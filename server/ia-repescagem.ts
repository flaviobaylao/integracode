// ============================================================================
// INTEGRA 2.0 — IA · Repescagem (Plano Dobrar Vendas, Proposta 1 — 11/10/2026)
//
// Todo cliente sorteado na repescagem que NAO foi atendido por humano ate as 11h recebe,
// no mesmo dia, um contato da IA pelo WhatsApp (Umbler 2630, texto livre): o ultimo
// pedido pronto para repetir, ou, se tem titulo vencido, o acerto do pagamento primeiro.
// Quando o cliente responde, o agente `whatsapp` segue a conversa (ia_front_line) com
// as ferramentas de pedido/financeiro. Em jul-set 92% das alocacoes voltaram sem contato.
//
// O contato e registrado em virtual_service_logs (attendant 'ia') — assim o fechamento
// da repescagem marca a alocacao como atendida e o sorteio nao repete o cliente em 7 d.
//
// Gates (system_settings):
//   ia_repescagem_on        'on'|'off'  (default on)
//   ia_repescagem_hora      hora BRT do disparo (default 11)
//   ia_repescagem_max_dia   teto de contatos por dia (default 150)
//   ia_repescagem_canal     numero Umbler de saida (default 5562992682630)
//   ia_repescagem_last_run  carimbo do ultimo dia executado (trava)
//   agents_runtime_mode     off -> nao faz nada; test -> so agents_test_numbers
//
// Rotas (admin): GET /api/admin/ia-repescagem?dry=1          -> previa (nao envia)
//                GET /api/admin/ia-repescagem?run=1[&limit=N] -> executa agora
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { whereDebitoVivoSql } from './divida-viva';

const TZ = 'America/Sao_Paulo';
function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function ddmm(d: any) { return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }) : ''; }
function hojeBR(): string { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function horaBR(): number { return parseInt(new Date().toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }), 10) || 0; }
function diaSemanaBR(): number { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).getDay(); }

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'ia-repescagem')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

let _tabela = false;
async function ensureTabela() {
  if (_tabela) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ia_repescagem_contatos (
    id serial PRIMARY KEY,
    assignment_id varchar(64),
    customer_id varchar(64) NOT NULL,
    telefone varchar(20),
    conversation_id varchar(64),
    draw_date varchar(10),
    tipo varchar(20),            -- 'pedido' | 'debito' | 'generico'
    texto text,
    enviado_ok boolean,
    erro text,
    criado_em timestamptz DEFAULT now())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ia_rep_cust_dia ON ia_repescagem_contatos (customer_id, draw_date)`);
  _tabela = true;
}

type Alvo = { assignmentId: string; customerId: string; nome: string; telefone: string; sellerId: string | null };

// Alocacoes do dia ainda sem atendimento humano, com telefone valido e sem contato da IA hoje.
async function selecionarAlvos(drawDate: string, limit: number): Promise<Alvo[]> {
  await ensureTabela();
  const r: any = await db.execute(sql`
    SELECT a.id AS assignment_id, a.customer_id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome,
           regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') AS tel, c.seller_id
    FROM repescagem_assignments a
    JOIN customers c ON c.id = a.customer_id
    WHERE a.draw_date = ${drawDate}
      AND a.status = 'in_route' AND a.completed_at IS NULL
      AND COALESCE(c.is_active, true) = true
      AND COALESCE(c.situacao, '') NOT ILIKE 'inativo'
      -- so celular, com ou sem 55 e com ou sem o 9o digito (210 cadastros ativos ainda tem
      -- celular de 8 digitos): fixo (DDD + 2-5...) nao tem WhatsApp
      AND regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') ~ '^(55)?[1-9][0-9](9[0-9]{8}|[6-9][0-9]{7})$'
      AND NOT EXISTS (SELECT 1 FROM ia_repescagem_contatos x WHERE x.customer_id = a.customer_id AND x.draw_date = ${drawDate})
      -- ja atendido hoje por humano (mesmas fontes do fechamento da repescagem)
      AND NOT EXISTS (SELECT 1 FROM virtual_service_logs v WHERE v.customer_id = a.customer_id
                        AND (v.attendance_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${drawDate}::date)
      AND NOT EXISTS (SELECT 1 FROM route_checkpoints k WHERE k.customer_id = a.customer_id AND k.checkpoint_type = 'check_in'
                        AND (k.checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${drawDate}::date)
      AND NOT EXISTS (SELECT 1 FROM billing_pipeline b WHERE b.customer_id = a.customer_id
                        AND COALESCE(b.scheduled_billing_date::date, (b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) = ${drawDate}::date)
    ORDER BY a.assigned_at NULLS LAST, a.id
    LIMIT ${limit}`);
  return ((r.rows || []) as any[]).map(x => {
    let tel = String(x.tel || '').replace(/^55/, '');
    if (tel.length === 10 && /^[1-9][0-9][6-9]/.test(tel)) tel = tel.slice(0, 2) + '9' + tel.slice(2); // celular antigo sem o 9
    tel = '55' + tel;
    return { assignmentId: String(x.assignment_id), customerId: String(x.customer_id), nome: String(x.nome || '').trim(), telefone: tel, sellerId: x.seller_id || null };
  });
}

// Conversa do WhatsApp deste telefone (cria se nao existir), apontada para o canal de saida.
async function conversaDoTelefone(tel: string, nome: string, canal: string): Promise<{ id: string; nova: boolean } | null> {
  try {
    const r: any = await db.execute(sql`SELECT id, channel_phone FROM chat_conversations
      WHERE customer_phone NOT LIKE 'ig:%' AND right(regexp_replace(COALESCE(customer_phone,''),'[^0-9]','','g'), 8) = ${tel.slice(-8)}
      ORDER BY last_message_time DESC NULLS LAST LIMIT 1`);
    const row = r.rows?.[0];
    if (row?.id) {
      if (!row.channel_phone) { try { await db.execute(sql`UPDATE chat_conversations SET channel_phone = ${canal} WHERE id = ${row.id}`); } catch {} }
      return { id: String(row.id), nova: false };
    }
    const cc: any = await db.execute(sql`INSERT INTO chat_customers (name, phone) VALUES (${nome || tel}, ${tel}) RETURNING id`);
    const ins: any = await db.execute(sql`INSERT INTO chat_conversations (customer_id, customer_name, customer_phone, status, channel, channel_phone, initiated_by)
      VALUES (${cc.rows?.[0]?.id || null}, ${nome || tel}, ${tel}, 'new', 'whatsapp', ${canal}, 'customer') RETURNING id`);
    return ins.rows?.[0]?.id ? { id: String(ins.rows[0].id), nova: true } : null;
  } catch (e: any) { console.error('[IA-REP] conversa', e?.message || e); return null; }
}

// Humano atuando / IA pausada nessa conversa -> a IA nao se mete.
async function conversaLivre(convId: string): Promise<boolean> {
  try {
    const { iaPausadaConsistente } = await import('./mkt-fase0');
    if (await iaPausadaConsistente(convId)) return false;
    const r: any = await db.execute(sql`SELECT
        (coalesce(c.initiated_by::text,'customer') = 'user') AS do_atendente,
        EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_type <> 'customer'
                  AND coalesce(m.sender_id,'') NOT LIKE 'agent:%' AND coalesce(m.sender_id,'') <> 'system'
                  AND m.created_at > now() - interval '2 days') AS humano_recente,
        EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.created_at > now() - interval '12 hours') AS msg_recente
      FROM chat_conversations c WHERE c.id = ${convId}`);
    const x = r.rows?.[0];
    if (!x) return true;
    return !(x.do_atendente || x.humano_recente || x.msg_recente);
  } catch { return true; }
}

// Texto de abertura: ultimo pedido pronto para repetir, ou acerto de debito antes.
async function montarAbertura(customerId: string, nome: string): Promise<{ tipo: string; texto: string }> {
  // Nome fantasia em Title Case ("COLEGIO CIMAN" -> "Colegio Ciman"); contato, se houver, vem antes.
  let contato = '';
  try { const c: any = await db.execute(sql`SELECT contact FROM customers WHERE id = ${customerId} LIMIT 1`); contato = String(c.rows?.[0]?.contact || '').trim().split(/[\s/,-]+/)[0] || ''; } catch {}
  const title = (t: string) => t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m) => m.toUpperCase()).replace(/\b\d{8,14}\b/g, '').replace(/\b(Ltda|Me|Epp|Eireli|S\/a)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  const quem = contato ? title(contato) : title(nome);
  const saud = horaBR() < 12 ? 'Bom dia' : (horaBR() < 18 ? 'Boa tarde' : 'Boa noite');
  const abre = `${saud}${quem ? ', ' + quem : ''}! Aqui é a Honest Sucos 🧡`;

  // Debito vencido: combina pagamento antes de vender (regra do plano).
  try {
    const d: any = await db.execute(sql`SELECT count(*)::int AS n, sum(r.amount - coalesce(r.amount_paid,0))::float AS total
      FROM receivables r WHERE r.customer_id = ${customerId} AND ${whereDebitoVivoSql('r')}`);
    const deb = d.rows?.[0];
    if (deb && Number(deb.n) > 0 && Number(deb.total) > 0) {
      return { tipo: 'debito', texto: `${abre}\nVi aqui que ${Number(deb.n) > 1 ? 'há ' + deb.n + ' títulos em aberto' : 'há um título em aberto'} no total de ${brl(deb.total)}. Quer que eu te mande a 2ª via com PIX para acertar? Depois já deixo seu próximo pedido pronto. 😊` };
    }
  } catch {}

  // Ultimo pedido com itens.
  try {
    const p: any = await db.execute(sql`
      SELECT sc.products, sc.sale_value, COALESCE(sc.completed_date, sc.updated_at) AS dia
      FROM sales_cards sc
      WHERE sc.customer_id = ${customerId}
        AND COALESCE(sc.operation_type,'venda') = 'venda'
        AND COALESCE(sc.status,'') NOT IN ('cancelled','telemarketing')
        AND (sc.completed_date IS NOT NULL OR COALESCE(sc.status,'') IN ('blocked','completed','invoiced'))
      ORDER BY COALESCE(sc.completed_date, sc.updated_at, sc.created_at) DESC LIMIT 1`);
    const ped = p.rows?.[0];
    const raw = ped?.products;
    const itens: any[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
    if (ped && itens.length) {
      const lista = itens.slice(0, 12).map((i: any) => `• ${i.quantity || 1}x ${String(i.name || '').replace(/^SUCO MISTO DE FRUTA - /i, '')}`).join('\n');
      const tot = Number(ped.sale_value || 0);
      return { tipo: 'pedido', texto: `${abre}\nPassando para ver se precisa repor. Seu último pedido (${ddmm(ped.dia)}) foi:\n${lista}${tot ? '\nTotal ' + brl(tot) : ''}\n\nQuer repetir para a próxima entrega? Responda *SIM* ou me diga o que mudar. 🍹` };
    }
  } catch {}

  return { tipo: 'generico', texto: `${abre}\nPassando para ver se precisa repor os sucos esta semana. Temos 8 sabores em 350ml e 900ml. Quer que eu monte um pedido para você? 🍹` };
}

export async function iaRepescagemTick(opts: { force?: boolean; dry?: boolean; limit?: number; drawDate?: string } = {}): Promise<any> {
  const hoje = opts.drawDate || hojeBR();
  const on = (await getSetting('ia_repescagem_on', 'on')) === 'on';
  if (!on && !opts.force) return { ran: false, reason: 'off' };
  const mode = await getSetting('agents_runtime_mode', 'off');
  if (mode === 'off') return { ran: false, reason: 'agents_runtime_mode=off' };
  const teste = mode === 'test'
    ? (await getSetting('agents_test_numbers', '')).split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean)
    : null;

  // Fecha o que ja foi atendido hoje antes de olhar o que sobrou.
  try { const { closeAndExpireRepescagem } = await import('./repescagem-routes'); await closeAndExpireRepescagem(hoje); } catch (e: any) { console.error('[IA-REP] close', e?.message || e); }

  const max = Math.max(1, Math.min(500, opts.limit || parseInt(await getSetting('ia_repescagem_max_dia', '150'), 10) || 150));
  const canal = (await getSetting('ia_repescagem_canal', '5562992682630')).replace(/\D/g, '') || '5562992682630';
  const alvos = await selecionarAlvos(hoje, max);
  const { podeFalarAtivamente } = await import('./mkt-fase0');
  const { sendUmblerTalkText } = await import('./chat-routes');

  const detalhes: any[] = [];
  let enviados = 0, pulados = 0, falhas = 0;
  for (const a of alvos) {
    const det: any = { cliente: a.nome, tel: a.telefone };
    try {
      if (teste && !teste.includes(a.telefone)) { pulados++; continue; }
      const pf = await podeFalarAtivamente({ customerId: a.customerId, telefone: a.telefone, useCase: 'repescagem' });
      if (!pf.pode) { det.pulo = pf.motivo; pulados++; detalhes.push(det); continue; }
      const conv = await conversaDoTelefone(a.telefone, a.nome, canal);
      if (!conv) { det.pulo = 'sem conversa'; pulados++; detalhes.push(det); continue; }
      if (!(await conversaLivre(conv.id))) { det.pulo = 'conversa com humano/recente'; pulados++; detalhes.push(det); continue; }
      const ab = await montarAbertura(a.customerId, a.nome);
      det.tipo = ab.tipo; det.texto = ab.texto;
      if (opts.dry) { detalhes.push(det); continue; }

      let r: any = null;
      try { r = await sendUmblerTalkText(a.telefone, ab.texto, canal); } catch (e: any) { r = { success: false, error: e?.message || String(e) }; }
      const ok = !!(r && r.success);
      await db.execute(sql`INSERT INTO ia_repescagem_contatos (assignment_id, customer_id, telefone, conversation_id, draw_date, tipo, texto, enviado_ok, erro)
        VALUES (${a.assignmentId}, ${a.customerId}, ${a.telefone}, ${conv.id}, ${hoje}, ${ab.tipo}, ${ab.texto}, ${ok}, ${ok ? null : String(r?.error || 'falha')})`);
      if (!ok) { falhas++; det.erro = r?.error; detalhes.push(det); continue; }

      // Mensagem na conversa como se fosse a IA (sender agent:%) -> quando o cliente responder,
      // shouldRespondNow ve "IA falou por ultimo" e o agente whatsapp continua na hora.
      try {
        await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read, metadata)
          VALUES (${conv.id}, 'agent:repescagem', 'system', ${ab.texto}, 'text', true, ${JSON.stringify({ auto: true, origem: 'ia_repescagem', assignment: a.assignmentId, delivery: r })}::jsonb)`);
        await db.execute(sql`UPDATE chat_conversations SET last_message_time = now(), updated_at = now(), status = CASE WHEN status = 'resolved' THEN 'new' ELSE status END WHERE id = ${conv.id}`);
      } catch {}
      // Atendimento registrado em nome da IA: fecha a alocacao e segura o sorteio por 7 dias.
      try {
        await db.execute(sql`INSERT INTO virtual_service_logs (customer_id, entity_type, attendant_id, attendant_name, attendance_date, service_type, notes)
          VALUES (${a.customerId}, 'customer', 'ia', 'IA WhatsApp (repescagem)', now(), 'repescagem_ia', ${'Contato automatico da IA (' + ab.tipo + ') via ' + canal})`);
      } catch (e: any) { console.error('[IA-REP] vlog', e?.message || e); }
      try { const { espelharConversa } = await import('./ia-espelho'); await espelharConversa({ conversationId: conv.id, phone: a.telefone, ia: ab.texto, agente: 'repescagem', nota: 'abertura (' + ab.tipo + ')' }); } catch {}
      enviados++; det.ok = true; detalhes.push(det);
      await new Promise(res => setTimeout(res, 4000));
    } catch (e: any) { falhas++; det.erro = e?.message || String(e); detalhes.push(det); }
  }
  if (!opts.dry) await setSetting('ia_repescagem_last_run', hoje);
  console.log(`[IA-REP] ${hoje}: alvos=${alvos.length} enviados=${enviados} pulados=${pulados} falhas=${falhas}${opts.dry ? ' (previa)' : ''}`);
  return { ran: true, drawDate: hoje, dry: !!opts.dry, mode, canal, alvos: alvos.length, enviados, pulados, falhas, detalhes: detalhes.slice(0, 200) };
}

export function registerIaRepescagem(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  app.get('/api/admin/ia-repescagem', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const run = String(req.query.run || '') === '1';
    const dry = !run || String(req.query.dry || '') === '1';
    const limit = parseInt(String(req.query.limit || ''), 10) || undefined;
    const drawDate = String(req.query.date || '') || undefined;
    try { res.json(await iaRepescagemTick({ force: true, dry, limit, drawDate })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/admin/ia-repescagem/config', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    if (typeof b.ativo === 'boolean') await setSetting('ia_repescagem_on', b.ativo ? 'on' : 'off');
    if (typeof b.hora === 'number') await setSetting('ia_repescagem_hora', String(b.hora));
    if (typeof b.maxDia === 'number') await setSetting('ia_repescagem_max_dia', String(b.maxDia));
    res.json({ ok: true, ativo: await getSetting('ia_repescagem_on', 'on'), hora: await getSetting('ia_repescagem_hora', '11'), maxDia: await getSetting('ia_repescagem_max_dia', '150') });
  });
  // Disparo diario: a cada minuto confere se e a hora (BRT), dia util (seg-sab) e ainda nao rodou hoje.
  try {
    setInterval(async () => {
      try {
        if ((await getSetting('ia_repescagem_on', 'on')) !== 'on') return;
        const dow = diaSemanaBR();
        if (dow === 0) return;
        // Feriado nacional/local: ninguem na operacao, cliente fechado -> nao contata (mesma fonte da fila humana).
        try { const { ehDiaUtil } = await import('./ia-fila'); if (!(await ehDiaUtil())) return; } catch {}
        const hora = parseInt(await getSetting('ia_repescagem_hora', '11'), 10) || 11;
        if (horaBR() < hora || horaBR() > hora + 3) return; // janela de 3h para pegar reinicios
        if ((await getSetting('ia_repescagem_last_run', '')) === hojeBR()) return;
        await iaRepescagemTick();
      } catch (e: any) { console.error('[IA-REP] tick', e?.message || e); }
    }, 60 * 1000);
  } catch {}
  console.log('[IA-REP] registrado (repescagem nao atendida -> IA as 11h BRT)');
}
