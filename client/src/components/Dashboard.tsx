import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isUnauthorizedError } from "@/lib/authUtils";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { RefreshCw } from "lucide-react";

export default function Dashboard() {
  const { toast } = useToast();
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const [isRefreshingSellers, setIsRefreshingSellers] = useState(false);

  // Redirect to home if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      toast({
        title: "Unauthorized",
        description: "You are logged out. Logging in again...",
        variant: "destructive",
      });
      setTimeout(() => {
        window.location.href = "/api/login";
      }, 500);
      return;
    }
  }, [isAuthenticated, isLoading, toast]);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['/api/dashboard/stats'],
    retry: false,
  });

  const { data: todayClients, isLoading: todayClientsLoading } = useQuery({
    queryKey: ['/api/dashboard/today-clients'],
    retry: false,
  });

  const { data: overdueClients, isLoading: overdueClientsLoading } = useQuery({
    queryKey: ['/api/dashboard/overdue-clients'],
    retry: false,
  });

  // Query para estatísticas dos vendedores (apenas para admin e coordinator)
  const { data: sellersStats, isLoading: sellersStatsLoading } = useQuery({
    queryKey: ['/api/dashboard/sellers-stats'],
    enabled: user && ['admin', 'coordinator'].includes(user.role),
    retry: false,
  });

  if (statsLoading || todayClientsLoading || overdueClientsLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-20 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  // Função para atualizar dados dos vendedores
  const handleRefreshSellers = async () => {
    setIsRefreshingSellers(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: ['/api/dashboard/sellers-stats']
      });
      toast({
        title: "Dados atualizados",
        description: "Performance dos vendedores atualizada com sucesso!",
      });
    } catch (error) {
      toast({
        title: "Erro",
        description: "Falha ao atualizar dados dos vendedores",
        variant: "destructive",
      });
    } finally {
      setIsRefreshingSellers(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'in_progress':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
        return 'bg-blue-100 text-blue-800';
      case 'no_sale':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed':
        return 'Vendido';
      case 'in_progress':
        return 'Em Atendimento';
      case 'pending':
        return 'Agendado';
      case 'no_sale':
        return 'Não Venda';
      default:
        return status;
    }
  };

  return (
    <div className="space-y-6">
      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Vendas Hoje</p>
                <p className="text-2xl font-bold text-gray-800">
                  {formatCurrency(stats?.todaySales || 0)}
                </p>
              </div>
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                <i className="fas fa-dollar-sign text-green-600"></i>
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              <span className="text-green-600 font-medium">+12%</span>
              <span className="text-gray-600 ml-1">vs ontem</span>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Clientes do Dia</p>
                <p className="text-2xl font-bold text-gray-800">{stats?.todayClients || 0}</p>
              </div>
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                <i className="fas fa-users text-honest-blue"></i>
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              <span className="text-gray-600">
                {todayClients?.filter((c: any) => c.status === 'completed').length || 0} visitados
              </span>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Atrasados</p>
                <p className="text-2xl font-bold text-red-600">{stats?.overdueClients || 0}</p>
              </div>
              <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center">
                <i className="fas fa-exclamation-triangle text-red-600"></i>
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              <span className="text-gray-600">Prioridade alta</span>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Taxa Conversão</p>
                <p className="text-2xl font-bold text-gray-800">{stats?.conversionRate || 0}%</p>
              </div>
              <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
                <i className="fas fa-chart-line text-honest-orange"></i>
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              <span className="text-green-600 font-medium">+5%</span>
              <span className="text-gray-600 ml-1">esta semana</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quadro de Vendedores (apenas para admin e coordinator) */}
      {user && ['admin', 'coordinator'].includes(user.role) && (
        <Card>
          <CardHeader className="border-b border-gray-200">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold text-gray-800">
                Performance dos Vendedores - {new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshSellers}
                disabled={isRefreshingSellers || sellersStatsLoading}
                data-testid="button-refresh-sellers"
                className="flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshingSellers ? 'animate-spin' : ''}`} />
                {isRefreshingSellers ? 'Atualizando...' : 'Atualizar'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            {sellersStatsLoading ? (
              <div className="animate-pulse">
                <div className="h-64 bg-gray-200 rounded"></div>
              </div>
            ) : sellersStats && sellersStats.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="sellers-stats-table">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Vendedor</th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700">Tamanho da Carteira</th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700">Clientes Positivados</th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700">% Positivação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellersStats.map((seller: any) => (
                      <tr key={seller.sellerId} className="border-b border-gray-100 hover:bg-gray-50" data-testid={`seller-row-${seller.sellerId}`}>
                        <td className="py-3 px-4">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 bg-honest-blue rounded-full flex items-center justify-center">
                              <i className="fas fa-user text-white text-sm"></i>
                            </div>
                            <span className="font-medium text-gray-800" data-testid={`seller-name-${seller.sellerId}`}>{seller.sellerName}</span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="text-lg font-semibold text-gray-800" data-testid={`active-clients-${seller.sellerId}`}>
                            {seller.activeClients}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className="text-lg font-semibold text-green-600" data-testid={`positivated-clients-${seller.sellerId}`}>
                            {seller.positivatedThisMonth}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center space-x-2">
                            <span className={`text-lg font-semibold ${
                              seller.positivationRate >= 30 ? 'text-green-600' :
                              seller.positivationRate >= 15 ? 'text-yellow-600' :
                              'text-red-600'
                            }`} data-testid={`positivation-rate-${seller.sellerId}`}>
                              {seller.positivationRate}%
                            </span>
                            <div className="w-16 bg-gray-200 rounded-full h-2">
                              <div 
                                className={`h-2 rounded-full ${
                                  seller.positivationRate >= 30 ? 'bg-green-500' :
                                  seller.positivationRate >= 15 ? 'bg-yellow-500' :
                                  'bg-red-500'
                                }`}
                                style={{ width: `${Math.min(seller.positivationRate, 100)}%` }}
                              ></div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-gray-500 text-center py-8">
                Nenhum vendedor encontrado
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Today's Route and Priority Clients */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's Clients */}
        <Card>
          <CardHeader className="border-b border-gray-200">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold text-gray-800">
                Clientes de Hoje
              </CardTitle>
              <span className="text-sm text-gray-600">
                {new Date().toLocaleDateString('pt-BR', { weekday: 'long' })}
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-4">
              {todayClients && todayClients.length > 0 ? (
                todayClients.slice(0, 5).map((client: any) => (
                  <div
                    key={client.id}
                    className={`flex items-center justify-between p-4 rounded-lg border ${
                      client.status === 'completed'
                        ? 'bg-green-50 border-green-200'
                        : client.status === 'in_progress'
                        ? 'bg-yellow-50 border-yellow-200'
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          client.status === 'completed'
                            ? 'bg-green-500'
                            : client.status === 'in_progress'
                            ? 'bg-yellow-500'
                            : 'bg-honest-blue'
                        }`}
                      >
                        <i
                          className={`${
                            client.status === 'completed'
                              ? 'fas fa-check'
                              : client.status === 'in_progress'
                              ? 'fas fa-spinner'
                              : 'fas fa-clock'
                          } text-white`}
                        ></i>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">{client.customer.name}</p>
                        <p className="text-sm text-gray-600">{client.customer.address}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge className={getStatusColor(client.status)}>
                        {getStatusLabel(client.status)}
                      </Badge>
                      {client.saleValue && (
                        <p className="text-sm text-gray-600 mt-1">
                          {formatCurrency(parseFloat(client.saleValue))}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center py-8">
                  Nenhum cliente agendado para hoje
                </p>
              )}
              
              <Button variant="ghost" className="w-full text-honest-blue hover:bg-blue-50">
                Ver todos os clientes do dia
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader className="border-b border-gray-200">
            <CardTitle className="text-lg font-semibold text-gray-800">
              Clientes Atrasados
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-4">
              {overdueClients && overdueClients.length > 0 ? (
                overdueClients.slice(0, 5).map((client: any) => (
                  <div key={client.id} className="flex items-start space-x-3">
                    <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <i className="fas fa-exclamation text-red-600 text-sm"></i>
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-gray-800">
                        <span className="font-medium">{client.customer?.name || 'Cliente não encontrado'}</span>
                      </p>
                      <p className="text-xs text-gray-600">
                        Agendado para {new Date(client.scheduledDate).toLocaleDateString('pt-BR')}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center py-8">
                  Nenhum cliente atrasado
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
