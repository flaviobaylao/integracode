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
  RefreshCw, ChevronRight, ChevronLeft, User, DollarSign, MapPin,
  Power, CheckSquare, X, ArrowRightCircle
} from 'lucide-react';

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
  paymentMethod: string | null;
  operationType: string | null;
  products: Array<{ id: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  notes: string | null;
  omieInstanceId: string | null;
  omieInstanceName: string | null;
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
  const [detailItem, setDetailItem] = useState<BillingPipelineItem | null>(null);
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
      return await apiRequest('POST', '/api/billing-pipeline/sync-now');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      toast({ title: 'Pipeline sincronizado', description: 'Dados atualizados a partir do Integra 1.0' });
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
    moveStageMutation.mutate({ id: item.id, stage: STAGES[nextIdx].key });
  };

  const moveToStage = (item: BillingPipelineItem, stage: string) => {
    moveStageMutation.mutate({ id: item.id, stage });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="p-4">
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
        <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 120px)' }}>
          {STAGES.map((stage) => {
            const stageItems = groupedByStage[stage.key] || [];
            const stageTotal = stageItems.reduce((sum, i) => sum + (i.saleValue ? parseFloat(i.saleValue) : 0), 0);
            const StageIcon = stage.icon;
            const stageIds = stageItems.map(i => i.id);
            const allStageSelected = stageIds.length > 0 && stageIds.every(id => selectedIds.has(id));
            const someStageSelected = stageIds.some(id => selectedIds.has(id));
            return (
              <div key={stage.key} className="flex-shrink-0 w-72">
                <div className={`rounded-t-lg px-3 py-2 ${stage.color} text-white flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    {stageItems.length > 0 && (
                      <Checkbox
                        checked={allStageSelected}
                        className="border-white data-[state=checked]:bg-white data-[state=checked]:text-gray-900 h-4 w-4"
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
                  {stageItems.length === 0 && (
                    <div className="text-center text-gray-400 text-sm py-8">
                      Nenhum pedido
                    </div>
                  )}
                  {stageItems.map((item) => (
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
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail Modal */}
      <Dialog open={!!detailItem} onOpenChange={() => setDetailItem(null)}>
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
                <Badge className={STAGES.find(s => s.key === detailItem.stage)?.badgeColor || 'bg-gray-100'}>
                  {STAGES.find(s => s.key === detailItem.stage)?.label || detailItem.stage}
                </Badge>
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
                    <p className="font-bold text-lg text-green-700">{formatCurrency(detailItem.saleValue)}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Pagamento</label>
                    <p className="text-sm">{PAYMENT_LABELS[detailItem.paymentMethod || ''] || detailItem.paymentMethod || '-'}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Operação</label>
                    <p className="text-sm">{OPERATION_LABELS[detailItem.operationType || ''] || detailItem.operationType || '-'}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Vendedor</label>
                    <p className="text-sm">{detailItem.sellerName || '-'}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Instância Omie</label>
                    <p className="text-sm">{detailItem.omieInstanceName || '-'}</p>
                  </div>
                  {detailItem.invoiceNumber && (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">Nota Fiscal</label>
                      <p className="text-sm font-mono font-semibold text-orange-700">{detailItem.invoiceNumber}</p>
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

              {detailItem.products && detailItem.products.length > 0 && (
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
                        {detailItem.products.map((p, i) => (
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
                          <td className="text-right p-2.5 font-bold text-green-700">{formatCurrency(detailItem.saleValue)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {detailItem.notes && (
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-1 block">Observações</label>
                  <p className="text-sm bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3 rounded-lg">{detailItem.notes}</p>
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

              <div className="border-t pt-4">
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
              onClick={() => batchStageTarget && batchStageMutation.mutate({ ids: Array.from(selectedIds), stage: batchStageTarget })}
              disabled={batchStageMutation.isPending}
            >
              {batchStageMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArrowRightCircle className="h-4 w-4 mr-1" />}
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
}) {
  const fs = (item.fiscalStatus || '').toLowerCase();
  const isCancelled = ['cancelled', 'canceled', 'rejected', 'denied', 'cancelada', 'rejeitada'].includes(fs) || stage.key === 'bloqueado';
  const isBilledOk = !isCancelled && (fs === 'authorized' || fs === 'autorizada' || (!!item.invoiceNumber && stage.key !== 'bloqueado'));
  const statusBg = selected
    ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20'
    : isCancelled
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
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect()}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 h-4 w-4 flex-shrink-0"
          />
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

        {item.omieInstanceName && (
          <Badge variant="secondary" className="text-[10px]">
            <MapPin className="h-2.5 w-2.5 mr-0.5" />
            {item.omieInstanceName}
          </Badge>
        )}

        <div className="text-[10px] text-gray-400">
          {formatDate(item.createdAt)}
        </div>

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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs text-red-500 hover:text-red-700"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
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
      </CardContent>
    </Card>
  );
}
