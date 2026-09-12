// ============================================================================
// CENTRAL DE MARKETING — CAIXA DE DECISÕES (mkt_acoes)
// ----------------------------------------------------------------------------
// Um unico objeto — a ACAO PROPOSTA — que qualquer agente pode criar e que
// passa sempre pelo mesmo caminho:
//
//   proposta ──► (politica decide o nivel) ──► N0: executa e informa
//                                          ├─► N1: executa dentro do teto
//                                          └─► N2: espera humano (tela ou WhatsApp)
//            ──► aprovada ──► executando ──► executada ──► medida (14/30 dias)
//            ──► rejeitada | expirada (48h sem decisao)
//
// O humano decide; o sistema executa. E a politica de autonomia e CODIGO, em
// tabela editavel (mkt_politicas): um agente nunca promove a propria acao.
//
// "Humano so aprova" nao e "humano aprova tudo": e o humano decidindo SO o que
// precisa dele. Por isso N0/N1 existem — e por isso toda acao, mesmo N0, aparece
// no resumo diario. Autonomia sem opacidade.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export type TipoAcao = 'regua' | 'alerta' | 'peca' | 'campanha' | 'cupom' | 'visita' | 'anuncio';

export type NovaAcao = {
  tipo: TipoAcao;
  agente: string;                 // quem propos: 'mkt_radar' | 'humano' | ...
  titulo: string;
  justificativa: string;
  evidencia?: any;                // numeros que sustentam (jsonb)
  publico?: { segmento?: string; regua?: string; clientes: Array<{ id: string; nome?: string; vendedor?: string | null; ticket?: number }>; };
  parametros?: any;               // o que o executor precisa (regua, destino, texto...)
  custoEstimado?: number;
  receitaEsperada?: number;
  categoria?: 'UTILITY' | 'MARKETING' | null;
  nivelSugerido?: 0 | 1 | 2;
  prazoHoras?: number;            // expira sem decisao (padrao 48h)
  modoTeste?: boolean;            // radar em 'test': nada executa sozinho
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktAcoesSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };
  await run('create_acoes',
    "CREATE TABLE IF NOT EXISTS mkt_acoes (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "numero serial, " +                                  // o '12' de 'OK 12'
    "tipo varchar NOT NULL, agente varchar NOT NULL, " +
    "titulo varchar NOT NULL, justificativa text, evidencia jsonb, " +
    "publico jsonb, publico_total int NOT NULL DEFAULT 0, parametros jsonb, " +
    "custo_estimado numeric(12,2) NOT NULL DEFAULT 0, receita_esperada numeric(12,2) NOT NULL DEFAULT 0, " +
    "categoria varchar, nivel_sugerido int NOT NULL DEFAULT 2, nivel_efetivo int NOT NULL DEFAULT 2, " +
    "motivo_nivel varchar, " +
    "status varchar NOT NULL DEFAULT 'proposta', " +   // proposta|aprovada|rejeitada|auto|executando|executada|erro|expirada
    "decidido_por varchar, decidido_via varchar, decidido_em timestamptz, comentario text, " +
    "executada_em timestamptz, execucao jsonb, resultado jsonb, medido_em timestamptz, " +
    "expira_em timestamptz, modo_teste boolean NOT NULL DEFAULT false, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");
  await run('idx_acoes_status', "CREATE INDEX IF NOT EXISTS idx_mkt_acoes_status ON mkt_acoes (status, criado_em DESC)");
  await run('idx_acoes_numero', "CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_acoes_numero ON mkt_acoes (numero)");

  await run('create_politicas',
    "CREATE TABLE IF NOT EXISTS mkt_politicas (" +
    "tipo varchar PRIMARY KEY, nivel_padrao int NOT NULL DEFAULT 2, " +
    "teto_custo_dia numeric(10,2) NOT NULL DEFAULT 5, max_clientes_dia int NOT NULL DEFAULT 60, " +
    "categorias_permitidas jsonb NOT NULL DEFAULT '[\"UTILITY\"]'::jsonb, " +
    "taxa_aprovacao_minima numeric(4,2) NOT NULL DEFAULT 0.90, dias_observacao int NOT NULL DEFAULT 30, " +
    "amostra_minima int NOT NULL DEFAULT 10, ativo boolean NOT NULL DEFAULT true, " +
    "atualizado_em timestamptz NOT NULL DEFAULT now(), atualizado_por varchar)");
  // Politicas de partida — tudo que fala com cliente comeca em N2 (humano).
  await run('seed_politicas',
    "INSERT INTO mkt_politicas (tipo, nivel_padrao) VALUES " +
    "('regua', 2), ('alerta', 0), ('peca', 2), ('campanha', 0), ('cupom', 2), ('visita', 2), ('anuncio', 2) " +
    "ON CONFLICT (tipo) DO NOTHING");

  await run('create_sinais',
    "CREATE TABLE IF NOT EXISTS mkt_sinais (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "data date NOT NULL, sinal varchar NOT NULL, valor jsonb, criado_em timestamptz NOT NULL DEFAULT now())");
  await run('create_decisoes_wpp',
    "CREATE TABLE IF NOT EXISTS mkt_decisoes_whatsapp (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "telefone varchar NOT NULL, texto text NOT NULL, interpretacao jsonb, aplicada boolean NOT NULL DEFAULT false, " +
    "resposta text, criado_em timestamptz NOT NULL DEFAULT now())");
  await run('create_learnings',
    "CREATE TABLE IF NOT EXISTS mkt_learnings (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "origem varchar NOT NULL DEFAULT 'humano', enunciado text NOT NULL, evidencia jsonb, amostra int, " +
    "confianca varchar NOT NULL DEFAULT 'media', acao_sugerida text, ativo boolean NOT NULL DEFAULT true, " +
    "criado_em timestamptz NOT NULL DEFAULT now())");

  // Rastro da acao ate a venda
  await run('col_sales_acao', "ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS acao_id varchar");
  await run('col_fila_acao', "ALTER TABLE mkt_fila_toques ADD COLUMN IF NOT EXISTS acao_id varchar");
  await run('col_lotes_acao', "ALTER TABLE mkt_lotes ADD COLUMN IF NOT EXISTS acao_id varchar");
  await run('col_pieces_acao', "ALTER TABLE mkt_pieces ADD COLUMN IF NOT EXISTS acao_id varchar");
  await run('col_conv_acao', "ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS acao_id varchar");
  await run('col_runs_provedor', "ALTER TABLE mkt_agent_runs ADD COLUMN IF NOT EXISTS provedor varchar NOT NULL DEFAULT 'anthropic'");

  _schemaOk = steps.filter(s => !String(s.step).startsWith('col_')).every(s => s.ok);
  _schemaTentativa = Date.now();
  return { ok: _schemaOk, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa > 60_000) await ensureMktAcoesSchema();
  return _schemaOk;
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

// ---------------------------------------------------------------------------
// Políticas de autonomia — o nível é decidido AQUI, por código.
// ---------------------------------------------------------------------------
export async function politicas(): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const r: any = await db.execute(sql`SELECT * FROM mkt_politicas ORDER BY tipo`);
  return r.rows || [];
}

export async function salvarPolitica(tipo: string, campos: any, por: string): Promise<void> {
  if (!(await garantirSchema())) throw new Error('schema indisponivel');
  const n = (v: any, d: number) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));
  const atual: any = (await db.execute(sql`SELECT * FROM mkt_politicas WHERE tipo = ${tipo} LIMIT 1`) as any).rows?.[0] || {};
  const nivel = Math.max(0, Math.min(2, n(campos.nivel_padrao, atual.nivel_padrao ?? 2)));
  await db.execute(sql`
    INSERT INTO mkt_politicas (tipo, nivel_padrao, teto_custo_dia, max_clientes_dia, categorias_permitidas, taxa_aprovacao_minima, dias_observacao, amostra_minima, ativo, atualizado_em, atualizado_por)
    VALUES (${tipo}, ${nivel}, ${n(campos.teto_custo_dia, atual.teto_custo_dia ?? 5)}, ${n(campos.max_clientes_dia, atual.max_clientes_dia ?? 60)},
            ${JSON.stringify(Array.isArray(campos.categorias_permitidas) ? campos.categorias_permitidas : (atual.categorias_permitidas ?? ['UTILITY']))}::jsonb,
            ${n(campos.taxa_aprovacao_minima, atual.taxa_aprovacao_minima ?? 0.9)}, ${n(campos.dias_observacao, atual.dias_observacao ?? 30)},
            ${n(campos.amostra_minima, atual.amostra_minima ?? 10)}, ${campos.ativo == null ? (atual.ativo ?? true) : !!campos.ativo}, now(), ${por})
    ON CONFLICT (tipo) DO UPDATE SET nivel_padrao = EXCLUDED.nivel_padrao, teto_custo_dia = EXCLUDED.teto_custo_dia,
      max_clientes_dia = EXCLUDED.max_clientes_dia, categorias_permitidas = EXCLUDED.categorias_permitidas,
      taxa_aprovacao_minima = EXCLUDED.taxa_aprovacao_minima, dias_observacao = EXCLUDED.dias_observacao,
      amostra_minima = EXCLUDED.amostra_minima, ativo = EXCLUDED.ativo, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`);
}

/**
 * Nível efetivo de uma ação. Regras duras, nesta ordem:
 *  - modo teste do agente → 2 (só propõe)
 *  - política inativa ou inexistente → 2
 *  - política N0 → 0 (ações sem dinheiro e sem contato com cliente)
 *  - política N1 só vale se: categoria permitida (UTILITY), custo ≤ teto do dia
 *    (somando o que já foi gasto em N1 hoje), público ≤ max/dia, e a taxa de
 *    aprovação humana recente para esse tipo ≥ mínima com amostra ≥ mínima.
 *  - qualquer coisa fora disso → 2
 */
export async function nivelEfetivo(a: NovaAcao): Promise<{ nivel: 0 | 1 | 2; motivo: string }> {
  if (a.modoTeste) return { nivel: 2, motivo: 'agente em modo teste' };
  const p: any = (await db.execute(sql`SELECT * FROM mkt_politicas WHERE tipo = ${a.tipo} LIMIT 1`) as any).rows?.[0];
  if (!p || !p.ativo) return { nivel: 2, motivo: 'sem politica ativa para ' + a.tipo };
  const padrao = Number(p.nivel_padrao);
  if (padrao >= 2) return { nivel: 2, motivo: 'politica: humano decide' };
  if (padrao === 0) return { nivel: 0, motivo: 'politica: executa e informa' };

  // N1 — cada guarda é código, não prompt
  const cats: string[] = Array.isArray(p.categorias_permitidas) ? p.categorias_permitidas : ['UTILITY'];
  if (a.categoria && !cats.includes(a.categoria)) return { nivel: 2, motivo: 'categoria ' + a.categoria + ' exige humano' };
  const custo = Number(a.custoEstimado || 0);
  const gastoHoje: any = (await db.execute(sql`
    SELECT COALESCE(SUM(custo_estimado),0)::float AS c, COALESCE(SUM(publico_total),0)::int AS n FROM mkt_acoes
     WHERE tipo = ${a.tipo} AND nivel_efetivo = 1 AND status IN ('auto','executando','executada')
       AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`) as any).rows?.[0] || {};
  if (custo + Number(gastoHoje.c || 0) > Number(p.teto_custo_dia)) return { nivel: 2, motivo: 'estoura teto de R$ ' + p.teto_custo_dia + '/dia' };
  const n = a.publico?.clientes?.length || 0;
  if (n + Number(gastoHoje.n || 0) > Number(p.max_clientes_dia)) return { nivel: 2, motivo: 'estoura ' + p.max_clientes_dia + ' clientes/dia' };
  const hist: any = (await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('aprovada','executando','executada'))::int AS ap,
           COUNT(*) FILTER (WHERE status = 'rejeitada')::int AS rj
      FROM mkt_acoes WHERE tipo = ${a.tipo} AND nivel_efetivo = 2 AND decidido_em IS NOT NULL
       AND decidido_em >= now() - (${String(Number(p.dias_observacao) || 30)} || ' days')::interval`) as any).rows?.[0] || {};
  const dec = Number(hist.ap || 0) + Number(hist.rj || 0);
  if (dec < Number(p.amostra_minima)) return { nivel: 2, motivo: 'ainda em observacao (' + dec + '/' + p.amostra_minima + ' decisoes humanas)' };
  const taxa = Number(hist.ap || 0) / dec;
  if (taxa < Number(p.taxa_aprovacao_minima)) return { nivel: 2, motivo: 'taxa de aprovacao ' + Math.round(taxa * 100) + '% abaixo da minima' };
  return { nivel: 1, motivo: 'dentro do teto, ' + Math.round(taxa * 100) + '% de aprovacao em ' + dec + ' decisoes' };
}

// ---------------------------------------------------------------------------
// Criar, listar, ver
// ---------------------------------------------------------------------------
export async function criarAcao(a: NovaAcao): Promise<{ id: string; numero: number; nivel: number; status: string }> {
  if (!(await garantirSchema())) throw new Error('schema da caixa de decisoes indisponivel');
  const { nivel, motivo } = await nivelEfetivo(a);
  const prazo = Math.max(1, Number(a.prazoHoras || 48));
  const status = nivel === 2 ? 'proposta' : 'auto';
  const r: any = await db.execute(sql`
    INSERT INTO mkt_acoes (tipo, agente, titulo, justificativa, evidencia, publico, publico_total, parametros,
                           custo_estimado, receita_esperada, categoria, nivel_sugerido, nivel_efetivo, motivo_nivel,
                           status, expira_em, modo_teste)
    VALUES (${a.tipo}, ${a.agente}, ${String(a.titulo).slice(0, 200)}, ${a.justificativa || null},
            ${JSON.stringify(a.evidencia || {})}::jsonb, ${JSON.stringify(a.publico || null)}::jsonb,
            ${a.publico?.clientes?.length || 0}, ${JSON.stringify(a.parametros || {})}::jsonb,
            ${Number(a.custoEstimado || 0).toFixed(2)}, ${Number(a.receitaEsperada || 0).toFixed(2)}, ${a.categoria || null},
            ${a.nivelSugerido ?? 2}, ${nivel}, ${motivo}, ${status},
            now() + (${String(prazo)} || ' hours')::interval, ${!!a.modoTeste})
    RETURNING id, numero`);
  const row = r.rows?.[0];
  return { id: String(row.id), numero: Number(row.numero), nivel, status };
}

export async function listar(opts: { status?: string; limite?: number } = {}): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const lim = Math.min(200, Math.max(1, Number(opts.limite) || 50));
  const r: any = opts.status
    ? await db.execute(sql`SELECT * FROM mkt_acoes WHERE status = ${opts.status} ORDER BY receita_esperada DESC, criado_em DESC LIMIT ${lim}`)
    : await db.execute(sql`SELECT * FROM mkt_acoes ORDER BY (status = 'proposta') DESC, criado_em DESC LIMIT ${lim}`);
  return r.rows || [];
}

export async function pendentes(): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const r: any = await db.execute(sql`SELECT * FROM mkt_acoes WHERE status = 'proposta' ORDER BY receita_esperada DESC, numero ASC`);
  return r.rows || [];
}

export async function ver(idOuNumero: string): Promise<any | null> {
  if (!(await garantirSchema())) return null;
  const n = Number(idOuNumero);
  const r: any = Number.isInteger(n) && String(n) === String(idOuNumero).trim()
    ? await db.execute(sql`SELECT * FROM mkt_acoes WHERE numero = ${n} LIMIT 1`)
    : await db.execute(sql`SELECT * FROM mkt_acoes WHERE id = ${idOuNumero} LIMIT 1`);
  return r.rows?.[0] || null;
}

// ---------------------------------------------------------------------------
// Decidir (aceita lote) — e executa em seguida o que foi aprovado
// ---------------------------------------------------------------------------
export async function decidir(opts: {
  ids: string[]; decisao: 'aprovar' | 'rejeitar'; quem: string; via: 'tela' | 'whatsapp';
  comentario?: string | null; excluirClientes?: string[];
}): Promise<{ aplicadas: number; ignoradas: string[]; execucoes: any[] }> {
  if (!(await garantirSchema())) throw new Error('schema indisponivel');
  const ignoradas: string[] = [];
  const execucoes: any[] = [];
  let aplicadas = 0;
  for (const idRaw of opts.ids) {
    const a = await ver(idRaw);
    if (!a || a.status !== 'proposta') { ignoradas.push(idRaw); continue; }
    if (opts.decisao === 'rejeitar') {
      await db.execute(sql`UPDATE mkt_acoes SET status='rejeitada', decidido_por=${opts.quem}, decidido_via=${opts.via}, decidido_em=now(), comentario=${opts.comentario || null} WHERE id=${a.id}`);
      aplicadas++; continue;
    }
    // Aprovar — opcionalmente tirando clientes da lista ("OK 12 menos 3,7")
    let publico = a.publico;
    if (opts.excluirClientes?.length && publico?.clientes) {
      const fora = new Set(opts.excluirClientes.map(String));
      publico = { ...publico, clientes: publico.clientes.filter((c: any, i: number) => !fora.has(String(i + 1)) && !fora.has(String(c.id))) };
      await db.execute(sql`UPDATE mkt_acoes SET publico=${JSON.stringify(publico)}::jsonb, publico_total=${publico.clientes.length} WHERE id=${a.id}`);
    }
    await db.execute(sql`UPDATE mkt_acoes SET status='aprovada', decidido_por=${opts.quem}, decidido_via=${opts.via}, decidido_em=now(), comentario=${opts.comentario || null} WHERE id=${a.id}`);
    aplicadas++;
    execucoes.push(await executar(a.id));
  }
  return { aplicadas, ignoradas, execucoes };
}

// ---------------------------------------------------------------------------
// Executar — o despachante por tipo. Idempotente: só executa 'aprovada' ou 'auto'.
// ---------------------------------------------------------------------------
export async function executar(id: string): Promise<{ id: string; ok: boolean; detalhe?: any; erro?: string }> {
  const a = await ver(id);
  if (!a) return { id, ok: false, erro: 'acao nao encontrada' };
  if (!['aprovada', 'auto'].includes(a.status)) return { id, ok: false, erro: 'status ' + a.status + ' nao executa' };
  if (a.modo_teste) {
    await db.execute(sql`UPDATE mkt_acoes SET status='executada', executada_em=now(), execucao=${JSON.stringify({ simulado: true })}::jsonb WHERE id=${a.id}`);
    return { id, ok: true, detalhe: { simulado: true } };
  }
  await db.execute(sql`UPDATE mkt_acoes SET status='executando' WHERE id=${a.id}`);
  try {
    let detalhe: any = null;
    switch (String(a.tipo)) {
      case 'regua': detalhe = await executarRegua(a); break;
      case 'alerta': detalhe = await executarAlerta(a); break;
      case 'campanha': detalhe = await executarCampanha(a); break;
      case 'peca': detalhe = await executarPeca(a); break;
      default: throw new Error('executor para tipo ' + a.tipo + ' ainda nao existe');
    }
    await db.execute(sql`UPDATE mkt_acoes SET status='executada', executada_em=now(), execucao=${JSON.stringify(detalhe || {})}::jsonb WHERE id=${a.id}`);
    return { id, ok: true, detalhe };
  } catch (e: any) {
    const erro = String(e?.message || e).slice(0, 300);
    await db.execute(sql`UPDATE mkt_acoes SET status='erro', execucao=${JSON.stringify({ erro })}::jsonb WHERE id=${a.id}`);
    console.error('[MKT-ACOES] execucao falhou', a.numero, erro);
    return { id, ok: false, erro };
  }
}

async function executarRegua(a: any): Promise<any> {
  const { montarLote, liberarLote, descartarLote } = await import('./mkt-recompra');
  const regua = String(a.parametros?.regua || a.publico?.regua || '');
  if (!regua) throw new Error('acao de regua sem regua');
  const ids: string[] = (a.publico?.clientes || []).map((c: any) => String(c.id));
  if (!ids.length) throw new Error('acao de regua sem clientes');
  const lote = await montarLote({ regua, limite: ids.length, criadoPor: 'acao:' + a.numero, clientesIds: ids, acaoId: a.id });
  if (!lote.total) { await descartarLote(lote.loteId); return { loteId: lote.loteId, enviados: 0, motivo: 'todos bloqueados (opt-out, inadimplente, frequencia)' }; }
  const lib = await liberarLote(lote.loteId, 'acao:' + a.numero);
  return { loteId: lote.loteId, montados: lote.total, bloqueados: lote.bloqueados, resultado: lib.resultado };
}

async function executarAlerta(a: any): Promise<any> {
  const { enviarInterno } = await import('./envio-texto');
  const destinos: string[] = [];
  const p = a.parametros || {};
  if (p.telefone) destinos.push(String(p.telefone));
  if (p.vendedor_id) {
    const u: any = await db.execute(sql`SELECT phone FROM users WHERE id = ${String(p.vendedor_id)} LIMIT 1`);
    if (u.rows?.[0]?.phone) destinos.push(String(u.rows[0].phone));
  }
  if (!destinos.length) destinos.push(await getSetting('telefone_gestor_relatorios', ''));
  const texto = String(p.texto || (a.titulo + '\n\n' + (a.justificativa || ''))).slice(0, 3500);
  const r: any[] = [];
  for (const d of destinos.filter(Boolean)) r.push({ para: d, ...(await enviarInterno(d, texto)) });
  return { enviados: r };
}

async function executarCampanha(a: any): Promise<any> {
  const { ensureMktAtribuicaoSchema, normalizarSlug } = await import('./mkt-atribuicao');
  await ensureMktAtribuicaoSchema();
  const p = a.parametros || {};
  const codigo = String(p.codigo || ('RADAR' + String(a.numero))).toUpperCase();
  const c: any = await db.execute(sql`
    INSERT INTO mkt_campanhas (codigo, nome, objetivo, canal, publico, verba, cupom, ativo)
    VALUES (${codigo}, ${String(p.nome || a.titulo).slice(0, 120)}, ${p.objetivo || 'reativacao'}, ${p.canal || 'whatsapp'},
            ${p.publico || null}, ${Number(p.verba || 0)}, ${p.cupom || null}, true)
    ON CONFLICT (codigo) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`);
  const campId = c.rows?.[0]?.id;
  let link: any = null;
  if (p.destino) {
    const slug = normalizarSlug(String(p.slug || codigo.toLowerCase()));
    const l: any = await db.execute(sql`
      INSERT INTO mkt_links (slug, destino, campanha_id, utm_source, utm_medium, utm_campaign, ativo, criado_por)
      VALUES (${slug}, ${String(p.destino)}, ${campId}, ${p.utm_source || 'whatsapp'}, ${p.utm_medium || 'regua'}, ${codigo.toLowerCase()}, true, ${'acao:' + a.numero})
      ON CONFLICT (slug) DO NOTHING RETURNING slug`);
    link = l.rows?.[0]?.slug || slug;
  }
  return { campanhaId: campId, codigo, link };
}

async function executarPeca(a: any): Promise<any> {
  const { criarPeca, enviarParaRevisao } = await import('./mkt-esteira');
  const p = a.parametros || {};
  const r = await criarPeca({ ...(p.peca || {}), criadoPor: 'acao:' + a.numero } as any);
  if (!r.ok || !r.id) throw new Error(r.erro || 'nao criou peca');
  await db.execute(sql`UPDATE mkt_pieces SET acao_id = ${a.id} WHERE id = ${r.id}`);
  const rev = await enviarParaRevisao(r.id, 'acao:' + a.numero);
  return { pecaId: r.id, revisao: rev };
}

/** Executa tudo que a política liberou (N0/N1). Chamado logo após o Radar. */
export async function processarAutomaticas(): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  const r: any = await db.execute(sql`SELECT id FROM mkt_acoes WHERE status = 'auto' ORDER BY criado_em ASC LIMIT 50`);
  const out: any[] = [];
  for (const row of (r.rows || [])) out.push(await executar(String(row.id)));
  return out;
}

export async function expirar(): Promise<number> {
  if (!(await garantirSchema())) return 0;
  const r: any = await db.execute(sql`UPDATE mkt_acoes SET status='expirada' WHERE status='proposta' AND expira_em < now() RETURNING id`);
  return (r.rows || []).length;
}

// ---------------------------------------------------------------------------
// Medição: a ação virou pedido? (14 dias; parcial todo dia até fechar)
// ---------------------------------------------------------------------------
export async function medir(): Promise<number> {
  if (!(await garantirSchema())) return 0;
  const r: any = await db.execute(sql`
    SELECT id, numero, publico, executada_em, custo_estimado FROM mkt_acoes
     WHERE status = 'executada' AND medido_em IS NULL AND executada_em IS NOT NULL AND tipo IN ('regua','cupom','visita')`);
  let n = 0;
  for (const a of (r.rows || [])) {
    const ids: string[] = (a.publico?.clientes || []).map((c: any) => String(c.id));
    if (!ids.length) { await db.execute(sql`UPDATE mkt_acoes SET medido_em = now(), resultado = '{}'::jsonb WHERE id = ${a.id}`); continue; }
    const q: any = await db.execute(sql`
      SELECT COUNT(DISTINCT sc.customer_id)::int AS clientes, COUNT(sc.id)::int AS pedidos, COALESCE(SUM(sc.sale_value),0)::float AS receita
        FROM sales_cards sc
       WHERE sc.customer_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
         AND COALESCE(sc.sale_value,0) > 0
         AND sc.created_at > ${a.executada_em} AND sc.created_at <= ${a.executada_em}::timestamptz + interval '14 days'`);
    const x = q.rows?.[0] || {};
    const resultado = { clientes: Number(x.clientes || 0), pedidos: Number(x.pedidos || 0), receita: Number(x.receita || 0),
      taxa: ids.length ? Number((Number(x.clientes || 0) / ids.length).toFixed(3)) : 0, custo: Number(a.custo_estimado || 0), janelaDias: 14 };
    const fechou = (Date.now() - new Date(a.executada_em).getTime()) > 14 * 86400000;
    await db.execute(sql`UPDATE mkt_acoes SET resultado = ${JSON.stringify(resultado)}::jsonb ${fechou ? sql`, medido_em = now()` : sql``} WHERE id = ${a.id}`);
    // carimba os pedidos (rastro da ação até a venda)
    try {
      await db.execute(sql`UPDATE sales_cards SET acao_id = ${a.id}
        WHERE acao_id IS NULL AND customer_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
          AND created_at > ${a.executada_em} AND created_at <= ${a.executada_em}::timestamptz + interval '14 days'`);
    } catch {}
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// WhatsApp: o resumo do dia e a resposta "OK 12"
// ---------------------------------------------------------------------------
const brl = (v: any) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function aprovadores(): Promise<string[]> {
  const so = (s: string) => String(s || '').replace(/\D/g, '');
  const lista = new Set<string>();
  const g = so(await getSetting('telefone_gestor_relatorios', ''));
  if (g) lista.add(g);
  for (const t of (await getSetting('mkt_aprovadores', '')).split(/[,;\s]+/)) { const d = so(t); if (d.length >= 10) lista.add(d); }
  return Array.from(lista);
}

export function ehAprovador(telefone: string, lista: string[]): boolean {
  const d = String(telefone || '').replace(/\D/g, '');
  if (!d) return false;
  return lista.some(a => a === d || a.endsWith(d.slice(-8)) || d.endsWith(a.slice(-8)));
}

export function textoResumo(pend: any[], extras: { autoHoje?: any[]; medidas?: any[]; avisos?: string[] } = {}): string {
  const linhas: string[] = [];
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  linhas.push('📬 *Caixa de Decisões — ' + hoje + '*');
  if (pend.length) {
    const receita = pend.reduce((s, a) => s + Number(a.receita_esperada || 0), 0);
    const custo = pend.reduce((s, a) => s + Number(a.custo_estimado || 0), 0);
    linhas.push(pend.length + ' ação(ões) esperando você · ' + brl(receita) + ' esperados · custo ' + brl(custo));
    linhas.push('');
    for (const a of pend.slice(0, 8)) {
      const pub = Number(a.publico_total || 0);
      linhas.push('*#' + a.numero + '* · ' + String(a.tipo).toUpperCase() + (a.modo_teste ? ' · teste' : ''));
      linhas.push(String(a.titulo));
      linhas.push((pub ? pub + ' cliente(s) · ' : '') + 'custo ' + brl(a.custo_estimado) + ' · esperado ' + brl(a.receita_esperada));
      if (a.justificativa) linhas.push('_' + String(a.justificativa).slice(0, 220) + '_');
      linhas.push('');
    }
    if (pend.length > 8) linhas.push('… e mais ' + (pend.length - 8) + ' na tela /marketing.');
    linhas.push('Responda: *OK 12* · *NAO 12* · *OK TUDO* · *OK 12 MENOS 3,7* (tira o 3º e o 7º cliente) · *CAIXA* (lista de novo)');
  } else {
    linhas.push('Nada esperando decisão hoje.');
  }
  if (extras.autoHoje?.length) {
    linhas.push('');
    linhas.push('🤖 Feito sozinho hoje (dentro da política):');
    for (const a of extras.autoHoje.slice(0, 6)) linhas.push('• #' + a.numero + ' ' + a.titulo + ' — ' + (a.status === 'executada' ? 'ok' : a.status));
  }
  if (extras.medidas?.length) {
    linhas.push('');
    linhas.push('📈 Resultados fechados (14 dias):');
    for (const a of extras.medidas.slice(0, 5)) {
      const r = a.resultado || {};
      linhas.push('• #' + a.numero + ' ' + a.titulo + ': ' + (r.pedidos || 0) + ' pedido(s), ' + brl(r.receita) + ' (custo ' + brl(r.custo) + ')');
    }
  }
  if (extras.avisos?.length) { linhas.push(''); for (const v of extras.avisos.slice(0, 4)) linhas.push('⚠️ ' + v); }
  return linhas.join('\n');
}

export async function enviarResumo(opts: { avisos?: string[] } = {}): Promise<{ enviados: any[]; pendentes: number }> {
  const pend = await pendentes();
  const autoHoje: any = await db.execute(sql`SELECT numero, titulo, status FROM mkt_acoes WHERE nivel_efetivo < 2
    AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY numero`);
  const medidas: any = await db.execute(sql`SELECT numero, titulo, resultado FROM mkt_acoes WHERE medido_em >= now() - interval '1 day' ORDER BY numero`);
  // Pendências dos outros módulos que hoje só iam para o console.warn
  const avisos = [...(opts.avisos || [])];
  try {
    const l: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM mkt_lotes WHERE status = 'previsto' AND acao_id IS NULL`);
    if (Number(l.rows?.[0]?.n)) avisos.push(l.rows[0].n + ' lote(s) de recompra montado(s) à mão esperando liberação em /marketing');
    const p: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM mkt_pieces WHERE estado = 'aguardando_aprovacao'`);
    if (Number(p.rows?.[0]?.n)) avisos.push(p.rows[0].n + ' peça(s) na fila de aprovação');
    const ag: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM mkt_pieces WHERE estado = 'agendado' AND agendado_para < now()`);
    if (Number(ag.rows?.[0]?.n)) avisos.push(ag.rows[0].n + ' peça(s) agendada(s) passaram da hora e não foram publicadas');
  } catch {}
  const texto = textoResumo(pend, { autoHoje: autoHoje.rows || [], medidas: medidas.rows || [], avisos });
  const { enviarInterno } = await import('./envio-texto');
  const enviados: any[] = [];
  for (const tel of await aprovadores()) enviados.push({ para: tel, ...(await enviarInterno(tel, texto)) });
  if (!enviados.length) console.warn('[MKT-ACOES] nenhum aprovador cadastrado (telefone_gestor_relatorios / mkt_aprovadores) — resumo nao enviado');
  return { enviados, pendentes: pend.length };
}

export type Interpretacao = { decisao: 'aprovar' | 'rejeitar' | null; tudo: boolean; numeros: number[]; excluir: string[]; ajuda: boolean };

/** "OK 12", "ok 12 14", "nao 12", "OK TUDO", "ok 12 menos 3,7", "caixa" (lista as pendentes) */
export function interpretar(texto: string): Interpretacao {
  const t = String(texto || '').trim().toLowerCase().replace(/[!.]/g, ' ');
  const out: Interpretacao = { decisao: null, tudo: false, numeros: [], excluir: [], ajuda: false };
  if (/^(caixa|pendentes?|acoes|ações)$/.test(t)) { out.ajuda = true; return out; }
  const m = t.match(/^(ok|sim|aprov[oa]r?|aprovado|libera(r)?|n[aã]o|nao|recus[oa]r?|rejeit[oa]r?|reprov[oa]r?)\b(.*)$/);
  if (!m) return out;
  out.decisao = /^(ok|sim|aprov|libera)/.test(m[1]) ? 'aprovar' : 'rejeitar';
  let resto = m[3] || '';
  const menos = resto.match(/\b(menos|exceto|sem|tirando)\b(.*)$/);
  if (menos) { out.excluir = (menos[2].match(/\d+/g) || []); resto = resto.slice(0, menos.index); }
  if (/\b(tudo|todas|todos|all)\b/.test(resto)) out.tudo = true;
  out.numeros = (resto.replace(/#/g, ' ').match(/\d+/g) || []).map(Number);
  return out;
}

/**
 * Trata uma mensagem recebida de um aprovador. Devolve o texto de resposta, ou
 * null se a mensagem não é uma decisão (aí o fluxo normal segue).
 */
export async function responderWhatsApp(telefone: string, texto: string): Promise<string | null> {
  if (!(await garantirSchema())) return null;
  const lista = await aprovadores();
  if (!ehAprovador(telefone, lista)) return null;
  const it = interpretar(texto);
  if (!it.decisao && !it.ajuda) return null;
  // "ok" / "não" sem número é conversa, não decisão — o gestor também fala com o número da empresa.
  if (!it.ajuda && !it.tudo && !it.numeros.length) return null;

  let resposta: string;
  if (it.ajuda) {
    resposta = textoResumo(await pendentes());
  } else {
    let ids: string[] = [];
    if (it.tudo) ids = (await pendentes()).map(a => String(a.id));
    else ids = it.numeros.map(String);
    if (!ids.length) resposta = 'Não entendi qual ação. Ex.: *OK 12*, *NAO 12* ou *OK TUDO*.';
    else {
      const r = await decidir({ ids, decisao: it.decisao!, quem: 'whatsapp:' + telefone.replace(/\D/g, ''), via: 'whatsapp', excluirClientes: it.excluir });
      const partes: string[] = [];
      partes.push((it.decisao === 'aprovar' ? '✅ Aprovada(s): ' : '⛔ Rejeitada(s): ') + r.aplicadas);
      for (const e of r.execucoes) {
        const a = await ver(e.id);
        partes.push('#' + (a?.numero ?? '?') + ' → ' + (e.ok ? resumoExecucao(e.detalhe) : 'falhou: ' + e.erro));
      }
      if (r.ignoradas.length) partes.push('Ignorei (já decididas ou inexistentes): ' + r.ignoradas.join(', '));
      const rest = await pendentes();
      partes.push(rest.length ? rest.length + ' ainda esperando.' : 'Caixa vazia. 👍');
      resposta = partes.join('\n');
    }
  }
  try {
    await db.execute(sql`INSERT INTO mkt_decisoes_whatsapp (telefone, texto, interpretacao, aplicada, resposta)
      VALUES (${telefone}, ${texto}, ${JSON.stringify(it)}::jsonb, ${!it.ajuda}, ${resposta})`);
  } catch {}
  return resposta;
}

function resumoExecucao(d: any): string {
  if (!d) return 'ok';
  if (d.simulado) return 'simulado (modo teste)';
  if (d.loteId) return (d.montados ?? 0) + ' mensagem(ns) na fila do 1841' + (d.bloqueados ? ', ' + d.bloqueados + ' bloqueada(s)' : '');
  if (d.enviados) return 'aviso enviado';
  if (d.campanhaId) return 'campanha ' + d.codigo + (d.link ? ' + link /r/' + d.link : '');
  if (d.pecaId) return 'peça criada e enviada ao revisor';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Panorama para a tela
// ---------------------------------------------------------------------------
export async function panorama(): Promise<any> {
  if (!(await garantirSchema())) return { ok: false };
  const k: any = await db.execute(sql.raw(`
    SELECT COUNT(*) FILTER (WHERE status = 'proposta')::int AS pendentes,
           COUNT(*) FILTER (WHERE status IN ('executada') AND criado_em >= now() - interval '30 days')::int AS executadas30,
           COUNT(*) FILTER (WHERE nivel_efetivo < 2 AND criado_em >= now() - interval '30 days')::int AS automaticas30,
           COUNT(*) FILTER (WHERE status = 'rejeitada' AND criado_em >= now() - interval '30 days')::int AS rejeitadas30,
           COALESCE(SUM((resultado->>'receita')::numeric) FILTER (WHERE medido_em IS NOT NULL AND criado_em >= now() - interval '90 days'),0)::float AS receita90,
           COALESCE(SUM(custo_estimado) FILTER (WHERE status = 'executada' AND criado_em >= now() - interval '90 days'),0)::float AS custo90,
           COALESCE(SUM(receita_esperada) FILTER (WHERE status = 'proposta'),0)::float AS esperadoPendente,
           AVG(EXTRACT(EPOCH FROM (decidido_em - criado_em))/3600) FILTER (WHERE decidido_em IS NOT NULL AND criado_em >= now() - interval '30 days')::float AS horasAteDecisao
      FROM mkt_acoes`));
  return {
    ok: true,
    kpis: k.rows?.[0] || {},
    pendentes: await pendentes(),
    recentes: await listar({ limite: 40 }),
    politicas: await politicas(),
    aprovadores: await aprovadores(),
  };
}
