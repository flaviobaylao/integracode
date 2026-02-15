import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { sefazService } from "./sefaz-service";
import { nowBrazil } from "./brazilTimezone";
import crypto from "crypto";
import { z } from "zod";
import { insertFiscalScenarioSchema, insertFiscalInvoiceSchema, insertFiscalInvoiceItemSchema, insertDigitalCertificateSchema } from "@shared/schema";

const createInvoiceSchema = z.object({
  customerName: z.string().min(1, "Nome do cliente obrigatório"),
  customerCnpjCpf: z.string().optional(),
  customerIe: z.string().optional(),
  customerAddress: z.string().optional(),
  fiscalScenarioId: z.string().optional(),
  cfop: z.string().optional(),
  natureOfOperation: z.string().optional(),
  paymentMethod: z.string().optional(),
  environment: z.enum(["homologacao", "producao"]).default("homologacao"),
  notes: z.string().optional(),
  series: z.string().optional(),
  operationType: z.string().optional(),
  totalProducts: z.string().optional(),
  totalDiscount: z.string().optional(),
  totalFreight: z.string().optional(),
  totalInsurance: z.string().optional(),
  totalOtherExpenses: z.string().optional(),
  totalInvoice: z.string().optional(),
  items: z.array(z.object({
    productName: z.string().min(1, "Nome do produto obrigatório"),
    productCode: z.string().optional(),
    productId: z.string().optional(),
    ncm: z.string().optional(),
    cfop: z.string().optional(),
    unit: z.string().default("UN"),
    quantity: z.string().or(z.number()),
    unitPrice: z.string().or(z.number()),
    totalPrice: z.string().or(z.number()),
    discount: z.string().or(z.number()).optional(),
    cstIcms: z.string().optional(),
    cstPis: z.string().optional(),
    cstCofins: z.string().optional(),
  })).optional(),
});

const createCertificateSchema = z.object({
  companyName: z.string().min(1, "Nome da empresa obrigatório"),
  cnpj: z.string().min(14, "CNPJ obrigatório"),
  serialNumber: z.string().optional(),
  issuer: z.string().optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  certificateType: z.string().default("A1"),
});

const cancelInvoiceSchema = z.object({
  justification: z.string().min(15, "Justificativa deve ter pelo menos 15 caracteres"),
});

export function registerNfeRoutes(app: Express) {

  // ============================================================================
  // FISCAL SCENARIOS
  // ============================================================================

  app.get('/api/fiscal-scenarios', authenticateUser, async (req: any, res) => {
    try {
      const scenarios = await storage.getFiscalScenarios();
      res.json(scenarios);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar cenários fiscais', error: error.message });
    }
  });

  app.post('/api/fiscal-scenarios', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = insertFiscalScenarioSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const scenario = await storage.createFiscalScenario(parsed.data);
      res.status(201).json(scenario);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao criar cenário fiscal', error: error.message });
    }
  });

  app.put('/api/fiscal-scenarios/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = insertFiscalScenarioSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const scenario = await storage.updateFiscalScenario(req.params.id, parsed.data);
      res.json(scenario);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao atualizar cenário fiscal', error: error.message });
    }
  });

  app.delete('/api/fiscal-scenarios/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      await storage.deleteFiscalScenario(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao deletar cenário fiscal', error: error.message });
    }
  });

  // ============================================================================
  // DIGITAL CERTIFICATES
  // ============================================================================

  app.get('/api/digital-certificates', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const certs = await storage.getDigitalCertificates();
      const safeCerts = certs.map(c => ({
        ...c,
        storageKey: '***',
      }));
      res.json(safeCerts);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar certificados', error: error.message });
    }
  });

  app.post('/api/digital-certificates', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = createCertificateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const { companyName, cnpj, serialNumber, issuer, validFrom, validUntil, certificateType } = parsed.data;

      const storageKey = `certificates/${crypto.randomUUID()}.pfx`;

      const cert = await storage.createDigitalCertificate({
        companyName,
        cnpj,
        serialNumber: serialNumber || null,
        issuer: issuer || null,
        validFrom: validFrom ? new Date(validFrom) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
        certificateType: certificateType || 'A1',
        storageKey,
        isActive: true,
        uploadedBy: req.user?.id || null,
      });

      res.status(201).json({ ...cert, storageKey: '***' });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao cadastrar certificado', error: error.message });
    }
  });

  app.put('/api/digital-certificates/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = createCertificateSchema.partial().extend({
        isActive: z.boolean().optional(),
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const { companyName, cnpj, serialNumber, issuer, validFrom, validUntil, certificateType, isActive } = parsed.data;
      const updateData: any = {};
      if (companyName !== undefined) updateData.companyName = companyName;
      if (cnpj !== undefined) updateData.cnpj = cnpj;
      if (serialNumber !== undefined) updateData.serialNumber = serialNumber;
      if (issuer !== undefined) updateData.issuer = issuer;
      if (validFrom !== undefined) updateData.validFrom = validFrom ? new Date(validFrom) : null;
      if (validUntil !== undefined) updateData.validUntil = validUntil ? new Date(validUntil) : null;
      if (certificateType !== undefined) updateData.certificateType = certificateType;
      if (isActive !== undefined) updateData.isActive = isActive;

      const cert = await storage.updateDigitalCertificate(req.params.id, updateData);
      res.json({ ...cert, storageKey: '***' });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao atualizar certificado', error: error.message });
    }
  });

  app.delete('/api/digital-certificates/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      await storage.deleteDigitalCertificate(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao deletar certificado', error: error.message });
    }
  });

  // ============================================================================
  // FISCAL INVOICES (NF-e)
  // ============================================================================

  app.get('/api/fiscal-invoices', authenticateUser, async (req: any, res) => {
    try {
      const { status, customerId, environment } = req.query;
      const invoices = await storage.getFiscalInvoices({
        status: status as string,
        customerId: customerId as string,
        environment: environment as string,
      });
      res.json(invoices);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar notas fiscais', error: error.message });
    }
  });

  app.get('/api/fiscal-invoices/:id', authenticateUser, async (req: any, res) => {
    try {
      const invoice = await storage.getFiscalInvoice(req.params.id);
      if (!invoice) return res.status(404).json({ message: 'Nota fiscal não encontrada' });

      const items = await storage.getFiscalInvoiceItems(req.params.id);
      const events = await storage.getFiscalInvoiceEvents(req.params.id);

      res.json({ ...invoice, items, events });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar nota fiscal', error: error.message });
    }
  });

  app.post('/api/fiscal-invoices', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const parsed = createInvoiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }

      const { items, ...invoiceFields } = parsed.data;
      const nextNumber = await storage.getNextInvoiceNumber(invoiceFields.series || '1');
      
      const invoice = await storage.createFiscalInvoice({
        ...invoiceFields,
        invoiceNumber: nextNumber,
        status: 'draft',
        createdBy: req.user?.id || null,
      });

      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          await storage.createFiscalInvoiceItem({
            ...items[i],
            invoiceId: invoice.id,
            itemNumber: i + 1,
            quantity: items[i].quantity.toString(),
            unitPrice: items[i].unitPrice.toString(),
            totalPrice: items[i].totalPrice.toString(),
            discount: items[i].discount?.toString() || '0',
          });
        }
      }

      await storage.createFiscalInvoiceEvent({
        invoiceId: invoice.id,
        eventType: 'criacao',
        status: 'success',
        description: `NF-e #${invoice.invoiceNumber} criada em modo ${invoice.environment}`,
        createdBy: req.user?.id || null,
      });

      const savedItems = await storage.getFiscalInvoiceItems(invoice.id);
      res.status(201).json({ ...invoice, items: savedItems });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao criar nota fiscal', error: error.message });
    }
  });

  app.put('/api/fiscal-invoices/:id', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const existing = await storage.getFiscalInvoice(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Nota fiscal não encontrada' });
      if (existing.status !== 'draft' && existing.status !== 'rejected') {
        return res.status(400).json({ message: `NF-e com status '${existing.status}' não pode ser editada` });
      }

      const { items, ...invoiceData } = req.body;
      const invoice = await storage.updateFiscalInvoice(req.params.id, invoiceData);

      if (items && Array.isArray(items)) {
        await storage.deleteFiscalInvoiceItems(req.params.id);
        for (let i = 0; i < items.length; i++) {
          await storage.createFiscalInvoiceItem({
            ...items[i],
            invoiceId: invoice.id,
            itemNumber: i + 1,
          });
        }
      }

      const updatedItems = await storage.getFiscalInvoiceItems(invoice.id);
      res.json({ ...invoice, items: updatedItems });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao atualizar nota fiscal', error: error.message });
    }
  });

  app.delete('/api/fiscal-invoices/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const existing = await storage.getFiscalInvoice(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Nota fiscal não encontrada' });
      if (existing.status === 'authorized') {
        return res.status(400).json({ message: 'NF-e autorizada não pode ser excluída. Use cancelamento.' });
      }

      await storage.deleteFiscalInvoice(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao deletar nota fiscal', error: error.message });
    }
  });

  // ============================================================================
  // SEFAZ OPERATIONS
  // ============================================================================

  app.post('/api/fiscal-invoices/:id/emit', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const result = await sefazService.emitNfe(req.params.id);

      if (result.success) {
        const invoice = await storage.getFiscalInvoice(req.params.id);
        const items = await storage.getFiscalInvoiceItems(req.params.id);
        const events = await storage.getFiscalInvoiceEvents(req.params.id);
        res.json({ ...result, invoice: { ...invoice, items, events } });
      } else {
        res.status(400).json(result);
      }
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  app.post('/api/fiscal-invoices/:id/cancel', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const parsed = cancelInvoiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const { justification } = parsed.data;

      const result = await sefazService.cancelNfe(req.params.id, justification);

      if (result.success) {
        const invoice = await storage.getFiscalInvoice(req.params.id);
        const events = await storage.getFiscalInvoiceEvents(req.params.id);
        res.json({ ...result, invoice: { ...invoice, events } });
      } else {
        res.status(400).json(result);
      }
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  app.get('/api/sefaz/status', authenticateUser, async (req: any, res) => {
    try {
      const { uf, environment } = req.query;
      const result = await sefazService.checkServiceStatus(
        (uf as string) || 'GO',
        (environment as 'homologacao' | 'producao') || 'homologacao'
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  app.post('/api/sefaz/consult', authenticateUser, async (req: any, res) => {
    try {
      const parsed = z.object({ accessKey: z.string().length(44, "Chave de acesso deve ter 44 dígitos") }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const result = await sefazService.consultNfe(parsed.data.accessKey);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  // ============================================================================
  // FISCAL INVOICE ITEMS
  // ============================================================================

  app.get('/api/fiscal-invoices/:invoiceId/items', authenticateUser, async (req: any, res) => {
    try {
      const items = await storage.getFiscalInvoiceItems(req.params.invoiceId);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar itens', error: error.message });
    }
  });

  app.post('/api/fiscal-invoices/:invoiceId/items', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const existingItems = await storage.getFiscalInvoiceItems(req.params.invoiceId);
      const nextItemNumber = existingItems.length + 1;

      const item = await storage.createFiscalInvoiceItem({
        ...req.body,
        invoiceId: req.params.invoiceId,
        itemNumber: req.body.itemNumber || nextItemNumber,
      });

      const allItems = await storage.getFiscalInvoiceItems(req.params.invoiceId);
      const totalProducts = allItems.reduce((sum, i) => sum + parseFloat(i.totalPrice?.toString() || '0'), 0);
      const totalDiscount = allItems.reduce((sum, i) => sum + parseFloat(i.discount?.toString() || '0'), 0);
      await storage.updateFiscalInvoice(req.params.invoiceId, {
        totalProducts: totalProducts.toFixed(2),
        totalInvoice: (totalProducts - totalDiscount).toFixed(2),
      });

      res.status(201).json(item);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao adicionar item', error: error.message });
    }
  });

  app.delete('/api/fiscal-invoice-items/:id', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      await storage.deleteFiscalInvoiceItem(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao deletar item', error: error.message });
    }
  });

  // ============================================================================
  // FISCAL INVOICE EVENTS (HISTORY)
  // ============================================================================

  app.get('/api/fiscal-invoices/:invoiceId/events', authenticateUser, async (req: any, res) => {
    try {
      const events = await storage.getFiscalInvoiceEvents(req.params.invoiceId);
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar eventos', error: error.message });
    }
  });

  // ============================================================================
  // FISCAL BACKUPS
  // ============================================================================

  app.get('/api/fiscal-backups', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { backupType, referenceId } = req.query;
      const backups = await storage.getFiscalBackups({
        backupType: backupType as string,
        referenceId: referenceId as string,
      });
      res.json(backups);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar backups', error: error.message });
    }
  });

  app.post('/api/fiscal-backups/create', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { invoiceId } = req.body;
      const invoice = await storage.getFiscalInvoice(invoiceId);
      if (!invoice) return res.status(404).json({ message: 'Nota fiscal não encontrada' });

      const items = await storage.getFiscalInvoiceItems(invoiceId);
      const events = await storage.getFiscalInvoiceEvents(invoiceId);

      const backupData = JSON.stringify({ invoice, items, events });
      const checksum = crypto.createHash('sha256').update(backupData).digest('hex');
      const storageKey = `fiscal-backups/${invoiceId}/${Date.now()}.json`;

      const backup = await storage.createFiscalBackup({
        backupType: 'invoice',
        referenceId: invoiceId,
        referenceKey: invoice.accessKey || `NF-${invoice.invoiceNumber}`,
        storageKey,
        fileSize: Buffer.byteLength(backupData, 'utf8'),
        checksum,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          environment: invoice.environment,
          itemCount: items.length,
          totalInvoice: invoice.totalInvoice,
        },
      });

      res.status(201).json(backup);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao criar backup', error: error.message });
    }
  });

  // ============================================================================
  // DASHBOARD/STATS
  // ============================================================================

  app.get('/api/fiscal-dashboard', authenticateUser, async (req: any, res) => {
    try {
      const invoices = await storage.getFiscalInvoices();
      const scenarios = await storage.getFiscalScenarios();
      const certificates = await storage.getDigitalCertificates();

      const stats = {
        totalInvoices: invoices.length,
        byStatus: {
          draft: invoices.filter(i => i.status === 'draft').length,
          authorized: invoices.filter(i => i.status === 'authorized').length,
          cancelled: invoices.filter(i => i.status === 'cancelled').length,
          rejected: invoices.filter(i => i.status === 'rejected').length,
        },
        totalValue: invoices
          .filter(i => i.status === 'authorized')
          .reduce((sum, i) => sum + parseFloat(i.totalInvoice?.toString() || '0'), 0),
        totalScenarios: scenarios.length,
        activeCertificates: certificates.filter(c => c.isActive).length,
        environment: invoices.length > 0 ? invoices[0].environment : 'homologacao',
      };

      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar dashboard fiscal', error: error.message });
    }
  });
}
