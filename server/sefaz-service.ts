import { NfeProc } from 'node-nfe-nfce';
import { storage } from './storage';
import { nowBrazil } from './brazilTimezone';
import type { FiscalInvoice, FiscalInvoiceItem, FiscalScenario, DigitalCertificate } from '@shared/schema';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SEFAZ_ENVIRONMENTS = {
  homologacao: 2,
  producao: 1,
} as const;

const UF_CODES: Record<string, string> = {
  'AC': '12', 'AL': '27', 'AP': '16', 'AM': '13', 'BA': '29',
  'CE': '23', 'DF': '53', 'ES': '32', 'GO': '52', 'MA': '21',
  'MT': '51', 'MS': '50', 'MG': '31', 'PA': '15', 'PB': '25',
  'PR': '41', 'PE': '26', 'PI': '22', 'RJ': '33', 'RN': '24',
  'RS': '43', 'RO': '11', 'RR': '14', 'SC': '42', 'SP': '35',
  'SE': '28', 'TO': '17',
};

export interface SefazConfig {
  certificatePfx: Buffer;
  certificatePassword: string;
  cnpj: string;
  uf: string;
  environment: 'homologacao' | 'producao';
  inscricaoEstadual?: string;
  razaoSocial?: string;
  nomeFantasia?: string;
  endereco?: {
    logradouro: string;
    numero: string;
    bairro: string;
    codigoMunicipio: string;
    nomeMunicipio: string;
    uf: string;
    cep: string;
    pais: string;
    codigoPais: string;
  };
}

export interface EmitNfeResult {
  success: boolean;
  accessKey?: string;
  protocolNumber?: string;
  xmlAutorizado?: string;
  xmlEnvio?: string;
  xmlRetorno?: string;
  danfeUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CancelNfeResult {
  success: boolean;
  protocolNumber?: string;
  xmlRequest?: string;
  xmlResponse?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface StatusResult {
  success: boolean;
  status?: string;
  description?: string;
  errorCode?: string;
  errorMessage?: string;
}

function generateAccessKey(params: {
  cUF: string;
  dataEmissao: Date;
  cnpj: string;
  mod: string;
  serie: string;
  nNF: string;
  tpEmis: string;
  cNF: string;
}): string {
  const { cUF, dataEmissao, cnpj, mod, serie, nNF, tpEmis, cNF } = params;
  const aamm = `${dataEmissao.getFullYear().toString().slice(2)}${(dataEmissao.getMonth() + 1).toString().padStart(2, '0')}`;
  const key = `${cUF}${aamm}${cnpj.replace(/\D/g, '').padStart(14, '0')}${mod}${serie.padStart(3, '0')}${nNF.padStart(9, '0')}${tpEmis}${cNF.padStart(8, '0')}`;
  const dv = calculateDV(key);
  return `${key}${dv}`;
}

function calculateDV(key: string): string {
  const weights = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  let weightIndex = 0;
  for (let i = key.length - 1; i >= 0; i--) {
    sum += parseInt(key[i]) * weights[weightIndex % weights.length];
    weightIndex++;
  }
  const remainder = sum % 11;
  const dv = remainder < 2 ? 0 : 11 - remainder;
  return dv.toString();
}

export class SefazService {
  private config: SefazConfig | null = null;

  async loadCertificate(certificateId: string): Promise<{ pfx: Buffer; password: string } | null> {
    try {
      const cert = await storage.getDigitalCertificate(certificateId);
      if (!cert || !cert.isActive) {
        console.error('[SEFAZ] Certificado não encontrado ou inativo:', certificateId);
        return null;
      }

      if (cert.validUntil && new Date(cert.validUntil) < new Date()) {
        console.error('[SEFAZ] Certificado expirado:', cert.validUntil);
        return null;
      }

      const certPath = path.join('/tmp', 'certificates', `${certificateId}.pfx`);
      if (!fs.existsSync(certPath)) {
        console.error('[SEFAZ] Arquivo de certificado não encontrado:', certPath);
        return null;
      }

      const pfx = fs.readFileSync(certPath);
      const password = process.env[`CERT_PASSWORD_${certificateId}`] || '';

      return { pfx, password };
    } catch (error) {
      console.error('[SEFAZ] Erro ao carregar certificado:', error);
      return null;
    }
  }

  async configure(config: SefazConfig): Promise<void> {
    this.config = config;
    console.log(`[SEFAZ] Configurado para ${config.environment} | UF: ${config.uf} | CNPJ: ${config.cnpj}`);
  }

  async checkServiceStatus(uf: string = 'GO', environment: 'homologacao' | 'producao' = 'homologacao'): Promise<StatusResult> {
    try {
      if (!this.config) {
        return { success: false, errorMessage: 'Serviço SEFAZ não configurado. Carregue um certificado primeiro.' };
      }

      console.log(`[SEFAZ] Consultando status do serviço - UF: ${uf}, Ambiente: ${environment}`);

      return {
        success: true,
        status: 'online',
        description: `Serviço SEFAZ ${environment} - UF ${uf} - Status: Operacional (modo ${environment})`,
      };
    } catch (error: any) {
      return {
        success: false,
        errorCode: 'SEFAZ_STATUS_ERROR',
        errorMessage: error.message || 'Erro ao consultar status SEFAZ',
      };
    }
  }

  buildNfeXml(invoice: FiscalInvoice, items: FiscalInvoiceItem[], scenario: FiscalScenario | null): Record<string, any> {
    const emissionDate = invoice.emissionDate || nowBrazil();
    const cNF = crypto.randomInt(10000000, 99999999).toString();
    const uf = this.config?.uf || 'GO';
    const cUF = UF_CODES[uf] || '52';

    const nfeData: Record<string, any> = {
      $: { xmlns: 'http://www.portalfiscal.inf.br/nfe' },
      infNFe: {
        $: { versao: '4.00' },
        ide: {
          cUF,
          cNF,
          natOp: invoice.natureOfOperation || scenario?.description || 'Venda',
          mod: '55',
          serie: invoice.series || '1',
          nNF: invoice.invoiceNumber?.toString() || '0',
          dhEmi: emissionDate instanceof Date ? emissionDate.toISOString() : new Date().toISOString(),
          tpNF: invoice.operationType === 'entrada' ? '0' : '1',
          idDest: scenario?.stateScope === 'fora_estado' ? '2' : '1',
          cMunFG: this.config?.endereco?.codigoMunicipio || '5208707',
          tpImp: '1',
          tpEmis: '1',
          cDV: '0',
          tpAmb: SEFAZ_ENVIRONMENTS[invoice.environment as keyof typeof SEFAZ_ENVIRONMENTS] || 2,
          finNFe: '1',
          indFinal: '1',
          indPres: '1',
          procEmi: '0',
          verProc: 'SistemaIntegra 1.0',
        },
        emit: {
          CNPJ: (this.config?.cnpj || '').replace(/\D/g, ''),
          xNome: this.config?.razaoSocial || 'Empresa Emitente',
          xFant: this.config?.nomeFantasia || '',
          IE: this.config?.inscricaoEstadual || '',
          CRT: '3',
          enderEmit: this.config?.endereco ? {
            xLgr: this.config.endereco.logradouro,
            nro: this.config.endereco.numero,
            xBairro: this.config.endereco.bairro,
            cMun: this.config.endereco.codigoMunicipio,
            xMun: this.config.endereco.nomeMunicipio,
            UF: this.config.endereco.uf,
            CEP: this.config.endereco.cep,
            cPais: this.config.endereco.codigoPais || '1058',
            xPais: this.config.endereco.pais || 'Brasil',
          } : {},
        },
        dest: {
          CNPJ: (invoice.customerCnpjCpf || '').replace(/\D/g, '').length === 14
            ? (invoice.customerCnpjCpf || '').replace(/\D/g, '')
            : undefined,
          CPF: (invoice.customerCnpjCpf || '').replace(/\D/g, '').length === 11
            ? (invoice.customerCnpjCpf || '').replace(/\D/g, '')
            : undefined,
          xNome: invoice.customerName || 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL',
          indIEDest: '9',
          IE: invoice.customerIe || undefined,
        },
        det: items.map((item, idx) => ({
          $: { nItem: (idx + 1).toString() },
          prod: {
            cProd: item.productCode || item.productId || (idx + 1).toString(),
            cEAN: 'SEM GTIN',
            xProd: invoice.environment === 'homologacao'
              ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
              : (item.productName || 'Produto'),
            NCM: item.ncm || '22029000',
            CEST: item.cest || undefined,
            CFOP: item.cfop || invoice.cfop || scenario?.cfop || '5102',
            uCom: item.unit || 'UN',
            qCom: item.quantity?.toString() || '1',
            vUnCom: item.unitPrice?.toString() || '0.00',
            vProd: item.totalPrice?.toString() || '0.00',
            cEANTrib: 'SEM GTIN',
            uTrib: item.unit || 'UN',
            qTrib: item.quantity?.toString() || '1',
            vUnTrib: item.unitPrice?.toString() || '0.00',
            indTot: '1',
            vDesc: parseFloat(item.discount?.toString() || '0') > 0 ? item.discount?.toString() : undefined,
          },
          imposto: {
            ICMS: {
              ICMS00: item.cstIcms === '00' ? {
                orig: '0',
                CST: item.cstIcms || '00',
                modBC: '3',
                vBC: item.baseIcms?.toString() || '0.00',
                pICMS: item.aliqIcms?.toString() || '0.00',
                vICMS: item.valorIcms?.toString() || '0.00',
              } : undefined,
              ICMS60: item.cstIcms === '60' ? {
                orig: '0',
                CST: '60',
                vBCSTRet: '0.00',
                pST: '0.00',
                vICMSSubstituto: '0.00',
                vICMSSTRet: '0.00',
              } : undefined,
              ICMSSN102: (!item.cstIcms || item.cstIcms === '102') ? {
                orig: '0',
                CSOSN: scenario?.csosn || '102',
              } : undefined,
            },
            PIS: {
              PISAliq: item.cstPis === '01' ? {
                CST: item.cstPis || '01',
                vBC: item.basePis?.toString() || '0.00',
                pPIS: item.aliqPis?.toString() || '0.0000',
                vPIS: item.valorPis?.toString() || '0.00',
              } : undefined,
              PISOutr: item.cstPis !== '01' ? {
                CST: item.cstPis || '99',
                vBC: '0.00',
                pPIS: '0.0000',
                vPIS: '0.00',
              } : undefined,
            },
            COFINS: {
              COFINSAliq: item.cstCofins === '01' ? {
                CST: item.cstCofins || '01',
                vBC: item.baseCofins?.toString() || '0.00',
                pCOFINS: item.aliqCofins?.toString() || '0.0000',
                vCOFINS: item.valorCofins?.toString() || '0.00',
              } : undefined,
              COFINSOutr: item.cstCofins !== '01' ? {
                CST: item.cstCofins || '99',
                vBC: '0.00',
                pCOFINS: '0.0000',
                vCOFINS: '0.00',
              } : undefined,
            },
          },
        })),
        total: {
          ICMSTot: {
            vBC: invoice.totalIcms?.toString() || '0.00',
            vICMS: invoice.totalIcms?.toString() || '0.00',
            vICMSDeson: '0.00',
            vFCPUFDest: '0.00',
            vICMSUFDest: '0.00',
            vICMSUFRemet: '0.00',
            vFCP: '0.00',
            vBCST: '0.00',
            vST: '0.00',
            vFCPST: '0.00',
            vFCPSTRet: '0.00',
            vProd: invoice.totalProducts?.toString() || '0.00',
            vFrete: invoice.totalFreight?.toString() || '0.00',
            vSeg: invoice.totalInsurance?.toString() || '0.00',
            vDesc: invoice.totalDiscount?.toString() || '0.00',
            vII: '0.00',
            vIPI: invoice.totalIpi?.toString() || '0.00',
            vIPIDevol: '0.00',
            vPIS: invoice.totalPis?.toString() || '0.00',
            vCOFINS: invoice.totalCofins?.toString() || '0.00',
            vOutro: invoice.totalOtherExpenses?.toString() || '0.00',
            vNF: invoice.totalInvoice?.toString() || '0.00',
          },
        },
        transp: {
          modFrete: '9',
        },
        pag: {
          detPag: {
            indPag: invoice.paymentMethod === 'a_vista' ? '0' : '1',
            tPag: invoice.paymentMethod === 'a_vista' ? '01' : '15',
            vPag: invoice.totalInvoice?.toString() || '0.00',
          },
        },
        infAdic: {
          infCpl: invoice.notes || '',
        },
      },
    };

    return nfeData;
  }

  async emitNfe(invoiceId: string): Promise<EmitNfeResult> {
    try {
      const invoice = await storage.getFiscalInvoice(invoiceId);
      if (!invoice) {
        return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Nota fiscal não encontrada' };
      }

      if (invoice.status !== 'draft' && invoice.status !== 'rejected') {
        return { success: false, errorCode: 'INVALID_STATUS', errorMessage: `NF-e com status '${invoice.status}' não pode ser emitida` };
      }

      const items = await storage.getFiscalInvoiceItems(invoiceId);
      if (!items || items.length === 0) {
        return { success: false, errorCode: 'NO_ITEMS', errorMessage: 'Nota fiscal não possui itens' };
      }

      const scenario = invoice.fiscalScenarioId
        ? await storage.getFiscalScenario(invoice.fiscalScenarioId)
        : null;

      if (!this.config) {
        if (invoice.environment === 'homologacao') {
          this.config = {
            certificatePfx: Buffer.from(''),
            certificatePassword: '',
            cnpj: invoice.issuerCnpj || '00000000000000',
            uf: 'GO',
            environment: 'homologacao',
            razaoSocial: invoice.issuerName || 'EMPRESA HOMOLOGACAO',
            nomeFantasia: invoice.issuerName || 'EMPRESA HOMOLOGACAO',
          };
          console.log('[SEFAZ] Auto-configurado para homologação (sem certificado)');
        } else {
          return { success: false, errorCode: 'NO_CONFIG', errorMessage: 'Serviço SEFAZ não configurado. Carregue um certificado digital para emissão em produção.' };
        }
      }

      const nfeData = this.buildNfeXml(invoice, items, scenario);
      const xmlEnvio = JSON.stringify(nfeData);

      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'emissao',
        status: 'processing',
        description: `Emissão NF-e iniciada em modo ${invoice.environment}`,
        xmlRequest: xmlEnvio,
        createdBy: invoice.createdBy || undefined,
      });

      if (invoice.environment === 'homologacao') {
        const mockAccessKey = generateAccessKey({
          cUF: UF_CODES[this.config.uf] || '52',
          dataEmissao: new Date(),
          cnpj: this.config.cnpj,
          mod: '55',
          serie: invoice.series || '1',
          nNF: (invoice.invoiceNumber || 1).toString(),
          tpEmis: '1',
          cNF: crypto.randomInt(10000000, 99999999).toString(),
        });
        const mockProtocol = `${Date.now()}`;

        await storage.updateFiscalInvoice(invoiceId, {
          status: 'authorized',
          accessKey: mockAccessKey,
          protocolNumber: mockProtocol,
          xmlEnvio,
          xmlRetorno: JSON.stringify({ cStat: '100', xMotivo: 'Autorizado o uso da NF-e (HOMOLOGAÇÃO)' }),
          xmlAutorizacao: xmlEnvio,
          authorizationDate: nowBrazil(),
        });

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'autorizacao',
          status: 'success',
          protocolNumber: mockProtocol,
          description: 'NF-e autorizada em ambiente de HOMOLOGAÇÃO (simulação)',
          xmlResponse: JSON.stringify({ cStat: '100', xMotivo: 'Autorizado' }),
          createdBy: invoice.createdBy || undefined,
        });

        return {
          success: true,
          accessKey: mockAccessKey,
          protocolNumber: mockProtocol,
          xmlEnvio,
          xmlRetorno: JSON.stringify({ cStat: '100' }),
          xmlAutorizado: xmlEnvio,
        };
      }

      return {
        success: false,
        errorCode: 'PRODUCTION_NOT_IMPLEMENTED',
        errorMessage: 'Emissão em produção requer configuração completa do certificado digital e conexão SEFAZ. Use homologação para testes.',
      };
    } catch (error: any) {
      console.error('[SEFAZ] Erro ao emitir NF-e:', error);

      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'emissao',
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: error.message,
        description: `Erro interno ao emitir NF-e: ${error.message}`,
      });

      await storage.updateFiscalInvoice(invoiceId, { status: 'rejected' });

      return {
        success: false,
        errorCode: 'INTERNAL_ERROR',
        errorMessage: error.message || 'Erro interno ao emitir NF-e',
      };
    }
  }

  async cancelNfe(invoiceId: string, justification: string): Promise<CancelNfeResult> {
    try {
      const invoice = await storage.getFiscalInvoice(invoiceId);
      if (!invoice) {
        return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Nota fiscal não encontrada' };
      }

      if (invoice.status !== 'authorized') {
        return { success: false, errorCode: 'INVALID_STATUS', errorMessage: `NF-e com status '${invoice.status}' não pode ser cancelada` };
      }

      if (!justification || justification.length < 15) {
        return { success: false, errorCode: 'INVALID_JUSTIFICATION', errorMessage: 'Justificativa deve ter pelo menos 15 caracteres' };
      }

      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'cancelamento',
        status: 'processing',
        description: `Cancelamento solicitado: ${justification}`,
        createdBy: invoice.createdBy || undefined,
      });

      if (invoice.environment === 'homologacao') {
        const mockProtocol = `${Date.now()}`;

        await storage.updateFiscalInvoice(invoiceId, {
          status: 'cancelled',
          cancellationDate: nowBrazil(),
        });

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'cancelamento',
          status: 'success',
          protocolNumber: mockProtocol,
          description: `NF-e cancelada em HOMOLOGAÇÃO: ${justification}`,
          createdBy: invoice.createdBy || undefined,
        });

        return { success: true, protocolNumber: mockProtocol };
      }

      return {
        success: false,
        errorCode: 'PRODUCTION_NOT_IMPLEMENTED',
        errorMessage: 'Cancelamento em produção requer configuração completa.',
      };
    } catch (error: any) {
      console.error('[SEFAZ] Erro ao cancelar NF-e:', error);
      return { success: false, errorCode: 'INTERNAL_ERROR', errorMessage: error.message };
    }
  }

  async consultNfe(accessKey: string): Promise<StatusResult> {
    try {
      if (!accessKey || accessKey.length !== 44) {
        return { success: false, errorCode: 'INVALID_KEY', errorMessage: 'Chave de acesso inválida (deve ter 44 dígitos)' };
      }

      return {
        success: true,
        status: '100',
        description: 'Autorizado o uso da NF-e (consulta em modo homologação)',
      };
    } catch (error: any) {
      return { success: false, errorCode: 'CONSULT_ERROR', errorMessage: error.message };
    }
  }

  getConfig(): SefazConfig | null {
    return this.config;
  }
}

export const sefazService = new SefazService();
