// ============================================================================
// PDV DO BALCAO — catalogo, venda e recebimento
// ----------------------------------------------------------------------------
// Este modulo transforma o app da maquininha num PDV de verdade: o operador
// monta o carrinho na tela, cobra pela Cielo e o dinheiro entra no financeiro.
//
// TRES DECISOES QUE EXPLICAM O RESTO DO ARQUIVO:
//
// 1) PRECO NUNCA VEM DO APARELHO.
//    O app manda apenas {produtoId, quantidade}. Todo preco e relido do banco
//    aqui. Um APK e um zip: qualquer um com o arquivo consegue alterar o que o
//    aparelho envia. Se o servidor aceitasse o preco do cliente, vender a um
//    centavo seria questao de editar um JSON.
//
// 2) DINHEIRO SO EM CENTAVOS, INTEIRO.
//    Nada de ponto flutuante em valor. 5.4 * 100 em IEEE-754 da
//    540.0000000000001; com arredondamento errado no lugar errado, some ou
//    sobra centavo no caixa. A conversao aqui e feita por STRING (ver
//    reaisParaCentavos) e e exata por construcao.
//
// 3) VENDA DE BALCAO NAO VIRA sales_card.
//    sales_cards e o card de visita recorrente — exige cliente, vendedor e dia
//    de rota, e alimenta roteirizacao, churn e entregas. Empurrar uma venda
//    avulsa de balcao para la criaria cliente fantasma na rota. O balcao lanca
//    direto em receivables + receivable_payments, que e onde o dinheiro
//    realmente mora.
// ============================================================================
import type { Express, Response } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

/**
 * "6.00" -> 600. Exato, sem ponto flutuante em momento algum.
 *
 * Aceita "6", "6.5", "6,50", "6.00". Recusa o resto devolvendo null — precisa
 * ser null e nao 0, senao um cadastro com preco sujo viraria venda gratis.
 */
export function reaisParaCentavos(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const centavos = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(centavos) ? centavos : null;
}

/** 600 -> "6.00", no formato que as colunas decimal(10,2) esperam. */
export function centavosParaReais(c: number): string {
  const n = Math.round(c);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Configuracao
// ---------------------------------------------------------------------------

/** Nome do cliente usado quando a venda nao e identificada. */
const CLIENTE_AVULSO = 'CONSUMIDOR (balcao)';

/**
 * Conta financeira que recebe as vendas da maquininha.
 *
 * Configuravel por env, com busca por nome como plano B: cravar um UUID no
 * codigo quebraria em qualquer outro ambiente (e ninguem lembraria por que).
 */
const CONTA_ENV = (process.env.LIO_CONTA_FINANCEIRA_ID || '').trim();
const CONTA_NOME_PADRAO = 'CARTOES';

let _contaCache: string | null = null;
async function contaFinanceira(): Promise<string | null> {
  if (_contaCache) return _contaCache;
  if (CONTA_ENV) { _contaCache = CONTA_ENV; return _contaCache; }
  try {
    const r: any = await db.execute(sql`SELECT id FROM financial_accounts
      WHERE upper(name) = ${CONTA_NOME_PADRAO} AND is_active = true LIMIT 1`);
    const id = ((r.rows || r) as any[])[0]?.id;
    if (id) { _contaCache = String(id); return _contaCache; }
  } catch { /* schema antigo — segue sem conta */ }
  return null;
}

/**
 * A partir de quanto a venda passa a ser atacado.
 *
 * NAO e numero inventado: o schema de products documenta retail_price como
 * "consumidor < R$200" e wholesale_price como "consumidor >= R$200". O PDV
 * apenas SUGERE a tabela por esta regra — quem decide continua sendo o
 * operador, porque no balcao existe combinado que o sistema nao conhece.
 */
export const ATACADO_A_PARTIR_DE_CENTAVOS = 20000;

export type TabelaPreco = 'varejo' | 'atacado';

// ---------------------------------------------------------------------------
// Schema proprio do PDV
// ---------------------------------------------------------------------------
let _pdvPronto = false;
export async function ensurePdvSchema(): Promise<void> {
  if (_pdvPronto) return;
  for (const alter of [
    // Qual tabela de preco o operador usou. Sem isso nao da para auditar uma
    // venda de atacado meses depois — os precos do cadastro mudam.
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS tabela_preco varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS cliente_id varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS cliente_nome varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS forma_pagamento varchar`,
    // Titulo gerado no financeiro. Guardado no pedido para o caminho de volta:
    // dado um estorno na maquininha, precisamos achar o titulo correspondente.
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS receivable_id varchar`,
  ]) {
    try { await db.execute(sql.raw(alter)); } catch { /* ja existe */ }
  }
  _pdvPronto = true;
}

// ---------------------------------------------------------------------------
// Pedido de venda (sales_card) — porta de entrada do faturamento
// ---------------------------------------------------------------------------

/** Origem gravada no card. E o que o Pipeline usa para exibir o selo "Balcao". */
export const ORIGEM_BALCAO = 'balcao';

/** Nome do cliente usado quando a venda de balcao nao e identificada. */
const CLIENTE_BALCAO_NOME = 'CONSUMIDOR BALCÃO';

/**
 * Cliente guarda-chuva das vendas de balcao nao identificadas.
 *
 * POR QUE UM SO, FIXO: sales_cards exige customer_id, e criar um cliente por
 * venda avulsa encheria o cadastro de fantasmas — cada um entrando em rota,
 * churn e carteira de vendedor. Um unico cliente concentra todas, fica claro no
 * relatorio e nao suja nada.
 *
 * Nasce com virtual_service = true e is_active = false de proposito: os dois
 * marcam "nao e cliente de visita", que e o que impede a roteirizacao e o radar
 * de churn de irem atras dele.
 */
async function clienteBalcao(): Promise<string | null> {
  try {
    const j: any = await db.execute(sql`SELECT id FROM customers
      WHERE name = ${CLIENTE_BALCAO_NOME} ORDER BY created_at ASC LIMIT 1`);
    const existente = ((j.rows || j) as any[])[0]?.id;
    if (existente) return String(existente);

    const { getHotsiteDefaults } = await import('./canais-routes');
    const cfg = await getHotsiteDefaults();
    const vendedor = cfg.vendedorId || (await vendedorPadrao());
    if (!vendedor) {
      console.error('❌ [LIO-PDV] Nenhum vendedor disponivel para criar o cliente do balcao.');
      return null;
    }

    const { storage } = await import('./storage');
    const { aplicarLocalPadraoCanal } = await import('./canal-local-padrao');
    // Cidade/UF padrao do canal (GOIÂNIA/GO). Sem UF o faturamento barra o card
    // em "Cadastro incompleto: informe a UF" e a NF-e sai com CFOP errado.
    const novo = await storage.createCustomer(aplicarLocalPadraoCanal({
      name: CLIENTE_BALCAO_NOME,
      customerType: 'pessoa_fisica',
      phone: '0000000000',
      address: 'Venda presencial no balcao',
      route: cfg.rota,
      sellerId: vendedor,
      weekdays: JSON.stringify([cfg.dia]),
      visitPeriodicity: cfg.periodicidade,
      virtualService: true,   // nao conta para meta de atendimento
      isActive: false,        // fica fora de rota e do radar de churn
    }) as any);
    console.log(`🆕 [LIO-PDV] Cliente do balcao criado: ${novo.id}`);
    return String(novo.id);
  } catch (e: any) {
    console.error('❌ [LIO-PDV] Falha ao resolver o cliente do balcao:', e?.message || e);
    return null;
  }
}

async function vendedorPadrao(): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT id FROM users
      WHERE role = 'vendedor' AND is_active = true ORDER BY created_at ASC LIMIT 1`);
    const v = ((r.rows || r) as any[])[0]?.id;
    if (v) return String(v);
    const a: any = await db.execute(sql`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
    return ((a.rows || a) as any[])[0]?.id ? String(((a.rows || a) as any[])[0].id) : null;
  } catch { return null; }
}

/**
 * Transforma a venda do balcao num pedido de venda (sales_card).
 *
 * POR QUE ISTO EXISTE: o Pipeline de Faturamento e ancorado em sales_cards —
 * billing_pipeline.sales_card_id e customer_id sao NOT NULL. Sem card, a venda
 * fica so no financeiro e NUNCA vira nota fiscal. Foi exatamente o que
 * aconteceu com as primeiras vendas do PDV.
 *
 * Segue o caminho do HOTSITE, que ja resolvia o mesmo problema para venda de
 * consumidor sem rota (ver POST /api/public/orders): mesmos defaults de dia,
 * periodicidade e vendedor, lidos de Canais > Hotsite.
 *
 * Valores: o payload do pedido guarda unitPrice em CENTAVOS (contrato do deep
 * link da Cielo); sales_cards trabalha em REAIS. A conversao acontece aqui, uma
 * vez, e o total sai da soma dos itens — nunca de arredondar o total.
 */
export async function criarSalesCardBalcao(pedidoId: string): Promise<string | null> {
  await ensurePdvSchema();

  const r: any = await db.execute(sql`SELECT id, reference, payload, cliente_id, cliente_nome,
      tabela_preco, forma_pagamento, sales_card_id
    FROM lio_pedidos WHERE id = ${pedidoId} LIMIT 1`);
  const p = ((r.rows || r) as any[])[0];
  if (!p) return null;
  if (p.sales_card_id) return String(p.sales_card_id); // idempotente

  let itens: any[] = [];
  try { itens = JSON.parse(String(p.payload || '{}')).itens || []; } catch { itens = []; }
  if (!itens.length) {
    console.warn(`⚠️ [LIO-PDV] Pedido ${pedidoId} sem itens no payload; card nao criado.`);
    return null;
  }

  const customerId = p.cliente_id || (await clienteBalcao());
  if (!customerId) return null;

  const { getHotsiteDefaults } = await import('./canais-routes');
  const cfg = await getHotsiteDefaults();
  const sellerId = cfg.vendedorId || (await vendedorPadrao());
  if (!sellerId) {
    console.error('❌ [LIO-PDV] Nenhum vendedor disponivel; card do balcao nao criado.');
    return null;
  }

  let totalCentavos = 0;
  const produtos = itens.map((it: any) => {
    const q = Number(it.quantity) || 0;
    const unitCent = Number(it.unitPrice) || 0;
    totalCentavos += unitCent * q;
    return {
      productId: it.produtoId || null,
      name: it.name,
      productName: it.name,
      quantity: q,
      unitPrice: unitCent / 100,
      totalPrice: (unitCent * q) / 100,
    };
  });

  const resumo = itens.map((it: any) => `${it.name} (${it.quantity}x)`).join(', ');
  const { storage } = await import('./storage');
  const card = await storage.createSalesCard({
    customerId,
    sellerId,
    routeDay: cfg.dia,
    recurrenceType: cfg.periodicidade,
    // Venda de balcao NAO se repete: e um evento, nao uma visita recorrente.
    // Deixar isRecurring true faria o sistema gerar um proximo card sozinho.
    isRecurring: false,
    status: 'pending',
    paymentMethod: 'a_vista',
    operationType: 'venda',
    products: produtos,
    saleValue: centavosParaReais(totalCentavos),
    source: ORIGEM_BALCAO,
    notes: `Venda no balcao pela maquininha — ${p.reference}\nItens: ${resumo}\n`
         + `Total: R$ ${centavosParaReais(totalCentavos)}\nTabela: ${p.tabela_preco || 'varejo'}\n`
         + `Pagamento: ${p.forma_pagamento || 'cartao'} (ja recebido na maquininha)`,
    deliveryWeekdays: [],
    deliveryTimeSlots: [],
    deliverySaturdayTimeSlots: [],
  } as any);

  await db.execute(sql`UPDATE lio_pedidos SET sales_card_id = ${card.id}, updated_at = now() WHERE id = ${pedidoId}`);
  console.log(`🧾 [LIO-PDV] Card de venda criado para ${p.reference}: ${card.id}`);
  return String(card.id);
}

// ---------------------------------------------------------------------------
// Recebimento no financeiro
// ---------------------------------------------------------------------------

/**
 * Lanca a venda de balcao no financeiro: cria o titulo JA RECEBIDO e a baixa.
 *
 * POR QUE ISTO EXISTE: ate aqui, pedido sem sales_card era apenas registrado e
 * o dinheiro nao aparecia em lugar nenhum do financeiro. Para um teste de deep
 * link tudo bem; para um PDV, seria um caixa que vende e nao contabiliza.
 *
 * IDEMPOTENTE: external_id = 'lio:<pedidoId>' com indice unico. Mesmo que o
 * fluxo chame duas vezes (reenvio do app, retry de rede), o segundo INSERT
 * falha no indice e nada e lancado em dobro.
 */
export async function registrarRecebimentoBalcao(pedido: {
  id: string;
  reference: string;
  valorCentavos: number;
  clienteId?: string | null;
  clienteNome?: string | null;
  formaPagamento?: string | null;
  detalhe?: string | null;
}): Promise<{ receivableId: string | null; motivo?: string }> {
  await ensurePdvSchema();

  if (!Number.isSafeInteger(pedido.valorCentavos) || pedido.valorCentavos <= 0) {
    return { receivableId: null, motivo: 'valor_invalido' };
  }

  // Indice unico: a trava real contra lancamento duplicado.
  try {
    await db.execute(sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_receivables_external_lio
       ON receivables (external_id) WHERE external_id IS NOT NULL`
    ));
  } catch { /* indice parcial nao suportado */ }

  const externalId = `lio:${pedido.id}`;
  const valor = centavosParaReais(pedido.valorCentavos);
  const conta = await contaFinanceira();
  const forma = pedido.formaPagamento || 'cartao';

  try {
    const r: any = await db.execute(sql`INSERT INTO receivables
      (customer_id, customer_name, category, description, issue_date, due_date,
       amount, amount_paid, status, payment_method, financial_account_id,
       external_id, notes, created_by)
      VALUES (${pedido.clienteId || null},
              ${pedido.clienteNome || CLIENTE_AVULSO},
              'Venda balcao',
              ${'Venda no balcao — ' + pedido.reference},
              now(), now(),
              ${valor}, ${valor}, 'recebida', ${forma}::financial_payment_method,
              ${conta}, ${externalId},
              ${pedido.detalhe || null}, 'lio-app')
      ON CONFLICT DO NOTHING
      RETURNING id`);

    const receivableId = ((r.rows || r) as any[])[0]?.id;
    if (!receivableId) {
      // Ja existia: o titulo desta venda ja foi lancado antes.
      const j: any = await db.execute(sql`SELECT id FROM receivables WHERE external_id = ${externalId} LIMIT 1`);
      const existente = ((j.rows || j) as any[])[0]?.id;
      return { receivableId: existente ? String(existente) : null, motivo: 'ja_lancado' };
    }

    await db.execute(sql`INSERT INTO receivable_payments
      (receivable_id, paid_at, amount, payment_method, financial_account_id, reference, notes, created_by)
      VALUES (${receivableId}, now(), ${valor}, ${forma}::financial_payment_method,
              ${conta}, ${pedido.reference}, ${pedido.detalhe || null}, 'lio-app')`);

    await db.execute(sql`UPDATE lio_pedidos SET receivable_id = ${receivableId} WHERE id = ${pedido.id}`);

    console.log(`💰 [LIO-PDV] Venda ${pedido.reference} lancada no financeiro (titulo ${receivableId}, ${valor}).`);
    return { receivableId: String(receivableId) };
  } catch (e: any) {
    // O dinheiro JA entrou na maquininha. Nunca derrubar a resposta ao app por
    // causa disto: registra o erro e deixa visivel para tratamento.
    console.error('❌ [LIO-PDV] Falha ao lancar no financeiro:', e?.message || e);
    try {
      await db.execute(sql`UPDATE lio_pedidos
        SET error = ${'financeiro: ' + String(e?.message || e)}, updated_at = now()
        WHERE id = ${pedido.id}`);
    } catch { /* noop */ }
    return { receivableId: null, motivo: 'erro' };
  }
}

/**
 * Tira do faturamento o pedido de uma venda estornada na maquininha.
 *
 * POR QUE PRECISOU EXISTIR: quando a venda de balcao passou a virar sales_card
 * (para poder ser faturada), o cancelamento parou de ter efeito. A regra antiga
 * dizia "pedido COM sales_card se trata a mao", escrita quando venda de balcao
 * nunca tinha card. Depois da mudanca, TODA venda de balcao tem card — entao a
 * regra passou a valer sempre e o estorno virou letra morta: o dinheiro voltava
 * para o cliente e o pedido seguia caminhando para virar nota.
 *
 * O QUE DECIDE: se ja existe NOTA FISCAL emitida, nao mexe. Documento fiscal
 * emitido nao se apaga por app — vira tratamento humano (carta de correcao,
 * cancelamento junto a SEFAZ, o que o contador determinar). Sem nota, o pedido
 * vai para a Lixeira do pipeline e o card fica 'cancelled'.
 */
export async function cancelarCardBalcao(
  pedidoId: string,
  motivo?: string | null,
): Promise<{ cancelado: boolean; motivo: string; etapaAnterior?: string; notaFiscal?: string }> {
  const r: any = await db.execute(sql`SELECT sales_card_id, reference FROM lio_pedidos WHERE id = ${pedidoId} LIMIT 1`);
  const p = ((r.rows || r) as any[])[0];
  const cardId = p?.sales_card_id;
  if (!cardId) return { cancelado: false, motivo: 'sem_card' };

  const b: any = await db.execute(sql`SELECT id, stage, invoice_number
    FROM billing_pipeline WHERE sales_card_id = ${cardId} LIMIT 1`);
  const linha = ((b.rows || b) as any[])[0];

  // TRAVA FISCAL: com nota emitida, o app para aqui.
  if (linha?.invoice_number) {
    return { cancelado: false, motivo: 'ja_faturado', notaFiscal: String(linha.invoice_number) };
  }

  const carimbo = `\n[VENDA CANCELADA NA MAQUININHA ${new Date().toISOString().slice(0, 10)}] `
    + (motivo || 'estorno solicitado no balcao') + ` — pedido ${p.reference}.`;

  if (linha) {
    // O valor 'lixeira' e adicionado ao enum em runtime pelo modulo do pipeline;
    // repetimos aqui porque este caminho pode rodar antes daquele.
    try { await db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'lixeira'`); } catch { /* ja existe */ }
    await db.execute(sql`UPDATE billing_pipeline
      SET stage = 'lixeira', updated_at = now() WHERE id = ${linha.id}`);
  }

  await db.execute(sql`UPDATE sales_cards SET
      status = 'cancelled',
      notes = COALESCE(notes,'') || ${carimbo},
      updated_at = now()
    WHERE id = ${cardId}`);

  console.log(`↩️ [LIO-PDV] Pedido ${p.reference} retirado do faturamento (card ${cardId}).`);
  return { cancelado: true, motivo: 'retirado_do_faturamento', etapaAnterior: linha?.stage || undefined };
}

/**
 * Desfaz no financeiro uma venda de balcao estornada na maquininha.
 *
 * POR QUE PRECISOU EXISTIR: enquanto venda de balcao nao gerava titulo, o
 * cancelamento nao tinha o que reverter e registrar o estorno bastava. No
 * momento em que passamos a lancar em receivables, um cancelamento sem esta
 * funcao deixaria o titulo "recebida" de pe — dinheiro contado no fechamento de
 * caixa que a Cielo ja devolveu ao cliente.
 *
 * SEGUE O PADRAO DA CASA (server/financial-routes.ts, estornar-baixa):
 *   - recusa quando o titulo tem lastro bancario conciliado;
 *   - apaga as baixas e zera amount_paid;
 *   - carimba o motivo em `notes`, que e a trilha que gente le depois.
 *
 * DIFERENCA: la se estorna a BAIXA de um titulo que continua devido. Aqui a
 * venda inteira deixou de existir, entao o titulo termina 'cancelada' — nao ha
 * o que cobrar de um cliente que devolveu o produto.
 */
export async function estornarRecebimentoBalcao(
  req: any,
  pedido: { id: string; reference?: string | null; motivo?: string | null },
): Promise<{ revertido: boolean; motivo: string; receivableId?: string; valor?: string }> {
  await ensurePdvSchema();

  const p: any = await db.execute(sql`SELECT receivable_id FROM lio_pedidos WHERE id = ${pedido.id} LIMIT 1`);
  const receivableId = ((p.rows || p) as any[])[0]?.receivable_id;
  if (!receivableId) return { revertido: false, motivo: 'sem_titulo' };

  const t: any = await db.execute(sql`SELECT id, amount, amount_paid, status, notes
    FROM receivables WHERE id = ${receivableId} AND deleted_at IS NULL LIMIT 1`);
  const titulo = ((t.rows || t) as any[])[0];
  if (!titulo) return { revertido: false, motivo: 'titulo_inexistente' };

  // JA CANCELADO: sai antes de tocar em qualquer coisa.
  //
  // O app reenvia o cancelamento quando a rede oscila, e sem esta saida cada
  // reenvio carimbava mais uma linha "[VENDA CANCELADA...]" no notes do titulo.
  // O dinheiro ficava certo — apagar baixa ja apagada e inofensivo — mas a
  // trilha que gente le para entender o que aconteceu enchia de repeticao, e
  // a resposta dizia "revertido" para uma operacao que nao reverteu nada.
  if (String(titulo.status) === 'cancelada') {
    return { revertido: false, motivo: 'ja_cancelado', receivableId: String(receivableId), valor: String(titulo.amount) };
  }

  // TRAVA: titulo com lastro bancario nao se mexe por aqui. Quem conciliou
  // precisa desfazer a conciliacao antes — mesma regra do estorno manual.
  try {
    const q: any = await db.execute(sql`SELECT EXISTS(
      SELECT 1 FROM bank_statement_item_matches m WHERE m.receivable_id = ${receivableId}) AS conciliado`);
    if (((q.rows || q) as any[])[0]?.conciliado === true) {
      return { revertido: false, motivo: 'conciliado', receivableId: String(receivableId) };
    }
  } catch { /* tabela ausente em ambiente antigo: segue */ }

  const carimbo = `[VENDA CANCELADA NA MAQUININHA ${new Date().toISOString().slice(0, 10)}] `
    + (pedido.motivo || 'estorno solicitado no balcao')
    + ` (pedido ${pedido.reference || pedido.id}, R$ ${titulo.amount}).`;

  await db.execute(sql`DELETE FROM receivable_payments WHERE receivable_id = ${receivableId}`);
  await db.execute(sql`UPDATE receivables SET
      amount_paid = '0.00',
      status = 'cancelada',
      notes = CASE WHEN COALESCE(notes,'') = '' THEN ${carimbo} ELSE notes || ${'\n' + carimbo} END,
      updated_at = now(),
      updated_by = 'lio-app'
    WHERE id = ${receivableId}`);

  // Auditoria e desejavel, nao critica: se falhar, o estorno ja aconteceu e
  // derrubar a resposta aqui so faria o app achar que o cancelamento falhou.
  try {
    const { logFinancialAudit } = await import('./financial-audit');
    await logFinancialAudit({
      req, action: 'reverse', entity: 'receivable', entityId: String(receivableId),
      before: titulo, amount: Number(titulo.amount || 0),
      note: 'venda de balcao cancelada na maquininha: ' + (pedido.motivo || 'sem motivo informado'),
    } as any);
  } catch (e: any) {
    console.warn('⚠️ [LIO-PDV] Estorno feito, auditoria falhou:', e?.message || e);
  }

  console.log(`↩️ [LIO-PDV] Titulo ${receivableId} cancelado (venda ${pedido.reference || pedido.id}).`);
  return { revertido: true, motivo: 'cancelado', receivableId: String(receivableId), valor: String(titulo.amount) };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

type Autenticador = (req: any, res: Response, next: any) => void;

export function registerLioPdv(app: Express, autenticarDispositivo: Autenticador): void {

  /**
   * Catalogo para a grade de produtos.
   *
   * As imagens NAO vem aqui. Sao 4,4 MB de base64 no banco — enfiar isso no
   * JSON faria a tela demorar a abrir a cada consulta, numa maquininha com
   * memoria curta. Vem so a marca `temImagem`; os bytes vem sob demanda pela
   * rota de imagem, que o app cacheia em disco.
   */
  app.get('/api/lio-app/catalogo', autenticarDispositivo, async (_req: any, res) => {
    try {
      await ensurePdvSchema();
      const r: any = await db.execute(sql`SELECT id, omie_code, name, retail_price, wholesale_price, image_url, ncm
        FROM products WHERE is_active = true ORDER BY name ASC`);
      const linhas = (r.rows || r) as any[];

      const produtos = linhas.map((p) => {
        const varejo = reaisParaCentavos(p.retail_price);
        const atacado = reaisParaCentavos(p.wholesale_price);
        return {
          id: String(p.id),
          codigo: p.omie_code || '',
          nome: String(p.name || ''),
          ncm: p.ncm || null,
          varejoCentavos: varejo,
          atacadoCentavos: atacado,
          // O app usa isto para esmaecer o produto no modo atacado em vez de
          // inventar preco. Ver a decisao registrada no LEIA-ME do PDV.
          disponivelVarejo: varejo !== null && varejo > 0,
          disponivelAtacado: atacado !== null && atacado > 0,
          temImagem: !!p.image_url,
        };
      })
      // Produto sem preco de varejo nao tem como ser vendido no balcao.
      .filter((p) => p.disponivelVarejo || p.disponivelAtacado);

      res.json({
        produtos,
        atacadoAPartirDeCentavos: ATACADO_A_PARTIR_DE_CENTAVOS,
        semPrecoAtacado: produtos.filter((p) => !p.disponivelAtacado).map((p) => p.codigo),
      });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /**
   * Bytes da imagem do produto.
   *
   * O banco guarda data URI base64. Devolver JPEG binario corta 33% do trafego
   * (o overhead do proprio base64) e deixa o app gravar direto em arquivo, sem
   * decodificar string gigante na memoria do aparelho.
   *
   * ETag: depois da primeira carga o aparelho recebe 304 e nao baixa de novo.
   */
  app.get('/api/lio-app/produto/:id/imagem', autenticarDispositivo, async (req: any, res) => {
    try {
      const r: any = await db.execute(sql`SELECT image_url FROM products WHERE id = ${String(req.params.id)} LIMIT 1`);
      const url = ((r.rows || r) as any[])[0]?.image_url;
      if (!url) return res.status(404).json({ message: 'Produto sem imagem.' });

      const texto = String(url);

      // Imagem hospedada fora: manda o app buscar la, sem proxy.
      if (/^https?:\/\//i.test(texto)) return res.redirect(302, texto);

      const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(texto);
      if (!m) return res.status(415).json({ message: 'Formato de imagem nao suportado.' });

      const buf = Buffer.from(m[2], 'base64');
      const etag = `"${createHash('sha1').update(buf).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      res.setHeader('Content-Type', m[1] || 'image/jpeg');
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(buf);
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /**
   * Busca de clientes para o botao opcional "Identificar cliente".
   *
   * Limite baixo e resposta magra de proposito: a tela da maquininha nao
   * comporta lista longa, e nao ha razao para o aparelho receber endereco,
   * telefone e coordenadas de cliente nenhum.
   */
  app.get('/api/lio-app/clientes', autenticarDispositivo, async (req: any, res) => {
    try {
      const busca = String(req.query?.busca || '').trim();
      if (busca.length < 3) return res.json({ clientes: [] });
      const like = `%${busca.toLowerCase()}%`;
      const digitos = busca.replace(/\D/g, '');

      const r: any = await db.execute(sql`SELECT id, name, cpf, cnpj, city
        FROM customers
        WHERE is_active = true AND (
          lower(name) LIKE ${like}
          OR (${digitos} <> '' AND (cpf LIKE ${'%' + digitos + '%'} OR cnpj LIKE ${'%' + digitos + '%'}))
        )
        ORDER BY name ASC LIMIT 15`);

      res.json({
        clientes: ((r.rows || r) as any[]).map((c) => ({
          id: String(c.id),
          nome: String(c.name || ''),
          documento: c.cnpj || c.cpf || null,
          cidade: c.city || null,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /**
   * Fecha o carrinho e cria o pedido a cobrar.
   *
   * O app manda SO produtoId e quantidade. Preco, nome e total sao resolvidos
   * aqui contra o banco — ver a decisao 1 no topo do arquivo.
   *
   * O pedido nasce em lio_pedidos com origem 'pdv' e status AGUARDANDO, e dali
   * para a frente percorre exatamente o mesmo caminho ja provado em producao:
   * deep link -> /pedido/:id/pago -> liquidacao. Nao existe caminho de cobranca
   * paralelo para o balcao.
   */
  app.post('/api/lio-app/venda', autenticarDispositivo, async (req: any, res) => {
    try {
      await ensurePdvSchema();
      const body = req.body || {};
      const tabela: TabelaPreco = body.tabela === 'atacado' ? 'atacado' : 'varejo';
      const itensPedidos: any[] = Array.isArray(body.itens) ? body.itens : [];
      if (!itensPedidos.length) return res.status(400).json({ message: 'Carrinho vazio.' });
      if (itensPedidos.length > 60) return res.status(400).json({ message: 'Carrinho grande demais.' });

      // Agrupa por produto: dois toques no mesmo item viram quantidade 2, e nao
      // duas linhas iguais no comprovante.
      const quantidades = new Map<string, number>();
      for (const it of itensPedidos) {
        const id = String(it?.produtoId || '').trim();
        const q = Number(it?.quantidade);
        if (!id) return res.status(400).json({ message: 'Item sem produtoId.' });
        if (!Number.isInteger(q) || q <= 0 || q > 999) {
          return res.status(400).json({ message: `Quantidade invalida para o produto ${id}.` });
        }
        quantidades.set(id, (quantidades.get(id) || 0) + q);
      }

      const ids = Array.from(quantidades.keys());
      // sql.join e nao `IN ${ids}`: o template do drizzle nao expande array em
      // lista de parametros — passaria o array inteiro como UM parametro e a
      // consulta nunca casaria.
      const listaIds = sql.join(ids.map((i) => sql`${i}`), sql`, `);
      const r: any = await db.execute(sql`SELECT id, omie_code, name, retail_price, wholesale_price
        FROM products WHERE is_active = true AND id IN (${listaIds})`);
      const achados = new Map(((r.rows || r) as any[]).map((p) => [String(p.id), p]));

      const itens: any[] = [];
      let totalCentavos = 0;

      for (const [id, quantidade] of quantidades) {
        const p = achados.get(id);
        if (!p) return res.status(400).json({ message: `Produto ${id} nao encontrado ou inativo.` });

        const unit = tabela === 'atacado'
          ? reaisParaCentavos(p.wholesale_price)
          : reaisParaCentavos(p.retail_price);

        // A trava combinada: sem preco na tabela escolhida, a venda para aqui.
        // Cair para o outro preco silenciosamente cobraria valor errado sem
        // ninguem perceber no caixa.
        if (unit === null || unit <= 0) {
          return res.status(409).json({
            message: `"${p.name}" nao tem preco de ${tabela} cadastrado. Cadastre no Omie ou troque a tabela.`,
            produtoId: id,
            codigo: p.omie_code || null,
            tabela,
          });
        }

        totalCentavos += unit * quantidade;
        itens.push({
          // Formato que o deep link da Cielo espera — o app repassa sem mexer.
          sku: p.omie_code || String(p.id).slice(0, 8),
          name: String(p.name),
          quantity: quantidade,
          unitOfMeasure: 'unidade',
          unitPrice: unit,
          produtoId: String(p.id),
        });
      }

      if (totalCentavos <= 0) return res.status(400).json({ message: 'Total invalido.' });

      // Cliente e opcional; quando vem, o nome e lido do banco e nao do app.
      let clienteId: string | null = null;
      let clienteNome: string | null = null;
      if (body.clienteId) {
        const c: any = await db.execute(sql`SELECT id, name FROM customers WHERE id = ${String(body.clienteId)} LIMIT 1`);
        const cli = ((c.rows || c) as any[])[0];
        if (!cli) return res.status(400).json({ message: 'Cliente nao encontrado.' });
        clienteId = String(cli.id);
        clienteNome = String(cli.name);
      }

      const referencia = String(body.referencia || '').trim()
        || `BALCAO-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;

      const ins: any = await db.execute(sql`INSERT INTO lio_pedidos
        (reference, status, origem, dispositivo_id, amount, payload,
         tabela_preco, cliente_id, cliente_nome)
        VALUES (${referencia}, 'AGUARDANDO', 'pdv', ${req.dispositivo?.id || null},
                ${centavosParaReais(totalCentavos)},
                ${JSON.stringify({ itens })},
                ${tabela}, ${clienteId}, ${clienteNome})
        RETURNING id`);
      const id = ((ins.rows || ins) as any[])[0]?.id;

      console.log(`🧾 [LIO-PDV] Venda ${referencia} criada (${tabela}, ${itens.length} itens, ${centavosParaReais(totalCentavos)}).`);

      res.status(201).json({
        id: String(id),
        reference: referencia,
        valorCentavos: totalCentavos,
        tabela,
        cliente: clienteNome,
        itens: itens.map(({ produtoId, ...resto }) => resto),
      });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });
}
