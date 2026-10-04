// ============================================================================
// HARNESS — ROTAS DE FATURAMENTO x ESTOQUE (auditoria 04/out/2026)
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-faturamento-estoque.ts
// Express real + rotas reais do pipeline, Postgres real, sessao injetada.
// A emissao na SEFAZ falha no ambiente de teste (sem certificado) — o que se
// confere aqui e o ESTOQUE e a etapa do card, que acontecem antes da nota.
// ============================================================================
import express from 'express';
import http from 'http';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { registerBillingPipelineRoutes } from '../billing-pipeline-routes';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => {
  if (cond) { ok++; console.log('  ✓', nome); }
  else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
};
const q = async (s: any) => ((await db.execute(s)) as any).rows || [];
const P = 'hf-prod-1';
const GYN = 'hf-gyn';

async function limpar() {
  await db.execute(sql`DELETE FROM inventory_movements WHERE product_id = ${P}`);
  await db.execute(sql`DELETE FROM inventory_lots WHERE product_id = ${P}`);
  await db.execute(sql`DELETE FROM fiscal_invoices WHERE sales_card_id LIKE 'hf-sc-%'`);
  await db.execute(sql`DELETE FROM billing_pipeline WHERE sales_card_id LIKE 'hf-sc-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id = ${GYN} OR name = 'GYN'`);
}

async function main() {
  await limpar();
  await db.execute(sql`DELETE FROM users WHERE id = 'hf-admin'`);
  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ('hf-admin', 'flavio@bebahonest.com.br', 'Harness', 'Admin', 'admin', true)`);
  await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj) VALUES (${GYN}, 'GYN', 'GYN', '', '', '28.295.493/0002-34')`);
  await db.execute(sql`INSERT INTO products (id, name, price) VALUES (${P}, 'SUCO HARNESS 350', 6) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`DELETE FROM customers WHERE id = 'hf-cli'`);
  await db.execute(sql`INSERT INTO customers (id, name, customer_type, phone, address, seller_id, weekdays, state, zip_code, city, cnpj) VALUES ('hf-cli', 'CLIENTE HF', 'pessoa_juridica', '62999999999', 'Rua A', 'hf-admin', 'seg', 'GO', '74000000', 'Goiania', '11222333000181')`);
  const lot: any = (await q(sql`INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, unit_cost, is_active) VALUES (gen_random_uuid()::varchar, ${P}, ${GYN}, 'in_use', 'H290926', '50', '1.64', true) RETURNING id`))[0];

  let n = 0;
  const card = async (qtd: number, extra: any = {}) => {
    n++;
    const r = await q(sql`INSERT INTO billing_pipeline (id, sales_card_id, customer_id, customer_name, stage, is_priority, operation_type, order_number, omie_instance_id, products, sale_value, created_at)
      VALUES (gen_random_uuid()::varchar, ${'hf-sc-' + n}, 'hf-cli', 'CLIENTE HF', 'a_faturar', false, 'venda', ${'INT-HF' + n}, NULL,
              ${JSON.stringify([{ productId: P, name: 'SUCO HARNESS 350', quantity: qtd, unitPrice: 6, totalPrice: 6 * qtd, ...extra }])}::jsonb, ${(6 * qtd).toFixed(2)}, now()) RETURNING id`);
    return String(r[0].id);
  };
  const saldo = async () => Number((await q(sql`SELECT quantity FROM inventory_lots WHERE id = ${lot.id}`))[0].quantity);
  const etapa = async (id: string) => (await q(sql`SELECT stage, omie_instance_id FROM billing_pipeline WHERE id = ${id}`))[0];

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 'hf-admin', userEmail: 'flavio@bebahonest.com.br' }; next(); });
  registerBillingPipelineRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  try {
    console.log('\n1) Faturamento individual: pedido sem instancia, produto em productId');
    const c1 = await card(20);
    let r = await call('PATCH', `/api/billing-pipeline/${c1}/stage`, { stage: 'faturado' });
    t('baixa feita (50 -> 30)', (await saldo()) === 30, { saldo: await saldo(), r });
    t('card ganhou a instancia GYN', (await etapa(c1)).omie_instance_id === GYN);
    const it1 = await q(sql`SELECT i.product_id, i.product_name, i.lot_number FROM fiscal_invoice_items i JOIN fiscal_invoices f ON f.id = i.invoice_id WHERE f.sales_card_id = 'hf-sc-1'`);
    t('item da NF com o produto (pedido em productId) e o lote', it1.length === 1 && it1[0].product_id === P && /H290926/.test(String(it1[0].lot_number || '')), it1);

    console.log('\n2) Faturamento individual sem saldo: 400 e nada muda');
    const c2 = await card(40);
    r = await call('PATCH', `/api/billing-pipeline/${c2}/stage`, { stage: 'faturado' });
    t('400 stockError', r.status === 400 && r.json?.stockError === true, r);
    t('card continua em a_faturar', (await etapa(c2)).stage === 'a_faturar');
    t('saldo intacto (30)', (await saldo()) === 30);
    const nfs = await q(sql`SELECT 1 FROM fiscal_invoices WHERE sales_card_id = 'hf-sc-2'`);
    t('nenhuma NF criada', nfs.length === 0);

    console.log('\n3) Faturamento em LOTE: um passa, outro bloqueia');
    const c3 = await card(10);
    const c4 = await card(100);
    r = await call('POST', '/api/billing-pipeline/batch/stage', { ids: [c3, c4], stage: 'faturado' });
    const res3 = (r.json?.results || []).find((x: any) => x.id === c3);
    const res4 = (r.json?.results || []).find((x: any) => x.id === c4);
    t('c3 baixou (30 -> 20)', (await saldo()) === 20, { saldo: await saldo(), r: r.json });
    t('c4 recusado por estoque', res4 && res4.success === false && /estoque em uso insuficiente/i.test(res4.error || ''), res4);
    t('c4 continua em a_faturar', (await etapa(c4)).stage === 'a_faturar');
    void res3;

    console.log('\n4) Lixeira de pedido baixado sem NF autorizada devolve o estoque');
    await db.execute(sql`UPDATE fiscal_invoices SET status = 'rejected' WHERE sales_card_id = 'hf-sc-3'`);
    r = await call('DELETE', `/api/billing-pipeline/${c3}`);
    t('lixeira 200', r.status === 200, r.json);
    t('estoque de c3 voltou (20 -> 30)', (await saldo()) === 30, { saldo: await saldo(), r: r.json });
  } finally {
    server.close();
    await limpar();
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
