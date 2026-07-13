import {
  carregaCertificadoBase64,
  emitir,
  statusServico,
  cancelar,
} from 'node-nfe-nfce';

import { storage } from './storage';
import { nowBrazil } from './brazilTimezone';
import { isValidFiscalDoc } from './fiscal-doc';
import { normalizeUf, ufFromCep } from './cep-uf';
import type { FiscalInvoice, FiscalInvoiceItem, FiscalScenario } from '@shared/schema';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
// [2.0] objectStorage removido: certificado vem do banco (pfx_data cifrado)

// ─── Ambiente ─────────────────────────────────────────────────────────────────
const SEFAZ_AMBIENTE: Record<string, string> = {
  homologacao: '2',
  producao: '1',
};

// ─── Crédito de ICMS do Simples Nacional (CSOSN 101) ─────────────────────────
// Alíquota efetiva do Simples Nacional usada para conceder crédito de ICMS no
// rodapé da NF-e. Configurável em Cenários Fiscais (system_settings). O default
// reflete a alíquota vigente e é usado quando ainda não houver configuração.
export const SN_CREDIT_ALIQ_KEY = 'simples_nacional_credit_aliquota';
export const SN_CREDIT_ALIQ_DEFAULT = 3.77;

// ─── UF → cUF ────────────────────────────────────────────────────────────────
export const UF_CODES: Record<string, string> = {
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29',
  CE: '23', DF: '53', ES: '32', GO: '52', MA: '21',
  MT: '51', MS: '50', MG: '31', PA: '15', PB: '25',
  PR: '41', PE: '26', PI: '22', RJ: '33', RN: '24',
  RS: '43', RO: '11', RR: '14', SC: '42', SP: '35',
  SE: '28', TO: '17',
};

// ─── Decryption (mirrors nfe-routes.ts) ──────────────────────────────────────
const CERT_ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(process.env.SESSION_SECRET || 'cert-key-fallback')
  .digest();

function decryptPassword(encrypted: string): string {
  const [ivHex, encHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', CERT_ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── Sanitize strings for SEFAZ ──────────────────────────────────────────────
function onlyDigits(s: string): string {
  return (s || '').replace(/\D/g, '');
}

// NCMs conhecidos como INEXISTENTES na tabela da SEFAZ (rejeição "Informado NCM
// inexistente") usados indevidamente nos produtos de suco. Todos remapeiam para
// 2009.90.00 ("misturas de sucos"), o código vigente e aceito (única classe de
// suco com NF-e autorizada no histórico). Ex.: 2009.89.00 (20098900) nunca foi
// autorizado; 2202.90.00 (22029000) foi reclassificado em 2022.
const NCM_SUCO_MISTO = '20099000';
const INVALID_NCM_REMAP: Record<string, string> = {
  '20098900': NCM_SUCO_MISTO,
  '22029000': NCM_SUCO_MISTO,
  '00000000': NCM_SUCO_MISTO,
};

// Normaliza um NCM para 8 dígitos e remapeia códigos sabidamente inexistentes.
// Retorna '' apenas quando a entrada não tem dígito algum (caller decide o que
// fazer com vazio). NÃO inventa NCM para entrada vazia.
export function normalizeNcm(raw: string | null | undefined): string {
  const d = onlyDigits(raw || '');
  if (!d) return '';
  const v = d.padStart(8, '0').slice(0, 8);
  return INVALID_NCM_REMAP[v] || v;
}

// Substituição tributária da filial BSB (CNPJ 28295493000315, PURO IND COM
// PROD NATURAIS LTDA DF, Simples Nacional CRT=1). Toda VENDA onerosa de
// mercadoria dessa emissora sai como contribuinte substituído: CFOP 5405
// (interno DF) / 6404 (interestadual) e CSOSN 500 (ICMS-ST já recolhido pelo
// fornecedor). Diferente de _defaultCfop/_defaultCsosn (que só agem como
// fallback), esta regra é AUTORITATIVA: corrige CFOP/CSOSN de venda vindos de
// item ou cenário fiscal mal configurado (ex.: 5102/102). Só atua em CFOP de
// venda onerosa (5101-5129 / 6101-6129) — NÃO em devolução (52xx), bonificação
// (591x), amostra (591x), troca (594x) nem transferência (515x).
export function bsbStSaleOverride(
  issuerCnpj: string | null | undefined,
  cfop: string | null | undefined,
  isInterstate: boolean,
): { cfop: string; csosn: string } | null {
  if (onlyDigits(issuerCnpj || '') !== '28295493000315') return null;
  if (!/^[56]1(0[1-9]|1\d|2\d)$/.test(cfop || '')) return null;
  return { cfop: isInterstate ? '6404' : '5405', csosn: '500' };
}

// Recalcula a DIREÇÃO do CFOP (interno x interestadual) preservando a natureza
// da operação: troca só o 1º dígito (5↔6 saídas, 1↔2 entradas/devolução), com o
// par de ST 5405↔6404 como exceção (não é troca simples de dígito). Retorna
// null quando o CFOP já está coerente com a operação (ou é exterior 3xxx/7xxx,
// ou não é um CFOP de 4 dígitos). Caso "Casa de Marias" (NF 104152, 10/jul/2026):
// NF nasceu 6102 porque o cliente estava sem UF; corrigida a UF (DF=DF), o
// retentar mantinha o 6102 gravado → SEFAZ 772.
export function cfopForOperation(
  cfop: string | null | undefined,
  isInterstate: boolean,
): string | null {
  const cur = String(cfop || '').trim();
  if (!/^\d{4}$/.test(cur)) return null;
  if (cur === '5405' && isInterstate) return '6404';
  if (cur === '6404' && !isInterstate) return '5405';
  const d = cur.charAt(0);
  if (isInterstate) {
    if (d === '5') return '6' + cur.slice(1);
    if (d === '1') return '2' + cur.slice(1);
  } else {
    if (d === '6') return '5' + cur.slice(1);
    if (d === '2') return '1' + cur.slice(1);
  }
  return null;
}

function sanitizeStr(s: string, maxLen = 60): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 !@#$%^&*()_+\-=[\]{};':"\\|,.<>\/?]/g, ' ')
    .substring(0, maxLen)
    .trim() || 'N/A';
}

// ─── NF-e access key computation ─────────────────────────────────────────────
// Key = cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1) + cNF(8) + cDV(1)
export function computeNFeCheckDigit(key43: string): string {
  let sum = 0;
  let weight = 2;
  for (let i = key43.length - 1; i >= 0; i--) {
    sum += parseInt(key43[i], 10) * weight;
    weight = weight >= 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return String(remainder < 2 ? 0 : 11 - remainder);
}

export function computeNFeAccessKey(params: {
  cUF: string;
  emissionDate: Date;
  cnpj: string;
  serie: string;
  nNF: string;
  tpEmis?: string;
  cNF: string;
  modelo?: string;
}): string {
  const { cUF, emissionDate, cnpj, serie, nNF, tpEmis = '1', cNF, modelo = '55' } = params;
  const year = emissionDate.getFullYear().toString().slice(-2);
  const month = String(emissionDate.getMonth() + 1).padStart(2, '0');
  const AAMM = year + month;
  const key43 = [
    cUF.padStart(2, '0'),
    AAMM,
    onlyDigits(cnpj).padStart(14, '0'),
    modelo,
    serie.padStart(3, '0'),
    String(nNF).padStart(9, '0'),
    tpEmis,
    cNF.padStart(8, '0'),
  ].join('');
  return key43 + computeNFeCheckDigit(key43);
}

// ─── Parse customer address into street / number / complement ─────────────────
// Input: "Rua das Flores, nº 123 - Apto 45" or "Rua X, 100" or plain "Rua X"
function parseCustomerAddress(full: string): { xLgr: string; nro: string; xCompl?: string } {
  if (!full) return { xLgr: 'N/I', nro: 'S/N' };
  const ensureXLgr = (s: string) => {
    if (!s || s.length < 2) return 'N/I';
    return s.replace(/\s+$/, '') || 'N/I';
  };

  // Pattern 1: "Street, nº NUMBER" (optionally followed by complement)
  let m = full.match(/^(.+?),\s*n[º°]?\s*([A-Za-z0-9/\-]+)([\s,\-–]+(.+))?$/i);
  if (m) {
    const xCompl = m[4] ? sanitizeStr(m[4].trim(), 60) : undefined;
    return { xLgr: ensureXLgr(sanitizeStr(m[1].trim(), 60)), nro: sanitizeStr(m[2].trim(), 10) || 'S/N', ...(xCompl ? { xCompl } : {}) };
  }

  // Pattern 2: "Street, NUMBER" (number is purely numeric, optionally with complement)
  m = full.match(/^(.+?),\s*(\d+[A-Za-z]?)([\s,\-–]+(.+))?$/);
  if (m) {
    const xCompl = m[4] ? sanitizeStr(m[4].trim(), 60) : undefined;
    return { xLgr: ensureXLgr(sanitizeStr(m[1].trim(), 60)), nro: sanitizeStr(m[2].trim(), 10) || 'S/N', ...(xCompl ? { xCompl } : {}) };
  }

  // No number found — put everything in xLgr
  return { xLgr: ensureXLgr(sanitizeStr(full, 60)), nro: 'S/N' };
}

// ─── IBGE city code lookup for common cities ──────────────────────────────────
// IBGE city codes always start with a 2-digit UF code. Mismatch causes
// SEFAZ rejection: "Código Município do Destinatário difere do da UF do Destinatário".
const UF_IBGE_PREFIX: Record<string, string> = {
  'AC': '12', 'AL': '27', 'AP': '16', 'AM': '13', 'BA': '29', 'CE': '23',
  'DF': '53', 'ES': '32', 'GO': '52', 'MA': '21', 'MT': '51', 'MS': '50',
  'MG': '31', 'PA': '15', 'PB': '25', 'PR': '41', 'PE': '26', 'PI': '22',
  'RJ': '33', 'RN': '24', 'RS': '43', 'RO': '11', 'RR': '14', 'SC': '42',
  'SP': '35', 'SE': '28', 'TO': '17',
};

// Capital city IBGE code per UF — used as a safe fallback when the city
// is unknown but UF is known. This guarantees the cMun matches the UF.
const UF_CAPITAL_IBGE: Record<string, string> = {
  'AC': '1200401', // Rio Branco
  'AL': '2704302', // Maceió
  'AP': '1600303', // Macapá
  'AM': '1302603', // Manaus
  'BA': '2927408', // Salvador
  'CE': '2304400', // Fortaleza
  'DF': '5300108', // Brasília
  'ES': '3205309', // Vitória
  'GO': '5208707', // Goiânia
  'MA': '2111300', // São Luís
  'MT': '5103403', // Cuiabá
  'MS': '5002704', // Campo Grande
  'MG': '3106200', // Belo Horizonte
  'PA': '1501402', // Belém
  'PB': '2507507', // João Pessoa
  'PR': '4106902', // Curitiba
  'PE': '2611606', // Recife
  'PI': '2211001', // Teresina
  'RJ': '3304557', // Rio de Janeiro
  'RN': '2408102', // Natal
  'RS': '4314902', // Porto Alegre
  'RO': '1100205', // Porto Velho
  'RR': '1400100', // Boa Vista
  'SC': '4205407', // Florianópolis
  'SP': '3550308', // São Paulo
  'SE': '2800308', // Aracaju
  'TO': '1721000', // Palmas
};

const IBGE_CITY_CODES: Record<string, string> = {
  // GO
  'goiania': '5208707', 'goiânia': '5208707',
  'anapolis': '5201108', 'anápolis': '5201108',
  'aparecida de goiania': '5201405', 'aparecida de goiânia': '5201405',
  'rio verde': '5218805',
  'luziania': '5212501', 'luziânia': '5212501',
  'catalao': '5205109', 'catalão': '5205109',
  'jatai': '5211909', 'jataí': '5211909',
  'itumbiara': '5211503',
  'caldas novas': '5204508',
  'inhumas': '5210000',
  'senador canedo': '5220454',
  'trindade': '5221403',
  'bela vista de goias': '5203302', 'bela vista de goiás': '5203302',
  'piracanjuba': '5217104',
  'morrinhos': '5213806',
  'pires do rio': '5217203',
  'cristalina': '5206206',
  'planaltina': '5217609',
  'formosa': '5208004',
  'valparaiso de goias': '5221858', 'valparaíso de goiás': '5221858',
  'novo gama': '5215231',
  'hidrolandia': '5209705', 'hidrolândia': '5209705',
  'goiatuba': '5209200',
  'ipameri': '5210109',
  'mineiros': '5213103',
  'quirinopolis': '5218300', 'quirinópolis': '5218300',
  'sao luis de montes belos': '5220058',
  'uruacu': '5221403', 'uruaçu': '5221403',
  'itapaci': '5210802',
  'acreuna': '5200050', 'acreúna': '5200050',
  'goias': '5208509', 'goiás': '5208509',
  'ceres': '5205109',
  // DF
  'brasilia': '5300108', 'brasília': '5300108',
  'taguatinga': '5300108',
  'ceilandia': '5300108', 'ceilândia': '5300108',
  'samambaia': '5300108',
  'gama': '5300108',
  // SP
  'sao paulo': '3550308', 'são paulo': '3550308',
  'campinas': '3509502',
  'guarulhos': '3518800',
  'santos': '3548100',
  // RJ
  'rio de janeiro': '3304557',
  // MG
  'belo horizonte': '3106200',
  // BA
  'salvador': '2927408',
  // PE
  'recife': '2611606',
  'olinda': '2609600',
  'jaboatao dos guararapes': '2607901', 'jaboatão dos guararapes': '2607901',
  'caruaru': '2604106',
  'paulista': '2610707',
  // PR
  'curitiba': '4106902',
  // RS
  'porto alegre': '4314902',
  // SC
  'florianopolis': '4205407', 'florianópolis': '4205407',
  // CE
  'fortaleza': '2304400',
  // PA
  'belem': '1501402', 'belém': '1501402',
  // MA
  'sao luis': '2111300', 'são luís': '2111300',
  // ES
  'vitoria': '3205309', 'vitória': '3205309',
  // MT
  'cuiaba': '5103403', 'cuiabá': '5103403',
  // MS
  'campo grande': '5002704',
};

/**
 * Resolve um código IBGE de município de forma "UF-segura":
 * - Procura pelo nome no dicionário; ignora resultado se não bater com a UF.
 * - Fallback: capital da UF informada (garante que cMun e UF combinem).
 * - Se UF for desconhecida, último recurso é Goiânia.
 */
function lookupCityCode(cityName: string, uf?: string): string {
  const ufKey = (uf || '').toUpperCase().trim();
  const ufPrefix = UF_IBGE_PREFIX[ufKey];
  const capital = UF_CAPITAL_IBGE[ufKey];

  if (!cityName) {
    return capital || UF_CAPITAL_IBGE['GO'];
  }

  const key = cityName.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const candidate = IBGE_CITY_CODES[key] || IBGE_CITY_CODES[cityName.toLowerCase().trim()];

  // Só aceita o candidato se o prefixo bater com a UF informada (ou se a UF for desconhecida).
  if (candidate && (!ufPrefix || candidate.startsWith(ufPrefix))) {
    return candidate;
  }

  // Cidade não encontrada (ou bate em outra UF). Usa a capital da UF — sempre válido com a UF.
  if (capital) return capital;
  return UF_CAPITAL_IBGE['GO'];
}

/**
 * Garante que um código IBGE existente seja compatível com a UF informada.
 * Se não for, retorna o código da capital da UF (ou faz lookup pelo nome).
 */
function ensureCityCodeMatchesUf(cityCode: string | null | undefined, uf: string | null | undefined, cityName?: string | null): string {
  const ufKey = (uf || '').toUpperCase().trim();
  const ufPrefix = UF_IBGE_PREFIX[ufKey];
  const cleanCode = (cityCode || '').toString().trim();

  // Sem UF para validar — devolve o que tiver (ou faz lookup).
  if (!ufPrefix) {
    return cleanCode || lookupCityCode(cityName || '', ufKey);
  }

  // Código presente E compatível com a UF — usa direto.
  if (cleanCode && /^\d{7}$/.test(cleanCode) && cleanCode.startsWith(ufPrefix)) {
    return cleanCode;
  }

  // Código ausente ou inconsistente — refaz lookup pelo nome dentro da UF.
  return lookupCityCode(cityName || '', ufKey);
}

// ─── Interfaces ───────────────────────────────────────────────────────────────
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

/**
 * Versão do consultor SEFAZ. Incrementar quando o parser de respostas mudar
 * de forma incompatível, para que o frontend possa exibir um selo de
 * "verificada com a versão atual" e o backend possa identificar registros
 * que foram consultados pelo stub antigo (somente outer cStat) e precisam
 * ser reverificados.
 *
 *   v2-eventos → consultNfe usa NfeConsultaProtocolo4 real e detecta
 *                cancelamentos via Evento (tpEvento=110111/110112), validando
 *                o cStat dentro de <retEvento> (101/135/155).
 */
export const SEFAZ_VERIFIER_VERSION = 'v2-eventos';

// ─── Load certificate from Object Storage ─────────────────────────────────────
async function loadCertFromStorage(certificateId: string): Promise<{
  pem: string;
  key: string;
  password: string;
  csc?: string;
  idCsc?: string;
} | null> {
  try {
    const cert = await storage.getDigitalCertificate(certificateId);
    if (!cert) {
      console.error('[SEFAZ] Certificado não encontrado:', certificateId);
      return null;
    }
    if (!cert.isActive) {
      console.error('[SEFAZ] Certificado inativo:', certificateId);
      return null;
    }
    if (cert.validUntil && new Date(cert.validUntil) < new Date()) {
      console.error('[SEFAZ] Certificado expirado:', cert.validUntil);
      return null;
    }

    const rawPassword = cert.certificatePassword ? decryptPassword(cert.certificatePassword) : '';
    const base64 = (cert as any).pfxData ? decryptPassword((cert as any).pfxData) : '';
    if (!base64) {
      console.error('[SEFAZ] Certificado sem binario (pfx_data) no banco:', certificateId);
      return null;
    }

    console.log(`[SEFAZ] Carregando certificado ${certificateId} (${cert.companyName})...`);
    const certData = carregaCertificadoBase64({ password: rawPassword, base64 });

    if (!certData?.pem || !certData?.key) {
      console.error('[SEFAZ] carregaCertificadoBase64 não retornou pem/key');
      return null;
    }

    return {
      pem: certData.pem,
      key: certData.key,
      password: rawPassword,
      csc: (cert as any).csc || undefined,
      idCsc: (cert as any).idCsc || undefined,
    };
  } catch (err: any) {
    console.error('[SEFAZ] Erro ao carregar certificado do Object Storage:', err.message);
    return null;
  }
}

// ─── Find active certificate for a CNPJ ──────────────────────────────────────
export function extractCnpjFromCertName(companyName: string): string | null {
  const match = (companyName || '').match(/\d{14}/);
  return match ? match[0] : null;
}

// CNPJ real do certificado. O CNPJ vem embutido no CN do e-CNPJ ("RAZAO
// SOCIAL:CNPJ"), que é extraído do próprio arquivo e é a fonte de verdade.
// O campo `cnpj` pode ter sido gravado errado no upload (ex.: pegou o número
// do issuer/serial ou um valor digitado à mão), então só serve de fallback.
export function getCertificateCnpj(cert: { companyName?: string | null; cnpj?: string | null }): string {
  const fromName = extractCnpjFromCertName(cert.companyName || '');
  if (fromName && fromName.length === 14) return fromName;
  return onlyDigits(cert.cnpj || '');
}

async function findCertificateForCnpj(cnpj: string): Promise<string | null> {
  try {
    const certs = await storage.getDigitalCertificates();
    const clean = onlyDigits(cnpj);
    const cnpjRoot = clean.substring(0, 8);

    const validCerts = certs.filter(
      (c) => c.isActive && (!c.validUntil || new Date(c.validUntil) >= new Date()),
    );

    console.log(`[SEFAZ] Buscando certificado para CNPJ ${clean}. ${validCerts.length} certificados ativos.`);

    // Autocorreção: alinha o campo `cnpj` ao CNPJ real (do CN) quando divergem,
    // para que a lista e o painel do radar reflitam o dono correto do arquivo.
    for (const c of validCerts) {
      const real = getCertificateCnpj(c);
      if (real && real.length === 14 && onlyDigits(c.cnpj || '') !== real) {
        try {
          await storage.updateDigitalCertificate(c.id, { cnpj: real });
          (c as any).cnpj = real;
          console.log(`[SEFAZ] CNPJ do certificado "${c.companyName}" corrigido para ${real} (campo divergia do CN)`);
        } catch (e: any) {
          console.warn(`[SEFAZ] Falha ao corrigir CNPJ do certificado ${c.id}: ${e.message}`);
        }
      }
    }

    // Preferir certificado COM binario (pfx_data) no banco; entre iguais, o de maior validade.
    // Evita escolher um cert-cadastro paralelo sem PFX (que faria loadCertFromStorage falhar).
    const hasPfx = (c: any) => !!c.pfxData;
    const preferBest = (a: any, b: any) =>
      ((hasPfx(b) ? 1 : 0) - (hasPfx(a) ? 1 : 0)) ||
      (new Date(b.validUntil || 0).getTime() - new Date(a.validUntil || 0).getTime());

    const exactMatches = validCerts
      .filter((c) => getCertificateCnpj(c) === clean)
      .sort(preferBest);
    if (exactMatches.length) {
      const chosen = exactMatches[0];
      console.log(`[SEFAZ] Certificado encontrado por CNPJ exato: ${chosen.companyName} (pfx=${hasPfx(chosen)})`);
      return chosen.id;
    }

    const rootMatches = validCerts
      .filter((c) => getCertificateCnpj(c).substring(0, 8) === cnpjRoot && cnpjRoot.length === 8)
      .sort(preferBest);
    if (rootMatches.length) {
      const chosen = rootMatches[0];
      console.log(`[SEFAZ] Certificado encontrado por CNPJ raiz: ${chosen.companyName} (pfx=${hasPfx(chosen)})`);
      return chosen.id;
    }

    // ATENÇÃO: NÃO usar fallback para "único certificado disponível" — a SEFAZ
    // valida o CNPJ-Base do emitente vs o CNPJ-Base do certificado e rejeita
    // (cStat=213) se forem diferentes. Melhor falhar cedo com mensagem clara.
    console.warn(`[SEFAZ] Nenhum certificado encontrado para CNPJ ${clean}. Certificados disponíveis: ${validCerts.map(c => `${c.companyName}(cnpj=${getCertificateCnpj(c)})`).join(', ')}`);
    return null;
  } catch (err: any) {
    console.error(`[SEFAZ] Erro ao buscar certificado: ${err.message}`);
    return null;
  }
}

// ─── Build documento ──────────────────────────────────────────────────────────
function buildDocumento(
  invoice: FiscalInvoice,
  items: FiscalInvoiceItem[],
  scenario: FiscalScenario | null,
  ambiente: string,
  crt: string,
  allScenarios?: any[],
  snCreditAliq: number = 0,
): { documento: Record<string, any>; cNF: string; cUF: string; modelo: string } {
  const modelo = (invoice as any).invoiceModel || '55';
  const isNFCe = modelo === '65';
  const emissionDate = invoice.emissionDate ? new Date(invoice.emissionDate) : new Date();
  const uf = (invoice.issuerUf || 'GO').toUpperCase();
  const cUF = UF_CODES[uf] || '52';
  const cNF = crypto.randomInt(10000000, 99999999).toString().padStart(8, '0');

  const custDoc = onlyDigits(invoice.customerCnpjCpf || '');

  // UF do destinatário resolvida do estado cadastrado ou, em falta dele, do CEP.
  // NUNCA assume a UF do emitente: isso fazia venda interestadual sair como
  // interna (CFOP 5xxx em vez de 6xxx). Sem UF confiável, bloqueia a emissão da
  // NF-e. NFC-e (modelo 65) é sempre operação interna de consumidor final no
  // balcão, então pode usar a UF do emitente.
  let destUf = normalizeUf(invoice.customerUf) || ufFromCep(invoice.customerCep);
  if (!destUf) {
    if (!isNFCe) {
      throw new Error(
        `UF do destinatário não informada para o cliente "${invoice.customerName || ''}". ` +
        `Preencha o estado (UF) ou o CEP no cadastro do cliente antes de emitir a NF-e ` +
        `(sem a UF a nota sairia com CFOP incorreto).`
      );
    }
    destUf = (invoice.issuerUf || 'GO').toUpperCase();
  }
  const issuerCnpj = onlyDigits(invoice.issuerCnpj || '');
  const issuerCep = onlyDigits(invoice.issuerCep || '74335102').padStart(8, '0');

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const brtDate = new Date(emissionDate.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brtDate.getUTCFullYear();
  const MM = pad2(brtDate.getUTCMonth() + 1);
  const dd = pad2(brtDate.getUTCDate());
  const hh = pad2(brtDate.getUTCHours());
  const mm = pad2(brtDate.getUTCMinutes());
  const ss = pad2(brtDate.getUTCSeconds());
  const dhEmi = `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}-03:00`;
  const dhSaiEnt = dhEmi;

  const rawIe = (invoice.customerIe || '').trim();
  const ieClean = rawIe.toUpperCase() === 'NULL' || rawIe.toUpperCase() === 'ISENTO' || rawIe === '' ? '' : rawIe;
  const ieDigits = onlyDigits(ieClean);
  const isCpf = custDoc.length === 11;

  const IE_LENGTH_BY_UF: Record<string, number[]> = {
    'AC': [13], 'AL': [9], 'AP': [9], 'AM': [9], 'BA': [8,9], 'CE': [9], 'DF': [13],
    'ES': [9], 'GO': [9], 'MA': [9], 'MT': [11], 'MS': [9], 'MG': [13], 'PA': [9],
    'PB': [9], 'PR': [10], 'PE': [14], 'PI': [9], 'RJ': [8], 'RN': [9,10], 'RS': [10],
    'RO': [14], 'RR': [9], 'SC': [9], 'SP': [12], 'SE': [9], 'TO': [11],
  };
  const customerUfUpper = destUf;
  let ieValid = ieDigits.length > 0;
  if (ieValid && customerUfUpper && IE_LENGTH_BY_UF[customerUfUpper]) {
    const validLengths = IE_LENGTH_BY_UF[customerUfUpper];
    if (!validLengths.includes(ieDigits.length)) {
      console.warn(`⚠️ [NFE-XML] IE "${ieDigits}" (${ieDigits.length} dígitos) inválida para UF ${customerUfUpper} (esperado: ${validLengths.join('/')} dígitos). Enviando como não-contribuinte.`);
      ieValid = false;
    }
  }
  if (ieValid && !customerUfUpper) {
    console.warn(`⚠️ [NFE-XML] IE presente mas UF do destinatário desconhecida. Enviando como não-contribuinte.`);
    ieValid = false;
  }

  const hasIe = !isCpf && ieValid;
  console.log(`📋 [NFE-XML] dest: doc=${custDoc} (${isCpf ? 'CPF' : 'CNPJ'}), rawIe="${rawIe}", ieClean="${ieClean}", hasIe=${hasIe}, indIEDest=${hasIe ? '1' : '9'}`);

  let dest: Record<string, any> | undefined;

  // Só incluímos CPF/CNPJ no XML se os dígitos verificadores forem válidos. Um doc
  // com comprimento certo mas DV errado seria rejeitado pela SEFAZ. Para NFC-e
  // (modelo 65), sem doc válido emitimos como consumidor não identificado.
  const docIsValid = isValidFiscalDoc(custDoc);

  if (isNFCe) {
    if (docIsValid && isCpf) {
      dest = {
        CPF: custDoc,
        xNome: ambiente === '2'
          ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
          : sanitizeStr(invoice.customerName || 'CONSUMIDOR', 60),
        indIEDest: '9',
      };
    } else if (docIsValid && custDoc.length === 14) {
      dest = {
        CNPJ: custDoc,
        xNome: ambiente === '2'
          ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
          : sanitizeStr(invoice.customerName || 'CONSUMIDOR', 60),
        indIEDest: '9',
      };
    }
  } else {
    const destName = ambiente === '2'
      ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
      : sanitizeStr(invoice.customerName || 'DESTINATARIO', 60);

    if (docIsValid && custDoc.length === 14) {
      dest = { CNPJ: custDoc, xNome: destName, indIEDest: hasIe ? '1' : '9' };
      if (hasIe) dest.IE = ieDigits;
    } else if (docIsValid && isCpf) {
      dest = { CPF: custDoc, xNome: destName, indIEDest: '9' };
    } else {
      dest = { idEstrangeiro: '', xNome: destName, indIEDest: '9' };
    }
  }

  if (!isNFCe && (invoice.customerAddress || invoice.customerCity)) {
    // Parse address into logradouro + number + complement
    const fullAddr = invoice.customerAddress || '';
    const { xLgr, nro, xCompl } = parseCustomerAddress(fullAddr);
    // If form already provides a separate number, prefer it; treat "0"/"00" placeholders as "S/N"
    const rawNro = invoice.customerAddressNumber
      ? sanitizeStr(invoice.customerAddressNumber, 10)
      : nro;
    const nroFinal = /^0+$/.test(rawNro) ? 'S/N' : (rawNro || 'S/N');

    const finalCompl = (invoice as any).customerAddressComplement
      ? sanitizeStr((invoice as any).customerAddressComplement, 60)
      : xCompl;

    // City code: use stored value or look up from city name.
    // CRÍTICO: SEFAZ rejeita se cMun não bater com a UF (os 2 primeiros dígitos).
    const cleanedCity = (invoice.customerCity || '').replace(/\s*\([A-Z]{2}\)\s*$/, '');
    const cityCode = ensureCityCodeMatchesUf(invoice.customerCityCode, destUf, cleanedCity);
    if (invoice.customerCityCode && cityCode !== invoice.customerCityCode) {
      console.warn(`⚠️ [NFE-XML] cMun corrigido: ${invoice.customerCityCode} → ${cityCode} (cidade="${cleanedCity}", UF=${destUf})`);
    }

    const rawPhone = onlyDigits(invoice.customerPhone || '').slice(0, 14);
    const validPhone = rawPhone.length >= 6 && rawPhone.length <= 14 && !/^0+$/.test(rawPhone) ? rawPhone : null;

    const rawBairro = invoice.customerBairro && invoice.customerBairro.toLowerCase() !== 'null' ? invoice.customerBairro : '';
    const xBairro = sanitizeStr(rawBairro || 'N/I', 60);

    dest.enderDest = {
      xLgr: (!xLgr || xLgr.length < 2) ? 'N/I' : xLgr.replace(/\s+$/, '') || 'N/I',
      nro: nroFinal,
      ...(finalCompl ? { xCompl: finalCompl } : {}),
      xBairro,
      cMun: cityCode,
      xMun: sanitizeStr(cleanedCity || 'Goiania', 60),
      UF: destUf,
      CEP: onlyDigits(invoice.customerCep || '').padStart(8, '0'),
      cPais: '1058',
      xPais: 'BRASIL',
      ...(validPhone ? { fone: validPhone } : {}),
    };
  }

  // Detecta operação interestadual a partir do emissor vs destinatário.
  // Importante: não aplicar fallbacks de tributação INTERNA de GO (CST 20 com
  // benefício GO821005, alíquota 19%, redução 42,105%) em saídas interestaduais.
  const _issuerUfNorm = (invoice.issuerUf || 'GO').toUpperCase();
  const _customerUfNorm = destUf;
  const isInterstateOp = !!_customerUfNorm && _customerUfNorm !== _issuerUfNorm;

  // Defaults de CFOP/CSOSN por instância emissora. BSB (CNPJ 28295493000315,
  // PURO IND COM PROD NATURAIS LTDA filial DF, Simples Nacional) opera sob
  // substituição tributária: CFOP 5405 (interno DF) / 6404 (interestadual)
  // e CSOSN 500 (ICMS cobrado anteriormente por ST). Demais instâncias
  // mantêm 5102/102 como antes.
  const _issuerCnpjDigits = onlyDigits(invoice.issuerCnpj || '');
  const _isBsbIssuer = _issuerCnpjDigits === '28295493000315';
  const _defaultCfop = _isBsbIssuer
    ? (isInterstateOp ? '6404' : '5405')
    : '5102';
  const _defaultCsosn = _isBsbIssuer ? '500' : '102';

  const primaryCfopCandidates = [items[0]?.cfop, invoice.cfop, scenario?.cfop, _defaultCfop];
  const primaryCfop = primaryCfopCandidates.find(c => c && /^\d{4}$/.test(c)) || _defaultCfop;
  const cfopFirstDigit = primaryCfop.charAt(0);
  // idDest pela COMPARAÇÃO REAL de UFs (emitente x destinatário), não pelo 1º
  // dígito do CFOP gravado: um CFOP desatualizado na NF/itens não pode mais
  // contradizer a UF do destinatário (rejeição 772 — "Operação interestadual e
  // UF destinatário igual a UF de origem"). Exterior (3xxx/7xxx) segue o CFOP.
  const derivedIdDest =
    (cfopFirstDigit === '3' || cfopFirstDigit === '7') ? '3' :
    isInterstateOp ? '2' : '1';
  console.log(`📋 [NFE-XML] CFOP resolução: invoice.cfop=${invoice.cfop}, scenario.cfop=${scenario?.cfop}, primaryCfop=${primaryCfop}, idDest=${derivedIdDest}, scenario.stateScope=${scenario?.stateScope}, issuerCnpj=${_issuerCnpjDigits}, isBsb=${_isBsbIssuer}, defaultCfop=${_defaultCfop}, defaultCsosn=${_defaultCsosn}`);

  // NF-e interestadual (idDest=2) de emitente Regime Normal (CRT 3) para um
  // destinatário PESSOA JURÍDICA SEM Inscrição Estadual: a SEFAZ trata como
  // não contribuinte (indIEDest=9) e exige o grupo ICMSUFDest (DIFAL EC 87/2015),
  // rejeitando a nota (rejeição 871 "Não informado o grupo de ICMS para a UF de
  // destino"). Para o Simples Nacional (CRT 1/2) não há partilha (a nota é aceita
  // sem o grupo), por isso o bloqueio se limita ao CRT 3. Decisão do negócio: são
  // lojas que revendem (contribuintes) cuja IE está faltando no cadastro — então
  // bloqueamos e pedimos a IE em vez de calcular DIFAL.
  if (!isNFCe && derivedIdDest === '2' && crt === '3' && !isCpf && !hasIe) {
    throw new Error(
      `Cliente PJ "${invoice.customerName || ''}" sem Inscrição Estadual em venda ` +
      `interestadual (${_issuerUfNorm}→${_customerUfNorm}). Preencha a Inscrição ` +
      `Estadual no cadastro do cliente antes de emitir a NF-e (a SEFAZ exige o ICMS ` +
      `do estado de destino — DIFAL — quando o destinatário não é contribuinte).`
    );
  }

  let sumVbcIcms = 0;
  let sumVicms = 0;
  let sumVicmsDeson = 0;
  let sumVPis = 0;
  let sumVCofins = 0;
  let usedRcteRedBc = false;
  // Crédito de ICMS do Simples Nacional (CSOSN 101) acumulado para a legenda
  // do rodapé (infCpl), nos termos do art. 23 da LC 123/2006.
  let sumVCredSN = 0;
  let snCredAliqUsed = 0;
  // Alíquotas interestaduais: 7% para origem GO destino Sul/Sudeste (exceto ES);
  // 12% para os demais estados. (Mercadoria nacional, sem ICMS-ST.)
  function defaultInterstateIcmsFromGo(destUf: string): string {
    const sulSudeste7 = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);
    return sulSudeste7.has(destUf) ? '7' : '12';
  }
  function defaultGoIcmsAliq(): string {
    if (_issuerUfNorm !== 'GO') return '0';
    return isInterstateOp ? defaultInterstateIcmsFromGo(_customerUfNorm) : '19';
  }

  function safeDecimal(val: any, decimals: number, fallback = '0'): string {
    const n = parseFloat(val?.toString() || fallback);
    return (isNaN(n) || n < 0 ? 0 : n).toFixed(decimals);
  }

  const detList = items.map((item, idx) => {
    const cfopCandidates = [item.cfop, invoice.cfop, scenario?.cfop, _defaultCfop];
    let cfop = cfopCandidates.find(c => c && /^\d{4}$/.test(c)) || _defaultCfop;
    // Direção do CFOP sempre coerente com a operação REAL (UF emitente x UF
    // destinatário) — proteção final contra CFOP desatualizado gravado na
    // NF/itens/cenário (o recálculo persistente acontece no _doEmitNfe).
    const _dirFix = cfopForOperation(cfop, isInterstateOp);
    if (_dirFix) {
      console.log(`🔧 [NFE-XML] CFOP ${cfop} → ${_dirFix} (operação ${isInterstateOp ? 'interestadual' : 'interna'} ${_issuerUfNorm}→${_customerUfNorm})`);
      cfop = _dirFix;
    }
    const qty = parseFloat(item.quantity?.toString() || '1').toFixed(4);
    const unitPrc = parseFloat(item.unitPrice?.toString() || '0').toFixed(10);
    const totPrc = parseFloat(item.totalPrice?.toString() || '0').toFixed(2);
    const descVal = parseFloat(item.discount?.toString() || '0');

    const imposto: Record<string, any> = {
      ICMS: {},
      PIS: {},
      COFINS: {},
    };

    // ICMS
    const CSOSN_VALUES = ['101', '102', '103', '200', '201', '202', '203', '300', '400', '500', '900'];
    const rawCstIcms = item.cstIcms;
    const isCsosnInCst = rawCstIcms && CSOSN_VALUES.includes(rawCstIcms);
    let csosn = item.csosn || (isCsosnInCst ? rawCstIcms : null) || scenario?.csosn || _defaultCsosn;
    let cstIcms = isCsosnInCst ? null : rawCstIcms;

    // BSB (Simples Nacional sob ST): venda onerosa sempre como contribuinte
    // substituído (5405/6404 + CSOSN 500), sobrepondo CFOP/CSOSN de venda
    // herdados de item/cenário mal configurado (ex.: 5102/102→101).
    // Só vale para NF-e modelo 55; NFC-e (consumidor final) não é alterada.
    const _bsbStOv = !isNFCe ? bsbStSaleOverride(invoice.issuerCnpj, cfop, isInterstateOp) : null;
    if (_bsbStOv) {
      cfop = _bsbStOv.cfop;
      csosn = _bsbStOv.csosn;
      cstIcms = null;
    }

    const icmsOrig = item.icmsOrigem || scenario?.icmsOrigem || '0';
    // cBenef interno (GO821005) só pode ser usado em operação interna em GO.
    // Em saída interestadual, ignorar qualquer cBenef herdado de cenário irmão.
    let cBenef = (item.cBenef || scenario?.cBenef || '');
    if (cBenef && isInterstateOp) {
      console.log(`🔧 [NFE-XML] cBenef "${cBenef}" descartado (operação interestadual ${_issuerUfNorm}→${_customerUfNorm})`);
      cBenef = '';
    }
    if (!cBenef && cstIcms === '20' && !isInterstateOp && allScenarios) {
      console.warn(`⚠️ [NFE-XML] CST 20 sem cBenef no item ${item.productName} e cenário ${scenario?.name || 'N/A'}. Buscando em cenários irmãos...`);
      const sameInstanceWithBenef = allScenarios.find((s: any) =>
        s.cBenef && s.cstIcms === '20' &&
        s.omieInstanceId === scenario?.omieInstanceId &&
        s.operationType === scenario?.operationType
      );
      if (sameInstanceWithBenef) {
        cBenef = sameInstanceWithBenef.cBenef!;
        console.log(`✅ [NFE-XML] cBenef encontrado em cenário irmão "${sameInstanceWithBenef.name}": ${cBenef}`);
      }
    }

    if (crt === '1' || crt === '2') {
      // Simples Nacional: SEFAZ rejeita CST. Se um CST veio do cenário/item
      // e nenhum CSOSN explícito foi configurado, mapeia para o CSOSN equivalente.
      let snCsosn = csosn;
      if (cstIcms && !item.csosn && !scenario?.csosn) {
        const cstToCsosn: Record<string, string> = {
          '00': '102', // tributada integralmente → sem permissão de crédito
          '10': '201',
          '20': '900', // com redução BC → outros (mantém destaque de BC/aliq)
          '30': '102',
          '40': '102', // isenta
          '41': '102', // não tributada
          '50': '102',
          '51': '900',
          '60': '500', // ICMS-ST cobrado anteriormente
          '70': '900',
          '90': '900',
        };
        snCsosn = cstToCsosn[cstIcms] || '102';
      }
      // Crédito de ICMS no Simples Nacional: quando há alíquota configurada e a
      // operação é VENDA onerosa, emite com permissão de crédito (CSOSN 101) em
      // vez de 102. Elegibilidade restrita a:
      //   - CFOP de venda onerosa (5101-5129 / 6101-6129) — exclui transferência
      //     (515x), bonificação (591x), amostra (591x), troca (594x), devolução (52xx);
      //   - operação do tipo 'venda' (quando o cenário informa o operationType);
      //   - NF-e modelo 55 (NUNCA NFC-e / consumidor final);
      //   - destinatário CONTRIBUINTE do ICMS (indIEDest '1' = hasIe). SEFAZ
      //     rejeita CSOSN 101 para Não Contribuinte (rejeição 600 "CSOSN
      //     incompatível na operação com Não Contribuinte"): o crédito só pode
      //     ser aproveitado por quem é contribuinte;
      //   - sem CSOSN explícito em item/cenário (não sobrescreve config manual).
      // BSB e demais cenários com CSOSN/ST (ex.: 500) não entram aqui pois só
      // alteramos quando o CSOSN resolvido seria 102.
      const isSaleCfop = /^[56]1(0[1-9]|1\d|2\d)$/.test(cfop);
      const isVendaOp = scenario?.operationType ? scenario.operationType === 'venda' : true;
      const eligibleForSnCredit = isSaleCfop && isVendaOp && !isNFCe && hasIe;
      if (
        snCsosn === '102' &&
        snCreditAliq > 0 &&
        eligibleForSnCredit &&
        !item.csosn &&
        !scenario?.csosn
      ) {
        snCsosn = '101';
      }
      if (snCsosn === '101') {
        const pCredSN = Math.max(0, parseFloat(
          item.aliqIcms?.toString() ||
          scenario?.aliqIcms?.toString() ||
          (snCreditAliq > 0 ? String(snCreditAliq) : '0')
        ));
        const vCredICMSSN = parseFloat(totPrc) * (pCredSN / 100);
        imposto.ICMS.ICMSSN101 = {
          orig: icmsOrig,
          CSOSN: '101',
          pCredSN: pCredSN.toFixed(2),
          vCredICMSSN: Math.max(0, vCredICMSSN).toFixed(2),
        };
        // Só alimenta a legenda do art. 23 (rodapé) em NF-e modelo 55. Em NFC-e
        // (consumidor final) o crédito não é aproveitável pelo destinatário.
        if (pCredSN > 0 && !isNFCe) {
          sumVCredSN += Math.max(0, vCredICMSSN);
          snCredAliqUsed = pCredSN;
        }
      } else if (snCsosn === '201') {
        const pCredSN201 = Math.max(0, parseFloat(item.aliqIcms?.toString() || scenario?.aliqIcms?.toString() || '0'));
        const vCredICMSSN201 = parseFloat(totPrc) * (pCredSN201 / 100);
        imposto.ICMS.ICMSSN201 = {
          orig: icmsOrig,
          CSOSN: '201',
          modBCST: '4',
          pMVAST: '0.00',
          pRedBCST: '0.00',
          vBCST: '0.00',
          pICMSST: '0.00',
          vICMSST: '0.00',
          pCredSN: pCredSN201.toFixed(2),
          vCredICMSSN: Math.max(0, vCredICMSSN201).toFixed(2),
        };
      } else if (snCsosn === '202' || snCsosn === '203') {
        imposto.ICMS.ICMSSN202 = {
          orig: icmsOrig,
          CSOSN: snCsosn,
          modBCST: '4',
          pMVAST: '0.00',
          pRedBCST: '0.00',
          vBCST: '0.00',
          pICMSST: '0.00',
          vICMSST: '0.00',
        };
      } else if (snCsosn === '400' || snCsosn === '102' || snCsosn === '103' || snCsosn === '300') {
        imposto.ICMS.ICMSSN102 = { orig: icmsOrig, CSOSN: snCsosn };
      } else if (snCsosn === '500') {
        imposto.ICMS.ICMSSN500 = {
          orig: icmsOrig,
          CSOSN: '500',
          vBCSTRet: '0.00',
          pST: '0.00',
          vICMSSTRet: '0.00',
        };
      } else if (snCsosn === '900') {
        imposto.ICMS.ICMSSN900 = {
          orig: icmsOrig,
          CSOSN: '900',
        };
      } else {
        imposto.ICMS.ICMSSN102 = { orig: icmsOrig, CSOSN: '102' };
      }
    } else {
      // CRT 3 (Lucro Real) — sem CST definido:
      //  - Saída INTERNA em GO: CST 20 (redução de BC com benefício GO821005, alíq 19%)
      //  - Saída INTERESTADUAL: CST 00 (tributação normal interestadual, sem benefício)
      let resolvedCstIcmsCrt3 = cstIcms;
      if (!resolvedCstIcmsCrt3 && _issuerUfNorm === 'GO') {
        resolvedCstIcmsCrt3 = isInterstateOp ? '00' : '20';
      }
      if (resolvedCstIcmsCrt3 === '00') {
        // CRT 3 + CST 00 — tributação normal. Sempre computa quando os valores
        // do item estão zerados/ausentes para evitar destaques zerados na DANFE.
        const aliqIcmsRaw = parseFloat(item.aliqIcms?.toString() || scenario?.aliqIcms?.toString() || defaultGoIcmsAliq());
        const itemVbc = parseFloat(item.baseIcms?.toString() || '0');
        const vbc00b = itemVbc > 0 ? itemVbc : parseFloat(totPrc);
        const itemVicms = parseFloat(item.valorIcms?.toString() || '0');
        const vicms00b = itemVicms > 0 ? itemVicms : Math.round(vbc00b * (aliqIcmsRaw / 100) * 100) / 100;
        imposto.ICMS.ICMS00 = {
          orig: icmsOrig,
          CST: '00',
          modBC: item.modalidadeBcIcms || scenario?.modalidadeBcIcms || '3',
          vBC: Math.max(0, vbc00b).toFixed(2),
          pICMS: Math.max(0, aliqIcmsRaw).toFixed(2),
          vICMS: Math.max(0, vicms00b).toFixed(2),
        };
        sumVbcIcms += vbc00b;
        sumVicms += vicms00b;
      } else if (resolvedCstIcmsCrt3 === '20') {
        // Defaults internos GO (CST 20 com benefício GO821005). Para
        // operações interestaduais NÃO aplicar redução BC nem 19% — usar a
        // alíquota interestadual padrão e redBC 0.
        const isGoServ = _issuerUfNorm === 'GO' && !isInterstateOp;
        const defaultRedBc = isGoServ ? '42.105' : '0';
        const defaultAliqIcms = isGoServ ? '19' : (isInterstateOp ? defaultGoIcmsAliq() : '0');
        const redBc = parseFloat(item.redBcIcms?.toString() || scenario?.redBcIcms?.toString() || defaultRedBc);
        const aliqIcms20 = parseFloat(item.aliqIcms?.toString() || scenario?.aliqIcms?.toString() || defaultAliqIcms);
        const baseCalc = parseFloat(totPrc) * (1 - redBc / 100);
        const valorIcms20 = baseCalc * (aliqIcms20 / 100);
        const vDesonerado2 = parseFloat(item.valorIcmsDesonerado?.toString() || scenario?.valorIcmsDesonerado?.toString() || '0');
        const motDesoneracao2 = item.motivoDesoneracaoIcms || scenario?.motivoDesoneracaoIcms || '9';
        const icms20: Record<string, any> = {
          orig: icmsOrig,
          CST: '20',
          modBC: item.modalidadeBcIcms || scenario?.modalidadeBcIcms || '3',
          pRedBC: Math.max(0, redBc).toFixed(2),
          vBC: Math.max(0, baseCalc).toFixed(2),
          pICMS: Math.max(0, aliqIcms20).toFixed(2),
          vICMS: Math.max(0, valorIcms20).toFixed(2),
        };
        if (vDesonerado2 > 0) {
          icms20.vICMSDeson = vDesonerado2.toFixed(2);
          icms20.motDesICMS = motDesoneracao2;
          sumVicmsDeson += vDesonerado2;
        }
        imposto.ICMS.ICMS20 = icms20;
        sumVbcIcms += baseCalc;
        sumVicms += valorIcms20;
        if (redBc > 0 && crt === '3' && (invoice.issuerUf || 'GO').toUpperCase() === 'GO') {
          usedRcteRedBc = true;
        }
      } else if (resolvedCstIcmsCrt3 === '60') {
        imposto.ICMS.ICMS60 = {
          orig: icmsOrig,
          CST: '60',
          vBCSTRet: '0.00',
          pST: '0.00',
          vICMSSubstituto: '0.00',
          vICMSSTRet: '0.00',
        };
      } else {
        const csosnToCstMap: Record<string, string> = { '400': '41', '102': '41', '103': '41', '300': '41', '500': '60', '101': '00', '900': '41' };
        let resolvedCst = (resolvedCstIcmsCrt3 && !CSOSN_VALUES.includes(resolvedCstIcmsCrt3)) ? resolvedCstIcmsCrt3 : (csosnToCstMap[csosn] || '41');
        const cstRequiresBenef = ['40', '41', '50'].includes(resolvedCst);
        if (cstRequiresBenef && !cBenef && !isInterstateOp && allScenarios) {
          const issuerCnpjClean = onlyDigits(invoice.issuerCnpj || '');
          const crtMapForLookup: Record<string, string> = {
            '28295493000315': '1', '28295493000234': '1',
            '28295493000153': '1', '52921727000105': '3',
          };
          const issuerCrt = crtMapForLookup[issuerCnpjClean] || crt;
          const scenarioWithBenef = allScenarios.find((s: any) =>
            s.cBenef && s.cstIcms && !CSOSN_VALUES.includes(s.cstIcms)
          );
          if (scenarioWithBenef) {
            console.log(`🔧 [NFE-XML] CRT ${issuerCrt}, CST ${resolvedCst} sem cBenef → usando cenário "${scenarioWithBenef.name}" (CST=${scenarioWithBenef.cstIcms}, cBenef=${scenarioWithBenef.cBenef})`);
            cBenef = scenarioWithBenef.cBenef!;
            resolvedCst = scenarioWithBenef.cstIcms;
          }
        }
        if (resolvedCst === '20') {
          // Defaults internos GO só valem em operação interna; em interestadual
          // usar redBC 0 e alíquota interestadual padrão (7/12% conforme UF destino).
          const isGoFb = _issuerUfNorm === 'GO' && !isInterstateOp;
          const redBcFb = parseFloat(item.redBcIcms?.toString() || scenario?.redBcIcms?.toString() || (isGoFb ? '42.105' : '0'));
          const aliqFb = parseFloat(item.aliqIcms?.toString() || scenario?.aliqIcms?.toString() || (isGoFb ? '19' : (isInterstateOp ? defaultGoIcmsAliq() : '0')));
          const baseCalcFb = parseFloat(totPrc) * (1 - redBcFb / 100);
          const valorIcmsFb = baseCalcFb * (aliqFb / 100);
          imposto.ICMS.ICMS20 = {
            orig: icmsOrig,
            CST: '20',
            modBC: item.modalidadeBcIcms || scenario?.modalidadeBcIcms || '3',
            pRedBC: Math.max(0, redBcFb).toFixed(2),
            vBC: Math.max(0, baseCalcFb).toFixed(2),
            pICMS: Math.max(0, aliqFb).toFixed(2),
            vICMS: Math.max(0, valorIcmsFb).toFixed(2),
          };
          sumVbcIcms += baseCalcFb;
          sumVicms += valorIcmsFb;
          if (redBcFb > 0 && crt === '3' && isGoFb) {
            usedRcteRedBc = true;
          }
        } else {
          imposto.ICMS.ICMS40 = { orig: icmsOrig, CST: resolvedCst };
        }
      }
    }

    // PIS — Regime Normal (CRT 3) precisa de vBC, pPIS e vPIS preenchidos.
    // Default da alíquota varia conforme o regime de apuração:
    //  - Lucro Real (não-cumulativo): 1,65%
    //  - Lucro Presumido (cumulativo): 0,65%
    const _pisCofinsDefaults = defaultPisCofinsRates(invoice.issuerCnpj);
    const cstPis = item.cstPis || scenario?.cstPis || (crt === '3' ? '01' : '99');
    const pisNtCsts = ['04', '05', '06', '07', '08', '09'];
    if (cstPis === '01' || cstPis === '02') {
      const itemBasePis = parseFloat(item.basePis?.toString() || '0');
      const scenBcPis = parseFloat(scenario?.bcPis?.toString() || '0');
      const basePisNum = itemBasePis > 0 ? itemBasePis : (scenBcPis > 0 ? scenBcPis : parseFloat(totPrc));
      const aliqPisNum = parseFloat(item.aliqPis?.toString() || scenario?.aliqPis?.toString() || (crt === '3' ? _pisCofinsDefaults.pis : '0'));
      const itemValorPis = parseFloat(item.valorPis?.toString() || '0');
      const valorPisNum = itemValorPis > 0 ? itemValorPis : Math.round(basePisNum * (aliqPisNum / 100) * 100) / 100;
      imposto.PIS.PISAliq = {
        CST: cstPis,
        vBC: Math.max(0, basePisNum).toFixed(2),
        pPIS: Math.max(0, aliqPisNum).toFixed(4),
        vPIS: Math.max(0, valorPisNum).toFixed(2),
      };
      sumVPis += Math.max(0, valorPisNum);
    } else if (cstPis === '03') {
      imposto.PIS.PISQtde = {
        CST: '03',
        qBCProd: safeDecimal(item.basePis, 4),
        vAliqProd: safeDecimal(item.aliqPis, 4),
        vPIS: safeDecimal(item.valorPis, 2),
      };
    } else if (pisNtCsts.includes(cstPis)) {
      imposto.PIS.PISNT = {
        CST: cstPis,
      };
    } else {
      imposto.PIS.PISOutr = {
        CST: cstPis,
        vBC: 0,
        pPIS: 0,
        vPIS: 0,
      };
    }

    // COFINS — Lucro Real (CRT 3) precisa de vBC, pCOFINS e vCOFINS preenchidos
    const cstCofins = item.cstCofins || scenario?.cstCofins || (crt === '3' ? '01' : '99');
    const cofinsNtCsts = ['04', '05', '06', '07', '08', '09'];
    if (cstCofins === '01' || cstCofins === '02') {
      const itemBaseCofins = parseFloat(item.baseCofins?.toString() || '0');
      const scenBcCofins = parseFloat(scenario?.bcCofins?.toString() || '0');
      const baseCofinsNum = itemBaseCofins > 0 ? itemBaseCofins : (scenBcCofins > 0 ? scenBcCofins : parseFloat(totPrc));
      const aliqCofinsNum = parseFloat(item.aliqCofins?.toString() || scenario?.aliqCofins?.toString() || (crt === '3' ? _pisCofinsDefaults.cofins : '0'));
      const itemValorCofins = parseFloat(item.valorCofins?.toString() || '0');
      const valorCofinsNum = itemValorCofins > 0 ? itemValorCofins : Math.round(baseCofinsNum * (aliqCofinsNum / 100) * 100) / 100;
      sumVCofins += Math.max(0, valorCofinsNum);
      imposto.COFINS.COFINSAliq = {
        CST: cstCofins,
        vBC: Math.max(0, baseCofinsNum).toFixed(2),
        pCOFINS: Math.max(0, aliqCofinsNum).toFixed(4),
        vCOFINS: Math.max(0, valorCofinsNum).toFixed(2),
      };
    } else if (cstCofins === '03') {
      imposto.COFINS.COFINSQtde = {
        CST: '03',
        qBCProd: safeDecimal(item.baseCofins, 4),
        vAliqProd: safeDecimal(item.aliqCofins, 4),
        vCOFINS: safeDecimal(item.valorCofins, 2),
      };
    } else if (cofinsNtCsts.includes(cstCofins)) {
      imposto.COFINS.COFINSNT = {
        CST: cstCofins,
      };
    } else {
      imposto.COFINS.COFINSOutr = {
        CST: cstCofins,
        vBC: 0,
        pCOFINS: 0,
        vCOFINS: 0,
      };
    }

    let lotInfo = '';
    if (item.lotNumber) {
      lotInfo = sanitizeStr(`Lote: ${item.lotNumber}`, 500);
    } else {
      const lotMatch = (item.productName || '').match(/(?:\s*-\s*)?Lote:\s*(.+)$/i);
      if (lotMatch) lotInfo = sanitizeStr(`Lote: ${lotMatch[1].trim()}`, 500);
    }

    const prodName = item.productName || 'Produto';
    const baseName = prodName.replace(/\s*[-–]\s*Lote:.*$/i, '').replace(/\s*Lote:.*$/i, '').trim() || prodName;

    const det: Record<string, any> = {
      $: { nItem: String(idx + 1) },
      prod: {
        cProd: sanitizeStr(item.productCode || String(idx + 1), 60),
        cEAN: 'SEM GTIN',
        xProd: sanitizeStr(baseName, 120),
        NCM: (() => {
          const ncmVal = normalizeNcm(item.ncm);
          if (!ncmVal) throw new Error(`Item ${idx + 1} (${item.productName || 'Produto'}) sem NCM. O NCM é obrigatório para emissão de NF-e.`);
          return ncmVal;
        })(),
        CFOP: cfop,
        uCom: item.unit || 'UN',
        qCom: qty,
        vUnCom: unitPrc,
        vProd: totPrc,
        cEANTrib: 'SEM GTIN',
        uTrib: item.unit || 'UN',
        qTrib: qty,
        vUnTrib: unitPrc,
        indTot: '1',
        ...(item.cest ? { CEST: item.cest } : {}),
        ...(cBenef ? { cBenef } : {}),
        ...(descVal > 0 ? { vDesc: descVal.toFixed(2) } : {}),
      },
      imposto,
      ...(lotInfo ? { infAdProd: lotInfo } : {}),
    };

    return det;
  });

  const totalProducts = parseFloat(invoice.totalProducts?.toString() || '0');
  const totalFreight = parseFloat(invoice.totalFreight?.toString() || '0');
  const totalInsurance = parseFloat(invoice.totalInsurance?.toString() || '0');
  const totalDiscount = parseFloat(invoice.totalDiscount?.toString() || '0');
  const totalOther = parseFloat(invoice.totalOtherExpenses?.toString() || '0');
  const totalInvoice = parseFloat(invoice.totalInvoice?.toString() || '0');
  const totalIcms = parseFloat(invoice.totalIcms?.toString() || '0');
  const totalPis = parseFloat(invoice.totalPis?.toString() || '0');
  const totalCofins = parseFloat(invoice.totalCofins?.toString() || '0');
  const totalIpi = parseFloat(invoice.totalIpi?.toString() || '0');

  const documento: Record<string, any> = {
    ide: {
      cUF,
      cNF,
      natOp: sanitizeStr(invoice.natureOfOperation || scenario?.description || 'Venda de Mercadoria', 60),
      mod: modelo,
      serie: String(parseInt(invoice.series || (isNFCe ? '1' : '1'), 10)),
      nNF: String(invoice.invoiceNumber || 1),
      dhEmi,
      ...(!isNFCe && invoice.operationType !== 'entrada' ? { dhSaiEnt } : {}),
      tpNF: invoice.operationType === 'entrada' ? '0' : '1',
      idDest: isNFCe ? '1' : derivedIdDest,
      cMunFG: invoice.issuerCityCode || '5208707',
      tpImp: isNFCe ? '4' : '1',
      tpEmis: '1',
      cDV: '0',
      tpAmb: ambiente,
      finNFe: isNFCe ? '1' : (invoice.finNFe || '1'),
      indFinal: '1',
      indPres: isNFCe ? '1' : '1',
      procEmi: '0',
      verProc: 'SistemaIntegra 1.0',
      ...(!isNFCe && invoice.referencedAccessKey
        ? { NFref: { refNFe: invoice.referencedAccessKey } }
        : {}),
    },
    emit: {
      CNPJ: issuerCnpj,
      xNome: sanitizeStr(invoice.issuerName || 'EMITENTE', 60),
      xFant: sanitizeStr(invoice.issuerName || '', 60),
      enderEmit: {
        xLgr: (() => { const s = sanitizeStr(invoice.issuerStreet || invoice.issuerAddress || 'N/I', 60); return (!s || s.length < 2) ? 'N/I' : s.replace(/\s+$/, '') || 'N/I'; })(),
        nro: sanitizeStr(invoice.issuerNumber || 'S/N', 60),
        xBairro: sanitizeStr(invoice.issuerBairro || 'N/I', 60),
        cMun: invoice.issuerCityCode || '5208707',
        xMun: sanitizeStr(invoice.issuerCity || 'Goiania', 60),
        UF: uf,
        CEP: issuerCep,
        cPais: '1058',
        xPais: 'BRASIL',
        ...(invoice.issuerPhone ? { fone: onlyDigits(invoice.issuerPhone).slice(0, 14) } : {}),
      },
      IE: onlyDigits(invoice.issuerIe || ''),
      CRT: crt,
    },
    ...(dest ? { dest } : {}),
    det_list: detList,
    total: {
      ICMSTot: {
        vBC: sumVbcIcms.toFixed(2),
        vICMS: sumVicms.toFixed(2),
        vICMSDeson: sumVicmsDeson.toFixed(2),
        vFCPUFDest: '0.00',
        vICMSUFDest: '0.00',
        vICMSUFRemet: '0.00',
        vFCP: '0.00',
        vBCST: '0.00',
        vST: '0.00',
        vFCPST: '0.00',
        vFCPSTRet: '0.00',
        vProd: totalProducts.toFixed(2),
        vFrete: totalFreight.toFixed(2),
        vSeg: totalInsurance.toFixed(2),
        vDesc: totalDiscount.toFixed(2),
        vII: '0.00',
        vIPI: totalIpi.toFixed(2),
        vIPIDevol: '0.00',
        vPIS: (sumVPis > 0 ? sumVPis : totalPis).toFixed(2),
        vCOFINS: (sumVCofins > 0 ? sumVCofins : totalCofins).toFixed(2),
        vOutro: totalOther.toFixed(2),
        vNF: totalInvoice.toFixed(2),
      },
    },
    transp: {
      modFrete: '9',
    },
    ...(!isNFCe ? (() => {
      const pm = String(invoice.paymentMethod || 'a_prazo').trim().toLowerCase();
      const isAVista = pm === 'a_vista' || pm === 'dinheiro' || pm === 'pix' || pm === 'cartao_debito' || pm === 'debit_card';
      if (isAVista || pm === 'sem_pagamento') return {};
      const dVencDate = (() => {
        let d = invoice.dueDate ? new Date(invoice.dueDate) : null;
        if (!d || d.getTime() <= emissionDate.getTime()) {
          d = new Date(emissionDate);
          d.setDate(d.getDate() + 30);
        }
        return d;
      })();
      const dVencStr = `${dVencDate.getFullYear()}-${String(dVencDate.getMonth() + 1).padStart(2, '0')}-${String(dVencDate.getDate()).padStart(2, '0')}`;
      return {
        cobr: {
          fat: {
            nFat: String(invoice.invoiceNumber || '1'),
            vOrig: (totalInvoice + totalDiscount).toFixed(2),
            vDesc: totalDiscount.toFixed(2),
            vLiq: totalInvoice.toFixed(2),
          },
          dup: [
            {
              nDup: '001',
              dVenc: dVencStr,
              vDup: totalInvoice.toFixed(2),
            },
          ],
        },
      };
    })() : {}),
    pag: {
      detPag: [
        {
          ...(!isNFCe ? {
            indPag: (() => {
              const pm = String(invoice.paymentMethod || 'a_prazo').trim().toLowerCase();
              if (pm === 'sem_pagamento') return '0';
              if (pm === 'a_vista' || pm === 'dinheiro' || pm === 'pix' || pm === 'cartao_debito' || pm === 'debit_card') return '0';
              return '1';
            })(),
          } : {}),
          tPag: (() => {
            const pm = String(invoice.paymentMethod || 'a_prazo').trim().toLowerCase();
            if (pm === 'sem_pagamento') return '90';
            if (pm === 'a_vista' || pm === 'dinheiro') return '01';
            if (pm === 'pix') return '17';
            // Aceita variantes em inglês/PT do hotsite ('card') e do legado.
            if (pm === 'cartao' || pm === 'cartao_credito' || pm === 'card' || pm === 'credit_card') return '03';
            if (pm === 'cartao_debito' || pm === 'debit_card') return '04';
            if (pm === 'boleto' || pm === 'a_prazo') return '15';
            if (pm === 'transferencia' || pm === 'deposito' || pm === 'transfer') return '18';
            if (pm === 'cheque') return '02';
            return '99';
          })(),
          vPag: (() => {
            const pm = String(invoice.paymentMethod || 'a_prazo').trim().toLowerCase();
            if (pm === 'sem_pagamento') return '0.00';
            return totalInvoice.toFixed(2);
          })(),
          // SEFAZ exige <xPag> quando tPag=99 (Outros). Inclui descrição
          // sanitizada do método informado para evitar rejeição 441.
          ...((() => {
            const pm = String(invoice.paymentMethod || 'a_prazo').trim().toLowerCase();
            const isOther = !['sem_pagamento','a_vista','dinheiro','pix','cartao','cartao_credito','card','credit_card','cartao_debito','debit_card','boleto','a_prazo','transferencia','deposito','transfer','cheque'].includes(pm);
            return isOther ? { xPag: sanitizeStr(String(pm).slice(0, 60), 60) } : {};
          })()),
        },
      ],
      ...(isNFCe ? { vTroco: '0.00' } : {}),
    },
    ...((() => {
      const parts: string[] = [];
      if (invoice.notes) parts.push(String(invoice.notes).trim());
      if (usedRcteRedBc) {
        const rcteTxt = 'Reducao de base de calculo conforme: Artigo 8o, inciso VIII, do Anexo IX do RCTE/GO';
        if (!parts.some(p => p.toLowerCase().includes('rcte'))) parts.push(rcteTxt);
      }
      // Legenda do Simples Nacional. Quando a nota concede crédito de ICMS
      // (CSOSN 101), informa o valor e a alíquota para aproveitamento pelo
      // destinatário, nos termos do art. 23 da LC 123/2006.
      if (crt === '1' || crt === '2') {
        const fmtBR = (n: number, d: number) => n.toFixed(d).replace('.', ',');
        let snTxt = 'Documento emitido por ME ou EPP optante pelo Simples Nacional. Nao gera direito a credito fiscal de IPI.';
        if (sumVCredSN > 0 && snCredAliqUsed > 0) {
          snTxt += ` Permite o aproveitamento de credito do ICMS de R$ ${fmtBR(sumVCredSN, 2)} conforme aliquota do Simples Nacional de ${fmtBR(snCredAliqUsed, 2)}%, nos termos do art. 23 da LC 123.`;
        }
        if (!parts.some(p => p.toLowerCase().includes('simples nacional'))) parts.push(snTxt);
      }
      const cpl = parts.filter(Boolean).join(' | ').trim();
      return cpl ? { infAdic: { infCpl: sanitizeStr(cpl, 500), obsCont: [], obsFisco: [], procRef: [] } } : {};
    })()),
  };

  return { documento, cNF, cUF, modelo };
}

// ─── Determine CRT for issuer CNPJ ────────────────────────────────────────────
export function crtForCnpj(cnpj: string): string {
  const clean = onlyDigits(cnpj);
  const CRT_MAP: Record<string, string> = {
    '28295493000315': '1', // BSB - Simples Nacional
    '28295493000234': '1', // GYN - Simples Nacional
    '28295493000153': '1', // IND - Simples Nacional
    '52921727000105': '3', // SERV (PURO SERVICOS) - Regime Normal (Lucro Presumido)
  };
  return CRT_MAP[clean] || '1';
}

// CNPJs cujo regime PIS/COFINS é CUMULATIVO (Lucro Presumido):
// PIS 0,65% e COFINS 3,00%. Não-cumulativo (Lucro Real) = 1,65% / 7,60%.
// CRT 3 (Regime Normal) abrange tanto Lucro Real quanto Presumido — o CRT
// sozinho não diferencia, então mapeamos por CNPJ.
const LUCRO_PRESUMIDO_CNPJS = new Set<string>([
  '52921727000105', // PURO SERVICOS E CONSULTORIA EMPRESARIAL LTDA
]);
function isLucroPresumido(cnpj: string | null | undefined): boolean {
  return LUCRO_PRESUMIDO_CNPJS.has(onlyDigits(cnpj || ''));
}
export function defaultPisCofinsRates(issuerCnpj: string | null | undefined): { pis: string; cofins: string } {
  return isLucroPresumido(issuerCnpj)
    ? { pis: '0.65', cofins: '3' }       // Cumulativo (Lucro Presumido)
    : { pis: '1.65', cofins: '7.6' };    // Não-cumulativo (Lucro Real)
}

// ─── SefazService ─────────────────────────────────────────────────────────────
export class SefazService {

  async checkServiceStatus(
    uf: string = 'GO',
    environment: 'homologacao' | 'producao' = 'producao',
    certificateId?: string,
  ): Promise<StatusResult> {
    try {
      const cUF = UF_CODES[uf] || '52';
      const ambiente = SEFAZ_AMBIENTE[environment];

      let certData: { pem: string; key: string; password: string } | null = null;
      if (certificateId) {
        certData = await loadCertFromStorage(certificateId);
      }

      if (!certData) {
        if (environment === 'producao') {
          return {
            success: false,
            errorCode: 'NO_CERTIFICATE',
            errorMessage: 'Certificado digital necessário para consultar status em produção.',
          };
        }
        return {
          success: true,
          status: 'online',
          description: `SEFAZ ${environment} UF ${uf} — status não verificado (sem certificado carregado)`,
        };
      }

      const configuracoes = {
        empresa: {
          pem: certData.pem,
          key: certData.key,
          password: certData.password,
        },
        geral: {
          versao: '4.00',
          ambiente,
          modelo: '55',
        },
      };

      console.log(`[SEFAZ] Consultando status - UF: ${uf}, Ambiente: ${environment}`);
      const result = await statusServico(configuracoes as any, cUF);
      console.log(`[SEFAZ] Status: ${result.status} - ${result.mensagem}`);

      return {
        success: result.status === '107',
        status: result.status,
        description: result.mensagem,
      };
    } catch (error: any) {
      console.error('[SEFAZ] Erro ao consultar status:', error.message);
      return {
        success: false,
        errorCode: 'SEFAZ_STATUS_ERROR',
        errorMessage: error.message || 'Erro ao consultar status SEFAZ',
      };
    }
  }

  private static _emitLocks: Map<string, Promise<EmitNfeResult>> = new Map();

  async emitNfe(invoiceId: string): Promise<EmitNfeResult> {
    // Anti-concorrência: se já existe uma emissão em andamento para este invoiceId,
    // aguarda e retorna o resultado dela em vez de iniciar uma nova (que geraria
    // novo cNF e cairia em rejeição 539 - Duplicidade).
    const existing = SefazService._emitLocks.get(invoiceId);
    if (existing) {
      console.warn(`[SEFAZ] 🔒 Emissão já em andamento para ${invoiceId} — aguardando resultado`);
      return existing;
    }
    const promise = this._doEmitNfe(invoiceId).finally(() => {
      SefazService._emitLocks.delete(invoiceId);
    });
    SefazService._emitLocks.set(invoiceId, promise);
    return promise;
  }

  private async _doEmitNfe(invoiceId: string): Promise<EmitNfeResult> {
    try {
      let invoice = await storage.getFiscalInvoice(invoiceId);
      if (!invoice) {
        return { success: false, errorCode: 'NOT_FOUND', errorMessage: 'Nota fiscal não encontrada' };
      }

      if (invoice.status !== 'draft' && invoice.status !== 'rejected') {
        return {
          success: false,
          errorCode: 'INVALID_STATUS',
          errorMessage: `NF-e com status '${invoice.status}' não pode ser emitida`,
        };
      }

      const items = await storage.getFiscalInvoiceItems(invoiceId);
      if (!items || items.length === 0) {
        return { success: false, errorCode: 'NO_ITEMS', errorMessage: 'Nota fiscal não possui itens' };
      }

      const scenario = invoice.fiscalScenarioId
        ? await storage.getFiscalScenario(invoice.fiscalScenarioId)
        : null;

      const environment = (invoice.environment || 'producao') as 'homologacao' | 'producao';
      const ambiente = SEFAZ_AMBIENTE[environment];
      let issuerCnpj = onlyDigits(invoice.issuerCnpj || '');

      // CNPJ alias rewrite: corrige NFs em rascunho que foram criadas com CNPJ
      // antigo/errado do emitente antes de o cadastro ter sido normalizado.
      // Sem isso, "Retentar" mantém o CNPJ errado gravado, não acha
      // certificado e a NF nunca emite. Aplica também ao registro persistido
      // para que próximas tentativas usem o CNPJ correto.
      const CNPJ_ALIAS_MAP: Record<string, string> = {
        '52521727000195': '52921727000105', // PURO SERVICOS — CNPJ antigo (typo) → CNPJ real do cartão CNPJ/certificado
      };
      const aliasTarget = CNPJ_ALIAS_MAP[issuerCnpj];
      if (aliasTarget) {
        console.log(`[SEFAZ] 🔧 issuerCnpj ${issuerCnpj} reescrito para ${aliasTarget} (alias) — NF ${invoice.invoiceNumber}`);
        try {
          await storage.updateFiscalInvoice(invoiceId, { issuerCnpj: aliasTarget } as any);
          invoice = await storage.getFiscalInvoice(invoiceId) || invoice;
        } catch (_e) { /* noop — segue mesmo se update falhar */ }
        issuerCnpj = aliasTarget;
      }

      const crt = crtForCnpj(issuerCnpj);

      // ── Carrega certificado ────────────────────────────────────────────────
      let certData: { pem: string; key: string; password: string } | null = null;

      const certId =
        invoice.certificateId ||
        (await findCertificateForCnpj(issuerCnpj));

      if (certId) {
        certData = await loadCertFromStorage(certId);
      }

      if (!certData) {
        const issuerCnpjClean = onlyDigits(issuerCnpj || '');
        const issuerCnpjFormatted = issuerCnpjClean.length === 14
          ? `${issuerCnpjClean.slice(0,2)}.${issuerCnpjClean.slice(2,5)}.${issuerCnpjClean.slice(5,8)}/${issuerCnpjClean.slice(8,12)}-${issuerCnpjClean.slice(12)}`
          : (issuerCnpj || 'desconhecido');
        const issuerLabel = invoice.issuerName ? ` (${invoice.issuerName})` : '';
        return {
          success: false,
          errorCode: 'NO_CERTIFICATE',
          errorMessage:
            `Não há certificado digital A1 cadastrado para o CNPJ emitente ${issuerCnpjFormatted}${issuerLabel}. ` +
            `Acesse Notas Fiscais > Certificados Digitais e faça upload de um certificado A1 (.pfx/.p12) válido para esse CNPJ.`,
        };
      }

      // ── Validação: cliente deve ter CNPJ ou CPF VÁLIDO para NF-e modelo 55 ─────
      // Validamos os dígitos verificadores (não só o comprimento): um documento com
      // 14 dígitos mas DV errado passava na checagem antiga e era rejeitado pela
      // SEFAZ. Aqui, se o documento do espelho for inválido, tentamos auto-corrigir a
      // partir do cadastro (fonte de verdade) e, por último, de active_customers —
      // sempre exigindo que o documento seja VÁLIDO antes de usar/gravar.
      let custDocCheck = onlyDigits(invoice.customerCnpjCpf || '');
      const invoiceModel = (invoice as any).invoiceModel || '55';
      if (invoiceModel === '55' && !isValidFiscalDoc(custDocCheck)) {
        if (invoice.customerId) {
          try {
            const customer = await storage.getCustomer(invoice.customerId);
            let freshDoc = '';
            if (customer) {
              freshDoc = onlyDigits((customer as any).cnpj || (customer as any).cpf || '');
              if (isValidFiscalDoc(freshDoc)) {
                console.log(`[SEFAZ] 🔧 Auto-preenchendo CNPJ/CPF da NF-e #${invoice.invoiceNumber} a partir do cadastro: ${freshDoc}`);
                const custUf = ((customer as any).state || invoice.issuerUf || 'GO').toUpperCase();
                const custCep = onlyDigits((customer as any).zipCode || (customer as any).zip_code || '') || '00000000';
                const { Pool } = await import('@neondatabase/serverless');
                const pool = new Pool({ connectionString: process.env.DATABASE_URL });
                await pool.query(
                  `UPDATE fiscal_invoices SET
                    customer_cnpj_cpf = $1, customer_uf = COALESCE(NULLIF(customer_uf,''), $2),
                    customer_cep = COALESCE(NULLIF(customer_cep,'00000000'), $3),
                    customer_city = COALESCE(NULLIF(customer_city,''), $4),
                    customer_bairro = COALESCE(NULLIF(customer_bairro,''), $5),
                    customer_address = COALESCE(NULLIF(customer_address,''), $6),
                    customer_address_number = COALESCE(NULLIF(customer_address_number,''), $7),
                    customer_ie = COALESCE(NULLIF(customer_ie,''), $8)
                   WHERE id = $9`,
                  [freshDoc, custUf, custCep, (customer as any).city || '', (customer as any).neighborhood || '',
                   (customer as any).address || '', (customer as any).addressNumber || (customer as any).address_number || 'S/N',
                   (customer as any).stateRegistration || (customer as any).state_registration || '', invoiceId]
                );
                await pool.end();
                invoice = await storage.getFiscalInvoice(invoiceId);
                if (!invoice) throw new Error('NF-e não encontrada após atualização');
                custDocCheck = freshDoc;
              }
            }
            if (!isValidFiscalDoc(freshDoc)) {
              const { Pool } = await import('@neondatabase/serverless');
              const pool2 = new Pool({ connectionString: process.env.DATABASE_URL });
              const acResult = await pool2.query(
                `SELECT document, document_type FROM active_customers WHERE customer_id = $1 AND document IS NOT NULL AND document != '' LIMIT 1`,
                [invoice.customerId]
              );
              if (acResult.rows.length > 0) {
                const acDoc = onlyDigits(acResult.rows[0].document || '');
                // active_customers vem de importação de planilha e já trouxe CNPJ
                // com dígito trocado. Só usamos/gravamos se o documento for VÁLIDO.
                if (isValidFiscalDoc(acDoc)) {
                  freshDoc = acDoc;
                  console.log(`[SEFAZ] 🔧 CNPJ/CPF válido obtido de active_customers para NF-e #${invoice.invoiceNumber}: ${freshDoc}`);
                  const custUf = (invoice.issuerUf || 'GO').toUpperCase();
                  await pool2.query(
                    `UPDATE fiscal_invoices SET customer_cnpj_cpf = $1, customer_uf = COALESCE(NULLIF(customer_uf,''), $2) WHERE id = $3`,
                    [freshDoc, custUf, invoiceId]
                  );
                  const isDocCnpj = freshDoc.length === 14;
                  await pool2.query(
                    `UPDATE customers SET ${isDocCnpj ? 'cnpj' : 'cpf'} = $1 WHERE id = $2 AND (${isDocCnpj ? 'cnpj' : 'cpf'} IS NULL OR ${isDocCnpj ? 'cnpj' : 'cpf'} = '')`,
                    [freshDoc, invoice.customerId]
                  );
                  invoice = await storage.getFiscalInvoice(invoiceId);
                  if (!invoice) throw new Error('NF-e não encontrada após atualização');
                  custDocCheck = freshDoc;
                } else if (acDoc) {
                  console.warn(`[SEFAZ] ⚠️ Documento de active_customers inválido (DV) ignorado para NF-e #${invoice.invoiceNumber}: ${acDoc}`);
                }
              }
              await pool2.end();
            }
          } catch (autoFixErr: any) {
            console.error(`[SEFAZ] ❌ Erro ao auto-preencher dados do cliente:`, autoFixErr.message);
          }
        }
        if (!isValidFiscalDoc(custDocCheck)) {
          console.log(`[SEFAZ] ❌ Cliente "${invoice.customerName}" sem CNPJ/CPF válido para NF-e`);
          return {
            success: false,
            errorCode: 'MISSING_CUSTOMER_DOC',
            errorMessage: `Cliente "${invoice.customerName}" não possui CNPJ/CPF válido cadastrado (verifique os dígitos). Corrija o cadastro do cliente antes de emitir a NF-e.`,
          };
        }
      }

      // ── REVISITA o cadastro do cliente e RECALCULA o CFOP (toda tentativa) ──
      // Caso "Casa de Marias" (NF 104152, 10/jul/2026): a NF nasceu com CFOP
      // 6102 porque o cliente estava SEM UF no cadastro; corrigida a UF (DF),
      // o Retentar continuava emitindo com o CFOP interestadual GRAVADO na
      // NF/itens → SEFAZ cStat 772 (idDest=2 com UF destino == UF origem).
      // Regra do negócio: a CADA emissão/retentativa o CADASTRO do cliente é a
      // fonte de verdade — refresca a UF do destinatário e ajusta a DIREÇÃO do
      // CFOP (5xxx interno / 6xxx interestadual; par ST 5405↔6404), persistindo
      // na NF e nos itens. Nunca muda a natureza (venda/bonif/troca/amostra).
      // NFC-e (modelo 65) é sempre operação interna — não precisa.
      try {
        if (invoiceModel === '55') {
          let freshCust: any = null;
          if (invoice.customerId) {
            try { freshCust = await storage.getCustomer(invoice.customerId); } catch { /* segue com dados da NF */ }
          }
          const custUfCad = normalizeUf(freshCust?.state) || ufFromCep(onlyDigits(String(freshCust?.zipCode || freshCust?.zip_code || '')));
          const destUfNow = custUfCad || normalizeUf(invoice.customerUf) || ufFromCep(invoice.customerCep);
          if (destUfNow) {
            const issuerUfNow = (invoice.issuerUf || 'GO').toUpperCase();
            const isInterNow = destUfNow !== issuerUfNow;
            const invUpd: Record<string, any> = {};
            if (custUfCad && normalizeUf(invoice.customerUf) !== custUfCad) invUpd.customerUf = custUfCad;
            const oldInvCfop = invoice.cfop || null;
            const newInvCfop = cfopForOperation(invoice.cfop, isInterNow);
            if (newInvCfop) invUpd.cfop = newInvCfop;
            const itemFixes: Array<{ id: string; from: string; to: string }> = [];
            for (const it of items) {
              const to = cfopForOperation((it as any).cfop, isInterNow);
              if (to) itemFixes.push({ id: (it as any).id, from: String((it as any).cfop || ''), to });
            }
            if (Object.keys(invUpd).length > 0 || itemFixes.length > 0) {
              if (Object.keys(invUpd).length > 0) {
                await storage.updateFiscalInvoice(invoiceId, invUpd as any);
              }
              for (const f of itemFixes) {
                await storage.updateFiscalInvoiceItem(f.id, { cfop: f.to } as any);
              }
              const cfopMsg = newInvCfop
                ? `CFOP ${oldInvCfop || 'N/D'} → ${newInvCfop}`
                : (itemFixes.length > 0 ? `CFOP itens ${itemFixes[0].from} → ${itemFixes[0].to}` : `UF destinatário → ${destUfNow}`);
              console.log(`[SEFAZ] 🔁 Cadastro do cliente revisitado p/ NF-e #${invoice.invoiceNumber}: UF destino=${destUfNow} (emitente ${issuerUfNow}, operação ${isInterNow ? 'INTERESTADUAL' : 'INTERNA'}) — ${cfopMsg}; ${itemFixes.length} item(ns) ajustado(s)`);
              try {
                await storage.createFiscalInvoiceEvent({
                  invoiceId,
                  eventType: 'correcao',
                  status: 'success',
                  description: `CFOP recalculado a partir do cadastro do cliente (UF ${destUfNow}; operação ${isInterNow ? 'interestadual' : 'interna'}): ${cfopMsg}${itemFixes.length ? ` | ${itemFixes.length} item(ns) ajustado(s)` : ''}`,
                  createdBy: invoice.createdBy || undefined,
                });
              } catch { /* evento é cosmético */ }
              // Recarrega NF e itens já corrigidos p/ montar o XML
              invoice = (await storage.getFiscalInvoice(invoiceId)) || invoice;
              const reloadedItems = await storage.getFiscalInvoiceItems(invoiceId);
              if (reloadedItems && reloadedItems.length > 0) {
                items.length = 0;
                items.push(...reloadedItems);
              }
            }
          }
        }
      } catch (cfopErr: any) {
        console.warn(`[SEFAZ] ⚠️ Falha ao recalcular CFOP a partir do cadastro (segue com os dados da NF): ${cfopErr.message}`);
      }

      // ── Monta documento ───────────────────────────────────────────────────
      let allScenarios: any[] = [];
      try { allScenarios = await storage.getFiscalScenarios(); } catch (e) { /* ignore */ }
      // Alíquota do Simples Nacional usada para conceder crédito de ICMS
      // (CSOSN 101) no rodapé da NF-e. Configurável em Cenários Fiscais.
      let snCreditAliq = SN_CREDIT_ALIQ_DEFAULT;
      try {
        const row = await storage.getSystemSetting(SN_CREDIT_ALIQ_KEY);
        if (row?.value != null && row.value !== '') {
          const parsed = parseFloat(String(row.value).replace(',', '.'));
          if (!isNaN(parsed) && parsed >= 0) snCreditAliq = parsed;
        }
      } catch (e) { /* usa default */ }
      const { documento, cNF, cUF, modelo } = buildDocumento(invoice, items, scenario, ambiente, crt, allScenarios, snCreditAliq);
      const isNFCe = modelo === '65';

      // ── Persiste valores de impostos calculados nos itens e na nota ───────
      // Garante que a DANFE e relatórios futuros leiam vBC/vICMS/vPIS/vCOFINS
      // calculados em tempo de emissão (CRT 3 / CST 20 com redução de BC etc.)
      try {
        const detList: any[] = (documento as any)?.det_list || [];
        let totBaseIcms = 0, totVicms = 0, totVPis = 0, totVCofins = 0;
        for (let i = 0; i < detList.length && i < items.length; i++) {
          const det = detList[i];
          const icms = det?.imposto?.ICMS || {};
          const icmsObj = icms.ICMS00 || icms.ICMS10 || icms.ICMS20 || icms.ICMS30 || icms.ICMS40 || icms.ICMS51 || icms.ICMS60 || icms.ICMS70 || icms.ICMS90 || icms.ICMSSN101 || icms.ICMSSN102 || icms.ICMSSN201 || icms.ICMSSN202 || icms.ICMSSN500 || icms.ICMSSN900 || {};
          const pis = det?.imposto?.PIS?.PISAliq || det?.imposto?.PIS?.PISOutr || {};
          const cofins = det?.imposto?.COFINS?.COFINSAliq || det?.imposto?.COFINS?.COFINSOutr || {};
          const vBC = parseFloat(icmsObj.vBC || '0');
          const vICMS = parseFloat(icmsObj.vICMS || '0');
          const pICMS = parseFloat(icmsObj.pICMS || '0');
          const vBCPis = parseFloat(pis.vBC || '0');
          const pPIS = parseFloat(pis.pPIS || '0');
          const vPIS = parseFloat(pis.vPIS || '0');
          const vBCCofins = parseFloat(cofins.vBC || '0');
          const pCOFINS = parseFloat(cofins.pCOFINS || '0');
          const vCOFINS = parseFloat(cofins.vCOFINS || '0');
          totBaseIcms += vBC; totVicms += vICMS; totVPis += vPIS; totVCofins += vCOFINS;
          try {
            await storage.updateFiscalInvoiceItem(items[i].id, {
              baseIcms: vBC.toFixed(2),
              aliqIcms: pICMS.toFixed(2),
              valorIcms: vICMS.toFixed(2),
              basePis: vBCPis.toFixed(2),
              aliqPis: pPIS.toFixed(4),
              valorPis: vPIS.toFixed(2),
              baseCofins: vBCCofins.toFixed(2),
              aliqCofins: pCOFINS.toFixed(4),
              valorCofins: vCOFINS.toFixed(2),
              cstIcms: icmsObj.CST || icmsObj.CSOSN || items[i].cstIcms || null,
            } as any);
          } catch (itemErr: any) {
            console.warn(`[SEFAZ] ⚠️ Falha ao persistir impostos do item ${items[i].id}: ${itemErr.message}`);
          }
        }
        try {
          await storage.updateFiscalInvoice(invoiceId, {
            totalBaseIcms: totBaseIcms.toFixed(2),
            totalIcms: totVicms.toFixed(2),
            totalPis: totVPis.toFixed(2),
            totalCofins: totVCofins.toFixed(2),
            // Espelha na nota o infCpl exatamente como vai no XML (notas +
            // legendas legais, incl. crédito de ICMS do Simples Nacional art. 23
            // LC 123) para a DANFE imprimir o mesmo texto enviado à SEFAZ.
            infCpl: (documento as any)?.infAdic?.infCpl || null,
          } as any);
        } catch (totErr: any) {
          console.warn(`[SEFAZ] ⚠️ Falha ao persistir totais de impostos da NF-e ${invoiceId}: ${totErr.message}`);
        }
      } catch (persistErr: any) {
        console.warn(`[SEFAZ] ⚠️ Falha ao persistir impostos calculados: ${persistErr.message}`);
      }

      const configuracoes: Record<string, any> = {
        empresa: {
          pem: certData.pem,
          key: certData.key,
          password: certData.password,
          ...(isNFCe && certData.idCsc ? { idCSC: certData.idCsc } : {}),
          ...(isNFCe && certData.csc ? { CSC: certData.csc } : {}),
        },
        geral: {
          versao: '4.00',
          ambiente,
          modelo,
        },
      };

      if (isNFCe) {
        console.log(`[SEFAZ] Emitindo NFC-e (modelo 65) para ${invoiceId}`);
        if (!certData.csc || !certData.idCsc) {
          return {
            success: false,
            errorCode: 'MISSING_CSC',
            errorMessage: 'CSC e ID do CSC são obrigatórios para emissão de NFC-e (modelo 65). Acesse Notas Fiscais > Certificados Digitais e configure o CSC e ID CSC no certificado deste CNPJ.',
          };
        }
      }

      // Pre-compute the access key from known invoice fields + cNF
      // This gives us a reliable fallback if the library doesn't return the key
      const emissionDateForKey = invoice.emissionDate ? new Date(invoice.emissionDate) : new Date();
      const preComputedKey = computeNFeAccessKey({
        cUF,
        emissionDate: emissionDateForKey,
        cnpj: issuerCnpj,
        serie: invoice.series || '1',
        nNF: invoice.invoiceNumber || '1',
        tpEmis: '1',
        cNF,
        modelo,
      });
      console.log(`[SEFAZ] Chave pré-computada: ${preComputedKey}`);
      console.log(`[SEFAZ] paymentMethod no invoice: "${invoice.paymentMethod}"`);
      console.log(`[SEFAZ] documento.cobr presente: ${!!documento.cobr}`);
      console.log(`[SEFAZ] documento.cobr: ${JSON.stringify(documento.cobr || null)}`);
      console.log(`[SEFAZ] documento.pag: ${JSON.stringify(documento.pag)}`);

      const logDesc = `Emissão NF-e iniciada — Ambiente: ${environment} | CNPJ: ${issuerCnpj}`;
      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'emissao',
        status: 'processing',
        description: logDesc,
        createdBy: invoice.createdBy || undefined,
      });

      console.log(`[SEFAZ] Emitindo NF-e ${invoiceId} em ${environment}...`);

      // ── Emite via node-nfe-nfce ───────────────────────────────────────────
      const result = await emitir({ documento, configuracoes } as any);

      const xmlEnvioRaw: string = result?.xml_enviado || '';
      const xmlRetornoRaw: string = result?.xml_recebido || '';
      const xmlCompletoRaw: string = result?.xml_completo || '';

      const diagSizes = `env:${xmlEnvioRaw.length} rec:${xmlRetornoRaw.length} comp:${xmlCompletoRaw.length}`;
      console.log(`[SEFAZ] Resultado emissão: success=${result?.success}, mensagem=${result?.mensagem}`);
      console.log(`[SEFAZ] Tamanhos XML – ${diagSizes}`);
      console.log(`[SEFAZ] protNFe direto:`, JSON.stringify(result?.nfeProc?.protNFe?.infProt || 'AUSENTE'));
      console.log(`[SEFAZ] nfeProc keys:`, Object.keys(result?.nfeProc || {}));
      console.log(`[SEFAZ] protNFe type:`, typeof result?.nfeProc?.protNFe, 'isArray:', Array.isArray(result?.nfeProc?.protNFe));
      const cobrMatch = xmlEnvioRaw.match(/<cobr>[\s\S]*?<\/cobr>/);
      const pagMatch = xmlEnvioRaw.match(/<pag>[\s\S]*?<\/pag>/);
      const indPagMatch = xmlEnvioRaw.match(/<indPag>[\s\S]*?<\/indPag>/g);
      console.log(`[SEFAZ] XML <cobr> section: ${cobrMatch ? cobrMatch[0] : 'AUSENTE'}`);
      console.log(`[SEFAZ] XML <pag> section: ${pagMatch ? pagMatch[0] : 'AUSENTE'}`);
      console.log(`[SEFAZ] XML all <indPag> tags: ${JSON.stringify(indPagMatch)}`);
      console.log(`[SEFAZ] xml_enviado[0..300]: ${xmlEnvioRaw.substring(0, 300)}`);
      console.log(`[SEFAZ] xml_recebido[0..300]: ${xmlRetornoRaw.substring(0, 300)}`);
      console.log(`[SEFAZ] xml_completo[0..300]: ${xmlCompletoRaw.substring(0, 300)}`);

      if (result?.success) {
        const xmlEnvio: string = xmlEnvioRaw;
        const xmlRetorno: string = xmlRetornoRaw;
        let xmlCompleto: string = xmlCompletoRaw;

        if (!xmlCompleto && xmlEnvio && xmlRetorno) {
          const nfeMatch = xmlEnvio.match(/<NFe\b[\s\S]*<\/NFe>/);
          const protMatch = xmlRetorno.match(/<protNFe\b[\s\S]*<\/protNFe>/);
          if (nfeMatch && protMatch) {
            xmlCompleto = `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">${nfeMatch[0]}${protMatch[0]}</nfeProc>`;
            console.log(`[SEFAZ] xml_completo estava vazio — construído nfeProc (${xmlCompleto.length} chars)`);
          }
        }

        // ── Extrair chave de acesso e protocolo ──────────────────────────────
        // Helper: extrai 44 dígitos de uma string usando vários padrões
        function extract44(src: string): string {
          if (!src) return '';
          // padrão exato com tag chNFe (com ou sem prefixo de namespace)
          let m = src.match(/<[a-zA-Z0-9_:]*chNFe>(\d{44})<\/[a-zA-Z0-9_:]*chNFe>/);
          if (m) return m[1];
          // atributo Id="NFe{44}" – aspas duplas ou simples
          m = src.match(/Id\s*=\s*["']NFe(\d{44})["']/i);
          if (m) return m[1];
          // atributo Id="ID{44}" (infProt assinado)
          m = src.match(/Id\s*=\s*["']ID(\d{44})["']/i);
          if (m) return m[1];
          // qualquer sequência exata de 44 dígitos delimitada por não-dígito
          m = src.match(/(?<!\d)(\d{44})(?!\d)/);
          if (m) return m[1];
          return '';
        }

        function extractNProt(src: string): string {
          if (!src) return '';
          const m = src.match(/<[a-zA-Z0-9_:]*nProt>(\d+)<\/[a-zA-Z0-9_:]*nProt>/);
          return m ? m[1] : '';
        }

        // Estratégia 1: objeto direto nfeProc.protNFe.infProt (mais rápida)
        let accessKey: string = String(result.nfeProc?.protNFe?.infProt?.chNFe || '').replace(/\D/g, '').slice(0, 44);
        let protocolNumber: string = String(result.nfeProc?.protNFe?.infProt?.nProt || '');
        console.log(`[SEFAZ][E1] chNFe=${accessKey || 'VAZIO'}`);

        // Estratégia 2: protNFe como array
        if (!accessKey && Array.isArray(result.nfeProc?.protNFe)) {
          const pn = result.nfeProc.protNFe[0];
          accessKey = String(pn?.infProt?.chNFe || '').replace(/\D/g, '').slice(0, 44);
          if (!protocolNumber) protocolNumber = String(pn?.infProt?.nProt || '');
          console.log(`[SEFAZ][E2] chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 3: infProt pode ser array mesmo sem protNFe array
        if (!accessKey) {
          const pn = result.nfeProc?.protNFe;
          const ip = Array.isArray(pn?.infProt) ? pn.infProt[0] : pn?.infProt;
          if (ip?.chNFe) {
            accessKey = String(Array.isArray(ip.chNFe) ? ip.chNFe[0] : ip.chNFe).replace(/\D/g, '').slice(0, 44);
            if (!protocolNumber && ip.nProt) protocolNumber = String(Array.isArray(ip.nProt) ? ip.nProt[0] : ip.nProt);
          }
          console.log(`[SEFAZ][E3] chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 4: atributo Id no nfeProc.NFe.infNFe
        if (!accessKey) {
          const nfeId: string = result.nfeProc?.NFe?.infNFe?.$?.Id || '';
          if (nfeId.startsWith('NFe') && nfeId.length === 47) accessKey = nfeId.substring(3);
          else if (/^\d{44}$/.test(nfeId)) accessKey = nfeId;
          console.log(`[SEFAZ][E4] nfeId=${nfeId || 'VAZIO'} → chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 5: XML completo (nfeProc serializado pela lib)
        if (!accessKey) {
          accessKey = extract44(xmlCompleto);
          if (!protocolNumber) protocolNumber = extractNProt(xmlCompleto);
          console.log(`[SEFAZ][E5] xmlCompleto → chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 6: XML retornado pelo SEFAZ (SOAP com envelope)
        if (!accessKey) {
          accessKey = extract44(xmlRetorno);
          if (!protocolNumber) protocolNumber = extractNProt(xmlRetorno);
          console.log(`[SEFAZ][E6] xmlRetorno → chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 7: XML enviado (lote com NF-e assinada, possivelmente em CDATA)
        // O Id="NFe{44}" está sempre presente no XML assinado, mesmo dentro de CDATA
        if (!accessKey) {
          // Tenta padrão Id=..."NFe{44}"... com aspas simples ou duplas
          const m7a = xmlEnvio.match(/Id\s*=\s*["']NFe(\d{44})["']/i);
          if (m7a) accessKey = m7a[1];
          // Fallback: Id= sem aspas (improvável mas possível)
          if (!accessKey) {
            const m7b = xmlEnvio.match(/Id=NFe(\d{44})/i);
            if (m7b) accessKey = m7b[1];
          }
          // Fallback: busca genérica de 44 dígitos precedidos de "NFe"
          if (!accessKey) {
            const m7c = xmlEnvio.match(/NFe(\d{44})/i);
            if (m7c) accessKey = m7c[1];
          }
          console.log(`[SEFAZ][E7] xmlEnvio(${xmlEnvio.length}) → chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 8: varredura em todos os XMLs concatenados
        if (!accessKey) {
          const xmlAll = [xmlCompleto, xmlRetorno, xmlEnvio].join(' ');
          accessKey = extract44(xmlAll);
          if (!protocolNumber) protocolNumber = extractNProt(xmlAll);
          console.log(`[SEFAZ][E8] xmlAll → chNFe=${accessKey || 'VAZIO'}`);
        }

        // Estratégia 8b: busca direta de NFe{44} no result.nfeProc serializado como JSON
        if (!accessKey) {
          try {
            const nfeProcJson = JSON.stringify(result.nfeProc || {});
            const m8b = nfeProcJson.match(/NFe(\d{44})/i);
            if (m8b) accessKey = m8b[1];
            if (!accessKey) {
              // Busca chNFe diretamente no JSON
              const m8c = nfeProcJson.match(/"chNFe"\s*:\s*"(\d{44})"/);
              if (m8c) accessKey = m8c[1];
            }
            console.log(`[SEFAZ][E8b] nfeProcJson → chNFe=${accessKey || 'VAZIO'}`);
          } catch {}
        }

        // Validate extracted key length
        if (accessKey && accessKey.length !== 44) {
          console.warn(`[SEFAZ] Chave extraída com comprimento inválido (${accessKey.length}): ${accessKey}`);
          accessKey = '';
        }

        // Estratégia 9: usar a chave pré-computada como último recurso
        // ATENÇÃO: a biblioteca gera seu próprio cNF internamente, diferente do nosso cNF.
        // Por isso a chave pré-computada pode ter cNF diferente da chave real.
        // Mas é melhor exibir uma chave (possivelmente errada) do que "N/A".
        if (!accessKey && preComputedKey && preComputedKey.length === 44) {
          accessKey = preComputedKey;
          console.log(`[SEFAZ][E9] Usando chave pré-computada (cNF pode diferir da lib): ${accessKey}`);
        }

        console.log(`[SEFAZ] ── Chave final: ${accessKey || 'NÃO EXTRAÍDA'} | Protocolo: ${protocolNumber || 'VAZIO'} ──`);

        const cStat = String(
          result.nfeProc?.protNFe?.infProt?.cStat ||
          (Array.isArray(result.nfeProc?.protNFe) ? result.nfeProc.protNFe[0]?.infProt?.cStat : '') ||
          ''
        );
        if (!cStat) {
          const cStatXml = xmlRetorno.match(/<[a-zA-Z0-9_:]*cStat>(\d+)<\/[a-zA-Z0-9_:]*cStat>/);
          if (cStatXml) {
            console.log(`[SEFAZ] cStat extraído do XML retorno: ${cStatXml[1]}`);
          }
        }
        console.log(`[SEFAZ] cStat: ${cStat || 'NÃO ENCONTRADO'}`);

        const isReallyAuthorized = !!(protocolNumber && protocolNumber.length >= 10 && accessKey && accessKey.length === 44);
        const isSefazAuthorized = cStat === '100' || cStat === '150';

        const diagInfo = [
          `sizes(${diagSizes})`,
          `E1_chNFe=${String(result.nfeProc?.protNFe?.infProt?.chNFe || 'nil')}`,
          `E1_nProt=${String(result.nfeProc?.protNFe?.infProt?.nProt || 'nil')}`,
          `protNFe_type=${typeof result.nfeProc?.protNFe}`,
          `proto_final=${protocolNumber || 'VAZIO'}`,
          `chave_final=${accessKey || 'VAZIO'}`,
          `cStat=${cStat || 'nil'}`,
          `isReallyAuthorized=${isReallyAuthorized}`,
        ].join(' | ');

        if (!isReallyAuthorized) {
          console.error(`[SEFAZ] ❌ Lib retornou success=true MAS sem protocolo/chave válidos! NF-e NÃO será marcada como autorizada.`);
          console.error(`[SEFAZ] DIAG: ${diagInfo}`);
          console.error(`[SEFAZ] result.mensagem: ${result.mensagem}`);
          console.error(`[SEFAZ] xml_recebido completo: ${xmlRetorno}`);

          const xMotivo = xmlRetorno.match(/<[a-zA-Z0-9_:]*xMotivo>([^<]+)<\/[a-zA-Z0-9_:]*xMotivo>/);
          const errorMsg = xMotivo ? xMotivo[1] : (result.mensagem || 'SEFAZ não autorizou — protocolo ausente');

          await storage.updateFiscalInvoice(invoiceId, {
            status: 'rejected',
            xmlEnvio,
            xmlRetorno,
          });

          await storage.createFiscalInvoiceEvent({
            invoiceId,
            eventType: 'rejeicao',
            status: 'error',
            errorCode: cStat || 'NO_PROTOCOL',
            errorMessage: `Lib retornou success mas sem protocolo SEFAZ: ${errorMsg}`,
            description: `NF-e NÃO autorizada — success=true sem protocolo. DIAG: ${diagInfo}`,
            xmlRequest: JSON.stringify({ protNFe: result.nfeProc?.protNFe, diagSizes }),
            xmlResponse: xmlRetorno,
            createdBy: invoice.createdBy || undefined,
          });

          return {
            success: false,
            errorCode: cStat || 'NO_PROTOCOL',
            errorMessage: `SEFAZ não retornou protocolo de autorização. ${errorMsg}`,
            xmlEnvio,
            xmlRetorno,
          };
        }

        await storage.updateFiscalInvoice(invoiceId, {
          status: 'authorized',
          accessKey,
          protocolNumber,
          xmlEnvio,
          xmlRetorno,
          xmlAutorizacao: xmlCompleto,
          authorizationDate: nowBrazil(),
        });

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'autorizacao',
          status: 'success',
          protocolNumber,
          description: `NF-e autorizada — Protocolo: ${protocolNumber} | Chave: ${accessKey} | cStat: ${cStat} | DIAG: ${diagInfo}`,
          xmlResponse: xmlRetorno,
          xmlRequest: JSON.stringify({ protNFe: result.nfeProc?.protNFe, diagSizes }),
          createdBy: invoice.createdBy || undefined,
        });

        return {
          success: true,
          accessKey,
          protocolNumber,
          xmlEnvio,
          xmlRetorno,
          xmlAutorizado: xmlCompleto,
        };
      } else {
        const errorMsg = result.mensagem || 'Rejeitado pela SEFAZ';
        const errorCode = result.nfeProc?.protNFe?.infProt?.cStat || 'REJECTED';
        const errorCodeStr = String(errorCode);

        // Rejeição 539: Duplicidade de NF-e com diferença na Chave de Acesso.
        // SEFAZ já tem uma NF-e autorizada com este nNF/série/CNPJ, porém a chave
        // que estamos enviando agora difere (cNF diferente). Tentamos extrair a
        // chave autorizada da mensagem da SEFAZ e marcar a NF-e como autorizada.
        const isDup = errorCodeStr === '539' || /Duplicidade de NF-e/i.test(errorMsg);
        if (isDup) {
          const chaveMatch = errorMsg.match(/(\d{44})/) || (result.xml_recebido || '').match(/(\d{44})/);
          const recoveredKey = chaveMatch ? chaveMatch[1] : null;

          // COLISÃO vs REENVIO: se a chave recuperada JÁ pertence a OUTRA nota local, isto NÃO é
          // um reenvio da mesma nota — são duas NF-e diferentes com o mesmo número (colisão). NÃO
          // podemos copiar a chave do outro cliente e marcar como autorizada (falsa autorização).
          // Marcamos rejeitada com mensagem clara para reemitir com um número novo.
          if (recoveredKey) {
            let collisionOwner: any = null;
            try { collisionOwner = await storage.getFiscalInvoiceByAccessKey(recoveredKey); } catch {}
            if (collisionOwner && collisionOwner.id !== invoiceId) {
              console.warn(`[SEFAZ] ⛔ Rejeição 539: chave ${recoveredKey} já pertence à NF-e ${collisionOwner.id} (colisão de número ${invoice.invoiceNumber}). Marcando REJEITADA (sem copiar chave).`);
              await storage.updateFiscalInvoice(invoiceId, { status: 'rejected' });
              await storage.createFiscalInvoiceEvent({
                invoiceId,
                eventType: 'rejeicao_539_colisao',
                status: 'error',
                errorCode: '539',
                errorMessage: errorMsg,
                description: `Colisão de número: a NF-e #${invoice.invoiceNumber} (série ${invoice.series}, CNPJ ${invoice.issuerCnpj}) já foi autorizada na SEFAZ para OUTRA nota (chave ${recoveredKey}). Esta nota NÃO foi autorizada — reemita com um número novo.`,
                xmlRequest: result.xml_enviado,
                xmlResponse: result.xml_recebido,
                createdBy: invoice.createdBy || undefined,
              });
              return {
                success: false,
                errorCode: '539',
                errorMessage: `NF-e #${invoice.invoiceNumber}: número já usado por outra nota (colisão). Reemita com um número novo.`,
                xmlEnvio: result.xml_enviado,
                xmlRetorno: result.xml_recebido,
              };
            }

            console.warn(`[SEFAZ] ⚠️ Rejeição 539 detectada. Recuperando chave autorizada da SEFAZ: ${recoveredKey}`);
            await storage.updateFiscalInvoice(invoiceId, {
              status: 'authorized',
              accessKey: recoveredKey,
            } as any);
            await storage.createFiscalInvoiceEvent({
              invoiceId,
              eventType: 'recuperacao_539',
              status: 'success',
              errorCode: '539',
              errorMessage: errorMsg,
              description: `NF-e recuperada após rejeição 539 — chave autorizada extraída da SEFAZ: ${recoveredKey}. Faça uma "Consulta de Situação" na SEFAZ para baixar o XML autorizado e o protocolo.`,
              xmlRequest: result.xml_enviado,
              xmlResponse: result.xml_recebido,
              createdBy: invoice.createdBy || undefined,
            });
            return {
              success: true,
              accessKey: recoveredKey,
              protocolNumber: undefined,
              xmlEnvio: result.xml_enviado,
              xmlRetorno: result.xml_recebido,
            };
          } else {
            console.warn(`[SEFAZ] ⚠️ Rejeição 539 sem chave extraível na mensagem.`);
            await storage.updateFiscalInvoice(invoiceId, { status: 'rejected' });
            await storage.createFiscalInvoiceEvent({
              invoiceId,
              eventType: 'rejeicao_539',
              status: 'error',
              errorCode: '539',
              errorMessage: errorMsg,
              description: `NF-e #${invoice.invoiceNumber} já existe autorizada na SEFAZ com outra chave. Consulte manualmente a chave correta no portal da SEFAZ-GO (CNPJ ${invoice.issuerCnpj}, série ${invoice.series}, nNF ${invoice.invoiceNumber}) e atualize a nota.`,
              xmlRequest: result.xml_enviado,
              xmlResponse: result.xml_recebido,
              createdBy: invoice.createdBy || undefined,
            });
            return {
              success: false,
              errorCode: '539',
              errorMessage: `NF-e #${invoice.invoiceNumber} já autorizada na SEFAZ com chave diferente. Consulte manualmente no portal da SEFAZ-GO.`,
              xmlEnvio: result.xml_enviado,
              xmlRetorno: result.xml_recebido,
            };
          }
        }

        await storage.updateFiscalInvoice(invoiceId, { status: 'rejected' });

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'rejeicao',
          status: 'error',
          errorCode: errorCodeStr,
          errorMessage: errorMsg,
          description: `NF-e rejeitada pela SEFAZ — cStat: ${errorCode} | ${errorMsg}`,
          xmlRequest: result.xml_enviado,
          xmlResponse: result.xml_recebido,
          createdBy: invoice.createdBy || undefined,
        });

        return {
          success: false,
          errorCode: errorCodeStr,
          errorMessage: errorMsg,
          xmlEnvio: result.xml_enviado,
          xmlRetorno: result.xml_recebido,
        };
      }
    } catch (error: any) {
      console.error('[SEFAZ] Erro ao emitir NF-e:', error);

      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'emissao',
        status: 'error',
        errorCode: 'INTERNAL_ERROR',
        errorMessage: error.message,
        description: `Erro interno ao emitir NF-e: ${error.message}`,
      }).catch(() => {});

      await storage.updateFiscalInvoice(invoiceId, { status: 'rejected' }).catch(() => {});

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
        return {
          success: false,
          errorCode: 'INVALID_STATUS',
          errorMessage: `NF-e com status '${invoice.status}' não pode ser cancelada`,
        };
      }

      // SEFAZ TJust pattern exige começar e terminar com caractere não-branco
      // ([!-ÿ]) e tamanho 15..255. Espaço/quebra de linha no início ou fim
      // (ex.: "erro de faturamento ") faz a SEFAZ rejeitar com "Falha no
      // schema XML". Normalizamos: trim + colapsa whitespace interno + remove
      // controles invisíveis. Também truncamos em 255 chars.
      justification = (justification || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255);

      if (!justification || justification.length < 15) {
        return {
          success: false,
          errorCode: 'INVALID_JUSTIFICATION',
          errorMessage: 'Justificativa deve ter pelo menos 15 caracteres (sem contar espaços nas extremidades)',
        };
      }

      if (!invoice.accessKey || !invoice.protocolNumber) {
        return {
          success: false,
          errorCode: 'NO_ACCESS_KEY',
          errorMessage: 'Chave de acesso ou protocolo não encontrados',
        };
      }

      const environment = (invoice.environment || 'producao') as 'homologacao' | 'producao';
      const ambiente = SEFAZ_AMBIENTE[environment];
      const issuerCnpj = onlyDigits(invoice.issuerCnpj || '');

      const certId =
        invoice.certificateId ||
        (await findCertificateForCnpj(issuerCnpj));

      if (!certId) {
        return { success: false, errorCode: 'NO_CERTIFICATE', errorMessage: 'Certificado digital não encontrado' };
      }

      const certData = await loadCertFromStorage(certId);
      if (!certData) {
        return { success: false, errorCode: 'CERT_LOAD_ERROR', errorMessage: 'Erro ao carregar certificado digital' };
      }

      const invoiceModelo = (invoice as any).invoiceModel || '55';
      const configuracoes = {
        empresa: {
          pem: certData.pem,
          key: certData.key,
          password: certData.password,
        },
        geral: {
          versao: '4.00',
          ambiente,
          modelo: invoiceModelo,
        },
      };

      await storage.createFiscalInvoiceEvent({
        invoiceId,
        eventType: 'cancelamento',
        status: 'processing',
        description: `Cancelamento solicitado: ${justification}`,
        createdBy: invoice.createdBy || undefined,
      });

      console.log(`[SEFAZ] Cancelando NF-e ${invoice.accessKey}...`);

      const result = await cancelar({
        chNFe: invoice.accessKey,
        configuracoes: configuracoes as any,
        nProt: invoice.protocolNumber,
        xJust: justification,
      });

      if (result.success) {
        const protocolNumber = result.nfeProc?.infEvento?.nProt || result.nProt || '';

        await storage.updateFiscalInvoice(invoiceId, {
          status: 'cancelled',
          cancellationDate: nowBrazil(),
        });

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'cancelamento',
          status: 'success',
          protocolNumber: String(protocolNumber),
          description: `NF-e cancelada pela SEFAZ: ${justification}`,
          xmlResponse: result.xml_recebido,
          createdBy: invoice.createdBy || undefined,
        });

        return {
          success: true,
          protocolNumber: String(protocolNumber),
          xmlRequest: result.xml_enviado,
          xmlResponse: result.xml_recebido,
        };
      } else {
        const errorMsg = result.mensagem || 'Cancelamento rejeitado pela SEFAZ';

        await storage.createFiscalInvoiceEvent({
          invoiceId,
          eventType: 'cancelamento',
          status: 'error',
          errorMessage: errorMsg,
          description: `Cancelamento rejeitado: ${errorMsg}`,
          xmlResponse: result.xml_recebido,
          createdBy: invoice.createdBy || undefined,
        });

        return {
          success: false,
          errorCode: 'CANCEL_REJECTED',
          errorMessage: errorMsg,
          xmlRequest: result.xml_enviado,
          xmlResponse: result.xml_recebido,
        };
      }
    } catch (error: any) {
      console.error('[SEFAZ] Erro ao cancelar NF-e:', error);
      return { success: false, errorCode: 'INTERNAL_ERROR', errorMessage: error.message };
    }
  }

  /**
   * Consulta a situação atual de uma NF-e/NFC-e na SEFAZ via webservice
   * NfeConsultaProtocolo4. Usa mTLS com o certificado digital encontrado para
   * o emissor (ou um fallback ativo) — qualquer e-CNPJ ativo pode consultar
   * qualquer chave de acesso, pois o certificado serve apenas como
   * autenticação no webservice, não como autorização sobre a NF.
   *
   * Mapeia o cStat retornado para a flag `isCancelled` do chamador:
   *   100/150        → autorizada
   *   101/135/151/155 → cancelada
   *   102            → inutilizada
   *   110            → denegada
   *   217            → não consta
   *   demais         → mantém como pendente/erro
   */
  async consultNfe(
    accessKey: string,
    opts?: { certificateId?: string; environment?: 'homologacao' | 'producao' },
  ): Promise<StatusResult & { cStat?: string; xMotivo?: string; stub?: boolean; verifierVersion?: string }> {
    if (!accessKey || accessKey.length !== 44 || !/^\d{44}$/.test(accessKey)) {
      return { success: false, errorCode: 'INVALID_KEY', errorMessage: 'Chave de acesso inválida (deve ter 44 dígitos)' };
    }

    // Sanity-check do DV (último dígito) para evitar bater no webservice com
    // chaves obviamente malformadas (ex.: códigos de barras de boleto que foram
    // capturados por engano pelo extrator de PDF).
    const expectedDv = computeNFeCheckDigit(accessKey.substring(0, 43));
    if (expectedDv !== accessKey.substring(43, 44)) {
      return { success: false, errorCode: 'INVALID_DV', errorMessage: 'Dígito verificador inválido — chave provavelmente não é uma chave de NF-e/NFC-e' };
    }

    try {
      const cUF = accessKey.substring(0, 2);
      const issuerCnpj = accessKey.substring(6, 20);
      const modelo = accessKey.substring(20, 22);
      const uf = CUF_TO_UF[cUF];
      if (!uf) {
        return { success: false, errorCode: 'INVALID_UF', errorMessage: `cUF ${cUF} não reconhecido` };
      }

      const environment = opts?.environment || 'producao';
      const ambiente = SEFAZ_AMBIENTE[environment];

      // Resolve certificate: prefer the explicit one, then issuer CNPJ, then any active
      let certId = opts?.certificateId || (await findCertificateForCnpj(issuerCnpj));
      if (!certId) {
        // fallback: pega o primeiro certificado ativo válido
        const certs = await storage.getDigitalCertificates();
        const fallback = certs.find(
          (c) => c.isActive && (!c.validUntil || new Date(c.validUntil) >= new Date()),
        );
        certId = fallback?.id || null;
      }
      if (!certId) {
        return { success: false, errorCode: 'NO_CERTIFICATE', errorMessage: 'Nenhum certificado digital ativo disponível para consulta SEFAZ' };
      }

      const certData = await loadCertFromStorage(certId);
      if (!certData) {
        return { success: false, errorCode: 'CERT_LOAD_ERROR', errorMessage: 'Falha ao carregar certificado digital do storage' };
      }

      const wsUrl = pickConsultaProtocoloUrl(uf, environment, modelo);
      if (!wsUrl) {
        return { success: false, errorCode: 'WS_URL_NOT_MAPPED', errorMessage: `URL de consulta não configurada para UF ${uf} (ambiente ${environment})` };
      }

      const consultaXml =
        `<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
          `<tpAmb>${ambiente}</tpAmb>` +
          `<xServ>CONSULTAR</xServ>` +
          `<chNFe>${accessKey}</chNFe>` +
        `</consSitNFe>`;

      const soapEnvelope =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
          `<soap12:Body>` +
            `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">${consultaXml}</nfeDadosMsg>` +
          `</soap12:Body>` +
        `</soap12:Envelope>`;

      const responseXml = await postSoap(wsUrl, soapEnvelope, certData.pem, certData.key);

      // O outer cStat de retConsSitNFe normalmente é o status agregado da NF-e:
      //   100 = Autorizado o uso da NF-e
      //   101 = Cancelamento homologado (cancelamento "antigo", via cancNFe)
      //   etc.
      // Porém, desde 2012 o cancelamento é feito via Evento (tpEvento=110111).
      // Nesse fluxo a SEFAZ MANTÉM o status da NF como 100 e a evidência do
      // cancelamento fica no bloco <procEventoNFe>/<retEvento>/<infEvento>.
      // Precisamos inspecionar esses eventos para detectar cancelamentos modernos.
      const outerCStat = extractTag(responseXml, 'cStat');
      const outerXMotivo = extractTag(responseXml, 'xMotivo') || '';

      if (!outerCStat) {
        return {
          success: false,
          errorCode: 'NO_CSTAT',
          errorMessage: 'Resposta da SEFAZ sem cStat',
          description: responseXml.substring(0, 400),
        };
      }

      // Se o status já indica cancelamento/inutilização/denegação direto, retorna.
      const TERMINAL_CSTATS = new Set(['101', '102', '110', '151', '155', '217', '218', '301', '302']);
      if (TERMINAL_CSTATS.has(outerCStat)) {
        return {
          success: true,
          status: outerCStat,
          cStat: outerCStat,
          xMotivo: outerXMotivo,
          description: outerXMotivo || `cStat ${outerCStat}`,
          verifierVersion: SEFAZ_VERIFIER_VERSION,
        };
      }

      // Procura eventos: cancelamento (110111), cancelamento por substituição (110112),
      // carta de correção (110110). Para cancelamento, cStat 135 ou 155 (extemporâneo)
      // significa cancelamento autorizado.
      const cancellationEvent = findCancellationEvent(responseXml);
      if (cancellationEvent) {
        return {
          success: true,
          status: cancellationEvent.cStat, // 135 / 155 → mapeados como cancelada
          cStat: cancellationEvent.cStat,
          xMotivo: cancellationEvent.xMotivo || 'Cancelamento de NF-e por evento homologado',
          description: cancellationEvent.xMotivo || 'Cancelamento por evento',
          verifierVersion: SEFAZ_VERIFIER_VERSION,
        };
      }

      return {
        success: true,
        status: outerCStat,
        cStat: outerCStat,
        xMotivo: outerXMotivo,
        description: outerXMotivo || `cStat ${outerCStat}`,
        verifierVersion: SEFAZ_VERIFIER_VERSION,
      };
    } catch (err: any) {
      console.error('[SEFAZ] consultNfe erro:', err?.message || err);
      return {
        success: false,
        errorCode: 'CONSULT_ERROR',
        errorMessage: err?.message || 'Erro ao consultar NF na SEFAZ',
      };
    }
  }
}

// ─── cUF → UF ─────────────────────────────────────────────────────────────────
const CUF_TO_UF: Record<string, string> = Object.fromEntries(
  Object.entries(UF_CODES).map(([uf, cuf]) => [cuf, uf]),
);

// ─── NfeConsultaProtocolo4 endpoints ──────────────────────────────────────────
// Fontes: portal nacional NF-e (https://www.nfe.fazenda.gov.br/portal/webServices.aspx)
// Estados não listados caem no SVRS (Sefaz Virtual RS) que serve como autorizador.
const SVRS = {
  producao: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
  homologacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
};
const SVAN = {
  producao: 'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
  homologacao: 'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
};

const CONSULTA_PROTOCOLO_NFE_URL: Record<string, { producao: string; homologacao: string }> = {
  GO: {
    producao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
    homologacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
  },
  MG: {
    producao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
    homologacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
  },
  MS: {
    producao: 'https://nfe.fazenda.ms.gov.br/producao/services2/NFeConsultaProtocolo4',
    homologacao: 'https://hom.nfe.fazenda.ms.gov.br/homologacao/services2/NFeConsultaProtocolo4',
  },
  MT: {
    producao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
    homologacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
  },
  PR: {
    producao: 'https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
    homologacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
  },
  RS: {
    producao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    homologacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
  },
  SP: {
    producao: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    homologacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
  },
  BA: {
    producao: 'https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    homologacao: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
  },
  CE: {
    producao: 'https://nfe.sefaz.ce.gov.br/nfe4/services/NFeConsultaProtocolo4',
    homologacao: 'https://nfeh.sefaz.ce.gov.br/nfe4/services/NFeConsultaProtocolo4',
  },
  AM: {
    producao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
    homologacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
  },
  PE: {
    producao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
    homologacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
  },
  MA: { producao: SVAN.producao, homologacao: SVAN.homologacao },
};

// NFC-e (modelo 65) consulta — todos atendidos via webservice próprio da UF, e
// SVRS para os que não emitem NFC-e localmente. Para consulta o caminho é, via
// de regra, o mesmo NfeConsultaProtocolo4. Mantemos o mesmo mapa.
function pickConsultaProtocoloUrl(
  uf: string,
  environment: 'homologacao' | 'producao',
  _modelo: string,
): string | null {
  const direct = CONSULTA_PROTOCOLO_NFE_URL[uf];
  if (direct) return direct[environment];
  // Fallback: SVRS atende AC, AL, AP, DF, ES, PA, PB, PI, RJ, RN, RO, RR, SC, SE, TO
  return SVRS[environment];
}

// ─── HTTPS POST com mTLS ──────────────────────────────────────────────────────
// Tenta primeiro com verificação TLS estrita; se houver erro de certificado
// (alguns servidores SEFAZ enviam cadeia incompleta de intermediários ICP-Brasil),
// faz uma segunda tentativa permissiva e loga o downgrade para auditoria.
function postSoapOnce(
  url: string,
  body: string,
  certPem: string,
  keyPem: string,
  rejectUnauthorized: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          // SOAPAction vazio é aceito pelos webservices SOAP 1.2 da SEFAZ
          SOAPAction: '""',
        },
        cert: certPem,
        key: keyPem,
        rejectUnauthorized,
        timeout: 25000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${text.substring(0, 300)}`));
          }
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error('Timeout consultando SEFAZ'));
    });
    req.write(body);
    req.end();
  });
}

const TLS_DOWNGRADE_HOSTS = new Set<string>();
async function postSoap(url: string, body: string, certPem: string, keyPem: string): Promise<string> {
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const allowDowngrade = TLS_DOWNGRADE_HOSTS.has(host);
  try {
    return await postSoapOnce(url, body, certPem, keyPem, !allowDowngrade);
  } catch (err: any) {
    const msg = err?.message || '';
    const tlsError =
      err?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      err?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
      err?.code === 'CERT_HAS_EXPIRED' ||
      err?.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      err?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      /unable to (verify|get).*cert|self.?signed/i.test(msg);
    if (tlsError && !allowDowngrade) {
      console.warn(`[SEFAZ] TLS strict falhou em ${host} (${err?.code || msg}); reusando handshake permissivo.`);
      TLS_DOWNGRADE_HOSTS.add(host);
      return postSoapOnce(url, body, certPem, keyPem, false);
    }
    throw err;
  }
}

// Extrai a primeira ocorrência de uma tag XML (sem namespaces) — bom o suficiente
// para os campos cStat / xMotivo da resposta NfeConsultaProtocolo.
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// Encontra eventos de cancelamento (tpEvento=110111 ou 110112) homologados
// no payload de retConsSitNFe. Retorna o cStat/xMotivo do evento que indique
// cancelamento (135, 155 ou 101).
//
// IMPORTANTE: o critério é a combinação <procEventoNFe> + tpEvento de cancelamento
// + cStat homologado. Sem um tpEvento explícito de cancelamento NÃO marca como
// cancelada — assim evitamos falso-positivo em payloads com eventos genéricos
// (carta de correção, manifestação do destinatário, etc.) que também usam cStat 135.
function findCancellationEvent(xml: string): { cStat: string; xMotivo: string } | null {
  const CANCEL_TPEVENTO = new Set(['110111', '110112']);
  const CANCEL_CSTAT = new Set(['101', '135', '155']);

  // Itera por cada bloco <procEventoNFe> (cada cancelamento/CC-e fica em um bloco próprio).
  // Para cada um, exige: tpEvento de cancelamento (vindo do <evento>/<infEvento>)
  // E cStat homologado (vindo do <retEvento>/<infEvento>).
  const procRegex = /<(?:[a-zA-Z0-9]+:)?procEventoNFe\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?procEventoNFe>/gi;
  const procs = xml.match(procRegex) || [];
  for (const block of procs) {
    const tpEvento = extractTag(block, 'tpEvento');
    if (!tpEvento || !CANCEL_TPEVENTO.has(tpEvento)) continue;

    // Procura especificamente o cStat dentro de <retEvento> (resposta da SEFAZ ao evento).
    const retEventoMatch = block.match(/<(?:[a-zA-Z0-9]+:)?retEvento\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?retEvento>/i);
    const retBlock = retEventoMatch?.[0] || block;
    const cStat = extractTag(retBlock, 'cStat');
    if (!cStat || !CANCEL_CSTAT.has(cStat)) continue;
    const xMotivo = extractTag(retBlock, 'xMotivo') || '';
    return { cStat, xMotivo };
  }
  return null;
}

// ─── Distribuição de DF-e (SEFAZ Ambiente Nacional) ──────────────────────────
// Web Service nacional que entrega os documentos fiscais (NF-e) emitidos CONTRA
// um CNPJ. Sem manifestação, retorna apenas o RESUMO (resNFe) de cada nota.
const DFE_DISTRIBUICAO_URL: Record<string, string> = {
  '1': 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  '2': 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
};

export interface DfeDocSummary {
  nsu: string;
  schema: string;
  type: 'resumo' | 'nota' | 'evento' | 'desconhecido';
  accessKey: string | null;
  supplierName: string | null;
  supplierDocument: string | null;
  supplierIe: string | null;
  totalValue: string | null;
  issueDate: Date | null;
  invoiceNumber: string | null;
  series: string | null;
  cSitNFe: string | null;
  isCancellation: boolean;
}

export interface DfeFetchResult {
  ok: boolean;
  cStat: string | null;
  xMotivo: string | null;
  ultNSU: string;
  maxNSU: string;
  docs: DfeDocSummary[];
  error?: string;
}

// Deriva número e série da NF-e a partir da chave de acesso (44 dígitos).
function invoiceNumberFromKey(chNFe: string): { invoiceNumber: string | null; series: string | null } {
  const k = onlyDigits(chNFe || '');
  if (k.length !== 44) return { invoiceNumber: null, series: null };
  return {
    series: String(parseInt(k.substring(22, 25), 10)),
    invoiceNumber: String(parseInt(k.substring(25, 34), 10)),
  };
}

function parseDfeDoc(nsu: string, schema: string, xml: string): DfeDocSummary {
  const base: DfeDocSummary = {
    nsu, schema, type: 'desconhecido',
    accessKey: null, supplierName: null, supplierDocument: null, supplierIe: null,
    totalValue: null, issueDate: null, invoiceNumber: null, series: null, cSitNFe: null,
    isCancellation: false,
  };
  const sch = (schema || '').toLowerCase();

  const isEvent = sch.startsWith('resevento') || sch.startsWith('procevento') || xml.includes('<procEventoNFe') || xml.includes('<resEvento');
  if (isEvent) {
    const chNFe = extractTag(xml, 'chNFe');
    const tpEvento = extractTag(xml, 'tpEvento');
    // 110111 = Cancelamento; 110112 = Cancelamento extemporâneo (por substituição)
    return {
      ...base,
      type: 'evento',
      accessKey: chNFe ? onlyDigits(chNFe) : null,
      isCancellation: tpEvento === '110111' || tpEvento === '110112',
    };
  }

  // Resumo da NF-e (resNFe) ou NF-e completa (procNFe/nfeProc)
  const isFull = sch.startsWith('procnfe') || xml.includes('<nfeProc') || xml.includes('<infNFe');
  let accessKey = (() => {
    const ch = extractTag(xml, 'chNFe');
    if (ch && onlyDigits(ch).length === 44) return onlyDigits(ch);
    const idMatch = xml.match(/Id="NFe(\d{44})"/);
    return idMatch ? idMatch[1] : null;
  })();

  const supplierDocument = extractTag(xml, 'CNPJ') || extractTag(xml, 'CPF');
  const { invoiceNumber, series } = accessKey ? invoiceNumberFromKey(accessKey) : { invoiceNumber: null, series: null };
  const dEmi = extractTag(xml, 'dhEmi') || extractTag(xml, 'dEmi');
  let issueDate: Date | null = null;
  if (dEmi) {
    const d = new Date(dEmi);
    if (!isNaN(d.getTime())) issueDate = d;
  }

  return {
    ...base,
    type: isFull ? 'nota' : 'resumo',
    accessKey,
    supplierName: extractTag(xml, 'xNome') || null,
    supplierDocument: supplierDocument ? onlyDigits(supplierDocument) : null,
    supplierIe: extractTag(xml, 'IE') || null,
    totalValue: extractTag(xml, 'vNF') || null,
    issueDate,
    invoiceNumber,
    series,
    cSitNFe: extractTag(xml, 'cSitNFe') || null,
  };
}

// Consulta o WS de Distribuição de DF-e para um CNPJ a partir do último NSU lido.
export async function fetchDistribuicaoDFe(params: {
  cnpj: string;
  uf: string;
  ultNSU?: string;
  ambiente?: 'producao' | 'homologacao';
}): Promise<DfeFetchResult> {
  const cnpj = onlyDigits(params.cnpj);
  const ambiente = params.ambiente === 'homologacao' ? '2' : '1';
  const ultNSU = (params.ultNSU || '0').replace(/\D/g, '').padStart(15, '0');
  const cUF = UF_CODES[(params.uf || 'GO').toUpperCase()] || '52';
  const empty: DfeFetchResult = { ok: false, cStat: null, xMotivo: null, ultNSU, maxNSU: ultNSU, docs: [] };

  const certId = await findCertificateForCnpj(cnpj);
  if (!certId) {
    return { ...empty, error: `Nenhum certificado digital A1 válido encontrado para o CNPJ ${cnpj}.` };
  }
  const certData = await loadCertFromStorage(certId);
  if (!certData) {
    return { ...empty, error: `Falha ao carregar o certificado do CNPJ ${cnpj}.` };
  }

  const distDFeInt =
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
    `<tpAmb>${ambiente}</tpAmb>` +
    `<cUFAutor>${cUF}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ>` +
    `<distNSU><ultNSU>${ultNSU}</ultNSU></distNSU>` +
    `</distDFeInt>`;

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<nfeDadosMsg>${distDFeInt}</nfeDadosMsg>` +
    `</nfeDistDFeInteresse>` +
    `</soap12:Body></soap12:Envelope>`;

  let responseXml: string;
  try {
    responseXml = await postSoap(DFE_DISTRIBUICAO_URL[ambiente], envelope, certData.pem, certData.key);
  } catch (err: any) {
    return { ...empty, error: `Erro na comunicação com a SEFAZ: ${err.message}` };
  }

  const cStat = extractTag(responseXml, 'cStat');
  const xMotivo = extractTag(responseXml, 'xMotivo');
  const newUlt = (extractTag(responseXml, 'ultNSU') || ultNSU).replace(/\D/g, '').padStart(15, '0');
  const maxNSU = (extractTag(responseXml, 'maxNSU') || newUlt).replace(/\D/g, '').padStart(15, '0');

  const docs: DfeDocSummary[] = [];
  const docZipRe = /<docZip([^>]*)>([\s\S]*?)<\/docZip>/gi;
  let m: RegExpExecArray | null;
  while ((m = docZipRe.exec(responseXml)) !== null) {
    const attrs = m[1] || '';
    const b64 = (m[2] || '').trim();
    const nsuMatch = attrs.match(/NSU="(\d+)"/i);
    const schemaMatch = attrs.match(/schema="([^"]+)"/i);
    try {
      const xml = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
      docs.push(parseDfeDoc(nsuMatch ? nsuMatch[1] : '', schemaMatch ? schemaMatch[1] : '', xml));
    } catch (e: any) {
      console.error('[DFE] Falha ao descompactar docZip NSU', nsuMatch?.[1], e.message);
    }
  }

  return {
    ok: cStat === '138' || cStat === '137',
    cStat, xMotivo,
    ultNSU: newUlt,
    maxNSU,
    docs,
  };
}

export interface NFeByChaveResult {
  ok: boolean;
  cStat: string | null;
  xMotivo: string | null;
  fullXml: string | null;
  summary: DfeDocSummary | null;
  error?: string;
}

// Consulta uma NF-e específica no WS de Distribuição de DF-e pela chave de acesso
// (consChNFe). Retorna o XML completo (procNFe) quando o CNPJ informado é
// participante da nota (tipicamente o destinatário). Não emite manifestação.
export async function fetchNFeByChave(params: {
  chave: string;
  uf: string;
  cnpj: string;
  ambiente?: 'producao' | 'homologacao';
}): Promise<NFeByChaveResult> {
  const chave = onlyDigits(params.chave);
  const cnpj = onlyDigits(params.cnpj);
  const ambiente = params.ambiente === 'homologacao' ? '2' : '1';
  const cUF = UF_CODES[(params.uf || 'GO').toUpperCase()] || '52';
  const empty: NFeByChaveResult = { ok: false, cStat: null, xMotivo: null, fullXml: null, summary: null };

  if (chave.length !== 44) return { ...empty, error: 'Chave de acesso inválida (precisa ter 44 dígitos).' };

  const certId = await findCertificateForCnpj(cnpj);
  if (!certId) return { ...empty, error: `Nenhum certificado digital A1 válido encontrado para o CNPJ ${cnpj}.` };
  const certData = await loadCertFromStorage(certId);
  if (!certData) return { ...empty, error: `Falha ao carregar o certificado do CNPJ ${cnpj}.` };

  const distDFeInt =
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
    `<tpAmb>${ambiente}</tpAmb>` +
    `<cUFAutor>${cUF}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ>` +
    `<consChNFe><chNFe>${chave}</chNFe></consChNFe>` +
    `</distDFeInt>`;

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<nfeDadosMsg>${distDFeInt}</nfeDadosMsg>` +
    `</nfeDistDFeInteresse>` +
    `</soap12:Body></soap12:Envelope>`;

  let responseXml: string;
  try {
    responseXml = await postSoap(DFE_DISTRIBUICAO_URL[ambiente], envelope, certData.pem, certData.key);
  } catch (err: any) {
    return { ...empty, error: `Erro na comunicação com a SEFAZ: ${err.message}` };
  }

  const cStat = extractTag(responseXml, 'cStat');
  const xMotivo = extractTag(responseXml, 'xMotivo');

  let fullXml: string | null = null;
  let summary: DfeDocSummary | null = null;
  const docZipRe = /<docZip([^>]*)>([\s\S]*?)<\/docZip>/gi;
  let m: RegExpExecArray | null;
  while ((m = docZipRe.exec(responseXml)) !== null) {
    const attrs = m[1] || '';
    const b64 = (m[2] || '').trim();
    const nsuMatch = attrs.match(/NSU="(\d+)"/i);
    const schemaMatch = attrs.match(/schema="([^"]+)"/i);
    try {
      const xml = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
      const doc = parseDfeDoc(nsuMatch ? nsuMatch[1] : '', schemaMatch ? schemaMatch[1] : '', xml);
      if (doc.type === 'nota' || xml.includes('<infNFe')) {
        fullXml = xml;
        summary = doc;
      } else if (!summary) {
        summary = doc;
      }
    } catch (e: any) {
      console.error('[DFE][consChNFe] Falha ao descompactar docZip', e.message);
    }
  }

  return { ok: cStat === '138', cStat, xMotivo, fullXml, summary };
}

// ─── Manifestação do Destinatário — Ciência da Operação (tpEvento 210210) ────
// Enviada ao Ambiente Nacional (cOrgao 91). É o que faz a SEFAZ liberar o XML
// completo (procNFe) da NF-e de ENTRADA para o destinatário baixar. Reaproveita
// o assinador do node-nfe-nfce (xml-crypto) e o mesmo mTLS do postSoap.
const RECEP_EVENTO_AN_URL: Record<'producao' | 'homologacao', string> = {
  producao: 'https://www1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  homologacao: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
};

function brasiliaIsoNow(): string {
  const b = new Date(Date.now() - 3 * 3600 * 1000); // Brasil = UTC-3 (sem horário de verão)
  const p = (n: number) => String(n).padStart(2, '0');
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}T${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}-03:00`;
}

export interface ManifestacaoResult {
  ok: boolean;
  cStat: string | null;
  xMotivo: string | null;
  error?: string;
}

export async function manifestarCiencia(params: {
  chave: string;
  cnpj: string;
  ambiente?: 'producao' | 'homologacao';
}): Promise<ManifestacaoResult> {
  const chave = onlyDigits(params.chave);
  const cnpj = onlyDigits(params.cnpj);
  const ambiente: 'producao' | 'homologacao' = params.ambiente === 'homologacao' ? 'homologacao' : 'producao';
  const tpAmb = ambiente === 'homologacao' ? '2' : '1';
  if (chave.length !== 44) return { ok: false, cStat: null, xMotivo: null, error: 'Chave de acesso inválida.' };

  const certId = await findCertificateForCnpj(cnpj);
  if (!certId) return { ok: false, cStat: null, xMotivo: null, error: `Nenhum certificado A1 para o CNPJ ${cnpj}.` };
  const certData = await loadCertFromStorage(certId);
  if (!certData) return { ok: false, cStat: null, xMotivo: null, error: 'Falha ao carregar o certificado.' };

  let signXmlX509: any;
  try {
    const sx: any = await import('node-nfe-nfce/lib/domain/use-cases/signature/sign-xml-x509');
    signXmlX509 = sx.signXmlX509 || (sx.default && sx.default.signXmlX509);
    if (!signXmlX509) throw new Error('signXmlX509 indisponível');
  } catch (e: any) {
    return { ok: false, cStat: null, xMotivo: null, error: `Assinador indisponível: ${e.message}` };
  }

  const id = `ID210210${chave}01`;
  const evento =
    `<evento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
    `<infEvento Id="${id}">` +
    `<cOrgao>91</cOrgao>` +
    `<tpAmb>${tpAmb}</tpAmb>` +
    `<CNPJ>${cnpj}</CNPJ>` +
    `<chNFe>${chave}</chNFe>` +
    `<dhEvento>${brasiliaIsoNow()}</dhEvento>` +
    `<tpEvento>210210</tpEvento>` +
    `<nSeqEvento>1</nSeqEvento>` +
    `<verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>` +
    `</infEvento></evento>`;

  let signedEvento: string;
  try {
    signedEvento = signXmlX509(evento, 'infEvento', certData);
  } catch (e: any) {
    return { ok: false, cStat: null, xMotivo: null, error: `Falha ao assinar o evento: ${e.message}` };
  }

  const lote = `<envEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote>${signedEvento}</envEvento>`;
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${lote}</nfeDadosMsg>` +
    `</soap12:Body></soap12:Envelope>`;

  let responseXml: string;
  try {
    responseXml = await postSoap(RECEP_EVENTO_AN_URL[ambiente], envelope, certData.pem, certData.key);
  } catch (e: any) {
    return { ok: false, cStat: null, xMotivo: null, error: `Erro ao transmitir manifestação à SEFAZ: ${e.message}` };
  }

  // Prioriza o cStat DENTRO de retEvento (evento individual) sobre o cStat do lote.
  const retScope = (responseXml.match(/<retEvento[\s\S]*?<\/retEvento>/i) || [])[0] || responseXml;
  const cStat = ((retScope.match(/<cStat>(\d+)<\/cStat>/i) || [])[1]) || ((responseXml.match(/<cStat>(\d+)<\/cStat>/i) || [])[1]) || null;
  const xMotivo = ((retScope.match(/<xMotivo>([^<]*)<\/xMotivo>/i) || [])[1]) || ((responseXml.match(/<xMotivo>([^<]*)<\/xMotivo>/i) || [])[1]) || null;
  // 135 = registrado e vinculado; 136 = registrado (não vinculado); 573 = duplicidade (já manifestado)
  const ok = ['135', '136', '573'].includes(String(cStat || ''));
  return { ok, cStat: cStat ? String(cStat) : null, xMotivo: xMotivo || null };
}

export const sefazService = new SefazService();
