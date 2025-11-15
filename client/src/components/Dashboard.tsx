import { useQuery, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isUnauthorizedError } from "@/lib/authUtils";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { RefreshCw, RotateCcw } from "lucide-react";
import { getVendorColor, getVendorInitials } from "@/lib/vendorColors";
import { apiRequest } from "@/lib/queryClient";
import RouteMetricsCard from "./RouteMetricsCard";
import { DailyRoutesOverview } from "./DailyRoutesOverview";
import { MonthlyMetricsOverview } from "./MonthlyMetricsOverview";
import { SyncStatusDisplay } from "./SyncStatusDisplay";

interface DashboardStats {
  todaySales: string;
  todayClients: string;
  overdueClients?: string;
  conversionRate: string;
}

interface TodayClient {
  id: string;
  customerId: string;
  customerName: string;
  sellerId: string;
  sellerFirstName?: string;
  sellerLastName?: string;
  visitDate: string;
  status: string;
}

interface OverdueClient {
  id: string;
  customerId: string;
  customerName: string;
  sellerId: string;
  sellerFirstName?: string;
  sellerLastName?: string;
  visitDate: string;
  status: string;
}

interface SellerStats {
  sellerId: string;
  sellerFirstName: string;
  sellerLastName: string;
  totalVisits: number;
  completedVisits: number;
  totalRevenue: number;
}

interface VisitPerformance {
  overview: {
    totalVisits: number;
    completed: number;
    pending: number;
    overdue: number;
    completionRate: number;
    avgTimePerVisit: number;
    averageVisitTime?: number;
    completedVisits?: number;
    inProgressVisits?: number;
    pendingVisits?: number;
    totalSales?: number;
    averageSaleValue?: number;
    conversionRate?: number;
  };
  performanceBySeller: Array<{
    sellerId: string;
    sellerFirstName: string;
    sellerLastName: string;
    totalVisits: number;
    completedVisits: number;
    averageTime: number;
  }>;
}

export default function Dashboard() {
  const { toast } = useToast();
  const { user, isAuthenticated, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const [isRefreshingSellers, setIsRefreshingSellers] = useState(false);
  const [isSyncingComplete, setIsSyncingComplete] = useState(false);

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

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ['/api/dashboard/stats'],
    retry: false,
  });

  const { data: todayClients, isLoading: todayClientsLoading } = useQuery<TodayClient[]>({
    queryKey: ['/api/dashboard/today-clients'],
    retry: false,
  });

  const { data: overdueClients, isLoading: overdueClientsLoading } = useQuery<OverdueClient[]>({
    queryKey: ['/api/dashboard/overdue-clients'],
    retry: false,
  });

  // Query para estatísticas dos vendedores (apenas para admin e coordinator)
  const [sellersStatsKey, setSellersStatsKey] = useState(Date.now());
  const { data: sellersStats, isLoading: sellersStatsLoading } = useQuery<SellerStats[]>({
    queryKey: ['/api/dashboard/sellers-stats', sellersStatsKey],
    enabled: user && ['admin', 'coordinator'].includes(user.role),
    retry: false,
  });

  // Query para métricas de performance de visitas
  const { data: visitPerformance, isLoading: visitPerformanceLoading } = useQuery<VisitPerformance>({
    queryKey: ['/api/dashboard/visit-performance'],
    retry: false,
  });

  if (statsLoading || todayClientsLoading || overdueClientsLoading || visitPerformanceLoading) {
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
      // Limpar cache anterior
      await queryClient.removeQueries({
        queryKey: ['/api/dashboard/sellers-stats']
      });
      
      // Forçar nova busca com timestamp único
      const newTimestamp = Date.now();
      setSellersStatsKey(newTimestamp);
      
      toast({
        title: "Dados atualizados",
        description: "Performance dos vendedores atualizada com sucesso!",
      });
    } catch (error) {
      console.error('Erro ao atualizar dados dos vendedores:', error);
      toast({
        title: "Erro",
        description: "Falha ao atualizar dados dos vendedores",
        variant: "destructive",
      });
    } finally {
      setIsRefreshingSellers(false);
    }
  };

  // Função para sincronização completa (Clientes + Faturamentos + Débitos)
  const handleCompleteSync = async () => {
    setIsSyncingComplete(true);
    try {
      toast({
        title: "Sincronização Iniciada",
        description: "Processando em segundo plano. Aguarde...",
        variant: "default",
      });

      // Iniciar sincronização (retorna imediatamente)
      const result = await apiRequest('POST', '/api/omie/sync-complete');

      if (result.success) {
        // Invalidar o cache do sync status para forçar atualização
        queryClient.invalidateQueries({ queryKey: ['/api/sync-status'] });

        let pollingTimeoutId: NodeJS.Timeout | null = null;

        // Fazer polling a cada 5 segundos para verificar o status
        const checkSyncStatus = async () => {
          try {
            const statuses = await apiRequest('GET', '/api/sync-status');
            const syncStatus = statuses?.find((s: any) => s.syncType === 'omie_complete');
            
            if (syncStatus) {
              if (syncStatus.status === 'success') {
                setIsSyncingComplete(false);
                toast({
                  title: "Sincronização Concluída",
                  description: `✅ ${syncStatus.recordsProcessed || 0} registros processados com sucesso!`,
                  variant: "default",
                });
                
                // Invalidar cache dos dados para forçar atualização
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['/api/dashboard/stats'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/dashboard/today-clients'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/dashboard/overdue-clients'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/customers'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/billings'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/omie/overdue-debts'] }),
                  queryClient.invalidateQueries({ queryKey: ['/api/sync-status'] })
                ]);
              } else if (syncStatus.status === 'error') {
                setIsSyncingComplete(false);
                toast({
                  title: "Erro na Sincronização",
                  description: syncStatus.message || "Falha na sincronização",
                  variant: "destructive",
                });
              } else if (syncStatus.status === 'in_progress') {
                // Continuar verificando
                pollingTimeoutId = setTimeout(checkSyncStatus, 5000);
              }
            } else {
              // Se não há status ainda, continuar verificando
              pollingTimeoutId = setTimeout(checkSyncStatus, 5000);
            }
          } catch (error: any) {
            // Ignorar erros de abort silenciosamente
            if (error.name === 'AbortError' || error.message?.includes('abort')) {
              console.log('Polling cancelado');
              return;
            }
            console.error('Erro ao verificar status da sincronização:', error);
            setIsSyncingComplete(false);
          }
        };

        // Iniciar polling após 5 segundos
        pollingTimeoutId = setTimeout(checkSyncStatus, 5000);

        // Cleanup: cancelar polling quando componente desmontar
        return () => {
          if (pollingTimeoutId) {
            clearTimeout(pollingTimeoutId);
          }
        };
      } else {
        throw new Error(result.message || 'Erro desconhecido');
      }
      
    } catch (error: any) {
      // Ignorar erros de abort
      if (error.name === 'AbortError' || error.message?.includes('abort')) {
        return;
      }
      console.error('Erro na sincronização completa:', error);
      setIsSyncingComplete(false);
      toast({
        title: "Erro na Sincronização",
        description: error.message || "Falha ao iniciar sincronização",
        variant: "destructive",
      });
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
      {/* Ações Administrativas */}
      {user && ['admin', 'coordinator'].includes(user.role) && (
        <Card>
          <CardHeader className="border-b border-gray-200">
            <CardTitle className="text-lg font-semibold text-gray-800">
              Ações de Sincronização
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex flex-col gap-4">
              <div className="flex gap-4 items-center">
                <Button
                  onClick={handleCompleteSync}
                  disabled={isSyncingComplete}
                  variant="default"
                  className="flex items-center gap-2 bg-honest-blue hover:bg-honest-blue/90"
                  data-testid="button-sync-complete"
                >
                  <RotateCcw className={`h-4 w-4 ${isSyncingComplete ? 'animate-spin' : ''}`} />
                  {isSyncingComplete ? 'Sincronizando...' : 'Sincronizar Tudo'}
                </Button>
                <div className="text-sm text-gray-600 flex items-center">
                  Sincroniza clientes, faturamentos e débitos vencidos simultaneamente
                </div>
              </div>
              <SyncStatusDisplay syncType="omie_complete" compact={true} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Vendas Hoje</p>
                <p className="text-2xl font-bold text-gray-800">
                  {formatCurrency(parseFloat(stats?.todaySales || '0'))}
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
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold text-xs ${getVendorColor(seller.sellerId)}`}>
                              {getVendorInitials(seller.sellerName)}
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
                        <p className="font-medium text-gray-800">{client.customer.fantasyName || client.customer.name}</p>
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

      {/* Performance de Visitas */}
      {visitPerformance && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-800">Performance de Atendimento</h2>
            <p className="text-sm text-gray-600">Últimos 30 dias</p>
          </div>
          
          {/* Métricas Overview */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card data-testid="card-total-visits">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Total de Visitas</p>
                    <p className="text-2xl font-bold text-gray-800" data-testid="metric-total-visits">
                      {visitPerformance?.overview?.totalVisits || 0}
                    </p>
                  </div>
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                    <i className="fas fa-calendar text-blue-600"></i>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-completion-rate">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Taxa de Atendimento</p>
                    <p className="text-2xl font-bold text-green-600" data-testid="metric-completion-rate">
                      {visitPerformance?.overview?.completionRate?.toFixed(1) || '0.0'}%
                    </p>
                  </div>
                  <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                    <i className="fas fa-check-circle text-green-600"></i>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-average-time">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Tempo Médio</p>
                    <p className="text-2xl font-bold text-purple-600" data-testid="metric-average-time">
                      {visitPerformance?.overview?.averageVisitTime || 0} min
                    </p>
                  </div>
                  <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center">
                    <i className="fas fa-clock text-purple-600"></i>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-conversion-rate">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Taxa de Positivação</p>
                    <p className="text-2xl font-bold text-orange-600" data-testid="metric-conversion-rate">
                      {visitPerformance?.overview?.conversionRate?.toFixed(1) || '0.0'}%
                    </p>
                  </div>
                  <div className="w-8 h-8 bg-orange-100 rounded-full flex items-center justify-center">
                    <i className="fas fa-trophy text-orange-600"></i>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Breakdown de Status das Visitas */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card data-testid="card-visit-status">
              <CardHeader className="border-b border-gray-200">
                <CardTitle className="text-lg font-semibold text-gray-800">
                  Status das Visitas
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                      <span className="text-sm text-gray-600">Concluídas</span>
                    </div>
                    <span className="text-sm font-medium text-gray-800" data-testid="status-completed">
                      {visitPerformance?.overview?.completedVisits || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
                      <span className="text-sm text-gray-600">Em Atendimento</span>
                    </div>
                    <span className="text-sm font-medium text-gray-800" data-testid="status-in-progress">
                      {visitPerformance?.overview?.inProgressVisits || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                      <span className="text-sm text-gray-600">Pendentes</span>
                    </div>
                    <span className="text-sm font-medium text-gray-800" data-testid="status-pending">
                      {visitPerformance?.overview?.pendingVisits || 0}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-sales-metrics">
              <CardHeader className="border-b border-gray-200">
                <CardTitle className="text-lg font-semibold text-gray-800">
                  Métricas de Vendas
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Total de Vendas</span>
                    <span className="text-sm font-medium text-gray-800" data-testid="metric-total-sales">
                      {visitPerformance?.overview?.totalSales || 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Valor Médio por Venda</span>
                    <span className="text-sm font-medium text-gray-800" data-testid="metric-average-sale">
                      {formatCurrency(visitPerformance?.overview?.averageSaleValue || 0)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Taxa de Conversão</span>
                    <span className="text-sm font-medium text-green-600" data-testid="metric-conversion-detailed">
                      {visitPerformance?.overview?.conversionRate?.toFixed(1) || '0.0'}%
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Performance por Vendedor (apenas para admins/coordenadores) */}
          {user && ['admin', 'coordinator'].includes(user.role) && visitPerformance?.performanceBySeller && visitPerformance.performanceBySeller.length > 0 && (
            <Card data-testid="card-seller-performance">
              <CardHeader className="border-b border-gray-200">
                <CardTitle className="text-lg font-semibold text-gray-800">
                  Performance por Vendedor
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {visitPerformance.performanceBySeller.map((seller: any, index: number) => (
                    <div key={seller.sellerId || index} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg" data-testid={`seller-performance-${seller.sellerId || index}`}>
                      <div className="flex items-center space-x-3">
                        <div 
                          className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm ${getVendorColor(seller.sellerId)}`}
                        >
                          {getVendorInitials(`${seller.sellerFirstName} ${seller.sellerLastName}`)}
                        </div>
                        <div>
                          <p className="font-medium text-gray-800">
                            {seller.sellerFirstName} {seller.sellerLastName}
                          </p>
                        </div>
                      </div>
                      <div className="flex space-x-6">
                        <div className="text-center">
                          <p className="text-xs text-gray-500">Visitas</p>
                          <p className="text-sm font-medium text-gray-800" data-testid={`seller-visits-${seller.sellerId || index}`}>{seller.totalVisits || 0}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">Concluídas</p>
                          <p className="text-sm font-medium text-green-600" data-testid={`seller-completed-${seller.sellerId || index}`}>{seller.completedVisits || 0}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">Taxa</p>
                          <p className="text-sm font-medium text-blue-600" data-testid={`seller-rate-${seller.sellerId || index}`}>
                            {seller.totalVisits > 0 ? ((seller.completedVisits / seller.totalVisits) * 100).toFixed(1) : '0.0'}%
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">Tempo Médio</p>
                          <p className="text-sm font-medium text-purple-600" data-testid={`seller-time-${seller.sellerId || index}`}>
                            {seller.averageTime ? Math.round(seller.averageTime) : 0} min
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Métricas de Rotas - Admin */}
      {user && ['admin', 'coordinator', 'administrative'].includes(user.role) && (
        <div className="space-y-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-6">
              Rotas do Dia
            </h2>
            <DailyRoutesOverview />
          </div>
          
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-6">
              Resumo Mensal
            </h2>
            <MonthlyMetricsOverview />
          </div>
        </div>
      )}

      {/* Métricas de Rotas para Vendedores */}
      {user && user.role === 'vendedor' && (
        <div>
          <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-4">
            Minhas Métricas de Rotas
          </h2>
          <RouteMetricsCard sellerId={user.id} showDetailed={true} />
        </div>
      )}
    </div>
  );
}
