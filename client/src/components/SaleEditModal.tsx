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
  Phone
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
  const [customerWeekdays, setCustomerWeekdays] = useState<string[]>([]);
  const [customerVisitPeriodicity, setCustomerVisitPeriodicity] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
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
      
      // Carregar weekdays, periodicidade e telefone do cliente
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
      }
    } else {
      // Valores padrão quando não há card
      setProducts([]);
      setPaymentMethod('a_vista');
      setOperationType('venda');
      setNotes('');
      setRouteDay('');
      setRecurrenceType('');
      setDeliveryWeekdays(['segunda', 'terca', 'quarta', 'quinta', 'sexta']);
      setDeliveryTimeSlots(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
      setCustomerLatitude('');
      setCustomerLongitude('');
      setCustomerWeekdays([]);
      setCustomerVisitPeriodicity('');
    }
  }, [card]);

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

  const addProduct = () => {
    setProducts([...products, {
      id: '',
      name: '',
      quantity: 1,
      unitPrice: 0,
      totalPrice: 0
    }]);
  };

  const removeProduct = (index: number) => {
    setProducts(products.filter((_, i) => i !== index));
  };

  const updateProduct = (index: number, field: keyof ProductItem, value: any) => {
    const updatedProducts = [...products];
    updatedProducts[index] = { ...updatedProducts[index], [field]: value };
    
    // Recalcular total do produto
    if (field === 'quantity' || field === 'unitPrice') {
      updatedProducts[index].totalPrice = updatedProducts[index].quantity * updatedProducts[index].unitPrice;
    }
    
    setProducts(updatedProducts);
  };

  const selectProductById = (index: number, productId: string) => {
    if (!availableProducts || !Array.isArray(availableProducts)) return;
    
    const selectedProduct = availableProducts.find((p: any) => p.id === productId);
    if (selectedProduct) {
      const updatedProducts = [...products];
      updatedProducts[index] = {
        ...updatedProducts[index],
        id: selectedProduct.id,
        name: selectedProduct.name,
        unitPrice: parseFloat(selectedProduct.price || '0'),
        totalPrice: updatedProducts[index].quantity * parseFloat(selectedProduct.price || '0')
      };
      setProducts(updatedProducts);
    }
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
      // Atualizar card com dados da venda
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
          completedDate: new Date()
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

  if (!card) return null;

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

  // Função para gerenciar weekdays do cliente (máximo 2 dias)
  const handleCustomerWeekdayChange = (weekday: string, checked: boolean) => {
    if (checked) {
      if (customerWeekdays.length >= 2) {
        toast({
          title: "Limite atingido",
          description: "Cada cliente pode ter no máximo 2 dias de visita por semana.",
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
        phone: customerPhone
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

                {/* Dias de Visita do Cliente */}
                <div>
                  <Label className="text-sm font-medium mb-3 block">
                    Dias de Visita do Cliente (máximo 2 dias)
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
                    {customerWeekdays.length}/2 dias selecionados
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
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Package className="h-5 w-5 text-blue-600" />
                  <span>Produtos</span>
                </div>
                <Button onClick={addProduct} size="sm" className="bg-green-500 hover:bg-green-600">
                  <Plus className="h-4 w-4 mr-1" />
                  Adicionar
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {products.map((product, index) => (
                <div key={index} className="grid grid-cols-12 gap-3 items-end p-4 bg-gray-50 rounded-lg">
                  <div className="col-span-4">
                    <Label>Produto</Label>
                    <Select 
                      value={product.id} 
                      onValueChange={(value) => selectProductById(index, value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione um produto" />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.isArray(availableProducts) && availableProducts
                          .filter((p: any) => {
                            // Mostra o produto se:
                            // 1. Não está selecionado em nenhum outro campo, OU
                            // 2. É o produto já selecionado neste campo atual
                            const isUsedElsewhere = products.some((prod, i) => 
                              i !== index && prod.id === p.id && prod.id !== ''
                            );
                            return !isUsedElsewhere;
                          })
                          .map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))
                        }
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="col-span-2">
                    <Label>Quantidade</Label>
                    <Input
                      type="number"
                      min="1"
                      value={product.quantity}
                      onChange={(e) => updateProduct(index, 'quantity', parseInt(e.target.value) || 1)}
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <Label>Preço Unit.</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={product.unitPrice}
                      onChange={(e) => updateProduct(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <Label>Total</Label>
                    <Input
                      value={product.totalPrice.toFixed(2)}
                      disabled
                      className="bg-green-50 font-semibold"
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => removeProduct(index)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              
              {products.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Package className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                  <p>Nenhum produto adicionado</p>
                  <p className="text-sm">Clique em "Adicionar" para incluir produtos</p>
                </div>
              )}
              
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
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger>
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
                    <SelectTrigger>
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

              {/* Recorrência e Dia da Rota */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Dia da Rota</Label>
                  <Select 
                    value={routeDay} 
                    onValueChange={setRouteDay}
                  >
                    <SelectTrigger data-testid="select-route-day">
                      <SelectValue placeholder="Selecione o dia" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="segunda">Segunda-feira</SelectItem>
                      <SelectItem value="terca">Terça-feira</SelectItem>
                      <SelectItem value="quarta">Quarta-feira</SelectItem>
                      <SelectItem value="quinta">Quinta-feira</SelectItem>
                      <SelectItem value="sexta">Sexta-feira</SelectItem>
                      <SelectItem value="sabado">Sábado</SelectItem>
                      <SelectItem value="domingo">Domingo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Recorrência</Label>
                  <Select 
                    value={recurrenceType} 
                    onValueChange={setRecurrenceType}
                  >
                    <SelectTrigger data-testid="select-recurrence-type">
                      <SelectValue placeholder="Selecione a recorrência" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="semanal">Semanal</SelectItem>
                      <SelectItem value="quinzenal">Quinzenal</SelectItem>
                      <SelectItem value="mensal">Mensal</SelectItem>
                      <SelectItem value="bimestral">Bimestral</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div>
                <Label>Observações</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Observações sobre a venda..."
                  rows={3}
                />
              </div>
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