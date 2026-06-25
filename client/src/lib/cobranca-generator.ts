import jsPDF from 'jspdf';
import { renderDanfeToDoc, type DanfeInvoice } from './danfe-generator';

export interface CobrancaData {
  itemId: string;
  customerName?: string;
  sellerName?: string;
  invoiceNumber?: string;
  saleValue?: string | number;
  products?: any;
  boleto?: any | null;
  pix?: any | null;
  danfe?: DanfeInvoice | null;
}

const BRL = (v: any) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: any) => { if (!s) return '-'; const d = new Date(s); return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('pt-BR'); };

// Interleaved 2 of 5 barcode (boleto, 44 digitos)
function drawI25(doc: jsPDF, raw: string, x: number, y: number, height: number) {
  let code = (raw || '').replace(/\D/g, '');
  if (code.length % 2 !== 0) code = '0' + code;
  const P: Record<string, number[]> = { '0':[0,0,1,1,0],'1':[1,0,0,0,1],'2':[0,1,0,0,1],'3':[1,1,0,0,0],'4':[0,0,1,0,1],'5':[1,0,1,0,0],'6':[0,1,1,0,0],'7':[0,0,0,1,1],'8':[1,0,0,1,0],'9':[0,1,0,1,0] };
  const n = 0.38, w = n * 3; let cx = x;
  doc.setFillColor(0, 0, 0);
  // start 0000
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

function header(doc: jsPDF, title: string) {
  doc.setFontSize(14); doc.setFont('helvetica', 'bold');
  doc.text(title, 105, 15, { align: 'center' });
  doc.setDrawColor(0); doc.line(10, 18, 200, 18);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
}

function kv(doc: jsPDF, label: string, val: string, y: number) {
  doc.setFont('helvetica', 'bold'); doc.text(label, 12, y);
  doc.setFont('helvetica', 'normal'); doc.text(val || '-', 62, y);
}

function renderBoleto(doc: jsPDF, c: CobrancaData) {
  const b = c.boleto || {}; header(doc, 'Boleto de Cobranca'); let y = 30;
  kv(doc, 'Pagador:', b.debtor_name || c.customerName || '-', y); y += 7;
  kv(doc, 'CPF/CNPJ:', b.debtor_document || '-', y); y += 7;
  kv(doc, 'Nota Fiscal:', c.invoiceNumber || '-', y); y += 7;
  kv(doc, 'Vencimento:', fmtDate(b.data_vencimento), y); y += 7;
  kv(doc, 'Valor:', BRL(b.valor_original), y); y += 7;
  kv(doc, 'Nosso Numero:', String(b.nosso_numero || '-'), y); y += 7;
  kv(doc, 'Convenio:', String(b.numero_convenio || '-'), y); y += 10;
  doc.setFont('helvetica', 'bold'); doc.text('Linha Digitavel:', 12, y); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.text(String(b.linha_digitavel || '-'), 12, y); y += 9; doc.setFontSize(10);
  if (b.codigo_barras) { drawI25(doc, String(b.codigo_barras), 12, y, 14); y += 20; }
  if (b.instrucoes) { doc.setFontSize(9); doc.text('Instrucoes: ' + String(b.instrucoes).slice(0, 240), 12, y, { maxWidth: 186 }); y += 12; doc.setFontSize(10); }
  if (b.pix_qr_code_base64) {
    doc.setFont('helvetica', 'bold'); doc.text('PIX (pague pelo QR):', 12, y); y += 3;
    try { doc.addImage('data:image/png;base64,' + b.pix_qr_code_base64, 'PNG', 12, y, 34, 34); } catch (e) {}
    if (b.pix_copia_e_cola) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(String(b.pix_copia_e_cola), 50, y + 6, { maxWidth: 148 }); doc.setFontSize(10); }
  }
}

function renderPix(doc: jsPDF, c: CobrancaData) {
  const p = c.pix || {}; header(doc, 'Cobranca PIX'); let y = 30;
  kv(doc, 'Cliente:', p.debtor_name || c.customerName || '-', y); y += 7;
  kv(doc, 'Nota Fiscal:', c.invoiceNumber || '-', y); y += 7;
  kv(doc, 'Valor:', BRL(p.amount), y); y += 7;
  kv(doc, 'Vencimento:', fmtDate(p.due_date || p.expires_at), y); y += 7;
  kv(doc, 'Status:', String(p.status || '-'), y); y += 10;
  const qr = p.qr_code_base64;
  if (qr) { try { doc.addImage(String(qr).startsWith('data:') ? String(qr) : 'data:image/png;base64,' + qr, 'PNG', 12, y, 45, 45); } catch (e) {} }
  if (p.pix_copia_e_cola) { doc.setFont('helvetica', 'bold'); doc.text('PIX copia e cola:', 64, y + 4); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(String(p.pix_copia_e_cola), 64, y + 9, { maxWidth: 132 }); doc.setFontSize(10); }
}

function renderPedido(doc: jsPDF, c: CobrancaData) {
  header(doc, 'Pedido'); let y = 30;
  kv(doc, 'Cliente:', c.customerName || '-', y); y += 7;
  kv(doc, 'Vendedor:', c.sellerName || '-', y); y += 7;
  kv(doc, 'Nota Fiscal:', c.invoiceNumber || '-', y); y += 7;
  kv(doc, 'Valor Total:', BRL(c.saleValue), y); y += 10;
  let prods: any[] = [];
  try { prods = Array.isArray(c.products) ? c.products : (c.products ? JSON.parse(c.products) : []); } catch (e) { prods = []; }
  if (prods.length) {
    doc.setFont('helvetica', 'bold'); doc.text('Produtos:', 12, y); y += 6; doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    prods.slice(0, 35).forEach((p: any) => {
      const name = p.name || p.productName || p.description || '-'; const qty = p.quantity || p.qty || ''; const val = p.total || p.value || p.price || '';
      doc.text((qty ? qty + 'x ' : '') + String(name).slice(0, 62), 12, y); if (val) doc.text(BRL(val), 198, y, { align: 'right' }); y += 5;
      if (y > 280) { doc.addPage(); y = 20; }
    });
    doc.setFontSize(10);
  }
}

export function generateMultiCobrancaPdf(list: CobrancaData[]): number {
  const valid = list.filter((c) => c.boleto || c.pix);
  if (valid.length === 0) return 0;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  valid.forEach((c, i) => { if (i > 0) doc.addPage(); if (c.boleto) renderBoleto(doc, c); else renderPix(doc, c); });
  doc.save('cobrancas_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return valid.length;
}

export function generateCompletoPdf(list: CobrancaData[]): number {
  if (list.length === 0) return 0;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  let first = true;
  list.forEach((c) => {
    if (!first) doc.addPage(); first = false;
    renderPedido(doc, c);
    if (c.danfe) { doc.addPage(); try { renderDanfeToDoc(doc, c.danfe); } catch (e) {} }
    if (c.boleto) { doc.addPage(); renderBoleto(doc, c); }
    else if (c.pix) { doc.addPage(); renderPix(doc, c); }
  });
  doc.save('completo_' + new Date().toISOString().slice(0, 10) + '.pdf');
  return list.length;
}
