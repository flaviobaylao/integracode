import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlaskConical, Plus, Loader2, Minus, Check, XCircle, Truck, User } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// 🧃 Amostras para LEAD — degustação antes de virar cliente.
// Seção reutilizável (Rota do Dia, Leads, Consulta no local): lista os pedidos de amostra do lead,
// abre o formulário "Pedir amostra" e o registro de degustação. Nada aqui conta como cliente ativo,
// faturamento ou comissão — é um pedido de amostra ligado ao LEAD.

export type Amostra = {
  id: number; leadId: string; status: string; statusLabel: string;
  items: { productId: string; name: string; qty: number; unitValue: number }[];
  totalUnits: number; totalValue: number; deliveryMode: "rota" | "vendedor"; deliveryDate?: string | null; receiver?: string | null;
  objective?: string | null; returnDate?: string | null; observation?: string | null;
  approvedByName?: string | null; rejectedReason?: string | null; deliveredAt?: string | null;
  tastingResult?: string | null; tastingNotes?: string | null; createdAt?: string; requestedByName?: string | null;
};

const brl = (n: number) => `R$ ${(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dBR = (s?: string | null) => { if (!s) return "—"; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : new Date(s).toLocaleDateString("pt-BR"); };
const hojeMais = (dias: number) => { const d = new Date(); d.setDate(d.getDate() + dias); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export const corStatusAmostra: Record<string, string> = {
  solicitado: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  aprovado: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  separado: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  entregue: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  degustado: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  recusado: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  cancelado: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};
const rotuloDegust: Record<string, string> = { gostou: "Gostou", pensar: "Vai pensar", nao_gostou: "Não gostou" };

// Kit padrão: 2× Maracujá, 2× Acerola, 2× Limonada (350 ml) — casa pelo nome do produto
const KIT_PADRAO = [/maracuja.*350/i, /acerola.*350/i, /limonada.*350/i];
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function SeloAmostra({ status, tastingResult, className = "" }: { status?: string | null; tastingResult?: string | null; className?: string }) {
  if (!status) return null;
  const txt = status === "degustado" ? `Degustação: ${rotuloDegust[tastingResult || ""] || "registrada"}` : `Amostra: ${({ solicitado: "aguardando aprovação", aprovado: "aprovada", separado: "separada", entregue: "entregue", recusado: "recusada", cancelado: "cancelada" } as any)[status] || status}`;
  return <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${corStatusAmostra[status] || "bg-gray-100 text-gray-700"} ${className}`} data-testid="selo-amostra"><FlaskConical className="h-3 w-3" /> {txt}</span>;
}

export default function LeadAmostras({ leadId, leadName, leadContact, leadPhone, compact = false, onChanged }: {
  leadId: string; leadName?: string; leadContact?: string | null; leadPhone?: string | null; compact?: boolean; onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [lista, setLista] = useState<Amostra[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [cfg, setCfg] = useState<{ maxUnidades: number; maxPedidosLead: number }>({ maxUnidades: 12, maxPedidosLead: 2 });
  const [formOpen, setFormOpen] = useState(false);
  const [degustDe, setDegustDe] = useState<Amostra | null>(null);

  const carregar = useCallback(async () => {
    try {
      const d: any = await apiRequest("GET", `/api/leads/${leadId}/amostras`);
      setLista(Array.isArray(d?.amostras) ? d.amostras : []);
    } catch { /* seção é complementar */ } finally { setCarregando(false); }
  }, [leadId]);
  useEffect(() => { carregar(); apiRequest("GET", "/api/amostras/config").then((c: any) => c && setCfg(c)).catch(() => {}); }, [carregar]);

  const ativas = lista.filter((a) => !["recusado", "cancelado"].includes(a.status));
  const ultima = ativas[0];
  const podePedir = ativas.length < cfg.maxPedidosLead && (!ultima || ultima.status === "degustado");
  const motivoBloqueio = ativas.length >= cfg.maxPedidosLead ? `Limite de ${cfg.maxPedidosLead} amostras por lead` : (ultima && ultima.status !== "degustado" ? "Registre a degustação da amostra atual para pedir outra" : "");

  const mudarStatus = async (a: Amostra, status: string) => {
    try {
      const d: any = await apiRequest("POST", `/api/amostras/${a.id}/status`, { status });
      if (d?.ok) { toast({ title: `Amostra #A-${a.id}: ${d.amostra.statusLabel}` }); carregar(); onChanged?.(); }
      else toast({ title: "Não foi possível", description: d?.message, variant: "destructive" });
    } catch (e: any) { toast({ title: "Erro", description: e?.message, variant: "destructive" }); }
  };

  return (
    <div className={`rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/20 ${compact ? "p-2" : "p-3"} space-y-2`} data-testid={`amostras-lead-${leadId}`} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-violet-900 dark:text-violet-200 inline-flex items-center gap-1.5"><FlaskConical className="h-4 w-4 text-violet-700 dark:text-violet-300" /> Amostras para degustação</span>
        <span className="text-[11px] text-muted-foreground">{carregando ? "…" : `${ativas.length} de ${cfg.maxPedidosLead}`}</span>
      </div>

      {lista.map((a) => (
        <div key={a.id} className="rounded-md border border-violet-200/70 dark:border-violet-900 bg-white dark:bg-gray-950 px-2.5 py-2 space-y-1 text-xs" data-testid={`amostra-${a.id}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Amostra #A-{a.id} · {dBR(a.createdAt)}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${corStatusAmostra[a.status] || ""}`}>{a.statusLabel}{a.status === "degustado" && a.tastingResult ? ` · ${rotuloDegust[a.tastingResult] || a.tastingResult}` : ""}</span>
          </div>
          <div className="text-muted-foreground">{a.items.map((i) => `${i.qty}× ${i.name}`).join(" · ")}</div>
          <div className="text-[11px] text-muted-foreground">{a.totalUnits} un. · ref. {brl(a.totalValue)} · {a.deliveryMode === "vendedor" ? "vendedor leva" : "rota de entrega"}{a.deliveryDate ? ` ${dBR(a.deliveryDate)}` : ""}{a.returnDate ? ` · retorno ${dBR(a.returnDate)}` : ""}</div>
          {a.status === "recusado" && a.rejectedReason && <div className="text-[11px] text-red-700 dark:text-red-400">Motivo: {a.rejectedReason}</div>}
          {a.tastingNotes && <div className="text-[11px] italic text-muted-foreground">“{a.tastingNotes}”</div>}
          <div className="flex gap-1.5 flex-wrap pt-0.5">
            {["aprovado", "separado"].includes(a.status) && a.deliveryMode === "vendedor" && (
              <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-400 text-emerald-700" onClick={() => mudarStatus(a, "entregue")} data-testid={`button-amostra-entregue-${a.id}`}><Truck className="h-3.5 w-3.5 mr-1" /> Entreguei</Button>
            )}
            {["aprovado", "separado", "entregue"].includes(a.status) && (
              <Button size="sm" className="h-8 text-xs bg-violet-600 hover:bg-violet-700 text-white" onClick={() => setDegustDe(a)} data-testid={`button-amostra-degustacao-${a.id}`}><Check className="h-3.5 w-3.5 mr-1" /> Registrar degustação</Button>
            )}
            {a.status === "solicitado" && (
              <Button size="sm" variant="ghost" className="h-8 text-xs text-red-600" onClick={() => mudarStatus(a, "cancelado")} data-testid={`button-amostra-cancelar-${a.id}`}><XCircle className="h-3.5 w-3.5 mr-1" /> Cancelar</Button>
            )}
          </div>
        </div>
      ))}

      <Button size="sm" className="w-full h-10 bg-violet-600 hover:bg-violet-700 text-white" disabled={!podePedir || carregando} onClick={() => setFormOpen(true)} data-testid={`button-pedir-amostra-${leadId}`}>
        <Plus className="h-4 w-4 mr-1" /> Pedir amostra
      </Button>
      <p className="text-[10px] text-muted-foreground text-center">{motivoBloqueio || "Aprovado pelo administrativo · não conta como cliente ativo nem comissão"}</p>

      {formOpen && (
        <FormAmostra leadId={leadId} leadName={leadName} leadContact={leadContact} leadPhone={leadPhone} cfg={cfg}
          onClose={() => setFormOpen(false)} onCreated={() => { setFormOpen(false); carregar(); onChanged?.(); queryClient.invalidateQueries({ queryKey: ["/api/leads"] }); }} />
      )}
      {degustDe && (
        <DialogDegustacao amostra={degustDe} onClose={() => setDegustDe(null)} onSaved={() => { setDegustDe(null); carregar(); onChanged?.(); }} />
      )}
    </div>
  );
}

function FormAmostra({ leadId, leadName, leadContact, leadPhone, cfg, onClose, onCreated }: {
  leadId: string; leadName?: string; leadContact?: string | null; leadPhone?: string | null; cfg: { maxUnidades: number }; onClose: () => void; onCreated: () => void;
}) {
  const { toast } = useToast();
  const [produtos, setProdutos] = useState<any[]>([]);
  const [qtd, setQtd] = useState<Record<string, number>>({});
  const [busca, setBusca] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"rota" | "vendedor">("rota");
  const [deliveryDate, setDeliveryDate] = useState(hojeMais(2));
  const [receiver, setReceiver] = useState(leadContact || "");
  const [objective, setObjective] = useState("Degustação com o dono / comprador");
  const [returnDate, setReturnDate] = useState(hojeMais(7));
  const [observation, setObservation] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    apiRequest("GET", "/api/products").then((ps: any) => {
      const lista = (Array.isArray(ps) ? ps : []).filter((p: any) => p.isActive !== false && !/bombona/i.test(p.name || ""));
      setProdutos(lista);
      // kit padrão pré-marcado
      const q: Record<string, number> = {};
      for (const rx of KIT_PADRAO) { const p = lista.find((x: any) => rx.test(norm(x.name))); if (p) q[p.id] = 2; }
      setQtd(q);
    }).catch(() => setProdutos([]));
  }, []);

  const valorRef = (p: any) => Number(p.resaleGoianiaPrice || p.wholesalePrice || p.price || 0);
  const itens = useMemo(() => produtos.map((p) => ({ productId: p.id, name: p.name, qty: qtd[p.id] || 0, unitValue: valorRef(p) })).filter((i) => i.qty > 0), [produtos, qtd]);
  const totalUn = itens.reduce((s, i) => s + i.qty, 0);
  const totalVal = itens.reduce((s, i) => s + i.qty * i.unitValue, 0);
  const visiveis = produtos.filter((p) => !busca || norm(p.name).includes(norm(busca)));
  const set = (id: string, v: number) => setQtd((q) => ({ ...q, [id]: Math.max(0, v) }));

  const enviar = async () => {
    if (!itens.length) { toast({ title: "Escolha ao menos um produto", variant: "destructive" }); return; }
    setSalvando(true);
    try {
      const d: any = await apiRequest("POST", `/api/leads/${leadId}/amostras`, { items: itens, deliveryMode, deliveryDate, receiver, objective, returnDate, observation });
      if (d?.ok) { toast({ title: `Pedido de amostra #A-${d.amostra.id} enviado`, description: "Aguardando aprovação do administrativo." }); onCreated(); }
      else toast({ title: "Não foi possível enviar", description: d?.message, variant: "destructive" });
    } catch (e: any) { toast({ title: "Erro ao enviar", description: e?.message, variant: "destructive" }); }
    finally { setSalvando(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FlaskConical className="h-5 w-5 text-violet-600" /> Pedir amostra</DialogTitle>
          <DialogDescription>Degustação para fechar negócio · sem faturamento, sem comissão.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm space-y-0.5">
            <div className="flex items-center justify-between"><span className="text-[11px] font-bold text-muted-foreground tracking-wide">1 · DADOS DO LEAD</span><span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-amber-400 text-amber-700">Lead · não é cliente</span></div>
            <div className="font-semibold">{leadName || "Lead"}</div>
            <div className="text-xs text-muted-foreground">{[leadContact && `Contato: ${leadContact}`, leadPhone].filter(Boolean).join(" · ") || "sem contato informado"}</div>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between"><span className="text-[11px] font-bold text-muted-foreground tracking-wide">2 · PRODUTOS DA AMOSTRA</span><span className="text-[11px] text-muted-foreground">máx. {cfg.maxUnidades} un.</span></div>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" className="flex-1 border-violet-400 text-violet-700" onClick={() => { const q: Record<string, number> = {}; for (const rx of KIT_PADRAO) { const p = produtos.find((x: any) => rx.test(norm(x.name))); if (p) q[p.id] = 2; } setQtd(q); }}>Kit padrão (6 un.)</Button>
              <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => setQtd({})}>Limpar</Button>
            </div>
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto…" className="h-9 text-sm" />
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {visiveis.map((p) => (
                <div key={p.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${qtd[p.id] ? "border-violet-300 bg-violet-50/60 dark:bg-violet-950/20" : ""}`}>
                  <div className="flex-1 min-w-0"><div className="text-xs font-medium truncate">{p.name}</div><div className="text-[10px] text-muted-foreground">ref. {brl(valorRef(p))}</div></div>
                  <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="Menos" onClick={() => set(p.id, (qtd[p.id] || 0) - 1)}><Minus className="h-3.5 w-3.5" /></Button>
                  <span className="w-5 text-center text-sm font-bold">{qtd[p.id] || 0}</span>
                  <Button type="button" size="icon" variant="outline" className="h-8 w-8 border-violet-400 text-violet-700" aria-label="Mais" onClick={() => set(p.id, (qtd[p.id] || 0) + 1)}><Plus className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
              {produtos.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">Carregando produtos…</p>}
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted px-2.5 py-1.5 text-xs"><span>{totalUn} unidade(s)</span><span className="font-semibold">valor de referência {brl(totalVal)}</span></div>
            {totalUn > cfg.maxUnidades && <p className="text-[11px] text-red-600">Acima do limite de {cfg.maxUnidades} unidades — só o gestor pode aprovar um pedido assim.</p>}
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <span className="text-[11px] font-bold text-muted-foreground tracking-wide">3 · ENTREGA</span>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" className={`h-11 ${deliveryMode === "rota" ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30" : ""}`} onClick={() => setDeliveryMode("rota")}><Truck className="h-4 w-4 mr-1.5" /> Rota de entrega</Button>
              <Button type="button" variant="outline" className={`h-11 ${deliveryMode === "vendedor" ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30" : ""}`} onClick={() => setDeliveryMode("vendedor")}><User className="h-4 w-4 mr-1.5" /> Vendedor leva</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Data prevista</Label><Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></div>
              <div><Label className="text-xs">Quem recebe</Label><Input value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="Nome" /></div>
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <span className="text-[11px] font-bold text-muted-foreground tracking-wide">4 · O QUE FOI COMBINADO</span>
            <div><Label className="text-xs">Objetivo da amostra</Label>
              <Select value={objective} onValueChange={setObjective}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Degustação com o dono / comprador">Degustação com o dono / comprador</SelectItem>
                  <SelectItem value="Teste de giro no ponto (gôndola)">Teste de giro no ponto (gôndola)</SelectItem>
                  <SelectItem value="Evento / inauguração">Evento / inauguração</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Retorno para fechar (vira o próximo contato do lead)</Label><Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></div>
            <div><Label className="text-xs">Observação</Label><Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} placeholder="Ex.: dono quer provar os 350 ml antes do primeiro pedido" /></div>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-[11px] text-amber-900 dark:text-amber-200 space-y-0.5">
            <div className="font-semibold">Como esse pedido é tratado</div>
            <div>• Gera um pedido de amostra ligado ao lead, não a um cliente.</div>
            <div>• Não vira cliente ativo, não fatura, não conta comissão nem positivação.</div>
            <div>• Vai para aprovação do administrativo. O lead ganha retorno agendado na data acima.</div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button className="bg-violet-600 hover:bg-violet-700 text-white" disabled={salvando || !itens.length} onClick={enviar} data-testid="button-enviar-amostra">
            {salvando ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Enviando…</> : `Enviar pedido (${totalUn} un.)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogDegustacao({ amostra, onClose, onSaved }: { amostra: Amostra; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [resultado, setResultado] = useState<string>("");
  const [obs, setObs] = useState("");
  const [salvando, setSalvando] = useState(false);
  const salvar = async () => {
    if (!resultado) { toast({ title: "Escolha como foi a degustação", variant: "destructive" }); return; }
    setSalvando(true);
    try {
      const d: any = await apiRequest("POST", `/api/amostras/${amostra.id}/degustacao`, { resultado, observacao: obs });
      if (d?.ok) { toast({ title: "Degustação registrada", description: resultado === "gostou" ? "Boa! Agora é converter o lead em cliente." : "Registrado no histórico do lead." }); onSaved(); }
      else toast({ title: "Não foi possível", description: d?.message, variant: "destructive" });
    } catch (e: any) { toast({ title: "Erro", description: e?.message, variant: "destructive" }); }
    finally { setSalvando(false); }
  };
  const Op = ({ v, label }: { v: string; label: string }) => (
    <Button type="button" variant="outline" className={`h-11 ${resultado === v ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30" : ""}`} onClick={() => setResultado(v)} data-testid={`degust-${v}`}>{label}</Button>
  );
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader><DialogTitle>Como foi a degustação?</DialogTitle><DialogDescription>Amostra #A-{amostra.id} · {amostra.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2"><Op v="gostou" label="Gostou" /><Op v="pensar" label="Vai pensar" /><Op v="nao_gostou" label="Não gostou" /></div>
          <div><Label className="text-xs">Observação (opcional)</Label><Input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: gostou do maracujá, achou a limonada ácida" /></div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button className="bg-violet-600 hover:bg-violet-700 text-white" disabled={salvando} onClick={salvar}>{salvando ? "Salvando…" : "Salvar degustação"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
