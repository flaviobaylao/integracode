import { useEffect, useMemo, useRef, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

// ---------------------------------------------------------------------------
// Conciliação Bancária — paridade com o 1.0: extratos + lançamentos (paginação/
// ordenação/filtro) + modal "Conciliar Transação" (carrinho com juros/desconto,
// abas Sugestões / Buscar Título, Δ deve zerar). Conciliar dá baixa (financeiro).
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
  description: string; document: string; origin_name?: string | null; reconciliation_status: string | null;
  matched_at: string | null; notes: string | null;
};
type Title = { kind: string; id: string; title: string | null; name: string | null; document?: string | null; amount: any; due?: any; instance?: string | null; score?: number; motivos?: string[]; restante?: any };
type CartLine = { kind: string; id: string; title: string | null; name: string | null; amount: number; interest: number; discount: number };

const fmtDate = (d: any): string => {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
};
const num = (v: any): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
};
const fmtMoney = (v: any): string => num(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

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

  // filtro / ordenação / paginação da tabela de lançamentos
  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [sortKey, setSortKey] = useState<"date" | "name" | "amount" | "status" | "title">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // modal de conciliação
  const [modalItem, setModalItem] = useState<Item | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tab, setTab] = useState<"sug" | "search" | "novo">("sug");
  const [novo, setNovo] = useState<any>({});
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<Title[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // FASE 3.4c - autocomplete de fornecedor (cadastro) e categoria (DRE) no Criar Novo
  const [supSug, setSupSug] = useState<any[]>([]);
  const [supNovo, setSupNovo] = useState(false);
  const [catSug, setCatSug] = useState<any[]>([]);
  const supTimer = useRef<any>(null);
  const catTimer = useRef<any>(null);
  const buscarFornecedores = (v: string) => {
    if (supTimer.current) clearTimeout(supTimer.current);
    const q = v.trim();
    if (q.length < 2) { setSupSug([]); setSupNovo(false); return; }
    supTimer.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/reconciliation/suppliers/search?q=" + encodeURIComponent(q), { credentials: "include" });
        const j = await r.json();
        const list = j.suppliers || [];
        setSupSug(list);
        setSupNovo(list.length === 0 && q.length >= 3);
      } catch { setSupSug([]); }
    }, 250);
  };
  const buscarCategorias = (v: string) => {
    if (catTimer.current) clearTimeout(catTimer.current);
    const q = v.trim();
    if (!q) { setCatSug([]); return; }
    catTimer.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/reconciliation/dre-categories?q=" + encodeURIComponent(q), { credentials: "include" });
        const j = await r.json();
        setCatSug(j.categories || []);
      } catch { setCatSug([]); }
    }, 250);
  };

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
  useEffect(() => { loadStatements(); if (selected?.id === "__pendentes__") loadDetail(selected); }, [instance, account]);

  const accountOptions = useMemo(
    () => accounts.filter((a) => !instance || a.omie_instance_id === instance),
    [accounts, instance]
  );

  const loadDetail = (s: Statement) => {
    setLoadingDetail(true);
    const url = s.id === "__pendentes__"
      ? "/api/reconciliation/pending-items?" + new URLSearchParams({ ...(instance ? { instanceId: instance } : {}), ...(account ? { accountId: account } : {}) }).toString()
      : `/api/reconciliation/statements/${s.id}/items`;
    return fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setDetail(d))
      .catch(() => setDetail({ items: [], matchesByItem: {}, suggestions: {} }))
      .finally(() => setLoadingDetail(false));
  };
  const openStatement = (s: Statement) => { setSelected(s); setDetail(null); setPage(0); setFilterText(""); setFilterStatus(""); loadDetail(s); };
  // FASE 3.4b - visao consolidada: pendentes de todos os extratos da conta
  const openPendentes = () => openStatement({ id: "__pendentes__", file_name: "Pendentes — todos os extratos" } as any);
  const refresh = async () => { if (selected) await loadDetail(selected); await loadStatements(); };

  const post = async (url: string, body: any) => {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(j?.error || ("HTTP " + r.status));
    return j;
  };

  const items: Item[] = detail?.items || [];
  const matchesByItem: Record<string, any[]> = detail?.matchesByItem || {};
  const suggestions: Record<string, any> = detail?.suggestions || {};

  // título/nome resolvido do item (p/ ordenação e exibição)
  const itemTitleStr = (it: Item): string => {
    const ms = matchesByItem[it.id] || [];
    if (ms.length) return String(ms[0].r_title || ms[0].p_title || "");
    const sg = suggestions[it.id];
    if (sg?.titles?.length) return String(sg.titles[0].title || "");
    return "";
  };
  const itemNameStr = (it: Item): string => String(it.origin_name || it.description || "");

  const viewItems = useMemo(() => {
    let arr = items.slice();
    const q = filterText.trim().toLowerCase();
    if (q) {
      const qd = q.replace(/\D/g, "");
      arr = arr.filter((it) =>
        (it.description || "").toLowerCase().includes(q) ||
        (it.origin_name || "").toLowerCase().includes(q) ||
        itemTitleStr(it).toLowerCase().includes(q) ||
        (qd && (it.document || "").replace(/\D/g, "").includes(qd)) ||
        (qd && String(it.amount).replace(/\D/g, "").includes(qd))
      );
    }
    if (filterStatus) arr = arr.filter((it) => (it.reconciliation_status || "pending") === filterStatus);
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let va: any, vb: any;
      if (sortKey === "date") { va = a.transaction_date || ""; vb = b.transaction_date || ""; }
      else if (sortKey === "amount") { va = num(a.amount); vb = num(b.amount); }
      else if (sortKey === "status") { va = a.reconciliation_status || "pending"; vb = b.reconciliation_status || "pending"; }
      else if (sortKey === "title") { va = itemTitleStr(a).toLowerCase(); vb = itemTitleStr(b).toLowerCase(); }
      else { va = itemNameStr(a).toLowerCase(); vb = itemNameStr(b).toLowerCase(); }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return arr;
  }, [items, matchesByItem, suggestions, filterText, filterStatus, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(viewItems.length / pageSize));
  const curPage = Math.min(page, totalPages - 1);
  const pageItems = viewItems.slice(curPage * pageSize, curPage * pageSize + pageSize);
  useEffect(() => { setPage(0); }, [filterText, filterStatus, sortKey, sortDir]);

  const setSort = (k: typeof sortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };
  const Arrow = ({ k }: { k: typeof sortKey }) => <span className="text-gray-400">{sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : ""}</span>;

  // ---- ações simples (ignore/undo) ----
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

  // ---- modal de conciliação (carrinho) ----
  const openModal = (it: Item) => {
    setModalItem(it); setCart([]); setTab("sug"); setSearchQ(""); setSearchResults([]);
  };
  const closeModal = () => { setModalItem(null); setCart([]); };
  const itemAmt = modalItem ? Math.abs(num(modalItem.amount)) : 0;
  const cartTotal = cart.reduce((s, c) => s + (num(c.amount) + num(c.interest) - num(c.discount)), 0);
  const delta = Math.round((itemAmt - cartTotal) * 100) / 100;

  const addToCart = (t: Title) => {
    setCart((prev) => {
      if (prev.some((c) => c.id === t.id && c.kind === t.kind)) return prev;
      const cur = prev.reduce((s, c) => s + (num(c.amount) + num(c.interest) - num(c.discount)), 0);
      const remaining = Math.max(0, Math.round((itemAmt - cur) * 100) / 100);
      const defAmt = remaining > 0 ? remaining : Math.abs(num(t.amount));
      return [...prev, { kind: t.kind, id: t.id, title: t.title, name: t.name, amount: defAmt, interest: 0, discount: 0 }];
    });
  };
  const removeCart = (idx: number) => setCart((prev) => prev.filter((_, i) => i !== idx));
  const setCartField = (idx: number, field: "amount" | "interest" | "discount", val: string) =>
    setCart((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: num(val) } : c)));

  const searchTitles = async (q: string) => {
    if (!modalItem) return;
    setSearchLoading(true);
    try {
      const type = modalItem.type === "C" ? "C" : "D";
      const r = await fetch(`/api/reconciliation/titles/search?type=${type}&q=${encodeURIComponent(q)}`, { credentials: "include" });
      const j = await r.json();
      setSearchResults(j.titles || []);
    } catch { setSearchResults([]); }
    finally { setSearchLoading(false); }
  };

  const confirmReconcile = async () => {
    if (!modalItem || !cart.length) return;
    if (Math.abs(delta) >= 0.01) { alert(`O total do carrinho (${fmtMoney(cartTotal)}) precisa igualar o valor do extrato (${fmtMoney(itemAmt)}). Δ = ${fmtMoney(delta)}.`); return; }
    if (!window.confirm(`Conciliar ${fmtMoney(itemAmt)} com ${cart.length} título(s)? Isso DÁ BAIXA (marca como pago).`)) return;
    setBusy(modalItem.id);
    try {
      await post(`/api/reconciliation/items/${modalItem.id}/reconcile`, {
        by: me,
        titles: cart.map((c) => ({ kind: c.kind, id: c.id, amount: num(c.amount), interest: num(c.interest), discount: num(c.discount) })),
      });
      closeModal();
      await refresh();
    } catch (e: any) { alert("Erro ao conciliar: " + e.message); }
    finally { setBusy(""); }
  };

  const initNovo = () => {
    if (!modalItem) return;
    const d = (() => { try { return new Date(modalItem.transaction_date).toISOString().slice(0, 10); } catch { return ""; } })();
    setNovo({
      tipo: modalItem.type === "C" ? "receber" : "pagar",
      name: modalItem.description || "",
      document: "",
      amount: itemAmt,
      issueDate: d, dueDate: d,
      description: modalItem.description || "",
      category: "",
      chartAccountId: "",
      omieInstanceId: instance || "",
    });
    setSupSug([]); setSupNovo(false); setCatSug([]);
  };
  const createAndReconcile = async () => {
    if (!modalItem) return;
    const amt = num(novo.amount);
    if (!(amt > 0)) { alert("Informe um valor válido."); return; }
    if (!String(novo.name || "").trim()) { alert("Informe o nome do " + (novo.tipo === "receber" ? "cliente" : "fornecedor") + "."); return; }
    if (!window.confirm(`Criar ${novo.tipo === "receber" ? "conta a receber" : "conta a pagar"} de ${fmtMoney(amt)} e CONCILIAR (dar baixa) com este lançamento?`)) return;
    setBusy(modalItem.id);
    try {
      await post(`/api/reconciliation/items/${modalItem.id}/create-and-reconcile`, {
        by: me, tipo: novo.tipo, name: novo.name, document: novo.document,
        amount: amt, issueDate: novo.issueDate || null, dueDate: novo.dueDate || null,
        description: novo.description, category: novo.category || null, chartAccountId: novo.chartAccountId || null, omieInstanceId: novo.omieInstanceId || null,
      });
      closeModal(); await refresh();
    } catch (e: any) { alert("Erro ao criar/conciliar: " + e.message); }
    finally { setBusy(""); }
  };

  // ---- OFX / delete ----
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
      alert(`OFX importado: ${j.inserted} lançamento(s) novo(s)` + (j.skipped ? `, ${j.skipped} já existia(m)` : "") + (j.inserted ? `.\nCréditos ${fmtMoney(j.totalCredits)} · Débitos ${fmtMoney(j.totalDebits)}` : "."));
      await loadStatements();
      if (j.statementId) openStatement({ id: j.statementId, file_name: j.fileName, source: "ofx", start_date: j.period?.start, end_date: j.period?.end, items: j.inserted, reconciled: 0, ignored: 0, account_name: j.account, omie_instance_id: j.instance } as any);
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

  const pend = viewItems.filter((i) => (i.reconciliation_status || "pending") === "pending").length;
  const conc = viewItems.filter((i) => i.reconciliation_status === "reconciled").length;

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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 font-semibold text-sm">Extratos Importados</div>
          <div className="max-h-[74vh] overflow-auto divide-y">
            {loadingList && <div className="p-4 text-sm text-gray-400">Carregando…</div>}
            {!loadingList && statements.length === 0 && <div className="p-4 text-sm text-gray-400">Nenhum extrato.</div>}
            {!loadingList && statements.length > 0 && (
              <button onClick={openPendentes} className={`w-full text-left px-4 py-3 hover:bg-amber-100 ${selected?.id === "__pendentes__" ? "bg-amber-100" : "bg-amber-50"}`}>
                <div className="text-sm font-medium">⏳ Pendentes — todos os extratos</div>
                <div className="text-xs text-gray-500 mt-0.5">Tudo que ainda não foi conciliado, de todas as importações{account ? " da conta selecionada" : ""}</div>
              </button>
            )}
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
                <button onClick={(e) => doDeleteStatement(s, e)} disabled={busy === "stmt:" + s.id} title={(s.reconciled || 0) > 0 ? "Desfaça as conciliações antes de remover" : "Remover extrato importado"} className="absolute top-2 right-2 text-gray-300 hover:text-red-600 text-sm disabled:opacity-40">🗑</button>
              </div>
            ))}
          </div>
        </div>

        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm">{selected ? `${selected.file_name || "Extrato"}` : "Selecione um extrato"}</span>
            {selected && <span className="text-xs text-gray-500">{viewItems.length} lançamentos · <span className="text-amber-600">{pend} pend.</span> · <span className="text-green-600">{conc} conc.</span></span>}
            <div className="flex-1" />
            {selected && (
              <>
                <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="Filtrar (nome, valor, título, doc)…" className="border rounded px-2 py-1 text-xs w-56" />
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="border rounded px-2 py-1 text-xs">
                  <option value="">Todas as situações</option>
                  <option value="pending">Pendentes</option>
                  <option value="reconciled">Conciliados</option>
                  <option value="ignored">Ignorados</option>
                </select>
              </>
            )}
          </div>
          {!selected && <div className="p-8 text-center text-gray-400">Selecione um extrato na lista ao lado</div>}
          {selected && loadingDetail && <div className="p-8 text-center text-gray-400">Carregando itens…</div>}
          {selected && !loadingDetail && (
            <>
              <div className="max-h-[64vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white border-b z-10">
                    <tr className="text-left text-xs text-gray-500">
                      <th className="px-3 py-2 cursor-pointer select-none" onClick={() => setSort("date")}>Data<Arrow k="date" /></th>
                      <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => setSort("amount")}>Valor<Arrow k="amount" /></th>
                      <th className="px-3 py-2 cursor-pointer select-none" onClick={() => setSort("name")}>Nome / Descrição<Arrow k="name" /></th>
                      <th className="px-3 py-2 cursor-pointer select-none" onClick={() => setSort("status")}>Situação<Arrow k="status" /></th>
                      <th className="px-3 py-2 cursor-pointer select-none" onClick={() => setSort("title")}>Título / Sugestão<Arrow k="title" /></th>
                      <th className="px-3 py-2">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pageItems.map((it) => {
                      const ms = matchesByItem[it.id] || [];
                      const sg = suggestions[it.id];
                      const isBusy = busy === it.id;
                      const st = it.reconciliation_status || "pending";
                      return (
                        <tr key={it.id} className="align-top">
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(it.transaction_date)}</td>
                          <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${it.type === "C" ? "text-green-600" : "text-red-600"}`}>{it.type === "C" ? "+" : "−"}{fmtMoney(it.amount)}</td>
                          <td className="px-3 py-2 max-w-[260px]">
                            <div className="truncate" title={it.description}>{it.origin_name || it.description}</div>
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
                            {ms.length === 0 && sg && sg.counterparty && (
                              <div className="text-xs">
                                <span className="inline-block px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 mr-1">sugestão</span>
                                <span className="font-medium">{sg.counterparty.name}</span>
                                {sg.counterparty.category ? <span className="text-gray-500"> · {sg.counterparty.category}</span> : null}
                                <span className="text-gray-400"> · {sg.counterparty.via === "cpf_cnpj" ? "por doc" : "por descr"} ({sg.counterparty.matchCount}×)</span>
                              </div>
                            )}
                            {ms.length === 0 && sg && (sg.titles || []).length > 0 && (() => {
                              const t0 = sg.titles[0];
                              const chip = (t0.score ?? 0) >= 80 ? "bg-emerald-100 text-emerald-700" : (t0.score ?? 0) >= 60 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600";
                              return (
                                <div className="text-[11px] text-gray-600 mt-0.5">
                                  <span className={`inline-block px-1.5 py-0.5 rounded font-medium mr-1 ${chip}`}>{t0.score ?? 0}%</span>
                                  <b>{t0.title || "—"}</b> {t0.name || ""}
                                  {(t0.motivos || []).length > 0 && <span className="text-gray-400"> · {(t0.motivos || []).join(", ")}</span>}
                                  {sg.titles.length > 1 && <span className="text-gray-400"> · +{sg.titles.length - 1} opção(ões)</span>}
                                </div>
                              );
                            })()}
                            {ms.length === 0 && sg && sg.pix && (
                              <div className="text-[11px] text-sky-700 mt-0.5">PIX recebido via webhook{sg.pix.pagador ? ` · pagador: ${sg.pix.pagador}` : ""}</div>
                            )}
                            {ms.length === 0 && !sg && st === "pending" && <span className="text-xs text-gray-300">sem sugestão</span>}
                            {st === "ignored" && it.notes && <span className="text-[11px] text-gray-400">{it.notes.split("|")[0]}</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {st === "pending" && (
                              <div className="flex gap-1">
                                <button disabled={isBusy} onClick={() => openModal(it)} className="px-2 py-0.5 rounded bg-green-600 text-white text-[11px] disabled:opacity-50">Conciliar</button>
                                <button disabled={isBusy} onClick={() => doIgnore(it)} className="px-2 py-0.5 rounded border text-gray-600 text-[11px] disabled:opacity-50">Ignorar</button>
                              </div>
                            )}
                            {(st === "reconciled" || st === "ignored") && (
                              <button disabled={isBusy} onClick={() => doUndo(it)} className="px-2 py-0.5 rounded border border-red-300 text-red-600 text-[11px] disabled:opacity-50">Desfazer</button>
                            )}
                            {isBusy && <span className="text-[11px] text-gray-400 ml-1">…</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {pageItems.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400 text-sm">Nenhum lançamento.</td></tr>}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t bg-gray-50 text-xs text-gray-600">
                  <span>Página {curPage + 1} de {totalPages} · {viewItems.length} lançamentos</span>
                  <div className="flex gap-1">
                    <button disabled={curPage === 0} onClick={() => setPage(0)} className="px-2 py-1 rounded border disabled:opacity-40">« Início</button>
                    <button disabled={curPage === 0} onClick={() => setPage(curPage - 1)} className="px-2 py-1 rounded border disabled:opacity-40">‹ Anterior</button>
                    <button disabled={curPage >= totalPages - 1} onClick={() => setPage(curPage + 1)} className="px-2 py-1 rounded border disabled:opacity-40">Próxima ›</button>
                    <button disabled={curPage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} className="px-2 py-1 rounded border disabled:opacity-40">Fim »</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* MODAL Conciliar Transação */}
      {modalItem && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={closeModal}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-start justify-between">
              <div>
                <div className="font-bold text-gray-800">Conciliar Transação</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {modalItem.type === "C" ? "Crédito" : "Débito"}: <span className="font-medium">{fmtMoney(modalItem.amount)}</span> em {fmtDate(modalItem.transaction_date)} — {modalItem.description}
                </div>
              </div>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>

            {/* carrinho */}
            <div className="px-5 py-3 border-b bg-gray-50">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-gray-600">🛒 Carrinho de Conciliação</span>
                <span>Extrato: <b>{fmtMoney(itemAmt)}</b> · Carrinho: <b className={cartTotal ? "" : "text-gray-400"}>{fmtMoney(cartTotal)}</b> · Δ <b className={Math.abs(delta) < 0.01 ? "text-green-600" : "text-red-600"}>{fmtMoney(delta)}</b></span>
              </div>
              {cart.length === 0 && <div className="text-xs text-gray-400 italic">Adicione um ou mais títulos abaixo. Você pode informar juros e desconto; o total (principal + juros − desconto) deve igualar o valor do extrato.</div>}
              {cart.map((c, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs py-1 border-t first:border-t-0">
                  <span className="flex-1 truncate"><b>{c.title || "—"}</b> · {c.name || ""} <span className="text-gray-400">({c.kind === "receivable" ? "Receber" : "Pagar"})</span></span>
                  <label className="text-gray-400">R$<input type="number" step="0.01" value={c.amount} onChange={(e) => setCartField(idx, "amount", e.target.value)} className="w-20 border rounded px-1 py-0.5 ml-0.5" /></label>
                  <label className="text-gray-400">juros<input type="number" step="0.01" value={c.interest} onChange={(e) => setCartField(idx, "interest", e.target.value)} className="w-16 border rounded px-1 py-0.5 ml-0.5" /></label>
                  <label className="text-gray-400">desc<input type="number" step="0.01" value={c.discount} onChange={(e) => setCartField(idx, "discount", e.target.value)} className="w-16 border rounded px-1 py-0.5 ml-0.5" /></label>
                  <button onClick={() => removeCart(idx)} className="text-red-500 hover:text-red-700">✕</button>
                </div>
              ))}
            </div>

            {/* abas */}
            <div className="px-5 pt-2 flex gap-4 text-sm border-b">
              <button onClick={() => setTab("sug")} className={`pb-2 ${tab === "sug" ? "border-b-2 border-green-600 text-green-700 font-medium" : "text-gray-500"}`}>✨ Sugestões</button>
              <button onClick={() => { setTab("search"); if (!searchResults.length) searchTitles(""); }} className={`pb-2 ${tab === "search" ? "border-b-2 border-green-600 text-green-700 font-medium" : "text-gray-500"}`}>🔎 Buscar Título</button>
              <button onClick={() => { setTab("novo"); initNovo(); }} className={`pb-2 ${tab === "novo" ? "border-b-2 border-green-600 text-green-700 font-medium" : "text-gray-500"}`}>➕ Criar Novo</button>
            </div>

            <div className="px-5 py-3 overflow-auto flex-1">
              {tab === "sug" && (
                <div className="space-y-2">
                  {(() => {
                    const sg = suggestions[modalItem.id];
                    const titles: Title[] = (sg?.titles || []);
                    const pixBox = sg?.pix ? (
                      <div className="border border-sky-200 bg-sky-50 text-sky-800 rounded px-3 py-2 text-xs">
                        <b>PIX recebido via webhook</b>{sg.pix.pagador ? <> · pagador: <b>{sg.pix.pagador}</b></> : null}
                        <div className="text-sky-600">{fmtMoney(sg.pix.valor)} · {fmtDate(sg.pix.horario)}{sg.pix.e2e ? ` · e2e ${String(sg.pix.e2e).slice(0, 20)}…` : ""}</div>
                      </div>
                    ) : null;
                    if (!titles.length) return <>{pixBox}<div className="text-sm text-gray-400">Sem sugestão automática. Use “Buscar Título”.</div></>;
                    return (
                      <>
                        {pixBox}
                        {titles.map((t, idx) => {
                          const chip = (t.score ?? 0) >= 80 ? "bg-emerald-100 text-emerald-700" : (t.score ?? 0) >= 60 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600";
                          return (
                            <div key={idx} className="flex items-center gap-2 border rounded px-3 py-2">
                              <div className="flex-1 text-sm">
                                <div>
                                  {typeof t.score === "number" && <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium mr-1.5 ${chip}`}>{t.score}%</span>}
                                  <b>{t.title || "—"}</b> · {t.name || ""} <span className="text-gray-400">({t.kind === "receivable" ? "Receber" : "Pagar"})</span>
                                </div>
                                <div className="text-xs text-gray-500">{fmtMoney(t.amount)}{t.restante != null && num(t.restante) !== num(t.amount) ? ` (restante ${fmtMoney(t.restante)})` : ""} · venc {fmtDate(t.due)}{t.instance ? ` · ${t.instance}` : ""}</div>
                                {(t.motivos || []).length > 0 && <div className="text-[11px] text-emerald-700">{(t.motivos || []).join(" · ")}</div>}
                              </div>
                              <button onClick={() => addToCart(t)} disabled={cart.some((c) => c.id === t.id)} className="px-2 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-40">+ Adicionar</button>
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              )}
              {tab === "search" && (
                <div>
                  <div className="flex gap-2 mb-3">
                    <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") searchTitles(searchQ); }} placeholder="Buscar por nº do título, nome, documento ou valor…" className="flex-1 border rounded px-3 py-1.5 text-sm" />
                    <button onClick={() => searchTitles(searchQ)} className="px-3 py-1.5 rounded bg-green-600 text-white text-sm">Buscar</button>
                  </div>
                  {searchLoading && <div className="text-sm text-gray-400">Buscando…</div>}
                  {!searchLoading && searchResults.length === 0 && <div className="text-sm text-gray-400">Nenhum título em aberto encontrado.</div>}
                  <div className="space-y-2">
                    {searchResults.map((t, idx) => (
                      <div key={idx} className="flex items-center gap-2 border rounded px-3 py-2">
                        <div className="flex-1 text-sm">
                          <div><b>{t.title || "—"}</b> · {t.name || ""}</div>
                          <div className="text-xs text-gray-500">{fmtMoney(t.amount)} · venc {fmtDate(t.due)}{t.instance ? ` · ${t.instance}` : ""}{t.document ? ` · ${t.document}` : ""}</div>
                        </div>
                        <button onClick={() => addToCart(t)} disabled={cart.some((c) => c.id === t.id)} className="px-2 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-40">+ Adicionar</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {tab === "novo" && (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">Tipo:</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${novo.tipo === "receber" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{novo.tipo === "receber" ? "Conta a Receber" : "Conta a Pagar"}</span>
                  </div>
                  <div className="relative">
                    <label className="block text-xs text-gray-600 mb-1">{novo.tipo === "receber" ? "Cliente" : "Fornecedor"}</label>
                    <input value={novo.name || ""} onChange={(e) => { const v = e.target.value; setNovo({ ...novo, name: v }); if (novo.tipo === "pagar") buscarFornecedores(v); }} className="w-full border rounded px-3 py-1.5" placeholder={novo.tipo === "pagar" ? "Busque no cadastro de fornecedores…" : "Nome do cliente"} autoComplete="off" />
                    {novo.tipo === "pagar" && supSug.length > 0 && (
                      <div className="absolute z-30 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">
                        {supSug.map((s: any) => (
                          <button key={s.id} onClick={() => { setNovo({ ...novo, name: s.name || "", document: s.cnpj || s.cpf || novo.document || "", chartAccountId: s.default_chart_account_id || novo.chartAccountId || "", category: s.default_category || novo.category || "" }); setSupSug([]); setSupNovo(false); }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">
                            {s.name}{(s.cnpj || s.cpf) ? <span className="text-gray-400 text-xs"> · {s.cnpj || s.cpf}</span> : null}
                          </button>
                        ))}
                      </div>
                    )}
                    {novo.tipo === "pagar" && supNovo && <div className="text-[11px] text-amber-600 mt-0.5">Fornecedor novo — será cadastrado automaticamente no cadastro de Fornecedores.</div>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Documento (CPF/CNPJ)</label>
                      <input value={novo.document || ""} onChange={(e) => setNovo({ ...novo, document: e.target.value })} className="w-full border rounded px-3 py-1.5" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Valor</label>
                      <input type="number" step="0.01" value={novo.amount ?? ""} onChange={(e) => setNovo({ ...novo, amount: e.target.value })} className="w-full border rounded px-3 py-1.5" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Data de Emissão</label>
                      <input type="date" value={novo.issueDate || ""} onChange={(e) => setNovo({ ...novo, issueDate: e.target.value })} className="w-full border rounded px-3 py-1.5" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Data de Vencimento</label>
                      <input type="date" value={novo.dueDate || ""} onChange={(e) => setNovo({ ...novo, dueDate: e.target.value })} className="w-full border rounded px-3 py-1.5" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Instância</label>
                      <select value={novo.omieInstanceId || ""} onChange={(e) => setNovo({ ...novo, omieInstanceId: e.target.value })} className="w-full border rounded px-3 py-1.5">
                        <option value="">(do extrato)</option>
                        {instances.map((i) => <option key={i} value={i}>{i}</option>)}
                      </select>
                    </div>
                    <div className="relative">
                      <label className="block text-xs text-gray-600 mb-1">Categoria (DRE)</label>
                      <input value={novo.category || ""} onChange={(e) => { setNovo({ ...novo, category: e.target.value, chartAccountId: "" }); buscarCategorias(e.target.value); }} className="w-full border rounded px-3 py-1.5" placeholder="Busque no plano de contas…" autoComplete="off" />
                      {catSug.length > 0 && (
                        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">
                          {catSug.map((c: any) => (
                            <button key={c.id} onClick={() => { setNovo({ ...novo, category: `${c.code} ${c.name}`, chartAccountId: c.id }); setCatSug([]); }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">
                              <b>{c.code}</b> {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {novo.chartAccountId ? <div className="text-[11px] text-emerald-700 mt-0.5">Título será classificado nesta categoria da DRE.</div> : null}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Descrição</label>
                    <input value={novo.description || ""} onChange={(e) => setNovo({ ...novo, description: e.target.value })} className="w-full border rounded px-3 py-1.5" />
                  </div>
                  <button onClick={createAndReconcile} disabled={busy === modalItem.id} className="w-full mt-1 px-4 py-2 rounded bg-green-600 text-white font-medium disabled:opacity-40">Criar e Conciliar {fmtMoney(num(novo.amount))}</button>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t flex items-center justify-between">
              <span className="text-xs text-gray-500">{modalItem.type === "C" ? "Recebimento (títulos a receber)" : "Pagamento (títulos a pagar)"}</span>
              <div className="flex gap-2">
                <button onClick={closeModal} className="px-3 py-1.5 rounded border text-sm">Cancelar</button>
                <button onClick={confirmReconcile} disabled={!cart.length || Math.abs(delta) >= 0.01 || busy === modalItem.id} className="px-4 py-1.5 rounded bg-green-600 text-white text-sm font-medium disabled:opacity-40">Conciliar {cart.length ? `(${fmtMoney(cartTotal)})` : ""}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
