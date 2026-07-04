import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportToExcel, ExportExcelButton, DateRangeFilter, dateInRange, useTableSort, SortableTh } from "@/lib/tableTools";

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const ym = (v: any) => { if (!v) return "Sem data"; const d = new Date(v); if (isNaN(d.getTime())) return "Sem data"; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export default function FluxoCaixa() {
  const [dtStart, setDtStart] = useState("");
  const [dtEnd, setDtEnd] = useState("");
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort();
  const rec = useQuery({ queryKey: ["/api/financial/receivables"], queryFn: async () => (await fetch("/api/financial/receivables", { credentials: "include" })).json() });
  const pay = useQuery({ queryKey: ["/api/financial/payables"], queryFn: async () => (await fetch("/api/financial/payables", { credentials: "include" })).json() });
  const rows = useMemo(() => {
    const map: Record<string, { mes: string; entradas: number; saidas: number; saldo: number }> = {};
    for (const x of (Array.isArray(rec.data) ? rec.data : [])) { if (!dateInRange(x.dueDate, dtStart, dtEnd)) continue; const k = ym(x.dueDate); (map[k] = map[k] || { mes: k, entradas: 0, saidas: 0, saldo: 0 }).entradas += Number(x.amount) || 0; }
    for (const x of (Array.isArray(pay.data) ? pay.data : [])) { if (!dateInRange(x.dueDate, dtStart, dtEnd)) continue; const k = ym(x.dueDate); (map[k] = map[k] || { mes: k, entradas: 0, saidas: 0, saldo: 0 }).saidas += Number(x.amount) || 0; }
    const arr = Object.values(map);
    for (const m of arr) m.saldo = m.entradas - m.saidas;
    return arr.sort((a, b) => a.mes.localeCompare(b.mes));
  }, [rec.data, pay.data, dtStart, dtEnd]);
  const sortedRows = sortRows(rows, (x: any, k: string) => x[k]);
  const thCls = "sticky top-0 bg-background z-10 px-2 py-2 text-left";
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Fluxo de Caixa</h1>
      <p className="text-sm text-gray-500 mb-3">Projecao por mes de vencimento (entradas = contas a receber; saidas = contas a pagar). Calculado a partir dos dados reais.</p>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <DateRangeFilter start={dtStart} end={dtEnd} onChange={(s, e) => { setDtStart(s); setDtEnd(e); }} label="Vencimento" testId="daterange-fluxo" />
        <ExportExcelButton testId="export-fluxo" onClick={() => exportToExcel(sortedRows.map((r: any) => ({ Mes: r.mes, Entradas: r.entradas, Saidas: r.saidas, Saldo: r.entradas - r.saidas })), "fluxo-de-caixa")} />
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow>
            <SortableTh label="Mes" colKey="mes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Entradas" colKey="entradas" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Saidas" colKey="saidas" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Saldo do mes" colKey="saldo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
          </TableRow></TableHeader>
          <TableBody>
            {sortedRows.map((r) => (
              <TableRow key={r.mes}><TableCell>{r.mes}</TableCell><TableCell className="text-green-700">{brl(r.entradas)}</TableCell><TableCell className="text-red-700">{brl(r.saidas)}</TableCell><TableCell className={r.entradas - r.saidas >= 0 ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>{brl(r.entradas - r.saidas)}</TableCell></TableRow>
            ))}
            {sortedRows.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-gray-400 py-8">Sem dados</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
