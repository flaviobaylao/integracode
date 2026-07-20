import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Navigation, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";

interface MissingCoordinate {
  billingId: string;
  customerId: string;
  customerName: string;
  address: string;
  latitude: string;
  longitude: string;
}

interface MissingCoordinatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  missingCoordinates: MissingCoordinate[];
  onSuccess: () => void;
}

export default function MissingCoordinatesModal({
  isOpen,
  onClose,
  missingCoordinates,
  onSuccess,
}: MissingCoordinatesModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [coordinates, setCoordinates] = useState<Record<string, { lat: string; lng: string }>>(
    missingCoordinates.reduce((acc, item) => {
      acc[item.customerId] = {
        lat: item.latitude || '',
        lng: item.longitude || ''
      };
      return acc;
    }, {} as Record<string, { lat: string; lng: string }>)
  );
  const [capturingLocation, setCapturingLocation] = useState<string | null>(null);

  const updateCoordinatesMutation = useMutation({
    mutationFn: async () => {
      // Atualizar coordenadas de todos os clientes
      const updates = Object.entries(coordinates).map(([customerId, coords]) => {
        // Só atualizar se ambos lat e lng foram preenchidos
        if (coords.lat && coords.lng) {
          return apiRequest('PATCH', `/api/customers/${customerId}`, {
            latitude: coords.lat,
            longitude: coords.lng
          });
        }
        return Promise.resolve();
      });
      
      return Promise.all(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries'] });
      toast({
        title: "Coordenadas atualizadas!",
        description: "As coordenadas foram cadastradas com sucesso.",
      });
      onSuccess();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar coordenadas",
        description: error.message || "Ocorreu um erro ao salvar as coordenadas",
        variant: "destructive",
      });
    }
  });

  const handleCaptureLocation = (customerId: string) => {
    setCapturingLocation(customerId);
    
    if (!navigator.geolocation) {
      toast({
        title: "Geolocalização não disponível",
        description: "Seu navegador não suporta geolocalização",
        variant: "destructive",
      });
      setCapturingLocation(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates(prev => ({
          ...prev,
          [customerId]: {
            lat: position.coords.latitude.toString(),
            lng: position.coords.longitude.toString()
          }
        }));
        toast({
          title: "Localização capturada!",
          description: "Coordenadas GPS obtidas com sucesso",
        });
        setCapturingLocation(null);
      },
      (error) => {
        toast({
          title: "Erro ao capturar localização",
          description: error.message || "Não foi possível obter sua localização",
          variant: "destructive",
        });
        setCapturingLocation(null);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  const handleOpenWaze = (address: string) => {
    const wazeUrl = `https://www.waze.com/ul?q=${encodeURIComponent(address)}`;
    window.open(wazeUrl, '_blank');
  };

  const handleUpdateCoord = (customerId: string, field: 'lat' | 'lng', value: string) => {
    setCoordinates(prev => ({
      ...prev,
      [customerId]: {
        ...prev[customerId],
        [field]: value
      }
    }));
  };

  const handleSubmit = () => {
    // Verificar se todas as coordenadas foram preenchidas
    const missingFields = missingCoordinates.filter(item => {
      const coords = coordinates[item.customerId];
      return !coords || !coords.lat || !coords.lng;
    });

    if (missingFields.length > 0) {
      toast({
        title: "Campos obrigatórios",
        description: `Por favor, preencha as coordenadas de todos os clientes (${missingFields.length} faltando)`,
        variant: "destructive",
      });
      return;
    }

    updateCoordinatesMutation.mutate();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-orange-500" />
            Cadastrar Coordenadas GPS
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-2">
            {missingCoordinates.length} {missingCoordinates.length === 1 ? 'cliente não possui' : 'clientes não possuem'} coordenadas cadastradas.
            Preencha as coordenadas abaixo para continuar com o planejamento de rota.
          </p>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {missingCoordinates.map((item) => {
            const coords = coordinates[item.customerId] || { lat: '', lng: '' };
            const isCapturing = capturingLocation === item.customerId;
            
            return (
              <Card key={item.customerId}>
                <CardContent className="pt-6">
                  <div className="space-y-4">
                    {/* Nome e Endereço */}
                    <div>
                      <h3 className="font-semibold text-lg">{item.customerName}</h3>
                      <p className="text-sm text-muted-foreground">{item.address || 'Endereço não cadastrado'}</p>
                    </div>

                    {/* Ações de captura */}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleCaptureLocation(item.customerId)}
                        disabled={isCapturing}
                        data-testid={`button-capture-location-${item.customerId}`}
                      >
                        {isCapturing ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Capturando...
                          </>
                        ) : (
                          <>
                            <Navigation className="h-4 w-4 mr-2" />
                            Capturar Localização Atual
                          </>
                        )}
                      </Button>
                      
                      {item.address && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleOpenWaze(item.address)}
                          data-testid={`button-open-waze-${item.customerId}`}
                        >
                          Abrir no Waze
                        </Button>
                      )}
                    </div>

                    {/* Campos de coordenadas */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor={`lat-${item.customerId}`}>Latitude *</Label>
                        <Input
                          id={`lat-${item.customerId}`}
                          type="text"
                          placeholder="-16.123456"
                          value={coords.lat}
                          onChange={(e) => handleUpdateCoord(item.customerId, 'lat', e.target.value)}
                          onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); setCoordinates(prev => ({ ...prev, [item.customerId]: { lat: p[1], lng: p[2] } })); } }}
                          data-testid={`input-latitude-${item.customerId}`}
                        />
                      </div>
                      <div>
                        <Label htmlFor={`lng-${item.customerId}`}>Longitude *</Label>
                        <Input
                          id={`lng-${item.customerId}`}
                          type="text"
                          placeholder="-49.123456"
                          value={coords.lng}
                          onChange={(e) => handleUpdateCoord(item.customerId, 'lng', e.target.value)}
                          onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); setCoordinates(prev => ({ ...prev, [item.customerId]: { lat: p[1], lng: p[2] } })); } }}
                          data-testid={`input-longitude-${item.customerId}`}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={updateCoordinatesMutation.isPending}
            data-testid="button-cancel-coordinates"
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={updateCoordinatesMutation.isPending}
            data-testid="button-save-coordinates"
          >
            {updateCoordinatesMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Salvando...
              </>
            ) : (
              'Salvar e Planejar Rota'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
