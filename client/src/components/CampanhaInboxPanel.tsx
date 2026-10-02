// client/src/components/CampanhaInboxPanel.tsx
// Painel da Campanha de Outubro dentro do Inbox (Solicitacoes de Alteracao):
// lista os novos clientes do mes para o admin APROVAR (conta como cliente novo da
// campanha) ou REJEITAR (com justificativa obrigatoria). Cliente e pedido valem na
// carteira nos dois casos. A resposta aparece para o vendedor na rota do dia.
// So aparece para admin e apenas durante o mes da campanha (o backend devolve
// 403 para outros papeis e ativo=false fora do mes -> o painel some).
import { useState } from "react";
import { useQuery, queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, Loader2, Trophy } from "lucide-react";

type Row = { id: string; cliente: string; vendedor: string; regiao: string; pedido: number; data: string; status: string; justificativa: string };
type Resp = { ativo: boolean; rows: Row[] };

const INBOX_URL = "/api/campanha/outubro/inbox";

function brl(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataBr(iso: string): string {
  if (!iso) return "";
  const p = iso.slice(0, 10).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] : iso;
}

function Linha({ r }: { r: Row }) {
  const { toast } = useToast();
  const [rejeitando, setRejeitando] = useState(false);
  const [just, setJust] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function decidir(acao: "aprovar" | "rejeitar") {
    if (acao === "rejeitar" && !just.trim()) {
      toast({ title: "Informe a justificativa", description: "Ela vai para o vendedor na rota do dia.", variant: "destructive" });
      return;
    }
    setEnviando(true);
    try {
      await apiRequest("POST", "/api/campanha/outubro/decidir", { id: r.id, acao, justificativa: acao === "rejeitar" ? just.trim() : "" });
      toast({ title: acao === "aprovar" ? "Aprovado para a campanha" : "Rejeitado para a campanha", description: "Aviso enviado à rota do dia de " + r.vendedor + "." });
      queryClient.invalidateQueries({ queryKey: [INBOX_URL] });
      queryClient.invalidateQueries({ queryKey: ["/api/campanha/outubro"] });
    } catch (e: any) {
      toast({ title: "Não foi possível registrar", description: e?.message || String(e), variant: "destructive" });
    } finally { setEnviando(false); }
  }

  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate">{r.cliente}</div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="font-semibold text-emerald-700">{r.vendedor || "Sem vendedor"}</span>
            <span>Pedido <b className="text-foreground">{brl(r.pedido)}</b></span>
            {r.regiao && <span>Região: <b className="text-foreground">{r.regiao}</b></span>}
            {r.data && <span>1ª compra {dataBr(r.data)}</span>}
          </div>
        </div>
        {!rejeitando && (
          <div className="flex gap-2">
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 gap-1" disabled={enviando} onClick={() => decidir("aprovar")}>
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Aprovar p/ campanha
            </Button>
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50 gap-1" disabled={enviando} onClick={() => setRejeitando(true)}>
              <XCircle className="h-4 w-4" /> Rejeitar
            </Button>
          </div>
        )}
      </div>
      {rejeitando && (
        <div className="mt-2 space-y-2">
          <Textarea value={just} onChange={(e) => setJust(e.target.value)} placeholder="Justificativa da rejeição (vai para o vendedor na rota do dia)…" className="min-h-[60px] text-sm" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={enviando} onClick={() => { setRejeitando(false); setJust(""); }}>Cancelar</Button>
            <Button size="sm" variant="destructive" disabled={enviando} onClick={() => decidir("rejeitar")}>
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirmar rejeição
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CampanhaInboxPanel() {
  const [verDecididos, setVerDecididos] = useState(false);
  const { data } = useQuery<Resp | null>({
    queryKey: [INBOX_URL],
    queryFn: async () => {
      const res = await fetch(INBOX_URL, { credentials: "include" });
      if (!res.ok) return null; // 403 (nao-admin) ou erro: painel nao aparece
      return res.json();
    },
    retry: false,
    refetchInterval: 5 * 60_000,
  });

  if (!data || !data.ativo) return null;
  const pend = (data.rows || []).filter((r) => r.status === "pendente");
  const dec = (data.rows || []).filter((r) => r.status !== "pendente");
  const aprov = dec.filter((r) => r.status === "aprovado").length;
  const rej = dec.filter((r) => r.status === "rejeitado").length;

  return (
    <Card className="border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Trophy className="h-5 w-5 text-emerald-600" />
        <div className="font-semibold text-sm">Campanha de Outubro — novos clientes</div>
        {pend.length > 0 && <Badge className="bg-emerald-600">{pend.length} pendente{pend.length > 1 ? "s" : ""}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">Cliente e pedido valem na carteira nos dois casos — aqui você define se ele <b>conta como cliente novo da campanha</b>. A resposta vai para a <b>rota do dia</b> do vendedor.</p>
      {pend.length === 0 ? (
        <div className="text-xs text-muted-foreground py-1">Nenhum cadastro novo aguardando aprovação.</div>
      ) : (
        <div className="space-y-2">{pend.map((r) => <Linha key={r.id} r={r} />)}</div>
      )}
      {dec.length > 0 && (
        <div>
          <button type="button" className="text-xs text-emerald-700 hover:underline" onClick={() => setVerDecididos((v) => !v)}>
            {verDecididos ? "Ocultar" : "Ver"} decididos ({aprov} aprovado{aprov === 1 ? "" : "s"} · {rej} rejeitado{rej === 1 ? "" : "s"})
          </button>
          {verDecididos && (
            <div className="mt-2 space-y-1.5">
              {dec.map((r) => (
                <div key={r.id} className="rounded-md border bg-white px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-sm">{r.cliente}</span>
                    {r.status === "aprovado"
                      ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Aprovado</Badge>
                      : <Badge className="bg-red-100 text-red-700 hover:bg-red-100">Rejeitado</Badge>}
                  </div>
                  <div className="text-muted-foreground mt-0.5">{r.vendedor} · {brl(r.pedido)}{r.status === "rejeitado" && r.justificativa ? " · " + r.justificativa : ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
