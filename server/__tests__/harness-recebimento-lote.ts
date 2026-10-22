// Harness do RECEBIMENTO DE TRANSFERENCIA COM CONFERENCIA (Flavio, 22/out/2026).
// Roda contra Postgres REAL (schema via drizzle-kit push):
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-recebimento-lote.ts
// Nao entra no vitest (include e *.test.ts) de proposito: precisa de banco.
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { baixarEstoqueEmUso, espelharTransferenciaPelosMovimentos, ehBloqueioEstoque } from '../estoque-em-uso';
import { receberLote, podeReceberLote, moverTipoLote, ensureRecebimentoLoteSchema, TITULO_DIVERGENCIA_RECEBIMENTO } from '../recebimento-lote';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => {
  if (cond) { ok++; console.log('  ✓', nome); }
  else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
};
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];

async function main() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS production_orders (
    id varchar PRIMARY KEY, order_number varchar, product_id varchar, product_name varchar, quantity numeric(14,3),
    instance_id varchar, instance_name varchar, status varchar, start_date timestamp, end_date timestamp, notes text,
    created_by varchar, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), production_date date,
    brix_degree numeric, ph numeric, sensory_analysis varchar, lot_expiry_date varchar, lot_number varchar,
    pasteurization_start_time varchar, pasteurization_end_time varchar, pasteurization_start_temp numeric, pasteurization_end_temp numeric)`);
  const { ensureTables: _ } = {} as any;
  await ensureRecebimentoLoteSchema();
  // chamados: tabelas sob demanda
  const { abrirChamadoSistema } = await import('../chamados-routes');
  void abrirChamadoSistema;

  for (const tb of ['inventory_movements', 'inventory_lots', 'billing_pipeline', 'fiscal_invoice_items', 'fiscal_invoices', 'production_orders', 'lote_recebimentos']) {
    await db.execute(sql.raw(`DELETE FROM ${tb}`));
  }
  await db.execute(sql`DELETE FROM system_settings WHERE key IN ('estoque_promover_bloqueado','recebimento_lote_extra','recebimento_lote_destinos','chamados_destinos','chamados_whatsapp')`);
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('chamados_whatsapp', 'off', 'harness')`);
  for (const tb of ['chamados', 'chamado_mensagens', 'chamado_consultas', 'chamado_leituras']) {
    try { await db.execute(sql.raw(`DELETE FROM ${tb}`)); } catch { /* ainda nao existe */ }
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM customers WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM products WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'r-%'`);

  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES
    ('r-flavio', 'flavio@bebahonest.com.br', 'Flavio', 'Baylao', 'admin', true),
    ('r-lanucy', 'lanucy@bebahonest.com.br', 'Lanucy', 'Silva', 'administrative', true),
    ('r-robson', 'robson@bebahonest.com.br', 'Robson', 'Tele', 'telemarketing', true),
    ('r-naiara', 'industria@bebahonest.com.br', 'Naiara', 'Gomes', 'industria', true),
    ('r-vend', 'vend@bebahonest.com.br', 'Zé', 'Vendedor', 'vendedor', true)`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj, is_active) VALUES
    ('r-ind', 'IND', 'Industria', 'k', 's', '11111111000191', true),
    ('r-gyn', 'GYN', 'Goiania', 'k', 's', '22222222000192', true)`);
  await db.execute(sql`INSERT INTO products (id, name, price, omie_instance_id) VALUES ('r-prod', 'SUCO MISTO - UVA 350ml', 5.40, 'r-ind')`);
  await db.execute(sql`INSERT INTO customers (id, name, customer_type, phone, address, seller_id, weekdays, cnpj) VALUES
    ('r-cli-gyn', 'HONEST FILIAL GYN', 'pessoa_juridica', '62', 'Rua X', 'r-flavio', 'seg', '22222222000192')`);
  await db.execute(sql`INSERT INTO production_orders (id, order_number, product_id, product_name, quantity, instance_id, instance_name, status, end_date, production_date, lot_number)
    VALUES ('r-op1', 'OP-1', 'r-prod', 'SUCO MISTO - UVA 350ml', 100, 'r-ind', 'IND', 'finalizada', now(), current_date, 'H221026')`);
  await db.execute(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, unit_cost, production_order_id, is_active, created_at)
    VALUES ('r-l-ind', 'r-prod', 'r-ind', 'in_use', 'H221026', 100, 0.9, 'r-op1', true, now() - interval '2 days')`);
  await db.execute(sql`INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_at)
    VALUES ('r-m-op', 'r-l-ind', 'r-prod', 'r-ind', 'replenish', 100, 0, 100, 'order', 'r-op1', 'H221026', 'Producao OP-1', now() - interval '2 days')`);

  console.log('\n1) Permissoes de recebimento');
  const flavio = (await q(sql`SELECT * FROM users WHERE id = 'r-flavio'`))[0];
  const lanucy = (await q(sql`SELECT * FROM users WHERE id = 'r-lanucy'`))[0];
  const robson = (await q(sql`SELECT * FROM users WHERE id = 'r-robson'`))[0];
  const naiara = (await q(sql`SELECT * FROM users WHERE id = 'r-naiara'`))[0];
  const vend = (await q(sql`SELECT * FROM users WHERE id = 'r-vend'`))[0];
  const u = (r: any) => ({ id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, role: r.role });
  t('Flavio (admin) pode', await podeReceberLote(u(flavio)));
  t('Lanucy pode (destino lanucy)', await podeReceberLote(u(lanucy)));
  t('Robson pode (extra por nome)', await podeReceberLote(u(robson)));
  t('Naiara NAO pode', !(await podeReceberLote(u(naiara))));
  t('vendedor NAO pode', !(await podeReceberLote(u(vend))));

  console.log('\n2) Transferencia IND -> GYN: entra bloqueada e NAO sai no faturamento');
  await db.execute(sql`INSERT INTO billing_pipeline (id, sales_card_id, customer_id, customer_name, customer_document, order_number, operation_type, omie_instance_id, omie_instance_name, stage, products)
    VALUES ('r-card-trf', 'r-sc-trf', 'r-cli-gyn', 'HONEST FILIAL GYN', '22222222000192', 'TRF-1', 'transferencia', 'r-ind', 'IND', 'faturado',
            '[{"id":"r-prod","name":"SUCO MISTO - UVA 350ml","quantity":40,"transferToInstanceId":"r-gyn"}]'::jsonb)`);
  await baixarEstoqueEmUso({ instanceId: 'r-ind', products: [{ id: 'r-prod', name: 'SUCO MISTO - UVA 350ml', quantity: 40 }], sourceId: 'r-card-trf', rotulo: 'TRF-1', createdBy: 'harness' });
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, customer_name, total_invoice, omie_instance_id, sales_card_id, cfop, nature_of_operation, environment, issuer_cnpj, fin_nfe)
    VALUES ('r-nf-trf', 'authorized', 'saida', 5001, '1', 'HONEST FILIAL GYN', 36, 'r-ind', 'r-sc-trf', '5151', 'Transferencia', 'producao', '11111111000191', '1')`);
  await db.execute(sql`INSERT INTO fiscal_invoice_items (id, invoice_id, item_number, product_id, product_name, quantity, unit_price, total_price, lot_number, cfop)
    VALUES ('r-nfi-trf', 'r-nf-trf', 1, 'r-prod', 'SUCO MISTO - UVA 350ml - Lote: H221026', 40, 0.9, 36, 'H221026', '5151')`);
  const card = (await q(sql`SELECT * FROM billing_pipeline WHERE id = 'r-card-trf'`))[0];
  const esp = await espelharTransferenciaPelosMovimentos({ id: card.id, operationType: 'transferencia', products: card.products, customerId: card.customer_id, customerDocument: card.customer_document, omieInstanceId: 'r-ind', omieInstanceName: 'IND', orderNumber: 'TRF-1' }, { email: 'harness' });
  const bloq = (await q(sql`SELECT * FROM inventory_lots WHERE instance_id = 'r-gyn' AND stock_type = 'blocked'`))[0];
  t('GYN recebeu 40 bloqueado no lote H221026', !!bloq && Number(bloq.quantity) === 40 && bloq.lot_number === 'H221026', esp);
  let err: any = null;
  try { await baixarEstoqueEmUso({ instanceId: 'r-gyn', products: [{ id: 'r-prod', name: 'SUCO MISTO - UVA 350ml', quantity: 10 }], sourceId: 'r-ped-x', rotulo: 'PED-X', createdBy: 'harness' }); } catch (e) { err = e; }
  t('faturamento na GYN bloqueado (40 bloqueados aguardando conferencia, 0 em uso)', ehBloqueioEstoque(err) && /CONFER/i.test(String(err?.details || '')), err?.details);
  t('lote continua bloqueado', (await q(sql`SELECT stock_type FROM inventory_lots WHERE id = ${bloq.id}`))[0].stock_type === 'blocked');

  console.log('\n3) Recebimento SEM divergencia (Lanucy)');
  const r1 = await receberLote({ lotId: bloq.id, quantidadeRecebida: 40, observacao: '', user: u(lanucy) });
  t('recebimento gravado, divergencia 0, sem chamado', r1.divergencia === 0 && r1.chamadoIds.length === 0, r1);
  const emUso = (await q(sql`SELECT * FROM inventory_lots WHERE instance_id = 'r-gyn' AND stock_type = 'in_use' AND lot_number = 'H221026'`))[0];
  t('lote em uso na GYN com 40', !!emUso && Number(emUso.quantity) === 40, emUso);
  t('responsavel pelo desbloqueio carimbado no lote em uso', emUso?.desbloqueado_por === 'r-lanucy' && /Lanucy/.test(String(emUso?.desbloqueado_por_nome)) && !!emUso?.desbloqueado_em && emUso?.recebimento_id === r1.recebimentoId, emUso);
  const bloqDepois = (await q(sql`SELECT * FROM inventory_lots WHERE id = ${bloq.id}`))[0];
  t('linha bloqueada zerou e tambem leva o responsavel', Number(bloqDepois.quantity) === 0 && bloqDepois.desbloqueado_por === 'r-lanucy', bloqDepois);
  t('movimentos unblock gravados (saida + entrada)', (await q(sql`SELECT count(*)::int AS n FROM inventory_movements WHERE movement_type = 'unblock' AND lot_number = 'H221026'`))[0].n === 2);
  t('CMV do lote preservado no destino', Number(emUso.unit_cost) === 0.9, emUso.unit_cost);
  t('receber de novo -> erro (lote nao esta bloqueado / sem saldo)', await receberLote({ lotId: bloq.id, quantidadeRecebida: 1, user: u(lanucy) }).then(() => false).catch(() => true));

  console.log('\n4) Segunda transferencia e recebimento COM divergencia (Robson)');
  await db.execute(sql`INSERT INTO billing_pipeline (id, sales_card_id, customer_id, customer_name, customer_document, order_number, operation_type, omie_instance_id, omie_instance_name, stage, products)
    VALUES ('r-card-trf2', 'r-sc-trf2', 'r-cli-gyn', 'HONEST FILIAL GYN', '22222222000192', 'TRF-2', 'transferencia', 'r-ind', 'IND', 'faturado',
            '[{"id":"r-prod","name":"SUCO MISTO - UVA 350ml","quantity":30,"transferToInstanceId":"r-gyn"}]'::jsonb)`);
  await baixarEstoqueEmUso({ instanceId: 'r-ind', products: [{ id: 'r-prod', name: 'SUCO MISTO - UVA 350ml', quantity: 30 }], sourceId: 'r-card-trf2', rotulo: 'TRF-2', createdBy: 'harness' });
  await db.execute(sql`INSERT INTO fiscal_invoices (id, status, operation_type, invoice_number, series, customer_name, total_invoice, omie_instance_id, sales_card_id, cfop, nature_of_operation, environment, issuer_cnpj, fin_nfe)
    VALUES ('r-nf-trf2', 'authorized', 'saida', 5002, '1', 'HONEST FILIAL GYN', 27, 'r-ind', 'r-sc-trf2', '5151', 'Transferencia', 'producao', '11111111000191', '1')`);
  await db.execute(sql`INSERT INTO fiscal_invoice_items (id, invoice_id, item_number, product_id, product_name, quantity, unit_price, total_price, lot_number, cfop)
    VALUES ('r-nfi-trf2', 'r-nf-trf2', 1, 'r-prod', 'SUCO MISTO - UVA 350ml - Lote: H221026', 30, 0.9, 27, 'H221026', '5151')`);
  const card2 = (await q(sql`SELECT * FROM billing_pipeline WHERE id = 'r-card-trf2'`))[0];
  await espelharTransferenciaPelosMovimentos({ id: card2.id, operationType: 'transferencia', products: card2.products, customerId: card2.customer_id, customerDocument: card2.customer_document, omieInstanceId: 'r-ind', omieInstanceName: 'IND', orderNumber: 'TRF-2' }, { email: 'harness' });
  const bloq2 = (await q(sql`SELECT * FROM inventory_lots WHERE instance_id = 'r-gyn' AND stock_type = 'blocked' AND lot_number = 'H221026' AND quantity > 0`))[0];
  t('segunda entrada mesclou na linha bloqueada (30)', !!bloq2 && Number(bloq2.quantity) === 30, bloq2);
  err = null;
  try { await receberLote({ lotId: bloq2.id, quantidadeRecebida: 27, observacao: '', user: u(robson) }); } catch (e) { err = e; }
  t('divergencia sem observacao -> recusa', !!err && /observa/i.test(err.message), err?.message);
  const r2 = await receberLote({ lotId: bloq2.id, quantidadeRecebida: 27, observacao: 'Faltaram 3 unidades no fardo 2', user: u(robson) });
  t('divergencia -3 registrada', r2.divergencia === -3 && r2.faturada === 30 && r2.recebida === 27, r2);
  t('chamado(s) aberto(s) para naiara e flavio', r2.chamadoIds.length === 2, r2.chamadoIds);
  const ch = await q(sql`SELECT * FROM chamados WHERE assunto = ${TITULO_DIVERGENCIA_RECEBIMENTO} ORDER BY destino_key`);
  t('titulo DIVERGENCIA EM RECEBIMENTO, destinos flavio + naiara, autor Robson', ch.length === 2 && ch.map((c: any) => c.destino_key).join(',') === 'flavio,naiara' && ch.every((c: any) => c.autor_id === 'r-robson'), ch.map((c: any) => [c.destino_key, c.autor_nome]));
  t('corpo traz NF 5002, pedido TRF-2, faturado 30, recebido 27 e o responsavel', /NF-e 5002/.test(ch[0].descricao) && /TRF-2/.test(ch[0].descricao) && /faturada[^\n]*30/.test(ch[0].descricao) && /recebida: 27/.test(ch[0].descricao) && /Robson/.test(ch[0].descricao), ch[0].descricao);
  const emUso2 = (await q(sql`SELECT * FROM inventory_lots WHERE instance_id = 'r-gyn' AND stock_type = 'in_use' AND lot_number = 'H221026'`))[0];
  t('em uso GYN = 40 + 27 = 67, responsavel agora Robson', Number(emUso2.quantity) === 67 && emUso2.desbloqueado_por === 'r-robson', emUso2);
  const adj = await q(sql`SELECT * FROM inventory_movements WHERE movement_type = 'adjust' AND lot_id = ${bloq2.id}`);
  t('ajuste -3 gravado com motivo e recebimento', adj.length === 1 && Number(adj[0].quantity) === -3 && /Confer/.test(adj[0].notes) && adj[0].source_id === r2.recebimentoId, adj);
  const rec = await q(sql`SELECT * FROM lote_recebimentos ORDER BY created_at`);
  t('2 recebimentos no historico, com origem (NF/pedido) em JSON', rec.length === 2 && Array.isArray(rec[1].origem) && rec[1].origem.some((o: any) => o.nfNumero === 5002 && o.pedido === 'TRF-2'), rec[1]?.origem);

  console.log('\n5) Faturamento na GYN agora sai, em FIFO, com o lote na NF');
  const mapa = await baixarEstoqueEmUso({ instanceId: 'r-gyn', products: [{ id: 'r-prod', name: 'SUCO MISTO - UVA 350ml', quantity: 10 }], sourceId: 'r-ped-1', rotulo: 'PED-1', createdBy: 'harness' });
  t('baixou 10 de H221026', mapa['r-prod']?.length === 1 && mapa['r-prod'][0].lotNumber === 'H221026' && mapa['r-prod'][0].quantidade === 10, mapa);

  console.log('\n6) Desbloqueio manual (mover-tipo) tambem carimba o responsavel; vendedor nao pode');
  await db.execute(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, is_active) VALUES ('r-l-man', 'r-prod', 'r-gyn', 'blocked', 'H990001', 12, true)`);
  const mv = await moverTipoLote({ lotId: 'r-l-man', destino: 'in_use', quantidade: 5, motivo: 'liberacao parcial de teste', user: u(flavio) });
  const dest = (await q(sql`SELECT * FROM inventory_lots WHERE id = ${mv.destinoId}`))[0];
  t('parcial: destino em uso com 5, origem com 7, responsavel Flavio', Number(dest.quantity) === 5 && mv.origemSaldo === 7 && dest.desbloqueado_por === 'r-flavio', { mv, dest });
  err = null;
  try { await moverTipoLote({ lotId: 'r-l-man', destino: 'in_use', quantidade: 100, motivo: 'teste de saldo', user: u(flavio) }); } catch (e) { err = e; }
  t('mover mais que o saldo -> erro', !!err && /maior que o saldo/.test(err.message), err?.message);

  console.log('\n7) Linha do tempo: destinacao e divergencias');
  const { registerRastreabilidadeLoteRoutes } = await import('../rastreabilidade-lote-routes');
  // chama a rota diretamente (sem express): captura o handler
  const handlers: Record<string, any> = {};
  registerRastreabilidadeLoteRoutes({ get: (path: string, ...fns: any[]) => { handlers[path] = fns[fns.length - 1]; } } as any);
  const call = async (query: any) => { let out: any = null; await handlers['/api/rastreabilidade-lote/linha-do-tempo']({ query }, { status: () => ({ json: (j: any) => { out = j; } }), json: (j: any) => { out = j; } }); return out; };
  const lt = await call({ lote: 'H221026' });
  t('producao OP-1 (100 un)', lt.producao.length === 1 && lt.producao[0].qtdLancada === 100, lt.producao);
  t('balanco IND: producao 100, consumos 70 (2 transf.), saldo 30', (() => { const b = lt.balanco.find((x: any) => x.code === 'IND'); return b && b.producao === 100 && b.consumos === 70 && b.saldoEmUso === 30 && b.nfSaidaTransf === 70; })(), lt.balanco);
  t('balanco GYN: entradas 70, ajuste -3, baixas 10, saldo em uso 57, bloqueado 0', (() => { const b = lt.balanco.find((x: any) => x.code === 'GYN'); return b && b.entradasTransferencia === 70 && b.ajustes === -3 && b.consumos === 10 && b.saldoEmUso === 57 && b.saldoBloqueado === 0; })(), lt.balanco);
  t('notas: 2 NFs de transferencia marcadas', lt.notas.filter((n: any) => n.transferencia).length === 2, lt.notas.map((n: any) => [n.numero, n.transferencia]));
  t('recebimentos: 2, um com divergencia', lt.recebimentos.length === 2 && lt.recebimentos.some((r: any) => Number(r.divergencia) === -3));
  const tipos = lt.divergencias.map((d: any) => d.tipo);
  t('divergencias: recebimento (-3) e baixa sem NF (PED-1 sem nota) apontadas', tipos.includes('recebimento') && tipos.includes('baixa_sem_nf'), lt.divergencias);
  t('destinacao: produzido 100, em estoque 87 (30+57), ajustes -3, 10 baixados sem NF -> 10 sem destino explicado', lt.destinacao.produzido === 100 && lt.destinacao.emEstoque === 87 && lt.destinacao.ajustes === -3 && lt.destinacao.naoExplicado === 10, lt.destinacao);
  t('saldos recalculados batem com os gravados (sem divergencia tipo saldo)', !tipos.includes('saldo'), lt.divergencias.filter((d: any) => d.tipo === 'saldo'));

  // Limpeza (omie_instances.name e UNIQUE: outros harnesses criam 'IND'/'GYN' com ids proprios).
  for (const tb of ['inventory_movements', 'inventory_lots', 'billing_pipeline', 'fiscal_invoice_items', 'fiscal_invoices', 'production_orders']) await db.execute(sql.raw(`DELETE FROM ${tb}`));
  await db.execute(sql`DELETE FROM omie_instances WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM products WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM customers WHERE id LIKE 'r-%'`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'r-%'`);
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
