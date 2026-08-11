import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Briefcase, Users, TrendingUp, Wallet, Download } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";

// ── Paleta validada (scripts/validate_palette.js — light, surface #ffffff) ──────
// ABC e ordinal: rampa de UM tom (azul), claro -> escuro.
const COR_ABC: Record<string, string> = { A: "#184f95", B: "#3987e5", C: "#86b6ef" };
// PJ/PF e categorico: slots 1 e 2 da ordem fixa; cinza para "nao identificado".
const COR_TIPO: Record<string, string> = { PJ: "#2a78d6", PF: "#eb6834", "Não identificado": "#898781" };
const CAT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];
const CINZA = "#898781";
const SERIE_TITULOS = "#2a78d6";
const SERIE_NF = "#eb6834";

const BRL = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const BRL0 = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const NUM = (v: any) => Number(v || 0).toLocaleString("pt-BR");
const MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (m: string) => {
  const [a, b] = String(m || "").split("-");
  return b ? `${MES_ABREV[Number(b) - 1]}/${a.slice(2)}` : m;
};

type Cliente = {
  chave: string; doc: string | null; nome: string; tipo: string; vendedor: string; cidade: string;
  segmento: string; cadastrado: boolean; ativo: boolean; total: number; titulos: number;
  mesesComCompra: number; primeiraCompra: string | null; ultimaCompra: string | null;
  mediaSimples: number; mediaPonderada: number; classe: "A" | "B" | "C";
};

function KpiCard(props: { icon: any; titulo: string; valor: string; nota?: string; cor?: string }) {
  const Icon = props.icon;
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Icon className="h-4 w-4" />{props.titulo}
        </div>
        <p className={`text-2xl font-bold ${props.cor || ""}`}>{props.valor}</p>
        {props.nota ? <p className="text-xs text-muted-foreground">{props.nota}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Rótulo dentro da fatia: só nas fatias com folga (>=6%), para não colidir. */
const rotuloFatia = (p: any) => (p.percent >= 0.06 ? `${(p.percent * 100).toFixed(0)}%` : "");

export default function GestaoCarteiras() {
  const hoje = new Date();
  const mesHoje = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const [inicio, setInicio] = useState("2025-01");
  const [fim, setFim] = useState(mesHoje);
  const [vendedor, setVendedor] = useState("__todos__");
  const [tipoPizza, setTipoPizza] = useState<"abc" | "segmento">("abc");
  const [ordem, setOrdem] = useState<"total" | "ponderada">("total");

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/reports/gestao-carteiras", inicio, fim],
    queryFn: async () => {
      const r = await fetch(`/api/reports/gestao-carteiras?inicio=${inicio}&fim=${fim}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar o dashboard de carteiras");
      return r.json();
    },
  });

  const d = data || {};
  const meses: string[] = d?.periodo?.meses || [];
  const todos: Cliente[] = d?.clientes || [];
  const filtrarVend = vendedor !== "__todos__";
  const clientes = useMemo(
    () => (filtrarVend ? todos.filter((c) => c.vendedor === vendedor) : todos),
    [todos, vendedor, filtrarVend],
  );

  // Com filtro de vendedor a curva ABC é recalculada só na carteira dele.
  const abc = useMemo(() => {
    if (!filtrarVend) return d?.abc || [];
    const tot = clientes.reduce((s, c) => s + c.total, 0);
    const acc: Record<string, { clientes: number; valor: number }> = { A: { clientes: 0, valor: 0 }, B: { clientes: 0, valor: 0 }, C: { clientes: 0, valor: 0 } };
    let soma = 0;
    for (const c of [...clientes].sort((a, b) => b.total - a.total)) {
      soma += c.total;
      const pct = tot > 0 ? soma / tot : 0;
      const k = pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C";
      acc[k].clientes++; acc[k].valor += c.total;
    }
    return (["A", "B", "C"] as const).map((k) => ({ classe: k, ...acc[k], pctValor: tot > 0 ? (acc[k].valor / tot) * 100 : 0 }));
  }, [d, clientes, filtrarVend]);

  const classeDe = useMemo(() => {
    if (!filtrarVend) return new Map(todos.map((c) => [c.chave, c.classe]));
    const tot = clientes.reduce((s, c) => s + c.total, 0);
    const m = new Map<string, "A" | "B" | "C">();
    let soma = 0;
    for (const c of [...clientes].sort((a, b) => b.total - a.total)) {
      soma += c.total;
      const pct = tot > 0 ? soma / tot : 0;
      m.set(c.chave, pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C");
    }
    return m;
  }, [todos, clientes, filtrarVend]);

  const tipos = useMemo(() => {
    if (!filtrarVend) return d?.tipos || [];
    const m = new Map<string, { clientes: number; valor: number }>();
    for (const c of clientes) {
      const a = m.get(c.tipo) || { clientes: 0, valor: 0 };
      a.clientes++; a.valor += c.total; m.set(c.tipo, a);
    }
    return Array.from(m.entries()).map(([tipo, a]) => ({ tipo, ...a })).sort((a, b) => b.clientes - a.clientes);
  }, [d, clientes, filtrarVend]);

  const segmentos = useMemo(() => {
    const m = new Map<string, { clientes: number; valor: number }>();
    for (const c of clientes) {
      const a = m.get(c.segmento) || { clientes: 0, valor: 0 };
      a.clientes++; a.valor += c.total; m.set(c.segmento, a);
    }
    const arr = Array.from(m.entries()).map(([segmento, a]) => ({ segmento, ...a })).sort((a, b) => b.valor - a.valor);
    if (arr.length <= 7) return arr;
    const top = arr.slice(0, 6);
    const resto = arr.slice(6).reduce((s, x) => ({ clientes: s.clientes + x.clientes, valor: s.valor + x.valor }), { clientes: 0, valor: 0 });
    return [...top, { segmento: `Demais (${arr.length - 6})`, ...resto }];
  }, [clientes]);

  // A série do gráfico segue o período; com filtro de vendedor ela é recomposta
  // a partir dos clientes daquela carteira (por isso o back manda porMes).
  const serie = useMemo(() => {
    const base: any[] = d?.serie || [];
    if (!filtrarVend) return base;
    const soma = new Map<string, number>();
    for (const c of clientes as any[]) {
      for (const [m, v] of Object.entries(c.porMes || {})) soma.set(m, (soma.get(m) || 0) + (Number(v) || 0));
    }
    return meses.map((m) => ({ mes: m, valor: soma.get(m) || 0, titulos: 0, clientes: 0, valorNf: null }));
  }, [d, clientes, meses, filtrarVend]);

  const kpis = useMemo(() => {
    if (!filtrarVend) return d?.kpis || {};
    const tot = clientes.reduce((s, c) => s + c.total, 0);
    const ult = serie[serie.length - 1];
    const pen = serie.length > 1 ? serie[serie.length - 2] : null;
    return {
      faturamento: tot,
      clientes: clientes.length,
      mediaMensal: meses.length ? tot / meses.length : 0,
      ticketMedioCliente: clientes.length ? tot / clientes.length : 0,
      mesAtual: ult?.valor || 0,
      mesAtualLabel: ult?.mes || null,
      mesAnterior: pen?.valor || 0,
      varPct: pen && pen.valor > 0 && ult ? ((ult.valor - pen.valor) / pen.valor) * 100 : null,
    };
  }, [d, clientes, serie, meses, filtrarVend]);

  const top20 = useMemo(() => {
    const arr = [...clientes];
    arr.sort((a, b) => (ordem === "total" ? b.total - a.total : b.mediaPonderada - a.mediaPonderada));
    return arr.slice(0, 20);
  }, [clientes, ordem]);

  const opcoesMes = useMemo(() => {
    const out: string[] = [];
    let y = 2025, m = 1;
    while (`${y}-${String(m).padStart(2, "0")}` <= mesHoje) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }, [mesHoje]);

  const exportar = () => {
    exportToExcel(
      [...clientes]
        .sort((a, b) => (ordem === "total" ? b.total - a.total : b.mediaPonderada - a.mediaPonderada))
        .map((c, i) => ({
          "#": i + 1, Cliente: c.nome, "CPF/CNPJ": c.doc || "", Tipo: c.tipo, Classe: classeDe.get(c.chave) || c.classe,
          Vendedor: c.vendedor, Cidade: c.cidade, Segmento: c.segmento,
          "Faturamento no período": Number(c.total.toFixed(2)),
          "Média ponderada/mês": Number(c.mediaPonderada.toFixed(2)),
          "Média simples/mês": Number(c.mediaSimples.toFixed(2)),
          "Meses com compra": c.mesesComCompra, "Última compra": c.ultimaCompra || "",
        })),
      `gestao-carteiras_${inicio}_a_${fim}`,
    );
  };

  const varPct = kpis?.varPct;

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />

      <div className="flex items-center gap-3">
        <Briefcase className="h-8 w-8 text-blue-600" />
        <div>
          <h1 className="text-3xl font-bold">Gestão de Carteiras — Vendas</h1>
          <p className="text-muted-foreground">
            Curva ABC, perfil de clientes e evolução do faturamento de {labelMes(inicio)} a {labelMes(fim)}
          </p>
        </div>
      </div>

      {/* Filtros — uma linha acima dos gráficos */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">De</label>
            <Select value={inicio} onValueChange={setInicio}>
              <SelectTrigger className="w-[130px]" data-testid="select-inicio"><SelectValue /></SelectTrigger>
              <SelectContent>{opcoesMes.map((m) => <SelectItem key={m} value={m}>{labelMes(m)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Até</label>
            <Select value={fim} onValueChange={setFim}>
              <SelectTrigger className="w-[130px]" data-testid="select-fim"><SelectValue /></SelectTrigger>
              <SelectContent>{opcoesMes.map((m) => <SelectItem key={m} value={m}>{labelMes(m)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Vendedor</label>
            <Select value={vendedor} onValueChange={setVendedor}>
              <SelectTrigger className="w-[220px]" data-testid="select-vendedor"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__todos__">Todos os vendedores</SelectItem>
                {(d?.vendedores || []).map((v: any) => (
                  <SelectItem key={v.vendedor} value={v.vendedor}>{v.vendedor} ({v.clientes})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto">
            <Button variant="outline" onClick={exportar} data-testid="button-export">
              <Download className="h-4 w-4 mr-2" />Exportar Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Carregando dados da carteira…</div>
      ) : error ? (
        <div className="text-center text-red-600 py-16">Não foi possível carregar o dashboard.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard icon={Wallet} titulo="Faturamento no período" valor={BRL0(kpis?.faturamento)}
              nota={`${meses.length} meses · média ${BRL0(kpis?.mediaMensal)}/mês`} cor="text-emerald-600" />
            <KpiCard icon={Users} titulo="Clientes que compraram" valor={NUM(kpis?.clientes)}
              nota={`ticket médio ${BRL0(kpis?.ticketMedioCliente)} no período`} />
            <KpiCard icon={TrendingUp} titulo={`Faturamento ${labelMes(kpis?.mesAtualLabel || fim)}`} valor={BRL0(kpis?.mesAtual)}
              nota={`${(kpis?.mesAtualLabel || fim) === mesHoje ? "mês em curso · " : ""}${varPct === null || varPct === undefined ? "sem base de comparação" : `${varPct >= 0 ? "+" : ""}${varPct.toFixed(1)}% vs mês anterior`}`}
              cor={varPct === null || varPct === undefined ? "" : varPct >= 0 ? "text-emerald-600" : "text-red-600"} />
            <KpiCard icon={Briefcase} titulo="Clientes classe A" valor={NUM(abc?.[0]?.clientes || 0)}
              nota={`concentram ${(abc?.[0]?.pctValor || 0).toFixed(0)}% do faturamento`} cor="text-blue-700" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pizza 1 — segmentos da carteira */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>Segmentos da carteira</CardTitle>
                    <CardDescription>
                      {tipoPizza === "abc"
                        ? "Curva ABC — A = clientes que somam 80% do faturamento, B = até 95%, C = o restante"
                        : "Segmento de negócio informado no cadastro do cliente"}
                    </CardDescription>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant={tipoPizza === "abc" ? "default" : "outline"} onClick={() => setTipoPizza("abc")} data-testid="button-abc">Curva ABC</Button>
                    <Button size="sm" variant={tipoPizza === "segmento" ? "default" : "outline"} onClick={() => setTipoPizza("segmento")} data-testid="button-segmento">Negócio</Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={(tipoPizza === "abc"
                        ? abc.map((a: any) => ({ nome: `Classe ${a.classe}`, valor: a.valor, clientes: a.clientes, cor: COR_ABC[a.classe] }))
                        : segmentos.map((s: any, i: number) => ({ nome: s.segmento, valor: s.valor, clientes: s.clientes, cor: /^Demais|^Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length] })))}
                      dataKey="valor" nameKey="nome" cx="50%" cy="50%" outerRadius={95}
                      stroke="#ffffff" strokeWidth={2} label={rotuloFatia} labelLine={false}
                    >
                      {(tipoPizza === "abc"
                        ? abc.map((a: any) => COR_ABC[a.classe])
                        : segmentos.map((s: any, i: number) => (/^Demais|^Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length]))
                      ).map((cor: string, i: number) => <Cell key={i} fill={cor} />)}
                    </Pie>
                    <Tooltip formatter={(v: any, n: any, p: any) => [`${BRL(v)} · ${NUM(p?.payload?.clientes)} clientes`, p?.payload?.nome]} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-2 border-t pt-2 text-sm">
                  {(tipoPizza === "abc"
                    ? abc.map((a: any) => ({ nome: `Classe ${a.classe}`, valor: a.valor, clientes: a.clientes, cor: COR_ABC[a.classe] }))
                    : segmentos.map((s: any, i: number) => ({ nome: s.segmento, valor: s.valor, clientes: s.clientes, cor: /^Demais|^Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length] }))
                  ).map((x: any) => (
                    <div key={x.nome} className="flex items-center justify-between py-0.5">
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: x.cor }} />
                        {x.nome} <span className="text-muted-foreground">({NUM(x.clientes)} clientes)</span>
                      </span>
                      <span className="font-medium">{BRL0(x.valor)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Pizza 2 — PJ x PF */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Tipo de cliente — PJ x PF</CardTitle>
                <CardDescription>Classificado pelo CPF/CNPJ do título; sem documento, pelo tipo do cadastro</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={tipos.map((t: any) => ({ nome: t.tipo, valor: t.clientes, faturamento: t.valor }))}
                      dataKey="valor" nameKey="nome" cx="50%" cy="50%" outerRadius={95}
                      stroke="#ffffff" strokeWidth={2} label={rotuloFatia} labelLine={false}
                    >
                      {tipos.map((t: any, i: number) => <Cell key={i} fill={COR_TIPO[t.tipo] || CINZA} />)}
                    </Pie>
                    <Tooltip formatter={(v: any, n: any, p: any) => [`${NUM(v)} clientes · ${BRL(p?.payload?.faturamento)}`, p?.payload?.nome]} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-2 border-t pt-2 text-sm">
                  {tipos.map((t: any) => (
                    <div key={t.tipo} className="flex items-center justify-between py-0.5">
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COR_TIPO[t.tipo] || CINZA }} />
                        {t.tipo} <span className="text-muted-foreground">({NUM(t.clientes)} clientes)</span>
                      </span>
                      <span className="font-medium">{BRL0(t.valor)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Linha — evolução mensal */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Evolução do faturamento</CardTitle>
              <CardDescription>
                Base: títulos emitidos em Contas a Receber (exclui cancelados)
                {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? " · linha laranja tracejada = NF-e de venda autorizada (regra oficial)" : ""}
                {fim === mesHoje ? " · o último mês ainda está em curso" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={serie} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ececea" vertical={false} />
                  <XAxis dataKey="mes" tickFormatter={labelMes} tick={{ fontSize: 12, fill: "#898781" }} tickLine={false} axisLine={{ stroke: "#ececea" }} />
                  <YAxis tickFormatter={(v: any) => (Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : String(v))}
                    tick={{ fontSize: 12, fill: "#898781" }} tickLine={false} axisLine={false} width={52} />
                  <Tooltip formatter={(v: any, n: any) => [BRL(v), n]} labelFormatter={(l: any) => labelMes(String(l))} />
                  <Legend />
                  <Line type="monotone" dataKey="valor" name="Faturamento (títulos emitidos)" stroke={SERIE_TITULOS} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                  {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? (
                    <Line type="monotone" dataKey="valorNf" name="NF-e de venda autorizada" stroke={SERIE_NF} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Tabela — top 20 */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle>Top 20 clientes</CardTitle>
                  <CardDescription>
                    Média ponderada dá mais peso aos meses recentes (o mês mais antigo do período pesa 1; o mais recente, {meses.length})
                  </CardDescription>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant={ordem === "total" ? "default" : "outline"} onClick={() => setOrdem("total")} data-testid="button-ordem-total">Por faturamento total</Button>
                  <Button size="sm" variant={ordem === "ponderada" ? "default" : "outline"} onClick={() => setOrdem("ponderada")} data-testid="button-ordem-ponderada">Por média ponderada</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="w-16">Tipo</TableHead>
                    <TableHead className="w-16">Classe</TableHead>
                    <TableHead>Vendedor</TableHead>
                    <TableHead className="text-right">Faturamento no período</TableHead>
                    <TableHead className="text-right">Média ponderada/mês</TableHead>
                    <TableHead className="text-right">Média simples/mês</TableHead>
                    <TableHead className="text-right w-24">Meses c/ compra</TableHead>
                    <TableHead className="w-24">Última compra</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {top20.map((c, i) => {
                    const cl = classeDe.get(c.chave) || c.classe;
                    return (
                      <TableRow key={c.chave} data-testid={`row-cliente-${i}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-medium">
                          {c.nome}
                          {c.cidade ? <span className="block text-xs text-muted-foreground">{c.cidade}</span> : null}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: `${COR_TIPO[c.tipo] || CINZA}1a`, color: COR_TIPO[c.tipo] || CINZA }}>{c.tipo === "Não identificado" ? "—" : c.tipo}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs font-semibold px-1.5 py-0.5 rounded text-white" style={{ background: COR_ABC[cl] }}>{cl}</span>
                        </TableCell>
                        <TableCell className="text-sm">{c.vendedor}</TableCell>
                        <TableCell className="text-right font-semibold">{BRL(c.total)}</TableCell>
                        <TableCell className="text-right">{BRL(c.mediaPonderada)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{BRL(c.mediaSimples)}</TableCell>
                        <TableCell className="text-right">{c.mesesComCompra}/{meses.length}</TableCell>
                        <TableCell className="text-sm">{labelMes(c.ultimaCompra || "")}</TableCell>
                      </TableRow>
                    );
                  })}
                  {top20.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-6">Nenhum cliente com faturamento no período.</TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3">
                {NUM(clientes.length)} clientes com faturamento no período{filtrarVend ? ` na carteira de ${vendedor}` : ""}.
                {d?.clientesTruncado ? " Lista limitada aos 2.000 maiores." : ""}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
