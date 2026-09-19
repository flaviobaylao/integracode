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
// O QUE NUNCA ACONTECE AQUI: mandar mensagem para cliente real, publicar no
// Instagram, criar anuncio que gaste dinheiro, ou deixar lixo no banco — cada
// passo registra o que criou e a limpeza desfaz no fim, mesmo se algo falhar.
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
export async function rodarEnsaio(opts: { enviar?: boolean; quem?: string } = {}) {
  const e = new Ensaio(!!opts.enviar);
  const quem = opts.quem || "ensaio";
  const t0 = Date.now();

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
      tipo, agente: "mkt_ensaio", titulo: `${MARCA} ${titulo}`,
      justificativa: "Ação criada pelo ensaio geral. Não representa uma decisão de negócio.",
      custoEstimado: 0, receitaEsperada: 0, nivelSugerido: 2, modoTeste: !e.enviar,
      prazoHoras: 1, ...extra,
    });
    e.anotar("mkt_acoes", a.id);
    if (a.status !== "proposta") return { estado: "falhou" as Estado, detalhe: `nasceu como '${a.status}', esperava 'proposta' (N2)` };
    const d = await decidir({ ids: [a.id], decisao: "aprovar", quem, via: "tela", comentario: MARCA });
    const depois: any = await ver(a.id);
    const ex = d.execucoes?.[0] || {};
    if (depois?.status === "erro") return { estado: "falhou" as Estado, detalhe: `executou com erro: ${String(depois?.execucao?.erro || ex.erro || "?").slice(0, 160)}` };
    return { estado: "ok" as Estado, detalhe: `#${a.numero} proposta → aprovada → ${depois?.status}${ex.detalhe ? ` (${JSON.stringify(ex.detalhe).slice(0, 120)})` : ""}` };
  };

  await e.passo("Caixa", "Alerta ao vendedor: propor → aprovar → executar", async () =>
    cicloDaAcao("alerta", "alerta ao vendedor", {
      parametros: { texto: `${MARCA} Teste do ensaio geral da Central. Pode ignorar.`, vendedor_id: null },
    }));

  await e.passo("Caixa", "Visita: propor → aprovar → entra na agenda", async () => {
    const cli = await uma(sql`SELECT id, name FROM customers WHERE COALESCE(phone,'') <> '' AND is_active IS NOT FALSE ORDER BY created_at DESC LIMIT 1`);
    if (!cli) return { estado: "pulado", detalhe: "nenhum cliente com telefone na base" };
    return cicloDaAcao("visita", "visita de ensaio", {
      publico: { clientes: [{ id: String(cli.id), nome: String(cli.name || "") }] },
      parametros: { dias: 1, motivo: `${MARCA} visita de teste` },
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
      tipo: "alerta", agente: "mkt_ensaio", titulo: `${MARCA} proposta para rejeitar`,
      justificativa: "ensaio", parametros: { texto: "x" }, custoEstimado: 0, receitaEsperada: 0,
      nivelSugerido: 2, modoTeste: true, prazoHoras: 1,
    });
    e.anotar("mkt_acoes", a.id);
    const d = await decidir({ ids: [a.id], decisao: "rejeitar", quem, via: "tela", comentario: `${MARCA} rejeitada no ensaio` });
    const depois: any = await ver(a.id);
    if (d.aplicadas !== 1 || depois?.status !== "rejeitada") return { estado: "falhou", detalhe: `status ficou '${depois?.status}'` };
    return "rejeição registrada com motivo";
  });

  await e.passo("Caixa", "Proposta vencida expira sozinha", async () => {
    const a = await criarAcao({
      tipo: "alerta", agente: "mkt_ensaio", titulo: `${MARCA} proposta que vai expirar`,
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

  await e.passo("Painéis", e.enviar ? "Resumo diário vai para o aprovador" : "Resumo diário (texto montado, não enviado)", async () => {
    const { textoResumo, enviarResumo, pendentes } = await import("./mkt-acoes");
    if (!e.enviar) {
      const p = await pendentes();
      const t = textoResumo(p, { avisos: [`${MARCA} ensaio geral`] });
      if (!t) return { estado: "pulado", detalhe: "nada pendente para resumir agora" };
      return `${t.length} caracteres montados: “${t.slice(0, 90).replace(/\n/g, " ")}…”`;
    }
    const r: any = await enviarResumo({ avisos: [`${MARCA} este resumo faz parte do ensaio geral`] });
    return `${(r.enviados || []).length} envio(s), ${r.pendentes} pendente(s) no resumo`;
  });

  // ========================================================================
  // 9. LIMPEZA — nada do ensaio fica no banco
  // ========================================================================
  await e.passo("Limpeza", "Desfazer tudo que o ensaio criou", async () => {
    let n = 0;
    for (const c of e.criados) {
      try { await db.execute(sql.raw(`DELETE FROM ${c.tabela} WHERE id = '${String(c.id).replace(/'/g, "")}'`)); n++; } catch {}
    }
    // Toques e disparos do ensaio que ainda nao sairam: nao podem sobrar na fila.
    try { await db.execute(sql`DELETE FROM mkt_fila_toques WHERE lote_id = ANY(${e.criados.filter(c => c.tabela === "mkt_lotes").map(c => c.id)})`); } catch {}
    try { await db.execute(sql`DELETE FROM official_dispatches WHERE status::text = 'fila' AND campaign LIKE '%ensaio%'`); } catch {}
    for (const [k, v] of Object.entries(modosAntes)) { if (v) await set(k, v); }
    return `${n} registro(s) removido(s); modos devolvidos ao que estavam`;
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

export function registerMktEnsaio(app: Express) {
  // POST /api/mkt/ensaio           → ensaio seco (padrão, não envia nada)
  // POST /api/mkt/ensaio?enviar=1  → dispara de verdade, para os telefones de teste
  app.post("/api/mkt/ensaio", authenticateUser, requireRole(PAPEIS), async (req: Request, res: Response) => {
    try {
      const enviar = String(req.query.enviar || (req.body && (req.body as any).enviar) || "") === "1";
      const quem = String((req as any).user?.username || (req as any).user?.id || "admin");
      res.setHeader("Cache-Control", "no-store");
      res.json(await rodarEnsaio({ enviar, quem }));
    } catch (e: any) {
      console.error("[MKT-ENSAIO]", e?.message || e);
      res.status(500).json({ error: (e && e.message) || String(e) });
    }
  });
  console.log("[MKT-ENSAIO] registrado (POST /api/mkt/ensaio)");
}
