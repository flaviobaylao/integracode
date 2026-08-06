// ============================================================================
// INTEGRA 2.0 — Diagnóstico de webhooks de RECEBIMENTO (Umbler Talk)
// Mostra, dos últimos eventos gravados em webhook_debug_log, QUAL canal enviou
// (Channel.Id), o telefone do contato, a direção (Source) e o tipo — sem máscara —
// para diagnosticar por que o 1841 (canal oficial) não chega ao ChatCenter.
// Wiring em server/index.ts:
//   import { registerIaDiag } from "./ia-diag";
//   registerIaDiag(app);
// Acesso: /api/admin/ia-atendimento/diag-webhooks?k=SENHA (se OFICIAL_ADMIN_KEY setada)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// IDs conhecidos de canais (para rotular). 1841 oficial = ajqNf-Vjp4yjcaJf (UMBLER_OFFICIAL_CHANNEL_ID).
const CHANNEL_LABELS: Record<string, string> = {
  'ajqNf-Vjp4yjcaJf': '1841 (HONESTAPI oficial)',
};

async function _get(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

export function registerIaDiag(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  app.get('/api/admin/ia-atendimento/diag-webhooks', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const n = Math.min(200, Math.max(5, parseInt(String(req.query.n || '80'), 10) || 80));
    let rows: any[] = [];
    try {
      const r: any = await db.execute(sql`SELECT id, created_at, LEFT(raw_payload, 40000) AS raw
        FROM webhook_debug_log ORDER BY created_at DESC LIMIT ${n}`);
      rows = r.rows || [];
    } catch (e: any) { return res.status(500).json({ error: e?.message || String(e) }); }

    const porCanal: Record<string, number> = {};
    const amostra: any[] = [];
    for (const row of rows) {
      let p: any = null;
      try { p = JSON.parse(row.raw); } catch { continue; }
      const content = (p.Payload && p.Payload.Content) || (p.payload && p.payload.content) || null;
      if (!content) continue;
      const ch = content.Channel || content.channel || {};
      const chId = ch.Id || ch.id || null;
      const chPhone = ch.PhoneNumber || ch.phoneNumber || ch.Phone || null;
      const contact = content.Contact || content.contact || {};
      const phone = contact.PhoneNumber || contact.phoneNumber || contact.Phone || null;
      const lm = content.LastMessage || content.lastMessage || {};
      const source = lm.Source || lm.source || null;
      const mtype = lm.MessageType || lm.messageType || null;
      const key = (chId || 'sem-canal') + (chPhone ? ' / ' + chPhone : '');
      porCanal[key] = (porCanal[key] || 0) + 1;
      if (amostra.length < 25) {
        amostra.push({
          at: row.created_at,
          canalId: chId,
          canalLabel: (chId && CHANNEL_LABELS[chId]) || null,
          canalPhone: chPhone,
          contatoPhone: phone,
          source,
          type: p.Type || null,
          msgType: mtype,
        });
      }
    }
    res.json({ analisados: rows.length, porCanal, amostra });
  });

  // ---------------------------------------------------------------------------
  // "Por que a IA nao respondeu?" — abre TODAS as portas que a mensagem atravessa,
  // conversa por conversa, com o veredito de cada uma. Sem isto so restava adivinhar
  // qual regra estava barrando (e ja errei assim antes: testei por curl, nunca pelo
  // caminho de verdade). ?phone=5562... para um numero; sem phone, as ultimas conversas.
  // ---------------------------------------------------------------------------
  app.get('/api/admin/ia-atendimento/porque-nao-respondeu', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const fone = String(req.query.phone || '').replace(/\D/g, '');
      const lim = Math.min(20, Math.max(1, parseInt(String(req.query.n || '8'), 10) || 8));
      const mins = Math.max(5, parseInt(await _get('ia_respeita_atendente_min', '60'), 10) || 60);
      const respeita = (await _get('ia_respeita_atendente', 'on')) === 'on';

      const q: any = await db.execute(sql`
        SELECT c.id, c.customer_phone, c.customer_name, c.status,
               coalesce(c.initiated_by::text, 'customer') AS origem,
               c.assigned_agent_id,
               to_char(c.last_message_time, 'DD/MM HH24:MI') AS ult_msg,
               EXISTS (SELECT 1 FROM system_settings s WHERE s.key = 'ia_transferida:' || c.id) AS transferida,
               EXISTS (SELECT 1 FROM system_settings s WHERE s.key = 'chat_ai_paused:' || c.id) AS pausada,
               EXISTS (SELECT 1 FROM system_settings s WHERE s.key = 'ia_robo_avisado:' || c.id) AS robo,
               EXISTS (SELECT 1 FROM chat_messages m
                       WHERE m.conversation_id = c.id AND m.sender_type <> 'customer'
                         AND coalesce(m.sender_id,'') NOT LIKE 'agent:%'
                         AND coalesce(m.sender_id,'') <> 'system'
                         AND m.created_at > now() - make_interval(mins => ${mins})) AS humano_recente,
               (SELECT to_char(max(m.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
                  FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_type = 'customer') AS ult_cliente,
               (SELECT to_char(max(m.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
                  FROM chat_messages m WHERE m.conversation_id = c.id AND coalesce(m.sender_id,'') LIKE 'agent:%') AS ult_ia
        FROM chat_conversations c
        WHERE (${fone} = '' OR right(c.customer_phone, 8) = right(${fone}, 8))
          AND c.customer_phone NOT LIKE 'ig:%'
        ORDER BY c.last_message_time DESC NULLS LAST
        LIMIT ${lim}`);

      const itens = (q.rows || []).map((c: any) => {
        const portas: string[] = [];
        if (String(c.status) === 'resolved') portas.push('conversa finalizada (so reabre quando o cliente escrever)');
        if (respeita && String(c.origem) === 'user') portas.push('conversa INICIADA PELO ATENDENTE — a IA nao entra (regra de origem)');
        if (respeita && c.transferida) portas.push('conversa TRANSFERIDA pela IA para um humano');
        if (respeita && c.humano_recente) portas.push('humano escreveu ha menos de ' + mins + ' min');
        if (c.pausada) portas.push('IA pausada nesta conversa (chat_ai_paused)');
        if (c.robo) portas.push('detector de robo: aguardando um humano');
        return {
          conv: c.id, cliente: c.customer_name, fone: c.customer_phone, status: c.status,
          origem: c.origem, dono: c.assigned_agent_id, ult_msg: c.ult_msg,
          ult_cliente: c.ult_cliente, ult_ia: c.ult_ia,
          iaResponde: portas.length === 0,
          portasFechadas: portas,
        };
      });
      const total = itens.length;
      const barradas = itens.filter((i: any) => !i.iaResponde).length;
      const motivos: Record<string, number> = {};
      for (const i of itens) for (const p of i.portasFechadas) motivos[p] = (motivos[p] || 0) + 1;
      res.json({ regras: { ia_respeita_atendente: respeita ? 'on' : 'off', janela_min: mins },
                 resumo: { conversas: total, barradas, motivos }, itens });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ---------------------------------------------------------------------------
  // Ensaio: roda o MESMO caminho de uma mensagem que chega, porta por porta, e no fim
  // chama o modelo de verdade — mas NAO envia nada ao cliente. E o unico jeito honesto de
  // saber onde a resposta morre: ler o codigo so mostra o que deveria acontecer.
  //   /api/admin/ia-atendimento/testar-resposta?phone=5562...&texto=oi
  // ---------------------------------------------------------------------------
  app.get('/api/admin/ia-atendimento/testar-resposta', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const passos: any[] = [];
    try {
      const fone = String(req.query.phone || '').replace(/\D/g, '');
      const texto = String(req.query.texto || 'oi, tudo bem?');
      if (!fone) return res.status(400).json({ error: 'informe ?phone=' });

      const c: any = await db.execute(sql`SELECT id, customer_id, customer_phone, status,
          coalesce(initiated_by::text,'customer') AS origem
        FROM chat_conversations WHERE right(customer_phone, 8) = right(${fone}, 8)
        ORDER BY last_message_time DESC NULLS LAST LIMIT 1`);
      const conv = c.rows?.[0];
      if (!conv) return res.json({ erro: 'nenhuma conversa para esse numero', passos });
      passos.push({ passo: 'conversa', ok: true, detalhe: { id: conv.id, status: conv.status, origem: conv.origem } });

      const { avaliarCanal } = await import('./canais-gestao');
      const av = await avaliarCanal(String(conv.id));
      passos.push({ passo: 'canal', ok: !!(av.ativo && av.iaAtiva && av.dentroHorario), detalhe: av });

      const modo = await _get('agents_runtime_mode', 'off');
      passos.push({ passo: 'modo_whatsapp', ok: modo !== 'off', detalhe: { modo, testNumbers: await _get('agents_test_numbers', '') } });
      passos.push({ passo: 'anthropic_key', ok: !!process.env.ANTHROPIC_API_KEY,
        detalhe: { presente: !!process.env.ANTHROPIC_API_KEY, tamanho: (process.env.ANTHROPIC_API_KEY || '').length } });

      const pausada: any = await db.execute(sql`SELECT 1 FROM system_settings WHERE key = ${'chat_ai_paused:' + conv.id} LIMIT 1`);
      passos.push({ passo: 'ia_pausada', ok: !pausada.rows?.length, detalhe: { pausada: !!pausada.rows?.length } });

      // Agente escolhido + chamada real ao modelo (sem enviar nada ao cliente).
      const defId = await _get('agents_default', 'sdr');
      const a: any = await db.execute(sql`SELECT id, nome, modelo, ativo FROM agentes_config WHERE id = ${defId} LIMIT 1`);
      passos.push({ passo: 'agente', ok: !!a.rows?.[0]?.ativo, detalhe: a.rows?.[0] || { id: defId, achou: false } });

      // A cadeia do reactiveInbound: cada handler que pode responder no lugar da IA ou
      // simplesmente encerrar o processamento. E aqui que a resposta some sem log.
      const ult: any = await db.execute(sql`SELECT sender_id, sender_type, LEFT(content, 60) AS txt,
          to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando
        FROM chat_messages WHERE conversation_id = ${conv.id} AND sender_type <> 'customer'
        ORDER BY created_at DESC LIMIT 1`);
      const u = ult.rows?.[0];
      const sid = String(u?.sender_id || '');
      const humanoUltimo = !!sid && !sid.startsWith('agent:') && sid !== 'system';
      const frontLine = (await _get('ia_front_line', 'off')) === 'on';
      passos.push({ passo: 'ia_front_line (humano falou por ultimo)', ok: !(frontLine && humanoUltimo),
        detalhe: { ia_front_line: frontLine ? 'on' : 'off', ultimaNaoCliente: u || null, humanoUltimo,
                   nota: 'sem janela de tempo: com front_line on, um humano que falou por ultimo tira a IA da conversa ate ela ser finalizada' } });

      const roboAv: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${'ia_robo_avisado:' + conv.id} LIMIT 1`);
      passos.push({ passo: 'detector_robo', ok: !roboAv.rows?.length,
        detalhe: { jaAvisado: !!roboAv.rows?.length, nota: 'depois de avisado, a IA fica em silencio nesta conversa (sem expiracao)' } });

      try {
        const { respostaDeCobranca } = await import('./promessa-pagamento');
        const rc = await respostaDeCobranca(fone, texto);
        passos.push({ passo: 'previsao_pagamento', ok: !rc, detalhe: { interceptou: !!rc, texto: (rc || '').slice(0, 120) } });
      } catch (e: any) { passos.push({ passo: 'previsao_pagamento', ok: true, detalhe: { erro: e?.message } }); }
      try {
        const { respostaDaRota } = await import('./rota-respostas');
        const rr = await respostaDaRota(fone, texto);
        passos.push({ passo: 'resposta_rota', ok: !rr, detalhe: { interceptou: !!rr, texto: (rr || '').slice(0, 120) } });
      } catch (e: any) { passos.push({ passo: 'resposta_rota', ok: true, detalhe: { erro: e?.message } }); }
      try {
        const { botaoDeEncerramento } = await import('./official-templates');
        const be = await botaoDeEncerramento(fone, texto);
        passos.push({ passo: 'botao_encerramento', ok: !be, detalhe: { interceptou: !!be } });
      } catch (e: any) { passos.push({ passo: 'botao_encerramento', ok: true, detalhe: { erro: e?.message } }); }

      const { generateAgentReply } = await import('./agent-runtime');
      const t0 = Date.now();
      const gen = await generateAgentReply(defId, [{ role: 'user', content: texto }], {
        conversationId: String(conv.id), customerId: conv.customer_id, phone: fone, channel: 'whatsapp',
        sendText: async () => ({ dry: true }), sendImage: async () => ({ dry: true }),
      });
      passos.push({ passo: 'modelo', ok: !!gen.ok, ms: Date.now() - t0,
        detalhe: { erro: gen.error || null, modelo: gen.model || null, tools: gen.usedTools || [], resposta: (gen.reply || '').slice(0, 400) } });

      // O ULTIMO trecho que faltava: o envio. maybeRunAgent so grava a mensagem da IA
      // DEPOIS de mandar; se o transporte falha, nao sobra nem log nem mensagem — parece
      // "a IA nao respondeu". Aqui o transporte e testado de verdade, e so para os numeros
      // de teste (agents_test_numbers): nenhum cliente recebe nada.
      let envio: any = { testado: false };
      if (String(req.query.enviar || '') === '1') {
        const permitidos = (await _get('agents_test_numbers', '')).split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean);
        const { telefoneNaLista } = await import('./ia-fila');
        if (!telefoneNaLista(fone, permitidos.join(','))) {
          envio = { testado: false, motivo: 'numero fora de agents_test_numbers — envio de teste bloqueado' };
        } else {
          const w: any = await db.execute(sql`SELECT last_inbound_channel, channel_phone,
              to_char(window_open_until AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS janela,
              (window_open_until > now()) AS janela_aberta
            FROM chat_conversations WHERE id = ${conv.id} LIMIT 1`);
          const rota = w.rows?.[0] || {};
          let r: any = null, erro: string | null = null;
          try {
            if (rota.last_inbound_channel === 'oficial_1841' && rota.janela_aberta) {
              const { sendOfficialText } = await import('./official-dispatch');
              r = await sendOfficialText(fone, '[teste INTEGRA] ' + (gen.reply || 'ping'));
              r = { via: '1841', ...(r || {}) };
            } else {
              const { sendUmblerTalkText } = await import('./chat-routes');
              r = await sendUmblerTalkText(fone, '[teste INTEGRA] ' + (gen.reply || 'ping'), rota.channel_phone || undefined);
              r = { via: '2630/umbler', ...(r || {}) };
            }
          } catch (e: any) { erro = e?.message || String(e); }
          envio = { testado: true, rota, resultado: r, erro };
          passos.push({ passo: 'envio', ok: !!(r && r.success), detalhe: envio });
        }
      }

      const parou = passos.find(p => p.ok === false);
      res.json({ enviou: !!envio.testado, veredito: parou ? ('parou em: ' + parou.passo) : 'todas as portas abertas — a IA responderia', envio, passos });
    } catch (e: any) {
      passos.push({ passo: 'excecao', ok: false, detalhe: e?.message || String(e) });
      res.status(500).json({ error: e?.message || String(e), passos });
    }
  });


  // A trilha crua: o que aconteceu com CADA mensagem que entrou de verdade.
  app.get('/api/admin/ia-atendimento/trilha', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      const fone = String(req.query.phone || '').replace(/\D/g, '');
      const n = Math.min(200, Math.max(5, parseInt(String(req.query.n || '60'), 10) || 60));
      const r: any = await db.execute(sql`SELECT
          to_char(criado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS quando,
          telefone, porta, detalhe, LEFT(texto, 80) AS texto, conversation_id AS conv
        FROM ia_trilha
        WHERE (${fone} = '' OR right(telefone, 8) = right(${fone}, 8))
        ORDER BY criado_at DESC LIMIT ${n}`);
      const linhas = r.rows || [];
      const porPorta: Record<string, number> = {};
      for (const l of linhas as any[]) porPorta[l.porta] = (porPorta[l.porta] || 0) + 1;
      res.json({ total: linhas.length, porPorta, linhas });
    } catch (e: any) { res.json({ erro: e?.message || String(e), nota: 'a tabela ia_trilha nasce na primeira mensagem apos o deploy' }); }
  });

  console.log('[IA-DIAG] registrado (diag-webhooks + porque-nao-respondeu + testar-resposta + trilha)');
}
