import { useQuery } from "@tanstack/react-query";

/**
 * 🟢🟡🔴 Bolinhas de "Efetividade em vendas" por ciclo — as MESMAS da Rota do Dia e do
 * Resumo de Visitas: um ponto por ciclo da periodicidade (Semanal 4 / Quinzenal 2 /
 * Mensal 1). Verde = houve pedido; amarelo = atendido sem pedido; vermelho = passou o
 * dia da visita sem nada; sem cor (tracejada) = atendimento do ciclo ainda não realizado.
 *
 * Fonte única: /api/visit-summary (ciclos calculados a partir dos faturamentos dos
 * últimos ~130 dias, sempre relativos a HOJE). Usado no Inbox (26/out/2026). O mapa
 * customerId → ciclos é montado UMA vez por versão da resposta e compartilhado por
 * todos os cards da tela.
 */
export type SalesCycle = { anchor?: string; start?: string; end?: string; green: boolean; isPast?: boolean; attended?: boolean; pending?: boolean };

function corCiclo(cy: SalesCycle) {
  if (cy.pending) return "transparent";
  if (cy.green) return "#22c55e";
  if (cy.attended) return "#eab308";
  return "#ef4444";
}
function textoCiclo(cy: SalesCycle) {
  if (cy.pending) return "Atendimento do ciclo ainda não realizado";
  if (cy.green) return "houve pedido";
  if (cy.attended) return "atendido, sem pedido";
  return "sem atendimento e sem pedido";
}

let _srcRef: any = undefined;
let _map: Map<string, SalesCycle[]> = new Map();
function mapaCiclos(data: any): Map<string, SalesCycle[]> {
  if (data === _srcRef) return _map;
  const m = new Map<string, SalesCycle[]>();
  for (const r of (data?.rows || [])) {
    if (r && r.customerId && Array.isArray(r.cycles) && r.cycles.length > 0) m.set(String(r.customerId), r.cycles);
  }
  _srcRef = data;
  _map = m;
  return m;
}

function hojeBRT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

/** Mapa customerId → ciclos (todas as instâncias compartilham a mesma consulta e o mesmo mapa). */
export function useSalesCycles(enabled = true): Map<string, SalesCycle[]> {
  const hoje = hojeBRT();
  const { data } = useQuery<any>({
    queryKey: ["/api/visit-summary", "ciclos-vendas", hoje],
    queryFn: async () => {
      const res = await fetch(`/api/visit-summary?startDate=${hoje}&endDate=${hoje}`, { credentials: "include", cache: "no-store" });
      if (!res.ok) return { rows: [] };
      return res.json();
    },
    enabled,
    staleTime: 5 * 60 * 1000, // ciclos mudam devagar
  });
  return mapaCiclos(data);
}

export function SalesCycleDots({ cycles }: { cycles?: SalesCycle[] | null }) {
  if (!cycles || cycles.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-[3px] align-middle"
      title="Efetividade em vendas por ciclo: verde = houve pedido; amarelo = atendido sem pedido; vermelho = sem atendimento e sem pedido; sem cor = atendimento do ciclo ainda não realizado"
    >
      {cycles.map((cy, ci) => (
        <span
          key={ci}
          title={`${cy.start || ""}${cy.start && cy.end ? " a " : ""}${cy.end || ""}: ${textoCiclo(cy)}`}
          className="inline-block rounded-full"
          style={{ width: 10, height: 10, boxSizing: "border-box", background: corCiclo(cy), border: cy.pending ? "1px dashed #9ca3af" : "none" }}
        />
      ))}
    </span>
  );
}

/** Atalho: bolinhas do cliente pelo id (null se não houver ciclos). */
export function SalesCycleDotsCliente({ customerId }: { customerId?: string | null }) {
  const mapa = useSalesCycles(!!customerId);
  if (!customerId) return null;
  return <SalesCycleDots cycles={mapa.get(String(customerId))} />;
}
