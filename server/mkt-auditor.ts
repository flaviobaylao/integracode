// ============================================================================
// CENTRAL DE MARKETING — AUDITOR DA CENTRAL (agente mkt_auditor)
// ----------------------------------------------------------------------------
// O agente que olha para o PROPRIO sistema de marketing, todo dia, e pergunta:
// "esta tudo rodando? esta rendendo? o que eu mudaria?"
//
// Tres camadas, nesta ordem:
//   1. CHECAGENS deterministicas (SQL/config) — ~25 verificacoes com gravidade
//      (ok | atencao | alerta): crons que nao rodaram, acoes em erro, aprovacoes
//      lentas, templates faltando, criativos sem tag/direitos, custo de IA,
//      conversao medida x esperada, links sem clique, fila parada, chaves...
//   2. AUTOCORRECOES seguras (N0, reversiveis, sem dinheiro, sem cliente):
//      expirar acoes vencidas, descartar lote orfao, recalcular familias,
//      taguear criativos pendentes, calcular hashes pendentes.
//   3. MELHORIAS propostas pelo modelo (Sonnet) sobre as checagens + tendencias:
//      cada uma vira uma ACAO do tipo 'sistema' na Caixa (ajuste de parametro
//      dentro de limites, politica de autonomia, prompt de agente) — N2 por
//      padrao. Com `mkt_auditor_autoajuste=on`, ajustes de PARAMETRO dentro dos
//      limites (AJUSTES_PERMITIDOS) executam sozinhos e informam; politica e
//      prompt continuam sempre com o humano.
//
// Cada rodada grava um diagnostico (mkt_diagnosticos) — a serie mostra se o
// sistema esta melhorando. Roda 05:45 (antes do Radar) e sob demanda.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_auditor';

export type Checagem = { id: string; area: string; gravidade: 'ok' | 'atencao' | 'alerta'; titulo: string; detalhe: string; valor?: any; autofix?: string | null };

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function q1(query: string): Promise<any> { try { const r: any = await db.execute(sql.raw(query)); return r.rows?.[0] || {}; } catch { return {}; } }
async function rows(query: string): Promise<any[]> { try { const r: any = await db.execute(sql.raw(query)); return r.rows || []; } catch { return []; } }

export async function ensureMktAuditorSchema(): Promise<void> {
  try {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS mkt_diagnosticos (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), data date NOT NULL, nota int, checagens jsonb, autofix jsonb, melhorias jsonb, texto text, modelo varchar, criado_em timestamptz NOT NULL DEFAULT now())"));
    await db.execute(sql.raw("CREATE INDEX IF NOT EXISTS idx_mkt_diag_data ON mkt_diagnosticos (data DESC)"));
  } catch (e: any) { console.error('[MKT-AUDITOR] schema:', e?.message || e); }
}

export async function autoajuste(): Promise<boolean> { return (await getSetting('mkt_auditor_autoajuste', 'off')) === 'on'; }

// ---------------------------------------------------------------------------
// 1. CHECAGENS
// ---------------------------------------------------------------------------
export async function checar(): Promise<Checagem[]> {
  const c: Checagem[] = [];
  const add = (id: string, area: string, gravidade: Checagem['gravidade'], titulo: string, detalhe: string, valor?: any, autofix: string | null = null) => c.push({ id, area, gravidade, titulo, detalhe, valor, autofix });

  // --- infra / chaves / modos ---
  add('chave_anthropic', 'infra', process.env.ANTHROPIC_API_KEY ? 'ok' : 'alerta', 'Chave da Anthropic', process.env.ANTHROPIC_API_KEY ? 'presente' : 'ANTHROPIC_API_KEY ausente: nenhum agente de marketing roda');
  const radarModo = await getSetting('mkt_radar_modo', 'test');
  add('radar_modo', 'radar', radarModo === 'on' ? 'ok' : (radarModo === 'test' ? 'atencao' : 'alerta'), 'Modo do Radar', radarModo === 'on' ? 'ligado' : radarModo === 'test' ? 'em teste: propõe, mas nada executa sozinho' : 'desligado', radarModo);
  const contModo = await getSetting('mkt_conteudo_modo', 'off');
  add('conteudo_modo', 'conteudo', contModo === 'on' ? 'ok' : 'atencao', 'Agente de conteúdo', contModo === 'on' ? 'ligado' : 'em ' + contModo + ': nenhuma peça nasce sozinha', contModo);
  try {
    const { status: igStatus } = await import('./mkt-ig-auth');
    const ig = await igStatus();
    if (ig.conectado) {
      const d = Number(ig.diasRestantes ?? 99);
      add('instagram_token', 'conteudo', d <= 5 ? 'alerta' : d <= 20 ? 'atencao' : 'ok', 'Instagram conectado', '@' + ig.username + ' · token vence em ' + d + ' dia(s)' + (ig.podePublicar ? ' · pode publicar' : ' · SEM permissão de publicar (reconectar)'), { username: ig.username, dias: d, perms: ig.permissoes });
    } else {
      add('instagram_token', 'conteudo', ig.origem === 'env' ? 'atencao' : 'alerta', 'Instagram conectado', ig.origem === 'env' ? 'usando IG_PAGE_TOKEN do env (sem renovação automática) — conecte pela Central' : (ig.faltaEnv?.length ? 'faltam ' + ig.faltaEnv.join(', ') + ' no Railway' : 'não conectado: clique em Conectar Instagram'), ig.origem);
    }
    const pubModo = await getSetting('mkt_publicador_modo', 'test');
    add('publicador_modo', 'conteudo', pubModo === 'on' ? 'ok' : 'atencao', 'Publicador do Instagram', pubModo === 'on' ? 'ligado: peça aprovada vai ao ar sozinha' : pubModo === 'test' ? 'em teste: a Meta valida a foto, mas quem posta ainda é o humano' : 'desligado', pubModo);
  } catch {}
  try {
    const ads = await import('./mkt-meta-ads');
    const pr = ads.pronto(); const am = await ads.modo();
    add('meta_ads', 'anuncio', pr.ok ? (am === 'on' ? 'ok' : 'atencao') : 'atencao', 'Anúncio pago na Meta', pr.ok ? (am === 'on' ? 'conta configurada, anúncios ligados' : 'conta configurada, modo ' + am + ' (anúncio aprovado só valida a conta)') : 'sem conta: faltam ' + pr.falta.join(', ') + ' — o Radar não propõe anúncio', { pronto: pr.ok, modo: am });
  } catch {}
  const aprov = await (await import('./mkt-acoes')).aprovadores();
  add('aprovadores', 'caixa', aprov.length ? 'ok' : 'alerta', 'Aprovadores no WhatsApp', aprov.length ? aprov.length + ' número(s)' : 'nenhum: resumo e decisões por WhatsApp não funcionam (telefone_gestor_relatorios / mkt_aprovadores)', aprov.length);
  const disp = await getSetting('oficial_dispatch_mode', 'off'), rec = await getSetting('oficial_recompra', 'off');
  add('canal_oficial', 'regua', disp !== 'off' && rec !== 'off' ? 'ok' : 'alerta', 'Canal oficial 1841 para a régua', disp !== 'off' && rec !== 'off' ? 'disparo ' + disp + ', recompra ' + rec : 'oficial_dispatch_mode=' + disp + ', oficial_recompra=' + rec + ': régua aprovada não sai', { disp, rec });
  try {
    const { categoriasAprovadas } = await import('./mkt-recompra');
    const cats = await categoriasAprovadas();
    add('templates', 'regua', cats.faltando.length ? 'alerta' : 'ok', 'Templates da régua na Meta', cats.faltando.length ? 'faltam: ' + cats.faltando.join(', ') : 'todos cadastrados', cats.faltando);
    const mkt = Array.from(cats.mapa.entries()).filter(([, v]) => v === 'MARKETING').map(([k]) => k);
    if (mkt.length) add('templates_marketing', 'regua', 'atencao', 'Templates aprovados como MARKETING', mkt.join(', ') + ' custam R$ 0,34 em vez de R$ 0,04 — vale resubmeter como utility', mkt);
  } catch {}

  // --- crons rodaram? ---
  const runs = await rows(`SELECT agente, MAX(criado_em) AS ultimo, COUNT(*) FILTER (WHERE criado_em >= now() - interval '7 days')::int AS n7, COUNT(*) FILTER (WHERE sucesso = false AND criado_em >= now() - interval '7 days')::int AS falhas7 FROM mkt_agent_runs WHERE agente LIKE 'mkt_%' GROUP BY agente`);
  const ultimo = (ag: string) => runs.find(r => r.agente === ag);
  const horas = (d: any) => d ? (Date.now() - new Date(d).getTime()) / 3600000 : Infinity;
  if (radarModo !== 'off') { const r = ultimo('mkt_radar'); add('radar_rodou', 'radar', horas(r?.ultimo) < 30 ? 'ok' : 'alerta', 'Radar rodou nas últimas 30 h', r ? 'última ' + new Date(r.ultimo).toLocaleString('pt-BR') + ' · ' + r.n7 + ' execuções/7d · ' + r.falhas7 + ' falha(s)' : 'nunca rodou', r || null); }
  if (contModo === 'on') { const r = ultimo('mkt_conteudo'); add('conteudo_rodou', 'conteudo', horas(r?.ultimo) < 72 ? 'ok' : 'atencao', 'Conteúdo escreveu nos últimos 3 dias', r ? 'última ' + new Date(r.ultimo).toLocaleString('pt-BR') : 'ligado mas nunca escreveu — veja os portões (foto elegível, base de conhecimento)', r || null); }
  for (const r of runs) if (r.falhas7 >= 3) add('falhas_' + r.agente, 'infra', 'atencao', 'Falhas do agente ' + r.agente, r.falhas7 + ' falha(s) em 7 dias (teto? JSON inválido? veja mkt_agent_runs.erro)', r.falhas7);

  // --- caixa ---
  const cx = await q1(`SELECT COUNT(*) FILTER (WHERE status = 'proposta')::int AS pend,
    COUNT(*) FILTER (WHERE status = 'proposta' AND criado_em < now() - interval '24 hours')::int AS pend24,
    COUNT(*) FILTER (WHERE status = 'expirada' AND criado_em >= now() - interval '14 days')::int AS exp14,
    COUNT(*) FILTER (WHERE status = 'erro' AND criado_em >= now() - interval '7 days')::int AS erro7,
    COUNT(*) FILTER (WHERE status = 'rejeitada' AND COALESCE(comentario,'') NOT ILIKE 'duplicada%' AND criado_em >= now() - interval '14 days')::int AS rej14,
    COUNT(*) FILTER (WHERE status IN ('aprovada','executada') AND nivel_efetivo = 2 AND criado_em >= now() - interval '14 days')::int AS apr14,
    AVG(EXTRACT(EPOCH FROM (decidido_em - criado_em))/3600) FILTER (WHERE decidido_em IS NOT NULL AND criado_em >= now() - interval '14 days')::float AS horas
    FROM mkt_acoes`);
  add('caixa_pendentes', 'caixa', Number(cx.pend24) > 5 ? 'alerta' : Number(cx.pend24) > 0 ? 'atencao' : 'ok', 'Ações esperando há mais de 24 h', cx.pend24 + ' de ' + cx.pend + ' pendente(s)', cx.pend24);
  add('caixa_expiradas', 'caixa', Number(cx.exp14) >= 5 ? 'alerta' : Number(cx.exp14) > 0 ? 'atencao' : 'ok', 'Ações expiradas sem decisão (14 d)', cx.exp14 + ' — se o aprovador não decide, a Central para', cx.exp14);
  add('caixa_erros', 'caixa', Number(cx.erro7) >= 3 ? 'alerta' : Number(cx.erro7) > 0 ? 'atencao' : 'ok', 'Ações com erro (7 d)', String(cx.erro7), cx.erro7);
  const dec = Number(cx.rej14) + Number(cx.apr14);
  if (dec >= 5) add('caixa_taxa', 'caixa', Number(cx.rej14) / dec > 0.5 ? 'alerta' : 'ok', 'Taxa de aprovação humana (14 d)', Math.round(Number(cx.apr14) / dec * 100) + '% (' + cx.apr14 + ' de ' + dec + ')', { apr: cx.apr14, rej: cx.rej14 });
  if (cx.horas != null) add('caixa_tempo', 'caixa', Number(cx.horas) > 24 ? 'atencao' : 'ok', 'Tempo médio até decidir', Number(cx.horas).toFixed(1) + ' h', Number(cx.horas));
  const erros = await rows(`SELECT execucao->>'erro' AS erro, COUNT(*)::int AS n FROM mkt_acoes WHERE status = 'erro' AND criado_em >= now() - interval '7 days' GROUP BY 1 ORDER BY n DESC LIMIT 5`);
  for (const e of erros) if (Number(e.n) >= 2) add('erro_rep', 'caixa', 'alerta', 'Erro repetido na execução', String(e.erro).slice(0, 160) + ' (' + e.n + '×)', e);

  // --- regua: conversao medida x esperada, N1 elegivel ---
  const reguas = await rows(`SELECT f.regua, COUNT(*)::int AS enviados, COUNT(sc.id)::int AS pedidos FROM mkt_fila_toques f LEFT JOIN sales_cards sc ON sc.customer_id = f.cliente_id AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days' WHERE f.status = 'enfileirado' AND f.liberado_em >= now() - interval '90 days' GROUP BY f.regua`);
  try {
    const { REGUAS } = await import('./mkt-recompra');
    for (const r of reguas) {
      const def = REGUAS.find(x => x.id === r.regua); if (!def || Number(r.enviados) < 20) continue;
      const medida = Number(r.pedidos) / Number(r.enviados);
      const desvio = medida / def.conversaoEsperada;
      if (desvio < 0.5) add('regua_conv_' + r.regua, 'regua', 'atencao', 'Régua ' + r.regua + ' rende menos que o esperado', (medida * 100).toFixed(1) + '% medido vs ' + (def.conversaoEsperada * 100).toFixed(0) + '% esperado em ' + r.enviados + ' msgs — receita esperada das ações está inflada', { medida, esperada: def.conversaoEsperada });
      else if (desvio > 1.5) add('regua_conv_' + r.regua, 'regua', 'ok', 'Régua ' + r.regua + ' rende acima do esperado', (medida * 100).toFixed(1) + '% vs ' + (def.conversaoEsperada * 100).toFixed(0) + '% — cabe aumentar o lote', { medida, esperada: def.conversaoEsperada });
    }
  } catch {}
  const pol = await q1(`SELECT nivel_padrao, amostra_minima, taxa_aprovacao_minima FROM mkt_politicas WHERE tipo = 'regua'`);
  if (pol.nivel_padrao != null && Number(pol.nivel_padrao) === 2) {
    const h = await q1(`SELECT COUNT(*) FILTER (WHERE status IN ('aprovada','executada'))::int AS ap, COUNT(*) FILTER (WHERE status = 'rejeitada' AND COALESCE(comentario,'') NOT ILIKE 'duplicada%')::int AS rj FROM mkt_acoes WHERE tipo = 'regua' AND nivel_efetivo = 2 AND decidido_em >= now() - interval '30 days'`);
    const n = Number(h.ap) + Number(h.rj);
    if (n >= Number(pol.amostra_minima) && Number(h.ap) / n >= Number(pol.taxa_aprovacao_minima)) add('n1_elegivel', 'politica', 'atencao', 'Régua elegível para N1', 'você aprovou ' + h.ap + ' de ' + n + ' réguas em 30 d (' + Math.round(Number(h.ap) / n * 100) + '%). A política pode ir para N1: réguas utility dentro do teto saem sozinhas', { ap: h.ap, n });
  }
  const lotesOrfaos = await q1(`SELECT COUNT(*)::int AS n FROM mkt_lotes WHERE status = 'previsto' AND criado_em < now() - interval '2 days'`);
  if (Number(lotesOrfaos.n)) add('lotes_orfaos', 'regua', 'atencao', 'Lotes de recompra parados há 2+ dias', String(lotesOrfaos.n), lotesOrfaos.n, 'descartar_lotes');

  // --- conteudo / criativos ---
  const pc = await q1(`SELECT COUNT(*) FILTER (WHERE estado = 'aguardando_aprovacao')::int AS fila, COUNT(*) FILTER (WHERE estado IN ('aprovado','agendado') AND atualizado_em < now() - interval '3 days')::int AS paradas, COUNT(*) FILTER (WHERE estado = 'bloqueado')::int AS bloq FROM mkt_pieces`);
  add('pecas_fila', 'conteudo', Number(pc.fila) > 10 ? 'atencao' : 'ok', 'Peças na fila de aprovação', String(pc.fila), pc.fila);
  add('pecas_paradas', 'conteudo', Number(pc.paradas) > 0 ? 'atencao' : 'ok', 'Peças aprovadas sem postar há 3+ dias', String(pc.paradas), pc.paradas);
  if (Number(pc.bloq) > 3) add('pecas_bloq', 'conteudo', 'atencao', 'Peças bloqueadas pelo revisor', pc.bloq + ' — o prompt do conteúdo pode estar gerando claim/fato errado', pc.bloq);
  const as = await q1(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE direitos_ok = true)::int AS ok, COUNT(*) FILTER (WHERE visao_em IS NULL)::int AS semvisao, COUNT(*) FILTER (WHERE phash IS NULL)::int AS semhash, COUNT(*) FILTER (WHERE direitos_ok = true AND (tags->'gancho' IS NULL OR jsonb_array_length(tags->'gancho') = 0))::int AS semgancho FROM mkt_assets WHERE COALESCE(ativo,true) = true`);
  add('criativos_direitos', 'conteudo', Number(as.total) && Number(as.ok) / Number(as.total) < 0.3 ? 'atencao' : 'ok', 'Criativos com direitos liberados', as.ok + ' de ' + as.total, { ok: as.ok, total: as.total });
  if (Number(as.semvisao) > 0) add('criativos_visao', 'conteudo', 'atencao', 'Criativos sem passar pela visão', String(as.semvisao), as.semvisao, 'visao_lote');
  if (Number(as.semhash) > 0) add('criativos_hash', 'conteudo', 'atencao', 'Criativos sem hash (família)', String(as.semhash), as.semhash, 'hash_lote');
  if (Number(as.semgancho) > 0) add('criativos_semgancho', 'conteudo', 'atencao', 'Criativos liberados sem gancho', as.semgancho + ' — não podem virar peça', as.semgancho);
  try {
    const { buscar, GANCHOS } = await import('./mkt-assets');
    let b2b = 0; for (const g of GANCHOS as readonly string[]) b2b += (await buscar({ soElegiveis: true, publico: 'b2b', gancho: g, limite: 5 } as any).catch(() => [])).length;
    add('criativos_b2b', 'conteudo', b2b === 0 ? 'alerta' : 'ok', 'Fotos elegíveis para B2B', b2b === 0 ? 'nenhuma: 70% do negócio é revenda e o agente não consegue escrever para ele' : b2b + ' foto(s)', b2b);
  } catch {}
  const marca = await q1(`SELECT versao FROM mkt_brand_voice WHERE ativo = true LIMIT 1`);
  if (marca.versao != null && Number(marca.versao) < 2) add('marca_v1', 'conteudo', 'alerta', 'Cartão de marca ainda na v1', 'a v1 diz "produzido em Goiânia" (a fábrica é Bela Vista); a v2 automática não rodou', marca.versao);
  const base = await q1(`SELECT COALESCE(MAX(LENGTH(base_conhecimento)),0)::int AS n FROM agentes_config`);
  add('base_conhecimento', 'conteudo', Number(base.n) < 300 ? 'alerta' : 'ok', 'Base de conhecimento (fatos da empresa)', Number(base.n) < 300 ? 'vazia ou curta demais (' + base.n + ' caracteres): o agente de conteúdo se recusa a escrever sem fatos' : base.n + ' caracteres', base.n);

  // --- atribuicao ---
  const at = await q1(`SELECT (SELECT COUNT(*) FROM mkt_links WHERE ativo = true)::int AS links, (SELECT COUNT(*) FROM mkt_links WHERE ativo = true AND cliques = 0 AND criado_em < now() - interval '30 days')::int AS mortos,
    (SELECT COUNT(*) FROM sales_cards WHERE created_at >= now() - interval '30 days' AND campaign_id IS NOT NULL)::int AS comcamp,
    (SELECT COUNT(*) FROM sales_cards WHERE created_at >= now() - interval '30 days' AND COALESCE(sale_value,0) > 0)::int AS total`);
  if (Number(at.mortos) > 5) add('links_mortos', 'atribuicao', 'atencao', 'Links sem nenhum clique em 30+ dias', String(at.mortos), at.mortos);
  add('cobertura', 'atribuicao', 'ok', 'Pedidos com código de campanha (30 d)', at.comcamp + ' de ' + at.total, { comcamp: at.comcamp, total: at.total });
  const capi = await getSetting('mkt_capi_mode', 'off');
  if (process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN && capi === 'off') add('capi_off', 'atribuicao', 'atencao', 'CAPI configurado mas desligado', 'Pixel e token existem; mkt_capi_mode=off — a Meta não recebe Purchase', capi);

  // --- custo ---
  const custo = await q1(`SELECT COALESCE(SUM(custo_brl),0)::float AS mes, COALESCE(SUM(custo_brl) FILTER (WHERE criado_em >= now() - interval '7 days'),0)::float AS sem, COUNT(*) FILTER (WHERE erro ILIKE '%teto%' AND criado_em >= now() - interval '7 days')::int AS tetos FROM mkt_agent_runs WHERE criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`);
  add('custo_ia', 'custo', Number(custo.sem) > 60 ? 'atencao' : 'ok', 'Custo de IA da Central', 'R$ ' + Number(custo.sem).toFixed(2) + ' em 7 d · R$ ' + Number(custo.mes).toFixed(2) + ' no mês', { sem: custo.sem, mes: custo.mes });
  if (Number(custo.tetos) > 0) add('tetos', 'custo', 'atencao', 'Agentes parados por teto diário (7 d)', custo.tetos + ' vez(es) — o teto pode estar baixo para o volume', custo.tetos);

  return c;
}

// ---------------------------------------------------------------------------
// 2. AUTOCORRECOES (sem dinheiro, sem cliente, reversiveis)
// ---------------------------------------------------------------------------
export async function autocorrigir(checagens: Checagem[]): Promise<any[]> {
  const feitas: any[] = [];
  const tem = (fix: string) => checagens.some(c => c.autofix === fix);
  try { const { expirar } = await import('./mkt-acoes'); const n = await expirar(); if (n) feitas.push({ fix: 'expirar_acoes', n }); } catch {}
  if (tem('descartar_lotes')) {
    try {
      const l = await rows(`SELECT id FROM mkt_lotes WHERE status = 'previsto' AND criado_em < now() - interval '2 days'`);
      const { descartarLote } = await import('./mkt-recompra');
      for (const x of l) await descartarLote(String(x.id));
      if (l.length) feitas.push({ fix: 'descartar_lotes', n: l.length });
    } catch {}
  }
  if (tem('hash_lote')) { try { const { calcularHashesPendentes } = await import('./mkt-semelhanca'); const r = await calcularHashesPendentes(60); if (r.feitos) feitas.push({ fix: 'hash_lote', n: r.feitos }); } catch {} }
  if (tem('visao_lote')) { try { const { classificarPendentes } = await import('./mkt-visao'); const r = await classificarPendentes(15); if (r.feitos) feitas.push({ fix: 'visao_lote', n: r.feitos }); } catch {} }
  try { const { corrigirGeografiaV2 } = await import('./mkt-marca'); const r = await corrigirGeografiaV2(); if (r.criou) feitas.push({ fix: 'marca_v2', versao: r.versao }); } catch {}
  return feitas;
}

// ---------------------------------------------------------------------------
// 3. MELHORIAS (modelo) -> acoes 'sistema'
// ---------------------------------------------------------------------------
const PROMPT_PADRAO = `Você é o auditor da Central de Marketing da Honest Sucos — um sistema em que agentes de IA propõem ações de venda (réguas de WhatsApp, alertas a vendedores, peças de conteúdo, visitas, cupons), um humano aprova, e o sistema executa e mede. Você recebe: as checagens do dia (com gravidade), as autocorreções já feitas, os parâmetros atuais e seus limites, as políticas de autonomia e os números de tendência. Sua função é propor de 0 a 5 MELHORIAS no próprio sistema, ranqueadas por impacto em vendas ÷ risco.

Tipos de melhoria permitidos:
- "setting": mudar um parâmetro de "parametros_ajustaveis" (só chaves listadas, valor dentro de min..max). Ex.: aumentar mkt_recompra_lote_max quando a régua converte acima do esperado.
- "politica": mudar nível/teto de uma política de autonomia (ex.: regua para N1 quando a taxa de aprovação humana está alta e a amostra bate).
- "prompt": reescrever o prompt de um agente mkt_* (radar, conteudo, revisor, analista, otimizador) quando as checagens mostram erro sistemático (peças bloqueadas por claim, ações rejeitadas pelo mesmo motivo). Só se tiver evidência; inclua o prompt completo novo.
- "humano": algo que só a pessoa resolve (cadastrar template na Meta, subir fotos de padaria, ligar o canal oficial). Sem executor: vira alerta.

Regras: nunca proponha aumentar gasto ou falar com cliente; nunca proponha mudar algo que já está "ok" sem ganho claro; uma melhoria por tema; cite a checagem que a motiva; português do Brasil, curto.

Responda SOMENTE JSON: {"nota":0-100,"resumo":"2 frases sobre a saúde do sistema","melhorias":[{"tipo":"setting|politica|prompt|humano","titulo":"...","motivo":"...","impacto":"alto|medio|baixo","setting":{"chave":"...","valor":n},"politica":{"tipo_acao":"regua","campos":{"nivel_padrao":1}},"prompt":{"agente":"mkt_radar","system_prompt":"..."}}]}`;

export async function rodar(opts: { quem?: string } = {}): Promise<any> {
  await ensureMktAuditorSchema();
  const t0 = Date.now();
  const checagens = await checar();
  const autofix = await autocorrigir(checagens);
  const alertas = checagens.filter(c => c.gravidade === 'alerta').length, atencoes = checagens.filter(c => c.gravidade === 'atencao').length;
  const notaBase = Math.max(0, 100 - alertas * 15 - atencoes * 5);

  // contexto para o modelo
  const { AJUSTES_PERMITIDOS, politicas } = await import('./mkt-acoes');
  const params: any = {};
  for (const k of Object.keys(AJUSTES_PERMITIDOS)) params[k] = { atual: await getSetting(k, ''), ...AJUSTES_PERMITIDOS[k] };
  let numeros: any = null;
  try { const { numerosDaSemana } = await import('./mkt-analista'); numeros = await numerosDaSemana(); } catch {}
  const diagAnteriores = await rows(`SELECT data, nota FROM mkt_diagnosticos ORDER BY data DESC LIMIT 7`);
  const propostasRecentes = await rows(`SELECT titulo, status, comentario FROM mkt_acoes WHERE tipo = 'sistema' AND criado_em >= now() - interval '14 days' ORDER BY criado_em DESC LIMIT 15`);

  let melhorias: any[] = [], resumo = '', nota = notaBase, modelo: string | null = null, criadas: any[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    const { chamarAgente } = await import('./mkt-llm');
    const r = await chamarAgente({
      agente: AGENTE, nome: 'Auditor da Central', promptPadrao: PROMPT_PADRAO, modeloPadrao: 'claude-sonnet-4-6', tetoPadrao: 2,
      user: JSON.stringify({ data: new Date().toISOString().slice(0, 10), checagens, autocorrecoes: autofix, parametros_ajustaveis: params, politicas: await politicas(), tendencia_semana: numeros, notas_anteriores: diagAnteriores, propostas_de_sistema_recentes: propostasRecentes }),
      maxTokens: 3500, temperature: 0.2, gatilho: opts.quem === 'cron' ? 'cron' : 'api',
    });
    modelo = r.modelo;
    if (r.ok && r.json) {
      resumo = String(r.json.resumo || '').slice(0, 600);
      if (Number.isFinite(Number(r.json.nota))) nota = Math.round((notaBase + Number(r.json.nota)) / 2);
      melhorias = Array.isArray(r.json.melhorias) ? r.json.melhorias.slice(0, 5) : [];
      criadas = await materializarMelhorias(melhorias, checagens);
    } else resumo = 'modelo indisponível (' + (r.erro || 'sem JSON') + '); só checagens e autocorreções';
  } else resumo = 'sem ANTHROPIC_API_KEY: só checagens e autocorreções';

  const texto = textoDiagnostico({ nota, resumo, checagens, autofix, criadas });
  try {
    await db.execute(sql`INSERT INTO mkt_diagnosticos (data, nota, checagens, autofix, melhorias, texto, modelo) VALUES (${new Date().toISOString().slice(0, 10)}, ${nota}, ${JSON.stringify(checagens)}::jsonb, ${JSON.stringify(autofix)}::jsonb, ${JSON.stringify({ propostas: melhorias, criadas })}::jsonb, ${texto}, ${modelo})`);
  } catch (e: any) { console.error('[MKT-AUDITOR] gravar:', e?.message || e); }
  return { ok: true, nota, resumo, checagens, autofix, melhorias: criadas, duracaoMs: Date.now() - t0, texto };
}

async function materializarMelhorias(melhorias: any[], checagens: Checagem[]): Promise<any[]> {
  const { criarAcao, AJUSTES_PERMITIDOS, executar } = await import('./mkt-acoes');
  const auto = await autoajuste();
  const out: any[] = [];
  const jaProposto = new Set((await rows(`SELECT titulo FROM mkt_acoes WHERE tipo IN ('sistema','alerta') AND agente = '${AGENTE}' AND status IN ('proposta','aprovada','auto','executada') AND criado_em >= now() - interval '7 days'`)).map(r => String(r.titulo)));
  for (const m of melhorias) {
    const titulo = String(m?.titulo || '').slice(0, 200); if (!titulo || jaProposto.has(titulo)) continue;
    const motivo = String(m?.motivo || '').slice(0, 1200);
    const tipo = String(m?.tipo || '');
    try {
      if (tipo === 'setting') {
        const chave = String(m.setting?.chave || ''); const regra = AJUSTES_PERMITIDOS[chave]; const v = Number(m.setting?.valor);
        if (!regra || !Number.isFinite(v) || v < regra.min || v > regra.max) { out.push({ titulo, descartada: 'setting fora da lista/limites' }); continue; }
        const atual = Number(await getSetting(chave, '')) ; if (atual === v) { out.push({ titulo, descartada: 'valor igual ao atual' }); continue; }
        const a = await criarAcao({ tipo: 'sistema', agente: AGENTE, titulo, justificativa: motivo, evidencia: { checagens: checagens.filter(c => c.gravidade !== 'ok').map(c => c.id), impacto: m.impacto }, parametros: { tipo: 'setting', chave, valor: v, antes: atual }, custoEstimado: 0, receitaEsperada: 0, nivelSugerido: auto ? 1 : 2 });
        if (auto) { await db.execute(sql`UPDATE mkt_acoes SET status = 'auto', nivel_efetivo = 1, motivo_nivel = 'mkt_auditor_autoajuste=on (parametro dentro dos limites)' WHERE id = ${a.id} AND status = 'proposta'`); const ex = await executar(a.id); out.push({ titulo, numero: a.numero, auto: true, ok: ex.ok, detalhe: ex.detalhe || ex.erro }); }
        else out.push({ titulo, numero: a.numero, auto: false });
      } else if (tipo === 'politica') {
        const ta = String(m.politica?.tipo_acao || ''); const campos = m.politica?.campos || {};
        if (!ta || !Object.keys(campos).length) { out.push({ titulo, descartada: 'politica sem campos' }); continue; }
        const a = await criarAcao({ tipo: 'sistema', agente: AGENTE, titulo, justificativa: motivo, evidencia: { impacto: m.impacto }, parametros: { tipo: 'politica', tipo_acao: ta, campos }, custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 2 });
        out.push({ titulo, numero: a.numero, auto: false });
      } else if (tipo === 'prompt') {
        const ag = String(m.prompt?.agente || ''); const sp = String(m.prompt?.system_prompt || '');
        if (!/^mkt_/.test(ag) || sp.length < 80) { out.push({ titulo, descartada: 'prompt invalido' }); continue; }
        const a = await criarAcao({ tipo: 'sistema', agente: AGENTE, titulo, justificativa: motivo, evidencia: { impacto: m.impacto }, parametros: { tipo: 'prompt', agente: ag, system_prompt: sp, motivo: titulo }, custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 2 });
        out.push({ titulo, numero: a.numero, auto: false });
      } else {
        const a = await criarAcao({ tipo: 'alerta', agente: AGENTE, titulo, justificativa: motivo, evidencia: { impacto: m.impacto }, parametros: { texto: '🔧 *Auditor da Central*\n' + titulo + '\n\n' + motivo }, custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 0 });
        out.push({ titulo, numero: a.numero, auto: true, humano: true });
      }
    } catch (e: any) { out.push({ titulo, erro: String(e?.message || e).slice(0, 120) }); }
  }
  try { const { processarAutomaticas } = await import('./mkt-acoes'); await processarAutomaticas(); } catch {}
  return out;
}

export function textoDiagnostico(d: { nota: number; resumo: string; checagens: Checagem[]; autofix: any[]; criadas: any[] }): string {
  const l: string[] = [];
  l.push('🔧 *Auditor da Central — nota ' + d.nota + '/100*');
  if (d.resumo) l.push(d.resumo);
  const ruins = d.checagens.filter(c => c.gravidade !== 'ok');
  if (ruins.length) { l.push(''); for (const c of ruins.slice(0, 10)) l.push((c.gravidade === 'alerta' ? '🔴 ' : '🟠 ') + c.titulo + ': ' + c.detalhe); }
  if (d.autofix.length) { l.push(''); l.push('Corrigi sozinho: ' + d.autofix.map(f => f.fix + (f.n ? ' (' + f.n + ')' : '')).join(', ')); }
  if (d.criadas.length) { l.push(''); l.push('Melhorias propostas: ' + d.criadas.filter(c => c.numero).map(c => '#' + c.numero + ' ' + c.titulo + (c.auto ? ' (aplicada)' : '')).join(' · ')); }
  return l.join('\n');
}

export async function ultimo(): Promise<any | null> {
  await ensureMktAuditorSchema();
  const r = await rows(`SELECT * FROM mkt_diagnosticos ORDER BY criado_em DESC LIMIT 1`);
  return r[0] || null;
}
export async function serie(dias = 30): Promise<any[]> {
  await ensureMktAuditorSchema();
  return rows(`SELECT data, nota FROM mkt_diagnosticos WHERE data >= current_date - ${Math.max(1, dias)} ORDER BY data`);
}
