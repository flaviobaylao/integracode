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

// Consulta as conversas elegíveis para finalização (WhatsApp, inativas, sem humano).
async function selectElegiveis(mins: number, limit: number): Promise<Array<{ id: string; customer_phone: string }>> {
  const q: any = await db.execute(sql`
    SELECT c.id, c.customer_phone
    FROM chat_conversations c
    LEFT JOIN chat_customers cu ON cu.id = c.customer_id
    WHERE c.customer_phone IS NOT NULL
      AND c.customer_phone NOT LIKE 'ig:%'
      AND c.customer_phone NOT LIKE '%@g.us%'
      AND coalesce(cu.tags, '') NOT LIKE '%grupo%'
      AND c.status <> 'resolved'
      AND c.last_message_time IS NOT NULL
      AND c.last_message_time < now() - make_interval(mins => ${mins})
      AND (c.last_attended_at IS NULL OR c.last_attended_at < now() - make_interval(mins => ${mins}))
    ORDER BY c.last_message_time ASC
    LIMIT ${limit}`);
  return (q.rows || []) as any;
}

// Um "tick" da varredura. Respeita os gates. Retorna um resumo do que fez.
export async function finalizarTick(force = false): Promise<{ ran: boolean; reason?: string; mode?: string; encerradas: number; enviadas: number; puladasTeste: number; detalhes: any[] }> {
  const on = (await getSetting('ia_regra_finalizar_on', 'off')) === 'on';
  if (!on && !force) return { ran: false, reason: 'regra_off', encerradas: 0, enviadas: 0, puladasTeste: 0, detalhes: [] };
  const waMode = await getSetting('agents_runtime_mode', 'off');
  if (waMode === 'off' && !force) return { ran: false, reason: 'canal_off', encerradas: 0, enviadas: 0, puladasTeste: 0, detalhes: [] };

  const mins = Math.max(1, parseInt(await getSetting('ia_finalizar_min', '120'), 10) || 120);
  const despedida = (await getSetting('ia_despedida', DEFAULT_DESPEDIDA)).slice(0, 500);
  const tests = testPhones();
  const rows = await selectElegiveis(mins, 20);

  let encerradas = 0, enviadas = 0, puladasTeste = 0;
  const detalhes: any[] = [];
  for (const row of rows) {
    const phoneDigits = normalizeBrPhone(row.customer_phone);
    // Em modo test (ou force sem canal on), só age nos números de teste; clientes reais ficam intactos.
    if ((waMode === 'test' || (force && waMode !== 'on')) && !tests.includes(phoneDigits)) {
      puladasTeste++;
      continue;
    }
    const sent = await sendDespedida(row.id, row.customer_phone, despedida);
    if (sent.ok) enviadas++;
    try {
      await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
        VALUES (${row.id}, 'system', 'system', ${'[IA · finalização] ' + despedida}, 'text', true)`);
    } catch {}
    await db.execute(sql`UPDATE chat_conversations SET status = 'resolved', updated_at = now() WHERE id = ${row.id}`);
    encerradas++;
    detalhes.push({ conv: row.id, phone: phoneDigits, via: sent.via, enviado: sent.ok, erro: sent.error || null });
    console.log(`[IA-FINALIZAR] conv=${row.id} phone=${phoneDigits} via=${sent.via} ok=${sent.ok} mode=${waMode}`);
  }
  return { ran: true, mode: waMode, encerradas, enviadas, puladasTeste, detalhes };
}

export function registerIaFinalizar(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;

  // Prévia (não age): mostra quantas conversas SERIAM finalizadas agora, sem enviar nada.
  app.get('/api/admin/ia-atendimento/finalizar/preview', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const on = (await getSetting('ia_regra_finalizar_on', 'off')) === 'on';
    const waMode = await getSetting('agents_runtime_mode', 'off');
    const mins = Math.max(1, parseInt(await getSetting('ia_finalizar_min', '120'), 10) || 120);
    const rows = await selectElegiveis(mins, 50);
    const tests = testPhones();
    const amostra = rows.slice(0, 20).map((r: any) => {
      const p = normalizeBrPhone(r.customer_phone);
      return { conv: r.id, phone: p, ehTeste: tests.includes(p) };
    });
    res.json({ regra: on ? 'on' : 'off', canal: waMode, inatividadeMin: mins, elegiveis: rows.length, amostra });
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
