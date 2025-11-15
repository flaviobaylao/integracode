import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Search, Package, FileText, CheckCircle, Clock, Truck } from "lucide-react";

interface OrderStepsProps {
  step: 'sale' | 'billing' | 'billed' | 'awaiting-route' | 'in-route';
}

interface OmieOrder {
  codigo_pedido: number;
  numero_pedido: string;
  codigo_cliente: number;
  cliente: {
    nome_fantasia: string;
    cnpj_cpf: string;
  };
  etapa: string;
  data_pedido: string;
  qtde_itens: number;
  valor_total_pedido: number;
  codigo_vendedor?: number;
  vendedor?: string;
}

interface OrdersData {
  orders: OmieOrder[];
  totalCount: number;
  currentStep: string;
}

const stepConfig = {
  sale: {
    title: 'Pedido de Venda',
    icon: Package,
    color: 'bg-blue-100 text-blue-800',
    omieStage: '10'
  },
  billing: {
    title: 'Faturar',
    icon: FileText,
    color: 'bg-yellow-100 text-yellow-800',
    omieStage: '20'
  },
  billed: {
    title: 'Faturado',
    icon: CheckCircle,
    color: 'bg-green-100 text-green-800',
    omieStage: '30'
  },
  'awaiting-route': {
    title: 'Aguardando Rota',
    icon: Clock,
    color: 'bg-orange-100 text-orange-800',
    omieStage: '40'
  },
  'in-route': {
    title: 'Em Rota',
    icon: Truck,
    color: 'bg-purple-100 text-purple-800',
    omieStage: '50'
  }
};

export default function OrderSteps({ step }: OrderStepsProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const config = stepConfig[step];
  const IconComponent = config.icon;

  // Query para buscar pedidos da etapa
  const { data: ordersData, isLoading, refetch } = useQuery<OrdersData>({
    queryKey: [`/api/omie/orders/${step}`],
    enabled: false, // Não carregar automaticamente
  });

  // Mutation para sincronizar pedidos da etapa
  const syncOrders = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/omie/orders/${step}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Erro ao sincronizar pedidos');
      }

      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/omie/orders/${step}`] });
      toast({
        title: "Sincronização concluída",
        description: `${data.count || 0} pedidos sincronizados da etapa ${config.title}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredOrders = ordersData?.orders?.filter(order => {
    const searchLower = searchTerm.toLowerCase();
    return order.cliente.nome_fantasia.toLowerCase().includes(searchLower) ||
           order.numero_pedido.includes(searchTerm) ||
           order.cliente.cnpj_cpf.includes(searchTerm);
  }) || [];

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className={`p-2 ${config.color} rounded-lg`}>
            <IconComponent className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{config.title}</h1>
            <p className="text-gray-600">Sincronizar e gerenciar pedidos nesta etapa</p>
          </div>
        </div>
        
        <div className="flex space-x-3">
          <Button 
            onClick={() => refetch()} 
            variant="outline"
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
          <Button 
            onClick={() => syncOrders.mutate()}
            disabled={syncOrders.isPending}
            data-testid="button-sync-orders"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncOrders.isPending ? 'animate-spin' : ''}`} />
            Sincronizar do Omie
          </Button>
        </div>
      </div>

      {/* Stats Card */}
      {ordersData && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center">
              <div className={`p-2 ${config.color} rounded-lg mr-4`}>
                <IconComponent className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm text-gray-600">Total de Pedidos</p>
                <p className="text-2xl font-bold text-gray-900">{ordersData.totalCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      {ordersData && (
        <div className="flex items-center space-x-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Buscar por cliente, número do pedido ou documento..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
              data-testid="input-search-orders"
            />
          </div>
        </div>
      )}

      {/* Orders List */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : ordersData ? (
        <div className="space-y-4">
          {filteredOrders.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <IconComponent className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {searchTerm ? 'Nenhum pedido encontrado' : 'Nenhum pedido nesta etapa'}
                </h3>
                <p className="text-gray-600">
                  {searchTerm 
                    ? 'Tente ajustar os termos da busca.' 
                    : 'Sincronize com o Omie para carregar os pedidos desta etapa.'
                  }
                </p>
              </CardContent>
            </Card>
          ) : (
            filteredOrders.map((order) => (
              <Card key={order.codigo_pedido} className="border border-gray-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <Badge className={config.color}>
                        {config.title}
                      </Badge>
                      <div>
                        <CardTitle className="text-lg">{order.cliente.nome_fantasia}</CardTitle>
                        <p className="text-sm text-gray-600">
                          Pedido: {order.numero_pedido} | {order.cliente.cnpj_cpf}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-green-600">
                        {formatCurrency(order.valor_total_pedido)}
                      </p>
                      <p className="text-sm text-gray-600">
                        {order.qtde_itens} {order.qtde_itens === 1 ? 'item' : 'itens'}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600">Data do Pedido</p>
                      <p className="font-medium">{new Date(order.data_pedido).toLocaleDateString('pt-BR')}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Vendedor</p>
                      <p className="font-medium">{order.vendedor || 'Não informado'}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Etapa Atual</p>
                      <p className="font-medium">{order.etapa}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center">
            <IconComponent className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Sincronize os pedidos
            </h3>
            <p className="text-gray-600 mb-4">
              Clique em "Sincronizar do Omie" para carregar os pedidos da etapa {config.title}.
            </p>
            <Button onClick={() => syncOrders.mutate()} disabled={syncOrders.isPending}>
              <RefreshCw className={`h-4 w-4 mr-2 ${syncOrders.isPending ? 'animate-spin' : ''}`} />
              Sincronizar do Omie
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}