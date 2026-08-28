import { db } from './db';
import { sql } from 'drizzle-orm';

// Colunas de RASTREABILIDADE DE LOTE acrescentadas de forma idempotente (mesmo padrao dos
// demais "ensure" do projeto — ver server/ensure-payment-method-card.ts). Rodam uma unica vez
// por processo, antes da primeira consulta de estoque/NF que depende delas.
//
//  - inventory_lots.manufacturing_date / expiry_date  -> dFab e dVal do grupo <rastro> da NF-e
//  - fiscal_invoice_items.lots (jsonb)                -> rastro completo do item (pode ter N lotes)
//
// Sem isso, um deploy com o schema novo quebraria o SELECT do Drizzle antes do `npm run db:push`.

let __loteColsReady: Promise<void> | null = null;

async function run(stmt: string) {
  try {
    await db.execute(sql.raw(stmt));
  } catch (e: any) {
    console.warn('[LOTE] ensure coluna:', stmt, '->', e?.message);
  }
}

export function ensureLoteColumns(): Promise<void> {
  if (!__loteColsReady) {
    __loteColsReady = (async () => {
      await run('ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS manufacturing_date date');
      await run('ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS expiry_date date');
      await run('ALTER TABLE fiscal_invoice_items ADD COLUMN IF NOT EXISTS lots jsonb');
      console.log('✅ [LOTE] colunas de rastreabilidade de lote conferidas');
    })();
  }
  return __loteColsReady;
}
