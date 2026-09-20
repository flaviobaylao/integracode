// server/painel-atendimento-digital.ts
// -----------------------------------------------------------------------------
// GESTAO — ATENDIMENTO DIGITAL (bloco novo da tela /painel-atendimento)
//
// O painel de atendimento mostrava so o CAMPO: vendedor, visita, pedido, km.
// Tudo que fala com o cliente por tela — WhatsApp oficial, IA, Instagram,
// anuncio, aviso de entrega — nao aparecia em lugar nenhum. Este endpoint e a
// outra metade: uma leitura so, por periodo, de tudo que a Honest trocou com
// cliente.
//
// Acesso: admin e administrative, igual ao painel de campo.
//
// REGUAS (o numero tem que bater com a tela de origem, senao nao serve):
//   * RECEBIDA   = chat_messages.sender_type = 'customer'. E o cliente falando,
//                  em qualquer canal.
//   * ENVIADA    = qualquer outra linha de chat_messages, separada por QUEM:
//                    IA      -> sender_id LIKE 'agent:%'   (agent-runtime)
//                    sistema -> sender_id = 'system'       (avisos, retomada)
//                    humano  -> o resto                    (atendente digitando)
//                  Disparo de template NAO entra aqui: ele vive em
//                  official_dispatches e e contado separado, senao dobra.
//   * CANAL      = da CONVERSA, nao da mensagem:
//                    customer_phone LIKE 'ig:%'         -> Instagram Direct
//                    last_inbound_channel = 'oficial_1841' -> WhatsApp oficial
//                    resto                               -> WhatsApp (outros numeros)
//   * RESPOSTA   = primeira mensagem nao-cliente depois de uma do cliente, na
//                  mesma conversa, com menos de 12 h de intervalo (acima disso e
//                  conversa nova, nao demora de resposta).
//   * DISPARO    = official_dispatches. 'enviado' = status IN (enviada, entregue,
//                  lida, resposta) — o mesmo conjunto que o painel do 1841 usa.
//                  Custo = estimated_cost (0,34 MARKETING / 0,04 UTILITY).
//   * INSTAGRAM  = social_metrics. A leitura e CUMULATIVA por post (uma por dia),
//                  entao somar dias inflaria: pega-se a ULTIMA leitura de cada
//                  post dentro do periodo.
//   * ANUNCIO    = mkt_ads_diario, que ja e por dia — esse soma normalmente.
//   * ENTREGA    = official_dispatches com use_case 'entrega', quebrado por
//                  template (saiu / feita / devolvida / pos-entrega).
//   * REGUA      = mkt_fila_toques do periodo, por status.
//
// FUSO: as duas convencoes convivem aqui. chat_messages.created_at e `timestamp`
// SEM fuso guardando UTC (conversao dupla); mkt_* e social_* sao timestamptz
// (conversao simples). official_dispatches ja foi descrito nesta linha como
// naive, e NAO e — o que jogava todo disparo feito depois das 18h BRT para o dia
// seguinte no painel. Por isso o dia agora vem de `diaBR`, que PERGUNTA o tipo
// ao catalogo do Postgres em vez de confiar na memoria de quem escreveu.
//
// Nenhuma consulta e obrigatoria: cada bloco cai em zero se a tabela nao existir
// naquele ambiente. Um painel que quebra inteiro porque uma tabela sumiu nao
// serve para diagnosticar nada.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { diaBR } from "./fuso-coluna";

const TZ = "America/Sao_Paulo";
const PAPEIS = ["admin", "administrative"];

/** Dia BR de uma coluna `timestamp` sem fuso guardando UTC. */
const diaDeNaive = (col: string) => `((${col}) AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date`;
/** Dia BR de uma coluna `timestamptz`. */
const diaDeTz = (col: string) => `((${col}) AT TIME ZONE '${TZ}')::date`;

function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDias(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const num = (v: any) => (v == null ? 0 : Number(v) || 0);

/** Roda a consulta; se a tabela nao existe naquele ambiente, devolve [] e segue. */
async function q(texto: string): Promise<any[]> {
  try { return ((await db.execute(sql.raw(texto))) as any).rows || []; }
  catch (e: any) { console.warn("[ATEND-DIGITAL] consulta ignorada:", String(e?.message || e).slice(0, 140)); return []; }
}

export type ResumoDigital = Awaited<ReturnType<typeof resumoDigital>>;

/**
 * Tudo que a Honest trocou com cliente no periodo [de, ate] (datas BR inclusivas).
 */
export async function resumoDigital(de: string, ate: string) {
  const ini = `'${de}'::date`;
  const fim = `'${ate}'::date`;
  // Recorte de chat_messages e official_dispatches (naive UTC) pelo dia BR.
  const noPeriodoNaive = (col: string) => `${diaDeNaive(col)} BETWEEN ${ini} AND ${fim}`;
  const noPeriodoTz = (col: string) => `${diaDeTz(col)} BETWEEN ${ini} AND ${fim}`;
  // official_dispatches: o tipo real da coluna decide a conversao.
  const diaDisparoCriado = await diaBR("official_dispatches", "created_at", "created_at");
  const diaDisparoEnvio = await diaBR("official_dispatches", "sent_at", "sent_at");
  const noPeriodoDisparo = (expr: string) => `${expr} BETWEEN ${ini} AND ${fim}`;

  // Classificacao de quem enviou e por qual canal — usada em varias consultas.
  const QUEM = `CASE WHEN m.sender_type = 'customer' THEN 'cliente'
                     WHEN COALESCE(m.sender_id,'') LIKE 'agent:%' THEN 'ia'
                     WHEN COALESCE(m.sender_id,'') = 'system' THEN 'sistema'
                     ELSE 'humano' END`;
  // last_inbound_channel entrou por SQL solto e nao existe no schema do drizzle;
  // to_jsonb le a coluna quando ela existe e devolve NULL quando nao existe.
  const CANAL = `CASE WHEN COALESCE(c.customer_phone,'') LIKE 'ig:%' THEN 'instagram'
                      WHEN to_jsonb(c) ->> 'last_inbound_channel' = 'oficial_1841' THEN 'whatsapp_1841'
                      ELSE 'whatsapp_outros' END`;

  const [
    porQuemCanal, conversasRow, respostaRow, janelaRow,
    disparoTpl, disparoUso, iaRow, iaAgente,
    igRow, igDm, adsRow, entregaRow, reguaRow, serieRow, acaoRow,
  ] = await Promise.all([
    // 1. mensagens por quem enviou x canal
    q(`SELECT ${CANAL} AS canal, ${QUEM} AS quem, count(*)::int AS n,
              count(DISTINCT m.conversation_id)::int AS conversas
         FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE ${noPeriodoNaive("m.created_at")}
        GROUP BY 1, 2`),

    // 2. conversas tocadas e clientes distintos no periodo
    q(`SELECT count(DISTINCT m.conversation_id)::int AS conversas,
              count(DISTINCT c.customer_phone)::int AS clientes,
              count(DISTINCT m.conversation_id) FILTER (WHERE ${noPeriodoNaive("c.created_at")})::int AS novas
         FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE ${noPeriodoNaive("m.created_at")}`),

    // 3. demora ate a primeira resposta depois de uma mensagem do cliente
    q(`WITH m AS (
         SELECT m.conversation_id, m.created_at,
                (m.sender_type = 'customer') AS entrada,
                (COALESCE(m.sender_id,'') LIKE 'agent:%') AS por_ia
           FROM chat_messages m
          WHERE ${noPeriodoNaive("m.created_at")}
       ), p AS (
         SELECT created_at AS resposta, por_ia, entrada,
                LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at) AS antes,
                LAG(entrada)    OVER (PARTITION BY conversation_id ORDER BY created_at) AS antes_entrada
           FROM m
       )
       SELECT round(avg(EXTRACT(EPOCH FROM (resposta - antes))/60)::numeric, 1) AS media_min,
              round(avg(EXTRACT(EPOCH FROM (resposta - antes))/60) FILTER (WHERE por_ia)::numeric, 1) AS media_ia_min,
              round(avg(EXTRACT(EPOCH FROM (resposta - antes))/60) FILTER (WHERE NOT por_ia)::numeric, 1) AS media_humano_min,
              count(*)::int AS respostas,
              count(*) FILTER (WHERE por_ia)::int AS respostas_ia
         FROM p
        WHERE antes_entrada AND NOT entrada AND (resposta - antes) < interval '12 hours'`),

    // 4. janelas de 24 h abertas agora (so faz sentido "agora", nao no periodo)
    q(`SELECT count(*) FILTER (WHERE (to_jsonb(c) ->> 'window_open_until')::timestamptz > now())::int AS abertas,
              count(*)::int AS oficiais
         FROM chat_conversations c
        WHERE to_jsonb(c) ->> 'last_inbound_channel' = 'oficial_1841'`),

    // 5. disparos oficiais por template, com o caminho da entrega
    //    'enviada' so diz que a Meta aceitou; 'entregue'/'lida' vem do estado que
    //    o Umbler confirma (server/official-entrega.ts). Uma mensagem parada em
    //    'enviada' meia hora depois provavelmente NAO chegou.
    q(`SELECT template_label AS template, COALESCE(category,'UTILITY') AS categoria,
              COALESCE(use_case::text,'—') AS uso,
              count(*) FILTER (WHERE mode = 'test')::int AS ensaio,
              count(*) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta'))::int AS enviados,
              count(*) FILTER (WHERE status::text IN ('entregue','lida','resposta'))::int AS entregues,
              count(*) FILTER (WHERE status::text IN ('lida','resposta'))::int AS lidas,
              count(*) FILTER (WHERE status::text = 'resposta')::int AS responderam,
              count(*) FILTER (WHERE status::text = 'falha')::int AS falhas,
              count(*) FILTER (WHERE status::text = 'fila')::int AS fila,
              round(COALESCE(sum(estimated_cost) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta')),0)::numeric, 2) AS custo
         FROM official_dispatches
        WHERE ${noPeriodoDisparo(diaDisparoCriado)}
        GROUP BY 1, 2, 3 ORDER BY enviados DESC, template`),

    // 6. disparos por caso de uso
    q(`SELECT COALESCE(use_case::text,'—') AS uso,
              count(*) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta'))::int AS enviados,
              round(COALESCE(sum(estimated_cost) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta')),0)::numeric, 2) AS custo
         FROM official_dispatches
        WHERE ${noPeriodoDisparo(diaDisparoCriado)}
        GROUP BY 1 ORDER BY enviados DESC`),

    // 7. custo e volume da IA
    q(`SELECT count(*)::int AS execucoes,
              count(*) FILTER (WHERE NOT sucesso)::int AS erros,
              round(COALESCE(sum(custo_brl),0)::numeric, 2) AS custo_brl,
              round(COALESCE(avg(duracao_ms),0)::numeric, 0) AS duracao_media_ms
         FROM mkt_agent_runs WHERE ${noPeriodoTz("criado_em")}`),

    q(`SELECT agente, count(*)::int AS execucoes,
              round(COALESCE(sum(custo_brl),0)::numeric, 2) AS custo_brl,
              count(*) FILTER (WHERE NOT sucesso)::int AS erros
         FROM mkt_agent_runs WHERE ${noPeriodoTz("criado_em")}
        GROUP BY 1 ORDER BY execucoes DESC`),

    // 8. Instagram — insight e cumulativo por post: vale a ULTIMA leitura do periodo
    q(`WITH ult AS (
         SELECT DISTINCT ON (post_id) post_id, alcance, impressoes, curtidas, comentarios,
                salvos, compartilhamentos, cliques_link, novos_seguidores
           FROM social_metrics
          WHERE data BETWEEN ${ini} AND ${fim}
          ORDER BY post_id, data DESC
       )
       SELECT count(*)::int AS posts,
              COALESCE(sum(alcance),0)::int AS alcance,
              COALESCE(sum(impressoes),0)::int AS impressoes,
              COALESCE(sum(curtidas),0)::int AS curtidas,
              COALESCE(sum(comentarios),0)::int AS comentarios,
              COALESCE(sum(salvos),0)::int AS salvos,
              COALESCE(sum(compartilhamentos),0)::int AS compartilhamentos,
              COALESCE(sum(cliques_link),0)::int AS cliques_link,
              COALESCE(sum(novos_seguidores),0)::int AS novos_seguidores
         FROM ult`),

    q(`SELECT count(*)::int AS publicados FROM social_posts WHERE ${noPeriodoTz("publicado_em")}`),

    // 9. anuncios — mkt_ads_diario ja e por dia, soma normal
    q(`SELECT COALESCE(sum(gasto),0)::numeric(12,2) AS gasto,
              COALESCE(sum(impressoes),0)::int AS impressoes,
              COALESCE(sum(cliques),0)::int AS cliques,
              COALESCE(sum(conversas),0)::int AS conversas,
              COALESCE(sum(alcance),0)::int AS alcance,
              count(DISTINCT ad_id)::int AS anuncios
         FROM mkt_ads_diario WHERE data BETWEEN ${ini} AND ${fim}`),

    // 10. avisos de entrega, por momento
    q(`SELECT CASE WHEN template_label IN ('entrega_saiu','pedido_saiu_entrega') THEN 'saiu'
                   WHEN template_label IN ('entrega_feita','pedido_entregue') THEN 'entregue'
                   WHEN template_label IN ('entrega_devolvida','entrega_nao_realizada') THEN 'devolvida'
                   WHEN template_label LIKE 'pos_entrega%' THEN 'pos_entrega'
                   ELSE 'outros' END AS momento,
              count(*) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta'))::int AS enviados,
              count(*) FILTER (WHERE status::text = 'fila')::int AS agendados
         FROM official_dispatches
        WHERE ${noPeriodoDisparo(diaDisparoCriado)}
          AND (COALESCE(use_case::text,'') = 'entrega'
               OR template_label IN ('entrega_saiu','entrega_feita','entrega_devolvida',
                                     'pedido_saiu_entrega','pedido_entregue','entrega_nao_realizada')
               OR template_label LIKE 'pos_entrega%')
        GROUP BY 1`),

    // 11. reguas de recompra
    q(`SELECT status, count(*)::int AS n, round(COALESCE(sum(custo_estimado),0)::numeric,2) AS custo
         FROM mkt_fila_toques WHERE ${noPeriodoTz("criado_em")} GROUP BY 1`),

    // 12. serie por dia — o grafico
    q(`WITH d AS (SELECT generate_series(${ini}, ${fim}, interval '1 day')::date AS dia),
            msg AS (
              SELECT ${diaDeNaive("m.created_at")} AS dia,
                     count(*) FILTER (WHERE m.sender_type = 'customer')::int AS recebidas,
                     count(*) FILTER (WHERE m.sender_type <> 'customer')::int AS enviadas,
                     count(*) FILTER (WHERE COALESCE(m.sender_id,'') LIKE 'agent:%')::int AS ia
                FROM chat_messages m
               WHERE ${noPeriodoNaive("m.created_at")}
               GROUP BY 1),
            dis AS (
              SELECT ${diaDisparoEnvio} AS dia, count(*)::int AS disparos
                FROM official_dispatches
               WHERE sent_at IS NOT NULL AND ${noPeriodoDisparo(diaDisparoEnvio)}
               GROUP BY 1)
       SELECT to_char(d.dia,'YYYY-MM-DD') AS dia,
              COALESCE(msg.recebidas,0) AS recebidas,
              COALESCE(msg.enviadas,0)  AS enviadas,
              COALESCE(msg.ia,0)        AS ia,
              COALESCE(dis.disparos,0)  AS disparos
         FROM d LEFT JOIN msg ON msg.dia = d.dia LEFT JOIN dis ON dis.dia = d.dia
        ORDER BY d.dia`),

    // 13. acoes executadas: o que cada uma custou e o que voltou
    //
    // A janela e a do painel OU 14 dias, o que for maior: a medicao de uma acao
    // corre por 14 dias depois da execucao, entao uma acao de ontem ainda esta
    // rendendo hoje — corta-la no dia mostraria custo sem retorno.
    //
    // CUSTO: o real, somando os toques que de fato sairam (mkt_fila_toques em
    // 'enfileirado'); so cai no custo_estimado da acao quando nao ha toque
    // (visita, anuncio, ajuste de sistema).
    // RECEITA: resultado->receita, gravado por medir(). Para anuncio o custo
    // real e o gasto na Meta (resultado->gasto).
    q(`SELECT a.numero, a.tipo, a.titulo, a.status::text AS status, a.modo_teste,
              to_char(${diaDeTz("a.executada_em")}, 'YYYY-MM-DD') AS dia,
              (a.medido_em IS NOT NULL) AS fechado,
              round(COALESCE(a.custo_estimado,0)::numeric,2) AS custo_estimado,
              round(COALESCE(a.receita_esperada,0)::numeric,2) AS receita_esperada,
              round(COALESCE((a.resultado->>'gasto')::numeric, (a.resultado->>'custo')::numeric, t.custo_real, a.custo_estimado, 0)::numeric, 2) AS custo,
              CASE WHEN a.resultado ? 'receita' THEN round((a.resultado->>'receita')::numeric, 2) END AS receita,
              (a.resultado->>'pedidos')::int AS pedidos,
              (a.resultado->>'clientes')::int AS clientes,
              (a.resultado->>'conversas')::int AS conversas,
              COALESCE(a.publico_total, 0)::int AS publico,
              COALESCE(t.enviados, 0)::int AS enviados
         FROM mkt_acoes a
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE status = 'enfileirado')::int AS enviados,
                  sum(custo_estimado) FILTER (WHERE status = 'enfileirado') AS custo_real
             FROM mkt_fila_toques WHERE acao_id = a.id
         ) t ON true
        WHERE a.status::text IN ('executada','executando')
          AND a.executada_em IS NOT NULL
          AND ${diaDeTz("a.executada_em")} BETWEEN LEAST(${ini}, ${fim} - 13) AND ${fim}
        ORDER BY a.executada_em DESC LIMIT 60`),
  ]);

  // ── mensagens: totais e quebra por canal ──────────────────────────────────
  const CANAIS: Record<string, string> = {
    whatsapp_1841: "WhatsApp oficial",
    whatsapp_outros: "WhatsApp (outros números)",
    instagram: "Instagram Direct",
  };
  const porCanal = Object.keys(CANAIS).map(k => ({
    canal: k, rotulo: CANAIS[k],
    recebidas: 0, enviadas: 0, ia: 0, humano: 0, sistema: 0, conversas: 0,
  }));
  const msgs = { recebidas: 0, enviadas: 0, ia: 0, humano: 0, sistema: 0 };
  for (const r of porQuemCanal) {
    const linha = porCanal.find(c => c.canal === String(r.canal)) || porCanal[1];
    const n = num(r.n), quem = String(r.quem);
    if (quem === "cliente") { linha.recebidas += n; msgs.recebidas += n; }
    else {
      linha.enviadas += n; msgs.enviadas += n;
      if (quem === "ia") { linha.ia += n; msgs.ia += n; }
      else if (quem === "humano") { linha.humano += n; msgs.humano += n; }
      else { linha.sistema += n; msgs.sistema += n; }
    }
    linha.conversas = Math.max(linha.conversas, num(r.conversas));
  }

  const cv = conversasRow[0] || {};
  const rp = respostaRow[0] || {};
  const jn = janelaRow[0] || {};
  const ia = iaRow[0] || {};
  const ig = igRow[0] || {};
  const ads = adsRow[0] || {};

  const disparosEnviados = disparoTpl.reduce((t, r) => t + num(r.enviados), 0);
  const disparosCusto = disparoTpl.reduce((t, r) => t + num(r.custo), 0);
  const disparosEntregues = disparoTpl.reduce((t, r) => t + num(r.entregues), 0);
  const disparosLidas = disparoTpl.reduce((t, r) => t + num(r.lidas), 0);
  const respostas = num(rp.respostas);
  const entregas = { saiu: 0, entregue: 0, devolvida: 0, pos_entrega: 0, agendados: 0 };
  for (const r of entregaRow) {
    const k = String(r.momento) as keyof typeof entregas;
    if (k in entregas) entregas[k] += num(r.enviados);
    entregas.agendados += num(r.agendados);
  }
  const reguas = { previsto: 0, liberado: 0, enfileirado: 0, bloqueado: 0, erro: 0, custo: 0 };
  for (const r of reguaRow) {
    const k = String(r.status) as keyof typeof reguas;
    if (k in reguas) (reguas as any)[k] += num(r.n);
    reguas.custo += num(r.custo);
  }

  // ── acoes: custo real x retorno medido ────────────────────────────────────
  const TIPOS: Record<string, string> = {
    regua: "Régua WhatsApp", alerta: "Alerta ao vendedor", peca: "Peça de conteúdo",
    campanha: "Campanha + link", cupom: "Cupom", visita: "Visita",
    anuncio: "Anúncio pago", sistema: "Ajuste do sistema",
  };
  const acoes = acaoRow.map(r => {
    const custo = num(r.custo), receita = r.receita == null ? null : num(r.receita);
    return {
      numero: num(r.numero), tipo: String(r.tipo), tipoNome: TIPOS[String(r.tipo)] || String(r.tipo),
      titulo: String(r.titulo || ""), status: String(r.status), dia: String(r.dia || ""),
      modoTeste: r.modo_teste === true, fechado: r.fechado === true,
      custo, receita,
      receitaEsperada: num(r.receita_esperada),
      // Retorno = quantas vezes o custo voltou. Sem custo (alerta, visita) nao
      // ha multiplo a calcular — o numero que vale ali e a receita em si.
      retorno: receita != null && custo > 0 ? Math.round((receita / custo) * 10) / 10 : null,
      pedidos: num(r.pedidos), clientes: num(r.clientes), conversas: num(r.conversas),
      publico: num(r.publico), enviados: num(r.enviados),
    };
  });
  const comReceita = acoes.filter(a => a.receita != null);
  const custoAcoes = acoes.reduce((t, a) => t + a.custo, 0);
  const receitaAcoes = comReceita.reduce((t, a) => t + (a.receita || 0), 0);
  const custoMedido = comReceita.reduce((t, a) => t + a.custo, 0);
  const porTipo = Object.values(acoes.reduce((acc: Record<string, any>, a) => {
    const k = a.tipo;
    acc[k] = acc[k] || { tipo: k, tipoNome: a.tipoNome, acoes: 0, custo: 0, receita: 0, medidas: 0 };
    acc[k].acoes++; acc[k].custo += a.custo;
    if (a.receita != null) { acc[k].receita += a.receita; acc[k].medidas++; }
    return acc;
  }, {})).map((t: any) => ({
    ...t,
    custo: Math.round(t.custo * 100) / 100,
    receita: Math.round(t.receita * 100) / 100,
    retorno: t.custo > 0 && t.medidas ? Math.round((t.receita / t.custo) * 10) / 10 : null,
  })).sort((a: any, b: any) => b.receita - a.receita || b.custo - a.custo);

  return {
    de, ate, dias: Math.round((Date.parse(ate) - Date.parse(de)) / 86400000) + 1,
    geradoEm: new Date().toISOString(),
    mensagens: {
      ...msgs,
      total: msgs.recebidas + msgs.enviadas,
      conversas: num(cv.conversas),
      conversasNovas: num(cv.novas),
      clientes: num(cv.clientes),
      respostas,
      respostasIa: num(rp.respostas_ia),
      pctIa: respostas ? Math.round((num(rp.respostas_ia) / respostas) * 1000) / 10 : 0,
      tempoRespostaMin: rp.media_min == null ? null : num(rp.media_min),
      tempoRespostaIaMin: rp.media_ia_min == null ? null : num(rp.media_ia_min),
      tempoRespostaHumanoMin: rp.media_humano_min == null ? null : num(rp.media_humano_min),
    },
    porCanal,
    janela24h: { abertas: num(jn.abertas), conversasOficiais: num(jn.oficiais) },
    disparos: {
      enviados: disparosEnviados,
      entregues: disparosEntregues,
      lidas: disparosLidas,
      // Saiu, mas o aparelho ainda não confirmou. Zero é o esperado; número alto
      // e persistente quer dizer que a mensagem não está chegando.
      semConfirmacao: disparosEnviados - disparosEntregues,
      pctEntrega: disparosEnviados ? Math.round((disparosEntregues / disparosEnviados) * 1000) / 10 : null,
      pctLeitura: disparosEntregues ? Math.round((disparosLidas / disparosEntregues) * 1000) / 10 : null,
      ensaio: disparoTpl.reduce((t, r) => t + num(r.ensaio), 0),
      fila: disparoTpl.reduce((t, r) => t + num(r.fila), 0),
      falhas: disparoTpl.reduce((t, r) => t + num(r.falhas), 0),
      responderam: disparoTpl.reduce((t, r) => t + num(r.responderam), 0),
      custo: Math.round(disparosCusto * 100) / 100,
      porTemplate: disparoTpl.map(r => ({
        template: String(r.template || "—"), categoria: String(r.categoria), uso: String(r.uso),
        enviados: num(r.enviados), entregues: num(r.entregues), lidas: num(r.lidas),
        responderam: num(r.responderam), falhas: num(r.falhas),
        fila: num(r.fila), custo: num(r.custo), ensaio: num(r.ensaio),
      })),
      porUso: disparoUso.map(r => ({ uso: String(r.uso), enviados: num(r.enviados), custo: num(r.custo) })),
    },
    ia: {
      execucoes: num(ia.execucoes), erros: num(ia.erros), custo: num(ia.custo_brl),
      duracaoMediaMs: num(ia.duracao_media_ms),
      porAgente: iaAgente.map(r => ({ agente: String(r.agente), execucoes: num(r.execucoes), custo: num(r.custo_brl), erros: num(r.erros) })),
    },
    instagram: {
      posts: num(ig.posts), publicados: num((igDm[0] || {}).publicados),
      alcance: num(ig.alcance), impressoes: num(ig.impressoes), curtidas: num(ig.curtidas),
      comentarios: num(ig.comentarios), salvos: num(ig.salvos),
      compartilhamentos: num(ig.compartilhamentos), cliquesLink: num(ig.cliques_link),
      novosSeguidores: num(ig.novos_seguidores),
      direct: porCanal.find(c => c.canal === "instagram") || null,
    },
    ads: {
      anuncios: num(ads.anuncios), gasto: num(ads.gasto), impressoes: num(ads.impressoes),
      cliques: num(ads.cliques), conversas: num(ads.conversas), alcance: num(ads.alcance),
      custoPorConversa: num(ads.conversas) ? Math.round((num(ads.gasto) / num(ads.conversas)) * 100) / 100 : null,
    },
    entregas,
    reguas,
    acoes: {
      total: acoes.length,
      medidas: comReceita.length,
      medindo: acoes.length - comReceita.length,
      custo: Math.round(custoAcoes * 100) / 100,
      receita: Math.round(receitaAcoes * 100) / 100,
      // Retorno so compara o que da para comparar: receita medida sobre o custo
      // DAS ACOES MEDIDAS. Dividir pela conta toda, com metade ainda medindo,
      // daria um numero baixo e falso.
      retorno: custoMedido > 0 && comReceita.length ? Math.round((receitaAcoes / custoMedido) * 10) / 10 : null,
      esperado: Math.round(acoes.reduce((t, a) => t + a.receitaEsperada, 0) * 100) / 100,
      porTipo,
      lista: acoes,
    },
    serie: serieRow.map(r => ({
      dia: String(r.dia), recebidas: num(r.recebidas), enviadas: num(r.enviadas),
      ia: num(r.ia), disparos: num(r.disparos),
    })),
  };
}

export function registerPainelAtendimentoDigital(app: Express) {
  // GET /api/gestao/atendimento-digital?dia=YYYY-MM-DD&dias=1|7|30
  app.get("/api/gestao/atendimento-digital", authenticateUser, requireRole(PAPEIS), async (req: Request, res: Response) => {
    try {
      const hoje = hojeBR();
      const m = String(req.query.dia || "").match(/^\d{4}-\d{2}-\d{2}$/);
      const ate = m ? m[0] : hoje;
      const dias = Math.min(90, Math.max(1, Number(req.query.dias) || 1));
      const de = addDias(ate, -(dias - 1));
      res.setHeader("Cache-Control", "no-store");
      res.json({ hoje, ehHoje: ate === hoje, ...(await resumoDigital(de, ate)) });
    } catch (e: any) {
      console.error("[ATEND-DIGITAL]", e?.message || e);
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  });
  console.log("[ATEND-DIGITAL] registrado (/api/gestao/atendimento-digital)");
}
