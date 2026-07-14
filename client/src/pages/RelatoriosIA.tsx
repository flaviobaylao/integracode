import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  Brain, TrendingUp, TrendingDown, Users, ShoppingCart, AlertTriangle,
  DollarSign, Search, RefreshCw, UserX, UserCheck, Trophy,
} from "lucide-react";

const STAGE_LABELS: Record<string, string> = {
  pedido: "Pedido",
  a_faturar: "A Faturar",
  faturado: "Faturado",
  impresso: "Impresso",
  aguardando_rota: "Aguardando Rota",
  em_rota: "Em Rota",
  em_rota_bsb: "Em Rota BSB",
  entregue: "Entregue",
};

function brl(v: number | null | undefined) {
  const n = Number(v) || 0;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}
function num(v: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR").format(Number(v) || 0);
}

interface DashResp {
  gerado_em: string;
  dias: number;
  resumo_carteira: { ativos: number; comprou: number; parou: number; nunca: number };
  kpis: {
    total_vendido_periodo: number; total_pedidos_periodo: number; ticket_medio_periodo: number;
    debitos_clientes: number; debitos_valor: number;
  };
  ranking_vendedores: Array<{
    vendedor: string; pedidos: number; valor_total: number; ticket_medio: number;
    ativos: number; comprou: number; parou: number; nunca: number;
  }>;
  pipeline_estagios: Array<{ stage: string; qtd: number; valor: number }>;
  vendas_por_dia: Array<{ dia: string; pedidos: number; valor: number }>;
  debitos_top: Array<{ client_name: string; total_amount: number; max_days_overdue: number }>;
}

interface SemPedidoResp {
  total: number;
  resumo: { comprou: number; parou: number; nunca_comprou: number };
  clientes: Array<{ id: string; name: string; vendedor: string; ultima_compra: string | null; status: string }>;
}

function KpiCard({ icon: Icon, label, value, sub, tone = "default" }: any) {
  const toneClass: Record<string, string> = {
    default: "text-foreground",
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    blue: "text-blue-600 dark:text-blue-400",
  };
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Icon className="w-4 h-4" /> {label}
        </div>
        <div className={`text-2xl font-bold ${toneClass[tone]}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  comprou: { label: "Comprou", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" },
  parou: { label: "Parou", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  nunca_comprou: { label: "Nunca comprou", cls: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
};

export default function RelatoriosIA() {
  const [dias, setDias] = useState("30");
  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("todos");

  const dash = useQuery<DashResp>({
    queryKey: ["/api/reports/ia-dashboard", dias],
    queryFn: async () => {
      const r = await fetch(`/api/reports/ia-dashboard?dias=${dias}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar dashboard");
      return r.json();
    },
  });

  const semPedido = useQuery<SemPedidoResp>({
    queryKey: ["/api/reports/clientes-sem-pedido", dias],
    queryFn: async () => {
      const r = await fetch(`/api/reports/clientes-sem-pedido?dias=${dias}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar lista");
      return r.json();
    },
  });

  const churn = useQuery<any>({
    queryKey: ["/api/admin/churn/radar"],
    queryFn: async () => {
      const r = await fetch(`/api/admin/churn/radar`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar churn");
      return r.json();
    },
  });

  const d = dash.data;
  const rc = d?.resumo_carteira;
  const k = d?.kpis;
  const crn = churn.data?.resumo;

  const clientesFiltrados = useMemo(() => {
    const all = semPedido.data?.clientes || [];
    const q = busca.trim().toLowerCase();
    return all.filter((c) => {
      if (filtroStatus !== "todos" && c.status !== filtroStatus) return false;
      if (!q) return true;
      return (c.name || "").toLowerCase().includes(q) || (c.vendedor || "").toLowerCase().includes(q);
    });
  }, [semPedido.data, busca, filtroStatus]);

  const chartData = (d?.vendas_por_dia || []).map((x) => ({
    dia: x.dia.slice(5),
    valor: Math.round(Number(x.valor) || 0),
    pedidos: Number(x.pedidos) || 0,
  }));

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" /> Relatórios IA
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitoramento de carteira e vendas — fonte: pipeline de faturamento (ao vivo).
            {d && <span> Janela: últimos {d.dias} dias.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={dias} onValueChange={setDias}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="15">Últimos 15 dias</SelectItem>
              <SelectItem value="30">Últimos 30 dias</SelectItem>
              <SelectItem value="60">Últimos 60 dias</SelectItem>
              <SelectItem value="90">Últimos 90 dias</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => { dash.refetch(); semPedido.refetch(); }}>
            <RefreshCw className={`w-4 h-4 ${dash.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <BackToDashboardButton />
        </div>
      </div>

      {dash.isError && (
        <Card><CardContent className="pt-6 text-red-600">Erro ao carregar o dashboard. Tente recarregar.</CardContent></Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard icon={Users} label="Clientes ativos" value={dash.isLoading ? "…" : num(rc?.ativos)} tone="blue" />
        <KpiCard icon={UserCheck} label="Compraram" value={dash.isLoading ? "…" : num(rc?.comprou)} tone="green"
          sub={rc?.ativos ? `${Math.round((rc.comprou / rc.ativos) * 100)}% da carteira` : undefined} />
        <KpiCard icon={TrendingDown} label="Pararam" value={dash.isLoading ? "…" : num(rc?.parou)} tone="amber"
          sub="prioridade de resgate" />
        <KpiCard icon={UserX} label="Nunca compraram" value={dash.isLoading ? "…" : num(rc?.nunca)} tone="red"
          sub="fila de ativação" />
        <KpiCard icon={DollarSign} label="Vendido no período" value={dash.isLoading ? "…" : brl(k?.total_vendido_periodo)} tone="green"
          sub={k ? `${num(k.total_pedidos_periodo)} pedidos · ticket ${brl(k.ticket_medio_periodo)}` : undefined} />
        <KpiCard icon={AlertTriangle} label="Débitos vencidos" value={dash.isLoading ? "…" : brl(k?.debitos_valor)} tone="red"
          sub={k ? `${num(k.debitos_clientes)} clientes` : undefined} />
        <KpiCard icon={AlertTriangle} label="Em risco (churn)" value={churn.isLoading ? "…" : num(crn?.em_risco)} tone="amber"
          sub={crn ? `perdido ${num(crn.perdido)}` : undefined} />
        <KpiCard icon={DollarSign} label="R$ em risco" value={churn.isLoading ? "…" : brl(crn?.valorEmRisco)} tone="red"
          sub="carteira em churn" />
      </div>

      {/* Gráfico vendas/dia + pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Vendas por dia</CardTitle></CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">Sem dados no período.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="dia" fontSize={11} />
                  <YAxis fontSize={11} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: any, n: any) => n === "valor" ? brl(v) : num(v)} />
                  <Bar dataKey="valor" fill="hsl(142 71% 45%)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Pipeline por estágio</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(d?.pipeline_estagios || []).map((s) => (
              <div key={s.stage} className="flex items-center justify-between text-sm border-b pb-1.5 last:border-0">
                <span>{STAGE_LABELS[s.stage] || s.stage}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{num(s.qtd)}</Badge>
                  <span className="text-muted-foreground text-xs w-24 text-right">{brl(s.valor)}</span>
                </span>
              </div>
            ))}
            {dash.isLoading && <div className="text-muted-foreground text-sm">Carregando…</div>}
          </CardContent>
        </Card>
      </div>

      {/* Ranking de vendedores */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Trophy className="w-4 h-4" /> Ranking de vendedores</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendedor</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Ticket médio</TableHead>
                <TableHead className="text-right">Ativos</TableHead>
                <TableHead className="text-right text-emerald-600">Comprou</TableHead>
                <TableHead className="text-right text-amber-600">Parou</TableHead>
                <TableHead className="text-right text-red-600">Nunca</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(d?.ranking_vendedores || []).map((r) => (
                <TableRow key={r.vendedor}>
                  <TableCell className="font-medium">{r.vendedor}</TableCell>
                  <TableCell className="text-right">{num(r.pedidos)}</TableCell>
                  <TableCell className="text-right">{brl(r.valor_total)}</TableCell>
                  <TableCell className="text-right">{brl(r.ticket_medio)}</TableCell>
                  <TableCell className="text-right">{num(r.ativos)}</TableCell>
                  <TableCell className="text-right text-emerald-600">{num(r.comprou)}</TableCell>
                  <TableCell className="text-right text-amber-600">{num(r.parou)}</TableCell>
                  <TableCell className="text-right text-red-600">{num(r.nunca)}</TableCell>
                </TableRow>
              ))}
              {!dash.isLoading && (d?.ranking_vendedores || []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">Sem dados.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Top devedores */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-600" /> Maiores débitos vencidos</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Dias em atraso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(d?.debitos_top || []).map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{r.client_name}</TableCell>
                  <TableCell className="text-right text-red-600">{brl(r.total_amount)}</TableCell>
                  <TableCell className="text-right">{num(r.max_days_overdue)}</TableCell>
                </TableRow>
              ))}
              {!dash.isLoading && (d?.debitos_top || []).length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-6">Sem débitos.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Lista nominal de clientes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" /> Clientes por situação</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Buscar cliente ou vendedor…" value={busca} onChange={(e) => setBusca(e.target.value)} />
            </div>
            <Select value={filtroStatus} onValueChange={setFiltroStatus}>
              <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="comprou">Comprou</SelectItem>
                <SelectItem value="parou">Parou</SelectItem>
                <SelectItem value="nunca_comprou">Nunca comprou</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground mb-2">{num(clientesFiltrados.length)} cliente(s)</div>
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Vendedor</TableHead>
                  <TableHead>Última compra</TableHead>
                  <TableHead>Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clientesFiltrados.slice(0, 500).map((c) => {
                  const b = STATUS_BADGE[c.status] || { label: c.status, cls: "" };
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>{c.vendedor}</TableCell>
                      <TableCell>{c.ultima_compra || "—"}</TableCell>
                      <TableCell><Badge className={b.cls}>{b.label}</Badge></TableCell>
                    </TableRow>
                  );
                })}
                {semPedido.isLoading && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">Carregando…</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {clientesFiltrados.length > 500 && (
            <div className="text-xs text-muted-foreground mt-2">Exibindo os primeiros 500 de {num(clientesFiltrados.length)}.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
