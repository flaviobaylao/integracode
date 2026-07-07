import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { generateBoletoForReceivable, generatePixForReceivable } from "./billing-pipeline-routes";

// ---------------------------------------------------------------------------
// GARANTIR COBRANCA - corrige "faturado sem cobranca" DAQUI PRA FRENTE.
//   POST /api/admin/customers/pull-cep-from-1-0 { apply }  -> preenche CEP/endereco faltantes do 1.0 (fill-only)
//   POST /api/admin/financial/garantir-cobranca { apply, sinceISO, cutoffReset }
//        -> gera a cobranca que faltou nos recebiveis de VENDA em aberto criados A PARTIR do cutoff (nao toca no legado)
//   GET  /api/admin/financial/garantir-cobranca/last
// O cutoff (system_settings.charge_guarantee_cutoff) e fixado no 1o uso = "de agora em diante".
// ---------------------------------------------------------------------------

const dig = (x: any): string => String(x ?? "").replace(/\D/g, "");

async function pgClient(url: string | undefined) {
  const pgMod = await import("pg");
  const c = new pgMod.default.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    return r?.rows?.[0]?.value ?? null;
  } catch { return null; }
}
async function setSetting(key: string, value: string) {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${value}, 'charge-guarantee', now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'charge-guarantee', updated_at = now()`);
}

export function registerChargeGuarantee(app: Express) {
  // ---- Puxar CEP/endereco faltantes do 1.0 (fill-only, por documento) -----
  app.post("/api/admin/customers/pull-cep-from-1-0", async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    let src: any = null;
    try {
      src = await pgClient(process.env.REPLIT_DATABASE_URL);
      const wanted = ["zip_code", "address", "city", "neighborhood", "state"];
      const colsRes = (await src.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'"
      )).rows.map((r: any) => r.column_name);
      const have = wanted.filter((c) => colsRes.includes(c));
      if (!have.includes("zip_code")) return res.status(400).json({ error: "1.0 sem coluna zip_code", colsDoOneZero: colsRes.filter((c: string) => /zip|cep|address|city|bairro|neighbor|state|uf/i.test(c)) });
      const sel = have.map((c) => `"${c}"`).join(", ");
      const rows1 = (await src.query(
        `SELECT COALESCE(NULLIF(regexp_replace(COALESCE(cnpj,''),'\\D','','g'),''), NULLIF(regexp_replace(COALESCE(cpf,''),'\\D','','g'),'')) AS doc, ${sel}
         FROM customers WHERE (cnpj IS NOT NULL OR cpf IS NOT NULL)`
      )).rows as any[];
      const byDoc = new Map<string, any>();
      for (const r of rows1) { const d = dig(r.doc); if (d.length >= 11) byDoc.set(d, r); }

      const cust2 = await storage.getCustomers();
      const alvo = (cust2 || []).filter((c: any) => dig(c.zipCode).length < 8);
      let matched = 0, updated = 0, semMatch = 0; const erros: string[] = [];
      const amostra: any[] = [];
      for (const c of alvo) {
        const d = dig(c.cnpj) || dig(c.cpf) || dig(c.document);
        if (d.length < 11) { semMatch++; continue; }
        const src1 = byDoc.get(d);
        if (!src1) { semMatch++; continue; }
        matched++;
        const patch: any = {};
        if (dig(c.zipCode).length < 8 && dig(src1.zip_code).length === 8) patch.zipCode = String(src1.zip_code);
        if (!c.address && src1.address) patch.address = String(src1.address);
        if (!c.city && src1.city) patch.city = String(src1.city);
        if (!c.neighborhood && src1.neighborhood) patch.neighborhood = String(src1.neighborhood);
        if (!c.state && src1.state) patch.state = String(src1.state);
        if (!Object.keys(patch).length) continue;
        if (amostra.length < 15) amostra.push({ nome: c.name, ...patch });
        if (apply) {
          try { await storage.updateCustomer(c.id, patch); updated++; }
          catch (e: any) { erros.push(`${c.name}: ${e?.message || e}`); }
        } else { updated++; }
      }
      res.json({ apply, colunas1_0: have, alvoSemCEP: alvo.length, matched, updated, semMatch, erros: erros.slice(0, 20), amostra });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    } finally { try { if (src) await src.end(); } catch {} }
  });

  // ---- Garantir cobranca nos recebiveis de venda em aberto (a partir do cutoff) ----
  app.post("/api/admin/financial/garantir-cobranca", async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    try {
      let cutoff = await getSetting("charge_guarantee_cutoff");
      if (req.body?.cutoffReset) { cutoff = new Date().toISOString(); await setSetting("charge_guarantee_cutoff", cutoff); }
      if (!cutoff) { cutoff = new Date().toISOString(); await setSetting("charge_guarantee_cutoff", cutoff); }
      const since = req.body?.sinceISO ? new Date(req.body.sinceISO).toISOString() : cutoff;

      const rows: any = await db.execute(sql`
        SELECT r.id, r.amount, r.due_date, r.customer_id, r.customer_name, r.customer_document,
               r.fiscal_invoice_id, r.billing_pipeline_id, r.omie_instance_id, r.payment_method,
               r.title_number, r.created_at,
               bp.omie_instance_name, bp.order_number, bp.sales_card_id
        FROM receivables r
        LEFT JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
        WHERE r.billing_pipeline_id IS NOT NULL
          AND r.status IN ('a_vencer','vencida')
          AND (r.amount - COALESCE(r.amount_paid,0)) > 0
          AND r.created_at >= ${since}
          AND NOT EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM pix_charges pc WHERE pc.receivable_id = r.id)
        ORDER BY r.created_at ASC
        LIMIT 200`);
      const list = rows?.rows || [];
      let ok = 0, skipped = 0, fail = 0; const detalhes: any[] = [];
      if (apply) {
        for (const r of list) {
          const receivable = {
            id: r.id, amount: r.amount, dueDate: r.due_date,
            customerName: r.customer_name, customerDocument: r.customer_document,
            customerId: r.customer_id, fiscalInvoiceId: r.fiscal_invoice_id,
          };
          const item = {
            id: r.billing_pipeline_id, customerId: r.customer_id,
            omieInstanceId: r.omie_instance_id, omieInstanceName: r.omie_instance_name,
            orderNumber: r.order_number, salesCardId: r.sales_card_id,
            invoiceNumber: r.title_number, saleValue: r.amount,
          };
          const fm = String(r.payment_method || "").toLowerCase();
          try {
            const res1 = fm === "boleto"
              ? await generateBoletoForReceivable(receivable, item)
              : await generatePixForReceivable(receivable, item);
            if (res1?.ok) { ok++; detalhes.push({ titulo: r.title_number, forma: fm, ok: true }); }
            else if (res1?.skipped) { skipped++; detalhes.push({ titulo: r.title_number, forma: fm, skipped: true }); }
            else { fail++; detalhes.push({ titulo: r.title_number, forma: fm, erro: res1?.error }); }
          } catch (e: any) { fail++; detalhes.push({ titulo: r.title_number, forma: fm, erro: e?.message }); }
        }
        await setSetting("charge_guarantee_last", JSON.stringify({ at: new Date().toISOString(), candidatos: list.length, ok, skipped, fail }));
      }
      res.json({ apply, cutoff, since, candidatos: list.length, ok, skipped, fail, detalhes: detalhes.slice(0, 50) });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get("/api/admin/financial/garantir-cobranca/last", async (_req: Request, res: Response) => {
    const v = await getSetting("charge_guarantee_last");
    res.json(v ? JSON.parse(v) : { none: true });
  });
}
