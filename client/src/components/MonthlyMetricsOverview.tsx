import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, MapPin, Calendar } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { nowBrazil } from '@/lib/brazilTimezone';

interface SellerMonthlyMetrics {
  sellerId: string;
  sellerName: string;
  totalWorkDays: number;
  avgCompletionRate: number;
  totalEstimatedDistance: number;
  totalActualDistance: number;
  avgDailyDistance: number;
}

interface AdminDashboardMetrics {
  sellers: SellerMonthlyMetrics[];
  totals: {
    totalDistance: number;
    avgCompletionRate: number;
    totalWorkDays: number;
  };
}

export function MonthlyMetricsOverview() {
  const now = nowBrazil();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data: monthData, isLoading } = useQuery<AdminDashboardMetrics>({
    queryKey: ['/api/route-metrics/admin-dashboard', year, month],
  });

  const handlePrevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
  };

  const handleNextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
  };

  const monthName = new Date(year, month - 1).toLocaleDateString('pt-BR', { 
    month: 'long', 
    year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  });

  const formatDistance = (meters: number) => {
    const km = meters / 1000;
    return km.toFixed(2);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!monthData) {
    return null;
  }

  const { totals } = monthData;

  return (
    <div className="space-y-6">
      {/* Navegação de mês */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold capitalize">{monthName}</h3>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handlePrevMonth}
            data-testid="button-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleNextMonth}
            data-testid="button-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Cards de resumo mensal */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-month-completion">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Conclusão Média do Mês
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-month-avg-completion">
              {totals.avgCompletionRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              Todos os vendedores
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-month-distance">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Distância Total do Mês
            </CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-month-total-distance">
              {formatDistance(totals.totalDistance)} km
            </div>
            <p className="text-xs text-muted-foreground">
              Percorridos no mês
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-month-workdays">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total de Dias Trabalhados
            </CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-month-workdays">
              {totals.totalWorkDays}
            </div>
            <p className="text-xs text-muted-foreground">
              Dias com rotas executadas
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
