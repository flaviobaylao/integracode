// ============================================================================
// INTEGRA 2.0 — PAINEL MENSAL DO FECHAMENTO DE ROTA (Ago/2026) — Fase 5
// Acompanhamento mensal (admin/gestao): total de nao-visitas, motivos,
// relacao de clientes nao visitados no mes e desempenho por vendedor.
// Fonte: /api/admin/fechamento/mensal (visit_justifications + route_closures).
// Renova por mes (seletor); meses anteriores ficam no historico.
// Filtro por vendedor (global) + exportacao em PDF para envio ao vendedor.
// ============================================================================
import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { apiRequest, queryClient } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Ban, CheckCircle2, ClipboardList, FileDown, Copy, Check, Info } from "lucide-react";

const MOTIVO_LABEL: Record<string, string> = {
  sem_tempo: "Não deu tempo / rota grande",
  remarcou: "Cliente avisou / remarcou",
  fechado: "Cliente fechado temporariamente",
  rota_inviavel: "Rota/distância inviável",
  imprevisto: "Imprevisto (veículo/pessoal)",
  cancelou: "Cliente cancelou fornecimento",
  ausente: "Responsável ausente",
  ja_comprou: "Já comprou / não precisa",
  endereco: "Endereço errado",
  sem_interesse: "Sem interesse",
  outro: "Outro",
};

function nowMonthISO(): string {
  const d = new Date().toLocaleString("en-CA", { timeZone: "America/Sao_Paulo" });
  return d.slice(0, 7);
}
function monthOptions(): string[] {
  const out: string[] = [];
  const base = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function mesLabel(m: string): string {
  const [y, mm] = m.split("-");
  const nomes = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${nomes[Number(mm) - 1]}/${y}`;
}

export default function FechamentoPainel({ embedded = false }: { embedded?: boolean }) {
  const [mes, setMes] = useState<string>(nowMonthISO());
  const [sellerId, setSellerId] = useState<string>("__all__");
  const [gerandoPdf, setGerandoPdf] = useState<boolean>(false);
  const { data } = useQuery<any>({
    queryKey: ["/api/admin/fechamento/mensal", mes, sellerId],
    queryFn: () => apiRequest("GET", `/api/admin/fechamento/mensal?mes=${mes}${sellerId !== "__all__" ? `&sellerId=${encodeURIComponent(sellerId)}` : ""}`),
    // Sempre buscar do banco ao (re)montar o painel — evita que suspensões de
    // justificativa (Visita/Débito) reapareçam marcadas ao trocar de aba e voltar
    // por causa de cache antigo do React Query (staleTime padrão de 5 min).
    staleTime: 0,
    refetchOnMount: "always",
  });

  const porMotivo = (data?.porMotivo || []) as any[];
  const clientesAll = (data?.clientes || []) as any[];
  const [buscaCliente, setBuscaCliente] = useState<string>("");
  const [filtroMotivo, setFiltroMotivo] = useState<string>("");
  const perLabel = (p: string) => (p === "semanal" ? "Semanal" : p === "quinzenal" ? "Quinzenal" : p === "mensal" ? "Mensal" : "");
  const clientes = clientesAll.filter((c) => {
    const okBusca = !buscaCliente.trim() || `${c.nome} ${c.cidade || ""} ${c.vendedor || ""}`.toLowerCase().includes(buscaCliente.trim().toLowerCase());
    const okMotivo = !filtroMotivo || (c.motivo || "") === filtroMotivo;
    return okBusca && okMotivo;
  });
  const motivosPresentes = Array.from(new Set(clientesAll.map((c) => c.motivo || ""))).filter(Boolean);
  const porVendedor = (data?.porVendedor || []) as any[];
  const vendedores = (data?.vendedores || []) as any[];
  const totalNV = data?.totalNaoVisitados || 0;
  const totalJust = porVendedor.reduce((s, v) => s + (v.justificados || 0), 0);
  const totalPend = porVendedor.reduce((s, v) => s + (v.pendentes || 0), 0);
  const maxMotivo = Math.max(1, ...porMotivo.map((m) => m.n));
  const vendedorLabel = sellerId === "__all__" ? "Todos os vendedores" : (vendedores.find((v) => v.sellerId === sellerId)?.vendedor || sellerId);

  const streakCls = (n: number) => (n >= 3 ? "bg-red-50 text-red-600" : n === 2 ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500");

  // Suspensão de justificativa (gestão admin): override local p/ resposta imediata do checkbox.
  const [susp, setSusp] = useState<Record<string, boolean>>({});
  const [salvando, setSalvando] = useState<boolean>(false);
  const sKey = (cid: string, tipo: "visita" | "debito") => `${cid}:${tipo}`;
  const isSusp = (c: any, tipo: "visita" | "debito") => {
    const k = sKey(c.customerId, tipo);
    if (k in susp) return susp[k];
    return tipo === "debito" ? !!c.flagDebito : !!c.flagVisita;
  };
  async function toggleSusp(c: any, tipo: "visita" | "debito", value: boolean) {
    setSusp((s) => ({ ...s, [sKey(c.customerId, tipo)]: value }));
    try {
      await apiRequest("POST", "/api/admin/fechamento/suspensao", { mes, customerId: c.customerId, tipo, value });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fechamento/mensal"] });
    } catch {
      setSusp((s) => ({ ...s, [sKey(c.customerId, tipo)]: !value }));
      alert("Não foi possível salvar a suspensão. Tente novamente.");
    }
  }
  async function bulkSusp(tipo: "visita" | "debito", value: boolean) {
    const ids = clientes.map((c) => c.customerId);
    if (ids.length === 0) return;
    setSusp((s) => { const n = { ...s }; ids.forEach((id) => { n[sKey(id, tipo)] = value; }); return n; });
    try {
      setSalvando(true);
      await apiRequest("POST", "/api/admin/fechamento/suspensao/bulk", { mes, tipo, value, customerIds: ids });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fechamento/mensal"] });
    } catch {
      alert("Não foi possível atualizar em massa. Tente novamente.");
    } finally { setSalvando(false); }
  }

  const [copiado, setCopiado] = useState<string>("");
  async function copiarNome(nome: string) {
    try { await navigator.clipboard.writeText(nome); setCopiado(nome); setTimeout(() => setCopiado(""), 1500); }
    catch { /* clipboard indisponível */ }
  }

  async function exportarPDF() {
    try {
      setGerandoPdf(true);
      const { jsPDF } = await import("jspdf");
      const autoTable = (await import("jspdf-autotable")).default as any;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const W = doc.internal.pageSize.getWidth();

      doc.setFontSize(16); doc.setTextColor(30, 64, 175);
      doc.text("Fechamento de Rotas — mensal", 14, 18);
      doc.setFontSize(11); doc.setTextColor(0, 0, 0);
      doc.text(`Período: ${mesLabel(mes)}`, 14, 26);
      doc.text(`Vendedor: ${vendedorLabel}`, 14, 32);
      doc.setFontSize(9); doc.setTextColor(120, 120, 120);
      doc.text(`Gerado em: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, 14, 38);

      // Indicadores
      doc.setTextColor(0, 0, 0);
      autoTable(doc, {
        startY: 44,
        head: [["Não visitados (mês)", "Justificados (fechos)", "Sem justificativa"]],
        body: [[String(totalNV), String(totalJust), String(totalPend)]],
        theme: "grid",
        headStyles: { fillColor: [30, 64, 175], halign: "center" },
        bodyStyles: { halign: "center", fontStyle: "bold", fontSize: 14 },
        margin: { left: 14, right: 14 },
      });

      // Motivos
      let y = (doc as any).lastAutoTable.finalY + 6;
      doc.setFontSize(12); doc.setTextColor(30, 64, 175); doc.text("Por que não foram visitados", 14, y);
      autoTable(doc, {
        startY: y + 3,
        head: [["Motivo", "Qtd"]],
        body: (porMotivo.length ? porMotivo : [{ motivo: "", n: 0 }]).map((m) => [MOTIVO_LABEL[m.motivo] || m.motivo, String(m.n)]),
        theme: "striped",
        headStyles: { fillColor: [30, 64, 175] },
        columnStyles: { 1: { halign: "right", cellWidth: 24 } },
        margin: { left: 14, right: 14 },
      });

      // Clientes
      y = (doc as any).lastAutoTable.finalY + 6;
      doc.setFontSize(12); doc.setTextColor(30, 64, 175); doc.text("Clientes não visitados no mês", 14, y);
      autoTable(doc, {
        startY: y + 3,
        head: [["Cliente", "Cidade", "Último motivo", "Observação", "Recorr."]],
        body: (clientes.length ? clientes : []).map((c) => [
          c.nome, c.cidade || "", MOTIVO_LABEL[c.motivo] || c.motivo || "", (c.motivo === "outro" ? (c.obs || "") : ""), `${c.n}x`,
        ]),
        theme: "striped",
        headStyles: { fillColor: [30, 64, 175] },
        styles: { fontSize: 8, cellPadding: 1.5, overflow: "linebreak" },
        columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: 24 }, 2: { cellWidth: 40 }, 3: { cellWidth: 45 }, 4: { halign: "right", cellWidth: 14 } },
        margin: { left: 14, right: 14 },
      });

      // Rodapé
      const totalPages = doc.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8); doc.setTextColor(150, 150, 150);
        doc.text(`INTEGRA 2.0 · Fechamento de Rotas · Página ${i}/${totalPages}`, W / 2, doc.internal.pageSize.getHeight() - 8, { align: "center" });
      }

      const nomeArq = `Fechamento_${vendedorLabel.replace(/[^a-zA-Z0-9]+/g, "-")}_${mes}.pdf`;
      doc.save(nomeArq);
    } catch (e) {
      alert("Não foi possível gerar o PDF. Tente novamente.");
    } finally {
      setGerandoPdf(false);
    }
  }

  return (
    <div className={embedded ? "" : "p-4 md:p-6 max-w-6xl mx-auto"}>
      {!embedded && <BackToDashboardButton />}
      <div className="flex items-center justify-between gap-3 mt-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><BarChart3 className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold">Painel do Fechamento — mensal</h1>
            <div className="text-xs text-muted-foreground">Renova por mês · meses anteriores ficam no histórico</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="border rounded-lg px-3 py-2 text-sm font-semibold max-w-[220px]" value={sellerId} onChange={(e) => setSellerId(e.target.value)} title="Filtrar por vendedor">
            <option value="__all__">Todos os vendedores</option>
            {vendedores.map((v) => (<option key={v.sellerId} value={v.sellerId}>{v.vendedor}</option>))}
          </select>
          <select className="border rounded-lg px-3 py-2 text-sm font-semibold" value={mes} onChange={(e) => setMes(e.target.value)}>
            {monthOptions().map((m) => (<option key={m} value={m}>{mesLabel(m)}</option>))}
          </select>
          <button onClick={exportarPDF} disabled={gerandoPdf} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold px-3 py-2 hover:bg-blue-700 disabled:opacity-60" title="Exportar PDF para enviar ao vendedor">
            <FileDown className="w-4 h-4" /> {gerandoPdf ? "Gerando…" : "Exportar PDF"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><Ban className="w-4 h-4 text-red-500" /> Não visitados (mês)</div><div className="text-3xl font-extrabold text-red-600 mt-1">{totalNV}</div><div className="text-[11px] text-muted-foreground mt-1">clientes justificados no mês</div></div>
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-600" /> Justificados (fechos)</div><div className="text-3xl font-extrabold text-green-700 mt-1">{totalJust}</div><div className="text-[11px] text-muted-foreground mt-1">somados nos dias fechados</div></div>
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><ClipboardList className="w-4 h-4 text-amber-600" /> Sem justificativa</div><div className="text-3xl font-extrabold text-amber-600 mt-1">{totalPend}</div><div className="text-[11px] text-muted-foreground mt-1">pendências nos fechos</div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Por que não foram visitados</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-3">Motivos informados pelos vendedores em {mesLabel(mes)}.</div>
            {porMotivo.length === 0 ? <div className="text-sm text-muted-foreground">Sem justificativas neste mês.</div> : (
              <div className="flex flex-col gap-3">
                {porMotivo.map((m) => {
                  const listaMot = clientesAll.filter((c) => (c.motivo || "") === m.motivo);
                  return (
                  <div key={m.motivo} className="group relative grid grid-cols-[150px_1fr_36px] items-center gap-3 cursor-help">
                    <div className="text-xs text-gray-600 font-semibold text-right truncate" title={MOTIVO_LABEL[m.motivo] || m.motivo}>{MOTIVO_LABEL[m.motivo] || m.motivo}</div>
                    <div className="bg-gray-100 rounded h-4 overflow-hidden"><div className="h-full bg-blue-600 rounded" style={{ width: `${Math.round((m.n / maxMotivo) * 100)}%` }} /></div>
                    <div className="text-xs font-bold text-gray-800 tabular-nums">{m.n}</div>
                    {/* Tooltip: lista de clientes desse motivo (hover) */}
                    <div className="hidden group-hover:block absolute z-30 left-[150px] top-full mt-1 w-72 max-h-64 overflow-auto bg-white border border-gray-200 rounded-lg shadow-xl p-2 text-left">
                      <div className="text-[11px] font-bold text-gray-700 mb-1">{MOTIVO_LABEL[m.motivo] || m.motivo} · {listaMot.length} cliente(s)</div>
                      {listaMot.length === 0 ? <div className="text-[11px] text-muted-foreground">Sem clientes.</div> : (
                        <ul className="space-y-0.5">
                          {listaMot.slice(0, 40).map((c, i) => (
                            <li key={i} className="text-[11px] text-gray-700 truncate">
                              <span className="font-semibold">{c.nome}</span>
                              {c.cidade ? <span className="text-gray-400"> · {c.cidade}</span> : null}
                              {c.vendedor ? <span className="text-gray-400"> · {c.vendedor}</span> : null}
                            </li>
                          ))}
                          {listaMot.length > 40 ? <li className="text-[11px] text-muted-foreground">+{listaMot.length - 40} mais…</li> : null}
                        </ul>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Clientes não visitados no mês</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-2">Ordenado por recorrência · 🔴 3+ rever periodicidade · 🟡 2 atenção · ⚪ 1 ocasional.</div>
            <div className="text-[11px] text-muted-foreground mb-2">
              <span className="font-semibold">Suspender justificativa</span> (mês vigente): marcada uma das caixas, o vendedor não precisa justificar aquele motivo no Fechar Rota.
            </div>
            {/* Busca por cliente */}
            <div className="relative mb-2">
              <input value={buscaCliente} onChange={(e) => setBuscaCliente(e.target.value)} placeholder="Buscar cliente…" className="w-full border rounded-lg pl-3 pr-8 py-2 text-sm" />
              {buscaCliente ? <button onClick={() => setBuscaCliente("")} title="Limpar" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button> : null}
            </div>
            {/* Filtro por motivo */}
            <div className="mb-2">
              <select value={filtroMotivo} onChange={(e) => setFiltroMotivo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Todos os motivos</option>
                {motivosPresentes.map((mot) => {
                  const nMot = clientesAll.filter((c) => (c.motivo || "") === mot).length;
                  return <option key={mot} value={mot}>{(MOTIVO_LABEL[mot] || mot)} ({nMot})</option>;
                })}
              </select>
            </div>
            {/* Cabeçalho das colunas de suspensão + marcar/limpar tudo */}
            <div className="flex items-center justify-end gap-2 mb-2 text-[10px]">
              <div className="flex flex-col items-center gap-0.5">
                <span className="font-bold text-emerald-700 uppercase tracking-wide inline-flex items-center gap-0.5">Visita<Info className="w-3 h-3 text-emerald-600 cursor-help" title="Suspende a justificativa de VISITA no mês vigente: o cliente não visitado deixa de aparecer para o vendedor justificar no Fechar Rota (não afeta o débito)." /></span>
                <div className="flex gap-1">
                  <button disabled={salvando || clientes.length === 0} onClick={() => bulkSusp("visita", true)} className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50">marcar tudo</button>
                  <button disabled={salvando || clientes.length === 0} onClick={() => bulkSusp("visita", false)} className="px-1.5 py-0.5 rounded bg-gray-50 text-gray-600 border hover:bg-gray-100 disabled:opacity-50">limpar</button>
                </div>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <span className="font-bold text-red-700 uppercase tracking-wide inline-flex items-center gap-0.5">Débito<Info className="w-3 h-3 text-red-600 cursor-help" title="Suspende a justificativa de DÉBITO no mês vigente: o cliente com débito deixa de precisar justificar o débito no Fechar Rota (não afeta a visita)." /></span>
                <div className="flex gap-1">
                  <button disabled={salvando || clientes.length === 0} onClick={() => bulkSusp("debito", true)} className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50">marcar tudo</button>
                  <button disabled={salvando || clientes.length === 0} onClick={() => bulkSusp("debito", false)} className="px-1.5 py-0.5 rounded bg-gray-50 text-gray-600 border hover:bg-gray-100 disabled:opacity-50">limpar</button>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto pr-1">
              {clientes.length === 0 ? <div className="text-sm text-muted-foreground">Sem registros neste mês.</div> : clientes.map((c, i) => (
                <div key={c.customerId + i} className="flex items-center justify-between gap-2 border rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm flex items-center gap-1 flex-wrap">
                      <span className="break-words">{c.nome}</span>
                      <button onClick={() => copiarNome(c.nome)} title="Copiar nome do cliente" className="inline-flex items-center text-gray-400 hover:text-blue-600 flex-shrink-0">
                        {copiado === c.nome ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      {perLabel(c.periodicidade) ? <span className="text-[10px] font-semibold bg-blue-50 text-blue-700 rounded-full px-2 py-0.5">{perLabel(c.periodicidade)}</span> : null}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${streakCls(c.n)}`}>{c.n}x</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{c.vendedor || "—"} · último motivo: "{MOTIVO_LABEL[c.motivo] || c.motivo}"</div>
                    {c.motivo === "outro" && c.obs ? <div className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-2 py-1 mt-1 break-words">✍️ {c.obs}</div> : null}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <label className="flex flex-col items-center gap-0.5 cursor-pointer" title="Suspender justificativa de VISITA neste mês">
                      <input type="checkbox" checked={isSusp(c, "visita")} onChange={(e) => toggleSusp(c, "visita", e.target.checked)} className="w-4 h-4 accent-emerald-600" />
                      <span className="text-[9px] text-emerald-700 font-semibold">Visita</span>
                    </label>
                    <label className="flex flex-col items-center gap-0.5 cursor-pointer" title="Suspender justificativa de DÉBITO neste mês">
                      <input type="checkbox" checked={isSusp(c, "debito")} onChange={(e) => toggleSusp(c, "debito", e.target.checked)} className="w-4 h-4 accent-red-600" />
                      <span className="text-[9px] text-red-700 font-semibold">Débito</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Desempenho por vendedor — {mesLabel(mes)}</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-3">Dias fechados, não visitados, justificados e pendências acumuladas no mês.</div>
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-bold pb-2 px-2">Vendedor</th>
              <th className="text-right font-bold pb-2 px-2">Dias fechados</th>
              <th className="text-right font-bold pb-2 px-2">Não visitados</th>
              <th className="text-right font-bold pb-2 px-2">Justificados</th>
              <th className="text-right font-bold pb-2 px-2">Sem justif.</th>
            </tr></thead>
            <tbody>
              {porVendedor.length === 0 ? (<tr><td colSpan={5} className="text-sm text-muted-foreground py-4 px-2">Nenhum fechamento registrado neste mês.</td></tr>) : porVendedor.map((v) => (
                <tr key={v.sellerId} className="border-t">
                  <td className="py-2 px-2 font-semibold">{v.vendedor}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.dias}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.naoVisitados}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.justificados}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.pendentes > 0 ? <span className="text-amber-600 font-bold">{v.pendentes}</span> : v.pendentes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-muted-foreground mt-3">Motivo estruturado é o que permite somar e comparar — texto livre não escala.</div>
        </CardContent>
      </Card>
    </div>
  );
}
