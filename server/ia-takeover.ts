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
  // Fora do 1841 (ou com a janela fechada), responde pelo Umbler Talk — pelo MESMO numero
  // que o cliente usou. Sem o override, toda resposta saia do numero padrao (2630), mesmo
  // para quem escreveu no 7169.
  let from: string | undefined;
  try {
    const c2: any = await db.execute(sql`SELECT channel_phone FROM chat_conversations WHERE id = ${convId} LIMIT 1`);
    from = c2.rows?.[0]?.channel_phone || undefined;
  } catch {}
  const { sendUmblerTalkText } = await import('./chat-routes');
  return sendUmblerTalkText(toPhone, text, from);
}

// ============================================================================
// MODO "IA NA FRENTE" (ia_front_line)
// A IA atende sozinha desde o primeiro "oi": a conversa NAO entra na fila humana
// (round-robin) enquanto ela estiver atendendo, e so e distribuida no momento em que
// a IA chama transferir_humano. Se um humano escrever mesmo assim, a IA recua daquela
// conversa (quem falou por ultimo entre os nao-clientes deixa de ser 'agent:%').
// ============================================================================

// A IA vai mesmo atender esta conversa agora? Usado pelo webhook para decidir se
// pula a distribuicao. Se qualquer gate estiver fechado, a fila humana funciona
// exatamente como hoje — nenhuma conversa fica orfa.
export async function iaAssumeSozinha(conversationId: string, phone: string): Promise<boolean> {
  try {
    if ((await getSetting('ia_front_line', 'off')) !== 'on') return false;
    const mode = await getSetting('agents_runtime_mode', 'off');
    if (mode === 'off') return false;
    if (mode === 'test') {
      const d = String(phone || '').replace(/\D/g, '');
      const allow = (await getSetting('agents_test_numbers', '')).split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean);
      if (!allow.includes(d)) return false;
    }
    if ((await getSetting('chat_ai_paused:' + conversationId, '')) !== '') return false; // ja transferida
    const { avaliarCanal } = await import('./canais-gestao');
    const av = await avaliarCanal(conversationId);
    return !!(av.ativo && av.iaAtiva && av.dentroHorario);
  } catch { return false; } // na duvida, mantem a fila humana de hoje
}

// Um humano escreveu por ultimo nesta conversa? (mensagens da IA tem sender_id 'agent:%';
// avisos do sistema usam 'system')
async function humanoFalouPorUltimo(conversationId: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT sender_id FROM chat_messages
      WHERE conversation_id = ${conversationId} AND sender_type <> 'customer'
      ORDER BY created_at DESC LIMIT 1`);
    const id = r.rows?.[0]?.sender_id;
    if (!id) return false;
    const sid = String(id);
    return !sid.startsWith('agent:') && sid !== 'system';
  } catch { return false; }
}

// Envio de IMAGEM (QR do PIX). O 1841 nao tem endpoint de midia proprio; como ele tambem e um
// canal do Umbler, a midia sai pelo mesmo numero que o cliente usou (channel_phone da conversa).
async function replyImageVia(convId: string, toPhone: string, url: string, caption?: string): Promise<any> {
  let from: string | undefined;
  try {
    const c: any = await db.execute(sql`SELECT channel_phone FROM chat_conversations WHERE id = ${convId} LIMIT 1`);
    from = c.rows?.[0]?.channel_phone || undefined;
  } catch {}
  const { sendUmblerTalkMedia } = await import('./chat-routes');
  return sendUmblerTalkMedia(toPhone, url, caption || '', from);
}

// Enforcement de canal (painel Gestão de Canais). Decide se a IA pode agir nesta conversa:
//   - canal (número inteiro) precisa estar LIGADO (canal_<n>_ativo);
//   - a IA precisa estar LIGADA naquele canal (ia_canal_<n>; mesmas chaves do painel Fase 1);
//   - precisa estar DENTRO DO HORÁRIO de atividade (dias + início/fim, fuso de Brasília).
// Fora do horário: envia o aviso automático 1x (throttle de 4h por conversa) e NÃO aciona a IA.
async function canalLiberaIA(conversationId: string, toPhone: string): Promise<boolean> {
  try {
    const { avaliarCanal, podeEnviarForaMsg, registrarForaMsgEnviado } = await import('./canais-gestao');
    const av = await avaliarCanal(conversationId);
    if (!av.ativo) return false;    // canal inteiro desligado
    if (!av.iaAtiva) return false;  // IA desligada neste canal
    if (!av.dentroHorario) {        // fora do horário -> aviso automático 1x, sem IA
      if (av.foraMsg && (await podeEnviarForaMsg(conversationId))) {
        try { await replyVia(conversationId, toPhone, av.foraMsg); await registrarForaMsgEnviado(conversationId); } catch {}
      }
      return false;
    }
    return true;
  } catch { return true; } // em qualquer erro, não trava o atendimento
}

// Decide se o disparo IMEDIATO (inbound) deve rodar agora. Ver regras no cabeçalho.
export async function shouldRespondNow(conversationId: string): Promise<boolean> {
  try {
    // Modo "IA na frente": se um humano interveio nesta conversa, a IA sai dela
    // (evita os dois respondendo o mesmo cliente).
    if ((await getSetting('ia_front_line', 'off')) === 'on' && (await humanoFalouPorUltimo(conversationId))) return false;
    if ((await getSetting('ia_regra_timeout_on', 'off')) !== 'on') return true; // regra off -> comportamento atual
    const r: any = await db.execute(sql`SELECT sender_id, sender_type FROM chat_messages
      WHERE conversation_id = ${conversationId} AND sender_type <> 'customer'
      ORDER BY created_at DESC LIMIT 1`);
    const row = r.rows?.[0];
    // IA já falou por último entre os não-clientes -> ela assumiu, continua respondendo na hora.
    return !!(row && typeof row.sender_id === 'string' && row.sender_id.startsWith('agent:'));
  } catch { return true; } // em qualquer erro, mantém o comportamento atual (não trava o atendimento)
}

// Cliente tocou no primeiro botao do template de aviso: agradece e ENCERRA a conversa.
// Devolve true quando tratou a mensagem (a IA nao deve mais responder nada).
async function encerrarPeloBotao(conversationId: string, phone: string, texto: string): Promise<boolean> {
  try {
    const { botaoDeEncerramento } = await import('./official-templates');
    const resposta = await botaoDeEncerramento(phone, texto);
    if (!resposta) return false;

    await replyVia(conversationId, phone, resposta);
    try {
      await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
        VALUES (${conversationId}, 'agent:sistema', 'agent', ${resposta}, 'text', true)`);
    } catch {}
    await db.execute(sql`UPDATE chat_conversations SET status = 'resolved', updated_at = now() WHERE id = ${conversationId}`);
    try { const { liberarIA } = await import('./ia-fila'); await liberarIA(conversationId); } catch {}
    try { await db.execute(sql`DELETE FROM chat_conversation_labels WHERE conversation_id = ${conversationId}`); } catch {}
    console.log(`[ENCERRA-BOTAO] conversa ${conversationId} encerrada — cliente respondeu o botao de confirmacao`);
    return true;
  } catch (e: any) {
    console.error('[ENCERRA-BOTAO]', e?.message || e);
    return false;   // qualquer erro: segue o fluxo normal da IA
  }
}

// Gatilho REATIVO do WhatsApp (chamado pelo webhook ao vivo /api/chat/webhook/messages).
// A IA reativa oficial passa a ser a NOVA (Agentes de IA / Claude, mesmo motor do Instagram).
// O porteiro shouldRespondNow aplica a regra de takeover: se ligada e a IA ainda não assumiu,
// espera o humano (o sweep assume em X min); se a IA já assumiu, responde na hora.
// maybeRunAgent reaplica canal/modo/allowlist/paused — cliente real protegido em modo test.
export async function reactiveInbound(conversationId: string, phone: string, incomingText: string): Promise<void> {
  try {
    if (!incomingText || !incomingText.trim()) return;
    if (!(await canalLiberaIA(conversationId, phone))) return; // liga/desliga por número (2630/1841)
    // Botao 1 do template de aviso ("Ok, obrigado.") = assunto encerrado. Agradece e finaliza,
    // em vez de mandar a saudacao padrao e reabrir uma conversa que ja tinha acabado.
    // Resposta ao aviso de VISITA (rota do dia): "Sim, confirmar" / "Nao" / 1-2-3.
    // Vira decisao registrada e resposta pronta — a IA nao precisa adivinhar o contexto.
    try {
      const { respostaDaRota } = await import('./rota-respostas');
      const rr = await respostaDaRota(phone, incomingText);
      if (rr) {
        await replyVia(conversationId, phone, rr);
        try {
          await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
            VALUES (${conversationId}, 'agent:rota', 'agent', ${rr}, 'text', true)`);
        } catch {}
        return;
      }
    } catch (e: any) { console.error('[ROTA-RESPOSTA]', e?.message || e); }

    if (await encerrarPeloBotao(conversationId, phone, incomingText)) return;
    if (!(await shouldRespondNow(conversationId))) return;
    const { maybeRunAgent } = await import('./agent-runtime');
    await maybeRunAgent({
      phone,
      conversationId,
      incomingText,
      sendText: (to: string, text: string) => replyVia(conversationId, to, text),
      sendImage: (url: string) => replyImageVia(conversationId, phone, url),
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
      if (!(await canalLiberaIA(row.id, row.customer_phone))) continue; // liga/desliga por número (2630/1841)
      // maybeRunAgent aplica: agents_runtime_mode (off/test/on), allowlist de teste, chat_ai_paused,
      // escolha do agente por palavra-chave, roteamento Rota_do_Dia e loop de ferramentas — igual ao IG.
      await maybeRunAgent({
        phone: row.customer_phone,
        conversationId: row.id,
        incomingText: String(row.last_text || ''),
        sendText: (to: string, text: string) => replyVia(row.id, to, text),
        sendImage: (url: string) => replyImageVia(row.id, row.customer_phone, url),
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

  // Retomar a IA numa conversa transferida para humano (limpa chat_ai_paused).
  //   ?conv=<id>  -> limpa aquela conversa
  //   ?todas=1    -> limpa todas as pausas LEGADAS (valor '1', que nunca expiravam)
  app.get('/api/admin/ia-atendimento/retomar', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const conv = String(req.query.conv || '').trim();
    const todas = String(req.query.todas || '') === '1';
    if (!conv && !todas) return res.status(400).json({ error: 'informe ?conv=<id> ou ?todas=1' });
    const { limparPausa } = await import('./agent-runtime');
    const n = await limparPausa(conv || undefined);
    res.json({ ok: true, limpas: n, escopo: conv ? conv : 'legadas' });
  });

  // Quantas conversas estao pausadas hoje (diagnostico).
  app.get('/api/admin/ia-atendimento/pausadas', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const r: any = await db.execute(sql`SELECT count(*) FILTER (WHERE value = '1') AS legadas,
                                               count(*) FILTER (WHERE value <> '1') AS com_data,
                                               count(*) AS total
                                        FROM system_settings WHERE key LIKE 'chat_ai_paused:%'`);
    res.json(r.rows?.[0] || {});
  });

  // Varredura automática a cada 1 min (para o takeover reagir perto do limite de X min).
  try {
    setInterval(() => { takeoverTick(false).catch(e => console.error('[IA-TAKEOVER]', e?.message || e)); }, 60 * 1000);
  } catch {}

  console.log('[IA-TAKEOVER] registrado (regra #2 assumir após X min; sweep 1min + endpoints preview/run)');
}
