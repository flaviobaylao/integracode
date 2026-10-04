// ===========================================================================
// PROGRAMAÇÃO DE PRODUÇÃO (módulo Indústria › aba Programação) — 04/out/2026
// ===========================================================================
// Em uma tela: SAÍDAS de produto acabado por dia / semana / mês (filtro por
// instância), ESTOQUE NA FÁBRICA (IND) × ESTOQUE NO ESCRITÓRIO (GYN) × BSB,
// LEAD TIME / COBERTURA por produto e o botão PROGRAMAR PRODUÇÃO, que cria
// ordens de produção 'planejada' com a quantidade sugerida (ou editada).
// Dados: GET /api/industria/programacao (server/programacao-producao-routes.ts).
// ===========================================================================
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { exportSheetsToExcel } from '@/lib/tableTools';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  CalendarClock, Factory, Building2, Warehouse, TrendingDown, AlertTriangle, RefreshCw, Loader2,
  FileSpreadsheet, Settings2, PlayCircle, CheckCircle2, Info,
} from 'lucide-react';

// ---------------------------------------------------------------------------
type Tipo = 'venda' | 'troca' | 'amostra' | 'bonificacao' | 'outros';
type Saida = { productId: string; instancia: string; dia: string; tipo: Tipo; qtd: number };
type Produto = {
  productId: string; nome: string; codigo: string | null; sabor: string; tam: string | null; ativo: boolean; fardoUnidades: number;
  estoque: { fabrica: number; escritorio: number; porInstancia: Record<string, number>; bloqueadoPorInstancia: Record<string, number>; total: number; cobertura: number; lotesFabrica: number; custoFabrica: number };
  saidas: { janelaDias: number; diasUteisJanela: number; total: number; venda: number; troca: number; amostra: number; bonificacao: number; outros: number; mediaDia: number; mediaSemana: number; mediaMes: number; picoSemana: number; diasComSaida: number };
  programado: { aberto: number; ops: { id: string; orderNumber: string; status: string; quantidade: number; productionDate: string | null }[] };
  calculo: { leadTotal: number; diasMinimo: number; diasAlvo: number; coberturaDias: number | null; coberturaComProgramado: number | null; estoqueMinimo: number; estoqueAlvo: number; sugestaoProduzir: number; sugestaoFardos: number | null; dataRuptura: string | null; dataLimiteProducao: string | null; status: 'ruptura' | 'critico' | 'atencao' | 'ok' | 'sem_giro' };
};
type Parametros = { leadProducaoDias: number; leadTransferenciaDias: number; segurancaDias: number; horizonteDias: number; janelaMediaDias: number; loteMinimoUnidades: number; arredondarFardo: boolean };
type Payload = {
  geradoEm: string; hoje: string; periodo: { de: string; ate: string }; janelaMediaDias: number; diasUteisJanela: number; inicioJanela: string;
  instancias: { id: string; name: string; displayName: string }[]; instanciasDemanda: string[];
  parametros: Parametros; produtos: Produto[]; saidas: Saida[];
  totais: { estoqueFabrica: number; estoqueEscritorio: number; estoquePorInstancia: Record<string, number>; saidasJanela: number; mediaDia: number; sugestaoProduzir: number; programado: number; porStatus: Record<string, number>; saidasPorInstancia: Record<string, Record<string, number>> };
};
type Gran = 'dia' | 'semana' | 'mes';

const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};
const fmtInt = (v: any) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const fmt1 = (v: any) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtData = (ymd: string | null) => (ymd ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : '—');
const fmtDataCurta = (ymd: string) => ymd.slice(8, 10) + '/' + ymd.slice(5, 7);
const hojeIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const addDias = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const inicioSemana = (ymd: string) => { const d = new Date(ymd + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return addDias(ymd, -dow); };
const chaveDe = (dia: string, g: Gran) => (g === 'dia' ? dia : g === 'semana' ? inicioSemana(dia) : dia.slice(0, 7));
const rotuloDe = (k: string, g: Gran) => (g === 'mes' ? k.slice(5, 7) + '/' + k.slice(0, 4) : g === 'semana' ? 'sem ' + fmtDataCurta(k) : fmtDataCurta(k));
const NOME_INST: Record<string, string> = { IND: 'Fábrica (IND)', GYN: 'Escritório (GYN)', BSB: 'Brasília (BSB)', SERV: 'Serviços (SERV)' };
const COR_INST: Record<string, string> = { GYN: '#0d9488', BSB: '#f59e0b', SERV: '#6366f1', IND: '#64748b' };
const TIPOS: { k: Tipo; label: string }[] = [
  { k: 'venda', label: 'Venda' }, { k: 'troca', label: 'Troca' }, { k: 'amostra', label: 'Amostra' }, { k: 'bonificacao', label: 'Bonificação' }, { k: 'outros', label: 'Outros' },
];
const STATUS: Record<Produto['calculo']['status'], { label: string; cls: string }> = {
  ruptura: { label: 'Ruptura', cls: 'bg-red-600 text-white' },
  critico: { label: 'Crítico', cls: 'bg-red-100 text-red-800 border border-red-300' },
  atencao: { label: 'Atenção', cls: 'bg-amber-100 text-amber-800 border border-amber-300' },
  ok: { label: 'OK', cls: 'bg-emerald-100 text-emerald-800 border border-emerald-300' },
  sem_giro: { label: 'Sem giro', cls: 'bg-gray-100 text-gray-600 border border-gray-300' },
};

// ---------------------------------------------------------------------------
export default function ProgramacaoProducao() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const hoje = hojeIso();
  const [de, setDe] = useState(addDias(hoje, -89));
  const [ate, setAte] = useState(hoje);
  const [janela, setJanela] = useState<number>(30);
  const [inst, setInst] = useState<string[]>(['GYN', 'BSB', 'SERV']);
  const [gran, setGran] = useState<Gran>('semana');
  const [busca, setBusca] = useState('');
  const [soAtencao, setSoAtencao] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qtd, setQtd] = useState<Record<string, string>>({});
  const [dataProd, setDataProd] = useState<Record<string, string>>({});
  const [confirmar, setConfirmar] = useState(false);
  const [programando, setProgramando] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);

  const qs = new URLSearchParams({ de, ate, janela: String(janela), instancias: inst.join(',') }).toString();
  const { data, isLoading, isFetching, refetch, error } = useQuery<Payload>({
    queryKey: ['/api/industria/programacao', qs],
    queryFn: () => jfetch('/api/industria/programacao?' + qs),
    staleTime: 60 * 1000,
  });

  // Quantidade sugerida vira o valor inicial do campo editável sempre que o
  // relatório recarrega (o usuário pode ajustar antes de programar).
  useEffect(() => {
    if (!data) return;
    const q: Record<string, string> = {}; const d: Record<string, string> = {};
    for (const p of data.produtos) {
      q[p.productId] = String(p.calculo.sugestaoProduzir || '');
      const lim = p.calculo.dataLimiteProducao;
      d[p.productId] = lim && lim > data.hoje ? lim : data.hoje;
    }
    setQtd(q); setDataProd(d); setSel({});
  }, [data?.geradoEm]);

  const instDisponiveis = data?.instancias.map((i) => i.name) || ['IND', 'GYN', 'BSB', 'SERV'];
  const toggleInst = (n: string) => setInst((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  // --- séries (pivot no cliente: dia / semana / mês) ----------------------
  const serieGeral = useMemo(() => {
    if (!data) return [] as any[];
    const m: Record<string, any> = {};
    for (const s of data.saidas) {
      if (!inst.includes(s.instancia)) continue;
      const k = chaveDe(s.dia, gran);
      const row = (m[k] = m[k] || { k, rotulo: rotuloDe(k, gran), total: 0 });
      row[s.instancia] = (row[s.instancia] || 0) + s.qtd; row.total += s.qtd;
    }
    return Object.values(m).sort((a, b) => String(a.k).localeCompare(String(b.k)));
  }, [data, gran, inst]);

  const periodos = useMemo(() => serieGeral.map((r) => r.k as string), [serieGeral]);
  const pivotProduto = useMemo(() => {
    if (!data) return {} as Record<string, Record<string, number>>;
    const out: Record<string, Record<string, number>> = {};
    for (const s of data.saidas) {
      if (!inst.includes(s.instancia)) continue;
      const k = chaveDe(s.dia, gran);
      (out[s.productId] = out[s.productId] || {})[k] = (out[s.productId]?.[k] || 0) + s.qtd;
    }
    return out;
  }, [data, gran, inst]);

  const produtos = useMemo(() => {
    if (!data) return [] as Produto[];
    const b = busca.trim().toLowerCase();
    return data.produtos.filter((p) => (!b || p.nome.toLowerCase().includes(b) || String(p.codigo || '').toLowerCase().includes(b))
      && (!soAtencao || ['ruptura', 'critico', 'atencao'].includes(p.calculo.status)));
  }, [data, busca, soAtencao]);

  const selecionados = produtos.filter((p) => sel[p.productId] && Number(qtd[p.productId]) > 0);
  const marcarSugeridos = () => {
    const nx: Record<string, boolean> = {};
    for (const p of produtos) if (p.calculo.sugestaoProduzir > 0) nx[p.productId] = true;
    setSel(nx);
  };

  const programar = async () => {
    if (!selecionados.length) return;
    setProgramando(true);
    try {
      const r = await jfetch('/api/industria/programacao/programar', {
        method: 'POST',
        body: JSON.stringify({ itens: selecionados.map((p) => ({ product_id: p.productId, quantity: Number(qtd[p.productId]), production_date: dataProd[p.productId] || undefined, notes: `Programação de produção — sugestão ${p.calculo.sugestaoProduzir} un (cobertura ${p.calculo.coberturaDias ?? '∞'} d)` })) }),
      });
      toast({ title: `${r.criadas?.length || 0} OP(s) planejada(s)`, description: (r.criadas || []).map((c: any) => c.order_number).join(', ') });
      if (r.erros?.length) toast({ title: `${r.erros.length} item(ns) não programado(s)`, variant: 'destructive' });
      setConfirmar(false); setSel({});
      qc.invalidateQueries({ queryKey: ['/api/industria/production-orders'] });
      refetch();
    } catch (e: any) { toast({ title: 'Erro ao programar', description: String(e.message || e), variant: 'destructive' }); }
    finally { setProgramando(false); }
  };

  const exportar = () => {
    if (!data) return;
    const prog = produtos.map((p) => ({
      Produto: p.nome, Código: p.codigo || '', Status: STATUS[p.calculo.status].label,
      'Estoque fábrica (IND)': p.estoque.fabrica, 'Estoque escritório (GYN)': p.estoque.escritorio, 'Estoque BSB': p.estoque.porInstancia.BSB || 0, 'Estoque SERV': p.estoque.porInstancia.SERV || 0, 'Estoque total': p.estoque.total,
      [`Saídas ${janela}d`]: p.saidas.total, 'Média/dia': p.saidas.mediaDia, 'Média/semana': p.saidas.mediaSemana, 'Média/mês': p.saidas.mediaMes, 'Pico semanal': p.saidas.picoSemana,
      'Cobertura (dias)': p.calculo.coberturaDias ?? '', 'Ruptura prevista': p.calculo.dataRuptura || '', 'Estoque mínimo': p.calculo.estoqueMinimo, 'Estoque alvo': p.calculo.estoqueAlvo,
      'Programado (OPs abertas)': p.programado.aberto, 'Sugestão produzir': p.calculo.sugestaoProduzir, 'Fardos': p.calculo.sugestaoFardos ?? '', 'Produzir até': p.calculo.dataLimiteProducao || '',
    }));
    const saidas = produtos.map((p) => { const row: Record<string, any> = { Produto: p.nome }; for (const k of periodos) row[rotuloDe(k, gran)] = Math.round(pivotProduto[p.productId]?.[k] || 0); return row; });
    exportSheetsToExcel([
      { nome: 'Programação', linhas: prog } as any,
      { nome: `Saídas por ${gran}`, linhas: saidas } as any,
    ], `programacao_producao_${hoje}.xlsx`);
  };

  if (error) return <Card><CardContent className="p-6 text-red-600">Erro: {String((error as any).message)}</CardContent></Card>;

  const t = data?.totais;
  const p = data?.parametros;
  const alerta = (t?.porStatus?.ruptura || 0) + (t?.porStatus?.critico || 0) + (t?.porStatus?.atencao || 0);

  return (
    <div className="space-y-4" data-testid="programacao-producao">
      {/* ----- filtros ----- */}
      <Card><CardContent className="p-4 flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs">Instâncias (demanda)</Label>
          <div className="flex gap-1.5 mt-1">
            {instDisponiveis.map((n) => (
              <button key={n} type="button" onClick={() => toggleInst(n)} data-testid={`filtro-inst-${n}`}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border ${inst.includes(n) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 dark:bg-gray-800'}`}>
                {NOME_INST[n] || n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label className="text-xs">Visualizar por</Label>
          <div className="flex gap-1.5 mt-1">
            {(['dia', 'semana', 'mes'] as Gran[]).map((g) => (
              <button key={g} type="button" onClick={() => setGran(g)} data-testid={`gran-${g}`}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border capitalize ${gran === g ? 'bg-gray-900 text-white border-gray-900 dark:bg-white dark:text-gray-900' : 'bg-white text-gray-600 border-gray-300 dark:bg-gray-800'}`}>
                {g === 'mes' ? 'Mês' : g === 'dia' ? 'Diário' : 'Semanal'}
              </button>
            ))}
          </div>
        </div>
        <div><Label className="text-xs">De</Label><Input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="h-8 w-36 mt-1" /></div>
        <div><Label className="text-xs">Até</Label><Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="h-8 w-36 mt-1" /></div>
        <div>
          <Label className="text-xs">Média sobre</Label>
          <select value={janela} onChange={(e) => setJanela(Number(e.target.value))} className="block h-8 mt-1 rounded-md border border-gray-300 bg-white px-2 text-sm dark:bg-gray-800">
            {[15, 30, 60, 90].map((d) => <option key={d} value={d}>{d} dias</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setParamsOpen(true)}><Settings2 className="h-4 w-4 mr-1" /> Lead time</Button>
        <Button variant="outline" size="sm" onClick={exportar} disabled={!data}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</Button>
      </CardContent></Card>

      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-gray-500 p-6"><Loader2 className="h-4 w-4 animate-spin" /> Calculando programação…</div>
      ) : (
        <>
          {/* ----- KPIs ----- */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Kpi icone={<Factory className="h-4 w-4" />} rotulo="Estoque na fábrica (IND)" valor={fmtInt(t!.estoqueFabrica)} sub="garrafas em lotes in_use" />
            <Kpi icone={<Building2 className="h-4 w-4" />} rotulo="Estoque no escritório (GYN)" valor={fmtInt(t!.estoqueEscritorio)} sub="garrafas (em uso + bloqueadas)" />
            <Kpi icone={<Warehouse className="h-4 w-4" />} rotulo="Estoque BSB" valor={fmtInt(t!.estoquePorInstancia.BSB || 0)} sub="garrafas" />
            <Kpi icone={<TrendingDown className="h-4 w-4" />} rotulo={`Saídas últimos ${data.janelaMediaDias} dias`} valor={fmtInt(t!.saidasJanela)} sub={`${fmt1(t!.mediaDia)} garrafas/dia útil (${data.diasUteisJanela} dias úteis) · ${data.instanciasDemanda.join(' + ')}`} />
            <Kpi icone={<AlertTriangle className="h-4 w-4" />} rotulo="Produtos em alerta" valor={String(alerta)} sub={`${t!.porStatus.ruptura || 0} ruptura · ${t!.porStatus.critico || 0} crítico · ${t!.porStatus.atencao || 0} atenção`} destaque={alerta > 0} />
            <Kpi icone={<PlayCircle className="h-4 w-4" />} rotulo="Sugestão de produção" valor={fmtInt(t!.sugestaoProduzir)} sub={`garrafas · ${fmtInt(t!.programado)} já programadas em OP`} />
          </div>

          {/* ----- gráfico de saídas ----- */}
          <Card><CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-sm flex items-center gap-2"><TrendingDown className="h-4 w-4 text-emerald-600" /> Saídas de produto acabado por {gran === 'mes' ? 'mês' : gran} <span className="text-gray-400 font-normal">({fmtData(data.periodo.de)} a {fmtData(data.periodo.ate)})</span></div>
              <div className="text-xs text-gray-500">venda + troca + amostra + bonificação · transferências IND→filial não contam</div>
            </div>
            <div className="h-64 w-full">
              {serieGeral.length === 0 ? <div className="flex h-full items-center justify-center text-sm text-gray-500">Sem saídas no período.</div> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serieGeral} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} strokeOpacity={0.3} />
                    <XAxis dataKey="rotulo" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={serieGeral.length > 24 ? Math.ceil(serieGeral.length / 16) - 1 : 0} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmtInt(v)} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} formatter={(v: any, name: any) => [fmtInt(v), NOME_INST[String(name)] || name]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => NOME_INST[String(v)] || v} />
                    {inst.map((i) => <Bar key={i} dataKey={i} stackId="s" fill={COR_INST[i] || '#94a3b8'} radius={[2, 2, 0, 0]} />)}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent></Card>

          {/* ----- PROGRAMAÇÃO ----- */}
          <Card><CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="font-semibold text-sm flex items-center gap-2"><CalendarClock className="h-4 w-4 text-emerald-600" /> Programação de produção</div>
              <Badge variant="outline" className="text-[11px] font-normal">lead {p!.leadProducaoDias}d produção + {p!.leadTransferenciaDias}d transferência · segurança {p!.segurancaDias}d · horizonte {p!.horizonteDias}d</Badge>
              <div className="flex-1" />
              <Input placeholder="Buscar produto…" value={busca} onChange={(e) => setBusca(e.target.value)} className="h-8 w-48" />
              <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={soAtencao} onCheckedChange={(v) => setSoAtencao(!!v)} /> só em alerta</label>
              <Button variant="outline" size="sm" onClick={marcarSugeridos}>Marcar sugeridos</Button>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={!selecionados.length} onClick={() => setConfirmar(true)} data-testid="btn-programar">
                <PlayCircle className="h-4 w-4 mr-1" /> Programar produção ({selecionados.length})
              </Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow className="text-xs">
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Fábrica</TableHead>
                  <TableHead className="text-right">Escritório</TableHead>
                  <TableHead className="text-right">BSB</TableHead>
                  <TableHead className="text-right">SERV</TableHead>
                  <TableHead className="text-right">Média/dia útil</TableHead>
                  <TableHead className="text-right">Média/sem</TableHead>
                  <TableHead className="text-right">Cobertura (d.u.)</TableHead>
                  <TableHead>Ruptura prev.</TableHead>
                  <TableHead className="text-right">Est. mínimo</TableHead>
                  <TableHead className="text-right">Programado</TableHead>
                  <TableHead className="text-right">Sugestão</TableHead>
                  <TableHead>Produzir até</TableHead>
                  <TableHead className="w-28">Qtd a produzir</TableHead>
                  <TableHead className="w-36">Data produção</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {produtos.length === 0 && <TableRow><TableCell colSpan={17} className="text-center text-gray-500 py-6">Nenhum produto.</TableCell></TableRow>}
                  {produtos.map((pr) => {
                    const st = STATUS[pr.calculo.status];
                    const cob = pr.calculo.coberturaDias;
                    return (
                      <TableRow key={pr.productId} className={pr.calculo.status === 'ruptura' || pr.calculo.status === 'critico' ? 'bg-red-50/60 dark:bg-red-950/20' : pr.calculo.status === 'atencao' ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''} data-testid={`linha-prog-${pr.productId}`}>
                        <TableCell><Checkbox checked={!!sel[pr.productId]} onCheckedChange={(v) => setSel((s) => ({ ...s, [pr.productId]: !!v }))} /></TableCell>
                        <TableCell className="text-sm">
                          <div className="font-medium">{pr.nome}</div>
                          <div className="text-[11px] text-gray-500">{pr.codigo || ''}{pr.fardoUnidades ? ` · fardo ${pr.fardoUnidades} un` : ''}{pr.estoque.lotesFabrica ? ` · ${pr.estoque.lotesFabrica} lote(s) na IND` : ''}</div>
                        </TableCell>
                        <TableCell><span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${st.cls}`}>{st.label}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{fmtInt(pr.estoque.fabrica)}</TableCell>
                        <TableCell className="text-right tabular-nums" title={pr.estoque.bloqueadoPorInstancia?.GYN ? `inclui ${fmtInt(pr.estoque.bloqueadoPorInstancia.GYN)} bloqueadas (NF de transferência ainda não promovida)` : ''}>
                          {fmtInt(pr.estoque.escritorio)}{pr.estoque.bloqueadoPorInstancia?.GYN ? <span className="text-[10px] text-gray-400 ml-0.5">*</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums" title={pr.estoque.bloqueadoPorInstancia?.BSB ? `inclui ${fmtInt(pr.estoque.bloqueadoPorInstancia.BSB)} bloqueadas` : ''}>
                          {fmtInt(pr.estoque.porInstancia.BSB || 0)}{pr.estoque.bloqueadoPorInstancia?.BSB ? <span className="text-[10px] text-gray-400 ml-0.5">*</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums" title={pr.estoque.bloqueadoPorInstancia?.SERV ? `inclui ${fmtInt(pr.estoque.bloqueadoPorInstancia.SERV)} bloqueadas` : ''}>
                          {fmtInt(pr.estoque.porInstancia.SERV || 0)}{pr.estoque.bloqueadoPorInstancia?.SERV ? <span className="text-[10px] text-gray-400 ml-0.5">*</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt1(pr.saidas.mediaDia)}</TableCell>
                        <TableCell className="text-right tabular-nums" title={`média/dia útil × 5 · pico semanal ${fmtInt(pr.saidas.picoSemana)} · ${pr.saidas.diasComSaida} dias com saída`}>{fmt1(pr.saidas.mediaSemana)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold" title={pr.calculo.coberturaComProgramado != null ? `com OPs abertas: ${fmt1(pr.calculo.coberturaComProgramado)} d` : ''}>
                          {cob == null ? '∞' : `${fmt1(cob)} d`}
                        </TableCell>
                        <TableCell className="text-xs">{fmtData(pr.calculo.dataRuptura)}</TableCell>
                        <TableCell className="text-right tabular-nums" title={`alvo ${fmtInt(pr.calculo.estoqueAlvo)} un (${pr.calculo.diasAlvo} dias de venda)`}>{fmtInt(pr.calculo.estoqueMinimo)}</TableCell>
                        <TableCell className="text-right tabular-nums" title={pr.programado.ops.map((o) => `${o.orderNumber} · ${fmtInt(o.quantidade)} · ${o.status}${o.productionDate ? ' · ' + fmtData(o.productionDate) : ''}`).join('\n')}>
                          {pr.programado.aberto ? <span className="underline decoration-dotted">{fmtInt(pr.programado.aberto)}</span> : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold text-emerald-700">
                          {pr.calculo.sugestaoProduzir ? fmtInt(pr.calculo.sugestaoProduzir) : '—'}
                          {pr.calculo.sugestaoFardos ? <div className="text-[11px] font-normal text-gray-500">{pr.calculo.sugestaoFardos} fardos</div> : null}
                        </TableCell>
                        <TableCell className={`text-xs ${pr.calculo.dataLimiteProducao && pr.calculo.dataLimiteProducao <= data.hoje ? 'text-red-600 font-semibold' : ''}`}>{fmtData(pr.calculo.dataLimiteProducao)}</TableCell>
                        <TableCell><Input type="number" min={0} step={pr.fardoUnidades || 1} value={qtd[pr.productId] ?? ''} onChange={(e) => setQtd((q) => ({ ...q, [pr.productId]: e.target.value }))} className="h-8 text-right" /></TableCell>
                        <TableCell><Input type="date" value={dataProd[pr.productId] ?? data.hoje} onChange={(e) => setDataProd((d) => ({ ...d, [pr.productId]: e.target.value }))} className="h-8" /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3 text-[11px] text-gray-500 flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <b>Média/dia útil</b> = saídas dos últimos {data.janelaMediaDias} dias ÷ {data.diasUteisJanela} dias úteis (seg–sex, sem feriado nacional).
                {' '}<b>Cobertura</b> = (estoque fábrica + estoque das instâncias selecionadas) ÷ média/dia útil, em dias úteis — ruptura e "produzir até" pulam fins de semana e feriados.
                {' '}<b>Estoque mínimo</b> = média/dia × (lead {p!.leadProducaoDias + p!.leadTransferenciaDias}d + segurança {p!.segurancaDias}d).
                {' '}<b>Sugestão</b> = média/dia × (lead + segurança + horizonte {p!.horizonteDias}d) − estoque − OPs abertas, arredondada em fardos.
                {' '}<b>Produzir até</b> = data da ruptura − lead − segurança. Status: crítico quando a cobertura (com OPs abertas) é menor que o lead; atenção quando é menor que lead + segurança.
              </div>
            </div>
          </CardContent></Card>

          {/* ----- SAÍDAS POR PRODUTO × PERÍODO ----- */}
          <Card><CardContent className="p-4">
            <div className="font-semibold text-sm mb-2 flex items-center gap-2"><TrendingDown className="h-4 w-4 text-emerald-600" /> Saídas por produto × {gran === 'mes' ? 'mês' : gran} <span className="text-gray-400 font-normal">· {inst.map((i) => NOME_INST[i] || i).join(' + ')}</span></div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow className="text-xs">
                  <TableHead className="sticky left-0 bg-white dark:bg-gray-900 z-10">Produto</TableHead>
                  {periodos.map((k) => <TableHead key={k} className="text-right whitespace-nowrap">{rotuloDe(k, gran)}</TableHead>)}
                  <TableHead className="text-right font-bold">Total</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {produtos.map((pr) => {
                    const row = pivotProduto[pr.productId] || {};
                    const tot = periodos.reduce((s, k) => s + (row[k] || 0), 0);
                    if (!tot) return null;
                    return (
                      <TableRow key={pr.productId} className="text-xs">
                        <TableCell className="sticky left-0 bg-white dark:bg-gray-900 z-10 font-medium whitespace-nowrap">{pr.nome}</TableCell>
                        {periodos.map((k) => <TableCell key={k} className="text-right tabular-nums">{row[k] ? fmtInt(row[k]) : <span className="text-gray-300">·</span>}</TableCell>)}
                        <TableCell className="text-right tabular-nums font-bold">{fmtInt(tot)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="text-xs font-bold bg-gray-50 dark:bg-gray-800">
                    <TableCell className="sticky left-0 bg-gray-50 dark:bg-gray-800 z-10">Total</TableCell>
                    {serieGeral.map((r) => <TableCell key={r.k} className="text-right tabular-nums">{fmtInt(r.total)}</TableCell>)}
                    <TableCell className="text-right tabular-nums">{fmtInt(serieGeral.reduce((s, r) => s + r.total, 0))}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent></Card>
        </>
      )}

      {/* ----- confirmação ----- */}
      <Dialog open={confirmar} onOpenChange={setConfirmar}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Programar produção</DialogTitle></DialogHeader>
          <div className="text-sm text-gray-600 mb-2">Serão criadas {selecionados.length} ordem(ns) de produção com status <b>planejada</b> na IND. Elas aparecem na aba Ordens de Produção para preenchimento de insumos e finalização.</div>
          <div className="max-h-72 overflow-y-auto border rounded">
            <Table><TableBody>
              {selecionados.map((pr) => (
                <TableRow key={pr.productId} className="text-sm"><TableCell>{pr.nome}</TableCell><TableCell className="text-right tabular-nums font-semibold">{fmtInt(qtd[pr.productId])} un</TableCell><TableCell className="text-xs text-gray-500">{fmtData(dataProd[pr.productId] || null)}</TableCell></TableRow>
              ))}
            </TableBody></Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmar(false)} disabled={programando}>Cancelar</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={programar} disabled={programando} data-testid="btn-confirmar-programar">
              {programando ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />} Criar {selecionados.length} OP(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ParametrosDialog open={paramsOpen} onClose={() => setParamsOpen(false)} atual={data?.parametros} onSaved={() => { refetch(); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
function Kpi({ icone, rotulo, valor, sub, destaque }: { icone: any; rotulo: string; valor: string; sub?: string; destaque?: boolean }) {
  return (
    <Card className={destaque ? 'border-red-300' : ''}><CardContent className="p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-gray-500 uppercase tracking-wide">{icone}{rotulo}</div>
      <div className={`text-2xl font-bold mt-1 ${destaque ? 'text-red-600' : ''}`}>{valor}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </CardContent></Card>
  );
}

function ParametrosDialog({ open, onClose, atual, onSaved }: { open: boolean; onClose: () => void; atual?: Parametros; onSaved: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState<Parametros | null>(null);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { if (open && atual) setF({ ...atual }); }, [open, atual]);
  if (!f) return null;
  const campo = (k: keyof Parametros, label: string, hint: string) => (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input type="number" min={0} value={String((f as any)[k])} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} className="h-8 mt-1" />
      <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>
    </div>
  );
  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await fetch('/api/industria/programacao/parametros', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `Falha (${r.status})`);
      toast({ title: 'Parâmetros salvos' }); onSaved(); onClose();
    } catch (e: any) { toast({ title: 'Erro ao salvar', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSalvando(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Lead time e cobertura (em dias úteis)</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {campo('leadProducaoDias', 'Lead de produção (dias úteis)', 'da abertura da OP até o lote disponível na IND')}
          {campo('leadTransferenciaDias', 'Lead de transferência (dias úteis)', 'da IND até a filial (NF + transporte)')}
          {campo('segurancaDias', 'Estoque de segurança (dias úteis)', 'dias de venda mantidos como colchão')}
          {campo('horizonteDias', 'Horizonte de produção (dias úteis)', 'dias de venda que cada programação deve cobrir')}
          {campo('janelaMediaDias', 'Janela da média (dias corridos)', 'a média divide pelos dias úteis da janela')}
          {campo('loteMinimoUnidades', 'Lote mínimo (unidades)', '0 = sem lote mínimo')}
        </div>
        <label className="flex items-center gap-2 text-sm mt-2"><Checkbox checked={f.arredondarFardo} onCheckedChange={(v) => setF({ ...f, arredondarFardo: !!v })} /> Arredondar a sugestão para fardos fechados</label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={salvando}>Cancelar</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={salvar} disabled={salvando}>{salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
