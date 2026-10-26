import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { PackageCheck, Unlock, AlertTriangle, RefreshCw, History, Loader2, FileDown, CheckCircle2 } from "lucide-react";

/**
 * RECEBIMENTO DE TRANSFERÊNCIAS (22/out/2026)
 * Fila de lotes BLOQUEADOS (entrada automática por NF de transferência IND → GYN)
 * aguardando conferência física. Quem recebe (Flávio, Lanucy, Robson ou admin)
 * informa a QUANTIDADE RECEBIDA: o lote é desbloqueado com esse saldo e, se a
 * quantidade for diferente da faturada, o ajuste fica registrado e abre o chamado
 * "DIVERGENCIA EM RECEBIMENTO" para Naiara e Flávio. Server: server/recebimento-lote.ts
 */

type Origem = {
  movimentoId: string; data: string; quantidade: number; cardId: string | null; pedido: string | null;
  nfNumero: number | null; nfSerie: string | null; nfData: string | null; nfStatus: string | null; nfId: string | null; origemInstancia: string | null;
};
type LotePendente = {
  id: string; product_id: string; product_name: string; instance_id: string; instance_name: string; instance_code: string;
  lot_number: string; quantity: number; unit_cost: number | null; created_at: string; updated_at: string; notes: string | null; origens: Origem[];
};
type Recebimento = {
  id: string; lot_number: string; product_name: string; instance_name: string; qtd_faturada: string; qtd_recebida: string; divergencia: string;
  observacao: string | null; recebido_por_nome: string; recebido_por_email: string | null; chamado_ids: string[] | null; created_at: string; origem: Origem[] | null;
};

const fmtN = (v: any) => (v === null || v === undefined || v === "" ? "–" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }));
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const fmtD = (s?: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "–");
const nfLabel = (o: Origem) => (o.nfNumero != null ? `NF-e ${o.nfNumero}${o.nfSerie && o.nfSerie !== "1" ? "/" + o.nfSerie : ""}` : "sem NF");

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e: any = new Error(j?.message || `HTTP ${r.status}`); Object.assign(e, j); throw e; }
  return j;
}

export default function RecebimentoEstoque() {
  const qc = useQueryClient();
  const [location] = useLocation();
  const { data, isLoading, refetch, isFetching, error } = useQuery<{ podeReceber: boolean; lotes: LotePendente[] }>({
    queryKey: ["/api/recebimento-lote/pendentes"], queryFn: () => api("/api/recebimento-lote/pendentes"), refetchInterval: 60_000,
  });
  const { data: historico = [] } = useQuery<Recebimento[]>({ queryKey: ["/api/recebimento-lote/historico"], queryFn: () => api("/api/recebimento-lote/historico?dias=90") });

  const [sel, setSel] = useState<LotePendente | null>(null);
  const [recebida, setRecebida] = useState("");
  const [obs, setObs] = useState("");
  const [filtroInst, setFiltroInst] = useState<string>("all");
  const [busca, setBusca] = useState("");

  // ?lot=<id> (vindo da Gestão de Estoque) abre direto a conferência daquele lote.
  useEffect(() => {
    const m = /[?&]lot=([^&]+)/.exec(typeof window !== "undefined" ? window.location.search : "");
    if (!m || !data?.lotes?.length || sel) return;
    const l = data.lotes.find((x) => x.id === decodeURIComponent(m[1]));
    if (l) abrir(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.lotes, location]);

  const abrir = (l: LotePendente) => { setSel(l); setRecebida(String(l.quantity)); setObs(""); };

  const receber = useMutation({
    mutationFn: async () => api(`/api/recebimento-lote/${sel!.id}/receber`, { method: "POST", body: JSON.stringify({ quantidadeRecebida: Number(String(recebida).replace(",", ".")), observacao: obs }) }),
    onSuccess: (r: any) => {
      const div = Number(r?.divergencia || 0);
      toast({
        title: div === 0 ? `Lote ${r.lote} recebido e desbloqueado` : `Lote ${r.lote} recebido com divergência (${div > 0 ? "+" : ""}${fmtN(div)})`,
        description: div === 0 ? `${fmtN(r.recebida)} un conferidas.` : `Ajustado para ${fmtN(r.recebida)} un. Chamado "DIVERGENCIA EM RECEBIMENTO" aberto para Naiara e Flávio.`,
        variant: div === 0 ? undefined : "destructive",
      });
      setSel(null);
      qc.invalidateQueries({ queryKey: ["/api/recebimento-lote/pendentes"] });
      qc.invalidateQueries({ queryKey: ["/api/recebimento-lote/historico"] });
      qc.invalidateQueries({ queryKey: ["/api/inventory/lots"] });
      qc.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
      qc.invalidateQueries({ queryKey: ["/api/chamados/contadores"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível receber", description: e?.message, variant: "destructive" }),
  });

  const lotes = data?.lotes || [];
  const instancias = useMemo(() => Array.from(new Set(lotes.map((l) => l.instance_name))).sort(), [lotes]);
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return lotes.filter((l) => (filtroInst === "all" || l.instance_name === filtroInst) && (!q || `${l.product_name} ${l.lot_number} ${l.origens.map((o) => `${o.pedido || ""} ${o.nfNumero ?? ""}`).join(" ")}`.toLowerCase().includes(q)));
  }, [lotes, filtroInst, busca]);
  const totalUn = filtrados.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  const recebidaNum = Number(String(recebida).replace(",", "."));
  const faturada = Number(sel?.quantity || 0);
  const divergencia = Number.isFinite(recebidaNum) ? Math.round((recebidaNum - faturada) * 10000) / 10000 : 0;
  const precisaObs = divergencia !== 0 && obs.trim().length < 3;

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-recebimento-estoque">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><PackageCheck className="h-6 w-6" />Recebimento de Transferências</h1>
          <p className="text-sm text-muted-foreground">Lotes que entraram bloqueados pela NF-e de transferência. Confira o que chegou fisicamente, informe a quantidade recebida e desbloqueie.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />Atualizar</Button>
          <BackToDashboardButton />
        </div>
      </div>

      {error && <Card><CardContent className="p-6 text-red-600">{(error as Error).message}</CardContent></Card>}
      {data && !data.podeReceber && (
        <Card className="border-amber-300 bg-amber-50"><CardContent className="p-3 text-sm text-amber-900 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />Você pode ver a fila, mas só os responsáveis pelo recebimento (Flávio, Lanucy, Robson ou admin) conferem e desbloqueiam.
        </CardContent></Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">Aguardando conferência
            <Badge variant="secondary">{filtrados.length} lote(s) · {fmtN(totalUn)} un</Badge>
          </CardTitle>
          <CardDescription>Bloqueado não sai em faturamento: só o que for conferido e desbloqueado aqui entra no estoque em uso.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Input placeholder="Buscar produto, lote, pedido ou NF…" value={busca} onChange={(e) => setBusca(e.target.value)} className="max-w-xs" data-testid="input-busca-recebimento" />
            <div className="flex gap-1">
              <Button size="sm" variant={filtroInst === "all" ? "default" : "outline"} onClick={() => setFiltroInst("all")}>Todas</Button>
              {instancias.map((i) => <Button key={i} size="sm" variant={filtroInst === i ? "default" : "outline"} onClick={() => setFiltroInst(i)}>{i}</Button>)}
            </div>
          </div>
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Carregando…</div>
          ) : filtrados.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2"><CheckCircle2 className="h-8 w-8 text-green-600" />Nenhum lote aguardando conferência.</div>
          ) : (
            <div className="overflow-auto border rounded max-h-[60vh]">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-background z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-medium">Instância</th>
                    <th className="px-2 py-2 font-medium min-w-[220px]">Produto</th>
                    <th className="px-2 py-2 font-medium">Lote</th>
                    <th className="px-2 py-2 font-medium text-right">Faturado (bloqueado)</th>
                    <th className="px-2 py-2 font-medium min-w-[260px]">Origem (transferência)</th>
                    <th className="px-2 py-2 font-medium">Entrou em</th>
                    <th className="px-2 py-2 font-medium text-right">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map((l) => (
                    <tr key={l.id} className="border-t hover:bg-muted/30" data-testid={`linha-recebimento-${l.lot_number}`}>
                      <td className="px-2 py-1.5"><Badge variant="outline">{l.instance_name}</Badge></td>
                      <td className="px-2 py-1.5 font-medium">{l.product_name}</td>
                      <td className="px-2 py-1.5"><code className="bg-muted px-1.5 py-0.5 rounded">{l.lot_number}</code></td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtN(l.quantity)}</td>
                      <td className="px-2 py-1.5">
                        {l.origens.length === 0 ? <span className="text-muted-foreground text-xs" title={l.notes || ""}>sem NF de transferência identificada</span> : l.origens.map((o) => (
                          <div key={o.movimentoId} className="text-xs flex items-center gap-1 flex-wrap">
                            <span className="font-medium">{nfLabel(o)}</span>
                            {o.nfStatus && o.nfStatus !== "authorized" && <Badge variant="outline" className="text-[10px] py-0">{o.nfStatus}</Badge>}
                            <span className="text-muted-foreground">· pedido {o.pedido || "—"} · {fmtD(o.nfData || o.data)} · {fmtN(o.quantidade)} un{o.origemInstancia ? ` de ${o.origemInstancia}` : ""}</span>
                            {o.nfId && <a href={`/api/contabilidade/fiscal/nota/${o.nfId}/danfe`} target="_blank" rel="noreferrer" title="DANFE" className="text-primary"><FileDown className="h-3.5 w-3.5" /></a>}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-xs">{fmtDT(l.created_at)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Button size="sm" disabled={!data?.podeReceber} onClick={() => abrir(l)} data-testid={`button-receber-${l.lot_number}`}>
                          <Unlock className="h-4 w-4 mr-1" />Conferir e desbloquear
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" />Recebimentos (90 dias)</CardTitle>
          <CardDescription>Quem conferiu cada lote, quanto foi faturado × recebido e o chamado de divergência quando houve.</CardDescription>
        </CardHeader>
        <CardContent>
          {historico.length === 0 ? <div className="p-4 text-center text-muted-foreground text-sm">Nenhum recebimento registrado.</div> : (
            <div className="overflow-auto border rounded max-h-[50vh]">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-background z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-medium">Data</th>
                    <th className="px-2 py-2 font-medium">Instância</th>
                    <th className="px-2 py-2 font-medium">Produto</th>
                    <th className="px-2 py-2 font-medium">Lote</th>
                    <th className="px-2 py-2 font-medium text-right">Faturado</th>
                    <th className="px-2 py-2 font-medium text-right">Recebido</th>
                    <th className="px-2 py-2 font-medium text-right">Divergência</th>
                    <th className="px-2 py-2 font-medium">Responsável</th>
                    <th className="px-2 py-2 font-medium">Obs. / chamado</th>
                  </tr>
                </thead>
                <tbody>
                  {historico.map((r) => {
                    const d = Number(r.divergencia) || 0;
                    const ids = Array.isArray(r.chamado_ids) ? r.chamado_ids : [];
                    return (
                      <tr key={r.id} className={`border-t ${d !== 0 ? "bg-red-50/60 dark:bg-red-950/20" : ""}`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{fmtDT(r.created_at)}</td>
                        <td className="px-2 py-1.5">{r.instance_name}</td>
                        <td className="px-2 py-1.5">{r.product_name}</td>
                        <td className="px-2 py-1.5"><code className="bg-muted px-1.5 py-0.5 rounded">{r.lot_number}</code></td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtN(r.qtd_faturada)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtN(r.qtd_recebida)}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${d !== 0 ? "text-red-700" : "text-green-700"}`}>{d === 0 ? "OK" : `${d > 0 ? "+" : ""}${fmtN(d)}`}</td>
                        <td className="px-2 py-1.5">{r.recebido_por_nome}</td>
                        <td className="px-2 py-1.5 text-xs">
                          {r.observacao && <div>{r.observacao}</div>}
                          {ids.map((id) => <a key={id} className="text-primary underline" href={`/chamados?id=${id}`}>chamado DIVERGENCIA EM RECEBIMENTO</a>)}
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

      <Dialog open={!!sel} onOpenChange={(o) => { if (!o) setSel(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Unlock className="h-5 w-5 text-green-700" />Conferência de recebimento</DialogTitle>
            <DialogDescription>Conte fisicamente o que chegou deste lote e informe a quantidade recebida. O lote será desbloqueado com essa quantidade.</DialogDescription>
          </DialogHeader>
          {sel && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><Label className="text-xs text-muted-foreground">Produto</Label><div className="font-medium">{sel.product_name}</div></div>
                <div><Label className="text-xs text-muted-foreground">Lote · Instância</Label><div><code className="bg-muted px-1.5 py-0.5 rounded">{sel.lot_number}</code> · {sel.instance_name}</div></div>
              </div>
              <div className="rounded border p-2 text-xs space-y-1 bg-muted/30">
                <div className="font-medium">Faturamento (transferência)</div>
                {sel.origens.length === 0 ? <div className="text-muted-foreground">sem NF de transferência identificada</div> : sel.origens.map((o) => (
                  <div key={o.movimentoId}>{nfLabel(o)} · pedido {o.pedido || "—"} · {fmtD(o.nfData || o.data)} · {fmtN(o.quantidade)} un{o.origemInstancia ? ` de ${o.origemInstancia}` : ""}</div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Quantidade faturada</Label>
                  <Input disabled value={fmtN(sel.quantity)} />
                </div>
                <div>
                  <Label>Quantidade recebida *</Label>
                  <Input type="number" min={0} step="1" value={recebida} onChange={(e) => setRecebida(e.target.value)} autoFocus data-testid="input-qtd-recebida" />
                </div>
              </div>
              {Number.isFinite(recebidaNum) && divergencia !== 0 && (
                <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800 flex gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <b>Divergência de {divergencia > 0 ? "+" : ""}{fmtN(divergencia)} un.</b> O lote será ajustado para {fmtN(recebidaNum)} un e um chamado
                    <b> "DIVERGENCIA EM RECEBIMENTO"</b> será aberto para Naiara e Flávio com os dados do faturamento, do recebimento e o seu nome.
                  </div>
                </div>
              )}
              <div>
                <Label>Observação{divergencia !== 0 ? " * (obrigatória na divergência)" : ""}</Label>
                <Textarea rows={3} value={obs} onChange={(e) => setObs(e.target.value)} placeholder={divergencia !== 0 ? "Ex.: faltaram 5 unidades no fardo 3; 2 garrafas quebradas…" : "Opcional"} data-testid="input-obs-recebimento" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSel(null)}>Cancelar</Button>
            <Button onClick={() => receber.mutate()} disabled={receber.isPending || !Number.isFinite(recebidaNum) || recebidaNum < 0 || precisaObs} data-testid="button-confirmar-recebimento">
              {receber.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
              {divergencia === 0 ? "Confirmar e desbloquear" : "Registrar divergência e desbloquear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
