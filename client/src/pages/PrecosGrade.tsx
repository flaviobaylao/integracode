import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function brl(v: any) {
  const n = Number(v);
  return isNaN(n) ? "-" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function PrecosGrade() {
  const [q, setQ] = useState("");
  const items = useQuery({ queryKey: ["/api/synced-table", "price_table_items"], queryFn: async () => (await fetch("/api/synced-table/price_table_items?limit=5000", { credentials: "include" })).json() });
  const tables = useQuery({ queryKey: ["/api/synced-table", "price_tables"], queryFn: async () => (await fetch("/api/synced-table/price_tables?limit=2000", { credentials: "include" })).json() });
  const products = useQuery({ queryKey: ["/api/products"], queryFn: async () => (await fetch("/api/products", { credentials: "include" })).json() });

  const tableName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of (tables.data?.rows || [])) m[t.id] = t.name;
    return m;
  }, [tables.data]);
  const productName = useMemo(() => {
    const m: Record<string, string> = {};
    const arr = Array.isArray(products.data) ? products.data : (products.data?.products || []);
    for (const p of arr) m[p.id] = p.name || p.productName || p.description;
    return m;
  }, [products.data]);

  const rows = useMemo(() => {
    const r = (items.data?.rows || []).map((it: any) => ({
      tabela: tableName[it.price_table_id] || it.price_table_id,
      produto: productName[it.product_id] || it.product_id,
      preco: it.price,
    }));
    if (!q.trim()) return r;
    const s = q.toLowerCase();
    return r.filter((x: any) => String(x.tabela).toLowerCase().includes(s) || String(x.produto).toLowerCase().includes(s));
  }, [items.data, tableName, productName, q]);

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-4">Preços (Grade)</h1>
      <div className="flex items-center gap-2 mb-3">
        <Input placeholder="Buscar produto ou tabela..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <span className="text-sm text-gray-500">{rows.length} preços</span>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow><TableHead>Tabela</TableHead><TableHead>Produto</TableHead><TableHead>Preço</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r: any, i: number) => (
              <TableRow key={i}><TableCell>{r.tabela}</TableCell><TableCell>{r.produto}</TableCell><TableCell>{brl(r.preco)}</TableCell></TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-gray-400 py-8">Nenhum preço</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
