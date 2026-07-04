import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";

// ============================================================================
// Ferramentas compartilhadas p/ telas de tabela.
// - useActiveSellers: picklist de vendedores ATIVOS. Externos (role 'vendedor')
//   + Internos/telemarketing que vendem (role 'telemarketing' COM omieVendorCode).
//   Linhas de vendedor inativo/desconhecido resolvem p/ "Sem Vendedor".
// - MultiSelect: picklist de selecao multipla com "Selecionar Tudo" (+grupos).
// - DateRangeFilter/dateInRange: filtro por periodo (De/Ate).
// - useTableSort: ordenacao A-Z/Z-A por coluna.
// - exportToExcel: exporta as linhas visiveis/filtradas p/ .xlsx (SheetJS).
// Tudo e camada de exibicao: NENHUMA escrita no banco.
// (05/jul/2026) Vendedor = externo; Telemarketing = interno (ambos vendem,
// mesmas premissas). Os internos passam a aparecer no seletor, agrupados.
// ============================================================================

export const SEM_VENDEDOR = "Sem Vendedor";

export function useActiveSellers() {
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/users", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (alive) setUsers(Array.isArray(d) ? d : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return useMemo(() => {
    const nameOf = (u: any) => (`${u.firstName || ""} ${u.lastName || ""}`.trim()) || u.email || String(u.id);
    const externos = users.filter((u: any) => u.role === "vendedor" && u.isActive);
    const internos = users.filter((u: any) => u.role === "telemarketing" && u.isActive && u.omieVendorCode);
    const keyToName = new Map<string, string>();
    const activeNames = new Set<string>();
    const externosNames: string[] = [];
    const internosNames: string[] = [];
    const register = (u: any, bucket: string[]) => {
      const n = nameOf(u);
      if (!activeNames.has(n)) bucket.push(n);
      activeNames.add(n);
      keyToName.set(String(u.id), n);
      if (u.omieVendorCode) {
        keyToName.set(String(u.omieVendorCode), n);
        keyToName.set("omie-vendor-" + String(u.omieVendorCode), n);
      }
    };
    for (const u of externos) register(u, externosNames);
    for (const u of internos) register(u, internosNames);
    const resolveSeller = (idOrName: any): string => {
      const v = String(idOrName == null ? "" : idOrName).trim();
      if (!v) return SEM_VENDEDOR;
      if (keyToName.has(v)) return keyToName.get(v) as string;
      if (activeNames.has(v)) return v;
      return SEM_VENDEDOR;
    };
    externosNames.sort((a, b) => a.localeCompare(b));
    internosNames.sort((a, b) => a.localeCompare(b));
    const sellerOptions = [...externosNames, ...internosNames, SEM_VENDEDOR];
    const sellerGroups = [
      { label: "Vendedores", options: externosNames },
      { label: "Telemarketing", options: internosNames },
      { label: "", options: [SEM_VENDEDOR] },
    ].filter((g) => g.options.length > 0);
    const kindOf = (name: string): string =>
      internosNames.includes(name) ? "telemarketing" : externosNames.includes(name) ? "vendedor" : "";
    return { sellerOptions, sellerGroups, resolveSeller, activeNames, kindOf };
  }, [users]);
}

export function MultiSelect(props: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  testId?: string;
  groups?: { label: string; options: string[] }[];
}) {
  const { label, options, selected, onChange, testId, groups } = props;
  const [open, setOpen] = useState(false);
  const all = selected.length === 0 || selected.length === options.length;
  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  const renderOption = (o: string) => (
    <label key={o} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer">
      <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
      <span className="truncate">{o}</span>
    </label>
  );
  return (
    <div className="relative inline-block text-left align-middle" data-testid={testId || "multi-select"}>
      <button
        type="button"
        className="px-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700 min-w-[170px] text-left"
        onClick={() => setOpen(!open)}
      >
        {label}: {all ? "Todos" : selected.length === 1 ? selected[0] : `${selected.length} selecionados`}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-72 max-h-72 overflow-auto border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 shadow-lg p-2">
            <label className="flex items-center gap-2 px-2 py-1 text-sm font-semibold cursor-pointer">
              <input
                type="checkbox"
                checked={selected.length === options.length}
                onChange={() => onChange(selected.length === options.length ? [] : [...options])}
              />
              Selecionar Tudo
            </label>
            <div className="border-t my-1 dark:border-gray-700" />
            {groups && groups.length
              ? groups.map((g) => (
                  <div key={g.label || "grp"}>
                    {g.label ? (
                      <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        {g.label}
                      </div>
                    ) : (
                      <div className="border-t my-1 dark:border-gray-700" />
                    )}
                    {g.options.map(renderOption)}
                  </div>
                ))
              : options.map(renderOption)}
          </div>
        </>
      )}
    </div>
  );
}

export function multiMatch(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

// dateInRange: true se `value` cai entre start/end (ambos 'yyyy-mm-dd', pode ser "").
export function dateInRange(value: any, start: string, end: string): boolean {
  if (!start && !end) return true;
  if (!value) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  const ymd = d.toISOString().slice(0, 10);
  if (start && ymd < start) return false;
  if (end && ymd > end) return false;
  return true;
}

export function DateRangeFilter(props: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  label?: string;
  testId?: string;
}) {
  const { start, end, onChange, label, testId } = props;
  return (
    <div className="inline-flex items-center gap-1 align-middle text-sm" data-testid={testId || "date-range-filter"}>
      {label ? <span className="text-gray-600 dark:text-gray-300">{label}:</span> : null}
      <input
        type="date"
        value={start}
        onChange={(e) => onChange(e.target.value, end)}
        className="px-2 py-1.5 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700"
        aria-label="Data inicial"
      />
      <span className="text-gray-400">-</span>
      <input
        type="date"
        value={end}
        onChange={(e) => onChange(start, e.target.value)}
        className="px-2 py-1.5 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700"
        aria-label="Data final"
      />
      {start || end ? (
        <button
          type="button"
          onClick={() => onChange("", "")}
          className="px-2 py-1.5 border rounded-md text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Limpar periodo"
        >
          Limpar
        </button>
      ) : null}
    </div>
  );
}

// Hook de ordenacao A-Z/Z-A por coluna.
export function useTableSort(initialKey = "", initialDir: "asc" | "desc" = "asc") {
  const [sortKey, setSortKey] = useState<string>(initialKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialDir);
  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };
  function sortRows<T>(rows: T[], getValue: (row: T, key: string) => any): T[] {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = getValue(a, sortKey);
      const vb = getValue(b, sortKey);
      const na = typeof va === "number" ? va : parseFloat(String(va).replace(/[^0-9.,-]/g, "").replace(",", "."));
      const nb = typeof vb === "number" ? vb : parseFloat(String(vb).replace(/[^0-9.,-]/g, "").replace(",", "."));
      if (!isNaN(na) && !isNaN(nb) && String(va).trim() !== "" && String(vb).trim() !== "") return (na - nb) * dir;
      return String(va == null ? "" : va).localeCompare(String(vb == null ? "" : vb), "pt-BR") * dir;
    });
  }
  return { sortKey, sortDir, toggleSort, sortRows };
}

// Cabecalho de coluna CLICAVEL (ordena A-Z / Z-A). Usar em TODAS as colunas
// EXCETO a de "Acoes" (que fica como <th> comum). Pareado com useTableSort.
export function SortableTh(props: {
  label: string;
  colKey: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const active = props.sortKey === props.colKey;
  const alignCls = props.align === "right" ? "justify-end" : props.align === "center" ? "justify-center" : "justify-start";
  return (
    <th
      className={`cursor-pointer select-none ${props.className || ""}`}
      onClick={() => props.onSort(props.colKey)}
      title="Ordenar A-Z"
      aria-sort={active ? (props.sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className={`inline-flex items-center gap-1 ${alignCls}`}>
        <span>{props.label}</span>
        {active ? (
          props.sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </span>
    </th>
  );
}

export function exportToExcel(rows: Record<string, any>[], filename: string) {
  try {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dados");
    XLSX.writeFile(wb, /\.xlsx$/i.test(filename) ? filename : filename + ".xlsx");
  } catch (e) {
    console.error("exportToExcel:", e);
    alert("Falha ao exportar para Excel.");
  }
}

export function ExportExcelButton(props: { onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="px-3 py-2 border rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-700"
      data-testid={props.testId || "button-export-excel"}
    >
      Exportar para Excel
    </button>
  );
}
