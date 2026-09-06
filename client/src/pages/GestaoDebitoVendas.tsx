// client/src/pages/GestaoDebitoVendas.tsx
// -----------------------------------------------------------------------------
// GESTAO — DEBITO VENCIDO E VARIACAO DE VENDAS POR CARTEIRA
//
// Relatorio da diretoria (grupo "Gestao" do menu). Duas perguntas, uma tela:
//   1. Quanto cada carteira tem de DEBITO VENCIDO hoje, e com que idade
//      (1-30 / 31-60 / 61-90 / 90+ dias).
//   2. Quem CAIU e quem SUBIU em vendas nos ultimos N dias (padrao 30) contra a
//      janela anterior de mesmo tamanho — por cliente e por carteira.
//
// Fonte unica: GET /api/gestao/debito-e-vendas (server/gestao-debito-vendas-routes.ts),
// que usa a MESMA regua de venda/vencido da Gestao de Carteiras. Todo o
// fatiamento (carteira, busca, quantos aparecem no ranking) e feito aqui na tela,
// sobre a mesma carga — trocar filtro nao volta ao servidor.
// -----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  MultiSelect, multiMatch, useTableSort, SortableTh, exportToExcel, ExportExcelButton,
} from '@/lib/tableTools';
import {
  Loader2, RefreshCw, TrendingDown, TrendingUp, AlertTriangle, Search, Wallet,
} from 'lucide-react';

type ClienteRow = {
  chave: string; cliente: string; carteira: string; cidade: string;
  vencido: number; titulosVencidos: number; diasMax: number;
  ag30: number; ag60: number; ag90: number; ag90mais: number;
  atual: number; anterior: number; delta: number; deltaPct: number | null;
  titulosAtual: number; titulosAnterior: number; ultimaVenda: string | null;
};
type CarteiraRow = {
  carteira: string;
  vencido: number; titulosVencidos: number; clientesVencidos: number; maiorAtraso: number;
  ag30: number; ag60: number; ag90: number; ag90mais: number;
  atual: number; anterior: number; delta: number; deltaPct: number | null;
  clientesAtual: number; clientesAnterior: number; clientesQueCairam: number; clientesQueSubiram: number;
  maiorQuedaCliente: string | null; maiorQuedaValor: number;
  maiorGanhoCliente: string | null; maiorGanhoValor: number;
};
type Resposta = {
  janela: { dias: number; de: string; ate: string; deAnt: string; ateAnt: string; hoje: string };
  escopo: 'carteira' | 'todas';
  totais: { vencido: number; atual: number; anterior: number; clientesVencidos: number };
  carteiras: CarteiraRow[];
  clientes: ClienteRow[];
};

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const fmtDia = (v: string | null) => (v ? v.slice(0, 10).split('-').reverse().join('/') : '—');
const JANELAS = [30, 60, 90] as const;
/** Quantas linhas cada ranking mostra. */
const TOPS = [10, 20, 50] as const;

/** Vermelho para queda, verde para ganho — o sinal do numero manda. */
function corDelta(v: number) {
  if (v < 0) return 'text-red-600 dark:text-red-400';
  if (v > 0) return 'text-emerald-600 dark:text-emerald-400';
  return 'text-gray-500';
}

export default function GestaoDebitoVendas() {
  const [dias, setDias] = useState<number>(30);
  const [carteirasSel, setCarteirasSel] = useState<string[]>([]);
  const [busca, setBusca] = useState('');
  const [top, setTop] = useState<number>(20);
  const [soComVencido, setSoComVencido] = useState(false);

  const url = `/api/gestao/debito-e-vendas?dias=${dias}`;
  const { data, isLoading, isFetching, refetch, error } = useQuery<Resposta>({ queryKey: [url] });

  const opcoesCarteira = useMemo(
    () => Array.from(new Set((data?.carteiras || []).map((c) => c.carteira))).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [data],
  );

  // Filtro comum das duas metades da tela.
  const clientes = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return (data?.clientes || []).filter((c) => {
      if (!multiMatch(carteirasSel, c.carteira)) return false;
      if (soComVencido && c.vencido <= 0) return false;
      if (termo && !`${c.cliente} ${c.cidade} ${c.carteira}`.toLowerCase().includes(termo)) return false;
      return true;
    });
  }, [data, carteirasSel, busca, soComVencido]);

  const carteiras = useMemo(
    () => (data?.carteiras || []).filter((c) => multiMatch(carteirasSel, c.carteira)),
    [data, carteirasSel],
  );

  const totais = useMemo(() => {
    const t = { vencido: 0, ag30: 0, ag60: 0, ag90: 0, ag90mais: 0, atual: 0, anterior: 0, clientesVencidos: 0 };
    for (const c of carteiras) {
      t.vencido += c.vencido; t.ag30 += c.ag30; t.ag60 += c.ag60; t.ag90 += c.ag90; t.ag90mais += c.ag90mais;
      t.atual += c.atual; t.anterior += c.anterior; t.clientesVencidos += c.clientesVencidos;
    }
    return t;
  }, [carteiras]);

  const quedasCliente = useMemo(
    () => clientes.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, top),
    [clientes, top],
  );
  const ganhosCliente = useMemo(
    () => clientes.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, top),
    [clientes, top],
  );
  const quedasCarteira = useMemo(() => [...carteiras].filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta), [carteiras]);
  const ganhosCarteira = useMemo(() => [...carteiras].filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta), [carteiras]);

  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort('vencido', 'desc');
  const carteirasOrdenadas = useMemo(
    () => sortRows(carteiras, (r: any, k) => r[k]),
    [carteiras, sortKey, sortDir],
  );

  const deltaTotal = totais.atual - totais.anterior;
  const deltaPctTotal = totais.anterior > 0 ? (deltaTotal / totais.anterior) * 100 : null;
  const j = data?.janela;

  function exportarCarteiras() {
    exportToExcel(
      carteirasOrdenadas.map((c) => ({
        Carteira: c.carteira,
        'Débito vencido': c.vencido,
        'Clientes devendo': c.clientesVencidos,
        'Títulos vencidos': c.titulosVencidos,
        'Maior atraso (dias)': c.maiorAtraso,
        '1 a 30 dias': c.ag30, '31 a 60 dias': c.ag60, '61 a 90 dias': c.ag90, 'Mais de 90 dias': c.ag90mais,
        [`Vendas ${dias}d`]: c.atual,
        [`Vendas ${dias}d anteriores`]: c.anterior,
        Variação: c.delta,
        'Variação %': c.deltaPct,
        'Clientes que caíram': c.clientesQueCairam,
        'Clientes que subiram': c.clientesQueSubiram,
      })),
      `carteiras-debito-vendas-${j?.ate || ''}`,
    );
  }
  function exportarClientes() {
    exportToExcel(
      clientes.map((c) => ({
        Cliente: c.cliente, Carteira: c.carteira, Cidade: c.cidade,
        'Débito vencido': c.vencido, 'Títulos vencidos': c.titulosVencidos, 'Maior atraso (dias)': c.diasMax,
        '1 a 30 dias': c.ag30, '31 a 60 dias': c.ag60, '61 a 90 dias': c.ag90, 'Mais de 90 dias': c.ag90mais,
        [`Vendas ${dias}d`]: c.atual,
        [`Vendas ${dias}d anteriores`]: c.anterior,
        Variação: c.delta, 'Variação %': c.deltaPct,
        'Última venda': c.ultimaVenda || '',
      })),
      `clientes-debito-vendas-${j?.ate || ''}`,
    );
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-900 min-h-[calc(100vh-56px)]">
      <div className="p-4 max-w-[1600px] mx-auto space-y-4">
        {/* Cabecalho */}
        <div className="flex flex-wrap items-center gap-3">
          <BackToDashboardButton />
          <h1 className="text-xl font-bold flex items-center gap-2 text-teal-700 dark:text-teal-300">
            <Wallet className="w-5 h-5" /> Débito Vencido e Variação de Vendas
          </h1>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {j ? `Débito em ${fmtDia(j.hoje)} · vendas de ${fmtDia(j.de)} a ${fmtDia(j.ate)} contra ${fmtDia(j.deAnt)} a ${fmtDia(j.ateAnt)}` : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => refetch()}
              className="px-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700 inline-flex items-center gap-2"
              data-testid="button-atualizar"
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Atualizar
            </button>
          </div>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg p-3">
          <div className="inline-flex rounded-md border dark:border-gray-700 overflow-hidden" data-testid="seletor-janela">
            {JANELAS.map((d) => (
              <button
                key={d}
                onClick={() => setDias(d)}
                className={`px-3 py-2 text-sm ${dias === d ? 'bg-teal-600 text-white' : 'bg-white dark:bg-gray-800'}`}
              >
                {d} dias
              </button>
            ))}
          </div>
          <MultiSelect
            label="Carteira"
            options={opcoesCarteira}
            selected={carteirasSel}
            onChange={setCarteirasSel}
            testId="filtro-carteira"
          />
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar cliente ou cidade"
              className="pl-8 pr-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700 min-w-[220px]"
              data-testid="input-busca"
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={soComVencido} onChange={(e) => setSoComVencido(e.target.checked)} />
            Só quem está devendo
          </label>
          <div className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
            Top:
            {TOPS.map((t) => (
              <button
                key={t}
                onClick={() => setTop(t)}
                className={`px-2 py-1 border rounded ${top === t ? 'bg-teal-600 text-white border-teal-600' : 'dark:border-gray-700'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <ExportExcelButton onClick={exportarCarteiras} testId="button-export-carteiras" />
            <button
              onClick={exportarClientes}
              className="px-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-800 dark:border-gray-700"
              data-testid="button-export-clientes"
            >
              Exportar clientes
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 p-8 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" /> Carregando…
          </div>
        ) : error ? (
          <div className="p-4 border border-red-300 bg-red-50 dark:bg-red-950 rounded-lg text-sm text-red-700 dark:text-red-300">
            Falha ao carregar o relatório. Tente Atualizar.
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi titulo="Débito vencido" valor={fmtBRL(totais.vencido)} sub={`${totais.clientesVencidos} clientes devendo`} icone={<AlertTriangle className="w-4 h-4" />} destaque="text-red-600 dark:text-red-400" />
              <Kpi titulo={`Vendas ${dias}d`} valor={fmtBRL(totais.atual)} sub={`anterior: ${fmtBRL(totais.anterior)}`} />
              <Kpi titulo="Variação" valor={`${deltaTotal >= 0 ? '+' : ''}${fmtBRL(deltaTotal)}`} sub={fmtPct(deltaPctTotal)} destaque={corDelta(deltaTotal)} icone={deltaTotal < 0 ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />} />
              <Kpi titulo="Vencido há mais de 90 dias" valor={fmtBRL(totais.ag90mais)} sub={`${totais.vencido > 0 ? Math.round((totais.ag90mais / totais.vencido) * 100) : 0}% do vencido`} destaque="text-red-700 dark:text-red-400" />
            </div>

            {/* 1) Debito vencido por carteira */}
            <Bloco titulo="Débito vencido por carteira" contagem={carteirasOrdenadas.length}>
              <div className="border rounded-lg bg-white dark:bg-gray-800 overflow-auto max-h-[520px]">
                <table className="w-full text-xs" data-testid="tabela-carteiras">
                  <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700 shadow-sm">
                    <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left">
                      <SortableTh label="Carteira" colKey="carteira" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortableTh label="Débito vencido" colKey="vencido" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="Clientes" colKey="clientesVencidos" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="Títulos" colKey="titulosVencidos" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="1-30" colKey="ag30" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="31-60" colKey="ag60" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="61-90" colKey="ag90" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="90+" colKey="ag90mais" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="Maior atraso" colKey="maiorAtraso" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label={`Vendas ${dias}d`} colKey="atual" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                      <SortableTh label="Variação" colKey="delta" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {carteirasOrdenadas.map((c) => (
                      <tr key={c.carteira} className="border-t dark:border-gray-700 [&>td]:px-2 [&>td]:py-1.5">
                        <td className="font-medium">{c.carteira}</td>
                        <td className="text-right font-semibold text-red-600 dark:text-red-400">{fmtBRL(c.vencido)}</td>
                        <td className="text-right">{c.clientesVencidos}</td>
                        <td className="text-right">{c.titulosVencidos}</td>
                        <td className="text-right">{fmtBRL(c.ag30)}</td>
                        <td className="text-right">{fmtBRL(c.ag60)}</td>
                        <td className="text-right">{fmtBRL(c.ag90)}</td>
                        <td className="text-right font-medium">{fmtBRL(c.ag90mais)}</td>
                        <td className="text-right">{c.maiorAtraso ? `${c.maiorAtraso} d` : '—'}</td>
                        <td className="text-right">{fmtBRL(c.atual)}</td>
                        <td className={`text-right font-semibold ${corDelta(c.delta)}`}>
                          {c.delta >= 0 ? '+' : ''}{fmtBRL(c.delta)} <span className="opacity-70">({fmtPct(c.deltaPct)})</span>
                        </td>
                      </tr>
                    ))}
                    {!carteirasOrdenadas.length && (
                      <tr><td colSpan={11} className="p-4 text-center text-gray-500">Nada a mostrar com os filtros atuais.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Bloco>

            {/* 2) Quedas e ganhos por carteira */}
            <div className="grid md:grid-cols-2 gap-4">
              <RankCarteira titulo="Maiores quedas por carteira" linhas={quedasCarteira} dias={dias} tipo="queda" />
              <RankCarteira titulo="Maiores ganhos por carteira" linhas={ganhosCarteira} dias={dias} tipo="ganho" />
            </div>

            {/* 3) Quedas e ganhos por cliente */}
            <div className="grid md:grid-cols-2 gap-4">
              <RankCliente titulo={`Maiores quedas por cliente (top ${top})`} linhas={quedasCliente} dias={dias} tipo="queda" />
              <RankCliente titulo={`Maiores ganhos por cliente (top ${top})`} linhas={ganhosCliente} dias={dias} tipo="ganho" />
            </div>

            <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
              Débito vencido = títulos com vencimento já passado e saldo em aberto (valor − valor pago), no fuso de Brasília.
              Vendas = títulos emitidos no período, com a mesma régua da Gestão de Carteiras (fora cancelados, empresas do
              grupo, devolução/troca/amostra/bonificação/transferência, aporte e pedidos na lixeira). Título de cliente sem
              cadastro correspondente aparece como “Sem carteira” — nunca é rateado entre vendedores.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi(props: { titulo: string; valor: string; sub?: string; destaque?: string; icone?: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg p-3">
      <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">{props.icone}{props.titulo}</div>
      <div className={`text-lg font-bold ${props.destaque || ''}`}>{props.valor}</div>
      {props.sub ? <div className="text-[11px] text-gray-500 dark:text-gray-400">{props.sub}</div> : null}
    </div>
  );
}

function Bloco(props: { titulo: string; contagem?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
        {props.titulo}
        {typeof props.contagem === 'number' ? <span className="ml-2 text-xs font-normal text-gray-500">{props.contagem}</span> : null}
      </h2>
      {props.children}
    </section>
  );
}

function RankCarteira(props: { titulo: string; linhas: CarteiraRow[]; dias: number; tipo: 'queda' | 'ganho' }) {
  const { linhas, dias, tipo } = props;
  return (
    <Bloco titulo={props.titulo} contagem={linhas.length}>
      <div className="border rounded-lg bg-white dark:bg-gray-800 overflow-auto max-h-[420px]">
        <table className="w-full text-xs" data-testid={`tabela-carteira-${tipo}`}>
          <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700">
            <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left">
              <th>Carteira</th>
              <th className="text-right">{dias}d</th>
              <th className="text-right">Anterior</th>
              <th className="text-right">Variação</th>
              <th>{tipo === 'queda' ? 'Cliente que mais caiu' : 'Cliente que mais subiu'}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((c) => (
              <tr key={c.carteira} className="border-t dark:border-gray-700 [&>td]:px-2 [&>td]:py-1.5">
                <td className="font-medium">{c.carteira}</td>
                <td className="text-right">{fmtBRL(c.atual)}</td>
                <td className="text-right text-gray-500">{fmtBRL(c.anterior)}</td>
                <td className={`text-right font-semibold ${corDelta(c.delta)}`}>
                  {c.delta >= 0 ? '+' : ''}{fmtBRL(c.delta)} <span className="opacity-70">({fmtPct(c.deltaPct)})</span>
                </td>
                <td className="truncate max-w-[220px]">
                  {tipo === 'queda'
                    ? c.maiorQuedaCliente ? `${c.maiorQuedaCliente} (${fmtBRL(c.maiorQuedaValor)})` : '—'
                    : c.maiorGanhoCliente ? `${c.maiorGanhoCliente} (+${fmtBRL(c.maiorGanhoValor)})` : '—'}
                </td>
              </tr>
            ))}
            {!linhas.length && <tr><td colSpan={5} className="p-4 text-center text-gray-500">Nenhuma carteira nesta lista.</td></tr>}
          </tbody>
        </table>
      </div>
    </Bloco>
  );
}

function RankCliente(props: { titulo: string; linhas: ClienteRow[]; dias: number; tipo: 'queda' | 'ganho' }) {
  const { linhas, dias, tipo } = props;
  return (
    <Bloco titulo={props.titulo} contagem={linhas.length}>
      <div className="border rounded-lg bg-white dark:bg-gray-800 overflow-auto max-h-[520px]">
        <table className="w-full text-xs" data-testid={`tabela-cliente-${tipo}`}>
          <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700">
            <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left">
              <th>Cliente</th>
              <th>Carteira</th>
              <th className="text-right">{dias}d</th>
              <th className="text-right">Anterior</th>
              <th className="text-right">Variação</th>
              <th className="text-right">Vencido</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((c) => (
              <tr key={c.chave} className="border-t dark:border-gray-700 [&>td]:px-2 [&>td]:py-1.5">
                <td className="truncate max-w-[260px]" title={c.cidade ? `${c.cliente} — ${c.cidade}` : c.cliente}>{c.cliente}</td>
                <td className="truncate max-w-[160px] text-gray-600 dark:text-gray-300">{c.carteira}</td>
                <td className="text-right">{fmtBRL(c.atual)}</td>
                <td className="text-right text-gray-500">{fmtBRL(c.anterior)}</td>
                <td className={`text-right font-semibold ${corDelta(c.delta)}`}>
                  {c.delta >= 0 ? '+' : ''}{fmtBRL(c.delta)} <span className="opacity-70">({fmtPct(c.deltaPct)})</span>
                </td>
                <td className="text-right text-red-600 dark:text-red-400">
                  {c.vencido > 0 ? `${fmtBRL(c.vencido)} · ${c.diasMax}d` : '—'}
                </td>
              </tr>
            ))}
            {!linhas.length && <tr><td colSpan={6} className="p-4 text-center text-gray-500">Nenhum cliente nesta lista.</td></tr>}
          </tbody>
        </table>
      </div>
    </Bloco>
  );
}
