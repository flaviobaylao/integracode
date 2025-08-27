import { useState, useEffect, useMemo } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Minus, ShoppingCart, Receipt, Check, CreditCard } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<{[key: string]: number}>({});
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('a_vista');
  const [operationType, setOperationType] = useState<OperationType>('venda');
  const [boletoDays, setBoletoDays] = useState<number>(7);
  const [enableSaturdayDelivery, setEnableSaturdayDelivery] = useState(false);
  const [selectedSaturdaySlots, setSelectedSaturdaySlots] = useState<string[]>([]);
  const [selectedWeekdaySlots, setSelectedWeekdaySlots] = useState<string[]>([]);
  const [customerLocation, setCustomerLocation] = useState({ latitude: '', longitude: '' });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: products, isLoading: productsLoading } = useQuery({
    queryKey: ['/api/products'],
    retry: false,
  });

  // Calcular total da venda
  const totalSale = useMemo(() => {
    return saleItems.reduce((sum, item) => sum + item.totalPrice, 0);
  }, [saleItems]);

  // Query para buscar configurações do sistema (valor mínimo)
  const { data: systemSettings } = useQuery({
    queryKey: ['/api/system-settings'],
    retry: false,
  });

  // Buscar valor mínimo de pedido
  const minimumOrderValue = useMemo(() => {
    if (!systemSettings || !Array.isArray(systemSettings)) return 0;
    const setting = systemSettings.find((s: any) => s.key === 'minimum_order_value');
    return setting ? parseFloat(setting.value) : 0;
  }, [systemSettings]);

  // Mutation para finalizar venda
  const finalizeSaleMutation = useMutation({
    mutationFn: async (saleData: any) => {
      const response = await fetch(`/api/sales-cards/${salesCard?.id}/finalize-sale`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
        title: "Sucesso",
        description: "Venda finalizada e enviada para o Omie!",
      });
      onClose();
      setShowConfirmation(false);
      setSaleItems([]);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao finalizar venda",
        variant: "destructive",
      });
    },
  });

  // Adicionar produto ao carrinho
  const addProduct = (product: Product) => {
    const existingItem = saleItems.find(item => item.id === product.id);
    
    if (existingItem) {
      updateQuantity(product.id, existingItem.quantity + 1);
    } else {
      const newItem: SaleItem = {
        id: product.id,
        name: product.name,
        quantity: 1,
        unitPrice: parseFloat(product.price),
        totalPrice: parseFloat(product.price),
      };
      setSaleItems(prev => [...prev, newItem]);
    }
  };

  // Atualizar quantidade
  const updateQuantity = (productId: string, newQuantity: number) => {
    if (newQuantity <= 0) {
      removeProduct(productId);
      return;
    }

    setSaleItems(prev => 
      prev.map(item => 
        item.id === productId 
          ? { ...item, quantity: newQuantity, totalPrice: item.unitPrice * newQuantity }
          : item
      )
    );
  };

  // Remover produto
  const removeProduct = (productId: string) => {
    setSaleItems(prev => prev.filter(item => item.id !== productId));
  };

  // Atualizar preço unitário
  const updateUnitPrice = (productId: string, newPrice: number) => {
    setSaleItems(prev => 
      prev.map(item => 
        item.id === productId 
          ? { ...item, unitPrice: newPrice, totalPrice: newPrice * item.quantity }
          : item
      )
    );
  };

  // Controlar seleção/desmarcar produto
  const handleProductSelect = (productId: string, isSelected: boolean) => {
    if (isSelected) {
      setSelectedProducts(prev => ({
        ...prev,
        [productId]: 1
      }));
    } else {
      setSelectedProducts(prev => {
        const newSelected = { ...prev };
        delete newSelected[productId];
        return newSelected;
      });
    }
  };

  // Atualizar quantidade do produto selecionado
  const handleProductQuantityChange = (productId: string, quantity: number) => {
    if (quantity > 0) {
      setSelectedProducts(prev => ({
        ...prev,
        [productId]: quantity
      }));
    } else {
      setSelectedProducts(prev => {
        const newSelected = { ...prev };
        delete newSelected[productId];
        return newSelected;
      });
    }
  };

  // Sincronizar seleções com saleItems
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

  // Salvar preferências no card
  const saveCardPreferences = async () => {
    if (!salesCard) return;
    
    const updateData = {
      deliveryTimeSlots: selectedWeekdaySlots,
      deliverySaturdayTimeSlots: selectedSaturdaySlots,
      boletoDays,
      customerLatitude: customerLocation.latitude ? parseFloat(customerLocation.latitude) : null,
      customerLongitude: customerLocation.longitude ? parseFloat(customerLocation.longitude) : null,
    };
    
    try {
      await fetch(`/api/sales-cards/${salesCard.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(updateData),
      });
    } catch (error) {
      console.warn('Erro ao salvar preferências do card:', error);
    }
  };

  // Agrupar produtos por tamanho/tipo
  const groupedProducts = useMemo(() => {
    if (!products || !Array.isArray(products)) return { '350ml': [], '900ml': [], outros: [] };
    
    return products.reduce((groups: any, product: Product) => {
      if (product.name.toLowerCase().includes('350ml')) {
        groups['350ml'].push(product);
      } else if (product.name.toLowerCase().includes('900ml')) {
        groups['900ml'].push(product);
      } else {
        groups.outros.push(product);
      }
      return groups;
    }, { '350ml': [], '900ml': [], outros: [] });
  }, [products]);

  // Ordenar produtos alfabeticamente em cada grupo
  Object.keys(groupedProducts).forEach(key => {
    groupedProducts[key].sort((a: Product, b: Product) => a.name.localeCompare(b.name));
  });

  // Verificar se o pedido deve ser bloqueado
  const shouldBlockOrder = useMemo(() => {
    // Bloquear se pagamento é boleto e prazo é diferente de 7 dias
    return paymentMethod === 'boleto' && boletoDays !== 7;
  }, [paymentMethod, boletoDays]);

  // Finalizar venda
  const handleFinalizeSale = () => {
    if (saleItems.length === 0) {
      toast({
        title: "Atenção",
        description: "Adicione pelo menos um produto à venda",
        variant: "destructive",
      });
      return;
    }

    // Verificar se pedido deve ser bloqueado
    if (shouldBlockOrder) {
      toast({
        title: "Pedido Bloqueado",
        description: `Este pedido será enviado para aprovação pois o prazo do boleto é de ${salesCard?.boletoDays} dias (diferente de 7 dias)`,
        variant: "destructive",
      });
    }

    setShowConfirmation(true);
  };

  // Capturar coordenadas GPS automaticamente
  const captureGPSAndFinalizeSale = () => {
    // Verificar valor mínimo do pedido (apenas para vendas, não para amostras)
    if (operationType === 'venda' && minimumOrderValue > 0 && totalSale < minimumOrderValue) {
      toast({
        title: "Valor Mínimo não Atingido",
        description: `O valor mínimo do pedido é R$ ${minimumOrderValue.toFixed(2)}. Valor atual: R$ ${totalSale.toFixed(2)}`,
        variant: "destructive",
      });
      return;
    }

    // Tentar capturar localização GPS primeiro
    if (navigator.geolocation) {
      toast({
        title: "Capturando localização...",
        description: "Obtendo coordenadas GPS para registrar no cliente",
      });

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          // Salvar preferências antes de finalizar
          await saveCardPreferences();
          
          const saleData = {
            products: saleItems,
            totalValue: totalSale,
            orderNumber: `HS-${Date.now()}`,
            paymentMethod,
            operationType,
            boletoDays,
            customerLatitude: position.coords.latitude.toString(),
            customerLongitude: position.coords.longitude.toString(),
            shouldBlock: shouldBlockOrder,
          };

          toast({
            title: "Localização capturada!",
            description: "Coordenadas GPS serão salvas no cliente",
          });

          finalizeSaleMutation.mutate(saleData);
        },
        async (error) => {
          console.error('Erro ao capturar GPS:', error);
          
          // Se não conseguir capturar GPS, finalizar venda mesmo assim
          // Salvar preferências antes de finalizar
          await saveCardPreferences();
          
          const saleData = {
            products: saleItems,
            totalValue: totalSale,
            orderNumber: `HS-${Date.now()}`,
            paymentMethod,
            operationType,
            boletoDays,
            shouldBlock: shouldBlockOrder,
            customerLatitude: customerLocation.latitude || undefined,
            customerLongitude: customerLocation.longitude || undefined,
          };

          toast({
            title: "GPS não disponível",
            description: "Venda será finalizada sem coordenadas GPS",
            variant: "destructive",
          });

          finalizeSaleMutation.mutate(saleData);
        },
        {
          enableHighAccuracy: true,
          timeout: 5000, // 5 segundos timeout
          maximumAge: 0,
        }
      );
    } else {
      // Navegador não suporta geolocalização
      const saleData = {
        products: saleItems,
        totalValue: totalSale,
        orderNumber: `HS-${Date.now()}`,
        paymentMethod,
        operationType,
        shouldBlock: shouldBlockOrder,
      };

      toast({
        title: "Geolocalização não suportada",
        description: "Venda será finalizada sem coordenadas GPS",
        variant: "destructive",
      });

      finalizeSaleMutation.mutate(saleData);
    }
  };

  // Manter função de confirmação para compatibilidade
  const confirmSale = captureGPSAndFinalizeSale;

  // Carregar dados existentes do card ao abrir
  useEffect(() => {
    if (isOpen && salesCard) {
      // Carregar horários de sábado se existirem
      if (salesCard.deliverySaturdayTimeSlots) {
        setSelectedSaturdaySlots(salesCard.deliverySaturdayTimeSlots);
        setEnableSaturdayDelivery(salesCard.deliverySaturdayTimeSlots.length > 0);
      }
      
      // Carregar horários de semana se existirem
      if (salesCard.deliveryTimeSlots) {
        setSelectedWeekdaySlots(salesCard.deliveryTimeSlots);
      }
      
      // Carregar localização do cliente se existir no card
      if (salesCard.customerLatitude && salesCard.customerLongitude) {
        setCustomerLocation({
          latitude: salesCard.customerLatitude.toString(),
          longitude: salesCard.customerLongitude.toString()
        });
      }
      
      // Carregar prazo do boleto se existir
      if (salesCard.boletoDays) {
        setBoletoDays(salesCard.boletoDays);
      }
    }
  }, [isOpen, salesCard]);

  // Reset ao fechar
  useEffect(() => {
    if (!isOpen) {
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
    }
  }, [isOpen]);

  if (!salesCard) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            {showConfirmation ? "Confirmar Pedido" : "Registrar Venda"}
          </DialogTitle>
        </DialogHeader>

        {showConfirmation ? (
          // Tela de confirmação
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Receipt className="h-5 w-5" />
                  Resumo do Pedido
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <strong>Cliente:</strong> {(salesCard as any).customer?.fantasyName || (salesCard as any).customer?.name}
                  </div>
                  <div>
                    <strong>Vendedor:</strong> {(salesCard as any).seller?.firstName} {(salesCard as any).seller?.lastName}
                  </div>
                  <div>
                    <strong>Número do Pedido:</strong> HS-{Date.now()}
                  </div>
                  <div>
                    <strong>Modo de Pagamento:</strong> {PAYMENT_METHOD_LABELS[paymentMethod]}
                  </div>
                  <div>
                    <strong>Tipo de Operação:</strong> {OPERATION_TYPE_LABELS[operationType]}
                  </div>
                  
                  <Separator />
                  
                  <div className="space-y-2">
                    <strong>Produtos:</strong>
                    {saleItems.map((item) => (
                      <div key={item.id} className="flex justify-between items-center py-2 border-b">
                        <div>
                          <div className="font-medium">{item.name}</div>
                          <div className="text-sm text-gray-500">
                            {item.quantity} x R$ {item.unitPrice.toFixed(2)}
                          </div>
                        </div>
                        <div className="font-medium">
                          R$ {item.totalPrice.toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  <Separator />
                  
                  <div className="flex justify-between items-center text-lg font-bold">
                    <span>Total da Venda:</span>
                    <span>R$ {totalSale.toFixed(2)}</span>
                  </div>
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
                  <>Enviando para Omie...</>
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    Confirmar e Enviar para Omie
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          // Tela de seleção de produtos
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">
            {/* Lista de produtos com checkboxes agrupados */}
            <div className="lg:col-span-2">
              <div className="mb-4">
                <h3 className="text-lg font-semibold mb-2">Seleção de Produtos</h3>
              </div>
              
              <ScrollArea className="h-[500px]">
                {productsLoading ? (
                  <div className="text-center py-8">Carregando produtos...</div>
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
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                      data-testid={`button-decrease-${product.id}`}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium" data-testid={`quantity-${product.id}`}>
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                      data-testid={`button-increase-${product.id}`}
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
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                      data-testid={`button-decrease-${product.id}`}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium" data-testid={`quantity-${product.id}`}>
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                      data-testid={`button-increase-${product.id}`}
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
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] - 1)}
                                      data-testid={`button-decrease-${product.id}`}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <span className="w-8 text-center font-medium" data-testid={`quantity-${product.id}`}>
                                      {selectedProducts[product.id]}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleProductQuantityChange(product.id, selectedProducts[product.id] + 1)}
                                      data-testid={`button-increase-${product.id}`}
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

            {/* Carrinho e Configurações */}
            <div className="border-l pl-6">
              <div className="mb-4">
                <h3 className="text-lg font-semibold">Carrinho</h3>
                <Badge variant="secondary">{saleItems.length} itens</Badge>
              </div>

              <ScrollArea className="h-[300px] mb-4">
                {saleItems.length === 0 ? (
                  <div className="text-center text-gray-500 py-8">
                    Nenhum produto selecionado
                  </div>
                ) : (
                  <div className="space-y-3">
                    {saleItems.map((item) => (
                      <Card key={item.id}>
                        <CardContent className="p-3">
                          <div className="space-y-2">
                            <div className="font-medium text-sm">{item.name}</div>
                            
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleProductQuantityChange(item.id, item.quantity - 1)}
                                data-testid={`cart-decrease-${item.id}`}
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                              <span className="w-8 text-center" data-testid={`cart-quantity-${item.id}`}>
                                {item.quantity}
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleProductQuantityChange(item.id, item.quantity + 1)}
                                data-testid={`cart-increase-${item.id}`}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>

                            <div>
                              <Label className="text-xs">Preço unitário</Label>
                              <Input
                                type="number"
                                step="0.01"
                                value={item.unitPrice}
                                onChange={(e) => updateUnitPrice(item.id, parseFloat(e.target.value) || 0)}
                                className="h-8"
                                data-testid={`cart-price-${item.id}`}
                              />
                            </div>

                            <div className="flex justify-between items-center pt-2 border-t">
                              <span className="text-sm font-medium">Total:</span>
                              <span className="font-bold" data-testid={`cart-total-${item.id}`}>
                                R$ {item.totalPrice.toFixed(2)}
                              </span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </ScrollArea>

              <div className="space-y-4">
                <Separator />
                <div className="flex justify-between items-center text-lg font-bold">
                  <span>Total da Venda:</span>
                  <span>R$ {totalSale.toFixed(2)}</span>
                </div>
                {minimumOrderValue > 0 && operationType === 'venda' && (
                  <div className="text-sm text-gray-500 text-right">
                    Valor mínimo: R$ {minimumOrderValue.toFixed(2)}
                  </div>
                )}
                
                {/* Campos de Pagamento e Operação */}
                <div className="space-y-3 pt-3 border-t">
                  <div className="space-y-2">
                    <Label className="text-sm flex items-center gap-2">
                      <CreditCard className="h-4 w-4" />
                      Modo de Pagamento
                    </Label>
                    <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as PaymentMethod)}>
                      <SelectTrigger className="w-full" data-testid="select-payment-method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key} data-testid={`payment-method-${key}`}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-2">
                    <Label className="text-sm">Tipo de Operação</Label>
                    <Select value={operationType} onValueChange={(value) => setOperationType(value as OperationType)}>
                      <SelectTrigger className="w-full" data-testid="select-operation-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(OPERATION_TYPE_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key} data-testid={`operation-type-${key}`}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Campo para prazo do boleto */}
                  {paymentMethod === 'boleto' && (
                    <div className="space-y-2">
                      <Label className="text-sm">Prazo do Boleto</Label>
                      <Select value={boletoDays.toString()} onValueChange={(value) => setBoletoDays(parseInt(value))}>
                        <SelectTrigger className="w-full" data-testid="select-boleto-days">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[7, 10, 14, 15, 21, 28, 30, 32].map((days) => (
                            <SelectItem key={days} value={days.toString()} data-testid={`boleto-days-${days}`}>
                              {days} dias
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Campo para localização do cliente */}
                  <div className="space-y-2">
                    <Label className="text-sm">Localização do Cliente (GPS)</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder="Latitude"
                        value={customerLocation.latitude}
                        onChange={(e) => setCustomerLocation(prev => ({ ...prev, latitude: e.target.value }))}
                        data-testid="input-latitude"
                      />
                      <Input
                        placeholder="Longitude"
                        value={customerLocation.longitude}
                        onChange={(e) => setCustomerLocation(prev => ({ ...prev, longitude: e.target.value }))}
                        data-testid="input-longitude"
                      />
                    </div>
                  </div>

                  {/* Checkboxes para horários de sábado */}
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="saturday-delivery"
                        checked={enableSaturdayDelivery}
                        onCheckedChange={(checked) => setEnableSaturdayDelivery(checked === true)}
                        data-testid="checkbox-saturday-delivery"
                      />
                      <Label htmlFor="saturday-delivery" className="text-sm">
                        Habilitar entrega aos sábados
                      </Label>
                    </div>
                    
                    {enableSaturdayDelivery && (
                      <div className="space-y-2 pl-6">
                        <Label className="text-sm font-medium">Horários aos sábados:</Label>
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
                              data-testid={`checkbox-saturday-${slot}`}
                            />
                            <Label htmlFor={`saturday-${slot}`} className="text-sm">
                              {slot} aos sábados
                            </Label>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {shouldBlockOrder && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="bg-yellow-100">ATENÇÃO</Badge>
                      </div>
                      <p className="text-sm text-yellow-800 mt-1">
                        Este pedido será enviado para aprovação manual devido às condições selecionadas.
                      </p>
                    </div>
                  )}
                </div>
                
                <div className="flex flex-col gap-2">
                  <Button 
                    onClick={handleFinalizeSale}
                    disabled={saleItems.length === 0}
                    className="w-full"
                    data-testid="button-finalize-sale"
                  >
                    <Receipt className="h-4 w-4 mr-2" />
                    Finalizar {OPERATION_TYPE_LABELS[operationType]}
                  </Button>
                  <Button variant="outline" onClick={onClose} className="w-full" data-testid="button-cancel-sale">
                    Cancelar
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}