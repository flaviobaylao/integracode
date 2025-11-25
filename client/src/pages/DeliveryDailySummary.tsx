import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar, Truck, CheckCircle2, AlertCircle, Clock, XCircle } from "lucide-react";
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface DeliveryStop {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  stopOrder: number;
  status: 'pendente' | 'efetuada' | 'em_pausa' | 'devolvida';
  checkInTime?: string;
  checkOutTime?: string;
  isPriority: boolean;
}

interface RouteWithDeliveries {
  id: string;
  routeName: string;
  routeDate: string;
  driverName: string;
  vehicleType: string;
  totalDeliveries: number;
  status: string;
  stops: DeliveryStop[];
}

export default function DeliveryDailySummary() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');

  // Buscar entregadores
  const { data: drivers = [] } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers'],
    staleTime: 5 * 60 * 1000,
  });

  // Buscar rotas do dia
  const { data: routes = [], isLoading } = useQuery<RouteWithDeliveries[]>({
    queryKey: ['/api/delivery-routes', selectedDate, selectedDriver],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedDate) params.append('routeDate', selectedDate);
      if (selectedDriver !== 'all') params.append('driverId', selectedDriver);
      params.append('savedOnly', 'true');

      const url = `/api/delivery-routes?${params.toString()}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch routes');
      return res.json();
    },
    enabled: !!selectedDate,
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'efetuada':
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case 'em_pausa':
        return <Clock className="h-5 w-5 text-yellow-600" />;
      case 'devolvida':
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <AlertCircle className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { bg: string; text: string; label: string }> = {
      pendente: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'PENDENTE' },
      efetuada: { bg: 'bg-green-100', text: 'text-green-800', label: 'EFETUADA' },
      em_pausa: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'EM PAUSA' },
      devolvida: { bg: 'bg-red-100', text: 'text-red-800', label: 'DEVOLVIDA' },
    };
    const config = variants[status] || { bg: 'bg-gray-100', text: 'text-gray-800', label: status.toUpperCase() };
    return <Badge className={`${config.bg} ${config.text}`}>{config.label}</Badge>;
  };

  const calculateDuration = (checkIn?: string, checkOut?: string) => {
    if (!checkIn || !checkOut) return null;
    const duration = new Date(checkOut).getTime() - new Date(checkIn).getTime();
    return Math.round(duration / 60000);
  };

  const groupedByDriver = routes.reduce((acc, route) => {
    if (!acc[route.driverName]) {
      acc[route.driverName] = { driverName: route.driverName, routes: [], totalDeliveries: 0 };
    }
    acc[route.driverName].routes.push(route);
    acc[route.driverName].totalDeliveries += route.totalDeliveries;
    return acc;
  }, {} as Record<string, any>);

  const activeDrivers = drivers.filter(d => d.isActive);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Resumo de Entregas do Dia</h1>
        <p className="text-muted-foreground">Acompanhe todas as entregas e seus status</p>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Calendar className="h-5 w-5 mr-2" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Data</Label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                data-testid="input-delivery-summary-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Entregador</Label>
              <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                <SelectTrigger data-testid="select-delivery-driver">
                  <SelectValue placeholder="Selecione um entregador" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os entregadores</SelectItem>
                  {activeDrivers.map((driver) => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Carregando entregas...
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && routes.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhuma entrega encontrada para a data selecionada
          </CardContent>
        </Card>
      )}

      {/* Entregas por Entregador */}
      {!isLoading && routes.length > 0 && (
        <div className="space-y-6">
          {Object.entries(groupedByDriver).map(([driverName, { routes: driverRoutes, totalDeliveries }]: [string, any]) => (
            <div key={driverName} className="space-y-3">
              <div className="flex items-center gap-2 px-2">
                <Truck className="h-5 w-5 text-blue-600" />
                <h2 className="text-xl font-bold">{driverName}</h2>
                <Badge variant="secondary">{totalDeliveries} entregas</Badge>
              </div>

              {driverRoutes.map((route: any) => (
                <Card key={route.id}>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center justify-between">
                      <span>{route.routeName}</span>
                      <Badge variant="outline">{route.status === 'em_andamento' ? '🚗 Em Andamento' : route.status === 'concluida' ? '✅ Concluída' : '⏱️ Planejada'}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {route.stops.map((stop: any) => {
                        const duration = calculateDuration(stop.checkInTime, stop.checkOutTime);
                        return (
                          <div
                            key={stop.id}
                            className={`p-4 border rounded-lg flex items-start gap-4 ${
                              stop.status === 'devolvida'
                                ? 'bg-red-50 border-red-200'
                                : stop.status === 'efetuada'
                                ? 'bg-green-50 border-green-200'
                                : ''
                            }`}
                            data-testid={`delivery-summary-${stop.id}`}
                          >
                            <div className="flex-shrink-0 mt-1">
                              {getStatusIcon(stop.status)}
                            </div>
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center justify-between">
                                <div className="font-semibold flex items-center gap-2">
                                  <span className="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full">
                                    #{stop.stopOrder}
                                  </span>
                                  {stop.customerName}
                                </div>
                                {getStatusBadge(stop.status)}
                              </div>
                              <p className="text-sm text-muted-foreground">{stop.customerAddress}</p>
                              {stop.checkInTime && (
                                <div className="text-xs text-muted-foreground">
                                  <strong>Check-in:</strong> {new Date(stop.checkInTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              )}
                              {stop.checkOutTime && (
                                <div className="text-xs text-muted-foreground">
                                  <strong>Check-out:</strong> {new Date(stop.checkOutTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              )}
                              {duration && (
                                <div className="text-xs text-muted-foreground">
                                  <strong>Duração:</strong> {duration} min
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
