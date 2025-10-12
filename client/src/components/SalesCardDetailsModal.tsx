import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
// Removed Separator import as it's not needed
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Calendar, 
  Clock, 
  Phone, 
  MapPin, 
  User, 
  CreditCard, 
  Tag, 
  DollarSign,
  MessageSquare,
  FileText,
  Send,
  CheckCircle,
  XCircle,
  AlertCircle,
  Package,
  ShoppingCart,
  Navigation,
  CircleDollarSign,
  Ban,
  LogIn,
  LogOut,
  Loader2,
  Monitor,
  Users,
  Truck
} from "lucide-react";
import type { SalesCardWithRelations } from "@shared/schema";
import CheckInModal from "./CheckInModal";

interface SalesCardDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: SalesCardWithRelations | null;
  onStartSale?: (card: SalesCardWithRelations) => void;
  onStartNoSale?: (card: SalesCardWithRelations) => void;
}

export default function SalesCardDetailsModal({ isOpen, onClose, card, onStartSale, onStartNoSale }: SalesCardDetailsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [localVirtualService, setLocalVirtualService] = useState(false);
  const [showCheckInModal, setShowCheckInModal] = useState(false);
  
  // Buscar usuário atual para verificar permissões
  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  // Verificar se o usuário é administrativo
  const isAdministrative = ['admin', 'coordinator', 'administrative'].includes((currentUser as any)?.role);
  
  // Sincronizar estado local com o card quando ele mudar
  useEffect(() => {
    if (card?.customer) {
      setLocalVirtualService((card.customer as any).virtualService || false);
    }
  }, [card]);
  
  // Log para debug
  console.log('SalesCardDetailsModal opened:', { isOpen, cardStatus: card?.status, cardId: card?.id });

  // Função para calcular distância entre duas coordenadas (fórmula de Haversine)
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000; // Raio da Terra em metros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distância em metros
  };

  // Função para capturar localização
  const getCurrentLocation = (): Promise<{latitude: number, longitude: number}> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocalização não é suportada neste navegador'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          });
        },
        (error) => {
          reject(new Error('Erro ao obter localização: ' + error.message));
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000
        }
      );
    });
  };

  // Check-in is now handled by CheckInModal with photo capture - no mutation needed here

  // Mutation para check-out
  const checkOutMutation = useMutation({
    mutationFn: async (data: { cardId: string, latitude: number, longitude: number }) => {
      await apiRequest('POST', `/api/sales-cards/${data.cardId}/check-out`, {
        latitude: data.latitude,
        longitude: data.longitude
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      setIsCheckingOut(false);
      toast({
        title: "Check-out Realizado",
        description: "Check-out registrado com sucesso!",
      });
    },
    onError: (error) => {
      setIsCheckingOut(false);
      toast({
        title: "Erro no Check-out",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const sendToOmieMutation = useMutation({
    mutationFn: async (cardId: string) => {
      await apiRequest('POST', `/api/sales-cards/${cardId}/send-to-omie`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Pedido enviado para Omie com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro ao Enviar para Omie",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation para alternar tipo de atendimento
  const toggleServiceTypeMutation = useMutation({
    mutationFn: async ({ customerId, virtualService }: { customerId: string, virtualService: boolean }) => {
      await apiRequest('PUT', `/api/customers/${customerId}`, { virtualService });
    },
    onSuccess: (data, variables) => {
      // Atualizar estado local imediatamente
      setLocalVirtualService(variables.virtualService);
      
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Sucesso",
        description: "Tipo de atendimento atualizado com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro ao Atualizar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSendToOmie = () => {
    if (!card?.saleValue || parseFloat(card.saleValue) === 0) {
      toast({
        title: "Aviso",
        description: "Este card não possui uma venda registrada para enviar ao Omie.",
        variant: "destructive",
      });
      return;
    }
    sendToOmieMutation.mutate(card.id);
  };

  // Função para realizar check-in - abre o modal
  const handleCheckIn = () => {
    if (!card) return;
    
    // Verificar se é cliente virtual
    if (card.customer?.virtualService) {
      toast({
        title: "Cliente Virtual",
        description: "Clientes virtuais não requerem check-in",
        variant: "destructive",
      });
      return;
    }
    
    setShowCheckInModal(true);
  };

  // Função para realizar check-out
  const handleCheckOut = async () => {
    if (!card) return;
    
    setIsCheckingOut(true);
    try {
      const location = await getCurrentLocation();
      
      checkOutMutation.mutate({
        cardId: card.id,
        latitude: location.latitude,
        longitude: location.longitude
      });
    } catch (error) {
      setIsCheckingOut(false);
      toast({
        title: "Erro na Localização",
        description: error instanceof Error ? error.message : "Erro ao capturar localização",
        variant: "destructive",
      });
    }
  };

  const openWhatsApp = (phone: string, customerName: string) => {
    const message = encodeURIComponent(
      `Olá ${customerName}! Somos da Honest Sucos. Gostaria de agendar uma visita para apresentar nossos produtos frescos e naturais. Qual o melhor horário para você?`
    );
    const whatsappUrl = `https://wa.me/55${phone.replace(/\D/g, '')}?text=${message}`;
    window.open(whatsappUrl, '_blank');
  };

  const openWaze = (latitude: string, longitude: string) => {
    if (!latitude || !longitude) {
      toast({
        title: "Localização não disponível",
        description: "É necessário cadastrar a latitude e longitude do cliente para usar a navegação.",
        variant: "destructive",
      });
      return;
    }
    
    const wazeUrl = `https://waze.com/ul?ll=${latitude},${longitude}&navigate=yes&zoom=17`;
    window.open(wazeUrl, '_blank');
  };

  const getStatusInfo = (status: string) => {
    switch (status) {
      case 'completed':
        return { 
          label: 'Finalizado', 
          color: 'bg-green-100 text-green-800', 
          icon: CheckCircle,
          iconColor: 'text-green-600'
        };
      case 'in_progress':
        return { 
          label: 'Em Atendimento', 
          color: 'bg-yellow-100 text-yellow-800', 
          icon: AlertCircle,
          iconColor: 'text-yellow-600'
        };
      case 'pending':
        return { 
          label: 'Pendente', 
          color: 'bg-blue-100 text-blue-800', 
          icon: Clock,
          iconColor: 'text-blue-600'
        };
      case 'no_sale':
        return { 
          label: 'Não Venda', 
          color: 'bg-red-100 text-red-800', 
          icon: XCircle,
          iconColor: 'text-red-600'
        };
      default:
        return { 
          label: status, 
          color: 'bg-gray-100 text-gray-800', 
          icon: AlertCircle,
          iconColor: 'text-gray-600'
        };
    }
  };

  const getPaymentMethodLabel = (method?: string) => {
    switch (method) {
      case 'a_vista': return 'À Vista';
      case 'boleto': return 'Boleto';
      case 'pix': return 'PIX';
      default: return 'À Vista';
    }
  };

  const getOperationTypeLabel = (type?: string) => {
    switch (type) {
      case 'venda': return 'Venda';
      case 'troca': return 'Troca';
      case 'amostra': return 'Amostra';
      default: return 'Venda';
    }
  };

  const getRecurrenceLabel = (type?: string) => {
    switch (type) {
      case 'semanal': return 'Semanal';
      case 'quinzenal': return 'Quinzenal';
      case 'mensal': return 'Mensal';
      default: return 'Semanal';
    }
  };

  if (!card) return null;

  const statusInfo = getStatusInfo(card.status);
  const StatusIcon = statusInfo.icon;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-3">
            <StatusIcon className={`h-6 w-6 ${statusInfo.iconColor}`} />
            <span>Detalhes da Venda</span>
            <Badge className={statusInfo.color}>
              {statusInfo.label}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Informações do Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <User className="h-5 w-5 text-blue-600" />
                <span>Informações do Cliente</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Nome</p>
                  <p className="font-semibold text-lg">{card.customer.name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Vendedor</p>
                  <p className="font-medium">{card.seller?.firstName} {card.seller?.lastName}</p>
                </div>
              </div>
              
              <div className="flex items-center space-x-2 text-gray-700">
                <Phone className="h-4 w-4" />
                <span>{card.customer.phone}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openWhatsApp(card.customer.phone, card.customer.name)}
                  className="ml-2 text-green-600 hover:text-green-700"
                  data-testid="button-whatsapp"
                >
                  <MessageSquare className="h-4 w-4 mr-1" />
                  WhatsApp
                </Button>
              </div>
              
              {/* Botão de Tipo de Atendimento */}
              <div className="flex items-center space-x-2">
                <div className="text-sm text-gray-600">Tipo de Atendimento:</div>
                <Button
                  variant={localVirtualService ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    if (!isAdministrative) {
                      toast({
                        title: "Acesso Negado",
                        description: "Apenas usuários administrativos podem alterar o tipo de atendimento.",
                        variant: "destructive",
                      });
                      return;
                    }
                    toggleServiceTypeMutation.mutate({
                      customerId: card.customer.id,
                      virtualService: !localVirtualService
                    });
                  }}
                  className={`${
                    localVirtualService 
                      ? "bg-blue-500 hover:bg-blue-600 text-white" 
                      : "bg-green-500 hover:bg-green-600 text-white border-green-500"
                  } ${!isAdministrative ? 'opacity-60 cursor-not-allowed' : ''}`}
                  disabled={toggleServiceTypeMutation.isPending || !isAdministrative}
                  data-testid="button-service-type"
                >
                  {localVirtualService ? (
                    <>
                      <Monitor className="h-4 w-4 mr-1" />
                      Virtual
                    </>
                  ) : (
                    <>
                      <Users className="h-4 w-4 mr-1" />
                      Presencial
                    </>
                  )}
                </Button>
              </div>
              
              <div className="flex items-start space-x-2 text-gray-700">
                <MapPin className="h-4 w-4 mt-1" />
                <span>{card.customer.address}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openWaze((card as any).customerLatitude, (card as any).customerLongitude)}
                  className="ml-2 text-blue-600 hover:text-blue-700"
                  data-testid="button-waze"
                >
                  <Navigation className="h-4 w-4 mr-1" />
                  Waze
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Informações do Agendamento */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Calendar className="h-5 w-5 text-purple-600" />
                <span>Agendamento</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Data</p>
                  <p className="font-medium">
                    {new Date(card.scheduledDate).toLocaleDateString('pt-BR')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Horário</p>
                  <p className="font-medium">
                    {new Date(card.scheduledDate).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Recorrência</p>
                  <p className="font-medium">{getRecurrenceLabel(card.recurrenceType)}</p>
                </div>
              </div>
              
              <div>
                <p className="text-sm text-gray-600">Dia da Rota</p>
                <p className="font-medium capitalize">{card.routeDay || 'Não definido'}</p>
              </div>
            </CardContent>
          </Card>

          {/* Informações da Venda */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <DollarSign className="h-5 w-5 text-green-600" />
                <span>Detalhes da Venda</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Tipo de Operação</p>
                  <div className="flex items-center space-x-2">
                    <Tag className="h-4 w-4 text-purple-500" />
                    <span className="font-medium text-purple-600">
                      {getOperationTypeLabel(card.operationType)}
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Método de Pagamento</p>
                  <div className="flex items-center space-x-2">
                    <CreditCard className="h-4 w-4 text-blue-500" />
                    <span className="font-medium text-blue-600">
                      {getPaymentMethodLabel(card.paymentMethod)}
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Valor da Venda</p>
                  <p className="text-2xl font-bold text-green-600">
                    {card.saleValue ? 
                      new Intl.NumberFormat('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      }).format(parseFloat(card.saleValue))
                      : 'Não registrado'
                    }
                  </p>
                </div>
              </div>

              {card.completedDate && (
                <div>
                  <p className="text-sm text-gray-600">Data de Finalização</p>
                  <p className="font-medium">
                    {new Date(card.completedDate).toLocaleDateString('pt-BR')} às{' '}
                    {new Date(card.completedDate).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </p>
                </div>
              )}

              {card.noSaleReason && (
                <div>
                  <p className="text-sm text-gray-600">Motivo da Não Venda</p>
                  <p className="font-medium text-red-600">{card.noSaleReason}</p>
                </div>
              )}

              {/* Veículo Exclusivo */}
              {(card as any).exclusiveVehicle && (
                <div className="border-t border-gray-200 pt-4 mt-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <Truck className="h-5 w-5 text-orange-600" />
                    <p className="text-sm font-semibold text-gray-700">Veículo Exclusivo</p>
                  </div>
                  <div className="ml-7">
                    <p className="text-sm text-gray-600 mb-2">Tipos de veículos:</p>
                    <div className="flex flex-wrap gap-2">
                      {((card as any).vehicleTypes || []).map((vehicle: string) => (
                        <Badge key={vehicle} variant="outline" className="bg-orange-50 text-orange-700 border-orange-300">
                          {vehicle === 'caminhao' ? '🚛 Caminhão' : vehicle === 'carro' ? '🚗 Carro' : '🏍️ Moto'}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Produtos Vendidos */}
          {card.products && card.products.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Package className="h-5 w-5 text-blue-600" />
                  <span>Produtos Vendidos</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {card.products.map((product, index) => (
                    <div key={index} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                      <div className="flex items-center space-x-3">
                        <ShoppingCart className="h-5 w-5 text-blue-500" />
                        <div>
                          <p className="font-medium text-gray-900">{product.name}</p>
                          <p className="text-sm text-gray-600">
                            Qtd: {product.quantity} | Preço unitário: {' '}
                            {new Intl.NumberFormat('pt-BR', {
                              style: 'currency',
                              currency: 'BRL',
                            }).format(product.unitPrice)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-green-600">
                          {new Intl.NumberFormat('pt-BR', {
                            style: 'currency',
                            currency: 'BRL',
                          }).format(product.totalPrice)}
                        </p>
                      </div>
                    </div>
                  ))}
                  
                  {/* Total Geral */}
                  <div className="border-t pt-4 mt-4">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-semibold text-gray-900">Total Geral:</span>
                      <span className="text-2xl font-bold text-green-600">
                        {card.saleValue ? 
                          new Intl.NumberFormat('pt-BR', {
                            style: 'currency',
                            currency: 'BRL',
                          }).format(parseFloat(card.saleValue))
                          : 
                          new Intl.NumberFormat('pt-BR', {
                            style: 'currency',
                            currency: 'BRL',
                          }).format(
                            card.products.reduce((total, product) => total + product.totalPrice, 0)
                          )
                        }
                      </span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Observações */}
          {card.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <FileText className="h-5 w-5 text-gray-600" />
                  <span>Observações</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <p className="whitespace-pre-wrap">{card.notes}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Integração Omie */}
          {card.status === 'completed' && card.saleValue && parseFloat(card.saleValue) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Send className="h-5 w-5 text-orange-600" />
                  <span>Integração Omie ERP</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {card.omieOrderId ? (
                  <div className="flex items-center space-x-2 text-green-600">
                    <CheckCircle className="h-5 w-5" />
                    <span className="font-medium">Enviado para Omie</span>
                    <Badge variant="outline" className="ml-2">
                      {card.omieOrderId}
                    </Badge>
                  </div>
                ) : (
                  <div className="flex items-center space-x-3">
                    <div className="flex items-center space-x-2 text-orange-600">
                      <AlertCircle className="h-5 w-5" />
                      <span>Pendente de envio para Omie</span>
                    </div>
                    <Button
                      onClick={handleSendToOmie}
                      disabled={sendToOmieMutation.isPending}
                      className="bg-orange-500 hover:bg-orange-600"
                      data-testid="button-send-to-omie"
                    >
                      {sendToOmieMutation.isPending ? (
                        <>
                          <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                          Enviando...
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4 mr-2" />
                          Enviar para Omie
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Botões de Ação */}
        {(card.status === 'pending' || card.status === 'in_progress') && (
          <div className="border-t pt-4 space-y-4">
            {/* Botões de Check-in e Check-out */}
            <div className="flex flex-wrap justify-center gap-3">
              <Button
                onClick={handleCheckIn}
                disabled={isCheckingIn || !!card.checkInTime}
                variant="outline"
                className="border-blue-600 text-blue-600 hover:bg-blue-50"
                data-testid="button-check-in"
              >
                {isCheckingIn ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4 mr-2" />
                )}
                {card.checkInTime ? 'Check-in Realizado' : 'Check-in'}
              </Button>
              
              <Button
                onClick={handleCheckOut}
                disabled={isCheckingOut || !card.checkInTime || !!card.checkOutTime}
                variant="outline"
                className="border-purple-600 text-purple-600 hover:bg-purple-50"
                data-testid="button-check-out"
              >
                {isCheckingOut ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4 mr-2" />
                )}
                {card.checkOutTime ? 'Check-out Realizado' : 'Check-out'}
              </Button>
            </div>

            {/* Informações de Check-in/Check-out */}
            {(card.checkInTime || card.checkOutTime) && (
              <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="font-semibold text-gray-700 mb-3">Registro de Presença</h4>
                
                {card.checkInTime && (
                  <div className="border-l-4 border-blue-500 pl-3 mb-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-blue-600 font-medium">✓ Check-in Realizado</span>
                      <span className="text-sm text-gray-600">{new Date(card.checkInTime).toLocaleString('pt-BR')}</span>
                    </div>
                    {(card.checkInLatitude && card.checkInLongitude) && (
                      <div className="text-xs text-gray-500">
                        Localização: {parseFloat(card.checkInLatitude).toFixed(6)}, {parseFloat(card.checkInLongitude).toFixed(6)}
                      </div>
                    )}
                    {card.distanceToCustomer && (
                      <div className="text-xs text-gray-500 mt-1">
                        Distância até o cliente: {parseFloat(card.distanceToCustomer).toFixed(0)}m
                      </div>
                    )}
                  </div>
                )}
                
                {card.checkOutTime && (
                  <div className="border-l-4 border-purple-500 pl-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-purple-600 font-medium">✓ Check-out Realizado</span>
                      <span className="text-sm text-gray-600">{new Date(card.checkOutTime).toLocaleString('pt-BR')}</span>
                    </div>
                    {(card.checkOutLatitude && card.checkOutLongitude) && (
                      <div className="text-xs text-gray-500">
                        Localização: {parseFloat(card.checkOutLatitude).toFixed(6)}, {parseFloat(card.checkOutLongitude).toFixed(6)}
                      </div>
                    )}
                    {card.checkOutDistanceToCustomer && (
                      <div className="text-xs text-gray-500 mt-1">
                        Distância até o cliente: {parseFloat(card.checkOutDistanceToCustomer).toFixed(0)}m
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Botões de Venda */}
            <div className="flex flex-wrap justify-center gap-3">
              <Button
                onClick={() => {
                  console.log('Finalizar Venda clicked, calling onStartSale with card:', card.id);
                  onStartSale?.(card);
                }}
                className="bg-green-600 hover:bg-green-700 text-white"
                data-testid="button-start-sale"
              >
                <CircleDollarSign className="h-4 w-4 mr-2" />
                Finalizar Venda
              </Button>
              <Button
                onClick={() => onStartNoSale?.(card)}
                variant="outline"
                className="border-red-600 text-red-600 hover:bg-red-50"
                data-testid="button-start-no-sale"
              >
                <Ban className="h-4 w-4 mr-2" />
                Não Venda
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-4">
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </DialogContent>

      {/* Modal de Check-In com foto */}
      {card && (
        <CheckInModal
          isOpen={showCheckInModal}
          onClose={() => setShowCheckInModal(false)}
          cardId={card.id}
          customerLatitude={card.customerLatitude}
          customerLongitude={card.customerLongitude}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
            setShowCheckInModal(false);
          }}
        />
      )}
    </Dialog>
  );
}