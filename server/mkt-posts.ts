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
// 'views' e 'impressions' caem na MESMA coluna de proposito: sao a mesma ideia com
// nomes de epocas diferentes (a Meta aposentou impressions na v22 e chamou o
// substituto de views). A tela ja rotula essa coluna como "Visualizacoes".
const DE_PARA_GRAPH: Record<string, string> = {
  reach: 'alcance', impressions: 'impressoes', views: 'impressoes', likes: 'curtidas',
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
    // Pede pela escada de metricas, nao pela lista inteira de uma vez. A sonda de
    // 13/ago provou o motivo: com 'impressions' junto, a Meta devolve 400 e a coleta
    // perderia TODAS as metricas do post por causa de uma so que a v22 aposentou.
    const r0 = await lerInsights(mediaId);
    if (!r0.ok) return { ok: false, modo: st.modo, erro: r0.erro, dados: r0.corpo };
    const valores: any = r0.dados;
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

// ---------------------------------------------------------------------------
// Sonda: a pergunta "precisa de App Review?" respondida com fato, nao com palpite
// ---------------------------------------------------------------------------
//
// coletarInsights() so funciona em post JA registrado e COM external_media_id, e
// hoje nao existe jeito de descobrir esse id sem sair catando na mao. Entao ligar
// a coleta em 'test' nao testa nada: ela nao tem em que bater.
//
// Esta sonda faz a pergunta direto na API, em tres degraus, e diz em qual degrau
// parou. Cada degrau depende de uma permissao diferente - e e exatamente isso que
// separa "acesso padrao ja basta" de "tem que protocolar App Review":
//
//   1. a conta responde?            -> instagram_business_basic
//   2. da para listar as midias?    -> instagram_business_basic
//   3. da para ler os Insights?     -> instagram_business_manage_insights  <- item 16
//
// Nao grava nada e nao depende do modo de coleta. E leitura pura, de proposito:
// serve para decidir, e decisao errada aqui custa semanas de espera.

/**
 * A escada de metricas, do mais completo para o mais conservador.
 *
 * Pedir a lista inteira de uma vez e tentador e errado: a Graph API responde 400
 * para o LOTE se UMA metrica nao existir mais naquela versao, e ai o post inteiro
 * volta sem numero nenhum. Foi o que a sonda de 13/ago mostrou - 'impressions' saiu
 * na v22, e com ela na lista nao vinha nada.
 *
 * Cada degrau abaixo tira o que a Meta pode ter aposentado, ate sobrar o que prova
 * que a permissao esta de pe. Quem chama fica com o degrau mais alto que passou.
 */
const TENTATIVAS_METRICAS = [
  ['reach', 'views', 'likes', 'comments', 'saved', 'shares'],       // v22+ (views substituiu impressions)
  ['reach', 'impressions', 'likes', 'comments', 'saved', 'shares'], // ate a v21
  ['reach', 'likes', 'comments', 'saved', 'shares'],                // sem visualizacoes
  ['reach'],                                                        // o minimo que prova a permissao
];

/** Quantas metricas o degrau mais completo entrega. Serve so para dizer "veio tudo". */
const METRICAS_COMPLETAS = TENTATIVAS_METRICAS[0].length;

/**
 * Le os Insights de UMA midia descendo a escada de metricas. Devolve o que veio
 * ja traduzido para as nossas colunas, mais qual degrau passou. Nao grava nada.
 */
async function lerInsights(mediaId: string): Promise<{
  ok: boolean; dados?: Record<string, number>; metricas?: string[];
  erro?: string; codigo?: number; subcodigo?: number; corpo?: any;
}> {
  let ultimo: { ok: boolean; corpo: any; erro?: string; codigo?: number; subcodigo?: number } | null = null;
  for (const metricas of TENTATIVAS_METRICAS) {
    const r = await pegarGraph(`${encodeURIComponent(mediaId)}/insights`, { metric: metricas.join(',') });
    ultimo = r;
    if (!r.ok) continue;
    const dados: Record<string, number> = {};
    for (const item of (r.corpo?.data || [])) {
      const col = DE_PARA_GRAPH[String(item.name)];
      if (col) dados[col] = Number(item.values?.[0]?.value ?? 0);
    }
    return { ok: true, dados, metricas };
  }
  return {
    ok: false, erro: ultimo?.erro, codigo: ultimo?.codigo,
    subcodigo: ultimo?.subcodigo, corpo: ultimo?.corpo,
    metricas: TENTATIVAS_METRICAS[TENTATIVAS_METRICAS.length - 1],
  };
}

function baseGraph(): string {
  return `${process.env.IG_GRAPH_BASE || 'https://graph.facebook.com'}/${process.env.GRAPH_VERSION || 'v21.0'}`;
}

/** GET na Graph API devolvendo corpo + erro normalizado, sem nunca vazar o token. */
async function pegarGraph(caminho: string, params: Record<string, string>): Promise<{ ok: boolean; corpo: any; erro?: string; codigo?: number; subcodigo?: number; http?: number }> {
  const token = String(process.env.IG_PAGE_TOKEN || '');
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  try {
    const r = await fetch(`${baseGraph()}/${caminho}?${qs}`);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      return {
        ok: false, corpo: j, http: r.status,
        erro: j?.error?.message || `HTTP ${r.status}`,
        codigo: j?.error?.code, subcodigo: j?.error?.error_subcode,
      };
    }
    return { ok: true, corpo: j, http: r.status };
  } catch (e: any) {
    return { ok: false, corpo: null, erro: String(e?.message || e) };
  }
}

export type SondaInstagram = {
  ok: boolean;
  falta: string[];
  degrau: 'credenciais' | 'conta' | 'midias' | 'insights' | 'completo';
  conta?: { id?: string; username?: string; media_count?: number };
  midias?: { id: string; permalink?: string; media_type?: string; timestamp?: string; legenda?: string }[];
  insights?: { mediaId: string; metricas: string[]; dados?: Record<string, number>; erro?: string; codigo?: number; subcodigo?: number };
  precisaAppReview?: boolean;
  veredito: string;
};

/**
 * Sonda o Instagram e devolve ate onde deu. `limite` = quantas midias listar.
 * Nunca escreve. Nunca devolve o token.
 */
export async function sondarInstagram(limite = 5): Promise<SondaInstagram> {
  const st = await modoColeta();
  if (!st.pronto) {
    return {
      ok: false, falta: st.falta, degrau: 'credenciais',
      veredito: 'Falta ' + st.falta.join(' e ') + ' no Railway. Sem isso nao da nem para perguntar.',
    };
  }
  const contaId = String(process.env.IG_BUSINESS_ID);
  const n = Math.min(Math.max(Number(limite) || 5, 1), 25);

  // Degrau 1 - a conta responde?
  const c = await pegarGraph(contaId, { fields: 'id,username,media_count' });
  if (!c.ok) {
    return {
      ok: false, falta: [], degrau: 'conta',
      veredito: 'A conta nao respondeu: ' + (c.erro || 'erro desconhecido')
        + '. Antes de pensar em App Review, confira o IG_BUSINESS_ID e a validade do IG_PAGE_TOKEN.',
    };
  }
  const conta = { id: c.corpo?.id, username: c.corpo?.username, media_count: c.corpo?.media_count };

  // Degrau 2 - da para listar as midias?
  const m = await pegarGraph(`${contaId}/media`, {
    fields: 'id,permalink,media_type,timestamp,caption', limit: String(n),
  });
  if (!m.ok) {
    return {
      ok: false, falta: [], degrau: 'midias', conta,
      veredito: 'A conta responde, mas a lista de midias nao: ' + (m.erro || 'erro desconhecido')
        + '. Isso e instagram_business_basic, nao insights.',
    };
  }
  const midias = (m.corpo?.data || []).map((x: any) => ({
    id: String(x.id), permalink: x.permalink, media_type: x.media_type,
    timestamp: x.timestamp, legenda: String(x.caption || '').slice(0, 140),
  }));
  if (!midias.length) {
    return {
      ok: true, falta: [], degrau: 'midias', conta, midias: [],
      veredito: 'Credenciais boas e a conta responde, mas nao ha midia publicada para medir. '
        + 'Publique um post e rode a sonda de novo.',
    };
  }

  // Degrau 3 - da para ler os Insights? (a pergunta do item 16)
  // Usa a MESMA escada da coleta de verdade, de proposito: sonda que testa um
  // caminho diferente do que roda em producao nao prova nada.
  const alvo = midias[0];
  const ins = await lerInsights(alvo.id);
  if (ins.ok) {
    const completo = (ins.metricas || []).length >= METRICAS_COMPLETAS;
    return {
      ok: true, falta: [], degrau: 'completo', conta, midias,
      insights: { mediaId: alvo.id, metricas: ins.metricas || [], dados: ins.dados },
      precisaAppReview: false,
      veredito: completo
        ? 'Os Insights vieram com o acesso padrao. O item 16 nao precisa de App Review — pode ligar a coleta.'
        : 'Os Insights vieram, mas so com ' + (ins.metricas || []).join(', ') + '. A permissao esta OK; '
          + 'o que sobrou de fora e metrica que esta versao da API nao serve mais.',
    };
  }

  // Nenhum degrau passou: agora sim a resposta pode ser App Review.
  const permissao = /permission|scope|OAuth|autoriza/i.test(String(ins.erro || ''));
  return {
    ok: false, falta: [], degrau: 'insights', conta, midias,
    insights: { mediaId: alvo.id, metricas: ins.metricas || [], erro: ins.erro, codigo: ins.codigo, subcodigo: ins.subcodigo },
    precisaAppReview: permissao,
    veredito: permissao
      ? 'A conta e as midias respondem, mas os Insights nao: "' + (ins.erro || '') + '". '
        + 'E erro de permissao — o item 16 precisa mesmo do App Review de instagram_business_manage_insights.'
      : 'Os Insights falharam por outro motivo: "' + (ins.erro || '') + '". '
        + 'Nao parece permissao; vale resolver isso antes de protocolar App Review.',
  };
}
