// ============================================================================
// CENTRAL DE MARKETING — CAIXA DE DECISÕES + RADAR DE VENDAS (tela)
// ----------------------------------------------------------------------------
// O único lugar em que o gestor precisa decidir. Cada cartão é uma ação
// proposta pela IA (ou por alguém) com custo, receita esperada, evidência e a
// lista de clientes. Aprovar em lote, rejeitar com motivo, tirar cliente da
// lista. Mobile-first: aprovar o dia inteiro em 3 minutos no celular.
//
// Abaixo, o Radar: modo off/test/on, rodar agora, última leitura do dia, custo,
// e as políticas de autonomia (N0/N1/N2) por tipo de ação.
// ============================================================================
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const ROXO = "#8b5cf6";

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

const TIPO_LABEL: Record<string, string> = { regua: "Régua WhatsApp", alerta: "Alerta ao vendedor", peca: "Peça de conteúdo", campanha: "Campanha + link", cupom: "Cupom", visita: "Visita", anuncio: "Anúncio" };
const NIVEL: Record<number, { t: string; cor: string }> = {
  0: { t: "N0 · executa e informa", cor: "#16a34a" },
  1: { t: "N1 · executa no teto", cor: "#0891b2" },
  2: { t: "N2 · você decide", cor: "#d97706" },
};
const STATUS: Record<string, { t: string; cor: string }> = {
  proposta: { t: "esperando você", cor: "#d97706" }, aprovada: { t: "aprovada", cor: "#2563eb" }, rejeitada: { t: "rejeitada", cor: "#6b7280" },
  auto: { t: "automática", cor: "#0891b2" }, executando: { t: "executando", cor: "#2563eb" }, executada: { t: "executada", cor: "#16a34a" },
  erro: { t: "erro", cor: "#dc2626" }, expirada: { t: "expirou", cor: "#9ca3af" },
};

export default function CaixaDecisoes() {
  const { toast } = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [comentario, setComentario] = useState("");
  const [agindo, setAgindo] = useState(false);
  const [abertos, setAbertos] = useState<string[]>([]);
  const [excluir, setExcluir] = useState<Record<string, string[]>>({});
  const [verHistorico, setVerHistorico] = useState(false);

  const q = useQuery<any>({ queryKey: ["/api/mkt/acoes"], queryFn: () => apiGet("/api/mkt/acoes"), refetchInterval: 60_000 });
  const d = q.data || {};
  const k = d.kpis || {};
  const pend: any[] = d.pendentes || [];
  const recentes: any[] = (d.recentes || []).filter((a: any) => a.status !== "proposta");

  const recarregar = () => { q.refetch(); setSel([]); setComentario(""); };
  const alternar = (id: string) => setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const abrir = (id: string) => setAbertos(abertos.includes(id) ? abertos.filter(x => x !== id) : [...abertos, id]);
  const alternarCliente = (acaoId: string, clienteId: string) => {
    const atual = excluir[acaoId] || [];
    setExcluir({ ...excluir, [acaoId]: atual.includes(clienteId) ? atual.filter(x => x !== clienteId) : [...atual, clienteId] });
  };

  async function decidir(decisao: "aprovar" | "rejeitar", ids?: string[]) {
    const alvo = ids || sel;
    if (!alvo.length) return;
    if (decisao === "rejeitar" && !comentario.trim()) {
      toast({ title: "Diga o motivo", description: "O motivo vira aprendizado para o Radar não propor de novo.", variant: "destructive" });
      return;
    }
    setAgindo(true);
    try {
      let aplicadas = 0; const falhas: string[] = [];
      // uma chamada por ação quando há exclusão de clientes; senão, lote
      const comExclusao = alvo.filter(id => (excluir[id] || []).length);
      const semExclusao = alvo.filter(id => !(excluir[id] || []).length);
      if (semExclusao.length) { const r = await apiPost("/api/mkt/acoes/decidir", { ids: semExclusao, decisao, comentario: comentario || null }); aplicadas += r.aplicadas; for (const e of r.execucoes || []) if (!e.ok) falhas.push(e.erro); }
      for (const id of comExclusao) { const r = await apiPost("/api/mkt/acoes/decidir", { ids: [id], decisao, comentario: comentario || null, excluirClientes: excluir[id] }); aplicadas += r.aplicadas; for (const e of r.execucoes || []) if (!e.ok) falhas.push(e.erro); }
      toast({ title: aplicadas + " ação(ões) " + (decisao === "aprovar" ? "aprovada(s) e executada(s)" : "rejeitada(s)"), description: falhas.length ? "Falhou: " + falhas[0] : "Tudo certo.", variant: falhas.length ? "destructive" : undefined });
      recarregar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setAgindo(false);
  }

  async function enviarResumo() {
    try { const r = await apiPost("/api/mkt/acoes/resumo/enviar", {}); toast({ title: "Resumo enviado", description: r.enviados.length + " número(s): " + r.enviados.map((e: any) => (e.success ? "ok" : e.error)).join(", ") }); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }

  return (
    <>
      <Card style={{ borderColor: ROXO }}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <i className="fas fa-inbox text-muted-foreground" /> Caixa de Decisões
            {pend.length > 0 && <Badge className="ml-1" style={{ background: ROXO }}>{pend.length}</Badge>}
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={enviarResumo}>Mandar resumo no WhatsApp</Button>
              <Button size="sm" variant="outline" onClick={() => q.refetch()}>Atualizar</Button>
            </span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            A IA propõe; você decide; o sistema executa e mede. Pelo WhatsApp funciona igual: <code>OK 12</code>, <code>NAO 12</code>, <code>OK TUDO</code>.
            {d.aprovadores?.length ? " Aprovadores: " + d.aprovadores.join(", ") : " Nenhum aprovador cadastrado — defina telefone_gestor_relatorios."}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
            <Kpi t="Esperando você" v={num(k.pendentes)} destaque />
            <Kpi t="R$ esperado (pendente)" v={brl(k.esperadopendente ?? k.esperadoPendente)} />
            <Kpi t="Executadas 30d" v={num(k.executadas30)} />
            <Kpi t="Sozinhas (N0/N1) 30d" v={num(k.automaticas30)} />
            <Kpi t="Receita medida 90d" v={brl(k.receita90) + " · custo " + brl(k.custo90)} />
          </div>

          {q.isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!q.isLoading && !pend.length && <p className="text-sm text-muted-foreground">Nada esperando decisão. O Radar roda às 06:30.</p>}

          {pend.length > 0 && (
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur py-2 flex flex-wrap gap-2 items-center border-b">
              <Button className="h-11" disabled={agindo || !sel.length} onClick={() => decidir("aprovar")}>Aprovar {sel.length ? "(" + sel.length + ")" : ""}</Button>
              <Button className="h-11" variant="outline" disabled={agindo} onClick={() => decidir("aprovar", pend.map(a => a.id))}>Aprovar tudo</Button>
              <Button className="h-11" variant="destructive" disabled={agindo || !sel.length} onClick={() => decidir("rejeitar")}>Rejeitar</Button>
              <Input className="h-11 flex-1 min-w-[180px]" placeholder="motivo (obrigatório para rejeitar)" value={comentario} onChange={e => setComentario(e.target.value)} />
            </div>
          )}

          <div className="space-y-3">
            {pend.map((a: any) => {
              const aberto = abertos.includes(a.id);
              const clientes: any[] = a.publico?.clientes || [];
              const exc = excluir[a.id] || [];
              return (
                <div key={a.id} className="border rounded-lg p-3" style={{ borderColor: sel.includes(a.id) ? ROXO : undefined }}>
                  <div className="flex gap-3 items-start">
                    <input type="checkbox" className="mt-1 h-5 w-5" checked={sel.includes(a.id)} onChange={() => alternar(a.id)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap gap-1 items-center text-xs">
                        <span className="font-mono font-semibold">#{a.numero}</span>
                        <Badge variant="outline">{TIPO_LABEL[a.tipo] || a.tipo}</Badge>
                        <Badge variant="outline" style={{ borderColor: NIVEL[a.nivel_efetivo]?.cor, color: NIVEL[a.nivel_efetivo]?.cor }}>{NIVEL[a.nivel_efetivo]?.t}</Badge>
                        {a.modo_teste && <Badge variant="outline">modo teste — não executa</Badge>}
                        {a.categoria && <Badge variant="outline">{a.categoria}</Badge>}
                        <span className="text-muted-foreground">por {a.agente}</span>
                      </div>
                      <div className="font-medium mt-1">{a.titulo}</div>
                      {a.justificativa && <div className="text-sm text-muted-foreground mt-1">{a.justificativa}</div>}
                      <div className="text-sm mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {a.publico_total > 0 && <span><b>{num(a.publico_total - exc.length)}</b> cliente(s){exc.length ? " (" + exc.length + " tirado(s))" : ""}</span>}
                        <span>custo <b>{brl(a.custo_estimado)}</b></span>
                        <span>esperado <b>{brl(a.receita_esperada)}</b></span>
                        {a.motivo_nivel && <span className="text-muted-foreground">{a.motivo_nivel}</span>}
                      </div>
                      <button className="text-xs underline mt-2" onClick={() => abrir(a.id)}>{aberto ? "esconder" : "ver clientes e evidência"}</button>
                      {aberto && (
                        <div className="mt-2 space-y-2">
                          {clientes.length > 0 && (
                            <div className="max-h-64 overflow-auto border rounded">
                              <table className="w-full text-xs">
                                <thead><tr className="bg-muted"><th className="text-left p-1">#</th><th className="text-left p-1">Cliente</th><th className="text-right p-1">Ticket</th><th className="p-1">Manter</th></tr></thead>
                                <tbody>
                                  {clientes.map((c: any, i: number) => (
                                    <tr key={c.id} className={exc.includes(String(i + 1)) ? "opacity-40 line-through" : ""}>
                                      <td className="p-1">{i + 1}</td><td className="p-1">{c.nome}</td><td className="p-1 text-right">{brl(c.ticket)}</td>
                                      <td className="p-1 text-center"><input type="checkbox" checked={!exc.includes(String(i + 1))} onChange={() => alternarCliente(a.id, String(i + 1))} /></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {a.parametros?.texto && <pre className="text-xs whitespace-pre-wrap bg-muted p-2 rounded">{a.parametros.texto}</pre>}
                          <pre className="text-[11px] whitespace-pre-wrap bg-muted p-2 rounded text-muted-foreground">{JSON.stringify(a.evidencia || {}, null, 1)}</pre>
                          <div className="text-xs text-muted-foreground">expira {a.expira_em ? new Date(a.expira_em).toLocaleString("pt-BR") : "—"}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button className="text-xs underline" onClick={() => setVerHistorico(!verHistorico)}>{verHistorico ? "esconder histórico" : "ver histórico (" + recentes.length + ")"}</button>
          {verHistorico && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="bg-muted"><th className="text-left p-1">#</th><th className="text-left p-1">Ação</th><th className="text-left p-1">Status</th><th className="text-right p-1">Custo</th><th className="text-right p-1">Esperado</th><th className="text-right p-1">Medido (14d)</th><th className="text-left p-1">Decidido</th></tr></thead>
                <tbody>
                  {recentes.map((a: any) => (
                    <tr key={a.id} className="border-b">
                      <td className="p-1 font-mono">{a.numero}</td>
                      <td className="p-1">{a.titulo}</td>
                      <td className="p-1"><span style={{ color: STATUS[a.status]?.cor }}>{STATUS[a.status]?.t || a.status}</span>{a.execucao?.erro ? " — " + a.execucao.erro : ""}</td>
                      <td className="p-1 text-right">{brl(a.custo_estimado)}</td>
                      <td className="p-1 text-right">{brl(a.receita_esperada)}</td>
                      <td className="p-1 text-right">{a.resultado?.receita != null ? brl(a.resultado.receita) + " · " + (a.resultado.pedidos || 0) + " ped." : "—"}</td>
                      <td className="p-1 text-muted-foreground">{a.decidido_via ? a.decidido_via + " · " + (a.decidido_por || "") : (a.nivel_efetivo < 2 ? "política" : "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Radar politicas={d.politicas || []} aoMudar={recarregar} />
      <AgentesConteudo />
      <Aprendizados aoMudar={recarregar} />
    </>
  );
}

function Aprendizados({ aoMudar }: { aoMudar: () => void }) {
  const { toast } = useToast();
  const [novo, setNovo] = useState("");
  const [rodando, setRodando] = useState(false);
  const q = useQuery<any>({ queryKey: ["/api/mkt/aprendizados"], queryFn: () => apiGet("/api/mkt/aprendizados") });
  const lista: any[] = q.data?.aprendizados || [];
  async function rodar() {
    setRodando(true);
    try { const r = await apiPost("/api/mkt/otimizador/rodar", {}); toast({ title: r.ok ? (r.gravados?.length || 0) + " aprendizado(s)" : "Não rodou", description: r.ok ? (r.resumo || "") : (r.motivo || ""), variant: r.ok ? undefined : "destructive" }); q.refetch(); aoMudar(); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setRodando(false);
  }
  async function salvar() {
    if (!novo.trim()) return;
    try { await apiPost("/api/mkt/aprendizados", { enunciado: novo }); setNovo(""); q.refetch(); toast({ title: "Aprendizado salvo — entra no prompt do Radar e do conteúdo" }); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  async function apagar(id: string) {
    try { await fetch("/api/mkt/aprendizados/" + id, { method: "DELETE", credentials: "include" }); q.refetch(); } catch {}
  }
  async function semanal() {
    try { const r = await apiPost("/api/mkt/analista/semanal", {}); toast({ title: "Relatório semanal enviado", description: r.enviados.map((e: any) => (e.success ? "ok" : e.error)).join(", ") }); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  const COR: Record<string, string> = { alta: "#16a34a", media: "#d97706", baixa: "#9ca3af" };
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <i className="fas fa-brain text-muted-foreground" /> Aprendizados
          <span className="ml-auto flex gap-1 flex-wrap">
            <Button size="sm" variant="outline" onClick={semanal}>Relatório semanal agora</Button>
            <Button size="sm" disabled={rodando} onClick={rodar}>{rodando ? "Analisando…" : "Rodar otimizador"}</Button>
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">Toda segunda 06:00 o otimizador cruza o que a Central fez com o que rendeu (14 dias) e grava aprendizados com amostra e confiança; eles entram no prompt do Radar e do agente de conteúdo. Às 07:15 de segunda chega o relatório dos 12 números. Você também pode escrever os seus.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex gap-2">
          <Input className="h-10 flex-1" placeholder="ex.: nunca propor promoção para padaria antes das 10h" value={novo} onChange={e => setNovo(e.target.value)} />
          <Button className="h-10" variant="outline" onClick={salvar}>Salvar</Button>
        </div>
        {!lista.length && <p className="text-xs text-muted-foreground">Nenhum aprendizado ainda. O otimizador precisa de ações executadas com resultado medido.</p>}
        <ul className="space-y-2">
          {lista.filter((l: any) => l.ativo).map((l: any) => (
            <li key={l.id} className="border rounded p-2 flex gap-2 items-start">
              <span className="text-[11px] font-mono mt-0.5" style={{ color: COR[l.confianca] || "#9ca3af" }}>{l.confianca}</span>
              <div className="flex-1 min-w-0">
                <div>{l.enunciado}</div>
                {l.acao_sugerida && <div className="text-xs text-muted-foreground">→ {l.acao_sugerida}</div>}
                <div className="text-[11px] text-muted-foreground">{l.origem}{l.amostra ? " · amostra " + l.amostra : ""} · {new Date(l.criado_em).toLocaleDateString("pt-BR")}</div>
              </div>
              <button className="text-xs underline" onClick={() => apagar(l.id)}>desativar</button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AgentesConteudo() {
  const { toast } = useToast();
  const [rodando, setRodando] = useState(false);
  const c = useQuery<any>({ queryKey: ["/api/mkt/conteudo"], queryFn: () => apiGet("/api/mkt/conteudo") });
  const aux = useQuery<any>({ queryKey: ["/api/mkt/agentes-aux"], queryFn: () => apiGet("/api/mkt/agentes-aux") });
  const d = c.data || {};
  const a = aux.data || {};
  async function modo(m: string) {
    try { await apiPost("/api/mkt/conteudo/modo", { modo: m }); toast({ title: "Agente de conteúdo em " + m }); c.refetch(); }
    catch (e: any) { toast({ title: "Não deu", description: e.message, variant: "destructive" }); }
  }
  async function rodar() {
    setRodando(true);
    try {
      const r = await apiPost("/api/mkt/conteudo/rodar", { forcar: true });
      toast({ title: r.ok ? (r.criou ? "Peça criada e enviada ao revisor" : "Rodou em modo teste") : "Não produziu", description: r.ok ? (r.titulo || "") + (r.motivo ? " — " + r.motivo : "") : (r.motivo || ""), variant: r.ok ? undefined : "destructive" });
      c.refetch();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setRodando(false);
  }
  async function auxModo(agente: string, m: string) {
    try { await apiPost("/api/mkt/agentes-aux/modo", { agente, modo: m }); aux.refetch(); } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  async function visaoLote() {
    try { const r = await apiPost("/api/mkt/visao/lote", { limite: 20 }); toast({ title: r.feitos + " criativo(s) classificado(s)", description: r.erros ? r.erros + " erro(s)" : "" }); aux.refetch(); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  async function entregar() {
    try { const r = await apiPost("/api/mkt/entrega/enviar", {}); toast({ title: r.entregues + " peça(s) enviada(s) ao WhatsApp", description: r.semAprovador ? "Nenhum aprovador cadastrado" : (r.falhas ? r.falhas + " falha(s)" : "") }); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  const portoes: any[] = d.portoes || d.prontidao?.portoes || [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <i className="fas fa-pen-nib text-muted-foreground" /> Agente de conteúdo
          <Badge variant="outline">{d.modo || "…"}</Badge>
          {d.temChaveIA === false && <Badge variant="destructive">sem ANTHROPIC_API_KEY</Badge>}
          <span className="ml-auto flex gap-1 flex-wrap">
            <Button size="sm" variant={d.modo === "off" ? "default" : "outline"} onClick={() => modo("off")}>Desligar</Button>
            <Button size="sm" variant={d.modo === "test" ? "default" : "outline"} onClick={() => modo("test")}>Modo teste</Button>
            <Button size="sm" variant={d.modo === "on" ? "default" : "outline"} onClick={() => modo("on")}>Ligar</Button>
            <Button size="sm" disabled={rodando || d.modo === "off"} onClick={rodar}>{rodando ? "Escrevendo…" : "Escrever uma peça agora"}</Button>
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Escreve às 07:10 até a cota da semana ({d.saldo ? d.saldo.feitas + "/" + d.saldo.cota : "…"}), com foto do acervo, campanha do mês e link próprio por peça; preço só via consulta ao cadastro. Cada peça passa pelo revisor (regras + IA) e para na fila de aprovação. Aprovada, chega pronta no seu WhatsApp às 09:05 — responda <code>POSTEI 31 &lt;link&gt;</code>.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {portoes.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {portoes.map((p: any) => (
              <div key={p.id} className="border rounded p-2 text-xs">
                <div className="flex items-center gap-1"><span style={{ color: p.ok ? "#16a34a" : "#dc2626" }}>{p.ok ? "●" : "●"}</span><b>{p.id}</b></div>
                <div className="text-muted-foreground">{p.detalhe}</div>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center border-t pt-3">
          <span className="text-xs text-muted-foreground">Revisor de IA (fato, claim, foto, tom — depois das regras):</span>
          <Button size="sm" variant={a.revisor === "on" ? "default" : "outline"} onClick={() => auxModo("mkt_revisor", "on")}>ligado</Button>
          <Button size="sm" variant={a.revisor === "off" ? "default" : "outline"} onClick={() => auxModo("mkt_revisor", "off")}>desligado</Button>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground">Visão de criativos (tagueia gancho/cenário/público ao subir a foto; {num(a.criativosSemVisao)} ainda sem passar):</span>
          <Button size="sm" variant={a.visao === "on" ? "default" : "outline"} onClick={() => auxModo("mkt_visao", "on")}>ligada</Button>
          <Button size="sm" variant={a.visao === "off" ? "default" : "outline"} onClick={() => auxModo("mkt_visao", "off")}>desligada</Button>
          <Button size="sm" variant="outline" disabled={a.visao !== "on" || !a.criativosSemVisao} onClick={visaoLote}>Classificar 20 agora</Button>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground">Peças aprovadas ainda não postadas:</span>
          <Button size="sm" variant="outline" onClick={entregar}>Mandar prontas no WhatsApp agora</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Kpi({ t, v, destaque }: { t: string; v: string; destaque?: boolean }) {
  return (
    <div className="border rounded p-2" style={{ borderColor: destaque ? ROXO : undefined }}>
      <div className="text-[11px] text-muted-foreground">{t}</div>
      <div className="font-semibold text-sm truncate" title={v}>{v}</div>
    </div>
  );
}

function Radar({ politicas, aoMudar }: { politicas: any[]; aoMudar: () => void }) {
  const { toast } = useToast();
  const [rodando, setRodando] = useState(false);
  const [editando, setEditando] = useState<Record<string, any>>({});
  const q = useQuery<any>({ queryKey: ["/api/mkt/radar"], queryFn: () => apiGet("/api/mkt/radar") });
  const r = q.data || {};
  const u = r.ultima || null;

  async function modo(m: string) {
    try { await apiPost("/api/mkt/radar/modo", { modo: m }); toast({ title: "Radar em " + m }); q.refetch(); }
    catch (e: any) { toast({ title: "Não deu", description: e.message, variant: "destructive" }); }
  }
  async function rodar() {
    setRodando(true);
    try {
      const x = await apiPost("/api/mkt/radar/rodar", { forcar: true });
      toast({ title: x.ok ? x.criadas.length + " ação(ões) proposta(s)" : "Radar não rodou", description: x.ok ? (x.leituraDoDia || "") : (x.motivo || ""), variant: x.ok ? undefined : "destructive" });
      q.refetch(); aoMudar();
    } catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
    setRodando(false);
  }
  async function salvarPolitica(tipo: string) {
    try { await apiPost("/api/mkt/politicas/" + tipo, editando[tipo] || {}); toast({ title: "Política de " + tipo + " salva" }); setEditando({ ...editando, [tipo]: undefined }); aoMudar(); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  }
  const snap = r.snapshot?.valor || null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <i className="fas fa-satellite-dish text-muted-foreground" /> Radar de Vendas
          <Badge variant="outline">{r.modo || "…"}</Badge>
          {!r.temChave && <Badge variant="destructive">sem ANTHROPIC_API_KEY</Badge>}
          <span className="ml-auto flex gap-1 flex-wrap">
            <Button size="sm" variant={r.modo === "off" ? "default" : "outline"} onClick={() => modo("off")}>Desligar</Button>
            <Button size="sm" variant={r.modo === "test" ? "default" : "outline"} onClick={() => modo("test")}>Modo teste</Button>
            <Button size="sm" variant={r.modo === "on" ? "default" : "outline"} onClick={() => modo("on")}>Ligar</Button>
            <Button size="sm" disabled={rodando || r.modo === "off"} onClick={rodar}>{rodando ? "Lendo o ERP…" : "Rodar agora"}</Button>
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Todo dia às 06:30 lê a base (quem parou, ciclo furado, mix, carteiras que caíram, positivação, resultado das réguas) e propõe ações. Em <b>teste</b> só propõe — aprovar simula. Em <b>ligado</b> vale a política abaixo. Prompt e teto do agente <code>mkt_radar</code> em /admin/agentes.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Kpi t="Última rodada" v={u?.em ? new Date(u.em).toLocaleString("pt-BR") : "nunca"} />
          <Kpi t="Propostas / descartadas" v={u ? num(u.criadas?.length) + " / " + num(u.descartadas?.length) : "—"} />
          <Kpi t="Custo 30d" v={r.custo30d ? brl(r.custo30d.custo) + " · " + num(r.custo30d.execucoes) + " exec." : "—"} />
          <Kpi t="Base lida" v={snap ? num(snap.base?.clientes) + " clientes · " + num(snap.positivacao?.pct) + "% positivados" : "—"} />
        </div>
        {u?.leituraDoDia && <div className="border-l-4 pl-3 text-muted-foreground" style={{ borderColor: ROXO }}>{u.leituraDoDia}</div>}
        {u?.descartadas?.length > 0 && (
          <details className="text-xs"><summary className="cursor-pointer">Propostas descartadas pela validação ({u.descartadas.length})</summary>
            <ul className="list-disc pl-5 mt-1">{u.descartadas.map((x: any, i: number) => <li key={i}>{x.prop?.titulo || x.prop?.segmento}: {x.motivo}</li>)}</ul>
          </details>
        )}
        {snap?.avisos?.length > 0 && <div className="text-xs text-amber-700">{snap.avisos.map((a: string, i: number) => <div key={i}>⚠️ {a}</div>)}</div>}

        <div>
          <div className="font-medium mb-1">Políticas de autonomia</div>
          <div className="text-xs text-muted-foreground mb-2">N0 executa e informa · N1 executa sozinho dentro do teto (só depois de {"≥"} amostra mínima de decisões suas com taxa de aprovação {"≥"} mínima) · N2 sempre espera você. Tudo que fala com cliente nasce em N2.</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-muted"><th className="text-left p-1">Tipo</th><th className="p-1">Nível</th><th className="p-1">Teto R$/dia</th><th className="p-1">Máx clientes/dia</th><th className="p-1">Aprovação mín.</th><th className="p-1">Amostra mín.</th><th className="p-1"></th></tr></thead>
              <tbody>
                {politicas.map((p: any) => {
                  const e = editando[p.tipo] || {};
                  const v = (k: string) => (e[k] ?? p[k]) ?? "";
                  const set = (k: string, val: any) => setEditando({ ...editando, [p.tipo]: { ...e, [k]: val } });
                  return (
                    <tr key={p.tipo} className="border-b">
                      <td className="p-1 font-medium">{TIPO_LABEL[p.tipo] || p.tipo}</td>
                      <td className="p-1 text-center">
                        <select className="border rounded p-1 bg-background" value={v("nivel_padrao")} onChange={ev => set("nivel_padrao", Number(ev.target.value))}>
                          <option value={0}>N0</option><option value={1}>N1</option><option value={2}>N2</option>
                        </select>
                      </td>
                      <td className="p-1"><Input className="h-8 w-20 mx-auto" value={v("teto_custo_dia")} onChange={ev => set("teto_custo_dia", ev.target.value)} /></td>
                      <td className="p-1"><Input className="h-8 w-20 mx-auto" value={v("max_clientes_dia")} onChange={ev => set("max_clientes_dia", ev.target.value)} /></td>
                      <td className="p-1"><Input className="h-8 w-20 mx-auto" value={v("taxa_aprovacao_minima")} onChange={ev => set("taxa_aprovacao_minima", ev.target.value)} /></td>
                      <td className="p-1"><Input className="h-8 w-16 mx-auto" value={v("amostra_minima")} onChange={ev => set("amostra_minima", ev.target.value)} /></td>
                      <td className="p-1"><Button size="sm" variant="outline" disabled={!editando[p.tipo]} onClick={() => salvarPolitica(p.tipo)}>Salvar</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
