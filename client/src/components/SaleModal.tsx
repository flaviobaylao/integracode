import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Minus, ShoppingCart, Receipt, Check, CreditCard, MapPin, FileText, MessageCircle, Truck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import honestLogo from '@/assets/honest-logo.png';
import { apiRequest } from "@/lib/queryClient";
import type { SalesCard, Product, PaymentMethod, OperationType } from "@shared/schema";
import { PAYMENT_METHOD_LABELS, OPERATION_TYPE_LABELS } from "@shared/schema";

interface SaleItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

interface SaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  salesCard: SalesCard | null;
}

export default function SaleModal({ isOpen, onClose, salesCard }: SaleModalProps) {
  
  // Estados principais
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<{[key: string]: number}>({});
  
  // Estados dos campos de pagamento
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('a_vista');
  const [operationType, setOperationType] = useState<OperationType>('venda');
  const [boletoDays, setBoletoDays] = useState<number>(7);
  
  // Estados dos horários de entrega
  const [enableSaturdayDelivery, setEnableSaturdayDelivery] = useState(false);
  const [selectedSaturdaySlots, setSelectedSaturdaySlots] = useState<string[]>([]);
  const [selectedWeekdaySlots, setSelectedWeekdaySlots] = useState<string[]>([]);
  
  // Estados da localização
  const [customerLocation, setCustomerLocation] = useState({ latitude: '', longitude: '' });
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  
  // Estados do veículo exclusivo
  const [exclusiveVehicle, setExclusiveVehicle] = useState(false);
  const [vehicleTypes, setVehicleTypes] = useState<string[]>([]);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Carregar produtos
  const { data: products, isLoading: productsLoading } = useQuery({
    queryKey: ['/api/products'],
    retry: false,
  });

  // Configurações do sistema
  const { data: systemSettings } = useQuery({
    queryKey: ['/api/system-settings'],
    retry: false,
  });

  // Buscar usuário atual para verificar permissões
  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  // Verificar se o usuário é administrativo
  const isAdministrative = ['admin', 'coordinator', 'administrative'].includes((currentUser as any)?.role);

  // Valor mínimo de pedido
  const minimumOrderValue = useMemo(() => {
    if (!systemSettings || !Array.isArray(systemSettings)) return 0;
    const setting = systemSettings.find((s: any) => s.key === 'minimum_order_value');
    return setting ? parseFloat(setting.value) : 0;
  }, [systemSettings]);

  // Calcular total da venda
  const totalSale = useMemo(() => {
    return saleItems.reduce((sum, item) => sum + item.totalPrice, 0);
  }, [saleItems]);

  // Agrupar produtos por tamanho (apenas produtos ativos)
  const groupedProducts = useMemo(() => {
    if (!products || !Array.isArray(products)) return { '350ml': [], '900ml': [], outros: [] };
    
    // Filtrar apenas produtos ativos
    const activeProducts = products.filter((product: Product) => product.isActive);
    
    const groups = activeProducts.reduce((acc: any, product: Product) => {
      const name = product.name.toLowerCase();
      if (name.includes('350ml')) {
        acc['350ml'].push(product);
      } else if (name.includes('900ml') || name.includes('500ml')) {
        acc['900ml'].push(product);
      } else {
        acc.outros.push(product);
      }
      return acc;
    }, { '350ml': [], '900ml': [], outros: [] });

    // Ordenar alfabeticamente
    Object.keys(groups).forEach(key => {
      groups[key].sort((a: Product, b: Product) => a.name.localeCompare(b.name));
    });

    return groups;
  }, [products]);

  // Verificar se pedido deve ser bloqueado
  const shouldBlockOrder = useMemo(() => {
    return paymentMethod === 'boleto' && boletoDays !== 7;
  }, [paymentMethod, boletoDays]);

  // Função para gerar PDF do orçamento
  const generateQuotePDF = () => {
    const pdf = new jsPDF();
    
    // Adicionar logomarca no canto superior direito
    try {
      pdf.addImage(honestLogo, 'PNG', 150, 10, 40, 40);
    } catch (error) {
      console.log('Erro ao carregar logomarca:', error);
    }
    
    // Configurações da página
    pdf.setFontSize(20);
    pdf.text('ORÇAMENTO DE VENDA', 20, 30);
    
    // Informações da empresa
    pdf.setFontSize(12);
    pdf.text('Honest Sucos', 20, 50);
    pdf.text('Sucos Naturais e Saudáveis', 20, 60);
    
    // Informações do cliente
    const customer = (salesCard as any)?.customer;
    if (customer) {
      pdf.text(`Cliente: ${customer.fantasyName || customer.name}`, 20, 80);
      if (customer.cnpj) pdf.text(`CNPJ: ${customer.cnpj}`, 20, 90);
      if (customer.cpf) pdf.text(`CPF: ${customer.cpf}`, 20, 90);
      if (customer.phone) pdf.text(`Telefone: ${customer.phone}`, 20, 100);
    }
    
    // Informações do vendedor
    const seller = (salesCard as any)?.seller;
    if (seller) {
      pdf.text(`Vendedor: ${seller.firstName} ${seller.lastName}`, 20, 110);
    }
    
    // Informações do pedido
    pdf.text(`Número do Orçamento: HS-${Date.now()}`, 20, 130);
    pdf.text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, 20, 140);
    pdf.text(`Forma de Pagamento: ${PAYMENT_METHOD_LABELS[paymentMethod]}`, 20, 150);
    if (paymentMethod === 'boleto') {
      pdf.text(`Prazo do Boleto: ${boletoDays} dias`, 20, 160);
    }
    pdf.text(`Tipo de Operação: ${OPERATION_TYPE_LABELS[operationType]}`, 20, 170);
    
    // Tabela de produtos
    const tableColumn = ['Produto', 'Qtd', 'Preço Unit.', 'Total'];
    const tableRows = saleItems.map(item => [
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
    pdf.text(`TOTAL GERAL: R$ ${totalSale.toFixed(2)}`, 20, finalY + 20);
    
    // Observações
    pdf.setFontSize(10);
    pdf.text('Observações:', 20, finalY + 40);
    pdf.text('- Este orçamento tem validade de 15 dias.', 20, finalY + 50);
    pdf.text('- Preços sujeitos a alteração sem aviso prévio.', 20, finalY + 60);
    pdf.text('- Produtos naturais, sem conservantes.', 20, finalY + 70);
    
    if (shouldBlockOrder) {
      pdf.text('- Este pedido requer aprovação manual.', 20, finalY + 80);
    }
    
    // Salvar o PDF
    const fileName = `orcamento-${customer?.name || 'cliente'}-${Date.now()}.pdf`;
    pdf.save(fileName);
    
    toast({
      title: "PDF Gerado",
      description: "O orçamento foi gerado e baixado com sucesso!",
    });
  };

  // Função para enviar PDF por WhatsApp
  const sendPDFToWhatsApp = () => {
    const customer = (salesCard as any)?.customer;
    if (!customer?.phone) {
      toast({
        title: "Erro",
        description: "Cliente não possui número de WhatsApp cadastrado.",
        variant: "destructive"
      });
      return;
    }

    // Gerar o PDF primeiro
    const pdf = new jsPDF();
    
    // Adicionar logomarca no canto superior direito
    try {
      pdf.addImage(honestLogo, 'PNG', 150, 10, 40, 40);
    } catch (error) {
      console.log('Erro ao carregar logomarca:', error);
    }
    
    // Configurações da página
    pdf.setFontSize(20);
    pdf.text('ORÇAMENTO DE VENDA', 20, 30);
    
    // Informações da empresa
    pdf.setFontSize(12);
    pdf.text('Honest Sucos', 20, 50);
    pdf.text('Sucos Naturais e Saudáveis', 20, 60);
    
    // Informações do cliente
    if (customer) {
      pdf.text(`Cliente: ${customer.fantasyName || customer.name}`, 20, 80);
      if (customer.cnpj) pdf.text(`CNPJ: ${customer.cnpj}`, 20, 90);
      if (customer.cpf) pdf.text(`CPF: ${customer.cpf}`, 20, 90);
      if (customer.phone) pdf.text(`Telefone: ${customer.phone}`, 20, 100);
    }
    
    // Informações do vendedor
    const seller = (salesCard as any)?.seller;
    if (seller) {
      pdf.text(`Vendedor: ${seller.firstName} ${seller.lastName}`, 20, 110);
    }
    
    // Informações do pedido
    pdf.text(`Número do Orçamento: HS-${Date.now()}`, 20, 130);
    pdf.text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, 20, 140);
    pdf.text(`Forma de Pagamento: ${PAYMENT_METHOD_LABELS[paymentMethod]}`, 20, 150);
    if (paymentMethod === 'boleto') {
      pdf.text(`Prazo do Boleto: ${boletoDays} dias`, 20, 160);
    }
    pdf.text(`Tipo de Operação: ${OPERATION_TYPE_LABELS[operationType]}`, 20, 170);
    
    // Tabela de produtos
    const tableColumn = ['Produto', 'Qtd', 'Preço Unit.', 'Total'];
    const tableRows = saleItems.map(item => [
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
    pdf.text(`TOTAL GERAL: R$ ${totalSale.toFixed(2)}`, 20, finalY + 20);
    
    // Observações
    pdf.setFontSize(10);
    pdf.text('Observações:', 20, finalY + 40);
    pdf.text('- Este orçamento tem validade de 15 dias.', 20, finalY + 50);
    pdf.text('- Preços sujeitos a alteração sem aviso prévio.', 20, finalY + 60);
    pdf.text('- Produtos naturais, sem conservantes.', 20, finalY + 70);
    
    if (shouldBlockOrder) {
      pdf.text('- Este pedido requer aprovação manual.', 20, finalY + 80);
    }

    // Converter PDF para blob e enviar por WhatsApp
    const pdfBlob = pdf.output('blob');
    const pdfDataUrl = pdf.output('datauristring');
    
    // Limpar número de telefone (remover caracteres especiais)
    const cleanPhone = customer.phone.replace(/\D/g, '');
    
    // Mensagem personalizada
    const message = `Olá ${customer.fantasyName || customer.name}! 📄

Segue o orçamento da Honest Sucos:
• Total: R$ ${totalSale.toFixed(2)}
• Produtos: ${saleItems.length} itens
• Pagamento: ${PAYMENT_METHOD_LABELS[paymentMethod]}
${paymentMethod === 'boleto' ? `• Prazo: ${boletoDays} dias` : ''}

🌿 Sucos naturais e saudáveis!

Qualquer dúvida, estou à disposição.`;

    // Criar link do WhatsApp com mensagem
    const whatsappUrl = `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(message)}`;
    
    // Abrir WhatsApp em nova aba
    window.open(whatsappUrl, '_blank');
    
    toast({
      title: "WhatsApp Aberto",
      description: `Mensagem preparada para ${customer.fantasyName || customer.name}. Você pode anexar o PDF manualmente.`,
    });
  };

  // Carregar preferências do card
  useEffect(() => {
    if (salesCard && isOpen) {
      const card = salesCard as any;
      
      // Carregar preferências salvas
      setPaymentMethod(card.paymentMethod || 'a_vista');
      setOperationType(card.operationType || 'venda');
      setBoletoDays(card.boletoDays || 7);
      setSelectedWeekdaySlots(card.deliveryTimeSlots || []);
      setSelectedSaturdaySlots(card.deliverySaturdayTimeSlots || []);
      setEnableSaturdayDelivery((card.deliverySaturdayTimeSlots || []).length > 0);
      
      // Carregar configuração de veículo exclusivo
      setExclusiveVehicle(card.exclusiveVehicle || false);
      setVehicleTypes(card.vehicleTypes || []);
      
      // Carregar localização
      if (card.customerLatitude && card.customerLongitude) {
        setCustomerLocation({
          latitude: card.customerLatitude.toString(),
          longitude: card.customerLongitude.toString()
        });
      }

      // Carregar produtos salvos do pedido anterior
      if (card.products && Array.isArray(card.products) && card.products.length > 0) {
        const savedProducts: {[key: string]: number} = {};
        card.products.forEach((item: any) => {
          if (item.id && item.quantity > 0) {
            savedProducts[item.id] = item.quantity;
          }
        });
        setSelectedProducts(savedProducts);
      }
    }
  }, [salesCard, isOpen]);

  // Controlar seleção de produtos
  const handleProductSelect = (productId: string, isSelected: boolean) => {
    if (isSelected) {
      setSelectedProducts(prev => ({ ...prev, [productId]: 1 }));
    } else {
      setSelectedProducts(prev => {
        const newSelected = { ...prev };
        delete newSelected[productId];
        return newSelected;
      });
    }
  };

  // Alterar quantidade do produto
  const handleQuantityChange = (productId: string, quantity: number) => {
    if (quantity > 0) {
      setSelectedProducts(prev => ({ ...prev, [productId]: quantity }));
    } else {
      setSelectedProducts(prev => {
        const newSelected = { ...prev };
        delete newSelected[productId];
        return newSelected;
      });
    }
  };

  // Sincronizar produtos selecionados com itens da venda
  useEffect(() => {
    const newItems: SaleItem[] = [];
    Object.entries(selectedProducts).forEach(([productId, quantity]) => {
      const product = Array.isArray(products) ? products.find((p: Product) => p.id === productId) : null;
      if (product && quantity > 0) {
        newItems.push({
          id: product.id,
          name: product.name,
          quantity,
          unitPrice: parseFloat(product.price),
          totalPrice: parseFloat(product.price) * quantity
        });
      }
    });
    setSaleItems(newItems);
  }, [selectedProducts, products]);

  // Capturar localização GPS
  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Geolocalização não suportada pelo navegador",
        variant: "destructive"
      });
      return;
    }

    setIsCapturingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCustomerLocation({
          latitude: position.coords.latitude.toString(),
          longitude: position.coords.longitude.toString()
        });
        setIsCapturingLocation(false);
        toast({
          title: "Sucesso",
          description: "Localização capturada com sucesso!"
        });
      },
      (error) => {
        setIsCapturingLocation(false);
        toast({
          title: "Erro",
          description: "Erro ao capturar localização: " + error.message,
          variant: "destructive"
        });
      }
    );
  };

  // Salvar preferências no card
  const saveCardPreferences = async () => {
    if (!salesCard) return;
    
    const updateData = {
      paymentMethod,
      operationType,
      boletoDays,
      deliveryTimeSlots: selectedWeekdaySlots,
      deliverySaturdayTimeSlots: selectedSaturdaySlots,
      customerLatitude: customerLocation.latitude ? parseFloat(customerLocation.latitude) : null,
      customerLongitude: customerLocation.longitude ? parseFloat(customerLocation.longitude) : null,
      // Salvar produtos selecionados para reutilização
      products: saleItems.map(item => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice
      }))
    };
    
    try {
      await fetch(`/api/sales-cards/${salesCard.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updateData),
      });
    } catch (error) {
      console.warn('Erro ao salvar preferências:', error);
    }
  };

  // Finalizar venda
  const handleFinalizeSale = () => {
    if (saleItems.length === 0) {
      toast({
        title: "Atenção",
        description: "Selecione pelo menos um produto para finalizar a venda",
        variant: "destructive"
      });
      return;
    }

    if (operationType === 'venda' && minimumOrderValue > 0 && totalSale < minimumOrderValue) {
      toast({
        title: "Valor Mínimo",
        description: `Valor mínimo do pedido: R$ ${minimumOrderValue.toFixed(2)}. Atual: R$ ${totalSale.toFixed(2)}`,
        variant: "destructive"
      });
      return;
    }

    // Validação de veículo exclusivo
    if (exclusiveVehicle && vehicleTypes.length > 2) {
      toast({
        title: "Erro de Validação",
        description: "Selecione no máximo 2 tipos de veículos",
        variant: "destructive"
      });
      return;
    }

    saveCardPreferences();
    setShowConfirmation(true);
  };

  // Mutation para finalizar venda
  const finalizeSaleMutation = useMutation({
    mutationFn: async (saleData: any) => {
      const response = await fetch(`/api/sales-cards/${salesCard?.id}/finalize-sale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(saleData),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status}: ${errorText}`);
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso!",
        description: shouldBlockOrder 
          ? "Pedido enviado para aprovação devido ao prazo do boleto"
          : "Venda finalizada e enviada para Omie com sucesso!"
      });
      onClose();
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Erro ao Finalizar Venda",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // Mutation para salvar como rascunho
  const saveDraftMutation = useMutation({
    mutationFn: async (saleData: any) => {
      const response = await fetch(`/api/sales-cards/${salesCard?.id}/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(saleData),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status}: ${errorText}`);
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Rascunho Salvo!",
        description: "O pedido foi salvo como rascunho com sucesso!"
      });
      onClose();
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Erro ao Salvar Rascunho",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  // Confirmar venda
  const confirmSale = () => {
    const saleData = {
      items: saleItems,
      paymentMethod,
      operationType,
      boletoDays,
      deliveryTimeSlots: selectedWeekdaySlots,
      deliverySaturdayTimeSlots: selectedSaturdaySlots,
      customerLatitude: customerLocation.latitude ? parseFloat(customerLocation.latitude) : null,
      customerLongitude: customerLocation.longitude ? parseFloat(customerLocation.longitude) : null,
      totalValue: totalSale,
      shouldBlock: shouldBlockOrder,
      exclusiveVehicle,
      vehicleTypes,
      // Salvar configurações para reutilização
      saveForReuse: true
    };

    finalizeSaleMutation.mutate(saleData);
  };

  // Salvar como rascunho
  const saveDraft = () => {
    const saleData = {
      items: saleItems,
      paymentMethod,
      operationType,
      boletoDays,
      deliveryTimeSlots: selectedWeekdaySlots,
      deliverySaturdayTimeSlots: selectedSaturdaySlots,
      customerLatitude: customerLocation.latitude ? parseFloat(customerLocation.latitude) : null,
      customerLongitude: customerLocation.longitude ? parseFloat(customerLocation.longitude) : null,
      totalValue: totalSale,
      shouldBlock: shouldBlockOrder,
      exclusiveVehicle,
      vehicleTypes,
      status: 'rascunho'
    };

    saveDraftMutation.mutate(saleData);
  };

  // Fazer checkout
  const handleCheckout = () => {
    const saleData = {
      items: saleItems,
      paymentMethod,
      operationType,
      boletoDays,
      deliveryTimeSlots: selectedWeekdaySlots,
      deliverySaturdayTimeSlots: selectedSaturdaySlots,
      customerLatitude: customerLocation.latitude ? parseFloat(customerLocation.latitude) : null,
      customerLongitude: customerLocation.longitude ? parseFloat(customerLocation.longitude) : null,
      totalValue: totalSale,
      shouldBlock: shouldBlockOrder,
      exclusiveVehicle,
      vehicleTypes,
      saveForReuse: true
    };

    // Por enquanto, checkout simplesmente finaliza a venda
    finalizeSaleMutation.mutate(saleData);
  };

  // Reset form
  const resetForm = () => {
    setSaleItems([]);
    setSelectedProducts({});
    setShowConfirmation(false);
    setPaymentMethod('a_vista');
    setOperationType('venda');
    setBoletoDays(7);
    setEnableSaturdayDelivery(false);
    setSelectedSaturdaySlots([]);
    setSelectedWeekdaySlots([]);
    setCustomerLocation({ latitude: '', longitude: '' });
  };

  if (!salesCard) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-[95vw] lg:max-w-6xl h-[95vh] lg:max-h-[90vh] overflow-hidden p-3 lg:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base lg:text-lg">
            <ShoppingCart className="h-4 w-4 lg:h-5 lg:w-5" />
            <span className="truncate">
              Finalizar Venda - {(salesCard as any).customer?.fantasyName || (salesCard as any).customer?.name}
            </span>
          </DialogTitle>
        </DialogHeader>

        {showConfirmation ? (
          // Tela de Confirmação com ScrollArea
          <div className="flex flex-col h-full">
            <ScrollArea className="flex-1 pr-4 max-h-[calc(95vh-200px)]">
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Receipt className="h-5 w-5" />
                      Resumo do Pedido
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div><strong>Cliente:</strong> {(salesCard as any).customer?.fantasyName || (salesCard as any).customer?.name}</div>
                      <div><strong>Vendedor:</strong> {(salesCard as any).seller?.firstName} {(salesCard as any).seller?.lastName}</div>
                      <div><strong>Número do Pedido:</strong> HS-{Date.now()}</div>
                      <div><strong>Pagamento:</strong> {PAYMENT_METHOD_LABELS[paymentMethod]}</div>
                      {paymentMethod === 'boleto' && <div><strong>Prazo do Boleto:</strong> {boletoDays} dias</div>}
                      <div><strong>Tipo:</strong> {OPERATION_TYPE_LABELS[operationType]}</div>
                      
                      
                      <Separator />
                      
                      <div className="space-y-2">
                        <strong>Produtos:</strong>
                        {saleItems.map((item) => (
                          <div key={item.id} className="flex justify-between items-center py-2 border-b">
                            <div>
                              <div className="font-medium">{item.name}</div>
                              <div className="text-sm text-gray-500">{item.quantity} x R$ {item.unitPrice.toFixed(2)}</div>
                            </div>
                            <div className="font-medium">R$ {item.totalPrice.toFixed(2)}</div>
                          </div>
                        ))}
                      </div>
                      
                      <Separator />
                      
                      <div className="flex justify-between items-center text-lg font-bold">
                        <span>Total da Venda:</span>
                        <span>R$ {totalSale.toFixed(2)}</span>
                      </div>

                      {shouldBlockOrder && (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                          <Badge variant="outline" className="bg-yellow-100">ATENÇÃO</Badge>
                          <p className="text-sm text-yellow-800 mt-1">
                            Este pedido será enviado para aprovação manual devido ao prazo do boleto ser de {boletoDays} dias (diferente de 7 dias).
                          </p>
                        </div>
                      )}
                      
                      {/* Botões para PDF e WhatsApp */}
                      <div className="pt-4 space-y-2">
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={generateQuotePDF}
                          data-testid="button-generate-pdf"
                        >
                          <FileText className="h-4 w-4 mr-2" />
                          Gerar PDF do Pedido
                        </Button>
                        
                        <Button
                          variant="outline"
                          className="w-full bg-green-50 hover:bg-green-100 border-green-200"
                          onClick={sendPDFToWhatsApp}
                          data-testid="button-send-whatsapp"
                        >
                          <MessageCircle className="h-4 w-4 mr-2" />
                          Enviar PDF para Cliente
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </ScrollArea>

            {/* Botões de Ação */}
            <div className="flex flex-col gap-3 pt-4 border-t bg-white">
              <div className="grid grid-cols-2 gap-3">
                <Button 
                  variant="outline" 
                  onClick={() => setShowConfirmation(false)}
                  data-testid="button-back"
                >
                  Voltar
                </Button>
                
                <Button 
                  variant="outline"
                  onClick={saveDraft}
                  disabled={saveDraftMutation.isPending}
                  className="bg-blue-50 hover:bg-blue-100 border-blue-200"
                  data-testid="button-save-draft"
                >
                  {saveDraftMutation.isPending ? (
                    <>Salvando...</>
                  ) : (
                    <>
                      <FileText className="h-4 w-4 mr-2" />
                      Salvar Pedido
                    </>
                  )}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Button 
                  onClick={handleCheckout}
                  disabled={finalizeSaleMutation.isPending}
                  className="bg-orange-600 hover:bg-orange-700"
                  data-testid="button-checkout"
                >
                  {finalizeSaleMutation.isPending ? (
                    <>Processando...</>
                  ) : (
                    <>
                      <CreditCard className="h-4 w-4 mr-2" />
                      Fazer Checkout
                    </>
                  )}
                </Button>
                
                <Button 
                  onClick={confirmSale}
                  disabled={finalizeSaleMutation.isPending}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-confirm-sale"
                >
                  {finalizeSaleMutation.isPending ? (
                    <>Processando...</>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Confirmar e Finalizar
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          // Tela de Seleção de Produtos
          <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6 h-auto lg:h-[600px]">
            {/* Lista de Produtos */}
            <div className="lg:col-span-2 order-2 lg:order-1">
              <div className="mb-4">
                <h3 className="text-lg font-semibold mb-2">Seleção de Produtos</h3>
              </div>
              
              <ScrollArea className="h-[300px] lg:h-[500px]">
                {productsLoading ? (
                  <div className="text-center py-8">Carregando produtos...</div>
                ) : !products || !Array.isArray(products) ? (
                  <div className="text-center py-8 text-red-500">Erro ao carregar produtos</div>
                ) : products.length === 0 ? (
                  <div className="text-center py-8">Nenhum produto encontrado</div>
                ) : (
                  <div className="space-y-6">
                    {/* Produtos 350ml */}
                    {groupedProducts['350ml']?.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-lg mb-3 text-blue-700">Produtos 350ml</h4>
                        <div className="space-y-3">
                          {groupedProducts['350ml'].map((product: Product) => (
                            <div key={product.id} className="border rounded-lg p-3 bg-blue-50/30">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-3 flex-1">
                                  <Checkbox
                                    id={`product-${product.id}`}
                                    checked={!!selectedProducts[product.id]}
                                    onCheckedChange={(checked) => handleProductSelect(product.id, checked as boolean)}
                                    data-testid={`checkbox-product-${product.id}`}
                                  />
                                  <Label 
                                    htmlFor={`product-${product.id}`}
                                    className="text-sm cursor-pointer flex-1"
                                  >
                                    <div className="font-medium">{product.name}</div>
                                    <div className="text-gray-600">R$ {parseFloat(product.price).toFixed(2)}</div>
                                    <div className="text-xs text-gray-500">Estoque: {product.stock}</div>
                                  </Label>
                                </div>
                                
                                {selectedProducts[product.id] && (
                                  <div className="flex items-center space-x-2 ml-4">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium">
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                    >
                                      <Plus className="h-3 w-3" />
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Produtos 900ml */}
                    {groupedProducts['900ml']?.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-lg mb-3 text-green-700">Produtos 900ml</h4>
                        <div className="space-y-3">
                          {groupedProducts['900ml'].map((product: Product) => (
                            <div key={product.id} className="border rounded-lg p-3 bg-green-50/30">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-3 flex-1">
                                  <Checkbox
                                    id={`product-${product.id}`}
                                    checked={!!selectedProducts[product.id]}
                                    onCheckedChange={(checked) => handleProductSelect(product.id, checked as boolean)}
                                    data-testid={`checkbox-product-${product.id}`}
                                  />
                                  <Label 
                                    htmlFor={`product-${product.id}`}
                                    className="text-sm cursor-pointer flex-1"
                                  >
                                    <div className="font-medium">{product.name}</div>
                                    <div className="text-gray-600">R$ {parseFloat(product.price).toFixed(2)}</div>
                                    <div className="text-xs text-gray-500">Estoque: {product.stock}</div>
                                  </Label>
                                </div>
                                
                                {selectedProducts[product.id] && (
                                  <div className="flex items-center space-x-2 ml-4">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium">
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                    >
                                      <Plus className="h-3 w-3" />
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Outros Produtos */}
                    {groupedProducts.outros?.length > 0 && (
                      <div>
                        <h4 className="font-semibold text-lg mb-3 text-gray-700">Outros Produtos</h4>
                        <div className="space-y-3">
                          {groupedProducts.outros.map((product: Product) => (
                            <div key={product.id} className="border rounded-lg p-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-3 flex-1">
                                  <Checkbox
                                    id={`product-${product.id}`}
                                    checked={!!selectedProducts[product.id]}
                                    onCheckedChange={(checked) => handleProductSelect(product.id, checked as boolean)}
                                    data-testid={`checkbox-product-${product.id}`}
                                  />
                                  <Label 
                                    htmlFor={`product-${product.id}`}
                                    className="text-sm cursor-pointer flex-1"
                                  >
                                    <div className="font-medium">{product.name}</div>
                                    <div className="text-gray-600">R$ {parseFloat(product.price).toFixed(2)}</div>
                                    <div className="text-xs text-gray-500">Estoque: {product.stock}</div>
                                  </Label>
                                </div>
                                
                                {selectedProducts[product.id] && (
                                  <div className="flex items-center space-x-2 ml-4">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium">
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                    >
                                      <Plus className="h-3 w-3" />
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Painel Lateral - Configurações */}
            <div className="order-1 lg:order-2 h-auto lg:h-[600px]">
              <ScrollArea className="h-full pr-4">
                <div className="space-y-4">
                {/* Resumo da Venda */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Resumo da Venda</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Itens:</span>
                      <span>{saleItems.length}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>Quantidade:</span>
                      <span>{saleItems.reduce((sum, item) => sum + item.quantity, 0)}</span>
                    </div>
                    <Separator />
                    <div className="flex justify-between font-bold">
                      <span>Total:</span>
                      <span>R$ {totalSale.toFixed(2)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Configurações */}
              <div className="space-y-3">
                {/* Modo de Pagamento */}
                <div className="space-y-2">
                  <Label className="text-sm flex items-center gap-2">
                    <CreditCard className="h-4 w-4" />
                    Modo de Pagamento
                  </Label>
                  <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as PaymentMethod)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Prazo do Boleto */}
                {paymentMethod === 'boleto' && (
                  <div className="space-y-2">
                    <Label className="text-sm">Prazo do Boleto</Label>
                    <Select value={boletoDays.toString()} onValueChange={(value) => setBoletoDays(parseInt(value))}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[7, 10, 14, 15, 21, 28, 30, 32].map((days) => (
                          <SelectItem key={days} value={days.toString()}>
                            {days} dias
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Tipo de Operação */}
                <div className="space-y-2">
                  <Label className="text-sm">Tipo de Operação</Label>
                  <Select value={operationType} onValueChange={(value) => setOperationType(value as OperationType)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(OPERATION_TYPE_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Localização do Cliente */}
                <div className="space-y-2">
                  <Label className="text-sm flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Localização do Cliente
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Latitude"
                      value={customerLocation.latitude}
                      onChange={(e) => setCustomerLocation(prev => ({ ...prev, latitude: e.target.value }))}
                    />
                    <Input
                      placeholder="Longitude"
                      value={customerLocation.longitude}
                      onChange={(e) => setCustomerLocation(prev => ({ ...prev, longitude: e.target.value }))}
                    />
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={captureLocation}
                    disabled={isCapturingLocation}
                    className="w-full"
                  >
                    {isCapturingLocation ? 'Capturando...' : 'Capturar GPS'}
                  </Button>
                </div>

                {/* Veículo Exclusivo - Somente Admin */}
                {isAdministrative && (
                  <div className="space-y-3 border-t border-gray-200 pt-4 bg-orange-50 p-3 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Truck className="h-4 w-4 text-orange-600" />
                      <Label className="text-sm font-medium text-orange-900">Veículo Exclusivo (Admin)</Label>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="exclusive-vehicle-sale"
                        checked={exclusiveVehicle}
                        onCheckedChange={(checked) => {
                          setExclusiveVehicle(checked as boolean);
                          if (!checked) setVehicleTypes([]);
                        }}
                        data-testid="checkbox-exclusive-vehicle-sale"
                      />
                      <Label htmlFor="exclusive-vehicle-sale" className="text-sm cursor-pointer">
                        Entrega em veículo exclusivo?
                      </Label>
                    </div>

                    {exclusiveVehicle && (
                      <div className="ml-6 space-y-2">
                        <Label className="text-sm font-medium">Tipos de Veículos (máximo 2)</Label>
                        <div className="grid grid-cols-3 gap-3">
                          {[
                            { value: 'caminhao', label: 'Caminhão' },
                            { value: 'carro', label: 'Carro' },
                            { value: 'moto', label: 'Moto' }
                          ].map((vehicle) => (
                            <div key={vehicle.value} className="flex items-center space-x-2">
                              <Checkbox
                                id={`vehicle-sale-${vehicle.value}`}
                                checked={vehicleTypes.includes(vehicle.value)}
                                onCheckedChange={(checked) => {
                                  const newVehicleTypes = checked 
                                    ? [...vehicleTypes, vehicle.value]
                                    : vehicleTypes.filter(v => v !== vehicle.value);
                                  
                                  if (newVehicleTypes.length > 2) {
                                    toast({
                                      title: "Limite excedido",
                                      description: "Selecione no máximo 2 tipos de veículos",
                                      variant: "destructive",
                                    });
                                    return;
                                  }
                                  
                                  setVehicleTypes(newVehicleTypes);
                                }}
                                data-testid={`checkbox-vehicle-sale-${vehicle.value}`}
                              />
                              <Label htmlFor={`vehicle-sale-${vehicle.value}`} className="text-sm cursor-pointer">
                                {vehicle.label}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Dias de Entrega */}
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Dias e Horários de Entrega:</Label>
                  
                  {/* Dias de semana (segunda a sexta) */}
                  <div className="space-y-3">
                    <Label className="text-sm text-gray-600">Dias de semana:</Label>
                    {['08:00-10:00', '10:00-12:00', '14:00-16:00', '16:00-18:00'].map((slot) => (
                      <div key={slot} className="flex items-center space-x-2">
                        <Checkbox
                          id={`weekday-${slot}`}
                          checked={selectedWeekdaySlots.includes(slot)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedWeekdaySlots(prev => [...prev, slot]);
                            } else {
                              setSelectedWeekdaySlots(prev => prev.filter(s => s !== slot));
                            }
                          }}
                        />
                        <Label htmlFor={`weekday-${slot}`} className="text-sm">
                          {slot}
                        </Label>
                      </div>
                    ))}
                  </div>

                  <Separator />

                  {/* Entrega aos Sábados */}
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="saturday-delivery"
                        checked={enableSaturdayDelivery}
                        onCheckedChange={(checked) => setEnableSaturdayDelivery(checked === true)}
                      />
                      <Label htmlFor="saturday-delivery" className="text-sm font-medium">
                        Habilitar entrega aos sábados
                      </Label>
                    </div>
                    
                    {enableSaturdayDelivery && (
                      <div className="space-y-2 pl-6">
                        <Label className="text-sm text-gray-600">Horários aos sábados:</Label>
                        {['08:00-10:00', '10:00-12:00', '14:00-16:00', '16:00-18:00'].map((slot) => (
                          <div key={slot} className="flex items-center space-x-2">
                            <Checkbox
                              id={`saturday-${slot}`}
                              checked={selectedSaturdaySlots.includes(`${slot} aos sábados`)}
                              onCheckedChange={(checked) => {
                                const slotWithSuffix = `${slot} aos sábados`;
                                if (checked) {
                                  setSelectedSaturdaySlots(prev => [...prev, slotWithSuffix]);
                                } else {
                                  setSelectedSaturdaySlots(prev => prev.filter(s => s !== slotWithSuffix));
                                }
                              }}
                            />
                            <Label htmlFor={`saturday-${slot}`} className="text-sm">
                              {slot} aos sábados
                            </Label>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Alerta de Bloqueio */}
                {shouldBlockOrder && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <Badge variant="outline" className="bg-yellow-100">ATENÇÃO</Badge>
                    <p className="text-sm text-yellow-800 mt-1">
                      Este pedido será enviado para aprovação manual devido ao prazo do boleto.
                    </p>
                  </div>
                )}
              </div>
              
                {/* Botões de Ação */}
                <div className="flex flex-col gap-2">
                  <Button 
                    onClick={handleFinalizeSale}
                    disabled={saleItems.length === 0}
                    className="w-full"
                  >
                    <Receipt className="h-4 w-4 mr-2" />
                    Finalizar {OPERATION_TYPE_LABELS[operationType]}
                  </Button>
                  <Button variant="outline" onClick={onClose} className="w-full">
                    Cancelar
                  </Button>
                </div>
                </div>
              </ScrollArea>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}