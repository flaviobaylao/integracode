import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { History, Loader2 } from "lucide-react";

/**
 * Histórico de Ações do Cliente — lista achatada dos registros do Inbox
 * (change_requests) de um cliente: Descrição, Observações, Réplicas (admin),
 * Tréplicas (vendedor) e Resolução, com data/hora e autor. Mostra os 50 mais
 * recentes (o backend já ordena e corta em 50). Não inclui alterações de
 * cadastro — essas seguem no "relógio" ao lado do nome.
 */

type HistItem = {
  id: string;
  tipo: string;
  tipoLabel: string;
  texto: string;
  autor: string;
  data: string | null;
};

const TIPO_STYLE: Record<string, string> = {
  descricao: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  observacao: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  replica: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  treplica: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  resolucao: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  report: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

function fmtDataHora(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ActionHistoryModal({
  open,
  onClose,
  customerId,
  customerName,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
}) {
  const { data, isLoading, isError } = useQuery<{ items: HistItem[] }>({
    queryKey: ["/api/change-requests/history/customer", customerId],
    enabled: open && !!customerId,
    staleTime: 60 * 1000,
  });

  const items = data?.items || [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Histórico de Ações do Cliente
          </DialogTitle>
        </DialogHeader>

        {customerName && (
          <p className="text-sm font-semibold text-foreground -mt-1">{customerName}</p>
        )}
        <p className="text-xs text-muted-foreground -mt-1">
          Descrições, observações, réplicas e tréplicas do Inbox — 50 registros mais recentes.
        </p>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 py-1 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando…
            </div>
          ) : isError ? (
            <div className="text-center py-10 text-sm text-red-600">Não foi possível carregar o histórico.</div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              Nenhum registro de ação no Inbox para este cliente.
            </div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="rounded-md border border-border p-2.5" data-testid="hist-item">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge variant="outline" className={`text-[10px] border-transparent ${TIPO_STYLE[it.tipo] || TIPO_STYLE.descricao}`}>
                    {it.tipoLabel}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDataHora(it.data)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{it.texto}</p>
                <p className="text-[11px] text-muted-foreground mt-1">por {it.autor || "—"}</p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
