import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { 
  TrendingUp, 
  Navigation, 
  CheckCircle, 
  Calendar,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Users
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export default function AdminRouteMetrics() {
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());

  // Buscar métricas do dashboard admin
  const { data: dashboardMetrics, isLoading } = useQuery({
    queryKey: ['/api/route-metrics/admin-dashboard', currentYear, currentMonth],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/route-metrics/admin-dashboard/${currentYear}/${currentMonth}`);
      return response;
    }
  });

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(1)}km`;
  };

  const handlePreviousMonth = () => {
    if (currentMonth === 1) {
      setCurrentMonth(12);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 12) {
      setCurrentMonth(1);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!dashboardMetrics) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-gray-500">Sem dados disponíveis</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header com seletor de mês */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
          <Navigation className="mr-2 h-6 w-6" />
          Métricas de Rotas
        </h2>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={handlePreviousMonth} data-testid="button-previous-month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium min-w-[150px] text-center">
            {monthNames[currentMonth - 1]} {currentYear}
          </span>
          <Button variant="outline" size="sm" onClick={handleNextMonth} data-testid="button-next-month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Resumo Geral */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Taxa Média de Conclusão</p>
                <p className="text-3xl font-bold text-honest-blue">
                  {dashboardMetrics.totals?.avgCompletionRate?.toFixed(1) || 0}%
                </p>
              </div>
              <CheckCircle className="h-10 w-10 text-green-600" />
            </div>
            <Progress value={dashboardMetrics.totals?.avgCompletionRate || 0} className="mt-3" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Distância Total</p>
                <p className="text-3xl font-bold text-honest-blue">
                  {formatDistance(dashboardMetrics.totals?.totalDistance || 0)}
                </p>
              </div>
              <Navigation className="h-10 w-10 text-purple-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total de Dias Úteis</p>
                <p className="text-3xl font-bold text-honest-blue">
                  {dashboardMetrics.totals?.totalWorkDays || 0}
                </p>
              </div>
              <Calendar className="h-10 w-10 text-blue-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Métricas por Vendedor */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Users className="mr-2 h-5 w-5" />
            Desempenho por Vendedor
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dashboardMetrics.sellers && dashboardMetrics.sellers.length > 0 ? (
            <div className="space-y-4">
              {dashboardMetrics.sellers.map((seller: any) => (
                <div 
                  key={seller.sellerId}
                  className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-gray-800 dark:text-white">
                        {seller.sellerName || 'Vendedor'}
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {seller.totalWorkDays} dias trabalhados
                      </p>
                    </div>
                    <Badge variant={seller.avgCompletionRate >= 80 ? "default" : "outline"}>
                      {seller.avgCompletionRate.toFixed(1)}% conclusão
                    </Badge>
                  </div>
                  
                  <Progress value={seller.avgCompletionRate} className="mb-3 h-2" />
                  
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">Dist. Total</p>
                      <p className="font-semibold text-gray-800 dark:text-white">
                        {formatDistance(seller.totalActualDistance)}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">Média Diária</p>
                      <p className="font-semibold text-gray-800 dark:text-white">
                        {formatDistance(seller.avgDailyDistance)}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">Estimada</p>
                      <p className="font-semibold text-gray-800 dark:text-white">
                        {formatDistance(seller.totalEstimatedDistance)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-500 py-8">
              Nenhum vendedor com dados de rotas neste período
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
