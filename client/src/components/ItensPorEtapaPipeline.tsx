import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, RefreshCw, Package, Layers } from "lucide-react";
import { MultiSelect, exportToExcel } from "@/lib/tableTools";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * RELATÓRIO "ITENS POR ETAPA" (20/out/2026)
 * Quantidade de itens, por produto, somada sobre todos os pedidos de cada etapa do
 * Pipeline de Faturamento. Dados vêm agregados de GET /api/billing-pipeline/itens-por-etapa
 * (grão etapa × produto × instância × vendedor × tipo de operação) e TODO o pivô/filtro é
 * feito aqui — por isso é dinâmico: mudar filtro não bate no servidor.
 */

interface Row {
  stage: string;
  instId: string;
  instName: string;
  seller: string;
  op: string;
  productId: string | null;
  productName: string;
  qty: number;
  valor: number;
  pedidos: number;
}

// Mesma ordem e rótulos do board do Pipeline (BillingPipeline.tsx → STAGES), sem a Lixeira.
const STAGES: Array<{ key: string; label: string; badge: string }> = [
  { key: "bloqueado", label: "Bloqueados", badge: "bg-red-100 text-red-800" },
  { key: "agendado", label: "Agendado", badge: "bg-cyan-100 text-cyan-800" },
  { key: "pedido", label: "Pedido", badge: "bg-blue-100 text-blue-800" },
  { key: "a_faturar", label: "A Faturar", badge: "bg-yellow-100 text-yellow-800" },
  { key: "faturado", label: "Faturado", badge: "bg-orange-100 text-orange-800" },
  { key: "impresso", label: "Impresso", badge: "bg-purple-100 text-purple-800" },
  { key: "bsb", label: "BSB", badge: "bg-pink-100 text-pink-800" },
  { key: "aguardando_rota_bsb", label: "Ag. Rota BSB", badge: "bg-teal-100 text-teal-800" },
  { key: "em_rota_bsb", label: "Em Rota BSB", badge: "bg-sky-100 text-sky-800" },
  { key: "outras_cidades", label: "Outras Cidades", badge: "bg-violet-100 text-violet-800" },
  { key: "aguardando_rota", label: "Aguardando Rota", badge: "bg-gray-100 text-gray-800" },
  { key: "em_rota", label: "Em Rota", badge: "bg-indigo-100 text-indigo-800" },
  { key: "entregue", label: "Entregue", badge: "bg-green-100 text-green-800" },
];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map(s => [s.key, s.label]));
const OP_LABEL: Record<string, string> = {
  venda: "Venda", troca: "Troca", amostra: "Amostra", bonificacao: "Bonificação", transferencia: "Transferência", "": "(sem tipo)",
};

// Chave do produto: sem acento e minúscula — pedidos antigos gravaram "LIMAO" e "LIMÃO" para o mesmo item.
const chaveProduto = (nome: string) => nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const fmtInt = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString("pt-BR");
const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

type Metrica = "qty" | "pedidos" | "valor";

export default function ItensPorEtapaPipeline() {
  const [diasEntregue, setDiasEntregue] = useState<string>("0");
  const [etapas, setEtapas] = useState<string[]>([]);
  const [instancias, setInstancias] = useState<string[]>([]);
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [tipos, setTipos] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [metrica, setMetrica] = useState<Metrica>("qty");

  const dias = Math.max(0, parseInt(diasEntregue || "0", 10) || 0);
  const { data, isLoading, isFetching, refetch, error } = useQuery<{ geradoEm: string; diasEntregue: number; rows: Row[] }>({
    queryKey: ["/api/billing-pipeline/itens-por-etapa", dias],
    queryFn: () => fetch(`/api/billing-pipeline/itens-por-etapa?diasEntregue=${dias}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    staleTime: 60_000,
  });
  const rows = data?.rows || [];

  // Opções dos filtros — só o que existe nos dados.
  const opcoes = useMemo(() => {
    const inst = new Map<string, string>();
    const vend = new Set<string>();
    const ops = new Set<string>();
    for (const r of rows) {
      inst.set(r.instName || "(sem instância)", r.instName || "(sem instância)");
      vend.add(r.seller || "(sem vendedor)");
      ops.add(OP_LABEL[r.op] || r.op);
    }
    const etapasPresentes = STAGES.filter(s => rows.some(r => r.stage === s.key)).map(s => s.label);
    return {
      etapas: etapasPresentes,
      instancias: Array.from(inst.keys()).sort(),
      vendedores: Array.from(vend).sort(),
      tipos: Array.from(ops).sort(),
    };
  }, [rows]);

  // Filtro
  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return rows.filter(r => {
      if (etapas.length && !etapas.includes(STAGE_LABEL[r.stage] || r.stage)) return false;
      if (instancias.length && !instancias.includes(r.instName || "(sem instância)")) return false;
      if (vendedores.length && !vendedores.includes(r.seller || "(sem vendedor)")) return false;
      if (tipos.length && !tipos.includes(OP_LABEL[r.op] || r.op)) return false;
      if (q && !chaveProduto(r.productName).includes(chaveProduto(q))) return false;
      return true;
    });
  }, [rows, etapas, instancias, vendedores, tipos, busca]);

  // Pivô: produto (linha) × etapa (coluna)
  const pivo = useMemo(() => {
    const colunas = STAGES.filter(s => (etapas.length ? etapas.includes(s.label) : true) && filtradas.some(r => r.stage === s.key));
    const porProduto = new Map<string, { nome: string; porEtapa: Record<string, { qty: number; pedidos: number; valor: number }>; total: { qty: number; pedidos: number; valor: number } }>();
    for (const r of filtradas) {
      const k = chaveProduto(r.productName);
      let p = porProduto.get(k);
      if (!p) { p = { nome: r.productName, porEtapa: {}, total: { qty: 0, pedidos: 0, valor: 0 } }; porProduto.set(k, p); }
      const c = p.porEtapa[r.stage] || (p.porEtapa[r.stage] = { qty: 0, pedidos: 0, valor: 0 });
      c.qty += r.qty; c.pedidos += r.pedidos; c.valor += r.valor;
      p.total.qty += r.qty; p.total.pedidos += r.pedidos; p.total.valor += r.valor;
    }
    const linhas = Array.from(porProduto.values()).sort((a, b) => b.total.qty - a.total.qty || a.nome.localeCompare(b.nome));
    // Totais por etapa: só quantidade e valor. "Nº de pedidos" é COUNT(DISTINCT card) por produto;
    // somar entre produtos contaria o mesmo pedido várias vezes, então não totalizamos pedidos.
    const totalEtapa: Record<string, { qty: number; valor: number }> = {};
    for (const c of colunas) {
      totalEtapa[c.key] = { qty: 0, valor: 0 };
      for (const l of linhas) { const v = l.porEtapa[c.key]; if (v) { totalEtapa[c.key].qty += v.qty; totalEtapa[c.key].valor += v.valor; } }
    }
    const geral = { qty: 0, valor: 0 };
    for (const l of linhas) { geral.qty += l.total.qty; geral.valor += l.total.valor; }
    return { colunas, linhas, totalEtapa, geral };
  }, [filtradas, etapas]);

  const fmt = (v: { qty: number; pedidos: number; valor: number } | undefined) => {
    if (!v) return "";
    if (metrica === "qty") return fmtInt(v.qty);
    if (metrica === "pedidos") return fmtInt(v.pedidos);
    return fmtBRL(v.valor);
  };

  const exportar = () => {
    const linhas = pivo.linhas.map(l => {
      const o: Record<string, any> = { Produto: l.nome };
      for (const c of pivo.colunas) o[c.label] = metrica === "valor" ? (l.porEtapa[c.key]?.valor || 0) : metrica === "pedidos" ? (l.porEtapa[c.key]?.pedidos || 0) : (l.porEtapa[c.key]?.qty || 0);
      o["Total"] = metrica === "valor" ? l.total.valor : metrica === "pedidos" ? l.total.pedidos : l.total.qty;
      return o;
    });
    exportToExcel(linhas, `itens-por-etapa-${metrica}`);
  };

  const limpar = () => { setEtapas([]); setInstancias([]); setVendedores([]); setTipos([]); setBusca(""); };
  const filtrosAtivos = etapas.length + instancias.length + vendedores.length + tipos.length + (busca ? 1 : 0);

  return (
    <div className="space-y-4" data-testid="itens-por-etapa">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg"><Layers className="h-5 w-5" />Itens por Etapa do Pipeline</CardTitle>
              <CardDescription>
                Quantidade de itens, por produto, somando todos os pedidos que estão em cada etapa do Pipeline de Faturamento — em tempo real.
                {data?.geradoEm && <> Gerado às {new Date(data.geradoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.</>}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-itens-etapa">
                <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
              <Button variant="outline" size="sm" onClick={exportar} disabled={!pivo.linhas.length} data-testid="button-export-itens-etapa">
                <Download className="w-4 h-4 mr-2" />Exportar Excel
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1">
              <Label className="text-xs">Produto</Label>
              <Input placeholder="Buscar produto…" value={busca} onChange={e => setBusca(e.target.value)} data-testid="input-busca-produto" />
            </div>
            <MultiSelect label="Etapa" options={opcoes.etapas} selected={etapas} onChange={setEtapas} testId="filtro-etapa" />
            <MultiSelect label="Instância" options={opcoes.instancias} selected={instancias} onChange={setInstancias} testId="filtro-instancia" />
            <MultiSelect label="Vendedor" options={opcoes.vendedores} selected={vendedores} onChange={setVendedores} testId="filtro-vendedor" searchable />
            <MultiSelect label="Tipo de operação" options={opcoes.tipos} selected={tipos} onChange={setTipos} testId="filtro-tipo" />
            <div className="space-y-1">
              <Label className="text-xs">Mostrar</Label>
              <Select value={metrica} onValueChange={v => setMetrica(v as Metrica)}>
                <SelectTrigger data-testid="select-metrica"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="qty">Quantidade de itens</SelectItem>
                  <SelectItem value="pedidos">Nº de pedidos</SelectItem>
                  <SelectItem value="valor">Valor (R$)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap">Incluir "Entregue" dos últimos</Label>
              <Select value={diasEntregue} onValueChange={setDiasEntregue}>
                <SelectTrigger className="h-8 w-36" data-testid="select-dias-entregue"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">não incluir</SelectItem>
                  <SelectItem value="1">1 dia</SelectItem>
                  <SelectItem value="7">7 dias</SelectItem>
                  <SelectItem value="30">30 dias</SelectItem>
                  <SelectItem value="90">90 dias</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {filtrosAtivos > 0 && (
              <Button variant="ghost" size="sm" onClick={limpar} data-testid="button-limpar-filtros">Limpar filtros ({filtrosAtivos})</Button>
            )}
            <span className="text-muted-foreground ml-auto">
              {pivo.linhas.length} produto(s) · {pivo.colunas.length} etapa(s) · {fmtInt(pivo.geral.qty)} itens · {fmtBRL(pivo.geral.valor)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Resumo por etapa */}
      {pivo.colunas.length > 0 && (
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
          {pivo.colunas.map(c => (
            <Card key={c.key} className="py-0">
              <CardContent className="p-3">
                <Badge className={`${c.badge} text-[11px]`}>{c.label}</Badge>
                <div className="text-xl font-bold mt-1" data-testid={`total-etapa-${c.key}`}>{fmtInt(pivo.totalEtapa[c.key]?.qty || 0)}</div>
                <div className="text-[11px] text-muted-foreground">itens · {fmtBRL(pivo.totalEtapa[c.key]?.valor || 0)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Carregando…</div>
          ) : error ? (
            <div className="p-8 text-center text-red-600">Erro ao carregar: {(error as Error).message}</div>
          ) : pivo.linhas.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground flex flex-col items-center gap-2">
              <Package className="h-8 w-8" />Nenhum item nas etapas selecionadas.
            </div>
          ) : (
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium sticky left-0 bg-background min-w-[220px]">Produto</th>
                    {pivo.colunas.map(c => (
                      <th key={c.key} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                        <Badge className={`${c.badge} text-[11px] font-medium`}>{c.label}</Badge>
                      </th>
                    ))}
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap bg-muted/40">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pivo.linhas.map(l => (
                    <tr key={l.nome} className="border-t hover:bg-muted/30" data-testid={`linha-produto-${l.nome}`}>
                      <td className="px-3 py-1.5 sticky left-0 bg-background font-medium">{l.nome}</td>
                      {pivo.colunas.map(c => {
                        const v = l.porEtapa[c.key];
                        return (
                          <td key={c.key} className={`px-3 py-1.5 text-right tabular-nums ${v ? "" : "text-muted-foreground/40"}`} title={v ? `${fmtInt(v.qty)} itens em ${fmtInt(v.pedidos)} pedido(s) · ${fmtBRL(v.valor)}` : ""}>
                            {v ? fmt(v) : "–"}
                          </td>
                        );
                      })}
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold bg-muted/40">{fmt(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-muted/60 backdrop-blur">
                  <tr className="border-t-2 font-semibold">
                    <td className="px-3 py-2 sticky left-0 bg-muted/60">Total</td>
                    {pivo.colunas.map(c => (
                      <td key={c.key} className="px-3 py-2 text-right tabular-nums">
                        {metrica === "valor" ? fmtBRL(pivo.totalEtapa[c.key]?.valor || 0) : metrica === "qty" ? fmtInt(pivo.totalEtapa[c.key]?.qty || 0) : ""}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {metrica === "valor" ? fmtBRL(pivo.geral.valor) : metrica === "qty" ? fmtInt(pivo.geral.qty) : ""}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
