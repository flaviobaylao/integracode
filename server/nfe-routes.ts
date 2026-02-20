import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { sefazService } from "./sefaz-service";
import { nowBrazil } from "./brazilTimezone";
import crypto from "crypto";
import { z } from "zod";
import { insertFiscalScenarioSchema, insertFiscalInvoiceSchema, insertFiscalInvoiceItemSchema, insertDigitalCertificateSchema } from "@shared/schema";
import multer from "multer";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { objectStorageClient } from "./replit_integrations/object_storage/objectStorage";

const CERT_ENCRYPTION_KEY = crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'cert-key-fallback').digest();

export interface CompanyData {
  name: string;
  cnpj: string;
  ie: string;
  address: string;
  city: string;
  cityCode: string;
  uf: string;
  cep: string;
  phone: string;
  crt: string;
}

export const INSTANCE_COMPANY_DATA: Record<string, CompanyData> = {
  'BSB': {
    name: 'PURO INDÚSTRIA E COMÉRCIO LTDA - BSB',
    cnpj: '26.975.835/0002-80',
    ie: '07.668.149/001-08',
    address: 'SIA Trecho 5A, Lote 180/200, Sala 2 - SIA, Brasília/DF',
    city: 'Brasília',
    cityCode: '5300108',
    uf: 'DF',
    cep: '71200-055',
    phone: '(61) 3333-5050',
    crt: '3',
  },
  'GYN': {
    name: 'PURO INDÚSTRIA E COMÉRCIO LTDA',
    cnpj: '26.975.835/0001-09',
    ie: '10.451.466-0',
    address: 'Rua 10, Qd. 34, Lt. 14 - Setor Boa Vista, Senador Canedo/GO',
    city: 'Senador Canedo',
    cityCode: '5220454',
    uf: 'GO',
    cep: '75250-810',
    phone: '(62) 3093-5050',
    crt: '3',
  },
  'IND': {
    name: 'PURO INDÚSTRIA E COMÉRCIO LTDA - INDÚSTRIA',
    cnpj: '26.975.835/0003-61',
    ie: '10.451.466-0',
    address: 'Rua 10, Qd. 34, Lt. 14 - Setor Boa Vista, Senador Canedo/GO',
    city: 'Senador Canedo',
    cityCode: '5220454',
    uf: 'GO',
    cep: '75250-810',
    phone: '(62) 3093-5050',
    crt: '3',
  },
  'SERV': {
    name: 'PURO SERVIÇOS LTDA',
    cnpj: '26.975.835/0004-42',
    ie: 'ISENTO',
    address: 'Rua 10, Qd. 34, Lt. 14 - Setor Boa Vista, Senador Canedo/GO',
    city: 'Senador Canedo',
    cityCode: '5220454',
    uf: 'GO',
    cep: '75250-810',
    phone: '(62) 3093-5050',
    crt: '3',
  },
};

function encryptPassword(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CERT_ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptPassword(encrypted: string): string {
  const [ivHex, encHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', CERT_ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function stripSensitiveFields(cert: any) {
  const { storageKey, certificatePassword, ...safe } = cert;
  return safe;
}

const pfxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.pfx') || ext.endsWith('.p12')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos .pfx ou .p12 são permitidos'));
    }
  },
});

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
  // COMPANY DATA PER INSTANCE
  // ============================================================================

  app.get('/api/nfe/company-data', authenticateUser, async (req: any, res) => {
    try {
      const instances = await storage.getOmieInstances();
      const result = instances
        .filter(inst => inst.isActive && INSTANCE_COMPANY_DATA[inst.name])
        .map(inst => {
          const companyData = INSTANCE_COMPANY_DATA[inst.name];
          return {
            instanceId: inst.id,
            instanceName: inst.name,
            displayName: inst.displayName,
            tagColor: inst.tagColor,
            ...companyData,
          };
        });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar dados das empresas', error: error.message });
    }
  });

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
      const safeCerts = certs.map(c => stripSensitiveFields(c));
      res.json(safeCerts);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar certificados', error: error.message });
    }
  });

  app.post('/api/digital-certificates', authenticateUser, requireRole(['admin']), pfxUpload.single('pfxFile'), async (req: any, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ message: 'Arquivo PFX/P12 é obrigatório' });
      }

      const password = req.body.password;
      const passHex = password ? Buffer.from(password).toString('hex') : 'empty';
      console.log(`[CERT-UPLOAD] File received: ${file.originalname}, size: ${file.size} bytes, password provided: ${!!password}, password length: ${password?.length || 0}, passHex: ${passHex}`);
      if (!password) {
        return res.status(400).json({ message: 'Senha do certificado é obrigatória' });
      }

      let certInfo: { companyName: string; cnpj: string; serialNumber: string; issuer: string; validFrom: Date; validUntil: Date };
      const tmpFile = path.join(os.tmpdir(), `cert_${crypto.randomUUID()}.pfx`);
      try {
        fs.writeFileSync(tmpFile, file.buffer);

        const passFile = path.join(os.tmpdir(), `pass_${crypto.randomUUID()}.txt`);
        fs.writeFileSync(passFile, password, { mode: 0o600 });

        const tryOpenSSL = (cmd: string): { success: boolean; output: string; error: string } => {
          try {
            const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
            return { success: true, output, error: '' };
          } catch (e: any) {
            const errOutput = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
            return { success: false, output: '', error: errOutput };
          }
        };

        console.log(`[CERT-UPLOAD] Attempting OpenSSL pkcs12 extraction...`);

        const escapedPass = password.replace(/'/g, "'\\''");

        const attempts = [
          { label: 'legacy+file', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin file:"${passFile}" -legacy 2>&1` },
          { label: 'legacy+pass', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin 'pass:${escapedPass}' -legacy 2>&1` },
          { label: 'nolegacy+file', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin file:"${passFile}" 2>&1` },
          { label: 'nolegacy+pass', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin 'pass:${escapedPass}' 2>&1` },
          { label: 'legacy+nodes+file', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin file:"${passFile}" -legacy -nodes 2>&1` },
          { label: 'legacy+nomacver', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin file:"${passFile}" -legacy -nomacver 2>&1` },
          { label: 'nolegacy+nomacver', cmd: `openssl pkcs12 -in "${tmpFile}" -clcerts -nokeys -passin file:"${passFile}" -nomacver 2>&1` },
        ];

        let certText = '';
        let successLabel = '';

        for (const attempt of attempts) {
          const result = tryOpenSSL(attempt.cmd);
          console.log(`[CERT-UPLOAD] ${attempt.label}: success=${result.success}, hasCert=${result.output.includes('BEGIN CERTIFICATE')}, error=${result.error.substring(0, 150)}`);
          if (result.success && result.output.includes('BEGIN CERTIFICATE')) {
            certText = result.output;
            successLabel = attempt.label;
            console.log(`[CERT-UPLOAD] SUCCESS with ${attempt.label}`);
            break;
          }
          if (!result.success && result.output.includes('BEGIN CERTIFICATE')) {
            certText = result.output;
            successLabel = attempt.label;
            console.log(`[CERT-UPLOAD] SUCCESS (non-zero exit but got cert) with ${attempt.label}`);
            break;
          }
        }

        if (!certText || !certText.includes('BEGIN CERTIFICATE')) {
          try { fs.unlinkSync(passFile); } catch {}
          try { fs.unlinkSync(tmpFile); } catch {}
          console.error(`[CERT-UPLOAD] All ${attempts.length} attempts failed`);
          return res.status(400).json({ message: 'Não foi possível ler o certificado. Verifique se o arquivo PFX/P12 e a senha estão corretos.' });
        }

        let certDetails = '';
        const pemMatch = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (pemMatch) {
          const pemFile = path.join(os.tmpdir(), `pem_${crypto.randomUUID()}.pem`);
          fs.writeFileSync(pemFile, pemMatch[0]);
          const pemResult = tryOpenSSL(`openssl x509 -in "${pemFile}" -noout -subject -issuer -serial -dates 2>&1`);
          if (pemResult.success) {
            certDetails = pemResult.output;
          }
          try { fs.unlinkSync(pemFile); } catch {}
        }
        try { fs.unlinkSync(passFile); } catch {}

        const subjectMatch = certDetails.match(/subject\s*=\s*(.*)/i);
        const subjectLine = subjectMatch ? subjectMatch[1] : '';

        const cnMatch = subjectLine.match(/CN\s*=\s*([^,/\n]+)/i);
        const companyName = cnMatch ? cnMatch[1].trim() : 'Desconhecido';

        let cnpj = '';
        const cnpjMatch = certDetails.match(/\d{14}/);
        if (cnpjMatch) cnpj = cnpjMatch[0];
        if (!cnpj) {
          const subjectCnpjMatch = subjectLine.match(/\d{14}/);
          if (subjectCnpjMatch) cnpj = subjectCnpjMatch[0];
        }

        const issuerMatch = certDetails.match(/issuer\s*=\s*(.*)/i);
        const issuerLine = issuerMatch ? issuerMatch[1] : '';
        const issuerCnMatch = issuerLine.match(/CN\s*=\s*([^,/\n]+)/i);
        const issuer = issuerCnMatch ? issuerCnMatch[1].trim() : '';

        const serialMatch = certDetails.match(/serial\s*=\s*([0-9A-Fa-f]+)/i);
        const serialNumber = serialMatch ? serialMatch[1] : '';

        const notBeforeMatch = certDetails.match(/notBefore\s*=\s*(.*)/i);
        const notAfterMatch = certDetails.match(/notAfter\s*=\s*(.*)/i);
        const validFrom = notBeforeMatch ? new Date(notBeforeMatch[1].trim()) : new Date();
        const validUntil = notAfterMatch ? new Date(notAfterMatch[1].trim()) : new Date();

        certInfo = {
          companyName,
          cnpj: cnpj || req.body.cnpj || '',
          serialNumber,
          issuer,
          validFrom,
          validUntil,
        };
      } catch (parseError: any) {
        return res.status(400).json({ message: 'Erro ao ler o certificado PFX: ' + parseError.message });
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }

      const privateDir = process.env.PRIVATE_OBJECT_DIR;
      if (!privateDir) {
        return res.status(500).json({ message: 'Object storage não configurado' });
      }

      const storageKey = `${privateDir}/certificates/${crypto.randomUUID()}.pfx`;
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      if (!bucketId) {
        return res.status(500).json({ message: 'Bucket de armazenamento não configurado' });
      }

      const bucket = objectStorageClient.bucket(bucketId);
      const gcsFile = bucket.file(storageKey);
      await gcsFile.save(file.buffer, { contentType: 'application/x-pkcs12' });

      const cert = await storage.createDigitalCertificate({
        companyName: certInfo.companyName,
        cnpj: certInfo.cnpj,
        serialNumber: certInfo.serialNumber || null,
        issuer: certInfo.issuer || null,
        validFrom: certInfo.validFrom,
        validUntil: certInfo.validUntil,
        certificateType: 'A1',
        storageKey,
        certificatePassword: encryptPassword(password),
        isActive: true,
        uploadedBy: req.user?.id || null,
      });

      res.status(201).json(stripSensitiveFields(cert));
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
      res.json(stripSensitiveFields(cert));
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

        // Consume stock for each item in the invoice
        try {
          const { consumeStock } = await import('./inventory-routes.js');
          const userId = req.user?.id || req.userId || null;
          for (const item of items) {
            if (item.productId) {
              const product = await storage.getProduct(item.productId);
              const instanceId = product?.omieInstanceId || 'default';
              await consumeStock(
                item.productId,
                instanceId,
                parseFloat(item.quantity),
                'invoice',
                req.params.id,
                userId,
              );
            }
          }
        } catch (stockErr: any) {
          console.warn('⚠️ Erro ao consumir estoque após emissão NF-e:', stockErr.message);
        }

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
        const items = await storage.getFiscalInvoiceItems(req.params.id);
        const events = await storage.getFiscalInvoiceEvents(req.params.id);

        // Reverse stock consumption for cancelled invoice
        try {
          const { reverseStockConsumption } = await import('./inventory-routes.js');
          const userId = req.user?.id || req.userId || null;
          for (const item of items) {
            if (item.productId) {
              const product = await storage.getProduct(item.productId);
              const instanceId = product?.omieInstanceId || 'default';
              await reverseStockConsumption(
                item.productId,
                instanceId,
                parseFloat(item.quantity),
                'invoice',
                req.params.id,
                userId,
              );
            }
          }
        } catch (stockErr: any) {
          console.warn('⚠️ Erro ao reverter estoque após cancelamento NF-e:', stockErr.message);
        }

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
