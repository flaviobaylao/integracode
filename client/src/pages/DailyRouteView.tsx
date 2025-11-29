console.log('🚀 DailyRouteView CARREGADO - Versão: 2025-11-12 12:34');

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogPortal, DialogOverlay } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { 
  Route, MapPin, Clock, Navigation, Home, CheckCircle, Phone,
  AlertTriangle, RefreshCw, ChevronRight, TrendingUp, Users, Calendar, Camera, X, Download, Trash2
} from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import RouteMap from "@/components/RouteMap";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SalesCardModal from "@/components/SalesCardModal";
import type { SalesCardWithRelations } from "@shared/schema";

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
  segments?: Array<{
    visitId: string;
    from: string;
    to: string;
    distance: number;
  }>;
  progress: {
    totalVisits: number;
    completedVisits: number;
    totalEstimatedDistance: number;
    totalActualDistance: number;
    percentComplete: number;
  };
}

// Função para calcular distância entre duas coordenadas usando Haversine
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distância em metros
}

export default function DailyRouteView() {
  const { user } = useAuth();
  const { toast } = useToast();
  
  // Estado para vendedor selecionado (admin pode escolher)
  const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');
  const [selectedSellerId, setSelectedSellerId] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  
  // Estado para modal de detalhes do card
  const [selectedCard, setSelectedCard] = useState<SalesCardWithRelations | null>(null);
  const [showCardModal, setShowCardModal] = useState(false);
  
  // Estado para modal de edição do card
  const [editingCard, setEditingCard] = useState<SalesCardWithRelations | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  
  // Estado para modal de foto
  const [selectedPhoto, setSelectedPhoto] = useState<{
    url: string;
    customerName: string;
    checkInTime: string;
    latitude: string;
    longitude: string;
  } | null>(null);
  
  // Estado para confirmação de exclusão
  const [deleteVisit, setDeleteVisit] = useState<{
    visitId: string;
    customerName: string;
  } | null>(null);
  
  // Estado para modal de adicionar cliente
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');

  // Estado para ordem otimizada local (sem salvar no banco)
  const [localOptimizedOrder, setLocalOptimizedOrder] = useState<string[] | null>(null);
  
  // Estado para distância estimada local após re-otimização
  const [localEstimatedDistance, setLocalEstimatedDistance] = useState<number | null>(null);

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

  // DEBUG: Log sellers data
  useEffect(() => {
    if (sellers.length > 0) {
      console.log('🔍 [DEBUG] Sellers loaded:', sellers.map((s: any) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })));
    }
  }, [sellers]);

  // Inicializar sellerId quando os vendedores forem carregados ou quando user mudar
  useEffect(() => {
    console.log('🔍 [EFFECT] Executando useEffect:', { 
      isAdmin, 
      sellersLength: sellers.length, 
      selectedSellerId, 
      userId: user?.id,
      userRole: user?.role 
    });
    
    if (isAdmin && sellers.length > 0 && !selectedSellerId) {
      console.log('✅ [EFFECT] Setando primeiro vendedor:', sellers[0].id);
      setSelectedSellerId(sellers[0].id);
    } else if (!isAdmin && user?.id && !selectedSellerId) {
      // Se for vendedor, usar seu próprio ID
      console.log('✅ [EFFECT] Setando user ID:', user.id);
      setSelectedSellerId(user.id);
    } else {
      console.log('❌ [EFFECT] Nenhuma condição atendida!');
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

  // Buscar rota do vendedor selecionado para a data escolhida
  const { data: routeData, isLoading, refetch } = useQuery({
    queryKey: ['/api/daily-routes', selectedSellerId, selectedDate],
    queryFn: async () => {
      console.log('🔍 [QUERY] Buscando rota:', { selectedSellerId, selectedDate });
      if (!selectedSellerId || !selectedDate) {
        console.log('⚠️ [QUERY] Valores vazios, retornando null');
        return null;
      }
      // Adicionar timestamp para quebrar cache do navegador
      const cacheBuster = Date.now();
      const url = `/api/daily-routes/${selectedSellerId}/date/${selectedDate}?t=${cacheBuster}`;
      console.log('🌐 [QUERY] URL:', url);
      const response = await apiRequest('GET', url);
      console.log('✅ [QUERY] Resposta:', response);
      return response;
    },
    enabled: !!selectedSellerId && !!selectedDate,
    staleTime: 0, // Sempre considerar dados como stale para forçar refetch
    gcTime: 0, // Não cachear no React Query (TanStack Query v5)
  });
  
  // Log debug
  console.log('🔍 [STATE] selectedSellerId:', selectedSellerId, 'selectedDate:', selectedDate, 'enabled:', !!selectedSellerId && !!selectedDate);

  const route: DailyRoute | null = routeData?.route || null;

  // Limpar otimização local quando a rota mudar (vendedor, data, ou rota regenerada)
  useEffect(() => {
    setLocalOptimizedOrder(null);
    setLocalEstimatedDistance(null);
  }, [selectedSellerId, selectedDate, route?.id]);

  // Usar ordem otimizada local se existir, senão usar a ordem do banco
  const effectiveOptimizedOrder = localOptimizedOrder || route?.optimizedOrder || [];
  
  // Reordenar visitas de acordo com a ordem efetiva
  // optimizedOrder contém customer IDs, não visit IDs
  const orderedVisits = route?.visits && effectiveOptimizedOrder.length > 0
    ? effectiveOptimizedOrder
        .map(id => route.visits.find((v: any) => v.customerId === id))
        .filter(Boolean)
    : route?.visits || [];

  // Buscar clientes sem coordenadas para a data selecionada
  const { data: missingCoordsData } = useQuery({
    queryKey: ['/api/daily-routes', selectedSellerId, selectedDate, 'missing-coordinates'],
    queryFn: async () => {
      if (!selectedSellerId || !selectedDate) return null;
      
      const response = await fetch(`/api/daily-routes/${selectedSellerId}/date/${selectedDate}/missing-coordinates`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Falha ao buscar clientes sem coordenadas');
      }
      
      return response.json();
    },
    enabled: !!selectedSellerId && !!selectedDate
  });

  const missingCoordinates = missingCoordsData?.customers || [];
  const hasMissingCoordinates = missingCoordinates.length > 0;

  // Mutation para validar visita off-route
  const validateVisitMutation = useMutation({
    mutationFn: async (checkpointId: string) => {
      return await apiRequest('POST', `/api/daily-routes/checkpoints/${checkpointId}/validate`);
    },
    onSuccess: () => {
      toast({
        title: "Visita validada!",
        description: "A visita foi validada e incluída no cálculo de distância.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, selectedDate] });
    }
  });

  // Mutation para cancelar visita off-route
  const cancelVisitMutation = useMutation({
    mutationFn: async (checkpointId: string) => {
      return await apiRequest('POST', `/api/daily-routes/checkpoints/${checkpointId}/cancel`);
    },
    onSuccess: () => {
      toast({
        title: "Visita cancelada",
        description: "A visita foi cancelada e removida do cálculo de distância.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, selectedDate] });
    }
  });

  // Mutation para gerar rota manualmente
  const generateRouteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/daily-routes/generate', {
        sellerId: selectedSellerId,
        date: selectedDate
      });
      
      return response;
    },
    onSuccess: (data) => {
      // Limpar otimizações locais ao regenerar rota
      setLocalOptimizedOrder(null);
      setLocalEstimatedDistance(null);
      
      if (data.regenerated) {
        toast({
          title: "Rota atualizada com sucesso!",
          description: `Rota regenerada com ${data.totalVisits || 0} visitas.`,
        });
      } else {
        toast({
          title: "Rota gerada com sucesso!",
          description: `Rota criada com ${data.totalVisits || 0} visitas.`,
        });
      }
      
      // Invalidar cache específico e geral para recarregar dados
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, selectedDate] });
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

  // Mutation para remover visita da rota
  const removeVisitMutation = useMutation({
    mutationFn: async ({ routeId, visitId }: { routeId: string; visitId: string }) => {
      return await apiRequest('DELETE', `/api/daily-routes/${routeId}/visits/${visitId}`);
    },
    onSuccess: (data) => {
      toast({
        title: "Visita removida!",
        description: "A visita foi removida da rota com sucesso.",
      });
      setDeleteVisit(null);
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao remover visita",
        description: error.message || "Não foi possível remover a visita da rota.",
      });
    }
  });

  // Buscar todos os clientes (para modal de adicionar à rota)
  const { data: customersData } = useQuery({
    queryKey: ['/api/customers'],
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/customers');
      return response;
    },
    enabled: showAddCustomerModal && isAdmin
  });

  const allCustomers = customersData || [];

  // Filtrar clientes pela busca
  const filteredCustomers = allCustomers.filter((customer: any) => {
    const searchLower = customerSearchQuery.toLowerCase();
    const fantasyName = (customer.fantasyName || '').toLowerCase();
    const name = (customer.name || '').toLowerCase();
    const cpfCnpj = (customer.cpf || customer.cnpj || '').toLowerCase();
    
    return fantasyName.includes(searchLower) || 
           name.includes(searchLower) || 
           cpfCnpj.includes(searchLower);
  });

  // Mutation para adicionar cliente à rota
  const addCustomerToRouteMutation = useMutation({
    mutationFn: async (customerId: string) => {
      if (!route?.id) throw new Error('Rota não encontrada');
      return await apiRequest('POST', `/api/daily-routes/${route.id}/visits`, { customerId });
    },
    onSuccess: (data) => {
      toast({
        title: "Cliente adicionado!",
        description: `${data.customer.name} foi adicionado à rota com sucesso.`,
      });
      setShowAddCustomerModal(false);
      setCustomerSearchQuery('');
      setLocalOptimizedOrder(null); // Limpar otimização local ao adicionar cliente
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao adicionar cliente",
        description: error.message || "Não foi possível adicionar o cliente à rota.",
      });
    }
  });

  // Mutation para re-otimizar rota localmente (sem salvar)
  const reoptimizeRouteMutation = useMutation({
    mutationFn: async () => {
      if (!route?.id) throw new Error('Rota não encontrada');
      return await apiRequest('POST', `/api/daily-routes/${route.id}/optimize-preview`);
    },
    onSuccess: (data) => {
      setLocalOptimizedOrder(data.optimizedOrder);
      // Armazenar distância em metros (backend retorna em km)
      const distanceKm = parseFloat(data.totalDistance);
      if (!isNaN(distanceKm) && distanceKm > 0) {
        setLocalEstimatedDistance(Math.round(distanceKm * 1000));
      }
      toast({
        title: "Rota re-otimizada!",
        description: `Nova ordem calculada com ${data.totalVisits} visitas e ${data.totalDistance}km estimados. Esta otimização é temporária e não foi salva.`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao re-otimizar rota",
        description: error.message || "Não foi possível re-otimizar a rota.",
      });
    }
  });

  // Verificar se vendedor tem coordenadas configuradas
  // Para admin, usa os dados completos ou busca na lista de vendedores
  const currentSeller = isAdmin 
    ? (sellerData || sellers.find((s: any) => s.id === selectedSellerId))
    : user;
  const hasHomeCoordinates = currentSeller?.homeLatitude && currentSeller?.homeLongitude;

  // Função para abrir detalhes do card de vendas (suporta customers e leads)
  const handleOpenCardDetails = async (visitId: string) => {
    try {
      // Extrair entityId do visitId (suporta "customer:123:ts", "lead:456:ts" e "123")
      let entityId = visitId;
      let visitType: 'customer' | 'lead' = 'customer';
      
      if (visitId.includes(':')) {
        const parts = visitId.split(':');
        visitType = parts[0] as 'customer' | 'lead'; // customer ou lead
        entityId = parts[1]; // 123
      }
      
      console.log(`🔍 [CARD-DETAILS] Abrindo card para ${visitType} ${entityId} (visitId: ${visitId})`);
      
      // Buscar sales_cards da data da rota filtrados por esta entidade
      const routeDate = route?.routeDate || selectedDate;
      const response = await apiRequest('GET', `/api/sales-cards/by-date/${routeDate}`);
      
      if (!response || !response.cards) {
        throw new Error('Nenhum card encontrado para esta data');
      }
      
      // Filtrar pelo entityId (customerId para customers, customerId contendo leadId para leads)
      const card = response.cards.find((c: any) => c.customerId === entityId);
      
      if (!card) {
        toast({
          variant: "destructive",
          title: "Card não encontrado",
          description: `Não há card de vendas para ${visitType === 'lead' ? 'este lead' : 'este cliente'} na data selecionada.`,
        });
        return;
      }
      
      setSelectedCard(card);
      setShowCardModal(true);
    } catch (error: any) {
      console.error('Erro ao carregar card:', error);
      toast({
        variant: "destructive",
        title: "Erro ao carregar card",
        description: error.message || "Não foi possível carregar os detalhes do card.",
      });
    }
  };

  // Função para abrir modal de edição do card (suporta customers e leads)
  const handleEditCard = async (visitId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevenir que abra o modal de detalhes
    try {
      // Extrair entityId do visitId (suporta "customer:123:ts", "lead:456:ts" e "123")
      let entityId = visitId;
      let visitType: 'customer' | 'lead' = 'customer';
      
      if (visitId.includes(':')) {
        const parts = visitId.split(':');
        visitType = parts[0] as 'customer' | 'lead'; // customer ou lead
        entityId = parts[1]; // 123
      }
      
      console.log(`✏️ [CARD-EDIT] Editando card para ${visitType} ${entityId} (visitId: ${visitId})`);
      
      // Buscar sales_cards da data da rota filtrados por esta entidade
      const routeDate = route?.routeDate || selectedDate;
      const response = await apiRequest('GET', `/api/sales-cards/by-date/${routeDate}`);
      
      if (!response || !response.cards) {
        throw new Error('Nenhum card encontrado para esta data');
      }
      
      // Filtrar pelo entityId (customerId para customers, customerId contendo leadId para leads)
      const card = response.cards.find((c: any) => c.customerId === entityId);
      
      if (!card) {
        toast({
          variant: "destructive",
          title: "Card não encontrado",
          description: `Não há card de vendas para ${visitType === 'lead' ? 'este lead' : 'este cliente'} na data selecionada.`,
        });
        return;
      }
      
      setEditingCard(card);
      setShowEditModal(true);
    } catch (error: any) {
      console.error('Erro ao carregar card:', error);
      toast({
        variant: "destructive",
        title: "Erro ao carregar card",
        description: error.message || "Não foi possível carregar os detalhes do card.",
      });
    }
  };

  // Função para abrir modal de foto
  const handleOpenPhoto = (visit: any) => {
    if (!visit.checkInPhotoUrl) return;
    
    setSelectedPhoto({
      url: visit.checkInPhotoUrl,
      customerName: visit.customerName,
      checkInTime: visit.actualCheckIn || new Date().toISOString(), // Fallback para timestamp atual
      latitude: visit.checkInLatitude || '',
      longitude: visit.checkInLongitude || ''
    });
  };

  // Função para baixar foto
  const downloadPhoto = (photoUrl: string, customerName: string, checkInTime: string) => {
    const link = document.createElement('a');
    link.href = photoUrl;
    link.download = `checkin-${customerName}-${format(new Date(checkInTime), 'yyyy-MM-dd-HHmm')}.jpg`;
    link.click();
  };

  const formatDistance = (meters: number) => {
    // Os valores vêm em METROS do backend
    if (meters < 1000) return `${Math.round(meters)}m`; // Menos de 1km mostra em metros
    return `${(meters / 1000).toFixed(1)}km`; // Converte para km
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
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">Rota do Dia</h2>
          <BackToDashboardButton />
        </div>
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
          <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="select-seller">Selecionar Vendedor</Label>
              <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
                <SelectTrigger className="w-full" data-testid="select-seller">
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
            <div>
              <Label htmlFor="select-date">Data</Label>
              <Input
                id="select-date"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full"
                data-testid="input-date"
              />
            </div>
          </div>
        )}

        {hasMissingCoordinates && (
          <Alert className="mb-6 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-700">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500" />
            <AlertDescription className="text-yellow-800 dark:text-yellow-200">
              <div className="flex items-center justify-between">
                <div>
                  <strong>{missingCoordinates.length} cliente(s)</strong> sem coordenadas GPS para esta data.
                  <p className="text-sm mt-1">Adicione as coordenadas e clique em "Gerar Rota" para incluí-los na rota.</p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                {missingCoordinates.map((customer: any) => (
                  <div key={customer.customerId} className="bg-white dark:bg-gray-800 p-3 rounded-md border border-yellow-200 dark:border-yellow-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{customer.customerName}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{customer.cpfCnpj}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{customer.address}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          // Redirecionar para a página de edição do cliente
                          window.location.href = `/customers/${customer.customerId}`;
                        }}
                        data-testid={`button-edit-coords-${customer.customerId}`}
                      >
                        <MapPin className="h-4 w-4 mr-1" />
                        Adicionar Coordenadas
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardContent className="py-12 text-center">
            <Route className="h-16 w-16 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Nenhuma rota disponível para esta data</h3>
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
            {formatInTimeZone(route.routeDate, 'America/Sao_Paulo', "EEEE, dd 'de' MMMM", { locale: ptBR })}
            {isAdmin && currentSeller && ` - ${currentSeller.firstName} ${currentSeller.lastName || ''}`}
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && route && (
            <Button
              onClick={() => setShowAddCustomerModal(true)}
              variant="default"
              size="sm"
              data-testid="button-add-customer-to-route"
            >
              <Users className="mr-2 h-4 w-4" />
              Adicionar Cliente
            </Button>
          )}
          {route && route.optimizedOrder && route.optimizedOrder.length > 0 && (
            <Button
              onClick={() => reoptimizeRouteMutation.mutate()}
              disabled={reoptimizeRouteMutation.isPending}
              variant="secondary"
              size="sm"
              data-testid="button-reoptimize-route"
            >
              {reoptimizeRouteMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Re-otimizando...
                </>
              ) : (
                <>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  {localOptimizedOrder ? 'Otimizado ✓' : 'Re-otimizar Rota'}
                </>
              )}
            </Button>
          )}
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

      {/* Seletores de vendedor e data para admin */}
      {isAdmin && sellers.length > 0 && (
        <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="select-seller-main">Selecionar Vendedor</Label>
            <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
              <SelectTrigger className="w-full" data-testid="select-seller">
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
          <div>
            <Label htmlFor="select-date-main">Data</Label>
            <Input
              id="select-date-main"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full"
              data-testid="input-date"
            />
          </div>
        </div>
      )}

      {hasMissingCoordinates && (
        <Alert className="mb-6 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-700">
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500" />
          <AlertDescription className="text-yellow-800 dark:text-yellow-200">
            <div className="flex items-center justify-between">
              <div>
                <strong>{missingCoordinates.length} cliente(s)</strong> sem coordenadas GPS para esta data.
                <p className="text-sm mt-1">Adicione as coordenadas e clique em "Gerar Rota" para incluí-los na rota.</p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {missingCoordinates.map((customer: any) => (
                <div key={customer.customerId} className="bg-white dark:bg-gray-800 p-3 rounded-md border border-yellow-200 dark:border-yellow-800">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{customer.customerName}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{customer.cpfCnpj}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{customer.address}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // Redirecionar para a página de edição do cliente
                        window.location.href = `/customers/${customer.customerId}`;
                      }}
                      data-testid={`button-edit-coords-${customer.customerId}`}
                    >
                      <MapPin className="h-4 w-4 mr-1" />
                      Adicionar Coordenadas
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </AlertDescription>
        </Alert>
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
                  {formatDistance(localEstimatedDistance ?? route.progress.totalEstimatedDistance)}
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
              visits={orderedVisits}
              optimizedOrder={effectiveOptimizedOrder}
              checkpoints={route.checkpoints || []}
              onPhotoClick={(photoData) => setSelectedPhoto(photoData)}
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
            {(!orderedVisits || orderedVisits.length === 0) && (
              <div className="p-6 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 text-center">
                <Users className="h-12 w-12 mx-auto text-blue-400 mb-3" />
                <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2">
                  Rota Vazia
                </h3>
                <p className="text-sm text-blue-700 dark:text-blue-300 mb-4">
                  Esta rota não possui visitas programadas. {isAdmin ? 'Use o botão "Adicionar Cliente" acima para adicionar clientes manualmente.' : 'Entre em contato com seu gerente para adicionar clientes.'}
                </p>
                {isAdmin && (
                  <Button
                    onClick={() => setShowAddCustomerModal(true)}
                    variant="default"
                    size="sm"
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-add-first-customer"
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Adicionar Primeiro Cliente
                  </Button>
                )}
              </div>
            )}
            {orderedVisits && orderedVisits.map((visit: any, index: number) => {
              const status = getVisitStatus(visit);
              const checkpoint = route.checkpoints?.find(cp => cp.visitId === visit.id);
              const segment = route.segments?.find((s: any) => s.visitId === visit.id);

              return (
                <div 
                  key={visit.id}
                  onClick={() => handleOpenCardDetails(visit.id)}
                  className={`flex items-start p-4 rounded-lg border cursor-pointer transition-all hover:shadow-md ${
                    status === 'completed' 
                      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30'
                      : status === 'in_progress'
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30'
                      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
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
                      <div className="flex-1">
                        <h4 className="font-semibold text-gray-900 dark:text-white">
                          {visit.customerName}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {visit.customerAddress || 'Endereço não disponível'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 ml-2">
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-red-500 hover:bg-red-600 text-white border-red-600"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteVisit({
                                visitId: visit.id,
                                customerName: visit.customerName
                              });
                            }}
                            data-testid={`button-delete-${index}`}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            Excluir
                          </Button>
                        )}
                        {visit.checkInPhotoUrl && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-purple-500 hover:bg-purple-600 text-white border-purple-600"
                            onClick={(e) => {
                              e.stopPropagation(); // Prevenir que abra o modal ao clicar
                              handleOpenPhoto(visit);
                            }}
                            data-testid={`button-photo-${index}`}
                          >
                            <Camera className="h-4 w-4 mr-1" />
                            Foto
                          </Button>
                        )}
                        {visit.customerLatitude && visit.customerLongitude && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="bg-blue-500 hover:bg-blue-600 text-white border-blue-600"
                            onClick={(e) => {
                              e.stopPropagation(); // Prevenir que abra o modal ao clicar no Waze
                              const wazeUrl = `https://waze.com/ul?ll=${visit.customerLatitude},${visit.customerLongitude}&navigate=yes`;
                              window.open(wazeUrl, '_blank');
                            }}
                            data-testid={`button-waze-${index}`}
                          >
                            <Navigation className="h-4 w-4 mr-1" />
                            Waze
                          </Button>
                        )}
                        {getStatusBadge(status)}
                      </div>
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
                            {formatDistance(segment.distance)}
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

          {/* Atendimentos Virtuais (se houver) */}
          {route?.visits && route.visits.filter((v: any) => v.isVirtual).length > 0 && (
            <>
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
                        {formatDistance(route.segments.find((s: any) => s.visitId === 'return')?.distance || 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Atendimentos Virtuais */}
              <div className="mt-6 bg-blue-50 dark:bg-blue-900/20 rounded-lg border-2 border-blue-300 dark:border-blue-700 p-4">
                <div className="flex items-center mb-4">
                  <Phone className="h-6 w-6 text-blue-600 mr-3" />
                  <div>
                    <h3 className="text-lg font-bold text-blue-900 dark:text-blue-100">Atendimentos Virtuais do Dia</h3>
                    <p className="text-sm text-blue-700 dark:text-blue-300">{route.visits.filter((v: any) => v.isVirtual).length} chamadas/WhatsApp</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {route.visits.filter((v: any) => v.isVirtual).map((visit: any, index: number) => (
                    <div key={visit.id} className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-blue-200 dark:border-blue-700 hover:shadow-sm transition-all">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Phone className="h-4 w-4 text-blue-600 flex-shrink-0" />
                            <p className="font-semibold text-gray-900 dark:text-white truncate">
                              {visit.customerName}
                            </p>
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 ml-6">
                            {visit.customerPhone}
                          </p>
                        </div>
                        <Badge className="bg-blue-500 hover:bg-blue-600 text-white text-xs flex-shrink-0">
                          Virtual
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          
          {/* Se NÃO houver virtuais, mostrar o bloco "Retorno - Casa" normalmente */}
          {(!route?.visits || route.visits.filter((v: any) => v.isVirtual).length === 0) && (
            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg mt-2 border border-green-200 dark:border-green-800">
              <div className="flex items-center">
                <Home className="h-5 w-5 text-green-600 mr-3" />
                <div className="flex-1">
                  <p className="font-semibold text-green-800 dark:text-green-200">Retorno - Sua Casa</p>
                  <p className="text-sm text-green-700 dark:text-green-300">Fim da rota</p>
                </div>
              </div>
              {/* Distância de retorno */}
              {route?.segments && route.segments.find((s: any) => s.visitId === 'return') && (
                <div className="mt-2 px-3 py-2 bg-green-100 dark:bg-green-900/30 rounded-md">
                  <div className="flex items-center text-sm font-medium text-green-800 dark:text-green-200">
                    <Navigation className="h-4 w-4 mr-2" />
                    <span className="text-xs text-green-600 dark:text-green-300 mr-2">
                      {route.segments.find((s: any) => s.visitId === 'return')?.from} → Casa:
                    </span>
                    <span className="font-bold text-green-900 dark:text-green-100">
                      {formatDistance(route.segments.find((s: any) => s.visitId === 'return')?.distance || 0)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
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
              {(() => {
                // Agrupar checkpoints em pares (check-in + check-out)
                const pairs: any[] = [];
                for (let i = 0; i < route.checkpoints.length; i += 2) {
                  const checkIn = route.checkpoints[i];
                  const checkOut = route.checkpoints[i + 1];
                  if (checkIn && checkOut) {
                    pairs.push({ checkIn, checkOut });
                  } else if (checkIn) {
                    // Se houver check-in sem check-out, adicionar sozinho
                    pairs.push({ checkIn, checkOut: null });
                  }
                }

                return pairs.map((pair, pairIndex) => {
                  const { checkIn, checkOut } = pair;
                  const isOffRoute = checkIn.isOffRoute || false;
                  const validationStatus = checkIn.validationStatus || 'validated';
                  const isCancelled = validationStatus === 'cancelled';
                  const isPending = validationStatus === 'pending';
                  
                  return (
                    <div 
                      key={checkIn.id} 
                      className={`p-4 rounded-lg border-2 ${
                        isCancelled 
                          ? 'bg-gray-100 dark:bg-gray-900 border-gray-300 dark:border-gray-700 opacity-60' 
                          : isOffRoute && isPending
                          ? 'bg-red-50 dark:bg-red-950 border-red-500'
                          : isOffRoute
                          ? 'bg-orange-50 dark:bg-orange-950 border-orange-500'
                          : 'bg-gray-50 dark:bg-gray-800 border-transparent'
                      }`}
                    >
                      {/* Header com nome do cliente e badges */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                            isCancelled 
                              ? 'bg-gray-400 text-white' 
                              : isOffRoute 
                              ? 'bg-red-600 text-white' 
                              : 'bg-honest-blue text-white'
                          }`}>
                            {pairIndex + 1}
                          </div>
                          <div>
                            <p className={`font-semibold text-base ${
                              isCancelled 
                                ? 'text-gray-500 dark:text-gray-600 line-through' 
                                : 'text-gray-900 dark:text-white'
                            }`}>
                              {checkIn.customerName || 'Cliente'}
                            </p>
                            {isOffRoute && (
                              <Badge 
                                variant={isPending ? "destructive" : "secondary"}
                                className="text-xs mt-1"
                              >
                                {isPending ? 'FORA DA ROTA - PENDENTE' : isCancelled ? 'CANCELADA' : 'VALIDADA'}
                              </Badge>
                            )}
                          </div>
                        </div>
                        
                        {/* Botões de Validar/Cancelar (apenas admin e visitas off-route) */}
                        {isAdmin && isOffRoute && isPending && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-green-600 border-green-600 hover:bg-green-50"
                              onClick={() => validateVisitMutation.mutate(checkIn.id)}
                              disabled={validateVisitMutation.isPending}
                              data-testid={`button-validate-${checkIn.id}`}
                            >
                              <CheckCircle className="h-4 w-4 mr-1" />
                              Validar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-600 border-red-600 hover:bg-red-50"
                              onClick={() => cancelVisitMutation.mutate(checkIn.id)}
                              disabled={cancelVisitMutation.isPending}
                              data-testid={`button-cancel-${checkIn.id}`}
                            >
                              <AlertTriangle className="h-4 w-4 mr-1" />
                              Cancelar
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* Check-in e Check-out lado a lado */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Check-in */}
                        <div className="bg-white dark:bg-gray-900 p-3 rounded-md border border-gray-200 dark:border-gray-700">
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2">
                              <MapPin className="h-4 w-4 text-green-600" />
                              <p className="font-semibold text-sm text-gray-900 dark:text-white">
                                Check-in
                              </p>
                            </div>
                            {/* Botão de ver foto */}
                            {checkIn.photoUrl && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSelectedPhoto({
                                  url: checkIn.photoUrl,
                                  customerName: checkIn.customerName || 'Cliente',
                                  checkInTime: checkIn.checkpointTime || checkIn.timestamp,
                                  latitude: checkIn.latitude || '',
                                  longitude: checkIn.longitude || ''
                                })}
                                data-testid={`button-view-photo-${checkIn.id}`}
                              >
                                <Camera className="h-3 w-3 mr-1" />
                                Ver Foto
                              </Button>
                            )}
                          </div>
                          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                            <Clock className="h-3 w-3 inline mr-1" />
                            {format(new Date(checkIn.checkpointTime || checkIn.timestamp), "HH:mm:ss", { locale: ptBR })}
                          </p>
                          <p className={`text-sm font-medium ${
                            isCancelled 
                              ? 'text-gray-500 dark:text-gray-600 line-through' 
                              : 'text-honest-blue'
                          }`}>
                            <Navigation className="h-3 w-3 inline mr-1" />
                            {formatDistance(parseFloat(checkIn.distanceFromPrevious || '0'))}
                            <span className="text-xs text-gray-500 ml-1">
                              {isCancelled ? '(não contada)' : 'do anterior'}
                            </span>
                          </p>
                          {/* Distância do local cadastrado */}
                          {checkIn.customerRegisteredLatitude && checkIn.customerRegisteredLongitude && 
                           checkIn.checkpointLatitude && checkIn.checkpointLongitude && (
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                              <MapPin className="h-3 w-3 inline mr-1" />
                              {(() => {
                                const distance = calculateDistance(
                                  parseFloat(checkIn.checkpointLatitude),
                                  parseFloat(checkIn.checkpointLongitude),
                                  parseFloat(checkIn.customerRegisteredLatitude),
                                  parseFloat(checkIn.customerRegisteredLongitude)
                                );
                                return formatDistance(distance / 1000); // converter metros para km
                              })()} do local cadastrado
                            </p>
                          )}
                        </div>

                        {/* Check-out */}
                        {checkOut && (
                          <div className="bg-white dark:bg-gray-900 p-3 rounded-md border border-gray-200 dark:border-gray-700">
                            <div className="flex items-center gap-2 mb-2">
                              <MapPin className="h-4 w-4 text-red-600" />
                              <p className="font-semibold text-sm text-gray-900 dark:text-white">
                                Check-out
                              </p>
                            </div>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              <Clock className="h-3 w-3 inline mr-1" />
                              {format(new Date(checkOut.checkpointTime || checkOut.timestamp), "HH:mm:ss", { locale: ptBR })}
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              Tempo no local: {(() => {
                                const diff = new Date(checkOut.checkpointTime || checkOut.timestamp).getTime() - 
                                            new Date(checkIn.checkpointTime || checkIn.timestamp).getTime();
                                const minutes = Math.floor(diff / 60000);
                                return `${minutes} min`;
                              })()}
                            </p>
                            {/* Distância do local cadastrado */}
                            {checkOut.customerRegisteredLatitude && checkOut.customerRegisteredLongitude && 
                             checkOut.checkpointLatitude && checkOut.checkpointLongitude && (
                              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                <MapPin className="h-3 w-3 inline mr-1" />
                                {(() => {
                                  const distance = calculateDistance(
                                    parseFloat(checkOut.checkpointLatitude),
                                    parseFloat(checkOut.checkpointLongitude),
                                    parseFloat(checkOut.customerRegisteredLatitude),
                                    parseFloat(checkOut.customerRegisteredLongitude)
                                  );
                                  return formatDistance(distance / 1000); // converter metros para km
                                })()} do local cadastrado
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal de Detalhes do Card de Vendas */}
      <SalesCardDetailsModal
        isOpen={showCardModal}
        onClose={() => {
          setShowCardModal(false);
          setSelectedCard(null);
          // Recarregar rota após fechar modal
          refetch();
        }}
        card={selectedCard}
      />

      {/* Modal de Edição do Card de Vendas */}
      <SalesCardModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setEditingCard(null);
          // Invalidar queries de rotas e cards para recarregar dados atualizados
          queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
          queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
          refetch();
        }}
        editingCard={editingCard}
      />

      {/* Modal de Visualização de Foto */}
      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-4xl p-0">
          {selectedPhoto && (
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                className="absolute top-2 right-2 z-10 bg-white/90 hover:bg-white"
                onClick={() => setSelectedPhoto(null)}
                data-testid="button-close-photo-modal"
              >
                <X className="h-4 w-4" />
              </Button>
              
              {selectedPhoto.url && selectedPhoto.url.length > 100 ? (
                <img 
                  src={selectedPhoto.url} 
                  alt={`Check-in ${selectedPhoto.customerName}`}
                  className="w-full max-h-[80vh] object-contain bg-black"
                />
              ) : (
                <div className="w-full h-96 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
                  <div className="text-center">
                    <Camera className="h-16 w-16 mx-auto text-gray-400 mb-4" />
                    <p className="text-gray-500 dark:text-gray-400">Foto indisponível</p>
                  </div>
                </div>
              )}
              
              <div className="p-6 bg-white dark:bg-gray-800">
                <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
                  <Camera className="h-5 w-5 text-honest-blue" />
                  Check-in: {selectedPhoto.customerName}
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-gray-500" />
                    <span>{format(new Date(selectedPhoto.checkInTime), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-gray-500" />
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {selectedPhoto.latitude}, {selectedPhoto.longitude}
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    onClick={() => downloadPhoto(selectedPhoto.url, selectedPhoto.customerName, selectedPhoto.checkInTime)}
                    className="flex-1"
                    data-testid="button-download-photo"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Baixar Foto
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.open(`https://www.google.com/maps?q=${selectedPhoto.latitude},${selectedPhoto.longitude}`, '_blank')}
                    data-testid="button-view-location"
                  >
                    <MapPin className="mr-2 h-4 w-4" />
                    Ver Localização
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* AlertDialog de confirmação para excluir visita */}
      <AlertDialog open={!!deleteVisit} onOpenChange={(open) => !open && setDeleteVisit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja remover a visita de <strong>{deleteVisit?.customerName}</strong> da rota de hoje? 
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 hover:bg-red-600"
              onClick={() => {
                if (deleteVisit && route) {
                  removeVisitMutation.mutate({
                    routeId: route.id,
                    visitId: deleteVisit.visitId
                  });
                }
              }}
              data-testid="button-confirm-delete"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Modal de Adicionar Cliente à Rota */}
      <Dialog open={showAddCustomerModal} onOpenChange={setShowAddCustomerModal}>
        <DialogPortal>
          <DialogOverlay className="z-[9999]" />
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col z-[10000]">
            <div className="flex items-center gap-2 pb-4 border-b">
              <Users className="h-5 w-5 text-honest-blue" />
              <h2 className="text-xl font-semibold">Adicionar Cliente à Rota</h2>
            </div>
          
          <div className="py-4">
            <Label htmlFor="search-customer">Pesquisar Cliente</Label>
            <Input
              id="search-customer"
              type="text"
              placeholder="Digite o nome, nome fantasia ou CPF/CNPJ..."
              value={customerSearchQuery}
              onChange={(e) => setCustomerSearchQuery(e.target.value)}
              className="mt-1"
              data-testid="input-search-customer"
              autoFocus
            />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Selecione um cliente para adicionar à rota de {format(new Date(route?.routeDate || new Date()), "dd/MM/yyyy")}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 min-h-[300px]">
            {filteredCustomers.length === 0 ? (
              <div className="text-center py-12">
                <Users className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                <p className="text-gray-600 dark:text-gray-400">
                  {customerSearchQuery ? 'Nenhum cliente encontrado' : 'Digite para pesquisar clientes'}
                </p>
              </div>
            ) : (
              filteredCustomers.map((customer: any) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  data-testid={`customer-item-${customer.id}`}
                >
                  <div className="flex-1">
                    <p className="font-medium">{customer.fantasyName || customer.name}</p>
                    {customer.fantasyName && customer.name !== customer.fantasyName && (
                      <p className="text-sm text-gray-600 dark:text-gray-400">{customer.name}</p>
                    )}
                    <div className="flex gap-4 text-sm text-gray-500 dark:text-gray-400 mt-1">
                      <span>{customer.cpf || customer.cnpj}</span>
                      {customer.address && <span className="truncate max-w-xs">{customer.address}</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      if (!addCustomerToRouteMutation.isPending) {
                        addCustomerToRouteMutation.mutate(customer.id);
                      }
                    }}
                    disabled={addCustomerToRouteMutation.isPending}
                    data-testid={`button-add-customer-${customer.id}`}
                  >
                    {addCustomerToRouteMutation.isPending ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                        Adicionando...
                      </>
                    ) : (
                      'Adicionar'
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => {
                setShowAddCustomerModal(false);
                setCustomerSearchQuery('');
              }}
              className="w-full"
              data-testid="button-close-add-customer"
            >
              Fechar
            </Button>
          </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
