import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface DanfeInvoice {
  id: string;
  invoiceNumber: string;
  series: string;
  issuerName: string;
  issuerCnpj: string;
  issuerIe: string;
  issuerAddress: string;
  issuerUf: string;
  issuerCityCode: string;
  issuerCity: string;
  issuerPhone: string;
  customerName: string;
  customerCnpjCpf: string;
  customerIe: string;
  customerAddress: string;
  customerBairro?: string;
  customerCep?: string;
  customerCity?: string;
  customerUf?: string;
  customerPhone?: string;
  cfop: string;
  natureOfOperation: string;
  operationType: string;
  status: string;
  environment: string;
  totalProducts: string;
  totalDiscount: string;
  totalFreight: string;
  totalInsurance: string;
  totalOtherExpenses: string;
  totalIcms: string;
  totalPis: string;
  totalCofins: string;
  totalIpi: string;
  totalInvoice: string;
  totalBaseIcms?: string;
  totalBaseIcmsSt?: string;
  totalIcmsSt?: string;
  paymentMethod: string;
  dueDate?: string;
  notes: string;
  accessKey: string;
  protocolNumber: string;
  emissionDate: string;
  authorizationDate?: string;
  createdAt: string;
  items?: DanfeInvoiceItem[];
}

export interface DanfeInvoiceItem {
  id: string;
  invoiceId: string;
  itemNumber: number;
  productCode: string;
  productName: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  totalPrice: string;
  discount: string;
  csosn?: string;
  cstIcms?: string;
  baseIcms?: string;
  aliqIcms?: string;
  valorIcms?: string;
  aliqIpi?: string;
  cstPis?: string;
  valorPis?: string;
  cstCofins?: string;
  valorCofins?: string;
  valorIpi?: string;
}

export function generateMultiDanfePdf(invoices: DanfeInvoice[]) {
  if (invoices.length === 0) return;
  if (invoices.length === 1) {
    generateDanfePdf(invoices[0]);
    return;
  }
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  for (let i = 0; i < invoices.length; i++) {
    if (i > 0) doc.addPage();
    renderDanfeToDoc(doc, invoices[i]);
  }
  const firstNum = invoices[0].invoiceNumber || '0';
  const lastNum = invoices[invoices.length - 1].invoiceNumber || '0';
  const env = invoices[0].environment === 'homologacao' ? 'HOM' : 'PROD';
  const fileName = `DANFE_${firstNum}-${lastNum}_${env}.pdf`;
  doc.save(fileName);
}

export function generateDanfePdf(invoice: DanfeInvoice) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  renderDanfeToDoc(doc, invoice);
  const nfNum = invoice.invoiceNumber || '0';
  const fileName = `DANFE_${nfNum}_${invoice.environment === 'homologacao' ? 'HOM' : 'PROD'}.pdf`;
  doc.save(fileName);
}

function renderDanfeToDoc(doc: jsPDF, invoice: DanfeInvoice) {
  const pageWidth = 210;
  const margin = 7;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const centerX = pageWidth / 2;

  const isHomologacao = invoice.environment === 'homologacao';

  const fmtCur = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return '0,00';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtQty = (v: string | number) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (isNaN(n)) return '0';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  };
  const fmtDateOnly = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };
  const fmtTimeOnly = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const fmtDateTime = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };

  const drawBox = (x: number, yp: number, w: number, h: number) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.rect(x, yp, w, h);
  };

  const drawField = (label: string, value: string, x: number, yp: number, w: number, h: number = 10) => {
    drawBox(x, yp, w, h);
    doc.setFontSize(5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(label, x + 1, yp + 3);
    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    const lines = doc.splitTextToSize(value || '-', w - 2);
    doc.text(lines.slice(0, 2), x + 1, yp + 7);
  };

  const emitName = invoice.issuerName || 'EMPRESA EMITENTE';
  const emitCnpj = invoice.issuerCnpj || '';
  const emitIe = invoice.issuerIe || '';
  const emitAddress = invoice.issuerAddress || '';
  const emitPhone = invoice.issuerPhone || '';
  const emitCity = invoice.issuerCity || '';
  const emitUf = invoice.issuerUf || '';
  const nfNum = invoice.invoiceNumber || '0';
  const nfSerie = invoice.series || '1';
  const emissionDate = invoice.emissionDate || invoice.createdAt;
  const accessKey = invoice.accessKey || '';
  const formattedKey = accessKey ? accessKey.replace(/(.{4})/g, '$1 ').trim() : '';

  const canhotH = 22;
  drawBox(margin, y, contentWidth - 40, canhotH);
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  const canhotText = `RECEBEMOS DE ${emitName} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA ABAIXO.`;
  const canhotLines = doc.splitTextToSize(canhotText, contentWidth - 46);
  doc.text(canhotLines, margin + 2, y + 4);
  doc.setFontSize(5.5);
  doc.text(`EMISSÃO: ${fmtDateOnly(emissionDate)}    VALOR TOTAL: R$ ${fmtCur(invoice.totalInvoice || '0')}    DESTINATÁRIO: ${invoice.customerName || ''}`, margin + 2, y + 10);
  const destAddrShort = invoice.customerAddress || '';
  if (destAddrShort) {
    doc.setFontSize(5);
    const addrShort = doc.splitTextToSize(destAddrShort, contentWidth - 46);
    doc.text(addrShort.slice(0, 1), margin + 2, y + 13);
  }
  doc.setFontSize(5);
  doc.text('DATA DE RECEBIMENTO', margin + 2, y + 17);
  doc.setLineWidth(0.2);
  doc.line(margin + 30, y + 17.5, margin + 50, y + 17.5);
  doc.text('IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR', margin + 52, y + 17);
  doc.line(margin + 95, y + 17.5, contentWidth - 42, y + 17.5);

  drawBox(contentWidth - 40 + margin, y, 40, canhotH);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('NF-e', contentWidth - 40 + margin + 20, y + 7, { align: 'center' });
  doc.setFontSize(9);
  doc.text(`Nº ${nfNum}`, contentWidth - 40 + margin + 20, y + 13, { align: 'center' });
  doc.setFontSize(7);
  doc.text(`Série ${nfSerie}`, contentWidth - 40 + margin + 20, y + 18, { align: 'center' });

  y += canhotH;

  doc.setLineDashPattern([2, 2], 0);
  doc.setLineWidth(0.2);
  doc.line(margin, y + 1, pageWidth - margin, y + 1);
  doc.setLineDashPattern([], 0);
  y += 3;

  const headerH = 32;
  const col1W = 80;
  const col2W = 42;
  const col3HeaderW = contentWidth - col1W - col2W;

  drawBox(margin, y, col1W, headerH);
  drawBox(margin + col1W, y, col2W, headerH);
  drawBox(margin + col1W + col2W, y, col3HeaderW, headerH);

  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('IDENTIFICAÇÃO DO EMITENTE', margin + col1W / 2, y + 3, { align: 'center' });
  doc.setTextColor(0);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  const emitNameLines = doc.splitTextToSize(emitName, col1W - 4);
  doc.text(emitNameLines.slice(0, 2), margin + 2, y + 8);
  const emitNameH = Math.min(emitNameLines.length, 2) * 3.5;
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  const emitAddrLines = doc.splitTextToSize(emitAddress, col1W - 4);
  doc.text(emitAddrLines.slice(0, 2), margin + 2, y + 8 + emitNameH + 1);
  const cityLine = emitCity && emitUf ? `${emitCity} - ${emitUf}` : '';
  const phoneLine = emitPhone ? `Fone: ${emitPhone}` : '';
  const cityPhoneLine = [cityLine, phoneLine].filter(Boolean).join('  ');
  if (cityPhoneLine) {
    doc.text(cityPhoneLine, margin + 2, y + 8 + emitNameH + 1 + Math.min(emitAddrLines.length, 2) * 3 + 1);
  }

  const danfeCenterX = margin + col1W + col2W / 2;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('DANFE', danfeCenterX, y + 7, { align: 'center' });
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.text('Documento Auxiliar', danfeCenterX, y + 10.5, { align: 'center' });
  doc.text('da Nota Fiscal', danfeCenterX, y + 13, { align: 'center' });
  doc.text('Eletrônica', danfeCenterX, y + 15.5, { align: 'center' });
  doc.setFontSize(6);
  const isEntrada = invoice.operationType === 'entrada';
  doc.text(`0 - ENTRADA`, danfeCenterX - 2, y + 19, { align: 'center' });
  doc.text(`1 - SAÍDA`, danfeCenterX - 2, y + 22, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(isEntrada ? '0' : '1', danfeCenterX + 18, y + 21, { align: 'center' });
  doc.setLineWidth(0.3);
  doc.rect(danfeCenterX + 14, y + 17, 8, 6);
  doc.setFontSize(7);
  doc.text(`Nº ${nfNum}`, danfeCenterX, y + 26, { align: 'center' });
  doc.text(`Série ${nfSerie}`, danfeCenterX, y + 29, { align: 'center' });
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Folha 1/1', danfeCenterX, y + 32, { align: 'center' });

  const keyColX = margin + col1W + col2W;
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('CHAVE DE ACESSO', keyColX + col3HeaderW / 2, y + 3, { align: 'center' });
  doc.setTextColor(0);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  if (formattedKey) {
    const keyLines = doc.splitTextToSize(formattedKey, col3HeaderW - 4);
    doc.text(keyLines, keyColX + 2, y + 8);
  } else {
    doc.text('N/A', keyColX + 2, y + 8);
  }
  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.text('Consulta de autenticidade no portal nacional da NF-e', keyColX + 2, y + 18);
  doc.text('www.nfe.fazenda.gov.br/portal', keyColX + 2, y + 21);
  doc.text('ou no site da Sefaz Autorizadora', keyColX + 2, y + 24);

  y += headerH;

  const natW = contentWidth * 0.55;
  const protW = contentWidth - natW;
  drawField('NATUREZA DA OPERAÇÃO', invoice.natureOfOperation || 'Venda de Producao do Estabelecimento', margin, y, natW, 10);
  drawField('PROTOCOLO DE AUTORIZAÇÃO DE USO', `${invoice.protocolNumber || ''}    -    ${fmtDateTime(invoice.authorizationDate || emissionDate)}`, margin + natW, y, protW, 10);
  y += 10;

  const ieW = contentWidth * 0.35;
  const ieStW = contentWidth * 0.35;
  const cnpjW = contentWidth - ieW - ieStW;
  drawField('INSCRIÇÃO ESTADUAL', emitIe, margin, y, ieW, 10);
  drawField('INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.', '', margin + ieW, y, ieStW, 10);
  drawField('CNPJ', emitCnpj, margin + ieW + ieStW, y, cnpjW, 10);
  y += 10;

  if (isHomologacao) {
    drawBox(margin, y, contentWidth, 7);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(200, 0, 0);
    doc.text('SEM VALOR FISCAL - EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO', centerX, y + 5, { align: 'center' });
    doc.setTextColor(0);
    y += 7;
  }

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0);
  doc.text('DESTINATÁRIO / REMETENTE', margin + 2, y + 3.5);
  y += 5;

  const destNameW = contentWidth * 0.55;
  const destCnpjW = contentWidth * 0.25;
  const destDateW = contentWidth - destNameW - destCnpjW;
  drawField('NOME / RAZÃO SOCIAL', invoice.customerName || '', margin, y, destNameW, 10);
  drawField('CNPJ / CPF', invoice.customerCnpjCpf || '', margin + destNameW, y, destCnpjW, 10);
  drawField('DATA DA EMISSÃO', fmtDateOnly(emissionDate), margin + destNameW + destCnpjW, y, destDateW, 10);
  y += 10;

  const destAddrW = contentWidth * 0.45;
  const destBairroW = contentWidth * 0.2;
  const destCepW = contentWidth * 0.15;
  const destExitDateW = contentWidth - destAddrW - destBairroW - destCepW;
  drawField('ENDEREÇO', invoice.customerAddress || '', margin, y, destAddrW, 10);
  drawField('BAIRRO / DISTRITO', invoice.customerBairro || '', margin + destAddrW, y, destBairroW, 10);
  drawField('CEP', invoice.customerCep || '', margin + destAddrW + destBairroW, y, destCepW, 10);
  drawField('DATA DA SAÍDA/ENTRADA', fmtDateOnly(emissionDate), margin + destAddrW + destBairroW + destCepW, y, destExitDateW, 10);
  y += 10;

  const destMuniW = contentWidth * 0.35;
  const destUfW = contentWidth * 0.05;
  const destFoneW = contentWidth * 0.2;
  const destIeW = contentWidth * 0.2;
  const destHourW = contentWidth - destMuniW - destUfW - destFoneW - destIeW;
  drawField('MUNICÍPIO', invoice.customerCity || '', margin, y, destMuniW, 10);
  drawField('UF', invoice.customerUf || '', margin + destMuniW, y, destUfW, 10);
  drawField('FONE / FAX', invoice.customerPhone || '', margin + destMuniW + destUfW, y, destFoneW, 10);
  drawField('INSCRIÇÃO ESTADUAL', invoice.customerIe || '', margin + destMuniW + destUfW + destFoneW, y, destIeW, 10);
  drawField('HORA DA SAÍDA/ENTRADA', fmtTimeOnly(emissionDate), margin + destMuniW + destUfW + destFoneW + destIeW, y, destHourW, 10);
  y += 10;

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('FATURA / DUPLICATA', margin + 2, y + 3.5);
  y += 5;

  const payLabels: Record<string, string> = {
    'a_vista': 'À Vista', 'a_prazo': 'A Prazo', 'pix': 'PIX',
    'boleto': 'Boleto', 'cartao': 'Cartão', 'dinheiro': 'Dinheiro'
  };
  const fatW = contentWidth / 4;
  drawField('Num.', '001', margin, y, fatW, 12);
  drawField('Venc.', invoice.dueDate ? fmtDateOnly(invoice.dueDate) : fmtDateOnly(emissionDate), margin + fatW, y, fatW, 12);
  drawField('Valor', `R$ ${fmtCur(invoice.totalInvoice || '0')}`, margin + fatW * 2, y, fatW, 12);
  drawField('Forma Pagamento', payLabels[invoice.paymentMethod] || invoice.paymentMethod || '-', margin + fatW * 3, y, fatW, 12);
  y += 12;

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('CÁLCULO DO IMPOSTO', margin + 2, y + 3.5);
  y += 5;

  const col7 = contentWidth / 7;
  drawField('BASE DE CÁLCULO DO ICMS', fmtCur(invoice.totalBaseIcms || '0'), margin, y, col7, 10);
  drawField('VALOR DO ICMS', fmtCur(invoice.totalIcms || '0'), margin + col7, y, col7, 10);
  drawField('BASE DE CÁLC. ICMS S.T.', fmtCur(invoice.totalBaseIcmsSt || '0'), margin + col7 * 2, y, col7, 10);
  drawField('VALOR DO ICMS SUBST.', fmtCur(invoice.totalIcmsSt || '0'), margin + col7 * 3, y, col7, 10);
  drawField('VALOR IMP. IMPORTAÇÃO', '0,00', margin + col7 * 4, y, col7, 10);
  drawField('VALOR DO PIS', fmtCur(invoice.totalPis || '0'), margin + col7 * 5, y, col7, 10);
  drawField('VALOR TOTAL DOS PRODUTOS', fmtCur(invoice.totalProducts || '0'), margin + col7 * 6, y, col7, 10);
  y += 10;

  drawField('VALOR DO FRETE', fmtCur(invoice.totalFreight || '0'), margin, y, col7, 10);
  drawField('VALOR DO SEGURO', fmtCur(invoice.totalInsurance || '0'), margin + col7, y, col7, 10);
  drawField('DESCONTO', fmtCur(invoice.totalDiscount || '0'), margin + col7 * 2, y, col7, 10);
  drawField('OUTRAS DESPESAS', fmtCur(invoice.totalOtherExpenses || '0'), margin + col7 * 3, y, col7, 10);
  drawField('VALOR TOTAL DO IPI', fmtCur(invoice.totalIpi || '0'), margin + col7 * 4, y, col7, 10);
  drawField('VALOR DA COFINS', fmtCur(invoice.totalCofins || '0'), margin + col7 * 5, y, col7, 10);
  drawField('VALOR TOTAL DA NOTA', fmtCur(invoice.totalInvoice || '0'), margin + col7 * 6, y, col7, 10);
  y += 10;

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('TRANSPORTADOR / VOLUMES TRANSPORTADOS', margin + 2, y + 3.5);
  y += 5;

  const trNameW = contentWidth * 0.3;
  const trFreteW = contentWidth * 0.15;
  const trAnttW = contentWidth * 0.15;
  const trPlacaW = contentWidth * 0.15;
  const trUfTrW = contentWidth * 0.05;
  const trCnpjTrW = contentWidth - trNameW - trFreteW - trAnttW - trPlacaW - trUfTrW;
  drawField('NOME / RAZÃO SOCIAL', '', margin, y, trNameW, 10);
  drawField('FRETE POR CONTA', '(9) Sem Frete', margin + trNameW, y, trFreteW, 10);
  drawField('CÓDIGO ANTT', '', margin + trNameW + trFreteW, y, trAnttW, 10);
  drawField('PLACA DO VEÍCULO', '', margin + trNameW + trFreteW + trAnttW, y, trPlacaW, 10);
  drawField('UF', '', margin + trNameW + trFreteW + trAnttW + trPlacaW, y, trUfTrW, 10);
  drawField('CNPJ / CPF', '', margin + trNameW + trFreteW + trAnttW + trPlacaW + trUfTrW, y, trCnpjTrW, 10);
  y += 10;

  const trQtdW = contentWidth / 6;
  drawField('QUANTIDADE', '', margin, y, trQtdW, 10);
  drawField('ESPÉCIE', '', margin + trQtdW, y, trQtdW, 10);
  drawField('MARCA', '', margin + trQtdW * 2, y, trQtdW, 10);
  drawField('NUMERAÇÃO', '', margin + trQtdW * 3, y, trQtdW, 10);
  drawField('PESO BRUTO (KG)', '', margin + trQtdW * 4, y, trQtdW, 10);
  drawField('PESO LÍQUIDO (KG)', '', margin + trQtdW * 5, y, trQtdW, 10);
  y += 10;

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('DADOS DOS PRODUTOS / SERVIÇOS', margin + 2, y + 3.5);
  y += 5;

  const items = invoice.items || [];
  const tableHead = [['CÓDIGO\nPRODUTO', 'DESCRIÇÃO DO PRODUTO / SERVIÇO', 'NCM/SH', 'O/CSOSN', 'CFOP', 'UN', 'QUANT', 'VALOR\nUNIT', 'VALOR\nTOTAL', 'B.CÁLC\nICMS', 'VALOR\nICMS', 'VALOR\nIPI', 'ALÍQ.\nICMS', 'ALÍQ.\nIPI']];
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^p-[0-9a-f]{8}-/.test(s);
  const tableBody = items.map((item: DanfeInvoiceItem) => [
    (item.productCode && !isUuid(item.productCode)) ? item.productCode : String(item.itemNumber || ''),
    item.productName || '',
    item.ncm || '',
    item.csosn || item.cstIcms || '0102',
    item.cfop || invoice.cfop || '',
    item.unit || 'UN',
    fmtQty(item.quantity),
    fmtCur(item.unitPrice),
    fmtCur(item.totalPrice),
    fmtCur(item.baseIcms || '0'),
    fmtCur(item.valorIcms || '0'),
    fmtCur(item.valorIpi || '0'),
    item.aliqIcms ? `${item.aliqIcms}` : '0,00',
    item.aliqIpi ? `${item.aliqIpi}` : '0,00',
  ]);

  autoTable(doc, {
    startY: y,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: { fontSize: 5, cellPadding: 1, lineWidth: 0.2, lineColor: [0, 0, 0], overflow: 'linebreak' },
    headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 4.5, cellPadding: 1 },
    columnStyles: {
      0: { cellWidth: 14 },
      1: { cellWidth: 42 },
      2: { cellWidth: 14 },
      3: { cellWidth: 10 },
      4: { cellWidth: 10 },
      5: { cellWidth: 8 },
      6: { cellWidth: 14, halign: 'right' },
      7: { cellWidth: 14, halign: 'right' },
      8: { cellWidth: 14, halign: 'right' },
      9: { cellWidth: 14, halign: 'right' },
      10: { cellWidth: 14, halign: 'right' },
      11: { cellWidth: 12, halign: 'right' },
      12: { cellWidth: 8, halign: 'right' },
      13: { cellWidth: 8, halign: 'right' },
    },
    margin: { left: margin, right: margin },
    showHead: 'everyPage',
  });

  y = (doc as any).lastAutoTable.finalY + 2;

  const pageHeight = doc.internal.pageSize.getHeight();
  if (y > pageHeight - 60) {
    doc.addPage();
    y = margin;
  }

  drawBox(margin, y, contentWidth, 5);
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.text('DADOS ADICIONAIS', margin + 2, y + 3.5);
  y += 5;

  const infoW = contentWidth * 0.65;
  const fiscoW = contentWidth - infoW;
  const infoH = 20;
  drawBox(margin, y, infoW, infoH);
  drawBox(margin + infoW, y, fiscoW, infoH);

  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('INFORMAÇÕES COMPLEMENTARES', margin + 2, y + 3);
  doc.text('RESERVADO AO FISCO', margin + infoW + 2, y + 3);
  doc.setTextColor(0);

  doc.setFontSize(5.5);
  const notesText = invoice.notes || '';
  const noteLines = doc.splitTextToSize(notesText, infoW - 4);
  doc.text(noteLines.slice(0, 6), margin + 2, y + 6);

  y += infoH;

  doc.setFontSize(5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  const printDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  doc.text(`Impresso em ${printDate}`, margin, y + 4);
  doc.text('Sistema Integra - Beba Honest', pageWidth - margin, y + 4, { align: 'right' });
  doc.setTextColor(0);
}
