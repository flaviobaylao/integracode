import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useActiveSellers,
  MultiSelect,
  multiMatch,
  exportToExcel,
  ExportExcelButton,
  useTableSort,
  SortableTh,
} from "@/lib/tableTools";

// VIGIA 2A — Radar de Churn por cadência.
// Fonte: GET /api/admin/churn/radar (última compra x periodicidade -> faixa de risco)

type Faixa = "em_dia" | "esfriando" | "em_risco" | "perdido" | "sem_historico";

type Cliente = {
  customerId: string;
  nome: string;
  cidade?: string;
  sellerId: string;
  sellerName: string;
  periodicidade: string;
  intervalo: number;
  ultimaCompra: string | null;
  diasSemCompra: number | null;
  ciclos: number | null;
  valorHistorico: number;
  valorHistorico6m: number;
  nPedidos: number;
  faixa: Faixa;
};
type SellerRow = {
  sellerId: string;
  sellerName: string;
  total: number;
  em_dia: number;
  esfriando: number;
  em_risco: number;
  perdido: number;
  sem_historico: number;
  valorEmRisco: number;
};
type RadarResp = {
  ok: boolean;
  date: string;
  resumo: {
    total: number;
    em_dia: number;
    esfriando: number;
    em_risco: number;
    perdido: number;
    sem_historico: number;
    valorEmRisco: number;
  };
  por_vendedor: SellerRow[];
  transicoes: {
    count: number;
    novosEmRisco: {
      customerId: string;
      nome: string;
      sellerName: string;
      faixa: Faixa;
      faixaAnterior: Faixa;
      valorHistorico: number;
    }[];
  };
  clientes: Cliente[];
};

const fmtBRL = (v: number) =>
  (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const FAIXA_LABEL: Record<Faixa, string> = {
  em_dia: "Em dia",
  esfriando: "Esfriando",
  em_risco: "Em risco",
  perdido: "Perdido",
  sem_historico: "Sem histórico",
};
const FAIXA_COR: Record<Faixa, string> = {
  em_dia: "bg-green-600 text-white",
  esfriando: "bg-amber-500 text-white",
  em_risco: "bg-orange-600 text-white",
  perdido: "bg-red-600 text-white",
  sem_historico: "bg-gray-400 text-white",
};

function fmtData(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("pt-BR");
  } catch {
    return "—";
  }
}

export default function RadarChurn() {
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [abertoPerdida, setAbertoPerdida] = useState<string | null>(null);
  const { sellerOptions, resolveSeller } = useActiveSellers();

  const { data, isFetching, dataUpdatedAt } = useQuery<RadarResp>({
    queryKey: ["/api/admin/churn/radar"],
    queryFn: async () => {
      const r = await fetch(`/api/admin/churn/radar`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Falha ao carregar radar de churn");
      return r.json();
    },
    refetchInterval: 300000,
  });

  const linhas = useMemo(() => {
    const all = data?.por_vendedor || [];
    return all.filter((s) =>
      multiMatch(sellerMulti, resolveSeller(s.sellerName || s.sellerId)),
    );
  }, [data, sellerMulti, resolveSeller]);

  const sort1 = useTableSort();
  const sort2 = useTableSort();

  const clientesPorVendedor = useMemo(() => {
    const map = new Map<string, Cliente[]>();
    for (const c of data?.clientes || []) {
      if (c.faixa !== "em_risco" && c.faixa !== "perdido") continue;
      const arr = map.get(c.sellerName) || [];
      arr.push(c);
      map.set(c.sellerName, arr);
    }
    for (const arr of map.values())
      arr.sort((a, b) => b.valorHistorico - a.valorHistorico);
    return map;
  }, [data]);

  const carteiraPerdida = useMemo(() => {
    const map = new Map<string, { sellerName: string; valor6m: number; clientes: Cliente[] }>();
    for (const c of data?.clientes || []) {
      if (c.faixa !== "perdido") continue;
      if (!multiMatch(sellerMulti, resolveSeller(c.sellerName || c.sellerId))) continue;
      const g = map.get(c.sellerName) || { sellerName: c.sellerName, valor6m: 0, clientes: [] };
      g.valor6m += c.valorHistorico6m || 0;
      g.clientes.push(c);
      map.set(c.sellerName, g);
    }
    const arr = Array.from(map.values());
    for (const g of arr) g.clientes.sort((a, b) => (b.valorHistorico6m || 0) - (a.valorHistorico6m || 0));
    arr.sort((a, b) => b.valor6m - a.valor6m);
    return arr;
  }, [data, sellerMulti, resolveSeller]);

  const totalPerdido6m = useMemo(
    () => carteiraPerdida.reduce((s, g) => s + g.valor6m, 0),
    [carteiraPerdida],
  );

  const tot = useMemo(() => {
    const a = {
      total: 0,
      em_dia: 0,
      esfriando: 0,
      em_risco: 0,
      perdido: 0,
      sem_historico: 0,
      valorEmRisco: 0,
    };
    for (const s of linhas) {
      a.total += s.total;
      a.em_dia += s.em_dia;
      a.esfriando += s.esfriando;
      a.em_risco += s.em_risco;
      a.perdido += s.perdido;
      a.sem_historico += s.sem_historico;
      a.valorEmRisco += s.valorEmRisco;
    }
    return a;
  }, [linhas]);

  const novos = useMemo(
    () =>
      (data?.transicoes?.novosEmRisco || []).filter((n) =>
        multiMatch(sellerMulti, resolveSeller(n.sellerName)),
      ),
    [data, sellerMulti, resolveSeller],
  );

  const exportar = () => {
    exportToExcel(
      (data?.clientes || [])
        .filter((c) =>
          multiMatch(sellerMulti, resolveSeller(c.sellerName || c.sellerId)),
        )
        .map((c) => ({
          Cliente: c.nome,
          Cidade: c.cidade || "",
          Vendedor: c.sellerName,
          Periodicidade: c.periodicidade,
          "Última compra": fmtData(c.ultimaCompra),
          "Dias sem compra": c.diasSemCompra ?? "",
          "Ciclos perdidos": c.ciclos ?? "",
          Faixa: FAIXA_LABEL[c.faixa],
          "Valor histórico": c.valorHistorico,
          Pedidos: c.nPedidos,
        })),
      `radar-churn-${data?.date || "hoje"}`,
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-radar-churn">
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <h1 className="text-2xl font-bold">Radar de Churn</h1>
        {isFetching && (
          <span className="text-xs text-muted-foreground">atualizando…</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <MultiSelect
          label="Vendedor"
          options={sellerOptions}
          selected={sellerMulti}
          onChange={setSellerMulti}
          testId="multiselect-vendedor-churn"
        />
        <ExportExcelButton onClick={exportar} testId="export-radar-churn" />
        <span className="text-xs text-muted-foreground">
          {dataUpdatedAt
            ? `última: ${new Date(dataUpdatedAt).toLocaleTimeString("pt-BR")}`
            : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {(
          [
            ["Em dia", tot.em_dia, "text-green-700"],
            ["Esfriando", tot.esfriando, "text-amber-600"],
            ["Em risco", tot.em_risco, "text-orange-700"],
            ["Perdido", tot.perdido, "text-red-700"],
            ["Sem histórico", tot.sem_historico, "text-gray-600"],
          ] as [string, number, string][]
        ).map(([label, val, cor]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className={`text-2xl font-bold ${cor}`}>
              {val}
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Valor em risco
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-bold text-red-700">
            {fmtBRL(tot.valorEmRisco)}
          </CardContent>
        </Card>
      </div>

      {novos.length > 0 && (
        <Card className="border-orange-300">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-orange-700">
              Entraram em risco hoje ({novos.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {novos.map((n) => (
                <span
                  key={n.customerId}
                  className="inline-block bg-orange-50 text-orange-800 border border-orange-200 rounded px-2 py-0.5 text-xs"
                >
                  {n.nome} · {n.sellerName} · {fmtBRL(n.valorHistorico)}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Por vendedor ({linhas.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b [&>th]:py-2 [&>th]:pr-3 [&>th]:sticky [&>th]:top-0 [&>th]:bg-background">
                <SortableTh label="Vendedor" colKey="vendedor" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} />
                <SortableTh label="Total" colKey="total" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Em dia" colKey="emdia" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Esfriando" colKey="esfriando" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Em risco" colKey="emrisco" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Perdido" colKey="perdido" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Sem hist." colKey="semhist" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <SortableTh label="Valor em risco" colKey="valor" sortKey={sort1.sortKey} sortDir={sort1.sortDir} onSort={sort1.toggleSort} align="right" className="text-right" />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort1.sortRows(linhas, (s: any, key: string) => { switch (key) { case 'vendedor': return s.sellerName || ''; case 'total': return Number(s.total || 0); case 'emdia': return Number(s.em_dia || 0); case 'esfriando': return Number(s.esfriando || 0); case 'emrisco': return Number(s.em_risco || 0); case 'perdido': return Number(s.perdido || 0); case 'semhist': return Number(s.sem_historico || 0); case 'valor': return Number(s.valorEmRisco || 0); default: return ''; } }).map((s) => {
                const clis = clientesPorVendedor.get(s.sellerName) || [];
                return (
                  <>
                    <tr
                      key={s.sellerName}
                      className="border-b hover:bg-muted/40 [&>td]:py-2 [&>td]:pr-3"
                    >
                      <td className="font-medium">{s.sellerName}</td>
                      <td className="text-right">{s.total}</td>
                      <td className="text-right text-green-700">{s.em_dia}</td>
                      <td className="text-right text-amber-600">
                        {s.esfriando}
                      </td>
                      <td className="text-right text-orange-700 font-semibold">
                        {s.em_risco}
                      </td>
                      <td className="text-right text-red-700 font-semibold">
                        {s.perdido}
                      </td>
                      <td className="text-right text-gray-500">
                        {s.sem_historico}
                      </td>
                      <td className="text-right">{fmtBRL(s.valorEmRisco)}</td>
                      <td className="text-right">
                        {clis.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setAberto(
                                aberto === s.sellerName ? null : s.sellerName,
                              )
                            }
                            data-testid={`btn-detalhe-${s.sellerId}`}
                          >
                            {aberto === s.sellerName ? "Fechar" : "Detalhes"}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {aberto === s.sellerName && clis.length > 0 && (
                      <tr
                        key={s.sellerName + "-det"}
                        className="border-b bg-muted/20"
                      >
                        <td colSpan={9} className="py-3 px-2">
                          <div className="font-semibold text-red-700 mb-1">
                            Em risco / perdidos ({clis.length}):
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {clis.map((c) => (
                              <span
                                key={c.customerId}
                                className="inline-flex items-center gap-1 bg-red-50 text-red-800 border border-red-200 rounded px-2 py-0.5 text-xs"
                              >
                                <Badge className={FAIXA_COR[c.faixa] + " text-[10px] px-1 py-0"}>
                                  {FAIXA_LABEL[c.faixa]}
                                </Badge>
                                {c.nome}
                                {c.cidade ? ` · ${c.cidade}` : ""} ·{" "}
                                {c.diasSemCompra ?? "?"}d · {fmtBRL(c.valorHistorico)}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
              {linhas.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="py-6 text-center text-muted-foreground"
                  >
                    Sem dados de churn.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Carteira Perdida — recuperação (6m)</span>
            <span className="text-sm font-normal text-red-700">
              {fmtBRL(totalPerdido6m)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b [&>th]:py-2 [&>th]:pr-3 [&>th]:sticky [&>th]:top-0 [&>th]:bg-background">
                <SortableTh label="Vendedor" colKey="vendedor" sortKey={sort2.sortKey} sortDir={sort2.sortDir} onSort={sort2.toggleSort} />
                <SortableTh label="Perdidos" colKey="perdidos" sortKey={sort2.sortKey} sortDir={sort2.sortDir} onSort={sort2.toggleSort} align="right" className="text-right" />
                <SortableTh label="Valor perdido (6m)" colKey="valor6m" sortKey={sort2.sortKey} sortDir={sort2.sortDir} onSort={sort2.toggleSort} align="right" className="text-right" />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort2.sortRows(carteiraPerdida, (g: any, key: string) => { switch (key) { case 'vendedor': return g.sellerName || ''; case 'perdidos': return g.clientes ? g.clientes.length : 0; case 'valor6m': return Number(g.valor6m || 0); default: return ''; } }).map((g) => (
                <>
                  <tr
                    key={g.sellerName}
                    className="border-b hover:bg-muted/40 [&>td]:py-2 [&>td]:pr-3"
                  >
                    <td className="font-medium">{g.sellerName}</td>
                    <td className="text-right text-red-700 font-semibold">
                      {g.clientes.length}
                    </td>
                    <td className="text-right">{fmtBRL(g.valor6m)}</td>
                    <td className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setAbertoPerdida(
                            abertoPerdida === g.sellerName ? null : g.sellerName,
                          )
                        }
                      >
                        {abertoPerdida === g.sellerName ? "Fechar" : "Ver clientes"}
                      </Button>
                    </td>
                  </tr>
                  {abertoPerdida === g.sellerName && (
                    <tr key={g.sellerName + "-cp"} className="border-b bg-muted/20">
                      <td colSpan={4} className="py-3 px-2">
                        <div className="flex flex-wrap gap-1">
                          {g.clientes.map((c) => (
                            <span
                              key={c.customerId}
                              className="inline-block bg-red-50 text-red-800 border border-red-200 rounded px-2 py-0.5 text-xs"
                            >
                              {c.nome}
                              {c.cidade ? ` · ${c.cidade}` : ""} ·{" "}
                              {c.diasSemCompra ?? "?"}d · 6m {fmtBRL(c.valorHistorico6m)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {carteiraPerdida.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-muted-foreground">
                    Nenhum cliente na faixa "perdido".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Faixa = ciclos sem compra (dias desde a última compra ÷ intervalo da
        periodicidade: semanal 7 / quinzenal 14 / mensal 28). Em dia (&lt;1) ·
        Esfriando (1–2) · Em risco (2–3) · Perdido (≥3). Última compra vem do
        pipeline de faturamento (billing_pipeline).
      </p>
    </div>
  );
}
