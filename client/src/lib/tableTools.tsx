import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

// ============================================================================
// Ferramentas compartilhadas p/ telas de tabela (02/jul/2026):
// - useActiveSellers: picklist só com vendedores ATIVOS (Vendas > Vendedores);
//   linhas de vendedor inativo/desconhecido resolvem p/ "Sem Vendedor".
// - MultiSelect: picklist de seleção múltipla com "Selecionar Tudo".
// - exportToExcel: exporta as linhas visíveis/filtradas p/ .xlsx (SheetJS).
// Tudo é camada de exibição: NENHUMA escrita no banco.
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
    const sellers = users.filter((u: any) => u.role === "vendedor" && u.isActive);
    const nameOf = (u: any) => (`${u.firstName || ""} ${u.lastName || ""}`.trim()) || u.email || String(u.id);
    const keyToName = new Map<string, string>();
    const activeNames = new Set<string>();
    for (const u of sellers) {
      const n = nameOf(u);
      activeNames.add(n);
      keyToName.set(String(u.id), n);
      if (u.omieVendorCode) {
        keyToName.set(String(u.omieVendorCode), n);
        keyToName.set("omie-vendor-" + String(u.omieVendorCode), n);
      }
    }
    // aceita id de user, codigo omie, 'omie-vendor-X' OU o proprio nome; fora dos ativos -> Sem Vendedor
    const resolveSeller = (idOrName: any): string => {
      const v = String(idOrName == null ? "" : idOrName).trim();
      if (!v) return SEM_VENDEDOR;
      if (keyToName.has(v)) return keyToName.get(v) as string;
      if (activeNames.has(v)) return v;
      return SEM_VENDEDOR;
    };
    const sellerOptions = Array.from(activeNames).sort((a, b) => a.localeCompare(b)).concat([SEM_VENDEDOR]);
    return { sellerOptions, resolveSeller, activeNames };
  }, [users]);
}

// Picklist de seleção múltipla com "Selecionar Tudo". selected=[] significa "Todos" (sem filtro).
export function MultiSelect(props: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const { label, options, selected, onChange, testId } = props;
  const [open, setOpen] = useState(false);
  const all = selected.length === 0 || selected.length === options.length;
  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
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
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// true se a linha passa no filtro do MultiSelect (selected=[] -> todos)
export function multiMatch(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

// Exporta linhas (objetos chave->valor JA formatados p/ exibicao) p/ .xlsx no navegador.
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

// Botão padrão "Exportar para Excel"
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
