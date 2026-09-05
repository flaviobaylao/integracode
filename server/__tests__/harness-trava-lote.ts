// Harness da TRAVA DE LOTE EM NF DE TRANSFERENCIA (Flavio, 05/set/2026).
// Roda contra Postgres REAL (schema via drizzle-kit push), Express real e o
// authenticateUser de producao (sessao injetada, sem shim de role):
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-trava-lote.ts
// Nao entra no vitest (include e *.test.ts) de proposito: precisa de banco.
import express from 'express';
import http from 'http';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { storage } from '../storage';
import { registerInventoryRoutes } from '../inventory-routes';
import { registerIndustriaRoutes } from '../industria-routes';
import { authenticateUser, requireRole } from '../authMiddleware';
import { deductStockForBilling, mirrorTransferToDestination } from '../billing-pipeline-routes';
import { getTransferLocks, getProductionOrderTransferLock, reverseTransferStockExact, TRF_EST_MARK } from '../lot-lock';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => {
  if (cond) { ok++; console.log('  ✓', nome); }
  else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
};
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];

async function main() {
  // ---------------------------------------------------------------- tabelas do 1.0 (sincronizadas, sem drizzle)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS production_orders (
    id varchar PRIMARY KEY, order_number varchar, product_id varchar, product_name varchar, quantity numeric(14,3),
    instance_id varchar, instance_name varchar, status varchar, start_date timestamp, end_date timestamp, notes text,
    created_by varchar, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), production_date date,
    brix_degree numeric, ph numeric, sensory_analysis varchar, lot_expiry_date varchar, lot_number varchar,
    pasteurization_start_time varchar, pasteurization_end_time varchar, pasteurization_start_temp numeric, pasteurization_end_temp numeric)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS production_order_items (
    id varchar PRIMARY KEY, production_order_id varchar, raw_material_id varchar, raw_material_name varchar,
    quantity_used numeric, unit varchar, lot_number varchar, lot_expiry_date varchar)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_materials (id varchar PRIMARY KEY, name varchar, unit varchar, quantity numeric, unit_cost numeric, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_material_movements (id varchar PRIMARY KEY, raw_material_id varchar, movement_type varchar,
    quantity numeric, previous_quantity numeric, new_quantity numeric, production_order_id varchar, notes text, created_by varchar, created_at timestamp, unit_cost numeric)`);
  await db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'lixeira'`);

  // ---------------------------------------------------------------- limpeza
  for (const tb of ['inventory_movements', 'inventory_lots', 'billing_pipeline', 'fiscal_invoice_items', 'fiscal_invoices', 'production_order_items', 'production_orders', 'raw_material_movements', 'raw_materials']) {
    await db.execute(sql.raw(`DELETE FROM ${tb}`));
  }
  await db.execute(sql`DELETE FROM customers WHERE id LIKE 'h-%'`);
  await db.execute(sql`DELETE FROM products WHERE id LIKE 'h-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'h-%'`);
  await db.execute(sql`DELETE FROM users WHERE id = 'h-admin'`);

  // ---------------------------------------------------------------- seed
  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ('h-admin', 'harness@honest.test', 'Harness', 'Admin', 'admin', true)`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj, is_active) VALUES
    ('h-ind', 'IND', 'Industria', 'k', 's', '11111111000191', true),
    ('h-gyn', 'GYN', 'Goiania', 'k', 's', '22222222000192', true)`);
  await db.execute(sql`INSERT INTO products (id, name, price, omie_instance_id) VALUES ('h-prod', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 5.40, 'h-ind')`);
  await db.execute(sql`INSERT INTO customers (id, name, customer_type, phone, address, seller_id, weekdays, cnpj) VALUES
    ('h-cli-gyn', 'HONEST FILIAL GYN', 'pessoa_juridica', '62', 'Rua X', 'h-admin', 'seg', '22222222000192')`);
  await db.execute(sql`INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, end_date, notes, production_date, lot_number)
    VALUES ('h-op1', 'OP-90001', 'h-prod', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 1000, 'h-ind', 'IND', 'finalizada', now(), 'harness', current_date, 'H050926')`);
  const lot = await storage.createInventoryLot({
    productId: 'h-prod', instanceId: 'h-ind', stockType: 'in_use', lotNumber: 'H050926', quantity: '1000', minQuantity: '0',
    unitCost: '0.4113', totalCost: '411.30', productionOrderId: 'h-op1', notes: 'Produzido via OP-90001',
  } as any);
  await storage.createInventoryMovement({ lotId: lot.id, productId: 'h-prod', instanceId: 'h-ind', movementType: 'replenish', quantity: '1000',
    previousQuantity: '0', newQuantity: '1000', sourceType: 'order', sourceId: 'h-op1', lotNumber: 'H050926', notes: 'Entrada por finalizacao da OP-90001', createdBy: 'h-admin' } as any);

  // ---------------------------------------------------------------- app express real
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 'h-admin', userEmail: 'harness@honest.test' }; next(); });
  app.use('/api/industria', authenticateUser, requireRole(['admin']));
  registerInventoryRoutes(app);
  registerIndustriaRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  await new Promise((r) => setTimeout(r, 300)); // ensureCmvLoteColumns em background

  try {
    console.log('\n1) Lote recem-produzido: livre');
    let r = await call('GET', '/api/inventory/summary');
    t('summary responde 200', r.status === 200, r.json);
    let row = (r.json?.lots || []).find((l: any) => l.id === lot.id);
    t('sem transferLock', row && row.transferLock === null, row);
    t('lotesTravados = 0', r.json?.lotesTravados === 0);
    r = await call('PUT', `/api/inventory/lots/${lot.id}`, { notes: 'obs livre' });
    t('PUT do lote livre passa (200)', r.status === 200, r.json);
    r = await call('GET', '/api/industria/production-orders');
    t('OP sem transfer_lock', (r.json?.orders || [])[0]?.transfer_lock === null, r.json);

    console.log('\n2) Pedido de transferencia criado (sem NF ainda): trava "aguardando faturamento"');
    r = await call('POST', '/api/inventory/transfer-order', { lots: [{ lotId: lot.id, quantity: 600 }], destinationInstanceId: 'h-gyn', customerId: 'h-cli-gyn' });
    t('transfer-order 201', r.status === 201, r.json);
    const item = r.json?.item;
    t('card em a_faturar, transferencia', item?.stage === 'a_faturar' && item?.operationType === 'transferencia');
    r = await call('GET', '/api/inventory/summary');
    row = (r.json?.lots || []).find((l: any) => l.id === lot.id);
    t('summary: transferLock presente', !!row?.transferLock, row);
    t('summary: motivo cita a Lixeira (sem NF)', /Lixeira/.test(row?.transferLock?.reason || ''), row?.transferLock);
    t('summary: orderNumber TRF-', /^TRF-/.test(row?.transferLock?.orderNumber || ''));
    t('lotesTravados = 1', r.json?.lotesTravados === 1);
    r = await call('GET', '/api/inventory/lots');
    t('GET /lots tambem traz transferLock', !!(r.json || []).find((l: any) => l.id === lot.id)?.transferLock);
    r = await call('PUT', `/api/inventory/lots/${lot.id}`, { quantity: '5' });
    t('PUT do lote travado -> 409', r.status === 409, r.json);
    t('409 explica o motivo', /travado/.test(r.json?.message || '') && !!r.json?.transferLock);
    r = await call('DELETE', `/api/inventory/lots/${lot.id}`);
    t('DELETE do lote travado -> 409', r.status === 409, r.json);
    t('quantidade do lote intacta (1000)', Number((await storage.getInventoryLot(lot.id))?.quantity) === 1000);
    r = await call('POST', '/api/industria/production-orders/h-op1/reopen');
    t('reabrir OP travada -> 409', r.status === 409, r.json);
    t('409 da OP traz transfer_lock', !!r.json?.transfer_lock);
    r = await call('DELETE', '/api/industria/production-orders/h-op1');
    t('excluir OP travada -> 409', r.status === 409, r.json);
    t('OP continua finalizada', (await q(sql`SELECT status FROM production_orders WHERE id='h-op1'`))[0]?.status === 'finalizada');
    r = await call('GET', '/api/industria/production-orders');
    t('listagem de OP traz transfer_lock', !!(r.json?.orders || [])[0]?.transfer_lock, r.json);

    console.log('\n3) Pedido vai para a Lixeira antes da NF: trava cai (nada a estornar)');
    await db.execute(sql`UPDATE billing_pipeline SET stage='lixeira' WHERE id=${item.id}`);
    r = await call('GET', '/api/inventory/summary');
    row = (r.json?.lots || []).find((l: any) => l.id === lot.id);
    t('sem transferLock', row?.transferLock === null, row?.transferLock);
    r = await call('PUT', `/api/inventory/lots/${lot.id}`, { notes: 'liberado' });
    t('PUT volta a passar', r.status === 200, r.json);
    t('OP destravada', (await getProductionOrderTransferLock('h-op1')) === null);

    console.log('\n4) Pedido restaurado e FATURADO (baixa lote exato + espelho GYN + NF autorizada)');
    await db.execute(sql`UPDATE billing_pipeline SET stage='a_faturar' WHERE id=${item.id}`);
    const card: any = await storage.getBillingPipelineItem(item.id);
    const lotMap = await deductStockForBilling(card, { email: 'harness@honest.test' });
    await mirrorTransferToDestination(card, { email: 'harness@honest.test' });
    await db.execute(sql`UPDATE billing_pipeline SET stage='faturado' WHERE id=${item.id}`);
    const inv: any = await storage.createFiscalInvoice({
      status: 'authorized', operationType: 'saida', invoiceNumber: 104500, series: '1', salesCardId: card.salesCardId,
      customerId: 'h-cli-gyn', customerName: 'HONEST FILIAL GYN', omieInstanceId: 'h-ind', totalInvoice: '246.78', finNFe: '1',
    } as any);
    t('baixa saiu do lote exato', (lotMap['h-prod'] || [])[0] === 'H050926', lotMap);
    t('origem ficou com 400', Number((await storage.getInventoryLot(lot.id))?.quantity) === 400);
    const espelho = (await storage.getInventoryLots({ productId: 'h-prod', instanceId: 'h-gyn', isActive: true }))[0];
    t('espelho GYN criado com 600 e CMV', espelho && Number(espelho.quantity) === 600 && Number((espelho as any).unitCost) === 0.4113, espelho);
    r = await call('GET', '/api/inventory/summary');
    row = (r.json?.lots || []).find((l: any) => l.id === lot.id);
    t('trava com NF: invoiceNumber 104500', row?.transferLock?.invoiceNumber === 104500, row?.transferLock);
    t('motivo cita CANCELAMENTO/DEVOLUCAO', /CANCELAMENTO/.test(row?.transferLock?.reason || ''));
    const esp = (r.json?.lots || []).find((l: any) => l.id === espelho.id);
    t('espelho na GYN NAO e travado (estoque normal da filial)', esp && esp.transferLock === null, esp?.transferLock);
    r = await call('POST', '/api/industria/production-orders/h-op1/reopen');
    t('reabrir OP com NF -> 409', r.status === 409, r.json);
    await db.execute(sql`UPDATE billing_pipeline SET stage='lixeira' WHERE id=${item.id}`);
    t('card na Lixeira mas NF viva: CONTINUA travado', !!(await getTransferLocks([lot.id])).get(lot.id));
    await db.execute(sql`UPDATE billing_pipeline SET stage='faturado' WHERE id=${item.id}`);
    // Devolucao (fin_nfe=4) apontando para o mesmo card nao pode confundir a trava
    await storage.createFiscalInvoice({ status: 'draft', operationType: 'devolucao', salesCardId: card.salesCardId, customerId: 'h-cli-gyn', customerName: 'x', totalInvoice: '0', finNFe: '4' } as any);
    t('NF de devolucao (fin_nfe=4) rascunho nao altera a trava', (await getTransferLocks([lot.id])).get(lot.id)?.invoiceNumber === 104500);

    console.log('\n5) CANCELAMENTO da NF: estorno exato (origem +600, espelho -600) e trava cai');
    const invDb: any = await storage.getFiscalInvoice(inv.id);
    let est = await reverseTransferStockExact(invDb, 'harness@honest.test');
    t('estorno tratado como transferencia', est.handled === true, est);
    t('2 movimentos desfeitos', est.undone.length === 2, est);
    t('origem voltou a 1000', Number((await storage.getInventoryLot(lot.id))?.quantity) === 1000);
    const esp2: any = await storage.getInventoryLot(espelho.id);
    t('espelho GYN zerado e inativo', Number(esp2.quantity) === 0 && esp2.isActive === false, esp2);
    const revs = await q(sql`SELECT * FROM inventory_movements WHERE movement_type='cancel_reversal' AND source_id=${inv.id}`);
    t('2 movimentos cancel_reversal com source = NF', revs.length === 2);
    t('sinais: +600 origem / -600 destino', revs.some((m: any) => Number(m.quantity) === 600) && revs.some((m: any) => Number(m.quantity) === -600), revs.map((m: any) => m.quantity));
    const marcados = await q(sql`SELECT count(*)::int n FROM inventory_movements WHERE source_type='invoice' AND source_id=${item.id} AND notes LIKE ${'%' + TRF_EST_MARK + '%'}`);
    t('movimentos originais marcados como estornados', marcados[0]?.n === 2);
    est = await reverseTransferStockExact(invDb, 'harness@honest.test');
    t('IDEMPOTENTE: segundo estorno nao desfaz nada', est.handled && est.undone.length === 0, est);
    t('origem segue 1000 (nao dobrou)', Number((await storage.getInventoryLot(lot.id))?.quantity) === 1000);
    t('antes de mudar o status, ainda travado', !!(await getTransferLocks([lot.id])).get(lot.id));
    await storage.updateFiscalInvoice(inv.id, { status: 'cancelled' } as any);
    t('NF cancelada: trava caiu', (await getTransferLocks([lot.id])).get(lot.id) === undefined);
    r = await call('GET', '/api/inventory/summary');
    t('summary lotesTravados = 0', r.json?.lotesTravados === 0);

    console.log('\n6) SO AGORA a OP pode ser alterada: reabrir estorna o lote (1000 -> 0)');
    r = await call('POST', '/api/industria/production-orders/h-op1/reopen');
    t('reabrir OP -> 200', r.status === 200, r.json);
    t('OP em_producao', r.json?.order?.status === 'em_producao');
    t('lote da OP baixado pela reabertura', Number((await storage.getInventoryLot(lot.id))?.quantity) === 0);

    console.log('\n7) DEVOLUCAO (status returned) tambem libera; venda comum nunca trava');
    const lot2 = await storage.createInventoryLot({ productId: 'h-prod', instanceId: 'h-ind', stockType: 'in_use', lotNumber: 'H060926', quantity: '100', minQuantity: '0', unitCost: '0.5', totalCost: '50', productionOrderId: 'h-op1' } as any);
    r = await call('POST', '/api/inventory/transfer-order', { lots: [{ lotId: lot2.id, quantity: 10 }], destinationInstanceId: 'h-gyn', customerId: 'h-cli-gyn' });
    const item2 = r.json?.item;
    const inv2: any = await storage.createFiscalInvoice({ status: 'authorized', operationType: 'saida', invoiceNumber: 104501, series: '1', salesCardId: item2.salesCardId, customerId: 'h-cli-gyn', customerName: 'x', omieInstanceId: 'h-ind', totalInvoice: '5', finNFe: '1' } as any);
    t('lote 2 travado pela NF 104501', (await getTransferLocks([lot2.id])).get(lot2.id)?.invoiceNumber === 104501);
    await storage.updateFiscalInvoice(inv2.id, { status: 'returned' } as any);
    t('NF devolvida: trava caiu', (await getTransferLocks([lot2.id])).get(lot2.id) === undefined);
    await storage.createBillingPipelineItem({ salesCardId: 'h-sc-venda', customerId: 'h-cli-gyn', customerName: 'x', stage: 'a_faturar', operationType: 'venda',
      products: [{ id: 'h-prod', name: 'x', quantity: 5, unitPrice: 5, totalPrice: 25, lotId: lot2.id, lotNumber: 'H060926' }] as any, omieInstanceId: 'h-ind' } as any);
    t('pedido de VENDA com lotId nao trava', (await getTransferLocks([lot2.id])).get(lot2.id) === undefined);
    const invVenda: any = await storage.createFiscalInvoice({ status: 'authorized', operationType: 'saida', invoiceNumber: 104502, series: '1', salesCardId: 'h-sc-venda', customerId: 'h-cli-gyn', customerName: 'x', totalInvoice: '25', finNFe: '1' } as any);
    est = await reverseTransferStockExact(await storage.getFiscalInvoice(invVenda.id), null);
    t('estorno exato ignora NF de venda (handled=false -> caminho generico)', est.handled === false);
    t('getTransferLocks([]) responde vazio sem query', (await getTransferLocks([])).size === 0);
  } finally {
    server.close();
  }

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
