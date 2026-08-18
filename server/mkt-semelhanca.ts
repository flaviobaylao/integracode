// ---------------------------------------------------------------------------
// Semelhanca entre criativos: familias de foto quase igual
// ---------------------------------------------------------------------------
// O problema real: o banco tem 598 pecas, mas boa parte e a MESMA foto — o
// mesmo instante fotografado em rajada, mais os recortes 4:5 / 9:16 / 1.91:1
// gerados dela. Sem isso, a esteira acha que tem 598 opcoes, roda duas fotos
// praticamente identicas em sequencia, e o anuncio parece repetido.
//
// A regra que passa a valer: o descanso e da FAMILIA, nao da peca. Usou uma,
// a familia inteira descansa.
//
// Como o hash e calculado: o projeto nao tem sharp/jimp e o Railway nao tem
// volume — decodificar JPEG no servidor sairia caro em dependencia e em risco
// de build (mesmo motivo de lerDimensao ler so o cabecalho). Quem decodifica a
// imagem e o navegador, no painel, via canvas; o servidor recebe o hash pronto
// e faz a parte que importa: agrupar e impedir a repeticao.
//
// dHash 9x8: reduz para 9x8 tons de cinza e compara cada pixel com o vizinho da
// direita -> 64 bits, 16 caracteres hex. Robusto a recorte leve, escala e
// compressao; sensivel a assunto diferente.

import { db } from './db';
import { sql } from 'drizzle-orm';

// Medido no proprio banco da Honest, comparando 153 fotos duas a duas:
// - ate 10 bits de diferenca: sempre a mesma cena (rajada ou recorte)
// - 14 bits: teto — ainda parecidas, mas ja aparecem pares discutiveis
// - 18 bits ou mais: comeca a juntar foto que nao tem nada a ver
// 10 e o valor conservador: erra para o lado de "sao a mesma", que e o erro
// barato — perder uma opcao e melhor do que publicar duas fotos iguais.
export const LIMIAR_SEMELHANCA = 10;

const HEX = /^[0-9a-f]{16}$/;

export function hashValido(h: any): boolean {
  return typeof h === 'string' && HEX.test(h.trim().toLowerCase());
}

/** Distancia de Hamming entre dois dHash de 64 bits em hex. -1 se algum for invalido. */
export function distancia(a: string, b: string): number {
  if (!hashValido(a) || !hashValido(b)) return -1;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let v = parseInt(x[i], 16) ^ parseInt(y[i], 16);
    while (v) { d += v & 1; v >>= 1; }
  }
  return d;
}

/**
 * Titulo sem o sufixo de formato. O recorte nasce com o nome do original mais
 * " (feed_4x5)" — dois recortes do mesmo instante PRECISAM cair na mesma
 * familia mesmo quando o hash discorda, porque o enquadramento muda bastante
 * a imagem e o hash nao sabe que vieram da mesma foto.
 */
export function tituloBase(t: any): string {
  return String(t || '')
    .replace(/\s*\((paisagem_[^)]*|story_9x16|retrato_outro|feed_4x5|quadrado_1x1|desconhecido)\)\s*$/i, '')
    .replace(/\s*-\s*c[oó]pia\s*$/i, '')
    .trim()
    .toLowerCase();
}

// --- union-find simples: N e da ordem de centenas, nao precisa de nada esperto
//
// Cada componente carrega um ROTULO (o produto). Nao basta recusar o par
// acerola~maracuja: uma foto sem produto com hash parecido encosta nas duas e
// liga as duas por corrente. O rotulo viaja junto com o grupo e fecha a porta.

function novaUniao(rotulos: string[]) {
  const n = rotulos.length;
  const pai = Array.from({ length: n }, (_, i) => i);
  const rot = rotulos.slice();
  const raiz = (i: number): number => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i]; } return i; };
  const juntar = (ra: number, rb: number) => { pai[ra] = rb; if (!rot[rb]) rot[rb] = rot[ra]; };
  return {
    raiz,
    rotuloDe: (i: number) => rot[raiz(i)],
    /** Une sem perguntar. Usado pelo titulo, que e autoridade maior que o hash. */
    unir(a: number, b: number) { const ra = raiz(a), rb = raiz(b); if (ra !== rb) juntar(ra, rb); },
    /** Une so se os rotulos nao brigarem. Devolve se uniu. */
    unirSePuder(a: number, b: number): boolean {
      const ra = raiz(a), rb = raiz(b);
      if (ra === rb) return false;
      if (rot[ra] && rot[rb] && rot[ra] !== rot[rb]) return false;
      juntar(ra, rb);
      return true;
    },
  };
}

export type PecaParaAgrupar = { id: number; phash?: string | null; titulo?: string | null; produto_nome?: string | null };

/**
 * Produto diferente NUNCA e a mesma foto, doa o que doer no hash.
 *
 * Medido no banco da Honest: as 15 fotos de catalogo (garrafa em fundo branco)
 * cairam TODAS numa familia so — Acerola, Maracuja, Frutas Vermelhas, Limonada.
 * O dHash e em tons de cinza, e a silhueta da garrafa e identica; o que muda
 * entre elas e a COR do liquido e o rotulo, exatamente o que o hash joga fora.
 * Sem esta regra o sistema trataria o catalogo inteiro como um criativo unico.
 */
function chaveDeProduto(p: PecaParaAgrupar): string {
  return String(p.produto_nome || '').trim().toLowerCase();
}

/**
 * Agrupa em familias. Ligacao simples: A~B e B~C poe os tres juntos, mesmo que
 * A e C estejam longe. E o comportamento certo aqui — uma rajada de foto e uma
 * corrente continua de quadros que mudam pouco de um para o outro.
 *
 * O id da familia e o MENOR id do grupo: estavel entre recalculos e legivel no
 * banco (a familia 147 e a que comeca no criativo #147).
 */
export function agrupar(pecas: PecaParaAgrupar[], limiar = LIMIAR_SEMELHANCA): Map<number, number> {
  const n = pecas.length;
  const u = novaUniao(pecas.map(chaveDeProduto));

  // 1) mesmo titulo base = mesma familia, sem discussao (original + recortes)
  const porTitulo = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const t = tituloBase(pecas[i].titulo);
    if (!t) continue;
    const j = porTitulo.get(t);
    if (j === undefined) porTitulo.set(t, i); else u.unir(i, j);
  }

  // 2) hashes proximos entram na mesma familia
  for (let i = 0; i < n; i++) {
    const hi = pecas[i].phash;
    if (!hashValido(hi)) continue;
    for (let j = i + 1; j < n; j++) {
      const hj = pecas[j].phash;
      if (!hashValido(hj)) continue;
      if (u.raiz(i) === u.raiz(j)) continue;
      const d = distancia(hi as string, hj as string);
      // unirSePuder recusa quando os dois lados ja tem produtos diferentes.
      // Peca sem produto entra na familia de quem encontrar primeiro; qual das
      // duas nao importa, o que importa e que os dois produtos nao se misturam.
      if (d >= 0 && d <= limiar) u.unirSePuder(i, j);
    }
  }

  // 3) nome da familia = menor id do grupo
  const menor = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = u.raiz(i);
    const atual = menor.get(r);
    if (atual === undefined || pecas[i].id < atual) menor.set(r, pecas[i].id);
  }
  const saida = new Map<number, number>();
  for (let i = 0; i < n; i++) saida.set(pecas[i].id, menor.get(u.raiz(i)) as number);
  return saida;
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

/** Guarda o hash calculado no navegador. Recusa o que nao for dHash valido. */
export async function gravarHashes(
  itens: { id: number; phash: string }[],
): Promise<{ ok: boolean; gravados: number; recusados: { id: number; motivo: string }[] }> {
  const recusados: { id: number; motivo: string }[] = [];
  let gravados = 0;
  for (const it of itens || []) {
    const id = Number(it?.id);
    const h = String(it?.phash || '').trim().toLowerCase();
    if (!Number.isFinite(id) || id <= 0) { recusados.push({ id: it?.id as any, motivo: 'id invalido' }); continue; }
    if (!hashValido(h)) { recusados.push({ id, motivo: 'phash fora do formato (16 hex)' }); continue; }
    try {
      const r: any = await db.execute(sql`UPDATE mkt_assets SET phash = ${h} WHERE id = ${id} RETURNING id`);
      if (r.rows?.length) gravados++; else recusados.push({ id, motivo: 'criativo nao encontrado' });
    } catch (e: any) {
      recusados.push({ id, motivo: String(e?.message || e) });
    }
  }
  return { ok: recusados.length === 0, gravados, recusados };
}

/** Recalcula a familia de TODO o banco. Barato: centenas de pecas, roda em ms. */
export async function recalcularFamilias(limiar = LIMIAR_SEMELHANCA): Promise<{
  ok: boolean; pecas: number; comHash: number; familias: number; maiorFamilia: number; erro?: string;
}> {
  try {
    const r: any = await db.execute(sql`SELECT id, phash, titulo, produto_nome FROM mkt_assets ORDER BY id ASC`);
    const pecas: PecaParaAgrupar[] = (r.rows || []).map((x: any) => ({ id: Number(x.id), phash: x.phash, titulo: x.titulo, produto_nome: x.produto_nome }));
    if (!pecas.length) return { ok: true, pecas: 0, comHash: 0, familias: 0, maiorFamilia: 0 };

    const mapa = agrupar(pecas, limiar);

    // Um UPDATE por familia, nao um por peca: 598 pecas viram ~dezenas de queries.
    const porFamilia = new Map<number, number[]>();
    mapa.forEach((fam, id) => {
      const l = porFamilia.get(fam); if (l) l.push(id); else porFamilia.set(fam, [id]);
    });
    const grupos: { fam: number; ids: number[] }[] = [];
    porFamilia.forEach((ids, fam) => grupos.push({ fam, ids }));
    for (const g of grupos) {
      // ANY(array) nao funciona com array js no drizzle (vai como texto): IN + sql.join.
      await db.execute(sql`UPDATE mkt_assets SET familia = ${g.fam} WHERE id IN (${sql.join(g.ids.map((i: number) => sql`${i}`), sql`, `)})`);
    }

    let maior = 0;
    for (const g of grupos) if (g.ids.length > maior) maior = g.ids.length;
    return {
      ok: true,
      pecas: pecas.length,
      comHash: pecas.filter(p => hashValido(p.phash)).length,
      familias: porFamilia.size,
      maiorFamilia: maior,
    };
  } catch (e: any) {
    return { ok: false, pecas: 0, comHash: 0, familias: 0, maiorFamilia: 0, erro: String(e?.message || e) };
  }
}

/**
 * A familia desta peca descansou o suficiente? Devolve quem foi usado e quando,
 * para a recusa poder dizer o motivo com nome e sobrenome em vez de "indisponivel".
 */
export async function familiaEmDescanso(
  assetId: number, diasDescanso: number,
): Promise<{ emDescanso: boolean; irmaoId?: number; irmaoTitulo?: string; diasFaltando?: number; tamanhoFamilia?: number }> {
  try {
    const a: any = await db.execute(sql`SELECT familia FROM mkt_assets WHERE id = ${assetId} LIMIT 1`);
    const fam = a.rows?.[0]?.familia;
    if (fam == null) return { emDescanso: false };

    const r: any = await db.execute(sql`
      SELECT id, titulo, ultimo_uso,
             EXTRACT(EPOCH FROM (NOW() - ultimo_uso)) / 86400 AS dias,
             (SELECT COUNT(*)::int FROM mkt_assets t WHERE t.familia = ${fam}) AS tamanho
        FROM mkt_assets
       WHERE familia = ${fam} AND id <> ${assetId} AND ultimo_uso IS NOT NULL
       ORDER BY ultimo_uso DESC
       LIMIT 1`);
    const linha = r.rows?.[0];
    const tamanho = Number(linha?.tamanho || 0) || undefined;
    if (!linha) return { emDescanso: false, tamanhoFamilia: tamanho };

    const dias = Math.floor(Number(linha.dias));
    if (dias >= diasDescanso) return { emDescanso: false, tamanhoFamilia: tamanho };
    return {
      emDescanso: true,
      irmaoId: Number(linha.id),
      irmaoTitulo: linha.titulo || undefined,
      diasFaltando: diasDescanso - dias,
      tamanhoFamilia: tamanho,
    };
  } catch {
    // Coluna ainda nao existe ou banco fora: nunca bloquear por causa disso.
    return { emDescanso: false };
  }
}

/** Panorama das familias, para a tela poder mostrar "598 pecas, mas N assuntos". */
export async function panoramaFamilias(): Promise<any> {
  try {
    const r: any = await db.execute(sql`
      SELECT COUNT(*)::int AS pecas,
             COUNT(phash)::int AS com_hash,
             COUNT(DISTINCT familia)::int AS familias
        FROM mkt_assets WHERE ativo = true`);
    const maiores: any = await db.execute(sql`
      SELECT familia, COUNT(*)::int AS n, MIN(titulo) AS exemplo
        FROM mkt_assets WHERE ativo = true AND familia IS NOT NULL
       GROUP BY familia ORDER BY n DESC LIMIT 10`);
    const l = r.rows?.[0] || {};
    return {
      ok: true,
      pecas: Number(l.pecas || 0),
      comHash: Number(l.com_hash || 0),
      familias: Number(l.familias || 0),
      semHash: Number(l.pecas || 0) - Number(l.com_hash || 0),
      limiar: LIMIAR_SEMELHANCA,
      maiores: (maiores.rows || []).map((x: any) => ({ familia: Number(x.familia), pecas: Number(x.n), exemplo: x.exemplo })),
    };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}
