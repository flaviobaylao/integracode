// Central de Marketing - buraco 5: biblioteca de criativos com tags.
//
// O buraco nao e "onde guardar foto" - foto a Honest ja tem. O buraco e:
// "impossivel saber que gancho de margem vende mais que gancho de sabor".
// Por isso a biblioteca nasce ligada ao fio de atribuicao (buraco 2): todo uso
// de um criativo aponta para campanha/link, e receita volta por ali.
//
// Decisoes:
//  - NAO cria armazenamento novo. Guarda REFERENCIA (url). Foto nova sobe pelo
//    /api/upload-image que ja existe e vira /api/photo-media/<id>.
//  - Tag e VOCABULARIO CONTROLADO por eixo. Texto livre nao fecha analise nunca.
//  - Dedup por sha256 do conteudo: a mesma foto cadastrada em 3 produtos e UM
//    criativo, senao o desempenho por tag conta a mesma peca varias vezes.
//  - formato e DERIVADO da dimensao real do arquivo, nao digitado.
//  - DDL preguicosa, nunca no boot (precedente do official-templates.ts).

import { db } from './db';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Vocabulario controlado
// ---------------------------------------------------------------------------

// O eixo que responde a pergunta do buraco 5.
export const GANCHOS = [
  'margem',        // quanto sobra para o revendedor
  'giro',          // sai rapido da prateleira
  'sabor',         // gosto, experiencia
  'saude',         // natural, sem acucar adicionado
  'comodidade',    // entrega, praticidade
  'preco',         // condicao comercial
  'novidade',      // lancamento, sabor novo
  'confianca',     // processo, producao local, controle
  'prova_social',  // cliente usando, depoimento
] as const;

export const CENARIOS = [
  'prateleira', 'padaria', 'geladeira', 'mesa', 'producao', 'fruta',
  'caixa', 'entrega', 'pessoa', 'produto_isolado',
] as const;

export const PUBLICOS = ['b2b', 'b2c'] as const;

export const ORIGENS = ['foto_real', 'video_real', 'ia_moldura', 'ia_gerado'] as const;
export type Origem = typeof ORIGENS[number];

export const EIXOS_TAG = ['gancho', 'cenario', 'publico', 'produto', 'livre'] as const;
export type EixoTag = typeof EIXOS_TAG[number];

const VOCABULARIO: Record<string, readonly string[]> = {
  gancho: GANCHOS,
  cenario: CENARIOS,
  publico: PUBLICOS,
};

// Dias minimos entre dois usos do mesmo criativo (antifadiga).
export const DIAS_DESCANSO_PADRAO = 21;

// Abaixo disso, desempenho por tag NAO conclui nada - so mostra que falta amostra.
export const AMOSTRA_MINIMA = 3;

export type Formato =
  | 'feed_4x5' | 'story_9x16' | 'quadrado_1x1' | 'paisagem_1.91x1'
  | 'paisagem_16x9' | 'retrato_outro' | 'paisagem_outro' | 'desconhecido';

// Onde cada formato serve. Usado pela tela e pelas lacunas.
export const FORMATO_CANAL: Record<string, string[]> = {
  feed_4x5: ['instagram', 'facebook'],
  quadrado_1x1: ['instagram', 'facebook', 'google'],
  story_9x16: ['instagram', 'facebook'],
  'paisagem_1.91x1': ['facebook', 'google'],
  paisagem_16x9: ['google'],
};

// ---------------------------------------------------------------------------
// Schema (preguicoso)
// ---------------------------------------------------------------------------

let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktAssetsSchema(): Promise<{ ok: boolean; steps: { sql: string; ok: boolean; erro?: string }[] }> {
  const steps: { sql: string; ok: boolean; erro?: string }[] = [];
  const ddl: string[] = [
    `CREATE TABLE IF NOT EXISTS mkt_assets (
       id SERIAL PRIMARY KEY,
       sha256 VARCHAR(64) NOT NULL,
       tipo VARCHAR(16) NOT NULL DEFAULT 'foto',
       url TEXT NOT NULL,
       fonte VARCHAR(24) NOT NULL DEFAULT 'upload',
       origem VARCHAR(16) NOT NULL DEFAULT 'foto_real',
       produto_id VARCHAR,
       produto_nome VARCHAR,
       titulo VARCHAR,
       tags JSONB NOT NULL DEFAULT '{}'::jsonb,
       largura INTEGER,
       altura INTEGER,
       formato VARCHAR(20) NOT NULL DEFAULT 'desconhecido',
       bytes INTEGER,
       direitos_ok BOOLEAN NOT NULL DEFAULT false,
       ativo BOOLEAN NOT NULL DEFAULT true,
       usos INTEGER NOT NULL DEFAULT 0,
       ultimo_uso TIMESTAMPTZ,
       observacao TEXT,
       criado_por VARCHAR,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS mkt_assets_sha_idx ON mkt_assets (sha256)`,
    `CREATE INDEX IF NOT EXISTS mkt_assets_formato_idx ON mkt_assets (formato)`,
    `CREATE INDEX IF NOT EXISTS mkt_assets_ativo_idx ON mkt_assets (ativo, direitos_ok)`,
    `CREATE INDEX IF NOT EXISTS mkt_assets_tags_idx ON mkt_assets USING GIN (tags)`,
    `CREATE TABLE IF NOT EXISTS mkt_asset_usos (
       id SERIAL PRIMARY KEY,
       asset_id INTEGER NOT NULL,
       canal VARCHAR(24),
       campanha_id INTEGER,
       campanha_codigo VARCHAR,
       link_slug VARCHAR,
       ref VARCHAR,
       gancho VARCHAR(24),
       criado_por VARCHAR,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS mkt_asset_usos_asset_idx ON mkt_asset_usos (asset_id)`,
    `CREATE INDEX IF NOT EXISTS mkt_asset_usos_camp_idx ON mkt_asset_usos (campanha_id)`,
    `CREATE INDEX IF NOT EXISTS mkt_asset_usos_slug_idx ON mkt_asset_usos (link_slug)`,
  ];

  for (const s of ddl) {
    try { await db.execute(sql.raw(s)); steps.push({ sql: s.slice(0, 60), ok: true }); }
    catch (e: any) { steps.push({ sql: s.slice(0, 60), ok: false, erro: String(e?.message || e) }); }
  }
  const ok = steps.every(s => s.ok);
  _schemaOk = ok;
  return { ok, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  // Anti-tempestade de DDL: no maximo 1 tentativa por minuto quando falha.
  if (Date.now() - _schemaTentativa < 60_000) return false;
  _schemaTentativa = Date.now();
  await ensureMktAssetsSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// Leitura de dimensao sem dependencia nova
// ---------------------------------------------------------------------------
// O projeto nao tem sharp/jimp/image-size, e o Railway nao tem volume. Ler o
// cabecalho e barato (poucos bytes) e evita mais uma dependencia no build.

export function lerDimensao(buf: Buffer): { largura: number; altura: number; tipo: string } | null {
  if (!buf || buf.length < 24) return null;

  // PNG: 89 50 4E 47 ... IHDR em 16..24
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20), tipo: 'png' };
  }

  // GIF: "GIF8", little-endian em 6..10
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { largura: buf.readUInt16LE(6), altura: buf.readUInt16LE(8), tipo: 'gif' };
  }

  // WEBP: "RIFF"...."WEBP"
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const sub = buf.toString('ascii', 12, 16);
    if (sub === 'VP8X') return { largura: 1 + buf.readUIntLE(24, 3), altura: 1 + buf.readUIntLE(27, 3), tipo: 'webp' };
    if (sub === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { largura: 1 + (b & 0x3fff), altura: 1 + ((b >> 14) & 0x3fff), tipo: 'webp' };
    }
    if (sub === 'VP8 ' && buf.length > 30) {
      return { largura: buf.readUInt16LE(26) & 0x3fff, altura: buf.readUInt16LE(28) & 0x3fff, tipo: 'webp' };
    }
    return null;
  }

  // JPEG: percorre os marcadores ate um SOF (C0..CF, menos C4/C8/CC)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    let guarda = 0;
    while (i + 9 < buf.length && guarda++ < 4000) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marcador = buf[i + 1];
      if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) { i += 2; continue; }
      if (marcador === 0xd9) break;
      const tam = buf.readUInt16BE(i + 2);
      if (tam < 2) break;
      const ehSof = marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
      if (ehSof) {
        return { altura: buf.readUInt16BE(i + 5), largura: buf.readUInt16BE(i + 7), tipo: 'jpeg' };
      }
      i += 2 + tam;
    }
    return null;
  }

  return null;
}

export function classificarFormato(largura?: number | null, altura?: number | null): Formato {
  if (!largura || !altura || largura <= 0 || altura <= 0) return 'desconhecido';
  const r = largura / altura;
  const perto = (alvo: number) => Math.abs(r - alvo) / alvo <= 0.04;
  if (perto(1)) return 'quadrado_1x1';
  if (perto(0.8)) return 'feed_4x5';
  if (perto(0.5625)) return 'story_9x16';
  if (perto(1.91)) return 'paisagem_1.91x1';
  if (perto(1.7778)) return 'paisagem_16x9';
  return r < 1 ? 'retrato_outro' : 'paisagem_outro';
}

// ---------------------------------------------------------------------------
// URL -> bytes (so para data: URL; caminho de arquivo nao busca a rede)
// ---------------------------------------------------------------------------

function bytesDaUrl(url: string): Buffer | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

export function impressaoDigital(url: string): string {
  const b = bytesDaUrl(url);
  // Foto embutida: hash do conteudo - pega a mesma foto repetida em N produtos.
  if (b && b.length > 0) return crypto.createHash('sha256').update(b).digest('hex');
  // Caminho/URL: hash da propria url normalizada - dedup por identidade.
  return crypto.createHash('sha256').update('url:' + String(url).trim().toLowerCase()).digest('hex');
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export type Tags = Partial<Record<EixoTag, string[]>>;

function normalizar(s: string): string {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Aceita so o vocabulario de cada eixo; 'produto' e 'livre' sao abertos mas normalizados. */
export function sanearTags(entrada: any): { tags: Tags; recusadas: { eixo: string; valor: string }[] } {
  const tags: Tags = {};
  const recusadas: { eixo: string; valor: string }[] = [];
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return { tags, recusadas };

  for (const eixo of EIXOS_TAG) {
    const bruto = (entrada as any)[eixo];
    if (bruto === undefined || bruto === null) continue;
    const lista = Array.isArray(bruto) ? bruto : [bruto];
    const aceitos: string[] = [];
    for (const v of lista) {
      const val = normalizar(String(v)).replace(/\s+/g, '_');
      if (!val) continue;
      const vocab = VOCABULARIO[eixo];
      if (vocab && !vocab.includes(val)) { recusadas.push({ eixo, valor: String(v) }); continue; }
      if (!aceitos.includes(val)) aceitos.push(val);
    }
    if (aceitos.length) tags[eixo] = aceitos;
  }
  return { tags, recusadas };
}

/** Palpite de tag a partir do nome do produto. Palpite, nao verdade: fica editavel. */
export function tagsSugeridas(produtoNome?: string | null, fonte?: string): Tags {
  const t: Tags = {};
  const n = normalizar(produtoNome || '');
  if (n) {
    const sabor = n
      .replace(/\b(suco|integral|natural|garrafa|pack|caixa|ml|l|litro|litros|un|und|unidade|de|do|da|com|sem)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(p => p.length >= 3 && !/\d/.test(p));
    if (sabor.length) t.produto = Array.from(new Set(sabor)).slice(0, 3);
  }
  if (fonte === 'catalogo') { t.cenario = ['produto_isolado']; t.gancho = ['sabor']; }
  return t;
}

function mesclarTags(a: any, b: Tags): Tags {
  const base: Tags = (a && typeof a === 'object' && !Array.isArray(a)) ? { ...a } : {};
  for (const eixo of EIXOS_TAG) {
    const atual: string[] = Array.isArray((base as any)[eixo]) ? (base as any)[eixo] : [];
    const novo: string[] = Array.isArray(b[eixo]) ? (b[eixo] as string[]) : [];
    const juntos = Array.from(new Set([...atual, ...novo]));
    if (juntos.length) (base as any)[eixo] = juntos;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

export type NovoAsset = {
  url: string;
  tipo?: 'foto' | 'video' | 'arte';
  fonte?: string;
  origem?: Origem;
  produtoId?: string | null;
  produtoNome?: string | null;
  titulo?: string | null;
  tags?: any;
  direitosOk?: boolean;
  observacao?: string | null;
  criadoPor?: string | null;
};

export type ResultadoCadastro = {
  ok: boolean;
  id?: number;
  duplicado?: boolean;
  formato?: Formato;
  largura?: number | null;
  altura?: number | null;
  recusadas?: { eixo: string; valor: string }[];
  erro?: string;
};

export async function cadastrarAsset(a: NovoAsset): Promise<ResultadoCadastro> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };

  const url = String(a?.url || '').trim();
  if (!url) return { ok: false, erro: 'url obrigatoria' };

  const origem: Origem = (ORIGENS as readonly string[]).includes(String(a.origem)) ? (a.origem as Origem) : 'foto_real';
  const { tags: tagsLimpas, recusadas } = sanearTags(a.tags);
  const tags = mesclarTags(tagsLimpas, tagsSugeridas(a.produtoNome, a.fonte));

  const buf = bytesDaUrl(url);
  const dim = buf ? lerDimensao(buf) : null;
  const formato = classificarFormato(dim?.largura, dim?.altura);
  const sha = impressaoDigital(url);

  // IA gerada nasce SEM direitos liberados: exige aprovacao explicita (regra da casa).
  const direitosOk = origem === 'ia_gerado' ? false : (a.direitosOk === true);

  try {
    const r: any = await db.execute(sql`
      INSERT INTO mkt_assets
        (sha256, tipo, url, fonte, origem, produto_id, produto_nome, titulo, tags,
         largura, altura, formato, bytes, direitos_ok, observacao, criado_por)
      VALUES
        (${sha}, ${a.tipo || 'foto'}, ${url}, ${a.fonte || 'upload'}, ${origem},
         ${a.produtoId || null}, ${a.produtoNome || null}, ${a.titulo || null},
         ${JSON.stringify(tags)}::jsonb,
         ${dim?.largura ?? null}, ${dim?.altura ?? null}, ${formato},
         ${buf ? buf.length : null}, ${direitosOk}, ${a.observacao || null}, ${a.criadoPor || null})
      ON CONFLICT (sha256) DO NOTHING
      RETURNING id
    `);
    if (r.rows?.length) {
      return { ok: true, id: Number(r.rows[0].id), duplicado: false, formato, largura: dim?.largura ?? null, altura: dim?.altura ?? null, recusadas };
    }

    // Ja existia: em vez de ignorar, SOMA as tags novas no registro que existe.
    // A mesma foto em dois produtos vira um criativo com dois produtos na tag.
    const ex: any = await db.execute(sql`SELECT id, tags FROM mkt_assets WHERE sha256 = ${sha} LIMIT 1`);
    if (!ex.rows?.length) return { ok: false, erro: 'conflito sem linha' };
    const id = Number(ex.rows[0].id);
    const juntas = mesclarTags(ex.rows[0].tags, tags);
    await db.execute(sql`UPDATE mkt_assets SET tags = ${JSON.stringify(juntas)}::jsonb WHERE id = ${id}`);
    return { ok: true, id, duplicado: true, formato, recusadas };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

export async function atualizarAsset(id: number, campos: Partial<NovoAsset> & { ativo?: boolean }): Promise<{ ok: boolean; recusadas?: any[]; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  try {
    const atual: any = await db.execute(sql`SELECT id, tags, origem FROM mkt_assets WHERE id = ${id} LIMIT 1`);
    if (!atual.rows?.length) return { ok: false, erro: 'criativo nao encontrado' };

    let recusadas: any[] = [];
    if (campos.tags !== undefined) {
      // Substitui os eixos informados (nao soma) - e como o usuario espera ao editar.
      const s = sanearTags(campos.tags);
      recusadas = s.recusadas;
      await db.execute(sql`UPDATE mkt_assets SET tags = ${JSON.stringify(s.tags)}::jsonb WHERE id = ${id}`);
    }
    if (campos.titulo !== undefined) await db.execute(sql`UPDATE mkt_assets SET titulo = ${campos.titulo || null} WHERE id = ${id}`);
    if (campos.observacao !== undefined) await db.execute(sql`UPDATE mkt_assets SET observacao = ${campos.observacao || null} WHERE id = ${id}`);
    if (campos.origem !== undefined && (ORIGENS as readonly string[]).includes(String(campos.origem))) {
      await db.execute(sql`UPDATE mkt_assets SET origem = ${campos.origem} WHERE id = ${id}`);
    }
    if (campos.ativo !== undefined) await db.execute(sql`UPDATE mkt_assets SET ativo = ${!!campos.ativo} WHERE id = ${id}`);
    if (campos.direitosOk !== undefined) {
      const origemFinal = campos.origem ?? atual.rows[0].origem;
      // Liberar direitos de peca gerada por IA e decisao humana explicita - e permitido,
      // mas nunca acontece por padrao (ver cadastrarAsset).
      await db.execute(sql`UPDATE mkt_assets SET direitos_ok = ${!!campos.direitosOk} WHERE id = ${id}`);
      void origemFinal;
    }
    return { ok: true, recusadas };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Importar o que a Honest JA tem
// ---------------------------------------------------------------------------
// O plano registra "Banco de fotos de produto - Existe". Pedir para o Flavio
// recadastrar tudo a mao seria o jeito mais rapido de a biblioteca nascer vazia
// e morrer vazia. Entao ela se popula sozinha do catalogo.

export async function importarDoCatalogo(criadoPor?: string): Promise<{
  ok: boolean; produtos: number; encontradas: number; novas: number; duplicadas: number;
  semDimensao: number; erros: number; porFormato: Record<string, number>; detalhe?: string;
}> {
  const zero = { ok: false, produtos: 0, encontradas: 0, novas: 0, duplicadas: 0, semDimensao: 0, erros: 0, porFormato: {} as Record<string, number> };
  if (!(await garantirSchema())) return { ...zero, detalhe: 'schema indisponivel' };

  let linhas: any[] = [];
  try {
    const r: any = await db.execute(sql`
      SELECT id, name, image_url, images
        FROM products
       WHERE is_active = true
    `);
    linhas = r.rows || [];
  } catch (e: any) {
    return { ...zero, detalhe: 'nao consegui ler products: ' + String(e?.message || e) };
  }

  let encontradas = 0, novas = 0, duplicadas = 0, semDimensao = 0, erros = 0;
  const porFormato: Record<string, number> = {};

  for (const p of linhas) {
    // Defensivo de proposito: no buraco 8 um products.products fora do formato
    // esperado derrubou a consulta inteira. images pode vir null, string ou com nulos.
    const candidatas: string[] = [];
    if (typeof p.image_url === 'string' && p.image_url.trim()) candidatas.push(p.image_url);
    const imgs = p.images;
    if (Array.isArray(imgs)) {
      for (const u of imgs) if (typeof u === 'string' && u.trim()) candidatas.push(u);
    } else if (typeof imgs === 'string' && imgs.trim()) {
      candidatas.push(imgs);
    }

    for (const url of candidatas) {
      // Placeholder nao e criativo.
      if (/placeholder/i.test(url)) continue;
      encontradas++;
      const r = await cadastrarAsset({
        url,
        tipo: 'foto',
        fonte: 'catalogo',
        origem: 'foto_real',
        produtoId: String(p.id),
        produtoNome: String(p.name || ''),
        titulo: String(p.name || '').slice(0, 120),
        direitosOk: true, // foto do proprio catalogo da Honest
        criadoPor: criadoPor || 'importador',
      });
      if (!r.ok) { erros++; continue; }
      if (r.duplicado) duplicadas++; else novas++;
      const f = r.formato || 'desconhecido';
      porFormato[f] = (porFormato[f] || 0) + 1;
      if (f === 'desconhecido') semDimensao++;
    }
  }

  return { ok: true, produtos: linhas.length, encontradas, novas, duplicadas, semDimensao, erros, porFormato };
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

export type FiltroBusca = {
  gancho?: string; cenario?: string; publico?: string; produto?: string;
  formato?: string; origem?: string; fonte?: string;
  soElegiveis?: boolean; diasDescanso?: number; texto?: string; limite?: number;
};

export async function buscar(f: FiltroBusca = {}): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const descanso = Number(f.diasDescanso ?? DIAS_DESCANSO_PADRAO);
  const limite = Math.min(Math.max(Number(f.limite || 60), 1), 300);

  const cond: any[] = [sql`1=1`];
  const tagFiltro = (eixo: string, valor?: string) => {
    if (!valor) return;
    const v = normalizar(valor).replace(/\s+/g, '_');
    cond.push(sql`tags -> ${eixo} @> ${JSON.stringify([v])}::jsonb`);
  };
  tagFiltro('gancho', f.gancho);
  tagFiltro('cenario', f.cenario);
  tagFiltro('publico', f.publico);
  tagFiltro('produto', f.produto);
  if (f.formato) cond.push(sql`formato = ${f.formato}`);
  if (f.origem) cond.push(sql`origem = ${f.origem}`);
  if (f.fonte) cond.push(sql`fonte = ${f.fonte}`);
  if (f.texto) {
    const t = '%' + String(f.texto).trim() + '%';
    cond.push(sql`(COALESCE(titulo,'') ILIKE ${t} OR COALESCE(produto_nome,'') ILIKE ${t} OR COALESCE(observacao,'') ILIKE ${t})`);
  }
  if (f.soElegiveis) {
    cond.push(sql`ativo = true AND direitos_ok = true`);
    cond.push(sql`(ultimo_uso IS NULL OR ultimo_uso < NOW() - (${descanso}::text || ' days')::interval)`);
  }

  const where = cond.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`));
  const r: any = await db.execute(sql`
    SELECT id, sha256, tipo, url, fonte, origem, produto_id, produto_nome, titulo, tags,
           largura, altura, formato, bytes, direitos_ok, ativo, usos, ultimo_uso, observacao, criado_em,
           (ativo AND direitos_ok
              AND (ultimo_uso IS NULL OR ultimo_uso < NOW() - (${descanso}::text || ' days')::interval)) AS elegivel,
           CASE WHEN ultimo_uso IS NULL THEN NULL
                ELSE GREATEST(0, ${descanso}::int - EXTRACT(DAY FROM NOW() - ultimo_uso)::int) END AS dias_de_descanso
      FROM mkt_assets
     WHERE ${where}
     ORDER BY (ultimo_uso IS NULL) DESC, ultimo_uso ASC NULLS FIRST, id DESC
     LIMIT ${limite}
  `);
  return (r.rows || []).map((x: any) => {
    const embutida = String(x.url || '').startsWith('data:');
    return {
      ...x,
      // Foto do catalogo vem como data: URL de centenas de KB. Mandar 60 delas na
      // listagem seria dezenas de MB de JSON - a tela recebe um endereco leve e
      // busca a imagem so quando for desenhar.
      url: embutida ? '/api/mkt/assets/' + x.id + '/arquivo' : x.url,
      embutida,
    };
  });
}

export async function verAsset(id: number): Promise<any | null> {
  if (!(await garantirSchema())) return null;
  // id invalido nao pode virar SQL: sem esta guarda, undefined monta "WHERE id =  LIMIT 1".
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return null;
  const r: any = await db.execute(sql`SELECT * FROM mkt_assets WHERE id = ${n} LIMIT 1`);
  return r.rows?.[0] || null;
}

/** Bytes de um criativo embutido, para servir a miniatura sem inchar a listagem. */
export async function arquivoDoAsset(id: number): Promise<{ mime: string; buf: Buffer } | null> {
  const a = await verAsset(id);
  if (!a) return null;
  const url = String(a.url || '');
  const m = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  try {
    return { mime: m[1] || 'application/octet-stream', buf: Buffer.from(m[2], 'base64') };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Elegibilidade e uso
// ---------------------------------------------------------------------------

export async function elegivel(id: number, diasDescanso = DIAS_DESCANSO_PADRAO): Promise<{ elegivel: boolean; motivo?: string; diasFaltando?: number }> {
  if (!(await garantirSchema())) return { elegivel: false, motivo: 'schema indisponivel' };
  const a = await verAsset(id);
  if (!a) return { elegivel: false, motivo: 'criativo nao encontrado' };
  if (a.ativo === false) return { elegivel: false, motivo: 'criativo arquivado' };
  if (a.direitos_ok !== true) {
    return { elegivel: false, motivo: a.origem === 'ia_gerado' ? 'gerado por IA sem sua aprovacao explicita' : 'direitos de uso nao conferidos' };
  }
  if (a.ultimo_uso) {
    const dias = Math.floor((Date.now() - new Date(a.ultimo_uso).getTime()) / 86400000);
    if (dias < diasDescanso) return { elegivel: false, motivo: 'usado ha ' + dias + ' dia(s); descanso de ' + diasDescanso, diasFaltando: diasDescanso - dias };
  }
  return { elegivel: true };
}

export type RegistroUso = {
  assetId: number; canal?: string; campanhaId?: number | null; campanhaCodigo?: string | null;
  linkSlug?: string | null; ref?: string | null; gancho?: string | null; criadoPor?: string | null;
  ignorarDescanso?: boolean; diasDescanso?: number;
};

export async function registrarUso(u: RegistroUso): Promise<{ ok: boolean; id?: number; erro?: string; motivo?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const el = await elegivel(u.assetId, u.diasDescanso ?? DIAS_DESCANSO_PADRAO);
  if (!el.elegivel && !u.ignorarDescanso) return { ok: false, motivo: el.motivo };
  // Nem com ignorarDescanso: direitos e arquivo nao sao negociaveis.
  if (!el.elegivel && u.ignorarDescanso && !String(el.motivo || '').startsWith('usado ha ')) {
    return { ok: false, motivo: el.motivo };
  }

  let campanhaId = u.campanhaId ?? null;
  let campanhaCodigo = u.campanhaCodigo ?? null;
  try {
    // Fecha o fio: se veio o slug do link curto, herda a campanha dele.
    if (!campanhaId && u.linkSlug) {
      const r: any = await db.execute(sql`SELECT campanha_id FROM mkt_links WHERE slug = ${u.linkSlug} LIMIT 1`);
      if (r.rows?.length) campanhaId = r.rows[0].campanha_id ?? null;
    }
    if (campanhaId && !campanhaCodigo) {
      const r: any = await db.execute(sql`SELECT codigo FROM mkt_campanhas WHERE id = ${campanhaId} LIMIT 1`);
      if (r.rows?.length) campanhaCodigo = r.rows[0].codigo ?? null;
    }
  } catch { /* mkt_links/mkt_campanhas podem nao existir ainda; uso continua valido */ }

  const gancho = u.gancho ? normalizar(u.gancho) : null;
  try {
    const r: any = await db.execute(sql`
      INSERT INTO mkt_asset_usos (asset_id, canal, campanha_id, campanha_codigo, link_slug, ref, gancho, criado_por)
      VALUES (${u.assetId}, ${u.canal || null}, ${campanhaId}, ${campanhaCodigo},
              ${u.linkSlug || null}, ${u.ref || null}, ${gancho}, ${u.criadoPor || null})
      RETURNING id
    `);
    await db.execute(sql`UPDATE mkt_assets SET usos = usos + 1, ultimo_uso = NOW() WHERE id = ${u.assetId}`);
    return { ok: true, id: Number(r.rows[0].id) };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// O motivo do buraco 5 existir: desempenho por tag
// ---------------------------------------------------------------------------
// Junta criativo -> uso -> campanha -> receita atribuida (mkt_toques, buraco 2).
// E diz na cara quando NAO da para concluir. Ranking com n=1 e pior que ranking
// nenhum, porque parece resposta.

export type LinhaDesempenho = {
  valor: string; criativos: number; usos: number; campanhas: number;
  campanhasExclusivas: number; campanhasMistas: number;
  pedidos: number; receita: number; receitaPorUso: number;
  confiavel: boolean; observacao: string;
};

export async function desempenhoPorTag(eixo: EixoTag | 'gancho' = 'gancho', dias = 90): Promise<{
  eixo: string; dias: number; amostraMinima: number; linhas: LinhaDesempenho[];
  totalUsos: number; usosComFio: number; recado: string;
}> {
  const vazio = { eixo: String(eixo), dias, amostraMinima: AMOSTRA_MINIMA, linhas: [] as LinhaDesempenho[], totalUsos: 0, usosComFio: 0, recado: '' };
  if (!(await garantirSchema())) return { ...vazio, recado: 'schema indisponivel' };
  const eixoOk: string = (EIXOS_TAG as readonly string[]).includes(String(eixo)) ? String(eixo) : 'gancho';

  let temToques = true;
  try { await db.execute(sql.raw('SELECT 1 FROM mkt_toques LIMIT 1')); } catch { temToques = false; }

  // O gancho do USO manda sobre a tag do criativo: a mesma foto pode ir ao ar
  // com gancho de margem hoje e de sabor no mes que vem.
  // Nao da para chamar jsonb_array_elements_text dentro de COALESCE (funcao que
  // devolve conjunto nao entra em expressao) - por isso LATERAL + COALESCE fora.
  const valorDoUso = eixoOk === 'gancho'
    ? sql`COALESCE(NULLIF(u.gancho, ''), t.valor)`
    : sql`t.valor`;
  const lateral = eixoOk === 'gancho'
    ? sql`LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(a.tags->'gancho','[]'::jsonb)) AS t(valor) ON true`
    : sql`LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(a.tags->${eixoOk},'[]'::jsonb)) AS t(valor) ON true`;

  const receitaCte = temToques
    ? sql`receita AS (
            SELECT campanha_id,
                   COUNT(*) FILTER (WHERE sales_card_id IS NOT NULL)::int AS pedidos,
                   COALESCE(SUM(valor), 0)::numeric AS receita
              FROM mkt_toques
             WHERE campanha_id IS NOT NULL
               AND convertido_em IS NOT NULL
               AND convertido_em >= NOW() - (${dias}::text || ' days')::interval
             GROUP BY campanha_id
          )`
    : sql`receita AS (SELECT NULL::int AS campanha_id, 0::int AS pedidos, 0::numeric AS receita WHERE false)`;

  const r: any = await db.execute(sql`
    WITH ${receitaCte},
    base AS (
      SELECT u.id AS uso_id, u.asset_id, u.campanha_id, ${valorDoUso} AS valor
        FROM mkt_asset_usos u
        JOIN mkt_assets a ON a.id = u.asset_id
        ${lateral}
       WHERE u.criado_em >= NOW() - (${dias}::text || ' days')::interval
    ),
    limpa AS (
      SELECT * FROM base WHERE valor IS NOT NULL AND valor <> ''
    ),
    agg AS (
      SELECT valor,
             COUNT(DISTINCT uso_id)::int    AS usos,
             COUNT(DISTINCT asset_id)::int  AS criativos,
             COUNT(DISTINCT campanha_id)::int AS campanhas
        FROM limpa GROUP BY valor
    ),
    -- Um par (valor, campanha) por linha: assim a receita da campanha entra UMA
    -- vez por valor, e nao uma vez por uso.
    pares AS (
      SELECT DISTINCT valor, campanha_id FROM limpa WHERE campanha_id IS NOT NULL
    ),
    -- Campanha que teve mais de um valor no ar nao consegue separar o merito.
    mistura AS (
      SELECT campanha_id, COUNT(DISTINCT valor)::int AS valores FROM pares GROUP BY campanha_id
    ),
    rec AS (
      SELECT p.valor,
             COALESCE(SUM(r.pedidos), 0)::int     AS pedidos,
             COALESCE(SUM(r.receita), 0)::numeric AS receita,
             COUNT(*) FILTER (WHERE m.valores = 1)::int AS campanhas_exclusivas,
             COUNT(*) FILTER (WHERE m.valores > 1)::int AS campanhas_mistas
        FROM pares p
        JOIN mistura m ON m.campanha_id = p.campanha_id
        LEFT JOIN receita r ON r.campanha_id = p.campanha_id
       GROUP BY p.valor
    )
    SELECT a.valor, a.criativos, a.usos, a.campanhas,
           COALESCE(rc.pedidos, 0)::int    AS pedidos,
           COALESCE(rc.receita, 0)::numeric AS receita,
           COALESCE(rc.campanhas_exclusivas, 0)::int AS campanhas_exclusivas,
           COALESCE(rc.campanhas_mistas, 0)::int     AS campanhas_mistas
      FROM agg a
      LEFT JOIN rec rc ON rc.valor = a.valor
     ORDER BY receita DESC, usos DESC
  `);

  const linhas: LinhaDesempenho[] = (r.rows || []).map((x: any) => {
    const usos = Number(x.usos || 0);
    const receita = Number(x.receita || 0);
    const exclusivas = Number(x.campanhas_exclusivas || 0);
    const mistas = Number(x.campanhas_mistas || 0);
    // Amostra suficiente E pelo menos uma campanha onde este valor estava sozinho.
    // Sem isso, "gancho de margem faturou X" pode ser merito do gancho de sabor
    // que rodou na mesma campanha.
    const confiavel = usos >= AMOSTRA_MINIMA && receita > 0 && exclusivas >= 1;
    // Os motivos SOMAM. Mostrar so o primeiro esconde o mais grave: um valor com
    // 1 uso numa campanha misturada tem dois problemas, nao um.
    const motivos: string[] = [];
    if (receita === 0) motivos.push(usos > 0 ? 'usado, mas nenhuma venda chegou por campanha com fio' : 'sem uso no periodo');
    if (usos > 0 && usos < AMOSTRA_MINIMA) motivos.push('amostra pequena (' + usos + ' uso[s])');
    if (receita > 0 && exclusivas === 0) motivos.push('receita so de campanha com mais de um valor no ar - nao da para separar o merito');
    const observacao = motivos.length
      ? motivos.join(' · ') + ' - nao conclua ainda'
      : 'amostra suficiente' + (mistas > 0 ? ' (' + mistas + ' campanha[s] misturada[s] tambem contam no total)' : '');
    return {
      valor: String(x.valor),
      criativos: Number(x.criativos || 0),
      usos,
      campanhas: Number(x.campanhas || 0),
      campanhasExclusivas: exclusivas,
      campanhasMistas: mistas,
      pedidos: Number(x.pedidos || 0),
      receita,
      receitaPorUso: usos > 0 ? Number((receita / usos).toFixed(2)) : 0,
      confiavel,
      observacao,
    };
  });

  const totalUsos = linhas.reduce((s, l) => s + l.usos, 0);
  const usosComFio = linhas.filter(l => l.receita > 0).reduce((s, l) => s + l.usos, 0);
  const confiaveis = linhas.filter(l => l.confiavel).length;

  let recado: string;
  if (!temToques) recado = 'O fio de atribuicao ainda nao esta instalado - sem ele nao existe receita por criativo.';
  else if (totalUsos === 0) recado = 'Nenhum criativo foi marcado como usado no periodo. Enquanto o uso nao for registrado, nao ha o que comparar.';
  else if (confiaveis === 0) recado = 'Ja existe uso registrado, mas nenhuma venda voltou por campanha com fio. Este quadro so responde depois que a primeira campanha com link /r/ vender.';
  else if (confiaveis === 1) recado = 'So um valor tem amostra suficiente - ainda nao da para dizer qual gancho vende mais.';
  else recado = confiaveis + ' valores com amostra suficiente. Os demais aparecem, mas nao contam.';

  return { eixo: eixoOk, dias, amostraMinima: AMOSTRA_MINIMA, linhas, totalUsos, usosComFio, recado };
}

// ---------------------------------------------------------------------------
// Lacunas - o roteiro de captacao
// ---------------------------------------------------------------------------
// Quando falta material, o plano manda entregar um roteiro de captacao em vez de
// inventar imagem. Aqui o roteiro sai do que a biblioteca NAO tem.

export async function lacunas(): Promise<{
  combinacoesVazias: { publico: string; gancho: string; disponiveis: number }[];
  formatosFaltando: { formato: string; canais: string[]; disponiveis: number }[];
  semTag: number; semDireitos: number; semDimensao: number; total: number; elegiveis: number;
  roteiro: string[];
}> {
  const vazio = { combinacoesVazias: [], formatosFaltando: [], semTag: 0, semDireitos: 0, semDimensao: 0, total: 0, elegiveis: 0, roteiro: [] as string[] };
  if (!(await garantirSchema())) return vazio;

  const r: any = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ativo AND direitos_ok
        AND (ultimo_uso IS NULL OR ultimo_uso < NOW() - (${DIAS_DESCANSO_PADRAO}::text || ' days')::interval))::int AS elegiveis,
      COUNT(*) FILTER (WHERE NOT direitos_ok AND ativo)::int AS sem_direitos,
      COUNT(*) FILTER (WHERE formato = 'desconhecido')::int AS sem_dimensao,
      COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(tags->'gancho'),0) = 0
                          OR COALESCE(jsonb_array_length(tags->'publico'),0) = 0)::int AS sem_tag
      FROM mkt_assets
  `);
  const g = r.rows?.[0] || {};

  const comb: any = await db.execute(sql`
    SELECT p.publico, gc.gancho,
           (SELECT COUNT(*)::int FROM mkt_assets a
             WHERE a.ativo AND a.direitos_ok
               AND a.tags->'publico' @> to_jsonb(ARRAY[p.publico])
               AND a.tags->'gancho'  @> to_jsonb(ARRAY[gc.gancho])) AS disponiveis
      FROM (SELECT unnest(${sql.raw("ARRAY['" + PUBLICOS.join("','") + "']")}::text[]) AS publico) p
      CROSS JOIN (SELECT unnest(${sql.raw("ARRAY['" + GANCHOS.join("','") + "']")}::text[]) AS gancho) gc
     ORDER BY disponiveis ASC, p.publico, gc.gancho
  `);

  const fmt: any = await db.execute(sql`
    SELECT f.formato,
           (SELECT COUNT(*)::int FROM mkt_assets a WHERE a.ativo AND a.direitos_ok AND a.formato = f.formato) AS disponiveis
      FROM (SELECT unnest(${sql.raw("ARRAY['" + Object.keys(FORMATO_CANAL).join("','") + "']")}::text[]) AS formato) f
     ORDER BY disponiveis ASC
  `);

  const combinacoesVazias = (comb.rows || [])
    .filter((x: any) => Number(x.disponiveis) === 0)
    .map((x: any) => ({ publico: x.publico, gancho: x.gancho, disponiveis: 0 }));
  const formatosFaltando = (fmt.rows || [])
    .filter((x: any) => Number(x.disponiveis) === 0)
    .map((x: any) => ({ formato: x.formato, canais: FORMATO_CANAL[x.formato] || [], disponiveis: 0 }));

  // O roteiro fala em portugues de fotografo, nao em nome de coluna.
  const COMO_FOTOGRAFAR: Record<string, string> = {
    margem: 'display da Honest na prateleira do cliente com a etiqueta de preco visivel',
    giro: 'prateleira cheia e a mesma prateleira no fim do dia, ou a caixa vazia no deposito',
    sabor: 'garrafa aberta, copo servido, fruta ao lado - luz natural',
    saude: 'a fruta chegando e o rotulo com a lista de ingredientes legivel',
    comodidade: 'a caixa fechada com etiqueta, a entrega chegando no balcao',
    preco: 'a tabela impressa ou o display com o cartaz de preco',
    novidade: 'o sabor novo isolado, fundo limpo, em 4:5 e em 9:16',
    confianca: 'dentro da producao: selecao de fruta, envase, controle - pessoa trabalhando',
    prova_social: 'o dono do ponto de venda com o produto na mao, autorizacao de imagem assinada',
  };
  const roteiro: string[] = [];
  for (const c of combinacoesVazias.slice(0, 8)) {
    const quem = c.publico === 'b2b' ? 'revenda (dono de padaria/mercadinho)' : 'consumidor final';
    roteiro.push('Falta foto de ' + c.gancho + ' para ' + quem + ': ' + (COMO_FOTOGRAFAR[c.gancho] || 'cena que sustente esse gancho') + '.');
  }
  for (const f of formatosFaltando) {
    roteiro.push('Nenhum criativo em ' + f.formato + ' - sem ele nao da para anunciar em ' + (f.canais.join(' / ') || 'alguns canais') + '. Fotografe ja enquadrando nesse formato.');
  }
  if (Number(g.sem_dimensao) > 0) {
    roteiro.push(Number(g.sem_dimensao) + ' criativo(s) sem dimensao lida - sao arquivos por caminho, nao embutidos. O formato precisa ser confirmado a mao.');
  }

  return {
    combinacoesVazias, formatosFaltando,
    semTag: Number(g.sem_tag || 0),
    semDireitos: Number(g.sem_direitos || 0),
    semDimensao: Number(g.sem_dimensao || 0),
    total: Number(g.total || 0),
    elegiveis: Number(g.elegiveis || 0),
    roteiro,
  };
}

// ---------------------------------------------------------------------------
// Panorama para a tela
// ---------------------------------------------------------------------------

export async function panorama(): Promise<any> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const g: any = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ativo)::int AS ativos,
           COUNT(*) FILTER (WHERE ativo AND direitos_ok)::int AS liberados,
           COUNT(*) FILTER (WHERE ativo AND direitos_ok
             AND (ultimo_uso IS NULL OR ultimo_uso < NOW() - (${DIAS_DESCANSO_PADRAO}::text || ' days')::interval))::int AS elegiveis,
           COUNT(*) FILTER (WHERE usos = 0)::int AS nunca_usados,
           COUNT(*) FILTER (WHERE origem = 'ia_gerado')::int AS ia_gerado,
           COALESCE(SUM(usos),0)::int AS usos_totais
      FROM mkt_assets
  `);
  const porFormato: any = await db.execute(sql`SELECT formato, COUNT(*)::int AS n FROM mkt_assets WHERE ativo GROUP BY formato ORDER BY n DESC`);
  const porFonte: any = await db.execute(sql`SELECT fonte, COUNT(*)::int AS n FROM mkt_assets WHERE ativo GROUP BY fonte ORDER BY n DESC`);
  const porGancho: any = await db.execute(sql`
    SELECT v AS gancho, COUNT(*)::int AS n
      FROM mkt_assets a, LATERAL jsonb_array_elements_text(COALESCE(a.tags->'gancho','[]'::jsonb)) v
     WHERE a.ativo GROUP BY v ORDER BY n DESC
  `);
  return {
    ok: true,
    ...(g.rows?.[0] || {}),
    diasDescanso: DIAS_DESCANSO_PADRAO,
    porFormato: porFormato.rows || [],
    porFonte: porFonte.rows || [],
    porGancho: porGancho.rows || [],
    vocabulario: { gancho: GANCHOS, cenario: CENARIOS, publico: PUBLICOS, origem: ORIGENS },
  };
}
