import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Search, Unlock, Ban, AlertTriangle, Trash2 } from "lucide-react";
import type { User } from "@shared/schema";

interface BlockedOrder {
  id: string;
  salesCardId: string;
  customerId: string;
  sellerId: string;
  status: 'blocked' | 'released' | 'sent_to_omie';
  blockReason: string;
  blockDetails?: string;
  operationType: 'venda' | 'troca' | 'amostra';
  paymentMethod?: string;
  boletoDays?: number;
  totalAmount?: number;
  products: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  blockedAt: string;
  releasedAt?: string;
  releasedBy?: string;
  customer: {
    name: string;
    fantasyName?: string | null;
    phone: string;
    email?: string;
  };
  seller: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface BlockedOrdersProps {
  user?: User;
}

export default function BlockedOrdersManagement({ user }: BlockedOrdersProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const canReleaseOrders = user?.role && ['admin', 'coordinator', 'administrative'].includes(user.role);

  // Query para buscar pedidos bloqueados
  const { data: blockedOrders, isLoading } = useQuery<BlockedOrder[]>({
    queryKey: ['/api/blocked-orders'],
  });

  // Mutation para liberar pedidos selecionados
  const releaseOrdersMutation = useMutation({
    mutationFn: async (orderIds: string[]) => {
      return await apiRequest('POST', '/api/blocked-orders/release', { orderIds });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      setSelectedOrders(new Set());
      toast({
        title: "Pedidos liberados",
        description: `${data.released} pedido(s) liberado(s) e enviado(s) para o Omie.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro ao liberar pedidos",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation para rejeitar (deletar) pedidos liberados
  const rejectOrdersMutation = useMutation({
    mutationFn: async (orderIds: string[]) => {
      return await apiRequest('POST', '/api/blocked-orders/reject', { orderIds });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/blocked-orders'] });
      setSelectedOrders(new Set());
      toast({
        title: "Pedidos rejeitados",
        description: `${data.rejected} pedido(s) removido(s) do sistema.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro ao rejeitar pedidos",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredOrders = blockedOrders?.filter(order => {
    const searchLower = searchTerm.toLowerCase();
    return (order.customer.fantasyName || order.customer.name).toLowerCase().includes(searchLower) ||
           order.seller.firstName.toLowerCase().includes(searchLower) ||
           order.seller.lastName.toLowerCase().includes(searchLower) ||
           order.customer.phone.includes(searchTerm);
  }) || [];

  const handleSelectOrder = (orderId: string, checked: boolean) => {
    const newSelection = new Set(selectedOrders);
    if (checked) {
      newSelection.add(orderId);
    } else {
      newSelection.delete(orderId);
    }
    setSelectedOrders(newSelection);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedOrders(new Set(filteredOrders.map(order => order.id)));
    } else {
      setSelectedOrders(new Set());
    }
  };

  const handleReleaseSelected = () => {
    if (selectedOrders.size === 0) {
      toast({
        title: "Nenhum pedido selecionado",
        description: "Selecione pelo menos um pedido para liberar.",
        variant: "destructive",
      });
      return;
    }

    // Filtrar apenas pedidos com status 'blocked'
    const selectedOrdersData = filteredOrders.filter(order => selectedOrders.has(order.id));
    const blockedOrders = selectedOrdersData.filter(order => order.status === 'blocked');

    if (blockedOrders.length === 0) {
      toast({
        title: "Nenhum pedido bloqueado selecionado",
        description: "Selecione pedidos com status 'Bloqueado' para liberar.",
        variant: "destructive",
      });
      return;
    }

    releaseOrdersMutation.mutate(blockedOrders.map(order => order.id));
  };

  const handleRejectSelected = () => {
    if (selectedOrders.size === 0) {
      toast({
        title: "Nenhum pedido selecionado",
        description: "Selecione pelo menos um pedido para rejeitar.",
        variant: "destructive",
      });
      return;
    }

    // Verificar se há pedidos bloqueados selecionados
    const selectedOrdersData = filteredOrders.filter(order => selectedOrders.has(order.id));
    const blockedOrdersList = selectedOrdersData.filter(order => order.status === 'blocked');

    if (blockedOrdersList.length === 0) {
      toast({
        title: "Nenhum pedido bloqueado selecionado",
        description: "Selecione pedidos com status 'Bloqueado' para rejeitar.",
        variant: "destructive",
      });
      return;
    }

    rejectOrdersMutation.mutate(blockedOrdersList.map(order => order.id));
  };

  const formatCurrency = (value?: number) => {
    if (!value) return 'N/A';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const getBlockReasonLabel = (reason: string, operationType?: string, boletoDays?: number) => {
    switch (reason) {
      case 'operation_type':
        return operationType === 'troca' ? 'Pedido de Troca' : 'Pedido de Amostra';
      case 'overdue_debt':
        return 'Cliente com Débito Vencido';
      case 'credit_limit':
        return 'Limite de Crédito Excedido';
      case 'payment_term':
        return `Prazo de Boleto Excedido (${boletoDays || 0} dias)`;
      default:
        return reason;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'blocked':
        return <Badge variant="destructive">Bloqueado</Badge>;
      case 'released':
        return <Badge variant="secondary">Liberado</Badge>;
      case 'sent_to_omie':
        return <Badge variant="default">Enviado ao Omie</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getOperationTypeBadge = (type: string) => {
    const config = {
      'venda': { label: 'Venda', variant: 'default' as const },
      'troca': { label: 'Troca', variant: 'secondary' as const },
      'amostra': { label: 'Amostra', variant: 'outline' as const },
    };
    
    const { label, variant } = config[type as keyof typeof config] || { label: type, variant: 'outline' as const };
    return <Badge variant={variant}>{label}</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Pedidos Bloqueados</h1>
          <p className="text-gray-600 mt-1">
            Gerencie pedidos que foram automaticamente bloqueados pelo sistema
          </p>
        </div>
        {canReleaseOrders && (
          <div className="flex items-center gap-3">
            <Button 
              onClick={handleReleaseSelected}
              disabled={selectedOrders.size === 0 || releaseOrdersMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
              data-testid="button-release-orders"
            >
              <Unlock className="h-4 w-4 mr-2" />
              {releaseOrdersMutation.isPending 
                ? 'Liberando...' 
                : `Liberar ${selectedOrders.size} Pedido(s)`
              }
            </Button>
            <Button 
              onClick={handleRejectSelected}
              disabled={selectedOrders.size === 0 || rejectOrdersMutation.isPending}
              variant="destructive"
              data-testid="button-reject-orders"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {rejectOrdersMutation.isPending 
                ? 'Rejeitando...' 
                : `Rejeitar ${selectedOrders.size} Pedido(s)`
              }
            </Button>
          </div>
        )}
      </div>

      {!canReleaseOrders && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mr-3 mt-0.5" />
            <div>
              <h3 className="font-medium text-yellow-800">Acesso Restrito</h3>
              <p className="text-sm text-yellow-700 mt-1">
                Apenas administradores, coordenadores e equipe administrativa podem liberar pedidos bloqueados.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center space-x-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <Input
            placeholder="Buscar por cliente, vendedor ou telefone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-blocked-orders"
          />
        </div>
      </div>

      {/* Orders List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Lista de Pedidos Bloqueados</span>
            <div className="flex items-center space-x-2">
              {canReleaseOrders && (
                <Checkbox
                  checked={filteredOrders.length > 0 && selectedOrders.size === filteredOrders.length}
                  onCheckedChange={handleSelectAll}
                  data-testid="checkbox-select-all"
                />
              )}
              <Badge variant="secondary">
                {filteredOrders.length} pedido(s)
              </Badge>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">
              Carregando pedidos bloqueados...
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {searchTerm ? 'Nenhum pedido encontrado para a busca.' : 'Nenhum pedido bloqueado encontrado.'}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredOrders.map((order) => (
                <div
                  key={order.id}
                  className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-3">
                      {canReleaseOrders && (
                        <Checkbox
                          checked={selectedOrders.has(order.id)}
                          onCheckedChange={(checked) => handleSelectOrder(order.id, checked as boolean)}
                          disabled={order.status === 'sent_to_omie'}
                          data-testid={`checkbox-order-${order.id}`}
                        />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-2">
                          <h3 className="font-semibold text-lg text-gray-900">
                            {order.customer.fantasyName || order.customer.name}
                          </h3>
                          {getStatusBadge(order.status)}
                          {getOperationTypeBadge(order.operationType)}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-600">
                          <p><span className="font-medium">Vendedor:</span> {order.seller.firstName} {order.seller.lastName}</p>
                          <p><span className="font-medium">Telefone:</span> {order.customer.phone}</p>
                          <p><span className="font-medium">Motivo:</span> {getBlockReasonLabel(order.blockReason, order.operationType, order.boletoDays)}</p>
                          <p><span className="font-medium">Bloqueado em:</span> {new Date(order.blockedAt).toLocaleDateString('pt-BR')}</p>
                        </div>
                        {order.blockDetails && (
                          <p className="text-sm text-gray-500 mt-2">
                            <span className="font-medium">Detalhes:</span> {order.blockDetails}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-lg text-gray-900">
                        {formatCurrency(order.totalAmount)}
                      </p>
                      {order.products && order.products.length > 0 && (
                        <p className="text-sm text-gray-600">
                          {order.products.length} item(s)
                        </p>
                      )}
                    </div>
                  </div>
                  
                  {order.products && order.products.length > 0 && (
                    <div className="mt-3 pt-3 border-t">
                      <p className="text-sm font-medium text-gray-700 mb-2">Produtos:</p>
                      <div className="space-y-1">
                        {order.products.map((product, idx) => (
                          <div key={idx} className="flex justify-between text-sm">
                            <span>{product.name} (x{product.quantity})</span>
                            <span>{formatCurrency(product.totalPrice)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}