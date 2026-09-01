// client/src/components/DailyHistory.tsx
// Aba "Historico Diario" do dashboard. Mesma tabela do Comparativo por Vendedor do Painel,
// porem para MESES ANTERIORES (fechados), com filtro de mes. So realizado (sem projecoes).
// Fonte: GET /api/dashboard2/history (snapshot diario por vendedor, ja com escopo de carteira).
import { useMemo, useState, Fragment } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const intBR = (n: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(Math.round(n));
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DOWLBL = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

function mesLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return MESES[m - 1] + "/" + String(y).slice(2);
}

type DiaCell = { iso: string; dom: number; inMonth: boolean };
type Semana = { days: DiaCell[]; ini: number; fim: number };

function buildWeeks(ym: string): Semana[] {
  const [y, m] = ym.split("-").map(Number);
  const m0 = m - 1;
  const lastDay = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const first = new Date(Date.UTC(y, m0, 1));
  const firstDow = (first.getUTCDay() + 6) % 7; // 0=seg
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - firstDow);
  const weeks: Semana[] = [];
  const cur = new Date(start);
  while (true) {
    const days: DiaCell[] = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(cur);
      dt.setUTCDate(cur.getUTCDate() + i);
      const inMonth = dt.getUTCFullYear() === y && dt.getUTCMonth() === m0;
      days.push({ iso: dt.toISOString().slice(0, 10), dom: dt.getUTCDate(), inMonth });
    }
    const inDays = days.filter((d) => d.inMonth);
    weeks.push({ days, ini: inDays[0]?.dom || 0, fim: inDays[inDays.length - 1]?.dom || 0 });
    cur.setUTCDate(cur.getUTCDate() + 7);
    if (cur.getUTCFullYear() > y || (cur.getUTCFullYear() === y && cur.getUTCMonth() > m0)) break;
    if (cur.getUTCDate() > lastDay && cur.getUTCMonth() === m0) break;
  }
  return weeks;
}

export default function DailyHistory() {
  const { data } = useQuery<any>({ queryKey: ["/api/dashboard2/history"], refetchInterval: 1800000, refetchOnWindowFocus: true, staleTime: 0 });
  const snaps: any[] = useMemo(() => (data?.snapshots || []), [data]);

  // Mes corrente (America/Sao_Paulo) para excluir dos "meses fechados".
  const curMonth = useMemo(() => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(new Date());
    return p.slice(0, 7);
  }, []);

  // Meses disponiveis nos snapshots, apenas FECHADOS (< mes corrente), ultimos 12, mais recente primeiro.
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const s of snaps) if (s.date) set.add(String(s.date).slice(0, 7));
    return Array.from(set).filter((m) => m < curMonth).sort().reverse().slice(0, 12);
  }, [snaps, curMonth]);

  const [sel, setSel] = useState<string>("");
  const monthSel = sel && months.includes(sel) ? sel : (months[0] || "");

  const weeks = useMemo(() => (monthSel ? buildWeeks(monthSel) : []), [monthSel]);

  // seller -> iso -> valor  (do mes selecionado)
  const { sellers, valMap, dayTot, mesTot } = useMemo(() => {
    const valMap = new Map<string, Map<string, number>>();
    const dayTot = new Map<string, number>();
    const totBySeller = new Map<string, number>();
    for (const s of snaps) {
      const iso = String(s.date || "");
      if (iso.slice(0, 7) !== monthSel) continue;
      for (const r of (s.sellers || [])) {
        const name = String(r.seller || "Sem vendedor");
        const v = Number(r.total) || 0;
        if (!valMap.has(name)) valMap.set(name, new Map());
        const mm = valMap.get(name)!;
        mm.set(iso, (mm.get(iso) || 0) + v);
        dayTot.set(iso, (dayTot.get(iso) || 0) + v);
        totBySeller.set(name, (totBySeller.get(name) || 0) + v);
      }
    }
    const sellers = Array.from(totBySeller.entries()).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return { sellers, valMap, dayTot, mesTot: totBySeller };
  }, [snaps, monthSel]);

  const wkSum = (mp: Map<string, number> | undefined, wk: Semana) =>
    wk.days.reduce((a, d) => a + (d.inMonth && mp ? (mp.get(d.iso) || 0) : 0), 0);
  const mesSum = (mp: Map<string, number> | undefined) =>
    weeks.reduce((a, wk) => a + wkSum(mp, wk), 0);

  const cols = weeks.length * 8 + 2;

  if (!months.length) {
    return (
      <Card>
        <CardContent><div className="px-3 py-6 text-sm text-gray-500">Ainda não há histórico de meses anteriores para exibir.</div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base font-semibold">Histórico Diário — Comparativo por Vendedor</CardTitle>
            <div className="text-xs text-gray-500">Faturamento efetivo (NF-e de venda) por vendedor, dia a dia, de um mês fechado. Exclui devoluções, trocas, transferências, remessas, bonificações e amostras.</div>
          </div>
          <label className="text-sm text-gray-600 flex items-center gap-2">
            Mês:
            <select className="border rounded px-2 py-1 text-sm" value={monthSel} onChange={(e) => setSel(e.target.value)}>
              {months.map((m) => (<option key={m} value={m}>{mesLabel(m)}</option>))}
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr className="text-gray-600">
                <th className="sticky left-0 bg-white text-left px-2 py-1 border-b align-bottom" rowSpan={2}>Vendedor</th>
                {weeks.map((wk, wi) => (
                  <th key={wi} className="px-1 py-1 border-b border-l text-center font-medium" colSpan={8}>
                    Semana {wi + 1} ({wk.ini}-{wk.fim}/{monthSel.slice(5)})
                  </th>
                ))}
                <th className="px-2 py-1 border-b border-l text-right align-bottom" rowSpan={2}>Total Mensal</th>
              </tr>
              <tr className="text-gray-400">
                {weeks.map((wk, wi) => (
                  <Fragment key={"h" + wi}>
                    {wk.days.map((d, di) => (
                      <th key={wi + "-" + di} className={"px-1 py-1 border-b text-center font-normal " + (di === 0 ? "border-l" : "") + (!d.inMonth ? " text-gray-300" : "")}>{DOWLBL[di]}</th>
                    ))}
                    <th className="px-1 py-1 border-b text-right font-medium text-gray-500">Sem.</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {sellers.map((name) => {
                const mp = valMap.get(name);
                return (
                  <tr key={name} className="hover:bg-gray-50">
                    <td className="sticky left-0 bg-white px-2 py-1 border-b whitespace-nowrap font-medium text-gray-800">{name}</td>
                    {weeks.map((wk, wi) => (
                      <Fragment key={"b" + wi}>
                        {wk.days.map((d, di) => {
                          const v = d.inMonth && mp ? (mp.get(d.iso) || 0) : 0;
                          return (
                            <td key={wi + "-" + di} className={"px-1 py-1 border-b text-right tabular-nums " + (di === 0 ? "border-l" : "") + (d.inMonth ? "" : " bg-gray-50")}>{d.inMonth && v > 0 ? intBR(v) : ""}</td>
                          );
                        })}
                        <td className="px-1 py-1 border-b text-right tabular-nums font-medium text-gray-700 bg-gray-50">{brl(wkSum(mp, wk))}</td>
                      </Fragment>
                    ))}
                    <td className="px-2 py-1 border-b border-l text-right tabular-nums font-semibold whitespace-nowrap">{brl(mesSum(mp))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-gray-100">
                <td className="sticky left-0 bg-gray-100 px-2 py-1 border-t">Total</td>
                {weeks.map((wk, wi) => (
                  <Fragment key={"f" + wi}>
                    {wk.days.map((d, di) => {
                      const v = d.inMonth ? (dayTot.get(d.iso) || 0) : 0;
                      return (<td key={wi + "-" + di} className={"px-1 py-1 border-t text-right tabular-nums " + (di === 0 ? "border-l" : "")}>{d.inMonth && v > 0 ? intBR(v) : ""}</td>);
                    })}
                    <td className="px-1 py-1 border-t text-right tabular-nums">{brl(wk.days.reduce((a, d) => a + (d.inMonth ? (dayTot.get(d.iso) || 0) : 0), 0))}</td>
                  </Fragment>
                ))}
                <td className="px-2 py-1 border-t border-l text-right tabular-nums whitespace-nowrap">{brl(Array.from(mesTot.values()).reduce((a, b) => a + b, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="text-[11px] text-gray-400 mt-2">Colunas de dia em R$ sem centavos; subtotais semanais e total mensal em R$. Dias fora do mês aparecem em cinza. Somente valores realizados (sem projeções).</div>
      </CardContent>
    </Card>
  );
}
