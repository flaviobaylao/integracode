import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Home, Play, Save, Trash2, FileText, Download, Plus, X, GripVertical,
  Database, Columns, BarChart3, Filter, SortAsc, SortDesc, ChevronRight,
  Loader2, BookOpen, ArrowUpDown, Settings2, Eye, Copy, CalendarDays
} from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';
import type { SavedReport } from '@shared/schema';

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'currency';
  category: string;
  dbColumn?: string;
}

interface DataSourceDef {
  key: string;
  label: string;
  description: string;
  fields: FieldDef[];
}

interface AggConfig {
  field: string;
  fn: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'count_distinct';
}

interface FilterConfig {
  field: string;
  operator: string;
  value: string;
}

interface OrderConfig {
  field: string;
  direction: 'asc' | 'desc';
}

interface ReportResult {
  rows: Record<string, any>[];
  totalRows: number;
  columns: string[];
}

const AGG_LABELS: Record<string, string> = {
  sum: 'Soma', count: 'Contagem', avg: 'Média',
  min: 'Mínimo', max: 'Máximo', count_distinct: 'Contagem Distinta'
};

const OPERATOR_LABELS: Record<string, string> = {
  eq: 'Igual a', neq: 'Diferente de', gt: 'Maior que', gte: 'Maior ou igual',
  lt: 'Menor que', lte: 'Menor ou igual', like: 'Contém',
  is_null: 'É vazio', is_not_null: 'Não é vazio'
};

const DS_ICONS: Record<string, string> = {
  customers: '👥', products: '📦', sales_cards: '💰', billings: '📄',
  overdue_debts: '⚠️', sales_goals: '🎯', delivery_routes: '🚚', users: '👤'
};

const CHART_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0d9488'];

function ReportChart({ mode, result, chartX, chartY, setChartX, setChartY, labelOf, typeOf }: any) {
  const cols: string[] = result.columns;
  const numericCols = cols.filter((c: string) => { const t = typeOf(c); return t === 'currency' || t === 'number'; });
  const xKey = chartX && cols.includes(chartX) ? chartX : (cols.find((c: string) => !numericCols.includes(c)) || cols[0]);
  const yKey = chartY && cols.includes(chartY) ? chartY : (numericCols[0] || cols[cols.length - 1]);
  const data = result.rows.slice(0, 50).map((r: any) => ({ name: String(r[xKey] ?? '—'), value: Number(r[yKey]) || 0 }));
  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Eixo X:</span>
        <Select value={xKey} onValueChange={setChartX}>
          <SelectTrigger className="h-7 text-xs w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{cols.map((c: string) => (<SelectItem key={c} value={c}>{labelOf(c)}</SelectItem>))}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">Valor:</span>
        <Select value={yKey} onValueChange={setChartY}>
          <SelectTrigger className="h-7 text-xs w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{cols.map((c: string) => (<SelectItem key={c} value={c}>{labelOf(c)}</SelectItem>))}</SelectContent>
        </Select>
        {result.rows.length > 50 && (<span className="text-xs text-muted-foreground">(primeiros 50 de {result.rows.length.toLocaleString('pt-BR')})</span>)}
      </div>
      <div style={{ width: '100%', height: 400 }}>
        <ResponsiveContainer>
          {mode === 'barras' ? (
            <BarChart data={data} margin={{ top: 8, right: 16, bottom: 60, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-40} textAnchor="end" interval={0} height={80} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <RTooltip />
              <Bar dataKey="value" fill="#2563eb" />
            </BarChart>
          ) : mode === 'linha' ? (
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 60, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-40} textAnchor="end" interval={0} height={80} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <RTooltip />
              <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} />
            </LineChart>
          ) : (
            <PieChart>
              <RTooltip />
              <Legend />
              <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={140}>
                {data.map((_: any, i: number) => (<Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ReportPivot({ result, pivotCol, setPivotCol, labelOf, typeOf }: any) {
  const cols: string[] = result.columns;
  const numericCols = cols.filter((c: string) => { const t = typeOf(c); return t === 'currency' || t === 'number'; });
  const dimCols = cols.filter((c: string) => !numericCols.includes(c));
  const valueKey = numericCols[0];
  if (!valueKey || dimCols.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Para a Tabela Dinâmica, agrupe por 2+ campos e adicione um Totalizador (ex.: Soma de um valor) antes de executar.</div>;
  }
  const colKey = pivotCol && dimCols.includes(pivotCol) ? pivotCol : dimCols[dimCols.length - 1];
  const rowKeys = dimCols.filter((c: string) => c !== colKey);
  const valType = typeOf(valueKey);
  const fmtVal = (v: number) => valType === 'currency' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : v.toLocaleString('pt-BR');
  const colVals = Array.from(new Set(result.rows.map((r: any) => String(r[colKey] ?? '—')))).sort();
  const rowMap = new Map<string, any>();
  for (const r of result.rows) {
    const label = rowKeys.map((k: string) => String(r[k] ?? '—'));
    const rk = label.join(' | ') || 'Total';
    if (!rowMap.has(rk)) rowMap.set(rk, { label, cells: {} as Record<string, number> });
    const cv = String(r[colKey] ?? '—');
    rowMap.get(rk).cells[cv] = (rowMap.get(rk).cells[cv] || 0) + (Number(r[valueKey]) || 0);
  }
  const rowsArr = Array.from(rowMap.values());
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Coluna (pivô):</span>
        <Select value={colKey} onValueChange={setPivotCol}>
          <SelectTrigger className="h-7 text-xs w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{dimCols.map((c: string) => (<SelectItem key={c} value={c}>{labelOf(c)}</SelectItem>))}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">Valores: {labelOf(valueKey)} (Soma)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800">
              {rowKeys.map((k: string) => (<th key={k} className="text-left p-2 font-semibold whitespace-nowrap border">{labelOf(k)}</th>))}
              {colVals.map((cv: string) => (<th key={cv} className="text-right p-2 font-semibold whitespace-nowrap border">{cv}</th>))}
              <th className="text-right p-2 font-semibold whitespace-nowrap border">Total</th>
            </tr>
          </thead>
          <tbody>
            {rowsArr.map((row: any, ri: number) => {
              const rowTotal = colVals.reduce((acc: number, cv: string) => acc + (row.cells[cv] || 0), 0);
              return (
                <tr key={ri} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  {rowKeys.length === 0 && <td className="p-2 whitespace-nowrap border">Total</td>}
                  {row.label.map((lv: string, li: number) => (<td key={li} className="p-2 whitespace-nowrap border">{lv}</td>))}
                  {colVals.map((cv: string) => (<td key={cv} className="p-2 text-right whitespace-nowrap border">{row.cells[cv] !== undefined ? fmtVal(row.cells[cv]) : ''}</td>))}
                  <td className="p-2 text-right whitespace-nowrap border font-semibold">{fmtVal(rowTotal)}</td>
                </tr>
              );
            })}
            <tr className="bg-blue-50 dark:bg-blue-900/20 font-semibold border-t-2">
              <td className="p-2 border" colSpan={Math.max(1, rowKeys.length)}>Total</td>
              {colVals.map((cv: string) => { const ct = rowsArr.reduce((acc: number, r: any) => acc + (r.cells[cv] || 0), 0); return (<td key={cv} className="p-2 text-right border">{fmtVal(ct)}</td>); })}
              <td className="p-2 text-right border">{fmtVal(rowsArr.reduce((acc: number, r: any) => acc + colVals.reduce((a2: number, cv: string) => a2 + (r.cells[cv] || 0), 0), 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCellValue(value: any, type: string): string {
  if (value === null || value === undefined) return '—';
  if (type === 'currency') {
    const num = parseFloat(String(value));
    return isNaN(num) ? String(value) : num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  if (type === 'number') {
    const num = parseFloat(String(value));
    return isNaN(num) ? String(value) : num.toLocaleString('pt-BR');
  }
  if (type === 'date') {
    try {
      const d = new Date(value);
      return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('pt-BR');
    } catch { return String(value); }
  }
  if (type === 'boolean') return value ? 'Sim' : 'Não';
  return String(value);
}

function FieldChip({ label, onRemove, icon }: { label: string; onRemove?: () => void; icon?: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-1 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-md px-2 py-1 text-xs border border-blue-200 dark:border-blue-700">
      {icon}
      <span className="font-medium truncate max-w-[140px]">{label}</span>
      {onRemove && (
        <button onClick={onRemove} className="ml-1 hover:text-red-500">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export default function Reports() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'builder' | 'saved'>('builder');
  const [dataSource, setDataSource] = useState('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [aggregations, setAggregations] = useState<AggConfig[]>([]);
  const [filters, setFilters] = useState<FilterConfig[]>([]);
  const [orderBy, setOrderBy] = useState<OrderConfig[]>([]);
  const [limit, setLimit] = useState(5000);
  const [periodEnabled, setPeriodEnabled] = useState(false);
  const [periodField, setPeriodField] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [viewMode, setViewMode] = useState<'tabela' | 'pivo' | 'barras' | 'pizza' | 'linha'>('tabela');
  const [chartX, setChartX] = useState('');
  const [chartY, setChartY] = useState('');
  const [pivotCol, setPivotCol] = useState('');
  const [result, setResult] = useState<ReportResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');

  const { data: dataSources } = useQuery<DataSourceDef[]>({
    queryKey: ['/api/reports/data-sources'],
  });

  const { data: savedReports } = useQuery<SavedReport[]>({
    queryKey: ['/api/reports/saved'],
  });

  const currentSource = dataSources?.find(ds => ds.key === dataSource);
  const fieldsMap = useMemo(() => {
    const map = new Map<string, FieldDef>();
    currentSource?.fields.forEach(f => map.set(f.key, f));
    return map;
  }, [currentSource]);

  const fieldsByCategory = useMemo(() => {
    if (!currentSource) return {};
    const cats: Record<string, FieldDef[]> = {};
    currentSource.fields.forEach(f => {
      if (!cats[f.category]) cats[f.category] = [];
      cats[f.category].push(f);
    });
    return cats;
  }, [currentSource]);

  const handleSelectDataSource = (key: string) => {
    setDataSource(key);
    setSelectedColumns([]);
    setGroupBy([]);
    setAggregations([]);
    setFilters([]);
    setOrderBy([]);
    setPeriodEnabled(false);
    setPeriodField('');
    setPeriodStart('');
    setPeriodEnd('');
    setResult(null);
  };

  const toggleColumn = (key: string) => {
    setSelectedColumns(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const toggleGroupBy = (key: string) => {
    setGroupBy(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const addAggregation = () => {
    const numericFields = currentSource?.fields.filter(f => f.type === 'currency' || f.type === 'number') || [];
    const firstField = numericFields[0]?.key || currentSource?.fields[0]?.key || '';
    setAggregations(prev => [...prev, { field: firstField, fn: 'sum' }]);
  };

  const updateAggregation = (idx: number, partial: Partial<AggConfig>) => {
    setAggregations(prev => prev.map((a, i) => i === idx ? { ...a, ...partial } : a));
  };

  const removeAggregation = (idx: number) => {
    setAggregations(prev => prev.filter((_, i) => i !== idx));
  };

  const addFilter = () => {
    const firstField = currentSource?.fields[0]?.key || '';
    setFilters(prev => [...prev, { field: firstField, operator: 'eq', value: '' }]);
  };

  const updateFilter = (idx: number, partial: Partial<FilterConfig>) => {
    setFilters(prev => prev.map((f, i) => i === idx ? { ...f, ...partial } : f));
  };

  const removeFilter = (idx: number) => {
    setFilters(prev => prev.filter((_, i) => i !== idx));
  };

  const applyPeriodPreset = (preset: string) => {
    const today = new Date();
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let start = new Date(today);
    let end = new Date(today);
    if (preset === 'semana') { start.setDate(today.getDate() - 6); }
    else if (preset === 'mes') { start = new Date(today.getFullYear(), today.getMonth(), 1); end = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (preset === 'mesant') { start = new Date(today.getFullYear(), today.getMonth() - 1, 1); end = new Date(today.getFullYear(), today.getMonth(), 0); }
    else if (preset === 'trimestre') { start = new Date(today.getFullYear(), today.getMonth() - 2, 1); end = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (preset === 'ano') { start = new Date(today.getFullYear(), 0, 1); end = new Date(today.getFullYear(), 11, 31); }
    setPeriodStart(fmt(start));
    setPeriodEnd(fmt(end));
    setPeriodEnabled(true);
  };

  const addOrderBy = () => {
    const firstField = currentSource?.fields[0]?.key || '';
    setOrderBy(prev => [...prev, { field: firstField, direction: 'asc' }]);
  };

  const updateOrderBy = (idx: number, partial: Partial<OrderConfig>) => {
    setOrderBy(prev => prev.map((o, i) => i === idx ? { ...o, ...partial } : o));
  };

  const removeOrderBy = (idx: number) => {
    setOrderBy(prev => prev.filter((_, i) => i !== idx));
  };

  const executeReportQuery = async () => {
    if (!dataSource) {
      toast({ title: 'Selecione uma fonte de dados', variant: 'destructive' });
      return;
    }
    setIsExecuting(true);
    try {
      const effFilters = filters.filter(f => f.operator === 'is_null' || f.operator === 'is_not_null' || f.value);
      if (periodEnabled && periodField) {
        if (periodStart) effFilters.push({ field: periodField, operator: 'gte', value: periodStart });
        if (periodEnd) effFilters.push({ field: periodField, operator: 'lte', value: periodEnd });
      }
      const config = {
        dataSource,
        columns: selectedColumns,
        groupBy: groupBy.length > 0 ? groupBy : undefined,
        aggregations: aggregations.length > 0 ? aggregations : undefined,
        filters: effFilters.length > 0 ? effFilters : undefined,
        orderBy: orderBy.length > 0 ? orderBy : undefined,
        limit,
      };
      const res = await apiRequest('POST', '/api/reports/execute', config);
      const data = res;
      setResult(data);
      toast({ title: `${data.totalRows.toLocaleString('pt-BR')} registros encontrados` });
    } catch (err: any) {
      toast({ title: 'Erro ao executar relatório', description: err.message, variant: 'destructive' });
    } finally {
      setIsExecuting(false);
    }
  };

  const saveReport = async () => {
    if (!saveName || !dataSource) return;
    try {
      await apiRequest('POST', '/api/reports/saved', {
        name: saveName,
        description: saveDescription,
        dataSource,
        config: { columns: selectedColumns, groupBy, aggregations, filters, orderBy, limit, period: { enabled: periodEnabled, field: periodField, start: periodStart, end: periodEnd } },
        isPublic: true,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/reports/saved'] });
      setSaveDialogOpen(false);
      setSaveName('');
      setSaveDescription('');
      toast({ title: 'Relatório salvo com sucesso' });
    } catch (err: any) {
      toast({ title: 'Erro ao salvar', description: err.message, variant: 'destructive' });
    }
  };

  const loadSavedReport = (report: SavedReport) => {
    const config = report.config as any;
    setDataSource(report.dataSource);
    setSelectedColumns(config.columns || []);
    setGroupBy(config.groupBy || []);
    setAggregations(config.aggregations || []);
    setFilters(config.filters || []);
    setOrderBy(config.orderBy || []);
    setLimit(config.limit || 5000);
    const pp = config.period || {};
    setPeriodEnabled(!!pp.enabled);
    setPeriodField(pp.field || '');
    setPeriodStart(pp.start || '');
    setPeriodEnd(pp.end || '');
    setResult(null);
    setActiveTab('builder');
    toast({ title: `Relatório "${report.name}" carregado` });
  };

  const deleteSavedMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest('DELETE', `/api/reports/saved/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/reports/saved'] });
      toast({ title: 'Relatório excluído' });
    },
  });

  const exportCSV = () => {
    if (!result || result.rows.length === 0) return;
    const headers = result.columns;
    const labelMap = new Map<string, string>();
    currentSource?.fields.forEach(f => labelMap.set(f.key, f.label));
    aggregations.forEach(a => {
      const fLabel = fieldsMap.get(a.field)?.label || a.field;
      labelMap.set(`${a.fn}_${a.field}`, `${AGG_LABELS[a.fn]} ${fLabel}`);
    });

    const headerLabels = headers.map(h => labelMap.get(h) || h);
    const csvRows = [headerLabels.join(';')];
    for (const row of result.rows) {
      csvRows.push(headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        return String(val).replace(/;/g, ',');
      }).join(';'));
    }
    const blob = new Blob(['\ufeff' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio_${dataSource}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getColumnLabel = (colKey: string): string => {
    const field = fieldsMap.get(colKey);
    if (field) return field.label;
    for (const a of aggregations) {
      if (`${a.fn}_${a.field}` === colKey) {
        const fLabel = fieldsMap.get(a.field)?.label || a.field;
        return `${AGG_LABELS[a.fn]} ${fLabel}`;
      }
    }
    return colKey;
  };

  const getColumnType = (colKey: string): string => {
    const field = fieldsMap.get(colKey);
    if (field) return field.type;
    for (const a of aggregations) {
      if (`${a.fn}_${a.field}` === colKey) {
        if (a.fn === 'count' || a.fn === 'count_distinct') return 'number';
        return fieldsMap.get(a.field)?.type || 'number';
      }
    }
    return 'text';
  };

  const totals = useMemo(() => {
    if (!result || result.rows.length === 0) return null;
    const numericCols = result.columns.filter(c => {
      const t = getColumnType(c);
      return t === 'currency' || t === 'number';
    });
    if (numericCols.length === 0) return null;
    const sums: Record<string, number> = {};
    numericCols.forEach(c => { sums[c] = 0; });
    for (const row of result.rows) {
      numericCols.forEach(c => {
        const v = parseFloat(String(row[c] || 0));
        if (!isNaN(v)) sums[c] += v;
      });
    }
    return sums;
  }, [result]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Button variant="outline" size="sm" onClick={() => window.location.href = '/'} className="mb-2">
            <Home className="h-4 w-4 mr-2" />Voltar ao Dashboard
          </Button>
          <h1 className="text-2xl md:text-3xl font-bold">Relatórios Dinâmicos</h1>
          <p className="text-sm text-muted-foreground">Construa relatórios personalizados cruzando qualquer dado do sistema</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList>
          <TabsTrigger value="builder" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />Construtor
          </TabsTrigger>
          <TabsTrigger value="saved" className="flex items-center gap-2">
            <BookOpen className="h-4 w-4" />Relatórios Salvos
            {savedReports && savedReports.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">{savedReports.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="saved" className="mt-4">
          {!savedReports?.length ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <BookOpen className="h-12 w-12 mb-3 opacity-40" />
                <p className="font-medium">Nenhum relatório salvo</p>
                <p className="text-sm">Configure e salve seus relatórios mais utilizados</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {savedReports.map(report => (
                <Card key={report.id} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => loadSavedReport(report)}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-base">{report.name}</CardTitle>
                        <p className="text-xs text-muted-foreground mt-1">{report.description || 'Sem descrição'}</p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {DS_ICONS[report.dataSource] || '📊'} {dataSources?.find(d => d.key === report.dataSource)?.label || report.dataSource}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {report.createdAt ? new Date(report.createdAt).toLocaleDateString('pt-BR') : ''}
                      </span>
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); loadSavedReport(report); }}>
                          <Eye className="h-3 w-3 mr-1" />Abrir
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-red-600" onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('Excluir este relatório?')) deleteSavedMutation.mutate(report.id);
                        }}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="builder" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-4 xl:col-span-3 space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Database className="h-4 w-4 text-blue-500" />
                    Fonte de Dados
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {dataSources?.map(ds => (
                    <button
                      key={ds.key}
                      onClick={() => handleSelectDataSource(ds.key)}
                      className={`w-full text-left p-2.5 rounded-lg border transition-all text-sm ${
                        dataSource === ds.key
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span>{DS_ICONS[ds.key] || '📊'}</span>
                        <div>
                          <div className="font-medium">{ds.label}</div>
                          <div className="text-xs text-muted-foreground">{ds.description}</div>
                        </div>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {currentSource && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Columns className="h-4 w-4 text-green-500" />
                      Campos Disponíveis
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">Selecione colunas para o relatório</p>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="max-h-[400px]">
                      <div className="space-y-3">
                        {Object.entries(fieldsByCategory).map(([category, fields]) => (
                          <div key={category}>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{category}</p>
                            <div className="space-y-0.5">
                              {fields.map(field => {
                                const isSelected = selectedColumns.includes(field.key);
                                const isGrouped = groupBy.includes(field.key);
                                return (
                                  <div key={field.key} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800">
                                    <Checkbox
                                      checked={isSelected}
                                      onCheckedChange={() => toggleColumn(field.key)}
                                      className="h-3.5 w-3.5"
                                    />
                                    <span className="text-xs flex-1 truncate">{field.label}</span>
                                    <div className="flex gap-0.5">
                                      {(field.type === 'text' || field.type === 'date' || field.type === 'boolean') && (
                                        <button
                                          onClick={() => toggleGroupBy(field.key)}
                                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                            isGrouped
                                              ? 'bg-orange-100 text-orange-700 border-orange-300'
                                              : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-orange-50 hover:text-orange-600'
                                          }`}
                                          title="Agrupar por este campo"
                                        >
                                          G
                                        </button>
                                      )}
                                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                                        {field.type === 'currency' ? 'R$' : field.type === 'number' ? '#' : field.type === 'date' ? '📅' : field.type === 'boolean' ? '✓' : 'Aa'}
                                      </Badge>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="lg:col-span-8 xl:col-span-9 space-y-4">
              {!dataSource ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                    <BarChart3 className="h-16 w-16 mb-4 opacity-30" />
                    <p className="text-lg font-medium">Selecione uma fonte de dados</p>
                    <p className="text-sm">Escolha a fonte de dados à esquerda para começar a construir seu relatório</p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 items-center">
                    <div className="flex flex-wrap gap-1 flex-1">
                      {selectedColumns.length > 0 && selectedColumns.map(key => (
                        <FieldChip key={key} label={fieldsMap.get(key)?.label || key} onRemove={() => toggleColumn(key)} icon={<Columns className="h-3 w-3" />} />
                      ))}
                      {groupBy.length > 0 && groupBy.map(key => (
                        <FieldChip key={`g-${key}`} label={`Agrupar: ${fieldsMap.get(key)?.label || key}`} onRemove={() => toggleGroupBy(key)} icon={<GripVertical className="h-3 w-3 text-orange-500" />} />
                      ))}
                      {aggregations.map((a, i) => (
                        <FieldChip key={`a-${i}`} label={`${AGG_LABELS[a.fn]}: ${fieldsMap.get(a.field)?.label || a.field}`} onRemove={() => removeAggregation(i)} icon={<BarChart3 className="h-3 w-3 text-purple-500" />} />
                      ))}
                      {selectedColumns.length === 0 && groupBy.length === 0 && aggregations.length === 0 && (
                        <span className="text-xs text-muted-foreground italic">Todos os campos serão incluídos</span>
                      )}
                    </div>
                  </div>

                  <Card>
                    <CardHeader className="p-3 pb-2">
                      <CardTitle className="text-xs flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 text-blue-500" />
                        <Checkbox checked={periodEnabled} onCheckedChange={(v) => { const on = !!v; setPeriodEnabled(on); if (on && !periodField) { const df = currentSource?.fields.find(f => f.type === 'date'); if (df) setPeriodField(df.key); } }} />
                        Período
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 pt-0">
                      {(() => {
                        const dateFields = currentSource?.fields.filter(f => f.type === 'date') || [];
                        if (dateFields.length === 0) return <p className="text-xs text-muted-foreground">Esta fonte não tem campo de data.</p>;
                        return (
                          <div className="flex flex-wrap items-center gap-2">
                            <Select value={periodField} onValueChange={setPeriodField}>
                              <SelectTrigger className="h-7 text-xs w-44"><SelectValue placeholder="Campo de data" /></SelectTrigger>
                              <SelectContent>
                                {dateFields.map(f => (<SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>))}
                              </SelectContent>
                            </Select>
                            <Input type="date" className="h-7 text-xs w-36" value={periodStart} onChange={e => { setPeriodStart(e.target.value); setPeriodEnabled(true); }} />
                            <span className="text-xs text-muted-foreground">até</span>
                            <Input type="date" className="h-7 text-xs w-36" value={periodEnd} onChange={e => { setPeriodEnd(e.target.value); setPeriodEnabled(true); }} />
                            <div className="flex flex-wrap gap-1">
                              {([['hoje', 'Hoje'], ['semana', 'Semana'], ['mes', 'Mês'], ['mesant', 'Mês Ant.'], ['trimestre', 'Trimestre'], ['ano', 'Ano']] as [string, string][]).map(([pk, pl]) => (
                                <Button key={pk} size="sm" variant="outline" className="h-7 text-xs px-2" onClick={() => { if (!periodField) { const df = currentSource?.fields.find(f => f.type === 'date'); if (df) setPeriodField(df.key); } applyPeriodPreset(pk); }}>{pl}</Button>
                              ))}
                              {periodEnabled && (<Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => { setPeriodEnabled(false); setPeriodStart(''); setPeriodEnd(''); }}>Limpar</Button>)}
                            </div>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Card>
                      <CardHeader className="p-3 pb-2">
                        <CardTitle className="text-xs flex items-center gap-1.5">
                          <BarChart3 className="h-3.5 w-3.5 text-purple-500" />
                          Totalizadores
                          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 ml-auto" onClick={addAggregation}><Plus className="h-3 w-3" /></Button>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-3 pt-0 space-y-2">
                        {aggregations.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Nenhum totalizador</p>
                        ) : aggregations.map((agg, idx) => (
                          <div key={idx} className="flex gap-1 items-center">
                            <Select value={agg.fn} onValueChange={v => updateAggregation(idx, { fn: v as any })}>
                              <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {Object.entries(AGG_LABELS).map(([k, v]) => (
                                  <SelectItem key={k} value={k}>{v}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select value={agg.field} onValueChange={v => updateAggregation(idx, { field: v })}>
                              <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {currentSource?.fields.map(f => (
                                  <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => removeAggregation(idx)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="p-3 pb-2">
                        <CardTitle className="text-xs flex items-center gap-1.5">
                          <Filter className="h-3.5 w-3.5 text-red-500" />
                          Filtros
                          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 ml-auto" onClick={addFilter}><Plus className="h-3 w-3" /></Button>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-3 pt-0 space-y-2">
                        {filters.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Nenhum filtro</p>
                        ) : filters.map((f, idx) => (
                          <div key={idx} className="space-y-1">
                            <div className="flex gap-1 items-center">
                              <Select value={f.field} onValueChange={v => updateFilter(idx, { field: v })}>
                                <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {currentSource?.fields.map(fi => (
                                    <SelectItem key={fi.key} value={fi.key}>{fi.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => removeFilter(idx)}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                            <div className="flex gap-1">
                              <Select value={f.operator} onValueChange={v => updateFilter(idx, { operator: v })}>
                                <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {Object.entries(OPERATOR_LABELS).map(([k, v]) => (
                                    <SelectItem key={k} value={k}>{v}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {f.operator !== 'is_null' && f.operator !== 'is_not_null' && (
                                <Input className="h-7 text-xs flex-1" value={f.value} onChange={e => updateFilter(idx, { value: e.target.value })} placeholder="Valor..." />
                              )}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="p-3 pb-2">
                        <CardTitle className="text-xs flex items-center gap-1.5">
                          <ArrowUpDown className="h-3.5 w-3.5 text-amber-500" />
                          Ordenação
                          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 ml-auto" onClick={addOrderBy}><Plus className="h-3 w-3" /></Button>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-3 pt-0 space-y-2">
                        {orderBy.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Sem ordenação</p>
                        ) : orderBy.map((o, idx) => (
                          <div key={idx} className="flex gap-1 items-center">
                            <Select value={o.field} onValueChange={v => updateOrderBy(idx, { field: v })}>
                              <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {currentSource?.fields.map(f => (
                                  <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                                ))}
                                {aggregations.map(a => (
                                  <SelectItem key={`${a.fn}_${a.field}`} value={`${a.fn}_${a.field}`}>
                                    {AGG_LABELS[a.fn]} {fieldsMap.get(a.field)?.label || a.field}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => updateOrderBy(idx, { direction: o.direction === 'asc' ? 'desc' : 'asc' })}>
                              {o.direction === 'asc' ? <SortAsc className="h-3 w-3" /> : <SortDesc className="h-3 w-3" />}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => removeOrderBy(idx)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">Limite:</Label>
                      <Select value={String(limit)} onValueChange={v => setLimit(parseInt(v))}>
                        <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="100">100</SelectItem>
                          <SelectItem value="500">500</SelectItem>
                          <SelectItem value="1000">1.000</SelectItem>
                          <SelectItem value="2000">2.000</SelectItem>
                          <SelectItem value="5000">5.000</SelectItem>
                          <SelectItem value="10000">10.000</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex gap-2 ml-auto">
                      <Button variant="outline" size="sm" onClick={() => setSaveDialogOpen(true)} disabled={!dataSource}>
                        <Save className="h-4 w-4 mr-1" />Salvar
                      </Button>
                      {result && result.rows.length > 0 && (
                        <Button variant="outline" size="sm" onClick={exportCSV}>
                          <Download className="h-4 w-4 mr-1" />Exportar CSV
                        </Button>
                      )}
                      <Button size="sm" onClick={executeReportQuery} disabled={isExecuting || !dataSource} className="bg-blue-600 hover:bg-blue-700">
                        {isExecuting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                        Executar Relatório
                      </Button>
                    </div>
                  </div>

                  {result && (
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <CardTitle className="text-sm">
                            Resultado: {result.totalRows.toLocaleString('pt-BR')} registros
                            {result.rows.length < result.totalRows && ` (exibindo ${result.rows.length.toLocaleString('pt-BR')})`}
                          </CardTitle>
                          <div className="flex items-center gap-2">
                            <div className="flex gap-1">
                              {([['tabela', 'Tabela'], ['pivo', 'Pivô'], ['barras', 'Barras'], ['pizza', 'Pizza'], ['linha', 'Linha']] as [any, string][]).map(([vm, vl]) => (
                                <Button key={vm} size="sm" variant={viewMode === vm ? 'default' : 'outline'} className="h-7 text-xs px-2" onClick={() => setViewMode(vm)}>{vl}</Button>
                              ))}
                            </div>
                            <Badge variant="outline" className="text-xs">{result.columns.length} colunas</Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-0">
                        {viewMode === 'pivo' ? (
                          <ReportPivot result={result} pivotCol={pivotCol} setPivotCol={setPivotCol} labelOf={getColumnLabel} typeOf={getColumnType} />
                        ) : viewMode !== 'tabela' ? (
                          <ReportChart mode={viewMode} result={result} chartX={chartX} chartY={chartY} setChartX={setChartX} setChartY={setChartY} labelOf={getColumnLabel} typeOf={getColumnType} />
                        ) : (
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-gray-50 dark:bg-gray-800">
                                <TableHead className="w-10 text-center text-xs">#</TableHead>
                                {result.columns.map(col => (
                                  <TableHead key={col} className="text-xs font-semibold whitespace-nowrap">
                                    {getColumnLabel(col)}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {result.rows.map((row, rowIdx) => (
                                <TableRow key={rowIdx} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                  <TableCell className="text-center text-xs text-muted-foreground">{rowIdx + 1}</TableCell>
                                  {result.columns.map(col => (
                                    <TableCell key={col} className="text-xs whitespace-nowrap">
                                      {formatCellValue(row[col], getColumnType(col))}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                              {totals && (
                                <TableRow className="bg-blue-50 dark:bg-blue-900/20 font-semibold border-t-2 border-blue-200">
                                  <TableCell className="text-center text-xs">Σ</TableCell>
                                  {result.columns.map(col => {
                                    const t = getColumnType(col);
                                    const isNumeric = t === 'currency' || t === 'number';
                                    return (
                                      <TableCell key={col} className="text-xs whitespace-nowrap">
                                        {isNumeric && totals[col] !== undefined
                                          ? formatCellValue(totals[col], t)
                                          : ''}
                                      </TableCell>
                                    );
                                  })}
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Salvar Relatório</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nome do Relatório *</Label>
              <Input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Ex: Vendas por Vendedor - Mensal" />
            </div>
            <div className="space-y-2">
              <Label>Descrição</Label>
              <Textarea value={saveDescription} onChange={e => setSaveDescription(e.target.value)} placeholder="Descreva o objetivo deste relatório..." rows={3} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancelar</Button>
              <Button onClick={saveReport} disabled={!saveName} className="bg-blue-600 hover:bg-blue-700">
                <Save className="h-4 w-4 mr-2" />Salvar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
