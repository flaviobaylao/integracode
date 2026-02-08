import { useState } from "react";
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
import type { Customer, User, CustomerWithSeller } from "@shared/schema";
import OmieInstanceBadge from "./OmieInstanceBadge";
import { Plus, Search, Edit, Trash2, MapPin, Phone, Mail, User as UserIcon, Building2, Download, RefreshCw, AlertTriangle, CheckCircle, XCircle, Clock, AlertCircle, Calendar, Upload } from "lucide-react";

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
  const [routeDateFilter, setRouteDateFilter] = useState('');
  const [positivationFilter, setPositivationFilter] = useState('all');
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
                         (statusFilter === 'active' && customer.omieStatus === 'ativo') ||
                         (statusFilter === 'inactive' && customer.omieStatus === 'inativo');
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
    
    return matchesSearch && matchesWeekday && matchesStatus && matchesSeller && matchesRouteDate && matchesPositivation;
  }) || [];

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
          <Button
            className="bg-honest-blue hover:bg-blue-700"
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
          <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
            <Input
              placeholder="Buscar por nome, CPF/CNPJ ou telefone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              data-testid="input-search-customer"
            />
            <Select value={weekdayFilter} onValueChange={setWeekdayFilter}>
              <SelectTrigger data-testid="select-weekday-filter">
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
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
              </SelectContent>
            </Select>
            <Select value={positivationFilter} onValueChange={setPositivationFilter}>
              <SelectTrigger data-testid="select-positivation-filter">
                <SelectValue placeholder="Positivação" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="yes">SIM</SelectItem>
                <SelectItem value="no">NÃO</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sellerFilter} onValueChange={setSellerFilter}>
              <SelectTrigger data-testid="select-seller-filter">
                <SelectValue placeholder="Todos os vendedores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os vendedores</SelectItem>
                {users?.map((user: User) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.firstName} {user.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              placeholder="Data da rota"
              value={routeDateFilter}
              onChange={(e) => setRouteDateFilter(e.target.value)}
              data-testid="input-route-date-filter"
            />
            <div className="text-sm text-gray-600 flex items-center">
              {filteredCustomers.length} cliente(s) encontrado(s)
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Customers Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Nome Fantasia</th>
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
                    <tr key={customer.id} className="hover:bg-gray-50">
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
                        {(customer as any).situacao ? (
                          <Badge 
                            className={
                              (customer as any).situacao === 'ativo' 
                                ? "bg-green-100 text-green-800" 
                                : "bg-red-100 text-red-800"
                            }
                          >
                            {(customer as any).situacao}
                          </Badge>
                        ) : (
                          <span className="text-gray-400 text-xs">N/A</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center space-x-2">
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
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
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
