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
import { Plus, Minus, ShoppingCart, Receipt, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { SalesCard, Product } from "@shared/schema";

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

  // Mutation para finalizar venda
  const finalizeSaleMutation = useMutation({
    mutationFn: async (saleData: any) => {
      return await apiRequest(`/api/sales-cards/${salesCard?.id}/finalize-sale`, {
        method: 'POST',
        body: JSON.stringify(saleData),
      });
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
    setShowConfirmation(true);
  };

  // Confirmar e enviar para Omie
  const confirmSale = () => {
    const saleData = {
      products: saleItems,
      totalValue: totalSale,
      orderNumber: `HS-${Date.now()}`, // Número do pedido único
    };

    finalizeSaleMutation.mutate(saleData);
  };

  // Reset ao fechar
  useEffect(() => {
    if (!isOpen) {
      setSaleItems([]);
      setShowConfirmation(false);
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
            {/* Lista de produtos */}
            <div className="lg:col-span-2">
              <div className="mb-4">
                <h3 className="text-lg font-semibold mb-2">Produtos Disponíveis</h3>
              </div>
              
              <ScrollArea className="h-[500px]">
                {productsLoading ? (
                  <div className="text-center py-8">Carregando produtos...</div>
                ) : (
                  <div className="grid gap-3">
                    {products?.map((product: Product) => (
                      <Card key={product.id} className="cursor-pointer hover:shadow-md transition-shadow">
                        <CardContent className="p-4">
                          <div className="flex justify-between items-center">
                            <div className="flex-1">
                              <h4 className="font-medium">{product.name}</h4>
                              {product.description && (
                                <p className="text-sm text-gray-600">{product.description}</p>
                              )}
                              <div className="flex items-center gap-2 mt-2">
                                <Badge variant="secondary">
                                  R$ {parseFloat(product.price).toFixed(2)}
                                </Badge>
                                <Badge variant={product.stock > 0 ? "default" : "destructive"}>
                                  Estoque: {product.stock}
                                </Badge>
                              </div>
                            </div>
                            <Button 
                              onClick={() => addProduct(product)}
                              disabled={!product.isActive || product.stock <= 0}
                              size="sm"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Carrinho */}
            <div className="border-l pl-6">
              <div className="mb-4">
                <h3 className="text-lg font-semibold">Carrinho</h3>
                <Badge variant="secondary">{saleItems.length} itens</Badge>
              </div>

              <ScrollArea className="h-[400px] mb-4">
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
                                onClick={() => updateQuantity(item.id, item.quantity - 1)}
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                              <span className="w-8 text-center">{item.quantity}</span>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => updateQuantity(item.id, item.quantity + 1)}
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
                              />
                            </div>

                            <div className="flex justify-between items-center pt-2 border-t">
                              <span className="text-sm font-medium">Total:</span>
                              <span className="font-bold">R$ {item.totalPrice.toFixed(2)}</span>
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
                
                <div className="flex flex-col gap-2">
                  <Button 
                    onClick={handleFinalizeSale}
                    disabled={saleItems.length === 0}
                    className="w-full"
                  >
                    Finalizar Venda
                  </Button>
                  <Button variant="outline" onClick={onClose} className="w-full">
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