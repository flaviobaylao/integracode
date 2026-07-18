import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { generateDanfePdf, generateMultiDanfePdf, type DanfeInvoice } from '@/lib/danfe-generator';
import { generateMultiCobrancaPdf, generateCompletoPdf, type CobrancaData } from '@/lib/cobranca-generator';
import {
  Package, ArrowRight, ArrowLeft, Loader2, Trash2, Eye,
  ClipboardList, FileText, Printer, Clock, Truck, CheckCircle2,
  RefreshCw, ChevronRight, ChevronLeft, User, DollarSign, MapPin, Search,
  Power, CheckSquare, X, ArrowRightCircle, Copy, ChevronDown, Ban, Calendar, ArrowDownUp
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface BillingPipelineItem {
  id: string;
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerDocument: string | null;
  sellerId: string | null;
  sellerName: string | null;
  stage: string;
  orderNumber: string | null;
  invoiceNumber: string | null;
  saleValue: string | null;
  fiscalStatus?: string | null;
  fiscalError?: string | null;
  paymentMethod: string | null;
  operationType: string | null;
  products: Array<{ id: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  notes: string | null;
  omieInstanceId: string | null;
  omieInstanceName: string | null;
  scheduledBillingDate: string | null;
  stageHistory: Array<{ stage: string; changedAt: string; changedBy: string }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const STAGES = [
  { key: 'bloqueado', label: 'Bloqueados', icon: Power, color: 'bg-red-600', badgeColor: 'bg-red-100 text-red-800' },
  { key: 'agendado', label: 'Agendado', icon: Clock, color: 'bg-cyan-500', badgeColor: 'bg-cyan-100 text-cyan-800' },
  { key: 'pedido', label: 'Pedido', icon: ClipboardList, color: 'bg-blue-500', badgeColor: 'bg-blue-100 text-blue-800' },
  { key: 'a_faturar', label: 'A Faturar', icon: FileText, color: 'bg-yellow-500', badgeColor: 'bg-yellow-100 text-yellow-800' },
  { key: 'faturado', label: 'Faturado', icon: FileText, color: 'bg-orange-500', badgeColor: 'bg-orange-100 text-orange-800' },
  { key: 'impresso', label: 'Impresso', icon: Printer, color: 'bg-purple-500', badgeColor: 'bg-purple-100 text-purple-800' },
  { key: 'bsb', label: 'BSB', icon: MapPin, color: 'bg-pink-500', badgeColor: 'bg-pink-100 text-pink-800' },
  { key: 'aguardando_rota_bsb', label: 'Ag. Rota BSB', icon: Clock, color: 'bg-teal-600', badgeColor: 'bg-teal-100 text-teal-800' },
  { key: 'em_rota_bsb', label: 'Em Rota BSB', icon: Truck, color: 'bg-sky-600', badgeColor: 'bg-sky-100 text-sky-800' },
  { key: 'outras_cidades', label: 'Outras Cidades', icon: MapPin, color: 'bg-violet-500', badgeColor: 'bg-violet-100 text-violet-800' },
  { key: 'aguardando_rota', label: 'Aguardando Rota', icon: Clock, color: 'bg-gray-500', badgeColor: 'bg-gray-100 text-gray-800' },
  { key: 'em_rota', label: 'Em Rota', icon: Truck, color: 'bg-indigo-500', badgeColor: 'bg-indigo-100 text-indigo-800' },
  { key: 'entregue', label: 'Entregue', icon: CheckCircle2, color: 'bg-green-500', badgeColor: 'bg-green-100 text-green-800' },
] as const;

const PAYMENT_LABELS: Record<string, string> = {
  a_vista: 'À Vista',
  boleto: 'Boleto',
  pix: 'PIX',
  cartao: 'Cartão',
  dinheiro: 'Dinheiro',
};

const OPERATION_LABELS: Record<string, string> = {
  venda: 'Venda',
  bonificacao: 'Bonificação',
  troca: 'Troca',
  amostra: 'Amostra',
  reposicao: 'Reposição',
};

// Categoria de "Tipo de Operação" exibida no card (cancelado = status fiscal; senão o operationType do pedido)
const CANCELLED_FISCAL = ['cancelled', 'canceled', 'rejected', 'denied', 'cancelada', 'rejeitada'];
function isItemCancelled(item: any): boolean {
  return CANCELLED_FISCAL.includes((item?.fiscalStatus || '').toLowerCase());
}
function operationCategory(item: any): string | null {
  if (isItemCancelled(item)) return 'cancelado';
  return item?.operationType || null;
}
const CATEGORY_LABELS: Record<string, string> = {
  venda: 'Venda',
  cancelado: 'Cancelado',
  devolucao: 'Devolução',
  amostra: 'Amostra',
  bonificacao: 'Bonificação',
  troca: 'Troca',
  reposicao: 'Reposição',
};
const CATEGORY_ORDER = ['venda', 'cancelado', 'devolucao', 'amostra', 'bonificacao', 'troca', 'reposicao'];
// Cores das tags: Venda=verde, Cancelado=vermelho escuro, Devolução=vermelho claro, Amostra=azul, Troca=amarelo
// (correspondência por texto para tolerar variações de chave, ex.: 'devolucao'/'devolução')
function operationBadgeClass(cat: string | null): string {
  const c = normName(cat || '');
  if (c.includes('cancel')) return 'border-red-600 text-red-900 bg-red-100';
  if (c.includes('devolu')) return 'border-red-200 text-red-400 bg-red-50';
  if (c.includes('venda')) return 'border-green-300 text-green-700 bg-green-50';
  if (c.includes('amostra')) return 'border-blue-300 text-blue-700 bg-blue-50';
  if (c.includes('troca')) return 'border-yellow-300 text-yellow-700 bg-yellow-50';
  return 'border-slate-300 text-slate-700';
}

// Cor da tag da INSTÂNCIA Omie: fundo escuro + fonte clara (BSB=verde, GYN=azul, SERV=amarelo, IND=roxo)
function instanceBadgeClass(name: string | null): string {
  const n = (name || '').toUpperCase();
  if (n.includes('BSB')) return 'bg-green-700 text-green-100 border-green-700';
  if (n.includes('GYN')) return 'bg-blue-700 text-blue-100 border-blue-700';
  if (n.includes('SERV')) return 'bg-yellow-700 text-yellow-100 border-yellow-700';
  if (n.includes('IND')) return 'bg-purple-700 text-purple-100 border-purple-700';
  return 'bg-gray-200 text-gray-700 border-gray-300';
}

// Normaliza um nome para comparação (minúsculas, sem acentos, sem pontuação, espaços colapsados)
function normName(s: string): string {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Dois nomes são a mesma pessoa se: iguais normalizados; OU mesmo primeiro nome e (um só tem 1 token,
// ou o 2º token de um é prefixo do 2º token do outro — ex.: "Natalia B" ~ "Natalia Barbosa", "Ezequiel" ~ "Ezequiel DF")
function sellerMatches(aTokens: string[], bTokens: string[]): boolean {
  if (!aTokens.length || !bTokens.length) return false;
  if (aTokens.join(' ') === bTokens.join(' ')) return true;
  if (aTokens[0] !== bTokens[0]) return false;
  if (aTokens.length === 1 || bTokens.length === 1) return true;
  const a2 = aTokens[1], b2 = bTokens[1];
  return a2.startsWith(b2) || b2.startsWith(a2);
}

// Dropdown de seleção múltipla com checkboxes
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
          className="h-9 border rounded-md px-3 text-sm bg-white dark:bg-gray-800 dark:border-gray-600 flex items-center gap-1.5 whitespace-nowrap"
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

function formatCurrency(value: string | number | null) {
  if (!value) return 'R$ 0,00';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function BillingPipeline() {
  const [search, setSearch] = useState('');
  // Classificação por data de criação em cada raia (asc = A-Z / mais antigos primeiro).
  const [stageSort, setStageSort] = useState<Record<string, 'asc' | 'desc'>>({});
  const [sellerFilter, setSellerFilter] = useState<Set<string>>(new Set());
  const [opFilter, setOpFilter] = useState<Set<string>>(new Set());
  const [instanceFilter, setInstanceFilter] = useState<Set<string>>(new Set());
  // Filtro de datas (por data de criação do pedido). Vazios = sem filtro; só executa quando preenchidos.
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [detailItem, setDetailItem] = useState<BillingPipelineItem | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState<any>(null);
  const { data: usersList = [] } = useQuery<any[]>({ queryKey: ['/api/users'] });
  const { data: productCatalog = [] } = useQuery<any[]>({ queryKey: ['/api/products'] });
  const [prodSearch, setProdSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchStageTarget, setBatchStageTarget] = useState<string | null>(null);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [isPrintingDanfe, setIsPrintingDanfe] = useState(false);
  const [isPrintingCobranca, setIsPrintingCobranca] = useState(false);
  const [isPrintingCompleto, setIsPrintingCompleto] = useState(false);

  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
  });

  const isFlavio = (currentUser as any)?.email === 'flavio@bebahonest.com.br';
  // Bloqueio manual de pedido: apenas os 3 admins (mesma lista da Rota do Dia).
  const canBlockOrders = ['cinthiamarque90@gmail.com', 'flaviobaylao@gmail.com', 'flavio@bebahonest.com.br']
    .includes(String((currentUser as any)?.email || '').toLowerCase());
  // Edição (mover/excluir/selecionar em lote): admins. Telemarketing tem acesso
  // SOMENTE de leitura (consulta + filtros). As mutações também são bloqueadas no backend.
  const canEdit = ['admin', 'coordinator', 'administrative'].includes(String((currentUser as any)?.role || ''));

  const { data: items = [], isLoading } = useQuery<BillingPipelineItem[]>({
    queryKey: ['/api/billing-pipeline'],
  });

  const { data: blockedOrders = [] } = useQuery<any[]>({
    queryKey: ['/api/blocked-orders'],
  });

  const { data: modeStatus } = useQuery<{ active: boolean; activatedBy: string | null }>({
    queryKey: ['/api/billing-pipeline/mode'],
    refetchInterval: 10000,
  });

  const syncNowMutation = useMutation({
    mutationFn: async () => {
      // Cutover (08/jul): pipeline gerido no 2.0 — apenas recarrega a tela, sem puxar do Integra 1.0.
      await queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      toast({ title: 'Pipeline atualizado', description: 'Tela recarregada (fonte: Integra 2.0)' });
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      toast({ title: 'Falha ao sincronizar', description: error.message, variant: 'destructive' });
    }
  });

  const toggleModeMutation = useMutation({
    mutationFn: async (active: boolean) => {
      return await apiRequest('POST', '/api/billing-pipeline/mode', { active });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline/mode'] });
      toast({
        title: data.active ? 'Faturamento interno ATIVADO' : 'Faturamento interno DESATIVADO',
        description: data.active
          ? 'Todos os novos pedidos serao encaminhados para o pipeline interno'
          : 'Pedidos voltam ao fluxo normal pelo Omie',
      });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao alterar modo', description: error.message, variant: 'destructive' });
    }
  });

  const moveStageMutation = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: string }) => {
      return await apiRequest('PATCH', `/api/billing-pipeline/${id}/stage`, { stage });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      if (data?.fiscalInvoiceId) {
        toast({
          title: 'NF-e criada automaticamente',
          description: `Pedido faturado e NF-e ${data.invoiceNumber || ''} gerada com sucesso`,
        });
      } else {
        toast({ title: 'Stage atualizado com sucesso' });
      }
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao mover item', description: error.message, variant: 'destructive' });
    }
  });

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryInvoiceMutation = useMutation({
    mutationFn: async (id: string) => await apiRequest('POST', `/api/billing-pipeline/${id}/retry-invoice`, {}),
    onMutate: (id: string) => { setRetryingId(id); },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      toast({ title: data?.already ? 'NF-e já autorizada' : 'Faturamento reprocessado', description: 'NF-e transmitida com sucesso.' });
    },
    onError: (error: any) => {
      toast({ title: 'Falha ao re-tentar faturamento', description: error?.message || 'Erro ao transmitir a NF-e.', variant: 'destructive' });
    },
    onSettled: () => setRetryingId(null),
  });

  const updateItemMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => await apiRequest('PATCH', `/api/billing-pipeline/${id}`, data),
    onSuccess: (_r: any, vars: any) => {
      toast({ title: 'Pedido atualizado' });
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      setEditMode(false);
      setDetailItem((prev) => prev ? ({ ...prev, ...vars.data } as any) : prev);
    },
    onError: (e: any) => toast({ title: 'Erro ao salvar', description: e.message, variant: 'destructive' }),
  });
  const duplicateMutation = useMutation({
    mutationFn: async (id: string) => await apiRequest('POST', `/api/billing-pipeline/${id}/duplicate`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      toast({ title: 'Pedido duplicado', description: 'Uma cópia foi criada na etapa "Pedido", pronta para faturar.' });
      setDetailItem(null);
    },
    onError: (e: any) => toast({ title: 'Erro ao duplicar', description: e?.message || 'Não foi possível duplicar o pedido.', variant: 'destructive' }),
  });
  const startEdit = () => {
    if (!detailItem) return;
    setEditData({
      saleValue: detailItem.saleValue ?? '',
      paymentMethod: detailItem.paymentMethod ?? '',
      operationType: detailItem.operationType ?? '',
      sellerId: detailItem.sellerId ?? '',
      sellerName: detailItem.sellerName ?? '',
      invoiceNumber: detailItem.invoiceNumber ?? '',
      scheduledBillingDate: detailItem.scheduledBillingDate ? String(detailItem.scheduledBillingDate).slice(0, 10) : '',
      notes: detailItem.notes ?? '',
      products: (detailItem.products || []).map((pp: any) => ({ ...pp })),
    });
    setProdSearch('');
    setEditMode(true);
  };
  const saveEdit = () => { if (detailItem && editData) updateItemMutation.mutate({ id: detailItem.id, data: editData }); };
  const blockOrderMutation = useMutation({
    mutationFn: async (vars: { id: string; reason?: string }) => await apiRequest('POST', `/api/billing-pipeline/${vars.id}/block`, { reason: vars.reason || '' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      toast({ title: 'Pedido bloqueado', description: 'Movido para a coluna Bloqueados. Só sai de lá por liberação manual.' });
    },
    onError: (error: any) => {
      toast({ title: 'Falha ao bloquear', description: error?.message || 'Erro', variant: 'destructive' });
    },
  });

  const releaseBlockedMutation = useMutation({
    mutationFn: async (orderIds: string[]) => await apiRequest('POST', '/api/blocked-orders/release', { orderIds }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      const rel = data?.released ?? 0; const errs = data?.errors?.length ?? 0;
      if (errs && !rel) toast({ title: 'Nao foi possivel liberar', description: (data?.errors || []).join(' | '), variant: 'destructive' });
      else toast({ title: 'Pedido liberado', description: `${rel} pedido(s) enviado(s) ao faturamento${errs ? `, ${errs} erro(s)` : ''}` });
    },
    onError: (error: any) => { toast({ title: 'Erro ao liberar', description: error.message, variant: 'destructive' }); }
  });

  const rejectBlockedMutation = useMutation({
    mutationFn: async (orderIds: string[]) => await apiRequest('POST', '/api/blocked-orders/reject', { orderIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      toast({ title: 'Pedido rejeitado', description: 'Pedido bloqueado removido.' });
    },
    onError: (error: any) => { toast({ title: 'Erro ao rejeitar', description: error.message, variant: 'destructive' }); }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/billing-pipeline/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      setDeleteConfirm(null);
      toast({ title: 'Item removido do pipeline' });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao remover', description: error.message, variant: 'destructive' });
    }
  });

  const batchStageMutation = useMutation({
    mutationFn: async ({ ids, stage }: { ids: string[]; stage: string }) => {
      return await apiRequest('POST', '/api/billing-pipeline/batch/stage', { ids, stage });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      setSelectedIds(new Set());
      setBatchStageTarget(null);
      const nfeCount = data.results?.filter((r: any) => r.fiscalInvoiceId).length || 0;
      let desc = `${data.successCount}/${data.totalCount} pedidos movidos com sucesso`;
      if (nfeCount > 0) desc += ` (${nfeCount} NF-e criadas)`;
      toast({ title: 'Ação em lote concluída', description: desc });
    },
    onError: (error: any) => {
      toast({ title: 'Erro na ação em lote', description: error.message, variant: 'destructive' });
    }
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      return await apiRequest('POST', '/api/billing-pipeline/batch/delete', { ids });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      setSelectedIds(new Set());
      setBatchDeleteConfirm(false);
      toast({ title: 'Itens removidos', description: `${data.successCount}/${data.totalCount} removidos com sucesso` });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao remover em lote', description: error.message, variant: 'destructive' });
    }
  });

  const groupedByStage = useMemo(() => {
    const groups: Record<string, BillingPipelineItem[]> = {};
    STAGES.forEach(s => { groups[s.key] = []; });
    items.forEach(item => {
      if (groups[item.stage]) {
        groups[item.stage].push(item);
      }
    });
    if (groups['bloqueado']) {
      for (const b of (blockedOrders as any[])) {
        groups['bloqueado'].push({
          id: b.id,
          salesCardId: b.salesCardId,
          customerId: b.customerId,
          customerName: b.customer?.name ?? b.customerName ?? 'Cliente',
          customerDocument: b.customer?.document ?? null,
          sellerId: b.sellerId ?? null,
          sellerName: b.seller ? ((b.seller.firstName || '') + ' ' + (b.seller.lastName || '')).trim() : (b.sellerId ?? null),
          stage: 'bloqueado',
          orderNumber: b.omieOrderId ?? null,
          invoiceNumber: null,
          saleValue: b.totalAmount ?? null,
          paymentMethod: b.paymentMethod ?? null,
          operationType: b.operationType ?? null,
          products: b.products ?? null,
          notes: b.blockDetails ?? b.blockReason ?? null,
          omieInstanceId: null,
          omieInstanceName: null,
          stageHistory: [],
          createdBy: null,
          createdAt: b.blockedAt ?? b.createdAt,
          updatedAt: b.updatedAt,
        });
      }
    }
    return groups;
  }, [items, blockedOrders]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllInStage = useCallback((stageKey: string) => {
    const stageItems = groupedByStage[stageKey] || [];
    const stageIds = stageItems.map(i => i.id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allSelected = stageIds.every(id => next.has(id));
      if (allSelected) {
        stageIds.forEach(id => next.delete(id));
      } else {
        stageIds.forEach(id => next.add(id));
      }
      return next;
    });
  }, [groupedByStage]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const selectedItems = useMemo(() => {
    return items.filter(i => selectedIds.has(i.id));
  }, [items, selectedIds]);

  const selectedTotal = useMemo(() => {
    return selectedItems.reduce((sum, i) => sum + (i.saleValue ? parseFloat(i.saleValue) : 0), 0);
  }, [selectedItems]);

  const selectedFaturadoCount = useMemo(() => {
    return selectedItems.filter(i => i.invoiceNumber).length;
  }, [selectedItems]);

  const handlePrintDanfe = useCallback(async () => {
    const faturadoItems = selectedItems.filter(i => i.invoiceNumber);
    if (faturadoItems.length === 0) {
      toast({ title: 'Nenhum pedido faturado selecionado', description: 'Selecione pedidos que já possuem nota fiscal gerada', variant: 'destructive' });
      return;
    }

    setIsPrintingDanfe(true);
    try {
      const invoiceNumbers = faturadoItems.map(i => i.invoiceNumber!);
      const response = await fetch('/api/fiscal-invoices/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ invoiceNumbers }),
      });

      if (!response.ok) throw new Error('Erro ao buscar notas fiscais');
      const invoices: DanfeInvoice[] = await response.json();

      if (invoices.length === 0) {
        toast({ title: 'Nenhuma NF-e encontrada', description: 'As notas fiscais para os pedidos selecionados não foram encontradas', variant: 'destructive' });
        return;
      }

      generateMultiDanfePdf(invoices);

      toast({
        title: `${invoices.length} DANFE${invoices.length > 1 ? 's' : ''} ${invoices.length > 1 ? 'geradas' : 'gerada'}`,
        description: invoices.length > 1
          ? `${invoices.length} notas fiscais reunidas em um único PDF`
          : `Nota fiscal impressa com sucesso`,
      });
    } catch (err: any) {
      toast({ title: 'Erro ao imprimir', description: err.message, variant: 'destructive' });
    } finally {
      setIsPrintingDanfe(false);
    }
  }, [selectedItems]);

  const handlePrintCobrancas = useCallback(async () => {
    if (selectedItems.length === 0) { toast({ title: 'Nenhum pedido selecionado', variant: 'destructive' }); return; }
    setIsPrintingCobranca(true);
    try {
      const ids = selectedItems.map((i) => i.id);
      const resp = await fetch('/api/billing-pipeline/charges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ids }) });
      if (!resp.ok) throw new Error('Erro ao buscar cobrancas');
      const rows = await resp.json();
      const byItem = new Map<string, any>();
      for (const r of rows) { const cur = byItem.get(r.item_id); if (!cur || ((!cur.boleto && !cur.pix) && (r.boleto || r.pix))) byItem.set(r.item_id, r); }
      const list: CobrancaData[] = selectedItems.map((it) => { const r = byItem.get(it.id) || {}; return { itemId: it.id, customerName: it.customerName, sellerName: it.sellerName, invoiceNumber: it.invoiceNumber, saleValue: it.saleValue, products: it.products, boleto: r.boleto, pix: r.pix }; });
      const n = await generateMultiCobrancaPdf(list);
      if (n === 0) toast({ title: 'Nenhuma cobranca encontrada', description: 'Os pedidos selecionados nao possuem boleto/PIX gerado.', variant: 'destructive' });
      else toast({ title: n + ' cobranca(s) gerada(s)' });
    } catch (err: any) { toast({ title: 'Erro ao imprimir', description: err.message, variant: 'destructive' }); }
    finally { setIsPrintingCobranca(false); }
  }, [selectedItems]);

  const handlePrintCompleto = useCallback(async () => {
    if (selectedItems.length === 0) { toast({ title: 'Nenhum pedido selecionado', variant: 'destructive' }); return; }
    setIsPrintingCompleto(true);
    try {
      const ids = selectedItems.map((i) => i.id);
      const resp = await fetch('/api/billing-pipeline/charges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ids }) });
      const rows = resp.ok ? await resp.json() : [];
      const byItem = new Map<string, any>();
      for (const r of rows) { const cur = byItem.get(r.item_id); if (!cur || ((!cur.boleto && !cur.pix) && (r.boleto || r.pix))) byItem.set(r.item_id, r); }
      const invNums = selectedItems.filter((i) => i.invoiceNumber).map((i) => i.invoiceNumber);
      const danfeByNum = new Map<string, DanfeInvoice>();
      if (invNums.length) {
        try {
          const fr = await fetch('/api/fiscal-invoices/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ invoiceNumbers: invNums }) });
          if (fr.ok) { const invs: DanfeInvoice[] = await fr.json(); for (const inv of invs) { danfeByNum.set(String(inv.invoiceNumber), inv); } }
        } catch (e) {}
      }
      const list: CobrancaData[] = selectedItems.map((it) => { const r = byItem.get(it.id) || {}; const num = (it.invoiceNumber || '').replace(/\D/g, ''); const danfe = danfeByNum.get(num) || danfeByNum.get(String(it.invoiceNumber)) || null; return { itemId: it.id, customerName: it.customerName, sellerName: it.sellerName, invoiceNumber: it.invoiceNumber, saleValue: it.saleValue, products: it.products, boleto: r.boleto, pix: r.pix, danfe }; });
      const n = await generateCompletoPdf(list);
      toast({ title: n + ' pedido(s) impresso(s)' });
    } catch (err: any) { toast({ title: 'Erro ao imprimir', description: err.message, variant: 'destructive' }); }
    finally { setIsPrintingCompleto(false); }
  }, [selectedItems]);

  const moveItem = (item: BillingPipelineItem, direction: 'forward' | 'backward') => {
    // Card da coluna 'Bloqueados' nao e item do pipeline: avancar = LIBERAR (release), nao PATCH /stage.
    if (item.stage === 'bloqueado') {
      if (direction === 'forward') {
        if (window.confirm(`Liberar o pedido de ${item.customerName} para o faturamento?`)) releaseBlockedMutation.mutate([item.id]);
      }
      return;
    }
    const currentIdx = STAGES.findIndex(s => s.key === item.stage);
    const nextIdx = direction === 'forward' ? currentIdx + 1 : currentIdx - 1;
    if (nextIdx < 0 || nextIdx >= STAGES.length) return;
    const targetStage = STAGES[nextIdx].key;
    // Mover para "Bloqueados" NAO e mudanca de stage: e BLOQUEAR (tabela blocked_orders via /block).
    if (targetStage === 'bloqueado') {
      if (window.confirm(`Bloquear o pedido de ${item.customerName}? Ele vai para a coluna "Bloqueados".`)) blockOrderMutation.mutate({ id: item.id });
      return;
    }
    moveStageMutation.mutate({ id: item.id, stage: targetStage });
  };

  const moveToStage = (item: BillingPipelineItem, stage: string) => {
    // Card da coluna 'Bloqueados' nao e item do pipeline: alterar a etapa = LIBERAR (release).
    // O pedido liberado entra na etapa "Pedido" e dali pode ser movido normalmente.
    if (item.stage === 'bloqueado') {
      if (window.confirm(`Liberar o pedido de ${item.customerName} para o faturamento? Ele entrara na etapa "Pedido".`)) releaseBlockedMutation.mutate([item.id]);
      return;
    }
    // Mover para "Bloqueados" NAO e mudanca de stage: e BLOQUEAR (tabela blocked_orders via /block).
    if (stage === 'bloqueado') {
      if (window.confirm(`Bloquear o pedido de ${item.customerName}? Ele vai para a coluna "Bloqueados" e so sai de la por liberacao manual.`)) blockOrderMutation.mutate({ id: item.id });
      return;
    }
    moveStageMutation.mutate({ id: item.id, stage });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Registro de Vendedores (ativos ou inativos) — nome oficial tem prioridade na unificação
  const registrySellers = (usersList as any[])
    .map((u) => {
      const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
      const tokens = normName(name).split(' ').filter(Boolean);
      return { id: u.id, name, tokens };
    })
    .filter((r) => r.name && r.tokens.length);

  // Resolve o nome CANÔNICO do vendedor de um card (unifica variações: "Natalia B" = "Natália B."; "Ezequiel DF" = "Ezequiel")
  const _sellerCache = new Map<string, string>();
  const canonicalSeller = (item: any): string => {
    const key = `${item.sellerId || ''}|${item.sellerName || ''}`;
    if (_sellerCache.has(key)) return _sellerCache.get(key) as string;
    let result: string | null = null;
    // 1) por sellerId direto no registro
    if (item.sellerId) {
      const byId = registrySellers.find((r) => r.id === item.sellerId);
      if (byId) result = byId.name;
    }
    // 2) por nome (heurística de unificação)
    if (!result && item.sellerName) {
      const pt = normName(item.sellerName).split(' ').filter(Boolean);
      const m = registrySellers.find((r) => sellerMatches(r.tokens, pt));
      if (m) result = m.name;
    }
    if (!result) result = (item.sellerName || '').trim() || 'Sem vendedor';
    _sellerCache.set(key, result);
    return result;
  };

  // Opções dos filtros (apenas o que existe no pipeline)
  const sellerOptions = Array.from(new Set((items || []).map((i: any) => canonicalSeller(i))))
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ value: v, label: v }));
  const opOptions = Array.from(new Set((items || []).map((i: any) => operationCategory(i)).filter(Boolean) as string[]))
    .sort((a, b) => (CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)))
    .map((v) => ({ value: v, label: CATEGORY_LABELS[v] || v }));
  const instanceOptions = Array.from(new Set((items || []).map((i: any) => i.omieInstanceName).filter(Boolean) as string[]))
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ value: v, label: v }));

  const toggleInSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (v: string) =>
    setter((prev) => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n; });

  return (
    <div className="h-screen bg-gray-50 dark:bg-gray-900 flex flex-col overflow-hidden">
      <div className="p-4 flex flex-col flex-1 min-h-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <BackToDashboardButton />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Pipeline de Faturamento
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {modeStatus?.active && (
              <Badge className="bg-green-100 text-green-800 border-green-300 animate-pulse text-xs">
                Modo Interno ATIVO
              </Badge>
            )}
            <Badge variant="outline" className="text-sm">
              {items.length} pedidos no pipeline
            </Badge>
            {isFlavio && (
              <Button
                size="sm"
                className={modeStatus?.active
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-purple-600 hover:bg-purple-700 text-white'}
                onClick={() => toggleModeMutation.mutate(!modeStatus?.active)}
                disabled={toggleModeMutation.isPending}
                data-testid="button-faturar-interno"
              >
                {toggleModeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Power className="h-4 w-4 mr-1" />
                )}
                {modeStatus?.active ? 'Desativar Interno' : 'Faturar Interno'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncNowMutation.mutate()}
              disabled={syncNowMutation.isPending}
            >
              {syncNowMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" />
              )}
              Atualizar
            </Button>
          </div>
        </div>

        {/* Filtros: (1) Cliente/NF  (2) Vendedor  (3) Tipo de Operação */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por cliente ou NF..."
              className="pl-8 h-9"
              data-testid="input-search-pipeline"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">×</button>
            )}
          </div>
          <MultiSelectFilter
            label="Vendedor"
            options={sellerOptions}
            selected={sellerFilter}
            onToggle={toggleInSet(setSellerFilter)}
            onClear={() => setSellerFilter(new Set())}
            testid="select-seller-pipeline"
          />
          <MultiSelectFilter
            label="Tipo de Operação"
            options={opOptions}
            selected={opFilter}
            onToggle={toggleInSet(setOpFilter)}
            onClear={() => setOpFilter(new Set())}
            testid="select-operation-pipeline"
          />
          <MultiSelectFilter
            label="Instância"
            options={instanceOptions}
            selected={instanceFilter}
            onToggle={toggleInSet(setInstanceFilter)}
            onClear={() => setInstanceFilter(new Set())}
            testid="select-instance-pipeline"
          />
          {/* Filtro de datas (de/até por data de criação do pedido). Vazios = sem filtro. */}
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-500 text-xs">De</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 px-2 border rounded-md text-sm"
              data-testid="input-date-from-pipeline"
              aria-label="Data inicial"
            />
            <span className="text-gray-500 text-xs">Até</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-9 px-2 border rounded-md text-sm"
              data-testid="input-date-to-pipeline"
              aria-label="Data final"
            />
          </div>
          {(sellerFilter.size > 0 || opFilter.size > 0 || instanceFilter.size > 0 || search || dateFrom || dateTo) && (
            <button
              onClick={() => { setSearch(''); setSellerFilter(new Set()); setOpFilter(new Set()); setInstanceFilter(new Set()); setDateFrom(''); setDateTo(''); }}
              className="text-gray-400 hover:text-gray-600 text-sm"
              data-testid="clear-all-filters-pipeline"
            >Limpar filtros ×</button>
          )}
        </div>

        {/* Bulk Action Toolbar */}
        {selectedIds.size > 0 && (
          <div className="mb-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg px-4 py-3 flex items-center justify-between gap-3 animate-in slide-in-from-top-2">
            <div className="flex items-center gap-3">
              <CheckSquare className="h-5 w-5 text-blue-600" />
              <span className="font-semibold text-sm text-blue-800 dark:text-blue-200">
                {selectedIds.size} {selectedIds.size === 1 ? 'pedido selecionado' : 'pedidos selecionados'}
              </span>
              <Badge variant="outline" className="text-xs font-bold text-green-700 border-green-300">
                Total: {formatCurrency(selectedTotal)}
              </Badge>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {STAGES.map(s => {
                const SIcon = s.icon;
                return (
                  <Button
                    key={s.key}
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => setBatchStageTarget(s.key)}
                    disabled={batchStageMutation.isPending}
                  >
                    <SIcon className="h-3 w-3 mr-1" />
                    {s.label}
                  </Button>
                );
              })}
              <div className="w-px h-6 bg-gray-300 mx-1" />
              {selectedFaturadoCount > 0 && (
                <Button
                  size="sm"
                  className="text-xs h-7 bg-green-600 hover:bg-green-700 text-white"
                  onClick={handlePrintDanfe}
                  disabled={isPrintingDanfe}
                >
                  {isPrintingDanfe ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Printer className="h-3 w-3 mr-1" />
                  )}
                  Imprimir DANFE ({selectedFaturadoCount})
                </Button>
              )}
              {selectedItems.length > 0 && (
                <Button
                  size="sm"
                  className="text-xs h-7 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={handlePrintCobrancas}
                  disabled={isPrintingCobranca}
                >
                  {isPrintingCobranca ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Printer className="h-3 w-3 mr-1" />
                  )}
                  Imprimir Cobrancas ({selectedItems.length})
                </Button>
              )}
              {selectedItems.length > 0 && (
                <Button
                  size="sm"
                  className="text-xs h-7 bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={handlePrintCompleto}
                  disabled={isPrintingCompleto}
                >
                  {isPrintingCompleto ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Printer className="h-3 w-3 mr-1" />
                  )}
                  Imprimir Completo ({selectedItems.length})
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                className="text-xs h-7"
                onClick={() => setBatchDeleteConfirm(true)}
                disabled={batchDeleteMutation.isPending}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Remover
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-7"
                onClick={clearSelection}
              >
                <X className="h-3 w-3 mr-1" />
                Limpar
              </Button>
            </div>
          </div>
        )}

        {/* Kanban Board */}
        <div className="flex gap-3 overflow-auto pb-4 flex-1 min-h-0">
          {STAGES.map((stage) => {
            const _q = search.trim().toLowerCase();
            const stageItems = (groupedByStage[stage.key] || []).filter(i => {
              // (1) Busca por cliente ou NF
              const matchesText = !_q
                || (i.customerName || '').toLowerCase().includes(_q)
                || (i.invoiceNumber || '').toLowerCase().includes(_q);
              // (2) Vendedor (nome canônico) — múltipla seleção
              const matchesSeller = sellerFilter.size === 0 || sellerFilter.has(canonicalSeller(i));
              // (3) Tipo de Operação — múltipla seleção
              const cat = operationCategory(i);
              const matchesOp = opFilter.size === 0 || (cat != null && opFilter.has(cat));
              // (4) Instância — múltipla seleção
              const matchesInstance = instanceFilter.size === 0 || (!!i.omieInstanceName && instanceFilter.has(i.omieInstanceName));
              // (5) Datas de/até — por data de criação (America/Sao_Paulo). Só filtra quando preenchido.
              let matchesDate = true;
              if (dateFrom || dateTo) {
                const dISO = i.createdAt
                  ? new Date(i.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
                  : '';
                if (!dISO) matchesDate = false;
                else {
                  if (dateFrom && dISO < dateFrom) matchesDate = false;
                  if (dateTo && dISO > dateTo) matchesDate = false;
                }
              }
              return matchesText && matchesSeller && matchesOp && matchesInstance && matchesDate;
            });
            const stageTotal = stageItems.reduce((sum, i) => sum + (i.saleValue ? parseFloat(i.saleValue) : 0), 0);
            // Classificação por data de criação (A-Z = mais antigos primeiro / Z-A = mais recentes primeiro).
            const sortDir = stageSort[stage.key] || 'asc';
            const sortedStageItems = [...stageItems].sort((a, b) => {
              const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return sortDir === 'asc' ? ta - tb : tb - ta;
            });
            const StageIcon = stage.icon;
            const stageIds = stageItems.map(i => i.id);
            const allStageSelected = stageIds.length > 0 && stageIds.every(id => selectedIds.has(id));
            const someStageSelected = stageIds.some(id => selectedIds.has(id));
            return (
              <div key={stage.key} className="flex-shrink-0 w-72">
                <div className={`rounded-t-lg px-3 py-2 ${stage.color} text-white flex items-center justify-between sticky top-0 z-20`}>
                  <div className="flex items-center gap-2">
                    {canEdit && stageItems.length > 0 && (
                      <Checkbox
                        checked={allStageSelected}
                        className="border-white data-[state=checked]:bg-white data-[state=checked]:text-gray-900 h-5 w-5"
                        onCheckedChange={() => toggleSelectAllInStage(stage.key)}
                      />
                    )}
                    <StageIcon className="h-4 w-4" />
                    <span className="font-semibold text-sm">{stage.label}</span>
                  </div>
                  <div className="flex flex-col items-end leading-tight">
                    <Badge className="bg-white/20 text-white text-xs">{stageItems.length} {stageItems.length === 1 ? 'pedido' : 'pedidos'}</Badge>
                    <span className="text-[10px] font-semibold text-white/90 mt-0.5">{formatCurrency(stageTotal)}</span>
                  </div>
                </div>
                <div className="bg-gray-100 dark:bg-gray-800 rounded-b-lg p-2 space-y-2 min-h-[200px]">
                  {/* Seletor de classificação por data de criação (A-Z / Z-A) */}
                  <div className="flex items-center justify-end">
                    <button
                      onClick={() => setStageSort(prev => ({ ...prev, [stage.key]: (prev[stage.key] || 'asc') === 'asc' ? 'desc' : 'asc' }))}
                      className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 bg-white dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-700"
                      title="Classificar por data de criação"
                      data-testid={`sort-stage-${stage.key}`}
                    >
                      <Calendar className="h-3 w-3" />
                      <span>Data</span>
                      <ArrowDownUp className="h-3 w-3" />
                      <span className="font-semibold">{sortDir === 'asc' ? 'A-Z' : 'Z-A'}</span>
                    </button>
                  </div>
                  {stageItems.length === 0 && (
                    <div className="text-center text-gray-400 text-sm py-8">
                      Nenhum pedido
                    </div>
                  )}
                  {sortedStageItems.map((item) => (
                    <KanbanCard
                      key={item.id}
                      item={item}
                      stage={stage}
                      selected={selectedIds.has(item.id)}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onMoveForward={() => moveItem(item, 'forward')}
                      onMoveBackward={() => moveItem(item, 'backward')}
                      onViewDetail={() => setDetailItem(item)}
                      onDelete={() => stage.key === 'bloqueado'
                        ? (window.confirm(`Rejeitar (excluir) o pedido bloqueado de ${item.customerName}?`) && rejectBlockedMutation.mutate([item.id]))
                        : setDeleteConfirm(item.id)}
                      isFirst={stage.key === STAGES[0].key}
                      isLast={stage.key === STAGES[STAGES.length - 1].key}
                      isMoving={moveStageMutation.isPending}
                      onRetryInvoice={() => retryInvoiceMutation.mutate(item.id)}
                      isRetrying={retryingId === item.id}
                      canBlock={canBlockOrders}
                      onBlock={() => {
                        const reason = window.prompt(`Bloquear o pedido de ${item.customerName}?\n\nMotivo (opcional):`, '');
                        if (reason !== null) blockOrderMutation.mutate({ id: item.id, reason });
                      }}
                      isBlocking={blockOrderMutation.isPending}
                      canEdit={canEdit}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail Modal */}
      <Dialog open={!!detailItem} onOpenChange={() => { setDetailItem(null); setEditMode(false); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-lg">Detalhes do Pedido</DialogTitle>
                <DialogDescription className="mt-1">
                  {detailItem?.orderNumber ? `Pedido ${detailItem.orderNumber}` : detailItem?.salesCardId ? `Card ${detailItem.salesCardId.slice(0, 8)}` : 'Informações do pedido'}
                </DialogDescription>
              </div>
              {detailItem && (
                <div className="flex items-center gap-2">
                  <Badge className={STAGES.find(s => s.key === detailItem.stage)?.badgeColor || 'bg-gray-100'}>
                    {STAGES.find(s => s.key === detailItem.stage)?.label || detailItem.stage}
                  </Badge>
                  {!editMode ? (
                    <Button size="sm" variant="outline" className="text-xs" onClick={startEdit} data-testid="button-edit-order">✏️ Editar</Button>
                  ) : (<span className="text-xs text-blue-600 font-medium">Editando…</span>)}
                </div>
              )}
            </div>
          </DialogHeader>
          {detailItem && (
            <div className="space-y-5">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <User className="h-4 w-4 text-gray-500" />
                  <span className="font-semibold text-sm text-gray-700 dark:text-gray-300">Cliente</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2 sm:col-span-1">
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Nome / Razão Social</label>
                    <p className="font-semibold text-sm">{detailItem.customerName}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">CPF / CNPJ</label>
                    <p className="text-sm font-mono">{detailItem.customerDocument || '-'}</p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign className="h-4 w-4 text-gray-500" />
                  <span className="font-semibold text-sm text-gray-700 dark:text-gray-300">Dados do Pedido</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Valor Total</label>
                    {editMode ? (
                      <input type="number" step="0.01" value={editData?.saleValue ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, saleValue: e.target.value }))} className="w-full border rounded px-2 py-1 text-sm font-bold" />
                    ) : (<p className="font-bold text-lg text-green-700">{formatCurrency(detailItem.saleValue)}</p>)}
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Pagamento</label>
                    {editMode ? (
                      <select value={editData?.paymentMethod ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, paymentMethod: e.target.value }))} className="w-full border rounded px-2 py-1 text-sm">
                        <option value="">-</option>
                        {Object.entries(PAYMENT_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                      </select>
                    ) : (<p className="text-sm">{PAYMENT_LABELS[detailItem.paymentMethod || ''] || detailItem.paymentMethod || '-'}</p>)}
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Operação</label>
                    {editMode ? (
                      <select value={editData?.operationType ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, operationType: e.target.value }))} className="w-full border rounded px-2 py-1 text-sm">
                        <option value="">-</option>
                        {Object.entries(OPERATION_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                      </select>
                    ) : (<p className="text-sm">{OPERATION_LABELS[detailItem.operationType || ''] || detailItem.operationType || '-'}</p>)}
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Vendedor</label>
                    {editMode ? (
                      <select value={editData?.sellerId ?? ''} onChange={(e) => { const u = (usersList as any[]).find((x) => x.id === e.target.value); setEditData((d: any) => ({ ...d, sellerId: e.target.value, sellerName: u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : d.sellerName })); }} className="w-full border rounded px-2 py-1 text-sm">
                        <option value="">{editData?.sellerName || '-'}</option>
                        {(usersList as any[]).filter((u) => u.isActive).map((u) => (<option key={u.id} value={u.id}>{`${u.firstName || ''} ${u.lastName || ''}`.trim()}</option>))}
                      </select>
                    ) : (<p className="text-sm">{detailItem.sellerName || '-'}</p>)}
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Faturar em</label>
                    {editMode ? (
                      <input type="date" value={editData?.scheduledBillingDate ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, scheduledBillingDate: e.target.value }))} className="w-full border rounded px-2 py-1 text-sm" data-testid="input-faturar-em" />
                    ) : (<p className="text-sm">{detailItem.scheduledBillingDate ? new Date(detailItem.scheduledBillingDate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-'}</p>)}
                  </div>
                  {(detailItem.invoiceNumber || editMode) && (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Nota Fiscal</label>
                      {editMode ? (
                        <input value={editData?.invoiceNumber ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, invoiceNumber: e.target.value }))} className="w-full border rounded px-2 py-1 text-sm font-mono" />
                      ) : (<p className="text-sm font-mono font-semibold text-orange-700">{detailItem.invoiceNumber}</p>)}
                    </div>
                  )}
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Criado por</label>
                    <p className="text-sm">{detailItem.createdBy || '-'}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Data de Criação</label>
                    <p className="text-sm">{formatDate(detailItem.createdAt)}</p>
                  </div>
                </div>
              </div>

              {((detailItem.products && detailItem.products.length > 0) || editMode) && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Package className="h-4 w-4 text-gray-500" />
                    <span className="font-semibold text-sm text-gray-700 dark:text-gray-300">Produtos ({detailItem.products.length})</span>
                  </div>
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 dark:bg-gray-700">
                        <tr>
                          <th className="text-left p-2.5 font-semibold">#</th>
                          <th className="text-left p-2.5 font-semibold">Produto</th>
                          <th className="text-right p-2.5 font-semibold">Qtd</th>
                          <th className="text-right p-2.5 font-semibold">Vlr Unit.</th>
                          <th className="text-right p-2.5 font-semibold">Vlr Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {editMode ? (editData?.products || []).map((p: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="p-1.5 text-gray-400">{i + 1}</td>
                            <td className="p-1.5"><input value={p.name || ''} onChange={(e) => setEditData((d: any) => { const pr = [...d.products]; pr[i] = { ...pr[i], name: e.target.value }; const _sv = pr.reduce((t: number, x: any) => t + (parseFloat(x.totalPrice) || 0), 0); return { ...d, products: pr, saleValue: _sv.toFixed(2) }; })} className="w-full border rounded px-1 py-0.5 text-xs" /></td>
                            <td className="text-right p-1.5"><input type="number" step="0.001" value={p.quantity ?? ''} onChange={(e) => setEditData((d: any) => { const pr = [...d.products]; const q = parseFloat(e.target.value) || 0; pr[i] = { ...pr[i], quantity: q, totalPrice: q * (parseFloat(pr[i].unitPrice) || 0) }; const _sv = pr.reduce((t: number, x: any) => t + (parseFloat(x.totalPrice) || 0), 0); return { ...d, products: pr, saleValue: _sv.toFixed(2) }; })} className="w-16 border rounded px-1 py-0.5 text-xs text-right" /></td>
                            <td className="text-right p-1.5"><input type="number" step="0.01" value={p.unitPrice ?? ''} onChange={(e) => setEditData((d: any) => { const pr = [...d.products]; const u = parseFloat(e.target.value) || 0; pr[i] = { ...pr[i], unitPrice: u, totalPrice: (parseFloat(pr[i].quantity) || 0) * u }; const _sv = pr.reduce((t: number, x: any) => t + (parseFloat(x.totalPrice) || 0), 0); return { ...d, products: pr, saleValue: _sv.toFixed(2) }; })} className="w-20 border rounded px-1 py-0.5 text-xs text-right" /></td>
                            <td className="text-right p-1.5 font-semibold whitespace-nowrap">{formatCurrency(p.totalPrice)} <button onClick={() => setEditData((d: any) => { const pr = d.products.filter((_: any, x: number) => x !== i); const _sv = pr.reduce((t: number, x: any) => t + (parseFloat(x.totalPrice) || 0), 0); return { ...d, products: pr, saleValue: _sv.toFixed(2) }; })} className="text-red-500 ml-1">✕</button></td>
                          </tr>
                        )) : detailItem.products?.map((p, i) => (
                          <tr key={i} className="border-t hover:bg-gray-50 dark:hover:bg-gray-800">
                            <td className="p-2.5 text-gray-400">{i + 1}</td>
                            <td className="p-2.5 font-medium">{p.name}</td>
                            <td className="text-right p-2.5">{p.quantity}</td>
                            <td className="text-right p-2.5">{formatCurrency(p.unitPrice)}</td>
                            <td className="text-right p-2.5 font-semibold">{formatCurrency(p.totalPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 dark:bg-gray-700">
                        <tr className="border-t-2">
                          <td colSpan={4} className="p-2.5 text-right font-bold">Total:</td>
                          <td className="text-right p-2.5 font-bold text-green-700">{formatCurrency(editMode ? editData?.saleValue : detailItem.saleValue)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {editMode && (
                    <div className="mt-2 relative">
                      <input
                        value={prodSearch}
                        onChange={(e) => setProdSearch(e.target.value)}
                        placeholder="🔍 Buscar produto para adicionar ao pedido…"
                        className="w-full border rounded px-2 py-1.5 text-xs"
                        data-testid="input-add-product-search"
                      />
                      {prodSearch.trim() && (
                        <div className="absolute z-20 left-0 right-0 border rounded mt-1 max-h-48 overflow-auto bg-white dark:bg-gray-800 shadow-lg">
                          {(productCatalog as any[])
                            .filter((pc: any) => (pc.name || '').toLowerCase().includes(prodSearch.toLowerCase()) && !(editData?.products || []).some((ep: any) => ep.id && ep.id === pc.id))
                            .slice(0, 25)
                            .map((pc: any) => {
                              const up = parseFloat(pc.price ?? pc.unitPrice ?? '0') || 0;
                              return (
                                <button
                                  key={pc.id}
                                  type="button"
                                  onClick={() => {
                                    setEditData((d: any) => {
                                      const pr = [...(d.products || []), { id: pc.id, name: pc.name, quantity: 1, unitPrice: up, totalPrice: up }];
                                      const _sv = pr.reduce((t: number, x: any) => t + (parseFloat(x.totalPrice) || 0), 0);
                                      return { ...d, products: pr, saleValue: _sv.toFixed(2) };
                                    });
                                    setProdSearch('');
                                  }}
                                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 dark:hover:bg-gray-700 flex justify-between items-center gap-2 border-b last:border-b-0"
                                >
                                  <span className="truncate">{pc.name}</span>
                                  <span className="text-gray-500 whitespace-nowrap">{formatCurrency(up)}</span>
                                </button>
                              );
                            })}
                          {(productCatalog as any[]).filter((pc: any) => (pc.name || '').toLowerCase().includes(prodSearch.toLowerCase()) && !(editData?.products || []).some((ep: any) => ep.id && ep.id === pc.id)).length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-gray-400">Nenhum produto encontrado.</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {(detailItem.notes || editMode) && (
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-1 block">Observações</label>
                  {editMode ? (
                    <textarea value={editData?.notes ?? ''} onChange={(e) => setEditData((d: any) => ({ ...d, notes: e.target.value }))} rows={2} className="w-full border rounded px-2 py-1 text-sm" />
                  ) : (<p className="text-sm bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3 rounded-lg">{detailItem.notes}</p>)}
                </div>
              )}

              {detailItem.stageHistory && detailItem.stageHistory.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="h-4 w-4 text-gray-500" />
                    <span className="font-semibold text-sm text-gray-700 dark:text-gray-300">Histórico de Etapas</span>
                  </div>
                  <div className="space-y-1.5">
                    {detailItem.stageHistory.map((h, i) => {
                      const stageInfo = STAGES.find(s => s.key === h.stage);
                      return (
                        <div key={i} className="flex items-center justify-between text-xs bg-gray-50 dark:bg-gray-800 p-2.5 rounded-lg">
                          <Badge className={stageInfo?.badgeColor || 'bg-gray-100'}>{stageInfo?.label || h.stage}</Badge>
                          <span className="text-gray-500">{h.changedBy} - {formatDate(h.changedAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {editMode && (
                <div className="border-t pt-4 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditMode(false)}>Cancelar</Button>
                  <Button size="sm" onClick={saveEdit} disabled={updateItemMutation.isPending} className="bg-green-600 hover:bg-green-700 text-white" data-testid="button-save-order">{updateItemMutation.isPending ? 'Salvando…' : 'Salvar alterações'}</Button>
                </div>
              )}
              {!editMode && (
              <div className="border-t pt-4 space-y-4">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-2 block">Ações</label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300"
                    onClick={() => detailItem && duplicateMutation.mutate(detailItem.id)}
                    disabled={duplicateMutation.isPending}
                    data-testid="button-duplicate-order"
                  >
                    {duplicateMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Copy className="h-3 w-3 mr-1" />}
                    Duplicar Pedido
                  </Button>
                </div>
                <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-2 block">Mover para etapa</label>
                <div className="flex flex-wrap gap-1.5">
                  {STAGES.filter(s => s.key !== detailItem.stage).map(s => {
                    const SIcon = s.icon;
                    return (
                      <Button
                        key={s.key}
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => {
                          moveToStage(detailItem, s.key);
                          setDetailItem(null);
                        }}
                        disabled={moveStageMutation.isPending}
                      >
                        <SIcon className="h-3 w-3 mr-1" />
                        {s.label}
                      </Button>
                    );
                  })}
                </div>
                </div>
              </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar Exclusao</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja remover este pedido do pipeline de faturamento?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancelar</Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Stage Confirm */}
      <Dialog open={!!batchStageTarget} onOpenChange={() => setBatchStageTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mover em Lote</DialogTitle>
            <DialogDescription>
              Mover {selectedIds.size} {selectedIds.size === 1 ? 'pedido' : 'pedidos'} para{' '}
              <strong>{STAGES.find(s => s.key === batchStageTarget)?.label}</strong>?
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const blockedSet = new Set((blockedOrders as any[]).map((b: any) => b.id));
            const blockedCount = Array.from(selectedIds).filter(id => blockedSet.has(id)).length;
            return blockedCount > 0 ? (
              <div className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 rounded px-2 py-1.5">
                {blockedCount} {blockedCount === 1 ? 'pedido bloqueado será LIBERADO' : 'pedidos bloqueados serão LIBERADOS'} para o faturamento (entram na etapa "Pedido"), não movidos para a etapa selecionada.
              </div>
            ) : null;
          })()}
          <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1 max-h-40 overflow-y-auto">
            {selectedItems.map(item => (
              <div key={item.id} className="flex items-center justify-between py-1 border-b last:border-0">
                <span className="truncate flex-1">{item.customerName}</span>
                <span className="text-green-700 font-semibold ml-2">{formatCurrency(item.saleValue)}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchStageTarget(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (!batchStageTarget) return;
                // Cards da coluna "Bloqueados" carregam o id de blocked_orders (NAO existe em
                // billing_pipeline). Mover em lote precisa separar: bloqueados => LIBERAR (release),
                // demais => mudanca de etapa normal. Sem isso o batch/stage devolvia "Item nao encontrado".
                const blockedSet = new Set((blockedOrders as any[]).map((b: any) => b.id));
                const allIds = Array.from(selectedIds);
                const blockedIds = allIds.filter(id => blockedSet.has(id));
                const pipelineIds = allIds.filter(id => !blockedSet.has(id));
                if (blockedIds.length) releaseBlockedMutation.mutate(blockedIds);
                if (pipelineIds.length) {
                  batchStageMutation.mutate({ ids: pipelineIds, stage: batchStageTarget });
                } else {
                  setBatchStageTarget(null);
                  setSelectedIds(new Set());
                }
              }}
              disabled={batchStageMutation.isPending || releaseBlockedMutation.isPending}
            >
              {(batchStageMutation.isPending || releaseBlockedMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArrowRightCircle className="h-4 w-4 mr-1" />}
              Mover {selectedIds.size} pedidos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Delete Confirm */}
      <Dialog open={batchDeleteConfirm} onOpenChange={() => setBatchDeleteConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover em Lote</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja remover {selectedIds.size} {selectedIds.size === 1 ? 'pedido' : 'pedidos'} do pipeline?
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1 max-h-40 overflow-y-auto">
            {selectedItems.map(item => (
              <div key={item.id} className="flex items-center justify-between py-1 border-b last:border-0">
                <span className="truncate flex-1">{item.customerName}</span>
                <span className="text-green-700 font-semibold ml-2">{formatCurrency(item.saleValue)}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDeleteConfirm(false)}>Cancelar</Button>
            <Button
              variant="destructive"
              onClick={() => batchDeleteMutation.mutate(Array.from(selectedIds))}
              disabled={batchDeleteMutation.isPending}
            >
              {batchDeleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Remover {selectedIds.size} pedidos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

function KanbanCard({
  item,
  stage,
  selected,
  onToggleSelect,
  onMoveForward,
  onMoveBackward,
  onViewDetail,
  onDelete,
  isFirst,
  isLast,
  isMoving,
  onRetryInvoice,
  isRetrying,
  canBlock,
  onBlock,
  isBlocking,
  canEdit = true,
}: {
  item: BillingPipelineItem;
  stage: typeof STAGES[number];
  selected: boolean;
  onToggleSelect: () => void;
  onMoveForward: () => void;
  onMoveBackward: () => void;
  onViewDetail: () => void;
  onDelete: () => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
  onRetryInvoice: () => void;
  isRetrying: boolean;
  canBlock?: boolean;
  onBlock?: () => void;
  isBlocking?: boolean;
  canEdit?: boolean;
}) {
  const fs = (item.fiscalStatus || '').toLowerCase();
  const isBlocked = stage.key === 'bloqueado';
  // "Cancelado" é só status fiscal real — NÃO estar na coluna Bloqueados. Assim o card bloqueado
  // mostra a tag de Tipo de Operação (Venda/Amostra) registrada no pedido, não "Cancelado".
  const isCancelled = ['cancelled', 'canceled', 'rejected', 'denied', 'cancelada', 'rejeitada'].includes(fs);
  const isBilledOk = !isCancelled && !isBlocked && (fs === 'authorized' || fs === 'autorizada' || !!item.invoiceNumber);
  const statusBg = selected
    ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20'
    : (isCancelled || isBlocked)
      ? 'bg-red-50 dark:bg-red-900/20 border border-red-300'
      : isBilledOk
        ? 'bg-green-50 dark:bg-green-900/20 border border-green-300'
        : '';
  return (
    <Card
      className={`shadow-sm hover:shadow-md transition-all cursor-pointer border-l-4 ${statusBg}`}
      style={{ borderLeftColor: `var(--${stage.key}-color, #6b7280)` }}
      onClick={onViewDetail}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          {canEdit && (
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect()}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 h-6 w-6 flex-shrink-0"
          />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate">{item.customerName}</p>
            {item.sellerName && (
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <User className="h-3 w-3" />
                {item.sellerName}
              </p>
            )}
          </div>
          <button onClick={(e) => { e.stopPropagation(); onViewDetail(); }} className="text-gray-400 hover:text-gray-600">
            <Eye className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-green-700 flex items-center gap-1">
            <DollarSign className="h-3 w-3" />
            {formatCurrency(item.saleValue)}
          </span>
          {item.paymentMethod && (
            <Badge variant="outline" className="text-[10px]">
              {PAYMENT_LABELS[item.paymentMethod] || item.paymentMethod}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(() => {
            const cat = operationCategory(item);
            if (!cat) return null;
            return (
              <Badge variant="outline" className={`text-[10px] ${operationBadgeClass(cat)}`}>
                {CATEGORY_LABELS[cat] || OPERATION_LABELS[cat] || cat}
              </Badge>
            );
          })()}
          {item.omieInstanceName && (
            <Badge variant="secondary" className={`text-[10px] ${instanceBadgeClass(item.omieInstanceName)}`}>
              <MapPin className="h-2.5 w-2.5 mr-0.5" />
              {item.omieInstanceName}
            </Badge>
          )}
          {item.invoiceNumber && (
            <Badge variant="outline" className="text-[10px] border-green-300 text-green-700 bg-green-50">
              NF {item.invoiceNumber}
            </Badge>
          )}
        </div>

        <div className="text-[10px] text-gray-400">
          {formatDate(item.createdAt)}
        </div>

        {canEdit && stage.key !== 'bloqueado' && (['rejected', 'rejeitada', 'denied', 'draft'].includes(fs) || !!item.fiscalError) && (
          <div className="rounded bg-red-50 dark:bg-red-900/20 border border-red-200 p-1.5 space-y-1">
            <p className="text-[10px] text-red-700 leading-snug">
              <span className="font-semibold">Falha no faturamento:</span>{' '}
              {item.fiscalError || 'NF-e não autorizada (ficou em rascunho).'}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-6 w-full text-[11px] border-red-300 text-red-700 hover:bg-red-100"
              disabled={isRetrying}
              onClick={(e) => { e.stopPropagation(); onRetryInvoice(); }}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isRetrying ? 'animate-spin' : ''}`} />
              {isRetrying ? 'Re-tentando...' : 'Re-tentar faturamento'}
            </Button>
          </div>
        )}
        {canEdit && (
        <div className="flex items-center justify-between pt-1 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(e) => { e.stopPropagation(); onMoveBackward(); }}
            disabled={isFirst || isMoving}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <div className="flex items-center gap-1">
            {canBlock && !isBlocked && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1 text-xs text-orange-600 hover:text-orange-800"
                title="Bloquear pedido (admin)"
                disabled={isBlocking}
                onClick={(e) => { e.stopPropagation(); onBlock && onBlock(); }}
              >
                <Ban className="h-3 w-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-xs text-red-500 hover:text-red-700"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(e) => { e.stopPropagation(); onMoveForward(); }}
            disabled={isLast || isMoving}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
        )}
      </CardContent>
    </Card>
  );
}
