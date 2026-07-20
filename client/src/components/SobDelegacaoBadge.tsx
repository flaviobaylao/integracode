import { useMemo } from "react";
import { useQuery } from "@/lib/queryClient";

/**
 * Conjunto de IDs de clientes que estão sob uma delegação de carteira VIGENTE.
 * Fonte: GET /api/delegations/customer-marks (authenticateUser).
 *  - admin recebe todos os clientes sob delegação;
 *  - vendedor/telemarketing recebe apenas os clientes delegados a ele.
 * A marcação some sozinha quando a delegação encerra/é revogada.
 */
export function useCustomerMarks(): Set<string> {
  const { data } = useQuery<{ ids: string[] }>({
    queryKey: ["/api/delegations/customer-marks"],
    staleTime: 60_000,
  });
  return useMemo(() => new Set(data?.ids ?? []), [data]);
}

/** Etiqueta âmbar "sob delegação" — renderiza nada quando show=false. */
export function SobDelegacaoBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="text-[10px] font-semibold text-amber-700 border border-amber-300 bg-amber-50 px-1.5 py-0.5 rounded-full whitespace-nowrap"
      title="Cliente em delegação temporária de carteira — volta ao titular quando a delegação encerrar"
      data-testid="badge-sob-delegacao"
    >
      sob delegação
    </span>
  );
}
