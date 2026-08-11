// ============================================================================
// CENTRAL DE MARKETING — Buraco 7: custo e token por execucao de IA
// ----------------------------------------------------------------------------
// Ate aqui o INTEGRA nao sabia quanto a IA custava. O runtime chamava a Anthropic
// e jogava o `usage` da resposta fora. Sem isso nao existe CAC real, nao existe
// teto de gasto e nao da para responder "quanto a IA custou este mes".
//
// Este modulo resolve tres coisas:
//   1. mkt_agent_runs        -> 1 linha por execucao de agente (tokens + custo)
//   2. calcularCusto()       -> converte tokens em R$ com preco e cambio EDITAVEIS
//                               sem deploy (system_settings)
//   3. tetoEstourado()       -> guarda-chuva: agente com teto diario estourado para
//                               de responder e avisa, em vez de queimar dinheiro em
//                               silencio (motivo n.1 de cancelamento segundo a Gartner)
//
// Fuso: criado_em e timestamptz DE PROPOSITO. O sistema ja teve o bug de
// "vencimento hoje aparecia como vencido" por ler timestamp sem fuso. Com
// timestamptz, o dia em BRT e sempre (criado_em AT TIME ZONE 'America/Sao_Paulo')::date.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// Preco por 1 MILHAO de tokens, em USD. Editavel sem deploy pela chave
// system_settings 'mkt_precos_modelo' (JSON no mesmo formato). O que vier na
// chave sobrescreve o padrao; o que faltar cai para ca.
const PRECO_PADRAO: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-8': { in: 15, out: 75 },
};

// Familia do modelo: 'claude-haiku-4-5-20251001' -> 'claude-haiku-4-5'
export function familiaModelo(m?: string): string {
  const x = String(m || '').trim();
  if (x.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5';
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

// Cache curto: estas chaves sao lidas em TODA resposta da IA. 60s e suficiente
// para uma mudanca de preco valer sem reiniciar e sem martelar o banco.
let _cache: { at: number; precos: Record<string, { in: number; out: number }>; cambio: number } | null = null;

async function tabelaDePreco(): Promise<{ precos: Record<string, { in: number; out: number }>; cambio: number }> {
  const agora = Date.now();
  if (_cache && agora - _cache.at < 60_000) return { precos: _cache.precos, cambio: _cache.cambio };
  let precos = { ...PRECO_PADRAO };
  try {
    const raw = await getSetting('mkt_precos_modelo', '');
    if (raw) {
      const j = JSON.parse(raw);
      for (const k of Object.keys(j || {})) {
        const v = j[k] || {};
        if (typeof v.in === 'number' && typeof v.out === 'number') precos[k] = { in: v.in, out: v.out };
      }
    }
  } catch (e: any) { console.error('[MKT-CUSTO] mkt_precos_modelo invalido:', e?.message || e); }
  const cambio = Number(await getSetting('mkt_usd_brl', '5.40')) || 5.40;
  _cache = { at: agora, precos, cambio };
  return { precos, cambio };
}

export function limparCacheDePreco(): void { _cache = null; }

export async function calcularCusto(modelo: string, tokensIn: number, tokensOut: number): Promise<{ usd: number; brl: number; cambio: number }> {
  const { precos, cambio } = await tabelaDePreco();
  const p = precos[familiaModelo(modelo)] || PRECO_PADRAO['claude-sonnet-4-6'];
  const usd = (Math.max(0, tokensIn) / 1_000_000) * p.in + (Math.max(0, tokensOut) / 1_000_000) * p.out;
  return { usd, brl: usd * cambio, cambio };
}

// ---------------------------------------------------------------------------
// Schema (idempotente, padrao da casa: roda no boot e tambem por endpoint)
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0; // evita tempestade de DDL se um passo falhar de verdade

export async function ensureMktRunsSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };
  await run('create_mkt_agent_runs',
    "CREATE TABLE IF NOT EXISTS mkt_agent_runs (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "agente varchar NOT NULL, " +
    "gatilho varchar, " +            // chat | teste | cron | diag | api
    "canal varchar, " +              // whatsapp | instagram | interno
    "entrada_ref varchar, " +        // conversationId, peca, brief...
    "modelo varchar, " +
    "tokens_in int NOT NULL DEFAULT 0, " +
    "tokens_out int NOT NULL DEFAULT 0, " +
    "custo_usd numeric(12,6) NOT NULL DEFAULT 0, " +
    "custo_brl numeric(12,4) NOT NULL DEFAULT 0, " +
    "rodadas int NOT NULL DEFAULT 1, " +   // rodadas de tool-use gastas
    "ferramentas jsonb, " +
    "duracao_ms int, " +
    "sucesso boolean NOT NULL DEFAULT true, " +
    "erro text, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");
  await run('idx_runs_data', "CREATE INDEX IF NOT EXISTS idx_mkt_agent_runs_criado ON mkt_agent_runs (criado_em DESC)");
  await run('idx_runs_agente', "CREATE INDEX IF NOT EXISTS idx_mkt_agent_runs_agente ON mkt_agent_runs (agente, criado_em DESC)");
  // Teto de gasto diario por agente. NULL/0 = sem teto (comportamento de hoje).
  await run('col_teto', "ALTER TABLE agentes_config ADD COLUMN IF NOT EXISTS teto_custo_dia numeric(10,2)");
  _schemaOk = steps.every(s => s.ok);
  _schemaTentativa = Date.now();
  return { ok: _schemaOk, steps };
}

// ---------------------------------------------------------------------------
// Registro de execucao. NUNCA lanca: medir custo jamais pode derrubar resposta
// ao cliente. Se falhar, loga e segue.
// ---------------------------------------------------------------------------
export type AgentRun = {
  agente: string;
  gatilho?: string;
  canal?: string;
  entradaRef?: string | null;
  modelo?: string;
  tokensIn?: number;
  tokensOut?: number;
  rodadas?: number;
  ferramentas?: string[];
  duracaoMs?: number;
  sucesso?: boolean;
  erro?: string | null;
};

export async function registrarRun(r: AgentRun): Promise<void> {
  try {
    // Se o schema falhou de verdade, tenta de novo no maximo 1x por minuto — nunca
    // a cada mensagem (isso viraria uma tempestade de DDL sob volume de anuncio).
    if (!_schemaOk && Date.now() - _schemaTentativa > 60_000) await ensureMktRunsSchema();
    if (!_schemaOk) return;
    const tin = Math.max(0, Number(r.tokensIn || 0));
    const tout = Math.max(0, Number(r.tokensOut || 0));
    const { usd, brl } = await calcularCusto(r.modelo || '', tin, tout);
    await db.execute(sql`
      INSERT INTO mkt_agent_runs
        (agente, gatilho, canal, entrada_ref, modelo, tokens_in, tokens_out,
         custo_usd, custo_brl, rodadas, ferramentas, duracao_ms, sucesso, erro)
      VALUES
        (${r.agente}, ${r.gatilho || 'chat'}, ${r.canal || null}, ${r.entradaRef || null},
         ${r.modelo || null}, ${tin}, ${tout}, ${usd.toFixed(6)}, ${brl.toFixed(4)},
         ${Math.max(1, Number(r.rodadas || 1))},
         ${JSON.stringify(r.ferramentas || [])}::jsonb,
         ${r.duracaoMs == null ? null : Math.round(r.duracaoMs)},
         ${r.sucesso !== false}, ${r.erro || null})`);
  } catch (e: any) {
    console.error('[MKT-RUNS] falha ao registrar execucao:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Teto diario. Le agentes_config.teto_custo_dia e soma o gasto do DIA EM BRT.
// ---------------------------------------------------------------------------
export async function custoDoDia(agente?: string): Promise<number> {
  try {
    const q: any = agente
      ? await db.execute(sql`SELECT COALESCE(SUM(custo_brl),0) AS t FROM mkt_agent_runs
           WHERE agente = ${agente}
             AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`)
      : await db.execute(sql`SELECT COALESCE(SUM(custo_brl),0) AS t FROM mkt_agent_runs
           WHERE (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
    return Number(q.rows?.[0]?.t || 0);
  } catch { return 0; }
}

/**
 * Guarda de custo. Retorna o teto e se ja foi estourado.
 * Regra: teto nulo, zero ou negativo = SEM teto (nao muda o comportamento atual).
 */
export async function tetoEstourado(agente: string): Promise<{ estourou: boolean; teto: number; gasto: number }> {
  try {
    const a: any = await db.execute(sql`SELECT teto_custo_dia FROM agentes_config WHERE id = ${agente} LIMIT 1`);
    const teto = Number(a.rows?.[0]?.teto_custo_dia || 0);
    if (!(teto > 0)) return { estourou: false, teto: 0, gasto: 0 };
    const gasto = await custoDoDia(agente);
    return { estourou: gasto >= teto, teto, gasto };
  } catch { return { estourou: false, teto: 0, gasto: 0 }; }
}

// ---------------------------------------------------------------------------
// Resumo para a tela / relatorio semanal
// ---------------------------------------------------------------------------
export async function resumoCustos(dias = 30): Promise<any> {
  const d = Math.min(365, Math.max(1, Number(dias) || 30));
  const janela = sql.raw(`criado_em >= now() - interval '${d} days'`);
  const porAgente: any = await db.execute(sql`
    SELECT agente,
           COUNT(*)::int                AS execucoes,
           SUM(tokens_in)::int          AS tokens_in,
           SUM(tokens_out)::int         AS tokens_out,
           ROUND(SUM(custo_brl), 2)     AS custo_brl,
           ROUND(AVG(custo_brl), 4)     AS custo_medio_brl,
           ROUND(AVG(duracao_ms))       AS duracao_media_ms,
           SUM(CASE WHEN sucesso THEN 0 ELSE 1 END)::int AS erros
      FROM mkt_agent_runs WHERE ${janela}
     GROUP BY agente ORDER BY custo_brl DESC NULLS LAST`);
  const porDia: any = await db.execute(sql`
    SELECT (criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
           COUNT(*)::int            AS execucoes,
           ROUND(SUM(custo_brl), 2) AS custo_brl
      FROM mkt_agent_runs WHERE ${janela}
     GROUP BY 1 ORDER BY 1 DESC`);
  const tot: any = await db.execute(sql`
    SELECT COUNT(*)::int AS execucoes,
           ROUND(COALESCE(SUM(custo_brl), 0), 2) AS custo_brl,
           COALESCE(SUM(tokens_in), 0)::int  AS tokens_in,
           COALESCE(SUM(tokens_out), 0)::int AS tokens_out
      FROM mkt_agent_runs WHERE ${janela}`);
  const { cambio } = await tabelaDePreco();
  return {
    dias: d,
    cambioUsdBrl: cambio,
    total: tot.rows?.[0] || { execucoes: 0, custo_brl: 0, tokens_in: 0, tokens_out: 0 },
    hoje: await custoDoDia(),
    porAgente: porAgente.rows || [],
    porDia: porDia.rows || [],
  };
}
