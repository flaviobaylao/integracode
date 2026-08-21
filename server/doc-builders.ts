// ============================================================================
// INTEGRA 2.0 — MONTAGEM DOS DOCUMENTOS PARA ENVIO AUTOMATICO (lado servidor)
//
// Ate aqui todo PDF do sistema nascia no NAVEGADOR (client/src/lib/*-generator).
// Para o envio automatico (que roda no servidor, sem ninguem na tela) os mesmos
// documentos precisam nascer em Node:
//   • DANFE  -> reaproveita renderDanfeToDoc do gerador do front (mesmo desenho
//               da DANFE que o pessoal ja imprime; jspdf roda igual em Node).
//   • XML    -> texto que ja esta no banco (xml_autorizacao).
//   • Boleto/PIX -> folha simples com linha digitavel, QR e copia-e-cola.
//   • Pedido -> espelho enxuto do pedido (itens, valor, forma de pagamento).
//
// O danfe-generator so importa jspdf/jspdf-autotable (sem alias @shared e sem
// API de browser obrigatoria: o carregamento do logo e por fetch dentro de
// try/catch, que em Node simplesmente devolve null). Por isso da para importar
// direto daqui sem mexer no comando de build do servidor.
// ============================================================================
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { renderDanfeToDoc } from '../client/src/lib/danfe-generator';
import type { DocFile } from './doc-delivery';

function novoDoc(): any {
  return new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
}

function pdfBuffer(doc: any): Buffer {
  return Buffer.from(doc.output('arraybuffer'));
}

function brl(v: any): string {
  const n = Number(v || 0);
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function limpaNome(s: any): string {
  return String(s || 'documento').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
}

// ---------------------------------------------------------------------------
// DANFE (PDF) — recebe a nota no MESMO formato de GET /api/fiscal-invoices/:id
// ({ ...invoice, items }), que e o que o gerador do front ja consome.
// ---------------------------------------------------------------------------
export function montarDanfePdf(invoice: any): DocFile {
  const doc = novoDoc();
  renderDanfeToDoc(doc, invoice as any, null);
  const num = limpaNome(invoice?.invoiceNumber || invoice?.id);
  return { filename: `DANFE_${num}.pdf`, mime: 'application/pdf', content: pdfBuffer(doc) };
}

// ---------------------------------------------------------------------------
// XML da NF-e — prioriza o XML DE AUTORIZACAO (o unico que vale para o cliente
// escriturar). Sem ele, nao manda nada: XML de envio nao tem protocolo.
// ---------------------------------------------------------------------------
export function montarXmlNfe(invoice: any): DocFile | null {
  const xml = invoice?.xmlAutorizacao || invoice?.xml_autorizacao;
  if (!xml) return null;
  const base = limpaNome(invoice?.accessKey || ('NFe_' + (invoice?.invoiceNumber || invoice?.id)));
  return { filename: `${base}.xml`, mime: 'application/xml', content: Buffer.from(String(xml), 'utf8') };
}

// ---------------------------------------------------------------------------
// Boleto / PIX — folha de cobranca com o que o cliente precisa para pagar.
// ---------------------------------------------------------------------------
export interface CobrancaDoc {
  tipo: 'boleto' | 'pix';
  pagador?: string | null;
  documento?: string | null;
  valor?: any;
  vencimento?: any;
  linhaDigitavel?: string | null;
  nossoNumero?: string | null;
  pixCopiaECola?: string | null;
  qrBase64?: string | null;
}

export function montarCobrancaPdf(c: CobrancaDoc): DocFile {
  const doc = novoDoc();
  let y = 20;
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text(c.tipo === 'boleto' ? 'Boleto Banco do Brasil' : 'Cobrança PIX', 15, y); y += 8;

  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  doc.text(`Pagador: ${c.pagador || '-'}${c.documento ? '  ·  ' + c.documento : ''}`, 15, y); y += 5;
  const venc = c.vencimento ? new Date(c.vencimento).toLocaleDateString('pt-BR') : '';
  if (venc) { doc.text(`Vencimento: ${venc}`, 15, y); y += 5; }
  if (c.nossoNumero) { doc.text(`Nosso número: ${c.nossoNumero}`, 15, y); y += 5; }
  y += 3;

  doc.setFontSize(20); doc.setFont('helvetica', 'bold');
  doc.text(brl(c.valor), 15, y); y += 12;

  if (c.qrBase64) {
    try { doc.addImage('data:image/png;base64,' + c.qrBase64, 'PNG', 15, y, 55, 55); } catch { /* QR opcional */ }
    y += 60;
  }

  doc.setFontSize(9); doc.setFont('helvetica', 'bold');
  if (c.pixCopiaECola) {
    doc.text('PIX copia e cola', 15, y); y += 5;
    doc.setFont('helvetica', 'normal');
    for (const linha of doc.splitTextToSize(String(c.pixCopiaECola), 180)) { doc.text(linha, 15, y); y += 4; }
    y += 5;
  }
  if (c.linhaDigitavel) {
    doc.setFont('helvetica', 'bold');
    doc.text('Linha digitável', 15, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text(String(c.linhaDigitavel), 15, y); y += 8;
  }

  doc.setFontSize(8); doc.setTextColor(120);
  doc.text('Honest Sucos — documento gerado automaticamente.', 15, 285);

  const nome = c.tipo === 'boleto' ? `Boleto_${limpaNome(c.nossoNumero || '')}` : `PIX_${limpaNome(c.pagador || '')}`;
  return { filename: `${nome}.pdf`, mime: 'application/pdf', content: pdfBuffer(doc) };
}

// ---------------------------------------------------------------------------
// Pedido — espelho enxuto do que foi vendido. Nao substitui a DANFE: serve para
// o cliente conferir o que vem antes do faturamento.
// ---------------------------------------------------------------------------
export interface PedidoDoc {
  numero?: string | null;
  cliente?: string | null;
  documento?: string | null;
  vendedor?: string | null;
  data?: any;
  valor?: any;
  formaPagamento?: string | null;
  observacao?: string | null;
  produtos?: any; // array, ou JSON string vindo do banco
}

function normalizaProdutos(p: any): any[] {
  if (!p) return [];
  let arr = p;
  if (typeof p === 'string') { try { arr = JSON.parse(p); } catch { return []; } }
  return Array.isArray(arr) ? arr : [];
}

export function montarPedidoPdf(ped: PedidoDoc): DocFile {
  const doc = novoDoc();
  let y = 18;
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text('Pedido', 15, y); y += 7;

  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  if (ped.numero) { doc.text(`Número: ${ped.numero}`, 15, y); y += 5; }
  doc.text(`Cliente: ${ped.cliente || '-'}${ped.documento ? '  ·  ' + ped.documento : ''}`, 15, y); y += 5;
  if (ped.vendedor) { doc.text(`Vendedor: ${ped.vendedor}`, 15, y); y += 5; }
  const dt = ped.data ? new Date(ped.data).toLocaleDateString('pt-BR') : '';
  if (dt) { doc.text(`Data: ${dt}`, 15, y); y += 5; }
  if (ped.formaPagamento) { doc.text(`Pagamento: ${ped.formaPagamento}`, 15, y); y += 5; }
  y += 4;

  const itens = normalizaProdutos(ped.produtos).map((it: any) => {
    const qtd = Number(it.quantity ?? it.quantidade ?? it.qtd ?? 0);
    const unit = Number(it.unitPrice ?? it.price ?? it.valorUnitario ?? 0);
    const total = Number(it.total ?? it.totalPrice ?? (qtd * unit));
    return [
      String(it.name || it.description || it.produto || it.productName || '-').slice(0, 60),
      qtd ? String(qtd) : '-',
      unit ? brl(unit) : '-',
      total ? brl(total) : '-',
    ];
  });

  if (itens.length) {
    autoTable(doc, {
      startY: y,
      head: [['Produto', 'Qtd', 'Unit.', 'Total']],
      body: itens,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [22, 122, 70] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
      margin: { left: 15, right: 15 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  doc.setFontSize(13); doc.setFont('helvetica', 'bold');
  doc.text(`Total do pedido: ${brl(ped.valor)}`, 15, y); y += 8;

  if (ped.observacao) {
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text('Observações:', 15, y); y += 4;
    for (const linha of doc.splitTextToSize(String(ped.observacao), 180)) { doc.text(linha, 15, y); y += 4; }
  }

  doc.setFontSize(8); doc.setTextColor(120);
  doc.text('Honest Sucos — documento gerado automaticamente.', 15, 285);

  return { filename: `Pedido_${limpaNome(ped.numero || ped.cliente || '')}.pdf`, mime: 'application/pdf', content: pdfBuffer(doc) };
}
