// ============================================================================
// QUALIDADE DA ÁGUA (27/out/2026, Fase 3 Tuya) — analisador "8 in 1 tester"
// (categoria Tuya dgnbj, ex.: "LEITOR DE PH/ORP/CLORO AGUA"). Os dados já são
// gravados pelo coletor (tuya-collector.ts grava TODOS os DPs em
// tuya_temperature_readings, com value_raw); aqui só se expõe, com escala e
// unidade por parâmetro, numa aba própria — separada das temperaturas
// (tuya_devices.kind = 'agua').
//
// DPs vistos no aparelho (27/out): temp_current (÷10 °C), ph_current (÷100),
// orp_current (mV), tds_current (ppm), ec_current (µS/cm), salinity_current (ppm),
// cf_current, pro_current (÷1000 = densidade S.G.), rh_current (?), cada um com
// <param>_warn_max / _warn_min (limites de alarme configurados no aparelho) e
// sensor_list (raw/base64 — quais sondas estão habilitadas).
// Parâmetro novo que o aparelho mandar (qualquer *_current) entra sozinho, com
// rótulo = código e escala 1. Ajustes em system_settings.tuya_agua_params (JSON
// { code: { label, unit, div, decimals } }), somados aos defaults abaixo.
//
//   GET /api/tuya/agua/devices                         analisadores (kind='agua') + último valor de cada parâmetro
//   GET /api/tuya/agua/devices/:id/latest              todos os parâmetros com escala, unidade e limites
//   GET /api/tuya/agua/devices/:id/readings?from&to&bucket=raw|1m|1h|4h|8h|12h|24h  → por parâmetro: min/avg/max
//   GET /api/tuya/agua/devices/:id/readings.csv        mesmos parâmetros (; vírgula decimal, BRT)
// ============================================================================
import type { Express, Request, Response } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { ensureTuyaTables, refreshTuyaDevices } from './tuya-collector';
import { isTuyaConfigured } from './tuya-service';

const rows = (r: any): any[] => (r?.rows || []);

export interface ParamDef { label: string; unit: string; div: number; decimals: number; nota?: string }
export const DEFAULT_AGUA_PARAMS: Record<string, ParamDef> = {
  ph_current:       { label: 'pH',                  unit: '',      div: 100,  decimals: 2 },
  orp_current:      { label: 'ORP (potencial redox)', unit: 'mV',  div: 1,    decimals: 0 },
  tds_current:      { label: 'TDS (sólidos dissolvidos)', unit: 'ppm', div: 1, decimals: 0 },
  ec_current:       { label: 'Condutividade (EC)',  unit: 'µS/cm', div: 1,    decimals: 0 },
  salinity_current: { label: 'Salinidade',          unit: 'ppm',   div: 1,    decimals: 0 },
  cf_current:       { label: 'CF (fator de condutividade)', unit: '', div: 1, decimals: 0 },
  pro_current:      { label: 'Densidade (S.G.)',    unit: '',      div: 1000, decimals: 3 },
  temp_current:     { label: 'Temperatura da água', unit: '°C',    div: 10,   decimals: 1 },
  rh_current:       { label: 'RH',                  unit: '',      div: 1,    decimals: 0, nota: 'parâmetro do aparelho ainda sem significado confirmado (cloro residual?) — conferir com a sonda imersa' },
};
const ORDER = Object.keys(DEFAULT_AGUA_PARAMS);

let cache: { at: number; map: Record<string, ParamDef> } | null = null;
async function getParams(): Promise<Record<string, ParamDef>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.map;
  let extra: Record<string, Partial<ParamDef>> = {};
  try {
    const r = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = 'tuya_agua_params' LIMIT 1`));
    if (r[0]?.value) extra = JSON.parse(String(r[0].value)) || {};
  } catch { /* defaults */ }
  const map: Record<string, ParamDef> = { ...DEFAULT_AGUA_PARAMS };
  for (const [k, v] of Object.entries(extra)) map[k] = { ...(map[k] || { label: k, unit: '', div: 1, decimals: 0 }), ...(v || {}) };
  cache = { at: Date.now(), map };
  return map;
}
const defFor = (map: Record<string, ParamDef>, code: string): ParamDef => map[code] || { label: code.replace(/_current$/, ''), unit: '', div: 1, decimals: 0 };
const scale = (def: ParamDef, raw: any): number | null => (raw == null ? null : Number((Number(raw) / (def.div || 1)).toFixed(def.decimals)));
const sortCodes = (codes: string[]) => codes.sort((a, b) => { const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });

const BUCKETS: Record<string, number> = { raw: 0, '1m': 60, '1h': 3600, '4h': 4 * 3600, '8h': 8 * 3600, '12h': 12 * 3600, '24h': 24 * 3600 };
const RAW_MAX = 60000;
const str = (v: any, max = 120) => { if (v == null) return null; const s = String(v).trim().slice(0, max); return s || null; };

function parsePeriod(q: any): { from: Date; to: Date; bucket: string; secs: number } | { error: string } {
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 24 * 3600 * 1000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return { error: 'from/to invalidos' };
  if (from >= to) return { error: 'from deve ser anterior a to' };
  const bucket = String(q.bucket || 'raw').toLowerCase();
  if (!(bucket in BUCKETS)) return { error: 'bucket invalido' };
  return { from, to, bucket, secs: BUCKETS[bucket] };
}

/** Parâmetros (códigos *_current) que o aparelho já reportou. */
async function paramCodes(deviceId: string): Promise<string[]> {
  const r = rows(await db.execute(sql`SELECT code FROM tuya_device_dps WHERE device_id = ${deviceId} AND code LIKE '%\\_current' ESCAPE '\\'`));
  return sortCodes(r.map((x) => String(x.code)));
}

async function latest(deviceId: string) {
  const map = await getParams();
  const dps = rows(await db.execute(sql`SELECT code, dp_id, value_type, last_value_raw AS value_raw, last_value_text AS value_text, last_read_at FROM tuya_device_dps WHERE device_id = ${deviceId}`));
  const byCode: Record<string, any> = {};
  for (const d of dps) byCode[d.code] = d;
  const codes = sortCodes(Object.keys(byCode).filter((c) => c.endsWith('_current')));
  const params = codes.map((code) => {
    const def = defFor(map, code);
    const base = code.replace(/_current$/, '');
    const mx = byCode[`${base}_warn_max`], mn = byCode[`${base}_warn_min`];
    const value = scale(def, byCode[code].value_raw);
    const warnMax = mx ? scale(def, mx.value_raw) : null, warnMin = mn ? scale(def, mn.value_raw) : null;
    // limites iguais/zerados = alarme não configurado no aparelho
    const limitesAtivos = warnMax != null && warnMin != null && warnMax !== warnMin;
    const fora = limitesAtivos && value != null && (value > (warnMax as number) || value < (warnMin as number));
    return { code, dp_id: byCode[code].dp_id, label: def.label, unit: def.unit, decimals: def.decimals, nota: def.nota || null,
      value, raw: byCode[code].value_raw, read_at: byCode[code].last_read_at, warn_max: warnMax, warn_min: warnMin, limites_ativos: limitesAtivos, fora_dos_limites: fora };
  });
  const outros = dps.filter((d) => !/_current$|_warn_max$|_warn_min$/.test(d.code)).map((d) => ({ code: d.code, dp_id: d.dp_id, type: d.value_type, value_text: d.value_text, read_at: d.last_read_at }));
  return { params, outros };
}

export function registerTuyaAguaRoutes(app: Express, guard: any[]) {
  app.get('/api/tuya/agua/devices', ...guard, async (req: Request, res: Response) => {
    try {
      await ensureTuyaTables();
      let refreshError: string | null = null;
      if (String(req.query.refresh || '') === '1' && isTuyaConfigured()) {
        try { await refreshTuyaDevices(true); } catch (e: any) { refreshError = e?.message || String(e); }
      }
      const devs = rows(await db.execute(sql`
        SELECT device_id, name, product_name, category, online, first_seen_at, last_seen_at, last_poll_at, last_error
        FROM tuya_devices WHERE kind = 'agua' ORDER BY online DESC, name`));
      const out = [];
      for (const d of devs) out.push({ ...d, ...(await latest(String(d.device_id))) });
      res.json({ total: out.length, devices: out, refreshError });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/tuya/agua/devices/:id/latest', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80); if (!id) return res.status(400).json({ error: 'device id invalido' });
      res.json({ device_id: id, ...(await latest(id)) });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  const query = async (id: string, p: { from: Date; to: Date; secs: number }) => {
    const map = await getParams();
    const codes = await paramCodes(id);
    if (!codes.length) return { codes: [], defs: {}, points: [], truncated: false };
    const bucketExpr = p.secs > 0
      ? sql`to_timestamp(floor(extract(epoch from read_at) / ${p.secs}::int) * ${p.secs}::int)`
      : sql`date_trunc('second', read_at)`;
    // uma coluna min/avg/max por parâmetro, já na escala
    const cols = codes.map((c) => {
      const div = defFor(map, c).div || 1;
      return sql`MIN(value_raw) FILTER (WHERE code = ${c}) / ${div}::numeric AS ${sql.raw(`"${c}__min"`)},
                 ROUND(AVG(value_raw) FILTER (WHERE code = ${c}) / ${div}::numeric, 3) AS ${sql.raw(`"${c}__avg"`)},
                 MAX(value_raw) FILTER (WHERE code = ${c}) / ${div}::numeric AS ${sql.raw(`"${c}__max"`)}`;
    });
    const limit = p.secs > 0 ? 100000 : RAW_MAX + 1;
    const r = rows(await db.execute(sql`
      SELECT ${bucketExpr} AS t, COUNT(*)::int AS n, ${sql.join(cols, sql`, `)}
      FROM tuya_temperature_readings
      WHERE device_id = ${id} AND code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)}) AND value_raw IS NOT NULL
        AND read_at >= ${p.from.toISOString()}::timestamptz AND read_at < ${p.to.toISOString()}::timestamptz
      GROUP BY 1 ORDER BY 1 LIMIT ${limit}`));
    const truncated = p.secs === 0 && r.length > RAW_MAX;
    const points = (truncated ? r.slice(0, RAW_MAX) : r).map((x) => {
      const o: any = { t: new Date(x.t).toISOString(), n: Number(x.n) || 0 };
      for (const c of codes) for (const k of ['min', 'avg', 'max']) { const v = x[`${c}__${k}`]; o[`${c}__${k}`] = v == null ? null : Number(v); }
      return o;
    });
    const defs: Record<string, ParamDef> = {};
    for (const c of codes) defs[c] = defFor(map, c);
    return { codes, defs, points, truncated };
  };

  app.get('/api/tuya/agua/devices/:id/readings', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80); if (!id) return res.status(400).json({ error: 'device id invalido' });
      const p = parsePeriod(req.query); if ('error' in p) return res.status(400).json(p);
      const dev = rows(await db.execute(sql`SELECT device_id, name FROM tuya_devices WHERE device_id = ${id}`))[0];
      const q = await query(id, p);
      res.json({ device: dev || { device_id: id, name: id }, from: p.from.toISOString(), to: p.to.toISOString(), bucket: p.bucket, total: q.points.length, ...q });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get('/api/tuya/agua/devices/:id/readings.csv', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80); if (!id) return res.status(400).json({ error: 'device id invalido' });
      const p = parsePeriod(req.query); if ('error' in p) return res.status(400).json(p);
      const dev = rows(await db.execute(sql`SELECT name FROM tuya_devices WHERE device_id = ${id}`))[0];
      const q = await query(id, p);
      const isRaw = p.secs === 0;
      const fmtBRT = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const num = (v: any) => (v == null ? '' : String(v).replace('.', ','));
      const head = ['data_hora', ...(isRaw ? [] : ['leituras'])];
      for (const c of q.codes) { const d = q.defs[c]; const u = d.unit ? ` (${d.unit})` : ''; if (isRaw) head.push(`${d.label}${u}`); else head.push(`${d.label} mín${u}`, `${d.label} méd${u}`, `${d.label} máx${u}`); }
      const lines = [`# analisador;${dev?.name || id};${id}`, `# periodo;${fmtBRT(p.from.toISOString())};${fmtBRT(p.to.toISOString())};intervalo=${p.bucket}`, head.join(';')];
      for (const x of q.points) {
        const row = [fmtBRT(x.t), ...(isRaw ? [] : [String(x.n)])];
        for (const c of q.codes) { if (isRaw) row.push(num(x[`${c}__avg`])); else row.push(num(x[`${c}__min`]), num(x[`${c}__avg`]), num(x[`${c}__max`])); }
        lines.push(row.join(';'));
      }
      const safe = String(dev?.name || id).replace(/[^\w\-]+/g, '_').slice(0, 40);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="qualidade_agua_${safe}_${p.from.toISOString().slice(0, 10)}_${p.to.toISOString().slice(0, 10)}_${p.bucket}.csv"`);
      res.send('﻿' + lines.join('\r\n') + '\r\n');
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}
