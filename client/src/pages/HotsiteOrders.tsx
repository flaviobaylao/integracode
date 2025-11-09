import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Home, Search, ShoppingCart, Package, DollarSign, Calendar, User, Send, CheckCircle, XCircle, Clock } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';

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
  // Novos campos de sync com Omie
  omieSyncStatus?: 'aguardando_omie' | 'enviado_omie' | 'erro_omie' | null;
  omieOrderNumber?: string;
  omieSentAt?: string;
  omieErrorMessage?: string;
}

interface Customer {
  id: string;
  name: string;
  fantasy_name?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export default function HotsiteOrders() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
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

  // Mutation para enviar pedido ao Omie
  const sendToOmieMutation = useMutation({
    mutationFn: async (orderId: string) => {
      return await apiRequest(`/api/hotsite-orders/${orderId}/send-to-omie`, {
        method: 'POST',
      });
    },
    onSuccess: (data: any) => {
      const orderNumber = data?.omieOrderNumber || 'pendente';
      const isDemo = orderNumber.startsWith('STUB');
      
      toast({
        title: isDemo ? 'Demonstração' : 'Pedido enviado ao Omie!',
        description: isDemo 
          ? 'Integração com Omie em desenvolvimento. Este é um envio simulado.' 
          : `Pedido #${orderNumber} criado com sucesso`,
        variant: isDemo ? 'default' : 'default',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/hotsite-orders'] });
    },
    onError: (error: any) => {
      toast({
        title: 'Erro ao enviar pedido',
        description: error.message || 'Ocorreu um erro ao enviar o pedido ao Omie',
        variant: 'destructive',
      });
    },
  });

  // Buscar clientes para exibir nomes
  const { data: customers } = useQuery<Customer[]>({
    queryKey: ['/api/customers'],
  });

  // Criar mapa de clientes para lookup rápido
  const customersMap = customers?.reduce((map, customer) => {
    map[customer.id] = customer;
    return map;
  }, {} as Record<string, Customer>) || {};

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

  const getOmieSyncBadge = (omieSyncStatus?: string | null) => {
    if (!omieSyncStatus) {
      return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />Pendente</Badge>;
    }
    
    const statusMap: Record<string, { label: string; variant: 'default' | 'success' | 'destructive'; icon: any }> = {
      aguardando_omie: { label: 'Aguardando', variant: 'default', icon: Clock },
      enviado_omie: { label: 'Enviado', variant: 'success', icon: CheckCircle },
      erro_omie: { label: 'Erro', variant: 'destructive', icon: XCircle },
    };
    
    const statusInfo = statusMap[omieSyncStatus] || { label: omieSyncStatus, variant: 'secondary', icon: Clock };
    const Icon = statusInfo.icon;
    
    return (
      <Badge variant={statusInfo.variant as any} className="gap-1">
        <Icon className="h-3 w-3" />
        {statusInfo.label}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50">
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="outline" size="icon" data-testid="button-back-home">
                <Home className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Pedidos do Site</h1>
              <p className="text-gray-600">Pedidos realizados através do hotsite</p>
            </div>
          </div>
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
                      <TableHead>Data</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Produtos</TableHead>
                      <TableHead>Valor</TableHead>
                      <TableHead>Pagamento</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Status Omie</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => {
                      const customer = customersMap[order.customerId];
                      const customerName = customer?.fantasy_name || customer?.name || 'Cliente não encontrado';
                      const canSendToOmie = !order.omieSyncStatus || order.omieSyncStatus === 'erro_omie';
                      
                      return (
                        <TableRow key={order.id} data-testid={`row-order-${order.id}`}>
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
                                <div className="font-medium">{customerName}</div>
                                {customer?.phone && (
                                  <div className="text-xs text-gray-500">{customer.phone}</div>
                                )}
                              </div>
                            </div>
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
                          <TableCell>{getOperationTypeLabel(order.operationType)}</TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {getOmieSyncBadge(order.omieSyncStatus)}
                              {order.omieOrderNumber && (
                                <div className="text-xs text-gray-500">
                                  Pedido #{order.omieOrderNumber}
                                </div>
                              )}
                              {order.omieErrorMessage && (
                                <div className="text-xs text-red-600 max-w-xs truncate" title={order.omieErrorMessage}>
                                  {order.omieErrorMessage}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {canSendToOmie && (
                              <Button
                                size="sm"
                                onClick={() => sendToOmieMutation.mutate(order.id)}
                                disabled={sendToOmieMutation.isPending}
                                className="gap-1"
                                data-testid={`button-send-to-omie-${order.id}`}
                              >
                                <Send className="h-3 w-3" />
                                {sendToOmieMutation.isPending ? 'Enviando...' : 'Enviar para Omie'}
                              </Button>
                            )}
                            {order.omieSyncStatus === 'enviado_omie' && (
                              <Badge variant="success" className="gap-1">
                                <CheckCircle className="h-3 w-3" />
                                Enviado
                              </Badge>
                            )}
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
      </div>
    </div>
  );
}
