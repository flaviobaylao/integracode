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
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4" data-testid="card-comissao-cliente-novo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xl font-extrabold tracking-tight text-violet-800">12% de comissão · 6 meses</div>
          <div className="text-sm font-semibold text-gray-700">por cliente novo conquistado a partir de 16/11/2026</div>
          <div className="mt-1 max-w-3xl text-xs text-gray-600">
            Substitui o bônus de R$ 30 por novo cliente, que valeu para a 1ª compra até 15/11/2026. Quem conquista o cliente
            (dono da carteira na data da 1ª compra) recebe 12% sobre as vendas dele por 6 meses, em vez de 8%. Se o vendedor
            sair da Honest nesse período, o cliente volta para 8%. O cliente fica marcado em Clientes Ativos e no histórico do cadastro.
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-xs">
          <div><div className="text-gray-500">Clientes</div><div className="text-lg font-bold text-gray-800">{isLoading ? "…" : t?.clientes ?? 0}</div></div>
          <div><div className="text-gray-500">Vendas no mês</div><div className="text-lg font-bold text-gray-800">{isLoading ? "…" : brl(t?.vendas ?? 0)}</div></div>
          <div><div className="text-gray-500">Adicional (12% − 8%)</div><div className="text-lg font-bold text-violet-700">{isLoading ? "…" : brl(t?.adicional ?? 0)}</div></div>
        </div>
      </div>
      {!!data?.clientes?.length && (
        <button type="button" onClick={() => setAberto((v) => !v)} className="mt-3 text-xs font-semibold text-violet-700 hover:underline">
          {aberto ? "Ocultar clientes" : `Ver os ${data.clientes.length} clientes`}
        </button>
      )}
      {!isLoading && !data?.clientes?.length && (
        <div className="mt-3 text-xs text-gray-500">Nenhum cliente novo com a condição neste mês ainda.</div>
      )}
      {aberto && (
        <div className="mt-2 overflow-auto rounded-lg border border-violet-100 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-violet-50 text-left text-gray-600">
              <tr><th className="px-2 py-1.5">Cliente</th><th className="px-2 py-1.5">Vendedor</th><th className="px-2 py-1.5">Vigência</th>
                <th className="px-2 py-1.5">Situação</th><th className="px-2 py-1.5 text-right">Vendas no mês</th>
                <th className="px-2 py-1.5 text-right">%</th><th className="px-2 py-1.5 text-right">Comissão</th></tr>
            </thead>
            <tbody>
              {data!.clientes.map((c) => (
                <tr key={c.customerId} className="border-t border-gray-100">
                  <td className="px-2 py-1.5 font-medium text-gray-800">{c.cliente}</td>
                  <td className="px-2 py-1.5">{c.vendedor}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{dt(c.inicio)} a {dt(c.fim)}</td>
                  <td className="px-2 py-1.5">{c.status === "vigente" ? "Vigente" : c.status === "expirado" ? "Encerrada (6 meses)" : (c.motivo || "Encerrada")}</td>
                  <td className="px-2 py-1.5 text-right">{brl(c.vendasMes)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{c.percentual}%</td>
                  <td className="px-2 py-1.5 text-right">{brl(c.comissao)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
