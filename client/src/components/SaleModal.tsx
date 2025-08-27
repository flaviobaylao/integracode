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
import { Plus, Minus, ShoppingCart, Receipt, Check, CreditCard, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
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
      
      // Carregar localização
      if (card.customerLatitude && card.customerLongitude) {
        setCustomerLocation({
          latitude: card.customerLatitude.toString(),
          longitude: card.customerLongitude.toString()
        });
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
      shouldBlock: shouldBlockOrder
    };

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
          // Tela de Confirmação
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
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-4">
              <Button variant="outline" onClick={() => setShowConfirmation(false)}>
                Voltar
              </Button>
              <Button 
                onClick={confirmSale}
                disabled={finalizeSaleMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
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
            <div className="space-y-4 order-1 lg:order-2 h-auto lg:h-[600px] overflow-y-auto">
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}