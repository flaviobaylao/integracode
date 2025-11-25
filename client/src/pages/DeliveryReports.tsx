import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  BarChart3, 
  TrendingUp,
  TrendingDown,
  Calendar,
  Download,
  Clock,
  CheckCircle2,
  XCircle,
  Package,
  Truck,
  AlertTriangle
} from "lucide-react";

interface DeliveryReport {
  period: string;
  totalDeliveries: number;
  delivered: number;
  failed: number;
  pending: number;
  in_transit: number;
  returned: number;
  successRate: number;
  averageDeliveryTime: string;
  topDrivers: Array<{
    driverId: string;
    driverName: string;
    deliveries: number;
    successRate: number;
  }>;
  dailyStats: Array<{
    date: string;
    deliveries: number;
    success: number;
    failed: number;
  }>;
}

const reportPeriods = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "week", label: "Esta Semana" },
  { value: "last_week", label: "Semana Passada" },
  { value: "month", label: "Este Mês" },
  { value: "last_month", label: "Mês Passado" },
  { value: "quarter", label: "Este Trimestre" },
  { value: "year", label: "Este Ano" },
  { value: "custom", label: "Período Personalizado" },
];

const statusMetrics = {
  delivered: { icon: CheckCircle2, label: "Entregues", color: "text-green-600" },
  failed: { icon: XCircle, label: "Falhas", color: "text-red-600" },
  pending: { icon: Package, label: "Pendentes", color: "text-gray-600" },
  in_transit: { icon: Truck, label: "Em Trânsito", color: "text-blue-600" },
  returned: { icon: AlertTriangle, label: "Devolvidas", color: "text-orange-600" },
};

export default function DeliveryReports() {
  const [selectedPeriod, setSelectedPeriod] = useState("month");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");

  // Query para dados do relatório
  const { data: reportData, isLoading: isLoadingReport } = useQuery<DeliveryReport>({
    queryKey: ['/api/deliveries/reports', selectedPeriod, customStartDate, customEndDate],
    enabled: selectedPeriod !== "custom" || Boolean(customStartDate && customEndDate),
  });

  // Query para comparação com período anterior
  const { data: comparisonData } = useQuery<DeliveryReport>({
    queryKey: ['/api/deliveries/reports/comparison', selectedPeriod],
    enabled: selectedPeriod !== "custom",
  });

  const formatPercentage = (value: number) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  const getChangeIcon = (current: number, previous: number) => {
    if (current > previous) return <TrendingUp className="h-4 w-4 text-green-600" />;
    if (current < previous) return <TrendingDown className="h-4 w-4 text-red-600" />;
    return null;
  };

  const getChangeColor = (current: number, previous: number) => {
    if (current > previous) return "text-green-600";
    if (current < previous) return "text-red-600";
    return "text-gray-600";
  };

  const handleExportReport = () => {
    // Implementar exportação de relatório
    console.log("Exportando relatório...");
  };

  return (
    <div className="space-y-6" data-testid="delivery-reports">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Relatórios de Entregas</h1>
          <p className="text-muted-foreground">
            Análise detalhada da performance das entregas
          </p>
        </div>
        <BackToDashboardButton />
        
        <Button onClick={handleExportReport} data-testid="button-export">
          <Download className="h-4 w-4 mr-2" />
          Exportar Relatório
        </Button>
      </div>

      {/* Period Selection */}
      <Card data-testid="period-selection-card">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Calendar className="h-5 w-5" />
            <span>Período do Relatório</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="period">Período</Label>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger data-testid="select-period">
                  <SelectValue placeholder="Selecionar período" />
                </SelectTrigger>
                <SelectContent>
                  {reportPeriods.map((period) => (
                    <SelectItem key={period.value} value={period.value}>
                      {period.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedPeriod === "custom" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="start-date">Data Inicial</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    data-testid="input-start-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end-date">Data Final</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    data-testid="input-end-date"
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Main Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card data-testid="metric-total-deliveries">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Entregas</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingReport ? "-" : reportData?.totalDeliveries || 0}
            </div>
            {comparisonData?.totalDeliveries && (
              <div className={`text-xs flex items-center space-x-1 ${getChangeColor(reportData?.totalDeliveries || 0, comparisonData.totalDeliveries)}`}>
                {getChangeIcon(reportData?.totalDeliveries || 0, comparisonData.totalDeliveries)}
                <span>
                  {((((reportData?.totalDeliveries || 0) - comparisonData.totalDeliveries) / comparisonData.totalDeliveries) * 100).toFixed(1)}% vs período anterior
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="metric-success-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Taxa de Sucesso</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {isLoadingReport ? "-" : formatPercentage(reportData?.successRate || 0)}
            </div>
            {comparisonData?.successRate && (
              <div className={`text-xs flex items-center space-x-1 ${getChangeColor(reportData?.successRate || 0, comparisonData.successRate)}`}>
                {getChangeIcon(reportData?.successRate || 0, comparisonData.successRate)}
                <span>
                  {(((reportData?.successRate || 0) - comparisonData.successRate) * 100).toFixed(1)}pp vs período anterior
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="metric-average-time">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tempo Médio</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingReport ? "-" : reportData?.averageDeliveryTime || "N/A"}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="metric-failed-deliveries">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Entregas Falharam</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {isLoadingReport ? "-" : reportData?.failed || 0}
            </div>
            {comparisonData?.failed && (
              <div className={`text-xs flex items-center space-x-1 ${getChangeColor(comparisonData.failed, reportData?.failed || 0)}`}>
                {getChangeIcon(comparisonData.failed, reportData?.failed || 0)}
                <span>
                  {((((reportData?.failed || 0) - comparisonData.failed) / comparisonData.failed) * 100).toFixed(1)}% vs período anterior
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Status Breakdown */}
      <Card data-testid="status-breakdown-card">
        <CardHeader>
          <CardTitle>Distribuição por Status</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingReport ? (
            <div className="text-center py-8">Carregando dados...</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {Object.entries(statusMetrics).map(([status, config]) => {
                const count = reportData?.[status as keyof typeof reportData] as number || 0;
                const percentage = reportData?.totalDeliveries ? (count / reportData.totalDeliveries) * 100 : 0;
                const IconComponent = config.icon;
                
                return (
                  <div key={status} className="text-center space-y-2" data-testid={`status-breakdown-${status}`}>
                    <div className="flex items-center justify-center">
                      <IconComponent className={`h-8 w-8 ${config.color}`} />
                    </div>
                    <div className="space-y-1">
                      <div className={`text-2xl font-bold ${config.color}`}>{count}</div>
                      <div className="text-sm text-muted-foreground">{config.label}</div>
                      <div className="text-xs text-muted-foreground">{percentage.toFixed(1)}%</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Drivers */}
      <Card data-testid="top-drivers-card">
        <CardHeader>
          <CardTitle>Top Motoristas</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingReport ? (
            <div className="text-center py-8">Carregando dados...</div>
          ) : reportData?.topDrivers?.length > 0 ? (
            <div className="space-y-4">
              {reportData.topDrivers.map((driver, index) => (
                <div key={driver.driverId} className="flex items-center justify-between p-3 border rounded-lg" data-testid={`top-driver-${driver.driverId}`}>
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                      <span className="text-sm font-bold text-blue-600">#{index + 1}</span>
                    </div>
                    <div>
                      <div className="font-medium">{driver.driverName}</div>
                      <div className="text-sm text-muted-foreground">
                        {driver.deliveries} entregas
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge variant="default">
                      {formatPercentage(driver.successRate)} sucesso
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Nenhum dado de motorista disponível
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily Statistics */}
      <Card data-testid="daily-stats-card">
        <CardHeader>
          <CardTitle>Estatísticas Diárias</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingReport ? (
            <div className="text-center py-8">Carregando dados...</div>
          ) : reportData?.dailyStats?.length > 0 ? (
            <div className="space-y-2">
              <div className="grid grid-cols-4 gap-4 pb-2 border-b font-medium text-sm">
                <div>Data</div>
                <div className="text-center">Total</div>
                <div className="text-center">Sucesso</div>
                <div className="text-center">Falhas</div>
              </div>
              {reportData.dailyStats.map((day) => {
                const successRate = day.deliveries > 0 ? (day.success / day.deliveries) * 100 : 0;
                
                return (
                  <div key={day.date} className="grid grid-cols-4 gap-4 py-2 text-sm" data-testid={`daily-stat-${day.date}`}>
                    <div>{new Date(day.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</div>
                    <div className="text-center font-medium">{day.deliveries}</div>
                    <div className="text-center text-green-600">{day.success} ({successRate.toFixed(1)}%)</div>
                    <div className="text-center text-red-600">{day.failed}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Nenhum dado diário disponível
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}