import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Plus, History } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LeadTemperature = 'cold' | 'warm' | 'hot' | 'very_hot';

const temperatureLabels: Record<LeadTemperature, string> = {
  cold: "Frio",
  warm: "Morno",
  hot: "Quente",
  very_hot: "Muito Quente"
};

const temperatureColors: Record<LeadTemperature, string> = {
  cold: "bg-blue-500",
  warm: "bg-yellow-500",
  hot: "bg-orange-500",
  very_hot: "bg-red-500"
};

// Mesma visão do Histórico de Ações (cliente/lead): check-in/out, foto, visitas,
// observações e desfecho (conversão, não-conversão, prorrogação, resgate).
type HistItem = { id: string; tipo: string; tipoLabel: string; texto: string; autor: string; data: string | null; url?: string | null };

const TIPO_STYLE: Record<string, string> = {
  descricao: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  observacao: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  replica: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  treplica: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  resolucao: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  report: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  checkin: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  checkout: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  foto: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300",
  visita: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  conversao: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  nao_conversao: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  prorrogacao: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  resgate: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
};

function fmtDataHora(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface LeadVisitHistoryModalProps {
  open: boolean;
  onClose: () => void;
  leadId: string;
  leadName: string;
  currentTemperature?: LeadTemperature | null;
  onSuccess?: () => void;
}

export default function LeadVisitHistoryModal({
  open,
  onClose,
  leadId,
  leadName,
  currentTemperature,
  onSuccess
}: LeadVisitHistoryModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [observation, setObservation] = useState("");
  const [temperature, setTemperature] = useState<LeadTemperature | "">("");

  const HIST_KEY = ["/api/change-requests/history/lead", leadId];
  const { data, isLoading } = useQuery<{ items: HistItem[] }>({
    queryKey: HIST_KEY,
    enabled: open && !!leadId,
    staleTime: 30 * 1000,
  });
  const items = data?.items || [];

  const createVisitMutation = useMutation({
    mutationFn: async (data: { observation: string; temperature?: LeadTemperature }) => {
      return await apiRequest('POST', `/api/leads/${leadId}/visits`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: HIST_KEY });
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      setIsCreating(false);
      setObservation("");
      setTemperature("");
      toast({
        title: "Sucesso",
        description: "Visita registrada com sucesso!",
      });
      onSuccess?.();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao registrar visita",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (!observation.trim()) {
      toast({
        title: "Erro",
        description: "Observação é obrigatória",
        variant: "destructive",
      });
      return;
    }

    createVisitMutation.mutate({
      observation: observation.trim(),
    });
  };

  const handleClose = () => {
    setIsCreating(false);
    setObservation("");
    setTemperature("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Histórico de Ações do Lead - {leadName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          <p className="text-xs text-muted-foreground mb-3">
            Observações, visitas, check-in/out, foto e desfecho do lead — 50 registros mais recentes.
          </p>

          {!isCreating ? (
            <Button
              onClick={() => setIsCreating(true)}
              className="mb-4 w-full"
              variant="outline"
            >
              <Plus className="h-4 w-4 mr-2" />
              Registrar Nova Visita
            </Button>
          ) : (
            <Card className="mb-4 border-2 border-primary/20">
              <CardContent className="pt-4 space-y-4">
                <div>
                  <Label htmlFor="observation">Observação *</Label>
                  <Textarea
                    id="observation"
                    value={observation}
                    onChange={(e) => setObservation(e.target.value)}
                    placeholder="Descreva o que foi tratado na visita..."
                    rows={3}
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsCreating(false);
                      setObservation("");
                      setTemperature("");
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={createVisitMutation.isPending}
                  >
                    {createVisitMutation.isPending ? "Salvando..." : "Salvar Visita"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            ) : items.length > 0 ? (
              <div className="space-y-2 pr-4">
                {items.map((it) => (
                  <div key={it.id} className="rounded-md border border-border p-2.5" data-testid="hist-item">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <Badge variant="outline" className={`text-[10px] border-transparent ${TIPO_STYLE[it.tipo] || TIPO_STYLE.descricao}`}>
                        {it.tipoLabel}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDataHora(it.data)}</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">{it.texto}</p>
                    {it.url && (
                      <button type="button" onClick={() => { const u = (it as any).url || ''; try { if (typeof u === 'string' && u.startsWith('data:')) { const comma = u.indexOf(','); const meta = u.slice(0, comma); const b64 = u.slice(comma + 1); const mime = (meta.match(/data:(.*?)(;|$)/) || [])[1] || 'image/jpeg'; const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); const blobUrl = URL.createObjectURL(new Blob([arr], { type: mime })); const w = window.open(blobUrl, '_blank'); if (!w) { const a = document.createElement('a'); a.href = blobUrl; a.download = 'foto.jpg'; document.body.appendChild(a); a.click(); a.remove(); } setTimeout(() => URL.revokeObjectURL(blobUrl), 60000); } else if (u) { window.open(u, '_blank', 'noopener,noreferrer'); } } catch (e) { if (u) window.open(u, '_blank', 'noopener,noreferrer'); } }} className="text-[11px] text-blue-600 hover:underline break-all">Ver foto</button>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1">por {it.autor || "—"}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>Nenhum registro ainda</p>
                <p className="text-xs">Clique em "Registrar Nova Visita" para começar</p>
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
