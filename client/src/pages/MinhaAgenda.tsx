// client/src/pages/MinhaAgenda.tsx
// -----------------------------------------------------------------------------
// MINHA AGENDA — estilo Google Agenda (26/10/2026)
// Visoes Dia/Semana/Mes/Lista, criar por clique/arraste, mover e redimensionar,
// resumo do evento com Editar/Duplicar/Concluir/Excluir, cores livres, busca.
// Cada usuario ve so a propria agenda (escopo no servidor, /api/agenda/*).
// Sem recorrencia, sem compartilhamento, sem lembretes — por decisao (26/10).
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import ptBr from "@fullcalendar/core/locales/pt-br";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, ChevronRight, Plus, Search, MapPin, Check, Copy, Pencil, Trash2, X } from "lucide-react";

type Ev = {
  id: string; title: string; description: string; start: string; end: string | null;
  allDay: boolean; location: string; color: string; status: "pending" | "done"; priority: string;
};
type Draft = Partial<Omit<Ev, "start" | "end">> & { start: Date; end?: Date | null };

const COR_PADRAO = "#2a78d6";
// Cores por vendedor no modo Clientes (fixas por posicao na lista).
const CORES_VEND = ["#2a78d6", "#16a34a", "#d03b3b", "#7c3aed", "#eda100", "#0891b2", "#db2777", "#475569", "#65a30d", "#c2410c"];
type CliRota = { dia: string; id: string; nome: string; cidade: string; bairro: string; periodicidade: string; semana: string | null; virtual: boolean; sellerId: string; sellerNome: string };
const CORES_SUGERIDAS = ["#2a78d6", "#d03b3b", "#7c3aed", "#eda100", "#16a34a", "#0891b2", "#db2777", "#6b7280"];
const VIEWS: Array<[string, string]> = [["timeGridDay", "Dia"], ["timeGridWeek", "Semana"], ["dayGridMonth", "Mês"], ["listWeek", "Lista"]];

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toLocalInput = (d: Date | null | undefined, allDay: boolean) =>
  !d ? "" : allDay ? isoDate(d) : `${isoDate(d)}T${hm(d)}`;
const fmtDia = (d: Date) => d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());

export default function MinhaAgenda() {
  const calRef = useRef<FullCalendar>(null);
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [view, setView] = useState(() => (window.innerWidth < 760 ? "timeGridDay" : "timeGridWeek"));
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [busca, setBusca] = useState("");
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());
  const [miniMes, setMiniMes] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [dataCal, setDataCal] = useState(new Date());
  const [quick, setQuick] = useState<{ start: Date; end: Date; allDay: boolean; x: number; y: number } | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [sel, setSel] = useState<{ ev: Ev; x: number; y: number } | null>(null);
  const [modal, setModal] = useState<{ draft: Draft; mode: "new" | "edit" | "dup" } | null>(null);
  // Modo do calendario: "agenda" (eventos pessoais) ou "clientes" (clientes da Rota do Dia).
  // Um esconde o outro.
  const [modo, setModo] = useState<"agenda" | "clientes">(() => { try { return localStorage.getItem("agenda-modo") === "clientes" ? "clientes" : "agenda"; } catch { return "agenda"; } });
  useEffect(() => { try { localStorage.setItem("agenda-modo", modo); } catch {} }, [modo]);

  // Altura da faixa "dia inteiro": quantas linhas de evento aparecem antes do "+N mais".
  // Regulada arrastando a barra divisória (fc-timegrid-divider). Lembrada por navegador.
  const ALLDAY_PADRAO = 3, ALLDAY_MIN = 1, ALLDAY_MAX = 40, LINHA_PX = 24;
  const [allDayRows, setAllDayRows] = useState<number>(() => {
    try { const n = parseInt(localStorage.getItem("agenda-allday-rows") || "", 10); return n >= ALLDAY_MIN && n <= ALLDAY_MAX ? n : ALLDAY_PADRAO; } catch { return ALLDAY_PADRAO; }
  });
  useEffect(() => { try { localStorage.setItem("agenda-allday-rows", String(allDayRows)); } catch {} }, [allDayRows]);
  const secRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ y0: number; rows0: number } | null>(null);
  useEffect(() => {
    const sec = secRef.current; if (!sec) return;
    const ehAlca = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.(".fc-timegrid-divider");
    const down = (e: PointerEvent) => {
      if (!ehAlca(e.target)) return;
      e.preventDefault();
      dragRef.current = { y0: e.clientY, rows0: allDayRows };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const n = Math.max(ALLDAY_MIN, Math.min(ALLDAY_MAX, d.rows0 + Math.round((e.clientY - d.y0) / LINHA_PX)));
      setAllDayRows((cur) => (cur === n ? cur : n));
    };
    const up = () => { if (!dragRef.current) return; dragRef.current = null; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    const dbl = (e: MouseEvent) => { if (ehAlca(e.target)) setAllDayRows(ALLDAY_PADRAO); };
    sec.addEventListener("pointerdown", down);
    sec.addEventListener("dblclick", dbl);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    return () => {
      sec.removeEventListener("pointerdown", down); sec.removeEventListener("dblclick", dbl);
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up);
    };
  }, [allDayRows]);
  const [vendSel, setVendSel] = useState<string[]>([]);
  const [cliSel, setCliSel] = useState<{ c: CliRota; x: number; y: number } | null>(null);

  const { data: eventos = [], isLoading } = useQuery<Ev[]>({
    queryKey: ["/api/agenda/items", range?.start, range?.end],
    queryFn: () => apiRequest("GET", `/api/agenda/items?start=${encodeURIComponent(range!.start)}&end=${encodeURIComponent(range!.end)}`),
    enabled: !!range,
  });
  const { data: cliResp, isLoading: cliLoading } = useQuery<{ admin: boolean; clientes: CliRota[] }>({
    queryKey: ["/api/agenda/clientes-rota", range?.start, range?.end, vendSel.join(",")],
    queryFn: () => apiRequest("GET", `/api/agenda/clientes-rota?start=${encodeURIComponent(range!.start)}&end=${encodeURIComponent(range!.end)}${vendSel.length ? `&sellers=${encodeURIComponent(vendSel.join(","))}` : ""}`),
    enabled: !!range && modo === "clientes",
    staleTime: 60_000,
  });
  const { data: vendedores = [] } = useQuery<{ id: string; nome: string }[]>({
    queryKey: ["/api/agenda/vendedores"],
    queryFn: () => apiRequest("GET", "/api/agenda/vendedores"),
    enabled: modo === "clientes",
    staleTime: 300_000,
  });
  const ehAdmin = !!cliResp?.admin;
  const clientes = cliResp?.clientes || [];
  const corVend = useMemo(() => {
    const ids = Array.from(new Set([...vendedores.map((v) => v.id), ...clientes.map((c) => c.sellerId)]));
    const m: Record<string, string> = {};
    ids.forEach((id, i) => { m[id] = CORES_VEND[i % CORES_VEND.length]; });
    return m;
  }, [vendedores, clientes]);
  const cliEvents = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return clientes
      .filter((c) => !q || `${c.nome} ${c.cidade} ${c.bairro} ${c.sellerNome}`.toLowerCase().includes(q))
      .map((c) => ({
        id: `cli:${c.id}:${c.dia}`, title: `${c.virtual ? "☎ " : ""}${c.nome}${ehAdmin ? ` · ${c.sellerNome}` : ""}`, start: c.dia, allDay: true,
        backgroundColor: corVend[c.sellerId] || COR_PADRAO, borderColor: corVend[c.sellerId] || COR_PADRAO, editable: false,
        extendedProps: { cli: c },
      }));
  }, [clientes, busca, corVend, ehAdmin]);
  const { data: cores = [] } = useQuery<{ color: string; n: number }[]>({
    queryKey: ["/api/agenda/colors"],
    queryFn: () => apiRequest("GET", "/api/agenda/colors"),
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/agenda/items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/agenda/colors"] });
  };
  const erro = (e: any) => toast({ title: "Erro", description: e?.message || "Não foi possível salvar", variant: "destructive" });

  const criar = useMutation({ mutationFn: (d: any) => apiRequest("POST", "/api/agenda/items", d), onSuccess: invalidar, onError: erro });
  const alterar = useMutation({ mutationFn: ({ id, ...d }: any) => apiRequest("PATCH", `/api/agenda/items/${id}`, d), onSuccess: invalidar, onError: erro });
  const excluir = useMutation({ mutationFn: (id: string) => apiRequest("DELETE", `/api/agenda/items/${id}`), onSuccess: invalidar, onError: erro });

  const fcEvents = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return eventos
      .filter((e) => !ocultas.has(e.color) && (!q || `${e.title} ${e.location} ${e.description}`.toLowerCase().includes(q)))
      .map((e) => ({
        id: e.id, title: e.title, start: e.start, end: e.end || undefined, allDay: e.allDay,
        backgroundColor: e.color, borderColor: e.color, classNames: e.status === "done" ? ["agenda-done"] : [],
      }));
  }, [eventos, busca, ocultas]);

  const api = () => calRef.current?.getApi();
  const fechar = useCallback(() => { setQuick(null); setSel(null); api()?.unselect(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") fechar(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [fechar]);

  const posicionar = (x: number, y: number, w = 340, h = 230) => {
    let px = x + 12, py = y - 20;
    if (px + w > window.innerWidth - 12) px = x - w - 12;
    if (px < 12) px = 12;
    if (py + h > window.innerHeight - 12) py = window.innerHeight - h - 12;
    if (py < 12) py = 12;
    return { left: px, top: py };
  };

  const abrirNovo = () => {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    setModal({ draft: { start: s, end: e, allDay: false, color: cores[0]?.color || COR_PADRAO }, mode: "new" });
  };

  const salvarQuick = () => {
    if (!quick) return;
    const t = quickTitle.trim(); if (!t) return;
    criar.mutate({ title: t, start: quick.start, end: quick.allDay ? null : quick.end, allDay: quick.allDay, color: cores[0]?.color || COR_PADRAO });
    setQuickTitle(""); fechar();
  };

  const duplicar = (ev: Ev) => {
    const s = new Date(ev.start); s.setDate(s.getDate() + 7);
    const e = ev.end ? new Date(ev.end) : null; if (e) e.setDate(e.getDate() + 7);
    setSel(null);
    setModal({ draft: { ...ev, id: undefined, status: "pending", start: s, end: e }, mode: "dup" });
  };

  // ---------- mini calendário ----------
  const mini = useMemo(() => {
    const y = miniMes.getFullYear(), m = miniMes.getMonth();
    const first = new Date(y, m, 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const hoje = isoDate(new Date()), cur = isoDate(dataCal);
    const semanas: Date[][] = [];
    for (let r = 0; r < 6; r++) semanas.push(Array.from({ length: 7 }, (_, c) => { const d = new Date(start); d.setDate(start.getDate() + r * 7 + c); return d; }));
    return { y, m, semanas, hoje, cur, label: cap(first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })) };
  }, [miniMes, dataCal]);

  return (
    <div className="p-4 md:p-6 flex flex-col">
      <style>{`
        .agenda .fc{--fc-border-color:var(--border);--fc-page-bg-color:var(--background);--fc-neutral-bg-color:var(--muted);--fc-today-bg-color:transparent;--fc-now-indicator-color:#d03b3b;--fc-list-event-hover-bg-color:var(--muted);--fc-highlight-color:rgba(42,120,214,.18);font-size:12.5px}
        .agenda .fc a{color:inherit;text-decoration:none}
        .agenda .fc .fc-col-header-cell-cushion{padding:8px 4px;text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:var(--muted-foreground)}
        .agenda .fc .fc-timegrid-slot-label-cushion,.agenda .fc .fc-timegrid-axis-cushion{color:var(--muted-foreground);font-size:11px}
        .agenda .fc .fc-day-today .fc-col-header-cell-cushion{color:#2a78d6;font-weight:700}
        .agenda .fc .fc-day-today .fc-daygrid-day-number{background:#2a78d6;color:#fff;border-radius:50%;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;margin:3px}
        .agenda .fc-event{border:0;border-radius:4px;padding:1px 4px;font-size:12px;cursor:pointer;color:#fff}
        .agenda .fc-event.agenda-done{opacity:.55;text-decoration:line-through}
        .agenda .fc .fc-timegrid-slot{height:2.6em}
        .agenda .fc .fc-list-event-title a{color:inherit}
        /* Lista: fc-list-event tambem tem a classe fc-event (texto branco) e sumia no fundo claro */
        .agenda .fc .fc-list-event{color:var(--foreground);padding:0;border-radius:0;font-size:13px}
        .agenda .fc .fc-list-event td{color:var(--foreground)}
        .agenda .fc .fc-list-event-time{color:var(--muted-foreground)}
        .agenda .fc .fc-list-day-cushion{background:var(--muted)}
        .agenda .fc .fc-scrollgrid{border-radius:8px;overflow:hidden}
        /* Barra entre "dia inteiro" e as horas = alça: arrasta p/ ampliar/reduzir a faixa; duplo clique volta ao padrão */
        .agenda .fc .fc-timegrid-divider{cursor:row-resize;height:10px;padding:0;background:var(--muted);position:relative;touch-action:none;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
        .agenda .fc .fc-timegrid-divider:hover{background:color-mix(in srgb, #2a78d6 25%, var(--muted))}
        .agenda .fc .fc-timegrid-divider::after{content:"";position:absolute;left:50%;top:3px;width:44px;height:3px;margin-left:-22px;border-radius:2px;background:var(--muted-foreground);opacity:.55}
        /* Linhas verticais suaves separando os dias (Semana e Mes) e horas mais leves */
        .agenda .fc .fc-timegrid-col,.agenda .fc .fc-col-header-cell,.agenda .fc .fc-daygrid-day{border-left:1px solid var(--border) !important;border-right:1px solid var(--border) !important}
        .agenda .fc .fc-daygrid-day{border-top:1px solid var(--border) !important;border-bottom:1px solid var(--border) !important}
        .agenda .fc .fc-timegrid-slot{border-top:1px solid color-mix(in srgb, var(--border) 60%, transparent) !important}
        .agenda .fc .fc-timegrid-slot-minor{border-top:1px dotted color-mix(in srgb, var(--border) 40%, transparent) !important}
      `}</style>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <BackToDashboardButton />
        <h1 className="text-xl font-semibold mr-2">Minha Agenda</h1>
        <Button variant="outline" size="sm" onClick={() => api()?.today()} data-testid="agenda-hoje">Hoje</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label="Anterior" onClick={() => api()?.prev()}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label="Próximo" onClick={() => api()?.next()}><ChevronRight className="h-4 w-4" /></Button>
        <div className="text-lg font-medium min-w-[150px]" data-testid="agenda-titulo">{cap(title)}</div>
        <div className="flex-1" />
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input id="agenda-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Pesquisar" className="pl-8 w-[150px] md:w-[220px] h-9" />
        </div>
        <div className="flex rounded-md border overflow-hidden" role="group" aria-label="Mostrar">
          {([["agenda", "Agenda"], ["clientes", "Clientes"]] as const).map(([m, l]) => (
            <button key={m} className={`px-3 py-1.5 text-sm ${modo === m ? "bg-emerald-600 text-white" : "hover:bg-muted"}`}
              onClick={() => { setModo(m); fechar(); setCliSel(null); }} data-testid={`agenda-modo-${m}`}>{l}</button>
          ))}
        </div>
        <div className="flex rounded-md border overflow-hidden">
          {VIEWS.map(([v, l]) => (
            <button key={v} className={`px-3 py-1.5 text-sm ${view === v ? "bg-blue-600 text-white" : "hover:bg-muted"}`}
              onClick={() => { setView(v); api()?.changeView(v); }} data-testid={`agenda-view-${v}`}>{l}</button>
          ))}
        </div>
      </div>

      <div className="flex gap-4 agenda" style={{ height: "calc(100vh - 150px)", minHeight: 520 }}>
        <aside className="hidden md:flex w-[240px] flex-none flex-col gap-4 overflow-auto pr-1">
          {modo === "agenda" && <Button onClick={abrirNovo} className="rounded-full self-start shadow bg-white text-foreground border hover:bg-muted h-11 px-5 dark:bg-background" data-testid="agenda-criar">
            <Plus className="h-5 w-5 text-blue-600 mr-2" /> Criar
          </Button>}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold">{mini.label}</span>
              <span className="flex">
                <button className="h-6 w-6 rounded-full hover:bg-muted" aria-label="Mês anterior" onClick={() => setMiniMes(new Date(mini.y, mini.m - 1, 1))}>‹</button>
                <button className="h-6 w-6 rounded-full hover:bg-muted" aria-label="Mês seguinte" onClick={() => setMiniMes(new Date(mini.y, mini.m + 1, 1))}>›</button>
              </span>
            </div>
            <table className="w-full text-center text-[11.5px] tabular-nums">
              <thead><tr>{["D", "S", "T", "Q", "Q", "S", "S"].map((d, i) => <th key={i} className="font-medium text-muted-foreground py-1">{d}</th>)}</tr></thead>
              <tbody>{mini.semanas.map((sem, r) => (
                <tr key={r}>{sem.map((d) => {
                  const k = isoDate(d), fora = d.getMonth() !== mini.m, hoje = k === mini.hoje, selDia = k === mini.cur;
                  return (
                    <td key={k} className="p-0">
                      <button onClick={() => api()?.gotoDate(k)}
                        className={`h-[26px] w-[26px] rounded-full mx-auto my-[1px] block hover:bg-muted ${fora ? "text-muted-foreground/60" : ""} ${hoje ? "bg-blue-600 text-white font-semibold hover:bg-blue-600" : ""} ${selDia && !hoje ? "ring-2 ring-blue-500" : ""}`}>
                        {d.getDate()}
                      </button>
                    </td>
                  );
                })}</tr>
              ))}</tbody>
            </table>
          </div>
          {modo === "clientes" ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{ehAdmin ? "Vendedores" : "Meus clientes"}</div>
              {ehAdmin ? (
                <>
                  <div className="flex gap-3 text-xs mb-1">
                    <button className="text-blue-600 hover:underline" onClick={() => setVendSel([])}>Todos</button>
                  </div>
                  {vendedores.map((v) => {
                    const on = vendSel.length === 0 || vendSel.includes(v.id);
                    const n = clientes.filter((c) => c.sellerId === v.id).length;
                    return (
                      <label key={v.id} className="flex items-center gap-2 py-1 text-sm cursor-pointer">
                        <Checkbox checked={on} onCheckedChange={(ck) => setVendSel((s0) => {
                          const base = s0.length === 0 ? vendedores.map((x) => x.id) : s0;
                          const n2 = ck ? Array.from(new Set([...base, v.id])) : base.filter((x) => x !== v.id);
                          return n2.length === vendedores.length ? [] : n2;
                        })} />
                        <span className="h-3 w-3 rounded-sm flex-none" style={{ background: corVend[v.id] }} />
                        <span className="flex-1 truncate">{v.nome}</span>
                        {vendSel.length === 0 || vendSel.includes(v.id) ? <span className="text-xs text-muted-foreground">{n}</span> : null}
                      </label>
                    );
                  })}
                </>
              ) : (
                <div className="text-xs text-muted-foreground">{clientes.length} visita(s) no período.</div>
              )}
            </div>
          ) : (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Cores</div>
            {cores.length === 0 && <div className="text-xs text-muted-foreground">Crie o primeiro evento para ver as cores aqui.</div>}
            {cores.map((c) => (
              <label key={c.color} className="flex items-center gap-2 py-1 text-sm cursor-pointer">
                <Checkbox checked={!ocultas.has(c.color)} onCheckedChange={(v) => setOcultas((s) => { const n = new Set(s); v ? n.delete(c.color) : n.add(c.color); return n; })} />
                <span className="h-3 w-3 rounded-sm flex-none" style={{ background: c.color }} />
                <span className="flex-1">{c.color}</span>
                <span className="text-xs text-muted-foreground">{c.n}</span>
              </label>
            ))}
          </div>
          )}
          <div className="text-[11.5px] text-muted-foreground leading-relaxed border-t pt-2">
            {modo === "clientes"
              ? "Clientes da Rota do Dia pela periodicidade, dia da semana e semana do mês do cadastro. Muda sozinho quando o cadastro muda. ☎ = atendimento virtual."
              : "Clique num horário vazio para criar, arraste para mover, estique a borda para mudar a duração. Só você vê esta agenda."}
            <div className="mt-1">Arraste a barra entre "dia inteiro" e as horas para ampliar ou reduzir a faixa ({allDayRows} {allDayRows === 1 ? "linha" : "linhas"}); duplo clique volta ao padrão.</div>
          </div>
        </aside>

        <section ref={secRef} className="flex-1 min-w-0 relative">
          {(modo === "agenda" ? isLoading : cliLoading) && <div className="absolute right-2 top-2 text-xs text-muted-foreground z-10">Carregando…</div>}
          <FullCalendar
            ref={calRef}
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            initialView={view}
            locale={ptBr}
            headerToolbar={false}
            height="100%"
            firstDay={0}
            nowIndicator
            slotMinTime="06:00:00"
            slotMaxTime="22:00:00"
            scrollTime="08:00:00"
            allDaySlot
            allDayText="dia inteiro"
            dayMaxEvents={allDayRows}
            moreLinkText={(n) => `+${n} mais`}
            slotLabelFormat={{ hour: "numeric", minute: "2-digit", hour12: false }}
            eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
            selectable={modo === "agenda"}
            editable={modo === "agenda"}
            eventResizableFromStart
            selectMirror
            events={modo === "agenda" ? fcEvents : cliEvents}
            datesSet={(a) => {
              setTitle(a.view.title);
              setDataCal(a.view.calendar.getDate());
              setRange({ start: a.start.toISOString(), end: a.end.toISOString() });
            }}
            select={(info) => {
              setSel(null); setQuickTitle("");
              const pt = info.jsEvent ? { x: info.jsEvent.clientX, y: info.jsEvent.clientY } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
              setQuick({ start: info.start, end: info.end, allDay: info.allDay, ...pt });
            }}
            eventClick={(info) => {
              info.jsEvent.preventDefault();
              const cli = (info.event.extendedProps as any)?.cli as CliRota | undefined;
              if (cli) { setQuick(null); setSel(null); setCliSel({ c: cli, x: info.jsEvent.clientX, y: info.jsEvent.clientY }); return; }
              const ev = eventos.find((e) => e.id === info.event.id);
              if (ev) { setQuick(null); setSel({ ev, x: info.jsEvent.clientX, y: info.jsEvent.clientY }); }
            }}
            eventDrop={(info) => alterar.mutate({ id: info.event.id, start: info.event.start, end: info.event.end, allDay: info.event.allDay }, { onError: () => info.revert() })}
            eventResize={(info) => alterar.mutate({ id: info.event.id, start: info.event.start, end: info.event.end }, { onError: () => info.revert() })}
          />
        </section>
      </div>

      {/* popup rápido de criação */}
      {quick && (
        <div className="fixed z-50 w-[340px] max-w-[calc(100vw-32px)] rounded-xl border bg-background shadow-xl p-4" style={posicionar(quick.x, quick.y)} data-testid="agenda-quick">
          <button className="absolute right-2 top-2 h-7 w-7 rounded-full hover:bg-muted flex items-center justify-center" onClick={fechar} aria-label="Fechar"><X className="h-4 w-4" /></button>
          <input id="agenda-quick-titulo" autoFocus value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") salvarQuick(); }} placeholder="Adicionar título"
            className="w-full bg-transparent text-base border-0 border-b-2 border-blue-600 px-0.5 py-1.5 outline-none mt-1" />
          <p className="text-sm text-muted-foreground mt-2">{fmtDia(quick.start)}{quick.allDay ? " · dia inteiro" : ` · ${hm(quick.start)} – ${hm(quick.end)}`}</p>
          <div className="flex gap-2 mt-3">
            <Button variant="outline" size="sm" onClick={() => { const t = quickTitle; fechar(); setModal({ draft: { title: t, start: quick.start, end: quick.end, allDay: quick.allDay, color: cores[0]?.color || COR_PADRAO }, mode: "new" }); }}>Mais opções</Button>
            <div className="flex-1" />
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" onClick={salvarQuick} data-testid="agenda-quick-salvar">Salvar</Button>
          </div>
        </div>
      )}

      {/* resumo do cliente da rota */}
      {cliSel && (
        <div className="fixed z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-xl border bg-background shadow-xl p-4" style={posicionar(cliSel.x, cliSel.y, 320, 200)} data-testid="agenda-cliente">
          <button className="absolute right-2 top-2 h-7 w-7 rounded-full hover:bg-muted flex items-center justify-center" onClick={() => setCliSel(null)} aria-label="Fechar"><X className="h-4 w-4" /></button>
          <h3 className="text-base font-semibold pr-7 mt-1">{cliSel.c.nome}</h3>
          <p className="text-sm text-muted-foreground mt-1">{fmtDia(new Date(cliSel.c.dia + "T12:00:00"))}</p>
          <div className="text-sm mt-2 grid gap-1">
            {(cliSel.c.bairro || cliSel.c.cidade) && <div className="flex gap-2"><MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />{[cliSel.c.bairro, cliSel.c.cidade].filter(Boolean).join(" · ")}</div>}
            <div>Periodicidade: <b>{cliSel.c.periodicidade}</b>{cliSel.c.semana && cliSel.c.semana !== "toda" ? ` · semana ${cliSel.c.semana}` : ""}{cliSel.c.virtual ? " · virtual" : ""}</div>
            <div>Vendedor: <b>{cliSel.c.sellerNome}</b></div>
          </div>
        </div>
      )}

      {/* resumo do evento */}
      {sel && (
        <div className="fixed z-50 w-[340px] max-w-[calc(100vw-32px)] rounded-xl border bg-background shadow-xl p-4" style={posicionar(sel.x, sel.y)} data-testid="agenda-resumo">
          <button className="absolute right-2 top-2 h-7 w-7 rounded-full hover:bg-muted flex items-center justify-center" onClick={fechar} aria-label="Fechar"><X className="h-4 w-4" /></button>
          <h3 className="text-base font-semibold flex items-center gap-2 pr-7 mt-1">
            <span className="h-3.5 w-3.5 rounded flex-none" style={{ background: sel.ev.color }} />{sel.ev.title}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {fmtDia(new Date(sel.ev.start))}{sel.ev.allDay ? " · dia inteiro" : ` · ${hm(new Date(sel.ev.start))}${sel.ev.end ? " – " + hm(new Date(sel.ev.end)) : ""}`}
          </p>
          {sel.ev.location && <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{sel.ev.location}</p>}
          {sel.ev.description && <p className="text-sm mt-2 whitespace-pre-wrap">{sel.ev.description}</p>}
          <p className="text-xs text-muted-foreground mt-2">{sel.ev.status === "done" ? "✓ Concluído" : "Pendente"}</p>
          <div className="flex gap-1.5 mt-3 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => { const ev = sel.ev; setSel(null); setModal({ draft: { ...ev, start: new Date(ev.start), end: ev.end ? new Date(ev.end) : null }, mode: "edit" }); }}><Pencil className="h-3.5 w-3.5 mr-1" />Editar</Button>
            <Button variant="outline" size="sm" onClick={() => duplicar(sel.ev)} data-testid="agenda-duplicar"><Copy className="h-3.5 w-3.5 mr-1" />Duplicar</Button>
            <Button variant="outline" size="sm" onClick={() => { alterar.mutate({ id: sel.ev.id, status: sel.ev.status === "done" ? "pending" : "done" }); setSel(null); }}><Check className="h-3.5 w-3.5 mr-1" />{sel.ev.status === "done" ? "Reabrir" : "Concluir"}</Button>
            <Button variant="outline" size="sm" className="text-red-600 border-red-300" onClick={() => { excluir.mutate(sel.ev.id); setSel(null); }}><Trash2 className="h-3.5 w-3.5 mr-1" />Excluir</Button>
          </div>
        </div>
      )}

      {modal && (
        <EventoModal
          draft={modal.draft} mode={modal.mode} cores={cores.map((c) => c.color)}
          onClose={() => setModal(null)}
          onDelete={modal.mode === "edit" && modal.draft.id ? () => { excluir.mutate(modal.draft.id!); setModal(null); } : undefined}
          onSave={(d) => {
            if (modal.mode === "edit" && modal.draft.id) alterar.mutate({ id: modal.draft.id, ...d });
            else criar.mutate(d);
            setModal(null);
            api()?.gotoDate(d.start);
          }}
        />
      )}
    </div>
  );
}

function EventoModal({ draft, mode, cores, onClose, onSave, onDelete }: {
  draft: Draft; mode: "new" | "edit" | "dup"; cores: string[];
  onClose: () => void; onSave: (d: any) => void; onDelete?: () => void;
}) {
  const [titulo, setTitulo] = useState(draft.title || "");
  const [allDay, setAllDay] = useState(!!draft.allDay);
  const [inicio, setInicio] = useState(toLocalInput(draft.start, !!draft.allDay));
  const [fim, setFim] = useState(toLocalInput(draft.end || draft.start, !!draft.allDay));
  const [local, setLocal] = useState(draft.location || "");
  const [desc, setDesc] = useState(draft.description || "");
  const [cor, setCor] = useState(draft.color || COR_PADRAO);
  const [status, setStatus] = useState<"pending" | "done">(draft.status || "pending");
  const [erro, setErro] = useState("");
  const paleta = Array.from(new Set([...cores, ...CORES_SUGERIDAS]));

  const toggleAllDay = (v: boolean) => {
    setAllDay(v);
    const s = inicio ? new Date(inicio) : draft.start; const e = fim ? new Date(fim) : draft.end || draft.start;
    setInicio(toLocalInput(s, v)); setFim(toLocalInput(e, v));
  };
  const salvar = () => {
    const t = titulo.trim(); if (!t) return setErro("Informe o título");
    const s = new Date(inicio); if (isNaN(s.getTime())) return setErro("Informe o início");
    let e: Date | null = fim ? new Date(fim) : null; if (e && isNaN(e.getTime())) e = null;
    onSave({ title: t, allDay, start: s, end: allDay ? null : e, location: local.trim(), description: desc.trim(), color: cor, status });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{mode === "dup" ? "Duplicar evento" : mode === "new" ? "Novo evento" : "Editar evento"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="sm:col-span-2 text-xs text-muted-foreground flex flex-col gap-1">Título
            <Input id="agenda-f-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Adicionar título" autoFocus /></label>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm"><Checkbox checked={allDay} onCheckedChange={(v) => toggleAllDay(!!v)} /> Dia inteiro</label>
          <label className="text-xs text-muted-foreground flex flex-col gap-1">Início
            <Input id="agenda-f-inicio" type={allDay ? "date" : "datetime-local"} value={inicio} onChange={(e) => setInicio(e.target.value)} /></label>
          <label className="text-xs text-muted-foreground flex flex-col gap-1">Fim
            <Input id="agenda-f-fim" type={allDay ? "date" : "datetime-local"} value={fim} onChange={(e) => setFim(e.target.value)} disabled={allDay} /></label>
          <label className="sm:col-span-2 text-xs text-muted-foreground flex flex-col gap-1">Local
            <Input id="agenda-f-local" value={local} onChange={(e) => setLocal(e.target.value)} placeholder="Cliente, endereço, link..." /></label>
          <label className="sm:col-span-2 text-xs text-muted-foreground flex flex-col gap-1">Descrição
            <Textarea id="agenda-f-desc" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <div className="sm:col-span-2 text-xs text-muted-foreground flex flex-col gap-1">Cor
            <div className="flex items-center gap-1.5 flex-wrap">
              {paleta.map((c) => (
                <button key={c} type="button" title={c} onClick={() => setCor(c)} className="h-6 w-6 rounded-full border-2" style={{ background: c, borderColor: cor === c ? "hsl(var(--foreground))" : "transparent" }} />
              ))}
              <input id="agenda-f-cor" type="color" value={cor} onChange={(e) => setCor(e.target.value)} className="h-7 w-9 p-0.5 border rounded cursor-pointer bg-transparent" title="Cor personalizada" />
            </div>
          </div>
          <label className="text-xs text-muted-foreground flex flex-col gap-1">Status
            <select id="agenda-f-status" value={status} onChange={(e) => setStatus(e.target.value as any)} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
              <option value="pending">Pendente</option><option value="done">Concluído</option>
            </select></label>
        </div>
        {erro && <p className="text-sm text-red-600">{erro}</p>}
        <div className="flex justify-between gap-2 mt-2 flex-wrap">
          <span>{onDelete && <Button variant="outline" className="text-red-600 border-red-300" onClick={onDelete}>Excluir</Button>}</span>
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button className="bg-blue-600 hover:bg-blue-700 text-white" onClick={salvar} data-testid="agenda-f-salvar">Salvar</Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
