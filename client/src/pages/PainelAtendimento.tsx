// client/src/pages/PainelAtendimento.tsx
// -----------------------------------------------------------------------------
// GESTAO — PAINEL DE ATENDIMENTO
//
// Visao do dia, por vendedor, para a gestao (admin + administrativo):
//   visitas, atendimentos, pedidos (qtd + R$), repescagem atendida, faturado,
//   km rodado e horario do primeiro/ultimo check-in.
//
// Fonte unica: GET /api/gestao/painel-atendimento?dia=YYYY-MM-DD
// (server/painel-atendimento-routes.ts — as reguas estao documentadas la).
//
// "Tempo real" = polling: a tela reconsulta sozinha a cada 30 s (ajustavel),
// so enquanto a aba esta visivel, e mostra ha quantos segundos os numeros
// foram lidos. Quando o dia escolhido nao e hoje, o polling para — o passado
// nao muda.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { useTableSort, SortableTh, exportToExcel, ExportExcelButton } from '@/lib/tableTools';
import {
  Loader2, RefreshCw, Users, MapPin, Headset, ShoppingCart, Redo2, FileCheck2, Route, Clock,
  Radio, Pause, AlertTriangle,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
} from 'recharts';

type Linha = {
  vendedorId: string; vendedor: string; papel: string | null; ativo: boolean;
  visitas: number; atendimentos: number; pedidos: number; valorPedidos: number;
  repescagem: number; repescagemAlocados: number; faturado: number; notas: number;
  km: number | null; kmFonte: 'rota' | 'checkpoints' | null;
  primeiroCheckIn: string | null; ultimoCheckIn: string | null;
};
type Resposta = {
  dia: string; hoje: string; ehHoje: boolean; geradoEm: string;
  totais: {
    vendedores: number; emCampo: number; visitas: number; atendimentos: number; pedidos: number;
    valorPedidos: number; repescagem: number; repescagemAlocados: number; faturado: number; notas: number; km: number;
  };
  vendedores: Linha[];
  evolutivoRepescagem: { de: string; ate: string; dias: { dia: string; sorteados: number; atendidos: number }[] };
};

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtInt = (v: number) => (Number(v) || 0).toLocaleString('pt-BR');
const fmtKm = (v: number | null) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`);
const fmtDia = (v: string) => v.split('-').reverse().join('/');
const INTERVALOS = [15, 30, 60] as const;
const JANELAS_EVOLUTIVO = [15, 30, 60, 90] as const;

/** Situacao do vendedor no dia, pelo que ja aconteceu. */
function situacao(l: Linha, ehHoje: boolean): { rotulo: string; cor: string } {
  if (l.visitas > 0 || l.atendimentos > 0 || l.pedidos > 0) {
    return { rotulo: ehHoje ? 'Em atividade' : 'Ativo no dia', cor: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' };
  }
  if (l.papel === 'telemarketing') return { rotulo: 'Sem atendimento', cor: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' };
  return { rotulo: 'Sem check-in', cor: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' };
}

/** Barra proporcional dentro da celula — o numero e o que manda; a barra so da a escala. */
function Barra({ valor, max, children }: { valor: number; max: number; children: React.ReactNode }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (valor / max) * 100)) : 0;
  return (
    <div className="relative">
      <div className="absolute inset-y-1 left-0 rounded-sm bg-teal-100 dark:bg-teal-900/40" style={{ width: `${pct}%` }} aria-hidden />
      <div className="relative px-1 tabular-nums">{children}</div>
    </div>
  );
}

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

export default function PainelAtendimento() {
  const hojeLocal = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [dia, setDia] = useState<string>(hojeLocal);
  const [intervalo, setIntervalo] = useState<number>(30);
  const [aoVivo, setAoVivo] = useState(true);
  const [agora, setAgora] = useState(() => Date.now());
  const [diasEvolutivo, setDiasEvolutivo] = useState<number>(30);

  const ehHoje = dia === hojeLocal;
  const polling = aoVivo && ehHoje;
  const url = `/api/gestao/painel-atendimento?dia=${dia}&dias=${diasEvolutivo}`;
  const { data, isLoading, isFetching, refetch, error, dataUpdatedAt } = useQuery<Resposta>({
    queryKey: [url],
    staleTime: 0,
    refetchInterval: polling ? intervalo * 1000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Relogio de 1 s so para o "atualizado ha Xs".
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const segundosAtras = dataUpdatedAt ? Math.max(0, Math.round((agora - dataUpdatedAt) / 1000)) : null;

  const linhas = data?.vendedores || [];
  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort('faturado', 'desc');
  const ordenadas = useMemo(
    () => sortRows(linhas, (r: any, k) => (k === 'km' ? (r.km ?? -1) : r[k])),
    [linhas, sortKey, sortDir],
  );

  const max = useMemo(() => ({
    visitas: Math.max(0, ...linhas.map((l) => l.visitas)),
    atendimentos: Math.max(0, ...linhas.map((l) => l.atendimentos)),
    pedidos: Math.max(0, ...linhas.map((l) => l.pedidos)),
    valorPedidos: Math.max(0, ...linhas.map((l) => l.valorPedidos)),
    repescagem: Math.max(0, ...linhas.map((l) => l.repescagem)),
    faturado: Math.max(0, ...linhas.map((l) => l.faturado)),
    km: Math.max(0, ...linhas.map((l) => l.km || 0)),
  }), [linhas]);

  const t = data?.totais;

  // Evolutivo da repescagem: barra empilhada (atendidos + nao atendidos = sorteados)
  const evolutivo = useMemo(() => (data?.evolutivoRepescagem?.dias || []).map((d) => ({
    dia: d.dia,
    rotulo: d.dia.slice(8, 10) + '/' + d.dia.slice(5, 7),
    sorteados: d.sorteados,
    atendidos: d.atendidos,
    naoAtendidos: Math.max(0, d.sorteados - d.atendidos),
    taxa: d.sorteados > 0 ? Math.round((d.atendidos / d.sorteados) * 100) : null,
  })), [data]);
  const resumoEvolutivo = useMemo(() => {
    const s = evolutivo.reduce((a, d) => ({ sorteados: a.sorteados + d.sorteados, atendidos: a.atendidos + d.atendidos }), { sorteados: 0, atendidos: 0 });
    return { ...s, taxa: s.sorteados > 0 ? Math.round((s.atendidos / s.sorteados) * 100) : null };
  }, [evolutivo]);

  function exportar() {
    exportToExcel(
      ordenadas.map((l) => ({
        Vendedor: l.vendedor,
        Papel: l.papel || '',
        Visitas: l.visitas,
        Atendimentos: l.atendimentos,
        Pedidos: l.pedidos,
        'Valor pedidos': l.valorPedidos,
        'Repescagem atendida': l.repescagem,
        'Repescagem alocada': l.repescagemAlocados,
        'Notas emitidas': l.notas,
        Faturado: l.faturado,
        'Km rodado': l.km ?? '',
        '1º check-in': l.primeiroCheckIn || '',
        'Último check-in': l.ultimoCheckIn || '',
      })),
      `painel-atendimento-${dia}`,
    );
  }

  return (
    <div className="space-y-4 p-4" data-testid="page-painel-atendimento">
      {/* Cabecalho */}
      <div className="flex flex-wrap items-center gap-3">
        <BackToDashboardButton />
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-50">Painel de Atendimento</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Dia {fmtDia(dia)} · {t ? `${t.emCampo} de ${t.vendedores} vendedores com atividade` : '—'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="date" value={dia} max={hojeLocal}
            onChange={(e) => e.target.value && setDia(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
            data-testid="input-dia"
          />
          {!ehHoje && (
            <button type="button" onClick={() => setDia(hojeLocal)}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
              data-testid="button-hoje">Hoje</button>
          )}
          <button
            type="button" onClick={() => setAoVivo((v) => !v)} disabled={!ehHoje}
            title={ehHoje ? (aoVivo ? 'Pausar atualização automática' : 'Retomar atualização automática') : 'Só o dia de hoje atualiza sozinho'}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm ${polling
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-300'} disabled:opacity-50`}
            data-testid="button-ao-vivo"
          >
            {polling ? <Radio className="h-4 w-4 animate-pulse" /> : <Pause className="h-4 w-4" />}
            {polling ? 'Ao vivo' : 'Pausado'}
          </button>
          <select
            value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
            data-testid="select-intervalo"
          >
            {INTERVALOS.map((s) => <option key={s} value={s}>a cada {s}s</option>)}
          </select>
          <button type="button" onClick={() => refetch()}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
            data-testid="button-atualizar">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Atualizar
          </button>
          <ExportExcelButton onClick={exportar} />
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="text-atualizado">
        <Clock className="h-3.5 w-3.5" />
        {segundosAtras === null ? 'Carregando…' : `Atualizado há ${segundosAtras}s`}
        {polling && ` · próxima leitura em até ${intervalo}s`}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300" data-testid="text-erro">
          <AlertTriangle className="h-4 w-4" /> Não foi possível carregar o painel: {(error as any)?.message || 'erro'}
        </div>
      )}

      {/* KPIs do dia */}
      {t && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Kpi icone={<MapPin className="h-4 w-4" />} rotulo="Visitas" valor={fmtInt(t.visitas)} sub="check-ins (clientes)" testid="kpi-visitas" />
          <Kpi icone={<Headset className="h-4 w-4" />} rotulo="Atendimentos" valor={fmtInt(t.atendimentos)} sub="visita, virtual ou pedido" testid="kpi-atendimentos" />
          <Kpi icone={<ShoppingCart className="h-4 w-4" />} rotulo="Pedidos" valor={fmtInt(t.pedidos)} sub={fmtBRL(t.valorPedidos)} testid="kpi-pedidos" />
          <Kpi icone={<Redo2 className="h-4 w-4" />} rotulo="Repescagem" valor={fmtInt(t.repescagem)} sub={`atendidos de ${fmtInt(t.repescagemAlocados)} alocados`} testid="kpi-repescagem" />
          <Kpi icone={<FileCheck2 className="h-4 w-4" />} rotulo="Faturado" valor={fmtBRL(t.faturado)} sub={`${fmtInt(t.notas)} NF-e`} testid="kpi-faturado" />
          <Kpi icone={<Route className="h-4 w-4" />} rotulo="Km rodado" valor={fmtKm(t.km)} sub="todas as rotas" testid="kpi-km" />
          <Kpi icone={<Users className="h-4 w-4" />} rotulo="Em atividade" valor={`${fmtInt(t.emCampo)} / ${fmtInt(t.vendedores)}`} sub="vendedores" testid="kpi-vendedores" />
        </div>
      )}

      {/* Tabela por vendedor */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando…</div>
        ) : (
          <table className="w-full text-sm" data-testid="table-vendedores">
            <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              <tr>
                <SortableTh colKey="vendedor" label="Vendedor" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-2">Situação</th>
                <SortableTh colKey="visitas" label="Visitas" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="atendimentos" label="Atendimentos" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="pedidos" label="Pedidos" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="valorPedidos" label="R$ Pedidos" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="repescagem" label="Repescagem (atend. / aloc.)" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="faturado" label="Faturado" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="km" label="Km rodado" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortableTh colKey="primeiroCheckIn" label="1º check-in" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortableTh colKey="ultimoCheckIn" label="Último check-in" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {ordenadas.length === 0 && (
                <tr><td colSpan={11} className="p-8 text-center text-gray-500">Nenhum vendedor ativo e nenhuma atividade neste dia.</td></tr>
              )}
              {ordenadas.map((l) => {
                const s = situacao(l, !!data?.ehHoje);
                const semVendedor = l.vendedorId === 'sem-vendedor';
                return (
                  <tr key={l.vendedorId} className={`hover:bg-gray-50 dark:hover:bg-gray-800/60 ${semVendedor ? 'italic text-gray-500' : ''}`} data-testid={`row-vendedor-${l.vendedorId}`}>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-50">
                      {l.vendedor}
                      {l.papel === 'telemarketing' && <span className="ml-1 text-xs font-normal text-gray-500">(TMK)</span>}
                      {!l.ativo && <span className="ml-1 text-xs font-normal text-gray-500">(inativo)</span>}
                    </td>
                    <td className="px-3 py-2">
                      {!semVendedor && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cor}`}>{s.rotulo}</span>}
                    </td>
                    <td className="px-2 py-1 text-right"><Barra valor={l.visitas} max={max.visitas}>{fmtInt(l.visitas)}</Barra></td>
                    <td className="px-2 py-1 text-right"><Barra valor={l.atendimentos} max={max.atendimentos}>{fmtInt(l.atendimentos)}</Barra></td>
                    <td className="px-2 py-1 text-right"><Barra valor={l.pedidos} max={max.pedidos}>{fmtInt(l.pedidos)}</Barra></td>
                    <td className="px-2 py-1 text-right"><Barra valor={l.valorPedidos} max={max.valorPedidos}>{fmtBRL(l.valorPedidos)}</Barra></td>
                    <td className="px-2 py-1 text-right" title="Clientes em repescagem atendidos hoje por este vendedor / clientes de repescagem alocados a ele hoje">
                      <Barra valor={l.repescagem} max={max.repescagem}>
                        {fmtInt(l.repescagem)}
                        <span className="ml-1 text-xs text-gray-500">/ {fmtInt(l.repescagemAlocados)}</span>
                      </Barra>
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Barra valor={l.faturado} max={max.faturado}>
                        <span className="font-medium">{fmtBRL(l.faturado)}</span>
                        {l.notas > 0 && <span className="ml-1 text-xs text-gray-500">({l.notas} NF)</span>}
                      </Barra>
                    </td>
                    <td className="px-2 py-1 text-right" title={l.kmFonte === 'checkpoints' ? 'Rota ainda aberta: soma das pernas entre check-ins' : l.kmFonte === 'rota' ? 'Total da rota do dia' : 'Sem rota do dia'}>
                      <Barra valor={l.km || 0} max={max.km}>
                        {fmtKm(l.km)}{l.kmFonte === 'checkpoints' && <span className="ml-0.5 text-xs text-amber-600" aria-label="parcial">*</span>}
                      </Barra>
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums">{l.primeiroCheckIn || '—'}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{l.ultimoCheckIn || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            {t && ordenadas.length > 0 && (
              <tfoot className="bg-gray-50 text-sm font-semibold dark:bg-gray-800">
                <tr data-testid="row-totais">
                  <td className="px-3 py-2" colSpan={2}>Total do dia</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(t.visitas)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(t.atendimentos)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(t.pedidos)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(t.valorPedidos)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtInt(t.repescagem)} <span className="text-xs font-normal text-gray-500">/ {fmtInt(t.repescagemAlocados)}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(t.faturado)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKm(t.km)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* Evolutivo da repescagem */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" data-testid="card-evolutivo-repescagem">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-50">
              <Redo2 className="h-4 w-4 text-teal-600 dark:text-teal-400" /> Repescagem — clientes sorteados × atendidos
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Por dia de sorteio, até {fmtDia(dia)}. No período: {fmtInt(resumoEvolutivo.sorteados)} clientes em repescagem,
              {' '}{fmtInt(resumoEvolutivo.atendidos)} atendidos{resumoEvolutivo.taxa !== null ? ` (${resumoEvolutivo.taxa}%)` : ''}.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {JANELAS_EVOLUTIVO.map((n) => (
              <button key={n} type="button" onClick={() => setDiasEvolutivo(n)}
                className={`rounded-md border px-2 py-1 text-xs ${diasEvolutivo === n
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'}`}
                data-testid={`button-evolutivo-${n}`}>{n} dias</button>
            ))}
          </div>
        </div>
        <div className="mt-3 h-72 w-full" data-testid="chart-evolutivo-repescagem">
          {evolutivo.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">Sem dados de repescagem no período.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={evolutivo} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid vertical={false} stroke="currentColor" className="text-gray-200 dark:text-gray-700" strokeOpacity={0.6} />
                <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                  interval={evolutivo.length > 40 ? Math.ceil(evolutivo.length / 20) - 1 : 0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
                <Tooltip
                  cursor={{ fill: 'rgba(13,148,136,0.08)' }}
                  formatter={(v: any, name: any) => [fmtInt(Number(v)), name]}
                  labelFormatter={(_l: any, p: any) => {
                    const d = p?.[0]?.payload;
                    return d ? `${fmtDia(d.dia)} · ${fmtInt(d.sorteados)} sorteados · ${fmtInt(d.atendidos)} atendidos${d.taxa !== null ? ` (${d.taxa}%)` : ''}` : '';
                  }}
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="atendidos" name="Atendidos" stackId="r" fill="#0d9488" />
                <Bar dataKey="naoAtendidos" name="Não atendidos" stackId="r" fill="#cbd5e1" radius={[4, 4, 0, 0]}>
                  {evolutivo.length <= 45 && (
                    <LabelList dataKey="taxa" position="top" fontSize={10} fill="#6b7280"
                      formatter={(v: any) => (v === null || v === undefined ? '' : `${v}%`)} />
                  )}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Barra = clientes que saíram no sorteio da repescagem naquele dia; a parte escura são os atendidos (fechados como concluídos). O rótulo é a taxa de atendimento do dia.
        </p>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Visita = check-in presencial (clientes distintos). Atendimento = cliente atendido por visita, atendimento virtual ou pedido.
        Repescagem = clientes em repescagem no dia atendidos pelo vendedor / clientes de repescagem alocados a ele no dia.
        Pedidos = implantados no pipeline no dia. Faturado = NF-e de venda autorizada no dia (mesma régua do Faturamento).
        Km = total da rota do dia; <span className="text-amber-600">*</span> = rota ainda aberta (soma parcial entre check-ins).
      </p>
    </div>
  );
}
