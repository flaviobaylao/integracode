import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Route, MapPin, Calendar, User, CheckCircle, Clock, AlertCircle, Camera, Navigation, X, RefreshCw, Trash2, Plus, Zap, UtensilsCrossed, Target, Phone } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import type { DailyRouteResponse } from "@shared/schema";
import RouteMap from "@/components/RouteMap";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import { calculateDistance, formatDistance, calculateRouteDistance } from "@/lib/geoUtils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SalesCardWithRelations } from "@shared/schema";
import EditablePhoneField from "@/components/EditablePhoneField";

// Funções auxiliares para formatar dados de agendamento
function formatWeekdaysLocal(weekdaysJson: string | null | undefined): string {
  if (!weekdaysJson) return '';
  
  try {
    const { safeParseWeekdays } = require('@/lib/weekdayParser');
    const days = safeParseWeekdays(weekdaysJson);
    if (!Array.isArray(days) || days.length === 0) return '';
    
    const dayMap: Record<string, string> = {
      'Seg': 'Seg',
      'Ter': 'Ter',
      'Qua': 'Qua',
      'Qui': 'Qui',
      'Sex': 'Sex',
      'Sab': 'Sáb',
      'Dom': 'Dom'
    };
    
    return days.map(d => dayMap[d] || d).join(', ');
  } catch (e) {
    return '';
  }
}

function formatPeriodicity(periodicity: string | null | undefined): string {
  if (!periodicity) return '';
  
  const periodicityMap: Record<string, string> = {
    'semanal': 'Semanal',
    'quinzenal': 'Quinzenal',
    'mensal': 'Mensal'
  };
  
  return periodicityMap[periodicity] || periodicity;
}

export default function RotaDoDia() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useLocation()[1];
  
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator' || user?.role === 'administrative';
  const isVendedor = user?.role === 'vendedor';
  
  // Bloquear motoristas de acessar Rota do Dia
  if (user && (user.role as string) === 'motorista') {
    return (
      <div className="p-6 text-center">
        <h1 className="text-2xl font-bold mb-4">Acesso Negado</h1>
        <p className="text-gray-600 mb-4">Motoristas devem usar a "Rota de Entrega"</p>
        <button 
          onClick={() => navigate('/rota-entrega')}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Ir para Rota de Entrega
        </button>
      </div>
    );
  }
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedSellerId, setSelectedSellerId] = useState(isAdmin ? '' : user?.id || '');
  const [selectedCard, setSelectedCard] = useState<any>(null);
  const [showCardModal, setShowCardModal] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isNoSaleModalOpen, setIsNoSaleModalOpen] = useState(false);
  const [loadingCardId, setLoadingCardId] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [showAddVisitModal, setShowAddVisitModal] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [addVisitTab, setAddVisitTab] = useState<'customer' | 'lead'>('customer');
  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [selectedLead, setSelectedLead] = useState<any>(null);
  const [showLeadCheckInModal, setShowLeadCheckInModal] = useState(false);
  const [leadCheckInPhoto, setLeadCheckInPhoto] = useState<File | null>(null);
  const [leadCheckInPhotoUrl, setLeadCheckInPhotoUrl] = useState<string | null>(null);
  const [checkInCoords, setCheckInCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [leadCheckInNotes, setLeadCheckInNotes] = useState('');

  const { data: sellers } = useQuery<any[]>({
    queryKey: ['/api/users?role=vendedor'],
    enabled: isAdmin && !!user,
  });

  const { data: customers } = useQuery<any[]>({
    queryKey: ['/api/customers', { sellerId: selectedSellerId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedSellerId) {
        params.append('sellerId', selectedSellerId);
      }
      const res = await fetch(`/api/customers?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch customers');
      return res.json();
    },
    enabled: isAdmin && showAddVisitModal && addVisitTab === 'customer' && !!selectedSellerId,
  });

  const { data: leads } = useQuery<any[]>({
    queryKey: ['/api/leads', { sellerId: selectedSellerId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedSellerId) {
        params.append('sellerId', selectedSellerId);
      }
      const res = await fetch(`/api/leads?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch leads');
      return res.json();
    },
    enabled: isAdmin && showAddVisitModal && addVisitTab === 'lead' && !!selectedSellerId,
  });

  const { data: response, isLoading, refetch, isFetching } = useQuery<DailyRouteResponse>({
    queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate],
    enabled: !!selectedSellerId && !!selectedDate,
    refetchInterval: 30000, // Atualiza automaticamente a cada 30 segundos
  });

  const generateFromPlannedVisitsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSellerId || !selectedDate) throw new Error('Vendedor e data são obrigatórios');
      return apiRequest('POST', '/api/daily-routes/from-planned-visits', {
        sellerId: selectedSellerId,
        date: selectedDate
      });
    },
    onSuccess: (data) => {
      if (data.totalVisits === 0) {
        toast({ title: "Aviso", description: "Nenhuma visita planejada para esta data" });
      } else {
        toast({ title: "Sucesso", description: `Rota gerada com ${data.totalVisits} visitas planejadas` });
      }
      refetch();
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Falha ao gerar rota", variant: "destructive" });
    }
  });

  const generateRouteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/daily-routes/generate', {
        sellerId: selectedSellerId,
        date: selectedDate,
        allowEmpty: true
      });
      
      return response;
    },
    onSuccess: (data) => {
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
      
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao gerar rota",
        description: error.message || "Ocorreu um erro ao gerar a rota",
      });
    },
  });

  const createEmptyRouteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/daily-routes/create-empty', {
        sellerId: selectedSellerId,
        date: selectedDate
      });
      
      return response;
    },
    onSuccess: async (data) => {
      toast({
        title: "Rota vazia criada!",
        description: "Agora você pode adicionar clientes manualmente.",
      });
      
      await queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
      await queryClient.invalidateQueries({ queryKey: ['/api/daily-routes'] });
      await refetch();  // Força atualização imediata da UI
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao criar rota vazia",
        description: error.message || "Ocorreu um erro ao criar a rota vazia",
      });
    },
  });

  const deleteVisitMutation = useMutation({
    mutationFn: async ({ routeId, customerId }: { routeId: string; customerId: string }) => {
      return await apiRequest('DELETE', `/api/daily-routes/${routeId}/visits/${customerId}`);
    },
    onSuccess: () => {
      toast({
        title: "Visita removida",
        description: "A visita foi removida da rota com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao remover visita",
        description: error.message || "Ocorreu um erro ao remover a visita",
      });
    },
  });

  const addVisitMutation = useMutation({
    mutationFn: async ({ routeId, customerId }: { routeId: string; customerId: string }) => {
      return await apiRequest('POST', `/api/daily-routes/${routeId}/visits`, { customerId });
    },
    onSuccess: (data) => {
      const customerName = data?.customer?.name || 'Cliente';
      toast({
        title: "Visita adicionada",
        description: `${customerName} adicionado a rota com sucesso`,
      });
      setShowAddVisitModal(false);
      setCustomerSearchQuery('');
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Erro ao adicionar visita",
        description: error.message || "Ocorreu um erro ao adicionar a visita",
      });
    },
  });

  const addLeadMutation = useMutation({
    mutationFn: async ({ routeId, leadId }: { routeId: string; leadId: string }) => {
      return await apiRequest('POST', `/api/daily-routes/${routeId}/leads`, { leadId });
    },
    onSuccess: (data) => {
      const leadName = data?.lead?.name || 'Lead';
      toast({
        title: "Lead adicionado",
        description: `${leadName} adicionado à rota com sucesso`,
      });
      setShowAddVisitModal(false);
      setLeadSearchQuery('');
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Erro ao adicionar lead",
        description: error.message || "Ocorreu um erro ao adicionar o lead",
      });
    },
  });

  const deleteRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('DELETE', `/api/daily-routes/${routeId}`);
    },
    onSuccess: () => {
      toast({
        title: "Rota limpa com sucesso!",
        description: "Você pode gerar uma nova rota agora",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao limpar rota",
        description: error.message || "Ocorreu um erro ao limpar a rota",
      });
    },
  });

  const optimizeRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('POST', `/api/daily-routes/${routeId}/optimize`);
    },
    onSuccess: (data) => {
      toast({
        title: "Rota otimizada!",
        description: data.message || "A rota foi otimizada com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao otimizar rota",
        description: error.message || "Ocorreu um erro ao otimizar a rota",
      });
    },
  });

  const markLunchBreakMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('POST', `/api/daily-routes/${routeId}/lunch-break`);
    },
    onSuccess: () => {
      toast({
        title: "Horário de almoço marcado",
        description: "O horário de almoço foi registrado com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
      refetch();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Erro ao marcar horário de almoço",
        description: error.message || "Ocorreu um erro ao marcar o horário de almoço",
      });
    },
  });

  const leadCheckInMutation = useMutation({
    mutationFn: async ({ leadId, latitude, longitude, photo }: { leadId: string; latitude: number; longitude: number; photo?: File }) => {
      const formData = new FormData();
      formData.append('latitude', latitude.toString());
      formData.append('longitude', longitude.toString());
      if (photo) {
        formData.append('photo', photo);
      }
      if (leadCheckInNotes) {
        formData.append('notes', leadCheckInNotes);
      }

      const response = await fetch(`/api/leads/${leadId}/check-in`, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Erro ao fazer check-in`);
      }
      return data;
    },
    onSuccess: () => {
      setLeadCheckInPhoto(null);
      setLeadCheckInPhotoUrl(null);
      setCheckInCoords(null);
      setLeadCheckInNotes('');
      toast({
        title: "✓ Check-in realizado",
        description: "Check-in no lead realizado com sucesso",
      });
      closeModals();
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      console.error('❌ Check-in error:', error);
      toast({
        variant: "destructive",
        title: "Erro ao fazer check-in",
        description: error.message || "Ocorreu um erro ao fazer check-in no lead. Tente novamente.",
      });
    },
  });

  const validateVisitMutation = useMutation({
    mutationFn: async (checkpointId: string) => {
      return await apiRequest('POST', `/api/daily-routes/checkpoints/${checkpointId}/validate`, {});
    },
    onSuccess: () => {
      toast({
        title: "Visita validada!",
        description: "A distância desta visita foi incluída na rota executada.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao validar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const rejectVisitMutation = useMutation({
    mutationFn: async (checkpointId: string) => {
      return await apiRequest('POST', `/api/daily-routes/checkpoints/${checkpointId}/cancel`, {});
    },
    onSuccess: () => {
      toast({
        title: "Visita rejeitada",
        description: "Esta visita não será contabilizada na rota executada.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao rejeitar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleManualRefresh = async () => {
    await refetch();
    toast({
      title: "Rota atualizada",
      description: "Os dados foram atualizados com sucesso",
    });
  };

  const filteredCustomers = useMemo(() => {
    if (!customers || !customerSearchQuery) return customers || [];
    
    const query = customerSearchQuery.toLowerCase().trim();
    const queryClean = query.replace(/\D/g, '');
    
    return customers.filter((customer: any) => {
      // Busca em todos os campos de nome
      const fantasyName = customer.fantasyName?.toLowerCase() || '';
      const name = customer.name?.toLowerCase() || '';
      const companyName = customer.companyName?.toLowerCase() || '';
      
      // Pesquisa por nome fantasia, razão social ou nome da empresa
      if (fantasyName.includes(query) || name.includes(query) || companyName.includes(query)) {
        return true;
      }
      
      // Pesquisa por CNPJ/CPF apenas se a query contém números
      if (queryClean.length > 0) {
        const cnpj = customer.cnpj?.replace(/\D/g, '') || '';
        const cpf = customer.cpf?.replace(/\D/g, '') || '';
        
        if (cnpj.includes(queryClean) || cpf.includes(queryClean)) {
          return true;
        }
      }
      
      return false;
    });
  }, [customers, customerSearchQuery]);

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

    // Usar tempo médio calculado pelo backend (apenas visitas completas com check-in E check-out)
    const averageVisitTime = route.progress?.averageVisitTime ?? 0;

    return {
      plannedDistance: calculateRouteDistance(plannedCoords),
      executedDistance: Number(route.totalActualDistance ?? 0),
      averageVisitTime
    };
  }, [route]);

  const handleVisitClick = async (entityId: string, isLead: boolean = false) => {
    try {
      setLoadingCardId(entityId);
      
      if (isLead) {
        // Para leads, buscar dados do lead
        const response = await fetch(`/api/leads/${entityId}`, {
          credentials: 'include'
        });
        
        if (!response.ok) {
          throw new Error('Falha ao buscar lead');
        }
        
        const lead = await response.json();
        setSelectedLead(lead);
        setShowLeadCheckInModal(true);
      } else {
        // Para clientes normais, buscar sales card
        const response = await fetch(`/api/customers/${entityId}/sales-card/${selectedDate}`, {
          credentials: 'include'
        });
        
        if (!response.ok) {
          throw new Error('Falha ao buscar card de vendas');
        }
        
        const card = await response.json();
        setSelectedCard(card);
        setShowCardModal(true);
      }
    } catch (error) {
      console.error('Erro ao abrir card de vendas:', error);
      toast({
        variant: "destructive",
        title: "Erro ao abrir card",
        description: "Não foi possível carregar os detalhes desta visita."
      });
    } finally {
      setLoadingCardId(null);
    }
  };

  const handlePhotoClick = (photoUrl: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPhoto(photoUrl);
    setShowPhotoModal(true);
  };

  const handleEditSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setIsEditModalOpen(true);
  };

  const handleNoSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setIsNoSaleModalOpen(true);
  };

  const closeModals = () => {
    setShowCardModal(false);
    setIsEditModalOpen(false);
    setIsNoSaleModalOpen(false);
    setSelectedCard(null);
    setShowLeadCheckInModal(false);
    setSelectedLead(null);
    setLeadCheckInPhoto(null);
    setLeadCheckInPhotoUrl(null);
    setCheckInCoords(null);
    setLeadCheckInNotes('');
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Route className="h-8 w-8 text-green-600" />
            Rota do Dia
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            Visualize e gerencie suas visitas programadas
          </p>
        </div>
        {selectedSellerId && (
          <Button
            onClick={handleManualRefresh}
            disabled={isFetching}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
            data-testid="button-refresh-route"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            {isFetching ? 'Atualizando...' : 'Atualizar'}
          </Button>
        )}
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
                  {sellers?.filter(s => s.isActive).map((seller) => (
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
              <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
                <Button 
                  variant="default" 
                  data-testid="button-generate-route"
                  onClick={() => generateRouteMutation.mutate()}
                  disabled={generateRouteMutation.isPending || createEmptyRouteMutation.isPending || generateFromPlannedVisitsMutation.isPending || !selectedSellerId}
                >
                  {generateRouteMutation.isPending ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Gerando...
                    </>
                  ) : (
                    <>
                      <Route className="mr-2 h-4 w-4" />
                      Gerar Rota
                    </>
                  )}
                </Button>
                <Button 
                  variant="outline" 
                  data-testid="button-create-empty-route"
                  onClick={() => createEmptyRouteMutation.mutate()}
                  disabled={generateRouteMutation.isPending || createEmptyRouteMutation.isPending || generateFromPlannedVisitsMutation.isPending || !selectedSellerId}
                >
                  {createEmptyRouteMutation.isPending ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Criando...
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Criar Rota Vazia
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-3">
                <span>
                  {formatInTimeZone(new Date(selectedDate + 'T12:00:00.000Z'), 'America/Sao_Paulo', "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  {isAdmin && route?.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => deleteRouteMutation.mutate(route.id)}
                      disabled={deleteRouteMutation.isPending}
                      data-testid="button-clear-route"
                      className="border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      {deleteRouteMutation.isPending ? (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          Limpando...
                        </>
                      ) : (
                        <>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Limpar Rota
                        </>
                      )}
                    </Button>
                  )}
                  {(() => {
                    const hasCheckins = route.checkpoints?.some((cp: any) => cp.checkpointType === 'check_in');
                    const lunchBreak = (route.progress as any)?.lunchBreak;
                    const lunchStatus = lunchBreak?.status || null;
                    const canMarkLunch = hasCheckins && !lunchStatus;
                    
                    if (!lunchStatus && canMarkLunch) {
                      return (
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => markLunchBreakMutation.mutate(route.id)}
                          disabled={markLunchBreakMutation.isPending}
                          className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                          data-testid="button-lunch-break"
                        >
                          <UtensilsCrossed className="mr-2 h-4 w-4" />
                          {markLunchBreakMutation.isPending ? 'Marcando...' : 'Iniciar Almoço'}
                        </Button>
                      );
                    } else if (lunchStatus === 'pending') {
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled
                          className="bg-amber-100 dark:bg-amber-900 border-amber-300 dark:border-amber-700"
                          data-testid="button-lunch-break-pending"
                        >
                          <UtensilsCrossed className="mr-2 h-4 w-4 text-amber-600 dark:text-amber-400" />
                          Aguardando Retorno
                        </Button>
                      );
                    } else if (lunchStatus === 'completed') {
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled
                          className="bg-green-100 dark:bg-green-900 border-green-300 dark:border-green-700"
                          data-testid="button-lunch-break-completed"
                        >
                          <UtensilsCrossed className="mr-2 h-4 w-4 text-green-600 dark:text-green-400" />
                          Almoço Concluído
                        </Button>
                      );
                    }
                    return null;
                  })()}
                  <Badge variant={route.routeStatus === 'completed' ? 'default' : 'secondary'}>
                    {route.routeStatus === 'completed' ? 'Concluída' : 'Em andamento'}
                  </Badge>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
                    <p className="text-xl font-bold">{formatDistance(routeMetrics.executedDistance * 1000)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-teal-100 dark:bg-teal-900 rounded-lg">
                    <Clock className="h-6 w-6 text-teal-600 dark:text-teal-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Carga Horária</p>
                    <p className="text-xl font-bold" data-testid="worked-hours">
                      {(route.progress as any)?.workedHours?.formatted || '-'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-red-100 dark:bg-red-900 rounded-lg">
                    <UtensilsCrossed className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Tempo de Almoço</p>
                    <p className="text-xl font-bold" data-testid="lunch-time">
                      {(route.progress as any)?.lunchBreak
                        ? (route.progress as any).lunchBreak.formatted
                        : '1h 30min (padrão)'}
                    </p>
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
                  visits={((route.visits || []).filter((v: any) => !v.isVirtual && v.visitType !== 'virtual')).map(visit => ({
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
              <div className="flex items-center justify-between">
                <CardTitle>Visitas Presenciais ({(route.visits || []).filter((v: any) => !v.isVirtual && v.visitType !== 'virtual').length})</CardTitle>
                {isAdmin && route.id && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAddVisitModal(true)}
                      className="flex items-center gap-2"
                      data-testid="button-add-visit"
                    >
                      <Plus className="h-4 w-4" />
                      Adicionar Visita
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => optimizeRouteMutation.mutate(route.id)}
                      disabled={optimizeRouteMutation.isPending}
                      className="flex items-center gap-2"
                      data-testid="button-optimize-route"
                    >
                      <Zap className="h-4 w-4" />
                      {optimizeRouteMutation.isPending ? 'Otimizando...' : 'Otimizar Rota'}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {((route.visits || []).filter((v: any) => !v.isVirtual && v.visitType !== 'virtual')).map((visit, index) => {
                  const checkInCheckpoint = route.checkpoints?.find(
                    cp => cp.customerId === visit.customerId && cp.checkpointType === 'check_in'
                  );
                  const checkOutCheckpoint = route.checkpoints?.find(
                    cp => cp.customerId === visit.customerId && cp.checkpointType === 'check_out'
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
                  const isLead = (visit as any).visitType === 'lead';

                  let statusColor = 'text-gray-600 dark:text-gray-400';
                  let borderColor = 'border-gray-200 dark:border-gray-700';
                  
                  if (isLead) {
                    // LEADs sempre aparecem em roxo, com variações baseadas no status
                    if (hasOffsite) {
                      statusColor = 'text-red-600 dark:text-red-400';
                      borderColor = 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950';
                    } else if (isCompleted) {
                      statusColor = 'text-purple-700 dark:text-purple-300';
                      borderColor = 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950';
                    } else if (isInProgress) {
                      statusColor = 'text-purple-600 dark:text-purple-400';
                      borderColor = 'border-purple-400 dark:border-purple-600 bg-purple-50 dark:bg-purple-950';
                    } else {
                      statusColor = 'text-purple-600 dark:text-purple-400';
                      borderColor = 'border-purple-500 dark:border-purple-700';
                    }
                  } else if (hasOffsite) {
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
                      key={visit.id || visit.customerId || index}
                      className={`p-3 border rounded-lg hover:shadow-md transition-all ${borderColor}`}
                      data-testid={`visit-${visit.customerId || visit.id}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div 
                          className="flex items-start gap-3 flex-1 cursor-pointer"
                          onClick={() => handleVisitClick(isLead ? (visit.entityId || visit.leadId || visit.customerId) : (visit.customerId || visit.entityId), isLead)}
                        >
                          <div className={`flex-shrink-0 w-7 h-7 rounded-full text-white flex items-center justify-center text-sm font-semibold ${
                            hasOffsite ? 'bg-red-600' : isCompleted ? 'bg-green-600' : isInProgress ? 'bg-blue-600' : 'bg-gray-400'
                          }`}>
                            {index + 1}
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <p className={`font-semibold ${statusColor} flex items-center gap-1`}>
                                {isLead && <Target className="h-4 w-4 text-purple-600 dark:text-purple-400" />}
                                {visit.customerName}
                              </p>
                              {isLead && (
                                <Badge variant="outline" className="text-xs border-purple-500 text-purple-600 dark:text-purple-400">
                                  Lead
                                </Badge>
                              )}
                              {checkInCheckpoint && checkInCheckpoint.photoUrl && (
                                <Camera 
                                  className="h-4 w-4 text-purple-500 cursor-pointer hover:text-purple-700 transition-colors" 
                                  data-testid={`camera-icon-${visit.customerId}`}
                                  onClick={(e) => handlePhotoClick(checkInCheckpoint.photoUrl!, e)}
                                />
                              )}
                            </div>
                            
                            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 mb-1">
                              <MapPin className="h-3 w-3" />
                              {visit.customerAddress || 'Endereço não informado'}
                            </p>

                            {!isLead && ((visit as any).weekdays || (visit as any).visitPeriodicity) && (
                              <p className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1 mb-2 font-medium">
                                <Calendar className="h-3 w-3" />
                                {formatWeekdaysLocal((visit as any).weekdays)}
                                {(visit as any).weekdays && (visit as any).visitPeriodicity && ' • '}
                                {formatPeriodicity((visit as any).visitPeriodicity)}
                              </p>
                            )}

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
                                  <div className="inline-flex items-center gap-2">
                                    <span className={`font-medium ${checkOutOffsite ? 'text-red-600' : statusColor}`} data-testid={`checkout-time-${visit.customerId}`}>
                                      {formatInTimeZone(checkOutCheckpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                      {checkOutOffsite && ` ⚠️ ${formatDistance(checkOutDistance!)}`}
                                    </span>
                                    {visit.isAutoCheckout && (
                                      <Badge variant="secondary" className="text-xs" data-testid={`badge-auto-checkout-${visit.customerId}`}>
                                        <Clock className="h-3 w-3 mr-1" />
                                        Check-out automático
                                      </Badge>
                                    )}
                                  </div>
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
                        
                        <div className="flex items-center gap-1">
                          {/* Botão Waze */}
                          {visit.customerLatitude && visit.customerLongitude && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(`https://waze.com/ul?ll=${visit.customerLatitude},${visit.customerLongitude}&navigate=yes`, '_blank');
                              }}
                              data-testid={`button-waze-${visit.customerId}`}
                              title="Abrir no Waze"
                            >
                              <Navigation className="h-4 w-4" />
                            </Button>
                          )}
                          
                          {/* Botão Deletar (apenas admin) */}
                          {isAdmin && route.id && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Deseja realmente remover ${visit.customerName} desta rota?`)) {
                                  deleteVisitMutation.mutate({ routeId: route.id, customerId: visit.customerId || visit.entityId });
                                }
                              }}
                              disabled={deleteVisitMutation.isPending}
                              data-testid={`button-delete-visit-${visit.customerId}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {(() => {
                  const virtualVisits = (route.visits || []).filter((v: any) => v.isVirtual || v.visitType === 'virtual');
                  if (virtualVisits.length === 0) return null;

                  return (
                    <div className="my-6 border-t-2 border-blue-300 dark:border-blue-700 pt-4">
                      <h3 className="text-lg font-bold text-blue-600 dark:text-blue-400 mb-3 flex items-center gap-2">
                        <Phone className="h-5 w-5" />
                        Atendimentos Virtuais ({virtualVisits.length})
                      </h3>
                      <div className="space-y-2">
                        {virtualVisits.map((visit, index) => (
                          <div
                            key={visit.id || visit.customerId}
                            className="p-3 border border-blue-200 dark:border-blue-700 rounded-lg bg-blue-50 dark:bg-blue-950 hover:shadow-md transition-all"
                            data-testid={`virtual-visit-${visit.customerId}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3 flex-1">
                                <div className="flex-shrink-0 w-6 h-6 rounded-full text-white flex items-center justify-center text-xs font-semibold bg-blue-500">
                                  {index + 1}
                                </div>
                                <div className="flex-1">
                                  <p className="font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                                    <Phone className="h-4 w-4" />
                                    {visit.customerName}
                                  </p>
                                  {visit.phone && (
                                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                      📱 {visit.phone}
                                    </p>
                                  )}
                                  {visit.customerAddress && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                      📍 {visit.customerAddress}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

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

                      {offsiteCheckIns.map((checkpoint, index) => {
                        const validationStatus = checkpoint.validationStatus || 'pending';
                        const isValidated = validationStatus === 'validated';
                        const isCancelled = validationStatus === 'cancelled';
                        const isPending = validationStatus === 'pending';
                        
                        return (
                          <div
                            key={checkpoint.id}
                            className={`p-3 border rounded-lg ${
                              isValidated 
                                ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950' 
                                : isCancelled
                                ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950'
                                : 'border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950'
                            }`}
                            data-testid={`offsite-visit-${checkpoint.id}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className={`flex-shrink-0 w-7 h-7 rounded-full text-white flex items-center justify-center text-sm font-semibold ${
                                isValidated 
                                  ? 'bg-green-600' 
                                  : isCancelled
                                  ? 'bg-red-600'
                                  : 'bg-orange-600'
                              }`}>
                                {isValidated ? '✓' : isCancelled ? '✗' : '!'}
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <p className={`font-semibold ${
                                    isValidated 
                                      ? 'text-green-600 dark:text-green-400' 
                                      : isCancelled
                                      ? 'text-red-600 dark:text-red-400'
                                      : 'text-orange-600 dark:text-orange-400'
                                  }`}>
                                    {checkpoint.customerName || 'Cliente não identificado'}
                                  </p>
                                  {checkpoint.photoUrl && (
                                    <Camera 
                                      className="h-4 w-4 text-purple-500 cursor-pointer hover:text-purple-700 transition-colors" 
                                      onClick={(e) => handlePhotoClick(checkpoint.photoUrl!, e)}
                                    />
                                  )}
                                  {isValidated && (
                                    <Badge variant="default" className="bg-green-600 text-white">
                                      Validada
                                    </Badge>
                                  )}
                                  {isCancelled && (
                                    <Badge variant="destructive">
                                      Rejeitada
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                                  Check-in realizado fora da rota programada
                                </p>
                                <div className="text-xs mb-2">
                                  <span className="text-gray-500">Horário: </span>
                                  <span className={`font-medium ${
                                    isValidated 
                                      ? 'text-green-600 dark:text-green-400' 
                                      : isCancelled
                                      ? 'text-red-600 dark:text-red-400'
                                      : 'text-orange-600 dark:text-orange-400'
                                  }`}>
                                    {formatInTimeZone(checkpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                  </span>
                                </div>
                                
                                {/* Botões de validação (apenas admin e status pending) */}
                                {isAdmin && isPending && (
                                  <div className="flex gap-2 mt-2">
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="bg-green-600 hover:bg-green-700 text-white"
                                      onClick={() => validateVisitMutation.mutate(checkpoint.id)}
                                      disabled={validateVisitMutation.isPending || rejectVisitMutation.isPending}
                                      data-testid={`button-validate-${checkpoint.id}`}
                                    >
                                      {validateVisitMutation.isPending ? (
                                        <Clock className="h-4 w-4 mr-1 animate-spin" />
                                      ) : (
                                        <CheckCircle className="h-4 w-4 mr-1" />
                                      )}
                                      {validateVisitMutation.isPending ? 'Validando...' : 'Validar'}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      onClick={() => rejectVisitMutation.mutate(checkpoint.id)}
                                      disabled={validateVisitMutation.isPending || rejectVisitMutation.isPending}
                                      data-testid={`button-reject-${checkpoint.id}`}
                                    >
                                      {rejectVisitMutation.isPending ? (
                                        <Clock className="h-4 w-4 mr-1 animate-spin" />
                                      ) : (
                                        <X className="h-4 w-4 mr-1" />
                                      )}
                                      {rejectVisitMutation.isPending ? 'Rejeitando...' : 'Rejeitar'}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
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
          onClose={closeModals}
          card={selectedCard}
          onStartSale={handleEditSale}
          onStartNoSale={handleNoSale}
        />
      )}

      {isEditModalOpen && selectedCard && (
        <SaleEditModal
          isOpen={isEditModalOpen}
          onClose={closeModals}
          card={selectedCard}
        />
      )}

      {isNoSaleModalOpen && selectedCard && (
        <NoSaleModal
          isOpen={isNoSaleModalOpen}
          onClose={closeModals}
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

      {showLeadCheckInModal && selectedLead && (
        <Dialog open={showLeadCheckInModal} onOpenChange={closeModals}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Check-in em {selectedLead.fantasyName}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Localização */}
              <div className="border rounded-lg p-3 bg-gray-50 dark:bg-gray-900">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">📍 Localização</label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (!navigator.geolocation) {
                        toast({
                          variant: "destructive",
                          title: "Erro",
                          description: "Seu dispositivo não suporta geolocalização"
                        });
                        return;
                      }
                      navigator.geolocation.getCurrentPosition(
                        (position) => {
                          setCheckInCoords({
                            lat: position.coords.latitude,
                            lng: position.coords.longitude
                          });
                          toast({
                            title: "Localização capturada",
                            description: `Lat: ${position.coords.latitude.toFixed(6)}, Lng: ${position.coords.longitude.toFixed(6)}`
                          });
                        },
                        () => {
                          toast({
                            variant: "destructive",
                            title: "Erro",
                            description: "Não foi possível obter sua localização"
                          });
                        }
                      );
                    }}
                    data-testid="button-capture-location"
                  >
                    Capturar Localização
                  </Button>
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {checkInCoords ? (
                    <div className="space-y-1">
                      <p>✓ Lat: {checkInCoords.lat.toFixed(6)}</p>
                      <p>✓ Lng: {checkInCoords.lng.toFixed(6)}</p>
                    </div>
                  ) : (
                    <p className="text-red-600 dark:text-red-400">Não capturada</p>
                  )}
                </div>
              </div>

              {/* Foto */}
              <div>
                <label className="block text-sm font-medium mb-2">📷 Foto (obrigatória)</label>
                {leadCheckInPhotoUrl ? (
                  <div className="relative">
                    <img 
                      src={leadCheckInPhotoUrl} 
                      alt="Preview" 
                      className="w-full h-32 object-cover rounded-lg mb-2"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setLeadCheckInPhoto(null);
                        setLeadCheckInPhotoUrl(null);
                      }}
                      className="w-full"
                    >
                      Trocar Foto
                    </Button>
                  </div>
                ) : (
                  <Input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setLeadCheckInPhoto(file);
                        const reader = new FileReader();
                        reader.onload = (event) => {
                          setLeadCheckInPhotoUrl(event.target?.result as string);
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                    data-testid="input-lead-checkin-photo"
                  />
                )}
              </div>

              {/* Observações */}
              <div>
                <label className="block text-sm font-medium mb-2">📝 Observações</label>
                <textarea
                  placeholder="Relatar o ocorrido na visita (opcional)"
                  value={leadCheckInNotes}
                  onChange={(e) => setLeadCheckInNotes(e.target.value)}
                  className="w-full h-20 p-2 border rounded-lg dark:bg-gray-900 dark:border-gray-700 text-sm"
                  data-testid="textarea-lead-notes"
                />
              </div>

              {/* Botão Submit */}
              <Button
                onClick={() => {
                  if (!checkInCoords) {
                    toast({
                      variant: "destructive",
                      title: "Localização obrigatória",
                      description: "Clique em 'Capturar Localização' primeiro"
                    });
                    return;
                  }
                  if (!leadCheckInPhoto) {
                    toast({
                      variant: "destructive",
                      title: "Foto obrigatória",
                      description: "Escolha uma foto para fazer check-in"
                    });
                    return;
                  }
                  leadCheckInMutation.mutate({
                    leadId: selectedLead.id,
                    latitude: checkInCoords.lat,
                    longitude: checkInCoords.lng,
                    photo: leadCheckInPhoto
                  });
                }}
                disabled={leadCheckInMutation.isPending || !checkInCoords || !leadCheckInPhoto}
                className="w-full"
                data-testid="button-lead-checkin-submit"
              >
                {leadCheckInMutation.isPending ? 'Realizando check-in...' : '✓ Fazer Check-in'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={showAddVisitModal} onOpenChange={(open) => {
        setShowAddVisitModal(open);
        if (!open) {
          setCustomerSearchQuery('');
          setLeadSearchQuery('');
          setAddVisitTab('customer');
        }
      }}>
        <DialogContent className="max-w-2xl z-[9999]">
          <DialogHeader>
            <DialogTitle>Adicionar à Rota</DialogTitle>
          </DialogHeader>
          <Tabs value={addVisitTab} onValueChange={(value) => setAddVisitTab(value as 'customer' | 'lead')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="customer" data-testid="tab-customers">Clientes</TabsTrigger>
              <TabsTrigger value="lead" data-testid="tab-leads">Leads</TabsTrigger>
            </TabsList>
            <TabsContent value="customer" className="space-y-4">
              <div>
                <Input
                  placeholder="Buscar cliente por nome ou CNPJ/CPF..."
                  value={customerSearchQuery}
                  onChange={(e) => setCustomerSearchQuery(e.target.value)}
                  data-testid="input-customer-search"
                />
              </div>
              <div className="max-h-96 overflow-y-auto border rounded-lg">
                {filteredCustomers && filteredCustomers.length > 0 ? (
                  filteredCustomers.map((customer: any) => (
                    <div
                      key={customer.id}
                      className={`p-3 border-b last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800 ${
                        addVisitMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                      onClick={() => {
                        if (route?.id && !addVisitMutation.isPending) {
                          addVisitMutation.mutate({ routeId: route.id, customerId: customer.id });
                        }
                      }}
                      data-testid={`customer-option-${customer.id}`}
                    >
                      <div className="font-medium">{customer.fantasyName || customer.name}</div>
                      <div className="text-sm text-gray-500">{customer.cnpj || customer.cpf}</div>
                      <div className="text-xs text-gray-400">{customer.address}</div>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-center text-gray-500">
                    {customerSearchQuery ? 'Nenhum cliente encontrado' : 'Digite para buscar clientes'}
                  </div>
                )}
              </div>
              {addVisitMutation.isPending && (
                <div className="text-center text-sm text-gray-500">Adicionando cliente à rota...</div>
              )}
            </TabsContent>
            <TabsContent value="lead" className="space-y-4">
              <div>
                <Input
                  placeholder="Buscar lead por nome..."
                  value={leadSearchQuery}
                  onChange={(e) => setLeadSearchQuery(e.target.value)}
                  data-testid="input-lead-search"
                />
              </div>
              <div className="max-h-96 overflow-y-auto border rounded-lg">
                {leads && leads.length > 0 ? (
                  leads.filter((lead: any) => {
                    if (!leadSearchQuery) return true;
                    const query = leadSearchQuery.toLowerCase();
                    return lead.fantasyName?.toLowerCase().includes(query);
                  }).map((lead: any) => (
                    <div
                      key={lead.id}
                      className={`p-3 border-b last:border-b-0 hover:bg-purple-50 dark:hover:bg-purple-950 ${
                        addLeadMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                      onClick={() => {
                        if (route?.id && !addLeadMutation.isPending) {
                          addLeadMutation.mutate({ routeId: route.id, leadId: lead.id });
                        }
                      }}
                      data-testid={`lead-option-${lead.id}`}
                    >
                      <div className="font-medium flex items-center gap-2">
                        <Target className="h-4 w-4 text-purple-600" />
                        {lead.fantasyName}
                      </div>
                      {lead.contact && <div className="text-sm text-gray-500">{lead.contact}</div>}
                      {lead.phone && (
                        <div className="text-xs" onClick={(e) => e.stopPropagation()}>
                          <EditablePhoneField 
                            customerId={lead.id}
                            phone={lead.phone}
                          />
                        </div>
                      )}
                      <div className="text-xs text-purple-600 mt-1">
                        Status: {lead.status === 'pending' ? 'Pendente' : lead.status}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-center text-gray-500">
                    {leadSearchQuery ? 'Nenhum lead encontrado' : 'Nenhum lead disponível'}
                  </div>
                )}
              </div>
              {addLeadMutation.isPending && (
                <div className="text-center text-sm text-gray-500">Adicionando lead à rota...</div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
