// ============================================================================
// LOJA (HOTSITE) — PIX "PAGAR ANTES" (Banco do Brasil)
// Fluxo: o cliente fecha o carrinho → geramos a cobrança PIX (BB) e guardamos o
// payload do pedido em hotsite_pending_pix → a loja mostra QR/copia-e-cola e fica
// consultando o status → quando o BB confirma o pagamento, o pedido é criado
// reusando o endpoint público existente (POST /api/public/orders) via chamada
// interna — toda a lógica de preço/cliente/Omie/indicação permanece intacta.
// O pedido SÓ existe no sistema depois do PIX pago (zero pedido fantasma).
// ============================================================================
import type { Express } from 'express';
import { storage } from './storage';
import { db } from './db';
import { sql } from 'drizzle-orm';
import * as bbPixService from './bb-pix-service';

const EXPIRATION_SECONDS = 30 * 60; // 30 min para pagar
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // varredura de segurança a cada 5 min
const INTERNAL_BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080');

let _tableReady = false;
async function ensureTable(): Promise<void> {
  if (_tableReady) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS hotsite_pending_pix (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    charge_id varchar NOT NULL,
    txid varchar,
    amount numeric(10,2) NOT NULL,
    payload text NOT NULL,
    status varchar NOT NULL DEFAULT 'awaiting_payment',
    order_id varchar,
    order_number varchar,
    error text,
    expires_at timestamp,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`));
  _tableReady = true;
}

function onlyDigits(s: any): string { return String(s || '').replace(/\D/g, ''); }

// Recalcula o total no servidor (mesma regra do POST /api/public/orders):
// preço por tabela + desconto de indicação. Nunca confia no total do cliente.
export async function computeServerTotal(body: any): Promise<{ total: number; refPct: number; refDiscount: number } | { error: string }> {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { error: 'Adicione pelo menos um produto' };
  let subtotal = 0;
  for (const item of items) {
    const product = await storage.getProduct(String(item.productId || ''));
    if (!product) return { error: `Produto ${item.productName || item.productId} não encontrado` };
    if (!product.isActive) return { error: `Produto ${product.name} não está mais disponível` };
    let price: number;
    switch (body.priceTable) {
      case 'retail': price = (product as any).retailPrice ?? product.price; break;
      case 'wholesale': price = (product as any).wholesalePrice ?? product.price; break;
      case 'goiania': price = (product as any).resaleGoianiaPrice ?? product.price; break;
      case 'interior': price = (product as any).resaleInteriorPrice ?? product.price; break;
      case 'brasilia': price = (product as any).resaleBrasiliaPrice ?? product.price; break;
      default: price = product.price;
    }
    const qty = Number(item.quantity) || 0;
    if (qty < 1) return { error: 'Quantidade inválida' };
    subtotal += Number(price) * qty;
  }

  // Desconto de indicação — mesmos endpoints internos usados pelo endpoint de pedido
  let refPct = 0;
  const code = String(body.referralCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const doc = onlyDigits(body?.customer?.cpfCnpj);
  try {
    if (code && doc) {
      const vr: any = await fetch(`${INTERNAL_BASE}/api/referral/validate?code=${encodeURIComponent(code)}&referredDocument=${doc}`).then(r => r.json());
      if (vr && vr.valid) refPct = Number(vr.discountPct) || 15;
    }
    if (!refPct && doc) {
      const rw: any = await fetch(`${INTERNAL_BASE}/api/referral/reward-status?document=${doc}`).then(r => r.json());
      if (rw && rw.hasReward) refPct = Number(rw.pct) || 10;
    }
  } catch { /* indicação indisponível não bloqueia a venda */ }

  const refDiscount = refPct > 0 ? Math.round(subtotal * (refPct / 100) * 100) / 100 : 0;
  const total = Math.round((subtotal - refDiscount) * 100) / 100;
  return { total, refPct, refDiscount };
}

// Finaliza um pedido pendente cujo PIX foi CONFIRMADO: claim atômico + chamada
// interna ao endpoint real. Idempotente: só o 1º caller cria o pedido.
async function finalizePaidOrder(row: any): Promise<{ status: string; orderId?: string; orderNumber?: string }> {
  const claim: any = await db.execute(sql`UPDATE hotsite_pending_pix SET status = 'finalizing', updated_at = now() WHERE id = ${row.id} AND status = 'awaiting_payment'`);
  const claimed = (claim.rowCount ?? claim?.rows?.length ?? 0) === 1;
  if (!claimed) {
    const cur: any = await db.execute(sql`SELECT status, order_id, order_number FROM hotsite_pending_pix WHERE id = ${row.id}`);
    const c = (cur.rows || cur)[0] || {};
    if (c.status === 'paid') return { status: 'paid', orderId: c.order_id, orderNumber: c.order_number };
    return { status: 'processing' };
  }
  try {
    const payload = JSON.parse(row.payload);
    const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data: any = await resp.json();
    if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);

    await db.execute(sql`UPDATE hotsite_pending_pix SET status = 'paid', order_id = ${data.orderId}, order_number = ${data.orderNumber || null}, updated_at = now() WHERE id = ${row.id}`);
    // Marca no pedido que o PIX já foi PAGO (aparece nas notas do card)
    try {
      await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${'\n💰 PIX PAGO na loja (txid ' + (row.txid || row.charge_id) + ') — pedido criado após confirmação do pagamento.'} WHERE id = ${data.orderId}`);
    } catch { /* nota é cosmética */ }
    console.log(`✅ [LOJA-PIX] Pedido criado após PIX pago: ${data.orderNumber} (pending ${row.id})`);
    // Pedido JÁ PAGO não espera: envia imediatamente ao pipeline de faturamento
    // (reconcilePendingOrders marca completed + autoSendToBillingPipeline com travas/auditoria).
    try {
      const { reconcilePendingOrders } = await import('./billing-pipeline-routes');
      const r = await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [data.orderId] });
      console.log(`🚀 [LOJA-PIX] Pedido pago enviado ao pipeline imediatamente (recovered=${r?.recovered}).`);
    } catch (e: any) {
      console.warn('⚠️ [LOJA-PIX] Envio imediato ao pipeline falhou (cron recupera em ≤90min):', e?.message || e);
    }
    return { status: 'paid', orderId: data.orderId, orderNumber: data.orderNumber };
  } catch (e: any) {
    // Pagamento recebido mas criação do pedido falhou → NÃO tenta de novo sozinho
    // (endpoint não é idempotente); fica 'error' para ação manual, dinheiro está seguro.
    await db.execute(sql`UPDATE hotsite_pending_pix SET status = 'error', error = ${String(e?.message || e)}, updated_at = now() WHERE id = ${row.id}`);
    console.error(`❌ [LOJA-PIX] PIX pago mas falha ao criar pedido (pending ${row.id}):`, e?.message || e);
    return { status: 'paid_order_error' };
  }
}

async function checkAndFinalize(row: any): Promise<{ status: string; orderId?: string; orderNumber?: string }> {
  // Consulta o BB (atualiza a cobrança e processa a baixa financeira se CONCLUIDA)
  try { await bbPixService.checkChargeStatus(row.charge_id); } catch (e: any) {
    console.warn(`⚠️ [LOJA-PIX] checkChargeStatus falhou (pending ${row.id}):`, e?.message || e);
  }
  const charge = await storage.getPixCharge(row.charge_id);
  if (charge && charge.status === 'CONCLUIDA') return finalizePaidOrder(row);
  const exp = row.expires_at ? new Date(row.expires_at) : null;
  if (exp && Date.now() > exp.getTime()) {
    await db.execute(sql`UPDATE hotsite_pending_pix SET status = 'expired', updated_at = now() WHERE id = ${row.id} AND status = 'awaiting_payment'`);
    return { status: 'expired' };
  }
  return { status: 'awaiting_payment' };
}

let _sweeping = false;
async function sweepPending(): Promise<void> {
  if (_sweeping) return;
  _sweeping = true;
  try {
    await ensureTable();
    const rs: any = await db.execute(sql`SELECT * FROM hotsite_pending_pix WHERE status = 'awaiting_payment' AND created_at > now() - interval '24 hours' ORDER BY created_at ASC LIMIT 20`);
    const rows = rs.rows || rs || [];
    for (const row of rows) {
      try { await checkAndFinalize(row); } catch (e: any) {
        console.warn(`⚠️ [LOJA-PIX] sweep erro (pending ${row.id}):`, e?.message || e);
      }
    }
  } catch (e: any) {
    console.warn('⚠️ [LOJA-PIX] sweep geral falhou:', e?.message || e);
  } finally {
    _sweeping = false;
  }
}

export function registerHotsitePix(app: Express): void {
  // Cria a cobrança PIX e guarda o pedido pendente (NÃO cria o pedido ainda)
  app.post('/api/public/orders/pix/init', async (req, res) => {
    try {
      await ensureTable();
      const body = req.body || {};
      const c = body.customer || {};
      if (!String(c.name || '').trim()) return res.status(400).json({ message: 'Nome é obrigatório' });
      if (onlyDigits(c.phone).length < 10) return res.status(400).json({ message: 'Telefone inválido' });
      if (!String(c.address || '').trim()) return res.status(400).json({ message: 'Endereço é obrigatório' });
      if ((c.customerType || 'pessoa_fisica') === 'pessoa_fisica' && onlyDigits(c.cpfCnpj).length !== 11) {
        return res.status(400).json({ message: 'CPF é obrigatório e deve ter 11 dígitos' });
      }
      if (body.paymentMethod !== 'pix') return res.status(400).json({ message: 'Método de pagamento deve ser PIX' });

      const totals = await computeServerTotal(body);
      if ('error' in totals) return res.status(400).json({ message: totals.error });
      const clientTotal = Number(body.totalAmount) || 0;
      if (Math.abs(totals.total - clientTotal) > 0.01) {
        return res.status(400).json({ message: 'O total do pedido não corresponde aos preços atuais dos produtos', serverTotal: totals.total, clientTotal });
      }
      if (totals.total <= 0) return res.status(400).json({ message: 'Total inválido' });

      const accounts = await storage.getFinancialAccounts();
      const account = (accounts || []).find((a: any) => a.bbPixEnabled && a.pixKey);
      if (!account) return res.status(503).json({ message: 'Pagamento PIX indisponível no momento. Tente novamente em instantes.' });

      const charge = await bbPixService.createImmediateCharge(account.id, {
        amount: totals.total,
        debtorName: String(c.name).slice(0, 120),
        debtorDocument: onlyDigits(c.cpfCnpj) || undefined,
        description: 'Pedido loja Honest Sucos',
        expirationSeconds: EXPIRATION_SECONDS,
        createdBy: 'loja-hotsite',
      });

      const expiresAt = new Date(Date.now() + EXPIRATION_SECONDS * 1000);
      const ins: any = await db.execute(sql`INSERT INTO hotsite_pending_pix (charge_id, txid, amount, payload, status, expires_at) VALUES (${charge.id}, ${charge.txid}, ${totals.total.toFixed(2)}, ${JSON.stringify(body)}, 'awaiting_payment', ${expiresAt}) RETURNING id`);
      const pendingId = ((ins.rows || ins)[0] || {}).id;

      console.log(`📱 [LOJA-PIX] Cobrança criada p/ checkout: R$ ${totals.total.toFixed(2)} pending=${pendingId} txid=${charge.txid}`);
      res.status(201).json({
        pendingId,
        txid: charge.txid,
        amount: totals.total,
        qrCodeBase64: charge.qrCodeBase64,
        pixCopiaECola: charge.pixCopiaECola,
        expiresAt: expiresAt.toISOString(),
        referralDiscount: totals.refPct > 0 ? { pct: totals.refPct, amount: totals.refDiscount, total: totals.total } : null,
      });
    } catch (e: any) {
      console.error('❌ [LOJA-PIX] Erro no pix/init:', e?.message || e);
      res.status(500).json({ message: 'Erro ao gerar o PIX. Tente novamente.' });
    }
  });

  // Consulta o status; quando o PIX confirma, cria o pedido (idempotente)
  app.get('/api/public/orders/pix/:id/status', async (req, res) => {
    try {
      await ensureTable();
      const rs: any = await db.execute(sql`SELECT * FROM hotsite_pending_pix WHERE id = ${req.params.id}`);
      const row = (rs.rows || rs)[0];
      if (!row) return res.status(404).json({ status: 'not_found' });
      if (row.status === 'paid') return res.json({ status: 'paid', orderId: row.order_id, orderNumber: row.order_number });
      if (row.status === 'expired') return res.json({ status: 'expired' });
      if (row.status === 'error') return res.json({ status: 'paid_order_error' });
      if (row.status === 'finalizing') return res.json({ status: 'processing' });
      const out = await checkAndFinalize(row);
      res.json(out);
    } catch (e: any) {
      console.error('❌ [LOJA-PIX] Erro no pix/status:', e?.message || e);
      res.status(500).json({ status: 'error_check' });
    }
  });

  // Varredura de segurança: confirma pagamentos mesmo se o cliente fechou o navegador
  setInterval(() => { void sweepPending(); }, SWEEP_INTERVAL_MS);
  console.log('🛒 [LOJA-PIX] Rotas de PIX do checkout registradas (pagar-antes, BB)');
}
