// ============================================================================
// CENTRAL DE MARKETING — o Pixel do navegador, do lado da loja
// ----------------------------------------------------------------------------
// O codigo base do Pixel e injetado pelo SERVIDOR (mkt-google.ts), condicionado
// a existir META_PIXEL_ID. Este arquivo so dispara os eventos do funil.
//
// TRES DECISOES QUE VALEM MAIS QUE O CODIGO:
//
// 1. Marketing NUNCA pode derrubar a loja. Se o Pixel nao foi injetado,
//    window.fbq simplesmente nao existe e toda funcao daqui vira no-op. Nenhuma
//    chamada lanca: tudo mora dentro de try/catch. Pior cenario possivel = a
//    Meta nao aprende nada. O cliente compra do mesmo jeito.
//
// 2. Purchase dispara UMA VEZ por pedido, e a trava sobrevive a recarga da
//    pagina. A tela de sucesso e alcancada por quatro caminhos diferentes
//    (pedido direto, PIX confirmado no polling, cartao, Google Pay). Contar a
//    mesma venda quatro vezes ensinaria a Meta a mentira mais cara possivel:
//    que o anuncio rende 4x o que rende.
//
// 3. Nada de dado pessoal aqui. Nome, telefone, CPF e endereco NAO entram em
//    evento de navegador. O que a Meta precisa saber e o que foi comprado e por
//    quanto — quem comprou e problema do servidor, e so quando houver base legal.
// ============================================================================

type Dados = Record<string, any>;

const CHAVE_VISTOS = 'honest-pixel-vistos';
const TETO_VISTOS = 30; // memoria curta: o suficiente para uma sessao de compra

function temPixel(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).fbq === 'function';
}

/** Dispara um evento padrao do Pixel. Silencioso e sem excecao, por desenho. */
export function pixel(evento: string, dados?: Dados): void {
  try {
    if (!temPixel()) return;
    (window as any).fbq('track', evento, dados || {});
  } catch { /* marketing nunca quebra a loja */ }
}

/**
 * Dispara no maximo uma vez por chave. A lista fica em localStorage para que
 * F5 na tela de sucesso nao vire uma segunda venda.
 * Devolve true se disparou agora.
 */
export function pixelUmaVez(chave: string, evento: string, dados?: Dados): boolean {
  try {
    if (!temPixel()) return false;
    let vistos: string[] = [];
    try { vistos = JSON.parse(localStorage.getItem(CHAVE_VISTOS) || '[]'); } catch { vistos = []; }
    if (!Array.isArray(vistos)) vistos = [];
    if (vistos.includes(chave)) return false;

    (window as any).fbq('track', evento, dados || {});

    vistos.push(chave);
    // Navegador em modo privado pode recusar a escrita. O evento ja saiu; perder
    // a trava e ruim, mas nao e motivo para derrubar nada.
    try { localStorage.setItem(CHAVE_VISTOS, JSON.stringify(vistos.slice(-TETO_VISTOS))); } catch { /* ok */ }
    return true;
  } catch {
    return false;
  }
}

/** Formato que a Meta espera em content_ids/contents. */
export function conteudos(itens: Array<{ id: string; quantity: number; price: number }>) {
  return {
    content_type: 'product',
    content_ids: itens.map(i => String(i.id)),
    contents: itens.map(i => ({ id: String(i.id), quantity: Number(i.quantity) || 1, item_price: Number(i.price) || 0 })),
    num_items: itens.reduce((s, i) => s + (Number(i.quantity) || 1), 0),
  };
}
