import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { DateRangeFilter, exportToExcel, ExportExcelButton } from "@/lib/tableTools";

// ============================================================================
// EXTRATO DO CLIENTE — a "vida" do cliente com a Honest.
// Uma linha para cada nota faturada e uma linha para cada pagamento, por data,
// com saldo corrente acumulado. Fonte: /api/customer-statement/:customerId
// ============================================================================

type CustomerHit = {
  id: string;
  name: string;
  fantasyName?: string | null;
  document?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  isActive?: boolean;
  sellerName?: string | null;
};

type Linha = {
  key: string;
  data: string | null;
  tipo: "NF" | "PAGAMENTO";
  documento: string;
  nf: string;
  pedido?: string | null;
  descricao?: string | null;
  vencimento?: string | null;
  parcelas?: number | null;
  debito: number;
  credito: number;
  saldo: number;
  valorNota?: number;
  valorBruto?: number;
  pagoNota?: number;
  saldoNota?: number;
  situacao: string | null;
  origem: string;
  tipoMovimento?: string | null;
  motivo?: string | null;
  historico?: boolean;
  semCobranca?: boolean;
  natureza?: string | null;
  informativa?: boolean;
  duplicado?: boolean;
  cancelada?: boolean;
  diasAtraso?: number | null;
  formaPagamento?: string | null;
  conta?: string | null;
  estimado?: boolean;
  detalhe?: DetalheNota | DetalhePagamento | null;
};

type DetalheParcela = {
  titulo: string | null;
  vencimento: string | null;
  valor: number;
  pago: number;
  status: string | null;
  formaPagamento?: string | null;
  categoria?: string | null;
  descricao?: string | null;
};

type DetalheNota = {
  tipo: "NF";
  nf: string;
  pedido?: string | null;
  emissao?: string | null;
  vencimento?: string | null;
  valorTotal: number;
  pago: number;
  saldo: number;
  parcelasQtd: number;
  origem?: string | null;
  situacao: string | null;
  tipoMovimento?: string | null;
  motivo?: string | null;
  natureza?: string | null;
  duplicado?: boolean;
  cancelada?: boolean;
  parcelas: DetalheParcela[];
  implantadoPor?: string | null;
  implantadoPorTipo?: "pessoa" | "rotina" | null;
  vendedor?: string | null;
  pagamentos: Array<{ data: string | null; valor: number; formaPagamento?: string | null; conta?: string | null; referencia?: string | null; titulo?: string | null }>;
  produtos?: Array<{ nome: string; quantidade: number; unidade?: string | null; unitPrice?: number; totalPrice?: number }>;
  fiscalInvoiceId?: string | null;
};

type DetalhePagamento = {
  tipo: "PAGAMENTO";
  pagoEm?: string | null;
  valor: number;
  formaPagamento?: string | null;
  conta?: string | null;
  referencia?: string | null;
  obs?: string | null;
  nf?: string | null;
  pedido?: string | null;
  tituloNumero?: string | null;
  tituloVencimento?: string | null;
  diasAtraso?: number | null;
  estimado?: boolean;
};

type Extrato = {
  customer: any;
  resumo: {
    totalFaturado: number;
    totalPago: number;
    saldoDevedor: number;
    totalVencido: number;
    clienteDesde?: string | null;
    totalDevolucoes?: number;
    totalTrocas?: number;
    qtdDevolucoes?: number;
    qtdTrocas?: number;
    totalAVencer: number;
    qtdNotas: number;
    qtdNotasAbertas: number;
    qtdPagamentos: number;
    ticketMedio: number;
    primeiraCompra: string | null;
    ultimaCompra: string | null;
    diasSemComprar: number | null;
    atrasoMedioDias: number | null;
    notasCanceladas: number;
    baixasEstimadas: number;
    origem?: string;
    notasHistorico?: number;
    valorHistorico?: number;
    ocorrenciasSemCobranca?: number;
    valorSemCobranca?: number;
    notasInformativas?: number;
    valorInformativas?: number;
    titulosFantasma?: number;
    valorFantasma?: number;
    duplicadasComBaixa?: number;
    valorDuplicadasComBaixa?: number;
  };
  linhas: Linha[];
  totalLinhas: number;
};

interface TrocaRegistro {
  id: string; salesCardId: string; motivo: string; categoria: string; temperatura: number | null;
  valorTroca: number; itens: Array<{ produto: string; quantidade: number }>;
  nfNumero: string | null; nfData: string | null; vendedorNf: string | null; vendedorCard: string | null;
  comissaoPct: number; desconto: number; observacao: string | null; data: string;
}
const MOTIVO_TROCA_LABEL: Record<string, string> = { fermentado: "Fermentado", lacre: "Lacre", tampa: "Tampa", avaria: "Avaria / deformação / rótulo", vencido: "Vencido" };

const fmtBRL = (v?: number | null) =>
  (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtData = (v?: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};

const fmtDoc = (v?: string | null) => {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return v || "—";
};

const SIT_COR: Record<string, string> = {
  Quitada: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Parcial: "bg-amber-100 text-amber-800 border-amber-200",
  "Em aberto": "bg-blue-100 text-blue-800 border-blue-200",
  Vencida: "bg-red-100 text-red-800 border-red-200",
  Cancelada: "bg-gray-200 text-gray-600 border-gray-300",
  Recebido: "bg-emerald-100 text-emerald-800 border-emerald-200",
  "Sem cobrança": "bg-gray-100 text-gray-600 border-gray-200",
};

// Tipo de movimento: o QUE a linha é. Venda fica neutra para não poluir; o que não
// é venda ganha cor, porque é a exceção que o usuário precisa enxergar de longe.
const MOV_COR: Record<string, string> = {
  Venda: "bg-gray-100 text-gray-600 border-gray-200",
  Duplicado: "bg-gray-200 text-gray-600 border-gray-300",
  "Outra praça": "bg-violet-100 text-violet-800 border-violet-200",
  "Transferência": "bg-violet-100 text-violet-800 border-violet-200",
  "Devolução": "bg-sky-100 text-sky-800 border-sky-200",
  Troca: "bg-sky-100 text-sky-800 border-sky-200",
  Amostra: "bg-sky-100 text-sky-800 border-sky-200",
  "Outra saída": "bg-sky-100 text-sky-800 border-sky-200",
};
const MOVIMENTOS = ["Venda", "Devolução", "Troca", "Amostra", "Outra saída", "Outra praça", "Transferência", "Duplicado"];

// O que cada tipo de movimento quer dizer — vira o "i" no cabeçalho da coluna.
const MOV_AJUDA: Array<[string, string]> = [
  ["Venda", "Venda normal para este cliente. É o que entra no total faturado e no saldo devedor."],
  ["Devolução", "A mercadoria voltou: o título foi cancelado por devolução de venda. Não é compra nem dívida — fica no histórico e no card Devoluções. A coluna Motivo traz a justificativa de quem devolveu."],
  ["Troca", "Pedido registrado como troca de mercadoria (produto fermentado, lacre, tampa ou vencido). A troca é cobrada normalmente, então continua no faturado e no saldo devedor."],
  ["Amostra", "Pedido registrado como amostra/bonificação. Quando gera título, é cobrado como venda."],
  ["Outra praça", "Nota faturada por OUTRA unidade do grupo — [GYN] Goiânia, [BSB] Brasília, [IND] Puro Indústria, [SERV] Puro Serviços. Aparece no histórico do cliente por rastreabilidade, mas a cobrança é da outra praça: fica fora do faturado, do saldo devedor e do vencido."],
  ["Transferência", "Transferência de mercadoria entre estabelecimentos da própria empresa (CFOP 5151/6151). Não é venda para o cliente; entra só como ocorrência."],
  ["Outra saída", "CFOP 5949/6949 — \"outra saída de mercadoria ou prestação de serviço não especificado\": bonificação, remessa, brinde. Sai mercadoria, mas não há cobrança."],
  ["Duplicado", "Título repetido criado por rotina de reparo: a mesma NF já tem outro título ligado à nota fiscal, e este nasceu depois, sem NF-e e sem pedido. Fica na lista com valor zero, só para conferência com o Contas a Receber."],
];

/**
 * Filtro de MÚLTIPLA ESCOLHA. Mostra todas as opções de uma vez, com caixa de seleção.
 * Lista vazia = nenhum filtro (todos), que é o estado inicial.
 */
function MultiFiltro(props: {
  label: string;
  opcoes: Array<{ valor: string; rotulo: string }>;
  selecionados: string[];
  onChange: (v: string[]) => void;
  testId?: string;
  rotuloVazio: string;
}) {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, []);
  const n = props.selecionados.length;
  const resumo =
    n === 0 ? props.rotuloVazio
    : n === 1 ? (props.opcoes.find((o) => o.valor === props.selecionados[0])?.rotulo || props.selecionados[0])
    : `${n} selecionados`;
  const alterna = (v: string) => {
    const atual = props.selecionados;
    props.onChange(atual.includes(v) ? atual.filter((x) => x !== v) : [...atual, v]);
  };
  return (
    <div className="relative" ref={caixa}>
      <label className="text-xs text-gray-500 dark:text-gray-400 block">{props.label}</label>
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm min-w-[11rem] text-left flex items-center justify-between gap-2"
        data-testid={props.testId}
      >
        <span className={n ? "font-medium" : "text-gray-600 dark:text-gray-300"}>{resumo}</span>
        <span className="text-[10px] text-gray-400">▾</span>
      </button>
      {aberto ? (
        <div className="absolute z-40 mt-1 min-w-full w-max max-w-[22rem] max-h-72 overflow-auto rounded-md border bg-white dark:bg-gray-800 dark:border-gray-700 shadow-lg py-1">
          <button
            type="button"
            onClick={() => props.onChange([])}
            className="w-full text-left px-3 py-1.5 text-xs text-blue-700 dark:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {props.rotuloVazio} (limpar)
          </button>
          <div className="border-t dark:border-gray-700 my-1" />
          {props.opcoes.map((o) => (
            <label
              key={o.valor}
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={props.selecionados.includes(o.valor)}
                onChange={() => alterna(o.valor)}
                className="rounded border-gray-300"
                data-testid={props.testId ? `${props.testId}-${o.valor}` : undefined}
              />
              <span>{o.rotulo}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ORIGEM_LABEL: Record<string, string> = {
  financeiro: "Financeiro",
  nfe: "NF-e emitida",
  pedido: "Pedido faturado",
  baixa: "Baixa",
  baixa_importada: "Baixa importada",
};

// Textos de ajuda de cada KPI — explicam de onde sai o número.
// Todos os KPIs são de VIDA INTEIRA: não mudam quando o filtro de período é aplicado.
const KPI_INFO = {
  faturado:
    "Soma das notas de VENDA que estão na lista agora — acompanha período, tipo, situação, movimento, rede, origem e busca. Devolução, troca sem cobrança, outra praça, duplicata e nota cancelada não entram. Abaixo, a quantidade de notas.",
  pago:
    "Soma das baixas que estão na lista agora, lançadas na data real do pagamento. Baixas vindas do histórico importado sem data entram na data de vencimento e aparecem marcadas como (est.). Abaixo, a quantidade de pagamentos.",
  saldo:
    "Parte do que o cliente deve que AINDA NÃO venceu: notas em aberto com vencimento de hoje em diante. Vencido + A vencer é a dívida total. Abaixo, a quantidade de notas com saldo em aberto.",
  vencido:
    "Parte do saldo devedor cujo vencimento já passou. Nota que vence hoje NÃO conta como vencida — só a partir do dia seguinte.",
  devolucoes:
    "Quanto este cliente já devolveu: soma das notas canceladas por devolução de venda. Não é dívida nem compra — entra só como histórico. Abaixo, a quantidade de devoluções.",
  trocas:
    "Quanto este cliente já trocou: soma das notas cujo pedido foi registrado como troca. A troca é cobrada normalmente, então continua dentro do faturado e do saldo devedor. Abaixo, a quantidade de trocas.",
  ticket:
    "Total faturado dividido pela quantidade de notas. Abaixo, a média de dias entre o vencimento e o pagamento efetivo (só de baixas com data real).",
  relacionamento:
    "Primeira compra dentro do recorte filtrado. Abaixo, a última compra, há quantos dias ele não compra e — quando o filtro esconde algo mais antigo — desde quando o cliente existe, olhando todas as origens.",
} as const;

// "i" no canto do card: abre a explicação no hover e também no clique (toque no celular).
function InfoDot(props: {
  text: string;
  testId?: string;
  /** Lista termo → explicação. Quando vem, o balão vira glossário e fica mais largo. */
  itens?: Array<[string, string]>;
}) {
  const [aberto, setAberto] = useState(false);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        title={props.text}
        aria-label={props.text}
        data-testid={props.testId}
        onClick={(e) => {
          e.stopPropagation();
          setAberto((v) => !v);
        }}
        onMouseEnter={() => setAberto(true)}
        onMouseLeave={() => setAberto(false)}
        onBlur={() => setAberto(false)}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-bold leading-none text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      >
        i
      </button>
      {aberto ? (
        <span
          role="tooltip"
          className={`absolute top-5 z-50 rounded-md border border-gray-200 bg-white p-2 text-[11px] font-normal normal-case whitespace-normal break-words leading-snug tracking-normal text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 ${
            props.itens ? "left-0 w-[26rem] max-h-80 overflow-auto" : "right-0 w-60"
          }`}
        >
          {props.itens ? (
            <span className="block space-y-1.5">
              {props.text ? <span className="block pb-1 text-gray-500 dark:text-gray-400">{props.text}</span> : null}
              {props.itens.map(([termo, desc]) => (
                <span key={termo} className="block">
                  <strong className="text-gray-900 dark:text-gray-100">{termo}</strong>
                  {" — "}
                  {desc}
                </span>
              ))}
            </span>
          ) : (
            props.text
          )}
        </span>
      ) : null}
    </span>
  );
}

function Kpi(props: { label: string; value: string; sub?: string; tone?: string; testId?: string; info?: string }) {
  return (
    <div
      className={`relative rounded-lg border p-3 ${props.tone || "bg-white dark:bg-gray-800"}`}
      data-testid={props.testId}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{props.label}</div>
        {props.info ? <InfoDot text={props.info} testId={props.testId ? `${props.testId}-info` : undefined} /> : null}
      </div>
      <div className="text-lg font-bold leading-tight">{props.value}</div>
      {props.sub ? <div className="text-[11px] text-gray-500 dark:text-gray-400">{props.sub}</div> : null}
    </div>
  );
}

export default function ExtratoCliente() {
  const [location] = useLocation();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CustomerHit | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // Filtros de múltipla escolha: lista vazia = sem filtro (mostra tudo).
  const [tiposSel, setTiposSel] = useState<string[]>([]);
  const [situacoesSel, setSituacoesSel] = useState<string[]>([]);
  const [movimentosSel, setMovimentosSel] = useState<string[]>([]);
  // REDE: consolida o extrato de todos os clientes do grupo num só histórico.
  // Escolher uma rede substitui o cliente; escolher um cliente limpa a rede.
  const [redeSel, setRedeSel] = useState<string>("");
  // Origem dos DADOS (não é filtro de tela: vai ao servidor e refaz os KPIs).
  const [origem, setOrigem] = useState<"todas" | "integra" | "omie">("integra");
  const [busca, setBusca] = useState("");
  const [detalheLinha, setDetalheLinha] = useState<Linha | null>(null);
  const [sortCol, setSortCol] = useState<"data" | "documento" | "descricao" | "vencimento" | "situacao">("data");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const toggleSort = (col: "data" | "documento" | "descricao" | "vencimento" | "situacao") => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "data" || col === "vencimento" ? "desc" : "asc");
    }
  };

  const limparCliente = () => {
    setTerm("");
    setDebounced("");
    setSelected(null);
    setRedeSel("");
    setOpen(false);
  };

  /** Escolher uma rede troca o titular do extrato; o cliente escolhido sai. */
  const escolherRede = (id: string) => {
    setRedeSel(id);
    if (!id) { setSelected(null); setTerm(""); return; }
    const r = redes.find((x) => x.id === id);
    setTerm("");
    setDebounced("");
    setOpen(false);
    setSelected({ id: `rede:${id}`, name: `Rede ${r?.nome || ""}`.trim() } as any);
  };

  // Permite abrir já num cliente: /extrato-cliente?customerId=...
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const cid = qs.get("customerId");
    if (cid && !selected) {
      setSelected({ id: cid, name: "Carregando..." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 350);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const { data: hits = [], isFetching: buscando } = useQuery<CustomerHit[]>({
    queryKey: ["customer-statement-search", debounced],
    queryFn: () => apiRequest("GET", `/api/customer-statement/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });

  const { data: redes = [] } = useQuery<Array<{ id: string; nome: string; membros: number }>>({
    queryKey: ["extrato-redes"],
    queryFn: () => apiRequest("GET", "/api/customer-statement/redes"),
  });

  const { data: extrato, isLoading, isError, error } = useQuery<Extrato>({
    queryKey: ["customer-statement", selected?.id, start, end, origem],
    queryFn: () => {
      const p = new URLSearchParams();
      if (start) p.set("start", start);
      if (end) p.set("end", end);
      p.set("origem", origem);
      const qs = p.toString();
      return apiRequest("GET", `/api/customer-statement/${selected!.id}${qs ? "?" + qs : ""}`);
    },
    enabled: !!selected?.id,
  });

  // Trocas registradas (política de trocas): motivo, valor e desconto de comissão.
  const { data: trocas = [] } = useQuery<TrocaRegistro[]>({
    queryKey: ["trocas-cliente", selected?.id],
    queryFn: () => apiRequest("GET", `/api/trocas/cliente/${selected!.id}`),
    enabled: !!selected?.id && !String(selected?.id).startsWith("rede:"),
  });
  // Link do aviso "troca pelo mesmo motivo" abre com ?secao=trocas: rola até o bloco.
  const secaoTrocas = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("secao") === "trocas";
  const trocasRef = useRef<HTMLDivElement | null>(null);
  const rolouTrocas = useRef(false);
  useEffect(() => {
    if (secaoTrocas && !rolouTrocas.current && extrato && trocasRef.current) {
      rolouTrocas.current = true;
      setTimeout(() => trocasRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    }
  }, [secaoTrocas, extrato, trocas.length]);

  const linhas = useMemo(() => {
    let out = extrato?.linhas || [];
    if (tiposSel.length) out = out.filter((l) => tiposSel.includes(l.tipo));
    if (situacoesSel.length) {
      out = out.filter((l) =>
        situacoesSel.includes(l.situacao ? String(l.situacao) : "__sem__")
      );
    }
    if (movimentosSel.length) {
      out = out.filter((l) => movimentosSel.includes(String(l.tipoMovimento || "")));
    }
    const q = busca.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (l) =>
          String(l.documento || "").toLowerCase().includes(q) ||
          String(l.nf || "").toLowerCase().includes(q) ||
          String(l.pedido || "").toLowerCase().includes(q) ||
          String(l.descricao || "").toLowerCase().includes(q)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (l: Linha) => {
      switch (sortCol) {
        case "documento": return String(l.documento || "");
        case "descricao": return String(l.descricao || "");
        case "situacao": return String(l.situacao || "");
        case "vencimento": return String(l.vencimento || "");
        default: return String(l.data || "");
      }
    };
    out = [...out].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va !== vb) return va < vb ? -1 * dir : 1 * dir;
      // desempate estável por data e depois documento
      const da = String(a.data || ""), db_ = String(b.data || "");
      if (da !== db_) return da < db_ ? 1 : -1;
      return String(a.documento).localeCompare(String(b.documento));
    });
    return out;
  }, [extrato, tiposSel, situacoesSel, movimentosSel, busca, sortCol, sortDir]);

  const totaisVisiveis = useMemo(() => {
    const deb = linhas.reduce((s, l) => s + (l.debito || 0), 0);
    const cre = linhas.reduce((s, l) => s + (l.credito || 0), 0);
    return { deb, cre, saldo: deb - cre };
  }, [linhas]);

  // ── BIG NUMBERS DO QUE ESTÁ NA TELA (25/out/2026) ──────────────────────────
  // Antes os cards eram sempre de vida inteira e ignoravam período, tipo, situação,
  // movimento e busca — filtrar maio em diante continuava mostrando o faturado de
  // 200 notas. Agora eles saem das MESMAS linhas que a tabela mostra, então o que
  // está no card é o que está na lista. Rede e Origem já eram aplicados no servidor.
  const kpis = useMemo(() => {
    const notas = linhas.filter((l) => l.tipo !== "PAGAMENTO");
    const pagtos = linhas.filter((l) => l.tipo === "PAGAMENTO");
    // VENDA = o que é compra deste cliente. Fora: operação informativa (outra praça,
    // transferência, devolução, CFOP 5949), ocorrência sem cobrança, duplicata e nota
    // cancelada. Mesma régua do servidor, agora sobre o recorte visível.
    const vendas = notas.filter(
      (l) => !l.informativa && !l.semCobranca && !l.duplicado && !l.cancelada
    );
    const soma = (arr: Linha[], f: (l: Linha) => number) => arr.reduce((acc, l) => acc + (f(l) || 0), 0);
    const cent = (v: number) => Math.round(v * 100) / 100;

    const totalFaturado = soma(vendas, (l) => l.valorNota || 0);
    const totalPago = soma(pagtos.filter((l) => !l.informativa), (l) => l.credito || 0);
    const abertas = vendas.filter((l) => (l.saldoNota || 0) > 0.009);
    const vencidas = abertas.filter((l) => l.situacao === "Vencida");
    const aVencer = abertas.filter((l) => l.situacao !== "Vencida");
    const porMov = (mov: string) => notas.filter((l) => l.tipoMovimento === mov);
    const devolucoes = porMov("Devolução");
    const trocas = porMov("Troca");
    const atrasos = pagtos.filter((l) => !l.estimado && l.diasAtraso != null).map((l) => l.diasAtraso as number);
    const datas = vendas.map((l) => l.data).filter(Boolean).sort() as string[];
    const ultima = datas[datas.length - 1] || null;

    return {
      totalFaturado: cent(totalFaturado),
      totalPago: cent(totalPago),
      totalAVencer: cent(soma(aVencer, (l) => l.saldoNota || 0)),
      totalVencido: cent(soma(vencidas, (l) => l.saldoNota || 0)),
      totalDevolucoes: cent(soma(devolucoes, (l) => l.valorBruto ?? l.valorNota ?? 0)),
      totalTrocas: cent(soma(trocas, (l) => l.valorBruto ?? l.valorNota ?? 0)),
      qtdDevolucoes: devolucoes.length,
      qtdTrocas: trocas.length,
      qtdNotas: vendas.length,
      qtdNotasAbertas: abertas.length,
      qtdPagamentos: pagtos.length,
      ticketMedio: vendas.length ? cent(totalFaturado / vendas.length) : 0,
      primeiraCompra: datas[0] || null,
      ultimaCompra: ultima,
      diasSemComprar: ultima ? Math.floor((Date.now() - new Date(ultima).getTime()) / 86400000) : null,
      atrasoMedioDias: atrasos.length ? Math.round(atrasos.reduce((a, b) => a + b, 0) / atrasos.length) : null,
      // Avisos: também do recorte visível, senão o texto contradiz a lista.
      baixasEstimadas: pagtos.filter((l) => l.estimado).length,
      notasHistorico: notas.filter((l) => l.historico).length,
      valorHistorico: cent(soma(notas.filter((l) => l.historico), (l) => l.valorNota || 0)),
      ocorrenciasSemCobranca: notas.filter((l) => l.semCobranca).length,
      valorSemCobranca: cent(soma(notas.filter((l) => l.semCobranca), (l) => l.valorNota || 0)),
      notasInformativas: notas.filter((l) => l.informativa).length,
      valorInformativas: cent(soma(notas.filter((l) => l.informativa), (l) => l.valorNota || 0)),
      titulosFantasma: notas.filter((l) => l.duplicado).length,
      valorFantasma: cent(soma(notas.filter((l) => l.duplicado), (l) => l.valorBruto ?? l.valorNota ?? 0)),
    };
  }, [linhas]);

  const exportar = () => {
    const rows = linhas.map((l) => ({
      Data: fmtData(l.data),
      Tipo: l.tipo === "NF" ? "Nota faturada" : "Pagamento",
      "Tipo de movimento": l.tipoMovimento || "",
      "Motivo da troca": l.motivo || "",
      Documento: l.documento,
      Pedido: l.pedido || "",
      Descricao: l.descricao || "",
      Vencimento: fmtData(l.vencimento),
      Parcelas: l.parcelas || "",
      "Forma de pagamento": l.formaPagamento || "",
      "Valor do DOC": l.debito || 0,
      Credito: l.credito || 0,
      Saldo: l.saldo,
      Situacao: l.situacao,
      "Dias de atraso": l.diasAtraso ?? "",
      Origem: ORIGEM_LABEL[l.origem] || l.origem,
      "Data estimada": l.estimado ? "SIM" : "",
    }));
    const nome = (extrato?.customer?.name || "cliente").replace(/[^\w]+/g, "_").slice(0, 40);
    exportToExcel(rows, `extrato_${nome}`);
  };

  // `r` é o que os cards mostram: o recorte da tela. `clienteDesde` e
  // `duplicadasComBaixa` seguem vindo do servidor — não dependem do filtro.
  const r = extrato ? { ...extrato.resumo, ...kpis } : undefined;
  const clienteDesde = extrato?.resumo?.clienteDesde || null;

  return (
    <div className="space-y-4" data-testid="page-extrato-cliente">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Extrato do Cliente</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Espelho do Contas a Receber: uma linha por nota faturada e uma linha por pagamento, com saldo acumulado.
          </p>
        </div>
        <BackToDashboardButton />
      </div>

      {/* Seletor de cliente */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[280px] flex-1" ref={boxRef}>
              <label className="text-xs text-gray-500 dark:text-gray-400">Cliente</label>
              <div className="relative">
                <input
                  value={term}
                  onChange={(e) => {
                    setTerm(e.target.value);
                    setOpen(true);
                  }}
                  onFocus={() => setOpen(true)}
                  placeholder="Digite o nome, fantasia ou CNPJ/CPF do cliente..."
                  className="w-full px-3 py-2 pr-9 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700"
                  data-testid="input-busca-cliente"
                />
                {term ? (
                  <button
                    type="button"
                    onClick={limparCliente}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none px-1"
                    title="Limpar"
                    aria-label="Limpar busca de cliente"
                    data-testid="button-limpar-cliente"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              {open && debounced.length >= 2 ? (
                <div className="absolute z-30 mt-1 w-full max-h-80 overflow-auto rounded-md border bg-white dark:bg-gray-800 shadow-lg">
                  {buscando ? (
                    <div className="px-3 py-2 text-sm text-gray-500">Buscando...</div>
                  ) : hits.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500">Nenhum cliente encontrado.</div>
                  ) : (
                    hits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setSelected(h);
                          setRedeSel("");
                          setTerm(h.fantasyName || h.name);
                          setOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 border-b last:border-b-0 dark:border-gray-700"
                        data-testid={`option-cliente-${h.id}`}
                      >
                        <div className="text-sm font-medium flex items-center gap-2">
                          {h.fantasyName || h.name}
                          {h.isActive === false ? (
                            <Badge variant="outline" className="text-[10px]">inativo</Badge>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {h.fantasyName && h.fantasyName !== h.name ? `${h.name} · ` : ""}
                          {fmtDoc(h.document)} · {h.city || "—"}/{h.state || "—"}
                          {h.sellerName ? ` · ${h.sellerName}` : ""}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                Rede
                <InfoDot
                  testId="info-rede"
                  text="Consolida num só extrato todos os clientes do grupo — útil quando a rede tem várias lojas com CNPJs diferentes. Escolher uma rede substitui o cliente selecionado; escolher um cliente limpa a rede."
                />
              </label>
              <select
                value={redeSel}
                onChange={(e) => escolherRede(e.target.value)}
                className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm max-w-[13rem]"
                data-testid="select-rede"
              >
                <option value="">Sem rede (cliente)</option>
                {redes.map((rd) => (
                  <option key={rd.id} value={rd.id}>
                    {rd.nome} ({rd.membros})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block">Período</label>
              <DateRangeFilter start={start} end={end} onChange={(s, e) => { setStart(s); setEnd(e); }} />
            </div>

            <MultiFiltro
              label="Tipo"
              rotuloVazio="Notas + Pagamentos"
              testId="select-tipo-linha"
              opcoes={[
                { valor: "NF", rotulo: "Notas" },
                { valor: "PAGAMENTO", rotulo: "Pagamentos" },
              ]}
              selecionados={tiposSel}
              onChange={setTiposSel}
            />

            <MultiFiltro
              label="Situação"
              rotuloVazio="Todas as situações"
              testId="select-situacao"
              opcoes={[
                { valor: "Em aberto", rotulo: "Em aberto" },
                { valor: "Vencida", rotulo: "Vencida" },
                { valor: "Parcial", rotulo: "Parcial" },
                { valor: "Quitada", rotulo: "Quitada" },
                { valor: "Recebido", rotulo: "Recebido" },
                { valor: "Cancelada", rotulo: "Cancelada" },
                { valor: "Sem cobrança", rotulo: "Sem cobrança" },
                { valor: "__sem__", rotulo: "Sem situação" },
              ]}
              selecionados={situacoesSel}
              onChange={setSituacoesSel}
            />

            <MultiFiltro
              label="Movimento"
              rotuloVazio="Todos os movimentos"
              testId="select-movimento"
              opcoes={MOVIMENTOS.map((m) => ({ valor: m, rotulo: m }))}
              selecionados={movimentosSel}
              onChange={setMovimentosSel}
            />

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                Origem
                <InfoDot
                  testId="info-origem"
                  text="De onde vêm os lançamentos. O INTEGRA 2.0 começou a gerar títulos próprios em 31/03/2026; tudo que é anterior veio da migração do Omie (emissões desde 28/01/2020), importada a partir de 28/04/2026. O histórico tem defeitos conhecidos — títulos marcados como recebidos sem a baixa correspondente, baixas sem data de pagamento lançadas no vencimento e algumas NFs que existem nas duas origens —, então para conferir número financeiro escolha Somente INTEGRA 2.0."
                />
              </label>
              <select
                value={origem}
                onChange={(e) => setOrigem(e.target.value as any)}
                className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm"
                data-testid="select-origem"
              >
                <option value="todas">INTEGRA 2.0 + histórico</option>
                <option value="integra">Somente INTEGRA 2.0</option>
                <option value="omie">Somente histórico Omie</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block">NF / pedido</label>
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Filtrar..."
                className="px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm w-36"
                data-testid="input-filtro-nf"
              />
            </div>

            {extrato ? <ExportExcelButton onClick={exportar} testId="button-exportar-extrato" /> : null}
            {extrato ? (
              <Button variant="outline" onClick={() => window.print()} data-testid="button-imprimir-extrato">
                Imprimir
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {!selected ? (
        <Card>
          <CardContent className="py-10 text-center text-gray-500">
            Selecione um cliente para ver todo o histórico de compras e pagamentos.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card><CardContent className="py-10 text-center text-gray-500">Carregando extrato...</CardContent></Card>
      ) : isError ? (
        <Card><CardContent className="py-10 text-center text-red-600">{(error as any)?.message || "Erro ao carregar o extrato."}</CardContent></Card>
      ) : extrato ? (
        <>
          {/* Identificação + KPIs */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                {extrato.customer?.name}
                {extrato.customer?.isActive === false ? <Badge variant="outline">inativo</Badge> : null}
                <span className="text-sm font-normal text-gray-500">
                  {fmtDoc(extrato.customer?.document)} · {extrato.customer?.city || "—"}/{extrato.customer?.state || "—"}
                  {extrato.customer?.sellerName ? ` · Vendedor: ${extrato.customer.sellerName}` : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
                <Kpi label="Total faturado" value={fmtBRL(r?.totalFaturado)} sub={`${r?.qtdNotas || 0} notas`} testId="kpi-faturado" info={KPI_INFO.faturado} />
                <Kpi label="Total pago" value={fmtBRL(r?.totalPago)} sub={`${r?.qtdPagamentos || 0} pagamentos`} tone="bg-emerald-50 dark:bg-emerald-900/20" testId="kpi-pago" info={KPI_INFO.pago} />
                <Kpi
                  label="A vencer"
                  value={fmtBRL(r?.totalAVencer)}
                  sub={`${r?.qtdNotasAbertas || 0} em aberto`}
                  tone={(r?.totalAVencer || 0) > 0.009 ? "bg-amber-50 dark:bg-amber-900/20" : "bg-white dark:bg-gray-800"}
                  testId="kpi-saldo"
                  info={KPI_INFO.saldo}
                />
                <Kpi label="Vencido" value={fmtBRL(r?.totalVencido)} tone={(r?.totalVencido || 0) > 0.009 ? "bg-red-50 dark:bg-red-900/20" : ""} testId="kpi-vencido" info={KPI_INFO.vencido} />
                <Kpi
                  label="Devoluções"
                  value={fmtBRL(r?.totalDevolucoes)}
                  sub={`${r?.qtdDevolucoes || 0} nota(s)`}
                  tone={(r?.totalDevolucoes || 0) > 0.009 ? "bg-sky-50 dark:bg-sky-900/20" : ""}
                  testId="kpi-devolucoes"
                  info={KPI_INFO.devolucoes}
                />
                <Kpi
                  label="Trocas"
                  value={fmtBRL(r?.totalTrocas)}
                  sub={`${r?.qtdTrocas || 0} nota(s)`}
                  tone={(r?.totalTrocas || 0) > 0.009 ? "bg-sky-50 dark:bg-sky-900/20" : ""}
                  testId="kpi-trocas"
                  info={KPI_INFO.trocas}
                />
                <Kpi label="Ticket médio" value={fmtBRL(r?.ticketMedio)} sub={r?.atrasoMedioDias != null ? `atraso médio: ${r.atrasoMedioDias}d` : undefined} testId="kpi-ticket" info={KPI_INFO.ticket} />
                <Kpi
                  label="Relacionamento"
                  value={fmtData(r?.primeiraCompra)}
                  sub={`última: ${fmtData(r?.ultimaCompra)}${r?.diasSemComprar != null ? ` (${r.diasSemComprar}d)` : ""}${
                    clienteDesde && r?.primeiraCompra && clienteDesde < r.primeiraCompra
                      ? ` · cliente desde ${fmtData(clienteDesde)}`
                      : ""
                  }`}
                  testId="kpi-relacionamento"
                  info={KPI_INFO.relacionamento}
                />
              </div>
              {(r?.baixasEstimadas || 0) > 0 ? (
                <div className="mt-3 text-[11px] text-amber-700 dark:text-amber-300">
                  ⚠ {r?.baixasEstimadas} baixa(s) vieram do histórico importado sem data de pagamento — foram lançadas na data
                  de vencimento e aparecem marcadas como <em>data estimada</em>.
                </div>
              ) : null}
              {(r?.ocorrenciasSemCobranca || 0) > 0 ? (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {r?.ocorrenciasSemCobranca} ocorrência(s) de {fmtBRL(r?.valorSemCobranca)} —{" "}
                  <strong>troca, amostra ou transferência que não gerou conta a receber</strong> — aparecem no histórico com o
                  valor em cinza e <strong>sem débito</strong>: não houve cobrança, então ficam fora do faturado e do saldo
                  devedor. Elas somam nos cards de Trocas e Devoluções.
                </div>
              ) : null}
              {(r?.notasHistorico || 0) > 0 ? (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {r?.notasHistorico} nota(s) de {fmtBRL(r?.valorHistorico)} vieram do{" "}
                  <strong>histórico migrado do Omie</strong> (emissões anteriores a 31/03/2026, quando o INTEGRA 2.0 passou a
                  gerar títulos próprios). Esse acervo tem baixas sem data de pagamento e títulos quitados sem a baixa
                  correspondente — para conferir número financeiro, use o filtro <strong>Origem → Somente INTEGRA 2.0</strong>.
                </div>
              ) : null}
              {(r?.notasInformativas || 0) > 0 ? (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {r?.notasInformativas} lançamento(s) de {fmtBRL(r?.valorInformativas)} aparecem no histórico mas{" "}
                  <strong>não são venda deste cliente</strong>: devolução, troca, amostra, CFOP 5949, transferência entre
                  estabelecimentos ou faturamento de outra praça ([GYN], [BSB], [IND], [SERV]). Cada um leva o nome da ocorrência
                  na coluna Situação e fica fora do faturado, do saldo devedor e do vencido.
                </div>
              ) : null}
              {(r?.titulosFantasma || 0) > 0 ? (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {r?.titulosFantasma} título(s) de {fmtBRL(r?.valorFantasma)} aparecem marcados como <strong>Duplicado</strong>: a
                  mesma NF já tem título ligado à nota fiscal, e estes nasceram depois, sem NF-e e sem pedido. Ficam na lista para
                  conferência com o Contas a Receber, com débito zero e fora das somas.
                </div>
              ) : null}
              {(r?.duplicadasComBaixa || 0) > 0 ? (
                <div className="mt-2 text-[11px] text-red-700 dark:text-red-300">
                  ⚠ {r?.duplicadasComBaixa} título(s) com cara de duplicata <strong>têm baixa</strong> ({fmtBRL(r?.valorDuplicadasComBaixa)}
                  {" "}recebidos) e por isso continuam na lista. Confira se houve recebimento em duplicidade.
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Trocas registradas */}
          {(trocas.length > 0 || secaoTrocas) && (
            <div ref={trocasRef} id="trocas" className="scroll-mt-4">
              <Card className={secaoTrocas ? "ring-2 ring-red-400" : undefined}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Trocas registradas ({trocas.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {trocas.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-gray-500">Nenhuma troca registrada com motivo para este cliente.</div>
                  ) : (
                    <div className="overflow-auto max-h-[50vh]">
                      <table className="w-full text-sm" data-testid="tabela-trocas-cliente">
                        <thead className="text-gray-600 dark:text-gray-300">
                          <tr className="text-left [&>th]:sticky [&>th]:top-0 [&>th]:bg-gray-100 [&>th]:dark:bg-gray-800 [&>th]:px-3 [&>th]:py-2 [&>th]:whitespace-nowrap">
                            <th>Data</th>
                            <th>Motivo</th>
                            <th>Produtos</th>
                            <th className="text-right">Valor</th>
                            <th>Vendedor</th>
                            <th>Última NF</th>
                            <th className="text-right">Desconto comissão</th>
                            <th>Observação</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trocas.map((t) => (
                            <tr key={t.id} className="border-t align-top [&>td]:px-3 [&>td]:py-2">
                              <td className="whitespace-nowrap">{new Date(t.data).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
                              <td className="whitespace-nowrap">
                                <Badge variant="outline" className={t.motivo === "vencido" ? "border-red-300 text-red-700" : "border-amber-300 text-amber-800"}>
                                  {MOTIVO_TROCA_LABEL[t.motivo] || t.motivo}
                                </Badge>
                                {t.temperatura != null && <span className="ml-1 text-xs text-gray-500">{String(t.temperatura).replace(".", ",")} °C</span>}
                              </td>
                              <td className="text-xs">
                                {(t.itens || []).map((i, k) => (
                                  <div key={k}>{i.quantidade} × {i.produto}</div>
                                ))}
                              </td>
                              <td className="text-right whitespace-nowrap">{fmtBRL(t.valorTroca)}</td>
                              <td className="whitespace-nowrap">{t.vendedorNf || t.vendedorCard || "—"}</td>
                              <td className="whitespace-nowrap">{t.nfNumero ? `NF ${t.nfNumero} · ${fmtData(t.nfData)}` : "—"}</td>
                              <td className="text-right whitespace-nowrap text-red-700">{t.desconto > 0 ? `− ${fmtBRL(t.desconto)}` : "—"}</td>
                              <td className="text-xs text-gray-600 dark:text-gray-300 max-w-[22rem] whitespace-pre-line">{t.observacao || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Extrato */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Movimentação ({linhas.length} de {extrato.totalLinhas} lançamentos)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="text-gray-600 dark:text-gray-300">
                    <tr className="text-left [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-gray-100 [&>th]:dark:bg-gray-800 [&>th]:shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.12)]">
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHeader label="Data" col="data" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                      </th>
                      <th className="px-3 py-2 whitespace-nowrap">Tipo</th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          Tipo de movimento
                          <InfoDot
                            testId="info-tipo-movimento"
                            text="O que cada linha é. Só Venda, Troca e Amostra entram no faturado e no saldo devedor."
                            itens={MOV_AJUDA}
                          />
                        </span>
                      </th>
                      <th className="px-3 py-2 whitespace-nowrap">Motivo da troca</th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHeader label="Documento" col="documento" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                      </th>
                      <th className="px-3 py-2">
                        <SortHeader label="Descrição" col="descricao" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                      </th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHeader label="Vencimento" col="vencimento" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                      </th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Valor do DOC</th>
                      <th className="px-3 py-2 text-right whitespace-nowrap">Pagamento (C)</th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHeader label="Situação" col="situacao" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                      </th>
                    </tr>
                    {/* Totais do que está na tela AGORA: acompanham período, tipo,
                        movimento, situação e busca. Ficam colados no cabeçalho para
                        serem lidos junto com as colunas que somam. */}
                    <tr className="text-left font-semibold [&>th]:sticky [&>th]:top-9 [&>th]:z-20 [&>th]:bg-gray-50 [&>th]:dark:bg-gray-900 [&>th]:shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.12)]">
                      <th className="px-3 py-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" colSpan={7}>
                        Valor total dos filtros
                      </th>
                      <th className="px-3 py-1.5 text-right whitespace-nowrap" data-testid="total-valor-doc">{fmtBRL(totaisVisiveis.deb)}</th>
                      <th className="px-3 py-1.5 text-right whitespace-nowrap text-emerald-700 dark:text-emerald-300" data-testid="total-pagamento">{fmtBRL(totaisVisiveis.cre)}</th>
                      <th className="px-3 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                          Nenhum lançamento no período/filtro selecionado.
                        </td>
                      </tr>
                    ) : (
                      linhas.map((l) => (
                        <tr
                          key={l.key}
                          className={`border-t dark:border-gray-700 ${
                            l.tipo === "PAGAMENTO" ? "bg-emerald-50/40 dark:bg-emerald-900/10" : ""
                          } ${l.cancelada ? "opacity-60 line-through" : ""}`}
                          data-testid={`linha-${l.key}`}
                        >
                          <td className="px-3 py-2 whitespace-nowrap">
                            {fmtData(l.data)}
                            {l.estimado ? <span className="ml-1 text-[10px] text-amber-600">(est.)</span> : null}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setDetalheLinha(l)}
                              title="Ver pormenores"
                              data-testid={`link-detalhe-${l.key}`}
                              className={`inline-flex items-center gap-1 font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus:ring-1 focus:ring-blue-400 rounded ${
                                l.tipo === "NF"
                                  ? "text-blue-700 dark:text-blue-300"
                                  : "text-emerald-700 dark:text-emerald-300"
                              }`}
                            >
                              {l.tipo === "NF" ? (
                                <><i className="fas fa-file-invoice-dollar text-[11px]" /> Nota</>
                              ) : (
                                <><i className="fas fa-hand-holding-dollar text-[11px]" /> Pagamento</>
                              )}
                            </button>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {l.tipo === "NF" && l.tipoMovimento ? (
                              <span className={`px-2 py-0.5 rounded-full border text-[11px] ${MOV_COR[l.tipoMovimento] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                                {l.tipoMovimento}
                              </span>
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 max-w-[200px] truncate" title={l.motivo || ""}>
                            {l.motivo || <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                            {l.tipo === "NF" ? (
                              <button
                                type="button"
                                onClick={() => setDetalheLinha(l)}
                                title="Ver produtos faturados"
                                data-testid={`link-produtos-${l.key}`}
                                className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid text-blue-700 dark:text-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-400 rounded"
                              >
                                {l.documento}
                              </button>
                            ) : (
                              l.documento
                            )}
                            {l.parcelas && l.parcelas > 1 ? (
                              <span className="ml-1 text-[10px] text-gray-500">({l.parcelas} parc.)</span>
                            ) : null}
                            {l.tipo === "NF" ? (
                              <div className="text-[10px] text-blue-600 dark:text-blue-400">
                                <button type="button" onClick={() => setDetalheLinha(l)} className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none">
                                  ver produtos
                                </button>
                              </div>
                            ) : null}
                            {l.pedido ? <div className="text-[10px] text-gray-400">ped. {l.pedido}</div> : null}
                          </td>
                          <td className="px-3 py-2 max-w-[280px] truncate" title={l.descricao || ""}>
                            {l.descricao || "—"}
                            {l.formaPagamento ? (
                              <span className="ml-1 text-[10px] text-gray-500">· {l.formaPagamento}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {fmtData(l.vencimento)}
                            {l.tipo === "PAGAMENTO" && l.diasAtraso != null && l.diasAtraso > 0 ? (
                              <span className="ml-1 text-[10px] text-red-600">+{l.diasAtraso}d</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                            {l.debito ? (
                              fmtBRL(l.debito)
                            ) : l.semCobranca && (l.valorNota || 0) > 0 ? (
                              <span
                                className="font-normal text-gray-400 dark:text-gray-500"
                                title="Ocorrência sem conta a receber: o valor não entra no saldo devedor nem nos totais."
                              >
                                {fmtBRL(l.valorNota)}
                              </span>
                            ) : (
                              ""
                            )}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-emerald-700 dark:text-emerald-300">
                            {l.credito ? fmtBRL(l.credito) : ""}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {l.situacao ? (
                              <span className={`px-2 py-0.5 rounded-full border text-[11px] ${SIT_COR[l.situacao] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                                {l.situacao}
                              </span>
                            ) : null}
                            {l.tipo === "NF" && l.saldoNota != null && l.saldoNota > 0.009 && (l.pagoNota || 0) > 0 ? (
                              <div className="text-[10px] text-gray-500">falta {fmtBRL(l.saldoNota)}</div>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {detalheLinha ? (
        <DetalheModal linha={detalheLinha} onClose={() => setDetalheLinha(null)} cliente={extrato?.customer} />
      ) : null}
    </div>
  );
}

// ============================================================================
// MODAL DE PORMENORES — abre ao clicar em "Nota" ou "Pagamento" no extrato.
// ============================================================================
type SortColKey = "data" | "documento" | "descricao" | "vencimento" | "situacao";

function SortHeader(props: {
  label: string;
  col: SortColKey;
  sortCol: SortColKey;
  sortDir: "asc" | "desc";
  onSort: (col: SortColKey) => void;
}) {
  const active = props.sortCol === props.col;
  return (
    <button
      type="button"
      onClick={() => props.onSort(props.col)}
      className="inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none"
      title="Ordenar A-Z / Z-A"
      data-testid={`sort-${props.col}`}
    >
      {props.label}
      <span className={`text-[10px] leading-none ${active ? "opacity-100" : "opacity-30"}`}>
        {active ? (props.sortDir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </button>
  );
}

function DetInfo(props: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{props.label}</div>
      <div className="text-sm font-medium">{props.value}</div>
    </div>
  );
}

// ============================================================================
// ESPELHO DA NOTA — layout para conferência, SEM NENHUM EFEITO FISCAL.
// ----------------------------------------------------------------------------
// Decisão do Flavio (29/out/2026). Regras que este código respeita, e que quem
// mexer aqui precisa manter:
//
//   • NÃO emite nada. Não chama a SEFAZ, não gera NF-e, não cria título, não
//     grava nada. É só uma folha montada no navegador com dados JÁ existentes
//     na tela — zero requisições de rede.
//   • NÃO é DANFE e não substitui documento fiscal. Não tem chave de acesso,
//     não tem código de barras, não tem protocolo de autorização — de propósito,
//     para que não possa ser confundido com o documento oficial.
//   • A marca d'água "ESPELHO SEM VALOR FISCAL" é repetida no fundo e o aviso
//     aparece no topo E no rodapé, para que sobreviva a uma fotocópia e a um
//     recorte de página.
// ============================================================================
function escaparHtml(v: any): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

type EspelhoFiscal = { nota: any; itens: any[] };

const STATUS_TITULO: Record<string, string> = {
  a_vencer: "A vencer",
  vencida: "Vencida",
  recebida: "Recebida",
  cancelada: "Cancelada",
  pdd: "PDD",
};

function montarEspelhoHtml(d: DetalheNota, linha: Linha, cliente: any, fiscal?: EspelhoFiscal | null): string {
  const e = escaparHtml;
  const n = fiscal?.nota;
  const itens = fiscal?.itens || [];
  const moeda = (v?: any) => fmtBRL(Number(v || 0));
  const num = (v: any, casas = 2) =>
    Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const dt = (v?: string | null) => fmtData(v);
  const vazio = "\u00a0";

  // Chave de acesso formatada em blocos de 4, como na DANFE.
  const chave = String(n?.access_key || "").replace(/\D/g, "");
  const chaveFmt = chave ? chave.replace(/(\d{4})(?=\d)/g, "$1 ").trim() : "";

  const emit = {
    nome: n?.issuer_name || "—",
    cnpj: n?.issuer_cnpj ? fmtDoc(n.issuer_cnpj) : "—",
    ie: n?.issuer_ie || "—",
    endereco: n?.issuer_address || "—",
    cidade: [n?.issuer_city, n?.issuer_uf].filter(Boolean).join(" - ") || "—",
    fone: n?.issuer_phone || "—",
  };
  const dest = {
    nome: n?.customer_name || cliente?.name || "—",
    doc: n?.customer_cnpj_cpf ? fmtDoc(n.customer_cnpj_cpf) : cliente?.document ? fmtDoc(cliente.document) : "—",
    ie: n?.customer_ie || "—",
    endereco: n?.customer_address || cliente?.address || "—",
    bairro: n?.customer_bairro || "—",
    cep: n?.customer_cep || "—",
    cidade: n?.customer_city || cliente?.city || "—",
    uf: n?.customer_uf || cliente?.state || "—",
    fone: n?.customer_phone || cliente?.phone || "—",
  };

  // Itens: usa os da NF-e quando houver; senão, os produtos que o extrato já tinha.
  const linhasItens = itens.length
    ? itens
        .map(
          (it: any) => `<tr>
            <td>${e(it.product_code || "—")}</td>
            <td class="desc">${e(it.product_name || "—")}</td>
            <td>${e(it.ncm || "—")}</td>
            <td>${e(it.csosn || it.cst_icms || "—")}</td>
            <td>${e(it.cfop || n?.cfop || "—")}</td>
            <td>${e(it.unit || "UN")}</td>
            <td class="num">${e(num(it.quantity, 0))}</td>
            <td class="num">${e(num(it.unit_price, 4))}</td>
            <td class="num">${e(num(it.total_price))}</td>
            <td class="num">${e(num(it.base_icms))}</td>
            <td class="num">${e(num(it.valor_icms))}</td>
            <td class="num">${e(num(it.valor_ipi))}</td>
            <td class="num">${e(num(it.aliq_icms, 2))}</td>
            <td class="num">${e(num(it.aliq_ipi, 2))}</td>
          </tr>`
        )
        .join("")
    : (d.produtos || []).length
    ? (d.produtos || [])
        .map(
          (p) => `<tr>
            <td>—</td>
            <td class="desc">${e(p.nome)}</td>
            <td>—</td><td>—</td><td>${e(n?.cfop || "—")}</td>
            <td>${e(p.unidade || "UN")}</td>
            <td class="num">${e(num(p.quantidade, 0))}</td>
            <td class="num">${e(num(p.unitPrice, 4))}</td>
            <td class="num">${e(num(p.totalPrice))}</td>
            <td class="num">0,00</td><td class="num">0,00</td><td class="num">0,00</td>
            <td class="num">0,00</td><td class="num">0,00</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="14" class="vaziolinha">Sem itens registrados para esta nota.</td></tr>`;

  const duplicatas = (d.parcelas || []).length
    ? (d.parcelas || [])
        .map(
          (t, k) => `<div class="dup"><b>Núm.</b> ${e(t.titulo || k + 1)} &nbsp; <b>Venc.</b> ${e(dt(t.vencimento))} &nbsp; <b>Valor</b> ${e(moeda(t.valor))}</div>`
        )
        .join("")
    : `<div class="dup">—</div>`;

  const infoComplementar = [n?.notes, d.pedido ? `Pedido: ${d.pedido}` : "", d.vendedor ? `Vendedor: ${d.vendedor}` : ""]
    .filter(Boolean)
    .join(" | ");

  const totalProd = n?.total_products ?? d.valorTotal;
  const totalNota = n?.total_invoice ?? d.valorTotal;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Espelho da NF ${e(n?.invoice_number || d.nf)} — sem valor fiscal</title>
<style>
  @page { size: A4 portrait; margin: 6mm; }
  * { box-sizing: border-box; }
  body { font: 7.6px/1.25 Arial, Helvetica, sans-serif; color: #000; margin: 0; background: #fff; }
  .folha { position: relative; z-index: 1;
           background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='470' height='300'%3E%3Ctext x='235' y='160' fill='%23000000' fill-opacity='0.055' font-family='Arial,Helvetica,sans-serif' font-size='30' font-weight='bold' letter-spacing='3' text-anchor='middle' transform='rotate(-24 235 160)'%3EESPELHO SEM VALOR FISCAL%3C/text%3E%3C/svg%3E");
           background-repeat: repeat; background-position: center top; }
  table { border-collapse: collapse; width: 100%; }
  .bx { border: .6px solid #000; }
  .bx td, .bx th { border: .6px solid #000; padding: 1px 3px; vertical-align: top; }
  .rot { font-size: 5.6px; text-transform: uppercase; letter-spacing: .2px; display: block; line-height: 1.1; }
  .val { font-size: 8.2px; line-height: 1.25; display: block; min-height: 9px; }
  .val.g { font-size: 9.6px; font-weight: 700; }
  .c { text-align: center; } .r { text-align: right; }
  .num { text-align: right; white-space: nowrap; }
  .faixa { text-align: center; font-weight: 700; font-size: 8.4px; letter-spacing: .4px;
           border: .6px solid #000; border-top: 0; padding: 1.5px; }
  .canhoto { margin-bottom: 2mm; }
  .corte { border-top: 1px dashed #000; margin: 1.5mm 0 2mm; }
  .danfe-tit { font-size: 15px; font-weight: 700; letter-spacing: 1px; }
  .danfe-sub { font-size: 5.8px; line-height: 1.15; }
  .chavebox { border: .6px solid #000; padding: 2px 4px; text-align: center; }
  .chave { font-family: "Courier New", monospace; font-size: 9px; font-weight: 700; letter-spacing: .3px; word-break: break-all; }
  .semcodigo { border: .6px dashed #777; color: #555; font-size: 6.4px; letter-spacing: 1px;
               text-align: center; padding: 5px 2px; margin-bottom: 1px; text-transform: uppercase; }
  .sec { font-size: 6.4px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
         border: .6px solid #000; border-bottom: 0; padding: 1px 3px; margin-top: 1.5mm; }
  .itens th { font-size: 5.6px; text-transform: uppercase; background: #fff; }
  .itens td { font-size: 7.2px; }
  .itens .desc { width: 34%; }
  .vaziolinha { text-align: center; font-style: italic; padding: 8px; }
  .dup { display: inline-block; border: .6px solid #000; padding: 1px 5px; margin: 1px 2px 1px 0; font-size: 7.2px; }
  .avisoTopo { border: .8px solid #444; background: #f6f6f6; text-align: center; font-size: 7.4px;
               font-weight: 700; letter-spacing: 1px; padding: 2.5px; margin-bottom: 1.5mm; text-transform: uppercase; }
  .rodape { font-size: 6.4px; color: #333; margin-top: 1.5mm; line-height: 1.3; }
  .barra { text-align: center; margin-bottom: 2mm; }
  .barra button { font: 12px Arial; padding: 6px 14px; border: 1px solid #333; background: #111; color: #fff; border-radius: 4px; cursor: pointer; }
  @media print { .naoimprime { display: none !important; }
    body, .folha { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body>
  <div class="folha">
    <div class="barra naoimprime"><button onclick="window.print()">Imprimir / salvar em PDF</button></div>
    <div class="avisoTopo">Espelho do original · documento sem valor fiscal · não é DANFE</div>

    <!-- CANHOTO -->
    <table class="bx canhoto"><tr>
      <td style="width:76%">
        <span class="rot">Recebemos de ${e(emit.nome)} os produtos constantes da nota fiscal indicada ao lado</span>
        <table style="width:100%;margin-top:1px"><tr>
          <td class="bx" style="width:30%"><span class="rot">Data de recebimento</span><span class="val">${vazio}</span></td>
          <td class="bx"><span class="rot">Identificação e assinatura do recebedor</span><span class="val">${vazio}</span></td>
        </tr></table>
      </td>
      <td class="c" style="width:24%">
        <span class="val g">NF-e</span>
        <span class="val">Nº ${e(n?.invoice_number || d.nf)}</span>
        <span class="val">SÉRIE ${e(n?.series || "1")}</span>
      </td>
    </tr></table>
    <div class="corte"></div>

    <!-- CABEÇALHO -->
    <table class="bx"><tr>
      <td style="width:38%">
        <span class="val g">${e(emit.nome)}</span>
        <span class="val">${e(emit.endereco)}</span>
        <span class="val">${e(emit.cidade)}</span>
        <span class="val">Fone: ${e(emit.fone)}</span>
      </td>
      <td class="c" style="width:26%">
        <div class="danfe-tit">DANFE</div>
        <div class="danfe-sub">Documento Auxiliar da<br>Nota Fiscal Eletrônica</div>
        <div class="danfe-sub" style="margin-top:2px">0 - ENTRADA<br>1 - SAÍDA</div>
        <div style="border:.6px solid #000;display:inline-block;padding:0 5px;font-weight:700;font-size:10px;margin:1px 0">1</div>
        <div class="val">Nº ${e(n?.invoice_number || d.nf)}</div>
        <div class="val">SÉRIE ${e(n?.series || "1")}</div>
        <div class="val">FOLHA 1/1</div>
      </td>
      <td style="width:36%">
        <div class="semcodigo">Espelho — código de barras suprimido</div>
        <div class="chavebox">
          <span class="rot">Chave de acesso</span>
          <span class="chave">${e(chaveFmt || "—")}</span>
        </div>
        <div class="c" style="font-size:6px;margin-top:1px">
          Consulta de autenticidade no portal nacional da NF-e ou no site da Sefaz autorizadora
        </div>
      </td>
    </tr></table>
    <table class="bx" style="border-top:0"><tr>
      <td style="width:62%"><span class="rot">Natureza da operação</span><span class="val">${e(n?.nature_of_operation || linha.descricao || "—")}</span></td>
      <td><span class="rot">Protocolo de autorização de uso</span><span class="val">${e(n?.protocol_number || "—")}${n?.authorization_date ? " - " + e(dt(n.authorization_date)) : ""}</span></td>
    </tr></table>
    <table class="bx" style="border-top:0"><tr>
      <td style="width:34%"><span class="rot">Inscrição estadual</span><span class="val">${e(emit.ie)}</span></td>
      <td style="width:34%"><span class="rot">Inscr. estadual do subst. tributário</span><span class="val">—</span></td>
      <td><span class="rot">CNPJ</span><span class="val">${e(emit.cnpj)}</span></td>
    </tr></table>

    <!-- DESTINATÁRIO -->
    <div class="sec">Destinatário / Remetente</div>
    <table class="bx"><tr>
      <td style="width:52%"><span class="rot">Nome / Razão social</span><span class="val">${e(dest.nome)}</span></td>
      <td style="width:26%"><span class="rot">CNPJ / CPF</span><span class="val">${e(dest.doc)}</span></td>
      <td><span class="rot">Data da emissão</span><span class="val">${e(dt(n?.emission_date || d.emissao))}</span></td>
    </tr><tr>
      <td><span class="rot">Endereço</span><span class="val">${e(dest.endereco)}</span></td>
      <td><span class="rot">Bairro / Distrito</span><span class="val">${e(dest.bairro)}</span></td>
      <td><span class="rot">CEP</span><span class="val">${e(dest.cep)}</span></td>
    </tr><tr>
      <td><span class="rot">Município</span><span class="val">${e(dest.cidade)}</span></td>
      <td><span class="rot">Fone / Fax</span><span class="val">${e(dest.fone)}</span></td>
      <td><span class="rot">UF</span><span class="val">${e(dest.uf)}</span></td>
    </tr><tr>
      <td><span class="rot">Inscrição estadual</span><span class="val">${e(dest.ie)}</span></td>
      <td><span class="rot">Data da saída / entrada</span><span class="val">${e(dt(n?.emission_date || d.emissao))}</span></td>
      <td><span class="rot">Hora da saída</span><span class="val">—</span></td>
    </tr></table>

    <!-- FATURA / DUPLICATAS -->
    <div class="sec">Fatura / Duplicatas</div>
    <table class="bx"><tr><td>${duplicatas}</td></tr></table>

    <!-- CÁLCULO DO IMPOSTO -->
    <div class="sec">Cálculo do imposto</div>
    <table class="bx"><tr>
      <td><span class="rot">Base de cálc. do ICMS</span><span class="val r">${e(num(n?.total_icms ? itens.reduce((s2: number, i2: any) => s2 + Number(i2.base_icms || 0), 0) : 0))}</span></td>
      <td><span class="rot">Valor do ICMS</span><span class="val r">${e(num(n?.total_icms))}</span></td>
      <td><span class="rot">Base cálc. ICMS ST</span><span class="val r">0,00</span></td>
      <td><span class="rot">Valor do ICMS ST</span><span class="val r">0,00</span></td>
      <td><span class="rot">Valor total dos produtos</span><span class="val r">${e(num(totalProd))}</span></td>
    </tr><tr>
      <td><span class="rot">Valor do frete</span><span class="val r">${e(num(n?.total_freight))}</span></td>
      <td><span class="rot">Valor do seguro</span><span class="val r">${e(num(n?.total_insurance))}</span></td>
      <td><span class="rot">Desconto</span><span class="val r">${e(num(n?.total_discount))}</span></td>
      <td><span class="rot">Outras despesas</span><span class="val r">${e(num(n?.total_other_expenses))}</span></td>
      <td><span class="rot">Valor total da nota</span><span class="val g r">${e(num(totalNota))}</span></td>
    </tr></table>

    <!-- TRANSPORTADOR -->
    <div class="sec">Transportador / Volumes transportados</div>
    <table class="bx"><tr>
      <td style="width:40%"><span class="rot">Nome / Razão social</span><span class="val">—</span></td>
      <td><span class="rot">Frete por conta</span><span class="val">—</span></td>
      <td><span class="rot">Código ANTT</span><span class="val">—</span></td>
      <td><span class="rot">Placa do veículo</span><span class="val">—</span></td>
      <td><span class="rot">UF</span><span class="val">—</span></td>
      <td><span class="rot">CNPJ / CPF</span><span class="val">—</span></td>
    </tr><tr>
      <td><span class="rot">Quantidade</span><span class="val">—</span></td>
      <td><span class="rot">Espécie</span><span class="val">—</span></td>
      <td><span class="rot">Marca</span><span class="val">—</span></td>
      <td><span class="rot">Numeração</span><span class="val">—</span></td>
      <td><span class="rot">Peso bruto</span><span class="val">—</span></td>
      <td><span class="rot">Peso líquido</span><span class="val">—</span></td>
    </tr></table>

    <!-- PRODUTOS -->
    <div class="sec">Dados do produto / serviço</div>
    <table class="bx itens">
      <thead><tr>
        <th>Código</th><th>Descrição do produto / serviço</th><th>NCM/SH</th><th>CST</th><th>CFOP</th>
        <th>Unid.</th><th>Quant.</th><th>Valor unit.</th><th>Valor total</th>
        <th>B. cálc. ICMS</th><th>Valor ICMS</th><th>Valor IPI</th><th>Alíq. ICMS</th><th>Alíq. IPI</th>
      </tr></thead>
      <tbody>${linhasItens}</tbody>
    </table>

    <!-- DADOS ADICIONAIS -->
    <div class="sec">Dados adicionais</div>
    <table class="bx"><tr>
      <td style="width:68%;height:52px">
        <span class="rot">Informações complementares</span>
        <span class="val">${e(infoComplementar || "—")}</span>
        <span class="val" style="margin-top:3px;font-weight:700">ESPELHO SEM VALOR FISCAL — reprodução para conferência interna.</span>
      </td>
      <td><span class="rot">Reservado ao fisco</span><span class="val">—</span></td>
    </tr></table>

    <div class="faixa" style="border-top:.6px solid #000;margin-top:1mm">ESPELHO DO ORIGINAL — SEM VALOR FISCAL</div>

    <div class="rodape">
      Reprodução de tela do INTEGRA 2.0 para conferência interna e atendimento ao cliente, gerada em
      ${e(new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))}.
      Não é DANFE e não substitui documento fiscal: o código de barras foi suprimido de propósito, o documento não foi
      transmitido à SEFAZ e sua emissão não gerou faturamento, título ou cobrança.
      ${chave ? "A autenticidade da nota original pode ser conferida pela chave de acesso acima, no portal da NF-e." : ""}
    </div>
  </div>
</body></html>`;
}

/**
 * Abre o espelho numa aba nova. A única ida ao servidor é um GET de LEITURA dos
 * dados fiscais já gravados da NF-e — nada é emitido, transmitido ou gravado.
 * A janela é aberta no próprio clique para o navegador não tratar como pop-up.
 */
async function abrirEspelho(d: DetalheNota, linha: Linha, cliente: any) {
  const w = window.open("", "_blank");
  if (!w) {
    alert("O navegador bloqueou a janela do espelho. Libere os pop-ups deste site e tente de novo.");
    return;
  }
  w.document.write("<p style='font:13px Arial;padding:16px'>Montando o espelho da nota…</p>");
  let fiscal: EspelhoFiscal | null = null;
  if (d.fiscalInvoiceId) {
    try {
      fiscal = await apiRequest("GET", `/api/customer-statement/nota/${d.fiscalInvoiceId}`);
    } catch {
      fiscal = null; // sem NF-e acessível, cai no layout com o que o extrato já tem
    }
  }
  w.document.open();
  w.document.write(montarEspelhoHtml(d, linha, cliente, fiscal));
  w.document.close();
}

function DetalheModal({ linha, onClose, cliente }: { linha: Linha; onClose: () => void; cliente?: any }) {
  const d = linha.detalhe as any;
  const isNota = linha.tipo === "NF";

  // Fallback: se o backend ainda não enviar `detalhe`, monta a partir da linha.
  const dNota: DetalheNota | null =
    isNota && d
      ? (d as DetalheNota)
      : isNota
      ? {
          tipo: "NF",
          nf: linha.nf,
          pedido: linha.pedido || null,
          emissao: linha.data,
          vencimento: linha.vencimento || null,
          valorTotal: linha.valorNota ?? linha.debito,
          pago: linha.pagoNota ?? 0,
          saldo: linha.saldoNota ?? 0,
          parcelasQtd: linha.parcelas || 1,
          origem: ORIGEM_LABEL[linha.origem] || linha.origem,
          situacao: linha.situacao,
          cancelada: linha.cancelada,
          parcelas: [],
          pagamentos: [],
        }
      : null;

  const dPag: DetalhePagamento | null =
    !isNota && d
      ? (d as DetalhePagamento)
      : !isNota
      ? {
          tipo: "PAGAMENTO",
          pagoEm: linha.data,
          valor: linha.credito,
          formaPagamento: linha.formaPagamento || null,
          conta: linha.conta || null,
          referencia: null,
          obs: linha.descricao || null,
          nf: linha.nf,
          pedido: linha.pedido || null,
          tituloNumero: null,
          tituloVencimento: linha.vencimento || null,
          diasAtraso: linha.diasAtraso ?? null,
          estimado: linha.estimado,
        }
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
      onMouseDown={onClose}
      data-testid="modal-detalhe-extrato"
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-lg bg-white dark:bg-gray-900 shadow-xl border dark:border-gray-700"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b dark:border-gray-700 px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            {isNota ? (
              <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300 font-semibold">
                <i className="fas fa-file-invoice-dollar" /> Nota {dNota?.nf && dNota.nf !== "—" ? dNota.nf : ""}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-semibold">
                <i className="fas fa-hand-holding-dollar" /> Pagamento{dPag?.nf ? ` — NF ${dPag.nf}` : ""}
              </span>
            )}
            {linha.tipoMovimento ? (
              <span className={`px-2 py-0.5 rounded-full border text-[11px] ${MOV_COR[linha.tipoMovimento] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                {linha.tipoMovimento}
              </span>
            ) : null}
            {linha.situacao ? (
              <span className={`px-2 py-0.5 rounded-full border text-[11px] ${SIT_COR[linha.situacao] || "bg-gray-100 text-gray-700 border-gray-200"}`}>
                {linha.situacao}
              </span>
            ) : null}
            {(isNota ? dNota?.cancelada : dPag?.estimado) ? (
              <span className="px-2 py-0.5 rounded-full border text-[11px] bg-gray-200 text-gray-600 border-gray-300">
                {isNota ? "Cancelada" : "Data estimada"}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {isNota && dNota ? (
              <button
                type="button"
                onClick={() => abrirEspelho(dNota, linha, cliente)}
                title="Abre um layout da nota para conferência. Não emite nada: sem SEFAZ, sem faturamento, sem cobrança."
                className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                data-testid="button-espelho-nota"
              >
                <i className="fas fa-print text-[11px]" /> Espelho da NF
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none px-2"
              data-testid="button-fechar-detalhe"
              aria-label="Fechar"
            >
              ×
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {isNota && dNota ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <DetInfo label="Emissão" value={fmtData(dNota.emissao)} />
                <DetInfo label="Vencimento" value={fmtData(dNota.vencimento)} />
                <DetInfo label="Pedido" value={dNota.pedido || "—"} />
                <DetInfo label="Valor total" value={fmtBRL(dNota.valorTotal)} />
                <DetInfo label="Pago" value={<span className="text-emerald-700 dark:text-emerald-300">{fmtBRL(dNota.pago)}</span>} />
                <DetInfo label="Saldo" value={<span className={dNota.saldo > 0.009 ? "text-amber-700 dark:text-amber-300" : ""}>{fmtBRL(dNota.saldo)}</span>} />
                <DetInfo label="Parcelas" value={dNota.parcelasQtd} />
                <DetInfo label="Origem" value={dNota.origem || "—"} />
                <DetInfo
                  label="Implantado por"
                  value={
                    dNota.implantadoPor ? (
                      <span className={dNota.implantadoPorTipo === "rotina" ? "text-gray-500 dark:text-gray-400 italic" : ""}>
                        {dNota.implantadoPor}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <DetInfo label="Vendedor" value={dNota.vendedor || "—"} />
              </div>

              <div>
                <div className="text-sm font-semibold mb-1">Produtos faturados</div>
                {dNota.produtos && dNota.produtos.length ? (
                  <div className="overflow-x-auto rounded border dark:border-gray-700">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                        <tr className="text-left">
                          <th className="px-2 py-1">Produto</th>
                          <th className="px-2 py-1 text-right">Qtd.</th>
                          <th className="px-2 py-1 text-right">Preço unit.</th>
                          <th className="px-2 py-1 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dNota.produtos.map((p, i) => (
                          <tr key={i} className="border-t dark:border-gray-700">
                            <td className="px-2 py-1">{p.nome}{p.unidade ? <span className="ml-1 text-[10px] text-gray-500">({p.unidade})</span> : null}</td>
                            <td className="px-2 py-1 text-right">{p.quantidade}</td>
                            <td className="px-2 py-1 text-right">{p.unitPrice != null ? fmtBRL(p.unitPrice) : "—"}</td>
                            <td className="px-2 py-1 text-right">{p.totalPrice != null ? fmtBRL(p.totalPrice) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">Produtos desta nota não disponíveis (nota importada sem itens detalhados).</div>
                )}
              </div>

              {dNota.parcelas && dNota.parcelas.length ? (
                <div>
                  <div className="text-sm font-semibold mb-1">Parcelas / títulos</div>
                  <div className="overflow-x-auto rounded border dark:border-gray-700">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                        <tr className="text-left">
                          <th className="px-2 py-1">Título</th>
                          <th className="px-2 py-1">Vencimento</th>
                          <th className="px-2 py-1 text-right">Valor</th>
                          <th className="px-2 py-1 text-right">Pago</th>
                          <th className="px-2 py-1">Forma</th>
                          <th className="px-2 py-1">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dNota.parcelas.map((p, i) => (
                          <tr key={i} className="border-t dark:border-gray-700">
                            <td className="px-2 py-1 font-mono">{p.titulo || "—"}</td>
                            <td className="px-2 py-1 whitespace-nowrap">{fmtData(p.vencimento)}</td>
                            <td className="px-2 py-1 text-right">{fmtBRL(p.valor)}</td>
                            <td className="px-2 py-1 text-right text-emerald-700 dark:text-emerald-300">{p.pago ? fmtBRL(p.pago) : ""}</td>
                            <td className="px-2 py-1">{p.formaPagamento || "—"}</td>
                            <td className="px-2 py-1">{p.status || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {dNota.pagamentos && dNota.pagamentos.length ? (
                <div>
                  <div className="text-sm font-semibold mb-1">Pagamentos aplicados</div>
                  <div className="overflow-x-auto rounded border dark:border-gray-700">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                        <tr className="text-left">
                          <th className="px-2 py-1">Data</th>
                          <th className="px-2 py-1 text-right">Valor</th>
                          <th className="px-2 py-1">Forma</th>
                          <th className="px-2 py-1">Conta</th>
                          <th className="px-2 py-1">Referência</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dNota.pagamentos.map((p, i) => (
                          <tr key={i} className="border-t dark:border-gray-700">
                            <td className="px-2 py-1 whitespace-nowrap">{fmtData(p.data)}</td>
                            <td className="px-2 py-1 text-right text-emerald-700 dark:text-emerald-300">{fmtBRL(p.valor)}</td>
                            <td className="px-2 py-1">{p.formaPagamento || "—"}</td>
                            <td className="px-2 py-1">{p.conta || "—"}</td>
                            <td className="px-2 py-1 max-w-[200px] truncate" title={p.referencia || ""}>{p.referencia || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-500">Nenhum pagamento registrado para esta nota.</div>
              )}

              {linha.descricao ? (
                <DetInfo label="Descrição" value={linha.descricao} />
              ) : null}
            </>
          ) : dPag ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <DetInfo label="Data do pagamento" value={<>{fmtData(dPag.pagoEm)}{dPag.estimado ? <span className="ml-1 text-[10px] text-amber-600">(estimada)</span> : null}</>} />
                <DetInfo label="Valor" value={<span className="text-emerald-700 dark:text-emerald-300">{fmtBRL(dPag.valor)}</span>} />
                <DetInfo label="Forma de pagamento" value={dPag.formaPagamento || "—"} />
                <DetInfo label="Conta" value={dPag.conta || "—"} />
                <DetInfo label="NF" value={dPag.nf || "—"} />
                <DetInfo label="Pedido" value={dPag.pedido || "—"} />
                <DetInfo label="Título" value={dPag.tituloNumero || "—"} />
                <DetInfo label="Vencimento do título" value={fmtData(dPag.tituloVencimento)} />
                <DetInfo
                  label="Atraso"
                  value={
                    dPag.diasAtraso == null
                      ? "—"
                      : dPag.diasAtraso > 0
                      ? <span className="text-red-600">{dPag.diasAtraso} dia(s)</span>
                      : dPag.diasAtraso < 0
                      ? `${Math.abs(dPag.diasAtraso)} dia(s) adiantado`
                      : "em dia"
                  }
                />
              </div>
              {dPag.referencia ? <DetInfo label="Referência" value={dPag.referencia} /> : null}
              {dPag.obs ? <DetInfo label="Observação" value={dPag.obs} /> : null}
            </>
          ) : (
            <div className="text-sm text-gray-500">Sem detalhes disponíveis.</div>
          )}
        </div>
      </div>
    </div>
  );
}
