// ============================================================================
// INTEGRA 2.0 — IA · Resgate de quem parou de comprar (Plano Dobrar Vendas, Proposta 2)
// 11/10/2026 — decisões do Flavio: cupom 10 % (91–180 d), 15 % + amostra (181–365 d),
// brinde Uva 350 / frete grátis (61–90 d), contato pelo Umbler 2630 (texto livre).
//
// Todo dia útil às 10h a IA contata, sem aprovação humana (N0), os clientes por faixa de
// dias sem compra (última NF de venda autorizada, casada por CNPJ/CPF):
//   31–60   lembrete com o último pedido pronto para repetir; +1 lembrete em 3 d se calar
//   61–90   pergunta o motivo (3 opções) e oferece frete grátis OU 6 Uva 350 de brinde
//   91–180  cupom 10 % na primeira recompra; sem resposta em 5 d -> fila de ligação humana
//   181–365 mensal: novidade (Uva) + cupom 15 % + amostra
// Débito vencido: fala do acerto antes (mesma abertura da repescagem) e não dá cupom.
// Quando o cliente responde, o agente `whatsapp` continua (front-line) e, se fechar pedido,
// aplica o cupom pelo parâmetro `cupom` do registrar_pedido.
//
// Gates (system_settings): ia_resgate_on (on), ia_resgate_hora (10), ia_resgate_max_dia (60),
//   ia_resgate_canal (5562992682630), ia_resgate_cupom_min (pedido mínimo do cupom, 80)
// Rotas: GET /api/admin/ia-resgate?dry=1[&faixa=91-180][&limit=N] | ?run=1
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { whereDebitoVivoSql } from './divida-viva';

const TZ = 'America/Sao_Paulo';
const CFOPS = ['5101', '6101', '5102', '6102', '5405', '6404'];
function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function ddmm(d: any) { return d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' }) : ''; }
function hojeBR(): string { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function horaBR(): number { return parseInt(new Date().toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }), 10) || 0; }
const dig = (s: any) => String(s || '').replace(/\D/g, '');
function normalizar(t: string): string { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function title(t: string): string { return String(t || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m) => m.toUpperCase()).replace(/\b\d{8,14}\b/g, '').replace(/\b(Ltda|Me|Epp|Eireli|S\/a)\b\.?/gi, '').replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/g, '').trim(); }

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'ia-resgate')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

let _tabela = false;
async function ensureTabela() {
  if (_tabela) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ia_resgate_contatos (
    id serial PRIMARY KEY,
    customer_id varchar(64) NOT NULL,
    faixa varchar(10) NOT NULL,
    tipo varchar(20),             -- 'pedido' | 'motivo' | 'cupom10' | 'cupom15' | 'debito' | 'lembrete' | 'generico'
    cupom varchar(40),
    telefone varchar(20),
    conversation_id varchar(64),
    texto text,
    enviado_ok boolean,
    erro text,
    respondeu_em timestamptz,
    criado_em timestamptz DEFAULT now())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ia_resg_cust ON ia_resgate_contatos (customer_id, criado_em DESC)`);
  _tabela = true;
}

export type Faixa = '31-60' | '61-90' | '91-180' | '181-365';
type Alvo = { customerId: string; nome: string; telefone: string; faixa: Faixa; dias: number; ultima: string; contatos30d: number; ultimoContatoDias: number | null; ultimoTipo: string | null };

function celular(phone: any): string | null {
  let d = dig(phone).replace(/^55/, '');
  if (d.length === 10 && /^[1-9][0-9][6-9]/.test(d)) d = d.slice(0, 2) + '9' + d.slice(2);
  if (/(\d)\1{6,}/.test(d)) return null; // 99999-9999 e afins nao sao celular
  return /^[1-9][0-9]9[0-9]{8}$/.test(d) ? '55' + d : null;
}

// Clientes por faixa, com celular, sem contato de resgate nos últimos 30 d (ou lembrete da 31–60).
async function selecionar(limit: number, soFaixa?: string): Promise<Alvo[]> {
  await ensureTabela();
  const r: any = await db.execute(sql`
    WITH nf AS (
      SELECT regexp_replace(COALESCE(customer_cnpj_cpf,''),'[^0-9]','','g') AS doc, max(emission_date)::date AS ult
      FROM fiscal_invoices WHERE status = 'authorized' AND cfop = ANY(string_to_array(${CFOPS.join(',')}, ',')) GROUP BY 1
    ), sc AS (
      -- pedido no pipeline (card concluido/faturado) tambem conta como compra: a NF pode ainda nao existir
      SELECT customer_id, max(COALESCE(completed_date, updated_at))::date AS ult FROM sales_cards
      WHERE COALESCE(operation_type,'venda') = 'venda' AND COALESCE(status,'') NOT IN ('cancelled','telemarketing')
        AND (completed_date IS NOT NULL OR COALESCE(status,'') IN ('blocked','completed','invoiced')) GROUP BY 1
    ), base AS (
      SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, c.phone,
             GREATEST(nf.ult, COALESCE(sc.ult, nf.ult)) AS ult,
             ((now() AT TIME ZONE 'America/Sao_Paulo')::date - GREATEST(nf.ult, COALESCE(sc.ult, nf.ult))) AS dias
      FROM customers c
      JOIN nf ON nf.doc <> '' AND nf.doc = regexp_replace(COALESCE(c.cnpj, c.cpf, ''),'[^0-9]','','g')
      LEFT JOIN sc ON sc.customer_id = c.id
      WHERE COALESCE(c.is_supplier, false) = false
        AND COALESCE(c.situacao, '') NOT ILIKE 'inativo'
        AND regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') ~ '^(55)?[1-9][0-9](9[0-9]{8}|[6-9][0-9]{7})$'
    )
    SELECT b.id, b.nome, b.phone, b.ult, b.dias,
           CASE WHEN b.dias BETWEEN 31 AND 60 THEN '31-60' WHEN b.dias BETWEEN 61 AND 90 THEN '61-90'
                WHEN b.dias BETWEEN 91 AND 180 THEN '91-180' ELSE '181-365' END AS faixa,
           (SELECT count(*) FROM ia_resgate_contatos x WHERE x.customer_id = b.id AND x.criado_em > now() - interval '30 days')::int AS contatos30d,
           (SELECT extract(day from now() - max(x.criado_em))::int FROM ia_resgate_contatos x WHERE x.customer_id = b.id) AS ultimo_contato_dias,
           (SELECT x.tipo FROM ia_resgate_contatos x WHERE x.customer_id = b.id ORDER BY x.criado_em DESC LIMIT 1) AS ultimo_tipo,
           (SELECT max(x.respondeu_em) FROM ia_resgate_contatos x WHERE x.customer_id = b.id AND x.criado_em > now() - interval '30 days') AS respondeu
    FROM base b
    WHERE b.dias BETWEEN 31 AND 365
      AND (${soFaixa || ''} = '' OR (CASE WHEN b.dias BETWEEN 31 AND 60 THEN '31-60' WHEN b.dias BETWEEN 61 AND 90 THEN '61-90'
                WHEN b.dias BETWEEN 91 AND 180 THEN '91-180' ELSE '181-365' END) = ${soFaixa || ''})
      -- sem contato da repescagem por IA nos ultimos 7 dias (nao empilha dois contatos)
      AND NOT EXISTS (SELECT 1 FROM ia_repescagem_contatos p WHERE p.customer_id = b.id AND p.criado_em > now() - interval '7 days')
      -- sem atendimento humano/visita nos ultimos 7 dias
      AND NOT EXISTS (SELECT 1 FROM virtual_service_logs v WHERE v.customer_id = b.id AND v.attendance_date > now() - interval '7 days')
      AND NOT EXISTS (SELECT 1 FROM route_checkpoints k WHERE k.customer_id = b.id AND k.checkpoint_type = 'check_in' AND k.checkpoint_time > now() - interval '7 days')
    ORDER BY b.dias ASC
    LIMIT 3000`);
  const out: Alvo[] = [];
  const vistos = new Set<string>();
  for (const x of (r.rows || []) as any[]) {
    const tel = celular(x.phone);
    if (!tel || vistos.has(tel)) continue; // mesmo telefone em 2 cadastros (matriz/filial): 1 contato
    vistos.add(tel);
    const c30 = Number(x.contatos30d || 0);
    const ult = x.ultimo_contato_dias == null ? null : Number(x.ultimo_contato_dias);
    const faixa = String(x.faixa) as Faixa;
    // Regra de frequência: 1 contato / 30 d; na faixa 31–60, 1 lembrete 3 d depois se não respondeu.
    const lembrete = faixa === '31-60' && c30 === 1 && ult != null && ult >= 3 && !x.respondeu && x.ultimo_tipo !== 'lembrete';
    if (c30 > 0 && !lembrete) continue;
    out.push({ customerId: String(x.id), nome: String(x.nome || '').trim(), telefone: tel, faixa, dias: Number(x.dias), ultima: x.ult, contatos30d: c30, ultimoContatoDias: ult, ultimoTipo: lembrete ? 'lembrete' : (x.ultimo_tipo || null) });
  }
  // Cota por faixa (senao a 31-60 consome o teto e os 91-365 — o alvo do plano — nunca entram):
  // 35% 31-60 · 20% 61-90 · 25% 91-180 · 20% 181-365; sobra de uma faixa vai para as outras.
  if (soFaixa) return out.slice(0, limit);
  const grupos: Record<string, Alvo[]> = { '31-60': [], '61-90': [], '91-180': [], '181-365': [] };
  for (const a of out) grupos[a.faixa].push(a);
  const cotas: Record<string, number> = { '31-60': Math.round(limit * 0.35), '61-90': Math.round(limit * 0.20), '91-180': Math.round(limit * 0.25), '181-365': Math.round(limit * 0.20) };
  const sel: Alvo[] = [];
  for (const f of Object.keys(grupos)) sel.push(...grupos[f].splice(0, cotas[f]));
  for (const f of Object.keys(grupos)) { while (sel.length < limit && grupos[f].length) sel.push(grupos[f].shift()!); }
  return sel.slice(0, limit);
}

// Cupom mensal da faixa (uma vez por cliente), criado sob demanda. Ex.: VOLTA10-OUT26.
async function cupomDaFaixa(pct: 10 | 15): Promise<{ code: string; ate: Date } | null> {
  try {
    const meses = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const code = `VOLTA${pct}-${meses[d.getMonth()]}${String(d.getFullYear()).slice(2)}`;
    const ate = new Date(d.getFullYear(), d.getMonth() + 1, 15, 23, 59, 59); // vale até dia 15 do mês seguinte
    const minimo = parseFloat(await getSetting('ia_resgate_cupom_min', '80')) || null;
    const ex: any = await db.execute(sql`SELECT id, valid_until FROM coupons WHERE upper(code) = ${code} LIMIT 1`);
    if (!ex.rows?.length) {
      await db.execute(sql`INSERT INTO coupons (code, description, discount_type, discount_value, valid_from, valid_until, is_active, max_uses, min_order_value, once_per_customer, channels, enabled_2_0, created_by_user_id)
        VALUES (${code}, ${'Resgate IA: ' + pct + '% na primeira recompra (clientes sem compra ha ' + (pct === 10 ? '91-180' : '181-365') + ' dias)'}, 'percent', ${pct}, now(), ${ate}, true, NULL, ${minimo}, true, 'todos', true, 'ia-resgate')`);
    }
    return { code, ate };
  } catch (e: any) { console.error('[IA-RESGATE] cupom', e?.message || e); return null; }
}

async function temDebito(customerId: string): Promise<{ n: number; total: number } | null> {
  try {
    const d: any = await db.execute(sql`SELECT count(*)::int AS n, sum(r.amount - coalesce(r.amount_paid,0))::float AS total FROM receivables r WHERE r.customer_id = ${customerId} AND ${whereDebitoVivoSql('r')}`);
    const x = d.rows?.[0];
    return x && Number(x.n) > 0 && Number(x.total) > 0 ? { n: Number(x.n), total: Number(x.total) } : null;
  } catch { return null; }
}

async function ultimoPedido(customerId: string): Promise<{ lista: string; total: number; dia: any } | null> {
  try {
    const p: any = await db.execute(sql`
      SELECT sc.products, sc.sale_value, COALESCE(sc.completed_date, sc.updated_at) AS dia FROM sales_cards sc
      WHERE sc.customer_id = ${customerId} AND COALESCE(sc.operation_type,'venda') = 'venda'
        AND COALESCE(sc.status,'') NOT IN ('cancelled','telemarketing')
        AND (sc.completed_date IS NOT NULL OR COALESCE(sc.status,'') IN ('blocked','completed','invoiced'))
      ORDER BY COALESCE(sc.completed_date, sc.updated_at, sc.created_at) DESC LIMIT 1`);
    const ped = p.rows?.[0]; const raw = ped?.products;
    const itens: any[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
    if (!ped || !itens.length) return null;
    return { lista: itens.slice(0, 12).map((i: any) => `• ${i.quantity || 1}x ${String(i.name || '').replace(/^SUCO MISTO DE FRUTA - /i, '')}`).join('\n'), total: Number(ped.sale_value || 0), dia: ped.dia };
  } catch { return null; }
}

// Texto por faixa. Devolve tipo, texto e cupom (se houver).
async function montar(a: Alvo): Promise<{ tipo: string; texto: string; cupom?: string }> {
  const saud = horaBR() < 12 ? 'Bom dia' : (horaBR() < 18 ? 'Boa tarde' : 'Boa noite');
  const quem = title(a.nome);
  const abre = `${saud}${quem ? ', ' + quem : ''}! Aqui é a Honest Sucos 🧡`;

  const deb = await temDebito(a.customerId);
  if (deb) return { tipo: 'debito', texto: `${abre}\nFaz um tempo que não recebemos seu pedido, e vi que ${deb.n > 1 ? 'há ' + deb.n + ' títulos em aberto' : 'há um título em aberto'} (${brl(deb.total)}). Quer que eu te mande a 2ª via com PIX para acertar? Depois já deixo um pedido novo pronto para você. 😊` };

  if (a.ultimoTipo === 'lembrete') {
    return { tipo: 'lembrete', texto: `Oi${quem ? ', ' + quem : ''}! Passando de novo rapidinho 🧡 Quer que eu monte seu pedido de reposição desta semana? É só responder *SIM* ou me dizer os sabores.` };
  }

  if (a.faixa === '31-60') {
    const ped = await ultimoPedido(a.customerId);
    if (ped) return { tipo: 'pedido', texto: `${abre}\nSeu último pedido foi em ${ddmm(ped.dia)} — já deve estar na hora de repor. Foi assim:\n${ped.lista}${ped.total ? '\nTotal ' + brl(ped.total) : ''}\n\nQuer repetir para a próxima entrega? Responda *SIM* ou me diga o que mudar. 🍹` };
    return { tipo: 'generico', texto: `${abre}\nSua última compra foi em ${ddmm(a.ultima)} — já deve estar na hora de repor. Quer que eu monte um pedido? Temos 8 sabores em 350ml e 900ml. 🍹` };
  }

  if (a.faixa === '61-90') {
    return { tipo: 'motivo', texto: `${abre}\nSentimos sua falta por aqui — sua última compra foi em ${ddmm(a.ultima)}. Me ajuda a entender o que aconteceu? Responda com o número:\n1️⃣ Ainda tenho estoque\n2️⃣ Estou comprando de outro fornecedor\n3️⃣ Tive problema com entrega, produto ou preço\n\nE para voltar com o pé direito: no seu próximo pedido você escolhe *frete grátis* ou *6 garrafas de Uva 350ml de brinde* (nosso sabor novo). 🍇` };
  }

  if (a.faixa === '91-180') {
    const c = await cupomDaFaixa(10);
    return { tipo: 'cupom10', cupom: c?.code, texto: `${abre}\nFaz ${a.dias} dias que não recebemos seu pedido e queremos você de volta. Preparei um cupom de *10% de desconto* para sua primeira recompra: *${c?.code || 'VOLTA10'}*${c ? ' (vale até ' + ddmm(c.ate) + ')' : ''}.\nTemos novidade também: suco de *Uva* em 350ml e 900ml. 🍇\n\nQuer que eu monte um pedido com os sabores de sempre? Responda *SIM* ou me diga o que prefere.` };
  }

  const c = await cupomDaFaixa(15);
  return { tipo: 'cupom15', cupom: c?.code, texto: `${abre}\nFaz um bom tempo que não recebemos seu pedido — sua última compra foi em ${ddmm(a.ultima)}. Temos novidades: suco de *Uva* e em breve a garrafinha de 200ml.\nPara você experimentar de novo: cupom de *15% de desconto* na primeira recompra, *${c?.code || 'VOLTA15'}*${c ? ' (vale até ' + ddmm(c.ate) + ')' : ''}, e eu incluo uma *amostra de Uva* no pedido. 🍇\n\nQuer que eu monte um pedido? Responda *SIM* ou me diga o que prefere.` };
}

async function conversaDoTelefone(tel: string, nome: string, canal: string): Promise<{ id: string } | null> {
  try {
    const r: any = await db.execute(sql`SELECT id, channel_phone FROM chat_conversations
      WHERE customer_phone NOT LIKE 'ig:%' AND right(regexp_replace(COALESCE(customer_phone,''),'[^0-9]','','g'), 8) = ${tel.slice(-8)}
      ORDER BY last_message_time DESC NULLS LAST LIMIT 1`);
    const row = r.rows?.[0];
    if (row?.id) { if (!row.channel_phone) { try { await db.execute(sql`UPDATE chat_conversations SET channel_phone = ${canal} WHERE id = ${row.id}`); } catch {} } return { id: String(row.id) }; }
    const cc: any = await db.execute(sql`INSERT INTO chat_customers (name, phone) VALUES (${nome || tel}, ${tel}) RETURNING id`);
    const ins: any = await db.execute(sql`INSERT INTO chat_conversations (customer_id, customer_name, customer_phone, status, channel, channel_phone, initiated_by)
      VALUES (${cc.rows?.[0]?.id || null}, ${nome || tel}, ${tel}, 'new', 'whatsapp', ${canal}, 'customer') RETURNING id`);
    return ins.rows?.[0]?.id ? { id: String(ins.rows[0].id) } : null;
  } catch (e: any) { console.error('[IA-RESGATE] conversa', e?.message || e); return null; }
}
async function conversaLivre(convId: string): Promise<boolean> {
  try {
    const { iaPausadaConsistente } = await import('./mkt-fase0');
    if (await iaPausadaConsistente(convId)) return false;
    const r: any = await db.execute(sql`SELECT (coalesce(c.initiated_by::text,'customer') = 'user') AS do_atendente,
        EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_type <> 'customer' AND coalesce(m.sender_id,'') NOT LIKE 'agent:%' AND coalesce(m.sender_id,'') <> 'system' AND m.created_at > now() - interval '2 days') AS humano_recente,
        EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.created_at > now() - interval '12 hours') AS msg_recente
      FROM chat_conversations c WHERE c.id = ${convId}`);
    const x = r.rows?.[0]; if (!x) return true;
    return !(x.do_atendente || x.humano_recente || x.msg_recente);
  } catch { return true; }
}

export async function iaResgateTick(opts: { force?: boolean; dry?: boolean; limit?: number; faixa?: string } = {}): Promise<any> {
  if ((await getSetting('ia_resgate_on', 'on')) !== 'on' && !opts.force) return { ran: false, reason: 'off' };
  const mode = await getSetting('agents_runtime_mode', 'off');
  if (mode === 'off') return { ran: false, reason: 'agents_runtime_mode=off' };
  const teste = mode === 'test' ? (await getSetting('agents_test_numbers', '')).split(/[,;\s]+/).map(dig).filter(Boolean) : null;
  const max = Math.max(1, Math.min(300, opts.limit || parseInt(await getSetting('ia_resgate_max_dia', '60'), 10) || 60));
  const canal = dig(await getSetting('ia_resgate_canal', '5562992682630')) || '5562992682630';
  const alvos = await selecionar(max, opts.faixa);
  const { podeFalarAtivamente } = await import('./mkt-fase0');
  const { sendUmblerTalkText } = await import('./chat-routes');
  const detalhes: any[] = []; let enviados = 0, pulados = 0, falhas = 0;
  const porFaixa: Record<string, number> = {};
  for (const a of alvos) {
    const det: any = { cliente: a.nome, tel: a.telefone, faixa: a.faixa, dias: a.dias };
    try {
      if (teste && !teste.includes(a.telefone)) { pulados++; continue; }
      const pf = await podeFalarAtivamente({ customerId: a.customerId, telefone: a.telefone, useCase: 'resgate', categoria: 'MARKETING' });
      if (!pf.pode) { det.pulo = pf.motivo; pulados++; detalhes.push(det); continue; }
      const conv = await conversaDoTelefone(a.telefone, a.nome, canal);
      if (!conv) { det.pulo = 'sem conversa'; pulados++; detalhes.push(det); continue; }
      if (!(await conversaLivre(conv.id))) { det.pulo = 'conversa com humano/recente'; pulados++; detalhes.push(det); continue; }
      const m = await montar(a);
      det.tipo = m.tipo; det.texto = m.texto; det.cupom = m.cupom || null;
      if (opts.dry) { detalhes.push(det); continue; }
      let r: any = null;
      try { r = await sendUmblerTalkText(a.telefone, m.texto, canal); } catch (e: any) { r = { success: false, error: e?.message || String(e) }; }
      const ok = !!(r && r.success);
      await db.execute(sql`INSERT INTO ia_resgate_contatos (customer_id, faixa, tipo, cupom, telefone, conversation_id, texto, enviado_ok, erro)
        VALUES (${a.customerId}, ${a.faixa}, ${m.tipo}, ${m.cupom || null}, ${a.telefone}, ${conv.id}, ${m.texto}, ${ok}, ${ok ? null : String(r?.error || 'falha')})`);
      if (!ok) { falhas++; det.erro = r?.error; detalhes.push(det); continue; }
      try {
        await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read, metadata)
          VALUES (${conv.id}, 'agent:resgate', 'system', ${m.texto}, 'text', true, ${JSON.stringify({ auto: true, origem: 'ia_resgate', faixa: a.faixa, tipo: m.tipo, cupom: m.cupom || null, delivery: r })}::jsonb)`);
        await db.execute(sql`UPDATE chat_conversations SET last_message_time = now(), updated_at = now(), status = CASE WHEN status = 'resolved' THEN 'new' ELSE status END WHERE id = ${conv.id}`);
      } catch {}
      try { const { espelharConversa } = await import('./ia-espelho'); await espelharConversa({ conversationId: conv.id, phone: a.telefone, ia: m.texto, agente: 'resgate', nota: `faixa ${a.faixa} · ${m.tipo}` }); } catch {}
      enviados++; porFaixa[a.faixa] = (porFaixa[a.faixa] || 0) + 1; det.ok = true; detalhes.push(det);
      await new Promise(res => setTimeout(res, 4000));
    } catch (e: any) { falhas++; det.erro = e?.message || String(e); detalhes.push(det); }
  }
  if (!opts.dry) { await setSetting('ia_resgate_last_run', hojeBR()); await encaminharParaLigacao(); }
  console.log(`[IA-RESGATE] ${hojeBR()}: alvos=${alvos.length} enviados=${enviados} pulados=${pulados} falhas=${falhas}${opts.dry ? ' (previa)' : ''}`);
  return { ran: true, dry: !!opts.dry, mode, canal, alvos: alvos.length, enviados, porFaixa, pulados, falhas, detalhes: detalhes.slice(0, 200) };
}

// 91–180 d sem resposta em 5 dias -> fila de ligação humana (churn_resgate_queue, status 'ligar').
async function encaminharParaLigacao(): Promise<void> {
  try {
    const r: any = await db.execute(sql`
      SELECT x.customer_id, c.name, c.fantasy_name, c.city, c.neighborhood, c.phone, c.cnpj, c.cpf, x.faixa, x.criado_em
      FROM ia_resgate_contatos x JOIN customers c ON c.id = x.customer_id
      WHERE x.faixa IN ('91-180','181-365') AND x.enviado_ok = true AND x.respondeu_em IS NULL
        AND x.criado_em < now() - interval '5 days' AND x.criado_em > now() - interval '12 days'
        AND NOT EXISTS (SELECT 1 FROM churn_resgate_queue q WHERE q.customer_id = x.customer_id AND q.status IN ('ligar','em_andamento') )`);
    for (const c of (r.rows || []) as any[]) {
      await db.execute(sql`INSERT INTO churn_resgate_queue (customer_id, customer_name, cidade, bairro, telefone, documento, faixa, status, notes)
        VALUES (${c.customer_id}, ${c.fantasy_name || c.name}, ${c.city || null}, ${c.neighborhood || null}, ${c.phone || null}, ${c.cnpj || c.cpf || null}, ${c.faixa === '91-180' ? 'esfriando' : 'perdido'}, 'ligar',
                ${'IA contatou em ' + ddmm(c.criado_em) + ' sem resposta — ligar (Letícia/Robson)'})`);
    }
    if (r.rows?.length) console.log(`[IA-RESGATE] ${r.rows.length} cliente(s) encaminhado(s) para ligação humana`);
  } catch (e: any) { console.error('[IA-RESGATE] ligacao', e?.message || e); }
}

// ---------------------------------------------------------------------------
// Resposta do cliente (chamada por ia-takeover.reactiveInbound antes da IA):
//  - marca respondeu_em no último contato;
//  - na faixa 61–90, "1/2/3" vira outcome_reason na churn_resgate_queue e devolve a oferta.
// Devolve texto só quando trata a mensagem; null deixa a IA seguir.
// ---------------------------------------------------------------------------
export async function respostaDoResgate(phone: string, texto: string): Promise<string | null> {
  try {
    await ensureTabela();
    const d = dig(phone); if (d.length < 8) return null;
    const r: any = await db.execute(sql`SELECT id, customer_id, faixa, tipo, respondeu_em, criado_em FROM ia_resgate_contatos
      WHERE right(telefone, 8) = ${d.slice(-8)} AND enviado_ok = true AND criado_em > now() - interval '10 days'
      ORDER BY criado_em DESC LIMIT 1`);
    const c = r.rows?.[0]; if (!c) return null;
    if (!c.respondeu_em) await db.execute(sql`UPDATE ia_resgate_contatos SET respondeu_em = now() WHERE id = ${c.id}`);
    if (c.tipo !== 'motivo') return null;
    const t = normalizar(texto);
    const motivos: Record<string, string> = { '1': 'ainda tem estoque', '2': 'comprando de outro fornecedor', '3': 'problema com entrega/produto/preco' };
    const k = t.match(/^([123])\b/)?.[1] || (/(estoque|ainda tenho|sobrou)/.test(t) ? '1' : (/(outro fornecedor|concorrente|outra marca|fornecedor)/.test(t) ? '2' : (/(problema|atras|preco|caro|estrag|venc|entrega)/.test(t) ? '3' : '')));
    if (!k) return null;
    try {
      await db.execute(sql`INSERT INTO churn_resgate_queue (customer_id, faixa, status, outcome, outcome_reason, outcome_at, notes)
        VALUES (${c.customer_id}, 'em_risco', 'respondido', 'motivo_informado', ${motivos[k]}, now(), ${'Respondeu a IA em ' + hojeBR()})`);
    } catch {}
    if (k === '1') return 'Entendi, obrigado! 🧡 Então quando estiver perto de acabar me chama que eu monto o pedido na hora — e lembra: no próximo pedido você escolhe frete grátis ou 6 Uva 350ml de brinde. Quer que eu te lembre em alguns dias?';
    if (k === '2') return 'Entendi, obrigado pela sinceridade! 🧡 Posso perguntar o que pesou na troca — preço, sabor, entrega? Se quiser dar uma nova chance, no próximo pedido você escolhe frete grátis ou 6 Uva 350ml de brinde, e eu cuido pessoalmente para a entrega sair certinha.';
    return 'Poxa, sinto muito por isso — obrigado por me contar. 🧡 Me diz o que aconteceu que eu já levo para a equipe resolver. E no seu próximo pedido você escolhe frete grátis ou 6 Uva 350ml de brinde, por nossa conta.';
  } catch (e: any) { console.error('[IA-RESGATE] resposta', e?.message || e); return null; }
}

// Cupom ativo deste cliente (para o bloco ESTE CLIENTE do prompt).
export async function cupomAtivoDoCliente(customerId: string): Promise<string> {
  try {
    await ensureTabela();
    const r: any = await db.execute(sql`SELECT x.cupom, x.faixa, x.criado_em, c.valid_until, c.discount_value::float AS pct
      FROM ia_resgate_contatos x JOIN coupons c ON upper(c.code) = upper(x.cupom)
      WHERE x.customer_id = ${customerId} AND x.cupom IS NOT NULL AND x.criado_em > now() - interval '45 days'
        AND c.is_active = true AND (c.valid_until IS NULL OR c.valid_until > now())
        AND NOT EXISTS (SELECT 1 FROM coupon_redemptions cr WHERE cr.coupon_id = c.id AND cr.customer_id = ${customerId})
      ORDER BY x.criado_em DESC LIMIT 1`);
    const x = r.rows?.[0]; if (!x) return '';
    return `Cupom de resgate ATIVO para este cliente: ${x.cupom} (${x.pct}% na primeira recompra, válido até ${ddmm(x.valid_until)}). Se ele fechar pedido, passe cupom="${x.cupom}" no registrar_pedido.` + (x.faixa === '181-365' ? ' Inclua tambem 1 amostra de Uva 350ml (brinde) nas observacoes.' : '');
  } catch { return ''; }
}

export function registerIaResgate(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  app.get('/api/admin/ia-resgate', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const run = String(req.query.run || '') === '1';
    const limit = parseInt(String(req.query.limit || ''), 10) || undefined;
    const faixa = String(req.query.faixa || '') || undefined;
    try { res.json(await iaResgateTick({ force: true, dry: !run, limit, faixa })); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  try {
    setInterval(async () => {
      try {
        if ((await getSetting('ia_resgate_on', 'on')) !== 'on') return;
        const { ehDiaUtil } = await import('./ia-fila');
        if (!(await ehDiaUtil())) return;
        const hora = parseInt(await getSetting('ia_resgate_hora', '10'), 10) || 10;
        if (horaBR() < hora || horaBR() > hora + 3) return;
        if ((await getSetting('ia_resgate_last_run', '')) === hojeBR()) return;
        await iaResgateTick();
      } catch (e: any) { console.error('[IA-RESGATE] tick', e?.message || e); }
    }, 60 * 1000);
  } catch {}
  console.log('[IA-RESGATE] registrado (resgate por faixa 31-365 d, 10h BRT, N0)');
}
