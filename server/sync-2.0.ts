/**
 * server/sync-2.0.ts
 * ============================================================
 * Serviço de sincronização contínua Integra 2.0 → 1.0
 *
 * Replica dados novos/alterados do banco do Integra 2.0
 * (Railway PostgreSQL) de volta ao banco do Integra 1.0
 * (Replit Neon PostgreSQL), fechando o loop bidirecional.
 *
 * VARIÁVEIS DE AMBIENTE:
 *   DATABASE_URL            — Railway (source)
 *   REPLIT_DATABASE_URL     — Neon/Replit (target)
 *   SYNC_20_INTERVAL_MINUTES — Intervalo em minutos (padrão: 5)
 *   SYNC_20_ENABLED         — "true" para ativar
 *
 * CONFLICT RESOLUTION: last-write-wins por updated_at.
 * SEGURANÇA: introspect de colunas — sincroniza apenas o
 * subconjunto comum entre os dois schemas.
 * ============================================================
 */

import pg from "pg";
import { logger } from "./logger";
import { getQueue, createWorker } from "./queue";

const { Client } = pg;

const LOCAL_DB_URL  = process.env.DATABASE_URL;
const REPLIT_DB_URL = process.env.REPLIT_DATABASE_URL;
const SYNC_ENABLED  = process.env.SYNC_20_ENABLED === "true";
const INTERVAL_MIN  = parseInt(process.env.SYNC_20_INTERVAL_MINUTES || "5", 10);

const SYNC_TABLES: Array<{
  table: string;
  pk: string;
  dateCol: "updated_at" | "created_at";
}> = [
  { table: "customers",       pk: "id", dateCol: "updated_at" },
  { table: "products",        pk: "id", dateCol: "updated_at" },
  { table: "users",           pk: "id", dateCol: "updated_at" },
  { table: "routes",          pk: "id", dateCol: "updated_at" },
  { table: "sales_cards",     pk: "id", dateCol: "updated_at" },
  { table: "leads",           pk: "id", dateCol: "updated_at" },
  { table: "order_history",   pk: "id", dateCol: "created_at" },
  { table: "visit_agenda",    pk: "id", dateCol: "updated_at" },
  { table: "daily_routes",    pk: "id", dateCol: "updated_at" },
  { table: "delivery_routes", pk: "id", dateCol: "updated_at" },
  { table: "delivery_drivers",pk: "id", dateCol: "updated_at" },
{ table: "billings", pk: "id", dateCol: "created_at" },
];

const SETTINGS_KEY = "sync_2_0_last_at";

async function getColumns(client: pg.Client, table: string): Promise<string[]> {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r: any) => r.column_name as string);
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const res = await client.query("SELECT to_regclass($1) AS e", [`public.${table}`]);
  return !!res.rows[0]?.e;
}

async function getLastSyncedAt(target: pg.Client): Promise<Date> {
  try {
    const res = await target.query(
      "SELECT value FROM system_settings WHERE key = $1",
      [SETTINGS_KEY]
    );
    if (res.rows[0]?.value) return new Date(res.rows[0].value);
  } catch { /* ok */ }
  return new Date(0);
}

async function setLastSyncedAt(target: pg.Client, at: Date): Promise<void> {
  await target.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [SETTINGS_KEY, at.toISOString()]
  );
}

async function syncTable(
  source: pg.Client,
  target: pg.Client,
  cfg: (typeof SYNC_TABLES)[number],
  since: Date
): Promise<number> {
  if (!(await tableExists(source, cfg.table))) return 0;
  if (!(await tableExists(target, cfg.table))) {
    logger.warn({ table: cfg.table }, "2.0→1.0 tabela ausente no target");
    return 0;
  }

  // Colunas comuns — ignora colunas exclusivas do 2.0
  const [srcCols, tgtCols] = await Promise.all([
    getColumns(source, cfg.table),
    getColumns(target, cfg.table),
  ]);
  const tgtSet = new Set(tgtCols);
  const cols = srcCols.filter(c => tgtSet.has(c));
  if (cols.length === 0) return 0;

  const dataRes = await source.query(
    `SELECT ${cols.map(c => `"${c}"`).join(", ")}
     FROM "${cfg.table}"
     WHERE ${cfg.dateCol} > $1
     ORDER BY ${cfg.dateCol} ASC LIMIT 1000`,
    [since]
  );
  if (dataRes.rows.length === 0) return 0;

  const colsSql = cols.map(c => `"${c}"`).join(", ");
  const setClauses = cols
    .filter(c => c !== cfg.pk)
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  const whereClause = tgtCols.includes("updated_at")
    ? `WHERE "${cfg.table}"."updated_at" <= EXCLUDED."updated_at"`
    : "";

  const BATCH = 200;
  let upserted = 0;
  for (let i = 0; i < dataRes.rows.length; i += BATCH) {
    const batch = dataRes.rows.slice(i, i + BATCH);
    const placeholders = batch
      .map((_, ri) =>
        "(" + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ") + ")"
      )
      .join(", ");
    const flat = batch.flatMap(r => cols.map(c => r[c]));
    await target.query(
      `INSERT INTO "${cfg.table}" (${colsSql})
       VALUES ${placeholders}
       ON CONFLICT ("${cfg.pk}") DO UPDATE SET ${setClauses}
       ${whereClause}`,
      flat
    );
    upserted += batch.length;
  }
  return upserted;
}

export async function runSync20(): Promise<{
  success: boolean;
  totalRows: number;
  durationMs: number;
  tables: Record<string, number>;
  error?: string;
}> {
  const start = Date.now();
  const tables: Record<string, number> = {};

  if (!LOCAL_DB_URL || !REPLIT_DB_URL) {
    const msg = "DATABASE_URL ou REPLIT_DATABASE_URL não definido";
    logger.warn(msg);
    return { success: false, totalRows: 0, durationMs: 0, tables, error: msg };
  }

  const source = new Client({ connectionString: LOCAL_DB_URL,  ssl: false });
  const target = new Client({
    connectionString: REPLIT_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await source.connect();
    await target.connect();

    const since = await getLastSyncedAt(target);
    const syncStart = new Date();
    logger.info({ since, direction: "2.0→1.0" }, "Sync 2.0→1.0 iniciado");

    let totalRows = 0;
    for (const cfg of SYNC_TABLES) {
      try {
        const count = await syncTable(source, target, cfg, since);
        tables[cfg.table] = count;
        if (count > 0) {
          logger.info({ table: cfg.table, count }, "2.0→1.0 sincronizada");
          totalRows += count;
        }
      } catch (err: any) {
        logger.error({ table: cfg.table, err: err.message }, "2.0→1.0 erro na tabela");
        tables[cfg.table] = -1;
      }
    }

    await setLastSyncedAt(target, syncStart);
    const durationMs = Date.now() - start;
    logger.info({ totalRows, durationMs }, "Sync 2.0→1.0 concluído");
    return { success: true, totalRows, durationMs, tables };
  } catch (err: any) {
    logger.error({ err: err.message }, "Sync 2.0→1.0 falhou");
    return {
      success: false,
      totalRows: 0,
      durationMs: Date.now() - start,
      tables,
      error: err.message,
    };
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

/** Remove o timestamp do sync 2.0→1.0, forçando resync completo */
export async function resetSync20Timestamp(): Promise<void> {
  if (!REPLIT_DB_URL) return;
  const target = new Client({ connectionString: REPLIT_DB_URL, ssl: { rejectUnauthorized: false } });
  await target.connect();
  try {
    await target.query("DELETE FROM system_settings WHERE key = $1", [SETTINGS_KEY]);
    logger.info("Timestamp sync 2.0→1.0 resetado");
  } finally {
    await target.end().catch(() => {});
  }
}

export function startSync20Worker(): void {
  if (!SYNC_ENABLED) {
    logger.info("Sync 2.0→1.0 desabilitado (SYNC_20_ENABLED != true)");
    return;
  }

  const queue = getQueue("omie-sync" as any);
  if (!queue) {
    logger.warn("Redis indisponível — worker de sync 2.0→1.0 não iniciado");
    return;
  }

  queue
    .add("sync-2.0", {}, {
      repeat: { every: INTERVAL_MIN * 60 * 1000 },
      jobId: "sync-2.0-recurring",
    })
    .catch(err => logger.error({ err }, "Falha ao agendar sync 2.0"));

  createWorker("omie-sync" as any, async (job) => {
    if (job.name !== "sync-2.0") return;
    await runSync20();
  });

  logger.info({ intervalMinutes: INTERVAL_MIN }, "Worker sync 2.0→1.0 iniciado");
                }
