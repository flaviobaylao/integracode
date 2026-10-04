// =============================================================================
//  INTEGRA 2.0 — Gestão de Feriados (Administração)
//  server/holidays-routes.ts — registrar em server/index.ts:
//      import { registerHolidaysRoutes } from "./holidays-routes";
//      registerHolidaysRoutes(app);
//
//  Feriados nacionais (auto-seed), estaduais (por UF / macro-região) e municipais
//  (por cidade / micro-região). Quando uma visita da agenda cai num feriado que
//  "desloca rota", ela é movida: SEMANAL → próximo dia útil (postergação);
//  QUINZENAL/MENSAL → dia útil anterior (antecipação). O card da Rota do Dia
//  recebe a marcação "Antecipação/Postergação de visita devido ao feriado dd/mm/aaaa".
//
//  AUTOSSUFICIENTE: ensureTables() cria a tabela e as colunas no boot (produção
//  não roda db:push). Todo handler é async + try/catch.
// =============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);
const safe = (fn: (req: Request, res: Response) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try { await fn(req, res); }
    catch (e: any) {
      console.error("[feriados] erro na rota:", req.method, req.path, e?.message, e?.stack);
      if (!res.headersSent) res.status(500).json({ error: e?.message || "erro interno" });
    }
  };

const SCOPES = new Set(["nacional", "estadual", "municipal"]);

// ── Normalização de região (cidade/UF): maiúsculas, sem acento, sem sufixo " (…)". ──
function norm(v: any): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
}
function isoDay(d: Date): string { return d.toISOString().slice(0, 10); }
function brDate(iso: string): string { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso); }

// ── Feriados nacionais (fixos + móveis) com nome, para o seed. ──
function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function nacionaisDoAno(year: number): Array<{ date: string; name: string }> {
  const fixos: Array<[string, string]> = [
    ["01-01", "Confraternização Universal"], ["04-21", "Tiradentes"], ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência do Brasil"], ["10-12", "Nossa Senhora Aparecida"], ["11-02", "Finados"],
    ["11-15", "Proclamação da República"], ["11-20", "Consciência Negra"], ["12-25", "Natal"],
  ];
  const out = fixos.map(([md, name]) => ({ date: `${year}-${md}`, name }));
  const easter = easterSunday(year);
  out.push({ date: isoDay(addDays(easter, -2)), name: "Sexta-feira Santa" });
  out.push({ date: isoDay(addDays(easter, 60)), name: "Corpus Christi" });
  return out;
}

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS route_holidays (
     id            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     hdate         date NOT NULL,
     name          varchar NOT NULL,
     scope         varchar NOT NULL DEFAULT 'nacional',
     uf            varchar,
     city          varchar,
     desloca_rota  boolean NOT NULL DEFAULT true,
     is_active     boolean NOT NULL DEFAULT true,
     source        varchar NOT NULL DEFAULT 'manual',
     created_by    varchar,
     created_at    timestamptz DEFAULT now(),
     updated_at    timestamptz DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_rh_date ON route_holidays (hdate);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_rh_dedup ON route_holidays (hdate, scope, COALESCE(uf,''), COALESCE(city,''));`,
  `ALTER TABLE visit_agenda ADD COLUMN IF NOT EXISTS holiday_note text;`,
  `ALTER TABLE visit_agenda ADD COLUMN IF NOT EXISTS holiday_original_date timestamptz;`,
  `CREATE TABLE IF NOT EXISTS holiday_rules (
     id varchar PRIMARY KEY DEFAULT 'default',
     rules jsonb NOT NULL DEFAULT '{}'::jsonb,
     updated_at timestamptz DEFAULT now()
   );`,
  // Exceção de regra por cliente: 'post' | 'ant' | 'none' | NULL (= usa a regra da periodicidade).
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS holiday_rule varchar;`,
  // Regra fixa por REGIÃO: amarra uma direção à macro (UF) ou micro-região (cidade).
  `CREATE TABLE IF NOT EXISTS holiday_region_rules (
     id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     uf varchar NOT NULL,
     city varchar,
     rule varchar NOT NULL,
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz DEFAULT now()
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_hrr_region ON holiday_region_rules (uf, COALESCE(city,''));`,
];

// Macro-região (UF) de um cliente: GO/DF do cadastro; sem UF, Brasília e RAs → DF.
const DF_CIDADES = new Set(["BRASILIA", "TAGUATINGA", "CEILANDIA", "GAMA", "SOBRADINHO", "PLANALTINA", "GUARA", "AGUAS CLARAS", "SAMAMBAIA", "SANTA MARIA", "RECANTO DAS EMAS", "AGUAS LINDAS DE GOIAS"]);
function macroUf(city: any, state: any): string {
  const u = norm(state);
  if (u === "GO" || u === "DF") return u;
  return DF_CIDADES.has(norm(city)) ? "DF" : "GO";
}
// Regras fixas por região → Map com chaves "UF|CIDADE" (micro) e "UF|" (macro).
async function loadRegionRules(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const rows = rowsOf(await db.execute(sql`SELECT uf, city, rule FROM holiday_region_rules`));
    for (const r of rows) m.set(norm(r.uf) + "|" + norm(r.city), String(r.rule));
  } catch { /* noop */ }
  return m;
}
// Override efetivo: cliente > micro-região (cidade) > macro-região (UF) > nulo (periodicidade).
function resolveOverride(clientRule: any, regionRules: Map<string, string>, city: any, state: any): string | null {
  const cr = String(clientRule || "");
  if (cr === "post" || cr === "ant" || cr === "none") return cr;
  const uf = macroUf(city, state);
  const micro = regionRules.get(uf + "|" + norm(city));
  if (micro) return micro;
  const macro = regionRules.get(uf + "|");
  if (macro) return macro;
  return null;
}

// Regra de deslocamento por periodicidade: 'post' (próximo dia útil), 'ant' (dia
// útil anterior) ou 'none' (não desloca). + opções gerais (editáveis pelo admin).
const DEFAULT_RULES: Record<string, any> = {
  semanal: "post", trisemanal: "post", quinzenal: "ant", mensal: "ant",
  cascata: true, incluirVirtuais: false,
};
async function loadRules(): Promise<Record<string, any>> {
  try {
    const r = rowsOf(await db.execute(sql`SELECT rules FROM holiday_rules WHERE id = 'default' LIMIT 1`));
    const saved = (r[0] && r[0].rules) || {};
    return { ...DEFAULT_RULES, ...saved };
  } catch { return { ...DEFAULT_RULES }; }
}
function perKey(rec: string): "semanal" | "trisemanal" | "quinzenal" | "mensal" {
  const r = norm(rec);
  if (r.startsWith("QUINZ") || r.startsWith("BIWEEK")) return "quinzenal";
  if (r.startsWith("MENS") || r.startsWith("MONTH")) return "mensal";
  if (r.startsWith("TRI")) return "trisemanal";
  return "semanal";
}

let _ready: Promise<void> | null = null;
export function ensureHolidayTables(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    for (const stmt of DDL) {
      try { await db.execute(sql.raw(stmt)); }
      catch (e: any) { console.error("[feriados] ensureTables stmt falhou:", e?.message); }
    }
    // Seed nacionais do ano corrente + próximo (idempotente).
    try {
      const y = new Date().getFullYear();
      for (const yy of [y, y + 1]) {
        for (const f of nacionaisDoAno(yy)) {
          await db.execute(sql`
            INSERT INTO route_holidays (hdate, name, scope, source)
            VALUES (${f.date}::date, ${f.name}, 'nacional', 'auto')
            ON CONFLICT (hdate, scope, COALESCE(uf,''), COALESCE(city,'')) DO NOTHING`);
        }
      }
    } catch (e: any) { console.warn("[feriados] seed nacionais:", e?.message); }
    console.log("[feriados] ensureTables: tabela/colunas verificadas.");
  })();
  return _ready;
}

const mapRow = (r: any) => ({
  id: r.id, date: isoDay(new Date(r.hdate)), name: r.name, scope: r.scope,
  uf: r.uf || null, city: r.city || null, deslocaRota: r.desloca_rota !== false,
  active: r.is_active !== false, source: r.source || "manual",
});

// ── Carrega feriados ativos (que deslocam) e aplicáveis a um cliente. ──
async function holidaysApplicableTo(customer: { city?: any; state?: any }): Promise<Map<string, { name: string; date: string }>> {
  const cCity = norm(customer.city), cUf = norm(customer.state);
  const rows = rowsOf(await db.execute(sql`SELECT hdate, name, scope, uf, city FROM route_holidays WHERE is_active = true AND desloca_rota = true`));
  const m = new Map<string, { name: string; date: string }>();
  for (const r of rows) {
    const d = isoDay(new Date(r.hdate));
    let applies = false;
    if (r.scope === "nacional") applies = true;
    else if (r.scope === "estadual") applies = !!cUf && norm(r.uf) === cUf;
    else if (r.scope === "municipal") applies = !!cCity && norm(r.city) === cCity && (!r.uf || norm(r.uf) === cUf);
    if (applies) m.set(d, { name: r.name, date: d });
  }
  return m;
}

// Dia útil = não é fim de semana e (quando cascata ligada) não é feriado.
function ehDiaUtil(iso: string, feriados: Map<string, any>, cascata: boolean): boolean {
  const d = new Date(iso + "T12:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (cascata && feriados.has(iso)) return false;
  return true;
}
// Direção vinda das REGRAS configuráveis: +1 posterga, -1 antecipa, 0 não desloca.
function direcaoFor(recurrence: string, rules: Record<string, any>): 1 | -1 | 0 {
  const v = String(rules[perKey(recurrence)] || "post");
  return v === "ant" ? -1 : v === "none" ? 0 : 1;
}
function shiftOffHoliday(iso: string, recurrence: string, feriados: Map<string, any>, rules: Record<string, any>, override?: string | null): { date: string; tipo: "post" | "ant" } | null {
  // Exceção por cliente (override) vence a regra da periodicidade.
  const ov = String(override || "");
  const dir: 1 | -1 | 0 = ov === "post" ? 1 : ov === "ant" ? -1 : ov === "none" ? 0 : direcaoFor(recurrence, rules);
  if (dir === 0) return null; // configurado para NÃO deslocar
  const cascata = rules.cascata !== false;
  let cur = iso;
  for (let i = 0; i < 31; i++) {
    const d = new Date(cur + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + dir);
    cur = isoDay(d);
    if (ehDiaUtil(cur, feriados, cascata)) break;
  }
  return { date: cur, tipo: dir === 1 ? "post" : "ant" };
}
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

// ── Núcleo: reposiciona linhas da visit_agenda que caem em feriado. ──
// `where` extra limita o conjunto (um cliente, um mês). Idempotente: ignora
// linhas já deslocadas (holiday_original_date preenchido) e virtuais.
async function processShift(opts: { customerId?: string; monthStart?: string; monthEnd?: string; onlyFuture?: boolean }): Promise<{ moved: number; list: any[] }> {
  await ensureHolidayTables();
  const rules = await loadRules();
  const regionRules = await loadRegionRules();
  const conds: any[] = [sql`va.visit_status = 'pending'`, sql`va.holiday_original_date IS NULL`,
    sql`c.is_active = true`];
  if (!rules.incluirVirtuais) conds.push(sql`va.is_virtual = false`);
  if (opts.customerId) conds.push(sql`va.customer_id = ${opts.customerId}`);
  if (opts.monthStart) conds.push(sql`va.scheduled_date::date >= ${opts.monthStart}::date`);
  if (opts.monthEnd) conds.push(sql`va.scheduled_date::date <= ${opts.monthEnd}::date`);
  if (opts.onlyFuture) conds.push(sql`va.scheduled_date::date >= CURRENT_DATE`);
  const whereSql = sql.join(conds, sql` AND `);
  const rows = rowsOf(await db.execute(sql`
    SELECT va.id, va.customer_id, va.scheduled_date, va.recurrence_type, va.customer_name,
           c.city AS c_city, c.state AS c_state, c.holiday_rule AS c_rule
      FROM visit_agenda va
      LEFT JOIN customers c ON c.id = va.customer_id
     WHERE ${whereSql}
     ORDER BY va.scheduled_date ASC
     LIMIT 5000`));
  // Agrupa feriados por cliente (cache por cidade/UF).
  const cache = new Map<string, Map<string, any>>();
  let moved = 0; const list: any[] = [];
  for (const r of rows) {
    const key = norm(r.c_city) + "|" + norm(r.c_state);
    let fer = cache.get(key);
    if (!fer) { fer = await holidaysApplicableTo({ city: r.c_city, state: r.c_state }); cache.set(key, fer); }
    const diaOrig = isoDay(new Date(r.scheduled_date));
    const hit = fer.get(diaOrig);
    if (!hit) continue;
    const override = resolveOverride(r.c_rule, regionRules, r.c_city, r.c_state);
    const sh = shiftOffHoliday(diaOrig, r.recurrence_type || "semanal", fer, rules, override);
    if (!sh) continue; // configurado para não deslocar
    const { date: alvo, tipo } = sh;
    const nota = `${tipo === "post" ? "Postergação" : "Antecipação"} de visita devido ao feriado ${brDate(diaOrig)}`;
    const alvoDt = new Date(alvo + "T12:00:00Z");
    await db.execute(sql`
      UPDATE visit_agenda
         SET scheduled_date = ${alvoDt}, route_day = ${DIAS[alvoDt.getUTCDay()]},
             holiday_note = ${nota}, holiday_original_date = ${new Date(diaOrig + "T12:00:00Z")}, updated_at = now()
       WHERE id = ${r.id}`);
    moved++;
    list.push({ customerId: r.customer_id, customerName: r.customer_name, periodicidade: r.recurrence_type,
      de: brDate(diaOrig), para: brDate(alvo), paraDow: DIAS[alvoDt.getUTCDay()], tipo, feriado: hit.name, nota });
  }
  return { moved, list };
}

// Prévia (sem gravar): mesma lógica, só calcula.
async function previewShift(monthStart: string, monthEnd: string): Promise<any[]> {
  await ensureHolidayTables();
  const rules = await loadRules();
  const regionRules = await loadRegionRules();
  const conds: any[] = [sql`va.visit_status = 'pending'`, sql`va.holiday_original_date IS NULL`,
    sql`c.is_active = true`,
    sql`va.scheduled_date::date >= ${monthStart}::date`, sql`va.scheduled_date::date <= ${monthEnd}::date`];
  if (!rules.incluirVirtuais) conds.push(sql`va.is_virtual = false`);
  const rows = rowsOf(await db.execute(sql`
    SELECT va.id, va.customer_id, va.scheduled_date, va.recurrence_type, va.customer_name,
           c.city AS c_city, c.state AS c_state, c.holiday_rule AS c_rule
      FROM visit_agenda va
      LEFT JOIN customers c ON c.id = va.customer_id
     WHERE ${sql.join(conds, sql` AND `)}
     ORDER BY va.scheduled_date ASC LIMIT 5000`));
  const cache = new Map<string, Map<string, any>>();
  const list: any[] = [];
  for (const r of rows) {
    const key = norm(r.c_city) + "|" + norm(r.c_state);
    let fer = cache.get(key);
    if (!fer) { fer = await holidaysApplicableTo({ city: r.c_city, state: r.c_state }); cache.set(key, fer); }
    const diaOrig = isoDay(new Date(r.scheduled_date));
    const hit = fer.get(diaOrig);
    if (!hit) continue;
    const override = resolveOverride(r.c_rule, regionRules, r.c_city, r.c_state);
    const sh = shiftOffHoliday(diaOrig, r.recurrence_type || "semanal", fer, rules, override);
    if (!sh) continue;
    const { date: alvo, tipo } = sh;
    const alvoDt = new Date(alvo + "T12:00:00Z");
    list.push({ customerId: r.customer_id, customerName: r.customer_name, periodicidade: r.recurrence_type,
      de: brDate(diaOrig), para: brDate(alvo), paraDow: DIAS[alvoDt.getUTCDay()], tipo, feriado: hit.name,
      feriadoData: brDate(diaOrig) });
  }
  return list;
}

/** Hook do motor da agenda: reaplica os deslocamentos de feriado de UM cliente
 *  após a regeneração. Nunca lança. */
export async function applyHolidayShiftsForCustomer(customerId: string): Promise<void> {
  try {
    if (!customerId) return;
    await processShift({ customerId, onlyFuture: true });
  } catch (e: any) { console.warn("[feriados] applyHolidayShiftsForCustomer:", e?.message); }
}

/** Reverte os deslocamentos FUTUROS de um cliente e reaplica com a regra atual.
 *  Usado quando a exceção de regra do cliente muda. Nunca lança. */
export async function reapplyHolidayShiftsForCustomer(customerId: string): Promise<void> {
  try {
    if (!customerId) return;
    await ensureHolidayTables();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, holiday_original_date FROM visit_agenda
       WHERE customer_id = ${customerId} AND holiday_original_date IS NOT NULL
         AND holiday_original_date::date >= CURRENT_DATE`));
    for (const r of rows) {
      const orig = new Date(r.holiday_original_date);
      await db.execute(sql`
        UPDATE visit_agenda SET scheduled_date = ${orig}, route_day = ${DIAS[orig.getUTCDay()]},
               holiday_note = NULL, holiday_original_date = NULL, updated_at = now()
         WHERE id = ${r.id}`);
    }
    await processShift({ customerId, onlyFuture: true });
  } catch (e: any) { console.warn("[feriados] reapplyHolidayShiftsForCustomer:", e?.message); }
}

export function registerHolidaysRoutes(app: Express) {
  void ensureHolidayTables();
  const admin = requireRole(["admin", "coordinator", "administrative"]);

  // Lista por ano.
  app.get("/api/holidays", authenticateUser, safe(async (req, res) => {
    await ensureHolidayTables();
    const ano = Number(req.query.year) || new Date().getFullYear();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM route_holidays WHERE EXTRACT(YEAR FROM hdate) = ${ano}
      ORDER BY hdate ASC, scope ASC`));
    res.json({ holidays: rows.map(mapRow) });
  }));

  // Macro/micro-regiões derivadas do cadastro. As macro-regiões são apenas GO e DF;
  // cada cidade é uma micro-região, classificada pela UF ('GO'/'DF') ou, quando o
  // cadastro não tem UF, pelo nome oficial da cidade (Brasília → DF).
  app.get("/api/holidays/regions", authenticateUser, safe(async (_req, res) => {
    const { cidadeCanonica } = await import("../shared/cidadePadrao");
    const rows = rowsOf(await db.execute(sql`
      SELECT state AS uf, city, COUNT(*)::int AS n
        FROM customers WHERE is_active = true AND COALESCE(city,'') <> ''
        GROUP BY state, city ORDER BY state, city`));
    const macro = new Map<string, { uf: string; total: number; cidades: Array<{ city: string; n: number }> }>();
    macro.set("GO", { uf: "GO", total: 0, cidades: [] });
    macro.set("DF", { uf: "DF", total: 0, cidades: [] });
    // Agrupa pela cidade PADRONIZADA (nome oficial GO/DF), deduplicando grafias.
    const byCity = new Map<string, { uf: string; city: string; n: number }>();
    for (const r of rows) {
      const canon = cidadeCanonica(r.city) || String(r.city || "").trim();
      if (!canon) continue;
      const uf = macroUf(canon, r.uf); // GO/DF; sem UF, Brasília e RAs → DF, resto → GO
      const key = uf + "|" + norm(canon);
      const ex = byCity.get(key);
      if (ex) ex.n += Number(r.n);
      else byCity.set(key, { uf, city: canon, n: Number(r.n) });
    }
    for (const v of byCity.values()) { const g = macro.get(v.uf)!; g.cidades.push({ city: v.city, n: v.n }); g.total += v.n; }
    for (const g of macro.values()) g.cidades.sort((a, b) => a.city.localeCompare(b.city, "pt-BR"));
    res.json({ macro: Array.from(macro.values()) });
  }));

  // Regras de deslocamento (editáveis): direção por periodicidade + cascata + virtuais.
  app.get("/api/holidays/rules", authenticateUser, safe(async (_req, res) => {
    res.json({ rules: await loadRules() });
  }));
  app.put("/api/holidays/rules", authenticateUser, admin, safe(async (req, res) => {
    await ensureHolidayTables();
    const b: any = req.body || {};
    const DIR = new Set(["post", "ant", "none"]);
    const merged: Record<string, any> = { ...DEFAULT_RULES };
    for (const k of ["semanal", "trisemanal", "quinzenal", "mensal"]) if (DIR.has(b[k])) merged[k] = b[k];
    if (typeof b.cascata === "boolean") merged.cascata = b.cascata;
    if (typeof b.incluirVirtuais === "boolean") merged.incluirVirtuais = b.incluirVirtuais;
    await db.execute(sql`
      INSERT INTO holiday_rules (id, rules, updated_at) VALUES ('default', ${JSON.stringify(merged)}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET rules = EXCLUDED.rules, updated_at = now()`);
    res.json({ rules: merged });
  }));

  // ── Regras fixas por REGIÃO (macro UF ou micro cidade) ──
  app.get("/api/holidays/region-rules", authenticateUser, safe(async (_req, res) => {
    await ensureHolidayTables();
    const rows = rowsOf(await db.execute(sql`SELECT id, uf, city, rule FROM holiday_region_rules ORDER BY uf, COALESCE(city,'')`));
    res.json({ regionRules: rows.map((r: any) => ({ id: r.id, uf: r.uf, city: r.city || null, rule: r.rule })) });
  }));
  app.post("/api/holidays/region-rules", authenticateUser, admin, safe(async (req: any, res) => {
    await ensureHolidayTables();
    const b: any = req.body || {};
    const uf = String(b.uf || "").trim().toUpperCase();
    let city = b.city ? String(b.city).trim() : null;
    if (city) { try { const { cidadeCanonica } = await import("../shared/cidadePadrao"); city = cidadeCanonica(city) || city; } catch { /* noop */ } }
    const rule = String(b.rule || "");
    if (uf !== "GO" && uf !== "DF") return res.status(400).json({ error: "UF deve ser GO ou DF." });
    if (!["post", "ant", "none"].includes(rule)) return res.status(400).json({ error: "Regra inválida." });
    const r = rowsOf(await db.execute(sql`
      INSERT INTO holiday_region_rules (uf, city, rule) VALUES (${uf}, ${city}, ${rule})
      ON CONFLICT (uf, COALESCE(city,'')) DO UPDATE SET rule = EXCLUDED.rule, updated_at = now()
      RETURNING id, uf, city, rule`));
    const row = r[0];
    res.json({ regionRule: { id: row.id, uf: row.uf, city: row.city || null, rule: row.rule } });
  }));
  app.delete("/api/holidays/region-rules/:id", authenticateUser, admin, safe(async (req, res) => {
    await ensureHolidayTables();
    await db.execute(sql`DELETE FROM holiday_region_rules WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  }));

  // Define a regra do cliente (post/ant/none/padrao) SEM reaplicar deslocamentos.
  // Usado na prévia para alternar postergação/antecipação (pontual ou em massa) de forma não destrutiva.
  app.post("/api/holidays/customer-rule", authenticateUser, admin, safe(async (req: any, res) => {
    await ensureHolidayTables();
    const b: any = req.body || {};
    const ids: string[] = Array.isArray(b.ids) ? b.ids.map((x: any) => String(x)).filter(Boolean) : [];
    const raw = String(b.rule || "");
    if (!ids.length) return res.status(400).json({ error: "Informe ao menos um cliente." });
    if (!["post", "ant", "none", "padrao"].includes(raw)) return res.status(400).json({ error: "Regra inválida." });
    const rule = raw === "padrao" ? null : raw;
    await db.execute(sql`UPDATE customers SET holiday_rule = ${rule} WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    res.json({ ok: true, updated: ids.length });
  }));

  app.post("/api/holidays", authenticateUser, admin, safe(async (req: any, res) => {
    await ensureHolidayTables();
    const b = req.body || {};
    const date = String(b.date || "").slice(0, 10);
    const name = String(b.name || "").trim();
    const scope = SCOPES.has(b.scope) ? b.scope : "municipal";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) return res.status(400).json({ error: "Informe data e nome do feriado." });
    const uf = scope === "nacional" ? null : (String(b.uf || "").trim().toUpperCase() || null);
    const city = scope === "municipal" ? (String(b.city || "").trim() || null) : null;
    if (scope === "estadual" && !uf) return res.status(400).json({ error: "Feriado estadual precisa da UF." });
    if (scope === "municipal" && !city) return res.status(400).json({ error: "Feriado municipal precisa da cidade." });
    const r = rowsOf(await db.execute(sql`
      INSERT INTO route_holidays (hdate, name, scope, uf, city, desloca_rota, is_active, source, created_by)
      VALUES (${date}::date, ${name}, ${scope}, ${uf}, ${city}, ${b.deslocaRota !== false}, ${b.active !== false}, 'manual', ${req.currentUser?.id || null})
      ON CONFLICT (hdate, scope, COALESCE(uf,''), COALESCE(city,'')) DO UPDATE SET name = EXCLUDED.name, desloca_rota = EXCLUDED.desloca_rota, is_active = EXCLUDED.is_active, updated_at = now()
      RETURNING *`));
    res.json({ holiday: mapRow(r[0]) });
  }));

  app.patch("/api/holidays/:id", authenticateUser, admin, safe(async (req, res) => {
    await ensureHolidayTables();
    const b: any = req.body || {};
    const sets: any[] = [];
    if (typeof b.active === "boolean") sets.push(sql`is_active = ${b.active}`);
    if (typeof b.deslocaRota === "boolean") sets.push(sql`desloca_rota = ${b.deslocaRota}`);
    if (typeof b.name === "string" && b.name.trim()) sets.push(sql`name = ${b.name.trim()}`);
    if (!sets.length) return res.json({ ok: true });
    sets.push(sql`updated_at = now()`);
    await db.execute(sql`UPDATE route_holidays SET ${sql.join(sets, sql`, `)} WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  }));

  app.delete("/api/holidays/:id", authenticateUser, admin, safe(async (req, res) => {
    await ensureHolidayTables();
    await db.execute(sql`DELETE FROM route_holidays WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  }));

  // Prévia do mês (?month=YYYY-MM): o que será deslocado, sem gravar.
  app.get("/api/holidays/preview", authenticateUser, admin, safe(async (req, res) => {
    const month = String(req.query.month || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Informe o mês (YYYY-MM)." });
    const start = month + "-01";
    const end = isoDay(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    res.json({ items: await previewShift(start, end) });
  }));

  // Aplica o deslocamento no mês.
  app.post("/api/holidays/apply", authenticateUser, admin, safe(async (req, res) => {
    const month = String((req.body && req.body.month) || req.query.month || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Informe o mês (YYYY-MM)." });
    const start = month + "-01";
    const end = isoDay(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    const r = await processShift({ monthStart: start, monthEnd: end });
    res.json({ moved: r.moved, items: r.list });
  }));

  // Reverte os deslocamentos do mês (volta a data original, limpa o selo).
  app.post("/api/holidays/revert", authenticateUser, admin, safe(async (req, res) => {
    await ensureHolidayTables();
    const month = String((req.body && req.body.month) || req.query.month || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Informe o mês (YYYY-MM)." });
    const start = month + "-01";
    const end = isoDay(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    const rows = rowsOf(await db.execute(sql`
      SELECT id, holiday_original_date FROM visit_agenda
       WHERE holiday_original_date IS NOT NULL
         AND holiday_original_date::date >= ${start}::date AND holiday_original_date::date <= ${end}::date`));
    const DIAS2 = DIAS;
    for (const r of rows) {
      const orig = new Date(r.holiday_original_date);
      await db.execute(sql`
        UPDATE visit_agenda SET scheduled_date = ${orig}, route_day = ${DIAS2[orig.getUTCDay()]},
               holiday_note = NULL, holiday_original_date = NULL, updated_at = now()
         WHERE id = ${r.id}`);
    }
    res.json({ reverted: rows.length });
  }));

  // Selos para a Rota do Dia de uma data (?date=YYYY-MM-DD): { customerId: nota }.
  app.get("/api/holidays/notes", authenticateUser, safe(async (req, res) => {
    await ensureHolidayTables();
    const date = String(req.query.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ notes: {} });
    const rows = rowsOf(await db.execute(sql`
      SELECT customer_id, holiday_note FROM visit_agenda
       WHERE scheduled_date::date = ${date}::date AND holiday_note IS NOT NULL`));
    const notes: Record<string, string> = {};
    for (const r of rows) if (r.customer_id) notes[String(r.customer_id)] = r.holiday_note;
    res.json({ notes });
  }));
}
