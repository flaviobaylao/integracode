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
const pct = (n: number | null) => n == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const cap = (s: string) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const mesLabel = (ym: string) => {
  const [y, m] = (ym || "").split("-");
  const nomes = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  return (nomes[Number(m)] || ym) + "/" + (y || "");
};

type Row = { sabor: string; tam: string; produzidas: number; custo_unit: number | null; custo_total_prod: number; vendidas: number; faturamento: number; trocas_amostras: number; custo_trocas_amostras: number; estoque: number; custo_estoque: number };
type MonthData = { month: string; rows: Row[]; sub900: any; sub350: any; total: any };

// Preço médio realizado = faturamento ÷ garrafas vendidas.
const precoMedio = (fat: number, vend: number) => (Number(vend) > 0 ? Number(fat) / Number(vend) : null);
// Custo das vendidas (COGS) = Σ custo unitário do lote × garrafas vendidas.
const cogsOf = (rows: Row[]) => rows.reduce((s, r) => s + (r.custo_unit != null ? r.custo_unit * r.vendidas : 0), 0);
// Margem bruta = (faturamento − custo das vendidas) ÷ faturamento.
const margemDe = (fat: number, cogs: number) => (Number(fat) > 0 ? (Number(fat) - Number(cogs)) / Number(fat) : null);

// Ícone "i" com tooltip explicando origem/composição do dado da coluna.
const Info = ({ t }: { t: string }) => (
  <span title={t} className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 text-gray-500 text-[9px] font-bold cursor-help align-[1px] normal-case tracking-normal">i</span>
);

const INFO = {
  sabor: "Sabor do suco conforme o nome do SKU cadastrado no módulo Indústria.",
  emb: "Embalagem da garrafa (900 ml ou 350 ml), extraída do nome do SKU.",
  produzidas: "Soma das garrafas nas ordens de produção do mês (módulo Indústria › ordens de produção), agrupadas por SKU.",
  custoUnit: "Custo unitário do lote em uso (módulo Indústria › lotes de estoque). Ainda NÃO inclui energia elétrica nem mão de obra.",
  custoProd: "Custo de produção = garrafas produzidas × custo unitário do lote. Ainda NÃO inclui energia elétrica nem mão de obra.",
  vendidas: "Garrafas vendidas = soma das quantidades dos itens das NF-e de venda emitidas no mês (regra oficial, a mesma do Painel: NF autorizada, deduplicada por nº, sem devolução/troca/transferência/remessa/bonificação/amostra).",
  faturamento: "Valor dos produtos vendidos = soma do valor dos itens das NF-e de venda do mês (regra oficial do Painel). Pode diferir do total da NF por ajustes de rodapé (descontos, frete, impostos) — o total oficial da NF está indicado abaixo da tabela.",
  preco: "Preço médio de venda realizado = Faturamento ÷ Garrafas vendidas.",
  margem: "Margem bruta = (Faturamento − custo das vendidas) ÷ Faturamento, com custo das vendidas = custo unitário do lote × garrafas vendidas. Ainda NÃO considera energia elétrica nem mão de obra.",
  trocasAmostras: "Garrafas cedidas em operações do tipo 'troca' ou 'amostra' no mês (pipeline de faturamento). Não entram em Vendidas nem em Faturamento.",
  custoTA: "Custo das trocas/amostras = garrafas cedidas × custo unitário do lote. Ainda NÃO inclui energia elétrica nem mão de obra.",
  estoque: "Saldo atual de garrafas em lotes 'em uso' (snapshot do momento da consulta, módulo Indústria).",
  custoEstoque: "Valor atual em estoque = soma do custo total dos lotes 'em uso' (snapshot do momento da consulta).",
};

export default function ProducaoFaturamento() {
  const { data, isLoading, error } = useQuery<any>({ queryKey: ["/api/industria/dashboard-producao-faturamento"], refetchInterval: 1800000, refetchOnWindowFocus: true, staleTime: 0 });
  const months: MonthData[] = data?.months || [];
  const [sel, setSel] = useState<string>("");
  const current = useMemo(() => months.find((m) => m.month === sel) || months[months.length - 1], [months, sel]);

  if (isLoading) return <div className="mt-6 text-sm text-gray-500">Carregando dados de produção…</div>;
  if (error) return <div className="mt-6 text-sm text-red-600">Erro ao carregar: {String((error as any)?.message || error)}</div>;
  if (!current) return <div className="mt-6 text-sm text-gray-500">Sem dados de produção a partir de Set/2026.</div>;

  const T = current.total;
  const r900 = current.rows.filter((r) => r.tam === "900");
  const r350 = current.rows.filter((r) => r.tam === "350");
  const cell = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
  const th = "px-3 py-2 text-right text-[11px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap";
  const Margem = ({ m }: { m: number | null }) => m == null
    ? <span className="text-gray-400">—</span>
    : <span className={m < 0 ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}>{pct(m)}</span>;
  const SubRow = ({ label, d, rows }: { label: string; d: any; rows: Row[] }) => {
    const preco = precoMedio(d.faturamento, d.vendidas);
    const marg = margemDe(d.faturamento, cogsOf(rows));
    return (
      <tr className="bg-slate-100 font-semibold text-slate-800 border-y-2 border-slate-300">
        <td className="px-3 py-2 text-left"><span className="border-l-4 border-slate-400 pl-2">{label}</span></td><td></td>
        <td className={cell}>{nf(d.produzidas)}</td><td></td><td className={cell}>{brl0(d.custo_total_prod)}</td>
        <td className={cell}>{nf(d.vendidas)}</td><td className={cell}>{brl0(d.faturamento)}</td>
        <td className={cell}>{preco != null ? brl(preco) : <span className="text-gray-400">—</span>}</td>
        <td className={cell}><Margem m={marg} /></td>
        <td className={cell + " text-sky-700"}>{nf(d.trocas_amostras)}</td>
        <td className={cell + " text-sky-700"}>{brl0(d.custo_trocas_amostras)}</td>
        <td className={cell}>{nf(d.estoque)}</td><td className={cell}>{brl0(d.custo_estoque)}</td>
      </tr>
    );
  };
  const DataRow = ({ r }: { r: Row }) => {
    const preco = precoMedio(r.faturamento, r.vendidas);
    const marg = r.custo_unit != null ? margemDe(r.faturamento, r.custo_unit * r.vendidas) : null;
    return (
      <tr className="border-b border-gray-100">
        <td className="px-3 py-2 text-left font-medium">{cap(r.sabor)}</td>
        <td className="px-3 py-2 text-left"><span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-600">{r.tam}ml</span></td>
        <td className={cell}>{nf(r.produzidas)}</td>
        <td className={cell}>{r.custo_unit != null ? brl(r.custo_unit) : <span className="text-gray-400">—</span>}</td>
        <td className={cell}>{brl0(r.custo_total_prod)}</td>
        <td className={cell}>{nf(r.vendidas)}</td>
        <td className={cell}>{brl0(r.faturamento)}</td>
        <td className={cell}>{preco != null ? brl(preco) : <span className="text-gray-400">—</span>}</td>
        <td className={cell}><Margem m={marg} /></td>
        <td className={cell + " text-sky-700"}>{nf(r.trocas_amostras)}</td>
        <td className={cell + " text-sky-700"}>{brl0(r.custo_trocas_amostras)}</td>
        <td className={cell}>{nf(r.estoque)}</td>
        <td className={cell}>{brl0(r.custo_estoque)}</td>
      </tr>
    );
  };

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

      <Card><CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 1140 }}>
            <thead><tr className="border-b border-gray-200">
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap">Sabor<Info t={INFO.sabor} /></th>
              <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap">Emb.<Info t={INFO.emb} /></th>
              <th className={th}>Produzidas<Info t={INFO.produzidas} /></th>
              <th className={th}>Custo unit.<Info t={INFO.custoUnit} /></th>
              <th className={th}>Custo produção<Info t={INFO.custoProd} /></th>
              <th className={th}>Vendidas<Info t={INFO.vendidas} /></th>
              <th className={th}>Faturamento<Info t={INFO.faturamento} /></th>
              <th className={th}>Preço venda<Info t={INFO.preco} /></th>
              <th className={th}>Margem<Info t={INFO.margem} /></th>
              <th className={th + " text-sky-700"}>Trocas/Amostras<Info t={INFO.trocasAmostras} /></th>
              <th className={th + " text-sky-700"}>Custo T/A<Info t={INFO.custoTA} /></th>
              <th className={th}>Estoque<Info t={INFO.estoque} /></th>
              <th className={th}>Custo estoque<Info t={INFO.custoEstoque} /></th>
            </tr></thead>
            <tbody>
              {r900.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
              <SubRow label="Subtotal 900 ml" d={current.sub900} rows={r900} />
              {r350.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
              <SubRow label="Subtotal 350 ml" d={current.sub350} rows={r350} />
              <tr className="bg-emerald-600 text-white font-bold text-[15px] border-t-4 border-emerald-800">
                <td className="px-3 py-2.5 text-left tracking-wide">TOTAL</td><td></td>
                <td className={cell}>{nf(T.produzidas)}</td><td></td><td className={cell}>{brl0(T.custo_total_prod)}</td>
                <td className={cell}>{nf(T.vendidas)}</td><td className={cell}>{brl0(T.faturamento)}</td>
                <td className={cell}>{precoMedio(T.faturamento, T.vendidas) != null ? brl(precoMedio(T.faturamento, T.vendidas)) : "—"}</td>
                <td className={cell}>{pct(margemDe(T.faturamento, cogsOf(current.rows)))}</td>
                <td className={cell}>{nf(T.trocas_amostras)}</td>
                <td className={cell}>{brl0(T.custo_trocas_amostras)}</td>
                <td className={cell}>{nf(T.estoque)}</td><td className={cell}>{brl0(T.custo_estoque)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      {T.faturamento_oficial_nf != null && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600 px-1">
          <span>Faturamento oficial da NF no mês (igual ao Painel): <span className="font-semibold text-gray-800 tabular-nums">{brl(T.faturamento_oficial_nf)}</span></span>
          <span>Soma do valor dos produtos por SKU: <span className="font-semibold text-gray-800 tabular-nums">{brl(T.faturamento)}</span></span>
          {Math.abs((T.faturamento_oficial_nf || 0) - (T.faturamento || 0)) >= 0.5 && (
            <span className="text-amber-600">Diferença de {brl(Math.abs((T.faturamento_oficial_nf || 0) - (T.faturamento || 0)))} = ajustes de rodapé da NF (descontos, frete e impostos), que não são rateados por SKU.</span>
          )}
        </div>
      )}

      <p className="text-[11px] text-gray-400">Vendidas e faturamento vêm da <span className="font-medium">NF-e de venda emitida</span> (regra oficial, a mesma do Painel), rateados por SKU pelos itens da nota. Estoque e custo em estoque são o saldo atual (snapshot) dos lotes em uso; produção é do mês selecionado. Custo de produção = garrafas produzidas × custo unitário do lote — <span className="text-amber-600 font-medium">ainda não inclui energia elétrica nem mão de obra</span>. Preço de venda = faturamento ÷ vendidas; margem bruta = (faturamento − custo das vendidas) ÷ faturamento. Trocas/amostras são contabilizadas à parte (garrafas cedidas × custo unitário) e não entram em vendidas nem em faturamento. Passe o mouse sobre o <span className="font-semibold">i</span> de cada coluna para ver a origem do dado. Os dados se atualizam automaticamente na mesma cadência do Painel (a cada 30 min e ao focar a janela).</p>
    </div>
  );
}
