// client/src/pages/AgendaCarteira.tsx
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba "Agenda da carteira".
//
// Tabela dinamica de nº de atendimentos por dia da semana, uma coluna por semana,
// separando PRESENCIAL de VIRTUAL. Abaixo, a relacao de clientes que sustenta
// cada numero — clicar em qualquer numero filtra a relacao.
//
// JANELA DESLIZANTE: 8 semanas passadas, a vigente e 8 proximas. Nao acompanha
// o mes — anda junto com a semana de hoje. A semana e' de segunda a sexta.
//
// Ate hoje o quadro mostra a AGENDA REAL (o que esteve marcado); de amanha em
// diante, a PROJECAO do cadastro ancorada na ultima visita concluida — e' o que
// faz mudanca de periodicidade ou de dia aparecer na hora.
// -----------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Download, Search, ArrowUp, ArrowDown, ChevronsUpDown, Info, CalendarDays } from "lucide-react";
import { exportToExcel, MultiSelect } from "@/lib/tableTools";

type Item = {
  id: string;
  tipo: "cliente" | "lead";
  nome: string;
  cidade: string;
  vendedor: string;
  sellerId: string;
  canal: "presencial" | "virtual";
  periodicidade: string;
  dias: string[];
  ultimaVisita: string | null;
  pedidoUltimaVisita?: number;
  dataUltimoPedido?: string | null;
  datas: string[];
};
type Semana = { i: number; off: number; ini: string; fim: string; rotulo: string; atual: boolean; passada: boolean };

const DIAS = [
  { n: 1, curto: "2ª", longo: "Segunda", cod: "Seg" },
  { n: 2, curto: "3ª", longo: "Terça", cod: "Ter" },
  { n: 3, curto: "4ª", longo: "Quarta", cod: "Qua" },
  { n: 4, curto: "5ª", longo: "Quinta", cod: "Qui" },
  { n: 5, curto: "6ª", longo: "Sexta", cod: "Sex" },
];
const COD_LONGO: Record<string, string> = { Seg: "Segunda", Ter: "Terça", Qua: "Quarta", Qui: "Quinta", Sex: "Sexta", Sab: "Sábado", Dom: "Domingo" };
const PERIODICIDADES = ["semanal", "quinzenal", "mensal"];
const NUM = (v: any) => Number(v || 0).toLocaleString("pt-BR");
const BRL = (v: any) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
/** 'YYYY-MM-DD' -> dia da semana 1..5 (0 = fim de semana / invalido). */
const diaDaData = (s: string) => {
  const [a, m, d] = String(s || "").split("-").map(Number);
  if (!a || !m || !d) return 0;
  const w = new Date(a, m - 1, d).getDay();
  return w >= 1 && w <= 5 ? w : 0;
};
/** Quantas semanas para tras e para frente o quadro cobre (espelha o servidor). */
const SEMANAS_ATRAS = 8;
const SEMANAS_FRENTE = 8;
/** "esta semana", "3 sem. atrás", "+2 sem." — o off e' relativo a semana vigente. */
const rotuloSemana = (s: { off: number }) =>
  s.off === 0 ? "Esta semana" : s.off < 0 ? `${-s.off} sem. atrás` : `+${s.off} sem.`;

// ── Cidade: o cadastro tem "GOIANIA", "Goiânia", "goiania " e afins. Aqui a
// grafia e' padronizada para o filtro e a coluna nao brigarem entre si.
/** Chave de agrupamento: sem acento, sem caixa, sem espaço sobrando. */
const chaveCidade = (s: any) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
/** Preposições ficam em minúscula, como se escreve "Aparecida de Goiânia". */
const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "d'"]);
const tituloCidade = (s: any) =>
  String(s || "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) => (i > 0 && MINUSCULAS.has(w) ? w : w.charAt(0).toLocaleUpperCase("pt-BR") + w.slice(1)))
    .join(" ");
/** Quantos caracteres acentuados a grafia tem — a mais acentuada é a melhor. */
const acentos = (s: any) => (String(s || "").normalize("NFD").match(/[\u0300-\u036f]/g) || []).length;

const dataBR = (s: any) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : "—";
};

export default function AgendaCarteira() {
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  // Filtros da relacao de baixo (vazio = todos). Guardam o RÓTULO que aparece na
  // coluna, para o usuario nao ter que traduzir "Seg" -> "Segunda" de cabeca.
  const [fTipo, setFTipo] = useState<string[]>([]);
  const [fCanal, setFCanal] = useState<string[]>([]);
  const [fPeriodo, setFPeriodo] = useState<string[]>([]);
  const [fDia, setFDia] = useState<string[]>([]);
  const [fCidade, setFCidade] = useState<string[]>([]);
  // Celula clicada na tabela dinamica: { semana, dia, canal } — filtra a lista.
  const [celula, setCelula] = useState<{ s: number; d: number; c: string } | null>(null);
  const [ordCol, setOrdCol] = useState("nome");
  const [ordDir, setOrdDir] = useState<"asc" | "desc">("asc");
  const [editando, setEditando] = useState<string>("");
  // O quadro abre com 8 semanas de passado a esquerda; sem isso o usuario cai
  // olhando junho. Rolamos ate a semana vigente assim que ela existe no DOM.
  const rolagem = useRef<HTMLDivElement | null>(null);
  const jaRolou = useRef(false);

  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/carteira/agenda"],
    queryFn: async () => {
      const r = await fetch("/api/carteira/agenda", { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar a agenda da carteira");
      return r.json();
    },
  });

  const semanas: Semana[] = data?.semanas || [];
  const todos: Item[] = data?.itens || [];
  const hoje: string = data?.hoje || "";
  const semanaAtual = semanas.find((s) => s.atual);
  const escopoRestrito = data?.escopo?.restrito === true;
  const podeEditarVisita = data?.podeEditarVisita === true;

  // Opções do filtro de vendedor: quem realmente tem alguém na janela.
  const opcoesVend = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of todos) if (i.datas.length) c.set(i.vendedor, (c.get(i.vendedor) || 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [todos]);
  // O filtro guarda o nome puro — nunca um rótulo com contagem, que muda sozinho.
  useEffect(() => {
    setVendedores((sel) => sel.filter((v) => opcoesVend.includes(v)));
  }, [opcoesVend]);

  // Base do quadro: só quem tem atendimento na janela, já pelo vendedor filtrado.
  const base = useMemo(() => {
    const sel = new Set(vendedores);
    return todos.filter((i) => i.datas.length > 0 && (sel.size === 0 || sel.has(i.vendedor)));
  }, [todos, vendedores]);

  /** Índice da semana de uma data (1..17); 0 se cair fora da janela. */
  const semanaDaData = useMemo(() => {
    const faixas = semanas.map((s) => [s.ini, s.fim, s.i] as [string, string, number]);
    return (d: string) => {
      for (const [ini, fim, i] of faixas) if (d >= ini && d <= fim) return i;
      return 0;
    };
  }, [semanas]);

  // Tabela dinâmica: contagem de clientes distintos por semana × dia × canal.
  const pivo = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of base) {
      for (const dt of it.datas) {
        const s = semanaDaData(dt);
        const d = diaDaData(dt);
        if (!s || !d) continue;
        const k = `${s}|${d}|${it.canal}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return m;
  }, [base, semanaDaData]);
  const conta = (s: number, d: number, c: string) => pivo.get(`${s}|${d}|${c}`) || 0;
  const totalSemana = (s: number, c: string) => DIAS.reduce((t, x) => t + conta(s, x.n, c), 0);

  // Grafia canônica de cada cidade: entre as variações do cadastro, ganha a que
  // tem mais acento (é a que carrega mais informação) e ela vai para Title Case.
  const cidadePadrao = useMemo(() => {
    const melhor = new Map<string, string>();
    for (const i of todos) {
      const bruta = String(i.cidade || "").trim();
      if (!bruta) continue;
      const k = chaveCidade(bruta);
      const atual = melhor.get(k);
      if (!atual || acentos(bruta) > acentos(atual)) melhor.set(k, bruta);
    }
    const m = new Map<string, string>();
    for (const [k, bruta] of melhor) m.set(k, tituloCidade(bruta));
    return (c: any) => {
      const k = chaveCidade(c);
      return k ? m.get(k) || tituloCidade(c) : "";
    };
  }, [todos]);

  // Rótulos de cada coluna filtrável — as mesmas palavras que aparecem na tabela.
  const rotuloTipo = (i: Item) => (i.tipo === "lead" ? "Lead" : "Cliente");
  const rotuloCanal = (i: Item) => (i.canal === "virtual" ? "Virtual" : "Presencial");
  const rotuloPeriodo = (i: Item) => i.periodicidade || "—";
  const rotulosDia = (i: Item) => (i.dias.length ? i.dias.map((d) => COD_LONGO[d] || d) : ["—"]);
  const rotuloCidade = (i: Item) => cidadePadrao(i.cidade) || "(sem cidade)";

  /** Opções de um filtro: o que existe na base, já pelo vendedor escolhido. */
  const opcoesDe = (fn: (i: Item) => string[] | string) =>
    Array.from(new Set(base.flatMap((i) => { const v = fn(i); return Array.isArray(v) ? v : [v]; })))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const opTipo = useMemo(() => opcoesDe(rotuloTipo), [base]);
  const opCanal = useMemo(() => opcoesDe(rotuloCanal), [base]);
  const opPeriodo = useMemo(() => opcoesDe(rotuloPeriodo), [base]);
  const opDia = useMemo(
    () => DIAS.map((d) => d.longo).filter((l) => base.some((i) => rotulosDia(i).includes(l))),
    [base],
  );
  const opCidade = useMemo(() => opcoesDe(rotuloCidade), [base, cidadePadrao]);

  // Escolha que sumiu da base (troquei de vendedor) não pode ficar filtrando escondida.
  useEffect(() => { setFTipo((v) => v.filter((x) => opTipo.includes(x))); }, [opTipo]);
  useEffect(() => { setFCanal((v) => v.filter((x) => opCanal.includes(x))); }, [opCanal]);
  useEffect(() => { setFPeriodo((v) => v.filter((x) => opPeriodo.includes(x))); }, [opPeriodo]);
  useEffect(() => { setFDia((v) => v.filter((x) => opDia.includes(x))); }, [opDia]);
  useEffect(() => { setFCidade((v) => v.filter((x) => opCidade.includes(x))); }, [opCidade]);

  const temFiltroColuna = fTipo.length + fCanal.length + fPeriodo.length + fDia.length + fCidade.length > 0;
  const limparTudo = () => {
    setCelula(null); setBusca("");
    setFTipo([]); setFCanal([]); setFPeriodo([]); setFDia([]); setFCidade([]);
  };

  // Lista de baixo: obedece a célula clicada, os filtros de coluna e a busca.
  const lista = useMemo(() => {
    let l = base;
    if (celula) {
      l = l.filter(
        (i) => i.canal === celula.c && i.datas.some((dt) => semanaDaData(dt) === celula.s && diaDaData(dt) === celula.d),
      );
    }
    if (fTipo.length) l = l.filter((i) => fTipo.includes(rotuloTipo(i)));
    if (fCanal.length) l = l.filter((i) => fCanal.includes(rotuloCanal(i)));
    if (fPeriodo.length) l = l.filter((i) => fPeriodo.includes(rotuloPeriodo(i)));
    // Cliente com dois dias entra se QUALQUER um deles estiver escolhido.
    if (fDia.length) l = l.filter((i) => rotulosDia(i).some((d) => fDia.includes(d)));
    if (fCidade.length) l = l.filter((i) => fCidade.includes(rotuloCidade(i)));
    const alvo = busca.trim().toLocaleLowerCase("pt-BR");
    if (alvo.length >= 2) {
      l = l.filter((i) => i.nome.toLocaleLowerCase("pt-BR").includes(alvo) || cidadePadrao(i.cidade).toLocaleLowerCase("pt-BR").includes(alvo));
    }
    return l;
  }, [base, celula, busca, semanaDaData, fTipo, fCanal, fPeriodo, fDia, fCidade, cidadePadrao]);

  const valorCol = (i: Item, k: string): any => {
    switch (k) {
      case "nome": return i.nome.toLocaleLowerCase("pt-BR");
      case "tipo": return i.tipo;
      case "canal": return i.canal;
      case "periodicidade": return i.periodicidade;
      case "dias": return i.dias.join(",");
      case "cidade": return cidadePadrao(i.cidade).toLocaleLowerCase("pt-BR");
      case "vendedor": return i.vendedor.toLocaleLowerCase("pt-BR");
      case "pedido": return Number(i.pedidoUltimaVisita || 0);
      default: return "";
    }
  };
  const listaOrdenada = useMemo(() => {
    const dir = ordDir === "asc" ? 1 : -1;
    return [...lista].sort((a, b) => {
      const va = valorCol(a, ordCol), vb = valorCol(b, ordCol);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "pt-BR") * dir;
    });
  }, [lista, ordCol, ordDir, cidadePadrao]);

  const clicaOrd = (k: string) => {
    if (ordCol !== k) { setOrdCol(k); setOrdDir("asc"); return; }
    setOrdDir((d) => (d === "asc" ? "desc" : "asc"));
  };
  const th = (k: string, label: string, cls = "") => {
    const ativa = ordCol === k;
    const Icone = !ativa ? ChevronsUpDown : ordDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={`cursor-pointer select-none ${cls}`} onClick={() => clicaOrd(k)} data-testid={`th-agenda-${k}`}>
        <span className="inline-flex items-center gap-1">
          {label}
          <Icone className={`h-3 w-3 ${ativa ? "opacity-90" : "opacity-30"}`} />
        </span>
      </TableHead>
    );
  };

  const exportar = () => {
    const quadro: Record<string, any>[] = [];
    for (const canal of ["presencial", "virtual"]) {
      for (const dia of DIAS) {
        const linha: Record<string, any> = { Canal: canal === "presencial" ? "PRESENCIAL" : "VIRTUAL", Dia: dia.curto };
        for (const s of semanas) linha[`${rotuloSemana(s)} (${s.rotulo})`] = conta(s.i, dia.n, canal);
        quadro.push(linha);
      }
    }
    exportToExcel(quadro, `agenda-carteira-${hoje || "janela"}`);
    const clientes = listaOrdenada.map((i) => ({
      Cliente: i.nome,
      Tipo: i.tipo === "lead" ? "Lead" : "Cliente",
      Atendimento: i.canal === "virtual" ? "Virtual" : "Presencial",
      Periodicidade: i.periodicidade,
      "Dia(s) de atendimento": i.dias.map((d) => COD_LONGO[d] || d).join(", "),
      Cidade: cidadePadrao(i.cidade),
      Vendedor: i.vendedor,
      "Pedido na última visita (R$)": Number(i.pedidoUltimaVisita || 0),
      "Data da última visita": i.dataUltimoPedido ? dataBR(i.dataUltimoPedido) : (i.ultimaVisita ? dataBR(i.ultimaVisita) : ""),
      Datas: i.datas.map(dataBR).join(" · "),
    }));
    exportToExcel(clientes, `agenda-carteira-clientes-${hoje || "janela"}`);
  };

  useEffect(() => {
    if (jaRolou.current || !semanas.length) return;
    const box = rolagem.current;
    const alvo = box?.querySelector<HTMLElement>("[data-semana-atual='1']");
    if (!box || !alvo) return;
    box.scrollLeft = Math.max(0, alvo.offsetLeft - 220);
    jaRolou.current = true;
  }, [semanas.length]);

  const semanaPorI = (i: number) => semanas.find((s) => s.i === i);
  const rotuloCelula = celula
    ? `${(() => { const sm = semanaPorI(celula.s); return sm ? `${rotuloSemana(sm)} (${sm.rotulo})` : `semana ${celula.s}`; })()} · ${DIAS.find((d) => d.n === celula.d)?.longo} · ${celula.c === "virtual" ? "virtual" : "presencial"}`
    : "";

  return (
    <div className="space-y-6">
      {/* Filtros da aba */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-end gap-3">
          <div className="pt-[21px]">
            <div className="px-3 py-2 border rounded-md text-sm bg-muted/40 text-muted-foreground whitespace-nowrap" data-testid="selo-semana-vigente">
              Semana vigente: <span className="font-medium text-foreground">{semanaAtual ? semanaAtual.rotulo : "—"}</span>
            </div>
          </div>
          <div className="pt-[21px]">
            {escopoRestrito ? (
              <div className="px-3 py-2 border rounded-md text-sm bg-muted/40 text-muted-foreground whitespace-nowrap">
                Carteira: <span className="font-medium text-foreground">{data?.escopo?.vendedor || "minha carteira"}</span>
              </div>
            ) : (
              <MultiSelect label="Vendedor" options={opcoesVend} selected={vendedores} onChange={setVendedores} testId="select-vendedor-agenda" />
            )}
          </div>
          <div className="ml-auto">
            <Button variant="outline" onClick={exportar} data-testid="button-export-agenda">
              <Download className="h-4 w-4 mr-2" />Exportar Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-16">Montando a agenda do mês…</div>
      ) : error ? (
        <div className="text-center text-destructive py-16">Não deu para carregar a agenda da carteira.</div>
      ) : (
        <>
          {/* ── TABELA DINÂMICA ────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarDays className="h-5 w-5 text-blue-600" />
                    Atendimentos por dia da semana
                  </CardTitle>
                  <CardDescription>
                    {SEMANAS_ATRAS} semanas passadas, a vigente e {SEMANAS_FRENTE} à frente · clique em um número para ver quem está por trás dele
                  </CardDescription>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="text-muted-foreground hover:text-foreground" data-testid="info-agenda">
                      <Info className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-96 text-sm space-y-2">
                    <p className="font-semibold">Como o quadro é montado</p>
                    <p>
                      <b>Janela deslizante</b>: as {SEMANAS_ATRAS} semanas passadas, a vigente e as {SEMANAS_FRENTE}{" "}
                      próximas. Não acompanha o mês — anda junto com a semana de hoje. Cada semana vai de segunda a
                      sexta, ancorada na segunda-feira.
                    </p>
                    <p>
                      <b>Até hoje</b> o quadro mostra a agenda <i>real</i>: o que de fato esteve marcado no dia (colunas
                      em tom apagado). <b>De amanhã em diante</b> é projeção do cadastro — por isso mudar periodicidade
                      ou dia de atendimento muda o número na hora.
                    </p>
                    <p>
                      <b>Âncora</b> da projeção é a última visita <i>concluída</i> do cliente, o mesmo raciocínio da
                      montagem da Rota do Dia. A cadência (semanal, quinzenal, mensal) é contada a partir dela. Quem
                      nunca teve visita concluída entra pela primeira data válida da janela.
                    </p>
                    <p>
                      <b>Leads são sempre presenciais</b> e entram pela data de próximo contato. Cliente marcado como
                      atendimento virtual no cadastro conta em VIRTUAL; o resto, em PRESENCIAL.
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Quem atende em mais de um dia da semana aparece em todos eles na semana visitada. O número conta
                      atendimentos, não clientes distintos.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto border rounded-md" ref={rolagem}>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-muted/60 z-10">Dia</th>
                      {semanas.map((s) => (
                        <th
                          key={s.i}
                          colSpan={2}
                          data-semana-atual={s.atual ? "1" : undefined}
                          className={`px-2 py-2 text-center font-semibold border-l whitespace-nowrap ${
                            s.atual ? "bg-blue-100 text-blue-900" : s.passada ? "text-muted-foreground" : ""
                          }`}
                        >
                          {rotuloSemana(s)}
                          <span className={`block text-[11px] font-normal ${s.atual ? "text-blue-800" : "text-muted-foreground"}`}>{s.rotulo}</span>
                        </th>
                      ))}
                    </tr>
                    <tr className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-1 sticky left-0 bg-muted/40 z-10"></th>
                      {semanas.map((s) => (
                        <Fragment key={s.i}>
                          <th className={`px-2 py-1 text-center border-l ${s.atual ? "bg-blue-50" : ""}`}>Presencial</th>
                          <th className={`px-2 py-1 text-center ${s.atual ? "bg-blue-50" : ""}`}>Virtual</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DIAS.map((dia) => (
                      <tr key={dia.n} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium sticky left-0 bg-card z-10">
                          {dia.curto} <span className="text-muted-foreground text-xs">{dia.longo}</span>
                        </td>
                        {semanas.map((s) =>
                          (["presencial", "virtual"] as const).map((canal) => {
                            const v = conta(s.i, dia.n, canal);
                            const ativa = celula && celula.s === s.i && celula.d === dia.n && celula.c === canal;
                            return (
                              <td
                                key={`${s.i}-${canal}`}
                                className={`px-2 py-2 text-center ${canal === "presencial" ? "border-l" : ""} ${s.atual ? "bg-blue-50/60" : ""}`}
                              >
                                <button
                                  type="button"
                                  data-testid={`celula-${s.i}-${dia.n}-${canal}`}
                                  onClick={() => setCelula(ativa ? null : { s: s.i, d: dia.n, c: canal })}
                                  disabled={v === 0}
                                  title={s.passada ? "Semana passada — agenda real" : "Projeção do cadastro"}
                                  className={`min-w-[2.25rem] px-2 py-0.5 rounded transition ${
                                    v === 0
                                      ? "text-muted-foreground/40 cursor-default"
                                      : ativa
                                      ? "bg-blue-600 text-white font-semibold"
                                      : s.passada
                                      ? "text-muted-foreground hover:bg-muted font-normal"
                                      : "hover:bg-blue-100 font-medium"
                                  }`}
                                >
                                  {v || "—"}
                                </button>
                              </td>
                            );
                          }),
                        )}
                      </tr>
                    ))}
                    <tr className="border-t-2 bg-muted/50 font-semibold">
                      <td className="px-3 py-2 sticky left-0 bg-muted/50 z-10">Total</td>
                      {semanas.map((s) => (
                        <Fragment key={s.i}>
                          <td className="px-2 py-2 text-center border-l">{totalSemana(s.i, "presencial") || "—"}</td>
                          <td className="px-2 py-2 text-center">{totalSemana(s.i, "virtual") || "—"}</td>
                        </Fragment>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── RELAÇÃO DE CLIENTES ────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Clientes da agenda</CardTitle>
                  <CardDescription>
                    {celula ? <>Filtrado por <span className="font-medium text-foreground">{rotuloCelula}</span></> : "Todos os atendimentos da janela — 8 semanas atrás até 8 à frente"}
                    {" · "}clique no nome para alterar periodicidade, dia e cidade
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {celula || temFiltroColuna || busca ? (
                    <Button size="sm" variant="ghost" onClick={limparTudo} data-testid="button-limpar-celula">
                      Limpar filtros
                    </Button>
                  ) : null}
                  <div className="relative">
                    <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={busca}
                      onChange={(e) => setBusca(e.target.value)}
                      placeholder="Buscar cliente ou cidade…"
                      className="pl-8 w-[240px]"
                      data-testid="input-busca-agenda"
                    />
                  </div>
                </div>
              </div>

              {/* Filtros das colunas da relação — mesmos rótulos que aparecem na
                  tabela, para ninguém ter que traduzir "Seg" de cabeça. */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <MultiSelect label="Tipo" options={opTipo} selected={fTipo} onChange={setFTipo} testId="filtro-tipo" />
                <MultiSelect label="Atendimento" options={opCanal} selected={fCanal} onChange={setFCanal} testId="filtro-atendimento" />
                <MultiSelect label="Periodicidade" options={opPeriodo} selected={fPeriodo} onChange={setFPeriodo} testId="filtro-periodicidade" />
                <MultiSelect label="Dia de atendimento" options={opDia} selected={fDia} onChange={setFDia} testId="filtro-dia" />
                <MultiSelect label="Cidade" options={opCidade} selected={fCidade} onChange={setFCidade} testId="filtro-cidade" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-md [&>div]:max-h-[60vh] [&>div]:overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-20 bg-card shadow-[inset_0_-1px_0_hsl(var(--border))]">
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      {th("nome", "Cliente")}
                      {th("tipo", "Tipo", "w-20")}
                      {th("canal", "Atendimento", "w-28")}
                      {th("periodicidade", "Periodicidade", "w-28")}
                      {th("dias", "Dia de atendimento", "w-40")}
                      {th("cidade", "Cidade")}
                      {th("vendedor", "Vendedor")}
                      {th("pedido", "Pedido na última visita?", "text-right w-40")}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {listaOrdenada.map((i, idx) => (
                      <TableRow key={`${i.tipo}-${i.id}`} data-testid={`row-agenda-${idx}`}>
                        <TableCell className="text-muted-foreground text-xs">{idx + 1}</TableCell>
                        <TableCell className="font-medium">
                          <EditorCliente
                            item={i}
                            aberto={editando === i.id}
                            onAbrir={(v) => setEditando(v ? i.id : "")}
                            podeEditarVisita={podeEditarVisita}
                            onSalvo={() => { setEditando(""); qc.invalidateQueries({ queryKey: ["/api/carteira/agenda"] }); }}
                          />
                        </TableCell>
                        <TableCell className="text-xs">
                          {i.tipo === "lead" ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">Lead</span> : "Cliente"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {i.canal === "virtual"
                            ? <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-900">Virtual</span>
                            : <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-900">Presencial</span>}
                        </TableCell>
                        <TableCell className="text-sm capitalize">{i.periodicidade}</TableCell>
                        <TableCell className="text-sm">{i.dias.map((d) => COD_LONGO[d] || d).join(", ") || "—"}</TableCell>
                        <TableCell className="text-sm">{cidadePadrao(i.cidade) || "—"}</TableCell>
                        <TableCell className="text-sm">{i.vendedor}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <span className={`text-sm font-semibold ${Number(i.pedidoUltimaVisita || 0) > 0 ? "text-emerald-700" : "text-muted-foreground"}`}>
                            {BRL(i.pedidoUltimaVisita || 0)}
                          </span>
                          {i.dataUltimoPedido ? (
                            <span className="block text-[11px] text-muted-foreground">{dataBR(i.dataUltimoPedido)}</span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                    {listaOrdenada.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          Nenhum atendimento nesse recorte.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {NUM(listaOrdenada.length)} de {NUM(base.length)} {base.length === 1 ? "cliente" : "clientes"} na relação
                {celula ? ` · ${rotuloCelula}` : ""}
                {temFiltroColuna
                  ? ` · ${[
                      fTipo.length ? `tipo: ${fTipo.join(", ")}` : "",
                      fCanal.length ? `atendimento: ${fCanal.join(", ")}` : "",
                      fPeriodo.length ? `periodicidade: ${fPeriodo.join(", ")}` : "",
                      fDia.length ? `dia: ${fDia.join(", ")}` : "",
                      fCidade.length ? `cidade: ${fCidade.join(", ")}` : "",
                    ].filter(Boolean).join(" · ")}`
                  : ""}.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Nome do cliente que abre a edição de periodicidade, dia da semana e cidade.
 * Grava no cadastro e reescreve a agenda pendente — é dela que sai a Rota do Dia.
 */
function EditorCliente(props: {
  item: Item;
  aberto: boolean;
  onAbrir: (v: boolean) => void;
  podeEditarVisita: boolean;
  onSalvo: () => void;
}) {
  const { item, aberto, podeEditarVisita } = props;
  const ehLead = item.tipo === "lead";
  const [per, setPer] = useState(item.periodicidade);
  const [dias, setDias] = useState<string[]>(item.dias);
  const [cidade, setCidade] = useState(item.cidade || "");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  // Reabrir num cliente diferente sempre parte do valor atual dele.
  useEffect(() => {
    if (aberto) { setPer(item.periodicidade); setDias(item.dias); setCidade(item.cidade || ""); setErro(""); }
  }, [aberto, item.id]);

  const travado = !podeEditarVisita && (item.dias.length > 0 || !!item.periodicidade);

  const alterna = (cod: string) => {
    setDias((atual) => (atual.includes(cod) ? atual.filter((x) => x !== cod) : [...atual, cod]));
  };

  const salvar = async () => {
    if (salvando) return;
    if (!ehLead && dias.length === 0) { setErro("Escolha pelo menos um dia de atendimento."); return; }
    setSalvando(true); setErro("");
    try {
      const r = await fetch(`/api/carteira/agenda/cliente/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          ehLead ? { tipo: "lead", dias, cidade } : { tipo: "cliente", periodicidade: per, dias, cidade },
        ),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || "Não deu para salvar.");
      props.onSalvo();
    } catch (e: any) {
      setErro(e?.message || "Não deu para salvar.");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Popover open={aberto} onOpenChange={props.onAbrir}>
      <PopoverTrigger asChild>
        <button type="button" className="text-left hover:underline decoration-dotted" data-testid={`btn-editar-${item.id}`}>
          {item.nome}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-semibold leading-tight">{item.nome}</p>
          <p className="text-xs text-muted-foreground">
            {ehLead ? "Lead — atendimento sempre presencial" : item.canal === "virtual" ? "Atendimento virtual" : "Atendimento presencial"}
          </p>
        </div>

        {!ehLead ? (
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Periodicidade</label>
            <Select value={per} onValueChange={setPer} disabled={travado}>
              <SelectTrigger className="h-8 text-sm" data-testid={`sel-per-${item.id}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIODICIDADES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            {ehLead ? "Dia do retorno" : "Dia(s) de atendimento"}
          </label>
          <div className="flex flex-wrap gap-1">
            {DIAS.map((d) => (
              <button
                key={d.cod}
                type="button"
                disabled={travado}
                data-testid={`dia-${item.id}-${d.cod}`}
                onClick={() => (ehLead ? setDias([d.cod]) : alterna(d.cod))}
                className={`px-2 py-1 rounded border text-xs transition ${
                  dias.includes(d.cod) ? "bg-blue-600 text-white border-blue-600 font-semibold" : "bg-muted/40 hover:bg-muted"
                } ${travado ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {d.curto}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">Cidade</label>
          <Input value={cidade} onChange={(e) => setCidade(e.target.value)} className="h-8 text-sm" data-testid={`inp-cidade-${item.id}`} />
        </div>

        {travado ? (
          <p className="text-xs text-amber-700">
            Alterar dia e periodicidade de quem já tem esses campos preenchidos é restrito ao Admin. A cidade você pode ajustar.
          </p>
        ) : null}
        {erro ? <p className="text-xs text-destructive">{erro}</p> : null}

        <div className="flex items-center gap-2">
          <Button size="sm" className="h-7 text-xs" disabled={salvando} onClick={salvar} data-testid={`btn-salvar-${item.id}`}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => props.onAbrir(false)}>Cancelar</Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Salvar grava no cadastro e reprograma as próximas visitas — reflete na Rota do Dia.
        </p>
      </PopoverContent>
    </Popover>
  );
}
