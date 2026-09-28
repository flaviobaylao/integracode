// Aba admin-only do Dashboard Geral: Produção & Faturamento por SKU/mês.
// Consome GET /api/industria/dashboard-producao-faturamento (rota já restrita a admin).
// Fontes: ordens de produção (produzidas), lotes de estoque (custo unit + valor em estoque),
// billing_pipeline (vendidas + faturamento, só operações de venda).
import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";

const nf = (n: any) => new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brl0 = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(n) || 0);
const cap = (s: string) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const mesLabel = (ym: string) => {
  const [y, m] = (ym || "").split("-");
  const nomes = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  return (nomes[Number(m)] || ym) + "/" + (y || "");
};

type Row = { sabor: string; tam: string; produzidas: number; custo_unit: number | null; custo_total_prod: number; vendidas: number; faturamento: number; estoque: number; custo_estoque: number };
type MonthData = { month: string; rows: Row[]; sub900: any; sub350: any; total: any };

function Chart({ rows }: { rows: Row[] }) {
  const data = [...rows].sort((a, b) => b.vendidas - a.vendidas);
  const max = Math.max(1, ...data.map((r) => Math.max(r.produzidas, r.vendidas)));
  const rowH = 30, gap = 10, padL = 168, padR = 56, padT = 6, W = 760, H = padT + data.length * (rowH + gap), barH = 11;
  const scale = (v: number) => (v / max) * (W - padL - padR);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  return (
    <svg viewBox={`0 0 ${W} ${H + 26}`} width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Produzido versus vendido por SKU" style={{ fontFamily: "inherit" }}>
      {grid.map((g, i) => { const x = padL + scale(g); return (<g key={i}><line x1={x} y1={padT} x2={x} y2={H} stroke="#e5e7eb" /><text x={x} y={H + 16} fill="#6b7280" fontSize="10" textAnchor="middle">{nf(g)}</text></g>); })}
      {data.map((r, i) => { const y = padT + i * (rowH + gap); return (
        <g key={r.sabor + r.tam}>
          <text x={padL - 8} y={y + rowH / 2} fill="#374151" fontSize="11" textAnchor="end" dominantBaseline="middle">{cap(r.sabor) + " " + r.tam}</text>
          <rect x={padL} y={y + 2} width={Math.max(scale(r.produzidas), 0)} height={barH} rx="2.5" fill="#059669" />
          <rect x={padL} y={y + 2 + barH + 3} width={Math.max(scale(r.vendidas), 0)} height={barH} rx="2.5" fill="#e11d48" />
          <text x={padL + scale(r.produzidas) + 5} y={y + 2 + barH / 2} fill="#6b7280" fontSize="9.5" dominantBaseline="middle">{nf(r.produzidas)}</text>
          <text x={padL + scale(r.vendidas) + 5} y={y + 2 + barH + 3 + barH / 2} fill="#6b7280" fontSize="9.5" dominantBaseline="middle">{nf(r.vendidas)}</text>
        </g>); })}
    </svg>
  );
}

export default function ProducaoFaturamento() {
  const { data, isLoading, error } = useQuery<any>({ queryKey: ["/api/industria/dashboard-producao-faturamento"], refetchOnWindowFocus: true, staleTime: 0 });
  const months: MonthData[] = data?.months || [];
  const [sel, setSel] = useState<string>("");
  const current = useMemo(() => months.find((m) => m.month === sel) || months[months.length - 1], [months, sel]);

  if (isLoading) return <div className="mt-6 text-sm text-gray-500">Carregando dados de produção…</div>;
  if (error) return <div className="mt-6 text-sm text-red-600">Erro ao carregar: {String((error as any)?.message || error)}</div>;
  if (!current) return <div className="mt-6 text-sm text-gray-500">Sem dados de produção a partir de Set/2026.</div>;

  const T = current.total;
  const kpis = [
    { lab: "Garrafas produzidas", val: nf(T.produzidas), u: "un", dot: "bg-emerald-600", split: `900: ${nf(current.sub900.produzidas)} · 350: ${nf(current.sub350.produzidas)}` },
    { lab: "Custo de produção", val: brl0(T.custo_total_prod), u: "", dot: "bg-amber-500", split: `900: ${brl0(current.sub900.custo_total_prod)} · 350: ${brl0(current.sub350.custo_total_prod)}` },
    { lab: "Garrafas vendidas", val: nf(T.vendidas), u: "un", dot: "bg-rose-600", split: `900: ${nf(current.sub900.vendidas)} · 350: ${nf(current.sub350.vendidas)}` },
    { lab: "Faturamento", val: brl0(T.faturamento), u: "", dot: "bg-rose-600", split: `900: ${brl0(current.sub900.faturamento)} · 350: ${brl0(current.sub350.faturamento)}` },
    { lab: "Estoque atual", val: nf(T.estoque), u: "un", dot: "bg-emerald-600", split: `900: ${nf(current.sub900.estoque)} · 350: ${nf(current.sub350.estoque)}` },
    { lab: "Custo em estoque", val: brl0(T.custo_estoque), u: "", dot: "bg-amber-500", split: `900: ${brl0(current.sub900.custo_estoque)} · 350: ${brl0(current.sub350.custo_estoque)}` },
  ];

  const r900 = current.rows.filter((r) => r.tam === "900");
  const r350 = current.rows.filter((r) => r.tam === "350");
  const cell = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
  const th = "px-3 py-2 text-right text-[11px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap";
  const SubRow = ({ label, d }: { label: string; d: any }) => (
    <tr className="bg-gray-50 font-semibold">
      <td className="px-3 py-2 text-left">{label}</td><td></td>
      <td className={cell}>{nf(d.produzidas)}</td><td></td><td className={cell}>{brl0(d.custo_total_prod)}</td>
      <td className={cell}>{nf(d.vendidas)}</td><td className={cell}>{brl0(d.faturamento)}</td>
      <td className={cell}>{nf(d.estoque)}</td><td className={cell}>{brl0(d.custo_estoque)}</td>
    </tr>
  );
  const DataRow = ({ r }: { r: Row }) => (
    <tr className="border-b border-gray-100">
      <td className="px-3 py-2 text-left font-medium">{cap(r.sabor)}</td>
      <td className="px-3 py-2 text-left"><span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-600">{r.tam}ml</span></td>
      <td className={cell}>{nf(r.produzidas)}</td>
      <td className={cell}>{r.custo_unit != null ? brl(r.custo_unit) : <span className="text-gray-400">—</span>}</td>
      <td className={cell}>{brl0(r.custo_total_prod)}</td>
      <td className={cell}>{nf(r.vendidas)}</td>
      <td className={cell}>{brl0(r.faturamento)}</td>
      <td className={cell}>{nf(r.estoque)}</td>
      <td className={cell}>{brl0(r.custo_estoque)}</td>
    </tr>
  );

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Produção &amp; Faturamento por SKU</h2>
          <p className="text-xs text-gray-500">Fonte: módulo Indústria (ordens de produção + lotes) e pipeline de faturamento. Dados a partir de Set/2026{data?.generatedAt ? " · atualizado em " + new Date(data.generatedAt).toLocaleString("pt-BR") : ""}.</p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {months.map((m) => (
            <button key={m.month} type="button" onClick={() => setSel(m.month)}
              className={"text-xs font-semibold px-3 py-1.5 rounded-full border " + (current.month === m.month ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-300 text-gray-500 hover:text-gray-700")}>
              {mesLabel(m.month)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {kpis.map((k, i) => (
          <Card key={i}><CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-500"><span className={"w-2 h-2 rounded-sm " + k.dot}></span>{k.lab}</div>
            <div className="mt-1.5 text-2xl font-bold text-gray-800 tabular-nums">{k.val} {k.u && <span className="text-sm font-medium text-gray-400">{k.u}</span>}</div>
            <div className="mt-1 text-xs text-gray-500 tabular-nums">{k.split}</div>
          </CardContent></Card>
        ))}
      </div>

      <Card><CardContent className="p-4">
        <div className="flex items-center gap-4 text-xs text-gray-500 mb-2">
          <span className="font-semibold text-gray-700">Produzido × Vendido (garrafas)</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px] mr-1 bg-emerald-600"></span>Produzidas</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px] mr-1 bg-rose-600"></span>Vendidas</span>
        </div>
        <div className="overflow-x-auto"><Chart rows={current.rows} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 760 }}>
            <thead><tr className="border-b border-gray-200">
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Sabor</th>
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Emb.</th>
              <th className={th}>Produzidas</th><th className={th}>Custo unit.</th><th className={th}>Custo produção</th>
              <th className={th}>Vendidas</th><th className={th}>Faturamento</th><th className={th}>Estoque</th><th className={th}>Custo estoque</th>
            </tr></thead>
            <tbody>
              {r900.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
              <SubRow label="Subtotal 900 ml" d={current.sub900} />
              {r350.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
              <SubRow label="Subtotal 350 ml" d={current.sub350} />
              <tr className="bg-emerald-50 font-bold border-t-2 border-emerald-600">
                <td className="px-3 py-2 text-left">TOTAL</td><td></td>
                <td className={cell}>{nf(T.produzidas)}</td><td></td><td className={cell}>{brl0(T.custo_total_prod)}</td>
                <td className={cell}>{nf(T.vendidas)}</td><td className={cell}>{brl0(T.faturamento)}</td>
                <td className={cell}>{nf(T.estoque)}</td><td className={cell}>{brl0(T.custo_estoque)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent></Card>
      <p className="text-[11px] text-gray-400">Estoque e custo em estoque são o saldo atual (snapshot) dos lotes em uso; produção, vendas e faturamento são do mês selecionado. Custo de produção = garrafas produzidas × custo unitário do lote.</p>
    </div>
  );
}
