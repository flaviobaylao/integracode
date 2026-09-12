// ============================================================================
// CENTRAL DE MARKETING — chamada de modelo para agentes de marketing (cron)
// ----------------------------------------------------------------------------
// Os agentes de atendimento usam generateAgentReply (conversa + tools de venda).
// Os agentes de marketing (radar, conteudo, revisor, visao, analista...) rodam
// por cron, sem conversa, com JSON estruturado de saida e tools proprias. Este
// modulo e o caminho unico deles:
//   - le modelo / prompt / base_conhecimento / teto em agentes_config (a linha e
//     criada aqui se nao existir — prompt e teto ficam editaveis em /admin/agentes)
//   - respeita agentes_config.ferramentas (lista nao vazia restringe)
//   - loop de tool-use (max 4 rodadas), com tools passadas por quem chama
//   - imagem (visao) opcional
//   - registra tokens/custo em mkt_agent_runs com gatilho 'cron'|'api'
//   - para no teto diario, como o runtime de atendimento
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export type ToolDef = { name: string; description: string; input_schema: any; run: (input: any) => Promise<string> };

export type Chamada = {
  agente: string;                 // id em agentes_config
  nome?: string;                  // nome amigavel se a linha precisar ser criada
  promptPadrao?: string;          // system_prompt se a linha precisar ser criada
  modeloPadrao?: string;          // 'claude-sonnet-4-6' | 'claude-haiku-4-5'
  tetoPadrao?: number;            // R$/dia se a linha precisar ser criada
  systemExtra?: string;           // vai depois do prompt do agente (fatos, cartao...)
  user: string;
  imagem?: { base64: string; mime: string };
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  gatilho?: string;
  entradaRef?: string | null;
};

export type Resposta = { ok: boolean; texto?: string; json?: any; erro?: string; modelo: string; tokensIn: number; tokensOut: number; rodadas: number; ferramentas: string[] };

function normModel(m?: string): string {
  const x = (m || '').trim();
  if (x.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5-20251001';
  if (x.startsWith('claude-opus-4-8')) return 'claude-opus-4-8';
  return 'claude-sonnet-4-6';
}

export async function garantirAgenteConfig(c: { agente: string; nome?: string; promptPadrao?: string; modeloPadrao?: string; tetoPadrao?: number }): Promise<void> {
  try {
    try { await db.execute(sql.raw("ALTER TABLE agentes_config ADD COLUMN IF NOT EXISTS teto_custo_dia numeric(10,2)")); } catch {}
    await db.execute(sql`
      INSERT INTO agentes_config (id, nome, modelo, system_prompt, ferramentas, limites, ativo, base_conhecimento, teto_custo_dia)
      VALUES (${c.agente}, ${c.nome || c.agente}, ${c.modeloPadrao || 'claude-sonnet-4-6'}, ${c.promptPadrao || ''}, ${'[]'}::jsonb, ${'{}'}::jsonb, true, ${''}, ${c.tetoPadrao ?? 3})
      ON CONFLICT (id) DO NOTHING`);
  } catch (e: any) { console.error('[MKT-LLM] agentes_config ' + c.agente + ':', e?.message || e); }
}

async function configDoAgente(c: Chamada): Promise<{ modelo: string; prompt: string; base: string; ferramentas: string[]; ativo: boolean }> {
  await garantirAgenteConfig(c);
  try {
    const r: any = await db.execute(sql`SELECT modelo, system_prompt, base_conhecimento, ferramentas, ativo FROM agentes_config WHERE id = ${c.agente} LIMIT 1`);
    const a = r.rows?.[0];
    if (a) {
      let f: string[] = [];
      try { f = Array.isArray(a.ferramentas) ? a.ferramentas.map(String) : JSON.parse(a.ferramentas || '[]'); } catch {}
      return { modelo: normModel(a.modelo || c.modeloPadrao), prompt: String(a.system_prompt || c.promptPadrao || ''), base: String(a.base_conhecimento || ''), ferramentas: f, ativo: a.ativo !== false };
    }
  } catch {}
  return { modelo: normModel(c.modeloPadrao), prompt: c.promptPadrao || '', base: '', ferramentas: [], ativo: true };
}

function lerUso(j: any): { in: number; out: number } {
  const u = j?.usage || {};
  return { in: Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0), out: Number(u.output_tokens || 0) };
}

export function extrairJson(texto: string): any | null {
  const t = String(texto || '').trim();
  const semCerca = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const cand of [semCerca, t]) {
    try { return JSON.parse(cand); } catch {}
    const i = cand.indexOf('{'), f = cand.lastIndexOf('}');
    if (i >= 0 && f > i) { try { return JSON.parse(cand.slice(i, f + 1)); } catch {} }
  }
  return null;
}

export async function chamarAgente(c: Chamada): Promise<Resposta> {
  const vazio = (modelo: string, erro: string): Resposta => ({ ok: false, erro, modelo, tokensIn: 0, tokensOut: 0, rodadas: 0, ferramentas: [] });
  if (!process.env.ANTHROPIC_API_KEY) return vazio(c.modeloPadrao || 'claude-sonnet-4-6', 'ANTHROPIC_API_KEY ausente');
  const cfg = await configDoAgente(c);
  if (!cfg.ativo) return vazio(cfg.modelo, 'agente ' + c.agente + ' desativado em agentes_config');

  let mkt: any = null;
  try { mkt = await import('./mkt-agent-runs'); } catch {}
  if (mkt) {
    const t = await mkt.tetoEstourado(c.agente).catch(() => ({ estourou: false }));
    if (t.estourou) return vazio(cfg.modelo, 'teto diario de custo do agente ' + c.agente + ' estourado (R$ ' + Number(t.gasto).toFixed(2) + ' de R$ ' + Number(t.teto).toFixed(2) + ')');
  }

  const t0 = Date.now();
  let tin = 0, tout = 0, rodadas = 0;
  const usadas: string[] = [];
  const registrar = async (ok: boolean, erro?: string) => {
    if (!mkt) return;
    try { await mkt.registrarRun({ agente: c.agente, gatilho: c.gatilho || 'cron', canal: 'interno', entradaRef: c.entradaRef || null, modelo: cfg.modelo, tokensIn: tin, tokensOut: tout, rodadas: Math.max(1, rodadas), ferramentas: usadas, duracaoMs: Date.now() - t0, sucesso: ok, erro: erro || null }); } catch {}
  };

  // ferramentas: as que quem chama oferece, filtradas pela lista do agente (se houver)
  let tools = c.tools || [];
  if (cfg.ferramentas.length) tools = tools.filter(t => cfg.ferramentas.includes(t.name));
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  const system = [cfg.prompt, cfg.base ? '# Fatos da empresa (base de conhecimento)\n' + cfg.base : '', c.systemExtra || ''].filter(Boolean).join('\n\n');
  const primeiro: any = c.imagem
    ? { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: c.imagem.mime, data: c.imagem.base64 } }, { type: 'text', text: c.user }] }
    : { role: 'user', content: c.user };
  const conv: any[] = [primeiro];

  try {
    for (let i = 0; i < 4; i++) {
      const body: any = { model: cfg.modelo, max_tokens: c.maxTokens || 2000, system, messages: conv };
      if (c.temperature != null) body.temperature = c.temperature;
      if (toolDefs.length) body.tools = toolDefs;
      const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
      const j: any = await resp.json().catch(() => ({}));
      const u = lerUso(j); tin += u.in; tout += u.out; rodadas++;
      if (!resp.ok) { const erro = 'anthropic ' + resp.status + ': ' + JSON.stringify(j).slice(0, 200); await registrar(false, erro); return { ...vazio(cfg.modelo, erro), tokensIn: tin, tokensOut: tout, rodadas }; }
      const content: any[] = j.content || [];
      const usos = content.filter(b => b.type === 'tool_use');
      if (!usos.length || j.stop_reason !== 'tool_use') {
        const texto = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        await registrar(true);
        return { ok: true, texto, json: extrairJson(texto), modelo: cfg.modelo, tokensIn: tin, tokensOut: tout, rodadas, ferramentas: usadas };
      }
      conv.push({ role: 'assistant', content });
      const results: any[] = [];
      for (const uso of usos) {
        const t = tools.find(x => x.name === uso.name);
        usadas.push(uso.name);
        let out = 'Ferramenta desconhecida.';
        if (t) { try { out = await t.run(uso.input || {}); } catch (e: any) { out = 'Erro na ferramenta: ' + String(e?.message || e).slice(0, 120); } }
        results.push({ type: 'tool_result', tool_use_id: uso.id, content: String(out).slice(0, 6000) });
      }
      conv.push({ role: 'user', content: results });
    }
    await registrar(false, 'excedeu rodadas de tool-use');
    return { ...vazio(cfg.modelo, 'excedeu 4 rodadas de tool-use'), tokensIn: tin, tokensOut: tout, rodadas };
  } catch (e: any) {
    const erro = String(e?.message || e).slice(0, 200);
    await registrar(false, erro);
    return { ...vazio(cfg.modelo, erro), tokensIn: tin, tokensOut: tout, rodadas };
  }
}

// ---------------------------------------------------------------------------
// Tool compartilhada: preco e disponibilidade — o modelo NUNCA escreve preco de
// memoria; se quiser citar, consulta aqui. Mesma fonte do atendimento (products).
// ---------------------------------------------------------------------------
export const TOOL_CONSULTAR_PRODUTO: ToolDef = {
  name: 'consultar_produto',
  description: 'Consulta preco de varejo, preco de revenda, estoque e disponibilidade de um produto Honest pelo nome. Use antes de citar qualquer preco ou sabor.',
  input_schema: { type: 'object', properties: { termo: { type: 'string', description: 'nome ou parte do nome (ex.: laranja, uva 300ml)' } }, required: ['termo'] },
  run: async (input: any) => {
    const termo = String(input?.termo || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    try {
      const r: any = await db.execute(sql`SELECT name, price, retail_price, resale_goiania_price, stock, available_for_sale FROM products WHERE is_active = true ORDER BY name`);
      const rows = (r.rows || []).filter((p: any) => String(p.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(termo)).slice(0, 8);
      if (!rows.length) return 'Nenhum produto encontrado com "' + termo + '". Nao cite preco nem esse sabor.';
      const brl = (v: any) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
      return rows.map((p: any) => p.name + ': varejo ' + brl(p.retail_price || p.price) + (p.resale_goiania_price ? '; revenda ' + brl(p.resale_goiania_price) : '') + (p.available_for_sale === false ? '; INDISPONIVEL — nao anuncie' : '')).join(' | ');
    } catch (e: any) { return 'Consulta indisponivel: ' + String(e?.message || e).slice(0, 80) + '. Nao cite preco.'; }
  },
};
