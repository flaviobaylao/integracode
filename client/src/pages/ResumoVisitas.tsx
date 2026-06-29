import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Resumo de Visitas — paridade com o 1.0. Reusa /api/dashboard2/full (visitSummary
// por cliente) e a MESMA agregação por vendedor validada no dashboard de paridade.

type Visit = {
  date: string;
  isPast?: boolean;
  isScheduled?: boolean;
  hasVisit?: boolean;
  hasOrder?: boolean;
  hasVirtualAttendance?: boolean;
  orderValue?: number;
  metaValue?: number;
  nextSaleValue?: number;
};
type Row = { customerId: string; customerName: string; sellerId: string; sellerName: string; visits: Visit[] };

// janela = hoje + 3 dias úteis anteriores (America/Sao_Paulo)
function lVe() {
  const e = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const a = new Date(e + "T12:00:00Z");
  const s = [e];
  let r = 0;
  while (r < 3) {
    a.setUTCDate(a.getUTCDate() - 1);
    const n = a.getUTCDay();
    if (n >= 1 && n <= 5) { s.push(a.toISOString().slice(0, 10)); r++; }
  }
  s.sort();
  return { start: s[0], end: e, dates: s };
}

function statusColor(e: Visit): string {
  if (!e.isPast) return "future";
  if (e.hasVirtualAttendance && e.hasOrder) return "blue";
  if (e.hasVirtualAttendance && e.isScheduled) return "sky";
  if (e.hasVirtualAttendance && !e.isScheduled) return "teal";
  if (e.isScheduled && e.hasVisit && e.hasOrder) return "green";
  if (e.isScheduled && e.hasVisit && !e.hasOrder) return "yellow";
  if (!e.isScheduled && e.hasOrder) return "lilac";
  if (e.isScheduled && !e.hasVisit && e.hasOrder) return "orange";
  if (e.isScheduled && !e.hasVisit) return "red";
  return "future";
}
function expectedValue(e: Visit): number {
  if (e.isPast) return e.hasOrder ? (e.orderValue || 0) : (e.metaValue || 0);
  return e.isScheduled ? ((e.nextSaleValue || e.metaValue) || 0) : 0;
}

const money = (n: number) => (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function ResumoVisitas() {
  const { data, isLoading } = useQuery<{ visitSummary?: { rows?: Row[] } }>({
    queryKey: ["/api/dashboard2/full"],
    queryFn: () => fetch("/api/dashboard2/full", { credentials: "include", cache: "no-store" }).then((r) => r.json()),
  });

  const h = lVe();
  const validDates = new Set(h.dates);
  const map = new Map<string, any>();
  const rows: Row[] = data?.visitSummary?.rows || [];
  for (const n of rows) {
    const S = n.sellerId || "sem-vendedor";
    let w = map.get(S) || { sellerId: S, sellerName: n.sellerName || "Sem vendedor", completedVisits: 0, missedVisits: 0, orders: 0, revenue: 0, unmetRevenue: 0 };
    map.set(S, w);
    for (const v of (n.visits || [])) {
      if (!v.isPast || !validDates.has(v.date)) continue;
      const k = statusColor(v);
      if (k === "green" || k === "yellow") w.completedVisits++;
      else if (k === "orange" || k === "red") { w.missedVisits++; w.unmetRevenue += expectedValue(v); }
      if (v.hasOrder) { w.orders++; w.revenue += v.orderValue || 0; }
    }
  }
  const g = Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  const tot = g.reduce((acc, x) => ({
    orders: acc.orders + x.orders, completedVisits: acc.completedVisits + x.completedVisits,
    revenue: acc.revenue + x.revenue, missedVisits: acc.missedVisits + x.missedVisits, unmetRevenue: acc.unmetRevenue + x.unmetRevenue,
  }), { orders: 0, completedVisits: 0, revenue: 0, missedVisits: 0, unmetRevenue: 0 });

  const fmtD = (s: string) => { const p = s.split("-"); return `${p[2]}/${p[1]}`; };

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <i className="fas fa-calendar-check text-primary" /> Resumo de Visitas
        </h1>
        <p className="text-muted-foreground text-sm">
          Comparativo por vendedor — últimos 3 dias úteis + hoje. Período: {fmtD(h.start)} a {fmtD(h.end)}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Comparativo por Vendedor</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Carregando...</p>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-2">Vendedor</th>
                    <th className="p-2 text-right">Pedidos</th>
                    <th className="p-2 text-right">Visitas Efetivadas</th>
                    <th className="p-2 text-right">Fat. Visitas Efetivas</th>
                    <th className="p-2 text-right">Não Efetivadas</th>
                    <th className="p-2 text-right">Fat. Previsto Não Efetivado</th>
                  </tr>
                </thead>
                <tbody>
                  {g.map((s) => (
                    <tr key={s.sellerId} className="border-b hover:bg-muted/30">
                      <td className="p-2">{s.sellerName}</td>
                      <td className="p-2 text-right">{s.orders}</td>
                      <td className="p-2 text-right">{s.completedVisits}</td>
                      <td className="p-2 text-right">{money(s.revenue)}</td>
                      <td className="p-2 text-right">{s.missedVisits}</td>
                      <td className="p-2 text-right">{money(s.unmetRevenue)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold border-t-2">
                    <td className="p-2">Total</td>
                    <td className="p-2 text-right">{tot.orders}</td>
                    <td className="p-2 text-right">{tot.completedVisits}</td>
                    <td className="p-2 text-right">{money(tot.revenue)}</td>
                    <td className="p-2 text-right">{tot.missedVisits}</td>
                    <td className="p-2 text-right">{money(tot.unmetRevenue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
