import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Truck, 
  Package, 
  CheckCircle2, 
  XCircle, 
  Clock,
  MapPin,
  BarChart3,
  Users,
  TrendingUp,
  AlertTriangle
} from "lucide-react";

interface DeliveryStats {
  total: number;
  pending: number;
  in_transit: number;
  delivered: number;
  failed: number;
  returned: number;
}

interface DeliveryMetrics {
  todayDeliveries: number;
  successRate: number;
  averageDeliveryTime: string;
  activeDrivers: number;
}

const deliveryStatusConfig = {
  pending: { icon: Package, label: "Aguardando", color: "bg-gray-500", badgeColor: "secondary" },
  in_transit: { icon: Truck, label: "Em trânsito", color: "bg-blue-500", badgeColor: "default" },
  delivered: { icon: CheckCircle2, label: "Entregue", color: "bg-green-500", badgeColor: "default" },
  failed: { icon: XCircle, label: "Falharam", color: "bg-red-500", badgeColor: "destructive" },
  returned: { icon: AlertTriangle, label: "Devolvidas", color: "bg-orange-500", badgeColor: "secondary" }
};

export default function DeliveryDashboard() {
  const [selectedPeriod, setSelectedPeriod] = useState('today');

  // Query para estatísticas de entregas
  const { data: deliveryStats, isLoading: isLoadingStats } = useQuery<DeliveryStats>({
    queryKey: ['/api/deliveries/stats', selectedPeriod],
    refetchInterval: 30000, // Atualiza a cada 30 segundos
  });

  // Query para métricas principais
  const { data: deliveryMetrics, isLoading: isLoadingMetrics } = useQuery<DeliveryMetrics>({
    queryKey: ['/api/deliveries/metrics', selectedPeriod],
    refetchInterval: 30000,
  });

  // Query para entregas pendentes
  const { data: pendingDeliveries, isLoading: isLoadingPending } = useQuery<any[]>({
    queryKey: ['/api/deliveries/pending'],
    refetchInterval: 15000, // Atualiza a cada 15 segundos
  });

  // Query para motoristas ativos
  const { data: activeDrivers, isLoading: isLoadingDrivers } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers/active'],
    refetchInterval: 60000, // Atualiza a cada 1 minuto
  });

  const formatPercentage = (value: number) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  return (
    <div className="space-y-6" data-testid="delivery-dashboard">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Dashboard de Entregas</h1>
          <p className="text-muted-foreground">
            Acompanhe todas as entregas em tempo real
          </p>
        </div>
        
        <div className="flex items-center space-x-2">
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="border rounded-md px-3 py-2"
            data-testid="period-selector"
          >
            <option value="today">Hoje</option>
            <option value="week">Esta Semana</option>
            <option value="month">Este Mês</option>
          </select>
          <Button variant="outline" size="sm" data-testid="button-refresh">
            <BarChart3 className="h-4 w-4 mr-2" />
            Relatórios
          </Button>
        </div>
      </div>

      {/* Métricas Principais */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card data-testid="metric-today-deliveries">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Entregas Hoje</CardTitle>
            <Truck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingMetrics ? "-" : deliveryMetrics?.todayDeliveries || 0}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="metric-success-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Taxa de Sucesso</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {isLoadingMetrics ? "-" : formatPercentage(deliveryMetrics?.successRate || 0)}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="metric-average-time">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tempo Médio</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingMetrics ? "-" : deliveryMetrics?.averageDeliveryTime || "N/A"}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="metric-active-drivers">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Motoristas Ativos</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingDrivers ? "-" : activeDrivers?.length || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Estatísticas por Status */}
      <Card data-testid="delivery-stats-card">
        <CardHeader>
          <CardTitle>Status das Entregas</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingStats ? (
            <div className="text-center py-8">Carregando estatísticas...</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {Object.entries(deliveryStatusConfig).map(([status, config]) => {
                const count = deliveryStats?.[status as keyof DeliveryStats] || 0;
                const IconComponent = config.icon;
                
                return (
                  <div key={status} className="text-center space-y-2" data-testid={`status-${status}`}>
                    <div className={`w-12 h-12 rounded-full ${config.color} flex items-center justify-center mx-auto`}>
                      <IconComponent className="h-6 w-6 text-white" />
                    </div>
                    <div className="text-2xl font-bold">{count}</div>
                    <div className="text-sm text-muted-foreground">{config.label}</div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Grid com Entregas Pendentes e Motoristas Ativos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Entregas Pendentes */}
        <Card data-testid="pending-deliveries-card">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Package className="h-5 w-5" />
              <span>Entregas Pendentes</span>
              <Badge variant="secondary" data-testid="pending-count">
                {pendingDeliveries?.length || 0}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingPending ? (
              <div className="text-center py-4">Carregando...</div>
            ) : pendingDeliveries?.length > 0 ? (
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {pendingDeliveries.slice(0, 10).map((delivery: any) => (
                  <div key={delivery.id} className="flex items-center justify-between p-3 border rounded-lg" data-testid={`pending-delivery-${delivery.id}`}>
                    <div className="flex-1">
                      <div className="font-medium">{delivery.customerName}</div>
                      <div className="text-sm text-muted-foreground flex items-center">
                        <MapPin className="h-3 w-3 mr-1" />
                        {delivery.customerAddress}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Card: {delivery.salesCardId}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge variant="secondary">{delivery.deliveryStatus}</Badge>
                      <div className="text-xs text-muted-foreground mt-1">
                        {delivery.scheduledDate && new Date(delivery.scheduledDate).toLocaleDateString('pt-BR')}
                      </div>
                    </div>
                  </div>
                ))}
                {pendingDeliveries.length > 10 && (
                  <div className="text-center pt-2">
                    <Button variant="outline" size="sm" data-testid="view-all-pending">
                      Ver todas ({pendingDeliveries.length - 10} restantes)
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Nenhuma entrega pendente
              </div>
            )}
          </CardContent>
        </Card>

        {/* Motoristas Ativos */}
        <Card data-testid="active-drivers-card">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Users className="h-5 w-5" />
              <span>Motoristas Ativos</span>
              <Badge variant="default" data-testid="drivers-count">
                {activeDrivers?.length || 0}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingDrivers ? (
              <div className="text-center py-4">Carregando...</div>
            ) : activeDrivers?.length > 0 ? (
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {activeDrivers.map((driver: any) => (
                  <div key={driver.id} className="flex items-center justify-between p-3 border rounded-lg" data-testid={`active-driver-${driver.id}`}>
                    <div className="flex-1">
                      <div className="font-medium">{driver.name}</div>
                      <div className="text-sm text-muted-foreground">{driver.phone}</div>
                      <div className="text-xs text-muted-foreground">
                        {driver.vehicleType} - {driver.licensePlate}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge variant="default">Ativo</Badge>
                      <div className="text-xs text-muted-foreground mt-1">
                        {driver.currentLocation || "Localização não disponível"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Nenhum motorista ativo
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card data-testid="quick-actions-card">
        <CardHeader>
          <CardTitle>Ações Rápidas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button variant="outline" className="h-20 flex-col" data-testid="action-new-delivery">
              <Package className="h-6 w-6 mb-2" />
              Nova Entrega
            </Button>
            <Button variant="outline" className="h-20 flex-col" data-testid="action-assign-driver">
              <Users className="h-6 w-6 mb-2" />
              Atribuir Motorista
            </Button>
            <Button variant="outline" className="h-20 flex-col" data-testid="action-track-delivery">
              <MapPin className="h-6 w-6 mb-2" />
              Rastrear Entrega
            </Button>
            <Button variant="outline" className="h-20 flex-col" data-testid="action-generate-report">
              <BarChart3 className="h-6 w-6 mb-2" />
              Relatório
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}