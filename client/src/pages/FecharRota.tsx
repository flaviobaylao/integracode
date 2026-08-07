// ============================================================================
// INTEGRA 2.0 — FECHAR ROTA DO DIA (Ago/2026) — Fase 2
// O vendedor encerra a rota do dia: o sistema separa os clientes NAO VISITADOS
// (Presencial/Virtual/Lead conforme regra do admin; Repescagem fica de fora),
// ele justifica cada um (reaproveita /api/vendedor/justificativas) e fecha o dia.
// A trava (config do admin) impede fechar com pendencia.
// Regras de "atendido" espelham a Rota do Dia:
//   Presencial: existe checkpoint check_in do customerId OU pedido no dia
//   Virtual:    atendimento virtual registrado OU pedido no dia
//   Lead:       leadStatus convertido/descartado/(agendado p/ data futura) OU pedido no dia
//   Repescagem: check_in OU atendimento OU pedido no dia
// Regra geral: cliente com pedido/faturamento registrado no dia conta como atendido
// (mesmo sem check-in) e NAO entra na lista de justificativas.
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { getBrazilDateISO } from "@/lib/brazilTimezone";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Flag, MapPin, CheckCircle2, AlertCircle, Lock, Mic } from "lucide-react";

type Tipo = "presencial" | "virtual" | "lead" | "repescagem";
type NaoVisitado = { id: string; customerId: string; nome: string; tipo: Tipo };

// Vendedores/TMK cujo fechamento também exige justificar a REPESCAGEM (além de presencial/virtual/lead).
// Maria E. (omie-vendor-4323360115) e Natalia B. (omie-vendor-4317814615) — telemarketing.
const REPESCAGEM_FECHA_SELLERS = new Set<string>(["omie-vendor-4323360115", "omie-vendor-4317814615"]);

const MOTIVOS: [string, string][] = [
  ["sem_tempo", "Não deu tempo / rota grande"],
  ["remarcou", "Cliente avisou / remarcou"],
  ["fechado", "Cliente fechado ou de férias"],
  ["rota_inviavel", "Rota/distância inviável hoje"],
  ["imprevisto", "Imprevisto (veículo/pessoal)"],
  ["cancelou", "Cliente cancelou fornecimento"],
  ["outro", "Outro"],
];
const MOTIVO_LABEL: Record<string, string> = Object.fromEntries(MOTIVOS);
const TIPO_LABEL: Record<Tipo, string> = { presencial: "Presencial", virtual: "Virtual", lead: "Lead", repescagem: "Repescagem" };
const TIPO_CLS: Record<Tipo, string> = {
  presencial: "bg-blue-50 text-blue-700",
  virtual: "bg-violet-50 text-violet-700",
  lead: "bg-amber-50 text-amber-700",
  repescagem: "bg-rose-50 text-rose-700",
};

function computeNaoVisitados(route: any, serviceCounts: any, overlay: any[], orders: Record<string, any[]>, allowed: Set<Tipo>, today: string, includeRepescagem: boolean = false): NaoVisitado[] {
  const checkedIn = new Set<string>();
  (route?.checkpoints || []).forEach((cp: any) => { if (cp?.checkpointType === "check_in" && cp?.customerId) checkedIn.add(String(cp.customerId)); });
  const attended = new Set<string>(((serviceCounts?.attendedCustomerIds) || []).map(String));
  const hasOrder = (cid?: string | null) => !!(cid && orders[String(cid)] && orders[String(cid)].length > 0);
  const repIds = new Set<string>((Array.isArray(overlay) ? overlay : []).map((r: any) => r?.customerId).filter(Boolean).map(String));
  const out: NaoVisitado[] = [];
  for (const v of (route?.visits || [])) {
    const isLead = v?.visitType === "lead";
    const isVirtual = !!(v?.isVirtual || v?.visitType === "virtual");
    const tipo: Tipo = isLead ? "lead" : isVirtual ? "virtual" : "presencial";
    if (!allowed.has(tipo)) continue;
    const cidExcl = v?.customerId ? String(v.customerId) : "";
    if (cidExcl && repIds.has(cidExcl)) continue;
    let done = false;
    if (isLead) {
      const lcid = String(v?.customerId || v?.entityId || v?.leadId || "");
      const st = v?.leadStatus;
      const nd = v?.leadNextContactDate ? String(v.leadNextContactDate).slice(0, 10) : null;
      done = hasOrder(lcid) || st === "converted" || st === "discarded" || (st === "scheduled" && !!nd && !!today && nd > today);
    } else if (isVirtual) {
      const cid = v?.customerId ? String(v.customerId) : "";
      done = !!cid && (attended.has(cid) || hasOrder(cid));
    } else {
      const cid = v?.customerId ? String(v.customerId) : "";
      done = !!cid && (checkedIn.has(cid) || hasOrder(cid));
    }
    if (done) continue;
    const customerId = isLead ? String(v?.entityId || v?.leadId || v?.customerId || "") : String(v?.customerId || v?.entityId || "");
    if (!customerId) continue;
    out.push({ id: String(v?.id ?? customerId), customerId, nome: v?.customerName || "(sem nome)", tipo });
  }
  // Repescagem (somente para vendedores habilitados): cada cliente da repescagem não atendido também precisa de justificativa.
  if (includeRepescagem) {
    for (const r of (Array.isArray(overlay) ? overlay : [])) {
      const cid = r?.customerId ? String(r.customerId) : "";
      if (!cid || out.some((o) => o.customerId === cid)) continue;
      const done = checkedIn.has(cid) || attended.has(cid) || hasOrder(cid);
      if (done) continue;
      out.push({ id: "rep-" + String(r?.assignmentId || cid), customerId: cid, nome: r?.customerName || "(sem nome)", tipo: "repescagem" });
    }
  }
  return out;
}

export default function FecharRota({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const uAny = user as any;
  const role = uAny?.role;
  const isAdmin = ["admin", "coordinator", "administrative"].includes(role);
  const { toast } = useToast();

  const _qd = (typeof window !== "undefined") ? new URLSearchParams(window.location.search).get("date") : null;
  const today = (_qd && /^\d{4}-\d{2}-\d{2}$/.test(_qd)) ? _qd : getBrazilDateISO();
  const [pickSeller, setPickSeller] = useState<string>("");
  const sellerId = isAdmin ? pickSeller : (uAny?.id || "");

  const { data: usersData } = useQuery<any>({ queryKey: ["/api/users"], enabled: isAdmin && !!user });
  const sellers = useMemo(() => (Array.isArray(usersData) ? usersData : []).filter((u: any) => ["vendedor", "telemarketing"].includes(u?.role) && u?.isActive), [usersData]);

  const enabled = !!sellerId && !!today;
  const { data: statusData } = useQuery<any>({ queryKey: ["/api/vendedor/fechamento/status", sellerId, today], enabled, queryFn: () => apiRequest("GET", `/api/vendedor/fechamento/status?sellerId=${encodeURIComponent(sellerId)}&date=${today}`) });
  const { data: routeData } = useQuery<any>({ queryKey: ["/api/daily-routes", sellerId, "date", today], enabled, queryFn: () => apiRequest("GET", `/api/daily-routes/${encodeURIComponent(sellerId)}/date/${today}`) });
  const route = routeData?.route;
  const { data: overlayData } = useQuery<any>({ queryKey: ["/api/repescagem/route-overlay", sellerId, today], enabled, queryFn: () => apiRequest("GET", `/api/repescagem/route-overlay?sellerId=${encodeURIComponent(sellerId)}&date=${today}`) });
  const overlay = Array.isArray(overlayData) ? overlayData : (overlayData?.overlay || []);
  const incluiRepescagem = REPESCAGEM_FECHA_SELLERS.has(String(sellerId));
  const routeCustomerIds = useMemo(() => {
    const s = new Set<string>();
    (route?.visits || []).forEach((v: any) => { const c = v?.customerId || v?.entityId; if (c) s.add(String(c)); });
    if (incluiRepescagem) (Array.isArray(overlay) ? overlay : []).forEach((r: any) => { if (r?.customerId) s.add(String(r.customerId)); });
    return Array.from(s);
  }, [route, overlay, incluiRepescagem]);
  const { data: svcData } = useQuery<any>({ queryKey: ["/api/service-logs/count/customer", sellerId, today, routeCustomerIds.length], enabled: enabled && routeCustomerIds.length > 0, queryFn: () => apiRequest("GET", `/api/service-logs/count/customer?sellerId=${encodeURIComponent(sellerId)}&date=${today}&customerIds=${routeCustomerIds.join(",")}`) });
  const { data: infoData } = useQuery<any>({ queryKey: ["/api/daily-routes", route?.id, "customer-info"], enabled: !!route?.id, queryFn: () => apiRequest("GET", `/api/daily-routes/${route.id}/customer-info`) });

  const cfg = statusData?.config || { travaObrigatoria: true, tipos: ["presencial", "virtual", "lead"] };
  const allowed = new Set<Tipo>((cfg.tipos || ["presencial", "virtual", "lead"]) as Tipo[]);
  const orders = infoData?.orders || {};
  const naoVisitados = useMemo(() => route ? computeNaoVisitados(route, svcData, overlay, orders, allowed, today, incluiRepescagem) : [], [route, svcData, overlay, orders, statusData, incluiRepescagem]);

  const totalStops = useMemo(() => {
    let n = 0;
    (route?.visits || []).forEach((v: any) => {
      const isLead = v?.visitType === "lead"; const isVirtual = !!(v?.isVirtual || v?.visitType === "virtual");
      const tipo: Tipo = isLead ? "lead" : isVirtual ? "virtual" : "presencial";
      const cid = v?.customerId ? String(v.customerId) : "";
      const isRep = cid && overlay.some((r: any) => String(r?.customerId) === cid);
      if (allowed.has(tipo) && !isRep) n++;
    });
    if (incluiRepescagem) n += (Array.isArray(overlay) ? overlay : []).length;
    return n;
  }, [route, overlay, statusData, incluiRepescagem]);

  // justificativas locais
  const [justified, setJustified] = useState<Record<string, { reason: string; note: string }>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftReason, setDraftReason] = useState<string>("");
  const [draftNote, setDraftNote] = useState<string>("");

  const pendentes = naoVisitados.filter((c) => !justified[c.customerId]);
  const closed = !!statusData?.closed;

  const salvarJust = useMutation({
    mutationFn: async (c: NaoVisitado) => apiRequest("POST", "/api/vendedor/justificativas", { date: today, customerId: c.customerId, sellerId, reason: draftReason, notes: draftNote || null }),
    onSuccess: (_r, c) => {
      setJustified((j) => ({ ...j, [c.customerId]: { reason: draftReason, note: draftNote } }));
      setOpenId(null); setDraftReason(""); setDraftNote("");
    },
    onError: () => toast({ title: "Erro ao salvar justificativa", variant: "destructive" }),
  });

  const fechar = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/vendedor/fechamento/fechar", { sellerId, date: today, pendentes: pendentes.length, justificados: Object.keys(justified).length, naoVisitados: naoVisitados.length }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendedor/fechamento/status", sellerId, today] });
      toast({ title: "Rota fechada!", description: "Resumo enviado ao gestor." });
    },
    onError: (e: any) => toast({ title: "Não foi possível fechar", description: e?.message || "Verifique as pendências.", variant: "destructive" }),
  });

  const canSave = !!draftReason && (draftReason !== "outro" || !!draftNote.trim());

  return (
    <div className={embedded ? "" : "p-4 md:p-6 max-w-3xl mx-auto"}>
      {!embedded && <BackToDashboardButton />}
      <div className="flex items-center gap-3 mt-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-green-50 text-green-600 flex items-center justify-center"><Flag className="w-5 h-5" /></div>
        <div>
          <h1 className="text-xl font-bold">Fechar Rota do Dia</h1>
          <div className="text-xs text-muted-foreground">{today.split("-").reverse().join("/")} · justifique quem não foi visitado e feche o dia</div>
        </div>
      </div>

      {isAdmin && (
        <select className="mt-3 border rounded-lg px-3 py-2 text-sm font-medium w-full max-w-sm" value={pickSeller} onChange={(e) => setPickSeller(e.target.value)}>
          <option value="">Selecione um vendedor…</option>
          {sellers.map((s: any) => (<option key={s.id} value={s.id}>{(s.firstName || "") + " " + (s.lastName || "")} {s.role === "telemarketing" ? "(TMK)" : ""}</option>))}
        </select>
      )}

      {!sellerId && (<div className="text-sm text-muted-foreground mt-6">Selecione um vendedor para ver o fechamento.</div>)}

      {sellerId && closed && (
        <Card className="mt-5 border-green-200"><CardContent className="pt-6 text-center">
          <div className="w-14 h-14 rounded-full bg-green-50 text-green-600 flex items-center justify-center mx-auto mb-3"><CheckCircle2 className="w-7 h-7" /></div>
          <div className="font-bold text-lg">Rota de {today.split("-").reverse().join("/")} já fechada</div>
          <div className="text-sm text-muted-foreground mt-1">Fechada às {statusData?.closure?.closedAt ? String(statusData.closure.closedAt).slice(11, 16) : "—"}. Para reabrir, fale com o admin.</div>
        </CardContent></Card>
      )}

      {sellerId && !closed && !route && (<div className="text-sm text-muted-foreground mt-6">Nenhuma rota encontrada para hoje.</div>)}

      {sellerId && !closed && route && (
        <>
          <div className="grid grid-cols-4 gap-2 mt-5">
            <div className="rounded-xl bg-white border p-3 text-center"><div className="text-xl font-bold">{totalStops}</div><div className="text-[11px] text-muted-foreground">na rota</div></div>
            <div className="rounded-xl bg-white border p-3 text-center"><div className="text-xl font-bold text-green-600">{Math.max(0, totalStops - naoVisitados.length)}</div><div className="text-[11px] text-muted-foreground">atendidos</div></div>
            <div className="rounded-xl bg-white border p-3 text-center"><div className="text-xl font-bold text-green-700">{Object.keys(justified).length}</div><div className="text-[11px] text-muted-foreground">justificados</div></div>
            <div className="rounded-xl bg-white border p-3 text-center"><div className="text-xl font-bold text-red-600">{pendentes.length}</div><div className="text-[11px] text-muted-foreground">pendentes</div></div>
          </div>

          {naoVisitados.length === 0 ? (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-xl p-3 mt-4">Tudo atendido! Nenhum cliente ficou sem visita. Pode fechar a rota.</div>
          ) : (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 mt-4 flex gap-2"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>Estes clientes ficaram <b>sem atendimento</b> hoje. Escolha um motivo para cada um.</span></div>
          )}

          <div className="mt-3 space-y-2">
            {naoVisitados.map((c) => {
              const j = justified[c.customerId];
              if (j) {
                return (
                  <Card key={c.id} className="border-l-4 border-l-green-500"><CardContent className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div><div className="font-semibold text-sm">{c.nome}</div><div className="text-[11px] text-muted-foreground flex items-center gap-2"><span className={`px-2 py-0.5 rounded ${TIPO_CLS[c.tipo]}`}>{TIPO_LABEL[c.tipo]}</span></div></div>
                      <span className="text-[11px] font-bold text-green-700 bg-green-50 px-2 py-1 rounded-full">✓ Justificado</span>
                    </div>
                    <div className="mt-2 text-xs bg-green-50 border border-green-100 rounded-lg px-3 py-2">📝 {MOTIVO_LABEL[j.reason] || j.reason}{j.note ? <span className="text-muted-foreground"> — "{j.note}"</span> : null}</div>
                  </CardContent></Card>
                );
              }
              const open = openId === c.id;
              return (
                <Card key={c.id} className="border-l-4 border-l-red-500"><CardContent className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div><div className="font-semibold text-sm">{c.nome}</div><div className="text-[11px] text-muted-foreground flex items-center gap-2"><span className={`px-2 py-0.5 rounded ${TIPO_CLS[c.tipo]}`}>{TIPO_LABEL[c.tipo]}</span></div></div>
                    <span className="text-[11px] font-bold text-red-600 bg-red-50 px-2 py-1 rounded-full">● Não visitado</span>
                  </div>
                  {!open ? (
                    <button className="mt-2 w-full bg-gray-900 text-white rounded-lg py-2 text-sm font-semibold" onClick={() => { setOpenId(c.id); setDraftReason(""); setDraftNote(""); }}>＋ Justificar não atendimento</button>
                  ) : (
                    <div className="mt-3 border-t border-dashed pt-3">
                      <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Motivo</div>
                      <div className="flex flex-wrap gap-2">
                        {MOTIVOS.map(([id, label]) => (
                          <button key={id} onClick={() => setDraftReason(id)} className={`px-3 py-2 rounded-full text-xs font-semibold border ${draftReason === id ? "bg-green-600 border-green-600 text-white" : "bg-white border-gray-200 text-gray-600"}`}>{label}</button>
                        ))}
                      </div>
                      <div className="flex items-center justify-between mt-3"><div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Observação {draftReason === "outro" ? "(obrigatória)" : "(opcional)"}</div><span className="text-[11px] text-muted-foreground flex items-center gap-1"><Mic className="w-3 h-3" /> áudio (em breve)</span></div>
                      <textarea className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" rows={2} placeholder="Ex.: passei 17h e estava fechado" value={draftNote} onChange={(e) => setDraftNote(e.target.value)} />
                      <div className="flex gap-2 mt-2">
                        <button className="flex-1 bg-gray-100 text-gray-600 rounded-lg py-2 text-sm font-semibold" onClick={() => setOpenId(null)}>Cancelar</button>
                        <button className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50" disabled={!canSave || salvarJust.isPending} onClick={() => salvarJust.mutate(c)}>Salvar</button>
                      </div>
                    </div>
                  )}
                </CardContent></Card>
              );
            })}
          </div>

          <div className="sticky bottom-0 bg-white border-t mt-6 -mx-4 md:-mx-6 px-4 md:px-6 py-3">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1 mb-2"><Lock className="w-3 h-3" /> Trava obrigatória: <b className={cfg.travaObrigatoria ? "text-green-700" : "text-red-600"}>{cfg.travaObrigatoria ? "ligada" : "desligada"}</b> <span className="bg-gray-100 rounded px-1.5 py-0.5">definida pelo admin</span></div>
            <button
              className="w-full bg-green-600 text-white rounded-xl py-3 text-base font-bold disabled:bg-gray-200 disabled:text-gray-400"
              disabled={fechar.isPending || (cfg.travaObrigatoria && pendentes.length > 0)}
              onClick={() => fechar.mutate()}
            >
              Fechar rota do dia {pendentes.length > 0 ? `(faltam ${pendentes.length})` : "✓"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
