// ============================================================================
// LOJA (HOTSITE) — CARTÃO DE CRÉDITO "PAGAR ANTES" (Cielo E-commerce API 3.0)
// Fluxo síncrono: o checkout envia os dados do cartão → autorizamos e capturamos
// na Cielo → SÓ com pagamento aprovado o pedido é criado (reusando o endpoint
// público existente via chamada interna, igual ao PIX). Cartão NUNCA é gravado
// nem logado — apenas os 4 últimos dígitos vão para a nota do pedido.
// Credenciais via env: CIELO_MERCHANT_ID, CIELO_MERCHANT_KEY, CIELO_ENV
// (production|sandbox; default production), CIELO_MAX_INSTALLMENTS (default 3).
// ============================================================================
import type { Express } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { computeServerTotal } from './hotsite-pix';

const INTERNAL_BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080');

function cieloConfig() {
  const env = String(process.env.CIELO_ENV || 'production').toLowerCase();
  const sandbox = env === 'sandbox';
  return {
    merchantId: process.env.CIELO_MERCHANT_ID || '',
    merchantKey: process.env.CIELO_MERCHANT_KEY || '',
    apiUrl: sandbox ? 'https://apisandbox.cieloecommerce.cielo.com.br' : 'https://api.cieloecommerce.cielo.com.br',
    queryUrl: sandbox ? 'https://apiquerysandbox.cieloecommerce.cielo.com.br' : 'https://apiquery.cieloecommerce.cielo.com.br',
    sandbox,
    maxInstallments: 1, // parcelamento desativado na loja (a vista)
  };
}

function onlyDigits(s: any): string { return String(s || '').replace(/\D/g, ''); }

// Detecção de bandeira pelo BIN (Elo/Hipercard antes de Visa/Master, pois os ranges se sobrepõem)
export function detectBrand(cardNumber: string): string {
  const n = onlyDigits(cardNumber);
  if (/^(4011(78|79)|43(1274|8935)|45(1416|7393|763(1|2))|50(4175|6699|67[0-6][0-9]|677[0-8])|509\d{3}|627780|63(6297|6368)|65(0(0(3([1-3]|[5-9])|4([0-9])|5[0-1])|4(0[5-9]|[1-3][0-9]|8[5-9]|9[0-9])|5([0-2][0-9]|3[0-8]|4[1-9]|[5-8][0-9]|9[0-8])|7(0[0-9]|1[0-8]|2[0-7])|9(0[1-9]|[1-6][0-9]|7[0-8]))|16(5[2-9]|[6-7][0-9])|50(0[0-9]|1[0-9]|2[1-9]|[3-4][0-9]|5[0-8])))/.test(n)) return 'Elo';
  if (/^(606282|3841(0|4|6))/.test(n)) return 'Hipercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^(5[1-5]|2(2[2-9]|[3-6][0-9]|7[01]|720))/.test(n)) return 'Master';
  if (/^4/.test(n)) return 'Visa';
  if (/^(30[1-5]|36|38)/.test(n)) return 'Diners';
  return 'Visa';
}

function luhnOk(cardNumber: string): boolean {
  const n = onlyDigits(cardNumber);
  if (n.length < 13 || n.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface CardSaleResult {
  approved: boolean;
  status?: number;
  paymentId?: string;
  tid?: string;
  authorizationCode?: string;
  returnCode?: string;
  returnMessage?: string;
  raw?: any;
  networkError?: boolean;
}

async function cieloFetch(url: string, opts: any, timeoutMs = 35000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Venda com captura automática (uma única tentativa — NUNCA repetir para não cobrar 2x)
async function createCardSale(params: {
  merchantOrderId: string;
  amountCents: number;
  installments: number;
  customerName: string;
  customerIdentity?: string;
  customerEmail?: string | null;
  card: { number: string; holder: string; expiry: string; cvv: string };
}): Promise<CardSaleResult> {
  const cfg = cieloConfig();
  const exp = params.card.expiry.trim(); // MM/AA ou MM/AAAA
  const m = exp.match(/^(\d{2})\s*\/\s*(\d{2}|\d{4})$/);
  const expiration = m ? `${m[1]}/${m[2].length === 2 ? '20' + m[2] : m[2]}` : exp;

  const body: any = {
    MerchantOrderId: params.merchantOrderId,
    Customer: {
      Name: params.customerName.slice(0, 100),
    },
    Payment: {
      Type: 'CreditCard',
      Amount: params.amountCents,
      Installments: params.installments,
      SoftDescriptor: 'HONESTSUCOS',
      Capture: true,
      CreditCard: {
        CardNumber: onlyDigits(params.card.number),
        Holder: params.card.holder.slice(0, 60),
        ExpirationDate: expiration,
        SecurityCode: onlyDigits(params.card.cvv),
        Brand: detectBrand(params.card.number),
      },
    },
  };
  if (params.customerIdentity) { body.Customer.Identity = onlyDigits(params.customerIdentity); body.Customer.IdentityType = onlyDigits(params.customerIdentity).length === 14 ? 'CNPJ' : 'CPF'; }
  if (params.customerEmail) body.Customer.Email = String(params.customerEmail).slice(0, 100);

  try {
    const resp = await cieloFetch(`${cfg.apiUrl}/1/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        MerchantId: cfg.merchantId,
        MerchantKey: cfg.merchantKey,
      },
      body: JSON.stringify(body),
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      const msg = Array.isArray(data) ? (data[0]?.Message || 'Erro Cielo') : (data?.Message || `HTTP ${resp.status}`);
      console.error(`❌ [LOJA-CARTAO] Cielo recusou a requisição (${resp.status}): ${msg}`);
      return { approved: false, returnMessage: String(msg) };
    }
    const p = data.Payment || {};
    const approved = p.Status === 2 || p.Status === 1; // 2=capturado; 1=autorizado
    console.log(`💳 [LOJA-CARTAO] Cielo status=${p.Status} code=${p.ReturnCode} paymentId=${p.PaymentId} order=${params.merchantOrderId}`);
    return {
      approved,
      status: p.Status,
      paymentId: p.PaymentId,
      tid: p.Tid,
      authorizationCode: p.AuthorizationCode,
      returnCode: String(p.ReturnCode || ''),
      returnMessage: String(p.ReturnMessage || ''),
    };
  } catch (e: any) {
    console.error('❌ [LOJA-CARTAO] Falha de rede na Cielo:', e?.message || e);
    return { approved: false, networkError: true, returnMessage: 'network' };
  }
}

// Venda Google Pay (Wallet) — captura automática, à vista. Cielo decripta o token.
async function createGooglePaySale(params: {
  merchantOrderId: string; amountCents: number;
  customerName: string; customerIdentity?: string; customerEmail?: string | null;
  googlePayToken: string;
}): Promise<CardSaleResult> {
  const cfg = cieloConfig();
  const walletKey = Buffer.from(String(params.googlePayToken)).toString('base64');
  const body: any = {
    MerchantOrderId: params.merchantOrderId,
    Customer: { Name: params.customerName.slice(0, 100) },
    Payment: {
      Type: 'CreditCard', Amount: params.amountCents, Installments: 1,
      SoftDescriptor: 'HONESTSUCOS', Capture: true,
      Wallet: { Type: 'Googlepay', WalletKey: walletKey },
    },
  };
  if (params.customerIdentity) { body.Customer.Identity = onlyDigits(params.customerIdentity); body.Customer.IdentityType = onlyDigits(params.customerIdentity).length === 14 ? 'CNPJ' : 'CPF'; }
  if (params.customerEmail) body.Customer.Email = String(params.customerEmail).slice(0, 100);
  try {
    const resp = await cieloFetch(`${cfg.apiUrl}/1/sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', MerchantId: cfg.merchantId, MerchantKey: cfg.merchantKey },
      body: JSON.stringify(body),
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      const msg = Array.isArray(data) ? (data[0]?.Message || 'Erro Cielo') : (data?.Message || `HTTP ${resp.status}`);
      console.error(`❌ [LOJA-GPAY] Cielo recusou (${resp.status}): ${msg}`);
      return { approved: false, returnMessage: String(msg) };
    }
    const p = data.Payment || {};
    const approved = p.Status === 2 || p.Status === 1;
    console.log(`💳 [LOJA-GPAY] Cielo status=${p.Status} code=${p.ReturnCode} paymentId=${p.PaymentId} order=${params.merchantOrderId}`);
    return { approved, status: p.Status, paymentId: p.PaymentId, tid: p.Tid, authorizationCode: p.AuthorizationCode, returnCode: String(p.ReturnCode || ''), returnMessage: String(p.ReturnMessage || '') };
  } catch (e: any) {
    console.error('❌ [LOJA-GPAY] Falha de rede na Cielo:', e?.message || e);
    return { approved: false, networkError: true, returnMessage: 'network' };
  }
}

// Consulta por MerchantOrderId (para desambiguar falha de rede pós-envio)
async function queryByMerchantOrderId(merchantOrderId: string): Promise<CardSaleResult | null> {
  const cfg = cieloConfig();
  try {
    const resp = await cieloFetch(`${cfg.queryUrl}/1/sales?merchantOrderId=${encodeURIComponent(merchantOrderId)}`, {
      method: 'GET',
      headers: { MerchantId: cfg.merchantId, MerchantKey: cfg.merchantKey },
    }, 20000);
    if (!resp.ok) return null;
    const data: any = await resp.json().catch(() => null);
    const pay = data?.Payments?.[0];
    if (!pay || !pay.PaymentId) return null;
    // Busca o detalhe para saber o status real
    const det = await cieloFetch(`${cfg.queryUrl}/1/sales/${pay.PaymentId}`, {
      method: 'GET',
      headers: { MerchantId: cfg.merchantId, MerchantKey: cfg.merchantKey },
    }, 20000);
    const dd: any = await det.json().catch(() => null);
    const p = dd?.Payment || {};
    return { approved: p.Status === 2 || p.Status === 1, status: p.Status, paymentId: p.PaymentId, returnCode: String(p.ReturnCode || ''), returnMessage: String(p.ReturnMessage || '') };
  } catch { return null; }
}

let _tableReady = false;
async function ensureTable(): Promise<void> {
  if (_tableReady) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS hotsite_card_payments (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_order_id varchar NOT NULL,
    payment_id varchar,
    amount numeric(10,2) NOT NULL,
    installments int DEFAULT 1,
    card_last4 varchar,
    card_brand varchar,
    status varchar NOT NULL DEFAULT 'processing',
    return_code varchar,
    return_message text,
    order_id varchar,
    order_number varchar,
    payload text,
    error text,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`));
  _tableReady = true;
}

function friendlyDecline(code: string, msg: string): string {
  const known: Record<string, string> = {
    '05': 'Cartão não autorizado pelo banco emissor. Verifique os dados ou tente outro cartão.',
    '51': 'Saldo/limite insuficiente.',
    '54': 'Cartão vencido — confira a validade.',
    '57': 'Transação não permitida para este cartão.',
    '78': 'Cartão bloqueado — contate o banco emissor.',
    'GF': 'Transação não autorizada. Tente novamente ou use outro cartão.',
    'BP': 'Transação não autorizada pelo emissor.',
  };
  return known[code] || (msg && msg !== 'Denied' ? `Pagamento não autorizado (${msg}).` : 'Pagamento não autorizado. Verifique os dados do cartão ou tente outro.');
}

export function registerHotsiteCard(app: Express): void {
  // Paga com cartão e, SÓ se aprovado, cria o pedido (síncrono)
  app.post('/api/public/orders/card/pay', async (req, res) => {
    try {
      await ensureTable();
      const cfg = cieloConfig();
      if (!cfg.merchantId || !cfg.merchantKey) {
        return res.status(503).json({ message: 'Pagamento com cartão indisponível no momento.' });
      }
      const body = req.body || {};
      const order = body.order || {};
      const card = body.card || {};
      const c = order.customer || {};

      // Validações leves (espelham o endpoint de pedido)
      if (!String(c.name || '').trim()) return res.status(400).json({ message: 'Nome é obrigatório' });
      if (onlyDigits(c.phone).length < 10) return res.status(400).json({ message: 'Telefone inválido' });
      if (!String(c.address || '').trim()) return res.status(400).json({ message: 'Endereço é obrigatório' });
      if ((c.customerType || 'pessoa_fisica') === 'pessoa_fisica' && onlyDigits(c.cpfCnpj).length !== 11) {
        return res.status(400).json({ message: 'CPF é obrigatório e deve ter 11 dígitos' });
      }
      if (order.paymentMethod !== 'card') return res.status(400).json({ message: 'Método de pagamento deve ser cartão' });

      // Validações do cartão (sem nunca logar/persistir os dados)
      if (!luhnOk(card.number)) return res.status(400).json({ message: 'Número de cartão inválido' });
      if (!String(card.holder || '').trim()) return res.status(400).json({ message: 'Informe o nome impresso no cartão' });
      if (!/^\d{2}\s*\/\s*(\d{2}|\d{4})$/.test(String(card.expiry || '').trim())) return res.status(400).json({ message: 'Validade inválida (use MM/AA)' });
      if (!/^\d{3,4}$/.test(onlyDigits(card.cvv))) return res.status(400).json({ message: 'CVV inválido' });

      const totals = await computeServerTotal(order);
      if ('error' in totals) return res.status(400).json({ message: totals.error });
      const clientTotal = Number(order.totalAmount) || 0;
      if (Math.abs(totals.total - clientTotal) > 0.01) {
        return res.status(400).json({ message: 'O total do pedido não corresponde aos preços atuais dos produtos', serverTotal: totals.total });
      }
      if (totals.total <= 0) return res.status(400).json({ message: 'Total inválido' });

      const installments = Math.max(1, Math.min(cfg.maxInstallments, parseInt(body.installments, 10) || 1));
      const amountCents = Math.round(totals.total * 100);
      const merchantOrderId = 'LOJA' + Date.now() + Math.floor(Math.random() * 1000);
      const last4 = onlyDigits(card.number).slice(-4);
      const brand = detectBrand(card.number);

      // Registra a tentativa ANTES de cobrar (conciliação; payload SEM dados de cartão)
      const ins: any = await db.execute(sql`INSERT INTO hotsite_card_payments (merchant_order_id, amount, installments, card_last4, card_brand, status, payload) VALUES (${merchantOrderId}, ${totals.total.toFixed(2)}, ${installments}, ${last4}, ${brand}, 'processing', ${JSON.stringify(order)}) RETURNING id`);
      const rowId = ((ins.rows || ins)[0] || {}).id;

      let sale = await createCardSale({
        merchantOrderId,
        amountCents,
        installments,
        customerName: String(c.name),
        customerIdentity: c.cpfCnpj || undefined,
        customerEmail: c.email || null,
        card: { number: String(card.number), holder: String(card.holder), expiry: String(card.expiry), cvv: String(card.cvv) },
      });

      // Falha de rede APÓS envio: consulta antes de declarar erro (evita cobrança perdida)
      if (sale.networkError) {
        const q = await queryByMerchantOrderId(merchantOrderId);
        if (q) sale = q;
      }

      if (!sale.approved) {
        await db.execute(sql`UPDATE hotsite_card_payments SET status = 'denied', payment_id = ${sale.paymentId || null}, return_code = ${sale.returnCode || null}, return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${rowId}`);
        if (sale.networkError) return res.status(502).json({ message: 'Não conseguimos falar com a operadora. Nada foi cobrado — tente novamente.' });
        return res.status(402).json({ message: friendlyDecline(sale.returnCode || '', sale.returnMessage || '') });
      }

      // APROVADO → cria o pedido reusando o endpoint real
      await db.execute(sql`UPDATE hotsite_card_payments SET status = 'paid', payment_id = ${sale.paymentId || null}, return_code = ${sale.returnCode || null}, return_message = ${sale.returnMessage || null}, updated_at = now() WHERE id = ${rowId}`);
      try {
        const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order),
        });
        const data: any = await resp.json();
        if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);

        await db.execute(sql`UPDATE hotsite_card_payments SET order_id = ${data.orderId}, order_number = ${data.orderNumber || null}, updated_at = now() WHERE id = ${rowId}`);
        try {
          await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${'\n💳 CARTÃO APROVADO na loja (Cielo PaymentId ' + (sale.paymentId || '?') + ', ' + brand + ' final ' + last4 + ', ' + installments + 'x) — pedido criado após confirmação do pagamento.'} WHERE id = ${data.orderId}`);
        } catch { /* nota é cosmética */ }
        console.log(`✅ [LOJA-CARTAO] Pedido criado após cartão aprovado: ${data.orderNumber} (payment ${sale.paymentId})`);
        // Pedido JÁ PAGO não espera: envia imediatamente ao pipeline de faturamento
        try {
          const { reconcilePendingOrders } = await import('./billing-pipeline-routes');
          const r = await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [data.orderId] });
          console.log(`🚀 [LOJA-CARTAO] Pedido pago enviado ao pipeline imediatamente (recovered=${r?.recovered}).`);
        } catch (e2: any) {
          console.warn('⚠️ [LOJA-CARTAO] Envio imediato ao pipeline falhou (cron recupera em ≤90min):', e2?.message || e2);
        }
        return res.status(201).json({ success: true, orderId: data.orderId, orderNumber: data.orderNumber, paymentId: sale.paymentId, installments, brand, last4 });
      } catch (e: any) {
        // Cobrado mas pedido falhou → registro fica para ação manual (dinheiro seguro)
        await db.execute(sql`UPDATE hotsite_card_payments SET status = 'paid_order_error', error = ${String(e?.message || e)}, updated_at = now() WHERE id = ${rowId}`);
        console.error(`❌ [LOJA-CARTAO] Cartão aprovado mas falha ao criar pedido (payment ${sale.paymentId}):`, e?.message || e);
        return res.status(201).json({ success: true, orderPending: true, paymentId: sale.paymentId, message: 'Pagamento aprovado! Seu pedido está sendo registrado — guarde este código.' });
      }
    } catch (e: any) {
      console.error('❌ [LOJA-CARTAO] Erro no card/pay:', e?.message || e);
      res.status(500).json({ message: 'Erro ao processar o pagamento. Tente novamente.' });
    }
  });

  // Google Pay: token da carteira -> Cielo -> SO se aprovado cria o pedido
  app.post('/api/public/orders/card/pay-googlepay', async (req, res) => {
    try {
      await ensureTable();
      const cfg = cieloConfig();
      if (!cfg.merchantId || !cfg.merchantKey) return res.status(503).json({ message: 'Pagamento indisponível no momento.' });
      const body = req.body || {}; const order = body.order || {}; const c = order.customer || {};
      const token = body.googlePayToken;
      if (!token) return res.status(400).json({ message: 'Token do Google Pay ausente' });
      if (!String(c.name || '').trim()) return res.status(400).json({ message: 'Nome é obrigatório' });
      if (onlyDigits(c.phone).length < 10) return res.status(400).json({ message: 'Telefone inválido' });
      if (!String(c.address || '').trim()) return res.status(400).json({ message: 'Endereço é obrigatório' });
      if ((c.customerType || 'pessoa_fisica') === 'pessoa_fisica' && onlyDigits(c.cpfCnpj).length !== 11) return res.status(400).json({ message: 'CPF é obrigatório e deve ter 11 dígitos' });
      if (order.paymentMethod !== 'card') return res.status(400).json({ message: 'Método de pagamento deve ser cartão' });

      const totals = await computeServerTotal(order);
      if ('error' in totals) return res.status(400).json({ message: totals.error });
      if (Math.abs(totals.total - (Number(order.totalAmount) || 0)) > 0.01) return res.status(400).json({ message: 'O total do pedido não corresponde aos preços atuais dos produtos', serverTotal: totals.total });
      if (totals.total <= 0) return res.status(400).json({ message: 'Total inválido' });

      const amountCents = Math.round(totals.total * 100);
      const merchantOrderId = 'LOJAGP' + Date.now() + Math.floor(Math.random() * 1000);
      const ins: any = await db.execute(sql`INSERT INTO hotsite_card_payments (merchant_order_id, amount, installments, card_brand, status, payload) VALUES (${merchantOrderId}, ${totals.total.toFixed(2)}, 1, ${'GooglePay'}, 'processing', ${JSON.stringify(order)}) RETURNING id`);
      const rowId = ((ins.rows || ins)[0] || {}).id;

      let sale = await createGooglePaySale({ merchantOrderId, amountCents, customerName: String(c.name), customerIdentity: c.cpfCnpj || undefined, customerEmail: c.email || null, googlePayToken: String(token) });
      if (sale.networkError) { const q = await queryByMerchantOrderId(merchantOrderId); if (q) sale = q; }

      if (!sale.approved) {
        await db.execute(sql`UPDATE hotsite_card_payments SET status='denied', payment_id=${sale.paymentId||null}, return_code=${sale.returnCode||null}, return_message=${sale.returnMessage||null}, updated_at=now() WHERE id=${rowId}`);
        if (sale.networkError) return res.status(502).json({ message: 'Não conseguimos falar com a operadora. Nada foi cobrado — tente novamente.' });
        return res.status(402).json({ message: friendlyDecline(sale.returnCode || '', sale.returnMessage || '') });
      }

      await db.execute(sql`UPDATE hotsite_card_payments SET status='paid', payment_id=${sale.paymentId||null}, return_code=${sale.returnCode||null}, return_message=${sale.returnMessage||null}, updated_at=now() WHERE id=${rowId}`);
      try {
        const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order) });
        const data: any = await resp.json();
        if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);
        await db.execute(sql`UPDATE hotsite_card_payments SET order_id=${data.orderId}, order_number=${data.orderNumber||null}, updated_at=now() WHERE id=${rowId}`);
        try { await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${' 💳 GOOGLE PAY APROVADO na loja (Cielo PaymentId ' + (sale.paymentId || '?') + ') — pedido criado após confirmação do pagamento.'} WHERE id = ${data.orderId}`); } catch {}
        try { const { reconcilePendingOrders } = await import('./billing-pipeline-routes'); await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [data.orderId] }); } catch (e2: any) { console.warn('⚠️ [LOJA-GPAY] envio imediato ao pipeline falhou:', e2?.message || e2); }
        return res.status(201).json({ success: true, orderId: data.orderId, orderNumber: data.orderNumber, paymentId: sale.paymentId, brand: 'GooglePay' });
      } catch (e: any) {
        await db.execute(sql`UPDATE hotsite_card_payments SET status='paid_order_error', error=${String(e?.message||e)}, updated_at=now() WHERE id=${rowId}`);
        return res.status(201).json({ success: true, orderPending: true, paymentId: sale.paymentId, message: 'Pagamento aprovado! Seu pedido está sendo registrado — guarde este código.' });
      }
    } catch (e: any) {
      console.error('❌ [LOJA-GPAY] Erro no pay-googlepay:', e?.message || e);
      res.status(500).json({ message: 'Erro ao processar o pagamento. Tente novamente.' });
    }
  });

  // Config pública do checkout (máximo de parcelas)
  app.get('/api/public/orders/card/config', async (_req, res) => {
    const cfg = cieloConfig();
    res.json({ enabled: !!(cfg.merchantId && cfg.merchantKey), maxInstallments: cfg.maxInstallments });
  });

  console.log('💳 [LOJA-CARTAO] Rotas de cartão do checkout registradas (pagar-antes, Cielo ' + (cieloConfig().sandbox ? 'SANDBOX' : 'PRODUÇÃO') + ')');
}
