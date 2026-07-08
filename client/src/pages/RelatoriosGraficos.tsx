import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from "recharts";
import { TrendingUp, Target, CalendarDays, Users } from "lucide-react";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

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
        </>
      )}
    </div>
  );
}
