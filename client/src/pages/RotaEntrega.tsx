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
  pendente: 'Pendente',
  efetuada: 'Efetuada',
  em_pausa: 'Em Pausa',
  devolvida: 'Devolvida'
};

const statusColors: Record<string, string> = {
  pendente: 'bg-gray-100 text-gray-800',
  efetuada: 'bg-green-100 text-green-800',
  em_pausa: 'bg-yellow-100 text-yellow-800',
  devolvida: 'bg-red-100 text-red-800'
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

  // Agrupar todas as entregas de todas as rotas em uma lista única
  const allDeliveries = routes.flatMap(route => 
    (route.stops || []).map(stop => ({
      ...stop,
      routeId: route.id,
      routeStatus: route.status,
      vehicleType: route.vehicleType
    }))
  ).sort((a, b) => a.stopOrder - b.stopOrder);

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

  const totalDeliveries = allDeliveries.length;
  const completedDeliveries = allDeliveries.filter(d => d.status === 'efetuada').length;
  const pendingDeliveries = allDeliveries.filter(d => d.status === 'pendente').length;
  const pendingRoute = routes.find(r => r.status === 'planejada');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Header */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-6 w-6" />
              Minhas Entregas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Date Filter */}
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

            {/* Summary Stats */}
            {!isLoading && totalDeliveries > 0 && (
              <div className="grid grid-cols-3 gap-3 pt-2">
                <div className="text-center p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">{totalDeliveries}</div>
                  <div className="text-xs text-gray-600">Total</div>
                </div>
                <div className="text-center p-3 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                  <div className="text-2xl font-bold text-yellow-600">{pendingDeliveries}</div>
                  <div className="text-xs text-gray-600">Pendentes</div>
                </div>
                <div className="text-center p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{completedDeliveries}</div>
                  <div className="text-xs text-gray-600">Concluídas</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Loading State */}
        {isLoading && (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600 dark:text-gray-400">Carregando entregas...</p>
            </CardContent>
          </Card>
        )}

        {/* Empty State */}
        {!isLoading && allDeliveries.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-16 w-16 mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold mb-2">Nenhuma entrega encontrada</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Não há entregas programadas para esta data
              </p>
            </CardContent>
          </Card>
        )}

        {/* Start Route Button (if route is planned) */}
        {!isLoading && pendingRoute && (
          <Button
            onClick={() => startRouteMutation.mutate(pendingRoute.id)}
            disabled={startRouteMutation.isPending}
            className="w-full"
            size="lg"
            data-testid="button-start-route"
          >
            <PlayCircle className="mr-2 h-5 w-5" />
            {startRouteMutation.isPending ? 'Iniciando Rota...' : 'Iniciar Rota de Entregas'}
          </Button>
        )}

        {/* Deliveries List */}
        {!isLoading && allDeliveries.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-semibold text-lg px-1">Lista de Entregas</h3>
            {allDeliveries.map((delivery) => {
              const isCompleted = delivery.status === 'efetuada';
              const isPending = delivery.status === 'pendente';

              return (
                <Card
                  key={delivery.id}
                  className={`${
                    isCompleted 
                      ? 'border-green-300 bg-green-50 dark:bg-green-950' 
                      : delivery.isPriority
                      ? 'border-red-300 bg-red-50 dark:bg-red-950'
                      : ''
                  }`}
                  data-testid={`delivery-${delivery.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1">
                        <div className={`flex-shrink-0 w-8 h-8 rounded-full text-white flex items-center justify-center text-sm font-semibold ${
                          isCompleted ? 'bg-green-600' : delivery.isPriority ? 'bg-red-600' : 'bg-gray-400'
                        }`}>
                          {delivery.stopOrder}
                        </div>
                        
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-semibold">{delivery.customerName}</p>
                            {delivery.isPriority && (
                              <Badge variant="destructive" className="text-xs">
                                Urgente
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
                            <MapPin className="h-4 w-4" />
                            {delivery.customerAddress}
                          </p>
                          {delivery.estimatedArrival && (
                            <p className="text-xs text-blue-600 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Previsto: {formatInTimeZone(new Date(delivery.estimatedArrival), 'America/Sao_Paulo', 'HH:mm')}
                            </p>
                          )}
                          {delivery.completedAt && (
                            <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                              <CheckCircle className="h-3 w-3" />
                              Concluído: {formatInTimeZone(new Date(delivery.completedAt), 'America/Sao_Paulo', 'HH:mm')}
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
                              `https://waze.com/ul?ll=${delivery.customerLatitude},${delivery.customerLongitude}&navigate=yes`,
                              '_blank'
                            );
                          }}
                          data-testid={`button-waze-${delivery.id}`}
                        >
                          <Navigation className="h-4 w-4" />
                        </Button>

                        {/* Check-in/Check-out Buttons */}
                        {delivery.routeStatus === 'em_andamento' && (
                          <>
                            {isPending && (
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => handleCheckIn(delivery.id)}
                                data-testid={`button-checkin-${delivery.id}`}
                              >
                                Check-in
                              </Button>
                            )}
                            {!isPending && !isCompleted && (
                              <Button
                                size="sm"
                                variant="default"
                                className="bg-green-600 hover:bg-green-700"
                                onClick={() => handleCheckOut(delivery.id)}
                                data-testid={`button-checkout-${delivery.id}`}
                              >
                                Check-out
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
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
