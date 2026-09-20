// server/mkt-ensaio.ts
// -----------------------------------------------------------------------------
// ENSAIO GERAL DA CENTRAL DE MARKETING
//
// Roda TODAS as rotinas da Central de ponta a ponta e diz, passo a passo, o que
// funcionou e o que nao. Existe porque testar isso a mao e inviavel: sao quatro
// agentes, oito tipos de acao, cinco canais e uma fila de disparo — e um pedaco
// so quebrado (um template desligado, uma chave que venceu) aparece como
// "nao aconteceu nada", que e o defeito mais caro de diagnosticar.
//
// DOIS MODOS:
//   seco (padrao)  — exercita tudo, MAS nao dispara mensagem nenhuma. Serve para
//                    rodar sempre, inclusive depois de cada deploy.
//   enviar         — dispara de verdade, em modo 'test': o Umbler redireciona
//                    para INTEGRA_OFICIAL_TEST_PHONES (os aparelhos do ensaio),
//                    nunca para cliente. Modo teste tambem ignora o expediente,
//                    entao da para ensaiar a noite ou no fim de semana.
//
// O RASTRO FICA. O ensaio NAO apaga o que criou: mensagem enviada e mensagem
// enviada de verdade, custou dinheiro de verdade, e tem que aparecer no painel
// de atendimento — e justamente olhando o painel encher que se ve a Central
// funcionando. Tudo que o ensaio cria leva a marca '[ensaio]' e o id da rodada,
// entao da para distinguir no painel e apagar depois, de uma vez, com
// POST /api/mkt/ensaio/limpar?id=<id>.
//
// O QUE NUNCA ACONTECE AQUI: mandar mensagem para CLIENTE real (modo teste
// redireciona), publicar no Instagram, ou criar anuncio que gaste dinheiro.
//
// COMO LER O RELATORIO: cada passo devolve ok/falhou/pulado + detalhe. 'pulado'
// nao e defeito: e uma rotina que depende de algo ausente naquele ambiente
// (conta de anuncio nao configurada, por exemplo) e ela diz o que falta.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

type Estado = "ok" | "falhou" | "pulado";
type Passo = { n: number; grupo: string; passo: string; estado: Estado; detalhe: string; ms: number };

const PAPEIS = ["admin"];
const MARCA = "[ensaio]"; // tudo que o ensaio cria leva esta marca no titulo/comentario

export class Ensaio {
  passos: Passo[] = [];
  criados: { tabela: string; id: string }[] = [];
  enviar: boolean;
  private n = 0;

  constructor(enviar: boolean) { this.enviar = enviar; }

  /** Roda um passo, cronometra e guarda o resultado. Nunca lanca. */
  async passo(grupo: string, passo: string, fn: () => Promise<string | { estado: Estado; detalhe: string }>): Promise<Estado> {
    const t0 = Date.now();
    this.n++;
    try {
      const r = await fn();
      const { estado, detalhe } = typeof r === "string" ? { estado: "ok" as Estado, detalhe: r } : r;
      this.passos.push({ n: this.n, grupo, passo, estado, detalhe, ms: Date.now() - t0 });
      return estado;
    } catch (e: any) {
      this.passos.push({ n: this.n, grupo, passo, estado: "falhou", detalhe: String(e?.message || e).slice(0, 300), ms: Date.now() - t0 });
      return "falhou";
    }
  }
  anotar(tabela: string, id: string) { if (id) this.criados.push({ tabela, id }); }
  get resumo() {
    const c = (e: Estado) => this.passos.filter(p => p.estado === e).length;
    return { total: this.passos.length, ok: c("ok"), falhou: c("falhou"), pulado: c("pulado") };
  }
}

const set = (k: string, v: string) =>
  db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (${k}, ${v}, 'mkt-ensaio', now())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'mkt-ensaio', updated_at = now()`);
const get = async (k: string, d = "") => {
  try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${k} LIMIT 1`);
    const v = r.rows?.[0]?.value; return v == null ? d : String(v).replace(/^"|"$/g, ""); } catch { return d; }
};
const uma = async (texto: any): Promise<any> => { try { return ((await db.execute(texto)) as any).rows?.[0] || null; } catch { return null; } };

/**
 * O ensaio inteiro. `enviar` liga o disparo real (redirecionado aos telefones de teste).
 */
export async function rodarEnsaio(opts: { enviar?: boolean; quem?: string; limpar?: boolean } = {}) {
  const e = new Ensaio(!!opts.enviar);
  const quem = opts.quem || "ensaio";
  const t0 = Date.now();
  // Id da rodada: carimba tudo que o ensaio criar, para dar para achar no painel
  // e apagar depois sem varrer a marca junto com dado de verdade.
  const ensaioId = "ens-" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const marca = `${MARCA} ${ensaioId}`;
  const limpar = opts.limpar === true; // padrao: NAO limpa — o rastro tem que aparecer no painel

  // Guarda os modos atuais para devolver tudo como estava no fim.
  const modosAntes: Record<string, string> = {};
  for (const k of ["mkt_radar_modo", "mkt_publicador_modo", "mkt_ads_modo", "oficial_mode_recompra", "oficial_mode_entrega"]) {
    modosAntes[k] = await get(k, "");
  }

  // ========================================================================
  // 1. INFRAESTRUTURA — sem isto, nenhuma rotina roda
  // ========================================================================
  await e.passo("Infra", "Chave da Anthropic (os agentes pensam?)", async () =>
    process.env.ANTHROPIC_API_KEY ? "presente" : { estado: "falhou", detalhe: "ANTHROPIC_API_KEY ausente — nenhum agente roda" });

  await e.passo("Infra", "Telefones do ensaio", async () => {
    const tp = (process.env.INTEGRA_OFICIAL_TEST_PHONES || "").split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
    if (!tp.length) return { estado: "falhou", detalhe: "INTEGRA_OFICIAL_TEST_PHONES vazia — o modo teste nao tem para onde enviar" };
    return `${tp.length} número(s): ${tp.map(p => p.slice(0, 4) + "…" + p.slice(-4)).join(", ")}`;
  });

  await e.passo("Infra", "Canal oficial do WhatsApp (1841)", async () =>
    process.env.UMBLER_TALK_TOKEN ? "token do Umbler presente" : { estado: "falhou", detalhe: "UMBLER_TALK_TOKEN ausente — nada sai pelo 1841" });

  await e.passo("Infra", "Templates da régua aprovados", async () => {
    const { categoriasAprovadas } = await import("./mkt-recompra");
    const { mapa, faltando } = await categoriasAprovadas();
    if (faltando.length) return { estado: "falhou", detalhe: `faltam no cadastro: ${faltando.join(", ")}` };
    const rot: string[] = []; mapa.forEach((c, l) => rot.push(`${l}=${c}`));
    return `${mapa.size} template(s): ${rot.join(", ")}`;
  });

  await e.passo("Infra", "Instagram conectado", async () => {
    const { status } = await import("./mkt-ig-auth");
    const s: any = await status();
    if (!s?.conectado) return { estado: "falhou", detalhe: "Instagram desconectado — o publicador não sobe peça" };
    const dias = s.diasRestantes == null ? "?" : `${s.diasRestantes} dia(s)`;
    const pode = [s.podePublicar ? "publica" : null, s.podeInsights ? "lê insights" : null].filter(Boolean).join(" e ") || "sem permissão de publicar";
    return `@${s.username || "?"} — token vale ${dias}; ${pode}`;
  });

  await e.passo("Infra", "Conta de anúncios da Meta", async () => {
    const ads = await import("./mkt-meta-ads");
    const p: any = await ads.pronto();
    if (!p?.pronto) return { estado: "pulado", detalhe: `não configurada — falta ${(p?.falta || []).join(", ")}` };
    return "pronta";
  });

  await e.passo("Infra", "Aprovadores cadastrados", async () => {
    const { aprovadores } = await import("./mkt-acoes");
    const lista = await aprovadores();
    if (!lista.length) return { estado: "falhou", detalhe: "nenhum aprovador — o resumo diário não tem destino" };
    return lista.map((p: string) => p.slice(0, 4) + "…" + p.slice(-4)).join(", ");
  });

  // ========================================================================
  // 2. AGENTES — cada um roda e grava o que fez
  // ========================================================================
  await e.passo("Agentes", "Auditor audita a própria Central", async () => {
    const { rodar } = await import("./mkt-auditor");
    const r: any = await rodar({ quem: "ensaio" });
    if (!r?.ok && !r?.nota) return { estado: "falhou", detalhe: String(r?.motivo || "não devolveu nota") };
    const alertas = (r.checagens || []).filter((c: any) => c.gravidade !== "ok").length;
    return `nota ${r.nota}/100, ${alertas} ponto(s) de atenção`;
  });

  await e.passo("Agentes", "Radar lê a base e propõe ações", async () => {
    await set("mkt_radar_modo", "test"); // nada executa sozinho durante o ensaio
    const { rodar } = await import("./mkt-radar");
    const r: any = await rodar({ quem: "ensaio", forcar: true });
    if (!r?.ok) return { estado: "falhou", detalhe: String(r?.motivo || "não rodou") };
    for (const c of (r.criadas || [])) { const row = await uma(sql`SELECT id FROM mkt_acoes WHERE numero = ${c.numero}`); if (row) e.anotar("mkt_acoes", row.id); }
    return `${(r.criadas || []).length} proposta(s), ${(r.descartadas || []).length} descartada(s) — ${r.duracaoMs} ms`;
  });

  await e.passo("Agentes", "Agente de conteúdo escreve uma peça", async () => {
    const c = await import("./mkt-agente-conteudo");
    const pr: any = await c.prontidao();
    if (pr && pr.pode === false) return { estado: "pulado", detalhe: String(pr.motivo || "sem assunto ou criativo disponível") };
    const r: any = await c.rodar({ quem: "ensaio" });
    if (!r?.ok) return { estado: "falhou", detalhe: String(r?.motivo || r?.erro || "não gerou") };
    if (r.pecaId) e.anotar("mkt_pieces", r.pecaId);
    return `peça ${r.numero || r.pecaId || "?"} criada (${r.gancho || "sem gancho"})`;
  });

  await e.passo("Agentes", "Otimizador lê o que já foi medido", async () => {
    const o = await import("./mkt-otimizador");
    const r: any = await o.rodar({ quem: "ensaio" });
    if (r?.ok === false) return { estado: "pulado", detalhe: String(r?.motivo || "sem amostra suficiente ainda") };
    return `${(r?.aprendizados || r?.criados || []).length ?? 0} aprendizado(s)`;
  });

  // ========================================================================
  // 3. CAIXA DE DECISÕES — o ciclo completo de uma ação, tipo por tipo
  // ========================================================================
  const { criarAcao, decidir, executar, medir, expirar, ver } = await import("./mkt-acoes");

  /** Cria uma ação de ensaio, aprova, executa e conta o que houve. */
  const cicloDaAcao = async (tipo: any, titulo: string, extra: any = {}) => {
    const a = await criarAcao({
      tipo, agente: "mkt_ensaio", titulo: `${marca} ${titulo}`,
      justificativa: "Ação criada pelo ensaio geral. Não representa uma decisão de negócio.",
      custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 2, modoTeste: !e.enviar,
      prazoHoras: 1, ...extra,
    });
    e.anotar("mkt_acoes", a.id);
    // N0/N1 executam sozinhas: a politica do tipo manda, nao o que o ensaio pede.
    // Em modo teste toda acao vira N2, entao este caminho so aparece no ensaio real —
    // e 'auto' ali e o comportamento CERTO, nao defeito.
    if (a.status === "auto") {
      const dep: any = await ver(a.id);
      return { estado: "ok" as Estado, detalhe: `#${a.numero} nasceu N${a.nivel} (política do tipo) → executou sozinha → ${dep?.status}` };
    }
    if (a.status !== "proposta") return { estado: "falhou" as Estado, detalhe: `nasceu como '${a.status}', esperava 'proposta' ou 'auto'` };
    const d = await decidir({ ids: [a.id], decisao: "aprovar", quem, via: "tela", comentario: marca });
    const depois: any = await ver(a.id);
    const ex = d.execucoes?.[0] || {};
    if (depois?.status === "erro") return { estado: "falhou" as Estado, detalhe: `executou com erro: ${String(depois?.execucao?.erro || ex.erro || "?").slice(0, 160)}` };
    return { estado: "ok" as Estado, detalhe: `#${a.numero} proposta → aprovada → ${depois?.status}${ex.detalhe ? ` (${JSON.stringify(ex.detalhe).slice(0, 120)})` : ""}` };
  };

  await e.passo("Caixa", "Alerta ao vendedor: propor → aprovar → executar", async () =>
    cicloDaAcao("alerta", "alerta ao vendedor", {
      parametros: { texto: `${marca} Teste do ensaio geral da Central. Pode ignorar.`, vendedor_id: null },
    }));

  await e.passo("Caixa", "Visita: propor → aprovar → entra na agenda", async () => {
    const cli = await uma(sql`SELECT id, name FROM customers WHERE COALESCE(phone,'') <> '' AND is_active IS NOT FALSE ORDER BY created_at DESC LIMIT 1`);
    if (!cli) return { estado: "pulado", detalhe: "nenhum cliente com telefone na base" };
    return cicloDaAcao("visita", "visita de ensaio", {
      publico: { clientes: [{ id: String(cli.id), nome: String(cli.name || "") }] },
      parametros: { dias: 1, motivo: `${marca} visita de teste` },
    });
  });

  await e.passo("Caixa", "Ajuste de sistema: propor → aprovar → muda o parâmetro", async () => {
    const antes = await get("mkt_recompra_lote_max", "60");
    const r = await cicloDaAcao("sistema", "ajuste de parâmetro", {
      parametros: { tipo: "setting", chave: "mkt_recompra_lote_max", valor: Number(antes) || 60, antes: Number(antes) || 60 },
    });
    await set("mkt_recompra_lote_max", antes); // devolve o valor original
    return r;
  });

  await e.passo("Caixa", "Rejeitar uma proposta", async () => {
    const a = await criarAcao({
      tipo: "alerta", agente: "mkt_ensaio", titulo: `${marca} proposta para rejeitar`,
      justificativa: "ensaio", parametros: { texto: "x" }, custoEstimado: 0, receitaEsperada: 0,
      nivelSugerido: 2, modoTeste: true, prazoHoras: 1,
    });
    e.anotar("mkt_acoes", a.id);
    const d = await decidir({ ids: [a.id], decisao: "rejeitar", quem, via: "tela", comentario: `${marca} rejeitada no ensaio` });
    const depois: any = await ver(a.id);
    if (d.aplicadas !== 1 || depois?.status !== "rejeitada") return { estado: "falhou", detalhe: `status ficou '${depois?.status}'` };
    return "rejeição registrada com motivo";
  });

  await e.passo("Caixa", "Proposta vencida expira sozinha", async () => {
    const a = await criarAcao({
      tipo: "alerta", agente: "mkt_ensaio", titulo: `${marca} proposta que vai expirar`,
      justificativa: "ensaio", parametros: { texto: "x" }, custoEstimado: 0, receitaEsperada: 0,
      nivelSugerido: 2, modoTeste: true, prazoHoras: 1,
    });
    e.anotar("mkt_acoes", a.id);
    await db.execute(sql`UPDATE mkt_acoes SET expira_em = now() - interval '1 hour' WHERE id = ${a.id}`);
    const n = await expirar();
    const depois: any = await ver(a.id);
    if (depois?.status !== "expirada") return { estado: "falhou", detalhe: `expirar() devolveu ${n}, status ficou '${depois?.status}'` };
    return `expirou (${n} no total)`;
  });

  await e.passo("Caixa", "Medição fecha o resultado das executadas", async () => {
    const n = await medir();
    return `${n} ação(ões) medida(s)`;
  });

  // ========================================================================
  // 4. RÉGUA DE WHATSAPP — o caminho mais caro, do lote ao disparo
  // ========================================================================
  let loteEnsaio: string | null = null;
  await e.passo("Régua", "Montar o lote (quem entra, quem é bloqueado e por quê)", async () => {
    const { montarLote } = await import("./mkt-recompra");
    const l: any = await montarLote({ regua: "reativacao", limite: 3, criadoPor: quem });
    if (!l?.loteId && !l?.id) return { estado: "pulado", detalhe: String(l?.motivo || "nenhum cliente elegível na régua de reativação agora") };
    loteEnsaio = String(l.loteId || l.id);
    e.anotar("mkt_lotes", loteEnsaio);
    return `lote com ${l.total ?? "?"} toque(s), ${l.bloqueados ?? 0} bloqueado(s), custo ${Number(l.custoEstimado || 0).toFixed(2)}`;
  });

  await e.passo("Régua", e.enviar ? "Liberar o lote e DISPARAR para os telefones do ensaio" : "Liberar o lote (sem disparar)", async () => {
    if (!loteEnsaio) return { estado: "pulado", detalhe: "não houve lote para liberar" };
    if (!e.enviar) {
      const f = await uma(sql`SELECT count(*)::int AS n FROM mkt_fila_toques WHERE lote_id = ${loteEnsaio} AND status = 'previsto'`);
      return `${f?.n ?? 0} toque(s) prontos — ensaio seco, nada foi enviado`;
    }
    await set("oficial_mode_recompra", "test"); // redireciona para os telefones de teste
    const { liberarLote } = await import("./mkt-recompra");
    const r: any = await liberarLote(loteEnsaio, quem);
    const fila = await uma(sql`SELECT count(*) FILTER (WHERE status='enfileirado')::int AS ok,
                                      count(*) FILTER (WHERE status='erro')::int AS erro
                                 FROM mkt_fila_toques WHERE lote_id = ${loteEnsaio}`);
    if (!Number(fila?.ok)) return { estado: "falhou", detalhe: `nada entrou na fila (${JSON.stringify(r).slice(0, 160)})` };
    return `${fila?.ok} toque(s) na fila do 1841, ${fila?.erro || 0} erro(s) — sai redirecionado para os números do ensaio`;
  });

  await e.passo("Régua", "Fila do 1841 processa e entrega", async () => {
    if (!e.enviar) return { estado: "pulado", detalhe: "ensaio seco" };
    const { processDispatchQueueTick } = await import("./official-dispatch");
    for (let i = 0; i < 6; i++) { await processDispatchQueueTick(); await new Promise(r => setTimeout(r, 900)); }
    const s = await uma(sql`SELECT count(*) FILTER (WHERE status::text IN ('enviada','entregue','lida','resposta'))::int AS enviadas,
                                   count(*) FILTER (WHERE status::text = 'falha')::int AS falhas,
                                   count(*) FILTER (WHERE status::text = 'fila')::int AS fila
                              FROM official_dispatches WHERE use_case::text = 'recompra' AND created_at > now() - interval '10 minutes'`);
    if (Number(s?.falhas)) return { estado: "falhou", detalhe: `${s?.falhas} falha(s), ${s?.enviadas} enviada(s)` };
    return `${s?.enviadas || 0} enviada(s), ${s?.fila || 0} ainda na fila`;
  });

  // ========================================================================
  // 5. CONTEÚDO — esteira e publicador
  // ========================================================================
  await e.passo("Conteúdo", "Esteira: fila de peças e aprovação", async () => {
    const { fila } = await import("./mkt-esteira");
    const f: any = await fila();
    const n = (f?.itens || f?.pecas || []).length;
    return `${n} peça(s) aguardando aprovação`;
  });

  await e.passo("Conteúdo", "Publicador (modo teste: monta tudo, não publica)", async () => {
    const p = await import("./mkt-publicador");
    await p.definirModo("test");
    const r: any = await p.panorama();
    const f = r?.fila || {};
    return `modo ${r?.modo || "test"} — ${f.aprovadas ?? 0} aprovada(s), ${f.agendadas ?? 0} agendada(s), ${f.publicadas30 ?? 0} publicada(s) em 30 dias`;
  });

  // ========================================================================
  // 6. ENTREGA — os quatro avisos ao cliente
  // ========================================================================
  await e.passo("Entrega", "Avisos de entrega configurados", async () => {
    let ec: any;
    try { ec = await import("./entrega-cliente"); }
    catch { return { estado: "pulado", detalhe: "módulo de pós-venda ainda não está neste deploy" }; }
    const p = await ec.panorama();
    const faltam = Object.entries(p.templates || {}).filter(([, v]) => !v).map(([k]) => k);
    if (faltam.length) return { estado: "falhou", detalhe: `sem template ativo para: ${faltam.join(", ")}` };
    const usando = Object.keys(p.templates || {}).map(k => `${k}→${(p.templates as any)[k].label}`).join(", ");
    return `ligado=${p.ligado}; ${usando}`;
  });

  await e.passo("Entrega", "Rota iniciada avisa os clientes da rota", async () => {
    let ec: any;
    try { ec = await import("./entrega-cliente"); } catch { return { estado: "pulado", detalhe: "módulo ainda não está neste deploy" }; }
    const rota = await uma(sql`SELECT r.id, count(s.id)::int AS paradas FROM delivery_routes r
                                 JOIN delivery_route_stops s ON s.route_id = r.id AND s.status = 'pendente'
                                WHERE r.route_date >= current_date - 7 GROUP BY r.id ORDER BY r.route_date DESC LIMIT 1`);
    if (!rota) return { estado: "pulado", detalhe: "nenhuma rota recente com parada pendente para ensaiar" };
    if (!e.enviar) return { estado: "pulado", detalhe: `rota ${String(rota.id).slice(0, 8)} com ${rota.paradas} parada(s) — ensaio seco` };
    await set("oficial_mode_entrega", "test");
    const r = await ec.avisarRotaIniciada(String(rota.id));
    return `${r.enviados} aviso(s) enfileirado(s) — ${r.detalhes.slice(0, 3).join(" | ")}`;
  });

  // Os outros tres momentos: entrega feita (+ follow-up de 2 dias) e devolucao.
  // Usa uma parada de verdade, sem mexer no status dela — so os avisos.
  await e.passo("Entrega", "Entrega feita avisa e agenda a conferência de 2 dias", async () => {
    let ec: any;
    try { ec = await import("./entrega-cliente"); } catch { return { estado: "pulado", detalhe: "módulo ainda não está neste deploy" }; }
    if (!e.enviar) return { estado: "pulado", detalhe: "ensaio seco" };
    const parada = await uma(sql`SELECT s.id, s.sales_card_id FROM delivery_route_stops s
                                   JOIN customers c ON c.id = s.customer_id AND COALESCE(c.phone,'') <> ''
                                  WHERE s.sales_card_id IS NOT NULL ORDER BY s.id DESC LIMIT 1`);
    if (!parada) return { estado: "pulado", detalhe: "nenhuma parada com cliente e pedido para ensaiar" };
    await set("oficial_mode_entrega", "test");
    const r = await ec.avisarEntregaEfetuada(String(parada.id));
    const agora = String(r.agora);
    // 'duplicado' nao e defeito: e a guarda anti-duplicidade dizendo que aquele
    // pedido ja foi avisado. Num ensaio repetido essa e a resposta SAUDAVEL. O
    // que o passo precisa provar e que existe a linha de disparo e que ela nao
    // morreu no caminho — por isso o ensaio vai conferir a linha de qualquer jeito.
    if (!agora.startsWith("enfileirado") && !/ja avisado/.test(agora) && !agora.startsWith("duplicado"))
      return { estado: "falhou", detalhe: `aviso de entrega: ${agora}` };
    const linha = await uma(sql`SELECT status::text AS status, error FROM official_dispatches
                                 WHERE campaign = ${`card:${String(parada.sales_card_id)}:entregue`}
                                 ORDER BY created_at DESC LIMIT 1`);
    if (!linha) return { estado: "falhou", detalhe: `${agora}, mas nenhum disparo de entrega ficou registrado` };
    if (linha.status === "falha")
      return { estado: "falhou", detalhe: `disparo registrado mas falhou: ${String(linha.error || "sem motivo").slice(0, 110)}` };
    const nota = agora.startsWith("duplicado") ? "já avisado antes (guarda anti-duplicidade)" : agora;
    return `agora: ${nota} — disparo está '${linha.status}'; em 2 dias: ${r.followUp}`;
  });

  await e.passo("Entrega", "Devolução avisa e cancela a conferência agendada", async () => {
    let ec: any;
    try { ec = await import("./entrega-cliente"); } catch { return { estado: "pulado", detalhe: "módulo ainda não está neste deploy" }; }
    if (!e.enviar) return { estado: "pulado", detalhe: "ensaio seco" };
    const parada = await uma(sql`SELECT s.id, s.sales_card_id FROM delivery_route_stops s
                                   JOIN customers c ON c.id = s.customer_id AND COALESCE(c.phone,'') <> ''
                                  WHERE s.sales_card_id IS NOT NULL ORDER BY s.id DESC LIMIT 1`);
    if (!parada) return { estado: "pulado", detalhe: "nenhuma parada para ensaiar" };
    const r = String(await ec.avisarEntregaDevolvida(String(parada.id), `${marca} devolução simulada`));
    if (!r.startsWith("enfileirado") && !/ja avisado/.test(r) && !r.startsWith("duplicado"))
      return { estado: "falhou", detalhe: r };
    const linhaDev = await uma(sql`SELECT status::text AS status, error FROM official_dispatches
                                    WHERE campaign LIKE ${`card:${String(parada.sales_card_id)}:devolvida:%`}
                                    ORDER BY created_at DESC LIMIT 1`);
    if (!linhaDev) return { estado: "falhou", detalhe: `${r}, mas nenhum aviso de devolução ficou registrado` };
    if (linhaDev.status === "falha")
      return { estado: "falhou", detalhe: `aviso registrado mas falhou: ${String(linhaDev.error || "sem motivo").slice(0, 110)}` };
    const cancelado = await uma(sql`SELECT count(*)::int AS n FROM official_dispatches
                                     WHERE campaign LIKE 'card:%:pos2d' AND status::text = 'falha' AND error LIKE 'cancelado%'`);
    return `${r}; ${cancelado?.n || 0} conferência(s) de 2 dias cancelada(s) por devolução`;
  });

  // ========================================================================
  // 7. ATENDIMENTO — a IA responde quem escreve
  // ========================================================================
  await e.passo("Atendimento", "Agente de atendimento ligado", async () => {
    const modo = await get("agents_runtime_mode", "off");
    if (modo === "off") return { estado: "falhou", detalhe: "agents_runtime_mode=off — ninguém responde o cliente" };
    const ag = await uma(sql`SELECT count(*)::int AS n FROM agentes_config WHERE ativo`);
    return `modo ${modo}, ${ag?.n || 0} agente(s) ativo(s)`;
  });

  await e.passo("Atendimento", "IA reabre para responder quem recebeu disparo", async () => {
    const on = await get("ia_disparo_reabre", "on");
    const horas = await get("ia_disparo_horas", "48");
    if (on !== "on") return { estado: "falhou", detalhe: "ia_disparo_reabre=off — resposta a template ficaria sem atendimento" };
    return `ligado, janela de ${horas} h`;
  });

  // O teste de verdade do atendimento: o telefone do ensaio escreve, e a IA tem
  // que responder. Entra pelas MESMAS funcoes que o webhook do Umbler chama
  // depois de normalizar o payload — o que nao se exercita aqui e so a leitura
  // do payload cru, que e a parte que nao quebra sozinha.
  await e.passo("Atendimento", e.enviar ? "Cliente escreve e a IA responde (ida e volta real)" : "Cliente escreve e a IA responde", async () => {
    const fone = (process.env.INTEGRA_OFICIAL_TEST_PHONES || "").split(",").map(s => s.replace(/\D/g, "")).filter(Boolean)[0];
    if (!fone) return { estado: "pulado", detalhe: "sem telefone de ensaio configurado" };
    if ((await get("agents_runtime_mode", "off")) === "off") return { estado: "pulado", detalhe: "agents_runtime_mode=off" };

    const { storage } = await import("./storage");
    let conv: any = await uma(sql`SELECT id FROM chat_conversations WHERE right(regexp_replace(COALESCE(customer_phone,''),'\\D','','g'), 8) = ${fone.slice(-8)} LIMIT 1`);
    if (!conv) {
      const cc: any = await uma(sql`INSERT INTO chat_customers (name, phone) VALUES (${"Ensaio da Central"}, ${"+" + fone}) RETURNING id`);
      conv = await uma(sql`INSERT INTO chat_conversations (customer_id, customer_name, customer_phone, status)
                            VALUES (${cc?.id || null}, ${"Ensaio da Central"}, ${"+" + fone}, 'new') RETURNING id`);
      if (conv?.id) e.anotar("chat_conversations", String(conv.id));
    }
    if (!conv?.id) return { estado: "falhou", detalhe: "não consegui abrir a conversa do ensaio" };

    const pergunta = `${marca} Oi! Quanto custa a caixa de suco de laranja?`;
    const msg = await storage.createChatMessage({
      conversationId: String(conv.id), senderId: "cliente-ensaio", senderType: "customer",
      content: pergunta, messageType: "text",
    } as any);
    if (msg?.id) e.anotar("chat_messages", String(msg.id));

    const antes: any = await uma(sql`SELECT count(*)::int AS n FROM chat_messages
                                      WHERE conversation_id = ${String(conv.id)} AND COALESCE(sender_id,'') LIKE 'agent:%'`);
    const { maybeRunAgent } = await import("./agent-runtime");
    const enviadas: string[] = [];
    let erroEnvio = "";
    await maybeRunAgent({
      phone: fone, conversationId: String(conv.id), incomingText: pergunta, channel: "whatsapp",
      // Em ensaio seco a resposta e montada mas nao sai do predio.
      sendText: async (_to: string, texto: string) => {
        enviadas.push(texto);
        if (!e.enviar) return { simulado: true };
        const { sendOfficialText } = await import("./official-dispatch");
        const r: any = await sendOfficialText(fone, texto);
        // Texto livre so passa DENTRO da janela de 24 h. Fora dela o Umbler
        // devolve 400 — a IA "respondeu" mas ninguem recebeu, e dar isso como
        // sucesso e o tipo de falso positivo que o ensaio existe para evitar.
        if (r && r.success === false) erroEnvio = String(r.error || "envio recusado");
        return r;
      },
    });
    const depois: any = await uma(sql`SELECT count(*)::int AS n FROM chat_messages
                                       WHERE conversation_id = ${String(conv.id)} AND COALESCE(sender_id,'') LIKE 'agent:%'`);
    if (!enviadas.length && Number(depois?.n) <= Number(antes?.n)) {
      const t: any = await uma(sql`SELECT porta, detalhe FROM ia_trilha WHERE conversation_id = ${String(conv.id)} ORDER BY criado_at DESC LIMIT 1`);
      return { estado: "falhou", detalhe: `a IA não respondeu${t ? ` — porta '${t.porta}' ${String(t.detalhe || "")}` : " (sem trilha registrada)"}` };
    }
    const r = enviadas[0] || "(gravada na conversa)";
    const previa = `“${r.slice(0, 110).replace(/\n/g, " ")}…”`;
    if (erroEnvio) {
      // Fora da janela de 24 h o Umbler recusa texto livre, e isso nao e defeito
      // do atendimento: e pre-requisito que falta. So se abre mandando uma
      // mensagem DE VERDADE do telefone do ensaio para o WhatsApp da Honest.
      const semJanela = /24\s*h|janela|window|outside|1013|131047|re-?engage/i.test(erroEnvio) || /\b400\b/.test(erroEnvio);
      if (semJanela)
        return { estado: "pulado", detalhe: `a IA respondeu ${previa} — mas não há janela de 24 h aberta, então nada saiu. Mande um "oi" do telefone do ensaio para o WhatsApp da Honest e rode o ensaio de novo para fechar essa ida e volta` };
      return { estado: "falhou", detalhe: `a IA respondeu ${previa} mas o envio foi recusado: ${erroEnvio.slice(0, 120)}` };
    }
    return `respondeu em ${enviadas.length || 1} mensagem: ${previa}`;
  });

  // ========================================================================
  // 8. PAINÉIS — os números que você olha
  // ========================================================================
  await e.passo("Painéis", "Painel do dia responde e fecha as contas", async () => {
    const { painelDoDia } = await import("./mkt-hoje");
    const p: any = await painelDoDia();
    if (!p?.numeros) return { estado: "falhou", detalhe: "painel sem bloco de números" };
    return `${p.pendentes?.length ?? 0} pendente(s), ${p.rodando?.length ?? 0} rodando, auditor ${p.auditor?.nota ?? "?"}/100`;
  });

  await e.passo("Painéis", "Atendimento digital responde", async () => {
    let pd: any;
    try { pd = await import("./painel-atendimento-digital"); }
    catch { return { estado: "pulado", detalhe: "painel digital ainda não está neste deploy" }; }
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const d = await pd.resumoDigital(hoje, hoje);
    return `${d.mensagens.recebidas} recebidas, ${d.mensagens.enviadas} enviadas, ${d.disparos.enviados} disparos, ${d.acoes.total} ação(ões)`;
  });

  // O painel de comunicação e a lista de onde saem os disparos manuais. Se ele
  // devolve lista vazia ou um tipo sem template aprovado, ninguém consegue
  // mandar nada — e isso aparece como "cliquei e não aconteceu", que é caro de
  // diagnosticar depois. Aqui é barato.
  await e.passo("Painéis", "Painel de comunicação lista e sabe o que pode enviar", async () => {
    let pc: any;
    try { pc = await import("./painel-comunicacao"); }
    catch { return { estado: "pulado", detalhe: "painel de comunicação ainda não está neste deploy" }; }
    const r = await pc.listarClientes({ limite: 5000 });
    if (!r.itens.length) return { estado: "falhou", detalhe: "nenhum cliente ativo na lista — filtro de ativo quebrado?" };
    const tipos = await pc.prontidaoDosTipos();
    const prontos = tipos.filter((t: any) => !t.pendencia).map((t: any) => t.id);
    const travados = tipos.filter((t: any) => t.pendencia).map((t: any) => `${t.id} (${t.pendencia})`);
    const base = `${r.itens.length} cliente(s), ${r.resumo.comDebito} com débito; envio pronto: ${prontos.join(", ") || "nenhum"}`;
    if (!prontos.length) return { estado: "falhou", detalhe: `${base} — nenhum tipo pode sair: ${travados.join("; ")}` };
    return travados.length ? `${base}; aguardando: ${travados.join("; ")}` : base;
  });

  await e.passo("Painéis", e.enviar ? "Resumo diário vai para o aprovador" : "Resumo diário (texto montado, não enviado)", async () => {
    const { textoResumo, enviarResumo, pendentes } = await import("./mkt-acoes");
    if (!e.enviar) {
      const p = await pendentes();
      const t = textoResumo(p, { avisos: [`${marca} ensaio geral`] });
      if (!t) return { estado: "pulado", detalhe: "nada pendente para resumir agora" };
      return `${t.length} caracteres montados: “${t.slice(0, 90).replace(/\n/g, " ")}…”`;
    }
    const r: any = await enviarResumo({ avisos: [`${marca} este resumo faz parte do ensaio geral`] });
    return `${(r.enviados || []).length} envio(s), ${r.pendentes} pendente(s) no resumo`;
  });

  // ========================================================================
  // 9. LIMPEZA — nada do ensaio fica no banco
  // ========================================================================
  // ========================================================================
  // 9. FECHAMENTO — modos voltam ao normal; o RASTRO fica
  // ========================================================================
  await e.passo("Fechamento", "Devolver os modos ao que estavam", async () => {
    const mudados: string[] = [];
    for (const k of Object.keys(modosAntes)) {
      const v = modosAntes[k];
      if (v && v !== (await get(k, ""))) { await set(k, v); mudados.push(`${k}=${v}`); }
    }
    return mudados.length ? `devolvidos: ${mudados.join(", ")}` : "nenhum modo precisou voltar";
  });

  await e.passo("Fechamento", limpar ? "Apagar o rastro do ensaio" : "Rastro preservado para o painel", async () => {
    if (!limpar) {
      return `${e.criados.length} registro(s) marcados '${ensaioId}' — vão aparecer no painel de atendimento. `
        + `Para apagar depois: POST /api/mkt/ensaio/limpar?id=${ensaioId}`;
    }
    const n = await limparEnsaio(ensaioId);
    return `${n.removidos} registro(s) removido(s)`;
  });

  const r = e.resumo;
  return {
    geradoEm: new Date().toISOString(),
    modo: e.enviar ? "enviar (disparo real redirecionado aos telefones do ensaio)" : "seco (nada foi enviado)",
    duracaoMs: Date.now() - t0,
    resumo: r,
    veredito: r.falhou === 0 ? "Central inteira respondeu" : `${r.falhou} rotina(s) com defeito`,
    passos: e.passos,
  };
}

/**
 * Apaga o rastro de uma rodada do ensaio. Nao toca em disparo JA ENVIADO: aquilo
 * aconteceu, custou dinheiro, e apagar do banco nao desfaz a mensagem que chegou
 * no aparelho — so faria o painel mentir. Some o que nao saiu e o que foi criado
 * so para o teste.
 */
export async function limparEnsaio(ensaioId: string): Promise<{ removidos: number; detalhe: Record<string, number> }> {
  const det: Record<string, number> = {};
  const conta = async (t: string, texto: any) => {
    try { const r: any = await db.execute(texto); det[t] = (det[t] || 0) + (r.rowCount ?? 0); } catch {}
  };
  const alvo = `%${ensaioId}%`;
  await conta("mkt_fila_toques", sql`DELETE FROM mkt_fila_toques WHERE acao_id IN (SELECT id FROM mkt_acoes WHERE titulo LIKE ${alvo})`);
  await conta("mkt_acoes", sql`DELETE FROM mkt_acoes WHERE titulo LIKE ${alvo} OR comentario LIKE ${alvo}`);
  await conta("chat_messages", sql`DELETE FROM chat_messages WHERE content LIKE ${alvo}`);
  await conta("official_dispatches", sql`DELETE FROM official_dispatches WHERE status::text = 'fila' AND campaign LIKE ${alvo}`);
  const removidos = Object.values(det).reduce((t, n) => t + n, 0);
  console.log(`[MKT-ENSAIO] limpeza de ${ensaioId}: ${removidos} registro(s)`, det);
  return { removidos, detalhe: det };
}

export function registerMktEnsaio(app: Express) {
  // POST /api/mkt/ensaio           → ensaio seco (padrão, não envia nada)
  // POST /api/mkt/ensaio?enviar=1  → dispara de verdade, para os telefones de teste
  app.post("/api/mkt/ensaio", authenticateUser, requireRole(PAPEIS), async (req: Request, res: Response) => {
    try {
      const enviar = String(req.query.enviar || (req.body && (req.body as any).enviar) || "") === "1";
      const limpar = String(req.query.limpar || "") === "1";
      const quem = String((req as any).user?.username || (req as any).user?.id || "admin");
      res.setHeader("Cache-Control", "no-store");
      res.json(await rodarEnsaio({ enviar, quem, limpar }));
    } catch (e: any) {
      console.error("[MKT-ENSAIO]", e?.message || e);
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  });
  // POST /api/mkt/ensaio/limpar?id=ens-...  → apaga o rastro daquela rodada
  app.post("/api/mkt/ensaio/limpar", authenticateUser, requireRole(PAPEIS), async (req: Request, res: Response) => {
    try {
      const id = String(req.query.id || (req.body && (req.body as any).id) || "").trim();
      if (!/^ens-\d{8,}$/.test(id)) return res.status(400).json({ error: "informe o id da rodada (ens-...)" });
      res.json(await limparEnsaio(id));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  console.log("[MKT-ENSAIO] registrado (POST /api/mkt/ensaio)");
}
