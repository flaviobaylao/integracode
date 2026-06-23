// client/src/components/Dashboard.tsx
// PARIDADE 2.0 = 1.0 — reconstruido a partir da engenharia reversa do dashboard do 1.0 (jun/2026).
// Consome GET /api/dashboard2/full.

import { useMemo } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const brl = (n: any) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);

function fmtDateTime(ts: any): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (t: string) => fmt.find((p) => p.type === t)?.value || "";
  return `${get("day")}/${get("month")}, ${get("hour")}:${get("minute")}`;
}

function lastBusinessRange() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const a = new Date(today + "T12:00:00Z");
  const dates = [today];
  let r = 0;
  while (r < 3) { a.setUTCDate(a.getUTCDate() - 1); const dow = a.getUTCDay(); if (dow >= 1 && dow <= 5) { dates.push(a.toISOString().slice(0, 10)); r++; } }
  dates.sort();
  return { start: dates[0], end: today, dates };
}

function visitColor(v: any): string {
  if (!v.isPast) return "future";
  if (v.hasVirtualAttendance && v.hasOrder) return "blue";
  if (v.hasVirtualAttendance && v.isScheduled) return "sky";
  if (v.hasVirtualAttendance && !v.isScheduled) return "teal";
  if (v.isScheduled && v.hasVisit && v.hasOrder) return "green";
  if (v.isScheduled && v.hasVisit && !v.hasOrder) return "yellow";
  if (!v.isScheduled && v.hasOrder) return "lilac";
  if (v.isScheduled && !v.hasVisit && v.hasOrder) return "orange";
  if (v.isScheduled && !v.hasVisit) return "red";
  return "future";
}

function expectedValue(v: any): number {
  if (v.isPast) return v.hasOrder ? v.orderValue || 0 : v.metaValue || 0;
  return v.isScheduled ? (v.nextSaleValue || v.metaValue) || 0 : 0;
}

function monthLabel(d = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", month: "long", year: "numeric" }).format(d);
}

export default function Dashboard() {
  const { data } = useQuery<any>({ queryKey: ["/api/dashboard2/full"] });
  const range = useMemo(() => lastBusinessRange(), []);

  const stats = data?.stats || {};
  const ov = data?.ordersOverview || {};
  const vem = data?.vendasEfetivasMes || {};

  const sellers = useMemo(() => {
    const rows = data?.visitSummary?.rows;
    if (!Array.isArray(rows)) return [];
    const dset = new Set(range.dates);
    const map = new Map<string, any>();
    for (const N of rows) {
      const S = N.sellerId || "sem-vendedor";
      let w = map.get(S);
      if (!w) { w = { sellerId: S, sellerName: N.sellerName || "Sem vendedor", completedVisits: 0, missedVisits: 0, orders: 0, revenue: 0, unmetRevenue: 0 }; map.set(S, w); }
      for (const v of N.visits || []) {
        if (!v.isPast || !dset.has(v.date)) continue;
        const k = visitColor(v);
        if (k === "green" || k === "yellow") w.completedVisits++;
        else if (k === "orange" || k === "red") { w.missedVisits++; w.unmetRevenue += expectedValue(v); }
        if (v.hasOrder) { w.orders++; w.revenue += v.orderValue || 0; }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [data, range]);

  const totals = useMemo(() => sellers.reduce((t, s) => ({ orders: t.orders + s.orders, completedVisits: t.completedVisits + s.completedVisits, revenue: t.revenue + s.revenue, missedVisits: t.missedVisits + s.missedVisits, unmetRevenue: t.unmetRevenue + s.unmetRevenue }), { orders: 0, completedVisits: 0, revenue: 0, missedVisits: 0, unmetRevenue: 0 }), [sellers]);

  const today = Number(stats.todaySales) || 0;
  const yesterday = Number(stats.yesterdaySales) || 0;
  const pct = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : null;

  const blocked: any[] = ov.blocked || [];
  const aFaturar: any[] = ov.aFaturar || ov.unbilled || [];
  const nfsHoje: any[] = ov.nfsHoje || ov.todayInvoices || [];
  const sum = (arr: any[], f: string) => arr.reduce((a, x) => a + (Number(x[f]) || 0), 0);

  return (
    <div className="space-y-6 p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Vendas Hoje</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-800">{brl(today)}</div>
            <div className="text-xs mt-1">{pct === null ? (<span className="text-gray-400">-</span>) : (<span className={pct >= 0 ? "text-green-600" : "text-red-600"}>{pct >= 0 ? "+" : ""}{pct}% vs ontem</span>)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento da Semana</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-gray-800">{brl(stats.weekSales)}</div><div className="text-xs mt-1 text-gray-400">Semana vigente</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento do Mes</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-gray-800">{brl(stats.monthSales)}</div><div className="text-xs mt-1 text-gray-400">Mes vigente</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Precos (Grade)</CardTitle></CardHeader>
          <CardContent><a href="/price-tables" className="text-2xl font-bold text-green-700 hover:underline">Editar</a><div className="text-xs mt-1 text-gray-400">Consumidor Final + Instancias</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comparativo por Vendedor - ultimos 3 dias uteis + hoje</CardTitle>
          <div className="text-xs text-gray-500">Periodo: {range.start.split("-").reverse().join("/")} a {range.end.split("-").reverse().join("/")}</div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-2 pr-4 font-medium text-left">Vendedor</th>
                  <th className="py-2 px-3 font-medium text-right">Pedidos</th>
                  <th className="py-2 px-3 font-medium text-right">Visitas Efetivadas</th>
                  <th className="py-2 px-3 font-medium text-right">Faturamento Visitas Efetivas</th>
                  <th className="py-2 px-3 font-medium text-right">Nao Efetivadas</th>
                  <th className="py-2 pl-3 font-medium text-right">Faturamento Previsto Nao Efetivado</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((x) => (
                  <tr key={x.sellerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{x.sellerName}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{x.orders}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-green-700">{x.completedVisits}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-800">{brl(x.revenue)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-red-700">{x.missedVisits}</td>
                    <td className="py-2 pl-3 text-right tabular-nums font-semibold text-gray-500">{brl(x.unmetRevenue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-semibold text-gray-800">
                  <td className="py-2 pr-4">Total</td>
                  <td className="py-2 px-3 text-right tabular-nums">{totals.orders}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{totals.completedVisits}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{brl(totals.revenue)}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{totals.missedVisits}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{brl(totals.unmetRevenue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Vendas Efetivas do Mes</CardTitle>
            <div className="text-sm text-gray-600">{(vem.label || monthLabel())} - {brl(vem.value)}</div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pedidos e Notas Fiscais</CardTitle>
          <div className="text-xs text-gray-500">Bloqueados agora, ainda nao faturados e NFs emitidas hoje.</div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Column title="Bloqueados" color="red" count={blocked.length} total={sum(blocked, "total_amount")} items={blocked.map((b) => ({ name: b.customer_name || b.customerName || "-", sub: `Debito vencido - ${b.seller_name || b.sellerName || ""}`, when: fmtDateTime(b.blocked_at || b.blockedAt || b.created_at), value: b.total_amount ?? b.totalAmount }))} />
            <Column title="A faturar" color="yellow" count={aFaturar.length} total={sum(aFaturar, "sale_value")} items={aFaturar.map((p) => ({ name: p.customer_name || p.customerName || "-", sub: `Pedido - ${p.seller_name || p.sellerName || ""}`, when: fmtDateTime(p.created_at || p.createdAt), value: p.sale_value ?? p.saleValue }))} />
            <Column title="NFs emitidas hoje" color="green" count={nfsHoje.length} total={sum(nfsHoje, "total_invoice")} items={nfsHoje.map((n) => ({ name: n.customer_name || n.customerName || "-", sub: `NF ${n.invoice_number || n.invoiceNumber || ""} - ${n.seller_name || n.sellerName || ""}`, when: fmtDateTime(n.authorization_date || n.authorizationDate || n.emission_date), value: n.total_invoice ?? n.totalInvoice }))} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Column(props: { title: string; color: "red" | "yellow" | "green"; count: number; total: number; items: { name: string; sub: string; when: string; value: any }[]; }) {
  const head = props.color === "red" ? "bg-red-50 border-red-200 text-red-700" : props.color === "yellow" ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-green-50 border-green-200 text-green-700";
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className={`flex items-center justify-between px-3 py-2 border-b ${head}`}>
        <div className="flex items-center gap-2 font-medium"><span>{props.title}</span><Badge variant="secondary">{props.count}</Badge></div>
        <div className="font-semibold tabular-nums">{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(props.total) || 0)}</div>
      </div>
      <div className="max-h-80 overflow-y-auto divide-y">
        {props.items.length === 0 ? (<div className="px-3 py-4 text-xs text-gray-400">Nenhum item.</div>) : (props.items.map((it, i) => (
          <div key={i} className="px-3 py-2 flex items-start justify-between gap-2">
            <div className="min-w-0"><div className="text-sm font-medium text-gray-800 truncate">{it.name}</div><div className="text-xs text-gray-500 truncate">{it.sub}</div><div className="text-[11px] text-gray-400">{it.when}</div></div>
            <div className="text-sm font-semibold tabular-nums whitespace-nowrap">{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(it.value) || 0)}</div>
          </div>
        )))}
      </div>
    </div>
  );
}
