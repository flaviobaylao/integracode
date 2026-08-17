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
// O backfill LIMPA o intervalo antes de repovoar (senao dias orfaos de um bucket
// antigo -- ex.: AT TIME ZONE -- sobrevivem e inflam os totais mensais).
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
  // Limpa o intervalo reconstruido: garante que dias sem NF-e valida (ou orfaos de um
  // bucket antigo) desaparecam em vez de sobreviver com valor obsoleto.
  await db.execute(sql`DELETE FROM dashboard_snapshots WHERE snapshot_date >= '2026-01-01'::date`);
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

// ============================================================================
// PREVISAO DE FATURAMENTO POR CLIENTE DA CARTEIRA (periodicidade + dia da semana)
// Para cada cliente com >=2 compras nos ultimos ~100 dias: calcula periodicidade
// (media dos intervalos, ponderada por recencia), dia da semana dominante e ticket
// medio (ponderado por recencia). Projeta as proximas compras dentro do mes vigente,
// creditando ao dono da carteira (customers.seller_id). Retorna 1 valor por (vendedor, dia).
// ============================================================================

function ymdToDate(iso: string): Date { const p = iso.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function dateToYmd(dt: Date): string { return dt.toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string { const dt = ymdToDate(iso); dt.setUTCDate(dt.getUTCDate() + n); return dateToYmd(dt); }
function weekdayOf(iso: string): number { return ymdToDate(iso).getUTCDay(); } // 0=dom ... 6=sab
function diffDays(a: string, b: string): number { return Math.round((ymdToDate(b).getTime() - ymdToDate(a).getTime()) / 86400000); }

const CARTEIRA_SELLER = "(SELECT DISTINCT ON (doc) doc, seller FROM (SELECT regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') AS doc, NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') AS seller FROM customers c JOIN users u ON (u.omie_vendor_code=c.seller_id OR u.omie_vendor_code=replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id=c.seller_id) WHERE regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g') <> '') s ORDER BY doc) cs";

export async function computeForecast(only?: string): Promise<{ asOf: string; monthEnd: string; forecast: { seller: string; date: string; value: number }[]; total: number; clients: number }> {
  const today = todayBrt();
  const [Y, M] = today.split("-").map(Number);
  const monthEnd = dateToYmd(new Date(Date.UTC(Y, M, 0)));
  const lookbackStart = addDays(today, -100);

  const dcol = nfData("fi");
  const purchases = await rawq(
    "SELECT regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') AS doc, " + dcol + "::date::text AS d, COALESCE(SUM(fi.total_invoice),0) AS v" +
    " FROM " + nfVendaFrom("fi") + " WHERE " + nfVendaWhere("fi") +
    " AND " + dcol + "::date >= '" + lookbackStart + "'::date AND " + dcol + "::date <= '" + today + "'::date" +
    " AND regexp_replace(COALESCE(fi.customer_cnpj_cpf,''),'[^0-9]','','g') <> '' GROUP BY 1, 2"
  );
  const carteira = await rawq("SELECT doc, seller FROM " + CARTEIRA_SELLER);
  const docSeller: Record<string, string> = {};
  for (const r of carteira) { const d = String(r.doc); if (d && !(d in docSeller)) docSeller[d] = r.seller || "Sem vendedor"; }

  const byDoc: Record<string, { d: string; v: number }[]> = {};
  for (const r of purchases) { const doc = String(r.doc); (byDoc[doc] = byDoc[doc] || []).push({ d: String(r.d).slice(0, 10), v: Number(r.v) || 0 }); }

  const fmap: Record<string, number> = {};
  let clients = 0;
  for (const doc of Object.keys(byDoc)) {
    const rows = byDoc[doc].filter((x) => x.v > 0).sort((a, b) => a.d.localeCompare(b.d));
    if (rows.length < 2) continue;
    // periodicidade = media dos intervalos ponderada por recencia
    let gs = 0, gw = 0;
    for (let i = 1; i < rows.length; i++) { const g = diffDays(rows[i - 1].d, rows[i].d); if (g > 0) { const w = i; gs += g * w; gw += w; } }
    if (gw === 0) continue;
    let P = Math.round(gs / gw); if (P < 3) P = 3; if (P > 45) P = 45;
    // dia da semana dominante (seg-sab)
    const wc: Record<number, number> = {};
    for (const r of rows) { const wd = weekdayOf(r.d); if (wd >= 1 && wd <= 6) wc[wd] = (wc[wd] || 0) + 1; }
    let W = 1, best = -1; for (const k of Object.keys(wc)) { const wd = Number(k); if (wc[wd] > best) { best = wc[wd]; W = wd; } }
    // ticket medio ponderado por recencia
    let ts = 0, tw = 0; rows.forEach((r, i) => { const w = i + 1; ts += r.v * w; tw += w; });
    const T = tw > 0 ? ts / tw : 0;
    if (T <= 0) continue;
    const seller = docSeller[doc] || "Sem vendedor";
    if (only && seller !== only) continue;
    const L = rows[rows.length - 1].d;
    clients++;
    let cand = addDays(L, P); let guard = 0;
    while (cand <= monthEnd && guard < 25) {
      guard++;
      // "encaixa" no dia da semana dominante (janela +-3 dias)
      let snapped = cand, bestDiff = 99;
      for (let off = -3; off <= 3; off++) { const cd = addDays(cand, off); if (weekdayOf(cd) === W && Math.abs(off) < bestDiff) { bestDiff = Math.abs(off); snapped = cd; } }
      const wd = weekdayOf(snapped);
      if (snapped > today && snapped <= monthEnd && wd >= 1 && wd <= 6) {
        const key = seller + "|" + snapped;
        fmap[key] = (fmap[key] || 0) + T;
      }
      cand = addDays(cand, P);
    }
  }
  const forecast = Object.keys(fmap).map((k) => { const idx = k.indexOf("|"); return { seller: k.slice(0, idx), date: k.slice(idx + 1), value: Math.round(fmap[k] * 100) / 100 }; });
  const total = Math.round(forecast.reduce((a, x) => a + x.value, 0) * 100) / 100;
  return { asOf: today, monthEnd, forecast, total, clients };
}

// Resolve o NOME do vendedor logado (para escopo de carteira) — vazio p/ admin e demais papeis.
async function scopeSellerName(req: any): Promise<string> {
  try {
    const s: any = (req && req.session) || {};
    let uid: any = s.userId || (s.user && s.user.claims && s.user.claims.sub) || ((req && req.isAuthenticated && req.isAuthenticated() && req.user && req.user.claims) ? req.user.claims.sub : null);
    let umail: any = s.userEmail || (s.user && s.user.claims && s.user.claims.email) || ((req && req.user && req.user.claims) ? req.user.claims.email : null) || null;
    let row: any = null;
    const SID = uid ? String(uid).replace(/[^a-zA-Z0-9_-]/g, '') : '';
    if (SID) { const r = await rawq("SELECT COALESCE(role,'') AS role, NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome, is_active FROM users WHERE id='" + SID + "' LIMIT 1"); row = r[0]; }
    if ((!row) && umail) { const M = String(umail).replace(/[']/g, ''); const r = await rawq("SELECT COALESCE(role,'') AS role, NULLIF(TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')),'') AS nome, is_active FROM users WHERE lower(email)=lower('" + M + "') LIMIT 1"); row = r[0]; }
    if (!row || row.is_active === false) return "";
    let role = String(row.role || '');
    const imp = s.impersonateRole;
    if (imp && role === 'admin') role = String(imp);
    if (role !== 'vendedor' && role !== 'telemarketing') return "";
    return String(row.nome || '');
  } catch (e) { return ""; }
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
  app.get("/api/dashboard2/history", async (req, res) => {
    try {
      await ensureDashboardHistoryTable();
      const scopeName = await scopeSellerName(req);
      const snaps = await rawq("SELECT snapshot_date::text AS snapshot_date, day_sales, sellers, captured_at FROM dashboard_snapshots ORDER BY snapshot_date");
      res.json({ snapshots: snaps.map((s) => {
        let sellers = (s.sellers || []) as any[];
        let daySales = Number(s.day_sales) || 0;
        if (scopeName) { sellers = sellers.filter((x: any) => String(x.seller) === scopeName); daySales = sellers.reduce((a: number, x: any) => a + (Number(x.total) || 0), 0); }
        return { date: s.snapshot_date, daySales, sellers, capturedAt: s.captured_at };
      }) });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
  });

  // Previsao de faturamento por cliente da carteira (periodicidade + dia da semana).
  app.get("/api/dashboard2/forecast", async (req, res) => {
    try { const scopeName = await scopeSellerName(req); const r = await computeForecast(scopeName || undefined); res.json(r); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) ? e.message : String(e) }); }
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
