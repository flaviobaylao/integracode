// ============================================================================
// INTEGRA 2.0 — DANFE DA NOTA DE COMPRA (entrada)
//
// A aba Compras ja guarda o XML COMPLETO da NF-e do fornecedor em
// purchase_invoices.xml_content (vindo do upload de XML ou do download pela
// chave na SEFAZ). Aqui esse XML vira o MESMO desenho de DANFE que o pessoal
// ja imprime nas notas de venda: reaproveitamos renderDanfeToDoc do gerador do
// front (jspdf roda igual em Node — mesmo caminho ja usado em doc-builders.ts).
//
// Diferenca em relacao ao parse enxuto do purchase-routes: aqui precisamos do
// emitente completo (endereco/cidade/UF/IE/fone), do destinatario, dos impostos
// por item, das duplicatas e do protocolo de autorizacao — tudo que a DANFE
// mostra. O parse do purchase-routes continua intacto (ele so alimenta a lista
// e a classificacao).
// ============================================================================
import { jsPDF } from 'jspdf';
import * as xmlJs from 'xml-js';
import { renderDanfeToDoc, type DanfeInvoice, type DanfeInvoiceItem } from '../client/src/lib/danfe-generator';

function stripNamespaces(xmlString: string): string {
  return xmlString
    .replace(/<\/?[\w]+:/g, (match) => (match.charAt(0) === '<' && match.charAt(1) === '/' ? '</' : '<'))
    .replace(/\sxmlns[^=]*="[^"]*"/g, '');
}

function txt(obj: any): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string' || typeof obj === 'number') return String(obj);
  if (obj._text !== undefined) return String(obj._text);
  if (obj._cdata !== undefined) return String(obj._cdata);
  return '';
}

function arr(v: any): any[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

// Primeiro grupo de imposto preenchido dentro de ICMS/PIS/COFINS/IPI (o layout
// da NF-e usa uma tag diferente por CST: ICMS00, ICMS60, ICMSSN102, PISAliq...).
function grupo(no: any): any {
  if (!no || typeof no !== 'object') return {};
  const k = Object.keys(no).filter((x) => x !== '_attributes');
  return k.length ? no[k[0]] || {} : {};
}

/**
 * Converte o XML da NF-e de compra no formato que renderDanfeToDoc consome.
 * Nao acessa banco: recebe o XML e (opcionalmente) dados da nota no 2.0.
 */
export function nfeXmlParaDanfe(xmlContent: string, extra?: { id?: string; environment?: string }): DanfeInvoice {
  const root: any = xmlJs.xml2js(stripNamespaces(String(xmlContent)), { compact: true, ignoreComment: true });
  const nfeProc = root.nfeProc || root.NFe || root.nfe || root;
  const nfe = nfeProc?.NFe || nfeProc?.nfe || nfeProc;
  const infNFe = nfe?.infNFe || nfe?.infnfe;
  if (!infNFe) throw new Error('XML sem infNFe (nao e uma NF-e valida)');

  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const enderEmit = emit.enderEmit || {};
  const dest = infNFe.dest || {};
  const enderDest = dest.enderDest || {};
  const total = infNFe.total?.ICMSTot || infNFe.total?.icmstot || {};
  const transp = infNFe.transp || {};
  const cobr = infNFe.cobr || {};
  const infAdic = infNFe.infAdic || {};
  const protNFe = nfeProc?.protNFe?.infProt || {};

  const accessKey = String(txt(infNFe._attributes?.Id) || '').replace(/^NFe/, '');

  const items: DanfeInvoiceItem[] = arr(infNFe.det).map((det: any, i: number) => {
    const prod = det.prod || {};
    const imp = det.imposto || {};
    const icms = grupo(imp.ICMS);
    const pis = grupo(imp.PIS);
    const cofins = grupo(imp.COFINS);
    const ipi = imp.IPI ? grupo(imp.IPI) : {};
    return {
      id: `${accessKey || 'nf'}-${i + 1}`,
      invoiceId: extra?.id || '',
      itemNumber: Number(txt(det._attributes?.nItem) || i + 1),
      productCode: txt(prod.cProd),
      productName: txt(prod.xProd),
      ncm: txt(prod.NCM),
      cfop: txt(prod.CFOP),
      unit: txt(prod.uCom),
      quantity: txt(prod.qCom),
      unitPrice: txt(prod.vUnCom),
      totalPrice: txt(prod.vProd),
      discount: txt(prod.vDesc) || '0',
      csosn: txt(icms.CSOSN) || undefined,
      cstIcms: txt(icms.CST) || undefined,
      baseIcms: txt(icms.vBC) || '0',
      aliqIcms: txt(icms.pICMS) || '0',
      valorIcms: txt(icms.vICMS) || '0',
      aliqIpi: txt(ipi.pIPI) || '0',
      cstPis: txt(pis.CST) || undefined,
      valorPis: txt(pis.vPIS) || '0',
      cstCofins: txt(cofins.CST) || undefined,
      valorCofins: txt(cofins.vCOFINS) || '0',
      valorIpi: txt(ipi.vIPI) || '0',
    };
  });

  const duplicatas = arr(cobr.dup).map((d: any) => ({
    nDup: txt(d.nDup),
    dVenc: txt(d.dVenc) || null,
    vDup: Number(txt(d.vDup) || 0),
  }));

  const emitAddress = [
    txt(enderEmit.xLgr),
    txt(enderEmit.nro),
    txt(enderEmit.xCpl),
    txt(enderEmit.xBairro),
    txt(enderEmit.CEP) ? `CEP ${txt(enderEmit.CEP)}` : '',
  ].filter(Boolean).join(', ');

  const destAddress = [
    txt(enderDest.xLgr),
    txt(enderDest.nro),
    txt(enderDest.xCpl),
  ].filter(Boolean).join(', ');

  const infCpl = [txt(infAdic.infCpl), txt(infAdic.infAdFisco)].filter(Boolean).join(' | ');
  const emissao = txt(ide.dhEmi) || txt(ide.dEmi) || '';

  return {
    id: extra?.id || accessKey,
    invoiceNumber: txt(ide.nNF),
    series: txt(ide.serie) || '1',
    issuerName: txt(emit.xNome) || txt(emit.xFant),
    issuerCnpj: txt(emit.CNPJ) || txt(emit.CPF),
    issuerIe: txt(emit.IE),
    issuerAddress: emitAddress,
    issuerUf: txt(enderEmit.UF),
    issuerCityCode: txt(enderEmit.cMun),
    issuerCity: txt(enderEmit.xMun),
    issuerPhone: txt(enderEmit.fone),
    customerName: txt(dest.xNome),
    customerCnpjCpf: txt(dest.CNPJ) || txt(dest.CPF),
    customerIe: txt(dest.IE),
    customerAddress: destAddress,
    customerBairro: txt(enderDest.xBairro),
    customerCep: txt(enderDest.CEP),
    customerCity: txt(enderDest.xMun),
    customerUf: txt(enderDest.UF),
    customerPhone: txt(enderDest.fone),
    cfop: items[0]?.cfop || '',
    natureOfOperation: txt(ide.natOp),
    operationType: txt(ide.tpNF) === '0' ? 'entrada' : 'saida',
    status: txt(protNFe.cStat) === '100' ? 'autorizada' : (txt(protNFe.cStat) || 'importada'),
    environment: txt(ide.tpAmb) === '2' ? 'homologacao' : (extra?.environment || 'producao'),
    totalProducts: txt(total.vProd) || '0',
    totalDiscount: txt(total.vDesc) || '0',
    totalFreight: txt(total.vFrete) || '0',
    totalInsurance: txt(total.vSeg) || '0',
    totalOtherExpenses: txt(total.vOutro) || '0',
    totalIcms: txt(total.vICMS) || '0',
    totalPis: txt(total.vPIS) || '0',
    totalCofins: txt(total.vCOFINS) || '0',
    totalIpi: txt(total.vIPI) || '0',
    totalInvoice: txt(total.vNF) || '0',
    totalBaseIcms: txt(total.vBC) || '0',
    totalBaseIcmsSt: txt(total.vBCST) || '0',
    totalIcmsSt: txt(total.vST) || '0',
    paymentMethod: txt(transp.modFrete) ? '' : '',
    duplicatas: duplicatas.length ? duplicatas : undefined,
    notes: infCpl,
    accessKey,
    protocolNumber: txt(protNFe.nProt),
    emissionDate: emissao,
    authorizationDate: txt(protNFe.dhRecbto) || undefined,
    createdAt: emissao,
    items,
  };
}

/** Nome de arquivo estavel para o DANFE da compra. */
export function nomeArquivoDanfeCompra(invoice: { invoiceNumber?: string | null; supplierName?: string | null; accessKey?: string | null }): string {
  const num = String(invoice?.invoiceNumber || invoice?.accessKey || 'compra').replace(/[^A-Za-z0-9_-]/g, '');
  const forn = String(invoice?.supplierName || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
  return `DANFE_COMPRA_${num}${forn ? '_' + forn : ''}.pdf`;
}

/**
 * Gera o PDF do DANFE de uma nota de COMPRA a partir do XML guardado.
 * Devolve null quando a nota ainda nao tem XML (status 'detected' do radar).
 */
export function montarDanfeCompraPdf(invoice: any): Buffer | null {
  const xml = invoice?.xmlContent || invoice?.xml_content;
  if (!xml) return null;
  const danfe = nfeXmlParaDanfe(String(xml), { id: invoice?.id });
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderDanfeToDoc(doc, danfe, null);
  return Buffer.from(doc.output('arraybuffer'));
}
