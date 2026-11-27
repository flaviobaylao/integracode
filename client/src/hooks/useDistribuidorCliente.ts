// client/src/hooks/useDistribuidorCliente.ts
// (19/nov/2026) Classifica o cliente do card quanto ao distribuidor (Amorix) e diz se o usuario
// logado pode lancar pedido para ele. Regra do servidor: cliente cuja carteira e' um vendedor
// 'distribuidor' so' recebe pedido de admin/administrativo/coordenacao. A API tambem recusa
// (403 DISTRIBUIDOR_SOMENTE_ADMIN); aqui e' so' para avisar e desabilitar o botao antes.
import { useQuery } from "@tanstack/react-query";

export type DistribuidorCliente = {
  sellout: boolean;
  clienteDistribuidor: boolean;
  distribuidorId: string | null;
  distribuidorNome: string | null;
  podeLancar: boolean;
};

const LIVRE: DistribuidorCliente = { sellout: false, clienteDistribuidor: false, distribuidorId: null, distribuidorNome: null, podeLancar: true };

export function useDistribuidorCliente(customerId: string | null | undefined): DistribuidorCliente {
  const { data } = useQuery<DistribuidorCliente>({
    queryKey: ['/api/distribuidores/cliente', customerId],
    queryFn: async () => {
      const r = await fetch(`/api/distribuidores/cliente/${customerId}`, { credentials: 'include' });
      return r.ok ? r.json() : LIVRE;
    },
    enabled: !!customerId,
    staleTime: 60_000,
  });
  return data || LIVRE;
}

export function mensagemBloqueioDistribuidor(nome?: string | null): string {
  return `Cliente atendido pela ${nome || 'Amorix'} — pedidos para esta carteira só pela administração (admin, administrativo ou coordenação).`;
}
