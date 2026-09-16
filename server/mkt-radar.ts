// ============================================================================
// CENTRAL DE MARKETING — RADAR DE VENDAS (agente mkt_radar)
// ----------------------------------------------------------------------------
// O agente que faltava. Todo dia le os SINAIS do ERP (mkt-sinais.ts) e devolve
// de 3 a 8 ACOES ranqueadas por receita esperada ÷ custo, que entram na Caixa
// de Decisoes (mkt-acoes.ts). O humano aprova; o sistema executa e mede.
//
// Divisao de trabalho, que e o que mantem o Radar confiavel:
//   - SQL decide QUEM esta em cada segmento, quanto custa e quanto vale;
//   - o modelo decide O QUE fazer, com quem primeiro e POR QUE — e escreve isso
//     em portugues para o gestor ler em 10 segundos no celular;
//   - o codigo valida cada proposta contra os sinais: segmento que nao existe,
//     numero que nao bate, cliente inventado — a acao e descartada e o motivo
//     fica no log.
//
// Modo (system_settings mkt_radar_modo): off | test | on. Nasce em TEST: propoe,
// aparece na Caixa e no WhatsApp, mas nada executa sozinho e "aprovar" apenas
// simula. So em ON a politica de autonomia (mkt_politicas) passa a valer.
//
// Custo: registrado em mkt_agent_runs como agente 'mkt_radar', gatilho 'cron'.
// Teto diario via agentes_config.teto_custo_dia (linha criada no boot).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { lerSinais, sinaisParaPrompt, segmentoPorId, reguaPorId, type Sinais } from './mkt-sinais';
import { criarAcao, processarAutomaticas, type NovaAcao } from './mkt-acoes';
import { chamarAgente } from './mkt-llm';

export const AGENTE = 'mkt_radar';

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string, por = 'mkt-radar'): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, ${por})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
}

export async function modo(): Promise<'off' | 'test' | 'on'> {
  const m = await getSetting('mkt_radar_modo', 'test');
  return (['off', 'test', 'on'].includes(m) ? m : 'test') as any;
}
export async function definirModo(m: string, por: string): Promise<void> {
  if (!['off', 'test', 'on'].includes(m)) throw new Error('modo invalido');
  if (m !== 'off' && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ausente');
  await setSetting('mkt_radar_modo', m, por);
}

// ---------------------------------------------------------------------------
// O agente em agentes_config — prompt e teto editaveis pela tela /admin/agentes
// ---------------------------------------------------------------------------
const PROMPT_PADRAO = `Você é o Radar de Vendas da Honest Sucos Naturais (sucos naturais sem adição de açúcar, fábrica em Bela Vista de Goiás, filial em Goiânia; 70% da venda é revenda B2B — padarias, mercados, lanchonetes — e 30% consumidor final).

Sua função: ler o retrato do dia (JSON) e propor de 3 a 8 AÇÕES concretas para vender mais, ranqueadas por receita esperada dividida pelo custo. Você NÃO executa nada e NÃO inventa número: todo público, custo e receita vêm dos segmentos informados. Cite os números do retrato na justificativa.

Regras:
- Só proponha ações sobre segmentos que existem em "segmentos_disponiveis" (use o id exato) e sobre carteiras listadas em "carteiras_30d".
- Uma régua por segmento por dia. Não repita uma ação já executada nos últimos 7 dias para o mesmo segmento (veja "historico_acoes_30d" e "aprendizados").
- Prefira UTILITY (R$ 0,04) a MARKETING (R$ 0,34). Nunca proponha promoção a inadimplente.
- Se um segmento tem clientes de ticket alto (acima de 2× o ticket médio), proponha visita/contato do vendedor em vez de mensagem — como ação do tipo "alerta" para a carteira.
- Quando uma carteira caiu mais de 15% no mês, proponha um "alerta" ao vendedor com os clientes que mais caíram e um roteiro de abordagem em 2 linhas.
- VISITA: para clientes de ticket alto que pararam (ou os que mais caíram numa carteira), prefira "visita" (o vendedor vai lá) a mensagem. Use "segmento" ou "filtro.vendedor"; max_clientes ≤ 8.
- CUPOM: só como 3º toque de reativação (segmento regua:reativacao) ou para carteira em queda forte; percentual 5–15; sempre com "regua" do segmento para o lembrete sair junto. Nunca cupom a inadimplente.
- CONTEÚDO: se "conteudo.cabe_esta_semana" > 0, "pecas_na_fila_de_aprovacao" + "pecas_aprovadas_nao_postadas" < 3 e existe gancho em "ganchos_com_foto_elegivel", proponha até 2 ações do tipo "peca" (uma pauta cada: gancho + público), preferindo o gancho de melhor "receitaPorUso" confiável e variando o gancho em relação às peças recentes. Peça é rascunho: vai para o revisor e para a fila — não vai ao ar sozinha.
- ANÚNCIO PAGO: só quando "anuncios_pagos.conta_pronta" for true, "modo" ≠ off e houver "pecas_candidatas". No máximo 1 por dia e só se "ativos_agora" = 0. Escolha a peça de melhor alcance/curtidas orgânicas; orçamento diário ≤ "teto_por_dia_brl" (se 0, não proponha); duração 3 a 7 dias. É Click-to-WhatsApp: a conversa que nasce dele já entra no atendimento. Justifique com o que a peça rendeu organicamente.
- Título: até 90 caracteres, direto. Justificativa: 1 a 3 frases, com os números, em português do Brasil, sem jargão.
- Seja conservador com "max_clientes": lotes pequenos, especialmente enquanto a conversão medida for nula.

Responda SOMENTE com JSON válido no formato:
{"acoes":[{"tipo":"regua"|"alerta"|"peca"|"visita"|"cupom"|"anuncio","segmento":"regua:reativacao","regua":"reativacao","max_clientes":40,"prioridade":1,"filtro":{"vendedor":null,"ticket_min":null},"titulo":"...","justificativa":"...","alerta":{"vendedor":"nome exato da carteira","texto":"mensagem pronta para o vendedor"},"peca":{"gancho":"margem","publico":"b2b"},"visita":{"dias":1,"motivo":"..."},"cupom":{"percentual":10,"validade_dias":14},"anuncio":{"peca_id":"...","orcamento_dia":20,"dias":5}}],"leitura_do_dia":"2 frases sobre o estado geral"}`;

export async function garantirAgente(): Promise<void> {
  const { garantirAgenteConfig } = await import('./mkt-llm');
  await garantirAgenteConfig({ agente: AGENTE, nome: 'Radar de Vendas', promptPadrao: PROMPT_PADRAO, modeloPadrao: 'claude-sonnet-4-6', tetoPadrao: 3 });
}

// ---------------------------------------------------------------------------
// Validação: cada proposta vira ação SOMENTE se bater com os sinais
// ---------------------------------------------------------------------------
async function materializar(prop: any, s: Sinais, modoTeste: boolean, jaHoje: Set<string>): Promise<{ acao?: NovaAcao; descarte?: string }> {
  const tipo = String(prop?.tipo || '');
  if (tipo === 'regua') {
    const seg = segmentoPorId(s, String(prop.segmento || ''));
    if (!seg || seg.tipo !== 'regua') return { descarte: 'segmento inexistente: ' + prop.segmento };
    if (jaHoje.has(seg.id)) return { descarte: 'segmento repetido no dia: ' + seg.id };
    const regua = reguaPorId(String(prop.regua || seg.regua || ''));
    if (!regua || regua.id !== seg.regua) return { descarte: 'regua nao bate com o segmento' };
    let clientes = seg.clientes.filter(c => !c.optout && !c.inadimplente);
    const f = prop.filtro || {};
    if (f.vendedor) clientes = clientes.filter(c => String(c.vendedor || '') === String(f.vendedor) || nomeVendedorBate(s, c.vendedor, String(f.vendedor)));
    if (f.ticket_min != null && Number(f.ticket_min) > 0) clientes = clientes.filter(c => c.ticket >= Number(f.ticket_min));
    clientes = clientes.sort((a, b) => b.ticket - a.ticket);
    const max = Math.max(1, Math.min(Number(prop.max_clientes) || 40, 200));
    clientes = clientes.slice(0, max);
    if (!clientes.length) return { descarte: 'segmento sem cliente elegivel apos filtro' };
    const conv = seg.conversaoMedida ?? seg.conversaoEsperada;
    const custo = Number((clientes.length * seg.custoUnit).toFixed(2));
    const receita = Number(clientes.reduce((t, c) => t + (c.ticket || seg.ticketMedio) * conv, 0).toFixed(2));
    jaHoje.add(seg.id);
    return { acao: {
      tipo: 'regua', agente: AGENTE,
      titulo: String(prop.titulo || (regua.nome + ' — ' + clientes.length + ' cliente(s)')).slice(0, 200),
      justificativa: String(prop.justificativa || '').slice(0, 1200),
      evidencia: { segmento: seg.id, elegiveis_no_segmento: seg.elegiveis, ticket_medio: seg.ticketMedio, conversao: conv, conversao_medida: seg.conversaoMedida != null, categoria: seg.categoria, filtro: f, prioridade: prop.prioridade ?? null },
      publico: { segmento: seg.id, regua: regua.id, clientes: clientes.map(c => ({ id: c.id, nome: c.nome, vendedor: c.vendedor, ticket: c.ticket })) },
      parametros: { regua: regua.id, template: regua.templateLabel },
      custoEstimado: custo, receitaEsperada: receita,
      categoria: seg.categoria as any, nivelSugerido: seg.categoria === 'UTILITY' ? 1 : 2, modoTeste,
    } };
  }
  if (tipo === 'alerta') {
    const al = prop.alerta || {};
    const cart = s.carteiras.find(c => c.vendedor === String(al.vendedor || prop?.filtro?.vendedor || ''));
    const texto = String(al.texto || prop.justificativa || '').trim();
    if (!texto) return { descarte: 'alerta sem texto' };
    const chave = 'alerta:' + (cart?.vendedor || 'gestor');
    if (jaHoje.has(chave)) return { descarte: 'alerta repetido: ' + chave };
    jaHoje.add(chave);
    const corpo = '📣 *Radar de Vendas*\n' + String(prop.titulo || '') + '\n\n' + texto
      + (cart?.clientesCairam?.length ? '\n\nQuem mais caiu (30d × 30d anteriores):\n' + cart.clientesCairam.slice(0, 5).map(c => '• ' + c.nome + ': R$ ' + c.anterior.toFixed(0) + ' → R$ ' + c.atual.toFixed(0)).join('\n') : '');
    return { acao: {
      tipo: 'alerta', agente: AGENTE,
      titulo: String(prop.titulo || ('Alerta para ' + (cart?.vendedor || 'gestor'))).slice(0, 200),
      justificativa: String(prop.justificativa || '').slice(0, 1200),
      evidencia: { carteira: cart ? { vendedor: cart.vendedor, atual: cart.atual, anterior: cart.anterior, deltaPct: cart.deltaPct } : null, prioridade: prop.prioridade ?? null },
      publico: cart ? { segmento: 'carteira:' + cart.vendedor, clientes: cart.clientesCairam.map(c => ({ id: c.id, nome: c.nome, vendedor: cart.vendedorId, ticket: c.anterior })) } : undefined,
      parametros: { vendedor_id: cart?.vendedorId || null, texto: corpo },
      custoEstimado: 0, receitaEsperada: 0, categoria: null, nivelSugerido: 0, modoTeste,
    } };
  }
  if (tipo === 'visita' || tipo === 'cupom') {
    // Publico: um segmento de regua (com filtro) ou os clientes que mais cairam numa carteira
    let clientes: any[] = [];
    const seg = prop.segmento ? segmentoPorId(s, String(prop.segmento)) : null;
    if (seg) clientes = seg.clientes.filter(c => !c.optout && !c.inadimplente).sort((a, b) => b.ticket - a.ticket);
    else if (prop.filtro?.vendedor) { const cart = s.carteiras.find(c => c.vendedor === String(prop.filtro.vendedor)); if (cart) clientes = cart.clientesCairam.map(c => ({ id: c.id, nome: c.nome, vendedor: cart.vendedorId, ticket: c.anterior })); }
    const f = prop.filtro || {};
    if (f.ticket_min != null && Number(f.ticket_min) > 0) clientes = clientes.filter(c => Number(c.ticket) >= Number(f.ticket_min));
    clientes = clientes.slice(0, Math.max(1, Math.min(Number(prop.max_clientes) || (tipo === 'visita' ? 8 : 30), tipo === 'visita' ? 20 : 100)));
    if (!clientes.length) return { descarte: tipo + ' sem publico' };
    const chave = tipo + ':' + (prop.segmento || prop.filtro?.vendedor || 'x');
    if (jaHoje.has(chave)) return { descarte: tipo + ' repetido: ' + chave };
    jaHoje.add(chave);
    const ticketMedio = clientes.reduce((t, c) => t + Number(c.ticket || 0), 0) / clientes.length;
    if (tipo === 'visita') {
      return { acao: { tipo: 'visita', agente: AGENTE, titulo: String(prop.titulo || ('Visita a ' + clientes.length + ' cliente(s)')).slice(0, 200),
        justificativa: String(prop.justificativa || '').slice(0, 1200), evidencia: { segmento: seg?.id || null, carteira: prop.filtro?.vendedor || null, ticket_medio: Number(ticketMedio.toFixed(2)), prioridade: prop.prioridade ?? null },
        publico: { segmento: seg?.id, clientes: clientes.map(c => ({ id: c.id, nome: c.nome, vendedor: c.vendedor, ticket: c.ticket })) },
        parametros: { dias: Number(prop.visita?.dias) || 1, motivo: String(prop.visita?.motivo || prop.titulo || '').slice(0, 200) },
        custoEstimado: 0, receitaEsperada: Number((ticketMedio * clientes.length * 0.3).toFixed(2)), categoria: null, nivelSugerido: 2, modoTeste } };
    }
    const pct = Math.min(15, Math.max(3, Number(prop.cupom?.percentual) || 10));
    const regua = seg?.regua && reguaPorId(seg.regua) ? seg.regua : null;
    return { acao: { tipo: 'cupom', agente: AGENTE, titulo: String(prop.titulo || ('Cupom ' + pct + '% para ' + clientes.length + ' cliente(s)')).slice(0, 200),
      justificativa: String(prop.justificativa || '').slice(0, 1200), evidencia: { segmento: seg?.id || null, ticket_medio: Number(ticketMedio.toFixed(2)), percentual: pct, prioridade: prop.prioridade ?? null },
      publico: { segmento: seg?.id, regua: regua || undefined, clientes: clientes.map(c => ({ id: c.id, nome: c.nome, vendedor: c.vendedor, ticket: c.ticket })) },
      parametros: { percentual: pct, validade_dias: Number(prop.cupom?.validade_dias) || 14, regua },
      custoEstimado: Number(((regua ? clientes.length * (seg?.custoUnit || 0.04) : 0) + ticketMedio * clientes.length * 0.1 * (pct / 100)).toFixed(2)),
      receitaEsperada: Number((ticketMedio * clientes.length * 0.1).toFixed(2)), categoria: seg?.categoria as any || null, nivelSugerido: 2, modoTeste } };
  }
  if (tipo === 'peca') {
    const pc = prop.peca || {};
    const gancho = String(pc.gancho || '').trim(); const publico = pc.publico === 'b2c' ? 'b2c' : 'b2b';
    const temFoto = s.conteudo.ganchosComFoto.find(g => g.gancho === gancho && g.publico === publico);
    if (!temFoto) return { descarte: 'pauta sem foto elegivel: ' + gancho + '/' + publico };
    if (s.conteudo.cabe <= 0) return { descarte: 'cota de conteudo da semana cumprida' };
    const chave = 'peca:' + gancho + ':' + publico;
    if (jaHoje.has(chave)) return { descarte: 'pauta repetida: ' + chave };
    jaHoje.add(chave);
    return { acao: {
      tipo: 'peca', agente: AGENTE,
      titulo: String(prop.titulo || ('Peça ' + publico + ' · gancho ' + gancho)).slice(0, 200),
      justificativa: String(prop.justificativa || '').slice(0, 1200),
      evidencia: { gancho, publico, fotos_elegiveis: temFoto.fotos, cabe_semana: s.conteudo.cabe, desempenho: s.conteudo.desempenhoGancho.find(d => d.gancho === gancho) || null, prioridade: prop.prioridade ?? null },
      parametros: { gerar: true, gancho, publico },
      custoEstimado: 0.1, receitaEsperada: 0, categoria: null, nivelSugerido: 0, modoTeste,
    } };
  }
  if (tipo === 'anuncio') {
    const an = prop.anuncio || {};
    if (!s.anuncios.pronto) return { descarte: 'conta de anuncios nao configurada' };
    if (s.anuncios.modo === 'off') return { descarte: 'anuncios desligados' };
    if (s.anuncios.ativos > 0) return { descarte: 'ja existe anuncio ativo' };
    const peca = s.anuncios.pecasCandidatas.find(p => p.id === String(an.peca_id || '') || p.numero === Number(an.peca_id)) || s.anuncios.pecasCandidatas[0];
    if (!peca) return { descarte: 'nenhuma peca candidata para anuncio' };
    const teto = Number(s.anuncios.tetoDia || 0);
    if (teto <= 0) return { descarte: 'politica anuncio sem teto por dia' };
    const orc = Math.min(teto, Math.max(5, Number(an.orcamento_dia) || teto));
    const dias = Math.min(7, Math.max(3, Number(an.dias) || 5));
    const chave = 'anuncio:' + peca.id;
    if (jaHoje.has(chave)) return { descarte: 'anuncio repetido: ' + chave };
    jaHoje.add(chave);
    return { acao: {
      tipo: 'anuncio', agente: AGENTE,
      titulo: String(prop.titulo || ('Anúncio Click-to-WhatsApp da peça #' + peca.numero + ' · R$ ' + orc + '/dia por ' + dias + ' dias')).slice(0, 200),
      justificativa: String(prop.justificativa || '').slice(0, 1200),
      evidencia: { peca: peca.numero, gancho: peca.gancho, alcance_organico: peca.alcance, curtidas: peca.curtidas, teto_dia: teto, prioridade: prop.prioridade ?? null },
      parametros: { canal: 'facebook', plataforma: 'meta', peca_id: peca.id, asset_id: peca.assetId, orcamento_dia: orc, dias },
      custoEstimado: Number((orc * dias).toFixed(2)), receitaEsperada: Number((orc * dias * 2).toFixed(2)), categoria: null, nivelSugerido: 2, modoTeste,
    } };
  }
  return { descarte: 'tipo desconhecido: ' + tipo };
}

function nomeVendedorBate(s: Sinais, vendedorId: string | null, nome: string): boolean {
  const c = s.carteiras.find(x => x.vendedorId && x.vendedorId === vendedorId);
  return !!c && c.vendedor.toLowerCase() === nome.toLowerCase();
}

// ---------------------------------------------------------------------------
// A rodada
// ---------------------------------------------------------------------------
export async function rodar(opts: { quem?: string; forcar?: boolean } = {}): Promise<any> {
  const m = await modo();
  if (m === 'off' && !opts.forcar) return { ok: false, motivo: 'radar desligado (mkt_radar_modo=off)' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, motivo: 'ANTHROPIC_API_KEY ausente' };
  await garantirAgente();
  const modoTeste = m !== 'on';
  const t0 = Date.now();

  const sinais = await lerSinais();
  const user = 'Retrato de hoje (' + sinais.data + '):\n' + JSON.stringify(sinaisParaPrompt(sinais), null, 0);
  const r = await chamarAgente({ agente: AGENTE, nome: 'Radar de Vendas', promptPadrao: PROMPT_PADRAO, modeloPadrao: 'claude-sonnet-4-6', tetoPadrao: 3,
    user, maxTokens: 4000, temperature: 0.3, gatilho: opts.quem === 'cron' ? 'cron' : 'api' });
  if (!r.ok) { console.error('[MKT-RADAR]', r.erro); return { ok: false, motivo: r.erro, sinais: sinaisParaPrompt(sinais) }; }
  const j = r.json;
  if (!j || !Array.isArray(j.acoes)) return { ok: false, motivo: 'resposta do modelo sem JSON valido', bruto: String(r.texto || '').slice(0, 500) };

  const { criadas, descartadas } = await aplicarResposta(j, sinais, modoTeste);

  // N0/N1 executam já (em test, executar() apenas simula)
  const automaticas = await processarAutomaticas();

  const resumo = { ok: true, modo: m, modelo: r.modelo, leituraDoDia: String(j.leitura_do_dia || '').slice(0, 600), criadas, descartadas, automaticas, duracaoMs: Date.now() - t0, avisos: sinais.avisos };
  try { await setSetting('mkt_radar_ultima', JSON.stringify({ em: new Date().toISOString(), ...resumo, automaticas: automaticas.length })); } catch {}
  console.log('[MKT-RADAR] ' + criadas.length + ' acao(oes) criada(s), ' + descartadas.length + ' descartada(s), modo ' + m + ', ' + (Date.now() - t0) + 'ms');
  return resumo;
}

/** Valida e grava as propostas do modelo. Exportado para teste sem chamar a API. */
export async function aplicarResposta(j: any, sinais: Sinais, modoTeste: boolean): Promise<{ criadas: any[]; descartadas: any[] }> {
  // Chaves já ocupadas: tudo que está PENDENTE (qualquer dia) + o que foi criado hoje.
  // Mesma regra de chave que materializar() usa, por tipo — antes só a régua era
  // conferida e o Radar repetia visita/alerta quando rodava 2× no dia.
  const jaHoje = new Set<string>();
  try {
    const q: any = await db.execute(sql`SELECT tipo, evidencia, publico, parametros FROM mkt_acoes
      WHERE agente = ${AGENTE} AND (
        status IN ('proposta','aprovada','auto','executando')
        OR (status = 'executada' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)
        OR (tipo = 'peca' AND status NOT IN ('rejeitada','expirada') AND criado_em >= now() - interval '3 days'))`);
    for (const row of (q.rows || [])) {
      const ev = row.evidencia || {}, pub = row.publico || {}, par = row.parametros || {};
      const tipo = String(row.tipo || '');
      if (tipo === 'regua' && ev.segmento) jaHoje.add(String(ev.segmento));
      else if (tipo === 'alerta') jaHoje.add('alerta:' + (ev.carteira?.vendedor || (String(pub.segmento || '').startsWith('carteira:') ? String(pub.segmento).slice(9) : 'gestor')));
      else if (tipo === 'visita' || tipo === 'cupom') jaHoje.add(tipo + ':' + (ev.segmento || ev.carteira || 'x'));
      else if (tipo === 'peca' && par.gancho) jaHoje.add('peca:' + par.gancho + ':' + (par.publico || 'b2b'));
      else if (tipo === 'anuncio' && par.peca_id) jaHoje.add('anuncio:' + par.peca_id);
    }
  } catch {}

  const criadas: any[] = [], descartadas: any[] = [];
  for (const prop of j.acoes.slice(0, 8)) {
    const mt = await materializar(prop, sinais, modoTeste, jaHoje);
    if (!mt.acao) { descartadas.push({ prop: { tipo: prop?.tipo, segmento: prop?.segmento, titulo: prop?.titulo }, motivo: mt.descarte }); continue; }
    try {
      const c = await criarAcao(mt.acao);
      criadas.push({ numero: c.numero, nivel: c.nivel, status: c.status, tipo: mt.acao.tipo, titulo: mt.acao.titulo, custo: mt.acao.custoEstimado, receita: mt.acao.receitaEsperada });
    } catch (e: any) { descartadas.push({ prop: { titulo: prop?.titulo }, motivo: 'falha ao criar: ' + (e?.message || e) }); }
  }
  return { criadas, descartadas };
}

export async function panorama(): Promise<any> {
  let ultima: any = null;
  try { ultima = JSON.parse(await getSetting('mkt_radar_ultima', '') || 'null'); } catch {}
  let snapshot: any = null;
  try {
    const r: any = await db.execute(sql`SELECT data, valor, criado_em FROM mkt_sinais WHERE sinal = 'radar' ORDER BY criado_em DESC LIMIT 1`);
    snapshot = r.rows?.[0] || null;
  } catch {}
  let custo: any = null;
  try {
    const r: any = await db.execute(sql`SELECT COUNT(*)::int AS execucoes, COALESCE(SUM(custo_brl),0)::float AS custo FROM mkt_agent_runs
      WHERE agente = ${AGENTE} AND criado_em >= now() - interval '30 days'`);
    custo = r.rows?.[0] || null;
  } catch {}
  return { modo: await modo(), temChave: !!process.env.ANTHROPIC_API_KEY, ultima, snapshot, custo30d: custo, agente: AGENTE };
}
