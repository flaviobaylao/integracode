// client/src/components/AtendimentoDigital.tsx
// -----------------------------------------------------------------------------
// GESTAO — ATENDIMENTO DIGITAL (bloco do /painel-atendimento)
//
// A outra metade do painel: o painel de campo conta o que o VENDEDOR fez na rua;
// este conta tudo que a Honest trocou com cliente por tela — WhatsApp oficial,
// WhatsApp dos outros numeros, Instagram Direct, disparos de template, IA,
// anuncio e os avisos de entrega.
//
// Fonte unica: GET /api/gestao/atendimento-digital?dia=YYYY-MM-DD&dias=1|7|30
// (server/painel-atendimento-digital.ts — as reguas estao documentadas la).
//
// O periodo e proprio: o painel de campo e sempre de UM dia (a rua acontece no
// dia), mas conversa e disparo so fazem sentido em janela — por isso o seletor
// Hoje / 7 / 30 dias aqui dentro, ancorado no mesmo dia escolhido em cima.
// -----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MessageSquare, Send, Bot, User, Clock, Wallet, Instagram, Megaphone, Truck,
  Inbox, AlertTriangle, Loader2,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

type PorCanal = { canal: string; rotulo: string; recebidas: number; enviadas: number; ia: number; humano: number; sistema: number; conversas: number };
type Template = { template: string; categoria: string; uso: string; enviados: number; responderam: number; falhas: number; fila: number; custo: number };

type Digital = {
  de: string; ate: string; dias: number; geradoEm: string;
  mensagens: {
    recebidas: number; enviadas: number; ia: number; humano: number; sistema: number; total: number;
    conversas: number; conversasNovas: number; clientes: number;
    respostas: number; respostasIa: number; pctIa: number;
    tempoRespostaMin: number | null; tempoRespostaIaMin: number | null; tempoRespostaHumanoMin: number | null;
  };
  porCanal: PorCanal[];
  janela24h: { abertas: number; conversasOficiais: number };
  disparos: { enviados: number; fila: number; falhas: number; responderam: number; custo: number; porTemplate: Template[]; porUso: { uso: string; enviados: number; custo: number }[] };
  ia: { execucoes: number; erros: number; custo: number; duracaoMediaMs: number; porAgente: { agente: string; execucoes: number; custo: number; erros: number }[] };
  instagram: { posts: number; publicados: number; alcance: number; impressoes: number; curtidas: number; comentarios: number; salvos: number; compartilhamentos: number; cliquesLink: number; novosSeguidores: number; direct: PorCanal | null };
  ads: { anuncios: number; gasto: number; impressoes: number; cliques: number; conversas: number; alcance: number; custoPorConversa: number | null };
  entregas: { saiu: number; entregue: number; devolvida: number; pos_entrega: number; agendados: number };
  reguas: { previsto: number; liberado: number; enfileirado: number; bloqueado: number; erro: number; custo: number };
  serie: { dia: string; recebidas: number; enviadas: number; ia: number; disparos: number }[];
};

const fmtInt = (n: number) => (n || 0).toLocaleString('pt-BR');
const fmtBRL = (n: number) => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtMin = (n: number | null) => (n == null ? '—' : n < 1 ? '< 1 min' : n < 60 ? `${Math.round(n)} min` : `${(n / 60).toFixed(1)} h`);
const fmtDia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Kpi({ icone, rotulo, valor, sub, testid }: { icone: React.ReactNode; rotulo: string; valor: string; sub?: string; testid: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={testid}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <span className="text-teal-600 dark:text-teal-400">{icone}</span>{rotulo}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-50">{valor}</div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
}

/** Caixa de um canal: quanto entrou, quanto saiu e quem respondeu. */
function CardCanal({ c }: { c: PorCanal }) {
  const total = c.recebidas + c.enviadas;
  const pct = (v: number) => (c.enviadas > 0 ? Math.round((v / c.enviadas) * 100) : 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={`card-canal-${c.canal}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-50">{c.rotulo}</span>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{fmtInt(c.conversas)} conversas</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div><div className="text-xs text-gray-500 dark:text-gray-400">Recebidas</div><div className="font-semibold tabular-nums text-gray-900 dark:text-gray-50">{fmtInt(c.recebidas)}</div></div>
        <div><div className="text-xs text-gray-500 dark:text-gray-400">Enviadas</div><div className="font-semibold tabular-nums text-gray-900 dark:text-gray-50">{fmtInt(c.enviadas)}</div></div>
      </div>
      {c.enviadas > 0 && (
        <>
          <div className="mt-3 flex h-2 overflow-hidden rounded-sm" aria-hidden>
            <div className="bg-teal-500" style={{ width: `${pct(c.ia)}%` }} />
            <div className="bg-amber-500" style={{ width: `${pct(c.humano)}%` }} />
            <div className="bg-gray-300 dark:bg-gray-600" style={{ width: `${pct(c.sistema)}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-teal-500 align-middle" />IA {fmtInt(c.ia)}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500 align-middle" />Humano {fmtInt(c.humano)}</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-gray-300 align-middle dark:bg-gray-600" />Sistema {fmtInt(c.sistema)}</span>
          </div>
        </>
      )}
      {total === 0 && <div className="mt-3 text-xs text-gray-400">Sem movimento no período.</div>}
    </div>
  );
}

/** Painel menor, para os blocos de Instagram / anúncios / entregas / réguas. */
function Quadro({ titulo, icone, testid, children, rodape }: { titulo: string; icone: React.ReactNode; testid: string; children: React.ReactNode; rodape?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900" data-testid={testid}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <span className="text-teal-600 dark:text-teal-400">{icone}</span>{titulo}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">{children}</dl>
      {rodape && <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{rodape}</p>}
    </div>
  );
}
function Item({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{rotulo}</dt>
      <dd className={`tabular-nums ${destaque ? 'text-lg font-semibold' : 'text-sm font-medium'} text-gray-900 dark:text-gray-50`}>{valor}</dd>
    </div>
  );
}

export default function AtendimentoDigital({ dia, ehHoje, intervalo, aoVivo }: { dia: string; ehHoje: boolean; intervalo: number; aoVivo: boolean }) {
  const [dias, setDias] = useState<number>(1);
  const url = `/api/gestao/atendimento-digital?dia=${dia}&dias=${dias}`;
  const { data, isLoading, isFetching, error } = useQuery<Digital>({
    queryKey: [url],
    staleTime: 0,
    refetchInterval: aoVivo && ehHoje ? intervalo * 1000 : false,
    refetchIntervalInBackground: false,
  });

  const serie = useMemo(
    () => (data?.serie || []).map(d => ({ ...d, rotulo: fmtDia(d.dia) })),
    [data?.serie],
  );
  const m = data?.mensagens;
  const custoTotal = (data?.disparos.custo || 0) + (data?.ia.custo || 0) + (data?.ads.gasto || 0);

  return (
    <section className="space-y-4" data-testid="secao-atendimento-digital">
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-5 dark:border-gray-700">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Atendimento digital</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Tudo que a Honest trocou com cliente por tela — WhatsApp, Instagram, anúncios e avisos de entrega.
            {isFetching && !isLoading && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {[{ n: 1, r: 'Hoje' }, { n: 7, r: '7 dias' }, { n: 30, r: '30 dias' }].map(o => (
            <button key={o.n} onClick={() => setDias(o.n)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${dias === o.n
                ? 'border-teal-600 bg-teal-600 text-white'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'}`}
              data-testid={`button-digital-${o.n}`}>{o.n === 1 && !ehHoje ? 'No dia' : o.r}</button>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" /> Não foi possível carregar o atendimento digital.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi icone={<Inbox className="h-4 w-4" />} rotulo="Recebidas" testid="kpi-recebidas"
              valor={fmtInt(m!.recebidas)} sub={`${fmtInt(m!.clientes)} clientes · ${fmtInt(m!.conversas)} conversas`} />
            <Kpi icone={<Send className="h-4 w-4" />} rotulo="Enviadas" testid="kpi-enviadas"
              valor={fmtInt(m!.enviadas)} sub={`+ ${fmtInt(data.disparos.enviados)} disparos de template`} />
            <Kpi icone={<Bot className="h-4 w-4" />} rotulo="Respondido pela IA" testid="kpi-pct-ia"
              valor={`${m!.pctIa}%`} sub={`${fmtInt(m!.respostasIa)} de ${fmtInt(m!.respostas)} respostas`} />
            <Kpi icone={<Clock className="h-4 w-4" />} rotulo="Tempo de resposta" testid="kpi-tempo"
              valor={fmtMin(m!.tempoRespostaMin)} sub={`IA ${fmtMin(m!.tempoRespostaIaMin)} · humano ${fmtMin(m!.tempoRespostaHumanoMin)}`} />
            <Kpi icone={<MessageSquare className="h-4 w-4" />} rotulo="Janelas abertas" testid="kpi-janela"
              valor={fmtInt(data.janela24h.abertas)} sub="conversas em que dá para falar de graça" />
            <Kpi icone={<Wallet className="h-4 w-4" />} rotulo="Custo do período" testid="kpi-custo"
              valor={fmtBRL(custoTotal)} sub={`disparos ${fmtBRL(data.disparos.custo)} · IA ${fmtBRL(data.ia.custo)} · ads ${fmtBRL(data.ads.gasto)}`} />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {data.porCanal.map(c => <CardCanal key={c.canal} c={c} />)}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-50">Movimento por dia</h3>
            <div className="mt-3 h-64 w-full" data-testid="chart-digital-serie">
              {serie.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-500">Sem mensagens no período.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={serie} margin={{ top: 12, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
                    <CartesianGrid vertical={false} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeOpacity={0.6} />
                    <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                      interval={serie.length > 20 ? Math.ceil(serie.length / 15) - 1 : 0} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={34} />
                    <Tooltip cursor={{ fill: 'rgba(13,148,136,0.08)' }} contentStyle={{ fontSize: 12, borderRadius: 6 }}
                      formatter={(v: any, name: any) => [fmtInt(Number(v)), name]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="recebidas" name="Recebidas" fill="#0d9488" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="enviadas" name="Enviadas" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                    <Line type="monotone" dataKey="disparos" name="Disparos de template" stroke="#d97706" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Quadro titulo="Instagram" icone={<Instagram className="h-4 w-4" />} testid="quadro-instagram"
              rodape="Alcance e curtidas são a última leitura de cada post no período (o número da Meta é acumulado, somar dias duplicaria).">
              <Item rotulo="Alcance" valor={fmtInt(data.instagram.alcance)} destaque />
              <Item rotulo="Curtidas" valor={fmtInt(data.instagram.curtidas)} destaque />
              <Item rotulo="Comentários" valor={fmtInt(data.instagram.comentarios)} />
              <Item rotulo="Salvos" valor={fmtInt(data.instagram.salvos)} />
              <Item rotulo="Publicados" valor={fmtInt(data.instagram.publicados)} />
              <Item rotulo="Direct recebidas" valor={fmtInt(data.instagram.direct?.recebidas || 0)} />
            </Quadro>

            <Quadro titulo="Anúncios Meta" icone={<Megaphone className="h-4 w-4" />} testid="quadro-ads"
              rodape="Conversa = pessoa que clicou no anúncio e abriu o WhatsApp da Honest.">
              <Item rotulo="Gasto" valor={fmtBRL(data.ads.gasto)} destaque />
              <Item rotulo="Conversas" valor={fmtInt(data.ads.conversas)} destaque />
              <Item rotulo="Cliques" valor={fmtInt(data.ads.cliques)} />
              <Item rotulo="Alcance" valor={fmtInt(data.ads.alcance)} />
              <Item rotulo="Custo por conversa" valor={data.ads.custoPorConversa == null ? '—' : fmtBRL(data.ads.custoPorConversa)} />
              <Item rotulo="Anúncios" valor={fmtInt(data.ads.anuncios)} />
            </Quadro>

            <Quadro titulo="Avisos de entrega" icone={<Truck className="h-4 w-4" />} testid="quadro-entregas"
              rodape="Disparados pelo app do entregador: início da rota, entrega feita, devolução e a conferência de dois dias.">
              <Item rotulo="Saiu para entrega" valor={fmtInt(data.entregas.saiu)} destaque />
              <Item rotulo="Entrega feita" valor={fmtInt(data.entregas.entregue)} destaque />
              <Item rotulo="Devolvida" valor={fmtInt(data.entregas.devolvida)} />
              <Item rotulo="Conferência 2 dias" valor={fmtInt(data.entregas.pos_entrega)} />
              <Item rotulo="Agendados" valor={fmtInt(data.entregas.agendados)} />
            </Quadro>

            <Quadro titulo="Agentes de IA" icone={<Bot className="h-4 w-4" />} testid="quadro-ia"
              rodape={data.ia.porAgente.length ? data.ia.porAgente.slice(0, 4).map(a => `${a.agente} ${fmtInt(a.execucoes)}`).join(' · ') : undefined}>
              <Item rotulo="Execuções" valor={fmtInt(data.ia.execucoes)} destaque />
              <Item rotulo="Custo" valor={fmtBRL(data.ia.custo)} destaque />
              <Item rotulo="Erros" valor={fmtInt(data.ia.erros)} />
              <Item rotulo="Tempo médio" valor={data.ia.duracaoMediaMs ? `${(data.ia.duracaoMediaMs / 1000).toFixed(1)} s` : '—'} />
              <Item rotulo="Réguas na fila" valor={fmtInt(data.reguas.previsto + data.reguas.liberado + data.reguas.enfileirado)} />
              <Item rotulo="Bloqueados" valor={fmtInt(data.reguas.bloqueado)} />
            </Quadro>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-50">Disparos oficiais por modelo</h3>
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                {fmtInt(data.disparos.enviados)} enviados · {fmtInt(data.disparos.responderam)} responderam · {fmtBRL(data.disparos.custo)}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="tabela-disparos">
                <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="px-4 py-2 text-left font-medium">Modelo</th>
                    <th className="px-2 py-2 text-left font-medium">Tipo</th>
                    <th className="px-2 py-2 text-right font-medium">Enviados</th>
                    <th className="px-2 py-2 text-right font-medium">Responderam</th>
                    <th className="px-2 py-2 text-right font-medium">Falhas</th>
                    <th className="px-4 py-2 text-right font-medium">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.disparos.porTemplate.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-500">Nenhum disparo no período.</td></tr>
                  ) : data.disparos.porTemplate.map(t => (
                    <tr key={t.template} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                      <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-50">{t.template}</td>
                      <td className="px-2 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${t.categoria === 'MARKETING'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>{t.categoria === 'MARKETING' ? 'Marketing' : 'Utilidade'}</span>
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{t.uso}</span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtInt(t.enviados)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmtInt(t.responderam)}
                        {t.enviados > 0 && <span className="ml-1 text-xs text-gray-400">{Math.round((t.responderam / t.enviados) * 100)}%</span>}
                      </td>
                      <td className={`px-2 py-2 text-right tabular-nums ${t.falhas > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{fmtInt(t.falhas)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtBRL(t.custo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Recebida = mensagem do cliente. Enviada = mensagem nossa na conversa, separada por quem escreveu (IA, atendente ou aviso do sistema);
            disparo de template é contado à parte, porque sai antes de existir conversa. Tempo de resposta = primeira resposta depois de uma mensagem
            do cliente, ignorando intervalos acima de 12 h. Janela aberta = conversa em que o cliente falou nas últimas 24 h, onde a mensagem é grátis.
          </p>
        </>
      )}
    </section>
  );
}
