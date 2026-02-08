import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { MapPin, TrendingUp, Calendar } from 'lucide-react';
import { formatDateBR } from '@/lib/brazilTimezone';

interface DailyRouteOverview {
  sellerId: string;
  sellerName: string;
  routeId: string | null;
  totalVisits: number;
  completedVisits: number;
  completionRate: number;
  estimatedDistance: number;
  actualDistance: number;
  routeStatus: string;
}

interface TodayMetrics {
  date: string;
  sellers: DailyRouteOverview[];
  totals: {
    totalVisits: number;
    totalCompleted: number;
    avgCompletionRate: number;
    totalEstimatedDistance: number;
    totalActualDistance: number;
  };
}

export function DailyRoutesOverview() {
  const { data: todayData, isLoading } = useQuery<TodayMetrics>({
    queryKey: ['/api/route-metrics/today'],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!todayData) {
    return null;
  }

  const { sellers, totals } = todayData;
  
  // Formatar distâncias: < 1km mostra em metros, >= 1km mostra em km
  const formatDistance = (meters: number) => {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(2)}km`;
  };

  return (
    <div className="space-y-6">
      {/* Cards de resumo do dia */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-today-completion">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Conclusão Média do Dia
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-today-avg-completion">
              {totals.avgCompletionRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.totalCompleted} de {totals.totalVisits} visitas
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-today-distance">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Distância Total do Dia
            </CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-today-total-distance">
              {formatDistance(totals.totalActualDistance)}
            </div>
            <p className="text-xs text-muted-foreground">
              Estimado: {formatDistance(totals.totalEstimatedDistance)}
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-today-sellers">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Vendedores em Rota
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-today-active-sellers">
              {sellers.filter(s => s.routeId !== null).length}
            </div>
            <p className="text-xs text-muted-foreground">
              de {sellers.length} vendedores
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabela de vendedores */}
      <Card data-testid="card-sellers-routes">
        <CardHeader>
          <CardTitle>Rotas do Dia - {formatDateBR(new Date())}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {sellers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Nenhum vendedor cadastrado
              </p>
            ) : (
              sellers.map((seller) => (
                <div 
                  key={seller.sellerId} 
                  className="border rounded-lg p-4"
                  data-testid={`seller-route-${seller.sellerId}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="font-medium" data-testid={`text-seller-name-${seller.sellerId}`}>
                        {seller.sellerName}
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        {seller.routeId ? (
                          <>
                            {seller.completedVisits} de {seller.totalVisits} visitas •{' '}
                            {formatDistance(seller.actualDistance)}
                          </>
                        ) : (
                          'Sem rota para hoje'
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <div 
                        className="text-2xl font-bold"
                        data-testid={`text-completion-${seller.sellerId}`}
                      >
                        {seller.completionRate.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                  
                  {seller.routeId && (
                    <Progress 
                      value={seller.completionRate} 
                      className="h-2"
                      data-testid={`progress-${seller.sellerId}`}
                    />
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
