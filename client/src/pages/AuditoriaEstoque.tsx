import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { exportToExcel } from "@/lib/tableTools";
import { ShieldAlert, AlertTriangle, Info, CheckCircle2, RefreshCw, Play, Download, Search, History, BellRing, ListChecks } from "lucide-react";

/**
 * AUDITORIA DE ESTOQUE (20/out/2026)
 * Achados da auditoria contínua de movimentações (server/auditoria-estoque.ts): trilha × saldo,
 * NF × baixa, baixa sem NF, duplicidade, espelho de transferência, lotes duplicados, CMV, ajustes.
 * Roda a cada hora; aqui dá para executar agora, reconhecer achados com motivo, abrir o extrato
 * do lote (trilha com saldo corrente e quebras) e exportar.
 */

type Achado = {
  id: string; fingerprint: string; check_code: string; severity: "critica" | "alta" | "media" | "info"; status: "open" | "ack" | "resolved";
  instance_id: string | null; instance_name: string | null; product_id: string | null; product_name: string | null;
  lot_id: string | null; lot_number: string | null; ref: string | null; expected: string | null; actual: string | null;
  details: Record<string, any> | null; first_seen_at: string; last_seen_at: string; resolved_at: string | null; ack_at: string | null; ack_by: string | null; ack_note: string | null;
};
type Checagem = { label: string; severidade: string; descricao: string };

const SEV: Record<string, { label: string; badge: string; icon: any }> = {
  critica: { label: "Crítica", badge: "bg-red-100 text-red-800 border-red-200", icon: ShieldAlert },
  alta: { label: "Alta", badge: "bg-orange-100 text-orange-800 border-orange-200", icon: AlertTriangle },
  media: { label: "Média", badge: "bg-amber-100 text-amber-800 border-amber-200", icon: AlertTriangle },
  info: { label: "Info", badge: "bg-sky-100 text-sky-800 border-sky-200", icon: Info },
};
const fmtN = (v: any) => (v === null || v === undefined || v === "" ? "–" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }));
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const fmtD = (s?: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "–");

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `HTTP ${r.status}`);
  return r.json();
}

export default function AuditoriaEstoque() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const [sev, setSev] = useState("");
  const [check, setCheck] = useState("");
  const [inst, setInst] = useState("");
  const [busca, setBusca] = useState("");
  const [ack, setAck] = useState<Achado | null>(null);
  const [ackNota, setAckNota] = useState("");
  const [extratoLot, setExtratoLot] = useState<string | null>(null);
  const [buscaLote, setBuscaLote] = useState("");

  const { data: checagens = {} } = useQuery<Record<string, Checagem>>({ queryKey: ["/api/auditoria-estoque/checagens"], queryFn: () => api("/api/auditoria-estoque/checagens"), staleTime: Infinity });
  const { data: resumo, refetch: refetchResumo } = useQuery<any>({ queryKey: ["/api/auditoria-estoque/resumo"], queryFn: () => api("/api/auditoria-estoque/resumo"), refetchInterval: 60_000 });
  const params = new URLSearchParams({ status, severidade: sev, check, instancia: inst, q: busca });
  const { data: achados = [], isLoading, isFetching, refetch } = useQuery<Achado[]>({
    queryKey: ["/api/auditoria-estoque/achados", status, sev, check, inst, busca],
    queryFn: () => api(`/api/auditoria-estoque/achados?${params.toString()}`), refetchInterval: 120_000,
  });
  const { data: lotesBusca = [] } = useQuery<any[]>({
    queryKey: ["/api/auditoria-estoque/lotes", buscaLote], queryFn: () => api(`/api/auditoria-estoque/lotes?q=${encodeURIComponent(buscaLote)}`), enabled: buscaLote.trim().length >= 2,
  });

  const executar = useMutation({
    mutationFn: () => api("/api/auditoria-estoque/executar", { method: "POST", body: "{}" }),
    onSuccess: (r: any) => { toast({ title: "Auditoria executada", description: `${r.total} achado(s) · ${r.novos} novo(s) · ${r.resolvidos} resolvido(s)` }); qc.invalidateQueries({ queryKey: ["/api/auditoria-estoque/achados"] }); refetchResumo(); },
    onError: (e: any) => toast({ title: "Falha ao executar", description: e.message, variant: "destructive" }),
  });
  const reconhecer = useMutation({
    mutationFn: ({ id, nota }: { id: string; nota: string }) => api(`/api/auditoria-estoque/achados/${id}/reconhecer`, { method: "POST", body: JSON.stringify({ nota }) }),
    onSuccess: () => { toast({ title: "Achado reconhecido" }); setAck(null); setAckNota(""); qc.invalidateQueries({ queryKey: ["/api/auditoria-estoque/achados"] }); refetchResumo(); },
    onError: (e: any) => toast({ title: "Não foi possível reconhecer", description: e.message, variant: "destructive" }),
  });
  const reabrir = useMutation({
    mutationFn: (id: string) => api(`/api/auditoria-estoque/achados/${id}/reabrir`, { method: "POST", body: "{}" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/auditoria-estoque/achados"] }); refetchResumo(); },
  });
  const flag = useMutation({
    mutationFn: (ativo: boolean) => api("/api/auditoria-estoque/alerta/flag", { method: "POST", body: JSON.stringify({ ativo }) }),
    onSuccess: () => refetchResumo(),
  });

  const kpi = useMemo(() => {
    const k: Record<string, number> = { critica: 0, alta: 0, media: 0, info: 0 };
    for (const r of resumo?.porSeveridade || []) if (r.status === "open") k[r.severity] = (k[r.severity] || 0) + Number(r.n);
    return k;
  }, [resumo]);
  const instancias = useMemo(() => Array.from(new Set(achados.map((a) => a.instance_name).filter(Boolean))).sort() as string[], [achados]);
  const ultima = resumo?.ultimaExecucao;

  const exportar = () => exportToExcel(achados.map((a) => ({
    Severidade: SEV[a.severity]?.label || a.severity, Checagem: checagens[a.check_code]?.label || a.check_code, Status: a.status,
    Instância: a.instance_name || "", Produto: a.product_name || "", Lote: a.lot_number || "", Referência: a.ref || "",
    Esperado: a.expected === null ? "" : Number(a.expected), Encontrado: a.actual === null ? "" : Number(a.actual),
    Diferença: a.expected === null || a.actual === null ? "" : Number(a.actual) - Number(a.expected),
    "Visto em": fmtDT(a.first_seen_at), "Último visto": fmtDT(a.last_seen_at), "Reconhecido por": a.ack_by || "", Motivo: a.ack_note || "", Detalhes: JSON.stringify(a.details || {}),
  })), "auditoria-estoque", { formatos: { Esperado: "decimal", Encontrado: "decimal", Diferença: "decimal", Lote: "texto", Referência: "texto" } as any });

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-5" data-testid="auditoria-estoque">
      <BackToDashboardButton />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ListChecks className="h-6 w-6" />Auditoria de Estoque</h1>
          <p className="text-sm text-muted-foreground">
            Confere, a cada hora, trilha de movimentos × saldo dos lotes × NF-e × espelho de transferência, e aponta divergências antes que virem erro.
            {ultima && <> Última execução {fmtDT(ultima.finished_at || ultima.started_at)} ({ultima.trigger}) · {ultima.total ?? "…"} achado(s).</>}
            {resumo?.desde && <> Data-base: {fmtD(resumo.desde)}.</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm mr-2" title="Aviso diário por WhatsApp ao gestor (07:40, dia útil) quando houver crítica em aberto">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            <Label className="text-xs">Alerta WhatsApp</Label>
            <Switch checked={!!resumo?.alertaAtivo} onCheckedChange={(v) => flag.mutate(v)} data-testid="switch-alerta" />
          </div>
          <Button variant="outline" size="sm" onClick={() => { refetch(); refetchResumo(); }} disabled={isFetching}><RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /></Button>
          <Button size="sm" onClick={() => executar.mutate()} disabled={executar.isPending || resumo?.rodando} data-testid="button-executar">
            <Play className="h-4 w-4 mr-2" />{executar.isPending || resumo?.rodando ? "Executando…" : "Executar agora"}
          </Button>
          <Button variant="outline" size="sm" onClick={exportar} disabled={!achados.length}><Download className="h-4 w-4 mr-2" />Excel</Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {(["critica", "alta", "media", "info"] as const).map((s) => {
          const I = SEV[s].icon; const ativo = sev === s && status === "open";
          return (
            <Card key={s} className={`cursor-pointer transition ${ativo ? "ring-2 ring-primary" : ""}`} onClick={() => { setStatus("open"); setSev(ativo ? "" : s); }} data-testid={`kpi-${s}`}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`rounded-lg p-2 border ${SEV[s].badge}`}><I className="h-5 w-5" /></div>
                <div><div className="text-xs text-muted-foreground">{SEV[s].label} em aberto</div><div className="text-2xl font-bold">{kpi[s] || 0}</div></div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 grid gap-3 md:grid-cols-6">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">Buscar (produto, lote, NF/pedido)</Label>
            <div className="relative"><Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" /><Input className="pl-8" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="ex.: H131026, 108020, FRUTAS VERMELHAS" /></div>
          </div>
          <div className="space-y-1"><Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="open">Em aberto</SelectItem><SelectItem value="ack">Reconhecidos</SelectItem><SelectItem value="resolved">Resolvidos</SelectItem><SelectItem value="all">Todos</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label className="text-xs">Severidade</Label>
            <Select value={sev || "_"} onValueChange={(v) => setSev(v === "_" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="_">Todas</SelectItem>{Object.entries(SEV).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label className="text-xs">Checagem</Label>
            <Select value={check || "_"} onValueChange={(v) => setCheck(v === "_" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="_">Todas</SelectItem>{Object.entries(checagens).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label className="text-xs">Instância</Label>
            <Select value={inst || "_"} onValueChange={(v) => setInst(v === "_" ? "" : v)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="_">Todas</SelectItem>{instancias.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent></Select></div>
        </CardContent>
      </Card>

      {/* Tabela de achados */}
      <Card>
        <CardHeader className="py-3"><CardTitle className="text-base">{achados.length} achado(s)</CardTitle>
          {check && checagens[check] && <CardDescription>{checagens[check].descricao}</CardDescription>}</CardHeader>
        <CardContent className="p-0">
          {isLoading ? <div className="p-8 text-center text-muted-foreground">Carregando…</div>
          : achados.length === 0 ? <div className="p-10 text-center text-muted-foreground flex flex-col items-center gap-2"><CheckCircle2 className="h-8 w-8 text-green-600" />Nenhum achado com esses filtros.</div>
          : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background shadow-[0_1px_0_0_hsl(var(--border))] z-10">
                  <tr className="text-left">
                    <th className="px-3 py-2">Sev.</th><th className="px-3 py-2">Checagem</th><th className="px-3 py-2">Inst.</th><th className="px-3 py-2">Produto</th>
                    <th className="px-3 py-2">Lote</th><th className="px-3 py-2">Ref.</th><th className="px-3 py-2 text-right">Esperado</th><th className="px-3 py-2 text-right">Encontrado</th>
                    <th className="px-3 py-2 text-right">Dif.</th><th className="px-3 py-2">Visto</th><th className="px-3 py-2">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {achados.map((a) => {
                    const dif = a.expected !== null && a.actual !== null ? Number(a.actual) - Number(a.expected) : null;
                    const d = a.details || {};
                    return (
                      <tr key={a.id} className="border-t hover:bg-muted/30 align-top" data-testid={`achado-${a.check_code}`}>
                        <td className="px-3 py-2"><Badge className={`${SEV[a.severity]?.badge} border text-[11px]`}>{SEV[a.severity]?.label}</Badge></td>
                        <td className="px-3 py-2">
                          <div className="font-medium" title={checagens[a.check_code]?.descricao}>{checagens[a.check_code]?.label || a.check_code}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {d.legado && <span className="mr-2">legado (antes da data-base)</span>}
                            {d.lacunas ? <span className="mr-2">{d.lacunas} lacuna(s) · última {fmtD(d.ultimaLacunaEm)}</span> : null}
                            {d.cliente && <span className="mr-2">{d.cliente}</span>}
                            {d.nfStatus && <span className="mr-2">NF {d.nfStatus}</span>}
                            {d.etapaCard && <span className="mr-2">card: {d.etapaCard}</span>}
                            {d.vezes && <span className="mr-2">{d.vezes}×</span>}
                            {d.por && <span className="mr-2">por {d.por}</span>}
                            {d.nota && <span className="mr-2" title={d.nota}>{String(d.nota).slice(0, 60)}</span>}
                            {a.status === "ack" && <span className="text-amber-700">reconhecido por {a.ack_by} — {a.ack_note}</span>}
                            {a.status === "resolved" && <span className="text-green-700">resolvido em {fmtDT(a.resolved_at)}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{a.instance_name || "–"}</td>
                        <td className="px-3 py-2">{a.product_name || "–"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {a.lot_id ? <button className="underline decoration-dotted text-primary" onClick={() => setExtratoLot(a.lot_id)}>{a.lot_number}</button> : (a.lot_number || "–")}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{a.ref || "–"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(a.expected)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(a.actual)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${dif ? (dif > 0 ? "text-red-600" : "text-orange-600") : ""}`}>{dif === null ? "–" : (dif > 0 ? "+" : "") + fmtN(dif)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmtDT(a.first_seen_at)}<br />até {fmtDT(a.last_seen_at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {a.status === "open" && <Button size="sm" variant="outline" onClick={() => { setAck(a); setAckNota(""); }}>Reconhecer</Button>}
                          {a.status === "ack" && <Button size="sm" variant="ghost" onClick={() => reabrir.mutate(a.id)}>Reabrir</Button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Extrato de lote por busca */}
      <Card>
        <CardHeader className="py-3"><CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" />Extrato de lote</CardTitle>
          <CardDescription>Trilha completa de um lote com saldo corrente recalculado e marcação de quebras — digite o número do lote ou o produto.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <Input value={buscaLote} onChange={(e) => setBuscaLote(e.target.value)} placeholder="ex.: H131026" className="max-w-sm" data-testid="input-busca-lote" />
          {lotesBusca.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {lotesBusca.map((l) => (
                <button key={l.id} onClick={() => setExtratoLot(l.id)} className="text-xs border rounded px-2 py-1 hover:bg-muted">
                  <span className="font-semibold">{l.instance_name}</span> · {l.lot_number} · {l.product_name} · {l.stock_type === "blocked" ? "bloq." : "em uso"} · {fmtN(l.quantity)}{!l.is_active && " · inativo"}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog reconhecer */}
      <Dialog open={!!ack} onOpenChange={(o) => !o && setAck(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reconhecer achado</DialogTitle>
            <DialogDescription>{ack && <>{checagens[ack.check_code]?.label} — {ack.product_name} {ack.lot_number ? `· lote ${ack.lot_number}` : ""} {ack.ref ? `· ${ack.ref}` : ""}</>}<br />O achado sai da lista de abertos, fica registrado com seu nome e motivo, e volta sozinho se a divergência mudar.</DialogDescription></DialogHeader>
          <Textarea value={ackNota} onChange={(e) => setAckNota(e.target.value)} placeholder="Motivo (ex.: lote legado anterior ao livro de movimentos; NF será reemitida; ajuste de inventário conferido)" rows={3} />
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setAck(null)}>Cancelar</Button>
            <Button onClick={() => ack && reconhecer.mutate({ id: ack.id, nota: ackNota })} disabled={ackNota.trim().length < 3 || reconhecer.isPending}>Reconhecer</Button></div>
        </DialogContent>
      </Dialog>

      <ExtratoLoteDialog lotId={extratoLot} onClose={() => setExtratoLot(null)} />
    </div>
  );
}

function ExtratoLoteDialog({ lotId, onClose }: { lotId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/auditoria-estoque/lote", lotId], queryFn: () => api(`/api/auditoria-estoque/lote/${lotId}/extrato`), enabled: !!lotId });
  const l = data?.lote;
  return (
    <Dialog open={!!lotId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5" />Extrato do lote {l?.lotNumber} {l && <Badge variant="outline">{l.instanceName} · {l.stockType === "blocked" ? "bloqueado" : "em uso"}{!l.isActive && " · inativo"}</Badge>}</DialogTitle>
          <DialogDescription>
            {l && <>{l.productName} · saldo gravado <b>{fmtN(l.quantity)}</b> · saldo pela trilha <b>{fmtN(data.saldoTrilha)}</b> · {data.fecha ? <span className="text-green-700">fecha ✓</span> : <span className="text-red-700">não fecha</span>} · {data.quebras} quebra(s) · criado em {fmtD(l.createdAt)}</>}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? <div className="p-6 text-center text-muted-foreground">Carregando…</div> : (
          <div className="overflow-auto max-h-[65vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background"><tr className="text-left"><th className="px-2 py-1">Quando</th><th className="px-2 py-1">Tipo</th><th className="px-2 py-1">Origem</th><th className="px-2 py-1 text-right">Qtd.</th><th className="px-2 py-1 text-right">Antes</th><th className="px-2 py-1 text-right">Depois</th><th className="px-2 py-1">Obs.</th></tr></thead>
              <tbody>
                {(data?.movimentos || []).map((m: any) => (
                  <tr key={m.id} className={`border-t ${m.quebra ? "bg-red-50" : ""}`} title={m.quebra ? `QUEBRA: o saldo anterior esperado era ${fmtN(m.saldoAntesEsperado)}, o movimento diz ${fmtN(m.previous_quantity)}` : ""}>
                    <td className="px-2 py-1 whitespace-nowrap">{fmtDT(m.created_at)}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{m.movement_type}{m.quebra && <Badge className="ml-1 bg-red-100 text-red-800 text-[10px]">quebra</Badge>}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{m.nf ? `NF ${m.nf}` : ""} {m.order_number || ""} {m.customer_name ? `· ${String(m.customer_name).slice(0, 28)}` : ""}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${m.delta < 0 ? "text-red-700" : m.delta > 0 ? "text-green-700" : ""}`}>{m.delta > 0 ? "+" : ""}{fmtN(m.delta)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtN(m.previous_quantity)}</td>
                    <td className="px-2 py-1 text-right tabular-nums font-medium">{fmtN(m.new_quantity)}</td>
                    <td className="px-2 py-1 text-muted-foreground" title={m.notes}>{String(m.notes || "").slice(0, 70)}{m.created_by ? ` — ${m.created_by}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
