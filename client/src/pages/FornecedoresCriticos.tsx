import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import * as XLSX from "xlsx";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldAlert, FileSpreadsheet, Printer, Paperclip, ChevronDown, ChevronRight, ArrowLeft, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Relatório de Fornecedores Críticos — todos os fornecedores marcados como
// críticos, com os dados do cadastro, aprovação/vigência e pendências (documentos).
// Backend: GET /api/suppliers/criticos/relatorio[?inativos=1]
// ---------------------------------------------------------------------------

type Pend = {
  id: string; tipo: string; descricao: string | null; valid_until: string | null; attachment_id: string | null;
  anexo_nome: string | null; situacao: "pendente" | "vencido" | "vencendo" | "ok"; dias_para_vencer: number | null;
};
type Item = {
  id: string; name: string; company_name: string | null; cnpj: string | null; cpf: string | null; state_registration: string | null;
  email: string | null; phone: string | null; contact_name: string | null; address: string | null; address_number: string | null;
  address_complement: string | null; neighborhood: string | null; city: string | null; state: string | null; zip_code: string | null;
  default_category: string | null; notes: string | null; is_active: boolean | null; payment_method: string | null; payment_terms: string | null;
  critical_approved_by: string | null; critical_approved_at: string | null; critical_valid_until: string | null; critical_notes: string | null;
  pendencias: Pend[]; total_pendencias: number; pendencias_sem_anexo: number; pendencias_vencidas: number; pendencias_vencendo: number;
  situacao_vigencia: string; dias_para_vencer: number | null;
  situacao: "regular" | "vencendo" | "vencido" | "pendente" | "nao_aprovado";
};
type Resp = { gerado_em: string; resumo: Record<string, number>; itens: Item[] };

const SIT: Record<Item["situacao"], { l: string; cls: string; ordem: number }> = {
  vencido: { l: "Vencido", cls: "bg-red-100 text-red-800 border-red-200", ordem: 0 },
  pendente: { l: "Com pendência", cls: "bg-amber-100 text-amber-800 border-amber-200", ordem: 1 },
  nao_aprovado: { l: "Não aprovado", cls: "bg-gray-200 text-gray-800 border-gray-300", ordem: 2 },
  vencendo: { l: "Vence em ≤30 dias", cls: "bg-orange-100 text-orange-800 border-orange-200", ordem: 3 },
  regular: { l: "Regular", cls: "bg-green-100 text-green-800 border-green-200", ordem: 4 },
};
const SIT_PEND: Record<Pend["situacao"], { l: string; cls: string }> = {
  pendente: { l: "Sem anexo", cls: "bg-amber-100 text-amber-800" },
  vencido: { l: "Vencido", cls: "bg-red-100 text-red-800" },
  vencendo: { l: "Vencendo", cls: "bg-orange-100 text-orange-800" },
  ok: { l: "Em dia", cls: "bg-green-100 text-green-800" },
};
const APROVADOR: Record<string, string> = { naiara: "Naiara", flavio: "Flavio" };
const fmtData = (d: any) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString("pt-BR") : "—");
const fmtDoc = (cnpj: string | null, cpf: string | null) => {
  const c = (cnpj || "").replace(/\D/g, "");
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  const p = (cpf || "").replace(/\D/g, "");
  if (p.length === 11) return p.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return cnpj || cpf || "—";
};
const endereco = (i: Item) => [i.address, i.address_number, i.address_complement, i.neighborhood, [i.city, i.state].filter(Boolean).join("/"), i.zip_code].filter(Boolean).join(", ");

export default function FornecedoresCriticos() {
  const [inativos, setInativos] = useState(false);
  const [busca, setBusca] = useState("");
  const [filtroSit, setFiltroSit] = useState<string>("");
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});
  const [todosAbertos, setTodosAbertos] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<Resp>({
    queryKey: ["/api/suppliers/criticos/relatorio", inativos],
    queryFn: async () => {
      const r = await fetch(`/api/suppliers/criticos/relatorio${inativos ? "?inativos=1" : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Falha ao carregar o relatório");
      return r.json();
    },
    staleTime: 30_000,
  });

  const itens = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (data?.itens || [])
      .filter((i) => !filtroSit || i.situacao === filtroSit)
      .filter((i) => !q || [i.name, i.company_name, i.cnpj, i.cpf, i.city, i.default_category, i.contact_name].some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => SIT[a.situacao].ordem - SIT[b.situacao].ordem || a.name.localeCompare(b.name, "pt-BR"));
  }, [data, busca, filtroSit]);

  const toggle = (id: string) => setAbertos((a) => ({ ...a, [id]: !(a[id] ?? todosAbertos) }));
  const aberto = (id: string) => abertos[id] ?? todosAbertos;

  const exportarExcel = () => {
    if (!data) return;
    const forn = itens.map((i) => ({
      "Fornecedor": i.name,
      "Razão Social": i.company_name || "",
      "CNPJ/CPF": fmtDoc(i.cnpj, i.cpf),
      "Insc. Estadual": i.state_registration || "",
      "Categoria": i.default_category || "",
      "Contato": i.contact_name || "",
      "Telefone": i.phone || "",
      "E-mail": i.email || "",
      "Endereço": endereco(i),
      "Ativo": i.is_active === false ? "Não" : "Sim",
      "Situação": SIT[i.situacao].l,
      "Aprovado por": APROVADOR[i.critical_approved_by || ""] || "",
      "Data da aprovação": fmtData(i.critical_approved_at) === "—" ? "" : fmtData(i.critical_approved_at),
      "Vigência até": fmtData(i.critical_valid_until) === "—" ? "" : fmtData(i.critical_valid_until),
      "Dias p/ vencer": i.dias_para_vencer ?? "",
      "Pendências": i.total_pendencias,
      "Sem anexo": i.pendencias_sem_anexo,
      "Vencidas": i.pendencias_vencidas,
      "Vencendo": i.pendencias_vencendo,
      "Obs. aprovação": i.critical_notes || "",
      "Obs. cadastro": i.notes || "",
    }));
    const pend = itens.flatMap((i) => i.pendencias.map((p) => ({
      "Fornecedor": i.name,
      "CNPJ/CPF": fmtDoc(i.cnpj, i.cpf),
      "Tipo": p.tipo,
      "Descrição": p.descricao || "",
      "Vigência até": fmtData(p.valid_until) === "—" ? "" : fmtData(p.valid_until),
      "Dias p/ vencer": p.dias_para_vencer ?? "",
      "Anexo": p.anexo_nome || "",
      "Situação": SIT_PEND[p.situacao].l,
    })));
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(forn);
    ws1["!cols"] = Object.keys(forn[0] || { a: 1 }).map((k) => ({ wch: Math.min(50, Math.max(k.length + 2, ...forn.map((r: any) => String(r[k] ?? "").length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws1, "Fornecedores críticos");
    const ws2 = XLSX.utils.json_to_sheet(pend.length ? pend : [{ "Fornecedor": "", "Tipo": "", "Situação": "" }]);
    XLSX.utils.book_append_sheet(wb, ws2, "Pendências");
    XLSX.writeFile(wb, `fornecedores_criticos_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const r = data?.resumo || {};

  return (
    <div className="p-6 print:p-2">
      <div className="print:hidden"><BackToDashboardButton /></div>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/fornecedores"><Button variant="ghost" size="sm" className="print:hidden"><ArrowLeft className="w-4 h-4 mr-1" />Fornecedores</Button></Link>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ShieldAlert className="w-6 h-6 text-red-600" />Fornecedores Críticos</h1>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button variant="outline" onClick={exportarExcel} disabled={!data || itens.length === 0} data-testid="exportar-excel"><FileSpreadsheet className="w-4 h-4 mr-2" />Excel</Button>
          <Button variant="outline" onClick={() => { setTodosAbertos(true); setAbertos({}); setTimeout(() => window.print(), 150); }} disabled={!data}><Printer className="w-4 h-4 mr-2" />Imprimir</Button>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
          {[
            ["", "Total", r.total, "bg-gray-100 text-gray-800 border-gray-200"],
            ["regular", SIT.regular.l, r.regular, SIT.regular.cls],
            ["vencendo", SIT.vencendo.l, r.vencendo, SIT.vencendo.cls],
            ["vencido", SIT.vencido.l, r.vencido, SIT.vencido.cls],
            ["pendente", SIT.pendente.l, r.pendente, SIT.pendente.cls],
            ["nao_aprovado", SIT.nao_aprovado.l, r.nao_aprovado, SIT.nao_aprovado.cls],
          ].map(([k, l, n, cls]) => (
            <button key={String(k)} type="button" onClick={() => setFiltroSit(filtroSit === k ? "" : String(k))}
              className={`rounded-md border px-3 py-2 text-left ${cls} ${filtroSit === k ? "ring-2 ring-offset-1 ring-gray-500" : ""}`}>
              <div className="text-xs">{l}</div>
              <div className="text-xl font-bold">{n ?? 0}</div>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-center mb-3 flex-wrap print:hidden">
        <Input placeholder="Buscar por nome, CNPJ, cidade, categoria…" value={busca} onChange={(e) => setBusca(e.target.value)} className="max-w-sm" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> Incluir inativos</label>
        <Button variant="ghost" size="sm" onClick={() => { setTodosAbertos((v) => !v); setAbertos({}); }}>{todosAbertos ? "Recolher todos" : "Expandir todos"}</Button>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Atualizar"}</Button>
        {data && <span className="text-xs text-gray-500 ml-auto">Gerado em {new Date(data.gerado_em).toLocaleString("pt-BR")} · {itens.length} fornecedor(es)</span>}
      </div>

      {isLoading && <div className="py-12 flex justify-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin mr-2" />Carregando…</div>}
      {error && <p className="text-sm text-red-600">{String((error as any)?.message || error)}</p>}

      {data && itens.length === 0 && (
        <p className="text-sm text-gray-500 py-8 text-center">
          {data.itens.length === 0 ? <>Nenhum fornecedor marcado como crítico. Marque na aba <b>Crítico</b> do cadastro em <Link href="/fornecedores" className="underline">Fornecedores</Link>.</> : "Nenhum fornecedor com esse filtro."}
        </p>
      )}

      {itens.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="text-left">
                <th className="px-2 py-2 w-6"></th>
                <th className="px-2 py-2">Fornecedor</th>
                <th className="px-2 py-2">CNPJ/CPF</th>
                <th className="px-2 py-2">Categoria</th>
                <th className="px-2 py-2">Contato</th>
                <th className="px-2 py-2">Aprovado por</th>
                <th className="px-2 py-2">Aprovação</th>
                <th className="px-2 py-2">Vigência até</th>
                <th className="px-2 py-2 text-center">Pendências</th>
                <th className="px-2 py-2">Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {itens.map((i) => {
                const st = SIT[i.situacao];
                const exp = aberto(i.id);
                return (
                  <Fragment key={i.id}>
                    <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => toggle(i.id)} data-testid={`critico-${i.id}`}>
                      <td className="px-2 py-2 text-gray-400">{exp ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                      <td className="px-2 py-2">
                        <div className="font-medium">{i.name}{i.is_active === false && <span className="ml-2 text-xs text-gray-500">(inativo)</span>}</div>
                        {i.company_name && i.company_name !== i.name && <div className="text-xs text-gray-500">{i.company_name}</div>}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">{fmtDoc(i.cnpj, i.cpf)}</td>
                      <td className="px-2 py-2">{i.default_category || "—"}</td>
                      <td className="px-2 py-2">
                        <div>{i.contact_name || "—"}</div>
                        <div className="text-xs text-gray-500">{[i.phone, i.email].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="px-2 py-2">{APROVADOR[i.critical_approved_by || ""] || <span className="text-gray-400">—</span>}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{fmtData(i.critical_approved_at)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {fmtData(i.critical_valid_until)}
                        {i.dias_para_vencer != null && <div className={`text-xs ${i.dias_para_vencer < 0 ? "text-red-600" : i.dias_para_vencer <= 30 ? "text-orange-600" : "text-gray-500"}`}>{i.dias_para_vencer < 0 ? `vencido há ${-i.dias_para_vencer}d` : `${i.dias_para_vencer}d`}</div>}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {i.total_pendencias}
                        {(i.pendencias_sem_anexo || i.pendencias_vencidas || i.pendencias_vencendo) ? (
                          <div className="text-xs">
                            {i.pendencias_sem_anexo ? <span className="text-amber-700 mr-1">{i.pendencias_sem_anexo} s/ anexo</span> : null}
                            {i.pendencias_vencidas ? <span className="text-red-700 mr-1">{i.pendencias_vencidas} venc.</span> : null}
                            {i.pendencias_vencendo ? <span className="text-orange-700">{i.pendencias_vencendo} vencendo</span> : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-2"><span className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${st.cls}`}>{st.l}</span></td>
                    </tr>
                    {exp && (
                      <tr className="bg-gray-50/60">
                        <td></td>
                        <td colSpan={9} className="px-2 py-3">
                          <div className="grid md:grid-cols-2 gap-4 text-sm">
                            <div className="space-y-1">
                              <div className="font-semibold text-gray-700">Cadastro</div>
                              <div><span className="text-gray-500">Razão social:</span> {i.company_name || "—"}</div>
                              <div><span className="text-gray-500">Insc. Estadual:</span> {i.state_registration || "—"}</div>
                              <div><span className="text-gray-500">Endereço:</span> {endereco(i) || "—"}</div>
                              <div><span className="text-gray-500">Pagamento:</span> {[i.payment_method, i.payment_terms].filter(Boolean).join(" · ") || "—"}</div>
                              {i.notes && <div><span className="text-gray-500">Obs.:</span> {i.notes}</div>}
                              {i.critical_notes && <div><span className="text-gray-500">Obs. da aprovação:</span> {i.critical_notes}</div>}
                            </div>
                            <div>
                              <div className="font-semibold text-gray-700 mb-1">Pendências do cadastro</div>
                              {i.pendencias.length === 0 ? <div className="text-gray-400">Nenhuma pendência registrada.</div> : (
                                <table className="w-full text-xs border rounded">
                                  <thead className="bg-white"><tr className="text-left"><th className="px-2 py-1">Tipo</th><th className="px-2 py-1">Descrição</th><th className="px-2 py-1">Vigência</th><th className="px-2 py-1">Anexo</th><th className="px-2 py-1">Situação</th></tr></thead>
                                  <tbody className="divide-y bg-white">
                                    {i.pendencias.map((p) => (
                                      <tr key={p.id}>
                                        <td className="px-2 py-1 font-medium">{p.tipo}</td>
                                        <td className="px-2 py-1">{p.descricao || "—"}</td>
                                        <td className="px-2 py-1 whitespace-nowrap">{fmtData(p.valid_until)}</td>
                                        <td className="px-2 py-1">{p.attachment_id ? <a href={`/api/suppliers/anexos/${p.attachment_id}`} target="_blank" rel="noreferrer" className="hover:underline flex items-center gap-1" onClick={(e) => e.stopPropagation()}><Paperclip className="w-3 h-3" />{p.anexo_nome || "abrir"}</a> : <span className="text-gray-400">—</span>}</td>
                                        <td className="px-2 py-1"><span className={`px-2 py-0.5 rounded-full ${SIT_PEND[p.situacao].cls}`}>{SIT_PEND[p.situacao].l}</span></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
