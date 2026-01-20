import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Route, Calendar, User, CheckCircle, Clock, AlertCircle, RefreshCw, Phone, DollarSign, ShoppingCart, FileText, Headphones, Target } from "lucide-react";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import type { DailyRouteResponse } from "@shared/schema";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SalesCardWithRelations } from "@shared/schema";
import EditablePhoneField from "@/components/EditablePhoneField";

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

export default function TelemarketingRotaDoDia() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useLocation()[1];
  
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator' || user?.role === 'administrative';
  const isTelemarketing = user?.role === 'telemarketing';
  
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedSellerId, setSelectedSellerId] = useState(isAdmin ? '' : '');
  const [selectedCard, setSelectedCard] = useState<any>(null);
  const [showCardModal, setShowCardModal] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isNoSaleModalOpen, setIsNoSaleModalOpen] = useState(false);
  
  const [virtualServiceCustomer, setVirtualServiceCustomer] = useState<{ id: string; name: string } | null>(null);
  const [showVirtualActionModal, setShowVirtualActionModal] = useState(false);
  const [virtualActionCustomer, setVirtualActionCustomer] = useState<{ id: string; name: string } | null>(null);

  const { data: sellers } = useQuery<any[]>({
    queryKey: ['/api/users?role=vendedor'],
    enabled: (isAdmin || isTelemarketing) && !!user,
  });

  const { data: response, isLoading, refetch, isFetching } = useQuery<DailyRouteResponse>({
    queryKey: ['/api/daily-routes', selectedSellerId, 'date', selectedDate],
    enabled: !!selectedSellerId && !!selectedDate,
    refetchInterval: 30000,
  });

  const routeId = response?.route?.id;
  
  interface CustomerInfoResponse {
    orders: Record<string, { cardNumber: string | null; omieOrderId: string | null }[]>;
    debts: Record<string, number>;
  }
  
  const { data: customerInfo, refetch: refetchCustomerInfo } = useQuery<CustomerInfoResponse>({
    queryKey: ['/api/daily-routes', routeId, 'customer-info', selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/daily-routes/${routeId}/customer-info?date=${selectedDate}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch customer info');
      return res.json();
    },
    enabled: !!routeId && !!selectedDate,
    staleTime: 60000,
  });

  const { data: virtualServiceCount = 0 } = useQuery<number>({
    queryKey: ['/api/service-logs/count/customer', selectedSellerId, selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/service-logs/count/customer?sellerId=${selectedSellerId}&date=${selectedDate}`, {
        credentials: 'include',
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count || 0;
    },
    enabled: !!selectedSellerId && !!selectedDate,
  });

  const route = response?.route;
  
  const virtualVisits = useMemo(() => {
    if (!route?.visits) return [];
    return (route.visits || []).filter((v: any) => v.isVirtual || v.visitType === 'virtual');
  }, [route?.visits]);

  const stats = useMemo(() => {
    if (!virtualVisits.length) {
      return {
        total: 0,
        completed: 0,
        pending: 0,
        completionRate: 0
      };
    }

    const completed = virtualVisits.filter((v: any) => 
      v.status === 'completed' || v.checkOutTime || v.status === 'no_sale'
    ).length;
    
    return {
      total: virtualVisits.length,
      completed,
      pending: virtualVisits.length - completed,
      completionRate: virtualVisits.length > 0 ? Math.round((completed / virtualVisits.length) * 100) : 0
    };
  }, [virtualVisits]);

  const handleOpenVirtualService = (customerId: string, customerName: string) => {
    setVirtualServiceCustomer({ id: customerId, name: customerName });
  };

  const handleOpenCard = async (visit: any) => {
    try {
      const dateStr = selectedDate;
      const res = await fetch(`/api/customers/${visit.customerId}/sales-card/${dateStr}`, {
        credentials: 'include',
      });
      
      if (res.ok) {
        const card = await res.json();
        setSelectedCard(card);
        setShowCardModal(true);
      } else {
        toast({
          title: "Erro",
          description: "Não foi possível carregar os detalhes do cliente",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Erro",
        description: "Falha ao carregar dados do cliente",
        variant: "destructive"
      });
    }
  };

  const handleStartSale = (card: any) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setIsEditModalOpen(true);
  };

  const handleStartNoSale = (card: any) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setIsNoSaleModalOpen(true);
  };

  const handleSaleComplete = () => {
    setIsEditModalOpen(false);
    setSelectedCard(null);
    refetch();
    refetchCustomerInfo();
  };

  const handleNoSaleComplete = () => {
    setIsNoSaleModalOpen(false);
    setSelectedCard(null);
    refetch();
  };

  const formattedDate = formatInTimeZone(
    new Date(selectedDate + 'T12:00:00'),
    'America/Sao_Paulo',
    "EEEE, d 'de' MMMM 'de' yyyy",
    { locale: ptBR }
  );

  if (!user) {
    return <div className="p-6 text-center">Carregando...</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Headphones className="h-8 w-8 text-green-600" />
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Rota Virtual do Dia</h1>
              <p className="text-gray-600">Atendimentos virtuais programados</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetch();
                refetchCustomerInfo();
              }}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
              Atualizar
            </Button>
            <BackToDashboardButton />
          </div>
        </div>

        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="flex items-center text-sm font-medium text-gray-700 mb-2">
                  <Calendar className="h-4 w-4 mr-2" />
                  Data da Rota
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                  data-testid="input-date-selector"
                />
              </div>
              
              <div>
                <label className="flex items-center text-sm font-medium text-gray-700 mb-2">
                  <User className="h-4 w-4 mr-2" />
                  Vendedor
                </label>
                <Select value={selectedSellerId} onValueChange={setSelectedSellerId}>
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Selecione o vendedor" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellers?.map((seller) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.firstName} {seller.lastName?.charAt(0) || ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {selectedSellerId && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg capitalize">{formattedDate}</CardTitle>
                  <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">
                    Virtual
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                    <Target className="h-5 w-5 text-blue-600" />
                    <div>
                      <p className="text-xs text-gray-500">Total Clientes</p>
                      <p className="text-xl font-bold">{stats.total}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="text-xs text-gray-500">Atendidos</p>
                      <p className="text-xl font-bold">{stats.completed}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3 p-3 bg-orange-50 rounded-lg">
                    <Clock className="h-5 w-5 text-orange-600" />
                    <div>
                      <p className="text-xs text-gray-500">Pendentes</p>
                      <p className="text-xl font-bold">{stats.pending}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg">
                    <FileText className="h-5 w-5 text-purple-600" />
                    <div>
                      <p className="text-xs text-gray-500">Atend. Virtuais</p>
                      <p className="text-xl font-bold">{virtualServiceCount}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {isLoading ? (
              <Card>
                <CardContent className="py-12 text-center text-gray-500">
                  <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
                  Carregando clientes virtuais...
                </CardContent>
              </Card>
            ) : !route ? (
              <Card>
                <CardContent className="py-12 text-center text-gray-500">
                  <Headphones className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                  <p className="text-lg font-medium">Nenhuma rota encontrada</p>
                  <p className="text-sm">Selecione um vendedor e data para visualizar os clientes virtuais</p>
                </CardContent>
              </Card>
            ) : virtualVisits.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-gray-500">
                  <Headphones className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                  <p className="text-lg font-medium">Nenhum cliente virtual nesta rota</p>
                  <p className="text-sm">Este vendedor não possui clientes virtuais para atendimento hoje</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Headphones className="h-5 w-5 text-green-600" />
                    Clientes Virtuais ({virtualVisits.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {virtualVisits.map((visit: any, index: number) => {
                      const customerId = visit.customerId;
                      const customerOrders = customerInfo?.orders?.[customerId] || [];
                      const customerDebt = customerInfo?.debts?.[customerId] || 0;
                      const isCompleted = visit.status === 'completed' || visit.checkOutTime || visit.status === 'no_sale';
                      
                      return (
                        <div
                          key={visit.customerId}
                          className={`p-4 rounded-lg border cursor-pointer transition-all hover:shadow-md ${
                            isCompleted 
                              ? 'bg-green-50 border-green-200' 
                              : 'bg-white border-gray-200 hover:border-green-300'
                          }`}
                          onClick={() => {
                            setVirtualActionCustomer({ 
                              id: visit.customerId, 
                              name: visit.customerName 
                            });
                            setShowVirtualActionModal(true);
                          }}
                          data-testid={`virtual-visit-${visit.customerId}`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-medium text-gray-900">{visit.customerName}</span>
                                {isCompleted && (
                                  <Badge className="bg-green-500 text-white text-xs">Atendido</Badge>
                                )}
                              </div>
                              
                              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 mb-2">
                                {visit.phone && (
                                  <span className="flex items-center gap-1">
                                    <Phone className="h-3 w-3" />
                                    <EditablePhoneField
                                      phone={visit.phone}
                                      customerId={visit.customerId}
                                      onUpdate={() => refetch()}
                                    />
                                  </span>
                                )}
                                {visit.weekdays && (
                                  <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">
                                    {formatWeekdaysLocal(visit.weekdays)}
                                  </span>
                                )}
                              </div>
                              
                              <div className="flex flex-wrap gap-2">
                                {customerOrders.length > 0 && customerOrders.map((order, orderIdx) => (
                                  <Badge key={orderIdx} variant="outline" className="bg-green-50 text-green-700 border-green-300 text-xs">
                                    <ShoppingCart className="h-3 w-3 mr-1" />
                                    {order.cardNumber || order.omieOrderId || 'Pedido'}
                                  </Badge>
                                ))}
                                
                                {customerDebt > 0 && (
                                  <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300 text-xs">
                                    <DollarSign className="h-3 w-3 mr-1" />
                                    Débito: R$ {customerDebt.toFixed(2)}
                                  </Badge>
                                )}
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenVirtualService(visit.customerId, visit.customerName);
                                }}
                                className="text-green-600 hover:text-green-700 hover:bg-green-50"
                                title="Registrar Atendimento Virtual"
                                data-testid={`button-virtual-service-${visit.customerId}`}
                              >
                                <FileText className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      <Dialog open={showVirtualActionModal} onOpenChange={setShowVirtualActionModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Ações para Cliente Virtual</DialogTitle>
            <DialogDescription>
              {virtualActionCustomer?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Button
              className="w-full justify-start bg-green-600 hover:bg-green-700 text-white"
              onClick={() => {
                if (virtualActionCustomer) {
                  handleOpenVirtualService(virtualActionCustomer.id, virtualActionCustomer.name);
                  setShowVirtualActionModal(false);
                }
              }}
              data-testid="button-action-virtual-service"
            >
              <FileText className="h-5 w-5 mr-3" />
              Registrar Atendimento Virtual
            </Button>
            
            <Button
              className="w-full justify-start bg-blue-600 hover:bg-blue-700 text-white"
              onClick={async () => {
                if (virtualActionCustomer) {
                  setShowVirtualActionModal(false);
                  try {
                    const res = await fetch(`/api/customers/${virtualActionCustomer.id}/sales-card/${selectedDate}`, {
                      credentials: 'include',
                    });
                    if (res.ok) {
                      const card = await res.json();
                      setSelectedCard(card);
                      setIsEditModalOpen(true);
                    }
                  } catch (error) {
                    toast({
                      title: "Erro",
                      description: "Falha ao carregar dados para pedido",
                      variant: "destructive"
                    });
                  }
                }
              }}
              data-testid="button-action-create-order"
            >
              <ShoppingCart className="h-5 w-5 mr-3" />
              Registrar Pedido
            </Button>
            
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                if (virtualActionCustomer) {
                  handleOpenCard({ customerId: virtualActionCustomer.id, customerName: virtualActionCustomer.name });
                  setShowVirtualActionModal(false);
                }
              }}
              data-testid="button-action-view-details"
            >
              <User className="h-5 w-5 mr-3" />
              Ver Detalhes do Cliente
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {virtualServiceCustomer && (
        <VirtualServiceLogModal
          isOpen={!!virtualServiceCustomer}
          onClose={() => setVirtualServiceCustomer(null)}
          entityId={virtualServiceCustomer.id}
          entityType="customer"
          entityName={virtualServiceCustomer.name}
          onSuccess={() => {
            refetch();
            setVirtualServiceCustomer(null);
            toast({
              title: "Sucesso",
              description: "Atendimento virtual registrado"
            });
          }}
        />
      )}

      <SalesCardDetailsModal
        isOpen={showCardModal}
        onClose={() => {
          setShowCardModal(false);
          setSelectedCard(null);
        }}
        card={selectedCard}
        onStartSale={handleStartSale}
        onStartNoSale={handleStartNoSale}
        onUpdate={() => {
          refetch();
          refetchCustomerInfo();
        }}
      />

      {selectedCard && (
        <SaleEditModal
          isOpen={isEditModalOpen}
          onClose={() => {
            setIsEditModalOpen(false);
            setSelectedCard(null);
          }}
          card={selectedCard}
          onComplete={handleSaleComplete}
        />
      )}

      {selectedCard && (
        <NoSaleModal
          isOpen={isNoSaleModalOpen}
          onClose={() => {
            setIsNoSaleModalOpen(false);
            setSelectedCard(null);
          }}
          card={selectedCard}
          onComplete={handleNoSaleComplete}
        />
      )}
    </div>
  );
}
