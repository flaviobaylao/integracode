import { CartItem } from '../types';
import { useCustomerType } from '../contexts/CustomerTypeContext';

interface CartProps {
  items: CartItem[];
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onCheckout: () => void;
  onClose: () => void;
}

export default function Cart({ items, onUpdateQuantity, onRemoveItem, onCheckout, onClose }: CartProps) {
  const { category, consumerTier, resellerLocation } = useCustomerType();
  
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = subtotal; // Sem desconto - preços já são diferenciados por tabela

  // Calcular pedido mínimo baseado no tipo de cliente
  const getMinimumOrder = (): number => {
    if (category === 'consumer') {
      if (consumerTier === 'retail') return 70;
      if (consumerTier === 'wholesale') return 200;
      return 70; // Fallback para consumidor sem tier
    }
    if (category === 'reseller') {
      if (resellerLocation === 'goiania') return 150;
      if (resellerLocation === 'interior') return 350;
      if (resellerLocation === 'brasilia') return 150;
      return 150; // Fallback para revendedor sem localização
    }
    return 70; // Fallback geral
  };

  const minimumOrder = getMinimumOrder();
  // ✅ CORREÇÃO: Usar subtotal ao invés de total para validar pedido mínimo
  // Isso evita que o desconto de 10% bloqueie clientes que atingem o mínimo
  const meetsMinimum = subtotal >= minimumOrder;
  const missingAmount = minimumOrder - subtotal;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end md:items-center md:justify-center" 
      data-testid="cart-modal"
      onClick={onClose}
    >
      <div 
        className="bg-white w-full md:max-w-lg md:rounded-t-3xl rounded-t-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between bg-honest-green text-white rounded-t-3xl">
          <h2 className="text-xl font-bold">Carrinho</h2>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2"
            data-testid="btn-close-cart"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">🛒</div>
              <p className="text-gray-500">Seu carrinho está vazio</p>
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((item) => (
                <div key={item.id} className="flex gap-3 bg-gray-50 p-3 rounded-lg" data-testid={`cart-item-${item.id}`}>
                  <div className="w-20 h-20 bg-gray-200 rounded-lg flex-shrink-0">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover rounded-lg" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-rose-400 to-pink-500 rounded-lg">
                        <span className="text-white text-3xl">🍓</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm">{item.name}</h3>
                    <p className="text-honest-green font-bold">R$ {item.price.toFixed(2)}</p>
                    
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
                        className="w-8 h-8 bg-white border-2 border-honest-green text-honest-green rounded-full font-bold active:scale-95"
                        data-testid={`btn-decrease-${item.id}`}
                      >
                        −
                      </button>
                      <span className="w-8 text-center font-semibold" data-testid={`quantity-${item.id}`}>{item.quantity}</span>
                      <button
                        onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                        className="w-8 h-8 bg-honest-green text-white rounded-full font-bold active:scale-95"
                        data-testid={`btn-increase-${item.id}`}
                      >
                        +
                      </button>
                      <button
                        onClick={() => onRemoveItem(item.id)}
                        className="ml-auto text-red-500 text-sm hover:underline"
                        data-testid={`btn-remove-${item.id}`}
                      >
                        Remover
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="border-t p-4 bg-gray-50">
            {/* Frete Grátis */}
            <div className="mb-3 p-3 bg-green-50 border-2 border-green-400 rounded-lg">
              <p className="text-sm font-bold text-green-700 flex items-center gap-2">
                <span>🚚</span>
                Frete Grátis em todos os pedidos!
              </p>
            </div>

            {/* Aviso de Pedido Mínimo */}
            {!meetsMinimum && (
              <div className="mb-3 p-3 bg-amber-50 border-2 border-amber-400 rounded-lg">
                <p className="text-sm font-bold text-amber-700 flex items-center gap-2">
                  <span>⚠️</span>
                  Pedido mínimo: R$ {minimumOrder.toFixed(2)}
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  Adicione mais R$ {missingAmount.toFixed(2)} para finalizar seu pedido
                </p>
              </div>
            )}
            
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-sm">
                <span>Subtotal:</span>
                <span>R$ {subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm text-green-700">
                <span>Frete:</span>
                <span className="font-semibold">GRÁTIS</span>
              </div>
              <div className="flex justify-between text-lg font-bold border-t pt-2">
                <span>Total:</span>
                <span className="text-honest-green" data-testid="cart-total">R$ {total.toFixed(2)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                onClick={onClose}
                className="w-full py-3 rounded-xl font-bold border-2 border-honest-green text-honest-green hover:bg-honest-green hover:bg-opacity-10 transition-all"
                data-testid="btn-continue-shopping"
              >
                Continuar Comprando
              </button>
              
              <button
                onClick={onCheckout}
                disabled={!meetsMinimum}
                className={`w-full py-3 rounded-xl font-bold transition-all ${
                  meetsMinimum
                    ? 'btn-primary'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
                data-testid="btn-checkout"
              >
                {meetsMinimum ? 'Finalizar Pedido' : `Pedido Mínimo: R$ ${minimumOrder.toFixed(2)}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
