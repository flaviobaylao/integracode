// Harness da NF-e DE ENTRADA PRÓPRIA (04/out/2026).
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-nf-entrada-produtor.ts
// Postgres real, Express real; a transmissão à SEFAZ é simulada (status gravado à mão).
import express from 'express';
import http from 'http';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { registerNfEntradaProdutorRoutes, ensureNfEntradaProdutor, aoCancelarNfEntrada } from '../nf-entrada-produtor';
import { registerPurchaseRoutes } from '../purchase-routes';

let ok = 0, fail = 0;
const t = (n: string, c: boolean, x?: any) => { if (c) { ok++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];

async function main() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS suppliers (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), name varchar, company_name varchar, cnpj varchar, cpf varchar, state_registration varchar, email varchar, phone varchar, contact_name varchar, address varchar, address_number varchar, address_complement varchar, neighborhood varchar, city varchar, state varchar, zip_code varchar, default_chart_account_id varchar, default_category varchar, omie_instance_id varchar, notes text, is_active boolean, created_at timestamp, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_materials (id varchar PRIMARY KEY, name varchar, code varchar, category varchar, unit varchar, quantity numeric, min_quantity numeric, unit_cost numeric, is_active boolean DEFAULT true, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS raw_material_movements (id varchar PRIMARY KEY, raw_material_id varchar, movement_type varchar, quantity numeric, previous_quantity numeric, new_quantity numeric, production_order_id varchar, notes text, created_by varchar, created_at timestamp, unit_cost numeric)`);
  for (const tb of ['raw_material_movements', 'raw_materials', 'suppliers', 'purchase_invoices', 'fiscal_invoice_items', 'fiscal_invoices', 'fiscal_scenarios', 'omie_instances', 'users']) await db.execute(sql.raw(`DELETE FROM ${tb}`));
  await db.execute(sql`DELETE FROM chart_of_accounts WHERE code = '2.01'`);
  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ('h-admin','h@honest.test','H','A','admin',true)`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj, is_active) VALUES ('h-ind','IND','IND','k','s','28295493000153',true), ('h-serv','SERV','SERV','k','s','52921727000105',true)`);
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('fiscal_env_h-ind','producao','h') ON CONFLICT (key) DO UPDATE SET value='producao'`);
  await db.execute(sql`INSERT INTO chart_of_accounts (id, code, name, type) VALUES ('ca-201','2.01','Matéria-prima (frutas/polpas)','despesa')`).catch(async (e) => { console.log('chart insert', e.message); });
  await db.execute(sql`INSERT INTO raw_materials (id, name, unit, quantity, unit_cost) VALUES ('mp-acer','ACEROLA','kg',0,5.5), ('mp-polpa','POLPA INTEGRAL DE ACEROLA','kg',10,7.1)`);
  await db.execute(sql`INSERT INTO suppliers (id, name, cpf, state, city, address, is_active) VALUES ('s-ok','JOAO PRODUTOR','52998224725','GO','Bela Vista de Goiás','Fazenda Boa Vista',true), ('s-ruim','SEM ENDERECO','52998224725',null,null,null,true)`);

  await ensureNfEntradaProdutor();
  const cen = await q(sql`SELECT cfop, csosn, cst_pis FROM fiscal_scenarios WHERE operation_type='compra_produtor' ORDER BY cfop`);
  t('2 cenários semeados 1101/2101 CSOSN 900 CST 98', cen.length === 2 && cen[0].cfop === '1101' && cen[1].cfop === '2101' && cen[0].csosn === '900' && cen[0].cst_pis === '98', cen);
  const ncm = await q(sql`SELECT id, ncm FROM raw_materials ORDER BY id`);
  t('NCM só na fruta in natura', ncm.find((r: any) => r.id === 'mp-acer')?.ncm === '08109000' && !ncm.find((r: any) => r.id === 'mp-polpa')?.ncm, ncm);

  const app = express(); app.use(express.json());
  app.use((req: any, _r, n) => { req.session = { userId: 'h-admin', userEmail: 'h@honest.test' }; n(); });
  registerNfEntradaProdutorRoutes(app); registerPurchaseRoutes(app);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, p: string, b?: any) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let j: any = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };

  try {
    console.log('\n1) contexto');
    let r = await call('GET', '/api/nf-entrada-produtor/contexto');
    t('só IND (SERV é regime normal, fica fora)', r.status === 200 && r.json.instancias.length === 1 && r.json.instancias[0].name === 'IND', r.json?.instancias);
    t('conta padrão 2.01', r.json?.contaPadrao?.code === '2.01', r.json?.contaPadrao);

    console.log('\n2) validações');
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ruim', items: [{ rawMaterialId: 'mp-acer', quantity: 1, unitPrice: 1 }], emitir: false });
    t('fornecedor sem UF/cidade/endereço → 400', r.status === 400 && /UF|munic|endere/.test(r.json?.error), r.json);
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ok', items: [{ rawMaterialId: 'mp-polpa', quantity: 1, unitPrice: 1 }], emitir: false });
    t('item sem NCM → 400', r.status === 400 && /NCM/.test(r.json?.error), r.json);
    r = await call('POST', '/api/nf-entrada-produtor/fornecedores', { name: 'X', document: '12345678900', state: 'GO' });
    t('CPF com DV errado → 400', r.status === 400, r.json);

    console.log('\n3) cria rascunho (sem transmitir)');
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ok', paymentMethod: 'pix', items: [{ rawMaterialId: 'mp-acer', quantity: '100', unitPrice: '5,50' }, { rawMaterialId: 'mp-polpa', ncm: '20079990', quantity: 2, unitPrice: 7 }], emitir: false });
    t('201', r.status === 201, r.json);
    const id = r.json?.invoice?.id;
    const inv = (await q(sql`SELECT * FROM fiscal_invoices WHERE id=${id}`))[0];
    t('entrada / finNFe 1 / CFOP 1101 / total 564,00 / pix / producao', inv?.operation_type === 'entrada' && inv?.fin_nfe === '1' && inv?.cfop === '1101' && Number(inv?.total_invoice) === 564 && inv?.payment_method === 'pix' && inv?.environment === 'producao', inv && { op: inv.operation_type, cfop: inv.cfop, tot: inv.total_invoice });
    t('remetente no <dest>: CPF, cidade, UF', inv?.customer_cnpj_cpf === '52998224725' && inv?.customer_uf === 'GO' && inv?.customer_city === 'Bela Vista de Goiás', inv);
    t('emitente IND', String(inv?.issuer_cnpj).includes('0001-53'), inv?.issuer_cnpj);
    const its = await q(sql`SELECT * FROM fiscal_invoice_items WHERE invoice_id=${id} ORDER BY item_number`);
    t('2 itens, CSOSN 900, CST 98, sem productId', its.length === 2 && its.every((i: any) => i.csosn === '900' && i.cst_pis === '98' && !i.product_id), its.map((i: any) => [i.csosn, i.cst_pis, i.product_id]));
    t('NCM digitado gravado na polpa', (await q(sql`SELECT ncm FROM raw_materials WHERE id='mp-polpa'`))[0]?.ncm === '20079990');
    r = await call('GET', '/api/nf-entrada-produtor');
    t('lista mostra o rascunho', r.json?.length === 1 && r.json[0].status === 'draft', r.json);

    console.log('\n4) "autorizada" → compra na aba Compras');
    await db.execute(sql`UPDATE fiscal_invoices SET status='authorized', access_key='52261028295493000153550010000000011000000011', xml_autorizacao='<nfeProc/>', emission_date=now() WHERE id=${id}`);
    r = await call('POST', `/api/nf-entrada-produtor/${id}/sincronizar`);
    t('compra criada', r.status === 200 && r.json?.purchaseId, r.json);
    const pid = r.json?.purchaseId;
    const p = (await q(sql`SELECT * FROM purchase_invoices WHERE id=${pid}`))[0];
    t('classificada, estoque, conta 2.01, fornecedor = produtor, total 564', p?.status === 'classified' && p?.is_stock_purchase === true && p?.chart_account_id === 'ca-201' && p?.supplier_document === '52998224725' && Number(p?.total_value) === 564, p);
    t('itens com rawMaterialId', p?.items?.[0]?.rawMaterialId === 'mp-acer' && p?.items?.[1]?.rawMaterialId === 'mp-polpa', p?.items);
    r = await call('POST', `/api/nf-entrada-produtor/${id}/sincronizar`);
    t('idempotente (mesma compra)', r.json?.purchaseId === pid && (await q(sql`SELECT count(*)::int n FROM purchase_invoices`))[0].n === 1);

    console.log('\n5) entrada da matéria-prima pela rota de Compras');
    r = await call('POST', `/api/purchases/${pid}/process-raw-materials`, { itemMappings: p.items.map((i: any) => ({ rawMaterialId: i.rawMaterialId, quantity: Number(i.qCom), unitCost: Number(i.vUnCom) })) });
    t('200', r.status === 200, r.json);
    const mp = await q(sql`SELECT id, quantity::float q, unit_cost::float c FROM raw_materials ORDER BY id`);
    t('acerola 0 → 100 @ 5,50; polpa 10 → 12', mp.find((m: any) => m.id === 'mp-acer')?.q === 100 && mp.find((m: any) => m.id === 'mp-acer')?.c === 5.5 && mp.find((m: any) => m.id === 'mp-polpa')?.q === 12, mp);

    console.log('\n6) cancelamento');
    const aviso = await aoCancelarNfEntrada(id, 'teste', 'h');
    const p2 = (await q(sql`SELECT status FROM purchase_invoices WHERE id=${pid}`))[0];
    t('com estoque lançado: compra NÃO cancela, só avisa', p2.status === 'classified' && /ATENÇÃO/.test(aviso || ''), { p2, aviso });
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ok', items: [{ rawMaterialId: 'mp-acer', quantity: 1, unitPrice: 5 }], emitir: false });
    const id2 = r.json?.invoice?.id;
    t('numeração sequencial', r.json?.invoice?.invoiceNumber === inv.invoice_number + 1, [inv.invoice_number, r.json?.invoice?.invoiceNumber]);
    await db.execute(sql`UPDATE fiscal_invoices SET status='authorized', access_key='52261028295493000153550010000000021000000021' WHERE id=${id2}`);
    const s2 = await call('POST', `/api/nf-entrada-produtor/${id2}/sincronizar`);
    await aoCancelarNfEntrada(id2, 'teste', 'h');
    t('sem estoque: compra cancelada', (await q(sql`SELECT status FROM purchase_invoices WHERE id=${s2.json?.purchaseId}`))[0]?.status === 'cancelled');

    console.log('\n7) homologação e descarte');
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ok', homologacao: true, items: [{ rawMaterialId: 'mp-acer', quantity: 1, unitPrice: 5 }], emitir: false });
    const id3 = r.json?.invoice?.id;
    await db.execute(sql`UPDATE fiscal_invoices SET status='authorized' WHERE id=${id3}`);
    r = await call('POST', `/api/nf-entrada-produtor/${id3}/sincronizar`);
    t('homologação não vira compra', r.status === 400 && r.json?.motivo === 'homologacao', r.json);
    r = await call('POST', '/api/nf-entrada-produtor', { supplierId: 's-ok', items: [{ rawMaterialId: 'mp-acer', quantity: 1, unitPrice: 5 }], emitir: false });
    const id4 = r.json?.invoice?.id;
    r = await call('DELETE', `/api/nf-entrada-produtor/${id4}`);
    t('rascunho descartado', r.status === 200 && (await q(sql`SELECT count(*)::int n FROM fiscal_invoices WHERE id=${id4}`))[0].n === 0, r.json);
    r = await call('DELETE', `/api/nf-entrada-produtor/${id}`);
    t('autorizada não pode ser descartada', r.status === 400, r.json);
  } finally { server.close(); }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
