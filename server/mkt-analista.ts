// ============================================================================
// CENTRAL DE MARKETING — ANALISTA (agente mkt_analista)
// ----------------------------------------------------------------------------
// Ate aqui o gestor recebia tres listas SQL por WhatsApp (positivacao 07:50,
// debitos 08:30, rota 18:30) e, desde a Sprint 1, o resumo da Caixa as 07:30.
// O analista faz duas coisas:
//   1. leituraDoDia(): 3-5 linhas em portugues sobre o estado de hoje (numeros
//      deterministicos + interpretacao do Haiku) — entra NO TOPO do resumo das 07:30
//   2. relatorioSemanal(): segunda 07:15, os 12 numeros da semana com comentario,
//      no WhatsApp do aprovador. Sem tela para abrir.
// Os numeros vem de SQL; o modelo so escreve. Se o modelo falhar, o texto sai
// so com os numeros — nunca fica mudo.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_analista';
const brl = (v: any) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function q1(query: string): Promise<any> { try { const r: any = await db.execute(sql.raw(query)); return r.rows?.[0] || {}; } catch { return {}; } }

export async function numerosDoDia(): Promise<any> {
  const [pos, deb, ac, ia, reg, pecas] = await Promise.all([
    q1(`SELECT (SELECT COUNT(*) FROM customers WHERE is_active = true AND COALESCE(is_lead,false) = false)::int AS ativos,
               (SELECT COUNT(DISTINCT customer_id) FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::int AS positivados,
               (SELECT COALESCE(SUM(sale_value),0)::float FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= now() - interval '7 days')::float AS vendas7d,
               (SELECT COALESCE(SUM(sale_value),0)::float FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days')::float AS vendas7dAnt`),
    q1(`SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS vencido, COUNT(*)::int AS titulos FROM receivables
         WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida') AND due_date::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date AND (amount - COALESCE(amount_paid,0)) > 0`),
    q1(`SELECT COUNT(*) FILTER (WHERE status = 'proposta')::int AS pendentes,
               COUNT(*) FILTER (WHERE status = 'executada' AND executada_em >= now() - interval '1 day')::int AS executadasOntem,
               COALESCE(SUM((resultado->>'receita')::numeric) FILTER (WHERE medido_em >= now() - interval '7 days'),0)::float AS receitaMedida7d,
               COUNT(*) FILTER (WHERE status = 'erro' AND criado_em >= now() - interval '1 day')::int AS erros FROM mkt_acoes`),
    q1(`SELECT COALESCE(SUM(custo_brl),0)::float AS mes, COALESCE(SUM(custo_brl) FILTER (WHERE criado_em >= now() - interval '1 day'),0)::float AS dia FROM mkt_agent_runs WHERE criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`),
    q1(`SELECT COUNT(*)::int AS enviados, COUNT(sc.id)::int AS pedidos FROM mkt_fila_toques f LEFT JOIN sales_cards sc ON sc.customer_id = f.cliente_id AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days' WHERE f.status = 'enfileirado' AND f.liberado_em >= now() - interval '7 days'`),
    q1(`SELECT COUNT(*) FILTER (WHERE estado = 'aguardando_aprovacao')::int AS fila, COUNT(*) FILTER (WHERE estado IN ('aprovado','agendado'))::int AS aprovadas, COUNT(*) FILTER (WHERE estado = 'publicado' AND publicado_em >= now() - interval '7 days')::int AS publicadas7d FROM mkt_pieces`),
  ]);
  return {
    ativos: Number(pos.ativos || 0), positivados: Number(pos.positivados || 0), pctPositivacao: pos.ativos ? Number(((pos.positivados / pos.ativos) * 100).toFixed(1)) : 0,
    vendas7d: Number(pos.vendas7d || 0), vendas7dAnt: Number(pos.vendas7dant ?? pos.vendas7dAnt ?? 0),
    debitoVencido: Number(deb.vencido || 0), titulosVencidos: Number(deb.titulos || 0),
    acoesPendentes: Number(ac.pendentes || 0), acoesExecutadasOntem: Number(ac.executadasontem ?? ac.executadasOntem ?? 0), receitaMedida7d: Number(ac.receitamedida7d ?? ac.receitaMedida7d ?? 0), acoesErro: Number(ac.erros || 0),
    custoIaMes: Number(ia.mes || 0), custoIaDia: Number(ia.dia || 0),
    reguaEnviados7d: Number(reg.enviados || 0), reguaPedidos7d: Number(reg.pedidos || 0),
    pecasFila: Number(pecas.fila || 0), pecasAprovadas: Number(pecas.aprovadas || 0), pecasPublicadas7d: Number(pecas.publicadas7d || 0),
  };
}

export async function leituraDoDia(): Promise<string> {
  const n = await numerosDoDia();
  const fatos = [
    'Positivação do mês: ' + n.positivados + ' de ' + n.ativos + ' ativos (' + n.pctPositivacao + '%).',
    'Vendas 7d: ' + brl(n.vendas7d) + ' (7d anteriores ' + brl(n.vendas7dAnt) + ').',
    'Débito vencido: ' + brl(n.debitoVencido) + ' em ' + n.titulosVencidos + ' títulos.',
    'Régua 7d: ' + n.reguaEnviados7d + ' mensagens → ' + n.reguaPedidos7d + ' pedidos.',
    'Conteúdo: ' + n.pecasFila + ' na fila, ' + n.pecasAprovadas + ' aprovadas sem postar, ' + n.pecasPublicadas7d + ' publicadas em 7d.',
    'IA: ' + brl(n.custoIaDia) + ' ontem, ' + brl(n.custoIaMes) + ' no mês.' + (n.acoesErro ? ' ' + n.acoesErro + ' ação(ões) com erro.' : ''),
  ];
  try {
    const { chamarAgente } = await import('./mkt-llm');
    const r = await chamarAgente({
      agente: AGENTE, nome: 'Analista de Marketing', modeloPadrao: 'claude-haiku-4-5', tetoPadrao: 1,
      promptPadrao: 'Você é o analista comercial da Honest Sucos. Recebe números do dia e escreve 3 a 5 linhas curtas, em português do Brasil, para o dono ler no celular: o que mudou, o que preocupa, o que merece atenção hoje. Sem cumprimento, sem repetir todos os números, sem inventar nada além dos números recebidos. Responda em texto simples, uma linha por ponto, começando cada linha com "•".',
      user: fatos.join('\n'), maxTokens: 400, temperature: 0.2, gatilho: 'cron',
    });
    if (r.ok && r.texto) return '📊 *Leitura do dia*\n' + r.texto.trim() + '\n';
  } catch {}
  return '📊 *Leitura do dia*\n' + fatos.map(f => '• ' + f).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Semanal — os 12 números (segunda 07:15)
// ---------------------------------------------------------------------------
export async function numerosDaSemana(): Promise<any> {
  const [v, r, a, c, p, ia] = await Promise.all([
    q1(`SELECT COALESCE(SUM(sale_value),0)::float AS semana, COUNT(DISTINCT customer_id)::int AS clientes, COUNT(*)::int AS pedidos,
               (SELECT COALESCE(SUM(sale_value),0)::float FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS anterior,
               COUNT(DISTINCT customer_id) FILTER (WHERE acao_id IS NOT NULL)::int AS clientesViaAcao,
               COALESCE(SUM(sale_value) FILTER (WHERE acao_id IS NOT NULL),0)::float AS receitaViaAcao,
               COALESCE(SUM(sale_value) FILTER (WHERE campaign_id IS NOT NULL),0)::float AS receitaComCampanha
          FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= now() - interval '7 days'`),
    q1(`SELECT COUNT(*)::int AS enviados, COUNT(sc.id)::int AS pedidos, COALESCE(SUM(sc.sale_value),0)::float AS receita, COALESCE(SUM(f.custo_estimado),0)::float AS custo
          FROM mkt_fila_toques f LEFT JOIN sales_cards sc ON sc.customer_id = f.cliente_id AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days'
         WHERE f.status = 'enfileirado' AND f.liberado_em >= now() - interval '7 days'`),
    q1(`SELECT COUNT(*)::int AS propostas, COUNT(*) FILTER (WHERE status IN ('aprovada','executada','auto','executando'))::int AS aprovadas,
               COUNT(*) FILTER (WHERE status = 'rejeitada')::int AS rejeitadas, COUNT(*) FILTER (WHERE status = 'expirada')::int AS expiradas,
               COUNT(*) FILTER (WHERE nivel_efetivo < 2)::int AS automaticas,
               AVG(EXTRACT(EPOCH FROM (decidido_em - criado_em))/3600) FILTER (WHERE decidido_em IS NOT NULL)::float AS horasDecisao
          FROM mkt_acoes WHERE criado_em >= now() - interval '7 days'`),
    q1(`SELECT (SELECT COUNT(*) FROM customers WHERE is_active = true AND COALESCE(is_lead,false) = false)::int AS ativos,
               (SELECT COUNT(DISTINCT customer_id) FROM sales_cards WHERE COALESCE(sale_value,0) > 0 AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::int AS positivados,
               (SELECT COUNT(*) FROM mkt_links WHERE criado_em >= now() - interval '7 days')::int AS links,
               (SELECT COALESCE(SUM(cliques),0) FROM mkt_links)::int AS cliquesTotal`),
    q1(`SELECT COUNT(*) FILTER (WHERE criado_em >= now() - interval '7 days')::int AS criadas,
               COUNT(*) FILTER (WHERE estado = 'publicado' AND publicado_em >= now() - interval '7 days')::int AS publicadas,
               COUNT(*) FILTER (WHERE criado_em >= now() - interval '7 days' AND rodada <= 1 AND estado IN ('aguardando_aprovacao','aprovado','agendado','publicado'))::int AS semRetrabalho
          FROM mkt_pieces`),
    q1(`SELECT COALESCE(SUM(custo_brl),0)::float AS semana, COUNT(*)::int AS execucoes FROM mkt_agent_runs WHERE criado_em >= now() - interval '7 days'`),
  ]);
  const custoTotal = Number(ia.semana || 0) + Number(r.custo || 0);
  const receitaAtrib = Number(v.receitaviaacao ?? v.receitaViaAcao ?? 0);
  return {
    vendasSemana: Number(v.semana || 0), vendasAnterior: Number(v.anterior || 0), pedidos: Number(v.pedidos || 0), clientes: Number(v.clientes || 0),
    positivacaoPct: c.ativos ? Number(((c.positivados / c.ativos) * 100).toFixed(1)) : 0,
    receitaAtribuida: receitaAtrib, receitaComCampanha: Number(v.receitacomcampanha ?? v.receitaComCampanha ?? 0), clientesViaAcao: Number(v.clientesviaacao ?? v.clientesViaAcao ?? 0),
    regua: { enviados: Number(r.enviados || 0), pedidos: Number(r.pedidos || 0), receita: Number(r.receita || 0), custo: Number(r.custo || 0) },
    acoes: { propostas: Number(a.propostas || 0), aprovadas: Number(a.aprovadas || 0), rejeitadas: Number(a.rejeitadas || 0), expiradas: Number(a.expiradas || 0), automaticas: Number(a.automaticas || 0), horasDecisao: a.horasdecisao != null ? Number(Number(a.horasdecisao).toFixed(1)) : null },
    pecas: { criadas: Number(p.criadas || 0), publicadas: Number(p.publicadas || 0), semRetrabalhoPct: p.criadas ? Math.round((Number(p.semretrabalho ?? p.semRetrabalho ?? 0) / Number(p.criadas)) * 100) : null },
    links: Number(c.links || 0), cliquesTotal: Number(c.cliquestotal ?? c.cliquesTotal ?? 0),
    custoIa: Number(ia.semana || 0), execucoesIa: Number(ia.execucoes || 0), custoTotal,
    roi: custoTotal > 0 ? Number((receitaAtrib / custoTotal).toFixed(1)) : null,
  };
}

export function textoSemanal(n: any): string {
  const pct = (a: number, b: number) => b > 0 ? ((a - b) / b * 100).toFixed(0) + '%' : '—';
  return [
    '📈 *Semana da Central — 12 números*',
    '1. Vendas 7d: ' + brl(n.vendasSemana) + ' (' + pct(n.vendasSemana, n.vendasAnterior) + ' vs. semana anterior) · ' + n.pedidos + ' pedidos · ' + n.clientes + ' clientes',
    '2. Positivação do mês: ' + n.positivacaoPct + '%',
    '3. Receita atribuída a ações da Central: ' + brl(n.receitaAtribuida) + ' (' + n.clientesViaAcao + ' clientes)',
    '4. Receita com código de campanha: ' + brl(n.receitaComCampanha),
    '5. Régua: ' + n.regua.enviados + ' msgs → ' + n.regua.pedidos + ' pedidos · ' + brl(n.regua.receita) + ' · custo ' + brl(n.regua.custo),
    '6. Ações: ' + n.acoes.propostas + ' propostas · ' + n.acoes.aprovadas + ' aprovadas · ' + n.acoes.rejeitadas + ' rejeitadas · ' + n.acoes.expiradas + ' expiradas',
    '7. Sozinhas (N0/N1): ' + n.acoes.automaticas + ' · tempo até decidir: ' + (n.acoes.horasDecisao != null ? n.acoes.horasDecisao + ' h' : '—'),
    '8. Peças: ' + n.pecas.criadas + ' criadas · ' + n.pecas.publicadas + ' publicadas · sem retrabalho: ' + (n.pecas.semRetrabalhoPct != null ? n.pecas.semRetrabalhoPct + '%' : '—'),
    '9. Links novos: ' + n.links + ' · cliques acumulados: ' + n.cliquesTotal,
    '10. Custo de IA: ' + brl(n.custoIa) + ' em ' + n.execucoesIa + ' execuções',
    '11. Custo total da Central (IA + mensagens): ' + brl(n.custoTotal),
    '12. ROI (receita atribuída ÷ custo): ' + (n.roi != null ? n.roi + '×' : '—'),
  ].join('\n');
}

export async function relatorioSemanal(): Promise<{ texto: string; enviados: any[] }> {
  const n = await numerosDaSemana();
  let texto = textoSemanal(n);
  try {
    const { chamarAgente } = await import('./mkt-llm');
    const r = await chamarAgente({
      agente: AGENTE, nome: 'Analista de Marketing', modeloPadrao: 'claude-haiku-4-5', tetoPadrao: 1,
      promptPadrao: 'Você é o analista comercial da Honest Sucos. Recebe os 12 números da semana e escreve 3 linhas: o que foi bem, o que foi mal, e a única coisa que o dono deveria fazer esta semana. Português do Brasil, direto, sem inventar dado. Cada linha começa com "•".',
      user: JSON.stringify(n), maxTokens: 350, temperature: 0.2, gatilho: 'cron',
    });
    if (r.ok && r.texto) texto += '\n\n' + r.texto.trim();
  } catch {}
  const { aprovadores } = await import('./mkt-acoes');
  const { enviarInterno } = await import('./envio-texto');
  const enviados: any[] = [];
  for (const t of await aprovadores()) enviados.push({ para: t, ...(await enviarInterno(t, texto)) });
  return { texto, enviados };
}
