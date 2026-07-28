// ============================================================================
// INTEGRA 2.0 — IA de Atendimento · Fila e repasse dirigido (ia-fila)
//
// Regra de negocio implementada aqui:
//   1. Enquanto a IA esta atendendo, NENHUM atendente pode interromper a conversa.
//   2. A conversa so e liberada quando a IA chama transferir_humano.
//   3. Ao liberar, a IA procura o DONO DA CARTEIRA do cliente (customers.seller_id):
//        - dono ONLINE  -> a conversa vai para ele, em modo EXCLUSIVO (so ele le e
//                          responde) e ele recebe a notificacao de "aguardando atendimento";
//        - dono OFFLINE -> vai para qualquer atendente online (rodizio), sem exclusividade.
//   4. Se o dono foi notificado e nao responder em ia_handoff_min (padrao 5 min),
//      a conversa e repassada para outro atendente online.
//
// Presenca: o sistema tem DOIS mecanismos independentes (chat_agents.status, do
// heartbeat do ChatCenter, e users.last_seen_at, do ping do Layout). Aqui vale
// online em QUALQUER um dos dois — evita conversa parada porque o atendente
// fechou a aba do ChatCenter mas continua trabalhando no Integra.
//
// Wiring em server/index.ts:  import { registerIaFila } from "./ia-fila";  registerIaFila(app);
//
// Chaves (system_settings):
//   ia_front_line     : 'on'|'off'  -> IA atende sozinha (trava o atendente)
//   ia_handoff_min    : minutos que o dono tem para responder antes de perder a vez (padrao 5)
//   ia_carteira_padrao: users.id que vira dono do cliente NOVO cadastrado pela IA
//   ia_notifica_wa    : 'on'|'off'  -> avisa o atendente por WhatsApp (padrao on)
//   ia_trava_admin    : 'on'|'off'  -> se 'on', nem admin escreve por cima da IA (padrao off)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const ONLINE_MIN_DEFAULT = 3; // mesma janela usada pelo lead-capture

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

const PLACEHOLDERS = ['chatgpt-ai', 'instagram', 'system', 'auto', 'reconcile', 'unknown-vendor', ''];

export async function ensureFilaTable(): Promise<void> {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS ia_handoff (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id varchar UNIQUE,
      customer_phone varchar,
      owner_user_id varchar,
      target_user_id varchar,
      target_agent_id varchar,
      exclusivo boolean DEFAULT false,
      motivo text,
      status varchar DEFAULT 'waiting',
      notified_at timestamptz DEFAULT now(),
      deadline_at timestamptz,
      answered_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`);
  } catch (e: any) { console.error('[IA-FILA] ensure table', e?.message || e); }
}

// ---------------------------------------------------------------------------
// Presenca
// ---------------------------------------------------------------------------

// Online = heartbeat do ChatCenter (chat_agents.status) OU ping do Layout
// (users.last_seen_at dentro da janela). Basta um dos dois.
export async function usuarioOnline(userId: string): Promise<boolean> {
  if (!userId) return false;
  const mins = Math.max(1, parseInt(process.env.LEAD_ONLINE_MINUTES || String(ONLINE_MIN_DEFAULT), 10) || ONLINE_MIN_DEFAULT);
  try {
    const r: any = await db.execute(sql`
      SELECT 1 FROM chat_agents WHERE user_id = ${userId} AND status = 'online' AND coalesce(is_active, true) = true
      UNION ALL
      SELECT 1 FROM users WHERE id = ${userId} AND coalesce(is_active, true) = true
        AND last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(mins => ${mins})
      LIMIT 1`);
    return !!r.rows?.[0];
  } catch { return false; }
}

// Atendentes disponiveis agora (chat_agents online, ou com dono online pelo ping do Layout).
async function agentesDisponiveis(excluirAgentId?: string): Promise<Array<{ agent_id: string; user_id: string | null; name: string; phone: string | null }>> {
  const mins = Math.max(1, parseInt(process.env.LEAD_ONLINE_MINUTES || String(ONLINE_MIN_DEFAULT), 10) || ONLINE_MIN_DEFAULT);
  try {
    const r: any = await db.execute(sql`
      SELECT a.id AS agent_id, a.user_id, a.name, coalesce(a.phone, u.phone) AS phone, t.ult
      FROM chat_agents a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN LATERAL (
        SELECT max(last_attended_at) AS ult FROM chat_conversations WHERE assigned_agent_id = a.id
      ) t ON true
      WHERE coalesce(a.is_active, true) = true
        AND (
          a.status = 'online'
          OR (u.id IS NOT NULL AND coalesce(u.is_active, true) = true
              AND u.last_seen_at IS NOT NULL AND u.last_seen_at > now() - make_interval(mins => ${mins}))
        )
      ORDER BY t.ult ASC NULLS FIRST, a.name`);
    const rows = (r.rows || []) as any[];
    return rows.filter(x => !excluirAgentId || String(x.agent_id) !== String(excluirAgentId));
  } catch { return []; }
}

// chat_agents correspondente a um usuario do sistema.
async function agentDoUsuario(userId: string): Promise<{ agent_id: string; name: string; phone: string | null } | null> {
  try {
    const r: any = await db.execute(sql`SELECT a.id AS agent_id, a.name, coalesce(a.phone, u.phone) AS phone
      FROM chat_agents a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ${userId} AND coalesce(a.is_active, true) = true LIMIT 1`);
    return r.rows?.[0] || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Carteira
// ---------------------------------------------------------------------------

// Dono da carteira a partir do telefone do cliente (casa pelos ultimos 8 digitos,
// mesma regra do storage.getCustomerByPhone). Retorna users.id ou null.
export async function donoDaCarteira(phone: string): Promise<string | null> {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  const last8 = d.slice(-8);
  try {
    const r: any = await db.execute(sql`SELECT c.seller_id FROM customers c
      WHERE RIGHT(REGEXP_REPLACE(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 8) = ${last8}
        AND c.seller_id IS NOT NULL
      ORDER BY c.updated_at DESC NULLS LAST LIMIT 1`);
    const s = r.rows?.[0]?.seller_id;
    if (!s) return null;
    const sid = String(s);
    if (PLACEHOLDERS.includes(sid)) return null;
    // Precisa ser um usuario real do sistema (codigos omie-vendor-* nao logam no ChatCenter).
    const u: any = await db.execute(sql`SELECT id FROM users WHERE id = ${sid} AND coalesce(is_active, true) = true LIMIT 1`);
    return u.rows?.[0]?.id ? sid : null;
  } catch { return null; }
}

// Carteira padrao para cliente NOVO cadastrado pela IA (decisao do Flavio: Honest 1).
export async function carteiraPadrao(): Promise<string> {
  return await getSetting('ia_carteira_padrao', '58f7ba0b-dcd1-4d0e-abc2-458cdddb2794');
}

// ---------------------------------------------------------------------------
// Dia util / feriado
// ---------------------------------------------------------------------------

// Feriados nacionais de data FIXA (MM-DD). Os moveis (Carnaval, Sexta-Santa,
// Corpus Christi) e os municipais entram na lista 'ia_feriados' (YYYY-MM-DD).
const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];

function partesBR(d: Date): { iso: string; dow: number } {
  const iso = d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  const nome = d.toLocaleDateString('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { iso, dow: map[nome] ?? 1 };
}

export async function ehDiaUtil(d: Date = new Date()): Promise<boolean> {
  const { iso, dow } = partesBR(d);
  const dias = (await getSetting('ia_dias_uteis', '1,2,3,4,5')).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  if (!dias.includes(String(dow))) return false;
  if (FERIADOS_FIXOS.includes(iso.slice(5))) return false;
  const extras = (await getSetting('ia_feriados', '')).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  return !extras.includes(iso);
}

// Nome amigavel do proximo dia util ("amanha", "na segunda-feira", ...).
export async function proximoDiaUtilTexto(): Promise<string> {
  const nomes = ['domingo', 'segunda-feira', 'terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado'];
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.now() + i * 24 * 3600 * 1000);
    if (await ehDiaUtil(d)) {
      const { dow } = partesBR(d);
      return i === 1 ? 'amanha' : ('na ' + nomes[dow]);
    }
  }
  return 'no proximo dia util';
}

// ---------------------------------------------------------------------------
// Etiqueta "Aguardando resposta"
// ---------------------------------------------------------------------------

const LABEL_AGUARDANDO = '\u23F3 Aguardando resposta';

async function labelAguardandoId(): Promise<string | null> {
  try {
    const r: any = await db.execute(sql`SELECT id FROM chat_labels WHERE name = ${LABEL_AGUARDANDO} LIMIT 1`);
    if (r.rows?.[0]?.id) return String(r.rows[0].id);
    const ins: any = await db.execute(sql`INSERT INTO chat_labels (name, color, created_by, created_by_name)
      VALUES (${LABEL_AGUARDANDO}, '#f59e0b', 'system', 'IA') RETURNING id`);
    return ins.rows?.[0]?.id ? String(ins.rows[0].id) : null;
  } catch { return null; }
}

// Marca a conversa como "aguardando resposta" (etiqueta) e deixa a mensagem de
// sistema NAO lida, para o atendente ver o badge no ChatCenter.
export async function marcarAguardando(conversationId: string, texto: string): Promise<void> {
  try {
    const lid = await labelAguardandoId();
    if (lid) await db.execute(sql`INSERT INTO chat_conversation_labels (conversation_id, label_id)
      VALUES (${conversationId}, ${lid}) ON CONFLICT DO NOTHING`);
  } catch {}
  try {
    await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
      VALUES (${conversationId}, 'system', 'system', ${texto}, 'text', false)`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Lembrete: conversa aberta pelo atendente que ficou esquecida
// ---------------------------------------------------------------------------

export async function lembreteTick(): Promise<{ ran: boolean; lembradas: number; detalhes: any[] }> {
  const detalhes: any[] = [];
  let lembradas = 0;
  try {
    if ((await getSetting('ia_lembrete_on', 'on')) !== 'on') return { ran: false, lembradas: 0, detalhes };
    await ensureFilaTable();
    const mins = Math.max(5, parseInt(await getSetting('ia_lembrete_min', '120'), 10) || 120);
    const repeteH = Math.max(1, parseInt(await getSetting('ia_lembrete_repete_h', '24'), 10) || 24);
    const r: any = await db.execute(sql`SELECT id, customer_name, customer_phone FROM chat_conversations
      WHERE coalesce(initiated_by::text, 'customer') = 'user'
        AND status <> 'resolved'
        AND last_message_time IS NOT NULL
        AND last_message_time < now() - make_interval(mins => ${mins})
      ORDER BY last_message_time ASC LIMIT 20`);
    for (const c of (r.rows || []) as any[]) {
      const k = 'ia_lembrete_ts:' + c.id;
      const ultimo = await getSetting(k, '');
      if (ultimo) {
        const t = Date.parse(ultimo);
        if (!isNaN(t) && (Date.now() - t) < repeteH * 3600 * 1000) continue;
      }
      await marcarAguardando(String(c.id),
        `[IA] Esta conversa com ${c.customer_name || c.customer_phone || 'o cliente'} continua aberta e sem movimento. Se o atendimento terminou, finalize a conversa; se ainda falta algo, retome com o cliente.`);
      try {
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${new Date().toISOString()}, 'ia-fila')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      } catch {}
      lembradas++;
      detalhes.push({ conv: c.id });
      console.log(`[IA-FILA] lembrete de finalizacao conv=${c.id}`);
    }
  } catch (e: any) { console.error('[IA-FILA] lembrete', e?.message || e); }
  return { ran: true, lembradas, detalhes };
}

// ---------------------------------------------------------------------------
// Notificacao
// ---------------------------------------------------------------------------

async function avisarAtendente(phone: string | null, nome: string, clienteNome: string, exclusivo: boolean): Promise<void> {
  if (!phone) return;
  if ((await getSetting('ia_notifica_wa', 'on')) !== 'on') return;
  const msg = exclusivo
    ? `🔔 ${nome}, o cliente *${clienteNome}* pediu para falar com uma pessoa e a conversa é SUA (carteira). Ela está aguardando atendimento no ChatCenter.`
    : `🔔 ${nome}, o cliente *${clienteNome}* pediu para falar com uma pessoa. A conversa está aguardando atendimento no ChatCenter.`;
  try {
    const { sendUmblerTalkText } = await import('./chat-routes');
    await sendUmblerTalkText(phone, msg);
  } catch (e: any) { console.error('[IA-FILA] aviso', e?.message || e); }
}

async function nomeDoCliente(conversationId: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT coalesce(customer_name, customer_phone, 'cliente') AS n FROM chat_conversations WHERE id = ${conversationId} LIMIT 1`);
    return String(r.rows?.[0]?.n || 'cliente');
  } catch { return 'cliente'; }
}

async function msgSistema(conversationId: string, texto: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
      VALUES (${conversationId}, 'system', 'system', ${texto}, 'text', true)`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Repasse dirigido (chamado pela ferramenta transferir_humano)
// ---------------------------------------------------------------------------

async function atribuir(conversationId: string, agentId: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE chat_conversations
      SET assigned_agent_id = ${agentId}, status = 'assigned', last_attended_at = now(), updated_at = now()
      WHERE id = ${conversationId}`);
  } catch (e: any) { console.error('[IA-FILA] atribuir', e?.message || e); }
}

export async function handoffParaHumano(conversationId: string, phone: string, motivo?: string): Promise<{ ok: boolean; alvo?: string; exclusivo?: boolean; erro?: string; foraExpediente?: boolean; retorno?: string; semAtendente?: boolean }> {
  try {
    await ensureFilaTable();
    const minutos = Math.max(1, parseInt(await getSetting('ia_handoff_min', '5'), 10) || 5);
    const cliente = await nomeDoCliente(conversationId);

    const owner = await donoDaCarteira(phone);

    // Sabado, domingo ou feriado: ninguem para assumir agora. A conversa fica marcada
    // como "aguardando resposta" para o dono da carteira (ou para a fila) e a IA avisa
    // o cliente que o retorno acontece no proximo dia util.
    if (!(await ehDiaUtil())) {
      const retorno = await proximoDiaUtilTexto();
      let agentId: string | null = null;
      let nomeAlvo = '';
      if (owner) { const a = await agentDoUsuario(owner); if (a) { agentId = a.agent_id; nomeAlvo = a.name; } }
      if (agentId) await atribuir(conversationId, agentId);
      await db.execute(sql`INSERT INTO ia_handoff (conversation_id, customer_phone, owner_user_id, target_user_id, target_agent_id, exclusivo, motivo, status, notified_at, deadline_at)
        VALUES (${conversationId}, ${phone}, ${owner}, ${owner}, ${agentId}, false, ${motivo || null}, 'proximo_dia_util', now(), NULL)
        ON CONFLICT (conversation_id) DO UPDATE SET customer_phone = EXCLUDED.customer_phone, owner_user_id = EXCLUDED.owner_user_id,
          target_user_id = EXCLUDED.target_user_id, target_agent_id = EXCLUDED.target_agent_id, exclusivo = false,
          motivo = EXCLUDED.motivo, status = 'proximo_dia_util', notified_at = now(), deadline_at = NULL,
          answered_at = NULL, updated_at = now()`);
      await marcarAguardando(conversationId,
        `[IA] ${cliente} pediu para falar com uma pessoa fora do expediente (fim de semana/feriado). Foi informado que o retorno acontece ${retorno}.${nomeAlvo ? ' Carteira: ' + nomeAlvo + '.' : ''} Entrar em contato no proximo dia util.`);
      console.log(`[IA-FILA] conv=${conversationId} fora de expediente, retorno ${retorno}`);
      return { ok: true, foraExpediente: true, retorno, alvo: nomeAlvo || undefined };
    }
    let alvoUserId: string | null = null;
    let alvoAgent: { agent_id: string; name: string; phone: string | null } | null = null;
    let exclusivo = false;

    if (owner && (await usuarioOnline(owner))) {
      const a = await agentDoUsuario(owner);
      if (a) { alvoUserId = owner; alvoAgent = a; exclusivo = true; }
    }

    if (!alvoAgent) {
      const lista = await agentesDisponiveis();
      if (lista.length) {
        const esc = lista[0];
        alvoUserId = esc.user_id ? String(esc.user_id) : null;
        alvoAgent = { agent_id: String(esc.agent_id), name: esc.name, phone: esc.phone };
      }
    }

    // Ninguem online em dia util: a conversa fica reservada ao DONO da carteira e ele
    // e notificado do mesmo jeito (WhatsApp + etiqueta). O cliente ouve que os
    // atendentes estao ocupados e que sera atendido em breve.
    if (!alvoAgent) {
      let agentId: string | null = null;
      let nomeDono = '';
      let foneDono: string | null = null;
      if (owner) {
        const a = await agentDoUsuario(owner);
        if (a) { agentId = a.agent_id; nomeDono = a.name; foneDono = a.phone; }
        else {
          try {
            const u: any = await db.execute(sql`SELECT coalesce(first_name,'') || ' ' || coalesce(last_name,'') AS n, phone FROM users WHERE id = ${owner} LIMIT 1`);
            nomeDono = String(u.rows?.[0]?.n || '').trim();
            foneDono = u.rows?.[0]?.phone || null;
          } catch {}
        }
      }
      if (agentId) await atribuir(conversationId, agentId);
      await db.execute(sql`INSERT INTO ia_handoff (conversation_id, customer_phone, owner_user_id, target_user_id, target_agent_id, exclusivo, motivo, status, notified_at, deadline_at)
        VALUES (${conversationId}, ${phone}, ${owner}, ${owner}, ${agentId}, false, ${motivo || null}, 'sem_atendente', now(), NULL)
        ON CONFLICT (conversation_id) DO UPDATE SET customer_phone = EXCLUDED.customer_phone, owner_user_id = EXCLUDED.owner_user_id,
          target_user_id = EXCLUDED.target_user_id, target_agent_id = EXCLUDED.target_agent_id, exclusivo = false,
          motivo = EXCLUDED.motivo, status = 'sem_atendente', notified_at = now(), deadline_at = NULL,
          answered_at = NULL, updated_at = now()`);
      await marcarAguardando(conversationId,
        `[IA] ${cliente} pediu para falar com uma pessoa e nao havia nenhum atendente online. O cliente foi avisado que sera atendido em breve.${nomeDono ? ' Carteira: ' + nomeDono + '.' : ''} Entrar em contato.`);
      await avisarAtendente(foneDono, nomeDono || 'atendente', cliente, false);
      console.log(`[IA-FILA] conv=${conversationId} sem atendente online (dono=${nomeDono || '-'})`);
      return { ok: true, semAtendente: true, alvo: nomeDono || undefined };
    }

    await atribuir(conversationId, alvoAgent.agent_id);
    await db.execute(sql`INSERT INTO ia_handoff (conversation_id, customer_phone, owner_user_id, target_user_id, target_agent_id, exclusivo, motivo, status, notified_at, deadline_at)
      VALUES (${conversationId}, ${phone}, ${owner}, ${alvoUserId}, ${alvoAgent.agent_id}, ${exclusivo}, ${motivo || null}, 'waiting', now(), now() + make_interval(mins => ${minutos}))
      ON CONFLICT (conversation_id) DO UPDATE SET customer_phone = EXCLUDED.customer_phone, owner_user_id = EXCLUDED.owner_user_id,
        target_user_id = EXCLUDED.target_user_id, target_agent_id = EXCLUDED.target_agent_id, exclusivo = EXCLUDED.exclusivo,
        motivo = EXCLUDED.motivo, status = 'waiting', notified_at = now(), deadline_at = EXCLUDED.deadline_at,
        answered_at = NULL, updated_at = now()`);

    await msgSistema(conversationId, exclusivo
      ? `[IA] Aguardando atendimento de ${alvoAgent.name} (dono da carteira).`
      : `[IA] Aguardando atendimento de ${alvoAgent.name}.`);
    await avisarAtendente(alvoAgent.phone, alvoAgent.name, cliente, exclusivo);

    console.log(`[IA-FILA] conv=${conversationId} -> ${alvoAgent.name} exclusivo=${exclusivo} prazo=${minutos}min`);
    return { ok: true, alvo: alvoAgent.name, exclusivo };
  } catch (e: any) {
    console.error('[IA-FILA] handoff', e?.message || e);
    return { ok: false, erro: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Permissoes (usadas pelo chat-routes)
// ---------------------------------------------------------------------------

// A IA esta com a conversa agora? (modo front-line ligado e conversa nao transferida)
async function iaComAConversa(conversationId: string): Promise<boolean> {
  if ((await getSetting('ia_front_line', 'off')) !== 'on') return false;
  if ((await getSetting('agents_runtime_mode', 'off')) === 'off') return false;
  // A pausa (setada pelo transferir_humano) e o que tira a conversa da IA. Ela expira em
  // ia_pausa_horas — quando expirar, a IA volta a ser a linha de frente daquela conversa.
  if ((await getSetting('chat_ai_paused:' + conversationId, '')) !== '') return false;
  return true;
}

export type Veredito = { ok: true } | { ok: false; code: string; message: string };

// Pode ESCREVER nesta conversa?
export async function podeEnviar(conversationId: string, userId: string, role?: string): Promise<Veredito> {
  try {
    const isAdmin = role === 'admin' || role === 'coordinator';
    if (await iaComAConversa(conversationId)) {
      if (isAdmin && (await getSetting('ia_trava_admin', 'off')) !== 'on') return { ok: true };
      return { ok: false, code: 'IA_ATENDENDO', message: 'A IA está atendendo este cliente. Ela libera a conversa quando o cliente pedir para falar com uma pessoa.' };
    }
    const r: any = await db.execute(sql`SELECT target_user_id, exclusivo, status, deadline_at FROM ia_handoff WHERE conversation_id = ${conversationId} LIMIT 1`);
    const h = r.rows?.[0];
    if (!h) return { ok: true };
    if (String(h.status) !== 'waiting') return { ok: true };
    if (!h.exclusivo) return { ok: true };
    const venceu = h.deadline_at ? (new Date(h.deadline_at).getTime() < Date.now()) : false;
    if (venceu) return { ok: true }; // passou o prazo do dono: liberado para os demais
    if (isAdmin) return { ok: true };
    if (h.target_user_id && String(h.target_user_id) === String(userId)) return { ok: true };
    return { ok: false, code: 'CARTEIRA_EXCLUSIVA', message: 'Esta conversa foi transferida para o dono da carteira do cliente e está aguardando o atendimento dele.' };
  } catch { return { ok: true }; } // em erro, nao trava o atendimento
}

// Pode LER esta conversa? Mesma regra da escrita, mas sem a trava da IA
// (acompanhar a conversa da IA e util; escrever nela e que nao pode).
export async function podeLer(conversationId: string, userId: string, role?: string): Promise<Veredito> {
  try {
    const isAdmin = role === 'admin' || role === 'coordinator' || role === 'administrative';
    if (isAdmin) return { ok: true };
    const r: any = await db.execute(sql`SELECT target_user_id, exclusivo, status, deadline_at FROM ia_handoff WHERE conversation_id = ${conversationId} LIMIT 1`);
    const h = r.rows?.[0];
    if (!h || String(h.status) !== 'waiting' || !h.exclusivo) return { ok: true };
    const venceu = h.deadline_at ? (new Date(h.deadline_at).getTime() < Date.now()) : false;
    if (venceu) return { ok: true };
    if (h.target_user_id && String(h.target_user_id) === String(userId)) return { ok: true };
    return { ok: false, code: 'CARTEIRA_EXCLUSIVA', message: 'Conversa reservada para o dono da carteira.' };
  } catch { return { ok: true }; }
}

// Atendente respondeu -> encerra a espera (para o sweep nao repassar).
export async function marcarAtendida(conversationId: string, userId?: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE ia_handoff SET status = 'answered', answered_at = now(), updated_at = now(),
      target_user_id = coalesce(${userId || null}, target_user_id)
      WHERE conversation_id = ${conversationId} AND status = 'waiting'`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Sweep: dono notificado que nao respondeu no prazo perde a vez
// ---------------------------------------------------------------------------

export async function filaTick(): Promise<{ ran: boolean; repassadas: number; detalhes: any[] }> {
  const detalhes: any[] = [];
  let repassadas = 0;
  try {
    if ((await getSetting('ia_front_line', 'off')) !== 'on') return { ran: false, repassadas: 0, detalhes };
    await ensureFilaTable();
    const r: any = await db.execute(sql`SELECT conversation_id, target_agent_id, target_user_id, customer_phone
      FROM ia_handoff WHERE status = 'waiting' AND exclusivo = true AND deadline_at IS NOT NULL AND deadline_at < now()
      ORDER BY deadline_at ASC LIMIT 20`);
    for (const h of (r.rows || []) as any[]) {
      const lista = await agentesDisponiveis(String(h.target_agent_id || ''));
      if (!lista.length) { detalhes.push({ conv: h.conversation_id, resultado: 'sem_outro_online' }); continue; }
      const novo = lista[0];
      await atribuir(String(h.conversation_id), String(novo.agent_id));
      await db.execute(sql`UPDATE ia_handoff SET target_user_id = ${novo.user_id ? String(novo.user_id) : null},
        target_agent_id = ${String(novo.agent_id)}, exclusivo = false, notified_at = now(),
        deadline_at = NULL, updated_at = now() WHERE conversation_id = ${h.conversation_id}`);
      await msgSistema(String(h.conversation_id), `[IA] Sem resposta do dono da carteira no prazo — conversa repassada para ${novo.name}.`);
      await avisarAtendente(novo.phone, novo.name, await nomeDoCliente(String(h.conversation_id)), false);
      repassadas++;
      detalhes.push({ conv: h.conversation_id, para: novo.name });
      console.log(`[IA-FILA] repasse por timeout conv=${h.conversation_id} -> ${novo.name}`);
    }
  } catch (e: any) { console.error('[IA-FILA] tick', e?.message || e); }
  return { ran: true, repassadas, detalhes };
}

// ---------------------------------------------------------------------------
export function registerIaFila(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // A tabela e criada sob demanda (handoffParaHumano/filaTick), NAO no boot:
  // o healthcheck do Railway e curto e o boot deste app ja faz muito trabalho de banco.

  // Diagnostico: conversas aguardando atendimento e quem esta online.
  app.get('/api/admin/ia-atendimento/fila', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const f: any = await db.execute(sql`SELECT h.conversation_id, h.customer_phone, h.owner_user_id, h.target_user_id,
      h.exclusivo, h.status, h.notified_at, h.deadline_at, c.customer_name
      FROM ia_handoff h LEFT JOIN chat_conversations c ON c.id = h.conversation_id
      WHERE h.status = 'waiting' ORDER BY h.notified_at DESC LIMIT 50`);
    res.json({ aguardando: f.rows || [], online: await agentesDisponiveis() });
  });

  // Executa 1 varredura de lembrete de finalizacao agora.
  app.get('/api/admin/ia-atendimento/fila/lembrete', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json(await lembreteTick());
  });

  // Diagnostico do calendario: hoje e dia util? qual o proximo?
  app.get('/api/admin/ia-atendimento/dia-util', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json({ hoje: await ehDiaUtil(), proximo: await proximoDiaUtilTexto(), feriadosExtras: await getSetting('ia_feriados', ''), diasUteis: await getSetting('ia_dias_uteis', '1,2,3,4,5') });
  });

  // Executa 1 varredura de repasse agora.
  app.get('/api/admin/ia-atendimento/fila/run', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    res.json(await filaTick());
  });

  try {
    setTimeout(() => {
      setInterval(() => { filaTick().catch(e => console.error('[IA-FILA]', e?.message || e)); }, 60 * 1000);
    }, 2 * 60 * 1000);
    // Lembrete de finalizacao: varredura mais espacada (5 min).
    setInterval(() => { lembreteTick().catch(e => console.error('[IA-FILA] lembrete', e?.message || e)); }, 5 * 60 * 1000);
  } catch {}

  console.log('[IA-FILA] registrado (repasse dirigido por carteira + timeout + endpoints fila/run)');
}
