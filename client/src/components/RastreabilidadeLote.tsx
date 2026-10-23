import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, PackageSearch, Search, FileDown } from "lucide-react";
import { MultiSelect, exportToExcel } from "@/lib/tableTools";

/**
 * RASTREABILIDADE DE LOTE (22/out/2026)
 * Todas as notas fiscais faturadas que levaram o lote "X" do produto "Y", com a
 * instância que emitiu cada nota. Transferências ficam de fora; todos os outros
 * tipos de NF entram (venda, troca, amostra, bonificação, devolução de venda…).
 * Dados: GET /api/rastreabilidade-lote (server/rastreabilidade-lote-routes.ts).
 */

interface Linha {
  invoiceId: string;
  numero: number | null;
  serie: string;
  data: string;
  status: string;
  tipo: "entrada" | "saida";
  cfop: string;
  natureza: string;
  instancia: string;
  cliente: string;
  clienteDoc: string;
  cidade: string;
  chave: string;
  productId: string | null;
  produto: string;
  lote: string;
  lotesDoItem: string;
  qtdItem: number;
  qtdLote: number | null;
  sinal: number;
  valorUnit: number;
}

const TODOS = "__todos__";
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  authorized: { label: "Autorizada", cls: "bg-green-100 text-green-800" },
  returned: { label: "Devolvida", cls: "bg-amber-100 text-amber-800" },
  cancelled: { label: "Cancelada", cls: "bg-red-100 text-red-800" },
};

/** Tipo da NF a partir da natureza / CFOP (só para leitura e filtro). */
function tipoNf(l: Linha): string {
  const nat = (l.natureza || "").toUpperCase();
  const c = (l.cfop || "").replace(/\D/g, "");
  if (l.tipo === "entrada") return nat.includes("DEVOL") || /^[12]20[12]$/.test(c) || /^[12]41[01]$/.test(c) ? "Devolução de venda" : "Entrada (outras)";
  if (nat.includes("AMOSTRA") || c.endsWith("911")) return "Amostra";
  if (nat.includes("TROCA") || c.endsWith("949")) return "Troca";
  if (nat.includes("BONIFIC") || c.endsWith("910")) return "Bonificação";
  if (nat.includes("DEVOL")) return "Devolução";
  if (nat.includes("REMESSA")) return "Remessa";
  if (nat.includes("VENDA") || /^[56][14]0\d$/.test(c)) return "Venda";
  return "Outros";
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString("pt-BR");
const fmtData = (d: string) => (d ? new Date(d).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
const fmtDT = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

/* ------------------------------------------------------------------------ */
/* LINHA DO TEMPO (produção → transferência → recebimento → destino)          */
/* GET /api/rastreabilidade-lote/linha-do-tempo                               */
/* ------------------------------------------------------------------------ */
type Divergencia = { tipo: string; gravidade: "alta" | "media" | "info"; texto: string; ref?: any };
type LinhaTempo = {
  lote: string;
  producao: Array<{ id: string; order_number: string; product_name: string; quantity: number; qtdLancada: number; instance_name: string; status: string; production_date: string | null; end_date: string | null; lot_expiry_date: string | null; created_by: string | null }>;
  lotes: Array<{ id: string; product_name: string; instancia: string; stock_type: string; quantity: number; is_active: boolean; unit_cost: number | null; desbloqueado_por_nome: string | null; desbloqueado_em: string | null; created_at: string }>;
  movimentos: Array<{ id: string; instancia: string; movement_type: string; quantity: number; previous_quantity: number | null; new_quantity: number | null; source_type: string | null; source_id: string | null; notes: string | null; created_by: string | null; created_at: string; lot_stock_type: string; pedido: string | null; nf_id: string | null; nf_numero: number | null; nf_status: string | null; nf_cfop: string | null; nf_natureza: string | null; nf_cliente: string | null; vivo: boolean }>;
  notas: Array<Linha & { transferencia: boolean; instCode: string }>;
  recebimentos: Array<{ id: string; instance_name: string; qtd_faturada: string; qtd_recebida: string; divergencia: string; observacao: string | null; recebido_por_nome: string; created_at: string; chamado_ids: string[] | null }>;
  balanco: Array<{ instancia: string; code: string; producao: number; entradasTransferencia: number; ajustes: number; estornos: number; consumos: number; saldoRecalculado: number; saldoEmUso: number; saldoBloqueado: number; nfSaida: number; nfSaidaTransf: number; nfEntrada: number }>;
  destinacao: { produzido: number; vendidoLiquido: number; emEstoque: number; ajustes: number; naoExplicado: number };
  divergencias: Divergencia[];
};
const MOV_LABEL: Record<string, string> = { replenish: "Entrada", consume: "Baixa (NF)", adjust: "Ajuste manual", cancel_reversal: "Estorno", transfer: "Promoção bloq.→uso", block: "Bloqueio", unblock: "Desbloqueio" };
const GRAV_CLS: Record<string, string> = { alta: "border-red-300 bg-red-50 text-red-900", media: "border-amber-300 bg-amber-50 text-amber-900", info: "border-slate-200 bg-slate-50 text-slate-700" };

function LinhaDoTempo({ consulta }: { consulta: { lote: string; productId: string | null } }) {
  const { data, isFetching, error } = useQuery<LinhaTempo>({
    queryKey: ["/api/rastreabilidade-lote/linha-do-tempo", consulta],
    queryFn: () => {
      const p = new URLSearchParams({ lote: consulta.lote });
      if (consulta.productId) p.set("productId", consulta.productId);
      return fetch(`/api/rastreabilidade-lote/linha-do-tempo?${p}`).then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`);
        return r.json();
      });
    },
  });
  if (error) return <Card><CardContent className="p-8 text-center text-red-600">Erro: {(error as Error).message}</CardContent></Card>;
  if (!data || isFetching) return <Card><CardContent className="p-8 text-center text-muted-foreground">Montando a linha do tempo…</CardContent></Card>;
  const d = data.destinacao;
  const altas = data.divergencias.filter(x => x.gravidade === "alta").length;
  const exportarMov = () => exportToExcel(data.movimentos.map(m => ({
    "Data": fmtDT(m.created_at), "Instância": m.instancia, "Tipo": MOV_LABEL[m.movement_type] || m.movement_type, "Lote (tipo)": m.lot_stock_type === "in_use" ? "Em uso" : "Bloqueado",
    "Quantidade": m.quantity, "Saldo anterior": m.previous_quantity ?? "", "Saldo novo": m.new_quantity ?? "",
    "NF": m.nf_numero ?? "", "Status NF": m.nf_status || "", "CFOP": m.nf_cfop || "", "Cliente/Destinatário": m.nf_cliente || "", "Pedido": m.pedido || "",
    "Vivo": m.vivo ? "sim" : "estornado", "Por": m.created_by || "", "Observação": m.notes || "",
  })), `linha-do-tempo-${data.lote}`);
  return (
    <div className="space-y-4" data-testid="linha-do-tempo-lote">
      {/* Destinação */}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-6">
        <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Lote</div><div className="text-xl font-bold">{data.lote}</div></CardContent></Card>
        <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Produzido (OP)</div><div className="text-xl font-bold">{fmtNum(d.produzido)}</div></CardContent></Card>
        <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Vendido/trocado (líquido, NF)</div><div className="text-xl font-bold">{fmtNum(d.vendidoLiquido)}</div></CardContent></Card>
        <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Em estoque (todas)</div><div className="text-xl font-bold">{fmtNum(d.emEstoque)}</div></CardContent></Card>
        <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Ajustes manuais</div><div className="text-xl font-bold">{d.ajustes > 0 ? "+" : ""}{fmtNum(d.ajustes)}</div></CardContent></Card>
        <Card className={`py-0 ${Math.abs(d.naoExplicado) > 0.5 ? "border-red-400" : "border-green-400"}`}><CardContent className="p-3">
          <div className="text-[11px] text-muted-foreground">Sem destino explicado</div>
          <div className={`text-xl font-bold ${Math.abs(d.naoExplicado) > 0.5 ? "text-red-700" : "text-green-700"}`}>{fmtNum(d.naoExplicado)}</div>
        </CardContent></Card>
      </div>

      {/* Divergências */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2">Divergências
          <Badge variant={altas ? "destructive" : "secondary"}>{altas} crítica(s) · {data.divergencias.length} no total</Badge></CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {data.divergencias.length === 0 ? <div className="text-sm text-green-700">Nenhuma divergência: NFs, movimentos e saldos batem.</div> : data.divergencias.map((x, i) => (
            <div key={i} className={`text-sm rounded border px-2 py-1.5 flex gap-2 ${GRAV_CLS[x.gravidade]}`}>
              <Badge variant="outline" className="shrink-0 text-[10px] h-5">{x.tipo}</Badge>
              <span>{x.texto}{x.ref?.invoiceId && <a className="ml-1 underline" href={`/api/contabilidade/fiscal/nota/${x.ref.invoiceId}/danfe`} target="_blank" rel="noreferrer">DANFE</a>}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Balanço por instância */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Balanço por instância (unidades do lote)</CardTitle></CardHeader>
        <CardContent className="overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="text-left border-b">
              <th className="px-2 py-1.5">Instância</th><th className="px-2 py-1.5 text-right">Produção</th><th className="px-2 py-1.5 text-right">Entrada transf.</th>
              <th className="px-2 py-1.5 text-right">Baixas (NF)</th><th className="px-2 py-1.5 text-right">Estornos</th><th className="px-2 py-1.5 text-right">Ajustes</th>
              <th className="px-2 py-1.5 text-right">Saldo recalc.</th><th className="px-2 py-1.5 text-right">Em uso</th><th className="px-2 py-1.5 text-right">Bloqueado</th>
              <th className="px-2 py-1.5 text-right">NF saída</th><th className="px-2 py-1.5 text-right">NF transf.</th><th className="px-2 py-1.5 text-right">NF entrada</th>
            </tr></thead>
            <tbody>{data.balanco.map(b => {
              const ok = Math.abs(b.saldoRecalculado - (b.saldoEmUso + b.saldoBloqueado)) <= 0.001;
              return (<tr key={b.code} className="border-b">
                <td className="px-2 py-1.5"><Badge variant="outline">{b.instancia}</Badge></td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.producao)}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.entradasTransferencia)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.consumos)}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.estornos)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{b.ajustes > 0 ? "+" : ""}{fmtNum(b.ajustes)}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${ok ? "" : "text-red-700"}`}>{fmtNum(b.saldoRecalculado)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.saldoEmUso)}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.saldoBloqueado)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.nfSaida)}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.nfSaidaTransf)}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(b.nfEntrada)}</td>
              </tr>);
            })}</tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Produção */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">1 · Produção</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.producao.length === 0 ? <div className="text-muted-foreground">Nenhuma ordem de produção com este lote (lote criado à mão ou importado).</div> : data.producao.map(po => (
              <div key={po.id} className="rounded border p-2">
                <div className="font-medium">OP {po.order_number} · {po.instance_name} · <Badge variant="outline" className="text-[10px]">{po.status}</Badge></div>
                <div className="text-xs text-muted-foreground">{po.product_name} · produzido {fmtNum(po.quantity)} · lançado no estoque {fmtNum(po.qtdLancada)} · produção {po.production_date ? fmtData(po.production_date) : "—"} · validade {po.lot_expiry_date || "—"} · por {po.created_by || "—"}</div>
              </div>
            ))}
          </CardContent>
        </Card>
        {/* Recebimentos */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">3 · Recebimento na filial (conferência)</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.recebimentos.length === 0 ? <div className="text-muted-foreground">Nenhuma conferência registrada para este lote.</div> : data.recebimentos.map(r => {
              const dv = Number(r.divergencia) || 0;
              return (<div key={r.id} className={`rounded border p-2 ${dv !== 0 ? "border-red-300 bg-red-50/50" : ""}`}>
                <div className="font-medium">{r.instance_name} · {fmtDT(r.created_at)} · por {r.recebido_por_nome}</div>
                <div className="text-xs">faturado {fmtNum(Number(r.qtd_faturada))} · recebido {fmtNum(Number(r.qtd_recebida))} · {dv === 0 ? <span className="text-green-700">sem divergência</span> : <span className="text-red-700 font-semibold">divergência {dv > 0 ? "+" : ""}{fmtNum(dv)}</span>}{r.observacao ? ` · ${r.observacao}` : ""}</div>
                {(r.chamado_ids || []).map(id => <a key={id} className="text-xs underline text-primary" href={`/chamados?id=${id}`}>chamado DIVERGENCIA EM RECEBIMENTO</a>)}
              </div>);
            })}
            <div className="pt-1 border-t text-xs text-muted-foreground">Saldos atuais:</div>
            {data.lotes.map(l => (
              <div key={l.id} className="text-xs flex flex-wrap gap-1 items-center">
                <Badge variant="outline">{l.instancia}</Badge>
                <Badge className={l.stock_type === "in_use" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>{l.stock_type === "in_use" ? "Em uso" : "Bloqueado"}</Badge>
                <span className="tabular-nums font-semibold">{fmtNum(l.quantity)}</span>
                {!l.is_active && <span className="text-muted-foreground">(finalizado)</span>}
                {l.desbloqueado_por_nome && <span className="text-muted-foreground">· desbloqueado por {l.desbloqueado_por_nome} em {fmtDT(l.desbloqueado_em)}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* NFs (todas, incl. transferência) */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">2 e 4 · Notas fiscais com o lote (inclusive transferências)</CardTitle></CardHeader>
        <CardContent className="overflow-auto max-h-[50vh]">
          {data.notas.length === 0 ? <div className="text-sm text-muted-foreground">Nenhuma NF com este lote.</div> : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-background"><tr className="text-left border-b">
                <th className="px-2 py-1.5">Data</th><th className="px-2 py-1.5">NF</th><th className="px-2 py-1.5">Instância</th><th className="px-2 py-1.5">Tipo</th><th className="px-2 py-1.5">CFOP</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5">Destinatário</th><th className="px-2 py-1.5 text-right">Qtd lote</th><th className="px-2 py-1.5 text-right">Qtd item</th><th className="px-2 py-1.5">Lotes no item</th><th className="px-2 py-1.5">DANFE</th>
              </tr></thead>
              <tbody>{data.notas.map((n, i) => {
                const st = STATUS_LABEL[n.status] || { label: n.status, cls: "" };
                return (<tr key={`${n.invoiceId}-${i}`} className={`border-b ${n.status === "cancelled" ? "opacity-60" : ""}`}>
                  <td className="px-2 py-1.5 whitespace-nowrap">{fmtData(n.data)}</td>
                  <td className="px-2 py-1.5 font-medium">{n.numero ?? "—"}{n.serie && n.serie !== "1" ? `/${n.serie}` : ""}</td>
                  <td className="px-2 py-1.5"><Badge variant="outline">{n.instancia}</Badge></td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{n.transferencia ? <Badge className="bg-blue-100 text-blue-800 text-[10px]">Transferência</Badge> : tipoNf(n)}</td>
                  <td className="px-2 py-1.5">{n.cfop}</td>
                  <td className="px-2 py-1.5"><Badge className={`${st.cls} text-[11px]`}>{st.label}</Badge></td>
                  <td className="px-2 py-1.5">{n.cliente}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${n.sinal < 0 ? "text-amber-700" : ""}`}>{n.qtdLote == null ? "?" : `${n.sinal < 0 ? "−" : ""}${fmtNum(n.qtdLote)}`}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(n.qtdItem)}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{n.lotesDoItem}</td>
                  <td className="px-2 py-1.5"><a href={`/api/contabilidade/fiscal/nota/${n.invoiceId}/danfe`} target="_blank" rel="noreferrer" className="text-primary"><FileDown className="h-4 w-4" /></a></td>
                </tr>);
              })}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Movimentos */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center justify-between">Movimentos de estoque do lote ({data.movimentos.length})
          <Button variant="outline" size="sm" onClick={exportarMov} disabled={!data.movimentos.length}><Download className="w-4 h-4 mr-2" />Exportar Excel</Button></CardTitle></CardHeader>
        <CardContent className="overflow-auto max-h-[55vh]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-background"><tr className="text-left border-b">
              <th className="px-2 py-1.5">Data</th><th className="px-2 py-1.5">Instância</th><th className="px-2 py-1.5">Movimento</th><th className="px-2 py-1.5">Linha</th><th className="px-2 py-1.5 text-right">Qtd</th><th className="px-2 py-1.5 text-right">Saldo</th><th className="px-2 py-1.5">NF / pedido</th><th className="px-2 py-1.5">Por</th><th className="px-2 py-1.5">Observação</th>
            </tr></thead>
            <tbody>{data.movimentos.map(m => (
              <tr key={m.id} className={`border-b ${m.vivo ? "" : "opacity-50 line-through"}`}>
                <td className="px-2 py-1.5 whitespace-nowrap">{fmtDT(m.created_at)}</td>
                <td className="px-2 py-1.5"><Badge variant="outline">{m.instancia}</Badge></td>
                <td className="px-2 py-1.5 whitespace-nowrap">{MOV_LABEL[m.movement_type] || m.movement_type}</td>
                <td className="px-2 py-1.5 text-xs">{m.lot_stock_type === "in_use" ? "Em uso" : "Bloqueado"}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${m.movement_type === "consume" ? "text-red-700" : m.quantity > 0 ? "text-green-700" : ""}`}>{m.movement_type === "consume" ? "−" : ""}{fmtNum(Math.abs(m.quantity))}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{m.previous_quantity != null ? `${fmtNum(m.previous_quantity)} → ${fmtNum(m.new_quantity || 0)}` : ""}</td>
                <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                  {m.nf_numero != null ? <a className="underline text-primary" href={`/api/contabilidade/fiscal/nota/${m.nf_id}/danfe`} target="_blank" rel="noreferrer">NF-e {m.nf_numero}</a> : null}
                  {m.nf_status && m.nf_status !== "authorized" ? <span className="ml-1 text-amber-700">[{m.nf_status}]</span> : null}
                  {m.pedido ? <span className="ml-1 text-muted-foreground">{m.pedido}</span> : null}
                  {m.nf_cliente ? <div className="text-muted-foreground truncate max-w-[220px]" title={m.nf_cliente}>{m.nf_cliente}</div> : null}
                </td>
                <td className="px-2 py-1.5 text-xs">{m.created_by || ""}</td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground max-w-[360px]" title={m.notes || ""}><div className="truncate">{m.notes}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}


/* ------------------------------------------------------------------------ */
/* DESTINO DAS ENTRADAS (todas as entradas → NF de saída)                    */
/* GET /api/destino-estoque                                                  */
/* ------------------------------------------------------------------------ */
type Entrada = { tipo: string; data: string; quantidade: number; ref: string; refId: string | null; detalhe: string; por: string | null };
type Saida = { tipo: "nf" | "sem_nf" | "ajuste"; data: string; quantidade: number; nfId: string | null; nfNumero: number | null; nfSerie: string | null; nfStatus: string | null; cfop: string | null; natureza: string | null; transferencia: boolean; destinatario: string | null; destinatarioDoc: string | null; instanciaEmissora: string | null; pedido: string | null; detalhe: string; nfTemLote: boolean | null };
type Grupo = { chave: string; productId: string; produto: string; instanceId: string; instancia: string; lote: string; primeiraEntrada: string | null; entradas: Entrada[]; saidas: Saida[]; totais: { entradas: number; saidasNf: number; saidasSemNf: number; ajustesNeg: number; saldoEmUso: number; saldoBloqueado: number; naoExplicado: number }; situacao: "fechado" | "em_estoque" | "divergente"; alertas: string[] };
type Destino = { de: string; ate: string; grupos: Grupo[]; resumo: { lotes: number; divergentes: number; emEstoque: number; fechados: number; entradas: number; saidasNf: number; saidasSemNf: number; ajustesNeg: number; saldo: number; naoExplicado: number; nfs: number } };
const ENTRADA_LABEL: Record<string, string> = { producao: "Produção", transferencia: "Transferência recebida", compra: "Compra (NF entrada)", ajuste: "Ajuste manual (+)", estorno: "Estorno (NF cancelada/devolvida)", criacao: "Criação do lote", desconhecida: "Origem não identificada" };
const SIT: Record<string, { label: string; cls: string }> = { fechado: { label: "Fechado", cls: "bg-green-100 text-green-800" }, em_estoque: { label: "Em estoque", cls: "bg-blue-100 text-blue-800" }, divergente: { label: "Divergente", cls: "bg-red-100 text-red-800" } };
const isoHoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const isoAtras = (d: number) => new Date(Date.now() - 3 * 3600000 - d * 86400000).toISOString().slice(0, 10);

function DestinoEntradas({ produtos }: { produtos: Array<{ id: string; name: string }> }) {
  const [de, setDe] = useState(isoAtras(60));
  const [ate, setAte] = useState(isoHoje());
  const [productId, setProductId] = useState<string>(TODOS);
  const [instanciaSel, setInstanciaSel] = useState<string>(TODOS);
  const [somenteAbertos, setSomenteAbertos] = useState(false);
  const [params, setParams] = useState<{ de: string; ate: string; productId: string | null; somenteAbertos: boolean } | null>(null);
  const [busca, setBusca] = useState("");
  const [situacoes, setSituacoes] = useState<string[]>([]);
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});

  const { data, isFetching, error } = useQuery<Destino>({
    queryKey: ["/api/destino-estoque", params],
    enabled: !!params,
    queryFn: () => {
      const p = new URLSearchParams({ de: params!.de, ate: params!.ate });
      if (params!.productId) p.set("productId", params!.productId);
      if (params!.somenteAbertos) p.set("somenteAbertos", "1");
      return fetch(`/api/destino-estoque?${p}`).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`); return r.json(); });
    },
  });
  const grupos = data?.grupos || [];
  const instancias = useMemo(() => Array.from(new Set(grupos.map(g => g.instancia))).sort(), [grupos]);
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return grupos.filter(g => {
      if (instanciaSel !== TODOS && g.instancia !== instanciaSel) return false;
      if (situacoes.length && !situacoes.includes(SIT[g.situacao].label)) return false;
      if (q && !`${g.produto} ${g.lote} ${g.entradas.map(e => e.ref).join(" ")} ${g.saidas.map(s => `${s.nfNumero ?? ""} ${s.destinatario ?? ""} ${s.pedido ?? ""}`).join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [grupos, instanciaSel, situacoes, busca]);
  const resumo = useMemo(() => {
    const r = { lotes: filtrados.length, divergentes: 0, emEstoque: 0, fechados: 0, entradas: 0, saidasNf: 0, saidasSemNf: 0, saldo: 0, naoExplicado: 0, nfs: new Set<string>() };
    for (const g of filtrados) {
      if (g.situacao === "divergente") r.divergentes++; else if (g.situacao === "em_estoque") r.emEstoque++; else r.fechados++;
      r.entradas += g.totais.entradas; r.saidasNf += g.totais.saidasNf; r.saidasSemNf += g.totais.saidasSemNf; r.saldo += g.totais.saldoEmUso + g.totais.saldoBloqueado; r.naoExplicado += g.totais.naoExplicado;
      for (const s of g.saidas) if (s.nfId) r.nfs.add(s.nfId);
    }
    return r;
  }, [filtrados]);

  const exportar = () => {
    const linhas: any[] = [];
    for (const g of filtrados) {
      for (const e of g.entradas) linhas.push({ "Instância": g.instancia, "Produto": g.produto, "Lote": g.lote, "Situação": SIT[g.situacao].label, "Movimento": "ENTRADA", "Tipo": ENTRADA_LABEL[e.tipo] || e.tipo, "Data": fmtDT(e.data), "Referência": e.ref, "Detalhe": e.detalhe, "Quantidade": e.quantidade, "NF saída": "", "Status NF": "", "CFOP": "", "Destinatário": "", "CNPJ/CPF": "", "Emissora": "", "Pedido": "" });
      for (const s of g.saidas) linhas.push({ "Instância": g.instancia, "Produto": g.produto, "Lote": g.lote, "Situação": SIT[g.situacao].label, "Movimento": "SAÍDA", "Tipo": s.tipo === "nf" ? (s.transferencia ? "NF transferência" : "NF saída") : s.tipo === "sem_nf" ? "BAIXA SEM NF" : "Ajuste (−)", "Data": fmtDT(s.data), "Referência": s.nfNumero != null ? `NF-e ${s.nfNumero}${s.nfSerie && s.nfSerie !== "1" ? "/" + s.nfSerie : ""}` : "", "Detalhe": s.detalhe, "Quantidade": -s.quantidade, "NF saída": s.nfNumero ?? "", "Status NF": s.nfStatus || "", "CFOP": s.cfop || "", "Destinatário": s.destinatario || "", "CNPJ/CPF": s.destinatarioDoc || "", "Emissora": s.instanciaEmissora || "", "Pedido": s.pedido || "" });
      linhas.push({ "Instância": g.instancia, "Produto": g.produto, "Lote": g.lote, "Situação": SIT[g.situacao].label, "Movimento": "SALDO ATUAL", "Tipo": `em uso ${g.totais.saldoEmUso} / bloqueado ${g.totais.saldoBloqueado}`, "Data": "", "Referência": "", "Detalhe": g.alertas.join("; "), "Quantidade": g.totais.saldoEmUso + g.totais.saldoBloqueado, "NF saída": "", "Status NF": "", "CFOP": "", "Destinatário": "", "CNPJ/CPF": "", "Emissora": "", "Pedido": "" });
      if (Math.abs(g.totais.naoExplicado) > 0.01) linhas.push({ "Instância": g.instancia, "Produto": g.produto, "Lote": g.lote, "Situação": SIT[g.situacao].label, "Movimento": "SEM DESTINO", "Tipo": "", "Data": "", "Referência": "", "Detalhe": "", "Quantidade": g.totais.naoExplicado, "NF saída": "", "Status NF": "", "CFOP": "", "Destinatário": "", "CNPJ/CPF": "", "Emissora": "", "Pedido": "" });
    }
    exportToExcel(linhas, `destino-entradas-${params?.de}-${params?.ate}`);
  };
  const toggleTodos = (v: boolean) => setAbertos(Object.fromEntries(filtrados.map(g => [g.chave, v])));

  return (
    <div className="space-y-4" data-testid="destino-entradas">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Destino das entradas de estoque</CardTitle>
          <CardDescription>Toda entrada (produção, transferência recebida, compra, estorno, ajuste) por lote e instância, com as notas fiscais de saída que consumiram cada uma, o saldo atual e o que ficou sem destino. Entradas − saídas − saldo deve dar zero.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-[auto_auto_2fr_auto_auto] items-end" onSubmit={e => { e.preventDefault(); setAbertos({}); setParams({ de, ate, productId: productId === TODOS ? null : productId, somenteAbertos }); }}>
            <div className="space-y-1"><Label className="text-xs">Entradas de</Label><Input type="date" value={de} onChange={e => setDe(e.target.value)} data-testid="input-destino-de" /></div>
            <div className="space-y-1"><Label className="text-xs">até</Label><Input type="date" value={ate} onChange={e => setAte(e.target.value)} data-testid="input-destino-ate" /></div>
            <div className="space-y-1">
              <Label className="text-xs">Produto</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger data-testid="select-produto-destino"><SelectValue placeholder="Todos os produtos" /></SelectTrigger>
                <SelectContent className="max-h-80"><SelectItem value={TODOS}>Todos os produtos</SelectItem>{produtos.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm h-10 whitespace-nowrap"><Checkbox checked={somenteAbertos} onCheckedChange={v => setSomenteAbertos(!!v)} />Só em estoque / divergentes</label>
            <Button type="submit" disabled={isFetching} data-testid="button-buscar-destino"><Search className="w-4 h-4 mr-2" />{isFetching ? "Buscando…" : "Conferir"}</Button>
          </form>
        </CardContent>
      </Card>

      {!params ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2"><PackageSearch className="h-8 w-8" />Escolha o período das entradas e clique em Conferir.</CardContent></Card>
      ) : error ? (
        <Card><CardContent className="p-8 text-center text-red-600">Erro: {(error as Error).message}</CardContent></Card>
      ) : isFetching && !data ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Cruzando entradas, baixas e notas fiscais…</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-2 grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
            <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Lotes</div><div className="text-xl font-bold">{resumo.lotes}</div><div className="text-[11px] text-muted-foreground">{resumo.fechados} fechados · {resumo.emEstoque} em estoque</div></CardContent></Card>
            <Card className={`py-0 ${resumo.divergentes ? "border-red-400" : ""}`}><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Divergentes</div><div className={`text-xl font-bold ${resumo.divergentes ? "text-red-700" : "text-green-700"}`}>{resumo.divergentes}</div></CardContent></Card>
            <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Unidades entradas</div><div className="text-xl font-bold">{fmtNum(resumo.entradas)}</div></CardContent></Card>
            <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Saídas com NF</div><div className="text-xl font-bold">{fmtNum(resumo.saidasNf)}</div><div className="text-[11px] text-muted-foreground">{resumo.nfs.size} NF-e</div></CardContent></Card>
            <Card className={`py-0 ${resumo.saidasSemNf ? "border-red-400" : ""}`}><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Baixas sem NF</div><div className={`text-xl font-bold ${resumo.saidasSemNf ? "text-red-700" : ""}`}>{fmtNum(resumo.saidasSemNf)}</div></CardContent></Card>
            <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Em estoque</div><div className="text-xl font-bold">{fmtNum(resumo.saldo)}</div></CardContent></Card>
            <Card className={`py-0 ${Math.abs(resumo.naoExplicado) > 0.5 ? "border-red-400" : "border-green-400"}`}><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Sem destino</div><div className={`text-xl font-bold ${Math.abs(resumo.naoExplicado) > 0.5 ? "text-red-700" : "text-green-700"}`}>{fmtNum(resumo.naoExplicado)}</div></CardContent></Card>
            <Card className="py-0"><CardContent className="p-3"><div className="text-[11px] text-muted-foreground">Período (entradas)</div><div className="text-sm font-semibold">{data?.de.split("-").reverse().join("/")} – {data?.ate.split("-").reverse().join("/")}</div></CardContent></Card>
          </div>

          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1 min-w-[220px]"><Label className="text-xs">Buscar produto / lote / NF / cliente</Label><Input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Filtrar…" /></div>
                <div className="space-y-1">
                  <Label className="text-xs">Instância</Label>
                  <Select value={instanciaSel} onValueChange={setInstanciaSel}><SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value={TODOS}>Todas</SelectItem>{instancias.map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent></Select>
                </div>
                <div className="min-w-[180px]"><MultiSelect label="Situação" options={["Divergente", "Em estoque", "Fechado"]} selected={situacoes} onChange={setSituacoes} testId="filtro-situacao-destino" /></div>
                <span className="text-sm text-muted-foreground ml-auto">{filtrados.length} lote(s)</span>
                <Button variant="outline" size="sm" onClick={() => toggleTodos(true)}>Expandir</Button>
                <Button variant="outline" size="sm" onClick={() => toggleTodos(false)}>Recolher</Button>
                <Button variant="outline" size="sm" onClick={exportar} disabled={!filtrados.length}><Download className="w-4 h-4 mr-2" />Exportar Excel</Button>
              </div>

              {filtrados.length === 0 ? <div className="p-8 text-center text-muted-foreground">Nenhuma entrada no período.</div> : (
                <div className="overflow-auto max-h-[70vh] border rounded">
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                      <tr className="text-left">
                        <th className="px-2 py-2 w-6"></th>
                        <th className="px-2 py-2 font-medium">Instância</th>
                        <th className="px-2 py-2 font-medium min-w-[200px]">Produto</th>
                        <th className="px-2 py-2 font-medium">Lote</th>
                        <th className="px-2 py-2 font-medium">1ª entrada</th>
                        <th className="px-2 py-2 font-medium text-right">Entradas</th>
                        <th className="px-2 py-2 font-medium text-right">Saídas c/ NF</th>
                        <th className="px-2 py-2 font-medium text-right">Sem NF</th>
                        <th className="px-2 py-2 font-medium text-right">Ajustes −</th>
                        <th className="px-2 py-2 font-medium text-right">Saldo</th>
                        <th className="px-2 py-2 font-medium text-right">Sem destino</th>
                        <th className="px-2 py-2 font-medium">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtrados.map(g => {
                        const ab = !!abertos[g.chave];
                        const st = SIT[g.situacao];
                        return (
                          <Fragment key={g.chave}>
                            <tr className={`border-t cursor-pointer hover:bg-muted/30 ${g.situacao === "divergente" ? "bg-red-50/40 dark:bg-red-950/10" : ""}`} onClick={() => setAbertos(a => ({ ...a, [g.chave]: !ab }))} data-testid={`linha-destino-${g.lote}`}>
                              <td className="px-2 py-1.5 text-muted-foreground">{ab ? "▾" : "▸"}</td>
                              <td className="px-2 py-1.5"><Badge variant="outline">{g.instancia}</Badge></td>
                              <td className="px-2 py-1.5 font-medium">{g.produto}</td>
                              <td className="px-2 py-1.5"><code className="bg-muted px-1.5 py-0.5 rounded">{g.lote}</code></td>
                              <td className="px-2 py-1.5 whitespace-nowrap">{g.primeiraEntrada ? fmtData(g.primeiraEntrada) : "—"}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtNum(g.totais.entradas)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(g.totais.saidasNf)}</td>
                              <td className={`px-2 py-1.5 text-right tabular-nums ${g.totais.saidasSemNf ? "text-red-700 font-semibold" : "text-muted-foreground"}`}>{fmtNum(g.totais.saidasSemNf)}</td>
                              <td className={`px-2 py-1.5 text-right tabular-nums ${g.totais.ajustesNeg ? "text-amber-700" : "text-muted-foreground"}`}>{fmtNum(g.totais.ajustesNeg)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums" title={`em uso ${fmtNum(g.totais.saldoEmUso)} · bloqueado ${fmtNum(g.totais.saldoBloqueado)}`}>{fmtNum(g.totais.saldoEmUso + g.totais.saldoBloqueado)}{g.totais.saldoBloqueado > 0 && <span className="text-[10px] text-amber-700 ml-1">({fmtNum(g.totais.saldoBloqueado)} bloq.)</span>}</td>
                              <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${Math.abs(g.totais.naoExplicado) > 0.01 ? "text-red-700" : "text-green-700"}`}>{fmtNum(g.totais.naoExplicado)}</td>
                              <td className="px-2 py-1.5"><Badge className={`${st.cls} text-[11px]`}>{st.label}</Badge></td>
                            </tr>
                            {ab && (
                              <tr className="border-t bg-muted/20">
                                <td></td>
                                <td colSpan={11} className="px-2 py-2">
                                  {g.alertas.length > 0 && <div className="mb-2 space-y-1">{g.alertas.map((a, i) => <div key={i} className="text-xs rounded border border-red-300 bg-red-50 text-red-900 px-2 py-1">{a}</div>)}</div>}
                                  <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
                                    <div>
                                      <div className="text-xs font-semibold mb-1">ENTRADAS ({fmtNum(g.totais.entradas)})</div>
                                      <table className="w-full text-xs"><tbody>
                                        {g.entradas.map((e, i) => (
                                          <tr key={i} className="border-t">
                                            <td className="py-1 pr-2 whitespace-nowrap">{fmtDT(e.data)}</td>
                                            <td className="py-1 pr-2">{ENTRADA_LABEL[e.tipo] || e.tipo}</td>
                                            <td className="py-1 pr-2 font-medium whitespace-nowrap">{e.ref}</td>
                                            <td className="py-1 pr-2 text-muted-foreground truncate max-w-[260px]" title={e.detalhe}>{e.detalhe}</td>
                                            <td className="py-1 text-right tabular-nums font-semibold text-green-700">+{fmtNum(e.quantidade)}</td>
                                          </tr>
                                        ))}
                                      </tbody></table>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold mb-1">SAÍDAS — notas fiscais ({fmtNum(g.totais.saidasNf + g.totais.saidasSemNf + g.totais.ajustesNeg)})</div>
                                      {g.saidas.length === 0 ? <div className="text-xs text-muted-foreground">Nenhuma saída ainda.</div> : (
                                        <table className="w-full text-xs"><tbody>
                                          {g.saidas.map((s, i) => (
                                            <tr key={i} className={`border-t ${s.tipo === "sem_nf" ? "bg-red-50" : ""}`}>
                                              <td className="py-1 pr-2 whitespace-nowrap">{fmtDT(s.data)}</td>
                                              <td className="py-1 pr-2 whitespace-nowrap font-medium">
                                                {s.tipo === "ajuste" ? <span className="text-amber-700">Ajuste (−)</span>
                                                  : s.nfNumero != null ? <a className="underline text-primary" href={`/api/contabilidade/fiscal/nota/${s.nfId}/danfe`} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()}>NF-e {s.nfNumero}{s.nfSerie && s.nfSerie !== "1" ? `/${s.nfSerie}` : ""}</a>
                                                  : <span className="text-red-700">SEM NF</span>}
                                                {s.tipo === "sem_nf" && s.nfNumero != null && <span className="ml-1 text-red-700">[{s.nfStatus}]</span>}
                                                {s.transferencia && <Badge className="ml-1 bg-blue-100 text-blue-800 text-[10px] py-0">transf.</Badge>}
                                                {s.nfTemLote === false && <span className="ml-1 text-amber-700" title="A NF não traz este lote no item">⚠ lote fora da NF</span>}
                                              </td>
                                              <td className="py-1 pr-2 whitespace-nowrap">{s.cfop || ""}{s.instanciaEmissora ? ` · ${s.instanciaEmissora}` : ""}</td>
                                              <td className="py-1 pr-2 truncate max-w-[260px]" title={`${s.destinatario || ""} ${s.destinatarioDoc || ""} ${s.detalhe}`}>{s.destinatario || s.detalhe}{s.pedido ? <span className="text-muted-foreground"> · {s.pedido}</span> : null}</td>
                                              <td className="py-1 text-right tabular-nums font-semibold text-red-700">−{fmtNum(s.quantidade)}</td>
                                            </tr>
                                          ))}
                                        </tbody></table>
                                      )}
                                      <div className="mt-1 text-xs text-muted-foreground">Saldo atual: em uso {fmtNum(g.totais.saldoEmUso)} · bloqueado {fmtNum(g.totais.saldoBloqueado)} · <b className={Math.abs(g.totais.naoExplicado) > 0.01 ? "text-red-700" : "text-green-700"}>sem destino {fmtNum(g.totais.naoExplicado)}</b></div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export default function RastreabilidadeLote() {
  const [productId, setProductId] = useState<string>(TODOS);
  const [loteDigitado, setLoteDigitado] = useState("");
  const [incluirCanceladas, setIncluirCanceladas] = useState(false);
  const [consulta, setConsulta] = useState<{ lote: string; productId: string | null; canc: boolean } | null>(null);
  const [instancias, setInstancias] = useState<string[]>([]);
  const [tipos, setTipos] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [visao, setVisao] = useState<"notas" | "tempo" | "destino">("notas");

  const pid = productId === TODOS ? null : productId;
  const { data: opcoes } = useQuery<{ produtos: Array<{ id: string; name: string }>; lotes: string[] }>({
    queryKey: ["/api/rastreabilidade-lote/opcoes", pid],
    queryFn: () => fetch(`/api/rastreabilidade-lote/opcoes${pid ? `?productId=${encodeURIComponent(pid)}` : ""}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    staleTime: 5 * 60_000,
  });

  const { data, isFetching, error } = useQuery<{ geradoEm: string; lote: string; linhas: Linha[] }>({
    queryKey: ["/api/rastreabilidade-lote", consulta],
    enabled: !!consulta,
    queryFn: () => {
      const p = new URLSearchParams({ lote: consulta!.lote });
      if (consulta!.productId) p.set("productId", consulta!.productId);
      if (consulta!.canc) p.set("incluirCanceladas", "1");
      return fetch(`/api/rastreabilidade-lote?${p}`).then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`);
        return r.json();
      });
    },
  });
  const linhas = data?.linhas || [];

  const buscar = () => {
    const lote = loteDigitado.trim();
    if (lote.length < 2) return;
    setInstancias([]); setTipos([]); setBusca("");
    setConsulta({ lote, productId: pid, canc: incluirCanceladas });
  };

  const opcoesFiltro = useMemo(() => ({
    instancias: Array.from(new Set(linhas.map(l => l.instancia))).sort(),
    tipos: Array.from(new Set(linhas.map(tipoNf))).sort(),
  }), [linhas]);

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return linhas.filter(l => {
      if (instancias.length && !instancias.includes(l.instancia)) return false;
      if (tipos.length && !tipos.includes(tipoNf(l))) return false;
      if (q && !`${l.cliente} ${l.clienteDoc} ${l.numero ?? ""} ${l.cidade} ${l.produto}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [linhas, instancias, tipos, busca]);

  // Resumo: só NFs não canceladas entram nos totais de quantidade.
  const resumo = useMemo(() => {
    const nfs = new Set<string>(), clientes = new Set<string>();
    let saida = 0, devolvido = 0, semQtd = 0;
    const porInst = new Map<string, { nfs: Set<string>; qtd: number }>();
    for (const l of filtradas) {
      nfs.add(l.invoiceId);
      if (l.tipo === "saida") clientes.add(l.clienteDoc || l.cliente);
      if (l.status === "cancelled") continue;
      if (l.qtdLote == null) { semQtd++; continue; }
      if (l.sinal > 0) saida += l.qtdLote; else devolvido += l.qtdLote;
      const pi = porInst.get(l.instancia) || { nfs: new Set<string>(), qtd: 0 };
      pi.nfs.add(l.invoiceId); pi.qtd += l.sinal * l.qtdLote; porInst.set(l.instancia, pi);
    }
    return { nfs: nfs.size, clientes: clientes.size, saida, devolvido, semQtd, porInst: Array.from(porInst.entries()).sort((a, b) => b[1].qtd - a[1].qtd) };
  }, [filtradas]);

  const exportar = () => {
    exportToExcel(filtradas.map(l => ({
      "Data": fmtData(l.data),
      "NF": l.numero ?? "",
      "Série": l.serie,
      "Instância emissora": l.instancia,
      "Tipo": tipoNf(l),
      "Entrada/Saída": l.tipo === "entrada" ? "Entrada" : "Saída",
      "CFOP": l.cfop,
      "Natureza": l.natureza,
      "Status": STATUS_LABEL[l.status]?.label || l.status,
      "Cliente / Destinatário": l.cliente,
      "CNPJ/CPF": l.clienteDoc,
      "Cidade/UF": l.cidade,
      "Produto": l.produto,
      "Lote": l.lote,
      "Qtd do lote": l.qtdLote ?? "",
      "Qtd do item": l.qtdItem,
      "Lotes no item": l.lotesDoItem,
      "Chave de acesso": l.chave,
    })), `rastreabilidade-lote-${data?.lote || "lote"}`);
  };

  const nomeProduto = pid ? opcoes?.produtos.find(p => p.id === pid)?.name : null;

  return (
    <div className="space-y-4" data-testid="rastreabilidade-lote">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg"><PackageSearch className="h-5 w-5" />Rastreabilidade de Lote</CardTitle>
          <CardDescription>
            Todas as notas fiscais faturadas que levaram o lote informado, com a instância que emitiu cada nota.
            Transferências entre estabelecimentos não entram; vendas, trocas, amostras, bonificações e devoluções de venda entram.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="grid gap-3 md:grid-cols-[2fr_1fr_auto_auto] items-end" onSubmit={e => { e.preventDefault(); buscar(); }}>
            <div className="space-y-1">
              <Label className="text-xs">Produto</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger data-testid="select-produto-rastreio"><SelectValue placeholder="Todos os produtos" /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={TODOS}>Todos os produtos</SelectItem>
                  {(opcoes?.produtos || []).map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Lote</Label>
              <Input
                list="rastreio-lotes" placeholder="Ex.: H051026" value={loteDigitado}
                onChange={e => setLoteDigitado(e.target.value.toUpperCase())} data-testid="input-lote-rastreio"
              />
              <datalist id="rastreio-lotes">
                {(opcoes?.lotes || []).map(l => <option key={l} value={l} />)}
              </datalist>
            </div>
            <label className="flex items-center gap-2 text-sm h-10 whitespace-nowrap">
              <Checkbox checked={incluirCanceladas} onCheckedChange={v => setIncluirCanceladas(!!v)} data-testid="check-incluir-canceladas" />
              Incluir canceladas
            </label>
            <Button type="submit" disabled={loteDigitado.trim().length < 2 || isFetching} data-testid="button-buscar-rastreio">
              <Search className="w-4 h-4 mr-2" />{isFetching ? "Buscando…" : "Rastrear"}
            </Button>
          </form>
          <div className="flex gap-1">
            <Button type="button" size="sm" variant={visao === "notas" ? "default" : "outline"} onClick={() => setVisao("notas")} data-testid="button-visao-notas">Notas fiscais (vendas)</Button>
            <Button type="button" size="sm" variant={visao === "tempo" ? "default" : "outline"} onClick={() => setVisao("tempo")} data-testid="button-visao-tempo">Linha do tempo: produção → destino</Button>
            <Button type="button" size="sm" variant={visao === "destino" ? "default" : "outline"} onClick={() => setVisao("destino")} data-testid="button-visao-destino">Destino de todas as entradas</Button>
          </div>
        </CardContent>
      </Card>

      {visao === "destino" ? (
        <DestinoEntradas produtos={opcoes?.produtos || []} />
      ) : !consulta ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
          <PackageSearch className="h-8 w-8" />Escolha o produto, informe o lote e clique em Rastrear.
        </CardContent></Card>
      ) : visao === "tempo" ? (
        <LinhaDoTempo consulta={{ lote: consulta.lote, productId: consulta.productId }} />
      ) : error ? (
        <Card><CardContent className="p-8 text-center text-red-600">Erro ao consultar: {(error as Error).message}</CardContent></Card>
      ) : isFetching && !data ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Buscando notas…</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-2 grid-cols-2 md:grid-cols-5">
            <Card className="py-0"><CardContent className="p-3">
              <div className="text-[11px] text-muted-foreground">Lote{consulta.productId && nomeProduto ? ` · ${nomeProduto}` : ""}</div>
              <div className="text-xl font-bold" data-testid="resumo-lote">{data?.lote}</div>
            </CardContent></Card>
            <Card className="py-0"><CardContent className="p-3">
              <div className="text-[11px] text-muted-foreground">Notas fiscais</div>
              <div className="text-xl font-bold" data-testid="resumo-nfs">{fmtNum(resumo.nfs)}</div>
            </CardContent></Card>
            <Card className="py-0"><CardContent className="p-3">
              <div className="text-[11px] text-muted-foreground">Clientes atingidos</div>
              <div className="text-xl font-bold" data-testid="resumo-clientes">{fmtNum(resumo.clientes)}</div>
            </CardContent></Card>
            <Card className="py-0"><CardContent className="p-3">
              <div className="text-[11px] text-muted-foreground">Unidades saídas</div>
              <div className="text-xl font-bold" data-testid="resumo-saida">{fmtNum(resumo.saida)}</div>
              {resumo.devolvido > 0 && <div className="text-[11px] text-muted-foreground">− {fmtNum(resumo.devolvido)} devolvidas · líquido {fmtNum(resumo.saida - resumo.devolvido)}</div>}
            </CardContent></Card>
            <Card className="py-0"><CardContent className="p-3">
              <div className="text-[11px] text-muted-foreground mb-1">Por instância emissora (líquido)</div>
              <div className="flex flex-wrap gap-1">
                {resumo.porInst.map(([inst, v]) => (
                  <Badge key={inst} variant="secondary" className="text-[11px]">{inst}: {fmtNum(v.qtd)} · {v.nfs.size} NF</Badge>
                ))}
              </div>
            </CardContent></Card>
          </div>
          {resumo.semQtd > 0 && (
            <p className="text-xs text-amber-700">
              {resumo.semQtd} item(ns) de notas antigas trazem mais de um lote sem a quantidade de cada um — aparecem na lista, mas não entram nas somas (veja a coluna "Qtd do item").
            </p>
          )}

          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1 min-w-[220px]">
                  <Label className="text-xs">Buscar cliente / NF / cidade</Label>
                  <Input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Filtrar…" data-testid="input-busca-rastreio" />
                </div>
                <div className="min-w-[180px]"><MultiSelect label="Instância" options={opcoesFiltro.instancias} selected={instancias} onChange={setInstancias} testId="filtro-instancia-rastreio" /></div>
                <div className="min-w-[180px]"><MultiSelect label="Tipo de NF" options={opcoesFiltro.tipos} selected={tipos} onChange={setTipos} testId="filtro-tipo-rastreio" /></div>
                <span className="text-sm text-muted-foreground ml-auto">{filtradas.length} linha(s)</span>
                <Button variant="outline" size="sm" onClick={exportar} disabled={!filtradas.length} data-testid="button-export-rastreio">
                  <Download className="w-4 h-4 mr-2" />Exportar Excel
                </Button>
              </div>

              {filtradas.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">Nenhuma nota fiscal encontrada com esse lote.</div>
              ) : (
                <div className="overflow-auto max-h-[65vh] border rounded">
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                      <tr className="text-left">
                        <th className="px-2 py-2 font-medium">Data</th>
                        <th className="px-2 py-2 font-medium">NF</th>
                        <th className="px-2 py-2 font-medium">Instância</th>
                        <th className="px-2 py-2 font-medium">Tipo</th>
                        <th className="px-2 py-2 font-medium">CFOP</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium min-w-[200px]">Cliente / Destinatário</th>
                        <th className="px-2 py-2 font-medium">Cidade/UF</th>
                        <th className="px-2 py-2 font-medium min-w-[200px]">Produto</th>
                        <th className="px-2 py-2 font-medium text-right">Qtd lote</th>
                        <th className="px-2 py-2 font-medium text-right">Qtd item</th>
                        <th className="px-2 py-2 font-medium">DANFE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtradas.map((l, i) => {
                        const st = STATUS_LABEL[l.status] || { label: l.status, cls: "" };
                        return (
                          <tr key={`${l.invoiceId}-${i}`} className={`border-t hover:bg-muted/30 ${l.status === "cancelled" ? "opacity-60" : ""}`} data-testid={`linha-rastreio-${l.numero}`}>
                            <td className="px-2 py-1.5 whitespace-nowrap">{fmtData(l.data)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap font-medium" title={l.chave}>{l.numero ?? "—"}{l.serie && l.serie !== "1" ? `/${l.serie}` : ""}</td>
                            <td className="px-2 py-1.5"><Badge variant="outline">{l.instancia}</Badge></td>
                            <td className="px-2 py-1.5 whitespace-nowrap" title={l.natureza}>{tipoNf(l)}</td>
                            <td className="px-2 py-1.5">{l.cfop}</td>
                            <td className="px-2 py-1.5"><Badge className={`${st.cls} text-[11px]`}>{st.label}</Badge></td>
                            <td className="px-2 py-1.5">
                              <div>{l.cliente}</div>
                              <div className="text-[11px] text-muted-foreground">{l.clienteDoc}</div>
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{l.cidade}</td>
                            <td className="px-2 py-1.5" title={l.lotesDoItem ? `Lotes no item: ${l.lotesDoItem}` : ""}>{l.produto}</td>
                            <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${l.sinal < 0 ? "text-amber-700" : ""}`}>
                              {l.qtdLote == null ? "?" : `${l.sinal < 0 ? "−" : ""}${fmtNum(l.qtdLote)}`}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(l.qtdItem)}</td>
                            <td className="px-2 py-1.5">
                              <a href={`/api/contabilidade/fiscal/nota/${l.invoiceId}/danfe`} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center" title="Baixar DANFE">
                                <FileDown className="h-4 w-4" />
                              </a>
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
        </>
      )}
    </div>
  );
}
