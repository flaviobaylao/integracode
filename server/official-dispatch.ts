// ============================================================================
// INTEGRA 2.0 — Canal oficial 1841 (WhatsApp Business API via Umbler)
// Módulo autossuficiente: envio + fila + rota do dia + endpoints.
// Fala com o banco por SQL cru (mesmo padrão do agent-runtime.ts).
// Wiring: em server/index.ts →  import { registerOfficialDispatch } from "./official-dispatch";
//                               registerOfficialDispatch(app);
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const UMBLER_TALK_BASE = 'https://app-utalk.umbler.com/api';
const OFICIAL_CHANNEL_ID = process.env.UMBLER_OFFICIAL_CHANNEL_ID || 'ajqNf-Vjp4yjcaJf';
function orgId(): string { return process.env.UMBLER_TALK_ORG_ID || 'aZiQMy9bnyeDpiaY'; }
function testPhones(): string[] { return (process.env.INTEGRA_OFICIAL_TEST_PHONES || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean); }
function dailyCap(): number { return parseInt(process.env.INTEGRA_OFICIAL_DAILY_CAP || '200', 10); }
function ratePerMin(): number { return parseInt(process.env.INTEGRA_OFICIAL_RATE_PER_MIN || '10', 10); }

async function getSetting(key: string, def: string): Promise<string> {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value; return v == null ? def : String(v).replace(/^"|"$/g, ''); } catch { return def; }
}
async function mode(): Promise<'off'|'test'|'on'> { return (await getSetting('oficial_dispatch_mode', 'off')) as any; }
async function useCaseEnabled(uc: string): Promise<boolean> { return (await getSetting('oficial_' + uc, 'off')) === 'on'; }

function umblerFetch(path: string, init?: any) {
  const token = process.env.UMBLER_TALK_TOKEN;
  const headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, (init && init.headers) || {});
  return fetch(UMBLER_TALK_BASE + path, Object.assign({}, init, { headers, signal: AbortSignal.timeout(30000) }));
}
function normalizeBrPhone(toPhone: string): string {
  let d = String(toPhone || '').replace(/\D/g, '');
  if (d && !d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d;
}
function withinBusinessHours(now = new Date()): boolean {
  const br = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dow = br.getDay(); const mins = br.getHours() * 60 + br.getMinutes();
  if (dow === 0) return false;
  if (dow === 6) return mins >= 8*60+30 && mins < 12*60;
  return mins >= 8*60+30 && mins < 18*60+30;
}

async function officialCheckWhatsapp(toPhone: string): Promise<boolean | null> {
  const d = normalizeBrPhone(toPhone); if (!d) return null;
  try {
    const resp = await umblerFetch('/v1/contacts/check-whatsapp/?organizationId=' + encodeURIComponent(orgId()) + '&phone=' + encodeURIComponent('+' + d));
    if (!resp.ok) return null;
    const j: any = await resp.json().catch(() => null); if (j == null) return null;
    if (typeof j === 'boolean') return j;
    for (const k of ['exists','isValid','valid','hasWhatsapp']) if (typeof j[k] === 'boolean') return j[k];
    return null;
  } catch { return null; }
}
async function resolveContactId(toPhone: string, name?: string): Promise<string | null> {
  const d = normalizeBrPhone(toPhone); if (!d) return null;
  try {
    const f = await umblerFetch('/v1/contacts/phone/?organizationId=' + encodeURIComponent(orgId()) + '&phone=' + encodeURIComponent('+' + d));
    if (f.ok) { const c: any = await f.json().catch(() => null); const id = c && (c.id || c.contact?.id); if (id) return id; }
    const cr = await umblerFetch('/v1/contacts/', { method: 'POST', body: JSON.stringify({ organizationId: orgId(), phoneNumber: '+' + d, name: name || ('Cliente ' + d.slice(-4)) }) });
    if (cr.ok) { const c: any = await cr.json().catch(() => null); return (c && (c.id || c.contact?.id)) || null; }
    return null;
  } catch { return null; }
}
async function resolveChatId(contactId: string): Promise<string | null> {
  try {
    const r = await umblerFetch('/v1/chats/', { method: 'POST', body: JSON.stringify({ organizationId: orgId(), channelId: OFICIAL_CHANNEL_ID, contactId }) });
    if (!r.ok) return null; const c: any = await r.json().catch(() => null); return (c && (c.id || c.chat?.id)) || null;
  } catch { return null; }
}
export async function sendOfficialTemplate(toPhone: string, umblerTemplateId: string, params: string[],
  opts?: { name?: string; postbackTexts?: { index: number; text: string }[] }
): Promise<{ success: boolean; chatId?: string; messageId?: string; error?: string }> {
  if (!process.env.UMBLER_TALK_TOKEN) return { success: false, error: 'UMBLER_TALK_TOKEN ausente' };
  const contactId = await resolveContactId(toPhone, opts?.name); if (!contactId) return { success: false, error: 'contato nao resolvido' };
  const chatId = await resolveChatId(contactId); if (!chatId) return { success: false, error: 'chat nao resolvido' };
  try {
    const payload: any = { organizationId: orgId(), chatId, templateId: umblerTemplateId, params: params || [] };
    if (opts?.postbackTexts?.length) payload.postbackTexts = opts.postbackTexts;
    const resp = await umblerFetch('/v1/template-messages/', { method: 'POST', body: JSON.stringify(payload) });
    const raw = await resp.text();
    console.log(`[UMBLER-OFICIAL] to=${normalizeBrPhone(toPhone)} chat=${chatId} tpl=${umblerTemplateId} http=${resp.status} resp=${raw.slice(0,180)}`);
    if (!resp.ok) return { success: false, chatId, error: `HTTP ${resp.status}: ${raw.slice(0,180)}` };
    let id: string | undefined; try { id = JSON.parse(raw).id; } catch {}
    return { success: true, chatId, messageId: id };
  } catch (e: any) { return { success: false, chatId, error: e?.message || String(e) }; }
}

export async function enqueueOfficialDispatch(item: {
  customerId?: string; customerPhone: string; templateLabel: string; params: string[];
  useCase: string; campaign?: string; postbackTexts?: {index:number;text:string}[]; category?: string;
}): Promise<string> {
  if (await mode() === 'off') return 'desligado';
  if (!(await useCaseEnabled(item.useCase))) return 'desligado';
  const phone = normalizeBrPhone(item.customerPhone); if (!phone) return 'invalido';
  if ((item.category || 'UTILITY') === 'MARKETING') {
    const o: any = await db.execute(sql`SELECT 1 FROM chat_customers WHERE phone = ${'+'+phone} AND whatsapp_opt_out = true LIMIT 1`);
    if (o.rows?.length) return 'optout';
  }
  const dup: any = await db.execute(sql`SELECT 1 FROM official_dispatches
    WHERE customer_phone = ${phone} AND use_case = ${item.useCase}
      AND created_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date LIMIT 1`);
  if (dup.rows?.length) return 'duplicado';
  const m = await mode();
  await db.execute(sql`INSERT INTO official_dispatches
    (customer_id, customer_phone, template_label, category, use_case, params, campaign, estimated_cost, status, mode)
    VALUES (${item.customerId || null}, ${phone}, ${item.templateLabel}, ${item.category || 'UTILITY'},
      ${item.useCase}::dispatch_use_case, ${JSON.stringify(item.params)}::jsonb, ${item.campaign || null},
      ${item.category === 'MARKETING' ? 0.34 : 0.04}, 'fila'::dispatch_status, ${m})`);
  return 'enfileirado';
}

let _sentMin = 0, _minMark = 0;
export async function processDispatchQueueTick() {
  const m = await mode(); if (m === 'off') return;
  if (m === 'on' && !withinBusinessHours()) return;
  const nm = Math.floor(Date.now()/60000); if (nm !== _minMark) { _minMark = nm; _sentMin = 0; }
  if (_sentMin >= ratePerMin()) return;
  const st: any = await db.execute(sql`SELECT count(*)::int n FROM official_dispatches
    WHERE status IN ('enviada','entregue','lida','resposta') AND sent_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
  if ((st.rows?.[0]?.n || 0) >= dailyCap()) return;
  const q: any = await db.execute(sql`SELECT * FROM official_dispatches WHERE status='fila' ORDER BY created_at LIMIT 1`);
  const d = q.rows?.[0]; if (!d) return;
  const t: any = await db.execute(sql`SELECT umbler_id FROM whatsapp_templates WHERE label = ${d.template_label} LIMIT 1`);
  const umblerId = t.rows?.[0]?.umbler_id;
  if (!umblerId) { await mark(d.id, 'falha', 'template nao encontrado'); return; }
  const target = m === 'test' ? (testPhones()[0] || d.customer_phone) : d.customer_phone;
  const exists = await officialCheckWhatsapp(target);
  if (exists === false) { await mark(d.id, 'falha', 'numero sem whatsapp'); return; }
  const r = await sendOfficialTemplate(target, umblerId, (d.params as string[]) || []);
  _sentMin++;
  if (r.success) {
    await db.execute(sql`UPDATE official_dispatches SET status='enviada'::dispatch_status, chat_id=${r.chatId||null},
      umbler_message_id=${r.messageId||null}, sent_at=now(), updated_at=now() WHERE id=${d.id}`);
  } else { await mark(d.id, 'falha', r.error || 'erro envio'); }
}
async function mark(id: string, status: string, error?: string) {
  await db.execute(sql`UPDATE official_dispatches SET status=${status}::dispatch_status, error=${error||null}, updated_at=now() WHERE id=${id}`);
}

export async function dispatchRotaDoDia(): Promise<{ enfileirados: number; pulados: number; rotas: number }> {
  const rr: any = await db.execute(sql`SELECT seller_id, visit_stops FROM daily_routes
    WHERE (route_date AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
  const routes = rr.rows || []; let enfileirados = 0, pulados = 0;
  for (const route of routes) {
    const s: any = await db.execute(sql`SELECT first_name, last_name FROM users WHERE id = ${route.seller_id} LIMIT 1`);
    const seller = s.rows?.[0]; const sellerName = seller ? [seller.first_name, seller.last_name].filter(Boolean).join(' ') : 'seu vendedor';
    const stops = route.visit_stops || {};
    for (const stopId of Object.keys(stops)) {
      const stp = stops[stopId]; if (!stp || stp.entityType !== 'customer') continue;
      const c: any = await db.execute(sql`SELECT id, name, fantasy_name, phone, is_active, virtual_service FROM customers WHERE id = ${stp.entityId} LIMIT 1`);
      const cust = c.rows?.[0];
      if (!cust || !cust.is_active || cust.virtual_service || !cust.phone) { pulados++; continue; }
      const nome = cust.fantasy_name || cust.name;
      const res = await enqueueOfficialDispatch({
        customerId: cust.id, customerPhone: cust.phone, templateLabel: 'visita_rota_dia',
        params: [nome, sellerName, 'Hoje'], useCase: 'rota_do_dia',
        campaign: 'rota_' + new Date().toISOString().slice(0,10), category: 'UTILITY',
      });
      if (res === 'enfileirado') enfileirados++; else pulados++;
    }
  }
  console.log(`[ROTA-DO-DIA] enfileirados=${enfileirados} pulados=${pulados} rotas=${routes.length}`);
  return { enfileirados, pulados, rotas: routes.length };
}

export function registerOfficialDispatch(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/oficial/test-envio', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const r = await sendOfficialTemplate('5562995782812', 'alrAa2wGrlHC-83p', ['Flavio (teste)', 'Celso', 'Hoje'],
      { postbackTexts: [ {index:0,text:'Sim, confirmar'}, {index:1,text:'Não'} ] });
    res.json(r);
  });
  app.get('/api/admin/rota-do-dia/disparar', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json(await dispatchRotaDoDia());
  });
  app.get('/api/admin/rota-do-dia/fila', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const rows: any = await db.execute(sql`SELECT status, count(*)::int n FROM official_dispatches
      WHERE created_at::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date GROUP BY status`);
    res.json(rows.rows || []);
  });

  setInterval(() => { processDispatchQueueTick().catch(() => {}); }, 6000);

  let _firedOn = '';
  setInterval(async () => {
    const br = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const key = br.toISOString().slice(0,10);
    if (br.getDay() === 0) return;
    if (br.getHours() === 8 && br.getMinutes() >= 30 && _firedOn !== key) {
      _firedOn = key; await dispatchRotaDoDia().catch(e => console.error('[ROTA-DO-DIA] erro', e));
    }
  }, 60000);

  console.log('[OFICIAL-DISPATCH] registrado (endpoints + worker + agendamento 8h30)');
}
