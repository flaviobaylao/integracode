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
      </div>

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
            <div className="space-y-4 max-h-96 overflow-y-auto">
              {todayClients && todayClients.length > 0 ? (
                todayClients.map((client: any) => (
                  <div
                    key={client.id}
                    className={`flex items-center justify-between p-4 rounded-lg border ${
                      client.status === 'completed'
                        ? 'bg-green-50 border-green-200'
                        : client.status === 'no_sale'
                        ? 'bg-red-50 border-red-200'
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          client.status === 'completed'
                            ? 'bg-green-500'
                            : client.status === 'no_sale'
                            ? 'bg-red-500'
                            : 'bg-gray-400'
                        }`}
                      >
                        <i
                          className={`${
                            client.status === 'completed'
                              ? 'fas fa-check'
                              : client.status === 'no_sale'
                              ? 'fas fa-times'
                              : 'fas fa-clock'
                          } text-white`}
                        ></i>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">{client.customer?.fantasyName || client.customer?.name || 'Cliente'}</p>
                        <p className="text-sm text-gray-600">{client.customer?.address || '-'}</p>
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
