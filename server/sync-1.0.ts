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
// Ordem importa: tabelas referenciadas (pais) vêm antes das que dependem
// delas (FKs), para que o full-reset insira na ordem correta.
// naturalKey (opcional): quando o INSERT por id falha por conflito de chave
// única natural (mesma entidade com id diferente entre 1.0 e 2.0), faz UPDATE
// da linha existente no 2.0 casada por essa chave — sem alterar id/FKs.
const SYNC_TABLES: Array<{ table: string; pk: string; hasUpdatedAt: boolean; naturalKey?: string }> = [
{ table: "omie_instances", pk: "id", hasUpdatedAt: true },
{ table: "users", pk: "id", hasUpdatedAt: true },
{ table: "routes", pk: "id", hasUpdatedAt: true },
{ table: "customers", pk: "id", hasUpdatedAt: true, naturalKey: "cpf" },
{ table: "billings", pk: "id", hasUpdatedAt: false, naturalKey: "omie_order_id" },
{ table: "products", pk: "id", hasUpdatedAt: true },
{ table: "sales_cards", pk: "id", hasUpdatedAt: false },
{ table: "virtual_service_logs", pk: "id", hasUpdatedAt: true },
{ table: "prospections", pk: "id", hasUpdatedAt: false },
// --- Tabelas adicionadas (paridade de dados 1.0 → 2.0) ---
{ table: "leads", pk: "id", hasUpdatedAt: true },
{ table: "lead_visits", pk: "id", hasUpdatedAt: false },
  { table: "billing_pipeline", pk: "id", hasUpdatedAt: true },
{ table: "order_history", pk: "id", hasUpdatedAt: true },
{ table: "sales_goals", pk: "id", hasUpdatedAt: true },
{ table: "blocked_orders", pk: "id", hasUpdatedAt: true },
{ table: "delivery_drivers", pk: "id", hasUpdatedAt: true },
{ table: "delivery_routes", pk: "id", hasUpdatedAt: true },
{ table: "delivery_route_stops", pk: "id", hasUpdatedAt: true },
{ table: "visit_agenda", pk: "id", hasUpdatedAt: true },
{ table: "exported_reports", pk: "id", hasUpdatedAt: false },
// --- Módulo de chat/atendimento (pais antes dos filhos por FK) ---
{ table: "chat_agents", pk: "id", hasUpdatedAt: true },
{ table: "chat_customers", pk: "id", hasUpdatedAt: true },
{ table: "chat_conversations", pk: "id", hasUpdatedAt: true },
{ table: "chat_messages", pk: "id", hasUpdatedAt: false },
{ table: "chat_assignment_history", pk: "id", hasUpdatedAt: false },
{ table: "chat_quick_messages", pk: "id", hasUpdatedAt: true },
{ table: "chat_orders", pk: "id", hasUpdatedAt: true },
{ table: "chat_products", pk: "id", hasUpdatedAt: false },
{ table: "chat_deliveries", pk: "id", hasUpdatedAt: true },
{ table: "chat_reports", pk: "id", hasUpdatedAt: false },
// --- Tabelas de recurso adicionais (descobertas na varredura de abas; tinham dados no 1.0 e estavam vazias no 2.0) ---
{ table: "active_customers", pk: "id", hasUpdatedAt: true },        // alimenta a tela "Clientes Ativos"
{ table: "active_customer_uploads", pk: "id", hasUpdatedAt: false },
{ table: "fiscal_scenarios", pk: "id", hasUpdatedAt: true },        // cenários fiscais
{ table: "chat_ai_settings", pk: "id", hasUpdatedAt: true },
{ table: "chat_ai_logs", pk: "id", hasUpdatedAt: false },
{ table: "chat_ai_reports", pk: "id", hasUpdatedAt: false },
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
      // value pode estar como JSON string com aspas extra (ex: '"2026-..."') — fazer JSON.parse
      const val = typeof raw === 'string' ? raw : String(raw);
      const clean = val.startsWith('"') ? JSON.parse(val) : val;
      const date = new Date(clean);
      if (!isNaN(date.getTime())) return date;
    }
  } catch { /* tabela pode não existir ainda */ }
  return new Date(0); // Época Unix — sincroniza tudo na primeira vez
}

async function setLastSyncedAt(target: pg.Client, at: Date): Promise<void> {
  const value = at.toISOString(); // ISO string pura (sem aspas JSON extras)
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
  if (!existsRes.rows[0]?.exists) {
    logger.info({ table: cfg.table }, "Tabela não existe no source (Neon) — pulando");
    return 0;
  }

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
  const tgtJsonColsRes = await target.query(
    "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND udt_name IN ('json','jsonb')",
    [cfg.table]
  );
  const jsonbCols = new Set<string>(tgtJsonColsRes.rows.map((r: any) => r.column_name as string));
  // naturalKey só é usável se a coluna existir no target
  const naturalKey = cfg.naturalKey && targetColSet.has(cfg.naturalKey) ? cfg.naturalKey : undefined;


  // Busca com paginação — percorre TODAS as páginas até esgotar os registros
  const FETCH_LIMIT = 1000;
  const BATCH = 200;
  let currentSince = since;
  let upserted = 0;
  let cols: string[] | null = null;
  let colsSql = "";
  let setClauses = "";

  // Full reset (since=epoch): use OFFSET pagination; delta: use date cursor
const isFullReset = since.getTime() === 0;
let offset = 0;

while (true) {
let dataRes;
if (isFullReset) {
dataRes = await source.query(
`SELECT * FROM "${cfg.table}" ORDER BY "${cfg.pk}" LIMIT ${FETCH_LIMIT} OFFSET $1`,
[offset]
);
} else {
dataRes = await source.query(
`SELECT * FROM "${cfg.table}" WHERE ${dateCol} > $1 ORDER BY ${dateCol} ASC LIMIT ${FETCH_LIMIT}`,
[currentSince]
);
}

if (dataRes.rows.length === 0) break;

if (!cols) {
cols = Object.keys(dataRes.rows[0]).filter(c => targetColSet.has(c));
if (cols.length === 0) break;
colsSql = cols.map(c => `"${c}"`).join(", ");
setClauses = cols
.filter(c => c !== cfg.pk)
.map(c => `"${c}" = EXCLUDED."${c}"`)
.join(", ");
}

for (let i = 0; i < dataRes.rows.length; i += BATCH) {
const batch = dataRes.rows.slice(i, i + BATCH);
const valuePlaceholders = batch.map((_, ri) =>
"(" + cols!.map((_, ci) => `$${ri * cols!.length + ci + 1}`).join(", ") + ")"
).join(", ");
        const flat = batch.flatMap(r => cols!.map(c => {
          const v = r[c];
          if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v);
          return v;
        }));

        try {
          await target.query(
            `INSERT INTO "${cfg.table}" (${colsSql})
            VALUES ${valuePlaceholders}
            ON CONFLICT ("${cfg.pk}") DO UPDATE SET ${setClauses}`,
            flat
          );
          upserted += batch.length;
        } catch (batchErr: any) {
          logger.warn({ table: cfg.table, batchErr: batchErr.message }, "Batch falhou — row-by-row");
          for (const row of batch) {
            const rowVals = cols!.map(c => {
              const v = row[c];
              if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v);
              return v;
            });
            const rowPH = cols!.map((_x: any, i: number) => '$' + (i + 1)).join(", ");
            try {
              await target.query(
                `INSERT INTO "${cfg.table}" (${colsSql}) VALUES (${rowPH}) ON CONFLICT ("${cfg.pk}") DO UPDATE SET ${setClauses}`,
                rowVals
              );
              upserted++;
            } catch (rowErr: any) {
              // Merge por chave natural (ex: cpf, omie_order_id): a mesma entidade já
              // existe no 2.0 com id diferente — atualiza a linha existente sem mexer no id.
              if (naturalKey && row[naturalKey] != null) {
                try {
                  const upCols = cols!.filter(c => c !== cfg.pk && c !== naturalKey);
                  const setExpr = upCols.map((c, idx) => `"${c}" = $${idx + 1}`).join(", ");
                  const upVals = upCols.map(c => {
                    const v = row[c];
                    if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v);
                    return v;
                  });
                  upVals.push(row[naturalKey]);
                  const upRes = await target.query(
                    `UPDATE "${cfg.table}" SET ${setExpr} WHERE "${naturalKey}" = $${upCols.length + 1}`,
                    upVals
                  );
                  if (upRes.rowCount && upRes.rowCount > 0) {
                    upserted++;
                  } else {
                    logger.warn({ table: cfg.table, id: row[cfg.pk] }, "Linha pulada (chave natural não encontrada)");
                  }
                } catch (nkErr: any) {
                  logger.warn({ table: cfg.table, id: row[cfg.pk], err: nkErr.message }, "Linha pulada (merge por chave natural falhou)");
                }
              } else {
                logger.warn({ table: cfg.table, id: row[cfg.pk], err: rowErr.message }, "Linha pulada");
              }
            }
          }
        }
}

if (dataRes.rows.length < FETCH_LIMIT) break;

if (isFullReset) {
offset += FETCH_LIMIT;
} else {
const lastRow = dataRes.rows[dataRes.rows.length - 1];
currentSince = lastRow[dateCol];
}
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
    // Diagnose source tables
    const srcTablesRes = await source.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    logger.info({ sourceTables: srcTablesRes.rows.map((r: any) => r.table_name) }, "Source DB tables");
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

// Guarda contra execuções sobrepostas (importante no fallback setInterval)
let __syncRunning = false;
async function runSyncGuarded(): Promise<void> {
  if (__syncRunning) {
    logger.warn("Sync 1.0→2.0 já em execução — ciclo ignorado");
    return;
  }
  __syncRunning = true;
  try {
    await runSync();
  } catch (err: any) {
    logger.error({ err: err?.message }, "Sync 1.0→2.0 (ciclo) falhou");
  } finally {
    __syncRunning = false;
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
    // FALLBACK sem Redis: agenda via setInterval no próprio processo.
    // Garante sync contínuo mesmo quando o BullMQ/Redis não está disponível.
    logger.warn({ intervalMinutes: INTERVAL_MINUTES }, "Redis indisponível — usando setInterval como fallback para sync 1.0→2.0");
    setInterval(() => { void runSyncGuarded(); }, INTERVAL_MINUTES * 60 * 1000);
    void runSyncGuarded(); // roda uma vez logo ao iniciar
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
    await runSyncGuarded();
  });

  logger.info({ intervalMinutes: INTERVAL_MINUTES }, "Worker de sync 1.0→2.0 iniciado");
}

// Exporta funções para execução manual e reset de timestamp
export { runSync };

/** Remove o timestamp salvo, forçando a próxima sync a partir do epoch (resync completo) */
export async function resetSyncTimestamp(): Promise<void> {
  if (!LOCAL_DB_URL) return;
  const target = new Client({ connectionString: LOCAL_DB_URL, ssl: { rejectUnauthorized: false } });
  await target.connect();
  try {
    await target.query("DELETE FROM system_settings WHERE key = $1", [SETTINGS_KEY]);
    logger.info("Timestamp de sync resetado — próxima sync será completa");
  } finally {
    await target.end().catch(() => {});
  }
}
