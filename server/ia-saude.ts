// ============================================================================
// INTEGRA 2.0 — Saúde dos agentes de IA (vigia + fallback humano)
//
// Origem: entre 25/09 e 11/10/2026 a API da Anthropic recusou TODA chamada
// ("credit balance is too low") — 6.268 falhas, 72 conversas de clientes sem
// resposta, e ninguém foi avisado. O cliente só recebia "Atendimento finalizado"
// duas horas depois. Este módulo fecha os dois buracos:
//
//   1. alertarFalhaIA()  — chamado pelo agent-runtime quando o modelo não responde:
//      avisa o CLIENTE uma vez por conversa (texto fixo, sem modelo), transfere a
//      conversa para um humano pela fila (ia-fila.handoffParaHumano) e avisa o
//      gestor no WhatsApp (com trava de 30 min para não virar spam).
//   2. verificarSaudeAgentes() — cron de 10 em 10 min: lê mkt_agent_runs; se nos
//      últimos 30 min houve >= N falhas e NENHUM sucesso, manda o erro ao gestor
//      (trava de 2 h). Quando volta a funcionar, avisa uma vez que normalizou.
//
// Gates (system_settings):
//   ia_saude_alerta_ativo    'on'|'off' (default on)
//   ia_saude_min_falhas      nº mínimo de falhas em 30 min (default 10)
//   ia_saude_alerta_last     carimbo do último alerta (trava)
//   ia_saude_estado          'ok'|'falhando' (p/ avisar a volta)
//   ia_falha_msg_cliente     texto enviado ao cliente quando a IA cai
//   gestor_whatsapp          destinatários (CSV) — o mesmo das outras rotinas
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
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'ia-saude')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

const MSG_CLIENTE_PADRAO = 'Recebemos sua mensagem! Nosso atendimento automatico esta indisponivel neste momento, mas um atendente da Honest vai te responder em instantes. 🧡';

function resumirErro(e?: string | null): string {
  const s = String(e || '').trim();
  if (!s) return 'sem detalhe';
  const m = s.match(/"message":"([^"]{5,160})/);
  return (m ? m[1] : s).slice(0, 160);
}

async function destinatariosGestor(): Promise<string[]> {
  const csv = await getSetting('gestor_whatsapp', '5562995782812');
  const list = csv.split(',').map(x => x.replace(/\D/g, '')).filter(x => x.length >= 10);
  return list.length ? list : ['5562995782812'];
}

// Envia um texto a todos os gestores pelo Umbler Talk. Nunca lança.
export async function avisarGestor(texto: string): Promise<{ enviados: number; falhas: number }> {
  let enviados = 0, falhas = 0;
  try {
    const { sendUmblerTalkText } = await import('./chat-routes');
    for (const to of await destinatariosGestor()) {
      try {
        const r = await sendUmblerTalkText(to, texto);
        if (r && r.success) enviados++; else falhas++;
      } catch { falhas++; }
      await new Promise(r => setTimeout(r, 400));
    }
  } catch (e: any) { console.error('[IA-SAUDE] avisarGestor', e?.message || e); }
  return { enviados, falhas };
}

// Trava genérica por chave: devolve true se já passou `minutos` desde o último carimbo.
async function travaLiberada(chave: string, minutos: number): Promise<boolean> {
  const v = await getSetting(chave, '');
  const t = v ? new Date(v).getTime() : 0;
  if (t && Date.now() - t < minutos * 60 * 1000) return false;
  await setSetting(chave, new Date().toISOString());
  return true;
}

// ---------------------------------------------------------------------------
// 1) Fallback quando o modelo NÃO responde a uma mensagem de cliente.
// ---------------------------------------------------------------------------
export async function alertarFalhaIA(opts: {
  conversationId: string;
  phone: string;
  erro?: string | null;
  incomingText?: string;
  sendText?: (to: string, text: string) => Promise<any>;
}): Promise<void> {
  const { conversationId, phone } = opts;
  const erro = resumirErro(opts.erro);
  // (a) avisa o cliente UMA vez por conversa a cada 60 min — texto fixo, sem modelo.
  try {
    if (opts.sendText && (await travaLiberada('ia_falha_cliente:' + conversationId, 60))) {
      const texto = (await getSetting('ia_falha_msg_cliente', MSG_CLIENTE_PADRAO)).slice(0, 500);
      let sent: any = null;
      try { sent = await opts.sendText(phone, texto); } catch (e: any) { sent = { error: e?.message || String(e) }; }
      try {
        await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read, metadata)
          VALUES (${conversationId}, 'system', 'system', ${'[IA · indisponível] ' + texto}, 'text', true, ${JSON.stringify({ auto: true, fallback: 'ia_falha', erro, delivery: sent })}::jsonb)`);
      } catch {}
    }
  } catch (e: any) { console.error('[IA-SAUDE] aviso cliente', e?.message || e); }

  try { const { espelharConversa } = await import('./ia-espelho'); await espelharConversa({ conversationId, phone, cliente: opts.incomingText, ia: '(sem resposta do modelo — aviso fixo + fila humana)', agente: 'saude', nota: 'ERRO: ' + erro }); } catch {}
  // (b) transfere para humano pela fila (dono da carteira → padrão → rodízio).
  try {
    const { handoffParaHumano } = await import('./ia-fila');
    await handoffParaHumano(conversationId, phone, 'IA indisponivel: ' + erro);
  } catch (e: any) { console.error('[IA-SAUDE] handoff', e?.message || e); }

  // (c) avisa o gestor (trava de 30 min — o cron de saúde cobre o resto).
  try {
    if ((await getSetting('ia_saude_alerta_ativo', 'on')) === 'on' && (await travaLiberada('ia_saude_alerta_last', 30))) {
      await setSetting('ia_saude_estado', 'falhando');
      await avisarGestor(`⚠️ *IA do WhatsApp sem resposta*\nUm cliente escreveu e o agente nao conseguiu responder.\nErro: ${erro}\nA conversa foi encaminhada a um atendente humano. Se o erro for de credito/chave da API, corrija em console.anthropic.com.`);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 2) Vigia periódico sobre mkt_agent_runs.
// ---------------------------------------------------------------------------
export async function verificarSaudeAgentes(force = false): Promise<any> {
  const ativo = (await getSetting('ia_saude_alerta_ativo', 'on')) === 'on';
  if (!ativo && !force) return { ran: false, reason: 'off' };
  const minFalhas = Math.max(3, parseInt(await getSetting('ia_saude_min_falhas', '10'), 10) || 10);
  let total = 0, ok = 0, falhas = 0, erro = '';
  try {
    const r: any = await db.execute(sql`
      SELECT count(*)::int AS total,
             sum(CASE WHEN sucesso THEN 1 ELSE 0 END)::int AS ok,
             (SELECT erro FROM mkt_agent_runs WHERE criado_em > now() - interval '30 minutes' AND NOT sucesso AND erro IS NOT NULL ORDER BY criado_em DESC LIMIT 1) AS ultimo_erro
      FROM mkt_agent_runs WHERE criado_em > now() - interval '30 minutes'`);
    const row = r.rows?.[0] || {};
    total = Number(row.total || 0); ok = Number(row.ok || 0); falhas = total - ok; erro = resumirErro(row.ultimo_erro);
  } catch (e: any) { return { ran: false, reason: 'sql: ' + (e?.message || e) }; }

  const estado = await getSetting('ia_saude_estado', 'ok');
  const falhando = falhas >= minFalhas && ok === 0;
  let acao = 'nada';
  if (falhando) {
    if (await travaLiberada('ia_saude_alerta_last', 120)) {
      await setSetting('ia_saude_estado', 'falhando');
      await avisarGestor(`🚨 *Agentes de IA FORA DO AR*\n${falhas} chamadas falharam nos ultimos 30 min, nenhuma com sucesso.\nErro: ${erro}\nClientes que escreverem recebem um aviso e vao para atendente humano. Se for credito/chave da API Anthropic, corrija em console.anthropic.com > Plans & Billing.`);
      acao = 'alertou';
    } else acao = 'em_trava';
  } else if (estado === 'falhando' && ok > 0) {
    await setSetting('ia_saude_estado', 'ok');
    await setSetting('ia_saude_alerta_last', '');
    await avisarGestor(`✅ *Agentes de IA normalizados*\n${ok} respostas com sucesso nos ultimos 30 min.`);
    acao = 'normalizou';
  }
  return { ran: true, total, ok, falhas, minFalhas, estado: falhando ? 'falhando' : 'ok', ultimoErro: erro, acao };
}

export function registerIaSaude(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  // Estado atual (read-only) + ?run=1 executa a verificação agora.
  app.get('/api/admin/ia-saude', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const r = await verificarSaudeAgentes(req.query.run === '1');
    res.json({ ...r, ativo: await getSetting('ia_saude_alerta_ativo', 'on'), estadoGravado: await getSetting('ia_saude_estado', 'ok'), ultimoAlerta: await getSetting('ia_saude_alerta_last', '') });
  });
  // Liga/desliga + mensagem ao cliente.
  app.post('/api/admin/ia-saude/config', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    if (typeof b.ativo === 'boolean') await setSetting('ia_saude_alerta_ativo', b.ativo ? 'on' : 'off');
    if (typeof b.minFalhas === 'number') await setSetting('ia_saude_min_falhas', String(b.minFalhas));
    if (typeof b.msgCliente === 'string' && b.msgCliente.trim()) await setSetting('ia_falha_msg_cliente', b.msgCliente.trim().slice(0, 500));
    res.json({ ok: true, ativo: await getSetting('ia_saude_alerta_ativo', 'on'), minFalhas: await getSetting('ia_saude_min_falhas', '10'), msgCliente: await getSetting('ia_falha_msg_cliente', MSG_CLIENTE_PADRAO) });
  });
  try {
    setTimeout(() => {
      setInterval(() => { verificarSaudeAgentes().catch(e => console.error('[IA-SAUDE]', e?.message || e)); }, 10 * 60 * 1000);
    }, 3 * 60 * 1000);
  } catch {}
  console.log('[IA-SAUDE] registrado (vigia 10 min + fallback humano quando a IA nao responde)');
}
