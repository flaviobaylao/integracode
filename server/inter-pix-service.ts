import https from 'https';
import axios, { AxiosInstance } from 'axios';
import QRCode from 'qrcode';
import { storage } from './storage';
import type { FinancialAccount, PixCharge } from '@shared/schema';

const INTER_BASE_URL = 'https://cdpj.partners.bancointer.com.br';
const INTER_OAUTH_URL = `${INTER_BASE_URL}/oauth/v2/token`;

interface InterTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface InterCobResponse {
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

interface InterCobVResponse extends InterCobResponse {
  calendario: {
    criacao: string;
    expiracao: number;
    dataDeVencimento: string;
    validadeAposVencimento: number;
  };
}

interface InterPixPayment {
  endToEndId: string;
  txid: string;
  valor: string;
  horario: string;
  infoPagador?: string;
  componentesValor?: {
    original: { valor: string };
  };
}

interface InterWebhookPayload {
  pix: InterPixPayment[];
}

const tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

function createHttpsAgent(certCrt: string, certKey: string): https.Agent {
  return new https.Agent({
    cert: certCrt,
    key: certKey,
    rejectUnauthorized: true,
  });
}

function createApiClient(account: FinancialAccount): AxiosInstance {
  if (!account.interCertificateCrt || !account.interCertificateKey) {
    throw new Error('Certificado Inter não configurado para esta conta');
  }

  const agent = createHttpsAgent(account.interCertificateCrt, account.interCertificateKey);
  
  return axios.create({
    baseURL: INTER_BASE_URL,
    httpsAgent: agent,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function getAccessToken(account: FinancialAccount): Promise<string> {
  const cacheKey = account.id;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  if (!account.interClientId || !account.interClientSecret) {
    throw new Error('Client ID e Client Secret do Inter não configurados');
  }

  const client = createApiClient(account);
  
  const params = new URLSearchParams({
    client_id: account.interClientId,
    client_secret: account.interClientSecret,
    scope: 'cob.write cob.read cobv.write cobv.read pix.read pix.write webhook.read webhook.write',
    grant_type: 'client_credentials',
  });

  const response = await client.post<InterTokenResponse>(INTER_OAUTH_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const { access_token, expires_in } = response.data;
  
  tokenCache.set(cacheKey, {
    token: access_token,
    expiresAt: Date.now() + (expires_in * 1000),
  });

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
    console.error('❌ [INTER-PIX] Erro ao gerar QR Code:', error);
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
  if (!account.interPixEnabled) throw new Error('PIX Inter não habilitado para esta conta');
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

  console.log(`📱 [INTER-PIX] Criando cobrança imediata: R$ ${params.amount.toFixed(2)} txid=${txid}`);

  const response = await client.put<InterCobResponse>(`/pix/v2/cob/${txid}`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const interData = response.data;
  const qrCodeBase64 = await generateQrCodeBase64(interData.pixCopiaECola);

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + (params.expirationSeconds || 3600));

  const pixCharge = await storage.createPixCharge({
    txid: interData.txid || txid,
    chargeType: 'imediata',
    status: 'ATIVA',
    amount: params.amount.toFixed(2),
    pixKey: account.pixKey!,
    pixCopiaECola: interData.pixCopiaECola,
    qrCodeBase64,
    location: interData.location,
    expiresAt,
    debtorName: params.debtorName || null,
    debtorDocument: params.debtorDocument || null,
    description: params.description || null,
    financialAccountId: accountId,
    receivableId: params.receivableId || null,
    customerId: params.customerId || null,
    omieInstanceId: account.omieInstanceId || null,
    interResponse: JSON.stringify(interData),
    createdBy: params.createdBy || null,
  });

  console.log(`✅ [INTER-PIX] Cobrança criada: ${pixCharge.txid}`);
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
  if (!account.interPixEnabled) throw new Error('PIX Inter não habilitado para esta conta');
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

  console.log(`📱 [INTER-PIX] Criando cobrança com vencimento: R$ ${params.amount.toFixed(2)} txid=${txid} venc=${params.dueDate}`);

  const response = await client.put<InterCobVResponse>(`/pix/v2/cobv/${txid}`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const interData = response.data;
  const qrCodeBase64 = await generateQrCodeBase64(interData.pixCopiaECola);

  const pixCharge = await storage.createPixCharge({
    txid: interData.txid || txid,
    chargeType: 'com_vencimento',
    status: 'ATIVA',
    amount: params.amount.toFixed(2),
    pixKey: account.pixKey!,
    pixCopiaECola: interData.pixCopiaECola,
    qrCodeBase64,
    location: interData.location,
    dueDate: new Date(params.dueDate),
    debtorName: params.debtorName,
    debtorDocument: params.debtorDocument,
    description: params.description || null,
    financialAccountId: accountId,
    receivableId: params.receivableId || null,
    customerId: params.customerId || null,
    omieInstanceId: account.omieInstanceId || null,
    interResponse: JSON.stringify(interData),
    createdBy: params.createdBy || null,
  });

  console.log(`✅ [INTER-PIX] Cobrança com vencimento criada: ${pixCharge.txid}`);
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
    ? `/pix/v2/cobv/${charge.txid}`
    : `/pix/v2/cob/${charge.txid}`;

  const response = await client.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const interData = response.data;
  const updates: any = {
    status: interData.status,
    interResponse: JSON.stringify(interData),
  };

  if (interData.status === 'CONCLUIDA' && interData.pix && interData.pix.length > 0) {
    const payment = interData.pix[0];
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
  payment: InterPixPayment
): Promise<void> {
  const paidAmount = parseFloat(payment.valor);
  console.log(`💰 [INTER-PIX] Pagamento recebido: R$ ${paidAmount.toFixed(2)} txid=${charge.txid} e2e=${payment.endToEndId}`);

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
    description: `PIX recebido - ${charge.debtorName || 'N/A'} - ${charge.description || charge.txid}`,
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
        notes: `Pagamento PIX automático - txid: ${charge.txid}`,
        createdBy: 'sistema',
      });

      console.log(`✅ [INTER-PIX] Baixa automática: receivable ${charge.receivableId} - R$ ${paidAmount.toFixed(2)}`);
    }
  }
}

export async function configureWebhook(accountId: string, webhookUrl: string): Promise<void> {
  const account = await storage.getFinancialAccount(accountId);
  if (!account) throw new Error('Conta financeira não encontrada');
  if (!account.pixKey) throw new Error('Chave PIX não configurada');

  const token = await getAccessToken(account);
  const client = createApiClient(account);

  await client.put(`/pix/v2/webhook/${account.pixKey}`, {
    webhookUrl,
  }, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await storage.updateFinancialAccount(accountId, {
    interWebhookConfigured: true,
  } as any);

  console.log(`✅ [INTER-PIX] Webhook configurado: ${webhookUrl}`);
}

export async function handleWebhookNotification(payload: InterWebhookPayload): Promise<void> {
  if (!payload.pix || !Array.isArray(payload.pix)) return;

  for (const payment of payload.pix) {
    try {
      const charge = await storage.getPixChargeByTxid(payment.txid);
      if (!charge) {
        console.warn(`⚠️ [INTER-PIX] Webhook: txid não encontrado: ${payment.txid}`);
        continue;
      }

      if (charge.status === 'CONCLUIDA') {
        console.log(`ℹ️ [INTER-PIX] Webhook: cobrança já concluída: ${payment.txid}`);
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
      
      console.log(`✅ [INTER-PIX] Webhook processado: txid=${payment.txid}`);
    } catch (error: any) {
      console.error(`❌ [INTER-PIX] Erro processando webhook para txid=${payment.txid}:`, error.message);
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
      console.warn(`⚠️ [INTER-PIX] Erro ao verificar cobrança ${charge.txid}:`, error.message);
    }
  }
}

export async function testConnection(accountId: string): Promise<{ success: boolean; message: string }> {
  try {
    const account = await storage.getFinancialAccount(accountId);
    if (!account) return { success: false, message: 'Conta não encontrada' };

    const token = await getAccessToken(account);
    if (!token) return { success: false, message: 'Falha na autenticação' };

    return { success: true, message: 'Conexão com Banco Inter estabelecida com sucesso!' };
  } catch (error: any) {
    return { success: false, message: `Erro: ${error.message}` };
  }
}
