import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Route, MapPin, Calendar, User, CheckCircle, Clock, AlertCircle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import type { DailyRouteResponse } from "@shared/schema";
import RouteMap from "@/components/RouteMap";

export default function RotaDoDia() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator';
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedSellerId, setSelectedSellerId] = useState(isAdmin ? '' : user?.id || '');

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
                  {formatInTimeZone(route.routeDate, 'America/Sao_Paulo', "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                </span>
                <Badge variant={route.routeStatus === 'completed' ? 'default' : 'secondary'}>
                  {route.routeStatus === 'completed' ? 'Concluída' : 'Em andamento'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              <div className="space-y-3">
                {route.visits?.map((visit, index) => (
                  <div
                    key={visit.customerId}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    data-testid={`visit-${visit.customerId}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center font-semibold">
                        {index + 1}
                      </div>
                      <div>
                        <p className="font-semibold text-gray-800 dark:text-white">
                          {visit.customerName}
                        </p>
                        <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {visit.customerAddress || 'Endereço não informado'}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      data-testid={`badge-status-${visit.customerId}`}
                    >
                      Pendente
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
