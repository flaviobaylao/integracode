import { useState, useMemo, useRef, useEffect } from "react";
import { compareSellersByType } from "@/lib/sellerOrder";
import { getBrazilDateISO } from '@/lib/brazilTimezone';
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
import { Route, MapPin, Calendar, User, CheckCircle, Clock, AlertCircle, Camera, Navigation, X, RefreshCw, Trash2, Plus, Zap, UtensilsCrossed, Target, Phone, DollarSign, ShoppingCart, FileText } from "lucide-react";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import type { DailyRouteResponse } from "@shared/schema";
import OmieInstanceBadge from "@/components/OmieInstanceBadge";
import RouteMap from "@/components/RouteMap";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import { calculateDistance, formatDistance, calculateRouteDistance } from "@/lib/geoUtils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, apiRequestMultipart, queryClient } from "@/lib/queryClient";
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
  const isTelemarketing = user?.role === 'telemarketing';
  // Administradores autorizados a EDITAR/ADICIONAR/REMOVER check-in e check-out (ajuste do sistema).
  const CHECKIN_ADMINS = ['cinthiamarque90@gmail.com', 'flavio@bebahonest.com.br', 'flaviobaylao@gmail.com'];
  const isCheckinAdmin = CHECKIN_ADMINS.includes((user?.email || '').toLowerCase().trim());
  
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
  const [selectedDate, setSelectedDate] = useState(getBrazilDateISO());
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
  
  // Estado para modal de atendimento virtual
  const [virtualServiceCustomer, setVirtualServiceCustomer] = useState<{ id: string; name: string } | null>(null);
  // Ajuste admin de check-in/out
  const [adminEditVisit, setAdminEditVisit] = useState<any>(null);
  const [adminCheckInTime, setAdminCheckInTime] = useState('');
  const [adminCheckOutTime, setAdminCheckOutTime] = useState('');
  const [adminSaving, setAdminSaving] = useState(false);
  // Sessão de "atendimento completo" assumida por um adm: usada para detectar alterações EFETIVAS (diff) e só então marcar o card.
  const [adminActingCustomerId, setAdminActingCustomerId] = useState<string | null>(null);
  const adminSnapshotRef = useRef<any>(null);

  // Busca e filtro das Visitas Presenciais
  const [presentialSearch, setPresentialSearch] = useState('');
  const [presentialFilter, setPresentialFilter] = useState<'todos' | 'atendidos' | 'pendentes'>('todos');

  // Estado para modal de ações de cliente virtual (escolher entre atendimento ou pedido)
  const [showVirtualActionModal, setShowVirtualActionModal] = useState(false);
  const [virtualActionCustomer, setVirtualActionCustomer] = useState<{ id: string; name: string } | null>(null);

  const { data: sellers } = useQuery<any[]>({
    queryKey: ['/api/users'],
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
    enabled: (isAdmin || isVendedor || isTelemarketing) && showAddVisitModal && addVisitTab === 'customer' && !!selectedSellerId,
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
    enabled: (isAdmin || isVendedor || isTelemarketing) && showAddVisitModal && addVisitTab === 'lead' && !!selectedSellerId,
  });

  const { data: response, isLoading, refetch, isFetching } = useQuery<DailyRouteResponse>({
    queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate],
    enabled: !!selectedSellerId && !!selectedDate,
    refetchInterval: 30000, // Atualiza automaticamente a cada 30 segundos
  });

  // Buscar pedidos do dia e débitos para os clientes da rota
  interface CustomerInfoResponse {
    orders: Record<string, { cardNumber: string | null; omieOrderId: string | null; saleValue?: number | string | null }[]>;
    debts: Record<string, number>;
  }
  
  const routeId = response?.route?.id;
  const { data: customerInfo, refetch: refetchCustomerInfo, isFetching: isFetchingCustomerInfo } = useQuery<CustomerInfoResponse>({
    queryKey: ['/api/daily-routes', routeId, 'customer-info', selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/daily-routes/${routeId}/customer-info?date=${selectedDate}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch customer info');
      return res.json();
    },
    enabled: !!routeId && !!selectedDate,
    staleTime: 60000, // Cache por 1 minuto
  });

  // Query para contagem de atendimentos virtuais por vendedor na data
  interface VirtualServiceData {
    count: number;
    attendedCustomerIds: string[];
  }
  const { data: virtualServiceData } = useQuery<VirtualServiceData>({
    queryKey: ['/api/service-logs/count/customer', selectedSellerId, selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/service-logs/count/customer?sellerId=${selectedSellerId}&date=${selectedDate}`, {
        credentials: 'include',
      });
      if (!res.ok) return { count: 0, attendedCustomerIds: [] };
      const data = await res.json();
      return { count: data.count || 0, attendedCustomerIds: data.attendedCustomerIds || [] };
    },
    enabled: !!selectedSellerId && !!selectedDate,
  });
  const virtualServiceCount = virtualServiceData?.count || 0;
  const attendedCustomerIds = useMemo(() => new Set(virtualServiceData?.attendedCustomerIds || []), [virtualServiceData?.attendedCustomerIds]);

  // Clientes com visita no dia SEM coordenada (ficam fora da rota otimizada)
  interface MissingCoordsData { count: number; customers: { id: string; name: string; city: string | null }[] }
  const { data: missingCoords } = useQuery<MissingCoordsData>({
    queryKey: ['/api/admin/routes/missing-coords', selectedSellerId, selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/admin/routes/missing-coords?sellerId=${selectedSellerId}&date=${selectedDate}`, { credentials: 'include' });
      if (!res.ok) return { count: 0, customers: [] };
      return res.json();
    },
    enabled: !!selectedSellerId && !!selectedDate,
    staleTime: 60000,
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

      return await apiRequestMultipart('POST', `/api/leads/${leadId}/check-in`, formData);
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
  const adminAdjustments: Record<string, any> = (route as any)?.adminAdjustments || {};

  // Abrir o diálogo de ajuste admin de check-in/out para uma visita
  const openAdminEdit = (visit: any, checkInCp: any, checkOutCp: any) => {
    setAdminEditVisit({ visit, checkInCp, checkOutCp });
    setAdminCheckInTime(checkInCp ? formatInTimeZone(checkInCp.checkpointTime, 'America/Sao_Paulo', 'HH:mm') : '');
    setAdminCheckOutTime(checkOutCp ? formatInTimeZone(checkOutCp.checkpointTime, 'America/Sao_Paulo', 'HH:mm') : '');
  };

  const invalidateRoute = () => queryClient.invalidateQueries({ queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate] });

  // Salvar ajustes: compara o que existia com o que o admin digitou e chama editar/adicionar/remover
  const saveAdminCheckpoints = async () => {
    if (!adminEditVisit || !route?.id) return;
    const { visit, checkInCp, checkOutCp } = adminEditVisit;
    const rid = route.id;
    const applyField = async (cp: any, newTime: string, type: 'check_in' | 'check_out') => {
      const t = (newTime || '').trim();
      if (cp && !t) {
        await apiRequest('DELETE', `/api/daily-routes/checkpoints/${cp.id}/admin`);
      } else if (cp && t) {
        const cur = formatInTimeZone(cp.checkpointTime, 'America/Sao_Paulo', 'HH:mm');
        if (cur !== t) await apiRequest('PATCH', `/api/daily-routes/checkpoints/${cp.id}/admin-edit`, { time: t });
      } else if (!cp && t) {
        await apiRequest('POST', `/api/daily-routes/${rid}/checkpoints/admin-add`, { customerId: visit.customerId, checkpointType: type, time: t });
      }
    };
    try {
      setAdminSaving(true);
      await applyField(checkInCp, adminCheckInTime, 'check_in');
      await applyField(checkOutCp, adminCheckOutTime, 'check_out');
      toast({ title: 'Check-in/out ajustado', description: 'As alterações foram salvas (card marcado como ajuste Adm).' });
      setAdminEditVisit(null);
      invalidateRoute();
    } catch (e: any) {
      toast({ title: 'Erro ao ajustar', description: e?.message || 'Falha ao salvar o ajuste.', variant: 'destructive' });
    } finally {
      setAdminSaving(false);
    }
  };

  // "Fotografa" o estado atual da visita (check-in/out + pedidos) para depois detectar ALTERAÇÕES EFETIVAS.
  const buildVisitSnapshot = (customerId: string) => {
    const cps = (route?.checkpoints || []).filter((cp: any) => cp.customerId === customerId);
    const ci = cps.find((cp: any) => cp.checkpointType === 'check_in');
    const co = cps.find((cp: any) => cp.checkpointType === 'check_out');
    const ords = (customerId && customerInfo?.orders?.[customerId]) || [];
    return {
      checkIn: ci?.checkpointTime ? formatInTimeZone(ci.checkpointTime, 'America/Sao_Paulo', 'HH:mm') : null,
      checkOut: co?.checkpointTime ? formatInTimeZone(co.checkpointTime, 'America/Sao_Paulo', 'HH:mm') : null,
      orderCount: ords.length,
      orderValue: ords.reduce((s: number, o: any) => s + (Number(o.saleValue) || 0), 0),
    };
  };

  // Abrir o ATENDIMENTO COMPLETO como Adm: NÃO marca o card ao abrir; apenas fotografa o estado e abre a tela.
  // O card só ficará roxo se o adm efetivamente alterar algo (detectado por diff no useEffect abaixo).
  const openFullAttendanceAsAdmin = async () => {
    if (!adminEditVisit || !route?.id) return;
    const visit = adminEditVisit.visit;
    const cid = visit.customerId || visit.entityId;
    try {
      setAdminSaving(true);
      adminSnapshotRef.current = buildVisitSnapshot(cid);
      setAdminActingCustomerId(cid);
      setAdminEditVisit(null);
      // Abre a mesma tela de atendimento do vendedor (check-in, check-out, registrar pedido, não venda)
      await handleVisitClick(cid, false);
    } catch (e: any) {
      toast({ title: 'Erro ao abrir atendimento', description: e?.message || 'Falha ao assumir o atendimento.', variant: 'destructive' });
    } finally {
      setAdminSaving(false);
    }
  };

  // Detecta ALTERAÇÕES EFETIVAS durante a sessão de atendimento do adm e registra cada uma como histórico (de -> para).
  useEffect(() => {
    const cid = adminActingCustomerId;
    if (!cid || !route?.id || !adminSnapshotRef.current) return;
    const before = adminSnapshotRef.current;
    const after = buildVisitSnapshot(cid);
    const diffs: Array<{ field: string; from: any; to: any }> = [];
    if (before.checkIn !== after.checkIn) diffs.push({ field: 'Check-in', from: before.checkIn, to: after.checkIn });
    if (before.checkOut !== after.checkOut) diffs.push({ field: 'Check-out', from: before.checkOut, to: after.checkOut });
    if (before.orderCount !== after.orderCount || before.orderValue !== after.orderValue) {
      const fmt = (s: any) => `${s.orderCount} pedido(s) / R$ ${Number(s.orderValue || 0).toFixed(2)}`;
      diffs.push({ field: 'Pedido', from: fmt(before), to: fmt(after) });
    }
    if (diffs.length === 0) return;
    adminSnapshotRef.current = after; // evita re-registrar a mesma alteração
    (async () => {
      try {
        for (const d of diffs) {
          await apiRequest('POST', `/api/daily-routes/${route.id}/checkpoints/admin-record`, { customerId: cid, field: d.field, from: d.from, to: d.to });
        }
        invalidateRoute();
      } catch (e) {
        // silencioso: não impedir o atendimento por falha ao registrar histórico
      }
    })();
  }, [route?.checkpoints, customerInfo, adminActingCustomerId]);

  const virtualVisitsCount = useMemo(() => {
    if (!route?.visits) return 0;
    return (route.visits || []).filter((v: any) => v.isVirtual || v.visitType === 'virtual').length;
  }, [route?.visits]);

  // Métricas de PEDIDOS sobre as CONCLUÍDAS = visitas físicas realizadas (check-out) + atendimentos virtuais realizados.
  // Visitas com Pedidos  = concluídas que tiveram pedido implantado
  // Valor Visitas c/ Ped = soma dos pedidos das concluídas
  // Visitas Sem Pedido   = concluídas SEM registro de pedido
  const orderStats = useMemo(() => {
    // Universo de concluídas por customerId
    const concluidas = new Set<string>();
    (route?.checkpoints || []).forEach((cp: any) => { if (cp.checkpointType === 'check_out' && cp.customerId) concluidas.add(cp.customerId); });
    attendedCustomerIds.forEach((id: any) => { if (id) concluidas.add(String(id)); });
    let comPedidos = 0;
    let valor = 0;
    let semPedido = 0;
    concluidas.forEach((cid: string) => {
      const ords = (customerInfo?.orders?.[cid]) || [];
      if (ords.length > 0) {
        comPedidos++;
        valor += ords.reduce((s: number, o: any) => s + (Number(o.saleValue) || 0), 0);
      } else {
        semPedido++;
      }
    });
    return { comPedidos, semPedido, valor, totalConcluidas: concluidas.size };
  }, [route?.checkpoints, customerInfo, attendedCustomerIds]);

  // Visitas presenciais (exclui virtuais)
  const presentialVisits = useMemo(
    () => (route?.visits || []).filter((v: any) => !v.isVirtual && v.visitType !== 'virtual'),
    [route?.visits]
  );
  // Clientes com check-out realizado = "Atendidos" (concluídos); demais = "Pendentes"
  const checkedOutCustomerIds = useMemo(() => {
    const s = new Set<string>();
    (route?.checkpoints || []).forEach((cp: any) => { if (cp.checkpointType === 'check_out') s.add(cp.customerId); });
    return s;
  }, [route?.checkpoints]);
  // Aplica busca por cliente + filtro Atendidos/Pendentes
  const filteredPresentialVisits = useMemo(() => {
    const q = presentialSearch.trim().toLowerCase();
    return presentialVisits.filter((v: any) => {
      if (q && !((v.customerName || '').toLowerCase().includes(q))) return false;
      const atendido = checkedOutCustomerIds.has(v.customerId);
      if (presentialFilter === 'atendidos') return atendido;
      if (presentialFilter === 'pendentes') return !atendido;
      return true;
    });
  }, [presentialVisits, checkedOutCustomerIds, presentialSearch, presentialFilter]);

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
    // Encerra a sessão de atendimento assumida pelo adm (para de monitorar diffs)
    setAdminActingCustomerId(null);
    adminSnapshotRef.current = null;
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

      {/* 🎨 Legenda das cores dos cards */}
      <div className="mb-6 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
        <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2">Legenda das cores</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700 dark:text-gray-300">
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-gray-300 bg-gray-100 dark:bg-gray-700"></span>Aguardando (sem check-in)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-blue-300 bg-blue-100 dark:bg-blue-900"></span>Check-in realizado (em atendimento)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-green-300 bg-green-100 dark:bg-green-900"></span>Visita concluída (check-out)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-red-300 bg-red-100 dark:bg-red-900"></span>Check-in/out fora do local (&gt;100m)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border-2 border-purple-800 bg-purple-200 dark:bg-purple-900"></span>Ação do Adm</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm border border-amber-500 bg-amber-100 dark:bg-amber-900"></span>Lead</span>
        </div>
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
                  {sellers?.filter(s => s.isActive && (s.role === 'vendedor' || s.role === 'telemarketing')).sort(compareSellersByType).map((seller) => (
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

      {!!missingCoords && missingCoords.count > 0 && (
        <div className="mb-6 p-4 rounded-md border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200 text-sm" data-testid="banner-missing-coords">
          <strong>{missingCoords.count} cliente(s) da agenda deste dia SEM coordenada</strong> — ficam fora da rota otimizada. Atualize o cadastro (lat/long): {missingCoords.customers.map((c) => c.name).join(', ')}
        </div>
      )}

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
      ) : !route ? (
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
                  <Badge variant={route.routeStatus === 'completed' ? 'default' : 'secondary'}>
                    {route.routeStatus === 'completed' ? 'Concluída' : 'Em andamento'}
                  </Badge>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                // Presenciais
                const presTotal = route.totalVisits || 0;
                // Concluídas = clientes presenciais distintos com CHECK-OUT ao vivo (coerente com "Visitas Sem Pedido")
                const presConcl = presentialVisits.filter((v: any) => v.customerId && checkedOutCustomerIds.has(v.customerId)).length;
                const presPend = Math.max(0, presTotal - presConcl);
                const presPct = presTotal > 0 ? Math.round((presConcl / presTotal) * 100) : 0;
                // Virtuais
                const virtTotal = virtualVisitsCount || 0;
                const virtConcl = virtualServiceCount || 0;
                const virtPend = Math.max(0, virtTotal - virtConcl);
                const virtPct = virtTotal > 0 ? Math.round((virtConcl / virtTotal) * 100) : 0;
                return (
              <div className="space-y-5">
                {/* Linha 1 — Visitas Presenciais */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Visitas Presenciais</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-blue-100 dark:bg-blue-900 rounded-lg">
                        <MapPin className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Total de Visitas</p>
                        <p className="text-2xl font-bold" data-testid="pres-total">{presTotal}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-green-100 dark:bg-green-900 rounded-lg">
                        <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Concluídas</p>
                        <p className="text-2xl font-bold" data-testid="pres-concluidas">{presConcl}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-yellow-100 dark:bg-yellow-900 rounded-lg">
                        <Clock className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Pendentes</p>
                        <p className="text-2xl font-bold" data-testid="pres-pendentes">{presPend}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-lime-100 dark:bg-lime-900 rounded-lg">
                        <Target className="h-6 w-6 text-lime-600 dark:text-lime-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">% Atendimento</p>
                        <p className="text-2xl font-bold" data-testid="attendance-percentage">{presPct}%</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Linha 2 — Atendimentos Virtuais */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Atendimentos Virtuais</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-cyan-100 dark:bg-cyan-900 rounded-lg">
                        <FileText className="h-6 w-6 text-cyan-600 dark:text-cyan-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Total de Atendimentos</p>
                        <p className="text-2xl font-bold" data-testid="virt-total">{virtTotal}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-green-100 dark:bg-green-900 rounded-lg">
                        <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Concluídas</p>
                        <p className="text-2xl font-bold" data-testid="virt-concluidas">{virtConcl}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-yellow-100 dark:bg-yellow-900 rounded-lg">
                        <Clock className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Pendentes</p>
                        <p className="text-2xl font-bold" data-testid="virt-pendentes">{virtPend}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-lime-100 dark:bg-lime-900 rounded-lg">
                        <Target className="h-6 w-6 text-lime-600 dark:text-lime-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">% Atendimento</p>
                        <p className="text-2xl font-bold" data-testid="virt-percentage">{virtPct}%</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Linha 3 — Pedidos (sobre as Concluídas: presenciais realizadas + atend. virtuais realizados) */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Pedidos das Concluídas (Presenciais + Virtuais)</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-emerald-100 dark:bg-emerald-900 rounded-lg">
                        <ShoppingCart className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Visitas com Pedidos</p>
                        <p className="text-2xl font-bold" data-testid="visits-with-orders">{orderStats.comPedidos}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-green-100 dark:bg-green-900 rounded-lg">
                        <DollarSign className="h-6 w-6 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Valor Visitas com Pedidos</p>
                        <p className="text-xl font-bold" data-testid="orders-value">
                          R$ {orderStats.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-orange-100 dark:bg-orange-900 rounded-lg">
                        <MapPin className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                      </div>
                      <div>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Visitas Sem Pedido</p>
                        <p className="text-2xl font-bold" data-testid="visits-without-orders">{orderStats.semPedido}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
                );
              })()}
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
                  virtualVisits={((route.visits || []).filter((v: any) => v.isVirtual || v.visitType === 'virtual')).map((visit: any) => ({
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

          {/* Empty Route State - Show Button to Add Visits */}
          {route.visits?.length === 0 && (isAdmin || isVendedor || isTelemarketing) && (
            <Card className="mb-6 border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20">
              <CardContent className="py-8 text-center">
                <div className="flex flex-col items-center gap-4">
                  <Target className="h-12 w-12 text-blue-600 dark:text-blue-400" />
                  <div>
                    <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-1">Rota Vazia</h3>
                    <p className="text-sm text-blue-700 dark:text-blue-300 mb-4">
                      Clique no botão abaixo para adicionar clientes/leads a esta rota
                    </p>
                  </div>
                  <Button
                    variant="default"
                    onClick={() => setShowAddVisitModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800"
                    data-testid="button-add-visits-to-empty-route"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Adicionar Visitas à Rota
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle className="whitespace-nowrap">
                  Visitas Presenciais ({filteredPresentialVisits.length}{filteredPresentialVisits.length !== presentialVisits.length ? ` de ${presentialVisits.length}` : ''})
                </CardTitle>
                {/* Busca por cliente + filtro Atendidos/Pendentes */}
                <div className="flex flex-1 flex-wrap items-center gap-2 lg:justify-center">
                  <Input
                    placeholder="Buscar cliente..."
                    value={presentialSearch}
                    onChange={(e) => setPresentialSearch(e.target.value)}
                    className="h-9 w-full sm:max-w-xs"
                    data-testid="input-presential-search"
                  />
                  <Select value={presentialFilter} onValueChange={(v) => setPresentialFilter(v as 'todos' | 'atendidos' | 'pendentes')}>
                    <SelectTrigger className="h-9 w-[150px]" data-testid="select-presential-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todos">Todos</SelectItem>
                      <SelectItem value="atendidos">Atendidos</SelectItem>
                      <SelectItem value="pendentes">Pendentes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(isAdmin || isVendedor || isTelemarketing) && route.id && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => refetchCustomerInfo()}
                      disabled={isFetchingCustomerInfo}
                      className="flex items-center gap-2"
                      data-testid="button-refresh-debts"
                    >
                      <RefreshCw className={`h-4 w-4 ${isFetchingCustomerInfo ? 'animate-spin' : ''}`} />
                      {isFetchingCustomerInfo ? 'Atualizando...' : 'Atualizar Débitos'}
                    </Button>
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
                {filteredPresentialVisits.map((visit: any, index: number) => {
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
                    // LEADs aparecem em AMARELO OURO, com variações baseadas no status
                    if (hasOffsite) {
                      statusColor = 'text-red-600 dark:text-red-400';
                      borderColor = 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950';
                    } else if (isCompleted) {
                      statusColor = 'text-amber-700 dark:text-amber-300';
                      borderColor = 'border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950';
                    } else if (isInProgress) {
                      statusColor = 'text-amber-600 dark:text-amber-400';
                      borderColor = 'border-amber-500 dark:border-amber-600 bg-amber-50 dark:bg-amber-950';
                    } else {
                      statusColor = 'text-amber-600 dark:text-amber-400';
                      borderColor = 'border-amber-500 dark:border-amber-700';
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

                  // 🟣 Ajuste feito por administrador tem prioridade visual — SÓ quando houve alteração EFETIVA (histórico não vazio).
                  const adminMark = adminAdjustments[visit.customerId];
                  const adminChanges: any[] = (adminMark && Array.isArray(adminMark.changes)) ? adminMark.changes : [];
                  const hasAdminChange = adminChanges.length > 0;
                  if (hasAdminChange) {
                    statusColor = 'text-purple-900 dark:text-purple-200';
                    borderColor = 'border-2 border-purple-800 dark:border-purple-400 bg-purple-200 dark:bg-purple-900 ring-1 ring-purple-800 dark:ring-purple-500';
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
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <p className={`font-semibold ${statusColor} flex items-center gap-1`}>
                                {isLead && <Target className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
                                {visit.customerName}
                              </p>
                              <OmieInstanceBadge instanceId={(visit as any).omieInstanceId} />
                              {isLead && (
                                <Badge variant="outline" className="text-xs border-amber-500 text-amber-700 dark:text-amber-400">
                                  Lead
                                </Badge>
                              )}
                              {/* 🟣 Tag de ajuste administrativo (só quando houve alteração efetiva) */}
                              {hasAdminChange && (
                                <Badge variant="outline" className="text-xs border-purple-700 text-purple-900 bg-purple-100 dark:text-purple-200 dark:bg-purple-900 dark:border-purple-400" data-testid={`adm-tag-${visit.customerId}`}>
                                  Adm - {adminMark.by}
                                </Badge>
                              )}
                              {/* ✏️ Botão de ajuste admin de check-in/out (só admins autorizados) */}
                              {isCheckinAdmin && !isLead && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); openAdminEdit(visit, checkInCheckpoint, checkOutCheckpoint); }}
                                  className="inline-flex items-center gap-1 text-xs text-purple-700 dark:text-purple-300 border border-purple-300 dark:border-purple-700 rounded px-1.5 py-0.5 hover:bg-purple-50 dark:hover:bg-purple-950"
                                  data-testid={`admin-edit-checkin-${visit.customerId}`}
                                  title="Ajustar / assumir atendimento (Adm)"
                                >
                                  <Clock className="h-3 w-3" /> Ajustar
                                </button>
                              )}
                              {/* Mostrar pedidos do dia */}
                              {visit.customerId && customerInfo?.orders[visit.customerId]?.map((order: any, orderIdx: number) => (
                                <Badge 
                                  key={orderIdx}
                                  variant="default" 
                                  className="text-xs bg-green-600 hover:bg-green-700"
                                  data-testid={`order-badge-${visit.customerId}-${orderIdx}`}
                                >
                                  <ShoppingCart className="h-3 w-3 mr-1" />
                                  {order.omieOrderId || order.cardNumber || 'Pedido'}
                                </Badge>
                              ))}
                              {/* Mostrar débito vencido */}
                              {visit.customerId && customerInfo?.debts[visit.customerId] && customerInfo.debts[visit.customerId] > 0 && (
                                <Badge 
                                  variant="destructive" 
                                  className="text-xs"
                                  data-testid={`debt-badge-${visit.customerId}`}
                                >
                                  <DollarSign className="h-3 w-3 mr-1" />
                                  R$ {customerInfo.debts[visit.customerId].toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
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

                            {/* 🟣 Histórico de alterações do administrador (de → para) */}
                            {hasAdminChange && (
                              <div className="mb-2 rounded-md border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 p-2" data-testid={`adm-history-${visit.customerId}`}>
                                <p className="text-[11px] font-semibold text-purple-800 dark:text-purple-300 mb-1 flex items-center gap-1">
                                  <Clock className="h-3 w-3" /> Histórico de alterações (Adm)
                                </p>
                                <ul className="space-y-0.5">
                                  {adminChanges.map((ch: any, ci: number) => (
                                    <li key={ci} className="text-[11px] text-purple-900 dark:text-purple-200">
                                      <span className="font-medium">{ch.field}:</span>{' '}
                                      <span className="line-through opacity-70">{ch.from ?? '—'}</span>
                                      {' → '}
                                      <span className="font-semibold">{ch.to ?? '—'}</span>
                                      <span className="text-purple-500 dark:text-purple-400"> · {ch.by}{ch.at ? ` · ${formatInTimeZone(ch.at, 'America/Sao_Paulo', 'dd/MM HH:mm')}` : ''}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {!isLead && ((visit as any).weekdays || (visit as any).visitPeriodicity) && (
                              <p className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1 mb-2 font-medium">
                                <Calendar className="h-3 w-3" />
                                {formatWeekdaysLocal((visit as any).weekdays)}
                                {(visit as any).weekdays && (visit as any).visitPeriodicity && ' • '}
                                {formatPeriodicity((visit as any).visitPeriodicity)}
                              </p>
                            )}

                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <span className="text-gray-500">Check-in: </span>
                                  {checkInCheckpoint ? (
                                    <div>
                                      <span className={`font-medium ${checkInOffsite ? 'text-red-600' : statusColor}`} data-testid={`checkin-time-${visit.customerId}`}>
                                        {formatInTimeZone(checkInCheckpoint.checkpointTime, 'America/Sao_Paulo', 'HH:mm', { locale: ptBR })}
                                        {checkInOffsite && ` ⚠️ ${formatDistance(checkInDistance!)}`}
                                      </span>
                                      {checkInCheckpoint.latitude && checkInCheckpoint.longitude && (
                                        <div className="text-gray-400 text-xs mt-1">
                                          <div>Lat: {parseFloat(checkInCheckpoint.latitude.toString()).toFixed(6)}</div>
                                          <div>Lon: {parseFloat(checkInCheckpoint.longitude.toString()).toFixed(6)}</div>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </div>
                                <div>
                                  <span className="text-gray-500">Check-out: </span>
                                  {checkOutCheckpoint ? (
                                    <div>
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
                                      {checkOutCheckpoint.latitude && checkOutCheckpoint.longitude && (
                                        <div className="text-gray-400 text-xs mt-1">
                                          <div>Lat: {parseFloat(checkOutCheckpoint.latitude.toString()).toFixed(6)}</div>
                                          <div>Lon: {parseFloat(checkOutCheckpoint.longitude.toString()).toFixed(6)}</div>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </div>
                              </div>

                              {/* Observação/Comentário do Lead */}
                              {isLead && (visit as any).observation && (
                                <div className="border-l-2 border-amber-400 pl-2 py-1 text-xs text-gray-600 dark:text-gray-400 bg-amber-50 dark:bg-amber-950/20 rounded px-2">
                                  <span className="font-semibold text-amber-700 dark:text-amber-300">Comentário: </span>
                                  {(visit as any).observation}
                                </div>
                              )}
                            </div>

                            {hasOffsite && (
                              <div className="mt-2 text-xs text-red-600 dark:text-red-400 font-medium">
                                ⚠️ {checkInOffsite && 'Check-in fora do local'}{checkInOffsite && checkOutOffsite && ' | '}{checkOutOffsite && 'Check-out fora do local'}
                              </div>
                            )}
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-1">
                          {/* Botão Atendimento Virtual (apenas para clientes, não leads) */}
                          {!isLead && visit.customerId && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                              onClick={(e) => {
                                e.stopPropagation();
                                setVirtualServiceCustomer({ 
                                  id: visit.customerId, 
                                  name: visit.customerName 
                                });
                              }}
                              data-testid={`button-virtual-service-${visit.customerId}`}
                              title="Registrar Atendimento Virtual"
                            >
                              <FileText className="h-4 w-4" />
                            </Button>
                          )}
                          
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
                          
                          {/* Botão Deletar (admin e vendedor) */}
                          {(isAdmin || isVendedor || isTelemarketing) && route.id && (
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

                {filteredPresentialVisits.length === 0 && presentialVisits.length > 0 && (
                  <div className="text-center py-6 text-sm text-gray-500 dark:text-gray-400" data-testid="presential-empty">
                    Nenhuma visita corresponde à busca/filtro.
                  </div>
                )}

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
                        {virtualVisits.map((visit, index) => {
                          const isAttended = visit.customerId && attendedCustomerIds.has(visit.customerId);
                          return (
                          <div
                            key={visit.id || visit.customerId}
                            className={`p-3 border rounded-lg hover:shadow-md transition-all cursor-pointer ${
                              isAttended 
                                ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950' 
                                : 'border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950'
                            }`}
                            data-testid={`virtual-visit-${visit.customerId}`}
                            onClick={() => {
                              if (visit.customerId) {
                                setVirtualActionCustomer({ 
                                  id: visit.customerId, 
                                  name: visit.customerName 
                                });
                                setShowVirtualActionModal(true);
                              }
                            }}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3 flex-1">
                                <div className={`flex-shrink-0 w-6 h-6 rounded-full text-white flex items-center justify-center text-xs font-semibold ${isAttended ? 'bg-green-500' : 'bg-blue-500'}`}>
                                  {index + 1}
                                </div>
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                                      <Phone className="h-4 w-4" />
                                      {visit.customerName}
                                    </p>
                                    {/* Mostrar pedidos do dia */}
                                    {visit.customerId && customerInfo?.orders[visit.customerId]?.map((order: any, orderIdx: number) => (
                                      <Badge 
                                        key={orderIdx}
                                        variant="default" 
                                        className="text-xs bg-green-600 hover:bg-green-700"
                                        data-testid={`virtual-order-badge-${visit.customerId}-${orderIdx}`}
                                      >
                                        <ShoppingCart className="h-3 w-3 mr-1" />
                                        {order.omieOrderId || order.cardNumber || 'Pedido'}
                                      </Badge>
                                    ))}
                                    {/* Mostrar débito vencido */}
                                    {visit.customerId && customerInfo?.debts[visit.customerId] && customerInfo.debts[visit.customerId] > 0 && (
                                      <Badge 
                                        variant="destructive" 
                                        className="text-xs"
                                        data-testid={`virtual-debt-badge-${visit.customerId}`}
                                      >
                                        <DollarSign className="h-3 w-3 mr-1" />
                                        R$ {customerInfo.debts[visit.customerId].toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                      </Badge>
                                    )}
                                  </div>
                                  {(visit as any).phone && (
                                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                      📱 {(visit as any).phone}
                                    </p>
                                  )}
                                  {visit.customerAddress && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                      📍 {visit.customerAddress}
                                    </p>
                                  )}
                                </div>
                              </div>
                              {/* Botões de ação para visitas virtuais */}
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {/* Botão de Registro de Atendimento Virtual */}
                                {visit.customerId && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setVirtualServiceCustomer({ 
                                        id: visit.customerId!, 
                                        name: visit.customerName 
                                      });
                                    }}
                                    title="Registrar Atendimento Virtual"
                                    data-testid={`button-virtual-service-virtual-${visit.customerId}`}
                                  >
                                    <FileText className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                        })}
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

      {/* 🟣 Ajuste ADMIN de check-in/check-out */}
      <Dialog open={!!adminEditVisit} onOpenChange={(open) => { if (!open) setAdminEditVisit(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-purple-800 dark:text-purple-300">
              <Clock className="h-5 w-5" /> Atendimento / Ajuste (Adm)
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {adminEditVisit?.visit?.customerName}
            </p>

            <div className="rounded-lg border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 p-3 space-y-2">
              <p className="text-xs text-gray-600 dark:text-gray-300">
                Assumir o atendimento como administrador — abre a tela completa (check-in, check-out, registrar pedido, não venda). O card fica <strong>roxo escuro</strong> com a tag "Adm - {(user?.email || '').toLowerCase()}".
              </p>
              <Button className="w-full bg-purple-800 hover:bg-purple-900 text-white" onClick={openFullAttendanceAsAdmin} disabled={adminSaving} data-testid="admin-open-full-attendance">
                <FileText className="h-4 w-4 mr-2" /> Abrir atendimento completo
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Ou apenas ajuste os horários (HH:mm). Deixe em branco para <strong>remover</strong> o check-in/out. Também marca o card como ação do Adm.
              </p>
              <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Check-in</label>
                <Input type="time" value={adminCheckInTime} onChange={(e) => setAdminCheckInTime(e.target.value)} data-testid="admin-input-checkin" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Check-out</label>
                <Input type="time" value={adminCheckOutTime} onChange={(e) => setAdminCheckOutTime(e.target.value)} data-testid="admin-input-checkout" />
              </div>
            </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setAdminEditVisit(null)} disabled={adminSaving}>Cancelar</Button>
              <Button className="bg-purple-700 hover:bg-purple-800 text-white" onClick={saveAdminCheckpoints} disabled={adminSaving} data-testid="admin-save-checkpoints">
                {adminSaving ? 'Salvando...' : 'Salvar ajuste de horário'}
              </Button>
            </div>
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
                      const onGeoOk = (position: GeolocationPosition) => {
                        setCheckInCoords({
                          lat: position.coords.latitude,
                          lng: position.coords.longitude
                        });
                        toast({
                          title: "Localização capturada",
                          description: `Lat: ${position.coords.latitude.toFixed(6)}, Lng: ${position.coords.longitude.toFixed(6)}`
                        });
                      };
                      const onGeoErr = (err: any) => {
                        const code = err?.code;
                        const description = code === 1
                          ? 'Permissão de localização negada. Ative o GPS e permita o acesso à localização deste site.'
                          : code === 3
                          ? 'Tempo esgotado ao obter a localização. Verifique se o GPS está ligado e tente novamente.'
                          : 'Localização indisponível. Verifique se o GPS está ligado (de preferência próximo a uma janela).';
                        toast({ variant: "destructive", title: "Erro", description });
                      };
                      // 1a tentativa alta precisao; fallback baixa precisao (funciona em ambiente fechado)
                      navigator.geolocation.getCurrentPosition(
                        onGeoOk,
                        () => navigator.geolocation.getCurrentPosition(onGeoOk, onGeoErr, { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 }),
                        { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
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

      {/* Modal de Ações para Cliente Virtual */}
      <Dialog open={showVirtualActionModal} onOpenChange={setShowVirtualActionModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-blue-600" />
              Cliente Virtual
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-4">
              Cliente: <span className="font-semibold text-foreground">{virtualActionCustomer?.name}</span>
            </p>
            <div className="flex flex-col gap-3">
              <Button
                variant="outline"
                className="w-full justify-start h-12 text-left"
                onClick={() => {
                  if (virtualActionCustomer) {
                    setVirtualServiceCustomer(virtualActionCustomer);
                  }
                  setShowVirtualActionModal(false);
                }}
                data-testid="btn-virtual-register-service"
              >
                <FileText className="h-5 w-5 mr-3 text-blue-600" />
                <div>
                  <div className="font-medium">Registrar Atendimento</div>
                  <div className="text-xs text-muted-foreground">Registrar log de atendimento virtual</div>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start h-12 text-left"
                onClick={async () => {
                  if (virtualActionCustomer) {
                    setLoadingCardId(virtualActionCustomer.id);
                    setShowVirtualActionModal(false);
                    try {
                      const dateToUse = selectedDate || getBrazilDateISO();
                      const response = await fetch(`/api/customers/${virtualActionCustomer.id}/sales-card/${dateToUse}`, {
                        credentials: 'include'
                      });
                      if (!response.ok) {
                        throw new Error(`Falha ao buscar card de vendas: ${response.status}`);
                      }
                      const card = await response.json();
                      if (card && card.id) {
                        setSelectedCard(card);
                        setShowCardModal(true);
                      } else {
                        toast({
                          variant: "destructive",
                          title: "Erro",
                          description: "Não foi possível encontrar o card de venda para este cliente",
                        });
                      }
                    } catch (error) {
                      toast({
                        variant: "destructive",
                        title: "Erro",
                        description: error instanceof Error ? error.message : "Erro ao buscar card de venda",
                      });
                    } finally {
                      setLoadingCardId(null);
                    }
                  }
                }}
                data-testid="btn-virtual-register-order"
              >
                <ShoppingCart className="h-5 w-5 mr-3 text-green-600" />
                <div>
                  <div className="font-medium">Registrar Pedido</div>
                  <div className="text-xs text-muted-foreground">Abrir card de venda para registro de pedido</div>
                </div>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal de Atendimento Virtual */}
      {virtualServiceCustomer && (
        <VirtualServiceLogModal
          open={!!virtualServiceCustomer}
          onClose={() => setVirtualServiceCustomer(null)}
          customerId={virtualServiceCustomer.id}
          customerName={virtualServiceCustomer.name}
          entityType="customer"
          defaultServiceType="venda"
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/service-logs/count/customer', selectedSellerId, selectedDate] });
          }}
        />
      )}
    </div>
  );
}
