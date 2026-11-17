// ============================================================================
// PEDIDO EM PACKS — regra para PESSOA JURÍDICA (nov/2026)
// ----------------------------------------------------------------------------
// Decisão do Flavio: CNPJ não compra unidade quebrada. Cada sabor tem de fechar
// em pack inteiro ou meio pack, podendo somar vários (não há teto por sabor).
// Na prática: a quantidade precisa ser MÚLTIPLA DO MEIO PACK.
//
//   350 ml → fardo de 12 → meio pack 6  → vale 6, 12, 18, 24, 30…
//   900 ml → fardo de  6 → meio pack 3  → vale 3, 6, 9, 12, 15…
//
// Quebrados (4, 5, 10, 14…) são recusados. Pessoa física não muda em nada.
//
// O tamanho do pack vem do CADASTRO (fardo_filas × fardo_por_fila), não do nome
// do produto: renomear "900ml" para "900 mL" não pode desligar a regra.
// Produto sem dado de fardo (bombona, brinde) fica FORA da regra — barrar por
// desconhecimento recusaria venda boa.
//
// Roda igual no navegador e no Node: nada de banco nem de DOM aqui.
// ============================================================================

export interface ItemPedidoPack {
  nome?: string | null;
  quantidade: number;
  /** fardo_filas × fardo_por_fila do cadastro. Ausente/0 = produto sem regra. */
  unidadesPorFardo?: number | string | null;
}

export interface ItemForaDoPack {
  nome: string;
  quantidade: number;
  pack: number;
  meioPack: number;
  /** Maior quantidade válida abaixo da pedida (0 quando não há). */
  abaixo: number;
  /** Menor quantidade válida acima da pedida. */
  acima: number;
}

const inteiro = (v: any): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Unidades por fardo a partir das filas do cadastro. 0 = sem dado. */
export function unidadesPorFardo(filas: any, porFila: any): number {
  return inteiro(filas) * inteiro(porFila);
}

/**
 * Meio pack. Só existe quando o fardo é par — fardo ímpar não tem metade
 * inteira, e aí a regra não se aplica (devolve 0).
 */
export function meioPack(pack: any): number {
  const p = inteiro(pack);
  if (!p || p % 2 !== 0) return 0;
  return p / 2;
}

/** A quantidade fecha em packs e meios packs? Sem dado de fardo, sempre sim. */
export function quantidadeFechaEmPack(quantidade: any, pack: any): boolean {
  const meio = meioPack(pack);
  if (!meio) return true;
  const q = inteiro(quantidade);
  if (!q) return true; // quantidade inválida é problema de outra validação
  return q % meio === 0;
}

/** Vizinhas válidas, para a tela sugerir o ajuste em vez de só recusar. */
export function vizinhasValidas(quantidade: any, pack: any): { abaixo: number; acima: number } {
  const meio = meioPack(pack);
  const q = inteiro(quantidade);
  if (!meio || !q) return { abaixo: 0, acima: 0 };
  return { abaixo: Math.floor(q / meio) * meio, acima: Math.ceil(q / meio) * meio || meio };
}

/** Só dígitos — aceita CNPJ com ou sem máscara. */
export function ehPessoaJuridica(documento: any, customerType?: any): boolean {
  const tipo = String(customerType || '').trim().toLowerCase();
  if (tipo === 'pessoa_juridica' || tipo === 'pj') return true;
  if (tipo === 'pessoa_fisica' || tipo === 'pf') return false;
  return String(documento ?? '').replace(/\D/g, '').length === 14;
}

/**
 * Regra única, usada pela loja, pelo servidor e pela IA do Instagram.
 * Devolve [] quando está tudo certo (ou quando o cliente não é PJ).
 */
export function itensForaDoPack(itens: ItemPedidoPack[]): ItemForaDoPack[] {
  const fora: ItemForaDoPack[] = [];
  for (const it of itens || []) {
    const pack = inteiro(it?.unidadesPorFardo);
    const meio = meioPack(pack);
    if (!meio) continue;
    const q = inteiro(it?.quantidade);
    if (!q || q % meio === 0) continue;
    const v = vizinhasValidas(q, pack);
    fora.push({ nome: String(it?.nome || 'produto'), quantidade: q, pack, meioPack: meio, abaixo: v.abaixo, acima: v.acima });
  }
  return fora;
}

/** "6 ou 12" / "3, 6 ou 9" — o que oferecer no lugar da quantidade quebrada. */
export function textoSugestao(item: ItemForaDoPack): string {
  const opcoes = item.abaixo > 0 ? [item.abaixo, item.acima] : [item.acima];
  return opcoes.join(' ou ');
}

/** Frase pronta para o cliente, listando o que ajustar. */
export function mensagemForaDoPack(fora: ItemForaDoPack[]): string {
  if (!fora.length) return '';
  const partes = fora.map((f) => `${f.nome}: ${f.quantidade} un — use ${textoSugestao(f)}`);
  return 'Para CNPJ, cada sabor precisa fechar em pack ou meio pack. '
    + `Ajuste ${fora.length > 1 ? 'os itens' : 'o item'}: ${partes.join('; ')}.`;
}

/**
 * Barreira pronta para o `res.status(400).json(...)`. `null` = pode seguir.
 * Só age quando o cliente é PJ; pessoa física passa direto.
 */
export function barrarPackPJ(
  documento: any,
  customerType: any,
  itens: ItemPedidoPack[],
): null | { message: string; code: string; itens: ItemForaDoPack[] } {
  if (!ehPessoaJuridica(documento, customerType)) return null;
  const fora = itensForaDoPack(itens);
  if (!fora.length) return null;
  return { message: mensagemForaDoPack(fora), code: 'PACK_INCOMPLETO_PJ', itens: fora };
}

/** Bloco do system prompt — ensina a regra ANTES de a IA montar o pedido. */
export function blocoPromptPackPJ(): string {
  return [
    '# PEDIDO EM PACK — SO PARA CNPJ (pessoa juridica)',
    'Cliente com CNPJ nao leva unidade quebrada: cada sabor tem de fechar em pack ou meio pack.',
    '- 350 ml: pack 12, meio pack 6. Valem 6, 12, 18, 24, 30…',
    '- 900 ml: pack 6, meio pack 3. Valem 3, 6, 9, 12, 15…',
    '- Quebrados (4, 5, 10, 14…) NAO podem. Se o cliente pedir um desses, ofereca as duas',
    '  quantidades validas mais proximas e pergunte qual ele prefere. Nao escolha por ele.',
    '- Pessoa fisica (CPF) compra a quantidade que quiser: nao mencione pack para ela.',
    '- Enquanto nao souber o documento, nao suponha: so aplique a regra depois de saber que e CNPJ.',
  ].join('\n');
}
