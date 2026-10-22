import { useMemo, useState } from "react";
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

export default function RastreabilidadeLote() {
  const [productId, setProductId] = useState<string>(TODOS);
  const [loteDigitado, setLoteDigitado] = useState("");
  const [incluirCanceladas, setIncluirCanceladas] = useState(false);
  const [consulta, setConsulta] = useState<{ lote: string; productId: string | null; canc: boolean } | null>(null);
  const [instancias, setInstancias] = useState<string[]>([]);
  const [tipos, setTipos] = useState<string[]>([]);
  const [busca, setBusca] = useState("");

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
        </CardContent>
      </Card>

      {!consulta ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
          <PackageSearch className="h-8 w-8" />Escolha o produto, informe o lote e clique em Rastrear.
        </CardContent></Card>
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
