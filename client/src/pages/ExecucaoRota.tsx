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
} from "@/lib/tableTools";

// VIGIA 1A — Execução de Rota (hoje): planejados x check-ins x vendas x não-vendas
// Fonte: GET /api/admin/routes/execution?date=YYYY-MM-DD (auto-refresh 60s)

type Pendente = { customerId: string; nome: string; cidade?: string };
type NaoVenda = { customerId: string; nome?: string; motivo?: string };
type SellerRow = {
  sellerId: string;
  sellerName: string;
  planejados: number;
  checkins: number;
  atendidos: number;
  vendas: number;
  valorVendas: number;
  naoVendas: number;
  cobertura: number | null;
  pendentes: Pendente[];
  naoVendasLista: NaoVenda[];
};
type ExecResp = {
  ok: boolean;
  date: string;
  totais: {
    planejados: number;
    checkins: number;
    atendidos: number;
    vendas: number;
    valorVendas: number;
    naoVendas: number;
    cobertura: number | null;
  };
  sellers: SellerRow[];
};

function hojeBRT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const fmtBRL = (v: number) =>
  (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function corCobertura(c: number | null): string {
  if (c === null || c === undefined) return "bg-gray-200 text-gray-600";
  if (c >= 90) return "bg-green-600 text-white";
  if (c >= 60) return "bg-amber-500 text-white";
  return "bg-red-600 text-white";
}

export default function ExecucaoRota() {
  const [date, setDate] = useState<string>(hojeBRT());
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const { sellerOptions, resolveSeller } = useActiveSellers();

  const { data, isFetching, dataUpdatedAt } = useQuery<ExecResp>({
    queryKey: ["/api/admin/routes/execution", date],
    queryFn: async () => {
      const r = await fetch(`/api/admin/routes/execution?date=${date}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Falha ao carregar execução de rota");
      return r.json();
    },
    refetchInterval: 60000,
  });

  const linhas = useMemo(() => {
    const all = data?.sellers || [];
    return all.filter((s) =>
      multiMatch(sellerMulti, resolveSeller(s.sellerName || s.sellerId)),
    );
  }, [data, sellerMulti, resolveSeller]);

  const tot = useMemo(() => {
    const a = {
      planejados: 0,
      checkins: 0,
      atendidos: 0,
      vendas: 0,
      valorVendas: 0,
      naoVendas: 0,
    };
    for (const s of linhas) {
      a.planejados += s.planejados;
      a.checkins += s.checkins;
      a.atendidos += s.atendidos;
      a.vendas += s.vendas;
      a.valorVendas += s.valorVendas;
      a.naoVendas += s.naoVendas;
    }
    return {
      ...a,
      cobertura:
        a.planejados > 0 ? Math.round((a.atendidos / a.planejados) * 100) : null,
    };
  }, [linhas]);

  const exportar = () => {
    exportToExcel(
      linhas.map((s) => ({
        Vendedor: s.sellerName,
        Planejados: s.planejados,
        "Check-ins": s.checkins,
        Atendidos: s.atendidos,
        Pendentes: s.pendentes.length,
        Vendas: s.vendas,
        "Valor Vendas": s.valorVendas,
        "Não-vendas": s.naoVendas,
        "Cobertura %": s.cobertura === null ? "" : s.cobertura,
        "Clientes pendentes": s.pendentes.map((p) => p.nome).join("; "),
      })),
      `execucao-rota-${date}`,
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-execucao-rota">
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <h1 className="text-2xl font-bold">Execução de Rota — Hoje</h1>
        {isFetching && (
          <span className="text-xs text-muted-foreground">atualizando…</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Data:{" "}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
            data-testid="input-data-execucao"
          />
        </label>
        <MultiSelect
          label="Vendedor"
          options={sellerOptions}
          selected={sellerMulti}
          onChange={setSellerMulti}
          testId="multiselect-vendedor-execucao"
        />
        <ExportExcelButton onClick={exportar} testId="export-execucao-rota" />
        <span className="text-xs text-muted-foreground">
          Atualiza a cada 60s
          {dataUpdatedAt
            ? ` · última: ${new Date(dataUpdatedAt).toLocaleTimeString("pt-BR")}`
            : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Planejados
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {tot.planejados}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Check-ins
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{tot.checkins}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Atendidos
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {tot.atendidos}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Cobertura
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge className={corCobertura(tot.cobertura)}>
              {tot.cobertura === null ? "—" : `${tot.cobertura}%`}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Vendas
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {tot.vendas}
            <div className="text-xs font-normal text-muted-foreground">
              {fmtBRL(tot.valorVendas)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">
              Não-vendas
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {tot.naoVendas}
          </CardContent>
        </Card>
      </div>

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
                <th>Vendedor</th>
                <th className="text-right">Planejados</th>
                <th className="text-right">Check-ins</th>
                <th className="text-right">Atendidos</th>
                <th className="text-right">Pendentes</th>
                <th className="text-right">Vendas</th>
                <th className="text-right">Valor</th>
                <th className="text-right">Não-vendas</th>
                <th className="text-right">Cobertura</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((s) => (
                <>
                  <tr
                    key={s.sellerId}
                    className="border-b hover:bg-muted/40 [&>td]:py-2 [&>td]:pr-3"
                  >
                    <td className="font-medium">{s.sellerName}</td>
                    <td className="text-right">{s.planejados}</td>
                    <td className="text-right">{s.checkins}</td>
                    <td className="text-right">{s.atendidos}</td>
                    <td className="text-right">{s.pendentes.length}</td>
                    <td className="text-right">{s.vendas}</td>
                    <td className="text-right">{fmtBRL(s.valorVendas)}</td>
                    <td className="text-right">{s.naoVendas}</td>
                    <td className="text-right">
                      <Badge className={corCobertura(s.cobertura)}>
                        {s.cobertura === null ? "—" : `${s.cobertura}%`}
                      </Badge>
                    </td>
                    <td className="text-right">
                      {(s.pendentes.length > 0 || s.naoVendasLista.length > 0) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setAberto(aberto === s.sellerId ? null : s.sellerId)
                          }
                          data-testid={`btn-detalhe-${s.sellerId}`}
                        >
                          {aberto === s.sellerId ? "Fechar" : "Detalhes"}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {aberto === s.sellerId && (
                    <tr key={s.sellerId + "-det"} className="border-b bg-muted/20">
                      <td colSpan={10} className="py-3 px-2">
                        {s.pendentes.length > 0 && (
                          <div className="mb-2">
                            <div className="font-semibold text-red-700 mb-1">
                              Ainda não visitados ({s.pendentes.length}):
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {s.pendentes.map((p) => (
                                <span
                                  key={p.customerId}
                                  className="inline-block bg-red-50 text-red-800 border border-red-200 rounded px-2 py-0.5 text-xs"
                                >
                                  {p.nome}
                                  {p.cidade ? ` · ${p.cidade}` : ""}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {s.naoVendasLista.length > 0 && (
                          <div>
                            <div className="font-semibold text-amber-700 mb-1">
                              Visitas sem venda ({s.naoVendasLista.length}):
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {s.naoVendasLista.map((n) => (
                                <span
                                  key={n.customerId}
                                  className="inline-block bg-amber-50 text-amber-800 border border-amber-200 rounded px-2 py-0.5 text-xs"
                                >
                                  {n.nome || n.customerId}
                                  {n.motivo ? ` — ${n.motivo}` : ""}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {linhas.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-muted-foreground">
                    Sem rotas para a data selecionada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Planejados = visitas físicas pendentes da agenda do dia (clientes ativos
        com coordenada). Atendido = check-in ou venda registrada no dia. Fonte de
        check-in: cartão de venda + checkpoints de rota.
      </p>
    </div>
  );
}
