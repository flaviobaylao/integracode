import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ComposedChart, Bar, Line, BarChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Download, Info, Search } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";
import { useAuth } from "@/hooks/useAuth";

// Aba "Dossiê do vendedor" da Gestão de Carteiras.
// Dados: /api/reports/dossie-vendedores?ano=AAAA (todos os vendedores de uma vez;
// o seletor escolhe "Toda a Honest", um vendedor ou "Sem vendedor").

const TODA = "__toda__";
const SEM = "__sem__";
const MESES_ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const rotMes = (m: string) => `${MESES_ABREV[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const brl = (v: number) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const curto = (v: number) => {
  const a = Math.abs(v || 0);
  if (a >= 1e6) return `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
  return (v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
};
const dataBR = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const norm = (s: string) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function Kpi({ titulo, valor, sub, cor = "text-slate-900" }: { titulo: string; valor: string; sub?: string; cor?: string }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className={`text-xl font-bold ${cor}`}>{valor}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default function DossieVendedor() {
  const { user } = useAuth() as any;
  const podeAjustar = ["admin", "coordinator", "administrative"].includes(String(user?.role || ""));
  const anoAtual = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date()));
  const [ano, setAno] = useState(anoAtual);
  const [sel, setSel] = useState<string>(TODA);
  const [busca, setBusca] = useState("");
  const [limite, setLimite] = useState(100);
  const [dataAjuste, setDataAjuste] = useState("");
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/reports/dossie-vendedores", ano],
    queryFn: async () => {
      const r = await fetch(`/api/reports/dossie-vendedores?ano=${ano}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const vendedores: any[] = data?.vendedores || [];
  const semVendedor: any[] = data?.semVendedor || [];
  const meses: string[] = data?.meses || [];
  const mesCorrente: string = data?.mesCorrente || "";
  const selecionado = useMemo(() => {
    if (data?.restrito && vendedores.length === 1) return vendedores[0];
    return vendedores.find((v) => v.id === sel) || null;
  }, [vendedores, sel, data]);
  const modo = data?.restrito ? "vend" : sel === TODA ? "toda" : sel === SEM ? "sem" : "vend";

  // ── consolidado: toda a Honest ou um vendedor ─────────────────────────────
  const consolidado = useMemo(() => {
    const vs = modo === "vend" ? (selecionado ? [selecionado] : []) : modo === "toda" ? vendedores : [];
    const soma = (f: (v: any) => number) => vs.reduce((s, v) => s + (f(v) || 0), 0);
    const somaMes = (campo: string) => {
      const out: Record<string, number> = {};
      for (const v of vs) for (const [m, val] of Object.entries(v[campo] || {})) out[m] = (out[m] || 0) + Number(val);
      return out;
    };
    const vendasMes = somaMes("vendasMes"), pedidosMes = somaMes("pedidosMes"), carteiraMes = somaMes("carteiraMes");
    // Sem vendedor também entra no faturamento da carteira de "toda a Honest".
    const semNoCons = modo === "toda" || modo === "sem" ? semVendedor : [];
    const fatSemMes: Record<string, number> = {};
    for (const c of data?.clientesAno || []) if (!c.vendedorId && (modo === "toda" || modo === "sem"))
      for (const [m, val] of Object.entries(c.porMes || {})) fatSemMes[m] = (fatSemMes[m] || 0) + Number(val);
    for (const [m, val] of Object.entries(fatSemMes)) carteiraMes[m] = (modo === "sem" ? 0 : carteiraMes[m] || 0) + val;
    const segMap = new Map<string, { clientes: number; ativos: number; valor: number }>();
    for (const v of vs) for (const s of v.segmentos || []) {
      const a = segMap.get(s.segmento) || { clientes: 0, ativos: 0, valor: 0 };
      a.clientes += s.clientes; a.ativos += s.ativos; a.valor += s.valor; segMap.set(s.segmento, a);
    }
    for (const c of semNoCons) {
      const a = segMap.get(c.segmento) || { clientes: 0, ativos: 0, valor: 0 };
      a.clientes++; if (c.ativo) a.ativos++; a.valor += c.fatAno; segMap.set(c.segmento, a);
    }
    const semAtivos = semNoCons.filter((c) => c.ativo).length;
    return {
      carteira: soma((v) => v.carteira.total) + semNoCons.length,
      ativos: soma((v) => v.carteira.ativos) + semAtivos,
      compraramAno: soma((v) => v.carteira.compraramAno) + semNoCons.filter((c) => c.fatAno > 0).length,
      fatCarteira: soma((v) => v.carteira.fatAno) + semNoCons.reduce((s, c) => s + c.fatAno, 0),
      herdados: soma((v) => v.herdados.total), herdadosAtivos: soma((v) => v.herdados.ativos),
      herdadosCompraram: soma((v) => v.herdados.compraramAno), herdadosFat: soma((v) => v.herdados.fatAno),
      conquistados: vs.flatMap((v) => (v.conquistados || []).map((c: any) => ({ ...c, vendedor: v.nome }))),
      inativadosPorEle: vs.flatMap((v) => (v.inativadosPorEle?.lista || []).map((x: any) => ({ ...x, vendedor: v.nome }))),
      inativosCarteira: soma((v) => v.inativadosNaCarteira) + semNoCons.filter((c) => !c.ativo).length,
      leadsCad: soma((v) => v.leads.cadastrados.total), leadsConv: soma((v) => v.leads.cadastrados.convertidos),
      leadsDesc: soma((v) => v.leads.cadastrados.descartados), leadsAnd: soma((v) => v.leads.cadastrados.emAndamento),
      vendasAno: Object.values(vendasMes).reduce((s, x) => s + x, 0), pedidosAno: Object.values(pedidosMes).reduce((s, x) => s + x, 0),
      vendasMes, pedidosMes, carteiraMes,
      segmentos: Array.from(segMap.entries()).map(([segmento, s]) => ({ segmento, ...s })).sort((a, b) => b.valor - a.valor || b.clientes - a.clientes),
    };
  }, [modo, selecionado, vendedores, semVendedor, data]);

  const serie = meses.map((m) => ({
    mes: rotMes(m) + (m === mesCorrente ? "*" : ""),
    vendas: consolidado.vendasMes[m] || 0,
    carteira: consolidado.carteiraMes[m] || 0,
    pedidos: consolidado.pedidosMes[m] || 0,
  }));

  // ── tabela anual de clientes mês a mês ─────────────────────────────────────
  const clientesTabela = useMemo(() => {
    let arr: any[] = data?.clientesAno || [];
    if (modo === "vend") arr = arr.filter((c) => selecionado && c.vendedorId === selecionado.id);
    if (modo === "sem") arr = arr.filter((c) => !c.vendedorId);
    if (busca.trim()) {
      const b = norm(busca);
      arr = arr.filter((c) => norm(`${c.nome} ${c.vendedor} ${c.cidade} ${c.segmento} ${c.doc || ""}`).includes(b));
    }
    return [...arr].sort((a, b) => b.total - a.total);
  }, [data, modo, selecionado, busca]);
  const totalMes = (m: string) => clientesTabela.reduce((s, c) => s + (Number(c.porMes?.[m]) || 0), 0);

  const exportarTabela = () => {
    exportToExcel(clientesTabela.map((c) => {
      const row: any = { Cliente: c.nome, "CPF/CNPJ": c.doc || "", Vendedor: c.vendedor, Cidade: c.cidade, Segmento: c.segmento, Situação: c.ativo ? "Ativo" : "Inativo" };
      for (const m of meses) row[rotMes(m)] = Number(c.porMes?.[m]) || 0;
      row["Total no ano"] = c.total;
      return row;
    }), `clientes-${ano}-${modo === "vend" ? selecionado?.nome || "vendedor" : modo === "sem" ? "sem-vendedor" : "honest"}`);
  };

  const salvarInicio = async (valor: string | null) => {
    if (!selecionado) return;
    await fetch("/api/reports/dossie-vendedores/inicio", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selecionado.id, data: valor }),
    });
    qc.invalidateQueries({ queryKey: ["/api/reports/dossie-vendedores"] });
  };

  const titulo = modo === "toda" ? "Toda a Honest" : modo === "sem" ? "Clientes sem vendedor" : selecionado?.nome || "—";
  const origemInicio = selecionado?.inicioAjustado ? "ajustada manualmente" : selecionado?.primeiroPedido ? "1º pedido digitado" : "cadastro do usuário";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground block">Ano</label>
            <Select value={String(ano)} onValueChange={(v) => setAno(Number(v))}>
              <SelectTrigger className="w-28" data-testid="dossie-ano"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: anoAtual - 2024 }, (_, i) => anoAtual - i).map((a) => (
                  <SelectItem key={a} value={String(a)}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!data?.restrito && (
            <div>
              <label className="text-xs text-muted-foreground block">Vendedor</label>
              <Select value={sel} onValueChange={(v) => { setSel(v); setLimite(100); }}>
                <SelectTrigger className="w-72" data-testid="dossie-vendedor"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODA}>Toda a Honest</SelectItem>
                  {vendedores.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.nome}{v.ativoUsuario ? "" : " (inativo)"}</SelectItem>
                  ))}
                  <SelectItem value={SEM}>Sem vendedor ({semVendedor.length})</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="ml-auto"><Info className="h-4 w-4 mr-1" /> Como os números são contados</Button>
            </PopoverTrigger>
            <PopoverContent className="w-[480px] text-sm space-y-2">
              <p><b>Início na atividade:</b> o 1º pedido que o vendedor digitou no pipeline (ou o cadastro do usuário, se ele nunca digitou). Como o pipeline só existe desde a virada para o 2.0, a data pode ser ajustada à mão.</p>
              <p><b>Herdados:</b> clientes da carteira atual que já existiam antes do início dele. <b>Conquistados:</b> clientes da carteira atual que entraram a partir do início dele. Entrada do cliente = cadastro ou 1ª compra, o que vier primeiro.</p>
              <p><b>Inativados por ele:</b> inativações registradas na auditoria do cadastro com o usuário dele. A auditoria só começou em set/2026.</p>
              <p><b>Vendas dele:</b> pedidos que ele digitou (regra do implantador), mesmo para cliente de outra carteira. <b>Faturamento da carteira:</b> o que os clientes da carteira dele faturaram, na régua da aba Carteira.</p>
              <p><b>Leads:</b> leads cadastrados no sistema pelo próprio vendedor.</p>
            </PopoverContent>
          </Popover>
        </CardContent>
      </Card>

      {error && <div className="text-red-600 text-sm">Erro ao carregar: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted-foreground text-sm">Montando o dossiê…</div>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">{titulo}</CardTitle>
              {modo === "vend" && selecionado && (
                <CardDescription className="flex flex-wrap items-center gap-2">
                  <span>{selecionado.papel === "telemarketing" ? "Telemarketing" : "Vendedor"}{selecionado.ativoUsuario ? "" : " · usuário inativo"}</span>
                  <span>· Início na atividade: <b>{dataBR(selecionado.inicio)}</b> ({origemInicio})</span>
                  {podeAjustar && (
                    <span className="flex items-center gap-1">
                      <Input type="date" className="h-7 w-40" value={dataAjuste} onChange={(e) => setDataAjuste(e.target.value)} />
                      <Button size="sm" variant="outline" className="h-7" disabled={!dataAjuste} onClick={() => salvarInicio(dataAjuste)}>Ajustar início</Button>
                      {selecionado.inicioAjustado && <Button size="sm" variant="ghost" className="h-7" onClick={() => salvarInicio(null)}>Voltar ao automático</Button>}
                    </span>
                  )}
                </CardDescription>
              )}
              {modo === "toda" && <CardDescription>{vendedores.length} vendedores com carteira, pedidos ou leads, mais {semVendedor.length} clientes sem vendedor.</CardDescription>}
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              <Kpi titulo="Carteira hoje" valor={String(consolidado.carteira)} sub={`${consolidado.ativos} ativos · ${consolidado.compraramAno} compraram em ${ano}`} />
              <Kpi titulo={`Faturamento da carteira em ${ano}`} valor={brl(consolidado.fatCarteira)} cor="text-blue-700" />
              {modo !== "sem" && <Kpi titulo={`Vendas digitadas em ${ano}`} valor={brl(consolidado.vendasAno)} sub={`${consolidado.pedidosAno} pedidos`} cor="text-emerald-700" />}
              {modo !== "sem" && <Kpi titulo="Clientes herdados" valor={String(consolidado.herdados)} sub={`${consolidado.herdadosAtivos} ativos · ${consolidado.herdadosCompraram} compraram · ${curto(consolidado.herdadosFat)}`} />}
              {modo !== "sem" && <Kpi titulo="Clientes conquistados" valor={String(consolidado.conquistados.length)}
                sub={`${consolidado.conquistados.filter((c: any) => c.ativo).length} ativos · ${brl(consolidado.conquistados.reduce((s: number, c: any) => s + c.valorVida, 0))} vendidos`} />}
              <Kpi titulo="Inativados" valor={String(modo === "sem" ? consolidado.inativosCarteira : consolidado.inativadosPorEle.length)}
                sub={modo === "sem" ? "inativos na lista" : `por ele (auditoria) · ${consolidado.inativosCarteira} inativos na carteira`} cor="text-red-700" />
              {modo !== "sem" && <Kpi titulo="Leads cadastrados por ele" valor={String(consolidado.leadsCad)}
                sub={`${consolidado.leadsConv} convertidos · ${consolidado.leadsAnd} em andamento · ${consolidado.leadsDesc} descartados`} />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Evolução em {ano}: vendas e carteira</CardTitle>
              <CardDescription>
                Barras = vendas que {modo === "vend" ? "ele digitou" : "foram digitadas"} no mês. Linha = faturamento dos clientes da carteira no mês.
                {meses.includes(mesCorrente) && " *Mês em curso, parcial."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={serie} margin={{ top: 12, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="mes" />
                  <YAxis tickFormatter={curto} width={70} />
                  <Tooltip formatter={(v: any, n: any) => (n === "Pedidos" ? v : brl(Number(v)))} />
                  <Legend />
                  {modo !== "sem" && <Bar dataKey="vendas" name="Vendas digitadas" fill="#2a78d6" isAnimationActive={false} />}
                  <Line type="linear" dataKey="carteira" name="Faturamento da carteira" stroke="#eb6834" strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Perfil da carteira por segmento</CardTitle>
                <CardDescription>Clientes da carteira hoje e o faturamento deles em {ano}.</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={Math.max(180, Math.min(12, consolidado.segmentos.length) * 30 + 30)}>
                  <BarChart data={consolidado.segmentos.slice(0, 12)} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <XAxis type="number" tickFormatter={curto} />
                    <YAxis type="category" dataKey="segmento" width={170} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => brl(Number(v))} />
                    <Bar dataKey="valor" name={`Faturamento ${ano}`} fill="#2a78d6" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
                <table className="w-full text-sm mt-2">
                  <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1">Segmento</th><th className="text-right">Clientes</th><th className="text-right">Ativos</th><th className="text-right">Faturamento {ano}</th></tr></thead>
                  <tbody>
                    {consolidado.segmentos.map((s) => (
                      <tr key={s.segmento} className="border-b last:border-0"><td className="py-1">{s.segmento}</td><td className="text-right">{s.clientes}</td><td className="text-right">{s.ativos}</td><td className="text-right">{brl(s.valor)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {modo === "toda" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Resumo por vendedor</CardTitle>
                  <CardDescription>Clique em um nome para abrir o dossiê dele.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Vendedor</th><th>Início</th><th className="text-right">Carteira</th><th className="text-right">Herdados</th>
                      <th className="text-right">Conquistados</th><th className="text-right">Inativou</th><th className="text-right">Leads</th>
                      <th className="text-right">Vendas {ano}</th><th className="text-right">Carteira {ano}</th></tr></thead>
                    <tbody>
                      {vendedores.map((v) => (
                        <tr key={v.id} className="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onClick={() => setSel(v.id)}>
                          <td className="py-1 text-blue-700">{v.nome}</td><td>{dataBR(v.inicio)}</td>
                          <td className="text-right">{v.carteira.total}</td><td className="text-right">{v.herdados.total}</td>
                          <td className="text-right">{v.conquistados.length}</td><td className="text-right">{v.inativadosPorEle.total}</td>
                          <td className="text-right">{v.leads.cadastrados.total}</td>
                          <td className="text-right">{brl(Object.values(v.vendasMes as Record<string, number>).reduce((s, x) => s + x, 0))}</td>
                          <td className="text-right">{brl(v.carteira.fatAno)}</td>
                        </tr>
                      ))}
                      <tr className="text-muted-foreground"><td className="py-1">Sem vendedor</td><td></td><td className="text-right">{semVendedor.length}</td><td colSpan={5}></td>
                        <td className="text-right">{brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))}</td></tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : modo === "vend" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Clientes conquistados por {selecionado?.nome}</CardTitle>
                  <CardDescription>Entraram na carteira a partir de {dataBR(selecionado?.inicio)}, com o que já compraram.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto max-h-[420px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white"><tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Cliente</th><th>Entrada</th><th>Situação</th><th className="text-right">Vendas</th><th className="text-right">Total vendido</th><th className="text-right">Em {ano}</th></tr></thead>
                    <tbody>
                      {consolidado.conquistados.map((c: any) => (
                        <tr key={c.id} className="border-b last:border-0">
                          <td className="py-1">{c.nome}<div className="text-xs text-muted-foreground">{c.cidade} · {c.segmento}</div></td>
                          <td>{dataBR(c.conquista)}</td>
                          <td className={c.ativo ? "text-emerald-700" : "text-red-700"}>{c.ativo ? "Ativo" : "Inativo"}</td>
                          <td className="text-right">{c.vendasVida}</td><td className="text-right">{brl(c.valorVida)}</td><td className="text-right">{brl(c.fatAno)}</td>
                        </tr>
                      ))}
                      {consolidado.conquistados.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">Nenhum cliente novo na carteira dele.</td></tr>}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Relação dos clientes sem vendedor</CardTitle>
                  <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {ano}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto max-h-[420px]">
                  <SemVendedorTabela lista={semVendedor} ano={ano} />
                </CardContent>
              </Card>
            )}
          </div>

          {modo === "vend" && consolidado.inativadosPorEle.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Clientes que {selecionado?.nome} inativou</CardTitle></CardHeader>
              <CardContent className="overflow-auto max-h-[300px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white"><tr className="text-left text-muted-foreground border-b"><th className="py-1">Data</th><th>Cliente</th><th>Da carteira dele?</th></tr></thead>
                  <tbody>{consolidado.inativadosPorEle.map((x: any, i: number) => (
                    <tr key={i} className="border-b last:border-0"><td className="py-1">{dataBR(x.data)}</td><td>{x.cliente}</td><td>{x.daCarteira ? "Sim" : "Não"}</td></tr>
                  ))}</tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {modo === "toda" && (
            <Card>
              <CardHeader>
                <CardTitle>Relação dos clientes sem vendedor</CardTitle>
                <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {ano}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-auto max-h-[420px]"><SemVendedorTabela lista={semVendedor} ano={ano} /></CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <CardTitle>Clientes que compraram em {ano} — mês a mês</CardTitle>
                  <CardDescription>{clientesTabela.length} clientes · {titulo} · faturamento em R$ por mês até {rotMes(meses[meses.length - 1] || mesCorrente)}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                    <Input className="pl-8 w-64" placeholder="Buscar cliente, cidade, segmento…" value={busca} onChange={(e) => { setBusca(e.target.value); setLimite(100); }} data-testid="dossie-busca" />
                  </div>
                  <Button variant="outline" size="sm" onClick={exportarTabela}><Download className="h-4 w-4 mr-1" /> Exportar Excel</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="overflow-auto max-h-[70vh] p-0">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 px-3 min-w-[220px]">Cliente</th>
                    {modo === "toda" && <th className="px-2">Vendedor</th>}
                    <th className="px-2">Segmento</th>
                    {meses.map((m) => <th key={m} className="px-2 text-right whitespace-nowrap">{rotMes(m)}{m === mesCorrente ? "*" : ""}</th>)}
                    <th className="px-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {clientesTabela.slice(0, limite).map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="py-1 px-3">{c.nome}{!c.ativo && <span className="ml-1 text-xs text-red-600">inativo</span>}<div className="text-xs text-muted-foreground">{c.cidade}</div></td>
                      {modo === "toda" && <td className="px-2 whitespace-nowrap">{c.vendedor}</td>}
                      <td className="px-2 text-xs">{c.segmento}</td>
                      {meses.map((m) => {
                        const v = Number(c.porMes?.[m]) || 0;
                        return <td key={m} className={`px-2 text-right whitespace-nowrap ${v ? "" : "text-slate-300"}`}>{v ? brl(v) : "—"}</td>;
                      })}
                      <td className="px-3 text-right font-semibold whitespace-nowrap">{brl(c.total)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold bg-slate-50 sticky bottom-0">
                    <td className="py-2 px-3">Total ({clientesTabela.length})</td>
                    {modo === "toda" && <td></td>}
                    <td></td>
                    {meses.map((m) => <td key={m} className="px-2 text-right whitespace-nowrap">{brl(totalMes(m))}</td>)}
                    <td className="px-3 text-right whitespace-nowrap">{brl(clientesTabela.reduce((s, c) => s + c.total, 0))}</td>
                  </tr>
                </tbody>
              </table>
              {clientesTabela.length > limite && (
                <div className="p-3 flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setLimite(limite + 200)}>Mostrar mais 200</Button>
                  <Button variant="outline" size="sm" onClick={() => setLimite(clientesTabela.length)}>Mostrar todos ({clientesTabela.length})</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SemVendedorTabela({ lista, ano }: { lista: any[]; ano: number }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-white"><tr className="text-left text-muted-foreground border-b">
        <th className="py-1">Cliente</th><th>Cidade</th><th>Segmento</th><th>Situação</th><th>Entrada</th><th className="text-right">Em {ano}</th></tr></thead>
      <tbody>
        {lista.map((c) => (
          <tr key={c.id} className="border-b last:border-0">
            <td className="py-1">{c.nome}</td><td>{c.cidade}</td><td className="text-xs">{c.segmento}</td>
            <td className={c.ativo ? "text-emerald-700" : "text-red-700"}>{c.ativo ? "Ativo" : "Inativo"}</td>
            <td>{dataBR(c.conquista)}</td><td className="text-right">{brl(c.fatAno)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
