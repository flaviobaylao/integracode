import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Briefcase, Users, TrendingUp, Wallet, Download, Info, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const [classeSel, setClasseSel] = useState<"todas" | "A" | "B" | "C">("todas");
  const [busca, setBusca] = useState("");
  const [visiveis, setVisiveis] = useState(50);

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/reports/gestao-carteiras", inicio, fim],
    queryFn: async () => {
      const r = await fetch(`/api/reports/gestao-carteiras?inicio=${inicio}&fim=${fim}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar o dashboard de carteiras");
      return r.json();
    },
  });

  // Vendedores ATIVOS -- mesma fonte usada em "Vendedores" e no filtro de
  // "Clientes Ativos". O dropdown de vendedor lista somente quem esta ativo.
  const { data: vendedoresAtivos = [] } = useQuery<Array<{ id: string; name: string; allIds?: string[] }>>({
    queryKey: ["/api/sellers/active"],
    staleTime: 30000,
  });

  const d = data || {};
  const meses: string[] = d?.periodo?.meses || [];
  const todos: Cliente[] = d?.clientes || [];

  // Normaliza o nome do vendedor igual a dedup do endpoint /api/sellers/active.
  const normVend = (s: any) => String(s || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const nomesAtivos = useMemo(
    () => new Set((vendedoresAtivos || []).map((s: any) => normVend(s.name))),
    [vendedoresAtivos],
  );
  // Opcoes do dropdown: so vendedores ativos. Se a lista de ativos ainda nao
  // carregou (ou vier vazia), cai para todos -- evita esvaziar o filtro.
  const vendedoresDropdown = useMemo(() => {
    const lista: any[] = d?.vendedores || [];
    return nomesAtivos.size ? lista.filter((v: any) => nomesAtivos.has(normVend(v.vendedor))) : lista;
  }, [d, nomesAtivos]);

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

  // Contagem por classe dentro do recorte atual (vendedor), para os chips.
  const porClasse = useMemo(() => {
    const acc: Record<string, { clientes: number; valor: number }> = { A: { clientes: 0, valor: 0 }, B: { clientes: 0, valor: 0 }, C: { clientes: 0, valor: 0 } };
    for (const c of clientes) {
      const k = classeDe.get(c.chave) || c.classe;
      if (!acc[k]) continue;
      acc[k].clientes++; acc[k].valor += c.total;
    }
    return acc;
  }, [clientes, classeDe]);

  // Relação completa: filtra por classe e por busca, e ordena pelo critério escolhido.
  const listaFiltrada = useMemo(() => {
    const alvo = busca.trim().toLocaleLowerCase("pt-BR");
    // So-digitos da busca. Sem esse guarda, procurar por texto casaria com TODO
    // mundo: "moreira".replace(/\D/g,"") vira "" e includes("") e sempre true.
    const alvoDoc = alvo.replace(/\D/g, "");
    const arr = clientes.filter((c) => {
      if (classeSel !== "todas" && (classeDe.get(c.chave) || c.classe) !== classeSel) return false;
      if (!alvo) return true;
      return (
        c.nome.toLocaleLowerCase("pt-BR").includes(alvo) ||
        (c.cidade || "").toLocaleLowerCase("pt-BR").includes(alvo) ||
        (c.vendedor || "").toLocaleLowerCase("pt-BR").includes(alvo) ||
        (alvoDoc.length >= 3 && (c.doc || "").includes(alvoDoc))
      );
    });
    arr.sort((a, b) => (ordem === "total" ? b.total - a.total : b.mediaPonderada - a.mediaPonderada));
    return arr;
  }, [clientes, classeDe, classeSel, busca, ordem]);

  // Mexeu no filtro, volta para o começo da lista.
  useEffect(() => { setVisiveis(50); }, [classeSel, busca, ordem, vendedor, inicio, fim]);

  const listaVisivel = useMemo(() => listaFiltrada.slice(0, visiveis), [listaFiltrada, visiveis]);
  const totalFiltrado = useMemo(() => listaFiltrada.reduce((s, c) => s + c.total, 0), [listaFiltrada]);

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
      listaFiltrada
        .map((c, i) => ({
          "#": i + 1, Cliente: c.nome, "CPF/CNPJ": c.doc || "", Tipo: c.tipo, Classe: classeDe.get(c.chave) || c.classe,
          Vendedor: c.vendedor, Cidade: c.cidade, Segmento: c.segmento,
          "Faturamento no período": Number(c.total.toFixed(2)),
          "Média ponderada/mês": Number(c.mediaPonderada.toFixed(2)),
          "Média simples/mês": Number(c.mediaSimples.toFixed(2)),
          "Meses com compra": c.mesesComCompra, "Última compra": c.ultimaCompra || "",
        })),
      `gestao-carteiras_${inicio}_a_${fim}${classeSel !== "todas" ? `_classe-${classeSel}` : ""}`,
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
                {vendedoresDropdown.map((v: any) => (
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
                <ResponsiveContainer width="100%" height={290}>
                  <PieChart>
                    <Pie
                      data={(tipoPizza === "abc"
                        ? abc.map((a: any) => ({ nome: `Classe ${a.classe}`, valor: a.valor, clientes: a.clientes, cor: COR_ABC[a.classe] }))
                        : segmentos.map((s: any, i: number) => ({ nome: s.segmento, valor: s.valor, clientes: s.clientes, cor: /^Demais|Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length] })))}
                      dataKey="valor" nameKey="nome" cx="50%" cy="50%" outerRadius={88}
                      stroke="#ffffff" strokeWidth={2} label={rotuloFatia} labelLine={false} isAnimationActive={false}
                    >
                      {(tipoPizza === "abc"
                        ? abc.map((a: any) => COR_ABC[a.classe])
                        : segmentos.map((s: any, i: number) => (/^Demais|Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length]))
                      ).map((cor: string, i: number) => <Cell key={i} fill={cor} />)}
                    </Pie>
                    <Tooltip formatter={(v: any, n: any, p: any) => [`${BRL(v)} · ${NUM(p?.payload?.clientes)} clientes`, p?.payload?.nome]} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-2 border-t pt-2 text-sm">
                  {(tipoPizza === "abc"
                    ? abc.map((a: any) => ({ nome: `Classe ${a.classe}`, valor: a.valor, clientes: a.clientes, cor: COR_ABC[a.classe] }))
                    : segmentos.map((s: any, i: number) => ({ nome: s.segmento, valor: s.valor, clientes: s.clientes, cor: /^Demais|Sem segmento/.test(s.segmento) ? CINZA : CAT[i % CAT.length] }))
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
                <ResponsiveContainer width="100%" height={290}>
                  <PieChart>
                    <Pie
                      data={tipos.map((t: any) => ({ nome: t.tipo, valor: t.clientes, faturamento: t.valor }))}
                      dataKey="valor" nameKey="nome" cx="50%" cy="50%" outerRadius={88}
                      stroke="#ffffff" strokeWidth={2} label={rotuloFatia} labelLine={false} isAnimationActive={false}
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
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>Evolução do faturamento</CardTitle>
                  <CardDescription>
                    Base: títulos de venda emitidos em Contas a Receber
                    {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? " · linha laranja tracejada = NF-e de venda autorizada (regra oficial)" : ""}
                    {fim === mesHoje ? " · o último mês ainda está em curso" : ""}
                  </CardDescription>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="O que entra em cada linha" data-testid="button-info-faturamento">
                      <Info className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[420px] max-w-[92vw] text-sm space-y-3">
                    <div>
                      <p className="font-semibold flex items-center gap-2">
                        <span className="inline-block h-0.5 w-5 rounded" style={{ background: SERIE_TITULOS }} />
                        Faturamento (títulos emitidos)
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Soma dos títulos de <b>venda</b> lançados em Contas a Receber, pela data de emissão. É a base de tudo
                        nesta tela — os gráficos de pizza e a tabela saem dela.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold">Nunca entram no faturamento</p>
                      <ul className="text-muted-foreground mt-1 list-disc pl-4 space-y-0.5">
                        <li>título cancelado ou excluído</li>
                        <li>NF-e cancelada, rejeitada ou de entrada</li>
                        <li>devolução, troca, amostra, bonificação, brinde e remessa</li>
                        <li>empresas do grupo e parceiros que não são cliente (PURO, BARUC)</li>
                        <li>aporte de sócio, empréstimo e adiantamento</li>
                        <li>pedido mandado para a lixeira do pipeline</li>
                      </ul>
                    </div>
                    <div>
                      <p className="font-semibold flex items-center gap-2">
                        <span className="inline-block h-0.5 w-5 rounded" style={{ background: SERIE_NF, backgroundImage: `repeating-linear-gradient(90deg, ${SERIE_NF} 0 4px, transparent 4px 7px)` }} />
                        NF-e de venda autorizada
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Linha de conferência: NF-e autorizada em produção com CFOP de venda, uma linha por CNPJ + série + número
                        (mata nota lançada em duplicidade). É a mesma regra oficial do dashboard. Só aparece a partir de mar/26 —
                        a base de notas não cobre 2025, e por isso o faturamento da tela sai dos títulos, não das notas.
                      </p>
                    </div>
                    {!filtrarVend && d?.excluidos?.valor > 0 ? (
                      <div className="border-t pt-2">
                        <p className="font-semibold">Fora da carteira no período</p>
                        <ul className="text-muted-foreground mt-1 space-y-0.5">
                          {(d.excluidos.detalhe || []).map((x: any, i: number) => (
                            <li key={i}>{BRL0(x.valor)} — {x.motivo}</li>
                          ))}
                          {d?.excluidos?.cancelados?.titulos > 0 ? (
                            <li>{BRL0(d.excluidos.cancelados.valor)} — títulos cancelados</li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>
              </div>
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
                  <Line type="linear" dataKey="valor" name="Faturamento (títulos emitidos)" stroke={SERIE_TITULOS} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                  {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? (
                    <Line type="linear" dataKey="valorNf" name="NF-e de venda autorizada" stroke={SERIE_NF} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
              {!filtrarVend && d?.excluidos?.valor > 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Fora da carteira: {BRL0(d.excluidos.valor)} em {NUM(d.excluidos.titulos)} títulos que não são venda
                  (NF-e cancelada, devolução, troca, amostra, bonificação, transferência entre as empresas do grupo, aporte de sócio).
                  Detalhe no <b>i</b> acima.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Tabela — top 20 */}
          <Card>
            <CardHeader className="pb-2 space-y-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle>Clientes da carteira</CardTitle>
                  <CardDescription>
                    Relação completa do período. Média ponderada dá mais peso aos meses recentes
                    (o mês mais antigo do período pesa 1; o mais recente, {meses.length}).
                  </CardDescription>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant={ordem === "total" ? "default" : "outline"} onClick={() => setOrdem("total")} data-testid="button-ordem-total">Por faturamento total</Button>
                  <Button size="sm" variant={ordem === "ponderada" ? "default" : "outline"} onClick={() => setOrdem("ponderada")} data-testid="button-ordem-ponderada">Por média ponderada</Button>
                </div>
              </div>

              {/* Filtro por classe da curva ABC + busca */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setClasseSel("todas")}
                  data-testid="chip-classe-todas"
                  className={`px-3 py-1.5 rounded-md border text-sm transition ${classeSel === "todas" ? "border-foreground/40 bg-muted font-semibold" : "border-transparent bg-muted/40 hover:bg-muted"}`}
                >
                  Todas as classes <span className="text-muted-foreground">({NUM(clientes.length)})</span>
                </button>
                {(["A", "B", "C"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setClasseSel(classeSel === k ? "todas" : k)}
                    data-testid={`chip-classe-${k}`}
                    className={`px-3 py-1.5 rounded-md border text-sm transition flex items-center gap-2 ${classeSel === k ? "border-foreground/40 bg-muted font-semibold" : "border-transparent bg-muted/40 hover:bg-muted"}`}
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: COR_ABC[k] }}>{k}</span>
                    Classe {k}
                    <span className="text-muted-foreground">
                      {NUM(porClasse[k]?.clientes || 0)} · {BRL0(porClasse[k]?.valor || 0)}
                    </span>
                  </button>
                ))}
                <div className="relative ml-auto w-[260px] max-w-full">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Buscar cliente, cidade, vendedor ou CNPJ"
                    className="pl-8 h-9"
                    data-testid="input-busca-cliente"
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {classeSel === "todas"
                  ? "A = clientes que somam 80% do faturamento · B = até 95% · C = o restante."
                  : classeSel === "A"
                    ? "Classe A — os clientes que somam os primeiros 80% do faturamento do período."
                    : classeSel === "B"
                      ? "Classe B — a faixa entre 80% e 95% do faturamento acumulado."
                      : "Classe C — os últimos 5% do faturamento acumulado."}
                {filtrarVend ? ` A curva está recalculada dentro da carteira de ${vendedor}.` : ""}
              </p>
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
                  {listaVisivel.map((c, i) => {
                    const cl = classeDe.get(c.chave) || c.classe;
                    return (
                      <TableRow key={c.chave} data-testid={`row-cliente-${i}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-medium">
                          {c.nome}
                          {c.cadastrado && !c.ativo ? (
                            <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground align-middle">inativo</span>
                          ) : null}
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
                  {listaFiltrada.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-6">
                      {busca.trim() ? "Nenhum cliente encontrado para essa busca." : "Nenhum cliente com faturamento no período."}
                    </TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
                <p className="text-xs text-muted-foreground">
                  Mostrando {NUM(listaVisivel.length)} de {NUM(listaFiltrada.length)} clientes
                  {classeSel !== "todas" ? ` da classe ${classeSel}` : ""}
                  {filtrarVend ? ` na carteira de ${vendedor}` : ""} · {BRL0(totalFiltrado)} no período.
                  {d?.clientesTruncado ? " Base limitada aos 2.000 maiores." : ""}
                </p>
                {listaVisivel.length < listaFiltrada.length ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setVisiveis((v) => v + 100)} data-testid="button-mostrar-mais">
                      Mostrar mais 100
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setVisiveis(listaFiltrada.length)} data-testid="button-mostrar-todos">
                      Mostrar todos ({NUM(listaFiltrada.length)})
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
