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
import { 
  Truck, 
  MapPin,
  Clock,
  Calendar,
  Filter,
  Package,
  Image as ImageIcon,
  CheckCircle2,
  Circle
} from "lucide-react";
import { format } from 'date-fns';

interface RouteStop {
  id: string;
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: string;
  customerLongitude: string;
  stopOrder: number;
  estimatedArrival: string;
  estimatedDeparture: string;
  estimatedServiceTime: number;
  distanceFromPrevious: string;
  isPriority: boolean;
  status: string;
  checkInTime?: string;
  checkOutTime?: string;
  photos?: string[];
  completedAt?: string;
}

interface DeliveryRoute {
  id: string;
  routeName: string;
  routeDate: string;
  driverId: string;
  driverName: string;
  vehicleType: string;
  totalDistance: string;
  totalDuration: number;
  totalDeliveries: number;
  status: string;
  startTime?: string;
  endTime?: string;
  stops: RouteStop[];
  createdAt: string;
}

export default function RoutesSummary() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);

  // Buscar entregadores
  const { data: drivers = [] } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers'],
  });

  // Buscar rotas com filtros
  const { data: routes = [], isLoading } = useQuery<DeliveryRoute[]>({
    queryKey: ['/api/delivery-routes', { routeDate: selectedDate, driverId: selectedDriver !== 'all' ? selectedDriver : undefined }],
    enabled: !!selectedDate,
  });

  const activeDrivers = drivers.filter(d => d.isActive);

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string }> = {
      planejada: { variant: 'secondary', label: 'Planejada' },
      em_andamento: { variant: 'default', label: 'Em Andamento' },
      concluida: { variant: 'outline', label: 'Concluída' },
      cancelada: { variant: 'destructive', label: 'Cancelada' },
    };

    const config = variants[status] || { variant: 'secondary', label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getStopStatusIcon = (stop: RouteStop) => {
    if (stop.completedAt || stop.checkOutTime) {
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    }
    if (stop.checkInTime) {
      return <Clock className="h-5 w-5 text-blue-600 animate-pulse" />;
    }
    return <Circle className="h-5 w-5 text-gray-400" />;
  };

  const calculateDeliveryDuration = (checkIn?: string, checkOut?: string) => {
    if (!checkIn || !checkOut) return null;
    const duration = new Date(checkOut).getTime() - new Date(checkIn).getTime();
    return Math.round(duration / 60000); // minutos
  };

  const selectedRouteData = routes.find(r => r.id === selectedRoute);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Resumo das Rotas</h1>
        <p className="text-muted-foreground">Visualize e acompanhe as rotas de entrega</p>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Filter className="h-5 w-5 mr-2" />
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
                data-testid="input-route-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Entregador</Label>
              <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                <SelectTrigger data-testid="select-driver">
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

      {/* Lista de Rotas */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            Carregando rotas...
          </CardContent>
        </Card>
      ) : routes.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            Nenhuma rota encontrada para os filtros selecionados.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {routes.map((route) => (
            <Card 
              key={route.id} 
              className={`cursor-pointer transition-all ${selectedRoute === route.id ? 'ring-2 ring-blue-500' : 'hover:shadow-md'}`}
              onClick={() => setSelectedRoute(selectedRoute === route.id ? null : route.id)}
              data-testid={`route-card-${route.id}`}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center text-base">
                    <Truck className="h-5 w-5 mr-2" />
                    {route.routeName}
                  </span>
                  {getStatusBadge(route.status)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center text-muted-foreground">
                    <Calendar className="h-4 w-4 mr-2" />
                    {format(new Date(route.routeDate), 'dd/MM/yyyy')}
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <Truck className="h-4 w-4 mr-2" />
                    {route.driverName} • {route.vehicleType === 'caminhao' ? '🚛 Caminhão' : route.vehicleType === 'carro' ? '🚗 Carro' : '🏍️ Moto'}
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <Package className="h-4 w-4 mr-2" />
                    {route.totalDeliveries} paradas • {parseFloat(route.totalDistance).toFixed(1)} km • ~{Math.round(route.totalDuration)} min
                  </div>
                  {route.startTime && (
                    <div className="flex items-center text-muted-foreground">
                      <Clock className="h-4 w-4 mr-2" />
                      Iniciada: {new Date(route.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Detalhes da Rota Selecionada */}
      {selectedRouteData && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Detalhes da Rota: {selectedRouteData.routeName}</span>
              <Button variant="outline" size="sm" onClick={() => setSelectedRoute(null)}>
                Fechar
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-4 border-b">
                <div>
                  <div className="text-sm text-muted-foreground">Paradas</div>
                  <div className="text-2xl font-bold">{selectedRouteData.totalDeliveries}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Distância</div>
                  <div className="text-2xl font-bold">{parseFloat(selectedRouteData.totalDistance).toFixed(1)} km</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Duração Est.</div>
                  <div className="text-2xl font-bold">{Math.round(selectedRouteData.totalDuration)} min</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Status</div>
                  <div className="pt-1">{getStatusBadge(selectedRouteData.status)}</div>
                </div>
              </div>

              {/* Lista de Paradas */}
              <div className="space-y-3">
                <h3 className="font-semibold">Paradas da Rota</h3>
                {selectedRouteData.stops.map((stop) => {
                  const deliveryDuration = calculateDeliveryDuration(stop.checkInTime, stop.checkOutTime);
                  
                  return (
                    <Card key={stop.id} className={stop.isPriority ? 'border-red-300 bg-red-50' : ''}>
                      <CardContent className="pt-6">
                        <div className="flex items-start space-x-4">
                          <div className="flex-shrink-0">
                            {getStopStatusIcon(stop)}
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-semibold flex items-center">
                                  <span className="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full mr-2">
                                    #{stop.stopOrder}
                                  </span>
                                  {stop.customerName}
                                  {stop.isPriority && (
                                    <Badge variant="destructive" className="ml-2 text-xs">
                                      URGENTE
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-sm text-muted-foreground flex items-center mt-1">
                                  <MapPin className="h-3 w-3 mr-1" />
                                  {stop.customerAddress}
                                </div>
                              </div>
                            </div>

                            {/* Informações de Tempo */}
                            <div className="grid grid-cols-2 gap-4 text-sm border-t pt-2">
                              <div>
                                <div className="text-muted-foreground">ETA</div>
                                <div className="font-medium">
                                  {new Date(stop.estimatedArrival).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              </div>
                              {stop.checkInTime && (
                                <div>
                                  <div className="text-muted-foreground">Check-in</div>
                                  <div className="font-medium text-blue-600">
                                    {new Date(stop.checkInTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </div>
                              )}
                              {stop.checkOutTime && (
                                <div>
                                  <div className="text-muted-foreground">Check-out</div>
                                  <div className="font-medium text-green-600">
                                    {new Date(stop.checkOutTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </div>
                              )}
                              {deliveryDuration && (
                                <div>
                                  <div className="text-muted-foreground">Tempo de Entrega</div>
                                  <div className="font-medium">{deliveryDuration} min</div>
                                </div>
                              )}
                            </div>

                            {/* Fotos */}
                            {stop.photos && stop.photos.length > 0 && (
                              <div className="border-t pt-2">
                                <div className="text-sm text-muted-foreground mb-2 flex items-center">
                                  <ImageIcon className="h-4 w-4 mr-1" />
                                  Fotos da Entrega ({stop.photos.length})
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  {stop.photos.map((photo, idx) => (
                                    <img
                                      key={idx}
                                      src={photo}
                                      alt={`Foto ${idx + 1}`}
                                      className="w-full h-24 object-cover rounded border"
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
