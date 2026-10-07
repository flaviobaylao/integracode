// 🍾 GARRAFAS (out/2026) — mockups oficiais das garrafas 350 ml e 900 ml.
// O cadastro de produtos guarda imagens em base64 (pesadas e de estilos diferentes);
// a vitrine passa a usar estes arquivos locais, com fundo recortado, a partir do NOME
// do produto. Produto cujo nome não casa com nenhum sabor continua usando a imagem
// do cadastro — nada some da loja por causa deste mapa.
import type { Product } from '../types';

export type Tamanho = '350' | '900';

export interface Sabor {
  key: string;
  nome: string;
  // cor do rótulo (fundo do cartão) e cor do texto sobre ela
  cor: string;
  tinta: string;
  // composição como está impressa em cada rótulo
  ingredientes: Partial<Record<Tamanho, string>>;
}

// Ordem da vitrine.
export const SABORES: Sabor[] = [
  { key: 'acerola', nome: 'Acerola', cor: '#F07B2C', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã, pera e acerola', '900': 'maçã, pera e acerola' } },
  { key: 'maracuja', nome: 'Maracujá', cor: '#F6C51E', tinta: '#2A2208',
    ingredientes: { '350': 'maçã, pera e maracujá', '900': 'maçã, pera e maracujá' } },
  { key: 'morango-limao', nome: 'Morango com limão', cor: '#E2372F', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã, pera, morango e limão', '900': 'maçã, pera, morango e limão' } },
  { key: 'morango-maracuja', nome: 'Morango com maracujá', cor: '#D9452B', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã, morango e maracujá', '900': 'maçã, pera, morango e maracujá' } },
  { key: 'frutas-vermelhas', nome: 'Frutas vermelhas', cor: '#9E1C35', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã, morango, amora, mirtilo e framboesa', '900': 'maçã, morango, amora, mirtilo e framboesa' } },
  { key: 'pink-lemonade', nome: 'Pink lemonade', cor: '#EC4D6B', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã, pera, framboesa e limão', '900': 'maçã, pera, framboesa e limão' } },
  { key: 'limonada', nome: 'Limonada', cor: '#D6E6BF', tinta: '#174328',
    ingredientes: { '350': 'maçã e limão', '900': 'maçã, pera e limão' } },
  { key: 'uva', nome: 'Uva', cor: '#4A1E46', tinta: '#FFFFFF',
    ingredientes: { '350': 'maçã e uva', '900': 'maçã e uva' } },
];

const semAcento = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// A ordem importa: "MORANGO COM MARACUJA" antes de "MARACUJA" etc.
const REGRAS: [RegExp, string][] = [
  [/MORANGO\s+(COM|C\/?|E)\s+MARACUJA/, 'morango-maracuja'],
  [/MORANGO\s+(COM|C\/?|E)\s+LIMAO/, 'morango-limao'],
  [/PINK\s+LEMONADE/, 'pink-lemonade'],
  [/FRUTAS\s+VERMELHAS/, 'frutas-vermelhas'],
  [/LIMONADA/, 'limonada'],
  [/ACEROLA/, 'acerola'],
  [/MARACUJA/, 'maracuja'],
  [/\bUVA\b/, 'uva'],
];

export function identificar(nome: string): { sabor: Sabor | null; tamanho: Tamanho | null } {
  const n = semAcento(nome || '');
  const tamanho: Tamanho | null = /900\s*ML/.test(n) ? '900' : /350\s*ML/.test(n) ? '350' : null;
  const regra = REGRAS.find(([re]) => re.test(n));
  const sabor = regra ? SABORES.find(s => s.key === regra[1]) || null : null;
  return { sabor, tamanho };
}

export function garrafaUrl(saborKey: string, tamanho: Tamanho, grande = false): string {
  return `/shop/images/garrafas/${saborKey}-${tamanho}${grande ? '' : '-sm'}.webp`;
}

// Imagem principal de um produto: garrafa oficial quando reconhecida; senão a do cadastro.
export function imagemDoProduto(p: Pick<Product, 'name' | 'imageUrl'>, grande = false): string | null {
  const { sabor, tamanho } = identificar(p.name);
  if (sabor && tamanho) return garrafaUrl(sabor.key, tamanho, grande);
  return p.imageUrl || null;
}

export interface GrupoSabor {
  key: string;
  sabor: Sabor | null;      // null = produto fora do mapa (exibido como veio do cadastro)
  variantes: { tamanho: Tamanho | null; produto: Product }[];
}

// Junta os produtos da API por sabor (350 + 900 no mesmo cartão), na ordem da vitrine.
export function agruparPorSabor(produtos: Product[]): GrupoSabor[] {
  const grupos = new Map<string, GrupoSabor>();
  for (const p of produtos) {
    const { sabor, tamanho } = identificar(p.name);
    const key = sabor && tamanho ? sabor.key : `avulso-${p.id}`;
    if (!grupos.has(key)) grupos.set(key, { key, sabor: sabor && tamanho ? sabor : null, variantes: [] });
    const g = grupos.get(key)!;
    // mesmo sabor e tamanho duplicado no cadastro: o segundo vira cartão avulso
    if (g.sabor && g.variantes.some(v => v.tamanho === tamanho)) {
      grupos.set(`avulso-${p.id}`, { key: `avulso-${p.id}`, sabor: null, variantes: [{ tamanho, produto: p }] });
      continue;
    }
    g.variantes.push({ tamanho: g.sabor ? tamanho : null, produto: p });
  }
  const ordem = (g: GrupoSabor) => {
    const i = SABORES.findIndex(s => s.key === g.key);
    return i === -1 ? 999 : i;
  };
  const lista = Array.from(grupos.values()).sort((a, b) => ordem(a) - ordem(b));
  for (const g of lista) g.variantes.sort((a, b) => (a.tamanho || '').localeCompare(b.tamanho || ''));
  return lista;
}

export const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
