import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import cron from "node-cron";

// ============================================================================
// HISTORICO DO DASHBOARD (Faturamento Efetivo)
// Grava 1 snapshot por dia (faturamento fiscal do dia + por vendedor), permitindo
// consultar qualquer data/mes passado. Tabela criada sob demanda (CREATE TABLE IF NOT EXISTS).
// Atribuicao por vendedor = mesma logica do Comparativo (card do pipeline -> cartao -> carteira).
// ============================================================================

const FISCAL_WHERE = "fi.status='authorized' AND COALESCE(fi.operation_type,'saida')<>'entrada' AND COALESCE(fi.fin_nfe,'1')<>'4' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%DEVOL%' AND UPPER(COALESCE(fi.nature_of_operation,'')) LIKE '%VENDA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%TROCA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%TRANSFER%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%REMESSA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%BONIFICA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%AMOSTRA%' AND (fi.import_origin IS NULL OR TRIM(fi.import_origin)='')";

const SELLER_EXPR = "COALESCE((SELECT COALESCE(NULLIF(TRIM(CONCAT(up.first_name,' ',up.last_name)),''), NULLIF(TRIM(bp.seller_name),'')) FROM billing_pipeline bp LEFT JOIN users up ON (up.omie_vendor_code=bp.seller_id OR up.omie_vendor_code=replace(COALESCE(bp.seller_id,''),'omie-vendor-','') OR up.id=bp.seller_id) WHERE bp.sales_card_id=fi.sales_card_id ORDER BY bp.created_at DESC NULLS LAST LIMIT 1), (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM sales_cards sc JOIN users u ON (u.omie_vendor_code=sc.seller_id OR u.omie_vendor_code=replace(COALESCE(sc.seller_id,''),'omie-vendor-','') OR u.id=sc.seller_id) WHERE sc.id=fi.sales_card_id LIMIT 1), (SELECT NULLIF(TRIM(CONCAT(u2.first_name,' ',u2.last_name)),'') FROM customers c JOIN users u2 ON (u2.omie_vendor_code=c.seller_id OR u2.omie_vendor_code=replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u2.id=c.seller_id) WHERE regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g')<>'' AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g')=regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') LIMIT 1), 'Sem vendedor')";

const DATE_EXPR = "(COALESCE(fi.emission_date,fi.authorization_date,fi.created_at) AT TIME ZONE 'America/Sao_Paulo')::date";

const rawq = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

function todayBrt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

let _ensured = false;
export async function ensureDashboardHistoryTable(): Promise<void> {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS dashboard_snapshots (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date date NOT NULL UNIQUE,
    captured_at timestamptz DEFAULT now(),
    day_sales numeric NOT NULL DEFAULT 0,
    sellers jsonb NOT NULL DEFAULT '[]'::jsonb
  )`);
  _ensured = true;
}

async function upsertSnapshot(dateStr: string, daySales: number, sellers: any[]): Promise<void> {
  await db.execute(sql`INSERT INTO dashboard_snapshots (snapshot_date, day_sales, sellers, captured_at)
    VALUES (${dateStr}::date, ${daySales}, ${JSON.stringify(sellers)}::jsonb, now())
    ON CONFLICT (snapshot_date) DO UPDATE SET day_sales = EXCLUDED.day_sales, sellers = EXCLUDED.sellers, captured_at = now()`);
}

// Captura (ou atualiza) o snapshot de UM dia. Default: hoje (BRT).
export async function captureDashboardSnapshot(dateStr?: string): Promise<{ date: string; daySales: number; sellers: number }> {
  await ensureDashboardHistoryTable();
  const d = dateStr || todayBrt();
  const rows = await rawq("SELECT " + SELLER_EXPR + " AS seller, COALESCE(SUM(fi.total_invoice),0) AS total FROM fiscal_invoices fi WHERE " + FISCAL_WHERE + " AND " + DATE_EXPR + " = '" + d + "'::date GROUP BY 1 HAVING COALESCE(SUM(fi.total_invoice),0) <> 0 ORDER BY total DESC");
  const sellers = rows.map((r) => ({ seller: r.seller, total: Number(r.total) || 0 }));
  const daySales = sellers.reduce((a, s) => a + s.total, 0);
  await upsertSnapshot(d, daySales, sellers);
  return { date: d, daySales, sellers: sellers.length };
}

// Backfill: reconstroi todos os dias com NF-e desde 2026-03-01, mes a mes (mais leve).
export async function backfillDashboardHistory(): Promise<number> {
  await ensureDashboardHistoryTable();
  const months = await rawq("SELECT DISTINCT to_char(date_trunc('month', " + DATE_EXPR + "),'YYYY-MM-DD') AS m FROM fiscal_invoices fi WHERE " + FISCAL_WHERE + " AND " + DATE_EXPR + " >= '2026-03-01'::date ORDER BY 1");
  let n = 0;
  for (const mrow of months) {
    const m = String(mrow.m).slice(0, 10);
    const rows = await rawq("SELECT " + DATE_EXPR + " AS d, " + SELLER_EXPR + " AS seller, COALESCE(SUM(fi.total_invoice),0) AS total FROM fiscal_invoices fi WHERE " + FISCAL_WHERE + " AND " + DATE_EXPR + " >= '" + m + "'::date AND " + DATE_EXPR + " < ('" + m + "'::date + INTERVAL '1 month') GROUP BY 1, 2 HAVING COALESCE(SUM(fi.total_invoice),0) <> 0");
    const byDay: Record<string, { seller: string; total: number }[]> = {};
    for (const r of rows) { const d = String(r.d).slice(0, 10); (byDay[d] = byDay[d] || []).push({ seller: r.seller, total: Number(r.total) || 0 }); }
    for (const d of Object.keys(byDay)) {
      const sellers = byDay[d].sort((a, b) => b.total - a.total);
      const daySales = sellers.reduce((a, s) => a + s.total, 0);
      await upsertSnapshot(d, daySales, sellers);
      n++;
    }
  }
  return n;
}

export function registerDashboardHistoryRoutes(app: Express): void {
  // Garante tabela + backfill inicial (uma vez, em background) sem travar o boot.
  ensureDashboardHistoryTable().then(async () => {
    try {
      const c = await rawq("SELECT COUNT(*)::int AS n FROM dashboard_snapshots");
      if ((c[0]?.n || 0) === 0) {
        backfillDashboardHistory().then((k) => console.log("[DASH-HIST] backfill inicial: " + k + " dias")).catch((e) => console.error("[DASH-HIST] backfill:", e?.message));
      }
    } catch (e) { /* ignora */ }
  }).catch(() => {});

  // Leitura do historico (publico, somente leitura).
  app.get("/api/dashboard2/history", async (_req, res) => {
    try {
      await ensureDashboardHistoryTable();
      const snaps = await rawq("SELECT snapshot_date::text AS snapshot_date, day_sales, sellers, captured_at FROM dashboard_snapshots ORDER BY snapshot_date");
      res.json({ snapshots: snaps.map((s) => ({ date: s.snapshot_date, daySales: Number(s.day_sales) || 0, sellers: s.sellers || [], capturedAt: s.captured_at })) });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Snapshot diario automatico as 23:30 (BRT).
  try {
    cron.schedule("30 23 * * *", () => {
      captureDashboardSnapshot().then((r) => console.log("[DASH-HIST] snapshot " + r.date + " = " + r.daySales)).catch((e) => console.error("[DASH-HIST] cron:", e?.message));
    }, { timezone: "America/Sao_Paulo" });
  } catch (e: any) { console.error("[DASH-HIST] cron setup:", e?.message); }

  // Gatilho manual protegido por token (testar/forcar captura ou backfill).
  app.all("/api/dashboard2/history/run", async (req, res) => {
    try {
      const token = (req.query && (req.query as any).token);
      if (token !== "vday-6931") return res.json({ error: "forbidden" });
      const mode = (req.query as any).mode;
      if (mode === "backfill") { const k = await backfillDashboardHistory(); return res.json({ ok: true, backfill: k }); }
      const r = await captureDashboardSnapshot((req.query as any).date);
      res.json({ ok: true, ...r });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });
}
