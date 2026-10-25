// Aviso de troca repetida (política de trocas): quando o cliente já teve troca pelo
// MESMO motivo, mostra a data e um link que abre o Extrato do Cliente em outra guia,
// já no cliente e no bloco "Trocas registradas".
//  - salesCardId: pedido no pipeline (resolve o motivo registrado no card)
//  - customerId + motivo: card de vendas, enquanto o vendedor escolhe o motivo
import { useQuery } from "@/lib/queryClient";

interface Props {
  salesCardId?: string | null;
  customerId?: string | null;
  motivo?: string | null;
  className?: string;
}

export default function TrocaAnteriorAviso({ salesCardId, customerId, motivo, className }: Props) {
  const porPedido = !!salesCardId;
  const enabled = porPedido || (!!customerId && !!motivo);
  const qs = porPedido
    ? `salesCardId=${encodeURIComponent(String(salesCardId))}`
    : `customerId=${encodeURIComponent(String(customerId || ''))}&motivo=${encodeURIComponent(String(motivo || ''))}`;
  const { data } = useQuery<{ anterior: { dataBr: string; customerId: string } | null }>({
    queryKey: ['/api/trocas/anterior', qs],
    queryFn: async () => {
      const r = await fetch(`/api/trocas/anterior?${qs}`, { credentials: 'include' });
      if (!r.ok) return { anterior: null };
      return r.json();
    },
    enabled,
    staleTime: 60000,
  });
  const ant = data?.anterior;
  if (!enabled || !ant) return null;
  const href = `/extrato-cliente?customerId=${encodeURIComponent(ant.customerId)}&secao=trocas`;
  return (
    <p className={className ?? 'text-sm font-semibold text-red-600'} data-testid="aviso-troca-anterior">
      Este cliente teve uma troca pelo mesmo motivo em {ant.dataBr}.{' '}
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:text-red-800">
        Clique aqui para ver no extrato do cliente.
      </a>
    </p>
  );
}
