import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
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
import MissingCoordinatesModal from "@/components/MissingCoordinatesModal";
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
  RefreshCw,
  Map
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
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
  deliveryWeekdays: string[];
  deliveryTimeSlots: string[];
  deliverySaturdayTimeSlots: string[];
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
  
  // Estados para modal de coordenadas faltantes
  const [showMissingCoordinates, setShowMissingCoordinates] = useState(false);
  const [missingCoordinatesData, setMissingCoordinatesData] = useState<any[]>([]);
  const [pendingRouteConfig, setPendingRouteConfig] = useState<{ orderIds: string[]; vehicles: VehicleConfig[]; routeDate: string } | null>(null);
  
  // Estados para edição de configurações de entrega
  const [showDeliveryConfig, setShowDeliveryConfig] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<DeliveryOrder | null>(null);
  const [deliveryConfigForm, setDeliveryConfigForm] = useState({
    exclusiveVehicle: false,
    vehicleTypes: [] as string[],
    deliveryWeekdays: [] as string[],
    deliveryTimeSlots: [] as string[],
    deliverySaturdayTimeSlots: [] as string[],
  });

  // Query para buscar usuário atual
  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
  });
  
  const isAdministrative = ['admin', 'coordinator', 'administrative'].includes((currentUser as any)?.role);

  // Query para buscar pedidos aguardando rota
  const { data: orders, isLoading: isLoadingOrders, error: ordersError } = useQuery<DeliveryOrder[]>({
    queryKey: ['/api/deliveries'],
    queryFn: () => apiRequest('GET', '/api/deliveries'),
    refetchInterval: 30000,
  });

  // Query para buscar motoristas ativos
  const { data: drivers = [], isLoading: isLoadingDrivers, error: driversError } = useQuery<DeliveryDriver[]>({
    queryKey: ['/api/delivery-drivers'],
    queryFn: () => apiRequest('GET', '/api/delivery-drivers'),
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
      setPendingRouteConfig(null); // Limpar config pendente
      toast({
        title: "Rotas planejadas com sucesso!",
        description: `${data.stats.assignedOrders} pedidos atribuídos em ${data.routes.length} rotas`,
      });
    },
    onError: (error: any) => {
      // Detectar erro 422 (coordenadas faltantes)
      if (error.status === 422 && error.code === 'MISSING_COORDINATES') {
        setMissingCoordinatesData(error.missingCoordinates || []);
        setShowMissingCoordinates(true);
        // Não mostrar toast de erro, modal vai exibir a mensagem
      } else {
        toast({
          title: "Erro ao planejar rotas",
          description: error.message || "Erro desconhecido",
          variant: "destructive",
        });
      }
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

  const saveRoutesMutation = useMutation({
    mutationFn: async (data: { routes: any[] }) => {
      return await apiRequest('POST', '/api/delivery-routes/save', data);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      setShowResults(false);
      setSelectedOrders(new Set());
      setSelectAll(false);
      setRoutePlan(null);
      toast({
        title: "Rotas salvas com sucesso!",
        description: `${data.routes.length} rotas foram salvas e os pedidos estão agora "Em Rota"`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao salvar rotas",
        description: error.message || "Erro ao salvar as rotas planejadas",
        variant: "destructive",
      });
    },
  });
  
  // Mutation para atualizar configurações de entrega do cliente
  const updateDeliveryConfigMutation = useMutation({
    mutationFn: async (data: { customerId: string; config: any }) => {
      return await apiRequest('PUT', `/api/customers/${data.customerId}`, data.config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      setShowDeliveryConfig(false);
      toast({
        title: "Configurações atualizadas",
        description: "As configurações de entrega do cliente foram atualizadas com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar",
        description: error.message || "Erro ao atualizar configurações de entrega",
        variant: "destructive",
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
  
  // Funções para edição de configurações de entrega
  const handleOpenDeliveryConfig = (order: DeliveryOrder) => {
    setEditingCustomer(order);
    setDeliveryConfigForm({
      exclusiveVehicle: order.exclusiveVehicle || false,
      vehicleTypes: order.vehicleTypes || [],
      deliveryWeekdays: order.deliveryWeekdays || [],
      deliveryTimeSlots: order.deliveryTimeSlots || [],
      deliverySaturdayTimeSlots: order.deliverySaturdayTimeSlots || [],
    });
    setShowDeliveryConfig(true);
  };
  
  const handleSaveDeliveryConfig = () => {
    if (!editingCustomer) return;
    
    updateDeliveryConfigMutation.mutate({
      customerId: editingCustomer.customerId,
      config: deliveryConfigForm,
    });
  };
  
  const toggleDeliveryWeekday = (day: string) => {
    setDeliveryConfigForm(prev => ({
      ...prev,
      deliveryWeekdays: prev.deliveryWeekdays.includes(day)
        ? prev.deliveryWeekdays.filter(d => d !== day)
        : [...prev.deliveryWeekdays, day]
    }));
  };
  
  const toggleDeliveryTimeSlot = (slot: string) => {
    setDeliveryConfigForm(prev => ({
      ...prev,
      deliveryTimeSlots: prev.deliveryTimeSlots.includes(slot)
        ? prev.deliveryTimeSlots.filter(s => s !== slot)
        : [...prev.deliveryTimeSlots, slot]
    }));
  };
  
  const toggleSaturdayTimeSlot = (slot: string) => {
    setDeliveryConfigForm(prev => ({
      ...prev,
      deliverySaturdayTimeSlots: prev.deliverySaturdayTimeSlots.includes(slot)
        ? prev.deliverySaturdayTimeSlots.filter(s => s !== slot)
        : [...prev.deliverySaturdayTimeSlots, slot]
    }));
  };
  
  const toggleVehicleType = (type: string) => {
    setDeliveryConfigForm(prev => {
      const newTypes = prev.vehicleTypes.includes(type)
        ? prev.vehicleTypes.filter(v => v !== type)
        : [...prev.vehicleTypes, type];
      
      // Limitar a 2 tipos de veículos
      if (newTypes.length > 2) {
        toast({
          title: "Limite excedido",
          description: "Selecione no máximo 2 tipos de veículos",
          variant: "destructive",
        });
        return prev;
      }
      
      return { ...prev, vehicleTypes: newTypes };
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

    const routeConfig = {
      orderIds: Array.from(selectedOrders),
      vehicles,
      routeDate
    };
    
    // Salvar configuração para tentar novamente após preencher coordenadas
    setPendingRouteConfig(routeConfig);
    
    planRoutesMutation.mutate(routeConfig);
  };
  
  // Callback quando coordenadas são salvas com sucesso
  const handleCoordinatesSaved = () => {
    setShowMissingCoordinates(false);
    
    // Tentar criar rota novamente com a configuração salva
    if (pendingRouteConfig) {
      toast({
        title: "Coordenadas salvas!",
        description: "Gerando rotas agora...",
      });
      
      // Aguardar um pouco para garantir que o backend atualizou os dados
      setTimeout(() => {
        planRoutesMutation.mutate(pendingRouteConfig);
      }, 500);
    }
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

      {/* Error Alert - Renderização inline para permitir recuperação */}
      {(ordersError || driversError) && (
        <Card className="border-red-200 bg-red-50">
          <CardHeader>
            <CardTitle className="text-red-600">Erro ao Carregar Dados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-muted-foreground">
                Ocorreu um erro ao carregar alguns dados. Você pode tentar novamente.
              </p>
              {ordersError && (
                <div className="p-3 bg-white border border-red-200 rounded">
                  <p className="text-sm text-red-800">
                    <strong>Erro ao carregar pedidos:</strong> {(ordersError as any)?.message || 'Erro desconhecido'}
                  </p>
                </div>
              )}
              {driversError && (
                <div className="p-3 bg-white border border-red-200 rounded">
                  <p className="text-sm text-red-800">
                    <strong>Erro ao carregar motoristas:</strong> {(driversError as any)?.message || 'Erro desconhecido'}
                  </p>
                </div>
              )}
              <Button 
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
                  queryClient.invalidateQueries({ queryKey: ['/api/delivery-drivers'] });
                }}
                className="mt-2"
                disabled={isLoadingOrders || isLoadingDrivers}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${(isLoadingOrders || isLoadingDrivers) ? 'animate-spin' : ''}`} />
                {(isLoadingOrders || isLoadingDrivers) ? 'Tentando...' : 'Tentar Novamente'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
                min={new Date().toISOString().split('T')[0]}
                value={routeDate}
                onChange={(e) => setRouteDate(e.target.value)}
                data-testid="input-route-date"
              />
              <p className="text-xs text-muted-foreground">
                <Calendar className="h-3 w-3 inline mr-1" />
                Selecione a data de execução da rota
              </p>
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
                          {order.customerWeekdays && Array.isArray(order.customerWeekdays) && order.customerWeekdays.length > 0 && (
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

                        {/* Informações de entrega do card */}
                        {(order.deliveryWeekdays?.length > 0 || order.deliveryTimeSlots?.length > 0) && (
                          <div className="bg-blue-50 border border-blue-200 rounded p-2 space-y-1">
                            <div className="text-xs font-semibold text-blue-900">📅 Programação de Entrega do Card:</div>
                            {order.deliveryWeekdays?.length > 0 && (
                              <div className="flex items-center text-xs text-blue-800">
                                <Calendar className="h-3 w-3 mr-1" />
                                <span className="font-medium">Dias:</span>
                                <span className="ml-1">{order.deliveryWeekdays.join(', ')}</span>
                              </div>
                            )}
                            {order.deliveryTimeSlots?.length > 0 && (
                              <div className="flex items-center text-xs text-blue-800">
                                <Clock className="h-3 w-3 mr-1" />
                                <span className="font-medium">Horários:</span>
                                <span className="ml-1">{order.deliveryTimeSlots.join(', ')}</span>
                              </div>
                            )}
                            {order.deliverySaturdayTimeSlots?.length > 0 && (
                              <div className="flex items-center text-xs text-blue-800">
                                <Clock className="h-3 w-3 mr-1" />
                                <span className="font-medium">Sábados:</span>
                                <span className="ml-1">{order.deliverySaturdayTimeSlots.join(', ')}</span>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1">
                          <div className="flex items-center space-x-2">
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
                          
                          {isAdministrative && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleOpenDeliveryConfig(order)}
                              className="h-7 text-xs"
                              data-testid={`button-edit-delivery-config-${order.id}`}
                            >
                              <Settings className="h-3 w-3 mr-1" />
                              Editar Config. Entrega
                            </Button>
                          )}
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
                      
                      {/* Mapa da Rota */}
                      {(() => {
                        // Calcular centro do mapa baseado nas coordenadas dos stops
                        const validStops = route.stops.filter((stop: any) => {
                          const lat = parseFloat(stop.latitude || stop.customerLatitude);
                          const lng = parseFloat(stop.longitude || stop.customerLongitude);
                          return lat && lng && !isNaN(lat) && !isNaN(lng);
                        });
                        
                        if (validStops.length === 0) {
                          return (
                            <div className="mb-4 border rounded-lg p-4 bg-gray-50 text-center text-muted-foreground">
                              <Map className="h-6 w-6 mx-auto mb-2 opacity-50" />
                              <p className="text-sm">Mapa não disponível - coordenadas ausentes</p>
                            </div>
                          );
                        }
                        
                        const firstStop = validStops[0];
                        const centerLat = parseFloat(firstStop.latitude || firstStop.customerLatitude);
                        const centerLng = parseFloat(firstStop.longitude || firstStop.customerLongitude);
                        
                        return (
                          <div className="mb-4 border rounded-lg overflow-hidden" style={{ height: '300px' }}>
                            <MapContainer
                              center={[centerLat, centerLng]}
                              zoom={12}
                              style={{ height: '100%', width: '100%' }}
                              scrollWheelZoom={false}
                            >
                              <TileLayer
                                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                              />
                          
                          {/* Marcadores das paradas */}
                          {route.stops.map((stop: any, stopIdx: number) => {
                            const lat = parseFloat(stop.latitude || stop.customerLatitude);
                            const lng = parseFloat(stop.longitude || stop.customerLongitude);
                            
                            if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;
                            
                            return (
                              <Marker
                                key={stopIdx}
                                position={[lat, lng]}
                                icon={L.divIcon({
                                  html: `<div style="background-color: #10b981; width: 30px; height: 30px; border-radius: 50%; border: 3px solid white; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3); font-size: 12px;">${stop.stopOrder}</div>`,
                                  className: '',
                                  iconSize: [30, 30],
                                  iconAnchor: [15, 15]
                                })}
                              >
                                <Popup>
                                  <strong>Parada {stop.stopOrder}</strong><br />
                                  {stop.customerName}<br />
                                  <span className="text-xs text-gray-600">
                                    ETA: {new Date(stop.estimatedArrival).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </Popup>
                              </Marker>
                            );
                          })}
                          
                          {/* Linha conectando todos os pontos */}
                          <Polyline
                            positions={route.stops
                              .map((stop: any) => {
                                const lat = parseFloat(stop.latitude || stop.customerLatitude);
                                const lng = parseFloat(stop.longitude || stop.customerLongitude);
                                return lat && lng && !isNaN(lat) && !isNaN(lng) ? [lat, lng] : null;
                              })
                              .filter((pos: any) => pos !== null)
                            }
                            color="#3b82f6"
                            weight={3}
                            opacity={0.7}
                          />
                        </MapContainer>
                      </div>
                    );
                  })()}
                      
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

              <div className="flex justify-end space-x-2">
                <Button 
                  variant="outline"
                  onClick={() => {
                    setShowResults(false);
                    setSelectedOrders(new Set());
                    setSelectAll(false);
                    queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
                  }} 
                  data-testid="button-close-results"
                >
                  Fechar
                </Button>
                <Button 
                  onClick={() => {
                    console.log('🔍 [SAVE-ROUTES-FRONTEND] pendingRouteConfig:', pendingRouteConfig);
                    console.log('🔍 [SAVE-ROUTES-FRONTEND] routeDate será:', pendingRouteConfig?.routeDate || new Date().toISOString().split('T')[0]);
                    
                    // Preparar dados para salvar
                    const routesToSave = routePlan.routes.map((route: VehicleRoute) => ({
                      route: {
                        routeDate: pendingRouteConfig?.routeDate || new Date().toISOString().split('T')[0],
                        driverId: route.driverId || '',
                        driverName: route.driverName || 'Sem motorista',
                        vehicleType: route.vehicleType,
                        startLatitude: route.startLatitude,
                        startLongitude: route.startLongitude,
                        totalDistance: route.totalDistance,
                        totalDuration: route.totalDuration,
                        timeWindowStart: pendingRouteConfig?.vehicles.find((v: VehicleConfig) => v.type === route.vehicleType)?.timeWindowStart || '08:00',
                        timeWindowEnd: pendingRouteConfig?.vehicles.find((v: VehicleConfig) => v.type === route.vehicleType)?.timeWindowEnd || '18:00',
                      },
                      stops: route.stops.map((stop: any) => ({
                        ...stop,
                        billingId: stop.salesCardId, // salesCardId é na verdade o billingId
                        latitude: stop.latitude || stop.customerLatitude,
                        longitude: stop.longitude || stop.customerLongitude,
                      }))
                    }));
                    
                    saveRoutesMutation.mutate({ routes: routesToSave });
                  }}
                  disabled={saveRoutesMutation.isPending}
                  data-testid="button-save-routes"
                >
                  {saveRoutesMutation.isPending ? 'Salvando...' : 'Salvar Rotas'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal para editar configurações de entrega do cliente */}
      <Dialog open={showDeliveryConfig} onOpenChange={setShowDeliveryConfig}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-delivery-config">
          <DialogHeader>
            <DialogTitle>Configurações de Entrega</DialogTitle>
            <DialogDescription>
              Editar preferências de entrega para {editingCustomer?.customerName}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Veículo Exclusivo */}
            <div className="space-y-3 border border-orange-200 bg-orange-50 p-4 rounded-lg">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-orange-600" />
                <Label className="text-sm font-medium text-orange-900">Veículo Exclusivo</Label>
              </div>
              
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="exclusive-vehicle-config"
                  checked={deliveryConfigForm.exclusiveVehicle}
                  onCheckedChange={(checked) => {
                    setDeliveryConfigForm(prev => ({
                      ...prev,
                      exclusiveVehicle: checked as boolean,
                      vehicleTypes: checked ? prev.vehicleTypes : []
                    }));
                  }}
                  data-testid="checkbox-exclusive-vehicle-config"
                />
                <Label htmlFor="exclusive-vehicle-config" className="text-sm cursor-pointer">
                  Entrega em veículo exclusivo?
                </Label>
              </div>

              {deliveryConfigForm.exclusiveVehicle && (
                <div className="ml-6 space-y-2">
                  <Label className="text-sm font-medium">Tipos de Veículos (máximo 2)</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: 'caminhao', label: '🚛 Caminhão' },
                      { value: 'carro', label: '🚗 Carro' },
                      { value: 'moto', label: '🏍️ Moto' }
                    ].map((vehicle) => (
                      <div key={vehicle.value} className="flex items-center space-x-2">
                        <Checkbox
                          id={`vehicle-config-${vehicle.value}`}
                          checked={deliveryConfigForm.vehicleTypes.includes(vehicle.value)}
                          onCheckedChange={() => toggleVehicleType(vehicle.value)}
                          data-testid={`checkbox-vehicle-config-${vehicle.value}`}
                        />
                        <Label htmlFor={`vehicle-config-${vehicle.value}`} className="text-sm cursor-pointer">
                          {vehicle.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Dias de Entrega */}
            <div className="space-y-3 border border-blue-200 bg-blue-50 p-4 rounded-lg">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-600" />
                <Label className="text-sm font-medium text-blue-900">Dias da Semana para Entrega</Label>
              </div>
              
              <div className="grid grid-cols-4 gap-3">
                {[
                  { value: 'Seg', label: 'Seg' },
                  { value: 'Ter', label: 'Ter' },
                  { value: 'Qua', label: 'Qua' },
                  { value: 'Qui', label: 'Qui' },
                  { value: 'Sex', label: 'Sex' },
                  { value: 'Sab', label: 'Sáb' },
                  { value: 'Dom', label: 'Dom' },
                ].map((day) => (
                  <div key={day.value} className="flex items-center space-x-2">
                    <Checkbox
                      id={`delivery-weekday-${day.value}`}
                      checked={deliveryConfigForm.deliveryWeekdays.includes(day.value)}
                      onCheckedChange={() => toggleDeliveryWeekday(day.value)}
                      data-testid={`checkbox-delivery-weekday-${day.value}`}
                    />
                    <Label htmlFor={`delivery-weekday-${day.value}`} className="text-sm cursor-pointer">
                      {day.label}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            {/* Horários de Entrega (Seg-Sex) */}
            <div className="space-y-3 border border-green-200 bg-green-50 p-4 rounded-lg">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-green-600" />
                <Label className="text-sm font-medium text-green-900">Horários de Entrega (Seg-Sex)</Label>
              </div>
              
              <div className="grid grid-cols-4 gap-3">
                {['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'].map((slot) => (
                  <div key={slot} className="flex items-center space-x-2">
                    <Checkbox
                      id={`time-slot-${slot}`}
                      checked={deliveryConfigForm.deliveryTimeSlots.includes(slot)}
                      onCheckedChange={() => toggleDeliveryTimeSlot(slot)}
                      data-testid={`checkbox-time-slot-${slot}`}
                    />
                    <Label htmlFor={`time-slot-${slot}`} className="text-sm cursor-pointer">
                      {slot}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            {/* Horários de Entrega aos Sábados */}
            <div className="space-y-3 border border-purple-200 bg-purple-50 p-4 rounded-lg">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-purple-600" />
                <Label className="text-sm font-medium text-purple-900">Horários aos Sábados</Label>
              </div>
              
              <div className="grid grid-cols-4 gap-3">
                {['08:00', '09:00', '10:00', '11:00', '12:00'].map((slot) => (
                  <div key={slot} className="flex items-center space-x-2">
                    <Checkbox
                      id={`saturday-slot-${slot}`}
                      checked={deliveryConfigForm.deliverySaturdayTimeSlots.includes(slot)}
                      onCheckedChange={() => toggleSaturdayTimeSlot(slot)}
                      data-testid={`checkbox-saturday-slot-${slot}`}
                    />
                    <Label htmlFor={`saturday-slot-${slot}`} className="text-sm cursor-pointer">
                      {slot}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => setShowDeliveryConfig(false)}
              data-testid="button-cancel-delivery-config"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSaveDeliveryConfig}
              disabled={updateDeliveryConfigMutation.isPending}
              data-testid="button-save-delivery-config"
            >
              {updateDeliveryConfigMutation.isPending ? 'Salvando...' : 'Salvar Configurações'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal para cadastrar coordenadas faltantes */}
      <MissingCoordinatesModal
        isOpen={showMissingCoordinates}
        onClose={() => setShowMissingCoordinates(false)}
        missingCoordinates={missingCoordinatesData}
        onSuccess={handleCoordinatesSaved}
      />
    </div>
  );
}
