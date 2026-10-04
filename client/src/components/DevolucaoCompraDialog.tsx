// Devolução de compra ao fornecedor (04/out/2026) — abre a partir do detalhe da
// NF de compra (Radar de Compras). Lista os itens da NF de entrada com o saldo
// ainda devolvível, deixa escolher quantidade / matéria-prima / fator, e emite a
// NF-e de devolução pela instância que comprou (POST /api/purchases/:id/devolucao).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, CheckCircle2, Undo2 } from "lucide-react";

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Linha = { nItem: number; marcado: boolean; quantidade: string; rawMaterialId: string; fator: string };

export default function DevolucaoCompraDialog({ purchaseId, open, onOpenChange }: { purchaseId: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const [finalidade, setFinalidade] = useState("industrializacao");
  const [motivo, setMotivo] = useState("");
  const [baixarEstoque, setBaixarEstoque] = useState(true);
  const [abaterFinanceiro, setAbaterFinanceiro] = useState(true);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [resultado, setResultado] = useState<any>(null);

  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ["/api/purchases", purchaseId, "devolucao"],
    queryFn: async () => {
      const res = await fetch(`/api/purchases/${purchaseId}/devolucao`, { credentials: "include" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Erro ao carregar a NF de compra");
      return j;
    },
    enabled: open && !!purchaseId,
  });

  useEffect(() => {
    if (!data) return;
    setFinalidade(data.finalidadeSugerida || "industrializacao");
    setLinhas((data.itens || []).map((it: any) => ({
      nItem: it.nItem, marcado: false, quantidade: String(it.saldo || 0),
      rawMaterialId: it.rawMaterialSugerido || "", fator: "1",
    })));
    setResultado(null);
  }, [data]);

  const itens: any[] = data?.itens || [];
  const set = (nItem: number, patch: Partial<Linha>) => setLinhas((ls) => ls.map((l) => (l.nItem === nItem ? { ...l, ...patch } : l)));
  const escolhidas = linhas.filter((l) => l.marcado && Number(l.quantidade) > 0);

  const totais = useMemo(() => {
    let prod = 0, ipi = 0, outros = 0;
    for (const l of escolhidas) {
      const it = itens.find((x) => x.nItem === l.nItem); if (!it) continue;
      const q = Number(l.quantidade) || 0; const p = it.qCom > 0 ? q / it.qCom : 0;
      prod += Math.abs(q - it.qCom) < 1e-6 ? it.vProd : r2(it.vUnCom * q);
      ipi += r2(it.vIPI * p);
      outros += r2((it.vFrete + it.vSeg + it.vOutro - it.vDesc) * p);
    }
    return { prod: r2(prod), ipi: r2(ipi), total: r2(prod + ipi + outros) };
  }, [escolhidas, itens]);

  const cfop = (data?.finalidades || []).find((f: any) => f.valor === finalidade)?.cfop;
  const excedeu = escolhidas.some((l) => Number(l.quantidade) > (itens.find((x) => x.nItem === l.nItem)?.saldo || 0) + 1e-6);

  const emitir = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/purchases/${purchaseId}/devolucao`, {
      finalidade, motivo, baixarEstoque, abaterFinanceiro,
      itens: escolhidas.map((l) => ({ nItem: l.nItem, quantidade: Number(l.quantidade), rawMaterialId: l.rawMaterialId || null, fator: Number(l.fator) || 1 })),
    }, { timeout: 180000 }),
    onSuccess: (r: any) => {
      setResultado(r);
      toast({ title: `NF-e de devolução nº ${r.invoiceNumber} autorizada`, description: `Valor ${brl(r.valor)}` });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/synced-table/raw_materials"] });
      refetch();
    },
    onError: (e: any) => { toast({ title: "Devolução não autorizada", description: e.message, variant: "destructive" }); refetch(); },
  });

  const descartar = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/purchase-returns/${id}/descartar`, {}),
    onSuccess: () => { toast({ title: "Devolução descartada — saldo liberado" }); refetch(); },
    onError: (e: any) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const materias: any[] = data?.materias || [];
  const NF_STATUS: Record<string, string> = { authorized: "Autorizada", draft: "Rascunho", rejected: "Rejeitada", cancelled: "Cancelada" };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Undo2 className="h-5 w-5" /> Devolver ao fornecedor</DialogTitle>
          <DialogDescription>
            Emite a NF-e de devolução (saída, finalidade 4) pela empresa que comprou, referenciando a NF de entrada. Estoque e contas a pagar só mexem depois da autorização da SEFAZ.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Carregando a NF de compra…</p>}
        {error && <p className="text-sm text-red-600"><AlertCircle className="inline h-4 w-4 mr-1" />{(error as any).message}</p>}

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">NF de compra</div>
                <div className="font-medium">nº {data.compra.numero} — {brl(data.compra.total)}</div>
                <div className="text-xs font-mono break-all">{data.compra.chave}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Destinatário (fornecedor)</div>
                <div className="font-medium">{data.fornecedor.nome}</div>
                <div className="text-xs">{data.fornecedor.xMun}/{data.fornecedor.uf} · IE {data.fornecedor.ie || "—"}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Emitente</div>
                <div className="font-medium">{data.emitente?.instancia} — {data.emitente?.uf}</div>
                <div className="text-xs">{data.interestadual ? "Operação interestadual" : "Operação interna"}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Finalidade da compra</Label>
                <Select value={finalidade} onValueChange={setFinalidade}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(data.finalidades || []).map((f: any) => (
                      <SelectItem key={f.valor} value={f.valor}>{f.rotulo} — CFOP {f.cfop}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Rótulos, garrafas e tampas = industrialização ({cfop}).</p>
              </div>
              <div>
                <Label>Motivo da devolução</Label>
                <Textarea className="mt-1" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: rótulos com defeito de impressão / fora do especificado" />
              </div>
            </div>

            <div className="border rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    <th className="p-2 text-left">Devolver</th>
                    <th className="p-2 text-left">Item da NF</th>
                    <th className="p-2 text-right">Qtd NF</th>
                    <th className="p-2 text-right">Saldo</th>
                    <th className="p-2 text-right">Qtd a devolver</th>
                    <th className="p-2 text-left">Baixar do estoque (matéria-prima)</th>
                    <th className="p-2 text-right">Fator</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((it) => {
                    const l = linhas.find((x) => x.nItem === it.nItem);
                    if (!l) return null;
                    const semSaldo = !(it.saldo > 0);
                    return (
                      <tr key={it.nItem} className="border-t align-top">
                        <td className="p-2"><Checkbox disabled={semSaldo} checked={l.marcado} onCheckedChange={(v) => set(it.nItem, { marcado: !!v })} /></td>
                        <td className="p-2">
                          <div className="font-medium">{it.nItem}. {it.xProd}</div>
                          <div className="text-xs text-muted-foreground">NCM {it.NCM} · CFOP origem {it.CFOP} · {brl(it.vUnCom)}/{it.uCom}{it.vIPI > 0 ? ` · IPI ${brl(it.vIPI)}` : ""}</div>
                        </td>
                        <td className="p-2 text-right">{it.qCom} {it.uCom}</td>
                        <td className="p-2 text-right">{semSaldo ? <Badge variant="secondary">devolvido</Badge> : it.saldo}</td>
                        <td className="p-2 text-right">
                          <Input className="w-28 ml-auto text-right" type="number" step="any" min={0} max={it.saldo} disabled={!l.marcado}
                            value={l.quantidade} onChange={(e) => set(it.nItem, { quantidade: e.target.value })} />
                        </td>
                        <td className="p-2">
                          <Select value={l.rawMaterialId || "none"} onValueChange={(v) => set(it.nItem, { rawMaterialId: v === "none" ? "" : v })} disabled={!l.marcado || !baixarEstoque}>
                            <SelectTrigger className="w-64"><SelectValue placeholder="Não baixar" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— não baixar —</SelectItem>
                              {materias.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} ({Number(m.quantity).toLocaleString("pt-BR")} {m.unit})</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-2 text-right">
                          <Input className="w-20 ml-auto text-right" type="number" step="any" min={0} disabled={!l.marcado || !l.rawMaterialId}
                            value={l.fator} onChange={(e) => set(it.nItem, { fator: e.target.value })} title="Quanto 1 unidade da NF vale na unidade do estoque (ex.: NF em milheiro → 1000)" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2"><Checkbox checked={baixarEstoque} onCheckedChange={(v) => setBaixarEstoque(!!v)} /> Baixar do estoque de matéria-prima</label>
              <label className="flex items-center gap-2"><Checkbox checked={abaterFinanceiro} onCheckedChange={(v) => setAbaterFinanceiro(!!v)} /> Abater das contas a pagar desta compra</label>
            </div>

            <div className="rounded bg-muted/40 p-3 text-sm flex flex-wrap gap-6">
              <span>Produtos: <b>{brl(totais.prod)}</b></span>
              {totais.ipi > 0 && <span>IPI devolvido: <b>{brl(totais.ipi)}</b></span>}
              <span>Total da NF-e de devolução: <b>{brl(totais.total)}</b></span>
              <span>CFOP: <b>{cfop}</b></span>
            </div>

            {resultado?.success && (
              <div className="rounded border border-emerald-300 bg-emerald-50 dark:bg-emerald-950 p-3 text-sm space-y-1">
                <div className="font-medium text-emerald-800 dark:text-emerald-200"><CheckCircle2 className="inline h-4 w-4 mr-1" />NF-e nº {resultado.invoiceNumber} autorizada — protocolo {resultado.protocolNumber}</div>
                <div className="font-mono text-xs break-all">{resultado.accessKey}</div>
                {(resultado.avisos || []).map((a: string, i: number) => <div key={i} className="text-amber-700">⚠ {a}</div>)}
              </div>
            )}

            {(data.devolucoes || []).length > 0 && (
              <div className="text-sm">
                <div className="font-medium mb-1">Devoluções desta compra</div>
                <div className="space-y-1">
                  {data.devolucoes.map((d: any) => (
                    <div key={d.id} className="flex flex-wrap items-center gap-2 border rounded px-2 py-1">
                      <span>NF-e {d.invoice_number || "—"}</span>
                      <Badge variant="outline">{NF_STATUS[d.nf_status] || d.nf_status || "—"}</Badge>
                      <Badge variant="secondary">{d.status}</Badge>
                      <span>{brl(d.valor_total)} · CFOP {d.cfop}</span>
                      {Number(d.credito_fornecedor) > 0 && <span className="text-amber-700">crédito com fornecedor {brl(d.credito_fornecedor)}</span>}
                      {d.status === "rascunho" && d.nf_status !== "authorized" && (
                        <Button size="sm" variant="ghost" className="ml-auto h-7" disabled={descartar.isPending} onClick={() => descartar.mutate(d.id)}>Descartar</Button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Nota rejeitada pode ser corrigida e retransmitida em Notas Fiscais — ao autorizar, o estoque e o financeiro são acertados sozinhos.</p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          <Button
            disabled={!data || !escolhidas.length || motivo.trim().length < 5 || excedeu || emitir.isPending}
            onClick={() => {
              if (!window.confirm(`Emitir a NF-e de devolução para ${data?.fornecedor?.nome} no valor de ${brl(totais.total)} (CFOP ${cfop})?\n\nA nota vai para a SEFAZ em ${data?.emitente?.instancia}.`)) return;
              emitir.mutate();
            }}
          >
            {emitir.isPending ? "Transmitindo…" : "Emitir NF-e de devolução"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
