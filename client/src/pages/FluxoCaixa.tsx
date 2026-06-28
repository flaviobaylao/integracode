import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const ym = (v: any) => { if (!v) return "Sem data"; const d = new Date(v); if (isNaN(d.getTime())) return "Sem data"; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export default function FluxoCaixa() {
  const rec = useQuery({ queryKey: ["/api/financial/receivables"], queryFn: async () => (await fetch("/api/financial/receivables", { credentials: "include" })).json() });
  const pay = useQuery({ queryKey: ["/api/financial/payables"], queryFn: async () => (await fetch("/api/financial/payables", { credentials: "include" })).json() });
  const rows = useMemo(() => {
    const map: Record<string, { mes: string; entradas: number; saidas: number }> = {};
    for (const x of (Array.isArray(rec.data) ? rec.data : [])) { const k = ym(x.dueDate); (map[k] = map[k] || { mes: k, entradas: 0, saidas: 0 }).entradas += Number(x.amount) || 0; }
    for (const x of (Array.isArray(pay.data) ? pay.data : [])) { const k = ym(x.dueDate); (map[k] = map[k] || { mes: k, entradas: 0, saidas: 0 }).saidas += Number(x.amount) || 0; }
    return Object.values(map).sort((a, b) => a.mes.localeCompare(b.mes));
  }, [rec.data, pay.data]);
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Fluxo de Caixa</h1>
      <p className="text-sm text-gray-500 mb-3">Projeção por mês de vencimento (entradas = contas a receber; saídas = contas a pagar). Calculado a partir dos dados reais.</p>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow><TableHead>Mês</TableHead><TableHead>Entradas</TableHead><TableHead>Saídas</TableHead><TableHead>Saldo do mês</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.mes}><TableCell>{r.mes}</TableCell><TableCell className="text-green-700">{brl(r.entradas)}</TableCell><TableCell className="text-red-700">{brl(r.saidas)}</TableCell><TableCell className={r.entradas - r.saidas >= 0 ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>{brl(r.entradas - r.saidas)}</TableCell></TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-gray-400 py-8">Sem dados</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
