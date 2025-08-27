import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import CustomerModal from "./CustomerModal";
import CustomerDetailsModal from "./CustomerDetailsModal";
import OmieClientImport from "./OmieClientImport";
import OmieSyncManager from "./OmieSyncManager";
import type { Customer, User, CustomerWithSeller } from "@shared/schema";
import { Plus, Search, Edit, Trash2, MapPin, Phone, Mail, User as UserIcon, Building2, Download, RefreshCw, AlertTriangle, CheckCircle, XCircle, Clock, AlertCircle, Calendar } from "lucide-react";

export default function CustomerManagement() {
  const [showModal, setShowModal] = useState(false);
  const [showOmieImport, setShowOmieImport] = useState(false);
  const [showOmieSync, setShowOmieSync] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [routeFilter, setRouteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sellerFilter, setSellerFilter] = useState('all');
  const [routeDateFilter, setRouteDateFilter] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers, isLoading } = useQuery({
    queryKey: ['/api/customers'],
    retry: false,
  });

  const { data: users } = useQuery({
    queryKey: ['/api/users'],
    retry: false,
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

  const openWhatsApp = (phone: string, customerName: string) => {
    const message = encodeURIComponent(
      `Olá ${customerName}! Somos da Honest Sucos. Como está tudo? Gostaria de saber se precisa de algum produto hoje.`
    );
    const whatsappUrl = `https://wa.me/55${phone.replace(/\D/g, '')}?text=${message}`;
    window.open(whatsappUrl, '_blank');
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
    const matchesSearch = customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         documentSearch.includes(searchTerm) ||
                         customer.phone.includes(searchTerm);
    const matchesRoute = routeFilter === 'all' || customer.route === routeFilter;
    const matchesStatus = statusFilter === 'all' || 
                         (statusFilter === 'active' && customer.isActive) ||
                         (statusFilter === 'inactive' && !customer.isActive);
    const matchesSeller = sellerFilter === 'all' || customer.sellerId === sellerFilter;
    
    // Filtro por data da rota (verifica se a data está nos dias da semana selecionados)
    let matchesRouteDate = true;
    if (routeDateFilter) {
      const selectedDate = new Date(routeDateFilter);
      const dayOfWeek = selectedDate.getDay(); // 0=domingo, 1=segunda, etc.
      const weekdayMapping = {
        0: 'sunday',
        1: 'monday', 
        2: 'tuesday',
        3: 'wednesday',
        4: 'thursday',
        5: 'friday',
        6: 'saturday'
      };
      const dayString = weekdayMapping[dayOfWeek as keyof typeof weekdayMapping];
      const customerWeekdays = JSON.parse(customer.weekdays || '[]');
      matchesRouteDate = customerWeekdays.includes(dayString);
    }
    
    return matchesSearch && matchesRoute && matchesStatus && matchesSeller && matchesRouteDate;
  }) || [];

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'Nunca';
    return new Date(date).toLocaleDateString('pt-BR');
  };

  const renderLastActivityIcon = (status: string | undefined) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-4 w-4 text-green-600" title="Última venda realizada" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-600" title="Última venda sem êxito" />;
      case 'pending':
        return <Clock className="h-4 w-4 text-blue-600" title="Venda em andamento" />;
      case 'overdue':
        return <AlertCircle className="h-4 w-4 text-purple-600" title="Card atrasado" />;
      case 'scheduled':
        return <Calendar className="h-4 w-4 text-orange-600" title="Card agendado" />;
      default:
        return <div className="h-4 w-4" />; // Espaço vazio para manter alinhamento
    }
  };

  const getWeekdaysLabel = (weekdays: string) => {
    try {
      const days = JSON.parse(weekdays);
      const dayLabels: { [key: string]: string } = {
        monday: 'Seg',
        tuesday: 'Ter',
        wednesday: 'Qua',
        thursday: 'Qui',
        friday: 'Sex',
        saturday: 'Sáb',
        sunday: 'Dom',
      };
      return days.map((day: string) => dayLabels[day]).join('/');
    } catch {
      return weekdays;
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
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Sincronizar Omie
          </Button>
          <Button
            variant="outline"
            className="border-honest-blue text-honest-blue hover:bg-honest-blue hover:text-white"
            onClick={() => setShowOmieImport(true)}
          >
            <Download className="h-4 w-4 mr-2" />
            Importar do Omie
          </Button>
          <Button
            className="bg-honest-blue hover:bg-blue-700"
            onClick={() => setShowModal(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Cliente
          </Button>
        </div>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
            <Input
              placeholder="Buscar cliente..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Select value={routeFilter} onValueChange={setRouteFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Todas as rotas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as rotas</SelectItem>
                <SelectItem value="centro">Centro</SelectItem>
                <SelectItem value="norte">Norte</SelectItem>
                <SelectItem value="sul">Sul</SelectItem>
                <SelectItem value="leste">Leste</SelectItem>
                <SelectItem value="oeste">Oeste</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sellerFilter} onValueChange={setSellerFilter}>
              <SelectTrigger>
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
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Rota</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Última Inserção</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Periodicidade</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Positivado</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Última Atividade</th>
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
                          >
                            {(customer as any).fantasyName || customer.name}
                          </button>
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
                        <div>
                          <Badge className="bg-blue-100 text-blue-800 capitalize">
                            {customer.route}
                          </Badge>
                          <p className="text-xs text-gray-600 mt-1">
                            {getWeekdaysLabel(customer.weekdays)}
                          </p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">
                          {formatDate((customer as any).lastActivityDate)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600 capitalize">
                          {(customer as any).visitPeriodicity || 'Semanal'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {customer.isPositivatedThisMonth ? (
                          <Badge className="bg-green-100 text-green-800">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Positivado
                          </Badge>
                        ) : (
                          <span className="text-gray-400 text-sm">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center">
                          {renderLastActivityIcon(customer.lastActivityStatus)}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center space-x-2">
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
                            onClick={() => openWhatsApp(customer.phone, customer.name)}
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
          editingCustomer={editingCustomer}
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
