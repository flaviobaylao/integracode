// ============================================================================
// PAINEL DO DIA — /marketing/hoje
// A tela de 5 minutos do gestor: o que os agentes fizeram, o que espera decisão,
// o que está rodando e quanto já rendeu (ao vivo), peças no ar, nota do Auditor.
// Feita para o celular: um fluxo vertical, botões grandes, atualiza a cada 60 s.
// ============================================================================
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { CanalBadge, CanalLegenda } from "@/components/CanalBadge";

async function apiGet(url: string) {
  const r = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error("Erro ao carregar (" + r.status + ")");
  return r.json();
}
async function apiPost(url: string, body: any) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "Erro ao salvar (" + r.status + ")");
  return j;
}
const brl = (v: any) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: any) => Number(v || 0).toLocaleString("pt-BR");
const hora = (v: any) => (v ? new Date(v).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");
const dataHora = (v: any) => (v ? new Date(v).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const ROXO = "#8b5cf6";
const VERDE = "#16a34a";
const VERM = "#dc2626";

export default function MarketingHoje() {
  const { toast } = useToast();
  const q = useQuery<any>({ queryKey: ["/api/mkt/hoje"], queryFn: () => apiGet("/api/mkt/hoje"), refetchInterval: 60_000 });
  const d = q.data || {};
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [aberta, setAberta] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const pendentes: any[] = d.pendentes || [];
  const rodando: any[] = d.rodando || [];
  const agentes: any[] = d.agentes || [];

  async function decidir(ids: string[], decisao: "aprovar" | "rejeitar") {
    if (!ids.length) return;
    let comentario: string | null = null;
    if (decisao === "rejeitar") {
      // O motivo vira aprendizado ("não propor X"); "duplicada" não conta como decisão de mérito.
      const c = window.prompt("Motivo da rejeição (opcional — o Radar aprende com isso; escreva 'duplicada' se for repetição):", "");
      if (c === null) return;
      comentario = c.trim() || null;
    }
    setOcupado(true);
    try {
      const r = await apiPost("/api/mkt/acoes/decidir", { ids, decisao, comentario });
      const falhas = (r.execucoes || []).filter((e: any) => !e.ok);
      toast({ title: (decisao === "aprovar" ? "Aprovadas: " : "Rejeitadas: ") + r.aplicadas, description: falhas.length ? falhas.map((f: any) => f.erro).join(" · ") : "", variant: falhas.length ? "destructive" : undefined });
      setMarcadas(new Set()); q.refetch();
    } catch (e: any) { toast({ title: "Não deu", description: e.message, variant: "destructive" }); }
    setOcupado(false);
  }
  async function decidirPeca(ids: string[], decisao: "aprovar" | "reprovar") {
    setOcupado(true);
    try {
      const comentario = decisao === "reprovar" ? (window.prompt("Motivo (vai para o agente aprender):") || "") : undefined;
      if (decisao === "reprovar" && !comentario) { setOcupado(false); return; }
      const r = await apiPost("/api/mkt/pieces/decisao", { ids, decisao, comentario });
      toast({ title: (decisao === "aprovar" ? "Peça(s) aprovada(s): " : "Reprovada(s): ") + r.aplicados, description: r.erro || "" });
      q.refetch();
    } catch (e: any) { toast({ title: "Não deu", description: e.message, variant: "destructive" }); }
    setOcupado(false);
  }
  function toggle(id: string) { const s = new Set(marcadas); s.has(id) ? s.delete(id) : s.add(id); setMarcadas(s); }

  const modoBadge = (k: string, rotulo: string) => {
    const m = d.modos?.[k] || "off";
    return <Badge key={k} variant="outline" style={{ borderColor: m === "on" ? VERDE : m === "test" ? ROXO : "#9ca3af", color: m === "on" ? VERDE : m === "test" ? ROXO : "#6b7280" }}>{rotulo}: {m === "on" ? "ligado" : m === "test" ? "teste" : "off"}</Badge>;
  };

  return (
    <div className="max-w-3xl mx-auto p-3 sm:p-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-bold leading-tight">Painel do dia</h1>
          <p className="text-xs text-muted-foreground">
            {d.geradoEm ? "Atualizado " + hora(d.geradoEm) + " · atualiza sozinho a cada minuto" : "Carregando…"}
          </p>
        </div>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>Atualizar</Button>
          <Link href="/marketing"><Button size="sm" variant="outline">Central completa</Button></Link>
        </span>
      </div>

      {q.error && <Card><CardContent className="p-4 text-sm text-red-600">Erro: {String((q.error as any)?.message)}</CardContent></Card>}

      {/* Avisos que travam o dia */}
      {d.aprovadores === 0 && (
        <Card style={{ borderColor: VERM }}><CardContent className="p-3 text-sm">
          <b>Nenhum aprovador no WhatsApp.</b> O resumo das 07:30 e as respostas <code>OK 12</code> não funcionam até você gravar <code>telefone_gestor_relatorios</code> (ou <code>POST /api/mkt/aprovadores</code>).
        </CardContent></Card>
      )}
      {d.ig && !d.ig.conectado && (
        <Card style={{ borderColor: VERM }}><CardContent className="p-3 text-sm"><b>Instagram não conectado.</b> Publicador e Insights parados — conecte em Central completa → Agente de conteúdo.</CardContent></Card>
      )}

      {/* Números do dia */}
      <Card>
        <CardContent className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          <Kpi t="Esperando você" v={num(d.resumoPendentes?.n)} sub={porCanal(pendentes) || (brl(d.resumoPendentes?.receita) + " esperados")} destaque />
          <Kpi t="Rodando (14d)" v={num(d.totaisAoVivo?.acoes)} sub={brl(d.totaisAoVivo?.custo) + " gastos"} />
          <Kpi t="Rendeu ao vivo" v={brl(d.totaisAoVivo?.receita)} sub={num(d.totaisAoVivo?.pedidos) + " pedido(s) dos tocados"} />
          <Kpi t="Decisões 7d" v={num(d.decisoes7d?.aprovadas) + " ✓ / " + num(d.decisoes7d?.rejeitadas) + " ✗"} sub="rumo ao N1 (10 com ≥ 90%)" />
          {d.numeros && <>
            <Kpi t="Positivação do mês" v={num(d.numeros.positivados) + " / " + num(d.numeros.ativos)} sub={d.numeros.ativos ? Math.round(100 * d.numeros.positivados / d.numeros.ativos) + "% da base" : ""} />
            <Kpi t="Vendas 7d" v={brl(d.numeros.vendas7d)} sub={d.numeros.vendas7dAnt ? (d.numeros.vendas7d >= d.numeros.vendas7dAnt ? "▲ " : "▼ ") + Math.round(100 * (d.numeros.vendas7d - d.numeros.vendas7dAnt) / d.numeros.vendas7dAnt) + "% vs 7d anteriores" : ""} />
          </>}
        </CardContent>
        <CardContent className="px-3 pb-3 pt-0 flex flex-wrap gap-1">
          {modoBadge("mkt_radar_modo", "Radar")}{modoBadge("mkt_conteudo_modo", "Conteúdo")}{modoBadge("mkt_publicador_modo", "Publicador")}{modoBadge("mkt_insights_modo", "Insights")}{modoBadge("mkt_capi_mode", "CAPI")}{modoBadge("mkt_ads_modo", "Anúncios")}
          {d.ig?.conectado && <Badge variant="outline" style={{ borderColor: VERDE, color: VERDE }}>@{d.ig.username} · {d.ig.diasRestantes}d</Badge>}
        </CardContent>
        <CardContent className="px-3 pb-3 pt-0"><CanalLegenda /></CardContent>
      </Card>

      {/* 1. O que os agentes fizeram */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><i className="fas fa-robot text-muted-foreground" /> O que os agentes fizeram desde ontem</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {d.radar?.leitura && (
            <div className="border rounded p-2" style={{ borderColor: ROXO }}>
              <div className="text-[11px] text-muted-foreground">Radar · leitura do dia · {dataHora(d.radar.em)} · {num(d.radar.criadas)} proposta(s), {num(d.radar.descartadas)} descartada(s)</div>
              <div>{d.radar.leitura}</div>
              {Array.isArray(d.radar.avisos) && d.radar.avisos.length > 0 && <div className="text-xs text-amber-700 mt-1">⚠️ {d.radar.avisos.join(" · ")}</div>}
            </div>
          )}
          {agentes.length === 0 && <div className="text-muted-foreground">Nenhum agente rodou desde ontem.</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {agentes.map((a: any) => (
              <div key={a.agente} className="flex items-center gap-2 border rounded px-2 py-1">
                <span style={{ color: a.ok === a.execucoes ? VERDE : VERM }}>●</span>
                <span className="font-medium">{a.nome}</span>
                <span className="text-xs text-muted-foreground ml-auto text-right">{num(a.execucoes)}× · {brl(a.custo)} · {hora(a.ultimo)}{a.ultimo_erro ? <div className="text-red-600 truncate max-w-[220px]" title={a.ultimo_erro}>{a.ultimo_erro}</div> : null}</span>
              </div>
            ))}
          </div>
          {d.auditor && (
            <div className="border rounded p-2 flex flex-wrap items-center gap-2">
              <span className="font-medium">Auditor</span>
              <Badge variant="outline" style={{ borderColor: d.auditor.nota >= 80 ? VERDE : d.auditor.nota >= 60 ? "#d97706" : VERM }}>nota {d.auditor.nota}/100</Badge>
              <span className="text-xs text-muted-foreground">{d.auditor.alertas.length} alerta(s) · {d.auditor.atencoes} atenção · {d.auditor.autofix} autocorreção(ões) · {d.auditor.melhorias} melhoria(s) propostas</span>
              {d.auditor.alertas.length > 0 && <ul className="w-full text-xs list-disc pl-5">{d.auditor.alertas.map((x: any) => <li key={x.id}><b>{x.titulo}:</b> {x.detalhe}</li>)}</ul>}
            </div>
          )}
          {(d.aprendizados || []).length > 0 && (
            <div className="border rounded p-2">
              <div className="font-medium">Aprendizados novos (7d)</div>
              <ul className="text-xs list-disc pl-5">{d.aprendizados.map((l: any) => <li key={l.id}>[{l.confianca}] {l.enunciado}{l.acao_sugerida ? <span className="text-muted-foreground"> → {l.acao_sugerida}</span> : null}</li>)}</ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. O que espera você */}
      <Card style={{ borderColor: pendentes.length ? ROXO : undefined }}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <i className="fas fa-inbox text-muted-foreground" /> Esperando você
            <Badge style={{ background: ROXO }}>{pendentes.length}</Badge>
            <span className="ml-auto flex gap-1 flex-wrap">
              <Button size="sm" disabled={ocupado || !marcadas.size} onClick={() => decidir(Array.from(marcadas), "aprovar")}>Aprovar {marcadas.size ? "(" + marcadas.size + ")" : ""}</Button>
              <Button size="sm" variant="outline" disabled={ocupado || !pendentes.length} onClick={() => decidir(pendentes.filter(p => !marcadas.has(p.id)).map(p => p.id), "aprovar")}>{marcadas.size ? "Aprovar tudo exceto marcadas" : "Aprovar tudo"}</Button>
              <Button size="sm" variant="destructive" disabled={ocupado || !marcadas.size} onClick={() => decidir(Array.from(marcadas), "rejeitar")}>Rejeitar</Button>
            </span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Marque para agir só nelas. Pelo WhatsApp é igual: <code>OK 12</code>, <code>NAO 12 motivo</code>, <code>OK TUDO</code>.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {pendentes.length === 0 && <div className="text-sm text-muted-foreground">Nada pendente. O Radar roda às 06:30.</div>}
          {pendentes.map((p: any) => (
            <div key={p.id} className="border rounded p-2 text-sm" style={{ borderColor: marcadas.has(p.id) ? ROXO : undefined }}>
              <div className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 h-5 w-5" checked={marcadas.has(p.id)} onChange={() => toggle(p.id)} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1">
                    <b>#{p.numero}</b>
                    <CanalBadge canal={p.canal} via={p.canalVia?.canal} quem={p.canalQuem} grande />
                    <Badge variant="outline">{p.tipoNome}</Badge>
                    {p.categoria && <Badge variant="outline">{p.categoria}</Badge>}
                    {p.modo_teste && <Badge variant="outline" style={{ color: ROXO, borderColor: ROXO }}>teste — só simula</Badge>}
                    <span className="text-[11px] text-muted-foreground">por {p.agente} · {dataHora(p.criado_em)}</span>
                  </div>
                  <div className="font-medium">{p.titulo}</div>
                  <div className="text-xs text-muted-foreground">{num(p.publico_total)} cliente(s) · custo {brl(p.custo)} → esperado <b style={{ color: VERDE }}>{brl(p.receita)}</b></div>
                  {p.canalQuem && <div className="text-[11px] text-muted-foreground">{p.canalQuem}</div>}
                  <button className="text-xs underline" onClick={() => setAberta(aberta === p.id ? null : p.id)}>{aberta === p.id ? "esconder" : "por quê?"}</button>
                  {aberta === p.id && <div className="text-xs mt-1 whitespace-pre-wrap">{p.justificativa}</div>}
                </div>
                <div className="flex flex-col gap-1">
                  <Button size="sm" disabled={ocupado} onClick={() => decidir([p.id], "aprovar")}>OK</Button>
                  <Button size="sm" variant="outline" disabled={ocupado} onClick={() => decidir([p.id], "rejeitar")}>Não</Button>
                </div>
              </div>
            </div>
          ))}
          {d.pecas?.fila > 0 && (
            <div className="border-t pt-2">
              <div className="flex items-center gap-2 text-sm"><b>Peças na fila de aprovação</b><Badge>{d.pecas.fila}</Badge>
                <Button size="sm" className="ml-auto" disabled={ocupado} onClick={() => decidirPeca(d.pecas.filaLista.map((x: any) => x.id), "aprovar")}>Aprovar as {d.pecas.filaLista.length} listadas</Button>
              </div>
              {d.pecas.filaLista.map((x: any) => (
                <div key={x.id} className="border rounded p-2 text-sm mt-1 flex gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">#{x.numero} <CanalBadge canal={x.canalInfo?.canal} /> {x.gancho}{x.rodada > 1 ? " · rodada " + x.rodada : ""}</div>
                    <div>{x.trecho}…</div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button size="sm" disabled={ocupado} onClick={() => decidirPeca([x.id], "aprovar")}>OK</Button>
                    <Button size="sm" variant="outline" disabled={ocupado} onClick={() => decidirPeca([x.id], "reprovar")}>Não</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Rodando e rendendo */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><i className="fas fa-chart-line text-muted-foreground" /> Rodando e rendendo <span className="text-xs font-normal text-muted-foreground">(últimos 14 dias, medido ao vivo nos pedidos)</span></CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {rodando.length === 0 && <div className="text-muted-foreground">Nenhuma ação executada nos últimos 14 dias. O que você aprovar aparece aqui com o resultado subindo a cada pedido.</div>}
          {rodando.map((r: any) => (
            <div key={r.id} className="border rounded p-2">
              <div className="flex flex-wrap items-center gap-1">
                <b>#{r.numero}</b><CanalBadge canal={r.canal} via={r.canalVia?.canal} quem={r.canalQuem} /><Badge variant="outline">{r.tipoNome}</Badge>
                <Badge variant="outline" style={{ color: r.status === "erro" ? VERM : r.status === "executada" ? VERDE : ROXO, borderColor: r.status === "erro" ? VERM : r.status === "executada" ? VERDE : ROXO }}>{r.status}{r.modoTeste ? " (simulada)" : ""}</Badge>
                <span className="text-[11px] text-muted-foreground">{dataHora(r.executadaEm)}{r.decididoVia ? " · via " + r.decididoVia : ""}</span>
              </div>
              <div>{r.titulo}</div>
              {r.erro && <div className="text-xs text-red-600">{r.erro}</div>}
              {r.toques && <div className="text-xs text-muted-foreground">{num(r.toques.enviados)} mensagem(ns) enviada(s) · {num(r.toques.responderam)} responderam{r.toques.bloqueados ? " · " + num(r.toques.bloqueados) + " bloqueada(s)" : ""}</div>}
              {r.anuncio && (
                <div className="text-xs text-muted-foreground">📘 gasto {brl(r.anuncio.gasto)} de {brl(r.anuncio.orcamentoDia * r.anuncio.dias)} · {num(r.anuncio.impressoes)} impressões · {num(r.anuncio.cliques)} cliques · <b>{num(r.anuncio.conversas)} conversa(s) no WhatsApp</b> · {r.anuncio.status}{r.anuncio.link && <> · <a className="underline" href={r.anuncio.link} target="_blank" rel="noreferrer">Gerenciador</a></>}</div>
              )}
              {r.aoVivo && (
                <div className="grid grid-cols-3 gap-1 mt-1 text-xs">
                  <div className="border rounded p-1"><div className="text-muted-foreground">Pedidos</div><b>{num(r.aoVivo.pedidos)}</b> de {num(r.aoVivo.publico)} tocados ({Math.round(r.aoVivo.taxa * 100)}%)</div>
                  <div className="border rounded p-1"><div className="text-muted-foreground">Receita</div><b style={{ color: VERDE }}>{brl(r.aoVivo.receita)}</b> / esp. {brl(r.receitaEsperada)}</div>
                  <div className="border rounded p-1"><div className="text-muted-foreground">Janela</div><b>dia {r.aoVivo.diasCorridos}/14</b>{r.aoVivo.fechado ? " · fechada" : ""} · custo {brl(r.custo)}</div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 4. Peças no ar */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><i className="fab fa-instagram text-muted-foreground" /> No ar <span className="text-xs font-normal text-muted-foreground">(14 dias · {num(d.pecas?.escritasHoje)} peça(s) escritas hoje)</span></CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(d.pecas?.noAr || []).length === 0 && <div className="text-muted-foreground">Nenhuma peça publicada nos últimos 14 dias.</div>}
          {(d.pecas?.noAr || []).map((p: any) => (
            <div key={p.id} className="border rounded p-2 flex flex-wrap items-center gap-2">
              <span><b>#{p.numero}</b> <CanalBadge canal={p.canalInfo?.canal} /> {p.gancho ? <Badge variant="outline">{p.gancho}</Badge> : null} {p.titulo}</span>
              <span className="text-xs text-muted-foreground ml-auto">
                {p.metricas ? "alcance " + num(p.metricas.alcance) + " · curtidas " + num(p.metricas.curtidas) + " · salvos " + num(p.metricas.salvos) : "sem métricas ainda"} · {num(p.cliques)} clique(s)
                {p.permalink && <> · <a className="underline" href={p.permalink} target="_blank" rel="noreferrer">abrir</a></>}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function porCanal(lista: any[]): string {
  const m: Record<string, number> = {};
  for (const p of lista || []) if (p.canal) m[p.canal] = (m[p.canal] || 0) + 1;
  const nomes: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", google: "Google", loja: "Loja", presencial: "Visita", integra: "Integra" };
  return Object.entries(m).map(([c, n]) => n + " " + (nomes[c] || c)).join(" · ");
}

function Kpi({ t, v, sub, destaque }: { t: string; v: string; sub?: string; destaque?: boolean }) {
  return (
    <div className="border rounded p-2" style={{ borderColor: destaque ? ROXO : undefined }}>
      <div className="text-[11px] text-muted-foreground">{t}</div>
      <div className="font-semibold text-base truncate" title={v}>{v}</div>
      {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}
