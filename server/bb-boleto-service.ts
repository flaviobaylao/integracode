import axios, { AxiosInstance } from 'axios';
import QRCode from 'qrcode';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { storage } from './storage';
import type { FinancialAccount } from '@shared/schema';

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

  const body: any = {
    numeroConvenio: parseInt(numeroConvenio, 10),
    numeroCarteira,
    numeroVariacaoCarteira,
    codigoModalidade: 1,
    dataEmissao: formatBBDate(new Date()),
    dataVencimento: formatBBDate(params.dueDate),
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
      cep: parseInt(digits(params.debtorZip) || '0', 10),
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
    const multaDate = new Date(params.dueDate); multaDate.setDate(multaDate.getDate() + 1); // BB exige data da multa POSTERIOR ao vencimento
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
