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
import {
  Search, ChevronDown, Loader2, Download, RefreshCw, Package,
  ArrowUp, ArrowDown, ArrowDownUp,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  AreaChart, Area, PieChart, Pie, Cell, LabelList,
} from 'recharts';

/**
 * GESTÃO · PRODUTOS COMERCIALIZADOS
 * ---------------------------------------------------------------------------
 * Primeiro relatório do menu de Gestão. Fonte = billing_pipeline (a mesma do
 * Pipeline de Faturamento), explodida por ITEM pelo endpoint
 * GET /api/gestao/produtos-comercializados?de=...&ate=... — 1 linha por produto
 * de cada pedido, com vendedor, cliente, instância, operação (venda/troca/...),
 * etapa, CFOP e status da NF. Filtros e agregações rodam no cliente, no padrão
 * das demais telas (Fluxo de Entregas).
 */

interface ItemRow {
  pipeline_id: string;
  data: string; // YYYY-MM-DD
  stage: string;
  operation_type: string | null;
  payment_method: string | null;
  customer_id: string;
  customer_name: string;
  customer_city: string | null;
  seller_name: string | null;
  instance_name: string | null;
  order_number: string | null;
  invoice_number: string | null;
  cfop: string | null;
  fiscal_status: string | null;
  product_id: string | null;
  product_name: string;
  quantity: string | number;
  unit_price: string | number;
  total_price: string | number;
  product_code: string | null;
  ncm: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  bloqueado: 'Bloqueado', agendado: 'Agendado', pedido: 'Pedido', a_faturar: 'A Faturar',
  faturado: 'Faturado', impresso: 'Impresso', bsb: 'BSB', aguardando_rota_bsb: 'Ag. Rota BSB',
  em_rota_bsb: 'Em Rota BSB', outras_cidades: 'Outras Cidades', aguardando_rota: 'Aguardando Rota',
  em_rota: 'Em Rota', entregue: 'Entregue',
};

const OPERATION_LABELS: Record<string, string> = {
  venda: 'Venda', troca: 'Troca', amostra: 'Amostra', bonificacao: 'Bonificação',
  reposicao: 'Reposição', transferencia: 'Transferência',
};

const PAYMENT_LABELS: Record<string, string> = {
  a_vista: 'À Vista', boleto: 'Boleto', pix: 'PIX', cartao: 'Cartão', card: 'Cartão', dinheiro: 'Dinheiro',
};

const FISCAL_LABELS: Record<string, string> = {
  authorized: 'Autorizada', autorizada: 'Autorizada',
  cancelled: 'Cancelada', canceled: 'Cancelada', cancelada: 'Cancelada',
  returned: 'Devolvida', devolvida: 'Devolvida', rejected: 'Rejeitada', rejeitada: 'Rejeitada',
  denied: 'Denegada', draft: 'Rascunho', pending: 'Pendente',
};

// Nomes (resumidos) dos CFOPs mais comuns na operação. Chave sem pontuação —
// o dado pode vir "5102" ou "1.202". Código fora da lista aparece sem nome.
const CFOP_LABELS: Record<string, string> = {
  '1201': 'Devolução de venda de produção do estabelecimento',
  '1202': 'Devolução de venda de mercadoria de terceiros',
  '1411': 'Devolução de venda com substituição tributária',
  '1949': 'Outra entrada não especificada',
  '2201': 'Devolução de venda de produção (interestadual)',
  '2202': 'Devolução de venda de mercadoria de terceiros (interestadual)',
  '2411': 'Devolução de venda com ST (interestadual)',
  '5101': 'Venda de produção do estabelecimento',
  '5102': 'Venda de mercadoria adquirida de terceiros',
  '5151': 'Transferência de produção do estabelecimento',
  '5152': 'Transferência de mercadoria adquirida',
  '5401': 'Venda de produção com ST (substituto)',
  '5403': 'Venda de mercadoria com ST (substituto)',
  '5405': 'Venda de mercadoria com ST (substituído)',
  '5409': 'Venda com ST (substituído)',
  '5910': 'Remessa em bonificação, doação ou brinde',
  '5911': 'Remessa de amostra grátis',
  '5929': 'Saída de mercadoria acobertada por NFC-e/ECF',
  '5949': 'Outra saída não especificada',
  '6101': 'Venda de produção (interestadual)',
  '6102': 'Venda de mercadoria de terceiros (interestadual)',
  '6108': 'Venda a não contribuinte (interestadual)',
  '6151': 'Transferência de produção (interestadual)',
  '6152': 'Transferência de mercadoria (interestadual)',
  '6401': 'Venda de produção com ST (interestadual)',
  '6403': 'Venda com ST, substituto (interestadual)',
  '6404': 'Venda com ST, imposto já retido (interestadual)',
  '6409': 'Venda com ST, substituído (interestadual)',
  '6910': 'Bonificação, doação ou brinde (interestadual)',
  '6911': 'Remessa de amostra grátis (interestadual)',
  '6929': 'Saída acobertada por NFC-e/ECF (interestadual)',
  '6949': 'Outra saída não especificada (interestadual)',
};
const cfopName = (v: string | null | undefined) =>
  v ? (CFOP_LABELS[String(v).replace(/\D/g, '')] || '') : '';
const cfopFull = (v: string) =>
  v === 'sem NF' ? 'sem NF' : (cfopName(v) ? `${v} — ${cfopName(v)}` : v);

// Paleta categórica validada (CVD-safe na ordem fixa). A cor segue a ENTIDADE:
// cada operação tem a sua e não muda quando um filtro esconde as demais.
const PALETTE = ['#2563eb', '#ea580c', '#0d9488', '#7c3aed', '#ca8a04'];
const GRAY = '#6b7280';
const OPERATION_COLORS: Record<string, string> = {
  venda: PALETTE[0], troca: PALETTE[1], amostra: PALETTE[2],
  bonificacao: PALETTE[3], transferencia: PALETTE[4], reposicao: PALETTE[4],
};
const MAIN = PALETTE[0];

const num = (v: string | number | null | undefined) => {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n as number) ? (n as number) : 0;
};

const fmtBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtBRLc = (v: number) => // compacto p/ eixos e rótulos de gráfico
  v >= 1000000 ? `R$ ${(v / 1000000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M`
  : v >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`
  : `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
const fmtQtd = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function fmtBucket(b: string) {
  const m = b.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return b;
  return m[3] ? `${m[3]}/${m[2]}` : `${m[2]}/${m[1]}`;
}

function isoShift(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function MultiSelectFilter({ label, options, selected, onToggle, onClear, testid, searchable }: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  testid?: string;
  searchable?: boolean;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    if (!q.trim()) return options.slice(0, 300);
    const t = q.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(t)).slice(0, 300);
  }, [options, q]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={`h-9 border rounded-md px-3 text-sm bg-white dark:bg-gray-800 dark:border-gray-600 flex items-center gap-1.5 whitespace-nowrap ${selected.size > 0 ? 'border-teal-500 text-teal-700 dark:text-teal-300' : ''}`}
          data-testid={testid}
        >
          <span>{label}{selected.size > 0 ? ` (${selected.size})` : ''}</span>
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="flex items-center justify-between mb-1 px-1">
          <span className="text-xs font-semibold text-gray-500">{label}</span>
          {selected.size > 0 && (
            <button onClick={onClear} className="text-xs text-blue-600 hover:underline">Limpar</button>
          )}
        </div>
        {searchable && (
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar..." className="h-8 mb-1 text-sm" />
        )}
        <div className="max-h-64 overflow-auto">
          {shown.length === 0 && <p className="text-xs text-gray-400 py-2 px-1">Nenhuma opção</p>}
          {shown.map((o) => (
            <label key={o.value} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer text-sm">
              <Checkbox checked={selected.has(o.value)} onCheckedChange={() => onToggle(o.value)} className="h-4 w-4" />
              <span className="truncate" title={o.label}>{o.label}</span>
            </label>
          ))}
          {!q && options.length > 300 && (
            <p className="text-[11px] text-gray-400 px-1 pt-1">Mostrando 300 de {options.length} — use a busca.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChartCard({ title, subtitle, children, className = '' }: {
  title: string; subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg p-3 ${className}`}>
      <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</p>
      {subtitle && <p className="text-[11px] text-gray-500 mb-1">{subtitle}</p>}
      {children}
    </div>
  );
}

const tooltipStyle = {
  fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb',
  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
} as const;

type SortKey = 'product' | 'code' | 'qty' | 'saidaDU' | 'value' | 'share' | 'orders' | 'customers' | 'avgPrice' | 'trocaQty';

interface ProdAgg {
  key: string;
  name: string;
  code: string | null;
  ncm: string | null;
  qty: number;
  value: number;
  orders: Set<string>;
  customers: Set<string>;
  trocaQty: number;
  trocaValue: number;
}

const PRESETS = [
  { label: '7 dias', days: 6 },
  { label: '30 dias', days: 29 },
  { label: '90 dias', days: 89 },
  { label: '12 meses', days: 364 },
];

export default function GestaoProdutos() {
  const [de, setDe] = useState(isoShift(29));
  const [ate, setAte] = useState(isoShift(0));
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState<'valor' | 'qtd'>('valor');
  const [instFilter, setInstFilter] = useState<Set<string>>(new Set());
  const [sellerFilter, setSellerFilter] = useState<Set<string>>(new Set());
  const [customerFilter, setCustomerFilter] = useState<Set<string>>(new Set());
  const [opFilter, setOpFilter] = useState<Set<string>>(new Set());
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [cfopFilter, setCfopFilter] = useState<Set<string>>(new Set());
  const [cityFilter, setCityFilter] = useState<Set<string>>(new Set());
  const [payFilter, setPayFilter] = useState<Set<string>>(new Set());
  const [prodFilter, setProdFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [detailProduct, setDetailProduct] = useState<string | null>(null);

  const url = `/api/gestao/produtos-comercializados?de=${de}&ate=${ate}`;
  const { data, isLoading, isFetching, refetch } = useQuery<{ de: string; ate: string; itens: ItemRow[] }>({
    queryKey: [url],
  });
  const rows = data?.itens || [];

  const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    setter((prev) => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });

  const opts = (vals: (string | null | undefined)[], labels?: Record<string, string>) =>
    Array.from(new Set(vals.filter(Boolean) as string[]))
      .sort((a, b) => (labels?.[a] || a).localeCompare(labels?.[b] || b, 'pt-BR'))
      .map((v) => ({ value: v, label: labels?.[v] || v }));

  const instOptions = useMemo(() => opts(rows.map((r) => r.instance_name)), [rows]);
  const sellerOptions = useMemo(() => opts(rows.map((r) => r.seller_name)), [rows]);
  const customerOptions = useMemo(() => opts(rows.map((r) => r.customer_name)), [rows]);
  const opOptions = useMemo(() => opts(rows.map((r) => r.operation_type), OPERATION_LABELS), [rows]);
  const stageOptions = useMemo(() => opts(rows.map((r) => r.stage), STAGE_LABELS), [rows]);
  const cfopOptions = useMemo(() => {
    const lista = Array.from(new Set(rows.map((r) => r.cfop).filter(Boolean) as string[]))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((v) => ({ value: v, label: cfopFull(v) }));
    if (rows.some((r) => !r.cfop)) lista.push({ value: 'sem NF', label: 'sem NF — pedido ainda sem NF-e vinculada' });
    return lista;
  }, [rows]);
  const cityOptions = useMemo(() => opts(rows.map((r) => cidadeCanonica(r.customer_city))), [rows]);
  const payOptions = useMemo(() => opts(rows.map((r) => r.payment_method), PAYMENT_LABELS), [rows]);
  const prodOptions = useMemo(() => opts(rows.map((r) => r.product_name)), [rows]);

  const activeFilters =
    instFilter.size + sellerFilter.size + customerFilter.size + opFilter.size + stageFilter.size +
    cfopFilter.size + cityFilter.size + payFilter.size + prodFilter.size + (search ? 1 : 0);

  const clearAll = () => {
    setSearch(''); setInstFilter(new Set()); setSellerFilter(new Set()); setCustomerFilter(new Set());
    setOpFilter(new Set()); setStageFilter(new Set()); setCfopFilter(new Set()); setCityFilter(new Set());
    setPayFilter(new Set()); setProdFilter(new Set());
  };

  // Chave de CFOP de uma linha: itens sem NF entram como 'sem NF' — assim o
  // chip "sem NF" também é selecionável no filtro.
  const cfopKeyOf = (r: ItemRow) => (r.cfop ? String(r.cfop) : 'sem NF');

  const matches = (r: ItemRow, q: string, ignoreCfop: boolean) => {
    if (instFilter.size && !instFilter.has(String(r.instance_name || ''))) return false;
    if (sellerFilter.size && !sellerFilter.has(String(r.seller_name || ''))) return false;
    if (customerFilter.size && !customerFilter.has(String(r.customer_name || ''))) return false;
    if (opFilter.size && !opFilter.has(String(r.operation_type || ''))) return false;
    if (stageFilter.size && !stageFilter.has(String(r.stage || ''))) return false;
    if (!ignoreCfop && cfopFilter.size && !cfopFilter.has(cfopKeyOf(r))) return false;
    if (cityFilter.size && !cityFilter.has(cidadeCanonica(r.customer_city))) return false;
    if (payFilter.size && !payFilter.has(String(r.payment_method || ''))) return false;
    if (prodFilter.size && !prodFilter.has(String(r.product_name || ''))) return false;
    if (q) {
      const hay = [
        r.product_name, r.product_code, r.ncm, r.customer_name, r.seller_name,
        r.instance_name, r.order_number, r.invoice_number, r.cfop, cfopName(r.cfop), r.customer_city,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => matches(r, q, false));
  }, [rows, search, instFilter, sellerFilter, customerFilter, opFilter, stageFilter, cfopFilter, cityFilter, payFilter, prodFilter]);

  // Base dos chips de CFOP: todos os filtros MENOS o próprio filtro de CFOP —
  // senão, ao selecionar um chip, os demais sumiriam e a multi-seleção morre.
  const filteredExceptCfop = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => matches(r, q, true));
  }, [rows, search, instFilter, sellerFilter, customerFilter, opFilter, stageFilter, cityFilter, payFilter, prodFilter]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const orders = new Set<string>();
    const customers = new Set<string>();
    const products = new Set<string>();
    let qty = 0, value = 0, trocaQty = 0, trocaValue = 0;
    for (const r of filtered) {
      orders.add(r.pipeline_id);
      customers.add(r.customer_id);
      products.add(r.product_name);
      const q = num(r.quantity), v = num(r.total_price);
      qty += q; value += v;
      if (r.operation_type === 'troca') { trocaQty += q; trocaValue += v; }
    }
    return { orders: orders.size, customers: customers.size, products: products.size, qty, value, trocaQty, trocaValue };
  }, [filtered]);

  // Dias úteis (seg–sex) do período De→Até, limitado a hoje — divisor da
  // coluna "Saída D.U.". Feriados não entram na conta (simplificação).
  const diasUteis = useMemo(() => {
    const hoje = new Date().toISOString().slice(0, 10);
    const fim = ate < hoje ? ate : hoje;
    let n = 0;
    for (let t = Date.parse(de + 'T12:00:00Z'); t <= Date.parse(fim + 'T12:00:00Z'); t += 86400000) {
      const dow = new Date(t).getUTCDay();
      if (dow >= 1 && dow <= 5) n++;
    }
    return Math.max(1, n);
  }, [de, ate]);

  // ── Série temporal (dia até 62 dias de intervalo; acima disso, mês) ──────
  const byMonth = useMemo(() => {
    const span = Math.round((Date.parse(ate) - Date.parse(de)) / 86400000);
    return span > 62;
  }, [de, ate]);

  const serie = useMemo(() => {
    const map = new Map<string, { valor: number; qtd: number }>();
    for (const r of filtered) {
      const b = byMonth ? r.data.slice(0, 7) : r.data;
      const cur = map.get(b) || { valor: 0, qtd: 0 };
      cur.valor += num(r.total_price); cur.qtd += num(r.quantity);
      map.set(b, cur);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, label: fmtBucket(bucket), ...v }));
  }, [filtered, byMonth]);

  // ── Agregações p/ gráficos ───────────────────────────────────────────────
  const aggBy = (keyFn: (r: ItemRow) => string, labelMap?: Record<string, string>) => {
    const map = new Map<string, { valor: number; qtd: number }>();
    for (const r of filtered) {
      const k = keyFn(r) || '—';
      const cur = map.get(k) || { valor: 0, qtd: 0 };
      cur.valor += num(r.total_price); cur.qtd += num(r.quantity);
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .map(([k, v]) => ({ key: k, name: labelMap?.[k] || k, ...v }))
      .sort((a, b) => (metric === 'valor' ? b.valor - a.valor : b.qtd - a.qtd));
  };

  const byOperation = useMemo(() => aggBy((r) => String(r.operation_type || 'outros'), OPERATION_LABELS), [filtered, metric]);
  const byInstance = useMemo(() => aggBy((r) => String(r.instance_name || '—')), [filtered, metric]);
  const bySeller = useMemo(() => aggBy((r) => String(r.seller_name || '—')).slice(0, 8), [filtered, metric]);
  const byCustomer = useMemo(() => aggBy((r) => String(r.customer_name || '—')).slice(0, 8), [filtered, metric]);
  const byCfop = useMemo(() => {
    const map = new Map<string, { valor: number; qtd: number }>();
    for (const r of filteredExceptCfop) {
      const k = cfopKeyOf(r);
      const cur = map.get(k) || { valor: 0, qtd: 0 };
      cur.valor += num(r.total_price); cur.qtd += num(r.quantity);
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .map(([k, v]) => ({ key: k, name: k, ...v }))
      .sort((a, b) => (metric === 'valor' ? b.valor - a.valor : b.qtd - a.qtd));
  }, [filteredExceptCfop, metric]);

  // ── Agregação por produto (tabela + top 10) ──────────────────────────────
  const prodAgg = useMemo(() => {
    const map = new Map<string, ProdAgg>();
    for (const r of filtered) {
      const k = r.product_name;
      let a = map.get(k);
      if (!a) {
        a = { key: k, name: r.product_name, code: r.product_code, ncm: r.ncm, qty: 0, value: 0, orders: new Set(), customers: new Set(), trocaQty: 0, trocaValue: 0 };
        map.set(k, a);
      }
      if (!a.code && r.product_code) a.code = r.product_code;
      if (!a.ncm && r.ncm) a.ncm = r.ncm;
      const q = num(r.quantity), v = num(r.total_price);
      a.qty += q; a.value += v;
      a.orders.add(r.pipeline_id); a.customers.add(r.customer_id);
      if (r.operation_type === 'troca') { a.trocaQty += q; a.trocaValue += v; }
    }
    return Array.from(map.values());
  }, [filtered]);

  const topProducts = useMemo(
    () => [...prodAgg].sort((a, b) => (metric === 'valor' ? b.value - a.value : b.qty - a.qty)).slice(0, 10)
      .map((p) => ({ name: p.name, valor: p.value, qtd: p.qty })),
    [prodAgg, metric],
  );

  const sortedProds = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (p: ProdAgg): string | number => {
      switch (sortKey) {
        case 'product': return p.name.toLowerCase();
        case 'code': return String(p.code || '').toLowerCase();
        case 'qty': case 'saidaDU': return p.qty;
        case 'value': case 'share': return p.value;
        case 'orders': return p.orders.size;
        case 'customers': return p.customers.size;
        case 'avgPrice': return p.qty > 0 ? p.value / p.qty : 0;
        case 'trocaQty': return p.trocaQty;
      }
    };
    return [...prodAgg].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'pt-BR') * dir;
    });
  }, [prodAgg, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'product' || k === 'code' ? 'asc' : 'desc'); }
  };

  // ── Detalhe de um produto (dialog) ───────────────────────────────────────
  const detailRows = useMemo(
    () => (detailProduct ? filtered.filter((r) => r.product_name === detailProduct) : []),
    [filtered, detailProduct],
  );
  const detailAgg = (keyFn: (r: ItemRow) => string, labels?: Record<string, string>) => {
    const map = new Map<string, { valor: number; qtd: number }>();
    for (const r of detailRows) {
      const k = keyFn(r) || '—';
      const cur = map.get(k) || { valor: 0, qtd: 0 };
      cur.valor += num(r.total_price); cur.qtd += num(r.quantity);
      map.set(k, cur);
    }
    return Array.from(map.entries()).map(([k, v]) => ({ name: labels?.[k] || k, ...v }))
      .sort((a, b) => b.valor - a.valor);
  };

  // ── Export CSV ───────────────────────────────────────────────────────────
  const downloadCsv = (name: string, head: string[], lines: any[][]) => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + [head, ...lines].map((r) => r.map(esc).join(';')).join('\r\n');
    const csvUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = csvUrl; a.download = name; a.click();
    URL.revokeObjectURL(csvUrl);
  };

  const nBR = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');

  const exportProdutos = () => downloadCsv(
    `produtos-comercializados-${de}-a-${ate}.csv`,
    ['Produto', 'Código', 'NCM', 'Quantidade', `Saída por dia útil (${diasUteis} d.u.)`, 'Valor', '% do valor', 'Pedidos', 'Clientes', 'Preço médio', 'Qtd em trocas', 'Valor em trocas'],
    sortedProds.map((p) => [
      p.name, p.code || '', p.ncm || '', nBR(p.qty), nBR(Math.round((p.qty / diasUteis) * 10) / 10), nBR(p.value),
      kpis.value > 0 ? nBR((p.value / kpis.value) * 100) : '0',
      p.orders.size, p.customers.size, nBR(p.qty > 0 ? p.value / p.qty : 0),
      nBR(p.trocaQty), nBR(p.trocaValue),
    ]),
  );

  const exportDetalhado = () => downloadCsv(
    `produtos-comercializados-detalhado-${de}-a-${ate}.csv`,
    ['Data', 'Produto', 'Código', 'NCM', 'Quantidade', 'Valor unit.', 'Valor total', 'Operação', 'Etapa', 'Cliente', 'Cidade', 'Vendedor', 'Instância', 'Pedido', 'NF', 'CFOP', 'Nome do CFOP', 'Status fiscal', 'Pagamento'],
    filtered.map((r) => [
      fmtBucket(r.data), r.product_name, r.product_code || '', r.ncm || '',
      nBR(num(r.quantity)), nBR(num(r.unit_price)), nBR(num(r.total_price)),
      OPERATION_LABELS[String(r.operation_type || '')] || r.operation_type || '',
      STAGE_LABELS[r.stage] || r.stage,
      r.customer_name, r.customer_city || '', r.seller_name || '', r.instance_name || '',
      r.order_number || '', r.invoice_number || '', r.cfop || '', cfopName(r.cfop),
      FISCAL_LABELS[String(r.fiscal_status || '')] || r.fiscal_status || '',
      PAYMENT_LABELS[String(r.payment_method || '')] || r.payment_method || '',
    ]),
  );

  const Th = ({ k, children, className = '' }: { k?: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`px-2 py-2 text-left font-semibold whitespace-nowrap ${k ? 'cursor-pointer select-none hover:text-teal-700' : ''} ${className}`}
        onClick={k ? () => toggleSort(k) : undefined}
        data-testid={k ? `th-prod-${k}` : undefined}>
      <span className="inline-flex items-center gap-1">
        {children}
        {k && (sortKey === k
          ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ArrowDownUp className="h-3 w-3 text-gray-300" />)}
      </span>
    </th>
  );

  const metricKey = metric === 'valor' ? 'valor' : 'qtd';
  const fmtMetric = metric === 'valor' ? fmtBRL : fmtQtd;
  const fmtMetricAxis = metric === 'valor' ? fmtBRLc : fmtQtd;

  const kpiCards = [
    { label: 'Valor comercializado', value: fmtBRL(kpis.value), testid: 'kpi-valor' },
    { label: 'Quantidade (itens)', value: fmtQtd(kpis.qty), testid: 'kpi-qtd' },
    { label: 'Pedidos', value: kpis.orders.toLocaleString('pt-BR'), testid: 'kpi-pedidos' },
    { label: 'Produtos distintos', value: kpis.products.toLocaleString('pt-BR'), testid: 'kpi-produtos' },
    { label: 'Clientes atendidos', value: kpis.customers.toLocaleString('pt-BR'), testid: 'kpi-clientes' },
    { label: 'Trocas', value: `${fmtQtd(kpis.trocaQty)} un · ${fmtBRL(kpis.trocaValue)}`, testid: 'kpi-trocas' },
  ];

  return (
    <div className="bg-gray-50 dark:bg-gray-900 min-h-[calc(100vh-56px)]">
      <div className="p-4 max-w-[1600px] mx-auto">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <BackToDashboardButton />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="h-6 w-6 text-teal-600" />
              Produtos Comercializados
            </h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-sm" data-testid="badge-total-itens">
              {filtered.length.toLocaleString('pt-BR')} itens de {kpis.orders.toLocaleString('pt-BR')} pedidos
            </Badge>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-atualizar-gestao-produtos">
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Atualizar
            </Button>
            <Button variant="outline" size="sm" onClick={exportProdutos} data-testid="button-exportar-produtos">
              <Download className="h-4 w-4 mr-1" /> Produtos
            </Button>
            <Button variant="outline" size="sm" onClick={exportDetalhado} data-testid="button-exportar-detalhado">
              <Download className="h-4 w-4 mr-1" /> Detalhado
            </Button>
          </div>
        </div>

        {/* Período + filtros */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-500">De</span>
            <Input type="date" value={de} onChange={(e) => e.target.value && setDe(e.target.value)} className="h-9 w-[140px]" data-testid="input-gestao-de" />
            <span className="text-gray-500">até</span>
            <Input type="date" value={ate} onChange={(e) => e.target.value && setAte(e.target.value)} className="h-9 w-[140px]" data-testid="input-gestao-ate" />
          </div>
          <div className="flex items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => { setDe(isoShift(p.days)); setAte(isoShift(0)); }}
                className="h-9 px-2.5 text-xs border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 hover:border-teal-500 whitespace-nowrap"
                data-testid={`preset-${p.label.replace(/\s/g, '')}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center border rounded-md overflow-hidden h-9 bg-white dark:bg-gray-800 dark:border-gray-600">
            {(['valor', 'qtd'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 h-full text-xs font-medium ${metric === m ? 'bg-teal-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}
                data-testid={`toggle-metric-${m}`}
              >
                {m === 'valor' ? 'Valor (R$)' : 'Quantidade'}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Produto, cliente, NF, CFOP..."
              className="pl-8 h-9"
              data-testid="input-search-gestao-produtos"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">×</button>
            )}
          </div>
          <MultiSelectFilter label="Produto" options={prodOptions} selected={prodFilter} onToggle={toggleInSet(setProdFilter)} onClear={() => setProdFilter(new Set())} testid="filtro-gp-produto" searchable />
          <MultiSelectFilter label="Instância" options={instOptions} selected={instFilter} onToggle={toggleInSet(setInstFilter)} onClear={() => setInstFilter(new Set())} testid="filtro-gp-instancia" />
          <MultiSelectFilter label="Vendedor" options={sellerOptions} selected={sellerFilter} onToggle={toggleInSet(setSellerFilter)} onClear={() => setSellerFilter(new Set())} testid="filtro-gp-vendedor" searchable />
          <MultiSelectFilter label="Cliente" options={customerOptions} selected={customerFilter} onToggle={toggleInSet(setCustomerFilter)} onClear={() => setCustomerFilter(new Set())} testid="filtro-gp-cliente" searchable />
          <MultiSelectFilter label="Operação" options={opOptions} selected={opFilter} onToggle={toggleInSet(setOpFilter)} onClear={() => setOpFilter(new Set())} testid="filtro-gp-operacao" />
          <MultiSelectFilter label="Etapa" options={stageOptions} selected={stageFilter} onToggle={toggleInSet(setStageFilter)} onClear={() => setStageFilter(new Set())} testid="filtro-gp-etapa" />
          <MultiSelectFilter label="CFOP" options={cfopOptions} selected={cfopFilter} onToggle={toggleInSet(setCfopFilter)} onClear={() => setCfopFilter(new Set())} testid="filtro-gp-cfop" searchable />
          <MultiSelectFilter label="Cidade" options={cityOptions} selected={cityFilter} onToggle={toggleInSet(setCityFilter)} onClear={() => setCityFilter(new Set())} testid="filtro-gp-cidade" searchable />
          <MultiSelectFilter label="Pagamento" options={payOptions} selected={payFilter} onToggle={toggleInSet(setPayFilter)} onClear={() => setPayFilter(new Set())} testid="filtro-gp-pagamento" />
          {activeFilters > 0 && (
            <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-gp-limpar-filtros">
              Limpar filtros ×
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-60 text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando itens comercializados...
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 mb-3">
              {kpiCards.map((k) => (
                <div key={k.label} className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg p-3" data-testid={k.testid}>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">{k.label}</p>
                  <p className="text-lg font-bold text-gray-900 dark:text-white leading-tight">{k.value}</p>
                </div>
              ))}
            </div>

            {/* Evolução no período */}
            <ChartCard
              title={`Evolução no período — ${metric === 'valor' ? 'valor comercializado' : 'quantidade'}`}
              subtitle={byMonth ? 'agrupado por mês' : 'agrupado por dia'}
              className="mb-3"
            >
              <div className="h-56">
                <ResponsiveContainer>
                  <AreaChart data={serie} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gpFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={MAIN} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={MAIN} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => fmtMetricAxis(v).replace(/ /g, '\u00A0')} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v: any) => [fmtMetric(Number(v)), metric === 'valor' ? 'Valor' : 'Quantidade']}
                      labelFormatter={(l: any) => (byMonth ? `Mês ${l}` : `Dia ${l}`)}
                    />
                    <Area type="monotone" dataKey={metricKey} stroke={MAIN} strokeWidth={2} fill="url(#gpFill)" dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            {/* Top produtos + operação */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
              <ChartCard title={`Top 10 produtos por ${metric === 'valor' ? 'valor' : 'quantidade'}`} className="lg:col-span-2">
                <div style={{ height: Math.max(220, topProducts.length * 30 + 30) }}>
                  <ResponsiveContainer>
                    <BarChart data={topProducts} layout="vertical" margin={{ top: 4, right: 64, left: 4, bottom: 0 }} barCategoryGap={6}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: any) => [fmtMetric(Number(v)), metric === 'valor' ? 'Valor' : 'Quantidade']}
                      />
                      <Bar dataKey={metricKey} fill={MAIN} radius={[0, 4, 4, 0]} maxBarSize={18}>
                        <LabelList dataKey={metricKey} position="right" formatter={(v: any) => fmtMetricAxis(Number(v))} style={{ fontSize: 11, fill: '#374151' }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>

              <ChartCard title="Por tipo de operação" subtitle="venda, troca, amostra...">
                <div className="h-44">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie
                        data={byOperation}
                        dataKey={metricKey}
                        nameKey="name"
                        innerRadius="55%"
                        outerRadius="85%"
                        paddingAngle={2}
                        stroke="#fff"
                        strokeWidth={2}
                      >
                        {byOperation.map((o) => (
                          <Cell key={o.key} fill={OPERATION_COLORS[o.key] || GRAY} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [fmtMetric(Number(v)), n]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 space-y-1">
                  {byOperation.map((o) => {
                    const total = byOperation.reduce((s, x) => s + (metric === 'valor' ? x.valor : x.qtd), 0);
                    const v = metric === 'valor' ? o.valor : o.qtd;
                    const pct = total > 0 ? (v / total) * 100 : 0;
                    return (
                      <div key={o.key} className="flex items-center gap-2 text-xs">
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: OPERATION_COLORS[o.key] || GRAY }} />
                        <span className="flex-1 truncate text-gray-700 dark:text-gray-200">{o.name}</span>
                        <span className="text-gray-500">{pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
                        <span className="font-medium text-gray-800 dark:text-gray-100 tabular-nums">{fmtMetric(v)}</span>
                      </div>
                    );
                  })}
                  {byOperation.length === 0 && <p className="text-xs text-gray-400">Sem dados no período.</p>}
                </div>
              </ChartCard>
            </div>

            {/* Instância · Vendedores · Clientes */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
              {[
                { title: 'Por instância', data: byInstance.slice(0, 8), testid: 'chart-instancia' },
                { title: 'Top vendedores', data: bySeller, testid: 'chart-vendedores' },
                { title: 'Top clientes', data: byCustomer, testid: 'chart-clientes' },
              ].map((c) => (
                <ChartCard key={c.title} title={`${c.title} — ${metric === 'valor' ? 'valor' : 'quantidade'}`}>
                  <div style={{ height: Math.max(160, c.data.length * 28 + 20) }} data-testid={c.testid}>
                    <ResponsiveContainer>
                      <BarChart data={c.data} layout="vertical" margin={{ top: 4, right: 60, left: 4, bottom: 0 }} barCategoryGap={6}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [fmtMetric(Number(v)), metric === 'valor' ? 'Valor' : 'Quantidade']} />
                        <Bar dataKey={metricKey} fill={MAIN} radius={[0, 4, 4, 0]} maxBarSize={16}>
                          <LabelList dataKey={metricKey} position="right" formatter={(v: any) => fmtMetricAxis(Number(v))} style={{ fontSize: 10, fill: '#374151' }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>
              ))}
            </div>

            {/* CFOPs presentes — chips clicáveis: selecionam/desmarcam o CFOP no filtro */}
            {byCfop.length > 0 && (
              <ChartCard title={`Por CFOP — ${metric === 'valor' ? 'valor' : 'quantidade'}`} subtitle="CFOP do cabeçalho da NF-e vinculada ao pedido; itens sem NF aparecem como 'sem NF'. Clique num CFOP para filtrar o relatório por ele (pode marcar vários)." className="mb-3">
                <div className="flex flex-wrap gap-2">
                  {byCfop.map((c) => {
                    const sel = cfopFilter.has(c.key);
                    const nome = c.key === 'sem NF' ? 'pedido ainda sem NF-e vinculada' : cfopName(c.key);
                    return (
                      <button
                        key={c.key}
                        onClick={() => toggleInSet(setCfopFilter)(c.key)}
                        title={sel ? 'Clique para desmarcar' : 'Clique para filtrar por este CFOP'}
                        data-testid={`chip-cfop-${c.key.replace(/\D/g, '') || 'semnf'}`}
                        className={`text-left border rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                          sel
                            ? 'border-teal-600 bg-teal-50 dark:bg-teal-900/30 ring-1 ring-teal-500'
                            : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40 hover:border-teal-400'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={`font-semibold ${sel ? 'text-teal-800 dark:text-teal-200' : 'text-gray-800 dark:text-gray-100'}`}>{c.name}</span>
                          <span className="text-gray-500">{fmtMetric(metric === 'valor' ? c.valor : c.qtd)}</span>
                          {sel && <span className="text-teal-600 font-bold">✓</span>}
                        </span>
                        {nome && <span className="block text-[11px] text-gray-500 dark:text-gray-400 max-w-[260px]">{nome}</span>}
                      </button>
                    );
                  })}
                  {cfopFilter.size > 0 && (
                    <button
                      onClick={() => setCfopFilter(new Set())}
                      className="border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1.5 text-xs text-blue-600 hover:underline"
                      data-testid="chip-cfop-limpar"
                    >
                      Limpar CFOPs ×
                    </button>
                  )}
                </div>
              </ChartCard>
            )}

            {/* Tabela por produto */}
            <div className="border rounded-lg bg-white dark:bg-gray-800 overflow-auto max-h-[560px]">
              <table className="w-full text-xs" data-testid="tabela-produtos-comercializados">
                <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 shadow-sm">
                  <tr>
                    <Th k="product">Produto</Th>
                    <Th k="code">Código</Th>
                    <Th k="qty" className="text-right">Quantidade</Th>
                    <Th k="saidaDU" className="text-right">
                      <span title={`Quantidade ÷ dias úteis (seg–sex) do período: ${diasUteis} dia(s) útil(eis)`}>Saída D.U.</span>
                    </Th>
                    <Th k="value" className="text-right">Valor</Th>
                    <Th k="share" className="text-right">% do valor</Th>
                    <Th k="orders" className="text-right">Pedidos</Th>
                    <Th k="customers" className="text-right">Clientes</Th>
                    <Th k="avgPrice" className="text-right">Preço médio</Th>
                    <Th k="trocaQty" className="text-right">Trocas (qtd)</Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProds.length === 0 && (
                    <tr><td colSpan={10} className="text-center text-gray-500 py-8">Nenhum item para os filtros aplicados.</td></tr>
                  )}
                  {sortedProds.map((p) => (
                    <tr
                      key={p.key}
                      className="border-t hover:bg-teal-50/60 dark:hover:bg-gray-700/50 cursor-pointer"
                      onClick={() => setDetailProduct(p.name)}
                      data-testid={`linha-produto-${p.key}`}
                    >
                      <td className="px-2 py-1.5 font-medium max-w-[280px]"><span className="block truncate" title={p.name}>{p.name}</span></td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-600 dark:text-gray-300">{p.code || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtQtd(p.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-teal-700 dark:text-teal-300" title={`${fmtQtd(p.qty)} un ÷ ${diasUteis} dia(s) útil(eis)`}>
                        {(p.qty / diasUteis).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtBRL(p.value)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-300">
                        {kpis.value > 0 ? `${((p.value / kpis.value) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.orders.size}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.customers.size}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtBRL(p.qty > 0 ? p.value / p.qty : 0)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {p.trocaQty > 0 ? <span className="text-orange-600 font-medium">{fmtQtd(p.trocaQty)}</span> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-xs text-gray-500">
              Fonte: pedidos do Pipeline de Faturamento (todas as etapas, exceto lixeira), explodidos por item.
              CFOP e status fiscal vêm da NF-e vinculada ao pedido quando ela existe. Clique numa linha para o
              detalhamento do produto por cliente, vendedor e instância.
            </p>
          </>
        )}
      </div>

      {/* Detalhe do produto */}
      <Dialog open={!!detailProduct} onOpenChange={(o) => !o && setDetailProduct(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4 text-teal-600" /> {detailProduct}
            </DialogTitle>
          </DialogHeader>
          {detailProduct && (
            <div className="text-sm space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {(() => {
                  const q = detailRows.reduce((s, r) => s + num(r.quantity), 0);
                  const v = detailRows.reduce((s, r) => s + num(r.total_price), 0);
                  const tq = detailRows.filter((r) => r.operation_type === 'troca').reduce((s, r) => s + num(r.quantity), 0);
                  const cli = new Set(detailRows.map((r) => r.customer_id)).size;
                  return [
                    { l: 'Quantidade', v: fmtQtd(q) },
                    { l: 'Valor', v: fmtBRL(v) },
                    { l: 'Clientes', v: String(cli) },
                    { l: 'Em trocas', v: fmtQtd(tq) },
                  ].map((k) => (
                    <div key={k.l} className="bg-gray-50 dark:bg-gray-700/40 rounded-md p-2">
                      <p className="text-[11px] text-gray-500">{k.l}</p>
                      <p className="font-bold">{k.v}</p>
                    </div>
                  ));
                })()}
              </div>
              {[
                { title: 'Por cliente (top 15)', rows: detailAgg((r) => r.customer_name).slice(0, 15) },
                { title: 'Por vendedor', rows: detailAgg((r) => String(r.seller_name || '—')) },
                { title: 'Por instância', rows: detailAgg((r) => String(r.instance_name || '—')) },
                { title: 'Por operação', rows: detailAgg((r) => String(r.operation_type || '—'), OPERATION_LABELS) },
                { title: 'Por CFOP', rows: detailAgg((r) => (r.cfop ? cfopFull(String(r.cfop)) : 'sem NF')) },
              ].map((sec) => (
                <div key={sec.title}>
                  <p className="font-semibold mb-1">{sec.title}</p>
                  <table className="w-full text-xs border">
                    <thead className="bg-gray-100 dark:bg-gray-700">
                      <tr>
                        <th className="px-2 py-1 text-left">Nome</th>
                        <th className="px-2 py-1 text-right">Quantidade</th>
                        <th className="px-2 py-1 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.rows.map((r, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1">{r.name}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtQtd(r.qtd)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtBRL(r.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
