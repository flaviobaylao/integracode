import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { CalendarDays, Plus, Trash2, Loader2, CalendarClock } from "lucide-react";

type Holiday = { id: string; date: string; name: string; scope: string; uf: string | null; city: string | null; deslocaRota: boolean; active: boolean; source: string };
type Macro = { uf: string; total: number; cidades: { city: string; n: number }[] };
type PreviewItem = { customerId: string; customerName: string; periodicidade: string; de: string; para: string; paraDow: string; tipo: "post" | "ant"; feriado: string; feriadoData: string };

const DOW = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
function dowOf(iso: string): string { const d = new Date(iso + "T12:00:00Z"); return isNaN(d.getTime()) ? "" : DOW[d.getUTCDay()]; }
function brOf(iso: string): string { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; }
const SCOPE_PILL: Record<string, string> = {
  nacional: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  estadual: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  municipal: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
};
const SCOPE_LABEL: Record<string, string> = { nacional: "Nacional", estadual: "Estadual", municipal: "Municipal" };

export default function FeriadosAdmin() {
  const { toast } = useToast();
  const year = new Date().getFullYear();
  const [ano, setAno] = useState(String(year));
  const [showAdd, setShowAdd] = useState(false);
  const [scope, setScope] = useState("municipal");
  const [date, setDate] = useState(`${year}-01-01`);
  const [name, setName] = useState("");
  const [uf, setUf] = useState("");
  const [city, setCity] = useState("");
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);

  const { data: hdata, isLoading } = useQuery<{ holidays: Holiday[] }>({
    queryKey: ["/api/holidays", ano],
    queryFn: () => apiRequest("GET", `/api/holidays?year=${ano}`),
  });
  const { data: rdata } = useQuery<{ macro: Macro[] }>({
    queryKey: ["/api/holidays/regions"],
    queryFn: () => apiRequest("GET", "/api/holidays/regions"),
  });
  const holidays = hdata?.holidays || [];
  const macro = rdata?.macro || [];
  const ufs = useMemo(() => macro.map((m) => m.uf).filter((u) => u && u !== "—"), [macro]);
  const cities = useMemo(() => {
    const m = macro.find((x) => x.uf === uf);
    return (m ? m.cidades : macro.flatMap((x) => x.cidades)).map((c) => c.city);
  }, [macro, uf]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/holidays", ano] });

  const createMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/holidays", { date, name, scope, uf: scope === "nacional" ? null : uf, city: scope === "municipal" ? city : null, deslocaRota: true, active: true }),
    onSuccess: () => { toast({ title: "Feriado salvo" }); setShowAdd(false); setName(""); invalidate(); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Não foi possível salvar." }),
  });
  const patchMut = useMutation({
    mutationFn: (p: { id: string; body: any }) => apiRequest("PATCH", `/api/holidays/${p.id}`, p.body),
    onSuccess: invalidate,
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao atualizar." }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/holidays/${id}`),
    onSuccess: () => { toast({ title: "Feriado removido" }); invalidate(); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao remover." }),
  });
  const previewMut = useMutation({
    mutationFn: () => apiRequest("GET", `/api/holidays/preview?month=${month}`),
    onSuccess: (r: any) => setPreview(r?.items || []),
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha na prévia." }),
  });
  const applyMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/holidays/apply", { month }),
    onSuccess: (r: any) => { toast({ title: "Realocação aplicada", description: `${r?.moved || 0} visita(s) deslocada(s).` }); setPreview(r?.items || []); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao aplicar." }),
  });
  const revertMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/holidays/revert", { month }),
    onSuccess: (r: any) => { toast({ title: "Realocação revertida", description: `${r?.reverted || 0} visita(s) voltaram à data original.` }); setPreview(null); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao reverter." }),
  });

  // Regras de deslocamento (editáveis).
  const { data: rulesData } = useQuery<{ rules: any }>({
    queryKey: ["/api/holidays/rules"],
    queryFn: () => apiRequest("GET", "/api/holidays/rules"),
  });
  const [rules, setRules] = useState<any | null>(null);
  useEffect(() => { if (rulesData?.rules && !rules) setRules(rulesData.rules); }, [rulesData]);
  const R = rules || rulesData?.rules || {};
  const setRule = (k: string, v: any) => setRules((p: any) => ({ ...(p || rulesData?.rules || {}), [k]: v }));
  const saveRulesMut = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/holidays/rules", R),
    onSuccess: (r: any) => { toast({ title: "Regras salvas", description: "Valem para a próxima geração/aplicação da agenda." }); setRules(r?.rules || R); queryClient.invalidateQueries({ queryKey: ["/api/holidays/rules"] }); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao salvar regras." }),
  });

  // Regras fixas por região (macro UF / micro cidade).
  const { data: rrData } = useQuery<{ regionRules: { id: string; uf: string; city: string | null; rule: string }[] }>({
    queryKey: ["/api/holidays/region-rules"],
    queryFn: () => apiRequest("GET", "/api/holidays/region-rules"),
  });
  const regionRules = rrData?.regionRules || [];
  const [rrUf, setRrUf] = useState("GO");
  const [rrCity, setRrCity] = useState("");
  const [rrRule, setRrRule] = useState("ant");
  const rrCities = useMemo(() => { const m = macro.find((x) => x.uf === rrUf); return m ? m.cidades.map((c) => c.city) : []; }, [macro, rrUf]);
  const invalidateRR = () => queryClient.invalidateQueries({ queryKey: ["/api/holidays/region-rules"] });
  const addRegionRuleMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/holidays/region-rules", { uf: rrUf, city: rrCity || null, rule: rrRule }),
    onSuccess: () => { toast({ title: "Regra de região salva", description: "Vale para a próxima geração/aplicação da agenda." }); invalidateRR(); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao salvar." }),
  });
  const delRegionRuleMut = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/holidays/region-rules/${id}`),
    onSuccess: () => { toast({ title: "Regra de região removida" }); invalidateRR(); },
    onError: (e: any) => toast({ variant: "destructive", title: "Erro", description: e?.message || "Falha ao remover." }),
  });
  const ruleLabel = (r: string) => r === "ant" ? "Antecipar" : r === "none" ? "Não deslocar" : "Postergar";

  const stat = useMemo(() => ({
    total: holidays.length,
    uteis: holidays.filter((h) => { const g = new Date(h.date + "T12:00:00Z").getUTCDay(); return g >= 1 && g <= 5 && h.active; }).length,
    cidades: new Set(macro.flatMap((m) => m.cidades.map((c) => c.city))).size,
  }), [holidays, macro]);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <BackToDashboardButton />

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white grid place-items-center shrink-0"><CalendarDays className="w-6 h-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Gestão de Feriados</h1>
          <p className="text-sm text-muted-foreground">Nacionais, estaduais e municipais — deslocamento automático de rotas por região.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Feriados em {ano}</div><div className="text-2xl font-bold mt-1">{stat.total}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Em dia útil</div><div className="text-2xl font-bold mt-1">{stat.uteis}</div><div className="text-[11px] text-muted-foreground">deslocam rota</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Macro-regiões</div><div className="text-2xl font-bold mt-1">{macro.filter(m=>m.uf!=="—").length}</div><div className="text-[11px] text-muted-foreground">{ufs.join(" · ") || "—"}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Micro-regiões</div><div className="text-2xl font-bold mt-1">{stat.cidades}</div><div className="text-[11px] text-muted-foreground">cidades atendidas</div></CardContent></Card>
      </div>

      <Tabs defaultValue="feriados">
        <TabsList>
          <TabsTrigger value="feriados">Feriados</TabsTrigger>
          <TabsTrigger value="regras">Regras de deslocamento</TabsTrigger>
          <TabsTrigger value="previa">Prévia do mês</TabsTrigger>
        </TabsList>

        {/* FERIADOS */}
        <TabsContent value="feriados" className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={ano} onValueChange={setAno}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{[year - 1, year, year + 1].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex-1" />
            <Button onClick={() => setShowAdd((s) => !s)}><Plus className="w-4 h-4 mr-1.5" /> Adicionar feriado</Button>
          </div>

          {showAdd && (
            <Card className="border-dashed">
              <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div><label className="text-xs font-semibold text-muted-foreground">Data</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div><label className="text-xs font-semibold text-muted-foreground">Nome</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Aniversário da cidade" /></div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground">Abrangência</label>
                  <Select value={scope} onValueChange={setScope}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="nacional">Nacional</SelectItem><SelectItem value="estadual">Estadual</SelectItem><SelectItem value="municipal">Municipal</SelectItem></SelectContent>
                  </Select>
                </div>
                {scope !== "nacional" && (
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground">UF (macro)</label>
                    <Select value={uf} onValueChange={setUf}>
                      <SelectTrigger><SelectValue placeholder="UF" /></SelectTrigger>
                      <SelectContent>{ufs.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                {scope === "municipal" && (
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground">Cidade (micro)</label>
                    <Select value={city} onValueChange={setCity}>
                      <SelectTrigger><SelectValue placeholder="Cidade" /></SelectTrigger>
                      <SelectContent>{cities.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                <div className="sm:col-span-2 lg:col-span-4 flex gap-2">
                  <Button onClick={() => createMut.mutate()} disabled={createMut.isPending || !name || !date}>{createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Salvar feriado"}</Button>
                  <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancelar</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <th className="p-3">Data</th><th className="p-3">Feriado</th><th className="p-3">Abrangência</th><th className="p-3">Região</th><th className="p-3">Desloca rota</th><th className="p-3">Ativo</th><th className="p-3"></th>
                </tr></thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={7} className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
                  ) : holidays.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Nenhum feriado cadastrado em {ano}.</td></tr>
                  ) : holidays.map((h) => (
                    <tr key={h.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="p-3 whitespace-nowrap font-mono">{brOf(h.date)}<div className="text-[11px] text-muted-foreground">{dowOf(h.date)}</div></td>
                      <td className="p-3">{h.name}</td>
                      <td className="p-3"><Badge variant="outline" className={`border-transparent ${SCOPE_PILL[h.scope]}`}>{SCOPE_LABEL[h.scope] || h.scope}</Badge></td>
                      <td className="p-3 text-xs">{h.scope === "nacional" ? "Todas" : h.scope === "estadual" ? `${h.uf}` : <>{h.city} <span className="text-muted-foreground">· {h.uf || ""}</span></>}</td>
                      <td className="p-3"><input type="checkbox" className="w-4 h-4 accent-indigo-600" checked={h.deslocaRota} onChange={(e) => patchMut.mutate({ id: h.id, body: { deslocaRota: e.target.checked } })} /></td>
                      <td className="p-3"><input type="checkbox" className="w-4 h-4 accent-indigo-600" checked={h.active} onChange={(e) => patchMut.mutate({ id: h.id, body: { active: e.target.checked } })} /></td>
                      <td className="p-3"><Button size="sm" variant="ghost" className="text-red-500" onClick={() => { if (window.confirm(`Remover o feriado "${h.name}" (${brOf(h.date)})?`)) delMut.mutate(h.id); }}><Trash2 className="w-4 h-4" /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">Os nacionais entram automáticos todo ano. Estaduais valem para toda a UF (macro-região); municipais, só para a cidade (micro-região) — e só deslocam a rota de quem é daquela região.</p>
        </TabsContent>

        {/* REGRAS */}
        <TabsContent value="regras" className="space-y-4">
          <p className="text-sm text-muted-foreground">Defina, por periodicidade, para onde a visita vai quando cai num feriado. As regras valem para a próxima geração/aplicação da agenda.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([["semanal","Semanal"],["trisemanal","Trissemanal"],["quinzenal","Quinzenal"],["mensal","Mensal"]] as const).map(([k,label]) => (
              <Card key={k}>
                <CardHeader className="pb-2"><CardTitle className="text-base">{label}</CardTitle></CardHeader>
                <CardContent className="pt-0 space-y-2">
                  <Select value={String(R[k] || "post")} onValueChange={(v) => setRule(k, v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="post">Postergar → próximo dia útil</SelectItem>
                      <SelectItem value="ant">Antecipar ← dia útil anterior</SelectItem>
                      <SelectItem value="none">Não deslocar</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">{R[k] === "ant" ? "Antecipa para o dia útil anterior." : R[k] === "none" ? "Mantém no feriado (não move)." : "Posterga para o próximo dia útil."}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card><CardContent className="p-4 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 mt-0.5 accent-indigo-600" checked={R.cascata !== false} onChange={(e) => setRule("cascata", e.target.checked)} />
              <span><span className="text-sm font-medium">Cascata em feriados/fins de semana consecutivos</span><br /><span className="text-xs text-muted-foreground">Se o dia-alvo também for feriado ou fim de semana, anda mais um dia útil na mesma direção.</span></span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 mt-0.5 accent-indigo-600" checked={R.incluirVirtuais === true} onChange={(e) => setRule("incluirVirtuais", e.target.checked)} />
              <span><span className="text-sm font-medium">Incluir atendimentos virtuais</span><br /><span className="text-xs text-muted-foreground">Por padrão, virtuais não são deslocados (não dependem do feriado presencial).</span></span>
            </label>
          </CardContent></Card>

          <div className="flex items-center gap-2">
            <Button onClick={() => saveRulesMut.mutate()} disabled={saveRulesMut.isPending}>{saveRulesMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Salvar regras"}</Button>
            <span className="text-xs text-muted-foreground">O deslocamento é reaplicado sozinho quando a agenda do cliente é regenerada.</span>
          </div>

          {/* Regras fixas por região (macro/micro) */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Regras fixas por região</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">Amarre uma direção a uma macro-região (UF inteira) ou micro-região (cidade). A regra da região vence a regra da periodicidade — e a exceção por cliente vence a da região.</p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1">Macro (UF)</label>
                  <Select value={rrUf} onValueChange={(v) => { setRrUf(v); setRrCity(""); }}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="GO">GO</SelectItem><SelectItem value="DF">DF</SelectItem></SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1">Micro (cidade)</label>
                  <Select value={rrCity || "__all"} onValueChange={(v) => setRrCity(v === "__all" ? "" : v)}>
                    <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">Toda a {rrUf} (macro)</SelectItem>
                      {rrCities.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1">Direção</label>
                  <Select value={rrRule} onValueChange={setRrRule}>
                    <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="post">Postergar (próximo dia útil)</SelectItem>
                      <SelectItem value="ant">Antecipar (dia útil anterior)</SelectItem>
                      <SelectItem value="none">Não deslocar</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => addRegionRuleMut.mutate()} disabled={addRegionRuleMut.isPending}>{addRegionRuleMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Adicionar"}</Button>
              </div>

              {regionRules.length > 0 ? (
                <div className="border rounded-lg divide-y">
                  {regionRules.map((rr) => (
                    <div key={rr.id} className="flex items-center gap-3 p-2.5">
                      <Badge variant="outline" className={`border-transparent ${rr.city ? "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" : "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"}`}>{rr.city ? "Micro" : "Macro"}</Badge>
                      <span className="text-sm flex-1 min-w-0">{rr.city ? <>{rr.city} <span className="text-muted-foreground">· {rr.uf}</span></> : <>Toda a {rr.uf}</>}</span>
                      <Badge className={`border-transparent ${rr.rule === "ant" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" : rr.rule === "none" ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"}`}>{ruleLabel(rr.rule)}</Badge>
                      <Button size="sm" variant="ghost" className="text-red-500" onClick={() => { if (window.confirm("Remover esta regra de região?")) delRegionRuleMut.mutate(rr.id); }}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Nenhuma regra por região. Sem regra, a região segue a regra da periodicidade.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* PRÉVIA */}
        <TabsContent value="previa" className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPreview(null); }} className="w-44" />
            <Button variant="outline" onClick={() => previewMut.mutate()} disabled={previewMut.isPending}>{previewMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Ver prévia"}</Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => { if (window.confirm("Reverter as realocações deste mês? As visitas voltam à data original.")) revertMut.mutate(); }} disabled={revertMut.isPending}>Reverter mês</Button>
            <Button onClick={() => { if (window.confirm("Aplicar a realocação de feriados deste mês na agenda?")) applyMut.mutate(); }} disabled={applyMut.isPending}><CalendarClock className="w-4 h-4 mr-1.5" /> Aplicar realocação</Button>
          </div>

          {preview === null ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">Clique em "Ver prévia" para ver quais visitas mudam de dia neste mês.</CardContent></Card>
          ) : preview.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">Nenhuma visita cai em feriado neste mês (ou já foram realocadas).</CardContent></Card>
          ) : (
            <Card><CardContent className="p-0 divide-y">
              {preview.map((it, i) => (
                <div key={i} className="flex items-center gap-3 p-3 flex-wrap">
                  <div className="flex-1 min-w-[180px]"><span className="font-medium">{it.customerName}</span><span className="text-muted-foreground text-xs"> · {it.periodicidade} · feriado {it.feriadoData} ({it.feriado})</span></div>
                  <div className="font-mono text-xs whitespace-nowrap">{it.de} → <b>{it.para} ({it.paraDow})</b></div>
                  <Badge className={`border-transparent ${it.tipo === "post" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>{it.tipo === "post" ? "Postergação" : "Antecipação"}</Badge>
                </div>
              ))}
            </CardContent></Card>
          )}
          <p className="text-xs text-muted-foreground">A prévia não altera nada. "Aplicar" desloca as visitas do mês e marca o card da Rota do Dia; "Reverter" desfaz.</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
