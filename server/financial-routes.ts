import { Express } from 'express';
import { storage } from './storage';
import { authenticateUser } from './authMiddleware';
import { nowBrazil } from './brazilTimezone';

function isFinancialAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
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

  // ============================================================================
  // FINANCIAL ACCOUNTS (bank/cash)
  // ============================================================================

  app.get('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getFinancialAccounts(instanceId);
      res.json(accounts);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getFinancialAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta financeira não encontrada' });
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.createFinancialAccount(req.body);
      res.status(201).json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.updateFinancialAccount(req.params.id, req.body);
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

  // ============================================================================
  // RECEIVABLES (Contas a Receber)
  // ============================================================================

  app.get('/api/financial/receivables', authenticateUser, isFinancialAuthorized, async (req, res) => {
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
      const data = { ...req.body, createdBy: user?.email || null };
      const receivable = await storage.createReceivable(data);
      res.status(201).json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.updateReceivable(req.params.id, req.body);
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
      const data = { ...req.body, createdBy: user?.email || null };
      const payable = await storage.createPayable(data);
      res.status(201).json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.updatePayable(req.params.id, req.body);
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
  // DRE (Income Statement)
  // ============================================================================

  app.get('/api/financial/dre', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const receivables = await storage.getReceivables({ 
        instanceId, 
        startDate, 
        endDate 
      });
      const payables = await storage.getPayables({ 
        instanceId, 
        startDate, 
        endDate 
      });
      const chartAccounts = await storage.getChartOfAccounts(instanceId);

      const revenueAccounts = chartAccounts.filter(a => a.type === 'receita');
      const expenseAccounts = chartAccounts.filter(a => a.type === 'despesa');

      const revenueByAccount = revenueAccounts.map(account => {
        const items = receivables.filter(r => r.chartAccountId === account.id);
        const total = items.reduce((sum, r) => sum + parseFloat(r.amount), 0);
        const received = items.reduce((sum, r) => sum + parseFloat(r.amountPaid || '0'), 0);
        return {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          total,
          received,
          count: items.length,
        };
      });

      const expenseByAccount = expenseAccounts.map(account => {
        const items = payables.filter(p => p.chartAccountId === account.id);
        const total = items.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const paid = items.reduce((sum, p) => sum + parseFloat(p.amountPaid || '0'), 0);
        return {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          total,
          paid,
          count: items.length,
        };
      });

      const totalRevenue = revenueByAccount.reduce((sum, a) => sum + a.total, 0);
      const totalExpenses = expenseByAccount.reduce((sum, a) => sum + a.total, 0);
      const totalReceived = revenueByAccount.reduce((sum, a) => sum + a.received, 0);
      const totalPaid = expenseByAccount.reduce((sum, a) => sum + a.paid, 0);

      const unclassifiedRevenue = receivables
        .filter(r => !r.chartAccountId)
        .reduce((sum, r) => sum + parseFloat(r.amount), 0);
      const unclassifiedExpenses = payables
        .filter(p => !p.chartAccountId)
        .reduce((sum, p) => sum + parseFloat(p.amount), 0);

      res.json({
        revenue: revenueByAccount,
        expenses: expenseByAccount,
        summary: {
          totalRevenue: totalRevenue + unclassifiedRevenue,
          totalExpenses: totalExpenses + unclassifiedExpenses,
          netResult: (totalRevenue + unclassifiedRevenue) - (totalExpenses + unclassifiedExpenses),
          totalReceived,
          totalPaid,
          unclassifiedRevenue,
          unclassifiedExpenses,
        }
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
