// =============================================================================
//  INTEGRA 2.0 — "Solicitar Alteração" (controle de card + modal)
//  Mostra, na barra de ícones de cada card (presencial, virtual, repescagem,
//  lead), um dos três estados:
//    - sem solicitação            -> botão "Solicitar Alteração" (abre o modal)
//    - solicitação pendente       -> selo "⏳ Pendente" (bloqueia nova; abre p/ ver)
//    - solicitação resolvida      -> selo do resultado (Efetuadas / Parcial /
//                                    Rejeitadas); clique mostra a nota e permite
//                                    abrir uma NOVA solicitação.
//  A busca de estados é feita 1x por página via useChangeRequestStates().
//  Fase 1: campo "Outro" é texto (áudio transcrito entra na Fase 2).
// =============================================================================
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ClipboardList, Hourglass, CheckCircle2, AlertTriangle, XCircle, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Tipos e rótulos
// ---------------------------------------------------------------------------
export type EntityType = "customer" | "lead" | "repescagem";

export interface ChangeRequestState {
  id: string;
  entityType: EntityType;
  entityId: string;
  types: string[];
  details: any;
  status: "pending" | "efetuadas" | "parcial" | "rejeitadas";
  requestedByName?: string;
  resolvedByName?: string;
  resolutionNote?: string | null;
  createdAt?: string;
  resolvedAt?: string;
}

const TYPE_DEFS: { key: string; label: string }[] = [
  { key: "periodicidade", label: "Periodicidade" },
  { key: "dia_rota", label: "Dia de Rota" },
  { key: "area_vendas", label: "Área de vendas" },
  { key: "inicio_atendimento", label: "Início de atendimento" },
  { key: "inativar", label: "Inativar" },
  { key: "outro", label: "Outro" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_DEFS.map((t) => [t.key, t.label]));
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex"];

const RESULT_META: Record<string, { label: string; cls: string; Icon: any }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300 hover:bg-green-200", Icon: CheckCircle2 },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200", Icon: AlertTriangle },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-200", Icon: XCircle },
};

// ---------------------------------------------------------------------------
// Hook: 1 query por página para o mapa de estados. keys = "customer:ID" etc.
// ---------------------------------------------------------------------------
export function useChangeRequestStates(keys: string[]): Record<string, ChangeRequestState> {
  const uniq = useMemo(() => Array.from(new Set(keys.filter(Boolean))).sort(), [keys.join("|")]);
  const keysParam = uniq.join(",");
  const { data } = useQuery<Record<string, ChangeRequestState>>({
    queryKey: ["/api/change-requests/states", keysParam],
    queryFn: async () => {
      if (!keysParam) return {};
      const r = await fetch(`/api/change-requests/states?keys=${encodeURIComponent(keysParam)}`, { credentials: "include" });
      if (!r.ok) return {};
      return r.json();
    },
    enabled: !!keysParam,
    staleTime: 30_000,
  });
  return data || {};
}

export const crKey = (entityType: EntityType, entityId: string) => `${entityType}:${entityId}`;

// ---------------------------------------------------------------------------
// Controle por card
// ---------------------------------------------------------------------------
interface ControlProps {
  entityType: EntityType;
  entityId: string;
  customerId?: string | null;
  entityName?: string | null;
  sellerId?: string | null;
  sellerName?: string | null;
  state?: ChangeRequestState;
  className?: string;
  /** quando true, o gatilho vai para uma linha própria (abaixo dos ícones), alinhado à direita */
  fullRow?: boolean;
}

export function ChangeRequestControl(props: ControlProps) {
  const { entityType, entityId, customerId, entityName, sellerId, sellerName, state, className, fullRow } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);

  // Estado do formulário
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [periodicidade, setPeriodicidade] = useState<string>("");
  const [diaRota, setDiaRota] = useState<Set<string>>(new Set());
  const [areaVendas, setAreaVendas] = useState<string>("");
  const [inicioAtendimento, setInicioAtendimento] = useState<string>("");
  const [outro, setOutro] = useState<string>("");

  const resetForm = () => {
    setSelected(new Set()); setPeriodicidade(""); setDiaRota(new Set());
    setAreaVendas(""); setInicioAtendimento(""); setOutro("");
  };

  const toggleType = (k: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const toggleDia = (d: string) => {
    setDiaRota((prev) => {
      const n = new Set(prev);
      n.has(d) ? n.delete(d) : n.add(d);
      return n;
    });
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const details: any = {};
      if (selected.has("periodicidade") && periodicidade) details.periodicidade = periodicidade;
      if (selected.has("dia_rota")) details.diaRota = Array.from(diaRota);
      if (selected.has("area_vendas") && areaVendas) details.areaVendas = areaVendas;
      if (selected.has("inicio_atendimento") && inicioAtendimento) details.inicioAtendimento = inicioAtendimento;
      if (selected.has("outro") && outro.trim()) details.outro = outro.trim();
      return apiRequest("POST", "/api/change-requests", {
        entityType, entityId, customerId: customerId || null, entityName: entityName || null,
        sellerId: sellerId || null, sellerName: sellerName || null,
        types: Array.from(selected), details,
      });
    },
    onSuccess: () => {
      toast({ title: "Solicitação enviada", description: "O admin foi notificado na caixa de solicitações." });
      setOpen(false); resetForm();
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => {
      toast({ title: "Não foi possível enviar", description: e?.message || "Tente novamente.", variant: "destructive" });
    },
  });

  const canSubmit = selected.size > 0 && !createMut.isPending;

  // Validação leve: se marcou um tipo com sub-opção, exige a sub-opção.
  const missingSub =
    (selected.has("periodicidade") && !periodicidade) ||
    (selected.has("dia_rota") && diaRota.size === 0) ||
    (selected.has("area_vendas") && !areaVendas) ||
    (selected.has("inicio_atendimento") && !inicioAtendimento) ||
    (selected.has("outro") && !outro.trim());

  const stop = (e: any) => e.stopPropagation();

  // ---- Render do gatilho (botão ou selo) ----
  let trigger: JSX.Element;
  if (state?.status === "pending") {
    trigger = (
      <Badge
        variant="outline"
        className={`cursor-pointer bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 gap-1 ${className || ""}`}
        title={`Solicitação pendente: ${(state.types || []).map((t) => TYPE_LABEL[t] || t).join(", ")}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-pending-${entityId}`}
      >
        <Hourglass className="h-3 w-3" /> Pendente
      </Badge>
    );
  } else if (state && RESULT_META[state.status]) {
    const m = RESULT_META[state.status];
    trigger = (
      <Badge
        variant="outline"
        className={`cursor-pointer gap-1 ${m.cls} ${className || ""}`}
        title={`Alterações ${m.label}${state.resolutionNote ? " — " + state.resolutionNote : ""}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-result-${entityId}`}
      >
        <m.Icon className="h-3 w-3" /> {m.label}
      </Badge>
    );
  } else {
    trigger = (
      <Button
        size="sm"
        variant="outline"
        className={`h-7 gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800 ${className || ""}`}
        onClick={(e) => { stop(e); setOpen(true); }}
        title="Solicitar Alteração"
        data-testid={`button-cr-open-${entityId}`}
      >
        <ClipboardList className="h-3.5 w-3.5" /> Solicitar Alteração
      </Button>
    );
  }

  return (
    <>
      {fullRow ? <div className="basis-full w-full flex justify-end mt-1">{trigger}</div> : trigger}

      {/* Modal de nova solicitação */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-md" onClick={stop}>
          <DialogHeader>
            <DialogTitle>Solicitar Alteração</DialogTitle>
            <DialogDescription>
              {entityName ? entityName : "Cadastro"} — marque um ou mais tipos de alteração.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {TYPE_DEFS.map((t) => (
              <div key={t.key} className="rounded-md border p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={selected.has(t.key)} onCheckedChange={() => toggleType(t.key)} data-testid={`cr-type-${t.key}`} />
                  <span className="font-medium text-sm">{t.label}</span>
                </label>

                {selected.has("periodicidade") && t.key === "periodicidade" && (
                  <RadioGroup value={periodicidade} onValueChange={setPeriodicidade} className="mt-2 ml-6 flex flex-col gap-1">
                    {[["mensal", "Mensal"], ["quinzenal", "Quinzenal"], ["semanal", "Semanal"]].map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                        <RadioGroupItem value={v} /> {l}
                      </label>
                    ))}
                  </RadioGroup>
                )}

                {selected.has("dia_rota") && t.key === "dia_rota" && (
                  <div className="mt-2 ml-6 flex flex-wrap gap-3">
                    {DIAS.map((d) => (
                      <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <Checkbox checked={diaRota.has(d)} onCheckedChange={() => toggleDia(d)} /> {d}
                      </label>
                    ))}
                  </div>
                )}

                {selected.has("area_vendas") && t.key === "area_vendas" && (
                  <RadioGroup value={areaVendas} onValueChange={setAreaVendas} className="mt-2 ml-6 flex gap-4">
                    {[["interno", "Interno"], ["externo", "Externo"]].map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                        <RadioGroupItem value={v} /> {l}
                      </label>
                    ))}
                  </RadioGroup>
                )}

                {selected.has("inicio_atendimento") && t.key === "inicio_atendimento" && (
                  <div className="mt-2 ml-6">
                    <input
                      type="date"
                      value={inicioAtendimento}
                      onChange={(e) => setInicioAtendimento(e.target.value)}
                      className="border rounded-md px-2 py-1 text-sm"
                      data-testid="cr-inicio-data"
                    />
                  </div>
                )}

                {selected.has("outro") && t.key === "outro" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={outro}
                      onChange={(e) => setOutro(e.target.value)}
                      placeholder="Descreva a alteração desejada…"
                      rows={3}
                      data-testid="cr-outro-texto"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>Cancelar</Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={!canSubmit || missingSub}
              data-testid="cr-submit"
            >
              {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar solicitação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal de visualização (pendente ou resolvida) */}
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="max-w-md" onClick={stop}>
          <DialogHeader>
            <DialogTitle>Solicitação de Alteração</DialogTitle>
            <DialogDescription>{entityName || "Cadastro"}</DialogDescription>
          </DialogHeader>
          {state && (
            <div className="space-y-2 text-sm">
              <div><span className="text-muted-foreground">Tipos: </span>{(state.types || []).map((t) => TYPE_LABEL[t] || t).join(", ")}</div>
              {state.details && Object.keys(state.details).length > 0 && (
                <div className="rounded-md bg-muted p-2 text-xs">
                  {state.details.periodicidade && <div>Periodicidade: {state.details.periodicidade}</div>}
                  {Array.isArray(state.details.diaRota) && state.details.diaRota.length > 0 && <div>Dias: {state.details.diaRota.join(", ")}</div>}
                  {state.details.areaVendas && <div>Área de vendas: {state.details.areaVendas}</div>}
                  {state.details.inicioAtendimento && <div>Início de atendimento: {state.details.inicioAtendimento}</div>}
                  {state.details.outro && <div>Outro: {state.details.outro}</div>}
                </div>
              )}
              {state.requestedByName && <div className="text-muted-foreground">Solicitado por {state.requestedByName}</div>}
              {state.status === "pending" ? (
                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300 gap-1"><Hourglass className="h-3 w-3" /> Aguardando o admin</Badge>
              ) : (
                <div className="space-y-1">
                  <Badge variant="outline" className={`gap-1 ${RESULT_META[state.status]?.cls || ""}`}>
                    Alterações {RESULT_META[state.status]?.label}
                  </Badge>
                  {state.resolutionNote && <div className="text-xs">Obs.: {state.resolutionNote}</div>}
                  {state.resolvedByName && <div className="text-muted-foreground text-xs">Resolvido por {state.resolvedByName}</div>}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {state?.status !== "pending" && (
              <Button onClick={() => { setViewOpen(false); setOpen(true); }} data-testid="cr-new-from-view">Nova solicitação</Button>
            )}
            <Button variant="outline" onClick={() => setViewOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
