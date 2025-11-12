import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { SalesGoal, User } from "@shared/schema";

interface SalesGoalsDashboardProps {
  user: User;
}

interface SalesMetrics {
  positivationRate: number;
  totalRevenue: number;
  revenueProjection: number;
  overdueDebtRatio: number;
  serviceRate: number;
  workingDaysInMonth: number;
  workingDaysElapsed: number;
}

export default function SalesGoalsDashboard({ user }: SalesGoalsDashboardProps) {
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedSeller, setSelectedSeller] = useState<string>(user.role === 'vendedor' ? user.id : 'all');

  // Buscar vendedores (apenas para admins/coordinators/administrative)
  const { data: sellers = [] } = useQuery({
    queryKey: ['/api/users'],
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role)
  });

  // Buscar metas
  const { data: salesGoals = [] } = useQuery({
    queryKey: ['/api/sales-goals', selectedMonth, selectedYear, selectedSeller],
    queryFn: () => {
      const params = new URLSearchParams({
        month: selectedMonth.toString(),
        year: selectedYear.toString(),
        ...(selectedSeller !== 'all' && { sellerId: selectedSeller })
      });
      return fetch(`/api/sales-goals?${params}`)
        .then(res => res.json());
    }
  });

  // Buscar métricas atuais - individuais para cada vendedor quando "all" selecionado
  const { data: salesMetrics = null, isLoading: isLoadingMetrics, error: metricsError } = useQuery({
    queryKey: ['/api/sales-metrics', selectedMonth, selectedYear, selectedSeller, salesGoals],
    queryFn: async () => {
      if (selectedSeller === 'all') {
        // Quando "Todos os vendedores", buscar métricas individuais de cada vendedor com meta
        const sellerIds = salesGoals.map((g: SalesGoal) => g.sellerId).filter(Boolean);
        
        if (sellerIds.length === 0) {
          return {};
        }
        
        const params = new URLSearchParams({
          month: selectedMonth.toString(),
          year: selectedYear.toString(),
          sellerIds: sellerIds.join(',')
        });
        
        console.log('🔍 Buscando métricas múltiplas:', { month: selectedMonth, year: selectedYear, sellerIds });
        
        const res = await fetch(`/api/sales-metrics/multiple?${params}`, {
          credentials: 'include'
        });
        
        if (!res.ok) {
          throw new Error(`Erro ${res.status}: ${res.statusText}`);
        }
        
        const data = await res.json();
        console.log('📊 Métricas múltiplas recebidas:', JSON.stringify(data, null, 2));
        return data; // Retorna um objeto { sellerId: metrics, ... }
      } else {
        // Quando vendedor específico, buscar métricas apenas dele
        const params = new URLSearchParams({
          month: selectedMonth.toString(),
          year: selectedYear.toString(),
          sellerId: selectedSeller
        });
        
        console.log('🔍 Buscando métrica individual:', { month: selectedMonth, year: selectedYear, sellerId: selectedSeller });
        
        const res = await fetch(`/api/sales-metrics?${params}`, {
          credentials: 'include'
        });
        
        if (!res.ok) {
          throw new Error(`Erro ${res.status}: ${res.statusText}`);
        }
        
        const data = await res.json();
        console.log('📊 Métrica individual recebida:', JSON.stringify(data, null, 2));
        return data;
      }
    },
    enabled: salesGoals.length > 0,
    staleTime: 0,
    gcTime: 0,
    retry: false
  });

  const months = [
    { value: 1, label: 'Janeiro' },
    { value: 2, label: 'Fevereiro' },
    { value: 3, label: 'Março' },
    { value: 4, label: 'Abril' },
    { value: 5, label: 'Maio' },
    { value: 6, label: 'Junho' },
    { value: 7, label: 'Julho' },
    { value: 8, label: 'Agosto' },
    { value: 9, label: 'Setembro' },
    { value: 10, label: 'Outubro' },
    { value: 11, label: 'Novembro' },
    { value: 12, label: 'Dezembro' }
  ];

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

  // Função para calcular cor do progresso baseado na performance
  const getProgressColor = (current: number, target: number) => {
    const percentage = (current / target) * 100;
    if (percentage >= 100) return 'bg-green-500';
    if (percentage >= 80) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  // Função para calcular status de desempenho
  const getPerformanceStatus = (current: number, target: number) => {
    const percentage = (current / target) * 100;
    if (percentage >= 100) return { status: 'excellent', label: 'Excelente', color: 'bg-green-100 text-green-800' };
    if (percentage >= 90) return { status: 'good', label: 'Bom', color: 'bg-blue-100 text-blue-800' };
    if (percentage >= 70) return { status: 'average', label: 'Regular', color: 'bg-yellow-100 text-yellow-800' };
    return { status: 'poor', label: 'Abaixo', color: 'bg-red-100 text-red-800' };
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const canViewAllSellers = ['admin', 'coordinator', 'administrative'].includes(user.role);

  const { toast } = useToast();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefreshData = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['/api/sales-metrics'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/sales-goals'] });
      
      toast({
        title: "Dados atualizados",
        description: "Os resultados de cumprimento de metas foram atualizados com os dados mais recentes do sistema.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Erro ao atualizar",
        description: "Não foi possível atualizar os dados. Tente novamente.",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const GoalCard = ({ goal, metrics }: { goal: SalesGoal; metrics: SalesMetrics | null }) => {
    const seller = sellers.find((s: User) => s.id === goal.sellerId);
    
    return (
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex justify-between items-center">
            <span>
              {seller ? `${seller.firstName} ${seller.lastName}` : 'Vendedor não encontrado'}
            </span>
            <Badge variant="outline">
              {months.find(m => m.value === goal.month)?.label}/{goal.year}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Positivação */}
            {goal.positivationGoal && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-medium text-gray-600">Positivação</h4>
                  <Badge className={getPerformanceStatus(
                    metrics?.positivationRate || 0,
                    parseFloat(goal.positivationGoal.toString())
                  ).color}>
                    {getPerformanceStatus(
                      metrics?.positivationRate || 0,
                      parseFloat(goal.positivationGoal.toString())
                    ).label}
                  </Badge>
                </div>
                <div className="text-2xl font-bold">
                  {metrics?.positivationRate?.toFixed(1) || '0.0'}%
                </div>
                <div className="text-sm text-gray-500">
                  Meta: {goal.positivationGoal}%
                </div>
                <Progress
                  value={Math.min(100, (metrics?.positivationRate || 0) / parseFloat(goal.positivationGoal.toString()) * 100)}
                  className="h-2"
                />
              </div>
            )}

            {/* Faturamento */}
            {goal.revenueGoal && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-medium text-gray-600">Faturamento</h4>
                  <Badge className={getPerformanceStatus(
                    metrics?.revenueProjection || 0,
                    parseFloat(goal.revenueGoal.toString())
                  ).color}>
                    {getPerformanceStatus(
                      metrics?.revenueProjection || 0,
                      parseFloat(goal.revenueGoal.toString())
                    ).label}
                  </Badge>
                </div>
                <div className="text-2xl font-bold">
                  {formatCurrency(metrics?.revenueProjection || 0)}
                </div>
                <div className="text-sm text-gray-500">
                  Meta: {formatCurrency(parseFloat(goal.revenueGoal.toString()))}
                </div>
                <div className="text-xs text-gray-400">
                  Atual: {formatCurrency(metrics?.totalRevenue || 0)}
                </div>
                <Progress
                  value={Math.min(100, (metrics?.revenueProjection || 0) / parseFloat(goal.revenueGoal.toString()) * 100)}
                  className="h-2"
                />
              </div>
            )}

            {/* Débito Vencido */}
            {goal.overdueDebtGoal && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-medium text-gray-600">Débito Vencido</h4>
                  <Badge className={getPerformanceStatus(
                    parseFloat(goal.overdueDebtGoal.toString()) - (metrics?.overdueDebtRatio || 0), // Inverted logic - lower is better
                    parseFloat(goal.overdueDebtGoal.toString())
                  ).color}>
                    {(metrics?.overdueDebtRatio || 0) <= parseFloat(goal.overdueDebtGoal.toString()) ? 'Dentro' : 'Acima'}
                  </Badge>
                </div>
                <div className="text-2xl font-bold">
                  {metrics?.overdueDebtRatio?.toFixed(1) || '0.0'}%
                </div>
                <div className="text-sm text-gray-500">
                  Meta: máx {goal.overdueDebtGoal}%
                </div>
                <Progress
                  value={Math.min(100, (metrics?.overdueDebtRatio || 0) / parseFloat(goal.overdueDebtGoal.toString()) * 100)}
                  className={`h-2 ${(metrics?.overdueDebtRatio || 0) > parseFloat(goal.overdueDebtGoal.toString()) ? '[&>div]:bg-red-500' : '[&>div]:bg-green-500'}`}
                />
              </div>
            )}

            {/* Atendimento */}
            {goal.serviceGoal && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-medium text-gray-600">Atendimento</h4>
                  <Badge className={getPerformanceStatus(
                    metrics?.serviceRate || 0,
                    parseFloat(goal.serviceGoal.toString())
                  ).color}>
                    {getPerformanceStatus(
                      metrics?.serviceRate || 0,
                      parseFloat(goal.serviceGoal.toString())
                    ).label}
                  </Badge>
                </div>
                <div className="text-2xl font-bold">
                  {metrics?.serviceRate?.toFixed(1) || '0.0'}%
                </div>
                <div className="text-sm text-gray-500">
                  Meta: {goal.serviceGoal}%
                </div>
                <Progress
                  value={Math.min(100, (metrics?.serviceRate || 0) / parseFloat(goal.serviceGoal.toString()) * 100)}
                  className="h-2"
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">
          {user.role === 'vendedor' ? 'Meu Desempenho' : 'Dashboard de Metas'}
        </h2>
        <div className="flex space-x-2">
          <Button
            onClick={handleRefreshData}
            disabled={isRefreshing}
            variant="outline"
            size="sm"
            className="gap-2"
            data-testid="button-refresh-goals"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Atualizar Dados
          </Button>
          <Select value={selectedMonth.toString()} onValueChange={(value) => setSelectedMonth(parseInt(value))}>
            <SelectTrigger className="w-32" data-testid="select-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((month) => (
                <SelectItem key={month.value} value={month.value.toString()}>
                  {month.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedYear.toString()} onValueChange={(value) => setSelectedYear(parseInt(value))}>
            <SelectTrigger className="w-24" data-testid="select-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((year) => (
                <SelectItem key={year} value={year.toString()}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canViewAllSellers && (
            <Select value={selectedSeller} onValueChange={setSelectedSeller}>
              <SelectTrigger className="w-48" data-testid="select-seller">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os vendedores</SelectItem>
                {sellers.filter((seller: User) => seller.role === 'vendedor').map((seller: User) => (
                  <SelectItem key={seller.id} value={seller.id}>
                    {seller.firstName} {seller.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {salesGoals.length > 0 ? (
        <div className="space-y-4">
          {selectedSeller === 'all' ? (
            // Visualização agregada para todos os vendedores - pegar métricas individuais
            salesGoals.map((goal: SalesGoal) => {
              const sellerMetrics = salesMetrics?.[goal.sellerId] || null;
              return <GoalCard key={goal.id} goal={goal} metrics={sellerMetrics} />;
            })
          ) : (
            // Visualização para vendedor específico - métricas diretas
            salesGoals.map((goal: SalesGoal) => (
              <GoalCard key={goal.id} goal={goal} metrics={salesMetrics} />
            ))
          )}
        </div>
      ) : (
        <Card className="p-8 text-center">
          <div className="text-gray-500">
            <i className="fas fa-bullseye text-4xl mb-4 block"></i>
            <h3 className="text-lg font-semibold mb-2">Nenhuma meta definida</h3>
            <p className="text-sm">
              {user.role === 'vendedor' 
                ? 'Suas metas para este período ainda não foram definidas.'
                : 'Nenhuma meta foi definida para este período.'}
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}