import { useState } from "react";
import { useQuery, useMutation, queryClient, apiRequest } from "@/lib/queryClient";
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
  Circle,
  XCircle,
  Trash2,
  Plus
} from "lucide-react";
import { format } from 'date-fns';
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

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
  const [showAddOrders, setShowAddOrders] = useState(false);
  const [removePedidoIds, setRemovePedidoIds] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  // Buscar entregadores
  const { data: drivers = [] } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers'],
    staleTime: 5 * 60 * 1000, // Cache por 5 minutos
  });

  // Buscar rotas com filtros - apenas rotas salvas
  const { data: routes = [], isLoading } = useQuery<DeliveryRoute[]>({
    queryKey: ['/api/delivery-routes', { 
      routeDate: selectedDate, 
      driverId: selectedDriver !== 'all' ? selectedDriver : undefined,
      savedOnly: 'true' // Mostrar apenas rotas que foram salvas na Gestão de Entregas
    }],
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

  // Query para pedidos aguardando rota
  const { data: orders = [] } = useQuery<any[]>({
    queryKey: ['/api/deliveries'],
    queryFn: () => apiRequest('GET', '/api/deliveries'),
  });

  // Mutation para adicionar parada à rota
  const addStopMutation = useMutation({
    mutationFn: async (data: { routeId: string; billingId: string }) => {
      return await apiRequest('POST', `/api/delivery-routes/${data.routeId}/add-stop`, { billingId: data.billingId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setShowAddOrders(false);
      setRemovePedidoIds(new Set());
      toast({
        title: "Pedido adicionado com sucesso!",
        description: "O pedido foi adicionado à rota.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao adicionar pedido",
        description: error.message || "Erro desconhecido",
        variant: "destructive",
      });
    },
  });

  // Mutation para excluir parada individual
  const deleteStopMutation = useMutation({
    mutationFn: async (stopId: string) => {
      return await apiRequest('DELETE', `/api/delivery-routes/stops/${stopId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Parada excluída",
        description: "A entrega foi removida da rota e retornará para Gestão de Rotas.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir parada",
        description: error.message || "Não foi possível excluir a parada.",
        variant: "destructive",
      });
    }
  });

  // Mutation para excluir rota completa
  const deleteRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('DELETE', `/api/delivery-routes/${routeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setSelectedRoute(null); // Fechar detalhes da rota excluída
      toast({
        title: "Rota excluída",
        description: "Todas as entregas foram removidas e retornarão para Gestão de Rotas.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir rota",
        description: error.message || "Não foi possível excluir a rota.",
        variant: "destructive",
      });
    }
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

  const getDeliveryStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string; className: string }> = {
      pendente: { variant: 'secondary', label: 'PENDENTE', className: 'bg-gray-200 text-gray-700' },
      efetuada: { variant: 'default', label: 'EFETUADA', className: 'bg-green-500 text-white' },
      em_pausa: { variant: 'outline', label: 'EM PAUSA', className: 'bg-yellow-500 text-white' },
      devolvida: { variant: 'destructive', label: 'DEVOLVIDA', className: 'bg-red-500 text-white' },
    };

    const config = variants[status] || { variant: 'secondary', label: status.toUpperCase(), className: '' };
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getStopStatusIcon = (stop: RouteStop) => {
    if (stop.status === 'efetuada' || stop.completedAt || stop.checkOutTime) {
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    }
    if (stop.status === 'em_pausa' || stop.checkInTime) {
      return <Clock className="h-5 w-5 text-blue-600 animate-pulse" />;
    }
    if (stop.status === 'devolvida') {
      return <XCircle className="h-5 w-5 text-red-600" />;
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
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddOrders(true)}
                  data-testid={`button-add-orders-route-${selectedRoute}`}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  ➕ Adicionar Pedidos
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button 
                      variant="destructive" 
                      size="sm"
                      data-testid="button-delete-route"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Excluir Rota
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Excluir Rota Completa?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Tem certeza que deseja excluir esta rota? Todas as {selectedRouteData.totalDeliveries} entregas 
                        serão removidas e retornarão para a aba "Gestão de Rotas" para que possam ser incluídas em novas rotas.
                        Esta ação não pode ser desfeita.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteRouteMutation.mutate(selectedRouteData.id)}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        Confirmar Exclusão
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button variant="outline" size="sm" onClick={() => setSelectedRoute(null)}>
                  Fechar
                </Button>
              </div>
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
                {selectedRouteData.stops && selectedRouteData.stops.length > 0 ? (
                  selectedRouteData.stops.map((stop) => {
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
                              <div className="flex-1">
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
                              <div className="flex items-center gap-2">
                                {getDeliveryStatusBadge(stop.status)}
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button 
                                      variant="ghost" 
                                      size="sm"
                                      className="h-8 w-8 p-0"
                                      data-testid={`button-delete-stop-${stop.id}`}
                                    >
                                      <Trash2 className="h-4 w-4 text-red-500" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Excluir Entrega da Rota?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Tem certeza que deseja remover a entrega de <strong>{stop.customerName}</strong> desta rota? 
                                        O pedido retornará para a aba "Gestão de Rotas" e poderá ser incluído em uma nova rota.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteStopMutation.mutate(stop.id);
                                        }}
                                        className="bg-red-600 hover:bg-red-700"
                                      >
                                        Confirmar Exclusão
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
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
                })
                ) : (
                  <div className="text-center text-muted-foreground py-8">
                    Nenhuma parada cadastrada para esta rota
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal para adicionar pedidos à rota */}
      <Dialog open={showAddOrders} onOpenChange={setShowAddOrders}>
        <DialogContent className="max-w-md" data-testid="dialog-add-orders-route">
          <DialogHeader>
            <DialogTitle>Adicionar Pedidos à Rota</DialogTitle>
            <DialogDescription>
              Selecione um pedido disponível para adicionar à rota
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {orders.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                Não há pedidos disponíveis para adicionar
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {orders.map((order) => (
                  <div
                    key={order.id}
                    className="p-3 border border-gray-200 rounded-lg hover:bg-blue-50 cursor-pointer transition"
                    onClick={() => {
                      if (selectedRoute) {
                        addStopMutation.mutate({
                          routeId: selectedRoute,
                          billingId: order.id,
                        });
                      }
                    }}
                  >
                    <div className="font-medium text-sm">{order.customerName}</div>
                    <div className="text-xs text-muted-foreground mt-1">{order.customerAddress}</div>
                    <div className="text-xs text-blue-600 mt-2">
                      R$ {(Number(order.saleValue) || 0).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
