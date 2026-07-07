import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { settleBoletoCharge } from "./bb-boleto-service";

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
  app.get("/api/reconciliation/filters", async (_req, res) => {
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
  app.get("/api/reconciliation/statements", async (req, res) => {
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

  // ---- Itens de um extrato + matches + sugestões --------------------------
  app.get("/api/reconciliation/statements/:id/items", async (req, res) => {
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

      // Títulos em aberto casados por valor (receber p/ crédito, pagar p/ débito)
      const recvByAmt: Record<string, any[]> = {}, payByAmt: Record<string, any[]> = {};
      if (amtSet.size) {
        const amtArr = Array.from(amtSet);
        const orR = await db.execute(sql`
          SELECT id, title_number, customer_name, customer_document, amount, due_date, omie_instance_id
          FROM receivables
          WHERE status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0
            AND round(amount::numeric, 2)::text IN (${inList(amtArr)})
          LIMIT 400`);
        for (const r of rowsOf(orR)) (recvByAmt[money(r.amount)] ||= []).push(r);
        const opR = await db.execute(sql`
          SELECT id, title_number, supplier_name, supplier_document, amount, due_date, omie_instance_id
          FROM payables
          WHERE status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0
            AND round(amount::numeric, 2)::text IN (${inList(amtArr)})
          LIMIT 400`);
        for (const p of rowsOf(opR)) (payByAmt[money(p.amount)] ||= []).push(p);
      }

      const suggestions: Record<string, any> = {};
      for (const i of pend) {
        const { nd, doc, amt } = perKeys[i.id];
        const cand = [...(patByDoc[doc] || []), ...(patByDesc[nd] || [])]
          .filter((p) => !p.direction || p.direction === i.type)
          .sort((a, b) => (b.match_count || 0) - (a.match_count || 0));
        const bestPat = cand[0];
        const titles = (i.type === "C" ? recvByAmt[amt] || [] : payByAmt[amt] || []).slice(0, 5);
        if (bestPat || titles.length) {
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
            titles: titles.map((t: any) => ({
              kind: i.type === "C" ? "receivable" : "payable",
              id: t.id,
              title: t.title_number,
              name: t.customer_name || t.supplier_name,
              document: t.customer_document || t.supplier_document,
              amount: t.amount,
              due: t.due_date,
              instance: t.omie_instance_id,
            })),
          };
        }
      }

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
    const newPaid = prevPaid + amount;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "recebida" : rec.status;
    await storage.updateReceivable(recId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || rec.financialAccountId || null } as any);
    await storage.createReceivablePayment({ receivableId: recId, paidAt: paidAtISO as any, amount: amount.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || rec.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
    return { via: "receivable", status };
  }

  async function settlePayable(payId: string, amount: number, method: string, accountId: string | null, paidAtISO: string, by: string) {
    const pay: any = await storage.getPayable(payId);
    if (!pay) throw new Error("pagavel nao encontrado: " + payId);
    const prevPaid = Number(pay.amountPaid || 0);
    const amt = Number(pay.amount || 0);
    const newPaid = prevPaid + amount;
    const status = amt > 0 && newPaid >= amt - 0.005 ? "paga" : pay.status;
    await storage.updatePayable(payId, { amountPaid: newPaid.toFixed(2), status, paymentMethod: method, financialAccountId: accountId || pay.financialAccountId || null } as any);
    await storage.createPayablePayment({ payableId: payId, paidAt: paidAtISO as any, amount: amount.toFixed(2), paymentMethod: method as any, financialAccountId: accountId || pay.financialAccountId || null, reference: "conciliacao-bancaria", createdBy: by } as any);
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

  app.post("/api/reconciliation/items/:id/ignore", async (req, res) => {
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

  app.post("/api/reconciliation/items/:id/reconcile", async (req, res) => {
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

}
