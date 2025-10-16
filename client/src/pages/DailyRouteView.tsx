import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Route, MapPin, Clock, Navigation, Home, CheckCircle, 
  AlertTriangle, RefreshCw, ChevronRight, TrendingUp, Users
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import RouteMap from "@/components/RouteMap";

interface DailyRoute {
  id: string;
  sellerId: string;
  routeDate: string;
  optimizedOrder: string[];
  totalVisits: number;
  completedVisits: number;
  totalEstimatedDistance: string;
  totalActualDistance: string;
  status: string;
  visits: any[];
  checkpoints: any[];
  progress: {
    totalVisits: number;
    completedVisits: number;
    totalEstimatedDistance: number;
    totalActualDistance: number;
    percentComplete: number;
  };
}

export default function DailyRouteView() {
  const { user } = useAuth();
  const { toast } = useToast();
  
  // Estado para vendedor selecionado (admin pode escolher)
  const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');
  const [selectedSellerId, setSelectedSellerId] = useState<string>('');

  // Buscar lista de vendedores (apenas para admin)
  const { data: sellersData } = useQuery({
    queryKey: ['/api/users'],
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/users');
      return response;
    },
    enabled: isAdmin
  });

  const sellers = sellersData?.filter((u: any) => u.role === 'vendedor') || [];

  // Inicializar sellerId quando os vendedores forem carregados ou quando user mudar
  useEffect(() => {
    if (isAdmin && sellers.length > 0 && !selectedSellerId) {
      setSelectedSellerId(sellers[0].id);
    } else if (!isAdmin && user?.id && !selectedSellerId) {
      // Se for vendedor, usar seu próprio ID
      setSelectedSellerId(user.id);
    }
  }, [isAdmin, sellers, user?.id, selectedSellerId]);

  // Buscar dados do vendedor selecionado
  const { data: sellerData, isLoading: isLoadingSeller } = useQuery({
    queryKey: ['/api/users', selectedSellerId],
    queryFn: async () => {
      if (!selectedSellerId) return null;
      const response = await apiRequest('GET', `/api/users/${selectedSellerId}`);
      return response;
    },
    enabled: !!selectedSellerId && isAdmin
  });

  // Buscar rota do dia do vendedor selecionado
  const { data: routeData, isLoading, refetch } = useQuery({
    queryKey: ['/api/daily-routes', selectedSellerId, 'today'],
    queryFn: async () => {
      if (!selectedSellerId) return null;
      const response = await apiRequest('GET', `/api/daily-routes/${selectedSellerId}/today`);
      return response;
    },
    enabled: !!selectedSellerId
  });

  const route: DailyRoute | null = routeData?.route || null;

  // Mutation para gerar rota manualmente
  const generateRouteMutation = useMutation({
    mutationFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Formatar data apenas (YYYY-MM-DD) sem hora
      const dateStr = format(today, 'yyyy-MM-dd');
      
      const response = await apiRequest('POST', '/api/daily-routes/generate', {
        sellerId: selectedSellerId,
        date: dateStr
      });
      
      return response;
    },
    onSuccess: (data) => {
      if (data.alreadyExists) {
        toast({
          title: "Rota já existe",
          description: "A rota para hoje já foi gerada anteriormente.",
        });
      } else {
        toast({
          title: "Rota gerada com sucesso!",
          description: `Rota criada com ${data.totalVisits || 0} visitas.`,
        });
      }
      
      // Invalidar cache específico e geral para recarregar dados
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'today'] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao gerar rota",
        description: error.message || "Não foi possível gerar a rota.",
      });
    }
  });

  // Verificar se vendedor tem coordenadas configuradas
  // Para admin, usa os dados completos ou busca na lista de vendedores
  const currentSeller = isAdmin 
    ? (sellerData || sellers.find((s: any) => s.id === selectedSellerId))
    : user;
  const hasHomeCoordinates = currentSeller?.homeLatitude && currentSeller?.homeLongitude;

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(1)}km`;
  };

  const getVisitStatus = (visit: any) => {
    if (visit.actualCheckOut) return 'completed';
    if (visit.actualCheckIn) return 'in_progress';
    return 'pending';
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-600"><CheckCircle className="h-3 w-3 mr-1" />Concluída</Badge>;
      case 'in_progress':
        return <Badge className="bg-blue-600"><Clock className="h-3 w-3 mr-1" />Em andamento</Badge>;
      default:
        return <Badge variant="outline">Pendente</Badge>;
    }
  };

  if (!hasHomeCoordinates && selectedSellerId) {
    return (
      <div className="p-6">
        {isAdmin && sellers.length > 0 && (
          <div className="mb-6">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
              Selecionar Vendedor
            </label>
            <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
              <SelectTrigger className="w-full md:w-96">
                <SelectValue placeholder="Selecione um vendedor" />
              </SelectTrigger>
              <SelectContent>
                {sellers.map((seller: any) => (
                  <SelectItem key={seller.id} value={seller.id}>
                    <div className="flex items-center">
                      <Users className="h-4 w-4 mr-2" />
                      {seller.firstName} {seller.lastName || ''} ({seller.email})
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {isAdmin 
              ? `O vendedor ${currentSeller?.firstName || 'selecionado'} não tem coordenadas de casa configuradas.`
              : 'Configure suas coordenadas de casa no perfil para usar o sistema de roteirização.'
            }
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 flex justify-center items-center">
        <RefreshCw className="h-8 w-8 animate-spin text-honest-blue" />
      </div>
    );
  }

  if (!route) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
              <Route className="mr-2" />
              {isAdmin ? 'Rotas dos Vendedores' : 'Minha Rota do Dia'}
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Visualize e acompanhe {isAdmin ? 'as rotas dos vendedores' : 'sua rota otimizada'}
            </p>
          </div>
          {hasHomeCoordinates && (
            <Button
              onClick={() => generateRouteMutation.mutate()}
              disabled={generateRouteMutation.isPending || !selectedSellerId}
              data-testid="button-generate-route"
            >
              {generateRouteMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Gerando...
                </>
              ) : (
                <>
                  <Navigation className="mr-2 h-4 w-4" />
                  Gerar Rota
                </>
              )}
            </Button>
          )}
        </div>

        {isAdmin && sellers.length > 0 && (
          <div className="mb-6">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
              Selecionar Vendedor
            </label>
            <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
              <SelectTrigger className="w-full md:w-96" data-testid="select-seller">
                <SelectValue placeholder="Selecione um vendedor" />
              </SelectTrigger>
              <SelectContent>
                {sellers.map((seller: any) => (
                  <SelectItem key={seller.id} value={seller.id}>
                    <div className="flex items-center">
                      <Users className="h-4 w-4 mr-2" />
                      {seller.firstName} {seller.lastName || ''} ({seller.email})
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Card>
          <CardContent className="py-12 text-center">
            <Route className="h-16 w-16 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Nenhuma rota disponível para hoje</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-2">
              As rotas são geradas automaticamente pelo sistema todos os dias às 05:00h.
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-500">
              Certifique-se de ter visitas agendadas e coordenadas de casa configuradas.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
            <Route className="mr-2" />
            {isAdmin ? 'Rotas dos Vendedores' : 'Minha Rota do Dia'}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            {format(new Date(route.routeDate), "EEEE, dd 'de' MMMM", { locale: ptBR })}
            {isAdmin && currentSeller && ` - ${currentSeller.firstName} ${currentSeller.lastName || ''}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => generateRouteMutation.mutate()}
            disabled={generateRouteMutation.isPending || !selectedSellerId}
            variant="default"
            size="sm"
            data-testid="button-regenerate-route"
          >
            {generateRouteMutation.isPending ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Atualizando...
              </>
            ) : (
              <>
                <Navigation className="mr-2 h-4 w-4" />
                Atualizar Rota
              </>
            )}
          </Button>
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            data-testid="button-refresh-route"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Seletor de vendedor para admin */}
      {isAdmin && sellers.length > 0 && (
        <div className="mb-6">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
            Selecionar Vendedor
          </label>
          <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
            <SelectTrigger className="w-full md:w-96" data-testid="select-seller">
              <SelectValue placeholder="Selecione um vendedor" />
            </SelectTrigger>
            <SelectContent>
              {sellers.map((seller: any) => (
                <SelectItem key={seller.id} value={seller.id}>
                  <div className="flex items-center">
                    <Users className="h-4 w-4 mr-2" />
                    {seller.firstName} {seller.lastName || ''} ({seller.email})
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Estatísticas da Rota */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Progresso</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {route.progress.percentComplete}%
                </p>
              </div>
              <TrendingUp className="h-8 w-8 text-honest-blue" />
            </div>
            <Progress value={route.progress.percentComplete} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Visitas</p>
                <p className="text-2xl font-bold">
                  {route.progress.completedVisits}/{route.progress.totalVisits}
                </p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Dist. Estimada</p>
                <p className="text-2xl font-bold">
                  {formatDistance(route.progress.totalEstimatedDistance)}
                </p>
              </div>
              <MapPin className="h-8 w-8 text-purple-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Dist. Percorrida</p>
                <p className="text-2xl font-bold text-honest-blue">
                  {formatDistance(route.progress.totalActualDistance)}
                </p>
              </div>
              <Navigation className="h-8 w-8 text-honest-blue" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Mapa da Rota */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center">
            <MapPin className="mr-2 h-4 w-4" />
            Visualização da Rota
          </CardTitle>
        </CardHeader>
        <CardContent>
          {currentSeller?.homeLatitude && currentSeller?.homeLongitude && (
            <RouteMap
              homeLocation={{
                latitude: parseFloat(currentSeller.homeLatitude),
                longitude: parseFloat(currentSeller.homeLongitude)
              }}
              visits={route.visits || []}
              optimizedOrder={route.optimizedOrder || []}
              checkpoints={route.checkpoints || []}
            />
          )}
        </CardContent>
      </Card>

      {/* Lista de Visitas */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Navigation className="mr-2 h-4 w-4" />
            Rota Otimizada
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Início - Casa */}
          <div className="flex items-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg mb-2 border border-green-200 dark:border-green-800">
            <Home className="h-5 w-5 text-green-600 mr-3" />
            <div className="flex-1">
              <p className="font-semibold text-green-800 dark:text-green-200">
                Início - {isAdmin ? `Casa do ${currentSeller?.firstName}` : 'Sua Casa'}
              </p>
              <p className="text-sm text-green-700 dark:text-green-300">
                {currentSeller?.homeLatitude}, {currentSeller?.homeLongitude}
              </p>
            </div>
          </div>

          {/* Visitas */}
          <div className="space-y-2">
            {route.visits && route.visits.map((visit: any, index: number) => {
              const status = getVisitStatus(visit);
              const checkpoint = route.checkpoints?.find(cp => cp.visitId === visit.id);
              const segment = route.segments?.find((s: any) => s.visitId === visit.id);

              return (
                <div 
                  key={visit.id}
                  className={`flex items-start p-4 rounded-lg border ${
                    status === 'completed' 
                      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                      : status === 'in_progress'
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'
                  }`}
                  data-testid={`route-visit-${index}`}
                >
                  <div className="flex items-center mr-4">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                      status === 'completed' ? 'bg-green-600' : 
                      status === 'in_progress' ? 'bg-blue-600' : 
                      'bg-gray-400'
                    }`}>
                      {index + 1}
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-400 ml-2" />
                  </div>

                  <div className="flex-1">
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <h4 className="font-semibold text-gray-900 dark:text-white">
                          {visit.customerName}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {visit.customerAddress || 'Endereço não disponível'}
                        </p>
                      </div>
                      {getStatusBadge(status)}
                    </div>

                    {/* Distância estimada (sempre visível) */}
                    {segment && (
                      <div className="mt-2 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                        <div className="flex items-center text-sm font-medium text-blue-800 dark:text-blue-200">
                          <Navigation className="h-4 w-4 mr-2" />
                          <span className="text-xs text-blue-600 dark:text-blue-300 mr-2">
                            {segment.from} →
                          </span>
                          <span className="font-bold text-blue-900 dark:text-blue-100">
                            {formatDistance(segment.distance * 1000)}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Distância real (após check-in/out) */}
                    {checkpoint && (
                      <div className="mt-2 text-sm text-gray-600 dark:text-gray-400 space-y-1">
                        <div className="flex items-center">
                          <MapPin className="h-3 w-3 mr-1" />
                          Distância percorrida: {formatDistance(parseFloat(checkpoint.distanceFromPrevious || '0'))}
                        </div>
                        {checkpoint.timestamp && (
                          <div className="flex items-center">
                            <Clock className="h-3 w-3 mr-1" />
                            {format(new Date(checkpoint.timestamp), "HH:mm", { locale: ptBR })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Fim - Casa */}
          <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg mt-2 border border-green-200 dark:border-green-800">
            <div className="flex items-center">
              <Home className="h-5 w-5 text-green-600 mr-3" />
              <div className="flex-1">
                <p className="font-semibold text-green-800 dark:text-green-200">Retorno - Sua Casa</p>
                <p className="text-sm text-green-700 dark:text-green-300">Fim da rota</p>
              </div>
            </div>
            {/* Distância de retorno */}
            {route.segments && route.segments.find((s: any) => s.visitId === 'return') && (
              <div className="mt-2 px-3 py-2 bg-green-100 dark:bg-green-900/30 rounded-md">
                <div className="flex items-center text-sm font-medium text-green-800 dark:text-green-200">
                  <Navigation className="h-4 w-4 mr-2" />
                  <span className="text-xs text-green-600 dark:text-green-300 mr-2">
                    {route.segments.find((s: any) => s.visitId === 'return')?.from} → Casa:
                  </span>
                  <span className="font-bold text-green-900 dark:text-green-100">
                    {formatDistance(route.segments.find((s: any) => s.visitId === 'return')?.distance * 1000)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Informações Adicionais */}
      {route.checkpoints && route.checkpoints.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <Clock className="mr-2 h-4 w-4" />
              Histórico de Checkpoints
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {route.checkpoints.map((cp: any, index: number) => (
                <div key={cp.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <div className="flex items-center">
                    <div className="w-6 h-6 rounded-full bg-honest-blue text-white flex items-center justify-center text-xs font-bold mr-3">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">
                        {cp.checkpointType === 'check_in' ? 'Check-in' : 'Check-out'}
                      </p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {format(new Date(cp.timestamp), "HH:mm:ss", { locale: ptBR })}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {formatDistance(parseFloat(cp.distanceFromPrevious || '0'))}
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">do anterior</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
