// ============================================================================
// RESUMO RECEBÍVEIS COLABORADOR — 18/out/2026 · revisado 25/out/2026
// ---------------------------------------------------------------------------
// Planilha mensal do que cada colaborador tem a receber. Uma linha de valores
// por colaborador. As colunas de campanha são dinâmicas: vêm do cadastro de
// campanhas vigentes no mês.
//
// Rubrica não habilitada para o colaborador vem null do servidor e aparece
// como "—". Nunca um R$ 0,00 que pareça apurado.
//
// Backend: server/resumo-recebiveis-routes.ts
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Wallet, Settings2, Plus, Trash2, Download, Loader2, AlertTriangle, Info, Megaphone, Lock, Unlock,
  ArrowUpAZ, ArrowDownZA, ChevronsUpDown, Pencil, RefreshCw, EyeOff, Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

const PAPEL_LABEL: Record<string, string> = {
  vendedor: "Externo",
  telemarketing: "Interno",
  administrative: "Administrativo",
  motorista: "Motorista",
};
const PAPEL_COR: Record<string, string> = {
  vendedor: "bg-purple-100 text-purple-800",
  telemarketing: "bg-amber-100 text-amber-800",
  administrative: "bg-blue-100 text-blue-800",
  motorista: "bg-orange-100 text-orange-800",
};

// Tipos do lançamento avulso. Débito já chega negativo do servidor.
const TIPO_LANC: Record<string, string> = {
  bonus: "Bônus", credito: "Crédito", debito: "Débito",
};

const ACAO_COR: Record<string, string> = {
  "Remuneração": "bg-blue-100 text-blue-800",
  "Campanha": "bg-amber-100 text-amber-800",
  "Bônus": "bg-emerald-100 text-emerald-800",
  "Participação": "bg-violet-100 text-violet-800",
  "Fechamento": "bg-slate-800 text-white",
};

// Carimbo sempre no horário de Brasília, independente do fuso de quem olha.
const dataHora = (v: any) => {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

const dataBR = (v: any) => (v ? String(v).slice(0, 10).split("-").reverse().join("/") : "—");

const brl = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const kmTxt = (v: number) =>
  `${(Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;

// Primeiro mês do resumo (01/nov/2026). Antes disso não há folha apurável: não
// existe configuração de remuneração com vigência anterior, e o que a tela
// mostrasse ali seria uma conta feita com as regras de hoje sobre um passado que
// nunca foi fechado assim.
export const PRIMEIRO_MES = "2026-01";

function mesesDisponiveis(): string[] {
  const out: string[] = [];
  const hoje = new Date();
  for (let i = -2; i < 18; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return Array.from(new Set(out)).filter((m) => m >= PRIMEIRO_MES).sort().reverse();
}
const nomeDoMes = (ym: string) => {
  if (!ym) return "—";
  const [a, m] = ym.split("-").map(Number);
  return new Date(a, m - 1, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
};

// ---------------------------------------------------------------------------
// COMO CADA COLUNA É CALCULADA, por função. O conteúdo fica aqui e não na
// tabela para o cabeçalho não virar um muro de texto — cada coluna abre o seu
// no "i". Se a regra mudar no servidor, mude aqui junto: é esta tela que o
// colaborador abre para entender o próprio pagamento.
// ---------------------------------------------------------------------------
const Formula = ({ children }: { children: any }) => (
  <div className="rounded bg-muted p-2 font-mono text-[10px] leading-relaxed my-1.5">{children}</div>
);
const PorFuncao = ({ quem, children }: { quem: string; children: any }) => (
  <p className="mb-1"><strong>{quem}:</strong> {children}</p>
);

const AJUDA: Record<string, { titulo: string; corpo: any }> = {
  nome: {
    titulo: "Quem aparece na lista",
    corpo: (
      <>
        <p className="mb-2">
          Colaboradores <strong>ativos</strong> com papel de vendas (externo, interno, administrativo
          e motorista), mais quem o admin incluiu à mão na aba Participantes.
        </p>
        <p className="mb-2">
          A etiqueta embaixo do nome é a função. <strong>Consolidado</strong> marca a coordenação de
          vendas: meta e faturamento dela são a soma da equipe inteira.
        </p>
        <p className="mb-2">
          O <strong>olho riscado</strong> ao lado do nome tira aquela linha da tabela <strong>e do
          TOTAL</strong>, para conferir quanto sai sem ela. Nada é salvo: some ao recarregar ou ao
          trocar de mês, e o retrato congelado do fechamento continua com todo mundo. O{" "}
          <strong>Excel acompanha a tela</strong> — exporta só as linhas visíveis, com o TOTAL
          refeito e o arquivo marcado como parcial.
        </p>
        <p className="text-muted-foreground">
          Cada colaborador só enxerga a própria linha; o admin vê todas.
        </p>
      </>
    ),
  },
  fixoMensal: {
    titulo: "Fixo Mensal",
    corpo: (
      <>
        <p className="mb-2">
          <strong>Não é calculado</strong> — é cadastro. O admin informa em Configurações, com
          vigência por data: vale sempre a última vigência iniciada até o mês apurado. Entra cheio,
          sem proporcional por dias trabalhados.
        </p>
        <PorFuncao quem="Externo PJ">
          o fixo é <strong>adiantamento da comissão</strong>: só se paga comissão no que ela passar do fixo.
        </PorFuncao>
        <PorFuncao quem="Externo CLT, Interno e Motorista">
          somado normalmente, sem abater nada.
        </PorFuncao>
        <PorFuncao quem="Coordenação de vendas">
          fixo livre — nunca abate a comissão.
        </PorFuncao>
        <p className="text-muted-foreground">
          O sistema nunca guardou folha de pagamento: fixo em branco quer dizer não preenchido, não
          "sem salário".
        </p>
      </>
    ),
  },
  ajudaCusto: {
    titulo: "Ajuda de Custo",
    corpo: (
      <>
        <p className="mb-2">
          Valor de cadastro, informado em Configurações. Só aparece para quem tem o seletor de ajuda
          de custo ligado; nos demais fica <strong>—</strong>.
        </p>
        <p className="mb-2">
          É <strong>reembolso de despesa</strong>, não remuneração, e por isso <strong>nunca abate a
          comissão</strong>.
        </p>
        <PorFuncao quem="Externo PJ sem fixo mensal">
          recebe ajuda de custo <em>e</em> o percentual cheio sobre o faturamento.
        </PorFuncao>
      </>
    ),
  },
  meta: {
    titulo: "Meta",
    corpo: (
      <>
        <p className="mb-2">
          Buscada no módulo <strong>Metas de Vendas</strong>, na meta de faturamento cadastrada para
          o mês e o ano. Não é digitada aqui.
        </p>
        <PorFuncao quem="Coordenação de vendas">
          a meta é a <strong>soma das metas de toda a equipe</strong> (os outros consolidadores ficam
          de fora, senão o número se multiplicaria).
        </PorFuncao>
        <p className="text-muted-foreground">
          Serve de base para a comissão por faixa de atingimento e para a opção "proporcional à meta".
          Sem meta cadastrada, essas duas regras saem zero.
        </p>
      </>
    ),
  },
  faturamento: {
    titulo: "Faturamento",
    corpo: (
      <>
        <p className="mb-2">
          Mesma fonte do Dashboard: <strong>NF-e de venda autorizada</strong> com emissão dentro do
          mês. Devolução, remessa e bonificação não entram.
        </p>
        <p className="mb-2">
          O valor é creditado a <strong>quem implantou o pedido</strong>, e não ao vendedor do
          cadastro do cliente — quem registrou a venda leva o faturamento dela.
        </p>
        <PorFuncao quem="Coordenação de vendas">
          o faturamento da <strong>empresa inteira</strong> no mês — toda NF-e de venda, não só a de
          quem aparece na planilha. Entra também a venda de canal digital, de conta de sistema, de
          vendedor fora da lista e a nota sem vendedor atribuído.
        </PorFuncao>
        <p className="mb-2">
          O que não cai em linha nenhuma — nota sem vendedor, venda de quem não participa do resumo,
          venda de quem está com esta rubrica desligada — vai para a linha <strong>Outros</strong>,
          com a composição no "i" dela. Por isso o TOTAL do rodapé fecha com o total da empresa e
          com a linha da coordenação.
        </p>
        <p className="text-muted-foreground">
          Passe o mouse no valor da linha para ver o percentual de atingimento da meta.
        </p>
      </>
    ),
  },
  comissao: {
    titulo: "Comissão Mês",
    corpo: (
      <>
        <p className="mb-2">
          Cada colaborador tem <strong>uma</strong> regra, escolhida em Configurações. Passe o mouse
          no valor da linha para ver qual regra está valendo para ele.
        </p>
        <p className="font-medium mb-1">1. Percentual fixo</p>
        <Formula>
          faturamento × % − desconto fixo &nbsp;(piso zero)<br />
          proporcional à meta: (meta × % − desconto) × (faturamento ÷ meta)
        </Formula>
        <p className="font-medium mb-1 mt-2">2. Faixa por atingimento da meta</p>
        <p className="mb-1">
          A alíquota da faixa incide sobre o <strong>faturamento inteiro</strong>, não só sobre o que
          passou do piso.
        </p>
        <Formula>
          Interno &nbsp;&nbsp;&nbsp;&lt;90% 1,5% · 90% 2% · 100% 3% · 110% 3,5% · 120% 4%<br />
          Externo PJ &nbsp;&lt;85% 3,5% · 85% 4,5% · 100% 6% · 110% 6,5% · 120% 7,5%<br />
          Externo CLT &lt;85% 0,8% · 85% 1,5% · 100% 2,5% · 110% 3,5% · 120% 4,5%
        </Formula>
        <p className="font-medium mb-1 mt-2">3. Escalonado por faturamento</p>
        <p className="mb-1">
          Faixa pelo <strong>valor</strong> faturado, não pelo percentual da meta — é a regra da
          coordenação de vendas. A alíquota também incide sobre o faturamento inteiro.
        </p>
        <Formula>
          até R$ 299.999,99 = 2% · R$ 300.000 a R$ 399.999,99 = 2,2% · R$ 400.000+ = 2,5%
        </Formula>
        <p className="font-medium mb-1 mt-2">4. Por entrega</p>
        <p className="mb-2">
          Percentual sobre o valor entregue por <strong>todos</strong> os participantes na semana
          (segunda a domingo), rateado pelos pontos de cada um (dias entregues × peso). O mês leva as
          semanas que <strong>terminaram</strong> nele.
        </p>
        <p className="font-medium mb-1 mt-2">E aí, o fixo entra na conta</p>
        <PorFuncao quem="Externo PJ com fixo mensal">
          o fixo adianta a comissão — paga-se só o que ela passar dele. Apurou R$ 3.200 com fixo de
          R$ 3.000? Entram R$ 200 nesta coluna, e o total do mês segue R$ 3.200.
        </PorFuncao>
        <PorFuncao quem="Externo PJ só com ajuda de custo">
          percentual cheio sobre o faturamento bruto.
        </PorFuncao>
        <PorFuncao quem="Coordenação de vendas">
          fixo livre e percentual sobre o faturamento total da equipe — aqui o fixo não abate.
        </PorFuncao>
        <p className="mb-2">
          Por último sai o <strong>desconto por troca</strong> de vencimento, que tem coluna própria
          ao lado — o valor desta coluna já vem com ele abatido.
        </p>
        <Formula>
          comissão paga = apurado − fixo (quando a regra vale) − desconto por troca &nbsp;(piso zero)
        </Formula>
        <p className="text-muted-foreground">
          Quando o fixo engole parte da comissão, o valor apurado aparece em miúdo embaixo do valor
          pago: um zero aqui é comissão ainda dentro do fixo, não erro de apuração.
        </p>
      </>
    ),
  },
  descontoTroca: {
    titulo: "Desc. Trocas — já abatido na comissão",
    corpo: (
      <>
        <p className="mb-2">
          Troca por <strong>vencimento</strong> é aceita como decisão comercial, mas a comissão sobre
          o valor trocado volta: o vendedor recebeu comissão de uma venda que não se sustentou.
        </p>
        <Formula>
          valor da troca × % de comissão do vendedor<br />
          valor da troca = qtd trocada × preço da última NF dele para aquele cliente
        </Formula>
        <p className="mb-2">
          Apurado no módulo de Trocas e creditado a <strong>quem registrou</strong> o pedido de
          troca, no mês em que a troca aconteceu.
        </p>
        <p className="mb-2">
          Troca por <strong>qualidade</strong> — fermentado, lacre, tampa, avaria — fica registrada
          para a análise de lote e <strong>não desconta nada</strong>.
        </p>
        <p className="mb-2">
          A coluna aparece em negativo e <strong>já está abatida na Comissão Mês</strong>: não some
          de novo no total, senão o desconto conta duas vezes.
        </p>
        <p className="text-muted-foreground">
          A comissão tem piso zero. Se o desconto for maior que a comissão do mês, o que sobra{" "}
          <strong>não</strong> vira dívida nem passa para o mês seguinte — o tooltip da célula avisa
          quando isso acontece.
        </p>
      </>
    ),
  },
  bonus: {
    titulo: "Bônus e lançamentos",
    corpo: (
      <>
        <p className="mb-2">
          Saldo dos <strong>lançamentos avulsos</strong> do mês, feitos pelo admin em Configurações →
          Bônus e lançamentos. É a única rubrica digitada direto no valor — as outras vêm dos módulos
          que as calculam.
        </p>
        <Formula>
          bônus (+) &nbsp;·&nbsp; crédito (+) &nbsp;·&nbsp; débito (−)
        </Formula>
        <p className="mb-2">
          Serve para o que não cabe em comissão, fixo, km ou campanha: prêmio pontual, acerto a mais,
          devolução de desconto — e também desconto, no <strong>débito</strong>, que entra negativo e
          reduz o total do mês.
        </p>
        <p className="mb-2">
          Vale para <strong>qualquer colaborador da planilha</strong>: não é preciso marcar nada no
          cadastro antes de lançar. O débito <strong>exige justificativa</strong>, porque é dinheiro
          saindo da folha de alguém.
        </p>
        <p className="text-muted-foreground">
          O "i" ao lado do valor abre cada lançamento com a sua justificativa; o mesmo texto aparece
          ao passar o mouse. Mês fechado não aceita lançamento novo.
        </p>
      </>
    ),
  },
  kmValor: {
    titulo: "Km",
    corpo: (
      <>
        <p className="mb-2">
          Quilometragem do mês vinda do módulo <strong>Kilometragem Vendedores</strong>, multiplicada
          pela tarifa por km.
        </p>
        <Formula>km rodado no mês × tarifa por km</Formula>
        <p className="mb-2">
          A tarifa é a da <strong>região</strong> do colaborador (GO, DF ou PSN), salvo quando ele tem
          tarifa própria cadastrada — aí vale a dele.
        </p>
        <p className="text-muted-foreground">
          Passe o mouse no valor para ver quantos km e qual tarifa entraram na conta.
        </p>
      </>
    ),
  },
  reembolsos: {
    titulo: "Reembolsos — não soma no total",
    corpo: (
      <>
        <p className="mb-2">
          Esta coluna <strong>não entra no Total Mês</strong>. Ela não é recebível: é informação de
          quanto a empresa <strong>devolveu</strong> ao colaborador no mês, para enxergar o custo dele
          além da remuneração.
        </p>
        <p className="mb-1">Soma três fontes, de qualquer função — externo, interno, coordenação, motorista:</p>
        <Formula>
          módulo Reembolsos (despesa paga do próprio bolso)<br />
          + quilometragem do mês (km rodado × tarifa)<br />
          + Programação de Viagens (o que a viagem custou)
        </Formula>
        <p className="mb-2">
          Pedido recusado ou cancelado fica de fora: não virou dinheiro. A data considerada é a do
          <strong> fato</strong> — a despesa, o início da viagem —, não a do pagamento, para o número
          responder "quanto se gastou com ele neste mês".
        </p>
        <p className="mb-2">
          A quilometragem só entra aqui quando a <strong>rubrica Km está ligada</strong> para a
          pessoa — é o mesmo valor da coluna Km. Com a rubrica desligada a empresa não paga aquele
          km, então não há gasto: a distância continua sendo medida na Rota do Dia, mas não vira
          dinheiro em lugar nenhum.
        </p>
        <p className="text-muted-foreground">
          Visível só para administradores. O colaborador não vê esta coluna.
        </p>
      </>
    ),
  },
  totalMes: {
    titulo: "Total Mês",
    corpo: (
      <>
        <p className="mb-2">Soma de tudo que está habilitado para aquele colaborador:</p>
        <Formula>
          fixo + ajuda de custo + comissão + campanhas + bônus + km
        </Formula>
        <p className="mb-2">
          A comissão entra <strong>já abatida do fixo</strong> quando a regra do PJ se aplica — por
          isso o total não dobra o valor do fixo.
        </p>
        <p className="text-muted-foreground">
          Célula com <strong>—</strong> é rubrica desligada e não soma. Na linha TOTAL, meta e
          faturamento ignoram a coordenação de vendas, que já é a soma da equipe.
        </p>
      </>
    ),
  },
};

const ajudaCampanha = (c: { nome: string; origem: string; observacao?: string }) => ({
  titulo: c.nome,
  corpo: c.origem === "campanha" ? (
    <>
      <p className="mb-2">
        Puxado direto do módulo <strong>Campanha</strong>, que apura sozinho. Ninguém digita este
        valor aqui.
      </p>
      <Formula>
        R$ 30 por novo cliente apto<br />
        + R$ 500 se a positivação da carteira chegar a 90% no mês<br />
        + R$ 500 se bater a meta de faturamento
      </Formula>
      <p className="mb-2">
        <strong>Novo cliente apto</strong> = cliente inédito na base cuja 1ª NF-e de venda cai no mês,
        com 1º pedido de pelo menos R$ 300, creditado ao dono da carteira e <strong>aprovado</strong>{" "}
        pelo admin no Inbox. Enquanto está pendente conta como "em validação" e não paga.
      </p>
      <p className="text-muted-foreground">
        Vale para quem tem carteira: externo e interno. Motorista e administrativo não participam.
      </p>
    </>
  ) : (
    <>
      <p className="mb-2">
        Campanha de valor <strong>informado</strong>: o admin lança o valor de cada colaborador em
        Configurações, na aba Campanhas. Não há apuração automática.
      </p>
      {c.observacao && <p className="mb-2">{c.observacao}</p>}
      <p className="text-muted-foreground">
        A coluna só aparece nos meses de vigência da campanha.
      </p>
    </>
  ),
});

// Seções da aba Participantes, nesta ordem. O grupo de cada pessoa vem pronto do
// servidor (grupoDoParticipante), para a regra não existir em dois lugares.
const GRUPOS_PARTICIPANTE: Array<{ k: string; label: string; ajuda: string }> = [
  { k: "vendedores", label: "Vendedores", ajuda: "externos e internos" },
  { k: "motoristas", label: "Motoristas", ajuda: "entrega" },
  { k: "administrativos", label: "Administrativos", ajuda: "administração e coordenação" },
  { k: "canais", label: "Canais", ajuda: "loja, redes e contas de sistema — não são pessoas" },
  { k: "outros", label: "Outros", ajuda: "todo o restante" },
];

interface Campanha { id: string; nome: string; origem: string; ym_inicio: string; ym_fim: string | null; observacao?: string; }
interface Colab {
  id: string; nome: string; role: string; sellerType: string | null;
  config: any;
  fixoMensal: number | null; ajudaCusto: number | null; meta: number | null; faturamento: number | null;
  atingimentoPct: number; comissao: number | null;
  // Comissão apurada antes de abater o fixo mensal, e quanto o fixo engoliu.
  comissaoBruta?: number | null; comissaoAbatida?: number | null;
  // Troca por vencimento: já sai da comissão, não soma de novo no total.
  descontoTroca?: number | null; descontoTrocaAplicado?: number | null;
  campanhas: Record<string, number | null>;
  bonus: number | null;
  lancamentos: Array<{ id: string; descricao: string; valor: number; tipo?: string; justificativa?: string }>;
  kmRodado: number; kmTarifa: number; kmRegiao?: string; kmTarifaPropria?: boolean; kmValor: number | null; totalMes: number;
  // Só vem para admin. Informativo: não entra no totalMes.
  reembolsos?: { despesas: number; km: number; viagens: number; total: number } | null;
  consolidador?: boolean;
  // Desligado depois do mês: está na folha do mês, mas hoje está inativo.
  inativo?: boolean;
  // Linha de grupo (Canais, Outros…): soma das pessoas do grupo numa linha só.
  agrupado?: boolean; grupo?: string; membros?: number; membrosNomes?: string[];
  faturamentoSemDono?: number;
  faturamentoSemDonoPartes?: Array<{ nome: string; valor: number; motivo: string }>;
  // Só no consolidador: como o faturamento da empresa se divide entre as linhas
  // visíveis e o que veio de fora da planilha.
  faturamentoLinhas?: number | null; faturamentoForaDaLista?: number | null;
  entregaValorEntregue?: number | null; entregaSemanas?: number | null;
}

export default function ResumoRecebiveis() {
  const [ym, setYm] = useState(() => {
    const atual = new Date().toISOString().slice(0, 7);
    return atual < PRIMEIRO_MES ? PRIMEIRO_MES : atual;
  });
  const [abrirGestor, setAbrirGestor] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery<{ ym: string; admin: boolean; campanhas: Campanha[]; colaboradores: Colab[]; totais: any; fechado: boolean; fechadoEm: string | null; fechadoPor: string | null; podeFechar: boolean }>({
    queryKey: ["/api/resumo-recebiveis", ym],
    queryFn: () => apiRequest("GET", `/api/resumo-recebiveis?ym=${ym}`),
  });

  const admin = data?.admin === true;
  const fechado = data?.fechado === true;

  const fecharMes = useMutation({
    mutationFn: (acao: "fechar" | "reabrir") =>
      apiRequest("POST", `/api/resumo-recebiveis/${acao}`, { ym }),
    onSuccess: (r: any) => {
      toast({ title: r?.message || "Mês atualizado" });
      queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/auditoria"] });
    },
    onError: (e: any) => toast({ title: "Não foi possível", description: e?.message, variant: "destructive" }),
  });
  const colabs = data?.colaboradores || [];
  const campanhas = data?.campanhas || [];
  const totais = data?.totais;

  // Ordenação por qualquer coluna: 1º clique A→Z, 2º Z→A, 3º volta à ordem do
  // servidor (por função e nome). Vazio ("—") sempre no fim, nos dois sentidos:
  // rubrica desligada não é "o menor valor", é ausência de valor.
  const [ordem, setOrdem] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const valorDe = (c: Colab, col: string): string | number | null => {
    if (col === "nome") return c.nome;
    if (col.startsWith("camp:")) return c.campanhas?.[col.slice(5)] ?? null;
    if (col === "reembolsos") return c.reembolsos?.total ?? null;
    return (c as any)[col] ?? null;
  };
  const colabsOrdenados = useMemo(() => {
    if (!ordem) return colabs;
    const f = ordem.dir === "asc" ? 1 : -1;
    return [...colabs].sort((a, b) => {
      const va = valorDe(a, ordem.col);
      const vb = valorDe(b, ordem.col);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb), "pt-BR") * f;
      }
      return ((va as number) - (vb as number)) * f;
    });
  }, [colabs, ordem]);

  // ---------------------------------------------------------------------
  // OCULTAR LINHA (03/nov/2026). Filtro de leitura, não de apuração: serve
  // para tirar uma linha da conta e ver o TOTAL do resto — "quanto sai sem a
  // coordenação?", "quanto é só dos externos?".
  //
  // De propósito NÃO é salvo em lugar nenhum: some ao trocar de mês ou ao
  // recarregar, e nem a planilha do Excel nem o retrato do fechamento olham
  // para isto. Guardar significaria poder fechar um mês com uma linha
  // escondida por engano e congelar um total menor do que o devido.
  // ---------------------------------------------------------------------
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());
  useEffect(() => { setOcultas(new Set()); }, [ym]);
  const alternarOculta = (id: string) =>
    setOcultas((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const visiveis = useMemo(
    () => colabsOrdenados.filter((c) => !ocultas.has(c.id)), [colabsOrdenados, ocultas]);
  const nomesOcultos = useMemo(
    () => colabs.filter((c) => ocultas.has(c.id)).map((c) => c.nome), [colabs, ocultas]);

  // TOTAL do rodapé: sempre somado das linhas VISÍVEIS, com as mesmas duas
  // regras do servidor — meta e faturamento pulam o consolidador (ele já é a
  // soma da equipe; contá-lo dobraria), o resto soma todo mundo. Sem nada
  // oculto, bate número a número com `data.totais`.
  const totaisVis = useMemo(() => {
    if (!totais) return null;
    const soma = (f: (c: Colab) => number) => visiveis.reduce((s, c) => s + (f(c) || 0), 0);
    const somaBase = (f: (c: Colab) => number) =>
      visiveis.filter((c) => !c.consolidador).reduce((s, c) => s + (f(c) || 0), 0);
    return {
      ...totais,
      fixoMensal: soma((c) => c.fixoMensal || 0),
      ajudaCusto: soma((c) => c.ajudaCusto || 0),
      meta: somaBase((c) => c.meta || 0),
      faturamento: somaBase((c) => c.faturamento || 0),
      comissao: soma((c) => c.comissao || 0),
      descontoTroca: soma((c) => c.descontoTroca || 0),
      bonus: soma((c) => c.bonus || 0),
      kmValor: soma((c) => c.kmValor || 0),
      reembolsos: soma((c) => c.reembolsos?.total || 0),
      totalMes: soma((c) => c.totalMes || 0),
      campanhas: Object.fromEntries(
        campanhas.map((k) => [k.id, soma((c) => c.campanhas?.[k.id] || 0)])),
    };
  }, [totais, visiveis, campanhas]);

  // Cabeçalho: congelado no topo, clicável para ordenar e com o "i" que explica
  // como a coluna é calculada em cada função.
  const Th = ({ col, ajuda, children, primeira }: {
    col: string; ajuda?: { titulo: string; corpo: any }; children: any; primeira?: boolean;
  }) => {
    const ativa = ordem?.col === col;
    return (
      <th className={`px-3 py-2 font-semibold whitespace-nowrap bg-muted sticky top-0 ${
        primeira ? "text-left left-0 z-30 min-w-[190px]" : "text-right z-20"}`}>
        <div className={`flex items-center gap-1 ${primeira ? "" : "justify-end"}`}>
          <button type="button" className="inline-flex items-center gap-1 hover:text-emerald-700"
            title={ativa ? (ordem!.dir === "asc" ? "Ordenado A→Z — clique para Z→A" : "Ordenado Z→A — clique para voltar") : "Ordenar A→Z"}
            onClick={() => setOrdem((o) => o?.col !== col ? { col, dir: "asc" } : o.dir === "asc" ? { col, dir: "desc" } : null)}
            data-testid={`ordenar-${col}`}>
            <span>{children}</span>
            {ativa
              ? (ordem!.dir === "asc" ? <ArrowUpAZ className="h-3.5 w-3.5 text-emerald-700" /> : <ArrowDownZA className="h-3.5 w-3.5 text-emerald-700" />)
              : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
          </button>
          {ajuda && (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label={`Como é calculado: ${ajuda.titulo}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground">
                  <Info className="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[22rem] text-xs leading-relaxed font-normal text-left" align="end">
                <p className="font-semibold mb-1.5">{ajuda.titulo}</p>
                {ajuda.corpo}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </th>
    );
  };
  const semFixo = colabs.filter((c) => c.config?.usaFixo !== false && !c.fixoMensal).length;

  // O arquivo é gerado no servidor: a lib do front não escreve congelamento de
  // painel. Lá vai com largura 10, cabeçalho em negrito e congelado e quebra
  // automática de texto.
  // A planilha sai com as mesmas linhas da tela: o que foi ocultado não vai no
  // arquivo nem no TOTAL dele. Arquivo e tela com totais diferentes é a receita
  // para assinar pagamento pelo número errado.
  const exportarXls = () => {
    const ocultar = ocultas.size
      ? `&ocultar=${encodeURIComponent(Array.from(ocultas).join(","))}` : "";
    window.location.href = `/api/resumo-recebiveis/xlsx?ym=${ym}${ocultar}`;
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="h-6 w-6 text-emerald-600" />
            Resumo Recebíveis Colaborador
          </h1>
          <p className="text-sm text-muted-foreground">
            {admin
              ? "Tudo que cada colaborador tem a receber no mês."
              : "O que você tem a receber neste mês."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={ym} onValueChange={setYm}>
            <SelectTrigger className="w-48" data-testid="select-mes-recebiveis"><SelectValue /></SelectTrigger>
            <SelectContent>
              {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
            </SelectContent>
          </Select>
          {admin && data?.podeFechar && (
            <Button variant="outline" size="sm" className="text-emerald-700 border-emerald-300 hover:bg-emerald-50"
              onClick={() => fecharMes.mutate("fechar")} disabled={fecharMes.isPending}
              data-testid="button-fechar-mes">
              <Lock className="h-4 w-4 mr-1" /> Fechar mês
            </Button>
          )}
          {admin && fechado && (
            <Button variant="outline" size="sm" className="text-amber-700 border-amber-300 hover:bg-amber-50"
              onClick={() => fecharMes.mutate("reabrir")} disabled={fecharMes.isPending}
              data-testid="button-reabrir-mes">
              <Unlock className="h-4 w-4 mr-1" /> Reabrir
            </Button>
          )}
          {/* ATUALIZAR (01/nov/2026). Mês aberto é reapurado do zero a cada leitura:
              mudou um parâmetro em qualquer módulo — meta, km, comissão, trocas,
              campanha — este botão traz o número novo sem esperar o cache expirar.
              Mês FECHADO não reapura nada: o servidor devolve o retrato congelado,
              e o botão fica travado para não dar a entender que mexeria nele. */}
          <Button variant="outline" size="sm" onClick={() => refetch()}
            disabled={fechado || isFetching}
            title={fechado
              ? "Mês fechado: os valores são o retrato do fechamento e não se reapuram"
              : "Reapura o mês com os parâmetros que estão valendo agora"}
            data-testid="button-atualizar">
            {isFetching
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <RefreshCw className="h-4 w-4 mr-1" />}
            {isFetching ? "Atualizando…" : "Atualizar"}
          </Button>
          {admin && !fechado && (
            <Button variant="outline" size="sm" onClick={() => setAbrirGestor(true)} data-testid="button-gestor">
              <Settings2 className="h-4 w-4 mr-1" /> Configurações
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportarXls} disabled={!colabs.length}
            className={ocultas.size ? "text-amber-700 border-amber-300 hover:bg-amber-50" : ""}
            title={ocultas.size
              ? `Exporta as ${visiveis.length} linhas visíveis, sem as ${ocultas.size} ocultas`
              : "Exporta a planilha do mês"}>
            <Download className="h-4 w-4 mr-1" /> {ocultas.size ? "Excel (parcial)" : "Excel"}
          </Button>
          <BackToDashboardButton />
        </div>
      </div>

      {fechado && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            <strong>Mês fechado</strong> por {data?.fechadoPor || "—"} em {dataHora(data?.fechadoEm)}. Os valores
            abaixo são o retrato daquele momento e não mudam mais, mesmo que a configuração de alguém seja
            alterada depois. Lançamentos de bônus e de campanha neste mês ficam bloqueados.
          </span>
        </div>
      )}

      {admin && !fechado && semFixo > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {semFixo} colaborador{semFixo > 1 ? "es estão" : " está"} com Fixo Mensal zerado. O sistema
            nunca guardou salário ou ajuda de custo, então nada foi presumido — preencha em{" "}
            <button className="underline font-medium" onClick={() => setAbrirGestor(true)}>Configurações</button>.
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
            <span>{nomeDoMes(ym)}</span>
            <span className="flex items-center gap-3 text-sm font-normal text-muted-foreground">
              {/* Sem o carimbo, não dá para saber se o número na tela é de agora
                  ou de antes da alteração que acabou de ser feita. */}
              {!!dataUpdatedAt && (
                <span className="text-xs">
                  {fechado ? "Fechado · retrato congelado" : "Apurado às "}
                  {!fechado && new Date(dataUpdatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {totaisVis && (
                <span>
                  Total a pagar: <strong className="text-foreground">{brl(totaisVis.totalMes)}</strong>
                  {ocultas.size > 0 && (
                    <span className="ml-1 text-amber-700">
                      (só as {visiveis.length} linhas visíveis)
                    </span>
                  )}
                </span>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Apurando o mês…
            </div>
          ) : !colabs.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum colaborador ativo para este mês.
            </div>
          ) : (
            // Rolagem no container (não na página): é o que faz o cabeçalho congelar.
            <>
            <div className="overflow-auto max-h-[72vh]">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <Th col="nome" ajuda={AJUDA.nome} primeira>Colaborador</Th>
                    <Th col="fixoMensal" ajuda={AJUDA.fixoMensal}>Fixo Mensal</Th>
                    <Th col="ajudaCusto" ajuda={AJUDA.ajudaCusto}>Ajuda de Custo</Th>
                    <Th col="meta" ajuda={AJUDA.meta}>Meta</Th>
                    <Th col="faturamento" ajuda={AJUDA.faturamento}>Faturamento</Th>
                    <Th col="comissao" ajuda={AJUDA.comissao}>Comissão Mês</Th>
                    <Th col="descontoTroca" ajuda={AJUDA.descontoTroca}>Desc. Trocas</Th>
                    {campanhas.map((c) => (
                      <Th key={c.id} col={`camp:${c.id}`} ajuda={ajudaCampanha(c)}>{c.nome}</Th>
                    ))}
                    <Th col="bonus" ajuda={AJUDA.bonus}>Bônus</Th>
                    <Th col="kmValor" ajuda={AJUDA.kmValor}>Km</Th>
                    <Th col="totalMes" ajuda={AJUDA.totalMes}>Total Mês</Th>
                    {admin && <Th col="reembolsos" ajuda={AJUDA.reembolsos}>Reembolsos</Th>}
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-muted/30 group" data-testid={`linha-${c.id}`}>
                      <td className="px-3 py-2 sticky left-0 bg-background">
                        <div className="flex items-center gap-1 font-medium leading-tight">
                          {/* Ocultar é por linha e some com o TOTAL junto: o botão
                              fica na própria linha, não num menu, senão ninguém
                              descobre que existe. */}
                          <button type="button" onClick={() => alternarOculta(c.id)}
                            title={`Ocultar ${c.nome} e tirar do TOTAL`}
                            aria-label={`Ocultar ${c.nome}`}
                            className="shrink-0 text-muted-foreground/40 hover:text-amber-700 group-hover:text-muted-foreground"
                            data-testid={`ocultar-${c.id}`}>
                            <EyeOff className="h-3.5 w-3.5" />
                          </button>
                          {c.nome}
                          {/* Linha de grupo: o "i" conta o que está somado ali, já
                              que os nomes deixaram de aparecer. */}
                          {c.agrupado && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button type="button" aria-label={`O que está somado em ${c.nome}`}
                                  className="shrink-0 text-muted-foreground hover:text-foreground">
                                  <Info className="h-3.5 w-3.5" />
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[22rem] text-xs leading-relaxed" align="start">
                                <p className="font-semibold mb-1.5">{c.nome} — linha agrupada</p>
                                <p className="mb-2">
                                  O grupo está configurado para aparecer <strong>somado numa linha só</strong>,
                                  sem o nome de cada um. Troque em Configurações → Participantes.
                                </p>
                                {!!c.membros && (
                                  <>
                                    <p className="font-medium mb-1">{c.membros} na planilha</p>
                                    <p className="mb-2 text-muted-foreground">{(c.membrosNomes || []).join(" · ")}</p>
                                  </>
                                )}
                                {!!c.faturamentoSemDono && (
                                  <>
                                    <p className="font-medium mb-1">
                                      Faturamento sem dono na planilha: {brl(c.faturamentoSemDono)}
                                    </p>
                                    <p className="mb-1 text-muted-foreground">
                                      Saiu em NF-e no mês e não cai em nenhuma linha:
                                    </p>
                                    <ul className="mb-2 space-y-0.5">
                                      {(c.faturamentoSemDonoPartes || []).map((p, i) => (
                                        <li key={i}>
                                          <strong>{brl(p.valor)}</strong> — {p.nome} <span className="text-muted-foreground">({p.motivo})</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                )}
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                        {c.agrupado ? (
                          <Badge className="bg-slate-200 text-slate-700 mt-0.5">
                            grupo{c.membros ? ` · ${c.membros}` : ""}
                          </Badge>
                        ) : (
                          <Badge className={`${PAPEL_COR[c.role] || "bg-slate-100 text-slate-700"} mt-0.5`}>
                            {PAPEL_LABEL[c.role] || c.role}
                          </Badge>
                        )}
                        {c.consolidador && (
                          <Badge className="bg-slate-800 text-white ml-1" title="Meta e faturamento somam a equipe inteira">
                            consolidado
                          </Badge>
                        )}
                        {c.inativo && (
                          <Badge className="bg-slate-100 text-slate-500 ml-1"
                            title="Hoje está inativo, mas estava na folha deste mês: o desligamento foi depois que o mês acabou">
                            desligado
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{brl(c.fixoMensal)}</td>
                      <td className="px-3 py-2 text-right">{brl(c.ajudaCusto)}</td>
                      <td className="px-3 py-2 text-right">{brl(c.meta)}</td>
                      <td className="px-3 py-2 text-right"
                        title={[
                          c.meta ? `Atingimento ${c.atingimentoPct.toFixed(1)}% da meta` : "",
                          c.consolidador && c.faturamentoLinhas != null
                            ? `Faturamento da empresa no mês: ${brl(c.faturamentoLinhas)} da equipe listada + ${brl(c.faturamentoForaDaLista)} de fora da lista (canais, contas de sistema, nota sem vendedor)`
                            : "",
                        ].filter(Boolean).join("\n")}>
                        {/* Sem rótulo embaixo do valor: a explicação de que a coordenação
                            recebe sobre o total da empresa fica no "i" da coluna. */}
                        {brl(c.faturamento)}
                      </td>
                      <td className="px-3 py-2 text-right"
                        title={[
                          c.config?.comissaoTipo === "entrega"
                            ? `Comissão de entrega — ${c.entregaSemanas || 0} semana(s), ${brl(c.entregaValorEntregue || 0)} entregues`
                            : c.config?.comissaoTipo === "escalonado"
                            ? (c.config.comissaoFaixas || []).map((f: any) => `${brl(f.de)}${f.ate === null ? "+" : ` a ${brl(f.ate)}`} = ${f.pct}%`).join(" · ")
                            : c.config?.comissaoTipo === "faixa"
                            ? "Faixa por atingimento"
                            : c.config?.comissaoTipo === "fixo"
                              ? `${c.config.comissaoPct}%${c.config.comissaoDescontoFixo > 0 ? ` − ${brl(c.config.comissaoDescontoFixo)}` : ""}${c.config.comissaoProporcionalMeta ? " proporcional à meta" : ""}`
                              : "Sem regra de comissão",
                          (c.comissaoAbatida || 0) > 0
                            ? `Comissão a partir do fixo: apurado ${brl(c.comissaoBruta)} − fixo ${brl(c.fixoMensal)} = ${brl(c.comissao)}`
                            : "",
                          (c.descontoTroca || 0) > 0
                            ? `Já abatido ${brl(c.descontoTroca)} de desconto por troca de vencimento`
                            : "",
                        ].filter(Boolean).join("\n")}>
                        {brl(c.comissao)}
                        {/* O fixo adianta a comissão: sem esta linha, um zero aqui parece erro
                            de apuração em vez de comissão ainda dentro do fixo. */}
                        {(c.comissaoAbatida || 0) > 0 && (
                          <div className="text-[10px] font-normal text-muted-foreground whitespace-nowrap">
                            {brl(c.comissaoBruta)} − fixo
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right"
                        title={!c.descontoTroca ? "Nenhuma troca por vencimento no mês"
                          : (c.descontoTroca > (c.descontoTrocaAplicado || 0)
                            ? `Troca por vencimento: ${brl(c.descontoTroca)}. A comissão do mês absorveu ${brl(c.descontoTrocaAplicado)} — o resto não passa para o mês seguinte.`
                            : `Troca por vencimento: ${brl(c.descontoTroca)}, já abatidos na Comissão Mês`)}>
                        {c.descontoTroca
                          ? <span className="text-red-600">−{brl(c.descontoTroca)}</span>
                          : brl(c.descontoTroca ?? null)}
                      </td>
                      {campanhas.map((k) => (
                        <td key={k.id} className="px-3 py-2 text-right">{brl(c.campanhas?.[k.id] ?? null)}</td>
                      ))}
                      {/* Lançamento avulso não tem regra que o explique: a justificativa
                          tem de estar a um hover ou a um clique do valor, senão o número
                          vira um "de onde saiu isto?" na conferência da folha. */}
                      <td className="px-3 py-2 text-right"
                        title={(c.lancamentos || []).map((l) =>
                          `${TIPO_LANC[l.tipo || "bonus"] || "Bônus"} ${brl(l.valor)} — ${l.descricao}${l.justificativa ? `\n   ${l.justificativa}` : ""}`
                        ).join("\n")}>
                        <span className={(c.bonus || 0) < 0 ? "text-red-600" : ""}>{brl(c.bonus)}</span>
                        {!!c.lancamentos?.length && (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button type="button" aria-label="Ver os lançamentos e as justificativas"
                                className="ml-1 align-middle text-muted-foreground hover:text-foreground">
                                <Info className="inline h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[22rem] text-xs leading-relaxed text-left" align="end">
                              <p className="font-semibold mb-1.5">
                                {c.lancamentos.length} lançamento{c.lancamentos.length > 1 ? "s" : ""} em {nomeDoMes(ym)}
                              </p>
                              <ul className="space-y-2">
                                {c.lancamentos.map((l) => (
                                  <li key={l.id}>
                                    <div className="flex items-baseline justify-between gap-2">
                                      <span className="font-medium">
                                        {TIPO_LANC[l.tipo || "bonus"] || "Bônus"} · {l.descricao}
                                      </span>
                                      <span className={`shrink-0 font-semibold ${l.valor < 0 ? "text-red-600" : ""}`}>
                                        {brl(l.valor)}
                                      </span>
                                    </div>
                                    {l.justificativa
                                      ? <p className="text-muted-foreground">{l.justificativa}</p>
                                      : <p className="text-muted-foreground italic">Sem justificativa registrada.</p>}
                                  </li>
                                ))}
                              </ul>
                              <p className="mt-2 border-t pt-1.5 text-muted-foreground">
                                Débito entra negativo e reduz o total do mês. Lançado em Configurações →
                                Bônus e lançamentos.
                              </p>
                            </PopoverContent>
                          </Popover>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right"
                        title={`${kmTxt(c.kmRodado)} a ${brl(c.kmTarifa)}/km`}>
                        {brl(c.kmValor)}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">{brl(c.totalMes)}</td>
                      {admin && (
                        <td className="px-3 py-2 text-right text-muted-foreground"
                          title={c.reembolsos
                            ? `Despesas ${brl(c.reembolsos.despesas)} · Km ${brl(c.reembolsos.km)} · Viagens ${brl(c.reembolsos.viagens)} — fora do total do mês`
                            : ""}>
                          {brl(c.reembolsos?.total ?? null)}
                        </td>
                      )}
                    </tr>
                  ))}
                  {totaisVis && colabs.length > 1 && (
                    <tr className={`font-bold border-t-2 ${ocultas.size ? "bg-amber-50" : "bg-emerald-50"}`}>
                      <td className={`px-3 py-2 sticky left-0 ${ocultas.size ? "bg-amber-50" : "bg-emerald-50"}`}>
                        TOTAL
                        {ocultas.size > 0 && (
                          <div className="text-[10px] font-normal text-amber-700 whitespace-nowrap">
                            {visiveis.length} de {colabs.length} linhas
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{brl(totaisVis.fixoMensal)}</td>
                      <td className="px-3 py-2 text-right">{brl(totaisVis.ajudaCusto)}</td>
                      <td className="px-3 py-2 text-right">{brl(totaisVis.meta)}</td>
                      <td className="px-3 py-2 text-right"
                        title={totais?.faturamentoEmpresa !== undefined
                          ? `Soma das linhas acima. A empresa faturou ${brl(totais.faturamentoEmpresa)} no mês — é esse total que a coordenação recebe.`
                          : ""}>
                        {brl(totaisVis.faturamento)}
                      </td>
                      <td className="px-3 py-2 text-right">{brl(totaisVis.comissao)}</td>
                      <td className="px-3 py-2 text-right text-red-600">
                        {totaisVis.descontoTroca ? `−${brl(totaisVis.descontoTroca)}` : brl(0)}
                      </td>
                      {campanhas.map((k) => (
                        <td key={k.id} className="px-3 py-2 text-right">{brl(totaisVis.campanhas?.[k.id] || 0)}</td>
                      ))}
                      <td className="px-3 py-2 text-right">{brl(totaisVis.bonus)}</td>
                      <td className="px-3 py-2 text-right">{brl(totaisVis.kmValor)}</td>
                      <td className="px-3 py-2 text-right text-emerald-700">{brl(totaisVis.totalMes)}</td>
                      {admin && (
                        <td className="px-3 py-2 text-right font-normal text-muted-foreground"
                          title="Soma dos reembolsos do mês — fora do total a pagar">
                          {brl(totaisVis.reembolsos ?? null)}
                        </td>
                      )}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* O TOTAL parcial é a parte perigosa do recurso: fora da tabela, e
                não dentro dela, fica visível mesmo com a lista rolada — ninguém
                conferir a folha sem perceber que faltam linhas. */}
            {ocultas.size > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t bg-amber-50 px-3 py-2 text-xs text-amber-900"
                data-testid="aviso-ocultas">
                <EyeOff className="h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{ocultas.size} linha{ocultas.size > 1 ? "s ocultas" : " oculta"}</strong>
                  {" "}— o TOTAL acima soma só as visíveis.
                </span>
                <span className="text-amber-700">{nomesOcultos.join(" · ")}</span>
                <button type="button" className="inline-flex items-center gap-1 font-medium underline hover:no-underline"
                  onClick={() => setOcultas(new Set())} data-testid="mostrar-todas">
                  <Eye className="h-3.5 w-3.5" /> Mostrar todas
                </button>
                <span className="text-amber-700/80">
                  Some ao recarregar ou ao trocar de mês. O Excel sai com estas mesmas linhas,
                  marcado como parcial.
                </span>
              </div>
            )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Cada rubrica é buscada no módulo que a calcula: Meta nas Metas de Vendas, Faturamento na mesma
          fonte do Dashboard (NF-e de venda autorizada, atribuída a quem implantou o pedido), Km na
          Kilometragem Vendedores e as campanhas no módulo da campanha. Fixo Mensal, Ajuda de Custo e Bônus são
          valores de cadastro, informados em Configurações. Uma célula com <strong>—</strong> significa que a rubrica
          não está habilitada para aquele colaborador, e por isso não entra no total. Quem está marcado como
          <strong> consolidado</strong> tem meta e faturamento iguais à soma da equipe; para não contar duas
          vezes, o rodapé soma essas duas colunas apenas dos demais.
        </span>
      </div>

      {admin && <DialogGestor open={abrirGestor} onOpenChange={setAbrirGestor} ym={ym} colabs={colabs} campanhas={campanhas} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GESTOR — três abas: colaboradores (flags + remuneração), campanhas e bônus.
// ---------------------------------------------------------------------------
const FLAGS: Array<{ k: string; label: string; modulo: string; ajuda: string }> = [
  { k: "usaFixo", label: "Fixo mensal", modulo: "Cadastro (aqui)", ajuda: "Nenhum módulo calcula salário; o valor é informado nesta tela" },
  { k: "usaAjudaCusto", label: "Ajuda de custo", modulo: "Cadastro (aqui)", ajuda: "Valor fixo mensal de ajuda de custo, informado nesta tela" },
  { k: "usaMeta", label: "Meta", modulo: "Metas de Vendas", ajuda: "sales_goals: meta de faturamento do mês" },
  { k: "usaFaturamento", label: "Faturamento", modulo: "Faturamento oficial", ajuda: "NF-e de venda autorizada, atribuída a quem implantou o pedido" },
  { k: "usaComissao", label: "Comissão mês", modulo: "Regra do colaborador", ajuda: "Percentual, faixa, escalonamento ou comissão de entrega" },
  { k: "usaKm", label: "Km", modulo: "Kilometragem Vendedores", ajuda: "Km rodado no mês x tarifa do colaborador" },
  { k: "usaCampanhas", label: "Campanhas", modulo: "Módulos de campanha", ajuda: "Uma coluna por campanha vigente" },
  { k: "usaBonus", label: "Bônus manual", modulo: "Lançamento avulso", ajuda: "Abre o lançamento por usuário na aba Bônus" },
  { k: "consolidaTotais", label: "Consolida a equipe", modulo: "Soma dos demais", ajuda: "Meta e faturamento desta pessoa passam a ser a soma de todos os outros — para quem gerencia a equipe" },
];

function DialogGestor({ open, onOpenChange, ym, colabs, campanhas }: {
  open: boolean; onOpenChange: (o: boolean) => void; ym: string; colabs: Colab[]; campanhas: Campanha[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const vazio: any = {
    userId: "", vigenciaData: `${ym}-01`, fixoMensal: "", ajudaCusto: "", comissaoTipo: "nenhum",
    comissaoPct: "", comissaoDescontoFixo: "", comissaoProporcionalMeta: false,
    comissaoFaixas: [{ de: "0", ate: "", pct: "" }] as any[],
    faixaTipo: "telemarketing",
    usaFixo: true, usaAjudaCusto: false, usaMeta: true, usaFaturamento: true, usaComissao: true,
    usaKm: true, usaCampanhas: true, usaBonus: false, consolidaTotais: false, observacao: "",
    // null = segue o padrão do tipo de vendedor (PJ abate, os demais não).
    comissaoAbateFixo: null as boolean | null,
  };
  const [form, setForm] = useState<any>(vazio);
  const [buscaPart, setBuscaPart] = useState("");
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const { data: cfgData } = useQuery<{ configs: any[]; colaboradores: any[]; participantes: any[]; grupos?: Record<string, boolean> }>({
    queryKey: ["/api/resumo-recebiveis/config"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/config"),
    enabled: open,
  });
  const { data: auditData } = useQuery<{ registros: any[] }>({
    queryKey: ["/api/resumo-recebiveis/auditoria"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/auditoria?limite=200"),
    enabled: open,
  });
  const { data: campData } = useQuery<{ campanhas: any[] }>({
    queryKey: ["/api/resumo-recebiveis/campanhas"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/campanhas"),
    enabled: open,
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/config"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/campanhas"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/auditoria"] });
  };
  const num = (v: any) => Number(String(v).replace(",", ".")) || 0;

  // Comissão a partir do fixo mensal: padrão ligado para VENDEDOR PJ, desligado para
  // os demais, e sempre desligado para quem consolida a equipe (coordenação de vendas
  // tem fixo livre). O seletor mostra o valor que vai ser gravado, nunca um estado
  // "indefinido" que o admin não consegue ler.
  const colabSelecionado: any = (cfgData?.colaboradores || []).find((c: any) => c.id === form.userId);
  const abatePadrao = String(colabSelecionado?.seller_type || "") === "vendedor_pj";
  const abateFixo: boolean = form.consolidaTotais ? false
    : typeof form.comissaoAbateFixo === "boolean" ? form.comissaoAbateFixo : abatePadrao;

  const salvarCfg = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/config", {
      userId: form.userId, vigenciaData: form.vigenciaData, editando: !!editandoId,
      fixoMensal: num(form.fixoMensal), ajudaCusto: num(form.ajudaCusto), comissaoTipo: form.comissaoTipo,
      comissaoPct: num(form.comissaoPct), comissaoDescontoFixo: num(form.comissaoDescontoFixo),
      comissaoProporcionalMeta: form.comissaoProporcionalMeta, comissaoAbateFixo: abateFixo,
      faixaTipo: form.faixaTipo,
      comissaoFaixas: (form.comissaoFaixas || [])
        .filter((f: any) => String(f.pct).trim() !== "")
        .map((f: any) => ({ de: num(f.de), ate: String(f.ate).trim() === "" ? null : num(f.ate), pct: num(f.pct) })),
      usaFixo: form.usaFixo, usaAjudaCusto: form.usaAjudaCusto, usaMeta: form.usaMeta, usaFaturamento: form.usaFaturamento,
      usaComissao: form.usaComissao, usaKm: form.usaKm, usaCampanhas: form.usaCampanhas,
      usaBonus: form.usaBonus, consolidaTotais: form.consolidaTotais, observacao: form.observacao,
    }),
    onSuccess: () => {
      toast({ title: editandoId ? "Configuração atualizada" : "Configuração salva" });
      setEditandoId(null); setForm(vazio); invalidar();
    },
    onError: (e: any) => toast({ title: "Falha ao salvar", description: e?.message, variant: "destructive" }),
  });
  const removerCfg = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/config/${id}`),
    onSuccess: () => { toast({ title: "Vigência removida" }); invalidar(); },
  });

  const participacao = useMutation({
    mutationFn: (v: { userId: string; incluir: boolean }) =>
      apiRequest("POST", "/api/resumo-recebiveis/participacao", v),
    onSuccess: (r: any) => { toast({ title: r?.message || "Participação atualizada" }); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao alterar", description: e?.message, variant: "destructive" }),
  });

  // EDITAR UMA VIGÊNCIA JÁ GRAVADA (01/nov/2026). Antes só dava para criar outra
  // e apagar a antiga — mudar um percentual virava três cliques e o risco de
  // deixar duas vigências no mesmo dia. Carregar a linha no formulário e salvar
  // com a MESMA data cai no ON CONFLICT (user_id, vigencia_data) e atualiza.
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const editarCfg = (c: any) => {
    setEditandoId(String(c.id));
    setForm({
      userId: String(c.user_id),
      vigenciaData: String(c.vigencia_data || "").slice(0, 10),
      fixoMensal: String(Number(c.fixo_mensal) || ""),
      ajudaCusto: String(Number(c.ajuda_custo) || ""),
      comissaoTipo: c.comissao_tipo || "nenhum",
      comissaoPct: String(Number(c.comissao_pct) || ""),
      comissaoDescontoFixo: String(Number(c.comissao_desconto_fixo) || ""),
      comissaoProporcionalMeta: c.comissao_proporcional_meta === true,
      comissaoAbateFixo: typeof c.comissao_abate_fixo === "boolean" ? c.comissao_abate_fixo : null,
      comissaoFaixas: (c.comissao_faixas || []).length
        ? (c.comissao_faixas || []).map((f: any) => ({
            de: String(f.de ?? ""), ate: f.ate === null || f.ate === undefined ? "" : String(f.ate), pct: String(f.pct ?? ""),
          }))
        : [{ de: "0", ate: "", pct: "" }],
      faixaTipo: c.faixa_tipo || "telemarketing",
      incluirNoResumo: c.incluir_no_resumo !== false,
      usaFixo: c.usa_fixo !== false,
      usaAjudaCusto: c.usa_ajuda_custo === true,
      usaMeta: c.usa_meta !== false,
      usaFaturamento: c.usa_faturamento !== false,
      usaComissao: c.usa_comissao !== false,
      usaKm: c.usa_km !== false,
      usaCampanhas: c.usa_campanhas !== false,
      usaBonus: c.usa_bonus === true,
      consolidaTotais: c.consolida_totais === true,
      observacao: c.observacao || "",
    });
  };
  const cancelarEdicao = () => { setEditandoId(null); setForm(vazio); };

  const agruparGrupo = useMutation({
    mutationFn: (v: { grupo: string; agrupar: boolean }) =>
      apiRequest("POST", "/api/resumo-recebiveis/grupo", v),
    onSuccess: (r: any) => { toast({ title: r?.message || "Grupo atualizado" }); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao alterar", description: e?.message, variant: "destructive" }),
  });

  // --- campanhas
  const campVazia: any = { id: "", nome: "", origem: "manual", ymInicio: ym, ymFim: "", ativa: true, ordem: 0, observacao: "" };
  const [campForm, setCampForm] = useState<any>(campVazia);
  const setC = (k: string, v: any) => setCampForm((f: any) => ({ ...f, [k]: v }));
  const salvarCamp = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/campanhas", {
      id: campForm.id || undefined, nome: campForm.nome, origem: campForm.origem,
      ymInicio: campForm.ymInicio, ymFim: campForm.ymFim || null,
      ativa: campForm.ativa, ordem: Number(campForm.ordem) || 0, observacao: campForm.observacao,
    }),
    onSuccess: () => { toast({ title: "Campanha salva" }); setCampForm(campVazia); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao salvar", description: e?.message, variant: "destructive" }),
  });
  const removerCamp = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/campanhas/${id}`),
    onSuccess: () => { toast({ title: "Campanha removida" }); invalidar(); },
  });

  // --- valores manuais de campanha
  const [valCamp, setValCamp] = useState<any>({ campanhaId: "", userId: "", valor: "" });
  const lancarValor = useMutation({
    mutationFn: () => apiRequest("POST", `/api/resumo-recebiveis/campanhas/${valCamp.campanhaId}/valor`, {
      userId: valCamp.userId, ym, valor: num(valCamp.valor),
    }),
    onSuccess: () => { toast({ title: "Valor lançado" }); setValCamp({ ...valCamp, valor: "" }); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao lançar", description: e?.message, variant: "destructive" }),
  });

  // --- bônus avulso
  const [bon, setBon] = useState<any>({ userId: "", tipo: "bonus", descricao: "", valor: "", justificativa: "" });
  const lancarBonus = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/bonus", {
      userId: bon.userId, ym, tipo: bon.tipo, descricao: bon.descricao,
      valor: num(bon.valor), justificativa: bon.justificativa,
    }),
    onSuccess: (r: any) => {
      toast({ title: r?.message || "Lançamento feito" });
      setBon({ ...bon, descricao: "", valor: "", justificativa: "" }); invalidar();
    },
    onError: (e: any) => toast({ title: "Falha ao lançar", description: e?.message, variant: "destructive" }),
  });
  const removerBonus = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/bonus/${id}`),
    onSuccess: () => { toast({ title: "Lançamento removido" }); invalidar(); },
  });

  // (comBonus saiu: o lançamento avulso não depende mais da flag "Bônus manual".)
  const campanhasManuais = campanhas.filter((c) => c.origem === "manual");
  const lancamentos = colabs.flatMap((c) => (c.lancamentos || []).map((l) => ({ ...l, colaborador: c.nome })));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader><DialogTitle>Configurações do Resumo Recebíveis</DialogTitle></DialogHeader>

        <Tabs defaultValue="colaboradores">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="colaboradores"
              className="font-semibold text-blue-700 data-[state=active]:bg-blue-100 data-[state=active]:text-blue-900">
              Colaboradores
            </TabsTrigger>
            <TabsTrigger value="campanhas"
              className="font-semibold text-amber-700 data-[state=active]:bg-amber-100 data-[state=active]:text-amber-900">
              Campanhas
            </TabsTrigger>
            <TabsTrigger value="bonus"
              className="font-semibold text-emerald-700 data-[state=active]:bg-emerald-100 data-[state=active]:text-emerald-900">
              Bônus e lançamentos
            </TabsTrigger>
            <TabsTrigger value="participantes"
              className="font-semibold text-violet-700 data-[state=active]:bg-violet-100 data-[state=active]:text-violet-900">
              Participantes
            </TabsTrigger>
            <TabsTrigger value="historico"
              className="font-semibold text-slate-700 data-[state=active]:bg-slate-200 data-[state=active]:text-slate-900">
              Histórico
            </TabsTrigger>
          </TabsList>

          {/* ---------------- COLABORADORES ---------------- */}
          <TabsContent value="colaboradores" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Marque quais rubricas entram para cada colaborador. O que é marcado é <strong>buscado no
              módulo que calcula</strong> aquela informação. Fixo mensal é valor de cadastro, e Bônus
              manual abre o lançamento avulso. Cada linha vale <strong>a partir do mês de vigência</strong>
              — para dar um aumento, crie uma nova vigência e os meses já apurados ficam como estavam.
            </p>

            <div className="rounded-lg border bg-muted/30 p-3 space-y-3 min-w-0">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0 md:col-span-3">
                  <Label className="text-xs">Colaborador</Label>
                  {/* Travado durante a edição: trocar de pessoa aqui criaria uma
                      vigência para outra, deixando a que se queria corrigir intacta. */}
                  <Select value={form.userId} onValueChange={(v) => set("userId", v)} disabled={!!editandoId}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {(cfgData?.colaboradores || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.nome} · {PAPEL_LABEL[c.role] || c.role}{c.no_resumo === false ? " · fora do resumo" : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Vigência (a partir de)</Label>
                  <Input type="date" className="mt-1" value={form.vigenciaData}
                    onChange={(e) => set("vigenciaData", e.target.value)} data-testid="input-vigencia-data" />
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    No resumo mensal passa a valer já no mês em que esta data cai.
                  </p>
                </div>
              </div>

              <div>
                <Label className="text-xs">Rubricas deste colaborador</Label>
                <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-2">
                  {FLAGS.map((f) => (
                    <label key={f.k} className="flex items-start gap-2 rounded-md border bg-background px-2 py-1.5 cursor-pointer min-w-0"
                      title={f.ajuda}>
                      <Switch className="mt-0.5" checked={!!form[f.k]} onCheckedChange={(v) => set(f.k, v)} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium truncate">{f.label}</span>
                        <span className="block text-[10px] text-muted-foreground truncate">{f.modulo}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0">
                  <Label className="text-xs">Fixo mensal (R$)</Label>
                  <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                    value={form.fixoMensal} onChange={(e) => set("fixoMensal", e.target.value)} />
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Ajuda de custo (R$)</Label>
                  <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                    value={form.ajudaCusto} onChange={(e) => set("ajudaCusto", e.target.value)} />
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Comissão</Label>
                  <Select value={form.comissaoTipo} onValueChange={(v) => set("comissaoTipo", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nenhum">Sem comissão</SelectItem>
                      <SelectItem value="fixo">Percentual fixo</SelectItem>
                      <SelectItem value="faixa">Faixa por atingimento da meta</SelectItem>
                    <SelectItem value="escalonado">Escalonado por faturamento</SelectItem>
                    <SelectItem value="entrega">Por entrega (semana seg a dom)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.comissaoTipo === "fixo" && (
                  <>
                    <div className="min-w-0">
                      <Label className="text-xs">Percentual (%)</Label>
                      <Input className="mt-1" inputMode="decimal" placeholder="8"
                        value={form.comissaoPct} onChange={(e) => set("comissaoPct", e.target.value)} />
                    </div>
                    <div className="min-w-0">
                      <Label className="text-xs">Desconto fixo (R$)</Label>
                      <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                        value={form.comissaoDescontoFixo} onChange={(e) => set("comissaoDescontoFixo", e.target.value)} />
                    </div>
                    <div className="min-w-0 flex items-end gap-1.5 pb-1">
                      <Switch checked={form.comissaoProporcionalMeta} onCheckedChange={(v) => set("comissaoProporcionalMeta", v)} />
                      <span className="text-xs">Proporcional à meta</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" aria-label="O que é proporcional à meta"
                            className="shrink-0 text-muted-foreground hover:text-foreground">
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-96 text-xs leading-relaxed" align="start">
                          <p className="font-medium mb-1">O que muda com isto ligado</p>
                          <p className="mb-2">
                            O percentual e o desconto passam a ser aplicados sobre a <strong>meta</strong>, e o
                            colaborador recebe no mês a fatia correspondente ao quanto já faturou dela.
                          </p>
                          <div className="rounded bg-muted p-2 font-mono text-[10px] mb-2">
                            desligado: faturamento × % − desconto<br />
                            ligado: (meta × % − desconto) × (faturamento ÷ meta)
                          </div>
                          <p className="mb-2">
                            <strong>Para que serve:</strong> quando existe desconto fixo, aplicá-lo direto no
                            faturamento deixa a comissão zerada quase o mês inteiro e ela só salta no fim.
                            Proporcional, o valor cresce desde o primeiro dia. Batendo a meta cheia, os dois
                            caminhos chegam no mesmo total.
                          </p>
                          <p className="mb-2">
                            Exemplo — meta R$ 65.000, faturado R$ 28.344, 4% com desconto de R$ 1.400:<br />
                            ligado = (2.600 − 1.400) × 43,6% = <strong>R$ 523,29</strong><br />
                            desligado = 1.133 − 1.400 = negativo, piso zero = <strong>R$ 0,00</strong>
                          </p>
                          <p className="text-muted-foreground">
                            Sem desconto fixo o botão não muda nada, e ligado exige meta cadastrada no mês —
                            sem meta a comissão sai zero.
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </>
                )}
                {form.comissaoTipo === "entrega" && (
                  <div className="min-w-0 md:col-span-4 rounded-md border border-blue-200 bg-blue-50 p-2 text-[11px] text-blue-900">
                    O valor vem pronto do box <strong>Valor entregue por semana (seg a dom)</strong>: percentual
                    sobre o entregue de todos os participantes na semana, rateado pelos pontos de cada um (dias
                    entregues × peso). Quem participa e com que peso se define naquele box, não aqui. O mês leva
                    as semanas que <strong>terminaram</strong> nele — uma semana a cavalo entra inteira no mês em
                    que fechou.
                  </div>
                )}
                {form.comissaoTipo === "escalonado" && (
                  <div className="min-w-0 md:col-span-4">
                    <Label className="text-xs">Faixas por valor de faturamento</Label>
                    <p className="text-[11px] text-muted-foreground mb-1">
                      A alíquota da faixa alcançada incide sobre o faturamento inteiro. Deixe o
                      <strong> Até</strong> em branco na última faixa para dizer "daí em diante".
                    </p>
                    <div className="space-y-1">
                      {(form.comissaoFaixas || []).map((f: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 min-w-0">
                          <span className="text-[11px] text-muted-foreground w-6 shrink-0">De</span>
                          <Input className="h-8" inputMode="decimal" placeholder="0,00" value={f.de}
                            onChange={(e) => {
                              const fx = [...form.comissaoFaixas]; fx[i] = { ...fx[i], de: e.target.value };
                              set("comissaoFaixas", fx);
                            }} />
                          <span className="text-[11px] text-muted-foreground w-6 shrink-0">Até</span>
                          <Input className="h-8" inputMode="decimal" placeholder="sem teto" value={f.ate}
                            onChange={(e) => {
                              const fx = [...form.comissaoFaixas]; fx[i] = { ...fx[i], ate: e.target.value };
                              set("comissaoFaixas", fx);
                            }} />
                          <Input className="h-8 w-20 shrink-0" inputMode="decimal" placeholder="%" value={f.pct}
                            onChange={(e) => {
                              const fx = [...form.comissaoFaixas]; fx[i] = { ...fx[i], pct: e.target.value };
                              set("comissaoFaixas", fx);
                            }} />
                          <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0 text-red-600"
                            onClick={() => set("comissaoFaixas", form.comissaoFaixas.filter((_: any, j: number) => j !== i))}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button type="button" variant="outline" size="sm" className="mt-1 h-7 text-xs"
                      onClick={() => set("comissaoFaixas", [...(form.comissaoFaixas || []), { de: "", ate: "", pct: "" }])}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar faixa
                    </Button>
                  </div>
                )}
                {form.comissaoTipo === "faixa" && (
                  <div className="min-w-0">
                    <Label className="text-xs">Tabela de faixas</Label>
                    <Select value={form.faixaTipo} onValueChange={(v) => set("faixaTipo", v)}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="telemarketing">Vendas internas</SelectItem>
                        <SelectItem value="vendedor_pj">Externo PJ</SelectItem>
                        <SelectItem value="vendedor_clt">Externo CLT</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {form.comissaoTipo !== "nenhum" && (
                  <div className="min-w-0 md:col-span-4 rounded-md border p-2">
                    <div className="flex items-center gap-1.5">
                      <Switch checked={abateFixo} disabled={form.consolidaTotais}
                        onCheckedChange={(v) => set("comissaoAbateFixo", v)} />
                      <span className="text-xs font-medium">Comissão a partir do fixo mensal</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" aria-label="O que é comissão a partir do fixo mensal"
                            className="shrink-0 text-muted-foreground hover:text-foreground">
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-96 text-xs leading-relaxed" align="start">
                          <p className="font-medium mb-1">O fixo adianta a comissão</p>
                          <p className="mb-2">
                            Ligado, o fixo mensal é tratado como adiantamento: o colaborador só recebe
                            comissão no que ela <strong>passar</strong> do fixo.
                          </p>
                          <div className="rounded bg-muted p-2 font-mono text-[10px] mb-2">
                            comissão paga = apurado − fixo mensal (piso zero)
                          </div>
                          <p className="mb-2">
                            Exemplo — fixo R$ 3.000 e 8% sobre R$ 40.000:<br />
                            apurado R$ 3.200 − fixo R$ 3.000 = <strong>R$ 200</strong> de comissão,
                            e o total do mês continua R$ 3.200.
                          </p>
                          <p className="mb-2">
                            <strong>Ajuda de custo não abate.</strong> Quem recebe só ajuda de custo, sem
                            fixo, leva o percentual cheio sobre o faturamento — ela é reembolso de
                            despesa, não remuneração.
                          </p>
                          <p className="text-muted-foreground">
                            Padrão ligado para vendedor PJ. Coordenação de vendas (quem consolida os
                            totais da equipe) tem fixo livre: lá a regra não vale e o seletor fica travado.
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {form.consolidaTotais
                        ? "Coordenação de vendas: fixo livre e percentual sobre o faturamento total da equipe."
                        : abateFixo
                        ? "Só entra na folha o que a comissão passar do fixo mensal. Sem fixo cadastrado, o percentual sai cheio."
                        : "A comissão é paga cheia, somada ao fixo mensal."}
                    </p>
                  </div>
                )}
                <div className="min-w-0 md:col-span-2">
                  <Label className="text-xs">Observação</Label>
                  <Input className="mt-1" maxLength={500} value={form.observacao}
                    onChange={(e) => set("observacao", e.target.value)} placeholder="Ex.: reajuste aprovado em reunião" />
                </div>
              </div>

              {(() => {
                const alvo = colabs.find((c) => c.id === form.userId);
                if (!form.userId) return null;
                const regraCom = form.comissaoTipo === "entrega"
                  ? (alvo?.entregaSemanas
                      ? `${alvo.entregaSemanas} semana(s) · ${brl(alvo.entregaValorEntregue || 0)} entregues`
                      : "rateio semanal das entregas")
                  : form.comissaoTipo === "escalonado"
                  ? ((form.comissaoFaixas || []).filter((f: any) => String(f.pct).trim() !== "").length
                      ? (form.comissaoFaixas as any[]).filter((f: any) => String(f.pct).trim() !== "")
                          .map((f: any) => `${brl(num(f.de))}${String(f.ate).trim() === "" ? " ou mais" : ` a ${brl(num(f.ate))}`} = ${f.pct}%`)
                          .join(" · ")
                      : "escalonado, sem faixas cadastradas")
                  : form.comissaoTipo === "faixa"
                  ? `Faixa por atingimento (${form.faixaTipo === "telemarketing" ? "vendas internas" : form.faixaTipo === "vendedor_pj" ? "externo PJ" : "externo CLT"})`
                  : form.comissaoTipo === "fixo"
                    ? `${form.comissaoPct || 0}% sobre o faturamento${num(form.comissaoDescontoFixo) > 0 ? `, menos ${brl(num(form.comissaoDescontoFixo))}` : ""}${form.comissaoProporcionalMeta ? ", proporcional à meta" : ""}`
                    : "Sem comissão";
                const itens: Array<[string, string, string]> = [
                  ["Fixo mensal", "Cadastro (esta tela)", form.fixoMensal ? brl(num(form.fixoMensal)) : "a preencher"],
                  ["Ajuda de custo", "Cadastro (esta tela)", form.usaAjudaCusto ? (form.ajudaCusto ? brl(num(form.ajudaCusto)) : "a preencher") : "não recebe"],
                  ["Meta", form.consolidaTotais ? "Soma das metas da equipe" : "Metas de Vendas",
                    alvo?.meta ? brl(alvo.meta) : "sem meta cadastrada em " + nomeDoMes(ym)],
                  ["Faturamento", form.consolidaTotais ? "Soma do faturamento da equipe" : "Faturamento oficial",
                    alvo?.faturamento != null ? brl(alvo.faturamento) : "—"],
                  ["Comissão mês", form.comissaoTipo === "entrega" ? "Valor entregue por semana" : "Regra do colaborador", regraCom],
                  ["Km", "Kilometragem Vendedores",
                    alvo ? `${brl(alvo.kmTarifa)}/km · ${(alvo as any).kmTarifaPropria ? "tarifa própria" : `tarifa da região ${(alvo as any).kmRegiao || "GO"}`}` : "—"],
                  ["Campanhas", "Módulos de campanha",
                    campanhas.length ? campanhas.map((c) => `${c.nome} (${c.origem === "campanha" ? "módulo" : "manual"})`).join(" · ") : "nenhuma vigente em " + nomeDoMes(ym)],
                ];
                return (
                  <div className="rounded-md border bg-background p-2">
                    <div className="text-xs font-medium mb-1">De onde vem cada número deste colaborador</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5">
                      {itens.map(([rub, mod, regra]) => (
                        <div key={rub} className="flex items-baseline gap-1 text-[11px] min-w-0">
                          <span className="font-medium shrink-0">{rub}:</span>
                          <span className="text-muted-foreground shrink-0">{mod} —</span>
                          <span className="truncate" title={regra}>{regra}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="flex items-center justify-end gap-2">
                {editandoId && (
                  <>
                    <span className="mr-auto text-xs text-amber-700">
                      Editando a vigência de <strong>{dataBR(form.vigenciaData)}</strong>. Salvar com esta
                      mesma data <strong>substitui</strong> a linha; mudar a data cria outra vigência e a
                      antiga continua valendo até ela.
                    </span>
                    <Button size="sm" variant="outline" onClick={cancelarEdicao}>Cancelar</Button>
                  </>
                )}
                <Button size="sm" disabled={!form.userId || salvarCfg.isPending} onClick={() => salvarCfg.mutate()}>
                  {salvarCfg.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                  {editandoId ? "Salvar alterações" : "Salvar vigência"}
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60">
                    <th className="text-left px-2 py-1.5">Colaborador</th>
                    <th className="text-left px-2 py-1.5">Vigência</th>
                    <th className="text-right px-2 py-1.5">Fixo</th>
                    <th className="text-right px-2 py-1.5">Ajuda</th>
                    <th className="text-left px-2 py-1.5">Comissão</th>
                    <th className="text-left px-2 py-1.5">Rubricas</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {(cfgData?.configs || []).map((c: any) => (
                    <tr key={c.id} className={`border-t ${editandoId === String(c.id) ? "bg-amber-50" : ""}`}>
                      <td className="px-2 py-1.5">
                        {c.nome}
                      </td>
                      <td className="px-2 py-1.5">{dataBR(c.vigencia_data)}</td>
                      <td className="px-2 py-1.5 text-right">{brl(Number(c.fixo_mensal))}</td>
                      <td className="px-2 py-1.5 text-right">{c.usa_ajuda_custo ? brl(Number(c.ajuda_custo)) : "—"}</td>
                      <td className="px-2 py-1.5">
                        {c.comissao_tipo === "entrega" ? "Por entrega"
                      : c.comissao_tipo === "escalonado"
                      ? `Escalonado (${(c.comissao_faixas || []).length} faixas)`
                      : c.comissao_tipo === "faixa" ? "Faixa"
                          : c.comissao_tipo === "fixo"
                            ? `${Number(c.comissao_pct)}%${Number(c.comissao_desconto_fixo) > 0 ? ` − ${brl(Number(c.comissao_desconto_fixo))}` : ""}${c.comissao_proporcional_meta ? " prop." : ""}`
                            : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {[c.usa_fixo && "fixo", c.usa_ajuda_custo && "ajuda", c.usa_meta && "meta", c.usa_faturamento && "fat.",
                          c.usa_comissao && "com.", c.usa_km && "km", c.usa_campanhas && "camp.",
                          c.usa_bonus && "bônus", c.consolida_totais && "consolida"].filter(Boolean).join(" · ") || "nenhuma"}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        {/* Editar carrega a linha no formulário acima; salvar com a
                            mesma vigência substitui, sem precisar apagar e refazer. */}
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-emerald-700"
                          title="Editar esta vigência" aria-label={`Editar a vigência de ${c.nome}`}
                          onClick={() => editarCfg(c)} data-testid={`editar-cfg-${c.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-600"
                          title="Excluir esta vigência" aria-label={`Excluir a vigência de ${c.nome}`}
                          onClick={() => removerCfg.mutate(c.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ---------------- CAMPANHAS ---------------- */}
          <TabsContent value="campanhas" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Toda campanha vigente vira uma <strong>coluna</strong> na planilha, nos meses dentro da
              vigência. Origem <strong>Módulo da campanha</strong> puxa o bônus que o próprio módulo apura;
              origem <strong>Manual</strong> abre o lançamento por colaborador na aba ao lado.
            </p>

            <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
              <div className="min-w-0 md:col-span-2">
                <Label className="text-xs">Nome da campanha</Label>
                <Input className="mt-1" maxLength={120} value={campForm.nome}
                  onChange={(e) => setC("nome", e.target.value)} placeholder="Ex.: Desafio de Novembro" />
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Origem do valor</Label>
                <Select value={campForm.origem} onValueChange={(v) => setC("origem", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual (admin informa)</SelectItem>
                    <SelectItem value="campanha">Módulo da campanha</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 flex items-end gap-2 pb-1">
                <Switch checked={campForm.ativa} onCheckedChange={(v) => setC("ativa", v)} />
                <span className="text-xs">Ativa</span>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Início</Label>
                <Select value={campForm.ymInicio} onValueChange={(v) => setC("ymInicio", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Fim (vazio = sem prazo)</Label>
                <Select value={campForm.ymFim || "sem-prazo"} onValueChange={(v) => setC("ymFim", v === "sem-prazo" ? "" : v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sem-prazo">Sem prazo</SelectItem>
                    {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Ordem da coluna</Label>
                <Input className="mt-1" inputMode="numeric" value={campForm.ordem}
                  onChange={(e) => setC("ordem", e.target.value)} />
              </div>
              <div className="min-w-0 flex items-end">
                <Button size="sm" className="w-full" disabled={!campForm.nome.trim() || salvarCamp.isPending}
                  onClick={() => salvarCamp.mutate()}>
                  {salvarCamp.isPending ? <Loader2 className="h-4 w-4 animate-spin" />
                    : campForm.id ? "Atualizar" : "Criar campanha"}
                </Button>
              </div>
              <div className="min-w-0 md:col-span-4">
                <Label className="text-xs">Observação</Label>
                <Input className="mt-1" maxLength={500} value={campForm.observacao}
                  onChange={(e) => setC("observacao", e.target.value)} placeholder="Aparece ao passar o mouse no cabeçalho da coluna" />
              </div>
            </div>

            <div className="space-y-1">
              {(campData?.campanhas || []).map((c: any) => (
                <div key={c.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm min-w-0">
                  <Megaphone className={`h-4 w-4 shrink-0 ${c.ativa ? "text-emerald-600" : "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {c.nome}
                      {!c.ativa && <Badge className="ml-2 bg-gray-200 text-gray-700">inativa</Badge>}
                      <Badge className="ml-2 bg-blue-100 text-blue-800">
                        {c.origem === "campanha" ? "módulo" : "manual"}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {nomeDoMes(c.ym_inicio)} {c.ym_fim ? `até ${nomeDoMes(c.ym_fim)}` : "— sem prazo"}
                      {c.observacao ? ` · ${c.observacao}` : ""}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs"
                    onClick={() => setCampForm({
                      id: c.id, nome: c.nome, origem: c.origem, ymInicio: c.ym_inicio,
                      ymFim: c.ym_fim || "", ativa: c.ativa, ordem: c.ordem, observacao: c.observacao || "",
                    })}>
                    editar
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-red-600"
                    onClick={() => removerCamp.mutate(c.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* ---------------- BÔNUS E LANÇAMENTOS ---------------- */}
          <TabsContent value="bonus" className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold mb-1">Valor de campanha manual — {nomeDoMes(ym)}</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Para as campanhas de origem Manual. O valor vale apenas para o mês selecionado na planilha.
              </p>
              {campanhasManuais.length === 0 ? (
                <div className="rounded-md border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
                  Nenhuma campanha manual vigente neste mês. Crie uma na aba Campanhas.
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                  <div className="min-w-0">
                    <Label className="text-xs">Campanha</Label>
                    <Select value={valCamp.campanhaId} onValueChange={(v) => setValCamp({ ...valCamp, campanhaId: v })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                      <SelectContent>
                        {campanhasManuais.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-xs">Colaborador</Label>
                    <Select value={valCamp.userId} onValueChange={(v) => setValCamp({ ...valCamp, userId: v })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                      <SelectContent>
                        {colabs.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-xs">Valor (R$)</Label>
                    <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                      value={valCamp.valor} onChange={(e) => setValCamp({ ...valCamp, valor: e.target.value })} />
                  </div>
                  <div className="min-w-0 flex items-end">
                    <Button size="sm" className="w-full"
                      disabled={!valCamp.campanhaId || !valCamp.userId || lancarValor.isPending}
                      onClick={() => lancarValor.mutate()}>
                      {lancarValor.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lançar"}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-1">Lançamento avulso — {nomeDoMes(ym)}</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Para o que não cabe em nenhuma regra: um prêmio, um acerto a mais ou um desconto.
                Vale para <strong>qualquer colaborador da planilha</strong> — não é preciso marcar nada
                antes no cadastro. O <strong>débito entra negativo</strong> e reduz o total do mês.
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0">
                  <Label className="text-xs">Colaborador</Label>
                  <Select value={bon.userId} onValueChange={(v) => setBon({ ...bon, userId: v })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {(cfgData?.colaboradores || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.nome} · {PAPEL_LABEL[c.role] || c.role}{c.no_resumo === false ? " · fora do resumo" : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Tipo</Label>
                  <Select value={bon.tipo} onValueChange={(v) => setBon({ ...bon, tipo: v })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bonus">Bônus (soma)</SelectItem>
                      <SelectItem value="credito">Crédito (soma)</SelectItem>
                      <SelectItem value="debito">Débito (subtrai)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Descrição</Label>
                  <Input className="mt-1" maxLength={300} value={bon.descricao}
                    onChange={(e) => setBon({ ...bon, descricao: e.target.value })}
                    placeholder="Ex.: prêmio da campanha de reativação" />
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Valor (R$)</Label>
                  <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                    value={bon.valor} onChange={(e) => setBon({ ...bon, valor: e.target.value })} />
                  {bon.tipo === "debito" && (
                    <p className="mt-1 text-[11px] text-red-600">Informe positivo; entra como −{brl(num(bon.valor))}.</p>
                  )}
                </div>
                <div className="min-w-0 md:col-span-4">
                  <Label className="text-xs">
                    Justificativa{bon.tipo === "debito" ? " (obrigatória no débito)" : ""}
                  </Label>
                  <Textarea className="mt-1 resize-none" rows={2} maxLength={2000}
                    value={bon.justificativa}
                    onChange={(e) => setBon({ ...bon, justificativa: e.target.value })}
                    placeholder="Por que este lançamento existe. Aparece no 'i' da célula e no histórico." />
                </div>
                <div className="md:col-span-4 flex justify-end">
                  <Button size="sm"
                    disabled={!bon.userId || !bon.descricao.trim() || !(num(bon.valor) > 0)
                      || (bon.tipo === "debito" && !bon.justificativa.trim()) || lancarBonus.isPending}
                    onClick={() => lancarBonus.mutate()}>
                    {lancarBonus.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                    Lançar {bon.tipo === "debito" ? "débito" : bon.tipo === "credito" ? "crédito" : "bônus"}
                  </Button>
                </div>
              </div>

              {lancamentos.length > 0 && (
                <div className="space-y-1 mt-2">
                  {lancamentos.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm min-w-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{l.colaborador}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {TIPO_LANC[l.tipo || "bonus"] || "Bônus"} · {l.descricao}
                        </div>
                        {l.justificativa && (
                          <div className="truncate text-[11px] text-muted-foreground italic" title={l.justificativa}>
                            {l.justificativa}
                          </div>
                        )}
                      </div>
                      <span className={`shrink-0 font-medium ${l.valor < 0 ? "text-red-600" : ""}`}>{brl(l.valor)}</span>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-red-600"
                        onClick={() => removerBonus.mutate(l.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
          {/* ---------------- PARTICIPANTES ---------------- */}
          <TabsContent value="participantes" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Quem sai daqui some da planilha e do seletor de colaborador das outras abas. Use para contas
              que não são pessoas — canais, usuários de sistema — e para cadastros de teste. A lista traz
              <strong> todos os usuários ativos</strong>, de qualquer função: ligar o botão de alguém fora
              de vendas (um administrador, por exemplo) coloca essa pessoa na planilha.
            </p>
            <Input className="h-8" placeholder="Buscar por nome ou e-mail…"
              value={buscaPart} onChange={(e) => setBuscaPart(e.target.value)} />
            {(() => {
              const t = buscaPart.trim().toLowerCase();
              const lista = (cfgData?.participantes || []).filter((p: any) => !t
                || String(p.nome || "").toLowerCase().includes(t)
                || String(p.email || "").toLowerCase().includes(t));
              // Cada um continua com o seu liga/desliga; o grupo só organiza a
              // lista, que vinha com canal, motorista e sistema no meio da equipe.
              return GRUPOS_PARTICIPANTE.map(({ k, label, ajuda }) => {
                const doGrupo = lista.filter((p: any) => (p.grupo || "outros") === k);
                if (!doGrupo.length) return null;
                const dentro = doGrupo.filter((p: any) => p.incluir !== false).length;
                return (
                  <div key={k} className="space-y-1 pt-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {label} <span className="font-normal normal-case">· {ajuda}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                        {dentro} de {doGrupo.length} na planilha
                        <span className="flex items-center gap-1 rounded-md border px-2 py-0.5">
                          <Switch checked={cfgData?.grupos?.[k] === true}
                            onCheckedChange={(v) => agruparGrupo.mutate({ grupo: k, agrupar: v })} />
                          <span>Agrupar numa linha</span>
                          <Popover>
                            <PopoverTrigger asChild>
                              <button type="button" aria-label={`O que faz agrupar ${label}`}
                                className="shrink-0 text-muted-foreground hover:text-foreground">
                                <Info className="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80 text-xs leading-relaxed" align="end">
                              <p className="font-medium mb-1">Agrupar {label} numa linha</p>
                              <p className="mb-2">
                                Ligado, a planilha mostra <strong>só a palavra {label}</strong>, com os valores
                                de todos somados — o nome de cada um some da lista. Desligado, cada pessoa
                                tem a sua linha, como sempre foi.
                              </p>
                              {k === "outros" ? (
                                <p className="mb-2">
                                  A linha <strong>Outros</strong> ainda recolhe o faturamento que não cai em
                                  linha nenhuma: nota sem vendedor, venda de quem não participa do resumo e
                                  venda de quem está com a rubrica Faturamento desligada. Havendo esse valor,
                                  a linha aparece mesmo com o agrupamento desligado — o dinheiro saiu em NF-e
                                  e esconder não é opção. O "i" da linha mostra a composição.
                                </p>
                              ) : (
                                <p className="mb-2">
                                  Ligar não muda nenhum valor: muda só como a planilha mostra. O total do mês
                                  continua o mesmo.
                                </p>
                              )}
                              <p className="text-muted-foreground">
                                Quem está desligado no seu botão continua fora da planilha, agrupado ou não.
                              </p>
                            </PopoverContent>
                          </Popover>
                        </span>
                      </span>
                    </div>
                    {doGrupo.map((p: any) => (
                      <div key={p.id}
                        className={`flex items-center gap-3 rounded-md border px-3 py-1.5 text-sm min-w-0 ${p.incluir ? "" : "bg-muted/40"}`}>
                        <Switch checked={p.incluir !== false}
                          onCheckedChange={(v) => participacao.mutate({ userId: p.id, incluir: v })} />
                        <div className="min-w-0 flex-1">
                          <div className={`truncate font-medium ${p.incluir ? "" : "text-muted-foreground line-through"}`}>
                            {p.nome}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{p.email || "—"}</div>
                        </div>
                        <Badge className={`${PAPEL_COR[p.role] || "bg-slate-100 text-slate-700"} shrink-0`}>
                          {PAPEL_LABEL[p.role] || p.role}
                        </Badge>
                        {!p.papel_de_vendas && p.incluir && (
                          <Badge className="bg-emerald-100 text-emerald-800 shrink-0">incluído à mão</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                );
              });
            })()}
          </TabsContent>
          {/* ---------------- HISTÓRICO ---------------- */}
          <TabsContent value="historico" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Tudo que foi alterado nas configurações do resumo: quem fez, quando e o quê. A trilha é só
              leitura — não há como editar nem apagar um registro pela tela. Horário de Brasília, 200
              alterações mais recentes.
            </p>
            {!(auditData?.registros || []).length ? (
              <div className="rounded-md border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
                Nenhuma alteração registrada ainda.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="text-left px-2 py-1.5 whitespace-nowrap">Data e hora</th>
                      <th className="text-left px-2 py-1.5 whitespace-nowrap">Quem alterou</th>
                      <th className="text-left px-2 py-1.5 whitespace-nowrap">Tipo</th>
                      <th className="text-left px-2 py-1.5 whitespace-nowrap">Sobre</th>
                      <th className="text-left px-2 py-1.5">O que foi alterado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(auditData?.registros || []).map((a: any) => (
                      <tr key={a.id} className="border-t align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                          {dataHora(a.quando)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap font-medium">{a.autor_nome || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <Badge className={ACAO_COR[a.acao] || "bg-gray-100 text-gray-800"}>{a.acao}</Badge>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{a.alvo_nome || "—"}</td>
                        <td className="px-2 py-1.5">{a.descricao}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
