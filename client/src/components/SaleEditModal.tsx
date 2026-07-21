import { useState, useEffect } from "react";
import { useMutation, useQueryClient, useQuery } from "@/lib/queryClient";
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
import { useLocation } from "wouter";
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import honestLogo from '@/assets/honest-logo.png';
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
  AlertTriangle,
  FileText,
  MessageCircle,
  LogOut
} from "lucide-react";
import type { SalesCardWithRelations } from "@shared/schema";
import { PAYMENT_METHOD_LABELS, OPERATION_TYPE_LABELS } from "@shared/schema";

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
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { user, isLoading: userLoading } = useAuth();
  
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('a_vista');
  const [operationType, setOperationType] = useState('venda');
  const [notes, setNotes] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [routeDay, setRouteDay] = useState('');
  const [recurrenceType, setRecurrenceType] = useState('');
  const [deliveryWeekdays, setDeliveryWeekdays] = useState<string[]>(['Seg', 'Ter', 'Qua', 'Qui', 'Sex']);
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
  // Agendamento de pedido: quando marcado, o pedido entra na etapa "Agendado" do faturamento e migra
  // automaticamente para "Pedido" na data escolhida.
  const [isScheduledOrder, setIsScheduledOrder] = useState(false);
  const [scheduledOrderDate, setScheduledOrderDate] = useState('');
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  
  // Verificar se usuário pode editar recorrência e dia da rota
  // Permitir edição se: está carregando OU é admin/coordinator/administrative
  const canManageRouteAndRecurrence = userLoading || (user && ['admin', 'coordinator', 'administrative'].includes(user.role));

  // Buscar produtos disponíveis
  const { data: availableProducts, isLoading: isLoadingProducts, refetch: refetchProducts } = useQuery({
    queryKey: ['/api/products'],
    retry: 3,
    staleTime: 60000,
  });

  useEffect(() => {
    if (card) {
      // Card ja finalizado (completed/blocked) abre SEM os produtos do pedido antigo, para evitar
      // que o pedido concluido reapareca em tela e seja reenviado (duplicata de pedido).
      const _jaRegistrado = ((card as any).status === 'completed' || (card as any).status === 'blocked');
      setProducts(_jaRegistrado ? [] : (card.products || []));
      setPaymentMethod(card.paymentMethod || 'a_vista');
      setOperationType(card.operationType || 'venda');
      setNotes(card.notes || '');
      setRouteDay(card.routeDay || '');
      setRecurrenceType(card.recurrenceType || '');
      setBoletoDays((card as any).boletoDays || 7);
      setIsScheduledOrder(false);
      setScheduledOrderDate('');

      // Se o card tem configurações de entrega, usa elas, senão usa os valores padrão
      const defaultWeekdays = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
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
      setIsScheduledOrder(false);
      setScheduledOrderDate('');
      setDeliveryWeekdays(['Seg', 'Ter', 'Qua', 'Qui', 'Sex']);
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

  // Mutation para atualizar e FINALIZAR a venda (fecha modal)
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

  // Mutation dedicada para SALVAR produtos sem finalizar (mantém modal aberto)
  const saveProductsMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await apiRequest('PUT', `/api/sales-cards/${id}`, data);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      // NÃO fecha o modal - permite continuar editando
      console.log('✅ Produtos salvos (modal permanece aberto):', data);
    },
    onError: (error) => {
      console.error('❌ Erro ao salvar produtos:', error);
      // Error will be caught and handled in handleSaveProducts
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
      const scheduledBillingDate = (isScheduledOrder && scheduledOrderDate) ? scheduledOrderDate : undefined;
      await apiRequest('POST', `/api/sales-cards/${cardId}/send-to-omie`, { scheduledBillingDate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      queryClient.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
      if (isScheduledOrder && scheduledOrderDate) {
        const d = new Date(`${scheduledOrderDate}T12:00:00-03:00`);
        toast({
          title: "Pedido agendado",
          description: `Ficará em "Agendado" e migra para "Pedido" em ${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
        });
      } else {
        toast({
          title: "Sucesso",
          description: "Pedido enviado para faturamento!",
        });
      }
    },
    onError: (error) => {
      toast({
        title: "Erro ao Enviar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const duplicateCardMutation = useMutation({
    mutationFn: async (cardId: string) => {
      const today = new Date();
      return await apiRequest('POST', `/api/sales-cards/${cardId}/duplicate`, {
        newDate: today.toISOString().split('T')[0]
      });
    },
    onSuccess: (duplicatedCard: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Último pedido duplicado! Abrindo novo card para edição...",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro ao Duplicar",
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
          quantity: 0,
          unitPrice: parseFloat(selectedProduct.price || '0'),
          totalPrice: 0
        }]);
      }
    } else {
      setProducts(products.filter(p => p.id !== productId));
    }
  };

  const updateProductQuantity = (productId: string, quantity: number) => {
    const updatedProducts = products.map(p => {
      if (p.id === productId) {
        const qty = Number.isFinite(quantity) ? quantity : 0;
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
      const error = new Error("Adicione pelo menos um produto para finalizar a venda.");
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
      throw error;
    }

    const totalValue = calculateTotal();
    const minValue = operationType === 'venda' ? 10 : 0;
    
    if (totalValue < minValue) {
      const error = new Error(`Valor mínimo para venda é R$ ${minValue.toFixed(2)}`);
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
      throw error;
    }

    if (!card) {
      throw new Error("Card não encontrado");
    }

    setIsSubmitting(true);
    try {
      // A próxima data será calculada automaticamente pelo backend ao completar
      const nextScheduledDate = null;

      // Se o telefone foi alterado, atualizar no cliente.
      // Não bloqueia a venda se falhar: o backend grava o telefone do comprador ao finalizar (customerPhone vai no PUT do card).
      if (customerPhone && customerPhone !== card.customer?.phone) {
        try {
          await updateCustomerMutation.mutateAsync({
            id: card.customerId,
            data: { phone: customerPhone }
          });
        } catch (_ePhone) {
          console.warn('Não foi possível atualizar o telefone do cliente antes de finalizar (seguindo; o backend grava no fechamento):', _ePhone);
        }
      }

      // Atualizar card com dados da venda e reagendar
      await updateCardMutation.mutateAsync({
        id: card.id,
        data: {
          status: 'completed',
          saleValue: totalValue.toFixed(2),
          customerPhone: (customerPhone || '').trim(),
          referralCode: (referralCode || '').trim() || undefined,
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
    } catch (error) {
      setIsSubmitting(false);
      throw error; // Propagar erro para handleSendToFaturamento
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendToFaturamento = async () => {
    if (!card?.id) return;

    // Validação do agendamento: exige uma data (hoje ou futura) quando "Agendar pedido" está marcado.
    if (isScheduledOrder) {
      if (!scheduledOrderDate) {
        toast({
          title: "Selecione a data",
          description: "Marque a data para a qual o pedido será agendado.",
          variant: "destructive",
        });
        return;
      }
      if (scheduledOrderDate < todayISO) {
        toast({
          title: "Data inválida",
          description: "A data de agendamento não pode ser no passado.",
          variant: "destructive",
        });
        return;
      }
    }

    // 🔒 TRAVA: telefone do comprador obrigatório e válido para finalizar a venda
    const _phoneDigits = (customerPhone || '').replace(/\D/g, '');
    if (_phoneDigits.length < 10 || _phoneDigits.length > 13) {
      toast({
        title: "Telefone do comprador obrigatório",
        description: "Informe o telefone de contato do cliente (DDD + número) no campo \"Telefone do comprador\" para finalizar a venda.",
        variant: "destructive",
      });
      return;
    }
    // Anti-número-falso: repetidos, sequências óbvias, placeholder (00)00000-0000 e o próprio celular do vendedor
    const _sellerDigits = String((user as any)?.phone || '').replace(/\D/g, '');
    const _isFakePhone = /^(\d)\1+$/.test(_phoneDigits)
      || '01234567890123456789'.includes(_phoneDigits)
      || '98765432109876543210'.includes(_phoneDigits)
      || _phoneDigits.includes('00000')
      || (_sellerDigits.length >= 10 && _phoneDigits === _sellerDigits);
    if (_isFakePhone) {
      toast({
        title: "Telefone inválido",
        description: "Informe um número real do cliente. Números repetidos, sequências ou o telefone do próprio vendedor não são aceitos.",
        variant: "destructive",
      });
      return;
    }

    try {
      // Primeiro finalizar a venda
      await handleFinalizeSale();
      
      // Aguardar um pouco para garantir que a venda foi salva
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Depois enviar para faturamento
      sendToOmieMutation.mutate(card.id);
    } catch (error: any) {
      console.error('Erro ao finalizar venda antes de enviar para Omie:', error);
      toast({
        title: "Erro ao Finalizar",
        description: error.message || "Não foi possível finalizar a venda antes de enviar para o Omie.",
        variant: "destructive",
      });
    }
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

  const handleDuplicateLastOrder = async () => {
    if (!card?.id) {
      toast({
        title: "Erro",
        description: "Card não encontrado",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      duplicateCardMutation.mutate(card.id);
    } finally {
      setIsSubmitting(false);
    }
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

    const saturdayEnabled = deliveryWeekdays.includes('Sab');
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
    { value: 'Seg', label: 'Segunda-feira' },
    { value: 'Ter', label: 'Terça-feira' },
    { value: 'Qua', label: 'Quarta-feira' },
    { value: 'Qui', label: 'Quinta-feira' },
    { value: 'Sex', label: 'Sexta-feira' },
    { value: 'Sab', label: 'Sábado' },
    { value: 'Dom', label: 'Domingo' }
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
        weekdays: customerWeekdays,
        visitPeriodicity: customerVisitPeriodicity || null,
        phone: customerPhone,
        latitude: latitude || null,
        longitude: longitude || null
      }
    });
  };

  // Função para gerar PDF do pedido
  const generateOrderPDF = () => {
    if (products.length === 0) {
      toast({
        title: "Erro",
        description: "Adicione produtos antes de gerar o PDF.",
        variant: "destructive",
      });
      return;
    }

    const pdf = new jsPDF();
    
    // Adicionar logomarca
    try {
      pdf.addImage(honestLogo, 'PNG', 150, 10, 40, 40);
    } catch (error) {
      console.log('Erro ao carregar logomarca:', error);
    }
    
    // Título
    pdf.setFontSize(20);
    pdf.text('PEDIDO DE VENDA', 20, 30);
    
    // Informações da empresa
    pdf.setFontSize(12);
    pdf.text('Honest Sucos', 20, 50);
    pdf.text('Sucos Naturais e Saudáveis', 20, 60);
    
    // Informações do cliente
    if (card?.customer) {
      pdf.text(`Cliente: ${card.customer.fantasyName || card.customer.name}`, 20, 80);
      if (card.customer.cnpj) pdf.text(`CNPJ: ${card.customer.cnpj}`, 20, 90);
      if (card.customer.cpf) pdf.text(`CPF: ${card.customer.cpf}`, 20, 90);
      if (customerPhone) pdf.text(`Telefone: ${customerPhone}`, 20, 100);
      if (card.customer.address) pdf.text(`Endereço: ${card.customer.address}`, 20, 110);
    }
    
    // Informações do pedido
    pdf.text(`Número do Pedido: HS-${Date.now()}`, 20, 130);
    pdf.text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, 20, 140);
    pdf.text(`Forma de Pagamento: ${PAYMENT_METHOD_LABELS[paymentMethod as keyof typeof PAYMENT_METHOD_LABELS]}`, 20, 150);
    if (paymentMethod === 'boleto') {
      pdf.text(`Prazo do Boleto: ${boletoDays} dias`, 20, 160);
    }
    pdf.text(`Tipo de Operação: ${OPERATION_TYPE_LABELS[operationType as keyof typeof OPERATION_TYPE_LABELS]}`, 20, 170);
    
    // Tabela de produtos
    const tableColumn = ['Produto', 'Qtd', 'Preço Unit.', 'Total'];
    const tableRows = products.map(item => [
      item.name,
      item.quantity.toString(),
      `R$ ${item.unitPrice.toFixed(2)}`,
      `R$ ${item.totalPrice.toFixed(2)}`
    ]);
    
    autoTable(pdf, {
      head: [tableColumn],
      body: tableRows,
      startY: 190,
      styles: {
        fontSize: 10,
        cellPadding: 3
      },
      headStyles: {
        fillColor: [41, 128, 185],
        textColor: 255
      }
    });
    
    // Total da venda
    const finalY = (pdf as any).lastAutoTable?.finalY || 250;
    pdf.setFontSize(14);
    pdf.text(`TOTAL GERAL: R$ ${calculateTotal().toFixed(2)}`, 20, finalY + 20);
    
    // Previsão de entrega
    if (deliveryDate) {
      pdf.setFontSize(10);
      pdf.text(`Previsão de Entrega: ${deliveryDate.toLocaleDateString('pt-BR', { 
        day: '2-digit', 
        month: 'long', 
        year: 'numeric',
        timeZone: 'America/Sao_Paulo'
      })}`, 20, finalY + 40);
    }
    
    // Observações
    pdf.setFontSize(10);
    pdf.text('Observações:', 20, finalY + 60);
    pdf.text('- Produtos naturais, sem conservantes.', 20, finalY + 70);
    if (notes) {
      const notesLines = pdf.splitTextToSize(notes, 170);
      pdf.text(notesLines, 20, finalY + 80);
    }
    
    // Salvar PDF
    const fileName = `pedido-${card?.customer?.name || 'cliente'}-${Date.now()}.pdf`;
    pdf.save(fileName);
    
    toast({
      title: "PDF Gerado",
      description: "O pedido foi gerado e baixado com sucesso!",
    });
  };

  // Função para enviar PDF via WhatsApp
  const sendPDFToWhatsApp = async () => {
    if (!card?.customer?.phone && !customerPhone) {
      toast({
        title: "Erro",
        description: "Cliente não possui número de WhatsApp cadastrado.",
        variant: "destructive"
      });
      return;
    }

    if (products.length === 0) {
      toast({
        title: "Erro",
        description: "Adicione produtos antes de enviar.",
        variant: "destructive",
      });
      return;
    }

    // Gerar PDF primeiro
    generateOrderPDF();
    
    // Preparar mensagem para WhatsApp
    const phone = customerPhone || card?.customer?.phone || '';
    const cleanPhone = phone.replace(/\D/g, '');
    const customerName = card?.customer?.fantasyName || card?.customer?.name || 'Cliente';
    
    const message = `Olá ${customerName}! 📄

Segue o pedido da Honest Sucos:
• Total: R$ ${calculateTotal().toFixed(2)}
• Produtos: ${products.length} itens
• Pagamento: ${PAYMENT_METHOD_LABELS[paymentMethod as keyof typeof PAYMENT_METHOD_LABELS]}
${paymentMethod === 'boleto' ? `• Prazo: ${boletoDays} dias` : ''}
${deliveryDate ? `• Previsão de Entrega: ${deliveryDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ''}

🌿 Sucos naturais e saudáveis!

O PDF do pedido foi gerado. Por favor, anexe-o manualmente na conversa.`;

    // 💬 Criar conversa no Integra
    try {
      await apiRequest('/api/chat/conversations', 'POST', {
        customerPhone: card?.customer?.phone || phone,
        customerName: customerName
      });
      
      toast({
        title: "Sucesso",
        description: "Conversa criada! Redirecionando...",
      });
      
      setTimeout(() => {
        navigate('/telemarketing/atendimento');
      }, 500);
    } catch (error) {
      toast({
        title: "Erro",
        description: "Não foi possível criar a conversa",
        variant: "destructive",
      });
    }
  };

  // Função para salvar produtos sem finalizar a venda
  const handleSaveProducts = async () => {
    if (!card?.id) {
      console.error('handleSaveProducts: card ou card.id não está definido');
      return false;
    }

    // Validação: não permitir salvar lista vazia
    if (products.length === 0) {
      toast({
        title: "Nenhum Produto",
        description: "Adicione pelo menos um produto antes de salvar.",
        variant: "destructive"
      });
      return false;
    }

    // Validação: todos os produtos selecionados devem ter quantidade informada (>= 1)
    const semQuantidade = products.filter(p => !p.quantity || p.quantity < 1);
    if (semQuantidade.length > 0) {
      toast({
        title: "Quantidade não informada",
        description: "Informe a quantidade de todos os produtos selecionados antes de salvar.",
        variant: "destructive"
      });
      return false;
    }

    try {
      const totalValue = calculateTotal();
      
      console.log('🔄 Salvando produtos sem finalizar...', {
        cardId: card.id,
        productsCount: products.length,
        totalValue: totalValue.toFixed(2),
        products: products
      });
      
      // Usar mutation dedicada que não fecha o modal
      await saveProductsMutation.mutateAsync({
        id: card.id,
        data: {
          products: products,
          saleValue: totalValue.toFixed(2),
          paymentMethod: paymentMethod,
          operationType: operationType,
          notes: notes,
          deliveryWeekdays: deliveryWeekdays,
          deliveryTimeSlots: deliveryTimeSlots,
          customerLatitude: customerLatitude || null,
          customerLongitude: customerLongitude || null,
          boletoDays: boletoDays
          // NÃO enviamos 'status' aqui, então o card mantém status atual (in_progress)
        }
      });

      console.log('✅ Produtos salvos com sucesso (modal permanece aberto)');
      
      // Mostrar feedback de sucesso ao usuário
      toast({
        title: "✅ Produtos Salvos!",
        description: `${products.length} produto(s) salvos. Você pode continuar editando ou voltar depois para finalizar.`,
        duration: 4000,
      });
      
      return true;
    } catch (error: any) {
      console.error('❌ Erro ao salvar produtos:', error);
      toast({
        title: "Erro ao Salvar Produtos",
        description: error.message,
        variant: "destructive"
      });
      return false;
    }
  };

  // Função para fazer check-out na visita
  const handleCheckOut = async () => {
    if (!card?.id) return;

    // Salvar produtos antes de fazer check-out
    if (products.length > 0) {
      const saved = await handleSaveProducts();
      if (!saved) return; // Se falhou ao salvar, não continuar com check-out
      // Toast de sucesso já foi mostrado no handleSaveProducts, não duplicar aqui
    } else {
      toast({
        title: "Atenção",
        description: "Nenhum produto foi adicionado. Fazendo apenas check-out.",
        duration: 3000,
      });
    }

    try {
      // Buscar visita relacionada ao card
      const visitResponse = await fetch(`/api/visit-agenda?salesCardId=${card.id}`, {
        credentials: 'include'
      });

      if (!visitResponse.ok) {
        throw new Error('Erro ao buscar visita');
      }

      const visits = await visitResponse.json();
      
      if (!visits || visits.length === 0) {
        toast({
          title: "Aviso",
          description: "Nenhuma visita encontrada para este pedido.",
          variant: "destructive"
        });
        return;
      }

      const visit = visits[0];

      // Verificar se já foi feito check-in
      if (!visit.actualCheckIn) {
        toast({
          title: "Erro",
          description: "É necessário fazer check-in antes do check-out.",
          variant: "destructive"
        });
        return;
      }

      // Verificar se já foi feito check-out
      if (visit.actualCheckOut) {
        toast({
          title: "Aviso",
          description: "Check-out já foi realizado para esta visita.",
        });
        return;
      }

      // Capturar localização atual (robusto: cache rápido → GPS → tolerante; funciona indoor/supermercado)
      const getPos = (opts: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, opts);
      });
      let position: GeolocationPosition;
      try {
        position = await getPos({ enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
      } catch (e1) {
        try {
          position = await getPos({ enableHighAccuracy: true, timeout: 25000, maximumAge: 60000 });
        } catch (e2) {
          position = await getPos({ enableHighAccuracy: false, timeout: 30000, maximumAge: 600000 });
        }
      }

      // Fazer check-out
      const checkOutResponse = await fetch(`/api/visit-agenda/${visit.id}/check-out`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        })
      });

      if (!checkOutResponse.ok) {
        const error = await checkOutResponse.json();
        throw new Error(error.message || 'Erro ao fazer check-out');
      }

      const result = await checkOutResponse.json();

      toast({
        title: "Check-out Realizado!",
        description: result.message || "Check-out realizado com sucesso!",
      });

      queryClient.invalidateQueries({ queryKey: ['/api/visit-agenda'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      
      // Fechar o modal após sucesso
      onClose();
      
    } catch (error: any) {
      toast({
        title: "Erro no Check-out",
        description: error.message || "Não foi possível realizar o check-out.",
        variant: "destructive"
      });
    }
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
            <span>EFETUAR VENDA - {card.customer.fantasyName || card.customer.name}</span>
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
                  <p className="font-semibold">{card.customer.fantasyName || card.customer.name}</p>
                  <p className="text-sm text-gray-600">{card.customer.phone}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Endereço:</p>
                  <p className="text-sm">{card.customer.address}</p>
                </div>
              </div>
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
              {/* Carregando produtos */}
              {isLoadingProducts && (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-2"></div>
                  <p className="text-gray-600">Carregando produtos...</p>
                </div>
              )}

              {/* Erro ao carregar produtos */}
              {!isLoadingProducts && (!Array.isArray(availableProducts) || availableProducts.length === 0) && (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-2">
                  <p className="text-sm font-medium text-yellow-800">Nenhum produto disponível</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refetchProducts()}
                    className="text-yellow-800 border-yellow-300 hover:bg-yellow-100"
                  >
                    Tentar Novamente
                  </Button>
                </div>
              )}

              {/* Lista de produtos ativos com checkbox */}
              {!isLoadingProducts && Array.isArray(availableProducts) && availableProducts.length > 0 && (
                <div className="space-y-3">
                  {availableProducts
                    .filter((p: any) => p.isActive === true)
                    .slice()
                    .sort((a: any, b: any) => {
                      const grp = (n: string) => { const t = (n || '').toLowerCase(); return t.includes('350ml') ? 0 : (t.includes('900ml') || t.includes('500ml')) ? 1 : 2; };
                      return grp(a.name) - grp(b.name) || String(a.name).localeCompare(String(b.name), 'pt-BR');
                    })
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
                                  placeholder="Qtd"
                                  value={selectedProduct.quantity || ''}
                                  onChange={(e) => updateProductQuantity(product.id, e.target.value === '' ? 0 : (parseInt(e.target.value) || 0))}
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
              {/* 🔒 Telefone do comprador — obrigatório para finalizar a venda */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <Label className="font-semibold text-blue-900">Telefone do comprador *</Label>
                <Input
                  type="tel"
                  inputMode="numeric"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="(DDD) 9XXXX-XXXX"
                  data-testid="input-customer-phone"
                  className="mt-1"
                />
                <p className="text-xs text-blue-700 mt-1">
                  Obrigatório para finalizar. É o contato do cliente para confirmação de pedido e entrega.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Método de Pagamento</Label>
                  <Select 
                    value={paymentMethod} 
                    onValueChange={setPaymentMethod}
                  >
                    <SelectTrigger data-testid="select-payment-method">
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
                      <SelectItem value="transferencia">Transferência</SelectItem>
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

              <div>
                <Label>Código de indicação (opcional)</Label>
                <Input value={referralCode} onChange={(e) => setReferralCode(e.target.value)} placeholder="Cupom de indicação" data-testid="input-referral-code" />
              </div>

              {/* Agendamento de Pedido */}
              <div className="border border-cyan-200 bg-cyan-50 rounded-lg p-3 space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="agendar-pedido"
                    checked={isScheduledOrder}
                    onCheckedChange={(checked) => {
                      const val = checked === true;
                      setIsScheduledOrder(val);
                      if (!val) setScheduledOrderDate('');
                    }}
                    data-testid="checkbox-schedule-order"
                  />
                  <Label htmlFor="agendar-pedido" className="flex items-center gap-1.5 cursor-pointer text-cyan-900 font-medium">
                    <Calendar className="h-4 w-4" /> Agendar pedido
                  </Label>
                </div>
                {isScheduledOrder && (
                  <div>
                    <Label className="text-sm text-cyan-800">Data do agendamento</Label>
                    <Input
                      type="date"
                      value={scheduledOrderDate}
                      min={todayISO}
                      onChange={(e) => setScheduledOrderDate(e.target.value)}
                      className="mt-1"
                      data-testid="input-schedule-date"
                    />
                    <p className="text-xs text-cyan-700 mt-1">
                      O pedido ficará na etapa <strong>Agendado</strong> do faturamento e migrará para <strong>Pedido</strong> automaticamente nesta data.
                    </p>
                  </div>
                )}
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
                        year: 'numeric',
                        timeZone: 'America/Sao_Paulo'
                      })}
                    </span>
                  </p>
                  <p className="text-xs text-blue-600 mt-1">
                    (2 dias úteis após o agendamento{deliveryWeekdays.includes('Sab') ? ', incluindo sábado' : ''})
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Botões de Ação */}
        <div className="space-y-3 pt-6 border-t">
          {/* Linha 1: Botões de PDF e Check-out */}
          <div className="flex justify-between space-x-3">
            <div className="flex space-x-2">
              <Button 
                variant="outline" 
                onClick={onClose}
                disabled={isSubmitting}
                data-testid="button-cancel"
              >
                Cancelar
              </Button>
              
              <Button 
                variant="outline" 
                onClick={handleNoSale}
                disabled={isSubmitting}
                className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300"
                data-testid="button-no-sale"
              >
                <XCircle className="h-4 w-4 mr-2" />
                Venda Não Realizada
              </Button>
            </div>
            
            <div className="flex space-x-2">
              <Button 
                variant="outline" 
                onClick={generateOrderPDF}
                disabled={products.length === 0}
                className="bg-blue-50 hover:bg-blue-100"
                data-testid="button-generate-pdf"
              >
                <FileText className="h-4 w-4 mr-2" />
                Gerar PDF
              </Button>
              
              <Button 
                variant="outline" 
                onClick={sendPDFToWhatsApp}
                disabled={products.length === 0}
                className="bg-green-50 hover:bg-green-100"
                data-testid="button-send-whatsapp"
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Enviar WhatsApp
              </Button>
            </div>
          </div>
          
          {/* Botões de Ação - Salvar e Finalizar */}
          <div className="border-t pt-4 space-y-3">
            {/* Botão Duplicar Último Pedido */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-800 mb-2">
                📋 <strong>Duplicar Pedido:</strong> Cria um novo card com os mesmos produtos para amanhã.
              </p>
              <Button 
                variant="outline" 
                onClick={handleDuplicateLastOrder}
                disabled={isSubmitting}
                className="w-full bg-blue-100 hover:bg-blue-200 border-blue-300 text-blue-800"
                data-testid="button-duplicate-last-order"
              >
                <Package className="h-4 w-4 mr-2" />
                Duplicar Último Pedido
              </Button>
            </div>

            {/* Botão Salvar e Sair (sem finalizar) */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-sm text-yellow-800 mb-2">
                💡 <strong>Salvar e Sair:</strong> Os produtos serão salvos para finalizar depois. Você pode fazer check-out e voltar mais tarde.
              </p>
              <Button 
                variant="outline" 
                onClick={handleCheckOut}
                disabled={products.length === 0}
                className="w-full bg-yellow-100 hover:bg-yellow-200 border-yellow-300 text-yellow-800"
                data-testid="button-save-and-checkout"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Salvar Produtos e Fazer Check-out
              </Button>
            </div>

            {/* Botão de Finalizar e Enviar para Faturamento (ou Agendar) */}
            <div className={`${isScheduledOrder ? 'bg-cyan-50 border-cyan-200' : 'bg-orange-50 border-orange-200'} border rounded-lg p-3`}>
              <p className={`text-sm mb-2 ${isScheduledOrder ? 'text-cyan-800' : 'text-orange-800'}`}>
                {isScheduledOrder ? (
                  <>📅 <strong>Agendar Pedido:</strong> Marca como concluído e agenda o pedido no faturamento (etapa "Agendado").</>
                ) : (
                  <>✅ <strong>Finalizar Venda:</strong> Marca como concluído e envia para faturamento no Omie.</>
                )}
              </p>
              <Button
                onClick={handleSendToFaturamento}
                disabled={isSubmitting || products.length === 0 || (isScheduledOrder && !scheduledOrderDate)}
                className={`w-full ${isScheduledOrder ? 'bg-cyan-600 hover:bg-cyan-700' : 'bg-orange-500 hover:bg-orange-600'}`}
                data-testid="button-finalize-billing"
              >
                {isSubmitting ? (
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                ) : isScheduledOrder ? (
                  <Calendar className="h-4 w-4 mr-2" />
                ) : (
                  <DollarSign className="h-4 w-4 mr-2" />
                )}
                {isScheduledOrder ? 'Agendar Pedido' : 'Finalizar e Enviar p/ Faturamento'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
