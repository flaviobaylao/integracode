// client/src/pages/AgendaCarteira.tsx
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba "Agenda da carteira".
//
// Tabela dinamica de nº de atendimentos por dia da semana, uma coluna por semana
// do mes, separando PRESENCIAL de VIRTUAL. Abaixo, a relacao de clientes que
// sustenta cada numero — clicar em qualquer numero filtra a relacao.
//
// A semana e' de segunda a sexta e pertence ao mes da SEGUNDA dela (o servidor
// monta as semanas; aqui so' se pinta). A cadencia vem projetada do cadastro,
// ancorada na ultima visita concluida, entao mudar periodicidade ou dia de
// atendimento muda o quadro na hora.
// -----------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useState } from "react";
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
  datas: string[];
};
type Semana = { i: number; ini: string; fim: string; rotulo: string };

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
const MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (m: string) => {
  const [a, b] = String(m || "").split("-");
  return b ? `${MES_ABREV[Number(b) - 1]}/${a}` : m;
};
/** 'YYYY-MM-DD' -> dia da semana 1..5 (0 = fim de semana / invalido). */
const diaDaData = (s: string) => {
  const [a, m, d] = String(s || "").split("-").map(Number);
  if (!a || !m || !d) return 0;
  const w = new Date(a, m - 1, d).getDay();
  return w >= 1 && w <= 5 ? w : 0;
};
const dataBR = (s: any) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : "—";
};

export default function AgendaCarteira() {
  const hoje = new Date();
  const [mes, setMes] = useState(`${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`);
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  // Celula clicada na tabela dinamica: { semana, dia, canal } — filtra a lista.
  const [celula, setCelula] = useState<{ s: number; d: number; c: string } | null>(null);
  const [ordCol, setOrdCol] = useState("nome");
  const [ordDir, setOrdDir] = useState<"asc" | "desc">("asc");
  const [editando, setEditando] = useState<string>("");

  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/carteira/agenda", mes],
    queryFn: async () => {
      const r = await fetch(`/api/carteira/agenda?mes=${mes}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar a agenda da carteira");
      return r.json();
    },
  });

  const semanas: Semana[] = data?.semanas || [];
  const todos: Item[] = data?.itens || [];
  const escopoRestrito = data?.escopo?.restrito === true;
  const podeEditarVisita = data?.podeEditarVisita === true;

  // Opções do filtro de vendedor: quem realmente tem alguém na agenda do mês.
  const opcoesVend = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of todos) if (i.datas.length) c.set(i.vendedor, (c.get(i.vendedor) || 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [todos]);
  // O filtro guarda o nome puro — nunca um rótulo com contagem, que muda com o mês.
  useEffect(() => {
    setVendedores((sel) => sel.filter((v) => opcoesVend.includes(v)));
  }, [opcoesVend]);

  // Base do quadro: só quem tem atendimento projetado no mês, já pelo vendedor filtrado.
  const base = useMemo(() => {
    const sel = new Set(vendedores);
    return todos.filter((i) => i.datas.length > 0 && (sel.size === 0 || sel.has(i.vendedor)));
  }, [todos, vendedores]);

  /** Índice da semana de uma data (1..n); 0 se cair fora das semanas do mês. */
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
  const totalDia = (d: number, c: string) => semanas.reduce((t, s) => t + conta(s.i, d, c), 0);
  const totalGeral = (c: string) => semanas.reduce((t, s) => t + totalSemana(s.i, c), 0);

  // Lista de baixo: obedece a célula clicada e a busca por cliente.
  const lista = useMemo(() => {
    let l = base;
    if (celula) {
      l = l.filter(
        (i) => i.canal === celula.c && i.datas.some((dt) => semanaDaData(dt) === celula.s && diaDaData(dt) === celula.d),
      );
    }
    const alvo = busca.trim().toLocaleLowerCase("pt-BR");
    if (alvo.length >= 2) {
      l = l.filter((i) => i.nome.toLocaleLowerCase("pt-BR").includes(alvo) || (i.cidade || "").toLocaleLowerCase("pt-BR").includes(alvo));
    }
    return l;
  }, [base, celula, busca, semanaDaData]);

  const valorCol = (i: Item, k: string): any => {
    switch (k) {
      case "nome": return i.nome.toLocaleLowerCase("pt-BR");
      case "tipo": return i.tipo;
      case "canal": return i.canal;
      case "periodicidade": return i.periodicidade;
      case "dias": return i.dias.join(",");
      case "cidade": return (i.cidade || "").toLocaleLowerCase("pt-BR");
      case "vendedor": return i.vendedor.toLocaleLowerCase("pt-BR");
      case "ultima": return i.ultimaVisita || "";
      case "n": return i.datas.length;
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
  }, [lista, ordCol, ordDir]);

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

  const opcoesMes = useMemo(() => {
    const out: string[] = [];
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 1);
    for (let i = 0; i < 18; i++) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }, [hoje.getFullYear(), hoje.getMonth()]);

  const exportar = () => {
    const quadro: Record<string, any>[] = [];
    for (const canal of ["presencial", "virtual"]) {
      for (const dia of DIAS) {
        const linha: Record<string, any> = { Canal: canal === "presencial" ? "PRESENCIAL" : "VIRTUAL", Dia: dia.curto };
        for (const s of semanas) linha[`${s.i}ª sem (${s.rotulo})`] = conta(s.i, dia.n, canal);
        linha["Total"] = totalDia(dia.n, canal);
        quadro.push(linha);
      }
    }
    exportToExcel(quadro, `agenda-carteira-${mes}`);
    const clientes = listaOrdenada.map((i) => ({
      Cliente: i.nome,
      Tipo: i.tipo === "lead" ? "Lead" : "Cliente",
      Atendimento: i.canal === "virtual" ? "Virtual" : "Presencial",
      Periodicidade: i.periodicidade,
      "Dia(s) de atendimento": i.dias.map((d) => COD_LONGO[d] || d).join(", "),
      Cidade: i.cidade,
      Vendedor: i.vendedor,
      "Última visita concluída": i.ultimaVisita ? dataBR(i.ultimaVisita) : "",
      "Atendimentos no mês": i.datas.length,
      Datas: i.datas.map(dataBR).join(" · "),
    }));
    exportToExcel(clientes, `agenda-carteira-clientes-${mes}`);
  };

  const rotuloCelula = celula
    ? `${celula.s}ª semana · ${DIAS.find((d) => d.n === celula.d)?.longo} · ${celula.c === "virtual" ? "virtual" : "presencial"}`
    : "";

  return (
    <div className="space-y-6">
      {/* Filtros da aba */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Mês</label>
            <Select value={mes} onValueChange={(v) => { setMes(v); setCelula(null); }}>
              <SelectTrigger className="w-[150px]" data-testid="select-mes-agenda"><SelectValue /></SelectTrigger>
              <SelectContent>{opcoesMes.map((m) => <SelectItem key={m} value={m}>{labelMes(m)}</SelectItem>)}</SelectContent>
            </Select>
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
                    Atendimentos por dia da semana — {labelMes(mes)}
                  </CardTitle>
                  <CardDescription>
                    {semanas.length} semanas · clique em um número para ver quem está por trás dele
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
                      <b>Semana</b> vai de segunda a sexta e pertence ao mês da <b>segunda-feira</b> dela. Se o dia 1º cai
                      no meio da última semana do mês anterior, essa semana ainda é do mês anterior — a 1ª semana do mês
                      novo é a seguinte.
                    </p>
                    <p>
                      <b>Âncora</b> é a última visita <i>concluída</i> do cliente, o mesmo raciocínio da montagem da Rota
                      do Dia. A cadência (semanal, quinzenal, mensal) é contada a partir dela. Quem nunca teve visita
                      concluída entra pela primeira data válida do mês.
                    </p>
                    <p>
                      <b>Leads são sempre presenciais</b> e entram pela data de próximo contato. Cliente marcado como
                      atendimento virtual no cadastro conta em VIRTUAL; o resto, em PRESENCIAL.
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Quem atende em mais de um dia da semana aparece em todos eles na semana visitada.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto border rounded-md">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-muted/60 z-10">Dia</th>
                      {semanas.map((s) => (
                        <th key={s.i} colSpan={2} className="px-2 py-2 text-center font-semibold border-l">
                          {s.i}ª semana
                          <span className="block text-[11px] font-normal text-muted-foreground">{s.rotulo}</span>
                        </th>
                      ))}
                      <th colSpan={2} className="px-2 py-2 text-center font-semibold border-l bg-muted">Total</th>
                    </tr>
                    <tr className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-1 sticky left-0 bg-muted/40 z-10"></th>
                      {semanas.map((s) => (
                        <Fragment key={s.i}>
                          <th className="px-2 py-1 text-center border-l">Presencial</th>
                          <th className="px-2 py-1 text-center">Virtual</th>
                        </Fragment>
                      ))}
                      <th className="px-2 py-1 text-center border-l bg-muted">Presencial</th>
                      <th className="px-2 py-1 text-center bg-muted">Virtual</th>
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
                              <td key={`${s.i}-${canal}`} className={`px-2 py-2 text-center ${canal === "presencial" ? "border-l" : ""}`}>
                                <button
                                  type="button"
                                  data-testid={`celula-${s.i}-${dia.n}-${canal}`}
                                  onClick={() => setCelula(ativa ? null : { s: s.i, d: dia.n, c: canal })}
                                  disabled={v === 0}
                                  className={`min-w-[2.25rem] px-2 py-0.5 rounded transition ${
                                    v === 0
                                      ? "text-muted-foreground/40 cursor-default"
                                      : ativa
                                      ? "bg-blue-600 text-white font-semibold"
                                      : "hover:bg-blue-100 font-medium"
                                  }`}
                                >
                                  {v || "—"}
                                </button>
                              </td>
                            );
                          }),
                        )}
                        <td className="px-2 py-2 text-center border-l bg-muted/40 font-semibold">{totalDia(dia.n, "presencial") || "—"}</td>
                        <td className="px-2 py-2 text-center bg-muted/40 font-semibold">{totalDia(dia.n, "virtual") || "—"}</td>
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
                      <td className="px-2 py-2 text-center border-l bg-muted">{totalGeral("presencial") || "—"}</td>
                      <td className="px-2 py-2 text-center bg-muted">{totalGeral("virtual") || "—"}</td>
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
                    {celula ? <>Filtrado por <span className="font-medium text-foreground">{rotuloCelula}</span></> : "Todos os atendimentos projetados no mês"}
                    {" · "}clique no nome para alterar periodicidade, dia e cidade
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {celula ? (
                    <Button size="sm" variant="ghost" onClick={() => setCelula(null)} data-testid="button-limpar-celula">
                      Limpar filtro
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
                      {th("ultima", "Última visita", "w-28")}
                      {th("n", "Atend. no mês", "text-right w-24")}
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
                        <TableCell className="text-sm">{i.cidade || "—"}</TableCell>
                        <TableCell className="text-sm">{i.vendedor}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{i.ultimaVisita ? dataBR(i.ultimaVisita) : "—"}</TableCell>
                        <TableCell className="text-right font-semibold">{i.datas.length}</TableCell>
                      </TableRow>
                    ))}
                    {listaOrdenada.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                          Nenhum atendimento nesse recorte.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {NUM(listaOrdenada.length)} {listaOrdenada.length === 1 ? "cliente" : "clientes"} na relação
                {celula ? ` · ${rotuloCelula}` : ""}.
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
