import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FlaskConical, RefreshCw, Check, XCircle, Package, Truck, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { corStatusAmostra, type Amostra } from "@/components/LeadAmostras";

// 🧃 Painel do administrativo: pedidos de amostra para LEADS (aprovar, separar, entregar).
type Linha = Amostra & { vendedor?: string; leadName?: string | null; leadPhone?: string | null; leadContact?: string | null; leadCity?: string | null; leadNeighborhood?: string | null };

const dBR = (s?: string | null) => { if (!s) return "—"; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : new Date(s).toLocaleDateString("pt-BR"); };
const FILTROS: { v: string; l: string }[] = [
  { v: "solicitado", l: "Aguardando aprovação" }, { v: "aprovado", l: "Aprovadas" }, { v: "separado", l: "Separadas" },
  { v: "entregue", l: "Entregues" }, { v: "degustado", l: "Degustadas" }, { v: "recusado", l: "Recusadas" }, { v: "", l: "Todas" },
];

export default function AmostrasLeads() {
  const { toast } = useToast();
  const [filtro, setFiltro] = useState("solicitado");
  const [lista, setLista] = useState<Linha[]>([]);
  const [resumo, setResumo] = useState<{ status: string; n: number; valor: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [recusa, setRecusa] = useState<Linha | null>(null);
  const [motivo, setMotivo] = useState("");
  const [agindo, setAgindo] = useState<number | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const d: any = await apiRequest("GET", `/api/admin/amostras?status=${encodeURIComponent(filtro)}`);
      if (d?.ok) { setLista(d.amostras || []); setResumo(d.resumo || []); }
      else toast({ title: "Erro ao carregar", description: d?.message, variant: "destructive" });
    } catch (e: any) { toast({ title: "Erro ao carregar", description: e?.message, variant: "destructive" }); }
    finally { setLoading(false); }
  }, [filtro, toast]);
  useEffect(() => { carregar(); }, [carregar]);

  const mudar = async (a: Linha, status: string, motivoTxt?: string) => {
    setAgindo(a.id);
    try {
      const d: any = await apiRequest("POST", `/api/amostras/${a.id}/status`, { status, motivo: motivoTxt || "" });
      if (d?.ok) { toast({ title: `Amostra #A-${a.id}: ${d.amostra.statusLabel}` }); setRecusa(null); setMotivo(""); carregar(); }
      else toast({ title: "Não foi possível", description: d?.message, variant: "destructive" });
    } catch (e: any) { toast({ title: "Erro", description: e?.message, variant: "destructive" }); }
    finally { setAgindo(null); }
  };
  const n = (st: string) => Number(resumo.find((r) => r.status === st)?.n || 0);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-violet-600 text-white flex items-center justify-center"><FlaskConical className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">Amostras para Leads</h1>
            <p className="text-sm text-muted-foreground">Pedidos de degustação feitos pelos vendedores em leads. Regra: 1 unidade de cada sabor, só 350 ml, 1 pedido por lead. Ao aprovar, o Integra cria o cadastro em prospecção pelo CNPJ e manda a amostra para o Pipeline de Faturamento (NF de amostra grátis), igual ao cliente.</p>
          </div>
        </div>
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={carregar}><RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar</Button><BackToDashboardButton /></div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[["solicitado", "Aguardando"], ["aprovado", "Aprovadas"], ["separado", "Separadas"], ["entregue", "Entregues"], ["degustado", "Degustadas"]].map(([st, l]) => (
          <button key={st} type="button" onClick={() => setFiltro(st)} className={`rounded-lg border p-3 text-left ${filtro === st ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30" : "bg-card"}`} data-testid={`card-amostras-${st}`}>
            <div className="text-[11px] text-muted-foreground">{l}</div>
            <div className="text-2xl font-bold">{n(st)}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTROS.map((f) => (
          <button key={f.v} type="button" onClick={() => setFiltro(f.v)} className={`text-xs px-3 py-1.5 rounded-full border ${filtro === f.v ? "bg-violet-600 border-violet-600 text-white" : "bg-background text-muted-foreground hover:border-violet-400"}`}>{f.l}</button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{FILTROS.find((f) => f.v === filtro)?.l} · {lista.length}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {loading ? <p className="text-sm text-muted-foreground py-6 text-center"><Loader2 className="h-5 w-5 inline animate-spin mr-2" />Carregando…</p>
          : lista.length === 0 ? <p className="text-sm text-muted-foreground py-6 text-center">Nenhum pedido de amostra aqui.</p>
          : lista.map((a) => (
            <div key={a.id} className="rounded-lg border p-3 space-y-2" data-testid={`admin-amostra-${a.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">#A-{a.id} · {a.leadName || a.leadId} <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-amber-400 text-amber-700 ml-1">Lead</span></div>
                  <div className="text-xs text-muted-foreground">{[a.vendedor && `Vendedor: ${a.vendedor}`, a.leadContact && `Contato: ${a.leadContact}`, a.leadPhone, [a.leadNeighborhood, a.leadCity].filter(Boolean).join(" - ")].filter(Boolean).join(" · ")}</div>
                </div>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${corStatusAmostra[a.status] || ""}`}>{a.statusLabel}{a.tastingResult ? ` · ${({ gostou: "gostou", pensar: "vai pensar", nao_gostou: "não gostou" } as any)[a.tastingResult] || ""}` : ""}</span>
              </div>
              <div className="text-sm">{a.items.map((i) => `${i.qty}× ${i.name}`).join(" · ")}</div>
              {(a as any).cnpj && <div className="text-xs text-muted-foreground">CNPJ {(a as any).cnpj} · {(a as any).companyName}{(a as any).pipelineItemId ? <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">NF de amostra no Pipeline</span> : null}</div>}
              <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                <span><strong>{a.totalUnits}</strong> un. (1 de cada sabor, 350 ml)</span>
                <span>{a.deliveryMode === "vendedor" ? "Vendedor leva" : "Rota de entrega"} · {dBR(a.deliveryDate)}{a.receiver ? ` · recebe ${a.receiver}` : ""}</span>
                <span>Retorno p/ fechar: {dBR(a.returnDate)}</span>
                {a.objective && <span>Objetivo: {a.objective}</span>}
                <span>Pedido em {dBR(a.createdAt)} por {a.requestedByName || "—"}</span>
                {a.approvedByName && <span>Aprovado por {a.approvedByName}</span>}
              </div>
              {a.observation && <div className="text-xs italic text-muted-foreground">“{a.observation}”</div>}
              {a.rejectedReason && <div className="text-xs text-red-700">Recusa: {a.rejectedReason}</div>}
              {a.tastingNotes && <div className="text-xs text-violet-800 dark:text-violet-300">Degustação: {a.tastingNotes}</div>}
              <div className="flex flex-wrap gap-2 pt-1">
                {a.status === "solicitado" && <>
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" disabled={agindo === a.id} onClick={() => mudar(a, "aprovado")} data-testid={`button-aprovar-${a.id}`}><Check className="h-4 w-4 mr-1" /> Aprovar</Button>
                  <Button size="sm" variant="outline" className="border-red-400 text-red-700" disabled={agindo === a.id} onClick={() => { setRecusa(a); setMotivo(""); }} data-testid={`button-recusar-${a.id}`}><XCircle className="h-4 w-4 mr-1" /> Recusar</Button>
                </>}
                {a.status === "aprovado" && <Button size="sm" variant="outline" className="border-sky-400 text-sky-700" disabled={agindo === a.id} onClick={() => mudar(a, "separado")}><Package className="h-4 w-4 mr-1" /> Marcar separada</Button>}
                {["aprovado", "separado"].includes(a.status) && <Button size="sm" variant="outline" className="border-emerald-400 text-emerald-700" disabled={agindo === a.id} onClick={() => mudar(a, "entregue")}><Truck className="h-4 w-4 mr-1" /> Marcar entregue</Button>}
                {["solicitado", "aprovado", "separado"].includes(a.status) && <Button size="sm" variant="ghost" className="text-red-600" disabled={agindo === a.id} onClick={() => { if (confirm(`Cancelar a amostra #A-${a.id}?`)) mudar(a, "cancelado"); }}>Cancelar</Button>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={!!recusa} onOpenChange={(o) => { if (!o) setRecusa(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Recusar amostra #A-{recusa?.id}</DialogTitle></DialogHeader>
          <div><Label className="text-xs">Motivo (vai para o vendedor e para o histórico do lead)</Label><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: lead sem potencial de volume" /></div>
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setRecusa(null)}>Voltar</Button><Button variant="destructive" disabled={motivo.trim().length < 3} onClick={() => recusa && mudar(recusa, "recusado", motivo.trim())}>Recusar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
