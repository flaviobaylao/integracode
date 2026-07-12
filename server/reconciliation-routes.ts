import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { settleBoletoCharge } from "./bb-boleto-service";
import { authenticateUser, requireRole } from "./authMiddleware";
const FIN_ROLES = ["admin", "coordinator", "administrative"]; // FASE 1c

// ---------------------------------------------------------------------------
// Conciliação Bancária — FASE 1 (read-only): reconstrói a tela do 1.0.
//   GET /api/reconciliation/filters                 -> contas + instâncias
//   GET /api/reconciliation/statements              -> "Extratos Importados"
//   GET /api/reconciliation/statements/:id/items    -> itens + matches + sugestões
// Fonte: tabelas sincronizadas do 1.0 (bank_statements, bank_statement_items,
// bank_statement_item_matches, reconciliation_patterns). NENHUMA escrita.
// Sugestões: padrões aprendidos (reconciliation_patterns por descrição/cpf_cnpj,
// reforçados por match_count) + títulos em aberto (receber/pagar) casados por valor.
// ---------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
// drizzle expande ${array} em vez de passar array Postgres p/ ANY(); usar IN (...) com params individuais.
const inList = (arr: any[]) => sql.join(arr.map((v) => sql`${v}`), sql`, `);
const onlyDigits = (v: any): string => (v == null ? "" : String(v)).replace(/\D/g, "");
const pickMethod = (desc: any): string => {
  const d = (desc == null ? "" : String(desc)).toLowerCase();
  if (d.includes("pix")) return "pix";
  if (d.includes("boleto")) return "boleto";
  if (d.includes("ted") || d.includes("doc ") || d.includes("transfer")) return "transferencia";
  if (d.includes("dinheiro") || d.includes("especie") || d.includes("saque")) return "dinheiro";
  return "transferencia";
};
const normDesc = (v: any): string =>
  (v == null ? "" : String(v)).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const money = (v: any): string => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? "0.00" : n.toFixed(2);
};

export function registerReconciliation(app: Express) {
  // ---- Filtros (contas + instâncias) --------------------------------------
  app.get("/api/reconciliation/filters", authenticateUser, requireRole(FIN_ROLES), async (_req, res) => {
    try {
      const r = await db.execute(sql`
        SELECT id, name, omie_instance_id
        FROM financial_accounts
        WHERE is_active IS NOT FALSE
        ORDER BY omie_instance_id NULLS LAST, name`);
      const accounts = rowsOf(r);
      const instances = Array.from(new Set(accounts.map((a: any) => a.omie_instance_id).filter(Boolean)));
      res.json({ accounts, instances });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Lista de extratos importados ---------------------------------------
  app.get("/api/reconciliation/statements", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const instanceId = (req.query.instanceId as string) || null;
      const accountId = (req.query.accountId as string) || null;
      const r = await db.execute(sql`
        SELECT s.id, s.file_name, s.source, s.start_date, s.end_date,
               s.total_credits, s.total_debits, s.financial_account_id,
               s.omie_instance_id, fa.name AS account_name, s.created_at,
               (SELECT count(*) FROM bank_statement_items i WHERE i.statement_id = s.id)::int AS items,
               (SELECT count(*) FROM bank_statement_items i WHERE i.statement_id = s.id AND i.reconciliation_status = 'reconciled')::int AS reconciled,
               (SELECT count(*) FROM bank_statement_items i WHERE i.statement_id = s.id AND i.reconciliation_status = 'ignored')::int AS ignored
        FROM bank_statements s
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
        ORDER BY COALESCE(s.end_date, s.created_at) DESC NULLS LAST`);
      res.json({ statements: rowsOf(r) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- FASE 3.4b: motor de sugestões compartilhado ------------------------
  // Usado pelo extrato individual e pela visão consolidada de pendentes.
  async function buildSuggestions(items: any[]): Promise<Record<string, any>> {
      // Sugestões p/ itens pendentes
      const pend = items.filter((i: any) => !i.reconciliation_status || i.reconciliation_status === "pending");
      const perKeys: Record<string, { nd: string; doc: string; amt: string }> = {};
      const normSet = new Set<string>(), docSet = new Set<string>(), amtSet = new Set<string>();
      for (const i of pend) {
        const nd = normDesc(i.description);
        const dm = (String(i.description || "") + " " + String(i.origin_document || "")).match(/(\d{11}|\d{14})/);
        const doc = dm ? dm[1] : "";
        const amt = money(i.amount);
        perKeys[i.id] = { nd, doc, amt };
        if (nd) normSet.add(nd);
        if (doc) docSet.add(doc);
        amtSet.add(amt);
      }

      // Padrões aprendidos (descrição + cpf_cnpj)
      const patByDesc: Record<string, any[]> = {}, patByDoc: Record<string, any[]> = {};
      if (normSet.size || docSet.size) {
        const normArr = normSet.size ? Array.from(normSet) : ["__none__"];
        const docArr = docSet.size ? Array.from(docSet) : ["__none__"];
        const pR = await db.execute(sql`
          SELECT pattern_type, normalized_value, direction, counterparty_type, counterparty_id,
                 counterparty_name, counterparty_document, suggested_category, match_count
          FROM reconciliation_patterns
          WHERE (pattern_type = 'description' AND normalized_value IN (${inList(normArr)}))
             OR (pattern_type = 'cpf_cnpj'   AND normalized_value IN (${inList(docArr)}))
          ORDER BY match_count DESC`);
        for (const p of rowsOf(pR)) {
          if (p.pattern_type === "description") (patByDesc[p.normalized_value] ||= []).push(p);
          else (patByDoc[p.normalized_value] ||= []).push(p);
        }
      }

      // FASE 3.4 - Titulos em aberto casados com SCORE (valor restante, CPF/CNPJ, data).
      // Volume de abertos e pequeno (~1.100), entao carrega e casa em memoria.
      // SOMENTE SUGESTAO: a conciliacao continua 100% manual (modal + clique do usuario).
      let openRecv: any[] = [], openPay: any[] = [], pixPend: any[] = [];
      if (pend.length) {
        openRecv = rowsOf(await db.execute(sql`
          SELECT id, title_number, customer_name, customer_document, amount,
                 COALESCE(amount_paid, 0) AS amount_paid, due_date, omie_instance_id
          FROM receivables
          WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0
          LIMIT 2000`));
        openPay = rowsOf(await db.execute(sql`
          SELECT id, title_number, supplier_name, supplier_document, amount,
                 COALESCE(amount_paid, 0) AS amount_paid, due_date, omie_instance_id
          FROM payables
          WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0
          LIMIT 2000`));
        try {
          pixPend = rowsOf(await db.execute(sql`
            SELECT txid, end_to_end_id, valor, horario, info_pagador
            FROM pix_unmatched WHERE status = 'pendente' ORDER BY created_at DESC LIMIT 300`));
        } catch { pixPend = []; }
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const scoreTitle = (t: any, itemAmt: number, itemDoc: string, itemDate: number, patName: string) => {
        const restante = Number(t.amount || 0) - Number(t.amount_paid || 0);
        const dv = Math.abs(restante - itemAmt);
        const rel = itemAmt > 0 ? dv / itemAmt : 1;
        let score = 0; const motivos: string[] = [];
        if (dv <= 0.011) { score += 50; motivos.push("valor exato"); }
        else if (rel <= 0.02) { score += 35; motivos.push("valor aproximado (ate 2%)"); }
        else if (rel <= 0.10) { score += 15; motivos.push("valor proximo (ate 10%)"); }
        const tDoc = onlyDigits(t.customer_document || t.supplier_document);
        if (itemDoc && tDoc && itemDoc === tDoc) { score += 30; motivos.push("CPF/CNPJ confere"); }
        if (t.due_date && itemDate) {
          const dd = Math.abs(new Date(t.due_date).getTime() - itemDate) / dayMs;
          if (dd <= 5) { score += 15; motivos.push(dd < 1 ? "vence no dia" : `vencimento a ${Math.round(dd)} dia(s)`); }
          else if (dd <= 15) { score += 8; motivos.push(`vencimento a ${Math.round(dd)} dias`); }
        }
        const nome = String(t.customer_name || t.supplier_name || "");
        if (patName && nome && normDesc(nome) && normDesc(patName).includes(normDesc(nome).slice(0, 10))) { score += 10; motivos.push("padrao aprendido"); }
        return { score, motivos, restante };
      };

      const suggestions: Record<string, any> = {};
      for (const i of pend) {
        const { nd, doc } = perKeys[i.id];
        const cand = [...(patByDoc[doc] || []), ...(patByDesc[nd] || [])]
          .filter((p) => !p.direction || p.direction === i.type)
          .sort((a, b) => (b.match_count || 0) - (a.match_count || 0));
        const bestPat = cand[0];
        const itemAmt = Number(money(i.amount));
        const itemDate = i.transaction_date ? new Date(i.transaction_date).getTime() : 0;
        const pool = i.type === "C" ? openRecv : openPay;
        const scored = pool
          .map((t: any) => ({ t, s: scoreTitle(t, itemAmt, doc, itemDate, bestPat?.counterparty_name || "") }))
          .filter((x: any) => x.s.score >= 35)
          .sort((a: any, b: any) => b.s.score - a.s.score)
          .slice(0, 5);
        // Cruzamento com PIX recebidos sem cobranca (webhook) - so p/ creditos
        let pix: any = null;
        if (i.type === "C" && pixPend.length && itemDate) {
          const hit = pixPend.find((p: any) => Math.abs(Number(p.valor || 0) - itemAmt) <= 0.011
            && p.horario && Math.abs(new Date(p.horario).getTime() - itemDate) <= 2 * dayMs);
          if (hit) pix = { txid: hit.txid, e2e: hit.end_to_end_id, horario: hit.horario, valor: hit.valor, pagador: hit.info_pagador };
        }
        if (bestPat || scored.length || pix) {
          suggestions[i.id] = {
            counterparty: bestPat
              ? {
                  type: bestPat.counterparty_type,
                  id: bestPat.counterparty_id,
                  name: bestPat.counterparty_name,
                  document: bestPat.counterparty_document,
                  category: bestPat.suggested_category,
                  matchCount: bestPat.match_count,
                  via: bestPat.pattern_type,
                }
              : null,
            pix,
            titles: scored.map(({ t, s }: any) => ({
              kind: i.type === "C" ? "receivable" : "payable",
              id: t.id,
              title: t.title_number,
              name: t.customer_name || t.supplier_name,
              document: t.customer_document || t.supplier_document,
              amount: t.amount,
              restante: s.restante.toFixed(2),
              due: t.due_date,
              instance: t.omie_instance_id,
              score: Math.min(100, s.score),
              motivos: s.motivos,
            })),
          };
        }
      }

      return suggestions;
  }

  // ---- FASE 3.4b: Pendentes de todos os extratos (visão consolidada) ------
  // Read-only: lista lançamentos pendentes de todas as importações da conta,
  // com as mesmas sugestões. A conciliação continua por item (manual).
  app.get("/api/reconciliation/pending-items", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const accountId = (req.query.accountId as string) || null;
      const instanceId = (req.query.instanceId as string) || null;
      const r = await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.document,
               i.balance_after, i.origin_name, i.origin_document, i.reconciliation_status,
               i.matched_receivable_id, i.matched_payable_id, i.matched_at, i.matched_by,
               i.match_confidence, i.notes, s.file_name, fa.name AS account_name
        FROM bank_statement_items i
        JOIN bank_statements s ON s.id = i.statement_id
        LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
        WHERE (i.reconciliation_status IS NULL OR i.reconciliation_status = 'pending')
          AND (${accountId}::text IS NULL OR s.financial_account_id = ${accountId})
          AND (${instanceId}::text IS NULL OR s.omie_instance_id = ${instanceId})
        ORDER BY i.transaction_date, i.id
        LIMIT 1000`);
      const items = rowsOf(r);
      const suggestions = await buildSuggestions(items);
      res.json({ items, matchesByItem: {}, suggestions });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Itens de um extrato + matches + sugestões --------------------------
  app.get("/api/reconciliation/statements/:id/items", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const itemsR = await db.execute(sql`
        SELECT i.id, i.transaction_date, i.amount, i.type, i.description, i.document,
               i.balance_after, i.origin_name, i.origin_document, i.reconciliation_status,
               i.matched_receivable_id, i.matched_payable_id, i.matched_at, i.matched_by,
               i.match_confidence, i.notes
        FROM bank_statement_items i
        WHERE i.statement_id = ${id}
        ORDER BY i.transaction_date, i.id`);
      const items = rowsOf(itemsR);
      const ids = items.map((i: any) => i.id);

      // Matches (conciliação composta) dos itens já conciliados
      const matchesByItem: Record<string, any[]> = {};
      if (ids.length) {
        const mR = await db.execute(sql`
          SELECT m.bank_statement_item_id, m.receivable_id, m.payable_id, m.amount,
                 m.match_kind, m.title_amount_settled, m.interest, m.discount,
                 r.title_number AS r_title, r.customer_name AS r_name, r.amount AS r_amount, r.due_date AS r_due,
                 p.title_number AS p_title, p.supplier_name AS p_name, p.amount AS p_amount, p.due_date AS p_due
          FROM bank_statement_item_matches m
          LEFT JOIN receivables r ON r.id = m.receivable_id
          LEFT JOIN payables p ON p.id = m.payable_id
          WHERE m.bank_statement_item_id IN (${inList(ids)})`);
        for (const m of rowsOf(mR)) (matchesByItem[m.bank_statement_item_id] ||= []).push(m);
      }

      const suggestions = await buildSuggestions(items);

      res.json({ items, matchesByItem, suggestions });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });


  // =========================================================================
  // FASE 2 — ESCRITA (financeiro). Conciliar dá baixa (reusa a baixa testada).
  // =========================================================================

  async function settleReceivable(recId: string, amount: number, method: string, accountId: string | null, paidAtISO: string, by: string) {
    const br = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${recId} ORDER BY created_at DESC NULLS LAST LIMIT 1`);
    const charge = rowsOf(br)[0];
    if (charge) {
      const result = await settleBoletoCharge(charge, amount, paidAtISO, "conciliacao-bancaria");
      return { via: "boleto", result };
    }
    const rec: any = await storage.getReceivable(recId);
    if (!rec) throw new Error("recebivel nao encontrado: " + recId);
    const prevPaid = Number(rec.amountPaid || 0);
    const amt = Number(rec.amount || 0);
    // FIX 3.4b: titulo ja quitado (ex.: conciliacao anterior interrompida no meio) ->
    // nao duplica a baixa; o chamador ainda vincula o item do extrato ao titulo.
    if (amt > 0 && prevPaid >= amt - 0.005) return { via: "ja_baixado", status: rec.status };
    const newPaid = prevPaid + amount;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "recebida" : rec.status;
    // FIX 3.4b: paid_at precisa ser Date (string quebrava o drizzle com
    // "value.toISOString is not a function"); pagamento criado ANTES da baixa,
    // para nao deixar titulo baixado sem pagamento se algo falhar.
    await storage.createReceivablePayment({ receivableId: recId, paidAt: new Date(paidAtISO) as any, amount: amount.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || rec.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
    await storage.updateReceivable(recId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || rec.financialAccountId || null } as any);
    return { via: "receivable", status };
  }

  async function settlePayable(payId: string, amount: number, method: string, accountId: string | null, paidAtISO: string, by: string) {
    const pay: any = await storage.getPayable(payId);
    if (!pay) throw new Error("pagavel nao encontrado: " + payId);
    const prevPaid = Number(pay.amountPaid || 0);
    const amt = Number(pay.amount || 0);
    // FIX 3.4b: titulo ja quitado -> nao duplica a baixa (so vincula o extrato).
    if (amt > 0 && prevPaid >= amt - 0.005) return { via: "ja_baixado", status: pay.status };
    const newPaid = prevPaid + amount;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "paga" : pay.status;
    // FIX 3.4b: paid_at como Date + pagamento antes da baixa (ver settleReceivable).
    await storage.createPayablePayment({ payableId: payId, paidAt: new Date(paidAtISO) as any, amount: amount.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || pay.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
    await storage.updatePayable(payId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || pay.financialAccountId || null } as any);
    return { via: "payable", status };
  }

  async function evolvePattern(item: any, cp: { type: string; id: string | null; name: string | null; document: string | null; category: string | null }, instanceId: string | null, by: string) {
    try {
      const dir = item.type;
      const doc = onlyDigits(cp.document) || ((String(item.description || "").match(/(\d{11}|\d{14})/) || [])[1] || "");
      const nd = normDesc(item.description);
      const entries: { ptype: string; pval: string; norm: string }[] = [];
      if (doc) entries.push({ ptype: "cpf_cnpj", pval: doc, norm: doc });
      if (nd) entries.push({ ptype: "description", pval: String(item.description || "").slice(0, 200), norm: nd });
      for (const e of entries) {
        const ex = rowsOf(await db.execute(sql`
          SELECT id FROM reconciliation_patterns
          WHERE pattern_type = ${e.ptype} AND normalized_value = ${e.norm} AND direction = ${dir} LIMIT 1`))[0];
        if (ex) {
          await db.execute(sql`
            UPDATE reconciliation_patterns
            SET match_count = COALESCE(match_count,0) + 1, last_used_at = now(), updated_at = now(),
                counterparty_type = ${cp.type}, counterparty_id = ${cp.id}, counterparty_name = ${cp.name},
                counterparty_document = ${cp.document}, suggested_category = COALESCE(${cp.category}, suggested_category)
            WHERE id = ${ex.id}`);
        } else {
          await db.execute(sql`
            INSERT INTO reconciliation_patterns (id, pattern_type, pattern_value, normalized_value, direction,
              counterparty_type, counterparty_id, counterparty_name, counterparty_document, suggested_category,
              omie_instance_id, match_count, last_used_at, created_by, created_at, updated_at)
            VALUES (gen_random_uuid(), ${e.ptype}, ${e.pval}, ${e.norm}, ${dir},
              ${cp.type}, ${cp.id}, ${cp.name}, ${cp.document}, ${cp.category},
              ${instanceId}, 1, now(), ${by}, now(), now())`);
        }
      }
    } catch (_e) { /* best-effort */ }
  }

  // Buscar títulos em aberto (aba "Buscar Título" do modal) — C=receber, D=pagar
  app.get("/api/reconciliation/titles/search", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const type = String(req.query.type || "C").toUpperCase() === "D" ? "D" : "C";
      const q = String(req.query.q || "").trim();
      const limit = Math.min(parseInt(String(req.query.limit || "30")) || 30, 100);
      const like = `%${q}%`;
      const qDigits = q.replace(/\D/g, "");
      const qNumRaw = q.replace(/[^0-9.,]/g, "").replace(/\./g, "").replace(",", ".");
      const qNum = qNumRaw ? parseFloat(qNumRaw) : NaN;
      if (type === "C") {
        const conds: any[] = [sql`deleted_at IS NULL`, sql`status IN ('a_vencer','vencida')`, sql`(amount - COALESCE(amount_paid,0)) > 0`];
        if (q) {
          const ors: any[] = [sql`title_number ILIKE ${like}`, sql`customer_name ILIKE ${like}`];
          if (qDigits) ors.push(sql`COALESCE(customer_document,'') ILIKE ${'%' + qDigits + '%'}`);
          if (!isNaN(qNum)) ors.push(sql`round(amount::numeric,2) = ${qNum}`);
          conds.push(sql`(${sql.join(ors, sql` OR `)})`);
        }
        const r = await db.execute(sql`
          SELECT id, title_number, customer_name, customer_document, amount, due_date, omie_instance_id
          FROM receivables WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY due_date NULLS LAST LIMIT ${limit}`);
        return res.json({ titles: rowsOf(r).map((t: any) => ({ kind: "receivable", id: t.id, title: t.title_number, name: t.customer_name, document: t.customer_document, amount: t.amount, due: t.due_date, instance: t.omie_instance_id })) });
      } else {
        const conds: any[] = [sql`deleted_at IS NULL`, sql`status IN ('a_vencer','vencida')`, sql`(amount - COALESCE(amount_paid,0)) > 0`];
        if (q) {
          const ors: any[] = [sql`title_number ILIKE ${like}`, sql`supplier_name ILIKE ${like}`];
          if (qDigits) ors.push(sql`COALESCE(supplier_document,'') ILIKE ${'%' + qDigits + '%'}`);
          if (!isNaN(qNum)) ors.push(sql`round(amount::numeric,2) = ${qNum}`);
          conds.push(sql`(${sql.join(ors, sql` OR `)})`);
        }
        const r = await db.execute(sql`
          SELECT id, title_number, supplier_name, supplier_document, amount, due_date, omie_instance_id
          FROM payables WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY due_date NULLS LAST LIMIT ${limit}`);
        return res.json({ titles: rowsOf(r).map((t: any) => ({ kind: "payable", id: t.id, title: t.title_number, name: t.supplier_name, document: t.supplier_document, amount: t.amount, due: t.due_date, instance: t.omie_instance_id })) });
      }
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/reconciliation/items/:id/ignore", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const reason = (req.body?.reason || "").toString();
      const cur = rowsOf(await db.execute(sql`SELECT reconciliation_status FROM bank_statement_items WHERE id = ${id}`))[0];
      if (!cur) return res.status(404).json({ error: "item nao encontrado" });
      if (cur.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado; desfaca antes de ignorar" });
      const note = `Ignorado por ${by} em ${new Date().toISOString()}${reason ? " - " + reason : ""}`;
      await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(), notes = ${note}
        WHERE id = ${id}`);
      res.json({ ok: true, status: "ignored" });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post("/api/reconciliation/items/:id/reconcile", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const dryRun = !!req.body?.dryRun;
      const titles: any[] = Array.isArray(req.body?.titles) ? req.body.titles : [];
      if (!titles.length) return res.status(400).json({ error: "titles[] obrigatorio" });
      const item = rowsOf(await db.execute(sql`
        SELECT i.*, s.omie_instance_id AS s_instance, s.financial_account_id AS s_account
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
        WHERE i.id = ${id}`))[0];
      if (!item) return res.status(404).json({ error: "item nao encontrado" });
      if (item.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado" });
      const method = (req.body?.paymentMethod || pickMethod(item.description)).toString();
      const paidAtISO = (req.body?.paidAt ? new Date(req.body.paidAt) : new Date(item.transaction_date || Date.now())).toISOString();
      const accountId = item.s_account || null;

      const plan = titles.map((t) => ({
        kind: t.kind === "payable" ? "payable" : "receivable",
        id: t.id,
        amount: Number(t.amount || 0),
        interest: Number(t.interest || 0),
        discount: Number(t.discount || 0),
        settled: Number(t.amount || 0) + Number(t.interest || 0) - Number(t.discount || 0),
      }));
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, item: { id: item.id, amount: item.amount, type: item.type, description: item.description }, method, paidAtISO, accountId, plan });
      }

      const kind = titles.length > 1 ? "manual_multi" : "manual";
      const results: any[] = [];
      let firstRecv: string | null = null, firstPay: string | null = null;
      let cpInfo: any = null;
      for (const t of plan) {
        if (t.kind === "receivable") {
          const r = await settleReceivable(t.id, t.settled, method, accountId, paidAtISO, by);
          results.push({ id: t.id, kind: "receivable", ...r });
          if (!firstRecv) firstRecv = t.id;
          if (!cpInfo) { const rec: any = await storage.getReceivable(t.id); if (rec) cpInfo = { type: "customer", id: rec.customerId || null, name: rec.customerName || null, document: rec.customerDocument || null, category: rec.category || null }; }
        } else {
          const r = await settlePayable(t.id, t.settled, method, accountId, paidAtISO, by);
          results.push({ id: t.id, kind: "payable", ...r });
          if (!firstPay) firstPay = t.id;
          if (!cpInfo) { const pay: any = await storage.getPayable(t.id); if (pay) cpInfo = { type: "supplier", id: null, name: pay.supplierName || null, document: pay.supplierDocument || null, category: pay.category || null }; }
        }
        await db.execute(sql`
          INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
          VALUES (gen_random_uuid(), ${id}, ${t.kind === "receivable" ? t.id : null}, ${t.kind === "payable" ? t.id : null}, ${t.amount.toFixed(2)}, ${kind}, ${t.settled.toFixed(2)}, ${t.interest.toFixed(2)}, ${t.discount.toFixed(2)}, ${by}, now())`);
      }
      const note = `Conciliado por ${by} em ${new Date().toISOString()}${titles.length > 1 ? " (composta " + titles.length + " titulos)" : ""}`;
      await db.execute(sql`
        UPDATE bank_statement_items
        SET reconciliation_status = 'reconciled', matched_receivable_id = ${firstRecv}, matched_payable_id = ${firstPay},
            matched_at = now(), matched_by = ${by}, match_confidence = 100, notes = ${note}
        WHERE id = ${id}`);
      if (cpInfo) await evolvePattern(item, cpInfo, item.s_instance || null, by);
      res.json({ ok: true, status: "reconciled", kind, results });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // ---- FASE 3.4c: cadastros no "Criar Novo" -------------------------------
  // Busca fornecedores no cadastro (autocomplete do modal).
  app.get("/api/reconciliation/suppliers/search", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${q}%`;
      const digits = onlyDigits(q);
      const digitsLike = digits ? "%" + digits + "%" : "__none__";
      const r = await db.execute(sql`
        SELECT id, name, company_name, cnpj, cpf, default_category, default_chart_account_id
        FROM suppliers
        WHERE (is_active IS NOT FALSE)
          AND (${q} = '' OR name ILIKE ${like} OR company_name ILIKE ${like}
               OR regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') LIKE ${digitsLike}
               OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') LIKE ${digitsLike})
        ORDER BY name LIMIT 10`);
      res.json({ suppliers: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Busca categorias analiticas do DRE (plano de contas) p/ o campo Categoria.
  app.get("/api/reconciliation/dre-categories", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${q}%`;
      const r = await db.execute(sql`
        SELECT id, code, name, type, dre_group
        FROM chart_of_accounts
        WHERE (is_active IS NOT FALSE) AND code LIKE '%.%'
          AND (${q} = '' OR name ILIKE ${like} OR code ILIKE ${like})
        ORDER BY code LIMIT 20`);
      res.json({ categories: rowsOf(r) });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Garante o fornecedor no cadastro: procura por documento/nome; cadastra se novo.
  async function ensureSupplier(name: string, document: string | null, instanceId: string | null, chartAccountId: string | null, category: string | null, by: string): Promise<{ id: string | null; created: boolean; name: string; document: string | null }> {
    const nm = String(name || "").trim();
    if (!nm) return { id: null, created: false, name: nm, document };
    const digits = onlyDigits(document);
    try {
      let found: any = null;
      if (digits) {
        found = rowsOf(await db.execute(sql`
          SELECT id, name, cnpj, cpf FROM suppliers
          WHERE regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') = ${digits}
             OR regexp_replace(COALESCE(cpf, ''), '[^0-9]', '', 'g') = ${digits} LIMIT 1`))[0];
      }
      if (!found) {
        found = rowsOf(await db.execute(sql`
          SELECT id, name, cnpj, cpf FROM suppliers
          WHERE lower(trim(name)) = ${nm.toLowerCase()} OR lower(trim(COALESCE(company_name, ''))) = ${nm.toLowerCase()} LIMIT 1`))[0];
      }
      if (found) return { id: found.id, created: false, name: found.name || nm, document: document || found.cnpj || found.cpf || null };
      const cols = await tableColInfo("suppliers");
      const row = await insertDynamic("suppliers", cols, {
        name: nm,
        cnpj: digits.length === 14 ? document : null,
        cpf: digits.length === 11 ? document : null,
        omie_instance_id: instanceId,
        default_chart_account_id: chartAccountId,
        default_category: category,
        is_active: true,
        notes: "Cadastrado automaticamente pela Conciliacao 2.0 (" + by + ")",
      }, "id");
      return { id: row?.id || null, created: true, name: nm, document };
    } catch (_e) { return { id: null, created: false, name: nm, document }; }
  }

  // Criar Novo (aba do modal, igual ao 1.0): cria um titulo (conta a pagar/receber) na hora
  // com os dados do lancamento do banco e JA concilia (da baixa) contra o item do extrato.
  app.post("/api/reconciliation/items/:id/create-and-reconcile", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const b = req.body || {};
      const by = (b.by || "conciliacao-2.0").toString();
      const tipo = (b.tipo === "receber" || b.tipo === "receivable") ? "receber" : "pagar";
      const amount = Number(b.amount || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "valor invalido" });
      const item = rowsOf(await db.execute(sql`
        SELECT i.*, s.omie_instance_id AS s_instance, s.financial_account_id AS s_account
        FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id WHERE i.id = ${id}`))[0];
      if (!item) return res.status(404).json({ error: "item nao encontrado" });
      if (item.reconciliation_status === "reconciled") return res.status(409).json({ error: "item ja conciliado" });
      const method = (b.paymentMethod || pickMethod(item.description)).toString();
      const paidAtISO = (b.paidAt ? new Date(b.paidAt) : new Date(item.transaction_date || Date.now())).toISOString();
      const accountId = item.s_account || null;
      const instanceId = b.omieInstanceId || item.s_instance || null;
      const issue = b.issueDate ? new Date(b.issueDate) : new Date(item.transaction_date || Date.now());
      const due = b.dueDate ? new Date(b.dueDate) : issue;
      const desc = (b.description || item.description || "").toString().slice(0, 300);
      let name = (b.name || item.description || "Sem nome").toString().slice(0, 120);
      let doc = (b.document || "").toString();
      const category = b.category ? String(b.category) : null;
      const chartAccountId = b.chartAccountId ? String(b.chartAccountId) : null;
      // FASE 3.4c - fornecedor vem do cadastro: procura por documento/nome e
      // cadastra automaticamente quando o nome e novo.
      let supplierInfo: any = null;
      if (tipo === "pagar") {
        supplierInfo = await ensureSupplier(name, doc || null, instanceId, chartAccountId, category, by);
        name = String(supplierInfo.name || name).slice(0, 120);
        if (!doc && supplierInfo.document) doc = String(supplierInfo.document);
      }

      let titleId: string; let kind: "receivable" | "payable";
      if (tipo === "receber") {
        const rec: any = await storage.createReceivable({ customerName: name, customerDocument: doc || null, amount: amount.toFixed(2), issueDate: issue as any, dueDate: due as any, description: desc, category, chartAccountId: chartAccountId, omieInstanceId: instanceId, financialAccountId: accountId, status: "a_vencer", createdBy: by } as any);
        titleId = rec.id; kind = "receivable";
        await settleReceivable(titleId, amount, method, accountId, paidAtISO, by);
      } else {
        const pay: any = await storage.createPayable({ supplierName: name, supplierDocument: doc || null, amount: amount.toFixed(2), issueDate: issue as any, dueDate: due as any, description: desc, chartAccountId: chartAccountId, omieInstanceId: instanceId, financialAccountId: accountId, status: "a_vencer", source: "manual", createdBy: by, notes: category ? ("Categoria: " + category) : null } as any);
        titleId = pay.id; kind = "payable";
        await settlePayable(titleId, amount, method, accountId, paidAtISO, by);
      }
      await db.execute(sql`
        INSERT INTO bank_statement_item_matches (id, bank_statement_item_id, receivable_id, payable_id, amount, match_kind, title_amount_settled, interest, discount, created_by, created_at)
        VALUES (gen_random_uuid(), ${id}, ${kind === "receivable" ? titleId : null}, ${kind === "payable" ? titleId : null}, ${amount.toFixed(2)}, ${"manual_novo"}, ${amount.toFixed(2)}, ${"0.00"}, ${"0.00"}, ${by}, now())`);
      const note = `Conciliado (titulo criado) por ${by} em ${new Date().toISOString()}`;
      await db.execute(sql`
        UPDATE bank_statement_items SET reconciliation_status = 'reconciled',
          matched_receivable_id = ${kind === "receivable" ? titleId : null}, matched_payable_id = ${kind === "payable" ? titleId : null},
          matched_at = now(), matched_by = ${by}, match_confidence = 100, notes = ${note} WHERE id = ${id}`);
      try { await evolvePattern(item, { type: kind === "receivable" ? "customer" : "supplier", id: null, name, document: doc || null, category }, instanceId, by); } catch {}
      res.json({ ok: true, status: "reconciled", created: { kind, id: titleId }, supplier: supplierInfo });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Desfazer conciliação (reverte a baixa) ------------------------------
  app.post("/api/reconciliation/items/:id/undo", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const item = rowsOf(await db.execute(sql`SELECT * FROM bank_statement_items WHERE id = ${id}`))[0];
      if (!item) return res.status(404).json({ error: "item nao encontrado" });
      if (item.reconciliation_status === "ignored") {
        await db.execute(sql`UPDATE bank_statement_items SET reconciliation_status='pending', matched_by=${by}, matched_at=null, notes=null WHERE id=${id}`);
        return res.json({ ok: true, status: "pending", reverted: "ignored" });
      }
      if (item.reconciliation_status !== "reconciled") return res.status(409).json({ error: "item nao esta conciliado" });
      const matches = rowsOf(await db.execute(sql`SELECT * FROM bank_statement_item_matches WHERE bank_statement_item_id = ${id}`));
      const reverted: any[] = [];
      for (const m of matches) {
        const settled = Number(m.title_amount_settled || m.amount || 0);
        if (m.receivable_id) {
          const rec: any = await storage.getReceivable(m.receivable_id);
          if (rec) {
            const newPaid = Math.max(0, Number(rec.amountPaid || 0) - settled);
            const amt = Number(rec.amount || 0);
            const due = rec.dueDate ? new Date(rec.dueDate) : null;
            const status = amt > 0 && newPaid >= amt - 0.005 ? "recebida" : (due && due < new Date() ? "vencida" : "a_vencer");
            await storage.updateReceivable(m.receivable_id, { amountPaid: newPaid.toFixed(2), status } as any);
            await db.execute(sql`DELETE FROM receivable_payments WHERE receivable_id = ${m.receivable_id} AND reference = 'conciliacao-bancaria' AND amount = ${settled.toFixed(2)}`);
            reverted.push({ kind: "receivable", id: m.receivable_id, status });
          }
        } else if (m.payable_id) {
          const pay: any = await storage.getPayable(m.payable_id);
          if (pay) {
            const newPaid = Math.max(0, Number(pay.amountPaid || 0) - settled);
            const amt = Number(pay.amount || 0);
            const due = pay.dueDate ? new Date(pay.dueDate) : null;
            const status = amt > 0 && newPaid >= amt - 0.005 ? "paga" : (due && due < new Date() ? "vencida" : "a_vencer");
            await storage.updatePayable(m.payable_id, { amountPaid: newPaid.toFixed(2), status } as any);
            await db.execute(sql`DELETE FROM payable_payments WHERE payable_id = ${m.payable_id} AND reference = 'conciliacao-bancaria' AND amount = ${settled.toFixed(2)}`);
            reverted.push({ kind: "payable", id: m.payable_id, status });
          }
        }
      }
      await db.execute(sql`DELETE FROM bank_statement_item_matches WHERE bank_statement_item_id = ${id}`);
      await db.execute(sql`UPDATE bank_statement_items SET reconciliation_status='pending', matched_receivable_id=null, matched_payable_id=null, matched_at=null, matched_by=${by}, match_confidence=null, notes=null WHERE id=${id}`);
      res.json({ ok: true, status: "pending", reverted });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // =========================================================================
  // IMPORTAR OFX — cria bank_statement + bank_statement_items (status pending).
  // Não dá baixa; só ingere o extrato (o motor sugere a conciliação).
  // Insert defensivo por introspecção de colunas (tabelas vêm do sync do 1.0).
  // =========================================================================

  type ColInfo = Map<string, { nullable: boolean; hasDefault: boolean; dtype: string }>;
  async function tableColInfo(table: string): Promise<ColInfo> {
    const r = await db.execute(sql`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name = ${table} AND table_schema = 'public'`);
    const m: ColInfo = new Map();
    for (const c of rowsOf(r)) m.set(String(c.column_name), { nullable: c.is_nullable === "YES", hasDefault: c.column_default != null, dtype: String(c.data_type || "") });
    return m;
  }
  const defaultForType = (dtype: string): any => {
    if (/int|numeric|real|double|decimal|money/i.test(dtype)) return 0;
    if (/bool/i.test(dtype)) return false;
    if (/timestamp|date|time/i.test(dtype)) return new Date().toISOString();
    return "";
  };
  async function insertDynamic(table: string, cols: ColInfo, valueMap: Record<string, any>, returning?: string) {
    const names: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(valueMap)) {
      if (v === undefined) continue;
      if (cols.has(k)) { names.push(k); vals.push(v); }
    }
    // Preenche NOT NULL sem default que não foram fornecidos (evita 500 por coluna obrigatória)
    for (const [name, info] of cols.entries()) {
      if (name === "id") continue;
      if (!info.nullable && !info.hasDefault && !names.includes(name)) { names.push(name); vals.push(defaultForType(info.dtype)); }
    }
    const colSql = sql.join(names.map((c) => sql.raw('"' + c + '"')), sql`, `);
    const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    const hasId = cols.has("id");
    const idColSql = hasId ? sql`"id", ` : sql``;
    const idValSql = hasId ? sql`gen_random_uuid(), ` : sql``;
    const retSql = returning ? sql`${sql.raw('RETURNING "' + returning + '"')}` : sql``;
    const r = await db.execute(sql`INSERT INTO ${sql.raw('"' + table + '"')} (${idColSql}${colSql}) VALUES (${idValSql}${valSql}) ${retSql}`);
    return rowsOf(r)[0] || null;
  }

  const ofxDate = (v: any): string | null => {
    const s = onlyDigits(v);
    if (s.length < 8) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };
  const ofxAmount = (v: any): number => {
    let s = String(v == null ? "" : v).trim().replace(/[^0-9.,\-]/g, "");
    if (!s) return NaN;
    if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
    else if (s.includes(",")) s = s.replace(",", ".");
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  };
  const ofxTag = (block: string, tag: string): string => {
    const m = block.match(new RegExp("<" + tag + ">([^<\\r\\n]*)", "i"));
    return m ? m[1].trim() : "";
  };
  function parseOfx(text: string) {
    const acct = ofxTag(text, "ACCTID");
    const bankId = ofxTag(text, "BANKID");
    const dtStart = ofxDate(ofxTag(text, "DTSTART"));
    const dtEnd = ofxDate(ofxTag(text, "DTEND"));
    const txns: any[] = [];
    const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    let mm: RegExpExecArray | null;
    const chunks: string[] = [];
    while ((mm = re.exec(text))) chunks.push(mm[1]);
    if (!chunks.length && /<STMTTRN>/i.test(text)) {
      // OFX sem fechamento de </STMTTRN>: separa por marcador
      const parts = text.split(/<STMTTRN>/i).slice(1);
      for (const p of parts) chunks.push(p.split(/<\/BANKTRANLIST>|<LEDGERBAL>|<AVAILBAL>/i)[0]);
    }
    for (const blk of chunks) {
      const amt = ofxAmount(ofxTag(blk, "TRNAMT"));
      if (isNaN(amt)) continue;
      const date = ofxDate(ofxTag(blk, "DTPOSTED"));
      const memo = ofxTag(blk, "MEMO");
      const name = ofxTag(blk, "NAME");
      const fitid = ofxTag(blk, "FITID");
      const checknum = ofxTag(blk, "CHECKNUM");
      const trntype = ofxTag(blk, "TRNTYPE").toUpperCase();
      const type = amt >= 0 ? "C" : "D";
      txns.push({ date, amount: Math.abs(amt), type, description: (memo || name || trntype || "").slice(0, 300), name: (name || "").slice(0, 200), document: (checknum || "").slice(0, 60), fitid: (fitid || "").slice(0, 120) });
    }
    return { acct, bankId, dtStart, dtEnd, transactions: txns };
  }

  app.post("/api/reconciliation/import-ofx", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const ofxText = String(req.body?.ofxText || "");
      const accountId = (req.body?.accountId || "").toString();
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const fileName = (req.body?.fileName || "extrato.ofx").toString().slice(0, 200);
      if (!ofxText.trim()) return res.status(400).json({ error: "ofxText obrigatorio" });
      if (!accountId) return res.status(400).json({ error: "selecione a conta antes de importar" });

      const acc = rowsOf(await db.execute(sql`SELECT id, name, omie_instance_id FROM financial_accounts WHERE id = ${accountId} LIMIT 1`))[0];
      if (!acc) return res.status(404).json({ error: "conta financeira nao encontrada" });
      const instanceId = acc.omie_instance_id || null;

      const parsed = parseOfx(ofxText);
      if (!parsed.transactions.length) return res.status(400).json({ error: "nenhuma transacao (STMTTRN) encontrada no arquivo" });

      const stCols = await tableColInfo("bank_statements");
      const itCols = await tableColInfo("bank_statement_items");
      const fitCol = ["fit_id", "fitid", "external_id", "transaction_id"].find((c) => itCols.has(c)) || null;

      // Dedup contra itens já existentes na MESMA conta
      let skipped = 0;
      let toInsert = parsed.transactions;
      if (fitCol) {
        const fitsIn = Array.from(new Set(parsed.transactions.map((t) => t.fitid).filter(Boolean)));
        const existing = new Set<string>();
        if (fitsIn.length) {
          const er = await db.execute(sql`
            SELECT DISTINCT ${sql.raw('i."' + fitCol + '"')} AS fit
            FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
            WHERE s.financial_account_id = ${accountId} AND ${sql.raw('i."' + fitCol + '"')} IN (${inList(fitsIn)})`);
          for (const x of rowsOf(er)) existing.add(String(x.fit));
        }
        const seen = new Set<string>();
        toInsert = parsed.transactions.filter((t) => {
          const k = t.fitid || `${t.date}|${t.amount}|${t.type}|${t.description}`;
          if (t.fitid && existing.has(t.fitid)) { skipped++; return false; }
          if (seen.has(k)) { skipped++; return false; }
          seen.add(k); return true;
        });
      } else {
        // Sem coluna de FITID: dedup por (data|valor|tipo|descrição) contra o período
        const existing = new Set<string>();
        if (parsed.dtStart || parsed.dtEnd) {
          const er = await db.execute(sql`
            SELECT i.transaction_date, i.amount, i.type, i.description
            FROM bank_statement_items i JOIN bank_statements s ON s.id = i.statement_id
            WHERE s.financial_account_id = ${accountId}
              AND (${parsed.dtStart}::date IS NULL OR i.transaction_date >= ${parsed.dtStart}::date)
              AND (${parsed.dtEnd}::date IS NULL OR i.transaction_date <= ${parsed.dtEnd}::date)`);
          for (const x of rowsOf(er)) existing.add(`${String(x.transaction_date).slice(0, 10)}|${money(x.amount)}|${x.type}|${normDesc(x.description)}`);
        }
        const seen = new Set<string>();
        toInsert = parsed.transactions.filter((t) => {
          const k = `${t.date}|${money(t.amount)}|${t.type}|${normDesc(t.description)}`;
          if (existing.has(k) || seen.has(k)) { skipped++; return false; }
          seen.add(k); return true;
        });
      }

      if (!toInsert.length) return res.json({ ok: true, statementId: null, inserted: 0, skipped, message: "Todos os lançamentos já existiam (nada novo a importar)." });

      const totalC = toInsert.filter((t) => t.type === "C").reduce((a, t) => a + t.amount, 0);
      const totalD = toInsert.filter((t) => t.type === "D").reduce((a, t) => a + t.amount, 0);

      const stmt = await insertDynamic("bank_statements", stCols, {
        file_name: fileName,
        source: "ofx",
        start_date: parsed.dtStart,
        end_date: parsed.dtEnd,
        financial_account_id: accountId,
        omie_instance_id: instanceId,
        total_credits: totalC.toFixed(2),
        total_debits: totalD.toFixed(2),
        item_count: toInsert.length,
        reconciled_count: 0,
        bank_account: parsed.acct || null,
        created_by: by,
      }, "id");
      const stmtId = stmt?.id;
      if (!stmtId) return res.status(500).json({ error: "falha ao criar o extrato (sem id)" });

      let inserted = 0;
      let autoIgnorados = 0;
      for (const t of toInsert) {
        // FASE 3.4c/d - credito "COBRANCA" (repasse da baixa de boletos, ja tratados
        // pelo webhook) e marcadores "SALDO DO DIA"/"SALDO ANTERIOR" entram ignorados.
        const ndT = normDesc(t.description);
        const ehSaldo = ["saldododia", "saldoanterior"].includes(ndT);
        const ehCobranca = (t.type === "C" && ["cobranca", "cobrana", "cobranaa"].includes(ndT)) || ehSaldo;
        const vm: Record<string, any> = {
          statement_id: stmtId,
          transaction_date: t.date,
          amount: t.amount.toFixed(2),
          type: t.type,
          description: t.description,
          document: t.document,
          origin_name: t.name || null,
          reconciliation_status: ehCobranca ? "ignored" : "pending",
          created_by: by,
        };
        if (ehCobranca) { vm.notes = ehSaldo ? "Ignorado automaticamente: marcador de saldo do extrato" : "Ignorado automaticamente: repasse de COBRANCA (boletos baixados via webhook)"; vm.matched_by = by; vm.matched_at = new Date().toISOString(); autoIgnorados++; }
        if (fitCol) vm[fitCol] = t.fitid || null;
        await insertDynamic("bank_statement_items", itCols, vm);
        inserted++;
      }

      // FASE 3.4d - varredura pos-importacao: ignora tambem pendentes ANTIGOS com
      // descricao COBRANCA (credito) ou SALDO DO DIA / SALDO ANTERIOR.
      let varreduraIgnorados = 0;
      try {
        const uv: any = await db.execute(sql`
          UPDATE bank_statement_items
          SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(),
              notes = 'Ignorado automaticamente na importacao (COBRANCA / SALDO DO DIA / SALDO ANTERIOR)'
          WHERE (reconciliation_status IS NULL OR reconciliation_status = 'pending')
            AND ((type = 'C' AND regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('cobranca', 'cobrana', 'cobranaa'))
                 OR regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('saldododia', 'saldoanterior'))`);
        varreduraIgnorados = Number((uv as any)?.rowCount ?? 0);
      } catch {}

      res.json({ ok: true, statementId: stmtId, fileName, inserted, skipped, autoIgnorados, varreduraIgnorados, totalCredits: totalC.toFixed(2), totalDebits: totalD.toFixed(2), period: { start: parsed.dtStart, end: parsed.dtEnd }, account: acc.name, instance: instanceId });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });


  // FASE 3.4c - marca como ignorados os creditos "COBRANCA" pendentes (repasses
  // de boletos ja baixados via webhook). dryRun por padrao.
  app.post("/api/reconciliation/ignore-cobranca", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const c = rowsOf(await db.execute(sql`
        SELECT count(*)::int AS n FROM bank_statement_items
        WHERE (reconciliation_status IS NULL OR reconciliation_status = 'pending')
          AND ((type = 'C' AND regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('cobranca', 'cobrana', 'cobranaa'))
               OR regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('saldododia', 'saldoanterior'))`))[0];
      const candidatos = Number(c?.n || 0);
      let atualizados = 0;
      if (!dryRun && candidatos > 0) {
        const u: any = await db.execute(sql`
          UPDATE bank_statement_items
          SET reconciliation_status = 'ignored', matched_by = ${by}, matched_at = now(),
              notes = 'Ignorado automaticamente (COBRANCA / SALDO DO DIA / SALDO ANTERIOR)'
          WHERE (reconciliation_status IS NULL OR reconciliation_status = 'pending')
            AND ((type = 'C' AND regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('cobranca', 'cobrana', 'cobranaa'))
                 OR regexp_replace(lower(COALESCE(description, '')), '[^a-z]', '', 'g') IN ('saldododia', 'saldoanterior'))`);
        atualizados = Number((u as any)?.rowCount ?? 0);
      }
      res.json({ dryRun, candidatos, atualizados });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ---- Remover extrato importado (trava: recusa se houver item conciliado) -
  app.post("/api/reconciliation/statements/:id/delete", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const id = req.params.id;
      const by = (req.body?.by || "conciliacao-2.0").toString();
      const st = rowsOf(await db.execute(sql`SELECT id, file_name FROM bank_statements WHERE id = ${id}`))[0];
      if (!st) return res.status(404).json({ error: "extrato nao encontrado" });
      const rec = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM bank_statement_items WHERE statement_id = ${id} AND reconciliation_status = 'reconciled'`))[0];
      if (Number(rec?.n || 0) > 0) return res.status(409).json({ error: `extrato tem ${rec.n} item(ns) conciliado(s); desfaca as conciliacoes antes de remover`, reconciled: rec.n });
      await db.execute(sql`DELETE FROM bank_statement_item_matches WHERE bank_statement_item_id IN (SELECT id FROM bank_statement_items WHERE statement_id = ${id})`);
      const delItems = rowsOf(await db.execute(sql`DELETE FROM bank_statement_items WHERE statement_id = ${id} RETURNING id`));
      await db.execute(sql`DELETE FROM bank_statements WHERE id = ${id}`);
      res.json({ ok: true, statementId: id, fileName: st.file_name, deletedItems: delItems.length, by });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
  });

}
