// ============================================================================
// HARNESS — ESTORNO DE ESTOQUE NA DEVOLUCAO / CANCELAMENTO (Flavio, 20/set/2026)
//
// Roda contra um PostgreSQL real (nao entra no vitest; o include e *.test.ts):
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-estorno-devolucao.ts
//
// Cobre os defeitos achados na NF-e 102879 (transferencia IND->GYN devolvida):
//   1. transferencia com espelho: origem +, destino -, lote EXATO
//   2. idempotencia: estornar duas vezes nao duplica
//   3. card de transferencia SEM baixa nenhuma -> handled=false (antes voltava
//      true e o estorno generico era pulado: o estoque nao voltava, em silencio)
//   4. baixa gravada com source_id da NF (rota /emit) tambem e encontrada
//   5. transferencia sem espelho no destino -> origem volta + aviso explicito
//   6. NF sem sales_card_id -> handled=false
//   7. guarda: NF de entrada (finNFe=4) nunca estorna estoque
//   8. CFOP da devolucao espelha o da original
// ============================================================================
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { reverseTransferStockExact } from '../lot-lock';
import { cfopDevolucao, nfMovimentouEstoque } from '../nfe-routes';

let ok = 0;
let fail = 0;
function check(cond: boolean, label: string, extra?: any) {
  if (cond) { ok++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const IND = 'inst-ind';
const GYN = 'inst-gyn';
const PROD = 'prod-suco-350';

async function limpar() {
  await db.execute(sql`DELETE FROM inventory_movements WHERE instance_id IN (${IND}, ${GYN})`);
  await db.execute(sql`DELETE FROM inventory_lots WHERE instance_id IN (${IND}, ${GYN})`);
  await db.execute(sql`DELETE FROM billing_pipeline WHERE sales_card_id LIKE 'sc-harness-%'`);
}

async function criarLote(instancia: string, lote: string, qtd: number) {
  const r: any = await db.execute(sql`
    INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, unit_cost, cmv_estimado, is_active)
    VALUES (gen_random_uuid()::varchar, ${PROD}, ${instancia}, 'in_use', ${lote}, ${qtd.toFixed(4)}, '1.7926', false, true)
    RETURNING id`);
  return String(r.rows[0].id);
}

async function criarCard(sufixo: string) {
  const r: any = await db.execute(sql`
    INSERT INTO billing_pipeline (id, sales_card_id, customer_id, customer_name, stage, is_priority, operation_type, order_number, omie_instance_id, products, created_at)
    VALUES (gen_random_uuid()::varchar, ${'sc-harness-' + sufixo}, 'cli-gyn', 'FILIAL GYN', 'faturado', false, 'transferencia', ${'TRF-' + sufixo.toUpperCase()}, ${IND}, '[]'::jsonb, now())
    RETURNING id`);
  return String(r.rows[0].id);
}

async function mov(tipo: string, lotId: string, instancia: string, lote: string, qtd: number, sourceId: string, de: number, para: number) {
  await db.execute(sql`
    INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_at)
    VALUES (gen_random_uuid()::varchar, ${lotId}, ${PROD}, ${instancia}, ${tipo}, ${qtd.toFixed(4)}, ${de.toFixed(4)}, ${para.toFixed(4)}, 'invoice', ${sourceId}, ${lote}, 'harness', now())`);
}

async function saldo(lotId: string) {
  const r: any = await db.execute(sql`SELECT quantity FROM inventory_lots WHERE id = ${lotId}`);
  return Number(r.rows[0]?.quantity ?? NaN);
}

async function main() {
  await limpar();

  // ---- 1. transferencia com espelho -----------------------------------------
  {
    const card = await criarCard('c1');
    const nf = { id: 'nf-c1', invoiceNumber: 1001, salesCardId: 'sc-harness-c1' };
    const origem = await criarLote(IND, 'H170926', 0);      // ja zerada pela baixa
    const destino = await criarLote(GYN, 'H170926', 2296);  // espelho criado no faturamento
    await mov('consume', origem, IND, 'H170926', 2296, card, 2296, 0);
    await mov('replenish', destino, GYN, 'H170926', 2296, card, 0, 2296);

    const r = await reverseTransferStockExact(nf, 'harness');
    check(r.handled === true, '1a. transferencia com espelho: handled');
    check(await saldo(origem) === 2296, '1b. origem recebeu de volta no lote exato', await saldo(origem));
    check(await saldo(destino) === 0, '1c. espelho retirado do destino', await saldo(destino));
    check(r.undone.length === 2, '1d. dois movimentos estornados', r.undone);

    // ---- 2. idempotencia ----------------------------------------------------
    const r2 = await reverseTransferStockExact(nf, 'harness');
    check(r2.handled === true, '2a. segundo estorno: handled (nada a fazer)');
    check(await saldo(origem) === 2296, '2b. origem NAO dobrou', await saldo(origem));
    check(await saldo(destino) === 0, '2c. destino NAO ficou negativo', await saldo(destino));
    check(r2.undone.length === 0, '2d. nenhum movimento novo', r2.undone);
  }

  // ---- 3. card de transferencia SEM baixa nenhuma (regressao) ----------------
  {
    await criarCard('c3');
    const r = await reverseTransferStockExact({ id: 'nf-c3', invoiceNumber: 1003, salesCardId: 'sc-harness-c3' }, 'harness');
    check(r.handled === false, '3a. sem baixa: handled=false (deixa o generico assumir)', r);
    check(r.warnings.some((w) => w.includes('nenhuma baixa')), '3b. avisa que nao achou baixa', r.warnings);
  }

  // ---- 4. baixa gravada com source_id da NF (rota /emit) ---------------------
  {
    const card = await criarCard('c4');
    const nfId = 'nf-c4';
    const origem = await criarLote(IND, 'H180926', 0);
    await mov('consume', origem, IND, 'H180926', 1992, nfId, 1992, 0); // source = NF, nao o card
    const r = await reverseTransferStockExact({ id: nfId, invoiceNumber: 1004, salesCardId: 'sc-harness-c4' }, 'harness');
    check(r.handled === true, '4a. baixa por source_id da NF: encontrada', r);
    check(await saldo(origem) === 1992, '4b. origem recebeu de volta', await saldo(origem));
    void card;
  }

  // ---- 5. transferencia SEM espelho no destino (caso real da NF 102879) ------
  {
    const card = await criarCard('c5');
    const origem = await criarLote(IND, 'H170926', 0);
    await mov('consume', origem, IND, 'H170926', 2914, card, 2914, 0);
    const r = await reverseTransferStockExact({ id: 'nf-c5', invoiceNumber: 1005, salesCardId: 'sc-harness-c5' }, 'harness');
    check(r.handled === true, '5a. handled');
    check(await saldo(origem) === 2914, '5b. origem recebeu de volta', await saldo(origem));
    check(r.warnings.some((w) => w.includes('espelho')), '5c. avisa que nao havia espelho no destino', r.warnings);
  }

  // ---- 6. NF sem sales_card_id ----------------------------------------------
  {
    const r = await reverseTransferStockExact({ id: 'nf-c6', invoiceNumber: 1006, salesCardId: null }, 'harness');
    check(r.handled === false, '6. NF sem card: handled=false', r);
  }

  // ---- 7. guarda de NF de entrada -------------------------------------------
  check(nfMovimentouEstoque({ finNFe: '4', operationType: 'entrada' }) === false, '7a. devolucao (finNFe=4) nao estorna estoque');
  check(nfMovimentouEstoque({ finNFe: '1', operationType: 'saida' }) === true, '7b. NF de saida estorna');

  // ---- 8. CFOP da devolucao --------------------------------------------------
  check(cfopDevolucao('5409').cfop === '1.409', '8a. 5409 -> 1.409');
  check(cfopDevolucao('5409').natureza === 'DEVOLUCAO DE TRANSFERENCIA', '8b. natureza de transferencia');
  check(cfopDevolucao('6102').cfop === '2.202', '8c. 6102 -> 2.202');
  check(cfopDevolucao(null).cfop === '1.202', '8d. sem CFOP: mantem o historico');

  await limpar();
  console.log(`\n${ok} verdes, ${fail} vermelhos`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
