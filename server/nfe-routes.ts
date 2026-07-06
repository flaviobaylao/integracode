import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { sefazService } from "./sefaz-service";
import { nowBrazil } from "./brazilTimezone";
import crypto from "crypto";
import { z } from "zod";
import { db } from "./db";
import { sql } from "drizzle-orm";
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
    name: 'PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA',
    cnpj: '28.295.493/0003-15',
    ie: '0846917100165',
    address: 'SHCS CR 516, BLOCO B 69 PAVMTO1',
    city: 'Brasília',
    cityCode: '5300108',
    uf: 'DF',
    cep: '70381525',
    phone: '(62) 96353860',
    crt: '1',
  },
  'GYN': {
    name: 'PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA',
    cnpj: '28.295.493/0002-34',
    ie: '10.778.700-8',
    address: 'AVENIDA T 63, nº 4446, QUADRA 03 LOTE 71 SALA 1 E GALPAO, ANHANGUERA',
    city: 'Goiânia',
    cityCode: '5208707',
    uf: 'GO',
    cep: '74.335-102',
    phone: '(62) 3093-5050',
    crt: '1',
  },
  'IND': {
    name: 'PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA',
    cnpj: '28.295.493/0001-53',
    ie: '10.709.937-3',
    address: 'RODOVIA BELA VISTA DE GOIAS - CRISTIANOPOLIS - KM 08, FAZENDA GRAMADO, nº SN, ZONA RURAL',
    city: 'Bela Vista de Goiás',
    cityCode: '5203302',
    uf: 'GO',
    cep: '75.240-000',
    phone: '(62) 3093-5050',
    crt: '1',
  },
  'SERV': {
    name: 'PURO SERVICOS E CONSULTORIA EMPRESARIAL LTDA',
    cnpj: '52.921.727/0001-05',
    ie: '20.167.506-4',
    address: 'AVENIDA T 63, nº 4446, QUADRA 03 LOTE 71 SALA 1A, ANHANGUERA',
    city: 'Goiânia',
    cityCode: '5208707',
    uf: 'GO',
    cep: '74.335-102',
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
  customerBairro: z.string().optional(),
  customerCep: z.string().optional(),
  customerCity: z.string().optional(),
  customerUf: z.string().optional(),
  customerPhone: z.string().optional(),
  fiscalScenarioId: z.string().optional(),
  cfop: z.string().optional(),
  natureOfOperation: z.string().optional(),
  paymentMethod: z.string().optional(),
  environment: z.enum(["homologacao", "producao"]).default("homologacao"),
  notes: z.string().optional(),
  series: z.string().optional(),
  operationType: z.string().optional(),
  omieInstanceId: z.string().optional(),
  issuerName: z.string().optional(),
  issuerCnpj: z.string().optional(),
  issuerIe: z.string().optional(),
  issuerAddress: z.string().optional(),
  issuerUf: z.string().optional(),
  issuerCityCode: z.string().optional(),
  issuerCity: z.string().optional(),
  issuerPhone: z.string().optional(),
  totalProducts: z.string().optional(),
  totalDiscount: z.string().optional(),
  totalFreight: z.string().optional(),
  totalInsurance: z.string().optional(),
  totalOtherExpenses: z.string().optional(),
  totalInvoice: z.string().optional(),
  totalIcms: z.string().optional(),
  totalPis: z.string().optional(),
  totalCofins: z.string().optional(),
  totalIpi: z.string().optional(),
  totalBaseIcms: z.string().optional(),
  totalBaseIcmsSt: z.string().optional(),
  totalIcmsSt: z.string().optional(),
  dueDate: z.string().optional(),
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
    csosn: z.string().optional(),
    cstIcms: z.string().optional(),
    baseIcms: z.string().or(z.number()).optional(),
    aliqIcms: z.string().or(z.number()).optional(),
    valorIcms: z.string().or(z.number()).optional(),
    aliqIpi: z.string().or(z.number()).optional(),
    cstPis: z.string().optional(),
    valorPis: z.string().or(z.number()).optional(),
    cstCofins: z.string().optional(),
    valorCofins: z.string().or(z.number()).optional(),
    valorIpi: z.string().or(z.number()).optional(),
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

  app.get('/api/nfe/company-data', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-scenarios', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const scenarios = await storage.getFiscalScenarios();
      res.json(scenarios);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar cenários fiscais', error: error.message });
    }
  });

  app.post('/api/fiscal-scenarios', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.put('/api/fiscal-scenarios/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.delete('/api/fiscal-scenarios/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/digital-certificates', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const certs = await storage.getDigitalCertificates();
      const safeCerts = certs.map(c => stripSensitiveFields(c));
      res.json(safeCerts);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar certificados', error: error.message });
    }
  });

  app.post('/api/digital-certificates', authenticateUser, requireRole(['admin', 'industria']), pfxUpload.single('pfxFile'), async (req: any, res) => {
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

      let storageKey: string | null = null;
    try {
      const privateDir = process.env.PRIVATE_OBJECT_DIR;
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      if (privateDir && bucketId && objectStorageClient) {
        storageKey = `${privateDir}/certificates/${crypto.randomUUID()}.pfx`;
        await objectStorageClient.bucket(bucketId).file(storageKey).save(file.buffer, { contentType: 'application/x-pkcs12' });
      }
    } catch (e: any) {
      console.warn('[CERT-UPLOAD] Object Storage indisponivel, usando pfx no banco:', e?.message);
      storageKey = null;
    }
    const pfxData = encryptPassword(file.buffer.toString('base64'));

      const cert = await storage.createDigitalCertificate({
        companyName: certInfo.companyName,
        cnpj: certInfo.cnpj,
        serialNumber: certInfo.serialNumber || null,
        issuer: certInfo.issuer || null,
        validFrom: certInfo.validFrom,
        validUntil: certInfo.validUntil,
        certificateType: 'A1',
        storageKey: storageKey || 'db',
        pfxData,
        certificatePassword: encryptPassword(password),
        isActive: true,
        uploadedBy: req.user?.id || null,
      });

      res.status(201).json(stripSensitiveFields(cert));
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao cadastrar certificado', error: error.message });
    }
  });

  app.put('/api/digital-certificates/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.delete('/api/digital-certificates/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-invoices', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/fiscal-invoices/batch', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const { invoiceNumbers } = req.body;
      if (!invoiceNumbers || !Array.isArray(invoiceNumbers) || invoiceNumbers.length === 0) {
        return res.status(400).json({ message: 'invoiceNumbers é obrigatório (array)' });
      }

      const allInvoices = await storage.getFiscalInvoices();
      const matched = allInvoices.filter(inv => {
        const num = inv.invoiceNumber?.toString();
        return invoiceNumbers.some((n: string) => {
          const clean = n.replace('NF-', '');
          return num === clean;
        });
      });

      const results = [];
      for (const inv of matched) {
        const items = await storage.getFiscalInvoiceItems(inv.id);
        results.push({ ...inv, items });
      }

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar notas fiscais em lote', error: error.message });
    }
  });

  app.get('/api/fiscal-invoices/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/fiscal-invoices', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const parsed = createInvoiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }

      const { items, ...invoiceFields } = parsed.data;

      if (invoiceFields.omieInstanceId && !invoiceFields.issuerName) {
        const instances = await storage.getOmieInstances();
        const inst = instances.find(i => i.id === invoiceFields.omieInstanceId);
        if (inst && INSTANCE_COMPANY_DATA[inst.name]) {
          const cd = INSTANCE_COMPANY_DATA[inst.name];
          invoiceFields.issuerName = cd.name;
          invoiceFields.issuerCnpj = cd.cnpj;
          invoiceFields.issuerIe = cd.ie;
          invoiceFields.issuerAddress = cd.address;
          invoiceFields.issuerUf = cd.uf;
          invoiceFields.issuerCityCode = cd.cityCode;
          invoiceFields.issuerCity = cd.city;
          invoiceFields.issuerPhone = cd.phone;
        }
      }

      // Auto-preenche IE do destinatario a partir do cadastro (contribuinte ICMS)
      if ((invoiceFields as any).customerId && !(invoiceFields as any).customerIe) {
        try {
          const __custIe = await storage.getCustomer((invoiceFields as any).customerId);
          if (__custIe && (__custIe as any).stateRegistration) {
            (invoiceFields as any).customerIe = String((__custIe as any).stateRegistration).trim();
          }
        } catch (e) {}
      }
      // Numeracao por CNPJ emitente + serie (cada CNPJ tem sequencia SEFAZ propria).
      const nextNumber = await storage.getNextInvoiceNumber(invoiceFields.series || '1', (invoiceFields as any).issuerCnpj);
      
      // Ambiente de emissao por instancia (system_settings: fiscal_env_<id>). Default homologacao ate cutover.
      try {
        const __instId = (invoiceFields as any).omieInstanceId || 'default';
        const __envRes: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${'fiscal_env_' + __instId}`);
        const __raw = (__envRes && __envRes.rows && __envRes.rows[0]) ? __envRes.rows[0].value : null;
        (invoiceFields as any).environment = (__raw === 'producao' || __raw === '"producao"') ? 'producao' : 'homologacao';
      } catch (e) {
        (invoiceFields as any).environment = 'homologacao';
      }

      const invoice = await storage.createFiscalInvoice({
        ...invoiceFields,
        invoiceNumber: nextNumber,
        status: 'draft',
        createdBy: req.user?.id || null,
      });

      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          await storage.createFiscalInvoiceItem({
            productName: item.productName,
            productCode: item.productCode,
            productId: item.productId,
            ncm: item.ncm,
            cfop: item.cfop,
            unit: item.unit,
            csosn: item.csosn,
            cstIcms: item.cstIcms,
            cstPis: item.cstPis,
            cstCofins: item.cstCofins,
            invoiceId: invoice.id,
            itemNumber: i + 1,
            quantity: item.quantity.toString(),
            unitPrice: item.unitPrice.toString(),
            totalPrice: item.totalPrice.toString(),
            discount: item.discount?.toString() || '0',
            baseIcms: item.baseIcms?.toString(),
            aliqIcms: item.aliqIcms?.toString(),
            valorIcms: item.valorIcms?.toString(),
            aliqIpi: item.aliqIpi?.toString(),
            valorPis: item.valorPis?.toString(),
            valorCofins: item.valorCofins?.toString(),
            valorIpi: item.valorIpi?.toString(),
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

  app.put('/api/fiscal-invoices/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.delete('/api/fiscal-invoices/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/fiscal-invoices/:id/emit', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/fiscal-invoices/:id/cancel', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const parsed = cancelInvoiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Dados inválidos', errors: parsed.error.flatten().fieldErrors });
      }
      const { justification } = parsed.data;

      const invoice = await storage.getFiscalInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ message: 'NF-e não encontrada' });
      }

      const authDate = invoice.authorizationDate || invoice.emissionDate || invoice.createdAt;
      if (authDate) {
        const hoursSinceAuth = (Date.now() - new Date(authDate).getTime()) / (1000 * 60 * 60);
        if (hoursSinceAuth > 24) {
          return res.status(400).json({
            message: 'Prazo de cancelamento expirado',
            details: 'O cancelamento de NF-e só é permitido até 24 horas após a emissão. Após este prazo, utilize a devolução com emissão de nota fiscal de devolução.',
            expired: true,
          });
        }
      }

      const result = await sefazService.cancelNfe(req.params.id, justification);

      if (result.success) {
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

        // Cancel associated receivables
        try {
          const allReceivables = await storage.getReceivables({});
          const linkedReceivables = allReceivables.filter(r => r.fiscalInvoiceId === req.params.id);
          for (const rec of linkedReceivables) {
            await storage.updateReceivable(rec.id, {
              status: 'cancelada',
              notes: `${rec.notes ? rec.notes + ' | ' : ''}Cancelada automaticamente - Cancelamento NF-e: ${justification}`,
            });
            console.log(`💰 [NF-e CANCEL] Conta a receber ${rec.id} cancelada (NF-e ${req.params.id})`);
          }
        } catch (recErr: any) {
          console.warn('⚠️ Erro ao cancelar contas a receber após cancelamento NF-e:', recErr.message);
        }

        const updatedInvoice = await storage.getFiscalInvoice(req.params.id);
        res.json({ ...result, invoice: { ...updatedInvoice, events }, receivablesCancelled: true });
      } else {
        res.status(400).json(result);
      }
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  // Return invoice (NF-e devolução) for invoices past 24h cancellation window
  app.post('/api/fiscal-invoices/:id/return', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const { justification } = req.body;
      if (!justification || justification.length < 15) {
        return res.status(400).json({ message: 'Justificativa deve ter pelo menos 15 caracteres' });
      }

      const originalInvoice = await storage.getFiscalInvoice(req.params.id);
      if (!originalInvoice) {
        return res.status(404).json({ message: 'NF-e original não encontrada' });
      }
      if (originalInvoice.status !== 'authorized') {
        return res.status(400).json({ message: 'Somente NF-e autorizadas podem ser devolvidas' });
      }

      const authDate = originalInvoice.authorizationDate || originalInvoice.emissionDate || originalInvoice.createdAt;
      if (authDate) {
        const hoursSinceAuth = (Date.now() - new Date(authDate).getTime()) / (1000 * 60 * 60);
        if (hoursSinceAuth <= 24) {
          return res.status(400).json({
            message: 'NF-e ainda dentro do prazo de cancelamento',
            details: 'Esta NF-e ainda está dentro do prazo de 24 horas. Utilize a opção de cancelamento ao invés de devolução.',
          });
        }
      }

      const originalItems = await storage.getFiscalInvoiceItems(req.params.id);
      const user = req.currentUser || req.user;

      const returnInvoice = await storage.createFiscalInvoice({
        series: originalInvoice.series || '1',
        operationType: 'entrada',
        fiscalScenarioId: originalInvoice.fiscalScenarioId,
        certificateId: originalInvoice.certificateId,
        issuerName: originalInvoice.issuerName,
        issuerCnpj: originalInvoice.issuerCnpj,
        issuerIe: originalInvoice.issuerIe,
        issuerAddress: originalInvoice.issuerAddress,
        issuerUf: originalInvoice.issuerUf,
        issuerCityCode: originalInvoice.issuerCityCode,
        issuerCity: originalInvoice.issuerCity,
        issuerPhone: originalInvoice.issuerPhone,
        customerId: originalInvoice.customerId,
        customerName: originalInvoice.customerName,
        customerCnpjCpf: originalInvoice.customerCnpjCpf,
        customerIe: originalInvoice.customerIe,
        customerAddress: originalInvoice.customerAddress,
        customerBairro: originalInvoice.customerBairro,
        customerCep: originalInvoice.customerCep,
        customerCity: originalInvoice.customerCity,
        customerUf: originalInvoice.customerUf,
        customerPhone: originalInvoice.customerPhone,
        natureOfOperation: 'DEVOLUÇAO DE VENDA',
        cfop: '1.202',
        totalProducts: originalInvoice.totalProducts,
        totalDiscount: originalInvoice.totalDiscount || '0',
        totalFreight: originalInvoice.totalFreight || '0',
        totalInsurance: originalInvoice.totalInsurance || '0',
        totalOtherExpenses: originalInvoice.totalOtherExpenses || '0',
        totalIcms: originalInvoice.totalIcms || '0',
        totalPis: originalInvoice.totalPis || '0',
        totalCofins: originalInvoice.totalCofins || '0',
        totalIpi: originalInvoice.totalIpi || '0',
        totalInvoice: originalInvoice.totalInvoice,
        paymentMethod: originalInvoice.paymentMethod || 'a_prazo',
        notes: `NF-e de DEVOLUÇÃO referente à NF-e nº ${originalInvoice.invoiceNumber || 'N/A'} (chave: ${originalInvoice.accessKey || 'N/A'}). Motivo: ${justification}`,
        environment: originalInvoice.environment || 'homologacao',
        omieInstanceId: originalInvoice.omieInstanceId,
        salesCardId: originalInvoice.salesCardId,
        referencedAccessKey: originalInvoice.accessKey || null,
        finNFe: '4',
        createdBy: user?.email || null,
        status: 'draft',
      });

      for (const item of originalItems) {
        await storage.createFiscalInvoiceItem({
          invoiceId: returnInvoice.id,
          itemNumber: item.itemNumber,
          productId: item.productId,
          productCode: item.productCode,
          productName: item.productName,
          ncm: item.ncm,
          cest: item.cest,
          cfop: '1202',
          unit: item.unit,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          discount: item.discount,
          csosn: item.csosn,
          cstIcms: item.cstIcms,
          baseIcms: item.baseIcms,
          aliqIcms: item.aliqIcms,
          valorIcms: item.valorIcms,
          cstPis: item.cstPis,
          basePis: item.basePis,
          aliqPis: item.aliqPis,
          valorPis: item.valorPis,
          cstCofins: item.cstCofins,
          baseCofins: item.baseCofins,
          aliqCofins: item.aliqCofins,
          valorCofins: item.valorCofins,
          cstIpi: item.cstIpi,
          baseIpi: item.baseIpi,
          aliqIpi: item.aliqIpi,
          valorIpi: item.valorIpi,
          lotNumber: item.lotNumber,
          lotId: item.lotId,
        });
      }

      await storage.createFiscalInvoiceEvent({
        invoiceId: returnInvoice.id,
        eventType: 'created',
        status: 'success',
        description: `NF-e de devolução criada referente à NF-e original nº ${originalInvoice.invoiceNumber || 'N/A'}. Motivo: ${justification}`,
        createdBy: user?.email || null,
      });

      // Emit return invoice through SEFAZ
      const sefazResult = await sefazService.emitNfe(returnInvoice.id);

      if (!sefazResult.success) {
        console.error(`❌ [SEFAZ] Falha ao emitir NF-e de devolução: ${sefazResult.errorMessage}`);
        await storage.createFiscalInvoiceEvent({
          invoiceId: returnInvoice.id,
          eventType: 'emissao',
          status: 'error',
          description: `Falha na emissão SEFAZ da NF-e de devolução: ${sefazResult.errorMessage}`,
          createdBy: user?.email || null,
        });

        return res.status(422).json({
          success: false,
          returnInvoice,
          errorCode: sefazResult.errorCode,
          message: `Falha ao transmitir NF-e de devolução à SEFAZ: ${sefazResult.errorMessage}. A NF-e de devolução foi criada em rascunho e pode ser emitida manualmente.`,
        });
      }

      console.log(`✅ [SEFAZ] NF-e de devolução ${returnInvoice.id} autorizada - Protocolo: ${sefazResult.protocolNumber}`);

      // Only proceed with cancellations and reversals after SEFAZ authorization
      // Cancel associated receivables from original invoice
      try {
        const allReceivables = await storage.getReceivables({});
        const linkedReceivables = allReceivables.filter(r => r.fiscalInvoiceId === req.params.id);
        for (const rec of linkedReceivables) {
          await storage.updateReceivable(rec.id, {
            status: 'cancelada',
            notes: `${rec.notes ? rec.notes + ' | ' : ''}Cancelada automaticamente - Devolução de venda: ${justification}`,
          });
          console.log(`💰 [NF-e RETURN] Conta a receber ${rec.id} cancelada (Devolução NF-e ${req.params.id})`);
        }
      } catch (recErr: any) {
        console.warn('⚠️ Erro ao cancelar contas a receber após devolução NF-e:', recErr.message);
      }

      // Reverse stock consumption for returned invoice
      try {
        const { reverseStockConsumption } = await import('./inventory-routes.js');
        const userId = req.user?.id || req.userId || null;
        for (const item of originalItems) {
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
        console.warn('⚠️ Erro ao reverter estoque após devolução NF-e:', stockErr.message);
      }

      // Update original invoice to mark it as returned (only after SEFAZ success)
      await storage.updateFiscalInvoice(req.params.id, {
        status: 'returned',
      });
      await storage.createFiscalInvoiceEvent({
        invoiceId: req.params.id,
        eventType: 'devolucao',
        status: 'success',
        description: `NF-e devolvida via SEFAZ. NF-e de devolução: ${returnInvoice.id} (Protocolo: ${sefazResult.protocolNumber}). Motivo: ${justification}`,
        createdBy: user?.email || null,
      });

      // Get updated return invoice with SEFAZ data
      const updatedReturnInvoice = await storage.getFiscalInvoice(returnInvoice.id);

      console.log(`📦 [NF-e RETURN] NF-e de devolução ${returnInvoice.id} autorizada pela SEFAZ para NF-e original ${req.params.id}`);
      res.status(201).json({
        success: true,
        returnInvoice: updatedReturnInvoice || returnInvoice,
        sefazProtocol: sefazResult.protocolNumber,
        message: `NF-e de devolução emitida e autorizada pela SEFAZ com sucesso. Protocolo: ${sefazResult.protocolNumber}`,
        receivablesCancelled: true,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, errorMessage: error.message });
    }
  });

  app.get('/api/sefaz/status', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/sefaz/consult', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-invoices/:invoiceId/items', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
    try {
      const items = await storage.getFiscalInvoiceItems(req.params.invoiceId);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ message: 'Erro ao buscar itens', error: error.message });
    }
  });

  app.post('/api/fiscal-invoices/:invoiceId/items', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.delete('/api/fiscal-invoice-items/:id', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-invoices/:invoiceId/events', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-backups', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.post('/api/fiscal-backups/create', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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

  app.get('/api/fiscal-dashboard', authenticateUser, requireRole(['admin', 'industria']), async (req: any, res) => {
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
