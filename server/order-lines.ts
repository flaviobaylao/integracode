// ============================================================================
// LINHAS DE PEDIDO — regra unica: PEDIDO NAO ACEITA ITEM SEM QUANTIDADE
// ----------------------------------------------------------------------------
// Motivo (caso real, 31/ago/2026): as NF-e 104366 e 104367 sairam autorizadas
// com itens em QUANT 0,0000 / VALOR 0,00. Nao foi erro de impressao nem de
// estoque: o card do pipeline tinha linhas com quantity 0 no JSON de products,
// e createInvoiceFromPipelineItem copiava a linha para a NF sem nenhum filtro
// (`quantity: p.quantity.toString()`). As linhas zeradas nao entravam no total
// — eram linhas fantasma — mas foram parar na SEFAZ. Item com qCom = 0 e
// irregular e pode ser questionado em fiscalizacao / travar a escrituracao do
// cliente.
//
// Como a linha zerada nascia: ao trocar um formato por outro (900ml no lugar de
// 350ml) a linha antiga era ZERADA em vez de removida do array.
//
// Estrategia em duas camadas (decisao do Flavio, 02/set/2026):
//   1. ENTRADA  → a linha zerada e DESCARTADA (nao trava a operacao de ninguem).
//   2. EMISSAO  → se mesmo assim sobrar uma (dado legado, importacao, caminho
//                 novo que ninguem lembrou de sanear), o faturamento e a
//                 transmissao BLOQUEIAM com erro claro.
// A camada 2 e a rede: ela nao depende de lembrarem de chamar a camada 1.
// ============================================================================

export interface OrderLine {
  id?: string | null;
  name?: string | null;
  quantity?: any;
  unitPrice?: any;
  totalPrice?: any;
  [key: string]: any;
}

/** Quantidade da linha como numero. Texto, null, undefined e lixo viram 0. */
export function lineQuantity(line: any): number {
  if (line == null) return 0;
  const raw = line.quantity;
  if (raw == null || raw === '') return 0;
  // Aceita "1,5" (pt-BR) alem de "1.5" — a industria trabalha com quantidade decimal.
  const n = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Rotulo legivel da linha, para mensagem de erro e log. */
export function lineLabel(line: any, index?: number): string {
  const nome = String(line?.name || '').trim();
  if (nome) return nome;
  const id = line?.id != null ? String(line.id) : '';
  if (id) return `produto ${id}`;
  return index != null ? `item ${index + 1}` : 'item sem nome';
}

/** As linhas com quantidade <= 0 (ou invalida). Vazio = pedido saudavel. */
export function findZeroQuantityLines(products: any): OrderLine[] {
  if (!Array.isArray(products)) return [];
  return products.filter((l) => lineQuantity(l) <= 0);
}

/**
 * CAMADA 1 — ENTRADA. Devolve o array sem as linhas de quantidade zero.
 * Nao lanca: se o pedido inteiro for zerado, devolve array vazio e quem chamou
 * decide (o total ja e recalculado a partir dos produtos em quem grava).
 * `products` que nao e array volta como veio (null/undefined/legado nao viram []).
 */
export function sanitizeOrderLines(
  products: any,
  contexto?: string,
): { lines: any; dropped: OrderLine[] } {
  if (!Array.isArray(products)) return { lines: products, dropped: [] };
  const dropped: OrderLine[] = [];
  const lines: OrderLine[] = [];
  for (const l of products) {
    if (lineQuantity(l) > 0) lines.push(l);
    else dropped.push(l);
  }
  if (dropped.length > 0) {
    const nomes = dropped.map((l, i) => lineLabel(l, i)).join(', ');
    console.warn(
      `🧹 [ORDER-LINES] ${dropped.length} item(ns) sem quantidade descartado(s)` +
        `${contexto ? ` em ${contexto}` : ''}: ${nomes}`,
    );
  }
  return { lines, dropped };
}

/** Erro de negocio da camada 2 — reconhecivel por `code` nas rotas. */
export class ZeroQuantityLineError extends Error {
  code = 'ZERO_QTY_LINE';
  lines: OrderLine[];
  constructor(message: string, lines: OrderLine[]) {
    super(message);
    this.name = 'ZeroQuantityLineError';
    this.lines = lines;
  }
}

/** Mensagem unica, para a tela e para o log dizerem a mesma coisa. */
export function zeroQuantityMessage(zeradas: OrderLine[]): string {
  const nomes = zeradas.map((l, i) => lineLabel(l, i)).join(', ');
  return (
    `Pedido com ${zeradas.length} item(ns) sem quantidade: ${nomes}. ` +
    `Remova a linha do pedido (ou informe a quantidade) antes de faturar — ` +
    `item com quantidade zero nao pode ir para a nota fiscal.`
  );
}

/**
 * CAMADA 2 — BLOQUEIO. Use antes de faturar/emitir.
 * Retorna { valid:false, message } em vez de lancar, para as rotas devolverem 400.
 */
export function validateOrderLines(products: any): {
  valid: boolean;
  message?: string;
  zeroLines: OrderLine[];
} {
  const zeroLines = findZeroQuantityLines(products);
  if (zeroLines.length === 0) return { valid: true, zeroLines: [] };
  return { valid: false, message: zeroQuantityMessage(zeroLines), zeroLines };
}

/** CAMADA 2 em forma de guarda: lanca ZeroQuantityLineError. */
export function assertNoZeroQuantityLines(products: any, contexto?: string): void {
  const { valid, message, zeroLines } = validateOrderLines(products);
  if (!valid) {
    console.error(`🚫 [ORDER-LINES]${contexto ? ` ${contexto}:` : ''} ${message}`);
    throw new ZeroQuantityLineError(message!, zeroLines);
  }
}
