import { useQuery } from "@/lib/queryClient";
import { Loader2, History } from "lucide-react";

interface ChangeRow {
  field: string;
  label: string;
  old_value: string | null;
  new_value: string | null;
  changed_by_name: string | null;
  source: string | null;
  created_at: string;
}

/**
 * Box com o histórico das 30 últimas alterações de um cliente (rezoneamento,
 * periodicidade, dias de visita, etc.), uma linha por alteração e quem executou.
 * O histórico começa a ser registrado a partir da implantação desta funcionalidade.
 */
export default function CustomerHistoryBox({ customerId }: { customerId?: string | null }) {
  const { data, isLoading, isError } = useQuery<ChangeRow[]>({
    queryKey: ['/api/customers', customerId, 'change-history'],
    enabled: !!customerId,
    staleTime: 15000,
  });

  const rows = Array.isArray(data) ? data : [];
  const fmtDate = (s: string) => {
    try {
      return new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return s;
    }
  };
  const sourceLabel = (s: string | null) => (s === 'bulk' ? 'edição em massa' : s === 'system' ? 'sistema' : 'edição');

  return (
    <div className="bg-muted/40 border rounded-md p-3 my-1" data-testid={`history-box-${customerId || 'none'}`}>
      <div className="flex items-center gap-2 text-sm font-semibold mb-2">
        <History className="h-4 w-4" /> Histórico de alterações (30 últimas)
      </div>
      {!customerId ? (
        <div className="text-xs text-muted-foreground">Cliente ainda não cadastrado no sistema — sem histórico.</div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Carregando…</div>
      ) : isError ? (
        <div className="text-xs text-red-600">Falha ao carregar histórico.</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nenhuma alteração registrada ainda. As mudanças passam a aparecer aqui a partir de agora.</div>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map((r, i) => (
            <div key={i} className="py-1.5 text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-muted-foreground whitespace-nowrap tabular-nums">{fmtDate(r.created_at)}</span>
              <span className="font-medium">{r.label}:</span>
              <span className="text-red-600 line-through decoration-1">{r.old_value ?? '—'}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-green-700 font-medium">{r.new_value ?? '—'}</span>
              <span className="ml-auto text-muted-foreground whitespace-nowrap">
                por {r.changed_by_name || 'Sistema'} <span className="opacity-60">({sourceLabel(r.source)})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
