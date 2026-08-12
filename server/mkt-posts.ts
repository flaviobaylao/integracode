// Central de Marketing - buraco 1: registro de post e serie historica.
//
// O buraco: "Analise vira print de celular; sem serie historica."
//
// A coleta automatica de Insights depende do App Review da Meta para
// instagram_manage_insights - e o proprio plano diz que e "o item de maior prazo".
// Mas ESPERAR nao e a unica opcao: o que faz falta e a SERIE, e serie comeca com o
// primeiro ponto. Entao aqui:
//
//   1. Todo post publicado vira registro - automaticamente, quando a peca da esteira
//      (buraco 6) e marcada como publicada. Sem digitar nada duas vezes.
//   2. As metricas podem ser DIGITADAS. Voce olha o post no celular e passa 5 numeros.
//      A serie comeca hoje, nao daqui a semanas.
//   3. O coletor da Graph API esta escrito e DESLIGADO. No dia em que o App Review
//      sair, e uma chave em system_settings - nao um deploy.
//
// Decisoes:
//  - Uma medicao por post por DIA (snapshot). Insights sao cumulativos: guardar cada
//    leitura com a data e o que permite ver crescimento em vez de so o total de hoje.
//  - Metrica digitada e metrica coletada convivem, com a origem marcada. Numero
//    digitado que some quando o automatico liga seria perder historico de graca.
//  - id varchar/uuid, como o resto do modulo.
//  - DDL preguicosa, nunca no boot.

import { db } from './db';
import { sql } from 'drizzle-orm';

export const PLATAFORMAS = ['instagram', 'facebook', 'google', 'outro'] as const;
export const MODOS_COLETA = ['off', 'test', 'on'] as const;

// As metricas que a Honest consegue ler no celular hoje, sem API nenhuma.
export const METRICAS = [
  { chave: 'alcance', rotulo: 'Alcance', dica: 'contas alcançadas' },
  { chave: 'impressoes', rotulo: 'Visualizações', dica: 'quantas vezes apareceu' },
  { chave: 'curtidas', rotulo: 'Curtidas', dica: '' },
  { chave: 'comentarios', rotulo: 'Comentários', dica: '' },
  { chave: 'salvos', rotulo: 'Salvos', dica: 'o sinal que mais prevê venda' },
  { chave: 'compartilhamentos', rotulo: 'Compartilhamentos', dica: '' },
  { chave: 'cliques_link', rotulo: 'Cliques no link', dica: '' },
  { chave: 'novos_seguidores', rotulo: 'Novos seguidores', dica: '' },
] as const;

let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktPostsSchema(): Promise<{ ok: boolean; steps: { sql: string; ok: boolean; erro?: string }[] }> {
  const steps: { sql: string; ok: boolean; erro?: string }[] = [];
  const ddl: string[] = [
    `CREATE TABLE IF NOT EXISTS social_posts (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       piece_id VARCHAR,
       plataforma VARCHAR(24) NOT NULL DEFAULT 'instagram',
       external_media_id VARCHAR,
       permalink TEXT,
       tipo VARCHAR(24),
       legenda TEXT,
       gancho VARCHAR(24),
       campanha_id VARCHAR,
       cta_slug VARCHAR,
       asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
       publicado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       criado_por VARCHAR,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS social_posts_data_idx ON social_posts (publicado_em DESC)`,
    `CREATE INDEX IF NOT EXISTS social_posts_peca_idx ON social_posts (piece_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS social_posts_media_idx ON social_posts (external_media_id) WHERE external_media_id IS NOT NULL`,
    // Uma leitura por post por dia. Insight e cumulativo: sem a data, so da para ver
    // o total de hoje e nunca o crescimento.
    `CREATE TABLE IF NOT EXISTS social_metrics (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       post_id VARCHAR NOT NULL,
       data DATE NOT NULL DEFAULT CURRENT_DATE,
       origem VARCHAR(16) NOT NULL DEFAULT 'digitado',
       alcance INTEGER, impressoes INTEGER, curtidas INTEGER, comentarios INTEGER,
       salvos INTEGER, compartilhamentos INTEGER, cliques_link INTEGER, novos_seguidores INTEGER,
       criado_por VARCHAR,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS social_metrics_dia_idx ON social_metrics (post_id, data)`,
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
  if (Date.now() - _schemaTentativa < 60_000) return false;
  _schemaTentativa = Date.now();
  await ensureMktPostsSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export type NovoPost = {
  pieceId?: string | null;
  plataforma?: string;
  permalink?: string | null;
  externalMediaId?: string | null;
  tipo?: string | null;
  legenda?: string | null;
  gancho?: string | null;
  campanhaId?: string | null;
  ctaSlug?: string | null;
  assetIds?: (string | number)[];
  publicadoEm?: string | null;
  criadoPor?: string | null;
};

/** Le o id do post a partir do permalink do Instagram (o shortcode entre /p/ e /). */
export function shortcodeDoPermalink(permalink?: string | null): string | null {
  const m = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/i.exec(String(permalink || ''));
  return m ? m[1] : null;
}

export async function registrarPost(p: NovoPost): Promise<{ ok: boolean; id?: string; duplicado?: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const plataforma = (PLATAFORMAS as readonly string[]).includes(String(p.plataforma)) ? String(p.plataforma) : 'instagram';
  const permalink = String(p.permalink || '').trim() || null;
  // Sem permalink nem id de midia, o registro nao serve para nada: nao da para
  // voltar nele depois nem para a coleta automatica encontrar.
  if (!permalink && !p.externalMediaId && !p.pieceId) {
    return { ok: false, erro: 'informe ao menos o link do post' };
  }
  const mediaId = String(p.externalMediaId || '').trim() || shortcodeDoPermalink(permalink);
  const assets = Array.isArray(p.assetIds) ? p.assetIds.map(String).filter(Boolean) : [];

  try {
    if (mediaId) {
      const ex: any = await db.execute(sql`SELECT id FROM social_posts WHERE external_media_id = ${mediaId} LIMIT 1`);
      if (ex.rows?.length) return { ok: true, id: String(ex.rows[0].id), duplicado: true };
    }
    const r: any = await db.execute(sql`
      INSERT INTO social_posts (piece_id, plataforma, external_media_id, permalink, tipo, legenda,
                                gancho, campanha_id, cta_slug, asset_ids, publicado_em, criado_por)
      VALUES (${p.pieceId || null}, ${plataforma}, ${mediaId || null}, ${permalink},
              ${p.tipo || null}, ${p.legenda || null}, ${p.gancho || null},
              ${p.campanhaId || null}, ${p.ctaSlug || null}, ${JSON.stringify(assets)}::jsonb,
              -- NULL explicito ANULA o DEFAULT da coluna: sem o COALESCE, todo post
              -- registrado sem data batia no NOT NULL de publicado_em.
              COALESCE(${p.publicadoEm || null}::timestamptz, NOW()), ${p.criadoPor || null})
      RETURNING id
    `);
    return { ok: true, id: String(r.rows[0].id), duplicado: false };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

/**
 * Chamado quando a peca da esteira e marcada como publicada. Nao pede nada de novo:
 * a peca ja sabe canal, gancho, campanha, criativo e legenda.
 */
export async function registrarDaPeca(peca: any, permalink?: string | null, quem?: string | null): Promise<{ ok: boolean; id?: string; erro?: string }> {
  if (!peca) return { ok: false, erro: 'peca ausente' };
  return registrarPost({
    pieceId: String(peca.id),
    plataforma: String(peca.canal || 'instagram'),
    permalink: permalink || peca.permalink || null,
    externalMediaId: peca.external_media_id || null,
    legenda: peca.copy || null,
    gancho: peca.gancho || null,
    campanhaId: peca.campanha_id || null,
    ctaSlug: peca.cta_slug || null,
    assetIds: Array.isArray(peca.asset_ids) ? peca.asset_ids : [],
    criadoPor: quem || null,
  });
}

export async function verPost(id: string): Promise<any | null> {
  if (!(await garantirSchema())) return null;
  const pid = String(id || '').trim();
  if (!pid) return null;
  const r: any = await db.execute(sql`SELECT * FROM social_posts WHERE id = ${pid} LIMIT 1`);
  return r.rows?.[0] || null;
}

export async function removerPost(id: string): Promise<{ ok: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPost(id);
  if (!p) return { ok: false, erro: 'post nao encontrado' };
  try {
    await db.execute(sql`DELETE FROM social_metrics WHERE post_id = ${id}`);
    await db.execute(sql`DELETE FROM social_posts WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) { return { ok: false, erro: String(e?.message || e) }; }
}

// ---------------------------------------------------------------------------
// Metricas — digitadas hoje, coletadas quando a Meta liberar
// ---------------------------------------------------------------------------

export type Medicao = Partial<Record<typeof METRICAS[number]['chave'], number | null>> & {
  data?: string | null; origem?: 'digitado' | 'coletado'; criadoPor?: string | null;
};

function inteiro(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export async function anotarMedicao(postId: string, m: Medicao): Promise<{ ok: boolean; atualizou?: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const post = await verPost(postId);
  if (!post) return { ok: false, erro: 'post nao encontrado' };

  const v = {
    alcance: inteiro(m.alcance), impressoes: inteiro(m.impressoes), curtidas: inteiro(m.curtidas),
    comentarios: inteiro(m.comentarios), salvos: inteiro(m.salvos),
    compartilhamentos: inteiro(m.compartilhamentos), cliques_link: inteiro(m.cliques_link),
    novos_seguidores: inteiro(m.novos_seguidores),
  };
  if (Object.values(v).every(x => x === null)) return { ok: false, erro: 'nenhum numero informado' };

  const origem = m.origem === 'coletado' ? 'coletado' : 'digitado';
  try {
    // Uma medicao por post por dia: reler no mesmo dia atualiza, nao empilha.
    const r: any = await db.execute(sql`
      INSERT INTO social_metrics (post_id, data, origem, alcance, impressoes, curtidas, comentarios,
                                  salvos, compartilhamentos, cliques_link, novos_seguidores, criado_por)
      VALUES (${postId}, COALESCE(${m.data || null}::date, CURRENT_DATE), ${origem},
              ${v.alcance}, ${v.impressoes}, ${v.curtidas}, ${v.comentarios},
              ${v.salvos}, ${v.compartilhamentos}, ${v.cliques_link}, ${v.novos_seguidores}, ${m.criadoPor || null})
      ON CONFLICT (post_id, data) DO UPDATE SET
        origem = EXCLUDED.origem,
        alcance = COALESCE(EXCLUDED.alcance, social_metrics.alcance),
        impressoes = COALESCE(EXCLUDED.impressoes, social_metrics.impressoes),
        curtidas = COALESCE(EXCLUDED.curtidas, social_metrics.curtidas),
        comentarios = COALESCE(EXCLUDED.comentarios, social_metrics.comentarios),
        salvos = COALESCE(EXCLUDED.salvos, social_metrics.salvos),
        compartilhamentos = COALESCE(EXCLUDED.compartilhamentos, social_metrics.compartilhamentos),
        cliques_link = COALESCE(EXCLUDED.cliques_link, social_metrics.cliques_link),
        novos_seguidores = COALESCE(EXCLUDED.novos_seguidores, social_metrics.novos_seguidores)
      RETURNING (xmax <> 0) AS atualizou
    `);
    return { ok: true, atualizou: r.rows?.[0]?.atualizou === true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

export async function serieDoPost(postId: string): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const r: any = await db.execute(sql`SELECT * FROM social_metrics WHERE post_id = ${postId} ORDER BY data ASC`);
  return r.rows || [];
}

// ---------------------------------------------------------------------------
// A lista, com a ultima medicao de cada post
// ---------------------------------------------------------------------------

export async function listarPosts(dias = 90, limite = 60): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const lim = Math.min(Math.max(Number(limite) || 60, 1), 200);
  let temToques = true;
  try { await db.execute(sql.raw('SELECT 1 FROM mkt_toques LIMIT 1')); } catch { temToques = false; }

  const receita = temToques
    ? sql`LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE sales_card_id IS NOT NULL)::int AS pedidos,
                   COALESCE(SUM(valor),0)::numeric AS receita
              FROM mkt_toques t
             WHERE t.campanha_id = p.campanha_id AND t.convertido_em IS NOT NULL
          ) r ON true`
    : sql`LEFT JOIN LATERAL (SELECT 0::int AS pedidos, 0::numeric AS receita) r ON true`;

  const q: any = await db.execute(sql`
    SELECT p.*, c.codigo AS campanha_codigo,
           m.data AS medido_em, m.origem AS medido_origem,
           m.alcance, m.impressoes, m.curtidas, m.comentarios, m.salvos,
           m.compartilhamentos, m.cliques_link, m.novos_seguidores,
           (SELECT COUNT(*)::int FROM social_metrics x WHERE x.post_id = p.id) AS medicoes,
           r.pedidos, r.receita
      FROM social_posts p
      -- O ULTIMO VALOR CONHECIDO de cada metrica, nao os valores da ultima linha.
      -- Digitar so o alcance num dia nao pode fazer o cartao mostrar zero curtidas,
      -- como se o post tivesse perdido as curtidas que ja tinha.
      LEFT JOIN LATERAL (
        SELECT MAX(s.data) AS data,
               (array_agg(s.origem ORDER BY s.data DESC))[1] AS origem,
               (array_agg(s.alcance ORDER BY s.data DESC) FILTER (WHERE s.alcance IS NOT NULL))[1] AS alcance,
               (array_agg(s.impressoes ORDER BY s.data DESC) FILTER (WHERE s.impressoes IS NOT NULL))[1] AS impressoes,
               (array_agg(s.curtidas ORDER BY s.data DESC) FILTER (WHERE s.curtidas IS NOT NULL))[1] AS curtidas,
               (array_agg(s.comentarios ORDER BY s.data DESC) FILTER (WHERE s.comentarios IS NOT NULL))[1] AS comentarios,
               (array_agg(s.salvos ORDER BY s.data DESC) FILTER (WHERE s.salvos IS NOT NULL))[1] AS salvos,
               (array_agg(s.compartilhamentos ORDER BY s.data DESC) FILTER (WHERE s.compartilhamentos IS NOT NULL))[1] AS compartilhamentos,
               (array_agg(s.cliques_link ORDER BY s.data DESC) FILTER (WHERE s.cliques_link IS NOT NULL))[1] AS cliques_link,
               (array_agg(s.novos_seguidores ORDER BY s.data DESC) FILTER (WHERE s.novos_seguidores IS NOT NULL))[1] AS novos_seguidores
          FROM social_metrics s WHERE s.post_id = p.id
      ) m ON true
      LEFT JOIN mkt_campanhas c ON c.id = p.campanha_id
      ${receita}
     WHERE p.publicado_em >= NOW() - (${dias}::text || ' days')::interval
     ORDER BY p.publicado_em DESC
     LIMIT ${lim}
  `);

  return (q.rows || []).map((x: any) => {
    const assets: string[] = Array.isArray(x.asset_ids) ? x.asset_ids.map(String) : [];
    const inter = Number(x.curtidas || 0) + Number(x.comentarios || 0) + Number(x.salvos || 0) + Number(x.compartilhamentos || 0);
    const alcance = Number(x.alcance || 0);
    return {
      ...x,
      miniaturas: assets.slice(0, 3).map(a => '/api/mkt/assets/' + a + '/arquivo'),
      previa: String(x.legenda || '').slice(0, 140),
      interacoes: inter,
      // Taxa sobre ALCANCE, nao sobre seguidores: seguidor que nao viu o post nao
      // deveria entrar no denominador de engajamento.
      taxaEngajamento: alcance > 0 ? Number(((inter / alcance) * 100).toFixed(2)) : null,
      semMedicao: Number(x.medicoes || 0) === 0,
    };
  });
}

export async function panoramaPosts(dias = 90): Promise<any> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const g: any = await db.execute(sql`
    SELECT COUNT(*)::int AS posts,
           COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM social_metrics m WHERE m.post_id = p.id))::int AS sem_medicao,
           COUNT(DISTINCT campanha_id) FILTER (WHERE campanha_id IS NOT NULL)::int AS campanhas
      FROM social_posts p
     WHERE publicado_em >= NOW() - (${dias}::text || ' days')::interval`);
  const m: any = await db.execute(sql`
    SELECT COUNT(*)::int AS medicoes,
           COUNT(*) FILTER (WHERE origem = 'digitado')::int AS digitadas,
           COUNT(*) FILTER (WHERE origem = 'coletado')::int AS coletadas,
           MIN(data) AS primeira, MAX(data) AS ultima
      FROM social_metrics`);
  const modo = await modoColeta();
  const linha = { ...(g.rows?.[0] || {}), ...(m.rows?.[0] || {}) };
  const diasDeSerie = linha.primeira && linha.ultima
    ? Math.round((new Date(linha.ultima).getTime() - new Date(linha.primeira).getTime()) / 86400000) + 1 : 0;
  return {
    ok: true, dias, ...linha, diasDeSerie,
    modoColeta: modo.modo, coletaPronta: modo.pronto, faltaParaColetar: modo.falta,
    metricas: METRICAS,
  };
}

// ---------------------------------------------------------------------------
// Coleta automatica — escrita, e desligada ate o App Review sair
// ---------------------------------------------------------------------------

export async function modoColeta(): Promise<{ modo: string; pronto: boolean; falta: string[] }> {
  let modo = 'off';
  try {
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'mkt_insights_modo' LIMIT 1"));
    const v = r.rows?.[0]?.value;
    if (v) modo = String(v).replace(/^"|"$/g, '');
  } catch { /* padrao off */ }
  const falta: string[] = [];
  if (!process.env.IG_PAGE_TOKEN) falta.push('IG_PAGE_TOKEN');
  if (!process.env.IG_BUSINESS_ID) falta.push('IG_BUSINESS_ID (id da conta profissional)');
  return { modo, pronto: falta.length === 0, falta };
}

export async function definirModoColeta(modo: string, quem?: string): Promise<{ ok: boolean; modo?: string; erro?: string }> {
  if (!(MODOS_COLETA as readonly string[]).includes(modo)) return { ok: false, erro: 'modo invalido' };
  const st = await modoColeta();
  // Ligar sem credencial so gera erro em silencio no cron. Melhor recusar aqui.
  if (modo !== 'off' && !st.pronto) {
    return { ok: false, erro: 'falta ' + st.falta.join(' e ') + '. A coleta depende do App Review da Meta para instagram_manage_insights.' };
  }
  try {
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_insights_modo', ${modo}, ${quem || 'mkt-posts'})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`);
    return { ok: true, modo };
  } catch (e: any) { return { ok: false, erro: String(e?.message || e) }; }
}

// Nomes das metricas na Graph API -> nossas colunas.
const DE_PARA_GRAPH: Record<string, string> = {
  reach: 'alcance', impressions: 'impressoes', likes: 'curtidas',
  comments: 'comentarios', saved: 'salvos', shares: 'compartilhamentos',
};

/**
 * Coleta os Insights de um post. INERTE enquanto o modo for 'off'.
 * Em 'test' busca e devolve o que veio, mas NAO grava - o mesmo padrao do CAPI
 * no buraco 3, para dar para conferir o retorno antes de confiar nele.
 */
export async function coletarInsights(postId: string): Promise<{ ok: boolean; gravou?: boolean; modo?: string; dados?: any; erro?: string }> {
  const st = await modoColeta();
  if (st.modo === 'off') return { ok: false, modo: 'off', erro: 'coleta desligada' };
  const post = await verPost(postId);
  if (!post) return { ok: false, erro: 'post nao encontrado' };
  const mediaId = String(post.external_media_id || '');
  if (!mediaId) return { ok: false, erro: 'post sem id de midia da Meta - so da para coletar em post publicado pela API' };

  try {
    const base = `${process.env.IG_GRAPH_BASE || 'https://graph.facebook.com'}/${process.env.GRAPH_VERSION || 'v21.0'}`;
    const metricas = Object.keys(DE_PARA_GRAPH).join(',');
    const url = `${base}/${encodeURIComponent(mediaId)}/insights?metric=${metricas}&access_token=${encodeURIComponent(String(process.env.IG_PAGE_TOKEN))}`;
    const resp = await fetch(url);
    const j: any = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, modo: st.modo, erro: j?.error?.message || ('HTTP ' + resp.status), dados: j };

    const valores: any = {};
    for (const item of (j.data || [])) {
      const col = DE_PARA_GRAPH[String(item.name)];
      if (col) valores[col] = Number(item.values?.[0]?.value ?? 0);
    }
    if (st.modo === 'test') return { ok: true, gravou: false, modo: 'test', dados: valores };

    const r = await anotarMedicao(postId, { ...valores, origem: 'coletado', criadoPor: 'coletor' });
    return { ok: r.ok, gravou: r.ok, modo: 'on', dados: valores, erro: r.erro };
  } catch (e: any) {
    return { ok: false, modo: st.modo, erro: String(e?.message || e) };
  }
}

/** Varre os posts recentes. Chamada pelo cron; inerte enquanto o modo for 'off'. */
export async function coletarTodos(dias = 30): Promise<{ ok: boolean; modo: string; tentados: number; gravados: number; erros: number }> {
  const st = await modoColeta();
  if (st.modo === 'off') return { ok: true, modo: 'off', tentados: 0, gravados: 0, erros: 0 };
  if (!(await garantirSchema())) return { ok: false, modo: st.modo, tentados: 0, gravados: 0, erros: 0 };
  let tentados = 0, gravados = 0, erros = 0;
  try {
    const r: any = await db.execute(sql`
      SELECT id FROM social_posts
       WHERE external_media_id IS NOT NULL
         AND publicado_em >= NOW() - (${dias}::text || ' days')::interval
       ORDER BY publicado_em DESC LIMIT 100`);
    for (const p of (r.rows || [])) {
      tentados++;
      const c = await coletarInsights(String(p.id));
      if (c.gravou) gravados++; else if (!c.ok) erros++;
    }
  } catch { erros++; }
  return { ok: true, modo: st.modo, tentados, gravados, erros };
}
