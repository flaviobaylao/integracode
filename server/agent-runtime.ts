// Runtime dos Agentes de IA do ChatCenter (Honest Sucos / INTEGRA 2.0).
// SEGURANÇA: só responde conforme system_settings 'agents_runtime_mode':
//   'off'  (padrão) = nunca responde
//   'test' = responde apenas números em 'agents_test_numbers'
//   'on'   = responde todos os clientes
// Chama a API da Anthropic via fetch puro (sem dependência). Requer ANTHROPIC_API_KEY.
import { db } from './db';
import { sql } from 'drizzle-orm';

function normModel(m?: string): string {
  const x = (m || '').trim();
  if (x.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5-20251001';
  if (x.startsWith('claude-opus-4-8')) return 'claude-opus-4-8';
  if (x.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
  return 'claude-sonnet-4-6';
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

// Gera a resposta de um agente para um histórico/mensagem (sem enviar). Reutilizável p/ teste.
export async function generateAgentReply(agentId: string, messages: Array<{ role: string; content: string }>): Promise<{ ok: boolean; reply?: string; error?: string; model?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };
  try {
    const a: any = await db.execute(sql`SELECT id, nome, modelo, system_prompt, ativo FROM agentes_config WHERE id = ${agentId} LIMIT 1`);
    const agent = a.rows?.[0];
    if (!agent) return { ok: false, error: 'agente nao encontrado' };
    const g: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum' LIMIT 1`);
    const base = g.rows?.[0]?.valor || '';
    const systemPrompt = (base ? base + '\n\n' : '') + (agent.system_prompt || '');
    // normaliza messages: começa com user, alterna (mescla consecutivos do mesmo papel)
    const norm: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = String(m.content || '').trim();
      if (!content) continue;
      if (norm.length && norm[norm.length - 1].role === role) norm[norm.length - 1].content += '\n' + content;
      else norm.push({ role, content });
    }
    while (norm.length && norm[0].role !== 'user') norm.shift();
    if (!norm.length) return { ok: false, error: 'sem mensagem de usuario' };
    const model = normModel(agent.modelo);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages: norm }),
    });
    const j: any = await resp.json();
    if (!resp.ok) return { ok: false, error: 'anthropic ' + resp.status + ': ' + JSON.stringify(j).slice(0, 200), model };
    const reply = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
    return { ok: true, reply, model };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

// Roteamento por palavras-chave: escolhe o agente conforme o conteúdo recente.
// Configurável por system_settings 'agents_routing' = 'keyword' (padrão) ou 'fixed' (usa sempre o default).
function pickAgentByKeyword(text: string, defId: string): string {
  const t = (text || '').toLowerCase();
  const has = (arr: string[]) => arr.some(k => t.includes(k));
  if (has(['boleto', '2 via', '2a via', 'segunda via', 'pagar', 'pagamento', 'fatura', 'vencid', 'em atraso', 'débito', 'debito', 'cobran', 'pix', 'linha digitável', 'codigo de barras'])) return 'cobranca';
  if (has(['comprar', 'pedido', 'preço', 'preco', 'orçamento', 'orcamento', 'quero', 'valor', 'encomend', 'cardápio', 'cardapio', 'tabela', 'suco'])) return 'vendas';
  return defId;
}

// Chamado pelo webhook após salvar mensagem RECEBIDA (não fromMe). Fire-and-forget.
export async function maybeRunAgent(opts: { phone: string; conversationId: string; incomingText: string; sendText: (to: string, text: string) => Promise<any>; }): Promise<void> {
  try {
    const mode = await getSetting('agents_runtime_mode', 'off');
    if (mode === 'off') return;
    if (!process.env.ANTHROPIC_API_KEY) return;
    const phone = (opts.phone || '').replace(/\D/g, '');
    if (mode === 'test') {
      const allow = (await getSetting('agents_test_numbers', '5562995782812')).split(/[,;\s]+/).map(s => s.replace(/\D/g, '')).filter(Boolean);
      if (!allow.includes(phone)) return;
    }
    if (!opts.incomingText || !opts.incomingText.trim()) return;
    const defId = await getSetting('agents_default', 'sdr');
    const routing = await getSetting('agents_routing', 'keyword');
    // histórico recente (10) p/ contexto
    const h: any = await db.execute(sql`SELECT sender_type, content FROM chat_messages WHERE conversation_id = ${opts.conversationId} ORDER BY created_at DESC LIMIT 10`);
    const hist = (h.rows || []).reverse().map((m: any) => ({ role: m.sender_type === 'customer' ? 'user' : 'assistant', content: String(m.content || '') }));
    if (!hist.length || hist[hist.length - 1].role !== 'user') hist.push({ role: 'user', content: opts.incomingText });
    // Roteamento: escolhe o agente pelo conteúdo (cobranca/vendas) ou usa o default (sdr). Só agentes ATIVOS.
    let chosenId = routing === 'keyword' ? pickAgentByKeyword(opts.incomingText, defId) : defId;
    try {
      const chk: any = await db.execute(sql`SELECT id FROM agentes_config WHERE id = ${chosenId} AND ativo = true LIMIT 1`);
      if (!chk.rows?.[0]) chosenId = defId;
    } catch { chosenId = defId; }
    const gen = await generateAgentReply(chosenId, hist);
    if (!gen.ok || !gen.reply) return;
    const sent = await opts.sendText(opts.phone, gen.reply);
    try {
      const { storage } = await import('./storage');
      await storage.createChatMessage({ conversationId: opts.conversationId, senderId: 'agent:' + chosenId, senderType: 'system', content: gen.reply, messageType: 'text', metadata: { agent: chosenId, auto: true, delivery: sent } as any });
    } catch {}
  } catch (e: any) { console.error('[AGENT-RUNTIME]', e?.message || e); }
}
