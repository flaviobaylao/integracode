import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from "recharts";
import { TrendingUp, Target, CalendarDays, Users } from "lucide-react";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const FMT_BRL = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function RelatoriosGraficos() {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/reports/positivacao-mes"],
    queryFn: async () => {
      const r = await fetch("/api/reports/positivacao-mes", { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar o relatório");
      return r.json();
    },
  });

  const d = data || {};
  const serie = d.serie || [];
  const mesLabel = d.mes ? `${MESES[d.mes - 1]} de ${d.ano}` : "";
  const faltaPositivar = Math.max(0, (d.projetadoPositivados || 0) - (d.positivados || 0));

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />
      <div className="flex items-center gap-3">
        <TrendingUp className="h-8 w-8 text-blue-600" />
        <div>
          <h1 className="text-3xl font-bold">Relatórios Gráficos — Vendas</h1>
          <p className="text-muted-foreground">Positivação de clientes {mesLabel}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Carregando…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><Users className="h-4 w-4" />Positivados no mês</div>
              <p className="text-2xl font-bold text-emerald-600">{d.percentual ?? 0}%</p>
              <p className="text-xs text-muted-foreground">{d.positivados ?? 0} de {d.totalAtivos ?? 0} clientes</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><Target className="h-4 w-4" />Projeção fim do mês</div>
              <p className="text-2xl font-bold text-blue-600">{d.projetadoPercentual ?? 0}%</p>
              <p className="text-xs text-muted-foreground">~{d.projetadoPositivados ?? 0} clientes (estimado)</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><CalendarDays className="h-4 w-4" />Dias úteis</div>
              <p className="text-2xl font-bold">{d.diasUteisDecorridos ?? 0}/{d.diasUteisTotal ?? 0}</p>
              <p className="text-xs text-muted-foreground">{d.diasUteisRestantes ?? 0} restantes</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><TrendingUp className="h-4 w-4" />Falta positivar</div>
              <p className="text-2xl font-bold text-amber-600">{faltaPositivar}</p>
              <p className="text-xs text-muted-foreground">até a projeção</p>
            </CardContent></Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Positivação acumulada — % dos clientes ativos ({mesLabel})</CardTitle>
              <CardDescription>Linha cheia (verde) = realizado até hoje. Linha tracejada (azul) = projeção pelos dias úteis restantes.</CardDescription>
            </CardHeader>
            <CardContent>
              <div style={{ width: "100%", height: 380 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={serie} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="dia" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis unit="%" domain={[0, "auto"]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => (v == null ? "-" : v + "%")} />
                    <Legend />
                    <ReferenceLine y={d.projetadoPercentual} stroke="#3b82f6" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="real" name="Realizado" stroke="#10b981" strokeWidth={2} dot={false} connectNulls />
                    <Line type="monotone" dataKey="projecao" name="Projeção" stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Positivado = cliente que comprou no mês (venda no 2.0 ou fatura no 1.0). Projeção linear pela cadência de positivação sobre os dias úteis do mês (feriados não considerados).
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Positivação por vendedor (%)</CardTitle>
                <CardDescription>% da carteira ativa positivada no mês, por vendedor.</CardDescription>
              </CardHeader>
              <CardContent>
                <div style={{ width: "100%", height: Math.max(280, (d.porVendedor?.length || 0) * 28 + 40) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={[...(d.porVendedor || [])].sort((a: any, b: any) => b.percentual - a.percentual)} layout="vertical" margin={{ top: 5, right: 40, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" unit="%" tick={{ fontSize: 11 }} domain={[0, 100]} />
                      <YAxis type="category" dataKey="vendedor" width={130} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: any, _n: any, p: any) => [v + "%  (" + (p?.payload?.positivados ?? 0) + "/" + (p?.payload?.total ?? 0) + ")", "Positivação"]} />
                      <Bar dataKey="percentual" name="Positivação %" radius={[0, 4, 4, 0]}>
                        {(d.porVendedor || []).map((_: any, i: number) => (<Cell key={i} fill="#10b981" />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Faturamento do mês por vendedor</CardTitle>
                <CardDescription>Soma das vendas do mês (billing_pipeline), por vendedor da carteira.</CardDescription>
              </CardHeader>
              <CardContent>
                <div style={{ width: "100%", height: Math.max(280, (d.porVendedor?.length || 0) * 28 + 40) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={[...(d.porVendedor || [])].sort((a: any, b: any) => b.faturamento - a.faturamento)} layout="vertical" margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: any) => "R$ " + (Number(v) / 1000).toFixed(0) + "k"} />
                      <YAxis type="category" dataKey="vendedor" width={130} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={FMT_BRL} />
                      <Bar dataKey="faturamento" name="Faturamento" radius={[0, 4, 4, 0]}>
                        {(d.porVendedor || []).map((_: any, i: number) => (<Cell key={i} fill="#3b82f6" />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Comparativo por vendedor — tabela</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground border-b">
                    <tr><th className="py-2 pr-4">Vendedor</th><th className="py-2 pr-4 text-right">Carteira</th><th className="py-2 pr-4 text-right">Positivados</th><th className="py-2 pr-4 text-right">Positivação</th><th className="py-2 pr-4 text-right">Faturamento mês</th></tr>
                  </thead>
                  <tbody>
                    {[...(d.porVendedor || [])].sort((a: any, b: any) => b.faturamento - a.faturamento).map((v: any, i: number) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-1.5 pr-4 font-medium">{v.vendedor}</td>
                        <td className="py-1.5 pr-4 text-right">{v.total}</td>
                        <td className="py-1.5 pr-4 text-right">{v.positivados}</td>
                        <td className="py-1.5 pr-4 text-right font-medium text-emerald-600">{v.percentual}%</td>
                        <td className="py-1.5 pr-4 text-right">{FMT_BRL(v.faturamento)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
