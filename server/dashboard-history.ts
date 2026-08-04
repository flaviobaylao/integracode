import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import cron from "node-cron";
import { nfVendaWhere, nfVendaFrom, nfData, VENDEDOR_JOIN, VIGENCIA_REGRA_OFICIAL } from "./faturamento-oficial";

// ============================================================================
// HISTORICO DO DASHBOARD (Faturamento Efetivo) -- reconcilia com a regra OFICIAL.
// Fonte unica: server/faturamento-oficial.ts. Split de vigencia:
//   dia >= VIGENCIA_REGRA_OFICIAL  -> regra nova (dedup por NF + CFOP + SEM AT TIME ZONE)
//   dia <  VIGENCIA_REGRA_OFICIAL  -> calculo legado (nao reprocessamos o passado)
// Grava 1 snapshot/dia: faturamento do dia + faturamento por vendedor do dia.
// Observacao: o AT TIME ZONE do modulo antigo empurrava as notas do fim da tarde
// do ultimo dia do mes para o mes seguinte (jun/jul nao batiam). Removido.
// ============================================================================

// Filtro legado -- IDENTICO ao usado na serie mensal para o periodo anterior a vigencia.
const LEGADO_WHERE = "fi.status='authorized' AND COALESCE(fi.operation_type,'saida') <> 'entrada' AND COALESCE(fi.fin_nfe,'1') <> '4' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%DEVOL%' AND UPPER(COALESCE(fi.nature_of_operation,'')) LIKE '%VENDA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%TROCA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%TRANSFER%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%REMESSA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%BONIFICA%' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%AMOSTRA%' AND (fi.import_origin IS NULL OR TRIM(fi.import_origin) = '')";
const LEGADO_DATA = "COALESCE(fi.emission_date, fi.authorization_date, fi.created_at)";

const rawq = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

function todayBrt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Query (dia, vendedor, total) para o intervalo [iniSql, fimSql) sob a regra correta.
// iniSql/fimSql sao expressoes SQL de data (ex.: "'2026-08-03'::date").
function sqlDiaVendedor(iniSql: string, fimSql: string, oficial: boolean): string {
  const dataExpr = oficial ? nfData("fi") : LEGADO_DATA;
  const whereExpr = oficial ? nfVendaWhere("fi") : LEGADO_WHERE;
  const fromExpr = oficial ? nfVendaFrom("fi") : "fiscal_invoices fi";
  return "SELECT " + dataExpr + "::date::text AS d, COALESCE(v.nome,'Sem vendedor') AS seller, COALESCE(SUM(fi.total_invoice),0) AS total"
    + " FROM " + fromExpr + " " + VENDEDOR_JOIN
    + " WHERE " + whereExpr + " AND " + dataExpr + "::date >= " + iniSql + " AND " + dataExpr + "::date < " + fimSql
    + " GROUP BY 1,2 HAVING COALESCE(SUM(fi.total_invoice),0) <> 0";
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
  const oficial = d >= VIGENCIA_REGRA_OFICIAL;
  const iniSql = "'" + d + "'::date";
  const fimSql = "('" + d + "'::date + INTERVAL '1 day')";
  const rows = await rawq(sqlDiaVendedor(iniSql, fimSql, oficial));
  const sellers = rows.map((r) => ({ seller: r.seller, total: Number(r.total) || 0 }))
    .sort((a, b) => b.total - a.total);
  const daySales = sellers.reduce((a, s) => a + s.total, 0);
  await upsertSnapshot(d, daySales, sellers);
  return { date: d, daySales, sellers: sellers.length };
}

// Reconstroi todos os dias com NF-e desde 2026-01-01, mes a mes, respeitando a vigencia.
export async function backfillDashboardHistory(): Promise<number> {
  await ensureDashboardHistoryTable();
  // Meses do periodo LEGADO (< vigencia).
  const mesesLegado = await rawq("SELECT DISTINCT to_char(date_trunc('month', " + LEGADO_DATA + "),'YYYY-MM-DD') AS m FROM fiscal_invoices fi WHERE " + LEGADO_WHERE + " AND " + LEGADO_DATA + "::date < '" + VIGENCIA_REGRA_OFICIAL + "'::date AND " + LEGADO_DATA + "::date >= '2026-01-01'::date ORDER BY 1");
  // Meses do periodo OFICIAL (>= vigencia).
  const mesesOficial = await rawq("SELECT DISTINCT to_char(date_trunc('month', " + nfData("fi") + "),'YYYY-MM-DD') AS m FROM " + nfVendaFrom("fi") + " WHERE " + nfVendaWhere("fi") + " AND " + nfData("fi") + "::date >= '" + VIGENCIA_REGRA_OFICIAL + "'::date ORDER BY 1");

  const jobs: { m: string; oficial: boolean }[] = [];
  for (const r of mesesLegado) jobs.push({ m: String(r.m).slice(0, 10), oficial: false });
  for (const r of mesesOficial) jobs.push({ m: String(r.m).slice(0, 10), oficial: true });

  let n = 0;
  for (const job of jobs) {
    const iniSql = "'" + job.m + "'::date";
    const fimSql = "('" + job.m + "'::date + INTERVAL '1 month')";
    const rows = await rawq(sqlDiaVendedor(iniSql, fimSql, job.oficial));
    const byDay: Record<string, { seller: string; total: number }[]> = {};
    for (const r of rows) {
      const d = String(r.d).slice(0, 10);
      (byDay[d] = byDay[d] || []).push({ seller: r.seller, total: Number(r.total) || 0 });
    }
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
