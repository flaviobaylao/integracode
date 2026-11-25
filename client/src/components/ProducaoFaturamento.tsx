// Aba admin-only do Dashboard Geral: Produção & Faturamento — CUSTO PLENO por SKU num período.
// Consome GET /api/industria/dashboard-custo-pleno?inicio=AAAA-MM-DD&fim=AAAA-MM-DD (rota admin).
// Análise de contador (custeio por absorção, Flavio 23/11/2026):
//  • insumos por garrafa (matéria-prima, embalagens, outros) — consumo real nas OPs do período,
//    ou ficha técnica, ou custo do lote;
//  • custos indiretos (pessoal, salários, aluguel, energia, comerciais, administrativos, gerais,
//    financeiros) do Contas a Pagar pela data de emissão do título, rateados por LITROS produzidos;
//  • impostos sobre vendas pela alíquota efetiva do período.
import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";

const nf = (n: any) => new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brl0 = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(n) || 0);
const pct = (n: number | null | undefined) => n == null || !isFinite(n) ? "—" : new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const cap = (s: string) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MESES_LONGO = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const MIN_DATA = "2026-05-01";
const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const ultimoDia = (ym: string) => { const [y, m] = ym.split("-").map(Number); return ym + "-" + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0"); };
const dataBR = (iso: string) => iso ? iso.split("-").reverse().join("/") : "";

type Row = {
  sabor: string; tam: string; produzidas: number; vendidas: number; faturamento: number; trocas_amostras: number;
  estoque: number; custo_estoque: number; fonte_insumos: "real" | "ficha" | "lote" | null;
  mp_un: number; emb_un: number; outros_un: number; insumos_un: number; insumos_padrao_un: number | null;
  indireto_un: number; custo_pleno_un: number; imposto_un: number; preco: number | null; lucro_un: number | null;
  margem_contrib: number | null; margem_liquida: number | null; resultado: number; custo_ta: number; preco_equilibrio: number | null;
};

// Preço para a margem-alvo: custo pleno ÷ (1 − alíquota de impostos − margem).
const precoAlvo = (pleno: number, aliq: number, m: number) => (1 - aliq - m > 0.0001 ? pleno / (1 - aliq - m) : null);

const Info = ({ t }: { t: string }) => (
  <span title={t} className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 text-gray-500 text-[9px] font-bold cursor-help align-[1px] normal-case tracking-normal">i</span>
);

// Conceitos de cada grupo de colunas (ícone "i" no cabeçalho de cima).
const GRUPO = {
  volume: "VOLUME E RECEITA — o que foi produzido e vendido no período e quanto entrou. Produzidas vem das ordens de produção; vendidas e faturamento vêm das NF-e de venda (regra oficial do Painel). Preço de venda = faturamento ÷ garrafas vendidas.",
  direto: "CUSTO DIRETO (VARIÁVEL) — o que vai fisicamente dentro de cada garrafa e só existe se a garrafa for produzida: matéria-prima (polpas, concentrados, frutas, açúcar) e embalagem (garrafa, tampa, rótulo). Insumos/un = matéria-prima + embalagem + outros insumos. Origem: consumo real nas OPs do período; sem lançamento, ficha técnica; sem ficha, custo do lote.",
  estrutura: "ESTRUTURA RATEADA (CUSTOS INDIRETOS / FIXOS) — tudo o que a empresa gasta para funcionar e não vai dentro da garrafa: pessoal e salários, aluguel, energia, manutenção, despesas comerciais, administrativas, gerais e financeiras (Contas a Pagar do período, pela data de emissão do título). Pelo custeio por absorção, esse total é distribuído às garrafas proporcional aos litros (a de 900 ml absorve 2,6× a de 350 ml). Custo pleno = custo direto + estrutura rateada: é o custo total de cada garrafa.",
  resultado: "RESULTADO — o que sobra depois de pagar impostos e custos. Impostos/un pela alíquota efetiva do período. Lucro/un = preço − impostos − custo pleno. Margem de contribuição = (preço − impostos − insumos) ÷ preço: quanto cada garrafa contribui para pagar a estrutura (se for negativa, cada garrafa vendida aumenta o prejuízo). Margem líquida = lucro ÷ preço, já com toda a estrutura paga. Resultado = lucro/un × garrafas vendidas.",
  preco: "PREÇO DE VENDA (FORMAÇÃO DE PREÇO / MARKUP) — referências para precificar. Equilíbrio = menor preço sem prejuízo: custo pleno ÷ (1 − alíquota de impostos). P/ X% = preço que entrega a margem líquida-alvo informada no filtro: custo pleno ÷ (1 − impostos − margem-alvo). Compare com o preço de venda praticado.",
  trocas: "TROCAS E ESTOQUE — garrafas cedidas sem faturamento (trocas e amostras do período), com o custo pleno de cada uma, e a posição atual do estoque (foto do momento) com o valor em estoque.",
};

const FONTE: Record<string, { rot: string; cls: string; t: string }> = {
  real: { rot: "real", cls: "bg-emerald-50 text-emerald-700", t: "Consumo real de insumos lançado nas ordens de produção do período ÷ garrafas produzidas." },
  ficha: { rot: "ficha", cls: "bg-sky-50 text-sky-700", t: "Sem consumo lançado nas OPs do período: custo padrão pela ficha técnica (receita × custo atual de cada insumo)." },
  lote: { rot: "lote", cls: "bg-amber-50 text-amber-700", t: "Sem consumo lançado nem ficha técnica: custo unitário do lote em estoque." },
};

const INFO = {
  produzidas: "Garrafas das ordens de produção do período (pela data de produção), exceto OPs planejadas ou canceladas.",
  vendidas: "Garrafas vendidas = itens das NF-e de venda emitidas no período (regra oficial do Painel).",
  faturamento: "Valor dos produtos nas NF-e de venda do período (itens da nota). O total oficial da NF aparece no resumo.",
  preco: "Preço médio de venda realizado = Faturamento ÷ Garrafas vendidas.",
  mp: "Matéria-prima por garrafa (polpas, concentrados, frutas, açúcar).",
  emb: "Embalagem por garrafa (garrafa, tampa, rótulo, lacre).",
  insumos: "Custo direto de insumos por garrafa = matéria-prima + embalagem + outros insumos. A etiqueta mostra a origem: real (consumo nas OPs), ficha (ficha técnica) ou lote.",
  indireto: "Custos indiretos por garrafa: todas as despesas do período no Contas a Pagar (pessoal, salários, aluguel, energia, comerciais, administrativas, gerais, financeiras), exceto compras de matéria-prima/embalagem, rateadas por litro produzido × volume da garrafa.",
  pleno: "Custo pleno por garrafa = insumos + custos indiretos rateados.",
  imposto: "Impostos sobre vendas por garrafa = preço × alíquota efetiva do período (impostos sobre vendas do Contas a Pagar ÷ faturamento oficial).",
  lucro: "Lucro por garrafa = preço − impostos − custo pleno.",
  mc: "Margem de contribuição = (preço − impostos − insumos) ÷ preço. Quanto cada garrafa sobra para pagar a estrutura.",
  ml: "Margem líquida = lucro por garrafa ÷ preço, já com toda a estrutura rateada.",
  resultado: "Resultado do SKU no período = lucro por garrafa × garrafas vendidas.",
  equilibrio: "Preço de equilíbrio (lucro zero) = custo pleno ÷ (1 − alíquota de impostos).",
  alvo: "Preço sugerido para a margem-alvo = custo pleno ÷ (1 − alíquota de impostos − margem-alvo).",
  ta: "Garrafas cedidas em trocas/amostras no período (pipeline + amostras de leads). Custo = garrafas × custo pleno.",
  estoque: "Saldo atual de garrafas em lotes em uso (foto do momento) e o valor em estoque.",
};

export default function ProducaoFaturamento() {
  const hoje = hojeSP();
  const [inicio, setInicio] = useState<string>(hoje.slice(0, 8) + "01");
  const [fim, setFim] = useState<string>(hoje);
  const [alvoTxt, setAlvoTxt] = useState<string>("20");
  const alvo = Math.max(0, Math.min(90, Number(String(alvoTxt).replace(",", ".")) || 0)) / 100;
  const url = `/api/industria/dashboard-custo-pleno?inicio=${inicio}&fim=${fim}`;
  const { data, isLoading, isFetching, error } = useQuery<any>({ queryKey: [url], refetchInterval: 1800000, refetchOnWindowFocus: true, staleTime: 0 });

  // Atalhos de mês: de maio/2026 até o mês atual (1º ao último dia; o mês atual vai até hoje).
  const meses = useMemo(() => {
    const out: string[] = [];
    let [y, m] = [2026, 5];
    const [yh, mh] = hoje.split("-").map(Number);
    while (y < yh || (y === yh && m <= mh)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }, [hoje]);
  const escolherMes = (ym: string) => { setInicio(ym + "-01"); const u = ultimoDia(ym); setFim(u > hoje ? hoje : u); };
  const mesAtivo = meses.find((ym) => inicio === ym + "-01" && (fim === ultimoDia(ym) || (fim === hoje && hoje.startsWith(ym))));
  const setData = (qual: "i" | "f", v: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    let x = v < MIN_DATA ? MIN_DATA : v > hoje ? hoje : v;
    if (qual === "i") { setInicio(x); if (x > fim) setFim(x); } else { if (x < inicio) x = inicio; setFim(x); }
  };

  const rows: Row[] = data?.rows || [];
  const r900 = rows.filter((r) => r.tam === "900");
  const r350 = rows.filter((r) => r.tam === "350");
  const aliq = Number(data?.rateio?.aliquota_impostos) || 0;
  const periodoTxt = `${dataBR(inicio)} a ${dataBR(fim)}`;

  async function exportarExcel() {
    if (!data) return;
    const mod: any = await import("xlsx-js-style");
    const XLSX: any = mod.default ?? mod;
    const M2 = '"R$" #,##0.00', M0 = '"R$" #,##0', PC = '0.0%', IN = '#,##0';
    const bd = { style: "thin", color: { rgb: "D1D5DB" } };
    const B = { top: bd, bottom: bd, left: bd, right: bd };
    const sTitle = { font: { bold: true, sz: 14, color: { rgb: "0F5132" } } };
    const sSub = { font: { sz: 9, color: { rgb: "6B7280" } } };
    const sHead = { font: { bold: true, sz: 10, color: { rgb: "374151" } }, fill: { patternType: "solid", fgColor: { rgb: "F1F5F9" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: B };
    const T = (v: any, ex: any = {}) => ({ v: v == null ? "" : String(v), t: "s", s: { alignment: { vertical: "center" }, border: B, ...ex } });
    const N = (v: any, z: string, ex: any = {}) => (v == null || !isFinite(Number(v)) ? { v: "—", t: "s", s: { alignment: { horizontal: "right" }, border: B, ...ex } } : { v: Number(v), t: "n", z, s: { alignment: { horizontal: "right" }, numFmt: z, border: B, ...ex } });
    const fill = (rgb: string, white = false) => ({ fill: { patternType: "solid", fgColor: { rgb } }, font: { bold: true, ...(white ? { color: { rgb: "FFFFFF" } } : {}) } });
    const HEAD = ["Sabor", "Emb.", "Produzidas", "Vendidas", "Faturamento", "Preço venda", "Matéria-prima/un", "Embalagem/un", "Insumos/un", "Origem insumos", "Indireto/un", "Custo pleno/un", "Impostos/un", "Lucro/un", "Margem contrib.", "Margem líquida", "Resultado", "Preço equilíbrio", `Preço p/ ${Math.round(alvo * 100)}%`, "Trocas/Amostras", "Custo T/A", "Estoque", "Custo estoque"];
    const NC = HEAD.length;
    const aoa: any[][] = [];
    const linha = (cells: any[]) => { const r = Array.from({ length: NC }, () => T("")); cells.forEach((c, i) => (r[i] = c)); aoa.push(r); };
    linha([{ v: "Produção & Faturamento — custo pleno por SKU", t: "s", s: sTitle }]);
    linha([{ v: `Período: ${periodoTxt} · custos indiretos rateados por litro ${data.rateio?.base === "produzidos" ? "produzido" : "vendido"} (${brl(data.rateio?.custo_litro)}/litro) · alíquota efetiva de impostos ${pct(aliq)}`, t: "s", s: sSub }]);
    linha([]);
    aoa.push(HEAD.map((h) => ({ v: h, t: "s", s: sHead })));
    const dataRow = (r: Row) => linha([
      T(cap(r.sabor)), T(r.tam + "ml"), N(r.produzidas, IN), N(r.vendidas, IN), N(r.faturamento, M0), N(r.preco, M2),
      N(r.mp_un, M2), N(r.emb_un, M2), N(r.insumos_un, M2), T(r.fonte_insumos || "—"), N(r.indireto_un, M2), N(r.custo_pleno_un, M2),
      N(r.preco != null ? r.imposto_un : null, M2), N(r.lucro_un, M2), N(r.margem_contrib, PC), N(r.margem_liquida, PC), N(r.resultado, M0),
      N(r.preco_equilibrio, M2), N(precoAlvo(r.custo_pleno_un, aliq, alvo), M2), N(r.trocas_amostras, IN), N(r.custo_ta, M0), N(r.estoque, IN), N(r.custo_estoque, M0),
    ]);
    const subRow = (rot: string, s: any, ex: any) => {
      const preco = s.vendidas > 0 ? s.faturamento / s.vendidas : null;
      linha([
        T(rot, ex), T("", ex), N(s.produzidas, IN, ex), N(s.vendidas, IN, ex), N(s.faturamento, M0, ex), N(preco, M2, ex),
        T("", ex), T("", ex), N(s.vendidas > 0 ? s.insumos_vendidas / s.vendidas : null, M2, ex), T("", ex),
        N(s.vendidas > 0 ? s.indireto_vendidas / s.vendidas : null, M2, ex), N(s.vendidas > 0 ? (s.insumos_vendidas + s.indireto_vendidas) / s.vendidas : null, M2, ex),
        N(s.vendidas > 0 ? s.impostos_vendidas / s.vendidas : null, M2, ex), N(s.vendidas > 0 ? s.resultado / s.vendidas : null, M2, ex),
        N(s.faturamento > 0 ? (s.faturamento - s.impostos_vendidas - s.insumos_vendidas) / s.faturamento : null, PC, ex),
        N(s.faturamento > 0 ? s.resultado / s.faturamento : null, PC, ex), N(s.resultado, M0, ex), T("", ex), T("", ex),
        N(s.trocas_amostras, IN, ex), N(s.custo_ta, M0, ex), N(s.estoque, IN, ex), N(s.custo_estoque, M0, ex),
      ]);
    };
    r900.forEach(dataRow); subRow("Subtotal 900 ml", data.sub900, fill("EEF2F7"));
    r350.forEach(dataRow); subRow("Subtotal 350 ml", data.sub350, fill("EEF2F7"));
    subRow("TOTAL", data.total, fill("059669", true));
    linha([]);
    const D = data.dre || {};
    linha([{ v: "Resultado gerencial do período", t: "s", s: { font: { bold: true, sz: 11, color: { rgb: "047857" } } } }]);
    const dl = (rot: string, v: any, bold = false) => linha([T(rot, bold ? { font: { bold: true } } : {}), T(""), T(""), T(""), N(v, M2, bold ? { font: { bold: true } } : {}), N(D.faturamento_oficial > 0 ? Number(v) / D.faturamento_oficial : null, PC)]);
    dl("Faturamento (NF-e oficial)", D.faturamento_oficial, true);
    dl("(−) Impostos sobre vendas", -D.impostos);
    dl("(−) Insumos das garrafas vendidas", -D.insumos_vendidas);
    dl("= Margem de contribuição", D.margem_contribuicao, true);
    for (const g of (data.despesas?.grupos || [])) dl("(−) " + g.nome, -g.total);
    dl("= Resultado do período", D.resultado, true);
    linha([]);
    linha([{ v: "Despesas por conta (Contas a Pagar, pela data de emissão do título)", t: "s", s: { font: { bold: true, sz: 11, color: { rgb: "047857" } } } }]);
    for (const g of (data.despesas?.grupos || [])) {
      linha([T(g.nome, { font: { bold: true } }), T(""), T(""), T(""), N(g.total, M2, { font: { bold: true } })]);
      for (const c of g.contas) linha([T("   " + c.nome), T(""), T(""), N(c.qtd, IN), N(c.valor, M2)]);
    }
    const ws: any = {};
    for (let r = 0; r < aoa.length; r++) for (let c = 0; c < NC; c++) if (aoa[r][c]) ws[XLSX.utils.encode_cell({ r, c })] = aoa[r][c];
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: NC - 1 } });
    ws["!cols"] = [{ wch: 30 }, { wch: 7 }, ...Array.from({ length: NC - 2 }, () => ({ wch: 12 }))];
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: NC - 1 } }];
    ws["!freeze"] = { xSplit: 0, ySplit: 4 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Custo pleno por SKU");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const u = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a");
    a.href = u; a.download = `producao-faturamento-${inicio}_a_${fim}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }

  const cell = "px-2.5 py-2 text-right tabular-nums whitespace-nowrap";
  const th = "px-2.5 py-2 text-right text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold whitespace-nowrap";
  const thG = (cls: string) => th + " " + cls;
  const vazio = <span className="text-gray-300">—</span>;
  const M = ({ v, n = 2 }: { v: number | null | undefined; n?: 0 | 2 }) => v == null || !isFinite(v) ? vazio : <>{n === 0 ? brl0(v) : brl(v)}</>;
  const Pc = ({ m }: { m: number | null | undefined }) => m == null || !isFinite(m) ? vazio
    : <span className={m < 0 ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}>{pct(m)}</span>;
  const Lucro = ({ v, n = 2 }: { v: number | null | undefined; n?: 0 | 2 }) => v == null || !isFinite(v) ? vazio
    : <span className={v < 0 ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}>{n === 0 ? brl0(v) : brl(v)}</span>;

  // Faixas por assunto: cada grupo de colunas tem a sua cor (cabeçalho forte, células claras)
  // e uma divisória grossa na primeira coluna do grupo, de cima a baixo da tabela.
  const GC: Record<string, { hd: string; th: string; td: string; b: string; bt: string }> = {
    vol: { hd: "bg-gray-100 text-gray-700", th: "bg-white text-gray-500", td: "", b: "", bt: "" },
    dir: { hd: "bg-orange-200 text-orange-900", th: "bg-orange-100 text-orange-800", td: "bg-orange-50", b: "border-l-2 border-l-orange-400", bt: "border-l-2 border-l-white/60" },
    est: { hd: "bg-violet-200 text-violet-900", th: "bg-violet-100 text-violet-800", td: "bg-violet-50", b: "border-l-2 border-l-violet-400", bt: "border-l-2 border-l-white/60" },
    res: { hd: "bg-emerald-200 text-emerald-900", th: "bg-emerald-100 text-emerald-800", td: "bg-emerald-50/70", b: "border-l-2 border-l-emerald-500", bt: "border-l-2 border-l-white/60" },
    pre: { hd: "bg-sky-200 text-sky-900", th: "bg-sky-100 text-sky-800", td: "bg-sky-50", b: "border-l-2 border-l-sky-400", bt: "border-l-2 border-l-white/60" },
    tro: { hd: "bg-gray-200 text-gray-700", th: "bg-gray-100 text-gray-600", td: "bg-gray-50", b: "border-l-2 border-l-gray-400", bt: "border-l-2 border-l-white/60" },
  };
  const COLG = ["vol", "vol", "vol", "vol", "vol", "vol", "dir", "dir", "dir", "est", "est", "res", "res", "res", "res", "res", "pre", "pre", "tro", "tro", "tro", "tro"];
  const inicioGrupo = (i: number) => i > 0 && COLG[i] !== COLG[i - 1];
  // Classe da célula i: fundo do grupo (só nas linhas de SKU) + divisória no início do grupo.
  const cg = (i: number, modo: "td" | "sub" | "tot" = "td") => {
    const g = GC[COLG[i]];
    const borda = inicioGrupo(i) ? (modo === "tot" ? g.bt : g.b) : "";
    return " " + (modo === "td" ? g.td : "") + " " + borda;
  };
  const Celulas = ({ itens, modo }: { itens: { c: any; cls?: string; title?: string }[]; modo: "td" | "sub" | "tot" }) => (
    <>{itens.map((it, i) => <td key={i} title={it.title} className={(it.cls ?? cell) + cg(i, modo)}>{it.c}</td>)}</>
  );

  const DataRow = ({ r }: { r: Row }) => {
    const f = r.fonte_insumos ? FONTE[r.fonte_insumos] : null;
    const itens = [
      { c: cap(r.sabor), cls: "px-2.5 py-2 text-left font-medium whitespace-nowrap sticky left-0 bg-white" },
      { c: <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-600">{r.tam}ml</span>, cls: "px-2.5 py-2 text-left" },
      { c: nf(r.produzidas) }, { c: nf(r.vendidas) }, { c: brl0(r.faturamento) },
      { c: <M v={r.preco} />, cls: cell + " font-semibold" },
      { c: <M v={r.fonte_insumos ? r.mp_un : null} /> },
      { c: <M v={r.fonte_insumos ? r.emb_un : null} /> },
      { c: <><M v={r.fonte_insumos ? r.insumos_un : null} />{f && <span title={f.t} className={"ml-1 text-[9px] font-semibold px-1 py-px rounded " + f.cls}>{f.rot}</span>}</>, cls: cell + " font-semibold text-orange-900",
        title: r.outros_un ? "Inclui outros insumos: " + brl(r.outros_un) + "/un" + (r.insumos_padrao_un != null ? " · ficha técnica: " + brl(r.insumos_padrao_un) : "") : (r.insumos_padrao_un != null ? "Ficha técnica: " + brl(r.insumos_padrao_un) : "") },
      { c: <M v={r.indireto_un} /> },
      { c: <M v={r.custo_pleno_un} />, cls: cell + " font-bold text-violet-900" },
      { c: <M v={r.preco != null ? r.imposto_un : null} /> },
      { c: <Lucro v={r.lucro_un} /> }, { c: <Pc m={r.margem_contrib} /> }, { c: <Pc m={r.margem_liquida} /> },
      { c: <Lucro v={r.vendidas ? r.resultado : null} n={0} /> },
      { c: <M v={r.custo_pleno_un ? r.preco_equilibrio : null} /> },
      { c: <M v={r.custo_pleno_un ? precoAlvo(r.custo_pleno_un, aliq, alvo) : null} />, cls: cell + " font-bold text-sky-800" },
      { c: nf(r.trocas_amostras), cls: cell + " text-gray-600" }, { c: brl0(r.custo_ta), cls: cell + " text-gray-600" },
      { c: nf(r.estoque), cls: cell + " text-gray-600" }, { c: brl0(r.custo_estoque), cls: cell + " text-gray-600" },
    ];
    return <tr className="border-b border-gray-200/70 hover:brightness-[0.97]"><Celulas itens={itens} modo="td" /></tr>;
  };
  const SubRow = ({ rot, s, total }: { rot: string; s: any; total?: boolean }) => {
    const v = s?.vendidas || 0, fat = s?.faturamento || 0;
    const un = (x: number) => (v > 0 ? x / v : null);
    const cls = total ? "bg-emerald-600 text-white font-bold border-t-4 border-emerald-800" : "bg-slate-100 font-semibold text-slate-800 border-y-2 border-slate-300";
    const sticky = total ? "bg-emerald-600" : "bg-slate-100";
    const neg = (x: number | null) => (total ? "" : x != null && x < 0 ? " text-rose-600" : "");
    const mc = fat > 0 ? (fat - s.impostos_vendidas - s.insumos_vendidas) / fat : null;
    const ml = fat > 0 ? s.resultado / fat : null;
    const itens = [
      { c: total ? "TOTAL" : <span className="border-l-4 border-slate-400 pl-2">{rot}</span>, cls: "px-2.5 py-2 text-left whitespace-nowrap sticky left-0 " + sticky },
      { c: "", cls: "" },
      { c: nf(s?.produzidas) }, { c: nf(v) }, { c: brl0(fat) }, { c: un(fat) != null ? brl(un(fat)) : "—" },
      { c: "", cls: "" }, { c: "", cls: "" },
      { c: un(s?.insumos_vendidas) != null ? brl(un(s.insumos_vendidas)) : "—" },
      { c: un(s?.indireto_vendidas) != null ? brl(un(s.indireto_vendidas)) : "—" },
      { c: v > 0 ? brl((s.insumos_vendidas + s.indireto_vendidas) / v) : "—" },
      { c: un(s?.impostos_vendidas) != null ? brl(un(s.impostos_vendidas)) : "—" },
      { c: un(s?.resultado) != null ? brl(un(s.resultado)) : "—", cls: cell + neg(un(s?.resultado)) },
      { c: pct(mc), cls: cell + neg(mc) }, { c: pct(ml), cls: cell + neg(ml) },
      { c: brl0(s?.resultado), cls: cell + neg(s?.resultado) },
      { c: "", cls: "" }, { c: "", cls: "" },
      { c: nf(s?.trocas_amostras) }, { c: brl0(s?.custo_ta) }, { c: nf(s?.estoque) }, { c: brl0(s?.custo_estoque) },
    ];
    return <tr className={cls}><Celulas itens={itens} modo={total ? "tot" : "sub"} /></tr>;
  };

  const D = data?.dre || {};
  const fatO = Number(D.faturamento_oficial) || 0;
  const pf = (v: number) => (fatO > 0 ? pct(v / fatO) : "—");
  const Kpi = ({ rot, v, sub, cor = "text-gray-900" }: { rot: string; v: string; sub?: string; cor?: string }) => (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">{rot}</div>
      <div className={"text-xl font-bold tabular-nums " + cor}>{v}</div>
      {sub && <div className="text-[11px] text-gray-500 tabular-nums">{sub}</div>}
    </div>
  );

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">Produção &amp; Faturamento — custo pleno por SKU</h2>
          <p className="text-xs text-gray-500">Matéria-prima e embalagem das ordens de produção, todos os custos e despesas do Contas a Pagar (pessoal, aluguel, energia, comerciais, administrativas...) rateados por litro, e impostos sobre vendas. Período {periodoTxt}{data?.generatedAt ? " · atualizado em " + new Date(data.generatedAt).toLocaleString("pt-BR") : ""}{isFetching ? " · atualizando…" : ""}.</p>
        </div>
        <button type="button" onClick={exportarExcel} disabled={!data} title="Exportar o período para Excel (.xlsx)"
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-600 text-emerald-700 hover:bg-emerald-600 hover:text-white transition-colors disabled:opacity-50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          Exportar para Excel
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-200 bg-white px-3 py-2" data-testid="pf-filtro">
        <div className="flex items-center gap-1.5 text-xs text-gray-600">
          <span className="font-semibold">Período</span>
          <input type="date" value={inicio} min={MIN_DATA} max={hoje} onChange={(e) => setData("i", e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-xs" data-testid="pf-inicio" />
          <span>a</span>
          <input type="date" value={fim} min={inicio} max={hoje} onChange={(e) => setData("f", e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-xs" data-testid="pf-fim" />
        </div>
        <div className="flex gap-1 flex-wrap">
          {meses.map((ym) => (
            <button key={ym} type="button" onClick={() => escolherMes(ym)} title={`${MESES_LONGO[Number(ym.slice(5))]}/${ym.slice(0, 4)}: dia 1º ao último dia`}
              className={"text-[11px] font-semibold px-2.5 py-1 rounded-full border " + (mesAtivo === ym ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-300 text-gray-500 hover:text-gray-800")}>
              {MESES[Number(ym.slice(5))]}/{ym.slice(2, 4)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 ml-auto" title={INFO.alvo}>
          <span className="font-semibold">Margem-alvo</span>
          <input type="number" min={0} max={90} step={1} value={alvoTxt} onChange={(e) => setAlvoTxt(e.target.value)} className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-right" data-testid="pf-alvo" />
          <span>%</span>
        </label>
      </div>

      {isLoading ? <div className="text-sm text-gray-500">Carregando custos do período…</div>
        : error ? <div className="text-sm text-red-600">Erro ao carregar: {String((error as any)?.message || error)}</div>
        : !data ? null : (<>
          <Card><CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Kpi rot="Faturamento (NF-e)" v={brl0(fatO)} sub={`${nf(data.total?.vendidas)} garrafas vendidas`} />
              <Kpi rot="Impostos s/ vendas" v={brl0(D.impostos)} sub={`alíquota efetiva ${pct(aliq)}`} />
              <Kpi rot="Insumos das vendidas" v={brl0(D.insumos_vendidas)} sub={`${pf(D.insumos_vendidas)} do faturamento`} />
              <Kpi rot="Custos indiretos" v={brl0(D.indiretos)} sub={`${brl(data.rateio?.custo_litro)} por litro ${data.rateio?.base === "produzidos" ? "produzido" : "vendido"}`} />
              <Kpi rot="Resultado do período" v={brl0(D.resultado)} sub={`${pf(D.resultado)} do faturamento`} cor={Number(D.resultado) < 0 ? "text-rose-600" : "text-emerald-700"} />
            </div>
          </CardContent></Card>

          <Card><CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ minWidth: 1900 }}>
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide">
                    {([["vol", 6, "Volume e receita", GRUPO.volume], ["dir", 3, "Custo direto (insumos) por garrafa", GRUPO.direto], ["est", 2, "Estrutura rateada", GRUPO.estrutura],
                      ["res", 5, "Resultado", GRUPO.resultado], ["pre", 2, "Preço de venda", GRUPO.preco], ["tro", 4, "Trocas e estoque", GRUPO.trocas]] as const).map(([k, n, rot, t], gi) => (
                      <th key={k} colSpan={n} className={"py-1.5 px-2.5 font-bold " + GC[k].hd + (gi === 0 ? " text-left sticky left-0" : " text-center " + GC[k].b)}>{rot}<Info t={t} /></th>
                    ))}
                  </tr>
                  <tr className="border-b-2 border-gray-300">
                    {([["Sabor", null], ["Emb.", null], ["Produzidas", INFO.produzidas], ["Vendidas", INFO.vendidas], ["Faturamento", INFO.faturamento], ["Preço venda", INFO.preco],
                      ["Mat.-prima", INFO.mp], ["Embalagem", INFO.emb], ["Insumos/un", INFO.insumos], ["Indireto/un", INFO.indireto], ["Custo pleno", INFO.pleno],
                      ["Impostos/un", INFO.imposto], ["Lucro/un", INFO.lucro], ["Marg. contrib.", INFO.mc], ["Marg. líquida", INFO.ml], ["Resultado", INFO.resultado],
                      ["Equilíbrio", INFO.equilibrio], [`P/ ${Math.round(alvo * 100)}%`, INFO.alvo], ["Trocas/Am.", INFO.ta], ["Custo T/A", null], ["Estoque", INFO.estoque], ["Custo estoque", null]] as [string, string | null][]).map(([rot, t], i) => (
                      <th key={i} className={(i < 2 ? "px-2.5 py-2 text-left text-[10.5px] uppercase tracking-wide font-semibold " : th + " ") + GC[COLG[i]].th + (i === 0 ? " sticky left-0" : "") + (inicioGrupo(i) ? " " + GC[COLG[i]].b : "")}>{rot}{t && <Info t={t} />}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r900.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
                  <SubRow rot="Subtotal 900 ml" s={data.sub900} />
                  {r350.map((r) => <DataRow key={r.sabor + r.tam} r={r} />)}
                  <SubRow rot="Subtotal 350 ml" s={data.sub350} />
                  <SubRow rot="TOTAL" s={data.total} total />
                </tbody>
              </table>
            </div>
          </CardContent></Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card><CardContent className="p-4 space-y-1.5 text-sm">
              <div className="font-semibold text-gray-800 mb-1">Resultado gerencial do período</div>
              {[
                ["Faturamento (NF-e oficial)", fatO, true],
                ["(−) Impostos sobre vendas", -D.impostos, false],
                ["= Receita líquida", D.receita_liquida, true],
                ["(−) Insumos das garrafas vendidas", -D.insumos_vendidas, false],
                ["= Margem de contribuição", D.margem_contribuicao, true],
                ...((data.despesas?.grupos || []).map((g: any) => ["(−) " + g.nome, -g.total, false])),
                ["= Resultado do período", D.resultado, true],
              ].map(([rot, v, b]: any, i: number) => (
                <div key={i} className={"flex justify-between gap-3 " + (b ? "font-semibold border-t border-gray-100 pt-1" : "text-gray-600")}>
                  <span className="min-w-0">{rot}</span>
                  <span className={"tabular-nums whitespace-nowrap " + (Number(v) < 0 && b ? "text-rose-600" : "")}>{brl(v)} <span className="text-[11px] text-gray-400 font-normal">{pf(Number(v))}</span></span>
                </div>
              ))}
              <p className="text-[11px] text-gray-400 pt-2">Todas as despesas do período entram aqui, mesmo as que ficaram nas garrafas ainda em estoque. Trocas/amostras custaram {brl0(D.custo_ta)} no período (já dentro dos custos acima).</p>
            </CardContent></Card>

            <Card><CardContent className="p-4 text-sm">
              <div className="font-semibold text-gray-800 mb-1">Custos e despesas indiretos (Contas a Pagar)</div>
              <p className="text-[11px] text-gray-500 mb-2">Pela data de emissão do título no Contas a Pagar. Rateio: {brl(data.rateio?.custo_litro)} por litro {data.rateio?.base === "produzidos" ? "produzido" : "vendido"} ({nf(Math.round(data.rateio?.litros || 0))} litros).</p>
              {(data.despesas?.grupos || []).length === 0 && <div className="text-xs text-gray-400">Nenhuma despesa lançada no período.</div>}
              {(data.despesas?.grupos || []).map((g: any) => (
                <details key={g.key} className="border-b border-gray-100 py-1">
                  <summary className="flex justify-between gap-3 cursor-pointer list-none">
                    <span className="min-w-0 text-gray-700">▸ {g.nome}</span>
                    <span className="tabular-nums whitespace-nowrap font-semibold">{brl0(g.total)} <span className="text-[11px] text-gray-400 font-normal">{pf(g.total)}</span></span>
                  </summary>
                  <div className="pl-4 py-1 space-y-0.5">
                    {g.contas.map((c: any, i: number) => (
                      <div key={i} className="flex justify-between gap-3 text-xs text-gray-600">
                        <span className="min-w-0 truncate" title={c.nome}>{c.nome} <span className="text-gray-400">({c.qtd})</span></span>
                        <span className="tabular-nums whitespace-nowrap">{brl(c.valor)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
              <div className="flex justify-between gap-3 pt-1.5 font-semibold"><span>Total indireto</span><span className="tabular-nums">{brl0(data.despesas?.indiretos)}</span></div>
              <div className="text-[11px] text-gray-400 pt-2 space-y-0.5">
                <div>Fora do rateio: compras de matéria-prima/embalagem {brl0(data.despesas?.compras_insumos)} (o insumo entra pelo consumo nas OPs, para não contar duas vezes){Number(data.despesas?.fora_dre) ? `; contas marcadas fora da DRE ${brl0(data.despesas.fora_dre)}` : ""}.</div>
              </div>
            </CardContent></Card>

            <Card><CardContent className="p-4 text-sm">
              <div className="font-semibold text-gray-800 mb-1">Matéria-prima consumida nas OPs</div>
              <p className="text-[11px] text-gray-500 mb-2">Consumo e perdas lançados nas ordens de produção de garrafa no período, pelo custo do movimento.</p>
              {(data.insumos?.lista || []).length === 0 && <div className="text-xs text-gray-400">Nenhum consumo de insumo lançado em OP no período — o custo por garrafa usa a ficha técnica ou o lote.</div>}
              <div className="space-y-0.5 max-h-72 overflow-y-auto">
                {(data.insumos?.lista || []).map((i: any, k: number) => (
                  <div key={k} className="flex justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate text-gray-700" title={i.nome}>
                      <span className={"inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle " + (i.grupo === "mp" ? "bg-orange-400" : i.grupo === "emb" ? "bg-sky-400" : "bg-gray-300")} />
                      {i.nome} <span className="text-gray-400">{nf(i.quantidade)} {i.unidade}</span>
                    </span>
                    <span className="tabular-nums whitespace-nowrap">{brl(i.valor)}{i.perda ? <span className="text-rose-500" title="Perdas"> · perda {brl0(i.perda)}</span> : null}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between gap-3 pt-1.5 font-semibold border-t border-gray-100 mt-1"><span>Total consumido</span><span className="tabular-nums">{brl0(data.insumos?.total)}</span></div>
              <div className="text-[11px] text-gray-400 pt-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 mr-1" />matéria-prima <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 mx-1" />embalagem <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-300 mx-1" />outros{Number(data.insumos?.consumo_intermediario) ? ` · OPs de polpa/intermediários: ${brl0(data.insumos.consumo_intermediario)} (entram nas garrafas pelo insumo gerado)` : ""}</div>
            </CardContent></Card>
          </div>

          <p className="text-[11px] text-gray-400">Método: custeio por absorção. Custo pleno por garrafa = insumos (consumo real nas OPs do período; sem lançamento, ficha técnica; sem ficha, custo do lote) + estrutura (todas as despesas do Contas a Pagar do período, exceto compras de insumos, rateadas por litro {data.rateio?.base === "produzidos" ? "produzido" : "vendido"} — a garrafa de 900 ml absorve 2,6× a de 350 ml). Impostos pela alíquota efetiva do período. Faturamento oficial das NF-e: {brl(fatO)}; soma dos itens por SKU: {brl(D.faturamento_itens)}. Estoque é a foto atual. Passe o mouse no <span className="font-semibold">i</span> de cada coluna para ver a regra.</p>
        </>)}
    </div>
  );
}
