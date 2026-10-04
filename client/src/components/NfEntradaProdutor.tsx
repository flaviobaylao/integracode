// NF-e DE ENTRADA PRÓPRIA — compra de insumos (frutas etc.) de fornecedor que
// não emite nota (produtor rural pessoa física). A Honest emite a NF-e de
// entrada (CFOP 1101/2101) e, autorizada, ela vira NF de compra na aba Compras,
// já classificada como compra de estoque, pronta para "Dar entrada — Matéria-Prima".
// Backend: server/nf-entrada-produtor.ts.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Search, UserPlus, Pencil, Send, FileText, RefreshCw, AlertCircle, CheckCircle2, ArrowRight } from "lucide-react";

const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
const PAGAMENTOS = [
  { v: "dinheiro", l: "À vista — dinheiro" },
  { v: "pix", l: "À vista — Pix" },
  { v: "transferencia", l: "Transferência / depósito" },
  { v: "a_prazo", l: "A prazo" },
];
const STATUS: Record<string, { l: string; c: string }> = {
  draft: { l: "Rascunho", c: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200" },
  rejected: { l: "Rejeitada", c: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  authorized: { l: "Autorizada", c: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  cancelled: { l: "Cancelada", c: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
};

const dig = (v: any) => String(v ?? "").replace(/\D/g, "");
const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const num = (v: any) => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
function fmtDoc(d: string) {
  const x = dig(d);
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return d || "";
}

async function api(method: string, url: string, body?: any) {
  const res = await fetch(url, {
    method, credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data };
}

type Linha = { rawMaterialId: string; description: string; ncm: string; unit: string; quantity: string; unitPrice: string };
const linhaVazia = (): Linha => ({ rawMaterialId: "", description: "", ncm: "", unit: "KG", quantity: "", unitPrice: "" });

const fornVazio = {
  id: "", name: "", companyName: "", document: "", stateRegistration: "", phone: "", email: "",
  zipCode: "", state: "GO", city: "", cityCode: "", address: "", addressNumber: "", addressComplement: "", neighborhood: "",
};

export default function NfEntradaProdutor({ onCompraCriada, onAbrirCompras }: { onCompraCriada?: () => void; onAbrirCompras?: () => void }) {
  const { toast } = useToast();

  const { data: ctx } = useQuery<any>({ queryKey: ["/api/nf-entrada-produtor/contexto"] });
  const { data: contas = [] } = useQuery<any[]>({ queryKey: ["/api/financial/chart-of-accounts"] });
  const { data: notas = [], refetch: refetchNotas } = useQuery<any[]>({ queryKey: ["/api/nf-entrada-produtor"] });

  const instancias: any[] = ctx?.instancias || [];
  const materias: any[] = ctx?.materias || [];

  const [instanceId, setInstanceId] = useState("");
  const [busca, setBusca] = useState("");
  const [fornecedor, setFornecedor] = useState<any>(null);
  const [linhas, setLinhas] = useState<Linha[]>([linhaVazia()]);
  const [pagamento, setPagamento] = useState("dinheiro");
  const [contaId, setContaId] = useState("");
  const [obs, setObs] = useState("");
  const [teste, setTeste] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<any>(null);
  const [acaoId, setAcaoId] = useState<string | null>(null);

  const [showForn, setShowForn] = useState(false);
  const [forn, setForn] = useState<any>(fornVazio);
  const [salvandoForn, setSalvandoForn] = useState(false);
  const [municipios, setMunicipios] = useState<any[]>([]);
  const [municipiosErro, setMunicipiosErro] = useState(false);

  useEffect(() => { if (!instanceId && instancias[0]) setInstanceId(instancias[0].id); }, [instancias, instanceId]);
  useEffect(() => { if (!contaId && ctx?.contaPadrao?.id) setContaId(ctx.contaPadrao.id); }, [ctx, contaId]);

  const { data: resultadosBusca = [], isFetching: buscando } = useQuery<any[]>({
    queryKey: ["/api/nf-entrada-produtor/fornecedores", busca],
    queryFn: async () => {
      const r = await api("GET", `/api/nf-entrada-produtor/fornecedores?search=${encodeURIComponent(busca)}`);
      return r.ok ? r.data : [];
    },
    enabled: busca.trim().length >= 2 && !fornecedor,
  });

  // Municípios da UF (API pública do IBGE) — dá o código IBGE certo para o cMun.
  useEffect(() => {
    if (!showForn || !forn.state) return;
    let vivo = true;
    setMunicipiosErro(false);
    fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${forn.state}/municipios`)
      .then((r) => r.json())
      .then((j) => { if (vivo) setMunicipios((Array.isArray(j) ? j : []).map((m: any) => ({ id: String(m.id), nome: m.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))); })
      .catch(() => { if (vivo) { setMunicipios([]); setMunicipiosErro(true); } });
    return () => { vivo = false; };
  }, [showForn, forn.state]);

  const inst = instancias.find((i) => i.id === instanceId);
  const ufForn = (fornecedor?.state || "").toUpperCase();
  const cfopPrevisto = inst && ufForn ? (inst.uf === ufForn ? "1101" : "2101") : "—";
  const total = useMemo(() => linhas.reduce((s, l) => s + Math.round(num(l.quantity) * num(l.unitPrice) * 100) / 100, 0), [linhas]);

  function abrirNovoFornecedor() {
    setForn({ ...fornVazio, name: busca && !dig(busca) ? busca : "", document: dig(busca).length >= 11 ? dig(busca) : "" });
    setShowForn(true);
  }
  function abrirEditarFornecedor(s: any) {
    setForn({
      id: s.id, name: s.name || "", companyName: s.company_name || "", document: s.cpf || s.cnpj || "",
      stateRegistration: s.state_registration || "", phone: s.phone || "", email: s.email || "",
      zipCode: s.zip_code || "", state: (s.state || "GO").toUpperCase(), city: s.city || "", cityCode: s.city_code || "",
      address: s.address || "", addressNumber: s.address_number || "", addressComplement: s.address_complement || "", neighborhood: s.neighborhood || "",
    });
    setShowForn(true);
  }
  async function salvarFornecedor() {
    setSalvandoForn(true);
    const r = await api("POST", "/api/nf-entrada-produtor/fornecedores", forn);
    setSalvandoForn(false);
    if (!r.ok) { toast({ title: "Não salvei o fornecedor", description: r.data?.error || "Erro", variant: "destructive" }); return; }
    setFornecedor(r.data);
    setShowForn(false);
    queryClient.invalidateQueries({ queryKey: ["/api/nf-entrada-produtor/fornecedores"] });
    toast({ title: "Fornecedor salvo", description: r.data?.pendencias?.length ? `Falta: ${r.data.pendencias.join(", ")}` : "Cadastro fiscal completo." });
  }

  function setLinha(i: number, patch: Partial<Linha>) {
    setLinhas((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  function escolherMateria(i: number, id: string) {
    const m = materias.find((x) => x.id === id);
    const u = String(m?.unit || "").toLowerCase();
    setLinha(i, {
      rawMaterialId: id,
      description: m?.name || "",
      ncm: m?.ncm || "",
      unit: u === "kg" ? "KG" : u === "g" ? "G" : u.startsWith("un") ? "UN" : (u || "KG").toUpperCase().slice(0, 6),
      unitPrice: linhas[i]?.unitPrice || (m?.unit_cost ? String(Number(m.unit_cost)) : ""),
    });
  }

  function limpar() {
    setFornecedor(null); setBusca(""); setLinhas([linhaVazia()]); setObs(""); setTeste(false);
  }

  const podeEmitir = !!inst && !!fornecedor && !(fornecedor?.pendencias?.length) &&
    linhas.length > 0 && linhas.every((l) => l.rawMaterialId && num(l.quantity) > 0 && num(l.unitPrice) > 0 && dig(l.ncm).length === 8);

  async function emitir() {
    setEnviando(true); setResultado(null);
    const r = await api("POST", "/api/nf-entrada-produtor", {
      instanceId, supplierId: fornecedor.id, paymentMethod: pagamento, chartAccountId: contaId || null,
      notes: obs, homologacao: teste,
      items: linhas.map((l) => ({ rawMaterialId: l.rawMaterialId, description: l.description, ncm: dig(l.ncm), unit: l.unit, quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
    });
    setEnviando(false);
    refetchNotas();
    if (r.ok && r.data?.emitida) {
      setResultado({ ok: true, ...r.data });
      toast({ title: `NF-e ${r.data.invoice?.invoiceNumber} autorizada`, description: r.data.homologacao ? "Modo teste (homologação) — não gera compra." : "A compra já está na lista de Notas Fiscais da aba Compras." });
      if (r.data.compra?.purchaseId) onCompraCriada?.();
      limpar();
    } else {
      const msg = r.data?.sefaz?.errorMessage || r.data?.error || "Falha na emissão";
      setResultado({ ok: false, msg, invoice: r.data?.invoice });
      toast({ title: "NF-e não autorizada", description: msg, variant: "destructive" });
    }
  }

  async function retransmitir(n: any) {
    setAcaoId(n.fiscal_invoice_id);
    const r = await api("POST", `/api/nf-entrada-produtor/${n.fiscal_invoice_id}/emitir`);
    setAcaoId(null); refetchNotas();
    if (r.ok && r.data?.emitida) { toast({ title: `NF-e ${n.invoice_number} autorizada` }); if (r.data.compra?.purchaseId) onCompraCriada?.(); }
    else toast({ title: "Não autorizada", description: r.data?.sefaz?.errorMessage || r.data?.error || "Erro", variant: "destructive" });
  }
  async function descartar(n: any) {
    if (!window.confirm(`Descartar o rascunho da NF ${n.invoice_number}? (nunca foi autorizada)`)) return;
    setAcaoId(n.fiscal_invoice_id);
    const r = await api("DELETE", `/api/nf-entrada-produtor/${n.fiscal_invoice_id}`);
    setAcaoId(null); refetchNotas();
    if (!r.ok) toast({ title: "Não descartei", description: r.data?.error || "Erro", variant: "destructive" });
  }
  async function recriarCompra(n: any) {
    setAcaoId(n.fiscal_invoice_id);
    const r = await api("POST", `/api/nf-entrada-produtor/${n.fiscal_invoice_id}/sincronizar`);
    setAcaoId(null); refetchNotas();
    if (r.ok) { toast({ title: "Compra criada na aba Compras" }); onCompraCriada?.(); }
    else toast({ title: "Não criei a compra", description: r.data?.motivo || "Erro", variant: "destructive" });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Emitir NF-e de entrada — compra de fornecedor sem nota</CardTitle>
          <CardDescription>
            Para frutas e outros insumos comprados de produtor rural / pessoa física que não emite nota. A própria empresa emite a NF-e de entrada
            (CFOP 1101 na mesma UF, 2101 de outra UF); autorizada, ela entra como NF de compra classificada como estoque — é só criar a conta a pagar e dar entrada na matéria-prima.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <Label>Empresa emitente (quem recebe a mercadoria)</Label>
              <Select value={instanceId} onValueChange={setInstanceId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {instancias.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name} — {fmtDoc(i.cnpj)} ({i.city}/{i.uf})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {inst && inst.ambiente !== "producao" && <p className="text-xs text-amber-600 mt-1">Esta empresa está em homologação nas configurações fiscais.</p>}
            </div>
            <div>
              <Label>Pagamento ao fornecedor</Label>
              <Select value={pagamento} onValueChange={setPagamento}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{PAGAMENTOS.map((p) => <SelectItem key={p.v} value={p.v}>{p.l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Categoria da compra (plano de contas)</Label>
              <Select value={contaId} onValueChange={setContaId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {(contas as any[]).map((c: any) => <SelectItem key={c.id} value={c.id}>{c.code ? `${c.code} - ` : ""}{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* FORNECEDOR / REMETENTE */}
          <div className="space-y-2">
            <Label>Fornecedor (remetente da mercadoria)</Label>
            {fornecedor ? (
              <div className="border rounded-lg p-3 flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{fornecedor.company_name || fornecedor.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDoc(fornecedor.cpf || fornecedor.cnpj)}{fornecedor.state_registration ? ` · IE ${fornecedor.state_registration}` : " · sem IE"}
                    {" · "}{[fornecedor.address, fornecedor.address_number].filter(Boolean).join(", ") || "sem endereço"}
                    {" · "}{fornecedor.city || "?"}/{fornecedor.state || "?"}{fornecedor.city_code ? ` (IBGE ${fornecedor.city_code})` : ""}
                  </div>
                  {fornecedor.pendencias?.length > 0 && (
                    <div className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Falta no cadastro: {fornecedor.pendencias.join(", ")}</div>
                  )}
                  {!fornecedor.city_code && !(fornecedor.pendencias?.length) && (
                    <div className="text-xs text-amber-600 mt-1">Sem código IBGE do município — edite e escolha a cidade na lista para a nota sair com o município certo.</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => abrirEditarFornecedor(fornecedor)}><Pencil className="h-4 w-4 mr-1" /> Editar cadastro</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setFornecedor(null); }}>Trocar</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Buscar por nome ou CPF/CNPJ..." value={busca} onChange={(e) => setBusca(e.target.value)} />
                  </div>
                  <Button variant="outline" onClick={abrirNovoFornecedor}><UserPlus className="h-4 w-4 mr-1" /> Novo fornecedor</Button>
                </div>
                {busca.trim().length >= 2 && (
                  <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
                    {buscando && <div className="p-2 text-sm text-muted-foreground">Buscando...</div>}
                    {!buscando && resultadosBusca.length === 0 && <div className="p-2 text-sm text-muted-foreground">Nenhum fornecedor. Use "Novo fornecedor".</div>}
                    {resultadosBusca.map((s: any) => (
                      <button key={s.id} type="button" className="w-full text-left p-2 hover:bg-muted text-sm" onClick={() => setFornecedor(s)}>
                        <div className="font-medium">{s.company_name || s.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDoc(s.cpf || s.cnpj) || "sem documento"} · {s.city || "?"}/{s.state || "?"}
                          {s.pendencias?.length ? <span className="text-red-600"> · falta: {s.pendencias.join(", ")}</span> : null}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ITENS */}
          <div className="space-y-2">
            <Label>Itens (matéria-prima)</Label>
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left p-2 min-w-[200px]">Matéria-prima</th>
                    <th className="text-left p-2 min-w-[160px]">Descrição na nota</th>
                    <th className="text-left p-2 w-28">NCM</th>
                    <th className="text-left p-2 w-20">Un.</th>
                    <th className="text-right p-2 w-28">Quantidade</th>
                    <th className="text-right p-2 w-28">Preço unit.</th>
                    <th className="text-right p-2 w-28">Total</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l, i) => (
                    <tr key={i} className="border-t align-top">
                      <td className="p-2">
                        <Select value={l.rawMaterialId} onValueChange={(v) => escolherMateria(i, v)}>
                          <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                          <SelectContent>
                            {materias.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}{m.unit ? ` (${m.unit})` : ""}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2"><Input value={l.description} onChange={(e) => setLinha(i, { description: e.target.value })} /></td>
                      <td className="p-2">
                        <Input value={l.ncm} placeholder="8 dígitos" onChange={(e) => setLinha(i, { ncm: dig(e.target.value).slice(0, 8) })}
                          className={l.rawMaterialId && dig(l.ncm).length !== 8 ? "border-red-400" : ""} />
                      </td>
                      <td className="p-2"><Input value={l.unit} onChange={(e) => setLinha(i, { unit: e.target.value.toUpperCase().slice(0, 6) })} /></td>
                      <td className="p-2"><Input className="text-right" inputMode="decimal" value={l.quantity} onChange={(e) => setLinha(i, { quantity: e.target.value })} /></td>
                      <td className="p-2"><Input className="text-right" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLinha(i, { unitPrice: e.target.value })} /></td>
                      <td className="p-2 text-right whitespace-nowrap font-medium pt-4">{brl(Math.round(num(l.quantity) * num(l.unitPrice) * 100) / 100)}</td>
                      <td className="p-2">
                        <Button size="icon" variant="ghost" disabled={linhas.length === 1} onClick={() => setLinhas((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button size="sm" variant="outline" onClick={() => setLinhas((p) => [...p, linhaVazia()])}><Plus className="h-4 w-4 mr-1" /> Adicionar item</Button>
              <div className="text-sm">CFOP <b>{cfopPrevisto}</b> · Total da nota <b className="text-base">{brl(total)}</b></div>
            </div>
          </div>

          <div>
            <Label>Observações (vão nas informações complementares, depois do texto padrão)</Label>
            <Textarea className="mt-1" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: Pesagem na entrada da fábrica, romaneio 123." />
            {ctx?.observacao && <p className="text-xs text-muted-foreground mt-1">Texto padrão: {ctx.observacao}</p>}
          </div>

          <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
            <div className="flex items-center gap-2">
              <Checkbox id="nfe-teste" checked={teste} onCheckedChange={(v) => setTeste(!!v)} />
              <Label htmlFor="nfe-teste" className="cursor-pointer text-sm">Modo teste (homologação — sem valor fiscal, não gera compra)</Label>
            </div>
            <Button disabled={!podeEmitir || enviando} onClick={emitir} className="bg-green-700 hover:bg-green-800">
              <Send className="h-4 w-4 mr-1" /> {enviando ? "Transmitindo à SEFAZ..." : "Emitir NF-e de entrada"}
            </Button>
          </div>

          {resultado && (
            <div className={`rounded-lg border p-3 text-sm ${resultado.ok ? "border-green-300 bg-green-50 dark:bg-green-950" : "border-red-300 bg-red-50 dark:bg-red-950"}`}>
              {resultado.ok ? (
                <div className="flex flex-col md:flex-row md:items-center gap-2 justify-between">
                  <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-green-700" />
                    NF-e {resultado.invoice?.invoiceNumber} autorizada{resultado.homologacao ? " (homologação)" : ""} — chave {resultado.invoice?.accessKey}
                  </div>
                  <div className="flex gap-2">
                    {resultado.compra?.purchaseId && (
                      <Button size="sm" variant="outline" onClick={() => window.open(`/api/purchases/${resultado.compra.purchaseId}/danfe`, "_blank")}><FileText className="h-4 w-4 mr-1" /> DANFE</Button>
                    )}
                    {resultado.compra?.purchaseId && onAbrirCompras && (
                      <Button size="sm" onClick={onAbrirCompras}>Ir para a compra <ArrowRight className="h-4 w-4 ml-1" /></Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2"><AlertCircle className="h-4 w-4 text-red-700 mt-0.5" />
                  <div>{resultado.msg}{resultado.invoice?.invoiceNumber ? <div className="text-xs mt-1">A NF {resultado.invoice.invoiceNumber} ficou como rascunho/rejeitada na lista abaixo: corrija o cadastro e retransmita, ou descarte.</div> : null}</div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* NOTAS JÁ EMITIDAS */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">NF-e de entrada emitidas</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => refetchNotas()}><RefreshCw className="h-4 w-4" /></Button>
        </CardHeader>
        <CardContent>
          {notas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma ainda.</p>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left p-2">NF</th>
                    <th className="text-left p-2">Data</th>
                    <th className="text-left p-2">Fornecedor</th>
                    <th className="text-right p-2">Total</th>
                    <th className="text-left p-2">Situação</th>
                    <th className="text-left p-2">Compra</th>
                    <th className="text-right p-2">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n: any) => {
                    const st = STATUS[n.status] || STATUS.draft;
                    const ocupado = acaoId === n.fiscal_invoice_id;
                    return (
                      <tr key={n.fiscal_invoice_id} className="border-t align-top">
                        <td className="p-2 whitespace-nowrap">{n.invoice_number}<div className="text-xs text-muted-foreground">CFOP {n.cfop}</div></td>
                        <td className="p-2 whitespace-nowrap">{new Date(n.authorization_date || n.emission_date || n.created_at).toLocaleDateString("pt-BR")}</td>
                        <td className="p-2">{n.customer_name}<div className="text-xs text-muted-foreground">{fmtDoc(n.customer_cnpj_cpf)}</div></td>
                        <td className="p-2 text-right whitespace-nowrap">{brl(n.total_invoice)}</td>
                        <td className="p-2">
                          <Badge className={st.c}>{st.l}</Badge>
                          {n.environment === "homologacao" && <Badge variant="outline" className="ml-1">teste</Badge>}
                          {n.status !== "authorized" && n.last_error && <div className="text-xs text-red-600 mt-1 max-w-[260px]">{n.last_error}</div>}
                        </td>
                        <td className="p-2 text-xs">
                          {n.purchase_invoice_id
                            ? <>{n.purchase_status}{n.stock_processed ? " · estoque lançado" : " · falta entrada"}{n.payable_id ? " · conta a pagar" : ""}</>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="p-2 text-right whitespace-nowrap space-x-1">
                          {n.purchase_invoice_id && (
                            <Button size="sm" variant="outline" onClick={() => window.open(`/api/purchases/${n.purchase_invoice_id}/danfe`, "_blank")}><FileText className="h-4 w-4" /></Button>
                          )}
                          {(n.status === "draft" || n.status === "rejected") && (
                            <>
                              <Button size="sm" variant="outline" disabled={ocupado} onClick={() => retransmitir(n)}><Send className="h-4 w-4 mr-1" /> Retransmitir</Button>
                              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => descartar(n)}><Trash2 className="h-4 w-4" /></Button>
                            </>
                          )}
                          {n.status === "authorized" && !n.purchase_invoice_id && n.environment !== "homologacao" && (
                            <Button size="sm" variant="outline" disabled={ocupado} onClick={() => recriarCompra(n)}>Criar compra</Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">Para cancelar uma nota autorizada use Notas Fiscais (prazo de 24 h da SEFAZ). Ao cancelar, a compra correspondente é cancelada junto — se ainda não teve entrada de estoque nem conta a pagar.</p>
        </CardContent>
      </Card>

      {/* CADASTRO DO FORNECEDOR */}
      <Dialog open={showForn} onOpenChange={setShowForn}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{forn.id ? "Editar fornecedor" : "Novo fornecedor (sem nota)"}</DialogTitle>
            <DialogDescription>Dados do remetente que vão na NF-e. Produtor rural: informe a Inscrição Estadual de produtor se tiver (deixe em branco se não tiver).</DialogDescription>
          </DialogHeader>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2"><Label>Nome *</Label><Input value={forn.name} onChange={(e) => setForn({ ...forn, name: e.target.value })} /></div>
            <div><Label>CPF / CNPJ *</Label><Input value={forn.document} onChange={(e) => setForn({ ...forn, document: dig(e.target.value).slice(0, 14) })} /></div>
            <div><Label>Inscrição Estadual (produtor)</Label><Input value={forn.stateRegistration} onChange={(e) => setForn({ ...forn, stateRegistration: e.target.value })} /></div>
            <div><Label>Telefone</Label><Input value={forn.phone} onChange={(e) => setForn({ ...forn, phone: e.target.value })} /></div>
            <div><Label>CEP</Label><Input value={forn.zipCode} onChange={(e) => setForn({ ...forn, zipCode: dig(e.target.value).slice(0, 8) })} /></div>
            <div>
              <Label>UF *</Label>
              <Select value={forn.state} onValueChange={(v) => setForn({ ...forn, state: v, city: "", cityCode: "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UFS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Município *</Label>
              {municipios.length > 0 ? (
                <Select value={forn.cityCode} onValueChange={(v) => setForn({ ...forn, cityCode: v, city: municipios.find((m) => m.id === v)?.nome || "" })}>
                  <SelectTrigger><SelectValue placeholder={forn.city || "Selecione..."} /></SelectTrigger>
                  <SelectContent>{municipios.map((m) => <SelectItem key={m.id} value={m.id}>{m.nome}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <div className="flex gap-2">
                  <Input placeholder="Cidade" value={forn.city} onChange={(e) => setForn({ ...forn, city: e.target.value })} />
                  <Input placeholder="IBGE (7)" className="w-28" value={forn.cityCode} onChange={(e) => setForn({ ...forn, cityCode: dig(e.target.value).slice(0, 7) })} />
                </div>
              )}
              {municipiosErro && <p className="text-xs text-amber-600 mt-1">Lista do IBGE indisponível — digite a cidade e o código IBGE.</p>}
            </div>
            <div className="md:col-span-2"><Label>Logradouro * (rodovia, fazenda, sítio, rua...)</Label><Input value={forn.address} onChange={(e) => setForn({ ...forn, address: e.target.value })} /></div>
            <div><Label>Número</Label><Input value={forn.addressNumber} placeholder="S/N" onChange={(e) => setForn({ ...forn, addressNumber: e.target.value })} /></div>
            <div><Label>Complemento</Label><Input value={forn.addressComplement} onChange={(e) => setForn({ ...forn, addressComplement: e.target.value })} /></div>
            <div className="md:col-span-2"><Label>Bairro / localidade</Label><Input value={forn.neighborhood} placeholder="Zona Rural" onChange={(e) => setForn({ ...forn, neighborhood: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForn(false)}>Cancelar</Button>
            <Button disabled={salvandoForn || !forn.name || dig(forn.document).length < 11 || !forn.address || !forn.city} onClick={salvarFornecedor}>
              {salvandoForn ? "Salvando..." : "Salvar fornecedor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
