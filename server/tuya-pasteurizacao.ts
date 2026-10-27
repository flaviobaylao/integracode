// ============================================================================
// PASTEURIZAÇÃO NAS ORDENS DE PRODUÇÃO (27/out/2026, pedido Flavio) — Fase 2 Tuya
//
// Três sensores acompanham a pasteurização do suco:
//   produto      → controlador "Pasteurizador", sonda principal   → "Temp. do Produto"
//   vapor        → controlador "Pasteurizador", sonda 2/evaporador → "Temp. de vapor"
//   resfriamento → controlador "Banco de gelo", sonda 2/evaporador → "Resfriamento da Pasteurização"
// (a sonda principal do Banco de gelo passa a se chamar "Temperatura do Banco de gelo").
//
// Os controladores são resolvidos PELO NOME em tuya_devices (o "Pasteurizador" ainda
// vai ser pareado no Smart Life — quando aparecer, entra sozinho). Nome/código/cor/rótulo
// podem ser trocados em system_settings:
//   tuya_sensor_labels          JSON { "<nome do aparelho>|<code>": "rótulo" }  (tela + WhatsApp)
//   tuya_pasteurizacao_sensores JSON [{ role, device, code, label, color }]       (gráfico da OP)
//
// Fluxo na OP (/industria › Ordens): botão "Início de Pasteurização" grava
// production_orders.pasteurization_started_at; enquanto corre, o gráfico da OP mostra
// as 3 séries AO VIVO lendo tuya_temperature_readings; "Finalizar Pasteurização" grava
// pasteurization_finished_at e congela o snapshot em pasteurization_data (jsonb) —
// e preenche os 4 campos antigos (pasteurization_start_time/end_time = HH:MM BRT,
// start_temp/end_temp = mín/máx da Temp. do Produto) que o dialog Finalizar já usa.
// Colunas novas: ALTER TABLE ... IF NOT EXISTS no boot (ensurePasteurizacaoColumns).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (r?.rows || []);
const norm = (s: any) => String(s ?? '').trim().toLowerCase();

async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const r = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`));
    if (!r[0]?.value) return fallback;
    const p = JSON.parse(String(r[0].value));
    return (p && typeof p === 'object') ? p as T : fallback;
  } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Rótulos por aparelho|código
// ---------------------------------------------------------------------------
export const DEFAULT_SENSOR_LABELS: Record<string, string> = {
  'banco de gelo|temp_current': 'Temperatura do Banco de gelo',
  'banco de gelo|temperatura_do_evaporador': 'Resfriamento da Pasteurização',
  'pasteurizador|temp_current': 'Temp. do Produto',
  'pasteurizador|temperatura_do_evaporador': 'Temp. de vapor',
};
const GENERIC_LABELS: Record<string, string> = { temp_current: 'Sonda principal', temperatura_do_evaporador: 'Evaporador' };

let labelsCache: { at: number; map: Record<string, string> } | null = null;
/** Mapa normalizado "nome|code" → rótulo (defaults + system_settings.tuya_sensor_labels), cache 60 s. */
export async function getSensorLabels(): Promise<Record<string, string>> {
  if (labelsCache && Date.now() - labelsCache.at < 60_000) return labelsCache.map;
  const extra = await getSettingJson<Record<string, string>>('tuya_sensor_labels', {});
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_SENSOR_LABELS, ...extra })) map[norm(k)] = String(v);
  labelsCache = { at: Date.now(), map };
  return map;
}
/** Rótulo de um sensor: específico do aparelho, senão o genérico do código. `custom` diz se é específico. */
export function labelFor(map: Record<string, string>, deviceName: string, code: string): { label: string; custom: boolean } {
  const k = `${norm(deviceName)}|${norm(code)}`;
  if (map[k]) return { label: map[k], custom: true };
  return { label: GENERIC_LABELS[code] || code, custom: false };
}

// ---------------------------------------------------------------------------
// Sensores da pasteurização
// ---------------------------------------------------------------------------
export interface SensorCfg { role: string; device: string; code: string; label: string; color: string }
export const DEFAULT_PASTEUR_SENSORS: SensorCfg[] = [
  { role: 'produto', device: 'Pasteurizador', code: 'temp_current', label: 'Temp. do Produto', color: '#dc2626' },
  { role: 'vapor', device: 'Pasteurizador', code: 'temperatura_do_evaporador', label: 'Temp. de vapor', color: '#f59e0b' },
  { role: 'resfriamento', device: 'Banco de gelo', code: 'temperatura_do_evaporador', label: 'Resfriamento da Pasteurização', color: '#2563eb' },
];
export interface SensorResolvido extends SensorCfg { device_id: string | null; device_name: string | null; online: boolean }

export async function resolverSensores(): Promise<SensorResolvido[]> {
  const cfg = await getSettingJson<SensorCfg[]>('tuya_pasteurizacao_sensores', DEFAULT_PASTEUR_SENSORS);
  const devs = rows(await db.execute(sql`SELECT device_id, name, online FROM tuya_devices`));
  return (Array.isArray(cfg) ? cfg : DEFAULT_PASTEUR_SENSORS).map((s) => {
    const d = devs.find((x) => norm(x.name) === norm(s.device)) || devs.find((x) => norm(x.name).startsWith(norm(s.device)));
    return { ...s, device_id: d ? String(d.device_id) : null, device_name: d ? String(d.name) : null, online: d ? d.online === true : false };
  });
}

// ---------------------------------------------------------------------------
// Colunas na OP
// ---------------------------------------------------------------------------
let colsReady = false;
export async function ensurePasteurizacaoColumns(): Promise<void> {
  if (colsReady) return;
  await db.execute(sql`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS pasteurization_started_at timestamptz`);
  await db.execute(sql`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS pasteurization_finished_at timestamptz`);
  await db.execute(sql`ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS pasteurization_data jsonb`);
  colsReady = true;
}

// ---------------------------------------------------------------------------
// Séries
// ---------------------------------------------------------------------------
export interface SerieSensor extends SensorResolvido {
  points: [string, number][];   // [ISO, °C] bruto (1 ponto por report do aparelho)
  n: number; min: number | null; max: number | null; avg: number | null; first: number | null; last: number | null;
}
const MAX_POINTS = 20000;

export async function lerSeries(from: Date, to: Date): Promise<SerieSensor[]> {
  const sensores = await resolverSensores();
  const out: SerieSensor[] = [];
  for (const s of sensores) {
    let pts: [string, number][] = [];
    if (s.device_id) {
      const r = rows(await db.execute(sql`
        SELECT read_at, celsius FROM tuya_temperature_readings
        WHERE device_id = ${s.device_id} AND code = ${s.code} AND celsius IS NOT NULL
          AND read_at >= ${from.toISOString()}::timestamptz AND read_at <= ${to.toISOString()}::timestamptz
        ORDER BY read_at LIMIT ${MAX_POINTS}`));
      pts = r.map((x) => [new Date(x.read_at).toISOString(), Number(x.celsius)] as [string, number]);
    }
    const vals = pts.map((p) => p[1]);
    out.push({
      ...s, points: pts, n: pts.length,
      min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null,
      avg: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null,
      first: vals.length ? vals[0] : null, last: vals.length ? vals[vals.length - 1] : null,
    });
  }
  return out;
}

const hhmmBRT = (d: Date) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

export async function loadOrder(orderId: string): Promise<any | null> {
  await ensurePasteurizacaoColumns();
  return rows(await db.execute(sql`SELECT * FROM production_orders WHERE id = ${orderId} LIMIT 1`))[0] || null;
}

/** Estado atual da pasteurização de uma OP: snapshot gravado, ou séries ao vivo se em andamento. */
export async function estadoPasteurizacao(orderId: string): Promise<any> {
  const o = await loadOrder(orderId);
  if (!o) return null;
  const started = o.pasteurization_started_at ? new Date(o.pasteurization_started_at) : null;
  const finished = o.pasteurization_finished_at ? new Date(o.pasteurization_finished_at) : null;
  const sensores = await resolverSensores();
  const base = {
    order_id: o.id, order_number: o.order_number, product_name: o.product_name, status: o.status,
    started_at: started ? started.toISOString() : null, finished_at: finished ? finished.toISOString() : null,
    em_andamento: !!started && !finished,
    sensores: sensores.map((s) => ({ role: s.role, label: s.label, color: s.color, device: s.device, code: s.code, device_id: s.device_id, device_name: s.device_name, online: s.online, encontrado: !!s.device_id })),
  };
  if (!started) return { ...base, series: [], duracao_min: null };
  if (finished && o.pasteurization_data) return { ...base, ...(o.pasteurization_data as any), snapshot: true };
  const to = finished || new Date();
  const series = await lerSeries(started, to);
  return { ...base, series, duracao_min: Math.round((to.getTime() - started.getTime()) / 60000), snapshot: false };
}

export async function iniciarPasteurizacao(orderId: string, by: string, reiniciar = false): Promise<any> {
  const o = await loadOrder(orderId);
  if (!o) throw Object.assign(new Error('ordem nao encontrada'), { status: 404 });
  if (o.status === 'finalizada' || o.status === 'cancelada') throw Object.assign(new Error(`ordem ${o.status} — nao pode iniciar pasteurizacao`), { status: 400 });
  if (o.pasteurization_started_at && !o.pasteurization_finished_at && !reiniciar) throw Object.assign(new Error('pasteurizacao ja em andamento'), { status: 400 });
  if (o.pasteurization_finished_at && !reiniciar) throw Object.assign(new Error('pasteurizacao ja finalizada nesta ordem — use reiniciar para refazer'), { status: 400 });
  const sensores = await resolverSensores();
  // Ordem planejada vai para "em producao" (mesmo efeito do botao Iniciar producao)
  await db.execute(sql`
    UPDATE production_orders SET
      status = CASE WHEN status = 'planejada' THEN 'em_producao' ELSE status END,
      start_date = COALESCE(start_date, now()),
      pasteurization_started_at = now(), pasteurization_finished_at = NULL, pasteurization_data = NULL,
      updated_at = now()
    WHERE id = ${orderId}`);
  console.log(`🌡️🏭 [PASTEURIZACAO] inicio ${o.order_number} por ${by}${reiniciar ? ' (reiniciada)' : ''} — sensores: ${sensores.map((s) => `${s.role}=${s.device_id ? (s.online ? 'ok' : 'offline') : 'NAO ENCONTRADO'}`).join(', ')}`);
  return estadoPasteurizacao(orderId);
}

export async function finalizarPasteurizacao(orderId: string, by: string): Promise<any> {
  const o = await loadOrder(orderId);
  if (!o) throw Object.assign(new Error('ordem nao encontrada'), { status: 404 });
  if (!o.pasteurization_started_at) throw Object.assign(new Error('pasteurizacao nao foi iniciada nesta ordem'), { status: 400 });
  if (o.pasteurization_finished_at) throw Object.assign(new Error('pasteurizacao ja finalizada'), { status: 400 });
  const started = new Date(o.pasteurization_started_at);
  const finished = new Date();
  const series = await lerSeries(started, finished);
  const produto = series.find((s) => s.role === 'produto');
  const data = {
    started_at: started.toISOString(), finished_at: finished.toISOString(),
    duracao_min: Math.round((finished.getTime() - started.getTime()) / 60000),
    finalizado_por: by,
    series: series.map((s) => ({ ...s })),
  };
  await db.execute(sql`
    UPDATE production_orders SET
      pasteurization_finished_at = ${finished.toISOString()}::timestamptz,
      pasteurization_data = ${JSON.stringify(data)}::jsonb,
      pasteurization_start_time = ${hhmmBRT(started)},
      pasteurization_end_time = ${hhmmBRT(finished)},
      pasteurization_start_temp = COALESCE(${produto?.min ?? null}::numeric, pasteurization_start_temp),
      pasteurization_end_temp = COALESCE(${produto?.max ?? null}::numeric, pasteurization_end_temp),
      updated_at = now()
    WHERE id = ${orderId}`);
  console.log(`🌡️🏭 [PASTEURIZACAO] fim ${o.order_number} por ${by}: ${data.duracao_min} min, produto ${produto?.min ?? '-'}..${produto?.max ?? '-'} °C (${produto?.n ?? 0} pts)`);
  return estadoPasteurizacao(orderId);
}
