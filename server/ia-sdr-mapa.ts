// ============================================================================
// INTEGRA 2.0 — SDR sobre o mapa (Plano Dobrar Vendas, Proposta 4a) — 11/10/2026
//
// Toda semana (segunda, 9h BRT) o SDR gera até N estabelecimentos dos segmentos que mais
// compram, num raio de 1 km dos clientes visitados nos últimos 30 dias (as rotas atuais),
// descarta quem já é cliente ou lead, cria o LEAD na carteira do vendedor da região e manda a
// primeira mensagem pelo canal oficial 1841 com o template MARKETING `sdr_amostra`
// ("amostra grátis na próxima passagem"). Quem responde cai no agente `whatsapp` (triagem,
// catálogo, pedido); o lead vira `hot` e ganha visita na agenda.
//
// Fonte dos pontos: Google Places API (New) searchNearby — mesma chave do Radar
// (GOOGLE_MAPS_API_KEY). Telefone vem em nationalPhoneNumber. Cache em places_cache
// (gridkey 'sdr:<lat>,<lng>:<semana>').
//
// Gates: sdr_mapa_on (on), sdr_mapa_max_semana (200), sdr_mapa_dia (1=segunda), sdr_mapa_raio (1000),
//        sdr_mapa_segmentos (CSV de tipos Places; default supermarket,bakery,convenience_store,cafe,restaurant,gym),
//        oficial_sdr (on) / oficial_mode_sdr
// Rotas: GET /api/admin/sdr-mapa?dry=1[&limit=N] | ?run=1
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const TZ = 'America/Sao_Paulo';
const TEMPLATE = 'sdr_amostra';
const dig = (s: any) => String(s || '').replace(/\D/g, '');
function hojeBR(): string { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function horaBR(): number { return parseInt(new Date().toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }), 10) || 0; }
function diaSemanaBR(): number { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).getDay(); }
function semanaISO(): string { const d = new Date(new Date().toLocaleString('en-US', { timeZone: TZ })); const j = new Date(d.getFullYear(), 0, 1); return d.getFullYear() + '-' + String(Math.ceil(((d.getTime() - j.getTime()) / 86400000 + j.getDay() + 1) / 7)).padStart(2, '0'); }
function norm(t: string): string { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function title(t: string): string { return String(t || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m) => m.toUpperCase()).replace(/\b(Ltda|Me|Epp|Eireli|S\/a)\b\.?/gi, '').replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/g, '').trim(); }
function celular(phone: any): string | null {
  let d = dig(phone).replace(/^55/, '');
  if (d.length === 10 && /^[1-9][0-9][6-9]/.test(d)) d = d.slice(0, 2) + '9' + d.slice(2);
  if (/(\d)\1{6,}/.test(d)) return null;
  return /^[1-9][0-9]9[0-9]{8}$/.test(d) ? '55' + d : null;
}
function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toR = (x: number) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'sdr-mapa')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

let _tabela = false;
async function ensureTabela() {
  if (_tabela) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ia_sdr_contatos (
    id serial PRIMARY KEY,
    place_id varchar(120),
    nome varchar(160),
    categoria varchar(80),
    telefone varchar(20),
    endereco text,
    latitude double precision, longitude double precision,
    seller_id varchar(64),
    lead_id varchar(64),
    semana varchar(10),
    status varchar(30) DEFAULT 'lead',   -- lead | enfileirado | sem_template | respondeu | pulado
    dispatch_result varchar(60),
    criado_em timestamptz DEFAULT now(),
    respondeu_em timestamptz)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ia_sdr_place ON ia_sdr_contatos (place_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ia_sdr_tel ON ia_sdr_contatos (telefone)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS places_cache (gridkey text PRIMARY KEY, payload jsonb, created_at timestamptz DEFAULT now())`);
  try { await db.execute(sql`ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS 'sdr'`); } catch {}
  _tabela = true;
}

// Centros: clientes visitados/atendidos nos últimos 30 d, agrupados em células de ~1 km, com o vendedor dominante.
async function centros(max: number): Promise<Array<{ lat: number; lng: number; sellerId: string | null; n: number }>> {
  const r: any = await db.execute(sql`
    SELECT round(c.latitude::numeric, 2) AS glat, round(c.longitude::numeric, 2) AS glng,
           avg(c.latitude::float) AS lat, avg(c.longitude::float) AS lng,
           mode() WITHIN GROUP (ORDER BY c.seller_id) AS seller_id, count(*)::int AS n
    FROM customers c
    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
      AND c.latitude::float BETWEEN -20 AND -12 AND c.longitude::float BETWEEN -53 AND -45
      AND (EXISTS (SELECT 1 FROM visit_agenda v WHERE v.customer_id = c.id AND v.scheduled_date > now() - interval '30 days')
           OR EXISTS (SELECT 1 FROM route_checkpoints k WHERE k.customer_id = c.id AND k.checkpoint_time > now() - interval '30 days'))
    GROUP BY 1, 2
    ORDER BY n DESC
    LIMIT ${max}`);
  return ((r.rows || []) as any[]).map(x => ({ lat: Number(x.lat), lng: Number(x.lng), sellerId: x.seller_id || null, n: Number(x.n) }));
}

async function placesNearby(lat: number, lng: number, raio: number, tipos: string[]): Promise<any[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY ausente');
  const gridkey = `sdr:${lat.toFixed(3)},${lng.toFixed(3)}:${raio}:${semanaISO()}`;
  try {
    const c: any = await db.execute(sql`SELECT payload FROM places_cache WHERE gridkey = ${gridkey} LIMIT 1`);
    if (c.rows?.[0]?.payload) return Array.isArray(c.rows[0].payload) ? c.rows[0].payload : [];
  } catch {}
  const body: any = { maxResultCount: 20, rankPreference: 'DISTANCE', languageCode: 'pt-BR', regionCode: 'BR',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: raio } }, includedTypes: tipos };
  const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.primaryType,places.location,places.formattedAddress,places.nationalPhoneNumber,places.businessStatus' },
  });
  const j: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Places ' + resp.status + ': ' + JSON.stringify(j).slice(0, 160));
  const places = Array.isArray(j.places) ? j.places : [];
  try { await db.execute(sql`INSERT INTO places_cache (gridkey, payload) VALUES (${gridkey}, ${JSON.stringify(places)}::jsonb) ON CONFLICT (gridkey) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`); } catch {}
  return places;
}

type Candidato = { placeId: string; nome: string; categoria: string; tel: string; endereco: string; lat: number; lng: number; sellerId: string | null };

async function jaConhecido(c: Candidato): Promise<string | null> {
  // telefone em customers / leads / contatos do SDR
  const t8 = c.tel.slice(-8);
  const q: any = await db.execute(sql`
    SELECT 'cliente' AS o FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${t8} LIMIT 1`);
  if (q.rows?.length) return 'cliente (telefone)';
  const l: any = await db.execute(sql`SELECT 'lead' AS o FROM leads WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${t8} LIMIT 1`);
  if (l.rows?.length) return 'lead (telefone)';
  const s: any = await db.execute(sql`SELECT 1 FROM ia_sdr_contatos WHERE place_id = ${c.placeId} OR right(telefone, 8) = ${t8} LIMIT 1`);
  if (s.rows?.length) return 'ja contatado';
  // nome parecido a < 150 m (cliente ou lead)
  const n = norm(c.nome).split(' ').filter(w => w.length > 3).slice(0, 2);
  if (n.length) {
    const near: any = await db.execute(sql`
      SELECT COALESCE(NULLIF(fantasy_name,''), name) AS nm, latitude::float AS lat, longitude::float AS lng FROM customers
      WHERE latitude IS NOT NULL AND abs(latitude::float - ${c.lat}) < 0.003 AND abs(longitude::float - ${c.lng}) < 0.003
      UNION ALL
      SELECT fantasy_name, latitude::float, longitude::float FROM leads
      WHERE latitude IS NOT NULL AND abs(latitude::float - ${c.lat}) < 0.003 AND abs(longitude::float - ${c.lng}) < 0.003`);
    for (const r of (near.rows || []) as any[]) {
      const nm = norm(r.nm);
      if (n.every(w => nm.includes(w)) && distM(c, { lat: Number(r.lat), lng: Number(r.lng) }) < 150) return 'nome parecido perto: ' + r.nm;
    }
  }
  return null;
}

export async function sdrMapaTick(opts: { force?: boolean; dry?: boolean; limit?: number } = {}): Promise<any> {
  await ensureTabela();
  if ((await getSetting('sdr_mapa_on', 'on')) !== 'on' && !opts.force) return { ran: false, reason: 'off' };
  const max = Math.max(1, Math.min(500, opts.limit || parseInt(await getSetting('sdr_mapa_max_semana', '200'), 10) || 200));
  const raio = Math.max(200, Math.min(3000, parseInt(await getSetting('sdr_mapa_raio', '1000'), 10) || 1000));
  const tipos = (await getSetting('sdr_mapa_segmentos', 'supermarket,bakery,convenience_store,cafe,restaurant,gym')).split(/[,;\s]+/).filter(Boolean);
  const t: any = await db.execute(sql`SELECT umbler_id FROM whatsapp_templates WHERE label = ${TEMPLATE} LIMIT 1`);
  const temTemplate = !!t.rows?.[0]?.umbler_id;

  const cs = await centros(60);
  const cand: Candidato[] = []; const vistos = new Set<string>(); let erroPlaces = '';
  for (const c of cs) {
    if (cand.length >= max * 2) break;
    let places: any[] = [];
    try { places = await placesNearby(c.lat, c.lng, raio, tipos); } catch (e: any) { erroPlaces = e?.message || String(e); break; }
    for (const p of places) {
      const id = String(p.id || ''); if (!id || vistos.has(id)) continue; vistos.add(id);
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const tel = celular(p.nationalPhoneNumber); if (!tel) continue; // só celular (WhatsApp)
      cand.push({ placeId: id, nome: String(p.displayName?.text || p.displayName || '').slice(0, 150), categoria: String(p.primaryType || (p.types || [])[0] || ''), tel, endereco: String(p.formattedAddress || ''), lat: Number(p.location?.latitude), lng: Number(p.location?.longitude), sellerId: c.sellerId });
    }
  }

  const detalhes: any[] = []; let criados = 0, enfileirados = 0, pulados = 0;
  const { storage } = await import('./storage');
  const { enqueueOfficialDispatch } = await import('./official-dispatch');
  for (const c of cand) {
    if (criados >= max) break;
    const motivo = await jaConhecido(c);
    if (motivo) { pulados++; continue; }
    const det: any = { nome: c.nome, categoria: c.categoria, tel: c.tel, endereco: c.endereco, vendedor: c.sellerId };
    if (opts.dry) { detalhes.push(det); criados++; continue; }
    let leadId: string | null = null;
    try {
      const lead: any = await storage.createLead({
        fantasyName: title(c.nome) || c.nome, latitude: c.lat, longitude: c.lng, coordinatesLocked: true, phone: c.tel,
        observation: `Fonte: SDR mapa (IA) · ${c.categoria} · Google Place ID ${c.placeId} · ${c.endereco}`,
        status: 'pending', temperature: 'cold', createdBy: 'ia', createdByName: 'SDR IA', assignedTo: c.sellerId, routeType: 'prospeccao',
      } as any);
      leadId = lead?.id || null;
    } catch (e: any) { det.erro = 'lead: ' + (e?.message || e); detalhes.push(det); continue; }
    let status = 'lead', dr = '';
    if (temTemplate) {
      try {
        dr = await enqueueOfficialDispatch({ customerPhone: c.tel, templateLabel: TEMPLATE, params: [title(c.nome) || 'seu estabelecimento'], useCase: 'sdr', campaign: 'sdr:' + c.placeId, category: 'MARKETING' });
        status = dr === 'enfileirado' || dr === 'ok' || /enfileir|fila/i.test(dr) ? 'enfileirado' : 'lead';
        if (status === 'enfileirado') enfileirados++;
      } catch (e: any) { dr = 'erro: ' + (e?.message || e); }
    } else status = 'sem_template';
    await db.execute(sql`INSERT INTO ia_sdr_contatos (place_id, nome, categoria, telefone, endereco, latitude, longitude, seller_id, lead_id, semana, status, dispatch_result)
      VALUES (${c.placeId}, ${c.nome}, ${c.categoria}, ${c.tel}, ${c.endereco}, ${c.lat}, ${c.lng}, ${c.sellerId}, ${leadId}, ${semanaISO()}, ${status}, ${String(dr).slice(0, 60)}) ON CONFLICT (place_id) DO NOTHING`);
    criados++; det.lead = leadId; det.status = status; det.dispatch = dr; detalhes.push(det);
  }
  if (!opts.dry) await setSetting('sdr_mapa_last_run', hojeBR());
  console.log(`[SDR-MAPA] centros=${cs.length} candidatos=${cand.length} leads=${criados} enfileirados=${enfileirados} pulados=${pulados}${erroPlaces ? ' erroPlaces=' + erroPlaces : ''}`);
  return { ran: true, dry: !!opts.dry, temTemplate, centros: cs.length, candidatos: cand.length, leads: criados, enfileirados, pulados, erroPlaces: erroPlaces || null, tipos, raio, detalhes: detalhes.slice(0, 200) };
}

// Contexto para o agente quando o número é um lead do SDR (ou indicado) e não um cliente.
export async function contextoDoLead(phone: string): Promise<string> {
  try {
    const t8 = dig(phone).slice(-8); if (t8.length < 8) return '';
    const r: any = await db.execute(sql`SELECT fantasy_name, city, observation, temperature, status FROM leads
      WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${t8} ORDER BY created_at DESC LIMIT 1`);
    const l = r.rows?.[0]; if (!l) return '';
    const obs = String(l.observation || '');
    const origem = /SDR mapa/i.test(obs) ? 'prospectado pelo SDR (primeiro contato foi a oferta de amostra grátis)' : (/Indicado por/i.test(obs) ? 'indicado por um cliente (tem cupom de R$ 30 no primeiro pedido — veja a observação)' : 'lead em prospecção');
    return `# ESTE CONTATO É UM LEAD (ainda não é cliente)\nEstabelecimento: ${l.fantasy_name}${l.city ? ' · ' + l.city : ''}\nOrigem: ${origem}.\nObservação: ${obs.slice(0, 200)}\nObjetivo: apresentar a Honest em 2 linhas, oferecer amostra grátis na próxima passagem do vendedor e, se ele quiser, fazer a triagem (consumidor/revenda) e registrar o primeiro pedido. Não invente preço: use consultar_produto.`;
  } catch { return ''; }
}

// Lead respondeu ao SDR -> vira warm/hot e marca na tabela (chamado por ia-takeover).
export async function leadRespondeu(phone: string): Promise<void> {
  try {
    await ensureTabela();
    const t8 = dig(phone).slice(-8); if (t8.length < 8) return;
    const r: any = await db.execute(sql`UPDATE ia_sdr_contatos SET status = 'respondeu', respondeu_em = COALESCE(respondeu_em, now())
      WHERE right(telefone, 8) = ${t8} AND status IN ('enfileirado','lead') RETURNING lead_id`);
    for (const x of (r.rows || []) as any[]) if (x.lead_id) { try { await db.execute(sql`UPDATE leads SET temperature = 'warm', updated_at = now() WHERE id = ${x.lead_id} AND temperature = 'cold'`); } catch {} }
  } catch {}
}

export function registerSdrMapa(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  app.get('/api/admin/sdr-mapa', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const run = String(req.query.run || '') === '1';
    const limit = parseInt(String(req.query.limit || ''), 10) || undefined;
    try { res.json(await sdrMapaTick({ force: true, dry: !run, limit })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  try {
    setInterval(async () => {
      try {
        if ((await getSetting('sdr_mapa_on', 'on')) !== 'on') return;
        const dia = parseInt(await getSetting('sdr_mapa_dia', '1'), 10);
        if (diaSemanaBR() !== dia) return;
        const { ehDiaUtil } = await import('./ia-fila'); if (!(await ehDiaUtil())) return;
        if (horaBR() < 9 || horaBR() > 12) return;
        if ((await getSetting('sdr_mapa_last_run', '')) === hojeBR()) return;
        await sdrMapaTick();
      } catch (e: any) { console.error('[SDR-MAPA] tick', e?.message || e); }
    }, 60 * 1000);
  } catch {}
  console.log('[SDR-MAPA] registrado (semanal, segunda 9h BRT; template sdr_amostra pelo 1841)');
}
