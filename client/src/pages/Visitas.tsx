import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import SyncedTable from "@/components/SyncedTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, Users, CalendarDays } from "lucide-react";
import { exportToExcel, ExportExcelButton } from "@/lib/tableTools";

// Dias da semana na ordem de rota (Seg–Sáb; Domingo só aparece se houver cliente nele).
const DIAS: { key: string; label: string }[] = [
  { key: "Seg", label: "Segunda" },
  { key: "Ter", label: "Terça" },
  { key: "Qua", label: "Quarta" },
  { key: "Qui", label: "Quinta" },
  { key: "Sex", label: "Sexta" },
  { key: "Sab", label: "Sábado" },
  { key: "Dom", label: "Domingo" },
];

// Normaliza um token de dia (aceita "Seg", "segunda", "SÁB", etc.) para a chave canônica.
const DAY_MAP: Record<string, string> = {
  seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sab", dom: "Dom",
  "sáb": "Sab", segunda: "Seg", terca: "Ter", "terça": "Ter", quarta: "Qua", quinta: "Qui",
  sexta: "Sex", sabado: "Sab", "sábado": "Sab", domingo: "Dom",
};
function normDay(tok: string): string | null {
  const t = (tok || "").toString().trim().toLowerCase();
  if (!t) return null;
  return DAY_MAP[t] || DAY_MAP[t.slice(0, 3)] || null;
}

function parseWeekdays(w: any): string[] {
  let arr: any = w;
  try { if (typeof w === "string" && w.trim().startsWith("[")) arr = JSON.parse(w); } catch { /* noop */ }
  if (!Array.isArray(arr)) arr = typeof w === "string" ? w.split(/[,;\/]/) : [];
  const out: string[] = [];
  for (const x of arr) { const d = normDay(String(x)); if (d && !out.includes(d)) out.push(d); }
  return out;
}

export default function Visitas() {
  const [selSellers, setSelSellers] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelSellers((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const { data: users } = useQuery<any[]>({ queryKey: ["/api/users"] });
  const { data: customers, isLoading: loadingCust } = useQuery<any[]>({ queryKey: ["/api/customers"] });

  // Vendedores para o filtro: papel de venda + ativos.
  const sellers = useMemo(() => {
    return (users || [])
      .filter((u: any) => ["vendedor", "telemarketing"].includes(u.role) && u.isActive !== false)
      .map((u: any) => ({ id: u.id, name: (((u.firstName || "") + " " + (u.lastName || "")).trim()) || (u.email || "").split("@")[0] || "Sem nome" }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name, "pt-BR"));
  }, [users]);

  // sellerId do cadastro (uuid do user OU código omie-vendor) -> userId.
  const sellerIdToUser = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of (users || [])) {
      if (u.id) m.set(String(u.id), u.id);
      const codes: any[] = [u.omieVendorCode, ...(Array.isArray(u.omieVendorCodes) ? u.omieVendorCodes : [])].filter(Boolean);
      for (const code of codes) { m.set(String(code), u.id); m.set("omie-vendor-" + code, u.id); }
    }
    return m;
  }, [users]);

  // Chaves BRUTAS de seller_id dos vendedores selecionados (para filtrar a tabela sincronizada).
  const rowFilter = useMemo(() => {
    if (selSellers.size === 0) return undefined;
    const keys = new Set<string>();
    for (const u of (users || [])) {
      if (!selSellers.has(u.id)) continue;
      if (u.id) keys.add(String(u.id));
      const codes: any[] = [u.omieVendorCode, ...(Array.isArray(u.omieVendorCodes) ? u.omieVendorCodes : [])].filter(Boolean);
      for (const code of codes) { keys.add(String(code)); keys.add("omie-vendor-" + code); }
    }
    return (row: any) => keys.has(String(row.seller_id));
  }, [users, selSellers]);

  // ===== Cálculo do Calendário (base: cadastro atual de clientes ativos) =====
  // Regra: 1 por cliente em CADA dia de visita do cadastro (weekdays), independente da
  // periodicidade. Presencial vs Virtual = campo virtual_service do cliente.
  const calendario = useMemo(() => {
    // Nome por TODOS os usuários (não só os vendedores ativos do filtro), para que clientes
    // atribuídos a vendedores inativos/canais apareçam com o nome real em vez de "Sem vendedor".
    const nameOf = new Map<string, string>();
    for (const u of (users || [])) {
      const nm = (((u.firstName || "") + " " + (u.lastName || "")).trim()) || (u.email || "").split("@")[0] || "";
      if (u.id && nm) nameOf.set(u.id, nm);
    }
    sellers.forEach((s: any) => nameOf.set(s.id, s.name));
    const per = new Map<string, { name: string; days: Record<string, { p: number; v: number }> }>();
    const ensure = (uid: string, nm: string) => {
      if (!per.has(uid)) { const days: any = {}; DIAS.forEach((d) => (days[d.key] = { p: 0, v: 0 })); per.set(uid, { name: nm, days }); }
      return per.get(uid)!;
    };
    let usaDom = false;
    for (const c of (customers || [])) {
      if (c.isActive === false || c.isSupplier === true) continue;
      const uid = sellerIdToUser.get(String(c.sellerId)) || "__sem";
      if (selSellers.size > 0 && !selSellers.has(uid)) continue;
      const nm = nameOf.get(uid) || "Sem vendedor";
      const rec = ensure(uid, nm);
      const isV = c.virtualService === true;
      for (const d of parseWeekdays(c.weekdays)) {
        if (!rec.days[d]) continue;
        if (d === "Dom") usaDom = true;
        if (isV) rec.days[d].v++; else rec.days[d].p++;
      }
    }
    const dias = DIAS.filter((d) => d.key !== "Dom" || usaDom);
    const rows = [...per.entries()]
      .map(([uid, r]) => ({ uid, ...r }))
      .sort((a, b) => (a.uid === "__sem" ? 1 : b.uid === "__sem" ? -1 : a.name.localeCompare(b.name, "pt-BR")));
    return { dias, rows };
  }, [customers, users, sellers, sellerIdToUser, selSellers]);

  const dayTotal = (days: Record<string, { p: number; v: number }>, dk: string, tipo: "p" | "v" | "t") => {
    const cell = days[dk] || { p: 0, v: 0 };
    return tipo === "p" ? cell.p : tipo === "v" ? cell.v : cell.p + cell.v;
  };
  const rowTotal = (days: Record<string, { p: number; v: number }>, dias: any[], tipo: "p" | "v" | "t") =>
    dias.reduce((s, d) => s + dayTotal(days, d.key, tipo), 0);

  // Totais gerais (rodapé) por dia e tipo.
  const grand = useMemo(() => {
    const g: Record<string, { p: number; v: number }> = {};
    calendario.dias.forEach((d) => (g[d.key] = { p: 0, v: 0 }));
    for (const r of calendario.rows) for (const d of calendario.dias) { g[d.key].p += r.days[d.key].p; g[d.key].v += r.days[d.key].v; }
    return g;
  }, [calendario]);

  const exportCalendario = () => {
    const linhas: Record<string, any>[] = [];
    for (const r of calendario.rows) {
      (["p", "v", "t"] as const).forEach((tipo) => {
        const lin: Record<string, any> = { Vendedor: r.name, Tipo: tipo === "p" ? "Presencial" : tipo === "v" ? "Virtual" : "Total" };
        calendario.dias.forEach((d) => (lin[d.label] = dayTotal(r.days, d.key, tipo)));
        lin["Total"] = rowTotal(r.days, calendario.dias, tipo);
        linhas.push(lin);
      });
    }
    exportToExcel(linhas, "calendario-de-visitas");
  };

  const TIPOS: { k: "p" | "v" | "t"; label: string; cls: string }[] = [
    { k: "p", label: "Presencial", cls: "text-gray-700 dark:text-gray-300" },
    { k: "v", label: "Virtual", cls: "text-blue-600 dark:text-blue-400" },
    { k: "t", label: "Total", cls: "font-semibold" },
  ];

  const filtroVendedor = (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="filtro-vendedor">
          <Users className="h-4 w-4" />
          {selSellers.size === 0 ? "Todos os vendedores" : `${selSellers.size} vendedor(es)`}
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="flex items-center justify-between p-2 border-b text-xs">
          <button className="text-blue-600 hover:underline" onClick={() => setSelSellers(new Set(sellers.map((s: any) => s.id)))}>Selecionar todos</button>
          <button className="text-gray-500 hover:underline" onClick={() => setSelSellers(new Set())}>Limpar</button>
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {sellers.map((s: any) => (
            <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer text-sm">
              <Checkbox checked={selSellers.has(s.id)} onCheckedChange={() => toggle(s.id)} data-testid={`chk-vendedor-${s.id}`} />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
          {sellers.length === 0 && <div className="text-xs text-gray-400 px-2 py-3">Carregando vendedores…</div>}
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-1">Visitas</h1>
      <p className="text-muted-foreground text-sm mb-4">Agenda de visitas sincronizada do sistema 1.0.</p>

      <div className="flex items-center gap-2 flex-wrap mb-4">
        {filtroVendedor}
        {selSellers.size > 0 && (
          <span className="text-xs text-gray-500">Filtrando por {selSellers.size} vendedor(es)</span>
        )}
      </div>

      <Tabs defaultValue="registros">
        <TabsList>
          <TabsTrigger value="registros">Registros</TabsTrigger>
          <TabsTrigger value="calendario" data-testid="tab-calendario">
            <CalendarDays className="h-4 w-4 mr-1" /> Calendário de Visitas
          </TabsTrigger>
        </TabsList>

        <TabsContent value="registros" className="mt-4">
          <SyncedTable
            table="visit_agenda"
            hideColumns={["id"]}
            rowFilter={rowFilter}
            labels={{
              customer_id: "Cliente",
              seller_id: "Vendedor",
              date: "Data",
              visit_status: "Status",
              actual_check_in: "Check-in",
              scheduled_time: "Horário",
              notes: "Observações",
              created_at: "Criado em",
            }}
          />
        </TabsContent>

        <TabsContent value="calendario" className="mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="text-sm text-muted-foreground">
              Quantidade de clientes por dia da semana (Presencial / Virtual), conforme os dias de visita do cadastro. Cada cliente conta 1× em cada dia agendado.
            </p>
            <ExportExcelButton testId="export-calendario" onClick={exportCalendario} />
          </div>
          <div className="border rounded-lg overflow-auto max-h-[75vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Vendedor</TableHead>
                  <TableHead className="whitespace-nowrap">Tipo</TableHead>
                  {calendario.dias.map((d) => (
                    <TableHead key={d.key} className="text-center whitespace-nowrap">{d.label}</TableHead>
                  ))}
                  <TableHead className="text-center whitespace-nowrap">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingCust && (
                  <TableRow><TableCell colSpan={calendario.dias.length + 3} className="text-center text-gray-400 py-8">Carregando…</TableCell></TableRow>
                )}
                {!loadingCust && calendario.rows.length === 0 && (
                  <TableRow><TableCell colSpan={calendario.dias.length + 3} className="text-center text-gray-400 py-8">Nenhum cliente para os vendedores selecionados.</TableCell></TableRow>
                )}
                {calendario.rows.map((r) => (
                  TIPOS.map((tp, ti) => (
                    <TableRow key={r.uid + "-" + tp.k} className={tp.k === "t" ? "bg-gray-50 dark:bg-gray-900/40" : ""}>
                      {ti === 0 && (
                        <TableCell rowSpan={3} className="align-top font-medium whitespace-nowrap border-r">{r.name}</TableCell>
                      )}
                      <TableCell className={`whitespace-nowrap ${tp.cls}`}>{tp.label}</TableCell>
                      {calendario.dias.map((d) => {
                        const val = dayTotal(r.days, d.key, tp.k);
                        return <TableCell key={d.key} className={`text-center ${tp.cls} ${val === 0 ? "text-gray-300 dark:text-gray-600" : ""}`}>{val}</TableCell>;
                      })}
                      <TableCell className={`text-center ${tp.cls}`}>{rowTotal(r.days, calendario.dias, tp.k)}</TableCell>
                    </TableRow>
                  ))
                ))}
              </TableBody>
              {calendario.rows.length > 0 && (
                <tfoot className="sticky bottom-0">
                  <TableRow className="bg-gray-100 dark:bg-gray-800 font-semibold border-t-2">
                    <TableCell className="whitespace-nowrap border-r">TODOS</TableCell>
                    <TableCell className="whitespace-nowrap">Total</TableCell>
                    {calendario.dias.map((d) => (
                      <TableCell key={d.key} className="text-center">{grand[d.key].p + grand[d.key].v}</TableCell>
                    ))}
                    <TableCell className="text-center">
                      {calendario.dias.reduce((s, d) => s + grand[d.key].p + grand[d.key].v, 0)}
                    </TableCell>
                  </TableRow>
                </tfoot>
              )}
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
