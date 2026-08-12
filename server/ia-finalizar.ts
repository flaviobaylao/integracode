// ============================================================================
// INTEGRA 2.0 — IA de Atendimento · Fase 2: finalização de conversas inativas
// Espelha a varredura do Instagram (instagram-routes.ts), mas para o WhatsApp e
// com uma MENSAGEM DE DESPEDIDA antes de encerrar (decisão #3 do Flavio).
// Self-contained (SQL cru, mesmo padrão do official-dispatch.ts / agent-runtime.ts).
// Wiring em server/index.ts:
//   import { registerIaFinalizar } from "./ia-finalizar";
//   registerIaFinalizar(app);
//
// Gates (lidos do system_settings, editáveis no painel da Fase 1):
//   ia_regra_finalizar_on : 'on'|'off'  -> liga/desliga esta regra (default off)
//   ia_finalizar_min      : minutos de inatividade antes de encerrar (default 120)
//   ia_despedida          : texto enviado ao cliente antes de encerrar
//   agents_runtime_mode   : 'off'|'test'|'on' -> canal WhatsApp da IA
//        off  -> não faz nada
//        test -> só age nos números de INTEGRA_OFICIAL_TEST_PHONES (clientes reais intactos)
//        on   -> age em todos os clientes reais elegíveis
//
// Escopo: encerra conversas de WhatsApp (não Instagram, não grupos) que estão INATIVAS
// há X min — considerando TANTO a última mensagem quanto a última interação do atendente
// (last_attended_at). Inclui conversas atribuídas a um humano que ficaram ociosas, mas
// nunca encerra uma em que o cliente OU o atendente interagiram dentro da janela de X min.
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

function testPhones(): string[] {
  return (process.env.INTEGRA_OFICIAL_TEST_PHONES || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
}
function normalizeBrPhone(toPhone: string): string {
  let d = String(toPhone || '').replace(/\D/g, '');
  if (d && !d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d;
}

const DEFAULT_DESPEDIDA = 'Foi um prazer falar com voce! Qualquer coisa e so chamar aqui. 🧡';

// Envia a despedida reaproveitando EXATAMENTE a lógica do replyVia (chat-routes.ts):
// 1841 (texto livre) se a janela de 24h estiver aberta; senão 2630 (Umbler Talk).
async function sendDespedida(convId: string, toPhone: string, text: string): Promise<{ ok: boolean; via: string; error?: string }> {
  try {
    const c: any = await db.execute(sql`SELECT last_inbound_channel, window_open_until FROM chat_conversations WHERE id = ${convId} LIMIT 1`);
    const row = c.rows?.[0];
    if (row && row.last_inbound_channel === 'oficial_1841' && row.window_open_until && new Date(row.window_open_until) > new Date()) {
      try {
        const { sendOfficialText } = await import('./official-dispatch');
        const r = await sendOfficialText(toPhone, text);
        if (r && r.success) return { ok: true, via: '1841' };
      } catch {}
    }
  } catch {}
  try {
    const { sendUmblerTalkText } = await import('./chat-routes');
    const r = await sendUmblerTalkText(toPhone, text);
    return { ok: !!(r && r.success), via: '2630', error: r && (r as any).error };
  } catch (e: any) {
    return { ok: false, via: '2630', error: e?.message || String(e) };
  }
}

// ⏰ RELOGIO UNIFICADO (Fase 3 do fuso). chat_conversations.last_message_time,
// .last_attended_at e .updated_at ERAM gravados com nowBrazil() — hora de parede de
// Brasilia numa coluna sem fuso — e por isso todo leitor tinha de comparar com
// (now() AT TIME ZONE 'America/Sao_Paulo') em vez de now(). Isso quebrava com quem
// gravava certo: o Instagram gravava new Date() (UTC) na mesma coluna, e a conversa
// nascia 3h "no futuro" — nunca era lembrada nem finalizada.
// Agora a coluna guarda o INSTANTE em UTC, como todo o resto do sistema, e a comparacao
// e com now() puro. Ver shared/tempo.ts.
const AGORA_BR = sql`now()`;

// Consulta as conversas elegíveis para finalização (WhatsApp, inativas, sem humano).
async function selectElegiveis(mins: number, limit: number, minsAtendente: number): Promise<Array<{ id: string; customer_phone: string }>> {
  const q: any = await db.execute(sql`
    SELECT c.id, c.customer_phone
    FROM chat_conversations c
    LEFT JOIN chat_customers cu ON cu.id = c.customer_id
    WHERE c.customer_phone IS NOT NULL
      AND c.customer_phone NOT LIKE 'ig:%'
      AND c.customer_phone NOT LIKE '%@g.us%'
      AND coalesce(cu.tags, '') NOT LIKE '%grupo%'
      AND c.status <> 'resolved'
      -- Conversa do ATENDENTE (aberta por ele ou transferida pela IA) tem prazo proprio:
      -- nao fecha junto com as da IA, mas tambem nao fica aberta para sempre. Passa a
      -- fechar depois de chat_close_atendente_min (padrao 60) sem ninguem falar nada.
      AND (
        (coalesce(c.initiated_by::text, 'customer') <> 'user'
         AND NOT EXISTS (SELECT 1 FROM system_settings s WHERE s.key = 'ia_transferida:' || c.id))
        OR (c.last_message_time < ${AGORA_BR} - make_interval(mins => ${minsAtendente})
            AND (c.last_attended_at IS NULL OR c.last_attended_at < ${AGORA_BR} - make_interval(mins => ${minsAtendente})))
      )
      -- Ninguem — nem cliente, nem atendente, nem IA — escreveu nada nos ultimos X min.
      -- last_message_time sozinho nao bastava: mensagem enviada pelo painel nem sempre o
      -- atualiza, e a conversa "viva" era encerrada por baixo do atendente.
      AND NOT EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > now() - make_interval(mins => ${mins}))
      AND c.last_message_time IS NOT NULL
      AND c.last_message_time < ${AGORA_BR} - make_interval(mins => ${mins})
      AND (c.last_attended_at IS NULL OR c.last_attended_at < ${AGORA_BR} - make_interval(mins => ${mins}))
    ORDER BY c.last_message_time ASC
    LIMIT ${limit}`);
  return (q.rows || []) as any;
}

// ---------------------------------------------------------------------------
// Trava de despedida repetida.
// O cliente da POLIBELT recebeu "Atendimento finalizado..." tres vezes: a varredura
// daqui e o job antigo do scheduler.ts (closeInactiveConversations) fechavam a MESMA
// conversa, cada um mandando o seu texto — e, quando a conversa reabria, o proximo tick
// mandava de novo. Despedida e uma so: por conversa (enquanto o cliente nao voltar a
// falar) e por telefone (janela de espera, para nao pegar duas conversas do mesmo numero).
// ---------------------------------------------------------------------------

// Ja nos despedimos nesta conversa e o cliente nao falou nada depois disso?
async function jaSeDespediu(convId: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`
      SELECT 1 FROM chat_messages m
      WHERE m.conversation_id = ${convId}
        AND m.content LIKE '[IA · finalização]%'
        AND m.created_at > COALESCE((
              SELECT max(created_at) FROM chat_messages
              WHERE conversation_id = ${convId} AND sender_type = 'customer'
            ), to_timestamp(0))
      LIMIT 1`);
    return !!r.rows?.length;
  } catch { return false; }
}

// Mesmo numero, outra conversa: espera a janela antes de mandar outra despedida.
async function despedidaRecenteNoFone(digits: string, minutos: number): Promise<boolean> {
  if (!digits) return false;
  const chave = 'ia_despedida_fone:' + digits.slice(-8);
  const v = await getSetting(chave, '');
  if (!v) return false;
  const t = new Date(v).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) < minutos * 60 * 1000;
}
async function marcarDespedidaNoFone(digits: string): Promise<void> {
  if (!digits) return;
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
      VALUES (${'ia_despedida_fone:' + digits.slice(-8)}, ${new Date().toISOString()}, 'ia-finalizar')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

// Um "tick" da varredura. Respeita os gates. Retorna um resumo do que fez.
export async function finalizarTick(force = false): Promise<{ ran: boolean; reason?: string; mode?: string; encerradas: number; enviadas: number; puladasTeste: number; puladasRepetida?: number; detalhes: any[] }> {
  const on = (await getSetting('ia_regra_finalizar_on', 'off')) === 'on';
  if (!on && !force) return { ran: false, reason: 'regra_off', encerradas: 0, enviadas: 0, puladasTeste: 0, detalhes: [] };
  const waMode = await getSetting('agents_runtime_mode', 'off');
  if (waMode === 'off' && !force) return { ran: false, reason: 'canal_off', encerradas: 0, enviadas: 0, puladasTeste: 0, detalhes: [] };

  const mins = Math.max(1, parseInt(await getSetting('ia_finalizar_min', '120'), 10) || 120);
  const despedida = (await getSetting('ia_despedida', DEFAULT_DESPEDIDA)).slice(0, 500);
  const tests = testPhones();
  // Prazo proprio da conversa em andamento com atendente (padrao 60 min).
  const minsAtendente = Math.max(5, parseInt(await getSetting('chat_close_atendente_min', '60'), 10) || 60);
  const rows = await selectElegiveis(mins, 20, minsAtendente);

  // Janela minima entre duas despedidas para o MESMO telefone (padrao: a propria
  // inatividade, no minimo 60 min).
  const minsFone = Math.max(30, parseInt(await getSetting('ia_despedida_cooldown_min', String(Math.max(60, mins))), 10) || 60);

  let encerradas = 0, enviadas = 0, puladasTeste = 0, puladasRepetida = 0;
  const detalhes: any[] = [];
  for (const row of rows) {
    const phoneDigits = normalizeBrPhone(row.customer_phone);
    // Em modo test (ou force sem canal on), só age nos números de teste; clientes reais ficam intactos.
    const { telefoneNaLista } = await import('./ia-fila');
    if ((waMode === 'test' || (force && waMode !== 'on')) && !telefoneNaLista(phoneDigits, tests.join(','))) {
      puladasTeste++;
      continue;
    }
    // Ja se despediu aqui (ou no mesmo numero, ha pouco): FECHA a conversa em silencio.
    // Fechar sem mandar nada e o certo — senao a conversa fica eternamente elegivel e a
    // varredura seguinte tentaria mandar a despedida outra vez.
    const repetida = (await jaSeDespediu(row.id)) || (await despedidaRecenteNoFone(phoneDigits, minsFone));
    if (repetida) {
      await db.execute(sql`UPDATE chat_conversations SET status = 'resolved', updated_at = now() WHERE id = ${row.id}`);
      try { const { liberarIA } = await import('./ia-fila'); await liberarIA(String(row.id)); } catch { /* noop */ }
      try { await db.execute(sql`DELETE FROM chat_conversation_labels WHERE conversation_id = ${row.id}`); } catch {}
      encerradas++; puladasRepetida++;
      detalhes.push({ conv: row.id, phone: phoneDigits, via: '-', enviado: false, motivo: 'despedida ja enviada' });
      console.log(`[IA-FINALIZAR] conv=${row.id} phone=${phoneDigits} encerrada SEM despedida (ja enviada)`);
      continue;
    }

    const sent = await sendDespedida(row.id, row.customer_phone, despedida);
    if (sent.ok) enviadas++;
    try {
      await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
        VALUES (${row.id}, 'system', 'system', ${'[IA · finalização] ' + despedida}, 'text', true)`);
    } catch {}
    if (sent.ok) await marcarDespedidaNoFone(phoneDigits);
    await db.execute(sql`UPDATE chat_conversations SET status = 'resolved', updated_at = now() WHERE id = ${row.id}`);
    try { const { liberarIA } = await import('./ia-fila'); await liberarIA(String(row.id)); } catch { /* noop */ }
    try { await db.execute(sql`DELETE FROM chat_conversation_labels WHERE conversation_id = ${row.id}`); } catch {}
    encerradas++;
    detalhes.push({ conv: row.id, phone: phoneDigits, via: sent.via, enviado: sent.ok, erro: sent.error || null });
    console.log(`[IA-FINALIZAR] conv=${row.id} phone=${phoneDigits} via=${sent.via} ok=${sent.ok} mode=${waMode}`);
  }
  return { ran: true, mode: waMode, encerradas, enviadas, puladasTeste, puladasRepetida, detalhes };
}

export function registerIaFinalizar(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // Prévia (não age): mostra quantas conversas SERIAM finalizadas agora, sem enviar nada.
  app.get('/api/admin/ia-atendimento/finalizar/preview', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const on = (await getSetting('ia_regra_finalizar_on', 'off')) === 'on';
    const waMode = await getSetting('agents_runtime_mode', 'off');
    const mins = Math.max(1, parseInt(await getSetting('ia_finalizar_min', '120'), 10) || 120);
    // O 3o argumento faltava aqui: make_interval(mins => NULL) fazia a previa explodir.
    const minsAtendente = Math.max(5, parseInt(await getSetting('chat_close_atendente_min', '60'), 10) || 60);
    const rows = await selectElegiveis(mins, 50, minsAtendente);
    const tests = testPhones();
    const amostra = rows.slice(0, 20).map((r: any) => {
      const p = normalizeBrPhone(r.customer_phone);
      return { conv: r.id, phone: p, ehTeste: tests.includes(p) };
    });
    // Diagnostico de relogio: se "defasagem_min" nao for ~0, a coluna e o now() do banco
    // estao em fusos diferentes de novo e TODA conversa volta a parecer parada.
    let relogio: any = null;
    try {
      const t: any = await db.execute(sql`SELECT
        to_char(now(), 'DD/MM HH24:MI') AS now_utc,
        to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS now_br,
        to_char(max(c.last_message_time), 'DD/MM HH24:MI') AS msg_mais_recente,
        round(EXTRACT(EPOCH FROM (now() - max(c.last_message_time))) / 60) AS defasagem_min
        FROM chat_conversations c WHERE c.last_message_time IS NOT NULL`);
      relogio = t.rows?.[0] || null;
    } catch {}
    res.json({ regra: on ? 'on' : 'off', canal: waMode, inatividadeMin: mins, elegiveis: rows.length, relogio, amostra });
  });

  // Executa 1 varredura AGORA (respeita gates). ?force=1 ignora os gates mas mantém a proteção
  // de test (só números de teste) enquanto o canal não estiver em ON.
  app.get('/api/admin/ia-atendimento/finalizar/run', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const force = String(req.query.force || '') === '1';
    const out = await finalizarTick(force);
    res.json(out);
  });

  // Varredura automática a cada 5 min (mesma ideia do sweep do Instagram, que roda a cada 10 min).
  try {
    setInterval(() => { finalizarTick(false).catch(e => console.error('[IA-FINALIZAR]', e?.message || e)); }, 5 * 60 * 1000);
  } catch {}

  console.log('[IA-FINALIZAR] registrado (regra #3 finalização + despedida; sweep 5min + endpoints preview/run)');
}
