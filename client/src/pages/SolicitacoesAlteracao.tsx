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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Inbox, CheckCircle2, AlertTriangle, XCircle, Loader2, User as UserIcon, Clock } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  periodicidade: "Periodicidade", dia_rota: "Dia de Rota", area_vendas: "Área de vendas",
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

function Detalhes({ details }: { details: any }) {
  if (!details || Object.keys(details).length === 0) return null;
  return (
    <div className="rounded-md bg-muted/60 p-2 text-xs space-y-0.5">
      {details.periodicidade && <div>Periodicidade: <b>{details.periodicidade}</b></div>}
      {Array.isArray(details.diaRota) && details.diaRota.length > 0 && <div>Dias: <b>{details.diaRota.join(", ")}</b></div>}
      {details.areaVendas && <div>Área de vendas: <b>{details.areaVendas}</b></div>}
      {details.inicioAtendimento && <div>Início de atendimento: <b>{details.inicioAtendimento}</b></div>}
      {details.outro && <div>Outro: <span className="italic">{details.outro}</span></div>}
    </div>
  );
}

function PendingCard({ r }: { r: any }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const resolveMut = useMutation({
    mutationFn: async (status: string) => apiRequest("POST", `/api/change-requests/${r.id}/resolve`, { status, note: note.trim() || undefined }),
    onSuccess: () => {
      toast({ title: "Solicitação fechada", description: "O resultado já aparece no card." });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/change-requests/states"] });
    },
    onError: (e: any) => toast({ title: "Erro ao resolver", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  const busy = resolveMut.isPending;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{r.entityName || r.entityId}</div>
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
          <div className="font-semibold">{r.entityName || r.entityId}</div>
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
      {r.resolutionNote && <div className="text-xs">Obs.: {r.resolutionNote}</div>}
      <div className="text-xs text-muted-foreground">Resolvido por {r.resolvedByName || "—"} • {fmtDate(r.resolvedAt)}</div>
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

  if (!isAdmin) {
    return <div className="p-6 text-sm text-muted-foreground">Acesso restrito aos administradores.</div>;
  }

  const pending: any[] = pendingData?.requests || [];
  const resolved: any[] = resolvedData?.requests || [];

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Inbox className="h-6 w-6 text-indigo-600" />
        <h1 className="text-xl font-bold">Solicitações de Alteração</h1>
        {pending.length > 0 && <Badge className="bg-indigo-600">{pending.length}</Badge>}
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">Pendentes {pending.length > 0 ? `(${pending.length})` : ""}</TabsTrigger>
          <TabsTrigger value="resolvidas">Resolvidas</TabsTrigger>
        </TabsList>

        <TabsContent value="pendentes" className="space-y-3 mt-3">
          {loadingP ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : pending.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Nenhuma solicitação pendente. 🎉</div>
          ) : (
            pending.map((r) => <PendingCard key={r.id} r={r} />)
          )}
        </TabsContent>

        <TabsContent value="resolvidas" className="space-y-3 mt-3">
          {loadingR ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : resolved.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Nada resolvido ainda.</div>
          ) : (
            resolved.map((r) => <ResolvedCard key={r.id} r={r} />)
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
