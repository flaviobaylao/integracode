import { useQuery } from "@tanstack/react-query";
import { FileText, ShoppingCart, XCircle, Image as ImageIcon, Loader2 } from "lucide-react";

interface VirtualServiceSummaryProps {
  customerId: string;
  /** Data selecionada no formato YYYY-MM-DD (America/Sao_Paulo) */
  date: string;
  /** Valor do pedido do dia (quando houve venda registrada), vindo do customer-info */
  orderValue?: number | null;
}

interface ServiceLog {
  id: string;
  service_type?: string;
  serviceType?: string;
  attendance_date?: string;
  attendanceDate?: string;
  notes?: string | null;
  images?: string[] | null;
  attendant_name?: string;
  attendantName?: string;
}

const st = (l: ServiceLog) => String(l.serviceType || l.service_type || "").toLowerCase();
const attDate = (l: ServiceLog) => l.attendanceDate || l.attendance_date || "";
const brDay = (iso: string) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  } catch {
    return String(iso).slice(0, 10);
  }
};

function typeLabel(type: string): { label: string; cls: string; Icon: any } {
  switch (type) {
    case "venda":
      return { label: "Venda", cls: "border-green-500 text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300", Icon: ShoppingCart };
    case "nao_venda":
      return { label: "Não Venda", cls: "border-red-500 text-red-700 bg-red-50 dark:bg-red-950 dark:text-red-300", Icon: XCircle };
    case "debito_vencido":
      return { label: "Débito Vencido", cls: "border-amber-500 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300", Icon: FileText };
    default:
      return { label: "Prospecção", cls: "border-blue-500 text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300", Icon: FileText };
  }
}

export function VirtualServiceSummary({ customerId, date, orderValue }: VirtualServiceSummaryProps) {
  const { data: logs = [], isLoading } = useQuery<ServiceLog[]>({
    queryKey: ["/api/customers", customerId, "service-logs", date],
    queryFn: async () => {
      const r = await fetch(`/api/customers/${customerId}/service-logs`, { credentials: "include" });
      if (!r.ok) return [];
      const all: ServiceLog[] = await r.json();
      return (all || []).filter((l) => brDay(attDate(l)) === date);
    },
    enabled: !!customerId && !!date,
  });

  if (isLoading) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando resumo do atendimento...
      </div>
    );
  }

  const hasOrder = orderValue != null && Number(orderValue) > 0;

  if (!logs.length && !hasOrder) {
    return (
      <div className="mb-4 rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground" data-testid="virtual-summary-empty">
        Nenhum atendimento registrado para este cliente na data.
      </div>
    );
  }

  return (
    <div className="mb-4 space-y-2" data-testid="virtual-summary">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resumo do atendimento</p>

      {logs.map((l) => {
        const type = st(l);
        const { label, cls, Icon } = typeLabel(type);
        const images = Array.isArray(l.images) ? l.images.filter(Boolean) : [];
        return (
          <div key={l.id} className="rounded-md border bg-card p-3 text-sm" data-testid={`virtual-summary-log-${l.id}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
                <Icon className="h-3 w-3" />
                {label}
              </span>
              {type === "venda" && hasOrder && (
                <span className="text-xs font-semibold text-green-700 dark:text-green-300">
                  Pedido: R$ {Number(orderValue).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </span>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Observação: </span>
              {l.notes && String(l.notes).trim() ? l.notes : "—"}
            </div>

            {images.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <ImageIcon className="h-3 w-3" /> Imagem anexada ({images.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {images.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noreferrer" title="Abrir imagem">
                      <img
                        src={src}
                        alt={`Anexo ${i + 1}`}
                        className="h-16 w-16 rounded border object-cover hover:opacity-90"
                        data-testid={`virtual-summary-image-${l.id}-${i}`}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Pedido registrado sem log de atendimento (venda registrada pelo card de venda) */}
      {!logs.some((l) => st(l) === "venda") && hasOrder && (
        <div className="rounded-md border bg-card p-3 text-sm" data-testid="virtual-summary-order-only">
          <span className="inline-flex items-center gap-1 rounded-full border border-green-500 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
            <ShoppingCart className="h-3 w-3" />
            Venda
          </span>
          <span className="ml-2 text-xs font-semibold text-green-700 dark:text-green-300">
            Pedido: R$ {Number(orderValue).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
          </span>
        </div>
      )}
    </div>
  );
}
