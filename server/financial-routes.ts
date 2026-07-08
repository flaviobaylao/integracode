import { Express } from 'express';
import { storage } from './storage';
import { authenticateUser } from './authMiddleware';
import { nowBrazil } from './brazilTimezone';
import * as bbPixService from './bb-pix-service';

function isFinancialAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Leitura financeira ampliada: além de admin/coord/administrativo, permite
// vendedor e telemarketing VISUALIZAREM (somente GET; escrita segue restrita).
function isFinancialReadAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Normaliza o body de contas (edição): datas string -> Date; valores "1.234,56" -> "1234.56"
function normalizeFinancialBody(body: any): any {
  const out: any = { ...body };
  const dateFields = ['dueDate', 'issueDate', 'paidDate', 'paidAt', 'emissionDate', 'expectedSettlementDate'];
  for (const k of dateFields) {
    if (out[k] === '' || out[k] === null) { out[k] = null; }
    else if (typeof out[k] === 'string') { const d = new Date(out[k]); if (!isNaN(d.getTime())) out[k] = d; }
  }
  const numFields = ['amount', 'amountPaid', 'interestTotal', 'discountTotal'];
  for (const k of numFields) {
    if (typeof out[k] === 'string' && out[k].includes(',')) out[k] = out[k].replace(/\./g, '').replace(',', '.');
  }
  return out;
}

function addMonthsUTC(base: Date, n: number): Date {
  const r = new Date(base.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, dim));
  return r;
}

function buildRecurrenceDates(base: Date, rec: any): Date[] {
  const interval = Math.max(1, parseInt(rec.interval) || 1);
  const MAX = 120;
  const step = (i: number): Date => {
    if (rec.freq === 'daily') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * i); return d; }
    if (rec.freq === 'weekly') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * 7 * i); return d; }
    if (rec.freq === 'monthly') return addMonthsUTC(base, interval * i);
    if (rec.freq === 'yearly') return addMonthsUTC(base, interval * 12 * i);
    return new Date(base.getTime());
  };
  const dates: Date[] = [];
  if (rec.endType === 'date' && rec.until) {
    const until = new Date(rec.until);
    for (let i = 0; i < MAX; i++) { const d = step(i); if (d.getTime() > until.getTime()) break; dates.push(d); }
  } else {
    const count = Math.min(MAX, Math.max(1, parseInt(rec.count) || 1));
    for (let i = 0; i < count; i++) dates.push(step(i));
  }
  if (dates.length === 0) dates.push(new Date(base.getTime()));
  return dates;
}

export function registerFinancialRoutes(app: Express) {

  // ============================================================================
  // CHART OF ACCOUNTS
  // ============================================================================

  app.get('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getChartOfAccounts(instanceId);
      res.json(accounts);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getChartOfAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta não encontrada' });
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.createChartOfAccount(req.body);
      res.status(201).json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.updateChartOfAccount(req.params.id, req.body);
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteChartOfAccount(req.params.id);
      res.json({ message: 'Conta removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts/seed', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const existing = await storage.getChartOfAccounts();
      if (existing.length > 0) {
        return res.status(400).json({ message: 'Plano de contas já possui registros. Limpe antes de popular novamente.' });
      }

      const dreAccounts = [
        { code: '1', name: 'Receita Bruta de Vendas', type: 'receita' as const, dreGroup: 'receita_bruta' },
        { code: '1.01', name: 'Devoluções/Descontos', type: 'receita' as const, dreGroup: 'devolucoes' },
        { code: '1.02', name: 'Impostos sobre Vendas (ICMS, PIS/COFINS, ISS)', type: 'receita' as const, dreGroup: 'impostos_vendas' },

        { code: '2', name: 'CPV', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.01', name: 'Matéria-prima (frutas/polpas)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.02', name: 'Embalagens (garrafas/tampas/rótulos)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.03', name: 'Energia e utilidades de produção', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.04', name: 'Mão de obra direta', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.05', name: 'Manutenção/limpeza fabril', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.06', name: 'Fretes de entrada', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.07', name: 'Análise produto', type: 'despesa' as const, dreGroup: 'cpv' },

        { code: '3', name: 'Despesas Comerciais', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.01', name: 'Comissões', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.02', name: 'Marketing', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.03', name: 'Salários logística', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.04', name: 'Locação veículo', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.05', name: 'Energia e utilidades de armazenamento', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.06', name: 'Manutenções (refrigeradores, veículos, máquinas)', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.07', name: 'Combustível, gelo, IPVA, manutenção', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.08', name: 'Representantes', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },

        { code: '4', name: 'Despesas Administrativas', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.01', name: 'Salários ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.02', name: 'Serviços contábeis', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.03', name: 'TI (ERP, internet)', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.04', name: 'Energia ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.05', name: 'Água/esgoto', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.06', name: 'Aluguel', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.07', name: 'Limpeza', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.08', name: 'Telefone', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.09', name: 'Material escritório', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },

        { code: '5', name: 'Despesas Gerais', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.01', name: 'Seguros', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.02', name: 'Taxas', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.03', name: 'Taxas bancárias', type: 'despesa' as const, dreGroup: 'despesas_gerais' },

        { code: '6', name: 'Outras Receitas/Despesas Operacionais', type: 'despesa' as const, dreGroup: 'outras_receitas_despesas' },

        { code: '7', name: 'Depreciação e Amortização', type: 'despesa' as const, dreGroup: 'depreciacao' },

        { code: '8', name: 'Receitas Financeiras', type: 'receita' as const, dreGroup: 'receitas_financeiras' },

        { code: '9', name: 'Despesas Financeiras (juros, tarifas)', type: 'despesa' as const, dreGroup: 'despesas_financeiras' },

        { code: '10', name: 'IRPJ/CSLL', type: 'despesa' as const, dreGroup: 'irpj_csll' },
      ];

      const created = [];
      for (const acc of dreAccounts) {
        const result = await storage.createChartOfAccount({
          code: acc.code,
          name: acc.name,
          type: acc.type,
          dreGroup: acc.dreGroup,
          isActive: true,
        });
        created.push(result);
      }

      res.json({ message: `${created.length} contas criadas com sucesso`, count: created.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // FINANCIAL ACCOUNTS (bank/cash)
  // ============================================================================

  const maskAccountSecrets = (account: any) => {
    if (!account) return account;
    const masked = { ...account };
    if (masked.interClientSecret) masked.interClientSecret = '***';
    if (masked.interCertificateCrt) masked.interCertificateCrt = '[CERTIFICADO CONFIGURADO]';
    if (masked.interCertificateKey) masked.interCertificateKey = '[CHAVE CONFIGURADA]';
    if (masked.bbClientSecret) masked.bbClientSecret = '***';
    if (masked.bbDevAppKey) masked.bbDevAppKey = masked.bbDevAppKey.substring(0, 6) + '***';
    if (masked.bbPixClientSecret) masked.bbPixClientSecret = '***';
    if (masked.bbPagamentosClientSecret) masked.bbPagamentosClientSecret = '***';
    if (masked.bbExtratoClientSecret) masked.bbExtratoClientSecret = '***';
    return masked;
  };

  app.get('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getFinancialAccounts(instanceId);
      res.json(accounts.map(maskAccountSecrets));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getFinancialAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta financeira não encontrada' });
      res.json(maskAccountSecrets(account));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  const cleanAccountData = (data: any) => {
    const cleaned = { ...data };
    const decimalFields = ['balance', 'bbJurosPercentual', 'bbMultaPercentual'];
    for (const field of decimalFields) {
      if (cleaned[field] === '' || cleaned[field] === null || cleaned[field] === undefined) {
        cleaned[field] = field === 'balance' ? '0' : null;
      } else if (typeof cleaned[field] === 'string') {
        cleaned[field] = cleaned[field].replace(',', '.');
      }
    }
    const nullableStringFields = ['bankName', 'bankCode', 'agency', 'accountNumber', 'pixKey',
      'omieInstanceId', 'description', 'accountSubtype',
      'bbClientId', 'bbClientSecret', 'bbDevAppKey', 'bbConvenio', 'bbContrato',
      'bbCarteira', 'bbVariacaoCarteira', 'bbDiasCompensacao', 'bbSenhaBoletos',
      'bbInstrucaoLinha1', 'bbInstrucaoLinha2', 'bbInstrucaoLinha3', 'bbInstrucaoLinha4',
      'bbPixClientId', 'bbPixClientSecret',
      'bbPagamentosClientId', 'bbPagamentosClientSecret',
      'bbExtratoClientId', 'bbExtratoClientSecret',
      'interClientId', 'interClientSecret', 'interCertificateCrt', 'interCertificateKey'];
    for (const field of nullableStringFields) {
      if (cleaned[field] === '') cleaned[field] = null;
    }
    return cleaned;
  };

  app.post('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.createFinancialAccount(cleanAccountData(req.body));
      res.status(201).json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.updateFinancialAccount(req.params.id, cleanAccountData(req.body));
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteFinancialAccount(req.params.id);
      res.json({ message: 'Conta financeira removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/test-bb-pix', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const result = await bbPixService.testConnection(req.params.id);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ============================================================================
  // ACCOUNT MOVEMENTS (immutable history - read only)
  // ============================================================================

  app.get('/api/financial/accounts/:id/movements', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string);
      const movements = await storage.getAccountMovements(req.params.id, filters);
      res.json(movements);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PIX CHARGES (Cobranças PIX)
  // ============================================================================

  app.get('/api/financial/pix-charges', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.financialAccountId) filters.financialAccountId = req.query.financialAccountId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.receivableId) filters.receivableId = req.query.receivableId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      const charges = await storage.getPixCharges(filters);
      res.json(charges);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/pix-charges/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await storage.getPixCharge(req.params.id);
      if (!charge) return res.status(404).json({ message: 'Cobrança PIX não encontrada' });
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/immediate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const { accountId, amount, debtorName, debtorDocument, description, expirationSeconds, receivableId, customerId } = req.body;
      
      if (!accountId || !amount) {
        return res.status(400).json({ message: 'accountId e amount são obrigatórios' });
      }

      const charge = await bbPixService.createImmediateCharge(accountId, {
        amount: parseFloat(amount),
        debtorName,
        debtorDocument,
        description,
        expirationSeconds: expirationSeconds ? parseInt(expirationSeconds) : undefined,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança imediata:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/due-date', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const { accountId, amount, dueDate, validityAfterDue, debtorName, debtorDocument, description, receivableId, customerId } = req.body;
      
      if (!accountId || !amount || !dueDate || !debtorName || !debtorDocument) {
        return res.status(400).json({ message: 'accountId, amount, dueDate, debtorName e debtorDocument são obrigatórios' });
      }

      const charge = await bbPixService.createDueDateCharge(accountId, {
        amount: parseFloat(amount),
        dueDate,
        validityAfterDue: validityAfterDue ? parseInt(validityAfterDue) : undefined,
        debtorName,
        debtorDocument,
        description,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança com vencimento:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/:id/check-status', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await bbPixService.checkChargeStatus(req.params.id);
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-webhook', async (req, res) => {
    try {
      await bbPixService.handleWebhookNotification(req.body);
      res.status(200).json({ message: 'OK' });
    } catch (error: any) {
      console.error('❌ [PIX-WEBHOOK] Erro:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/configure-webhook', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { webhookUrl } = req.body;
      if (!webhookUrl) return res.status(400).json({ message: 'webhookUrl é obrigatório' });
      await bbPixService.configureWebhook(req.params.id, webhookUrl);
      res.json({ message: 'Webhook configurado com sucesso' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // RECEIVABLES (Contas a Receber)
  // ============================================================================

  app.get('/api/financial/receivables', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.customerId) filters.customerId = req.query.customerId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.paymentMethod) filters.paymentMethod = req.query.paymentMethod;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const receivables = await storage.getReceivables(filters);
      res.json(receivables);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.getReceivable(req.params.id);
      if (!receivable) return res.status(404).json({ message: 'Conta a receber não encontrada' });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      const receivable = await storage.createReceivable(data);
      res.status(201).json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.updateReceivable(req.params.id, normalizeFinancialBody(req.body));
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteReceivable(req.params.id);
      res.json({ message: 'Conta a receber removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Receivable Payments
  app.get('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getReceivablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const data = { ...req.body, receivableId: req.params.id, createdBy: user?.email || null };
      const payment = await storage.createReceivablePayment(data);
      
      const receivable = await storage.getReceivable(req.params.id);
      if (receivable) {
        const totalPaid = parseFloat(receivable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(receivable.amount);
        const newStatus = totalPaid >= totalAmount ? 'recebida' : 'a_vencer';
        await storage.updateReceivable(req.params.id, { 
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });
      }
      
      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PAYABLES (Contas a Pagar)
  // ============================================================================

  app.get('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.supplierDocument) filters.supplierDocument = req.query.supplierDocument;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.source) filters.source = req.query.source;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const payables = await storage.getPayables(filters);
      res.json(payables);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.getPayable(req.params.id);
      if (!payable) return res.status(404).json({ message: 'Conta a pagar não encontrada' });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      const rec = req.body.recurrence;
      if (rec && rec.freq && rec.freq !== 'none') {
        const base = data.dueDate instanceof Date ? data.dueDate : (data.dueDate ? new Date(data.dueDate) : new Date());
        const dates = buildRecurrenceDates(base, rec);
        const items: any[] = [];
        for (const d of dates) { items.push(await storage.createPayable({ ...data, dueDate: d })); }
        return res.status(201).json({ recurring: true, count: items.length, items });
      }
      const payable = await storage.createPayable(data);
      res.status(201).json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.updatePayable(req.params.id, normalizeFinancialBody(req.body));
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deletePayable(req.params.id);
      res.json({ message: 'Conta a pagar removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Payable Payments
  app.get('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getPayablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const data = { ...req.body, payableId: req.params.id, createdBy: user?.email || null };
      const payment = await storage.createPayablePayment(data);

      const payable = await storage.getPayable(req.params.id);
      if (payable) {
        const totalPaid = parseFloat(payable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(payable.amount);
        const newStatus = totalPaid >= totalAmount ? 'paga' : 'a_vencer';
        await storage.updatePayable(req.params.id, {
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });
      }

      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // DRE (Income Statement) - Monthly Breakdown
  // ============================================================================

  app.get('/api/financial/dre', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      const receivables = await storage.getReceivables({ instanceId, startDate, endDate });
      const payables = await storage.getPayables({ instanceId, startDate, endDate });
      const chartAccounts = await storage.getChartOfAccounts(instanceId);

      const accountMap = new Map(chartAccounts.map(a => [a.id, a]));

      const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

      const getMonthIndex = (dateVal: any): number => {
        const d = new Date(dateVal);
        return d.getMonth();
      };

      const buildAccountMonthly = (accountId: string, items: any[], amountField: string = 'amount'): number[] => {
        const monthly = new Array(12).fill(0);
        for (const item of items) {
          if (item.chartAccountId === accountId) {
            const m = getMonthIndex(item.issueDate);
            if (m >= 0 && m < 12) {
              monthly[m] += parseFloat(item[amountField] || '0');
            }
          }
        }
        return monthly;
      }

      const dreGroups = [
        'receita_bruta', 'devolucoes', 'impostos_vendas',
        'cpv',
        'despesas_comerciais', 'despesas_administrativas', 'despesas_gerais',
        'outras_receitas_despesas', 'depreciacao',
        'receitas_financeiras', 'despesas_financeiras',
        'irpj_csll',
      ];

      const lines: any[] = [];

      for (const group of dreGroups) {
        const groupAccounts = chartAccounts.filter(a => a.dreGroup === group).sort((a, b) => a.code.localeCompare(b.code));
        if (groupAccounts.length === 0) continue;

        const isGroupHeader = groupAccounts.find(a => !a.code.includes('.'));
        const childAccounts = groupAccounts.filter(a => a.code.includes('.'));

        for (const acc of childAccounts) {
          let monthly: number[];
          if (acc.type === 'receita') {
            monthly = buildAccountMonthly(acc.id, receivables);
          } else {
            monthly = buildAccountMonthly(acc.id, payables);
          }
          const total = monthly.reduce((s, v) => s + v, 0);
          lines.push({
            code: acc.code,
            name: acc.name,
            dreGroup: group,
            type: acc.type,
            isHeader: false,
            monthly,
            total,
            accountId: acc.id,
          });
        }
      }

      const unclassifiedRecMonthly = new Array(12).fill(0);
      for (const r of receivables) {
        if (!r.chartAccountId || !accountMap.has(r.chartAccountId)) {
          const m = getMonthIndex(r.issueDate);
          if (m >= 0 && m < 12) unclassifiedRecMonthly[m] += parseFloat(r.amount || '0');
        }
      }
      const unclassifiedRecTotal = unclassifiedRecMonthly.reduce((s, v) => s + v, 0);

      const unclassifiedPayMonthly = new Array(12).fill(0);
      for (const p of payables) {
        if (!p.chartAccountId || !accountMap.has(p.chartAccountId)) {
          const m = getMonthIndex(p.issueDate);
          if (m >= 0 && m < 12) unclassifiedPayMonthly[m] += parseFloat(p.amount || '0');
        }
      }
      const unclassifiedPayTotal = unclassifiedPayMonthly.reduce((s, v) => s + v, 0);

      const sumGroupMonthly = (group: string): number[] => {
        const monthly = new Array(12).fill(0);
        for (const line of lines) {
          if (line.dreGroup === group) {
            for (let i = 0; i < 12; i++) monthly[i] += line.monthly[i];
          }
        }
        return monthly;
      }

      const receitaBruta = sumGroupMonthly('receita_bruta');
      const devolucoes = sumGroupMonthly('devolucoes');
      const impostos = sumGroupMonthly('impostos_vendas');
      const cpvTotal = sumGroupMonthly('cpv');
      const despCom = sumGroupMonthly('despesas_comerciais');
      const despAdm = sumGroupMonthly('despesas_administrativas');
      const despGer = sumGroupMonthly('despesas_gerais');
      const outrasRD = sumGroupMonthly('outras_receitas_despesas');
      const depreciacao = sumGroupMonthly('depreciacao');
      const recFin = sumGroupMonthly('receitas_financeiras');
      const despFin = sumGroupMonthly('despesas_financeiras');
      const irpj = sumGroupMonthly('irpj_csll');

      const receitaLiquida = receitaBruta.map((v, i) => v - devolucoes[i] - impostos[i]);
      const lucroBruto = receitaLiquida.map((v, i) => v - cpvTotal[i]);
      const despOpTotal = despCom.map((v, i) => v + despAdm[i] + despGer[i] + outrasRD[i]);
      const ebitdaCalc = lucroBruto.map((v, i) => v - despCom[i] - despAdm[i] - despGer[i] - outrasRD[i]);
      const ebitCalc = ebitdaCalc.map((v, i) => v - depreciacao[i]);
      const resultadoFinanceiro = recFin.map((v, i) => v - despFin[i]);
      const resultadoAntesIR = ebitCalc.map((v, i) => v - despFin[i] + recFin[i]);
      const lucroLiquido = resultadoAntesIR.map((v, i) => v - irpj[i]);

      const sumArr = (arr: number[]) => arr.reduce((s, v) => s + v, 0);

      const computed = {
        receitaBruta: { monthly: receitaBruta, total: sumArr(receitaBruta) },
        devolucoes: { monthly: devolucoes, total: sumArr(devolucoes) },
        impostos: { monthly: impostos, total: sumArr(impostos) },
        receitaLiquida: { monthly: receitaLiquida, total: sumArr(receitaLiquida) },
        cpvTotal: { monthly: cpvTotal, total: sumArr(cpvTotal) },
        lucroBruto: { monthly: lucroBruto, total: sumArr(lucroBruto) },
        despesasComerciais: { monthly: despCom, total: sumArr(despCom) },
        despesasAdministrativas: { monthly: despAdm, total: sumArr(despAdm) },
        despesasGerais: { monthly: despGer, total: sumArr(despGer) },
        outrasReceitasDespesas: { monthly: outrasRD, total: sumArr(outrasRD) },
        despesasOperacionaisTotal: { monthly: despOpTotal.map((v, i) => v + depreciacao[i]), total: sumArr(despOpTotal) + sumArr(depreciacao) },
        depreciacao: { monthly: depreciacao, total: sumArr(depreciacao) },
        ebitda: { monthly: ebitdaCalc, total: sumArr(ebitdaCalc) },
        ebit: { monthly: ebitCalc, total: sumArr(ebitCalc) },
        receitasFinanceiras: { monthly: recFin, total: sumArr(recFin) },
        despesasFinanceiras: { monthly: despFin, total: sumArr(despFin) },
        resultadoFinanceiro: { monthly: resultadoFinanceiro, total: sumArr(resultadoFinanceiro) },
        resultadoAntesIR: { monthly: resultadoAntesIR, total: sumArr(resultadoAntesIR) },
        irpjCsll: { monthly: irpj, total: sumArr(irpj) },
        lucroLiquido: { monthly: lucroLiquido, total: sumArr(lucroLiquido) },
        unclassifiedReceivables: { monthly: unclassifiedRecMonthly, total: unclassifiedRecTotal },
        unclassifiedPayables: { monthly: unclassifiedPayMonthly, total: unclassifiedPayTotal },
      };

      res.json({
        year,
        months,
        lines,
        computed,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // XML SEARCH (from fiscal_invoices)
  // ============================================================================

  app.get('/api/financial/xml-documents', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq, and, gte, lte, desc, isNotNull, or, like } = await import('drizzle-orm');
      
      const conditions: any[] = [];
      
      if (req.query.instanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, req.query.instanceId as string));
      }
      if (req.query.status) {
        conditions.push(eq(fiscalInvoices.status, req.query.status as string));
      }
      if (req.query.startDate) {
        conditions.push(gte(fiscalInvoices.emissionDate, new Date(req.query.startDate as string)));
      }
      if (req.query.endDate) {
        conditions.push(lte(fiscalInvoices.emissionDate, new Date(req.query.endDate as string)));
      }
      if (req.query.customerName) {
        conditions.push(like(fiscalInvoices.customerName, `%${req.query.customerName}%`));
      }
      if (req.query.accessKey) {
        conditions.push(eq(fiscalInvoices.accessKey, req.query.accessKey as string));
      }

      const hasXml = or(
        isNotNull(fiscalInvoices.xmlEnvio),
        isNotNull(fiscalInvoices.xmlRetorno),
        isNotNull(fiscalInvoices.xmlAutorizacao)
      );

      let query;
      if (conditions.length > 0) {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).where(and(...conditions)).orderBy(desc(fiscalInvoices.emissionDate));
      } else {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).orderBy(desc(fiscalInvoices.emissionDate));
      }

      const results = await query;
      
      const mapped = results.map(r => ({
        ...r,
        hasXmlEnvio: !!r.hasXmlEnvio,
        hasXmlRetorno: !!r.hasXmlRetorno,
        hasXmlAutorizacao: !!r.hasXmlAutorizacao,
      }));

      res.json(mapped);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/xml-documents/:id/download/:type', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');

      const [invoice] = await db.select().from(fiscalInvoices).where(eq(fiscalInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ message: 'NF-e não encontrada' });

      let xml: string | null = null;
      let filename = '';

      switch (req.params.type) {
        case 'envio':
          xml = invoice.xmlEnvio;
          filename = `nfe_envio_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'retorno':
          xml = invoice.xmlRetorno;
          filename = `nfe_retorno_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'autorizacao':
          xml = invoice.xmlAutorizacao;
          filename = `nfe_autorizacao_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        default:
          return res.status(400).json({ message: 'Tipo de XML inválido' });
      }

      if (!xml) return res.status(404).json({ message: 'XML não disponível' });

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(xml);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // SPED FISCAL
  // ============================================================================

  app.get('/api/financial/sped-exports', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const exports = await storage.getSpedExports(instanceId);
      res.json(exports);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/sped-exports/generate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = (req as any).user;
      const { type, periodStart, periodEnd, omieInstanceId } = req.body;

      if (!type || !periodStart || !periodEnd) {
        return res.status(400).json({ message: 'Tipo, período inicial e final são obrigatórios' });
      }

      const { db } = await import('./db');
      const { fiscalInvoices, fiscalInvoiceItems } = await import('@shared/schema');
      const { eq, and, gte, lte, desc } = await import('drizzle-orm');

      const conditions: any[] = [
        gte(fiscalInvoices.emissionDate, new Date(periodStart)),
        lte(fiscalInvoices.emissionDate, new Date(periodEnd)),
      ];
      if (omieInstanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, omieInstanceId));
      }

      const invoices = await db.select().from(fiscalInvoices)
        .where(and(...conditions))
        .orderBy(desc(fiscalInvoices.emissionDate));

      const allItems: any[] = [];
      for (const inv of invoices) {
        const items = await db.select().from(fiscalInvoiceItems)
          .where(eq(fiscalInvoiceItems.invoiceId, inv.id));
        allItems.push(...items.map(item => ({ ...item, invoice: inv })));
      }

      const receivablesList = await storage.getReceivables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      const payablesList = await storage.getPayables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      let content = '';

      if (type === 'SPED_FISCAL') {
        content = generateSpedFiscal(invoices, allItems, receivablesList, payablesList, periodStart, periodEnd, omieInstanceId);
      } else if (type === 'BLOCO_K') {
        content = generateBlocoK(invoices, allItems, periodStart, periodEnd);
      } else {
        return res.status(400).json({ message: 'Tipo inválido. Use SPED_FISCAL ou BLOCO_K' });
      }

      const fileName = `${type}_${omieInstanceId || 'ALL'}_${periodStart.substring(0,7)}.txt`;

      const spedExport = await storage.createSpedExport({
        type,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        omieInstanceId: omieInstanceId || null,
        fileName,
        fileContent: content,
        status: 'generated',
        createdBy: user?.email || null,
      });

      res.status(201).json(spedExport);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/sped-exports/:id/download', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const exports = await storage.getSpedExports();
      const spedExport = exports.find(e => e.id === req.params.id);
      if (!spedExport) return res.status(404).json({ message: 'Exportação não encontrada' });

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${spedExport.fileName}"`);
      res.send(spedExport.fileContent || '');
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

function formatDecimal(value: string | number | null, decimals = 2): string {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  return num.toFixed(decimals).replace('.', ',');
}

function generateSpedFiscal(
  invoices: any[], 
  items: any[], 
  receivables: any[],
  payables: any[],
  periodStart: string, 
  periodEnd: string,
  instanceId?: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}|||${instanceId || ''}||||A|1|`);
  lines.push(`|0001|0|`);
  lines.push(`|0005|||||||||`);
  lines.push(`|0100|||||||||||||||||`);

  const productMap = new Map<string, any>();
  items.forEach(item => {
    if (item.productCode && !productMap.has(item.productCode)) {
      productMap.set(item.productCode, item);
    }
  });

  let itemIdx = 0;
  productMap.forEach((item, code) => {
    lines.push(`|0200|${code}|${item.productName || ''}||${item.ncm || ''}||${item.unit || 'UN'}|0|0|||0|`);
    itemIdx++;
  });

  lines.push(`|0990|${lines.length + 1}|`);

  lines.push(`|C001|0|`);
  
  invoices.forEach((inv, idx) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    lines.push(`|C100|0|1|${inv.customerCnpjCpf || ''}|55|00|${inv.series || '1'}|${inv.invoiceNumber || ''}|${inv.accessKey || ''}|${formatDate(inv.emissionDate || new Date())}|${formatDate(inv.emissionDate || new Date())}|${formatDecimal(inv.totalProducts)}|0,00|0,00|${formatDecimal(inv.totalDiscount)}|0,00|0,00|0,00|${formatDecimal(inv.totalProducts)}|9|0,00|${formatDecimal(inv.totalIcms)}|0,00|0,00|${formatDecimal(inv.totalPis)}|${formatDecimal(inv.totalCofins)}|0,00|0,00|0,00|0,00|`);
    
    invItems.forEach((item, itemIdx) => {
      lines.push(`|C170|${itemIdx + 1}|${item.productCode || ''}|${item.productName || ''}|${formatDecimal(item.quantity)}|${item.unit || 'UN'}|${formatDecimal(item.unitPrice)}|${formatDecimal(item.totalPrice)}|0,00|0|${item.cfop || inv.cfop || ''}|0|0,00|0,00|0,00|0,00|0,00|${item.ncm || ''}|0,00|0,00|0,00|0,00|`);
    });

    lines.push(`|C190|${inv.cfop || ''}|0|${formatDecimal(inv.totalProducts)}|${formatDecimal(inv.totalIcms)}|0,00|0,00|0,00|0,00|0,00|0,00|`);
  });

  lines.push(`|C990|${lines.length + 1}|`);

  lines.push(`|E001|0|`);
  lines.push(`|E100|${formatDate(start)}|${formatDate(end)}|`);
  lines.push(`|E110|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|`);
  lines.push(`|E990|${lines.length + 1}|`);

  lines.push(`|H001|0|`);
  lines.push(`|H005|${formatDate(end)}|0,00|0|`);
  lines.push(`|H990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|0000|1|`);
  lines.push(`|9900|9999|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}

function generateBlocoK(
  invoices: any[], 
  items: any[],
  periodStart: string, 
  periodEnd: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}||||||||A|1|`);
  
  lines.push(`|K001|0|`);
  lines.push(`|K100|${formatDate(start)}|${formatDate(end)}|`);

  const productMap = new Map<string, { code: string; name: string; totalQty: number }>();
  items.forEach(item => {
    const code = item.productCode || '';
    if (code) {
      const existing = productMap.get(code);
      if (existing) {
        existing.totalQty += parseFloat(item.quantity || '0');
      } else {
        productMap.set(code, {
          code,
          name: item.productName || '',
          totalQty: parseFloat(item.quantity || '0'),
        });
      }
    }
  });

  productMap.forEach((prod) => {
    lines.push(`|K200|${formatDate(end)}|${prod.code}|${formatDecimal(prod.totalQty)}|0|0,00|`);
  });

  invoices.forEach((inv) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    if (invItems.length > 0) {
      lines.push(`|K230|${formatDate(inv.emissionDate || new Date())}|${invItems[0]?.productCode || ''}|${formatDecimal(invItems.reduce((sum: number, i: any) => sum + parseFloat(i.quantity || '0'), 0))}|`);
    }
  });

  lines.push(`|K990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|K001|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}
