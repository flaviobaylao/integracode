// =============================================================================
//  INTEGRA 2.0 — Solicitações de Alteração (inbox — somente admin)
//  client/src/pages/SolicitacoesAlteracao.tsx  — rota /admin/solicitacoes-alteracao
//  Lista as solicitações abertas pelos usuários a partir do botão "Solicitar
//  Alteração" nos cards. O admin faz as alterações manualmente no sistema e
//  fecha cada tarefa com Efetuadas / Parcial / Rejeitadas (+ observação).
// =============================================================================
import { useState } from "react";
import { useQuery, useMutation, queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MessageThread } from "@/components/change-request/ChangeRequestControl";
import { VoiceDictateButton } from "@/components/VoiceDictateButton";
import { Inbox, CheckCircle2, XCircle, Loader2, User as UserIcon, Clock, Copy, Check, Reply, CheckSquare, Square, Trash2, MessageCircle, ShoppingCart, CalendarClock } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  periodicidade: "Periodicidade", dia_rota: "Dia de Rota", area_vendas: "Área de vendas",
  presencial_virtual: "Presencial/Virtual",
  inicio_atendimento: "Início de atendimento", inativar: "Inativar",
  dia_sobrecarregado: "Dia sobrecarregado", outro: "Outro",
};
const ENTITY_LABEL: Record<string, string> = {
  customer: "Cliente", lead: "Lead", repescagem: "Repescagem", agenda_dia: "Agenda da carteira",
};
const RESULT_META: Record<string, { label: string; cls: string }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300" },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300" },
  lido: { label: "Lido", cls: "bg-indigo-100 text-indigo-800 border-indigo-300" },
};

// 🛒 Última compra do cliente (último faturamento). Mostra a data e há quantos dias.
const fmtDiaBR = (s?: string) => {
  if (!s) return "";
  try { return new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return ""; }
};
function UltimaCompra({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="text-[11px] text-muted-foreground flex items-center gap-1"><ShoppingCart className="h-3 w-3" /> Sem compra registrada</span>;
  const dias = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  const cls = dias >= 60 ? "text-red-700" : dias >= 30 ? "text-amber-700" : "text-emerald-700";
  return (
    <span className={`text-[11px] flex items-center gap-1 ${cls}`} title="Data do último pedido faturado deste cliente">
      <ShoppingCart className="h-3 w-3" /> Última compra: <b>{fmtDiaBR(iso)}</b> ({dias === 0 ? "hoje" : dias === 1 ? "há 1 dia" : `há ${dias} dias`})
    </span>
  );
}

const fmtDate = (s?: string) => {
  if (!s) return "";
  try { return new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return String(s); }
};

// 📋 Botão de copiar a razão social do cliente para a área de transferência
// (facilita colar a busca no Omie/sistema ao efetuar a alteração manual). (30/jul/2026)
function CopyBtn({ text }: { text: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const copyText = async (t: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(t); return true; }
    catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta); return ok;
      } catch { return false; }
    }
  };
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); toast({ title: "Copiado", description: text }); }
        else toast({ title: "Não foi possível copiar", variant: "destructive" });
      }}
      title="Copiar razão social"
      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      data-testid="button-copy-name"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function Detalhes({ details }: { details: any }) {
  if (!details || Object.keys(details).length === 0) return null;
  return (
    <div className="rounded-md bg-muted/60 p-2 text-xs space-y-0.5">
      {details.periodicidade && <div>Periodicidade: <b>{details.periodicidade}</b></div>}
      {Array.isArray(details.diaRota) && details.diaRota.length > 0 && <div>Dias: <b>{details.diaRota.join(", ")}</b></div>}
      {details.areaVendas && <div>Área de vendas: <b>{details.areaVendas}</b></div>}
      {details.modalidade && <div>Modalidade: <b>{details.modalidade === "virtual" ? "Virtual" : "Presencial"}</b></div>}
      {details.inicioAtendimento && <div>Início de atendimento: <b>{details.inicioAtendimento}</b></div>}
      {details.outro && <div>Outro: <span className="italic">{details.outro}</span></div>}
    </div>
  );
}

function PendingCard({ r, selected, onToggleSelect }: { r: any; selected?: boolean; onToggleSelect?: (id: string) => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  // Item 4: ao retornar "Efetuadas", a rota do dia do vendedor é reotimizada automaticamente.
  // Para "Parcial"/"Rejeitadas" não há otimização automática.
  async function otimizarRotaAposEfetuada() {
    try {
      const sellerId = r.sellerId;
      if (!sellerId) return;
      const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
      const rd: any = await apiRequest("GET", `/api/daily-routes/${encodeURIComponent(sellerId)}/date/${hoje}`);
      const routeId = rd?.route?.id || rd?.id;
      if (!routeId) return;
      await apiRequest("POST", `/api/daily-routes/${routeId}/optimize`);
      queryClient.invalidateQueries({ queryKey: ["/api/daily-routes"] });
      toast({ title: "Rota otimizada", description: "A rota do vendedor foi reotimizada após a alteração efetuada." });
    } catch { /* silencioso: otimização é um efeito colateral opcional */ }
  }
  const resolveMut = useMutation({
    mutationFn: async (status: string) => apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status, note: note.trim() || undefined }),
    onSuccess: (_data, status) => {
      toast({ title: "Solicitação fechada", description: "O resultado já aparece no card." });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      if (status === "efetuadas") otimizarRotaAposEfetuada();
    },
    onError: (e: any) => toast({ title: "Erro ao resolver", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // Item 2 — botão Inativar direto no Inbox: inativa o cliente e fecha a solicitação.
  const inativarMut = useMutation({
    mutationFn: async () => {
      const cid = r.customerId || r.entityId;
      await apiRequest("POST", "/api/customers/bulk-inactivate", { ids: [cid] });
      return apiRequest("POST", `/api/change-requests/${r.id}/resolve`, {
        status: "efetuadas",
        note: (note.trim() ? note.trim() + " • " : "") + "Cliente inativado via Inbox.",
      });
    },
    onSuccess: () => {
      toast({ title: "Cliente inativado", description: "Saiu dos Clientes Ativos e a solicitação foi fechada." });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
    },
    onError: (e: any) => toast({ title: "Erro ao inativar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // 💬 Réplica do admin ao vendedor (report): registra a mensagem na conversa e, em seguida,
  // FECHA o report (status "lido") — ao acionar "Réplica" o card SAI de pendentes. O vendedor
  // continua recebendo a resposta no card do atendimento.
  const replyMut = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/change-requests/${r.id}/reply`, { text: note.trim() });
      return apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status: "lido" });
    },
    onSuccess: () => {
      toast({ title: "Réplica enviada", description: "O vendedor recebe a resposta e o card saiu de pendentes." });
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
    },
    onError: (e: any) => toast({ title: "Erro ao enviar réplica", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // 🚫 Inativar Cliente (no card de report): mesma ação/regras/impactos do "Inativar" do Integra
  // (POST /api/customers/bulk-inactivate, com auditoria) e, em seguida, fecha o report (status "lido").
  const inativarReportMut = useMutation({
    mutationFn: async () => {
      const cid = r.customerId || r.entityId;
      await apiRequest("POST", "/api/customers/bulk-inactivate", { ids: [cid], motivo: note.trim() || "Inativado via report do Inbox." });
      return apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status: "lido" });
    },
    onSuccess: () => {
      toast({ title: "Cliente inativado", description: "Saiu dos Clientes Ativos e o report foi para Resolvidas." });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
    },
    onError: (e: any) => toast({ title: "Erro ao inativar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // 🕒 Quarentena: atualiza a "Data de Início do Fornecimento" (serviceStartDate) do cliente —
  // mesmo caminho do formulário "Editar Dados do Cliente" (PATCH /api/customers/:id, regenera agenda) —
  // e fecha o report (status "lido").
  const [quarentenaOpen, setQuarentenaOpen] = useState(false);
  const [quarentenaDate, setQuarentenaDate] = useState("");
  const quarentenaMut = useMutation({
    mutationFn: async () => {
      const cid = r.customerId || r.entityId;
      await apiRequest("PATCH", `/api/customers/${cid}`, { serviceStartDate: quarentenaDate });
      return apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status: "lido" });
    },
    onSuccess: () => {
      toast({ title: "Quarentena aplicada", description: "Data de Início do Fornecimento atualizada e report enviado para Resolvidas." });
      setQuarentenaOpen(false); setQuarentenaDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
    },
    onError: (e: any) => toast({ title: "Erro ao aplicar quarentena", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // 📲 Envio Whatsapp (card de report): o servidor recorta o report (cliente, motivo, observação
  // do vendedor, quem/quando) e manda pelo WhatsApp da Honest para o número de
  // "DÉBITOS - Inbox de Informações" (+55 62 9451-1997; ajustável em system_settings
  // 'inbox_whatsapp_destino'). A observação digitada no card vai junto como "Obs. do admin".
  // Não muda o status do report — fica registrado na conversa do card.
  const whatsappMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/change-requests/${r.id}/whatsapp`, { extra: note.trim() || undefined }),
    onSuccess: (data: any) => {
      toast({ title: "Enviado por WhatsApp", description: `Recorte do report enviado para +${data?.destino || "55 62 9451-1997"}.` });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => toast({ title: "Erro no envio por WhatsApp", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // 💰 Previsão de pagamento: a data em que o cliente prometeu pagar. Ao chegar o dia, o sistema
  // lança uma pendência na Rota do Dia do vendedor (trava o Fechar Rota) e, se ele for externo,
  // manda um WhatsApp no celular dele para fazer a cobrança.
  // 🤖 Card aberto pelo SISTEMA (cadastro incompleto etc.): não tem vendedor. A Réplica abre um
  // box com a lista de vendedores + a escolha de rezonear ou manter o cadastro como está; ao
  // enviar, a mensagem cai na Rota do Dia do vendedor escolhido como uma réplica normal.
  // 23/set: a maioria dos cards do Sistema JÁ vem com um vendedor (o do cadastro) — exigir
  // sellerId vazio deixava o botão sem abrir o seletor, parecendo travado. Basta a origem ser
  // o Sistema; o vendedor atual, quando existe, vem pré-selecionado no box.
  const doSistema = /sistema/i.test(String(r.requestedByName || r.sellerName || ""));
  const [destOpen, setDestOpen] = useState(false);
  const [destSeller, setDestSeller] = useState(String(r.sellerId || ""));
  const [destRezonear, setDestRezonear] = useState<"manter" | "rezonear">("manter");
  const { data: vendedores = [] } = useQuery<any[]>({
    queryKey: ["/api/sellers/active"],
    enabled: doSistema && destOpen,
    staleTime: 300_000,
  });
  const atribuirMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/change-requests/${r.id}/atribuir-vendedor`, {
      sellerId: destSeller,
      sellerName: (vendedores.find((v: any) => String(v.id) === destSeller) || {}).name,
      texto: note.trim(),
      rezonear: destRezonear === "rezonear",
    }),
    onSuccess: (d: any) => {
      toast({
        title: "Enviado ao vendedor",
        description: `A pendência está na Rota do Dia de ${d?.sellerName || "quem você escolheu"}${d?.rezoneado ? " · cliente rezoneado" : ""}.`,
      });
      setDestOpen(false); setDestRezonear("manter"); setNote("");
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível enviar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  // Mesmo padrão da Quarentena: o botão só ABRE o box; ao confirmar, grava a previsão e fecha o
  // report (status "lido") — o card vai para Resolvidas. O aviso ao vendedor no dia continua
  // valendo: o cron das 07:00 reabre o card quando dispara a cobrança.
  const [previsaoOpen, setPrevisaoOpen] = useState(false);
  const [previsao, setPrevisao] = useState<string>("");
  const previsaoMut = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/change-requests/${r.id}/previsao-pagamento`, { data: previsao });
      return apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status: "lido" });
    },
    onSuccess: () => {
      toast({ title: "Cobrança agendada", description: "No dia, o vendedor é avisado (WhatsApp se for externo). O report foi para Resolvidas." });
      setPrevisaoOpen(false); setPrevisao("");
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
    },
    onError: (e: any) => toast({ title: "Erro ao agendar cobrança", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  const busy = resolveMut.isPending || inativarMut.isPending || inativarReportMut.isPending || quarentenaMut.isPending || whatsappMut.isPending;
  // 🗂️ Report do vendedor (não-venda, justificativa, atendimento virtual, desfecho de lead):
  // aparece no Inbox como item pendente; o admin só precisa "Marcar como lido".
  const isReport = r?.kind === "report";
  const rd = r?.details || {};

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold flex items-center gap-1.5">
            {onToggleSelect && (
              <input
                type="checkbox"
                checked={!!selected}
                onChange={() => onToggleSelect(r.id)}
                className="h-4 w-4 shrink-0 accent-indigo-600 cursor-pointer"
                title="Selecionar para limpar em lote"
                data-testid={`cr-select-${r.id}`}
              />
            )}
            <span>{r.entityName || r.entityId}</span>
            <CopyBtn text={r.entityName || r.entityId} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
            <Badge variant="outline" className="text-[10px]">{ENTITY_LABEL[r.entityType] || r.entityType}</Badge>
            {r.isRepescagem && <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300">Repescagem</Badge>}
            {isReport && <Badge variant="outline" className="text-[10px] bg-indigo-50 text-indigo-700 border-indigo-300">Report · {rd.reportLabel || "Registro"}</Badge>}
            {/* 🔁 Voltou ao Inbox porque o vendedor respondeu à réplica do admin */}
            {isReport && Array.isArray(r.messages) && r.messages.length > 0 && r.messages[r.messages.length - 1]?.role === "seller" && r.messages[r.messages.length - 1]?.kind === "reply" && (
              <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-300"><Reply className="h-3 w-3 mr-1" /> Tréplica do vendedor</Badge>
            )}
            <span className="flex items-center gap-1"><UserIcon className="h-3 w-3" /> {r.sellerName || r.requestedByName || "—"}</span>
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDate(r.createdAt)}</span>
          </div>
          {(r.neighborhood || r.city) ? <div className="text-[11px] text-muted-foreground mt-0.5">{[r.neighborhood, r.city].filter(Boolean).join(" · ")}</div> : null}
          {r.entityType === "customer" && <div className="mt-0.5"><UltimaCompra iso={r.lastOrderAt} /></div>}
        </div>
      </div>

      {isReport ? (
        <div className="rounded-md bg-indigo-50/60 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 p-2.5 text-sm space-y-1.5">
          {rd.motivo && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Motivo</div>
              <div>{rd.motivo}</div>
            </div>
          )}
          {rd.texto && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Observação do vendedor</div>
              <div className="whitespace-pre-wrap break-words">{rd.texto}</div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {(r.types || []).map((t: string) => (
              <Badge key={t} variant="secondary" className="text-[11px]">{TYPE_LABEL[t] || t}</Badge>
            ))}
          </div>
          <Detalhes details={r.details} />
        </>
      )}

      {Array.isArray(r.messages) && r.messages.length > 0 && (
        <div className="pt-1 border-t">
          <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
          <MessageThread messages={r.messages} />
        </div>
      )}

      <div className="space-y-1">
        <Textarea placeholder={isReport ? "Escreva uma réplica ao vendedor (ou observação ao marcar como lido)…" : "Observação (opcional) — ex.: o que foi feito ou por que foi rejeitado"} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        <VoiceDictateButton onText={(t) => setNote((p) => (p ? p.trim() + " " : "") + t)} testId="cr-admin-obs-audio" />
      </div>

      <div className="flex flex-wrap gap-2">
        {isReport ? (<>
          <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-50" disabled={busy || replyMut.isPending || !note.trim()} onClick={() => replyMut.mutate()}>
            {replyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Reply className="h-4 w-4 mr-1" /> Réplica</>}
          </Button>
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" disabled={busy} onClick={() => resolveMut.mutate("lido")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CheckCircle2 className="h-4 w-4 mr-1" /> Marcar como lido</>}
          </Button>
          <Button size="sm" variant="outline" className="border-green-500 text-green-700 hover:bg-green-50" disabled={busy}
            title="Envia o recorte deste report para DÉBITOS - Inbox de Informações (+55 62 9451-1997)"
            data-testid={`cr-whatsapp-${r.id}`}
            onClick={() => whatsappMut.mutate()}>
            {whatsappMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><MessageCircle className="h-4 w-4 mr-1" /> Envio Whatsapp</>}
          </Button>
          {r.entityType === "customer" && (<>
            <Button size="sm" variant="outline" className="border-red-400 text-red-700 hover:bg-red-50" disabled={busy}
              onClick={() => { if (window.confirm("Inativar este cliente? Ele sai dos Clientes Ativos (mesmas regras da inativação) e o report vai para Resolvidas.")) inativarReportMut.mutate(); }}>
              {inativarReportMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><XCircle className="h-4 w-4 mr-1" /> Inativar Cliente</>}
            </Button>
            <Button size="sm" variant="outline" className="border-amber-400 text-amber-700 hover:bg-amber-50" disabled={busy} onClick={() => setQuarentenaOpen((o) => !o)}>
              <Clock className="h-4 w-4 mr-1" /> Quarentena
            </Button>
            <Button size="sm" variant="outline" className="border-amber-500 text-amber-800 hover:bg-amber-50" disabled={busy}
              title="Registra a data em que o cliente prometeu pagar: no dia, o vendedor é avisado para cobrar"
              data-testid={`cr-previsao-abrir-${r.id}`}
              onClick={() => setPrevisaoOpen((o) => !o)}>
              <CalendarClock className="h-4 w-4 mr-1" /> Agendar cobrança
            </Button>
          </>)}
        </>) : (<>
        <Button size="sm" className="bg-green-600 hover:bg-green-700" disabled={busy} onClick={() => resolveMut.mutate("efetuadas")}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CheckCircle2 className="h-4 w-4 mr-1" /> Efetuadas</>}
        </Button>
        <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-50"
          disabled={busy || replyMut.isPending || (!doSistema && !note.trim())}
          title={doSistema ? "Escolher o vendedor que receberá esta pendência na Rota do Dia" : undefined}
          onClick={() => { if (doSistema) setDestOpen((o) => !o); else replyMut.mutate(); }}>
          {replyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Reply className="h-4 w-4 mr-1" /> Réplica</>}
        </Button>
        <Button size="sm" variant="outline" className="border-green-500 text-green-700 hover:bg-green-50" disabled={busy}
          title="Envia o recorte desta solicitação para DÉBITOS - Inbox de Informações (+55 62 9451-1997)"
          data-testid={`cr-whatsapp-sol-${r.id}`}
          onClick={() => whatsappMut.mutate()}>
          {whatsappMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><MessageCircle className="h-4 w-4 mr-1" /> Envio Whatsapp</>}
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => resolveMut.mutate("rejeitadas")}>
          <XCircle className="h-4 w-4 mr-1" /> Rejeitar
        </Button>
        {r.entityType === "customer" && (
          <Button
            size="sm"
            variant="outline"
            className="border-red-400 text-red-700 hover:bg-red-50"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Inativar este cliente? Ele sai dos Clientes Ativos e esta solicitação será fechada como Efetuada.")) inativarMut.mutate();
            }}
          >
            {inativarMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><XCircle className="h-4 w-4 mr-1" /> Inativar cliente</>}
          </Button>
        )}
        </>)}
      </div>

      {doSistema && destOpen && (
        <div className="rounded-md bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900 p-2.5 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
            Enviar para a Rota do Dia de qual vendedor?
          </div>
          <select
            value={destSeller}
            onChange={(e) => setDestSeller(e.target.value)}
            className="w-full sm:w-72 border rounded-md px-2 py-1.5 text-sm bg-white dark:bg-transparent"
            data-testid={`cr-dest-seller-${r.id}`}
          >
            <option value="">Escolha o vendedor…</option>
            {r.sellerId && !vendedores.some((v: any) => String(v.id) === String(r.sellerId)) && (
              <option value={String(r.sellerId)}>{r.sellerName || "Vendedor atual do cadastro"} (atual)</option>
            )}
            {vendedores.map((v: any) => (
              <option key={v.id} value={v.id}>{v.name}{v.role === "telemarketing" ? " (telemarketing)" : ""}</option>
            ))}
          </select>
          {r.entityType === "customer" && (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-muted-foreground">O cadastro deve ser rezoneado para esse vendedor?</div>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name={`rez-${r.id}`} checked={destRezonear === "manter"} onChange={() => setDestRezonear("manter")} className="accent-indigo-600" />
                  Manter como está
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name={`rez-${r.id}`} checked={destRezonear === "rezonear"} onChange={() => setDestRezonear("rezonear")} className="accent-indigo-600" data-testid={`cr-dest-rezonear-${r.id}`} />
                  Rezonear (troca o vendedor do cadastro)
                </label>
              </div>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground">
            A mensagem enviada é a que está escrita na caixa de texto acima.
            {!note.trim() && <span className="text-rose-600 dark:text-rose-400"> Escreva a mensagem para habilitar o envio.</span>}
            {r.sellerName && <> Vendedor atual do cadastro: <b>{r.sellerName}</b>.</>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!destSeller || !note.trim() || atribuirMut.isPending}
              onClick={() => atribuirMut.mutate()} data-testid={`cr-dest-enviar-${r.id}`}>
              {atribuirMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Reply className="h-4 w-4 mr-1" /> Enviar ao vendedor</>}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setDestOpen(false); setDestSeller(String(r.sellerId || "")); setDestRezonear("manter"); }}>Cancelar</Button>
          </div>
        </div>
      )}

      {isReport && previsaoOpen && r.entityType === "customer" && (
        <div className="flex flex-wrap items-end gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-2.5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-1">Previsão de pagamento</div>
            <input type="date" value={previsao} onChange={(e) => setPrevisao(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-white dark:bg-transparent" data-testid={`cr-previsao-date-${r.id}`} />
            <div className="text-[10px] text-muted-foreground mt-1">Data que o cliente prometeu pagar. Às 7h do dia, o vendedor recebe a pendência na Rota do Dia (e WhatsApp, se for externo).</div>
          </div>
          <Button size="sm" className="bg-amber-600 hover:bg-amber-700" disabled={!previsao || previsaoMut.isPending} onClick={() => previsaoMut.mutate()} data-testid={`cr-previsao-save-${r.id}`}>
            {previsaoMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CalendarClock className="h-4 w-4 mr-1" /> Agendar cobrança</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setPrevisaoOpen(false); setPrevisao(""); }}>Cancelar</Button>
          {rd?.previsaoPagamento && (
            <div className="basis-full text-[11px] text-amber-800 dark:text-amber-300">
              Já agendado para <b>{fmtDiaBR(rd.previsaoPagamento)}</b>{rd.previsaoAvisadaEm ? " · vendedor já avisado" : ""}. Confirmar de novo substitui a data.
            </div>
          )}
        </div>
      )}

      {isReport && quarentenaOpen && r.entityType === "customer" && (
        <div className="flex flex-wrap items-end gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-2.5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-1">Data de Início do Fornecimento</div>
            <input type="date" value={quarentenaDate} onChange={(e) => setQuarentenaDate(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-white dark:bg-transparent" data-testid="cr-quarentena-date" />
            <div className="text-[10px] text-muted-foreground mt-1">Data a partir da qual as visitas/fornecimento serão iniciados.</div>
          </div>
          <Button size="sm" className="bg-amber-600 hover:bg-amber-700" disabled={!quarentenaDate || quarentenaMut.isPending} onClick={() => quarentenaMut.mutate()}>
            {quarentenaMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Clock className="h-4 w-4 mr-1" /> Aplicar quarentena</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setQuarentenaOpen(false); setQuarentenaDate(""); }}>Cancelar</Button>
        </div>
      )}
    </Card>
  );
}

function ResolvedCard({ r }: { r: any }) {
  const { toast } = useToast();
  const m = RESULT_META[r.status];
  const isReport = r?.kind === "report";
  const rd = r?.details || {};
  // 📲 Envio Whatsapp também no report já resolvido (mesma rota do card pendente).
  const whatsappMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/change-requests/${r.id}/whatsapp`, {}),
    onSuccess: (data: any) => {
      toast({ title: "Enviado por WhatsApp", description: `Recorte do report enviado para +${data?.destino || "55 62 9451-1997"}.` });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
    },
    onError: (e: any) => toast({ title: "Erro no envio por WhatsApp", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold flex items-center gap-1.5">
            <span>{r.entityName || r.entityId}</span>
            <CopyBtn text={r.entityName || r.entityId} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
            <Badge variant="outline" className="text-[10px]">{ENTITY_LABEL[r.entityType] || r.entityType}</Badge>
            {r.isRepescagem && <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-300">Repescagem</Badge>}
            {isReport && <Badge variant="outline" className="text-[10px] bg-indigo-50 text-indigo-700 border-indigo-300">Report · {rd.reportLabel || "Registro"}</Badge>}
            <span className="flex items-center gap-1"><UserIcon className="h-3 w-3" /> {r.sellerName || r.requestedByName || "—"}</span>
            <span>{fmtDate(r.createdAt)}</span>
          </div>
          {(r.neighborhood || r.city) ? <div className="text-[11px] text-muted-foreground mt-0.5">{[r.neighborhood, r.city].filter(Boolean).join(" · ")}</div> : null}
          {r.entityType === "customer" && <div className="mt-0.5"><UltimaCompra iso={r.lastOrderAt} /></div>}
          {rd?.previsaoPagamento && (
            <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5 flex items-center gap-1">
              <CalendarClock className="h-3 w-3" /> Previsão de pagamento: <b>{fmtDiaBR(rd.previsaoPagamento)}</b>
              {rd.previsaoAvisadaEm ? " · vendedor avisado" : ""}
            </div>
          )}
        </div>
        {m && <Badge variant="outline" className={m.cls}>{m.label}</Badge>}
      </div>
      {isReport ? (
        <div className="rounded-md bg-muted/50 border p-2.5 text-sm space-y-1">
          {rd.motivo && <div><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Motivo: </span>{rd.motivo}</div>}
          {rd.texto && <div className="whitespace-pre-wrap break-words">{rd.texto}</div>}
        </div>
      ) : (<>
      <div className="flex flex-wrap gap-1">
        {(r.types || []).map((t: string) => <Badge key={t} variant="secondary" className="text-[11px]">{TYPE_LABEL[t] || t}</Badge>)}
      </div>
      <Detalhes details={r.details} />
      </>)}
      {Array.isArray(r.messages) && r.messages.length > 0 && (
        <div className="pt-1 border-t">
          <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
          <MessageThread messages={r.messages} />
        </div>
      )}
      {(!Array.isArray(r.messages) || r.messages.length === 0) && r.resolutionNote && (
        <div className="text-xs">Obs.: {r.resolutionNote}</div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground">Resolvido por {r.resolvedByName || "—"} • {fmtDate(r.resolvedAt)}</div>
        {isReport && (
          <Button size="sm" variant="outline" className="border-green-500 text-green-700 hover:bg-green-50 h-7 text-xs" disabled={whatsappMut.isPending}
            title="Envia o recorte deste report para DÉBITOS - Inbox de Informações (+55 62 9451-1997)"
            data-testid={`cr-whatsapp-resolved-${r.id}`}
            onClick={() => whatsappMut.mutate()}>
            {whatsappMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><MessageCircle className="h-3.5 w-3.5 mr-1" /> Envio Whatsapp</>}
          </Button>
        )}
      </div>
    </Card>
  );
}

// Card de SUGESTÃO DE MIGRAÇÃO DE CARTEIRA (repescagem) — decidido aqui no Inbox do admin.
function CarteiraSugestaoCard({ s }: { s: any }) {
  const { toast } = useToast();
  const decidir = useMutation({
    mutationFn: async (acao: "aprovar" | "rejeitar") => apiRequest("POST", `/api/repescagem/carteira-sugestoes/${s.id}/decidir`, { acao }),
    onSuccess: (_d, acao) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repescagem/carteira-sugestoes"] });
      toast({ title: acao === "aprovar" ? "Carteira migrada" : "Sugestão rejeitada", description: acao === "aprovar" ? "O cliente foi movido para o novo vendedor." : "Nenhuma alteração foi feita." });
    },
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Falha ao decidir", variant: "destructive" }),
  });
  return (
    <Card className="p-3 border-amber-300">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-amber-500 text-[11px]">Migração de carteira</Badge>
            <span className="text-sm font-semibold truncate">{s.customer_name || s.customer_id}</span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">Repescagem: 2º pedido implantado pelo mesmo vendedor · {s.from_name || s.from_seller_id || "—"} → <span className="font-semibold text-gray-700">{s.to_name || s.to_seller_id}</span></div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 h-8" disabled={decidir.isPending} onClick={() => decidir.mutate("aprovar")}><CheckCircle2 className="h-3.5 w-3.5 mr-1" />Aprovar</Button>
          <Button size="sm" variant="outline" className="h-8" disabled={decidir.isPending} onClick={() => decidir.mutate("rejeitar")}><XCircle className="h-3.5 w-3.5 mr-1" />Rejeitar</Button>
        </div>
      </div>
    </Card>
  );
}

export default function SolicitacoesAlteracao() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: pendingData, isLoading: loadingP } = useQuery<any>({
    queryKey: ["/api/change-requests", "pending"],
    queryFn: async () => apiRequest("GET", "/api/change-requests?status=pending"),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const { data: resolvedData, isLoading: loadingR } = useQuery<any>({
    queryKey: ["/api/change-requests", "resolved"],
    queryFn: async () => apiRequest("GET", "/api/change-requests?status=resolved"),
    enabled: isAdmin,
  });
  // Sugestões de migração de carteira (repescagem) — entram no mesmo Inbox.
  const { data: sugData } = useQuery<any>({
    queryKey: ["/api/repescagem/carteira-sugestoes"],
    queryFn: async () => apiRequest("GET", "/api/repescagem/carteira-sugestoes"),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  // Busca por cliente (aplica a Pendentes e Resolvidas).
  const [busca, setBusca] = useState("");
  // Filtro por vendedor (quem solicitou; aplica a Pendentes e Resolvidas).
  const [filtroVendedor, setFiltroVendedor] = useState("");

  // ✅ Seleção em lote + "Limpar caixa de pendentes": marca solicitações e as resolve
  // (status "lido") de uma vez — elas saem de Pendentes e vão para Resolvidas.
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkClear = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => apiRequest("POST", `/api/change-requests/${id}/resolve`, { status: "lido" })));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, fail: results.length - ok };
    },
    onSuccess: ({ ok, fail }: any) => {
      toast({ title: "Caixa de pendentes limpa", description: `${ok} solicitação(ões) enviada(s) para Resolvidas${fail ? ` · ${fail} falharam` : ""}.` });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
    },
    onError: (e: any) => toast({ title: "Erro ao limpar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });

  if (!isAdmin) {
    return <div className="p-6 text-sm text-muted-foreground">Acesso restrito aos administradores.</div>;
  }

  const pending: any[] = pendingData?.requests || [];
  const resolved: any[] = resolvedData?.requests || [];
  const sugestoes: any[] = sugData?.sugestoes || [];
  const totalPend = pending.length + sugestoes.length;

  // Lista de vendedores para o filtro: quem abriu a solicitação (requestedByName)
  // + origem/destino das sugestões de migração de carteira. Ordenada em pt-BR.
  const vendedoresSet = new Set<string>();
  for (const r of [...pending, ...resolved]) { if (r.requestedByName) vendedoresSet.add(r.requestedByName); }
  for (const s of sugestoes) { if (s.from_name) vendedoresSet.add(s.from_name); if (s.to_name) vendedoresSet.add(s.to_name); }
  const vendedores = Array.from(vendedoresSet).sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Filtro de busca por nome do cliente (case-insensitive) + filtro por vendedor.
  const q = busca.trim().toLowerCase();
  const matchNome = (nome) => !q || String(nome || "").toLowerCase().includes(q);
  const matchVend = (nome?: string) => !filtroVendedor || String(nome || "") === filtroVendedor;
  const matchVendSug = (s: any) => !filtroVendedor || s.from_name === filtroVendedor || s.to_name === filtroVendedor;
  const pendingF = pending.filter((r) => matchNome(r.entityName || r.entityId) && matchVend(r.requestedByName));
  const resolvedF = resolved.filter((r) => matchNome(r.entityName || r.entityId) && matchVend(r.requestedByName));
  const sugestoesF = sugestoes.filter((s) => matchNome(s.customer_name || s.customer_id) && matchVendSug(s));

  // Seleção em lote (escopada à lista de pendentes já filtrada).
  const selectedIds = pendingF.filter((r) => selected.has(r.id)).map((r) => r.id);
  const allSelected = pendingF.length > 0 && selectedIds.length === pendingF.length;
  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSelectAll = () => setSelected(() => (allSelected ? new Set<string>() : new Set(pendingF.map((r) => r.id))));
  const limparCaixa = () => {
    if (selectedIds.length === 0) return;
    if (window.confirm(`Limpar ${selectedIds.length} solicitação(ões) da caixa de pendentes? Elas vão para Resolvidas (marcadas como lidas).`)) bulkClear.mutate(selectedIds);
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Inbox className="h-6 w-6 text-indigo-600" />
        <h1 className="text-xl font-bold">Solicitações de Alteração</h1>
        {totalPend > 0 && <Badge className="bg-indigo-600">{totalPend}</Badge>}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Input
          placeholder="Buscar cliente..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="max-w-sm"
          data-testid="input-busca-cliente"
        />
        <select
          value={filtroVendedor}
          onChange={(e) => setFiltroVendedor(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm bg-white max-w-[220px]"
          title="Filtrar por vendedor"
          data-testid="select-filtro-vendedor"
        >
          <option value="">Todos os vendedores</option>
          {vendedores.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        {filtroVendedor && (
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground w-fit" onClick={() => setFiltroVendedor("")}>
            Limpar filtro
          </Button>
        )}
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">Pendentes {totalPend > 0 ? `(${totalPend})` : ""}</TabsTrigger>
          <TabsTrigger value="resolvidas">Resolvidas</TabsTrigger>
        </TabsList>

        <TabsContent value="pendentes" className="space-y-3 mt-3">
          {sugestoesF.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Migração de carteira (repescagem)</div>
              {sugestoesF.map((s) => <CarteiraSugestaoCard key={s.id} s={s} />)}
            </div>
          )}
          {pendingF.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pb-2 border-b">
              <Button variant="outline" size="sm" className="gap-1" onClick={toggleSelectAll} data-testid="cr-selecionar-tudo">
                {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                {allSelected ? "Desmarcar tudo" : "Selecionar tudo"}
              </Button>
              <span className="text-xs text-muted-foreground">{selectedIds.length} selecionada(s)</span>
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 ml-auto gap-1" disabled={selectedIds.length === 0 || bulkClear.isPending} onClick={limparCaixa} data-testid="cr-limpar-caixa">
                {bulkClear.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Limpar caixa de pendentes{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
              </Button>
            </div>
          )}
          {loadingP ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : pendingF.length === 0 ? (
            sugestoesF.length === 0 ? <div className="text-sm text-muted-foreground py-8 text-center">Nenhuma solicitação pendente. 🎉</div> : null
          ) : (
            pendingF.map((r) => <PendingCard key={r.id} r={r} selected={selected.has(r.id)} onToggleSelect={toggleSelect} />)
          )}
        </TabsContent>

        <TabsContent value="resolvidas" className="space-y-3 mt-3">
          {loadingR ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : resolvedF.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Nada resolvido ainda.</div>
          ) : (
            resolvedF.map((r) => <ResolvedCard key={r.id} r={r} />)
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
