// ============================================================================
// COLETOR DE TEMPERATURAS TUYA (27/out/2026)
// Roda a cada 60 s pelo scheduler.ts: lista os controladores vinculados ao projeto
// Tuya (cache de 10 min), lê TODOS os DPs de cada um (shadow/properties) e grava
// em tuya_temperature_readings — uma linha por DP (temperaturas com `celsius`;
// estados, enums, bitmaps, strings com value_raw/value_text). Pedido Flavio
// 27/out: "gravar todos os dados possíveis" — novos sensores e atribuições virão.
// Guarda o `time` do DP (carimbo do aparelho) em read_at e dedupe por
// UNIQUE(device_id, code, read_at): se o aparelho não reportou nada novo entre
// dois pollings, nada é inserido. SEM purga — retém para sempre.
// tuya_device_dps = catálogo dos DPs vistos por aparelho (tipo, nome, último valor).
//
// Tabelas SEM schema drizzle → SQL parametrizado (drizzle sql``), criadas no boot
// por ensureTuyaTables() (CREATE IF NOT EXISTS, idempotente).
// Estado da última rodada em memória + system_settings 'tuya_collector_last'
// (mesmo padrão do 'boleto_check_open_last').
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import {
  isTuyaConfigured, tuyaListDevices, tuyaShadowProperties, TuyaError, tuyaValueParts, type TuyaDevice,
} from './tuya-service';

const DEVICE_CACHE_MS = 10 * 60 * 1000;   // relista os aparelhos a cada 10 min
const CONCURRENCY = 3;                     // leituras simultâneas na nuvem

export interface TuyaCollectorState {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastDurationMs: number | null;
  devices: number;
  online: number;
  inserted: number;        // linhas novas na última rodada
  errors: string[];        // erros da última rodada
  trialExpired: boolean;   // code 28841002 → renovar IoT Core na plataforma Tuya
  totalRuns: number;
}

const state: TuyaCollectorState = {
  configured: isTuyaConfigured(), running: false, lastRunAt: null, lastOkAt: null, lastDurationMs: null,
  devices: 0, online: 0, inserted: 0, errors: [], trialExpired: false, totalRuns: 0,
};
export const getTuyaCollectorState = (): TuyaCollectorState => ({ ...state, configured: isTuyaConfigured() });

let deviceCache: { at: number; list: TuyaDevice[] } | null = null;
let tablesReady = false;

// ---------------------------------------------------------------------------
// Tabelas
// ---------------------------------------------------------------------------
export async function ensureTuyaTables(): Promise<void> {
  if (tablesReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tuya_devices (
      device_id     varchar PRIMARY KEY,
      name          varchar,
      product_name  varchar,
      category      varchar,
      online        boolean DEFAULT false,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz,
      last_poll_at  timestamptz,
      last_error    text,
      raw           jsonb
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tuya_temperature_readings (
      id           bigserial PRIMARY KEY,
      device_id    varchar NOT NULL,
      device_name  varchar,
      code         varchar NOT NULL,
      value_raw    integer,
      celsius      numeric(6,1),
      read_at      timestamptz NOT NULL,
      collected_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Colunas p/ guardar qualquer tipo de DP (27/out): id do DP, tipo Tuya e valor em texto (enum/string/bitmap/json).
  await db.execute(sql`ALTER TABLE tuya_temperature_readings ADD COLUMN IF NOT EXISTS dp_id integer`);
  await db.execute(sql`ALTER TABLE tuya_temperature_readings ADD COLUMN IF NOT EXISTS value_type varchar(20)`);
  await db.execute(sql`ALTER TABLE tuya_temperature_readings ADD COLUMN IF NOT EXISTS value_text text`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ux_tuya_readings_dev_code_time ON tuya_temperature_readings (device_id, code, read_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_tuya_readings_dev_code_time_desc ON tuya_temperature_readings (device_id, code, read_at DESC)`);
  // Catálogo dos DPs de cada aparelho (o que ele expõe, tipo, nome dado pela Coel, último valor visto).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tuya_device_dps (
      device_id     varchar NOT NULL,
      code          varchar NOT NULL,
      dp_id         integer,
      value_type    varchar(20),
      custom_name   varchar,
      is_temperature boolean NOT NULL DEFAULT false,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz,
      last_value_raw integer,
      last_value_text text,
      last_celsius  numeric(6,1),
      last_read_at  timestamptz,
      PRIMARY KEY (device_id, code)
    )`);
  tablesReady = true;
}

// ---------------------------------------------------------------------------
// Dispositivos (lista da Tuya + cache no banco)
// ---------------------------------------------------------------------------
export async function refreshTuyaDevices(force = false): Promise<TuyaDevice[]> {
  if (!force && deviceCache && Date.now() - deviceCache.at < DEVICE_CACHE_MS) return deviceCache.list;
  const list = await tuyaListDevices();
  await ensureTuyaTables();
  for (const d of list) {
    await db.execute(sql`
      INSERT INTO tuya_devices (device_id, name, product_name, category, online, last_seen_at, raw)
      VALUES (${d.id}, ${d.name}, ${d.product_name}, ${d.category}, ${d.online}, now(), ${JSON.stringify(d)}::jsonb)
      ON CONFLICT (device_id) DO UPDATE SET
        name = EXCLUDED.name, product_name = EXCLUDED.product_name, category = EXCLUDED.category,
        online = EXCLUDED.online, last_seen_at = now(), raw = EXCLUDED.raw`);
  }
  // Aparelho que sumiu da lista (desvinculado no app) fica como offline, mas o histórico permanece.
  if (list.length) {
    // drizzle expande array JS como lista (a, b, c) — usar NOT IN, não ::varchar[]
    const ids = sql.join(list.map((d) => sql`${d.id}`), sql`, `);
    await db.execute(sql`UPDATE tuya_devices SET online = false WHERE device_id NOT IN (${ids})`);
  }
  deviceCache = { at: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------------------
// Leitura de um aparelho → linhas novas
// ---------------------------------------------------------------------------
async function collectDevice(d: TuyaDevice): Promise<number> {
  const props = await tuyaShadowProperties(d.id);
  let inserted = 0;
  for (const p of props) {
    if (!p.code) continue;
    const { raw, text, celsius } = tuyaValueParts(p.code, p.value, p.type);
    const readAt = new Date(p.time);
    if (isNaN(readAt.getTime())) continue;
    const readIso = readAt.toISOString();
    const r: any = await db.execute(sql`
      INSERT INTO tuya_temperature_readings (device_id, device_name, code, dp_id, value_type, value_raw, value_text, celsius, read_at, collected_at)
      VALUES (${d.id}, ${d.name}, ${p.code}, ${isFinite(p.dp_id) ? p.dp_id : null}, ${p.type ?? null}, ${raw}, ${text}, ${celsius}, ${readIso}::timestamptz, now())
      ON CONFLICT (device_id, code, read_at) DO NOTHING
      RETURNING id`);
    if ((r.rows || []).length) inserted++;
    await db.execute(sql`
      INSERT INTO tuya_device_dps (device_id, code, dp_id, value_type, custom_name, is_temperature, last_seen_at, last_value_raw, last_value_text, last_celsius, last_read_at)
      VALUES (${d.id}, ${p.code}, ${isFinite(p.dp_id) ? p.dp_id : null}, ${p.type ?? null}, ${p.custom_name ?? null}, ${celsius != null}, now(), ${raw}, ${text}, ${celsius}, ${readIso}::timestamptz)
      ON CONFLICT (device_id, code) DO UPDATE SET
        dp_id = COALESCE(EXCLUDED.dp_id, tuya_device_dps.dp_id),
        value_type = COALESCE(EXCLUDED.value_type, tuya_device_dps.value_type),
        custom_name = COALESCE(EXCLUDED.custom_name, tuya_device_dps.custom_name),
        is_temperature = tuya_device_dps.is_temperature OR EXCLUDED.is_temperature,
        last_seen_at = now(), last_value_raw = EXCLUDED.last_value_raw, last_value_text = EXCLUDED.last_value_text,
        last_celsius = EXCLUDED.last_celsius, last_read_at = EXCLUDED.last_read_at`);
  }
  await db.execute(sql`UPDATE tuya_devices SET last_poll_at = now(), last_error = NULL WHERE device_id = ${d.id}`);
  return inserted;
}

// ---------------------------------------------------------------------------
// Rodada completa (chamada pelo cron de 1 min e pelo POST /api/tuya/collect-now)
// ---------------------------------------------------------------------------
export async function runTuyaCollector(opts: { forceDeviceRefresh?: boolean } = {}): Promise<TuyaCollectorState> {
  if (!isTuyaConfigured()) {
    state.errors = ['TUYA_ACCESS_SECRET nao configurado — coletor parado'];
    return getTuyaCollectorState();
  }
  if (state.running) return getTuyaCollectorState();   // rodada anterior ainda na nuvem
  state.running = true;
  const t0 = Date.now();
  const errors: string[] = [];
  let inserted = 0;
  let devices: TuyaDevice[] = [];
  try {
    await ensureTuyaTables();
    devices = await refreshTuyaDevices(opts.forceDeviceRefresh === true);
    state.trialExpired = false;
    const online = devices.filter((d) => d.online);
    // Lê também os offline? O shadow devolve o último valor conhecido, mas com o
    // mesmo `time` → dedupe não insere nada. Só gasta chamada: pula.
    const queue = online.slice();
    const worker = async () => {
      for (;;) {
        const d = queue.shift();
        if (!d) return;
        try {
          inserted += await collectDevice(d);
        } catch (e: any) {
          const msg = `${d.name} (${d.id}): ${e?.message || e}`;
          errors.push(msg);
          db.execute(sql`UPDATE tuya_devices SET last_poll_at = now(), last_error = ${String(e?.message || e).slice(0, 500)} WHERE device_id = ${d.id}`).catch(() => {});
          if (e instanceof TuyaError && e.isTrialExpired) { state.trialExpired = true; queue.length = 0; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));
    state.devices = devices.length;
    state.online = online.length;
    if (!errors.length) state.lastOkAt = new Date().toISOString();
  } catch (e: any) {
    errors.push(`listagem/tabelas: ${e?.message || e}`);
    if (e instanceof TuyaError && e.isTrialExpired) state.trialExpired = true;
    deviceCache = null;   // força relistar na próxima
  } finally {
    state.running = false;
    state.lastRunAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - t0;
    state.inserted = inserted;
    state.errors = errors;
    state.totalRuns++;
    if (inserted || errors.length) {
      console.log(`🌡️ [TUYA] rodada: ${devices.length} aparelho(s), ${inserted} leitura(s) nova(s), ${errors.length} erro(s) em ${state.lastDurationMs} ms${state.trialExpired ? ' — ⚠️ TRIAL IoT CORE VENCIDO (renovar na plataforma Tuya)' : ''}`);
      for (const er of errors) console.error('   [TUYA] ', er);
    }
    const reg = JSON.stringify({ at: state.lastRunAt, devices: devices.length, inserted, errors: errors.slice(0, 5), trialExpired: state.trialExpired });
    db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('tuya_collector_last', ${reg}, 'scheduler')
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`).catch(() => {});
  }
  return getTuyaCollectorState();
}
