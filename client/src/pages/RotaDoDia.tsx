import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Route, MapPin, Calendar, User, CheckCircle, Clock, AlertCircle, Camera, Navigation, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import type { DailyRouteResponse } from "@shared/schema";
import RouteMap from "@/components/RouteMap";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import { calculateDistance, formatDistance, calculateRouteDistance } from "@/lib/geoUtils";

export default function RotaDoDia() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator';
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedSellerId, setSelectedSellerId] = useState(isAdmin ? '' : user?.id || '');
  const [selectedCard, setSelectedCard] = useState<any>(null);
  const [showCardModal, setShowCardModal] = useState(false);
  const [loadingCardId, setLoadingCardId] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);

  const { data: sellers } = useQuery<any[]>({
    queryKey: ['/api/users?role=vendedor'],
    enabled: isAdmin && !!user,
  });

  const { data: response, isLoading } = useQuery<DailyRouteResponse>({
    queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate],
    enabled: !!selectedSellerId && !!selectedDate,
  });

  const route = response?.route;

  const currentSeller = sellers?.find(s => s.id === selectedSellerId);

  const routeMetrics = useMemo(() => {
    if (!route || !route.sellerHome) return { plannedDistance: 0, executedDistance: 0, averageVisitTime: 0 };

    const plannedCoords: Array<{ lat: number; lng: number }> = [];
    const executedCoords: Array<{ lat: number; lng: number }> = [];

    plannedCoords.push({
      lat: route.sellerHome.latitude,
      lng: route.sellerHome.longitude
    });

    route.optimizedOrder?.forEach(customerId => {
      const visit = route.visits?.find(v => v.customerId === customerId);
      if (visit && visit.customerLatitude && visit.customerLongitude) {
        plannedCoords.push({
          lat: parseFloat(String(visit.customerLatitude)),
          lng: parseFloat(String(visit.customerLongitude))
        });
      }
    });

    plannedCoords.push({
      lat: route.sellerHome.latitude,
      lng: route.sellerHome.longitude
    });

    if (route.checkpoints && route.checkpoints.length > 0) {
      const checkIns = route.checkpoints
        .filter(cp => cp.checkpointType === 'check_in' && cp.latitude && cp.longitude)
        .sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
      
      checkIns.forEach(cp => {
        executedCoords.push({
          lat: parseFloat(cp.latitude),
          lng: parseFloat(cp.longitude)
        });
      });
    }

    // Calcular tempo médio de visita
    let totalVisitTime = 0;
    let visitCount = 0;

    route.visits?.forEach(visit => {
      const checkIn = route.checkpoints?.find(
        cp => cp.visitId === visit.id && cp.checkpointType === 'check_in'
      );
      const checkOut = route.checkpoints?.find(
        cp => cp.visitId === visit.id && cp.checkpointType === 'check_out'
      );

      if (checkIn) {
        let visitTimeMinutes = 0;
        
        if (checkOut) {
          // Visita completa: calcular diferença real
          const checkInTime = new Date(checkIn.checkpointTime).getTime();
          const checkOutTime = new Date(checkOut.checkpointTime).getTime();
          visitTimeMinutes = (checkOutTime - checkInTime) / (1000 * 60); // converter para minutos
        } else {
          // Apenas check-in: considerar 30 minutos
          visitTimeMinutes = 30;
        }

        totalVisitTime += visitTimeMinutes;
        visitCount++;
      }
    });

    const averageVisitTime = visitCount > 0 ? Math.round(totalVisitTime / visitCount) : 0;

    return {
      plannedDistance: calculateRouteDistance(plannedCoords),
      executedDistance: calculateRouteDistance(executedCoords),
      averageVisitTime
    };
  }, [route]);

  const handleVisitClick = async (customerId: string) => {
    try {
      setLoadingCardId(customerId);
      const response = await fetch(`/api/customers/${customerId}/sales-card/${selectedDate}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Falha ao buscar card de vendas');
      }
      
      const card = await response.json();
      setSelectedCard(card);
      setShowCardModal(true);
    } catch (error) {
      console.error('Erro ao abrir card de vendas:', error);
    } finally {
      setLoadingCardId(null);
    }
  };

  const handlePhotoClick = (photoUrl: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPhoto(photoUrl);
    setShowPhotoModal(true);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
          <Route className="h-8 w-8 text-green-600" />
          Rota do Dia
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Visualize e gerencie suas visitas programadas
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <label className="text-sm font-medium mb-2 block">
              <Calendar className="inline h-4 w-4 mr-2" />
              Data da Rota
            </label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full p-2 border rounded-md dark:bg-gray-800 dark:border-gray-700"
              data-testid="input-route-date"
            />
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardContent className="pt-6">
              <label className="text-sm font-medium mb-2 block">
                <User className="inline h-4 w-4 mr-2" />
                Vendedor
              </label>
              <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
                <SelectTrigger data-testid="select-seller">
                  <SelectValue placeholder="Selecione um vendedor" />
                </SelectTrigger>
                <SelectContent>
                  {sellers?.map((seller) => (
                    <SelectItem key={seller.id} value={seller.id}>
                      {seller.firstName} {seller.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        )}
      </div>

      {!selectedSellerId ? (
        <Card>
          <CardContent className="py-12 text-center">
            <User className="h-16 w-16 mx-auto text-gray-400 mb-4" />
            <p className="text-gray-600 dark:text-gray-400">
              Selecione um vendedor para visualizar a rota
            </p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-400">Carregando rota...</p>
          </CardContent>
        </Card>
      ) : !route || route.visits?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="h-16 w-16 mx-auto text-yellow-500 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Nenhuma rota encontrada</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Não há visitas programadas para esta data
            </p>
            {isAdmin && (
              <Button variant="default" data-testid="button-generate-route">
                <Route className="mr-2 h-4 w-4" />
                Gerar Rota
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>
                  {formatInTimeZone(new Date(selectedDate + 'T12:00:00.000Z'), 'America/Sao_Paulo', "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                </span>
                <Badge variant={route.routeStatus === 'completed' ? 'default' : 'secondary'}>
                  {route.routeStatus === 'completed' ? 'Concluída' : 'Em andamento'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-blue-100 dark:bg-blue-900 rounded-lg">
                    <MapPin className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Total de Visitas</p>
                    <p className="text-2xl font-bold">{route.totalVisits}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-green-100 dark:bg-green-900 rounded-lg">
                    <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Concluídas</p>
                    <p className="text-2xl font-bold">{route.completedVisits}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-yellow-100 dark:bg-yellow-900 rounded-lg">
                    <Clock className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Pendentes</p>
                    <p className="text-2xl font-bold">{route.totalVisits - route.completedVisits}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-indigo-100 dark:bg-indigo-900 rounded-lg">
                    <Clock className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Tempo Médio</p>
                    <p className="text-2xl font-bold">{routeMetrics.averageVisitTime} min</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-purple-100 dark:bg-purple-900 rounded-lg">
                    <Navigation className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Rota Planejada</p>
                    <p className="text-xl font-bold">{formatDistance(routeMetrics.plannedDistance)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-orange-100 dark:bg-orange-900 rounded-lg">
                    <Navigation className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Rota Executada</p>
                    <p className="text-xl font-bold">{formatDistance(routeMetrics.executedDistance)}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {route.sellerHome && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Mapa da Rota</CardTitle>
              </CardHeader>
              <CardContent>
                <RouteMap
                  homeLocation={route.sellerHome}
                  visits={(route.visits || []).map(visit => ({
                    ...visit,
                    customerLatitude: visit.customerLatitude != null ? String(visit.customerLatitude) : null,
                    customerLongitude: visit.customerLongitude != null ? String(visit.customerLongitude) : null,
                  }))}
                  optimizedOrder={route.optimizedOrder || []}
                  checkpoints={route.checkpoints || []}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Lista de Visitas</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {route.visits?.map((visit, index) => {
                  const checkInCheckpoint = route.checkpoints?.find(
                    cp => cp.visitId === visit.id && cp.checkpointType === 'check_in'
                  );
                  const checkOutCheckpoint = route.checkpoints?.find(
                    cp => cp.visitId === visit.id && cp.checkpointType === 'check_out'
                  );

                  const customerLat = parseFloat(String(visit.customerLatitude || 0));
                  const customerLng = parseFloat(String(visit.customerLongitude || 0));

                  let checkInDistance = null;
                  let checkOutDistance = null;
                  let checkInOffsite = false;
                  let checkOutOffsite = false;

                  if (checkInCheckpoint && checkInCheckpoint.latitude && checkInCheckpoint.longitude && customerLat && customerLng) {
                    checkInDistance = calculateDistance(
                      customerLat,
                      customerLng,
                      parseFloat(checkInCheckpoint.latitude),
                      parseFloat(checkInCheckpoint.longitude)
                    );
                    checkInOffsite = checkInDistance > 100;
                  }

                  if (checkOutCheckpoint && checkOutCheckpoint.latitude && checkOutCheckpoint.longitude && customerLat && customerLng) {
                    checkOutDistance = calculateDistance(
                      customerLat,
                      customerLng,
                      parseFloat(checkOutCheckpoint.latitude),
                      parseFloat(checkOutCheckpoint.longitude)
                    );
                    checkOutOffsite = checkOutDistance > 100;
                  }

                  const hasOffsite = checkInOffsite || checkOutOffsite;
                  const isCompleted = !!checkOutCheckpoint;
                  const isInProgress = !!checkInCheckpoint && !checkOutCheckpoint;

                  let statusColor = 'text-gray-600 dark:text-gray-400';
                  let borderColor = 'border-gray-200 dark:border-gray-700';
                  
                  if (hasOffsite) {
                    statusColor = 'text-red-600 dark:text-red-400';
                    borderColor = 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950';
                  } else if (isCompleted) {
                    statusColor = 'text-green-600 dark:text-green-400';
                    borderColor = 'border-green-200 dark:border-green-800';
                  } else if (isInProgress) {
                    statusColor = 'text-blue-600 dark:text-blue-400';
                    borderColor = 'border-blue-200 dark:border-blue-800';
                  }

                  return (
                    <div
                      key={visit.customerId}
                      onClick={() => handleVisitClick(visit.customerId)}
                      className={`p-3 border rounded-lg hover:shadow-md transition-all cursor-pointer ${borderColor}`}
                      data-testid={`visit-${visit.customerId}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1">
                          <div className={`flex-shrink-0 w-7 h-7 rounded-full text-white flex items-center justify-center text-sm font-semibold ${
                            hasOffsite ? 'bg-red-600' : isCompleted ? 'bg-green-600' : isInProgress ? 'bg-blue-600' : 'bg-gray-400'
                          }`}>
                            {index + 1}
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <p className={`font-semibold ${statusColor}`}>
                                {visit.customerName}
                              </p>
                              {checkInCheckpoint && checkInCheckpoint.photoUrl && (
                                <Camera 
                                  className="h-4 w-4 text-purple-500 cursor-pointer hover:text-purple-700 transition-colors" 
                                  data-testid={`camera-icon-${visit.customerId}`}
                                  onClick={(e) => handlePhotoClick(checkInCheckpoint.photoUrl!, e)}
                                />
                              )}
                            </div>
                            
                            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 mb-2">
                              <MapPin className="h-3 w-3" />
                              {visit.customerAddress || 'Endereço não informado'}
                            </p>

                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div>
                                <span className="text-gray-500">Check-in: </span>
                                {checkInCheckpoint ? (
                                  <span className={`font-medium ${checkInOffsite ? 'text-red-600' : statusColor}`} data-testid={`checkin-time-${visit.customerId}`}>
                                    {formatInTimeZone(checkInCheckpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                    {checkInOffsite && ` ⚠️ ${formatDistance(checkInDistance!)}`}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </div>
                              <div>
                                <span className="text-gray-500">Check-out: </span>
                                {checkOutCheckpoint ? (
                                  <span className={`font-medium ${checkOutOffsite ? 'text-red-600' : statusColor}`} data-testid={`checkout-time-${visit.customerId}`}>
                                    {formatInTimeZone(checkOutCheckpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                    {checkOutOffsite && ` ⚠️ ${formatDistance(checkOutDistance!)}`}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </div>
                            </div>

                            {hasOffsite && (
                              <div className="mt-2 text-xs text-red-600 dark:text-red-400 font-medium">
                                ⚠️ {checkInOffsite && 'Check-in fora do local'}{checkInOffsite && checkOutOffsite && ' | '}{checkOutOffsite && 'Check-out fora do local'}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {route.checkpoints && (() => {
                  const offsiteCheckIns = route.checkpoints.filter(
                    cp => cp.checkpointType === 'check_in' && cp.isOffRoute === true
                  );

                  if (offsiteCheckIns.length === 0) return null;

                  return (
                    <>
                      <div className="my-4 border-t-2 border-orange-300 dark:border-orange-700 pt-4">
                        <h3 className="text-sm font-semibold text-orange-600 dark:text-orange-400 mb-2 flex items-center gap-2">
                          <AlertCircle className="h-4 w-4" />
                          Check-ins Fora da Rota Planejada ({offsiteCheckIns.length})
                        </h3>
                      </div>

                      {offsiteCheckIns.map((checkpoint, index) => (
                        <div
                          key={checkpoint.id}
                          className="p-3 border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950 rounded-lg"
                          data-testid={`offsite-visit-${checkpoint.id}`}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-orange-600 text-white flex items-center justify-center text-sm font-semibold">
                              !
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="font-semibold text-orange-600 dark:text-orange-400">
                                  {checkpoint.customerName || 'Cliente não identificado'}
                                </p>
                                {checkpoint.photoUrl && (
                                  <Camera 
                                    className="h-4 w-4 text-purple-500 cursor-pointer hover:text-purple-700 transition-colors" 
                                    onClick={(e) => handlePhotoClick(checkpoint.photoUrl!, e)}
                                  />
                                )}
                              </div>
                              <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                                Check-in realizado fora da rota programada
                              </p>
                              <div className="text-xs">
                                <span className="text-gray-500">Horário: </span>
                                <span className="font-medium text-orange-600 dark:text-orange-400">
                                  {formatInTimeZone(checkpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {showCardModal && selectedCard && (
        <SalesCardDetailsModal
          isOpen={showCardModal}
          onClose={() => {
            setShowCardModal(false);
            setSelectedCard(null);
          }}
          card={selectedCard}
        />
      )}

      <Dialog open={showPhotoModal} onOpenChange={setShowPhotoModal}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Foto do Check-in</DialogTitle>
          </DialogHeader>
          <div className="relative">
            {selectedPhoto && (
              <img 
                src={selectedPhoto} 
                alt="Foto do check-in" 
                className="w-full h-auto rounded-lg"
                data-testid="checkin-photo"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
