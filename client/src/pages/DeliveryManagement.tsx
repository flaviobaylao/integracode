import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { 
  Truck, 
  Package, 
  MapPin,
  Search,
  Filter,
  RotateCcw,
  Zap,
  Plus,
  Trash2,
  Calendar,
  Clock,
  Settings,
  RefreshCw
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeliveryOrder {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: string;
  customerLongitude: string;
  customerWeekdays: string[] | null;
  averageDeliveryTime: number;
  exclusiveVehicle: boolean;
  vehicleTypes: string[];
  isUrgent: boolean;
  saleValue: number;
  products: any;
  scheduledDate: string;
  completedDate: string;
  paymentMethod: string;
  operationType: string;
}

interface VehicleConfig {
  type: 'caminhao' | 'carro' | 'moto';
  driverId?: string;
  driverName?: string;
  startLatitude: number;
  startLongitude: number;
  startAddress: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  capacity?: number;
}

interface DeliveryDriver {
  id: string;
  name: string;
  phone: string;
  vehicleType: string;
  licensePlate: string;
  isActive: boolean;
}

interface RouteStop {
  salesCardId: string;
  customerName: string;
  customerAddress: string;
  estimatedArrival: string;
  estimatedDeparture: string;
  stopOrder: number;
  distanceFromPrevious: number;
}

interface VehicleRoute {
  vehicleType: string;
  driverId?: string;
  driverName?: string;
  startAddress: string;
  stops: RouteStop[];
  totalDistance: number;
  totalDuration: number;
}

interface RoutePlan {
  routes: VehicleRoute[];
  unassignedOrders: DeliveryOrder[];
  stats: {
    totalOrders: number;
    assignedOrders: number;
    unassignedOrders: number;
    totalDistance: number;
    totalVehicles: number;
  };
}

export default function DeliveryManagement() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  
  // Estados para configuração de veículos
  const [showVehicleConfig, setShowVehicleConfig] = useState(false);
  const [vehicles, setVehicles] = useState<VehicleConfig[]>([]);
  const [routeDate, setRouteDate] = useState(new Date().toISOString().split('T')[0]);
  
  // Estados para resultados da roteirização
  const [showResults, setShowResults] = useState(false);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);

  // Query para buscar pedidos aguardando rota
  const { data: orders, isLoading: isLoadingOrders } = useQuery<DeliveryOrder[]>({
    queryKey: ['/api/deliveries'],
    refetchInterval: 30000,
  });

  // Query para buscar motoristas ativos
  const { data: drivers = [], isLoading: isLoadingDrivers } = useQuery<DeliveryDriver[]>({
    queryKey: ['/api/delivery-drivers'],
  });

  // Mutation para planejar rotas
  const planRoutesMutation = useMutation({
    mutationFn: async (data: { orderIds: string[]; vehicles: VehicleConfig[]; routeDate: string }) => {
      return await apiRequest('POST', '/api/delivery-routes/plan', data);
    },
    onSuccess: (data) => {
      setRoutePlan(data);
      setShowVehicleConfig(false);
      setShowResults(true);
      toast({
        title: "Rotas planejadas com sucesso!",
        description: `${data.stats.assignedOrders} pedidos atribuídos em ${data.routes.length} rotas`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao planejar rotas",
        description: error.message || "Erro desconhecido",
        variant: "destructive",
      });
    },
  });

  // Mutation para marcar como urgente (billings)
  const toggleUrgentMutation = useMutation({
    mutationFn: async (data: { id: string; isUrgent: boolean }) => {
      return await apiRequest('PATCH', `/api/billings/${data.id}/urgent`, { isUrgent: data.isUrgent });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      toast({
        title: "Urgência atualizada",
        description: "A marcação de urgência foi atualizada com sucesso.",
      });
    },
  });

  // Funções de seleção
  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedOrders(new Set());
      setSelectAll(false);
    } else {
      const allIds = new Set(filteredOrders.map(o => o.id));
      setSelectedOrders(allIds);
      setSelectAll(true);
    }
  };

  const handleSelectOrder = (orderId: string) => {
    const newSelected = new Set(selectedOrders);
    if (newSelected.has(orderId)) {
      newSelected.delete(orderId);
    } else {
      newSelected.add(orderId);
    }
    setSelectedOrders(newSelected);
    setSelectAll(newSelected.size === filteredOrders.length && filteredOrders.length > 0);
  };

  const handleToggleUrgent = (orderId: string, currentUrgent: boolean) => {
    toggleUrgentMutation.mutate({
      id: orderId,
      isUrgent: !currentUrgent
    });
  };

  // Filtrar pedidos
  const filteredOrders = useMemo(() => {
    if (!orders) return [];

    return orders.filter(order => {
      const matchesSearch = 
        (order.customerName?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (order.customerAddress?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (order.id?.toLowerCase() || '').includes(searchTerm.toLowerCase());

      return matchesSearch;
    });
  }, [orders, searchTerm]);

  // Funções de veículos
  const addVehicle = () => {
    setVehicles(prev => [...prev, {
      type: 'moto',
      startLatitude: -16.719458733340122,
      startLongitude: -49.29937095026935,
      startAddress: 'HONEST GOIANIA',
      timeWindowStart: '08:00',
      timeWindowEnd: '18:00',
      capacity: undefined
    }]);
  };

  const removeVehicle = (index: number) => {
    setVehicles(vehicles.filter((_, i) => i !== index));
  };

  const updateVehicle = (index: number, field: keyof VehicleConfig, value: any) => {
    const updated = [...vehicles];
    updated[index] = { ...updated[index], [field]: value };
    setVehicles(updated);
  };

  const handlePlanRoutes = () => {
    if (selectedOrders.size === 0) {
      toast({
        title: "Nenhum pedido selecionado",
        description: "Selecione ao menos um pedido para planejar rotas",
        variant: "destructive",
      });
      return;
    }

    if (vehicles.length === 0) {
      toast({
        title: "Nenhum veículo configurado",
        description: "Configure ao menos um veículo",
        variant: "destructive",
      });
      return;
    }

    planRoutesMutation.mutate({
      orderIds: Array.from(selectedOrders),
      vehicles,
      routeDate
    });
  };

  return (
    <div className="space-y-6" data-testid="delivery-management">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Gestão de Entregas</h1>
          <p className="text-muted-foreground">
            Planeje rotas de entrega para múltiplos veículos
          </p>
        </div>
        <Button 
          onClick={() => setShowVehicleConfig(true)}
          data-testid="button-configure-routes"
          size="lg"
        >
          <Settings className="h-4 w-4 mr-2" />
          {selectedOrders.size > 0 
            ? `Configurar e Planejar Rotas (${selectedOrders.size})` 
            : 'Configurar Veículos'}
        </Button>
      </div>

      {/* Filters */}
      <Card data-testid="filters-card">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Filter className="h-5 w-5" />
            <span>Filtros e Seleção</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="search">Buscar</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Cliente, endereço, ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                  data-testid="input-search"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="route-date">Data da Rota</Label>
              <Input
                id="route-date"
                type="date"
                value={routeDate}
                onChange={(e) => setRouteDate(e.target.value)}
                data-testid="input-route-date"
              />
            </div>

            <div className="space-y-2">
              <Label>&nbsp;</Label>
              <div className="flex space-x-2">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setSearchTerm("");
                  }}
                  className="flex-1"
                  data-testid="button-clear-filters"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Limpar
                </Button>
                <Button 
                  variant="default" 
                  onClick={() => {
                    queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
                    toast({
                      title: "Pedidos atualizados",
                      description: "A lista de pedidos foi recarregada",
                    });
                  }}
                  className="flex-1"
                  data-testid="button-refresh-orders"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Recarregar Pedidos
                </Button>
              </div>
              <div className="flex items-center space-x-2 border rounded-md px-3 py-2">
                <Checkbox
                  id="select-all"
                  checked={selectAll}
                  onCheckedChange={handleSelectAll}
                  data-testid="checkbox-select-all"
                />
                <Label htmlFor="select-all" className="cursor-pointer text-sm">
                  Selecionar Todos
                </Label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Orders List */}
      <Card data-testid="orders-list-card">
        <CardHeader>
          <CardTitle>
            Pedidos Aguardando Rota ({filteredOrders.length})
            {selectedOrders.size > 0 && (
              <Badge variant="secondary" className="ml-2">{selectedOrders.size} selecionados</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingOrders ? (
            <div className="text-center py-8">Carregando pedidos...</div>
          ) : filteredOrders.length > 0 ? (
            <div className="space-y-3">
              {filteredOrders.map((order) => {
                const isSelected = selectedOrders.has(order.id);
                
                return (
                  <div 
                    key={order.id} 
                    className={`border rounded-lg p-4 hover:bg-gray-50 transition-colors ${isSelected ? 'bg-blue-50 border-blue-300' : ''}`}
                    data-testid={`order-item-${order.id}`}
                  >
                    <div className="flex items-start space-x-3">
                      <Checkbox
                        id={`select-${order.id}`}
                        checked={isSelected}
                        onCheckedChange={() => handleSelectOrder(order.id)}
                        data-testid={`checkbox-select-${order.id}`}
                        className="mt-1"
                      />
                      
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="font-medium">{order.customerName}</span>
                            {order.isUrgent && (
                              <Badge variant="destructive" className="bg-red-600">
                                <Zap className="h-3 w-3 mr-1" />
                                URGENTE
                              </Badge>
                            )}
                          </div>
                          <span className="text-sm text-gray-600">
                            R$ {(Number(order.saleValue) || 0).toFixed(2)}
                          </span>
                        </div>
                        
                        <div className="text-sm text-muted-foreground flex items-center">
                          <MapPin className="h-3 w-3 mr-1" />
                          {order.customerAddress}
                        </div>

                        <div className="flex items-center space-x-4 text-xs text-gray-600">
                          {order.customerLatitude !== '0' && order.customerLongitude !== '0' && (
                            <span className="flex items-center">
                              <MapPin className="h-3 w-3 mr-1" />
                              📍 Lat: {Number(order.customerLatitude).toFixed(6)}, Lng: {Number(order.customerLongitude).toFixed(6)}
                            </span>
                          )}
                          {order.customerWeekdays && order.customerWeekdays.length > 0 && (
                            <span className="flex items-center">
                              <Calendar className="h-3 w-3 mr-1" />
                              Dias: {order.customerWeekdays.join(', ')}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center space-x-4 text-xs text-gray-600">
                          <span className="flex items-center">
                            <Clock className="h-3 w-3 mr-1" />
                            ~{order.averageDeliveryTime} min
                          </span>
                          {order.exclusiveVehicle && order.vehicleTypes.length > 0 && (
                            <span className="flex items-center text-orange-600">
                              <Truck className="h-3 w-3 mr-1" />
                              Veículo: {order.vehicleTypes.map(v => 
                                v === 'caminhao' ? '🚛' : v === 'carro' ? '🚗' : '🏍️'
                              ).join(' ')}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center space-x-2 pt-1">
                          <Checkbox
                            id={`urgent-${order.id}`}
                            checked={order.isUrgent || false}
                            onCheckedChange={() => handleToggleUrgent(order.id, order.isUrgent || false)}
                            data-testid={`checkbox-urgent-${order.id}`}
                          />
                          <Label htmlFor={`urgent-${order.id}`} className="cursor-pointer text-xs font-medium flex items-center text-gray-600">
                            <Zap className="h-3 w-3 mr-1" />
                            Marcar como urgente
                          </Label>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-2 text-gray-300" />
              <p>Nenhum pedido aguardando rota</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vehicle Configuration Modal */}
      <Dialog open={showVehicleConfig} onOpenChange={setShowVehicleConfig}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto" data-testid="dialog-vehicle-config">
          <DialogHeader>
            <DialogTitle>Configurar Veículos de Entrega</DialogTitle>
            <DialogDescription>
              Configure os veículos disponíveis para as entregas
            </DialogDescription>
          </DialogHeader>
          
          {selectedOrders.size === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800" data-testid="alert-no-orders">
              <p className="font-medium">ℹ️ Nenhum pedido selecionado</p>
              <p className="text-xs mt-1">Você pode pré-configurar os veículos agora, mas precisará selecionar pedidos antes de gerar as rotas.</p>
            </div>
          )}
          
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <Button onClick={addVehicle} size="sm" data-testid="button-add-vehicle">
                <Plus className="h-4 w-4 mr-1" />
                Adicionar Veículo
              </Button>
            </div>

            {vehicles.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                <Truck className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                <p>Nenhum veículo configurado</p>
                <p className="text-xs">Clique em "Adicionar Veículo" para começar</p>
              </div>
            ) : (
              <div className="space-y-4">
                {vehicles.map((vehicle, idx) => (
                  <Card key={idx} data-testid={`vehicle-config-${idx}`}>
                    <CardContent className="pt-6">
                      <div className="flex justify-between items-start mb-4">
                        <h4 className="font-medium">Veículo {idx + 1}</h4>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeVehicle(idx)}
                          data-testid={`button-remove-vehicle-${idx}`}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Tipo de Veículo</Label>
                          <Select
                            value={vehicle.type}
                            onValueChange={(value: any) => updateVehicle(idx, 'type', value)}
                          >
                            <SelectTrigger data-testid={`select-vehicle-type-${idx}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="caminhao">🚛 Caminhão</SelectItem>
                              <SelectItem value="carro">🚗 Carro</SelectItem>
                              <SelectItem value="moto">🏍️ Moto</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Motorista</Label>
                          <Select
                            value={vehicle.driverId || ''}
                            onValueChange={(value: any) => {
                              const driver = drivers.find(d => d.id === value);
                              const updated = [...vehicles];
                              updated[idx] = { 
                                ...updated[idx], 
                                driverId: value,
                                driverName: driver?.name || undefined
                              };
                              setVehicles(updated);
                            }}
                            disabled={isLoadingDrivers || drivers.length === 0}
                          >
                            <SelectTrigger data-testid={`select-driver-${idx}`}>
                              <SelectValue placeholder={
                                isLoadingDrivers 
                                  ? "Carregando..." 
                                  : drivers.length === 0 
                                    ? "Nenhum motorista disponível" 
                                    : "Selecione o motorista"
                              } />
                            </SelectTrigger>
                            <SelectContent>
                              {drivers.map(driver => (
                                <SelectItem key={driver.id} value={driver.id}>
                                  {driver.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Capacidade (opcional)</Label>
                          <Input
                            type="number"
                            placeholder="Nº de entregas"
                            value={vehicle.capacity || ''}
                            onChange={(e) => updateVehicle(idx, 'capacity', e.target.value ? parseInt(e.target.value) : undefined)}
                            data-testid={`input-capacity-${idx}`}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Horário Início</Label>
                          <Input
                            type="time"
                            value={vehicle.timeWindowStart}
                            onChange={(e) => updateVehicle(idx, 'timeWindowStart', e.target.value)}
                            data-testid={`input-time-start-${idx}`}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Horário Fim</Label>
                          <Input
                            type="time"
                            value={vehicle.timeWindowEnd}
                            onChange={(e) => updateVehicle(idx, 'timeWindowEnd', e.target.value)}
                            data-testid={`input-time-end-${idx}`}
                          />
                        </div>

                        <div className="col-span-2 space-y-2">
                          <Label>Endereço de Partida</Label>
                          <Input
                            value={vehicle.startAddress}
                            onChange={(e) => updateVehicle(idx, 'startAddress', e.target.value)}
                            placeholder="Ex: São Paulo - Depósito Principal"
                            data-testid={`input-start-address-${idx}`}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Latitude</Label>
                          <Input
                            type="number"
                            step="0.000001"
                            value={vehicle.startLatitude}
                            onChange={(e) => updateVehicle(idx, 'startLatitude', parseFloat(e.target.value))}
                            data-testid={`input-lat-${idx}`}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Longitude</Label>
                          <Input
                            type="number"
                            step="0.000001"
                            value={vehicle.startLongitude}
                            onChange={(e) => updateVehicle(idx, 'startLongitude', parseFloat(e.target.value))}
                            data-testid={`input-lon-${idx}`}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="flex justify-end space-x-2 pt-4 border-t">
              <Button 
                variant="outline" 
                onClick={() => setShowVehicleConfig(false)}
                data-testid="button-cancel-config"
              >
                Cancelar
              </Button>
              <Button 
                onClick={handlePlanRoutes}
                disabled={vehicles.length === 0 || planRoutesMutation.isPending}
                data-testid="button-plan-routes"
              >
                {planRoutesMutation.isPending ? 'Planejando...' : 'Planejar Rotas'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Results Modal */}
      <Dialog open={showResults} onOpenChange={setShowResults}>
        <DialogContent className="max-w-6xl max-h-[80vh] overflow-y-auto" data-testid="dialog-route-results">
          <DialogHeader>
            <DialogTitle>Resultado do Planejamento de Rotas</DialogTitle>
            <DialogDescription>
              Visualize as rotas planejadas para cada veículo
            </DialogDescription>
          </DialogHeader>
          {routePlan && (
            <div className="space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{routePlan.stats.totalOrders}</div>
                    <div className="text-sm text-muted-foreground">Total de Pedidos</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-green-600">{routePlan.stats.assignedOrders}</div>
                    <div className="text-sm text-muted-foreground">Atribuídos</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-red-600">{routePlan.stats.unassignedOrders}</div>
                    <div className="text-sm text-muted-foreground">Não Atribuídos</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{routePlan.stats.totalDistance.toFixed(1)} km</div>
                    <div className="text-sm text-muted-foreground">Distância Total</div>
                  </CardContent>
                </Card>
              </div>

              {/* Routes */}
              <div className="space-y-4">
                <h3 className="font-semibold">Rotas Planejadas ({routePlan.routes.length})</h3>
                {routePlan.routes.map((route, idx) => (
                  <Card key={idx} data-testid={`route-result-${idx}`}>
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span className="flex items-center">
                          <Truck className="h-5 w-5 mr-2" />
                          Rota {idx + 1} - {route.vehicleType === 'caminhao' ? '🚛 Caminhão' : route.vehicleType === 'carro' ? '🚗 Carro' : '🏍️ Moto'}
                          {route.driverName && (
                            <Badge variant="secondary" className="ml-2">
                              {route.driverName}
                            </Badge>
                          )}
                        </span>
                        <div className="text-sm font-normal text-muted-foreground">
                          {route.stops.length} paradas • {route.totalDistance.toFixed(1)} km • ~{Math.round(route.totalDuration)} min
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-sm text-muted-foreground mb-3">
                        <MapPin className="h-4 w-4 inline mr-1" />
                        Partida: {route.startAddress}
                      </div>
                      <div className="space-y-2">
                        {route.stops.map((stop, stopIdx) => (
                          <div key={stopIdx} className="flex items-start space-x-3 py-2 border-l-2 border-blue-200 pl-4">
                            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white text-xs flex items-center justify-center">
                              {stop.stopOrder}
                            </div>
                            <div className="flex-1">
                              <div className="font-medium">{stop.customerName}</div>
                              <div className="text-sm text-muted-foreground">{stop.customerAddress}</div>
                              <div className="text-xs text-gray-600 mt-1">
                                <Clock className="h-3 w-3 inline mr-1" />
                                ETA: {new Date(stop.estimatedArrival).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                {stopIdx > 0 && ` • +${stop.distanceFromPrevious.toFixed(1)} km`}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Unassigned Orders */}
              {routePlan.unassignedOrders.length > 0 && (
                <div>
                  <h3 className="font-semibold text-red-600 mb-2">Pedidos Não Atribuídos ({routePlan.unassignedOrders.length})</h3>
                  <Card>
                    <CardContent className="pt-6">
                      <div className="space-y-2">
                        {routePlan.unassignedOrders.map((order) => (
                          <div key={order.id} className="text-sm border-l-2 border-red-300 pl-3 py-1">
                            {order.customerName} - {order.customerAddress}
                            {order.exclusiveVehicle && (
                              <Badge variant="outline" className="ml-2 text-xs">
                                Requer: {order.vehicleTypes.join(', ')}
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => {
                  setShowResults(false);
                  setSelectedOrders(new Set());
                  setSelectAll(false);
                  queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
                }} data-testid="button-close-results">
                  Fechar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
