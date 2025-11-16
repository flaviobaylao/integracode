import { useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Truck, Calendar, MapPin, X, Trash2, Eye, Package, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DeliveryRouteStop {
  id: string;
  customerName: string;
  customerAddress: string;
  stopOrder: number;
  status: string;
  invoiceNumber?: string;
}

interface DeliveryRoute {
  id: string;
  routeDate: string;
  vehicleType: string;
  driverId: string | null;
  totalDistance: string;
  totalDeliveries: number;
  status: string;
  startAddress: string;
  createdAt: string;
  stops?: DeliveryRouteStop[];
}

const statusLabels: Record<string, string> = {
  planned: 'Planejada',
  in_progress: 'Em Andamento',
  completed: 'Concluída',
  cancelled: 'Cancelada'
};

const statusColors: Record<string, string> = {
  planned: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-800'
};

const vehicleTypeLabels: Record<string, string> = {
  caminhao: 'Caminhão',
  carro: 'Carro',
  moto: 'Moto'
};

export default function DeliveryRoutesList() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [routeToDelete, setRouteToDelete] = useState<string | null>(null);
  const [routeToCancel, setRouteToCancel] = useState<string | null>(null);
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);

  const queryParams = new URLSearchParams();
  if (selectedDate) queryParams.append('routeDate', selectedDate);
  if (selectedStatus) queryParams.append('status', selectedStatus);

  const { data: routes = [], isLoading } = useQuery<DeliveryRoute[]>({
    queryKey: ['/api/delivery-routes', selectedDate, selectedStatus],
  });

  const { data: stops = {} } = useQuery<Record<string, DeliveryRouteStop[]>>({
    queryKey: ['/api/route-stops', expandedRoute],
    queryFn: async () => {
      if (!expandedRoute) return {};
      const result = await fetch(`/api/delivery-routes/${expandedRoute}/stops`);
      if (!result.ok) throw new Error('Failed to fetch stops');
      return { [expandedRoute]: await result.json() };
    },
    enabled: !!expandedRoute,
  });

  const cancelMutation = useMutation({
    mutationFn: (routeId: string) => apiRequest("PATCH", `/api/delivery-routes/${routeId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      toast({ title: "Rota cancelada com sucesso!" });
      setRouteToCancel(null);
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao cancelar rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (routeId: string) => apiRequest("DELETE", `/api/delivery-routes/${routeId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      toast({ title: "Rota excluída com sucesso!" });
      setRouteToDelete(null);
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleViewStops = (routeId: string) => {
    if (expandedRoute === routeId) {
      setExpandedRoute(null);
    } else {
      setExpandedRoute(routeId);
    }
  };

  return (
    <div className="container mx-auto py-6 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2" data-testid="page-title">Rotas de Entrega</h1>
        <p className="text-muted-foreground">Visualize e gerencie todas as rotas de entrega planejadas</p>
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Data da Rota</label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                data-testid="filter-date"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Status</label>
              <Select value={selectedStatus || "all"} onValueChange={(value) => setSelectedStatus(value === "all" ? "" : value)}>
                <SelectTrigger data-testid="filter-status">
                  <SelectValue placeholder="Todos os status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="planned">Planejada</SelectItem>
                  <SelectItem value="in_progress">Em Andamento</SelectItem>
                  <SelectItem value="completed">Concluída</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lista de rotas */}
      {isLoading ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Carregando rotas...</p>
        </div>
      ) : routes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Truck className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">Nenhuma rota encontrada</p>
            <p className="text-muted-foreground">
              {selectedDate || selectedStatus ? 'Tente ajustar os filtros' : 'Nenhuma rota foi planejada ainda'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {routes.map((route) => (
            <Card key={route.id} data-testid={`route-card-${route.id}`}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <CardTitle className="text-xl">
                        Rota {vehicleTypeLabels[route.vehicleType]}
                      </CardTitle>
                      <Badge className={statusColors[route.status]}>
                        {statusLabels[route.status]}
                      </Badge>
                    </div>
                    <CardDescription className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4" />
                        <span>
                          {format(parseISO(route.routeDate), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4" />
                        <span>{route.startAddress}</span>
                      </div>
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleViewStops(route.id)}
                      data-testid={`view-stops-${route.id}`}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      {expandedRoute === route.id ? 'Ocultar' : 'Ver'} Paradas
                    </Button>
                    {route.status === 'planned' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRouteToCancel(route.id)}
                          data-testid={`cancel-route-${route.id}`}
                        >
                          <X className="h-4 w-4 mr-1" />
                          Cancelar
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setRouteToDelete(route.id)}
                          data-testid={`delete-route-${route.id}`}
                        >
                          <Trash2 className="h-4 w-4 mr-1" />
                          Excluir
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Entregas</p>
                    <p className="text-lg font-semibold flex items-center gap-1">
                      <Package className="h-4 w-4" />
                      {route.totalDeliveries}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Distância Total</p>
                    <p className="text-lg font-semibold">{parseFloat(route.totalDistance).toFixed(2)} km</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Tipo de Veículo</p>
                    <p className="text-lg font-semibold">{vehicleTypeLabels[route.vehicleType]}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Criada em</p>
                    <p className="text-lg font-semibold flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      {format(parseISO(route.createdAt), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                    </p>
                  </div>
                </div>

                {/* Paradas expandidas */}
                {expandedRoute === route.id && stops[route.id] && (
                  <div className="border-t pt-4">
                    <h4 className="font-semibold mb-3">Paradas da Rota ({stops[route.id].length})</h4>
                    <div className="space-y-2">
                      {stops[route.id]
                        .sort((a, b) => a.stopOrder - b.stopOrder)
                        .map((stop) => (
                          <div 
                            key={stop.id} 
                            className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                            data-testid={`stop-${stop.id}`}
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-semibold">
                                {stop.stopOrder}
                              </div>
                              <div>
                                <p className="font-medium">{stop.customerName}</p>
                                <p className="text-sm text-muted-foreground">{stop.customerAddress}</p>
                                {stop.invoiceNumber && (
                                  <p className="text-xs text-muted-foreground mt-1">NF: {stop.invoiceNumber}</p>
                                )}
                              </div>
                            </div>
                            <Badge variant={stop.status === 'completed' ? 'default' : 'secondary'}>
                              {stop.status === 'pending' && 'Pendente'}
                              {stop.status === 'completed' && 'Concluída'}
                              {stop.status === 'failed' && 'Falhou'}
                            </Badge>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog de confirmação de cancelamento */}
      <AlertDialog open={!!routeToCancel} onOpenChange={() => setRouteToCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar Rota</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja cancelar esta rota? Os pedidos retornarão para a lista de aguardando rota e poderão ser replanejados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-dialog-no">Não</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => routeToCancel && cancelMutation.mutate(routeToCancel)}
              data-testid="cancel-dialog-yes"
            >
              Sim, cancelar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog de confirmação de exclusão */}
      <AlertDialog open={!!routeToDelete} onOpenChange={() => setRouteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Rota</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir permanentemente esta rota? Esta ação não pode ser desfeita. Os pedidos retornarão para a lista de aguardando rota.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="delete-dialog-no">Não</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => routeToDelete && deleteMutation.mutate(routeToDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="delete-dialog-yes"
            >
              Sim, excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
