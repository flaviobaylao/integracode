import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { History, Loader2 } from "lucide-react";

/**
 * Histórico de Ações — lista achatada dos registros de um cliente ou lead.
 * Cliente: registros do Inbox (change_requests) — Descrição, Observações,
 * Réplicas (admin), Tréplicas (vendedor), Resolução — e, quando o cliente veio
 * de um lead, a fase de lead migra junto (observações, check-in/out, foto,
 * visitas e desfecho). Lead: tudo que o vendedor registrou no lead.
 * Mostra os 50 mais recentes. Não inclui alterações de cadastro — essas seguem
 * no "relógio" ao lado do nome.
 */

type HistItem = {
  id: string;
  tipo: string;
  tipoLabel: string;
  texto: string;
  autor: string;
  data: string | null;
  url?: string | null;
};

const TIPO_STYLE: Record<string, string> = {
  descricao: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  observacao: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  replica: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  treplica: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  resolucao: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  report: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  // Fase de lead
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

export default function ActionHistoryModal({
  open,
  onClose,
  customerId,
  customerName,
  entityType = "customer",
}: {
  open: boolean;
  onClose: () => void;
  customerId: string | null;
  customerName?: string | null;
  entityType?: "customer" | "lead";
}) {
  const base = entityType === "lead"
    ? "/api/change-requests/history/lead"
    : "/api/change-requests/history/customer";
  const { data, isLoading, isError } = useQuery<{ items: HistItem[] }>({
    queryKey: [base, customerId],
    enabled: open && !!customerId,
    staleTime: 60 * 1000,
  });

  const items = data?.items || [];
  const titulo = entityType === "lead" ? "Histórico de Ações do Lead" : "Histórico de Ações do Cliente";
  const subtitulo = entityType === "lead"
    ? "Observações, visitas, check-in/out, foto e desfecho do lead — 50 registros mais recentes."
    : "Inbox (descrições, réplicas, tréplicas) e a fase de lead, quando houver — 50 registros mais recentes.";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {titulo}
          </DialogTitle>
        </DialogHeader>

        {customerName && (
          <p className="text-sm font-semibold text-foreground -mt-1">{customerName}</p>
        )}
        <p className="text-xs text-muted-foreground -mt-1">{subtitulo}</p>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 py-1 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando…
            </div>
          ) : isError ? (
            <div className="text-center py-10 text-sm text-red-600">Não foi possível carregar o histórico.</div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              Nenhum registro encontrado.
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
                {it.url && (
                  <a href={it.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline break-all">Ver foto</a>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">por {it.autor || "—"}</p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
