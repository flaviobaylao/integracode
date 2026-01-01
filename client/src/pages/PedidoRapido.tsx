import { useState, useEffect } from 'react';
import { ShoppingCart, Store, MapPin, Minus, Plus, Trash2, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

type CustomerCategory = 'consumer' | 'reseller';
type ConsumerTier = 'retail' | 'wholesale';
type ResellerLocation = 'goiania' | 'interior' | 'brasilia';
type PriceTable = 'retail_price' | 'wholesale_price' | 'resale_goiania_price' | 'resale_interior_price' | 'resale_brasilia_price';
type Step = 'customer-type' | 'products' | 'checkout' | 'success';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  retailPrice: number | null;
  wholesalePrice: number | null;
  resaleGoianiaPrice: number | null;
  resaleInteriorPrice: number | null;
  resaleBrasiliaPrice: number | null;
  imageUrl: string | null;
  stock: number;
}

interface CartItem extends Product {
  quantity: number;
  selectedPrice: number;
}

interface CustomerData {
  name: string;
  phone: string;
  cpfCnpj: string;
  address: string;
  paymentMethod: 'pix' | 'boleto' | 'card';
}

function getProductPrice(product: Product, priceTable: PriceTable | null): number {
  if (!priceTable) return product.price;
  
  const priceMap: Record<PriceTable, keyof Product> = {
    retail_price: 'retailPrice',
    wholesale_price: 'wholesalePrice',
    resale_goiania_price: 'resaleGoianiaPrice',
    resale_interior_price: 'resaleInteriorPrice',
    resale_brasilia_price: 'resaleBrasiliaPrice',
  };
  
  const priceField = priceMap[priceTable];
  const selectedPrice = product[priceField];
  return (selectedPrice as number | null) ?? product.price;
}

function getPriceTable(category: CustomerCategory | null, consumerTier: ConsumerTier | null, resellerLocation: ResellerLocation | null): PriceTable | null {
  if (category === 'consumer' && consumerTier) {
    return consumerTier === 'retail' ? 'retail_price' : 'wholesale_price';
  }
  if (category === 'reseller' && resellerLocation) {
    switch (resellerLocation) {
      case 'goiania': return 'resale_goiania_price';
      case 'interior': return 'resale_interior_price';
      case 'brasilia': return 'resale_brasilia_price';
    }
  }
  return null;
}

function getMinimumOrder(category: CustomerCategory | null, consumerTier: ConsumerTier | null, resellerLocation: ResellerLocation | null): number {
  if (category === 'consumer') {
    return consumerTier === 'wholesale' ? 200 : 70;
  }
  if (category === 'reseller') {
    if (resellerLocation === 'interior') return 350;
    return 150;
  }
  return 70;
}

export default function PedidoRapido() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('customer-type');
  const [category, setCategory] = useState<CustomerCategory | null>(null);
  const [consumerTier, setConsumerTier] = useState<ConsumerTier | null>(null);
  const [resellerLocation, setResellerLocation] = useState<ResellerLocation | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [customerData, setCustomerData] = useState<CustomerData>({
    name: '',
    phone: '',
    cpfCnpj: '',
    address: '',
    paymentMethod: 'pix',
  });

  const urlParams = new URLSearchParams(window.location.search);
  const phoneFromUrl = urlParams.get('telefone') || urlParams.get('phone') || '';

  useEffect(() => {
    if (phoneFromUrl) {
      setCustomerData(prev => ({ ...prev, phone: phoneFromUrl }));
    }
  }, [phoneFromUrl]);

  const priceTable = getPriceTable(category, consumerTier, resellerLocation);
  const minimumOrder = getMinimumOrder(category, consumerTier, resellerLocation);
  const cartTotal = cart.reduce((sum, item) => sum + item.selectedPrice * item.quantity, 0);
  const meetsMinimum = cartTotal >= minimumOrder;

  const loadProducts = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/public/products');
      if (!response.ok) throw new Error('Erro ao carregar produtos');
      const data = await response.json();
      setProducts(data);
    } catch (error) {
      toast({ title: 'Erro', description: 'Não foi possível carregar os produtos', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCategorySelect = (cat: CustomerCategory) => {
    setCategory(cat);
    setConsumerTier(null);
    setResellerLocation(null);
  };

  const handleConsumerTierSelect = (tier: ConsumerTier) => {
    setConsumerTier(tier);
    loadProducts();
    setStep('products');
  };

  const handleResellerLocationSelect = (location: ResellerLocation) => {
    setResellerLocation(location);
    loadProducts();
    setStep('products');
  };

  const addToCart = (product: Product) => {
    const price = getProductPrice(product, priceTable);
    const existing = cart.find(item => item.id === product.id);
    
    if (existing) {
      setCart(cart.map(item => 
        item.id === product.id 
          ? { ...item, quantity: item.quantity + 1 }
          : item
      ));
    } else {
      setCart([...cart, { ...product, quantity: 1, selectedPrice: price }]);
    }
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCart(cart.map(item => {
      if (item.id === productId) {
        const newQuantity = item.quantity + delta;
        return newQuantity > 0 ? { ...item, quantity: newQuantity } : item;
      }
      return item;
    }).filter(item => item.quantity > 0));
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter(item => item.id !== productId));
  };

  const handleSubmitOrder = async () => {
    if (!customerData.name || !customerData.phone || !customerData.address) {
      toast({ title: 'Dados incompletos', description: 'Preencha todos os campos obrigatórios', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const convertPriceTable = (table: PriceTable | null): 'retail' | 'wholesale' | 'goiania' | 'interior' | 'brasilia' | undefined => {
        if (!table) return undefined;
        const tableMap: Record<string, 'retail' | 'wholesale' | 'goiania' | 'interior' | 'brasilia'> = {
          'retail_price': 'retail',
          'wholesale_price': 'wholesale',
          'resale_goiania_price': 'goiania',
          'resale_interior_price': 'interior',
          'resale_brasilia_price': 'brasilia',
        };
        return tableMap[table];
      };

      const cleanCpfCnpj = customerData.cpfCnpj ? customerData.cpfCnpj.replace(/\D/g, '') : '';
      const cleanPhone = customerData.phone.replace(/\D/g, '');
      
      const order = {
        customer: {
          name: customerData.name,
          phone: cleanPhone,
          address: customerData.address,
          cpfCnpj: cleanCpfCnpj || null,
          email: null,
          customerType: cleanCpfCnpj.length > 11 ? 'pessoa_juridica' : 'pessoa_fisica',
        },
        items: cart.map(item => ({
          productId: item.id,
          productName: item.name,
          quantity: item.quantity,
          unitPrice: item.selectedPrice,
        })),
        totalAmount: cartTotal,
        paymentMethod: customerData.paymentMethod,
        source: 'hotsite',
        priceTable: convertPriceTable(priceTable),
      };

      const response = await fetch('/api/public/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Erro ao criar pedido');
      }

      const result = await response.json();
      setOrderNumber(result.orderNumber);
      setCart([]);
      setStep('success');
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message || 'Não foi possível criar o pedido', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const reset = () => {
    setStep('customer-type');
    setCategory(null);
    setConsumerTier(null);
    setResellerLocation(null);
    setCart([]);
    setOrderNumber('');
    setCustomerData({
      name: '',
      phone: phoneFromUrl,
      cpfCnpj: '',
      address: '',
      paymentMethod: 'pix',
    });
  };

  if (step === 'success') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <Check className="w-10 h-10 text-green-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Pedido Confirmado!</h1>
            <p className="text-gray-600 mb-4">Seu pedido foi registrado com sucesso</p>
            <div className="bg-gray-100 rounded-lg p-4 mb-6">
              <p className="text-sm text-gray-600">Número do pedido:</p>
              <p className="text-2xl font-mono font-bold text-green-600" data-testid="order-number-display">{orderNumber}</p>
            </div>
            <p className="text-sm text-gray-600 mb-6">
              Nossa equipe entrará em contato pelo WhatsApp para confirmar a entrega.
            </p>
            <Button onClick={reset} className="w-full bg-green-600 hover:bg-green-700" data-testid="btn-new-order">
              Fazer Novo Pedido
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 'checkout') {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-lg mx-auto">
          <Button variant="ghost" onClick={() => setStep('products')} className="mb-4" data-testid="btn-back-checkout">
            <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
          </Button>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-lg">Resumo do Pedido</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mb-4">
                {cart.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.quantity}x {item.name}</span>
                    <span>R$ {(item.selectedPrice * item.quantity).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t pt-2 flex justify-between font-bold">
                <span>Total:</span>
                <span className="text-green-600">R$ {cartTotal.toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Seus Dados</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="name">Nome Completo *</Label>
                <Input
                  id="name"
                  value={customerData.name}
                  onChange={e => setCustomerData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Seu nome completo"
                  data-testid="input-name"
                />
              </div>
              <div>
                <Label htmlFor="phone">WhatsApp *</Label>
                <Input
                  id="phone"
                  value={customerData.phone}
                  onChange={e => setCustomerData(prev => ({ ...prev, phone: e.target.value }))}
                  placeholder="(00) 00000-0000"
                  data-testid="input-phone"
                />
              </div>
              <div>
                <Label htmlFor="cpfCnpj">CPF ou CNPJ</Label>
                <Input
                  id="cpfCnpj"
                  value={customerData.cpfCnpj}
                  onChange={e => setCustomerData(prev => ({ ...prev, cpfCnpj: e.target.value }))}
                  placeholder="000.000.000-00"
                  data-testid="input-cpf-cnpj"
                />
              </div>
              <div>
                <Label htmlFor="address">Endereço de Entrega *</Label>
                <Input
                  id="address"
                  value={customerData.address}
                  onChange={e => setCustomerData(prev => ({ ...prev, address: e.target.value }))}
                  placeholder="Rua, número, bairro, cidade"
                  data-testid="input-address"
                />
              </div>
              <div>
                <Label>Forma de Pagamento</Label>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {(['pix', 'boleto', 'card'] as const).map(method => (
                    <Button
                      key={method}
                      variant={customerData.paymentMethod === method ? 'default' : 'outline'}
                      onClick={() => setCustomerData(prev => ({ ...prev, paymentMethod: method }))}
                      className="text-sm"
                      data-testid={`btn-payment-${method}`}
                    >
                      {method === 'pix' ? 'PIX' : method === 'boleto' ? 'Boleto' : 'Cartão'}
                    </Button>
                  ))}
                </div>
              </div>
              <Button
                onClick={handleSubmitOrder}
                disabled={isSubmitting || !customerData.name || !customerData.phone || !customerData.address}
                className="w-full bg-green-600 hover:bg-green-700"
                data-testid="btn-submit-order"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processando...
                  </>
                ) : (
                  'Confirmar Pedido'
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (step === 'products') {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white border-b sticky top-0 z-40 shadow-sm">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={reset} data-testid="btn-back-products">
              <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
            </Button>
            <h1 className="font-bold text-green-700">Honest Sucos</h1>
            <Badge variant="secondary" className="text-green-600" data-testid="cart-count-badge">
              <ShoppingCart className="w-4 h-4 mr-1" />
              {cart.reduce((sum, item) => sum + item.quantity, 0)}
            </Badge>
          </div>
        </header>

        <div className="max-w-4xl mx-auto p-4">
          <h2 className="text-xl font-bold mb-4">Escolha seus Produtos</h2>
          
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-green-600" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-24">
              {products.map(product => {
                const price = getProductPrice(product, priceTable);
                const inCart = cart.find(item => item.id === product.id);
                
                return (
                  <Card key={product.id} className="overflow-hidden" data-testid={`product-card-${product.id}`}>
                    <div className="h-32 bg-gradient-to-br from-rose-100 to-pink-100 flex items-center justify-center">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-4xl">🍓</span>
                      )}
                    </div>
                    <CardContent className="p-4">
                      <h3 className="font-semibold text-gray-900">{product.name}</h3>
                      <p className="text-lg font-bold text-green-600">R$ {price.toFixed(2)}</p>
                      
                      {inCart ? (
                        <div className="flex items-center justify-between mt-3">
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => updateQuantity(product.id, -1)}
                              data-testid={`btn-decrease-${product.id}`}
                            >
                              <Minus className="w-4 h-4" />
                            </Button>
                            <span className="w-8 text-center font-semibold" data-testid={`quantity-${product.id}`}>
                              {inCart.quantity}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => updateQuantity(product.id, 1)}
                              data-testid={`btn-increase-${product.id}`}
                            >
                              <Plus className="w-4 h-4" />
                            </Button>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeFromCart(product.id)}
                            className="text-red-500"
                            data-testid={`btn-remove-${product.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          onClick={() => addToCart(product)}
                          className="w-full mt-3 bg-green-600 hover:bg-green-700"
                          data-testid={`btn-add-${product.id}`}
                        >
                          Adicionar
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {cart.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg p-4">
            <div className="max-w-4xl mx-auto">
              {!meetsMinimum && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3 text-sm text-amber-700">
                  Pedido mínimo: R$ {minimumOrder.toFixed(2)} (faltam R$ {(minimumOrder - cartTotal).toFixed(2)})
                </div>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">{cart.reduce((sum, item) => sum + item.quantity, 0)} itens</p>
                  <p className="text-xl font-bold text-green-600" data-testid="cart-total">R$ {cartTotal.toFixed(2)}</p>
                </div>
                <Button
                  onClick={() => setStep('checkout')}
                  disabled={!meetsMinimum}
                  className="bg-green-600 hover:bg-green-700 px-8"
                  data-testid="btn-go-checkout"
                >
                  Continuar
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-600 to-emerald-700 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
            Honest Sucos
          </h1>
          <p className="text-white/90 text-lg">
            Pedido Rápido via WhatsApp
          </p>
        </div>

        {category === null ? (
          <div className="grid md:grid-cols-2 gap-4">
            <Card
              className="cursor-pointer hover:shadow-xl transition-all hover:scale-105 border-2 border-transparent hover:border-green-400"
              onClick={() => handleCategorySelect('consumer')}
              data-testid="btn-select-consumer"
            >
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShoppingCart className="w-8 h-8 text-rose-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">Consumidor</h2>
                <p className="text-gray-600 text-sm">Compre para consumo próprio</p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer hover:shadow-xl transition-all hover:scale-105 border-2 border-transparent hover:border-green-400"
              onClick={() => handleCategorySelect('reseller')}
              data-testid="btn-select-reseller"
            >
              <CardContent className="p-6 text-center">
                <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Store className="w-8 h-8 text-emerald-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">Revendedor</h2>
                <p className="text-gray-600 text-sm">Compre para revender</p>
              </CardContent>
            </Card>
          </div>
        ) : category === 'consumer' && consumerTier === null ? (
          <div>
            <Button variant="ghost" onClick={reset} className="text-white mb-4" data-testid="btn-back-consumer">
              <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
            </Button>
            <div className="grid md:grid-cols-2 gap-4">
              <Card
                className="cursor-pointer hover:shadow-xl transition-all hover:scale-105 border-2 border-transparent hover:border-blue-400"
                onClick={() => handleConsumerTierSelect('retail')}
                data-testid="btn-select-retail"
              >
                <CardContent className="p-6 text-center">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <ShoppingCart className="w-8 h-8 text-blue-600" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-800 mb-2">Varejo</h2>
                  <p className="text-gray-600 text-sm">Compras até R$ 200</p>
                  <Badge className="mt-2 bg-blue-100 text-blue-700">Mínimo R$ 70</Badge>
                </CardContent>
              </Card>

              <Card
                className="cursor-pointer hover:shadow-xl transition-all hover:scale-105 border-2 border-transparent hover:border-purple-400"
                onClick={() => handleConsumerTierSelect('wholesale')}
                data-testid="btn-select-wholesale"
              >
                <CardContent className="p-6 text-center">
                  <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <ShoppingCart className="w-8 h-8 text-purple-600" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-800 mb-2">Atacado</h2>
                  <p className="text-gray-600 text-sm">Compras acima de R$ 200</p>
                  <Badge className="mt-2 bg-purple-100 text-purple-700">Preços especiais</Badge>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : category === 'reseller' && resellerLocation === null ? (
          <div>
            <Button variant="ghost" onClick={reset} className="text-white mb-4" data-testid="btn-back-reseller">
              <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
            </Button>
            <h2 className="text-xl font-bold text-white text-center mb-4">Onde está seu negócio?</h2>
            <div className="grid md:grid-cols-3 gap-4">
              <Card
                className="cursor-pointer hover:shadow-xl transition-all hover:scale-105"
                onClick={() => handleResellerLocationSelect('goiania')}
                data-testid="btn-select-goiania"
              >
                <CardContent className="p-4 text-center">
                  <MapPin className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
                  <h3 className="font-bold">Goiânia</h3>
                  <Badge className="mt-2 bg-emerald-100 text-emerald-700">Mín R$ 150</Badge>
                </CardContent>
              </Card>

              <Card
                className="cursor-pointer hover:shadow-xl transition-all hover:scale-105"
                onClick={() => handleResellerLocationSelect('interior')}
                data-testid="btn-select-interior"
              >
                <CardContent className="p-4 text-center">
                  <MapPin className="w-8 h-8 text-amber-600 mx-auto mb-2" />
                  <h3 className="font-bold">Interior GO</h3>
                  <Badge className="mt-2 bg-amber-100 text-amber-700">Mín R$ 350</Badge>
                </CardContent>
              </Card>

              <Card
                className="cursor-pointer hover:shadow-xl transition-all hover:scale-105"
                onClick={() => handleResellerLocationSelect('brasilia')}
                data-testid="btn-select-brasilia"
              >
                <CardContent className="p-4 text-center">
                  <MapPin className="w-8 h-8 text-blue-600 mx-auto mb-2" />
                  <h3 className="font-bold">Brasília</h3>
                  <Badge className="mt-2 bg-blue-100 text-blue-700">Mín R$ 150</Badge>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}

        <p className="text-center text-white/70 text-sm mt-8">
          Sucos 100% naturais • Entrega rápida • Frete grátis
        </p>
      </div>
    </div>
  );
}
