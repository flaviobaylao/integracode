import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { exportToExcel, ExportExcelButton, DateRangeFilter, dateInRange, useTableSort, SortableTh } from "@/lib/tableTools";

const brl = (v: any) => { const n = Number(v); return isNaN(n) ? "-" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); };
const dt = (v: any) => { if (!v) return "-"; const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("pt-BR"); };

export default function TodasAsContas() {
  const [q, setQ] = useState("");
  const [dtStart, setDtStart] = useState("");
  const [dtEnd, setDtEnd] = useState("");
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort();
  const rec = useQuery({ queryKey: ["/api/financial/receivables"], queryFn: async () => (await fetch("/api/financial/receivables", { credentials: "include" })).json() });
  const pay = useQuery({ queryKey: ["/api/financial/payables"], queryFn: async () => (await fetch("/api/financial/payables", { credentials: "include" })).json() });
  const rows = useMemo(() => {
    const r = (Array.isArray(rec.data) ? rec.data : []).map((x: any) => ({ tipo: "Receber", titulo: x.titleNumber, nome: x.customerName, valor: x.amount, pago: x.amountPaid, venc: x.dueDate, status: x.status }));
    const p = (Array.isArray(pay.data) ? pay.data : []).map((x: any) => ({ tipo: "Pagar", titulo: x.titleNumber, nome: x.supplierName || x.customerName, valor: x.amount, pago: x.amountPaid, venc: x.dueDate, status: x.status }));
    let all = [...r, ...p];
    if (q.trim()) { const s = q.toLowerCase(); all = all.filter((x) => String(x.nome ?? "").toLowerCase().includes(s) || String(x.titulo ?? "").toLowerCase().includes(s)); }
    all = all.filter((x) => dateInRange(x.venc, dtStart, dtEnd));
    return all;
  }, [rec.data, pay.data, q, dtStart, dtEnd]);
  const sortedRows = sortRows(rows, (x: any, k: string) => x[k]);
  const totReceber = rows.filter((x) => x.tipo === "Receber").reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const totPagar = rows.filter((x) => x.tipo === "Pagar").reduce((s, x) => s + (Number(x.valor) || 0), 0);
  const thCls = "sticky top-0 bg-background z-10 px-2 py-2 text-left";
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Todas as Contas</h1>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <Input placeholder="Buscar..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <DateRangeFilter start={dtStart} end={dtEnd} onChange={(s, e) => { setDtStart(s); setDtEnd(e); }} label="Vencimento" testId="daterange-todas" />
        <ExportExcelButton testId="export-todas" onClick={() => exportToExcel(sortedRows.map((x: any) => ({ Tipo: x.tipo, Titulo: x.titulo || "", Nome: x.nome || "", Valor: Number(x.valor) || 0, Pago: Number(x.pago) || 0, Vencimento: dt(x.venc), Status: x.status || "" })), "todas-as-contas")} />
        <Badge className="bg-green-100 text-green-800">A Receber: {brl(totReceber)}</Badge>
        <Badge className="bg-red-100 text-red-800">A Pagar: {brl(totPagar)}</Badge>
        <Badge className="bg-blue-100 text-blue-800">Saldo: {brl(totReceber - totPagar)}</Badge>
        <span className="text-sm text-gray-500">{sortedRows.length} contas</span>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow>
            <SortableTh label="Tipo" colKey="tipo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Titulo" colKey="titulo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Nome" colKey="nome" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Valor" colKey="valor" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Pago" colKey="pago" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Vencimento" colKey="venc" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
            <SortableTh label="Status" colKey="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={thCls} />
          </TableRow></TableHeader>
          <TableBody>
            {sortedRows.map((x, i) => (
              <TableRow key={i}>
                <TableCell><Badge variant="outline" className={x.tipo === "Receber" ? "text-green-700" : "text-red-700"}>{x.tipo}</Badge></TableCell>
                <TableCell>{x.titulo || "-"}</TableCell><TableCell>{x.nome || "-"}</TableCell>
                <TableCell>{brl(x.valor)}</TableCell><TableCell>{brl(x.pago)}</TableCell><TableCell>{dt(x.venc)}</TableCell><TableCell>{x.status || "-"}</TableCell>
              </TableRow>
            ))}
            {sortedRows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-gray-400 py-8">Nenhuma conta</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
