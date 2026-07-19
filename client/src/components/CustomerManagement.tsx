import { useActiveSellers, MultiSelect, multiMatch, exportToExcel, ExportExcelButton } from "@/lib/tableTools";
import { useState, Fragment } from "react";
import { parseISO } from "date-fns";
import { safeParseWeekdays } from '@/lib/weekdayParser';
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import CustomerModal from "./CustomerModal";
import CustomerDetailsModal from "./CustomerDetailsModal";
import OmieClientImport from "./OmieClientImport";
import OmieSyncManager from "./OmieSyncManager";
import CustomerExcelImport from "./CustomerExcelImport";
import WhatsAppButton from "./WhatsAppButton";
import GeocodeAllButton from "./GeocodeAllButton";
import CustomerHistoryBox from "./CustomerHistoryBox";
import type { Customer, User, CustomerWithSeller } from "@shared/schema";
import OmieInstanceBadge from "./OmieInstanceBadge";
import { Plus, Search, Edit, Trash2, MapPin, Phone, Mail, User as UserIcon, Building2, Download, RefreshCw, AlertTriangle, CheckCircle, XCircle, Clock, AlertCircle, Calendar, Upload, History, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

// Função para normalizar dias da semana de qualquer formato para o padrão abreviado
function normalizeWeekdays(weekdays: string | string[]): string[] {
  const weekdayMap: Record<string, string> = {
    // Formato abreviado (padrão) - minúsculo e maiúsculo, com e sem acento
    'seg': 'Seg', 'ter': 'Ter', 'qua': 'Qua', 'qui': 'Qui', 'sex': 'Sex', 'sab': 'Sab', 'dom': 'Dom',
    'SEG': 'Seg', 'TER': 'Ter', 'QUA': 'Qua', 'QUI': 'Qui', 'SEX': 'Sex', 'SAB': 'Sab', 'DOM': 'Dom',
    'sáb': 'Sab', 'SÁB': 'Sab', 'sáb.': 'Sab', 'SÁB.': 'Sab',
    // Formato completo português - minúsculo
    'segunda': 'Seg', 'terca': 'Ter', 'quarta': 'Qua', 'quinta': 'Qui', 'sexta': 'Sex', 'sabado': 'Sab', 'domingo': 'Dom',
    // Formato completo português - com acento
    'terça': 'Ter', 'sábado': 'Sab',
    // Formato completo português - maiúsculo
    'SEGUNDA': 'Seg', 'TERCA': 'Ter', 'TERÇA': 'Ter', 'QUARTA': 'Qua', 'QUINTA': 'Qui', 
    'SEXTA': 'Sex', 'SABADO': 'Sab', 'SÁBADO': 'Sab', 'DOMINGO': 'Dom',
    // Formato com "-feira" - minúsculo
    'segunda-feira': 'Seg', 'terca-feira': 'Ter', 'terça-feira': 'Ter',
    'quarta-feira': 'Qua', 'quinta-feira': 'Qui', 'sexta-feira': 'Sex',
    'sabado-feira': 'Sab', 'sábado-feira': 'Sab', 'domingo-feira': 'Dom',
    // Formato em inglês (legacy)
    'monday': 'Seg', 'tuesday': 'Ter', 'wednesday': 'Qua', 'thursday': 'Qui',
    'friday': 'Sex', 'saturday': 'Sab', 'sunday': 'Dom',
    'MONDAY': 'Seg', 'TUESDAY': 'Ter', 'WEDNESDAY': 'Qua', 'THURSDAY': 'Qui',
    'FRIDAY': 'Sex', 'SATURDAY': 'Sab', 'SUNDAY': 'Dom',
  };

  let weekdaysArray: string[] = [];
  
  // Se for string JSON, parsear
  if (typeof weekdays === 'string') {
    try {
      try {
      weekdaysArray = JSON.parse(weekdays);
    } catch {
      weekdaysArray = typeof weekdays === 'string'
        ? weekdays.split(/[,;/]/).map(d => d.trim()).filter(d => d)
        : [];
    }
    } catch {
      // Se não for JSON válido, tratar como array único
      weekdaysArray = [weekdays];
    }
  } else {
    weekdaysArray = weekdays || [];
  }

  // Normalizar cada dia
  return weekdaysArray
    .map(day => {
      const normalized = weekdayMap[day.toLowerCase().trim()];
      return normalized || day; // Se não encontrar no mapa, retorna original
    })
    .filter(day => day); // Remove valores vazios
}

export default function CustomerManagement() {
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [showOmieImport, setShowOmieImport] = useState(false);
  const [showOmieSync, setShowOmieSync] = useState(false);
  const [showExcelImport, setShowExcelImport] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [weekdayFilter, setWeekdayFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sellerFilter, setSellerFilter] = useState('all');
  const { sellerOptions, resolveSeller } = useActiveSellers();
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [nameSort, setNameSort] = useState<'asc' | 'desc' | null>(null);
  const [routeDateFilter, setRouteDateFilter] = useState('');
  const [positivationFilter, setPositivationFilter] = useState('all');
  const [segmentMulti, setSegmentMulti] = useState<string[]>([]);
  const [selectedVirtualType, setSelectedVirtualType] = useState('');
  const [selectedPeriodicity, setSelectedPeriodicity] = useState('');
  const [selectedPersonType, setSelectedPersonType] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedNeighborhood, setSelectedNeighborhood] = useState('');
  const [selectedCoords, setSelectedCoords] = useState(''); // "", "com", "sem"
  const [phoneFilter, setPhoneFilter] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: user } = useQuery<User>({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  const { data: customers = [], isLoading } = useQuery<CustomerWithSeller[]>({
    queryKey: ['/api/customers'],
    retry: false,
  });

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['/api/users'],
    retry: false,
  });

  const isAdmin = user?.role === 'admin';

  const bulkInactivateMutation = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selectedIds);
      const r: any = await apiRequest('POST', '/api/customers/bulk-inactivate', { ids });
      return await (r?.json ? r.json() : Promise.resolve({})).catch(() => ({}));
    },
    onSuccess: (res: any) => {
      const extra: string[] = [];
      if (res.alreadyInactive) extra.push(`${res.alreadyInactive} já estavam inativos`);
      if (res.deletedCards) extra.push(`${res.deletedCards} agendamento(s) futuro(s) removido(s)`);
      toast({ title: "Inativação em massa concluída", description: `${res.inactivated ?? 0} cliente(s) inativado(s)${extra.length ? ' · ' + extra.join(' · ') : ''}.` });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
    },
    onError: (e: any) => { toast({ title: "Erro na inativação em massa", description: e?.message || String(e), variant: "destructive" }); },
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/customers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Sucesso",
        description: "Cliente excluído com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkUpdateTimeSlotsMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('POST', '/api/customers/bulk-update-time-slots');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Sucesso",
        description: "Horários de recebimento configurados para todos os clientes (Segunda-Sexta: 08:00-18:00)",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleBulkUpdateTimeSlots = () => {
    if (confirm('Tem certeza que deseja configurar os horários de recebimento para TODOS os clientes cadastrados?\n\nHorários: Segunda-Sexta 08:00-18:00\n\nEsta ação não pode ser desfeita diretamente, mas os horários podem ser editados individualmente depois.')) {
      bulkUpdateTimeSlotsMutation.mutate();
    }
  };

  const [, navigate] = useLocation();

  const createChatConversationMutation = useMutation({
    mutationFn: async (data: { phone: string; customerName: string }) => {
      return apiRequest('/api/chat/conversations', 'POST', {
        customerPhone: data.phone,
        customerName: data.customerName
      });
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Conversa criada! Redirecionando..." });
      setTimeout(() => navigate('/telemarketing/atendimento'), 500);
    },
    onError: () => {
      toast({ title: "Erro", description: "Não foi possível criar a conversa", variant: "destructive" });
    }
  });

  const handleOpenWhatsApp = (phone: string, customerName: string) => {
    createChatConversationMutation.mutate({ phone, customerName });
  };

  const openWaze = (customer: any) => {
    if (!customer.latitude || !customer.longitude) {
      toast({
        title: "Localização não disponível",
        description: "É necessário cadastrar a latitude e longitude do cliente primeiro.",
        variant: "destructive",
      });
      return;
    }
    
    const wazeUrl = `https://waze.com/ul?ll=${customer.latitude},${customer.longitude}&navigate=yes&zoom=17`;
    window.open(wazeUrl, '_blank');
  };

  const filteredCustomers = customers?.filter((customer: any) => {
    const documentSearch = customer.cpf || customer.cnpj || customer.document || '';
    const fantasyName = customer.fantasyName || '';
    // Normalizar termos de busca removendo formatação (pontos, barras, hífens)
    const normalizedSearchTerm = searchTerm.replace(/[.\-\/\s]/g, '');
    const normalizedDocument = documentSearch.replace(/[.\-\/\s]/g, '');
    const normalizedPhone = customer.phone.replace(/[.\-\/\s()\s]/g, '');
    
    const matchesSearch = customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         fantasyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         normalizedDocument.includes(normalizedSearchTerm) ||
                         normalizedPhone.includes(normalizedSearchTerm);
    
    // Filtro por dia da semana
    let matchesWeekday = true;
    if (weekdayFilter !== 'all') {
      try {
        const normalizedWeekdays = normalizeWeekdays(customer.weekdays || '[]');
        matchesWeekday = normalizedWeekdays.includes(weekdayFilter);
      } catch {
        matchesWeekday = false;
      }
    }
    
    const matchesStatus = statusFilter === 'all' ||
                         (statusFilter === 'active' && customer.isActive !== false) ||
                         (statusFilter === 'inactive' && customer.isActive === false);
    const matchesSeller = sellerFilter === 'all' || customer.sellerId === sellerFilter;
    
    // Filtro por data da rota (verifica se a data está nos dias da semana selecionados)
    let matchesRouteDate = true;
    if (routeDateFilter) {
      const selectedDate = parseISO(routeDateFilter);
      const dayOfWeek = selectedDate.getDay(); // 0=domingo, 1=segunda, etc.
      const weekdayMapping = {
        0: 'Dom',
        1: 'Seg', 
        2: 'Ter',
        3: 'Qua',
        4: 'Qui',
        5: 'Sex',
        6: 'Sab'
      };
      const dayString = weekdayMapping[dayOfWeek as keyof typeof weekdayMapping];
      const normalizedWeekdays = normalizeWeekdays(customer.weekdays || '[]');
      matchesRouteDate = normalizedWeekdays.includes(dayString);
    }
    
    // Filtro por positivação
    const matchesPositivation = positivationFilter === 'all' ||
                               (positivationFilter === 'yes' && customer.isPositivatedThisMonth) ||
                               (positivationFilter === 'no' && !customer.isPositivatedThisMonth);
    
    const matchesSellerMulti = multiMatch(sellerMulti, resolveSeller((customer as any).sellerName || customer.sellerId));
    const matchesSegment = multiMatch(segmentMulti, customer.segmentoPrincipal || '(Sem segmento)');
    const matchesVirtualType = !selectedVirtualType || (selectedVirtualType === 'virtual' ? !!customer.virtualService : !customer.virtualService);
    const matchesPeriodicity = !selectedPeriodicity || customer.visitPeriodicity === selectedPeriodicity;
    const ptDigits = String(customer.cnpj || customer.cpf || '').replace(/\D/g, '');
    const personType = (customer as any).customerType || (ptDigits.length === 14 ? 'pessoa_juridica' : ptDigits.length === 11 ? 'pessoa_fisica' : '');
    const matchesPersonType = !selectedPersonType || personType === selectedPersonType;
    const matchesCity = !selectedCity || String(customer.city || '').trim() === selectedCity;
    const matchesNeighborhood = !selectedNeighborhood || String(customer.neighborhood || '').trim() === selectedNeighborhood;
    const matchesPhone = !phoneFilter || String(customer.phone || '').replace(/\D/g, '').includes(phoneFilter.replace(/\D/g, ''));
    const hasCoords = !!(customer.latitude && customer.longitude);
    const matchesCoords = !selectedCoords || (selectedCoords === 'com' ? hasCoords : !hasCoords);
    return matchesSearch && matchesWeekday && matchesStatus && matchesSeller && matchesSellerMulti && matchesRouteDate && matchesPositivation && matchesSegment && matchesVirtualType && matchesPeriodicity && matchesPersonType && matchesCity && matchesNeighborhood && matchesPhone && matchesCoords;
  }) || [];
  if (nameSort) filteredCustomers.sort((a: any, b: any) => { const cmp = String(a.name || a.fantasyName || '').localeCompare(String(b.name || b.fantasyName || ''), 'pt-BR', { sensitivity: 'base' }); return nameSort === 'asc' ? cmp : -cmp; });
  const selectableIds = filteredCustomers.map((c: any) => c.id).filter(Boolean) as string[];
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const toggleSelect = (id?: string) => { if (!id) return; setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const toggleSelectAll = () => { setSelectedIds((prev) => { if (selectableIds.length > 0 && selectableIds.every((id) => prev.has(id))) return new Set(); return new Set(selectableIds); }); };
  const segmentFilterOptions = [
    ...(Array.from(new Set((customers || []).map((c: any) => c.segmentoPrincipal).filter(Boolean))).sort((a: any, b: any) => String(a).localeCompare(String(b))) as string[]),
    ...((customers || []).some((c: any) => !c.segmentoPrincipal) ? ['(Sem segmento)'] : []),
  ];
  const cities = Array.from(new Set((customers || []).map((c: any) => String(c.city || '').trim()).filter(Boolean))).sort((a: any, b: any) => String(a).localeCompare(String(b), 'pt-BR'));
  const neighborhoods = Array.from(new Set((customers || []).filter((c: any) => !selectedCity || String(c.city || '').trim() === selectedCity).map((c: any) => String(c.neighborhood || '').trim()).filter(Boolean))).sort((a: any, b: any) => String(a).localeCompare(String(b), 'pt-BR'));

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'Nunca';
    return new Date(date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  };

  const renderLastActivityIcon = (status: string | undefined) => {
    switch (status) {
      case 'success':
        return <div title="Última venda realizada"><CheckCircle className="h-4 w-4 text-green-600" /></div>;
      case 'failed':
        return <div title="Última venda sem êxito"><XCircle className="h-4 w-4 text-red-600" /></div>;
      case 'pending':
        return <div title="Venda em andamento"><Clock className="h-4 w-4 text-blue-600" /></div>;
      case 'overdue':
        return <div title="Card atrasado"><AlertCircle className="h-4 w-4 text-purple-600" /></div>;
      case 'scheduled':
        return <div title="Card agendado"><Calendar className="h-4 w-4 text-orange-600" /></div>;
      default:
        return <div className="h-4 w-4" />; // Espaço vazio para manter alinhamento
    }
  };

  const getWeekdaysLabel = (weekdays: string) => {
    try {
      let days = JSON.parse(weekdays);
      
      // Mapeamento de formatos variados para abreviações em português
      const weekdayMap: { [key: string]: string } = {
        // Formato abreviado (já no padrão)
        'seg': 'Seg', 'ter': 'Ter', 'qua': 'Qua', 'qui': 'Qui', 'sex': 'Sex', 'sab': 'Sáb', 'dom': 'Dom',
        // Formato completo minúsculo
        'segunda': 'Seg', 'terca': 'Ter', 'quarta': 'Qua', 'quinta': 'Qui', 'sexta': 'Sex', 'sabado': 'Sáb', 'domingo': 'Dom',
        // Com acento
        'terça': 'Ter', 'sábado': 'Sáb',
        // Com "-feira"
        'segunda-feira': 'Seg', 'terca-feira': 'Ter', 'terça-feira': 'Ter',
        'quarta-feira': 'Qua', 'quinta-feira': 'Qui', 'sexta-feira': 'Sex',
        'sabado-feira': 'Sáb', 'sábado-feira': 'Sáb', 'domingo-feira': 'Dom',
        // Formato antigo em inglês (compatibilidade)
        'monday': 'Seg', 'tuesday': 'Ter', 'wednesday': 'Qua', 'thursday': 'Qui',
        'friday': 'Sex', 'saturday': 'Sáb', 'sunday': 'Dom',
      };
      
      // Normalizar e filtrar dias válidos
      const normalizedDays = days
        .map((day: string) => weekdayMap[day.toLowerCase().trim()] || day)
        .filter((day: string) => day);
      
      return normalizedDays.join(', ');
    } catch {
      return '-';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-800">Gestão de Clientes</h2>
        </div>
        <Card>
          <CardContent className="p-6">
            <div className="animate-pulse space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 bg-gray-200 rounded"></div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Gestão de Clientes</h2>
        <div className="flex space-x-2">
          <GeocodeAllButton />
          <Button
            variant="outline"
            className="border-orange-500 text-orange-600 hover:bg-orange-500 hover:text-white"
            onClick={() => setShowOmieSync(true)}
            data-testid="button-sync-omie"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Sincronizar Omie
          </Button>
          <Button
            variant="outline"
            className="border-honest-blue text-honest-blue hover:bg-honest-blue hover:text-white"
            onClick={() => setShowOmieImport(true)}
            data-testid="button-import-omie"
          >
            <Download className="h-4 w-4 mr-2" />
            Importar do Omie
          </Button>
          <Button
            variant="outline"
            className="border-green-500 text-green-600 hover:bg-green-500 hover:text-white"
            onClick={() => setShowExcelImport(true)}
            data-testid="button-import-excel"
          >
            <Upload className="h-4 w-4 mr-2" />
            Importar Excel
          </Button>
          {isAdmin && (
            <Button
              variant="outline"
              className="border-purple-500 text-purple-600 hover:bg-purple-500 hover:text-white"
              onClick={handleBulkUpdateTimeSlots}
              disabled={bulkUpdateTimeSlotsMutation.isPending}
              data-testid="button-bulk-update-time-slots"
            >
              <Clock className="h-4 w-4 mr-2" />
              {bulkUpdateTimeSlotsMutation.isPending ? 'Configurando...' : 'Configurar Horários em Massa'}
            </Button>
          )}
          <ExportExcelButton testId="export-customers" onClick={() => exportToExcel(filteredCustomers.map((c: any) => ({ Nome: c.name, Fantasia: c.fantasyName, Documento: c.cnpj || c.cpf, Telefone: c.phone, Vendedor: resolveSeller(c.sellerName || c.sellerId), Cidade: c.city, Bairro: c.neighborhood, Status: c.omieStatus, Periodicidade: c.visitPeriodicity, Segmento: c.segmentoPrincipal })), "clientes")} />
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white border border-blue-600"
            onClick={() => setShowModal(true)}
            data-testid="button-new-customer"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Cliente
          </Button>
        </div>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-row items-center gap-1 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 h-9"
                data-testid="input-search-customer"
              />
            </div>

            <MultiSelect label="Vendedor" options={sellerOptions} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller-customers" />

            <Select value={weekdayFilter} onValueChange={setWeekdayFilter}>
              <SelectTrigger className="w-[100px] h-9" data-testid="select-weekday-filter">
                <SelectValue placeholder="Dia" />
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

            <Select value={selectedVirtualType} onValueChange={setSelectedVirtualType}>
              <SelectTrigger className="w-[100px] h-9" data-testid="select-virtual-filter">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="presencial">Presencial</SelectItem>
                <SelectItem value="virtual">Virtual</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedPeriodicity} onValueChange={setSelectedPeriodicity}>
              <SelectTrigger className="w-[110px] h-9" data-testid="select-periodicity-filter">
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semanal">Semanal</SelectItem>
                <SelectItem value="quinzenal">Quinzenal</SelectItem>
                <SelectItem value="mensal">Mensal</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedPersonType} onValueChange={setSelectedPersonType}>
              <SelectTrigger className="w-[120px] h-9" data-testid="select-persontype-filter">
                <SelectValue placeholder="PJ / PF" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pessoa_juridica">Pessoa Jurídica</SelectItem>
                <SelectItem value="pessoa_fisica">Pessoa Física</SelectItem>
              </SelectContent>
            </Select>

            <MultiSelect label="Segmento" options={segmentFilterOptions} selected={segmentMulti} onChange={setSegmentMulti} testId="filter-segment-customers" />

            <Select value={positivationFilter} onValueChange={setPositivationFilter}>
              <SelectTrigger className="w-[120px] h-9" data-testid="select-positivation-filter">
                <SelectValue placeholder="Positivação" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="yes">Positivado</SelectItem>
                <SelectItem value="no">Não Positivado</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedCoords} onValueChange={setSelectedCoords}>
              <SelectTrigger className="w-[140px] h-9" data-testid="select-coords-filter">
                <SelectValue placeholder="Coordenadas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="com">Com coordenada</SelectItem>
                <SelectItem value="sem">Sem coordenada</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedCity} onValueChange={(val) => { setSelectedCity(val); setSelectedNeighborhood(''); }}>
              <SelectTrigger className="w-[130px] h-9" data-testid="select-city-filter">
                <SelectValue placeholder="Cidade" />
              </SelectTrigger>
              <SelectContent>
                {cities.map((city: any) => (<SelectItem key={city} value={city}>{city}</SelectItem>))}
              </SelectContent>
            </Select>

            <Select value={selectedNeighborhood} onValueChange={setSelectedNeighborhood}>
              <SelectTrigger className="w-[130px] h-9" data-testid="select-neighborhood-filter">
                <SelectValue placeholder="Bairro" />
              </SelectTrigger>
              <SelectContent>
                {neighborhoods.map((nb: any) => (<SelectItem key={nb} value={nb}>{nb}</SelectItem>))}
              </SelectContent>
            </Select>

            <div className="relative">
              <Phone className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Telefone"
                value={phoneFilter}
                onChange={(e) => setPhoneFilter(e.target.value)}
                className="w-[130px] h-9 pl-8"
                data-testid="input-phone-filter"
              />
            </div>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[110px] h-9" data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
              </SelectContent>
            </Select>

            <Input
              type="date"
              value={routeDateFilter}
              onChange={(e) => setRouteDateFilter(e.target.value)}
              className="w-[140px] h-9"
              data-testid="input-route-date-filter"
            />

            <div className="text-sm text-gray-600 flex items-center ml-1">
              {filteredCustomers.length} cliente(s)
            </div>
            {selectedIds.size > 0 && (
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white h-9 ml-1"
                onClick={() => { if (window.confirm(`Inativar ${selectedIds.size} cliente(s) selecionado(s)?\n\nEles ficarão inativos, sairão da lista de Clientes Ativos e seus agendamentos futuros pendentes serão removidos.`)) bulkInactivateMutation.mutate(); }}
                disabled={bulkInactivateMutation.isPending}
                data-testid="button-bulk-inactivate"
              >
                🚫 {bulkInactivateMutation.isPending ? "Inativando…" : `Inativar selecionados (${selectedIds.size})`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Customers Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[70vh] [&_th]:sticky [&_th]:top-0 [&_th]:bg-gray-50 [&_th]:z-10">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-4 text-left w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="Selecionar todos" data-testid="checkbox-select-all" />
                  </th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">
                    <button
                      onClick={() => setNameSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
                      className="flex items-center gap-1 hover:text-primary transition-colors"
                      data-testid="sort-name-customers"
                    >
                      Nome Fantasia
                      {nameSort ? (
                        nameSort === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />
                      ) : (
                        <ArrowUpDown className="h-4 w-4 opacity-50" />
                      )}
                    </button>
                  </th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Coordenadas</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Dias da Semana</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Periodicidade</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Positivado</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Última Atividade</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Situação</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredCustomers.length > 0 ? (
                  filteredCustomers.map((customer: CustomerWithSeller) => (
                    <Fragment key={customer.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-4 w-8">
                        <input type="checkbox" checked={selectedIds.has(customer.id)} onChange={() => toggleSelect(customer.id)} aria-label="Selecionar cliente" data-testid={`checkbox-select-${customer.id}`} />
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <button
                            className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                            onClick={() => {
                              setSelectedCustomer(customer);
                              setShowDetailsModal(true);
                            }}
                            data-testid={`button-customer-details-${customer.id}`}
                          >
                            {(customer as any).fantasyName || customer.name}
                          </button>
                          <OmieInstanceBadge instanceId={(customer as any).omieInstanceId} />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-xs text-gray-600 space-y-1">
                          {customer.latitude && customer.longitude ? (
                            <>
                              <div className="flex items-center gap-1">
                                <MapPin className="h-3 w-3 text-green-600" />
                                <span className="font-mono">{parseFloat(customer.latitude).toFixed(6)}</span>
                              </div>
                              <div className="font-mono">{parseFloat(customer.longitude).toFixed(6)}</div>
                            </>
                          ) : (
                            <span className="text-gray-400 italic">Não definido</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-700 font-medium">
                          {getWeekdaysLabel(customer.weekdays)}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600 capitalize">
                          {(customer as any).visitPeriodicity || 'Semanal'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {customer.isPositivatedThisMonth ? (
                          <span className="font-semibold text-green-600">SIM</span>
                        ) : (
                          <span className="font-semibold text-red-600">NÃO</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="text-sm text-gray-700">
                          {customer.lastActivityDate 
                            ? formatDate(customer.lastActivityDate)
                            : <span className="text-gray-400">Nunca</span>
                          }
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {customer.isActive === false ? (
                          <Badge className="bg-red-100 text-red-800" data-testid={`badge-inativo-${customer.id}`}>
                            Inativo
                          </Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-800" data-testid={`badge-ativo-${customer.id}`}>
                            Ativo
                          </Badge>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center space-x-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setHistoryOpenId(historyOpenId === customer.id ? null : customer.id)}
                            title="Histórico de alterações"
                            data-testid={`button-history-${customer.id}`}
                            className={historyOpenId === customer.id ? 'text-primary' : 'text-gray-600'}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          <WhatsAppButton
                            phone={customer.phone}
                            customerName={(customer as any).fantasyName || customer.name}
                            size="sm"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditingCustomer(customer);
                              setShowModal(true);
                            }}
                            data-testid={`button-edit-customer-${customer.id}`}
                          >
                            <Edit className="h-4 w-4 text-gray-600" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenWhatsApp(customer.phone, (customer as any).fantasyName || customer.name)}
                            data-testid={`button-whatsapp-customer-${customer.id}`}
                          >
                            <Phone className="h-4 w-4 text-green-600" />
                          </Button>
                          {customer.latitude && customer.longitude && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openWaze(customer)}
                              data-testid={`button-waze-customer-${customer.id}`}
                              className="text-blue-600 hover:text-blue-700"
                            >
                              <MapPin className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteCustomerMutation.mutate(customer.id)}
                            data-testid={`button-delete-customer-${customer.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {historyOpenId === customer.id && (
                      <tr className="bg-gray-50">
                        <td colSpan={9} className="px-6 py-1">
                          <CustomerHistoryBox customerId={customer.id} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center text-gray-500">
                      Nenhum cliente encontrado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Customer Modal */}
      {showModal && (
        <CustomerModal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingCustomer(null);
          }}
          customer={editingCustomer}
        />
      )}

      {/* Omie Import Modal */}
      <OmieClientImport
        isOpen={showOmieImport}
        onClose={() => setShowOmieImport(false)}
      />

      {/* Omie Sync Manager Modal */}
      <OmieSyncManager
        isOpen={showOmieSync}
        onClose={() => setShowOmieSync(false)}
      />

      {/* Excel Import Modal */}
      <CustomerExcelImport
        isOpen={showExcelImport}
        onClose={() => setShowExcelImport(false)}
      />

      {/* Customer Details Modal */}
      {showDetailsModal && selectedCustomer && (
        <CustomerDetailsModal
          customer={selectedCustomer}
          isOpen={showDetailsModal}
          onClose={() => {
            setShowDetailsModal(false);
            setSelectedCustomer(null);
          }}
        />
      )}
    </div>
  );
}
