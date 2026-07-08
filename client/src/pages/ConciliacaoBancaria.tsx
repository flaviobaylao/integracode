import { useEffect, useMemo, useRef, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

// ---------------------------------------------------------------------------
// Conciliação Bancária — Fase 1 (extratos + itens + sugestões) + Fase 2 (ações:
// conciliar dá baixa, ignorar, desfazer). Consome /api/reconciliation/*.
// Conciliar/desfazer são financeiros: confirmação obrigatória + usuário logado.
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
  const [me, setMe] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/reconciliation/filters", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { setAccounts(d.accounts || []); setInstances(d.instances || []); })
      .catch(() => {});
    fetch("/api/auth/user", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((u) => setMe((u && (u.email || u.username || u.name)) || "conciliacao-2.0"))
      .catch(() => setMe("conciliacao-2.0"));
  }, []);

  const loadStatements = () => {
    setLoadingList(true);
    const qs = new URLSearchParams();
    if (instance) qs.set("instanceId", instance);
    if (account) qs.set("accountId", account);
    return fetch("/api/reconciliation/statements?" + qs.toString(), { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setStatements(d.statements || []))
      .catch(() => setStatements([]))
      .finally(() => setLoadingList(false));
  };
  useEffect(() => { loadStatements(); }, [instance, account]);

  const accountOptions = useMemo(
    () => accounts.filter((a) => !instance || a.omie_instance_id === instance),
    [accounts, instance]
  );

  const loadDetail = (s: Statement) => {
    setLoadingDetail(true);
    return fetch(`/api/reconciliation/statements/${s.id}/items`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail({ items: [], matchesByItem: {}, suggestions: {} }))
      .finally(() => setLoadingDetail(false));
  };
  const openStatement = (s: Statement) => { setSelected(s); setDetail(null); loadDetail(s); };
  const refresh = async () => { if (selected) await loadDetail(selected); await loadStatements(); };

  const post = async (url: string, body: any) => {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(j?.error || ("HTTP " + r.status));
    return j;
  };

  const doReconcile = async (item: Item, title: any) => {
    const msg = `Conciliar este lançamento (${fmtMoney(item.amount)}) com o título ${title.title || ""} — ${title.name || ""}?\n\nIsso DÁ BAIXA no título (marca como pago).`;
    if (!window.confirm(msg)) return;
    setBusy(item.id);
    try {
      await post(`/api/reconciliation/items/${item.id}/reconcile`, { by: me, titles: [{ kind: title.kind, id: title.id, amount: Number(item.amount) }] });
      await refresh();
    } catch (e: any) { alert("Erro ao conciliar: " + e.message); }
    finally { setBusy(""); }
  };
  const doIgnore = async (item: Item) => {
    if (!window.confirm(`Ignorar este lançamento (${fmtMoney(item.amount)})? Não dá baixa em nada.`)) return;
    setBusy(item.id);
    try { await post(`/api/reconciliation/items/${item.id}/ignore`, { by: me }); await refresh(); }
    catch (e: any) { alert("Erro ao ignorar: " + e.message); }
    finally { setBusy(""); }
  };
  const doUndo = async (item: Item) => {
    if (!window.confirm(`Desfazer a conciliação/ignore deste lançamento? Reverte a baixa (o título volta a ficar em aberto).`)) return;
    setBusy(item.id);
    try { await post(`/api/reconciliation/items/${item.id}/undo`, { by: me }); await refresh(); }
    catch (e: any) { alert("Erro ao desfazer: " + e.message); }
    finally { setBusy(""); }
  };

  const onPickOfx = () => {
    if (!account) { alert("Selecione a CONTA (no filtro acima) antes de importar o OFX."); return; }
    fileRef.current?.click();
  };
  const onOfxFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const j = await post("/api/reconciliation/import-ofx", { ofxText: text, accountId: account, by: me, fileName: file.name });
      alert(
        `OFX importado: ${j.inserted} lançamento(s) novo(s)` +
        (j.skipped ? `, ${j.skipped} já existia(m)` : "") +
        (j.inserted ? `.\nCréditos ${fmtMoney(j.totalCredits)} · Débitos ${fmtMoney(j.totalDebits)}` : ".")
      );
      await loadStatements();
      if (j.statementId) {
        const s: any = { id: j.statementId, file_name: j.fileName, source: "ofx", start_date: j.period?.start, end_date: j.period?.end, items: j.inserted, reconciled: 0, ignored: 0, account_name: j.account, omie_instance_id: j.instance };
        openStatement(s);
      }
    } catch (err: any) { alert("Erro ao importar OFX: " + err.message); }
    finally { setImporting(false); }
  };

  const doDeleteStatement = async (s: Statement, e?: any) => {
    if (e) e.stopPropagation();
    if ((s.reconciled || 0) > 0) { alert(`Este extrato tem ${s.reconciled} item(ns) já conciliado(s). Desfaça as conciliações antes de remover.`); return; }
    if (!window.confirm(`Remover o extrato "${s.file_name || s.id}" e seus ${s.items} lançamento(s)?\nNão afeta títulos (não há baixa). Você pode reimportar o OFX depois.`)) return;
    setBusy("stmt:" + s.id);
    try {
      await post(`/api/reconciliation/statements/${s.id}/delete`, { by: me });
      if (selected?.id === s.id) { setSelected(null); setDetail(null); }
      await loadStatements();
    } catch (err: any) { alert("Erro ao remover extrato: " + err.message); }
    finally { setBusy(""); }
  };

  const items: Item[] = detail?.items || [];
  const matchesByItem: Record<string, any[]> = detail?.matchesByItem || {};
  const suggestions: Record<string, any> = detail?.suggestions || {};

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold text-green-700">⇄ Conciliação</h1>
        {me ? <span className="text-xs text-gray-400">operador: {me}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={instance} onChange={(e) => { setInstance(e.target.value); setAccount(""); }} className="border rounded px-3 py-2 text-sm">
          <option value="">Todas as instâncias</option>
          {instances.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} className="border rounded px-3 py-2 text-sm">
          <option value="">Todas as contas</option>
          {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept=".ofx,.OFX,text/plain" className="hidden" onChange={onOfxFile} />
        <button onClick={onPickOfx} disabled={importing} title={account ? "Importar arquivo .ofx do banco" : "Selecione a conta antes de importar"} className="px-3 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{importing ? "Importando…" : "⬆ Importar OFX"}</button>
        <button disabled title="Disponível na próxima fase" className="px-3 py-2 text-sm rounded border text-gray-500 cursor-not-allowed">🏦 Importar via BB API</button>
        <button disabled title="Disponível na próxima fase" className="px-3 py-2 text-sm rounded border border-amber-400 text-amber-600 cursor-not-allowed">⚙ Acertar baixas pendentes</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 font-semibold text-sm">Extratos Importados</div>
          <div className="max-h-[72vh] overflow-auto divide-y">
            {loadingList && <div className="p-4 text-sm text-gray-400">Carregando…</div>}
            {!loadingList && statements.length === 0 && <div className="p-4 text-sm text-gray-400">Nenhum extrato.</div>}
            {statements.map((s) => (
              <div key={s.id} className={`relative group ${selected?.id === s.id ? "bg-green-50" : ""}`}>
                <button onClick={() => openStatement(s)} className="w-full text-left px-4 py-3 hover:bg-green-50">
                  <div className="text-sm font-medium truncate pr-6">📄 {s.file_name || s.id}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {fmtDate(s.start_date)} → {fmtDate(s.end_date)} · {s.items} itens · <span className="text-green-600">{s.reconciled} conciliados</span>
                    {s.ignored ? <span className="text-gray-400"> · {s.ignored} ignorados</span> : null}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{s.account_name || ""}{s.omie_instance_id ? ` · ${s.omie_instance_id}` : ""}{s.source ? ` · ${s.source}` : ""}</div>
                </button>
                <button
                  onClick={(e) => doDeleteStatement(s, e)}
                  disabled={busy === "stmt:" + s.id}
                  title={(s.reconciled || 0) > 0 ? "Desfaça as conciliações antes de remover" : "Remover extrato importado"}
                  className="absolute top-2 right-2 text-gray-300 hover:text-red-600 text-sm disabled:opacity-40"
                >🗑</button>
              </div>
            ))}
          </div>
        </div>

        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 font-semibold text-sm">
            {selected ? `${selected.file_name || "Extrato"} — ${selected.items} itens` : "Selecione um extrato"}
          </div>
          {!selected && <div className="p-8 text-center text-gray-400">Selecione um extrato na lista ao lado</div>}
          {selected && loadingDetail && <div className="p-8 text-center text-gray-400">Carregando itens…</div>}
          {selected && !loadingDetail && (
            <div className="max-h-[72vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white border-b">
                  <tr className="text-left text-xs text-gray-500">
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2 text-right">Valor</th>
                    <th className="px-3 py-2">Descrição</th>
                    <th className="px-3 py-2">Situação</th>
                    <th className="px-3 py-2">Conciliação / Sugestão</th>
                    <th className="px-3 py-2">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((it) => {
                    const ms = matchesByItem[it.id] || [];
                    const sg = suggestions[it.id];
                    const isBusy = busy === it.id;
                    const st = it.reconciliation_status || "pending";
                    return (
                      <tr key={it.id} className="align-top">
                        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(it.transaction_date)}</td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${it.type === "C" ? "text-green-600" : "text-red-600"}`}>
                          {it.type === "C" ? "+" : "−"}{fmtMoney(it.amount)}
                        </td>
                        <td className="px-3 py-2 max-w-[260px]">
                          <div className="truncate" title={it.description}>{it.description}</div>
                          {it.document ? <div className="text-[11px] text-gray-400">{it.document}</div> : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap"><StatusBadge s={st} /></td>
                        <td className="px-3 py-2">
                          {ms.length > 0 && (
                            <div className="space-y-1">
                              {ms.map((m, idx) => (
                                <div key={idx} className="text-xs">
                                  <span className="text-gray-500">{m.receivable_id ? "Receber" : "Pagar"} </span>
                                  <span className="font-medium">{m.r_title || m.p_title || "—"}</span>{" "}
                                  <span className="text-gray-600">{m.r_name || m.p_name || ""}</span>{" "}
                                  <span className="text-gray-400">({fmtMoney(m.title_amount_settled || m.amount)})</span>
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
                                <div key={idx} className="text-xs text-gray-600 flex items-center gap-2">
                                  <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">título</span>
                                  <span>{t.kind === "receivable" ? "Receber" : "Pagar"} {t.title || "—"} · {t.name || ""} · {fmtMoney(t.amount)}{t.instance ? ` · ${t.instance}` : ""}</span>
                                  {st === "pending" && (
                                    <button disabled={isBusy} onClick={() => doReconcile(it, t)} className="px-2 py-0.5 rounded bg-green-600 text-white text-[11px] disabled:opacity-50">Conciliar</button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {ms.length === 0 && !sg && st === "pending" && <span className="text-xs text-gray-300">sem sugestão</span>}
                          {st === "ignored" && it.notes && <span className="text-[11px] text-gray-400">{it.notes.split("|")[0]}</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {st === "pending" && (
                            <button disabled={isBusy} onClick={() => doIgnore(it)} className="px-2 py-0.5 rounded border text-gray-600 text-[11px] disabled:opacity-50">Ignorar</button>
                          )}
                          {(st === "reconciled" || st === "ignored") && (
                            <button disabled={isBusy} onClick={() => doUndo(it)} className="px-2 py-0.5 rounded border border-red-300 text-red-600 text-[11px] disabled:opacity-50">Desfazer</button>
                          )}
                          {isBusy && <span className="text-[11px] text-gray-400 ml-1">…</span>}
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
