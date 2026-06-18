/**
 * scripts/migrate-production.ts
 * ============================================================
 * Migra dados do Integra 1.0 (Replit / source) para o
 * Integra 2.0 (Railway / target).
 *
 * COMO USAR:
 *   1. Exporte as variáveis de ambiente:
 *        SOURCE_DATABASE_URL=<URL do banco do Replit>
 *        TARGET_DATABASE_URL=<URL do banco do Railway>
 *   2. Execute (dry-run primeiro!):
 *        DRY_RUN=true npx tsx scripts/migrate-production.ts
 *   3. Se ok, execute de verdade:
 *        npx tsx scripts/migrate-production.ts
 *
 * SEGURANÇA:
 *   - O script NUNCA apaga dados do source.
 *   - Por padrão usa INSERT … ON CONFLICT DO NOTHING (idempotente).
 *   - Tabelas migradas em ordem segura de FK.
 *   - O script pode ser re-executado sem duplicar dados.
 * ============================================================
 */

import pg from "pg";

const { Client } = pg;

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;
const DRY_RUN   = process.env.DRY_RUN === "true";

if (!SOURCE_URL || !TARGET_URL) {
  console.error("❌  Defina SOURCE_DATABASE_URL e TARGET_DATABASE_URL antes de executar.");
  process.exit(1);
}

// ----------------------------------------------------------------
// Ordem de migração: respeita dependências de FK
// ----------------------------------------------------------------
const MIGRATION_ORDER: string[] = [
  "omie_instances",          // sem dependências
  "users",                   // sem dependências
  "routes",                  // sem dependências
  "system_settings",         // sem dependências
  "customers",               // depende de users (seller_id), omie_instances
  "products",                // depende de omie_instances
  "product_reviews",         // depende de products
  "sales_cards",             // depende de customers, users, products (via jsonb)
  "delivery_orders",         // depende de sales_cards
  "deliveries",              // depende de delivery_orders, users
  "delivery_items",          // depende de deliveries, products
  "order_history",           // depende de sales_cards, users
  "omie_sync_logs",          // depende de omie_instances
  "virtual_service_logs",    // depende de customers, users
  "prospections",            // depende de customers, users, virtual_service_logs
  "blocked_orders",          // depende de customers, users
  "payment_records",         // depende de sales_cards, users
  "telegram_notifications",  // depende de users
  "sessions",                // sessões ativas (migrar por último / opcional)
];

// Tabelas que NÃO devem ser migradas (dados sensíveis de sessão ou recriados automaticamente)
const SKIP_TABLES = new Set(["sessions"]);

async function migrateTable(source: pg.Client, target: pg.Client, table: string) {
  if (SKIP_TABLES.has(table)) {
    console.log(`⏭  Pulando ${table} (na lista de exclusão)`);
    return;
  }

  // Verifica se a tabela existe na source
  const existsRes = await source.query(
    `SELECT to_regclass('public.${table}') AS exists`
  );
  if (!existsRes.rows[0]?.exists) {
    console.log(`⚠️  Tabela ${table} não encontrada na source — pulando`);
    return;
  }

  const countRes = await source.query(`SELECT COUNT(*) FROM "${table}"`);
  const total = parseInt(countRes.rows[0].count, 10);
  console.log(`📋  ${table}: ${total} registros`);

  if (total === 0) return;
  if (DRY_RUN) {
    console.log(`   ✅  [DRY RUN] nada executado`);
    return;
  }

  // Busca dados em lotes de 500 para não estourar memória
  const BATCH = 500;
  let offset = 0;
  let migrated = 0;

  while (offset < total) {
    const dataRes = await source.query(
      `SELECT * FROM "${table}" ORDER BY 1 LIMIT ${BATCH} OFFSET ${offset}`
    );
    const rows = dataRes.rows;
    if (rows.length === 0) break;

    const cols = Object.keys(rows[0]).map(c => `"${c}"`).join(", ");
    const values = rows.map((row, ri) => {
      const params = Object.keys(row).map((_, ci) => `$${ri * Object.keys(row).length + ci + 1}`);
      return `(${params.join(", ")})`;
    });

    // Flatten values
    const flat = rows.flatMap(r => Object.values(r));

    const sql = `
      INSERT INTO "${table}" (${cols})
      VALUES ${values.join(", ")}
      ON CONFLICT DO NOTHING
    `;

    await target.query(sql, flat);
    migrated += rows.length;
    offset += BATCH;
    process.stdout.write(`\r   ↳ ${migrated}/${total}`);
  }
  console.log(`\n   ✅  ${migrated} registros migrados`);
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Integra 1.0 → 2.0  |  Migração de dados`);
  console.log(DRY_RUN ? "⚠️  DRY RUN — nenhuma escrita será feita" : "🚀  MODO REAL — dados serão escritos no target");
  console.log("=".repeat(60));

  const source = new Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
  const target = new Client({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

  await source.connect();
  console.log("✅  Conectado à source (1.0)");
  await target.connect();
  console.log("✅  Conectado ao target (2.0)");

  // Desabilita triggers no target durante a migração (evita loops de cálculo)
  if (!DRY_RUN) {
    await target.query("SET session_replication_role = replica;");
  }

  for (const table of MIGRATION_ORDER) {
    await migrateTable(source, target, table);
  }

  // Re-habilita triggers
  if (!DRY_RUN) {
    await target.query("SET session_replication_role = DEFAULT;");
  }

  await source.end();
  await target.end();

  console.log("\n" + "=".repeat(60));
  console.log("✅  Migração concluída!");
  if (DRY_RUN) {
    console.log("   Execute sem DRY_RUN=true para migrar de verdade.");
  }
}

main().catch(err => {
  console.error("❌  Erro na migração:", err);
  process.exit(1);
});
