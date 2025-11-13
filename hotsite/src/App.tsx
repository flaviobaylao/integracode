import { useState, useEffect } from 'react';
import ProductCard from './components/ProductCard';
import Cart from './components/Cart';
import CheckoutForm from './components/CheckoutForm';
import { CustomerTypeSelector } from './components/CustomerTypeSelector';
import { HonestLogo } from './components/HonestLogo';
import HeroSection from './components/HeroSection';
import BadgesSection from './components/BadgesSection';
import ProductShowcase from './components/ProductShowcase';
import BenefitsSection from './components/BenefitsSection';
import { CustomerTypeProvider, useCustomerType } from './contexts/CustomerTypeContext';
import { getProductPrice } from './utils/pricing';
import { api } from './utils/api';
import type { Product, CartItem, Customer } from './types';

type View = 'catalog' | 'checkout' | 'success';

function HotsiteContent() {
  const { isSelectionComplete, priceTable, reset } = useCustomerType();
  const [view, setView] = useState<View>('catalog');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Carregar produtos ao iniciar
  useEffect(() => {
    loadProducts();
    // Carregar carrinho do localStorage
    const savedCart = localStorage.getItem('honest-cart');
    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart));
      } catch (e) {
        console.error('Erro ao carregar carrinho:', e);
      }
    }
  }, []);

  // Salvar carrinho no localStorage sempre que mudar
  useEffect(() => {
    localStorage.setItem('honest-cart', JSON.stringify(cart));
  }, [cart]);

  const loadProducts = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.getProducts();
      setProducts(data);
    } catch (err) {
      setError('Erro ao carregar produtos. Tente novamente.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const addToCart = (product: Product) => {
    const correctPrice = getProductPrice(product, priceTable);
    
    const existingItem = cart.find(item => item.id === product.id);
    
    if (existingItem) {
      setCart(cart.map(item =>
        item.id === product.id
          ? { ...item, quantity: item.quantity + 1 }
          : item
      ));
    } else {
      // Adicionar ao carrinho com o preço correto baseado na tabela selecionada
      setCart([...cart, { ...product, price: correctPrice, quantity: 1 }]);
    }
    
    // Feedback visual
    setIsCartOpen(true);
    setTimeout(() => setIsCartOpen(false), 2000);
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(productId);
      return;
    }
    
    setCart(cart.map(item =>
      item.id === productId
        ? { ...item, quantity }
        : item
    ));
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter(item => item.id !== productId));
  };

  const calculateTotal = () => {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const hasDiscount = subtotal >= 200;
    const discount = hasDiscount ? (subtotal * 0.1) : 0;
    return subtotal - discount;
  };

  const handleCheckout = async (customer: Customer, paymentMethod: 'pix' | 'card' | 'boleto') => {
    try {
      console.log('🔵 handleCheckout iniciado');
      console.log('🔵 Customer:', customer);
      console.log('🔵 Payment Method:', paymentMethod);
      console.log('🔵 Cart:', cart);
      console.log('🔵 Price Table:', priceTable);
      
      setIsProcessing(true);
      setError(null);

      // ✅ CORREÇÃO: Converter campos vazios para null para passar validação Zod
      const cleanCustomer = {
        ...customer,
        email: customer.email?.trim() || null,
        cpfCnpj: customer.cpfCnpj?.trim() || null,
      };

      // ✅ Converter formato da priceTable: 'retail_price' → 'retail'
      const convertPriceTable = (table: string | null): 'retail' | 'wholesale' | 'goiania' | 'interior' | 'brasilia' | undefined => {
        if (!table) return undefined;
        
        // Mapeamento direto das tabelas de preço
        const tableMap: Record<string, 'retail' | 'wholesale' | 'goiania' | 'interior' | 'brasilia'> = {
          'retail_price': 'retail',
          'wholesale_price': 'wholesale',
          'resale_goiania_price': 'goiania',
          'resale_interior_price': 'interior',
          'resale_brasilia_price': 'brasilia',
        };
        
        return tableMap[table];
      };

      const order = {
        customer: cleanCustomer,
        items: cart.map(item => ({
          productId: item.id,
          productName: item.name,
          quantity: item.quantity,
          unitPrice: item.price,
        })),
        totalAmount: calculateTotal(),
        paymentMethod,
        source: 'hotsite' as const,
        priceTable: convertPriceTable(priceTable), // ✅ Adicionar tabela de preço
        deliveryLocation: customer.deliveryLocation || null, // ✅ Adicionar coordenadas GPS (opcional)
      };

      console.log('🔵 Order objeto criado:', order);
      console.log('🔵 Chamando api.createOrder...');
      
      const response = await api.createOrder(order);
      
      console.log('✅ Resposta recebida:', response);
      
      setOrderNumber(response.orderNumber);
      setCart([]);
      localStorage.removeItem('honest-cart');
      setView('success');
    } catch (err: any) {
      console.error('❌ Erro capturado:', err);
      console.error('❌ Erro mensagem:', err.message);
      console.error('❌ Erro stack:', err.stack);
      setError(err.message || 'Erro ao criar pedido. Tente novamente.');
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // Se a seleção de tipo de cliente não estiver completa, mostrar seletor
  if (!isSelectionComplete) {
    return <CustomerTypeSelector />;
  }

  // View: Sucesso
  if (view === 'success') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-500 to-pink-400 flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="flex justify-center mb-6">
            <HonestLogo size="xl" className="text-honest-green" />
          </div>
          <div className="text-7xl mb-4">✅</div>
          <h1 className="text-3xl font-bold text-honest-green mb-4">Pedido Confirmado!</h1>
          <p className="text-gray-600 mb-2">Número do pedido:</p>
          <p className="text-2xl font-mono font-bold text-honest-orange mb-6" data-testid="order-number">{orderNumber}</p>
          
          <div className="bg-honest-light p-4 rounded-xl mb-6 text-left">
            <p className="text-sm text-gray-700">
              <strong>Próximos passos:</strong><br/>
              • Você receberá a confirmação no WhatsApp<br/>
              • Nossa equipe entrará em contato para agendar sua entrega<br/>
              • Entregaremos seus sucos fresquinhos! 🍓
            </p>
          </div>

          <button
            onClick={() => {
              setView('catalog');
              setOrderNumber('');
            }}
            className="btn-primary w-full"
            data-testid="btn-new-order"
          >
            Fazer Novo Pedido
          </button>

          <a
            href={`https://wa.me/556299578281?text=Olá! Meu pedido é ${orderNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary w-full mt-3 inline-block"
          >
            Falar no WhatsApp
          </a>
        </div>
      </div>
    );
  }

  // View: Checkout
  if (view === 'checkout') {
    return (
      <CheckoutForm
        cartItems={cart}
        total={calculateTotal()}
        onSubmit={handleCheckout}
        onBack={() => setView('catalog')}
        isProcessing={isProcessing}
      />
    );
  }

  // View: Catálogo (Principal)
  return (
    <div className="min-h-screen bg-white">
      {/* Header fixo */}
      <header className="bg-white/95 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-40 shadow-sm">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <HonestLogo size="lg" className="text-honest-green" />
            </div>
            
            <button
              onClick={reset}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 rounded-lg mr-3 transition-all"
              data-testid="btn-change-customer-type"
            >
              Alterar Tipo
            </button>
            
            <button
              onClick={() => setIsCartOpen(true)}
              className="relative bg-honest-green hover:bg-green-700 text-white rounded-full p-3 transition-all active:scale-95"
              data-testid="btn-open-cart"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              {cartItemsCount > 0 && (
                <span className="badge animate-pulse" data-testid="cart-badge">
                  {cartItemsCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Landing Page Sections */}
      <HeroSection />
      <BadgesSection />
      <ProductShowcase />
      <BenefitsSection />

      {/* Catálogo de Produtos */}
      <section id="products" className="py-20 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
              Nossos Sucos
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Escolha seus sabores favoritos e receba em casa
            </p>
          </div>

      {/* Conteúdo Principal */}
      <main className="max-w-7xl mx-auto px-4">
        {error && (
          <div className="bg-red-100 border-2 border-red-500 text-red-700 px-4 py-3 rounded-lg mb-4 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-700 font-bold">✕</button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <svg className="animate-spin h-12 w-12 text-honest-green mx-auto mb-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-gray-600">Carregando produtos...</p>
            </div>
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-xl text-gray-600">Nenhum produto disponível no momento</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="products-grid">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onAddToCart={addToCart}
              />
            ))}
          </div>
        )}
      </main>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-honest-green text-white py-12">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-8">
            <div>
              <HonestLogo size="xl" className="text-white mb-4" />
              <p className="text-sm opacity-90">
                Sucos 100% naturais direto da fazenda para você.
                Sem açúcar, sem conservantes, sem enrolação.
              </p>
            </div>
            <div>
              <h3 className="font-bold text-lg mb-4">Contato</h3>
              <p className="text-sm opacity-90 mb-2">📍 Bela Vista de Goiás, GO</p>
              <p className="text-sm opacity-90 mb-2">📞 <a href="https://wa.me/556299578281" className="underline">(62) 99578-2812</a></p>
              <p className="text-sm opacity-90">Entregamos em Goiânia e região</p>
            </div>
            <div>
              <h3 className="font-bold text-lg mb-4">Horário de Atendimento</h3>
              <p className="text-sm opacity-90">Segunda a Sexta: 8h às 18h</p>
              <p className="text-sm opacity-90">Sábado: 8h às 12h</p>
            </div>
          </div>
          <div className="border-t border-white/20 pt-6 text-center text-sm opacity-75">
            <p>&copy; {new Date().getFullYear()} Honest Sucos. Todos os direitos reservados.</p>
          </div>
        </div>
      </footer>

      {/* Cart Modal */}
      {isCartOpen && (
        <Cart
          items={cart}
          onUpdateQuantity={updateQuantity}
          onRemoveItem={removeFromCart}
          onCheckout={() => {
            setIsCartOpen(false);
            setView('checkout');
          }}
          onClose={() => setIsCartOpen(false)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <CustomerTypeProvider>
      <HotsiteContent />
    </CustomerTypeProvider>
  );
}
