// ============================================================================
// CIELO — LINK DE PAGAMENTO & CHECKOUT (MATRIZ, CNPJ 28.295.493/0001-53)
// ----------------------------------------------------------------------------
// Por que este módulo existe:
//   A API E-commerce 3.0 (server/hotsite-card.ts, POST /1/sales) está presa na
//   filial 0002-34, cujo credenciamento segue "em análise" pela Cielo (devolve
//   ReturnCode 002 em 100% das autorizações). A MATRIZ, por outro lado, tem o
//   produto "Link de Pagamento & Checkout" ATIVO, com Merchant ID próprio.
//   Este módulo fala com essa API — outra base, outra autenticação, outro fluxo.
//
// DIFERENÇAS que importam (vs. E-commerce 3.0):
//   - Autenticação: OAuth Basic -> access_token (Bearer), válido 20 min.
//   - O cliente paga numa página HOSPEDADA PELA CIELO. Dado de cartão NUNCA
//     passa pelo nosso servidor (some o risco PCI do checkout próprio).
//   - A confirmação é ASSÍNCRONA, por webhook POST (form-urlencoded).
//   - Carteiras (Google Pay etc.) e Pix são configurados no painel da Cielo,
//     não precisam do Google Pay Console nem de GOOGLE_PAY_MERCHANT_ID.
//
// REGRA COMERCIAL (Flavio, 01/ago/2026): SEM PARCELAMENTO — crédito 1x sempre.
//   Aqui isso é imposto no payload (maxNumberOfInstallments/fixedinstallments)
//   e também deve estar travado no painel (defesa em profundidade).
//
// SEGURANÇA: este arquivo nunca loga clientSecret nem access_token.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const BASE = (process.env.CIELO_LINK_BASE || 'https://cieloecommerce.cielo.com.br').replace(/\/+$/, '');

export type CieloLinkConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  merchantId: string;
  base: string;
};

export function cieloLinkConfig(): CieloLinkConfig {
  return {
    enabled: String(process.env.CIELO_LINK_ENABLED || '').trim().toLowerCase() === 'true',
    clientId: String(process.env.CIELO_LINK_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.CIELO_LINK_CLIENT_SECRET || '').trim(),
    merchantId: String(process.env.CIELO_LINK_MERCHANT_ID || '').trim(),
    base: BASE,
  };
}

/** Só usa a API do Link quando ligada E com credenciais presentes. */
export function cieloLinkEnabled(): boolean {
  const c = cieloLinkConfig();
  return c.enabled && !!c.clientId && !!c.clientSecret;
}

async function linkFetch(url: string, opts: any, timeoutMs = 30000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Token (vale 20 min na Cielo — guardamos 15 para não usar token na virada)
// ---------------------------------------------------------------------------
let _tok: { value: string; exp: number } | null = null;

export async function getLinkToken(force = false): Promise<string> {
  const cfg = cieloLinkConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('cielo-link: credenciais ausentes (CIELO_LINK_CLIENT_ID/SECRET)');
  if (!force && _tok && _tok.exp > Date.now()) return _tok.value;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const r = await linkFetch(`${cfg.base}/api/public/v2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const txt = await r.text();
  let j: any = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* resposta não-JSON */ }

  if (!r.ok || !j?.access_token) {
    // NUNCA logar o basic/secret — só status e mensagem da Cielo.
    throw new Error(`cielo-link: falha ao obter token (HTTP ${r.status}) ${String(j?.message || txt || '').slice(0, 200)}`);
  }
  const ttlMs = Math.max(60, Number(j.expires_in || 1200) - 300) * 1000; // -5 min de folga
  _tok = { value: String(j.access_token), exp: Date.now() + ttlMs };
  return _tok.value;
}

export function resetLinkToken(): void { _tok = null; }

// ---------------------------------------------------------------------------
// orderNumber: é a CHAVE que casa o webhook com o nosso payment_links.
// A Cielo limita a 20 caracteres para conciliação -> mantemos curto e único.
// Formato: PL + base36(timestamp) + 3 chars aleatórios  (~13 chars)
// ---------------------------------------------------------------------------
export function shortOrderNumber(prefix = 'PL'): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}${ts}${rnd}`.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Criar link de pagamento
// ---------------------------------------------------------------------------
export type CreateCieloLinkArgs = {
  name: string;                 // aparece na tela de pagamento (máx 128)
  amount: number;               // em REAIS (convertemos para centavos aqui)
  orderNumber: string;          // <= 20 chars, único
  description?: string | null;  // máx 256
  expirationDate?: string | null; // YYYY-MM-DD
  softDescriptor?: string | null; // máx 13 — fatura do cartão
  sku?: string | null;
  type?: 'Payment' | 'Asset' | 'Digital' | 'Service' | 'Recurrent';
};

export type CreateCieloLinkResult = {
  ok: boolean;
  checkoutUrl?: string;
  productId?: string;
  orderNumber?: string;
  error?: string;
  httpStatus?: number;
  raw?: any;
};

export async function createCieloLink(args: CreateCieloLinkArgs): Promise<CreateCieloLinkResult> {
  const cfg = cieloLinkConfig();
  try {
    const cents = Math.round((Number(args.amount) || 0) * 100);
    if (!(cents > 0)) return { ok: false, error: 'valor invalido' };

    const token = await getLinkToken();
    const build = (tipo: string) => {
      const b: any = {
      type: tipo,
      name: String(args.name || 'Pagamento').slice(0, 128),
      price: cents,
      orderNumber: String(args.orderNumber).slice(0, 20),
      // ⚠️ SEM PARCELAMENTO — crédito 1x (regra comercial de 01/ago/2026)
      maxNumberOfInstallments: 1,
      fixedinstallments: 1,
      // link de uso único: 1 transação válida
      quantity: '1',
      // A API exige o objeto de frete mesmo em cobranca sem entrega — a entrega
      // da Honest e feita pela propria rota, entao nunca ha frete no link.
      shipping: { type: 'WithoutShipping' },
      };
      if (args.description) { b.description = String(args.description).slice(0, 256); b.showDescription = true; }
      if (args.expirationDate) b.expirationDate = args.expirationDate;
      if (args.softDescriptor) b.softDescriptor = String(args.softDescriptor).slice(0, 13);
      if (args.sku) b.sku = String(args.sku).slice(0, 32);
      return b;
    };

    const post = async (tipo: string) => {
      const r = await linkFetch(`${cfg.base}/api/public/v1/products/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(build(tipo)),
      });
      const txt = await r.text();
      let j: any = null;
      try { j = txt ? JSON.parse(txt) : null; } catch { /* ignora */ }
      return { r, j, txt };
    };

    const tipo1 = args.type || 'Payment';
    let { r, j, txt } = await post(tipo1);
    // Alguns cadastros nao aceitam o tipo "Payment" (regra de negocio da Cielo).
    // Nesse caso tentamos UMA vez como "Service", que aceita frete WithoutShipping.
    if (r.status === 400 && tipo1 !== 'Service') {
      console.warn(`⚠️ [CIELO-LINK] tipo ${tipo1} recusado (${String(j?.message || txt || '').slice(0, 160)}) — tentando como Service`);
      ({ r, j, txt } = await post('Service'));
    }

    if (!r.ok || !j) {
      return { ok: false, httpStatus: r.status, error: String(j?.message || txt || `HTTP ${r.status}`).slice(0, 300), raw: j };
    }

    const url = extractCheckoutUrl(j);
    if (!url) return { ok: false, httpStatus: r.status, error: 'resposta da Cielo sem URL do link', raw: j };

    return { ok: true, checkoutUrl: url, productId: String(j.id || j.productId || ''), orderNumber: String(args.orderNumber).slice(0, 20), httpStatus: r.status, raw: j };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** A Cielo já devolveu a URL em formatos diferentes ao longo das versões — cobrimos os conhecidos. */
export function extractCheckoutUrl(j: any): string | null {
  if (!j) return null;
  if (typeof j.shortUrl === 'string' && j.shortUrl) return j.shortUrl;
  if (typeof j.link === 'string' && j.link) return j.link;
  if (typeof j.url === 'string' && j.url) return j.url;
  const links = j.links || j.Links;
  if (Array.isArray(links)) {
    const short = links.find((l: any) => String(l?.rel || '').toLowerCase().includes('short'));
    if (short?.href) return String(short.href);
    const first = links.find((l: any) => l?.href);
    if (first?.href) return String(first.href);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consulta de pedido — usada na reconciliação (webhook perdido) e no diag
// ---------------------------------------------------------------------------
export async function queryCieloOrder(orderNumber: string): Promise<{ ok: boolean; status?: string | number; paid?: boolean; raw?: any; error?: string; httpStatus?: number }> {
  const cfg = cieloLinkConfig();
  try {
    if (!cfg.merchantId) return { ok: false, error: 'CIELO_LINK_MERCHANT_ID ausente' };
    const token = await getLinkToken();
    const r = await linkFetch(`${cfg.base}/api/public/v2/orders/${encodeURIComponent(cfg.merchantId)}/${encodeURIComponent(orderNumber)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const txt = await r.text();
    let j: any = null;
    try { j = txt ? JSON.parse(txt) : null; } catch { /* ignora */ }
    if (!r.ok) return { ok: false, httpStatus: r.status, error: String(j?.message || txt || `HTTP ${r.status}`).slice(0, 300), raw: j };

    // Na consulta a Cielo devolve o status por EXTENSO ("Paid", "Denied"...)
    const st = j?.payment?.status ?? j?.payment_status ?? j?.status;
    const paid = String(st ?? '').toLowerCase() === 'paid' || Number(st) === 2;
    return { ok: true, status: st, paid, raw: j, httpStatus: r.status };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Status do Link de Pagamento (inteiro no webhook, texto no GET)
// ---------------------------------------------------------------------------
export const LINK_PAYMENT_STATUS: Record<number, string> = {
  1: 'pendente',
  2: 'pago',
  3: 'negado',
  4: 'expirado',
  5: 'cancelado',
  6: 'nao_finalizado',
  7: 'autorizado',              // aguardando captura (até 15 dias)
  10: 'aguardando_biometria',
};

export type LinkWebhook = {
  orderNumber: string;
  cieloOrderNumber?: string | null;
  statusCode: number | null;
  statusLabel: string;
  paid: boolean;
  amount: number | null;        // em REAIS
  tid?: string | null;
  nsu?: string | null;
  authorizationCode?: string | null;
  brand?: string | null;
  methodType?: string | null;
  last4?: string | null;
  installments?: number | null;
  isTest: boolean;
  customerName?: string | null;
  customerEmail?: string | null;
};

/**
 * Normaliza a notificação da Cielo (form-urlencoded, ~40 campos).
 * Tolerante a variações de nome/caixa entre as versões do produto.
 */
export function parseLinkWebhook(body: any): LinkWebhook | null {
  if (!body || typeof body !== 'object') return null;
  const pick = (...keys: string[]): any => {
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
      // tenta case-insensitive
      const hit = Object.keys(body).find((bk) => bk.toLowerCase() === k.toLowerCase());
      if (hit && body[hit] !== undefined && body[hit] !== null && body[hit] !== '') return body[hit];
    }
    return undefined;
  };

  const orderNumber = String(pick('order_number', 'orderNumber', 'MerchantOrderNumber', 'merchant_order_number') || '').trim();
  if (!orderNumber) return null;

  const rawStatus = pick('payment_status', 'paymentStatus', 'status', 'Status');
  const statusCode = rawStatus === undefined ? null : Number(rawStatus);
  const label = statusCode != null && LINK_PAYMENT_STATUS[statusCode] ? LINK_PAYMENT_STATUS[statusCode] : String(rawStatus ?? 'desconhecido');

  const rawAmount = pick('amount', 'Amount');
  const amount = rawAmount === undefined ? null : Math.round(Number(rawAmount)) / 100; // vem em centavos

  const masked = String(pick('payment_maskedcreditcard', 'maskedCreditCard') || '');
  const last4 = masked ? (masked.replace(/\D/g, '').slice(-4) || null) : null;

  const testRaw = String(pick('test_transaction', 'testTransaction') || '').toLowerCase();

  return {
    orderNumber,
    cieloOrderNumber: String(pick('checkout_cielo_order_number', 'checkoutCieloOrderNumber') || '') || null,
    statusCode,
    statusLabel: label,
    paid: statusCode === 2,
    amount: amount != null && isFinite(amount) ? amount : null,
    tid: String(pick('tid', 'Tid') || '') || null,
    nsu: String(pick('nsu', 'Nsu') || '') || null,
    authorizationCode: String(pick('authorization_code', 'authorizationCode') || '') || null,
    brand: String(pick('payment_method_brand', 'paymentMethodBrand') || '') || null,
    methodType: String(pick('payment_method_type', 'paymentMethodType') || '') || null,
    last4,
    installments: pick('payment_installments') !== undefined ? Number(pick('payment_installments')) : null,
    isTest: testRaw === 'true' || testRaw === '1',
    customerName: String(pick('customer_name', 'customerName') || '') || null,
    customerEmail: String(pick('customer_email', 'customerEmail') || '') || null,
  };
}

// ---------------------------------------------------------------------------
// Log cru das notificações — mesmo padrão já usado no projeto (diagnóstico)
// ---------------------------------------------------------------------------
export async function logLinkWebhook(kind: string, payload: any): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO webhook_debug_log
      (raw_payload, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to)
      VALUES (${JSON.stringify(payload || {}).slice(0, 40000)}, ${'CIELO-LINK:' + String(kind).slice(0, 20)},
              ${null}, ${null}, ${false}, ${null})`);
  } catch { /* log nunca derruba o webhook */ }
}

// ---------------------------------------------------------------------------
// Diagnóstico (admin) — NUNCA devolve credencial
// ---------------------------------------------------------------------------
export async function cieloLinkDiag(): Promise<any> {
  const cfg = cieloLinkConfig();
  const out: any = {
    enabled: cfg.enabled,
    base: cfg.base,
    merchantId_mascarado: cfg.merchantId ? cfg.merchantId.slice(0, 8) + '…' : null,
    clientId_tamanho: cfg.clientId.length,
    clientSecret_tamanho: cfg.clientSecret.length,
    credenciais_presentes: !!(cfg.clientId && cfg.clientSecret),
  };
  if (!out.credenciais_presentes) { out.diagnostico = 'FALTAM CREDENCIAIS (CIELO_LINK_CLIENT_ID/SECRET no Railway)'; return out; }
  try {
    await getLinkToken(true);
    out.token = 'OK';
    out.diagnostico = 'AUTENTICACAO OK — pronto para criar links';
  } catch (e: any) {
    out.token = 'FALHOU';
    out.erro = String(e?.message || e).slice(0, 300);
    out.diagnostico = 'FALHA NA AUTENTICACAO — conferir ClientId/ClientSecret e se o EC é o 3000878647 (matriz)';
  }
  return out;
}
