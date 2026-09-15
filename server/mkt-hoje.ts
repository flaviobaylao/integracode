// ============================================================================
// CENTRAL DE MARKETING — PAINEL DO DIA (/marketing/hoje)
// ----------------------------------------------------------------------------
// Uma tela so, feita para o celular, com tudo que o gestor precisa olhar por
// dia: o que os agentes fizeram desde ontem, o que espera decisao, o que esta
// rodando e quanto ja rendeu (medido AO VIVO, nao so na medicao da madrugada),
// as pecas no ar com os numeros do Instagram, a nota do Auditor e os
// aprendizados novos. Tudo em uma chamada: GET /api/mkt/hoje.
//
// "Ao vivo" = para cada acao executada nos ultimos 14 dias, conta pedidos dos
// clientes tocados desde a execucao, direto em sales_cards, a cada chamada.
// A medicao oficial (mkt-acoes.medir, 02:30) continua sendo a que fecha a conta.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

async function rows(q: string): Promise<any[]> { try { const r: any = await db.execute(sql.raw(q)); return r.rows || []; } catch { return []; } }

const NOMES: Record<string, string> = {
  mkt_radar: 'Radar de Vendas', mkt_conteudo: 'Agente de conteúdo', mkt_revisor: 'Revisor', mkt_visao: 'Visão de criativos',
  mkt_analista: 'Analista', mkt_otimizador: 'Otimizador', mkt_auditor: 'Auditor', mkt_publicador: 'Publicador', mkt_semelhanca: 'Famílias de fotos',
};
const TIPOS: Record<string, string> = { regua: 'Régua WhatsApp', alerta: 'Alerta ao vendedor', peca: 'Peça de conteúdo', campanha: 'Campanha + link', cupom: 'Cupom', visita: 'Visita', anuncio: 'Anúncio', sistema: 'Ajuste do sistema' };

/** Resultado ao vivo de uma acao executada: pedidos/receita dos clientes tocados desde a execucao (janela 14d). */
async function resultadoAoVivo(a: any): Promise<any> {
  const ids: string[] = (a.publico?.clientes || []).map((c: any) => String(c.id)).filter(Boolean);
  const base = { clientes: 0, pedidos: 0, receita: 0, taxa: 0, publico: ids.length, diasCorridos: a.executada_em ? Math.min(14, Math.floor((Date.now() - new Date(a.executada_em).getTime()) / 86400000)) : 0, fechado: !!a.medido_em };
  if (!ids.length || !a.executada_em) return base;
  try {
    const q: any = await db.execute(sql`
      SELECT COUNT(DISTINCT sc.customer_id)::int AS clientes, COUNT(sc.id)::int AS pedidos, COALESCE(SUM(sc.sale_value),0)::float AS receita
        FROM sales_cards sc
       WHERE sc.customer_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
         AND COALESCE(sc.sale_value,0) > 0
         AND sc.created_at > ${a.executada_em} AND sc.created_at <= ${a.executada_em}::timestamptz + interval '14 days'`);
    const x = q.rows?.[0] || {};
    return { ...base, clientes: Number(x.clientes || 0), pedidos: Number(x.pedidos || 0), receita: Number(x.receita || 0), taxa: ids.length ? Number((Number(x.clientes || 0) / ids.length).toFixed(3)) : 0 };
  } catch { return base; }
}

/** Toques da regua ligados a acao: quantos sairam e quantos clientes responderam depois. */
async function toquesDaAcao(acaoId: string): Promise<{ enviados: number; bloqueados: number; responderam: number } | null> {
  try {
    const t: any = await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE status = 'enfileirado')::int AS enviados,
             COUNT(*) FILTER (WHERE status = 'bloqueado')::int AS bloqueados,
             COUNT(*) FILTER (WHERE status = 'enfileirado' AND EXISTS (
               SELECT 1 FROM chat_conversations cc WHERE regexp_replace(COALESCE(cc.customer_phone,''), '\\D', '', 'g') LIKE '%' || RIGHT(regexp_replace(COALESCE(f.telefone,''), '\\D', '', 'g'), 8)
                 AND cc.last_message_time > f.liberado_em))::int AS responderam
        FROM mkt_fila_toques f WHERE f.acao_id = ${acaoId}`);
    const x = t.rows?.[0]; if (!x) return null;
    if (!Number(x.enviados) && !Number(x.bloqueados)) return null;
    return { enviados: Number(x.enviados || 0), bloqueados: Number(x.bloqueados || 0), responderam: Number(x.responderam || 0) };
  } catch { return null; }
}

export async function painelDoDia(): Promise<any> {
  // 1. Agentes: o que rodou desde ontem 00:00 (BRT), por agente, com custo e ultimo erro.
  const agentes = (await rows(`
    SELECT agente, COUNT(*)::int AS execucoes, COUNT(*) FILTER (WHERE sucesso)::int AS ok,
           COALESCE(SUM(custo_brl),0)::float AS custo, MAX(criado_em) AS ultimo,
           (array_agg(erro ORDER BY criado_em DESC) FILTER (WHERE NOT sucesso AND erro IS NOT NULL))[1] AS ultimo_erro
      FROM mkt_agent_runs
     WHERE agente LIKE 'mkt_%' AND criado_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 day') AT TIME ZONE 'America/Sao_Paulo'
     GROUP BY agente ORDER BY MAX(criado_em) DESC`)).map(a => ({ ...a, nome: NOMES[a.agente] || a.agente }));

  // 2. O que espera voce
  const pendentes = (await rows(`
    SELECT id, numero, tipo, titulo, justificativa, publico_total, custo_estimado::float AS custo, receita_esperada::float AS receita,
           nivel_efetivo, motivo_nivel, modo_teste, categoria, agente, criado_em, expira_em, evidencia
      FROM mkt_acoes WHERE status = 'proposta' ORDER BY receita_esperada DESC, criado_em ASC LIMIT 40`)).map(a => ({ ...a, tipoNome: TIPOS[a.tipo] || a.tipo }));

  // 3. Rodando e rendendo: executadas nos ultimos 14 dias (+ auto/executando), com resultado ao vivo.
  const rodando: any[] = [];
  for (const a of await rows(`
    SELECT id, numero, tipo, titulo, status, publico, publico_total, custo_estimado::float AS custo, receita_esperada::float AS receita,
           executada_em, medido_em, resultado, modo_teste, execucao, decidido_via, decidido_por
      FROM mkt_acoes WHERE status IN ('executada','executando','auto','erro') AND COALESCE(executada_em, criado_em) >= now() - interval '14 days'
      ORDER BY COALESCE(executada_em, criado_em) DESC LIMIT 40`)) {
    const aoVivo = a.status === 'executada' && !a.modo_teste && ['regua', 'cupom', 'visita'].includes(a.tipo) ? await resultadoAoVivo(a) : null;
    const toques = a.tipo === 'regua' ? await toquesDaAcao(a.id) : null;
    rodando.push({ id: a.id, numero: a.numero, tipo: a.tipo, tipoNome: TIPOS[a.tipo] || a.tipo, titulo: a.titulo, status: a.status, modoTeste: a.modo_teste,
      publicoTotal: a.publico_total, custo: a.custo, receitaEsperada: a.receita, executadaEm: a.executada_em, decididoVia: a.decidido_via,
      erro: a.status === 'erro' ? String(a.execucao?.erro || '').slice(0, 200) : null, aoVivo, toques, resultadoOficial: a.resultado || null });
  }
  const totaisAoVivo = rodando.reduce((t, r) => { if (r.aoVivo) { t.receita += r.aoVivo.receita; t.pedidos += r.aoVivo.pedidos; t.custo += Number(r.custo || 0); t.acoes++; } return t; }, { receita: 0, pedidos: 0, custo: 0, acoes: 0 });

  // 4. Pecas: fila + no ar (com ultimo numero do Instagram)
  const fila = await rows(`SELECT COUNT(*)::int AS n FROM mkt_pieces WHERE estado = 'aguardando_aprovacao'`);
  const pecasFila = await rows(`SELECT id, numero, canal, gancho, titulo, LEFT(copy, 160) AS trecho, rodada, criado_em FROM mkt_pieces WHERE estado = 'aguardando_aprovacao' ORDER BY criado_em ASC LIMIT 10`);
  const noAr = await rows(`
    SELECT p.id, p.numero, p.gancho, p.titulo, p.permalink, p.publicado_em, sp.id AS post_id,
           (SELECT row_to_json(m) FROM (SELECT alcance, impressoes, curtidas, comentarios, salvos, compartilhamentos, data FROM social_metrics WHERE post_id = sp.id ORDER BY data DESC LIMIT 1) m) AS metricas,
           (SELECT COALESCE(SUM(cliques),0)::int FROM mkt_links WHERE post_ref = p.id) AS cliques
      FROM mkt_pieces p LEFT JOIN social_posts sp ON sp.piece_id = p.id
     WHERE p.estado = 'publicado' AND p.publicado_em >= now() - interval '14 days' ORDER BY p.publicado_em DESC LIMIT 10`);
  const pecasHoje = await rows(`SELECT COUNT(*)::int AS n FROM mkt_pieces WHERE origem = 'agente' AND criado_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')) AT TIME ZONE 'America/Sao_Paulo'`);

  // 5. Auditor, aprendizados, radar
  const diag = (await rows(`SELECT data, nota, checagens, melhorias, autofix, texto FROM mkt_diagnosticos ORDER BY criado_em DESC LIMIT 1`))[0] || null;
  const auditor = diag ? { data: diag.data, nota: diag.nota, alertas: (diag.checagens || []).filter((c: any) => c.gravidade === 'alerta').map((c: any) => ({ id: c.id, titulo: c.titulo, detalhe: c.detalhe })), atencoes: (diag.checagens || []).filter((c: any) => c.gravidade === 'atencao').length, autofix: (diag.autofix || []).length, melhorias: (diag.melhorias || []).length } : null;
  const aprendizados = await rows(`SELECT id, origem, enunciado, confianca, acao_sugerida, criado_em FROM mkt_learnings WHERE ativo = true AND criado_em >= now() - interval '7 days' ORDER BY criado_em DESC LIMIT 8`);
  let radar: any = null;
  try { const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'mkt_radar_ultima' LIMIT 1")); radar = JSON.parse(String(r.rows?.[0]?.value || 'null')); } catch {}

  // 6. Numeros do dia + modos + aprovadores
  let numeros: any = null;
  try { const { numerosDoDia } = await import('./mkt-analista'); numeros = await numerosDoDia(); } catch {}
  const modos: Record<string, string> = {};
  for (const k of ['mkt_radar_modo', 'mkt_conteudo_modo', 'mkt_publicador_modo', 'mkt_insights_modo', 'mkt_capi_mode']) {
    const r = await rows(`SELECT value FROM system_settings WHERE key = '${k}' LIMIT 1`);
    modos[k] = r[0]?.value ? String(r[0].value).replace(/^"|"$/g, '') : (k === 'mkt_radar_modo' || k === 'mkt_publicador_modo' ? 'test' : 'off');
  }
  let aprovadores: string[] = [];
  try { const { aprovadores: ap } = await import('./mkt-acoes'); aprovadores = await ap(); } catch {}
  const decisoes7d = (await rows(`SELECT COUNT(*) FILTER (WHERE status IN ('aprovada','executando','executada'))::int AS aprovadas, COUNT(*) FILTER (WHERE status = 'rejeitada')::int AS rejeitadas FROM mkt_acoes WHERE decidido_em >= now() - interval '7 days'`))[0] || { aprovadas: 0, rejeitadas: 0 };

  let ig: any = null;
  try { const { status } = await import('./mkt-ig-auth'); const s = await status(); ig = { conectado: s.conectado, username: s.username, diasRestantes: s.diasRestantes, podePublicar: s.podePublicar }; } catch {}

  return {
    geradoEm: new Date().toISOString(),
    agentes, radar: radar ? { em: radar.em, leitura: radar.leituraDoDia || radar.leitura || null, criadas: Array.isArray(radar.criadas) ? radar.criadas.length : (radar.criadas ?? null), descartadas: Array.isArray(radar.descartadas) ? radar.descartadas.length : (radar.descartadas ?? null), avisos: radar.avisos || [] } : null,
    pendentes, resumoPendentes: { n: pendentes.length, receita: pendentes.reduce((t, p) => t + Number(p.receita || 0), 0), custo: pendentes.reduce((t, p) => t + Number(p.custo || 0), 0) },
    rodando, totaisAoVivo,
    pecas: { fila: Number(fila[0]?.n || 0), filaLista: pecasFila, noAr, escritasHoje: Number(pecasHoje[0]?.n || 0) },
    auditor, aprendizados, numeros, modos, aprovadores: aprovadores.length, decisoes7d, ig,
  };
}
