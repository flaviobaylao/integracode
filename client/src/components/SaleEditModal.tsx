import { useState, useEffect } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { 
  Package, 
  Plus, 
  Trash2, 
  CreditCard, 
  CheckCircle, 
  XCircle,
  DollarSign,
  ShoppingCart,
  MapPin,
  Calendar,
  Route,
  Truck,
  Clock,
  Target,
  Phone,
  AlertTriangle
} from "lucide-react";
import type { SalesCardWithRelations } from "@shared/schema";

interface SaleEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: SalesCardWithRelations | null;
}

interface ProductItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export default function SaleEditModal({ isOpen, onClose, card }: SaleEditModalProps) {
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('a_vista');
  const [operationType, setOperationType] = useState('venda');
  const [notes, setNotes] = useState('');
  const [routeDay, setRouteDay] = useState('');
  const [recurrenceType, setRecurrenceType] = useState('');
  const [deliveryWeekdays, setDeliveryWeekdays] = useState<string[]>(['segunda', 'terca', 'quarta', 'quinta', 'sexta']);
  const [deliveryTimeSlots, setDeliveryTimeSlots] = useState<string[]>(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
  const [customerLatitude, setCustomerLatitude] = useState('');
  const [customerLongitude, setCustomerLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [customerWeekdays, setCustomerWeekdays] = useState<string[]>([]);
  const [customerVisitPeriodicity, setCustomerVisitPeriodicity] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [boletoDays, setBoletoDays] = useState(7);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, isLoading: userLoading } = useAuth();
  
  // Verificar se usuário pode editar recorrência e dia da rota
  // Permitir edição se: está carregando OU é admin/coordinator/administrative
  const canManageRouteAndRecurrence = userLoading || (user && ['admin', 'coordinator', 'administrative'].includes(user.role));

  // Buscar produtos disponíveis
  const { data: availableProducts } = useQuery({
    queryKey: ['/api/products'],
    retry: false,
  });

  useEffect(() => {
    if (card) {
      setProducts(card.products || []);
      setPaymentMethod(card.paymentMethod || 'a_vista');
      setOperationType(card.operationType || 'venda');
      setNotes(card.notes || '');
      setRouteDay(card.routeDay || '');
      setRecurrenceType(card.recurrenceType || '');
      setBoletoDays((card as any).boletoDays || 7);
      
      // Se o card tem configurações de entrega, usa elas, senão usa os valores padrão
      const defaultWeekdays = ['segunda', 'terca', 'quarta', 'quinta', 'sexta'];
      const defaultTimeSlots = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
      
      setDeliveryWeekdays((card as any).deliveryWeekdays?.length > 0 
        ? (card as any).deliveryWeekdays 
        : defaultWeekdays
      );
      setDeliveryTimeSlots((card as any).deliveryTimeSlots?.length > 0 
        ? (card as any).deliveryTimeSlots 
        : defaultTimeSlots
      );
      setCustomerLatitude((card as any).customerLatitude || '');
      setCustomerLongitude((card as any).customerLongitude || '');
      
      // Carregar weekdays, periodicidade, telefone e coordenadas do cliente
      if (card.customer) {
        try {
          const weekdaysData = card.customer.weekdays || '[]';
          const parsedWeekdays = typeof weekdaysData === 'string' 
            ? JSON.parse(weekdaysData) 
            : weekdaysData;
          setCustomerWeekdays(Array.isArray(parsedWeekdays) ? parsedWeekdays : []);
        } catch {
          setCustomerWeekdays([]);
        }
        setCustomerVisitPeriodicity((card.customer as any).visitPeriodicity || '');
        setCustomerPhone(card.customer.phone || '');
        setLatitude(card.customer.latitude || '');
        setLongitude(card.customer.longitude || '');
      }
    } else {
      // Valores padrão quando não há card
      setProducts([]);
      setPaymentMethod('a_vista');
      setOperationType('venda');
      setNotes('');
      setRouteDay('');
      setRecurrenceType('');
      setBoletoDays(7);
      setDeliveryWeekdays(['segunda', 'terca', 'quarta', 'quinta', 'sexta']);
      setDeliveryTimeSlots(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
      setCustomerLatitude('');
      setCustomerLongitude('');
      setCustomerWeekdays([]);
      setCustomerVisitPeriodicity('');
    }
  }, [card]);

  // Ajustar dias selecionados quando periodicidade mudar
  useEffect(() => {
    // Se a periodicidade não for semanal e houver mais de 1 dia selecionado, manter apenas o primeiro
    if (customerVisitPeriodicity && customerVisitPeriodicity !== 'semanal' && customerWeekdays.length > 1) {
      setCustomerWeekdays([customerWeekdays[0]]);
      toast({
        title: "Dias ajustados",
        description: `Para periodicidade ${customerVisitPeriodicity}, apenas 1 dia de visita é permitido. O primeiro dia foi mantido.`,
      });
    }
  }, [customerVisitPeriodicity]);

  const updateCardMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/sales-cards/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Venda finalizada com sucesso!",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateCustomerMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/customers/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Dados do cliente atualizados com sucesso!",
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

  const sendToOmieMutation = useMutation({
    mutationFn: async (cardId: string) => {
      await apiRequest('POST', `/api/sales-cards/${cardId}/send-to-omie`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Pedido enviado para faturamento!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro ao Enviar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Gerenciar seleção de produtos via checkbox
  const handleProductToggle = (productId: string, checked: boolean) => {
    if (checked) {
      if (!Array.isArray(availableProducts)) return;
      const selectedProduct = availableProducts.find((p: any) => p.id === productId);
      if (selectedProduct) {
        setProducts([...products, {
          id: selectedProduct.id,
          name: selectedProduct.name,
          quantity: 1,
          unitPrice: parseFloat(selectedProduct.price || '0'),
          totalPrice: parseFloat(selectedProduct.price || '0')
        }]);
      }
    } else {
      setProducts(products.filter(p => p.id !== productId));
    }
  };

  const updateProductQuantity = (productId: string, quantity: number) => {
    const updatedProducts = products.map(p => {
      if (p.id === productId) {
        const qty = quantity || 1;
        return { ...p, quantity: qty, totalPrice: qty * p.unitPrice };
      }
      return p;
    });
    setProducts(updatedProducts);
  };

  const updateProductPrice = (productId: string, price: number) => {
    const updatedProducts = products.map(p => {
      if (p.id === productId) {
        return { ...p, unitPrice: price, totalPrice: p.quantity * price };
      }
      return p;
    });
    setProducts(updatedProducts);
  };

  const calculateTotal = () => {
    return products.reduce((total, product) => total + product.totalPrice, 0);
  };

  const handleFinalizeSale = async () => {
    if (products.length === 0) {
      toast({
        title: "Erro",
        description: "Adicione pelo menos um produto para finalizar a venda.",
        variant: "destructive",
      });
      return;
    }

    const totalValue = calculateTotal();
    const minValue = operationType === 'venda' ? 10 : 0;
    
    if (totalValue < minValue) {
      toast({
        title: "Erro",
        description: `Valor mínimo para venda é R$ ${minValue.toFixed(2)}`,
        variant: "destructive",
      });
      return;
    }

    if (!card) return;

    setIsSubmitting(true);
    try {
      // A próxima data será calculada automaticamente pelo backend ao completar
      const nextScheduledDate = null;

      // Atualizar card com dados da venda e reagendar
      await updateCardMutation.mutateAsync({
        id: card.id,
        data: {
          status: 'completed',
          saleValue: totalValue.toFixed(2),
          products: products,
          paymentMethod: paymentMethod,
          operationType: operationType,
          notes: notes,
          routeDay: routeDay,
          recurrenceType: recurrenceType,
          deliveryWeekdays: deliveryWeekdays,
          deliveryTimeSlots: deliveryTimeSlots,
          customerLatitude: customerLatitude || null,
          customerLongitude: customerLongitude || null,
          boletoDays: boletoDays,
          scheduledDate: nextScheduledDate || undefined
        }
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendToFaturamento = async () => {
    if (!card?.id) return;
    
    // Primeiro finalizar a venda, depois enviar para faturamento
    await handleFinalizeSale();
    
    // Esperar um pouco para garantir que a venda foi finalizada
    setTimeout(() => {
      sendToOmieMutation.mutate(card.id);
    }, 1000);
  };

  const handleNoSale = () => {
    // Fechar este modal e abrir modal de não venda
    onClose();
    // TODO: Implementar abertura do modal de não venda
    toast({
      title: "Funcionalidade",
      description: "Modal de não venda será implementado.",
    });
  };

  const captureLocation = () => {
    setIsCapturingLocation(true);
    
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Geolocalização não é suportada pelo seu navegador.",
        variant: "destructive",
      });
      setIsCapturingLocation(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toString());
        setLongitude(position.coords.longitude.toString());
        toast({
          title: "Sucesso",
          description: "Localização capturada com sucesso!",
        });
        setIsCapturingLocation(false);
      },
      (error) => {
        toast({
          title: "Erro",
          description: `Não foi possível capturar a localização: ${error.message}`,
          variant: "destructive",
        });
        setIsCapturingLocation(false);
      }
    );
  };

  // Função para calcular próxima data de agendamento usando módulo compartilhado
  const calculateNextScheduledDate = () => {
    if (!card || !customerWeekdays || customerWeekdays.length === 0 || !customerVisitPeriodicity) {
      return null;
    }

    try {
      // Usar scheduledDate do card se disponível (é a data que está salva)
      if (card && card.scheduledDate) {
        return new Date(card.scheduledDate);
      }

      // Caso contrário, usar data atual como fallback
      return new Date();
    } catch (e) {
      console.error('Erro ao calcular próxima data:', e);
      return null;
    }
  };

  // Função para calcular data de entrega
  // 2 dias úteis se venda no dia agendado, 3 dias úteis se em outro dia
  const calculateDeliveryDate = (scheduledDate: Date | null) => {
    if (!scheduledDate) return null;

    // Comparar se hoje é o dia agendado (ignorando hora)
    const today = new Date();
    const scheduledDay = new Date(scheduledDate);
    
    const isSameDayAsSale = 
      today.getDate() === scheduledDay.getDate() &&
      today.getMonth() === scheduledDay.getMonth() &&
      today.getFullYear() === scheduledDay.getFullYear();

    // Definir número de dias úteis baseado na regra
    const workingDaysNeeded = isSameDayAsSale ? 2 : 3;

    const saturdayEnabled = deliveryWeekdays.includes('sabado');
    let workingDaysCount = 0;
    let currentDate = new Date(today); // Usar data atual como base

    while (workingDaysCount < workingDaysNeeded) {
      currentDate.setDate(currentDate.getDate() + 1);
      const dayOfWeek = currentDate.getDay();

      // Segunda a sexta sempre conta
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        workingDaysCount++;
      }
      // Sábado conta se estiver habilitado
      else if (dayOfWeek === 6 && saturdayEnabled) {
        workingDaysCount++;
      }
    }

    return currentDate;
  };

  if (!card) return null;

  // Sempre calcular a próxima data baseada nos dias de visita do cliente
  const scheduledDate = calculateNextScheduledDate();
  const deliveryDate = calculateDeliveryDate(scheduledDate);

  // Dias da semana disponíveis
  const weekdays = [
    { value: 'segunda', label: 'Segunda-feira' },
    { value: 'terca', label: 'Terça-feira' },
    { value: 'quarta', label: 'Quarta-feira' },
    { value: 'quinta', label: 'Quinta-feira' },
    { value: 'sexta', label: 'Sexta-feira' },
    { value: 'sabado', label: 'Sábado' },
    { value: 'domingo', label: 'Domingo' }
  ];

  // Horários disponíveis das 7h às 19h
  const timeSlots = [
    '07:00', '08:00', '09:00', '10:00', '11:00', '12:00',
    '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'
  ];

  // Função para gerenciar checkboxes de dias da semana
  const handleWeekdayChange = (weekday: string, checked: boolean) => {
    setDeliveryWeekdays(checked 
      ? [...deliveryWeekdays, weekday]
      : deliveryWeekdays.filter(w => w !== weekday)
    );
  };

  // Função para gerenciar weekdays do cliente (baseado na periodicidade)
  const handleCustomerWeekdayChange = (weekday: string, checked: boolean) => {
    if (checked) {
      // Se periodicidade é semanal, permitir 2 dias. Senão, apenas 1 dia.
      const maxDays = customerVisitPeriodicity === 'semanal' ? 2 : 1;
      
      if (customerWeekdays.length >= maxDays) {
        toast({
          title: "Limite atingido",
          description: customerVisitPeriodicity === 'semanal' 
            ? "Clientes com frequência semanal podem ter no máximo 2 dias de visita."
            : "Clientes com frequência quinzenal, mensal ou bimestral podem ter apenas 1 dia de visita.",
          variant: "destructive",
        });
        return;
      }
      setCustomerWeekdays([...customerWeekdays, weekday]);
    } else {
      setCustomerWeekdays(customerWeekdays.filter(w => w !== weekday));
    }
  };

  // Função para salvar dados do cliente
  const handleSaveCustomerInfo = async () => {
    if (!card?.customer?.id) return;
    
    await updateCustomerMutation.mutateAsync({
      id: card.customer.id,
      data: {
        weekdays: JSON.stringify(customerWeekdays),
        visitPeriodicity: customerVisitPeriodicity || null,
        phone: customerPhone,
        latitude: latitude || null,
        longitude: longitude || null
      }
    });
  };

  // Função para gerenciar checkboxes de horários
  const handleTimeSlotChange = (timeSlot: string, checked: boolean) => {
    setDeliveryTimeSlots(checked 
      ? [...deliveryTimeSlots, timeSlot]
      : deliveryTimeSlots.filter(t => t !== timeSlot)
    );
  };

  // Função para capturar localização atual
  const captureCurrentLocation = async () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Geolocalização não é suportada pelo navegador.",
        variant: "destructive",
      });
      return;
    }

    setIsCapturingLocation(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCustomerLatitude(position.coords.latitude.toString());
        setCustomerLongitude(position.coords.longitude.toString());
        toast({
          title: "Sucesso",
          description: "Localização capturada com sucesso!",
        });
        setIsCapturingLocation(false);
      },
      (error) => {
        let errorMessage = 'Erro desconhecido';
        switch(error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = "Permissão negada. Permita acesso à localização.";
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = "Localização indisponível.";
            break;
          case error.TIMEOUT:
            errorMessage = "Tempo esgotado para capturar localização.";
            break;
        }
        toast({
          title: "Erro de Localização",
          description: errorMessage,
          variant: "destructive",
        });
        setIsCapturingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <ShoppingCart className="h-6 w-6 text-blue-600" />
            <span>Finalizar Venda - {card.customer.name}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Informações do Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Cliente</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="font-semibold">{card.customer.name}</p>
                  <p className="text-sm text-gray-600">{card.customer.phone}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Endereço:</p>
                  <p className="text-sm">{card.customer.address}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Informações de Rota e Periodicidade do Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Route className="h-5 w-5 text-green-600" />
                <span>Rota e Periodicidade do Cliente</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Telefone do Cliente (Editável por todos) */}
                <div>
                  <Label className="flex items-center space-x-1">
                    <Phone className="h-4 w-4" />
                    <span>Telefone de Contato</span>
                  </Label>
                  <Input
                    type="tel"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="(00) 00000-0000"
                    data-testid="input-customer-phone"
                  />
                </div>

                {/* Latitude e Longitude do Cliente */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="flex items-center space-x-1">
                      <MapPin className="h-4 w-4" />
                      <span>Latitude</span>
                    </Label>
                    <Input
                      type="text"
                      value={latitude}
                      onChange={(e) => setLatitude(e.target.value)}
                      placeholder="-23.550520"
                      data-testid="input-latitude"
                    />
                  </div>
                  <div>
                    <Label className="flex items-center space-x-1">
                      <MapPin className="h-4 w-4" />
                      <span>Longitude</span>
                    </Label>
                    <Input
                      type="text"
                      value={longitude}
                      onChange={(e) => setLongitude(e.target.value)}
                      placeholder="-46.633308"
                      data-testid="input-longitude"
                    />
                  </div>
                </div>

                {/* Botão para Capturar Localização */}
                <Button
                  type="button"
                  onClick={captureLocation}
                  variant="outline"
                  className="w-full"
                  disabled={isCapturingLocation}
                  data-testid="button-capture-location"
                >
                  <MapPin className="h-4 w-4 mr-2" />
                  {isCapturingLocation ? 'Capturando localização...' : 'Capturar Localização Atual'}
                </Button>

                {/* Dias de Visita do Cliente */}
                <div>
                  <Label className="text-sm font-medium mb-3 block">
                    Dias de Visita do Cliente {customerVisitPeriodicity === 'semanal' ? '(máximo 2 dias)' : '(1 dia apenas)'}
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    {weekdays.map((day) => (
                      <div key={day.value} className="flex items-center space-x-2">
                        <Checkbox
                          id={`customer-weekday-${day.value}`}
                          checked={customerWeekdays.includes(day.value)}
                          onCheckedChange={(checked) => handleCustomerWeekdayChange(day.value, checked as boolean)}
                          data-testid={`checkbox-customer-weekday-${day.value}`}
                        />
                        <Label 
                          htmlFor={`customer-weekday-${day.value}`} 
                          className="text-sm font-normal cursor-pointer"
                        >
                          {day.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {customerWeekdays.length}/{customerVisitPeriodicity === 'semanal' ? '2' : '1'} dias selecionados
                  </p>
                </div>

                {/* Periodicidade de Visita do Cliente */}
                <div>
                  <Label>Periodicidade de Visita do Cliente</Label>
                  <Select 
                    value={customerVisitPeriodicity} 
                    onValueChange={setCustomerVisitPeriodicity}
                  >
                    <SelectTrigger data-testid="select-customer-periodicity">
                      <SelectValue placeholder="Selecione a periodicidade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="semanal">Semanal</SelectItem>
                      <SelectItem value="quinzenal">Quinzenal</SelectItem>
                      <SelectItem value="mensal">Mensal</SelectItem>
                      <SelectItem value="bimestral">Bimestral</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Botão para Salvar Informações do Cliente */}
                <Button
                  onClick={handleSaveCustomerInfo}
                  disabled={updateCustomerMutation.isPending}
                  variant="outline"
                  className="w-full"
                  data-testid="button-save-customer-info"
                >
                  {updateCustomerMutation.isPending ? 'Salvando...' : 'Salvar Informações do Cliente'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Configurações de Entrega */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Truck className="h-5 w-5 text-blue-600" />
                <span>Configurações de Entrega</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Dias da Semana */}
              <div className="mb-6">
                <Label className="text-sm font-medium mb-3 block">Dias da Semana para Entrega</Label>
                <div className="grid grid-cols-2 gap-3">
                  {weekdays.map((day) => (
                    <div key={day.value} className="flex items-center space-x-2">
                      <Checkbox
                        id={`weekday-${day.value}`}
                        checked={deliveryWeekdays.includes(day.value)}
                        onCheckedChange={(checked) => handleWeekdayChange(day.value, checked as boolean)}
                        data-testid={`checkbox-weekday-${day.value}`}
                      />
                      <Label 
                        htmlFor={`weekday-${day.value}`} 
                        className="text-sm font-normal cursor-pointer"
                      >
                        {day.label}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Horários de Entrega */}
              <div>
                <div className="flex items-center space-x-2 mb-3">
                  <Clock className="h-4 w-4 text-blue-600" />
                  <Label className="text-sm font-medium">Horários Disponíveis para Entrega</Label>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {timeSlots.map((time) => (
                    <div key={time} className="flex items-center space-x-2">
                      <Checkbox
                        id={`time-${time}`}
                        checked={deliveryTimeSlots.includes(time)}
                        onCheckedChange={(checked) => handleTimeSlotChange(time, checked as boolean)}
                        data-testid={`checkbox-time-${time}`}
                      />
                      <Label 
                        htmlFor={`time-${time}`} 
                        className="text-xs font-normal cursor-pointer"
                      >
                        {time}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Georreferenciamento do Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <MapPin className="h-5 w-5 text-green-600" />
                <span>Localização do Cliente (Georreferenciamento)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <Label htmlFor="customerLatitude">Latitude</Label>
                  <Input
                    id="customerLatitude"
                    type="text"
                    value={customerLatitude}
                    onChange={(e) => setCustomerLatitude(e.target.value)}
                    placeholder="Ex: -23.550520"
                    data-testid="input-latitude"
                  />
                </div>
                <div>
                  <Label htmlFor="customerLongitude">Longitude</Label>
                  <Input
                    id="customerLongitude"
                    type="text"
                    value={customerLongitude}
                    onChange={(e) => setCustomerLongitude(e.target.value)}
                    placeholder="Ex: -46.633309"
                    data-testid="input-longitude"
                  />
                </div>
              </div>
              
              <Button
                type="button"
                variant="outline"
                onClick={captureCurrentLocation}
                disabled={isCapturingLocation}
                className="flex items-center space-x-2"
                data-testid="button-capture-location"
              >
                <Target className={`h-4 w-4 ${isCapturingLocation ? 'animate-pulse' : ''}`} />
                <span>
                  {isCapturingLocation ? 'Capturando...' : 'Capturar Localização Atual'}
                </span>
              </Button>
            </CardContent>
          </Card>

          {/* Produtos */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Package className="h-5 w-5 text-blue-600" />
                <span>Produtos</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Lista de produtos ativos com checkbox */}
              <div className="space-y-3">
                {Array.isArray(availableProducts) && availableProducts
                  .filter((p: any) => p.isActive === true)
                  .map((product: any) => {
                    const selectedProduct = products.find(p => p.id === product.id);
                    const isSelected = !!selectedProduct;
                    
                    return (
                      <div key={product.id} className="p-4 bg-gray-50 rounded-lg space-y-3">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`product-${product.id}`}
                            checked={isSelected}
                            onCheckedChange={(checked) => handleProductToggle(product.id, checked as boolean)}
                            data-testid={`checkbox-product-${product.id}`}
                          />
                          <Label 
                            htmlFor={`product-${product.id}`} 
                            className="text-sm font-medium cursor-pointer flex-1"
                          >
                            {product.name}
                          </Label>
                        </div>
                        
                        {isSelected && (
                          <div className="grid grid-cols-3 gap-3 ml-6">
                            <div>
                              <Label className="text-xs">Quantidade</Label>
                              <Input
                                type="number"
                                min="1"
                                value={selectedProduct.quantity}
                                onChange={(e) => updateProductQuantity(product.id, parseInt(e.target.value) || 1)}
                                data-testid={`input-quantity-${product.id}`}
                              />
                            </div>
                            <div>
                              <Label className="text-xs">Preço Unit. (R$)</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={selectedProduct.unitPrice}
                                onChange={(e) => updateProductPrice(product.id, parseFloat(e.target.value) || 0)}
                                data-testid={`input-price-${product.id}`}
                              />
                            </div>
                            <div>
                              <Label className="text-xs">Total (R$)</Label>
                              <Input
                                value={selectedProduct.totalPrice.toFixed(2)}
                                disabled
                                className="bg-green-50 font-semibold"
                                data-testid={`input-total-${product.id}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                }
              </div>
              
              {/* Total Geral */}
              {products.length > 0 && (
                <div className="border-t pt-4 mt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-semibold">Total Geral:</span>
                    <span className="text-2xl font-bold text-green-600">
                      {new Intl.NumberFormat('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      }).format(calculateTotal())}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Detalhes da Venda */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <CreditCard className="h-5 w-5 text-purple-600" />
                <span>Detalhes da Venda</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Método de Pagamento</Label>
                  <Select 
                    value={paymentMethod} 
                    onValueChange={setPaymentMethod}
                  >
                    <SelectTrigger 
                      data-testid="select-payment-method"
                      disabled={operationType === 'troca' || operationType === 'amostra'}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="a_vista">À Vista</SelectItem>
                      <SelectItem value="boleto">Boleto</SelectItem>
                      <SelectItem value="pix">PIX</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div>
                  <Label>Tipo de Operação</Label>
                  <Select value={operationType} onValueChange={setOperationType}>
                    <SelectTrigger data-testid="select-operation-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="venda">Venda</SelectItem>
                      <SelectItem value="troca">Troca</SelectItem>
                      <SelectItem value="amostra">Amostra</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Prazo do Boleto (exibido apenas quando boleto for selecionado e operação for venda) */}
              {paymentMethod === 'boleto' && operationType === 'venda' && (
                <div>
                  <Label>Prazo do Boleto</Label>
                  <Select 
                    value={boletoDays.toString()} 
                    onValueChange={(value) => setBoletoDays(parseInt(value))}
                  >
                    <SelectTrigger data-testid="select-boleto-days">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7 dias</SelectItem>
                      <SelectItem value="14">14 dias</SelectItem>
                      <SelectItem value="21">21 dias</SelectItem>
                      <SelectItem value="28">28 dias</SelectItem>
                      <SelectItem value="32">32 dias</SelectItem>
                      <SelectItem value="35">35 dias</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Alerta quando prazo do boleto > 7 dias */}
              {paymentMethod === 'boleto' && operationType === 'venda' && boletoDays > 7 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4" data-testid="alert-boleto-blocked">
                  <div className="flex items-start space-x-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-yellow-900">Pedido Bloqueado</p>
                      <p className="text-sm text-yellow-700">
                        Pedidos com prazo de boleto acima de 7 dias ficam bloqueados e precisam de aprovação.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              
              <div>
                <Label>Observações</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Observações sobre a venda..."
                  rows={3}
                  data-testid="textarea-notes"
                />
              </div>

              {/* Previsão de Entrega */}
              {deliveryDate && (
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                  <div className="flex items-center space-x-2 mb-2">
                    <Truck className="h-5 w-5 text-blue-600" />
                    <Label className="text-sm font-medium text-blue-900">Previsão de Entrega</Label>
                  </div>
                  <p className="text-sm text-blue-700">
                    Data prevista: <span className="font-bold" data-testid="text-delivery-date">
                      {deliveryDate.toLocaleDateString('pt-BR', { 
                        day: '2-digit', 
                        month: 'long', 
                        year: 'numeric' 
                      })}
                    </span>
                  </p>
                  <p className="text-xs text-blue-600 mt-1">
                    (2 dias úteis após o agendamento{deliveryWeekdays.includes('sabado') ? ', incluindo sábado' : ''})
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Botões de Ação */}
        <div className="flex justify-between space-x-3 pt-6 border-t">
          <div className="flex space-x-2">
            <Button 
              variant="outline" 
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            
            <Button 
              variant="outline" 
              onClick={handleNoSale}
              disabled={isSubmitting}
              className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300"
            >
              <XCircle className="h-4 w-4 mr-2" />
              Venda Não Realizada
            </Button>
          </div>
          
          <div className="flex space-x-2">
            <Button 
              onClick={handleFinalizeSale}
              disabled={isSubmitting || products.length === 0}
              className="bg-green-500 hover:bg-green-600"
            >
              {isSubmitting ? (
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Finalizar Venda
            </Button>
            
            <Button 
              onClick={handleSendToFaturamento}
              disabled={isSubmitting || products.length === 0}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {isSubmitting ? (
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
              ) : (
                <DollarSign className="h-4 w-4 mr-2" />
              )}
              Finalizar e Enviar p/ Faturamento
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}