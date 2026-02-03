import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Home, Search, ShoppingCart, Package, DollarSign, Calendar, User, Eye, MapPin, Phone, Mail, Trash2, Send } from 'lucide-react';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import OmieInstanceBadge from '@/components/OmieInstanceBadge';

interface HotsiteOrder {
  id: string;
  customerId: string;
  sellerId: string;
  status: string;
  scheduledDate: string;
  completedDate?: string;
  saleValue?: string;
  products?: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  paymentMethod?: string;
  operationType?: string;
  notes?: string;
  source?: string;
  customerAddress?: string;
}

interface Customer {
  id: string;
  name: string;
  fantasy_name?: string;
  phone?: string;
  email?: string;
  address?: string;
  cpf?: string;
  cnpj?: string;
}

export default function HotsiteOrders() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<HotsiteOrder | null>(null);
  const { toast } = useToast();

  // Buscar pedidos do hotsite
  const { data: hotsiteData, isLoading: isLoadingOrders } = useQuery<{
    orders: HotsiteOrder[];
    debug: {
      totalOrders: number;
      ordersWithSource: number;
      hotsiteOrders: number;
      sourceExamples: Array<{ id: string; source: string; status: string; date: string }>;
      timestamp: string;
    };
  }>({
    queryKey: ['/api/hotsite-orders'],
  });

  const orders = hotsiteData?.orders || [];
  const debugInfo = hotsiteData?.debug;

  // Buscar clientes para exibir nomes
  const { data: customers } = useQuery<Customer[]>({
    queryKey: ['/api/customers'],
  });

  // Criar mapa de clientes para lookup rápido
  const customersMap = customers?.reduce((map, customer) => {
    map[customer.id] = customer;
    return map;
  }, {} as Record<string, Customer>) || {};

  // Mutation para excluir pedido
  const deleteMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const response = await fetch(`/api/hotsite-orders/${orderId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao excluir pedido');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/hotsite-orders'] });
      setSelectedOrder(null);
      toast({
        title: 'Pedido excluído',
        description: 'O pedido foi excluído com sucesso.',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Erro ao excluir',
        description: error.message || 'Não foi possível excluir o pedido.',
        variant: 'destructive',
      });
    },
  });

  // Mutation para enviar pedido para Omie
  const sendToOmieMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const response = await fetch(`/api/hotsite-orders/${orderId}/send-to-omie`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao enviar para Omie');
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/hotsite-orders'] });
      toast({
        title: 'Pedido enviado para Omie',
        description: `Pedido criado no Omie: ${data.numero_pedido || 'N/A'}`,
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Erro ao enviar para Omie',
        description: error.message || 'Não foi possível enviar o pedido para o Omie.',
        variant: 'destructive',
      });
    },
  });

  const handleDeleteOrder = (orderId: string) => {
    if (confirm('Tem certeza que deseja excluir este pedido?')) {
      deleteMutation.mutate(orderId);
    }
  };

  const handleSendToOmie = (orderId: string) => {
    if (confirm('Deseja enviar este pedido para faturamento no Omie? Se o cliente não estiver cadastrado, será criado automaticamente.')) {
      sendToOmieMutation.mutate(orderId);
    }
  };

  // Filtrar pedidos
  const filteredOrders = orders?.filter(order => {
    const customer = customersMap[order.customerId];
    const customerName = customer?.fantasy_name || customer?.name || '';
    const matchesSearch = customerName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
    return matchesSearch && matchesStatus;
  }) || [];

  // Calcular estatísticas
  const stats = {
    totalOrders: filteredOrders.length,
    totalValue: filteredOrders.reduce((sum, order) => {
      const value = parseFloat(order.saleValue || '0');
      return sum + (isNaN(value) ? 0 : value);
    }, 0),
    pendingOrders: filteredOrders.filter(o => o.status === 'pending').length,
    completedOrders: filteredOrders.filter(o => o.status === 'completed').length,
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' }> = {
      pending: { label: 'Pendente', variant: 'warning' },
      completed: { label: 'Concluído', variant: 'success' },
      invoiced: { label: 'Faturado', variant: 'default' },
      cancelled: { label: 'Cancelado', variant: 'destructive' },
    };
    const statusInfo = statusMap[status] || { label: status, variant: 'secondary' };
    return <Badge variant={statusInfo.variant as any}>{statusInfo.label}</Badge>;
  };

  const getPaymentMethodLabel = (method?: string) => {
    const methodMap: Record<string, string> = {
      a_vista: 'À Vista',
      pix: 'PIX',
      boleto: 'Boleto',
      card: 'Cartão',
    };
    return methodMap[method || ''] || method || '-';
  };

  const getOperationTypeLabel = (type?: string) => {
    const typeMap: Record<string, string> = {
      venda: 'Venda',
      troca: 'Troca',
      amostra: 'Amostra',
    };
    return typeMap[type || ''] || type || 'Venda';
  };

  const formatDocument = (cpf?: string, cnpj?: string) => {
    if (cnpj) {
      // Format CNPJ: 00.000.000/0000-00
      const cleaned = cnpj.replace(/\D/g, '');
      if (cleaned.length === 14) {
        return cleaned.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
      }
      return cnpj;
    }
    if (cpf) {
      // Format CPF: 000.000.000-00
      const cleaned = cpf.replace(/\D/g, '');
      if (cleaned.length === 11) {
        return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      }
      return cpf;
    }
    return '-';
  };

  const extractOrderNumber = (notes?: string): string => {
    if (!notes) return '-';
    const match = notes.match(/WEB-\d+/);
    return match ? match[0] : '-';
  };

  const getDeliveryAddress = (order: HotsiteOrder, customer?: Customer): string | null => {
    if (order.customerAddress) return order.customerAddress;
    if (customer?.address) return customer.address;
    return null;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50">
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Pedidos do Site</h1>
            <p className="text-gray-600">Pedidos realizados através do hotsite</p>
          </div>
          <BackToDashboardButton />
        </div>

        {/* Debug Info (Temporário) */}
        {debugInfo && (
          <Card className="mb-6 bg-yellow-50 border-yellow-200">
            <CardHeader>
              <CardTitle className="text-sm">🔍 Informações de Debug</CardTitle>
              <CardDescription className="text-xs">Dados do banco de dados em produção</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="font-semibold">Total de Cards:</p>
                  <p className="text-2xl font-bold">{debugInfo.totalOrders}</p>
                </div>
                <div>
                  <p className="font-semibold">Com campo source:</p>
                  <p className="text-2xl font-bold">{debugInfo.ordersWithSource}</p>
                </div>
                <div>
                  <p className="font-semibold">Source = "hotsite":</p>
                  <p className="text-2xl font-bold text-orange-600">{debugInfo.hotsiteOrders}</p>
                </div>
                <div>
                  <p className="font-semibold">Timestamp:</p>
                  <p className="text-xs">{new Date(debugInfo.timestamp).toLocaleString('pt-BR')}</p>
                </div>
              </div>
              {debugInfo.sourceExamples && debugInfo.sourceExamples.length > 0 && (
                <div className="mt-4">
                  <p className="font-semibold mb-2 text-xs">Exemplos de source (primeiros 10 registros):</p>
                  <div className="bg-white rounded p-2 text-xs font-mono overflow-x-auto">
                    {debugInfo.sourceExamples.map((ex, i) => (
                      <div key={i} className="flex gap-2 py-1 border-b last:border-0">
                        <span className="text-gray-500">#{i + 1}</span>
                        <span className="font-semibold">{ex.id}...</span>
                        <span className={ex.source === 'hotsite' ? 'text-orange-600 font-bold' : 'text-gray-600'}>
                          source: {ex.source || 'null'}
                        </span>
                        <span className="text-gray-500">status: {ex.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total de Pedidos</CardTitle>
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalOrders}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Valor Total</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                R$ {stats.totalValue.toFixed(2)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pendingOrders}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Concluídos</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.completedOrders}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Filtros</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Buscar por cliente..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-customer"
                />
              </div>
              <div>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  data-testid="select-status-filter"
                >
                  <option value="all">Todos os Status</option>
                  <option value="pending">Pendente</option>
                  <option value="completed">Concluído</option>
                  <option value="invoiced">Faturado</option>
                  <option value="cancelled">Cancelado</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Orders Table */}
        <Card>
          <CardHeader>
            <CardTitle>Pedidos ({filteredOrders.length})</CardTitle>
            <CardDescription>
              Lista completa de pedidos realizados pelo hotsite
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingOrders ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto"></div>
                <p className="mt-4 text-gray-600">Carregando pedidos...</p>
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="text-center py-8">
                <ShoppingCart className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">Nenhum pedido encontrado</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pedido</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Endereço de Entrega</TableHead>
                      <TableHead>Produtos</TableHead>
                      <TableHead>Valor</TableHead>
                      <TableHead>Pagamento</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-center">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => {
                      const customer = customersMap[order.customerId];
                      const customerName = customer?.fantasy_name || customer?.name || 'Cliente não encontrado';
                      const deliveryAddress = getDeliveryAddress(order, customer);
                      const orderNumber = extractOrderNumber(order.notes);
                      
                      return (
                        <TableRow 
                          key={order.id} 
                          data-testid={`row-order-${order.id}`}
                          className={`cursor-pointer hover:bg-gray-50 ${deliveryAddress ? 'bg-green-50 hover:bg-green-100' : ''}`}
                          onClick={() => setSelectedOrder(order)}
                        >
                          <TableCell>
                            <div className="font-mono text-sm font-medium text-blue-600">
                              {orderNumber}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-gray-400" />
                              {format(new Date(order.scheduledDate), 'dd/MM/yyyy', { locale: ptBR })}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-gray-400" />
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="font-medium">{customerName}</div>
                                  <OmieInstanceBadge instanceId={(customer as any)?.omieInstanceId} />
                                </div>
                                {customer?.phone && (
                                  <div className="text-xs text-gray-500">{customer.phone}</div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {deliveryAddress ? (
                              <div className="flex items-start gap-1 max-w-xs">
                                <MapPin className="h-4 w-4 text-green-600 flex-shrink-0 mt-0.5" />
                                <span className="text-sm text-gray-700 truncate" title={deliveryAddress}>
                                  {deliveryAddress.length > 40 ? deliveryAddress.substring(0, 40) + '...' : deliveryAddress}
                                </span>
                              </div>
                            ) : (
                              <span className="text-gray-400 text-sm">Não informado</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="max-w-xs">
                              {order.products && order.products.length > 0 ? (
                                <div className="space-y-1">
                                  {order.products.map((product, idx) => (
                                    <div key={idx} className="text-sm">
                                      {product.quantity}x {product.name}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-gray-400">-</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-semibold text-green-700">
                              R$ {parseFloat(order.saleValue || '0').toFixed(2)}
                            </div>
                          </TableCell>
                          <TableCell>{getPaymentMethodLabel(order.paymentMethod)}</TableCell>
                          <TableCell>{getStatusBadge(order.status)}</TableCell>
                          <TableCell className="text-center">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedOrder(order);
                              }}
                              data-testid={`button-view-details-${order.id}`}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Order Details Dialog */}
        <Dialog open={!!selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            {selectedOrder && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5" />
                    Detalhes do Pedido
                    <Badge variant="outline" className="ml-2 font-mono text-blue-600">
                      {extractOrderNumber(selectedOrder.notes)}
                    </Badge>
                  </DialogTitle>
                  <DialogDescription>
                    Pedido realizado em {format(new Date(selectedOrder.scheduledDate), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-6">
                  {/* Status e Informações Gerais */}
                  <div className="grid grid-cols-2 gap-4">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-gray-600">Status</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {getStatusBadge(selectedOrder.status)}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-gray-600">Valor Total</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold text-green-700">
                          R$ {parseFloat(selectedOrder.saleValue || '0').toFixed(2)}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Cliente */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <User className="h-5 w-5" />
                        Informações do Cliente
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(() => {
                        const customer = customersMap[selectedOrder.customerId];
                        const customerName = customer?.fantasy_name || customer?.name || 'Cliente não encontrado';
                        
                        return (
                          <>
                            <div>
                              <div className="text-sm font-medium text-gray-600">Nome</div>
                              <div className="text-lg font-semibold">{customerName}</div>
                            </div>
                            {(customer?.cpf || customer?.cnpj) && (
                              <div>
                                <div className="text-sm font-medium text-gray-600">
                                  {customer?.cnpj ? 'CNPJ' : 'CPF'}
                                </div>
                                <div className="text-lg font-mono font-semibold">
                                  {formatDocument(customer?.cpf, customer?.cnpj)}
                                </div>
                              </div>
                            )}
                            {customer?.phone && (
                              <div className="flex items-center gap-2 text-gray-700">
                                <Phone className="h-4 w-4" />
                                {customer.phone}
                              </div>
                            )}
                            {customer?.email && (
                              <div className="flex items-center gap-2 text-gray-700">
                                <Mail className="h-4 w-4" />
                                {customer.email}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </CardContent>
                  </Card>

                  {/* Endereço de Entrega */}
                  {(() => {
                    const customer = customersMap[selectedOrder.customerId];
                    const deliveryAddress = getDeliveryAddress(selectedOrder, customer);
                    return deliveryAddress ? (
                      <Card className="border-green-200 bg-green-50">
                        <CardHeader>
                          <CardTitle className="text-lg flex items-center gap-2 text-green-800">
                            <MapPin className="h-5 w-5" />
                            Endereço de Entrega
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-gray-700 font-medium">
                            {deliveryAddress}
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <Card className="border-yellow-200 bg-yellow-50">
                        <CardHeader>
                          <CardTitle className="text-lg flex items-center gap-2 text-yellow-800">
                            <MapPin className="h-5 w-5" />
                            Endereço de Entrega
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-yellow-700">
                            Endereço não informado
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })()}

                  {/* Produtos */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <Package className="h-5 w-5" />
                        Produtos
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {selectedOrder.products && selectedOrder.products.length > 0 ? (
                        <div className="space-y-3">
                          {selectedOrder.products.map((product, idx) => (
                            <div 
                              key={idx} 
                              className="flex justify-between items-start p-3 bg-gray-50 rounded-lg"
                            >
                              <div className="flex-1">
                                <div className="font-medium">{product.name}</div>
                                <div className="text-sm text-gray-600">
                                  Quantidade: {product.quantity}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-sm text-gray-600">
                                  R$ {product.unitPrice.toFixed(2)} cada
                                </div>
                                <div className="font-semibold text-green-700">
                                  R$ {(product.quantity * product.unitPrice).toFixed(2)}
                                </div>
                              </div>
                            </div>
                          ))}
                          <div className="pt-3 border-t flex justify-between items-center">
                            <div className="font-semibold">Total</div>
                            <div className="text-xl font-bold text-green-700">
                              R$ {parseFloat(selectedOrder.saleValue || '0').toFixed(2)}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-4 text-gray-500">
                          Nenhum produto encontrado
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Pagamento e Tipo */}
                  <div className="grid grid-cols-2 gap-4">
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-gray-600">
                          Método de Pagamento
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-2">
                          <DollarSign className="h-4 w-4 text-gray-400" />
                          <span className="font-medium">
                            {getPaymentMethodLabel(selectedOrder.paymentMethod)}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium text-gray-600">
                          Tipo de Operação
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <span className="font-medium">
                          {getOperationTypeLabel(selectedOrder.operationType)}
                        </span>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Observações */}
                  {selectedOrder.notes && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">Observações</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-gray-700 whitespace-pre-wrap">{selectedOrder.notes}</p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Ações */}
                  <div className="flex justify-between gap-2 pt-4 border-t">
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        onClick={() => handleDeleteOrder(selectedOrder.id)}
                        disabled={deleteMutation.isPending}
                        data-testid="button-delete-order"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {deleteMutation.isPending ? 'Excluindo...' : 'Excluir Pedido'}
                      </Button>
                      <Button
                        variant="default"
                        onClick={() => handleSendToOmie(selectedOrder.id)}
                        disabled={sendToOmieMutation.isPending}
                        data-testid="button-send-to-omie"
                        className="bg-green-600 hover:bg-green-700"
                      >
                        <Send className="h-4 w-4 mr-2" />
                        {sendToOmieMutation.isPending ? 'Enviando...' : 'Enviar para Omie'}
                      </Button>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setSelectedOrder(null)}
                      data-testid="button-close-details"
                    >
                      Fechar
                    </Button>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
