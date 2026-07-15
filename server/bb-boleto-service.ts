import axios, { AxiosInstance } from 'axios';
import QRCode from 'qrcode';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { storage } from './storage';
import type { FinancialAccount } from '@shared/schema';
import { nowBrazil } from './brazilTimezone';

// ============================================================================
// BB Boleto (API Cobranca v2) — registro de boleto hibrido (boleto + PIX).
// Reusa a auth BB por conta financeira (bbClientId/bbClientSecret/bbDevAppKey),
// igual ao bb-pix-service. Default HOMOLOGACAO (sandbox) ate o cutover.
// Para producao: BB_BOLETO_SANDBOX=false (env Railway).
// ============================================================================

const BB_OAUTH_URL_PROD = 'https://oauth.bb.com.br/oauth/token';
const BB_OAUTH_URL_SANDBOX = 'https://oauth.sandbox.bb.com.br/oauth/token';
const BB_API_URL_PROD = 'https://api.bb.com.br/cobrancas/v2';
const BB_API_URL_SANDBOX = 'https://api.sandbox.bb.com.br/cobrancas/v2';

// Default = SANDBOX (homologacao). So vira producao com BB_BOLETO_SANDBOX=false.
function isSandbox(): boolean {
  return process.env.BB_BOLETO_SANDBOX !== 'false';
}

function getOAuthUrl(): string {
  return isSandbox() ? BB_OAUTH_URL_SANDBOX : BB_OAUTH_URL_PROD;
}

function getApiUrl(): string {
  return isSandbox() ? BB_API_URL_SANDBOX : BB_API_URL_PROD;
}

interface BBTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Resposta do POST /boletos (campos principais; BB retorna mais)
interface BBBoletoResponse {
  numero?: string; // numeroTituloCliente (20 digitos)
  numeroCarteira?: number;
  numeroVariacaoCarteira?: number;
  codigoCliente?: number;
  linhaDigitavel?: string;
  codigoBarraNumerico?: string;
  numeroContratoCobranca?: number;
  beneficiario?: any;
  qrCode?: {
    url?: string;
    txId?: string;
    emv?: string; // pix copia e cola
  };
}

const tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

function createApiClient(account: FinancialAccount): AxiosInstance {
  if (!account.bbDevAppKey) {
    throw new Error('Developer Application Key do BB (bbDevAppKey) nao configurada na conta financeira');
  }
  return axios.create({
    baseURL: getApiUrl(),
    headers: { 'Content-Type': 'application/json' },
    // gw-dev-app-key vai como QUERY PARAM na API de Cobranca (diferente do PIX, que usa header)
    params: { 'gw-dev-app-key': account.bbDevAppKey },
    timeout: 30000,
  });
}

async function getAccessToken(account: FinancialAccount): Promise<string> {
  const cacheKey = `bbBoleto_${account.id}_${isSandbox() ? 'sbx' : 'prd'}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }
  if (!account.bbClientId || !account.bbClientSecret) {
    throw new Error('Client ID e Client Secret do BB nao configurados na conta financeira');
  }
  const credentials = Buffer.from(`${account.bbClientId}:${account.bbClientSecret}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'cobrancas.boletos-info cobrancas.boletos-requisicao',
  });
  const response = await axios.post<BBTokenResponse>(getOAuthUrl(), params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    timeout: 15000,
  });
  const { access_token, expires_in } = response.data;
  tokenCache.set(cacheKey, { token: access_token, expiresAt: Date.now() + expires_in * 1000 });
  console.log(`🔑 [BB-BOLETO] Token obtido (${isSandbox() ? 'sandbox' : 'producao'}) para conta ${account.name}`);
  return access_token;
}

function digits(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

function pad(s: string | number, len: number): string {
  return String(s).padStart(len, '0').slice(-len);
}

// dd.mm.aaaa exigido pela API de Cobranca do BB
function formatBBDate(d: Date): string {
  const dd = pad(d.getDate(), 2);
  const mm = pad(d.getMonth() + 1, 2);
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// Gera o proximo nosso-numero (10 digitos) sequencial por convenio, lendo o MAX
// ja gravado em boleto_charges. Em producao, o ideal e uma sequence dedicada.
async function nextNossoNumero(_numeroConvenio: string): Promise<string> {
  // O 1.0 ainda emite boletos no MESMO convenio; derivar de MAX(boleto_charges) colidiria
  // com numeros ja registrados pelo 1.0 no BB ("Nosso Numero ja incluido"). Base temporal
  // (10 ultimos digitos do epoch em ms) e sempre alta/crescente e nao colide com a faixa do 1.0.
  return pad((Date.now() % 10000000000).toString(), 10);
}

export interface RegistrarBoletoParams {
  amount: number;
  dueDate: Date;
  debtorName: string;
  debtorDocument: string; // cpf/cnpj
  debtorAddress?: string;
  debtorCity?: string;
  debtorNeighborhood?: string;
  debtorState?: string;
  debtorZip?: string;
  description?: string;
  instrucoes?: string;
  receivableId?: string | null;
  fiscalInvoiceId?: string | null;
  customerId?: string | null;
  billingPipelineId?: string | null;
  createdBy?: string | null;
}

export interface RegistrarBoletoResult {
  success: boolean;
  sandbox: boolean;
  error?: string;
  persistError?: string;
  boletoChargeId?: string;
  numeroTituloCliente?: string;
  nossoNumero?: string;
  linhaDigitavel?: string;
  codigoBarras?: string;
  pixCopiaECola?: string;
  raw?: any;
}

/**
 * Registra um boleto hibrido (boleto + PIX) no BB e grava em boleto_charges.
 * Idempotente: se ja existe boleto para o receivable, retorna o existente.
 */
export async function registrarBoleto(
  accountId: string,
  params: RegistrarBoletoParams
): Promise<RegistrarBoletoResult> {
  const sandbox = isSandbox();

  const account = await storage.getFinancialAccount(accountId);
  if (!account) return { success: false, sandbox, error: 'Conta financeira nao encontrada' };
  if (!account.bbBoletoEnabled) {
    return { success: false, sandbox, error: 'Boleto BB nao habilitado para esta conta (bbBoletoEnabled=false)' };
  }
  if (!account.bbConvenio) {
    return { success: false, sandbox, error: 'Convenio de cobranca (bbConvenio) nao configurado na conta' };
  }
  if (!account.bbClientId || !account.bbClientSecret || !account.bbDevAppKey) {
    return { success: false, sandbox, error: 'Credenciais BB (clientId/clientSecret/devAppKey) ausentes na conta' };
  }

  // Idempotencia por receivable
  if (params.receivableId) {
    try {
      const ex: any = await db.execute(sql`
        SELECT id, nosso_numero, linha_digitavel, codigo_barras, pix_copia_e_cola
        FROM boleto_charges WHERE receivable_id = ${params.receivableId}
          AND status <> 'cancelado' AND status <> 'cancelada'
        ORDER BY created_at DESC LIMIT 1
      `);
      if (ex.rows?.[0]) {
        const row = ex.rows[0];
        return {
          success: true, sandbox,
          boletoChargeId: row.id,
          nossoNumero: row.nosso_numero,
          linhaDigitavel: row.linha_digitavel,
          codigoBarras: row.codigo_barras,
          pixCopiaECola: row.pix_copia_e_cola,
        };
      }
    } catch { /* segue para registrar */ }
  }

  const numeroConvenio = digits(account.bbConvenio);
  const numeroCarteira = parseInt(digits(account.bbCarteira) || '17', 10);
  const numeroVariacaoCarteira = parseInt(digits(account.bbVariacaoCarteira) || '0', 10);
  const nossoNumero = await nextNossoNumero(numeroConvenio);
  // numeroTituloCliente: "000" + convenio(7) + nossoNumero(10) = 20 digitos
  const numeroTituloCliente = '000' + pad(numeroConvenio, 7) + nossoNumero;

  const doc = digits(params.debtorDocument);
  const tipoInscricao = doc.length === 14 ? 2 : 1; // 1=CPF, 2=CNPJ

  // BB rejeita dataEmissao > dataVencimento. Para titulos vencidos, o vencimento
  // e reajustado para hoje (fuso BR) para permitir a (re)emissao do boleto/PIX;
  // o valor original e mantido e juros/multa passam a contar do novo vencimento.
  const hojeBR = nowBrazil();
  const dueMs = Date.UTC(params.dueDate.getFullYear(), params.dueDate.getMonth(), params.dueDate.getDate());
  const hojeMs = Date.UTC(hojeBR.getFullYear(), hojeBR.getMonth(), hojeBR.getDate());
  const effectiveDueDate = dueMs < hojeMs ? hojeBR : params.dueDate;

  const body: any = {
    numeroConvenio: parseInt(numeroConvenio, 10),
    numeroCarteira,
    numeroVariacaoCarteira,
    codigoModalidade: 1,
    dataEmissao: formatBBDate(hojeBR),
    dataVencimento: formatBBDate(effectiveDueDate),
    valorOriginal: Number(params.amount.toFixed(2)),
    valorAbatimento: 0,
    quantidadeDiasProtesto: 0,
    indicadorNumeroDiasLimiteRecebimento: 'N',
    numeroDiasLimiteRecebimento: 0,
    codigoAceite: 'N',
    codigoTipoTitulo: 2,
    descricaoTipoTitulo: 'DM',
    indicadorPermissaoRecebimentoParcial: 'N',
    numeroTituloBeneficiario: nossoNumero,
    numeroTituloCliente,
    indicadorPix: 'S',
    pagador: {
      tipoInscricao,
      numeroInscricao: parseInt(doc || '0', 10),
      nome: (params.debtorName || 'Cliente').slice(0, 60),
      endereco: (params.debtorAddress || 'Nao informado').slice(0, 60),
      // CEP: BB recusa cep=0/invalido. Se o cliente nao tem CEP valido (8 digitos),
      // usa um CEP padrao valido de Goiania (74000-000) para o registro nao falhar.
      cep: parseInt((digits(params.debtorZip).length === 8 ? digits(params.debtorZip) : '74000000'), 10),
      cidade: (params.debtorCity || 'Goiania').slice(0, 30),
      bairro: (params.debtorNeighborhood || 'Centro').slice(0, 30),
      uf: (params.debtorState || 'GO').slice(0, 2),
    },
  };

  // Juros / multa por conta (opcionais)
  if (account.bbJurosPercentual && parseFloat(account.bbJurosPercentual) > 0) {
    body.jurosMora = { tipo: 2, porcentagem: parseFloat(account.bbJurosPercentual) };
  } else {
    body.jurosMora = { tipo: 0 };
  }
  if (account.bbMultaPercentual && parseFloat(account.bbMultaPercentual) > 0) {
    const multaDate = new Date(effectiveDueDate); multaDate.setDate(multaDate.getDate() + 1); // BB exige data da multa POSTERIOR ao vencimento (usa vencimento efetivo)
    body.multa = { tipo: 2, porcentagem: parseFloat(account.bbMultaPercentual), data: formatBBDate(multaDate) };
  }

  const instrucoesLinhas = [
    account.bbInstrucaoLinha1, account.bbInstrucaoLinha2,
    account.bbInstrucaoLinha3, account.bbInstrucaoLinha4,
  ].filter(Boolean).join(' ');
  const instrucoes = params.instrucoes || instrucoesLinhas || null;
  if (instrucoes) body.mensagemBloquetoOcorrencia = String(instrucoes).slice(0, 165);

  let bbData: BBBoletoResponse;
  try {
    const token = await getAccessToken(account);
    const client = createApiClient(account);
    console.log(`🧾 [BB-BOLETO] Registrando boleto ${numeroTituloCliente} R$ ${params.amount.toFixed(2)} (${sandbox ? 'sandbox' : 'PRODUCAO'})`);
    const resp = await client.post<BBBoletoResponse>('/boletos', body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    bbData = resp.data;
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err?.message;
    console.error('❌ [BB-BOLETO] Falha ao registrar:', detail);
    return { success: false, sandbox, error: `BB: ${detail}`, numeroTituloCliente, nossoNumero };
  }

  // QR Code PIX hibrido (emv = pix copia e cola)
  const pixCopiaECola = bbData.qrCode?.emv || null;
  let pixQrBase64: string | null = null;
  if (pixCopiaECola) {
    try {
      const dataUrl = await QRCode.toDataURL(pixCopiaECola, { width: 300, margin: 2 });
      pixQrBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    } catch { /* ignore */ }
  }

  const linhaDigitavel = bbData.linhaDigitavel || null;
  const codigoBarras = bbData.codigoBarraNumerico || null;

  // Persistir em boleto_charges (colunas confirmadas via cobranca-generator do front)
  let boletoChargeId: string | undefined;
  let persistError: string | null = null;
  try {
    const ins: any = await db.execute(sql`
      INSERT INTO boleto_charges (
        id, nosso_numero, numero_convenio, numero_carteira, linha_digitavel, codigo_barras,
        data_vencimento, valor_original, debtor_name, debtor_document, instrucoes,
        pix_copia_e_cola, pix_qr_code_base64, status,
        receivable_id, fiscal_invoice_id, customer_id, created_at
      ) VALUES (
        gen_random_uuid(), ${nossoNumero}, ${numeroConvenio}, ${String(numeroCarteira)}, ${linhaDigitavel}, ${codigoBarras},
        ${params.dueDate}, ${params.amount.toFixed(2)}, ${params.debtorName}, ${doc}, ${instrucoes},
        ${pixCopiaECola}, ${pixQrBase64}, ${'registrado'},
        ${params.receivableId || null}, ${params.fiscalInvoiceId || null}, ${params.customerId || null}, now()
      )
      RETURNING id
    `);
    boletoChargeId = ins.rows?.[0]?.id;
  } catch (e: any) {
    // Se alguma coluna nao existir, registra o erro mas devolve os dados do BB.
    persistError = e?.message || String(e);
    console.error('⚠️ [BB-BOLETO] Boleto registrado no BB mas falha ao gravar boleto_charges:', persistError);
  }

  console.log(`✅ [BB-BOLETO] Boleto ${numeroTituloCliente} registrado. Linha: ${linhaDigitavel || '(sem linha)'}`);
  return {
    success: true, sandbox,
    boletoChargeId,
    persistError: persistError || undefined,
    numeroTituloCliente,
    nossoNumero,
    linhaDigitavel: linhaDigitavel || undefined,
    codigoBarras: codigoBarras || undefined,
    pixCopiaECola: pixCopiaECola || undefined,
    raw: bbData,
  };
}

/** Baixa/cancela um boleto no BB (comando de baixa) — deixa o boleto IMPAGÁVEL no banco. */
export async function cancelarBoleto(accountId: string, charge: any): Promise<{ ok: boolean; sandbox: boolean; error?: string; alreadyBaixado?: boolean }> {
  const sandbox = isSandbox();
  const account = await storage.getFinancialAccount(accountId);
  if (!account) return { ok: false, sandbox, error: 'Conta financeira nao encontrada' };
  const numeroConvenio = digits(String(account.bbConvenio || charge?.numero_convenio || ''));
  const nossoNumero = digits(String(charge?.nosso_numero || ''));
  if (!numeroConvenio || !nossoNumero) return { ok: false, sandbox, error: 'Convenio/nosso numero ausentes para baixa' };
  const numeroTituloCliente = '000' + pad(numeroConvenio, 7) + nossoNumero;
  try {
    const token = await getAccessToken(account);
    const client = createApiClient(account);
    console.log(`🚫 [BB-BOLETO] Baixando/cancelando boleto ${numeroTituloCliente} (${sandbox ? 'sandbox' : 'PRODUCAO'})`);
    await client.post(`/boletos/${numeroTituloCliente}/baixar`, { numeroConvenio: parseInt(numeroConvenio, 10) }, { headers: { Authorization: `Bearer ${token}` } });
    return { ok: true, sandbox };
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err?.message;
    // Se o BB indicar que ja esta baixado/liquidado/inexistente, tratar como ja cancelado (idempotente).
    if (/baix|liquid|inexist|nao\s+exist|n[aã]o\s+exist|j[aá]\s+/i.test(String(detail || ''))) {
      console.warn('[BB-BOLETO] baixa: BB indica ja baixado/inexistente — tratando como cancelado:', detail);
      return { ok: true, sandbox, alreadyBaixado: true };
    }
    console.error('❌ [BB-BOLETO] Falha ao baixar/cancelar:', detail);
    return { ok: false, sandbox, error: `BB: ${detail}` };
  }
}

/** Consulta um boleto registrado no BB pelo numeroTituloCliente (20 digitos). */
export async function consultarBoleto(accountId: string, numeroTituloCliente: string): Promise<any> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira nao encontrada');
  const token = await getAccessToken(account);
  const client = createApiClient(account);
  const numeroConvenio = digits(account.bbConvenio);
  const resp = await client.get(`/boletos/${digits(numeroTituloCliente)}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { numeroConvenio },
  });
  return resp.data;
}

/** Testa a conexao/credenciais BB Cobranca (obtem token). */
export async function testarConexaoBoleto(accountId: string): Promise<{ success: boolean; message: string; sandbox: boolean }> {
  const sandbox = isSandbox();
  try {
    const account = await storage.getFinancialAccount(accountId);
    if (!account) return { success: false, sandbox, message: 'Conta nao encontrada' };
    const token = await getAccessToken(account);
    if (!token) return { success: false, sandbox, message: 'Falha na autenticacao' };
    return { success: true, sandbox, message: `Conexao BB Cobranca OK (${sandbox ? 'Sandbox' : 'Producao'})` };
  } catch (error: any) {
    const detail = error?.response?.data ? JSON.stringify(error.response.data) : error?.message;
    return { success: false, sandbox, message: `Erro: ${detail}` };
  }
}

export function boletoIsSandbox(): boolean {
  return isSandbox();
}


// ============================================================================
// Conciliacao / baixa de boleto pago — webhook BB "BAIXA OPERACIONAL" + consulta
// ============================================================================

function pick(obj: any, keys: string[]): any {
  for (const k of keys) { if (obj && obj[k] != null && obj[k] !== '') return obj[k]; }
  return undefined;
}

// Aceita dd.mm.aaaa, dd/mm/aaaa ou aaaa-mm-dd -> ISO (aaaa-mm-dd)
function toISO(d: any): string | null {
  if (!d) return null;
  const s = String(d).trim();
  const m = s.match(/^(\d{2})[.\/](\d{2})[.\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

async function findFinancialAccountForConvenio(numeroConvenio: string | null): Promise<any | null> {
  try {
    const accts = await storage.getFinancialAccounts();
    if (numeroConvenio) {
      const m = (accts || []).find((a: any) => a.bbConvenio && digits(a.bbConvenio) === digits(numeroConvenio));
      if (m) return m;
    }
    return (accts || []).find((a: any) => a.bbBoletoEnabled && a.bbConvenio) || null;
  } catch { return null; }
}

export interface SettleResult {
  ok: boolean;
  alreadyPaid?: boolean;
  boletoChargeId?: string;
  receivableId?: string | null;
  receivableStatus?: string;
  amount?: number;
  message: string;
}

// Marca o boleto como liquidado e da baixa no recebivel vinculado (conciliacao).
// Atualiza tambem saldo da conta + movimento. Idempotente.
export async function settleBoletoCharge(charge: any, paidAmount: number, paidAtISO: string | null, source: string): Promise<SettleResult> {
  const already = String(charge.status || '').toLowerCase();
  if (already === 'liquidado' || already === 'pago' || already === 'recebido') {
    return { ok: true, alreadyPaid: true, boletoChargeId: charge.id, receivableId: charge.receivable_id || null, message: 'Boleto ja estava liquidado' };
  }
  const amount = paidAmount && paidAmount > 0 ? paidAmount : parseFloat(charge.valor_original || '0');
  const paidAt = paidAtISO ? new Date(paidAtISO) : new Date();

  try { await db.execute(sql`UPDATE boleto_charges SET status = 'liquidado' WHERE id = ${charge.id}`); } catch (e: any) { /* tolerante */ }

  // Titulos vinculados: boleto UNIFICADO (varios titulos via boleto_charge_receivables)
  // ou boleto simples (um unico receivable_id). Damos baixa em TODOS os titulos do boleto.
  let targets: Array<{ receivableId: string; alloc: number | null }> = [];
  try {
    const jr: any = await db.execute(sql`SELECT receivable_id, amount FROM boleto_charge_receivables WHERE boleto_charge_id = ${charge.id}`);
    if (jr.rows && jr.rows.length > 0) {
      targets = jr.rows.map((r: any) => ({ receivableId: r.receivable_id, alloc: r.amount != null ? parseFloat(r.amount) : null }));
    }
  } catch (e: any) { /* tabela pode nao existir em ambientes antigos — cai no fallback */ }
  if (targets.length === 0 && charge.receivable_id) {
    targets = [{ receivableId: charge.receivable_id, alloc: null }];
  }

  const account = await findFinancialAccountForConvenio(charge.numero_convenio);
  const done: Array<{ receivableId: string; status?: string }> = [];
  let remaining = amount;

  for (const t of targets) {
    try {
      const receivable: any = await storage.getReceivable(t.receivableId);
      if (!receivable) continue;
      const outstanding = parseFloat(receivable.amount) - parseFloat(receivable.amountPaid || '0');
      // Valor a baixar neste titulo: a alocacao gravada na juncao (saldo do titulo no
      // momento da geracao) e, no boleto simples, o valor pago inteiro. Limita ao que
      // resta do valor pago (rateio) para nunca baixar mais do que entrou.
      let pay = t.alloc != null ? t.alloc : (targets.length === 1 ? amount : outstanding);
      if (pay > remaining) pay = remaining;
      if (pay < 0) pay = 0;
      const totalPaid = parseFloat(receivable.amountPaid || '0') + pay;
      const receivableStatus = totalPaid >= parseFloat(receivable.amount) ? 'recebida' : 'a_vencer';
      await storage.updateReceivable(t.receivableId, {
        amountPaid: totalPaid.toFixed(2),
        status: receivableStatus as any,
        paymentMethod: 'boleto' as any,
        financialAccountId: account?.id || receivable.financialAccountId || null,
      } as any);
      try {
        await storage.createReceivablePayment({
          receivableId: t.receivableId,
          paidAt,
          amount: pay.toFixed(2),
          paymentMethod: 'boleto' as any,
          financialAccountId: account?.id || receivable.financialAccountId || null,
          reference: charge.nosso_numero || null,
          notes: `Baixa automatica boleto BB (${source}) - nosso ${charge.nosso_numero}${targets.length > 1 ? ' [boleto unificado]' : ''}`,
          createdBy: 'sistema',
        } as any);
      } catch (e: any) { console.warn('[BB-BOLETO] createReceivablePayment falhou:', e?.message); }
      remaining -= pay;
      done.push({ receivableId: t.receivableId, status: receivableStatus });
    } catch (e: any) { console.warn('[BB-BOLETO] baixa de recebivel falhou:', t.receivableId, e?.message); }
  }

  // Credita a conta UMA vez pelo total recebido (nao por titulo), so se algum titulo foi baixado.
  if (account && done.length > 0) {
    try {
      const cur = parseFloat(account.balance || '0'); const nb = cur + amount;
      await storage.updateFinancialAccount(account.id, { balance: nb.toFixed(2) } as any);
      await storage.createAccountMovement({
        financialAccountId: account.id, type: 'credito', amount: amount.toFixed(2), balanceAfter: nb.toFixed(2),
        description: `Boleto recebido BB - ${charge.debtor_name || 'N/A'} - nosso ${charge.nosso_numero}${targets.length > 1 ? ` (${targets.length} titulos)` : ''}`,
        sourceType: 'boleto_charge', sourceId: charge.id, reference: charge.nosso_numero || null,
        omieInstanceId: account.omieInstanceId || null, createdBy: 'sistema',
      } as any);
    } catch (e: any) { console.warn('[BB-BOLETO] movimento de conta falhou:', e?.message); }
  }

  const receivableStatus = done[0]?.status;
  console.log(`✅ [BB-BOLETO] Baixa (${source}): boleto ${charge.id} R$ ${amount.toFixed(2)} titulos=[${targets.map(t => t.receivableId).join(',') || '-'}] baixados=${done.length}`);
  return { ok: true, boletoChargeId: charge.id, receivableId: charge.receivable_id || targets[0]?.receivableId || null, receivableStatus, amount, message: `Boleto liquidado e ${done.length} titulo(s) baixado(s)` };
}

// Acha o boleto_charges a partir do payload do webhook BB (tolerante a nomes de campo).
async function findChargeFromWebhook(p: any): Promise<any | null> {
  const idCand = pick(p, ['numeroTituloCliente', 'numeroTituloBeneficiario', 'id', 'nossoNumero', 'numeroOperacao', 'numeroBoletoBB', 'seuNumero']);
  const nosso = idCand ? digits(String(idCand)) : '';
  if (nosso) {
    const last10 = nosso.slice(-10);
    const r: any = await db.execute(sql`
      SELECT * FROM boleto_charges
      WHERE regexp_replace(COALESCE(nosso_numero,''),'[^0-9]','','g') IN (${nosso}, ${last10})
      ORDER BY created_at DESC LIMIT 1`);
    if (r.rows?.[0]) return r.rows[0];
  }
  return null;
}

// Processa o payload do webhook do BB (liquidacao). Tolerante a objeto unico ou lista.
export async function processBoletoWebhook(payload: any): Promise<any> {
  const list = Array.isArray(payload?.boletos) ? payload.boletos
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload) ? payload : [payload];
  const results: any[] = [];
  for (const item of list) {
    try {
      const charge = await findChargeFromWebhook(item);
      if (!charge) { results.push({ matched: false, id: pick(item, ['numeroTituloCliente', 'id', 'nossoNumero']) }); continue; }
      const paid = parseFloat(String(pick(item, ['valorPagoSacado', 'valorRecebido', 'valorPago', 'valorLiquidacao', 'valor']) ?? charge.valor_original ?? '0').toString().replace(',', '.'));
      const dt = pick(item, ['dataLiquidacao', 'dataCredito', 'dataMovimento', 'dataRecebimento']);
      const r = await settleBoletoCharge(charge, paid, dt ? toISO(dt) : null, 'webhook');
      results.push({ matched: true, ...r });
    } catch (e: any) { results.push({ matched: false, error: e?.message }); }
  }
  return { processed: results.length, results };
}

// Consulta o boleto no BB e da baixa se estiver liquidado (fallback/teste/cron).
export async function checkAndSettleBoleto(boletoChargeId: string): Promise<any> {
  const r: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE id = ${boletoChargeId} LIMIT 1`);
  const charge = r.rows?.[0];
  if (!charge) return { ok: false, error: 'boleto_charge nao encontrado' };
  const account = await findFinancialAccountForConvenio(charge.numero_convenio);
  if (!account) return { ok: false, error: 'conta BB (convenio) nao encontrada' };
  const numeroTituloCliente = '000' + pad(digits(charge.numero_convenio || account.bbConvenio), 7) + pad(digits(charge.nosso_numero), 10);
  let bb: any;
  try { bb = await consultarBoleto(account.id, numeroTituloCliente); }
  catch (e: any) { return { ok: false, error: `consulta BB: ${e?.response?.data ? JSON.stringify(e.response.data) : e?.message}`, numeroTituloCliente }; }
  const estado = String(pick(bb, ['estadoTituloCobranca', 'codigoEstadoTituloCobranca', 'situacao']) || '').toUpperCase();
  const valorPago = parseFloat(String(pick(bb, ['valorPagoSacado', 'valorRecebido', 'valorPago']) || '0').toString().replace(',', '.'));
  const liquidado = /LIQUID|BAIX|PAG/.test(estado) || valorPago > 0;
  if (!liquidado) return { ok: true, paid: false, estado, numeroTituloCliente, raw: bb };
  const dt = pick(bb, ['dataCredito', 'dataRecebimento', 'dataMovimentoLiquidacao']);
  const res = await settleBoletoCharge(charge, valorPago || parseFloat(charge.valor_original || '0'), dt ? toISO(dt) : null, 'consulta');
  return { ok: true, paid: true, estado, ...res };
}


// FASE 1c - Varredura de boletos em aberto (consulta BB e da baixa nos pagos).
// Movida do endpoint HTTP para o agendador interno; o endpoint agora so dispara.
export async function sweepOpenBoletos(limit = 300, days = 120): Promise<{ candidates: number; checked: number; paid: number; settled: number }> {
  const r: any = await db.execute(sql`SELECT bc.id FROM boleto_charges bc JOIN receivables rr ON rr.id = bc.receivable_id WHERE COALESCE(bc.status,'') NOT IN ('liquidado','pago','recebido','cancelado','baixado') AND rr.status IN ('a_vencer','vencida') AND rr.deleted_at IS NULL AND bc.created_at > now() - make_interval(days => ${days}) ORDER BY bc.created_at DESC LIMIT ${limit}`);
  const ids = (r.rows || []).map((x: any) => x.id);
  let checked = 0, paid = 0, settled = 0; const errors: any[] = [];
  for (const id of ids) {
    try { const o: any = await checkAndSettleBoleto(id); checked++; if (o && o.paid) { paid++; if (!o.alreadyPaid) settled++; } }
    catch (e: any) { errors.push({ id, error: e?.message }); }
  }
  try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('boleto_check_open_last', ${JSON.stringify({ at: new Date().toISOString(), candidates: ids.length, checked, paid, settled, errors: errors.slice(0, 10) })}, 'cron-boleto') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch (e) {}
  console.log(`[BB-BOLETO] check-open concluido: candidates=${ids.length} checked=${checked} paid=${paid} settled=${settled}`);
  return { candidates: ids.length, checked, paid, settled };
}
