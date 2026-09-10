// client/src/components/ClientesAtivos.tsx
// Aba "Clientes Ativos": lista de clientes ativos com penúltimo/último pedido (NF-e
// de venda), periodicidade, variação % e minigráfico Jan/26 -> hoje.
// Filtros: Vendedor, Periodicidade, Município (multi-seleção) e data (de/para).
// Redes agrupadas (recolher/expandir), cabeçalho fixo, ordenação A-Z por coluna,
// seleção múltipla de linhas. Consome GET /api/dashboard2/clientes-ativos.
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect, multiMatch, DateRangeFilter, useTableSort, SortableTh } from "@/lib/tableTools";

type Row = {
  id: string; nome: string; municipio: string; vendedor: string; periodicidade: string;
  redeId: string; redeNome: string; ultimo: number; ultimoData: string;
  penultimo: number; penultimoData: string; variacao: number | null; serie: number[];
};
type Resp = { asOf: string; months: string[]; rows: Row[] };

function brl(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function Spark({ serie }: { serie: number[] }) {
  const w = 120, h = 28, pad = 3;
  const n = serie.length;
  if (n <= 1) return <svg width={w} height={h} />;
  const mx = Math.max(1, ...serie);
  const pts = serie.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / (n - 1);
    const y = h - pad - (v / mx) * (h - 2 * pad);
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const last = serie[n - 1], prev = serie[n - 2] || 0;
  const col = last >= prev ? "#16a34a" : "#dc2626";
  return (
    <svg width={w} height={h} className="mx-auto block">
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function ClientesAtivos() {
  const [de, setDe] = useState("");
  const [para, setPara] = useState("");
  const qs = de || para ? "?de=" + encodeURIComponent(de) + "&para=" + encodeURIComponent(para) : "";
  const { data, isLoading } = useQuery<Resp>({ queryKey: ["/api/dashboard2/clientes-ativos" + qs] });
  const rows: Row[] = (data && data.rows) || [];

  const [fVend, setFVend] = useState<string[]>([]);
  const [fPer, setFPer] = useState<string[]>([]);
  const [fMun, setFMun] = useState<string[]>([]);
  const [qCli, setQCli] = useState("");
  const [qRede, setQRede] = useState("");
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [openRedes, setOpenRedes] = useState<Record<string, boolean>>({});

  const optVend = useMemo(() => [...new Set(rows.map((r) => r.vendedor).filter(Boolean))].sort(), [rows]);
  const optPer = useMemo(() => [...new Set(rows.map((r) => r.periodicidade).filter(Boolean))].sort(), [rows]);
  const optMun = useMemo(() => [...new Set(rows.map((r) => r.municipio).filter(Boolean))].sort(), [rows]);

  const filtered = useMemo(
    () => rows.filter((r) =>
      multiMatch(fVend, r.vendedor) && multiMatch(fPer, r.periodicidade) && multiMatch(fMun, r.municipio)
      && (!qCli.trim() || (r.nome || "").toLowerCase().includes(qCli.trim().toLowerCase()))
      && (!qRede.trim() || (r.redeNome || "").toLowerCase().includes(qRede.trim().toLowerCase()))
    ),
    [rows, fVend, fPer, fMun, qCli, qRede]
  );

  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort("nome", "asc");

  const grouped = useMemo(() => {
    const redes: Record<string, { nome: string; rows: Row[] }> = {};
    const avulsos: Row[] = [];
    for (const r of filtered) {
      if (r.redeId) (redes[r.redeId] = redes[r.redeId] || { nome: r.redeNome || "Rede", rows: [] }).rows.push(r);
      else avulsos.push(r);
    }
    return { redes, avulsos };
  }, [filtered]);

  const allVisibleIds = filtered.map((r) => r.id);
  const allSel = allVisibleIds.length > 0 && allVisibleIds.every((id) => sel[id]);
  const selCount = allVisibleIds.filter((id) => sel[id]).length;
  function toggleAll() {
    const next: Record<string, boolean> = { ...sel };
    const target = !allSel;
    for (const id of allVisibleIds) next[id] = target;
    setSel(next);
  }
  function toggleOne(id: string) { setSel((s) => ({ ...s, [id]: !s[id] })); }

  function expandAll() {
    const n: Record<string, boolean> = {};
    for (const rk of Object.keys(grouped.redes)) n[rk] = true;
    setOpenRedes(n);
  }
  function collapseAll() {
    const n: Record<string, boolean> = {};
    for (const rk of Object.keys(grouped.redes)) n[rk] = false;
    setOpenRedes(n);
  }

  const colCount = 7;

  function Rowline({ r, indent }: { r: Row; indent?: boolean }) {
    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50">
        <td className="px-2 py-1 align-top"><input type="checkbox" checked={!!sel[r.id]} onChange={() => toggleOne(r.id)} /></td>
        <td className={"px-2 py-1 text-gray-900 " + (indent ? "pl-8" : "")}>
          {r.nome}
          <div className="text-[10px] text-gray-500">{r.municipio}{r.vendedor ? " - " + r.vendedor : ""}</div>
        </td>
        <td className="px-2 py-1 text-center whitespace-nowrap">{r.penultimo > 0 ? brl(r.penultimo) : "-"}</td>
        <td className="px-2 py-1 text-center whitespace-nowrap">{r.ultimo > 0 ? brl(r.ultimo) : "-"}</td>
        <td className="px-2 py-1 text-center whitespace-nowrap">{r.periodicidade || "-"}</td>
        <td className={"px-2 py-1 text-center whitespace-nowrap " + (r.variacao == null ? "text-gray-400" : r.variacao >= 0 ? "text-emerald-600" : "text-red-600")}>
          {r.variacao == null ? "-" : (r.variacao > 0 ? "+" : "") + r.variacao + "%"}
        </td>
        <td className="px-2 py-1 text-center"><Spark serie={r.serie} /></td>
      </tr>
    );
  }

  const redeKeys = Object.keys(grouped.redes);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">Variação de Vendas</CardTitle>
        <div className="text-xs text-gray-500 mt-1">
          Penúltimo x último pedido (NF-e de venda), periodicidade, variação e minigráfico Jan/26 → hoje.
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <MultiSelect label="Vendedor" options={optVend} selected={fVend} onChange={setFVend} />
          <MultiSelect label="Periodicidade" options={optPer} selected={fPer} onChange={setFPer} />
          <MultiSelect label="Município" options={optMun} selected={fMun} onChange={setFMun} />
          <input type="text" value={qCli} onChange={(e) => setQCli(e.target.value)} placeholder="Buscar cliente..." className="text-sm border border-gray-300 rounded-md px-2 py-1.5 w-40" />
          <input type="text" value={qRede} onChange={(e) => setQRede(e.target.value)} placeholder="Buscar rede..." className="text-sm border border-gray-300 rounded-md px-2 py-1.5 w-36" />
          <DateRangeFilter start={de} end={para} onChange={(s, e) => { setDe(s); setPara(e); }} label="Pedidos entre" />
          <span className="text-xs text-gray-500">{filtered.length} clientes{selCount > 0 ? " - " + selCount + " selecionados" : ""}</span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={expandAll} className="text-xs text-gray-500 hover:text-indigo-600">Expandir tudo</button>
            <span className="text-gray-300">·</span>
            <button type="button" onClick={collapseAll} className="text-xs text-gray-500 hover:text-indigo-600">Recolher tudo</button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto max-h-[70vh] border border-gray-200 rounded-lg">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr className="border-b border-gray-200 text-left">
                <th className="px-2 py-2"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
                <SortableTh label="Nome Fantasia" colKey="nome" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="px-2 py-2" />
                <SortableTh label="Penúltimo R$" colKey="penultimo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" className="px-2 py-2 text-center" />
                <SortableTh label="Último R$" colKey="ultimo" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" className="px-2 py-2 text-center" />
                <SortableTh label="Periodicidade" colKey="periodicidade" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" className="px-2 py-2 text-center" />
                <SortableTh label="Variação %" colKey="variacao" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" className="px-2 py-2 text-center" />
                <th className="px-2 py-2 text-center text-gray-500 font-medium whitespace-nowrap">Jan/26 → hoje</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={colCount} className="text-center text-gray-500 py-8">Carregando...</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={colCount} className="text-center text-gray-500 py-8">Nenhum cliente.</td></tr>}
              {redeKeys.map((rk) => {
                const g = grouped.redes[rk];
                const open = openRedes[rk] !== false;
                const total = g.rows.reduce((a, x) => a + (x.ultimo || 0), 0);
                return (
                  <Fragment key={"rede-" + rk}>
                    <tr className="bg-indigo-50 border-b border-indigo-100 cursor-pointer" onClick={() => setOpenRedes((o) => ({ ...o, [rk]: !open }))}>
                      <td className="px-2 py-1"></td>
                      <td className="px-2 py-1 font-semibold text-indigo-800" colSpan={colCount - 2}>
                        {open ? "▾" : "▸"} Rede: {g.nome} ({g.rows.length})
                      </td>
                      <td className="px-2 py-1 text-right text-indigo-800 font-medium whitespace-nowrap">{brl(total)}</td>
                    </tr>
                    {open && sortRows(g.rows, (row, key) => (row as any)[key]).map((r: Row) => <Rowline key={r.id} r={r} indent />)}
                  </Fragment>
                );
              })}
              {sortRows(grouped.avulsos, (row, key) => (row as any)[key]).map((r: Row) => <Rowline key={r.id} r={r} />)}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
