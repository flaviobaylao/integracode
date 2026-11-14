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
const dataBR = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const norm = (s: string) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** 'YYYY-MM' do mês anterior. */
const mesAntes = (m: string) => {
  const [a, b] = m.split("-").map(Number);
  const y = b === 1 ? a - 1 : a, x = b === 1 ? 12 : b - 1;
  return `${y}-${String(x).padStart(2, "0")}`;
};
/** 'YYYY-MM' deslocado de `delta` meses (negativo anda para trás). */
const somaMeses = (m: string, delta: number) => {
  let y = Number(m.slice(0, 4)), x = Number(m.slice(5, 7)) + delta;
  while (x < 1) { x += 12; y--; }
  while (x > 12) { x -= 12; y++; }
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
 * Quem aparece no RESUMO POR VENDEDOR (Flavio, 13/11/2026): contas de serviço
 * fora, e só quem TEM CARTEIRA hoje.
 *
 * Dos 27 usuários da base, a maioria não é vendedor: administradores, o usuário
 * SISTEMA, a conta de colaboradores e a de fornecedores. Ficam de fora por PAPEL
 * (admin/administrative) e por uma lista curta de contas de serviço — o papel
 * sozinho não resolve, porque "Honest Colaboradores" está cadastrado como
 * vendedor.
 *
 * A segunda regra é ter cliente na carteira AGORA. A primeira versão pedia
 * "qualquer tipo de valor" e deixava entrar quem só tinha venda digitada no
 * passado: seis linhas de vendedor com carteira zerada — gente que saiu, e a
 * conta da indústria — num quadro que existe para comparar carteiras. Repare
 * que a regra é a carteira, não o faturamento: vendedor com carteira e R$ 0 no
 * ano PRECISA aparecer, é justamente o caso que se quer enxergar.
 */
const CONTAS_DE_SERVICO = /^(sistema|honest\s+(colaborador|admin|fornecedor))/i;
const ehContaDeServico = (v: any) =>
  ["admin", "administrative"].includes(String(v?.papel || "")) || CONTAS_DE_SERVICO.test(String(v?.nome || "").trim());
const temCarteira = (v: any) => (Number(v?.carteira?.total) || 0) > 0;

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
  // 14/11/2026 (Flavio) — O FILTRO-MÃE VIROU UM PERÍODO. Antes eram "Mês" e
  // "Ano": a tela trabalhava um ano civil por vez e, dentro dele, um mês. Isso
  // impedia a pergunta mais natural do negócio — "e de nov/25 para cá?" —, que
  // atravessa a virada do ano. Agora são DE (mês) e ATÉ (mês), um intervalo
  // contínuo que pode cruzar anos, e TUDO abaixo obedece a ele: os cartões do
  // topo, o resumo, as listas, as colunas mês a mês e os gráficos.
  //
  // O "mês escolhido" deixou de existir como conceito à parte. Quem quer um mês
  // só põe De e Até no mesmo mês — e aí os cartões, a lista e as colunas falam
  // daquele mês, sem um segundo seletor para desencontrar do primeiro.
  const mesHojeBR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
  const anoAtual = Number(mesHojeBR.slice(0, 4));
  const [ini, setIni] = useState(`${anoAtual}-01`);
  const [fim, setFim] = useState(mesHojeBR);
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
    queryKey: ["/api/reports/dossie-vendedores", ini, fim],
    queryFn: async () => {
      const r = await fetch(`/api/reports/dossie-vendedores?inicio=${ini}&fim=${fim}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const vendedores: any[] = data?.vendedores || [];
  const semVendedor: any[] = data?.semVendedor || [];
  const meses: string[] = data?.meses || [];
  const mesCorrente: string = data?.mesCorrente || "";
  // O ano do FIM do período: é o que os gráficos embutidos usam para abrir.
  const ano = Number(fim.slice(0, 4));

  // De depois de Até é digitação, não intenção: arruma sozinho em vez de pedir
  // ao servidor uma janela invertida.
  useEffect(() => { if (ini > fim) setFim(ini); }, [ini, fim]);

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
  /** Quem entra no quadro "Resumo por vendedor" — ver ehContaDeServico/temCarteira. */
  const resumoVendedores = useMemo(
    () => vendedores.filter((v) => !ehContaDeServico(v) && temCarteira(v)),
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

  // ── os dois últimos meses do período ──────────────────────────────────────
  // A coluna de variação compara o ÚLTIMO mês do período com o anterior a ele.
  // Antes dependia de escolher um mês no filtro; agora que o filtro é uma
  // faixa, o "mês da pergunta" é naturalmente o último — e com um mês só no
  // período não há o que comparar.
  const mesFoco = meses.length ? meses[meses.length - 1] : "";
  const mesAnt = meses.length > 1 ? meses[meses.length - 2] : "";
  const temAnterior = !!mesAnt;
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
    const dir = ord.dir === "asc" ? 1 : -1;
    // .trim(): nome com espaco na frente existe no cadastro e, sem isto, ele
    // fura a ordem alfabetica e aparece antes do "2 IRMAOS" — o usuario ve uma
    // lista "ordenada" com duas linhas fora de lugar e nao confia em mais nada.
    const txt = (s: any) => String(s || "").trim();
    const chave = (c: any): any => {
      if (ord.col === "cliente") return txt(c.nome);
      if (ord.col === "vendedor") return txt(c.vendedor);
      if (ord.col === "rede") return txt(c.rede);
      if (ord.col === "total") return Number(c.total) || 0;
      if (ord.col === "situacao") return c.ativo ? "Ativo" : "Inativo";
      if (ord.col === "ultima") return txt(c.ultimaCompra);
      if (ord.col === "ultimaValor") return Number(c.ultimaCompraValor) || 0;
      if (ord.col === "var") {
        const v = temAnterior ? variacao(noMes(c, mesFoco), noMes(c, mesAnt)) : null;
        return v === null ? -Infinity : v;
      }
      return noMes(c, ord.col); // uma coluna de mês
    };
    return [...arr].sort((a, b) => {
      const x = chave(a), y = chave(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "pt-BR") * dir;
      return (x - y) * dir;
    });
  }, [base, redeSel, busca, mesFoco, mesAnt, temAnterior, ord]);

  const ordenar = (col: string) =>
    setOrd((o) => (o.col === col ? { col, dir: o.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "cliente" || col === "vendedor" || col === "rede" ? "asc" : "desc" }));

  const totalMes = (m: string) => clientesTabela.reduce((s, c) => s + noMes(c, m), 0);
  const totalGeral = clientesTabela.reduce((s, c) => s + (Number(c.total) || 0), 0);

  const exportarTabela = () => {
    exportToExcel(clientesTabela.map((c) => {
      const row: any = { Cliente: c.nome, "CPF/CNPJ": c.doc || "", Vendedor: c.vendedor, Rede: c.rede || "", Cidade: c.cidade, Segmento: c.segmento, Situação: c.ativo ? "Ativo" : "Inativo" };
      row["Última compra"] = c.ultimaCompra || "";
      row["Valor da última compra"] = Number(c.ultimaCompraValor) || 0;
      for (const m of meses) row[rotMes(m)] = noMes(c, m);
      row["Total no período"] = c.total;
      if (temAnterior) row[`Variação ${rotMes(mesFoco)} vs ${rotMes(mesAnt)}`] = pct(variacao(noMes(c, mesFoco), noMes(c, mesAnt)));
      return row;
    }), `clientes-${ini}_a_${fim}-${modo === "sel" ? (umSo?.nome || `${selecionados.length}-vendedores`) : modo === "sem" ? "sem-vendedor" : "honest"}`);
  };

  const salvarInicio = async (valor: string | null) => {
    if (!umSo) return;
    await fetch("/api/reports/dossie-vendedores/inicio", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: umSo.id, data: valor }),
    });
    qc.invalidateQueries({ queryKey: ["/api/reports/dossie-vendedores"] });
  };

  // ── o filtro do topo é o filtro-mãe (Flavio, 14/11/2026) ──────────────────
  // Tudo abaixo do box já obedecia a ele, menos os gráficos, que tinham vida
  // própria: escolher "Gilmar M" em cima e continuar vendo as barras de toda a
  // Honest embaixo fazia a tela contar duas histórias ao mesmo tempo. Agora o
  // recorte desce por `vendedoresFiltro`: em "Toda a Honest" ele vai null e os
  // gráficos recuperam o seletor próprio de vendedores; com vendedor marcado,
  // esse seletor some e eles falam só de quem está marcado aqui.
  const vendedoresFiltro = useMemo<string[] | null>(() => {
    if (modo === "toda") return null;
    if (modo === "sem") return ["Sem vendedor"];   // é o nome que a API usa
    return selecionados.map((v) => String(v.nome || "")).filter(Boolean);
  }, [modo, selecionados]);

  const titulo = modo === "toda" ? "Toda a Honest"
    : modo === "sem" ? "Clientes sem vendedor"
    : umSo ? umSo.nome
    : selecionados.length ? `${selecionados.length} vendedores` : "Nenhum vendedor marcado";
  const origemInicio = umSo?.inicioAjustado ? "ajustada manualmente" : umSo?.primeiroPedido ? "1º pedido digitado" : "cadastro do usuário";

  // ── como o período se escreve na tela ─────────────────────────────────────
  const rotPeriodo = meses.length <= 1 ? rotMes(fim) : `${rotMes(ini)} a ${rotMes(fim)}`;

  // ── ATIVOS COM / SEM COMPRA NO PERÍODO ────────────────────────────────────
  // Era uma janela fixa de 3 meses; virou O PERÍODO DO FILTRO (Flavio,
  // 14/11/2026). O filtro-mãe passa a mandar também aqui: ano inteiro conta o
  // ano inteiro, um mês só conta aquele mês. Manter uma janela própria aqui
  // dentro era a tela ter dois períodos ao mesmo tempo.
  //
  // COM COMPRA = cliente ATIVO do recorte que faturou em algum mês do período.
  // SEM COMPRA é o resto da carteira ativa, POR SUBTRAÇÃO e não por uma segunda
  // contagem: a lista do período só traz quem comprou, então quem está parado
  // há mais tempo simplesmente não existe nela e seria invisível numa contagem
  // direta.
  const comprouEm = (c: any, ms: string[]) => ms.some((m) => noMes(c, m) > 0);
  const ativosComCompra = useMemo(
    () => base.filter((c) => c.ativo && comprouEm(c, meses)).length,
    [base, meses],
  );
  const ativosSemCompra = Math.max(0, consolidado.ativos - ativosComCompra);

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
              <label className="text-xs text-muted-foreground block">De (mês)</label>
              <Input type="month" value={ini} min="2025-01" max={fim} className="w-40" data-testid="dossie-de"
                onChange={(e) => { if (e.target.value) { setIni(e.target.value.slice(0, 7)); setLimite(100); } }} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block">Até (mês)</label>
              <Input type="month" value={fim} min={ini} max={mesHojeBR} className="w-40" data-testid="dossie-ate"
                onChange={(e) => { if (e.target.value) { setFim(e.target.value.slice(0, 7)); setLimite(100); } }} />
            </div>
            {/* Atalhos: os recortes que se pede toda hora, sem digitar data. */}
            <div className="flex gap-1">
              {([
                ["Este ano", `${anoAtual}-01`, mesHojeBR],
                ["Últimos 12 meses", somaMeses(mesHojeBR, -11), mesHojeBR],
                ["Este mês", mesHojeBR, mesHojeBR],
                ["Desde nov/25", "2025-11", mesHojeBR],
              ] as const).map(([rot, de, ate]) => (
                <Button key={rot} variant="outline" size="sm" data-testid={`dossie-atalho-${rot}`}
                  onClick={() => { setIni(de as string); setFim(ate as string); setLimite(100); }}>{rot}</Button>
              ))}
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
                <p className="border-t pt-2"><b>Por que as barras e a linha não batem.</b> São perguntas diferentes: a barra é <b>o que ele digitou</b>, a linha é <b>o que os clientes da carteira dele faturaram</b>. Elas só coincidiriam se ele digitasse todos os pedidos dos seus clientes e nenhum outro. Separam as duas: pedido que o telemarketing (ou outro vendedor) digitou para um cliente da carteira dele entra só na linha; pedido que ele digitou para cliente de outra carteira entra só na barra; a carteira é a de <b>hoje</b> aplicada ao período inteiro, então cliente que chegou em setembro leva o faturamento dele de janeiro para a linha; e pedido digitado não é nota autorizada — valor, cancelamento e a virada do mês deslocam os dois.</p>
                <p><b>Antes de abr/2026 a barra é zero</b> em quase todo mundo: o pipeline do INTEGRA só passou a receber os pedidos ali. Não é que não houve venda — é que ela não foi digitada aqui.</p>
                <p className="border-t pt-2"><b>De / Até:</b> é o filtro-mãe. Define o período de <b>toda</b> a tela — os cartões do topo, o resumo por vendedor, as listas, as colunas mês a mês e os dois gráficos. Pode atravessar a virada do ano (nov/25 a nov/26, por exemplo). Para olhar um mês só, ponha o mesmo mês nos dois campos.</p>
                <p><b>Ativos com / sem compra:</b> seguem o período inteiro. "Com compra" é o cliente <b>ativo</b> que faturou em algum mês da faixa; "sem compra" é o resto da carteira ativa, por subtração — a lista só traz quem comprou, então quem está parado há mais tempo não apareceria numa contagem direta.</p>
                <p><b>Última compra e valor:</b> são da <b>vida</b> do cliente, não do período — a pergunta é "quando ele comprou pela última vez", e essa resposta não pode mudar porque o filtro mudou. Por isso a data pode ser anterior ao "De" ou posterior ao "Até". Valor = o faturamento daquele dia inteiro (parcelas do mesmo pedido somadas).</p>
                <p><b>Setas:</b> comparam cada mês com o mês anterior na mesma linha. A última coluna compara o <b>último mês do período</b> com o mês antes dele. Passe o mouse para ver os dois valores e a variação.</p>
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
            {/* SEIS CARTÕES (Flavio, 13/11/2026). Saíram carteira, faturamento,
                vendas digitadas e inativados: o topo passou a responder "a
                carteira está sendo atendida?" em vez de "quanto entrou". */}
            <CardContent className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <Kpi titulo="Ativos com compra no período" valor={String(ativosComCompra)}
                sub={rotPeriodo} cor="text-emerald-700" />
              <Kpi titulo="Ativos sem compra no período" valor={String(ativosSemCompra)}
                sub={`de ${consolidado.ativos} ativos na carteira`} cor="text-red-700" />
              {modo !== "sem" && <Kpi titulo="Rezoneados para a carteira" valor={String(consolidado.herdados)}
                sub={`herdados · ${consolidado.herdadosAtivos} ativos`} />}
              {modo !== "sem" && <Kpi titulo="Clientes conquistados" valor={String(consolidado.conquistados.length)}
                sub={`${consolidado.conquistados.filter((c: any) => c.ativo).length} ativos`} />}
              {modo !== "sem" && <Kpi titulo="Leads cadastrados" valor={String(consolidado.leadsCad)}
                sub={`${consolidado.leadsAnd} em andamento · ${consolidado.leadsDesc} descartados`} />}
              {modo !== "sem" && <Kpi titulo="Leads convertidos" valor={String(consolidado.leadsConv)}
                sub={consolidado.leadsCad > 0 ? `${Math.round(consolidado.leadsConv / consolidado.leadsCad * 100)}% dos cadastrados` : "nenhum lead cadastrado"}
                cor="text-emerald-700" />}
            </CardContent>
            <div className="px-6 pb-4 -mt-1 text-xs text-muted-foreground">
              “Com compra” conta o cliente <b>ativo</b> que faturou em algum mês de <b>{rotPeriodo}</b>
              {meses.length > 1 ? ` (${meses.length} meses)` : ""}; “sem compra” é o resto da carteira ativa.
              {" "}Mudando o período no topo, os dois números mudam junto.
              {" "}Rezoneados, conquistados e leads são do cadastro de hoje, não do período.
            </div>
          </Card>

          {/* Os dois gráficos que moravam na aba "Gráficos" (Flavio, 13/11/2026):
              comparação entre os anos e evolução por vendedor.
              Eles abrem NO PERÍODO DO FILTRO-MÃE (14/11/2026) — era o que
              faltava para a tela inteira falar do mesmo recorte. `key` muda com
              o período, então trocar De/Até remonta os gráficos ali. Dentro do
              card o período continua livre: o comparativo já traz o ano
              anterior sozinho, então não é preciso alargar o filtro de cima
              para ver dois anos no eixo. */}
          <GraficosCarteira
            key={`${ini}_${fim}`}
            periodoInicial={{ inicio: ini, fim }}
            vendedoresFiltro={vendedoresFiltro}
          />

          <div className="space-y-4">
            {modo === "toda" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Resumo por vendedor</CardTitle>
                  <CardDescription>
                    {resumoVendedores.length} com carteira hoje. Clique em um nome para abrir o dossiê dele.
                    {vendedores.length - resumoVendedores.length > 0 &&
                      ` Fora do quadro: ${vendedores.length - resumoVendedores.length} contas sem carteira ou de serviço (administração, sistema, colaboradores).`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-muted-foreground border-b">
                      <th className="py-1">Vendedor</th><th>Tipo</th><th>Início</th><th className="text-right">Carteira</th><th className="text-right">Herdados</th>
                      <th className="text-right">Conquistados</th><th className="text-right">Inativou</th><th className="text-right">Leads</th>
                      <th className="text-right">Vendas no período</th><th className="text-right">Carteira no período</th></tr></thead>
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
                      <th className="py-1">Cliente</th><th>Entrada</th><th>Situação</th><th className="text-right">Vendas</th><th className="text-right">Total vendido</th><th className="text-right">No período</th></tr></thead>
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
                  <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {rotPeriodo}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-auto max-h-[420px]">
                  <SemVendedorTabela lista={semVendedor} rotPeriodo={rotPeriodo} />
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
                      <th className="py-1">Cliente</th><th>Vendedor</th><th>Entrada</th><th>Situação</th><th className="text-right">No período</th></tr></thead>
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
                <CardDescription>{semVendedor.length} clientes · {semVendedor.filter((c) => c.ativo).length} ativos · {brl(semVendedor.reduce((s, c) => s + c.fatAno, 0))} em {rotPeriodo}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-auto max-h-[420px]"><SemVendedorTabela lista={semVendedor} rotPeriodo={rotPeriodo} /></CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <CardTitle>Clientes que compraram no período — mês a mês</CardTitle>
                  <CardDescription>
                    {clientesTabela.length} clientes · {titulo} · {rotPeriodo} · faturamento em R$ por mês.
                    {" "}“Última compra” é a da <b>vida</b> do cliente, não do período — por isso pode ser mais
                    recente ou mais antiga do que as colunas.
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
                    <Th cod="situacao" atual={ord} onOrdenar={ordenar} className="whitespace-nowrap">Situação</Th>
                    <Th cod="ultima" atual={ord} onOrdenar={ordenar} className="whitespace-nowrap">Última compra</Th>
                    <Th cod="ultimaValor" atual={ord} onOrdenar={ordenar} className="text-right whitespace-nowrap">Valor da última</Th>
                    {meses.map((m) => (
                      <Th key={m} cod={m} atual={ord} onOrdenar={ordenar}
                        className={`text-right whitespace-nowrap ${m === mesFoco ? "bg-amber-50 text-amber-900 font-semibold" : ""}`}>
                        {rotMes(m)}{m === mesCorrente ? "*" : ""}
                      </Th>
                    ))}
                    {temAnterior && <Th cod="var" atual={ord} onOrdenar={ordenar} className="text-right whitespace-nowrap">{rotMes(mesFoco)} vs {rotMes(mesAnt)}</Th>}
                    <Th cod="total" atual={ord} onOrdenar={ordenar} className="px-3 text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {clientesTabela.slice(0, limite).map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="py-1 px-3">{c.nome}
                        <div className="text-xs text-muted-foreground">{c.cidade}</div></td>
                      {modo !== "sel" || !umSo ? <td className="px-2 whitespace-nowrap">{c.vendedor}</td> : null}
                      {redes.length > 0 && <td className="px-2 text-xs whitespace-nowrap">{c.rede || <span className="text-slate-300">—</span>}</td>}
                      {/* Situação em coluna própria e sempre escrita: antes só
                          o inativo era marcado, e a ausência de marca exigia
                          saber a regra para ler "ativo". */}
                      <td className="px-2 whitespace-nowrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${c.ativo ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                          {c.ativo ? "Ativo" : "Inativo"}
                        </span>
                      </td>
                      <td className="px-2 text-sm whitespace-nowrap">{c.ultimaCompra ? dataBR(c.ultimaCompra) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-2 text-sm text-right whitespace-nowrap">{c.ultimaCompraValor ? brl(c.ultimaCompraValor) : <span className="text-slate-300">—</span>}</td>
                      {meses.map((m, i) => {
                        const v = noMes(c, m);
                        const ant = i > 0 ? noMes(c, meses[i - 1]) : null;
                        return (
                          <td key={m} className={`px-2 text-right whitespace-nowrap ${v ? "" : "text-slate-300"} ${m === mesFoco ? "bg-amber-50" : ""}`}>
                            {v ? brl(v) : "—"}
                            <Seta atual={v} anterior={ant} />
                          </td>
                        );
                      })}
                      {temAnterior && (
                        <td className={`px-2 text-right whitespace-nowrap font-medium ${
                          (variacao(noMes(c, mesFoco), noMes(c, mesAnt)) ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {pct(variacao(noMes(c, mesFoco), noMes(c, mesAnt)))}
                        </td>
                      )}
                      <td className="px-3 text-right font-semibold whitespace-nowrap">{brl(c.total)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold bg-slate-50 sticky bottom-0">
                    <td className="py-2 px-3">Total ({clientesTabela.length})</td>
                    {modo !== "sel" || !umSo ? <td></td> : null}
                    {redes.length > 0 && <td></td>}
                    <td className="px-2 text-xs font-normal text-muted-foreground whitespace-nowrap">
                      {clientesTabela.filter((c) => c.ativo).length} ativos
                    </td>
                    <td></td>
                    <td className="px-2 text-right whitespace-nowrap">{brl(clientesTabela.reduce((s2, c) => s2 + (Number(c.ultimaCompraValor) || 0), 0))}</td>
                    {meses.map((m, i) => {
                      const v = totalMes(m);
                      const ant = i > 0 ? totalMes(meses[i - 1]) : null;
                      return (
                        <td key={m} className={`px-2 text-right whitespace-nowrap ${m === mesFoco ? "bg-amber-100" : ""}`}>
                          {brl(v)}<Seta atual={v} anterior={ant} />
                        </td>
                      );
                    })}
                    {temAnterior && <td className="px-2 text-right">{pct(variacao(totalMes(mesFoco), totalMes(mesAnt)))}</td>}
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

function SemVendedorTabela({ lista, rotPeriodo }: { lista: any[]; rotPeriodo: string }) {
  // COLUNAS CENTRALIZADAS (Flavio, 13/11/2026), com duas exceções que são de
  // leitura, não de gosto: o MOTIVO é frase corrida — centrado, cada linha
  // começa num ponto diferente e a coluna deixa de ser varrível; e o VALOR fica
  // à direita, que é como número se compara (a mesma regra que ele já pediu nas
  // exportações: texto centralizado, dinheiro à direita).
  const c = "px-2 text-center";
  // Ordenação A-Z em Cliente, Cidade e Situação (Flavio, 13/11/2026). O VALOR
  // também ordena, de propósito: sem ele não haveria volta para a ordem de
  // entrada da lista (maior faturamento primeiro) depois do primeiro clique.
  const [ord, setOrd] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "valor", dir: "desc" });
  const ordenar = (col: string) =>
    setOrd((o) => (o.col === col ? { col, dir: o.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "valor" ? "desc" : "asc" }));

  const linhas = useMemo(() => {
    const dir = ord.dir === "asc" ? 1 : -1;
    const chave = (x: any): any => {
      if (ord.col === "cliente") return String(x.nome || "").trim();
      if (ord.col === "cidade") return String(x.cidade || "").trim();
      // Situação: Ativo antes de Inativo em A-Z, e dentro de cada grupo a data
      // da inativação, que é o que se quer ver depois de agrupar por situação.
      if (ord.col === "situacao") return `${x.ativo ? "0 Ativo" : "1 Inativo"} ${x.inativado || ""}`;
      return Number(x.fatAno) || 0;
    };
    return [...lista].sort((a, b) => {
      const x = chave(a), y = chave(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "pt-BR") * dir;
      return (x - y) * dir;
    });
  }, [lista, ord]);

  const total = useMemo(() => linhas.reduce((s, x) => s + (Number(x.fatAno) || 0), 0), [linhas]);
  const seta = (col: string) => (
    <span className={ord.col === col ? "text-slate-700" : "text-transparent group-hover:text-slate-300"}>
      {ord.col === col && ord.dir === "asc" ? "▲" : "▼"}
    </span>
  );
  const Cab = ({ col, children, className = c }: { col: string; children: any; className?: string }) => (
    <th className={`${className} cursor-pointer select-none group`} onClick={() => ordenar(col)}
      title="Clique para ordenar; clique de novo para inverter">
      <span className="inline-flex items-center gap-0.5">{children}{seta(col)}</span>
    </th>
  );

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-white z-10"><tr className="text-muted-foreground border-b">
        <Cab col="cliente" className={`py-1 ${c}`}>Cliente</Cab>
        <th className={c}>Último vendedor</th>
        <Cab col="cidade">Cidade</Cab>
        <Cab col="situacao">Situação</Cab>
        <th className="px-2 text-left min-w-[260px]">Motivo da inativação</th>
        <th className={c}>Entrada</th>
        <Cab col="valor" className="px-2 text-right">Em {rotPeriodo}</Cab></tr></thead>
      <tbody>
        {linhas.map((x) => (
          <tr key={x.id} className="border-b last:border-0">
            <td className={`py-1 ${c}`}>{x.nome}</td>
            {/* Sem linha no histórico não quer dizer "nunca teve vendedor": quer
                dizer que a troca não foi registrada (auditoria desde set/2026).
                Dizer isso evita que a coluna vazia vire conclusão errada. */}
            <td className={c}>
              {x.ultimoVendedor || <span className="text-amber-700 text-xs">não registrado</span>}
            </td>
            <td className={c}>{x.cidade}</td>
            <td className={`${c} ${x.ativo ? "text-emerald-700" : "text-red-700"}`}>
              {x.ativo ? "Ativo" : "Inativo"}
              {!x.ativo && x.inativado && <div className="text-xs text-muted-foreground">{dataBR(x.inativado)}</div>}
            </td>
            <td className="px-2 text-left text-xs">
              {x.ativo ? <span className="text-slate-300">—</span>
                : x.motivo ? x.motivo
                : <span className="text-amber-700">não registrado</span>}
            </td>
            <td className={c}>{dataBR(x.conquista)}</td>
            <td className="px-2 text-right">{brl(x.fatAno)}</td>
          </tr>
        ))}
        {/* Somatório preso no rodapé: a lista passa de 4 mil linhas e o total
            tem que continuar à vista enquanto se rola. */}
        <tr className="border-t-2 font-semibold bg-slate-50 sticky bottom-0">
          <td className={`py-2 ${c}`}>Total ({linhas.length.toLocaleString("pt-BR")})</td>
          <td colSpan={5} />
          <td className="px-2 text-right">{brl(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}
