// ============================================================================
// CENTRAL DE MARKETING — Buraco 2: O FIO DE ATRIBUICAO
// ----------------------------------------------------------------------------
// O problema: hoje um pedido do hotsite e orfao. `sales_cards.source` so sabe
// dizer 'hotsite' — nunca QUAL post, QUAL campanha, QUAL anuncio trouxe o cliente.
// Sem isso e impossivel responder "quanto o Instagram vendeu" e todo real de
// midia e gasto no escuro.
//
// A ideia unica: NENHUM CTA SAI DO INTEGRA SEM CARREGAR UM CODIGO QUE VOLTA.
//
//   link /r/<slug>  ->  302 com UTM + cid  ->  hotsite guarda  ->  vai no pedido
//        (mkt_links)      (mkt_cliques)         (sessionStorage)    (sales_cards.campaign_id)
//                                                                         |
//                                                                   mkt_toques
//                                                                   (receita por campanha)
//
// Este modulo cobre o caminho (1) LINK. Os outros tres caminhos do plano
// (ctwa_clid, palavra-chave e cupom) gravam na MESMA tabela mkt_toques e entram
// nos buracos 3 e seguintes — por isso `tipo` ja nasce generico.
//
// LGPD: o IP do clique NUNCA e gravado em claro. So o hash SHA-256 com sal, que
// serve para deduplicar clique repetido sem identificar pessoa.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Schema (idempotente, padrao da casa)
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktAtribuicaoSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };

  await run('create_campanhas',
    "CREATE TABLE IF NOT EXISTS mkt_campanhas (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "codigo varchar NOT NULL UNIQUE, " +           // IG0825 — e o que aparece no cupom e no relatorio
    "nome varchar NOT NULL, " +
    "objetivo varchar, " +                          // aquisicao_b2b | reativacao | mix | b2c
    "canal varchar, " +                             // instagram | facebook | whatsapp | google | offline
    "publico varchar, " +                           // b2b_revenda | b2c_consumidor
    "verba numeric(12,2), " +
    "inicio timestamptz, fim timestamptz, " +
    "cupom varchar, " +
    "ativo boolean NOT NULL DEFAULT true, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");

  await run('create_links',
    "CREATE TABLE IF NOT EXISTS mkt_links (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "slug varchar NOT NULL UNIQUE, " +
    "destino text NOT NULL DEFAULT '/shop', " +
    "campanha_id varchar, " +
    "utm_source varchar, utm_medium varchar, utm_campaign varchar, " +
    "utm_content varchar, utm_term varchar, " +
    "post_ref varchar, " +                          // referencia livre ao post/criativo
    "cliques int NOT NULL DEFAULT 0, " +
    "ativo boolean NOT NULL DEFAULT true, " +
    "criado_por varchar, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");

  await run('create_cliques',
    "CREATE TABLE IF NOT EXISTS mkt_cliques (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "link_id varchar, slug varchar, campanha_id varchar, " +
    "ua text, ip_hash varchar, referer text, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");

  await run('create_toques',
    "CREATE TABLE IF NOT EXISTS mkt_toques (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "campanha_id varchar, campanha_codigo varchar, link_id varchar, clique_id varchar, " +
    "canal varchar, " +                             // hotsite | instagram | whatsapp | google
    "tipo varchar NOT NULL DEFAULT 'link', " +      // link | ctwa | keyword | cupom
    "utm jsonb, ctwa_clid varchar, ad_id varchar, " +
    "conversa_id varchar, lead_id varchar, cliente_id varchar, sales_card_id varchar, " +
    "valor numeric(12,2), " +
    "primeiro_toque_em timestamptz NOT NULL DEFAULT now(), " +
    "convertido_em timestamptz)");

  await run('idx_cliques_slug', "CREATE INDEX IF NOT EXISTS idx_mkt_cliques_slug ON mkt_cliques (slug, criado_em DESC)");
  await run('idx_cliques_data', "CREATE INDEX IF NOT EXISTS idx_mkt_cliques_data ON mkt_cliques (criado_em DESC)");
  await run('idx_toques_camp', "CREATE INDEX IF NOT EXISTS idx_mkt_toques_camp ON mkt_toques (campanha_id, primeiro_toque_em DESC)");
  await run('idx_toques_card', "CREATE INDEX IF NOT EXISTS idx_mkt_toques_card ON mkt_toques (sales_card_id)");

  // ⚠️ Estas 3 colunas TAMBEM entram no shared/schema.ts (drizzle). Por isso o ALTER
  // precisa rodar no boot: entre o deploy do codigo novo e o ALTER, qualquer SELECT
  // gerado pelo drizzle em sales_cards quebraria. Mesma licao do is_priority.
  await run('col_campaign_id', "ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS campaign_id varchar");
  await run('col_utm', "ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS utm jsonb");
  await run('col_attr_kind', "ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS attribution_kind varchar");
  await run('idx_cards_camp', "CREATE INDEX IF NOT EXISTS idx_sales_cards_campaign ON sales_cards (campaign_id)");

  _schemaOk = steps.every(s => s.ok);
  _schemaTentativa = Date.now();
  return { ok: _schemaOk, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa > 60_000) await ensureMktAtribuicaoSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// LGPD: hash do IP com sal. Nunca guardar IP em claro.
// ---------------------------------------------------------------------------
const SAL = process.env.MKT_IP_SALT || 'integra-honest-mkt';
export function hashIp(ip?: string | null): string | null {
  const v = String(ip || '').trim();
  if (!v) return null;
  return crypto.createHash('sha256').update(SAL + '|' + v).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Slug: normaliza para o que pode ir em uma legenda de post sem quebrar
// ---------------------------------------------------------------------------
export function normalizarSlug(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Monta a URL de destino com os UTM. Aceita destino relativo ('/shop') e
// absoluto ('https://...'). Nao sobrescreve parametro que ja exista no destino.
// ---------------------------------------------------------------------------
export function montarDestino(link: any, base: string): string {
  const destinoBruto = String(link.destino || '/shop').trim();
  // Trava de destino. O link e criado por gente no painel, entao o campo destino e
  // uma entrada de texto — sem esta trava, um destino errado (ou mal-intencionado)
  // viraria redirecionamento aberto a partir de um dominio nosso. Regra:
  //   - so http/https quando for absoluto;
  //   - so caminho comecando com '/' quando for relativo;
  //   - qualquer outra coisa ('javascript:', 'data:', 'ftp:', texto solto) cai em /shop.
  const absoluto = /^https?:\/\//i.test(destinoBruto);
  const relativoValido = destinoBruto.startsWith('/') && !destinoBruto.startsWith('//');
  let u: URL;
  try {
    if (absoluto) u = new URL(destinoBruto);
    else if (relativoValido) u = new URL(destinoBruto, base);
    else throw new Error('destino nao permitido: ' + destinoBruto.slice(0, 40));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo nao permitido: ' + u.protocol);
  } catch (e: any) {
    console.warn('[MKT-ATRIB] destino invalido no link', link?.slug, '->', e?.message || e);
    u = new URL('/shop', base);
  }

  const por = (k: string, v: any) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, String(v)); };
  por('utm_source', link.utm_source || 'instagram');
  por('utm_medium', link.utm_medium || 'organic');
  por('utm_campaign', link.utm_campaign || link.campanha_codigo || link.slug);
  por('utm_content', link.utm_content);
  por('utm_term', link.utm_term);
  // cid = codigo da campanha. E o que vai virar sales_cards.campaign_id.
  por('cid', link.campanha_codigo || link.campanha_id);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Resolve o slug (com o codigo da campanha junto, para o cid)
// ---------------------------------------------------------------------------
export async function resolverSlug(slug: string): Promise<any | null> {
  try {
    const r: any = await db.execute(sql`
      SELECT l.*, c.codigo AS campanha_codigo
        FROM mkt_links l
        LEFT JOIN mkt_campanhas c ON c.id = l.campanha_id
       WHERE l.slug = ${slug} AND l.ativo = true
       LIMIT 1`);
    return r.rows?.[0] || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Registra o clique. NUNCA lanca e NUNCA atrasa o redirecionamento: quem chama
// dispara sem await. Um clique perdido e melhor que um cliente esperando.
// ---------------------------------------------------------------------------
export async function registrarClique(opts: { link: any; ua?: string; ip?: string; referer?: string }): Promise<void> {
  try {
    if (!(await garantirSchema())) return;
    const l = opts.link || {};
    await db.execute(sql`
      INSERT INTO mkt_cliques (link_id, slug, campanha_id, ua, ip_hash, referer)
      VALUES (${l.id || null}, ${l.slug || null}, ${l.campanha_id || null},
              ${String(opts.ua || '').slice(0, 400) || null}, ${hashIp(opts.ip)},
              ${String(opts.referer || '').slice(0, 400) || null})`);
    if (l.id) await db.execute(sql`UPDATE mkt_links SET cliques = cliques + 1 WHERE id = ${l.id}`);
  } catch (e: any) {
    console.error('[MKT-ATRIB] falha ao registrar clique:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Normaliza o bloco de origem que chega do hotsite no pedido.
// Aceita tanto { utm: {...}, cid } quanto os campos soltos no corpo.
// ---------------------------------------------------------------------------
const CHAVES_UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'landing', 'referrer'];

export function lerOrigem(body: any): { utm: Record<string, string> | null; cid: string | null } {
  const b = body || {};
  const bruto = (b.utm && typeof b.utm === 'object') ? b.utm : b;
  const utm: Record<string, string> = {};
  for (const k of CHAVES_UTM) {
    const v = bruto[k] ?? b[k];
    if (v != null && String(v).trim() !== '') utm[k] = String(v).slice(0, 200);
  }
  const cid = String(b.cid ?? bruto.cid ?? '').trim().toUpperCase().slice(0, 60) || null;
  return { utm: Object.keys(utm).length ? utm : null, cid };
}

// ---------------------------------------------------------------------------
// Resolve o cid (codigo da campanha) para o id interno, se a campanha existir.
// Se o codigo nao existir cadastrado, o pedido ainda guarda o cid — a campanha
// pode ser criada depois e o relatorio casa pelo codigo.
// ---------------------------------------------------------------------------
export async function resolverCampanhaPorCodigo(codigo?: string | null): Promise<{ id: string | null; codigo: string | null }> {
  const c = String(codigo || '').trim().toUpperCase();
  if (!c) return { id: null, codigo: null };
  try {
    const r: any = await db.execute(sql`SELECT id, codigo FROM mkt_campanhas WHERE upper(codigo) = ${c} LIMIT 1`);
    const row = r.rows?.[0];
    return { id: row?.id || null, codigo: row?.codigo || c };
  } catch { return { id: null, codigo: c }; }
}

// ---------------------------------------------------------------------------
// Grava o toque de atribuicao ligado ao pedido. Idempotente por sales_card_id:
// o mesmo pedido nunca conta duas vezes (o fluxo PIX/cartao reprocessa payload).
// NUNCA lanca — atribuicao jamais pode derrubar a criacao de um pedido.
// ---------------------------------------------------------------------------
export async function registrarToqueDoPedido(opts: {
  salesCardId: string; clienteId?: string | null; valor?: number | string | null;
  canal?: string; tipo?: string; utm?: Record<string, string> | null; cid?: string | null;
}): Promise<{ campaignId: string | null; campanhaCodigo: string | null; gravou: boolean }> {
  const vazio = { campaignId: null, campanhaCodigo: null, gravou: false };
  try {
    if (!(await garantirSchema())) return vazio;
    const { id: campanhaId, codigo } = await resolverCampanhaPorCodigo(opts.cid);
    // Sem cid E sem utm nao ha o que atribuir — pedido organico direto.
    if (!codigo && !(opts.utm && Object.keys(opts.utm).length)) return vazio;

    const ja: any = await db.execute(sql`SELECT id FROM mkt_toques WHERE sales_card_id = ${opts.salesCardId} LIMIT 1`);
    if ((ja.rows || []).length) return { campaignId: campanhaId, campanhaCodigo: codigo, gravou: false };

    // Liga ao link de origem quando a campanha do utm_campaign casar com um slug
    let linkId: string | null = null;
    try {
      const slug = String(opts.utm?.utm_campaign || '').trim();
      if (slug) {
        const l: any = await db.execute(sql`SELECT id FROM mkt_links WHERE slug = ${slug} LIMIT 1`);
        linkId = l.rows?.[0]?.id || null;
      }
    } catch {}

    const valor = opts.valor == null ? null : Number(opts.valor);
    await db.execute(sql`
      INSERT INTO mkt_toques
        (campanha_id, campanha_codigo, link_id, canal, tipo, utm, cliente_id, sales_card_id, valor, convertido_em)
      VALUES
        (${campanhaId}, ${codigo}, ${linkId}, ${opts.canal || 'hotsite'}, ${opts.tipo || 'link'},
         ${opts.utm ? JSON.stringify(opts.utm) : null}::jsonb, ${opts.clienteId || null},
         ${opts.salesCardId}, ${Number.isFinite(valor as number) ? valor : null}, now())`);
    return { campaignId: campanhaId, campanhaCodigo: codigo, gravou: true };
  } catch (e: any) {
    console.error('[MKT-ATRIB] falha ao registrar toque do pedido:', e?.message || e);
    return vazio;
  }
}

// ---------------------------------------------------------------------------
// O relatorio que o buraco 2 existe para entregar: RECEITA POR CAMPANHA.
// Junta clique (topo) com pedido faturado (fim) na mesma linha.
// ---------------------------------------------------------------------------
export async function relatorioPorCampanha(dias = 30): Promise<any> {
  const d = Math.min(365, Math.max(1, Number(dias) || 30));
  const janela = sql.raw(`now() - interval '${d} days'`);

  const campanhas: any = await db.execute(sql`
    SELECT c.id, c.codigo, c.nome, c.canal, c.objetivo, c.verba, c.ativo,
           COALESCE(cl.cliques, 0)::int          AS cliques,
           COALESCE(t.pedidos, 0)::int           AS pedidos,
           ROUND(COALESCE(t.receita, 0), 2)      AS receita,
           COALESCE(t.clientes, 0)::int          AS clientes
      FROM mkt_campanhas c
      LEFT JOIN (SELECT campanha_id, COUNT(*) AS cliques FROM mkt_cliques
                  WHERE criado_em >= ${janela} GROUP BY campanha_id) cl ON cl.campanha_id = c.id
      LEFT JOIN (SELECT campanha_id, COUNT(*) AS pedidos, SUM(valor) AS receita,
                        COUNT(DISTINCT cliente_id) AS clientes
                   FROM mkt_toques
                  WHERE sales_card_id IS NOT NULL AND primeiro_toque_em >= ${janela}
                  GROUP BY campanha_id) t ON t.campanha_id = c.id
     ORDER BY receita DESC NULLS LAST, c.criado_em DESC`);

  // Toques com codigo de campanha que ainda NAO tem cadastro — o relatorio nao
  // pode esconder receita so porque ninguem cadastrou a campanha ainda.
  const semCadastro: any = await db.execute(sql`
    SELECT campanha_codigo AS codigo, COUNT(*)::int AS pedidos,
           ROUND(COALESCE(SUM(valor), 0), 2) AS receita
      FROM mkt_toques
     WHERE campanha_id IS NULL AND campanha_codigo IS NOT NULL
       AND sales_card_id IS NOT NULL AND primeiro_toque_em >= ${janela}
     GROUP BY campanha_codigo ORDER BY receita DESC`);

  const links: any = await db.execute(sql`
    SELECT l.slug, l.destino, l.cliques, l.ativo, c.codigo AS campanha,
           COALESCE(j.cliques_janela, 0)::int AS cliques_janela
      FROM mkt_links l
      LEFT JOIN mkt_campanhas c ON c.id = l.campanha_id
      LEFT JOIN (SELECT link_id, COUNT(*) AS cliques_janela FROM mkt_cliques
                  WHERE criado_em >= ${janela} GROUP BY link_id) j ON j.link_id = l.id
     ORDER BY cliques_janela DESC, l.criado_em DESC LIMIT 200`);

  // Termometro do fio: quanto do que veio do hotsite esta atribuido.
  // COALESCE obrigatorio: sem nenhum pedido no periodo o SUM devolve NULL e a tela
  // mostraria "null" em vez de 0 no primeiro acesso.
  const cobertura: any = await db.execute(sql`
    SELECT COUNT(*)::int AS pedidos_hotsite,
           COALESCE(SUM(CASE WHEN campaign_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS com_campanha,
           COALESCE(SUM(CASE WHEN utm IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS com_utm
      FROM sales_cards
     WHERE source IN ('hotsite','website') AND created_at >= ${janela}`);

  return {
    dias: d,
    campanhas: campanhas.rows || [],
    semCadastro: semCadastro.rows || [],
    links: links.rows || [],
    cobertura: cobertura.rows?.[0] || { pedidos_hotsite: 0, com_campanha: 0, com_utm: 0 },
  };
}
