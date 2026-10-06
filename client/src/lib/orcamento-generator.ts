// ============================================================================
// Gerador de ORÇAMENTO DE VENDA em PDF (jsPDF), reutilizável.
// ----------------------------------------------------------------------------
// Mesmo layout do orçamento que o SaleModal já gera ("Retomar" um rascunho),
// extraído para um módulo próprio para também ser usado direto no card de
// Rascunhos (tela de Cartões), sem precisar abrir o modal.
// Recebe os dados já prontos (produtos, pagamento, operação, cliente, vendedor)
// e dispara o download do PDF.
// ============================================================================

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { writeLine, brl } from '@/lib/pdfLayout';
import honestLogo from '@/assets/honest-logo.png';
import { PAYMENT_METHOD_LABELS, OPERATION_TYPE_LABELS } from '@shared/schema';

export interface OrcamentoItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice?: number;
}

export interface OrcamentoInput {
  customer?: {
    fantasyName?: string | null;
    name?: string | null;
    cnpj?: string | null;
    cpf?: string | null;
    phone?: string | null;
  } | null;
  seller?: { firstName?: string | null; lastName?: string | null } | null;
  products: OrcamentoItem[];
  paymentMethod?: string | null;
  boletoDays?: number | null;
  operationType?: string | null;
}

/** Gera e baixa o PDF do orçamento. Retorna o nome do arquivo gerado. */
export function generateOrcamentoPdf(input: OrcamentoInput): string {
  const pdf = new jsPDF();

  // Logomarca no canto superior direito (falha de imagem não derruba o PDF).
  try { pdf.addImage(honestLogo, 'PNG', 150, 10, 40, 40); } catch (e) { /* noop */ }

  pdf.setFontSize(20);
  pdf.text('ORÇAMENTO DE VENDA', 20, 30);

  // Cabeçalho com cursor seguro (abre nova página se não couber) — igual ao SaleModal.
  let hy = 50;
  hy = writeLine(pdf, hy, ['Honest Sucos', 'Sucos Naturais e Saudáveis'], { size: 12, gap: 7 });

  const customer = input.customer;
  if (customer) {
    const dadosCliente = [`Cliente: ${customer.fantasyName || customer.name || '-'}`];
    if (customer.cnpj) dadosCliente.push(`CNPJ: ${customer.cnpj}`);
    else if (customer.cpf) dadosCliente.push(`CPF: ${customer.cpf}`);
    if (customer.phone) dadosCliente.push(`Telefone: ${customer.phone}`);
    hy = writeLine(pdf, hy + 4, dadosCliente, { size: 12, gap: 7 });
  }

  const seller = input.seller;
  if (seller && (seller.firstName || seller.lastName)) {
    hy = writeLine(pdf, hy, `Vendedor: ${`${seller.firstName || ''} ${seller.lastName || ''}`.trim()}`, { size: 12, gap: 7 });
  }

  const pm = String(input.paymentMethod || '');
  const ot = String(input.operationType || 'venda');
  const dadosPedido = [
    `Número do Orçamento: HS-${Date.now()}`,
    `Data: ${new Date().toLocaleDateString('pt-BR')}`,
    `Forma de Pagamento: ${(PAYMENT_METHOD_LABELS as any)[pm] || pm || '-'}`,
  ];
  if (pm === 'boleto' && input.boletoDays) dadosPedido.push(`Prazo do Boleto: ${input.boletoDays} dias`);
  dadosPedido.push(`Tipo de Operação: ${(OPERATION_TYPE_LABELS as any)[ot] || ot}`);
  hy = writeLine(pdf, hy + 4, dadosPedido, { size: 12, gap: 7 });

  // Normaliza itens (recalcula total da linha quando ausente).
  const items = (Array.isArray(input.products) ? input.products : []).map((i) => {
    const quantity = Number(i.quantity) || 0;
    const unitPrice = Number(i.unitPrice) || 0;
    const totalPrice = (i.totalPrice != null && String(i.totalPrice) !== '')
      ? (Number(i.totalPrice) || 0)
      : quantity * unitPrice;
    return { name: String(i.name || ''), quantity, unitPrice, totalPrice };
  });

  const totalSale = items.reduce((s, i) => s + (i.totalPrice || 0), 0);
  const totalItens = items.reduce((s, i) => s + (i.quantity || 0), 0);

  autoTable(pdf, {
    head: [['Produto', 'Qtd', 'Preço Unit.', 'Total']],
    body: items.map((i) => [i.name, String(i.quantity), brl(i.unitPrice), brl(i.totalPrice)]),
    foot: [[`TOTAL (${items.length} itens / ${totalItens} un.)`, '', '', brl(totalSale)]],
    showFoot: 'lastPage',
    startY: Math.max(hy + 6, 60),
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: [41, 128, 185], textColor: 255 },
    footStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: 'bold' },
  });

  let y = ((pdf as any).lastAutoTable?.finalY || 250) + 10;
  y = writeLine(pdf, y, `TOTAL GERAL: ${brl(totalSale)}`, { size: 14, gap: 10 });

  writeLine(pdf, y + 4, [
    'Observações:',
    '- Este orçamento tem validade de 15 dias.',
    '- Preços sujeitos a alteração sem aviso prévio.',
    '- Produtos naturais, sem conservantes.',
  ], { size: 10 });

  const nomeCli = (customer?.fantasyName || customer?.name || 'cliente');
  const fileName = `orcamento-${nomeCli}-${Date.now()}.pdf`;
  pdf.save(fileName);
  return fileName;
}
