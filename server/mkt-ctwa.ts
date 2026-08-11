// ============================================================================
// CENTRAL DE MARKETING — Buraco 3: CTWA (ctwa_clid) + Conversions API
// ----------------------------------------------------------------------------
// O buraco 2 fechou o fio de quem chega pelo LINK. Este fecha o de quem chega
// pelo ANUNCIO — e devolve o resultado para a Meta.
//
//   anuncio Click-to-WhatsApp/Instagram
//        │  (a Meta manda ctwa_clid junto da 1a mensagem)
//        ▼
//   webhook  →  mkt_toques (tipo='ctwa')  →  agente qualifica/registra pedido
//        │                                          │
//        │                                          ▼
//        └───────────────────────────────►  CAPI: Lead / Purchase + valor
//                                            (a Meta passa a otimizar por
//                                             QUEM COMPRA, nao por quem clica)
//
// Por que isto importa em dinheiro: sem CAPI, a Meta so sabe quem clicou. Com
// CAPI, ela aprende quem virou cliente da Honest. E o item de maior ROI do plano.
//
// SEGURANCA: nasce DESLIGADO. Sem META_PIXEL_ID + META_CAPI_TOKEN, e com a chave
// mkt_capi_mode em 'off', nada e enviado para a Meta. Em 'test' o evento e
// montado e GRAVADO, mas NAO sai — da para conferir o payload antes de ligar.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktCtwaSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };

  // A conversa passa a carregar de onde veio.
  await run('conv_ctwa_clid', "ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS ctwa_clid varchar");
  await run('conv_campaign', "ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS campaign_id varchar");
  await run('conv_ad_id', "ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS ad_id varchar");
  await run('conv_origem', "ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS origem_anuncio jsonb");
  await run('idx_conv_ctwa', "CREATE INDEX IF NOT EXISTS idx_chat_conv_ctwa ON chat_conversations (ctwa_clid)");

  // Fila/auditoria dos eventos devolvidos para a Meta.
  await run('create_capi',
    "CREATE TABLE IF NOT EXISTS mkt_capi_eventos (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "event_name varchar NOT NULL, " +            // Lead | Purchase
    "event_id varchar NOT NULL UNIQUE, " +       // dedup na Meta E aqui
    "ctwa_clid varchar, " +
    "canal varchar, " +                          // whatsapp | instagram
    "conversa_id varchar, sales_card_id varchar, " +
    "valor numeric(12,2), moeda varchar DEFAULT 'BRL', " +
    "payload jsonb, " +
    "modo varchar, " +                           // off | test | on (no momento do envio)
    "status varchar NOT NULL DEFAULT 'pendente', " + // pendente | enviado | erro | simulado
    "resposta_codigo int, resposta text, tentativas int NOT NULL DEFAULT 0, " +
    "criado_em timestamptz NOT NULL DEFAULT now(), enviado_em timestamptz)");
  await run('idx_capi_status', "CREATE INDEX IF NOT EXISTS idx_mkt_capi_status ON mkt_capi_eventos (status, criado_em DESC)");

  // Toques ganham a coluna de conversa indexada (o buraco 2 ja criou a tabela).
  await run('idx_toques_conv', "CREATE INDEX IF NOT EXISTS idx_mkt_toques_conv ON mkt_toques (conversa_id)");

  _schemaOk = steps.every(s => s.ok);
  _schemaTentativa = Date.now();
  return { ok: _schemaOk, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa > 60_000) await ensureMktCtwaSchema();
  return _schemaOk;
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

// ---------------------------------------------------------------------------
// LEITURA DO REFERRAL — deliberadamente TOLERANTE A FORMATO
// ---------------------------------------------------------------------------
// O mesmo dado chega em lugares diferentes conforme a origem:
//   • WhatsApp Cloud API : entry[].changes[].value.messages[].referral
//   • Instagram messaging: entry[].messaging[].{referral | postback.referral}
//                          ou message.referral
//   • Umbler Talk        : repassa o objeto da Meta aninhado de um jeito proprio
//
// Em vez de codificar os tres caminhos (e quebrar no quarto), varremos o payload
// procurando um objeto que TENHA ctwa_clid (ou cara de referral de anuncio).
// Custo irrisorio perto de perder a atribuicao de um anuncio pago.
// ---------------------------------------------------------------------------
export type Referral = {
  ctwaClid: string | null;
  adId: string | null;
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
};

const PROFUNDIDADE_MAX = 8;
const NOS_MAX = 4000;

export function lerReferral(payload: any): Referral | null {
  let achado: any = null;
  let visitados = 0;

  const visita = (no: any, prof: number) => {
    if (achado || no == null || prof > PROFUNDIDADE_MAX || ++visitados > NOS_MAX) return;
    if (Array.isArray(no)) { for (const x of no) visita(x, prof + 1); return; }
    if (typeof no !== 'object') return;

    const clid = no.ctwa_clid ?? no.ctwaClid;
    // Referral de anuncio SEM ctwa_clid ainda vale (identifica o criativo),
    // mas so aceitamos se tiver cara de anuncio — nao qualquer objeto com source_id.
    const pareceAnuncio = (no.source_type === 'ad' || no.source_type === 'post' || no.sourceType === 'ad')
      && (no.source_id || no.sourceId);
    if (clid || pareceAnuncio) { achado = no; return; }

    for (const k of Object.keys(no)) visita(no[k], prof + 1);
  };

  try { visita(payload, 0); } catch { return null; }
  if (!achado) return null;

  const s = (v: any) => { const x = v == null ? '' : String(v).trim(); return x ? x.slice(0, 400) : null; };
  return {
    ctwaClid: s(achado.ctwa_clid ?? achado.ctwaClid),
    adId: s(achado.ad_id ?? achado.adId ?? achado.source_id ?? achado.sourceId),
    sourceId: s(achado.source_id ?? achado.sourceId),
    sourceType: s(achado.source_type ?? achado.sourceType),
    sourceUrl: s(achado.source_url ?? achado.sourceUrl),
    headline: s(achado.headline),
    body: s(achado.body),
  };
}

/** Só vale a pena gravar se veio pelo menos um identificador. */
export function referralUtil(r: Referral | null): boolean {
  return !!(r && (r.ctwaClid || r.adId || r.sourceId));
}

// ---------------------------------------------------------------------------
// TOQUE DA CONVERSA — a conversa vinda de anúncio deixa de ser órfã
// ---------------------------------------------------------------------------
export async function registrarToqueDeConversa(opts: {
  conversaId?: string | null; canal: string; referral: Referral;
  clienteId?: string | null; telefone?: string | null;
}): Promise<{ gravou: boolean; toqueId?: string }> {
  try {
    if (!(await garantirSchema())) return { gravou: false };
    if (!referralUtil(opts.referral)) return { gravou: false };
    const r = opts.referral;

    // Carimba a conversa (permite ver a origem no ChatCenter e no relatório)
    if (opts.conversaId) {
      try {
        await db.execute(sql`
          UPDATE chat_conversations
             SET ctwa_clid = COALESCE(ctwa_clid, ${r.ctwaClid}),
                 ad_id = COALESCE(ad_id, ${r.adId}),
                 origem_anuncio = COALESCE(origem_anuncio, ${JSON.stringify(r)}::jsonb)
           WHERE id = ${opts.conversaId}`);
      } catch (e: any) { console.error('[CTWA] carimbo na conversa:', e?.message || e); }
    }

    // Idempotente por conversa: a 2ª mensagem do mesmo anúncio não vira outro toque
    if (opts.conversaId) {
      const ja: any = await db.execute(sql`SELECT id FROM mkt_toques WHERE conversa_id = ${opts.conversaId} AND tipo = 'ctwa' LIMIT 1`);
      if ((ja.rows || []).length) return { gravou: false, toqueId: ja.rows[0].id };
    }

    const ins: any = await db.execute(sql`
      INSERT INTO mkt_toques (canal, tipo, ctwa_clid, ad_id, conversa_id, cliente_id, utm)
      VALUES (${opts.canal}, 'ctwa', ${r.ctwaClid}, ${r.adId}, ${opts.conversaId || null},
              ${opts.clienteId || null}, ${JSON.stringify({
                source_type: r.sourceType, source_url: r.sourceUrl,
                headline: r.headline, body: r.body,
              })}::jsonb)
      RETURNING id`);
    const toqueId = ins.rows?.[0]?.id;
    console.log('🎯 [CTWA] conversa veio de anuncio:', { canal: opts.canal, ctwaClid: (r.ctwaClid || '').slice(0, 12) + '...', adId: r.adId });

    // Lead: a conversa existir JÁ é o evento de lead do CTWA.
    void enfileirarEvento({
      eventName: 'Lead', ctwaClid: r.ctwaClid, canal: opts.canal,
      conversaId: opts.conversaId || null, telefone: opts.telefone || null,
    });

    return { gravou: true, toqueId };
  } catch (e: any) {
    console.error('[CTWA] registrarToqueDeConversa:', e?.message || e);
    return { gravou: false };
  }
}

// ---------------------------------------------------------------------------
// PEDIDO FECHADO NA CONVERSA — liga o toque ao sales_card e dispara Purchase
// ---------------------------------------------------------------------------
export async function vincularPedidoAConversa(opts: {
  conversaId?: string | null; salesCardId: string; valor?: number | string | null;
  clienteId?: string | null; telefone?: string | null; canal?: string;
}): Promise<{ vinculou: boolean }> {
  try {
    if (!opts.conversaId) return { vinculou: false };
    if (!(await garantirSchema())) return { vinculou: false };

    const t: any = await db.execute(sql`SELECT id, ctwa_clid, canal FROM mkt_toques WHERE conversa_id = ${opts.conversaId} AND tipo = 'ctwa' ORDER BY primeiro_toque_em DESC LIMIT 1`);
    const toque = t.rows?.[0];
    if (!toque) return { vinculou: false }; // conversa orgânica: nada a atribuir

    const valor = opts.valor == null ? null : Number(opts.valor);
    await db.execute(sql`
      UPDATE mkt_toques
         SET sales_card_id = COALESCE(sales_card_id, ${opts.salesCardId}),
             cliente_id = COALESCE(cliente_id, ${opts.clienteId || null}),
             valor = COALESCE(valor, ${Number.isFinite(valor as number) ? valor : null}),
             convertido_em = COALESCE(convertido_em, now())
       WHERE id = ${toque.id}`);

    // Carimba o pedido também, para o relatório de campanha enxergar
    try {
      await db.execute(sql`UPDATE sales_cards SET attribution_kind = COALESCE(attribution_kind, 'ctwa') WHERE id = ${opts.salesCardId}`);
    } catch {}

    void enfileirarEvento({
      eventName: 'Purchase', ctwaClid: toque.ctwa_clid, canal: opts.canal || toque.canal || 'whatsapp',
      conversaId: opts.conversaId, salesCardId: opts.salesCardId,
      valor: Number.isFinite(valor as number) ? (valor as number) : null,
      telefone: opts.telefone || null,
    });
    console.log('🎯 [CTWA] pedido vinculado ao anuncio:', { salesCardId: opts.salesCardId, valor });
    return { vinculou: true };
  } catch (e: any) {
    console.error('[CTWA] vincularPedidoAConversa:', e?.message || e);
    return { vinculou: false };
  }
}

// ---------------------------------------------------------------------------
// CONVERSIONS API
// ---------------------------------------------------------------------------
function sha256(v: string): string {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

/** Telefone precisa ir em SHA-256 e só com dígitos (exigência da Meta). */
function telefoneHash(tel?: string | null): string | null {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return sha256(d.startsWith('55') ? d : '55' + d);
}

export function montarPayloadCapi(e: {
  eventName: string; eventId: string; ctwaClid?: string | null; canal?: string | null;
  valor?: number | null; telefone?: string | null; quando?: number;
}): any {
  const user_data: any = {};
  if (e.ctwaClid) user_data.ctwa_clid = e.ctwaClid;
  const ph = telefoneHash(e.telefone);
  if (ph) user_data.ph = [ph];

  const evento: any = {
    event_name: e.eventName,
    event_time: Math.floor((e.quando ?? 0) / 1000) || Math.floor(Date.now() / 1000),
    action_source: 'business_messaging',
    messaging_channel: (e.canal === 'instagram' ? 'instagram' : 'whatsapp'),
    event_id: e.eventId,
    user_data,
  };
  if (e.valor != null && Number.isFinite(e.valor)) {
    evento.custom_data = { value: Number(e.valor), currency: 'BRL' };
  }
  return { data: [evento] };
}

/**
 * Enfileira o evento. SEMPRE grava a linha (auditoria), e só envia se o modo
 * estiver 'on' E as credenciais existirem. Nunca lança.
 */
export async function enfileirarEvento(e: {
  eventName: 'Lead' | 'Purchase'; ctwaClid?: string | null; canal?: string | null;
  conversaId?: string | null; salesCardId?: string | null; valor?: number | null;
  telefone?: string | null;
}): Promise<{ status: string; eventId?: string }> {
  try {
    if (!(await garantirSchema())) return { status: 'sem-schema' };
    if (!e.ctwaClid) return { status: 'sem-ctwa_clid' }; // orgânico: não reportar à Meta

    // event_id determinístico = dedup na Meta e aqui. Purchase é por pedido;
    // Lead é por conversa. Reprocessar o mesmo fato nunca gera evento duplicado.
    const chave = e.eventName === 'Purchase'
      ? 'purchase:' + (e.salesCardId || e.conversaId || e.ctwaClid)
      : 'lead:' + (e.conversaId || e.ctwaClid);
    const eventId = sha256(chave).slice(0, 40);

    const modo = await getSetting('mkt_capi_mode', 'off');
    const payload = montarPayloadCapi({
      eventName: e.eventName, eventId, ctwaClid: e.ctwaClid, canal: e.canal,
      valor: e.valor ?? null, telefone: e.telefone ?? null,
    });

    const statusInicial = modo === 'on' ? 'pendente' : (modo === 'test' ? 'simulado' : 'pendente');
    const ins: any = await db.execute(sql`
      INSERT INTO mkt_capi_eventos (event_name, event_id, ctwa_clid, canal, conversa_id, sales_card_id, valor, payload, modo, status)
      VALUES (${e.eventName}, ${eventId}, ${e.ctwaClid}, ${e.canal || null}, ${e.conversaId || null},
              ${e.salesCardId || null}, ${e.valor ?? null}, ${JSON.stringify(payload)}::jsonb, ${modo}, ${statusInicial})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id`);
    if (!(ins.rows || []).length) return { status: 'ja-existia', eventId }; // dedup

    if (modo === 'on') void enviarPendentes();
    return { status: statusInicial, eventId };
  } catch (e2: any) {
    console.error('[CAPI] enfileirar:', e2?.message || e2);
    return { status: 'erro' };
  }
}

/** Envia os pendentes. Idempotente e seguro para rodar em cron. */
export async function enviarPendentes(limite = 25): Promise<{ enviados: number; erros: number; pulados: number }> {
  const out = { enviados: 0, erros: 0, pulados: 0 };
  try {
    if (!(await garantirSchema())) return out;
    const modo = await getSetting('mkt_capi_mode', 'off');
    const pixel = process.env.META_PIXEL_ID || '';
    const token = process.env.META_CAPI_TOKEN || '';
    if (modo !== 'on' || !pixel || !token) { out.pulados = 1; return out; }

    const r: any = await db.execute(sql`
      SELECT id, event_id, payload, tentativas FROM mkt_capi_eventos
       WHERE status IN ('pendente','erro') AND tentativas < 5
       ORDER BY criado_em LIMIT ${Math.min(100, Math.max(1, limite))}`);

    for (const ev of (r.rows || [])) {
      try {
        const resp = await fetch(`${GRAPH}/${encodeURIComponent(pixel)}/events?access_token=${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ev.payload),
        });
        const txt = (await resp.text().catch(() => '')).slice(0, 500);
        if (resp.ok) {
          await db.execute(sql`UPDATE mkt_capi_eventos SET status='enviado', resposta_codigo=${resp.status}, resposta=${txt}, tentativas=tentativas+1, enviado_em=now() WHERE id=${ev.id}`);
          out.enviados++;
        } else {
          await db.execute(sql`UPDATE mkt_capi_eventos SET status='erro', resposta_codigo=${resp.status}, resposta=${txt}, tentativas=tentativas+1 WHERE id=${ev.id}`);
          out.erros++;
          console.error('[CAPI] envio falhou', resp.status, txt.slice(0, 200));
        }
      } catch (e: any) {
        await db.execute(sql`UPDATE mkt_capi_eventos SET status='erro', resposta=${String(e?.message || e).slice(0, 300)}, tentativas=tentativas+1 WHERE id=${ev.id}`).catch(() => {});
        out.erros++;
      }
    }
  } catch (e: any) { console.error('[CAPI] enviarPendentes:', e?.message || e); }
  return out;
}

// ---------------------------------------------------------------------------
// Relatório do canal pago
// ---------------------------------------------------------------------------
export async function relatorioCtwa(dias = 30): Promise<any> {
  const d = Math.min(365, Math.max(1, Number(dias) || 30));
  const janela = sql.raw(`now() - interval '${d} days'`);

  const funil: any = await db.execute(sql`
    SELECT COUNT(*)::int                                              AS conversas,
           COUNT(DISTINCT ctwa_clid)                                  AS anuncios_distintos,
           COALESCE(SUM(CASE WHEN sales_card_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS pedidos,
           ROUND(COALESCE(SUM(valor), 0), 2)                          AS receita
      FROM mkt_toques
     WHERE tipo = 'ctwa' AND primeiro_toque_em >= ${janela}`);

  const porAnuncio: any = await db.execute(sql`
    SELECT COALESCE(ad_id, 'sem-id')                                  AS anuncio,
           COUNT(*)::int                                              AS conversas,
           COALESCE(SUM(CASE WHEN sales_card_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS pedidos,
           ROUND(COALESCE(SUM(valor), 0), 2)                          AS receita
      FROM mkt_toques
     WHERE tipo = 'ctwa' AND primeiro_toque_em >= ${janela}
     GROUP BY 1 ORDER BY receita DESC NULLS LAST LIMIT 50`);

  const capi: any = await db.execute(sql`
    SELECT status, event_name, COUNT(*)::int AS total
      FROM mkt_capi_eventos WHERE criado_em >= ${janela}
     GROUP BY status, event_name ORDER BY status, event_name`);

  const ultimos: any = await db.execute(sql`
    SELECT event_name, status, modo, valor, resposta_codigo, criado_em, enviado_em
      FROM mkt_capi_eventos ORDER BY criado_em DESC LIMIT 20`);

  return {
    dias: d,
    modo: await getSetting('mkt_capi_mode', 'off'),
    credenciais: { pixel: !!process.env.META_PIXEL_ID, token: !!process.env.META_CAPI_TOKEN },
    funil: funil.rows?.[0] || { conversas: 0, anuncios_distintos: 0, pedidos: 0, receita: 0 },
    porAnuncio: porAnuncio.rows || [],
    capi: capi.rows || [],
    ultimos: ultimos.rows || [],
  };
}
