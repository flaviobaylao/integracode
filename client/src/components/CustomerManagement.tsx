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
import type { CustomerWithSeller } from "@shared/schema";

export default function CustomerManagement() {
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerWithSeller | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [routeFilter, setRouteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers, isLoading } = useQuery({
    queryKey: ['/api/customers'],
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

  const filteredCustomers = customers?.filter((customer: CustomerWithSeller) => {
    const matchesSearch = customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         customer.document.includes(searchTerm) ||
                         customer.phone.includes(searchTerm);
    const matchesRoute = routeFilter === 'all' || customer.route === routeFilter;
    const matchesStatus = statusFilter === 'all' || 
                         (statusFilter === 'active' && customer.isActive) ||
                         (statusFilter === 'inactive' && !customer.isActive);
    
    return matchesSearch && matchesRoute && matchesStatus;
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
        <Button
          className="bg-honest-blue hover:bg-blue-700"
          onClick={() => setShowModal(true)}
        >
          <i className="fas fa-plus mr-2"></i>Novo Cliente
        </Button>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Cliente</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Documento</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Contato</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Rota</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Periodicidade</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Última Venda</th>
                  <th className="px-6 py-4 text-left text-sm font-medium text-gray-600">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredCustomers.length > 0 ? (
                  filteredCustomers.map((customer: CustomerWithSeller) => (
                    <tr key={customer.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium text-gray-800">{customer.name}</p>
                          <p className="text-sm text-gray-600 truncate max-w-xs">{customer.address}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">{customer.document}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <p className="text-sm text-gray-800">{customer.phone}</p>
                          {customer.email && (
                            <p className="text-sm text-gray-600">{customer.email}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <Badge className="bg-blue-100 text-blue-800 capitalize">
                          {customer.route}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">
                          {getWeekdaysLabel(customer.weekdays)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          {customer.lastSaleValue && (
                            <p className="text-sm font-medium text-gray-800">
                              {formatCurrency(parseFloat(customer.lastSaleValue))}
                            </p>
                          )}
                          <p className="text-sm text-gray-600">
                            {formatDate(customer.lastSaleDate)}
                          </p>
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
                          >
                            <i className="fas fa-edit"></i>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openWhatsApp(customer.phone, customer.name)}
                          >
                            <i className="fab fa-whatsapp text-green-600"></i>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteCustomerMutation.mutate(customer.id)}
                          >
                            <i className="fas fa-trash text-red-600"></i>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
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
    </div>
  );
}
