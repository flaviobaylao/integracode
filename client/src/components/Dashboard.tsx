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

// Mini gráfico de barras (somente barras, sem eixos/valores) para os boxes do topo.
function MiniBars({ values, highlight, color = "#10b981", height = 40, labels, labelEvery = 1, labelSize = "text-[7px]", captions, format }: { values: number[]; highlight?: number; color?: string; height?: number; labels?: string[]; labelEvery?: number; labelSize?: string; captions?: string[]; format?: (n: number) => string }) {
  const nums = values.map((v) => Number(v) || 0);
  const max = Math.max(1, ...nums);
  const [sel, setSel] = useState<number | null>(null);
  const selValid = sel !== null && (sel as number) >= 0 && (sel as number) < nums.length;
  return (
    <div className="mt-2">
      {format && selValid && (
        <div className="mb-1 text-[11px] font-semibold text-gray-800 whitespace-nowrap">
          {((captions && captions[sel as number]) || (labels && labels[sel as number]) || ("#" + ((sel as number) + 1))) + ": " + format(nums[sel as number])}
        </div>
      )}
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {nums.map((val, i) => {
          const h = Math.max(2, Math.round((val / max) * height));
          const isHi = highlight === i;
          const isSel = sel === i;
          return (
            <button
              type="button"
              key={i}
              onClick={() => setSel((prev) => (prev === i ? null : i))}
              title={((captions && captions[i]) || (labels && labels[i]) || ("#" + (i + 1))) + ": " + (format ? format(val) : String(val))}
              className="flex-1 flex items-end p-0 border-0 bg-transparent cursor-pointer"
              style={{ height, minWidth: 2 }}
            >
              <div className="w-full rounded-sm" style={{ height: h, backgroundColor: isSel ? "#111827" : isHi ? "#059669" : val > 0 ? color : "#e5e7eb" }} />
            </button>
          );
        })}
      </div>
      {labels && labels.length === nums.length && (
        <div className="flex gap-[2px] mt-0.5">
          {labels.map((lb, i) => (
            <div
              key={i}
              className={"flex-1 text-center " + labelSize + " leading-none overflow-hidden whitespace-nowrap " + (highlight === i || sel === i ? "text-gray-800 font-semibold" : "text-gray-500")}
              style={{ minWidth: 2 }}
            >
              {(labelEvery <= 1 || i % labelEvery === 0 || i === labels.length - 1) ? lb : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  // Atualização quase imediata às mudanças da Rota do Dia (check-in / pedido): poll + on-focus.
  const { data } = useQuery<any>({ queryKey: ["/api/dashboard2/full"], refetchInterval: 15000, refetchOnWindowFocus: true, staleTime: 0 });
  const { data: phoneCoverage } = useQuery<any[]>({ queryKey: ["/api/dashboard/phone-coverage"], refetchInterval: 60000, refetchOnWindowFocus: true, staleTime: 0 });
  const phoneCov = useMemo(() => {
    const arr = Array.isArray(phoneCoverage) ? [...phoneCoverage] : [];
    arr.sort((a: any, b: any) => (a.pct - b.pct) || (b.invalid - a.invalid));
    return arr;
  }, [phoneCoverage]);
  const covTotals = useMemo(() => {
    const t = phoneCov.reduce((acc: any, x: any) => { acc.total += x.total || 0; acc.valid += x.valid || 0; return acc; }, { total: 0, valid: 0 });
    const invalid = t.total - t.valid;
    return { total: t.total, valid: t.valid, invalid, pct: t.total > 0 ? Math.round((t.valid / t.total) * 100) : 0 };
  }, [phoneCov]);
  const bounds = useMemo(() => monthBounds(), []);
  const [start, setStart] = useState<string>(bounds.first);
  const [end, setEnd] = useState<string>(bounds.today);
  const { sellerOptions, sellerGroups, resolveSeller } = useActiveSellers();
  const [pnfSeller, setPnfSeller] = useState<string[]>([]);
  const [modal, setModal] = useState<{ title: string; names: string[] } | null>(null);
  const [sortKey, setSortKey] = useState<string>("fatMes");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const stats = data?.stats || {};
  const ov = data?.ordersOverview || {};
  const vem = data?.vendasEfetivasMes || {};

  const dates = useMemo(() => datesInRange(start, end), [start, end]);

  // Semana comeca na segunda-feira da semana atual (BRT).
  const weekStartISO = useMemo(() => { const d = new Date(bounds.today + "T12:00:00"); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.toISOString().slice(0, 10); }, [bounds.today]);
  // Faturamento (billing_pipeline via visitSummary) por vendedor: Dia / Semana / Mes vigente.
  // Mantem apenas vendedores COM faturamento no mes.
  const sellers = useMemo(() => {
    const rows = data?.visitSummary?.rows;
    if (!Array.isArray(rows)) return [];
    const map = new Map<string, any>();
    for (const N of rows) {
      const S = N.sellerId || "sem-vendedor";
      let w = map.get(S);
      if (!w) { w = { sellerId: S, sellerName: N.sellerName || "Sem vendedor", fatDia: 0, fatSemana: 0, fatMes: 0 }; map.set(S, w); }
      for (const v of N.visits || []) {
        if (!v.hasOrder) continue;
        const val = Number(v.orderValue) || 0;
        if (val <= 0) continue;
        w.fatMes += val;
        if (v.date >= weekStartISO) w.fatSemana += val;
        if (v.date === bounds.today) w.fatDia += val;
      }
    }
    return Array.from(map.values()).filter((s) => s.fatMes > 0).sort((a, b) => b.fatMes - a.fatMes);
  }, [data, weekStartISO, bounds.today]);

  const totals = useMemo(() => sellers.reduce((t, s) => ({ fatDia: t.fatDia + s.fatDia, fatSemana: t.fatSemana + s.fatSemana, fatMes: t.fatMes + s.fatMes }), { fatDia: 0, fatSemana: 0, fatMes: 0 }), [sellers]);
  const sortedSellers = useMemo(() => {
    const arr = [...sellers];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => sortKey === "sellerName"
      ? String(a.sellerName).localeCompare(String(b.sellerName), "pt-BR") * dir
      : (((a as any)[sortKey] || 0) - ((b as any)[sortKey] || 0)) * dir);
    return arr;
  }, [sellers, sortKey, sortDir]);
  const toggleSort = (k: string) => { if (sortKey === k) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); } else { setSortKey(k); setSortDir("asc"); } };
  const sortArrow = (k: string) => (sortKey === k ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : "");
  // ==== Comparativo diario (seg-sab) por semana do mes vigente ====
  const pad2 = (n: number) => (n < 10 ? "0" + n : "" + n);
  const isoOf = (d: Date) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const WD_ABBR = ["seg", "ter", "qua", "qui", "sex", "s\u00e1b"];
  const nfmt = (v: number) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  const monthWeeks = useMemo(() => {
    const parts = bounds.today.split("-");
    const Y = Number(parts[0]); const M = Number(parts[1]);
    const lastDay = new Date(Y, M, 0).getDate();
    const first = new Date(Y, M - 1, 1);
    const dow0 = (first.getDay() + 6) % 7;
    const monday = new Date(Y, M - 1, 1 - dow0);
    const lastDate = new Date(Y, M - 1, lastDay);
    const weeks: any[] = [];
    const cur = new Date(monday);
    while (cur <= lastDate && weeks.length < 6) {
      const days: any[] = [];
      for (let i = 0; i < 6; i++) {
        const d = new Date(cur); d.setDate(cur.getDate() + i);
        days.push({ iso: isoOf(d), inMonth: d.getMonth() === M - 1, dayNum: d.getDate() });
      }
      const inM = days.filter((x) => x.inMonth);
      const label = inM.length ? (inM[0].dayNum + "-" + inM[inM.length - 1].dayNum + "/" + pad2(M)) : "";
      weeks.push({ days, label });
      cur.setDate(cur.getDate() + 7);
    }
    return weeks;
  }, [bounds.today]);
  const sellerDaily = useMemo(() => {
    const rows = data?.visitSummary?.rows;
    const map = new Map<string, any>();
    if (Array.isArray(rows)) {
      for (const N of rows) {
        const nm = (N.sellerName || "Sem vendedor").trim();
        const S = nm.toLowerCase();
        let w = map.get(S);
        if (!w) { w = { sellerId: S, sellerName: nm, dates: new Map<string, number>() }; map.set(S, w); }
        for (const v of N.visits || []) {
          if (!v.hasOrder) continue;
          const val = Number(v.orderValue) || 0;
          if (val <= 0) continue;
          w.dates.set(v.date, (w.dates.get(v.date) || 0) + val);
        }
      }
    }
    const arr: any[] = [];
    for (const w of map.values()) {
      const weeks = monthWeeks.map((wk: any) => {
        const dayVals = wk.days.map((d: any) => (d.inMonth ? (w.dates.get(d.iso) || 0) : null));
        const total = dayVals.reduce((acc: number, x: any) => acc + (x || 0), 0);
        return { dayVals, total };
      });
      const mensal = weeks.reduce((acc: number, wk: any) => acc + wk.total, 0);
      arr.push({ sellerId: w.sellerId, sellerName: w.sellerName, weeks, mensal, fatMes: mensal });
    }
    return arr.filter((r) => r.fatMes > 0);
  }, [data, monthWeeks]);
  const sortedSellerDaily = useMemo(() => {
    const arr = [...sellerDaily];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => sortKey === "sellerName"
      ? String(a.sellerName).localeCompare(String(b.sellerName), "pt-BR") * dir
      : ((a.fatMes || 0) - (b.fatMes || 0)) * dir);
    return arr;
  }, [sellerDaily, sortKey, sortDir]);
  const grandTotals = useMemo(() => {
    const weeks = monthWeeks.map(() => ({ dayVals: [0, 0, 0, 0, 0, 0], total: 0 }));
    let mensal = 0;
    for (const r of sellerDaily) {
      r.weeks.forEach((wk: any, wi: number) => {
        wk.dayVals.forEach((v: any, di: number) => { if (v != null) weeks[wi].dayVals[di] += v; });
        weeks[wi].total += wk.total;
      });
      mensal += r.mensal;
    }
    return { weeks, mensal };
  }, [sellerDaily, monthWeeks]);
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

  // Faturamento diário: vendas de HOJE vs MESMO DIA da semana passada (billing_pipeline)
  const dailyTodaySales = Number(stats.todaySales) || 0;
  const dailyLastWeek = Number(stats.lastWeekSameDaySales) || 0;
  const dailyPct = dailyLastWeek > 0 ? Math.round(((dailyTodaySales - dailyLastWeek) / dailyLastWeek) * 100) : null;
  const todayISO = bounds.today;
  const lastWeekISO = (() => { const d = new Date(bounds.today + 'T12:00:00'); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();

  // ── Séries dos mini gráficos de barras ──────────────────────────────────────
  const series = data?.series || {};
  const monthDailyBars = useMemo(() => {
    const [y, m] = bounds.today.split("-");
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const map: Record<string, number> = {};
    for (const r of (series.daily || [])) map[r.d] = Number(r.v) || 0;
    const arr: number[] = [];
    for (let d = 1; d <= lastDay; d++) arr.push(map[`${y}-${m}-${String(d).padStart(2, "0")}`] || 0);
    return { arr, todayIdx: Number(bounds.today.slice(8, 10)) - 1 };
  }, [series.daily, bounds.today]);
  const weekBars = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of (series.daily || [])) map[String(r.d)] = Number(r.v) || 0;
    const arr = monthWeeks.map((wk: any) => wk.days.reduce((acc: number, d: any) => acc + (d.inMonth ? (map[d.iso] || 0) : 0), 0));
    let curWeek = 0;
    monthWeeks.forEach((wk: any, i: number) => { if (wk.days.some((d: any) => d.iso === bounds.today)) curWeek = i; });
    return { arr, curWeek };
  }, [series.daily, monthWeeks, bounds.today]);
  const yearMonthBars = useMemo(() => {
    const y = bounds.today.slice(0, 4);
    const curMonth = Number(bounds.today.slice(5, 7));
    const map: Record<string, number> = {};
    for (const r of (series.monthly || [])) map[r.m] = Number(r.v) || 0;
    const arr: number[] = [];
    for (let mo = 1; mo <= curMonth; mo++) arr.push(map[`${y}-${String(mo).padStart(2, "0")}`] || 0);
    return { arr, curIdx: curMonth - 1 };
  }, [series.monthly, bounds.today]);

  // Rótulos dos eixos dos mini gráficos.
  const MONTH_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const yy = bounds.today.slice(2, 4);
  const mm = Number(bounds.today.slice(5, 7));
  const weekDayBars = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of (series.daily || [])) map[String(r.d)] = Number(r.v) || 0;
    const base = new Date(bounds.today + "T12:00:00");
    const dow = (base.getDay() + 6) % 7;
    const monday = new Date(base); monday.setDate(base.getDate() - dow);
    const wd = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
    const arr: number[] = []; const labels: string[] = []; const captions: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      arr.push(map[ds] || 0); labels.push(wd[i]); captions.push(wd[i] + " " + brDate(ds));
    }
    return { arr, labels, captions, todayIdx: dow };
  }, [series.daily, bounds.today]);
  const dayLabels = useMemo(() => monthDailyBars.arr.map((_, i) => String(i + 1)), [monthDailyBars.arr]);
  const weekLabels = useMemo(() => monthWeeks.map((wk: any) => wk.label), [monthWeeks]);
  const monthLabels = useMemo(() => yearMonthBars.arr.map((_, i) => `${MONTH_ABBR[i] || ''}/${yy}`), [yearMonthBars.arr, yy]);

  const blocked: any[] = ov.blocked || [];
  const aFaturar: any[] = ov.aFaturar || ov.unbilled || [];
  const nfsHoje: any[] = ov.nfsHoje || ov.todayInvoices || [];
  // Relacao de clientes faturados no DIA (mesma composicao do card Vendas Hoje: a faturar + NFs de hoje).
  const billedDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of aFaturar) { const n = x.customer_name || x.customerName || "-"; m.set(n, (m.get(n) || 0) + (Number(x.sale_value) || 0)); }
    for (const x of nfsHoje) { const n = x.customer_name || x.customerName || "-"; m.set(n, (m.get(n) || 0) + (Number(x.total_invoice) || 0)); }
    const arr = [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = arr.reduce((acc, [, v]) => acc + v, 0);
    return { list: arr.map(([n, v]) => n + " - " + brl(v)), total };
  }, [aFaturar, nfsHoje]);
  // Relacao de clientes faturados na SEMANA vigente (billing_pipeline via visitSummary).
  const billedWeek = useMemo(() => {
    const rows = data?.visitSummary?.rows;
    const m = new Map<string, number>();
    if (Array.isArray(rows)) {
      for (const N of rows) {
        let v = 0;
        for (const vis of N.visits || []) { if (vis.hasOrder && vis.date >= weekStartISO) v += Number(vis.orderValue) || 0; }
        if (v > 0) { const n = N.customerName || "-"; m.set(n, (m.get(n) || 0) + v); }
      }
    }
    const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const total = arr.reduce((acc, [, v]) => acc + v, 0);
    return { list: arr.map(([n, v]) => n + " - " + brl(v)), total };
  }, [data, weekStartISO]);

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
            <MiniBars values={weekDayBars.arr} highlight={weekDayBars.todayIdx} labels={weekDayBars.labels} captions={weekDayBars.captions} labelSize="text-[10px]" format={brl} />
            <div className="text-[10px] text-gray-400 mt-1">Dias da semana (clique na barra)</div>
            <button type="button" onClick={() => setModal({ title: "Clientes faturados hoje - Total " + brl(billedDay.total), names: billedDay.list })} className="mt-2 text-xs text-blue-600 hover:underline">Ver clientes faturados no dia</button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento da Semana</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-gray-800">{brl(stats.weekSales)}</div><div className="text-xs mt-1 text-gray-400">Semana vigente</div><MiniBars values={weekBars.arr} highlight={weekBars.curWeek} color="#0ea5e9" labels={weekLabels} format={brl} /><div className="text-[10px] text-gray-400 mt-1">Semanas do mês</div><button type="button" onClick={() => setModal({ title: "Clientes faturados na semana - Total " + brl(billedWeek.total), names: billedWeek.list })} className="mt-2 text-xs text-blue-600 hover:underline">Ver clientes faturados na semana</button></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento do Mes</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-gray-800">{brl(stats.monthSales)}</div><div className="text-xs mt-1 text-gray-400">Mes vigente</div><MiniBars values={yearMonthBars.arr} highlight={yearMonthBars.curIdx} color="#6366f1" labels={monthLabels} labelEvery={monthLabels.length > 8 ? 2 : 1} format={brl} /><div className="text-[10px] text-gray-400 mt-1">Meses do ano (desde jan)</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-gray-500">Faturamento Diario (mes)</CardTitle></CardHeader>
          <CardContent>
            {(() => {
              const pair = [
                { label: "Sem. passada", v: dailyLastWeek, color: "#9ca3af" },
                { label: "Hoje", v: dailyTodaySales, color: "#10b981" },
              ];
              const mx = Math.max(1, dailyLastWeek, dailyTodaySales);
              return (
                <div className="mt-3 flex items-end justify-around gap-6 h-28">
                  {pair.map((p, i) => (
                    <div key={i} className="flex flex-col items-center flex-1">
                      <div className="text-[11px] font-semibold text-gray-700 mb-1 whitespace-nowrap">{brl(p.v)}</div>
                      <div className="w-10 rounded-t" style={{ height: Math.max(6, Math.round((p.v / mx) * 72)), backgroundColor: p.color }} />
                      <div className="text-[10px] text-gray-500 mt-1">{p.label}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="text-base">Comparativo por Vendedor</CardTitle>
            <div className="text-xs text-gray-500">Faturamento por vendedor - mes vigente</div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[70vh]">
            <table className="text-xs w-full">
              <thead>
                <tr className="border-b text-gray-500">
                  <th rowSpan={2} className="py-1 pr-3 pl-1 font-medium text-left sticky left-0 top-0 z-20 bg-white"><button type="button" onClick={() => toggleSort("sellerName")} className="inline-flex items-center gap-1 hover:text-gray-700" title="Ordenar A-Z / Z-A">Vendedor{sortArrow("sellerName")}</button></th>
                  {monthWeeks.map((wk: any, i: number) => (
                    <th key={i} colSpan={7} className="py-1 px-2 font-semibold text-center border-l bg-gray-50 sticky top-0 z-10">Semana {i + 1}{wk.label ? " (" + wk.label + ")" : ""}</th>
                  ))}
                  <th rowSpan={2} className="py-1 px-2 font-medium text-right border-l sticky top-0 z-10 bg-white"><button type="button" onClick={() => toggleSort("fatMes")} className="inline-flex items-center gap-1 hover:text-gray-700 w-full justify-end" title="Ordenar">Mensal{sortArrow("fatMes")}</button></th>
                </tr>
                <tr className="border-b text-gray-400">
                  {monthWeeks.flatMap((wk: any, i: number) => [
                    ...WD_ABBR.map((wd: string, di: number) => (
                      <th key={i + "d" + di} className={"py-1 px-1 font-normal text-right sticky top-6 z-10 bg-white " + (di === 0 ? "border-l" : "")}>{wd}</th>
                    )),
                    <th key={i + "s"} className="py-1 px-2 font-semibold text-right sticky top-6 z-10 bg-gray-50">Sem.</th>
                  ])}
                </tr>
              </thead>
              <tbody>
                {sortedSellerDaily.map((x: any) => (
                  <tr key={x.sellerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-1 pr-3 pl-1 font-medium text-gray-800 whitespace-nowrap sticky left-0 bg-white">{x.sellerName}</td>
                    {x.weeks.flatMap((wk: any, wi: number) => [
                      ...wk.dayVals.map((v: any, di: number) => (
                        <td key={wi + "d" + di} className={"py-1 px-1 text-right tabular-nums text-gray-700 " + (di === 0 ? "border-l" : "")}>{v == null || v === 0 ? "" : nfmt(v)}</td>
                      )),
                      <td key={wi + "s"} className="py-1 px-2 text-right tabular-nums font-semibold text-gray-800 bg-gray-50">{wk.total ? nfmt(wk.total) : ""}</td>
                    ])}
                    <td className="py-1 px-2 text-right tabular-nums font-bold text-gray-900 border-l">{brl(x.mensal)}</td>
                  </tr>
                ))}
                {sortedSellerDaily.length === 0 && (
                  <tr><td colSpan={monthWeeks.length * 7 + 2} className="py-6 text-center text-gray-400">Sem vendedores com faturamento no mes.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-semibold text-gray-800">
                  <td className="py-1 pr-3 pl-1 sticky left-0 bg-white">Total</td>
                  {grandTotals.weeks.flatMap((wk: any, wi: number) => [
                    ...wk.dayVals.map((v: number, di: number) => (
                      <td key={wi + "d" + di} className={"py-1 px-1 text-right tabular-nums " + (di === 0 ? "border-l" : "")}>{v ? nfmt(v) : ""}</td>
                    )),
                    <td key={wi + "s"} className="py-1 px-2 text-right tabular-nums bg-gray-50">{wk.total ? nfmt(wk.total) : ""}</td>
                  ])}
                  <td className="py-1 px-2 text-right tabular-nums border-l">{brl(grandTotals.mensal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="text-[10px] text-gray-400 mt-2">Faturamento diario (seg a sab) por semana do mes vigente. Domingos nao entram no comparativo. Colunas de dia em R$ sem centavos; subtotais e mensal em R$.</div>
        </CardContent>
      </Card>

      {phoneCov.length > 0 && (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Qualidade de Cadastro - Telefone</CardTitle>
              <div className="text-xs text-gray-500">% da carteira ativa de cada vendedor com telefone válido. Clique em "Sem telefone" para ver os clientes.</div>
            </div>
            <div className="text-sm text-gray-600">Geral: <span className={"font-semibold " + (covTotals.pct >= 90 ? "text-green-700" : covTotals.pct >= 60 ? "text-amber-600" : "text-red-700")}>{covTotals.pct}%</span> ({covTotals.valid}/{covTotals.total})</div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="py-2 pr-4 font-medium text-left sticky top-0 z-10 bg-white">Vendedor</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Carteira ativa</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Com telefone</th>
                  <th className="py-2 px-3 font-medium text-right sticky top-0 z-10 bg-white">Sem telefone</th>
                  <th className="py-2 pl-3 font-medium text-right sticky top-0 z-10 bg-white">% válido</th>
                </tr>
              </thead>
              <tbody>
                {phoneCov.map((x: any) => (
                  <tr key={x.sellerId} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{x.sellerName}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{x.total}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-green-700">{x.valid}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-red-700">{x.invalid > 0 ? (<button type="button" className="underline hover:opacity-80 tabular-nums" onClick={() => setModal({ title: "Sem telefone válido - " + x.sellerName, names: x.missingNames || [] })}>{x.invalid}</button>) : (x.invalid)}</td>
                    <td className={"py-2 pl-3 text-right tabular-nums font-semibold " + (x.pct >= 90 ? "text-green-700" : x.pct >= 60 ? "text-amber-600" : "text-red-700")}>{x.pct}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 font-semibold text-gray-800">
                  <td className="py-2 pr-4">Total</td>
                  <td className="py-2 px-3 text-right tabular-nums">{covTotals.total}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{covTotals.valid}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{covTotals.invalid}</td>
                  <td className="py-2 pl-3 text-right tabular-nums">{covTotals.pct}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>
      )}

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

function Sparkline(props: { data: { d: string; v: number }[]; highlight?: string[] }) {
  const data = props.data;
  if (!data.length) return <div className="text-xs text-gray-400 h-11 flex items-center">Sem dados</div>;
  const w = 240, h = 44, pad = 3;
  const vals = data.map((x) => x.v);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const n = data.length;
  const coord = (x: { d: string; v: number }, i: number) => ({
    px: pad + (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * pad)),
    py: h - pad - ((x.v - min) / range) * (h - 2 * pad),
  });
  const pts = data.map((x, i) => { const c = coord(x, i); return c.px.toFixed(1) + "," + c.py.toFixed(1); }).join(" ");
  const hl = new Set(props.highlight || []);
  const last = data[n - 1];
  const lc = coord(last, n - 1);
  return (
    <svg viewBox={"0 0 " + w + " " + h} className="w-full h-11 mt-1" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="#10b981" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={lc.px} cy={lc.py} r="2" fill="#10b981" />
      {data.map((x, i) => hl.has(x.d) ? (() => { const c = coord(x, i); return (<circle key={"hl" + i} cx={c.px} cy={c.py} r="3.2" fill="#f59e0b" stroke="#fff" strokeWidth="1" />); })() : null)}
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
