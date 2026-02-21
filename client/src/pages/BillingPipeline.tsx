import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Package, ArrowRight, ArrowLeft, Loader2, Trash2, Eye,
  ClipboardList, FileText, Printer, Clock, Truck, CheckCircle2,
  RefreshCw, ChevronRight, ChevronLeft, User, DollarSign, MapPin,
  Plus, Search
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
  { key: 'pedido', label: 'Pedido', icon: ClipboardList, color: 'bg-blue-500', badgeColor: 'bg-blue-100 text-blue-800' },
  { key: 'a_faturar', label: 'A Faturar', icon: FileText, color: 'bg-yellow-500', badgeColor: 'bg-yellow-100 text-yellow-800' },
  { key: 'faturado', label: 'Faturado', icon: FileText, color: 'bg-orange-500', badgeColor: 'bg-orange-100 text-orange-800' },
  { key: 'impresso', label: 'Impresso', icon: Printer, color: 'bg-purple-500', badgeColor: 'bg-purple-100 text-purple-800' },
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
  const [showBypassDialog, setShowBypassDialog] = useState(false);
  const [bypassSearch, setBypassSearch] = useState('');

  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
  });

  const isFlavio = (currentUser as any)?.email === 'flavio@bebahonest.com.br';

  const { data: items = [], isLoading } = useQuery<BillingPipelineItem[]>({
    queryKey: ['/api/billing-pipeline'],
  });

  const { data: salesCards = [] } = useQuery<any[]>({
    queryKey: ['/api/sales-cards'],
    enabled: showBypassDialog,
  });

  const filteredSalesCards = useMemo(() => {
    if (!bypassSearch.trim()) return salesCards.slice(0, 20);
    const term = bypassSearch.toLowerCase();
    return salesCards.filter((c: any) =>
      (c.customerName || '').toLowerCase().includes(term) ||
      (c.sellerName || '').toLowerCase().includes(term) ||
      (c.id || '').toLowerCase().includes(term)
    ).slice(0, 20);
  }, [salesCards, bypassSearch]);

  const bypassMutation = useMutation({
    mutationFn: async (salesCardId: string) => {
      const res = await apiRequest('POST', '/api/billing-pipeline/bypass', { salesCardId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      setShowBypassDialog(false);
      setBypassSearch('');
      toast({ title: 'Pedido enviado para faturamento interno' });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao enviar para faturamento', description: error.message, variant: 'destructive' });
    }
  });

  const moveStageMutation = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: string }) => {
      const res = await apiRequest('PATCH', `/api/billing-pipeline/${id}/stage`, { stage });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      toast({ title: 'Stage atualizado com sucesso' });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao mover item', description: error.message, variant: 'destructive' });
    }
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

  const groupedByStage = useMemo(() => {
    const groups: Record<string, BillingPipelineItem[]> = {};
    STAGES.forEach(s => { groups[s.key] = []; });
    items.forEach(item => {
      if (groups[item.stage]) {
        groups[item.stage].push(item);
      }
    });
    return groups;
  }, [items]);

  const moveItem = (item: BillingPipelineItem, direction: 'forward' | 'backward') => {
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
            <Badge variant="outline" className="text-sm">
              {items.length} pedidos no pipeline
            </Badge>
            {isFlavio && (
              <Button
                size="sm"
                className="bg-purple-600 hover:bg-purple-700 text-white"
                onClick={() => setShowBypassDialog(true)}
                data-testid="button-faturar-interno"
              >
                <Plus className="h-4 w-4 mr-1" />
                Faturar Interno
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] })}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Atualizar
            </Button>
          </div>
        </div>

        {/* Kanban Board */}
        <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 120px)' }}>
          {STAGES.map((stage) => {
            const stageItems = groupedByStage[stage.key] || [];
            const StageIcon = stage.icon;
            return (
              <div key={stage.key} className="flex-shrink-0 w-72">
                <div className={`rounded-t-lg px-3 py-2 ${stage.color} text-white flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    <StageIcon className="h-4 w-4" />
                    <span className="font-semibold text-sm">{stage.label}</span>
                  </div>
                  <Badge className="bg-white/20 text-white text-xs">{stageItems.length}</Badge>
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
                      onMoveForward={() => moveItem(item, 'forward')}
                      onMoveBackward={() => moveItem(item, 'backward')}
                      onViewDetail={() => setDetailItem(item)}
                      onDelete={() => setDeleteConfirm(item.id)}
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
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalhes do Pedido</DialogTitle>
            <DialogDescription>
              Informacoes completas do pedido no pipeline
            </DialogDescription>
          </DialogHeader>
          {detailItem && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Cliente</label>
                  <p className="font-semibold text-sm">{detailItem.customerName}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Documento</label>
                  <p className="text-sm">{detailItem.customerDocument || '-'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Vendedor</label>
                  <p className="text-sm">{detailItem.sellerName || '-'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Valor</label>
                  <p className="font-semibold text-sm text-green-700">{formatCurrency(detailItem.saleValue)}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Pagamento</label>
                  <p className="text-sm">{PAYMENT_LABELS[detailItem.paymentMethod || ''] || detailItem.paymentMethod || '-'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Operacao</label>
                  <p className="text-sm">{OPERATION_LABELS[detailItem.operationType || ''] || detailItem.operationType || '-'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Instancia Omie</label>
                  <p className="text-sm">{detailItem.omieInstanceName || '-'}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500">Criado por</label>
                  <p className="text-sm">{detailItem.createdBy || '-'}</p>
                </div>
              </div>

              {detailItem.products && detailItem.products.length > 0 && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Produtos</label>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 dark:bg-gray-700">
                        <tr>
                          <th className="text-left p-2">Produto</th>
                          <th className="text-right p-2">Qtd</th>
                          <th className="text-right p-2">Unit.</th>
                          <th className="text-right p-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailItem.products.map((p, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-2">{p.name}</td>
                            <td className="text-right p-2">{p.quantity}</td>
                            <td className="text-right p-2">{formatCurrency(p.unitPrice)}</td>
                            <td className="text-right p-2">{formatCurrency(p.totalPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {detailItem.notes && (
                <div>
                  <label className="text-xs text-gray-500">Observacoes</label>
                  <p className="text-sm bg-gray-50 dark:bg-gray-800 p-2 rounded">{detailItem.notes}</p>
                </div>
              )}

              {/* Stage History */}
              {detailItem.stageHistory && detailItem.stageHistory.length > 0 && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Historico de Etapas</label>
                  <div className="space-y-1">
                    {detailItem.stageHistory.map((h, i) => {
                      const stageInfo = STAGES.find(s => s.key === h.stage);
                      return (
                        <div key={i} className="flex items-center justify-between text-xs bg-gray-50 dark:bg-gray-800 p-2 rounded">
                          <Badge className={stageInfo?.badgeColor || 'bg-gray-100'}>{stageInfo?.label || h.stage}</Badge>
                          <span className="text-gray-500">{h.changedBy} - {formatDate(h.changedAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Move to stage buttons */}
              <div>
                <label className="text-xs text-gray-500 mb-2 block">Mover para etapa:</label>
                <div className="flex flex-wrap gap-1">
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

      {/* Bypass - Faturar Interno Dialog */}
      <Dialog open={showBypassDialog} onOpenChange={(open) => { setShowBypassDialog(open); if (!open) setBypassSearch(''); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-purple-600" />
              Faturar Interno
            </DialogTitle>
            <DialogDescription>
              Selecione um pedido para enviar ao pipeline de faturamento interno
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Buscar por cliente, vendedor ou ID..."
              value={bypassSearch}
              onChange={(e) => setBypassSearch(e.target.value)}
              className="pl-9"
              data-testid="bypass-search-input"
            />
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0 max-h-[50vh]">
            {filteredSalesCards.length === 0 && (
              <div className="text-center text-gray-400 text-sm py-8">
                {salesCards.length === 0 ? 'Carregando pedidos...' : 'Nenhum pedido encontrado'}
              </div>
            )}
            {filteredSalesCards.map((card: any) => {
              const alreadyInPipeline = items.some(i => i.salesCardId === card.id);
              return (
                <div
                  key={card.id}
                  className={`border rounded-lg p-3 ${alreadyInPipeline ? 'opacity-50 bg-gray-50 dark:bg-gray-800' : 'hover:border-purple-300 hover:bg-purple-50/50 dark:hover:bg-purple-900/10 cursor-pointer'} transition-colors`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{card.customerName || 'Cliente sem nome'}</p>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                        {card.sellerName && (
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {card.sellerName}
                          </span>
                        )}
                        <span className="font-semibold text-green-700">
                          {formatCurrency(card.totalValue || card.saleValue || 0)}
                        </span>
                        {card.omieInstanceName && (
                          <Badge variant="secondary" className="text-[10px]">
                            {card.omieInstanceName}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {alreadyInPipeline ? (
                      <Badge variant="outline" className="text-[10px] text-gray-500 shrink-0">
                        Ja no pipeline
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        className="bg-purple-600 hover:bg-purple-700 text-white shrink-0"
                        onClick={() => bypassMutation.mutate(card.id)}
                        disabled={bypassMutation.isPending}
                        data-testid={`bypass-card-${card.id}`}
                      >
                        {bypassMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Plus className="h-3 w-3 mr-1" />
                            Enviar
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KanbanCard({
  item,
  stage,
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
  onMoveForward: () => void;
  onMoveBackward: () => void;
  onViewDetail: () => void;
  onDelete: () => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
}) {
  return (
    <Card className="shadow-sm hover:shadow-md transition-shadow cursor-pointer border-l-4" style={{ borderLeftColor: `var(--${stage.key}-color, #6b7280)` }}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between">
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
