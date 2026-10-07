// client/src/components/ComodatoEquipamentos.tsx
// -----------------------------------------------------------------------------
// INVENTÁRIO DE EQUIPAMENTOS PARA COMODATO (aba da tela /comodatos) — 07/out/2026
//
// Lista os freezers/geladeiras da PURO com o status calculado no servidor:
//   - COMODATADO: há contrato não encerrado apontando para o equipamento
//     (mostra o cliente e o contrato);
//   - DISPONÍVEL: mostra onde está (CD GYN, CD BSB, Fábrica, Em manutenção).
// "Vincular a cliente" abre o formulário de novo contrato já preenchido com os
// dados do equipamento; o contrato nasce como "Aguardando contrato".
// Fonte: /api/comodatos/equipamentos (server/comodatos-routes.ts).
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { exportToExcel } from "@/lib/excelExport";
import { useToast } from "@/hooks/use-toast";
import { Plus, Loader2, Search, FileDown, Trash2, Link2, Pencil, Warehouse } from "lucide-react";

export const LOCAIS: Record<string, string> = {
  cd_gyn: "CD GYN",
  cd_bsb: "CD BSB",
  fabrica: "Fábrica",
  manutencao: "Em manutenção",
};
const TIPOS: Record<string, string> = { freezer: "Freezer", geladeira: "Geladeira", visa_cooler: "Visa cooler", outro: "Outro" };

const brl = (v: any) =>
  v == null || isNaN(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const colar = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

const VAZIO: any = {
  tipo: "freezer", marca: "", modelo: "", numeroSerie: "", codigoProduto: "", tensao: "220V",
  volumeLitros: "", volumeBrutoLitros: "", valorReferencia: "", usado: false, local: "cd_gyn",
  nfAquisicaoNumero: "", nfAquisicaoData: "", nfAquisicaoFornecedor: "", nfAquisicaoValor: "", observacoes: "",
};

function paraForm(e: any) {
  return {
    tipo: e.tipo || "freezer", marca: e.marca || "", modelo: e.modelo || "", numeroSerie: e.numero_serie || "",
    codigoProduto: e.codigo_produto || "", tensao: e.tensao || "", volumeLitros: e.volume_litros ?? "",
    volumeBrutoLitros: e.volume_bruto_litros ?? "", valorReferencia: e.valor_referencia ?? "", usado: !!e.usado,
    local: e.local || "", nfAquisicaoNumero: e.nf_aquisicao_numero || "", nfAquisicaoData: e.nf_aquisicao_data || "",
    nfAquisicaoFornecedor: e.nf_aquisicao_fornecedor || "", nfAquisicaoValor: e.nf_aquisicao_valor ?? "",
    observacoes: e.observacoes || "",
  };
}

async function api(url: string, opts: RequestInit = {}) {
  const r = await fetch(url, { credentials: "include", ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
  return j;
}

export default function ComodatoEquipamentos({ onVincular, onVerContrato }: {
  onVincular: (eq: any) => void;
  onVerContrato: (contratoId: string) => void;
}) {
  const { toast } = useToast();
  const [busca, setBusca] = useState("");
  const [fStatus, setFStatus] = useState("todos");
  const [fLocal, setFLocal] = useState("todos");
  const [aberto, setAberto] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<any>({ ...VAZIO });
  const [salvando, setSalvando] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/comodatos/equipamentos"],
    queryFn: () => api("/api/comodatos/equipamentos"),
  });
  const itens: any[] = data?.itens || [];
  const resumo = data?.resumo;

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return itens.filter((e) => {
      if (fStatus !== "todos" && e.status !== fStatus) return false;
      if (fLocal !== "todos" && (e.status !== "disponivel" || (e.local || "sem_local") !== fLocal)) return false;
      if (!q) return true;
      return [e.codigo, TIPOS[e.tipo], e.marca, e.modelo, e.numero_serie, e.codigo_produto, e.cliente, e.contrato_codigo, e.observacoes]
        .join(" ").toLowerCase().includes(q);
    }).sort((a, b) =>
      // disponíveis primeiro, depois por código
      (a.status === b.status ? 0 : a.status === "disponivel" ? -1 : 1) || colar.compare(a.codigo, b.codigo));
  }, [itens, busca, fStatus, fLocal]);

  const recarregar = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["/api/comodatos/equipamentos"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/comodatos"] }),
  ]);

  const abrirNovo = () => { setEditId(null); setForm({ ...VAZIO }); setAberto(true); };
  const abrirEdicao = (e: any) => { setEditId(e.id); setForm(paraForm(e)); setAberto(true); };

  const salvar = async () => {
    if (!form.marca.trim() && !form.modelo.trim() && !form.numeroSerie.trim()) {
      toast({ title: "Informe ao menos marca, modelo ou nº de série", variant: "destructive" }); return;
    }
    setSalvando(true);
    try {
      const body: any = { ...form };
      body.valorReferencia = form.valorReferencia === "" ? null : Number(String(form.valorReferencia).replace(",", "."));
      body.nfAquisicaoValor = form.nfAquisicaoValor === "" ? null : Number(String(form.nfAquisicaoValor).replace(",", "."));
      await api(editId ? `/api/comodatos/equipamentos/${editId}` : "/api/comodatos/equipamentos", {
        method: editId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      await recarregar();
      toast({ title: editId ? "Equipamento atualizado" : "Equipamento cadastrado" });
      setAberto(false);
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: e?.message, variant: "destructive" });
    } finally {
      setSalvando(false);
    }
  };

  const excluir = async () => {
    if (!editId || !window.confirm("Excluir este equipamento do inventário?")) return;
    try { await api(`/api/comodatos/equipamentos/${editId}`, { method: "DELETE" }); await recarregar(); setAberto(false); }
    catch (e: any) { toast({ title: "Não foi possível excluir", description: e?.message, variant: "destructive" }); }
  };

  const exportar = () => {
    exportToExcel(filtrados.map((e) => ({
      "Código": e.codigo,
      "Tipo": TIPOS[e.tipo] || e.tipo,
      "Marca": e.marca || "", "Modelo": e.modelo || "", "Nº de série": e.numero_serie || "",
      "Código produto": e.codigo_produto || "", "Tensão": e.tensao || "",
      "Volume (L)": e.volume_litros ?? "", "Volume bruto (L)": e.volume_bruto_litros ?? "",
      "Valor de referência": e.valor_referencia ?? "", "Usado": e.usado ? "Sim" : "Não",
      "Status": e.status === "comodatado" ? "Comodatado" : "Disponível",
      "Cliente (comodatado)": e.cliente || "",
      "Contrato": e.contrato_codigo || "",
      "Local (disponível)": e.status === "disponivel" ? (LOCAIS[e.local] || "Não informado") : "",
      "NF de aquisição": e.nf_aquisicao_numero || "",
      "Observações": e.observacoes || "",
    })), `Equipamentos_Comodato_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="space-y-4">
      {resumo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Equipamentos no inventário</div>
            <div className="text-2xl font-bold">{resumo.total}</div>
          </CardContent></Card>
          <Card className="cursor-pointer" onClick={() => { setFStatus("comodatado"); setFLocal("todos"); }}><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Comodatados</div>
            <div className="text-2xl font-bold text-sky-700">{resumo.comodatados}</div>
            <div className="text-xs text-muted-foreground">em pontos de venda</div>
          </CardContent></Card>
          <Card className="cursor-pointer" onClick={() => { setFStatus("disponivel"); setFLocal("todos"); }}><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Disponíveis</div>
            <div className="text-2xl font-bold text-emerald-600">{resumo.disponiveis}</div>
            <div className="text-xs text-muted-foreground">prontos para vincular</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Disponíveis por local</div>
            <div className="text-xs space-y-0.5">
              {Object.entries(LOCAIS).map(([k, l]) => (
                <div key={k} className="flex justify-between cursor-pointer hover:underline" onClick={() => { setFStatus("disponivel"); setFLocal(k); }}>
                  <span>{l}</span><b>{resumo.porLocal?.[k] ?? 0}</b>
                </div>
              ))}
              {(resumo.porLocal?.sem_local ?? 0) > 0 && (
                <div className="flex justify-between text-amber-700 cursor-pointer hover:underline" onClick={() => { setFStatus("disponivel"); setFLocal("sem_local"); }}>
                  <span>Local não informado</span><b>{resumo.porLocal.sem_local}</b>
                </div>
              )}
            </div>
          </CardContent></Card>
        </div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar por código, marca, modelo, série, cliente…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <select className="border rounded-md h-9 px-2 text-sm bg-background" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="todos">Todos os status</option>
          <option value="disponivel">Disponível</option>
          <option value="comodatado">Comodatado</option>
        </select>
        <select className="border rounded-md h-9 px-2 text-sm bg-background" value={fLocal} onChange={(e) => setFLocal(e.target.value)}>
          <option value="todos">Todos os locais</option>
          {Object.entries(LOCAIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          <option value="sem_local">Local não informado</option>
        </select>
        <Button variant="outline" onClick={exportar} disabled={!filtrados.length}><FileDown className="w-4 h-4 mr-2" />Excel</Button>
        <Button onClick={abrirNovo}><Plus className="w-4 h-4 mr-2" />Novo equipamento</Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Carregando…</div>
      ) : error ? (
        <div className="text-red-600">Erro: {(error as any)?.message}</div>
      ) : (
        <div className="border rounded-md overflow-auto max-h-[70vh]">
          <Table>
            <TableHeader className="sticky top-0 z-10 shadow-sm">
              <TableRow className="[&>th]:bg-slate-100 [&>th]:whitespace-nowrap">
                <TableHead>Código</TableHead>
                <TableHead>Equipamento</TableHead>
                <TableHead>Modelo</TableHead>
                <TableHead>Nº de série</TableHead>
                <TableHead>Cód. produto</TableHead>
                <TableHead>Tensão</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Valor ref.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cliente / Local</TableHead>
                <TableHead>Observações</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtrados.map((e) => (
                <TableRow key={e.id} className="hover:bg-muted/50">
                  <TableCell className="font-mono text-xs whitespace-nowrap">{e.codigo}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-medium">{TIPOS[e.tipo] || e.tipo} {e.marca || ""}</div>
                    {e.usado && <div className="text-[10px] text-muted-foreground">usado</div>}
                  </TableCell>
                  <TableCell className="text-sm">{e.modelo || "—"}</TableCell>
                  <TableCell className="text-xs font-mono">{e.numero_serie || <span className="text-amber-700 font-sans">sem série</span>}</TableCell>
                  <TableCell className="text-xs font-mono">{e.codigo_produto || "—"}</TableCell>
                  <TableCell className="text-sm">{e.tensao || "—"}</TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap">{e.volume_litros != null ? `${e.volume_litros} L` : "—"}</TableCell>
                  <TableCell className="text-right text-sm whitespace-nowrap">{brl(e.valor_referencia)}</TableCell>
                  <TableCell>
                    {e.status === "comodatado"
                      ? <Badge variant="outline" className="bg-sky-100 text-sky-800 border-sky-200">Comodatado</Badge>
                      : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Disponível</Badge>}
                  </TableCell>
                  <TableCell className="text-sm min-w-[180px]">
                    {e.status === "comodatado" ? (
                      <button type="button" className="text-left hover:underline" onClick={() => onVerContrato(e.contrato_id)} title="Abrir o contrato">
                        <div className="font-medium flex items-center gap-1"><Link2 className="w-3 h-3 text-sky-600" />{e.cliente}</div>
                        <div className="text-xs text-muted-foreground">{e.contrato_codigo}{e.contrato_status === "aguardando_contrato" ? " · aguardando contrato" : ""}</div>
                      </button>
                    ) : (
                      <span className={`flex items-center gap-1 ${e.local ? "" : "text-amber-700"}`}>
                        <Warehouse className="w-3.5 h-3.5" />{LOCAIS[e.local] || "Local não informado"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs max-w-[220px] whitespace-pre-wrap">{e.observacoes || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {e.status === "disponivel" && (
                        <Button size="sm" className="whitespace-nowrap" onClick={() => onVincular(e)}>
                          <Link2 className="w-3.5 h-3.5 mr-1" />Vincular a cliente
                        </Button>
                      )}
                      <Button variant="outline" size="sm" title="Editar equipamento" onClick={() => abrirEdicao(e)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!filtrados.length && (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-8">Nenhum equipamento encontrado.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Editar equipamento" : "Novo equipamento para comodato"}</DialogTitle>
            <DialogDescription>
              {editId && itens.find((i) => i.id === editId)?.status === "comodatado"
                ? "Equipamento comodatado: as alterações também atualizam o contrato em vigor."
                : "O status (Comodatado/Disponível) é definido pelo vínculo com contrato."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid md:grid-cols-3 gap-3">
              <div><Label>Tipo</Label>
                <select className="border rounded-md h-9 px-2 text-sm w-full bg-background" value={form.tipo} onChange={(e) => set("tipo", e.target.value)}>
                  {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div><Label>Marca</Label><Input value={form.marca} onChange={(e) => set("marca", e.target.value)} /></div>
              <div><Label>Modelo</Label><Input value={form.modelo} onChange={(e) => set("modelo", e.target.value)} /></div>
              <div><Label>Nº de série</Label><Input value={form.numeroSerie} onChange={(e) => set("numeroSerie", e.target.value)} /></div>
              <div><Label>Código do produto</Label><Input value={form.codigoProduto} onChange={(e) => set("codigoProduto", e.target.value)} /></div>
              <div><Label>Tensão</Label><Input value={form.tensao} onChange={(e) => set("tensao", e.target.value)} /></div>
              <div><Label>Volume (L)</Label><Input type="number" value={form.volumeLitros} onChange={(e) => set("volumeLitros", e.target.value)} /></div>
              <div><Label>Volume bruto (L)</Label><Input type="number" value={form.volumeBrutoLitros} onChange={(e) => set("volumeBrutoLitros", e.target.value)} /></div>
              <div><Label>Valor de referência (R$)</Label><Input type="number" step="0.01" value={form.valorReferencia} onChange={(e) => set("valorReferencia", e.target.value)} /></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.usado} onCheckedChange={(v) => set("usado", !!v)} />Equipamento usado</label>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label>Local quando disponível</Label>
                <select className="border rounded-md h-9 px-2 text-sm w-full bg-background" value={form.local} onChange={(e) => set("local", e.target.value)}>
                  <option value="">Não informado</option>
                  {Object.entries(LOCAIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="grid md:grid-cols-4 gap-3">
              <div><Label>NF de aquisição</Label><Input value={form.nfAquisicaoNumero} onChange={(e) => set("nfAquisicaoNumero", e.target.value)} /></div>
              <div><Label>Data da NF</Label><Input type="date" value={form.nfAquisicaoData} onChange={(e) => set("nfAquisicaoData", e.target.value)} /></div>
              <div><Label>Valor da NF (R$)</Label><Input type="number" step="0.01" value={form.nfAquisicaoValor} onChange={(e) => set("nfAquisicaoValor", e.target.value)} /></div>
              <div className="md:col-span-4"><Label>Fornecedor da NF</Label><Input value={form.nfAquisicaoFornecedor} onChange={(e) => set("nfAquisicaoFornecedor", e.target.value)} /></div>
            </div>
            <div><Label>Observações</Label><Textarea rows={3} value={form.observacoes} onChange={(e) => set("observacoes", e.target.value)} placeholder="Estado de conservação, avarias, histórico…" /></div>
          </div>
          <DialogFooter className="gap-2">
            {editId && <Button variant="ghost" className="text-red-600 mr-auto" onClick={excluir}><Trash2 className="w-4 h-4 mr-2" />Excluir</Button>}
            <Button variant="outline" onClick={() => setAberto(false)}>Cancelar</Button>
            <Button onClick={salvar} disabled={salvando}>{salvando && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
