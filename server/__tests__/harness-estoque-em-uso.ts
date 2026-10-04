// Harness do ESTOQUE EM USO NO FATURAMENTO (Flavio, 04/out/2026).
// Roda contra Postgres REAL (schema via drizzle-kit push):
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-estoque-em-uso.ts
// Nao entra no vitest (include e *.test.ts) de proposito: precisa de banco.
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { storage } from '../storage';
import {
  verificarEstoqueEmUso, baixarEstoqueEmUso, baixaVigenteDoPedido, distribuirLotes, textoLotes,
  ehBloqueioEstoque, EstoqueInsuficienteError, LinhaSemProdutoError,
} from '../estoque-em-uso';
import { deductStockForBilling } from '../billing-pipeline-routes';
import { consumeStock } from '../inventory-routes';
import { prepararEstoqueParaEmissao } from '../nfe-routes';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => {
  if (cond) { ok++; console.log('  ✓', nome); }
  else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];
const saldo = async (id: string) => Number((await q(sql`SELECT quantity FROM inventory_lots WHERE id = ${id}`))[0]?.quantity);
const nMov = async () => Number((await q(sql`SELECT count(*)::int AS n FROM inventory_movements`))[0].n);

async function lote(id: string, prod: string, inst: string, tipo: 'in_use' | 'blocked', num: string, qtd: number, diasAtras: number) {
  await db.execute(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, is_active, created_at, updated_at)
    VALUES (${id}, ${prod}, ${inst}, ${tipo}, ${num}, ${qtd.toFixed(4)}, true, now() - (${diasAtras} || ' days')::interval, now())`);
}

async function main() {
  for (const tb of ['inventory_movements', 'inventory_lots', 'billing_pipeline', 'fiscal_invoice_items', 'fiscal_invoices']) {
    await db.execute(sql.raw(`DELETE FROM ${tb}`));
  }
  await db.execute(sql`DELETE FROM products WHERE id LIKE 'e-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'e-%' OR name IN ('IND', 'SERV')`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj, is_active) VALUES
    ('e-ind', 'IND', 'Industria', 'k', 's', '11111111000191', true),
    ('e-serv', 'SERV', 'Puro Servicos', 'k', 's', '33333333000193', true)`);
  await db.execute(sql`INSERT INTO products (id, name, price, omie_instance_id) VALUES
    ('e-a', 'SUCO A 350ml', 5, 'e-ind'), ('e-b', 'SUCO B 900ml', 12, 'e-ind')`);

  // A: em uso L1=30 (mais antigo), L2=50; bloqueado B1=100.  B: em uso 10.
  await lote('e-l1', 'e-a', 'e-ind', 'in_use', 'L1', 30, 10);
  await lote('e-l2', 'e-a', 'e-ind', 'in_use', 'L2', 50, 5);
  await lote('e-b1', 'e-a', 'e-ind', 'blocked', 'B1', 100, 20);
  await lote('e-lb', 'e-b', 'e-ind', 'in_use', 'LB', 10, 3);

  console.log('\n1) Conferencia: so conta estoque em uso');
  let v = await verificarEstoqueEmUso('e-ind', [{ id: 'e-a', name: 'SUCO A', quantity: 80 }]);
  t('80 cabe (30+50 em uso)', v.valid, v);
  v = await verificarEstoqueEmUso('e-ind', [{ id: 'e-a', name: 'SUCO A', quantity: 81 }]);
  t('81 NAO cabe — bloqueado nao conta', !v.valid && v.shortages[0]?.available === 80 && v.shortages[0]?.blocked === 100, v);
  v = await verificarEstoqueEmUso('e-ind', [{ id: 'e-a', name: 'SUCO A', quantity: 50 }, { id: 'e-a', name: 'SUCO A', quantity: 40 }]);
  t('linhas repetidas somam (50+40=90 > 80)', !v.valid && v.shortages[0]?.required === 90, v);
  v = await verificarEstoqueEmUso('e-ind', [{ name: 'AVULSO', quantity: 1 }]);
  t('linha sem produto bloqueia', !v.valid && v.semProduto[0] === 'AVULSO', v);

  console.log('\n2) Baixa FIFO so de lotes em uso + texto de lote');
  let m = await baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ id: 'e-a', name: 'SUCO A', quantity: 40 }], sourceId: 'card-1', rotulo: 'T1', createdBy: 'h' });
  t('consumiu L1 30 + L2 10', m['e-a']?.length === 2 && m['e-a'][0].lotNumber === 'L1' && m['e-a'][0].quantidade === 30 && m['e-a'][1].quantidade === 10, m);
  t('L1=0, L2=40, B1 intacto 100', (await saldo('e-l1')) === 0 && (await saldo('e-l2')) === 40 && (await saldo('e-b1')) === 100);
  t('texto da NF com os 2 lotes', textoLotes(m['e-a']) === 'Lote: L1 (30) / L2 (10)', textoLotes(m['e-a']));
  t('um lote so: "Lote: X"', textoLotes([{ lotId: 'x', lotNumber: 'L9', quantidade: 5 }]) === 'Lote: L9');

  console.log('\n3) Falta de estoque: bloqueia TUDO, nada e baixado');
  const antes = await nMov();
  let err: any = null;
  try {
    await baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ id: 'e-b', name: 'SUCO B', quantity: 5 }, { id: 'e-a', name: 'SUCO A', quantity: 41 }], sourceId: 'card-2', rotulo: 'T2', createdBy: 'h' });
  } catch (e) { err = e; }
  t('lanca EstoqueInsuficienteError', err instanceof EstoqueInsuficienteError && ehBloqueioEstoque(err), err?.message);
  t('falta cita disponivel em uso 40 e bloqueado 100', err?.faltas?.[0]?.available === 40 && err?.faltas?.[0]?.blocked === 100, err?.faltas);
  t('produto B (que cabia) NAO foi baixado', (await saldo('e-lb')) === 10);
  t('nenhum movimento gravado', (await nMov()) === antes);
  err = null;
  try { await baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ name: 'X', quantity: 1 }], sourceId: 'c', rotulo: 'T', createdBy: null }); } catch (e) { err = e; }
  t('linha sem produto -> LinhaSemProdutoError', err instanceof LinhaSemProdutoError);

  console.log('\n4) Concorrencia: dois faturamentos disputando o mesmo saldo');
  const r = await Promise.allSettled([
    baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ id: 'e-a', name: 'SUCO A', quantity: 30 }], sourceId: 'cc-1', rotulo: 'C1', createdBy: null }),
    baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ id: 'e-a', name: 'SUCO A', quantity: 30 }], sourceId: 'cc-2', rotulo: 'C2', createdBy: null }),
  ]);
  t('um passa, o outro e bloqueado', r.filter((x) => x.status === 'fulfilled').length === 1 && r.filter((x) => x.status === 'rejected').length === 1, r.map((x) => x.status));
  t('L2 ficou com 10 (nunca negativo)', (await saldo('e-l2')) === 10);

  console.log('\n5) deductStockForBilling (pipeline): bloqueio, baixa vigente e refaturamento');
  await db.execute(sql`UPDATE inventory_lots SET quantity = 100 WHERE id = 'e-l2'`);
  const card: any = { id: 'p-1', salesCardId: 'sc-1', orderNumber: 'PED-1', omieInstanceId: 'e-ind', omieInstanceName: 'IND',
    products: [{ id: 'e-a', name: 'SUCO A', quantity: 20 }, { id: 'e-b', name: 'SUCO B', quantity: 4 }] };
  let lm = await deductStockForBilling(card, { email: 'h' });
  t('baixou A de L2 e B de LB', lm['e-a']?.[0]?.lotNumber === 'L2' && lm['e-b']?.[0]?.lotNumber === 'LB', lm);
  t('L2=80, LB=6', (await saldo('e-l2')) === 80 && (await saldo('e-lb')) === 6);
  const lm2 = await deductStockForBilling(card, { email: 'h' });
  t('refaturar NAO baixa de novo e devolve os mesmos lotes', (await saldo('e-l2')) === 80 && lm2['e-a']?.[0]?.lotNumber === 'L2' && lm2['e-a']?.[0]?.quantidade === 20, lm2);
  // NF do pedido cancelada -> estorno generico grava cancel_reversal com source = NF
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, sales_card_id, customer_name, total_invoice, environment)
    VALUES ('nf-1', 'cancelled', 'saida', 900001, '1', 'sc-1', 'X', 0, 'homologacao')`).catch(async () => {
    await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, sales_card_id, customer_name, total_invoice)
      VALUES ('nf-1', 'cancelled', 'saida', 900001, '1', 'sc-1', 'X', 0)`);
  });
  await db.execute(sql`INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, source_type, source_id, lot_number, created_at)
    VALUES ('mv-r1', 'e-l2', 'e-a', 'e-ind', 'cancel_reversal', 20, 'invoice', 'nf-1', 'L2', now()),
           ('mv-r2', 'e-lb', 'e-b', 'e-ind', 'cancel_reversal', 4, 'invoice', 'nf-1', 'LB', now())`);
  await db.execute(sql`UPDATE inventory_lots SET quantity = quantity + 20 WHERE id = 'e-l2'`);
  await db.execute(sql`UPDATE inventory_lots SET quantity = quantity + 4 WHERE id = 'e-lb'`);
  t('apos estorno da NF, baixa NAO e mais vigente', (await baixaVigenteDoPedido(card)) === null);
  lm = await deductStockForBilling(card, { email: 'h' });
  t('refaturar apos cancelamento baixa de novo (L2 100 -> 80)', (await saldo('e-l2')) === 80 && (await saldo('e-lb')) === 6, lm);
  err = null;
  try { await deductStockForBilling({ ...card, id: 'p-2', salesCardId: 'sc-2', products: [{ id: 'e-b', name: 'SUCO B', quantity: 7 }] }, { email: 'h' }); } catch (e) { err = e; }
  t('pedido sem estoque em uso -> lanca bloqueio', ehBloqueioEstoque(err), err?.message);
  const serv = await deductStockForBilling({ ...card, id: 'p-3', omieInstanceId: 'e-serv', omieInstanceName: 'SERV', products: [{ id: 'e-b', name: 'SUCO B', quantity: 999 }] }, { email: 'h' });
  t('SERV continua sem controle de estoque', Object.keys(serv).length === 0);
  err = null;
  try { await deductStockForBilling({ ...card, id: 'p-4', omieInstanceId: null, omieInstanceName: null }, { email: 'h' }); } catch (e) { err = e; }
  t('pedido sem instancia -> bloqueio', ehBloqueioEstoque(err));

  console.log('\n6) Lotes por linha da NF');
  const mapa = { 'e-a': [{ lotId: 'a1', lotNumber: 'L1', quantidade: 30 }, { lotId: 'a2', lotNumber: 'L2', quantidade: 20 }] };
  const d = distribuirLotes(mapa, [{ id: 'e-a', quantity: 25 }, { id: 'e-a', quantity: 25 }]);
  t('linha 1 = L1 25', textoLotes(d[0]) === 'Lote: L1', d[0]);
  t('linha 2 = L1 5 + L2 20', textoLotes(d[1]) === 'Lote: L1 (5) / L2 (20)', d[1]);
  const d2 = distribuirLotes(mapa, [{ id: 'e-a', quantity: 20, lotId: 'a2' }]);
  t('linha que pediu lote especifico pega ele', textoLotes(d2[0]) === 'Lote: L2', d2[0]);

  console.log('\n7) consumeStock (baixa avulsa) nao usa lote bloqueado');
  const c = await consumeStock('e-b', 'e-ind', 50, 'manual', 'avulso-1', null);
  t('falta -> success=false, nada baixado', c.success === false && (await saldo('e-lb')) === 6, c);
  await db.execute(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, is_active) VALUES ('e-bb', 'e-b', 'e-ind', 'blocked', 'BB', 500, true)`);
  const c2 = await consumeStock('e-b', 'e-ind', 50, 'manual', 'avulso-2', null);
  t('com bloqueado sobrando: continua recusando', c2.success === false && (await saldo('e-bb')) === 500 && (await saldo('e-lb')) === 6, c2);

  console.log('\n8) NF manual transmitida pela tela (/emit): prepararEstoqueParaEmissao');
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, customer_name, total_invoice, omie_instance_id, fin_nfe)
    VALUES ('nf-m', 'draft', 'saida', 900002, '1', 'CLIENTE', 0, 'e-ind', '1'),
           ('nf-dev', 'draft', 'saida', 900003, '1', 'FORN', 0, 'e-ind', '4'),
           ('nf-big', 'draft', 'saida', 900004, '1', 'CLIENTE', 0, 'e-ind', '1')`);
  await db.execute(sql`INSERT INTO fiscal_invoice_items (id, invoice_id, item_number, product_id, product_name, quantity, unit_price, total_price) VALUES
    ('it-1', 'nf-m', 1, 'e-a', 'SUCO A 350ml - Lote: DIGITADO', 30, 5, 150),
    ('it-2', 'nf-dev', 1, 'e-a', 'SUCO A 350ml', 10, 5, 50),
    ('it-3', 'nf-big', 1, 'e-a', 'SUCO A 350ml', 5000, 5, 25000)`);
  const l2Antes = await saldo('e-l2');
  let p = await prepararEstoqueParaEmissao('nf-m', 'h');
  const it1: any = (await storage.getFiscalInvoiceItems('nf-m'))[0];
  t('NF manual baixou 30 do em uso', p.baixouAgora && !p.bloqueio && (await saldo('e-l2')) === l2Antes - 30, p);
  t('item regravado com o lote real (sem o digitado)', it1.productName === 'SUCO A 350ml - Lote: L2' && it1.lotNumber === 'L2', it1);
  p = await prepararEstoqueParaEmissao('nf-m', 'h');
  t('retransmitir NAO baixa de novo', !p.baixouAgora && (await saldo('e-l2')) === l2Antes - 30, p);
  p = await prepararEstoqueParaEmissao('nf-dev', 'h');
  t('devolucao (finNFe 4) nao mexe no estoque', !p.baixouAgora && !p.bloqueio && (await saldo('e-l2')) === l2Antes - 30);
  p = await prepararEstoqueParaEmissao('nf-big', 'h');
  t('NF manual sem estoque em uso -> bloqueio', !!p.bloqueio && !p.baixouAgora && (await saldo('e-l2')) === l2Antes - 30, p);
  const { estornarBaixa } = await import('../estoque-em-uso');
  const n = await estornarBaixa('nf-m', 'rejeitada', 'h');
  t('rejeicao SEFAZ: baixa devolvida ao mesmo lote', n === 1 && (await saldo('e-l2')) === l2Antes);
  p = await prepararEstoqueParaEmissao('nf-m', 'h');
  t('nova transmissao baixa de novo, nome sem lote duplicado', p.baixouAgora && (await saldo('e-l2')) === l2Antes - 30
    && (await storage.getFiscalInvoiceItems('nf-m'))[0].productName === 'SUCO A 350ml - Lote: L2');

  console.log('\n9) Transferencia: lote especifico e obrigatorio e sai EXATAMENTE dele');
  await db.execute(sql`DELETE FROM inventory_lots WHERE product_id = 'e-c'`);
  await db.execute(sql`INSERT INTO products (id, name, price, omie_instance_id) VALUES ('e-c', 'SUCO C', 5, 'e-ind') ON CONFLICT DO NOTHING`);
  await lote('e-ca', 'e-c', 'e-ind', 'in_use', 'CA', 100, 9);
  await lote('e-cb', 'e-c', 'e-ind', 'in_use', 'CB', 100, 8);
  await lote('e-cx', 'e-c', 'e-ind', 'blocked', 'CX', 100, 7);
  const trf = [{ id: 'e-c', name: 'SUCO C', quantity: 10, lotId: 'e-cb', lotNumber: 'CB' }, { id: 'e-c', name: 'SUCO C', quantity: 5 }, { id: 'e-c', name: 'SUCO C', quantity: 10, lotId: 'e-ca', lotNumber: 'CA' }];
  m = await baixarEstoqueEmUso({ instanceId: 'e-ind', products: trf, sourceId: 'trf-1', rotulo: 'TRF', createdBy: null });
  t('CB saiu 10, CA saiu 15 (10 pedidos + 5 FIFO)', (await saldo('e-cb')) === 90 && (await saldo('e-ca')) === 85, m);
  const dt = distribuirLotes(m, trf);
  t('linha CB -> CB; linha sem lote -> CA 5; linha CA -> CA', textoLotes(dt[0]) === 'Lote: CB' && textoLotes(dt[1]) === 'Lote: CA' && textoLotes(dt[2]) === 'Lote: CA', dt.map(textoLotes));
  err = null;
  try { await baixarEstoqueEmUso({ instanceId: 'e-ind', products: [{ id: 'e-c', name: 'SUCO C', quantity: 10, lotId: 'e-cx', lotNumber: 'CX' }], sourceId: 'trf-2', rotulo: 'TRF', createdBy: null }); } catch (e) { err = e; }
  t('lote pedido BLOQUEADO -> recusa (nao cai no FIFO)', ehBloqueioEstoque(err) && /lote CX/.test(err?.details || ''), err?.details);
  v = await verificarEstoqueEmUso('e-ind', [{ id: 'e-c', name: 'SUCO C', quantity: 95, lotId: 'e-cb', lotNumber: 'CB' }]);
  t('conferencia tambem barra lote especifico sem saldo', !v.valid && /lote CB/.test(v.shortages[0]?.productName || ''), v);

  console.log('\n10) Mesmo pedido, duas baixas simultaneas: so uma vale');
  const card2: any = { id: 'p-9', salesCardId: 'sc-9', orderNumber: 'PED-9', omieInstanceId: 'e-ind', omieInstanceName: 'IND', products: [{ id: 'e-c', name: 'SUCO C', quantity: 7 }] };
  const ca0 = await saldo('e-ca');
  const rr = await Promise.all([deductStockForBilling(card2, { email: 'a' }), deductStockForBilling(card2, { email: 'b' })]);
  t('saldo caiu 7 so uma vez', (await saldo('e-ca')) === ca0 - 7, { ca0, now: await saldo('e-ca') });
  t('as duas chamadas devolvem o lote', rr.every((x) => x['e-c']?.[0]?.lotNumber === 'CA'), rr);

  console.log('\n11) NF de pedido interno (sem card) retransmitida pela tela nao baixa de novo');
  const card3: any = { id: 'p-10', salesCardId: null, orderNumber: 'INT-abc', omieInstanceId: 'e-ind', omieInstanceName: 'IND', products: [{ id: 'e-c', name: 'SUCO C', quantity: 3 }] };
  await db.execute(sql`INSERT INTO billing_pipeline (id, sales_card_id, customer_id, order_number, customer_name, stage, products, omie_instance_id) VALUES ('p-10', 'sc-10', 'cli-x', 'INT-abc', 'X', 'faturado', ${JSON.stringify(card3.products)}::jsonb, 'e-ind')`).catch((e: any) => console.log('   (seed billing_pipeline)', e.message));
  await deductStockForBilling(card3, { email: 'h' });
  const ca1 = await saldo('e-ca');
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, customer_name, total_invoice, omie_instance_id, fin_nfe, notes)
    VALUES ('nf-int', 'rejected', 'saida', 900005, '1', 'X', 0, 'e-ind', '1', 'Pedido pipeline interno - INT-abc')`);
  await db.execute(sql`INSERT INTO fiscal_invoice_items (id, invoice_id, item_number, product_id, product_name, quantity, unit_price, total_price) VALUES ('it-int', 'nf-int', 1, 'e-c', 'SUCO C', 3, 5, 15)`);
  p = await prepararEstoqueParaEmissao('nf-int', 'h');
  t('nao baixou de novo e gravou o lote', !p.baixouAgora && (await saldo('e-ca')) === ca1 && (await storage.getFiscalInvoiceItems('nf-int'))[0].lotNumber === 'CA', p);

  console.log('\n12) Refaturamento apos cancelamento: NF nova so com lotes da baixa nova');
  const card4: any = { id: 'p-11', salesCardId: 'sc-11', orderNumber: 'PED-11', omieInstanceId: 'e-ind', omieInstanceName: 'IND', products: [{ id: 'e-c', name: 'SUCO C', quantity: 70 }] };
  await deductStockForBilling(card4, { email: 'h' }); // tira de CA
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, sales_card_id, customer_name, total_invoice) VALUES ('nf-11', 'cancelled', 'saida', 900006, '1', 'sc-11', 'X', 0)`);
  await new Promise((r) => setTimeout(r, 20));
  await db.execute(sql`INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, source_type, source_id, lot_number, created_at)
    VALUES ('mv-r11', 'e-cb', 'e-c', 'e-ind', 'cancel_reversal', 70, 'invoice', 'nf-11', 'CB', now())`);
  await db.execute(sql`UPDATE inventory_lots SET quantity = 0 WHERE id = 'e-ca'`);
  await db.execute(sql`UPDATE inventory_lots SET quantity = 160 WHERE id = 'e-cb'`);
  await new Promise((r) => setTimeout(r, 20));
  const lm4 = await deductStockForBilling(card4, { email: 'h' });
  t('baixa nova so com CB (o CA antigo nao volta para a NF)', lm4['e-c']?.length === 1 && lm4['e-c'][0].lotNumber === 'CB' && lm4['e-c'][0].quantidade === 70, lm4);
  const viv = await baixaVigenteDoPedido(card4);
  t('baixa vigente = so a nova', viv?.['e-c']?.length === 1 && viv['e-c'][0].lotNumber === 'CB', viv);

  console.log('\n13) Falha da SEFAZ: so estorna quando e certo que a mercadoria nao saiu');
  const { falhaSemSaidaDeMercadoria } = await import('../nfe-routes');
  t('rejeicao 225 estorna', falhaSemSaidaDeMercadoria('225'));
  t('NO_CERTIFICATE estorna', falhaSemSaidaDeMercadoria('NO_CERTIFICATE'));
  t('NETWORK_ERROR / NO_PROTOCOL / 539 / INTERNAL_ERROR NAO estornam', !['NETWORK_ERROR', 'NO_PROTOCOL', '539', '204', 'INTERNAL_ERROR', 'REJECTED', ''].some(falhaSemSaidaDeMercadoria));

  // limpeza: as instancias IND/SERV de teste colidiriam (nome unico) com os outros harnesses
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'e-%'`);
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
