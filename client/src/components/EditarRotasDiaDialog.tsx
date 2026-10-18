// ============================================================================
// EDITAR ROTAS DO DIA (rotas JÁ SALVAS) — 18/out/2026
// ----------------------------------------------------------------------------
// Abre todas as rotas salvas de um dia lado a lado. O operador:
//   • migra entregas entre entregadores ("Migrar para…"), inclusive para um
//     entregador que ainda não tem rota no dia (vira rota nova ao salvar);
//   • muda a ordem (↑ ↓);
//   • tira a entrega da rota (volta para "Aguardando Rota").
// Nada é gravado até "Salvar alterações": aí tudo vai junto para
// POST /api/delivery-routes/ajustar-dia, que refaz os horários (deslocamento +
// horário de recebimento + tempo de entrega). Entregas já efetuadas/devolvidas
// ficam travadas onde aconteceram.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowDown, ArrowUp, Loader2, Lock, Truck, Undo2, UserPlus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, useQuery } from "@/lib/queryClient";

interface Parada {
  id: string;
  customerName: string;
  customerAddress?: string;
  orderNumber?: string | null;
  stopOrder: number;
  status: string;
  estimatedArrival?: string | null;
  isPriority?: boolean;
  billingId?: string | null;
  salesCardId?: string | null;
}
interface Rota {
  id: string;
  driverId: string;
  driverName: string;
  vehicleType?: string;
  status: string;
  stops?: Parada[];
}
interface Coluna {
  chave: string;
  routeId: string | null;
  driverId: string;
  driverName: string;
  vehicleType?: string;
  paradas: Parada[];
}

const FINAIS = new Set(["efetuada", "devolvida"]);
const BRL = (v: number) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtdTxt = (n: number) => (Number(n) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
/** Itens do pedido (products vem como array ou JSON em texto). */
function contarItens(products: any): number {
  let lista: any = products;
  if (typeof lista === "string") { try { lista = JSON.parse(lista); } catch { lista = []; } }
  if (!Array.isArray(lista)) return 0;
  return lista.reduce((s: number, p: any) => s + (Number(p?.quantity ?? p?.qty ?? 0) || 0), 0);
}
const idPedido = (p: Parada) => String(p.billingId || p.salesCardId || "");
const veiculo = (v?: string) => (v === "caminhao" ? "Caminhão" : v === "carro" ? "Carro" : v === "baruc" ? "Baruc" : v === "moto" ? "Moto" : v || "");

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  routeDate: string;
  routes: Rota[];
  drivers: Array<{ id: string; name: string; vehicleType?: string; isActive?: boolean }>;
}

export default function EditarRotasDiaDialog({ open, onOpenChange, routeDate, routes, drivers }: Props) {
  const { toast } = useToast();
  const [colunas, setColunas] = useState<Coluna[]>([]);
  const [removidas, setRemovidas] = useState<Array<{ parada: Parada; deChave: string }>>([]);
  const [reorganizar, setReorganizar] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [novoEntregador, setNovoEntregador] = useState("");

  const rotasValidas = useMemo(
    () => (routes || []).filter((r) => !["cancelled", "cancelada"].includes(String(r.status))),
    [routes],
  );

  // Estado inicial = rotas como estão salvas (refeito a cada abertura).
  const inicial = useMemo<Coluna[]>(
    () =>
      rotasValidas.map((r) => ({
        chave: r.id,
        routeId: r.id,
        driverId: r.driverId,
        driverName: r.driverName,
        vehicleType: r.vehicleType,
        paradas: [...(r.stops || [])].sort((a, b) => (a.stopOrder || 0) - (b.stopOrder || 0)),
      })),
    [rotasValidas],
  );
  // Valor (NF) e itens de cada entrega — atualiza os totais das colunas a cada migração.
  const idsPedidos = useMemo(
    () => Array.from(new Set(inicial.flatMap((c) => c.paradas.map(idPedido)).filter(Boolean))).sort(),
    [inicial],
  );
  const { data: pedidos = [], isLoading: carregandoValores } = useQuery<any[]>({
    queryKey: ["editar-rotas-dia-valores", routeDate, idsPedidos.join(",")],
    queryFn: () => apiRequest("POST", "/api/billing-pipeline/items-by-ids", { ids: idsPedidos }),
    enabled: open && idsPedidos.length > 0,
    staleTime: 60 * 1000,
  });
  const infoPedido = useMemo(() => {
    const m = new Map<string, { valor: number; itens: number; nf: string }>();
    for (const it of (Array.isArray(pedidos) ? pedidos : [])) {
      m.set(String(it.id), { valor: Number(it.saleValue) || 0, itens: contarItens(it.products), nf: String(it.invoiceNumber || "").trim() });
    }
    return m;
  }, [pedidos]);
  const totaisDe = (ps: Parada[]) => ps.reduce(
    (acc, p) => { const i = infoPedido.get(idPedido(p)); if (i) { acc.valor += i.valor; acc.itens += i.itens; } return acc; },
    { valor: 0, itens: 0 },
  );
  const totalAntes = useMemo(() => {
    const m = new Map<string, number>();
    inicial.forEach((c) => m.set(c.chave, totaisDe(c.paradas).valor));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inicial, infoPedido]);

  useEffect(() => {
    if (open) {
      setColunas(inicial.map((c) => ({ ...c, paradas: [...c.paradas] })));
      setRemovidas([]);
      setNovoEntregador("");
    }
  }, [open, inicial]);

  // O que mudou: entregas migradas, retiradas e rotas com a ordem mexida à mão.
  const resumo = useMemo(() => {
    const origem = new Map<string, string>();
    inicial.forEach((c) => c.paradas.forEach((p) => origem.set(p.id, c.chave)));
    let migradas = 0;
    let reordenadas = 0;
    for (const c of colunas) {
      migradas += c.paradas.filter((p) => origem.get(p.id) !== c.chave).length;
      const ini = inicial.find((x) => x.chave === c.chave);
      if (!ini) continue;
      const ficaram = new Set(c.paradas.map((p) => p.id));
      const ordemAntes = ini.paradas.map((p) => p.id).filter((id) => ficaram.has(id));
      const ordemAgora = c.paradas.map((p) => p.id).filter((id) => origem.get(id) === c.chave);
      if (ordemAntes.join('|') !== ordemAgora.join('|')) reordenadas++;
    }
    const partes: string[] = [];
    if (migradas) partes.push(`${migradas} migrada${migradas > 1 ? 's' : ''}`);
    if (removidas.length) partes.push(`${removidas.length} retirada${removidas.length > 1 ? 's' : ''}`);
    if (reordenadas) partes.push(`${reordenadas} rota${reordenadas > 1 ? 's' : ''} reordenada${reordenadas > 1 ? 's' : ''}`);
    return { total: migradas + removidas.length + reordenadas, texto: partes.join(' · ') };
  }, [colunas, removidas, inicial]);
  const alteracoes = resumo.total;

  const origemDe = useMemo(() => {
    const m = new Map<string, string>();
    inicial.forEach((c) => c.paradas.forEach((p) => m.set(p.id, c.chave)));
    return m;
  }, [inicial]);

  const mover = (chave: string, idx: number, delta: number) => {
    setColunas((prev) => prev.map((c) => {
      if (c.chave !== chave) return c;
      const j = idx + delta;
      if (j < 0 || j >= c.paradas.length) return c;
      const ps = [...c.paradas];
      [ps[idx], ps[j]] = [ps[j], ps[idx]];
      return { ...c, paradas: ps };
    }));
  };

  const migrar = (deChave: string, parada: Parada, alvo: string) => {
    if (alvo === "__remover") {
      setColunas((prev) => prev.map((c) => (c.chave === deChave ? { ...c, paradas: c.paradas.filter((p) => p.id !== parada.id) } : c)));
      setRemovidas((prev) => [...prev, { parada, deChave }]);
      return;
    }
    setColunas((prev) => prev.map((c) => {
      if (c.chave === deChave) return { ...c, paradas: c.paradas.filter((p) => p.id !== parada.id) };
      if (c.chave === alvo) return { ...c, paradas: [...c.paradas, parada] };
      return c;
    }));
  };

  const desfazerRemocao = (id: string) => {
    const r = removidas.find((x) => x.parada.id === id);
    if (!r) return;
    setRemovidas((prev) => prev.filter((x) => x.parada.id !== id));
    setColunas((prev) => {
      const alvo = prev.some((c) => c.chave === r.deChave) ? r.deChave : prev[0]?.chave;
      return prev.map((c) => (c.chave === alvo ? { ...c, paradas: [...c.paradas, r.parada] } : c));
    });
  };

  const entregadoresSemColuna = (drivers || [])
    .filter((d) => d.isActive !== false && !colunas.some((c) => c.driverId === d.id))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const adicionarEntregador = (id: string) => {
    const d = drivers.find((x) => x.id === id);
    if (!d) return;
    setColunas((prev) => [...prev, { chave: `novo-${d.id}`, routeId: null, driverId: d.id, driverName: d.name, vehicleType: d.vehicleType, paradas: [] }]);
    setNovoEntregador("");
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await apiRequest("POST", "/api/delivery-routes/ajustar-dia", {
        routeDate,
        reorganizar,
        rotas: colunas.map((c) => ({ routeId: c.routeId, driverId: c.driverId, stopIds: c.paradas.map((p) => p.id) })),
        removidas: removidas.map((x) => x.parada.id),
      });
      const mudaram = (r?.rotas || []).filter((x: any) => x.mudou).length;
      queryClient.invalidateQueries({ queryKey: ["editar-rotas-dia-valores"] });
      toast({
        title: "Rotas salvas",
        description: `${mudaram} rota(s) alterada(s)${r?.removidas ? `, ${r.removidas} entrega(s) de volta para Aguardando Rota` : ""}. Horários recalculados — reimprima as rotas alteradas.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/delivery-routes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/delivery-routes/dias-salvos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/billing-pipeline"] });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Não foi possível salvar", description: e?.message || "Erro desconhecido", variant: "destructive" });
    } finally {
      setSalvando(false);
    }
  };

  const dataBR = routeDate ? `${routeDate.slice(8, 10)}/${routeDate.slice(5, 7)}/${routeDate.slice(0, 4)}` : "";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!salvando) onOpenChange(v); }}>
      <DialogContent className="!max-w-[min(96vw,1500px)] !w-[96vw] max-h-[92vh] flex flex-col" data-testid="dialog-editar-rotas-dia">
        <DialogHeader>
          <DialogTitle>Editar rotas de {dataBR}</DialogTitle>
          <DialogDescription>
            Migre entregas entre entregadores, mude a ordem ou tire da rota. Nada é gravado até você clicar em <b>Salvar alterações</b>.
            {" "}
            {carregandoValores ? "Carregando valores…" : (() => {
              const t = totaisDe(colunas.flatMap((c) => c.paradas));
              return <span className="text-gray-700">Total nas rotas: <b>{BRL(t.valor)}</b> · {qtdTxt(t.itens)} itens.</span>;
            })()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto">
          <div className="flex gap-3 items-start pb-2">
            {colunas.map((c) => {
              const sent = rotasValidas.find((r) => r.id === c.routeId)?.status === "rota_enviada";
              return (
                <div key={c.chave} className="w-[320px] shrink-0 rounded-lg border bg-gray-50" data-testid={`coluna-${c.chave}`}>
                  <div className="px-3 py-2 border-b bg-white rounded-t-lg">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold flex items-center gap-1.5 text-sm">
                        <Truck className="h-4 w-4 text-gray-500" /> {c.driverName}
                      </span>
                      <Badge variant="outline" className="text-xs">{c.paradas.length} entrega(s)</Badge>
                    </div>
                    {(() => {
                      const t = totaisDe(c.paradas);
                      const antes = totalAntes.get(c.chave) ?? 0;
                      const delta = Math.round((t.valor - antes) * 100) / 100;
                      return (
                        <div className="text-sm mt-1 flex items-baseline gap-2 flex-wrap" data-testid={`total-coluna-${c.chave}`}>
                          <b className="text-gray-900">{BRL(t.valor)}</b>
                          <span className="text-xs text-gray-500">{qtdTxt(t.itens)} itens</span>
                          {delta !== 0 && (
                            <span className={`text-xs font-medium ${delta > 0 ? "text-green-700" : "text-red-700"}`}>
                              {delta > 0 ? "+" : "−"}{BRL(Math.abs(delta))}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div className="text-xs text-gray-500 mt-0.5">
                      {veiculo(c.vehicleType)}
                      {!c.routeId && <span className="ml-1 text-blue-700">· rota nova (criada ao salvar)</span>}
                      {sent && <span className="ml-1 text-amber-700">· já enviada: o app do entregador atualiza</span>}
                    </div>
                  </div>
                  <div className="p-2 space-y-1.5">
                    {c.paradas.length === 0 && (
                      <div className="text-xs text-gray-400 text-center py-4">
                        {c.routeId ? "Sem entregas — a rota será excluída ao salvar." : "Migre entregas para este entregador."}
                      </div>
                    )}
                    {c.paradas.map((p, i) => {
                      const travada = FINAIS.has(String(p.status));
                      const veioDeOutra = origemDe.get(p.id) !== c.chave;
                      return (
                        <div
                          key={p.id}
                          className={`rounded border bg-white px-2 py-1.5 text-xs ${veioDeOutra ? "border-blue-400 ring-1 ring-blue-200" : ""}`}
                          data-testid={`parada-editor-${p.id}`}
                        >
                          <div className="flex items-start gap-1.5">
                            <span className="font-bold text-gray-500 w-5 shrink-0 text-right">{i + 1}.</span>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate" title={p.customerName}>
                                {p.customerName}{p.isPriority ? " ★" : ""}
                              </div>
                              <div className="text-gray-500 truncate" title={p.customerAddress}>{p.customerAddress}</div>
                              <div className="text-gray-400">
                                {(() => {
                                  const inf = infoPedido.get(idPedido(p));
                                  if (!inf) return p.orderNumber ? `Pedido ${p.orderNumber} · ` : "";
                                  return (
                                    <span className="text-gray-700">
                                      {inf.nf ? `${inf.nf} · ` : p.orderNumber ? `Pedido ${p.orderNumber} · ` : ""}
                                      <b>{BRL(inf.valor)}</b>{inf.itens ? ` · ${qtdTxt(inf.itens)} itens` : ""}{" · "}
                                    </span>
                                  );
                                })()}
                                {travada ? <span className="text-green-700 font-medium">{p.status}</span> : (p.estimatedArrival ? `previsto ${String(p.estimatedArrival).slice(0, 5)}` : "")}
                                {veioDeOutra && <span className="text-blue-700"> · migrada</span>}
                              </div>
                            </div>
                            <div className="flex flex-col">
                              <button type="button" className="p-0.5 text-gray-500 hover:text-gray-900 disabled:opacity-30" disabled={i === 0} onClick={() => mover(c.chave, i, -1)} title="Subir">
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" className="p-0.5 text-gray-500 hover:text-gray-900 disabled:opacity-30" disabled={i === c.paradas.length - 1} onClick={() => mover(c.chave, i, 1)} title="Descer">
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          <div className="mt-1">
                            {travada ? (
                              <div className="flex items-center gap-1 text-gray-400"><Lock className="h-3 w-3" /> Entrega finalizada: fica nesta rota</div>
                            ) : (
                              <Select value="" onValueChange={(v) => migrar(c.chave, p, v)}>
                                <SelectTrigger className="h-7 text-xs" data-testid={`migrar-${p.id}`}>
                                  <SelectValue placeholder="Migrar para…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {colunas.filter((o) => o.chave !== c.chave).map((o) => (
                                    <SelectItem key={o.chave} value={o.chave}>{o.driverName}{!o.routeId ? " (rota nova)" : ""}</SelectItem>
                                  ))}
                                  <SelectItem value="__remover" className="text-red-700">Tirar da rota (volta para Aguardando Rota)</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <div className="w-[240px] shrink-0 rounded-lg border border-dashed p-3 space-y-2">
              <div className="text-sm font-medium flex items-center gap-1.5"><UserPlus className="h-4 w-4" /> Outro entregador</div>
              <p className="text-xs text-gray-500">Para migrar entregas a quem ainda não tem rota neste dia.</p>
              <Select value={novoEntregador} onValueChange={adicionarEntregador}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-novo-entregador">
                  <SelectValue placeholder={entregadoresSemColuna.length ? "Escolher entregador" : "Todos já estão aqui"} />
                </SelectTrigger>
                <SelectContent>
                  {entregadoresSemColuna.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}{d.vehicleType ? ` · ${veiculo(d.vehicleType)}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {removidas.length > 0 && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-sm font-medium text-red-800 mb-1">Saem da rota ao salvar (voltam para Aguardando Rota)</div>
              <div className="flex flex-wrap gap-1.5">
                {removidas.map(({ parada }) => (
                  <span key={parada.id} className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-white px-2 py-0.5 text-xs">
                    {parada.customerName}
                    <button type="button" onClick={() => desfazerRemocao(parada.id)} title="Desfazer" className="text-red-700 hover:text-red-900">
                      <Undo2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t pt-3">
          <label className="flex items-start gap-2 text-xs text-gray-700 max-w-xl">
            <Checkbox checked={reorganizar} onCheckedChange={(v) => setReorganizar(v === true)} data-testid="check-reorganizar" />
            <span>
              Reorganizar a ordem das rotas que ganharem ou perderem entregas (horário de recebimento + distância).
              Desmarcado, vale a ordem que está aqui. Os horários são recalculados sempre.
            </span>
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={salvando}>
              <X className="h-4 w-4 mr-1" /> Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando || alteracoes === 0} className="bg-green-600 hover:bg-green-700" data-testid="button-salvar-ajustes">
              {salvando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Salvar alterações{resumo.texto ? ` (${resumo.texto})` : ""}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
