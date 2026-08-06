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

      const { generateAgentReply } = await import('./agent-runtime');
      const t0 = Date.now();
      const gen = await generateAgentReply(defId, [{ role: 'user', content: texto }], {
        conversationId: String(conv.id), customerId: conv.customer_id, phone: fone, channel: 'whatsapp',
        sendText: async () => ({ dry: true }), sendImage: async () => ({ dry: true }),
      });
      passos.push({ passo: 'modelo', ok: !!gen.ok, ms: Date.now() - t0,
        detalhe: { erro: gen.error || null, modelo: gen.model || null, tools: gen.usedTools || [], resposta: (gen.reply || '').slice(0, 400) } });

      const parou = passos.find(p => p.ok === false);
      res.json({ enviou: false, veredito: parou ? ('parou em: ' + parou.passo) : 'todas as portas abertas — a IA responderia', passos });
    } catch (e: any) {
      passos.push({ passo: 'excecao', ok: false, detalhe: e?.message || String(e) });
      res.status(500).json({ error: e?.message || String(e), passos });
    }
  });

  console.log('[IA-DIAG] registrado (diag-webhooks + porque-nao-respondeu + testar-resposta)');
}
