import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { DateRangeFilter, exportToExcel, ExportExcelButton } from "@/lib/tableTools";

// ============================================================================
// EXTRATO DO CLIENTE — a "vida" do cliente com a Honest.
// Uma linha para cada nota faturada e uma linha para cada pagamento, por data,
// com saldo corrente acumulado. Fonte: /api/customer-statement/:customerId
// ============================================================================

type CustomerHit = {
  id: string;
  name: string;
  fantasyName?: string | null;
  document?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  isActive?: boolean;
  sellerName?: string | null;
};

type Linha = {
  key: string;
  data: string | null;
  tipo: "NF" | "PAGAMENTO";
  documento: string;
  nf: string;
  pedido?: string | null;
  descricao?: string | null;
  vencimento?: string | null;
  parcelas?: number | null;
  debito: number;
  credito: number;
  saldo: number;
  valorNota?: number;
  pagoNota?: number;
  saldoNota?: number;
  situacao: string;
  origem: string;
  cancelada?: boolean;
  diasAtraso?: number | null;
  formaPagamento?: string | null;
  conta?: string | null;
  estimado?: boolean;
};

type Extrato = {
  customer: any;
  resumo: {
    totalFaturado: number;
    totalPago: number;
    saldoDevedor: number;
    totalVencido: number;
    totalAVencer: number;
    qtdNotas: number;
    qtdNotasAbertas: number;
    qtdPagamentos: number;
    ticketMedio: number;
    primeiraCompra: string | null;
    ultimaCompra: string | null;
    diasSemComprar: number | null;
    atrasoMedioDias: number | null;
    notasCanceladas: number;
    baixasEstimadas: number;
  };
  linhas: Linha[];
  totalLinhas: number;
};

const fmtBRL = (v?: number | null) =>
  (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtData = (v?: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};

const fmtDoc = (v?: string | null) => {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return v || "—";
};

const SIT_COR: Record<string, string> = {
  Quitada: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Parcial: "bg-amber-100 text-amber-800 border-amber-200",
  "Em aberto": "bg-blue-100 text-blue-800 border-blue-200",
  Vencida: "bg-red-100 text-red-800 border-red-200",
  Cancelada: "bg-gray-200 text-gray-600 border-gray-300",
  Recebido: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const ORIGEM_LABEL: Record<string, string> = {
  financeiro: "Financeiro",
  nfe: "NF-e emitida",
  pedido: "Pedido faturado",
  baixa: "Baixa",
  baixa_importada: "Baixa importada",
};

function Kpi(props: { label: string; value: string; sub?: string; tone?: string; testId?: string }) {
  return (
    <div
      className={`rounded-lg border p-3 ${props.tone || "bg-white dark:bg-gray-800"}`}
      data-testid={props.testId}
    >
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{props.label}</div>
      <div className="text-lg font-bold leading-tight">{props.value}</div>
      {props.sub ? <div className="text-[11px] text-gray-500 dark:text-gray-400">{props.sub}</div> : null}
    </div>
  );
}

export default function ExtratoCliente() {
  const [location] = useLocation();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CustomerHit | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tipo, setTipo] = useState<"todos" | "NF" | "PAGAMENTO">("todos");
  const [busca, setBusca] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Permite abrir já num cliente: /extrato-cliente?customerId=...
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const cid = qs.get("customerId");
    if (cid && !selected) {
      setSelected({ id: cid, name: "Carregando..." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 350);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const { data: hits = [], isFetching: buscando } = useQuery<CustomerHit[]>({
    queryKey: ["customer-statement-search", debounced],
    queryFn: () => apiRequest("GET", `/api/customer-statement/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });

  const { data: extrato, isLoading, isError, error } = useQuery<Extrato>({
    queryKey: ["customer-statement", selected?.id, start, end],
    queryFn: () => {
      const p = new URLSearchParams();
      if (start) p.set("start", start);
      if (end) p.set("end", end);
      const qs = p.toString();
      return apiRequest("GET", `/api/customer-statement/${selected!.id}${qs ? "?" + qs : ""}`);
    },
    enabled: !!selected?.id,
  });

  const linhas = useMemo(() => {
    let out = extrato?.linhas || [];
    if (tipo !== "todos") out = out.filter((l) => l.tipo === tipo);
    const q = busca.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (l) =>
          String(l.documento || "").toLowerCase().includes(q) ||
          String(l.nf || "").toLowerCase().includes(q) ||
          String(l.pedido || "").toLowerCase().includes(q) ||
          String(l.descricao || "").toLowerCase().includes(q)
      );
    }
    return out;
  }, [extrato, tipo, busca]);

  const totaisVisiveis = useMemo(() => {
    const deb = linhas.reduce((s, l) => s + (l.debito || 0), 0);
    const cre = linhas.reduce((s, l) => s + (l.credito || 0), 0);
    return { deb, cre, saldo: deb - cre };
  }, [linhas]);

  const exportar = () => {
    const rows = linhas.map((l) => ({
      Data: fmtData(l.data),
      Tipo: l.tipo === "NF" ? "Nota faturada" : "Pagamento",
      Documento: l.documento,
      Pedido: l.pedido || "",
      Descricao: l.descricao || "",
      Vencimento: fmtData(l.vencimento),
      Parcelas: l.parcelas || "",
      "Forma de pagamento": l.formaPagamento || "",
      Debito: l.debito || 0,
      Credito: l.credito || 0,
      Saldo: l.saldo,
      Situacao: l.situacao,
      "Dias de atraso": l.diasAtraso ?? "",
      Origem: ORIGEM_LABEL[l.origem] || l.origem,
      "Data estimada": l.estimado ? "SIM" : "",
    }));
    const nome = (extrato?.customer?.name || "cliente").replace(/[^\w]+/g, "_").slice(0, 40);
    exportToExcel(rows, `extrato_${nome}`);
  };

  const r = extrato?.resumo;

  return (
    <div className="space-y-4" data-testid="page-extrato-cliente">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Extrato do Cliente</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Histórico completo: uma linha por nota faturada e uma linha por pagamento, com saldo acumulado.
          </p>
        </div>
        <BackToDashboardButton />
      </div>

      {/* Seletor de cliente */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[280px] flex-1" ref={boxRef}>
              <label className="text-xs text-gray-500 dark:text-gray-400">Cliente</label>
              <input
                value={term}
                onChange={(e) => {
                  setTerm(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder="Digite o nome, fantasia ou CNPJ/CPF do cliente..."
                className="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700"
                data-testid="input-busca-cliente"
              />
              {open && debounced.length >= 2 ? (
                <div className="absolute z-30 mt-1 w-full max-h-80 overflow-auto rounded-md border bg-white dark:bg-gray-800 shadow-lg">
                  {buscando ? (
                    <div className="px-3 py-2 text-sm text-gray-500">Buscando...</div>
                  ) : hits.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500">Nenhum cliente encontrado.</div>
                  ) : (
                    hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setSelected(h);
                          setTerm(h.name);
                          setOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 border-b last:border-b-0 dark:border-gray-700"
                        data-testid={`option-cliente-${h.id}`}
                      >
                        <div className="text-sm font-medium flex items-center gap-2">
                          {h.name}
                          {h.isActive === false ? (
                            <Badge variant="outline" className="text-[10px]">inativo</Badge>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {fmtDoc(h.document)} · {h.city || "—"}/{h.state || "—"}
                          {h.sellerName ? ` · ${h.sellerName}` : ""}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block">Período</label>
              <DateRangeFilter start={start} end={end} onChange={(s, e) => { setStart(s); setEnd(e); }} />
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block">Tipo</label>
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value as any)}
                className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm"
                data-testid="select-tipo-linha"
              >
                <option value="todos">Notas + Pagamentos</option>
                <option value="NF">Somente notas</option>
                <option value="PAGAMENTO">Somente pagamentos</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block">NF / pedido</label>
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Filtrar..."
                className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm w-36"
                data-testid="input-filtro-nf"
              />
            </div>

            {extrato ? <ExportExcelButton onClick={exportar} testId="button-exportar-extrato" /> : null}
            {extrato ? (
              <Button variant="outline" onClick={() => window.print()} data-testid="button-imprimir-extrato">
                Imprimir
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {!selected ? (
        <Card>
          <CardContent className="py-10 text-center text-gray-500">
            Selecione um cliente para ver todo o histórico de compras e pagamentos.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card><CardContent className="py-10 text-center text-gray-500">Carregando extrato...</CardContent></Card>
      ) : isError ? (
        <Card><CardContent className="py-10 text-center text-red-600">{(error as any)?.message || "Erro ao carregar o extrato."}</CardContent></Card>
      ) : extrato ? (
        <>
          {/* Identificação + KPIs */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                {extrato.customer?.name}
                {extrato.customer?.isActive === false ? <Badge variant="outline">inativo</Badge> : null}
                <span className="text-sm font-normal text-gray-500">
                  {fmtDoc(extrato.customer?.document)} · {extrato.customer?.city || "—"}/{extrato.customer?.state || "—"}
                  {extrato.customer?.sellerName ? ` · Vendedor: ${extrato.customer.sellerName}` : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
                <Kpi label="Total faturado" value={fmtBRL(r?.totalFaturado)} sub={`${r?.qtdNotas || 0} notas`} testId="kpi-faturado" />
                <Kpi label="Total pago" value={fmtBRL(r?.totalPago)} sub={`${r?.qtdPagamentos || 0} pagamentos`} tone="bg-emerald-50 dark:bg-emerald-900/20" testId="kpi-pago" />
                <Kpi
                  label="Saldo devedor"
                  value={fmtBRL(r?.saldoDevedor)}
                  sub={`${r?.qtdNotasAbertas || 0} em aberto`}
                  tone={(r?.saldoDevedor || 0) > 0.009 ? "bg-amber-50 dark:bg-amber-900/20" : "bg-white dark:bg-gray-800"}
                  testId="kpi-saldo"
                />
                <Kpi label="Vencido" value={fmtBRL(r?.totalVencido)} tone={(r?.totalVencido || 0) > 0.009 ? "bg-red-50 dark:bg-red-900/20" : ""} testId="kpi-vencido" />
                <Kpi label="A vencer" value={fmtBRL(r?.totalAVencer)} testId="kpi-a-vencer" />
                <Kpi label="Ticket médio" value={fmtBRL(r?.ticketMedio)} sub={r?.atrasoMedioDias != null ? `atraso médio: ${r.atrasoMedioDias}d` : undefined} testId="kpi-ticket" />
                <Kpi
                  label="Relacionamento"
                  value={fmtData(r?.primeiraCompra)}
                  sub={`última: ${fmtData(r?.ultimaCompra)}${r?.diasSemComprar != null ? ` (${r.diasSemComprar}d)` : ""}`}
                  testId="kpi-relacionamento"
                />
              </div>
              {(r?.baixasEstimadas || 0) > 0 ? (
                <div className="mt-3 text-[11px] text-amber-700 dark:text-amber-300">
                  ⚠ {r?.baixasEstimadas} baixa(s) vieram do histórico importado sem data de pagamento — foram lançadas na data
                  de vencimento e aparecem marcadas como <em>data estimada</em>.
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Extrato */}
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between">
              <CardTitle className="text-base">
                Movimentação ({linhas.length} de {extrato.totalLinhas} lançamentos)
              </CardTitle>
              <div className="text-sm text-gray-600 dark:text-gray-300">
                Débitos {fmtBRL(totaisVisiveis.deb)} · Créditos {fmtBRL(totaisVisiveis.cre)} ·{" "}
                <strong>Saldo {fmtBRL(totaisVisiveis.saldo)}</strong>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                    <tr className="text-left">
                      <th className="px-3 py-2 whitespace-nowrap">Data</th>
                      <th className="px-3 py-2 whitespace-nowrap">Tipo</th>
                      <th className="px-3 py-2 whitespace-nowrap">Documento</th>
                      <th className="px-3 py-2">Descrição</th>
                      <th className="px-3 py-2 whitespace-nowrap">Vencimento</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Venda (D)</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Pagamento (C)</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Saldo</th>
                      <th className="px-3 py-2 whitespace-nowrap">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                          Nenhum lançamento no período/filtro selecionado.
                        </td>
                      </tr>
                    ) : (
                      linhas.map((l) => (
                        <tr
                          key={l.key}
                          className={`border-t dark:border-gray-700 ${
                            l.tipo === "PAGAMENTO" ? "bg-emerald-50/40 dark:bg-emerald-900/10" : ""
                          } ${l.cancelada ? "opacity-60 line-through" : ""}`}
                          data-testid={`linha-${l.key}`}
                        >
                          <td className="px-3 py-2 whitespace-nowrap">
                            {fmtData(l.data)}
                            {l.estimado ? <span className="ml-1 text-[10px] text-amber-600">(est.)</span> : null}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {l.tipo === "NF" ? (
                              <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300 font-medium">
                                <i className="fas fa-file-invoice-dollar text-[11px]" /> Nota
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-medium">
                                <i className="fas fa-hand-holding-dollar text-[11px]" /> Pagamento
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                            {l.documento}
                            {l.parcelas && l.parcelas > 1 ? (
                              <span className="ml-1 text-[10px] text-gray-500">({l.parcelas} parc.)</span>
                            ) : null}
                            {l.pedido ? <div className="text-[10px] text-gray-400">ped. {l.pedido}</div> : null}
                          </td>
                          <td className="px-3 py-2 max-w-[280px] truncate" title={l.descricao || ""}>
                            {l.descricao || "—"}
                            {l.formaPagamento ? (
                              <span className="ml-1 text-[10px] text-gray-500">· {l.formaPagamento}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {fmtData(l.vencimento)}
                            {l.tipo === "PAGAMENTO" && l.diasAtraso != null && l.diasAtraso > 0 ? (
                              <span className="ml-1 text-[10px] text-red-600">+{l.diasAtraso}d</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                            {l.debito ? fmtBRL(l.debito) : ""}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-emerald-700 dark:text-emerald-300">
                            {l.credito ? fmtBRL(l.credito) : ""}
                          </td>
                          <td className={`px-3 py-2 text-right whitespace-nowrap font-semibold ${l.saldo > 0.009 ? "text-amber-700 dark:text-amber-300" : "text-gray-500"}`}>
                            {fmtBRL(l.saldo)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded-full border text-[11px] ${SIT_COR[l.situacao] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                              {l.situacao}
                            </span>
                            {l.tipo === "NF" && l.saldoNota != null && l.saldoNota > 0.009 && (l.pagoNota || 0) > 0 ? (
                              <div className="text-[10px] text-gray-500">falta {fmtBRL(l.saldoNota)}</div>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {linhas.length ? (
                    <tfoot className="bg-gray-50 dark:bg-gray-800 font-semibold">
                      <tr className="border-t-2 dark:border-gray-600">
                        <td className="px-3 py-2" colSpan={5}>Totais do filtro</td>
                        <td className="px-3 py-2 text-right">{fmtBRL(totaisVisiveis.deb)}</td>
                        <td className="px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{fmtBRL(totaisVisiveis.cre)}</td>
                        <td className="px-3 py-2 text-right">{fmtBRL(totaisVisiveis.saldo)}</td>
                        <td className="px-3 py-2"></td>
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
