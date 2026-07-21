// Runtime dos Agentes de IA do ChatCenter (Honest Sucos / INTEGRA 2.0).
// SEGURANÇA: só responde conforme system_settings 'agents_runtime_mode' (off|test|on).
// Chama Anthropic via fetch puro (sem dependência). Requer ANTHROPIC_API_KEY.
// FERRAMENTAS (tool-use): transferir_humano, buscar_boleto, consultar_debitos, consultar_produto.
import { db } from './db';
import { sql } from 'drizzle-orm';

const APP_URL = process.env.APP_URL || 'https://integracode-production.up.railway.app';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
async function setSetting(key: string, value: string): Promise<void> {
  try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, ${'agent-runtime'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch {}
}

function pickAgentByKeyword(text: string, defId: string): string {
  const t = (text || '').toLowerCase();
  const has = (arr: string[]) => arr.some(k => t.includes(k));
  if (has(['boleto', '2 via', '2a via', 'segunda via', 'pagar', 'pagamento', 'fatura', 'vencid', 'em atraso', 'débito', 'debito', 'cobran', 'pix', 'linha digitável', 'codigo de barras'])) return 'cobranca';
  if (has(['comprar', 'pedido', 'preço', 'preco', 'orçamento', 'orcamento', 'quero', 'valor', 'encomend', 'cardápio', 'cardapio', 'tabela', 'suco'])) return 'vendas';
  return defId;
}

// ===== Ferramentas =====
const TOOL_DEFS: any[] = [
  { name: 'transferir_humano', description: 'Transfere a conversa para um atendente humano quando o cliente pede falar com pessoa, reclama, ou o caso foge do seu escopo. Após chamar, avise o cliente que um atendente vai continuar.', input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'motivo da transferência' } }, required: [] } },
  { name: 'buscar_boleto', description: 'Busca a 2ª via de boleto/cobrança em aberto do cliente. Retorna link de pagamento, valor e vencimento. Use o documento se o cliente informar; senão usa o cliente da conversa.', input_schema: { type: 'object', properties: { documento: { type: 'string', description: 'CPF ou CNPJ (somente se o cliente informar)' } }, required: [] } },
  { name: 'consultar_debitos', description: 'Consulta os débitos/títulos em aberto (vencidos) do cliente. Retorna total e dias de atraso.', input_schema: { type: 'object', properties: { documento: { type: 'string' } }, required: [] } },
  { name: 'consultar_produto', description: 'Consulta preço e disponibilidade de um produto pelo nome/termo.', input_schema: { type: 'object', properties: { termo: { type: 'string', description: 'nome ou parte do nome do produto' } }, required: ['termo'] } },
];

function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function onlyDigits(s: any) { return String(s || '').replace(/\D/g, ''); }

async function resolveCustomerId(ctx: any, documento?: string): Promise<string | null> {
  if (documento) {
    const d = onlyDigits(documento);
    try {
      const r: any = await db.execute(sql`SELECT id FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=${d} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')=${d} LIMIT 1`);
      if (r.rows?.[0]?.id) return r.rows[0].id;
    } catch {}
  }
  return ctx?.customerId || null;
}

async function execTool(name: string, input: any, ctx: any): Promise<string> {
  try {
    if (name === 'transferir_humano') {
      if (ctx?.conversationId) {
        await setSetting('chat_ai_paused:' + ctx.conversationId, '1');
        try { await db.execute(sql`UPDATE chat_conversations SET status='assigned' WHERE id=${ctx.conversationId}`); } catch {}
      }
      return 'OK: conversa transferida para atendimento humano. Pare de responder e informe o cliente que um atendente assumirá em instantes.';
    }
    if (name === 'buscar_boleto') {
      const cid = await resolveCustomerId(ctx, input?.documento);
      if (!cid) return 'Cliente não identificado. Peça o CPF/CNPJ para localizar o boleto.';
      const r: any = await db.execute(sql`SELECT id, valor_original, data_vencimento, status, linha_digitavel FROM boleto_charges WHERE customer_id=${cid} AND COALESCE(status,'') NOT IN ('liquidado','cancelado','pago') ORDER BY created_at DESC LIMIT 1`);
      const b = r.rows?.[0];
      if (!b) return 'Nenhum boleto em aberto encontrado para este cliente.';
      return `Boleto em aberto encontrado. Valor: ${brl(b.valor_original)}; Vencimento: ${b.data_vencimento ? new Date(b.data_vencimento).toLocaleDateString('pt-BR') : '-'}; Link de pagamento (boleto+PIX): ${APP_URL}/api/boleto-view/${b.id} . Envie esse link ao cliente.`;
    }
    if (name === 'consultar_debitos') {
      const cid = await resolveCustomerId(ctx, input?.documento);
      const d = onlyDigits(input?.documento);
      let row: any = null;
      if (cid) { const r: any = await db.execute(sql`SELECT client_name, total_amount, max_days_overdue FROM overdue_debts WHERE client_id=${cid} LIMIT 1`); row = r.rows?.[0]; }
      if (!row && d) { const r: any = await db.execute(sql`SELECT client_name, total_amount, max_days_overdue FROM overdue_debts WHERE regexp_replace(COALESCE(client_document,''),'[^0-9]','','g')=${d} LIMIT 1`); row = r.rows?.[0]; }
      if (!row) return 'Nenhum débito vencido encontrado para este cliente.';
      return `Débitos em aberto: total ${brl(row.total_amount)}; atraso máximo ${row.max_days_overdue || 0} dias.`;
    }
    if (name === 'consultar_produto') {
      const termo = String(input?.termo || '').trim();
      if (!termo) return 'Informe o nome do produto.';
      const _stop = new Set(['de','da','do','com','e','a','o','os','as','para','por','sabor','ml','l','un','und']);
    const _norm = (x: any) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _tokens = _norm(termo).split(/[^0-9a-z]+/).filter((t: string) => t.length >= 2 && !_stop.has(t));
    const _all: any = await db.execute(sql`SELECT name, price, retail_price, resale_goiania_price, stock FROM products WHERE is_active=true ORDER BY name`);
    const _rows0 = (_all.rows || []).filter((p: any) => { const n = _norm(p.name); return _tokens.length ? _tokens.every((t: string) => n.includes(t)) : n.includes(_norm(termo)); }).slice(0, 8);
    const r: any = { rows: _rows0 };
      if (!r.rows?.length) return `Nenhum produto encontrado com "${termo}".`;
      return r.rows.map((p: any) => `${p.name}: varejo ${brl(p.retail_price || p.price)}${p.resale_goiania_price ? '; revenda ' + brl(p.resale_goiania_price) : ''}${p.stock != null ? '; estoque ' + p.stock : ''}`).join(' | ');
    }
    return 'Ferramenta desconhecida.';
  } catch (e: any) { return 'Erro ao executar ferramenta: ' + (e?.message || String(e)).slice(0, 120); }
}

async function callAnthropic(model: string, system: string, messages: any[], tools?: any[]): Promise<{ ok: boolean; status: number; j: any }> {
  const body: any = { model, max_tokens: 1024, system, messages };
  if (tools && tools.length) body.tools = tools;
  const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const j: any = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, j };
}

// Gera resposta. Se ctx (com conversa/cliente) for passado, habilita ferramentas (tool-use loop).
export async function generateAgentReply(agentId: string, messages: Array<{ role: string; content: any }>, ctx?: any): Promise<{ ok: boolean; reply?: string; error?: string; model?: string; usedTools?: string[] }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };
  try {
    const a: any = await db.execute(sql`SELECT id, nome, modelo, system_prompt, base_conhecimento FROM agentes_config WHERE id = ${agentId} LIMIT 1`);
    const agent = a.rows?.[0];
    if (!agent) return { ok: false, error: 'agente nao encontrado' };
    const g: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum' LIMIT 1`);
    const base = g.rows?.[0]?.valor || '';
    const kb = (agent.base_conhecimento || '').trim();
    const systemPrompt = (base ? base + '\n\n' : '')
      + (kb ? '# BASE DE CONHECIMENTO (fatos da Honest — responda so com o que esta aqui; se faltar, ofereca falar com uma pessoa)\n' + kb + '\n\n' : '')
      + (agent.system_prompt || '');
    // normaliza histórico inicial (texto): começa com user, alterna
    const conv: any[] = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof m.content === 'string' ? m.content.trim() : m.content;
      if (typeof content === 'string' && !content) continue;
      if (conv.length && conv[conv.length - 1].role === role && typeof content === 'string' && typeof conv[conv.length - 1].content === 'string') conv[conv.length - 1].content += '\n' + content;
      else conv.push({ role, content });
    }
    while (conv.length && conv[0].role !== 'user') conv.shift();
    if (!conv.length) return { ok: false, error: 'sem mensagem de usuario' };
    const model = normModel(agent.modelo);
    const tools = ctx ? TOOL_DEFS : undefined;
    const usedTools: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { ok, status, j } = await callAnthropic(model, systemPrompt, conv, tools);
      if (!ok) return { ok: false, error: 'anthropic ' + status + ': ' + JSON.stringify(j).slice(0, 200), model };
      const content = j.content || [];
      const toolUses = content.filter((c: any) => c.type === 'tool_use');
      if (j.stop_reason === 'tool_use' && toolUses.length && ctx) {
        conv.push({ role: 'assistant', content });
        const results: any[] = [];
        for (const tu of toolUses) { usedTools.push(tu.name); const out = await execTool(tu.name, tu.input || {}, ctx); results.push({ type: 'tool_result', tool_use_id: tu.id, content: out }); }
        conv.push({ role: 'user', content: results });
        continue;
      }
      const reply = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      return { ok: true, reply, model, usedTools };
    }
    return { ok: true, reply: '', model, usedTools };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

export async function maybeRunAgent(opts: { phone: string; conversationId: string; incomingText: string; sendText: (to: string, text: string) => Promise<any>; channel?: string; username?: string; }): Promise<void> {
  try {
    const channel = (opts.channel || 'whatsapp').toLowerCase();
    const isIG = channel === 'instagram';
    const mode = await getSetting(isIG ? 'agents_ig_mode' : 'agents_runtime_mode', 'off');
    if (mode === 'off') return;
    if (!process.env.ANTHROPIC_API_KEY) return;
    const phone = onlyDigits(opts.phone);
    const handle = (opts.username || '').replace(/^@/, '').trim().toLowerCase();
    if (mode === 'test') {
      if (isIG) {
        const allow = (await getSetting('agents_ig_test_handles', '')).split(/[,;\n\s]+/).map(s => s.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
        if (!allow.length || !handle || !allow.includes(handle)) return;
      } else {
        const allow = (await getSetting('agents_test_numbers', '5562995782812')).split(/[,;\s]+/).map(s => onlyDigits(s)).filter(Boolean);
        if (!allow.includes(phone)) return;
      }
    }
    if (!opts.incomingText || !opts.incomingText.trim()) return;
    // se a conversa foi transferida p/ humano, não responder mais
    if ((await getSetting('chat_ai_paused:' + opts.conversationId, '')) === '1') return;
    const defId = await getSetting(isIG ? 'agents_ig_default' : 'agents_default', isIG ? 'instagram' : 'sdr');
    const routing = await getSetting('agents_routing', 'keyword');
    // contexto do cliente (p/ ferramentas)
    let customerId: string | null = null;
    try { const c: any = await db.execute(sql`SELECT customer_id FROM chat_conversations WHERE id=${opts.conversationId} LIMIT 1`); customerId = c.rows?.[0]?.customer_id || null; } catch {}
    const ctx = { conversationId: opts.conversationId, customerId, phone };
    // histórico recente (10)
    const h: any = await db.execute(sql`SELECT sender_type, content FROM chat_messages WHERE conversation_id = ${opts.conversationId} ORDER BY created_at DESC LIMIT 10`);
    const hist = (h.rows || []).reverse().map((m: any) => ({ role: m.sender_type === 'customer' ? 'user' : 'assistant', content: String(m.content || '') }));
    if (!hist.length || hist[hist.length - 1].role !== 'user') hist.push({ role: 'user', content: opts.incomingText });
    let chosenId = (!isIG && routing === 'keyword') ? pickAgentByKeyword(opts.incomingText, defId) : defId;
    try { const chk: any = await db.execute(sql`SELECT id FROM agentes_config WHERE id = ${chosenId} AND ativo = true LIMIT 1`); if (!chk.rows?.[0]) chosenId = defId; } catch { chosenId = defId; }
    // Resposta a um disparo de rota do dia -> agente "Rota do Dia"
    try {
      const rd: any = await db.execute(sql`SELECT 1 FROM official_dispatches
        WHERE customer_phone = ${phone} AND use_case = 'rota_do_dia'
          AND created_at > now() - interval '24 hours' LIMIT 1`);
      if (rd.rows?.[0]) {
        const ra: any = await db.execute(sql`SELECT id FROM agentes_config
          WHERE id = 'Rota_do_Dia' AND ativo = true LIMIT 1`);
        if (ra.rows?.[0]) chosenId = 'Rota_do_Dia';
      }
    } catch {}
    const gen = await generateAgentReply(chosenId, hist, ctx);
    if (!gen.ok || !gen.reply) return;
    const sent = await opts.sendText(opts.phone, gen.reply);
    try { const { storage } = await import('./storage'); await storage.createChatMessage({ conversationId: opts.conversationId, senderId: 'agent:' + chosenId, senderType: 'system', content: gen.reply, messageType: 'text', metadata: { agent: chosenId, auto: true, tools: gen.usedTools, delivery: sent } as any }); } catch {}
  } catch (e: any) { console.error('[AGENT-RUNTIME]', e?.message || e); }
}
