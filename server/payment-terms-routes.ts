import type { Express } from "express";

// ---------------------------------------------------------------------------
// Prazos/condições de pagamento por cliente — puxa do 1.0 (Neon) p/ o 2.0.
//   GET  /api/admin/payment-terms/diag-1-0      -> lista colunas de pagamento do 1.0 + amostra
//   POST /api/admin/payment-terms/pull-from-1-0 { apply, map } -> copia por documento
// map = { payment_method, boleto_days, collection_discount, payment_installments } -> nome da coluna no 1.0
// Alvo no 2.0 (customers): payment_method (enum), boleto_days (int), collection_discount (numeric), payment_installments (int)
// ---------------------------------------------------------------------------

const dig = (x: any): string => String(x ?? "").replace(/\D/g, "");

async function client(url: string | undefined) {
  const pgMod = await import("pg");
  const c = new pgMod.default.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export function registerPaymentTerms(app: Express) {
  // ---- Diagnóstico: colunas de pagamento no 1.0 ---------------------------
  app.get("/api/admin/payment-terms/diag-1-0", async (_req, res) => {
    let src: any = null;
    try {
      src = await client(process.env.REPLIT_DATABASE_URL);
      const cols = (await src.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' ORDER BY ordinal_position"
      )).rows as any[];
      const rx = /pay|boleto|prazo|desconto|discount|parcel|installment|forma|dias|term|cond|venc/i;
      const payCols = cols.filter((c) => rx.test(c.column_name));
      let samples: any[] = [];
      const names = payCols.map((c) => c.column_name);
      if (names.length) {
        const sel = names.map((c) => `"${c}"`).join(", ");
        const whereNN = names.map((c) => `"${c}" IS NOT NULL`).join(" OR ");
        samples = (await src.query(
          `SELECT name, ${sel} FROM customers WHERE (${whereNN}) LIMIT 10`
        )).rows;
      }
      res.json({ totalCols: cols.length, payCols, samples });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      try { if (src) await src.end(); } catch {}
    }
  });

  // ---- Puxar forma/prazo/desconto/parcelamento do 1.0 p/ o 2.0 ------------
  app.post("/api/admin/payment-terms/pull-from-1-0", async (req, res) => {
    const apply = req.body?.apply === true;
    const map = (req.body?.map || {}) as Record<string, string>;
    // alvo 2.0 -> coluna 1.0
    const targets = {
      payment_method: map.payment_method || "",
      boleto_days: map.boleto_days || "",
      collection_discount: map.collection_discount || "",
      payment_installments: map.payment_installments || "",
    };
    const srcCols = Object.values(targets).filter(Boolean);
    if (!srcCols.length) return res.status(400).json({ error: "informe map com ao menos uma coluna do 1.0" });

    let src: any = null, tgt: any = null;
    try {
      src = await client(process.env.REPLIT_DATABASE_URL);
      tgt = await client(process.env.DATABASE_URL);

      await tgt.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS boleto_days integer").catch(() => {});
      await tgt.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_method varchar").catch(() => {});
      await tgt.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS collection_discount numeric DEFAULT 0").catch(() => {});
      await tgt.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_installments integer DEFAULT 1").catch(() => {});

      // enum válido p/ payment_method no 2.0 (customers.payment_method)
      const pmEnum = new Set(["a_vista", "boleto", "pix", "cartao", "cartao_credito", "cartao_debito", "transferencia", "dinheiro", "cheque", "a_prazo"]);
      const normPm = (v: any): string | null => {
        const s = String(v ?? "").toLowerCase().trim();
        if (!s) return null;
        if (s.includes("pix")) return "pix";
        if (s.includes("boleto")) return "boleto";
        if (s.includes("vista") || s.includes("dinheiro")) return "a_vista";
        if (s.includes("prazo")) return "a_prazo";
        return pmEnum.has(s) ? s : null;
      };
      const num = (v: any): number | null => {
        if (v == null || v === "") return null;
        const n = parseFloat(String(v).replace(/[^0-9.,-]/g, "").replace(",", "."));
        return isNaN(n) ? null : n;
      };

      const selSrc = ["cnpj", "cpf", ...srcCols].map((c) => `"${c}"`).join(", ");
      const s1 = (await src.query(`SELECT ${selSrc} FROM customers`)).rows as any[];
      const t2 = (await tgt.query("SELECT id, cnpj, cpf FROM customers")).rows as any[];
      const docToId = new Map<string, string>();
      for (const c of t2) for (const d of [dig(c.cnpj), dig(c.cpf)]) if (d.length >= 11 && !docToId.has(d)) docToId.set(d, String(c.id));

      const result: any = { srcCustomers: s1.length, apply, matched: 0, updated: 0, semDoc: 0, semMatch: 0, errors: [] as string[] };
      for (const row of s1) {
        const d = [dig(row.cnpj), dig(row.cpf)].find((x) => x.length >= 11);
        if (!d) { result.semDoc++; continue; }
        const id = docToId.get(d);
        if (!id) { result.semMatch++; continue; }
        result.matched++;

        const sets: string[] = []; const vals: any[] = [];
        if (targets.payment_method) { const v = normPm(row[targets.payment_method]); if (v) { sets.push(`payment_method = $${vals.length + 1}`); vals.push(v); } }
        if (targets.boleto_days) { const v = num(row[targets.boleto_days]); if (v != null) { sets.push(`boleto_days = $${vals.length + 1}`); vals.push(Math.round(v)); } }
        if (targets.collection_discount) { const v = num(row[targets.collection_discount]); if (v != null) { sets.push(`collection_discount = $${vals.length + 1}`); vals.push(v); } }
        if (targets.payment_installments) { const v = num(row[targets.payment_installments]); if (v != null) { sets.push(`payment_installments = $${vals.length + 1}`); vals.push(Math.round(v)); } }
        if (!sets.length) continue;
        if (apply) {
          try {
            vals.push(id);
            await tgt.query(`UPDATE customers SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
            result.updated++;
          } catch (e: any) { if (result.errors.length < 10) result.errors.push(String(e?.message || e)); }
        } else {
          result.updated++; // dry-run: conta o que atualizaria
        }
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    } finally {
      try { if (src) await src.end(); } catch {}
      try { if (tgt) await tgt.end(); } catch {}
    }
  });
}
