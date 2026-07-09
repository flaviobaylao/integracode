import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { sortSellerNamesByType } from "@/lib/sellerOrder";

// Resumo de Visitas e Atendimentos — paridade com o 1.0 (calendário por cliente).
// Fonte: GET /api/visit-summary?startDate&endDate

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
type Row = {
  customerId: string;
  customerName: string;
  sellerName: string;
  city: string;
  neighborhood: string;
  periodicity: string;
  weekdays: string;
  visits: Visit[];
};

type StatusKey = "green" | "yellow" | "red" | "orange" | "lilac" | "teal" | "sky" | "blue" | "future" | "none";

const STATUS: Record<StatusKey, { g: string; c: string; bg: string; t: string }> = {
  green: { g: "✓", c: "#166534", bg: "#dcfce7", t: "Visita agendada + efetuada + Pedido" },
  yellow: { g: "✓", c: "#854d0e", bg: "#fef9c3", t: "Visita agendada + efetuada, sem pedido" },
  red: { g: "✗", c: "#991b1b", bg: "#fee2e2", t: "Visita agendada, não efetuada, sem pedido" },
  orange: { g: "$", c: "#9a3412", bg: "#ffedd5", t: "Visita agendada, não efetuada — porém com Pedido" },
  lilac: { g: "$", c: "#6b21a8", bg: "#f3e8ff", t: "Pedido sem visita agendada" },
  teal: { g: "✗V", c: "#115e59", bg: "#ccfbf1", t: "Atendimento registrado fora do dia de rota" },
  sky: { g: "✗V", c: "#075985", bg: "#e0f2fe", t: "Atendimento virtual agendado (sem venda no dia)" },
  blue: { g: "$V", c: "#166534", bg: "#bbf7d0", t: "Atendimento virtual + Pedido" },
  future: { g: "—", c: "#6b7280", bg: "transparent", t: "Agendamento futuro" },
  none: { g: "—", c: "#d1d5db", bg: "transparent", t: "" },
};

function cellStatus(v?: Visit): StatusKey {
  if (!v) return "none";
  if (!v.isPast) return v.isScheduled ? "future" : v.hasOrder ? "lilac" : "none";
  if (v.hasVirtualAttendance && v.hasOrder) return "blue";
  if (v.hasVirtualAttendance && v.isScheduled) return "sky";
  if (v.hasVirtualAttendance && !v.isScheduled) return "teal";
  if (v.isScheduled && v.hasVisit && v.hasOrder) return "green";
  if (v.isScheduled && v.hasVisit && !v.hasOrder) return "yellow";
  if (!v.isScheduled && v.hasOrder) return "lilac";
  if (v.isScheduled && !v.hasVisit && v.hasOrder) return "orange";
  if (v.isScheduled && !v.hasVisit) return "red";
  return "none";
}

const money = (n: number) => (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "—");

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(base: string, days: number) {
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function eachDay(start: string, end: string) {
  const out: string[] = [];
  let d = new Date(start + "T12:00:00Z");
  const e = new Date(end + "T12:00:00Z");
  let guard = 0;
  while (d <= e && guard < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); guard++; }
  return out;
}
const ddmm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const isWeekend = (s: string) => { const dow = new Date(s + "T12:00:00Z").getUTCDay(); return dow === 0 || dow === 6; };
function parseWeekdays(w: string): string {
  try { const a = JSON.parse(w); return Array.isArray(a) ? a.join(", ") : String(w || ""); } catch { return String(w || ""); }
}

export default function ResumoVisitas() {
  const t0 = todayISO();
  const [startDate, setStartDate] = useState(addDays(t0, -30));
  const [endDate, setEndDate] = useState(addDays(t0, 30));
  const [search, setSearch] = useState("");
  const [seller, setSeller] = useState("");
  const [city, setCity] = useState("");
  const [bairro, setBairro] = useState("");
  const [freq, setFreq] = useState("");

  const { data, isLoading } = useQuery<{ rows?: Row[]; today?: string }>({
    queryKey: ["/api/visit-summary", startDate, endDate],
    queryFn: () => fetch(`/api/visit-summary?startDate=${startDate}&endDate=${endDate}`, { credentials: "include", cache: "no-store" }).then((r) => r.json()),
  });

  const rows: Row[] = data?.rows || [];
  const days = useMemo(() => eachDay(startDate, endDate), [startDate, endDate]);

  const { data: usersData } = useQuery<any[]>({
    queryKey: ["/api/users"],
    queryFn: () => fetch("/api/users", { credentials: "include" }).then((r) => r.json()),
  });
  const sellerTypeByName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of (Array.isArray(usersData) ? usersData : [])) {
      const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
      if (n && !(n in m)) m[n] = u.sellerType || (u.role === "telemarketing" ? "telemarketing" : "");
    }
    return m;
  }, [usersData]);
  const sellers = useMemo(
    () => sortSellerNamesByType(Array.from(new Set(rows.map((r) => r.sellerName).filter(Boolean))) as string[], sellerTypeByName),
    [rows, sellerTypeByName],
  );
  const cities = useMemo(() => Array.from(new Set(rows.map((r) => r.city).filter(Boolean))).sort(), [rows]);
  const bairros = useMemo(() => Array.from(new Set(rows.map((r) => r.neighborhood).filter(Boolean))).sort(), [rows]);
  const freqs = useMemo(() => Array.from(new Set(rows.map((r) => r.periodicity).filter(Boolean))).sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (seller && r.sellerName !== seller) return false;
      if (city && r.city !== city) return false;
      if (bairro && r.neighborhood !== bairro) return false;
      if (freq && r.periodicity !== freq) return false;
      if (q && !((r.customerName || "").toLowerCase().includes(q) || (r.city || "").toLowerCase().includes(q) || (r.neighborhood || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, search, seller, city, bairro, freq]);

  // resumo por status sobre as células visíveis
  const summary = useMemo(() => {
    const s: Record<StatusKey, { n: number; sale: number; meta: number }> = {
      green: { n: 0, sale: 0, meta: 0 }, yellow: { n: 0, sale: 0, meta: 0 }, red: { n: 0, sale: 0, meta: 0 },
      orange: { n: 0, sale: 0, meta: 0 }, lilac: { n: 0, sale: 0, meta: 0 }, teal: { n: 0, sale: 0, meta: 0 },
      sky: { n: 0, sale: 0, meta: 0 }, blue: { n: 0, sale: 0, meta: 0 }, future: { n: 0, sale: 0, meta: 0 }, none: { n: 0, sale: 0, meta: 0 },
    };
    for (const r of filtered) {
      for (const v of r.visits || []) {
        const k = cellStatus(v);
        s[k].n++; s[k].sale += v.orderValue || 0; s[k].meta += v.metaValue || 0;
      }
    }
    return s;
  }, [filtered]);

  const agendadas = summary.green.n + summary.yellow.n + summary.orange.n + summary.red.n;
  const cards: { key: StatusKey; label: string; sub: string }[] = [
    { key: "green", label: "Agendada + Efetuada + Pedido", sub: `Vendas: ${money(summary.green.sale)}` },
    { key: "yellow", label: "Agendada + Efetuada - Sem Pedido", sub: `Meta não cumprida: ${money(summary.yellow.meta)}` },
    { key: "lilac", label: "Não Agendada + Pedido", sub: `Vendas: ${money(summary.lilac.sale)}` },
    { key: "orange", label: "Agendada - Não Efetuada + Pedido", sub: `Vendas: ${money(summary.orange.sale)}` },
    { key: "red", label: "Agendada - Não Efetuada", sub: `Meta não cumprida: ${money(summary.red.meta)}` },
    { key: "teal", label: "Atendimento Fora de Rota", sub: `Meta não cumprida: ${money(summary.teal.meta)}` },
    { key: "sky", label: "Atendimento Virtual Agendado", sub: `Meta não cumprida: ${money(summary.sky.meta)}` },
    { key: "blue", label: "Atendimento Virtual + Pedido", sub: `Vendas: ${money(summary.blue.sale)}` },
  ];

  const cellMapFor = (r: Row) => { const m = new Map<string, Visit>(); for (const v of r.visits || []) m.set(v.date, v); return m; };
  const th = "sticky top-0 z-20 bg-background";
  const stickyL = (i: number) => ({ position: "sticky" as const, left: i, zIndex: 15, background: "var(--background, #fff)" });

  return (
    <div className="p-4 space-y-4">
      <BackToDashboardButton />
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <i className="fas fa-calendar-check text-primary" /> Resumo de Visitas e Atendimentos
        </h1>
        <p className="text-muted-foreground text-sm">Calendário por cliente. Período: {ddmm(startDate)} a {ddmm(endDate)}. {filtered.length} clientes.</p>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => {
          const st = STATUS[c.key];
          const isAg = c.key === "green" || c.key === "yellow" || c.key === "orange" || c.key === "red";
          return (
            <div key={c.key} className="rounded-lg border p-3" style={{ borderLeft: `4px solid ${st.c}` }}>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-xl font-bold" style={{ color: st.c }}>
                {summary[c.key].n}
                {isAg && <span className="text-xs font-normal text-muted-foreground"> ({pct(summary[c.key].n, agendadas)})</span>}
              </div>
              <div className="text-[11px] text-muted-foreground">{c.sub}</div>
            </div>
          );
        })}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <input className="border rounded px-2 py-1 text-sm" placeholder="Nome, cidade ou bairro..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220 }} />
        <input type="date" className="border rounded px-2 py-1 text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input type="date" className="border rounded px-2 py-1 text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <select className="border rounded px-2 py-1 text-sm" value={seller} onChange={(e) => setSeller(e.target.value)}><option value="">Todos os vendedores</option>{sellers.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="border rounded px-2 py-1 text-sm" value={city} onChange={(e) => setCity(e.target.value)}><option value="">Todas as cidades</option>{cities.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="border rounded px-2 py-1 text-sm" value={bairro} onChange={(e) => setBairro(e.target.value)}><option value="">Todos os bairros</option>{bairros.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="border rounded px-2 py-1 text-sm" value={freq} onChange={(e) => setFreq(e.target.value)}><option value="">Todas as freq.</option>{freqs.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {(["green", "yellow", "red", "orange", "lilac", "teal", "sky", "blue"] as StatusKey[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span style={{ color: STATUS[k].c, fontWeight: 700 }}>{STATUS[k].g}</span>
            <span className="text-muted-foreground">{STATUS[k].t}</span>
          </span>
        ))}
      </div>

      {/* Tabela calendário */}
      {isLoading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : (
        <div className="overflow-auto border rounded" style={{ maxHeight: "70vh" }}>
          <table className="text-xs border-collapse">
            <thead>
              <tr>
                <th className={th} style={{ ...stickyL(0), minWidth: 200, textAlign: "left", padding: "6px 8px" }}>Cliente</th>
                <th className={th} style={{ padding: "6px 8px", textAlign: "left", minWidth: 110 }}>Vendedor</th>
                <th className={th} style={{ padding: "6px 8px", textAlign: "left", minWidth: 100 }}>Cidade</th>
                <th className={th} style={{ padding: "6px 8px", textAlign: "left", minWidth: 120 }}>Bairro</th>
                <th className={th} style={{ padding: "6px 8px", textAlign: "left", minWidth: 80 }}>Freq.</th>
                {days.map((d) => (
                  <th key={d} className={th} style={{ padding: "4px 3px", textAlign: "center", minWidth: 34, color: isWeekend(d) ? "#9ca3af" : undefined, whiteSpace: "nowrap", fontWeight: 500 }}>{ddmm(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const cm = cellMapFor(r);
                return (
                  <tr key={r.customerId} className="border-t hover:bg-muted/20">
                    <td style={{ ...stickyL(0), padding: "4px 8px", fontWeight: 500, whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={r.customerName}>{r.customerName}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.sellerName}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.city}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }} title={r.neighborhood}>{r.neighborhood}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.periodicity}</td>
                    {days.map((d) => {
                      const v = cm.get(d);
                      const k = cellStatus(v);
                      const st = STATUS[k];
                      const sale = v && (k === "green" || k === "orange" || k === "lilac" || k === "blue") ? v.orderValue || 0 : 0;
                      const next = v && k === "future" ? v.nextSaleValue || v.metaValue || 0 : 0;
                      const title = st.t + (sale ? ` • ${money(sale)}` : "") + (next ? ` • Próxima Venda: ${money(next)}` : "");
                      return (
                        <td key={d} title={title} style={{ textAlign: "center", padding: "3px 2px", background: st.bg, color: st.c, fontWeight: 700, borderLeft: "1px solid #f1f5f9" }}>{st.g}</td>
                      );
                    })}
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={5 + days.length} className="p-4 text-center text-muted-foreground">Nenhum cliente para o filtro.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
