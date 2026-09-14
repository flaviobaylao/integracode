// ============================================================================
// CENTRAL DE MARKETING — SINAIS: o que o Radar de Vendas lê antes de propor
// ----------------------------------------------------------------------------
// Regra da casa: a IA NAO inventa numero. Cada sinal aqui e SQL/regra
// deterministica sobre o dado do ERP. O Radar (mkt-radar.ts) recebe o retrato
// pronto, interpreta, prioriza e escreve a justificativa — mas o publico, o
// custo e a receita esperada de cada acao sao calculados AQUI, nunca pelo
// modelo. Se o modelo citar um segmento que nao existe, a acao e descartada.
//
// Cada execucao grava um snapshot em mkt_sinais: e a resposta de "por que a
// IA propos isso naquele dia", meses depois.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { retratoDaBase, classificar, categoriasAprovadas, reguaPorId, REGUAS, type Retrato } from './mkt-recompra';

export type Segmento = {
  id: string;                 // ex.: 'regua:reativacao', 'regua:ciclo_furado'
  tipo: 'regua' | 'lista';
  regua?: string;
  nome: string;
  descricao: string;
  clientes: Array<{ id: string; nome: string; vendedor: string | null; ticket: number; dias: number | null; skus: number; inadimplente: boolean; optout: boolean }>;
  elegiveis: number;          // sem opt-out, sem inadimplente
  ticketMedio: number;
  custoUnit: number;          // pelo template aprovado (0.04 utility / 0.34 marketing)
  categoria: string;
  conversaoEsperada: number;
  conversaoMedida?: number | null; // o que a regua rendeu de fato (14d), se houver amostra
};

export type Sinais = {
  data: string;
  base: { clientes: number; comCiclo: number; inadimplentes: number; optout: number };
  segmentos: Segmento[];
  carteiras: Array<{ vendedor: string; vendedorId: string | null; atual: number; anterior: number; deltaPct: number | null; clientesCairam: Array<{ id: string; nome: string; atual: number; anterior: number }> }>;
  positivacao: { ativos: number; comPedidoMes: number; pct: number };
  reguas14d: Array<{ regua: string; enviados: number; pedidos: number; receita: number; custo: number }>;
  acoes: { ultimos30d: number; aprovadas: number; rejeitadas: number; executadas: number; receitaMedida: number; taxaAprovacao: number | null };
  custoIaMes: number;
  aprendizados: string[];
  avisos: string[];
  conteudo: { modo: string; cotaSemana: number; feitasSemana: number; cabe: number; naFila: number; aprovadasNaoPostadas: number; ganchosComFoto: Array<{ gancho: string; publico: string; fotos: number }>; desempenhoGancho: Array<{ gancho: string; usos: number; receitaPorUso: number; confiavel: boolean }> };
};

const hojeBR = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Segmentos por régua — reaproveita o retrato e a classificação da recompra.
// ---------------------------------------------------------------------------
async function segmentosPorRegua(retrato: Retrato[], reguas14d: Sinais['reguas14d']): Promise<Segmento[]> {
  const cand = await classificar(retrato);
  const cats = (await categoriasAprovadas()).mapa;
  const porRegua = new Map<string, Retrato[]>();
  for (const c of cand) { if (!porRegua.has(c.regua)) porRegua.set(c.regua, []); porRegua.get(c.regua)!.push(c.cliente); }

  const out: Segmento[] = [];
  for (const r of REGUAS) {
    const lista = porRegua.get(r.id) || [];
    if (!lista.length) continue;
    const categoria = cats.get(r.templateLabel) || r.categoria;
    const elegiveis = lista.filter(c => !c.optout && !c.inadimplente);
    const tickets = elegiveis.map(c => Number(c.ticket_medio || 0)).filter(t => t > 0);
    const medida = reguas14d.find(x => x.regua === r.id);
    out.push({
      id: 'regua:' + r.id, tipo: 'regua', regua: r.id, nome: r.nome, descricao: r.descricao,
      clientes: lista.slice(0, 400).map(c => ({
        id: String(c.id), nome: String(c.name || ''), vendedor: c.seller_id || null,
        ticket: Number(c.ticket_medio || 0), dias: c.dias_desde_compra, skus: Number(c.skus || 0),
        inadimplente: !!c.inadimplente, optout: !!c.optout,
      })),
      elegiveis: elegiveis.length,
      ticketMedio: tickets.length ? Number((tickets.reduce((a, b) => a + b, 0) / tickets.length).toFixed(2)) : 0,
      custoUnit: categoria === 'MARKETING' ? 0.34 : 0.04,
      categoria,
      conversaoEsperada: r.conversaoEsperada,
      conversaoMedida: medida && medida.enviados >= 20 ? Number((medida.pedidos / medida.enviados).toFixed(3)) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Carteiras: vendas dos últimos 30 dias × 30 anteriores, por vendedor, com os
// clientes que mais caíram. Fonte: sales_cards (pedido do 2.0).
// ---------------------------------------------------------------------------
async function carteiras(): Promise<Sinais['carteiras']> {
  try {
    const r: any = await db.execute(sql.raw(`
      WITH v AS (
        SELECT sc.customer_id, sc.seller_id,
               SUM(sc.sale_value) FILTER (WHERE sc.created_at >= now() - interval '30 days')                                            AS atual,
               SUM(sc.sale_value) FILTER (WHERE sc.created_at >= now() - interval '60 days' AND sc.created_at < now() - interval '30 days') AS anterior
          FROM sales_cards sc
         WHERE sc.customer_id IS NOT NULL AND COALESCE(sc.sale_value,0) > 0
           AND COALESCE(sc.status,'') NOT IN ('cancelled','no_sale','failed')
           AND sc.created_at >= now() - interval '60 days'
         GROUP BY sc.customer_id, sc.seller_id)
      SELECT v.seller_id,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''), v.seller_id, 'Sem carteira') AS vendedor,
             v.customer_id, c.name AS cliente,
             COALESCE(v.atual,0)::float AS atual, COALESCE(v.anterior,0)::float AS anterior
        FROM v
        LEFT JOIN users u ON u.id = v.seller_id
        LEFT JOIN customers c ON c.id = v.customer_id`));
    const porVend = new Map<string, any>();
    for (const row of (r.rows || [])) {
      const k = String(row.vendedor);
      if (!porVend.has(k)) porVend.set(k, { vendedor: k, vendedorId: row.seller_id || null, atual: 0, anterior: 0, clientesCairam: [] });
      const v = porVend.get(k);
      v.atual += Number(row.atual); v.anterior += Number(row.anterior);
      const queda = Number(row.anterior) - Number(row.atual);
      if (queda > 0 && Number(row.anterior) >= 100) v.clientesCairam.push({ id: String(row.customer_id), nome: String(row.cliente || ''), atual: Number(row.atual), anterior: Number(row.anterior) });
    }
    return Array.from(porVend.values()).map(v => ({
      ...v,
      atual: Number(v.atual.toFixed(2)), anterior: Number(v.anterior.toFixed(2)),
      deltaPct: v.anterior > 0 ? Number((((v.atual - v.anterior) / v.anterior) * 100).toFixed(1)) : null,
      clientesCairam: v.clientesCairam.sort((a: any, b: any) => (b.anterior - b.atual) - (a.anterior - a.atual)).slice(0, 8),
    })).sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0));
  } catch (e: any) {
    console.error('[MKT-SINAIS] carteiras:', e?.message || e);
    return [];
  }
}

async function positivacao(): Promise<Sinais['positivacao']> {
  try {
    const r: any = await db.execute(sql.raw(`
      SELECT (SELECT COUNT(*) FROM customers WHERE is_active = true AND COALESCE(is_lead,false) = false)::int AS ativos,
             (SELECT COUNT(DISTINCT customer_id) FROM sales_cards
               WHERE COALESCE(sale_value,0) > 0
                 AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo'))::int AS com_pedido`));
    const a = Number(r.rows?.[0]?.ativos || 0), c = Number(r.rows?.[0]?.com_pedido || 0);
    return { ativos: a, comPedidoMes: c, pct: a ? Number(((c / a) * 100).toFixed(1)) : 0 };
  } catch { return { ativos: 0, comPedidoMes: 0, pct: 0 }; }
}

async function reguas14d(): Promise<Sinais['reguas14d']> {
  try {
    const r: any = await db.execute(sql.raw(`
      SELECT f.regua, COUNT(*)::int AS enviados, COUNT(sc.id)::int AS pedidos,
             ROUND(COALESCE(SUM(sc.sale_value),0),2)::float AS receita,
             ROUND(COALESCE(SUM(f.custo_estimado),0),2)::float AS custo
        FROM mkt_fila_toques f
        LEFT JOIN sales_cards sc ON sc.customer_id = f.cliente_id
         AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days'
       WHERE f.status = 'enfileirado' AND f.liberado_em >= now() - interval '120 days'
       GROUP BY f.regua`));
    return (r.rows || []).map((x: any) => ({ regua: String(x.regua), enviados: Number(x.enviados), pedidos: Number(x.pedidos), receita: Number(x.receita), custo: Number(x.custo) }));
  } catch { return []; }
}

async function historicoAcoes(): Promise<Sinais['acoes']> {
  try {
    const r: any = await db.execute(sql.raw(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('aprovada','executando','executada'))::int AS aprovadas,
             COUNT(*) FILTER (WHERE status = 'rejeitada')::int AS rejeitadas,
             COUNT(*) FILTER (WHERE status = 'executada')::int AS executadas,
             COALESCE(SUM((resultado->>'receita')::numeric),0)::float AS receita
        FROM mkt_acoes WHERE criado_em >= now() - interval '30 days' AND nivel_efetivo = 2`));
    const x = r.rows?.[0] || {};
    const dec = Number(x.aprovadas || 0) + Number(x.rejeitadas || 0);
    return { ultimos30d: Number(x.total || 0), aprovadas: Number(x.aprovadas || 0), rejeitadas: Number(x.rejeitadas || 0),
      executadas: Number(x.executadas || 0), receitaMedida: Number(x.receita || 0),
      taxaAprovacao: dec ? Number((Number(x.aprovadas || 0) / dec).toFixed(2)) : null };
  } catch { return { ultimos30d: 0, aprovadas: 0, rejeitadas: 0, executadas: 0, receitaMedida: 0, taxaAprovacao: null }; }
}

async function custoIaMes(): Promise<number> {
  try {
    const r: any = await db.execute(sql.raw(`SELECT COALESCE(SUM(custo_brl),0)::float AS t FROM mkt_agent_runs
      WHERE criado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`));
    return Number(r.rows?.[0]?.t || 0);
  } catch { return 0; }
}

async function conteudo(): Promise<Sinais['conteudo']> {
  const out: Sinais['conteudo'] = { modo: 'off', cotaSemana: 0, feitasSemana: 0, cabe: 0, naFila: 0, aprovadasNaoPostadas: 0, ganchosComFoto: [], desempenhoGancho: [] };
  try {
    const c = await import('./mkt-agente-conteudo');
    out.modo = await c.modo();
    const s = await c.saldoDaSemana(); out.cotaSemana = s.cota; out.feitasSemana = s.feitas; out.cabe = s.cabe;
    const f: any = await db.execute(sql`SELECT COUNT(*) FILTER (WHERE estado = 'aguardando_aprovacao')::int AS fila, COUNT(*) FILTER (WHERE estado IN ('aprovado','agendado'))::int AS aprov FROM mkt_pieces`);
    out.naFila = Number(f.rows?.[0]?.fila || 0); out.aprovadasNaoPostadas = Number(f.rows?.[0]?.aprov || 0);
    const { buscar, GANCHOS, desempenhoPorTag } = await import('./mkt-assets');
    for (const pub of ['b2b', 'b2c']) for (const g of GANCHOS as readonly string[]) {
      const lista = await buscar({ soElegiveis: true, publico: pub, gancho: g, limite: 50 } as any).catch(() => []);
      if (lista.length) out.ganchosComFoto.push({ gancho: g, publico: pub, fotos: lista.length });
    }
    const d = await desempenhoPorTag('gancho', 90).catch(() => ({ linhas: [] }));
    out.desempenhoGancho = (d.linhas || []).map((l: any) => ({ gancho: String(l.valor), usos: Number(l.usos || 0), receitaPorUso: Number(l.receitaPorUso || 0), confiavel: !!l.confiavel }));
  } catch (e: any) { console.error('[MKT-SINAIS] conteudo:', e?.message || e); }
  return out;
}

async function aprendizados(): Promise<string[]> {
  try {
    const r: any = await db.execute(sql.raw(`SELECT enunciado FROM mkt_learnings WHERE ativo = true ORDER BY criado_em DESC LIMIT 12`));
    return (r.rows || []).map((x: any) => String(x.enunciado));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// O retrato completo, em uma chamada. Grava o snapshot.
// ---------------------------------------------------------------------------
export async function lerSinais(): Promise<Sinais> {
  const avisos: string[] = [];
  const retrato = await retratoDaBase().catch((e: any) => { avisos.push('retrato da base falhou: ' + (e?.message || e)); return [] as Retrato[]; });
  const r14 = await reguas14d();
  const [segmentos, cart, pos, acoes, custo, aprend, cont] = await Promise.all([
    segmentosPorRegua(retrato, r14), carteiras(), positivacao(), historicoAcoes(), custoIaMes(), aprendizados(), conteudo(),
  ]);
  const cats = await categoriasAprovadas();
  if (cats.faltando.length) avisos.push('templates sem cadastro em whatsapp_templates: ' + cats.faltando.join(', ') + ' (custo e palpite; liberacao falharia)');

  const sinais: Sinais = {
    data: hojeBR(),
    base: {
      clientes: retrato.length,
      comCiclo: retrato.filter(r => r.ciclo_dias && (r.intervalos || 0) >= 2).length,
      inadimplentes: retrato.filter(r => r.inadimplente).length,
      optout: retrato.filter(r => r.optout).length,
    },
    segmentos, carteiras: cart, positivacao: pos, reguas14d: r14, acoes, custoIaMes: custo, aprendizados: aprend, avisos, conteudo: cont,
  };

  // Snapshot (sem a lista nominal — só os números; a lista vive na ação)
  try {
    const resumo = {
      base: sinais.base, positivacao: pos, custoIaMes: custo, acoes,
      segmentos: segmentos.map(s => ({ id: s.id, total: s.clientes.length, elegiveis: s.elegiveis, ticketMedio: s.ticketMedio, categoria: s.categoria, conversaoMedida: s.conversaoMedida })),
      carteiras: cart.map(c => ({ vendedor: c.vendedor, atual: c.atual, anterior: c.anterior, deltaPct: c.deltaPct, cairam: c.clientesCairam.length })),
      reguas14d: r14, avisos,
    };
    await db.execute(sql`INSERT INTO mkt_sinais (data, sinal, valor) VALUES (${sinais.data}, ${'radar'}, ${JSON.stringify(resumo)}::jsonb)`);
  } catch (e: any) { console.error('[MKT-SINAIS] snapshot:', e?.message || e); }

  return sinais;
}

/** Versão enxuta para o prompt — sem lista nominal, com os números que importam. */
export function sinaisParaPrompt(s: Sinais): any {
  return {
    data: s.data,
    base: s.base,
    positivacao_mes: s.positivacao,
    segmentos_disponiveis: s.segmentos.map(seg => ({
      id: seg.id, nome: seg.nome, descricao: seg.descricao,
      clientes: seg.clientes.length, elegiveis: seg.elegiveis, ticket_medio: seg.ticketMedio,
      categoria_template: seg.categoria, custo_por_mensagem: seg.custoUnit,
      conversao_esperada: seg.conversaoMedida ?? seg.conversaoEsperada,
      conversao_e_medida: seg.conversaoMedida != null,
      por_vendedor: Object.entries(seg.clientes.filter(c => !c.optout && !c.inadimplente).reduce((m: any, c) => { const k = c.vendedor || 'sem'; m[k] = (m[k] || 0) + 1; return m; }, {})),
      maiores_tickets: seg.clientes.filter(c => !c.optout && !c.inadimplente).sort((a, b) => b.ticket - a.ticket).slice(0, 5).map(c => ({ nome: c.nome, ticket: c.ticket, dias: c.dias })),
    })),
    carteiras_30d: s.carteiras.map(c => ({ vendedor: c.vendedor, atual: c.atual, anterior: c.anterior, delta_pct: c.deltaPct, clientes_que_cairam: c.clientesCairam.slice(0, 5) })),
    resultado_reguas_14d: s.reguas14d,
    historico_acoes_30d: s.acoes,
    custo_ia_mes_brl: s.custoIaMes,
    conteudo: { agente_modo: s.conteudo.modo, cota_semana: s.conteudo.cotaSemana, feitas_semana: s.conteudo.feitasSemana, cabe_esta_semana: s.conteudo.cabe,
      pecas_na_fila_de_aprovacao: s.conteudo.naFila, pecas_aprovadas_nao_postadas: s.conteudo.aprovadasNaoPostadas,
      ganchos_com_foto_elegivel: s.conteudo.ganchosComFoto, desempenho_por_gancho_90d: s.conteudo.desempenhoGancho },
    aprendizados: s.aprendizados,
    avisos: s.avisos,
  };
}

export function segmentoPorId(s: Sinais, id: string): Segmento | null {
  return s.segmentos.find(x => x.id === id) || null;
}

export { reguaPorId };
