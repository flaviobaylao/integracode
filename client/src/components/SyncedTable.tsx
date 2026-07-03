import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw } from "lucide-react";
import { exportToExcel, ExportExcelButton } from "@/lib/tableTools";

function fmt(v: any, col: string) {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  const num = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null);
  if (num !== null && /(price|valor|value|amount|total|discount|saldo|preco)/i.test(col)) {
    return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  if (typeof v === "string" && /(_at$|date|data|valid_)/i.test(col) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v); if (!isNaN(d.getTime())) return d.toLocaleDateString("pt-BR");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function SyncedTable({
  table, hideColumns = [], labels = {}, limit = 2000,
}: { table: string; hideColumns?: string[]; labels?: Record<string, string>; limit?: number }) {
  const [q, setQ] = useState("");
  const [sortCol, setSortCol] = useState<string>("");
  const [sortAsc, setSortAsc] = useState(true);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["/api/synced-table", table, limit],
    queryFn: async () => {
      const r = await fetch(`/api/synced-table/${table}?limit=${limit}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar " + table);
      return r.json();
    },
  });
  const allCols: string[] = (data?.columns || []).map((c: any) => c.column_name);
  const cols = allCols.filter((c) => !hideColumns.includes(c));
  const rows: any[] = data?.rows || [];
  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.toLowerCase();
    return rows.filter((r) => cols.some((c) => String(r[c] ?? "").toLowerCase().includes(s)));
  }, [rows, q, cols]);
  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => String(a[sortCol] ?? "").localeCompare(String(b[sortCol] ?? ""), "pt-BR", { numeric: true }) * dir);
  }, [filtered, sortCol, sortAsc]);
  const handleSort = (c: string) => {
    if (sortCol === c) setSortAsc((v) => !v);
    else { setSortCol(c); setSortAsc(true); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Input placeholder="Buscar..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
        <ExportExcelButton testId={"export-" + table} onClick={() => exportToExcel(sorted.map((r) => Object.fromEntries(cols.map((c) => [labels[c] || c, fmt(r[c], c)]))), "tabela-" + table)} />
        <span className="text-sm text-gray-500">
          {isLoading ? "Carregando..." : `${filtered.length} de ${data?.total ?? rows.length} registros`}
        </span>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((c) => (
                <TableHead key={c} className="cursor-pointer select-none whitespace-nowrap" onClick={() => handleSort(c)}>
                  {labels[c] || c}{sortCol === c ? (sortAsc ? " ↑" : " ↓") : ""}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r, i) => (
              <TableRow key={r.id || i}>
                {cols.map((c) => (<TableCell key={c}>{fmt(r[c], c)}</TableCell>))}
              </TableRow>
            ))}
            {!isLoading && sorted.length === 0 && (
              <TableRow><TableCell colSpan={cols.length} className="text-center text-gray-400 py-8">Nenhum registro</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
