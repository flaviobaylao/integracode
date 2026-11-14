import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList,
} from "recharts";
import { Download } from "lucide-react";
import { exportToExcel, MultiSelect } from "@/lib/tableTools";

// Os dois gráficos da Gestão de Carteiras. Moravam numa aba "Gráficos" própria,
// que saiu em 13/11/2026 (Flavio): os dois passaram a viver dentro do DOSSIÊ DO
// VENDEDOR, no lugar da antiga "Evolução em 2026: vendas e carteira". O dossiê
// já é a tela de olhar vendedor; ter metade da evolução numa aba e metade em
// outra obrigava a comparar de cabeça.
//
// O componente continua inteiro e com os próprios controles de período, porque
// o período dele é outro: o dossiê trabalha um ano por vez e estes gráficos
// existem justamente para comparar anos. `periodoInicial` faz o embutido abrir
// no ano que o dossiê está mostrando, em vez de num padrão que não conversa
// com o resto da tela.
//  1) Barras: faturamento mês a mês comparando os anos (ou o total de cada ano).
//  2) Linhas: NOVOS CLIENTES por vendedor — quantos entraram na carteira em
//     cada mês. O tooltip abre a relação: quem entrou e o que comprou no
//     período. O mês em curso entra tracejado (está pela metade).
// Tudo sai de /api/reports/carteira-graficos, agregado no servidor.

type Novo = { nome: string; valor: number };
type Vend = {
  vendedor: string; total: number;
  fat: Record<string, number>; novosQtd: Record<string, number>; novosValor: Record<string, number>;
  novosTotal: number; novosValorTotal: number;
  /** mês de conquista -> quem entrou, com o que comprou no período. */
  novosLista?: Record<string, Novo[]>;
};
type Resp = {
  ok: boolean;
  periodo: { inicio: string; fim: string; meses: string[]; mesCorrente: string };
  total: Array<{ mes: string; valor: number; novos: number }>;
  vendedores: Vend[];
};

const MESES_ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const rotMes = (m: string) => `${MESES_ABREV[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
// Anos: rampa de um tom (o ano mais recente é o mais escuro).
const RAMPA_ANO = ["#c3d9f3", "#86b6ef", "#3987e5", "#184f95", "#0c2e5c"];
// Vendedores: categórico, ordem fixa.
const CORES = ["#2a78d6", "#eb6834", "#1f8a4c", "#8e4c8a", "#b8901a", "#d03b3b", "#4a3aa7", "#0f8b8d", "#7c8a82", "#c2185b", "#5d4037", "#00897b"];

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const curto = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
};

function mesHoje(): string {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(new Date());
  return d.slice(0, 7);
}
function somaMes(m: string, delta: number): string {
  let y = Number(m.slice(0, 4)), mm = Number(m.slice(5, 7)) + delta;
  while (mm < 1) { mm += 12; y--; }
  while (mm > 12) { mm -= 12; y++; }
  return `${y}-${String(mm).padStart(2, "0")}`;
}

// 14/11/2026 — COMPARATIVO LIGA/DESLIGA (Flavio). Antes a comparação entre anos
// era um efeito colateral do filtro: ela só aparecia quando o período pegava
// mais de um ano civil. Com "Últimos 4 meses" ou "Este ano" não havia como ver
// o ano anterior, e com "Tudo" não havia como NÃO ver. Agora é uma escolha:
//  • Individual  — uma barra por mês do período, na ordem do calendário.
//  • Comparativo — cada mês ao lado do mesmo mês do ano anterior.
// O comparativo vale só para o gráfico de faturamento; o de Novos clientes
// segue o filtro de período e mais nada.
//
// Quando o ano anterior não está dentro do filtro (o caso de "Últimos 4 meses"),
// ele é buscado numa segunda chamada ao mesmo endpoint, deslocada 12 meses. Os
// dois resultados entram num mapa mês -> faturamento, com o período filtrado
// tendo precedência: em "Tudo", que já contém 2025 e 2026, as duas faixas se
// cruzam e a mesma chave YYYY-MM não pode ser contada duas vezes.

// 13/11/2026 — o seletor de base saiu (Flavio): o gráfico de baixo é SÓ "Novos
// clientes", a quantidade que cada vendedor trouxe em cada mês. As outras duas
// bases diziam a mesma história em unidades diferentes e obrigavam a escolher
// antes de olhar; o que faltava não era opção, era detalhe — e esse agora vem
// no tooltip: quantos entraram, QUEM entrou e o que compraram no período.
// Quantos nomes o tooltip lista antes de resumir o resto.
const MAX_TOOLTIP = 12;

export default function GraficosCarteira({ periodoInicial }: { periodoInicial?: { inicio: string; fim: string } } = {}) {
  const hoje = mesHoje();
  const [inicio, setInicio] = useState(periodoInicial?.inicio || `${Number(hoje.slice(0, 4)) - 1}-01`);
  const [fim, setFim] = useState(periodoInicial?.fim || hoje);
  const [visao, setVisao] = useState<"mensal" | "anual">("mensal");
  const [comparar, setComparar] = useState(true);

  const [selVend, setSelVend] = useState<string[] | null>(null); // null = padrão (top 8)

  const buscar = async (de: string, ate: string): Promise<Resp> => {
    const r = await fetch(`/api/reports/carteira-graficos?inicio=${de}&fim=${ate}`, { credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["/api/reports/carteira-graficos", inicio, fim],
    queryFn: () => buscar(inicio, fim),
  });

  // O mesmo período, 12 meses atrás. Só sai do servidor com o comparativo
  // ligado; a chave é a mesma do outro useQuery, então quando as duas faixas
  // coincidem o cache responde sem ida à rede.
  const iniPrev = somaMes(inicio, -12);
  const fimPrev = somaMes(fim, -12);
  const { data: dataPrev } = useQuery<Resp>({
    queryKey: ["/api/reports/carteira-graficos", iniPrev, fimPrev],
    queryFn: () => buscar(iniPrev, fimPrev),
    enabled: comparar,
  });

  const meses = data?.periodo.meses || [];
  const mesCorrente = data?.periodo.mesCorrente || hoje;
  const temParcial = meses.length > 0 && meses[meses.length - 1] === mesCorrente;
  const anos = useMemo(() => Array.from(new Set(meses.map((m) => m.slice(0, 4)))), [meses]);

  // ── Gráfico 1: barras ─────────────────────────────────────────────────────
  // Mês -> faturamento. O período filtrado escreve por último: onde as duas
  // faixas se cruzam, vale o número do filtro (são iguais, mas a precedência
  // evita contar o mesmo mês duas vezes na soma por ano).
  const fatPorMes = useMemo(() => {
    const m = new Map<string, number>();
    if (comparar) for (const t of dataPrev?.total || []) m.set(t.mes, t.valor);
    for (const t of data?.total || []) m.set(t.mes, t.valor);
    return m;
  }, [data, dataPrev, comparar]);

  // Meses em jogo no comparativo: os do filtro + os mesmos 12 meses atrás.
  const mesesComp = useMemo(
    () => Array.from(new Set(meses.flatMap((m) => [somaMes(m, -12), m]))).sort(),
    [meses],
  );
  // Ano sem nenhum faturamento no recorte não vira barra: em "Tudo" o
  // deslocamento de 12 meses alcança 2024, que é anterior à base.
  const anosComp = useMemo(
    () => Array.from(new Set(mesesComp.map((m) => m.slice(0, 4)))).sort()
      .filter((a) => mesesComp.some((m) => m.startsWith(a) && (fatPorMes.get(m) || 0) > 0)),
    [mesesComp, fatPorMes],
  );
  // Os meses do ano que o eixo mostra, na ordem em que aparecem no período
  // ("Últimos 12 meses" começa em Dez, não em Jan).
  const rotulosMes = useMemo(() => {
    const out: string[] = [];
    for (const m of meses) { const r = MESES_ABREV[Number(m.slice(5, 7)) - 1]; if (!out.includes(r)) out.push(r); }
    return out;
  }, [meses]);
  // Comparar com um ano só não é comparar: cai no individual.
  const comparando = comparar && anosComp.length > 1;

  const barras = useMemo(() => {
    if (visao === "anual") {
      const lista = comparar ? anosComp : anos;
      const escopo = comparar ? mesesComp : meses;
      return lista.map((a) => ({
        rotulo: a + (temParcial && mesCorrente.startsWith(a) ? "*" : ""),
        valor: escopo.filter((m) => m.startsWith(a)).reduce((s, m) => s + (fatPorMes.get(m) || 0), 0),
      }));
    }
    if (comparando) {
      // Mês do ano no eixo, uma barra por ano.
      return rotulosMes.map((nome) => {
        const mm = String(MESES_ABREV.indexOf(nome) + 1).padStart(2, "0");
        const row: any = { rotulo: nome };
        for (const a of anosComp) {
          const m = `${a}-${mm}`;
          row[a] = fatPorMes.has(m) ? fatPorMes.get(m)! : null;
        }
        return row;
      });
    }
    // Individual: a linha do tempo do período, um mês depois do outro.
    return meses.map((m) => ({ rotulo: rotMes(m) + (m === mesCorrente ? "*" : ""), valor: fatPorMes.get(m) || 0 }));
  }, [visao, comparar, comparando, anos, anosComp, meses, mesesComp, rotulosMes, fatPorMes, temParcial, mesCorrente]);
  const barrasPorAno = visao === "mensal" && comparando;
  const totalPeriodo = (data?.total || []).reduce((s, t) => s + t.valor, 0);

  // ── Gráfico 2: linhas por vendedor ────────────────────────────────────────
  const vendedores = data?.vendedores || [];
  const valorDe = (v: Vend, m: string) => v.novosQtd[m] || 0;
  const totalDe = (v: Vend) => v.novosTotal;
  /** Quem entrou na carteira de `v` no mês `m`, maior comprador primeiro. */
  const novosDe = (v: Vend, m: string): Novo[] => (v.novosLista && v.novosLista[m]) || [];

  const opcoesVend = useMemo(() => vendedores.filter((v) => totalDe(v) > 0).map((v) => v.vendedor), [vendedores]);
  const padraoVend = useMemo(
    () => vendedores.filter((v) => v.vendedor !== "Sem vendedor" && totalDe(v) > 0)
      .sort((a, b) => totalDe(b) - totalDe(a)).slice(0, 8).map((v) => v.vendedor),
    [vendedores],
  );
  const ativos = (selVend && selVend.length ? selVend : padraoVend).filter((n) => opcoesVend.includes(n));
  const corDe = (n: string) => CORES[Math.max(0, vendedores.findIndex((v) => v.vendedor === n)) % CORES.length];

  const pontos = useMemo(() => {
    const vs = vendedores.filter((v) => ativos.includes(v.vendedor));
    if (visao === "anual") {
      return anos.map((a) => {
        const row: any = { rotulo: a + (temParcial && mesCorrente.startsWith(a) ? "*" : "") };
        for (const v of vs) row[v.vendedor] = meses.filter((m) => m.startsWith(a)).reduce((s, m) => s + valorDe(v, m), 0);
        return row;
      });
    }
    // Mensal: o último mês, se for o corrente, vai numa série tracejada à parte.
    return meses.map((m, i) => {
      const row: any = { rotulo: rotMes(m) + (m === mesCorrente ? "*" : "") };
      const ultimo = i === meses.length - 1;
      const penultimo = i === meses.length - 2;
      for (const v of vs) {
        const val = valorDe(v, m);
        if (temParcial) {
          row[v.vendedor] = ultimo ? null : val;
          row[`${v.vendedor}__p`] = ultimo || penultimo ? val : null;
        } else row[v.vendedor] = val;
      }
      return row;
    });
  }, [vendedores, ativos.join("|"), visao, meses, anos, temParcial, mesCorrente]);

  const fmtEixo = (v: number) => String(v);

  // O tooltip responde as tres coisas de uma vez (Flavio, 13/11/2026): QUANTOS
  // entraram, QUEM entrou e QUANTO compraram no periodo. Num mes cheio a lista
  // e' cortada no 12o nome — maior comprador primeiro — e o resto vira uma
  // linha de resumo, para o balao nao cobrir o grafico inteiro.
  const TooltipLinhas = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    // 'label' traz o rotulo do eixo (Mai/26, 2026...); o mes real vem do indice.
    const idx = pontos.findIndex((p: any) => p.rotulo === label);
    const mesReal = visao === "mensal" && idx >= 0 ? meses[idx] : null;
    const visto = new Set<string>();
    const itens = payload
      .map((p: any) => ({ nome: String(p.dataKey).replace(/__p$/, ""), valor: p.value, cor: p.stroke }))
      .filter((p: any) => p.valor !== null && p.valor !== undefined && !visto.has(p.nome) && visto.add(p.nome))
      .sort((a: any, b: any) => b.valor - a.valor);
    if (!itens.length) return null;
    return (
      <div className="rounded-md border bg-white px-3 py-2 text-xs shadow max-w-[420px] max-h-[60vh] overflow-auto">
        <div className="font-semibold mb-1">{label}</div>
        {itens.map((p: any) => {
          const v = vendedores.find((x) => x.vendedor === p.nome);
          // Na visao ANUAL o ponto soma 12 meses: a relacao sai da uniao deles.
          const lista: Novo[] = !v ? []
            : mesReal ? novosDe(v, mesReal)
            : meses.filter((m) => m.startsWith(String(label).replace("*", "")))
                   .flatMap((m) => novosDe(v, m)).sort((a, b) => b.valor - a.valor);
          const somaLista = lista.reduce((s, x) => s + x.valor, 0);
          return (
            <div key={p.nome} className="mb-1.5 last:mb-0">
              <div className="flex justify-between gap-4 font-medium">
                <span style={{ color: p.cor }}>{p.nome}</span>
                <span>{p.valor} cliente{p.valor === 1 ? "" : "s"}{somaLista > 0 ? ` · ${brl(somaLista)}` : ""}</span>
              </div>
              {lista.slice(0, MAX_TOOLTIP).map((c, i) => (
                <div key={`${c.nome}-${i}`} className="flex justify-between gap-4 text-[11px] text-muted-foreground pl-2">
                  <span className="truncate">{c.nome}</span>
                  <span className="shrink-0">{c.valor > 0 ? brl(c.valor) : "sem compra"}</span>
                </div>
              ))}
              {lista.length > MAX_TOOLTIP && (
                <div className="text-[11px] text-muted-foreground pl-2 italic">
                  e mais {lista.length - MAX_TOOLTIP} cliente(s)
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const tabela = vendedores
    .filter((v) => ativos.includes(v.vendedor))
    .map((v) => ({ vendedor: v.vendedor, cor: corDe(v.vendedor), valor: totalDe(v), novos: v.novosTotal, novosValor: v.novosValorTotal, carteira: v.total }))
    .sort((a, b) => b.valor - a.valor);

  const exportar = () => {
    const linhas = vendedores.map((v) => {
      const row: any = { Vendedor: v.vendedor };
      for (const m of meses) {
        row[`Fat. ${rotMes(m)}`] = v.fat[m] || 0;
      }
      for (const m of meses) row[`Novos ${rotMes(m)}`] = v.novosQtd[m] || 0;
      row["Faturamento no período"] = v.total;
      row["Clientes novos no período"] = v.novosTotal;
      row["Faturamento dos clientes novos"] = v.novosValorTotal;
      return row;
    });
    exportToExcel(linhas, `graficos-carteira_${inicio}_a_${fim}`);
  };

  const atalho = (ini: string, f: string) => { setInicio(ini); setFim(f); };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground block">De (mês)</label>
            <Input type="month" value={inicio} max={fim} onChange={(e) => e.target.value && setInicio(e.target.value)} className="w-40" data-testid="graf-inicio" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block">Até (mês)</label>
            <Input type="month" value={fim} min={inicio} max={hoje} onChange={(e) => e.target.value && setFim(e.target.value)} className="w-40" data-testid="graf-fim" />
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => atalho(`${hoje.slice(0, 4)}-01`, hoje)}>Este ano</Button>
            <Button variant="outline" size="sm" onClick={() => atalho(somaMes(hoje, -11), hoje)}>Últimos 12 meses</Button>
            <Button variant="outline" size="sm" onClick={() => atalho(somaMes(hoje, -3), hoje)}>Últimos 4 meses</Button>
            <Button variant="outline" size="sm" onClick={() => atalho("2025-01", hoje)}>Tudo</Button>
          </div>
          {/* Individual x Comparativo: vale com qualquer filtro de período. */}
          <div className="flex rounded-md border overflow-hidden ml-auto">
            {([[false, "Individual"], [true, "Comparativo"]] as const).map(([v, rotulo]) => (
              <button key={rotulo} type="button" onClick={() => setComparar(v)} data-testid={`graf-comp-${v ? "on" : "off"}`}
                title={v ? "Mostra também o mesmo período do ano anterior" : "Mostra só o período filtrado"}
                className={`px-3 py-1.5 text-sm ${comparar === v ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}>
                {rotulo}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border overflow-hidden">
            {(["mensal", "anual"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setVisao(v)} data-testid={`graf-visao-${v}`}
                className={`px-3 py-1.5 text-sm ${visao === v ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}>
                {v === "mensal" ? "Mensal" : "Anual"}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={exportar} disabled={!data}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </CardContent>
      </Card>

      {error && <div className="text-red-600 text-sm">Erro ao carregar: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted-foreground text-sm">Carregando gráficos…</div>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Evolução das vendas {visao === "anual" ? "por ano" : barrasPorAno ? "— comparação entre os anos" : "mês a mês"}</CardTitle>
              <CardDescription>
                Faturamento de {rotMes(inicio)} a {rotMes(fim)}: <b>{brl(totalPeriodo)}</b>. Mesma régua da aba Carteira.
                {barrasPorAno && " Comparativo ligado: cada mês aparece ao lado do mesmo mês do ano anterior."}
                {comparar && visao === "anual" && " Comparativo ligado: o ano anterior entra com os mesmos meses, para a comparação ser de igual para igual."}
                {comparar && !comparando && visao === "mensal" && " Sem faturamento no ano anterior para comparar — mostrando só o período."}
                {temParcial && " *Mês em curso, ainda parcial."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={340}>
                {/* barGap=2: o par do comparativo encosta, mas não se funde. */}
                <BarChart data={barras} margin={{ top: 24, right: 16, left: 8, bottom: 0 }} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="rotulo" />
                  <YAxis tickFormatter={curto} width={70} />
                  <Tooltip formatter={(v: any) => (v === null ? "—" : brl(Number(v)))} />
                  {barrasPorAno ? (
                    <>
                      <Legend />
                      {anosComp.map((a, i) => (
                        <Bar key={a} dataKey={a} name={a} fill={RAMPA_ANO[Math.max(0, RAMPA_ANO.length - anosComp.length + i)]} isAnimationActive={false} />
                      ))}
                    </>
                  ) : (
                    <Bar dataKey="valor" name="Faturamento" fill="#2a78d6" isAnimationActive={false}>
                      <LabelList dataKey="valor" position="top" formatter={(v: any) => curto(Number(v))} style={{ fontSize: 11, fill: "#475569" }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Novos clientes por vendedor</CardTitle>
                  <CardDescription>
                    Quantos clientes novos cada vendedor trouxe por mês (data de conquista: cadastro ou 1ª compra).
                    Passe o cursor para ver quem entrou e o que cada um comprou no período.
                    {temParcial && visao === "mensal" && " O trecho até o mês em curso é tracejado."}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <MultiSelect label="Vendedores" options={opcoesVend} selected={ativos} onChange={(v) => setSelVend(v)} testId="graf-vendedores" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {ativos.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center">Nenhum vendedor com cliente novo neste período.</div>
              ) : (
                <ResponsiveContainer width="100%" height={380}>
                  <LineChart data={pontos} margin={{ top: 12, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="rotulo" />
                    <YAxis tickFormatter={fmtEixo} width={70} allowDecimals={false} />
                    <Tooltip content={<TooltipLinhas />} />
                    <Legend />
                    {ativos.map((n) => (
                      <Line key={n} type="linear" dataKey={n} name={n} stroke={corDe(n)} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {temParcial && visao === "mensal" && ativos.map((n) => (
                      <Line key={`${n}__p`} type="linear" dataKey={`${n}__p`} stroke={corDe(n)} strokeWidth={2.5} strokeDasharray="6 5" dot={{ r: 3 }} legendType="none" connectNulls={false} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1 pr-3">Vendedor</th>
                      <th className="py-1 pr-3 text-right">Faturamento da carteira</th>
                      <th className="py-1 pr-3 text-right">Clientes novos</th>
                      <th className="py-1 pr-3 text-right">Faturamento dos novos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabela.map((t) => (
                      <tr key={t.vendedor} className="border-b last:border-0">
                        <td className="py-1 pr-3"><span className="inline-block w-3 h-3 rounded-full mr-2 align-middle" style={{ background: t.cor }} />{t.vendedor}</td>
                        <td className="py-1 pr-3 text-right">{brl(t.carteira)}</td>
                        <td className="py-1 pr-3 text-right">{t.novos}</td>
                        <td className="py-1 pr-3 text-right">{brl(t.novosValor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted-foreground mt-2">
                  Totais de {rotMes(inicio)} a {rotMes(fim)}. Clientes novos no período, todas as carteiras:{" "}
                  <b>{(data.total || []).reduce((s, t) => s + t.novos, 0)}</b>.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
