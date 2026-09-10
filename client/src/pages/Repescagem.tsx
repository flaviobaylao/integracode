import { useState, useMemo } from 'react';
import { hojeBR, inicioDoMes } from '@shared/tempo';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Loader2, Search, AlertTriangle, RefreshCw, Calendar, Headphones,
  Users as UsersIcon, History, BarChart3, UserCheck, Lock, LockOpen,
  ChevronUp, ChevronDown,
} from 'lucide-react';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { Button } from '@/components/ui/button';
import VirtualServiceLogModal from '@/components/VirtualServiceLogModal';
import WhatsAppIconLink from '@/components/WhatsAppIconLink';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import RepescagemRulesInfo from '@/components/RepescagemRulesInfo';
import { ScrollArea } from '@/components/ui/scroll-area';
import { queryClient, apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';

type CarteiraCoverage = { sellerId: string; sellerName: string; total: number; assigned: number; pct: number };
type Attendant = {
  userId: string;
  name: string;
  role: string;
  isEnabled: boolean;
  enabledAt: string | null;
  carteiras?: string[];
  carteiraPcts?: Record<string, number>;
  coverage?: CarteiraCoverage[];
};
type Carteira = { sellerId: string; name: string; role: string };

type Assignment = {
  assignmentId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string | null;
  customerCity?: string | null;
  customerNeighborhood?: string | null;
  customerUf?: string | null;
  sellerId: string | null;
  sellerName: string | null;
  periodicity: string;
  weekdays: string[];
  lastRedDate: string;
  daysSince: number;
  assignedUserId: string;
  assignedUserName: string;
  assignedAt: string;
  unassigned?: boolean;
  locked?: boolean;
  lockedBy?: string | null;
  canUnlock?: boolean;
};

type HistoryEntry = {
  id: string;
  customerId: string;
  fromUserId: string | null;
  toUserId: string | null;
  fromUserName: string | null;
  toUserName: string | null;
  action: 'assigned' | 'reassigned' | 'completed' | 'cancelled';
  reason: string | null;
  createdAt: string;
};

const PERIODICITY_LABELS: Record<string, string> = {
  semanal: 'Semanal', quinzenal: 'Quinzenal', mensal: 'Mensal', bimestral: 'Bimestral',
};

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  assigned: { label: 'Atribuído', color: 'bg-blue-100 text-blue-800' },
  reassigned: { label: 'Reatribuído', color: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Concluído', color: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelado', color: 'bg-gray-100 text-gray-700' },
};

function formatDateBR(dateStr: string) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateTimeBR(iso: string) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo',  dateStyle: 'short', timeStyle: 'short' });
}

export default function Repescagem() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [searchCustomer, setSearchCustomer] = useState('');
  const [filterAttendant, setFilterAttendant] = useState('all');
  const [filterSeller, setFilterSeller] = useState('all');
  const [filterCity, setFilterCity] = useState('all');
  const [filterNeighborhood, setFilterNeighborhood] = useState('all');
  const [filterPeriodicity, setFilterPeriodicity] = useState('all');
  const [filterAssignStatus, setFilterAssignStatus] = useState('all');
  // Ordenacao A-Z / Z-A por coluna (clique no cabecalho).
  const [sortKey, setSortKey] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [serviceLogTarget, setServiceLogTarget] = useState<{ id: string; name: string } | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<{ id: string; name: string } | null>(null);

  // Estatísticas: período
  // Mes corrente em dias de calendario do Brasil. new Date(ano, mes, 1).toISOString()
  // usava o fuso do navegador e, a leste de UTC, virava dia 31 do mes anterior.
  const [statsStart, setStatsStart] = useState(inicioDoMes(hojeBR()));
  const [statsEnd, setStatsEnd] = useState(hojeBR());
  // Recolher/expandir a seção de Atendentes habilitados (a lista é grande).
  const [attendantsCollapsed, setAttendantsCollapsed] = useState(false);
  // Selecao multipla (por customerId) + alteracao em massa de atendente.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAttendant, setBulkAttendant] = useState<string>('');

  const { data: attendants = [], isLoading: loadingAttendants } = useQuery<Attendant[]>({
    queryKey: ['/api/repescagem/attendants'],
  });
  const { data: assignments = [], isLoading: loadingAssignments, isError, error, refetch, isFetching } = useQuery<Assignment[]>({
    queryKey: ['/api/repescagem/assignments'],
  });
  const { data: stats } = useQuery<{ total: number; perUser: { userId: string; userName: string; count: number }[] }>({
    queryKey: [`/api/repescagem/stats?startDate=${statsStart}&endDate=${statsEnd}`],
    enabled: !!statsStart && !!statsEnd,
  });
  const { data: historyData = [], isLoading: loadingHistory } = useQuery<HistoryEntry[]>({
    queryKey: [`/api/repescagem/history/${historyCustomer?.id}`],
    enabled: !!historyCustomer?.id,
  });

  // Atendentes de repescagem = SOMENTE telemarketing. Os vendedores externos já recebem os
  // próprios clientes na rota do dia (perímetro), então não entram no painel nem nos seletores.
  const panelAttendants = attendants.filter(a => a.role === 'telemarketing');
  const enabledAttendants = panelAttendants.filter(a => a.isEnabled);
  const isAdmin = user?.role === 'admin';

  // Repescagem2: somente administradores habilitam/desabilitam atendentes.
  const toggleAttendant = useMutation({
    mutationFn: async ({ userId, isEnabled }: { userId: string; isEnabled: boolean }) =>
      apiRequest('POST', `/api/repescagem/attendants/${userId}`, { isEnabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/attendants'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/assignments'] });
      toast({ title: 'Atualizado', description: 'Disponibilidade do atendente atualizada.' });
    },
    onError: (e: any) => {
      toast({ title: 'Erro', description: e?.message || 'Falha ao atualizar', variant: 'destructive' });
    },
  });

  // Carteiras (fontes) selecionáveis = vendedores/telemarketing ativos.
  const { data: carteiras = [] } = useQuery<Carteira[]>({
    queryKey: ['/api/repescagem/carteiras'],
  });

  // Salvar as carteiras de repescagem de um atendente (admin).
  const saveCarteiras = useMutation({
    mutationFn: async ({ userId, carteiras }: { userId: string; carteiras: string[] }) =>
      apiRequest('POST', `/api/repescagem/attendants/${userId}/carteiras`, { carteiras }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/attendants'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/assignments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/route-overlay'] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
      toast({ title: 'Carteiras atualizadas', description: 'Roteamento da repescagem recalculado.' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao salvar carteiras', variant: 'destructive' }),
  });

  // Define o % (10..100) de uma carteira para um atendente (rateio quando 2+ recebem a carteira).
  const setCarteiraPct = useMutation({
    mutationFn: async ({ userId, sellerId, pct }: { userId: string; sellerId: string; pct: number }) =>
      apiRequest('POST', `/api/repescagem/attendants/${userId}/carteira-pct`, { sellerId, pct }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/attendants'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/assignments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/repescagem/route-overlay'] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
      toast({ title: '% atualizado', description: 'Rateio da carteira recalculado.' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao definir %', variant: 'destructive' }),
  });

  // Adiciona/remove uma carteira do atendente (envia a lista inteira atualizada).
  const carteiraNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of carteiras) m.set(c.sellerId, c.name);
    return m;
  }, [carteiras]);

  // Invalida tudo que depende da distribuição (lista + rota do dia + rotas).
  const invalidateDistribution = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/assignments'] });
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/attendants'] });
    queryClient.invalidateQueries({ queryKey: ['/api/repescagem/route-overlay'] });
    queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
  };

  // Botão "Atualizar" (admin): dispara todas as regras de novo, olhando os habilitados,
  // preservando as linhas travadas do dia, e ajusta a rota do dia.
  const redistribute = useMutation({
    mutationFn: async () => apiRequest('POST', '/api/repescagem/redistribute', {}),
    onSuccess: () => { invalidateDistribution(); refetch(); toast({ title: 'Repescagem atualizada', description: 'Distribuição refeita entre os atendentes habilitados (linhas travadas preservadas).' }); },
    onError: (e: any) => toast({ title: 'Erro ao atualizar', description: e?.message || 'Tente novamente.', variant: 'destructive' }),
  });

  // Trocar o atendente de uma linha (admin) — trava a linha automaticamente.
  const reassign = useMutation({
    mutationFn: async ({ assignmentId, toUserId }: { assignmentId: string; toUserId: string }) =>
      apiRequest('POST', `/api/repescagem/assignments/${assignmentId}/reassign`, { toUserId }),
    onSuccess: () => { invalidateDistribution(); refetch(); toast({ title: 'Atendente alterado', description: 'Atendente atualizado (sem trava).' }); },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao reatribuir', variant: 'destructive' }),
  });

  // Alteração EM MASSA de atendente para os clientes selecionados.
  const bulkAssign = useMutation({
    mutationFn: async ({ toUserId, customerIds }: { toUserId: string; customerIds: string[] }) =>
      apiRequest('POST', '/api/repescagem/assignments/bulk-assign', { toUserId, customerIds }),
    onSuccess: (r: any) => {
      invalidateDistribution(); refetch();
      setSelectedIds(new Set()); setBulkAttendant('');
      toast({ title: 'Atendente alterado em massa', description: `${r?.total ?? 0} cliente(s) atualizado(s).` });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha na alteração em massa', variant: 'destructive' }),
  });

  // Atribuir um cliente SEM atendente (admin) — cria a alocação e trava no dia.
  const assign = useMutation({
    mutationFn: async ({ customerId, toUserId, lastRedDate }: { customerId: string; toUserId: string; lastRedDate: string }) =>
      apiRequest('POST', '/api/repescagem/assign', { customerId, toUserId, lastRedDate }),
    onSuccess: () => { invalidateDistribution(); refetch(); toast({ title: 'Cliente atribuído', description: 'Atendente atribuído (sem trava).' }); },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao atribuir', variant: 'destructive' }),
  });

  // Travar / destravar uma linha (admin).
  const toggleLock = useMutation({
    mutationFn: async ({ assignmentId, locked }: { assignmentId: string; locked: boolean }) =>
      apiRequest('POST', `/api/repescagem/assignments/${assignmentId}/lock`, { locked }),
    onSuccess: () => { invalidateDistribution(); refetch(); },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao travar', variant: 'destructive' }),
  });

  // Travar / destravar TODAS as linhas do dia (admin) — cadeado do cabeçalho.
  const toggleLockAll = useMutation({
    mutationFn: async (locked: boolean) => apiRequest('POST', '/api/repescagem/assignments/lock-all', { locked }),
    onSuccess: (_d, locked) => { invalidateDistribution(); refetch(); toast({ title: locked ? 'Tudo travado' : 'Tudo destravado', description: locked ? 'Nenhuma linha será redistribuída hoje.' : 'As linhas voltam a ser redistribuídas.' }); },
    onError: (e: any) => toast({ title: 'Erro', description: e?.message || 'Falha ao travar todos', variant: 'destructive' }),
  });

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) if (a.customerCity?.trim()) set.add(a.customerCity.trim());
    return Array.from(set).sort((x, y) => x.localeCompare(y, 'pt-BR'));
  }, [assignments]);

  const neighborhoodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) {
      if (!a.customerNeighborhood?.trim()) continue;
      if (filterCity !== 'all' && (a.customerCity?.trim() || '') !== filterCity) continue;
      set.add(a.customerNeighborhood.trim());
    }
    return Array.from(set).sort((x, y) => x.localeCompare(y, 'pt-BR'));
  }, [assignments, filterCity]);

  // Opções de Vendedor (dono da carteira) presentes na lista.
  const sellerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of assignments) {
      if (a.sellerId && a.sellerName) map.set(a.sellerId, a.sellerName);
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((x, y) => x.name.localeCompare(y.name, 'pt-BR'));
  }, [assignments]);

  const filteredAssignments = useMemo(() => {
    let f = assignments;
    if (searchCustomer.trim()) {
      const t = searchCustomer.toLowerCase();
      f = f.filter(a =>
        a.customerName.toLowerCase().includes(t) ||
        (a.customerCity?.toLowerCase().includes(t) ?? false) ||
        (a.customerNeighborhood?.toLowerCase().includes(t) ?? false)
      );
    }
    if (filterAttendant !== 'all') {
      f = f.filter(a => a.assignedUserId === filterAttendant);
    }
    if (filterSeller !== 'all') {
      f = f.filter(a => (a.sellerId || '') === filterSeller);
    }
    if (filterCity !== 'all') {
      f = f.filter(a => (a.customerCity?.trim() || '') === filterCity);
    }
    if (filterNeighborhood !== 'all') {
      f = f.filter(a => (a.customerNeighborhood?.trim() || '') === filterNeighborhood);
    }
    if (filterPeriodicity !== 'all') {
      f = f.filter(a => a.periodicity === filterPeriodicity);
    }
    if (filterAssignStatus !== 'all') {
      f = f.filter(a => filterAssignStatus === 'unassigned' ? a.unassigned : !a.unassigned);
    }
    return f;
  }, [assignments, searchCustomer, filterAttendant, filterSeller, filterCity, filterNeighborhood, filterPeriodicity, filterAssignStatus]);

  // Ordenação A-Z / Z-A por coluna. Clique alterna asc -> desc; nova coluna começa asc.
  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const sortIndicator = (key: string) => (sortKey !== key ? '↕' : sortDir === 'asc' ? '↑' : '↓');

  const sortedAssignments = useMemo(() => {
    if (!sortKey) return filteredAssignments;
    const val = (a: any): string | number => {
      switch (sortKey) {
        case 'cliente': return (a.customerName || '').toLowerCase();
        case 'cidade': return (a.customerCity || '').toLowerCase();
        case 'bairro': return (a.customerNeighborhood || '').toLowerCase();
        case 'uf': return (a.customerUf || '').toLowerCase();
        case 'vendedor': return (a.sellerName || '').toLowerCase();
        case 'periodicidade': return String(PERIODICITY_LABELS[a.periodicity] || a.periodicity || '').toLowerCase();
        case 'ultimaVisita': return a.lastRedDate || '';
        case 'dias': return typeof a.daysSince === 'number' ? a.daysSince : -1;
        case 'atendente': return (a.unassigned ? 'não atribuído' : (a.assignedUserName || '')).toLowerCase();
        default: return '';
      }
    };
    const arr = [...filteredAssignments];
    arr.sort((a, b) => {
      const va = val(a), vb = val(b);
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), 'pt-BR', { sensitivity: 'base', numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filteredAssignments, sortKey, sortDir]);

  // ----- Seleção múltipla (por customerId, sobre a lista filtrada/ordenada) -----
  const selectableIds = useMemo(() => sortedAssignments.map(a => a.customerId).filter(Boolean) as string[], [sortedAssignments]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
  const someSelected = selectedIds.size > 0 && !allSelected;
  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      if (selectableIds.every(id => prev.has(id)) && selectableIds.length > 0) {
        const n = new Set(prev); selectableIds.forEach(id => n.delete(id)); return n;
      }
      const n = new Set(prev); selectableIds.forEach(id => n.add(id)); return n;
    });
  };
  const toggleSelectOne = (customerId: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(customerId) ? n.delete(customerId) : n.add(customerId); return n; });
  };

  // Distribuição visual por atendente para a lista filtrada
  const distribution = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const a of filteredAssignments) {
      const cur = map.get(a.assignedUserId);
      if (cur) cur.count++;
      else map.set(a.assignedUserId, { name: a.assignedUserName, count: 1 });
    }
    return Array.from(map.entries()).map(([uid, v]) => ({ uid, ...v })).sort((a, b) => b.count - a.count);
  }, [filteredAssignments]);

  return (
    <div className="container mx-auto p-3 md:p-4 max-w-[1500px] space-y-3">
      <BackToDashboardButton />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RefreshCw className="h-6 w-6 text-orange-600" />
            Repescagem
            <RepescagemRulesInfo className="h-6 w-6" />
          </h1>
          <p className="text-sm text-gray-600">
            Clientes cuja última visita agendada não foi efetuada — distribuição automática entre atendentes habilitados
          </p>
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => redistribute.mutate()}
            disabled={redistribute.isPending || isFetching}
            data-testid="button-refresh"
            title="Redistribui a repescagem entre os atendentes habilitados (preserva as linhas travadas) e ajusta a rota do dia"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${(redistribute.isPending || isFetching) ? 'animate-spin' : ''}`} />
            {redistribute.isPending ? 'Atualizando...' : 'Atualizar'}
          </Button>
        )}
      </div>

      {/* Painel de habilitação + atendentes */}
      <Card className="border-indigo-300 bg-indigo-50/70 dark:bg-indigo-950/30 dark:border-indigo-900 border-l-4 border-l-indigo-500">
        <CardHeader className="pb-2">
          <button
            type="button"
            onClick={() => setAttendantsCollapsed(v => !v)}
            className="w-full flex items-center justify-between gap-2 text-left"
            aria-expanded={!attendantsCollapsed}
            title={attendantsCollapsed ? 'Expandir atendentes habilitados' : 'Recolher atendentes habilitados'}
            data-testid="toggle-attendants-collapse"
          >
            <CardTitle className="text-base flex items-center gap-2">
              <UserCheck className="h-4 w-4" />
              Atendentes e carteiras de repescagem ({enabledAttendants.length})
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-gray-300 bg-white dark:bg-gray-900 text-gray-600 shrink-0">
                {attendantsCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </span>
              <span className="text-[11px] font-normal text-gray-400">{attendantsCollapsed ? 'expandir' : 'recolher'}</span>
            </CardTitle>
            {attendantsCollapsed
              ? <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
              : <ChevronUp className="h-4 w-4 text-gray-500 shrink-0" />}
          </button>
        </CardHeader>
        {!attendantsCollapsed && (
        <CardContent className="pt-0 space-y-3">
          {loadingAttendants ? (
            <div className="text-sm text-gray-500"><Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Carregando...</div>
          ) : isAdmin ? (
            <>
              <p className="text-xs text-gray-500">
                Atendentes de repescagem são o <b>telemarketing</b>. Marque as <b>carteiras</b> que cada um recebe e escolha o
                <b> %</b> daquela carteira que ele atende (10 a 100). Quando 2+ atendentes recebem a mesma carteira, os clientes
                são rateados conforme os <b>%</b> escolhidos. O <b>atual %</b> em cinza mostra a cobertura real de hoje (resultado do rateio).
              </p>
              <p className="text-[11px] text-gray-500 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md px-2 py-1.5">
                Os <b>vendedores externos</b> não aparecem aqui: eles já recebem os próprios clientes em repescagem na
                <b> rota do dia</b> (perímetro). O telemarketing atende as carteiras marcadas abaixo (o dono também vê o
                cliente na rota pelo <b>card duplo</b>).
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {panelAttendants.map(a => {
                  const sel = a.carteiras || [];
                  const covById = new Map((a.coverage || []).map(c => [c.sellerId, c]));
                  const available = carteiras.filter(c => !sel.includes(c.sellerId));
                  return (
                  <div
                    key={a.userId}
                    className={`rounded-md border p-2 ${sel.length > 0 ? 'bg-green-50 border-green-300 dark:bg-green-900/20' : 'bg-gray-50 dark:bg-gray-800'}`}
                    data-testid={`attendant-row-${a.userId}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{a.name}</p>
                        <p className="text-[11px] text-gray-500">
                          {a.role === 'vendedor' ? 'Externo' : a.role === 'telemarketing' ? 'Telemarketing' : a.role}
                          {sel.length > 0 ? ` · ${sel.length} carteira(s)` : ' · sem carteiras'}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {sel.map(sid => {
                        const cov = covById.get(sid);
                        const nm = cov?.sellerName || carteiraNameById.get(sid) || sid;
                        const isOwn = sid === a.userId;
                        const chosenPct = (a.carteiraPcts && a.carteiraPcts[sid] != null)
                          ? a.carteiraPcts[sid]
                          : (cov && cov.total > 0 ? Math.max(10, Math.min(100, Math.round(cov.pct / 10) * 10)) : 100);
                        return (
                          <span
                            key={sid}
                            className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 dark:bg-blue-950/40 pl-2 pr-1 py-0.5 text-[11px]"
                            data-testid={`carteira-chip-${a.userId}-${sid}`}
                            title={isOwn ? 'Carteira própria (fica com o próprio atendente)' : 'Carteira recebida — escolha o % que este atendente atende (o rateio segue os %)'}
                          >
                            <span className="font-medium">{nm}{isOwn ? ' (própria)' : ''}</span>
                            {isOwn ? (
                              <span className="text-blue-700 dark:text-blue-300 font-semibold">{cov ? `${cov.pct}%` : '100%'}</span>
                            ) : (
                              <>
                                <select
                                  value={String(chosenPct)}
                                  onChange={(e) => setCarteiraPct.mutate({ userId: a.userId, sellerId: sid, pct: Number(e.target.value) })}
                                  disabled={setCarteiraPct.isPending || saveCarteiras.isPending}
                                  className="ml-0.5 rounded border border-blue-300 bg-white dark:bg-gray-900 text-blue-700 dark:text-blue-300 font-semibold text-[11px] px-0.5 py-0 cursor-pointer"
                                  title="% desta carteira que este atendente atende (10 a 100)"
                                  data-testid={`carteira-pct-${a.userId}-${sid}`}
                                >
                                  {[10,20,30,40,50,60,70,80,90,100].map(p => <option key={p} value={p}>{p}%</option>)}
                                </select>
                                {cov && cov.total > 0 && <span className="text-gray-400" title="cobertura atual (resultado do rateio)">atual {cov.pct}%</span>}
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => saveCarteiras.mutate({ userId: a.userId, carteiras: sel.filter(x => x !== sid) })}
                              disabled={saveCarteiras.isPending}
                              className="ml-0.5 h-4 w-4 inline-flex items-center justify-center rounded-full text-gray-500 hover:bg-red-100 hover:text-red-600"
                              title="Remover carteira"
                              data-testid={`carteira-remove-${a.userId}-${sid}`}
                            >×</button>
                          </span>
                        );
                      })}
                      {sel.length === 0 && <span className="text-[11px] text-gray-400">Nenhuma carteira — não recebe repescagem.</span>}
                    </div>
                    <div className="mt-2">
                      <Select
                        value=""
                        onValueChange={(v) => { if (v) saveCarteiras.mutate({ userId: a.userId, carteiras: Array.from(new Set([...sel, v])) }); }}
                        disabled={saveCarteiras.isPending || available.length === 0}
                      >
                        <SelectTrigger className="h-7 w-full text-xs" data-testid={`carteira-add-${a.userId}`}>
                          <SelectValue placeholder={available.length === 0 ? 'Todas as carteiras adicionadas' : '+ adicionar carteira…'} />
                        </SelectTrigger>
                        <SelectContent>
                          {available.map(c => (
                            <SelectItem key={c.sellerId} value={c.sellerId}>
                              {c.name}{c.sellerId === a.userId ? ' (própria)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  );
                })}
                {panelAttendants.length === 0 && (
                  <span className="text-xs text-gray-500">Nenhum atendente elegível.</span>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              {enabledAttendants.map(a => (
                <Badge
                  key={a.userId}
                  variant="outline"
                  className="text-xs bg-green-50 text-green-800 border-green-300"
                  data-testid={`badge-attendant-${a.userId}`}
                >
                  ● {a.name}
                </Badge>
              ))}
              {enabledAttendants.length === 0 && (
                <span className="text-xs text-gray-500">Nenhum atendente habilitado. Fale com um administrador.</span>
              )}
            </div>
          )}
        </CardContent>
        )}
      </Card>

      {/* Filtros */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="lg:col-span-2">
              <Label className="text-xs">Buscar Cliente</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
                <Input
                  placeholder="Nome, cidade ou bairro..."
                  className="pl-7"
                  value={searchCustomer}
                  onChange={(e) => setSearchCustomer(e.target.value)}
                  data-testid="input-search-customer"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Cidade</Label>
              <Select value={filterCity} onValueChange={(v) => { setFilterCity(v); setFilterNeighborhood('all'); }}>
                <SelectTrigger data-testid="select-city"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as cidades</SelectItem>
                  {cityOptions.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Bairro</Label>
              <Select value={filterNeighborhood} onValueChange={setFilterNeighborhood}>
                <SelectTrigger data-testid="select-neighborhood"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os bairros</SelectItem>
                  {neighborhoodOptions.map(n => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Periodicidade</Label>
              <Select value={filterPeriodicity} onValueChange={setFilterPeriodicity}>
                <SelectTrigger data-testid="select-periodicity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {Object.entries(PERIODICITY_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Atendente</Label>
              <Select value={filterAttendant} onValueChange={setFilterAttendant}>
                <SelectTrigger data-testid="select-attendant"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos atendentes</SelectItem>
                  {enabledAttendants.map(a => (
                    <SelectItem key={a.userId} value={a.userId}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Vendedor</Label>
              <Select value={filterSeller} onValueChange={setFilterSeller}>
                <SelectTrigger data-testid="select-seller"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os vendedores</SelectItem>
                  {sellerOptions.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Situação</Label>
              <Select value={filterAssignStatus} onValueChange={setFilterAssignStatus}>
                <SelectTrigger data-testid="select-assign-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="assigned">Atribuídos</SelectItem>
                  <SelectItem value="unassigned">Não atribuídos</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-xs text-gray-500">
              Distribuição:&nbsp;
              {distribution.length === 0 ? '—' : distribution.map(d => (
                <span key={d.uid} className="inline-block mr-2">
                  <strong>{d.name}</strong>: {d.count}
                </span>
              ))}
            </div>
            {(searchCustomer || filterAttendant !== 'all' || filterSeller !== 'all' || filterCity !== 'all' || filterNeighborhood !== 'all' || filterPeriodicity !== 'all' || filterAssignStatus !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setSearchCustomer('');
                  setFilterAttendant('all');
                  setFilterSeller('all');
                  setFilterCity('all');
                  setFilterNeighborhood('all');
                  setFilterPeriodicity('all');
                  setFilterAssignStatus('all');
                }}
                data-testid="button-clear-filters"
              >
                Limpar filtros
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="p-3 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-600" />
            <div>
              <p className="text-xs text-orange-700 font-medium">Para Repescar</p>
              <p className="text-lg font-bold text-orange-800" data-testid="text-total-repescagem">
                {filteredAssignments.length}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <UsersIcon className="h-5 w-5 text-sky-600" />
            <div>
              <p className="text-xs text-gray-600">Atendentes habilitados</p>
              <p className="text-lg font-bold">{enabledAttendants.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="h-4 w-4 text-purple-600" />
              <p className="text-xs font-medium">Atendimentos concluídos no período</p>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <Input type="date" value={statsStart} onChange={e => setStatsStart(e.target.value)} className="h-7 text-xs" data-testid="input-stats-start" />
              <Input type="date" value={statsEnd} onChange={e => setStatsEnd(e.target.value)} className="h-7 text-xs" data-testid="input-stats-end" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge className="bg-purple-100 text-purple-800 border border-purple-300">
                Total: {stats?.total ?? 0}
              </Badge>
              {(stats?.perUser || []).map(u => (
                <Badge key={u.userId} variant="outline" className="text-[10px]">
                  {u.userName}: {u.count}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabela */}
      {loadingAssignments ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : isError ? (
        <div className="flex items-center justify-center py-20 text-red-500">
          <AlertTriangle className="h-5 w-5 mr-2" />
          Erro ao carregar: {String((error as any)?.message || 'desconhecido')}
        </div>
      ) : filteredAssignments.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-gray-500">
            <RefreshCw className="h-10 w-10 mx-auto mb-3 text-gray-300" />
            <p className="font-medium">Nenhum cliente para repescagem</p>
            <p className="text-xs mt-1">
              {enabledAttendants.length === 0
                ? 'Não há atendentes habilitados — habilite-se acima para receber atribuições.'
                : 'Todos os clientes filtrados foram atendidos ou já tiveram a próxima visita registrada.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">{filteredAssignments.length} cliente(s) em repescagem</CardTitle>
              {isAdmin && selectedIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-orange-200 bg-orange-50 dark:bg-orange-950/30 px-2 py-1.5" data-testid="bulk-action-bar">
                  <span className="text-sm font-medium text-orange-700 dark:text-orange-300">{selectedIds.size} selecionado(s)</span>
                  <Select value={bulkAttendant} onValueChange={setBulkAttendant}>
                    <SelectTrigger className="h-8 w-[200px]" data-testid="select-bulk-attendant">
                      <SelectValue placeholder="Escolher atendente…" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledAttendants.map(e => (
                        <SelectItem key={e.userId} value={e.userId}>{e.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={!bulkAttendant || bulkAssign.isPending}
                    onClick={() => bulkAssign.mutate({ toUserId: bulkAttendant, customerIds: Array.from(selectedIds) })}
                    data-testid="button-bulk-apply"
                  >
                    {bulkAssign.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aplicar'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => { setSelectedIds(new Set()); setBulkAttendant(''); }}
                    data-testid="button-bulk-clear"
                  >
                    Limpar
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[calc(100vh-360px)]">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b shadow-sm">
                    {isAdmin && (
                      <th className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 w-8">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-orange-600"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected; }}
                          onChange={toggleSelectAll}
                          title="Selecionar todos"
                          data-testid="checkbox-select-all"
                        />
                      </th>
                    )}
                    <th onClick={() => toggleSort('cliente')} title="Ordenar A-Z" className="px-3 py-2 text-left font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center gap-1">Cliente <span className={`text-[10px] leading-none ${sortKey === 'cliente' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('cliente')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('cidade')} title="Ordenar A-Z" className="px-3 py-2 text-left font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center gap-1">Cidade <span className={`text-[10px] leading-none ${sortKey === 'cidade' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('cidade')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('bairro')} title="Ordenar A-Z" className="px-3 py-2 text-left font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center gap-1">Bairro <span className={`text-[10px] leading-none ${sortKey === 'bairro' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('bairro')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('uf')} title="Ordenar A-Z" className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center justify-center gap-1">UF <span className={`text-[10px] leading-none ${sortKey === 'uf' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('uf')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('vendedor')} title="Ordenar A-Z" className="px-3 py-2 text-left font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center gap-1">Vendedor <span className={`text-[10px] leading-none ${sortKey === 'vendedor' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('vendedor')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('periodicidade')} title="Ordenar A-Z" className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center justify-center gap-1">Periodicidade <span className={`text-[10px] leading-none ${sortKey === 'periodicidade' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('periodicidade')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('ultimaVisita')} title="Ordenar por data" className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center justify-center gap-1"><Calendar className="inline h-3.5 w-3.5 mr-0.5" />Última Visita <span className={`text-[10px] leading-none ${sortKey === 'ultimaVisita' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('ultimaVisita')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('dias')} title="Ordenar por dias" className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center justify-center gap-1">Há quantos dias <span className={`text-[10px] leading-none ${sortKey === 'dias' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('dias')}</span></span>
                    </th>
                    <th onClick={() => toggleSort('atendente')} title="Ordenar A-Z" className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700">
                      <span className="inline-flex items-center justify-center gap-1">
                        Atendente
                        <span className={`text-[10px] leading-none ${sortKey === 'atendente' ? 'text-orange-600' : 'text-gray-400'}`}>{sortIndicator('atendente')}</span>
                        {isAdmin && (() => {
                          const lockable = filteredAssignments.filter(a => !a.unassigned && a.assignmentId);
                          const allLocked = lockable.length > 0 && lockable.every(a => a.locked);
                          return (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleLockAll.mutate(!allLocked); }}
                              disabled={toggleLockAll.isPending}
                              title={allLocked ? 'Destravar todas as linhas' : 'Travar todas as linhas (não sofrem redistribuição hoje)'}
                              className="ml-1 text-gray-500 hover:text-orange-600"
                              data-testid="button-lock-all"
                            >
                              {allLocked ? <Lock className="h-3.5 w-3.5 text-orange-600" /> : <LockOpen className="h-3.5 w-3.5" />}
                            </button>
                          );
                        })()}
                      </span>
                    </th>
                    <th className="px-3 py-2 text-center font-semibold bg-gray-50 dark:bg-gray-800">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAssignments.map((a, idx) => (
                    <tr
                      key={`${a.assignmentId || a.customerId || 'row'}-${idx}`}
                      className="border-t hover:bg-orange-50/30"
                      data-testid={`row-repescagem-${a.customerId}`}
                    >
                      {isAdmin && (
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-orange-600"
                            checked={!!a.customerId && selectedIds.has(a.customerId)}
                            disabled={!a.customerId}
                            onChange={() => a.customerId && toggleSelectOne(a.customerId)}
                            data-testid={`checkbox-row-${a.customerId}`}
                          />
                        </td>
                      )}
                      <td className="px-3 py-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          <span>{a.customerName}</span>
                          <WhatsAppIconLink
                            phone={a.customerPhone}
                            customerName={a.customerName}
                            customerId={a.customerId}
                            testIdSuffix={a.customerId}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{a.customerCity || '-'}</td>
                      <td className="px-3 py-2 text-gray-700">{a.customerNeighborhood || '-'}</td>
                      <td className="px-3 py-2 text-center text-gray-700">{a.customerUf || '-'}</td>
                      <td className="px-3 py-2 text-gray-700">{a.sellerName || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant="outline" className="text-[11px]">
                          {PERIODICITY_LABELS[a.periodicity] || a.periodicity}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Badge className="bg-red-100 text-red-800 border border-red-300 hover:bg-red-100">
                          {formatDateBR(a.lastRedDate)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-xs font-semibold ${
                          a.daysSince > 14 ? 'text-red-700' : a.daysSince > 7 ? 'text-orange-700' : 'text-yellow-700'
                        }`}>
                          {a.daysSince === 0 ? 'Hoje' : `${a.daysSince} dia${a.daysSince > 1 ? 's' : ''}`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {a.unassigned || !a.assignmentId ? (
                          <Select
                            value={undefined}
                            onValueChange={(v) => { if (v) assign.mutate({ customerId: a.customerId, toUserId: v, lastRedDate: a.lastRedDate }); }}
                          >
                            <SelectTrigger className="h-7 text-xs w-[150px]" data-testid={`select-assignee-${a.customerId}`}><SelectValue placeholder="Atribuir..." /></SelectTrigger>
                            <SelectContent>
                              {enabledAttendants.map(e => (
                                <SelectItem key={e.userId} value={e.userId}>{e.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <Select
                              value={a.assignedUserId}
                              disabled={!!a.locked && !a.canUnlock}
                              onValueChange={(v) => { if (v && v !== a.assignedUserId) reassign.mutate({ assignmentId: a.assignmentId, toUserId: v }); }}
                            >
                              <SelectTrigger className="h-7 text-xs w-[150px]" data-testid={`select-assignee-${a.customerId}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {!enabledAttendants.some(e => e.userId === a.assignedUserId) && (
                                  <SelectItem value={a.assignedUserId}>{a.assignedUserName}</SelectItem>
                                )}
                                {enabledAttendants.map(e => (
                                  <SelectItem key={e.userId} value={e.userId}>{e.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <button
                              type="button"
                              onClick={() => { if (a.locked && !a.canUnlock) return; toggleLock.mutate({ assignmentId: a.assignmentId, locked: !a.locked }); }}
                              disabled={toggleLock.isPending || (!!a.locked && !a.canUnlock)}
                              title={a.locked ? (a.canUnlock ? 'Travado — clique para destravar' : 'Travado por outro usuário (só ele ou um admin destrava)') : 'Destravado — clique para travar (só você ou um admin destrava)'}
                              className={a.locked ? (a.canUnlock ? 'text-orange-600' : 'text-gray-400 cursor-not-allowed') : 'text-gray-400 hover:text-orange-600'}
                              data-testid={`button-lock-${a.customerId}`}
                            >
                              {a.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            variant="ghost" size="sm"
                            className="h-8 w-8 p-0 text-sky-600 hover:text-sky-800 hover:bg-sky-50"
                            title="Registrar atendimento"
                            onClick={() => setServiceLogTarget({ id: a.customerId, name: a.customerName })}
                            data-testid={`button-service-log-${a.customerId}`}
                          >
                            <Headphones className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost" size="sm"
                            className="h-8 w-8 p-0 text-gray-600 hover:text-gray-900"
                            title="Histórico de atribuições"
                            onClick={() => setHistoryCustomer({ id: a.customerId, name: a.customerName })}
                            data-testid={`button-history-${a.customerId}`}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {serviceLogTarget && (
        <VirtualServiceLogModal
          open={!!serviceLogTarget}
          onClose={() => setServiceLogTarget(null)}
          customerId={serviceLogTarget.id}
          customerName={serviceLogTarget.name}
          defaultServiceType="acompanhamento"
          source="repescagem"
          onSuccess={() => {
            queryClient.invalidateQueries({
              predicate: (q) => {
                const k = q.queryKey?.[0];
                return typeof k === 'string' && (
                  k.startsWith('/api/visit-summary') ||
                  k.startsWith('/api/active-customers') ||
                  k.startsWith('/api/service-logs') ||
                  k.startsWith('/api/repescagem')
                );
              },
            });
            refetch();
          }}
        />
      )}

      {/* REGRAS DA REPESCAGEM (icone "i" no cabecalho). IMPORTANTE: manter este texto sempre
          sincronizado com a logica de repescagem sempre que a regra mudar. */}
      {historyCustomer && (
        <Dialog open={!!historyCustomer} onOpenChange={(o) => { if (!o) setHistoryCustomer(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Histórico de Atribuições — {historyCustomer.name}</DialogTitle>
            </DialogHeader>
            <ScrollArea className="max-h-[60vh] pr-3">
              {loadingHistory ? (
                <div className="text-center py-6"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
              ) : historyData.length === 0 ? (
                <p className="text-sm text-center text-gray-500 py-6">Sem registros.</p>
              ) : (
                <div className="space-y-2">
                  {historyData.map((h) => (
                    <div key={h.id} className="flex items-start gap-2 border rounded p-2 text-sm">
                      <Badge className={ACTION_LABELS[h.action]?.color || 'bg-gray-100'}>
                        {ACTION_LABELS[h.action]?.label || h.action}
                      </Badge>
                      <div className="flex-1">
                        <p className="text-xs">
                          {h.fromUserName && <span className="text-gray-500">de <strong>{h.fromUserName}</strong> </span>}
                          {h.toUserName && <span className="text-gray-500">→ <strong>{h.toUserName}</strong></span>}
                        </p>
                        {h.reason && <p className="text-xs text-gray-600 italic">{h.reason}</p>}
                      </div>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap">
                        {formatDateTimeBR(h.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
