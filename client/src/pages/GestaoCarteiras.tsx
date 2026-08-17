import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LineChart, Line, BarChart, Bar, LabelList, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Briefcase, Users, TrendingUp, Wallet, Download, Info, Search, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { exportToExcel, MultiSelect } from "@/lib/tableTools";

// ── Paleta validada (scripts/validate_palette.js — light, surface #ffffff) ──────
// Classe e ordinal: rampa de UM tom (azul), escuro (A) -> claro (D).
// PJ/PF e categorico: slots 1 e 2 da ordem fixa; cinza para "nao identificado".
const COR_TIPO: Record<string, string> = { PJ: "#2a78d6", PF: "#eb6834", "Não identificado": "#898781" };
const CINZA = "#898781";
// Barras da situação da carteira — ordem importa: a validação é por par
// adjacente (azul→vermelho→âmbar→violeta passa em todas as checagens).
const COR_BARRA = { faturamento: "#2a78d6", debito: "#d03b3b", inativos: "#eda100", perdidos: "#4a3aa7" };
const SERIE_TITULOS = "#2a78d6";
const SERIE_NF = "#eb6834";

const BRL = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const BRL0 = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const NUM = (v: any) => Number(v || 0).toLocaleString("pt-BR");
const MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (m: string) => {
  const [a, b] = String(m || "").split("-");
  return b ? `${MES_ABREV[Number(b) - 1]}/${a.slice(2)}` : m;
};

type Cliente = {
  chave: string; doc: string | null; nome: string; tipo: string; vendedor: string; cidade: string;
  segmento: string; cadastrado: boolean; ativo: boolean; total: number; titulos: number;
  mesesComCompra: number; primeiraCompra: string | null; ultimaCompra: string | null;
  mediaSimples: number; mediaPonderada: number;
  potencialMes: number; debito: number; situacao: "ativo" | "inativo" | "perdido"; mesesSemComprar: number;
  // Classe do cliente: letra = nivel de faturamento, sinal = positivacao de pagamento.
  classe?: string; pontualidade?: number | null; titulosMedidos?: number;
  piorAtraso?: number; atrasoMedio?: number; diasVencido?: number;
};

/** As 8 classes na ordem da tela. Mesma lista do servidor (CLASSES_ORDEM). */
const CLASSES_ORDEM = ["A+", "A-", "B+", "B-", "C+", "C-", "D+", "D-"];
const CLASSE_COR: Record<string, string> = { A: "#184f95", B: "#3987e5", C: "#86b6ef", D: "#c8ddf8" };

function KpiCard(props: { icon: any; titulo: string; valor: string; nota?: string; cor?: string }) {
  const Icon = props.icon;
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Icon className="h-4 w-4" />{props.titulo}
        </div>
        <p className={`text-2xl font-bold ${props.cor || ""}`}>{props.valor}</p>
        {props.nota ? <p className="text-xs text-muted-foreground">{props.nota}</p> : null}
      </CardContent>
    </Card>
  );
}

/** "Gilmar M (240)" -> "Gilmar M". A contagem entre parênteses muda com o
 *  período, então ela nunca pode fazer parte da chave de comparação. */
const baseNome = (r: string) => String(r || "").replace(/\s*\([\d.,]+\)\s*$/, "").trim();

/** Rótulo dentro da fatia: só nas fatias com folga (>=6%), para não colidir. */
const rotuloFatia = (p: any) => (p.percent >= 0.06 ? `${(p.percent * 100).toFixed(0)}%` : "");

export default function GestaoCarteiras() {
  const hoje = new Date();
  const mesHoje = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const [inicio, setInicio] = useState("2025-01");
  const [fim, setFim] = useState(mesHoje);
  const [vendedores, setVendedores] = useState<string[]>([]); // vazio = todos
  const [visao, setVisao] = useState<"situacao" | "clientes">("situacao");
  const [balde, setBalde] = useState<"inativos" | "perdidos" | "debito">("inativos");
  const [ordem, setOrdem] = useState<"total" | "ponderada">("total");
  const [classeSel, setClasseSel] = useState<"todas" | "A" | "B" | "C" | "D">("todas");
  const [sinalSel, setSinalSel] = useState<"todos" | "+" | "-">("todos");
  const [busca, setBusca] = useState("");
  // Ordenacao por coluna (A-Z / Z-A). Vazio = manda o botao "Por faturamento
  // total / Por media ponderada". Terceiro clique na mesma coluna desliga.
  const [ordCol, setOrdCol] = useState("");
  const [ordDir, setOrdDir] = useState<"asc" | "desc">("asc");
  // Aba do quadro de ticket medio: a distribuicao crua ou a classe A+/A-/.../D-.
  const [abaQuadro, setAbaQuadro] = useState<"ticket" | "classes">("ticket");
  const [visiveis, setVisiveis] = useState(50);

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/reports/gestao-carteiras", inicio, fim],
    queryFn: async () => {
      const r = await fetch(`/api/reports/gestao-carteiras?inicio=${inicio}&fim=${fim}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar o dashboard de carteiras");
      return r.json();
    },
  });

  // Vendedores ATIVOS -- mesma fonte usada em "Vendedores" e no filtro de
  // "Clientes Ativos". O dropdown de vendedor lista somente quem esta ativo.
  const { data: vendedoresAtivos = [] } = useQuery<Array<{ id: string; name: string; allIds?: string[] }>>({
    queryKey: ["/api/sellers/active"],
    staleTime: 30000,
  });

  const d = data || {};
  const meses: string[] = d?.periodo?.meses || [];
  const todos: Cliente[] = d?.clientes || [];

  // Normaliza o nome do vendedor igual a dedup do endpoint /api/sellers/active.
  const normVend = (s: any) => String(s || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const nomesAtivos = useMemo(
    () => new Set((vendedoresAtivos || []).map((s: any) => normVend(s.name))),
    [vendedoresAtivos],
  );
  // Opcoes do dropdown: so vendedores ativos. Se a lista de ativos ainda nao
  // carregou (ou vier vazia), cai para todos -- evita esvaziar o filtro.
  const vendedoresDropdown = useMemo(() => {
    const lista: any[] = d?.vendedores || [];
    return nomesAtivos.size ? lista.filter((v: any) => nomesAtivos.has(normVend(v.vendedor))) : lista;
  }, [d, nomesAtivos]);

  // Rotulo do dropdown = nome + quantos clientes ele tem NO PERIODO escolhido.
  const opcoesVend = useMemo(
    () => vendedoresDropdown.map((v: any) => `${v.vendedor} (${v.clientes})`),
    [vendedoresDropdown],
  );
  // O rotulo carrega a contagem, e a contagem MUDA quando o periodo muda
  // ("Gilmar M (240)" vira "Gilmar M (233)"). Por isso o filtro casa pelo NOME,
  // nunca pelo rotulo inteiro — foi o que zerou a tela ao trocar o mes de inicio.
  const nomesSel = useMemo(() => new Set(vendedores.map(baseNome)), [vendedores]);

  // E, quando as opcoes se renovam, remapeia a selecao para os rotulos novos,
  // senao o checkbox aparece desmarcado mesmo com o filtro valendo.
  useEffect(() => {
    if (!opcoesVend.length) return;
    setVendedores((prev) => {
      if (!prev.length) return prev;
      const porNome = new Map(opcoesVend.map((o) => [baseNome(o), o]));
      const next = prev.filter((r) => porNome.has(baseNome(r))).map((r) => porNome.get(baseNome(r)) as string);
      const igual = next.length === prev.length && next.every((v, i) => v === prev[i]);
      return igual ? prev : next;
    });
  }, [opcoesVend]);

  const filtrarVend = nomesSel.size > 0;
  // Filtro PJ / PF: vazio = todos. Recorta a carteira inteira (KPIs, ABC, faixas, listas).
  const [tipoPessoa, setTipoPessoa] = useState<string>("");
  // Como o filtro aparece em varias frases: 1 vendedor mostra o nome, mais de um
  // vira "nas N carteiras selecionadas".
  const rotuloCarteira = !filtrarVend
    ? ""
    : nomesSel.size === 1
      ? ` na carteira de ${Array.from(nomesSel)[0]}`
      : ` nas ${nomesSel.size} carteiras selecionadas`;

  const filtrarTipo = tipoPessoa !== "";
  const filtrando = filtrarVend || filtrarTipo;
  const clientes = useMemo(() => {
    let out = filtrarVend ? todos.filter((c) => nomesSel.has(c.vendedor)) : todos;
    if (filtrarTipo) out = out.filter((c) => c.tipo === tipoPessoa);
    return out;
  }, [todos, nomesSel, filtrarVend, filtrarTipo, tipoPessoa]);

  // A classe (A+/A-/.../D-) vem pronta do servidor em cada cliente: a letra e o
  // nivel de faturamento (ticket medio) e o sinal e a positivacao de pagamento.
  // Diferente da antiga curva ABC, ela NAO depende do recorte da tela — o mesmo
  // cliente tem a mesma classe com ou sem filtro de vendedor.
  const classeLabelDe = (c: Cliente) => String(c.classe || "");
  const letraDe = (c: Cliente) => classeLabelDe(c).charAt(0) || "D";
  const sinalDe = (c: Cliente) => (classeLabelDe(c).charAt(1) === "+" ? "+" : "-");

  // Quantidade de clientes por faixa de TICKET MEDIO (substituiu a pizza PJ x PF).
  // Ticket medio = potencialMes: total do cliente ÷ meses em que ele comprou.
  // Sem filtro usamos o calculo do servidor (a lista da tela vem truncada em 2000).
  const faixas = useMemo(() => {
    if (!filtrando) return d?.faixasTicket || [];
    return (d?.faixasTicket || []).map((f: any) => {
      const dentro = clientes.filter((c) => c.potencialMes >= f.min && (f.max == null || c.potencialMes <= f.max));
      return {
        ...f,
        clientes: dentro.length,
        pj: dentro.filter((c) => c.tipo === "PJ").length,
        pf: dentro.filter((c) => c.tipo === "PF").length,
        valor: dentro.reduce((s: number, c: any) => s + c.total, 0),
        faturamentoMes: dentro.reduce((s: number, c: any) => s + c.mediaSimples, 0),
      };
    });
  }, [d, clientes, filtrando]);
  const faixasTotais = useMemo(() => ({
    clientes: faixas.reduce((s: number, f: any) => s + (f.clientes || 0), 0),
    pj: faixas.reduce((s: number, f: any) => s + (f.pj || 0), 0),
    pf: faixas.reduce((s: number, f: any) => s + (f.pf || 0), 0),
    faturamentoMes: faixas.reduce((s: number, f: any) => s + (f.faturamentoMes || 0), 0),
  }), [faixas]);
  // CLASSE A+/A-/.../D- — mesma logica do servidor, so agrupando o campo `classe`
  // NOTA A+/A-/.../D- — mesma logica do servidor, so agrupando o campo `nota`
  // que ja vem pronto em cada cliente (assim tela e API nunca divergem).
  const classes = useMemo(() => {
    if (!filtrando) return d?.classes || [];
    const base: any[] = d?.classes || [];
    return CLASSES_ORDEM.map((n) => {
      const dentro = clientes.filter((c) => c.classe === n);
      return {
        classe: n,
        letra: n[0],
        sinal: n[1],
        label: base.find((b: any) => b.classe === n)?.label || "",
        clientes: dentro.length,
        pj: dentro.filter((c) => c.tipo === "PJ").length,
        pf: dentro.filter((c) => c.tipo === "PF").length,
        valor: dentro.reduce((s: number, c: any) => s + c.total, 0),
        faturamentoMes: dentro.reduce((s: number, c: any) => s + c.mediaSimples, 0),
        debito: dentro.reduce((s: number, c: any) => s + (c.debito || 0), 0),
        comDebito: dentro.filter((c) => (c.debito || 0) > 0).length,
        semMedicao: dentro.filter((c) => c.pontualidade == null).length,
      };
    });
  }, [d, clientes, filtrando]);
  const classesTotais = useMemo(() => ({
    clientes: classes.reduce((s: number, n: any) => s + (n.clientes || 0), 0),
    faturamentoMes: classes.reduce((s: number, n: any) => s + (n.faturamentoMes || 0), 0),
    debito: classes.reduce((s: number, n: any) => s + (n.debito || 0), 0),
    semMedicao: classes.reduce((s: number, n: any) => s + (n.semMedicao || 0), 0),
  }), [classes]);

  // Lista que sustenta as barras: um balde por vez, ordenada pelo que importa
  // em cada um (potencial nos parados, valor em aberto no débito).
  const listaSituacao = useMemo(() => {
    if (balde === "debito") {
      return clientes.filter((c) => (c.debito || 0) > 0).sort((a, b) => b.debito - a.debito);
    }
    const alvo = balde === "inativos" ? "inativo" : "perdido";
    return clientes.filter((c) => c.situacao === alvo).sort((a, b) => b.potencialMes - a.potencialMes);
  }, [clientes, balde]);

  const totalSituacao = useMemo(
    () => listaSituacao.reduce((s, c) => s + (balde === "debito" ? c.debito : c.potencialMes), 0),
    [listaSituacao, balde],
  );

  // A série do gráfico segue o período; com filtro de vendedor ela é recomposta
  // a partir dos clientes daquela carteira (por isso o back manda porMes).
  const serie = useMemo(() => {
    const base: any[] = d?.serie || [];
    if (!filtrarVend) return base;
    const soma = new Map<string, number>();
    for (const c of clientes as any[]) {
      for (const [m, v] of Object.entries(c.porMes || {})) soma.set(m, (soma.get(m) || 0) + (Number(v) || 0));
    }
    return meses.map((m) => ({ mes: m, valor: soma.get(m) || 0, titulos: 0, clientes: 0, valorNf: null }));
  }, [d, clientes, meses, filtrarVend]);

  const kpis = useMemo(() => {
    if (!filtrarVend) return d?.kpis || {};
    const tot = clientes.reduce((s, c) => s + c.total, 0);
    const ult = serie[serie.length - 1];
    const pen = serie.length > 1 ? serie[serie.length - 2] : null;
    return {
      faturamento: tot,
      clientes: clientes.length,
      mediaMensal: meses.length ? tot / meses.length : 0,
      ticketMedioCliente: clientes.length ? tot / clientes.length : 0,
      mesAtual: ult?.valor || 0,
      mesAtualLabel: ult?.mes || null,
      mesAnterior: pen?.valor || 0,
      varPct: pen && pen.valor > 0 && ult ? ((ult.valor - pen.valor) / pen.valor) * 100 : null,
    };
  }, [d, clientes, serie, meses, filtrarVend]);

  // Contagem por letra da classe dentro do recorte atual (vendedor/PJ-PF), para os chips.
  const porLetra = useMemo(() => {
    const acc: Record<string, { clientes: number; valor: number; mais: number; menos: number }> = {
      A: { clientes: 0, valor: 0, mais: 0, menos: 0 }, B: { clientes: 0, valor: 0, mais: 0, menos: 0 },
      C: { clientes: 0, valor: 0, mais: 0, menos: 0 }, D: { clientes: 0, valor: 0, mais: 0, menos: 0 },
    };
    for (const c of clientes) {
      const k = letraDe(c);
      if (!acc[k]) continue;
      acc[k].clientes++; acc[k].valor += c.total;
      if (sinalDe(c) === "+") acc[k].mais++; else acc[k].menos++;
    }
    return acc;
  }, [clientes]);
  const totalMais = useMemo(() => clientes.filter((c) => sinalDe(c) === "+").length, [clientes]);

  // MAIOR ATRASO do cliente: o pior atraso entre os títulos que ele já pagou no
  // período e o atraso do título que está vencido AGORA (esse ainda está correndo,
  // então também conta). `null` = nenhum título com data de baixa e nada vencido,
  // ou seja, não há do que medir atraso.
  const maiorAtraso = (c: Cliente): number | null => {
    const pago = Number(c.piorAtraso || 0);
    const correndo = Number(c.diasVencido || 0);
    const pior = Math.max(pago, correndo);
    if (pior > 0) return pior;
    return (c.titulosMedidos || 0) > 0 ? 0 : null;
  };

  // Valor usado na ordenação de cada coluna clicável (texto ordena A-Z, número por valor).
  const valorDaColuna = (c: Cliente, k: string): string | number => {
    switch (k) {
      case "nome": return c.nome || "";
      case "tipo": return c.tipo || "";
      case "classe": return c.classe || "";
      case "vendedor": return c.vendedor || "";
      case "total": return c.total || 0;
      case "debito": return c.debito || 0;
      case "atraso": return maiorAtraso(c) ?? -1;
      default: return "";
    }
  };
  // 1º clique = A-Z, 2º = Z-A, 3º volta para a ordem do botão.
  const clicarColuna = (k: string) => {
    if (ordCol !== k) { setOrdCol(k); setOrdDir("asc"); return; }
    if (ordDir === "asc") { setOrdDir("desc"); return; }
    setOrdCol(""); setOrdDir("asc");
  };

  const thOrdenavel = (k: string, label: string, cls = "", direita = false) => {
    const ativa = ordCol === k;
    return (
      <TableHead
        className={`cursor-pointer select-none group ${cls}`}
        onClick={() => clicarColuna(k)}
        title={ativa ? (ordDir === "asc" ? "Ordenado A-Z — clique para Z-A" : "Ordenado Z-A — clique para voltar ao padrão") : "Clique para ordenar A-Z"}
        aria-sort={ativa ? (ordDir === "asc" ? "ascending" : "descending") : "none"}
        data-testid={`th-ordenar-${k}`}
      >
        <span className={`inline-flex items-center gap-1 ${direita ? "flex-row-reverse" : ""}`}>
          <span>{label}</span>
          {ativa ? (
            ordDir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0 opacity-70" /> : <ArrowDown className="h-3 w-3 shrink-0 opacity-70" />
          ) : (
            <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-40 transition-opacity" />
          )}
        </span>
      </TableHead>
    );
  };

  // Relação completa: filtra por classe (letra e sinal) e por busca, e ordena pelo critério escolhido.
  const listaFiltrada = useMemo(() => {
    const alvo = busca.trim().toLocaleLowerCase("pt-BR");
    // So-digitos da busca. Sem esse guarda, procurar por texto casaria com TODO
    // mundo: "moreira".replace(/\D/g,"") vira "" e includes("") e sempre true.
    const alvoDoc = alvo.replace(/\D/g, "");
    const arr = clientes.filter((c) => {
      if (classeSel !== "todas" && letraDe(c) !== classeSel) return false;
      if (sinalSel !== "todos" && sinalDe(c) !== sinalSel) return false;
      if (!alvo) return true;
      return (
        c.nome.toLocaleLowerCase("pt-BR").includes(alvo) ||
        (c.cidade || "").toLocaleLowerCase("pt-BR").includes(alvo) ||
        (c.vendedor || "").toLocaleLowerCase("pt-BR").includes(alvo) ||
        (alvoDoc.length >= 3 && (c.doc || "").includes(alvoDoc))
      );
    });
    if (ordCol) {
      const dir = ordDir === "asc" ? 1 : -1;
      arr.sort((a, b) => {
        const va = valorDaColuna(a, ordCol);
        const vb = valorDaColuna(b, ordCol);
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(va).localeCompare(String(vb), "pt-BR") * dir;
      });
    } else {
      arr.sort((a, b) => (ordem === "total" ? b.total - a.total : b.mediaPonderada - a.mediaPonderada));
    }
    return arr;
  }, [clientes, classeSel, sinalSel, busca, ordem, ordCol, ordDir]);

  // Mexeu no filtro, volta para o começo da lista.
  useEffect(() => { setVisiveis(50); }, [classeSel, sinalSel, busca, ordem, ordCol, ordDir, vendedores, inicio, fim]);

  const listaVisivel = useMemo(() => listaFiltrada.slice(0, visiveis), [listaFiltrada, visiveis]);
  const totalFiltrado = useMemo(() => listaFiltrada.reduce((s, c) => s + c.total, 0), [listaFiltrada]);
  const debitoFiltrado = useMemo(() => listaFiltrada.reduce((s, c) => s + (c.debito || 0), 0), [listaFiltrada]);

  // ── Situação da carteira (4 barras) ───────────────────────────────────────
  // Fluxos em R$/mês; o débito é estoque (total vencido em aberto hoje) e vai
  // rotulado como tal. Tudo sai da lista já filtrada por vendedor.
  const barras = useMemo(() => {
    const totalPeriodo = clientes.reduce((s, c) => s + c.total, 0);
    const fatMes = meses.length ? totalPeriodo / meses.length : 0;
    const debito = clientes.reduce((s, c) => s + (c.debito || 0), 0);
    const inat = clientes.filter((c) => c.situacao === "inativo");
    const perd = clientes.filter((c) => c.situacao === "perdido");
    const soma = (arr: Cliente[]) => arr.reduce((s, c) => s + (c.potencialMes || 0), 0);
    return [
      { chave: "faturamento", nome: "Faturamento", valor: fatMes, cor: COR_BARRA.faturamento, unidade: "por mês", nota: `${NUM(clientes.length)} clientes · ${BRL0(totalPeriodo)} no período`, clientes: clientes.length },
      { chave: "debito", nome: "Débito da carteira", valor: debito, cor: COR_BARRA.debito, unidade: "vencido em aberto", nota: `${NUM(clientes.filter((c) => (c.debito || 0) > 0).length)} clientes com título vencido`, clientes: clientes.filter((c) => (c.debito || 0) > 0).length },
      { chave: "inativos", nome: "Inativos", valor: soma(inat), cor: COR_BARRA.inativos, unidade: "potencial por mês", nota: `${NUM(inat.length)} clientes com cadastro inativado`, clientes: inat.length },
      { chave: "perdidos", nome: "Perdidos", valor: soma(perd), cor: COR_BARRA.perdidos, unidade: "potencial por mês", nota: `${NUM(perd.length)} clientes sem comprar há 3+ meses`, clientes: perd.length },
    ];
  }, [clientes, meses]);

  const opcoesMes = useMemo(() => {
    const out: string[] = [];
    let y = 2025, m = 1;
    while (`${y}-${String(m).padStart(2, "0")}` <= mesHoje) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }, [mesHoje]);

  const exportar = () => {
    exportToExcel(
      listaFiltrada
        .map((c, i) => ({
          "#": i + 1, Cliente: c.nome, "CPF/CNPJ": c.doc || "", Tipo: c.tipo,
          Classe: c.classe || "", Vendedor: c.vendedor, Cidade: c.cidade, Segmento: c.segmento,
          "Faturamento no período": Number(c.total.toFixed(2)),
          "Média ponderada/mês": Number(c.mediaPonderada.toFixed(2)),
          "Média simples/mês": Number(c.mediaSimples.toFixed(2)),
          "Meses com compra": c.mesesComCompra, "Última compra": c.ultimaCompra || "",
          Situação: c.situacao, "Potencial/mês": Number((c.potencialMes || 0).toFixed(2)),
          "Débito vencido": Number((c.debito || 0).toFixed(2)),
          "Dias vencido": c.diasVencido || 0,
          "Pontualidade %": c.pontualidade == null ? "" : Number((c.pontualidade * 100).toFixed(1)),
          "Títulos medidos": c.titulosMedidos || 0,
          "Pior atraso pago (dias)": c.piorAtraso || 0,
          "Maior atraso (dias)": maiorAtraso(c) ?? "",
        })),
      `gestao-carteiras_${inicio}_a_${fim}${classeSel !== "todas" ? `_classe-${classeSel}` : ""}${sinalSel !== "todos" ? (sinalSel === "+" ? "_em-dia" : "_atrasa") : ""}${nomesSel.size === 1 ? `_${Array.from(nomesSel)[0].replace(/[^A-Za-z0-9]+/g, "-")}` : ""}`,
    );
  };

  const varPct = kpis?.varPct;

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />

      <div className="flex items-center gap-3">
        <Briefcase className="h-8 w-8 text-blue-600" />
        <div>
          <h1 className="text-3xl font-bold">Gestão de Carteiras — Vendas</h1>
          <p className="text-muted-foreground">
            Classe do cliente, perfil da carteira e evolução do faturamento de {labelMes(inicio)} a {labelMes(fim)}
          </p>
        </div>
      </div>

      {/* Filtros — uma linha acima dos gráficos */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">De</label>
            <Select value={inicio} onValueChange={setInicio}>
              <SelectTrigger className="w-[130px]" data-testid="select-inicio"><SelectValue /></SelectTrigger>
              <SelectContent>{opcoesMes.map((m) => <SelectItem key={m} value={m}>{labelMes(m)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Até</label>
            <Select value={fim} onValueChange={setFim}>
              <SelectTrigger className="w-[130px]" data-testid="select-fim"><SelectValue /></SelectTrigger>
              <SelectContent>{opcoesMes.map((m) => <SelectItem key={m} value={m}>{labelMes(m)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {/* Multipla escolha: vazio = todos os vendedores */}
          <div className="pt-[21px]">
            <MultiSelect
              label="Vendedor"
              options={opcoesVend}
              selected={vendedores}
              onChange={setVendedores}
              testId="select-vendedor"
            />
          </div>
          {/* Recorte PJ / PF da carteira inteira: vale para KPIs, ABC, faixas e listas. */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Tipo</label>
            <Select value={tipoPessoa || "todos"} onValueChange={(v) => setTipoPessoa(v === "todos" ? "" : v)}>
              <SelectTrigger className="w-[150px]" data-testid="select-tipo-pessoa">
                <SelectValue placeholder="PJ / PF" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">PJ e PF</SelectItem>
                <SelectItem value="PJ">Somente PJ</SelectItem>
                <SelectItem value="PF">Somente PF</SelectItem>
                <SelectItem value="Não identificado">Não identificado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto">
            <Button variant="outline" onClick={exportar} data-testid="button-export">
              <Download className="h-4 w-4 mr-2" />Exportar Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Carregando dados da carteira…</div>
      ) : error ? (
        <div className="text-center text-red-600 py-16">Não foi possível carregar o dashboard.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard icon={Wallet} titulo="Faturamento no período" valor={BRL0(kpis?.faturamento)}
              nota={`${meses.length} meses · média ${BRL0(kpis?.mediaMensal)}/mês`} cor="text-emerald-600" />
            <KpiCard icon={Users} titulo="Clientes que compraram" valor={NUM(kpis?.clientes)}
              nota={`ticket médio ${BRL0(kpis?.ticketMedioCliente)} no período`} />
            <KpiCard icon={TrendingUp} titulo={`Faturamento ${labelMes(kpis?.mesAtualLabel || fim)}`} valor={BRL0(kpis?.mesAtual)}
              nota={`${(kpis?.mesAtualLabel || fim) === mesHoje ? "mês em curso · " : ""}${varPct === null || varPct === undefined ? "sem base de comparação" : `${varPct >= 0 ? "+" : ""}${varPct.toFixed(1)}% vs mês anterior`}`}
              cor={varPct === null || varPct === undefined ? "" : varPct >= 0 ? "text-emerald-600" : "text-red-600"} />
            <KpiCard icon={Briefcase} titulo="Clientes classe A" valor={NUM(porLetra.A.clientes)}
              nota={`acima de R$ 1.501/mês · ${NUM(porLetra.A.mais)} pagam em dia`} cor="text-blue-700" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Barras — situação da carteira (substituiu a pizza da curva ABC) */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>{visao === "situacao" ? "Situação da carteira" : "Clientes por situação"}</CardTitle>
                    <CardDescription>
                      {visao === "situacao"
                        ? "Quanto entra e quanto está parado. Valores por mês, menos o débito, que é o total vencido em aberto hoje."
                        : "Quem está por trás de cada barra — clique no balde para trocar a lista"}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant={visao === "situacao" ? "default" : "outline"} onClick={() => setVisao("situacao")} data-testid="button-situacao">Situação</Button>
                    <Button size="sm" variant={visao === "clientes" ? "default" : "outline"} onClick={() => setVisao("clientes")} data-testid="button-lista-situacao">Clientes</Button>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="Como cada número é montado" data-testid="button-info-situacao">
                          <Info className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-[440px] max-w-[92vw] text-sm space-y-3">
                        {visao === "situacao" ? (
                          <>
                            <p className="text-muted-foreground">
                              Tudo abaixo respeita os filtros de cima: o período de {labelMes(inicio)} a {labelMes(fim)}
                              {filtrarVend ? `${rotuloCarteira}` : " e a carteira inteira"}. Cada cliente entra em um balde só.
                            </p>
                            <div>
                              <p className="font-semibold flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COR_BARRA.faturamento }} />
                                Faturamento — {BRL0(barras[0]?.valor)} por mês
                              </p>
                              <p className="text-muted-foreground mt-1">
                                O que foi faturado no período dividido pelos {meses.length} meses dele. Entram só títulos de <b>venda</b>:
                                ficam de fora cancelado, NF cancelada, devolução, troca, amostra, bonificação, remessa,
                                transferência entre as empresas do grupo (PURO, BARUC), aporte de sócio, empréstimo,
                                adiantamento e pedido mandado para a lixeira.
                              </p>
                            </div>
                            <div>
                              <p className="font-semibold flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COR_BARRA.debito }} />
                                Débito da carteira — {BRL0(barras[1]?.valor)}
                              </p>
                              <p className="text-muted-foreground mt-1">
                                Títulos <b>vencidos e ainda em aberto hoje</b> (valor do título menos o que já foi pago),
                                pela mesma régua da aba Contas a Receber. É uma foto de hoje, não do período — o período
                                define apenas de quais clientes estamos falando.
                              </p>
                            </div>
                            <div>
                              <p className="font-semibold flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COR_BARRA.inativos }} />
                                Inativos — {BRL0(barras[2]?.valor)} por mês
                              </p>
                              <p className="text-muted-foreground mt-1">
                                Clientes com o <b>cadastro inativado</b>. De cada um, o que ele faturava <b>nos meses em que
                                comprava</b> (total dele ÷ meses com compra) — não diluímos pelos meses parados. É uma conta
                                otimista: supõe que todos voltariam ao ritmo antigo.
                              </p>
                            </div>
                            <div>
                              <p className="font-semibold flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COR_BARRA.perdidos }} />
                                Perdidos — {BRL0(barras[3]?.valor)} por mês
                              </p>
                              <p className="text-muted-foreground mt-1">
                                Cadastro <b>ativo</b>, comprou em 3 meses ou mais e está <b>há 3 meses ou mais sem comprar</b> —
                                o churn que ninguém marcou. Mesmo cálculo de potencial dos inativos.
                                {meses.length < 6 ? " Atenção: com menos de 6 meses de período esta barra tende a zerar, porque não cabem 3 meses comprando mais 3 parado." : ""}
                              </p>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="font-semibold">Clientes por situação</p>
                            <p className="text-muted-foreground">
                              A lista nominal por trás das barras, no mesmo recorte de período e vendedor.
                            </p>
                            <ul className="text-muted-foreground list-disc pl-4 space-y-1">
                              <li><b>Inativos</b> — cadastro inativado. Mostra o potencial de cada um (o que faturava nos meses em que comprava) e há quanto tempo está parado.</li>
                              <li><b>Perdidos</b> — cadastro ativo, comprou em 3 meses ou mais e está há 3+ meses sem comprar.</li>
                              <li><b>Com débito</b> — quem tem título vencido em aberto hoje, do maior para o menor.</li>
                            </ul>
                            <p className="text-muted-foreground">
                              Um cliente pode aparecer em "com débito" e também em inativos ou perdidos — os dois primeiros
                              baldes é que são exclusivos entre si. O Exportar Excel lá em cima leva situação, potencial e
                              débito de todos os clientes.
                            </p>
                          </>
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {visao === "situacao" ? (
                  <>
                    <ResponsiveContainer width="100%" height={290}>
                      <BarChart data={barras} layout="vertical" margin={{ top: 8, right: 96, left: 8, bottom: 4 }} barCategoryGap="28%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#ececea" horizontal={false} />
                        <XAxis type="number" tickFormatter={(v: any) => (Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : String(v))}
                          tick={{ fontSize: 12, fill: "#898781" }} tickLine={false} axisLine={{ stroke: "#ececea" }} />
                        <YAxis type="category" dataKey="nome" width={140} tick={{ fontSize: 13, fill: "#52514e" }} tickLine={false} axisLine={false} />
                        <Tooltip
                          cursor={{ fill: "#00000008" }}
                          formatter={(v: any, _n: any, p: any) => [`${BRL(v)} (${p?.payload?.unidade})`, p?.payload?.nome]}
                          labelFormatter={() => ""}
                        />
                        <Bar dataKey="valor" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                          {barras.map((b) => <Cell key={b.chave} fill={b.cor} />)}
                          <LabelList dataKey="valor" position="right" formatter={(v: any) => BRL0(v)}
                            style={{ fontSize: 12, fontWeight: 600, fill: "#0b0b0b" }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-2 border-t pt-2 text-sm">
                      {barras.map((b) => (
                        <div key={b.chave} className="flex items-start justify-between gap-3 py-0.5">
                          <span className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: b.cor }} />
                            {b.nome} <span className="text-muted-foreground text-xs">({b.unidade}) · {b.nota}</span>
                          </span>
                          <span className="font-medium whitespace-nowrap">{BRL0(b.valor)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Baldes: trocam a lista sem sair do card */}
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      {([
                        { k: "inativos", rotulo: "Inativos", cor: COR_BARRA.inativos, n: clientes.filter((c) => c.situacao === "inativo").length },
                        { k: "perdidos", rotulo: "Perdidos", cor: COR_BARRA.perdidos, n: clientes.filter((c) => c.situacao === "perdido").length },
                        { k: "debito", rotulo: "Com débito", cor: COR_BARRA.debito, n: clientes.filter((c) => (c.debito || 0) > 0).length },
                      ] as const).map((b) => (
                        <button
                          key={b.k}
                          onClick={() => setBalde(b.k as any)}
                          data-testid={`chip-balde-${b.k}`}
                          className={`px-2.5 py-1.5 rounded-md border text-sm transition flex items-center gap-2 ${balde === b.k ? "border-foreground/40 bg-muted font-semibold" : "border-transparent bg-muted/40 hover:bg-muted"}`}
                        >
                          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: b.cor }} />
                          {b.rotulo} <span className="text-muted-foreground">{NUM(b.n)}</span>
                        </button>
                      ))}
                      <span className="ml-auto text-sm font-semibold whitespace-nowrap">
                        {BRL0(totalSituacao)}{balde === "debito" ? "" : "/mês"}
                      </span>
                    </div>

                    <div className="max-h-[268px] overflow-auto border rounded-md">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8">#</TableHead>
                            <TableHead>Cliente</TableHead>
                            <TableHead className="text-right whitespace-nowrap">
                              {balde === "debito" ? "Vencido em aberto" : "Potencial/mês"}
                            </TableHead>
                            <TableHead className="text-right w-20 whitespace-nowrap">Parado há</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {listaSituacao.slice(0, 200).map((c, i) => (
                            <TableRow key={c.chave} data-testid={`row-situacao-${i}`}>
                              <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                              <TableCell className="font-medium leading-tight">
                                {c.nome}
                                <span className="block text-xs text-muted-foreground">
                                  {c.vendedor}{c.cidade ? ` · ${c.cidade}` : ""}
                                  {balde === "debito" && c.situacao !== "ativo" ? ` · ${c.situacao}` : ""}
                                </span>
                              </TableCell>
                              <TableCell className="text-right font-semibold whitespace-nowrap">
                                {BRL(balde === "debito" ? c.debito : c.potencialMes)}
                              </TableCell>
                              <TableCell className="text-right text-sm whitespace-nowrap">
                                {c.mesesSemComprar >= 99 ? "—" : c.mesesSemComprar === 0 ? "comprou agora" : `${c.mesesSemComprar} ${c.mesesSemComprar === 1 ? "mês" : "meses"}`}
                              </TableCell>
                            </TableRow>
                          ))}
                          {listaSituacao.length === 0 ? (
                            <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              Nenhum cliente neste balde no recorte atual.
                            </TableCell></TableRow>
                          ) : null}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      {listaSituacao.length > 200
                        ? `Mostrando os 200 maiores de ${NUM(listaSituacao.length)} clientes.`
                        : `${NUM(listaSituacao.length)} clientes neste balde.`}
                      {" "}Use o Exportar Excel para a lista completa com situação, potencial e débito.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Quantidade de clientes por ticket médio + a classe A+/A-/.../D- */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>
                  {abaQuadro === "ticket" ? "Quantidade de clientes por ticket médio" : "Classe do cliente"}
                </CardTitle>
                <CardDescription>
                  {abaQuadro === "ticket" ? (
                    <>
                      Ticket médio = faturado no cliente ÷ meses em que ele comprou (o ritmo dele quando compra).
                      O faturamento da faixa é quanto ela entrega por mês no período.
                    </>
                  ) : (
                    <>
                      A <strong>letra</strong> é o nível de faturamento (o mesmo ticket médio ao lado, em 4 degraus).
                      O <strong>sinal</strong> é a positivação de pagamento: <strong>+</strong> para quem pagou ao menos
                      80% dos títulos em até 3 dias do vencimento <em>e</em> não deve nada hoje; <strong>−</strong> para
                      o resto.
                    </>
                  )}
                </CardDescription>
                {/* Abas do quadro */}
                <div className="flex gap-1 pt-2" role="tablist">
                  {([
                    { k: "ticket", t: "Ticket médio" },
                    { k: "classes", t: "Classe A–D" },
                  ] as const).map((a) => (
                    <button
                      key={a.k}
                      role="tab"
                      aria-selected={abaQuadro === a.k}
                      onClick={() => setAbaQuadro(a.k)}
                      data-testid={`tab-quadro-${a.k}`}
                      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                        abaQuadro === a.k
                          ? "bg-primary text-primary-foreground border-primary font-medium"
                          : "bg-background text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      {a.t}
                    </button>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                <div className={abaQuadro === "ticket" ? "overflow-x-auto" : "hidden"}>
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="text-left border-b">
                        <th className="py-2 pr-2 text-right w-20">Clientes</th>
                        <th className="py-2 px-1 text-right w-14">PJ</th>
                        <th className="py-2 px-1 text-right w-14">PF</th>
                        <th className="py-2 px-2">Ticket médio</th>
                        <th className="py-2 px-2 text-right w-16">%</th>
                        <th className="py-2 pl-2 text-right w-32">Fat. médio/mês</th>
                        <th className="py-2 pl-2 text-right w-20">% do fat.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {faixas.map((f: any) => (
                        <tr key={f.chave} className="border-b last:border-0" data-testid={`faixa-${f.chave}`}>
                          <td className="py-2 pr-2 text-right font-semibold">{NUM(f.clientes || 0)}</td>
                          <td className="py-2 px-1 text-right text-muted-foreground">{NUM(f.pj || 0)}</td>
                          <td className="py-2 px-1 text-right text-muted-foreground">{NUM(f.pf || 0)}</td>
                          <td className="py-2 px-2 whitespace-nowrap">{f.label}</td>
                          <td className="py-2 px-2 text-right">
                            {faixasTotais.clientes ? ((f.clientes / faixasTotais.clientes) * 100).toFixed(1).replace(".", ",") : "0,0"}%
                          </td>
                          <td className="py-2 pl-2 text-right font-medium whitespace-nowrap">{BRL0(f.faturamentoMes || 0)}</td>
                          <td className="py-2 pl-2 text-right text-muted-foreground">
                            {faixasTotais.faturamentoMes ? ((f.faturamentoMes / faixasTotais.faturamentoMes) * 100).toFixed(1).replace(".", ",") : "0,0"}%
                          </td>
                        </tr>
                      ))}
                      <tr className="font-semibold">
                        <td className="py-2 pr-2 text-right">{NUM(faixasTotais.clientes)}</td>
                        <td className="py-2 px-1 text-right">{NUM(faixasTotais.pj)}</td>
                        <td className="py-2 px-1 text-right">{NUM(faixasTotais.pf)}</td>
                        <td className="py-2 px-2">Total</td>
                        <td className="py-2 px-2 text-right">100,0%</td>
                        <td className="py-2 pl-2 text-right whitespace-nowrap">{BRL0(faixasTotais.faturamentoMes)}</td>
                        <td className="py-2 pl-2 text-right">100,0%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* ── Aba CLASSE ─────────────────────────────────────────────── */}
                <div className={abaQuadro === "classes" ? "overflow-x-auto" : "hidden"}>
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="text-left border-b">
                        <th className="py-2 pr-2 w-14">Classe</th>
                        <th className="py-2 px-2 text-right w-20">Clientes</th>
                        <th className="py-2 px-2 text-right w-16">%</th>
                        <th className="py-2 px-2">Nível de faturamento</th>
                        <th className="py-2 pl-2 text-right w-32">Fat. médio/mês</th>
                        <th className="py-2 pl-2 text-right w-28">Débito hoje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {classes.map((n: any) => (
                        <tr
                          key={n.classe}
                          className={`border-b last:border-0 ${n.sinal === "-" ? "" : "bg-muted/20"}`}
                          data-testid={`classe-${n.letra}${n.sinal === "+" ? "mais" : "menos"}`}
                        >
                          <td className="py-2 pr-2">
                            <span
                              className="inline-flex items-center justify-center min-w-[2.25rem] rounded px-1.5 py-0.5 text-xs font-bold text-white"
                              style={{
                                background: CLASSE_COR[n.letra] || CINZA,
                                color: n.letra === "D" ? "#0f172a" : "#ffffff",
                                opacity: n.sinal === "-" ? 0.75 : 1,
                              }}
                            >
                              {n.letra}
                              {n.sinal === "+" ? "+" : "−"}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-right font-semibold">{NUM(n.clientes || 0)}</td>
                          <td className="py-2 px-2 text-right text-muted-foreground">
                            {classesTotais.clientes ? ((n.clientes / classesTotais.clientes) * 100).toFixed(1).replace(".", ",") : "0,0"}%
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap">
                            {n.label}
                            <span className="text-muted-foreground">
                              {" · "}
                              {n.sinal === "+" ? "paga em dia" : "atrasa ou está devendo"}
                            </span>
                          </td>
                          <td className="py-2 pl-2 text-right font-medium whitespace-nowrap">{BRL0(n.faturamentoMes || 0)}</td>
                          <td
                            className={`py-2 pl-2 text-right whitespace-nowrap ${(n.debito || 0) > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}
                          >
                            {(n.debito || 0) > 0 ? BRL0(n.debito) : "—"}
                          </td>
                        </tr>
                      ))}
                      <tr className="font-semibold">
                        <td className="py-2 pr-2">Total</td>
                        <td className="py-2 px-2 text-right">{NUM(classesTotais.clientes)}</td>
                        <td className="py-2 px-2 text-right">100,0%</td>
                        <td className="py-2 px-2" />
                        <td className="py-2 pl-2 text-right whitespace-nowrap">{BRL0(classesTotais.faturamentoMes)}</td>
                        <td className="py-2 pl-2 text-right whitespace-nowrap text-destructive">{BRL0(classesTotais.debito)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                    A pontualidade é medida nos títulos do período que têm data de baixa registrada.
                    {classesTotais.semMedicao > 0 && (
                      <>
                        {" "}
                        <strong>{NUM(classesTotais.semMedicao)}</strong> cliente
                        {classesTotais.semMedicao === 1 ? " não tem" : "s não têm"} nenhum título com data de pagamento
                        (importação antiga trouxe o valor pago, mas não a data) — esse
                        {classesTotais.semMedicao === 1 ? "" : "s"} entra
                        {classesTotais.semMedicao === 1 ? "" : "m"} na classe só pelo débito de hoje.
                      </>
                    )}
                    {" "}A coluna Classe também sai no Exportar Excel, cliente a cliente.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Linha — evolução mensal */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>Evolução do faturamento</CardTitle>
                  <CardDescription>
                    Base: títulos de venda emitidos em Contas a Receber
                    {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? " · linha laranja tracejada = NF-e de venda autorizada (regra oficial)" : ""}
                    {fim === mesHoje ? " · o último mês ainda está em curso" : ""}
                  </CardDescription>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="O que entra em cada linha" data-testid="button-info-faturamento">
                      <Info className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[420px] max-w-[92vw] text-sm space-y-3">
                    <div>
                      <p className="font-semibold flex items-center gap-2">
                        <span className="inline-block h-0.5 w-5 rounded" style={{ background: SERIE_TITULOS }} />
                        Faturamento (títulos emitidos)
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Soma dos títulos de <b>venda</b> lançados em Contas a Receber, pela data de emissão. É a base de tudo
                        nesta tela — os gráficos de pizza e a tabela saem dela.
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold">Nunca entram no faturamento</p>
                      <ul className="text-muted-foreground mt-1 list-disc pl-4 space-y-0.5">
                        <li>título cancelado ou excluído</li>
                        <li>NF-e cancelada, rejeitada ou de entrada</li>
                        <li>devolução, troca, amostra, bonificação, brinde e remessa</li>
                        <li>empresas do grupo e parceiros que não são cliente (PURO, BARUC)</li>
                        <li>aporte de sócio, empréstimo e adiantamento</li>
                        <li>pedido mandado para a lixeira do pipeline</li>
                      </ul>
                    </div>
                    <div>
                      <p className="font-semibold flex items-center gap-2">
                        <span className="inline-block h-0.5 w-5 rounded" style={{ background: SERIE_NF, backgroundImage: `repeating-linear-gradient(90deg, ${SERIE_NF} 0 4px, transparent 4px 7px)` }} />
                        NF-e de venda autorizada
                      </p>
                      <p className="text-muted-foreground mt-1">
                        Linha de conferência: NF-e autorizada em produção com CFOP de venda, uma linha por CNPJ + série + número
                        (mata nota lançada em duplicidade). É a mesma regra oficial do dashboard. Só aparece a partir de mar/26 —
                        a base de notas não cobre 2025, e por isso o faturamento da tela sai dos títulos, não das notas.
                      </p>
                    </div>
                    {!filtrarVend && d?.excluidos?.valor > 0 ? (
                      <div className="border-t pt-2">
                        <p className="font-semibold">Fora da carteira no período</p>
                        <ul className="text-muted-foreground mt-1 space-y-0.5">
                          {(d.excluidos.detalhe || []).map((x: any, i: number) => (
                            <li key={i}>{BRL0(x.valor)} — {x.motivo}</li>
                          ))}
                          {d?.excluidos?.cancelados?.titulos > 0 ? (
                            <li>{BRL0(d.excluidos.cancelados.valor)} — títulos cancelados</li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={serie} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ececea" vertical={false} />
                  <XAxis dataKey="mes" tickFormatter={labelMes} tick={{ fontSize: 12, fill: "#898781" }} tickLine={false} axisLine={{ stroke: "#ececea" }} />
                  <YAxis tickFormatter={(v: any) => (Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : String(v))}
                    tick={{ fontSize: 12, fill: "#898781" }} tickLine={false} axisLine={false} width={52} />
                  <Tooltip formatter={(v: any, n: any) => [BRL(v), n]} labelFormatter={(l: any) => labelMes(String(l))} />
                  <Legend />
                  <Line type="linear" dataKey="valor" name="Faturamento (títulos emitidos)" stroke={SERIE_TITULOS} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                  {!filtrarVend && (d?.fonte?.mesesComNf || 0) > 0 ? (
                    <Line type="linear" dataKey="valorNf" name="NF-e de venda autorizada" stroke={SERIE_NF} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
              {!filtrarVend && d?.excluidos?.valor > 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Fora da carteira: {BRL0(d.excluidos.valor)} em {NUM(d.excluidos.titulos)} títulos que não são venda
                  (NF-e cancelada, devolução, troca, amostra, bonificação, transferência entre as empresas do grupo, aporte de sócio).
                  Detalhe no <b>i</b> acima.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Tabela — top 20 */}
          <Card>
            <CardHeader className="pb-2 space-y-3">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle>Clientes da carteira</CardTitle>
                  <CardDescription>
                    Relação completa do período. Média ponderada dá mais peso aos meses recentes
                    (o mês mais antigo do período pesa 1; o mais recente, {meses.length}).
                  </CardDescription>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant={ordem === "total" ? "default" : "outline"} onClick={() => setOrdem("total")} data-testid="button-ordem-total">Por faturamento total</Button>
                  <Button size="sm" variant={ordem === "ponderada" ? "default" : "outline"} onClick={() => setOrdem("ponderada")} data-testid="button-ordem-ponderada">Por média ponderada</Button>
                </div>
              </div>

              {/* Filtro pela CLASSE: a letra (nível de faturamento) e o sinal (pagamento) */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setClasseSel("todas")}
                  data-testid="chip-classe-todas"
                  className={`px-3 py-1.5 rounded-md border text-sm transition ${classeSel === "todas" ? "border-foreground/40 bg-muted font-semibold" : "border-transparent bg-muted/40 hover:bg-muted"}`}
                >
                  Todas as classes <span className="text-muted-foreground">({NUM(clientes.length)})</span>
                </button>
                {(["A", "B", "C", "D"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setClasseSel(classeSel === k ? "todas" : k)}
                    data-testid={`chip-classe-${k}`}
                    className={`px-3 py-1.5 rounded-md border text-sm transition flex items-center gap-2 ${classeSel === k ? "border-foreground/40 bg-muted font-semibold" : "border-transparent bg-muted/40 hover:bg-muted"}`}
                  >
                    <span
                      className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold"
                      style={{ background: CLASSE_COR[k], color: k === "D" ? "#0f172a" : "#ffffff" }}
                    >{k}</span>
                    Classe {k}
                    <span className="text-muted-foreground">
                      {NUM(porLetra[k]?.clientes || 0)} · {BRL0(porLetra[k]?.valor || 0)}
                    </span>
                  </button>
                ))}
                {/* Sinal: paga em dia (+) x atrasa ou está devendo (-) */}
                <div className="flex rounded-md border overflow-hidden">
                  {([
                    { k: "todos", t: `+ e −` },
                    { k: "+", t: `Só + (${NUM(totalMais)})` },
                    { k: "-", t: `Só − (${NUM(clientes.length - totalMais)})` },
                  ] as const).map((o) => (
                    <button
                      key={o.k}
                      onClick={() => setSinalSel(o.k)}
                      data-testid={`chip-sinal-${o.k === "+" ? "mais" : o.k === "-" ? "menos" : "todos"}`}
                      className={`px-3 py-1.5 text-sm transition ${sinalSel === o.k ? "bg-muted font-semibold" : "bg-background hover:bg-muted/60 text-muted-foreground"}`}
                    >
                      {o.t}
                    </button>
                  ))}
                </div>
                <div className="relative ml-auto w-[260px] max-w-full">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Buscar cliente, cidade, vendedor ou CNPJ"
                    className="pl-8 h-9"
                    data-testid="input-busca-cliente"
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                A letra é o nível de faturamento — A: acima de R$ 1.501/mês · B: R$ 800 a 1.500 · C: R$ 300 a 799 · D: até R$ 299,99.
                O sinal é o pagamento — <strong>+</strong> pagou ao menos 80% dos títulos em até 3 dias do vencimento e não deve nada hoje;
                {" "}<strong>−</strong> atrasa ou está devendo. A classe não muda com o filtro de vendedor: é a mesma do cliente em toda a empresa.
              </p>
            </CardHeader>
            <CardContent>
              {/* Sem o teto de altura do design system (max-h-[75vh]): assim o div de
                  scroll do <Table> termina na última linha e a barra de rolagem
                  horizontal nativa fica exatamente ali, embaixo do último cliente da
                  página. Em troca o cabeçalho vira sticky, para não sumir na rolagem. */}
              <div className="[&>div]:max-h-none [&>div]:overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_hsl(var(--border))]">
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    {thOrdenavel("nome", "Cliente")}
                    {thOrdenavel("tipo", "Tipo", "w-16")}
                    {thOrdenavel("classe", "Classe", "w-16")}
                    {thOrdenavel("vendedor", "Vendedor")}
                    {thOrdenavel("total", "Faturamento no período", "text-right", true)}
                    <TableHead className="text-right">Média ponderada/mês</TableHead>
                    <TableHead className="text-right">Média simples/mês</TableHead>
                    <TableHead className="text-right w-24">Meses c/ compra</TableHead>
                    <TableHead className="w-24">Última compra</TableHead>
                    {thOrdenavel("debito", "Débito", "text-right w-28", true)}
                    {thOrdenavel("atraso", "Maior atraso", "text-right w-28", true)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listaVisivel.map((c, i) => {
                    const letra = letraDe(c);
                    const positivo = sinalDe(c) === "+";
                    return (
                      <TableRow key={c.chave} data-testid={`row-cliente-${i}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-medium">
                          {c.nome}
                          {/* Situacao da carteira, a mesma do gráfico de barras acima.
                              INATIVO = cadastro desativado (a empresa já disse que ele saiu).
                              PERDIDO = cadastro ativo, comprava com regularidade e parou —
                              é o churn silencioso, o único balde em que dá para reagir. */}
                          {c.situacao === "inativo" ? (
                            <span
                              className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground align-middle"
                              title="Cadastro inativado"
                              data-testid={`tag-inativo-${i}`}
                            >inativo</span>
                          ) : c.situacao === "perdido" ? (
                            <span
                              className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded align-middle font-semibold"
                              style={{ background: `${COR_BARRA.perdidos}1a`, color: COR_BARRA.perdidos }}
                              title={`Comprava com regularidade e está há ${c.mesesSemComprar} ${c.mesesSemComprar === 1 ? "mês" : "meses"} sem comprar`}
                              data-testid={`tag-perdido-${i}`}
                            >perdido</span>
                          ) : null}
                          {c.cidade ? <span className="block text-xs text-muted-foreground">{c.cidade}</span> : null}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: `${COR_TIPO[c.tipo] || CINZA}1a`, color: COR_TIPO[c.tipo] || CINZA }}>{c.tipo === "Não identificado" ? "—" : c.tipo}</span>
                        </TableCell>
                        <TableCell>
                          <span
                            className="text-xs font-bold px-1.5 py-0.5 rounded"
                            title={positivo ? "Paga em dia e não deve nada hoje" : "Atrasa pagamentos ou está devendo hoje"}
                            style={{ background: CLASSE_COR[letra] || CINZA, color: letra === "D" ? "#0f172a" : "#ffffff", opacity: positivo ? 1 : 0.75 }}
                          >
                            {letra}{positivo ? "+" : "−"}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm">{c.vendedor}</TableCell>
                        <TableCell className="text-right font-semibold">{BRL(c.total)}</TableCell>
                        <TableCell className="text-right">{BRL(c.mediaPonderada)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{BRL(c.mediaSimples)}</TableCell>
                        <TableCell className="text-right">{c.mesesComCompra}/{meses.length}</TableCell>
                        <TableCell className="text-sm">{labelMes(c.ultimaCompra || "")}</TableCell>
                        <TableCell className={`text-right whitespace-nowrap ${(c.debito || 0) > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                          {(c.debito || 0) > 0 ? BRL(c.debito) : "—"}
                        </TableCell>
                        {(() => {
                          const at = maiorAtraso(c);
                          const correndo = (c.diasVencido || 0) > 0 && (c.diasVencido || 0) >= (c.piorAtraso || 0);
                          return (
                            <TableCell
                              className={`text-right whitespace-nowrap ${at === null ? "text-muted-foreground" : at === 0 ? "text-emerald-600" : at > 15 ? "text-destructive font-medium" : ""}`}
                              title={
                                at === null
                                  ? "Sem título com data de baixa e nada vencido — não há como medir atraso"
                                  : at === 0
                                    ? `${c.titulosMedidos} ${c.titulosMedidos === 1 ? "título pago" : "títulos pagos"} sem nenhum atraso`
                                    : correndo
                                      ? "Título vencido em aberto hoje — o atraso ainda está correndo"
                                      : `Pior atraso entre os ${c.titulosMedidos} títulos pagos do período`
                              }
                            >
                              {at === null ? "—" : at === 0 ? "em dia" : `${NUM(at)} ${at === 1 ? "dia" : "dias"}`}
                            </TableCell>
                          );
                        })()}
                      </TableRow>
                    );
                  })}
                  {listaFiltrada.length === 0 ? (
                    <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-6">
                      {busca.trim() ? "Nenhum cliente encontrado para essa busca." : "Nenhum cliente com faturamento no período."}
                    </TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
              </div>
              <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
                <p className="text-xs text-muted-foreground">
                  Mostrando {NUM(listaVisivel.length)} de {NUM(listaFiltrada.length)} clientes
                  {classeSel !== "todas" ? ` da classe ${classeSel}` : ""}
                  {sinalSel !== "todos" ? (sinalSel === "+" ? " que pagam em dia" : " que atrasam ou estão devendo") : ""}
                  {rotuloCarteira} · {BRL0(totalFiltrado)} no período
                  {debitoFiltrado > 0 ? <> · <span className="text-destructive font-medium">{BRL0(debitoFiltrado)} de débito vencido</span></> : " · sem débito vencido"}.
                  {d?.clientesTruncado ? " Base limitada aos 2.000 maiores." : ""}
                </p>
                {listaVisivel.length < listaFiltrada.length ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setVisiveis((v) => v + 100)} data-testid="button-mostrar-mais">
                      Mostrar mais 100
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setVisiveis(listaFiltrada.length)} data-testid="button-mostrar-todos">
                      Mostrar todos ({NUM(listaFiltrada.length)})
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
