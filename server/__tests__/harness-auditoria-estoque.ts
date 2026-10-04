// ============================================================================
// HARNESS — CORRECOES DA AUDITORIA DE ESTOQUE (28/set-04/out/2026)
//
// Roda contra um PostgreSQL real (nao entra no vitest):
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-auditoria-estoque.ts
//
// Complementa o harness-estoque-em-uso (baixa/bloqueio do faturamento) com o
// que a auditoria achou fora dele:
//   A. SERV controla o proprio estoque (deixou de ser excecao)
//   B. estorno de NF pelos movimentos: mesmo lote, mesma quantidade, idempotente
//   C. NF sem baixa: estorno nao inventa estoque
//   D. refaturar depois do estorno baixa de novo
//   E. transferencia GYN->BSB pelo CNPJ do destinatario: espelho exato,
//      BLOQUEADO, mesmo CMV, idempotente; estorno retira do destino
//   F. card na Lixeira sem NF autorizada devolve a baixa; com NF autorizada nao
//   G. card duplicado do mesmo pedido: estorno pega a baixa dos dois
//   H. numero de lote normalizado
// ============================================================================
import { db } from '../db';
import { sql } from 'drizzle-orm';
import {
  baixarEstoqueEmUso, verificarEstoqueEmUso, instanciaSemControleDeEstoque, baixaVigenteDoPedido,
  estornarEstoqueDaNfPorMovimentos, espelharTransferenciaPelosMovimentos, estornarBaixaDeCardSemNf,
  normalizarNumeroLote,
} from '../estoque-em-uso';

let ok = 0;
let fail = 0;
function check(cond: boolean, label: string, extra?: any) {
  if (cond) { ok++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
const rows = (r: any) => (r?.rows || []) as any[];

const GYN = 'ha-gyn', BSB = 'ha-bsb', SERV = 'ha-serv';
const P1 = 'ha-prod-1', P2 = 'ha-prod-2';

async function limpar() {
  await db.execute(sql`DELETE FROM inventory_movements WHERE product_id IN (${P1}, ${P2})`);
  await db.execute(sql`DELETE FROM inventory_lots WHERE product_id IN (${P1}, ${P2})`);
  await db.execute(sql`DELETE FROM fiscal_invoices WHERE id LIKE 'ha-nf-%'`);
  await db.execute(sql`DELETE FROM billing_pipeline WHERE sales_card_id LIKE 'ha-sc-%'`);
  await db.execute(sql`DELETE FROM omie_instances WHERE id IN (${GYN}, ${BSB}, ${SERV}) OR name IN ('GYN', 'BSB', 'SERV')`);
}

async function lote(inst: string, prod: string, numero: string, qtd: number, custo = '1.6407', diasAtras = 0, tipo = 'in_use') {
  const r = rows(await db.execute(sql`
    INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, unit_cost, is_active, created_at)
    VALUES (gen_random_uuid()::varchar, ${prod}, ${inst}, ${tipo}, ${numero}, ${qtd.toFixed(4)}, ${custo}, true, now() - (${diasAtras} || ' days')::interval)
    RETURNING id`));
  return String(r[0].id);
}

let seq = 0;
async function card(opts: { inst: string; products: any[]; op?: string; doc?: string; sc?: string }) {
  seq++;
  const sc = opts.sc || 'ha-sc-' + seq;
  const r = rows(await db.execute(sql`
    INSERT INTO billing_pipeline (id, sales_card_id, customer_id, customer_name, customer_document, stage, is_priority, operation_type, order_number, omie_instance_id, omie_instance_name, products, created_at)
    VALUES (gen_random_uuid()::varchar, ${sc}, 'ha-cli', 'CLIENTE HARNESS', ${opts.doc || null}, 'faturado', false, ${opts.op || 'venda'}, ${'INT-HA' + seq}, ${opts.inst}, 'X', ${JSON.stringify(opts.products)}::jsonb, now())
    RETURNING *`));
  const c = r[0];
  return { id: String(c.id), salesCardId: c.sales_card_id, orderNumber: c.order_number, omieInstanceId: c.omie_instance_id, omieInstanceName: 'X', products: c.products, operationType: c.operation_type, customerDocument: c.customer_document, customerId: c.customer_id };
}
async function baixar(c: any) {
  return baixarEstoqueEmUso({ instanceId: c.omieInstanceId, products: c.products, sourceId: c.id, rotulo: c.orderNumber, createdBy: 'harness', impedirDuplicadaDesde: null });
}
async function nf(salesCardId: string, status: string) {
  const id = 'ha-nf-' + (++seq);
  await db.execute(sql`INSERT INTO fiscal_invoices (id, invoice_number, status, operation_type, sales_card_id, fin_nfe) VALUES (${id}, ${800000 + seq}, ${status}, 'saida', ${salesCardId}, '1')`);
  return { id, invoiceNumber: 800000 + seq, salesCardId, status };
}
const saldo = async (id: string) => Number(rows(await db.execute(sql`SELECT quantity FROM inventory_lots WHERE id = ${id}`))[0]?.quantity ?? NaN);
const saldoInst = async (inst: string, prod: string) => Number(rows(await db.execute(sql`SELECT COALESCE(SUM(quantity),0) s FROM inventory_lots WHERE instance_id = ${inst} AND product_id = ${prod}`))[0].s);

async function main() {
  await limpar();
  for (const [id, nome, cnpj] of [[GYN, 'GYN', '28.295.493/0002-34'], [BSB, 'BSB', '28.295.493/0003-15'], [SERV, 'SERV', '52.921.727/0001-05']]) {
    await db.execute(sql`INSERT INTO omie_instances (id, name, display_name, app_key, app_secret, cnpj) VALUES (${id}, ${nome}, ${nome}, '', '', ${cnpj})`);
  }

  // ---- A ------------------------------------------------------------------
  {
    check(!instanciaSemControleDeEstoque('SERV'), 'A. SERV deixou de ser instancia sem controle de estoque');
    const v = await verificarEstoqueEmUso(SERV, [{ id: P1, name: 'P1', quantity: 5 }]);
    check(!v.valid, 'A. SERV sem saldo nao fatura');
    const l = await lote(SERV, P1, 'H290926', 24);
    const c = await card({ inst: SERV, products: [{ id: P1, name: 'P1', quantity: 24 }] });
    await baixar(c);
    check(await saldo(l) === 0, 'A. venda da SERV baixa o estoque da SERV');
  }

  // ---- B + D ----------------------------------------------------------------
  {
    const a = await lote(GYN, P1, 'HA0109', 10, '1.70', 5);
    const b = await lote(GYN, P1, 'HB2909', 40, '1.64', 1);
    const c = await card({ inst: GYN, products: [{ id: P1, name: 'P1', quantity: 25 }] });
    await baixar(c);
    check(await saldo(a) === 0 && await saldo(b) === 25, 'B. baixa de 25 (10 + 15)');
    const intruso = await lote(GYN, P1, 'HZ0101', 0, '1.50', 30);
    const nota = await nf(c.salesCardId, 'cancelled');
    const r = await estornarEstoqueDaNfPorMovimentos(nota, 'harness');
    check(await saldo(a) === 10 && await saldo(b) === 40, 'B. cada unidade volta ao lote de onde saiu', [await saldo(a), await saldo(b)]);
    check(await saldo(intruso) === 0, 'B. nada vai para o lote mais antigo (o generico antigo devolvia la)');
    check(r.undone.length === 2, 'B. dois movimentos estornados');
    const r2 = await estornarEstoqueDaNfPorMovimentos(nota, 'harness');
    check(r2.undone.length === 0 && await saldo(a) === 10 && await saldo(b) === 40, 'B. segundo estorno nao duplica');
    check((await baixaVigenteDoPedido(c)) === null, 'D. baixa estornada nao e mais vigente');
    await baixarEstoqueEmUso({ instanceId: GYN, products: c.products, sourceId: c.id, rotulo: c.orderNumber, createdBy: 'harness', impedirDuplicadaDesde: null });
    check(await saldo(a) === 0 && await saldo(b) === 25, 'D. refaturar depois do estorno baixa de novo');
  }

  // ---- C ------------------------------------------------------------------------
  {
    const l = await lote(GYN, P2, 'HC', 7, '6.0');
    const c = await card({ inst: GYN, products: [{ id: P2, name: 'P2', quantity: 12 }] });
    const nota = await nf(c.salesCardId, 'returned');
    const r = await estornarEstoqueDaNfPorMovimentos(nota, 'harness');
    check(r.nadaABaixar === true && r.undone.length === 0, 'C. NF sem baixa: nada estornado');
    check(await saldo(l) === 7, 'C. saldo intacto (antes: +12 fantasmas no primeiro lote)');
  }

  // ---- E -------------------------------------------------------------------------
  {
    const origem = await lote(GYN, P2, 'H230926', 200, '6.4361', 2);
    await db.execute(sql`UPDATE inventory_lots SET quantity = 0 WHERE instance_id = ${GYN} AND product_id = ${P2} AND id <> ${origem}`);
    const antes = await saldoInst(BSB, P2);
    const c = await card({ inst: GYN, op: 'transferencia', doc: '28.295.493/0003-15', products: [{ id: P2, name: 'P2', quantity: 72 }] });
    await baixar(c);
    const e1 = await espelharTransferenciaPelosMovimentos(c, { email: 'harness' });
    const dest = rows(await db.execute(sql`SELECT * FROM inventory_lots WHERE instance_id = ${BSB} AND product_id = ${P2} AND lot_number = 'H230926'`));
    check(dest.length === 1 && Number(dest[0].quantity) === 72, 'E. BSB recebeu 72 un no MESMO lote', dest);
    check(dest[0]?.stock_type === 'blocked', 'E. entrada de transferencia como BLOQUEADO (fila de reposicao)');
    check(Number(dest[0]?.unit_cost) === 6.4361, 'E. CMV do destino = CMV da origem');
    check(e1.creditado.length === 1, 'E. um credito registrado');
    const e2 = await espelharTransferenciaPelosMovimentos(c, { email: 'harness' });
    check(e2.creditado.length === 0 && await saldoInst(BSB, P2) === antes + 72, 'E. espelho idempotente');
    const nota = await nf(c.salesCardId, 'cancelled');
    const est = await estornarEstoqueDaNfPorMovimentos(nota, 'harness');
    check(await saldo(origem) === 200, 'E. estorno devolve a origem', await saldo(origem));
    check(await saldoInst(BSB, P2) === antes, 'E. estorno retira do destino');
    check(est.undone.some((u) => u.startsWith('destino')), 'E. undone registra a retirada do destino');
    const semDest = await card({ inst: GYN, op: 'transferencia', doc: '99.999.999/0001-99', products: [{ id: P2, name: 'P2', quantity: 1 }] });
    const e3 = await espelharTransferenciaPelosMovimentos(semDest, { email: 'harness' });
    check(e3.creditado.length === 0 && e3.avisos.some((a) => /destino da transferencia nao identificado/.test(a)), 'E. destino desconhecido vira aviso explicito');
  }

  // ---- F --------------------------------------------------------------------------
  {
    const l = await lote(GYN, P2, 'HF', 30, '6.0', 10);
    const c = await card({ inst: GYN, products: [{ id: P2, name: 'P2', quantity: 6 }] });
    await baixar(c);
    const antes = await saldoInst(GYN, P2);
    await nf(c.salesCardId, 'rejected');
    const r = await estornarBaixaDeCardSemNf(c.id, 'harness');
    check(!!r && await saldoInst(GYN, P2) === antes + 6, 'F. lixeira sem NF autorizada devolve a baixa');
    const c2 = await card({ inst: GYN, products: [{ id: P2, name: 'P2', quantity: 6 }] });
    await baixar(c2);
    const antes2 = await saldoInst(GYN, P2);
    await nf(c2.salesCardId, 'authorized');
    const r2 = await estornarBaixaDeCardSemNf(c2.id, 'harness');
    check(r2 === null && await saldoInst(GYN, P2) === antes2, 'F. com NF autorizada a lixeira nao mexe no estoque');
    void l;
  }

  // ---- G --------------------------------------------------------------------------
  {
    const l = await lote(GYN, P1, 'HG', 100, '1.6', 40);
    await db.execute(sql`UPDATE inventory_lots SET quantity = 0 WHERE instance_id = ${GYN} AND product_id = ${P1} AND id <> ${l}`);
    const c1 = await card({ inst: GYN, sc: 'ha-sc-dup', products: [{ id: P1, name: 'P1', quantity: 10 }] });
    const c2 = await card({ inst: GYN, sc: 'ha-sc-dup', products: [{ id: P1, name: 'P1', quantity: 5 }] });
    await baixar(c1); await baixar(c2);
    check(await saldo(l) === 85, 'G. dois cards do mesmo pedido baixaram 15');
    const nota = await nf('ha-sc-dup', 'cancelled');
    await estornarEstoqueDaNfPorMovimentos(nota, 'harness');
    check(await saldo(l) === 100, 'G. estorno da NF devolve a baixa dos dois cards', await saldo(l));
  }

  // ---- H ---------------------------------------------------------------------------
  check(normalizarNumeroLote(' h18 0626 ') === 'H180626', 'H. numero de lote normalizado');

  await limpar();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
