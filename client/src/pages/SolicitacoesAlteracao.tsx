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
import { Inbox, CheckCircle2, AlertTriangle, XCircle, Loader2, User as UserIcon, Clock, Copy, Check } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  periodicidade: "Periodicidade", dia_rota: "Dia de Rota", area_vendas: "Área de vendas",
  presencial_virtual: "Presencial/Virtual",
  inicio_atendimento: "Início de atendimento", inativar: "Inativar", outro: "Outro",
};
const ENTITY_LABEL: Record<string, string> = { customer: "Cliente", lead: "Lead", repescagem: "Repescagem" };
const RESULT_META: Record<string, { label: string; cls: string }> = {
  efetuadas: { label: "Efetuadas", cls: "bg-green-100 text-green-800 border-green-300" },
  parcial: { label: "Parcial", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  rejeitadas: { label: "Rejeitadas", cls: "bg-red-100 text-red-800 border-red-300" },
};

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

function PendingCard({ r }: { r: any }) {
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
  const busy = resolveMut.isPending;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold flex items-center gap-1.5">
            <span>{r.entityName || r.entityId}</span>
            <CopyBtn text={r.entityName || r.entityId} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
            <Badge variant="outline" className="text-[10px]">{ENTITY_LABEL[r.entityType] || r.entityType}</Badge>
            <span className="flex items-center gap-1"><UserIcon className="h-3 w-3" /> {r.requestedByName || "—"}</span>
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDate(r.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {(r.types || []).map((t: string) => (
          <Badge key={t} variant="secondary" className="text-[11px]">{TYPE_LABEL[t] || t}</Badge>
        ))}
      </div>
      <Detalhes details={r.details} />

      {Array.isArray(r.messages) && r.messages.length > 0 && (
        <div className="pt-1 border-t">
          <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
          <MessageThread messages={r.messages} />
        </div>
      )}

      <Textarea placeholder="Observação (opcional) — ex.: o que foi feito ou por que foi rejeitado" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="bg-green-600 hover:bg-green-700" disabled={busy} onClick={() => resolveMut.mutate("efetuadas")}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CheckCircle2 className="h-4 w-4 mr-1" /> Efetuadas</>}
        </Button>
        <Button size="sm" className="bg-amber-500 hover:bg-amber-600" disabled={busy} onClick={() => resolveMut.mutate("parcial")}>
          <AlertTriangle className="h-4 w-4 mr-1" /> Parcial
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => resolveMut.mutate("rejeitadas")}>
          <XCircle className="h-4 w-4 mr-1" /> Rejeitar
        </Button>
      </div>
    </Card>
  );
}

function ResolvedCard({ r }: { r: any }) {
  const m = RESULT_META[r.status];
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold flex items-center gap-1.5">
            <span>{r.entityName || r.entityId}</span>
            <CopyBtn text={r.entityName || r.entityId} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
            <Badge variant="outline" className="text-[10px]">{ENTITY_LABEL[r.entityType] || r.entityType}</Badge>
            <span className="flex items-center gap-1"><UserIcon className="h-3 w-3" /> {r.requestedByName || "—"}</span>
            <span>{fmtDate(r.createdAt)}</span>
          </div>
        </div>
        {m && <Badge variant="outline" className={m.cls}>{m.label}</Badge>}
      </div>
      <div className="flex flex-wrap gap-1">
        {(r.types || []).map((t: string) => <Badge key={t} variant="secondary" className="text-[11px]">{TYPE_LABEL[t] || t}</Badge>)}
      </div>
      <Detalhes details={r.details} />
      {Array.isArray(r.messages) && r.messages.length > 0 && (
        <div className="pt-1 border-t">
          <div className="text-[11px] font-semibold text-muted-foreground mb-1">Conversa</div>
          <MessageThread messages={r.messages} />
        </div>
      )}
      {(!Array.isArray(r.messages) || r.messages.length === 0) && r.resolutionNote && (
        <div className="text-xs">Obs.: {r.resolutionNote}</div>
      )}
      <div className="text-xs text-muted-foreground">Resolvido por {r.resolvedByName || "—"} • {fmtDate(r.resolvedAt)}</div>
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
          {loadingP ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : pendingF.length === 0 ? (
            sugestoesF.length === 0 ? <div className="text-sm text-muted-foreground py-8 text-center">Nenhuma solicitação pendente. 🎉</div> : null
          ) : (
            pendingF.map((r) => <PendingCard key={r.id} r={r} />)
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
