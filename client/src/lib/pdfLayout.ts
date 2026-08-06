// ============================================================================
// Helpers de layout para os PDFs gerados no navegador (jsPDF).
// ----------------------------------------------------------------------------
// Motivo: os geradores de Pedido de Venda / Orçamento escreviam o total e as
// observações em coordenadas fixas somadas ao `finalY` da tabela
// (`finalY + 20`, `finalY + 60`...). Quando a tabela de produtos terminava
// perto do rodapé da folha A4 (por volta de 8 itens), esse Y passava de 297mm
// e o jsPDF desenhava o texto FORA da página — o PDF saía sem o total.
// Aqui o cursor sempre confere se cabe e, se não couber, abre uma página nova.
// ============================================================================

export const PDF_MARGIN_BOTTOM = 12;
export const PDF_MARGIN_TOP = 20;

/** Devolve um Y seguro: se `needed` não couber na página atual, abre outra. */
export function ensureSpace(pdf: any, y: number, needed = 10): number {
  const pageHeight = pdf.internal.pageSize.getHeight();
  if (y + needed > pageHeight - PDF_MARGIN_BOTTOM) {
    pdf.addPage();
    return PDF_MARGIN_TOP;
  }
  return y;
}

/**
 * Escreve uma linha (ou várias) respeitando a quebra de página e devolve o
 * próximo Y livre. Use em vez de `pdf.text(..., finalY + N)`.
 */
export function writeLine(
  pdf: any,
  y: number,
  text: string | string[],
  opts?: { size?: number; x?: number; gap?: number }
): number {
  const size = opts?.size ?? 10;
  const x = opts?.x ?? 20;
  const gap = opts?.gap ?? 7;
  const lines = Array.isArray(text) ? text : [text];
  pdf.setFontSize(size);
  let cur = y;
  for (const line of lines) {
    cur = ensureSpace(pdf, cur, gap);
    pdf.text(line, x, cur);
    cur += gap;
  }
  return cur;
}

/** Formata em reais sem depender de locale do navegador. */
export function brl(v: number): string {
  return `R$ ${(Number(v) || 0).toFixed(2).replace(".", ",")}`;
}
