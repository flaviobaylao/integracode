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

// Aba "Gráficos" da Gestão de Carteiras.
//  1) Barras: faturamento mês a mês comparando os anos (ou o total de cada ano).
//  2) Linhas: uma linha por vendedor. O seletor troca a base entre a carteira
//     inteira, o faturamento só dos clientes novos do período e a quantidade de
//     clientes novos. O mês em curso entra tracejado (está pela metade).
// Tudo sai de /api/reports/carteira-graficos, agregado no servidor.

type Vend = {
  vendedor: string; total: number;
  fat: Record<string, number>; novosQtd: Record<string, number>; novosValor: Record<string, number>;
  novosTotal: number; novosValorTotal: number;
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

type Base = "carteira" | "novosValor" | "novosQtd";
const BASES: Array<{ k: Base; rot: string }> = [
  { k: "carteira", rot: "Carteira inteira (R$)" },
  { k: "novosValor", rot: "Clientes novos do período (R$)" },
  { k: "novosQtd", rot: "Quantidade de clientes novos" },
];

export default function GraficosCarteira() {
  const hoje = mesHoje();
  const [inicio, setInicio] = useState(`${Number(hoje.slice(0, 4)) - 1}-01`);
  const [fim, setFim] = useState(hoje);
  const [visao, setVisao] = useState<"mensal" | "anual">("mensal");
  const [base, setBase] = useState<Base>("carteira");
  const [selVend, setSelVend] = useState<string[] | null>(null); // null = padrão (top 8)

  const { data, isLoading, error } = useQuery<Resp>({
    queryKey: ["/api/reports/carteira-graficos", inicio, fim],
    queryFn: async () => {
      const r = await fetch(`/api/reports/carteira-graficos?inicio=${inicio}&fim=${fim}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const meses = data?.periodo.meses || [];
  const mesCorrente = data?.periodo.mesCorrente || hoje;
  const temParcial = meses.length > 0 && meses[meses.length - 1] === mesCorrente;
  const anos = useMemo(() => Array.from(new Set(meses.map((m) => m.slice(0, 4)))), [meses]);

  // ── Gráfico 1: barras ─────────────────────────────────────────────────────
  const barras = useMemo(() => {
    const tot = data?.total || [];
    if (visao === "anual") {
      return anos.map((a) => ({
        rotulo: a + (temParcial && mesCorrente.startsWith(a) ? "*" : ""),
        valor: tot.filter((t) => t.mes.startsWith(a)).reduce((s, t) => s + t.valor, 0),
      }));
    }
    if (anos.length <= 1) return tot.map((t) => ({ rotulo: rotMes(t.mes) + (t.mes === mesCorrente ? "*" : ""), valor: t.valor }));
    // Vários anos: Jan..Dez no eixo, uma barra por ano.
    return MESES_ABREV.map((nome, i) => {
      const row: any = { rotulo: nome };
      for (const a of anos) {
        const m = `${a}-${String(i + 1).padStart(2, "0")}`;
        const t = tot.find((x) => x.mes === m);
        row[a] = t ? t.valor : null;
      }
      return row;
    });
  }, [data, visao, anos, temParcial, mesCorrente]);
  const barrasPorAno = visao === "mensal" && anos.length > 1;
  const totalPeriodo = (data?.total || []).reduce((s, t) => s + t.valor, 0);

  // ── Gráfico 2: linhas por vendedor ────────────────────────────────────────
  const vendedores = data?.vendedores || [];
  const valorDe = (v: Vend, m: string) =>
    base === "carteira" ? v.fat[m] || 0 : base === "novosValor" ? v.novosValor[m] || 0 : v.novosQtd[m] || 0;
  const totalDe = (v: Vend) => (base === "carteira" ? v.total : base === "novosValor" ? v.novosValorTotal : v.novosTotal);

  const opcoesVend = useMemo(() => vendedores.filter((v) => totalDe(v) > 0).map((v) => v.vendedor), [vendedores, base]);
  const padraoVend = useMemo(
    () => vendedores.filter((v) => v.vendedor !== "Sem vendedor" && totalDe(v) > 0)
      .sort((a, b) => totalDe(b) - totalDe(a)).slice(0, 8).map((v) => v.vendedor),
    [vendedores, base],
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
  }, [vendedores, ativos.join("|"), visao, base, meses, anos, temParcial, mesCorrente]);

  const ehQtd = base === "novosQtd";
  const fmtEixo = (v: number) => (ehQtd ? String(v) : curto(v));
  const fmtValor = (v: number) => (ehQtd ? `${v} cliente${v === 1 ? "" : "s"}` : brl(v));

  const TooltipLinhas = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const visto = new Set<string>();
    const itens = payload
      .map((p: any) => ({ nome: String(p.dataKey).replace(/__p$/, ""), valor: p.value, cor: p.stroke }))
      .filter((p: any) => p.valor !== null && p.valor !== undefined && !visto.has(p.nome) && visto.add(p.nome))
      .sort((a: any, b: any) => b.valor - a.valor);
    return (
      <div className="rounded-md border bg-white px-3 py-2 text-xs shadow">
        <div className="font-semibold mb-1">{label}</div>
        {itens.map((p: any) => (
          <div key={p.nome} className="flex justify-between gap-4">
            <span style={{ color: p.cor }}>{p.nome}</span><span>{fmtValor(p.valor)}</span>
          </div>
        ))}
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
          <div className="flex rounded-md border overflow-hidden ml-auto">
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
                {temParcial && " *Mês em curso, ainda parcial."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={340}>
                <BarChart data={barras} margin={{ top: 24, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="rotulo" />
                  <YAxis tickFormatter={curto} width={70} />
                  <Tooltip formatter={(v: any) => (v === null ? "—" : brl(Number(v)))} />
                  {barrasPorAno ? (
                    <>
                      <Legend />
                      {anos.map((a, i) => (
                        <Bar key={a} dataKey={a} name={a} fill={RAMPA_ANO[Math.max(0, RAMPA_ANO.length - anos.length + i)]} isAnimationActive={false} />
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
                  <CardTitle>Evolução por vendedor</CardTitle>
                  <CardDescription>
                    {base === "carteira" && "Faturamento mês a mês da carteira atual de cada vendedor."}
                    {base === "novosValor" && "Faturamento só dos clientes que entraram na carteira dentro do período."}
                    {base === "novosQtd" && "Quantos clientes novos cada vendedor trouxe por mês (data de conquista: cadastro ou 1ª compra)."}
                    {temParcial && visao === "mensal" && " O trecho até o mês em curso é tracejado."}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex rounded-md border overflow-hidden" data-testid="graf-base">
                    {BASES.map((b) => (
                      <button key={b.k} type="button" onClick={() => setBase(b.k)} data-testid={`graf-base-${b.k}`}
                        className={`px-3 py-1.5 text-sm ${base === b.k ? "bg-emerald-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}>
                        {b.rot}
                      </button>
                    ))}
                  </div>
                  <MultiSelect label="Vendedores" options={opcoesVend} selected={ativos} onChange={(v) => setSelVend(v)} testId="graf-vendedores" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {ativos.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center">Nenhum vendedor com dados nesta base e período.</div>
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
