import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { settleBoletoCharge } from "./bb-boleto-service";
import { authenticateUser, requireRole } from "./authMiddleware";
const FIN_ROLES = ["admin", "coordinator", "administrative"]; // FASE 1c

// ---------------------------------------------------------------------------
// Pagamento Clientes (customer-payments) — conciliação por importação de
// planilha de boletos. Porta a tela do 1.0:
//   POST /api/financial/payment-verification/analyze        { rows }
//   POST /api/financial/payment-verification/settle/:id     { amount, paidAt, financialAccountId, paymentMethod }
// Matching: Nosso Número -> boleto_charges -> receivable; fallback por documento.
// A baixa reusa a infra testada (settleBoletoCharge) quando há boleto.
// ---------------------------------------------------------------------------

const onlyDigits = (v: any): string => (v == null ? "" : String(v)).replace(/\D/g, "");

function parseAmount(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  let s = String(v).trim().replace(/[^0-9.,-]/g, "");
  if (s === "") return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // o último separador é o decimal
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function toISO(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s.length <= 10 ? s + "T12:00:00" : s);
  else if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const p = s.slice(0, 10).split("/");
    d = new Date(`${p[2]}-${p[1]}-${p[0]}T12:00:00`);
  } else d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function rowsOf(r: any): any[] {
  return (r && r.rows) ? r.rows : (Array.isArray(r) ? r : []);
}

export function registerPaymentVerificationRoutes(app: Express) {
  // ---- ANALYZE (read-only) ----
  app.post("/api/financial/payment-verification/analyze", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return res.json({ total: 0, summary: { nao_baixado: 0, ja_baixado: 0, nao_encontrado: 0 }, rows: [] });

      const nossos = Array.from(new Set(rows.map((r) => onlyDigits(r.nossoNumero)).filter(Boolean)));
      const docs = Array.from(new Set(rows.map((r) => onlyDigits(r.documento)).filter(Boolean)));

      // boletos por nosso_numero
      const boletoByNosso = new Map<string, any>();
      if (nossos.length) {
        const br = await db.execute(sql`
          SELECT id, nosso_numero, receivable_id, fiscal_invoice_id, status, valor_original, numero_convenio, customer_id
          FROM boleto_charges
          WHERE regexp_replace(coalesce(nosso_numero, ''), '[^0-9]', '', 'g') = ANY(string_to_array(${nossos.join(",")}, ','))
        `);
        for (const b of rowsOf(br)) boletoByNosso.set(onlyDigits(b.nosso_numero), b);
      }

      // recebíveis pelos ids dos boletos
      const recIds = Array.from(new Set(Array.from(boletoByNosso.values()).map((b) => b.receivable_id).filter(Boolean)));
      const recById = new Map<string, any>();
      if (recIds.length) {
        const rr = await db.execute(sql`
          SELECT id, title_number, customer_name, customer_document, amount, amount_paid, status, due_date, payment_method, financial_account_id, billing_pipeline_id
          FROM receivables WHERE id = ANY(string_to_array(${recIds.join(",")}, ','))
        `);
        for (const r of rowsOf(rr)) recById.set(String(r.id), r);
      }

      // recebíveis em aberto por documento (fallback)
      const recByDoc = new Map<string, any[]>();
      if (docs.length) {
        const dr = await db.execute(sql`
          SELECT id, title_number, customer_name, customer_document, amount, amount_paid, status, due_date, payment_method, financial_account_id
          FROM receivables
          WHERE regexp_replace(coalesce(customer_document, ''), '[^0-9]', '', 'g') = ANY(string_to_array(${docs.join(",")}, ','))
            AND status <> 'recebida'
        `);
        for (const r of rowsOf(dr)) {
          const k = onlyDigits(r.customer_document);
          if (!recByDoc.has(k)) recByDoc.set(k, []);
          recByDoc.get(k)!.push(r);
        }
      }

      const summary: any = { nao_baixado: 0, ja_baixado: 0, nao_encontrado: 0 };
      const out = rows.map((row, idx) => {
        const nn = onlyDigits(row.nossoNumero);
        const dd = onlyDigits(row.documento);
        const valor = parseAmount(row.valor ?? row.valorLiquidacao);
        let receivable: any = null;
        let matchSource: string | null = null;
        let boleto: any = null;

        if (nn && boletoByNosso.has(nn)) {
          boleto = boletoByNosso.get(nn);
          const r = boleto.receivable_id ? recById.get(String(boleto.receivable_id)) : null;
          if (r) { receivable = r; matchSource = "nossoNumero"; }
        }
        if (!receivable && dd && recByDoc.has(dd)) {
          const cands = recByDoc.get(dd)!;
          let best = cands[0];
          if (valor > 0 && cands.length > 1) {
            best = cands.slice().sort((a, b) => Math.abs(Number(a.amount) - valor) - Math.abs(Number(b.amount) - valor))[0];
          }
          receivable = best; matchSource = "documento";
        }

        let status: string;
        if (!receivable) status = "nao_encontrado";
        else {
          const paid = Number(receivable.amount_paid || 0);
          const amt = Number(receivable.amount || 0);
          status = (receivable.status === "recebida" || (amt > 0 && paid >= amt)) ? "ja_baixado" : "nao_baixado";
        }
        summary[status] = (summary[status] || 0) + 1;

        const recOut = receivable ? {
          id: receivable.id,
          customerName: receivable.customer_name,
          customerDocument: receivable.customer_document,
          amount: Number(receivable.amount || 0),
          amountPaid: Number(receivable.amount_paid || 0),
          status: receivable.status,
          dueDate: receivable.due_date,
          paidDate: null,
        } : null;

        return {
          idx,
          nr: idx + 1,
          payerName: row.payerName || row.nome || row.pagador || (receivable ? receivable.customer_name : "") || "",
          document: row.documento || "",
          emissao: row.emissao || null,
          vencimento: row.vencimento || null,
          nossoNumero: row.nossoNumero || "",
          situacao: row.situacao || "",
          dataSituacao: row.dataSituacao || null,
          valor,
          valorLiquidacao: parseAmount(row.valorLiquidacao ?? row.valor),
          tipoLiquidacao: row.tipoLiquidacao || "",
          status,
          receivable: recOut,
          financialAccountId: receivable ? receivable.financial_account_id : null,
          invoiceNumber: receivable ? receivable.title_number : null,
          matchSource,
          boletoId: boleto ? boleto.id : null,
          boletoStatus: boleto ? boleto.status : null,
        };
      });

      res.json({ total: out.length, summary, rows: out });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao analisar" });
    }
  });

  // ---- SETTLE (baixa — ação financeira) ----
  app.post("/api/financial/payment-verification/settle/:receivableId", authenticateUser, requireRole(FIN_ROLES), async (req, res) => {
    try {
      const receivableId = req.params.receivableId;
      const amount = Number(req.body?.amount || 0);
      const paidAtISO = toISO(req.body?.paidAt) || new Date().toISOString();
      const paymentMethod = req.body?.paymentMethod || "boleto";
      const financialAccountId = req.body?.financialAccountId || null;
      if (!receivableId || !(amount > 0)) {
        return res.status(400).json({ error: "receivableId e amount (>0) são obrigatórios" });
      }

      // caminho 1: há boleto vinculado -> reusa a baixa testada
      const br = await db.execute(sql`
        SELECT * FROM boleto_charges WHERE receivable_id = ${receivableId}
        ORDER BY created_at DESC NULLS LAST LIMIT 1
      `);
      const charge = rowsOf(br)[0];
      if (charge) {
        const result = await settleBoletoCharge(charge, amount, paidAtISO, "planilha-pagamentos");
        return res.json({ ok: true, via: "boleto", result });
      }

      // caminho 2: sem boleto (match por documento) -> baixa direta no recebível
      const receivable: any = await storage.getReceivable(receivableId);
      if (!receivable) return res.status(404).json({ error: "recebível não encontrado" });
      const prevPaid = Number(receivable.amountPaid || 0);
      const amt = Number(receivable.amount || 0);
      const newPaid = prevPaid + amount;
      const status = (amt > 0 && newPaid >= amt - 0.005) ? "recebida" : "parcial";
      await storage.updateReceivable(receivableId, {
        amountPaid: newPaid.toFixed(2),
        status,
        paymentMethod,
        financialAccountId: financialAccountId || receivable.financialAccountId || null,
      } as any);
      await storage.createReceivablePayment({
        receivableId,
        paidAt: paidAtISO,
        amount: amount.toFixed(2),
        paymentMethod,
        financialAccountId: financialAccountId || receivable.financialAccountId || null,
        reference: "conciliacao-planilha",
      } as any);
      res.json({ ok: true, via: "receivable", status });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao dar baixa" });
    }
  });
}
