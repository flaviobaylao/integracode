// ============================================================================
// CENTRAL DE MARKETING — ANUNCIO PAGO NA META (Marketing API, Click-to-WhatsApp)
// ----------------------------------------------------------------------------
// Fecha o tipo 'anuncio' da Caixa. A acao aprovada vira, na conta de anuncios da
// Honest: campanha (OUTCOME_ENGAGEMENT) -> conjunto (destino WHATSAPP, orcamento
// diario, geo por raio) -> criativo (foto do acervo + legenda) -> anuncio.
// Tudo nasce PAUSADO e so e ATIVADO quando a acao e aprovada (N2 sempre humano).
// A conversa que nasce do anuncio chega com ctwa_clid (mkt-ctwa) e vira pedido
// medido pelo fio; a CAPI devolve o resultado para a Meta otimizar por quem compra.
//
// ENV (Railway):
//   META_AD_ACCOUNT_ID   act_123... (conta de anuncios no Gerenciador)
//   META_ADS_TOKEN       token de usuario do sistema com ads_management (fallback: META_CAPI_TOKEN)
//   META_PAGE_ID         pagina do Facebook ligada ao WhatsApp 1841 (ja existe para CTWA)
//   META_IG_ACTOR_ID     (opcional) id da conta do Instagram no Business — para o anuncio sair tambem no IG
//   META_ADS_LAT / META_ADS_LNG / META_ADS_RAIO_KM  (opcional) centro e raio padrao (default: Goiania, 40 km)
//
// Modos (system_settings.mkt_ads_modo): off | test | on. Nasce em 'test': cria
// campanha PAUSADA e nao ativa. 'on': ativa ao aprovar. Teto por dia/duracao vem
// da politica 'anuncio' (mkt_politicas.teto_custo_dia) e do proprio Radar.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const GRAPH = () => 'https://graph.facebook.com/' + (process.env.GRAPH_VERSION || 'v21.0');
const NUMERO_WHATSAPP = '5562994981841';
export const AGENTE = 'mkt_publicador'; // custo de API vai para o mesmo balde do publicador (provedor meta)

async function getSetting(k: string, d: string): Promise<string> {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${k} LIMIT 1`); const v = r.rows?.[0]?.value; return v ? String(v).replace(/^"|"$/g, '') : d; } catch { return d; }
}

export function config() {
  const conta = String(process.env.META_AD_ACCOUNT_ID || '').trim();
  return {
    conta: conta ? (conta.startsWith('act_') ? conta : 'act_' + conta) : '',
    token: String(process.env.META_ADS_TOKEN || process.env.META_CAPI_TOKEN || '').trim(),
    pageId: String(process.env.META_PAGE_ID || '').trim(),
    igActorId: String(process.env.META_IG_ACTOR_ID || '').trim() || null,
    lat: Number(process.env.META_ADS_LAT) || -16.6869, lng: Number(process.env.META_ADS_LNG) || -49.2648,
    raioKm: Math.min(80, Math.max(5, Number(process.env.META_ADS_RAIO_KM) || 40)),
  };
}
export function pronto(): { ok: boolean; falta: string[] } {
  const c = config(); const falta: string[] = [];
  if (!c.conta) falta.push('META_AD_ACCOUNT_ID'); if (!c.token) falta.push('META_ADS_TOKEN'); if (!c.pageId) falta.push('META_PAGE_ID');
  return { ok: !falta.length, falta };
}
export async function modo(): Promise<string> { return getSetting('mkt_ads_modo', 'test'); }
export async function definirModo(m: string, quem = 'mkt-ads'): Promise<{ ok: boolean; erro?: string }> {
  if (!['off', 'test', 'on'].includes(m)) return { ok: false, erro: 'modo inválido' };
  if (m !== 'off') { const p = pronto(); if (!p.ok) return { ok: false, erro: 'faltam ' + p.falta.join(', ') + ' no Railway' }; }
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_ads_modo', ${m}, ${quem}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  return { ok: true };
}

async function graph(metodo: 'GET' | 'POST', caminho: string, params: Record<string, any>): Promise<{ ok: boolean; corpo: any; erro?: string }> {
  const c = config();
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) body[k] = typeof v === 'string' ? v : JSON.stringify(v);
  body.access_token = c.token;
  try {
    const r = metodo === 'GET'
      ? await fetch(GRAPH() + '/' + caminho + '?' + new URLSearchParams(body).toString())
      : await fetch(GRAPH() + '/' + caminho, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) return { ok: false, corpo: j, erro: (j?.error?.error_user_msg || j?.error?.message || ('HTTP ' + r.status)) };
    return { ok: true, corpo: j };
  } catch (e: any) { return { ok: false, corpo: null, erro: String(e?.message || e) }; }
}

export async function ensureMktAdsSchema(): Promise<void> {
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS mkt_ads (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), acao_id varchar, campanha_meta_id varchar, adset_meta_id varchar, ad_meta_id varchar, creative_meta_id varchar,
      nome varchar, plataforma varchar NOT NULL DEFAULT 'meta', objetivo varchar, orcamento_dia numeric(10,2), dias int, inicio timestamptz, fim timestamptz,
      status varchar NOT NULL DEFAULT 'pausado', asset_id int, peca_id varchar, legenda text, criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz)`));
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS mkt_ads_diario (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), ad_id varchar NOT NULL, data date NOT NULL, gasto numeric(10,2) NOT NULL DEFAULT 0,
      impressoes int NOT NULL DEFAULT 0, cliques int NOT NULL DEFAULT 0, conversas int NOT NULL DEFAULT 0, alcance int NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now())`));
    await db.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_ads_diario_dia ON mkt_ads_diario (ad_id, data)`));
  } catch (e: any) { console.error('[MKT-ADS] schema:', e?.message || e); }
}

/** Conta de anuncios responde? Nome, moeda, gasto acumulado. */
export async function status(): Promise<any> {
  const p = pronto(); const m = await modo();
  if (!p.ok) return { pronto: false, falta: p.falta, modo: m };
  const c = config();
  const r = await graph('GET', c.conta, { fields: 'name,currency,account_status,amount_spent,balance' });
  if (!r.ok) return { pronto: true, modo: m, conta: c.conta, erro: r.erro };
  const gasto30: any = await db.execute(sql.raw(`SELECT COALESCE(SUM(gasto),0)::float AS g, COALESCE(SUM(conversas),0)::int AS c FROM mkt_ads_diario WHERE data >= CURRENT_DATE - 30`)).catch(() => ({ rows: [] }));
  const ativos: any = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM mkt_ads WHERE status = 'ativo'`)).catch(() => ({ rows: [] }));
  return { pronto: true, modo: m, conta: c.conta, nome: r.corpo?.name, moeda: r.corpo?.currency, statusConta: r.corpo?.account_status, gastoTotalCentavos: r.corpo?.amount_spent,
    gasto30d: Number(gasto30.rows?.[0]?.g || 0), conversas30d: Number(gasto30.rows?.[0]?.c || 0), ativos: Number(ativos.rows?.[0]?.n || 0), igActor: !!c.igActorId };
}

export type NovoAnuncio = {
  nome: string; legenda: string; assetId: number; orcamentoDia: number; dias: number;
  acaoId?: string | null; pecaId?: string | null; raioKm?: number; lat?: number; lng?: number; ativar?: boolean;
};

/** Cria campanha -> adset -> criativo -> anuncio (todos PAUSADOS); ativa se pedido. */
export async function criarAnuncioCTWA(n: NovoAnuncio): Promise<{ ok: boolean; adId?: string; campanhaMetaId?: string; adMetaId?: string; link?: string; erro?: string; etapa?: string }> {
  const p = pronto(); if (!p.ok) return { ok: false, erro: 'faltam ' + p.falta.join(', '), etapa: 'config' };
  await ensureMktAdsSchema();
  const c = config();
  const orc = Math.max(5, Math.round(Number(n.orcamentoDia) || 0));
  const dias = Math.min(30, Math.max(1, Math.round(Number(n.dias) || 3)));
  const inicio = new Date(Date.now() + 10 * 60 * 1000);
  const fim = new Date(inicio.getTime() + dias * 86400000);

  // 1. campanha
  const camp = await graph('POST', c.conta + '/campaigns', { name: n.nome.slice(0, 100), objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: [], buying_type: 'AUCTION' });
  if (!camp.ok) return { ok: false, erro: camp.erro, etapa: 'campanha' };
  const campId = String(camp.corpo?.id || '');

  // 2. conjunto: destino WhatsApp, orcamento diario em centavos, geo por raio
  const adset = await graph('POST', c.conta + '/adsets', {
    name: n.nome.slice(0, 90) + ' · conjunto', campaign_id: campId, status: 'PAUSED',
    daily_budget: String(orc * 100), billing_event: 'IMPRESSIONS', optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP',
    promoted_object: { page_id: c.pageId, whatsapp_phone_number: NUMERO_WHATSAPP },
    targeting: { geo_locations: { custom_locations: [{ latitude: n.lat ?? c.lat, longitude: n.lng ?? c.lng, radius: n.raioKm ?? c.raioKm, distance_unit: 'kilometer' }] }, age_min: 18, publisher_platforms: c.igActorId ? ['facebook', 'instagram'] : ['facebook'] },
    start_time: inicio.toISOString(), end_time: fim.toISOString(),
  });
  if (!adset.ok) return { ok: false, erro: adset.erro, etapa: 'conjunto', campanhaMetaId: campId };
  const adsetId = String(adset.corpo?.id || '');

  // 3. imagem: a foto do acervo normalizada (JPEG, proporcao valida), enviada em base64
  let imageHash = '';
  try {
    const { arquivoDoAsset } = await import('./mkt-assets');
    const { normalizarParaInstagram } = await import('./mkt-entrega');
    const a = await arquivoDoAsset(n.assetId);
    if (!a) return { ok: false, erro: 'foto ' + n.assetId + ' não encontrada', etapa: 'imagem', campanhaMetaId: campId };
    const jpg = (await normalizarParaInstagram(a.buf)) || a.buf;
    const img = await graph('POST', c.conta + '/adimages', { bytes: jpg.toString('base64') });
    if (!img.ok) return { ok: false, erro: img.erro, etapa: 'imagem', campanhaMetaId: campId };
    const imgs = img.corpo?.images || {}; const first: any = Object.values(imgs)[0];
    imageHash = String(first?.hash || '');
    if (!imageHash) return { ok: false, erro: 'Meta não devolveu hash da imagem', etapa: 'imagem', campanhaMetaId: campId };
  } catch (e: any) { return { ok: false, erro: String(e?.message || e), etapa: 'imagem', campanhaMetaId: campId }; }

  // 4. criativo: foto + legenda + botao "Enviar mensagem" (WhatsApp)
  const spec: any = { page_id: c.pageId, link_data: { image_hash: imageHash, message: n.legenda.slice(0, 2000), link: 'https://wa.me/' + NUMERO_WHATSAPP,
    call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } } };
  if (c.igActorId) spec.instagram_actor_id = c.igActorId;
  const cr = await graph('POST', c.conta + '/adcreatives', { name: n.nome.slice(0, 90) + ' · criativo', object_story_spec: spec });
  if (!cr.ok) return { ok: false, erro: cr.erro, etapa: 'criativo', campanhaMetaId: campId };
  const creativeId = String(cr.corpo?.id || '');

  // 5. anuncio
  const ad = await graph('POST', c.conta + '/ads', { name: n.nome.slice(0, 100), adset_id: adsetId, creative: { creative_id: creativeId }, status: 'PAUSED' });
  if (!ad.ok) return { ok: false, erro: ad.erro, etapa: 'anuncio', campanhaMetaId: campId };
  const adMetaId = String(ad.corpo?.id || '');

  const ins: any = await db.execute(sql`INSERT INTO mkt_ads (acao_id, campanha_meta_id, adset_meta_id, ad_meta_id, creative_meta_id, nome, objetivo, orcamento_dia, dias, inicio, fim, status, asset_id, peca_id, legenda)
    VALUES (${n.acaoId || null}, ${campId}, ${adsetId}, ${adMetaId}, ${creativeId}, ${n.nome.slice(0, 120)}, 'ctwa', ${orc}, ${dias}, ${inicio.toISOString()}, ${fim.toISOString()}, 'pausado', ${n.assetId}, ${n.pecaId || null}, ${n.legenda.slice(0, 2000)}) RETURNING id`);
  const adId = String(ins.rows?.[0]?.id || '');
  const link = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + c.conta.replace('act_', '') + '&selected_campaign_ids=' + campId;

  if (n.ativar) {
    const at = await ativar(adId);
    if (!at.ok) return { ok: true, adId, campanhaMetaId: campId, adMetaId, link, erro: 'criado mas não ativou: ' + at.erro };
  }
  try { const { registrarUso } = await import('./mkt-assets'); await registrarUso({ assetId: n.assetId, canal: 'meta_ads', ref: 'ad:' + adId, gancho: null, ignorarDescanso: true } as any); } catch {}
  return { ok: true, adId, campanhaMetaId: campId, adMetaId, link };
}

async function mudarStatus(adId: string, st: 'ACTIVE' | 'PAUSED'): Promise<{ ok: boolean; erro?: string }> {
  const r: any = await db.execute(sql`SELECT * FROM mkt_ads WHERE id = ${adId} LIMIT 1`); const a = r.rows?.[0];
  if (!a) return { ok: false, erro: 'anúncio não encontrado' };
  for (const id of [a.campanha_meta_id, a.adset_meta_id, a.ad_meta_id]) {
    const x = await graph('POST', String(id), { status: st });
    if (!x.ok) return { ok: false, erro: x.erro };
  }
  await db.execute(sql`UPDATE mkt_ads SET status = ${st === 'ACTIVE' ? 'ativo' : 'pausado'}, atualizado_em = now() WHERE id = ${adId}`);
  return { ok: true };
}
export async function ativar(adId: string) { return mudarStatus(adId, 'ACTIVE'); }
export async function pausar(adId: string) { return mudarStatus(adId, 'PAUSED'); }

/** Gasto e resultado por dia (insights) de cada anuncio nosso ainda vivo. Cron. */
export async function coletarInsights(): Promise<{ anuncios: number; linhas: number; erros: number }> {
  const p = pronto(); if (!p.ok) return { anuncios: 0, linhas: 0, erros: 0 };
  await ensureMktAdsSchema();
  const r: any = await db.execute(sql.raw(`SELECT id, campanha_meta_id, fim, status FROM mkt_ads WHERE campanha_meta_id IS NOT NULL AND (status = 'ativo' OR fim >= now() - interval '3 days')`));
  let linhas = 0, erros = 0;
  for (const a of (r.rows || [])) {
    const ins = await graph('GET', String(a.campanha_meta_id) + '/insights', { fields: 'spend,impressions,clicks,reach,actions', time_increment: '1', date_preset: 'last_7d' });
    if (!ins.ok) { erros++; continue; }
    for (const d of (ins.corpo?.data || [])) {
      const conv = (d.actions || []).filter((x: any) => /messaging_conversation_started|onsite_conversion\.messaging/i.test(String(x.action_type))).reduce((t: number, x: any) => t + Number(x.value || 0), 0);
      try {
        await db.execute(sql`INSERT INTO mkt_ads_diario (ad_id, data, gasto, impressoes, cliques, conversas, alcance)
          VALUES (${a.id}, ${d.date_start}, ${Number(d.spend || 0)}, ${Number(d.impressions || 0)}, ${Number(d.clicks || 0)}, ${conv}, ${Number(d.reach || 0)})
          ON CONFLICT (ad_id, data) DO UPDATE SET gasto = EXCLUDED.gasto, impressoes = EXCLUDED.impressoes, cliques = EXCLUDED.cliques, conversas = EXCLUDED.conversas, alcance = EXCLUDED.alcance`);
        linhas++;
      } catch { erros++; }
    }
    if (a.status === 'ativo' && a.fim && new Date(a.fim).getTime() < Date.now()) await db.execute(sql`UPDATE mkt_ads SET status = 'encerrado', atualizado_em = now() WHERE id = ${a.id}`);
  }
  return { anuncios: (r.rows || []).length, linhas, erros };
}

/** Resultado ao vivo de um anuncio (para o painel): gasto, conversas, pedidos pelo fio CTWA. */
export async function resultadoDoAnuncio(acaoId: string): Promise<any | null> {
  try {
    const a: any = (await db.execute(sql`SELECT * FROM mkt_ads WHERE acao_id = ${acaoId} ORDER BY criado_em DESC LIMIT 1`) as any).rows?.[0];
    if (!a) return null;
    const t: any = (await db.execute(sql`SELECT COALESCE(SUM(gasto),0)::float AS gasto, COALESCE(SUM(impressoes),0)::int AS impressoes, COALESCE(SUM(cliques),0)::int AS cliques, COALESCE(SUM(conversas),0)::int AS conversas, COALESCE(SUM(alcance),0)::int AS alcance FROM mkt_ads_diario WHERE ad_id = ${a.id}`) as any).rows?.[0] || {};
    // pedidos que nasceram de conversa CTWA desde o inicio do anuncio (fio do mkt-ctwa)
    let pedidos = 0, receita = 0;
    try {
      const q: any = await db.execute(sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(sc.sale_value),0)::float AS r FROM sales_cards sc WHERE sc.attribution_kind = 'ctwa' AND sc.created_at >= ${a.inicio}`);
      pedidos = Number(q.rows?.[0]?.n || 0); receita = Number(q.rows?.[0]?.r || 0);
    } catch {}
    return { adId: a.id, status: a.status, orcamentoDia: Number(a.orcamento_dia), dias: a.dias, inicio: a.inicio, fim: a.fim, link: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + config().conta.replace('act_', '') + '&selected_campaign_ids=' + a.campanha_meta_id,
      gasto: Number(t.gasto || 0), impressoes: Number(t.impressoes || 0), cliques: Number(t.cliques || 0), conversas: Number(t.conversas || 0), alcance: Number(t.alcance || 0), pedidosCtwa: pedidos, receitaCtwa: receita };
  } catch { return null; }
}

export async function listar(): Promise<any[]> {
  await ensureMktAdsSchema();
  const r: any = await db.execute(sql.raw(`SELECT a.*, (SELECT COALESCE(SUM(gasto),0)::float FROM mkt_ads_diario d WHERE d.ad_id = a.id) AS gasto, (SELECT COALESCE(SUM(conversas),0)::int FROM mkt_ads_diario d WHERE d.ad_id = a.id) AS conversas FROM mkt_ads a ORDER BY criado_em DESC LIMIT 30`));
  return r.rows || [];
}
