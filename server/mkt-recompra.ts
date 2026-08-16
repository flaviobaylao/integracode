// ============================================================================
// CENTRAL DE MARKETING — Buraco 8: RÉGUA DE RECOMPRA SOBRE A BASE PRÓPRIA
// ----------------------------------------------------------------------------
// O agente de maior retorno da Central, e o único que não depende de nada de
// fora: nem da Meta, nem de App Review, nem de verba de mídia.
//
// O dado que faz isso funcionar JÁ EXISTE no INTEGRA e nunca foi usado:
// **de quantos em quantos dias cada cliente costuma comprar.** Sabendo o ciclo,
// dá para falar com o cliente NA HORA CERTA — três dias antes de acabar o
// estoque dele, e não um mês depois que ele já comprou do concorrente.
//
// Custo: mensagem utility no 1841 sai por ~R$ 0,04. Uma régua de 400 mensagens
// custa ~R$ 18. Um único ponto de revenda reativado paga isso por muitos meses.
//
// SEGURANÇA — nada sai sozinho:
//   1. o motor MONTA um lote e para;
//   2. a tela mostra custo estimado e receita esperada ANTES de qualquer envio;
//   3. só depois de você liberar o lote as mensagens entram na fila do 1841;
//   4. a fila do 1841 ainda aplica as travas dela (modo off/test/on, teto diário,
//      ritmo por minuto, horário comercial, opt-out, antirrepetição).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// As réguas. Cada uma é um momento, não uma "campanha".
// ---------------------------------------------------------------------------
export type Regua = {
  id: string;
  nome: string;
  descricao: string;
  categoria: 'UTILITY' | 'MARKETING';
  /** conversão esperada (pedido ÷ mensagem). Chute inicial conservador;
   *  o próprio sistema mede o real depois e substitui. */
  conversaoEsperada: number;
  templateLabel: string;   // rótulo em whatsapp_templates (Flavio cadastra)
};

export const REGUAS: Regua[] = [
  { id: 'reposicao', nome: 'Reposição prevista', categoria: 'UTILITY', conversaoEsperada: 0.18,
    descricao: 'Faltam poucos dias para o estoque do cliente acabar, pelo ciclo dele.', templateLabel: 'recompra_reposicao' },
  { id: 'ciclo_furado', nome: 'Ciclo furado', categoria: 'UTILITY', conversaoEsperada: 0.12,
    descricao: 'Passou do dia em que ele costuma comprar e não comprou.', templateLabel: 'recompra_ciclo_furado' },
  { id: 'reativacao', nome: 'Reativação', categoria: 'UTILITY', conversaoEsperada: 0.08,
    descricao: 'Cliente ativo que parou de comprar há 45 dias ou mais.', templateLabel: 'recompra_reativacao' },
  { id: 'mix', nome: 'Ampliar mix', categoria: 'UTILITY', conversaoEsperada: 0.10,
    descricao: 'Compra sempre, mas só 1 ou 2 sabores — cabe mais na prateleira dele.', templateLabel: 'recompra_mix' },
  { id: 'pos_primeira', nome: 'Pós-primeira compra', categoria: 'UTILITY', conversaoEsperada: 0.15,
    descricao: 'Comprou pela primeira vez há ~7 dias. Momento de garantir a segunda.', templateLabel: 'recompra_pos_primeira' },
];

export function reguaPorId(id: string): Regua | null {
  return REGUAS.find(r => r.id === id) || null;
}

// ---------------------------------------------------------------------------
// Parâmetros — todos editáveis sem deploy (system_settings)
// ---------------------------------------------------------------------------
const PADRAO = {
  mkt_recompra_antecedencia_dias: '3',    // reposição: quantos dias antes do fim do ciclo
  mkt_recompra_folga_dias: '7',           // ciclo furado: quantos dias depois do esperado
  mkt_recompra_reativacao_dias: '45',     // reativação: sem compra há N dias
  mkt_recompra_reativacao_max: '180',     // acima disso não é reativação, é prospecção
  mkt_recompra_mix_min_skus: '3',         // abaixo disso entra em "ampliar mix"
  mkt_recompra_frequencia_dias: '14',     // 1 toque por cliente a cada N dias (todas as réguas)
  mkt_recompra_lote_max: '80',            // teto por lote — começa pequeno de propósito
  mkt_recompra_pular_inadimplente: 'on',  // não falar de compra com quem está devendo
  mkt_recompra_min_pedidos_ciclo: '3',    // mínimo de compras para o ciclo ser confiável
};

async function cfg(chave: keyof typeof PADRAO): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${chave} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? PADRAO[chave] : String(v).replace(/^"|"$/g, '');
  } catch { return PADRAO[chave]; }
}
const n = async (k: keyof typeof PADRAO) => Number(await cfg(k)) || Number(PADRAO[k]);

export async function parametros(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(PADRAO) as (keyof typeof PADRAO)[]) out[k] = await cfg(k);
  return out;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktRecompraSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };

  await run('create_fila',
    "CREATE TABLE IF NOT EXISTS mkt_fila_toques (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "lote_id varchar NOT NULL, " +
    "regua varchar NOT NULL, " +
    "cliente_id varchar NOT NULL, cliente_nome varchar, telefone varchar, " +
    "vendedor varchar, " +
    "ciclo_dias int, dias_desde_compra int, ticket_medio numeric(12,2), " +
    "skus int, ultima_compra date, " +
    "canal varchar NOT NULL DEFAULT 'whatsapp_1841', " +
    "template_label varchar, params jsonb, " +
    "custo_estimado numeric(10,4) NOT NULL DEFAULT 0.04, " +
    "receita_esperada numeric(12,2), " +
    "status varchar NOT NULL DEFAULT 'previsto', " +  // previsto | liberado | enfileirado | bloqueado | erro
    "motivo_bloqueio varchar, " +
    "resultado_disparo varchar, " +
    "criado_em timestamptz NOT NULL DEFAULT now(), liberado_em timestamptz, liberado_por varchar)");
  await run('idx_fila_lote', "CREATE INDEX IF NOT EXISTS idx_mkt_fila_lote ON mkt_fila_toques (lote_id)");
  await run('idx_fila_cliente', "CREATE INDEX IF NOT EXISTS idx_mkt_fila_cliente ON mkt_fila_toques (cliente_id, criado_em DESC)");
  await run('create_lotes',
    "CREATE TABLE IF NOT EXISTS mkt_lotes (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "regua varchar, total int NOT NULL DEFAULT 0, bloqueados int NOT NULL DEFAULT 0, " +
    "custo_estimado numeric(12,2), receita_esperada numeric(12,2), " +
    "status varchar NOT NULL DEFAULT 'previsto', " +   // previsto | liberado | descartado
    "criado_em timestamptz NOT NULL DEFAULT now(), liberado_em timestamptz, liberado_por varchar)");

  // Caso de uso próprio na fila do 1841 (o enum já existe; só acrescenta o valor).
  await run('enum_recompra', "ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS 'recompra'");

  _schemaOk = steps.every(s => s.ok);
  _schemaTentativa = Date.now();
  return { ok: _schemaOk, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa > 60_000) await ensureMktRecompraSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// O CORAÇÃO: o retrato de compra de cada cliente
// ---------------------------------------------------------------------------
// Junta as compras do 2.0 (billing_pipeline) com as do 1.0 (billings, por
// documento) — senão cliente antigo pareceria ter parado de comprar.
//
// O ciclo é a MEDIANA dos intervalos entre compras, não a média: um cliente que
// comprou 7, 7, 7 e 90 dias tem ciclo 7 com um sumiço, não ciclo 28. A média
// mentiria e a régua falaria na hora errada.
// ---------------------------------------------------------------------------
const SQL_RETRATO = `
WITH compras AS (
  SELECT bp.customer_id AS cid, bp.created_at::date AS dia
    FROM billing_pipeline bp
   WHERE bp.customer_id IS NOT NULL AND bp.created_at >= now() - interval '720 days'
  UNION
  SELECT c.id AS cid, b.invoice_date::date AS dia
    FROM billings b
    JOIN customers c
      ON translate(coalesce(NULLIF(c.document,''), c.cnpj, c.cpf, ''), './- ', '')
       = translate(coalesce(b.customer_document,''), './- ', '')
   WHERE b.invoice_date >= now() - interval '720 days'
     AND char_length(translate(coalesce(b.customer_document,''), './- ', '')) >= 11
),
dias AS (SELECT DISTINCT cid, dia FROM compras),
gaps AS (
  SELECT cid, dia, (dia - lag(dia) OVER (PARTITION BY cid ORDER BY dia))::int AS gap
    FROM dias
),
ciclo AS (
  SELECT cid,
         COUNT(*) FILTER (WHERE gap IS NOT NULL AND gap BETWEEN 1 AND 180)::int AS intervalos,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY gap) FILTER (WHERE gap BETWEEN 1 AND 180)                   AS ciclo_mediano
    FROM gaps GROUP BY cid
),
resumo AS (
  SELECT cid, MAX(dia) AS ultima_compra, MIN(dia) AS primeira_compra, COUNT(*)::int AS compras
    FROM dias GROUP BY cid
),
ticket AS (
  SELECT customer_id AS cid, AVG(NULLIF(sale_value,0))::numeric(12,2) AS ticket_medio
    FROM sales_cards
   WHERE customer_id IS NOT NULL AND created_at >= now() - interval '365 days'
     AND sale_value IS NOT NULL
   GROUP BY customer_id
),
mix AS (
  -- ⚠️ ACHADO EM PRODUÇÃO: nem todo sales_cards.products é um array. Tem linha
  -- com objeto (e com string) vindas de importações antigas, e o
  -- jsonb_array_elements derrubava a consulta inteira com "cannot extract
  -- elements from an object" — ou seja, a régua não abria para ninguém por causa
  -- de meia dúzia de linhas velhas. O CASE só desembrulha o que é array de fato;
  -- o resto conta zero SKU em vez de quebrar tudo.
  SELECT sc.customer_id AS cid, COUNT(DISTINCT p->>'name')::int AS skus
    FROM sales_cards sc
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(sc.products) = 'array' THEN sc.products ELSE '[]'::jsonb END) p
   WHERE sc.customer_id IS NOT NULL AND sc.created_at >= now() - interval '90 days'
   GROUP BY sc.customer_id
)
SELECT c.id, c.name, c.phone, c.seller_id,
       r.ultima_compra, r.primeira_compra, r.compras,
       ci.intervalos, ROUND(ci.ciclo_mediano)::int AS ciclo_dias,
       COALESCE(t.ticket_medio, 0)                 AS ticket_medio,
       COALESCE(m.skus, 0)                         AS skus,
       ((now() AT TIME ZONE 'America/Sao_Paulo')::date - r.ultima_compra)::int       AS dias_desde_compra,
       (SELECT 1 FROM overdue_debts od WHERE od.client_id = c.id LIMIT 1) AS inadimplente,
       (SELECT 1 FROM chat_customers cc
         WHERE cc.whatsapp_opt_out = true
           AND regexp_replace(COALESCE(cc.phone,''),'[^0-9]','','g')
               LIKE '%' || right(regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g'), 8) LIMIT 1) AS optout
  FROM customers c
  JOIN resumo r ON r.cid = c.id
  LEFT JOIN ciclo  ci ON ci.cid = c.id
  LEFT JOIN ticket t  ON t.cid  = c.id
  LEFT JOIN mix    m  ON m.cid  = c.id
 WHERE c.is_active = true
   AND COALESCE(c.is_lead, false) = false
   AND length(regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g')) >= 10
`;

export type Retrato = {
  id: string; name: string; phone: string; seller_id: string | null;
  ultima_compra: string | null; primeira_compra: string | null; compras: number;
  intervalos: number | null; ciclo_dias: number | null; ticket_medio: string;
  skus: number; dias_desde_compra: number | null;
  inadimplente: number | null; optout: number | null;
};

export async function retratoDaBase(): Promise<Retrato[]> {
  const r: any = await db.execute(sql.raw(SQL_RETRATO));
  return (r.rows || []) as Retrato[];
}

// ---------------------------------------------------------------------------
// Classificação: quem entra em qual régua HOJE
// ---------------------------------------------------------------------------
export async function classificar(retrato: Retrato[], reguaAlvo?: string): Promise<Array<{ cliente: Retrato; regua: string }>> {
  const antecedencia = await n('mkt_recompra_antecedencia_dias');
  const folga = await n('mkt_recompra_folga_dias');
  const reativDe = await n('mkt_recompra_reativacao_dias');
  const reativAte = await n('mkt_recompra_reativacao_max');
  const mixMin = await n('mkt_recompra_mix_min_skus');
  const minPedidos = await n('mkt_recompra_min_pedidos_ciclo');

  const out: Array<{ cliente: Retrato; regua: string }> = [];
  for (const c of retrato) {
    const dias = c.dias_desde_compra;
    const ciclo = c.ciclo_dias;
    const cicloConfiavel = !!(ciclo && ciclo > 0 && (c.intervalos || 0) >= (minPedidos - 1));
    let regua: string | null = null;

    // A ordem importa: o momento mais urgente ganha. Um cliente só entra em UMA
    // régua por rodada — senão vira perseguição.
    const naJanelaDeReposicao = cicloConfiavel && dias != null
      && dias >= (ciclo as number) - antecedencia && dias <= (ciclo as number);
    const mixEstreito = c.skus > 0 && c.skus < mixMin;

    if (dias != null && dias >= reativDe && dias <= reativAte) {
      regua = 'reativacao';
    } else if (cicloConfiavel && dias != null && dias > (ciclo as number) + folga) {
      regua = 'ciclo_furado';
    } else if (naJanelaDeReposicao) {
      // ⚠️ Achado por teste: quem compra certinho no ciclo E tem mix estreito nunca
      // receberia a mensagem de mix, porque a reposição sempre chegava antes. Além de
      // ser um furo, a ordem estava errada como marketing: a HORA de sugerir mais dois
      // sabores é exatamente quando ele vai repor. Então, dentro da janela de reposição,
      // mix estreito manda — a mensagem de mix já carrega a intenção de reposição.
      regua = mixEstreito ? 'mix' : 'reposicao';
    } else if (c.compras === 1 && dias != null && dias >= 6 && dias <= 9) {
      regua = 'pos_primeira';
    } else if (mixEstreito && dias != null && dias <= 60) {
      regua = 'mix';
    }

    if (!regua) continue;
    if (reguaAlvo && regua !== reguaAlvo) continue;
    out.push({ cliente: c, regua });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Montagem do lote — o passo que NÃO envia nada
// ---------------------------------------------------------------------------
export async function montarLote(opts: { regua?: string; limite?: number; criadoPor?: string }): Promise<any> {
  if (!(await garantirSchema())) throw new Error('schema da recompra indisponivel');

  const pularInad = (await cfg('mkt_recompra_pular_inadimplente')) === 'on';
  const freqDias = await n('mkt_recompra_frequencia_dias');
  const teto = Math.min(Number(opts.limite) || await n('mkt_recompra_lote_max'), 500);

  const retrato = await retratoDaBase();
  const candidatos = await classificar(retrato, opts.regua);

  // Quem já recebeu toque recente (qualquer régua) — o frequency cap vale para o
  // cliente, não para a régua. Sem isso, alguém que se encaixa em duas réguas em
  // semanas seguidas recebe mensagem demais e o número perde qualidade.
  const recentes = new Set<string>();
  try {
    const r: any = await db.execute(sql.raw(
      `SELECT DISTINCT cliente_id FROM mkt_fila_toques
        WHERE status IN ('liberado','enfileirado')
          AND criado_em >= now() - interval '${Math.max(1, Math.floor(freqDias))} days'`));
    for (const x of (r.rows || [])) recentes.add(String(x.cliente_id));
  } catch {}

  // A CATEGORIA REAL DO TEMPLATE, e nao a que a regua supoe.
  //
  // REGUAS declara todas como UTILITY (R$ 0,04). Se a Meta aprovar como MARKETING
  // (R$ 0,34 - 8,5x mais caro), a tela mostraria "custo ~R$ 3,20" num lote que
  // custa R$ 27, e a decisao de liberar seria tomada em cima de um numero errado.
  // A categoria aprovada ja esta cadastrada em whatsapp_templates: e de la que ela
  // tem que vir. Sem cadastro, cai na da regua — e o aviso diz que e um palpite.
  const catDoTemplate = new Map<string, string>();
  const templatesFaltando: string[] = [];
  try {
    const rotulos = Array.from(new Set(REGUAS.map(r => r.templateLabel)));
    // IN com um parametro por rotulo, e nao `= ANY(${array})`: o drizzle manda o
    // array JS como texto e o Postgres recusa com "requires array on right side".
    // O erro morreria neste try/catch e a categoria cairia no palpite da regua em
    // silencio — a correcao pareceria funcionar sem fazer nada.
    const t: any = await db.execute(sql`
      SELECT label, categoria FROM whatsapp_templates
       WHERE label IN (${sql.join(rotulos.map(l => sql`${l}`), sql`, `)})`);
    for (const row of (t.rows || [])) {
      const cat = String(row.categoria || '').toUpperCase();
      if (cat) catDoTemplate.set(String(row.label), cat);
    }
    for (const l of rotulos) if (!catDoTemplate.has(l)) templatesFaltando.push(l);
  } catch {
    // Sem a tabela nao da para saber: segue com a categoria da regua. Faltar o
    // cadastro nao e motivo para nao montar o lote — e motivo para avisar.
  }

  const loteId: string = (await db.execute(sql`
    INSERT INTO mkt_lotes (regua, status) VALUES (${opts.regua || 'todas'}, 'previsto') RETURNING id`) as any)
      .rows?.[0]?.id;

  let incluidos = 0, bloqueados = 0, custo = 0, receita = 0;
  const porRegua: Record<string, { total: number; custo: number; receita: number }> = {};

  for (const { cliente: c, regua: rid } of candidatos) {
    const regua = reguaPorId(rid)!;
    let bloqueio: string | null = null;
    if (c.optout) bloqueio = 'opt-out';
    else if (pularInad && c.inadimplente) bloqueio = 'inadimplente';
    else if (recentes.has(String(c.id))) bloqueio = 'frequencia';
    else if (incluidos >= teto) bloqueio = 'teto do lote';

    const ticket = Number(c.ticket_medio || 0);
    const receitaEsperada = bloqueio ? 0 : ticket * regua.conversaoEsperada;
    const categoria = catDoTemplate.get(regua.templateLabel) || regua.categoria;
    const custoUnit = categoria === 'MARKETING' ? 0.34 : 0.04;

    await db.execute(sql`
      INSERT INTO mkt_fila_toques
        (lote_id, regua, cliente_id, cliente_nome, telefone, vendedor, ciclo_dias, dias_desde_compra,
         ticket_medio, skus, ultima_compra, template_label, params, custo_estimado, receita_esperada,
         status, motivo_bloqueio)
      VALUES
        (${loteId}, ${rid}, ${c.id}, ${c.name}, ${String(c.phone || '').replace(/\D/g, '')}, ${c.seller_id || null},
         ${c.ciclo_dias}, ${c.dias_desde_compra}, ${ticket}, ${c.skus}, ${c.ultima_compra},
         ${regua.templateLabel}, ${JSON.stringify([String(c.name || '').split(' ')[0] || 'tudo bem'])}::jsonb,
         ${bloqueio ? 0 : custoUnit}, ${receitaEsperada.toFixed(2)},
         ${bloqueio ? 'bloqueado' : 'previsto'}, ${bloqueio})`);

    if (bloqueio) { bloqueados++; continue; }
    incluidos++; custo += custoUnit; receita += receitaEsperada;
    porRegua[rid] = porRegua[rid] || { total: 0, custo: 0, receita: 0 };
    porRegua[rid].total++; porRegua[rid].custo += custoUnit; porRegua[rid].receita += receitaEsperada;
  }

  await db.execute(sql`
    UPDATE mkt_lotes SET total = ${incluidos}, bloqueados = ${bloqueados},
      custo_estimado = ${custo.toFixed(2)}, receita_esperada = ${receita.toFixed(2)}
    WHERE id = ${loteId}`);

  return {
    loteId, total: incluidos, bloqueados,
    custoEstimado: Number(custo.toFixed(2)),
    receitaEsperada: Number(receita.toFixed(2)),
    porRegua: Object.entries(porRegua).map(([regua, v]) => ({
      regua, nome: reguaPorId(regua)?.nome || regua, total: v.total,
      custo: Number(v.custo.toFixed(2)), receita: Number(v.receita.toFixed(2)),
    })),
    baseAnalisada: retrato.length,
    candidatos: candidatos.length,
    // Sem estes rotulos cadastrados, o lote monta e a liberacao falha item a item
    // la na frente. Melhor dizer aqui, com o lote na tela, do que depois.
    templatesFaltando,
    custoConfiavel: templatesFaltando.length === 0,
  };
}

export async function verLote(loteId: string): Promise<any> {
  const l: any = await db.execute(sql`SELECT * FROM mkt_lotes WHERE id = ${loteId} LIMIT 1`);
  const itens: any = await db.execute(sql`
    SELECT * FROM mkt_fila_toques WHERE lote_id = ${loteId}
     ORDER BY (status = 'bloqueado'), receita_esperada DESC NULLS LAST LIMIT 500`);
  return { lote: l.rows?.[0] || null, itens: itens.rows || [], reguas: REGUAS };
}

// ---------------------------------------------------------------------------
// Liberação — só aqui alguma mensagem entra na fila do 1841
// ---------------------------------------------------------------------------
export async function liberarLote(loteId: string, por: string): Promise<any> {
  if (!(await garantirSchema())) throw new Error('schema da recompra indisponivel');
  const l: any = await db.execute(sql`SELECT * FROM mkt_lotes WHERE id = ${loteId} LIMIT 1`);
  const lote = l.rows?.[0];
  if (!lote) throw new Error('lote nao encontrado');
  if (lote.status === 'liberado') throw new Error('lote ja foi liberado');

  const itens: any = await db.execute(sql`SELECT * FROM mkt_fila_toques WHERE lote_id = ${loteId} AND status = 'previsto'`);
  const { enqueueOfficialDispatch } = await import('./official-dispatch');

  // Mesma regra do montarLote: a categoria que vai para o disparo e a APROVADA,
  // nao a que a regua supoe. Mandar UTILITY num template que a Meta aprovou como
  // MARKETING nao muda o que a Meta cobra — muda so a conta que a gente faz.
  const catDoTemplate = new Map<string, string>();
  try {
    const rotulos = Array.from(new Set(REGUAS.map(r => r.templateLabel)));
    const t: any = await db.execute(sql`
      SELECT label, categoria FROM whatsapp_templates
       WHERE label IN (${sql.join(rotulos.map(l => sql`${l}`), sql`, `)})`);
    for (const row of (t.rows || [])) {
      const cat = String(row.categoria || '').toUpperCase();
      if (cat) catDoTemplate.set(String(row.label), cat);
    }
  } catch { /* cai na categoria da regua */ }

  const resultado: Record<string, number> = {};
  for (const it of (itens.rows || [])) {
    let r = 'erro';
    try {
      const regua = reguaPorId(String(it.regua));
      r = await enqueueOfficialDispatch({
        customerId: it.cliente_id,
        customerPhone: it.telefone,
        templateLabel: it.template_label,
        params: (it.params as string[]) || [],
        useCase: 'recompra',
        category: (catDoTemplate.get(String(it.template_label)) || regua?.categoria || 'UTILITY') as any,
        // O evento é o cliente + a régua + o lote: reprocessar o lote nunca duplica.
        campaign: 'recompra:' + it.regua + ':' + loteId,
      });
    } catch (e: any) {
      r = 'erro: ' + String(e?.message || e).slice(0, 60);
    }
    resultado[r] = (resultado[r] || 0) + 1;
    await db.execute(sql`
      UPDATE mkt_fila_toques
         SET status = ${r === 'enfileirado' ? 'enfileirado' : 'erro'},
             resultado_disparo = ${r}, liberado_em = now(), liberado_por = ${por}
       WHERE id = ${it.id}`);
  }

  await db.execute(sql`UPDATE mkt_lotes SET status='liberado', liberado_em=now(), liberado_por=${por} WHERE id=${loteId}`);
  return { loteId, resultado };
}

export async function descartarLote(loteId: string): Promise<any> {
  await db.execute(sql`DELETE FROM mkt_fila_toques WHERE lote_id = ${loteId} AND status IN ('previsto','bloqueado')`);
  await db.execute(sql`UPDATE mkt_lotes SET status='descartado' WHERE id=${loteId} AND status='previsto'`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Painel: o retrato da base + o que a régua rendeu
// ---------------------------------------------------------------------------
export async function panorama(): Promise<any> {
  const retrato = await retratoDaBase();
  const candidatos = await classificar(retrato);
  const porRegua: Record<string, number> = {};
  for (const c of candidatos) porRegua[c.regua] = (porRegua[c.regua] || 0) + 1;

  const comCiclo = retrato.filter(r => r.ciclo_dias && (r.intervalos || 0) >= 2);
  const ciclos = comCiclo.map(r => Number(r.ciclo_dias)).sort((a, b) => a - b);
  const cicloMediano = ciclos.length ? ciclos[Math.floor(ciclos.length / 2)] : null;

  let lotes: any[] = [];
  try {
    const l: any = await db.execute(sql`SELECT * FROM mkt_lotes ORDER BY criado_em DESC LIMIT 20`);
    lotes = l.rows || [];
  } catch {}

  // Resultado real: pedidos que apareceram depois do toque, por régua.
  let resultado: any[] = [];
  try {
    const r: any = await db.execute(sql.raw(`
      SELECT f.regua,
             COUNT(*)::int                                   AS enviados,
             COUNT(sc.id)::int                               AS pedidos,
             ROUND(COALESCE(SUM(sc.sale_value), 0), 2)       AS receita,
             ROUND(COALESCE(SUM(f.custo_estimado), 0), 2)    AS custo
        FROM mkt_fila_toques f
        LEFT JOIN sales_cards sc
          ON sc.customer_id = f.cliente_id
         AND sc.created_at BETWEEN f.liberado_em AND f.liberado_em + interval '14 days'
       WHERE f.status = 'enfileirado'
       GROUP BY f.regua ORDER BY receita DESC`));
    resultado = r.rows || [];
  } catch {}

  return {
    base: {
      clientes: retrato.length,
      comCicloConfiavel: comCiclo.length,
      cicloMedianoDias: cicloMediano,
      inadimplentes: retrato.filter(r => r.inadimplente).length,
      optout: retrato.filter(r => r.optout).length,
    },
    candidatosHoje: REGUAS.map(r => ({
      id: r.id, nome: r.nome, descricao: r.descricao, categoria: r.categoria,
      conversaoEsperada: r.conversaoEsperada, template: r.templateLabel,
      candidatos: porRegua[r.id] || 0,
    })),
    totalCandidatos: candidatos.length,
    lotes, resultado,
    parametros: await parametros(),
  };
}
