import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  TrendingUp, 
  Navigation, 
  CheckCircle, 
  Calendar,
  MapPin,
  BarChart3
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface RouteMetricsCardProps {
  sellerId: string;
  year?: number;
  month?: number;
  showDetailed?: boolean;
}

export default function RouteMetricsCard({ 
  sellerId, 
  year = new Date().getFullYear(), 
  month = new Date().getMonth() + 1,
  showDetailed = false 
}: RouteMetricsCardProps) {
  
  // Buscar métricas mensais
  const { data: monthlyMetrics, isLoading: isLoadingMonthly } = useQuery({
    queryKey: ['/api/route-metrics/monthly', sellerId, year, month],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/route-metrics/monthly/${sellerId}/${year}/${month}`);
      return response;
    },
    enabled: !!sellerId
  });

  // Buscar rotas recentes
  const { data: recentRoutes, isLoading: isLoadingRecent } = useQuery({
    queryKey: ['/api/route-metrics/recent', sellerId],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/route-metrics/recent/${sellerId}?limit=7`);
      return response;
    },
    enabled: !!sellerId && showDetailed
  });

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(1)}km`;
  };

  if (isLoadingMonthly) {
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

  if (!monthlyMetrics) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-gray-500">Sem dados de rotas para este período</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Resumo Mensal */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Taxa de Conclusão</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {monthlyMetrics.avgCompletionRate.toFixed(1)}%
                </p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
            <Progress value={monthlyMetrics.avgCompletionRate} className="mt-3" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Dias Trabalhados</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {monthlyMetrics.totalWorkDays}
                </p>
              </div>
              <Calendar className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Distância Total</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {formatDistance(monthlyMetrics.totalActualDistance)}
                </p>
              </div>
              <Navigation className="h-8 w-8 text-purple-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Média Diária</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {formatDistance(monthlyMetrics.avgDailyDistance)}
                </p>
              </div>
              <MapPin className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Rotas Recentes */}
      {showDetailed && recentRoutes && recentRoutes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <BarChart3 className="mr-2 h-5 w-5" />
              Últimas Rotas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentRoutes.map((route: any, index: number) => (
                <div 
                  key={index}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div className="flex-1">
                    <div className="flex items-center space-x-3">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {new Date(route.date).toLocaleDateString('pt-BR')}
                      </span>
                      <Badge variant={route.completionRate === 100 ? "default" : "outline"}>
                        {route.completedVisits}/{route.totalVisits} visitas
                      </Badge>
                    </div>
                    <div className="mt-1">
                      <Progress value={route.completionRate} className="h-2" />
                    </div>
                  </div>
                  <div className="ml-4 text-right">
                    <p className="text-sm font-semibold text-honest-blue">
                      {route.completionRate.toFixed(0)}%
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatDistance(route.actualDistance)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
