import { useState, useMemo } from 'react';
import { cidadeCanonica } from "@/lib/cidadePadrao";
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { toast } from '@/hooks/use-toast';
import {
  Search, ChevronDown, Loader2, Download, RefreshCw, MapPin, Copy,
  ArrowUp, ArrowDown, ArrowDownUp, Truck, ExternalLink,
} from 'lucide-react';

/**
 * FLUXO DE ENTREGAS (Logística)
 * ---------------------------------------------------------------------------
 * Mesma fonte do Pipeline de Faturamento (`GET /api/billing-pipeline`), só que
 * em TABELA: todas as informações do card em colunas, com filtros, ordenação,
 * busca e exportação. A coluna "Coordenadas" traz "latitude, longitude" do
 * CADASTRO DO CLIENTE (customers.latitude/longitude — a mesma fonte do Mapa de
 * Clientes e da roteirização), no formato que se cola direto no Google Maps.
 */

interface FluxoItem {
  id: string;
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerAltName?: string | null;
  customerDocument: string | null;
  sellerId: string | null;
  sellerName: string | null;
  stage: string;
  isPriority?: boolean;
  orderNumber: string | null;
  invoiceNumber: string | null;
  saleValue: string | null;
  fiscalStatus?: string | null;
  fiscalError?: string | null;
  source?: string | null;
  paidOnline?: boolean;
  deliveryDriverName?: string | null;
  deliveryRouteDate?: string | null;
  paymentMethod: string | null;
  operationType: string | null;
  products: Array<{ id: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  notes: string | null;
  omieInstanceId: string | null;
  omieInstanceName: string | null;
  scheduledBillingDate: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // enriquecimento do cadastro do cliente (getBillingPipelineItems)
  customerLatitude?: number | null;
  customerLongitude?: number | null;
  customerAddress?: string | null;
  customerCity?: string | null;
  customerNeighborhood?: string | null;
  customerState?: string | null;
  customerZipCode?: string | null;
  customerPhone?: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  bloqueado: 'Bloqueado',
  agendado: 'Agendado',
  pedido: 'Pedido',
  a_faturar: 'A Faturar',
  faturado: 'Faturado',
  impresso: 'Impresso',
  bsb: 'BSB',
  aguardando_rota_bsb: 'Ag. Rota BSB',
  em_rota_bsb: 'Em Rota BSB',
  outras_cidades: 'Outras Cidades',
  aguardando_rota: 'Aguardando Rota',
  em_rota: 'Em Rota',
  entregue: 'Entregue',
  lixeira: 'Lixeira',
};

// Ordem lógica do fluxo (do pedido até a entrega) — usada na ordenação por etapa.
const STAGE_ORDER = [
  'bloqueado', 'agendado', 'pedido', 'a_faturar', 'faturado', 'impresso',
  'bsb', 'aguardando_rota_bsb', 'em_rota_bsb', 'outras_cidades',
  'aguardando_rota', 'em_rota', 'entregue', 'lixeira',
];

const STAGE_BADGE: Record<string, string> = {
  bloqueado: 'bg-red-100 text-red-800 border-red-200',
  agendado: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  pedido: 'bg-blue-100 text-blue-800 border-blue-200',
  a_faturar: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  faturado: 'bg-orange-100 text-orange-800 border-orange-200',
  impresso: 'bg-purple-100 text-purple-800 border-purple-200',
  bsb: 'bg-pink-100 text-pink-800 border-pink-200',
  aguardando_rota_bsb: 'bg-teal-100 text-teal-800 border-teal-200',
  em_rota_bsb: 'bg-sky-100 text-sky-800 border-sky-200',
  outras_cidades: 'bg-violet-100 text-violet-800 border-violet-200',
  aguardando_rota: 'bg-gray-100 text-gray-800 border-gray-200',
  em_rota: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  entregue: 'bg-green-100 text-green-800 border-green-200',
  lixeira: 'bg-gray-200 text-gray-700 border-gray-300',
};

const PAYMENT_LABELS: Record<string, string> = {
  a_vista: 'À Vista', boleto: 'Boleto', pix: 'PIX', cartao: 'Cartão', card: 'Cartão', dinheiro: 'Dinheiro',
};

const OPERATION_LABELS: Record<string, string> = {
  venda: 'Venda', bonificacao: 'Bonificação', troca: 'Troca', amostra: 'Amostra', reposicao: 'Reposição',
};

const FISCAL_LABELS: Record<string, string> = {
  authorized: 'Autorizada', autorizada: 'Autorizada',
  cancelled: 'Cancelada', canceled: 'Cancelada', cancelada: 'Cancelada',
  returned: 'Devolvida', devolvida: 'Devolvida', devolvido: 'Devolvida',
  rejected: 'Rejeitada', rejeitada: 'Rejeitada',
  denied: 'Denegada', draft: 'Rascunho', pending: 'Pendente',
};

function fmtCurrency(v: string | number | null | undefined) {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  if (!Number.isFinite(n as number)) return 'R$ 0,00';
  return (n as number).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDateTime(s?: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Data "pura" (YYYY-MM-DD) não pode virar Date: o fuso puxaria para o dia anterior.
function fmtDateOnly(s?: string | null) {
  if (!s) return '—';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function fmtDoc(doc?: string | null) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return doc || '—';
}

// "latitude, longitude" com ponto decimal — é o formato que o Google Maps aceita colado.
function fmtCoords(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0 && b === 0) return null;
  return `${a.toFixed(6)}, ${b.toFixed(6)}`;
}

function MultiSelectFilter({ label, options, selected, onToggle, onClear, testid }: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  testid?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={`h-9 border rounded-md px-3 text-sm bg-white dark:bg-gray-800 dark:border-gray-600 flex items-center gap-1.5 whitespace-nowrap ${selected.size > 0 ? 'border-orange-400 text-orange-700 dark:text-orange-300' : ''}`}
          data-testid={testid}
        >
          <span>{label}{selected.size > 0 ? ` (${selected.size})` : ''}</span>
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2 max-h-72 overflow-auto" align="start">
        <div className="flex items-center justify-between mb-1 px-1">
          <span className="text-xs font-semibold text-gray-500">{label}</span>
          {selected.size > 0 && (
            <button onClick={onClear} className="text-xs text-blue-600 hover:underline">Limpar</button>
          )}
        </div>
        {options.length === 0 && <p className="text-xs text-gray-400 py-2 px-1">Nenhuma opção</p>}
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer text-sm">
            <Checkbox checked={selected.has(o.value)} onCheckedChange={() => onToggle(o.value)} className="h-4 w-4" />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

type SortKey =
  | 'stage' | 'orderNumber' | 'invoiceNumber' | 'customerName' | 'customerCity'
  | 'sellerName' | 'saleValue' | 'createdAt' | 'updatedAt' | 'deliveryRouteDate'
  | 'deliveryDriverName' | 'coords';

const COORD_FILTER = [
  { value: 'com', label: 'Com coordenada' },
  { value: 'sem', label: 'Sem coordenada' },
];

export default function FluxoEntregas() {
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [sellerFilter, setSellerFilter] = useState<Set<string>>(new Set());
  const [cityFilter, setCityFilter] = useState<Set<string>>(new Set());
  const [driverFilter, setDriverFilter] = useState<Set<string>>(new Set());
  const [opFilter, setOpFilter] = useState<Set<string>>(new Set());
  const [payFilter, setPayFilter] = useState<Set<string>>(new Set());
  const [fiscalFilter, setFiscalFilter] = useState<Set<string>>(new Set());
  const [instanceFilter, setInstanceFilter] = useState<Set<string>>(new Set());
  const [coordFilter, setCoordFilter] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [detail, setDetail] = useState<FluxoItem | null>(null);

  const { data: items = [], isLoading, isFetching, refetch } = useQuery<FluxoItem[]>({
    queryKey: ['/api/billing-pipeline'],
  });

  const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    setter((prev) => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });

  const opts = (vals: (string | null | undefined)[], labels?: Record<string, string>) =>
    Array.from(new Set(vals.filter(Boolean) as string[]))
      .sort((a, b) => (labels?.[a] || a).localeCompare(labels?.[b] || b, 'pt-BR'))
      .map((v) => ({ value: v, label: labels?.[v] || v }));

  const stageOptions = useMemo(() => {
    const present = new Set(items.map((i) => i.stage).filter(Boolean));
    return STAGE_ORDER.filter((s) => present.has(s)).map((v) => ({ value: v, label: STAGE_LABELS[v] || v }));
  }, [items]);
  const sellerOptions = useMemo(() => opts(items.map((i) => i.sellerName)), [items]);
  const cityOptions = useMemo(() => opts(items.map((i) => cidadeCanonica(i.customerCity))), [items]);
  const driverOptions = useMemo(() => opts(items.map((i) => i.deliveryDriverName)), [items]);
  const opOptions = useMemo(() => opts(items.map((i) => i.operationType), OPERATION_LABELS), [items]);
  const payOptions = useMemo(() => opts(items.map((i) => i.paymentMethod), PAYMENT_LABELS), [items]);
  const fiscalOptions = useMemo(() => opts(items.map((i) => i.fiscalStatus), FISCAL_LABELS), [items]);
  const instanceOptions = useMemo(() => opts(items.map((i) => i.omieInstanceName)), [items]);

  const activeFilters =
    stageFilter.size + sellerFilter.size + cityFilter.size + driverFilter.size + opFilter.size +
    payFilter.size + fiscalFilter.size + instanceFilter.size + coordFilter.size +
    (search ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

  const clearAll = () => {
    setSearch(''); setStageFilter(new Set()); setSellerFilter(new Set()); setCityFilter(new Set());
    setDriverFilter(new Set()); setOpFilter(new Set()); setPayFilter(new Set()); setFiscalFilter(new Set());
    setInstanceFilter(new Set()); setCoordFilter(new Set()); setDateFrom(''); setDateTo('');
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (stageFilter.size && !stageFilter.has(i.stage)) return false;
      if (sellerFilter.size && !sellerFilter.has(String(i.sellerName || ''))) return false;
      if (cityFilter.size && !cityFilter.has(cidadeCanonica(i.customerCity))) return false;
      if (driverFilter.size && !driverFilter.has(String(i.deliveryDriverName || ''))) return false;
      if (opFilter.size && !opFilter.has(String(i.operationType || ''))) return false;
      if (payFilter.size && !payFilter.has(String(i.paymentMethod || ''))) return false;
      if (fiscalFilter.size && !fiscalFilter.has(String(i.fiscalStatus || ''))) return false;
      if (instanceFilter.size && !instanceFilter.has(String(i.omieInstanceName || ''))) return false;
      if (coordFilter.size) {
        const has = !!fmtCoords(i.customerLatitude, i.customerLongitude);
        if (coordFilter.has('com') && !coordFilter.has('sem') && !has) return false;
        if (coordFilter.has('sem') && !coordFilter.has('com') && has) return false;
      }
      if (dateFrom || dateTo) {
        const created = String(i.createdAt || '').slice(0, 10);
        if (dateFrom && created < dateFrom) return false;
        if (dateTo && created > dateTo) return false;
      }
      if (q) {
        const hay = [
          i.customerName, i.customerAltName, i.customerDocument, i.orderNumber, i.invoiceNumber,
          i.sellerName, i.customerCity, i.customerAddress, i.deliveryDriverName, i.notes,
          fmtCoords(i.customerLatitude, i.customerLongitude),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, stageFilter, sellerFilter, cityFilter, driverFilter, opFilter, payFilter, fiscalFilter, instanceFilter, coordFilter, dateFrom, dateTo]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (i: FluxoItem): string | number => {
      switch (sortKey) {
        case 'stage': return STAGE_ORDER.indexOf(i.stage);
        case 'saleValue': return parseFloat(String(i.saleValue || '0')) || 0;
        case 'orderNumber': return Number(String(i.orderNumber || '').replace(/\D/g, '')) || 0;
        case 'invoiceNumber': return Number(String(i.invoiceNumber || '').replace(/\D/g, '')) || 0;
        case 'coords': return fmtCoords(i.customerLatitude, i.customerLongitude) ? 1 : 0;
        case 'createdAt': return String(i.createdAt || '');
        case 'updatedAt': return String(i.updatedAt || '');
        case 'deliveryRouteDate': return String(i.deliveryRouteDate || '');
        default: return String((i as any)[sortKey] || '').toLowerCase();
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'pt-BR') * dir;
    });
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'createdAt' || k === 'updatedAt' ? 'desc' : 'asc'); }
  };

  const totalValor = useMemo(
    () => sorted.reduce((s, i) => s + (parseFloat(String(i.saleValue || '0')) || 0), 0),
    [sorted],
  );
  const semCoord = useMemo(
    () => sorted.filter((i) => !fmtCoords(i.customerLatitude, i.customerLongitude)).length,
    [sorted],
  );

  const copyCoords = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      toast({ title: 'Coordenada copiada', description: txt });
    } catch {
      toast({ title: 'Não foi possível copiar', description: txt, variant: 'destructive' });
    }
  };

  // Exportação CSV (;) com BOM — abre direto no Excel em pt-BR, acentos inclusive.
  const exportCsv = () => {
    const head = [
      'Etapa', 'Prioridade', 'Pedido', 'NF', 'Cliente', 'CNPJ/CPF', 'Telefone', 'Cidade', 'UF',
      'Bairro', 'Endereço', 'CEP', 'Coordenadas (latitude, longitude)', 'Latitude', 'Longitude',
      'Vendedor', 'Valor', 'Pagamento', 'Operação', 'Status fiscal', 'Origem', 'Pago online',
      'Instância', 'Entregador', 'Data da rota', 'Agendado para', 'Itens', 'Observações',
      'Criado em', 'Atualizado em',
    ];
    const rows = sorted.map((i) => {
      const c = fmtCoords(i.customerLatitude, i.customerLongitude);
      return [
        STAGE_LABELS[i.stage] || i.stage,
        i.isPriority ? 'Sim' : '',
        i.orderNumber || '', i.invoiceNumber || '',
        i.customerName || '', fmtDoc(i.customerDocument), i.customerPhone || '',
        i.customerCity || '', i.customerState || '', i.customerNeighborhood || '',
        i.customerAddress || '', i.customerZipCode || '',
        c || '', c ? String(i.customerLatitude) : '', c ? String(i.customerLongitude) : '',
        i.sellerName || '',
        String(parseFloat(String(i.saleValue || '0')) || 0).replace('.', ','),
        PAYMENT_LABELS[String(i.paymentMethod || '')] || i.paymentMethod || '',
        OPERATION_LABELS[String(i.operationType || '')] || i.operationType || '',
        FISCAL_LABELS[String(i.fiscalStatus || '')] || i.fiscalStatus || '',
        i.source || '', i.paidOnline ? 'Sim' : '',
        i.omieInstanceName || '', i.deliveryDriverName || '',
        fmtDateOnly(i.deliveryRouteDate) === '—' ? '' : fmtDateOnly(i.deliveryRouteDate),
        fmtDateOnly(i.scheduledBillingDate) === '—' ? '' : fmtDateOnly(i.scheduledBillingDate),
        String(i.products?.length || 0),
        (i.notes || '').replace(/[\r\n]+/g, ' '),
        fmtDateTime(i.createdAt), fmtDateTime(i.updatedAt),
      ];
    });
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `fluxo-de-entregas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const Th = ({ k, children, className = '' }: { k?: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`px-2 py-2 text-left font-semibold whitespace-nowrap ${k ? 'cursor-pointer select-none hover:text-orange-700' : ''} ${className}`}
        onClick={k ? () => toggleSort(k) : undefined}
        data-testid={k ? `th-${k}` : undefined}>
      <span className="inline-flex items-center gap-1">
        {children}
        {k && (sortKey === k
          ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ArrowDownUp className="h-3 w-3 text-gray-300" />)}
      </span>
    </th>
  );

  return (
    <div className="bg-gray-50 dark:bg-gray-900 flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 56px)' }}>
      <div className="p-4 flex flex-col flex-1 min-h-0">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <BackToDashboardButton />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Truck className="h-6 w-6 text-orange-500" />
              Fluxo de Entregas
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-sm" data-testid="badge-total-fluxo">
              {sorted.length} de {items.length} pedidos
            </Badge>
            <Badge variant="outline" className="text-sm">{fmtCurrency(totalValor)}</Badge>
            {semCoord > 0 && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-sm" data-testid="badge-sem-coordenada">
                {semCoord} sem coordenada
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-atualizar-fluxo">
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Atualizar
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-exportar-fluxo">
              <Download className="h-4 w-4 mr-1" /> Exportar
            </Button>
          </div>
        </div>

        {/* Filtros */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cliente, NF, pedido, cidade, coordenada..."
              className="pl-8 h-9"
              data-testid="input-search-fluxo"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">×</button>
            )}
          </div>
          <MultiSelectFilter label="Etapa" options={stageOptions} selected={stageFilter} onToggle={toggleInSet(setStageFilter)} onClear={() => setStageFilter(new Set())} testid="filtro-etapa" />
          <MultiSelectFilter label="Cidade" options={cityOptions} selected={cityFilter} onToggle={toggleInSet(setCityFilter)} onClear={() => setCityFilter(new Set())} testid="filtro-cidade" />
          <MultiSelectFilter label="Vendedor" options={sellerOptions} selected={sellerFilter} onToggle={toggleInSet(setSellerFilter)} onClear={() => setSellerFilter(new Set())} testid="filtro-vendedor" />
          <MultiSelectFilter label="Entregador" options={driverOptions} selected={driverFilter} onToggle={toggleInSet(setDriverFilter)} onClear={() => setDriverFilter(new Set())} testid="filtro-entregador" />
          <MultiSelectFilter label="Operação" options={opOptions} selected={opFilter} onToggle={toggleInSet(setOpFilter)} onClear={() => setOpFilter(new Set())} testid="filtro-operacao" />
          <MultiSelectFilter label="Pagamento" options={payOptions} selected={payFilter} onToggle={toggleInSet(setPayFilter)} onClear={() => setPayFilter(new Set())} testid="filtro-pagamento" />
          <MultiSelectFilter label="Status fiscal" options={fiscalOptions} selected={fiscalFilter} onToggle={toggleInSet(setFiscalFilter)} onClear={() => setFiscalFilter(new Set())} testid="filtro-fiscal" />
          <MultiSelectFilter label="Instância" options={instanceOptions} selected={instanceFilter} onToggle={toggleInSet(setInstanceFilter)} onClear={() => setInstanceFilter(new Set())} testid="filtro-instancia" />
          <MultiSelectFilter label="Coordenada" options={COORD_FILTER} selected={coordFilter} onToggle={toggleInSet(setCoordFilter)} onClear={() => setCoordFilter(new Set())} testid="filtro-coordenada" />
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-500">Criado de</span>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[140px]" data-testid="input-data-de" />
            <span className="text-gray-500">a</span>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[140px]" data-testid="input-data-ate" />
          </div>
          {activeFilters > 0 && (
            <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-limpar-filtros">
              Limpar filtros ×
            </Button>
          )}
        </div>

        {/* Tabela */}
        <div className="flex-1 min-h-0 overflow-auto border rounded-lg bg-white dark:bg-gray-800">
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando pipeline...
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              Nenhum pedido para os filtros aplicados.
            </div>
          ) : (
            <table className="w-full text-xs" data-testid="tabela-fluxo-entregas">
              <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 shadow-sm">
                <tr>
                  <Th k="stage">Etapa</Th>
                  <Th k="orderNumber">Pedido</Th>
                  <Th k="invoiceNumber">NF</Th>
                  <Th k="customerName">Cliente</Th>
                  <Th>CNPJ/CPF</Th>
                  <Th k="customerCity">Cidade</Th>
                  <Th>Endereço</Th>
                  <Th k="coords">Coordenadas (lat, long)</Th>
                  <Th k="sellerName">Vendedor</Th>
                  <Th k="saleValue" className="text-right">Valor</Th>
                  <Th>Pagamento</Th>
                  <Th>Operação</Th>
                  <Th>Status fiscal</Th>
                  <Th>Instância</Th>
                  <Th k="deliveryDriverName">Entregador</Th>
                  <Th k="deliveryRouteDate">Data da rota</Th>
                  <Th>Agendado</Th>
                  <Th>Itens</Th>
                  <Th k="createdAt">Criado em</Th>
                  <Th k="updatedAt">Atualizado</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((i) => {
                  const coords = fmtCoords(i.customerLatitude, i.customerLongitude);
                  return (
                    <tr
                      key={i.id}
                      className="border-t hover:bg-orange-50/60 dark:hover:bg-gray-700/50 cursor-pointer align-top"
                      onClick={() => setDetail(i)}
                      data-testid={`linha-fluxo-${i.id}`}
                    >
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <Badge variant="outline" className={`${STAGE_BADGE[i.stage] || ''} text-[11px] px-1.5 py-0`}>
                          {STAGE_LABELS[i.stage] || i.stage}
                        </Badge>
                        {i.isPriority && <span className="ml-1 text-amber-500" title="Prioridade na roteirização">★</span>}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.orderNumber || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.invoiceNumber || '—'}</td>
                      <td className="px-2 py-1.5 max-w-[220px]">
                        <span className="font-medium block truncate" title={i.customerName}>{i.customerName}</span>
                        {i.source === 'hotsite' && <span className="text-[10px] text-emerald-600">HOTSITE</span>}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-600 dark:text-gray-300">{fmtDoc(i.customerDocument)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.customerCity || '—'}{i.customerState ? `/${i.customerState}` : ''}</td>
                      <td className="px-2 py-1.5 max-w-[220px]">
                        <span className="block truncate text-gray-600 dark:text-gray-300" title={i.customerAddress || ''}>
                          {i.customerAddress || '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap" data-testid={`coordenadas-${i.id}`}>
                        {coords ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                            <MapPin className="h-3 w-3 text-orange-500 shrink-0" />
                            {coords}
                            <button
                              onClick={(e) => { e.stopPropagation(); copyCoords(coords); }}
                              className="text-gray-400 hover:text-orange-600"
                              title="Copiar coordenada"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-gray-400 hover:text-orange-600"
                              title="Abrir no Google Maps"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </span>
                        ) : (
                          <span className="text-amber-600 text-[11px]">sem coordenada</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.sellerName || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-right font-medium">{fmtCurrency(i.saleValue)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {PAYMENT_LABELS[String(i.paymentMethod || '')] || i.paymentMethod || '—'}
                        {i.paidOnline && <span className="ml-1 text-[10px] text-green-600">Pago</span>}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{OPERATION_LABELS[String(i.operationType || '')] || i.operationType || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{FISCAL_LABELS[String(i.fiscalStatus || '')] || i.fiscalStatus || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.omieInstanceName || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.deliveryDriverName || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fmtDateOnly(i.deliveryRouteDate)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fmtDateOnly(i.scheduledBillingDate)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-center">{i.products?.length || 0}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-600 dark:text-gray-300">{fmtDateTime(i.createdAt)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-600 dark:text-gray-300">{fmtDateTime(i.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="mt-2 text-xs text-gray-500">
          Mesma base do Pipeline de Faturamento. Coordenadas vêm do cadastro do cliente (Clientes → Localização) —
          quando aparece "sem coordenada", é o cadastro que está sem latitude/longitude.
        </p>
      </div>

      {/* Detalhe do pedido */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-base">
              {detail?.customerName} {detail?.orderNumber ? `· Pedido ${detail.orderNumber}` : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="text-sm space-y-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div><span className="text-gray-500">Etapa:</span> {STAGE_LABELS[detail.stage] || detail.stage}</div>
                <div><span className="text-gray-500">NF:</span> {detail.invoiceNumber || '—'}</div>
                <div><span className="text-gray-500">CNPJ/CPF:</span> {fmtDoc(detail.customerDocument)}</div>
                <div><span className="text-gray-500">Telefone:</span> {detail.customerPhone || '—'}</div>
                <div className="col-span-2"><span className="text-gray-500">Endereço:</span> {[detail.customerAddress, detail.customerNeighborhood, detail.customerCity, detail.customerState, detail.customerZipCode].filter(Boolean).join(', ') || '—'}</div>
                <div className="col-span-2">
                  <span className="text-gray-500">Coordenadas:</span>{' '}
                  <span className="font-mono">{fmtCoords(detail.customerLatitude, detail.customerLongitude) || 'sem coordenada'}</span>
                </div>
                <div><span className="text-gray-500">Vendedor:</span> {detail.sellerName || '—'}</div>
                <div><span className="text-gray-500">Valor:</span> {fmtCurrency(detail.saleValue)}</div>
                <div><span className="text-gray-500">Entregador:</span> {detail.deliveryDriverName || '—'}</div>
                <div><span className="text-gray-500">Data da rota:</span> {fmtDateOnly(detail.deliveryRouteDate)}</div>
                <div><span className="text-gray-500">Instância:</span> {detail.omieInstanceName || '—'}</div>
                <div><span className="text-gray-500">Status fiscal:</span> {FISCAL_LABELS[String(detail.fiscalStatus || '')] || detail.fiscalStatus || '—'}</div>
              </div>
              {detail.fiscalError && (
                <p className="text-xs text-red-600 bg-red-50 rounded p-2">{detail.fiscalError}</p>
              )}
              {detail.notes && (
                <p className="text-xs text-gray-600 bg-gray-50 dark:bg-gray-700 rounded p-2 whitespace-pre-wrap">{detail.notes}</p>
              )}
              {!!detail.products?.length && (
                <div>
                  <p className="font-semibold mb-1">Itens ({detail.products.length})</p>
                  <table className="w-full text-xs border">
                    <thead className="bg-gray-100 dark:bg-gray-700">
                      <tr><th className="px-2 py-1 text-left">Produto</th><th className="px-2 py-1 text-right">Qtd</th><th className="px-2 py-1 text-right">Unit.</th><th className="px-2 py-1 text-right">Total</th></tr>
                    </thead>
                    <tbody>
                      {detail.products.map((p, idx) => (
                        <tr key={p.id || idx} className="border-t">
                          <td className="px-2 py-1">{p.name}</td>
                          <td className="px-2 py-1 text-right">{p.quantity}</td>
                          <td className="px-2 py-1 text-right">{fmtCurrency(p.unitPrice)}</td>
                          <td className="px-2 py-1 text-right">{fmtCurrency(p.totalPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
