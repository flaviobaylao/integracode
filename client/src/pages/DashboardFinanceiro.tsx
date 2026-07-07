import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import {
  DollarSign, TrendingUp, TrendingDown, AlertTriangle, CalendarDays, Wallet, RefreshCw,
} from "lucide-react";

const fmt = (v: any) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtD = (s?: string) =>
  s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "-";
const fmtMes = (m: string) => {
  const [y, mo] = (m || "").split("-");
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return nomes[(parseInt(mo, 10) || 1) - 1] + "/" + (y || "").slice(2);
};

function KpiCard({ title, value, sub, icon: Icon, tone }: any) {
  const tones: Record<string, string> = {
    green: "text-green-600 bg-green-50",
    red: "text-red-600 bg-red-50",
    amber: "text-amber-600 bg-amber-50",
    blue: "text-blue-600 bg-blue-50",
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`rounded-lg p-2 ${tones[tone] || tones.blue}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{title}</div>
          <div className="text-lg font-bold truncate">{value}</div>
          {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardFinanceiro() {
  const { data, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ["/api/admin/financial/dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/admin/financial/dashboard", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error("Falha ao carregar dashboard financeiro");
      return r.json();
    },
    refetchInterval: 120000,
  });

  const k = data?.kpis || {};
  const fluxo: any[] = data?.fluxo || [];
  let acc = 0;
  const fluxoChart = fluxo.map((m: any) => {
    const saldo = Number(m.entradas || 0) - Number(m.saidas || 0);
    acc += saldo;
    return {
      mes: fmtMes(m.mes),
      Entradas: Number(m.entradas || 0),
      Saidas: Number(m.saidas || 0),
      Saldo: saldo,
      Acumulado: acc,
    };
  });

  const fluxoDiario: any[] = data?.fluxoDiario || [];
  const fmtDia = (d: string) => { const pp = String(d || '').split('-'); return pp.length === 3 ? pp[2] + '/' + pp[1] : d; };
  const fluxoDiarioChart = fluxoDiario.map((d: any) => ({
    dia: fmtDia(d.dia),
    Entradas: Number(d.entradas || 0),
    Saidas: Number(d.saidas || 0),
    Saldo: Number(d.saldo || 0),
    Acumulado: Number(d.saldoAcumulado || 0),
  }));

  const pagarHoje: any[] = data?.pagarHoje || [];
  const pagarVencidas: any[] = data?.pagarVencidas || [];
  const receberHoje: any[] = data?.receberHoje || [];
  const topDevedores: any[] = data?.topDevedores || [];
  const agingReceber: any[] = data?.agingReceber || [];
  const agingPagar: any[] = data?.agingPagar || [];

  return (
    <div className="container mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <BackToDashboardButton />
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="h-6 w-6 text-green-600" /> Dashboard Financeiro
          </h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {data?.hoje && <span>Hoje: {fmtD(data.hoje)}</span>}
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1 border rounded-md px-2 py-1 hover:bg-muted"
            data-testid="button-refresh-dashfin"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Atualizar
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Carregando dados financeiros...</div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KpiCard title="A Receber (em aberto)" value={fmt(k.receberAberto)} sub={`${k.receberAbertoN || 0} contas`} icon={TrendingUp} tone="green" />
            <KpiCard title="A Pagar (em aberto)" value={fmt(k.pagarAberto)} sub={`${k.pagarAbertoN || 0} contas`} icon={TrendingDown} tone="red" />
            <KpiCard title="Vence HOJE (receber)" value={fmt(k.receberHoje)} sub={`${k.receberHojeN || 0} contas`} icon={CalendarDays} tone="blue" />
            <KpiCard title="Vence HOJE (pagar)" value={fmt(k.pagarHoje)} sub={`${k.pagarHojeN || 0} contas`} icon={CalendarDays} tone="amber" />
            <KpiCard title="Vencidas a receber" value={fmt(k.receberVencido)} sub={`${k.receberVencidoN || 0} contas`} icon={AlertTriangle} tone="amber" />
            <KpiCard title="Vencidas a pagar" value={fmt(k.pagarVencido)} sub={`${k.pagarVencidoN || 0} contas`} icon={AlertTriangle} tone="red" />
          </div>

          {/* Fluxo de caixa */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-green-600" />
                Fluxo de Caixa (contas em aberto por mês de vencimento)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={fluxoChart}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="mes" fontSize={12} />
                    <YAxis fontSize={11} tickFormatter={(v: any) => (Number(v) / 1000).toFixed(0) + "k"} />
                    <Tooltip formatter={(v: any) => fmt(v)} />
                    <Legend />
                    <Bar dataKey="Entradas" fill="#16a34a" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Saidas" name="Saídas" fill="#dc2626" radius={[3, 3, 0, 0]} />
                    <Line type="monotone" dataKey="Acumulado" stroke="#2563eb" strokeWidth={2} dot />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mês</TableHead>
                    <TableHead className="text-right">Entradas (a receber)</TableHead>
                    <TableHead className="text-right">Saídas (a pagar)</TableHead>
                    <TableHead className="text-right">Saldo do mês</TableHead>
                    <TableHead className="text-right">Saldo acumulado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fluxoChart.map((m) => (
                    <TableRow key={m.mes}>
                      <TableCell className="font-medium">{m.mes}</TableCell>
                      <TableCell className="text-right text-green-700">{fmt(m.Entradas)}</TableCell>
                      <TableCell className="text-right text-red-700">{fmt(m.Saidas)}</TableCell>
                      <TableCell className={`text-right font-medium ${m.Saldo < 0 ? "text-red-700" : "text-green-700"}`}>{fmt(m.Saldo)}</TableCell>
                      <TableCell className={`text-right font-bold ${m.Acumulado < 0 ? "text-red-700" : ""}`}>{fmt(m.Acumulado)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Fluxo de caixa DIARIO - proximos 30 dias */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-blue-600" />
                Fluxo de Caixa — Próximos 30 dias (por dia)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={fluxoDiarioChart}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="dia" fontSize={10} interval={2} />
                    <YAxis fontSize={11} tickFormatter={(v: any) => (Number(v) / 1000).toFixed(0) + "k"} />
                    <Tooltip formatter={(v: any) => fmt(v)} />
                    <Legend />
                    <Bar dataKey="Entradas" fill="#16a34a" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Saidas" name="Saídas" fill="#dc2626" radius={[3, 3, 0, 0]} />
                    <Line type="monotone" dataKey="Acumulado" stroke="#2563eb" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="max-h-80 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dia</TableHead>
                      <TableHead className="text-right">Entradas (a receber)</TableHead>
                      <TableHead className="text-right">Saídas (a pagar)</TableHead>
                      <TableHead className="text-right">Saldo do dia</TableHead>
                      <TableHead className="text-right">Saldo acumulado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fluxoDiarioChart.map((d) => (
                      <TableRow key={d.dia}>
                        <TableCell className="font-medium">{d.dia}</TableCell>
                        <TableCell className="text-right text-green-700">{d.Entradas ? fmt(d.Entradas) : "—"}</TableCell>
                        <TableCell className="text-right text-red-700">{d.Saidas ? fmt(d.Saidas) : "—"}</TableCell>
                        <TableCell className={`text-right font-medium ${d.Saldo < 0 ? "text-red-700" : d.Saldo > 0 ? "text-green-700" : ""}`}>{d.Saldo ? fmt(d.Saldo) : "—"}</TableCell>
                        <TableCell className={`text-right font-bold ${d.Acumulado < 0 ? "text-red-700" : ""}`}>{fmt(d.Acumulado)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Contas a pagar do dia + vencidas */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-amber-600" />
                  Contas a Pagar HOJE
                  <Badge variant="secondary">{pagarHoje.length} · {fmt(pagarHoje.reduce((s, r) => s + Number(r.saldo || 0), 0))}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {pagarHoje.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">Nenhuma conta vencendo hoje.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Título</TableHead>
                        <TableHead>Fornecedor</TableHead>
                        <TableHead className="text-right">Saldo a pagar</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagarHoje.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{r.titulo || "-"}</TableCell>
                          <TableCell className="max-w-[240px] truncate">{r.fornecedor || r.descricao || "-"}</TableCell>
                          <TableCell className="text-right font-medium">{fmt(r.saldo)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  Vencidas e NÃO pagas
                  <Badge variant="destructive">{k.pagarVencidoN || 0} · {fmt(k.pagarVencido)}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {pagarVencidas.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">Nenhuma conta vencida em aberto.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Título</TableHead>
                        <TableHead>Fornecedor</TableHead>
                        <TableHead>Vencimento</TableHead>
                        <TableHead className="text-right">Saldo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagarVencidas.map((r, i) => (
                        <TableRow key={i} className="text-red-700">
                          <TableCell className="font-medium">{r.titulo || "-"}</TableCell>
                          <TableCell className="max-w-[200px] truncate">{r.fornecedor || r.descricao || "-"}</TableCell>
                          <TableCell>{fmtD(r.vencimento)}</TableCell>
                          <TableCell className="text-right font-medium">{fmt(r.saldo)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {(k.pagarVencidoN || 0) > pagarVencidas.length && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Mostrando as {pagarVencidas.length} mais antigas de {k.pagarVencidoN}.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Receber hoje + aging + devedores */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  A Receber HOJE
                  <Badge variant="secondary">{k.receberHojeN || 0} · {fmt(k.receberHoje)}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {receberHoje.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">Nenhum recebimento previsto hoje.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cliente</TableHead>
                        <TableHead className="text-right">Saldo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {receberHoje.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="max-w-[220px] truncate">{r.cliente || r.titulo || "-"}</TableCell>
                          <TableCell className="text-right">{fmt(r.saldo)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Aging de vencidos (dias de atraso)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">A RECEBER</div>
                  {agingReceber.map((a: any) => (
                    <div key={"r" + a.faixa} className="flex justify-between text-sm border-b py-1">
                      <span>{a.faixa} dias <span className="text-muted-foreground">({a.n})</span></span>
                      <span className="font-medium">{fmt(a.valor)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">A PAGAR</div>
                  {agingPagar.map((a: any) => (
                    <div key={"p" + a.faixa} className="flex justify-between text-sm border-b py-1">
                      <span>{a.faixa} dias <span className="text-muted-foreground">({a.n})</span></span>
                      <span className="font-medium text-red-700">{fmt(a.valor)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Top devedores (vencidos)</CardTitle>
              </CardHeader>
              <CardContent>
                {topDevedores.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">Sem devedores em atraso.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cliente</TableHead>
                        <TableHead className="text-right">Em atraso</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topDevedores.map((d: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="max-w-[220px] truncate">{d.cliente}</TableCell>
                          <TableCell className="text-right font-medium text-red-700">{fmt(d.valor)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
