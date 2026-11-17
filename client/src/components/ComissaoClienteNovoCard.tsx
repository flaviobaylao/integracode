// Card da campanha: comissão de 12% por 6 meses para cliente novo conquistado
// a partir de 16/11/2026 (ata da reunião de 14/11/2026). Até 15/11 valia o
// bônus de R$ 30 por novo cliente (premissa "novos").
import { useState } from "react";
import { useQuery, apiRequest } from "@/lib/queryClient";

type Linha = {
  customerId: string; cliente: string; vendedor: string; inicio: string; fim: string; status: string;
  motivo: string | null; vendasMes: number; percentual: number; comissao: number; adicional: number;
};
type Resp = {
  ok: boolean; ym: string; inicioRegra: string; percentual: number; percentualBase: number; meses: number;
  clientes: Linha[]; totais: { clientes: number; vendas: number; comissao: number; adicional: number };
};
const brl = (v: number) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dt = (d: string) => String(d || "").slice(0, 10).split("-").reverse().join("/");

export default function ComissaoClienteNovoCard({ ym }: { ym: string }) {
  const [aberto, setAberto] = useState(false);
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["/api/comissao-novos", ym],
    queryFn: () => apiRequest("GET", "/api/comissao-novos?ym=" + ym),
  });
  if (ym < "2026-11") return null;
  const t = data?.totais;
  return (
    <div className="mt-3 border-t border-dashed border-gray-200 pt-3" data-testid="card-comissao-cliente-novo">
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Clientes com a comissão neste mês</div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div><div className="text-gray-500">Clientes</div><div className="text-base font-bold text-gray-800">{isLoading ? "…" : t?.clientes ?? 0}</div></div>
        <div><div className="text-gray-500">Vendas no mês</div><div className="text-base font-bold text-gray-800">{isLoading ? "…" : brl(t?.vendas ?? 0)}</div></div>
        <div><div className="text-gray-500" title="Diferença até 12% sobre a taxa normal de cada vendedor — é o que entra na coluna Cliente Novo do Resumo Recebíveis">A mais (até 12%)</div><div className="text-base font-bold text-emerald-700">{isLoading ? "…" : brl(t?.adicional ?? 0)}</div></div>
      </div>
      {!!data?.clientes?.length && (
        <button type="button" onClick={() => setAberto((v) => !v)} className="mt-2 text-[11px] font-semibold text-emerald-700 hover:underline">
          {aberto ? "Ocultar clientes" : `Ver os ${data.clientes.length} clientes`}
        </button>
      )}
      {aberto && (
        <div className="mt-2 max-h-64 overflow-auto rounded border border-gray-100">
          <table className="w-full text-[11px]">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr><th className="px-2 py-1">Cliente</th><th className="px-2 py-1">Vendedor</th><th className="px-2 py-1">Até</th>
                <th className="px-2 py-1 text-right">Vendas</th><th className="px-2 py-1 text-right">%</th></tr>
            </thead>
            <tbody>
              {data!.clientes.map((c) => (
                <tr key={c.customerId} className="border-t border-gray-100" title={c.status !== "vigente" ? (c.motivo || "Encerrada") : ""}>
                  <td className="px-2 py-1 text-gray-800">{c.cliente}</td>
                  <td className="px-2 py-1">{c.vendedor}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{dt(c.fim)}</td>
                  <td className="px-2 py-1 text-right">{brl(c.vendasMes)}</td>
                  <td className="px-2 py-1 text-right font-semibold">{c.percentual}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
