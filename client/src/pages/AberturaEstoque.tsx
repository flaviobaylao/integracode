import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { ClipboardCheck, AlertTriangle, CheckCircle2, RefreshCw, Lock, History, ChevronDown, ChevronRight, Loader2, Ban } from "lucide-react";

/**
 * ABERTURA DE ESTOQUE DO DIA (22/out/2026)
 * Contagem física diária do estoque de produto acabado (GYN + SERV) antes do 1º faturamento.
 * Esperado = sistema GYN + sistema SERV + faturado ainda não em rota. Divergência → chamado por produto.
 * Só Flávio, Lanucy, Cinthia e Naiara gravam; todos podem ver. Server: server/abertura-estoque-routes.ts
 */

type Pedido = { id: string; orderNumber: string | null; customerName: string; stage: string; instancia: string | null; quantidade: number };
type Linha = {
  productId: string; productName: string;
  gynEmUso: number; gynBloqueado: number; servEmUso: number; servBloqueado: number;
  faturadoSemRota: number; esperado: number; fisico?: number | null; divergencia?: number | null;
  pedidos: Pedido[]; chamadoIds?: string[];
};
type Hoje = {
  data: string; ativa: boolean; podeAbrir: boolean; aberta: boolean;
  abertura: { id: string; abertoPor: string; em: string; observacao: string | null; totalItens: number; divergencias: number; refeitaEm: string | null; refeitaPor: string | null } | null;
  itens: Linha[]; esperadoAgora: Linha[] | null; instancias: Array<{ id: string; name: string }>; avisos: string[];
  tentativas: Array<{ user_nome: string; user_email: string; rota: string; created_at: string }>;
};

const fmtN = (v: any) => (v === null || v === undefined || v === "" ? "–" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }));
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const fmtData = (iso: string) => iso.split("-").reverse().join("/");
const STAGE_LABEL: Record<string, string> = { faturado: "Faturado", impresso: "Impresso", aguardando_rota: "Aguard. rota", bsb: "BSB", aguardando_rota_bsb: "Aguard. rota BSB", outras_cidades: "Outras cidades" };

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(j?.message || `HTTP ${r.status}`); Object.assign(e, j); throw e; }
  return j;
}

export default function AberturaEstoque() {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery<Hoje>({ queryKey: ["/api/abertura-estoque/hoje"], queryFn: () => api("/api/abertura-estoque/hoje"), refetchInterval: 60_000 });
  const { data: historico = [] } = useQuery<any[]>({ queryKey: ["/api/abertura-estoque/historico"], queryFn: () => api("/api/abertura-estoque/historico?dias=45") });

  const [fisico, setFisico] = useState<Record<string, string>>({});
  const [observacao, setObservacao] = useState("");
  const [refazendo, setRefazendo] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [histSel, setHistSel] = useState<any | null>(null);
  const { data: histItens = [] } = useQuery<Linha[]>({ queryKey: ["/api/abertura-estoque", histSel?.id, "itens"], queryFn: () => api(`/api/abertura-estoque/${histSel.id}/itens`), enabled: !!histSel?.id });

  // Modo edição: dia ainda não aberto, ou "Refazer" acionado.
  const editando = !!data && (!data.aberta || refazendo);
  const linhas: Linha[] = useMemo(() => (editando ? data?.esperadoAgora || [] : data?.itens || []), [data, editando]);

  // Ao entrar em "refazer", pré-carrega as quantidades já informadas hoje.
  useEffect(() => {
    if (refazendo && data?.itens?.length) {
      const m: Record<string, string> = {};
      for (const i of data.itens) if (i.fisico !== null && i.fisico !== undefined) m[i.productId] = String(i.fisico);
      setFisico(m);
    }
  }, [refazendo, data?.itens]);

  const preenchidos = linhas.filter((l) => fisico[l.productId] !== undefined && fisico[l.productId] !== "" && Number.isFinite(Number(fisico[l.productId].replace(",", ".")))).length;
  const faltam = linhas.length - preenchidos;
  const divergentesPrevia = linhas.filter((l) => {
    const v = fisico[l.productId]; if (v === undefined || v === "") return false;
    return Math.abs(Number(v.replace(",", ".")) - l.esperado) > 0.0001;
  });

  const gravar = useMutation({
    mutationFn: () => api("/api/abertura-estoque", { method: "POST", body: JSON.stringify({ refazer: refazendo, observacao, itens: linhas.map((l) => ({ productId: l.productId, fisico: fisico[l.productId] })) }) }),
    onSuccess: (r: any) => {
      setConfirmar(false); setRefazendo(false); setFisico({}); setObservacao("");
      toast({
        title: r.divergencias?.length ? `Abertura registrada com ${r.divergencias.length} divergência(s)` : "Abertura registrada — estoque conferido",
        description: r.divergencias?.length ? `${r.chamadosAbertos} chamado(s) de notificação aberto(s) para Flávio, Lanucy e Naiara. Os faturamentos do dia estão liberados.` : "Os faturamentos do dia estão liberados.",
        duration: 10000,
      });
      qc.invalidateQueries({ queryKey: ["/api/abertura-estoque/hoje"] });
      qc.invalidateQueries({ queryKey: ["/api/abertura-estoque/historico"] });
      qc.invalidateQueries({ queryKey: ["/api/chamados/contadores"] });
    },
    onError: (e: any) => { setConfirmar(false); toast({ title: "Não foi possível registrar a abertura", description: e.message, variant: "destructive" }); },
  });

  const totais = useMemo(() => linhas.reduce((a, l) => ({ gyn: a.gyn + l.gynEmUso + l.gynBloqueado, serv: a.serv + l.servEmUso + l.servBloqueado, fat: a.fat + l.faturadoSemRota, esp: a.esp + l.esperado }), { gyn: 0, serv: 0, fat: 0, esp: 0 }), [linhas]);

  if (isLoading || !data) return <div className="p-6 flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando abertura do dia…</div>;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BackToDashboardButton />
          <div>
            <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2"><ClipboardCheck className="h-6 w-6 text-amber-600" /> Abertura de Estoque do Dia</h1>
            <p className="text-sm text-slate-500">{fmtData(data.data)} · contagem física do produto acabado (GYN + SERV) antes do primeiro faturamento</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.aberta
            ? <Badge className="bg-green-100 text-green-800 border-green-200 text-sm py-1 px-3"><CheckCircle2 className="h-4 w-4 mr-1" /> Dia aberto · faturamentos liberados</Badge>
            : <Badge className="bg-red-100 text-red-800 border-red-200 text-sm py-1 px-3"><Lock className="h-4 w-4 mr-1" /> Dia NÃO aberto · faturamentos bloqueados</Badge>}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Recalcular</Button>
        </div>
      </div>

      {!data.ativa && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">A exigência de abertura está DESLIGADA (system_settings <code>abertura_estoque_ativa=off</code>). Os faturamentos não estão sendo bloqueados.</div>}
      {data.avisos?.map((a, i) => <div key={i} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{a}</div>)}

      {data.aberta && data.abertura && (
        <Card className="border-green-200">
          <CardContent className="pt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="space-y-0.5">
              <div>Abertura registrada por <b>{data.abertura.abertoPor}</b> às {fmtDT(data.abertura.em)}{data.abertura.refeitaEm ? <> · refeita por <b>{data.abertura.refeitaPor}</b> às {fmtDT(data.abertura.refeitaEm)}</> : null}</div>
              <div className="text-slate-600">{data.abertura.totalItens} produto(s) conferido(s) · {data.abertura.divergencias > 0 ? <span className="text-red-700 font-semibold">{data.abertura.divergencias} com divergência (chamados abertos)</span> : <span className="text-green-700 font-semibold">sem divergências</span>}</div>
              {data.abertura.observacao && <div className="text-slate-600">Obs.: {data.abertura.observacao}</div>}
            </div>
            {data.podeAbrir && !refazendo && <Button variant="outline" size="sm" onClick={() => setRefazendo(true)}><RefreshCw className="h-4 w-4 mr-1" /> Refazer abertura</Button>}
            {refazendo && <Button variant="ghost" size="sm" onClick={() => { setRefazendo(false); setFisico({}); }}>Cancelar refazer</Button>}
          </CardContent>
        </Card>
      )}

      {!data.aberta && !data.podeAbrir && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 flex items-start gap-2">
          <Ban className="h-4 w-4 mt-0.5" />
          <div>Você pode consultar, mas só <b>Flávio, Lanucy, Cinthia ou Naiara</b> registram a abertura. Enquanto ela não for feita, nenhum faturamento do pipeline é permitido.</div>
        </div>
      )}

      {data.tentativas?.length > 0 && (
        <Card className="border-red-200">
          <CardHeader className="py-3"><CardTitle className="text-sm text-red-800 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Tentativas de faturamento sem abertura hoje ({data.tentativas.length})</CardTitle></CardHeader>
          <CardContent className="pt-0 text-xs text-slate-700 space-y-0.5">
            {data.tentativas.slice(0, 10).map((t, i) => <div key={i}>{fmtDT(t.created_at)} — <b>{t.user_nome}</b>{t.user_email ? ` (${t.user_email})` : ""} · {t.rota}</div>)}
            {data.tentativas.length > 10 && <div>… e mais {data.tentativas.length - 10}</div>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">{editando ? (refazendo ? "Refazer contagem física" : "Registrar contagem física") : "Contagem registrada"}</CardTitle>
          <CardDescription>
            Esperado = estoque em sistema <b>GYN</b> + <b>SERV</b> (em uso + bloqueado) + itens <b>já faturados e ainda não em rota</b>. Informe o que existe fisicamente no estoque; a diferença é calculada na hora.
            {editando && <> · <b>{preenchidos}/{linhas.length}</b> preenchidos{divergentesPrevia.length ? <span className="text-red-700"> · {divergentesPrevia.length} divergente(s)</span> : null}</>}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr className="text-left text-xs uppercase text-slate-600">
                  <th className="p-2">Produto</th>
                  <th className="p-2 text-right" title="Lotes ativos na instância GYN (em uso + bloqueado)">Sistema GYN</th>
                  <th className="p-2 text-right" title="Lotes ativos na instância SERV (em uso + bloqueado)">Sistema SERV</th>
                  <th className="p-2 text-right" title="Pedidos faturados nas etapas Faturado, Impresso, Aguardando rota, BSB, Aguardando rota BSB e Outras cidades">Faturado s/ rota</th>
                  <th className="p-2 text-right font-bold">Esperado</th>
                  <th className="p-2 text-right font-bold w-36">Físico</th>
                  <th className="p-2 text-right">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => {
                  const v = editando ? fisico[l.productId] : (l.fisico ?? "");
                  const num = v === undefined || v === "" || v === null ? null : Number(String(v).replace(",", "."));
                  const dif = num === null || !Number.isFinite(num) ? null : num - l.esperado;
                  const divergente = dif !== null && Math.abs(dif) > 0.0001;
                  const temPedidos = l.pedidos?.length > 0;
                  const exp = !!aberto[l.productId];
                  return (
                    <FragmentRow key={l.productId}>
                      <tr className={`border-t ${divergente ? "bg-red-50" : dif !== null ? "bg-green-50/40" : ""}`}>
                        <td className="p-2 font-medium">
                          <div className="flex items-center gap-1">
                            {temPedidos ? <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => setAberto((s) => ({ ...s, [l.productId]: !exp }))} title="Ver pedidos faturados ainda não em rota">{exp ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button> : <span className="w-4" />}
                            {l.productName}
                            {!editando && l.chamadoIds && l.chamadoIds.length > 0 && <Link href={`/chamados?id=${l.chamadoIds[0]}`} className="ml-1 text-xs text-blue-700 underline">chamado</Link>}
                          </div>
                        </td>
                        <td className="p-2 text-right tabular-nums" title={`em uso ${fmtN(l.gynEmUso)} · bloqueado ${fmtN(l.gynBloqueado)}`}>{fmtN(l.gynEmUso + l.gynBloqueado)}{l.gynBloqueado > 0 && <span className="text-xs text-slate-500"> ({fmtN(l.gynBloqueado)} bloq.)</span>}</td>
                        <td className="p-2 text-right tabular-nums" title={`em uso ${fmtN(l.servEmUso)} · bloqueado ${fmtN(l.servBloqueado)}`}>{fmtN(l.servEmUso + l.servBloqueado)}{l.servBloqueado > 0 && <span className="text-xs text-slate-500"> ({fmtN(l.servBloqueado)} bloq.)</span>}</td>
                        <td className="p-2 text-right tabular-nums">{fmtN(l.faturadoSemRota)}{temPedidos && <span className="text-xs text-slate-500"> · {l.pedidos.length} ped.</span>}</td>
                        <td className="p-2 text-right tabular-nums font-bold">{fmtN(l.esperado)}</td>
                        <td className="p-2 text-right">
                          {editando
                            ? <Input inputMode="decimal" className={`h-8 text-right tabular-nums ${divergente ? "border-red-400" : ""}`} placeholder="0" value={fisico[l.productId] ?? ""} disabled={!data.podeAbrir}
                                onChange={(e) => setFisico((s) => ({ ...s, [l.productId]: e.target.value.replace(/[^\d.,]/g, "") }))} />
                            : <span className="tabular-nums font-semibold">{fmtN(l.fisico)}</span>}
                        </td>
                        <td className={`p-2 text-right tabular-nums font-semibold ${divergente ? "text-red-700" : dif !== null ? "text-green-700" : "text-slate-400"}`}>{dif === null ? "–" : `${dif > 0 ? "+" : ""}${fmtN(dif)}`}</td>
                      </tr>
                      {exp && temPedidos && (
                        <tr className="bg-slate-50/70 border-t">
                          <td colSpan={7} className="px-3 py-2">
                            <div className="text-xs text-slate-600 mb-1">Faturados e ainda no depósito (estoque já baixado no sistema):</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
                              {l.pedidos.map((p, i) => <div key={i} className="flex justify-between gap-2"><span>{p.orderNumber ? `Pedido ${p.orderNumber} — ` : ""}{p.customerName} <span className="text-slate-500">({STAGE_LABEL[p.stage] || p.stage}{p.instancia ? `, ${p.instancia}` : ""})</span></span><span className="tabular-nums font-medium">{fmtN(p.quantidade)}</span></div>)}
                            </div>
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
                {linhas.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Nenhum produto ativo encontrado.</td></tr>}
              </tbody>
              <tfoot className="bg-slate-50 border-t font-semibold">
                <tr>
                  <td className="p-2">Total ({linhas.length} produtos)</td>
                  <td className="p-2 text-right tabular-nums">{fmtN(totais.gyn)}</td>
                  <td className="p-2 text-right tabular-nums">{fmtN(totais.serv)}</td>
                  <td className="p-2 text-right tabular-nums">{fmtN(totais.fat)}</td>
                  <td className="p-2 text-right tabular-nums">{fmtN(totais.esp)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>

          {editando && data.podeAbrir && (
            <div className="mt-4 flex flex-col md:flex-row gap-3 md:items-end">
              <div className="flex-1">
                <label className="text-xs text-slate-600">Observação (opcional — vai no corpo dos chamados de divergência)</label>
                <Textarea rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Ex.: 3 caixas de Maracujá 350 ml separadas para troca, ainda no depósito" />
              </div>
              <Button size="lg" className="bg-amber-600 hover:bg-amber-700" disabled={faltam > 0 || gravar.isPending} onClick={() => setConfirmar(true)}>
                {gravar.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ClipboardCheck className="h-4 w-4 mr-2" />}
                {refazendo ? "Gravar nova contagem" : "Registrar abertura do dia"}{faltam > 0 ? ` (faltam ${faltam})` : ""}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> Histórico (45 dias)</CardTitle></CardHeader>
        <CardContent className="pt-0">
          {historico.length === 0 ? <div className="text-sm text-slate-500">Nenhuma abertura registrada ainda.</div> : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-slate-50"><tr className="text-left text-xs uppercase text-slate-600"><th className="p-2">Data</th><th className="p-2">Aberto por</th><th className="p-2">Horário</th><th className="p-2 text-right">Produtos</th><th className="p-2 text-right">Divergências</th><th className="p-2">Obs.</th><th className="p-2" /></tr></thead>
                <tbody>
                  {historico.map((h) => (
                    <tr key={h.id} className="border-t">
                      <td className="p-2 font-medium">{fmtData(h.data)}</td>
                      <td className="p-2">{h.abertoPor}{h.refeitaPor ? <span className="text-xs text-slate-500"> · refeita por {h.refeitaPor}</span> : null}</td>
                      <td className="p-2">{fmtDT(h.em)}</td>
                      <td className="p-2 text-right tabular-nums">{h.totalItens}</td>
                      <td className={`p-2 text-right tabular-nums font-semibold ${h.divergencias > 0 ? "text-red-700" : "text-green-700"}`}>{h.divergencias}</td>
                      <td className="p-2 text-xs text-slate-600 max-w-[280px] truncate" title={h.observacao || ""}>{h.observacao || ""}</td>
                      <td className="p-2 text-right"><Button variant="ghost" size="sm" onClick={() => setHistSel(h)}>Ver itens</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmação antes de gravar */}
      <Dialog open={confirmar} onOpenChange={(o) => !o && setConfirmar(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{refazendo ? "Confirmar nova contagem" : "Confirmar abertura do dia"}</DialogTitle>
            <DialogDescription>
              {divergentesPrevia.length === 0
                ? "Todas as quantidades físicas batem com o esperado pelo sistema. Os faturamentos do dia serão liberados."
                : `${divergentesPrevia.length} produto(s) com divergência. Será aberto um chamado por produto para Flávio, Lanucy e Naiara com a divergência encontrada. Os faturamentos do dia serão liberados mesmo assim.`}
            </DialogDescription>
          </DialogHeader>
          {divergentesPrevia.length > 0 && (
            <div className="max-h-60 overflow-auto rounded border text-sm">
              {divergentesPrevia.map((l) => { const f = Number(String(fisico[l.productId]).replace(",", ".")); const d = f - l.esperado; return (
                <div key={l.productId} className="flex justify-between gap-2 px-3 py-1.5 border-b last:border-0">
                  <span className="font-medium">{l.productName}</span>
                  <span className="tabular-nums">esperado {fmtN(l.esperado)} · físico {fmtN(f)} · <b className="text-red-700">{d > 0 ? "+" : ""}{fmtN(d)}</b></span>
                </div>); })}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmar(false)} disabled={gravar.isPending}>Voltar</Button>
            <Button className="bg-amber-600 hover:bg-amber-700" onClick={() => gravar.mutate()} disabled={gravar.isPending}>{gravar.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} Confirmar e registrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Itens de uma abertura do histórico */}
      <Dialog open={!!histSel} onOpenChange={(o) => !o && setHistSel(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Abertura de {histSel ? fmtData(histSel.data) : ""}</DialogTitle>
            <DialogDescription>Registrada por {histSel?.abertoPor} às {fmtDT(histSel?.em)}{histSel?.observacao ? ` · Obs.: ${histSel.observacao}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50"><tr className="text-left text-xs uppercase text-slate-600"><th className="p-2">Produto</th><th className="p-2 text-right">GYN</th><th className="p-2 text-right">SERV</th><th className="p-2 text-right">Fat. s/ rota</th><th className="p-2 text-right">Esperado</th><th className="p-2 text-right">Físico</th><th className="p-2 text-right">Dif.</th></tr></thead>
              <tbody>
                {histItens.map((i) => { const div = i.divergencia ?? 0; const d = Math.abs(div) > 0.0001; return (
                  <tr key={i.productId} className={`border-t ${d ? "bg-red-50" : ""}`}>
                    <td className="p-2">{i.productName}{i.chamadoIds && i.chamadoIds.length > 0 && <Link href={`/chamados?id=${i.chamadoIds[0]}`} className="ml-1 text-xs text-blue-700 underline">chamado</Link>}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(i.gynEmUso + i.gynBloqueado)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(i.servEmUso + i.servBloqueado)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtN(i.faturadoSemRota)}</td>
                    <td className="p-2 text-right tabular-nums font-semibold">{fmtN(i.esperado)}</td>
                    <td className="p-2 text-right tabular-nums font-semibold">{fmtN(i.fisico)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${d ? "text-red-700" : "text-green-700"}`}>{div > 0 ? "+" : ""}{fmtN(div)}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// <tbody> não aceita Fragment com key em alguns linters; wrapper explícito.
function FragmentRow({ children }: { children: ReactNode }) { return <>{children}</>; }
