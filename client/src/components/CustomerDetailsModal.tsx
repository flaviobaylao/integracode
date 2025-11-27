import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { Customer, SalesCardWithRelations } from "@shared/schema";
import { 
  User, 
  Phone, 
  Mail, 
  MapPin, 
  Building2, 
  Calendar, 
  Navigation,
  MessageSquare,
  Package,
  DollarSign,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  History,
  Plus,
  Truck
} from "lucide-react";
import { getVendorColor, getVendorInitials } from "@/lib/vendorColors";
import WhatsAppButton from "./WhatsAppButton";

interface CustomerDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
}

export default function CustomerDetailsModal({ isOpen, onClose, customer }: CustomerDetailsModalProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  
  const { data: salesHistory } = useQuery({
    queryKey: ['/api/sales-cards', 'customer', customer?.id],
    enabled: !!customer?.id,
  });

  const createSalesCardMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const currentUser = await fetch('/api/auth/user').then(res => res.json());
      
      // Buscar dados do cliente para calcular próxima data correta
      const customerResponse = await fetch(`/api/customers/${customerId}`);
      const customerData = await customerResponse.json();
      
      let scheduledDate = new Date();
      scheduledDate.setHours(8, 0, 0, 0);
      
      // Se cliente tem weekdays configurado, calcular baseado nisso
      if (customerData.weekdays && customerData.visitPeriodicity) {
        const weekdayMap: { [key: string]: number } = {
          domingo: 0, segunda: 1, terca: 2, quarta: 3,
          quinta: 4, sexta: 5, sabado: 6
        };
        
        let parsedWeekdays: string[] = [];
        try {
          parsedWeekdays = typeof customerData.weekdays === 'string' 
            ? JSON.parse(customerData.weekdays) 
            : customerData.weekdays;
        } catch (e) {
          parsedWeekdays = [];
        }
        
        if (parsedWeekdays.length > 0) {
          const targetWeekdays = parsedWeekdays.map((day: string) => weekdayMap[day]);
          const today = new Date();
          
          // Verificar se hoje já é um dia válido
          if (targetWeekdays.includes(today.getDay())) {
            scheduledDate = new Date(today);
            scheduledDate.setHours(8, 0, 0, 0);
          } else {
            // Procurar próximo dia válido
            for (let i = 1; i <= 7; i++) {
              const testDate = new Date(today);
              testDate.setDate(today.getDate() + i);
              if (targetWeekdays.includes(testDate.getDay())) {
                scheduledDate = testDate;
                scheduledDate.setHours(8, 0, 0, 0);
                break;
              }
            }
          }
        }
      }
      
      return apiRequest('POST', '/api/sales-cards', {
        customerId: customerId,
        sellerId: currentUser.id,
        status: 'pending',
        scheduledDate: scheduledDate.toISOString(),
        notes: 'Card criado a partir da gestão de clientes'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Card de venda criado com sucesso!",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message || "Não foi possível criar o card de venda",
        variant: "destructive",
      });
    },
  });

  const handleCreateSalesCard = () => {
    if (!customer?.id) return;
    
    // Verificar se já existe um card pendente para este cliente
    const hasPendingCard = salesHistory?.some((card: any) => 
      card.status === 'pending'
    );
    
    if (hasPendingCard) {
      toast({
        title: "Card já existe",
        description: "Este cliente já possui um card de vendas pendente. Por favor, utilize o card existente.",
        variant: "destructive",
      });
      return;
    }
    
    createSalesCardMutation.mutate(customer.id);
  };

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

  const openWaze = (latitude: string, longitude: string) => {
    if (!latitude || !longitude) return;
    const wazeUrl = `https://waze.com/ul?ll=${latitude},${longitude}&navigate=yes&zoom=17`;
    window.open(wazeUrl, '_blank');
  };

  const getWeekdaysLabel = (weekdays: string) => {
    try {
      const days = JSON.parse(weekdays);
      const dayLabels: { [key: string]: string } = {
        'monday': 'Seg',
        'tuesday': 'Ter',
        'wednesday': 'Qua',
        'thursday': 'Qui',
        'friday': 'Sex',
        'saturday': 'Sáb',
        'sunday': 'Dom'
      };
      return days.map((day: string) => dayLabels[day] || day).join(', ');
    } catch {
      return 'Não definido';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <Badge className="bg-green-100 text-green-800">
            <CheckCircle className="h-3 w-3 mr-1" />
            Concluído
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge className="bg-red-100 text-red-800">
            <XCircle className="h-3 w-3 mr-1" />
            Cancelado
          </Badge>
        );
      case 'in_progress':
        return (
          <Badge className="bg-blue-100 text-blue-800">
            <Clock className="h-3 w-3 mr-1" />
            Em Andamento
          </Badge>
        );
      case 'scheduled':
        return (
          <Badge className="bg-yellow-100 text-yellow-800">
            <Calendar className="h-3 w-3 mr-1" />
            Agendado
          </Badge>
        );
      default:
        return (
          <Badge className="bg-gray-100 text-gray-800">
            <AlertCircle className="h-3 w-3 mr-1" />
            Pendente
          </Badge>
        );
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (date: string | null) => {
    if (!date) return 'Não informado';
    return new Date(date).toLocaleDateString('pt-BR');
  };

  const formatDateTime = (date: string) => {
    return new Date(date).toLocaleString('pt-BR');
  };

  if (!customer) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center space-x-2">
              <User className="h-5 w-5 text-blue-600" />
              <span>Detalhes do Cliente</span>
            </DialogTitle>
            <Button
              onClick={handleCreateSalesCard}
              disabled={createSalesCardMutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
              data-testid="button-create-sales-card"
            >
              <Plus className="h-4 w-4 mr-2" />
              {createSalesCardMutation.isPending ? 'Criando...' : 'Criar Card de Venda'}
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[75vh]">
          <Tabs defaultValue="info" className="space-y-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Informações</TabsTrigger>
              <TabsTrigger value="history">Histórico de Vendas</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4">
              {/* Informações Básicas */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <User className="h-5 w-5 text-blue-600" />
                    <span>Informações Básicas</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Nome</p>
                      <p className="font-semibold text-lg">{(customer as any).fantasyName || customer.name}</p>
                      {(customer as any).fantasyName && (customer as any).companyName && (
                        <p className="text-xs text-gray-500 mt-1">Razão Social: {(customer as any).companyName}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Tipo</p>
                      <Badge variant="outline" className="capitalize">
                        {(customer as any).customerType === 'pessoa_fisica' ? 'Pessoa Física' : 'Pessoa Jurídica'}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Documento</p>
                      <p className="font-mono">{(customer as any).cpf || (customer as any).cnpj || 'Não informado'}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Informações de Contato */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Phone className="h-5 w-5 text-green-600" />
                    <span>Contato</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Phone className="h-4 w-4 text-gray-500" />
                      <span>{customer.phone}</span>
                    </div>
                    <WhatsAppButton 
                      phone={customer.phone} 
                      customerName={(customer as any).fantasyName || customer.name}
                    />
                  </div>
                  
                  {customer.email && (
                    <div className="flex items-center space-x-2">
                      <Mail className="h-4 w-4 text-gray-500" />
                      <span>{customer.email}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Localização */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <MapPin className="h-5 w-5 text-red-600" />
                    <span>Localização</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-sm text-gray-600">Endereço</p>
                    <p className="text-gray-800">{customer.address}</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {(customer as any).city && (
                      <div>
                        <p className="text-sm text-gray-600">Cidade</p>
                        <p className="font-medium">{(customer as any).city}</p>
                      </div>
                    )}
                    {(customer as any).state && (
                      <div>
                        <p className="text-sm text-gray-600">Estado</p>
                        <p className="font-medium">{(customer as any).state}</p>
                      </div>
                    )}
                    {(customer as any).zipCode && (
                      <div>
                        <p className="text-sm text-gray-600">CEP</p>
                        <p className="font-mono">{(customer as any).zipCode}</p>
                      </div>
                    )}
                  </div>

                  {(customer as any).latitude && (customer as any).longitude && (
                    <div className="space-y-2">
                      <p className="text-sm text-gray-600">Coordenadas GPS</p>
                      <div className="flex items-center justify-between">
                        <div className="font-mono text-sm space-y-1">
                          <div>Lat: {parseFloat((customer as any).latitude).toFixed(6)}</div>
                          <div>Lng: {parseFloat((customer as any).longitude).toFixed(6)}</div>
                          {(customer as any).coordinatesLocked && (
                            <Badge variant="secondary" className="bg-red-100 text-red-800 text-xs">
                              Coordenadas Travadas
                            </Badge>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openWaze((customer as any).latitude, (customer as any).longitude)}
                          className="text-blue-600 hover:text-blue-700"
                        >
                          <Navigation className="h-4 w-4 mr-1" />
                          Waze
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Informações de Venda */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Building2 className="h-5 w-5 text-purple-600" />
                    <span>Informações Comerciais</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Dias de Visita</p>
                      <p className="font-medium">{getWeekdaysLabel(customer.weekdays)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Status</p>
                      <Badge className={customer.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                        {customer.isActive ? 'Ativo' : 'Inativo'}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Última Venda</p>
                      <div className="space-y-1">
                        <p className="font-medium">{formatDate(customer.lastSaleDate)}</p>
                        {customer.lastSaleValue && (
                          <p className="text-sm text-green-600 font-medium">
                            {formatCurrency(parseFloat(customer.lastSaleValue))}
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Vendedor Responsável</p>
                      <div className="flex items-center space-x-3 mt-1">
                        {(customer as any).sellerId && (customer as any).seller && (
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold text-xs ${getVendorColor((customer as any).sellerId)}`}>
                            {getVendorInitials(`${(customer as any).seller?.firstName} ${(customer as any).seller?.lastName}`)}
                          </div>
                        )}
                        <p className="font-medium">{(customer as any).seller?.firstName} {(customer as any).seller?.lastName}</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Configurações de Recebimento */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Truck className="h-5 w-5 text-blue-600" />
                    <span>Configurações de Recebimento</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Dias de Recebimento */}
                    <div>
                      <p className="text-sm text-gray-600 mb-2">Dias de Recebimento</p>
                      {(() => {
                        // Usar receivingWeekdays (dias em que cliente aceita receber)
                        const rawDays = (customer as any).receivingWeekdays || (customer as any).receiving_weekdays;
                        if (!rawDays || (Array.isArray(rawDays) && rawDays.length === 0)) {
                          return <span className="text-sm text-gray-400">Não definido</span>;
                        }
                        
                        try {
                          const days = Array.isArray(rawDays) ? rawDays : JSON.parse(rawDays);
                          return days.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {days.map((day: string) => (
                                <Badge key={day} variant="outline" className="bg-blue-50 text-blue-700">
                                  {day}
                                </Badge>
                              ))}
                            </div>
                          ) : <span className="text-sm text-gray-400">Não definido</span>;
                        } catch {
                          return <span className="text-sm text-gray-400">Não definido</span>;
                        }
                      })()}
                    </div>

                    {/* Configuração de Veículo */}
                    <div>
                      <p className="text-sm text-gray-600 mb-2">Tipo de Entrega</p>
                      <div className="space-y-2">
                        {/* Try both camelCase and snake_case for compatibility */}
                        {((customer as any).exclusiveVehicle || (customer as any).exclusive_vehicle) && (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700">
                            🔒 Veículo Exclusivo Requerido
                          </Badge>
                        )}
                        {(() => {
                          const rawVehicles = (customer as any).vehicleTypes || (customer as any).vehicle_types;
                          if (!rawVehicles || (Array.isArray(rawVehicles) && rawVehicles.length === 0)) {
                            return <span className="text-sm text-gray-400">Todos os veículos permitidos</span>;
                          }

                          try {
                            const vehicles = Array.isArray(rawVehicles) ? rawVehicles : JSON.parse(rawVehicles);
                            const vehicleLabels: Record<string, string> = {
                              'caminhão': 'Caminhão',
                              'caminhao': 'Caminhão',
                              'carro': 'Carro',
                              'moto': 'Moto'
                            };

                            return vehicles.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {vehicles.map((vehicle: string) => (
                                  <Badge key={vehicle} variant="outline" className="bg-green-50 text-green-700">
                                    {vehicleLabels[vehicle] || vehicle}
                                  </Badge>
                                ))}
                              </div>
                            ) : <span className="text-sm text-gray-400">Todos os veículos permitidos</span>;
                          } catch {
                            return <span className="text-sm text-gray-400">Todos os veículos permitidos</span>;
                          }
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Horários de Recebimento - Dias Úteis */}
                  <div>
                    <p className="text-sm text-gray-600 mb-2">Horários de Recebimento (Dias Úteis)</p>
                    {(() => {
                      // Try both camelCase and snake_case for compatibility
                      const rawSlots = (customer as any).deliveryTimeSlots || (customer as any).delivery_time_slots;
                      if (!rawSlots || (Array.isArray(rawSlots) && rawSlots.length === 0)) {
                        return <span className="text-sm text-gray-400">Não definido</span>;
                      }

                      try {
                        const slots = Array.isArray(rawSlots) ? rawSlots : JSON.parse(rawSlots);
                        return slots.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {slots.map((slot: string) => (
                              <Badge key={slot} variant="outline" className="bg-orange-50 text-orange-700 font-mono">
                                {slot}
                              </Badge>
                            ))}
                          </div>
                        ) : <span className="text-sm text-gray-400">Não definido</span>;
                      } catch {
                        return <span className="text-sm text-gray-400">Não definido</span>;
                      }
                    })()}
                  </div>

                  {/* Horários de Recebimento - Sábado */}
                  <div>
                    <p className="text-sm text-gray-600 mb-2">Horários de Recebimento (Sábado)</p>
                    {(() => {
                      // Try both camelCase and snake_case for compatibility
                      const rawSlots = (customer as any).deliverySaturdayTimeSlots || (customer as any).delivery_saturday_time_slots;
                      if (!rawSlots || (Array.isArray(rawSlots) && rawSlots.length === 0)) {
                        return <span className="text-sm text-gray-400">Não definido</span>;
                      }

                      try {
                        const slots = Array.isArray(rawSlots) ? rawSlots : JSON.parse(rawSlots);
                        return slots.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {slots.map((slot: string) => (
                              <Badge key={slot} variant="outline" className="bg-purple-50 text-purple-700 font-mono">
                                {slot}
                              </Badge>
                            ))}
                          </div>
                        ) : <span className="text-sm text-gray-400">Não definido</span>;
                      } catch {
                        return <span className="text-sm text-gray-400">Não definido</span>;
                      }
                    })()}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <History className="h-5 w-5 text-orange-600" />
                    <span>Histórico de Atendimentos</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {salesHistory && salesHistory.length > 0 ? (
                    <div className="space-y-4">
                      {salesHistory.map((card: SalesCardWithRelations) => (
                        <div key={card.id} className="border rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-medium text-gray-900">
                                Card de Venda #{card.id.slice(-6)}
                              </p>
                              <p className="text-sm text-gray-600">
                                {formatDateTime(card.scheduledDate)}
                              </p>
                            </div>
                            {getStatusBadge(card.status)}
                          </div>

                          {card.saleValue && (
                            <div className="flex items-center space-x-2">
                              <DollarSign className="h-4 w-4 text-green-600" />
                              <span className="font-semibold text-green-600">
                                {formatCurrency(parseFloat(card.saleValue))}
                              </span>
                            </div>
                          )}

                          {card.rejectionReason && (
                            <div className="bg-red-50 p-3 rounded">
                              <p className="text-sm text-red-800">
                                <strong>Motivo da recusa:</strong> {card.rejectionReason}
                              </p>
                            </div>
                          )}

                          {card.notes && (
                            <div className="bg-gray-50 p-3 rounded">
                              <p className="text-sm text-gray-700">
                                <strong>Observações:</strong> {card.notes}
                              </p>
                            </div>
                          )}

                          {card.products && card.products.length > 0 && (
                            <div className="border-t pt-3 mt-3">
                              <p className="text-sm font-medium text-gray-700 mb-2">Produtos:</p>
                              <div className="space-y-1">
                                {card.products.map((product: any, index: number) => (
                                  <div key={index} className="flex items-center justify-between text-sm">
                                    <span>{product.name} (x{product.quantity})</span>
                                    <span className="font-medium">
                                      {formatCurrency(product.totalPrice)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <Package className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                      <p className="text-gray-500">Nenhum histórico de vendas encontrado</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}