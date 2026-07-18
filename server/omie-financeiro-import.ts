import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

// ─────────────────────────────────────────────────────────────────────────────
// Importação do histórico FINANCEIRO do Omie (backup "BKP OMIE") → Integra 2.0.
//
// Popula receivables (contas a receber) e payables (contas a pagar),
// sinalizando tudo com import_origin='omie_historico' + import_batch_id.
// Dedup pela chave nativa do Omie (codigo_lancamento_omie => external_id).
// Só INSERT do que falta — nunca atualiza/apaga registro existente. Idempotente.
// As datas originais do Omie (emissão/vencimento/faturamento) são preservadas.
//
// Colunas import_origin / import_batch_id são garantidas no boot (index.ts).
// ──────────────────────────────────────────────────────────────────────────────

const onlyDigits = (s: any) => String(s ?? "").replace(/\D/g, "");
const clampDate = (s: any): string | null => {
  const v = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

// cache CNPJ(normalizado) -> omie_instances.id
let _instMap: Record<string, string> | null = null;
async function instanceIdByCnpj(cnpj: string): Promise<string | null> {
  if (!_instMap) {
    _instMap = {};
    try {
      const r: any = await db.execute(sql`SELECT id, cnpj FROM omie_instances WHERE cnpj IS NOT NULL`);
      for (const row of (r.rows || [])) {
        const k = onlyDigits(row.cnpj);
        if (k) _instMap[k] = row.id;
      }
    } catch (e: any) {
      console.warn("[omie-fin] falha ao carregar omie_instances:", e?.message);
    }
  }
  return _instMap[onlyDigits(cnpj)] || null;
}

function isAdmin(req: any): boolean {
  const u = req.currentUser;
  return !!u && (u.role === "admin" || u.role === "administrative");
}

// Garante (idempotente) as colunas/índices de sinalização em receivables/payables.
// Roda uma única vez, na primeira chamada de importação — evita editar index.ts.
let _ensured = false;
async function ensureFinanceiroColumns(): Promise<void> {
  if (_ensured) return;
  _ensured = true;
  const stmts = [
    sql`ALTER TABLE receivables ADD COLUMN IF NOT EXISTS import_origin varchar`,
    sql`ALTER TABLE receivables ADD COLUMN IF NOT EXISTS import_batch_id varchar`,
    sql`ALTER TABLE payables ADD COLUMN IF NOT EXISTS import_origin varchar`,
    sql`ALTER TABLE payables ADD COLUMN IF NOT EXISTS import_batch_id varchar`,
    sql`CREATE INDEX IF NOT EXISTS idx_receivables_import_batch ON receivables(import_batch_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_payables_import_batch ON payables(import_batch_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_receivables_external ON receivables(external_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_payables_external ON payables(external_id)`,
  ];
  for (const s of stmts) { try { await db.execute(s); } catch (e: any) { console.warn("[omie-fin] ensure:", e?.message); } }
}

const REC_STATUS = new Set(["a_vencer", "recebida", "vencida", "cancelada"]);
const PAG_STATUS = new Set(["a_vencer", "paga", "vencida", "cancelada"]);
const PMETHODS = new Set(["dinheiro", "boleto", "cartao", "cartao_credito", "cartao_debito", "pix", "transferencia", "cheque", "outros"]);

// ── Faturamentos (billings) ─────────────────────────────────────────────────
const BILL_TYPES = new Set(["venda", "troca", "amostra"]);
let _ensuredBill = false;
async function ensureBillingsColumns(): Promise<void> {
  if (_ensuredBill) return;
  _ensuredBill = true;
  const stmts = [
    sql`ALTER TABLE billings ADD COLUMN IF NOT EXISTS import_origin varchar`,
    sql`ALTER TABLE billings ADD COLUMN IF NOT EXISTS import_batch_id varchar`,
    sql`CREATE INDEX IF NOT EXISTS idx_billings_import_batch ON billings(import_batch_id)`,
  ];
  for (const s of stmts) { try { await db.execute(s); } catch (e: any) { console.warn("[omie-fin] ensureBill:", e?.message); } }
}

function buildNotes(r: any): string {
  const parts: string[] = [];
  if (r.faturamentoDate) parts.push(`faturamento=${r.faturamentoDate}`);
  if (r.numeroParcela) parts.push(`parcela=${r.numeroParcela}`);
  if (r.categoryCode) parts.push(`cat=${r.categoryCode}`);
  if (r.numeroDocumentoFiscal) parts.push(`nf=${r.numeroDocumentoFiscal}`);
  if (r.numeroPedido) parts.push(`pedido=${r.numeroPedido}`);
  if (r.chaveNfe) parts.push(`chave=${r.chaveNfe}`);
  if (r.statusRaw) parts.push(`omie=${r.statusRaw}`);
  return parts.join(" | ") || "";
}

export function registerOmieFinanceiroImportRoutes(app: Express): void {
  // ── Importar um lote de títulos (receber | pagar) ───────────────────────────
  app.post("/api/admin/import/omie-financeiro", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      await ensureFinanceiroColumns();
      const { batchId, dryRun, kind, records } = req.body || {};
      if (!batchId) return res.status(400).json({ message: "batchId obrigatório" });
      if (kind !== "receber" && kind !== "pagar") return res.status(400).json({ message: "kind deve ser 'receber' ou 'pagar'" });
      if (!Array.isArray(records)) return res.status(400).json({ message: "records[] obrigatório" });

      const table = kind === "receber" ? "receivables" : "payables";
      const statusSet = kind === "receber" ? REC_STATUS : PAG_STATUS;

      // 1) normaliza + valida cada registro; descarta os sem external_id/datas
      const norm: any[] = [];
      let failed = 0;
      const errors: any[] = [];
      for (const r of records) {
        const externalId = String(r?.externalId ?? "").trim();
        const issue = clampDate(r?.issueDate);
        const due = clampDate(r?.dueDate) || issue;
        if (!externalId || !issue || !due) { failed++; if (errors.length < 30) errors.push({ externalId, e: "external_id/datas inválidos" }); continue; }
        const status = statusSet.has(r?.status) ? r.status : "a_vencer";
        const pm = PMETHODS.has(r?.paymentMethod) ? r.paymentMethod : null;
        const amount = Number(r?.amount || 0);
        const paid = Number(r?.amountPaid || 0);
        norm.push({
          externalId,
          titleNumber: r?.titleNumber ? String(r.titleNumber) : null,
          name: (r?.name ? String(r.name) : "") || (kind === "receber" ? "CLIENTE" : "FORNECEDOR"),
          doc: onlyDigits(r?.doc) || null,
          category: r?.category ? String(r.category) : null,
          description: r?.category ? String(r.category) : null,
          issue, due,
          amount, paid,
          status, pm,
          notes: buildNotes(r || {}),
          cnpj: r?.instanceCnpj,
        });
      }

      // 2) dedup em lote: quais external_id já existem na tabela alvo?
      const ids = Array.from(new Set(norm.map((x) => x.externalId)));
      const existing = new Set<string>();
      if (ids.length) {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 1000) chunks.push(ids.slice(i, i + 1000));
        for (const ch of chunks) {
          const q: any = await db.execute(
            sql`SELECT external_id FROM ${sql.raw(table)} WHERE external_id IN (${sql.join(ch.map((v) => sql`${v}`), sql`, `)})`
          );
          for (const row of (q.rows || [])) existing.add(String(row.external_id));
        }
      }

      const toInsert = norm.filter((x) => !existing.has(x.externalId));
      const skipped = norm.length - toInsert.length;

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, kind, received: records.length, wouldInsert: toInsert.length, skipped, failed, errors });
      }

      // 3) resolve omie_instance_id (todos do lote são da mesma instância)
      const instId = norm.length ? await instanceIdByCnpj(norm[0].cnpj) : null;

      // 4) INSERT multi-linha em chunks
      let inserted = 0;
      const CH = 200;
      for (let i = 0; i < toInsert.length; i += CH) {
        const slice = toInsert.slice(i, i + CH);
        try {
          if (kind === "receber") {
            const rows = slice.map((x) => sql`(${x.titleNumber}, ${x.name}, ${x.doc}, ${x.category}, ${x.description}, ${x.issue}::timestamp, ${x.due}::timestamp, ${x.amount}, ${x.paid}, ${x.status}::receivable_status, ${x.pm}::financial_payment_method, ${instId}, ${x.notes}, ${x.externalId}, 'omie_historico', ${batchId})`);
            await db.execute(sql`
              INSERT INTO receivables
                (title_number, customer_name, customer_document, category, description, issue_date, due_date, amount, amount_paid, status, payment_method, omie_instance_id, notes, external_id, import_origin, import_batch_id)
              VALUES ${sql.join(rows, sql`, `)}
            `);
          } else {
            const rows = slice.map((x) => sql`(${x.titleNumber}, ${x.name}, ${x.doc}, ${x.description}, ${x.issue}::timestamp, ${x.due}::timestamp, ${x.amount}, ${x.paid}, ${x.status}::payable_status, ${x.pm}::financial_payment_method, ${instId}, ${x.category}, ${x.notes}, ${x.externalId}, 'omie_historico', ${batchId})`);
            await db.execute(sql`
              INSERT INTO payables
                (title_number, supplier_name, supplier_document, description, issue_date, due_date, amount, amount_paid, status, payment_method, omie_instance_id, category, notes, external_id, import_origin, import_batch_id)
              VALUES ${sql.join(rows, sql`, `)}
            `);
          }
          inserted += slice.length;
        } catch (e: any) {
          failed += slice.length;
          if (errors.length < 30) errors.push({ chunk: i, e: e?.message || String(e) });
        }
      }

      res.json({ ok: true, dryRun: false, kind, received: records.length, inserted, skipped, failed, errors });
    } catch (error: any) {
      console.error("[omie-fin] erro:", error);
      res.status(500).json({ message: "Falha na importação financeira", error: error?.message });
    }
  });

  // ── Resumo do que já foi importado ──────────────────────────────────────────
  app.get("/api/admin/import/omie-financeiro/summary", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      await ensureFinanceiroColumns();
      const bid = req.query.batchId ? String(req.query.batchId) : null;
      const out: any = {};
      for (const table of ["receivables", "payables"]) {
        const where = bid ? sql`WHERE import_batch_id = ${bid}` : sql`WHERE import_origin = 'omie_historico'`;
        const c: any = await db.execute(sql`SELECT count(*)::int AS n, coalesce(sum(amount),0)::numeric AS total, coalesce(sum(amount_paid),0)::numeric AS paid, min(issue_date) AS min_d, max(due_date) AS max_d FROM ${sql.raw(table)} ${where}`);
        const byInst: any = await db.execute(sql`SELECT omie_instance_id, count(*)::int AS n FROM ${sql.raw(table)} ${where} GROUP BY omie_instance_id ORDER BY n DESC`);
        const byStatus: any = await db.execute(sql`SELECT status, count(*)::int AS n FROM ${sql.raw(table)} ${where} GROUP BY status ORDER BY n DESC`);
        out[table] = {
          count: c.rows?.[0]?.n ?? 0,
          amount: c.rows?.[0]?.total ?? 0,
          paid: c.rows?.[0]?.paid ?? 0,
          dateRange: [c.rows?.[0]?.min_d ?? null, c.rows?.[0]?.max_d ?? null],
          byInstance: byInst.rows || [],
          byStatus: byStatus.rows || [],
        };
      }
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });

  // ── Rollback de um lote (segurança) ─────────────────────────────────────────
  app.post("/api/admin/import/omie-financeiro/rollback", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const { batchId, confirm } = req.body || {};
      if (!batchId || confirm !== batchId) return res.status(400).json({ message: "batchId + confirm (igual ao batchId) obrigatórios" });
      const dr: any = await db.execute(sql`DELETE FROM receivables WHERE import_batch_id = ${batchId}`);
      const dp: any = await db.execute(sql`DELETE FROM payables WHERE import_batch_id = ${batchId}`);
      let deletedBillings: number | null = null;
      try { const dbil: any = await db.execute(sql`DELETE FROM billings WHERE import_batch_id = ${batchId}`); deletedBillings = dbil.rowCount ?? null; } catch (e: any) { /* coluna pode não existir ainda */ }
      res.json({ ok: true, deletedReceivables: dr.rowCount ?? null, deletedPayables: dp.rowCount ?? null, deletedBillings });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });

  // ── Backfill: vincula chart_account_id (plano de contas DRE) por categoria ──
  // Recebe { entries: [{ kind:'receber'|'pagar', name, code }] } (de-para categoria->codigo DRE).
  // Resolve o codigo -> chart_of_accounts.id e atualiza os titulos historicos sem conta.
  app.post("/api/admin/import/omie-financeiro/backfill-chart", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const entries: any[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (!entries.length) return res.status(400).json({ message: "entries[] obrigatório" });
      const coa: any = await db.execute(sql`SELECT id, code FROM chart_of_accounts`);
      const byCode: Record<string, string> = {};
      for (const r of (coa.rows || [])) byCode[String(r.code)] = String(r.id);
      let updRec = 0, updPay = 0, missing = 0;
      for (const e of entries) {
        const acc = byCode[String(e.code)];
        if (!acc) { missing++; continue; }
        const name = String(e.name ?? "");
        if (e.kind === "receber") {
          const u: any = await db.execute(sql`UPDATE receivables SET chart_account_id = ${acc} WHERE import_origin = 'omie_historico' AND category = ${name} AND chart_account_id IS NULL`);
          updRec += u.rowCount ?? 0;
        } else {
          const u: any = await db.execute(sql`UPDATE payables SET chart_account_id = ${acc} WHERE import_origin = 'omie_historico' AND category = ${name} AND chart_account_id IS NULL`);
          updPay += u.rowCount ?? 0;
        }
      }
      res.json({ ok: true, updatedReceivables: updRec, updatedPayables: updPay, missingCodes: missing });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });

  // ── Backfill: preenche omie_instance_id em payables a partir do external_id ──
  // external_id = omie_cp_<uuid-instancia>_<codigo>. Para os historicos que
  // entraram sem o vinculo de empresa. Idempotente (so mexe onde esta NULL).
  app.post("/api/admin/import/omie-financeiro/backfill-payable-instances", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const r: any = await db.execute(sql`
        UPDATE payables
        SET omie_instance_id = substring(external_id from '^omie_cp_([0-9a-fA-F-]{36})_')
        WHERE omie_instance_id IS NULL
          AND external_id ~ '^omie_cp_[0-9a-fA-F-]{36}_'
      `);
      res.json({ ok: true, updated: r.rowCount ?? null });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });

  // ── Importar BAIXAS (movimentos financeiros) dos titulos historicos ─────────
  // Body: { payments: [{ kind, externalId, paidAt, amount, financialAccountId, paymentMethod, reference, notes }] }
  // Resolve o titulo por external_id (so import_origin='omie_historico'), dedup por (titulo, reference).
  app.post("/api/admin/import/omie-financeiro/import-payments", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      const payments: any[] = Array.isArray(req.body?.payments) ? req.body.payments : [];
      if (!payments.length) return res.status(400).json({ message: "payments[] obrigatório" });
      const groups: Record<string, any[]> = { receber: [], pagar: [] };
      for (const p of payments) { if (p?.kind === "receber" || p?.kind === "pagar") groups[p.kind].push(p); }
      let inserted = 0, skipped = 0, noTitle = 0;
      for (const kind of ["receber", "pagar"] as const) {
        const arr = groups[kind]; if (!arr.length) continue;
        const table = kind === "receber" ? "receivables" : "payables";
        const ptable = kind === "receber" ? "receivable_payments" : "payable_payments";
        const fk = kind === "receber" ? "receivable_id" : "payable_id";
        // 1) resolve external_id -> id (apenas titulos historicos)
        const exts = Array.from(new Set(arr.map((p) => String(p.externalId))));
        const idmap: Record<string, string> = {};
        for (let i = 0; i < exts.length; i += 1000) {
          const ch = exts.slice(i, i + 1000);
          const q: any = await db.execute(sql`SELECT id, external_id FROM ${sql.raw(table)} WHERE import_origin = 'omie_historico' AND external_id IN (${sql.join(ch.map((v) => sql`${v}`), sql`, `)})`);
          for (const r of (q.rows || [])) idmap[String(r.external_id)] = String(r.id);
        }
        // 2) dedup por (titulo, reference) contra pagamentos existentes
        const tids = Array.from(new Set(Object.values(idmap)));
        const seen = new Set<string>();
        for (let i = 0; i < tids.length; i += 1000) {
          const ch = tids.slice(i, i + 1000);
          const q: any = await db.execute(sql.raw(`SELECT ${fk} AS tid, reference FROM ${ptable} WHERE ${fk} IN (${ch.map((v) => `'${v}'`).join(",")})`));
          for (const r of (q.rows || [])) seen.add(String(r.tid) + "|" + String(r.reference ?? ""));
        }
        // 3) montar inserts
        const toIns: any[] = [];
        for (const p of arr) {
          const tid = idmap[String(p.externalId)];
          if (!tid) { noTitle++; continue; }
          if (seen.has(tid + "|" + String(p.reference ?? ""))) { skipped++; continue; }
          toIns.push({ tid, paidAt: p.paidAt, amount: Number(p.amount || 0), pm: p.paymentMethod || null, fa: p.financialAccountId || null, ref: p.reference != null ? String(p.reference) : null, notes: p.notes || null });
        }
        // 4) multi-row insert
        for (let i = 0; i < toIns.length; i += 200) {
          const slice = toIns.slice(i, i + 200);
          if (kind === "receber") {
            const rows = slice.map((x) => sql`(${x.tid}, ${x.paidAt}::timestamp, ${x.amount}, ${x.pm}::financial_payment_method, ${x.fa}, ${x.ref}, ${x.notes})`);
            await db.execute(sql`INSERT INTO receivable_payments (receivable_id, paid_at, amount, payment_method, financial_account_id, reference, notes) VALUES ${sql.join(rows, sql`, `)}`);
          } else {
            const rows = slice.map((x) => sql`(${x.tid}, ${x.paidAt}::timestamp, ${x.amount}, ${x.pm}::financial_payment_method, ${x.fa}, ${x.ref}, ${x.notes})`);
            await db.execute(sql`INSERT INTO payable_payments (payable_id, paid_at, amount, payment_method, financial_account_id, reference, notes) VALUES ${sql.join(rows, sql`, `)}`);
          }
          inserted += slice.length;
        }
      }
      res.json({ ok: true, inserted, skipped, noTitle });
    } catch (error: any) {
      res.status(500).json({ message: "Falha ao importar baixas", error: error?.message });
    }
  });

  // ── Importar FATURAMENTOS históricos (pedidos de venda) → billings ──────────
  // Body: { batchId, dryRun, records:[{ omieOrderId, orderNumber, customerFantasyName,
  //   customerDocument, cfop, invoiceDate, orderDate, totalValue, dueDate, sellerName,
  //   omieCustomerCode, vendorCode, billingType, invoiceStatus, invoiceStage,
  //   isCancelled, products, instanceCnpj }] }
  // Dedup por omie_order_id (chave nativa Omie). Só INSERT do que falta. Idempotente.
  // Datas originais (pedido/faturamento/vencimento) preservadas. Reversível por batchId.
  app.post("/api/admin/import/omie-financeiro/import-billings", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      await ensureBillingsColumns();
      const { batchId, dryRun, records } = req.body || {};
      if (!batchId) return res.status(400).json({ message: "batchId obrigatório" });
      if (!Array.isArray(records)) return res.status(400).json({ message: "records[] obrigatório" });

      // 1) normaliza + valida (descarta os sem chave/número/data de pedido)
      const norm: any[] = [];
      let failed = 0;
      const errors: any[] = [];
      for (const r of records) {
        const omieOrderId = String(r?.omieOrderId ?? "").trim();
        const orderNumber = String(r?.orderNumber ?? "").trim();
        const orderDate = clampDate(r?.orderDate);
        if (!omieOrderId || !orderNumber || !orderDate) { failed++; if (errors.length < 30) errors.push({ omieOrderId, e: "omieOrderId/orderNumber/orderDate inválidos" }); continue; }
        const billingType = BILL_TYPES.has(r?.billingType) ? r.billingType : "venda";
        norm.push({
          omieOrderId, orderNumber,
          customer: (r?.customerFantasyName ? String(r.customerFantasyName) : "").trim() || "CLIENTE",
          doc: onlyDigits(r?.customerDocument) || null,
          cfop: r?.cfop ? String(r.cfop) : null,
          invoiceDate: clampDate(r?.invoiceDate),
          orderDate,
          totalValue: Number(r?.totalValue || 0),
          dueDate: clampDate(r?.dueDate),
          sellerName: r?.sellerName ? String(r.sellerName) : null,
          omieCustomerCode: r?.omieCustomerCode ? String(r.omieCustomerCode) : null,
          vendorCode: r?.vendorCode ? String(r.vendorCode) : null,
          billingType,
          invoiceStatus: r?.invoiceStatus ? String(r.invoiceStatus) : null,
          invoiceStage: r?.invoiceStage ? String(r.invoiceStage) : null,
          isCancelled: !!r?.isCancelled,
          products: Array.isArray(r?.products) ? r.products : null,
          cnpj: r?.instanceCnpj,
        });
      }

      // 2) dedup em lote contra a tabela (omie_order_id já existente)
      const ids = Array.from(new Set(norm.map((x) => x.omieOrderId)));
      const existing = new Set<string>();
      for (let i = 0; i < ids.length; i += 1000) {
        const ch = ids.slice(i, i + 1000);
        const q: any = await db.execute(
          sql`SELECT omie_order_id FROM billings WHERE omie_order_id IN (${sql.join(ch.map((v) => sql`${v}`), sql`, `)})`
        );
        for (const row of (q.rows || [])) existing.add(String(row.omie_order_id));
      }

      // 3) remove duplicados já-existentes e intra-lote (mantém 1ª ocorrência)
      const seenLocal = new Set<string>();
      const toInsert: any[] = [];
      for (const x of norm) {
        if (existing.has(x.omieOrderId) || seenLocal.has(x.omieOrderId)) continue;
        seenLocal.add(x.omieOrderId);
        toInsert.push(x);
      }
      const skipped = norm.length - toInsert.length;

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, received: records.length, wouldInsert: toInsert.length, skipped, failed, errors });
      }

      // 4) resolve omie_instance_id (todos do lote são da mesma instância)
      const instId = norm.length ? await instanceIdByCnpj(norm[0].cnpj) : null;

      // 5) INSERT multi-linha em chunks (ON CONFLICT protege corrida/dedup)
      let inserted = 0;
      const CH = 200;
      for (let i = 0; i < toInsert.length; i += CH) {
        const slice = toInsert.slice(i, i + CH);
        try {
          const rows = slice.map((x) => sql`(${x.omieOrderId}, ${x.orderNumber}, ${x.customer}, ${x.doc}, ${x.cfop}, ${x.invoiceDate}::timestamp, ${x.orderDate}::timestamp, ${x.totalValue}, ${x.dueDate}::timestamp, ${x.sellerName}, ${x.omieCustomerCode}, ${x.vendorCode}, ${x.billingType}::billing_type, ${x.invoiceStatus}, ${x.invoiceStage}, ${x.isCancelled}, ${x.products ? JSON.stringify(x.products) : null}::jsonb, ${instId}, 'omie_historico', ${batchId})`);
          const r: any = await db.execute(sql`
            INSERT INTO billings
              (omie_order_id, order_number, customer_fantasy_name, customer_document, cfop, invoice_date, order_date, total_value, due_date, seller_name, omie_customer_code, vendor_code, billing_type, invoice_status, invoice_stage, is_cancelled, products, omie_instance_id, import_origin, import_batch_id)
            VALUES ${sql.join(rows, sql`, `)}
            ON CONFLICT (omie_order_id) DO NOTHING
          `);
          inserted += (r.rowCount ?? slice.length);
        } catch (e: any) {
          failed += slice.length;
          if (errors.length < 30) errors.push({ chunk: i, e: e?.message || String(e) });
        }
      }

      res.json({ ok: true, dryRun: false, received: records.length, inserted, skipped, failed, errors });
    } catch (error: any) {
      console.error("[omie-fin] erro billings:", error);
      res.status(500).json({ message: "Falha na importação de faturamentos", error: error?.message });
    }
  });

  // ── Resumo dos faturamentos históricos importados ───────────────────────────
  app.get("/api/admin/import/omie-financeiro/billings-summary", authenticateUser, async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ message: "Access denied (admin only)" });
    try {
      await ensureBillingsColumns();
      const bid = req.query.batchId ? String(req.query.batchId) : null;
      const where = bid ? sql`WHERE import_batch_id = ${bid}` : sql`WHERE import_origin = 'omie_historico'`;
      const c: any = await db.execute(sql`SELECT count(*)::int AS n, coalesce(sum(total_value),0)::numeric AS total, min(order_date) AS min_d, max(order_date) AS max_d, count(*) FILTER (WHERE invoice_date IS NOT NULL)::int AS faturados, count(*) FILTER (WHERE is_cancelled)::int AS cancelados FROM billings ${where}`);
      const byInst: any = await db.execute(sql`SELECT omie_instance_id, count(*)::int AS n FROM billings ${where} GROUP BY omie_instance_id ORDER BY n DESC`);
      const byType: any = await db.execute(sql`SELECT billing_type, count(*)::int AS n FROM billings ${where} GROUP BY billing_type ORDER BY n DESC`);
      const totalAll: any = await db.execute(sql`SELECT count(*)::int AS n FROM billings`);
      res.json({
        historico: {
          count: c.rows?.[0]?.n ?? 0,
          amount: c.rows?.[0]?.total ?? 0,
          faturados: c.rows?.[0]?.faturados ?? 0,
          cancelados: c.rows?.[0]?.cancelados ?? 0,
          dateRange: [c.rows?.[0]?.min_d ?? null, c.rows?.[0]?.max_d ?? null],
          byInstance: byInst.rows || [],
          byType: byType.rows || [],
        },
        billingsTotal: totalAll.rows?.[0]?.n ?? 0,
      });
    } catch (error: any) {
      res.status(500).json({ message: error?.message });
    }
  });
}
