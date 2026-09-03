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
import { useMemo, useState, useRef } from "react";
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
import { ClipboardList, Hourglass, CheckCircle2, AlertTriangle, XCircle, Loader2, Mic, Square, Bell } from "lucide-react";

// ---------------------------------------------------------------------------
// Tipos e rótulos
// ---------------------------------------------------------------------------
export type EntityType = "customer" | "lead" | "repescagem";

export interface CRMessage {
  id?: string;
  role: "seller" | "admin";
  byName?: string;
  text: string;
  at?: string;
  kind?: string;
  status?: string;
}

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
  messages?: CRMessage[];
  createdAt?: string;
  resolvedAt?: string;
}

const TYPE_DEFS: { key: string; label: string }[] = [
  { key: "periodicidade", label: "Periodicidade" },
  { key: "dia_rota", label: "Dia de Rota" },
  { key: "area_vendas", label: "Área de vendas" },
  { key: "presencial_virtual", label: "Presencial/Virtual" },
  { key: "inicio_atendimento", label: "Início de atendimento" },
  { key: "inativar", label: "Inativar" },
  { key: "outro", label: "Outro" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_DEFS.map((t) => [t.key, t.label]));

// ---------------------------------------------------------------------------
// Regra (30/jul/2026): quando a solicitação é APENAS de modalidade
// (Presencial↔Virtual), o card permanece ATIVO na rota mesmo após "Efetuada" —
// o cliente continua sendo atendido, só muda o canal (presencial/virtual). As
// demais alterações seguem a regra normal (Efetuada → card recolhido/travado).
export function isModalidadeOnlyRequest(state?: { types?: string[]; details?: any } | null): boolean {
  if (!state) return false;
  const types = Array.isArray(state.types) ? state.types.filter(Boolean) : [];
  if (types.length !== 1) return false;
  if (types[0] === "presencial_virtual") return true;
  // Compatibilidade: solicitações antigas feitas via "Outro" cujo texto é exatamente
  // "Virtual" ou "Presencial" (ex.: GRUPO LIMA) também contam como troca de modalidade.
  if (types[0] === "outro") {
    const v = String(state?.details?.outro || "").trim().toLowerCase();
    return v === "virtual" || v === "presencial";
  }
  return false;
}
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex"];

const RESULT_META: Record<string, { label: string; cls: string; Icon: any }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300 hover:bg-green-200", Icon: CheckCircle2 },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200", Icon: AlertTriangle },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-200", Icon: XCircle },
};

const fmtWhen = (s?: string) => {
  if (!s) return "";
  try { return new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};

// 💬 Histórico de conversa (vendedor ⇄ admin).
export function MessageThread({ messages }: { messages?: CRMessage[] }) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return null;
  return (
    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
      {list.map((m, i) => {
        const admin = m.role === "admin";
        return (
          <div key={m.id || i} className={`flex ${admin ? "justify-start" : "justify-end"}`}>
            <div className={`rounded-lg px-2.5 py-1.5 text-xs max-w-[85%] ${admin ? "bg-indigo-50 text-indigo-900 border border-indigo-200" : "bg-emerald-50 text-emerald-900 border border-emerald-200"}`}>
              <div className="font-semibold text-[10px] opacity-80 mb-0.5">
                {admin ? "Admin" : "Vendedor"}{m.byName ? ` · ${m.byName}` : ""}{m.at ? ` · ${fmtWhen(m.at)}` : ""}
              </div>
              <div className="whitespace-pre-wrap break-words">{m.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: 1 query por página para o mapa de estados. keys = "customer:ID" etc.
// ---------------------------------------------------------------------------
export function useChangeRequestStates(keys: string[], date?: string): Record<string, ChangeRequestState> {
  const uniq = useMemo(() => Array.from(new Set(keys.filter(Boolean))).sort(), [keys.join("|")]);
  const keysParam = uniq.join(",");
  const dateParam = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : "";
  const { data } = useQuery<Record<string, ChangeRequestState>>({
    queryKey: ["/api/change-requests/states", keysParam, dateParam],
    queryFn: async () => {
      if (!keysParam) return {};
      const r = await fetch(`/api/change-requests/states?keys=${encodeURIComponent(keysParam)}${dateParam ? `&date=${dateParam}` : ""}`, { credentials: "include" });
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
  /** quando true, o botão de nova solicitação fica desabilitado (ex.: já há check-in/venda no dia) */
  disabled?: boolean;
  /** Texto do Registro de Atendimento a enviar JUNTO com a solicitação (embutido no campo "Outro").
   *  Quando presente, a solicitação pode ser enviada só com o registro (sem marcar nenhum tipo). */
  attachedNote?: string | null;
}

export function ChangeRequestControl(props: ControlProps) {
  const { entityType, entityId, customerId, entityName, sellerId, sellerName, state, className, fullRow, disabled, attachedNote } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);

  // Estado do formulário
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [periodicidade, setPeriodicidade] = useState<string>("");
  const [diaRota, setDiaRota] = useState<Set<string>>(new Set());
  const [areaVendas, setAreaVendas] = useState<string>("");
  const [modalidade, setModalidade] = useState<string>("");
  const [inicioAtendimento, setInicioAtendimento] = useState<string>("");
  const [outro, setOutro] = useState<string>("");
  const [inativarTexto, setInativarTexto] = useState<string>("");

  // 💬 Resposta/reenvio da conversa (vendedor).
  const [replyText, setReplyText] = useState<string>("");

  // Fase 2: gravação de áudio transcrito (Whisper) para o campo "Outro".
  const [recording, setRecording] = useState(false);
  const [recordTarget, setRecordTarget] = useState<"outro" | "inativar">("outro");
  const recordTargetRef = useRef<"outro" | "inativar">("outro");
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startRecording = async (target: "outro" | "inativar" = "outro") => {
    recordTargetRef.current = target;
    setRecordTarget(target);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach((tk) => tk.stop()); } catch {}
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || "audio/webm" });
        const dataUrl: string = await new Promise((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result)); r.readAsDataURL(blob); });
        setTranscribing(true);
        try {
          const resp = await apiRequest("POST", "/api/change-requests/transcribe", { audio: dataUrl });
          if (resp?.text) {
            const add = (prev: string) => (prev ? prev.trim() + " " : "") + resp.text;
            if (recordTargetRef.current === "inativar") setInativarTexto(add); else setOutro(add);
          }
          else toast({ title: "Nada transcrito", description: "Não consegui entender o áudio. Tente de novo." });
        } catch (e: any) {
          toast({ title: "Falha na transcrição", description: e?.message || "Tente novamente.", variant: "destructive" });
        } finally { setTranscribing(false); }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e: any) {
      toast({ title: "Microfone indisponível", description: e?.message || "Permita o acesso ao microfone.", variant: "destructive" });
    }
  };
  const stopRecording = () => { try { mediaRecorderRef.current?.stop(); } catch {} setRecording(false); };

  const resetForm = () => {
    setSelected(new Set()); setPeriodicidade(""); setDiaRota(new Set());
    setAreaVendas(""); setModalidade(""); setInicioAtendimento(""); setOutro(""); setInativarTexto("");
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
      if (selected.has("presencial_virtual") && modalidade) details.modalidade = modalidade;
      if (selected.has("inicio_atendimento") && inicioAtendimento) details.inicioAtendimento = inicioAtendimento;
      if (selected.has("inativar") && inativarTexto.trim()) details.inativar = inativarTexto.trim();
      if (selected.has("outro") && outro.trim()) details.outro = outro.trim();
      // 📋 Registro de Atendimento anexado (do modal de Atendimentos Virtuais): vai JUNTO com a
      // solicitação, embutido no campo "Outro" (único campo de texto livre persistido/exibido ao
      // admin). Garante que o tipo "outro" entre nos tipos para o backend gravar o texto.
      const submitTypes = new Set(selected);
      const _reg = String(attachedNote || "").trim();
      if (_reg) {
        submitTypes.add("outro");
        const _own = details.outro ? details.outro + "\n\n" : "";
        details.outro = (_own + "📋 Registro de atendimento:\n" + _reg).slice(0, 4000);
      }
      return apiRequest("POST", "/api/change-requests", {
        entityType, entityId, customerId: customerId || null, entityName: entityName || null,
        sellerId: sellerId || null, sellerName: sellerName || null,
        types: Array.from(submitTypes), details,
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

  // 💬 Reenvio: registra a mensagem do vendedor e REABRE a solicitação (volta ao admin).
  const replyMut = useMutation({
    mutationFn: async () => {
      if (!state?.id) throw new Error("Solicitação inválida");
      return apiRequest("POST", `/api/change-requests/${state.id}/reply`, { text: replyText.trim(), resend: true });
    },
    onSuccess: () => {
      toast({ title: "Solicitação reenviada", description: "O admin foi notificado na caixa de solicitações." });
      setReplyText(""); setViewOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível reenviar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });

  const hasAttachedNote = !!String(attachedNote || "").trim();
  const canSubmit = (selected.size > 0 || hasAttachedNote) && !createMut.isPending;

  // Validação leve: se marcou um tipo com sub-opção, exige a sub-opção.
  const missingSub =
    (selected.has("periodicidade") && !periodicidade) ||
    (selected.has("dia_rota") && diaRota.size === 0) ||
    (selected.has("area_vendas") && !areaVendas) ||
    (selected.has("presencial_virtual") && !modalidade) ||
    (selected.has("inicio_atendimento") && !inicioAtendimento) ||
    (selected.has("outro") && !outro.trim());

  const stop = (e: any) => e.stopPropagation();

  // ---- Render do gatilho ----
  // Regra (05/08/2026): o botão "Solicitar Alteração" fica SEMPRE disponível em todos os cards,
  // mesmo os que já têm solicitação ou registro de atendimento (check-in/venda). Quando há uma
  // solicitação, mostramos também o selo de status (Pendente/Efetuada/Parcial/Rejeitada + sino).
  let statusBadge: JSX.Element | null = null;
  if (state?.status === "pending") {
    statusBadge = (
      <Badge
        variant="outline"
        className="cursor-pointer bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5"
        title={`Solicitação pendente: ${(state.types || []).map((t) => TYPE_LABEL[t] || t).join(", ")}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-pending-${entityId}`}
      >
        <Hourglass className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Pendente
      </Badge>
    );
  } else if (state && RESULT_META[state.status]) {
    const m = RESULT_META[state.status];
    statusBadge = (
      <Badge
        variant="outline"
        className={`cursor-pointer gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5 ${m.cls}`}
        title={`Alterações ${m.label}${state.resolutionNote ? " — " + state.resolutionNote : ""}${(state.status === "parcial" || state.status === "rejeitadas") ? " · há retorno do admin a responder" : ""}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-result-${entityId}`}
      >
        <m.Icon className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> {m.label}
        {/* 🔔 Retorno do admin (Parcial/Rejeitada) a ser respondido no card. (04/08/2026) */}
        {(state.status === "parcial" || state.status === "rejeitadas") && (
          <Bell className="h-2.5 w-2.5 sm:h-3 sm:w-3 ml-0.5 animate-pulse" data-testid={`badge-cr-bell-${entityId}`} />
        )}
      </Badge>
    );
  }
  const trigger: JSX.Element = (
    <div className={`flex items-center gap-2 flex-wrap justify-end ${className || ""}`}>
      {statusBadge}
      <Button
        size="sm"
        variant="outline"
        className="h-6 sm:h-7 px-2 sm:px-3 text-[11px] sm:text-sm gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800"
        onClick={(e) => { stop(e); setOpen(true); }}
        title="Solicitar Alteração"
        data-testid={`button-cr-open-${entityId}`}
      >
        <ClipboardList className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> Solicitar Alteração
      </Button>
    </div>
  );

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
            {hasAttachedNote && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-900">
                <div className="font-semibold mb-1 flex items-center gap-1">
                  <ClipboardList className="h-3.5 w-3.5" /> Registro de atendimento (será enviado junto)
                </div>
                <div className="whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{String(attachedNote).trim()}</div>
              </div>
            )}
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

                {selected.has("presencial_virtual") && t.key === "presencial_virtual" && (
                  <RadioGroup value={modalidade} onValueChange={setModalidade} className="mt-2 ml-6 flex gap-4">
                    {[["presencial", "Presencial"], ["virtual", "Virtual"]].map(([v, l]) => (
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

                {selected.has("inativar") && t.key === "inativar" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={inativarTexto}
                      onChange={(e) => setInativarTexto(e.target.value)}
                      placeholder="Descreva o motivo da inativação… (ou grave um áudio) (opcional)"
                      rows={3}
                      data-testid="cr-inativar-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "inativar") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("inativar"); }} disabled={transcribing} data-testid="cr-inativar-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-inativar-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "inativar" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "inativar" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
                  </div>
                )}

                {selected.has("outro") && t.key === "outro" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={outro}
                      onChange={(e) => setOutro(e.target.value)}
                      placeholder="Descreva a alteração desejada… (ou grave um áudio)"
                      rows={3}
                      data-testid="cr-outro-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "outro") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("outro"); }} disabled={transcribing} data-testid="cr-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "outro" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "outro" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
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
                  {state.details.modalidade && <div>Modalidade: {state.details.modalidade === "virtual" ? "Virtual" : "Presencial"}</div>}
                  {state.details.inicioAtendimento && <div>Início de atendimento: {state.details.inicioAtendimento}</div>}
                  {state.details.inativar && <div>Inativar: {state.details.inativar}</div>}
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
                  {state.resolvedByName && <div className="text-muted-foreground text-xs">Resolvido por {state.resolvedByName}</div>}
                </div>
              )}

              {/* 💬 Histórico da conversa (vendedor ⇄ admin) */}
              {Array.isArray(state.messages) && state.messages.length > 0 && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
                  <MessageThread messages={state.messages} />
                </div>
              )}

              {/* 📌 Fallback: solicitações antigas (sem histórico) — mostra o motivo do admin */}
              {state.status !== "pending" && (!Array.isArray(state.messages) || state.messages.length === 0) && state.resolutionNote && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Resposta do admin</div>
                  <div className="rounded-lg px-2.5 py-1.5 text-xs bg-indigo-50 text-indigo-900 border border-indigo-200 whitespace-pre-wrap break-words">
                    {state.resolutionNote}
                  </div>
                </div>
              )}

              {/* ↩️ Reenvio: só para Parcial/Rejeitadas — o vendedor devolve ao admin */}
              {(state.status === "parcial" || state.status === "rejeitadas") && (
                <div className="pt-2 mt-1 border-t space-y-2">
                  <div className="text-[11px] font-semibold text-muted-foreground">Reenviar solicitação ao admin</div>
                  <Textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Escreva um retorno (ex.: motivo para reconsiderar)…"
                    rows={2}
                    data-testid="cr-reply-text"
                  />
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={replyMut.isPending || !replyText.trim()}
                    onClick={() => replyMut.mutate()}
                    data-testid="cr-reply-resend"
                  >
                    {replyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reenviar ao admin"}
                  </Button>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {state?.status !== "pending" && (
              <Button variant="outline" onClick={() => { setViewOpen(false); setOpen(true); }} data-testid="cr-new-from-view">Nova solicitação</Button>
            )}
            <Button variant="outline" onClick={() => setViewOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
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
import { useMemo, useState, useRef } from "react";
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
import { ClipboardList, Hourglass, CheckCircle2, AlertTriangle, XCircle, Loader2, Mic, Square, Bell } from "lucide-react";

// ---------------------------------------------------------------------------
// Tipos e rótulos
// ---------------------------------------------------------------------------
export type EntityType = "customer" | "lead" | "repescagem";

export interface CRMessage {
  id?: string;
  role: "seller" | "admin";
  byName?: string;
  text: string;
  at?: string;
  kind?: string;
  status?: string;
}

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
  messages?: CRMessage[];
  createdAt?: string;
  resolvedAt?: string;
}

const TYPE_DEFS: { key: string; label: string }[] = [
  { key: "periodicidade", label: "Periodicidade" },
  { key: "dia_rota", label: "Dia de Rota" },
  { key: "area_vendas", label: "Área de vendas" },
  { key: "presencial_virtual", label: "Presencial/Virtual" },
  { key: "inicio_atendimento", label: "Início de atendimento" },
  { key: "inativar", label: "Inativar" },
  { key: "outro", label: "Outro" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_DEFS.map((t) => [t.key, t.label]));

// ---------------------------------------------------------------------------
// Regra (30/jul/2026): quando a solicitação é APENAS de modalidade
// (Presencial↔Virtual), o card permanece ATIVO na rota mesmo após "Efetuada" —
// o cliente continua sendo atendido, só muda o canal (presencial/virtual). As
// demais alterações seguem a regra normal (Efetuada → card recolhido/travado).
export function isModalidadeOnlyRequest(state?: { types?: string[]; details?: any } | null): boolean {
  if (!state) return false;
  const types = Array.isArray(state.types) ? state.types.filter(Boolean) : [];
  if (types.length !== 1) return false;
  if (types[0] === "presencial_virtual") return true;
  // Compatibilidade: solicitações antigas feitas via "Outro" cujo texto é exatamente
  // "Virtual" ou "Presencial" (ex.: GRUPO LIMA) também contam como troca de modalidade.
  if (types[0] === "outro") {
    const v = String(state?.details?.outro || "").trim().toLowerCase();
    return v === "virtual" || v === "presencial";
  }
  return false;
}
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex"];

const RESULT_META: Record<string, { label: string; cls: string; Icon: any }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300 hover:bg-green-200", Icon: CheckCircle2 },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200", Icon: AlertTriangle },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-200", Icon: XCircle },
};

const fmtWhen = (s?: string) => {
  if (!s) return "";
  try { return new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};

// 💬 Histórico de conversa (vendedor ⇄ admin).
export function MessageThread({ messages }: { messages?: CRMessage[] }) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return null;
  return (
    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
      {list.map((m, i) => {
        const admin = m.role === "admin";
        return (
          <div key={m.id || i} className={`flex ${admin ? "justify-start" : "justify-end"}`}>
            <div className={`rounded-lg px-2.5 py-1.5 text-xs max-w-[85%] ${admin ? "bg-indigo-50 text-indigo-900 border border-indigo-200" : "bg-emerald-50 text-emerald-900 border border-emerald-200"}`}>
              <div className="font-semibold text-[10px] opacity-80 mb-0.5">
                {admin ? "Admin" : "Vendedor"}{m.byName ? ` · ${m.byName}` : ""}{m.at ? ` · ${fmtWhen(m.at)}` : ""}
              </div>
              <div className="whitespace-pre-wrap break-words">{m.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: 1 query por página para o mapa de estados. keys = "customer:ID" etc.
// ---------------------------------------------------------------------------
export function useChangeRequestStates(keys: string[], date?: string): Record<string, ChangeRequestState> {
  const uniq = useMemo(() => Array.from(new Set(keys.filter(Boolean))).sort(), [keys.join("|")]);
  const keysParam = uniq.join(",");
  const dateParam = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : "";
  const { data } = useQuery<Record<string, ChangeRequestState>>({
    queryKey: ["/api/change-requests/states", keysParam, dateParam],
    queryFn: async () => {
      if (!keysParam) return {};
      const r = await fetch(`/api/change-requests/states?keys=${encodeURIComponent(keysParam)}${dateParam ? `&date=${dateParam}` : ""}`, { credentials: "include" });
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
  /** quando true, o botão de nova solicitação fica desabilitado (ex.: já há check-in/venda no dia) */
  disabled?: boolean;
  /** Texto do Registro de Atendimento a enviar JUNTO com a solicitação (embutido no campo "Outro").
   *  Quando presente, a solicitação pode ser enviada só com o registro (sem marcar nenhum tipo). */
  attachedNote?: string | null;
}

export function ChangeRequestControl(props: ControlProps) {
  const { entityType, entityId, customerId, entityName, sellerId, sellerName, state, className, fullRow, disabled, attachedNote } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);

  // Estado do formulário
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [periodicidade, setPeriodicidade] = useState<string>("");
  const [diaRota, setDiaRota] = useState<Set<string>>(new Set());
  const [areaVendas, setAreaVendas] = useState<string>("");
  const [modalidade, setModalidade] = useState<string>("");
  const [inicioAtendimento, setInicioAtendimento] = useState<string>("");
  const [outro, setOutro] = useState<string>("");
  const [inativarTexto, setInativarTexto] = useState<string>("");

  // 💬 Resposta/reenvio da conversa (vendedor).
  const [replyText, setReplyText] = useState<string>("");

  // Fase 2: gravação de áudio transcrito (Whisper) para o campo "Outro".
  const [recording, setRecording] = useState(false);
  const [recordTarget, setRecordTarget] = useState<"outro" | "inativar">("outro");
  const recordTargetRef = useRef<"outro" | "inativar">("outro");
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startRecording = async (target: "outro" | "inativar" = "outro") => {
    recordTargetRef.current = target;
    setRecordTarget(target);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach((tk) => tk.stop()); } catch {}
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || "audio/webm" });
        const dataUrl: string = await new Promise((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result)); r.readAsDataURL(blob); });
        setTranscribing(true);
        try {
          const resp = await apiRequest("POST", "/api/change-requests/transcribe", { audio: dataUrl });
          if (resp?.text) {
            const add = (prev: string) => (prev ? prev.trim() + " " : "") + resp.text;
            if (recordTargetRef.current === "inativar") setInativarTexto(add); else setOutro(add);
          }
          else toast({ title: "Nada transcrito", description: "Não consegui entender o áudio. Tente de novo." });
        } catch (e: any) {
          toast({ title: "Falha na transcrição", description: e?.message || "Tente novamente.", variant: "destructive" });
        } finally { setTranscribing(false); }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e: any) {
      toast({ title: "Microfone indisponível", description: e?.message || "Permita o acesso ao microfone.", variant: "destructive" });
    }
  };
  const stopRecording = () => { try { mediaRecorderRef.current?.stop(); } catch {} setRecording(false); };

  const resetForm = () => {
    setSelected(new Set()); setPeriodicidade(""); setDiaRota(new Set());
    setAreaVendas(""); setModalidade(""); setInicioAtendimento(""); setOutro(""); setInativarTexto("");
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
      if (selected.has("presencial_virtual") && modalidade) details.modalidade = modalidade;
      if (selected.has("inicio_atendimento") && inicioAtendimento) details.inicioAtendimento = inicioAtendimento;
      if (selected.has("inativar") && inativarTexto.trim()) details.inativar = inativarTexto.trim();
      if (selected.has("outro") && outro.trim()) details.outro = outro.trim();
      // 📋 Registro de Atendimento anexado (do modal de Atendimentos Virtuais): vai JUNTO com a
      // solicitação, embutido no campo "Outro" (único campo de texto livre persistido/exibido ao
      // admin). Garante que o tipo "outro" entre nos tipos para o backend gravar o texto.
      const submitTypes = new Set(selected);
      const _reg = String(attachedNote || "").trim();
      if (_reg) {
        submitTypes.add("outro");
        const _own = details.outro ? details.outro + "\n\n" : "";
        details.outro = (_own + "📋 Registro de atendimento:\n" + _reg).slice(0, 4000);
      }
      return apiRequest("POST", "/api/change-requests", {
        entityType, entityId, customerId: customerId || null, entityName: entityName || null,
        sellerId: sellerId || null, sellerName: sellerName || null,
        types: Array.from(submitTypes), details,
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

  // 💬 Reenvio: registra a mensagem do vendedor e REABRE a solicitação (volta ao admin).
  const replyMut = useMutation({
    mutationFn: async () => {
      if (!state?.id) throw new Error("Solicitação inválida");
      return apiRequest("POST", `/api/change-requests/${state.id}/reply`, { text: replyText.trim(), resend: true });
    },
    onSuccess: () => {
      toast({ title: "Solicitação reenviada", description: "O admin foi notificado na caixa de solicitações." });
      setReplyText(""); setViewOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível reenviar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });

  const hasAttachedNote = !!String(attachedNote || "").trim();
  const canSubmit = (selected.size > 0 || hasAttachedNote) && !createMut.isPending;

  // Validação leve: se marcou um tipo com sub-opção, exige a sub-opção.
  const missingSub =
    (selected.has("periodicidade") && !periodicidade) ||
    (selected.has("dia_rota") && diaRota.size === 0) ||
    (selected.has("area_vendas") && !areaVendas) ||
    (selected.has("presencial_virtual") && !modalidade) ||
    (selected.has("inicio_atendimento") && !inicioAtendimento) ||
    (selected.has("outro") && !outro.trim());

  const stop = (e: any) => e.stopPropagation();

  // ---- Render do gatilho ----
  // Regra (05/08/2026): o botão "Solicitar Alteração" fica SEMPRE disponível em todos os cards,
  // mesmo os que já têm solicitação ou registro de atendimento (check-in/venda). Quando há uma
  // solicitação, mostramos também o selo de status (Pendente/Efetuada/Parcial/Rejeitada + sino).
  let statusBadge: JSX.Element | null = null;
  if (state?.status === "pending") {
    statusBadge = (
      <Badge
        variant="outline"
        className="cursor-pointer bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5"
        title={`Solicitação pendente: ${(state.types || []).map((t) => TYPE_LABEL[t] || t).join(", ")}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-pending-${entityId}`}
      >
        <Hourglass className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Pendente
      </Badge>
    );
  } else if (state && RESULT_META[state.status]) {
    const m = RESULT_META[state.status];
    statusBadge = (
      <Badge
        variant="outline"
        className={`cursor-pointer gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5 ${m.cls}`}
        title={`Alterações ${m.label}${state.resolutionNote ? " — " + state.resolutionNote : ""}${(state.status === "parcial" || state.status === "rejeitadas") ? " · há retorno do admin a responder" : ""}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-result-${entityId}`}
      >
        <m.Icon className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> {m.label}
        {/* 🔔 Retorno do admin (Parcial/Rejeitada) a ser respondido no card. (04/08/2026) */}
        {(state.status === "parcial" || state.status === "rejeitadas") && (
          <Bell className="h-2.5 w-2.5 sm:h-3 sm:w-3 ml-0.5 animate-pulse" data-testid={`badge-cr-bell-${entityId}`} />
        )}
      </Badge>
    );
  }
  const trigger: JSX.Element = (
    <div className={`flex items-center gap-2 flex-wrap justify-end ${className || ""}`}>
      {statusBadge}
      <Button
        size="sm"
        variant="outline"
        className="h-6 sm:h-7 px-2 sm:px-3 text-[11px] sm:text-sm gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800"
        onClick={(e) => { stop(e); setOpen(true); }}
        title="Solicitar Alteração"
        data-testid={`button-cr-open-${entityId}`}
      >
        <ClipboardList className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> Solicitar Alteração
      </Button>
    </div>
  );

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
            {hasAttachedNote && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-900">
                <div className="font-semibold mb-1 flex items-center gap-1">
                  <ClipboardList className="h-3.5 w-3.5" /> Registro de atendimento (será enviado junto)
                </div>
                <div className="whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{String(attachedNote).trim()}</div>
              </div>
            )}
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

                {selected.has("presencial_virtual") && t.key === "presencial_virtual" && (
                  <RadioGroup value={modalidade} onValueChange={setModalidade} className="mt-2 ml-6 flex gap-4">
                    {[["presencial", "Presencial"], ["virtual", "Virtual"]].map(([v, l]) => (
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

                {selected.has("inativar") && t.key === "inativar" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={inativarTexto}
                      onChange={(e) => setInativarTexto(e.target.value)}
                      placeholder="Descreva o motivo da inativação… (ou grave um áudio) (opcional)"
                      rows={3}
                      data-testid="cr-inativar-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "inativar") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("inativar"); }} disabled={transcribing} data-testid="cr-inativar-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-inativar-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "inativar" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "inativar" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
                  </div>
                )}

                {selected.has("outro") && t.key === "outro" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={outro}
                      onChange={(e) => setOutro(e.target.value)}
                      placeholder="Descreva a alteração desejada… (ou grave um áudio)"
                      rows={3}
                      data-testid="cr-outro-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "outro") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("outro"); }} disabled={transcribing} data-testid="cr-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "outro" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "outro" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
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
                  {state.details.modalidade && <div>Modalidade: {state.details.modalidade === "virtual" ? "Virtual" : "Presencial"}</div>}
                  {state.details.inicioAtendimento && <div>Início de atendimento: {state.details.inicioAtendimento}</div>}
                  {state.details.inativar && <div>Inativar: {state.details.inativar}</div>}
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
                  {state.resolvedByName && <div className="text-muted-foreground text-xs">Resolvido por {state.resolvedByName}</div>}
                </div>
              )}

              {/* 💬 Histórico da conversa (vendedor ⇄ admin) */}
              {Array.isArray(state.messages) && state.messages.length > 0 && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
                  <MessageThread messages={state.messages} />
                </div>
              )}

              {/* 📌 Fallback: solicitações antigas (sem histórico) — mostra o motivo do admin */}
              {state.status !== "pending" && (!Array.isArray(state.messages) || state.messages.length === 0) && state.resolutionNote && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Resposta do admin</div>
                  <div className="rounded-lg px-2.5 py-1.5 text-xs bg-indigo-50 text-indigo-900 border border-indigo-200 whitespace-pre-wrap break-words">
                    {state.resolutionNote}
                  </div>
                </div>
              )}

              {/* ↩️ Reenvio: só para Parcial/Rejeitadas — o vendedor devolve ao admin */}
              {(state.status === "parcial" || state.status === "rejeitadas") && (
                <div className="pt-2 mt-1 border-t space-y-2">
                  <div className="text-[11px] font-semibold text-muted-foreground">Reenviar solicitação ao admin</div>
                  <Textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Escreva um retorno (ex.: motivo para reconsiderar)…"
                    rows={2}
                    data-testid="cr-reply-text"
                  />
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={replyMut.isPending || !replyText.trim()}
                    onClick={() => replyMut.mutate()}
                    data-testid="cr-reply-resend"
                  >
                    {replyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reenviar ao admin"}
                  </Button>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {state?.status !== "pending" && (
              <Button variant="outline" onClick={() => { setViewOpen(false); setOpen(true); }} data-testid="cr-new-from-view">Nova solicitação</Button>
            )}
            <Button variant="outline" onClick={() => setViewOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
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
import { useMemo, useState, useRef } from "react";
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
import { ClipboardList, Hourglass, CheckCircle2, AlertTriangle, XCircle, Loader2, Mic, Square, Bell } from "lucide-react";

// ---------------------------------------------------------------------------
// Tipos e rótulos
// ---------------------------------------------------------------------------
export type EntityType = "customer" | "lead" | "repescagem";

export interface CRMessage {
  id?: string;
  role: "seller" | "admin";
  byName?: string;
  text: string;
  at?: string;
  kind?: string;
  status?: string;
}

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
  messages?: CRMessage[];
  createdAt?: string;
  resolvedAt?: string;
}

const TYPE_DEFS: { key: string; label: string }[] = [
  { key: "periodicidade", label: "Periodicidade" },
  { key: "dia_rota", label: "Dia de Rota" },
  { key: "area_vendas", label: "Área de vendas" },
  { key: "presencial_virtual", label: "Presencial/Virtual" },
  { key: "inicio_atendimento", label: "Início de atendimento" },
  { key: "inativar", label: "Inativar" },
  { key: "outro", label: "Outro" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_DEFS.map((t) => [t.key, t.label]));

// ---------------------------------------------------------------------------
// Regra (30/jul/2026): quando a solicitação é APENAS de modalidade
// (Presencial↔Virtual), o card permanece ATIVO na rota mesmo após "Efetuada" —
// o cliente continua sendo atendido, só muda o canal (presencial/virtual). As
// demais alterações seguem a regra normal (Efetuada → card recolhido/travado).
export function isModalidadeOnlyRequest(state?: { types?: string[]; details?: any } | null): boolean {
  if (!state) return false;
  const types = Array.isArray(state.types) ? state.types.filter(Boolean) : [];
  if (types.length !== 1) return false;
  if (types[0] === "presencial_virtual") return true;
  // Compatibilidade: solicitações antigas feitas via "Outro" cujo texto é exatamente
  // "Virtual" ou "Presencial" (ex.: GRUPO LIMA) também contam como troca de modalidade.
  if (types[0] === "outro") {
    const v = String(state?.details?.outro || "").trim().toLowerCase();
    return v === "virtual" || v === "presencial";
  }
  return false;
}
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex"];

const RESULT_META: Record<string, { label: string; cls: string; Icon: any }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300 hover:bg-green-200", Icon: CheckCircle2 },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200", Icon: AlertTriangle },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-200", Icon: XCircle },
};

const fmtWhen = (s?: string) => {
  if (!s) return "";
  try { return new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};

// 💬 Histórico de conversa (vendedor ⇄ admin).
export function MessageThread({ messages }: { messages?: CRMessage[] }) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return null;
  return (
    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
      {list.map((m, i) => {
        const admin = m.role === "admin";
        return (
          <div key={m.id || i} className={`flex ${admin ? "justify-start" : "justify-end"}`}>
            <div className={`rounded-lg px-2.5 py-1.5 text-xs max-w-[85%] ${admin ? "bg-indigo-50 text-indigo-900 border border-indigo-200" : "bg-emerald-50 text-emerald-900 border border-emerald-200"}`}>
              <div className="font-semibold text-[10px] opacity-80 mb-0.5">
                {admin ? "Admin" : "Vendedor"}{m.byName ? ` · ${m.byName}` : ""}{m.at ? ` · ${fmtWhen(m.at)}` : ""}
              </div>
              <div className="whitespace-pre-wrap break-words">{m.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: 1 query por página para o mapa de estados. keys = "customer:ID" etc.
// ---------------------------------------------------------------------------
export function useChangeRequestStates(keys: string[], date?: string): Record<string, ChangeRequestState> {
  const uniq = useMemo(() => Array.from(new Set(keys.filter(Boolean))).sort(), [keys.join("|")]);
  const keysParam = uniq.join(",");
  const dateParam = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : "";
  const { data } = useQuery<Record<string, ChangeRequestState>>({
    queryKey: ["/api/change-requests/states", keysParam, dateParam],
    queryFn: async () => {
      if (!keysParam) return {};
      const r = await fetch(`/api/change-requests/states?keys=${encodeURIComponent(keysParam)}${dateParam ? `&date=${dateParam}` : ""}`, { credentials: "include" });
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
  /** quando true, o botão de nova solicitação fica desabilitado (ex.: já há check-in/venda no dia) */
  disabled?: boolean;
}

export function ChangeRequestControl(props: ControlProps) {
  const { entityType, entityId, customerId, entityName, sellerId, sellerName, state, className, fullRow, disabled } = props;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);

  // Estado do formulário
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [periodicidade, setPeriodicidade] = useState<string>("");
  const [diaRota, setDiaRota] = useState<Set<string>>(new Set());
  const [areaVendas, setAreaVendas] = useState<string>("");
  const [modalidade, setModalidade] = useState<string>("");
  const [inicioAtendimento, setInicioAtendimento] = useState<string>("");
  const [outro, setOutro] = useState<string>("");
  const [inativarTexto, setInativarTexto] = useState<string>("");

  // 💬 Resposta/reenvio da conversa (vendedor).
  const [replyText, setReplyText] = useState<string>("");

  // Fase 2: gravação de áudio transcrito (Whisper) para o campo "Outro".
  const [recording, setRecording] = useState(false);
  const [recordTarget, setRecordTarget] = useState<"outro" | "inativar">("outro");
  const recordTargetRef = useRef<"outro" | "inativar">("outro");
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startRecording = async (target: "outro" | "inativar" = "outro") => {
    recordTargetRef.current = target;
    setRecordTarget(target);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        try { stream.getTracks().forEach((tk) => tk.stop()); } catch {}
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || "audio/webm" });
        const dataUrl: string = await new Promise((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(String(r.result)); r.readAsDataURL(blob); });
        setTranscribing(true);
        try {
          const resp = await apiRequest("POST", "/api/change-requests/transcribe", { audio: dataUrl });
          if (resp?.text) {
            const add = (prev: string) => (prev ? prev.trim() + " " : "") + resp.text;
            if (recordTargetRef.current === "inativar") setInativarTexto(add); else setOutro(add);
          }
          else toast({ title: "Nada transcrito", description: "Não consegui entender o áudio. Tente de novo." });
        } catch (e: any) {
          toast({ title: "Falha na transcrição", description: e?.message || "Tente novamente.", variant: "destructive" });
        } finally { setTranscribing(false); }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e: any) {
      toast({ title: "Microfone indisponível", description: e?.message || "Permita o acesso ao microfone.", variant: "destructive" });
    }
  };
  const stopRecording = () => { try { mediaRecorderRef.current?.stop(); } catch {} setRecording(false); };

  const resetForm = () => {
    setSelected(new Set()); setPeriodicidade(""); setDiaRota(new Set());
    setAreaVendas(""); setModalidade(""); setInicioAtendimento(""); setOutro(""); setInativarTexto("");
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
      if (selected.has("presencial_virtual") && modalidade) details.modalidade = modalidade;
      if (selected.has("inicio_atendimento") && inicioAtendimento) details.inicioAtendimento = inicioAtendimento;
      if (selected.has("inativar") && inativarTexto.trim()) details.inativar = inativarTexto.trim();
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

  // 💬 Reenvio: registra a mensagem do vendedor e REABRE a solicitação (volta ao admin).
  const replyMut = useMutation({
    mutationFn: async () => {
      if (!state?.id) throw new Error("Solicitação inválida");
      return apiRequest("POST", `/api/change-requests/${state.id}/reply`, { text: replyText.trim(), resend: true });
    },
    onSuccess: () => {
      toast({ title: "Solicitação reenviada", description: "O admin foi notificado na caixa de solicitações." });
      setReplyText(""); setViewOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível reenviar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });

  const canSubmit = selected.size > 0 && !createMut.isPending;

  // Validação leve: se marcou um tipo com sub-opção, exige a sub-opção.
  const missingSub =
    (selected.has("periodicidade") && !periodicidade) ||
    (selected.has("dia_rota") && diaRota.size === 0) ||
    (selected.has("area_vendas") && !areaVendas) ||
    (selected.has("presencial_virtual") && !modalidade) ||
    (selected.has("inicio_atendimento") && !inicioAtendimento) ||
    (selected.has("outro") && !outro.trim());

  const stop = (e: any) => e.stopPropagation();

  // ---- Render do gatilho ----
  // Regra (05/08/2026): o botão "Solicitar Alteração" fica SEMPRE disponível em todos os cards,
  // mesmo os que já têm solicitação ou registro de atendimento (check-in/venda). Quando há uma
  // solicitação, mostramos também o selo de status (Pendente/Efetuada/Parcial/Rejeitada + sino).
  let statusBadge: JSX.Element | null = null;
  if (state?.status === "pending") {
    statusBadge = (
      <Badge
        variant="outline"
        className="cursor-pointer bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100 gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5"
        title={`Solicitação pendente: ${(state.types || []).map((t) => TYPE_LABEL[t] || t).join(", ")}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-pending-${entityId}`}
      >
        <Hourglass className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Pendente
      </Badge>
    );
  } else if (state && RESULT_META[state.status]) {
    const m = RESULT_META[state.status];
    statusBadge = (
      <Badge
        variant="outline"
        className={`cursor-pointer gap-1 text-[10px] sm:text-xs px-1.5 sm:px-2.5 py-0 sm:py-0.5 ${m.cls}`}
        title={`Alterações ${m.label}${state.resolutionNote ? " — " + state.resolutionNote : ""}${(state.status === "parcial" || state.status === "rejeitadas") ? " · há retorno do admin a responder" : ""}`}
        onClick={(e) => { stop(e); setViewOpen(true); }}
        data-testid={`badge-cr-result-${entityId}`}
      >
        <m.Icon className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> {m.label}
        {/* 🔔 Retorno do admin (Parcial/Rejeitada) a ser respondido no card. (04/08/2026) */}
        {(state.status === "parcial" || state.status === "rejeitadas") && (
          <Bell className="h-2.5 w-2.5 sm:h-3 sm:w-3 ml-0.5 animate-pulse" data-testid={`badge-cr-bell-${entityId}`} />
        )}
      </Badge>
    );
  }
  const trigger: JSX.Element = (
    <div className={`flex items-center gap-2 flex-wrap justify-end ${className || ""}`}>
      {statusBadge}
      <Button
        size="sm"
        variant="outline"
        className="h-6 sm:h-7 px-2 sm:px-3 text-[11px] sm:text-sm gap-1 text-indigo-700 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800"
        onClick={(e) => { stop(e); setOpen(true); }}
        title="Solicitar Alteração"
        data-testid={`button-cr-open-${entityId}`}
      >
        <ClipboardList className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> Solicitar Alteração
      </Button>
    </div>
  );

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

                {selected.has("presencial_virtual") && t.key === "presencial_virtual" && (
                  <RadioGroup value={modalidade} onValueChange={setModalidade} className="mt-2 ml-6 flex gap-4">
                    {[["presencial", "Presencial"], ["virtual", "Virtual"]].map(([v, l]) => (
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

                {selected.has("inativar") && t.key === "inativar" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={inativarTexto}
                      onChange={(e) => setInativarTexto(e.target.value)}
                      placeholder="Descreva o motivo da inativação… (ou grave um áudio) (opcional)"
                      rows={3}
                      data-testid="cr-inativar-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "inativar") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("inativar"); }} disabled={transcribing} data-testid="cr-inativar-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-inativar-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "inativar" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "inativar" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
                  </div>
                )}

                {selected.has("outro") && t.key === "outro" && (
                  <div className="mt-2 ml-6">
                    <Textarea
                      value={outro}
                      onChange={(e) => setOutro(e.target.value)}
                      placeholder="Descreva a alteração desejada… (ou grave um áudio)"
                      rows={3}
                      data-testid="cr-outro-texto"
                    />
                    <div className="flex items-center gap-2 mt-2">
                      {!(recording && recordTarget === "outro") ? (
                        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={(e) => { stop(e); startRecording("outro"); }} disabled={transcribing} data-testid="cr-audio-record">
                          <Mic className="h-3.5 w-3.5" /> Gravar áudio
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="destructive" className="gap-1" onClick={(e) => { stop(e); stopRecording(); }} data-testid="cr-audio-stop">
                          <Square className="h-3.5 w-3.5" /> Parar
                        </Button>
                      )}
                      {recording && recordTarget === "outro" && <span className="text-xs text-red-600 animate-pulse">gravando…</span>}
                      {transcribing && recordTarget === "outro" && <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> transcrevendo…</span>}
                    </div>
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
                  {state.details.modalidade && <div>Modalidade: {state.details.modalidade === "virtual" ? "Virtual" : "Presencial"}</div>}
                  {state.details.inicioAtendimento && <div>Início de atendimento: {state.details.inicioAtendimento}</div>}
                  {state.details.inativar && <div>Inativar: {state.details.inativar}</div>}
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
                  {state.resolvedByName && <div className="text-muted-foreground text-xs">Resolvido por {state.resolvedByName}</div>}
                </div>
              )}

              {/* 💬 Histórico da conversa (vendedor ⇄ admin) */}
              {Array.isArray(state.messages) && state.messages.length > 0 && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
                  <MessageThread messages={state.messages} />
                </div>
              )}

              {/* 📌 Fallback: solicitações antigas (sem histórico) — mostra o motivo do admin */}
              {state.status !== "pending" && (!Array.isArray(state.messages) || state.messages.length === 0) && state.resolutionNote && (
                <div className="pt-2 mt-1 border-t">
                  <div className="text-[11px] font-semibold text-muted-foreground mb-1">Resposta do admin</div>
                  <div className="rounded-lg px-2.5 py-1.5 text-xs bg-indigo-50 text-indigo-900 border border-indigo-200 whitespace-pre-wrap break-words">
                    {state.resolutionNote}
                  </div>
                </div>
              )}

              {/* ↩️ Reenvio: só para Parcial/Rejeitadas — o vendedor devolve ao admin */}
              {(state.status === "parcial" || state.status === "rejeitadas") && (
                <div className="pt-2 mt-1 border-t space-y-2">
                  <div className="text-[11px] font-semibold text-muted-foreground">Reenviar solicitação ao admin</div>
                  <Textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Escreva um retorno (ex.: motivo para reconsiderar)…"
                    rows={2}
                    data-testid="cr-reply-text"
                  />
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={replyMut.isPending || !replyText.trim()}
                    onClick={() => replyMut.mutate()}
                    data-testid="cr-reply-resend"
                  >
                    {replyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reenviar ao admin"}
                  </Button>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {state?.status !== "pending" && (
              <Button variant="outline" onClick={() => { setViewOpen(false); setOpen(true); }} data-testid="cr-new-from-view">Nova solicitação</Button>
            )}
            <Button variant="outline" onClick={() => setViewOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
