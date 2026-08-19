// ============================================================================
// LINK DE PAGAMENTO (cartão de crédito + Google Pay) — INTEGRA 2.0 / Honest
// ----------------------------------------------------------------------------
// Motivo: no hotsite o cliente tem uma tela para digitar o cartão / tocar no
// Google Pay. Num DM do Instagram ou numa conversa de WhatsApp isso não existe:
// o atendente (humano ou IA) precisa mandar um LINK. Este módulo cria esse link
// e serve a página hospedada em /pay/<token>.
//
// PRINCÍPIOS (mesmos do hotsite-card.ts):
//  - Cartão NUNCA é gravado nem logado — só os 4 últimos dígitos.
//  - Tokenização do Google Pay no navegador; a Cielo decripta (PAN não passa aqui).
//  - Cobrança é SÍNCRONA e ÚNICA (autoriza+captura). Nunca repetir automaticamente.
//  - O total é sempre o do link (definido no servidor); o cliente não digita valor.
//  - Ao aprovar, grava em hotsite_card_payments com order_id = sales_card, que é o
//    sinal que o pipeline já usa hoje (badge PAGO + baixa automática ao faturar).
//
// A página é HTML servido pelo Express (string), de propósito: NÃO depende do
// build do hotsite (hotsite/dist -> server/public-hotsite), então entra no ar
// junto com o deploy do servidor, sem rebuild manual.
// ============================================================================
import type { Express } from 'express';
// Hora oficial do Brasil — regra unica em shared/tempo.ts.
import { diaBR, hojeBR, dataCalendario } from '@shared/tempo';
import crypto from 'crypto';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser } from './authMiddleware';
import {
  cieloConfig,
  createCardSale,
  createGooglePaySale,
  queryByMerchantOrderId,
  ensureHotsiteCardTable,
  detectBrand,
  luhnOk,
  friendlyDecline,
} from './hotsite-card';
import { storage } from './storage';
import { cancelarBoleto } from './bb-boleto-service';
import { lancarNaConta } from './account-ledger';
import {
  cieloLinkEnabled,
  createCieloLink,
  shortOrderNumber,
  parseLinkWebhook,
  queryCieloOrder,
  logLinkWebhook,
  cieloLinkDiag,
} from './cielo-link';

const APP_URL = (process.env.APP_URL || 'https://integracode-production.up.railway.app').replace(/\/+$/, '');
// Domínio "limpo" da loja — melhor para mandar num DM. Cai no mesmo servidor.
const LINK_BASE = (process.env.PAYMENT_LINK_BASE_URL || APP_URL).replace(/\/+$/, '');

const DEFAULT_TTL_HOURS = Number(process.env.PAYMENT_LINK_TTL_HOURS || 48);
const MAX_ATTEMPTS = 5;

function onlyDigits(s: any): string { return String(s || '').replace(/\D/g, ''); }
function brl(v: any): string {
  const n = Number(v);
  return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function esc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _plReady = false;
async function ensurePaymentLinkTable(): Promise<void> {
  if (_plReady) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS payment_links (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    token varchar NOT NULL UNIQUE,
    kind varchar NOT NULL DEFAULT 'order',
    sales_card_id varchar,
    order_number varchar,
    conversation_id varchar,
    channel varchar,
    customer_name varchar,
    customer_document varchar,
    customer_phone varchar,
    amount numeric(12,2) NOT NULL,
    description varchar,
    status varchar NOT NULL DEFAULT 'pending',
    merchant_order_id varchar,
    payment_id varchar,
    tid varchar,
    brand varchar,
    card_last4 varchar,
    wallet varchar,
    return_code varchar,
    return_message text,
    attempts int NOT NULL DEFAULT 0,
    expires_at timestamptz,
    paid_at timestamptz,
    created_by varchar,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`));
  try { await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_paylink_card ON payment_links (sales_card_id)`)); } catch {}
  try { await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_paylink_status ON payment_links (status)`)); } catch {}
  try { await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_paylink_conv ON payment_links (conversation_id)`)); } catch {}
  // Colunas do provedor "Cielo Link & Checkout" (matriz 0001-53) — aditivas e idempotentes.
  for (const c of [
    `provider varchar NOT NULL DEFAULT 'ecommerce'`,
    `checkout_url text`,
    `cielo_product_id varchar`,
    `nsu varchar`,
    `authorization_code varchar`,
    `is_test boolean NOT NULL DEFAULT false`,
    `receivable_id varchar`,
  ]) {
    try { await db.execute(sql.raw(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS ${c}`)); } catch {}
  }
  try { await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_paylink_moid ON payment_links (merchant_order_id)`)); } catch {}
  _plReady = true;
}

export type CreatePaymentLinkArgs = {
  kind?: 'order' | 'avulso' | 'receivable';
  salesCardId?: string | null;
  receivableId?: string | null;   // Contas a Receber: titulo ja faturado
  orderNumber?: string | null;
  conversationId?: string | null;
  channel?: string | null;           // instagram | whatsapp | manual
  customerName?: string | null;
  customerDocument?: string | null;
  customerPhone?: string | null;
  amount: number;
  description?: string | null;
  ttlHours?: number;
  createdBy?: string | null;
};

// Cria (ou reaproveita) o link de pagamento. Se já existe um link PENDENTE e não
// expirado para o mesmo pedido, devolve o mesmo — evita mandar 2 links ao cliente.
export async function createPaymentLink(args: CreatePaymentLinkArgs): Promise<{
  ok: boolean; token?: string; url?: string; amount?: number; reused?: boolean; error?: string;
}> {
  try {
    const amount = Math.round((Number(args.amount) || 0) * 100) / 100;
    if (!(amount > 0)) return { ok: false, error: 'valor invalido' };
    // Provedor: quando CIELO_LINK_ENABLED=true usamos o "Link & Checkout" da MATRIZ
    // (0001-53). Senao, o caminho antigo da API E-commerce 3.0 (filial 0002-34).
    const useLink = cieloLinkEnabled();
    if (!useLink) {
      const cfg = cieloConfig();
      if (!cfg.merchantId || !cfg.merchantKey) return { ok: false, error: 'cielo nao configurada' };
    }
    await ensurePaymentLinkTable();

    // Titulo de Contas a Receber: um titulo tem no maximo UM link pendente.
    if (args.receivableId) {
      const jp: any = await db.execute(sql`SELECT 1 FROM payment_links WHERE receivable_id = ${args.receivableId} AND status = 'paid' LIMIT 1`);
      if (((jp.rows || jp) as any[]).length) return { ok: false, error: 'titulo ja pago por link' };
      const ex2: any = await db.execute(sql`SELECT token, amount FROM payment_links
        WHERE receivable_id = ${args.receivableId} AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1`);
      const row2 = (ex2.rows || ex2)[0];
      if (row2 && Math.abs(Number(row2.amount) - amount) < 0.01) {
        return { ok: true, token: row2.token, url: `${LINK_BASE}/pay/${row2.token}`, amount, reused: true };
      }
      try { await db.execute(sql`UPDATE payment_links SET status = 'canceled', updated_at = now()
        WHERE receivable_id = ${args.receivableId} AND status = 'pending'`); } catch {}
    }

    if (args.salesCardId) {
      if (await orderAlreadyPaid(args.salesCardId)) return { ok: false, error: 'pedido ja pago' };
      const ex: any = await db.execute(sql`SELECT token, amount FROM payment_links
        WHERE sales_card_id = ${args.salesCardId} AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1`);
      const row = (ex.rows || ex)[0];
      if (row && Math.abs(Number(row.amount) - amount) < 0.01) {
        return { ok: true, token: row.token, url: `${LINK_BASE}/pay/${row.token}`, amount, reused: true };
      }
    }

    // Um pedido tem no maximo UM link pendente: cancela os anteriores (ex.: valor mudou).
    if (args.salesCardId) {
      try { await db.execute(sql`UPDATE payment_links SET status = 'canceled', updated_at = now()
        WHERE sales_card_id = ${args.salesCardId} AND status = 'pending'`); } catch {}
    }

    const token = crypto.randomBytes(16).toString('hex'); // 32 chars, imprevisível
    const ttl = Math.max(1, Number(args.ttlHours || DEFAULT_TTL_HOURS));
    const expiresAt = new Date(Date.now() + ttl * 3600 * 1000).toISOString();

    // Com o Link & Checkout, quem hospeda a tela de pagamento e a Cielo. Criamos o
    // link LA antes de gravar aqui — se a Cielo recusar, nao deixamos link orfao.
    let provider = 'ecommerce';
    let checkoutUrl: string | null = null;
    let cieloProductId: string | null = null;
    let merchantOrderId: string | null = null;

    if (useLink) {
      merchantOrderId = shortOrderNumber('PL'); // <= 20 chars: e a CHAVE do webhook
      const created = await createCieloLink({
        name: args.orderNumber ? `Pedido ${args.orderNumber} - Honest Sucos` : 'Pagamento - Honest Sucos',
        amount,
        orderNumber: merchantOrderId,
        description: args.description || (args.customerName ? `Cliente: ${args.customerName}` : null),
        // A Cielo interpreta expirationDate como data LOCAL do lojista (BRT). Com
        // toISOString() ia o dia UTC: um TTL que termina entre 21:00 e 00:00 BRT fazia
        // o link expirar um dia DEPOIS do pretendido.
        expirationDate: diaBR(Date.now() + ttl * 3600 * 1000),
        softDescriptor: 'HONEST',
        sku: args.orderNumber || null,
      });
      if (!created.ok || !created.checkoutUrl) {
        console.error('❌ [PAY-LINK] Cielo Link recusou a criacao:', created.error);
        return { ok: false, error: created.error || 'falha ao criar o link na Cielo' };
      }
      provider = 'cielolink';
      checkoutUrl = created.checkoutUrl;
      cieloProductId = created.productId || null;
    }

    await db.execute(sql`INSERT INTO payment_links
      (token, kind, sales_card_id, order_number, conversation_id, channel, customer_name,
       customer_document, customer_phone, amount, description, expires_at, created_by,
       provider, checkout_url, cielo_product_id, merchant_order_id, receivable_id)
      VALUES (${token}, ${args.kind || (args.receivableId ? 'receivable' : (args.salesCardId ? 'order' : 'avulso'))}, ${args.salesCardId || null},
              ${args.orderNumber || null}, ${args.conversationId || null}, ${args.channel || null},
              ${args.customerName || null}, ${onlyDigits(args.customerDocument) || null},
              ${onlyDigits(args.customerPhone) || null}, ${amount.toFixed(2)}, ${args.description || null},
              ${expiresAt}::timestamptz, ${args.createdBy || null},
              ${provider}, ${checkoutUrl}, ${cieloProductId}, ${merchantOrderId}, ${args.receivableId || null})`);
    console.log(`🔗 [PAY-LINK] criado token=${token.slice(0, 8)}… card=${args.salesCardId || '-'} total=${amount.toFixed(2)} canal=${args.channel || '-'}`);
    return { ok: true, token, url: `${LINK_BASE}/pay/${token}`, amount, reused: false };
  } catch (e: any) {
    console.error('❌ [PAY-LINK] createPaymentLink:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Trava anti-cobranca-dupla: o pedido ja foi pago online (por link, pela loja ou por PIX)?
export async function orderAlreadyPaid(salesCardId?: string | null): Promise<boolean> {
  if (!salesCardId) return false;
  try {
    const a: any = await db.execute(sql`SELECT 1 FROM payment_links WHERE sales_card_id = ${salesCardId} AND status = 'paid' LIMIT 1`);
    if (((a.rows || a) as any[]).length) return true;
  } catch {}
  try {
    const b: any = await db.execute(sql`SELECT 1 FROM hotsite_card_payments WHERE order_id = ${salesCardId} AND status = 'paid' LIMIT 1`);
    if (((b.rows || b) as any[]).length) return true;
  } catch {}
  try {
    const c: any = await db.execute(sql`SELECT 1 FROM hotsite_pending_pix WHERE order_id = ${salesCardId} AND status = 'paid' LIMIT 1`);
    if (((c.rows || c) as any[]).length) return true;
  } catch {}
  // Maquininha Cielo Smart (app do balcao). Sem esta linha, um pedido ja pago
  // no aparelho ainda poderia receber link de pagamento — cobranca em dobro no
  // cliente. O try/catch cobre o banco onde a tabela ainda nao existe.
  try {
    const d: any = await db.execute(sql`SELECT 1 FROM lio_pedidos WHERE sales_card_id = ${salesCardId} AND liquidado = true LIMIT 1`);
    if (((d.rows || d) as any[]).length) return true;
  } catch {}
  return false;
}

async function loadLink(token: string): Promise<any | null> {
  await ensurePaymentLinkTable();
  const r: any = await db.execute(sql`SELECT * FROM payment_links WHERE token = ${String(token || '')} LIMIT 1`);
  return (r.rows || r)[0] || null;
}

function linkState(link: any): 'pending' | 'paid' | 'expired' | 'canceled' | 'blocked' {
  if (!link) return 'canceled';
  if (link.status === 'paid') return 'paid';
  if (link.status === 'canceled') return 'canceled';
  if (Number(link.attempts || 0) >= MAX_ATTEMPTS) return 'blocked';
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'pending';
}

function googlePayPublicConfig() {
  const cfg = cieloConfig();
  const gpMerchantId = String(process.env.GOOGLE_PAY_MERCHANT_ID || '').trim();
  const gpEnv = String(process.env.GOOGLE_PAY_ENV || 'TEST').toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'TEST';
  return {
    enabled: !!(cfg.merchantId && cfg.merchantKey && gpMerchantId),
    environment: gpEnv,
    merchantId: gpMerchantId,
    merchantName: 'Honest Sucos',
    gateway: 'cielo',
    gatewayMerchantId: cfg.merchantId,
    allowedCardNetworks: ['MASTERCARD', 'VISA', 'ELO', 'AMEX'],
    allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
  };
}

// ---------------------------------------------------------------------------
// Pós-aprovação: registra o pagamento no MESMO lugar que a loja já usa, para o
// pipeline enxergar "pago na loja" (badge PAGO + baixa automática ao faturar).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CONTAS A RECEBER — o titulo JA foi faturado, entao pagar o link significa DAR
// BAIXA no recebivel (nao marcar pedido). Espelha o settleBoletoCharge do BB:
// atualiza o titulo, grava receivable_payments, credita a conta CARTOES e move
// o saldo. Depois BAIXA a cobranca antiga (boleto no BB / PIX) para o cliente
// nao conseguir pagar duas vezes o mesmo titulo.
// ---------------------------------------------------------------------------
async function findCardAccount(): Promise<any | null> {
  try {
    const r: any = await db.execute(sql`SELECT * FROM financial_accounts
      WHERE upper(name) = 'CARTOES' OR upper(name) LIKE 'CART%' ORDER BY (upper(name) = 'CARTOES') DESC LIMIT 1`);
    return (r.rows || r)[0] || null;
  } catch { return null; }
}

async function cancelarCobrancaAntiga(receivableId: string): Promise<{ boletos: number; pix: number; erros: string[] }> {
  const out = { boletos: 0, pix: 0, erros: [] as string[] };
  try {
    const bq: any = await db.execute(sql`SELECT * FROM boleto_charges
      WHERE receivable_id = ${receivableId} AND status NOT IN ('cancelado','cancelada','liquidado','pago','recebido')
      ORDER BY created_at DESC`);
    for (const boleto of ((bq.rows || bq) as any[])) {
      if (/(liquid|pag|receb)/i.test(String(boleto.status || ''))) continue; // ja pago: nao mexer
      try {
        const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL LIMIT 1`);
        const accId = (accq.rows || accq)[0]?.id;
        if (accId) {
          const c = await cancelarBoleto(accId, boleto);
          if (!c.ok && !c.alreadyBaixado) { out.erros.push(`boleto ${boleto.nosso_numero || boleto.id}: ${c.error || 'falha'}`); continue; }
        }
        await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado' WHERE id = ${boleto.id}`);
        out.boletos++;
      } catch (e: any) { out.erros.push(`boleto ${boleto.id}: ${e?.message || e}`); }
    }
  } catch { /* tabela pode nao existir */ }
  try {
    const pu: any = await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR'
      WHERE receivable_id = ${receivableId} AND status = 'ATIVA'`);
    out.pix = (pu?.rowCount ?? 0) as number;
  } catch { /* idem */ }
  return out;
}

async function settleReceivableByLink(link: any, sale: any, opts: { last4?: string; brand?: string }): Promise<void> {
  const receivableId = String(link.receivable_id || '');
  if (!receivableId) return;
  const paid = Number(link.amount) || 0;
  try {
    const receivable: any = await storage.getReceivable(receivableId);
    if (!receivable) { console.error(`❌ [PAY-LINK] recebivel ${receivableId} nao encontrado`); return; }

    const total = parseFloat(receivable.amount || '0');
    const already = parseFloat(receivable.amountPaid || '0');
    if (already >= total) { console.log(`ℹ️ [PAY-LINK] recebivel ${receivableId} ja estava quitado`); return; }

    const account = await findCardAccount();
    const novoPago = already + paid;
    const status = novoPago >= total ? 'recebida' : 'a_vencer';

    await storage.updateReceivable(receivableId, {
      amountPaid: novoPago.toFixed(2),
      status: status as any,
      paymentMethod: 'cartao_credito' as any,
      financialAccountId: account?.id || receivable.financialAccountId || null,
    } as any);

    try {
      await storage.createReceivablePayment({
        receivableId,
        // receivable_payments.paid_at e DATA DE CALENDARIO em todo o sistema (a baixa manual
        // grava meia-noite UTC e a conciliacao compara paid_at::date com o extrato).
        // Com new Date() o webhook gravava um instante e o pagamento confirmado entre
        // 21:00 e 00:00 BRT caia no dia seguinte no DRE e na conciliacao.
        paidAt: dataCalendario(hojeBR()),
        amount: paid.toFixed(2),
        paymentMethod: 'cartao_credito' as any,
        financialAccountId: account?.id || receivable.financialAccountId || null,
        reference: sale?.paymentId || link.merchant_order_id || null,
        notes: `Baixa automatica por LINK DE PAGAMENTO (cartao Cielo${opts.brand ? ' ' + opts.brand : ''}${opts.last4 ? ' final ' + opts.last4 : ''}) - pedido Cielo ${link.merchant_order_id || '-'}`,
        createdBy: 'link-pagamento',
      } as any);
    } catch (e: any) { console.warn('⚠️ [PAY-LINK] createReceivablePayment falhou:', e?.message || e); }

    if (account) {
      try {
        // FIX: os nomes dos campos estavam errados (movementType/referenceType/
        // referenceId em vez de type/sourceType/sourceId) e faltavam type e
        // balanceAfter, que sao NOT NULL. O insert falhava SEMPRE, o catch abaixo
        // so logava — e o saldo ja tinha subido na linha anterior. Resultado: todo
        // pagamento por link inflava o saldo sem deixar rastro no extrato interno.
        // O movimento agora e gravado PRIMEIRO: se ele falhar, o saldo nao sobe.
        // Saldo e movimento numa transacao so (ver server/account-ledger.ts).
        await lancarNaConta({
          accountId: account.id, tipo: 'credito', valor: paid,
          descricao: `Recebimento por link de pagamento (cartao) - titulo ${receivable.titleNumber || receivableId}`,
          sourceType: 'receivable', sourceId: receivableId, reference: receivableId,
          createdBy: 'link-pagamento', idempotente: true,
        });
      } catch (e: any) { console.warn('⚠️ [PAY-LINK] credito na conta falhou:', e?.message || e); }
    }

    // Anti-cobranca-dupla: baixa o boleto no BB e remove o PIX que ainda estiverem abertos.
    const canc = await cancelarCobrancaAntiga(receivableId);
    console.log(`✅ [PAY-LINK] recebivel ${receivableId} baixado por cartao (R$ ${paid.toFixed(2)}, status ${status}); boletos cancelados=${canc.boletos} pix=${canc.pix}${canc.erros.length ? ' erros=' + canc.erros.join('; ') : ''}`);
  } catch (e: any) {
    console.error('❌ [PAY-LINK] settleReceivableByLink:', e?.message || e);
  }
}

async function afterApproved(link: any, sale: any, opts: { wallet?: string; last4?: string; brand?: string }): Promise<void> {
  // Titulo de Contas a Receber: baixa o recebivel e encerra aqui (nao e pedido novo).
  if (String(link.kind || '') === 'receivable' || link.receivable_id) {
    await settleReceivableByLink(link, sale, opts);
    return;
  }
  const merchantOrderId = link.merchant_order_id;
  try {
    await ensureHotsiteCardTable();
    await db.execute(sql`INSERT INTO hotsite_card_payments
      (merchant_order_id, payment_id, amount, installments, card_last4, card_brand, status,
       return_code, return_message, order_id, order_number, payload)
      VALUES (${merchantOrderId}, ${sale.paymentId || null}, ${Number(link.amount).toFixed(2)}, 1,
              ${opts.last4 || null}, ${opts.brand || (opts.wallet === 'googlepay' ? 'GooglePay' : null)}, 'paid',
              ${sale.returnCode || null}, ${sale.returnMessage || null},
              ${link.sales_card_id || null}, ${link.order_number || null},
              ${JSON.stringify({ via: 'payment-link', token: String(link.token).slice(0, 8) + '…', channel: link.channel || null, conversationId: link.conversation_id || null })})`);
  } catch (e: any) {
    console.error('⚠️ [PAY-LINK] falha ao registrar em hotsite_card_payments:', e?.message || e);
  }

  if (!link.sales_card_id) return;

  const via = opts.wallet === 'googlepay' ? 'GOOGLE PAY' : 'CARTÃO';
  try {
    await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') ||
      ${'\n💳 ' + via + ' APROVADO por link de pagamento (Cielo PaymentId ' + (sale.paymentId || '?') + ') — enviado pelo canal ' + String(link.channel || '-') + '.'}
      WHERE id = ${link.sales_card_id}`);
  } catch {}

  // Se o pedido tinha um PIX pendente aberto (fluxo do Instagram), fecha para não
  // ficar cobrando duas vezes o mesmo pedido.
  try {
    await db.execute(sql`UPDATE instagram_pix SET status = 'paid', paid_at = now(), updated_at = now()
      WHERE sales_card_id = ${link.sales_card_id} AND status IN ('registered','awaiting_payment')`);
  } catch {}

  // Empurra imediatamente para o pipeline de faturamento (mesmo caminho da loja).
  try {
    const { reconcilePendingOrders } = await import('./billing-pipeline-routes');
    await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [link.sales_card_id] } as any);
  } catch (e: any) {
    console.warn('⚠️ [PAY-LINK] envio imediato ao pipeline falhou:', e?.message || e);
  }
}

// Marca a tentativa ANTES de cobrar e devolve o merchantOrderId usado.
async function beginAttempt(link: any, prefix: string): Promise<string> {
  const merchantOrderId = prefix + Date.now() + Math.floor(Math.random() * 1000);
  await db.execute(sql`UPDATE payment_links
    SET attempts = attempts + 1, merchant_order_id = ${merchantOrderId}, updated_at = now()
    WHERE id = ${link.id}`);
  return merchantOrderId;
}

// ---------------------------------------------------------------------------
// CIELO LINK & CHECKOUT — aplica o status recebido por webhook (ou por consulta)
// no payment_links e, quando PAGO, dispara o MESMO afterApproved() de sempre.
// Idempotente: link ja pago nao e reprocessado.
// ---------------------------------------------------------------------------
async function applyCieloLinkStatus(orderNumber: string, n: any): Promise<void> {
  await ensurePaymentLinkTable();
  const r: any = await db.execute(sql`SELECT * FROM payment_links WHERE merchant_order_id = ${orderNumber} LIMIT 1`);
  const link = (r.rows || r)[0];
  if (!link) { console.warn(`⚠️ [CIELO-LINK] ${orderNumber} nao encontrado em payment_links`); return; }
  if (String(link.status) === 'paid') return; // ja processado

  // Transacao de TESTE (Modo de teste do painel) NUNCA vira venda.
  if (n.isTest) {
    console.log(`🧪 [CIELO-LINK] ${orderNumber} e TESTE (${n.statusLabel}) — ignorado para o pipeline.`);
    try {
      await db.execute(sql`UPDATE payment_links SET is_test = true, return_code = ${String(n.statusCode ?? '')},
        return_message = ${'teste: ' + String(n.statusLabel || '')}, updated_at = now() WHERE id = ${link.id}`);
    } catch {}
    return;
  }

  if (n.paid) {
    // Conferencia de valor: o link e a fonte da verdade do quanto se cobra.
    if (n.amount != null && Math.abs(Number(n.amount) - Number(link.amount)) > 0.01) {
      console.error(`❌ [CIELO-LINK] valor divergente em ${orderNumber}: cielo=${n.amount} link=${link.amount} — NAO marcado como pago.`);
      return;
    }
    await db.execute(sql`UPDATE payment_links SET status = 'paid', paid_at = now(),
      payment_id = ${n.tid || null}, tid = ${n.tid || null}, nsu = ${n.nsu || null},
      authorization_code = ${n.authorizationCode || null}, brand = ${n.brand || null},
      card_last4 = ${n.last4 || null}, return_code = ${String(n.statusCode ?? '')},
      return_message = ${String(n.statusLabel || 'pago')}, updated_at = now()
      WHERE id = ${link.id}`);
    const fresh: any = await db.execute(sql`SELECT * FROM payment_links WHERE id = ${link.id} LIMIT 1`);
    const l2 = (fresh.rows || fresh)[0] || link;
    await afterApproved(l2,
      { paymentId: n.tid, returnCode: String(n.statusCode ?? ''), returnMessage: String(n.statusLabel || 'pago') },
      { last4: n.last4 || undefined, brand: n.brand || undefined });
    console.log(`✅ [CIELO-LINK] ${orderNumber} PAGO (tid ${n.tid || '-'}) → pipeline atualizado.`);
    return;
  }

  try {
    await db.execute(sql`UPDATE payment_links SET return_code = ${String(n.statusCode ?? '')},
      return_message = ${String(n.statusLabel || '')}, updated_at = now() WHERE id = ${link.id}`);
  } catch {}
  const map: Record<number, string> = { 3: 'denied', 4: 'expired', 5: 'canceled' };
  const novo = map[Number(n.statusCode)];
  if (novo) {
    try { await db.execute(sql`UPDATE payment_links SET status = ${novo}, updated_at = now() WHERE id = ${link.id}`); } catch {}
  }
  console.log(`ℹ️ [CIELO-LINK] ${orderNumber} status=${n.statusLabel} (${n.statusCode})`);
}

// Rede de seguranca contra webhook perdido: consulta na Cielo os links ainda
// pendentes das ultimas N horas e aplica o status. Usada pela rota admin e pelo
// cron horario do scheduler.
export async function reconcileCieloLinks(hours = 48): Promise<{ checked: number; paid: number; erros: number }> {
  let checked = 0, paid = 0, erros = 0;
  if (!cieloLinkEnabled()) return { checked, paid, erros };
  try {
    await ensurePaymentLinkTable();
    const r: any = await db.execute(sql`SELECT merchant_order_id FROM payment_links
      WHERE provider = 'cielolink' AND status = 'pending' AND merchant_order_id IS NOT NULL
        AND created_at > now() - (${String(hours)} || ' hours')::interval
      ORDER BY created_at DESC LIMIT 300`);
    const rows = (r.rows || r) as any[];
    for (const row of rows) {
      const on = String(row.merchant_order_id || '');
      if (!on) continue;
      checked++;
      try {
        const q = await queryCieloOrder(on);
        if (q.ok && q.paid) {
          const raw: any = q.raw || {};
          await applyCieloLinkStatus(on, {
            orderNumber: on, paid: true, statusCode: 2, statusLabel: 'pago',
            amount: raw?.price != null ? Math.round(Number(raw.price)) / 100 : null,
            tid: raw?.payment?.tid || null, nsu: raw?.payment?.nsu || null,
            authorizationCode: raw?.payment?.authorizationCode || null,
            brand: raw?.payment?.brand || null, last4: null, isTest: false,
          });
          paid++;
        }
      } catch { erros++; }
      await new Promise((ok) => setTimeout(ok, 250)); // gentil com a API da Cielo
    }
    console.log(`🔁 [CIELO-LINK] reconciliacao: ${checked} verificados, ${paid} pagos, ${erros} erros`);
    try {
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
        VALUES ('cielo_link_reconcile_last', ${JSON.stringify({ at: new Date().toISOString(), hours, checked, paid, erros })}, 'cielo-link')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
    } catch {}
  } catch (e: any) {
    console.error('❌ [CIELO-LINK] reconciliacao:', e?.message || e);
  }
  return { checked, paid, erros };
}

export function registerPaymentLink(app: Express): void {
  // --------------------------------------------------- criacao (atendente/interno)
  // Usado pelo ChatCenter (atendente humano) e por qualquer fluxo interno que precise
  // mandar um link de cartao/Google Pay. A IA usa createPaymentLink() direto.
  app.post('/api/payment-links', authenticateUser, async (req: any, res) => {
    try {
      const b = req.body || {};
      let amount = Number(b.amount) || 0;
      let name = b.customerName || null;
      let doc = b.customerDocument || null;
      let orderNumber = b.orderNumber || null;

      // Se veio um pedido, o valor e SEMPRE o do pedido (nunca o que o cliente digita).
      if (b.salesCardId) {
        const c: any = await db.execute(sql`SELECT sc.id, sc.sale_value, sc.order_number, cu.name AS cname, cu.cpf_cnpj AS cdoc
          FROM sales_cards sc LEFT JOIN customers cu ON cu.id = sc.customer_id
          WHERE sc.id = ${String(b.salesCardId)} LIMIT 1`);
        const row = (c.rows || c)[0];
        if (!row) return res.status(404).json({ message: 'Pedido nao encontrado' });
        amount = Number(row.sale_value) || amount;
        name = name || row.cname || null;
        doc = doc || row.cdoc || null;
        orderNumber = orderNumber || row.order_number || null;
      }
      if (!(amount > 0)) return res.status(400).json({ message: 'Valor invalido' });

      const out = await createPaymentLink({
        kind: b.salesCardId ? 'order' : 'avulso',
        salesCardId: b.salesCardId || null,
        orderNumber,
        conversationId: b.conversationId || null,
        channel: b.channel || 'manual',
        customerName: name,
        customerDocument: doc,
        customerPhone: b.customerPhone || null,
        amount,
        description: b.description || null,
        ttlHours: b.ttlHours,
        createdBy: (req as any).currentUser?.email || (req as any).currentUser?.id || 'atendente',
      });
      if (!out.ok) return res.status(400).json({ message: out.error || 'Falha ao criar o link' });
      return res.json(out);
    } catch (e: any) {
      console.error('\u274c [PAY-LINK] create:', e?.message || e);
      return res.status(500).json({ message: 'Erro ao criar o link de pagamento.' });
    }
  });

  // ------------------------------------------- link para TITULO em aberto
  // Contas a Receber / Debitos Vencidos: gera o link do SALDO em aberto do titulo.
  // Ao pagar, o webhook da Cielo baixa o recebivel e cancela boleto/PIX antigos.
  app.post('/api/financial/receivables/:id/payment-link', authenticateUser, async (req: any, res) => {
    try {
      const rec: any = await storage.getReceivable(String(req.params.id));
      if (!rec) return res.status(404).json({ message: 'Titulo nao encontrado' });

      const total = parseFloat(rec.amount || '0');
      const pago = parseFloat(rec.amountPaid || '0');
      const saldo = Math.round((total - pago) * 100) / 100;
      if (!(saldo > 0)) return res.status(400).json({ message: 'Titulo sem saldo em aberto' });
      if (['recebida', 'cancelada'].includes(String(rec.status || ''))) {
        return res.status(409).json({ message: `Titulo ${rec.status} - nao cabe link de pagamento` });
      }

      const out = await createPaymentLink({
        kind: 'receivable',
        receivableId: rec.id,
        orderNumber: rec.titleNumber || null,
        channel: req.body?.channel || 'financeiro',
        customerName: rec.customerName || null,
        customerDocument: rec.customerDocument || null,
        customerPhone: req.body?.customerPhone || null,
        amount: saldo,
        description: `Titulo ${rec.titleNumber || ''}`.trim(),
        ttlHours: req.body?.ttlHours,
        createdBy: (req as any).currentUser?.email || 'financeiro',
      });
      if (!out.ok) return res.status(400).json({ message: out.error || 'Falha ao criar o link' });
      return res.json({ ...out, titleNumber: rec.titleNumber || null, customerName: rec.customerName || null });
    } catch (e: any) {
      console.error('❌ [PAY-LINK] receivable link:', e?.message || e);
      return res.status(500).json({ message: 'Erro ao criar o link do titulo.' });
    }
  });

  // ---------------------------------------------------------------- estado
  app.get('/api/public/pay-link/:token', async (req, res) => {
    try {
      const link = await loadLink(req.params.token);
      if (!link) return res.status(404).json({ state: 'notfound' });
      res.json({
        state: linkState(link),
        amount: Number(link.amount),
        description: link.description || null,
        customerName: link.customer_name || null,
        orderNumber: link.order_number || null,
        expiresAt: link.expires_at || null,
        googlePay: googlePayPublicConfig(),
      });
    } catch (e: any) {
      res.status(500).json({ state: 'error', message: 'Erro ao consultar o link.' });
    }
  });

  // ------------------------------------------------------- cartão digitado
  app.post('/api/public/pay-link/:token/card', async (req, res) => {
    try {
      // Com o Link & Checkout o cartao e digitado NA PAGINA DA CIELO — este
      // endpoint (checkout proprio) fica indisponivel para esses links.
      { const l = await loadLink(req.params.token);
        if (l && String(l.provider || '') === 'cielolink') {
          return res.status(410).json({ message: 'Este link e pago na pagina da Cielo.', state: 'redirect', url: l.checkout_url || null });
        } }
      const cfg = cieloConfig();
      if (!cfg.merchantId || !cfg.merchantKey) return res.status(503).json({ message: 'Pagamento indisponível no momento.' });

      const link = await loadLink(req.params.token);
      if (!link) return res.status(404).json({ message: 'Link não encontrado.' });
      const st = linkState(link);
      if (st === 'paid') return res.status(409).json({ message: 'Este pagamento já foi realizado.', state: 'paid' });
      if (st === 'expired') return res.status(410).json({ message: 'Este link expirou. Peça um novo.', state: 'expired' });
      if (st === 'blocked') return res.status(429).json({ message: 'Muitas tentativas neste link. Fale com o atendimento.', state: 'blocked' });
      if (st !== 'pending') return res.status(409).json({ message: 'Link indisponível.', state: st });

      const card = (req.body || {}).card || {};
      if (!luhnOk(card.number)) return res.status(400).json({ message: 'Número de cartão inválido' });
      if (!String(card.holder || '').trim()) return res.status(400).json({ message: 'Informe o nome impresso no cartão' });
      if (!/^\d{2}\s*\/\s*(\d{2}|\d{4})$/.test(String(card.expiry || '').trim())) return res.status(400).json({ message: 'Validade inválida (use MM/AA)' });
      if (!/^\d{3,4}$/.test(onlyDigits(card.cvv))) return res.status(400).json({ message: 'CVV inválido' });

      if (await orderAlreadyPaid(link.sales_card_id)) {
        await db.execute(sql`UPDATE payment_links SET status = 'canceled', updated_at = now() WHERE id = ${link.id}`);
        return res.status(409).json({ message: 'Este pedido já foi pago.', state: 'paid' });
      }
      const amountCents = Math.round(Number(link.amount) * 100);
      if (!(amountCents > 0)) return res.status(400).json({ message: 'Valor inválido' });

      const merchantOrderId = await beginAttempt(link, 'LINK');
      const last4 = onlyDigits(card.number).slice(-4);
      const brand = detectBrand(card.number);

      let sale = await createCardSale({
        merchantOrderId,
        amountCents,
        installments: 1,
        customerName: String(link.customer_name || 'Cliente Honest'),
        customerIdentity: link.customer_document || undefined,
        customerEmail: null,
        card: { number: String(card.number), holder: String(card.holder), expiry: String(card.expiry), cvv: String(card.cvv) },
      });
      if (sale.networkError) {
        const q = await queryByMerchantOrderId(merchantOrderId);
        if (q) sale = q;
      }

      if (!sale.approved) {
        await db.execute(sql`UPDATE payment_links SET return_code = ${sale.returnCode || null},
          return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${link.id}`);
        if (sale.networkError) return res.status(502).json({ message: 'Não conseguimos falar com a operadora. Nada foi cobrado — tente novamente.' });
        return res.status(402).json({ message: friendlyDecline(sale.returnCode || '', sale.returnMessage || '') });
      }

      await db.execute(sql`UPDATE payment_links SET status = 'paid', paid_at = now(),
        payment_id = ${sale.paymentId || null}, tid = ${sale.tid || null}, brand = ${brand || null},
        card_last4 = ${last4 || null}, wallet = ${null}, return_code = ${sale.returnCode || null},
        return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${link.id}`);

      console.log(`💳 [PAY-LINK] APROVADO token=${String(link.token).slice(0, 8)}… card=${link.sales_card_id || '-'} paymentId=${sale.paymentId}`);
      await afterApproved({ ...link, merchant_order_id: merchantOrderId }, sale, { last4, brand });

      return res.json({ success: true, paymentId: sale.paymentId, orderNumber: link.order_number || null });
    } catch (e: any) {
      console.error('❌ [PAY-LINK] card:', e?.message || e);
      return res.status(500).json({ message: 'Erro ao processar o pagamento. Tente novamente.' });
    }
  });

  // ------------------------------------------------------------- Google Pay
  app.post('/api/public/pay-link/:token/googlepay', async (req, res) => {
    try {
      { const l = await loadLink(req.params.token);
        if (l && String(l.provider || '') === 'cielolink') {
          return res.status(410).json({ message: 'Este link e pago na pagina da Cielo.', state: 'redirect', url: l.checkout_url || null });
        } }
      const cfg = cieloConfig();
      if (!cfg.merchantId || !cfg.merchantKey) return res.status(503).json({ message: 'Pagamento indisponível no momento.' });

      const link = await loadLink(req.params.token);
      if (!link) return res.status(404).json({ message: 'Link não encontrado.' });
      const st = linkState(link);
      if (st === 'paid') return res.status(409).json({ message: 'Este pagamento já foi realizado.', state: 'paid' });
      if (st === 'expired') return res.status(410).json({ message: 'Este link expirou. Peça um novo.', state: 'expired' });
      if (st === 'blocked') return res.status(429).json({ message: 'Muitas tentativas neste link. Fale com o atendimento.', state: 'blocked' });
      if (st !== 'pending') return res.status(409).json({ message: 'Link indisponível.', state: st });

      const token = (req.body || {}).googlePayToken;
      if (!token) return res.status(400).json({ message: 'Token do Google Pay ausente' });

      if (await orderAlreadyPaid(link.sales_card_id)) {
        await db.execute(sql`UPDATE payment_links SET status = 'canceled', updated_at = now() WHERE id = ${link.id}`);
        return res.status(409).json({ message: 'Este pedido já foi pago.', state: 'paid' });
      }
      const amountCents = Math.round(Number(link.amount) * 100);
      if (!(amountCents > 0)) return res.status(400).json({ message: 'Valor inválido' });

      const merchantOrderId = await beginAttempt(link, 'LINKGP');
      let sale = await createGooglePaySale({
        merchantOrderId,
        amountCents,
        customerName: String(link.customer_name || 'Cliente Honest'),
        customerIdentity: link.customer_document || undefined,
        customerEmail: null,
        googlePayToken: String(token),
      });
      if (sale.networkError) {
        const q = await queryByMerchantOrderId(merchantOrderId);
        if (q) sale = q;
      }

      if (!sale.approved) {
        await db.execute(sql`UPDATE payment_links SET return_code = ${sale.returnCode || null},
          return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${link.id}`);
        if (sale.networkError) return res.status(502).json({ message: 'Não conseguimos falar com a operadora. Nada foi cobrado — tente novamente.' });
        return res.status(402).json({ message: friendlyDecline(sale.returnCode || '', sale.returnMessage || '') });
      }

      await db.execute(sql`UPDATE payment_links SET status = 'paid', paid_at = now(),
        payment_id = ${sale.paymentId || null}, tid = ${sale.tid || null}, brand = ${'GooglePay'},
        wallet = ${'googlepay'}, return_code = ${sale.returnCode || null},
        return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${link.id}`);

      console.log(`💳 [PAY-LINK-GPAY] APROVADO token=${String(link.token).slice(0, 8)}… card=${link.sales_card_id || '-'} paymentId=${sale.paymentId}`);
      await afterApproved({ ...link, merchant_order_id: merchantOrderId }, sale, { wallet: 'googlepay', brand: 'GooglePay' });

      return res.json({ success: true, paymentId: sale.paymentId, orderNumber: link.order_number || null });
    } catch (e: any) {
      console.error('❌ [PAY-LINK-GPAY]:', e?.message || e);
      return res.status(500).json({ message: 'Erro ao processar o pagamento. Tente novamente.' });
    }
  });

  // ============== CIELO LINK & CHECKOUT (matriz 0001-53) ==============
  // Notificacao de FINALIZACAO da transacao (form-urlencoded, ~40 campos).
  // SEMPRE responde 200: se devolvermos erro a Cielo repete 3x, de hora em hora.
  app.post('/api/webhooks/cielo-link', async (req: any, res) => {
    res.status(200).send('OK');
    try {
      await logLinkWebhook('pagamento', req.body);
      const n = parseLinkWebhook(req.body);
      if (!n) { console.warn('⚠️ [CIELO-LINK] webhook sem order_number'); return; }
      await applyCieloLinkStatus(n.orderNumber, n);
    } catch (e: any) {
      console.error('❌ [CIELO-LINK] webhook pagamento:', e?.message || e);
    }
  });

  // Notificacao de MUDANCA DE STATUS (payload reduzido: so identifica o pedido).
  // E por aqui que chega cancelamento/estorno depois de pago -> consultamos a Cielo.
  app.post('/api/webhooks/cielo-link/status', async (req: any, res) => {
    res.status(200).send('OK');
    try {
      await logLinkWebhook('status', req.body);
      const b = req.body || {};
      const on = String(b.MerchantOrderNumber || b.merchantOrderNumber || b.order_number || b.orderNumber || '').trim();
      if (!on) { console.warn('⚠️ [CIELO-LINK] status sem MerchantOrderNumber'); return; }
      const q = await queryCieloOrder(on);
      if (!q.ok) { console.warn(`⚠️ [CIELO-LINK] consulta de ${on} falhou: ${q.error}`); return; }
      const raw: any = q.raw || {};
      await applyCieloLinkStatus(on, {
        orderNumber: on,
        paid: !!q.paid,
        statusCode: q.paid ? 2 : null,
        statusLabel: String(q.status ?? 'desconhecido'),
        amount: raw?.price != null ? Math.round(Number(raw.price)) / 100 : null,
        tid: raw?.payment?.tid || null,
        nsu: raw?.payment?.nsu || null,
        authorizationCode: raw?.payment?.authorizationCode || null,
        brand: raw?.payment?.brand || null,
        last4: null,
        isTest: false,
      });
    } catch (e: any) {
      console.error('❌ [CIELO-LINK] webhook status:', e?.message || e);
    }
  });

  // Diagnostico (admin) — NUNCA devolve credencial.
  app.get('/api/admin/cielo-link-diag', async (_req, res) => {
    try { res.json(await cieloLinkDiag()); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Rede de seguranca: webhook perdido. Consulta na Cielo os links ainda pendentes
  // e aplica o status. Fire-and-forget (nao segura a resposta HTTP).
  app.get('/api/admin/cielo-link/reconcile', async (req: any, res) => {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours || 48)));
    res.json({ ok: true, started: true, hours });
    reconcileCieloLinks(hours).catch(() => {});
  });

  // ---------------------------------------------------------- página pública
  app.get('/pay/:token', async (req, res) => {
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      const link = await loadLink(req.params.token);
      const st = linkState(link);
      if (!link) return res.status(404).send(pageMessage('Link não encontrado', 'Confira o endereço ou peça um novo link ao atendimento.'));
      if (st === 'paid') return res.send(pageMessage('Pagamento já realizado ✅', `Este link já foi pago${link.order_number ? ' (pedido ' + esc(link.order_number) + ')' : ''}. Não é preciso pagar de novo.`));
      if (st === 'expired') return res.send(pageMessage('Link expirado', 'Este link de pagamento venceu. Peça um novo ao atendimento.'));
      if (st === 'canceled') return res.send(pageMessage('Link cancelado', 'Este link foi cancelado. Fale com o atendimento.'));
      if (st === 'blocked') return res.send(pageMessage('Muitas tentativas', 'Por segurança, este link foi bloqueado. Fale com o atendimento para receber um novo.'));
      // Cielo Link & Checkout: o pagamento acontece na pagina da Cielo. Mantemos o
      // nosso link curto (TTL, canal, anti-cobranca-dupla) e redirecionamos.
      if (String(link.provider || '') === 'cielolink' && link.checkout_url) {
        return res.redirect(302, String(link.checkout_url));
      }
      return res.send(pageCheckout(link));
    } catch (e: any) {
      console.error('❌ [PAY-LINK] page:', e?.message || e);
      return res.status(500).send(pageMessage('Erro', 'Não foi possível abrir o pagamento agora. Tente novamente em instantes.'));
    }
  });
}

// ============================== páginas HTML ================================
const SHELL_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
  background:linear-gradient(160deg,#0f9d58 0%,#0b7d45 45%,#075c33 100%);
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;color:#1f2937}
.card{background:#fff;border-radius:20px;max-width:420px;width:100%;padding:24px;
  box-shadow:0 18px 45px rgba(0,0,0,.28)}
.brand{text-align:center;font-weight:800;font-size:15px;letter-spacing:.5px;color:#0f9d58;margin-bottom:4px}
h1{font-size:18px;text-align:center;margin-bottom:6px;color:#111827}
.sub{text-align:center;font-size:13px;color:#6b7280;margin-bottom:14px}
.amount{font-size:32px;font-weight:800;text-align:center;color:#f97316;margin:6px 0 4px}
.desc{text-align:center;font-size:13px;color:#4b5563;margin-bottom:16px}
label{display:block;font-size:12px;font-weight:600;color:#4b5563;margin-bottom:4px}
input{width:100%;border:2px solid #e5e7eb;border-radius:12px;padding:12px;font-size:16px;margin-bottom:10px;outline:none}
input:focus{border-color:#0f9d58}
.row{display:flex;gap:10px}.row>div{flex:1}
button.pay{width:100%;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:700;color:#fff;background:#0f9d58;cursor:pointer}
button.pay:disabled{background:#d1d5db;cursor:not-allowed}
.err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:12px;padding:10px;font-size:13px;margin-bottom:10px}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;border-radius:12px;padding:14px;font-size:14px;text-align:center}
.sep{display:flex;align-items:center;gap:8px;margin:14px 0}
.sep div{flex:1;height:1px;background:#e5e7eb}.sep span{font-size:11px;color:#9ca3af}
.foot{font-size:11px;color:#9ca3af;text-align:center;margin-top:12px;line-height:1.5}
#gpay{min-height:48px}
`;

function pageMessage(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Honest Sucos</title><style>${SHELL_CSS}</style></head>
<body><div class="card"><div class="brand">HONEST SUCOS</div>
<h1>${esc(title)}</h1><p class="sub">${body}</p></div></body></html>`;
}

function pageCheckout(link: any): string {
  const gp = googlePayPublicConfig();
  const state = {
    token: String(link.token),
    amount: Number(link.amount),
    description: link.description || null,
    customerName: link.customer_name || null,
    orderNumber: link.order_number || null,
    googlePay: gp,
  };
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pagamento — Honest Sucos</title><style>${SHELL_CSS}</style></head>
<body>
<div class="card">
  <div class="brand">HONEST SUCOS</div>
  <h1>Pagamento seguro</h1>
  <p class="sub">${link.customer_name ? 'Ol&aacute;, ' + esc(String(link.customer_name).split(' ')[0]) + '!' : 'Finalize seu pagamento'}</p>
  <div class="amount">${esc(brl(link.amount))}</div>
  <p class="desc">${esc(link.description || (link.order_number ? 'Pedido ' + link.order_number : 'Pagamento Honest Sucos'))}</p>

  <div id="done" style="display:none" class="ok"></div>

  <div id="form">
    <div id="gpaywrap" style="display:none">
      <div id="gpay"></div>
      <div class="sep"><div></div><span>ou pague com cart&atilde;o</span><div></div></div>
    </div>

    <div id="err" class="err" style="display:none"></div>

    <label>N&uacute;mero do cart&atilde;o</label>
    <input id="num" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000">
    <label>Nome impresso no cart&atilde;o</label>
    <input id="holder" autocomplete="cc-name" placeholder="Como est&aacute; no cart&atilde;o">
    <div class="row">
      <div><label>Validade</label><input id="exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA"></div>
      <div><label>CVV</label><input id="cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123"></div>
    </div>
    <button class="pay" id="btn" disabled>Pagar ${esc(brl(link.amount))}</button>
    <p class="foot">🔒 Pagamento processado pela <b>Cielo</b>. &Agrave; vista, sem parcelamento.<br>
    Seus dados de cart&atilde;o n&atilde;o s&atilde;o armazenados pela Honest.</p>
  </div>
</div>
<script>
var S = ${JSON.stringify(state)};
var $ = function(id){ return document.getElementById(id); };
function showErr(m){ var e=$('err'); e.textContent=m; e.style.display='block'; }
function clearErr(){ $('err').style.display='none'; }
function done(msg){ $('form').style.display='none'; var d=$('done'); d.innerHTML=msg; d.style.display='block'; }

// ---- máscaras
$('num').addEventListener('input', function(){
  var d=this.value.replace(/\\D/g,'').slice(0,19);
  this.value=d.replace(/(\\d{4})(?=\\d)/g,'$1 '); check();
});
$('exp').addEventListener('input', function(){
  var d=this.value.replace(/\\D/g,'').slice(0,4);
  this.value = d.length>2 ? d.slice(0,2)+'/'+d.slice(2) : d; check();
});
$('cvv').addEventListener('input', function(){ this.value=this.value.replace(/\\D/g,'').slice(0,4); check(); });
$('holder').addEventListener('input', check);
function valid(){
  return $('num').value.replace(/\\D/g,'').length>=13
    && $('holder').value.trim().length>2
    && /^\\d{2}\\/\\d{2}$/.test($('exp').value)
    && $('cvv').value.length>=3;
}
function check(){ $('btn').disabled = !valid(); }

// ---- pagamento com cartão digitado
var busy=false;
$('btn').addEventListener('click', async function(){
  if(!valid()||busy) return;
  busy=true; clearErr(); $('btn').disabled=true; $('btn').textContent='Processando...';
  try{
    var r = await fetch('/api/public/pay-link/'+S.token+'/card', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ card:{ number:$('num').value, holder:$('holder').value, expiry:$('exp').value, cvv:$('cvv').value } })
    });
    var data = await r.json();
    if(!r.ok) throw new Error(data.message||'Pagamento n&atilde;o autorizado');
    done('<b>Pagamento aprovado! ✅</b><br>'+(data.orderNumber?('Pedido '+data.orderNumber+'<br>'):'')+'C&oacute;digo: '+(data.paymentId||'-')+'<br><br>Voc&ecirc; pode fechar esta p&aacute;gina e voltar para a conversa.');
  }catch(e){
    showErr(e.message||'N&atilde;o foi poss&iacute;vel concluir o pagamento.');
    $('btn').textContent='Pagar ${esc(brl(link.amount))}'; $('btn').disabled=false;
  } finally { busy=false; }
});

// ---- Google Pay (só aparece se configurado E o aparelho suportar)
(function(){
  var gp = S.googlePay;
  if(!gp || !gp.enabled || !gp.merchantId || !gp.gatewayMerchantId) return;
  var s=document.createElement('script'); s.src='https://pay.google.com/gp/p/js/pay.js'; s.async=true;
  s.onload=function(){
    try{
      var client=new google.payments.api.PaymentsClient({environment:gp.environment});
      var method={type:'CARD',parameters:{allowedAuthMethods:gp.allowedAuthMethods,allowedCardNetworks:gp.allowedCardNetworks},
        tokenizationSpecification:{type:'PAYMENT_GATEWAY',parameters:{gateway:gp.gateway,gatewayMerchantId:gp.gatewayMerchantId}}};
      client.isReadyToPay({apiVersion:2,apiVersionMinor:0,allowedPaymentMethods:[method]}).then(function(r){
        if(!r || !r.result) return;
        $('gpaywrap').style.display='block';
        var btn=client.createButton({buttonType:'pay',buttonColor:'black',buttonSizeMode:'fill',buttonLocale:'pt',
          onClick:async function(){
            if(busy) return; busy=true; clearErr();
            try{
              var pd=await client.loadPaymentData({apiVersion:2,apiVersionMinor:0,allowedPaymentMethods:[method],
                merchantInfo:{merchantId:gp.merchantId,merchantName:gp.merchantName},
                transactionInfo:{totalPriceStatus:'FINAL',totalPrice:S.amount.toFixed(2),currencyCode:'BRL',countryCode:'BR'}});
              var tok=pd.paymentMethodData.tokenizationData.token;
              var r2=await fetch('/api/public/pay-link/'+S.token+'/googlepay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({googlePayToken:tok})});
              var d2=await r2.json();
              if(!r2.ok) throw new Error(d2.message||'Pagamento n&atilde;o autorizado');
              done('<b>Pagamento aprovado! ✅</b><br>'+(d2.orderNumber?('Pedido '+d2.orderNumber+'<br>'):'')+'C&oacute;digo: '+(d2.paymentId||'-')+'<br><br>Voc&ecirc; pode fechar esta p&aacute;gina e voltar para a conversa.');
            }catch(e){
              var c=String((e&&(e.statusCode||e.statusMessage))||'').toUpperCase();
              if(c.indexOf('CANCEL')<0) showErr((e&&e.message)||'Google Pay n&atilde;o autorizado.');
            } finally { busy=false; }
          }});
        $('gpay').appendChild(btn);
      }).catch(function(){});
    }catch(e){}
  };
  document.head.appendChild(s);
})();
</script>
</body></html>`;
}
