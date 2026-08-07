import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { renderDanfeToDoc, type DanfeInvoice } from './danfe-generator';

export interface CobrancaData {
  itemId: string;
  customerName?: string;
  sellerName?: string;
  invoiceNumber?: string;
  saleValue?: string | number;
  products?: any;
  observation?: string | null;
  boleto?: any | null;
  pix?: any | null;
  danfe?: DanfeInvoice | null;
  // ▼ Dados da ROTA — preenchidos quando a impressão sai da roteirização.
  // Aparecem numa faixa logo ACIMA do rodapé da folha de pedido.
  driverName?: string | null;
  vehicleType?: string | null;
  stopOrder?: number | null;   // nº da ordem desta entrega dentro da rota
  stopCount?: number | null;   // total de paradas da rota (ex.: "3 de 14")
  routeDate?: string | null;   // YYYY-MM-DD
}

/** Uma rota (motorista) pronta para impressão — usada na folha de rosto. */
export interface RotaImpressao {
  routeId?: string;
  driverName?: string | null;
  vehicleType?: string | null;
  licensePlate?: string | null;
  routeDate?: string | null;
  startAddress?: string | null;
  totalDistance?: number | string | null;
  totalDuration?: number | string | null;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  stops: Array<{
    stopOrder?: number | null;
    billingId?: string | null;
    customerName?: string | null;
    customerAddress?: string | null;
    orderNumber?: string | null;
    invoiceNumber?: string | null;
    saleValue?: number | string | null;
    estimatedArrival?: string | null;
    distanceFromPrevious?: number | string | null;
    isPriority?: boolean | null;
  }>;
}

const COMPANY = 'PURO INDUSTRIA E COMERCIO DE PRODUTOS NATURAIS LTDA';
const GREEN: [number, number, number] = [31, 111, 67];

const BRL = (v: any) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: any) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: any) => { if (!s) return '-'; const d = new Date(s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('pt-BR'); };
const today = () => new Date().toLocaleDateString('pt-BR');

// Logo carregada uma vez (public/honest-logo.png) e cacheada.
let _logo: string | null | undefined;
async function loadLogo(): Promise<string | null> {
  if (_logo !== undefined) return _logo as string | null;
  try {
    const r = await fetch('/honest-logo.png');
    const blob = await r.blob();
    _logo = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onloadend = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(blob); });
  } catch { _logo = null; }
  return _logo as string | null;
}
// Proporção real do honest-logo.png (619 x 490 px). Usada p/ desenhar o logo
// sem distorção: os parâmetros (w,h) viram uma CAIXA e o logo é ajustado dentro
// dela mantendo a razão largura/altura (contain, alinhado no topo-esquerda).
const LOGO_RATIO = 619 / 490;
function putLogo(doc: jsPDF, logo: string | null, x: number, y: number, w: number, h: number) {
  if (!logo) return;
  let dw = w, dh = w / LOGO_RATIO;
  if (dh > h) { dh = h; dw = h * LOGO_RATIO; }
  try { doc.addImage(logo, 'PNG', x, y, dw, dh); } catch (e) {}
}

// Interleaved 2 of 5 barcode (boleto, 44 digitos)
function drawI25(doc: jsPDF, raw: string, x: number, y: number, height: number) {
  let code = (raw || '').replace(/\D/g, '');
  if (code.length % 2 !== 0) code = '0' + code;
  const P: Record<string, number[]> = { '0':[0,0,1,1,0],'1':[1,0,0,0,1],'2':[0,1,0,0,1],'3':[1,1,0,0,0],'4':[0,0,1,0,1],'5':[1,0,1,0,0],'6':[0,1,1,0,0],'7':[0,0,0,1,1],'8':[1,0,0,1,0],'9':[0,1,0,1,0] };
  const n = 0.38, w = n * 3; let cx = x;
  doc.setFillColor(0, 0, 0);
  doc.rect(cx, y, n, height, 'F'); cx += n * 2; doc.rect(cx, y, n, height, 'F'); cx += n * 2;
  for (let i = 0; i < code.length; i += 2) {
    const a = P[code[i]] || P['0']; const b = P[code[i + 1]] || P['0'];
    for (let j = 0; j < 5; j++) {
      const bw = a[j] ? w : n; doc.rect(cx, y, bw, height, 'F'); cx += bw;
      cx += b[j] ? w : n;
    }
  }
  doc.rect(cx, y, w, height, 'F'); cx += w + n; doc.rect(cx, y, n, height, 'F');
}

function kv(doc: jsPDF, label: string, val: string, y: number) {
  doc.setFont('helvetica', 'bold'); doc.text(label, 12, y);
  doc.setFont('helvetica', 'normal'); doc.text(val || '-', 55, y);
}

// ── Cabecalho comum com logo ────────────────────────────────────────────────
function brandHeader(doc: jsPDF, logo: string | null, title: string) {
  putLogo(doc, logo, 12, 9, 32, 13);
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
  doc.text(COMPANY, 47, 11.5);
  doc.setTextColor(80); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
  doc.text('AVENIDA T 63, nº 4446, QUADRA 03 LOTE 71 SALA 1 E GALPAO, ANHANGUERA', 47, 15);
  doc.text('Goiânia/GO · CEP 74.335-102 · CNPJ 28.295.493/0002-34', 47, 18);
  doc.text('Contato: (62) 3093-5050 · (62) 99327-5962 · (62) 99322-9699 · (62) 99578-2812', 47, 21);
  doc.setTextColor(0); doc.setFontSize(15); doc.setFont('helvetica', 'bold');
  doc.text(title, 198, 14, { align: 'right' });
  doc.setDrawColor(...GREEN); doc.setLineWidth(0.6); doc.line(12, 24, 198, 24); doc.setLineWidth(0.2); doc.setDrawColor(0);
}

function parseProducts(c: CobrancaData): any[] {
  try { return Array.isArray(c.products) ? c.products : (c.products ? JSON.parse(c.products) : []); } catch { return []; }
}

// ── PEDIDO ───────────────────────────────────────────────────────────────────
function renderPedido(doc: jsPDF, c: CobrancaData, logo: string | null) {
  brandHeader(doc, logo, 'PEDIDO');
  const d = c.danfe || ({} as any);
  const cidade = d.customerCity || '-';
  const bairro = d.customerBairro || '-';
  const uf = d.customerUf || '';

  // Destaque cidade/bairro no topo
  doc.setFillColor(...GREEN); doc.rect(12, 28, 186, 11, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('CIDADE', 15, 32.5); doc.text('BAIRRO', 108, 32.5);
  doc.setFontSize(12);
  doc.text(String(cidade + (uf ? ' - ' + uf : '')).slice(0, 42), 15, 37.5);
  doc.text(String(bairro).slice(0, 40), 108, 37.5);
  doc.setTextColor(0);

  // Dados do pedido
  let y = 47; doc.setFontSize(10);
  kv(doc, 'Cliente:', c.customerName || d.customerName || '-', y); y += 6.5;
  kv(doc, 'Vendedor:', c.sellerName || '-', y); y += 6.5;
  kv(doc, 'Nota Fiscal:', c.invoiceNumber || '-', y);
  doc.setFont('helvetica', 'bold'); doc.text('Data:', 130, y); doc.setFont('helvetica', 'normal'); doc.text(today(), 150, y);
  y += 8;

  // Tabela de itens
  const prods = parseProducts(c);
  let totQty = 0, totVal = 0;
  const body = prods.map((p: any, i: number) => {
    const name = p.name || p.productName || p.description || '-';
    const qty = Number(p.quantity ?? p.qty ?? 0);
    const unit = Number(p.unitPrice ?? p.price ?? p.valor_unitario ?? (p.total && qty ? Number(p.total) / qty : 0)) || 0;
    const tot = Number(p.total ?? p.totalPrice ?? p.value ?? (unit * qty)) || 0;
    totQty += qty; totVal += tot;
    return [String(i + 1), String(name).slice(0, 60), num(qty), BRL(unit), BRL(tot)];
  });

  autoTable(doc, {
    startY: y,
    head: [['#', 'Descrição do Produto', 'Qtd', 'Vlr Unit', 'Vlr Total']],
    body: body.length ? body : [['-', 'Sem itens', '', '', '']],
    foot: [['', 'TOTAL', num(totQty), '', BRL(totVal)]],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 1.6 },
    headStyles: { fillColor: GREEN, textColor: 255, halign: 'center', fontStyle: 'bold' },
    footStyles: { fillColor: [235, 245, 238], textColor: 0, fontStyle: 'bold' },
    columnStyles: {
      0: { halign: 'center', cellWidth: 10 },
      1: { cellWidth: 96 },
      2: { halign: 'center', cellWidth: 22 },
      3: { halign: 'right', cellWidth: 28 },
      4: { halign: 'right', cellWidth: 30 },
    },
    margin: { left: 12, right: 12 },
  });

  const fy = (doc as any).lastAutoTable?.finalY || y + 20;
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('Valor Total do Pedido: ' + BRL(c.saleValue ?? totVal), 198, fy + 8, { align: 'right' });
  doc.setFont('helvetica', 'normal');

  // ── Rodapé: ENDEREÇO COMPLETO DO CLIENTE + OBSERVAÇÃO DO PEDIDO ──────────────
  // Endereço vem da NF-e vinculada (logradouro/nº, bairro, cidade/UF, CEP);
  // a observação é o campo "Observações" do pedido (item.notes do pipeline).
  const fullAddr = [
    d.customerAddress,
    bairro !== '-' ? bairro : '',
    cidade !== '-' ? (cidade + (uf ? '/' + uf : '')) : '',
    d.customerCep ? 'CEP ' + d.customerCep : '',
  ].filter((p) => p && String(p).trim() && String(p).trim() !== '-').join(' · ');
  const obsText = (c.observation && String(c.observation).trim()) ? String(c.observation).trim() : 'Sem observação';

  const pageH = (doc as any).internal.pageSize.getHeight ? (doc as any).internal.pageSize.getHeight() : 297;
  const addrLines = doc.splitTextToSize(fullAddr || '-', 186);
  const obsLines = doc.splitTextToSize(obsText, 186);

  // ── Faixa da ENTREGA (motorista + ordem da parada) — fica ACIMA do rodapé ──
  // Só aparece quando a folha é impressa a partir de uma rota; na impressão
  // avulsa do Pipeline de Faturamento o bloco é omitido (layout inalterado).
  const temRota = !!(c.driverName || (c.stopOrder != null && c.stopOrder > 0));
  const rotaBlockH = temRota ? 15 : 0;

  const footerBlockH = rotaBlockH + 10 + addrLines.length * 4 + obsLines.length * 4;
  let footY = Math.max(fy + 18, pageH - 12 - footerBlockH);

  if (temRota) {
    const bh = 12;
    doc.setFillColor(235, 245, 238); doc.rect(12, footY, 186, bh, 'F');
    doc.setDrawColor(...GREEN); doc.setLineWidth(0.4); doc.rect(12, footY, 186, bh);
    doc.line(122, footY, 122, footY + bh); doc.line(160, footY, 160, footY + bh);
    doc.setLineWidth(0.2); doc.setDrawColor(0);

    doc.setFontSize(6.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
    doc.text('MOTORISTA / ENTREGADOR', 15, footY + 4);
    doc.text('ORDEM DE ENTREGA', 125, footY + 4);
    doc.text('DATA DA ROTA', 163, footY + 4);

    doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    const motorista = String(c.driverName || '-').toUpperCase().slice(0, 42);
    doc.text(motorista, 15, footY + 9.5);
    if (c.vehicleType) {
      // largura medida AINDA no tamanho 11 (o do nome) — senão o veículo sobrepõe
      const xVeic = 15 + Math.min(doc.getTextWidth(motorista), 82) + 3;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(90);
      doc.text('(' + String(c.vehicleType).toUpperCase() + ')', xVeic, footY + 9.5);
      doc.setTextColor(0);
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    const ordem = c.stopOrder != null && c.stopOrder > 0
      ? String(c.stopOrder) + (c.stopCount ? ' / ' + c.stopCount : '')
      : '-';
    doc.text(ordem, 141, footY + 9.7, { align: 'center' });
    doc.setFontSize(10);
    doc.text(c.routeDate ? fmtDate(c.routeDate + 'T12:00:00') : today(), 179, footY + 9.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    footY += rotaBlockH;
  }

  doc.setDrawColor(...GREEN); doc.setLineWidth(0.5); doc.line(12, footY, 198, footY);
  doc.setLineWidth(0.2); doc.setDrawColor(0);
  footY += 5;
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
  doc.text('ENDEREÇO COMPLETO DO CLIENTE', 12, footY);
  doc.setTextColor(0); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(addrLines, 12, footY + 4.5);
  let obsY = footY + 4.5 + addrLines.length * 4 + 3;
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
  doc.text('OBSERVAÇÃO DO PEDIDO', 12, obsY);
  doc.setTextColor(0); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(obsLines, 12, obsY + 4.5);
}

// ── BOLETO (padrao Banco do Brasil) ─────────────────────────────────────────
function cell(doc: jsPDF, x: number, y: number, w: number, h: number, label: string, value: string, o?: { fs?: number; bold?: boolean; align?: 'left' | 'center' | 'right' }) {
  doc.setDrawColor(0); doc.setLineWidth(0.2); doc.rect(x, y, w, h);
  doc.setFontSize(5.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(110);
  doc.text(label, x + 1, y + 2.6);
  doc.setTextColor(0); doc.setFontSize(o?.fs || 9); doc.setFont('helvetica', o?.bold ? 'bold' : 'normal');
  const al = o?.align || 'left';
  const tx = al === 'right' ? x + w - 1.5 : al === 'center' ? x + w / 2 : x + 1.5;
  doc.text(String(value || ''), tx, y + h - 1.8, { align: al });
}

function renderBoleto(doc: jsPDF, c: CobrancaData, logo: string | null) {
  const b = c.boleto || {};
  brandHeader(doc, logo, 'BOLETO');
  const L = 12, R = 198, W = 186;
  let y = 30;

  // Faixa do banco: logo empresa | 001-9 | linha digitavel
  putLogo(doc, logo, L, y - 1, 26, 9);
  doc.setDrawColor(0); doc.setLineWidth(0.5);
  doc.line(L + 30, y - 1, L + 30, y + 8); doc.line(L + 48, y - 1, L + 48, y + 8);
  doc.setFontSize(15); doc.setFont('helvetica', 'bold'); doc.text('001-9', L + 32, y + 5.5);
  doc.setFontSize(11); doc.text(String(b.linha_digitavel || '-'), R, y + 5, { align: 'right' });
  doc.setLineWidth(0.2);
  doc.setDrawColor(0); doc.line(L, y + 9, R, y + 9);
  y += 10;

  const wVenc = 42;
  cell(doc, L, y, W - wVenc, 8, 'Local de Pagamento', 'Pagável em qualquer banco ou aplicativo até o vencimento', { fs: 8 });
  cell(doc, R - wVenc, y, wVenc, 8, 'Vencimento', fmtDate(b.data_vencimento), { bold: true, align: 'right', fs: 10 }); y += 8;

  cell(doc, L, y, W - wVenc, 8, 'Beneficiário', COMPANY + '  ·  CNPJ ' + (b.beneficiary_document || '28.295.493/0002-34'), { fs: 8 });
  cell(doc, R - wVenc, y, wVenc, 8, 'Agência/Código do Beneficiário', 'Conv. ' + String(b.numero_convenio || '-'), { align: 'right' }); y += 8;

  const c6 = (W - wVenc) / 5;
  cell(doc, L, y, c6, 8, 'Data do Documento', today());
  cell(doc, L + c6, y, c6, 8, 'Nº do Documento', String(c.invoiceNumber || '-'));
  cell(doc, L + c6 * 2, y, c6, 8, 'Espécie DOC', 'DM');
  cell(doc, L + c6 * 3, y, c6, 8, 'Aceite', 'N');
  cell(doc, L + c6 * 4, y, c6, 8, 'Data Processamento', today());
  cell(doc, R - wVenc, y, wVenc, 8, 'Nosso Número', String(b.nosso_numero || '-'), { bold: true, align: 'right' }); y += 8;

  cell(doc, L, y, c6, 8, 'Uso do Banco', '');
  cell(doc, L + c6, y, c6, 8, 'Carteira', String(b.numero_carteira || '17'));
  cell(doc, L + c6 * 2, y, c6, 8, 'Espécie', 'R$');
  cell(doc, L + c6 * 3, y, c6, 8, 'Quantidade', '');
  cell(doc, L + c6 * 4, y, c6, 8, '(x) Valor', '');
  cell(doc, R - wVenc, y, wVenc, 8, '(=) Valor do Documento', BRL(b.valor_original), { bold: true, align: 'right' }); y += 8;

  // Instrucoes + coluna de valores
  const instr = String(b.instrucoes || 'Não receber após o vencimento sem os acréscimos legais.').slice(0, 300);
  const hInstr = 26;
  doc.setDrawColor(0); doc.rect(L, y, W - wVenc, hInstr);
  doc.setFontSize(5.5); doc.setTextColor(110); doc.setFont('helvetica', 'normal'); doc.text('Instruções (texto de responsabilidade do beneficiário)', L + 1, y + 2.6);
  doc.setTextColor(0); doc.setFontSize(8.5); doc.text(instr, L + 1.5, y + 6, { maxWidth: W - wVenc - 3 });
  const labels = ['(-) Desconto/Abatimento', '(-) Outras Deduções', '(+) Mora/Multa', '(+) Outros Acréscimos', '(=) Valor Cobrado'];
  for (let i = 0; i < 5; i++) { cell(doc, R - wVenc, y + i * (hInstr / 5), wVenc, hInstr / 5, labels[i], i === 4 ? BRL(b.valor_original) : '', { fs: 7, align: 'right', bold: i === 4 }); }
  y += hInstr;

  // Pagador
  const pagLine = (b.debtor_name || c.customerName || '-') + '   CPF/CNPJ: ' + (b.debtor_document || '-');
  const pagAddr = [b.debtor_address, b.debtor_bairro, b.debtor_city].filter(Boolean).join(', ');
  doc.setDrawColor(0); doc.rect(L, y, W, 12);
  doc.setFontSize(5.5); doc.setTextColor(110); doc.text('Pagador', L + 1, y + 2.6);
  doc.setTextColor(0); doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text(String(pagLine).slice(0, 90), L + 1.5, y + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); if (pagAddr) doc.text(String(pagAddr).slice(0, 100), L + 1.5, y + 10);
  y += 15;

  // Codigo de barras
  if (b.codigo_barras) { drawI25(doc, String(b.codigo_barras), L, y, 14); y += 16; }

  // PIX (boleto hibrido)
  if (b.pix_qr_code_base64) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('Ou pague via PIX:', L, y + 4);
    try { doc.addImage('data:image/png;base64,' + b.pix_qr_code_base64, 'PNG', L, y + 6, 30, 30); } catch (e) {}
    if (b.pix_copia_e_cola) { doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(String(b.pix_copia_e_cola), L + 34, y + 12, { maxWidth: 150 }); }
  }
}

function renderPix(doc: jsPDF, c: CobrancaData, logo: string | null) {
  const p = c.pix || {}; brandHeader(doc, logo, 'COBRANÇA PIX'); let y = 34; doc.setFontSize(10);
  kv(doc, 'Cliente:', p.debtor_name || c.customerName || '-', y); y += 7;
  kv(doc, 'Nota Fiscal:', c.invoiceNumber || '-', y); y += 7;
  kv(doc, 'Valor:', BRL(p.amount), y); y += 7;
  kv(doc, 'Vencimento:', fmtDate(p.due_date || p.expires_at), y); y += 10;
  const qr = p.qr_code_base64;
  if (qr) { try { doc.addImage(String(qr).startsWith('data:') ? String(qr) : 'data:image/png;base64,' + qr, 'PNG', 12, y, 45, 45); } catch (e) {} }
  if (p.pix_copia_e_cola) { doc.setFont('helvetica', 'bold'); doc.text('PIX copia e cola:', 64, y + 4); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(String(p.pix_copia_e_cola), 64, y + 9, { maxWidth: 132 }); doc.setFontSize(10); }
}

// ── FOLHA DE ROSTO DO MOTORISTA (romaneio da rota) ──────────────────────────
// Uma capa por motorista: cabeçalho com o nome dele, a lista das entregas na
// ordem em que serão feitas e a distância ponto a ponto (trecho + acumulado).
function renderFolhaRosto(doc: jsPDF, rota: RotaImpressao, logo: string | null) {
  brandHeader(doc, logo, 'ROMANEIO');

  const stops = [...(rota.stops || [])].sort(
    (a, b) => (Number(a.stopOrder) || 0) - (Number(b.stopOrder) || 0)
  );

  // Faixa de destaque: motorista / veículo / data
  doc.setFillColor(...GREEN); doc.rect(12, 28, 186, 14, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
  doc.text('MOTORISTA / ENTREGADOR', 15, 32.5);
  doc.text('VEÍCULO', 122, 32.5);
  doc.text('DATA DA ROTA', 160, 32.5);
  doc.setFontSize(13);
  doc.text(String(rota.driverName || '-').toUpperCase().slice(0, 40), 15, 39);
  doc.setFontSize(11);
  doc.text(String(rota.vehicleType || '-').toUpperCase().slice(0, 14) + (rota.licensePlate ? ' · ' + rota.licensePlate : ''), 122, 39);
  doc.text(rota.routeDate ? fmtDate(String(rota.routeDate).slice(0, 10) + 'T12:00:00') : today(), 160, 39);
  doc.setTextColor(0); doc.setFont('helvetica', 'normal');

  // Resumo da rota
  const totalKm = Number(rota.totalDistance) || stops.reduce((s, x) => s + (Number(x.distanceFromPrevious) || 0), 0);
  const totalMin = Math.round(Number(rota.totalDuration) || 0);
  const totalVal = stops.reduce((s, x) => s + (Number(x.saleValue) || 0), 0);
  let y = 48; doc.setFontSize(9);
  doc.setFont('helvetica', 'bold'); doc.text('Saída / retorno:', 12, y);
  doc.setFont('helvetica', 'normal'); doc.text(String(rota.startAddress || '-').slice(0, 60), 40, y);
  doc.setFont('helvetica', 'bold'); doc.text('Janela:', 140, y);
  doc.setFont('helvetica', 'normal'); doc.text((rota.timeWindowStart || '--:--') + ' às ' + (rota.timeWindowEnd || '--:--'), 156, y);
  y += 6;

  const resumo: Array<[string, string]> = [
    ['Entregas', String(stops.length)],
    ['Distância total', totalKm.toFixed(1) + ' km'],
    ['Tempo estimado', totalMin > 0 ? (Math.floor(totalMin / 60) + 'h' + String(totalMin % 60).padStart(2, '0')) : '-'],
    ['Valor total', BRL(totalVal)],
  ];
  const boxW = 186 / resumo.length;
  resumo.forEach(([label, val], i) => {
    const x = 12 + i * boxW;
    doc.setDrawColor(...GREEN); doc.setLineWidth(0.3); doc.rect(x, y, boxW, 12);
    doc.setFontSize(6.5); doc.setTextColor(110); doc.setFont('helvetica', 'normal');
    doc.text(label.toUpperCase(), x + 2, y + 4);
    doc.setFontSize(11); doc.setTextColor(0); doc.setFont('helvetica', 'bold');
    doc.text(val, x + 2, y + 9.5);
  });
  doc.setLineWidth(0.2); doc.setDrawColor(0); doc.setFont('helvetica', 'normal');
  y += 17;

  // Tabela das paradas, com distância do trecho e acumulada
  let acum = 0;
  const body = stops.map((s, i) => {
    const trecho = Number(s.distanceFromPrevious) || 0;
    acum += trecho;
    const nf = (s.invoiceNumber || '').toString().trim();
    const ped = (s.orderNumber || '').toString().trim();
    return [
      String(s.stopOrder ?? i + 1) + (s.isPriority ? ' *' : ''),
      String(s.customerName || '-').slice(0, 38),
      String(s.customerAddress || '-').slice(0, 52),
      [nf, ped].filter(Boolean).join(' / ') || '-',
      s.estimatedArrival || '-',
      trecho.toFixed(1),
      acum.toFixed(1),
      BRL(s.saleValue),
    ];
  });

  autoTable(doc, {
    startY: y,
    head: [['#', 'Cliente', 'Endereço', 'NF / Pedido', 'Chegada', 'Trecho (km)', 'Acum. (km)', 'Valor']],
    body: body.length ? body : [['-', 'Rota sem paradas', '', '', '', '', '', '']],
    foot: [['', 'TOTAL', '', String(stops.length) + ' entrega(s)', '', totalKm.toFixed(1), '', BRL(totalVal)]],
    theme: 'grid',
    // uma parada NUNCA é partida entre duas páginas (o motorista perderia a linha)
    rowPageBreak: 'avoid',
    styles: { fontSize: 7.5, cellPadding: 1.3, overflow: 'linebreak' },
    headStyles: { fillColor: GREEN, textColor: 255, halign: 'center', fontStyle: 'bold', fontSize: 7 },
    footStyles: { fillColor: [235, 245, 238], textColor: 0, fontStyle: 'bold' },
    // Continuação: identifica o motorista no topo das páginas seguintes.
    didDrawPage: (d: any) => {
      if (d.pageNumber > 1) {
        doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...GREEN);
        doc.text(
          'ROMANEIO · ' + String(rota.driverName || '-').toUpperCase() +
          ' · ' + (rota.routeDate ? fmtDate(String(rota.routeDate).slice(0, 10) + 'T12:00:00') : today()) +
          ' (continuação)',
          12, 10,
        );
        doc.setTextColor(0); doc.setFont('helvetica', 'normal');
      }
    },
    columnStyles: {
      0: { halign: 'center', cellWidth: 9 },
      1: { cellWidth: 40 },
      2: { cellWidth: 51 },
      3: { cellWidth: 24, halign: 'center' },
      4: { cellWidth: 15, halign: 'center' },
      5: { cellWidth: 15, halign: 'right' },
      6: { cellWidth: 15, halign: 'right' },
      7: { cellWidth: 17, halign: 'right' },
    },
    margin: { left: 12, right: 12, top: 14 },
  });

  let fy = (doc as any).lastAutoTable?.finalY || y + 20;
  const pageH = (doc as any).internal.pageSize.getHeight ? (doc as any).internal.pageSize.getHeight() : 297;
  if (stops.some(s => s.isPriority)) {
    doc.setFontSize(7); doc.setTextColor(120);
    doc.text('* entrega prioritária', 12, fy + 4); doc.setTextColor(0);
    fy += 4;
  }

  // Assinaturas (conferência da carga e recebimento pelo motorista)
  if (fy + 26 > pageH - 10) { doc.addPage(); fy = 24; }
  const sigY = Math.max(fy + 16, pageH - 30);
  doc.setDrawColor(0); doc.setLineWidth(0.3);
  doc.line(14, sigY, 90, sigY); doc.line(120, sigY, 196, sigY);
  doc.setFontSize(7.5); doc.setTextColor(90);
  doc.text('Conferente / Expedição', 52, sigY + 4, { align: 'center' });
  doc.text('Motorista — recebi os pedidos acima', 158, sigY + 4, { align: 'center' });
  doc.setTextColor(0);
}

/** Só as folhas de rosto (romaneio) — uma página por motorista. */
export async function generateFolhasDeRostoPdf(rotas: RotaImpressao[]): Promise<number> {
  const validas = (rotas || []).filter(r => r && (r.stops || []).length > 0);
  if (validas.length === 0) return 0;
  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  validas.forEach((r, i) => { if (i > 0) doc.addPage(); renderFolhaRosto(doc, r, logo); });
  doc.save('romaneio_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return validas.length;
}

/**
 * Impressão COMPLETA da roteirização: para cada motorista, a folha de rosto e,
 * na sequência, o pacote de cada entrega na ordem da rota
 * (folha de pedido → DANFE → boleto/PIX).
 */
export async function generateRotasCompletoPdf(
  rotas: RotaImpressao[],
  pedidos: CobrancaData[],
): Promise<{ rotas: number; pedidos: number }> {
  const validas = (rotas || []).filter(r => r && (r.stops || []).length > 0);
  if (validas.length === 0) return { rotas: 0, pedidos: 0 };
  const porId = new Map<string, CobrancaData>();
  for (const p of pedidos || []) if (p?.itemId) porId.set(String(p.itemId), p);

  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  let primeira = true;
  let impressos = 0;

  for (const rota of validas) {
    if (!primeira) doc.addPage(); primeira = false;
    renderFolhaRosto(doc, rota, logo);

    const stops = [...rota.stops].sort((a, b) => (Number(a.stopOrder) || 0) - (Number(b.stopOrder) || 0));
    stops.forEach((s, i) => {
      const base = porId.get(String(s.billingId || '')) || {
        itemId: String(s.billingId || ''),
        customerName: s.customerName || undefined,
        invoiceNumber: s.invoiceNumber || undefined,
        saleValue: s.saleValue ?? undefined,
      } as CobrancaData;
      const c: CobrancaData = {
        ...base,
        driverName: rota.driverName,
        vehicleType: rota.vehicleType,
        stopOrder: Number(s.stopOrder) || i + 1,
        stopCount: stops.length,
        routeDate: rota.routeDate ? String(rota.routeDate).slice(0, 10) : null,
      };
      doc.addPage(); renderPedido(doc, c, logo);
      if (c.danfe) { doc.addPage(); try { renderDanfeToDoc(doc, c.danfe, logo); } catch (e) {} }
      if (c.boleto) { doc.addPage(); renderBoleto(doc, c, logo); }
      else if (c.pix) { doc.addPage(); renderPix(doc, c, logo); }
      impressos++;
    });
  }

  doc.save('rotas_completo_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return { rotas: validas.length, pedidos: impressos };
}

export async function generateMultiCobrancaPdf(list: CobrancaData[]): Promise<number> {
  const valid = list.filter((c) => c.boleto || c.pix);
  if (valid.length === 0) return 0;
  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  valid.forEach((c, i) => { if (i > 0) doc.addPage(); if (c.boleto) renderBoleto(doc, c, logo); else renderPix(doc, c, logo); });
  doc.save('cobrancas_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return valid.length;
}

export async function generateCompletoPdf(list: CobrancaData[]): Promise<number> {
  if (list.length === 0) return 0;
  const logo = await loadLogo();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  let first = true;
  list.forEach((c) => {
    if (!first) doc.addPage(); first = false;
    renderPedido(doc, c, logo);
    if (c.danfe) { doc.addPage(); try { renderDanfeToDoc(doc, c.danfe, logo); } catch (e) {} }
    if (c.boleto) { doc.addPage(); renderBoleto(doc, c, logo); }
    else if (c.pix) { doc.addPage(); renderPix(doc, c, logo); }
  });
  doc.save('completo_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return list.length;
}
