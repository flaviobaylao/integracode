import { useEffect, useMemo, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

// ---------------------------------------------------------------------------
// Conciliação Bancária — FASE 1 (read-only). Reconstrói a tela do 1.0:
// Extratos Importados (esquerda) + itens do extrato com status, matches e
// SUGESTÕES (direita). Consome /api/reconciliation/*. Sem escrita ainda —
// os botões Importar OFX / BB API / Acertar baixas pendentes chegam na Fase 2.
// ---------------------------------------------------------------------------

type Account = { id: string; name: string; omie_instance_id: string | null };
type Statement = {
  id: string; file_name: string; source: string | null;
  start_date: string | null; end_date: string | null;
  items: number; reconciled: number; ignored: number;
  account_name: string | null; omie_instance_id: string | null;
};
type Item = {
  id: string; transaction_date: string; amount: string; type: string;
  description: string; document: string; reconciliation_status: string | null;
  matched_at: string | null; notes: string | null;
};

const fmtDate = (d: any): string => {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
};
const fmtMoney = (v: any): string => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(/[^0-9.-]/g, ""));
  return (isNaN(n) ? 0 : n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};

function StatusBadge({ s }: { s: string | null }) {
  const map: Record<string, string> = {
    reconciled: "bg-green-100 text-green-700",
    ignored: "bg-gray-200 text-gray-600",
    pending: "bg-amber-100 text-amber-700",
  };
  const label: Record<string, string> = { reconciled: "Conciliado", ignored: "Ignorado", pending: "Pendente" };
  const k = s || "pending";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[k] || map.pending}`}>{label[k] || "Pendente"}</span>;
}

export default function ConciliacaoBancaria() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [instances, setInstances] = useState<string[]>([]);
  const [instance, setInstance] = useState("");
  const [account, setAccount] = useState("");
  const [statements, setStatements] = useState<Statement[]>([]);
  const [selected, setSelected] = useState<Statement | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    fetch("/api/reconciliation/filters", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { setAccounts(d.accounts || []); setInstances(d.instances || []); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoadingList(true);
    const qs = new URLSearchParams();
    if (instance) qs.set("instanceId", instance);
    if (account) qs.set("accountId", account);
    fetch("/api/reconciliation/statements?" + qs.toString(), { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setStatements(d.statements || []))
      .catch(() => setStatements([]))
      .finally(() => setLoadingList(false));
  }, [instance, account]);

  const accountOptions = useMemo(
    () => accounts.filter((a) => !instance || a.omie_instance_id === instance),
    [accounts, instance]
  );

  const openStatement = (s: Statement) => {
    setSelected(s);
    setDetail(null);
    setLoadingDetail(true);
    fetch(`/api/reconciliation/statements/${s.id}/items`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail({ items: [], matchesByItem: {}, suggestions: {} }))
      .finally(() => setLoadingDetail(false));
  };

  const items: Item[] = detail?.items || [];
  const matchesByItem: Record<string, any[]> = detail?.matchesByItem || {};
  const suggestions: Record<string, any> = detail?.suggestions || {};

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold text-green-700">⇄ Conciliação</h1>
      </div>

      {/* Filtros + ações */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={instance}
          onChange={(e) => { setInstance(e.target.value); setAccount(""); }}
          className="border rounded px-3 py-2 text-sm"
        >
          <option value="">Todas as instâncias</option>
          {instances.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
        >
          <option value="">Todas as contas</option>
          {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="flex-1" />
        <button disabled title="Disponível na Fase 2" className="px-3 py-2 text-sm rounded bg-blue-500/50 text-white cursor-not-allowed">⬆ Importar OFX</button>
        <button disabled title="Disponível na Fase 2" className="px-3 py-2 text-sm rounded border text-gray-500 cursor-not-allowed">🏦 Importar via BB API</button>
        <button disabled title="Disponível na Fase 2" className="px-3 py-2 text-sm rounded border border-amber-400 text-amber-600 cursor-not-allowed">⚙ Acertar baixas pendentes</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        {/* Extratos importados */}
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 font-semibold text-sm">Extratos Importados</div>
          <div className="max-h-[70vh] overflow-auto divide-y">
            {loadingList && <div className="p-4 text-sm text-gray-400">Carregando…</div>}
            {!loadingList && statements.length === 0 && <div className="p-4 text-sm text-gray-400">Nenhum extrato.</div>}
            {statements.map((s) => (
              <button
                key={s.id}
                onClick={() => openStatement(s)}
                className={`w-full text-left px-4 py-3 hover:bg-green-50 ${selected?.id === s.id ? "bg-green-50" : ""}`}
              >
                <div className="text-sm font-medium truncate">📄 {s.file_name || s.id}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {fmtDate(s.start_date)} → {fmtDate(s.end_date)} · {s.items} itens · <span className="text-green-600">{s.reconciled} conciliados</span>
                  {s.ignored ? <span className="text-gray-400"> · {s.ignored} ignorados</span> : null}
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">{s.account_name || ""}{s.omie_instance_id ? ` · ${s.omie_instance_id}` : ""}{s.source ? ` · ${s.source}` : ""}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Itens do extrato selecionado */}
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 font-semibold text-sm">
            {selected ? `${selected.file_name || "Extrato"} — ${selected.items} itens` : "Selecione um extrato"}
          </div>
          {!selected && <div className="p-8 text-center text-gray-400">Selecione um extrato na lista ao lado</div>}
          {selected && loadingDetail && <div className="p-8 text-center text-gray-400">Carregando itens…</div>}
          {selected && !loadingDetail && (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white border-b">
                  <tr className="text-left text-xs text-gray-500">
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2 text-right">Valor</th>
                    <th className="px-3 py-2">Descrição</th>
                    <th className="px-3 py-2">Situação</th>
                    <th className="px-3 py-2">Conciliação / Sugestão</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((it) => {
                    const ms = matchesByItem[it.id] || [];
                    const sg = suggestions[it.id];
                    return (
                      <tr key={it.id} className="align-top">
                        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(it.transaction_date)}</td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${it.type === "C" ? "text-green-600" : "text-red-600"}`}>
                          {it.type === "C" ? "+" : "−"}{fmtMoney(it.amount)}
                        </td>
                        <td className="px-3 py-2 max-w-[280px]">
                          <div className="truncate" title={it.description}>{it.description}</div>
                          {it.document ? <div className="text-[11px] text-gray-400">{it.document}</div> : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap"><StatusBadge s={it.reconciliation_status} /></td>
                        <td className="px-3 py-2">
                          {ms.length > 0 && (
                            <div className="space-y-1">
                              {ms.map((m, idx) => (
                                <div key={idx} className="text-xs">
                                  <span className="text-gray-500">{m.receivable_id ? "Receber" : "Pagar"} </span>
                                  <span className="font-medium">{m.r_title || m.p_title || "—"}</span>
                                  {" "}<span className="text-gray-600">{m.r_name || m.p_name || ""}</span>
                                  {" "}<span className="text-gray-400">({fmtMoney(m.title_amount_settled || m.amount)})</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {ms.length === 0 && sg && (
                            <div className="space-y-1">
                              {sg.counterparty && (
                                <div className="text-xs">
                                  <span className="inline-block px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 mr-1">sugestão</span>
                                  <span className="font-medium">{sg.counterparty.name}</span>
                                  {sg.counterparty.category ? <span className="text-gray-500"> · {sg.counterparty.category}</span> : null}
                                  <span className="text-gray-400"> · {sg.counterparty.via === "cpf_cnpj" ? "por documento" : "por descrição"} ({sg.counterparty.matchCount}×)</span>
                                </div>
                              )}
                              {(sg.titles || []).map((t: any, idx: number) => (
                                <div key={idx} className="text-xs text-gray-600">
                                  <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 mr-1">título</span>
                                  {t.kind === "receivable" ? "Receber" : "Pagar"} {t.title || "—"} · {t.name || ""} · {fmtMoney(t.amount)}{t.instance ? ` · ${t.instance}` : ""}
                                </div>
                              ))}
                            </div>
                          )}
                          {ms.length === 0 && !sg && it.reconciliation_status === "pending" && (
                            <span className="text-xs text-gray-300">sem sugestão</span>
                          )}
                          {it.reconciliation_status === "ignored" && it.notes && (
                            <span className="text-[11px] text-gray-400">{it.notes.split("|")[0]}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
