import { useState, useRef } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Truck, MapPin, CheckCircle, Clock, Navigation, Package, Calendar, PlayCircle, AlertCircle, Camera } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface DeliveryStop {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: string;
  customerLongitude: string;
  stopOrder: number;
  status: string;
  estimatedArrival: string | null;
  estimatedDuration: number;
  isPriority: boolean;
  completedAt: string | null;
}

interface DeliveryRoute {
  id: string;
  routeDate: string;
  vehicleType: string;
  totalDistance: string;
  totalDeliveries: number;
  status: string;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  stops: DeliveryStop[];
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

const vehicleIcons: Record<string, string> = {
  caminhao: '🚛',
  carro: '🚗',
  moto: '🏍️'
};

export default function RotaEntrega() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ type: 'checkin' | 'checkout', stopId: string, latitude: number, longitude: number } | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: routes = [], isLoading, refetch } = useQuery<DeliveryRoute[]>({
    queryKey: ['/api/delivery-routes/driver/my-routes', selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/delivery-routes/driver/my-routes?date=${selectedDate}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch routes');
      return res.json();
    },
    refetchInterval: 30000, // Atualiza a cada 30 segundos
  });

  const startRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('POST', `/api/delivery-routes/${routeId}/start`, {});
    },
    onSuccess: () => {
      toast({ title: "Rota iniciada com sucesso!" });
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao iniciar rota",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const checkInMutation = useMutation({
    mutationFn: async ({ stopId, latitude, longitude }: { stopId: string; latitude: number; longitude: number }) => {
      return await apiRequest('POST', `/api/delivery-routes/stops/${stopId}/checkin`, {
        latitude,
        longitude,
      });
    },
    onSuccess: () => {
      toast({ title: "Check-in realizado com sucesso!" });
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao fazer check-in",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const checkOutMutation = useMutation({
    mutationFn: async ({ stopId, latitude, longitude }: { stopId: string; latitude: number; longitude: number }) => {
      return await apiRequest('POST', `/api/delivery-routes/stops/${stopId}/checkout`, {
        latitude,
        longitude,
      });
    },
    onSuccess: (data) => {
      toast({ 
        title: data.routeCompleted ? "🎉 Rota concluída!" : "Check-out realizado com sucesso!",
        description: data.routeCompleted ? "Todas as entregas foram concluídas!" : undefined,
      });
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao fazer check-out",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePhotoCapture = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setCapturedPhoto(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleConfirmPhoto = async () => {
    if (!capturedPhoto || !pendingAction) return;

    const formData = new FormData();
    formData.append('photo', capturedPhoto);
    formData.append('latitude', pendingAction.latitude.toString());
    formData.append('longitude', pendingAction.longitude.toString());

    try {
      const endpoint = pendingAction.type === 'checkin' 
        ? `/api/delivery-routes/stops/${pendingAction.stopId}/checkin`
        : `/api/delivery-routes/stops/${pendingAction.stopId}/checkout`;

      const response = await fetch(endpoint, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Erro ao processar');
      }

      const data = await response.json();
      
      toast({ 
        title: pendingAction.type === 'checkin' ? "Check-in realizado com sucesso!" : (data.routeCompleted ? "🎉 Rota concluída!" : "Check-out realizado com sucesso!"),
        description: data.routeCompleted ? "Todas as entregas foram concluídas!" : undefined,
      });

      refetch();
      setShowPhotoModal(false);
      setPendingAction(null);
      setCapturedPhoto(null);
      setPhotoPreview(null);
    } catch (error: any) {
      toast({
        title: `Erro ao fazer ${pendingAction.type === 'checkin' ? 'check-in' : 'check-out'}`,
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleCheckIn = async (stopId: string) => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setPendingAction({
            type: 'checkin',
            stopId,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
          setShowPhotoModal(true);
        },
        (error) => {
          toast({
            title: "Erro ao obter localização",
            description: "Permita o acesso à localização para fazer check-in",
            variant: "destructive",
          });
        }
      );
    } else {
      toast({
        title: "Geolocalização não suportada",
        description: "Seu dispositivo não suporta geolocalização",
        variant: "destructive",
      });
    }
  };

  const handleCheckOut = async (stopId: string) => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setPendingAction({
            type: 'checkout',
            stopId,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
          setShowPhotoModal(true);
        },
        (error) => {
          toast({
            title: "Erro ao obter localização",
            description: "Permita o acesso à localização para fazer check-out",
            variant: "destructive",
          });
        }
      );
    } else {
      toast({
        title: "Geolocalização não suportada",
        description: "Seu dispositivo não suporta geolocalização",
        variant: "destructive",
      });
    }
  };

  const completedStops = (route: DeliveryRoute) => 
    route.stops?.filter(s => s.status === 'completed').length || 0;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Header */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-6 w-6" />
              Minhas Rotas de Entrega
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-600" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="flex-1 p-2 border rounded-md dark:bg-gray-800 dark:border-gray-700"
                data-testid="input-delivery-date"
              />
            </div>
          </CardContent>
        </Card>

        {/* Loading State */}
        {isLoading && (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600 dark:text-gray-400">Carregando rotas...</p>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {!isLoading && routes.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-16 w-16 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold mb-2">Nenhuma rota encontrada</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Não há rotas de entrega programadas para esta data
              </p>
            </CardContent>
          </Card>
        )}

        {/* Routes List */}
        {routes.map((route) => {
          const isExpanded = expandedRoute === route.id;
          const completed = completedStops(route);
          const total = route.totalDeliveries;
          const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

          return (
            <Card key={route.id} className="overflow-hidden">
              <CardHeader className="cursor-pointer" onClick={() => setExpandedRoute(isExpanded ? null : route.id)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-3xl">{vehicleIcons[route.vehicleType] || '🚚'}</div>
                    <div>
                      <CardTitle className="text-lg">
                        Rota {formatInTimeZone(new Date(route.routeDate), 'America/Sao_Paulo', 'dd/MM/yyyy')}
                      </CardTitle>
                      <p className="text-sm text-gray-600">
                        {route.timeWindowStart && route.timeWindowEnd 
                          ? `${route.timeWindowStart} - ${route.timeWindowEnd}`
                          : 'Horário flexível'}
                      </p>
                    </div>
                  </div>
                  <Badge className={statusColors[route.status]}>
                    {statusLabels[route.status]}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent>
                {/* Progress Bar */}
                <div className="mb-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium">Progresso</span>
                    <span className="text-sm text-gray-600">{completed}/{total} entregas</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-green-600 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="flex items-center gap-2">
                    <Navigation className="h-4 w-4 text-blue-600" />
                    <span className="text-sm">{parseFloat(route.totalDistance).toFixed(1)} km</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-purple-600" />
                    <span className="text-sm">{total} entregas</span>
                  </div>
                </div>

                {/* Start Route Button */}
                {route.status === 'planned' && (
                  <Button
                    onClick={() => startRouteMutation.mutate(route.id)}
                    disabled={startRouteMutation.isPending}
                    className="w-full mb-4"
                    data-testid={`button-start-route-${route.id}`}
                  >
                    <PlayCircle className="mr-2 h-4 w-4" />
                    {startRouteMutation.isPending ? 'Iniciando...' : 'Iniciar Rota'}
                  </Button>
                )}

                {/* Stops List */}
                {isExpanded && route.stops && (
                  <div className="space-y-2 mt-4 border-t pt-4">
                    <h4 className="font-semibold mb-3">Paradas ({route.stops.length})</h4>
                    {route.stops.map((stop, index) => {
                      const isCompleted = stop.status === 'completed';
                      const isPending = stop.status === 'pending';

                      return (
                        <div
                          key={stop.id}
                          className={`p-3 border rounded-lg ${
                            isCompleted 
                              ? 'border-green-200 bg-green-50 dark:bg-green-950' 
                              : stop.isPriority
                              ? 'border-red-300 bg-red-50 dark:bg-red-950'
                              : 'border-gray-200 dark:border-gray-700'
                          }`}
                          data-testid={`stop-${stop.id}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 flex-1">
                              <div className={`flex-shrink-0 w-7 h-7 rounded-full text-white flex items-center justify-center text-sm font-semibold ${
                                isCompleted ? 'bg-green-600' : stop.isPriority ? 'bg-red-600' : 'bg-gray-400'
                              }`}>
                                {stop.stopOrder}
                              </div>
                              
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <p className="font-semibold">{stop.customerName}</p>
                                  {stop.isPriority && (
                                    <Badge variant="destructive" className="text-xs">
                                      Urgente
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
                                  <MapPin className="h-3 w-3" />
                                  {stop.customerAddress}
                                </p>
                                {stop.estimatedArrival && (
                                  <p className="text-xs text-blue-600 flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    Previsto: {formatInTimeZone(new Date(stop.estimatedArrival), 'America/Sao_Paulo', 'HH:mm')}
                                  </p>
                                )}
                                {stop.completedAt && (
                                  <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                                    <CheckCircle className="h-3 w-3" />
                                    Concluído: {formatInTimeZone(new Date(stop.completedAt), 'America/Sao_Paulo', 'HH:mm')}
                                  </p>
                                )}
                              </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex flex-col gap-2">
                              {/* Waze Button */}
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-blue-600"
                                onClick={() => {
                                  window.open(
                                    `https://waze.com/ul?ll=${stop.customerLatitude},${stop.customerLongitude}&navigate=yes`,
                                    '_blank'
                                  );
                                }}
                                data-testid={`button-waze-${stop.id}`}
                              >
                                <Navigation className="h-4 w-4" />
                              </Button>

                              {/* Check-in/Check-out Buttons */}
                              {route.status === 'in_progress' && (
                                <>
                                  {isPending && (
                                    <Button
                                      size="sm"
                                      variant="default"
                                      onClick={() => handleCheckIn(stop.id)}
                                      data-testid={`button-checkin-${stop.id}`}
                                    >
                                      Check-in
                                    </Button>
                                  )}
                                  {!isPending && !isCompleted && (
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="bg-green-600 hover:bg-green-700"
                                      onClick={() => handleCheckOut(stop.id)}
                                      data-testid={`button-checkout-${stop.id}`}
                                    >
                                      Check-out
                                    </Button>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Photo Capture Modal */}
      <Dialog open={showPhotoModal} onOpenChange={setShowPhotoModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.type === 'checkin' ? 'Check-in' : 'Check-out'} - Capturar Foto
            </DialogTitle>
            <DialogDescription>
              Tire uma foto para registrar a entrega
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!photoPreview ? (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoCapture}
                  className="hidden"
                  data-testid="photo-input"
                />
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full"
                  data-testid="button-capture-photo"
                >
                  <Camera className="mr-2 h-4 w-4" />
                  Tirar Foto
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative">
                  <img
                    src={photoPreview}
                    alt="Preview"
                    className="w-full rounded-lg"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setCapturedPhoto(null);
                      setPhotoPreview(null);
                      fileInputRef.current?.click();
                    }}
                    variant="outline"
                    className="flex-1"
                    data-testid="button-retake-photo"
                  >
                    Tirar Novamente
                  </Button>
                  <Button
                    onClick={handleConfirmPhoto}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                    data-testid="button-confirm-photo"
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Confirmar
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
