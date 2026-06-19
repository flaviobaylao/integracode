/**
 * server/sync-1.0.ts
 * ============================================================
 * Serviço de sincronização contínua Integra 1.0 → 2.0
 *
 * Funciona como um worker BullMQ que, a cada intervalo
 * configurável, replica dados novos/alterados do banco do
 * Integra 1.0 (Replit) para o banco do Integra 2.0 (Railway).
 *
 * VARIÁVEIS DE AMBIENTE necessárias:
 *   REPLIT_DATABASE_URL   — URL do PostgreSQL do Replit (source)
 *   DATABASE_URL          — URL do PostgreSQL do Railway (target)
 *   REDIS_URL             — URL do Redis (BullMQ)
 *   SYNC_INTERVAL_MINUTES — Intervalo em minutos (padrão: 5)
 *   SYNC_ENABLED          — "true" para ativar (padrão: false)
 *
 * SEGURANÇA:
 *   - Leitura apenas no source; escrita apenas no target.
 *   - Usa ON CONFLICT (id) DO UPDATE para ser idempotente.
 *   - Não apaga registros no target (soft-delete apenas).
 *   - Rastreia `last_synced_at` em system_settings para
 *     sincronizar apenas o delta (registros novos/alterados).
 * ============================================================
 */

import pg from "pg";
import { logger } from "./logger";
import { getQueue, createWorker, QUEUE_NAMES } from "./queue";

const { Client } = pg;

// ----------------------------------------------------------------
// Configuração
// ----------------------------------------------------------------
const REPLIT_DB_URL    = process.env.REPLIT_DATABASE_URL;
const LOCAL_DB_URL     = process.env.DATABASE_URL;
const SYNC_ENABLED     = process.env.SYNC_ENABLED === "true";
const INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || "1", 10);

// Tabelas sincronizadas e suas PKs
const SYNC_TABLES: Array<{ table: string; pk: string; hasUpdatedAt: boolean }> = [
  { table: "omie_instances",       pk: "id", hasUpdatedAt: true  },
  { table: "users",                pk: "id", hasUpdatedAt: true  },
  { table: "routes",               pk: "id", hasUpdatedAt: true  },
  { table: "customers",            pk: "id", hasUpdatedAt: true  },
  { table: "products",             pk: "id", hasUpdatedAt: true  },
  { table: "sales_cards",          pk: "id", hasUpdatedAt: false }, // sem updated_at, usa created_at
  { table: "virtual_service_logs", pk: "id", hasUpdatedAt: true  },
  { table: "prospections",         pk: "id", hasUpdatedAt: false },
  { table: "delivery_orders",      pk: "id", hasUpdatedAt: true  },
  { table: "payment_records",      pk: "id", hasUpdatedAt: true  },
  { table: "omie_sync_logs",       pk: "id", hasUpdatedAt: false },
  { table: "billing_pipeline_items", pk: "id", hasUpdatedAt: true  },
];

const SETTINGS_KEY = "sync_1_0_last_at";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function getLastSyncedAt(target: pg.Client): Promise<Date> {
  try {
    const res = await target.query(
      "SELECT value FROM system_settings WHERE key = $1",
      [SETTINGS_KEY]
    );
    const raw = res.rows[0]?.value;
    if (raw) {
      // pg driver auto-parseia jsonb; raw pode ser string ou objeto
      const val = typeof raw === 'string' ? raw : String(raw);
      return new Date(val);
    }
  } catch { /* tabela pode não existir ainda */ }
  return new Date(0); // Época Unix — sincroniza tudo na primeira vez
}

async function setLastSyncedAt(target: pg.Client, at: Date): Promise<void> {
  // JSON.stringify garante valor JSON válido (coluna value pode ser jsonb)
  const value = JSON.stringify(at.toISOString());
  await target.query(`
    INSERT INTO system_settings (id, key, value, description, updated_by, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'Última sincronização 1.0→2.0', 'sync-service', NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [SETTINGS_KEY, value]);
}

async function syncTable(
  source: pg.Client,
  target: pg.Client,
  cfg: typeof SYNC_TABLES[number],
  since: Date
): Promise<number> {
  const dateCol = cfg.hasUpdatedAt ? "updated_at" : "created_at";

  // Verifica se a tabela existe na source
  const existsRes = await source.query(
    "SELECT to_regclass($1) AS exists",
    [`public.${cfg.table}`]
  );
  if (!existsRes.rows[0]?.exists) return 0;

  // Também verifica no target
  const existsTarget = await target.query(
    "SELECT to_regclass($1) AS exists",
    [`public.${cfg.table}`]
  );
  if (!existsTarget.rows[0]?.exists) {
    logger.warn({ table: cfg.table }, "Tabela não existe no target — pulando");
    return 0;
  }

  // Obtém colunas que existem no target para evitar schema mismatch (1.0 pode ter colunas extras)
  const targetColsRes = await target.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [cfg.table]
  );
  const targetColSet = new Set<string>(targetColsRes.rows.map((r: any) => r.column_name as string));

  const dataRes = await source.query(
    `SELECT * FROM "${cfg.table}" WHERE ${dateCol} > $1 ORDER BY ${dateCol} ASC LIMIT 1000`,
    [since]
  );

  if (dataRes.rows.length === 0) return 0;

  // Filtra apenas colunas presentes no target (evita erros de schema mismatch)
  const cols = Object.keys(dataRes.rows[0]).filter(c => targetColSet.has(c));
  if (cols.length === 0) return 0;
  const colsSql = cols.map(c => `"${c}"`).join(", ");

  // BUILD: INSERT … ON CONFLICT (pk) DO UPDATE SET …
  const setClauses = cols
    .filter(c => c !== cfg.pk)
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");

  const BATCH = 200;
  let upserted = 0;

  for (let i = 0; i < dataRes.rows.length; i += BATCH) {
    const batch = dataRes.rows.slice(i, i + BATCH);
    const valuePlaceholders = batch.map((_, ri) =>
      "(" + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ") + ")"
    ).join(", ");
    const flat = batch.flatMap(r => cols.map(c => r[c]));

    await target.query(
      `INSERT INTO "${cfg.table}" (${colsSql})
       VALUES ${valuePlaceholders}
       ON CONFLICT ("${cfg.pk}") DO UPDATE SET ${setClauses}`,
      flat
    );
    upserted += batch.length;
  }

  return upserted;
}

// ----------------------------------------------------------------
// Job principal
// ----------------------------------------------------------------

async function runSync(): Promise<void> {
  if (!REPLIT_DB_URL) {
    logger.warn("REPLIT_DATABASE_URL não definido — sync 1.0→2.0 desabilitado");
    return;
  }
  if (!LOCAL_DB_URL) {
    logger.warn("DATABASE_URL não definido — sync 1.0→2.0 desabilitado");
    return;
  }

  const source = new Client({ connectionString: REPLIT_DB_URL, ssl: { rejectUnauthorized: false } });
  const target = new Client({ connectionString: LOCAL_DB_URL,  ssl: { rejectUnauthorized: false } });

  try {
    await source.connect();
    await target.connect();

    const since = await getLastSyncedAt(target);
    const syncStart = new Date();
    logger.info({ since }, "Sync 1.0→2.0 iniciado");

    let totalRows = 0;
    for (const cfg of SYNC_TABLES) {
      try {
        const count = await syncTable(source, target, cfg, since);
        if (count > 0) {
          logger.info({ table: cfg.table, count }, "Tabela sincronizada");
          totalRows += count;
        }
      } catch (tableErr: any) {
        logger.error({ table: cfg.table, err: tableErr.message }, "Erro ao sincronizar tabela — pulando");
      }
    }

    await setLastSyncedAt(target, syncStart);
    logger.info({ totalRows, durationMs: Date.now() - syncStart.getTime() }, "Sync 1.0→2.0 concluído");
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

// ----------------------------------------------------------------
// Registro como worker BullMQ
// ----------------------------------------------------------------

export function startSyncWorker(): void {
  if (!SYNC_ENABLED) {
    logger.info("Sync 1.0→2.0 desabilitado (SYNC_ENABLED != true)");
    return;
  }

  const queue = getQueue("omie-sync" as any); // reusa fila genérica de sync
  if (!queue) {
    logger.warn("Redis não disponível — worker de sync 1.0→2.0 não iniciado");
    return;
  }

  // Agenda o job repetitivo
  queue.add(
    "sync-1.0",
    {},
    {
      repeat: { every: INTERVAL_MINUTES * 60 * 1000 },
      jobId: "sync-1.0-recurring",
    }
  ).catch(err => logger.error({ err }, "Falha ao agendar sync 1.0"));

  // Registra o worker que processa o job
  createWorker("omie-sync" as any, async (job) => {
    if (job.name !== "sync-1.0") return;
    await runSync();
  });

  logger.info({ intervalMinutes: INTERVAL_MINUTES }, "Worker de sync 1.0→2.0 iniciado");
}

// Exporta a função de sync para execução manual (ex: scripts/run-sync.ts)
export { runSync };
