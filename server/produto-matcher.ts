// ============================================================================
// INTEGRA 2.0 — Casamento do nome dito pelo cliente com o produto do catalogo (nov/2026)
//
// Caso Carolina Lopes: ela pediu "4 Maracuja 350ml" e "4 Morango c/ Maracuja 350ml" e o
// robo perguntou se "Maracuja" era o puro ou o de morango — o casamento antigo era por
// SUBSTRING ("maracuja" esta dentro de "MORANGO COM MARACUJA"). Pior: "Limao 350ml" casava
// sozinho com "MORANGO COM LIMAO 350ml" (o produto certo era a LIMONADA).
//
// Regra nova, nesta ordem:
//   1) separa SABOR e TAMANHO (350/900) do nome, ignorando palavras genericas
//      (suco, misto, fruta, de, com, ml...);
//   2) sabor IGUAL ao pedido (mesmo conjunto de palavras) -> e esse; se houver tamanho no
//      pedido, filtra por ele;
//   3) senao, produtos cujo sabor CONTEM o pedido: um so e nao e sabor composto ("X com Y")
//      -> e esse ("pink" -> PINK LEMONADE); sabor composto ou varios -> pergunta;
//   4) "limao" sozinho = LIMONADA (sinonimo).
// Nunca escolhe um sabor composto quando o cliente disse so uma das frutas.
// ============================================================================

const GENERICAS = new Set([
  'suco', 'sucos', 'misto', 'mista', 'fruta', 'de', 'da', 'do', 'das', 'dos', 'com', 'c', 'e',
  'a', 'o', 'as', 'os', 'sabor', 'ml', 'l', 'lt', 'un', 'und', 'unid', 'garrafa', 'garrafinha',
  'para', 'por', 'natural',
]);

const SINONIMOS: Record<string, string[]> = {
  limao: ['limonada'],
  lemonade: ['pink', 'lemonade'],
};

const norm = (x: any) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function analisar(nome: string): { sabor: string[]; tamanho: string | null; composto: boolean } {
  const n = norm(nome);
  const tam = n.match(/(\d{3,4})\s*m?l\b/) || n.match(/\b(\d{3,4})\b/);
  const toks = n.split(/[^0-9a-z]+/).filter((t) => t && !/^\d+m?l?$/.test(t) && !GENERICAS.has(t));
  return { sabor: Array.from(new Set(toks)), tamanho: tam ? tam[1] : null, composto: /\bcom\b|\bc\//.test(n) };
}

const mesmoConjunto = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.includes(t));
const contem = (maior: string[], menor: string[]) => menor.length > 0 && menor.every((t) => maior.includes(t));

export type ResultadoProduto =
  | { tipo: 'ok'; produto: any }
  | { tipo: 'ambiguo'; opcoes: any[] }
  | { tipo: 'nao_encontrado' };

export function resolverProduto(termo: string, catalogo: any[], campoNome = 'name'): ResultadoProduto {
  const q = analisar(termo);
  if (!q.sabor.length) return { tipo: 'nao_encontrado' };
  let itens = catalogo.map((p) => ({ p, a: analisar(p[campoNome]) }));
  if (q.tamanho) {
    const mesmoTam = itens.filter((x) => x.a.tamanho === q.tamanho);
    if (mesmoTam.length) itens = mesmoTam;
  }
  const tentar = (sabor: string[]): ResultadoProduto | null => {
    const iguais = itens.filter((x) => mesmoConjunto(x.a.sabor, sabor));
    if (iguais.length === 1) return { tipo: 'ok', produto: iguais[0].p };
    if (iguais.length > 1) return { tipo: 'ambiguo', opcoes: iguais.map((x) => x.p) };
    const contidos = itens.filter((x) => contem(x.a.sabor, sabor));
    if (contidos.length === 1 && !contidos[0].a.composto) return { tipo: 'ok', produto: contidos[0].p };
    if (contidos.length >= 1) return { tipo: 'ambiguo', opcoes: contidos.map((x) => x.p) };
    return null;
  };
  // Sinonimo primeiro quando o pedido e SO a palavra do sinonimo ("limao" -> limonada).
  if (q.sabor.length === 1 && SINONIMOS[q.sabor[0]]) {
    const r = tentar(SINONIMOS[q.sabor[0]]);
    if (r && r.tipo === 'ok') return r;
  }
  return tentar(q.sabor) || { tipo: 'nao_encontrado' };
}
