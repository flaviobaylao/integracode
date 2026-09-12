// ============================================================================
// CENTRAL DE MARKETING — OTIMIZADOR (agente mkt_otimizador): o que funcionou
// ----------------------------------------------------------------------------
// Fecha o ciclo. Toda segunda 06:00 le o que a Central FEZ e o que isso RENDEU
// (acoes executadas com resultado de 14 dias, reguas por tipo, ganchos de
// criativo x receita, rejeicoes do gestor com o motivo, pecas devolvidas) e
// escreve 3 a 5 APRENDIZADOS em mkt_learnings — cada um com o numero que o
// sustenta, a amostra e a confianca. Os aprendizados ativos entram no prompt do
// Radar (mkt-sinais.aprendizados) e do agente de conteudo.
//
// Regras:
//   - amostra pequena vira confianca 'baixa', nunca certeza. O modelo e obrigado
//     a dizer quando nao ha volume para concluir.
//   - aprendizado antigo do otimizador com o mesmo tema e desativado quando um
//     novo o substitui (o humano pode escrever os dele; esses nunca sao tocados).
//   - so propoe; quem muda politica e o gestor.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_otimizador';

async function rows(query: string): Promise<any[]> { try { const r: any = await db.execute(sql.raw(query)); return r.rows || []; } catch { return []; } }

export async function evidencias(): Promise<any> {
  const [acoes, rejeicoes, reguas, ganchos, pecas, aprendAtuais] = await Promise.all([
    rows(`SELECT numero, tipo, titulo, evidencia->>'segmento' AS segmento, parametros->>'regua' AS regua, publico_total, custo_estimado::float AS custo,
                 receita_esperada::float AS esperado, (resultado->>'receita')::float AS receita, (resultado->>'pedidos')::int AS pedidos, (resultado->>'taxa')::float AS taxa, executada_em::date AS dia
            FROM mkt_acoes WHERE status = 'executada' AND resultado IS NOT NULL AND modo_teste = false AND executada_em >= now() - interval '60 days' ORDER BY executada_em DESC LIMIT 60`),
    rows(`SELECT numero, tipo, titulo, comentario, decidido_em::date AS dia FROM mkt_acoes WHERE status = 'rejeitada' AND criado_em >= now() - interval '30 days' ORDER BY decidido_em DESC LIMIT 30`),
    rows(`SELECT f.regua, COUNT(*)::int AS enviados, COUNT(sc.id)::int AS pedidos, ROUND(COALESCE(SUM(sc.sale_value),0),2)::float AS receita, ROUND(COALESCE(SUM(f.custo_estimado),0),2)::float AS custo
            FROM mkt_fila_toques f LEFT JOIN sales_cards sc ON sc.customer_id = f.cliente_id AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days'
           WHERE f.status = 'enfileirado' AND f.liberado_em >= now() - interval '90 days' GROUP BY f.regua`),
    rows(`SELECT p.gancho, COUNT(*)::int AS pecas, COUNT(*) FILTER (WHERE p.estado = 'publicado')::int AS publicadas,
                 COUNT(*) FILTER (WHERE p.estado = 'reprovado' OR p.rodada > 1)::int AS devolvidas,
                 COALESCE(SUM(l.cliques),0)::int AS cliques
            FROM mkt_pieces p LEFT JOIN mkt_links l ON l.post_ref = p.id
           WHERE p.criado_em >= now() - interval '90 days' AND p.gancho IS NOT NULL GROUP BY p.gancho`),
    rows(`SELECT r.veredito, r.motivo, COUNT(*)::int AS n FROM mkt_reviews r WHERE r.criado_em >= now() - interval '30 days' GROUP BY r.veredito, r.motivo ORDER BY n DESC LIMIT 15`),
    rows(`SELECT id, origem, enunciado, confianca, amostra FROM mkt_learnings WHERE ativo = true ORDER BY criado_em DESC LIMIT 20`),
  ]);
  return { acoes, rejeicoes, reguas, ganchos, pecas, aprendizadosAtuais: aprendAtuais };
}

const PROMPT_PADRAO = `Você é o otimizador da Central de Marketing da Honest Sucos. Recebe evidências (ações executadas e o que renderam em 14 dias, réguas por tipo, ganchos de conteúdo, rejeições do gestor com motivo, vereditos do revisor) e devolve de 2 a 5 APRENDIZADOS acionáveis.

Regras duras:
- Cada aprendizado cita o número que o sustenta e a amostra. Amostra < 20 mensagens ou < 5 ações → confiança "baixa" e o enunciado começa com "Indício:". Nunca afirme causalidade com amostra pequena.
- Se não houver volume para concluir nada, devolva um único aprendizado com confiança "baixa" dizendo exatamente isso e o que precisa acontecer para haver conclusão.
- Rejeições do gestor com motivo viram aprendizado de "não propor X" (confiança alta se repetido 2+ vezes).
- "acao_sugerida" é uma mudança concreta e pequena (ex.: "dobrar lote de ciclo_furado", "parar de propor reativação a ticket < R$ 150", "priorizar gancho margem no B2B").
- Português do Brasil, frases curtas.

Responda SOMENTE JSON: {"aprendizados":[{"tema":"regua:ciclo_furado|gancho:margem|rejeicao|geral","enunciado":"...","evidencia":{"numero":"...","amostra":n},"confianca":"alta|media|baixa","acao_sugerida":"..."}],"resumo":"1 frase"}`;

export async function rodar(opts: { quem?: string } = {}): Promise<any> {
  const ev = await evidencias();
  const { chamarAgente } = await import('./mkt-llm');
  const r = await chamarAgente({
    agente: AGENTE, nome: 'Otimizador de Marketing', promptPadrao: PROMPT_PADRAO, modeloPadrao: 'claude-sonnet-4-6', tetoPadrao: 2,
    user: JSON.stringify(ev), maxTokens: 2500, temperature: 0.2, gatilho: opts.quem === 'cron' ? 'cron' : 'api',
  });
  if (!r.ok || !r.json || !Array.isArray(r.json.aprendizados)) return { ok: false, motivo: r.erro || 'sem JSON', evidencias: { acoes: ev.acoes.length, reguas: ev.reguas.length } };
  const gravados: any[] = [];
  for (const a of r.json.aprendizados.slice(0, 5)) {
    const enunciado = String(a?.enunciado || '').trim().slice(0, 500);
    if (!enunciado) continue;
    const tema = String(a?.tema || 'geral').slice(0, 60);
    const conf = ['alta', 'media', 'baixa'].includes(a?.confianca) ? a.confianca : 'baixa';
    const amostra = Number(a?.evidencia?.amostra) || null;
    try {
      // Substitui o aprendizado anterior DO OTIMIZADOR com o mesmo tema; os do humano ficam.
      await db.execute(sql`UPDATE mkt_learnings SET ativo = false WHERE origem = ${AGENTE} AND ativo = true AND evidencia->>'tema' = ${tema}`);
      await db.execute(sql`INSERT INTO mkt_learnings (origem, enunciado, evidencia, amostra, confianca, acao_sugerida, ativo)
        VALUES (${AGENTE}, ${enunciado}, ${JSON.stringify({ tema, ...(a?.evidencia || {}) })}::jsonb, ${amostra}, ${conf}, ${String(a?.acao_sugerida || '').slice(0, 300) || null}, true)`);
      gravados.push({ tema, enunciado, confianca: conf, amostra, acao: a?.acao_sugerida || null });
    } catch (e: any) { console.error('[MKT-OTIMIZADOR] gravar:', e?.message || e); }
  }
  // Aprendizado com ação sugerida vira uma ação 'alerta' N0 ao gestor (sem dinheiro): ele lê e decide se muda a política.
  if (gravados.length) {
    try {
      const { criarAcao } = await import('./mkt-acoes');
      const texto = '🧠 *Aprendizados da semana*\n' + gravados.map(g => '• [' + g.confianca + '] ' + g.enunciado + (g.acao ? '\n  → ' + g.acao : '')).join('\n') + (r.json.resumo ? '\n\n' + String(r.json.resumo).slice(0, 300) : '');
      await criarAcao({ tipo: 'alerta', agente: AGENTE, titulo: 'Aprendizados da semana (' + gravados.length + ')', justificativa: String(r.json.resumo || '').slice(0, 600),
        evidencia: { aprendizados: gravados }, parametros: { texto }, custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 0 });
    } catch (e: any) { console.error('[MKT-OTIMIZADOR] acao:', e?.message || e); }
  }
  return { ok: true, gravados, resumo: r.json.resumo || null, modelo: r.modelo };
}

export async function listar(): Promise<any[]> {
  return rows(`SELECT id, origem, enunciado, evidencia, amostra, confianca, acao_sugerida, ativo, criado_em FROM mkt_learnings ORDER BY ativo DESC, criado_em DESC LIMIT 50`);
}

export async function registrarHumano(enunciado: string, por: string): Promise<void> {
  await db.execute(sql`INSERT INTO mkt_learnings (origem, enunciado, evidencia, confianca, ativo) VALUES (${'humano:' + por}, ${enunciado.slice(0, 500)}, ${JSON.stringify({ tema: 'humano' })}::jsonb, 'alta', true)`);
}

export async function desativar(id: string): Promise<void> {
  await db.execute(sql`UPDATE mkt_learnings SET ativo = false WHERE id = ${id}`);
}
