import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { Loader2, FileSpreadsheet } from "lucide-react";

// ---------------------------------------------------------------------------
// Clientes com troca recorrente (política de trocas, 30/10/2026): mesmo cliente +
// mesmo motivo com 2 ou mais trocas nos últimos 60 dias. Vendedor vê só os seus.
// Backend: GET /api/trocas/recorrentes?dias=60
// ---------------------------------------------------------------------------

type Linha = {
  customerId: string; cliente: string | null; motivo: string; motivoLabel: string; qtd: number; ordinal: string;
  nivel: "alta" | "atencao"; intervaloDias: number | null; ultima: string | null; valorTrocado: number;
  ultimaCompra: { data: string | null; valor: number } | null; vendedor: string | null; acao: string | null;
};
const MOTIVOS: Array<[string, string]> = [["todos", "Todos"], ["fermentado", "Fermentado"], ["vencido", "Vencido"], ["lacre", "Lacre"], ["tampa", "Tampa"], ["avaria", "Avaria / deformação / rótulo"]];
const brl = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);

export default function TrocasRecorrentes() {
  const [motivo, setMotivo] = useState("todos");
  const { data, isLoading, isError } = useQuery<{ dias: number; clientes: Linha[] }>({
    queryKey: ["/api/trocas/recorrentes"],
    queryFn: async () => {
      const r = await fetch("/api/trocas/recorrentes?dias=60", { credentials: "include" });
      if (!r.ok) throw new Error("falha");
      return r.json();
    },
  });
  const linhas = useMemo(() => (data?.clientes || []).filter((l) => motivo === "todos" || l.motivo === motivo), [data, motivo]);
  const totalTrocado = linhas.reduce((s, l) => s + l.valorTrocado, 0);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(linhas.map((l) => ({
      Cliente: l.cliente, Motivo: l.motivoLabel, "Trocas (60 dias)": l.qtd, "Intervalo médio (dias)": l.intervaloDias,
      "Última troca": l.ultima, "Valor trocado": l.valorTrocado, "Última compra": l.ultimaCompra?.data || "",
      "Valor última compra": l.ultimaCompra?.valor ?? "", Vendedor: l.vendedor, "Última ação": l.acao,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Trocas recorrentes");
    XLSX.writeFile(wb, `trocas-recorrentes-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Clientes com troca recorrente</h1>
            <p className="text-sm text-gray-600">Mesmo cliente e mesmo motivo, 2 ou mais trocas nos últimos {data?.dias ?? 60} dias</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportar} disabled={!linhas.length}><FileSpreadsheet className="h-4 w-4 mr-1" />Exportar Excel</Button>
            <BackToDashboardButton />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border bg-white p-3"><div className="text-xs text-gray-600">Clientes recorrentes</div><div className="text-2xl font-bold">{new Set(linhas.map((l) => l.customerId)).size}</div></div>
          <div className="rounded-lg border bg-white p-3"><div className="text-xs text-gray-600">3ª troca ou mais</div><div className="text-2xl font-bold">{linhas.filter((l) => l.qtd >= 3).length}</div></div>
          <div className="rounded-lg border bg-white p-3"><div className="text-xs text-gray-600">Valor trocado (60 dias)</div><div className="text-2xl font-bold">{brl(totalTrocado)}</div></div>
        </div>

        <div className="flex flex-wrap gap-2">
          {MOTIVOS.map(([id, label]) => (
            <button key={id} onClick={() => setMotivo(id)}
              className={`h-9 px-3 rounded-full border text-sm font-semibold ${motivo === id ? "bg-green-700 border-green-700 text-white" : "bg-white border-gray-300"}`}>{label}</button>
          ))}
        </div>

        <div className="rounded-lg border bg-white overflow-x-auto">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : isError ? (
            <div className="p-6 text-center text-sm text-red-600">Não foi possível carregar.</div>
          ) : linhas.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">Nenhum cliente com troca recorrente neste período.</div>
          ) : (
            <table className="w-full text-sm min-w-[1000px]">
              <thead className="bg-gray-100 text-left text-gray-700">
                <tr className="[&>th]:px-3 [&>th]:py-2">
                  <th>Cliente</th><th>Motivo</th><th className="text-right">Trocas (60 d)</th><th className="text-right">Intervalo médio</th>
                  <th>Última troca</th><th className="text-right">Valor trocado</th><th>Última compra</th><th>Vendedor</th><th>Última ação</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={`${l.customerId}-${l.motivo}`} className="border-t [&>td]:px-3 [&>td]:py-2 align-top">
                    <td><a className="font-semibold text-green-800 hover:underline" href={`/extrato-cliente?customerId=${encodeURIComponent(l.customerId)}&secao=trocas`} target="_blank" rel="noopener noreferrer">{l.cliente || "—"}</a></td>
                    <td>{l.motivoLabel}</td>
                    <td className="text-right"><span className="inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">{l.ordinal}</span></td>
                    <td className="text-right">{l.intervaloDias != null ? `${l.intervaloDias} dias` : "—"}</td>
                    <td>{l.ultima || "—"}</td>
                    <td className="text-right">{brl(l.valorTrocado)}</td>
                    <td>{l.ultimaCompra ? `${brl(l.ultimaCompra.valor)} · ${l.ultimaCompra.data || ""}` : "—"}</td>
                    <td>{l.vendedor || "—"}</td>
                    <td className="text-xs text-gray-700">{l.acao || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-xs text-gray-500">Clique no cliente para abrir o Extrato no bloco Trocas registradas.</p>
      </div>
    </div>
  );
}
