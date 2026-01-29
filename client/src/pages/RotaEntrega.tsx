import { useState, useRef } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Truck, MapPin, CheckCircle, Clock, Navigation, Package, Calendar, PlayCircle, AlertCircle, Camera, RotateCcw } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { format } from "date-fns";
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
  photos: string[] | null;
  notes: string | null;
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
  pending: 'Pendente',
  efetuada: 'Efetuada',
  em_pausa: 'Em Pausa',
  devolvida: 'Devolvida'
};

const statusColors: Record<string, string> = {
  pendente: 'bg-blue-100 text-blue-800',
  pending: 'bg-blue-100 text-blue-800',
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
  
  const getTodayDateStr = () => {
    const now = toZonedTime(new Date(), 'America/Sao_Paulo');
    return format(now, 'yyyy-MM-dd');
  };
  
  const [selectedDate, setSelectedDate] = useState(getTodayDateStr());
  
  // Modal de foto para entrega
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [pendingDeliveryStop, setPendingDeliveryStop] = useState<string | null>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Modal de devolução
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [pendingReturnStop, setPendingReturnStop] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [returnPhoto, setReturnPhoto] = useState<File | null>(null);
  const [returnPhotoPreview, setReturnPhotoPreview] = useState<string | null>(null);
  const returnFileInputRef = useRef<HTMLInputElement>(null);
  
  // Modal para visualização de foto em tamanho completo
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState<string | null>(null);
  const [selectedPhotoCustomer, setSelectedPhotoCustomer] = useState<string>('');

  const closeDeliveryModal = () => {
    if (isSubmitting) return;
    setShowDeliveryModal(false);
    setPendingDeliveryStop(null);
    setCapturedPhoto(null);
    setPhotoPreview(null);
  };
  
  const closeReturnModal = () => {
    if (isSubmitting) return;
    setShowReturnModal(false);
    setPendingReturnStop(null);
    setReturnReason('');
    setReturnPhoto(null);
    setReturnPhotoPreview(null);
  };

  const { data: routes = [], isLoading, refetch, error: routesError } = useQuery<DeliveryRoute[]>({
    queryKey: ['', 'api', 'delivery-routes', 'driver', 'my-routes', selectedDate],
    queryFn: async ({ queryKey }) => {
      const url = `/api/delivery-routes/driver/my-routes?date=${selectedDate}`;
      console.log(`🚗 [FRONTEND] Buscando rotas para data: ${selectedDate}`);
      const res = await fetch(url, {
        credentials: 'include',
      });
      console.log(`🚗 [FRONTEND] Resposta: ${res.status}`, res.ok);
      if (!res.ok) {
        const error = await res.text();
        console.error(`🚗 [FRONTEND] Erro: ${error}`);
        throw new Error(`Failed to fetch routes: ${res.status} - ${error}`);
      }
      const data = await res.json();
      console.log(`🚗 [FRONTEND] Rotas recebidas:`, data?.length || 0, data);
      return data || [];
    },
    refetchInterval: 30000,
  });

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
  
  const handleReturnPhotoCapture = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setReturnPhoto(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setReturnPhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Entrega efetuada com foto
  const handleDeliveryClick = (stopId: string) => {
    setPendingDeliveryStop(stopId);
    setShowDeliveryModal(true);
  };
  
  const handleConfirmDelivery = async () => {
    if (!capturedPhoto || !pendingDeliveryStop || isSubmitting) return;

    setIsSubmitting(true);
    
    try {
      // Primeiro obter localização
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(resolve, reject);
        } else {
          reject(new Error('Geolocalização não suportada'));
        }
      });

      const formData = new FormData();
      formData.append('photo', capturedPhoto);
      formData.append('latitude', position.coords.latitude.toString());
      formData.append('longitude', position.coords.longitude.toString());

      // Fazer check-in e check-out automaticamente (entrega direta)
      const checkoutResponse = await fetch(`/api/delivery-routes/stops/${pendingDeliveryStop}/complete-delivery`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!checkoutResponse.ok) {
        const errorData = await checkoutResponse.json();
        throw new Error(errorData.message || 'Erro ao processar entrega');
      }

      const data = await checkoutResponse.json();
      
      toast({ 
        title: data.routeCompleted ? "🎉 Rota concluída!" : "Entrega registrada com sucesso!",
        description: data.routeCompleted ? "Todas as entregas foram concluídas!" : undefined,
      });

      refetch();
      closeDeliveryModal();
    } catch (error: any) {
      toast({
        title: "Erro ao registrar entrega",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Devolução com motivo
  const handleReturnClick = (stopId: string) => {
    setPendingReturnStop(stopId);
    setShowReturnModal(true);
  };
  
  const handleConfirmReturn = async () => {
    if (!pendingReturnStop || !returnReason.trim() || isSubmitting) return;

    setIsSubmitting(true);
    
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(resolve, reject);
        } else {
          reject(new Error('Geolocalização não suportada'));
        }
      });

      const formData = new FormData();
      formData.append('reason', returnReason.trim());
      formData.append('latitude', position.coords.latitude.toString());
      formData.append('longitude', position.coords.longitude.toString());
      if (returnPhoto) {
        formData.append('photo', returnPhoto);
      }

      const response = await fetch(`/api/delivery-routes/stops/${pendingReturnStop}/return`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Erro ao processar devolução');
      }
      
      toast({ 
        title: "Devolução registrada",
        description: "A devolução foi registrada com o motivo informado.",
        variant: "destructive",
      });

      refetch();
      closeReturnModal();
    } catch (error: any) {
      toast({
        title: "Erro ao registrar devolução",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalDeliveries = allDeliveries.length;
  const completedDeliveries = allDeliveries.filter(d => d.status === 'efetuada').length;
  const returnedDeliveries = allDeliveries.filter(d => d.status === 'devolvida').length;
  const pendingDeliveries = allDeliveries.filter(d => d.status === 'pendente').length;
  const hasStartedRoute = routes.some(r => r.status === 'em_andamento' || r.status === 'rota_enviada');
  const firstRoute = routes[0];

  if (!user) {
    return (
      <div className="container mx-auto p-4 max-w-lg">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <p className="text-lg font-medium">Acesso restrito</p>
            <p className="text-gray-500 mt-2">Faça login para acessar sua rota de entregas</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-lg pb-24">
      <BackToDashboardButton />
      
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold flex items-center justify-center gap-2">
          <Truck className="h-6 w-6" />
          Minhas Entregas
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Olá, {user?.firstName || user?.email}
        </p>
      </div>

      {/* Date Selector */}
      <div className="mb-4">
        <Label className="text-sm font-medium">Data</Label>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="w-full p-2 border rounded-md mt-1"
        />
      </div>

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardContent className="p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-500">Carregando suas entregas...</p>
          </CardContent>
        </Card>
      )}

      {/* Error State */}
      {routesError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-6 text-center">
            <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-3" />
            <p className="text-red-700 font-medium">Erro ao carregar entregas</p>
            <p className="text-red-600 text-sm mt-1">{(routesError as any).message}</p>
            <Button onClick={() => refetch()} className="mt-4" variant="outline">
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* No Routes */}
      {!isLoading && !routesError && allDeliveries.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-lg font-medium text-gray-700">Nenhuma entrega para hoje</p>
            <p className="text-gray-500 text-sm mt-1">Você não tem entregas programadas para esta data</p>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      {!isLoading && allDeliveries.length > 0 && (
        <Card className="mb-4 bg-gradient-to-r from-blue-50 to-green-50">
          <CardContent className="p-4">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <p className="text-2xl font-bold text-blue-600">{totalDeliveries}</p>
                <p className="text-xs text-gray-600">Total</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-600">{pendingDeliveries}</p>
                <p className="text-xs text-gray-600">Pendentes</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">{completedDeliveries}</p>
                <p className="text-xs text-gray-600">Efetuadas</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-red-600">{returnedDeliveries}</p>
                <p className="text-xs text-gray-600">Devolvidas</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Start Route Button */}
      {firstRoute && !hasStartedRoute && (
        <Button
          className="w-full mb-4 bg-green-600 hover:bg-green-700 h-14 text-lg"
          onClick={() => startRouteMutation.mutate(firstRoute.id)}
          disabled={startRouteMutation.isPending}
        >
          <PlayCircle className="mr-2 h-6 w-6" />
          {startRouteMutation.isPending ? 'Iniciando...' : 'Iniciar Rota'}
        </Button>
      )}

      {/* Deliveries List */}
      {!isLoading && allDeliveries.length > 0 && (
        <div className="space-y-3">
          {allDeliveries.map((delivery) => {
            const isCompleted = delivery.status === 'efetuada';
            const isReturned = delivery.status === 'devolvida';
            const isPending = delivery.status === 'pendente' || delivery.status === 'pending';
            const canAct = (delivery.routeStatus === 'em_andamento' || delivery.routeStatus === 'rota_enviada') && isPending;

            return (
              <Card
                key={delivery.id}
                className={`${
                  isCompleted 
                    ? 'border-green-300 bg-green-50' 
                    : isReturned
                    ? 'border-red-300 bg-red-50'
                    : delivery.isPriority
                    ? 'border-orange-300 bg-orange-50'
                    : 'border-gray-200'
                }`}
              >
                <CardContent className="p-4">
                  {/* Customer Info */}
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`flex-shrink-0 w-10 h-10 rounded-full text-white flex items-center justify-center text-lg font-bold ${
                      isCompleted ? 'bg-green-600' : isReturned ? 'bg-red-600' : delivery.isPriority ? 'bg-orange-600' : 'bg-blue-600'
                    }`}>
                      {delivery.stopOrder}
                    </div>
                    
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-bold text-lg">{delivery.customerName}</p>
                        {delivery.isPriority && (
                          <Badge variant="destructive" className="text-xs">Urgente</Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 flex items-start gap-1">
                        <MapPin className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>{delivery.customerAddress}</span>
                      </p>
                      
                      {/* Status Badge */}
                      <Badge className={`mt-2 ${statusColors[delivery.status]}`}>
                        {statusLabels[delivery.status]}
                      </Badge>
                      
                      {/* Motivo de devolução */}
                      {delivery.status === 'devolvida' && delivery.notes && (
                        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                          <p className="text-xs font-semibold text-red-700 flex items-center gap-1 mb-1">
                            <AlertCircle className="h-3 w-3" />
                            Motivo da Devolução:
                          </p>
                          <p className="text-sm text-red-800">
                            {delivery.notes.includes('[DEVOLUÇÃO') 
                              ? delivery.notes.split('] ').pop() 
                              : delivery.notes}
                          </p>
                        </div>
                      )}
                      
                      {delivery.completedAt && (
                        <p className="text-xs text-green-600 flex items-center gap-1 mt-1">
                          <CheckCircle className="h-3 w-3" />
                          Concluído: {formatInTimeZone(new Date(delivery.completedAt), 'America/Sao_Paulo', 'HH:mm')}
                        </p>
                      )}
                      
                      {/* Miniatura da foto da entrega */}
                      {delivery.photos && delivery.photos.length > 0 && (
                        <div className="mt-2">
                          <div 
                            className="inline-block cursor-pointer rounded-lg overflow-hidden border-2 border-green-400 hover:border-green-600 transition-colors"
                            onClick={() => {
                              setSelectedPhotoUrl(delivery.photos![0]);
                              setSelectedPhotoCustomer(delivery.customerName);
                            }}
                          >
                            <img 
                              src={delivery.photos[0]} 
                              alt={`Foto da entrega - ${delivery.customerName}`}
                              className="w-16 h-16 object-cover"
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                            <Camera className="h-3 w-3" />
                            Toque para ampliar
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action Buttons - Simplified */}
                  <div className="flex gap-2">
                    {/* Waze Button - Always visible */}
                    <Button
                      size="lg"
                      variant="outline"
                      className="flex-1 text-blue-600 border-blue-600 h-12"
                      onClick={() => {
                        window.open(
                          `https://waze.com/ul?ll=${delivery.customerLatitude},${delivery.customerLongitude}&navigate=yes`,
                          '_blank'
                        );
                      }}
                    >
                      <Navigation className="h-5 w-5 mr-2" />
                      Waze
                    </Button>

                    {/* Delivery Button - Only when pending and route started */}
                    {canAct && (
                      <>
                        <Button
                          size="lg"
                          className="flex-1 bg-green-600 hover:bg-green-700 h-12"
                          onClick={() => handleDeliveryClick(delivery.id)}
                        >
                          <Camera className="h-5 w-5 mr-2" />
                          Entregar
                        </Button>

                        <Button
                          size="lg"
                          variant="destructive"
                          className="flex-1 h-12"
                          onClick={() => handleReturnClick(delivery.id)}
                        >
                          <RotateCcw className="h-5 w-5 mr-2" />
                          Devolver
                        </Button>
                      </>
                    )}

                    {/* Completed State */}
                    {isCompleted && (
                      <div className="flex-1 flex items-center justify-center bg-green-100 rounded-md h-12">
                        <CheckCircle className="h-5 w-5 text-green-600 mr-2" />
                        <span className="font-medium text-green-700">Entregue</span>
                      </div>
                    )}

                    {/* Returned State */}
                    {isReturned && (
                      <div className="flex-1 flex items-center justify-center bg-red-100 rounded-md h-12">
                        <RotateCcw className="h-5 w-5 text-red-600 mr-2" />
                        <span className="font-medium text-red-700">Devolvida</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delivery Photo Modal */}
      <Dialog open={showDeliveryModal} onOpenChange={(open) => !open && closeDeliveryModal()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5 text-green-600" />
              Registrar Entrega
            </DialogTitle>
            <DialogDescription>
              Tire uma foto do local ou comprovante de entrega
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isSubmitting ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
                <p className="text-lg font-medium text-gray-700">Registrando entrega...</p>
                <p className="text-sm text-gray-500">Aguarde, isso pode levar alguns segundos</p>
              </div>
            ) : !photoPreview ? (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoCapture}
                  className="hidden"
                />
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full h-14 text-lg bg-green-600 hover:bg-green-700"
                >
                  <Camera className="mr-2 h-6 w-6" />
                  Tirar Foto
                </Button>
                <Button
                  onClick={closeDeliveryModal}
                  variant="outline"
                  className="w-full"
                >
                  Cancelar
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <img
                  src={photoPreview}
                  alt="Preview"
                  className="w-full rounded-lg max-h-64 object-cover"
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setCapturedPhoto(null);
                      setPhotoPreview(null);
                    }}
                    variant="outline"
                    className="flex-1"
                  >
                    Tirar outra
                  </Button>
                  <Button
                    onClick={handleConfirmDelivery}
                    className="flex-1 bg-green-600 hover:bg-green-700"
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

      {/* Return Modal */}
      <Dialog open={showReturnModal} onOpenChange={(open) => !open && closeReturnModal()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <RotateCcw className="h-5 w-5" />
              Registrar Devolução
            </DialogTitle>
            <DialogDescription>
              Informe o motivo da devolução
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isSubmitting ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
                <p className="text-lg font-medium text-gray-700">Registrando devolução...</p>
              </div>
            ) : (
              <>
                <div>
                  <Label htmlFor="reason" className="font-medium">
                    Motivo da Devolução *
                  </Label>
                  <Textarea
                    id="reason"
                    placeholder="Ex: Cliente ausente, endereço não encontrado, recusou receber..."
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    className="mt-2 min-h-[100px]"
                  />
                </div>
                
                <div>
                  <Label className="font-medium">Foto (opcional)</Label>
                  <input
                    ref={returnFileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleReturnPhotoCapture}
                    className="hidden"
                  />
                  {!returnPhotoPreview ? (
                    <Button
                      onClick={() => returnFileInputRef.current?.click()}
                      variant="outline"
                      className="w-full mt-2"
                    >
                      <Camera className="mr-2 h-4 w-4" />
                      Adicionar Foto
                    </Button>
                  ) : (
                    <div className="mt-2 space-y-2">
                      <img
                        src={returnPhotoPreview}
                        alt="Preview"
                        className="w-full rounded-lg max-h-32 object-cover"
                      />
                      <Button
                        onClick={() => {
                          setReturnPhoto(null);
                          setReturnPhotoPreview(null);
                        }}
                        variant="outline"
                        size="sm"
                        className="w-full"
                      >
                        Remover foto
                      </Button>
                    </div>
                  )}
                </div>

                <DialogFooter className="flex gap-2">
                  <Button
                    onClick={closeReturnModal}
                    variant="outline"
                    className="flex-1"
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleConfirmReturn}
                    variant="destructive"
                    className="flex-1"
                    disabled={!returnReason.trim()}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Confirmar Devolução
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal para visualização de foto em tamanho completo */}
      <Dialog open={!!selectedPhotoUrl} onOpenChange={() => setSelectedPhotoUrl(null)}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden">
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              className="absolute top-2 right-2 z-10 bg-white/90 hover:bg-white rounded-full h-10 w-10"
              onClick={() => setSelectedPhotoUrl(null)}
            >
              ✕
            </Button>
            
            {selectedPhotoUrl && (
              <img 
                src={selectedPhotoUrl} 
                alt={`Foto da entrega - ${selectedPhotoCustomer}`}
                className="w-full max-h-[85vh] object-contain bg-black"
              />
            )}
            
            <div className="p-4 bg-white dark:bg-gray-800">
              <p className="text-center text-lg font-semibold flex items-center justify-center gap-2">
                <Camera className="h-5 w-5 text-green-600" />
                {selectedPhotoCustomer}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
