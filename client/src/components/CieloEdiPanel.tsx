// ============================================================================
// CIELO — Extrato Eletrônico (EDI) na tela de Conciliação Bancária
//
// Três peças usadas por ConciliacaoBancaria.tsx:
//   * useCieloEdi()  — estado + chamadas (arquivos, URs, mapa EC, importar, conciliar)
//   * CieloBotoes    — "Importar extrato Cielo" e "Conciliar Cielo" (barra de cima)
//   * CieloLista     — seção "Extratos Cielo" na coluna da esquerda
//   * CieloPainel    — painel da direita: URs (repasses) com as vendas de cada uma,
//                      status do casamento com o BB, mapa EC → conta
//
// O arquivo da Cielo NÃO vira extrato bancário: a conciliação continua na linha
// do BB. Aqui só se vê o que a Cielo pagou, venda a venda, e o que ainda falta
// para cada repasse fechar sozinho.
// ============================================================================
import React, { useEffect, useState } from "react";

const fmtMoney = (v: any): string => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (d: any): string => {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

export type CieloApi = {
  me: string;
  post: (url: string, body: any) => Promise<any>;
  refresh: () => Promise<void>;
};

export function useCieloEdi(api: CieloApi) {
  const [arquivos, setArquivos] = useState<any[]>([]);
  const [urs, setUrs] = useState<any[]>([]);
  const [ecs, setEcs] = useState<any[]>([]);
  const [sugPorItem, setSugPorItem] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadArquivos = async () => {
    try { const r = await fetch("/api/reconciliation/cielo-edi/arquivos", { credentials: "include" }); const j = await r.json(); setArquivos(j.arquivos || []); } catch { setArquivos([]); }
  };
  const loadSugestoes = async () => {
    try { const r = await fetch("/api/reconciliation/cielo-edi/sugestoes", { credentials: "include" }); const j = await r.json(); setSugPorItem(j.porItem || {}); } catch { setSugPorItem({}); }
  };
  const loadUrs = async (arquivoId: string | null) => {
    setLoading(true);
    try {
      const qs = arquivoId && arquivoId !== "__all__" ? "?arquivoId=" + encodeURIComponent(arquivoId) : "";
      const r = await fetch("/api/reconciliation/cielo-edi/urs" + qs, { credentials: "include" }); const j = await r.json(); setUrs(j.urs || []);
    } catch { setUrs([]); }
    finally { setLoading(false); }
  };
  const loadEcs = async () => {
    try { const r = await fetch("/api/reconciliation/cielo-ec", { credentials: "include" }); const j = await r.json(); setEcs(j.ecs || []); } catch { setEcs([]); }
  };
  useEffect(() => { loadArquivos(); loadSugestoes(); }, []);

  const importar = async (file: File): Promise<any> => {
    setImporting(true);
    try {
      const text = await file.text();
      const j = await api.post("/api/reconciliation/cielo-edi/import", { text, fileName: file.name, by: api.me, dryRun: false });
      const c = j.casamento || {};
      const linhas = [
        j.jaImportado ? `Este arquivo já tinha sido importado em ${fmtDate(j.importadoEm)} (${j.fileName || ""}).` : `Extrato Cielo importado: ${j.opcao === "04" ? "PAGAMENTO (CIELO04)" : j.opcao === "03" ? "VENDAS/PREVISÃO (CIELO03)" : "opção " + j.opcao} · EC ${j.header?.ec || "?"} · período ${fmtDate(j.header?.periodoIni)} → ${fmtDate(j.header?.periodoFim)}.`,
        `${j.urs} repasse(s) (${j.ursNovas ?? j.urs} novo(s)) · ${j.transacoes} venda(s) · bruto ${fmtMoney(j.totalBruto)} · taxa ${fmtMoney(j.totalTaxa)} · líquido ${fmtMoney(j.totalLiquido)}.`,
        c.transacoes ? `Vendas casadas com título: ${c.transacoes.casadas}/${c.transacoes.analisadas}` + (c.transacoes.ambiguas ? ` · ${c.transacoes.ambiguas} ambígua(s)` : "") + (c.transacoes.semTitulo ? ` · ${c.transacoes.semTitulo} sem título` : "") + "." : "",
        c.urs ? `Repasses casados com o extrato do BB: ${c.urs.sugeridas}` + (c.urs.semExtrato ? ` · ${c.urs.semExtrato} sem lançamento no BB (importe o OFX do dia)` : "") + (c.urs.ambiguas ? ` · ${c.urs.ambiguas} ambíguo(s)` : "") + "." : "",
        c.conciliacao ? `Conciliados automaticamente agora: ${c.conciliacao.conciliadas}` + (c.conciliacao.puladas ? ` · ${c.conciliacao.puladas} aguardando (veja o motivo no painel Extratos Cielo)` : "") + "." : "",
        ...(Array.isArray(j.avisos) ? j.avisos.map((a: string) => "⚠ " + a) : []),
      ].filter(Boolean);
      alert(linhas.join("\n"));
      await loadArquivos(); await loadSugestoes(); await api.refresh();
      return j;
    } catch (e: any) { alert("Erro ao importar extrato Cielo: " + e.message); return null; }
    finally { setImporting(false); }
  };

  const conciliar = async (urIds?: string[]) => {
    setBusy(true);
    try {
      const prev = await api.post("/api/reconciliation/cielo-edi/conciliar", { by: api.me, dryRun: true, urIds });
      const n = Number(prev.candidatas || 0), prontas = (prev.plano || []).length;
      if (!prontas) {
        const motivos = (prev.puladas || []).slice(0, 6).map((p: any) => "• " + p.motivo).join("\n");
        alert(`Conciliar Cielo: nenhum repasse pronto para fechar agora.` + (n ? `\n${n} repasse(s) casado(s) com o extrato, mas:\n${motivos}` : "\nImporte o extrato Cielo (CIELO04) e o OFX do BB do mesmo período."));
        return;
      }
      const resumo = (prev.plano || []).slice(0, 8).map((p: any) => `• ${fmtDate(p.data)} ${p.tipo} — líquido ${fmtMoney(p.liquido)} = ${p.titulos.length} título(s) ${fmtMoney(p.bruto)} − taxa ${fmtMoney(p.taxa)}`).join("\n");
      if (!window.confirm(`Conciliar Cielo: ${prontas} repasse(s) pronto(s).\n${resumo}${prontas > 8 ? "\n…" : ""}\n\nIsso baixa os títulos pelo bruto, cria a despesa "Taxa Cielo" e marca o lançamento do BB como conciliado. Continuar?`)) return;
      const r = await api.post("/api/reconciliation/cielo-edi/conciliar", { by: api.me, dryRun: false, urIds });
      alert(`Conciliar Cielo: ${Number(r.conciliadas || 0)} repasse(s) conciliado(s).` + (r.puladas?.length ? ` ${r.puladas.length} aguardando.` : "") + (r.erros?.length ? `\nErros:\n${r.erros.join("\n")}` : ""));
      await loadArquivos(); await loadSugestoes(); await api.refresh();
    } catch (e: any) { alert("Erro (Conciliar Cielo): " + e.message); }
    finally { setBusy(false); }
  };

  return { me: api.me, arquivos, urs, ecs, sugPorItem, loading, importing, busy, loadArquivos, loadUrs, loadEcs, loadSugestoes, importar, conciliar };
}

// ---- Botões da barra de cima -------------------------------------------------
export function CieloBotoes({ c }: { c: ReturnType<typeof useCieloEdi> }) {
  const ref = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={ref} type="file" accept=".txt,.edi,.cielo,.dat,.csv,text/plain,*/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) await c.importar(f); }} />
      <button onClick={() => c.conciliar()} disabled={c.busy} title="Fecha os repasses da Cielo já casados com o extrato do BB: baixa os títulos pelo bruto, lança a Taxa Cielo como despesa financeira e concilia o lançamento" className="px-3 py-2 text-sm rounded border text-gray-700 hover:bg-gray-50 disabled:opacity-50">💳 Conciliar Cielo</button>
      <button onClick={() => ref.current?.click()} disabled={c.importing} title="Importar o Extrato Eletrônico da Cielo (arquivo CIELO04 de pagamento; CIELO03 de vendas também é aceito). Baixe em cielo.com.br › Vendas e Recebíveis › Recursos › Extrato Eletrônico" className="px-3 py-2 text-sm rounded border border-sky-500 text-sky-800 bg-sky-50 hover:bg-sky-100 disabled:opacity-50">{c.importing ? "Importando…" : "🟦 Importar extrato Cielo"}</button>
    </>
  );
}

// ---- Seção "Extratos Cielo" na coluna da esquerda ----------------------------
export function CieloLista({ c, ativo, onOpen, onDelete }: { c: ReturnType<typeof useCieloEdi>; ativo: string | null; onOpen: (id: string) => void; onDelete: (a: any) => void }) {
  if (!c.arquivos.length) return null;
  const tot = c.arquivos.reduce((acc: any, a: any) => ({ s: acc.s + Number(a.urs_sugeridas || 0), p: acc.p + Number(a.urs_pendentes || 0), c: acc.c + Number(a.urs_conciliadas || 0) }), { s: 0, p: 0, c: 0 });
  return (
    <>
      <div className="px-4 py-2 border-b border-t bg-sky-50 font-semibold text-sm text-sky-900">Extratos Cielo (Extrato Eletrônico)</div>
      <button onClick={() => onOpen("__all__")} className={`w-full text-left px-4 py-2.5 hover:bg-sky-100 ${ativo === "__all__" ? "bg-sky-100" : ""}`}>
        <div className="text-sm font-medium">💳 Repasses Cielo — todos</div>
        <div className="text-xs text-gray-500 mt-0.5"><span className="text-green-600">{tot.c} conciliados</span> · <span className="text-amber-600">{tot.s} prontos/aguardando</span> · {tot.p} sem extrato do BB</div>
      </button>
      {c.arquivos.map((a: any) => (
        <div key={a.id} className={`relative group ${ativo === a.id ? "bg-sky-50" : ""}`}>
          <button onClick={() => onOpen(a.id)} className="w-full text-left px-4 py-2.5 hover:bg-sky-50">
            <div className="text-sm font-medium truncate pr-6">🟦 {a.file_name || a.id} <span className="text-[10px] text-gray-400">{a.opcao === "04" ? "pagamento" : a.opcao === "03" ? "vendas" : a.opcao}</span></div>
            <div className="text-xs text-gray-500 mt-0.5">
              {fmtDate(a.periodo_ini)} → {fmtDate(a.periodo_fim)} · {a.urs} repasse(s) · {a.transacoes} venda(s) · <span className="text-green-600">{a.urs_conciliadas} conc.</span>
              {Number(a.urs_pendentes || 0) ? <span className="text-amber-600"> · {a.urs_pendentes} pend.</span> : null}
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">EC {a.ec}{a.account_name ? ` · ${a.account_name}` : " · conta não mapeada"} · líquido {fmtMoney(a.total_liquido)}</div>
          </button>
          <button onClick={() => onDelete(a)} title={Number(a.urs_conciliadas || 0) > 0 ? "Desfaça as conciliações antes de remover" : "Remover arquivo Cielo importado"} className="absolute top-2 right-2 text-gray-300 hover:text-red-600 text-sm">🗑</button>
        </div>
      ))}
    </>
  );
}

// ---- Painel da direita ---------------------------------------------------------
const StatusUr = ({ s }: { s: string }) => {
  const map: Record<string, string> = {
    conciliado: "bg-green-100 text-green-700", sugerido: "bg-amber-100 text-amber-700", pendente: "bg-gray-100 text-gray-600",
    sem_extrato: "bg-orange-100 text-orange-700", ignorado: "bg-gray-100 text-gray-400", previsao: "bg-sky-100 text-sky-700",
  };
  const label: Record<string, string> = { conciliado: "Conciliado", sugerido: "Casado c/ BB", pendente: "Pendente", sem_extrato: "Sem extrato BB", ignorado: "Ignorado", previsao: "Previsão" };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${map[s] || "bg-gray-100 text-gray-600"}`}>{label[s] || s}</span>;
};

export function CieloPainel({ c, arquivoId, accounts, onIrParaItem }: { c: ReturnType<typeof useCieloEdi>; arquivoId: string; accounts: { id: string; name: string; omie_instance_id?: string | null }[]; onIrParaItem?: (itemId: string) => void }) {
  const [aberta, setAberta] = useState<string>("");
  const [ecForm, setEcForm] = useState<Record<string, any>>({});
  const [vinc, setVinc] = useState<{ txId: string; q: string; res: any[] } | null>(null);
  useEffect(() => { c.loadUrs(arquivoId); c.loadEcs(); }, [arquivoId]);

  const salvarEc = async (ec: string) => {
    const f = ecForm[ec] || {};
    const atual = c.ecs.find((e: any) => e.ec === ec) || {};
    try {
      await fetch("/api/reconciliation/cielo-ec", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ec, financialAccountId: f.financialAccountId ?? atual.financial_account_id ?? null, descricao: f.descricao ?? atual.descricao ?? null, taxaDebito: f.taxaDebito ?? atual.taxa_debito ?? null, taxaCredito: f.taxaCredito ?? atual.taxa_credito ?? null, taxaParcelado: f.taxaParcelado ?? atual.taxa_parcelado ?? null }) });
      await c.loadEcs(); await c.loadArquivos(); await c.loadUrs(arquivoId);
    } catch (e: any) { alert("Erro ao salvar EC: " + e.message); }
  };
  const buscarTitulo = async (txId: string, q: string) => {
    setVinc({ txId, q, res: [] });
    if (q.trim().length < 2) return;
    try {
      const r = await fetch("/api/reconciliation/titles/search?type=C&q=" + encodeURIComponent(q), { credentials: "include" });
      const j = await r.json(); setVinc({ txId, q, res: j.titles || [] });
    } catch { /* ignore */ }
  };
  const vincular = async (txId: string, receivableId: string | null) => {
    try {
      await fetch(`/api/reconciliation/cielo-edi/transacoes/${txId}/vincular`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receivableId }) });
      setVinc(null); await c.loadUrs(arquivoId);
    } catch (e: any) { alert("Erro ao vincular: " + e.message); }
  };
  const mudarStatus = async (urId: string, status: string) => {
    const motivo = status === "ignorado" ? window.prompt("Motivo para ignorar este repasse (ex.: ajuste/chargeback sem venda):") : "";
    if (status === "ignorado" && motivo === null) return;
    try {
      const r = await fetch(`/api/reconciliation/cielo-edi/urs/${urId}/status`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, motivo, by: c.me }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || "falha");
      await c.loadUrs(arquivoId); await c.loadArquivos(); await c.loadSugestoes();
    } catch (e: any) { alert(e.message); }
  };

  const ecsDoPainel = c.ecs.filter((e: any) => arquivoId === "__all__" || c.urs.some((u: any) => u.ec === e.ec) || c.arquivos.some((a: any) => a.id === arquivoId && a.ec === e.ec));
  const prontas = c.urs.filter((u: any) => u.match_status === "sugerido" && u.transacoes.length && u.transacoes.every((t: any) => t.receivable_id));

  return (
    <div className="max-h-[74vh] overflow-auto">
      {/* Mapa EC → conta */}
      {ecsDoPainel.length > 0 && (
        <div className="px-4 py-3 border-b bg-gray-50">
          <div className="text-xs font-semibold text-gray-600 mb-1">Estabelecimento Cielo (EC) → conta financeira que recebe o repasse</div>
          {ecsDoPainel.map((e: any) => {
            const f = ecForm[e.ec] || {};
            return (
              <div key={e.ec} className="flex flex-wrap items-center gap-2 text-xs py-1">
                <span className="font-mono font-medium">{e.ec}</span>
                <input value={f.descricao ?? e.descricao ?? ""} onChange={(ev) => setEcForm({ ...ecForm, [e.ec]: { ...f, descricao: ev.target.value } })} placeholder="descrição (ex.: MATRIZ)" className="border rounded px-2 py-1 w-44" />
                <select value={f.financialAccountId ?? e.financial_account_id ?? ""} onChange={(ev) => setEcForm({ ...ecForm, [e.ec]: { ...f, financialAccountId: ev.target.value || null } })} className={`border rounded px-2 py-1 ${!(f.financialAccountId ?? e.financial_account_id) ? "border-red-400" : ""}`}>
                  <option value="">— conta do repasse —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.omie_instance_id ? ` · ${a.omie_instance_id}` : ""}</option>)}
                </select>
                <span className="text-gray-400">taxas %:</span>
                <input value={f.taxaDebito ?? e.taxa_debito ?? ""} onChange={(ev) => setEcForm({ ...ecForm, [e.ec]: { ...f, taxaDebito: ev.target.value } })} placeholder="débito" className="border rounded px-2 py-1 w-16" />
                <input value={f.taxaCredito ?? e.taxa_credito ?? ""} onChange={(ev) => setEcForm({ ...ecForm, [e.ec]: { ...f, taxaCredito: ev.target.value } })} placeholder="crédito" className="border rounded px-2 py-1 w-16" />
                <input value={f.taxaParcelado ?? e.taxa_parcelado ?? ""} onChange={(ev) => setEcForm({ ...ecForm, [e.ec]: { ...f, taxaParcelado: ev.target.value } })} placeholder="parcel." className="border rounded px-2 py-1 w-16" />
                <button onClick={() => salvarEc(e.ec)} className="px-2 py-1 rounded bg-sky-600 text-white">Salvar</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="px-4 py-2 border-b flex items-center gap-2 text-xs text-gray-600">
        <span>{c.urs.length} repasse(s)</span>
        <span>· <span className="text-green-600">{c.urs.filter((u: any) => u.match_status === "conciliado").length} conciliados</span></span>
        <span>· <span className="text-amber-600">{prontas.length} prontos para conciliar</span></span>
        <div className="flex-1" />
        {prontas.length > 0 && <button onClick={() => c.conciliar(prontas.map((u: any) => u.id))} disabled={c.busy} className="px-2.5 py-1 rounded bg-green-600 text-white text-xs font-medium disabled:opacity-50">Conciliar {prontas.length} pronto(s)</button>}
      </div>

      {c.loading && <div className="p-6 text-sm text-gray-400">Carregando repasses…</div>}
      {!c.loading && c.urs.length === 0 && <div className="p-6 text-sm text-gray-400">Nenhum repasse neste arquivo.</div>}
      {!c.loading && c.urs.length > 0 && (
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white border-b z-10">
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-2">Pagamento</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Bruto</th>
              <th className="px-3 py-2 text-right">Taxa</th>
              <th className="px-3 py-2 text-right">Líquido</th>
              <th className="px-3 py-2">Vendas</th>
              <th className="px-3 py-2">Extrato BB</th>
              <th className="px-3 py-2">Situação</th>
              <th className="px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {c.urs.map((u: any) => {
              const comTit = u.transacoes.filter((t: any) => t.receivable_id).length;
              const open = aberta === u.id;
              return (
                <React.Fragment key={u.id}>
                  <tr className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(u.data_pagamento)}<div className="text-[10px] text-gray-400">EC {u.ec}{u.account_name ? ` · ${u.account_name}` : ""}</div></td>
                    <td className="px-3 py-2 whitespace-nowrap capitalize">{u.tipo}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(u.bruto)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-red-600">−{fmtMoney(u.taxa)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-green-700">{fmtMoney(u.liquido)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button onClick={() => setAberta(open ? "" : u.id)} className="text-blue-600 hover:underline text-xs">{open ? "▾" : "▸"} {u.transacoes.length} venda(s)</button>
                      <div className={`text-[11px] ${comTit === u.transacoes.length ? "text-green-600" : "text-amber-600"}`}>{comTit}/{u.transacoes.length} com título</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {u.bank_statement_item_id ? (
                        <button onClick={() => onIrParaItem && onIrParaItem(u.bank_statement_item_id)} className="text-left hover:underline" title="Abrir este lançamento no Livro da conta">
                          <div>{fmtDate(u.item_date)} · {fmtMoney(u.item_amount)}</div>
                          <div className="text-gray-400 truncate max-w-[180px]">{u.item_desc}</div>
                        </button>
                      ) : <span className="text-gray-400">{u.match_status === "previsao" ? "previsão" : "não encontrado"}</span>}
                    </td>
                    <td className="px-3 py-2"><StatusUr s={u.match_status} />{u.match_note ? <div className="text-[11px] text-gray-500 max-w-[220px]">{u.match_note}</div> : null}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">
                      {u.match_status === "sugerido" && comTit === u.transacoes.length && u.transacoes.length > 0 && <button onClick={() => c.conciliar([u.id])} disabled={c.busy} className="px-2 py-0.5 rounded bg-green-600 text-white text-[11px] disabled:opacity-50">Conciliar</button>}
                      {["pendente", "sem_extrato", "sugerido"].includes(u.match_status) && <button onClick={() => mudarStatus(u.id, "ignorado")} className="ml-1 px-2 py-0.5 rounded border text-gray-600 text-[11px]">Ignorar</button>}
                      {u.match_status === "ignorado" && <button onClick={() => mudarStatus(u.id, "pendente")} className="px-2 py-0.5 rounded border text-gray-600 text-[11px]">Reabrir</button>}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50">
                      <td colSpan={9} className="px-4 py-2">
                        <table className="w-full text-xs">
                          <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2">Venda</th><th className="py-1 pr-2">NSU · Aut. · Cartão</th><th className="py-1 pr-2 text-right">Bruto</th><th className="py-1 pr-2 text-right">Taxa</th><th className="py-1 pr-2 text-right">Líquido</th><th className="py-1 pr-2">Parc.</th><th className="py-1 pr-2">Título no Integra</th><th className="py-1"></th></tr></thead>
                          <tbody>
                            {u.transacoes.map((t: any) => (
                              <tr key={t.id} className="border-t border-slate-200 align-top">
                                <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(t.data_autorizacao)}</td>
                                <td className="py-1 pr-2 whitespace-nowrap text-gray-600">{t.nsu || "—"} · {t.cod_autorizacao || "—"} · {t.bin ? `${t.bin}…${t.final_cartao}` : t.final_cartao || ""}{t.tid ? <span className="text-gray-400"> · TID {t.tid}</span> : null}</td>
                                <td className="py-1 pr-2 text-right whitespace-nowrap">{fmtMoney(t.valor_bruto_parcela)}</td>
                                <td className="py-1 pr-2 text-right whitespace-nowrap text-gray-500">{t.taxa_venda != null ? `${Number(t.taxa_venda).toFixed(2)}%` : "—"}</td>
                                <td className="py-1 pr-2 text-right whitespace-nowrap">{fmtMoney(t.valor_liquido)}</td>
                                <td className="py-1 pr-2 whitespace-nowrap">{t.total_parcelas > 1 ? `${t.parcela}/${t.total_parcelas}` : "à vista"}</td>
                                <td className="py-1 pr-2">
                                  {t.receivable_id ? (
                                    <span><b>{t.title_number || "—"}</b> {t.customer_name || ""} <span className="text-gray-400">· {fmtMoney(t.rec_amount)} · {t.rec_status}{t.rec_method ? ` · ${t.rec_method}` : ""} · via {t.match_via}</span></span>
                                  ) : <span className="text-amber-700">{t.match_note || "sem título"}</span>}
                                </td>
                                <td className="py-1 whitespace-nowrap">
                                  {u.match_status !== "conciliado" && (
                                    vinc && vinc.txId === t.id ? (
                                      <span className="inline-flex items-center gap-1">
                                        <input autoFocus value={vinc.q} onChange={(e) => buscarTitulo(t.id, e.target.value)} placeholder="NF, cliente…" className="border rounded px-1 py-0.5 w-36" />
                                        <button onClick={() => setVinc(null)} className="text-gray-400">✕</button>
                                      </span>
                                    ) : (
                                      <>
                                        <button onClick={() => buscarTitulo(t.id, t.customer_name || "")} className="text-blue-600 hover:underline">{t.receivable_id ? "trocar" : "vincular"}</button>
                                        {t.receivable_id && <button onClick={() => vincular(t.id, null)} className="ml-2 text-gray-400 hover:text-red-600">desvincular</button>}
                                      </>
                                    )
                                  )}
                                  {vinc && vinc.txId === t.id && vinc.res.length > 0 && (
                                    <div className="mt-1 border rounded bg-white shadow max-h-40 overflow-auto">
                                      {vinc.res.slice(0, 10).map((r: any) => (
                                        <button key={r.id} onClick={() => vincular(t.id, r.id)} className="block w-full text-left px-2 py-1 hover:bg-sky-50">
                                          <b>{r.title || r.title_number}</b> {r.name || r.customer_name} <span className="text-gray-400">· {fmtMoney(r.amount)} · vence {fmtDate(r.due || r.due_date)}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Chip na coluna "Título / Sugestão" da tabela do BB ---------------------
export function CieloChip({ s }: { s: any }) {
  if (!s) return null;
  const pronto = s.status === "conciliado" || Number(s.vendasComTitulo) === Number(s.vendas);
  return (
    <div className="text-[11px] mt-0.5">
      <span className={`inline-block px-1.5 py-0.5 rounded font-medium mr-1 ${s.status === "conciliado" ? "bg-green-100 text-green-700" : pronto ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>Repasse Cielo</span>
      <span className="text-gray-700 capitalize">{s.tipo}</span>
      <span className="text-gray-500"> · {s.vendas} venda(s) · bruto {fmtMoney(s.bruto)} − taxa {fmtMoney(s.taxa)}</span>
      {s.titulos ? <div className="text-gray-600 truncate max-w-[360px]" title={s.titulos}>{s.titulos}</div> : null}
      {!pronto && s.status !== "conciliado" && <div className="text-amber-700">{s.vendasComTitulo}/{s.vendas} venda(s) com título{s.nota ? ` · ${s.nota}` : ""}</div>}
    </div>
  );
}
