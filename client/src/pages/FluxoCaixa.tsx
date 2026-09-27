import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { exportToExcel, ExportExcelButton } from "@/lib/tableTools";
import AccountEntriesModal from "@/components/AccountEntriesModal";

// FASE 5 - Fluxo de Caixa no MESMO formato/classificações da DRE, regime de caixa,
// por mês × conta. Clique numa linha abre os lançamentos (datas, contas, usuários).
const brl = (v: number) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const cell = (v: number) => (Math.abs(Number(v) || 0) < 0.005 ? "—" : brl(v));

export default function FluxoCaixa() {
  const hoje = new Date();
  const [year, setYear] = useState(hoje.getFullYear());
  const [conta, setConta] = useState("total");
  const [drill, setDrill] = useState<any>(null);
  const q = useQuery({
    queryKey: ["/api/financial/cashflow", year],
    queryFn: async () => (await fetch(`/api/financial/cashflow?year=${year}`, { credentials: "include" })).json(),
  });
  const d: any = q.data;
  const accounts: any[] = Array.isArray(d?.accounts) ? d.accounts : [];
  const months: string[] = Array.isArray(d?.months) ? d.months : ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const mode: string[] = Array.isArray(d?.mode) ? d.mode : [];
  const blk: any = d?.byAccount?.[conta] || { lines: [], computed: {} };
  const c: any = blk.computed || {};
  const lines: any[] = Array.isArray(blk.lines) ? blk.lines : [];
  const groupLines = (g: string) => lines.filter((l) => l.dreGroup === g);

  const saldoBase = useMemo(() => {
    if (conta === "total") return accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    if (conta === "sem_conta") return 0;
    return Number(accounts.find((a) => a.id === conta)?.balance || 0);
  }, [accounts, conta]);

  const saldoProj = useMemo(() => {
    const ll: number[] = c?.fluxoCaixaLiquido?.monthly || c?.lucroLiquido?.monthly || new Array(12).fill(0);
    const curM = typeof d?.curMonth === "number" ? d.curMonth : hoje.getMonth();
    const out: (number | null)[] = new Array(12).fill(null);
    let s = saldoBase;
    for (let i = 0; i < 12; i++) { if (i >= curM && curM >= 0 && curM <= 11) { s += ll[i]; out[i] = s; } }
    return out;
  }, [c, saldoBase, d]);

  const Z = new Array(12).fill(0);
  // dr: {accountId} | {group} | {special}  -> torna a linha clicável
  const R = (label: string, monthly: number[] = Z, total = 0, style: "total"|"highlight"|"deduction"|"normal"|"sub" = "normal", indent = false, dr: any = null) => {
    const base = style === "highlight" ? "bg-primary/10 font-bold" : style === "total" ? "bg-muted/60 font-semibold" : style === "sub" ? "text-muted-foreground" : "";
    const val = (v: number) => style === "deduction" ? (v ? `(${brl(v)})` : "—") : cell(v);
    const clickable = !!dr;
    return (
      <tr className={`border-b ${base} ${clickable ? "cursor-pointer hover:bg-accent/40" : ""}`} onClick={clickable ? () => setDrill({ ...dr, label, year }) : undefined}>
        <td className={`px-2 py-1 whitespace-nowrap sticky left-0 z-10 bg-inherit ${indent ? "pl-6 text-muted-foreground" : "font-medium"} ${clickable ? "underline decoration-dotted" : ""}`}>{label}</td>
        {(monthly || Z).map((v, i) => (<td key={i} className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{val(v)}</td>))}
        <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums font-semibold border-l">{val(total)}</td>
      </tr>
    );
  };

  const exportRows = () => {
    const rowsX: any[] = [];
    const push = (nome: string, m: number[] = Z, t = 0) => { const o: any = { Linha: nome }; months.forEach((mes, i) => o[mes] = m[i] || 0); o.Total = t; rowsX.push(o); };
    push("Receita Bruta (faturamento)", c.receitaBruta?.monthly, c.receitaBruta?.total);
    push("Receita Liquida", c.receitaLiquida?.monthly, c.receitaLiquida?.total);
    push("CPV", c.cpvTotal?.monthly, c.cpvTotal?.total);
    push("Lucro Bruto", c.lucroBruto?.monthly, c.lucroBruto?.total);
    push("EBITDA", c.ebitda?.monthly, c.ebitda?.total);
    push("Resultado Operacional (caixa)", c.lucroLiquido?.monthly, c.lucroLiquido?.total);
    push("Fluxo Liquido de Caixa", c.fluxoCaixaLiquido?.monthly, c.fluxoCaixaLiquido?.total);
    exportToExcel(rowsX, "fluxo-de-caixa-dre");
  };
  const has = (x: any) => x && (x.monthly || []).some((v: number) => Math.abs(v) > 0.005);

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-1">Fluxo de Caixa</h1>
      <p className="text-sm text-gray-500 mb-3">
        Mesmo formato/classificações da DRE, em regime de caixa. Passado = realizado (pagamento); mês corrente e futuros = previsto pelos títulos já lançados (vencimento).
        Movimentações não operacionais (amortização de empréstimos, aportes) entram no caixa mas não na DRE. Clique numa linha para ver os lançamentos.
      </p>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button data-testid="fluxo-ano-prev" className="border rounded px-2 py-1 text-sm" onClick={() => setYear((y) => y - 1)}>◀</button>
          <span className="font-semibold w-14 text-center">{year}</span>
          <button data-testid="fluxo-ano-next" className="border rounded px-2 py-1 text-sm" onClick={() => setYear((y) => y + 1)}>▶</button>
        </div>
        <select data-testid="fluxo-conta" className="border rounded px-2 py-1 text-sm bg-background" value={conta} onChange={(e) => setConta(e.target.value)}>
          <option value="total">Todas as contas (consolidado)</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="sem_conta">Sem conta vinculada</option>
        </select>
        <ExportExcelButton testId="export-fluxo" onClick={exportRows} />
      </div>

      <div className="border rounded-lg overflow-auto max-h-[78vh]">
        <table className="text-sm min-w-max">
          <thead>
            <tr className="border-b bg-background sticky top-0 z-20">
              <th className="px-2 py-2 text-left sticky left-0 bg-background z-30">Linha (regime de caixa)</th>
              {months.map((m, i) => (
                <th key={i} className="px-2 py-2 text-right whitespace-nowrap">{m}
                  <div className={`text-[10px] font-normal ${mode[i] === "realizado" ? "text-green-600" : mode[i] === "misto" ? "text-amber-600" : "text-blue-600"}`}>
                    {mode[i] === "realizado" ? "realizado" : mode[i] === "misto" ? "real+prev" : "previsto"}</div>
                </th>
              ))}
              <th className="px-2 py-2 text-right border-l">Total</th>
            </tr>
          </thead>
          <tbody>
            {R("Receita Bruta de Vendas (faturamento)", c.receitaBruta?.monthly, c.receitaBruta?.total, "total", false, { special: "faturamento" })}
            {R("(-) Devoluções/Descontos", c.devolucoes?.monthly, c.devolucoes?.total, "deduction", false, { group: "devolucoes" })}
            {R("(-) Impostos sobre Vendas", c.impostos?.monthly, c.impostos?.total, "deduction", false, { group: "impostos_vendas" })}
            {R("Receita Líquida", c.receitaLiquida?.monthly, c.receitaLiquida?.total, "highlight")}
            {groupLines("cpv").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(-) CPV", c.cpvTotal?.monthly, c.cpvTotal?.total, "total", false, { group: "cpv" })}
            {R("Lucro Bruto", c.lucroBruto?.monthly, c.lucroBruto?.total, "highlight")}
            {groupLines("despesas_comerciais").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(-) Despesas Comerciais", c.despesasComerciais?.monthly, c.despesasComerciais?.total, "total", false, { group: "despesas_comerciais" })}
            {groupLines("despesas_administrativas").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(-) Despesas Administrativas", c.despesasAdministrativas?.monthly, c.despesasAdministrativas?.total, "total", false, { group: "despesas_administrativas" })}
            {groupLines("despesas_gerais").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(-) Despesas Gerais", c.despesasGerais?.monthly, c.despesasGerais?.total, "total", false, { group: "despesas_gerais" })}
            {has(c.outrasReceitasDespesas) && groupLines("outras_receitas_despesas").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("EBITDA", c.ebitda?.monthly, c.ebitda?.total, "highlight")}
            {groupLines("receitas_financeiras").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(+) Receitas Financeiras", c.receitasFinanceiras?.monthly, c.receitasFinanceiras?.total, "normal", false, { group: "receitas_financeiras" })}
            {groupLines("despesas_financeiras").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("(-) Despesas Financeiras", c.despesasFinanceiras?.monthly, c.despesasFinanceiras?.total, "total", false, { group: "despesas_financeiras" })}
            {has(c.irpjCsll) && groupLines("irpj_csll").map((l) => R(l.name, l.monthly, l.total, "sub", true, { accountId: l.accountId }))}
            {R("= Resultado Operacional (caixa)", c.lucroLiquido?.monthly, c.lucroLiquido?.total, "highlight")}
            {groupLines("nao_operacional").length > 0 && R("Movimentações não operacionais (fora da DRE)", undefined, 0, "total")}
            {groupLines("nao_operacional").map((l) => R(l.name, l.monthly, l.total, l.type === "receita" ? "sub" : "deduction", true, { accountId: l.accountId }))}
            {R("= Fluxo Líquido de Caixa", c.fluxoCaixaLiquido?.monthly, c.fluxoCaixaLiquido?.total, "highlight")}
            <tr className="border-b bg-muted/60 font-semibold">
              <td className="px-2 py-1 whitespace-nowrap sticky left-0 z-10 bg-inherit">Saldo Projetado</td>
              {saldoProj.map((v, i) => (<td key={i} className={`px-2 py-1 text-right whitespace-nowrap tabular-nums ${v == null ? "text-gray-400" : v >= 0 ? "text-green-700" : "text-red-700"}`}>{v == null ? "—" : brl(v)}</td>))}
              <td className="px-2 py-1 border-l"></td>
            </tr>
            {q.isLoading && <tr><td colSpan={14} className="text-center text-gray-400 py-8">Carregando…</td></tr>}
            {!q.isLoading && lines.length === 0 && <tr><td colSpan={14} className="text-center text-gray-400 py-8">Sem lançamentos no período.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 mt-2">Saldo atual da(s) conta(s): {brl(saldoBase)}. O saldo projetado é exibido do mês corrente em diante e acumula o fluxo líquido de caixa.</p>
      {drill && <AccountEntriesModal drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
