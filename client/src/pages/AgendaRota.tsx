// client/src/pages/AgendaRota.tsx
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba "Agenda de Rota".
//
// A pergunta que a tela responde (Flavio, 04/10/2026): QUANTOS ATENDIMENTOS o
// vendedor tem em cada semana do mes e no mes inteiro — abertos por dia da
// semana e por periodicidade, separando presencial de virtual.
//
// Um quadro por semana, no desenho que ele fez:
//
//              SEGUNDA                 TERCA            ...
//        Sem | Qui | Men | Rep | Lea | Sem | ...
//   PRESENCIAL
//   VIRTUAL
//   TOTAL
//
// Sem/Qui/Men sao as periodicidades do cadastro. Rep (repescagem) e Lea (leads)
// nao tem periodicidade — entram pelo dia em que caem.
//
// A REGUA E A DA ROTA DO DIA: a conta sai da agenda de visitas (visit_agenda),
// com os mesmos filtros de cliente ativo que a Rota do Dia aplica. Ver
// server/agenda-rota-routes.ts para o detalhe de cada filtro.
// -----------------------------------------------------------------------------
import { Fragment, useMemo, useState } from "react";
import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CalendarDays, Info, Users } from "lucide-react";

type Semana = { n: number; ini: string; fim: string; rotulo: string; ultima: boolean; atual: boolean };
type Celula = {
  semana: number; dia: string; canal: string;
  semanal: number; quinzenal: number; mensal: number; repescagem: number; leads: number;
};
type Resposta = {
  mes: string;
  hoje: string;
  semanas: Semana[];
  vendedor: { id: string; nome: string; ativos: number; ativosVirtuais: number } | null;
  celulas: Celula[];
  vendedores: Array<{ id: string; nome: string; ativos: number }>;
  escopo: { restrito: boolean; papel: string };
  fonte: string;
};

const DIAS = [
  { k: "seg", curto: "Segunda" },
  { k: "ter", curto: "Terça" },
  { k: "qua", curto: "Quarta" },
  { k: "qui", curto: "Quinta" },
  { k: "sex", curto: "Sexta" },
] as const;

/** As 5 medidas de cada dia. Cabecalho curto porque sao 25 colunas por quadro. */
const TIPOS = [
  { k: "semanal", curto: "Sem", longo: "Semanal" },
  { k: "quinzenal", curto: "Qui", longo: "Quinzenal" },
  { k: "mensal", curto: "Men", longo: "Mensal" },
  { k: "repescagem", curto: "Rep", longo: "Repescagem" },
  { k: "leads", curto: "Lea", longo: "Leads" },
] as const;

const NUM = (n: number) => (n ? new Intl.NumberFormat("pt-BR").format(n) : "");
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const labelMes = (m: string) => {
  const [a, x] = String(m || "").split("-");
  return `${MESES[Number(x) - 1] || x}/${String(a).slice(2)}`;
};
const dataBR = (s: string) => (s ? s.slice(8, 10) + "/" + s.slice(5, 7) : "");

export default function AgendaRota() {
  const mesHoje = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const [mes, setMes] = useState(mesHoje);
  const [vendedorSel, setVendedorSel] = useState("");

  const { data, isLoading, error } = useQuery<Resposta>({
    queryKey: ["/api/carteira/agenda-rota", vendedorSel, mes],
    queryFn: async () => {
      const p = new URLSearchParams({ mes });
      if (vendedorSel) p.append("sellerId", vendedorSel);
      const r = await fetch(`/api/carteira/agenda-rota?${p.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error("Falha ao carregar a agenda de rota.");
      return r.json();
    },
  });

  const vendedores: Resposta["vendedores"] = data?.vendedores || [];
  const semanas: Semana[] = data?.semanas || [];
  const restrito = data?.escopo?.restrito === true;

  // celulas[semana][dia][canal] -> contagens. A tela desenha zero onde nao veio nada.
  const porCelula = useMemo(() => {
    const m = new Map<string, Celula>();
    for (const c of data?.celulas || []) m.set(`${c.semana}|${c.dia}|${c.canal}`, c);
    return m;
  }, [data]);

  /** Uma medida, de uma semana (0 = o mes inteiro), somando os canais pedidos. */
  const valor = (semana: number, dia: string, canal: "presencial" | "virtual" | "ambos", tipo: string): number => {
    const canais = canal === "ambos" ? ["presencial", "virtual"] : [canal];
    const sems = semana === 0 ? semanas.map((s) => s.n) : [semana];
    let n = 0;
    for (const s of sems) for (const c of canais) {
      const cel = porCelula.get(`${s}|${dia}|${c}`);
      if (cel) n += Number((cel as any)[tipo]) || 0;
    }
    return n;
  };
  /** Total de um dia (as 5 medidas) num canal. */
  const totalDia = (semana: number, dia: string, canal: "presencial" | "virtual" | "ambos") =>
    TIPOS.reduce((s, t) => s + valor(semana, dia, canal, t.k), 0);
  /** Total de uma semana inteira (0 = o mes). */
  const totalSemana = (semana: number, canal: "presencial" | "virtual" | "ambos") =>
    DIAS.reduce((s, d) => s + totalDia(semana, d.k, canal), 0);

  const totalMes = totalSemana(0, "ambos");

  // ── um quadro (uma semana, ou o mes inteiro quando semana = 0) ─────────────
  const Quadro = ({ semana, titulo, nota, destaque }: { semana: number; titulo: string; nota: string; destaque?: boolean }) => (
    <div className={`rounded-md border ${destaque ? "border-blue-300 bg-blue-50/30" : ""}`}>
      <div className="flex items-baseline justify-between gap-3 px-3 py-2 border-b">
        <div className="min-w-0">
          <span className={`text-sm font-semibold ${destaque ? "text-blue-800" : ""}`}>{titulo}</span>
          <span className="text-xs text-muted-foreground ml-2">{nota}</span>
        </div>
        <span className="text-sm whitespace-nowrap">
          <span className="text-muted-foreground text-xs mr-1">atendimentos</span>
          <b className={destaque ? "text-blue-800" : ""}>{NUM(totalSemana(semana, "ambos")) || "0"}</b>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full w-max text-sm border-collapse" data-testid={`quadro-semana-${semana}`}>
          <thead>
            <tr className="bg-muted/40">
              <th className="text-left font-medium px-2 py-1 sticky left-0 bg-muted/40 z-10 w-24">&nbsp;</th>
              {DIAS.map((d) => (
                <th key={d.k} colSpan={TIPOS.length + 1} className="px-1 py-1 text-center font-semibold border-l">
                  {d.curto}
                </th>
              ))}
              <th className="px-2 py-1 text-center font-semibold border-l bg-muted/60">Total</th>
            </tr>
            <tr className="bg-muted/20 text-[11px] text-muted-foreground">
              <th className="sticky left-0 bg-muted/20 z-10" />
              {DIAS.map((d) => (
                <Fragment key={d.k}>
                  {TIPOS.map((t, i) => (
                    <th key={`${d.k}-${t.k}`} className={`px-1 py-1 font-normal text-center w-10 ${i === 0 ? "border-l" : ""}`} title={t.longo}>
                      {t.curto}
                    </th>
                  ))}
                  <th key={`${d.k}-tot`} className="px-1 py-1 font-medium text-center w-10 bg-muted/30">Tot</th>
                </Fragment>
              ))}
              <th className="border-l bg-muted/60" />
            </tr>
          </thead>
          <tbody>
            {(["presencial", "virtual"] as const).map((canal) => (
              <tr key={canal} className="border-t">
                <td className="px-2 py-1 font-medium capitalize sticky left-0 bg-card z-10">{canal}</td>
                {DIAS.map((d) => (
                  <Fragment key={d.k}>
                    {TIPOS.map((t, i) => {
                      const v = valor(semana, d.k, canal, t.k);
                      return (
                        <td key={`${d.k}-${t.k}`}
                          className={`px-1 py-1 text-center tabular-nums ${i === 0 ? "border-l" : ""} ${v ? "" : "text-muted-foreground/40"}`}>
                          {NUM(v) || "–"}
                        </td>
                      );
                    })}
                    <td key={`${d.k}-tot`} className="px-1 py-1 text-center tabular-nums font-medium bg-muted/20">
                      {NUM(totalDia(semana, d.k, canal)) || "–"}
                    </td>
                  </Fragment>
                ))}
                <td className="px-2 py-1 text-center tabular-nums font-semibold border-l bg-muted/60">
                  {NUM(totalSemana(semana, canal)) || "–"}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 font-semibold">
              <td className="px-2 py-1 sticky left-0 bg-card z-10">Total</td>
              {DIAS.map((d) => (
                <Fragment key={d.k}>
                  {TIPOS.map((t, i) => (
                    <td key={`${d.k}-${t.k}`} className={`px-1 py-1 text-center tabular-nums ${i === 0 ? "border-l" : ""}`}>
                      {NUM(valor(semana, d.k, "ambos", t.k)) || "–"}
                    </td>
                  ))}
                  <td key={`${d.k}-tot`} className="px-1 py-1 text-center tabular-nums bg-muted/30">
                    {NUM(totalDia(semana, d.k, "ambos")) || "–"}
                  </td>
                </Fragment>
              ))}
              <td className="px-2 py-1 text-center tabular-nums border-l bg-muted/60">
                {NUM(totalSemana(semana, "ambos")) || "–"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Filtros — vendedor e mês */}
      <Card>
        <CardContent className="py-3 px-4 flex flex-wrap items-end gap-3">
          {!restrito ? (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Vendedor</label>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm min-w-[260px]"
                value={vendedorSel}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVendedorSel(e.target.value)}
                data-testid="select-vendedor-agenda-rota"
              >
                <option value="">Escolha um vendedor…</option>
                {vendedores.map((v) => (
                  <option key={v.id} value={v.id}>{v.nome} ({NUM(v.ativos) || 0} ativos)</option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Mês</label>
            <input
              type="month"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={mes}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMes(e.target.value || mesHoje)}
              data-testid="input-mes-agenda-rota"
            />
          </div>
          {data?.vendedor ? (
            <div className="ml-auto flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold">{data.vendedor.nome}</span>
              <span className="text-muted-foreground">
                · {NUM(data.vendedor.ativos) || 0} clientes ativos
                {data.vendedor.ativosVirtuais ? ` (${NUM(data.vendedor.ativosVirtuais)} virtuais)` : ""}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-amber-600" />
                Agenda de Rota — {labelMes(mes)}
              </CardTitle>
              <CardDescription>
                Quantos atendimentos o vendedor tem em cada semana e no mês, por dia da rota.
                {data?.vendedor ? ` · ${NUM(totalMes) || 0} atendimentos no mês` : ""}
              </CardDescription>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground"
                  aria-label="Como cada número é montado" data-testid="button-info-agenda-rota">
                  <Info className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[460px] max-w-[92vw] text-sm space-y-3">
                <p className="font-semibold">De onde vem cada número</p>
                <p className="text-muted-foreground">
                  A régua é a da <b>Rota do Dia</b>: a conta sai da agenda de visitas, com os mesmos
                  filtros que a rota aplica — cliente <b>ativo</b>, do vendedor, que não seja
                  fornecedor nem lead, já dentro da data de início do fornecimento, e com a visita
                  não cancelada no dia.
                </p>
                <ul className="text-muted-foreground list-disc pl-4 space-y-1">
                  <li><b>Sem / Qui / Men</b> — a periodicidade do cadastro do cliente (semanal, quinzenal, mensal).</li>
                  <li><b>Rep</b> — repescagem. É sorteada <b>dia a dia</b>, então só existe nos dias que já passaram; nas semanas à frente a coluna fica vazia. Repescagem de telemarketing conta como virtual.</li>
                  <li><b>Lea</b> — leads, pela data do próximo contato. Lead é sempre presencial.</li>
                  <li><b>Presencial / Virtual</b> — pelo atendimento virtual marcado no cadastro do cliente.</li>
                </ul>
                <p className="text-muted-foreground">
                  A <b>semana é contada pela segunda-feira</b>: ela pertence ao mês da segunda dela. Por
                  isso a última semana pode terminar já no mês seguinte, e os primeiros dias de um mês
                  podem pertencer à última semana do mês anterior. É o que faz a soma das semanas fechar
                  exatamente com o total do mês.
                </p>
                <p className="text-muted-foreground">
                  Fica de fora só o filtro “já comprou no ciclo”, que é uma decisão do dia na Rota do
                  Dia — aqui ele encolheria o passado a cada vez que a tela fosse aberta.
                </p>
              </PopoverContent>
            </Popover>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-16">Carregando a agenda…</div>
          ) : error ? (
            <div className="text-center text-destructive py-16">Não deu para carregar a agenda de rota.</div>
          ) : !data?.vendedor ? (
            <div className="text-center text-muted-foreground py-16">
              Escolha um vendedor para ver o quadro.
            </div>
          ) : (
            <>
              {/* Resumo: a semana e o mês de uma olhada só */}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {semanas.map((s) => (
                  <span key={s.n}
                    className={`px-2.5 py-1 rounded-md border ${s.atual ? "border-blue-400 bg-blue-50 font-semibold" : "bg-muted/40 border-transparent"}`}
                    data-testid={`resumo-semana-${s.n}`}>
                    {s.rotulo} <span className="text-muted-foreground text-xs">({dataBR(s.ini)}–{dataBR(s.fim)})</span>{" "}
                    <b>{NUM(totalSemana(s.n, "ambos")) || 0}</b>
                  </span>
                ))}
                <span className="px-2.5 py-1 rounded-md bg-foreground text-background font-semibold" data-testid="resumo-mes">
                  Mês {NUM(totalMes) || 0}
                </span>
              </div>

              {semanas.map((s) => (
                <div key={s.n}>
                <Quadro
                  semana={s.n}
                  titulo={s.rotulo}
                  nota={`${dataBR(s.ini)} a ${dataBR(s.fim)}${s.atual ? " · semana vigente" : ""}${s.ultima ? " · última do mês" : ""}`}
                />
                </div>
              ))}

              <Quadro semana={0} titulo={`Mês de ${labelMes(mes)}`} nota="soma das semanas acima" destaque />

              <div className="text-xs text-muted-foreground space-y-1">
                <p>Sem = semanal · Qui = quinzenal · Men = mensal · Rep = repescagem · Lea = leads.</p>
                <p>
                  <b>As últimas semanas do mês costumam aparecer mais vazias.</b> O sistema grava na
                  agenda só as próximas visitas de cada cliente (4 por vez), então a parte do mês que
                  ainda está longe pode não ter sido gerada — não é que o vendedor esteja livre, é que
                  a agenda ainda não chegou lá. Repescagem reforça isso: é sorteada no dia, então nas
                  semanas à frente a coluna fica sempre vazia.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
