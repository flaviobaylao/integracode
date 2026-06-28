import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const brl = (v: any) => { const n = Number(v); return isNaN(n) ? "-" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); };
const dt = (v: any) => { if (!v) return "-"; const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("pt-BR"); };

export default function ConferenciaPagamentos() {
  const [q, setQ] = useState("");
  const rec = useQuery({ queryKey: ["/api/financial/receivables"], queryFn: async () => (await fetch("/api/financial/receivables", { credentials: "include" })).json() });
  const rows = useMemo(() => {
    let r = (Array.isArray(rec.data) ? rec.data : []).filter((x: any) => Number(x.amountPaid) > 0);
    if (q.trim()) { const s = q.toLowerCase(); r = r.filter((x: any) => String(x.customerName ?? "").toLowerCase().includes(s) || String(x.titleNumber ?? "").toLowerCase().includes(s)); }
    return r;
  }, [rec.data, q]);
  const tot = rows.reduce((s: number, x: any) => s + (Number(x.amountPaid) || 0), 0);
  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Conferência de Pagamentos</h1>
      <p className="text-sm text-gray-500 mb-3">Recebíveis com pagamento registrado (a partir dos dados reais).</p>
      <div className="flex items-center gap-3 mb-3">
        <Input placeholder="Buscar..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Badge className="bg-green-100 text-green-800">Total pago: {brl(tot)}</Badge>
        <span className="text-sm text-gray-500">{rows.length} pagamentos</span>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow><TableHead>Título</TableHead><TableHead>Cliente</TableHead><TableHead>Valor</TableHead><TableHead>Pago</TableHead><TableHead>Forma</TableHead><TableHead>Vencimento</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((x: any, i: number) => (
              <TableRow key={i}><TableCell>{x.titleNumber || "-"}</TableCell><TableCell>{x.customerName || "-"}</TableCell><TableCell>{brl(x.amount)}</TableCell><TableCell>{brl(x.amountPaid)}</TableCell><TableCell>{x.paymentMethod || "-"}</TableCell><TableCell>{dt(x.dueDate)}</TableCell><TableCell>{x.status || "-"}</TableCell></TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-gray-400 py-8">Nenhum pagamento</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
