import { useMemo } from "react";
import { useQuery } from "@/lib/queryClient";

type Mark = { delegado: string; delegadoId: string; ate: string | null };

/**
 * Clientes sob delegação de carteira VIGENTE.
 * Fonte: GET /api/delegations/customer-marks (authenticateUser).
 *  - admin recebe todos os clientes sob delegação;
 *  - vendedor/telemarketing recebe apenas os clientes delegados a ele.
 * A marcação some sozinha quando a delegação encerra/é revogada — não existe
 * estado a limpar depois.
 */
function useMarksQuery() {
  return useQuery<{ ids: string[]; marks?: Record<string, Mark> }>({
    queryKey: ["/api/delegations/customer-marks"],
    staleTime: 60_000,
  });
}

/** Conjunto de IDs sob delegação (mantido para os pontos que só precisam do sim/não). */
export function useCustomerMarks(): Set<string> {
  const { data } = useMarksQuery();
  return useMemo(() => new Set(data?.ids ?? []), [data]);
}

/** Mapa clienteId -> { delegado, ate }: quem está atendendo e até quando. */
export function useDelegacaoMarks(): Map<string, Mark> {
  const { data } = useMarksQuery();
  return useMemo(() => new Map(Object.entries(data?.marks ?? {})), [data]);
}

const primeiroNome = (n: string) => String(n || "").trim().split(/\s+/)[0] || "";
const dataBR = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR");
};

/**
 * Etiqueta que vai NA FRENTE do nome do cliente: "DELEG → Jhonatan".
 * Mostra de relance quem está atendendo durante a delegação. Usa só o primeiro
 * nome para não empurrar o nome do cliente para fora da coluna; o nome completo
 * e o fim do período ficam no title.
 */
export function TagDelegacao({ customerId, marks }: { customerId?: string | null; marks: Map<string, Mark> }) {
  if (!customerId) return null;
  const m = marks.get(String(customerId));
  if (!m) return null;
  const ate = dataBR(m.ate);
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700 border border-amber-300 bg-amber-50 px-1.5 py-0.5 rounded-full whitespace-nowrap mr-1 align-middle"
      title={`Carteira delegada temporariamente${m.delegado ? ` para ${m.delegado}` : ""}${ate ? ` até ${ate}` : ""} — volta ao titular quando a delegação encerrar`}
      data-testid={`tag-delegacao-${customerId}`}
    >
      DELEG → {primeiroNome(m.delegado) || "delegado"}
    </span>
  );
}

/** Etiqueta antiga (texto only, sem delegado). Mantida para não quebrar chamadas existentes. */
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
