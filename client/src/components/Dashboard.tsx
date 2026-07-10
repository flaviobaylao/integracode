// client/src/components/Dashboard.tsx
// PARIDADE 2.0 = 1.0. Consome GET /api/dashboard2/full.
// (05/jul/2026) Ajustes pedidos pelo Flavio:
//  1) "Vendas Hoje" compara com o MESMO DIA DA SEMANA ANTERIOR (seg x seg...).
//  2) "Comparativo por Vendedor" default = DIA VIGENTE; coluna "Pedidos" trocada
//     por "Clientes a atender no dia" (visitas planejadas/agendadas).
//  3) Filtro De/Ate SEMPRE dentro do mes vigente (vazio nao aplica; default = hoje).
//  4) Cabecalho da tabela CONGELADO na rolagem (sticky).
//  5) Filtro de VENDEDOR no cabecalho de "Pedidos e Notas Fiscais" (filtra as 3 colunas).
// Requer no backend /api/dashboard2/full:
//  - stats.lastWeekSameDaySales (soma de vendas de hoje-7)
//  - visitSummary cobrindo o MES VIGENTE (dia 1 -> fim do mes) p/ o filtro funcionar.

import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useActiveSellers, MultiSelect, multiMatch } from "@/lib/tableTools";

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

function todayBRT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function monthBounds() {
  const t = todayBRT();
  const [y, m] = t.split("-");
  const first = `${y}-${m}-01`;
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const last = `${y}-${m}-${String(lastDay).padStart(2, "0")}`;
  return { first, last, today: t };
}

function datesInRange(start: string, end: string): string[] {
  if (!start || !end || start > end) return [];
  const out: string[] = [];
  const d = new Date(start + "T12:00:00Z");
  const e = new Date(end + "T12:00:00Z");
  while (d.getTime() <= e.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
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

const brDate = (iso: string) => (iso ? iso.split("-").reverse().join("/") : "");

export default function Dashboard() {
  const { data } = useQuery<any>({ queryKey: ["/api/dashboard2/full"] });
  const bounds = useMemo(() => monthBounds(), []);
  const [start, setStart] = useState<string>(bounds.today);
  const [end, setEnd] = useState<string>(bounds.today);
  const { sellerOptions, sellerGroups, resolveSeller } = useActiveSellers();
  const [pnfSeller, setPnfSeller] = useState<string[]>([]);
  const [modal, setModal] = useState<{ title: string; names: string[] } | null>(null);

  const stats = data?.stats || {};
  const ov = data?.ordersOverview || {};
  const vem = data?.vendasEfetivasMes || {};

  const dates = useMemo(() => datesInRange(start, end), [start, end]);

  const sellers = useMemo(() => {
    const rows = data?.visitSummary?.rows;
    if (!Array.isArray(rows)) return [];
    const dset = new Set(dates);
    const map = new Map<string, any>();
    for (const N of rows) {
      const S = N.sellerId || "sem-vendedor";
      let w = map.get(S);
      if (!w) { w = { sellerId: S, sellerName: N.sellerName || "Sem vendedor", clientesAtender: 0, completedVisits: 0, missedVisits: 0, revenue: 0, unmetRevenue: 0, completedNames: [] as string[], missedNames: [] as string[], clientesAtenderNames: [] as string[] }; map.set(S, w); }
      for (const v of N.visits || []) {
        if (!dset.has(v.date)) continue;
        if (v.isScheduled) { w.clientesAtender++; w.clientesAtenderNames.push(N.customerName || "-"); }
        if (!v.isPast) continue;
        const k = visitColor(v);
        if (k === "green" || k === "yellow") { w.completedVisits++; w.completedNames.push(N.customerName || "-"); }
        else if (k === "orange" || k === "red") { w.missedVisits++; w.unmetRevenue += expectedValue(v); w.missedNames.push(N.customerName || "-"); }
        if (v.isScheduled && v.hasOrder) w.revenue += v.orderValue || 0;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [data, dates]);

  const totals = useMemo(() => sellers.reduce((t, s) => ({ clientesAtender: t.clientesAtender + s.clientesAtender, completedVisits: t.completedVisits + s.completedVisits, revenue: t.revenue + s.revenue, missedVisits: t.missedVisits + s.missedVisits, unmetRevenue: t.unmetRevenue + s.unmetRevenue }), { clientesAtender: 0, completedVisits: 0, revenue: 0, missedVisits: 0, unmetRevenue: 0 }), [sellers]);
  const dailyRevenue = useMemo(() => {
    const rws = data?.visitSummary?.rows;
    if (!Array.isArray(rws)) return [] as { d: string; v: number }[];
    const m: Record<string, number> = {};
    for (const N of rws) for (const v of N.visits || []) { if (v.hasOrder) m[v.date] = (m[v.date] || 0) + (v.orderValue || 0); }
    return Object.keys(m).sort().map((d) => ({ d, v: m[d] }));
  }, [data]);

  // Vendas Hoje = total "a Faturar" + total das "NFs emitidas hoje"
  const today = ((ov.aFaturar || ov.unbilled || []) as any[]).reduce((a, x) => a + (Number(x.sale_value) || 0), 0)
    + ((ov.nfsHoje || ov.todayInvoices || []) as any[]).reduce((a, x) => a + (Number(x.total_invoice) || 0), 0);
  const lastWeekSameDay = Number(stats.lastWeekSameDaySales) || 0;
  const pct = lastWeekSameDay > 0 ? Math.round(((today - lastWeekSameDay) / lastWeekSameDay) * 100) : null;

  const blocked: any[] = ov.blocked || [];
  const aFaturar: any[] = ov.aFaturar || ov.unbilled || [];
  const nfsHoje: any[] = ov.nfsHoje || ov.todayInvoices || [];

  // Filtro de vendedor do card "Pedidos e Notas Fiscais" (aplica nas 3 colunas).
  const matchSeller = (x: any) => multiMatch(pnfSeller, resolveSeller(x.seller_name || x.sellerName || x.seller_id || ""));
  const blockedF = useMemo(() => blocked.filter(matchSeller), [blocked, pnfSeller, resolveSeller]);
  const aFaturarF = useMemo(() => aFaturar.filter(matchSeller), [aFaturar, pnfSeller, resolveSeller]);
  const nfsHojeF = useMemo(() => nfsHoje.filter(matchSeller), [nfsHoje, pnfSeller, resolveSeller]);

  const sum = (arr: any[], f: string) => arr.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  const isSingleDay = start === end;

  return (
    <div className="space-y-6 p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Vendas Hoje</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-800">{brl(today)}</div>
            <div className="text-xs mt-1">{pct === null ? (<span className="text-gray-400">-</span>) : (<span className={pct >= 0 ? "text-green-600" : "text-red-600"}>{pct >= 0 ? "+" : ""}{pct}% vs mesmo dia sem. passada</span>)}</div>
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
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento Diario (mes)</CardTitle></CardHeader>
          <CardContent><div className="text-lg font-bold text-gray-800">{brl(dailyRevenue.length ? dailyRevenue[dailyRevenue.length - 1].v : 0)}</div><Sparkline data={dailyRevenue} /><div className="text-xs mt-1 text-gray-400">Ultimo dia com venda</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Comparativo por Vendedor{isSingleDay ? " - dia vigente" : ""}</CardTitle>
              <div className="text-xs text-gray-500">Periodo: {brDate(start)}{isSingleDay ? "" : " a " + brDate(end)} (mes vigente)</div>
            </div>
            <div className="inline-flex items-center gap-1 text-sm">
              <span className="text-gray-600">Periodo:</span>
              <input type="date" value={start} min={bounds.first} max={bounds.last} onChange={(e) => { const v = e.target.value; setStart(v); if (v > end) setEnd(v); }} className="px-2 py-1.5 border rounded-md" aria-label="Data inicial" />
              <span className="text-gray-400">-</span>
              <input type="date" value={end} min={start || bounds.first} max={bounds.last} onChange={(e) => setEnd(e.target.value)} className="px-2 py-1.5 border rounded-md" aria-label="Data final" />
              <button type="button" onClick={() => { setStart(bounds.today); setEnd(bounds.today); }} className="px-2 py-1.5 border rounded-md text-gray-600 hover:bg-gray-100" title="Voltar para o dia vigente">Hoje</button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-2 pr-4 font-medium text-left sticky top-0 z-10 bg-white">Vendedor</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Clientes a atender no dia</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Visitas Efetivadas</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Faturamento Visitas Efetivas</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Nao Efetivadas</th>
                  <th className="py-2 pl-3 font-medium text-right sticky top-0 z-10 bg-white">Faturamento Previsto Nao Efetivado</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((x) => (
                  <tr key={x.sellerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{x.sellerName}</td>
                    <td className="py-2 px-3 text-right tabular-nums"><button type="button" className="underline hover:opacity-80 tabular-nums" onClick={() => setModal({ title: "Clientes a atender - " + x.sellerName, names: x.clientesAtenderNames })}>{x.clientesAtender}</button></td>
                    <td className="py-2 px-3 text-right tabular-nums text-green-700"><button type="button" className="underline hover:opacity-80 tabular-nums" onClick={() => setModal({ title: "Visitas Efetivadas - " + x.sellerName, names: x.completedNames })}>{x.completedVisits}</button></td>
                    <td className="py-2 px-3 text-right tabular-nums font-semibold text-gray-800">{brl(x.revenue)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-red-700"><button type="button" className="underline hover:opacity-80 tabular-nums" onClick={() => setModal({ title: "Nao Efetivadas - " + x.sellerName, names: x.missedNames })}>{x.missedVisits}</button></td>
                    <td className="py-2 pl-3 text-right tabular-nums font-semibold text-gray-500">{brl(x.unmetRevenue)}</td>
                  </tr>
                ))}
                {sellers.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-gray-400">Sem dados no periodo.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-semibold text-gray-800">
                  <td className="py-2 pr-4">Total</td>
                  <td className="py-2 px-3 text-right tabular-nums">{totals.clientesAtender}</td>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Pedidos e Notas Fiscais</CardTitle>
              <div className="text-xs text-gray-500">Bloqueados agora, ainda nao faturados e NFs emitidas hoje.</div>
            </div>
            <MultiSelect label="Vendedor" options={sellerOptions} groups={sellerGroups} selected={pnfSeller} onChange={setPnfSeller} testId="dash-pnf-seller" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Column title="Bloqueados" color="red" count={blockedF.length} total={sum(blockedF, "total_amount")} items={blockedF.map((b) => ({ name: b.customer_name || b.customerName || "-", sub: `Debito vencido - ${b.seller_name || b.sellerName || ""}`, when: fmtDateTime(b.blocked_at || b.blockedAt || b.created_at), value: b.total_amount ?? b.totalAmount }))} />
            <Column title="A faturar" color="yellow" count={aFaturarF.length} total={sum(aFaturarF, "sale_value")} items={aFaturarF.map((p) => ({ name: p.customer_name || p.customerName || "-", sub: `Pedido - ${p.seller_name || p.sellerName || ""}`, when: fmtDateTime(p.created_at || p.createdAt), value: p.sale_value ?? p.saleValue }))} />
            <Column title="NFs emitidas hoje" color="green" count={nfsHojeF.length} total={sum(nfsHojeF, "total_invoice")} items={nfsHojeF.map((n) => ({ name: n.customer_name || n.customerName || "-", sub: `NF ${n.invoice_number || n.invoiceNumber || ""} - ${n.seller_name || n.sellerName || ""}`, when: fmtDateTime(n.authorization_date || n.authorizationDate || n.emission_date), value: n.total_invoice ?? n.totalInvoice }))} />
          </div>
        </CardContent>
      </Card>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="font-semibold text-sm text-gray-800">{modal.title} ({modal.names.length})</h3>
              <button type="button" onClick={() => setModal(null)} className="text-sm px-2 py-1 border rounded hover:bg-gray-100">Fechar</button>
            </div>
            <div className="overflow-auto p-4 space-y-1">
              {modal.names.length === 0 ? (
                <div className="text-sm text-gray-400">Nenhum cliente no periodo.</div>
              ) : (
                modal.names.map((n, i) => (
                  <div key={i} className="text-sm text-gray-800 border-b border-gray-100 py-1">{n}</div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Sparkline(props: { data: { d: string; v: number }[] }) {
  const data = props.data;
  if (!data.length) return <div className="text-xs text-gray-400 h-11 flex items-center">Sem dados</div>;
  const w = 240, h = 44, pad = 3;
  const vals = data.map((x) => x.v);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const n = data.length;
  const pts = data.map((x, i) => {
    const px = pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * pad));
    const py = h - pad - ((x.v - min) / range) * (h - 2 * pad);
    return px.toFixed(1) + "," + py.toFixed(1);
  }).join(" ");
  const last = data[n - 1];
  const lx = pad + (n <= 1 ? 0 : (w - 2 * pad));
  const ly = h - pad - ((last.v - min) / range) * (h - 2 * pad);
  return (
    <svg viewBox={"0 0 " + w + " " + h} className="w-full h-11 mt-1" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="#10b981" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2" fill="#10b981" />
    </svg>
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
