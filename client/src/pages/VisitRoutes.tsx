import { useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar, MapPin, Clock, User, Filter, Route, RefreshCw, CheckCircle, XCircle, MapPinIcon, Monitor, Phone, Video } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { optimizeRouteAdvanced, calculateTravelTime, type RouteLocation, type OptimizedRoute } from "@shared/routeOptimization";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface VisitAgenda {
  id: string;
  customerId: string;
  sellerId: string;
  sellerName?: string;
  scheduledDate: string;
  routeDay: string;
  recurrenceType: string;
  isVirtual: boolean;
  visitStatus: string;
  customerName: string;
  customerLatitude: string | null;
  customerLongitude: string | null;
  customerAddress: string | null;
  actualCheckIn: string | null;
  actualCheckOut: string | null;
  distanceToCustomer: string | null;
  salesCardId: string | null;
  createdAt: string;
}

interface VisitResponse {
  visits: VisitAgenda[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export default function VisitRoutes() {
  const { user } = useAuth();
  const { toast } = useToast();
  
  // Obter data de hoje no formato YYYY-MM-DD (timezone do Brasil)
  const getTodayBrazil = () => {
    const now = new Date();
    const brazilOffset = -3 * 60; // UTC-3 em minutos
    const localOffset = now.getTimezoneOffset();
    const brazilTime = new Date(now.getTime() + (localOffset + brazilOffset) * 60 * 1000);
    return brazilTime.toISOString().split('T')[0];
  };
  
  const [filters, setFilters] = useState({
    sellerId: 'all',
    startDate: getTodayBrazil(), // Inicializar com data de hoje
    endDate: getTodayBrazil(), // Inicializar com data de hoje
    routeDay: 'all',
    visitStatus: 'pending',
    page: 1
  });
  
  const [optimizedRoute, setOptimizedRoute] = useState<OptimizedRoute | null>(null);
  const [checkInLoading, setCheckInLoading] = useState<string | null>(null);
  const [checkOutLoading, setCheckOutLoading] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);

  // Função para obter localização do usuário
  const getCurrentLocation = (): Promise<{ latitude: number; longitude: number }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocalização não é suportada pelo navegador'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          };
          setUserLocation(coords);
          resolve(coords);
        },
        (error) => {
          reject(new Error('Erro ao obter localização: ' + error.message));
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000
        }
      );
    });
  };

  // Mutation para check-in
  const checkInMutation = useMutation({
    mutationFn: async ({ visitId, latitude, longitude }: { visitId: string; latitude: number; longitude: number }) => {
      return apiRequest('POST', `/api/visit-agenda/${visitId}/check-in`, { latitude, longitude });
    },
    onSuccess: (data) => {
      toast({
        title: "Check-in realizado!",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/visit-agenda'] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro no check-in",
        description: error.message || "Erro ao realizar check-in",
        variant: "destructive",
      });
    }
  });

  // Mutation para check-out
  const checkOutMutation = useMutation({
    mutationFn: async ({ visitId, latitude, longitude }: { visitId: string; latitude: number; longitude: number }) => {
      return apiRequest('POST', `/api/visit-agenda/${visitId}/check-out`, { latitude, longitude });
    },
    onSuccess: (data) => {
      toast({
        title: "Check-out realizado!",
        description: `${data.message} - Duração: ${data.visitDuration} minutos`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/visit-agenda'] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro no check-out",
        description: error.message || "Erro ao realizar check-out",
        variant: "destructive",
      });
    }
  });

  // Função para realizar check-in
  const handleCheckIn = async (visitId: string) => {
    try {
      setCheckInLoading(visitId);
      const location = await getCurrentLocation();
      checkInMutation.mutate({ visitId, latitude: location.latitude, longitude: location.longitude });
    } catch (error: any) {
      toast({
        title: "Erro de localização",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setCheckInLoading(null);
    }
  };

  // Função para realizar check-out
  const handleCheckOut = async (visitId: string) => {
    try {
      setCheckOutLoading(visitId);
      const location = await getCurrentLocation();
      checkOutMutation.mutate({ visitId, latitude: location.latitude, longitude: location.longitude });
    } catch (error: any) {
      toast({
        title: "Erro de localização",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setCheckOutLoading(null);
    }
  };

  // Query para buscar sellers (para o filtro de vendedor)
  const { data: sellers } = useQuery({
    queryKey: ['/api/users', { role: 'vendedor' }],
    queryFn: async () => await apiRequest('GET', '/api/users?role=vendedor'),
    enabled: !!user && ['admin', 'coordinator', 'administrative'].includes(user.role || '')
  });

  // Usar sales-cards ao invés de visit-agenda (mais direto e atualizado)
  const { data: salesCardsData, isLoading, refetch } = useQuery({
    queryKey: ['/api/sales-cards/by-date', filters.startDate, filters.sellerId],
    queryFn: async () => {
      if (!filters.startDate) return { cards: [] };
      
      const response = await fetch(`/api/sales-cards/by-date/${filters.startDate}${filters.sellerId !== 'all' ? `?sellerId=${filters.sellerId}` : ''}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Erro ao buscar cards de visita');
      return response.json();
    }
  });

  // Mapear sales cards para formato compatível com visits
  const visits = salesCardsData?.cards ? {
    visits: salesCardsData.cards.map((card: any) => ({
      id: card.id,
      customerId: card.customerId,
      sellerId: card.sellerId,
      sellerName: card.seller ? `${card.seller.firstName} ${card.seller.lastName}` : 'N/A',
      scheduledDate: card.scheduledDate,
      routeDay: card.routeDay,
      recurrenceType: card.recurrenceType,
      isVirtual: card.customer?.virtualService || false,
      visitStatus: card.status === 'completed' ? 'completed' : card.status === 'pending' ? 'pending' : 'missed',
      customerName: card.customer?.fantasyName || card.customer?.name || '',
      customerLatitude: card.customer?.latitude,
      customerLongitude: card.customer?.longitude,
      customerAddress: card.customer?.address,
      actualCheckIn: card.checkInTime,
      actualCheckOut: card.checkOutTime,
      distanceToCustomer: null,
      salesCardId: card.id,
      createdAt: card.createdAt
    })),
    pagination: {
      page: 1,
      pageSize: 50,
      total: salesCardsData.cards.length,
      totalPages: 1
    }
  } : { visits: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };

  // Função para formatar distâncias: < 1km mostra em metros, >= 1km mostra em km
  const formatDistance = (meters: number) => {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(1)}km`;
  };

  const generateAgenda = async () => {
    try {
      await apiRequest('POST', '/api/visit-agenda/generate');
      refetch();
      toast({
        title: "Agenda gerada com sucesso!",
        description: "As visitas foram criadas automaticamente.",
      });
    } catch (error) {
      console.error('Erro ao gerar agenda:', error);
      toast({
        title: "Erro ao gerar agenda",
        description: "Ocorreu um erro ao tentar gerar a agenda de visitas.",
        variant: "destructive",
      });
    }
  };

  const optimizeRoute = async () => {
    if (!filters.startDate) {
      toast({
        title: "Data obrigatória",
        description: "Selecione uma data específica para otimizar a rota.",
        variant: "destructive",
      });
      return;
    }

    // Verificar se vendedor tem coordenadas de casa configuradas
    if (user?.role === 'vendedor' && (!user.homeLatitude || !user.homeLongitude)) {
      toast({
        title: "Coordenadas não configuradas",
        description: "Configure suas coordenadas de casa no perfil para otimizar rotas.",
        variant: "destructive",
      });
      return;
    }

    setIsOptimizing(true);
    try {
      const targetSellerId = user?.role === 'vendedor' ? user.id : filters.sellerId;
      
      console.log('🔄 Iniciando otimização de rota:', {
        targetSellerId,
        date: filters.startDate,
        userRole: user?.role,
        userCoordinates: { lat: user?.homeLatitude, lng: user?.homeLongitude }
      });
      
      const response = await apiRequest('POST', '/api/visit-agenda/optimize-route', {
        sellerId: targetSellerId === 'all' ? undefined : targetSellerId,
        date: filters.startDate,
      });
      
      console.log('✅ Resposta da API:', response);

      setOptimizedRoute(response.optimizedRoute);
      
      // Verificar se existem visitas para mostrar métricas
      if (response.optimizedRoute && response.optimizedRoute.locations.length > 0) {
        toast({
          title: "Rota otimizada!",
          description: `${response.message}. Distância total: ${formatDistance(response.optimizedRoute.totalDistance)}, tempo estimado: ${Math.round(response.optimizedRoute.estimatedTotalTime / 60)}h`,
        });
      } else {
        toast({
          title: "Rota consultada",
          description: response.message || "Nenhuma visita encontrada para otimização nesta data.",
        });
      }
    } catch (error: any) {
      console.error('Erro ao otimizar rota:', error);
      
      // Tratar erro específico de coordenadas
      if (error.message && error.message.includes("Coordenadas de localização inicial são obrigatórias")) {
        toast({
          title: "Coordenadas não configuradas",
          description: "Configure suas coordenadas de casa no perfil para otimizar rotas.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Erro ao otimizar rota",
          description: error.message || "Ocorreu um erro ao tentar otimizar a rota.",
          variant: "destructive",
        });
      }
    } finally {
      setIsOptimizing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap = {
      'pending': { label: 'Pendente', variant: 'default' as const },
      'completed': { label: 'Concluída', variant: 'secondary' as const },
      'missed': { label: 'Perdida', variant: 'destructive' as const },
      'cancelled': { label: 'Cancelada', variant: 'outline' as const }
    };
    
    const statusInfo = statusMap[status as keyof typeof statusMap] || statusMap.pending;
    return <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>;
  };

  const getRecurrenceLabel = (type: string) => {
    const labels = {
      'semanal': 'Semanal',
      'quinzenal': 'Quinzenal', 
      'mensal': 'Mensal',
      'bimestral': 'Bimestral'
    };
    return labels[type as keyof typeof labels] || type;
  };

  const formatDate = (dateStr: string) => {
    return format(new Date(dateStr), "dd/MM/yyyy", { locale: ptBR });
  };

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return format(new Date(dateStr), "HH:mm", { locale: ptBR });
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
            <Route className="mr-2" />
            Rota de Visitas
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Gerencie e visualize a agenda de visitas {user?.role === 'vendedor' ? 'suas' : 'dos vendedores'}
          </p>
        </div>
        <div className="flex gap-2">
          {user?.role && ['admin', 'coordinator'].includes(user.role) && (
            <Button
              onClick={generateAgenda}
              className="bg-honest-blue hover:bg-blue-700"
              data-testid="button-generate-agenda"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Gerar Agenda
            </Button>
          )}
          <Button
            onClick={optimizeRoute}
            disabled={isOptimizing || !filters.startDate || (user?.role === 'vendedor' && (!user.homeLatitude || !user.homeLongitude))}
            variant="outline"
            className="border-honest-blue text-honest-blue hover:bg-honest-blue hover:text-white"
            data-testid="button-optimize-route"
          >
            {isOptimizing ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Route className="mr-2 h-4 w-4" />
            )}
            {isOptimizing ? 'Otimizando...' : 'Otimizar Rota'}
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Filter className="mr-2 h-4 w-4" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {user && ['admin', 'coordinator', 'administrative'].includes(user.role || '') && (
              <div>
                <label className="text-sm font-medium mb-1 block">Vendedor</label>
                <Select
                  value={filters.sellerId}
                  onValueChange={(value) => setFilters(prev => ({ ...prev, sellerId: value }))}
                >
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Todos os vendedores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {Array.isArray(sellers) && sellers.map((seller: any) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.firstName} {seller.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <label className="text-sm font-medium mb-1 block">Data Inicial</label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))}
                data-testid="input-start-date"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Data Final</label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))}
                data-testid="input-end-date"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Dia da Semana</label>
              <Select
                value={filters.routeDay}
                onValueChange={(value) => setFilters(prev => ({ ...prev, routeDay: value }))}
              >
                <SelectTrigger data-testid="select-route-day">
                  <SelectValue placeholder="Todos os dias" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os dias</SelectItem>
                  <SelectItem value="Seg">Segunda-feira</SelectItem>
                  <SelectItem value="Ter">Terça-feira</SelectItem>
                  <SelectItem value="Qua">Quarta-feira</SelectItem>
                  <SelectItem value="Qui">Quinta-feira</SelectItem>
                  <SelectItem value="Sex">Sexta-feira</SelectItem>
                  <SelectItem value="Sab">Sábado</SelectItem>
                  <SelectItem value="Dom">Domingo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Status</label>
              <Select
                value={filters.visitStatus}
                onValueChange={(value) => setFilters(prev => ({ ...prev, visitStatus: value }))}
              >
                <SelectTrigger data-testid="select-visit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="completed">Concluída</SelectItem>
                  <SelectItem value="missed">Perdida</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Rota Otimizada */}
      {optimizedRoute && (
        <Card className="mb-6 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800">
          <CardHeader>
            <CardTitle className="flex items-center text-green-800 dark:text-green-200">
              <Route className="mr-2 h-4 w-4" />
              Rota Otimizada
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {formatDistance(optimizedRoute.totalDistance)}
                </div>
                <div className="text-sm text-green-700 dark:text-green-300">Distância Total</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {Math.round(optimizedRoute.estimatedTotalTime / 60)}h {optimizedRoute.estimatedTotalTime % 60}min
                </div>
                <div className="text-sm text-green-700 dark:text-green-300">Tempo Estimado</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {optimizedRoute.locations.length}
                </div>
                <div className="text-sm text-green-700 dark:text-green-300">Visitas</div>
              </div>
            </div>
            
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4">
              <h4 className="font-semibold mb-3 text-gray-800 dark:text-white">Ordem da Rota:</h4>
              <div className="space-y-2">
                {optimizedRoute.locations.map((location, index) => (
                  <div key={location.id} className={`flex items-center justify-between p-2 rounded ${
                    location.isVirtual 
                      ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700' 
                      : 'bg-gray-50 dark:bg-gray-700'
                  }`}>
                    <div className="flex items-center">
                      <div className={`w-6 h-6 text-white rounded-full flex items-center justify-center text-xs font-bold mr-3 ${
                        location.isVirtual ? 'bg-blue-600' : 'bg-green-600'
                      }`}>
                        {index + 1}
                      </div>
                      <div className="flex items-center">
                        {location.isVirtual && (
                          <Monitor className="h-4 w-4 text-blue-600 mr-2" />
                        )}
                        <div>
                          <div className="font-medium text-gray-800 dark:text-white flex items-center">
                            {location.customerName}
                            {location.isVirtual && (
                              <Badge variant="outline" className="ml-2 text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600 dark:text-blue-400 text-xs">
                                Virtual
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-600 dark:text-gray-400">
                            {location.isVirtual ? 'Atendimento Virtual' : location.address}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {location.estimatedDuration}min
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => setOptimizedRoute(null)}
                  variant="outline"
                  size="sm"
                >
                  Fechar Rota
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de Visitas */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center">
              <Calendar className="mr-2 h-4 w-4" />
              Agenda de Visitas
            </span>
            {visits?.pagination && (
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {visits.pagination.total} visita(s) encontrada(s)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue"></div>
            </div>
          ) : !visits?.visits?.length ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <Calendar className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>Nenhuma visita encontrada com os filtros aplicados</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Vendedor</TableHead>
                    <TableHead>Endereço</TableHead>
                    <TableHead>Dia</TableHead>
                    <TableHead>Recorrência</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Check-in</TableHead>
                    <TableHead>Check-out</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visits.visits.map((visit) => (
                    <TableRow key={visit.id} data-testid={`visit-row-${visit.id}`}>
                      <TableCell className="font-medium">
                        {formatDate(visit.scheduledDate)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center">
                          <User className="mr-2 h-4 w-4 text-gray-400" />
                          {visit.customerName}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <User className="mr-1 h-3 w-3 text-blue-500" />
                          {visit.sellerName || 'N/A'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm text-gray-600">
                          <MapPin className="mr-1 h-3 w-3" />
                          {visit.customerAddress || 'Não informado'}
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{visit.routeDay}</TableCell>
                      <TableCell>{getRecurrenceLabel(visit.recurrenceType)}</TableCell>
                      <TableCell>{getStatusBadge(visit.visitStatus)}</TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <Clock className="mr-1 h-3 w-3" />
                          {formatTime(visit.actualCheckIn)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <Clock className="mr-1 h-3 w-3" />
                          {formatTime(visit.actualCheckOut)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {visit.isVirtual ? (
                          <Badge variant="outline" className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600 dark:text-blue-400">
                            <Monitor className="h-3 w-3 mr-1" />
                            Virtual
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-green-600 bg-green-50 dark:bg-green-900/20">
                            <MapPin className="h-3 w-3 mr-1" />
                            Presencial
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!visit.isVirtual && (
                          <div className="flex gap-2">
                            {!visit.actualCheckIn && visit.visitStatus === 'pending' && (
                              <Button
                                onClick={() => handleCheckIn(visit.id)}
                                disabled={checkInLoading === visit.id}
                                size="sm"
                                variant="outline"
                                className="text-green-600 hover:text-green-700 hover:bg-green-50"
                                data-testid={`button-checkin-${visit.id}`}
                              >
                                {checkInLoading === visit.id ? (
                                  <RefreshCw className="h-3 w-3 animate-spin" />
                                ) : (
                                  <MapPinIcon className="h-3 w-3" />
                                )}
                                Check-in
                              </Button>
                            )}
                            {visit.actualCheckIn && !visit.actualCheckOut && visit.visitStatus === 'in_progress' && (
                              <Button
                                onClick={() => handleCheckOut(visit.id)}
                                disabled={checkOutLoading === visit.id}
                                size="sm"
                                variant="outline"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                data-testid={`button-checkout-${visit.id}`}
                              >
                                {checkOutLoading === visit.id ? (
                                  <RefreshCw className="h-3 w-3 animate-spin" />
                                ) : (
                                  <CheckCircle className="h-3 w-3" />
                                )}
                                Check-out
                              </Button>
                            )}
                            {visit.actualCheckIn && visit.actualCheckOut && visit.visitStatus === 'completed' && (
                              <Badge variant="secondary" className="text-green-600">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Concluída
                              </Badge>
                            )}
                          </div>
                        )}
                        {visit.isVirtual && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 text-center">
                            Não requer check-in físico
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Paginação */}
          {visits?.pagination && visits.pagination.totalPages > 1 && (
            <div className="flex justify-center mt-6 space-x-2">
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === 1}
                onClick={() => setFilters(prev => ({ ...prev, page: prev.page - 1 }))}
                data-testid="button-prev-page"
              >
                Anterior
              </Button>
              <span className="flex items-center px-4 text-sm text-gray-600 dark:text-gray-400">
                Página {visits.pagination.page} de {visits.pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === visits.pagination.totalPages}
                onClick={() => setFilters(prev => ({ ...prev, page: prev.page + 1 }))}
                data-testid="button-next-page"
              >
                Próxima
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}