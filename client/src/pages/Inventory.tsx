import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Package, Plus, Edit, Trash2, RefreshCw, ArrowRightLeft,
  Loader2, Search, AlertTriangle, CheckCircle2, Archive,
  TrendingDown, TrendingUp, History
} from 'lucide-react';

interface InventoryLot {
  id: string;
  productId: string;
  instanceId: string;
  stockType: 'in_use' | 'blocked';
  lotNumber: string;
  quantity: string;
  minQuantity: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InventoryMovement {
  id: string;
  lotId: string;
  productId: string;
  instanceId: string;
  movementType: string;
  quantity: string;
  previousQuantity: string;
  newQuantity: string;
  sourceType: string;
  sourceId: string | null;
  lotNumber: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface Product {
  id: string;
  name: string;
  omieInstanceId?: string;
}

interface OmieInstance {
  id: string;
  name: string;
  shortCode: string;
}

interface InventorySummary {
  lots: (InventoryLot & { product: Product | null; instance: OmieInstance | null })[];
  totalProducts: number;
  totalInstances: number;
  totalInUse: number;
  totalBlocked: number;
}

const INSTANCE_COLORS: Record<string, string> = {
  'GYN': 'bg-blue-100 text-blue-800 border-blue-300',
  'BSB': 'bg-green-100 text-green-800 border-green-300',
  'UBR': 'bg-purple-100 text-purple-800 border-purple-300',
  'default': 'bg-gray-100 text-gray-800 border-gray-300',
};

function getInstanceColor(code: string) {
  return INSTANCE_COLORS[code] || INSTANCE_COLORS['default'];
}

export default function Inventory() {
  const [activeTab, setActiveTab] = useState('lots');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterInstance, setFilterInstance] = useState('all');
  const [filterStockType, setFilterStockType] = useState('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingLot, setEditingLot] = useState<InventoryLot | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const [formData, setFormData] = useState({
    productId: '',
    instanceId: '',
    stockType: 'in_use' as 'in_use' | 'blocked',
    lotNumber: '',
    quantity: '',
    minQuantity: '0',
    notes: '',
  });

  const summaryQuery = useQuery<InventorySummary>({
    queryKey: ['/api/inventory/summary'],
  });

  const lotsQuery = useQuery<InventoryLot[]>({
    queryKey: ['/api/inventory/lots'],
  });

  const movementsQuery = useQuery<InventoryMovement[]>({
    queryKey: ['/api/inventory/movements'],
    enabled: activeTab === 'movements',
  });

  const productsQuery = useQuery<Product[]>({
    queryKey: ['/api/products'],
  });

  const instancesQuery = useQuery<OmieInstance[]>({
    queryKey: ['/api/omie-instances'],
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await apiRequest('POST', '/api/inventory/lots', data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/lots'] });
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/movements'] });
      setShowCreateDialog(false);
      resetForm();
      toast({ title: 'Lote criado com sucesso' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao criar lote', description: err.message, variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest('PUT', `/api/inventory/lots/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/lots'] });
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/movements'] });
      setShowEditDialog(false);
      setEditingLot(null);
      toast({ title: 'Lote atualizado com sucesso' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao atualizar lote', description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest('DELETE', `/api/inventory/lots/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/lots'] });
      queryClient.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
      toast({ title: 'Lote excluído com sucesso' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao excluir lote', description: err.message, variant: 'destructive' });
    },
  });

  const resetForm = () => {
    setFormData({
      productId: '',
      instanceId: '',
      stockType: 'in_use',
      lotNumber: '',
      quantity: '',
      minQuantity: '0',
      notes: '',
    });
  };

  const products = productsQuery.data || [];
  const instances = instancesQuery.data || [];

  const productMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const instanceMap = useMemo(() => new Map(instances.map(i => [i.id, i])), [instances]);

  const filteredLots = useMemo(() => {
    const lots = summaryQuery.data?.lots || [];
    return lots.filter(lot => {
      if (filterInstance !== 'all' && lot.instanceId !== filterInstance) return false;
      if (filterStockType !== 'all' && lot.stockType !== filterStockType) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const productName = lot.product?.name || '';
        const lotNumber = lot.lotNumber || '';
        if (!productName.toLowerCase().includes(term) && !lotNumber.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [summaryQuery.data?.lots, filterInstance, filterStockType, searchTerm]);

  const groupedByInstance = useMemo(() => {
    const groups: Record<string, typeof filteredLots> = {};
    for (const lot of filteredLots) {
      const key = lot.instanceId;
      if (!groups[key]) groups[key] = [];
      groups[key].push(lot);
    }
    return groups;
  }, [filteredLots]);

  const handleCreate = () => {
    if (!formData.productId || !formData.instanceId || !formData.lotNumber || !formData.quantity) {
      toast({ title: 'Preencha todos os campos obrigatórios', variant: 'destructive' });
      return;
    }
    createMutation.mutate(formData);
  };

  const handleEdit = (lot: InventoryLot) => {
    setEditingLot(lot);
    setFormData({
      productId: lot.productId,
      instanceId: lot.instanceId,
      stockType: lot.stockType,
      lotNumber: lot.lotNumber,
      quantity: lot.quantity,
      minQuantity: lot.minQuantity || '0',
      notes: lot.notes || '',
    });
    setShowEditDialog(true);
  };

  const handleUpdate = () => {
    if (!editingLot) return;
    updateMutation.mutate({
      id: editingLot.id,
      data: {
        lotNumber: formData.lotNumber,
        quantity: formData.quantity,
        minQuantity: formData.minQuantity,
        notes: formData.notes,
        isActive: editingLot.isActive,
      },
    });
  };

  const handleDelete = (lot: InventoryLot) => {
    if (confirm(`Deseja excluir o lote ${lot.lotNumber}?`)) {
      deleteMutation.mutate(lot.id);
    }
  };

  const isLoading = summaryQuery.isLoading || productsQuery.isLoading || instancesQuery.isLoading;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <BackToDashboardButton />
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Package className="h-7 w-7 text-blue-600" />
                Gestão de Estoque
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Controle de lotes, estoque em uso e bloqueado por instância
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
                queryClient.invalidateQueries({ queryKey: ['/api/inventory/lots'] });
                queryClient.invalidateQueries({ queryKey: ['/api/inventory/movements'] });
              }}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Atualizar
            </Button>
            <Button
              size="sm"
              onClick={() => { resetForm(); setShowCreateDialog(true); }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Novo Lote
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 uppercase">Produtos</p>
                  <p className="text-2xl font-bold">{summaryQuery.data?.totalProducts || 0}</p>
                </div>
                <Package className="h-8 w-8 text-blue-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 uppercase">Instâncias</p>
                  <p className="text-2xl font-bold">{summaryQuery.data?.totalInstances || 0}</p>
                </div>
                <Archive className="h-8 w-8 text-purple-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 uppercase">Estoque em Uso</p>
                  <p className="text-2xl font-bold text-green-600">{(summaryQuery.data?.totalInUse || 0).toFixed(0)}</p>
                </div>
                <TrendingUp className="h-8 w-8 text-green-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 uppercase">Estoque Bloqueado</p>
                  <p className="text-2xl font-bold text-amber-600">{(summaryQuery.data?.totalBlocked || 0).toFixed(0)}</p>
                </div>
                <AlertTriangle className="h-8 w-8 text-amber-500 opacity-50" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="lots">
              <Package className="h-4 w-4 mr-1" />
              Lotes de Estoque
            </TabsTrigger>
            <TabsTrigger value="movements">
              <History className="h-4 w-4 mr-1" />
              Movimentações
            </TabsTrigger>
          </TabsList>

          <TabsContent value="lots" className="mt-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3 mb-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Buscar por produto ou lote..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={filterInstance} onValueChange={setFilterInstance}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Instância" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas Instâncias</SelectItem>
                  {instances.map(i => (
                    <SelectItem key={i.id} value={i.id}>{i.shortCode} - {i.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStockType} onValueChange={setFilterStockType}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os Tipos</SelectItem>
                  <SelectItem value="in_use">Em Uso</SelectItem>
                  <SelectItem value="blocked">Bloqueado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              </div>
            ) : filteredLots.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-gray-500">
                  <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Nenhum lote de estoque encontrado</p>
                  <p className="text-sm mt-1">Crie um novo lote para começar a controlar seu estoque</p>
                </CardContent>
              </Card>
            ) : (
              Object.entries(groupedByInstance).map(([instanceId, lots]) => {
                const instance = instanceMap.get(instanceId);
                const colorClass = getInstanceColor(instance?.shortCode || 'default');
                return (
                  <Card key={instanceId} className="mb-4">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Badge variant="outline" className={`${colorClass} border px-3 py-1`}>
                          {instance?.shortCode || instanceId}
                        </Badge>
                        <span className="text-gray-700 dark:text-gray-300">{instance?.name || 'Instância Desconhecida'}</span>
                        <Badge variant="secondary" className="ml-auto">{lots.length} lotes</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Produto</TableHead>
                              <TableHead>Tipo</TableHead>
                              <TableHead>Lote</TableHead>
                              <TableHead className="text-right">Quantidade</TableHead>
                              <TableHead className="text-right">Qtd. Mínima</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Ações</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {lots.map(lot => {
                              const qty = parseFloat(lot.quantity);
                              const minQty = parseFloat(lot.minQuantity || '0');
                              const isLow = minQty > 0 && qty <= minQty;
                              return (
                                <TableRow key={lot.id} className={isLow ? 'bg-red-50 dark:bg-red-950/20' : ''}>
                                  <TableCell className="font-medium">
                                    {lot.product?.name || lot.productId}
                                  </TableCell>
                                  <TableCell>
                                    {lot.stockType === 'in_use' ? (
                                      <Badge className="bg-green-100 text-green-800 border-green-300">Em Uso</Badge>
                                    ) : (
                                      <Badge className="bg-amber-100 text-amber-800 border-amber-300">Bloqueado</Badge>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                                      {lot.lotNumber}
                                    </code>
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    <span className={isLow ? 'text-red-600 font-bold' : ''}>
                                      {qty.toFixed(2)}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-gray-500">
                                    {minQty.toFixed(2)}
                                  </TableCell>
                                  <TableCell>
                                    {!lot.isActive ? (
                                      <Badge variant="secondary">Inativo</Badge>
                                    ) : isLow ? (
                                      <Badge variant="destructive" className="flex items-center gap-1 w-fit">
                                        <AlertTriangle className="h-3 w-3" />
                                        Estoque Baixo
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-green-600 border-green-300 flex items-center gap-1 w-fit">
                                        <CheckCircle2 className="h-3 w-3" />
                                        Normal
                                      </Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex justify-end gap-1">
                                      <Button variant="ghost" size="sm" onClick={() => handleEdit(lot)}>
                                        <Edit className="h-4 w-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-red-500 hover:text-red-700"
                                        onClick={() => handleDelete(lot)}
                                        disabled={qty > 0}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="movements" className="mt-4">
            {movementsQuery.isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              </div>
            ) : (
              <Card>
                <CardContent className="pt-4">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Data/Hora</TableHead>
                          <TableHead>Produto</TableHead>
                          <TableHead>Instância</TableHead>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Lote</TableHead>
                          <TableHead className="text-right">Quantidade</TableHead>
                          <TableHead>Origem</TableHead>
                          <TableHead>Notas</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(movementsQuery.data || []).length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center py-8 text-gray-500">
                              Nenhuma movimentação encontrada
                            </TableCell>
                          </TableRow>
                        ) : (
                          (movementsQuery.data || []).map(mov => {
                            const product = productMap.get(mov.productId);
                            const instance = instanceMap.get(mov.instanceId);
                            const qty = parseFloat(mov.quantity);
                            return (
                              <TableRow key={mov.id}>
                                <TableCell className="text-sm whitespace-nowrap">
                                  {new Date(mov.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                                </TableCell>
                                <TableCell className="font-medium">
                                  {product?.name || mov.productId}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline" className={getInstanceColor(instance?.shortCode || 'default')}>
                                    {instance?.shortCode || mov.instanceId}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <MovementTypeBadge type={mov.movementType} />
                                </TableCell>
                                <TableCell>
                                  <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded">
                                    {mov.lotNumber}
                                  </code>
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  <span className={qty >= 0 ? 'text-green-600' : 'text-red-600'}>
                                    {qty >= 0 ? '+' : ''}{qty.toFixed(2)}
                                  </span>
                                  <span className="text-gray-400 text-xs ml-1">
                                    ({mov.previousQuantity} → {mov.newQuantity})
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <SourceTypeBadge type={mov.sourceType} sourceId={mov.sourceId} />
                                </TableCell>
                                <TableCell className="text-sm text-gray-500 max-w-[200px] truncate">
                                  {mov.notes}
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Create Lot Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo Lote de Estoque</DialogTitle>
            <DialogDescription>Cadastre um novo lote de estoque para controle</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Produto *</Label>
              <Select value={formData.productId} onValueChange={(v) => setFormData({...formData, productId: v})}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o produto" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {products.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Instância *</Label>
              <Select value={formData.instanceId} onValueChange={(v) => setFormData({...formData, instanceId: v})}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a instância" />
                </SelectTrigger>
                <SelectContent>
                  {instances.map(i => (
                    <SelectItem key={i.id} value={i.id}>{i.shortCode} - {i.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo de Estoque *</Label>
              <Select value={formData.stockType} onValueChange={(v: 'in_use' | 'blocked') => setFormData({...formData, stockType: v})}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_use">Em Uso</SelectItem>
                  <SelectItem value="blocked">Bloqueado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Número do Lote *</Label>
              <Input
                value={formData.lotNumber}
                onChange={(e) => setFormData({...formData, lotNumber: e.target.value})}
                placeholder="Ex: LOTE-2026-001"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantidade *</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.quantity}
                  onChange={(e) => setFormData({...formData, quantity: e.target.value})}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label>Qtd. Mínima</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.minQuantity}
                  onChange={(e) => setFormData({...formData, minQuantity: e.target.value})}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea
                value={formData.notes}
                onChange={(e) => setFormData({...formData, notes: e.target.value})}
                placeholder="Notas opcionais sobre o lote..."
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Criar Lote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Lot Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Lote</DialogTitle>
            <DialogDescription>Altere as informações do lote de estoque</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Produto</Label>
              <Input disabled value={productMap.get(editingLot?.productId || '')?.name || editingLot?.productId || ''} />
            </div>
            <div>
              <Label>Instância</Label>
              <Input disabled value={instanceMap.get(editingLot?.instanceId || '')?.name || editingLot?.instanceId || ''} />
            </div>
            <div>
              <Label>Tipo</Label>
              <Input disabled value={editingLot?.stockType === 'in_use' ? 'Em Uso' : 'Bloqueado'} />
            </div>
            <div>
              <Label>Número do Lote</Label>
              <Input
                value={formData.lotNumber}
                onChange={(e) => setFormData({...formData, lotNumber: e.target.value})}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantidade</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.quantity}
                  onChange={(e) => setFormData({...formData, quantity: e.target.value})}
                />
              </div>
              <div>
                <Label>Qtd. Mínima</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.minQuantity}
                  onChange={(e) => setFormData({...formData, minQuantity: e.target.value})}
                />
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea
                value={formData.notes}
                onChange={(e) => setFormData({...formData, notes: e.target.value})}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancelar</Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MovementTypeBadge({ type }: { type: string }) {
  const config: Record<string, { label: string; className: string }> = {
    'consume': { label: 'Consumo', className: 'bg-red-100 text-red-800' },
    'adjust': { label: 'Ajuste', className: 'bg-blue-100 text-blue-800' },
    'transfer': { label: 'Transferência', className: 'bg-purple-100 text-purple-800' },
    'cancel_reversal': { label: 'Cancelamento', className: 'bg-green-100 text-green-800' },
    'return': { label: 'Devolução', className: 'bg-amber-100 text-amber-800' },
  };
  const c = config[type] || { label: type, className: 'bg-gray-100 text-gray-800' };
  return <Badge className={c.className}>{c.label}</Badge>;
}

function SourceTypeBadge({ type, sourceId }: { type: string; sourceId: string | null }) {
  const config: Record<string, { label: string; className: string }> = {
    'invoice': { label: 'NF-e', className: 'bg-indigo-100 text-indigo-800' },
    'order': { label: 'Pedido', className: 'bg-cyan-100 text-cyan-800' },
    'manual': { label: 'Manual', className: 'bg-gray-100 text-gray-800' },
  };
  const c = config[type] || { label: type, className: 'bg-gray-100 text-gray-800' };
  return (
    <div className="flex items-center gap-1">
      <Badge className={c.className}>{c.label}</Badge>
      {sourceId && <span className="text-xs text-gray-400">#{sourceId.substring(0, 8)}</span>}
    </div>
  );
}
