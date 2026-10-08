import { useState, useEffect } from 'react';
import ProductCard from './components/ProductCard';
import Cart from './components/Cart';
import CheckoutForm from './components/CheckoutForm';
import { CustomerTypeSelector } from './components/CustomerTypeSelector';
import { HonestLogo } from './components/HonestLogo';
import { GooglePayButton } from './components/GooglePayButton';
import HeroSection from './components/HeroSection';
import BadgesSection from './components/BadgesSection';
import ProductShowcase from './components/ProductShowcase';
import BenefitsSection from './components/BenefitsSection';
import FlavorStories from './components/FlavorStories';
import { CustomerTypeProvider, useCustomerType } from './contexts/CustomerTypeContext';
import { getProductPrice } from './utils/pricing';
import { api } from './utils/api';
// Central de Marketing (buraco 2): captura a origem do visitante (UTM + cid do /r/<slug>)
import { capturarOrigem, origemDoPedido } from './utils/origem';
// Central de Marketing: eventos do Pixel. No-op se o Pixel nao foi injetado.
import { pixel, pixelUmaVez, conteudos } from './utils/pixel';
// Aviso de cobertura de entrega (provisoria) — mostrado na vitrine, antes do carrinho.
import { TITULO_AVISO_COBERTURA, TEXTO_AVISO_COBERTURA } from './utils/entrega';
import { useRef, useMemo } from 'react';
import { agruparPorSabor, brl } from './utils/garrafas';
import type { Product, CartItem, Customer } from './types';

type View = 'catalog' | 'checkout' | 'pix' | 'card' | 'success';

function HotsiteContent() {
  const { isSelectionComplete, priceTable, reset } = useCustomerType();
  const [view, setView] = useState<View>('catalog');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [discountInfo, setDiscountInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // 💚 PIX pagar-antes: dados da cobrança + status ('awaiting_payment' | 'processing' | 'paid' | 'expired' | 'paid_order_error')
  const [pixData, setPixData] = useState<any>(null);
  const [pixStatus, setPixStatus] = useState('awaiting_payment');
  const [pixCopied, setPixCopied] = useState(false);
  const [pixNow, setPixNow] = useState(Date.now());

  // 💳 Cartão pagar-antes: pedido pendente + campos do formulário
  const [cardOrder, setCardOrder] = useState<any>(null);
  // Cotação do servidor para o pedido no cartão (total já com cupom/indicação).
  // É a mesma conta que a cobrança usa; a tela nunca calcula desconto por conta própria.
  const [cardQuote, setCardQuote] = useState<any>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [cardInstallments] = useState(1);
  const [cardError, setCardError] = useState('');
  const [cardProcessing, setCardProcessing] = useState(false);
  const [cardPendingMsg, setCardPendingMsg] = useState('');

  // 🎯 Central de Marketing (buraco 2): captura a origem na PRIMEIRA carga, antes
  // de qualquer navegação. Guarda em sessionStorage e limpa os utm_* da barra de
  // endereço. Sem parâmetro na URL, não faz nada — visita direta continua igual.
  useEffect(() => { capturarOrigem(); }, []);

  // 🎯 Pixel: o carrinho é esvaziado ANTES da tela de sucesso aparecer, nos quatro
  // caminhos (pedido direto, PIX, cartão, Google Pay). Guardar a última foto do
  // carrinho aqui evita ter que instrumentar os quatro — e evita que um deles
  // seja esquecido no dia em que aparecer um quinto.
  const ultimoCarrinhoRef = useRef<{ valor: number; itens: CartItem[] }>({ valor: 0, itens: [] });

  // 🎯 Pixel: Purchase. UM lugar só, ouvindo o resultado, em vez de quatro
  // lugares disparando. A trava é o número do pedido e vive em localStorage:
  // um F5 na tela de sucesso não vira uma segunda venda. Contar a mesma compra
  // duas vezes ensina a Meta que o anúncio rende o dobro — e ela gasta de acordo.
  useEffect(() => {
    if (view !== 'success' || !orderNumber) return;
    const foto = ultimoCarrinhoRef.current;
    if (!foto.valor) return; // sem valor não há o que reportar
    pixelUmaVez('purchase:' + orderNumber, 'Purchase', {
      ...conteudos(foto.itens),
      value: foto.valor,
      currency: 'BRL',
    });
  }, [view, orderNumber]);

  // Contagem regressiva da expiração do PIX (1s)
  useEffect(() => {
    if (view !== 'pix') return;
    const t = setInterval(() => setPixNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view]);

  // Polling do pagamento (5s): quando o banco confirmar, o pedido é criado no servidor
  useEffect(() => {
    if (view !== 'pix' || !pixData) return;
    if (pixStatus !== 'awaiting_payment' && pixStatus !== 'processing') return;
    const t = setInterval(async () => {
      try {
        const s = await api.getPixStatus(pixData.pendingId);
        if (s.status === 'paid') {
          setOrderNumber(s.orderNumber || '');
          setCart([]);
          localStorage.removeItem('honest-cart');
          setPixStatus('paid');
          setView('success');
        } else if (s.status === 'expired' || s.status === 'paid_order_error') {
          setPixStatus(s.status);
        } else if (s.status === 'processing') {
          setPixStatus('processing');
        }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
    return () => clearInterval(t);
  }, [view, pixData, pixStatus]);

  // Carregar produtos ao iniciar
  useEffect(() => {
    loadProducts();
    // Carregar carrinho do localStorage (formato compacto: apenas id, name, price, quantity)
    const savedCart = localStorage.getItem('honest-cart');
    if (savedCart) {
      try {
        const parsedCart = JSON.parse(savedCart);
        // Reconstruir cart items mínimos (sem imagens para economizar espaço)
        setCart(parsedCart.map((item: any) => ({
          id: item.id,
          name: item.name || item.n || '',
          description: null,
          details: null,
          price: item.price || item.p || 0,
          retailPrice: null,
          wholesalePrice: null,
          resaleGoianiaPrice: null,
          resaleInteriorPrice: null,
          resaleBrasiliaPrice: null,
          imageUrl: null, // Não armazenamos imagem no localStorage
          stock: item.stock || 999,
          quantity: item.quantity || item.q || 1
        })));
      } catch (e) {
        console.error('Erro ao carregar carrinho:', e);
        localStorage.removeItem('honest-cart');
      }
    }
  }, []);

  // Salvar carrinho no localStorage sempre que mudar (formato compacto)
  useEffect(() => {
    // Só memoriza carrinho com item. Quando ele é esvaziado para a tela de
    // sucesso, a última foto boa precisa continuar de pé.
    if (cart.length) {
      ultimoCarrinhoRef.current = {
        valor: cart.reduce((s, i) => s + i.price * i.quantity, 0),
        itens: cart,
      };
    }
    try {
      // Salvar apenas dados essenciais: id, name, price, quantity
      const compactCart = cart.map(item => ({
        id: item.id,
        n: item.name,
        p: item.price,
        q: item.quantity
      }));
      localStorage.setItem('honest-cart', JSON.stringify(compactCart));
    } catch (e) {
      console.error('Erro ao salvar carrinho:', e);
      // Se ainda der erro de quota, limpar carrinho antigo
      if ((e as any)?.name === 'QuotaExceededError') {
        console.warn('Carrinho muito grande, limpando dados antigos');
        localStorage.removeItem('honest-cart');
      }
    }
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
    
    // 🎯 Pixel: AddToCart com o preço da TABELA do visitante (revenda paga
    // diferente de consumidor). Mandar o preço de balcão para todo mundo faria a
    // Meta otimizar por um ticket que não existe.
    pixel('AddToCart', {
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name,
      value: correctPrice,
      currency: 'BRL',
    });

    // Abrir carrinho (permanece aberto até cliente fechar)
    setIsCartOpen(true);
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
    // Sem desconto - preços já são diferenciados por tabela
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
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
        referralCode: (referralCode || '').trim().toUpperCase() || null,
        // Mesmo texto vai como cupom: o servidor tenta CUPOM primeiro (canal hotsite) e,
        // se nao for um cupom valido, cai no codigo de indicacao. Um desconto por pedido.
        couponCode: (referralCode || '').trim().toUpperCase() || null,
        paymentMethod,
        source: 'hotsite' as const,
        priceTable: convertPriceTable(priceTable), // ✅ Adicionar tabela de preço
        deliveryLocation: customer.deliveryLocation || null, // ✅ Adicionar coordenadas GPS (opcional)
        // 🎯 Origem do visitante (utm + cid). Vai junto no PIX, no cartão e no boleto —
        // os três guardam este mesmo objeto e o servidor o reprocessa quando o
        // pagamento confirma, então a atribuição sobrevive à volta. Sem origem, sai {}.
        ...origemDoPedido(),
      };

      console.log('🔵 Order objeto criado:', order);

      // 💚 PIX pagar-antes: gera a cobrança e mostra o QR — o pedido só é
      // registrado no sistema depois que o pagamento for confirmado.
      if (paymentMethod === 'pix') {
        const pix = await api.initPixOrder(order);
        if (pix.couponDiscount) setDiscountInfo({ ...pix.couponDiscount, tipo: 'cupom' });
        else if (pix.referralDiscount) setDiscountInfo({ ...pix.referralDiscount, tipo: 'indicacao' });
        else setDiscountInfo(null);
        setPixData(pix);
        setPixStatus('awaiting_payment');
        setPixCopied(false);
        setView('pix');
        return;
      }
      // 💳 Cartão pagar-antes: abre o formulário de cartão — o pedido só é
      // registrado depois que a Cielo aprovar o pagamento.
      if (paymentMethod === 'card') {
        // Pergunta ao servidor o valor que ELE vai cobrar (cupom > indicação > recompensa).
        // Falha na cotação não impede a compra: a tela cai no subtotal e o servidor
        // continua cobrando o valor correto — só o texto da tela fica sem o desconto.
        let quote: any = null;
        try {
          quote = await api.quoteOrder(order);
        } catch (e) {
          console.warn('⚠️ cotação indisponível — exibindo subtotal', e);
        }
        setCardQuote(quote);
        if (quote?.couponDiscount) setDiscountInfo({ ...quote.couponDiscount, tipo: 'cupom' });
        else if (quote?.referralDiscount) setDiscountInfo({ ...quote.referralDiscount, tipo: 'indicacao' });
        else setDiscountInfo(null);
        setCardOrder(order);
        setCardError('');
        setCardPendingMsg('');
        setCardProcessing(false);
        setView('card');
        return;
      }

      console.log('🔵 Chamando api.createOrder...');

      const response = await api.createOrder(order);
        if (response.couponDiscount) setDiscountInfo({ ...response.couponDiscount, tipo: 'cupom' });
        else if (response.referralDiscount) setDiscountInfo({ ...response.referralDiscount, tipo: 'indicacao' });
        else setDiscountInfo(null);
      
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
  // 🍾 Vitrine por sabor (350 + 900 no mesmo cartão)
  const grupos = useMemo(() => agruparPorSabor(products), [products]);

  // Se a seleção de tipo de cliente não estiver completa, mostrar seletor
  if (!isSelectionComplete) {
    return <CustomerTypeSelector />;
  }

  // View: Pagamento com CARTÃO — o pedido só é registrado após aprovação da Cielo
  if (view === 'card' && cardOrder) {
    // O valor cobrado é o do SERVIDOR (já com cupom/indicação). Sem cotação, cai no
    // subtotal — nunca o contrário: a tela jamais anuncia menos do que será cobrado.
    const subtotalCard = Number(cardOrder.totalAmount) || 0;
    const totalCard = Number(cardQuote?.total) > 0 ? Number(cardQuote.total) : subtotalCard;
    const descontoCard = Math.round((subtotalCard - totalCard) * 100) / 100;
    const fmtNum = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
    const fmtExp = (v: string) => {
      const d = v.replace(/\D/g, '').slice(0, 4);
      return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
    };
    const canPay = cardNumber.replace(/\D/g, '').length >= 13 && cardHolder.trim().length > 2 && /^\d{2}\/\d{2}$/.test(cardExpiry) && cardCvv.replace(/\D/g, '').length >= 3 && !cardProcessing;
    const doPay = async () => {
      if (!canPay) return;
      setCardProcessing(true);
      setCardError('');
      try {
        const r = await api.payWithCard(cardOrder, { number: cardNumber, holder: cardHolder, expiry: cardExpiry, cvv: cardCvv }, cardInstallments);
        if (r.orderPending) {
          setCardPendingMsg((r.message || 'Pagamento aprovado! Pedido em processamento.') + ' Código: ' + (r.paymentId || ''));
        } else {
          setOrderNumber(r.orderNumber || '');
          setCart([]);
          localStorage.removeItem('honest-cart');
          setCardNumber(''); setCardHolder(''); setCardExpiry(''); setCardCvv('');
          setView('success');
        }
      } catch (e: any) {
        setCardError(e.message || 'Pagamento não autorizado.');
      } finally {
        setCardProcessing(false);
      }
    };
    return (
      <div className="min-h-screen bg-honest-paper flex items-center justify-center p-4">
        <div className="bg-white rounded-[28px] p-6 sm:p-8 max-w-md w-full ring-1 ring-black/5">
          <div className="flex justify-center mb-3"><HonestLogo size="sm" /></div>
          <h1 className="font-display text-2xl font-bold text-honest-ink text-center mt-4 mb-1">Pagar com cartão</h1>
          <p className="font-display text-4xl font-extrabold text-honest-ink text-center mb-1 tabular-nums" data-testid="card-amount">{brl(totalCard)}</p>
          {descontoCard > 0 && (
            <p className="text-center text-sm text-green-700 mb-3" data-testid="card-discount">
              <span className="line-through text-gray-400 mr-2">R$ {subtotalCard.toFixed(2)}</span>
              {discountInfo?.tipo === 'cupom'
                ? <>Cupom <strong>{discountInfo.code}</strong>: −R$ {descontoCard.toFixed(2)}</>
                : <>Desconto aplicado: −R$ {descontoCard.toFixed(2)}</>}
            </p>
          )}
          {descontoCard <= 0 && <div className="mb-3" />}
          {cardPendingMsg ? (
            <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-4 mb-4 text-sm text-yellow-800">✅ {cardPendingMsg}</div>
          ) : (
            <>
              <GooglePayButton
                order={cardOrder}
                amount={totalCard}
                onSuccess={(r) => {
                  if (r.orderPending) {
                    setCardPendingMsg((r.message || 'Pagamento aprovado! Pedido em processamento.') + ' Código: ' + (r.paymentId || ''));
                  } else {
                    setOrderNumber(r.orderNumber || '');
                    setCart([]);
                    localStorage.removeItem('honest-cart');
                    setCardNumber(''); setCardHolder(''); setCardExpiry(''); setCardCvv('');
                    setView('success');
                  }
                }}
                onError={(m) => setCardError(m)}
              />
              <label className="block text-xs font-semibold text-gray-600 mb-1">Número do cartão</label>
              <input inputMode="numeric" autoComplete="cc-number" value={cardNumber} onChange={e => setCardNumber(fmtNum(e.target.value))} placeholder="0000 0000 0000 0000" className="w-full border border-gray-300 rounded-2xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-honest-green/30 focus:border-honest-green mb-3 text-base tracking-wider" data-testid="card-number" />
              <label className="block text-xs font-semibold text-gray-600 mb-1">Nome impresso no cartão</label>
              <input autoComplete="cc-name" value={cardHolder} onChange={e => setCardHolder(e.target.value.toUpperCase())} placeholder="COMO ESTÁ NO CARTÃO" className="w-full border border-gray-300 rounded-2xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-honest-green/30 focus:border-honest-green mb-3 text-base" data-testid="card-holder" />
              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Validade</label>
                  <input inputMode="numeric" autoComplete="cc-exp" value={cardExpiry} onChange={e => setCardExpiry(fmtExp(e.target.value))} placeholder="MM/AA" className="w-full border border-gray-300 rounded-2xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-honest-green/30 focus:border-honest-green text-base" data-testid="card-expiry" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">CVV</label>
                  <input inputMode="numeric" autoComplete="cc-csc" value={cardCvv} onChange={e => setCardCvv(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="123" className="w-full border border-gray-300 rounded-2xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-honest-green/30 focus:border-honest-green text-base" data-testid="card-cvv" />
                </div>
              </div>
              {cardError && (
                <div className="bg-red-50 border border-red-300 rounded-xl p-3 mb-3 text-sm text-red-700" data-testid="card-error">❌ {cardError}</div>
              )}
              <button onClick={doPay} disabled={!canPay} className={`w-full rounded-full py-3.5 font-bold text-white mb-2 ${canPay ? 'bg-honest-green hover:bg-honest-forest' : 'bg-gray-300'}`} data-testid="btn-card-pay">
                {cardProcessing ? '⏳ Processando pagamento…' : `Pagar ${brl(totalCard)}`}
              </button>
              <p className="text-[11px] text-gray-400 text-center mb-2">Pagamento processado com segurança pela Cielo. Seu pedido só é registrado após a aprovação.</p>
            </>
          )}
          <button onClick={() => { setView(cardPendingMsg ? 'catalog' : 'checkout'); setCardError(''); }} className="btn-secondary w-full" data-testid="btn-card-back">
            {cardPendingMsg ? 'Voltar ao início' : 'Voltar'}
          </button>
        </div>
      </div>
    );
  }

  // View: Pagamento PIX — o pedido só é registrado após o pagamento confirmado
  if (view === 'pix' && pixData) {
    const remainingMs = Math.max(0, new Date(pixData.expiresAt).getTime() - pixNow);
    const mm = String(Math.floor(remainingMs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0');
    const isExpired = pixStatus === 'expired' || remainingMs <= 0;
    return (
      <div className="min-h-screen bg-honest-paper flex items-center justify-center p-4">
        <div className="bg-white rounded-[28px] p-6 sm:p-8 max-w-md w-full text-center ring-1 ring-black/5">
          <div className="flex justify-center mb-4">
            <HonestLogo size="sm" />
          </div>
          <h1 className="font-display text-2xl font-bold text-honest-ink mt-4 mb-1">Pague com Pix</h1>
          <p className="font-display text-4xl font-extrabold text-honest-ink mb-3 tabular-nums" data-testid="pix-amount">{brl(Number(pixData.amount))}</p>
          {discountInfo && (
            <div className="bg-green-50 border border-green-300 rounded-xl p-2 mb-3 text-xs text-green-800">
              {discountInfo.tipo === 'cupom'
                ? <>Cupom <strong>{discountInfo.code}</strong> aplicado: −R$ {Number(discountInfo.amount).toFixed(2)}</>
                : <>Desconto de indicação aplicado: {discountInfo.pct}% (R$ {Number(discountInfo.amount).toFixed(2)})</>}
            </div>
          )}
          {pixStatus === 'paid_order_error' ? (
            <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-4 mb-4 text-sm text-yellow-800 text-left">
              ✅ <strong>Pagamento recebido!</strong> Estamos registrando seu pedido. Guarde este código e, se precisar, fale conosco no WhatsApp: <span className="font-mono break-all">{pixData.txid}</span>
            </div>
          ) : isExpired ? (
            <div className="bg-red-50 border border-red-300 rounded-xl p-4 mb-4 text-sm text-red-700">
              ⏰ Este PIX expirou sem pagamento. Nenhum pedido foi criado — volte e gere um novo código.
            </div>
          ) : (
            <>
              <p className="text-gray-600 mb-3 text-sm">Escaneie o QR Code ou copie o código abaixo</p>
              <img src={pixData.qrCodeBase64} alt="QR Code PIX" className="mx-auto w-56 h-56 p-2 bg-white ring-1 ring-black/10 rounded-3xl mb-4" data-testid="pix-qrcode" />
              <div className="bg-honest-paper rounded-2xl p-3 mb-4">
                <p className="text-[10px] text-gray-400 break-all mb-2 max-h-16 overflow-hidden">{pixData.pixCopiaECola}</p>
                <button
                  onClick={() => { try { navigator.clipboard.writeText(pixData.pixCopiaECola); setPixCopied(true); setTimeout(() => setPixCopied(false), 2500); } catch {} }}
                  className="btn-primary w-full text-sm"
                  data-testid="btn-copy-pix"
                >
                  {pixCopied ? 'Código copiado' : 'Copiar código Pix'}
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-1">Expira em <strong>{mm}:{ss}</strong></p>
              <p className="text-sm text-honest-green font-semibold mb-5"><span className="inline-block w-2 h-2 rounded-full bg-honest-leaf animate-pulse mr-2 align-middle" aria-hidden="true" />
                {pixStatus === 'processing' ? 'Pagamento recebido. Registrando seu pedido…' : 'Aguardando o pagamento. A confirmação é automática.'}
              </p>
            </>
          )}
          <button
            onClick={() => { setView(isExpired || pixStatus === 'paid_order_error' ? 'catalog' : 'checkout'); setPixData(null); setPixStatus('awaiting_payment'); }}
            className="btn-secondary w-full"
            data-testid="btn-pix-back"
          >
            {isExpired ? 'Gerar novo pedido' : 'Voltar'}
          </button>
        </div>
      </div>
    );
  }

  // View: Sucesso
  if (view === 'success') {
    return (
      <div className="min-h-screen bg-honest-paper flex items-center justify-center p-4">
        <div className="bg-white rounded-[28px] p-6 sm:p-8 max-w-md w-full text-center ring-1 ring-black/5">
          <div className="flex justify-center mb-6">
            <HonestLogo size="md" />
          </div>
          <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-honest-leaf flex items-center justify-center text-3xl text-honest-ink" aria-hidden="true">✓</div>
          <h1 className="font-display text-3xl font-extrabold text-honest-ink mb-4">Pedido confirmado</h1>
          <p className="text-sm text-gray-500 mb-1">Número do pedido</p>
          <p className="inline-block font-display text-2xl font-bold text-honest-ink bg-honest-paper rounded-full px-5 py-2 mb-6 tabular-nums" data-testid="order-number">{orderNumber}</p>
                {discountInfo && (
                  <div className="bg-green-50 border border-green-300 rounded-xl p-3 mb-4 text-sm text-green-800">
                    {discountInfo.tipo === 'cupom'
                      ? <>Cupom <strong>{discountInfo.code}</strong>: −R$ {Number(discountInfo.amount).toFixed(2)}</>
                      : <>Desconto aplicado: {discountInfo.pct}% (R$ {Number(discountInfo.amount).toFixed(2)})</>} · Total: R$ {Number(discountInfo.total).toFixed(2)}
                  </div>
                )}
          
          <ol className="text-left space-y-3 mb-6">
            {[
              'Você recebe a confirmação no WhatsApp.',
              'Nossa equipe combina com você o dia da entrega.',
              'Seus sucos chegam fresquinhos e gelados.',
            ].map((t, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-gray-700">
                <span className="w-6 h-6 shrink-0 rounded-full bg-honest-light text-honest-forest text-xs font-bold flex items-center justify-center">{i + 1}</span>
                <span className="pt-0.5">{t}</span>
              </li>
            ))}
          </ol>

          <button
            onClick={() => {
              setView('catalog');
              setOrderNumber('');
            }}
            className="btn-primary w-full"
            data-testid="btn-new-order"
          >
            Fazer novo pedido
          </button>

          <a
            href={`https://wa.me/5562995782812?text=Olá! Meu pedido é ${orderNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary w-full mt-3 inline-block text-center"
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
        code={referralCode}
        onCodeChange={setReferralCode}
      />
    );
  }

  // View: Catálogo (Principal)
  return (
    <div className="min-h-screen bg-honest-paper">
      {/* Header fixo */}
      <header className="bg-white/90 backdrop-blur border-b border-black/5 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3">
          <div className="flex-1">
            <HonestLogo size="sm" />
          </div>

          <button
            onClick={reset}
            className="text-sm text-honest-forest font-semibold px-3 py-2 rounded-full hover:bg-honest-paper transition-colors"
            data-testid="btn-change-customer-type"
          >
            Alterar tipo
          </button>

          <button
            onClick={() => setIsCartOpen(true)}
            className="relative bg-honest-forest hover:bg-honest-green text-white rounded-full pl-4 pr-5 py-2.5 transition-all active:scale-95 inline-flex items-center gap-2 font-semibold text-sm"
            data-testid="btn-open-cart"
            aria-label={`Abrir carrinho, ${cartItemsCount} ${cartItemsCount === 1 ? 'item' : 'itens'}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            Carrinho
            {cartItemsCount > 0 && (
              <span className="badge" data-testid="cart-badge">
                {cartItemsCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <HeroSection />

      {/* Catálogo de Produtos — logo depois do topo: é para isso que o cliente veio */}
      <section id="products" className="py-14 md:py-20 scroll-mt-16">
        <div className="max-w-6xl mx-auto px-4">
          <div className="md:flex md:items-end md:justify-between gap-8 mb-8">
            <div>
              <h2 className="font-display text-4xl md:text-5xl font-extrabold text-honest-ink">
                Escolha seus sabores
              </h2>
              <p className="text-lg text-gray-600 mt-2 max-w-xl">
                Cada sabor vem em 350 ml e 900 ml. Toque na garrafa para ver os detalhes.
              </p>
            </div>
          </div>

          {/* atalhos por sabor */}
          {grupos.some(g => g.sabor) && (
            <nav aria-label="Sabores" className="-mx-4 px-4 mb-8 flex gap-2 overflow-x-auto no-scrollbar">
              {grupos.filter(g => g.sabor).map(g => (
                <a
                  key={g.key}
                  href={`#sabor-${g.key}`}
                  className="shrink-0 inline-flex items-center gap-2 bg-white rounded-full pl-2 pr-4 py-1.5 text-sm font-semibold text-honest-ink ring-1 ring-black/5 hover:ring-honest-green transition-shadow"
                >
                  <span className="w-5 h-5 rounded-full" style={{ backgroundColor: g.sabor!.cor }} aria-hidden="true" />
                  {g.sabor!.nome}
                </a>
              ))}
            </nav>
          )}

          {/* 🚚 COBERTURA DE ENTREGA (29/set/2026) — o cliente precisa saber ANTES de
              montar o carrinho que a entrega hoje só alcança Goiânia e Aparecida, e
              que isso é provisório. O bloqueio real é pelo CEP, no checkout. */}
          <div
            className="mb-8 bg-white border-l-4 border-honest-orange rounded-2xl px-5 py-4 flex items-start gap-3"
            data-testid="aviso-cobertura-vitrine"
          >
            <span className="text-2xl leading-none shrink-0" aria-hidden="true">🚚</span>
            <div className="text-left">
              <p className="font-semibold text-honest-ink">{TITULO_AVISO_COBERTURA}</p>
              <p className="text-sm text-gray-600 mt-0.5">{TEXTO_AVISO_COBERTURA}</p>
            </div>
          </div>

          <main>
            {error && (
              <div className="bg-red-50 border border-red-300 text-red-700 px-4 py-3 rounded-2xl mb-4 flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => { setError(null); loadProducts(); }} className="text-red-700 font-semibold underline">Tentar de novo</button>
              </div>
            )}

            {isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" aria-busy="true" aria-label="Carregando sabores">
                {[0, 1, 2].map(i => (
                  <div key={i} className="bg-white rounded-[28px] overflow-hidden ring-1 ring-black/5">
                    <div className="h-72 sm:h-80 bg-honest-light animate-pulse" />
                    <div className="p-5 space-y-3">
                      <div className="h-6 w-2/3 bg-honest-paper rounded-full" />
                      <div className="h-4 w-full bg-honest-paper rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : products.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-xl text-gray-600">Nenhum sabor disponível agora. Fale com a gente no WhatsApp.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" data-testid="products-grid">
                {grupos.map((grupo) => (
                  <ProductCard
                    key={grupo.key}
                    grupo={grupo}
                    onAddToCart={addToCart}
                  />
                ))}
              </div>
            )}
          </main>
        </div>
      </section>

      {/* Landing Page Sections */}
      <FlavorStories />
      <BadgesSection />
      <ProductShowcase />
      <BenefitsSection />

      {/* Footer */}
      <footer className="bg-honest-forest text-white pt-14 pb-10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">
            <div>
              <img src="/shop/honest-logo-white.png" alt="Honest Sucos" className="h-20 w-auto mb-4" />
              <p className="text-sm text-white/80 max-w-xs">
                Suco natural, sem adição de açúcares, direto da fábrica para você.
              </p>
            </div>
            <div>
              <h3 className="font-display font-bold text-lg mb-3">Contato</h3>
              <p className="text-sm text-white/80 mb-2">Bela Vista de Goiás, GO</p>
              <p className="text-sm text-white/80 mb-2">WhatsApp <a href="https://wa.me/5562995782812" className="underline underline-offset-2">(62) 99578-2812</a></p>
              <p className="text-sm text-white/80">Entregamos em Goiânia e região</p>
            </div>
            <div>
              <h3 className="font-display font-bold text-lg mb-3">Atendimento</h3>
              <p className="text-sm text-white/80">Segunda a sexta: 8h às 18h</p>
              <p className="text-sm text-white/80">Sábado: 8h às 12h</p>
            </div>
          </div>
          <div className="border-t border-white/15 pt-6 text-sm text-white/60">
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
            // 🎯 Pixel: InitiateCheckout. É o sinal que separa "colocou no
            // carrinho" de "foi preencher o endereço" — e é dele que sai o
            // público de carrinho abandonado.
            pixel('InitiateCheckout', { ...conteudos(cart), value: calculateTotal(), currency: 'BRL' });
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
