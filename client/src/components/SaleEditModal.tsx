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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Package, 
  Plus, 
  Trash2, 
  CreditCard, 
  CheckCircle, 
  XCircle,
  DollarSign,
  ShoppingCart
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
    } else {
      setProducts([]);
      setPaymentMethod('a_vista');
      setOperationType('venda');
      setNotes('');
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
    const selectedProduct = availableProducts?.find((p: any) => p.id === productId);
    if (selectedProduct) {
      updateProduct(index, 'id', selectedProduct.id);
      updateProduct(index, 'name', selectedProduct.name);
      updateProduct(index, 'unitPrice', parseFloat(selectedProduct.price || '0'));
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
                        {availableProducts?.map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
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