// ============================================================================
// INTEGRA 2.0 — IA de Atendimento · Fase 3: takeover (assumir após X min)
// Regra #2: se o cliente escreve, há vendedores no ChatCenter mas NINGUÉM responde
// em X min (ia_timeout_min), a IA ASSUME a conversa e segue o atendimento — usando o
// MESMO motor da IA do Instagram (maybeRunAgent). Uma vez assumida, a IA passa a
// responder na hora as próximas mensagens (igual ao Instagram).
//
// Self-contained. Wiring em server/index.ts:
//   import { registerIaTakeover } from "./ia-takeover";
//   registerIaTakeover(app);
// E no chat-routes.ts o disparo imediato passa por shouldRespondNow() (ver abaixo).
//
// Gates (system_settings, editáveis no painel da Fase 1):
//   ia_regra_timeout_on : 'on'|'off'  -> liga/desliga a regra de takeover (default off)
//   ia_timeout_min      : minutos sem resposta antes de assumir (default 10)
//   agents_runtime_mode : 'off'|'test'|'on' -> canal WhatsApp da IA (o próprio maybeRunAgent
//                         reaplica esse gate + a allowlist de teste; cliente real nunca é
//                         respondido em modo test)
//
// COMO shouldRespondNow DECIDE o disparo imediato (chamado pelo chat-routes no inbound):
//   - regra timeout OFF  -> true (comportamento atual: front-line imediato, inalterado)
//   - regra timeout ON:
//       * última msg não-cliente foi da IA ('agent:%')  -> true  (IA já assumiu, continua na hora)
//       * senão (humano respondeu por último, ou ninguém) -> false (espera o humano; o sweep assume em X min)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

// Envia reaproveitando a lógica do replyVia (chat-routes.ts): 1841 (texto livre) se a janela
// de 24h estiver aberta; senão 2630 (Umbler Talk). Mesmo caminho que a IA já usa hoje.
async function replyVia(convId: string, toPhone: string, text: string): Promise<any> {
  try {
    const c: any = await db.execute(sql`SELECT last_inbound_channel, window_open_until FROM chat_conversations WHERE id = ${convId} LIMIT 1`);
    const row = c.rows?.[0];
    if (row && row.last_inbound_channel === 'oficial_1841' && row.window_open_until && new Date(row.window_open_until) > new Date()) {
      try {
        const { sendOfficialText } = await import('./official-dispatch');
        const r = await sendOfficialText(toPhone, text);
        if (r && r.success) return r;
      } catch {}
    }
  } catch {}
  const { sendUmblerTalkText } = await import('./chat-routes');
  return sendUmblerTalkText(toPhone, text);
}

// Decide se o disparo IMEDIATO (inbound) deve rodar agora. Ver regras no cabeçalho.
export async function shouldRespondNow(conversationId: string): Promise<boolean> {
  try {
    if ((await getSetting('ia_regra_timeout_on', 'off')) !== 'on') return true; // regra off -> comportamento atual
    const r: any = await db.execute(sql`SELECT sender_id, sender_type FROM chat_messages
      WHERE conversation_id = ${conversationId} AND sender_type <> 'customer'
      ORDER BY created_at DESC LIMIT 1`);
    const row = r.rows?.[0];
    // IA já falou por último entre os não-clientes -> ela assumiu, continua respondendo na hora.
    return !!(row && typeof row.sender_id === 'string' && row.sender_id.startsWith('agent:'));
  } catch { return true; } // em qualquer erro, mantém o comportamento atual (não trava o atendimento)
}

// Gatilho REATIVO do WhatsApp (chamado pelo webhook ao vivo /api/chat/webhook/messages).
// A IA reativa oficial passa a ser a NOVA (Agentes de IA / Claude, mesmo motor do Instagram).
// O porteiro shouldRespondNow aplica a regra de takeover: se ligada e a IA ainda não assumiu,
// espera o humano (o sweep assume em X min); se a IA já assumiu, responde na hora.
// maybeRunAgent reaplica canal/modo/allowlist/paused — cliente real protegido em modo test.
export async function reactiveInbound(conversationId: string, phone: string, incomingText: string): Promise<void> {
  try {
    if (!incomingText || !incomingText.trim()) return;
    if (!(await shouldRespondNow(conversationId))) return;
    const { maybeRunAgent } = await import('./agent-runtime');
    await maybeRunAgent({
      phone,
      conversationId,
      incomingText,
      sendText: (to: string, text: string) => replyVia(conversationId, to, text),
      channel: 'whatsapp',
    });
  } catch (e: any) { console.error('[IA-REACTIVE]', e?.message || e); }
}

// Candidatos ao takeover: conversa de WhatsApp cuja ÚLTIMA mensagem é do cliente, sem resposta
// de ninguém há >= mins, dentro de uma janela de frescor (evita disparar em backlog antigo ao ligar),
// não pausada e não resolvida.
async function selectTakeover(mins: number, teto: number, limit: number): Promise<Array<{ id: string; customer_phone: string; last_text: string }>> {
  const q: any = await db.execute(sql`
    SELECT c.id, c.customer_phone, m.content AS last_text
    FROM chat_conversations c
    JOIN LATERAL (
      SELECT sender_type, content, created_at FROM chat_messages
      WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
    ) m ON true
    LEFT JOIN chat_customers cu ON cu.id = c.customer_id
    WHERE c.customer_phone IS NOT NULL
      AND c.customer_phone NOT LIKE 'ig:%'
      AND c.customer_phone NOT LIKE '%@g.us%'
      AND coalesce(cu.tags, '') NOT LIKE '%grupo%'
      AND c.status <> 'resolved'
      AND m.sender_type = 'customer'
      AND m.created_at < now() - make_interval(mins => ${mins})
      AND m.created_at > now() - make_interval(mins => ${teto})
      AND NOT EXISTS (SELECT 1 FROM system_settings s WHERE s.key = ${'chat_ai_paused:'} || c.id AND s.value = '1')
    ORDER BY m.created_at ASC
    LIMIT ${limit}`);
  return (q.rows || []) as any;
}

// Um "tick" do takeover. Respeita os gates. O próprio maybeRunAgent reaplica mode/allowlist/paused,
// então cliente real NUNCA é respondido em modo test (defesa em profundidade).
export async function takeoverTick(force = false): Promise<{ ran: boolean; reason?: string; mode?: string; candidatos: number; assumidas: number; detalhes: any[] }> {
  const on = (await getSetting('ia_regra_timeout_on', 'off')) === 'on';
  if (!on && !force) return { ran: false, reason: 'regra_off', candidatos: 0, assumidas: 0, detalhes: [] };
  const mode = await getSetting('agents_runtime_mode', 'off');
  if (mode === 'off' && !force) return { ran: false, reason: 'canal_off', candidatos: 0, assumidas: 0, detalhes: [] };

  const mins = Math.max(1, parseInt(await getSetting('ia_timeout_min', '10'), 10) || 10);
  const teto = mins + 180; // janela de frescor: só assume mensagens de até ~3h atrás (evita backlog antigo ao ligar)
  const rows = await selectTakeover(mins, teto, 8);

  let assumidas = 0;
  const detalhes: any[] = [];
  const { maybeRunAgent } = await import('./agent-runtime');
  for (const row of rows) {
    try {
      // maybeRunAgent aplica: agents_runtime_mode (off/test/on), allowlist de teste, chat_ai_paused,
      // escolha do agente por palavra-chave, roteamento Rota_do_Dia e loop de ferramentas — igual ao IG.
      await maybeRunAgent({
        phone: row.customer_phone,
        conversationId: row.id,
        incomingText: String(row.last_text || ''),
        sendText: (to: string, text: string) => replyVia(row.id, to, text),
        channel: 'whatsapp',
      });
      assumidas++;
      detalhes.push({ conv: row.id });
      console.log(`[IA-TAKEOVER] conv=${row.id} assumida (mode=${mode})`);
    } catch (e: any) {
      console.error('[IA-TAKEOVER] item', row.id, e?.message || e);
    }
  }
  return { ran: true, mode, candidatos: rows.length, assumidas, detalhes };
}

export function registerIaTakeover(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // Prévia (não age): quantas conversas SERIAM assumidas agora.
  app.get('/api/admin/ia-atendimento/takeover/preview', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const on = (await getSetting('ia_regra_timeout_on', 'off')) === 'on';
    const mode = await getSetting('agents_runtime_mode', 'off');
    const mins = Math.max(1, parseInt(await getSetting('ia_timeout_min', '10'), 10) || 10);
    const rows = await selectTakeover(mins, mins + 180, 50);
    res.json({ regra: on ? 'on' : 'off', canal: mode, timeoutMin: mins, candidatos: rows.length, amostra: rows.slice(0, 20).map((r: any) => ({ conv: r.id })) });
  });

  // Executa 1 varredura AGORA (respeita gates). ?force=1 ignora os gates deste módulo, mas o
  // maybeRunAgent ainda reaplica o gate de canal/test — cliente real segue protegido em modo test.
  app.get('/api/admin/ia-atendimento/takeover/run', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const force = String(req.query.force || '') === '1';
    res.json(await takeoverTick(force));
  });

  // Varredura automática a cada 1 min (para o takeover reagir perto do limite de X min).
  try {
    setInterval(() => { takeoverTick(false).catch(e => console.error('[IA-TAKEOVER]', e?.message || e)); }, 60 * 1000);
  } catch {}

  console.log('[IA-TAKEOVER] registrado (regra #2 assumir após X min; sweep 1min + endpoints preview/run)');
}
