import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { exportToExcel } from "@/lib/tableTools";
import { ShoppingCart, Radio, MessageCircle, RefreshCw, Download, Settings2, Trash2, CheckCircle2 } from "lucide-react";

/**
 * CARRINHOS DA LOJA (02/nov/2026)
 * Quem está na loja.bebahonest.com.br agora, quem largou o carrinho e a recuperação
 * por WhatsApp (server/carrinho-loja.ts). A loja só identifica a pessoa depois que ela
 * digita o WhatsApp no checkout — antes disso a visita aparece como anônima.
 */

type Item = { id: string; n: string; p: number; q: number };
type Carrinho = {
  id: string; nome: string | null; telefone: string | null; email: string | null; tipo_cliente: string | null;
  itens: Item[]; qtd_itens: number; total: string | number; etapa: string; status: string; utm: Record<string, string> | null;
  visitas: number; criado_em: string; ultima_atividade: string; contato_em: string | null; abandonado_em: string | null;
  aviso_equipe_em: string | null; msg_cliente_em: string | null; msg_cliente_status: string | null; msg_cliente_por: string | null;
  recuperado_em: string | null; convertido_em: string | null; pedido_numero: string | null; observacao: string | null;
};

const ETAPA: Record<string, string> = { catalogo: "Vitrine", carrinho: "Carrinho", checkout: "Checkout", pix: "PIX gerado", cartao: "Cartão", sucesso: "Concluído" };
const STATUS: Record<string, { label: string; cls: string }> = {
  aberto: { label: "Em andamento", cls: "bg-sky-100 text-sky-800 border-sky-200" },
  abandonado: { label: "Abandonado", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  convertido: { label: "Comprou", cls: "bg-green-100 text-green-800 border-green-200" },
  descartado: { label: "Descartado", cls: "bg-gray-100 text-gray-700 border-gray-200" },
};
const brl = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const ha = (s?: string | null) => {
  if (!s) return "–";
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
};
const fone = (t?: string | null) => {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return t || "–";
};
const resumo = (itens: Item[]) => (itens || []).map((i) => `${i.q}x ${i.n}`).join(", ");
const origem = (u: Record<string, string> | null) => (!u ? "Direto" : u.utm_source ? `${u.utm_source}${u.utm_campaign ? ` · ${u.utm_campaign}` : ""}` : u.fbclid ? "Meta" : u.gclid ? "Google" : "Direto");

async function api(url: string, init?: RequestInit) {
  const r = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || j?.motivo || `HTTP ${r.status}`);
  return j;
}

export default function CarrinhosLoja() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("contato");
  const [dias, setDias] = useState("7");
  const [previa, setPrevia] = useState<{ c: Carrinho; texto: string } | null>(null);
  const [cfgAberta, setCfgAberta] = useState(false);

  const { data: resumoD, refetch: refetchResumo, isFetching: f1 } = useQuery<any>({
    queryKey: ["/api/carrinhos-loja/resumo"], queryFn: () => api("/api/carrinhos-loja/resumo"), refetchInterval: 20_000,
  });
  const { data: lista = [], refetch: refetchLista, isFetching: f2 } = useQuery<Carrinho[]>({
    queryKey: ["/api/carrinhos-loja", status, dias], queryFn: () => api(`/api/carrinhos-loja?status=${status}&dias=${dias}`), refetchInterval: 60_000,
  });
  const invalidar = () => { qc.invalidateQueries({ queryKey: ["/api/carrinhos-loja"] }); qc.invalidateQueries({ queryKey: ["/api/carrinhos-loja/resumo"] }); };

  const enviar = useMutation({
    mutationFn: ({ id, reenviar }: { id: string; reenviar?: boolean }) => api(`/api/carrinhos-loja/${id}/mensagem`, { method: "POST", body: JSON.stringify({ reenviar }) }),
    onSuccess: () => { toast({ title: "Mensagem enviada pelo WhatsApp" }); setPrevia(null); invalidar(); },
    onError: (e: any) => toast({ title: "Não enviou", description: String(e.message).replace(/_/g, " "), variant: "destructive" }),
  });
  const mudarStatus = useMutation({
    mutationFn: ({ id, st }: { id: string; st: string }) => api(`/api/carrinhos-loja/${id}/status`, { method: "POST", body: JSON.stringify({ status: st }) }),
    onSuccess: invalidar,
  });
  const salvarCfg = useMutation({
    mutationFn: (b: any) => api("/api/carrinhos-loja/config", { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => { toast({ title: "Configuração salva" }); invalidar(); },
    onError: (e: any) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const abrirPrevia = async (c: Carrinho) => {
    try { const r = await api(`/api/carrinhos-loja/${c.id}/previa`); setPrevia({ c, texto: r.texto }); }
    catch (e: any) { toast({ title: "Erro", description: e.message, variant: "destructive" }); }
  };

  const h = resumoD?.hoje || {};
  const online: any[] = resumoD?.online || [];
  const cfg = resumoD?.config;

  const exportar = () => exportToExcel(lista.map((c) => ({
    "Última atividade": fmtDT(c.ultima_atividade), Cliente: c.nome || "", WhatsApp: fone(c.telefone), "E-mail": c.email || "",
    Itens: resumo(c.itens), Total: Number(c.total || 0), Etapa: ETAPA[c.etapa] || c.etapa, Status: STATUS[c.status]?.label || c.status,
    Origem: origem(c.utm), "Msg ao cliente": c.msg_cliente_em ? `${fmtDT(c.msg_cliente_em)} (${c.msg_cliente_status || ""})` : "",
    Recuperado: c.recuperado_em ? "sim" : "", Pedido: c.pedido_numero || "",
  })), `carrinhos-loja-${new Date().toISOString().slice(0, 10)}`);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <BackToDashboardButton />
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><ShoppingCart className="h-6 w-6" /> Carrinhos da Loja</h1>
            <p className="text-sm text-muted-foreground">Quem está na loja agora, quem largou o carrinho e a recuperação por WhatsApp.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { refetchResumo(); refetchLista(); }} disabled={f1 || f2}><RefreshCw className={`h-4 w-4 mr-1 ${f1 || f2 ? "animate-spin" : ""}`} />Atualizar</Button>
          <Button variant="outline" size="sm" onClick={() => setCfgAberta(true)}><Settings2 className="h-4 w-4 mr-1" />Configurar</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          ["Na loja agora", online.length, "text-emerald-700"],
          ["Visitas hoje", h.visitas, ""],
          ["Com carrinho", h.com_carrinho, ""],
          ["Checkout", h.checkout, ""],
          ["Deixaram WhatsApp", h.com_contato, ""],
          ["Compraram", h.convertidos, "text-green-700"],
          ["Abandonados", h.abandonados, "text-orange-700"],
          ["Recuperados", h.recuperados, "text-emerald-700"],
        ].map(([l, v, c]) => (
          <Card key={String(l)}><CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{l}</div>
            <div className={`text-2xl font-bold ${c}`}>{Number(v || 0)}</div>
          </CardContent></Card>
        ))}
      </div>
      {Number(h.valor_abandonado || 0) > 0 && (
        <p className="text-sm text-orange-700">Valor em carrinhos abandonados hoje: <b>{brl(h.valor_abandonado)}</b>{Number(h.vindos_meta || 0) > 0 ? ` · ${h.vindos_meta} visita(s) vieram de anúncio Meta` : ""}</p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Radio className="h-4 w-4 text-emerald-600 animate-pulse" /> Na loja agora ({online.length})</CardTitle>
          <CardDescription>Atualiza a cada 20 s. Sem nome = visitante que ainda não informou o WhatsApp.</CardDescription>
        </CardHeader>
        <CardContent>
          {online.length === 0 ? <p className="text-sm text-muted-foreground">Ninguém na loja neste momento.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1 pr-3">Visitante</th><th className="pr-3">Onde está</th><th className="pr-3">Carrinho</th><th className="pr-3">Origem</th><th className="pr-3">Último sinal</th></tr></thead>
                <tbody>
                  {online.map((o) => (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">{o.nome ? <><b>{o.nome}</b><div className="text-xs text-muted-foreground">{fone(o.telefone)}</div></> : <span className="text-muted-foreground">Anônimo{o.visitas > 1 ? ` · ${o.visitas}ª visita` : ""}</span>}</td>
                      <td className="pr-3"><Badge variant="outline">{ETAPA[o.etapa] || o.etapa}</Badge></td>
                      <td className="pr-3">{o.qtd_itens > 0 ? <>{brl(o.total)} <span className="text-xs text-muted-foreground">({resumo(o.itens)})</span></> : <span className="text-muted-foreground">vazio</span>}</td>
                      <td className="pr-3 text-xs">{origem(o.utm)}</td>
                      <td className="pr-3 text-xs">{ha(o.ultima_atividade)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <CardTitle className="text-base">Carrinhos</CardTitle>
              <CardDescription>
                Abandono = parado há {cfg?.abandonoMin ?? 60} min com WhatsApp informado. Mensagem automática ao cliente: <b>{cfg?.msgAuto ? "ligada (8h–20h)" : "desligada"}</b>.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="contato">Com WhatsApp</SelectItem>
                  <SelectItem value="abandonado">Abandonados</SelectItem>
                  <SelectItem value="aberto">Em andamento</SelectItem>
                  <SelectItem value="convertido">Compraram</SelectItem>
                  <SelectItem value="descartado">Descartados</SelectItem>
                  <SelectItem value="todos">Todos com carrinho</SelectItem>
                </SelectContent>
              </Select>
              <Select value={dias} onValueChange={setDias}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Hoje/24 h</SelectItem>
                  <SelectItem value="7">7 dias</SelectItem>
                  <SelectItem value="30">30 dias</SelectItem>
                  <SelectItem value="90">90 dias</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={exportar} disabled={!lista.length}><Download className="h-4 w-4 mr-1" />Excel</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {lista.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum carrinho neste filtro.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-3">Cliente</th><th className="pr-3">Itens</th><th className="pr-3 text-right">Total</th><th className="pr-3">Parou em</th>
                  <th className="pr-3">Status</th><th className="pr-3">Mensagem</th><th className="pr-3">Atividade</th><th></th>
                </tr></thead>
                <tbody>
                  {lista.map((c) => {
                    const st = STATUS[c.status] || { label: c.status, cls: "" };
                    return (
                      <tr key={c.id} className="border-b last:border-0 align-top">
                        <td className="py-2 pr-3">
                          <b>{c.nome || "(sem nome)"}</b>
                          <div className="text-xs text-muted-foreground">{fone(c.telefone)}{c.email ? ` · ${c.email}` : ""}</div>
                          <div className="text-xs text-muted-foreground">{origem(c.utm)}</div>
                        </td>
                        <td className="pr-3 text-xs max-w-[280px]">{resumo(c.itens) || "–"}</td>
                        <td className="pr-3 text-right whitespace-nowrap">{brl(c.total)}</td>
                        <td className="pr-3"><Badge variant="outline">{ETAPA[c.etapa] || c.etapa}</Badge></td>
                        <td className="pr-3">
                          <Badge variant="outline" className={st.cls}>{st.label}</Badge>
                          {c.recuperado_em && <div className="text-xs text-emerald-700 mt-1 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />recuperado</div>}
                          {c.pedido_numero && <div className="text-xs text-muted-foreground">pedido {c.pedido_numero}</div>}
                        </td>
                        <td className="pr-3 text-xs">{c.msg_cliente_em ? <>{fmtDT(c.msg_cliente_em)}<div className={c.msg_cliente_status === "enviada" ? "text-emerald-700" : "text-red-600"}>{c.msg_cliente_status}{c.msg_cliente_por && c.msg_cliente_por !== "automatico" ? ` · ${c.msg_cliente_por}` : ""}</div></> : "–"}</td>
                        <td className="pr-3 text-xs whitespace-nowrap">{ha(c.ultima_atividade)}<div className="text-muted-foreground">{fmtDT(c.ultima_atividade)}</div></td>
                        <td className="text-right whitespace-nowrap">
                          {c.telefone && c.status !== "convertido" && (
                            <Button size="sm" variant="outline" className="mr-1" onClick={() => abrirPrevia(c)}><MessageCircle className="h-4 w-4 mr-1" />{c.msg_cliente_em ? "Reenviar" : "Chamar"}</Button>
                          )}
                          {c.status !== "convertido" && c.status !== "descartado" && (
                            <Button size="sm" variant="ghost" title="Descartar" onClick={() => mudarStatus.mutate({ id: c.id, st: "descartado" })}><Trash2 className="h-4 w-4" /></Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!previa} onOpenChange={(o) => !o && setPrevia(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Mensagem de recuperação</DialogTitle>
            <DialogDescription>Vai pelo WhatsApp da Honest para {previa?.c.nome || "o cliente"} · {fone(previa?.c.telefone)}. O link devolve o carrinho na loja.</DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md">{previa?.texto}</pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPrevia(null)}>Cancelar</Button>
            <Button onClick={() => previa && enviar.mutate({ id: previa.c.id, reenviar: !!previa.c.msg_cliente_em })} disabled={enviar.isPending}>
              <MessageCircle className="h-4 w-4 mr-1" />{enviar.isPending ? "Enviando…" : "Enviar agora"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cfgAberta} onOpenChange={setCfgAberta}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Configurar carrinho abandonado</DialogTitle>
            <DialogDescription>Valem na próxima varredura (a cada 5 min).</DialogDescription>
          </DialogHeader>
          {cfg && <ConfigForm cfg={cfg} onSalvar={(b) => salvarCfg.mutate(b)} salvando={salvarCfg.isPending} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConfigForm({ cfg, onSalvar, salvando }: { cfg: any; onSalvar: (b: any) => void; salvando: boolean }) {
  const [abandonoMin, setAbandonoMin] = useState(String(cfg.abandonoMin));
  const [msgAuto, setMsgAuto] = useState(!!cfg.msgAuto);
  const [avisoEquipe, setAvisoEquipe] = useState(!!cfg.avisoEquipe);
  const [tels, setTels] = useState(cfg.avisoTelefones || "");
  return (
    <div className="space-y-4">
      <div><Label>Minutos parado para considerar abandono</Label><Input type="number" min={15} max={1440} value={abandonoMin} onChange={(e) => setAbandonoMin(e.target.value)} /></div>
      <div className="flex items-center justify-between"><Label>Mensagem automática ao cliente (8h–20h)</Label><Switch checked={msgAuto} onCheckedChange={setMsgAuto} /></div>
      <div className="flex items-center justify-between"><Label>Avisar a equipe no WhatsApp</Label><Switch checked={avisoEquipe} onCheckedChange={setAvisoEquipe} /></div>
      <div>
        <Label>WhatsApp da equipe (separados por vírgula)</Label>
        <Input placeholder="vazio = telefone_gestor_relatorios" value={tels} onChange={(e) => setTels(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button onClick={() => onSalvar({ abandonoMin: Number(abandonoMin), msgAuto, avisoEquipe, avisoTelefones: tels })} disabled={salvando}>{salvando ? "Salvando…" : "Salvar"}</Button>
      </div>
    </div>
  );
}
