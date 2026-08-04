// client/src/components/DashboardHistory.tsx
// Aba "Historico" do dashboard. Consome GET /api/dashboard2/history.
// Snapshot diario (faturamento efetivo do dia + por vendedor), reconciliado com a regra oficial.
import { useMemo } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brl0 = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(n) || 0);
const kbrl = (n: number) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace(".", ",") + "k" : String(Math.round(n)));

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function mesLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return MESES[Number(m) - 1] + "/" + y.slice(2);
}
function diaLabel(d: string): string {
  const dt = new Date(d + "T12:00:00");
  return d.split("-").reverse().join("/") + " (" + DOW[dt.getDay()] + ")";
}
function isoWeekKey(d: string): string {
  const dt = new Date(d + "T12:00:00");
  const day = (dt.getDay() + 6) % 7; // segunda = 0
  dt.setDate(dt.getDate() - day);
  return dt.toISOString().slice(0, 10);
}

type Snap = { date: string; daySales: number; sellers: { seller: string; total: number }[]; capturedAt?: string };

export default function DashboardHistory() {
  const { data } = useQuery<any>({ queryKey: ["/api/dashboard2/history"], refetchInterval: 1800000, refetchOnWindowFocus: true, staleTime: 0 });
  const snaps: Snap[] = useMemo(
    () => (data?.snapshots || []).map((s: any) => ({ date: s.date, daySales: Number(s.daySales) || 0, sellers: Array.isArray(s.sellers) ? s.sellers : [], capturedAt: s.capturedAt })),
    [data]
  );

  const months = useMemo(() => {
    const map: Record<string, { total: number; dias: number }> = {};
    for (const s of snaps) { (map[s.date.slice(0, 7)] = map[s.date.slice(0, 7)] || { total: 0, dias: 0 }); map[s.date.slice(0, 7)].total += s.daySales; map[s.date.slice(0, 7)].dias += 1; }
    return Object.keys(map).sort().map((k) => ({ ym: k, total: map[k].total, dias: map[k].dias }));
  }, [snaps]);

  const maxMonth = useMemo(() => months.reduce((a, m) => Math.max(a, m.total), 0) || 1, [months]);
  const curYm = months.length ? months[months.length - 1].ym : "";

  const fechamento = useMemo(() => {
    const arr = months.slice().reverse();
    return arr.map((m, i) => {
      const prev = arr[i + 1];
      const varPct = prev && prev.total > 0 ? ((m.total - prev.total) / prev.total) * 100 : null;
      return { ...m, varPct };
    });
  }, [months]);

  const daily = useMemo(() => {
    const asc = snaps.slice().sort((a, b) => a.date.localeCompare(b.date));
    const accMonth: Record<string, number> = {};
    const accWeek: Record<string, number> = {};
    const out: any[] = [];
    for (const s of asc) {
      const mk = s.date.slice(0, 7); const wk = isoWeekKey(s.date);
      accMonth[mk] = (accMonth[mk] || 0) + s.daySales;
      accWeek[wk] = (accWeek[wk] || 0) + s.daySales;
      out.push({ ...s, accMonth: accMonth[mk], accWeek: accWeek[wk] });
    }
    return out.reverse();
  }, [snaps]);

  const comparativo = useMemo(() => {
    const totals: Record<string, number> = {};
    const cell: Record<string, Record<string, number>> = {};
    for (const s of snaps) {
      const ym = s.date.slice(0, 7);
      for (const v of s.sellers) {
        const name = v.seller || "Sem vendedor"; const t = Number(v.total) || 0;
        totals[name] = (totals[name] || 0) + t;
        (cell[name] = cell[name] || {}); cell[name][ym] = (cell[name][ym] || 0) + t;
      }
    }
    const sellers = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    return { sellers, cols: months.map((m) => m.ym), cell };
  }, [snaps, months]);

  if (!data) return <div className="p-6 text-sm text-gray-400">Carregando histórico…</div>;
  if (!snaps.length) return <div className="p-6 text-sm text-gray-400">Ainda não há snapshots gravados. O histórico começa a preencher automaticamente.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Histórico do Faturamento Efetivo</h2>
        <p className="text-xs text-gray-500">Uma "foto" (snapshot) por dia dos números do dashboard — permite consultar qualquer data ou mês passado. Reconciliado com a regra oficial de faturamento (NF-e de venda).</p>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-600">Evolução mensal</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 h-48 pt-2">
            {months.map((m) => {
              const h = Math.max(4, Math.round((m.total / maxMonth) * 160));
              const cur = m.ym === curYm;
              return (
                <div key={m.ym} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div className="text-[10px] font-semibold text-gray-600 mb-1">{kbrl(m.total)}</div>
                  <div className="w-full max-w-[64px] rounded-t" style={{ height: h, backgroundColor: cur ? "#10b981" : "#6366f1" }} />
                  <div className="text-[11px] text-gray-500 mt-1">{mesLabel(m.ym)}{cur ? "*" : ""}</div>
                </div>
              );
            })}
          </div>
          <div className="text-[10px] text-gray-400 mt-2">* mês vigente (parcial). Barra verde = mês em andamento.</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-600">Fechamento mensal</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead><tr className="text-gray-500 text-xs border-b border-gray-200"><th className="text-left py-2">Mês</th><th className="text-right">Faturamento efetivo</th><th className="text-right">Variação</th><th className="text-right">Dias com nota</th></tr></thead>
            <tbody>
              {fechamento.map((m) => (
                <tr key={m.ym} className="border-b border-gray-100">
                  <td className="py-2 text-gray-800">{mesLabel(m.ym)}{m.ym === curYm ? " (vigente)" : ""}</td>
                  <td className="text-right tabular-nums font-medium text-gray-800">{brl(m.total)}</td>
                  <td className={"text-right tabular-nums " + (m.varPct === null ? "text-gray-400" : m.varPct >= 0 ? "text-green-600" : "text-red-600")}>{m.varPct === null ? "—" : (m.varPct >= 0 ? "+" : "") + m.varPct.toFixed(1) + "%"}</td>
                  <td className="text-right tabular-nums text-gray-600">{m.dias}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-600">Snapshots diários</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white"><tr className="text-gray-500 text-xs border-b border-gray-200"><th className="text-left py-2">Data</th><th className="text-right">Fat. do dia</th><th className="text-right">Acum. semana</th><th className="text-right">Acum. mês</th><th className="text-left pl-4">Top vendedor do dia</th></tr></thead>
              <tbody>
                {daily.map((s) => {
                  const top = s.sellers[0];
                  return (
                    <tr key={s.date} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 text-gray-800 whitespace-nowrap">{diaLabel(s.date)}</td>
                      <td className="text-right tabular-nums font-medium text-gray-800">{brl(s.daySales)}</td>
                      <td className="text-right tabular-nums text-gray-600">{brl(s.accWeek)}</td>
                      <td className="text-right tabular-nums text-gray-600">{brl(s.accMonth)}</td>
                      <td className="pl-4 text-gray-700 whitespace-nowrap">{top ? top.seller + " — " + brl0(top.total) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-600">Comparativo por vendedor — histórico</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white"><tr className="text-gray-500 text-xs border-b border-gray-200"><th className="text-left py-2">Vendedor</th>{comparativo.cols.map((c) => (<th key={c} className="text-right px-2 whitespace-nowrap">{mesLabel(c)}{c === curYm ? "*" : ""}</th>))}</tr></thead>
              <tbody>
                {comparativo.sellers.map((sv) => (
                  <tr key={sv} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 text-gray-800 whitespace-nowrap">{sv}</td>
                    {comparativo.cols.map((c) => { const val = comparativo.cell[sv]?.[c] || 0; return (<td key={c} className="text-right tabular-nums px-2 text-gray-700">{val ? brl0(val) : "—"}</td>); })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-gray-400 mt-2">* mês vigente (parcial). Valores = faturamento efetivo (NF-e de venda) atribuído a quem implantou o pedido.</div>
        </CardContent>
      </Card>
    </div>
  );
}
