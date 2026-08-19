import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { sortSellerNamesByType } from "@/lib/sellerOrder";
import { MultiSelect, multiMatch } from "@/lib/tableTools";

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
type Cycle = { anchor: string; start: string; end: string; green: boolean; isPast: boolean };
type Row = {
  customerId: string;
  customerName: string;
  sellerName: string;
  city: string;
  neighborhood: string;
  periodicity: string;
  weekdays: string;
  segmento?: string;
  documento?: string;
  cadastroAtivo?: boolean;
  tipoPessoa?: string;
  cycles?: Cycle[];
  visits: Visit[];
};

const SEM_SEGMENTO = "(Sem segmento)";

// Situação do cliente — MESMA regra da tela Gestão de Carteiras (server/carteira-routes.ts):
// inativo = cadastro inativado; perdido = cadastro ativo, comprava em 3+ meses e está há
// 3+ meses sem comprar; ativo = o resto. O "perdido" vem do endpoint da Gestão de Carteiras
// para as duas telas nunca discordarem.
const SITUACOES = ["Ativo", "Inativo", "Perdido"];
const SITUACAO_PADRAO = ["Ativo", "Perdido"];
const SITUACAO_AJUDA: { s: string; t: string }[] = [
  { s: "Ativo", t: "Cadastro ativo e comprando dentro do ritmo esperado. É o que a tela sempre mostrou." },
  { s: "Inativo", t: "Cadastro inativado no sistema, mas que ainda tem dia de rota. Não vem marcado — marque para vê-los." },
  { s: "Perdido", t: "Cadastro ativo, comprava com regularidade (3+ meses com compra) e está há 3+ meses sem comprar." },
];

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
// Valor curto para caber na célula do dia (a coluna tem ~46px): 512 · 1,2k · 12k.
// O valor cheio continua no tooltip da célula.
function valorCurto(n: number) {
  const v = Math.abs(n || 0);
  if (!v) return "";
  if (v >= 10000) return Math.round(v / 1000).toLocaleString("pt-BR") + "k";
  if (v >= 1000) return (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k";
  return Math.round(v).toLocaleString("pt-BR");
}
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
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [cityMulti, setCityMulti] = useState<string[]>([]);
  const [tipoMulti, setTipoMulti] = useState<string[]>([]);
  const [freq, setFreq] = useState("");
  const [segmento, setSegmento] = useState("");
  const [situacaoMulti, setSituacaoMulti] = useState<string[]>(SITUACAO_PADRAO);
  const [cardFiltro, setCardFiltro] = useState<StatusKey | null>(null);
  const [infoSituacao, setInfoSituacao] = useState(false);
  const [sortBy, setSortBy] = useState<{ key: "cliente" | "cidade" | "efet" | "freq" | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });

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
  // Ordem alfabética pt-BR: mantém juntas as variações do mesmo município que vêm do cadastro
  // com grafias diferentes (GOIANIA / Goiania / Goiânia / GOIANIA (GO)), facilitando marcar todas.
  // Situação "perdido" vem da Gestão de Carteiras (mesma regra dos dois lados), casada por CNPJ/CPF.
  const { data: carteira } = useQuery<any>({
    queryKey: ["/api/reports/gestao-carteiras"],
    queryFn: () => fetch("/api/reports/gestao-carteiras", { credentials: "include" }).then((r) => r.json()),
    staleTime: 10 * 60 * 1000,
  });
  const situacaoPorDoc = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of (carteira?.clientes || [])) {
      const d = String(c?.doc || "").replace(/\D/g, "");
      if (d) m.set(d, String(c?.situacao || ""));
    }
    return m;
  }, [carteira]);
  const situacaoDe = useMemo(() => (r: Row) => {
    if (r.cadastroAtivo === false) return "Inativo";
    const d = String(r.documento || "").replace(/\D/g, "");
    return situacaoPorDoc.get(d) === "perdido" ? "Perdido" : "Ativo";
  }, [situacaoPorDoc]);

  const cities = useMemo(() => Array.from(new Set(rows.map((r) => r.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")), [rows]);
  const freqs = useMemo(() => Array.from(new Set(rows.map((r) => r.periodicity).filter(Boolean))).sort(), [rows]);
  // PJ / PF / Não identificado — na ordem fixa, só as opções que existem nos dados.
  const tipos = useMemo(() => {
    const presentes = new Set(rows.map((r) => r.tipoPessoa || "Não identificado"));
    return ["PJ", "PF", "Não identificado"].filter((t) => presentes.has(t));
  }, [rows]);
  const segmentos = useMemo(() => {
    const lista = Array.from(new Set(rows.map((r) => (r.segmento || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR"));
    return rows.some((r) => !(r.segmento || "").trim()) ? [...lista, SEM_SEGMENTO] : lista;
  }, [rows]);

  // filteredBase = todos os filtros da barra, SEM o clique nos cards. É a base dos 8 cards
  // e dos totais do topo, para que o painel continue mostrando o panorama enquanto a grade
  // abaixo mostra só os clientes do card clicado.
  const filteredBase = useMemo(() => {
    // Normaliza espaços repetidos: nomes vindos do Omie podem ter espaço duplo
    // (ex.: "EMPORIO NOBRE  SETOR OESTE"), então a busca digitada com 1 espaço não casava.
    const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const q = norm(search);
    return rows.filter((r) => {
      if (!multiMatch(sellerMulti, r.sellerName || "")) return false;
      if (!multiMatch(cityMulti, r.city || "")) return false;
      if (!multiMatch(tipoMulti, r.tipoPessoa || "Não identificado")) return false;
      if (freq && r.periodicity !== freq) return false;
      if (segmento && ((r.segmento || "").trim() || SEM_SEGMENTO) !== segmento) return false;
      if (!multiMatch(situacaoMulti, situacaoDe(r))) return false;
      if (q && !(norm(r.customerName).includes(q) || norm(r.city).includes(q) || norm(r.neighborhood).includes(q))) return false;
      return true;
    });
  }, [rows, search, sellerMulti, cityMulti, tipoMulti, freq, segmento, situacaoMulti, situacaoDe]);

  // Clique num card = manter só os clientes que têm PELO MENOS UM dia naquela condição,
  // dentro do período e dos demais filtros. Clicar de novo no mesmo card limpa.
  const filtered = useMemo(() => {
    if (!cardFiltro) return filteredBase;
    return filteredBase.filter((r) => (r.visits || []).some((v) => cellStatus(v) === cardFiltro));
  }, [filteredBase, cardFiltro]);

  // Quantidade de clientes distintos considerando TODOS os filtros ativos (busca, vendedor, cidade, freq., período).
  const clientesCount = useMemo(() => new Set(filtered.map((r) => r.customerId)).size, [filtered]);

  // Efetividade: nota p/ ordenar (verde=2, amarelo=1, vermelho=0), normalizada 0..1.
  const efetScore = (r: Row) => {
    const cy = r.cycles || [];
    if (cy.length === 0) return -1;
    let s = 0;
    for (const c of cy) { s += c.green ? 1 : 0; }
    return s / cy.length;
  };

  const sorted = useMemo(() => {
    if (!sortBy.key) return filtered;
    const dir = sortBy.dir === "asc" ? 1 : -1;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let r = 0;
      if (sortBy.key === "cliente") r = (a.customerName || "").localeCompare(b.customerName || "", "pt-BR");
      else if (sortBy.key === "cidade") r = (a.city || "").localeCompare(b.city || "", "pt-BR");
      else if (sortBy.key === "freq") r = (a.periodicity || "").localeCompare(b.periodicity || "", "pt-BR");
      else if (sortBy.key === "efet") r = efetScore(a) - efetScore(b);
      return r * dir;
    });
    return arr;
  }, [filtered, sortBy]);

  const toggleSort = (key: "cliente" | "cidade" | "efet" | "freq") =>
    setSortBy((p) => (p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const sortArrow = (key: string) => (sortBy.key === key ? (sortBy.dir === "asc" ? " ▲" : " ▼") : "");

  // resumo por status sobre as células visíveis
  const summary = useMemo(() => {
    const s: Record<StatusKey, { n: number; sale: number; meta: number }> = {
      green: { n: 0, sale: 0, meta: 0 }, yellow: { n: 0, sale: 0, meta: 0 }, red: { n: 0, sale: 0, meta: 0 },
      orange: { n: 0, sale: 0, meta: 0 }, lilac: { n: 0, sale: 0, meta: 0 }, teal: { n: 0, sale: 0, meta: 0 },
      sky: { n: 0, sale: 0, meta: 0 }, blue: { n: 0, sale: 0, meta: 0 }, future: { n: 0, sale: 0, meta: 0 }, none: { n: 0, sale: 0, meta: 0 },
    };
    for (const r of filteredBase) {
      for (const v of r.visits || []) {
        const k = cellStatus(v);
        s[k].n++; s[k].sale += v.orderValue || 0; s[k].meta += v.metaValue || 0;
      }
    }
    return s;
  }, [filteredBase]);

  const agendadas = summary.green.n + summary.yellow.n + summary.orange.n + summary.red.n;

  // Totais do topo (mesmos filtros da grade): COM PEDIDO soma as Vendas dos 4 cards com venda;
  // SEM PEDIDO soma a Meta não cumprida dos 4 cards sem venda.
  const totais = useMemo(() => {
    const com = ["green", "lilac", "orange", "blue"] as StatusKey[];
    const sem = ["yellow", "red", "teal", "sky"] as StatusKey[];
    return {
      comN: com.reduce((a, k) => a + summary[k].n, 0),
      comV: com.reduce((a, k) => a + summary[k].sale, 0),
      semN: sem.reduce((a, k) => a + summary[k].n, 0),
      semV: sem.reduce((a, k) => a + summary[k].meta, 0),
    };
  }, [summary]);

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
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <i className="fas fa-calendar-check text-primary" /> Resumo de Visitas e Atendimentos
          </h1>
          <p className="text-muted-foreground text-sm">Calendário por cliente. Período: {ddmm(startDate)} a {ddmm(endDate)}. {clientesCount} {clientesCount === 1 ? "cliente" : "clientes"}.</p>
        </div>
        <div className="rounded-lg border px-3 py-2" style={{ borderLeft: "4px solid #166534", minWidth: 190 }} title="Soma das vendas dos atendimentos COM pedido (agendada+efetuada+pedido, não agendada+pedido, não efetuada+pedido, virtual+pedido) — respeita os filtros.">
          <div className="text-xs text-muted-foreground">Com pedido ({totais.comN})</div>
          <div className="text-xl font-bold" style={{ color: "#166534" }}>{money(totais.comV)}</div>
        </div>
        <div className="rounded-lg border px-3 py-2" style={{ borderLeft: "4px solid #991b1b", minWidth: 190 }} title="Soma da meta não cumprida dos atendimentos SEM pedido (efetuada sem pedido, não efetuada, fora de rota, virtual agendado) — respeita os filtros.">
          <div className="text-xs text-muted-foreground">Sem pedido ({totais.semN})</div>
          <div className="text-xl font-bold" style={{ color: "#991b1b" }}>{money(totais.semV)}</div>
        </div>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => {
          const st = STATUS[c.key];
          const isAg = c.key === "green" || c.key === "yellow" || c.key === "orange" || c.key === "red";
          const ativo = cardFiltro === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setCardFiltro((p) => (p === c.key ? null : c.key))}
              aria-pressed={ativo}
              data-testid={`card-${c.key}`}
              title={ativo ? "Clique para tirar o filtro deste card" : "Clique para ver só os clientes nesta condição"}
              className="rounded-lg border p-3 text-left transition-colors hover:bg-muted/40"
              style={{ borderLeft: `4px solid ${st.c}`, boxShadow: ativo ? `0 0 0 2px ${st.c}` : undefined, background: ativo ? st.bg : undefined }}
            >
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-xl font-bold" style={{ color: st.c }}>
                {summary[c.key].n}
                {isAg && <span className="text-xs font-normal text-muted-foreground"> ({pct(summary[c.key].n, agendadas)})</span>}
              </div>
              <div className="text-[11px] text-muted-foreground">{c.sub}</div>
            </button>
          );
        })}
      </div>

      {cardFiltro && (
        <div className="flex items-center gap-2 text-xs" data-testid="card-filtro-ativo">
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1" style={{ borderColor: STATUS[cardFiltro].c, color: STATUS[cardFiltro].c }}>
            <b>{cards.find((c) => c.key === cardFiltro)?.label}</b>
            <span className="text-muted-foreground">— {clientesCount} {clientesCount === 1 ? "cliente" : "clientes"}</span>
          </span>
          <button type="button" onClick={() => setCardFiltro(null)} className="underline text-muted-foreground" data-testid="limpar-card-filtro">limpar</button>
          <span className="text-muted-foreground">Os cards continuam mostrando o total do período, sem o recorte do card.</span>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <input className="border rounded px-2 py-1 text-sm" placeholder="Nome ou cidade..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220 }} />
        <input type="date" className="border rounded px-2 py-1 text-sm" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input type="date" className="border rounded px-2 py-1 text-sm" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <MultiSelect label="Vendedor" options={sellers} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller-resumo-visitas" />
        <MultiSelect label="Cidade" options={cities} selected={cityMulti} onChange={setCityMulti} testId="filter-city-resumo-visitas" />
        <MultiSelect label="Tipo" options={tipos} selected={tipoMulti} onChange={setTipoMulti} testId="filter-tipo-resumo-visitas" />
        <select className="border rounded px-2 py-1 text-sm" value={freq} onChange={(e) => setFreq(e.target.value)}><option value="">Todas as freq.</option>{freqs.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="border rounded px-2 py-1 text-sm" value={segmento} onChange={(e) => setSegmento(e.target.value)} style={{ maxWidth: 260 }} title="Segmento de negócio do cliente (derivado do CNAE)"><option value="">Todos os segmentos</option>{segmentos.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <div className="relative inline-block" data-testid="filter-situacao-wrap">
          <MultiSelect label="Situação" options={SITUACOES} selected={situacaoMulti} onChange={setSituacaoMulti} testId="filter-situacao-resumo-visitas" />
          <button
            type="button"
            onClick={() => setInfoSituacao((v) => !v)}
            title="O que significa cada situação"
            data-testid="info-situacao"
            className="absolute -top-2 -right-2 z-10 h-4 w-4 rounded-full border bg-white dark:bg-gray-800 dark:border-gray-600 text-[10px] leading-none font-bold text-gray-600 dark:text-gray-300 shadow-sm"
          >i</button>
          {infoSituacao && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setInfoSituacao(false)} />
              <div className="absolute z-50 right-0 top-full mt-1 w-80 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 shadow-lg p-3 text-xs space-y-2 text-left">
                <div className="font-semibold">O que significa cada situação</div>
                {SITUACAO_AJUDA.map((a) => (
                  <div key={a.s}><b>{a.s}</b> — <span className="text-muted-foreground">{a.t}</span></div>
                ))}
                <div className="text-[11px] text-muted-foreground border-t pt-2 dark:border-gray-700">
                  Mesma regra da tela Gestão de Carteiras. Nenhuma opção marcada = todas.
                </div>
              </div>
            </>
          )}
        </div>
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
                <th className={th} onClick={() => toggleSort("cliente")} style={{ ...stickyL(0), minWidth: 200, textAlign: "left", padding: "6px 8px", cursor: "pointer", userSelect: "none" }} title="Ordenar A-Z">Cliente <span style={{ fontWeight: 400, color: "#6b7280" }} title="Quantidade de clientes no filtro atual">({clientesCount})</span>{sortArrow("cliente")}</th>
                <th className={th} style={{ padding: "6px 8px", textAlign: "left", minWidth: 110 }}>Vendedor</th>
                <th className={th} onClick={() => toggleSort("cidade")} style={{ padding: "6px 8px", textAlign: "left", minWidth: 100, cursor: "pointer", userSelect: "none" }} title="Ordenar A-Z">Cidade{sortArrow("cidade")}</th>
                <th className={th} onClick={() => toggleSort("efet")} style={{ padding: "6px 8px", textAlign: "center", minWidth: 120, cursor: "pointer", userSelect: "none" }} title="Ordenar por efetividade. Verde = houve venda no ciclo (semana/quinzena/mês). Vermelho = sem venda.">Efetividade em vendas{sortArrow("efet")}</th>
                <th className={th} onClick={() => toggleSort("freq")} style={{ padding: "6px 8px", textAlign: "left", minWidth: 80, cursor: "pointer", userSelect: "none" }} title="Ordenar A-Z">Freq.{sortArrow("freq")}</th>
                {days.map((d) => (
                  <th key={d} className={th} style={{ padding: "4px 3px", textAlign: "center", minWidth: 46, color: isWeekend(d) ? "#9ca3af" : undefined, whiteSpace: "nowrap", fontWeight: 500 }}>{ddmm(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const cm = cellMapFor(r);
                return (
                  <tr key={`${r.customerId}-${r.sellerName}-${i}`} className="border-t hover:bg-muted/20">
                    <td style={{ ...stickyL(0), padding: "4px 8px", fontWeight: 500, whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={r.customerName}>{r.customerName}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.sellerName}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.city}</td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap", textAlign: "center" }}>
                      {(r.cycles && r.cycles.length > 0) ? r.cycles.map((cy, ci) => (
                        <span key={ci} title={`${cy.start} a ${cy.end}: ${cy.green ? "houve venda" : "sem venda"}`} style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: cy.green ? "#22c55e" : "#ef4444", marginRight: 3, verticalAlign: "middle" }} />
                      )) : <span style={{ color: "#9ca3af" }}>—</span>}
                    </td>
                    <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.periodicity}</td>
                    {days.map((d) => {
                      const v = cm.get(d);
                      const k = cellStatus(v);
                      const st = STATUS[k];
                      const sale = v && (k === "green" || k === "orange" || k === "lilac" || k === "blue") ? v.orderValue || 0 : 0;
                      const next = v && k === "future" ? v.nextSaleValue || v.metaValue || 0 : 0;
                      const title = st.t + (sale ? ` • ${money(sale)}` : "") + (next ? ` • Próxima Venda: ${money(next)}` : "");
                      return (
                        <td key={d} title={title} style={{ textAlign: "center", padding: "3px 2px", background: st.bg, color: st.c, fontWeight: 700, borderLeft: "1px solid #f1f5f9" }}>
                          {sale ? (
                            <span style={{ display: "inline-block", lineHeight: 1.05 }}>
                              <span style={{ display: "block", fontSize: 10 }}>{st.g}</span>
                              <span style={{ display: "block", fontSize: 9, fontWeight: 700, letterSpacing: "-0.02em" }}>{valorCurto(sale)}</span>
                            </span>
                          ) : st.g}
                        </td>
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
