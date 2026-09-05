// Harness da BAIXA DE INSUMOS na finalizacao da OP (Flavio, 05/set/2026).
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-baixa-insumos.ts
// Postgres real, Express real, authenticateUser de producao com sessao injetada.
import express from 'express';
import http from 'http';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { registerIndustriaRoutes } from '../industria-routes';
import { authenticateUser, requireRole } from '../authMiddleware';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => {
  if (cond) { ok++; console.log('  ✓', nome); }
  else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];
const qtd = async (id: string) => Number((await q(sql`SELECT quantity FROM raw_materials WHERE id=${id}`))[0]?.quantity);
const baixas = async (op: string) => (await q(sql`SELECT * FROM raw_material_movements WHERE production_order_id=${op} AND movement_type='saida_producao' AND COALESCE(notes,'') NOT LIKE '%[estornado]%'`));
const status = async (op: string) => (await q(sql`SELECT status, notes FROM production_orders WHERE id=${op}`))[0];

async function main() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS production_orders (
    id varchar PRIMARY KEY, order_number varchar, product_id varchar, product_name varchar, quantity numeric(14,3),
    instance_id varchar, instance_name varchar, status varchar, start_date timestamp, end_date timestamp, notes text,
    created_by varchar, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), production_date date,
    brix_degree numeric, ph numeric, sensory_analysis varchar, lot_expiry_date varchar, lot_number varchar,
    pasteurization_start_time varchar, pasteurization_end_time varchar, pasteurization_start_temp numeric, pasteurization_end_temp numeric)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS production_order_items (id varchar PRIMARY KEY, production_order_id varchar, raw_material_id varchar, raw_material_name varchar, quantity_used numeric, unit varchar, lot_number varchar, lot_expiry_date varchar)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_materials (id varchar PRIMARY KEY, name varchar, unit varchar, quantity numeric, unit_cost numeric, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_material_movements (id varchar PRIMARY KEY, raw_material_id varchar, movement_type varchar, quantity numeric, previous_quantity numeric, new_quantity numeric, production_order_id varchar, notes text, created_by varchar, created_at timestamp, unit_cost numeric)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS recipes (id varchar PRIMARY KEY, name varchar, product_name varchar, product_id varchar, is_active boolean DEFAULT true, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS recipe_items (id varchar PRIMARY KEY, recipe_id varchar, raw_material_id varchar, quantity numeric, unit varchar)`);
  for (const tb of ['inventory_movements', 'inventory_lots', 'production_order_items', 'production_orders', 'raw_material_movements', 'raw_materials', 'recipe_items', 'recipes']) await db.execute(sql.raw(`DELETE FROM ${tb}`));
  await db.execute(sql`DELETE FROM products WHERE id LIKE 'h-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'h-%'`);
  await db.execute(sql`DELETE FROM users WHERE id = 'h-admin'`);
  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ('h-admin', 'harness@honest.test', 'Harness', 'Admin', 'admin', true)`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj, is_active) VALUES ('h-ind', 'IND', 'Industria', 'k', 's', '11111111000191', true)`);
  await db.execute(sql`INSERT INTO products (id, name, price) VALUES ('h-prod', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 5.40)`);
  await db.execute(sql`INSERT INTO raw_materials (id, name, unit, quantity, unit_cost) VALUES ('mp-polpa', 'POLPA MARACUJA', 'kg', 100, 10), ('mp-acucar', 'ACUCAR', 'kg', 50, 4), ('mp-garrafa', 'GARRAFA 350', 'un', 1000, 0.5)`);
  await db.execute(sql`INSERT INTO recipes (id, name, product_name, product_id) VALUES ('rec-1', 'Maracuja 350', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 'h-prod')`);
  await db.execute(sql`INSERT INTO recipe_items (id, recipe_id, raw_material_id, quantity, unit) VALUES ('ri-1','rec-1','mp-polpa',0.1,'kg'),('ri-2','rec-1','mp-garrafa',1,'un')`);
  const mkOp = async (id: string, num: string, items: Array<[string, number]> = []) => {
    await db.execute(sql`INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, production_date) VALUES (${id}, ${num}, 'h-prod', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 100, 'h-ind', 'IND', 'em_producao', current_date)`);
    for (const [rm, qt] of items) await db.execute(sql`INSERT INTO production_order_items (id, production_order_id, raw_material_id, quantity_used) VALUES (gen_random_uuid()::varchar, ${id}, ${rm}, ${qt})`);
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 'h-admin', userEmail: 'harness@honest.test' }; next(); });
  app.use('/api/industria', authenticateUser, requireRole(['admin']));
  registerIndustriaRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const base = { quantity_produced: 100, lot_number: 'H050926', lot_expiry_date: '2027-03-05' };

  try {
    console.log('\n1) Finalizacao normal: baixa pelo que a tela mandou');
    await mkOp('op1', 'OP-1');
    let r = await call('POST', '/api/industria/production-orders/op1/finalize', { ...base, materials: [{ raw_material_id: 'mp-polpa', quantity_used: 10 }, { raw_material_id: 'mp-garrafa', quantity_used: 100 }] });
    t('200', r.status === 200, r.json);
    t('2 insumos baixados (origem tela)', r.json?.consumed?.length === 2 && r.json?.origemInsumos === 'tela', r.json);
    t('polpa 100 -> 90', (await qtd('mp-polpa')) === 90);
    t('garrafa 1000 -> 900', (await qtd('mp-garrafa')) === 900);
    t('2 movimentos saida_producao', (await baixas('op1')).length === 2);
    t('CMV 150 (10*10 + 100*0.5)', r.json?.cmv?.total === 150);
    const lot = (await q(sql`SELECT * FROM inventory_lots WHERE production_order_id='op1'`))[0];
    t('lote criado na IND com CMV 1.5', lot && lot.instance_id === 'h-ind' && Number(lot.unit_cost) === 1.5 && Number(lot.quantity) === 100, lot);
    t('movimento replenish do lote', (await q(sql`SELECT * FROM inventory_movements WHERE source_type='order' AND source_id='op1'`)).length === 1);
    t('notes registra a baixa', /Baixa de insumos: 2 item/.test((await status('op1')).notes));

    console.log('\n2) Tela manda materials vazio, mas a OP tem itens: baixa pelos itens');
    await mkOp('op2', 'OP-2', [['mp-polpa', 5], ['mp-acucar', 2]]);
    r = await call('POST', '/api/industria/production-orders/op2/finalize', { ...base, materials: [] });
    t('200', r.status === 200, r.json);
    t('origem itens_da_op, 2 insumos', r.json?.origemInsumos === 'itens_da_op' && r.json?.consumed?.length === 2, r.json);
    t('polpa 90 -> 85', (await qtd('mp-polpa')) === 85);
    t('acucar 50 -> 48', (await qtd('mp-acucar')) === 48);

    console.log('\n3) Sem insumo nenhum e sem confirmacao: 400, ordem continua aberta');
    await mkOp('op3', 'OP-3');
    r = await call('POST', '/api/industria/production-orders/op3/finalize', { ...base });
    t('400 SEM_INSUMOS', r.status === 400 && r.json?.code === 'SEM_INSUMOS', r.json);
    t('ordem segue em_producao', (await status('op3')).status === 'em_producao');
    t('nenhum lote criado', (await q(sql`SELECT * FROM inventory_lots WHERE production_order_id='op3'`)).length === 0);

    console.log('\n4) Com confirmacao explicita: finaliza sem baixa e deixa registrado');
    r = await call('POST', '/api/industria/production-orders/op3/finalize', { ...base, confirm_sem_insumos: true });
    t('200', r.status === 200, r.json);
    t('0 insumos, aviso', r.json?.consumed?.length === 0 && (r.json?.warnings || []).some((w: string) => /SEM baixa/.test(w)), r.json);
    t('notes: SEM BAIXA DE INSUMOS (confirmado por ...)', /SEM BAIXA DE INSUMOS \(confirmado por harness@honest.test\)/.test((await status('op3')).notes), await status('op3'));
    t('lote criado sem CMV', Number((await q(sql`SELECT * FROM inventory_lots WHERE production_order_id='op3'`))[0]?.unit_cost ?? 0) === 0);

    console.log('\n5) Material inexistente: 400 e NADA gravado (rollback)');
    await mkOp('op4', 'OP-4');
    const polpaAntes = await qtd('mp-polpa');
    r = await call('POST', '/api/industria/production-orders/op4/finalize', { ...base, materials: [{ raw_material_id: 'mp-polpa', quantity_used: 1 }, { raw_material_id: 'mp-que-nao-existe', quantity_used: 3 }] });
    t('400 MATERIAL_INEXISTENTE', r.status === 400 && r.json?.code === 'MATERIAL_INEXISTENTE', r.json);
    t('ordem NAO finalizou', (await status('op4')).status === 'em_producao');
    t('polpa intacta (rollback da linha valida)', (await qtd('mp-polpa')) === polpaAntes);
    t('sem movimentos', (await baixas('op4')).length === 0);
    t('sem lote', (await q(sql`SELECT * FROM inventory_lots WHERE production_order_id='op4'`)).length === 0);
    t('clique duplo: segunda finalizacao da op1 -> 400', (await call('POST', '/api/industria/production-orders/op1/finalize', { ...base, materials: [{ raw_material_id: 'mp-polpa', quantity_used: 1 }] })).status === 400);

    console.log('\n6) Auditoria: acha a OP finalizada sem baixa (e um caso antigo com itens)');
    // caso antigo: finalizada "na mao" com itens mas sem movimentos (o bug de antes)
    await db.execute(sql`INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, production_date, end_date, lot_number) VALUES ('op5', 'OP-5', 'h-prod', 'SUCO MISTO DE FRUTA - MARACUJA 350ml', 200, 'h-ind', 'IND', 'finalizada', current_date, now(), 'H999')`);
    await db.execute(sql`INSERT INTO production_order_items (id, production_order_id, raw_material_id, quantity_used) VALUES ('it5', 'op5', 'mp-acucar', 7)`);
    await db.execute(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, production_order_id) VALUES ('lot5', 'h-prod', 'h-ind', 'in_use', 'H999', 200, 'op5')`);
    r = await call('GET', '/api/industria/production-orders/auditoria-baixa');
    t('200', r.status === 200, r.json);
    const ids = (r.json?.orders || []).map((o: any) => o.id).sort();
    t('lista op3 e op5 (nao op1/op2/op4)', JSON.stringify(ids) === JSON.stringify(['op3', 'op5']), ids);
    const a3 = r.json.orders.find((o: any) => o.id === 'op3'); const a5 = r.json.orders.find((o: any) => o.id === 'op5');
    t('op3: confirmada, fonte receita (0.1*100 polpa, 1*100 garrafa)', a3?.confirmada_sem_baixa === true && a3?.fonte === 'receita' && a3.previa.length === 2 && a3.previa.find((p: any) => p.raw_material_id === 'mp-polpa')?.quantity_used === 10, a3);
    t('op5: fonte itens_da_op (acucar 7)', a5?.fonte === 'itens_da_op' && a5.previa[0]?.quantity_used === 7 && a5.previa[0]?.name === 'ACUCAR', a5);

    console.log('\n7) Reparo: baixa retroativa pelos itens (op5) e pela receita (op3); idempotente');
    r = await call('POST', '/api/industria/production-orders/op5/baixar-insumos', {});
    t('op5 200, fonte itens_da_op', r.status === 200 && r.json?.fonte === 'itens_da_op', r.json);
    t('acucar 48 -> 41', (await qtd('mp-acucar')) === 41);
    t('movimento aponta para op5 com nota de reparo', (await baixas('op5')).length === 1 && /retroativa/.test((await baixas('op5'))[0].notes));
    t('CMV preenchido no lote (7*4/200 = 0.14)', Number((await q(sql`SELECT unit_cost FROM inventory_lots WHERE id='lot5'`))[0].unit_cost) === 0.14);
    r = await call('POST', '/api/industria/production-orders/op5/baixar-insumos', {});
    t('segundo reparo -> 409', r.status === 409, r.json);
    t('acucar segue 41', (await qtd('mp-acucar')) === 41);
    r = await call('POST', '/api/industria/production-orders/op3/baixar-insumos', {});
    t('op3 200, fonte receita', r.status === 200 && r.json?.fonte === 'receita' && r.json?.consumed?.length === 2, r.json);
    t('polpa 85 -> 75, garrafa 900 -> 800', (await qtd('mp-polpa')) === 75 && (await qtd('mp-garrafa')) === 800);
    t('CMV no lote da op3 (10*10+100*0.5)/100 = 1.5', Number((await q(sql`SELECT unit_cost FROM inventory_lots WHERE production_order_id='op3'`))[0].unit_cost) === 1.5);
    r = await call('GET', '/api/industria/production-orders/auditoria-baixa');
    t('auditoria zerada', r.json?.total === 0, r.json);
    t('reparo em OP aberta -> 400', (await call('POST', '/api/industria/production-orders/op4/baixar-insumos', {})).status === 400);

    console.log('\n8) Reabrir a op5 estorna a baixa retroativa (mesmo mecanismo)');
    r = await call('POST', '/api/industria/production-orders/op5/reopen');
    t('reopen 200', r.status === 200, r.json);
    t('acucar volta a 48', (await qtd('mp-acucar')) === 48);
  } finally { server.close(); }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
