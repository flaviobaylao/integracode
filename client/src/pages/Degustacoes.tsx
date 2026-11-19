// client/src/pages/Degustacoes.tsx
// -----------------------------------------------------------------------------
// PROMOÇÃO DE DEGUSTAÇÕES (tela /degustacoes, grupo Clientes) — 19/nov/2026
//
// Solicitação → chamado automático para a Lanucy → amostras no mesmo formulário de
// venda (caem em Bloqueados com as observações) → compromisso na agenda de Flávio,
// Cinthia, Lanucy e vendedor → Lanucy finaliza o chamado com as fotos → concluída.
// Fonte: /api/degustacoes (server/degustacoes-routes.ts).
// -----------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import SaleModal from "@/components/SaleModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Loader2, Search, CalendarClock, MapPin, Users, Package, Ticket, Camera, CheckCircle2, XCircle, Pencil, RefreshCw, Building2, Store, Wine,
} from "lucide-react";

type Degustacao = {
  id: string; numero: number; codigo: string; status: "aberta" | "concluida" | "cancelada";
  customerId: string; clienteNome: string; clienteRazao?: string; clienteEndereco?: string;
  sellerId?: string; vendedorNome?: string | null;
  data: string; horaInicio: string; horaFim?: string | null; local?: string | null;
  executorTipo: "honest" | "terceirizada"; empresaNome?: string | null; empresaContato?: string | null; empresaTelefone?: string | null;
  responsavelExecucao?: string | null; materiais: string[]; materiaisOutros?: string | null; publicoEstimado?: number | null; observacoes?: string | null;
  salesCardId?: string | null; amostra: { codigo: string; label: string }; amostraValor?: number | null; amostraProdutos?: any[];
  chamadoId?: string | null; chamadoCodigo?: string | null; chamadoStatus?: string | null;
  criadoPorNome?: string; concluidaEm?: string | null; canceladaEm?: string | null; motivoCancelamento?: string | null;
};
type Cliente = { id: string; nome: string; razao?: string; documento?: string; endereco?: string; vendedor?: string };
type Form = {
  customerId: string; clienteNome: string; data: string; horaInicio: string; horaFim: string; local: string;
  executorTipo: "honest" | "terceirizada"; empresaNome: string; empresaContato: string; empresaTelefone: string; responsavelExecucao: string;
  materiais: string[]; materiaisOutros: string; publicoEstimado: string; observacoes: string;
};

const FORM_VAZIO: Form = {
  customerId: "", clienteNome: "", data: "", horaInicio: "", horaFim: "", local: "", executorTipo: "honest",
  empresaNome: "", empresaContato: "", empresaTelefone: "", responsavelExecucao: "", materiais: [], materiaisOutros: "", publicoEstimado: "", observacoes: "",
};
const FILTROS = [{ v: "aberta", l: "Em aberto" }, { v: "concluida", l: "Concluídas" }, { v: "cancelada", l: "Canceladas" }, { v: "", l: "Todas" }];
const STATUS_COR: Record<string, string> = { aberta: "bg-amber-100 text-amber-800", concluida: "bg-green-100 text-green-800", cancelada: "bg-gray-200 text-gray-700" };
const STATUS_LABEL: Record<string, string> = { aberta: "Em aberto", concluida: "Concluída", cancelada: "Cancelada" };
const AMOSTRA_COR: Record<string, string> = { sem_amostra: "bg-gray-100 text-gray-700", rascunho: "bg-yellow-100 text-yellow-800", bloqueada: "bg-red-100 text-red-800", liberada: "bg-blue-100 text-blue-800", pipeline: "bg-blue-100 text-blue-800", cancelada: "bg-gray-200 text-gray-600" };
const CHAMADO_LABEL: Record<string, string> = { novo: "Novo", em_atendimento: "Em atendimento", respondido: "Respondido", reaberto: "Reaberto", solucionado: "Solucionado", cancelado: "Cancelado" };

const dBR = (s?: string | null) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : "—"; };
const dtBR = (s?: string | null) => { if (!s) return ""; const d = new Date(s); return isNaN(d.getTime()) ? String(s) : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const erroMsg = (e: any) => { const t = String(e?.message || e || "Erro"); const i = t.indexOf("{"); if (i >= 0) { try { return JSON.parse(t.slice(i)).message || t; } catch { /* texto cru */ } } return t.replace(/^\d{3}:\s*/, ""); };
const brl = (n?: number | null) => (n == null ? "" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));

function deParaForm(d: Degustacao): Form {
  return {
    customerId: d.customerId, clienteNome: d.clienteNome, data: d.data || "", horaInicio: d.horaInicio || "", horaFim: d.horaFim || "", local: d.local || "",
    executorTipo: d.executorTipo, empresaNome: d.empresaNome || "", empresaContato: d.empresaContato || "", empresaTelefone: d.empresaTelefone || "",
    responsavelExecucao: d.responsavelExecucao || "", materiais: d.materiais || [], materiaisOutros: d.materiaisOutros || "",
    publicoEstimado: d.publicoEstimado ? String(d.publicoEstimado) : "", observacoes: d.observacoes || "",
  };
}

// Linha do tempo do processo (o que já aconteceu nesta degustação)
function Etapas({ d, nFotos }: { d: Degustacao; nFotos: number }) {
  const amostraOk = ["bloqueada", "liberada", "pipeline"].includes(d.amostra.codigo);
  const passos = [
    { l: "Solicitada", ok: true },
    { l: `Chamado ${d.chamadoCodigo || ""}`.trim(), ok: !!d.chamadoId },
    { l: "Agenda", ok: d.status !== "cancelada" },
    { l: "Amostras", ok: amostraOk },
    { l: `Fotos${nFotos ? ` (${nFotos})` : ""}`, ok: nFotos > 0 },
    { l: "Concluída", ok: d.status === "concluida" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {passos.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded-full border ${p.ok ? "bg-green-600 text-white border-green-600" : "bg-white text-gray-500 border-gray-300"}`}>{p.l}</span>
          {i < passos.length - 1 && <span className="text-gray-300">›</span>}
        </span>
      ))}
    </div>
  );
}

export default function Degustacoes() {
  const { toast } = useToast();
  const [filtro, setFiltro] = useState("aberta");
  const [busca, setBusca] = useState("");
  const [lista, setLista] = useState<Degustacao[]>([]);
  const [resumo, setResumo] = useState<{ status: string; n: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [materiaisPadrao, setMateriaisPadrao] = useState<string[]>([]);

  // formulário (novo/editar)
  const [formAberto, setFormAberto] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(FORM_VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [qCli, setQCli] = useState("");
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [buscandoCli, setBuscandoCli] = useState(false);

  // detalhe
  const [detId, setDetId] = useState<string | null>(null);
  const [det, setDet] = useState<{ degustacao: Degustacao; mensagens: any[]; fotos: any[] } | null>(null);
  const [carregandoDet, setCarregandoDet] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [abrindoAmostra, setAbrindoAmostra] = useState(false);
  const [cardVenda, setCardVenda] = useState<any | null>(null);
  const [fotoGrande, setFotoGrande] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiRequest("GET", `/api/degustacoes?status=${encodeURIComponent(filtro)}`);
      setLista(d.degustacoes || []); setResumo(d.resumo || []);
    } catch (e) { toast({ title: "Erro ao carregar", description: erroMsg(e), variant: "destructive" }); }
    finally { setLoading(false); }
  }, [filtro, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => { apiRequest("GET", "/api/degustacoes/materiais").then((d) => setMateriaisPadrao(d.materiais || [])).catch(() => {}); }, []);

  // ?id=... abre o detalhe direto (link do chamado e da agenda)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setDetId(id);
  }, []);

  const carregarDet = useCallback(async (id: string) => {
    setCarregandoDet(true);
    try { setDet(await apiRequest("GET", `/api/degustacoes/${id}`)); }
    catch (e) { toast({ title: "Erro", description: erroMsg(e), variant: "destructive" }); setDetId(null); }
    finally { setCarregandoDet(false); }
  }, [toast]);
  useEffect(() => { if (detId) carregarDet(detId); else setDet(null); }, [detId, carregarDet]);

  // busca de cliente (debounce)
  useEffect(() => {
    if (!formAberto || editId) return;
    const q = qCli.trim();
    if (q.length < 2) { setClientes([]); return; }
    const t = setTimeout(async () => {
      setBuscandoCli(true);
      try { const d = await apiRequest("GET", `/api/degustacoes/clientes?q=${encodeURIComponent(q)}`); setClientes(d.clientes || []); }
      catch { setClientes([]); } finally { setBuscandoCli(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [qCli, formAberto, editId]);

  const n = (st: string) => (st ? Number(resumo.find((r) => r.status === st)?.n || 0) : resumo.reduce((s, r) => s + Number(r.n || 0), 0));
  const filtrada = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((d) => [d.codigo, d.clienteNome, d.clienteRazao, d.vendedorNome, d.empresaNome, d.local].some((x) => String(x || "").toLowerCase().includes(q)));
  }, [lista, busca]);

  const novo = () => { setEditId(null); setForm(FORM_VAZIO); setQCli(""); setClientes([]); setFormAberto(true); };
  const editar = (d: Degustacao) => { setEditId(d.id); setForm(deParaForm(d)); setFormAberto(true); };
  const set = (k: keyof Form, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const toggleMat = (m: string) => setForm((f) => ({ ...f, materiais: f.materiais.includes(m) ? f.materiais.filter((x) => x !== m) : [...f.materiais, m] }));

  const salvar = async () => {
    if (!form.customerId) return toast({ title: "Escolha o cliente", variant: "destructive" });
    if (!form.data || !form.horaInicio) return toast({ title: "Informe data e hora de início", variant: "destructive" });
    if (form.executorTipo === "terceirizada" && !form.empresaNome.trim()) return toast({ title: "Informe a empresa que vai executar", variant: "destructive" });
    setSalvando(true);
    try {
      const body = { ...form, publicoEstimado: form.publicoEstimado || null };
      if (editId) {
        await apiRequest("PATCH", `/api/degustacoes/${editId}`, body);
        toast({ title: "Degustação atualizada", description: "Agendas e chamado atualizados." });
        setFormAberto(false); carregar(); if (detId === editId) carregarDet(editId);
      } else {
        const r = await apiRequest("POST", "/api/degustacoes", body);
        const d: Degustacao = r.degustacao;
        toast({ title: `${d.codigo} aberta`, description: `Chamado ${d.chamadoCodigo || ""} enviado à Lanucy e compromisso nas agendas. Agora lance as amostras.` });
        setFormAberto(false); carregar(); setDetId(d.id);
      }
    } catch (e) { toast({ title: "Não foi possível salvar", description: erroMsg(e), variant: "destructive" }); }
    finally { setSalvando(false); }
  };

  const abrirAmostra = async (d: Degustacao) => {
    setAbrindoAmostra(true);
    try {
      const r = await apiRequest("POST", `/api/degustacoes/${d.id}/amostra`);
      const card = await apiRequest("GET", `/api/sales-cards/${r.salesCardId}`);
      setCardVenda({ ...card, operationType: "amostra" });
    } catch (e) { toast({ title: "Não foi possível abrir a amostra", description: erroMsg(e), variant: "destructive" }); }
    finally { setAbrindoAmostra(false); }
  };
  const fecharVenda = () => {
    setCardVenda(null);
    queryClient.invalidateQueries({ queryKey: ["/api/sales-cards"] });
    // o bloqueio é gravado na finalização; dá um respiro e recarrega
    setTimeout(() => { carregar(); if (detId) carregarDet(detId); }, 800);
  };

  const cancelar = async () => {
    if (!det) return;
    if (motivo.trim().length < 3) return toast({ title: "Informe o motivo", variant: "destructive" });
    try {
      await apiRequest("POST", `/api/degustacoes/${det.degustacao.id}/cancelar`, { motivo });
      toast({ title: "Degustação cancelada", description: "Agendas removidas e chamado encerrado." });
      setCancelando(false); setMotivo(""); carregar(); carregarDet(det.degustacao.id);
    } catch (e) { toast({ title: "Não foi possível cancelar", description: erroMsg(e), variant: "destructive" }); }
  };

  const d = det?.degustacao;
  const podeAmostra = d && d.status !== "cancelada" && ["sem_amostra", "rascunho", "cancelada"].includes(d.amostra.codigo);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <BackToDashboardButton />
          <div className="h-10 w-10 rounded-lg bg-green-600 text-white flex items-center justify-center"><Wine className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-bold">Promoção de Degustações</h1>
            <p className="text-sm text-muted-foreground">Solicitação → chamado à Lanucy → amostras (Bloqueados) → agenda → fotos e conclusão</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={carregar} disabled={loading}><RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />Atualizar</Button>
          <Button onClick={novo} className="bg-green-600 hover:bg-green-700"><Plus className="h-4 w-4 mr-1" />Nova degustação</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTROS.map((f) => (
          <Button key={f.v} size="sm" variant={filtro === f.v ? "default" : "outline"} onClick={() => setFiltro(f.v)}>
            {f.l} <Badge variant="secondary" className="ml-2">{n(f.v)}</Badge>
          </Button>
        ))}
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="h-4 w-4 absolute left-2 top-2.5 text-gray-400" />
          <Input className="pl-8" placeholder="Buscar cliente, código, empresa…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : filtrada.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhuma degustação {filtro ? `“${FILTROS.find((f) => f.v === filtro)?.l.toLowerCase()}”` : ""}.</CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtrada.map((x) => (
            <Card key={x.id} className="cursor-pointer hover:shadow-md transition" onClick={() => setDetId(x.id)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs text-muted-foreground">{x.codigo}</div>
                    <div className="font-semibold leading-tight">{x.clienteNome}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COR[x.status]}`}>{STATUS_LABEL[x.status]}</span>
                </div>
                <div className="text-sm flex items-center gap-1"><CalendarClock className="h-4 w-4 text-green-700" />{dBR(x.data)} · {x.horaInicio}{x.horaFim ? `–${x.horaFim}` : ""}</div>
                {x.local && <div className="text-xs text-muted-foreground flex items-start gap-1"><MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="line-clamp-1">{x.local}</span></div>}
                <div className="text-xs flex items-center gap-1">
                  {x.executorTipo === "terceirizada" ? <><Building2 className="h-3.5 w-3.5" />{x.empresaNome}</> : <><Store className="h-3.5 w-3.5" />Própria Honest</>}
                  {x.vendedorNome ? <span className="text-muted-foreground"> · vend. {x.vendedorNome}</span> : null}
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  <span className={`text-[11px] px-2 py-0.5 rounded ${AMOSTRA_COR[x.amostra.codigo] || "bg-gray-100"}`}><Package className="h-3 w-3 inline mr-1" />{x.amostra.label}</span>
                  {x.chamadoCodigo && <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-50 text-emerald-800"><Ticket className="h-3 w-3 inline mr-1" />{x.chamadoCodigo} · {CHAMADO_LABEL[x.chamadoStatus || ""] || x.chamadoStatus}</span>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ---------- Formulário ---------- */}
      <Dialog open={formAberto} onOpenChange={(o) => !salvando && setFormAberto(o)}>
        <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Editar degustação" : "Nova promoção de degustação"}</DialogTitle>
            <DialogDescription>
              {editId ? "As agendas e o chamado da Lanucy são atualizados ao salvar." : "Ao salvar: abre chamado para a Lanucy e marca na agenda de Flávio, Cinthia, Lanucy e do vendedor do cliente."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Cliente *</Label>
              {form.customerId ? (
                <div className="flex items-center justify-between rounded border p-2 mt-1 bg-green-50">
                  <span className="font-medium text-sm">{form.clienteNome}</span>
                  {!editId && <Button size="sm" variant="ghost" onClick={() => { set("customerId", ""); set("clienteNome", ""); }}>Trocar</Button>}
                </div>
              ) : (
                <div className="mt-1">
                  <Input placeholder="Nome, fantasia ou CNPJ…" value={qCli} onChange={(e) => setQCli(e.target.value)} autoFocus />
                  {buscandoCli && <div className="text-xs text-muted-foreground mt-1">Buscando…</div>}
                  {clientes.length > 0 && (
                    <div className="border rounded mt-1 max-h-52 overflow-y-auto divide-y">
                      {clientes.map((c) => (
                        <button key={c.id} type="button" className="w-full text-left p-2 hover:bg-gray-50"
                          onClick={() => setForm((f) => ({ ...f, customerId: c.id, clienteNome: c.nome, local: f.local || c.endereco || "" }))}>
                          <div className="text-sm font-medium">{c.nome}</div>
                          <div className="text-xs text-muted-foreground">{[c.documento, c.endereco, c.vendedor && `vend. ${c.vendedor}`].filter(Boolean).join(" · ")}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div><Label>Data *</Label><Input type="date" value={form.data} onChange={(e) => set("data", e.target.value)} /></div>
              <div><Label>Início *</Label><Input type="time" value={form.horaInicio} onChange={(e) => set("horaInicio", e.target.value)} /></div>
              <div><Label>Término</Label><Input type="time" value={form.horaFim} onChange={(e) => set("horaFim", e.target.value)} /></div>
            </div>
            <div><Label>Local</Label><Input placeholder="Endereço / ponto dentro da loja" value={form.local} onChange={(e) => set("local", e.target.value)} /></div>

            <div>
              <Label>Quem executa a degustação *</Label>
              <div className="flex gap-2 mt-1">
                <Button type="button" size="sm" variant={form.executorTipo === "honest" ? "default" : "outline"} onClick={() => set("executorTipo", "honest")}><Store className="h-4 w-4 mr-1" />Própria Honest</Button>
                <Button type="button" size="sm" variant={form.executorTipo === "terceirizada" ? "default" : "outline"} onClick={() => set("executorTipo", "terceirizada")}><Building2 className="h-4 w-4 mr-1" />Empresa terceirizada</Button>
              </div>
              {form.executorTipo === "terceirizada" ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                  <div><Label className="text-xs">Empresa *</Label><Input value={form.empresaNome} onChange={(e) => set("empresaNome", e.target.value)} /></div>
                  <div><Label className="text-xs">Contato</Label><Input value={form.empresaContato} onChange={(e) => set("empresaContato", e.target.value)} /></div>
                  <div><Label className="text-xs">Telefone</Label><Input value={form.empresaTelefone} onChange={(e) => set("empresaTelefone", e.target.value)} /></div>
                </div>
              ) : (
                <div className="mt-2"><Label className="text-xs">Responsável Honest pela execução</Label><Input placeholder="Quem vai estar no ponto" value={form.responsavelExecucao} onChange={(e) => set("responsavelExecucao", e.target.value)} /></div>
              )}
            </div>

            <div>
              <Label>Materiais necessários</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1">
                {materiaisPadrao.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={form.materiais.includes(m)} onCheckedChange={() => toggleMat(m)} />{m}
                  </label>
                ))}
              </div>
              <Input className="mt-2" placeholder="Outros materiais…" value={form.materiaisOutros} onChange={(e) => set("materiaisOutros", e.target.value)} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div><Label>Público estimado</Label><Input type="number" min={0} value={form.publicoEstimado} onChange={(e) => set("publicoEstimado", e.target.value)} /></div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea rows={4} placeholder="Sabores, abordagem, ação comercial, cuidados… (vão para o chamado e para o bloqueio da amostra)" value={form.observacoes} onChange={(e) => set("observacoes", e.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormAberto(false)} disabled={salvando}>Fechar</Button>
            <Button onClick={salvar} disabled={salvando} className="bg-green-600 hover:bg-green-700">
              {salvando && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{editId ? "Salvar alterações" : "Abrir degustação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Detalhe ---------- */}
      <Dialog open={!!detId && !cardVenda} onOpenChange={(o) => { if (!o) { setDetId(null); setCancelando(false); window.history.replaceState(null, "", "/degustacoes"); } }}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          {carregandoDet || !d ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {d.codigo} — {d.clienteNome}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COR[d.status]}`}>{STATUS_LABEL[d.status]}</span>
                </DialogTitle>
                <DialogDescription>Aberta por {d.criadoPorNome || "—"}{d.vendedorNome ? ` · vendedor ${d.vendedorNome}` : ""}</DialogDescription>
              </DialogHeader>

              <Etapas d={d} nFotos={det?.fotos.length || 0} />

              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded border p-3 space-y-1">
                  <div className="flex items-center gap-1 font-medium"><CalendarClock className="h-4 w-4" />{dBR(d.data)} · {d.horaInicio}{d.horaFim ? ` às ${d.horaFim}` : ""}</div>
                  <div className="flex items-start gap-1 text-muted-foreground"><MapPin className="h-4 w-4 mt-0.5 shrink-0" />{d.local || d.clienteEndereco || "—"}</div>
                  {d.publicoEstimado ? <div className="flex items-center gap-1 text-muted-foreground"><Users className="h-4 w-4" />{d.publicoEstimado} pessoas</div> : null}
                  <div className="text-xs text-muted-foreground pt-1">Na agenda de Flávio, Cinthia, Lanucy e do vendedor.</div>
                </div>
                <div className="rounded border p-3 space-y-1">
                  <div className="font-medium">Execução</div>
                  {d.executorTipo === "terceirizada" ? (
                    <div><Building2 className="h-4 w-4 inline mr-1" />{d.empresaNome}{d.empresaContato ? ` — ${d.empresaContato}` : ""}{d.empresaTelefone ? ` — ${d.empresaTelefone}` : ""}</div>
                  ) : (
                    <div><Store className="h-4 w-4 inline mr-1" />Própria Honest{d.responsavelExecucao ? ` — ${d.responsavelExecucao}` : ""}</div>
                  )}
                  <div className="font-medium pt-1">Materiais</div>
                  <div className="text-muted-foreground">{[...(d.materiais || []), ...(d.materiaisOutros ? [d.materiaisOutros] : [])].join(", ") || "—"}</div>
                </div>
              </div>
              {d.observacoes && <div className="rounded border p-3 text-sm whitespace-pre-wrap"><span className="font-medium">Observações: </span>{d.observacoes}</div>}
              {d.status === "cancelada" && <div className="rounded border border-gray-300 bg-gray-50 p-3 text-sm">Cancelada em {dtBR(d.canceladaEm)} — {d.motivoCancelamento}</div>}

              {/* Amostras */}
              <div className="rounded border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium flex items-center gap-1"><Package className="h-4 w-4" />Amostras da degustação</div>
                  <span className={`text-xs px-2 py-0.5 rounded ${AMOSTRA_COR[d.amostra.codigo] || "bg-gray-100"}`}>{d.amostra.label}</span>
                </div>
                {(d.amostraProdutos || []).length > 0 && (
                  <div className="text-sm text-muted-foreground">
                    {(d.amostraProdutos || []).map((p: any) => `${p.quantity}× ${p.name}`).join(" · ")}{d.amostraValor ? ` — ${brl(d.amostraValor)}` : ""}
                  </div>
                )}
                {podeAmostra ? (
                  <Button size="sm" onClick={() => abrirAmostra(d)} disabled={abrindoAmostra} className="bg-violet-600 hover:bg-violet-700">
                    {abrindoAmostra ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Package className="h-4 w-4 mr-1" />}
                    {d.amostra.codigo === "rascunho" ? "Continuar amostras" : "Criar amostras"}
                  </Button>
                ) : d.status !== "cancelada" ? (
                  <div className="text-xs text-muted-foreground">O pedido de amostra segue o fluxo normal: Bloqueados → liberação → faturamento → rota.</div>
                ) : null}
              </div>

              {/* Chamado + fotos */}
              <div className="rounded border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium flex items-center gap-1"><Ticket className="h-4 w-4" />Chamado {d.chamadoCodigo || "—"} (Lanucy)</div>
                  {d.chamadoId && (
                    <a className="text-xs text-blue-700 underline" href={`/chamados?id=${d.chamadoId}`}>{CHAMADO_LABEL[d.chamadoStatus || ""] || d.chamadoStatus} · abrir chamado</a>
                  )}
                </div>
                {(det?.fotos || []).length > 0 && (
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1 mb-1"><Camera className="h-4 w-4" />Fotos e arquivos</div>
                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                      {det!.fotos.map((f: any) => String(f.mime || "").startsWith("image/") ? (
                        <button key={f.id} type="button" onClick={() => setFotoGrande(f.url)} className="aspect-square overflow-hidden rounded border">
                          <img src={f.url} alt={f.nome} className="h-full w-full object-cover" loading="lazy" />
                        </button>
                      ) : (
                        <a key={f.id} href={`${f.url}?download=1`} className="aspect-square rounded border flex items-center justify-center text-xs p-1 text-center break-all">{f.nome}</a>
                      ))}
                    </div>
                  </div>
                )}
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {(det?.mensagens || []).map((m: any) => (
                    <div key={m.id} className={`text-sm rounded p-2 ${m.tipo === "sistema" ? "bg-gray-50 text-gray-500 text-xs" : "bg-emerald-50"}`}>
                      <div className="text-[11px] text-muted-foreground">{m.autorNome} · {dtBR(m.createdAt)}</div>
                      <div className="whitespace-pre-wrap">{m.texto}</div>
                    </div>
                  ))}
                </div>
                {d.status === "aberta" && <div className="text-xs text-muted-foreground">Quando a Lanucy responder e finalizar o chamado com as fotos, a degustação é concluída automaticamente.</div>}
                {d.status === "concluida" && <div className="text-sm text-green-700 flex items-center gap-1"><CheckCircle2 className="h-4 w-4" />Concluída em {dtBR(d.concluidaEm)}</div>}
              </div>

              {cancelando && (
                <div className="rounded border border-red-200 bg-red-50 p-3 space-y-2">
                  <Label>Motivo do cancelamento</Label>
                  <Textarea rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setCancelando(false)}>Voltar</Button>
                    <Button size="sm" variant="destructive" onClick={cancelar}>Confirmar cancelamento</Button>
                  </div>
                </div>
              )}

              <DialogFooter className="gap-2">
                {d.status === "aberta" && !cancelando && <Button variant="outline" className="text-red-700" onClick={() => setCancelando(true)}><XCircle className="h-4 w-4 mr-1" />Cancelar degustação</Button>}
                {d.status !== "cancelada" && <Button variant="outline" onClick={() => editar(d)}><Pencil className="h-4 w-4 mr-1" />Editar</Button>}
                <Button onClick={() => setDetId(null)}>Fechar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!fotoGrande} onOpenChange={(o) => !o && setFotoGrande(null)}>
        <DialogContent className="max-w-4xl p-2">{fotoGrande && <img src={fotoGrande} alt="Foto da degustação" className="w-full h-auto max-h-[85vh] object-contain" />}</DialogContent>
      </Dialog>

      {/* Mesmo formulário do card de vendas, já como AMOSTRA */}
      <SaleModal isOpen={!!cardVenda} onClose={fecharVenda} salesCard={cardVenda} />
    </div>
  );
}
