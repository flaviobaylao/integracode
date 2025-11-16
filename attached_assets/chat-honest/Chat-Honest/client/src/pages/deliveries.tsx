import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, MapPin, Calendar, Package, Phone, Navigation } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
// Logo will be loaded from attached assets if available
const logoImage = "/attached_assets/folha icone_1755477689163.JPG";

interface DeliveryRejectionReason {
  id: string;
  reason: string;
  description?: string;
  isActive: boolean;
}

interface DeliveryWithPerson {
  id: string;
  conversationId?: string;
  deliveryPersonId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  orderDetails: any;
  totalAmount: string;
  scheduledDate: string;
  status: string;
  deliveryTime?: string;
  latitude?: string;
  longitude?: string;
  rejectionReasonId?: string;
  rejectionNotes?: string;
  createdAt: string;
  updatedAt: string;
  deliveryPerson: {
    id: string;
    username: string;
    email: string;
  };
}

export default function DeliveriesPage() {
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryWithPerson | null>(null);
  const [actionType, setActionType] = useState<"confirm" | "reject" | null>(null);
  const [rejectionReasonId, setRejectionReasonId] = useState("");
  const [rejectionNotes, setRejectionNotes] = useState("");
  const [gettingLocation, setGettingLocation] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch today's deliveries
  const { data: deliveries = [], isLoading } = useQuery<DeliveryWithPerson[]>({
    queryKey: ["/api/deliveries/today"],
  });

  // Fetch rejection reasons
  const { data: rejectionReasons = [] } = useQuery<DeliveryRejectionReason[]>({
    queryKey: ["/api/delivery-rejection-reasons"],
  });

  // Confirm delivery mutation
  const confirmDeliveryMutation = useMutation({
    mutationFn: async ({ deliveryId, latitude, longitude }: { 
      deliveryId: string; 
      latitude: number; 
      longitude: number; 
    }) => {
      return apiRequest(`/api/deliveries/${deliveryId}/confirm`, "POST", { 
        latitude, 
        longitude 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deliveries/today"] });
      toast({
        title: "Entrega confirmada",
        description: "A entrega foi confirmada com sucesso!",
      });
      setSelectedDelivery(null);
      setActionType(null);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao confirmar entrega",
        variant: "destructive",
      });
    },
  });

  // Reject delivery mutation
  const rejectDeliveryMutation = useMutation({
    mutationFn: async ({ deliveryId, rejectionReasonId, rejectionNotes }: {
      deliveryId: string;
      rejectionReasonId: string;
      rejectionNotes?: string;
    }) => {
      return apiRequest(`/api/deliveries/${deliveryId}/reject`, "POST", { 
        rejectionReasonId, 
        rejectionNotes 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deliveries/today"] });
      toast({
        title: "Entrega recusada",
        description: "A entrega foi recusada com sucesso.",
      });
      setSelectedDelivery(null);
      setActionType(null);
      setRejectionReasonId("");
      setRejectionNotes("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao recusar entrega",
        variant: "destructive",
      });
    },
  });

  // Get current location
  const getCurrentLocation = () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Geolocalização não é suportada neste dispositivo",
        variant: "destructive",
      });
      return;
    }

    setGettingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        confirmDeliveryMutation.mutate({
          deliveryId: selectedDelivery!.id,
          latitude,
          longitude,
        });
        setGettingLocation(false);
      },
      (error) => {
        setGettingLocation(false);
        toast({
          title: "Erro de localização",
          description: "Não foi possível obter sua localização. Verifique as permissões.",
          variant: "destructive",
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000,
      }
    );
  };

  // Handle confirm delivery
  const handleConfirmDelivery = () => {
    if (!selectedDelivery) return;
    getCurrentLocation();
  };

  // Handle reject delivery
  const handleRejectDelivery = () => {
    if (!selectedDelivery || !rejectionReasonId) return;
    
    rejectDeliveryMutation.mutate({
      deliveryId: selectedDelivery.id,
      rejectionReasonId,
      rejectionNotes,
    });
  };

  // Get status badge variant
  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "delivered":
        return "default";
      case "failed":
        return "destructive";
      case "pending":
        return "secondary";
      default:
        return "outline";
    }
  };

  // Get status text
  const getStatusText = (status: string) => {
    switch (status) {
      case "delivered":
        return "Entregue";
      case "failed":
        return "Recusado";
      case "pending":
        return "Pendente";
      default:
        return status;
    }
  };

  // Format currency
  const formatCurrency = (value: string) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(parseFloat(value));
  };

  // Format date/time
  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString("pt-BR");
  };

  // Format time only
  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Open navigation to address
  const openNavigation = (address: string) => {
    const encodedAddress = encodeURIComponent(address);
    
    // Try to open in Google Maps app first, fallback to web
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodedAddress}`;
    window.open(mapsUrl, "_blank");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-400">Carregando entregas...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Mobile Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-40">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <img src={logoImage} alt="Logo" className="h-8 w-8 rounded-full object-cover" />
              <div>
                <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Entregas
                </h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {new Date().toLocaleDateString("pt-BR", { 
                    weekday: "long", 
                    year: "numeric", 
                    month: "long", 
                    day: "numeric" 
                  })}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="text-xs">
              {deliveries.length} entregas
            </Badge>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="p-4 pb-20">
        {deliveries.length === 0 ? (
          <div className="text-center py-12">
            <Package className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              Nenhuma entrega para hoje
            </h3>
            <p className="text-gray-500 dark:text-gray-400">
              Você não tem entregas programadas para hoje.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {deliveries.map((delivery: DeliveryWithPerson) => (
              <Card key={delivery.id} className="border-l-4 border-l-green-500">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Package className="h-4 w-4 text-green-600" />
                      <CardTitle className="text-base">{delivery.customerName}</CardTitle>
                    </div>
                    <Badge variant={getStatusBadgeVariant(delivery.status)}>
                      {getStatusText(delivery.status)}
                    </Badge>
                  </div>
                  <div className="flex items-center space-x-4 text-sm text-gray-500 dark:text-gray-400">
                    <div className="flex items-center space-x-1">
                      <Phone className="h-3 w-3" />
                      <span>{delivery.customerPhone}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <Calendar className="h-3 w-3" />
                      <span>{formatTime(delivery.scheduledDate)}</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <div className="flex items-start space-x-2">
                    <MapPin className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-gray-600 dark:text-gray-300 flex-1">
                      {delivery.customerAddress}
                    </p>
                  </div>

                  <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                    <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">
                      Total: {formatCurrency(delivery.totalAmount)}
                    </p>
                    {delivery.orderDetails && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {Array.isArray(delivery.orderDetails) ? (
                          delivery.orderDetails.map((item: any, index: number) => (
                            <div key={index}>
                              {item.quantity}x {item.name}
                            </div>
                          ))
                        ) : (
                          <div>Detalhes do pedido disponíveis</div>
                        )}
                      </div>
                    )}
                  </div>

                  {delivery.status === "pending" && (
                    <div className="flex space-x-2 pt-2">
                      <Button
                        onClick={() => openNavigation(delivery.customerAddress)}
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs"
                      >
                        <Navigation className="h-3 w-3 mr-1" />
                        Navegar
                      </Button>
                      <Button
                        onClick={() => {
                          setSelectedDelivery(delivery);
                          setActionType("confirm");
                        }}
                        size="sm"
                        className="flex-1 bg-green-600 hover:bg-green-700 text-xs"
                      >
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Confirmar
                      </Button>
                      <Button
                        onClick={() => {
                          setSelectedDelivery(delivery);
                          setActionType("reject");
                        }}
                        variant="destructive"
                        size="sm"
                        className="flex-1 text-xs"
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Recusar
                      </Button>
                    </div>
                  )}

                  {delivery.status === "delivered" && delivery.deliveryTime && (
                    <div className="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 p-2 rounded">
                      Entregue em {formatDateTime(delivery.deliveryTime)}
                    </div>
                  )}

                  {delivery.status === "failed" && (
                    <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
                      {delivery.rejectionNotes || "Entrega recusada"}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Confirm Delivery Dialog */}
      <Dialog open={actionType === "confirm"} onOpenChange={() => setActionType(null)}>
        <DialogContent className="mx-4 max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar Entrega</DialogTitle>
            <DialogDescription>
              Tem certeza de que deseja confirmar a entrega para {selectedDelivery?.customerName}?
              Sua localização será registrada automaticamente.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setActionType(null)}
              className="w-full sm:w-auto"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmDelivery}
              disabled={gettingLocation || confirmDeliveryMutation.isPending}
              className="w-full sm:w-auto bg-green-600 hover:bg-green-700"
            >
              {gettingLocation ? "Obtendo localização..." : "Confirmar Entrega"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Delivery Dialog */}
      <Dialog open={actionType === "reject"} onOpenChange={() => setActionType(null)}>
        <DialogContent className="mx-4 max-w-md">
          <DialogHeader>
            <DialogTitle>Recusar Entrega</DialogTitle>
            <DialogDescription>
              Por que você não conseguiu fazer a entrega para {selectedDelivery?.customerName}?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Select value={rejectionReasonId} onValueChange={setRejectionReasonId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o motivo" />
                </SelectTrigger>
                <SelectContent>
                  {rejectionReasons.map((reason) => (
                    <SelectItem key={reason.id} value={reason.id}>
                      {reason.reason}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Textarea
                placeholder="Observações adicionais (opcional)"
                value={rejectionNotes}
                onChange={(e) => setRejectionNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setActionType(null);
                setRejectionReasonId("");
                setRejectionNotes("");
              }}
              className="w-full sm:w-auto"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleRejectDelivery}
              disabled={!rejectionReasonId || rejectDeliveryMutation.isPending}
              variant="destructive"
              className="w-full sm:w-auto"
            >
              Recusar Entrega
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}