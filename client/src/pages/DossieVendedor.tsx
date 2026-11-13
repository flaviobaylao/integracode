import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowDown, ArrowUp, ChevronDown, Download, Info, Search, Users } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";
import GraficosCarteira from "@/pages/GraficosCarteira";
import { useAuth } from "@/hooks/useAuth";

// Aba "Dossiê do vendedor" da Gestão de Carteiras.
// Dados: /api/reports/dossie-vendedores?ano=AAAA (todos os vendedores de uma vez;
// o seletor escolhe "Toda a Honest", um ou vários vendedores, ou "Sem vendedor").
//
// FILTROS (Flavio, 13/11/2026). O box de Mês/Ano/Vendedor congela no topo ao
// rolar, porque esta tela é longa e a pergunta "e no mês passado?" nasce no meio
// da tabela, não no começo dela.
//  • MÊS manda nos cartões do topo e na tabela de clientes; o gráfico e as
//    colunas mês a mês seguem mostrando o ano inteiro, com o mês escolhido
//    destacado — é o ano que dá sentido ao mês.
//  • VENDEDOR é múltipla escolha, separando EXTERNOS (vendedor_clt/vendedor_pj,
//    quem vai à rua) de INTERNOS (telemarketing, quem atende de dentro). Só
//    ativos por padrão; a chave "incluir inativos" traz de volta quem saiu.
//    "Toda a Honest" continua somando TODO MUNDO, inativo incluído — a carteira
//    de quem saiu não deixou de faturar, e sem ela o total pararia de bater com
//    a aba Carteira.

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
/** 'YYYY-MM' do mês anterior. */
const mesAntes = (m: string) => {
  const [a, b] = m.split("-").map(Number);
  const y = b === 1 ? a - 1 : a, x = b === 1 ? 12 : b - 1;
  return `${y}-${String(x).padStart(2, "0")}`;
};
/** Variação % de `atual` sobre `base`. Sem base não há variação — devolve null
 *  em vez de inventar "+100%", que é o erro clássico de dividir por zero. */
const variacao = (atual: number, base: number): number | null => {
  const b = Number(base) || 0;
  if (b <= 0) return null;
  return ((Number(atual) || 0) - b) / b * 100;
};
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`);

/**
 * Em que grupo do seletor o usuário entra, pelo `seller_type` do cadastro:
 *   • EXTERNO  — vendedor_clt / vendedor_pj: vai à rua.
 *   • INTERNO  — telemarketing: atende de dentro.
 *   • OUTRO    — canal (HOTSITE), admin, indústria, sem tipo.
 * O terceiro grupo existe porque a lista tem 27 usuários e só 8 deles são
 * vendedor de verdade. Chamar HOTSITE ou um administrador de "externo" — que
 * era o que acontecia com a divisão em dois — poria no mesmo balde quem roda
 * rota e quem nunca pisou na rua, e é exatamente essa a comparação que o
 * seletor existe para permitir.
 */
type Grupo3 = "externo" | "interno" | "outro";
const grupoDe = (v: any): Grupo3 => {
  const t = String(v?.tipo || "");
  if (t === "vendedor_clt" || t === "vendedor_pj") return "externo";
  if (t === "telemarketing") return "interno";
  return "outro";
};
const ROTULO_GRUPO: Record<Grupo3, string> = {
  externo: "Vendedor externo", interno: "Telemarketing (interno)", outro: "Outro acesso com carteira",
};

/**
 * Quem aparece no RESUMO POR VENDEDOR (Flavio, 13/11/2026): "somente vendedores
 * com qualquer tipo de valor, exceto Honest colaborador, admin e sistema".
 *
 * Dos 27 usuários da base, a maioria não é vendedor: administradores, o usuário
 * SISTEMA, a conta de colaboradores e a de fornecedores. Eles têm carteira por
 * acidente de cadastro e enchiam um quadro que existe para comparar quem vende.
 * Ficam de fora por PAPEL (admin/administrative) e por uma lista curta de contas
 * de serviço — o papel sozinho não resolve, porque "Honest Colaboradores" está
 * cadastrado como vendedor. Além disso é preciso ter valor: faturamento na
 * carteira ou venda digitada no ano. O quadro diz na descrição quem saiu, para
 * ninguém procurar um nome e achar que o número sumiu.
 */
const CONTAS_DE_SERVICO = /^(sistema|honest\s+(colaborador|admin|fornecedor))/i;
const ehContaDeServico = (v: any) =>
  ["admin", "administrative"].includes(String(v?.papel || "")) || CONTAS_DE_SERVICO.test(String(v?.nome || "").trim());
const temValor = (v: any) =>
  (Number(v?.carteira?.fatAno) || 0) > 0 ||
  Object.values((v?.vendasMes || {}) as Record<string, number>).some((x) => Number(x) > 0);

/**
 * A setinha de subiu/caiu de um mês para o anterior.
 * Só o símbolo na célula — a conta por extenso fica no title, porque a tabela
 * tem 11 colunas de mês e um "+37%" em cada uma faria a grade virar ruído.
 */
function Seta({ atual, anterior, mostrarZero = false }: { atual: number; anterior: number | null; mostrarZero?: boolean }) {
  if (anterior === null) return null;
  const a = Number(atual) || 0, b = Number(anterior) || 0;
  if (b === 0 && a === 0) return null;
  if (a === b) return null;
  if (!mostrarZero && b === 0) return null; // primeira compra: nada a comparar
  const sobe = a > b;
  const v = variacao(a, b);
  return (
    <span
      className={`ml-0.5 inline-block align-middle ${sobe ? "text-emerald-600" : "text-red-600"}`}
      title={`${brl(b)} → ${brl(a)}${v === null ? "" : ` (${pct(v)})`}`}
    >
      {sobe ? "▲" : "▼"}
    </span>
  );
}

function Kpi({ titulo, valor, sub, cor = "text-slate-900", variacaoPct }: {
  titulo: string; valor: string; sub?: string; cor?: string; variacaoPct?: number | null;
}) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className={`text-xl font-bold ${cor} flex items-center gap-1`}>
        {valor}
        {variacaoPct !== undefined && variacaoPct !== null && (
          <span className={`text-xs font-semibold inline-flex items-center ${variacaoPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            {variacaoPct >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {pct(variacaoPct)}
          </span>
        )}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/** Cabeçalho que ordena. A setinha só aparece na coluna em uso — nas outras
 *  fica cinza no hover, para a grade não virar um painel de setas. */
function Th({ cod, atual, onOrdenar, children, className = "" }: {
  cod: string; atual: { col: string; dir: "asc" | "desc" }; onOrdenar: (c: string) => void;
  children: any; className?: string;
}) {
  const ativa = atual.col === cod;
  return (
    <th className={`px-2 cursor-pointer select-none group ${className}`} onClick={() => onOrdenar(cod)}
      title="Clique para ordenar; clique de novo para inverter">
      <span className="inline-flex items-center gap-0.5">
        {children}
        <span className={ativa ? "text-slate-700" : "text-transparent group-hover:text-slate-300"}>
          {ativa && atual.dir === "asc" ? "▲" : "▼"}
        </span>
      </span>
    </th>
  );
}

export default function DossieVendedor() {
  const { user } = useAuth() as any;
  const podeAjustar = ["admin", "coordinator", "administrative"].includes(String(user?.role || ""));
  const anoAtual = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date()));
  const [ano, setAno] = useState(anoAtual);
  const [mesSel, setMesSel] = useState<string>("");          // "" = ano inteiro
  const [escopo, setEscopo] = useState<"toda" | "sem" | "sel">("toda");
  const [selIds, setSelIds] = useState<string[]>([]);
  const [incluirInativos, setIncluirInativos] = useState(false);
  const [redeSel, setRedeSel] = useState<string>("");        // "" = todas
  const [ord, setOrd] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "total", dir: "desc" });
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

  // Mês escolhido que não existe no ano carregado (trocou de ano) volta para o ano inteiro.
  useEffect(() => { if (mesSel && meses.length && !meses.includes(mesSel)) setMesSel(""); }, [meses, mesSel]);

  // ── quem está no seletor ──────────────────────────────────────────────────
  const naLista = useMemo(
    () => vendedores.filter((v) => incluirInativos || v.ativoUsuario),
    [vendedores, incluirInativos],
  );
  const externos = useMemo(() => naLista.filter((v) => grupoDe(v) === "externo"), [naLista]);
  const internos = useMemo(() => naLista.filter((v) => grupoDe(v) === "interno"), [naLista]);
  const outros = useMemo(() => naLista.filter((v) => grupoDe(v) === "outro"), [naLista]);

  // Vendedor/telemarketing recebe só o próprio dossiê — não há seletor para ele.
  const restrito = data?.restrito === true;
  const modo: "toda" | "sem" | "sel" = restrito ? "sel" : escopo;
  const selecionados = useMemo(() => {
    if (restrito) return vendedores;
    if (modo === "toda") return vendedores;        // todo mundo, inativo incluído
    if (modo === "sem") return [];
    return vendedores.filter((v) => selIds.includes(v.id));
  }, [restrito, vendedores, modo, selIds]);
  const umSo = modo === "sel" && selecionados.length === 1 ? selecionados[0] : null;
  /** Quem entra no quadro "Resumo por vendedor" — ver ehContaDeServico/temValor. */
  const resumoVendedores = useMemo(
    () => vendedores.filter((v) => !ehContaDeServico(v) && temValor(v)),
    [vendedores],
  );

  const alterna = (id: string) => {
    setEscopo("sel");
    setLimite(100);
    setSelIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  };
  const rotuloSeletor = restrito
    ? vendedores[0]?.nome || "—"
    : modo === "toda" ? "Toda a Honest"
    : modo === "sem" ? `Sem vendedor (${semVendedor.length})`
    : selecionados.length === 0 ? "Nenhum vendedor marcado"
    : selecionados.length === 1 ? selecionados[0].nome
    : `${selecionados.length} vendedores`;

  // ── consolidado: toda a Honest, um vendedor ou vários ─────────────────────
  const consolidado = useMemo(() => {
    const vs = modo === "sem" ? [] : selecionados;
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
    };
  }, [modo, selecionados, semVendedor, data]);

  // ── o mês escolhido e o anterior ──────────────────────────────────────────
  const mesAnt = mesSel ? mesAntes(mesSel) : "";
  // Janeiro não tem com o que comparar dentro do ano carregado.
  const temAnterior = !!mesSel && meses.includes(mesAnt);
  const noMes = (c: any, m: string) => Number(c?.porMes?.[m]) || 0;

  // ── tabela anual de clientes mês a mês ─────────────────────────────────────
  const base = useMemo(() => {
    let arr: any[] = data?.clientesAno || [];
    if (modo === "sel") {
      const ids = new Set(selecionados.map((v) => v.id));
      arr = arr.filter((c) => c.vendedorId && ids.has(c.vendedorId));
    }
    if (modo === "sem") arr = arr.filter((c) => !c.vendedorId);
    return arr;
  }, [data, modo, selecionados]);

  /** As redes presentes no recorte atual — o filtro só oferece o que existe. */
  const redes = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of base) { const r = String(c.rede || ""); if (r) m.set(r, (m.get(r) || 0) + 1); }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
  }, [base]);
  useEffect(() => { if (redeSel && redeSel !== "__sem__" && !redes.some(([r]) => r === redeSel)) setRedeSel(""); }, [redes, redeSel]);

  const clientesTabela = useMemo(() => {
    let arr = base;
    if (redeSel === "__sem__") arr = arr.filter((c) => !c.rede);
    else if (redeSel) arr = arr.filter((c) => String(c.rede || "") === redeSel);
    if (busca.trim()) {
      const b = norm(busca);
      arr = arr.filter((c) => norm(`${c.nome} ${c.vendedor} ${c.cidade} ${c.segmento} ${c.rede || ""} ${c.doc || ""}`).includes(b));
    }
    // Com um mês escolhido, a lista é a de quem comprou NELE ou no mês anterior
    // — quem parou de comprar é justamente o que não pode sumir da tela.
    if (mesSel) arr = arr.filter((c) => noMes(c, mesSel) > 0 || (temAnterior && noMes(c, mesAnt) > 0));
    const dir = ord.dir === "asc" ? 1 : -1;
    // .trim(): nome com espaco na frente existe no cadastro e, sem isto, ele
    // fura a ordem alfabetica e aparece antes do "2 IRMAOS" — o usuario ve uma
    // lista "ordenada" com duas linhas fora de lugar e nao confia em mais nada.
    const txt = (s: any) => String(s || "").trim();
    const chave = (c: any): any => {
      if (ord.col === "cliente") return txt(c.nome);
      if (ord.col === "vendedor") return txt(c.vendedor);
      if (ord.col === "segmento") return txt(c.segmento);
      if (ord.col === "rede") return txt(c.rede);
      if (ord.col === "total") return Number(c.total) || 0;
      if (ord.col === "var") {
        const v = temAnterior ? variacao(noMes(c, mesSel), noMes(c, mesAnt)) : null;
        return v === null ? -Infinity : v;
      }
      return noMes(c, ord.col); // uma coluna de mês
    };
    return [...arr].sort((a, b) => {
      const x = chave(a), y = chave(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "pt-BR") * dir;
      return (x - y) * dir;
    });
  }, [base, redeSel, busca, mesSel, mesAnt, temAnterior, ord]);

  const ordenar = (col: string) =>
    setOrd((o) => (o.col === col ? { col, dir: o.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "cliente" || col === "vendedor" || col === "segmento" || col === "rede" ? "asc" : "desc" }));

  const totalMes = (m: string) => clientesTabela.reduce((s, c) => s + noMes(c, m), 0);
  const totalGeral = clientesTabela.reduce((s, c) => s + (Number(c.total) || 0), 0);

  const exportarTabela = () => {
    exportToExcel(clientesTabela.map((c) => {
      const row: any = { Cliente: c.nome, "CPF/CNPJ": c.doc || "", Vendedor: c.vendedor, Rede: c.rede || "", Cidade: c.cidade, Segmento: c.segmento, Situação: c.ativo ? "Ativo" : "Inativo" };
      for (const m of meses) row[rotMes(m)] = noMes(c, m);
      row["Total no ano"] = c.total;
      if (mesSel && temAnterior) row[`Variação ${rotMes(mesSel)} vs ${rotMes(mesAnt)}`] = pct(variacao(noMes(c, mesSel), noMes(c, mesAnt)));
      return row;
    }), `clientes-${ano}${mesSel ? "-" + mesSel.slice(5) : ""}-${modo === "sel" ? (umSo?.nome || `${selecionados.length}-vendedores`) : modo === "sem" ? "sem-vendedor" : "honest"}`);
  };

  const salvarInicio = async (valor: string | null) => {
    if (!umSo) return;
    await fetch("/api/reports/dossie-vendedores/inicio", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: umSo.id, data: valor }),
    });
    qc.invalidateQueries({ queryKey: ["/api/reports/dossie-vendedores"] });
  };

  const titulo = modo === "toda" ? "Toda a Honest"
    : modo === "sem" ? "Clientes sem vendedor"
    : umSo ? umSo.nome
    : selecionados.length ? `${selecionados.length} vendedores` : "Nenhum vendedor marcado";
  const origemInicio = umSo?.inicioAjustado ? "ajustada manualmente" : umSo?.primeiroPedido ? "1º pedido digitado" : "cadastro do usuário";

  // ── números do recorte de mês, para os cartões do topo ────────────────────
  const fatPeriodo = mesSel ? (consolidado.carteiraMes[mesSel] || 0) : consolidado.fatCarteira;
  const fatVar = mesSel && temAnterior ? variacao(fatPeriodo, consolidado.carteiraMes[mesAnt] || 0) : null;
  const vendasPeriodo = mesSel ? (consolidado.vendasMes[mesSel] || 0) : consolidado.vendasAno;
  const vendasVar = mesSel && temAnterior ? variacao(vendasPeriodo, consolidado.vendasMes[mesAnt] || 0) : null;
  const pedidosPeriodo = mesSel ? (consolidado.pedidosMes[mesSel] || 0) : consolidado.pedidosAno;
  const compraramPeriodo = mesSel ? base.filter((c) => noMes(c, mesSel) > 0).length : consolidado.compraramAno;
  const compraramVar = mesSel && temAnterior
    ? variacao(compraramPeriodo, base.filter((c) => noMes(c, mesAnt) > 0).length) : null;
  const rotPeriodo = mesSel ? rotMes(mesSel) : String(ano);

  return (
    <div className="space-y-4">
      {/* ── FILTROS — congelam no topo ao rolar ───────────────────────────────
          A tela tem gráfico, segmentos e uma tabela longa: a pergunta "e no mês
          passado?" nasce no meio dela. Com o box preso no topo dá para trocar
          mês e vendedor sem perder o lugar na lista. */}
      <div className="sticky top-0 z-30 -mx-1 px-1 pt-1 pb-2 bg-slate-50/95 backdrop-blur supports-[backdrop-filter]:bg-slate-50/80">
        <Card>
          <CardContent className="pt-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-muted-foreground block">Mês</label>
              <Select value={mesSel || "__ano__"} onValueChange={(v) => { setMesSel(v === "__ano__" ? "" : v); setLimite(100); }}>
                <SelectTrigger className="w-36" data-testid="dossie-mes"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__ano__">Ano inteiro</SelectItem>
                  {meses.map((m) => (
                    <SelectItem key={m} value={m}>{rotMes(m)}{m === mesCorrente ? " (em curso)" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
            {!restrito && (
              <div>
                <label className="text-xs text-muted-foreground block">Vendedor</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-72 justify-between font-normal" data-testid="dossie-vendedor">
                      <span className="flex items-center gap-2 truncate">
                        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{rotuloSeletor}</span>
                      </span>
                      <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[340px] p-0">
                    <div className="p-2 border-b space-y-1">
                      <button type="button" onClick={() => { setEscopo("toda"); setSelIds([]); setLimite(100); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-sm ${modo === "toda" ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}
                        data-testid="dossie-toda">
                        Toda a Honest
                        <span className={`block text-xs ${modo === "toda" ? "text-slate-300" : "text-muted-foreground"}`}>
                          todos os {vendedores.length}, inativos incluídos — é o total que fecha com a aba Carteira
                        </span>
                      </button>
                      <button type="button" onClick={() => { setEscopo("sem"); setSelIds([]); setLimite(100); }}
                        className={`w-full text-left px-2 py-1.5 rounded text-sm ${modo === "sem" ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}
                        data-testid="dossie-sem">
                        Sem vendedor ({semVendedor.length})
                      </button>
                    </div>
                    <div className="max-h-[320px] overflow-auto p-2 space-y-3">
                      <Grupo titulo="Externos" dica="Vendedor de rua (CLT ou PJ)" lista={externos} selIds={selIds} alterna={alterna}
                        marcarTodos={() => { setEscopo("sel"); setSelIds(externos.map((v) => v.id)); setLimite(100); }} />
                      <Grupo titulo="Internos" dica="Telemarketing — atende de dentro" lista={internos} selIds={selIds} alterna={alterna}
                        marcarTodos={() => { setEscopo("sel"); setSelIds(internos.map((v) => v.id)); setLimite(100); }} />
                      <Grupo titulo="Outros" dica="Canal, administração, indústria — não é vendedor" lista={outros} selIds={selIds} alterna={alterna}
                        marcarTodos={() => { setEscopo("sel"); setSelIds(outros.map((v) => v.id)); setLimite(100); }} />
                      {naLista.length === 0 && <div className="text-sm text-muted-foreground py-4 text-center">Nenhum vendedor ativo.</div>}
                    </div>
                    <div className="p-2 border-t flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input type="checkbox" checked={incluirInativos} onChange={(e) => setIncluirInativos(e.target.checked)}
                          data-testid="dossie-incluir-inativos" />
                        incluir inativos
                      </label>
                      <Button size="sm" variant="ghost" className="h-7 text-xs"
                        onClick={() => { setEscopo("toda"); setSelIds([]); setLimite(100); }}>Limpar</Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="ml-auto"><Info className="h-4 w-4 mr-1" /> Como os números são contados</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[520px] text-sm space-y-2 max-h-[70vh] overflow-auto">
                <p><b>Início na atividade:</b> o 1º pedido que o vendedor digitou no pipeline (ou o cadastro do usuário, se ele nunca digitou). Como o pipeline só existe desde a virada para o 2.0, a data pode ser ajustada à mão.</p>
                <p><b>Herdados:</b> clientes da carteira atual que já existiam antes do início dele. <b>Conquistados:</b> clientes da carteira atual que entraram a partir do início dele. Entrada do cliente = cadastro ou 1ª compra, o que vier primeiro.</p>
                <p><b>Inativados por ele:</b> inativações registradas na auditoria do cadastro com o usuário dele. A auditoria só começou em set/2026.</p>
                <p><b>Vendas dele:</b> pedidos que ele digitou (regra do implantador), mesmo para cliente de outra carteira. <b>Faturamento da carteira:</b> o que os clientes da carteira dele faturaram, na régua da aba Carteira.</p>
                <p className="border-t pt-2"><b>Por que as barras e a linha não batem.</b> São perguntas diferentes: a barra é <b>o que ele digitou</b>, a linha é <b>o que os clientes da carteira dele faturaram</b>. Elas só coincidiriam se ele digitasse todos os pedidos dos seus clientes e nenhum outro. Separam as duas: pedido que o telemarketing (ou outro vendedor) digitou para um cliente da carteira dele entra só na linha; pedido que ele digitou para cliente de outra carteira entra só na barra; a carteira é a de <b>hoje</b> aplicada ao ano inteiro, então cliente que chegou em setembro leva o faturamento dele de janeiro para a linha; e pedido digitado não é nota autorizada — valor, cancelamento e a virada do mês deslocam os dois.</p>
                <p><b>Antes de abr/2026 a barra é zero</b> em quase todo mundo: o pipeline do INTEGRA só passou a receber os pedidos ali. Não é que não houve venda — é que ela não foi digitada aqui.</p>
                <p className="border-t pt-2"><b>Mês:</b> manda nos cartões do topo e na lista de clientes. Escolhido um mês, a lista mostra quem comprou nele <b>ou no mês anterior</b> — quem parou de comprar é o que menos pode sumir da tela. O gráfico e as colunas mês a mês seguem no ano inteiro.</p>
                <p><b>Setas:</b> comparam o mês com o mês anterior na mesma linha. Passe o mouse para ver os dois valores e a variação.</p>
              </PopoverContent>
            </Popover>
          </CardContent>
        </Card>
      </div>

      {error && <div className="text-red-600 text-sm">Erro ao carregar: {(error as Error).message}</div>}
      {isLoading && <div className="text-muted-foreground text-sm">Montando o dossiê…</div>}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">{titulo}</CardTitle>
              {umSo && (
                <CardDescription className="flex flex-wrap items-center gap-2">
                  <span>{ROTULO_GRUPO[grupoDe(umSo)]}{umSo.ativoUsuario ? "" : " · usuário inativo"}</span>
                  <span>· Início na atividade: <b>{dataBR(umSo.inicio)}</b> ({origemInicio})</span>
                  {podeAjustar && (
                    <span className="flex items-center gap-1">
                      <Input type="date" className="h-7 w-40" value={dataAjuste} onChange={(e) => setDataAjuste(e.target.value)} />
                      <Button size="sm" variant="outline" className="h-7" disabled={!dataAjuste} onClick={() => salvarInicio(dataAjuste)}>Ajustar início</Button>
                      {umSo.inicioAjustado && <Button size="sm" variant="ghost" className="h-7" onClick={() => salvarInicio(null)}>Voltar ao automático</Button>}
                    </span>
                  )}
                </CardDescription>
              )}
              {modo === "sel" && !umSo && selecionados.length > 0 && (
                <CardDescription>Soma de {selecionados.map((v) => v.nome).join(", ")}.</CardDescription>
              )}
              {modo === "toda" && <CardDescription>{vendedores.length} vendedores com carteira, pedidos ou leads, mais {semVendedor.length} clientes sem vendedor.</CardDescription>}
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              <Kpi titulo="Carteira hoje" valor={String(consolidado.carteira)}
                sub={`${consolidado.ativos} ativos · ${compraramPeriodo} compraram${mesSel ? ` em ${rotPeriodo}` : ` em ${ano}`}`}
                variacaoPct={compraramVar} />
              <Kpi titulo={`Faturamento da carteira em ${rotPeriodo}`} valor={brl(fatPeriodo)} cor="text-blue-700" variacaoPct={fatVar} />
              {modo !== "sem" && <Kpi titulo={`Vendas digitadas em ${rotPeriodo}`} valor={brl(vendasPeriodo)} sub={`${pedidosPeriodo} pedidos`} cor="text-emerald-700" variacaoPct={vendasVar} />}
              {modo !== "sem" && <Kpi titulo="Clientes herdados" valor={String(consolidado.herdados)} sub={`${consolidado.herdadosAtivos} ativos · ${consolidado.herdadosCompraram} compraram · ${curto(consolidado.herdadosFat)}`} />}
              {modo !== "sem" && <Kpi titulo="Clientes conquistados" valor={String(consolidado.conquistados.length)}
                sub={`${consolidado.conquistados.filter((c: any) => c.ativo).length} ativos · ${brl(consolidado.conquistados.reduce((s: number, c: any) => s + c.valorVida, 0))} vendidos`} />}
              <Kpi titulo="Inativados" valor={String(modo === "sem" ? consolidado.inativosCarteira : consolidado.inativadosPorEle.length)}
                sub={modo === "sem" ? "inativos na lista" : `por ele (auditoria) · ${consolidado.inativosCarteira} inativos na carteira`} cor="text-red-700" />
              {modo !== "sem" && <Kpi titulo="Leads cadastrados por ele" valor={String(consolidado.leadsCad)}
                sub={`${consolidado.leadsConv} convertidos · ${consolidado.leadsAnd} em andamento · ${consolidado.leadsDesc} descartados`} />}
            </CardContent>
            {mesSel && (
              <div className="px-6 pb-4 -mt-1 text-xs text-muted-foreground">
                Faturamento, vendas digitadas e “compraram” são de <b>{rotPeriodo}</b>
                {temAnterior ? <> — a seta compara com {rotMes(mesAnt)}.</> : <> — {rotMes(mesSel)} é o primeiro mês do ano carregado, não há com o que comparar.</>}
                {" "}Carteira, herdados, conquistados e leads são do cadastro de hoje / do ano inteiro.
              </div>
            )}
          </Card>

          {/* Os dois gráficos que moravam na aba "Gráficos" (Flavio, 13/11/2026):
              comparação entre os anos e evolução por vendedor. Abrem no ano que
              o dossiê está mostrando; dentro deles o período é livre, que é o
              ponto — o dossiê olha um ano, estes existem para comparar anos.
              `key={ano}` faz o período reiniciar quando o ano do dossiê muda. */}
          <GraficosCarteira key={ano} periodoInicial={{ inicio: `${ano}-01`, fim: ano === anoAtual ? mesCorrente : `${ano}-12` }} />

          <div className="space-y-4">
            {modo === "toda" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Resumo por vendedor</CardTitle>
                  <CardDescription>
                    {resumoVendedores.length} com faturamento ou venda digitada em {ano}. Clique em um nome para abrir o dossiê dele.
                    {vendedores.length - resumoVendedores.length > 0 &&
                      ` Fora do quadro: ${vendedores.length - resumoVendedores.length} contas sem valor no ano ou de serviço (administração, sistema, colaboradores).`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Vendedor</th><th>Tipo</th><th>Início</th><th className="text-right">Carteira</th><th className="text-right">Herdados</th>
                      <th className="text-right">Conquistados</th><th className="text-right">Inativou</th><th className="text-right">Leads</th>
                      <th className="text-right">Vendas {ano}</th><th className="text-right">Carteira {ano}</th></tr></thead>
                    <tbody>
                      {resumoVendedores.map((v) => (
                        <tr key={v.id} className="border-b last:border-0 hover:bg-slate-50 cursor-pointer"
                          onClick={() => { setEscopo("sel"); setSelIds([v.id]); setLimite(100); }}>
                          <td className="py-1 text-blue-700">{v.nome}{v.ativoUsuario ? "" : <span className="text-xs text-muted-foreground"> (inativo)</span>}</td>
                          <td className="text-xs text-muted-foreground">{grupoDe(v) === "interno" ? "Interno" : grupoDe(v) === "externo" ? "Externo" : "Outro"}</td>
                          <td>{dataBR(v.inicio)}</td>
                          <td className="text-right">{v.carteira.total}</td><td className="text-right">{v.herdados.total}</td>
                          <td className="text-right">{v.conquistados.length}</td><td className="text-right">{v.inativadosPorEle.total}</td>
                          <td className="text-right">{v.leads.cadastrados.total}</td>
                          <td className="text-right">{brl(Object.values(v.vendasMes as Record<string, number>).reduce((s, x) => s + x, 0))}</td>
                          <td className="text-right">{brl(v.carteira.fatAno)}</td>
                        </tr>
                      ))}
                      <tr className="text-muted-foreground"><td className="py-1">Sem vendedor</td><td></td><td></td><td className="text-right">{semVendedor.length}</td><td colSpan={5}></td>
                        <td className="text-right">{brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))}</td></tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : umSo ? (
              <Card>
                <CardHeader>
                  <CardTitle>Clientes conquistados por {umSo.nome}</CardTitle>
                  <CardDescription>Entraram na carteira a partir de {dataBR(umSo.inicio)}, com o que já compraram.</CardDescription>
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
            ) : modo === "sem" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Relação dos clientes sem vendedor e inativados</CardTitle>
                  <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {ano}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto max-h-[420px]">
                  <SemVendedorTabela lista={semVendedor} ano={ano} />
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Clientes conquistados</CardTitle>
                  <CardDescription>Soma dos {selecionados.length} vendedores marcados.</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto max-h-[420px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white"><tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Cliente</th><th>Vendedor</th><th>Entrada</th><th>Situação</th><th className="text-right">Em {ano}</th></tr></thead>
                    <tbody>
                      {consolidado.conquistados.map((c: any) => (
                        <tr key={`${c.vendedor}-${c.id}`} className="border-b last:border-0">
                          <td className="py-1">{c.nome}<div className="text-xs text-muted-foreground">{c.cidade} · {c.segmento}</div></td>
                          <td className="text-xs">{c.vendedor}</td>
                          <td>{dataBR(c.conquista)}</td>
                          <td className={c.ativo ? "text-emerald-700" : "text-red-700"}>{c.ativo ? "Ativo" : "Inativo"}</td>
                          <td className="text-right">{brl(c.fatAno)}</td>
                        </tr>
                      ))}
                      {consolidado.conquistados.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">Marque ao menos um vendedor.</td></tr>}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </div>

          {umSo && consolidado.inativadosPorEle.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Clientes que {umSo.nome} inativou</CardTitle></CardHeader>
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
                <CardTitle>Relação dos clientes sem vendedor e inativados</CardTitle>
                <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {ano}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-auto max-h-[420px]"><SemVendedorTabela lista={semVendedor} ano={ano} /></CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <CardTitle>
                    {mesSel ? `Clientes em ${rotPeriodo}` : `Clientes que compraram em ${ano}`} — mês a mês
                  </CardTitle>
                  <CardDescription>
                    {clientesTabela.length} clientes · {titulo}
                    {mesSel
                      ? temAnterior
                        ? ` · compraram em ${rotMes(mesSel)} ou em ${rotMes(mesAnt)}`
                        : ` · compraram em ${rotMes(mesSel)}`
                      : ` · faturamento em R$ por mês até ${rotMes(meses[meses.length - 1] || mesCorrente)}`}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {redes.length > 0 && (
                    <Select value={redeSel || "__todas__"} onValueChange={(v) => { setRedeSel(v === "__todas__" ? "" : v); setLimite(100); }}>
                      <SelectTrigger className="w-56" data-testid="dossie-rede"><SelectValue placeholder="Rede" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__todas__">Todas as redes</SelectItem>
                        <SelectItem value="__sem__">Fora de rede</SelectItem>
                        {redes.map(([r, n]) => <SelectItem key={r} value={r}>{r} ({n})</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  <div className="relative">
                    <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                    <Input className="pl-8 w-64" placeholder="Buscar cliente, rede, cidade…" value={busca} onChange={(e) => { setBusca(e.target.value); setLimite(100); }} data-testid="dossie-busca" />
                  </div>
                  <Button variant="outline" size="sm" onClick={exportarTabela}><Download className="h-4 w-4 mr-1" /> Exportar Excel</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="overflow-auto max-h-[70vh] p-0">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="text-left text-muted-foreground border-b">
                    <Th cod="cliente" atual={ord} onOrdenar={ordenar} className="py-2 px-3 min-w-[220px]">Cliente</Th>
                    {modo !== "sel" || !umSo ? <Th cod="vendedor" atual={ord} onOrdenar={ordenar}>Vendedor</Th> : null}
                    {redes.length > 0 && <Th cod="rede" atual={ord} onOrdenar={ordenar}>Rede</Th>}
                    <Th cod="segmento" atual={ord} onOrdenar={ordenar}>Segmento</Th>
                    {meses.map((m) => (
                      <Th key={m} cod={m} atual={ord} onOrdenar={ordenar}
                        className={`text-right whitespace-nowrap ${m === mesSel ? "bg-amber-50 text-amber-900 font-semibold" : ""}`}>
                        {rotMes(m)}{m === mesCorrente ? "*" : ""}
                      </Th>
                    ))}
                    {mesSel && temAnterior && <Th cod="var" atual={ord} onOrdenar={ordenar} className="text-right whitespace-nowrap">vs {rotMes(mesAnt)}</Th>}
                    <Th cod="total" atual={ord} onOrdenar={ordenar} className="px-3 text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {clientesTabela.slice(0, limite).map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="py-1 px-3">{c.nome}{!c.ativo && <span className="ml-1 text-xs text-red-600">inativo</span>}
                        <div className="text-xs text-muted-foreground">{c.cidade}</div></td>
                      {modo !== "sel" || !umSo ? <td className="px-2 whitespace-nowrap">{c.vendedor}</td> : null}
                      {redes.length > 0 && <td className="px-2 text-xs whitespace-nowrap">{c.rede || <span className="text-slate-300">—</span>}</td>}
                      <td className="px-2 text-xs">{c.segmento}</td>
                      {meses.map((m, i) => {
                        const v = noMes(c, m);
                        const ant = i > 0 ? noMes(c, meses[i - 1]) : null;
                        return (
                          <td key={m} className={`px-2 text-right whitespace-nowrap ${v ? "" : "text-slate-300"} ${m === mesSel ? "bg-amber-50" : ""}`}>
                            {v ? brl(v) : "—"}
                            <Seta atual={v} anterior={ant} />
                          </td>
                        );
                      })}
                      {mesSel && temAnterior && (
                        <td className={`px-2 text-right whitespace-nowrap font-medium ${
                          (variacao(noMes(c, mesSel), noMes(c, mesAnt)) ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {pct(variacao(noMes(c, mesSel), noMes(c, mesAnt)))}
                        </td>
                      )}
                      <td className="px-3 text-right font-semibold whitespace-nowrap">{brl(c.total)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold bg-slate-50 sticky bottom-0">
                    <td className="py-2 px-3">Total ({clientesTabela.length})</td>
                    {modo !== "sel" || !umSo ? <td></td> : null}
                    {redes.length > 0 && <td></td>}
                    <td></td>
                    {meses.map((m, i) => {
                      const v = totalMes(m);
                      const ant = i > 0 ? totalMes(meses[i - 1]) : null;
                      return (
                        <td key={m} className={`px-2 text-right whitespace-nowrap ${m === mesSel ? "bg-amber-100" : ""}`}>
                          {brl(v)}<Seta atual={v} anterior={ant} />
                        </td>
                      );
                    })}
                    {mesSel && temAnterior && <td className="px-2 text-right">{pct(variacao(totalMes(mesSel), totalMes(mesAnt)))}</td>}
                    <td className="px-3 text-right whitespace-nowrap">{brl(totalGeral)}</td>
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

/** Um grupo do seletor (Externos / Internos), com marcar-todos. */
function Grupo({ titulo, dica, lista, selIds, alterna, marcarTodos }: {
  titulo: string; dica: string; lista: any[]; selIds: string[];
  alterna: (id: string) => void; marcarTodos: () => void;
}) {
  if (!lista.length) return null;
  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{titulo} ({lista.length})</div>
          <div className="text-[11px] text-muted-foreground">{dica}</div>
        </div>
        <button type="button" className="text-[11px] text-blue-700 hover:underline" onClick={marcarTodos}>marcar todos</button>
      </div>
      {lista.map((v) => (
        <label key={v.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-100 cursor-pointer text-sm"
          data-testid={`dossie-vend-${v.id}`}>
          <input type="checkbox" checked={selIds.includes(v.id)} onChange={() => alterna(v.id)} />
          <span className="truncate">{v.nome}</span>
          {!v.ativoUsuario && <span className="text-[11px] text-muted-foreground shrink-0">(inativo)</span>}
          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">{v.carteira.total}</span>
        </label>
      ))}
    </div>
  );
}

function SemVendedorTabela({ lista, ano }: { lista: any[]; ano: number }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-white"><tr className="text-left text-muted-foreground border-b">
        <th className="py-1">Cliente</th><th>Cidade</th><th>Situação</th>
        <th className="min-w-[260px]">Motivo da inativação</th>
        <th>Entrada</th><th className="text-right">Em {ano}</th></tr></thead>
      <tbody>
        {lista.map((c) => (
          <tr key={c.id} className="border-b last:border-0">
            <td className="py-1">{c.nome}</td><td>{c.cidade}</td>
            <td className={c.ativo ? "text-emerald-700" : "text-red-700"}>
              {c.ativo ? "Ativo" : "Inativo"}
              {!c.ativo && c.inativado && <div className="text-xs text-muted-foreground">{dataBR(c.inativado)}</div>}
            </td>
            {/* Motivo vazio não é "sem motivo": é motivo que ninguém registrou.
                Dizer isso por extenso evita que a coluna em branco passe por
                "inativação sem razão". */}
            <td className="text-xs">
              {c.ativo ? <span className="text-slate-300">—</span>
                : c.motivo ? c.motivo
                : <span className="text-amber-700">não registrado</span>}
            </td>
            <td>{dataBR(c.conquista)}</td><td className="text-right">{brl(c.fatAno)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
