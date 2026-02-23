import axios, { AxiosInstance } from 'axios';
import QRCode from 'qrcode';
import { storage } from './storage';
import type { FinancialAccount, PixCharge } from '@shared/schema';

const BB_OAUTH_URL_PROD = 'https://oauth.bb.com.br/oauth/token';
const BB_OAUTH_URL_SANDBOX = 'https://oauth.sandbox.bb.com.br/oauth/token';
const BB_API_URL_PROD = 'https://api.bb.com.br/pix/v2';
const BB_API_URL_SANDBOX = 'https://api.sandbox.bb.com.br/pix/v2';

const IS_SANDBOX = process.env.BB_PIX_SANDBOX === 'true';

function getOAuthUrl() {
  return IS_SANDBOX ? BB_OAUTH_URL_SANDBOX : BB_OAUTH_URL_PROD;
}

function getApiUrl() {
  return IS_SANDBOX ? BB_API_URL_SANDBOX : BB_API_URL_PROD;
}

interface BBTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface BBCobResponse {
  txid: string;
  revisao: number;
  status: string;
  calendario: {
    criacao: string;
    expiracao: number;
  };
  devedor?: {
    cpf?: string;
    cnpj?: string;
    nome: string;
  };
  valor: {
    original: string;
  };
  chave: string;
  location: string;
  pixCopiaECola: string;
}

interface BBCobVResponse extends BBCobResponse {
  calendario: {
    criacao: string;
    expiracao: number;
    dataDeVencimento: string;
    validadeAposVencimento: number;
  };
}

interface BBPixPayment {
  endToEndId: string;
  txid: string;
  valor: string;
  horario: string;
  infoPagador?: string;
}

interface BBWebhookPayload {
  pix: BBPixPayment[];
}

const tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

function createApiClient(account: FinancialAccount): AxiosInstance {
  if (!account.bbDevAppKey) {
    throw new Error('Developer Application Key do BB não configurada');
  }

  return axios.create({
    baseURL: getApiUrl(),
    headers: {
      'Content-Type': 'application/json',
      'gw-dev-app-key': account.bbDevAppKey,
    },
    timeout: 30000,
  });
}

async function getAccessToken(account: FinancialAccount): Promise<string> {
  const cacheKey = `bb_${account.id}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  if (!account.bbClientId || !account.bbClientSecret) {
    throw new Error('Client ID e Client Secret do BB não configurados');
  }

  const credentials = Buffer.from(`${account.bbClientId}:${account.bbClientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'cob.write cob.read cobv.write cobv.read pix.read pix.write webhook.read webhook.write',
  });

  const response = await axios.post<BBTokenResponse>(getOAuthUrl(), params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    timeout: 15000,
  });

  const { access_token, expires_in } = response.data;

  tokenCache.set(cacheKey, {
    token: access_token,
    expiresAt: Date.now() + (expires_in * 1000),
  });

  console.log(`🔑 [BB-PIX] Token obtido com sucesso para conta ${account.name}`);
  return access_token;
}

function generateTxid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateQrCodeBase64(pixCopiaECola: string): Promise<string> {
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(pixCopiaECola, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    return qrCodeDataUrl;
  } catch (error) {
    console.error('❌ [BB-PIX] Erro ao gerar QR Code:', error);
    throw new Error('Falha ao gerar QR Code');
  }
}

export async function createImmediateCharge(
  accountId: string,
  params: {
    amount: number;
    debtorName?: string;
    debtorDocument?: string;
    description?: string;
    expirationSeconds?: number;
    receivableId?: string;
    customerId?: string;
    createdBy?: string;
  }
): Promise<PixCharge> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira não encontrada');
  if (!account.bbPixEnabled) throw new Error('PIX BB não habilitado para esta conta');
  if (!account.pixKey) throw new Error('Chave PIX não configurada para esta conta');

  const token = await getAccessToken(account);
  const client = createApiClient(account);
  const txid = generateTxid();

  const body: any = {
    calendario: {
      expiracao: params.expirationSeconds || 3600,
    },
    valor: {
      original: params.amount.toFixed(2),
    },
    chave: account.pixKey,
  };

  if (params.debtorName) {
    body.devedor = { nome: params.debtorName };
    if (params.debtorDocument) {
      const doc = params.debtorDocument.replace(/\D/g, '');
      if (doc.length === 11) {
        body.devedor.cpf = doc;
      } else if (doc.length === 14) {
        body.devedor.cnpj = doc;
      }
    }
  }

  if (params.description) {
    body.solicitacaoPagador = params.description;
  }

  console.log(`📱 [BB-PIX] Criando cobrança imediata: R$ ${params.amount.toFixed(2)} txid=${txid}`);

  const response = await client.put<BBCobResponse>(`/cob/${txid}`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const bbData = response.data;
  const qrCodeBase64 = await generateQrCodeBase64(bbData.pixCopiaECola);

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + (params.expirationSeconds || 3600));

  const pixCharge = await storage.createPixCharge({
    txid: bbData.txid || txid,
    chargeType: 'imediata',
    status: 'ATIVA',
    amount: params.amount.toFixed(2),
    pixKey: account.pixKey!,
    pixCopiaECola: bbData.pixCopiaECola,
    qrCodeBase64,
    location: bbData.location,
    expiresAt,
    debtorName: params.debtorName || null,
    debtorDocument: params.debtorDocument || null,
    description: params.description || null,
    financialAccountId: accountId,
    receivableId: params.receivableId || null,
    customerId: params.customerId || null,
    omieInstanceId: account.omieInstanceId || null,
    interResponse: JSON.stringify(bbData),
    createdBy: params.createdBy || null,
  });

  console.log(`✅ [BB-PIX] Cobrança criada: ${pixCharge.txid}`);
  return pixCharge;
}

export async function createDueDateCharge(
  accountId: string,
  params: {
    amount: number;
    dueDate: string;
    validityAfterDue?: number;
    debtorName: string;
    debtorDocument: string;
    description?: string;
    receivableId?: string;
    customerId?: string;
    createdBy?: string;
  }
): Promise<PixCharge> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira não encontrada');
  if (!account.bbPixEnabled) throw new Error('PIX BB não habilitado para esta conta');
  if (!account.pixKey) throw new Error('Chave PIX não configurada para esta conta');

  const token = await getAccessToken(account);
  const client = createApiClient(account);
  const txid = generateTxid();

  const doc = params.debtorDocument.replace(/\D/g, '');
  const body: any = {
    calendario: {
      dataDeVencimento: params.dueDate,
      validadeAposVencimento: params.validityAfterDue || 30,
    },
    devedor: {
      nome: params.debtorName,
      ...(doc.length === 11 ? { cpf: doc } : { cnpj: doc }),
    },
    valor: {
      original: params.amount.toFixed(2),
    },
    chave: account.pixKey,
  };

  if (params.description) {
    body.solicitacaoPagador = params.description;
  }

  console.log(`📱 [BB-PIX] Criando cobrança com vencimento: R$ ${params.amount.toFixed(2)} txid=${txid} venc=${params.dueDate}`);

  const response = await client.put<BBCobVResponse>(`/cobv/${txid}`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const bbData = response.data;
  const qrCodeBase64 = await generateQrCodeBase64(bbData.pixCopiaECola);

  const pixCharge = await storage.createPixCharge({
    txid: bbData.txid || txid,
    chargeType: 'com_vencimento',
    status: 'ATIVA',
    amount: params.amount.toFixed(2),
    pixKey: account.pixKey!,
    pixCopiaECola: bbData.pixCopiaECola,
    qrCodeBase64,
    location: bbData.location,
    dueDate: new Date(params.dueDate),
    debtorName: params.debtorName,
    debtorDocument: params.debtorDocument,
    description: params.description || null,
    financialAccountId: accountId,
    receivableId: params.receivableId || null,
    customerId: params.customerId || null,
    omieInstanceId: account.omieInstanceId || null,
    interResponse: JSON.stringify(bbData),
    createdBy: params.createdBy || null,
  });

  console.log(`✅ [BB-PIX] Cobrança com vencimento criada: ${pixCharge.txid}`);
  return pixCharge;
}

export async function checkChargeStatus(chargeId: string): Promise<PixCharge> {
  const charge = await storage.getPixCharge(chargeId);
  if (!charge) throw new Error('Cobrança PIX não encontrada');
  if (charge.status === 'CONCLUIDA') return charge;

  const account = await storage.getFinancialAccount(charge.financialAccountId);
  if (!account) throw new Error('Conta financeira não encontrada');

  const token = await getAccessToken(account);
  const client = createApiClient(account);

  const endpoint = charge.chargeType === 'com_vencimento'
    ? `/cobv/${charge.txid}`
    : `/cob/${charge.txid}`;

  const response = await client.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const bbData = response.data;
  const updates: any = {
    status: bbData.status,
    interResponse: JSON.stringify(bbData),
  };

  if (bbData.status === 'CONCLUIDA' && bbData.pix && bbData.pix.length > 0) {
    const payment = bbData.pix[0];
    updates.amountPaid = payment.valor;
    updates.endToEndId = payment.endToEndId;
    updates.paidAt = new Date(payment.horario);

    await processPixPayment(charge, account, payment);
  }

  const updated = await storage.updatePixCharge(charge.id, updates);
  return updated;
}

async function processPixPayment(
  charge: PixCharge,
  account: FinancialAccount,
  payment: BBPixPayment
): Promise<void> {
  const paidAmount = parseFloat(payment.valor);
  console.log(`💰 [BB-PIX] Pagamento recebido: R$ ${paidAmount.toFixed(2)} txid=${charge.txid} e2e=${payment.endToEndId}`);

  const currentBalance = parseFloat(account.balance || '0');
  const newBalance = currentBalance + paidAmount;

  await storage.updateFinancialAccount(account.id, {
    balance: newBalance.toFixed(2),
  } as any);

  await storage.createAccountMovement({
    financialAccountId: account.id,
    type: 'credito',
    amount: paidAmount.toFixed(2),
    balanceAfter: newBalance.toFixed(2),
    description: `PIX recebido BB - ${charge.debtorName || 'N/A'} - ${charge.description || charge.txid}`,
    sourceType: 'pix_charge',
    sourceId: charge.id,
    reference: payment.endToEndId,
    omieInstanceId: account.omieInstanceId || null,
    createdBy: 'sistema',
  });

  if (charge.receivableId) {
    const receivable = await storage.getReceivable(charge.receivableId);
    if (receivable) {
      const totalPaid = parseFloat(receivable.amountPaid || '0') + paidAmount;
      const totalAmount = parseFloat(receivable.amount);
      const newStatus = totalPaid >= totalAmount ? 'recebida' : 'a_vencer';

      await storage.updateReceivable(charge.receivableId, {
        amountPaid: totalPaid.toFixed(2),
        status: newStatus as any,
        paymentMethod: 'pix',
        financialAccountId: account.id,
      });

      await storage.createReceivablePayment({
        receivableId: charge.receivableId,
        paidAt: new Date(payment.horario),
        amount: paidAmount.toFixed(2),
        paymentMethod: 'pix',
        financialAccountId: account.id,
        reference: payment.endToEndId,
        notes: `Pagamento PIX BB automático - txid: ${charge.txid}`,
        createdBy: 'sistema',
      });

      console.log(`✅ [BB-PIX] Baixa automática: receivable ${charge.receivableId} - R$ ${paidAmount.toFixed(2)}`);
    }
  }
}

export async function configureWebhook(accountId: string, webhookUrl: string): Promise<void> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira não encontrada');
  if (!account.pixKey) throw new Error('Chave PIX não configurada');

  const token = await getAccessToken(account);
  const client = createApiClient(account);

  await client.put(`/webhook/${account.pixKey}`, {
    webhookUrl,
  }, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await storage.updateFinancialAccount(accountId, {
    bbWebhookConfigured: true,
  } as any);

  console.log(`✅ [BB-PIX] Webhook configurado: ${webhookUrl}`);
}

export async function handleWebhookNotification(payload: BBWebhookPayload): Promise<void> {
  if (!payload.pix || !Array.isArray(payload.pix)) return;

  for (const payment of payload.pix) {
    try {
      const charge = await storage.getPixChargeByTxid(payment.txid);
      if (!charge) {
        console.warn(`⚠️ [BB-PIX] Webhook: txid não encontrado: ${payment.txid}`);
        continue;
      }

      if (charge.status === 'CONCLUIDA') {
        console.log(`ℹ️ [BB-PIX] Webhook: cobrança já concluída: ${payment.txid}`);
        continue;
      }

      const account = await storage.getFinancialAccount(charge.financialAccountId);
      if (!account) continue;

      await storage.updatePixCharge(charge.id, {
        status: 'CONCLUIDA',
        amountPaid: payment.valor,
        endToEndId: payment.endToEndId,
        paidAt: new Date(payment.horario),
      });

      await processPixPayment(charge, account, payment);

      console.log(`✅ [BB-PIX] Webhook processado: txid=${payment.txid}`);
    } catch (error: any) {
      console.error(`❌ [BB-PIX] Erro processando webhook para txid=${payment.txid}:`, error.message);
    }
  }
}

export async function pollActiveCharges(): Promise<void> {
  const activeCharges = await storage.getPixCharges({ status: 'ATIVA' });

  for (const charge of activeCharges) {
    try {
      if (charge.expiresAt && new Date(charge.expiresAt) < new Date()) {
        await storage.updatePixCharge(charge.id, { status: 'EXPIRADA' });
        continue;
      }

      await checkChargeStatus(charge.id);
    } catch (error: any) {
      console.warn(`⚠️ [BB-PIX] Erro ao verificar cobrança ${charge.txid}:`, error.message);
    }
  }
}

export async function testConnection(accountId: string): Promise<{ success: boolean; message: string }> {
  try {
    const account = await storage.getFinancialAccount(accountId);
    if (!account) return { success: false, message: 'Conta não encontrada' };

    const token = await getAccessToken(account);
    if (!token) return { success: false, message: 'Falha na autenticação' };

    return { success: true, message: `Conexão com Banco do Brasil estabelecida com sucesso! (${IS_SANDBOX ? 'Sandbox' : 'Produção'})` };
  } catch (error: any) {
    return { success: false, message: `Erro: ${error.message}` };
  }
}

export async function listReceivedPix(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira não encontrada');

  const token = await getAccessToken(account);
  const client = createApiClient(account);

  const response = await client.get('/pix', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      inicio: startDate,
      fim: endDate,
    },
  });

  return response.data.pix || [];
}
