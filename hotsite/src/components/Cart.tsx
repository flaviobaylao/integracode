import { useEffect, useState } from 'react';
import { CartItem } from '../types';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { TEXTO_AREA_ATENDIDA } from '../utils/entrega';
import { identificar, imagemDoProduto, brl } from '../utils/garrafas';

// 🔒 Pedido mínimo do consumidor — valores padrão iguais aos da configuração no
// servidor (Canais > Hotsite). Se a consulta falhar, a loja usa estes mesmos números,
// nunca libera o pedido sem trava.
const MIN_VAREJO_PADRAO = 80;
const MIN_ATACADO_PADRAO = 200;

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

  // 🔒 TRAVA DE VALOR DO CONSUMIDOR (ago/2026) — o teste de pagamento online de
  // 18/jul, que liberava pedido mínimo zero para consumidores, foi encerrado.
  // Os valores vêm de Canais > Hotsite > Configurações (default 80 varejo / 200
  // atacado) e a mesma regra é reaplicada no servidor, que é a trava de verdade.
  const [minVarejo, setMinVarejo] = useState(MIN_VAREJO_PADRAO);
  const [minAtacado, setMinAtacado] = useState(MIN_ATACADO_PADRAO);
  useEffect(() => {
    let vivo = true;
    fetch('/api/public/canais/minimos')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!vivo || !cfg?.consumidor) return;
        const v = Number(cfg.consumidor.varejo);
        const a = Number(cfg.consumidor.atacado);
        if (Number.isFinite(v) && v >= 0) setMinVarejo(v);
        if (Number.isFinite(a) && a >= 0) setMinAtacado(a);
      })
      .catch(() => { /* mantém os padrões */ });
    return () => { vivo = false; };
  }, []);

  // Calcular pedido mínimo baseado no tipo de cliente
  const getMinimumOrder = (): number => {
    if (category === 'consumer') {
      if (consumerTier === 'wholesale') return minAtacado;
      return minVarejo; // varejo e fallback do consumidor sem tier
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
      className="fixed inset-0 bg-honest-ink/60 z-50 flex items-end md:items-center md:justify-center" 
      data-testid="cart-modal"
      onClick={onClose}
    >
      <div 
        className="bg-white w-full md:max-w-lg md:rounded-t-3xl rounded-t-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 flex items-center justify-between bg-honest-forest text-white rounded-t-3xl">
          <h2 className="font-display text-xl font-bold">Seu carrinho</h2>
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
              <p className="font-display text-xl font-bold text-honest-ink">Seu carrinho está vazio</p>
              <p className="text-gray-500 mt-1">Escolha um sabor para começar.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((item) => (
                <div key={item.id} className="flex gap-3 bg-honest-paper p-3 rounded-2xl" data-testid={`cart-item-${item.id}`}>
                  <div
                    className="w-20 h-20 rounded-xl flex-shrink-0 flex items-end justify-center overflow-hidden"
                    style={{ backgroundColor: identificar(item.name).sabor?.cor || '#E6F0DC' }}
                  >
                    {imagemDoProduto(item) ? (
                      identificar(item.name).sabor
                        ? <img src={imagemDoProduto(item)!} alt={item.name} className="h-[88%] object-contain mb-0.5" />
                        : <img src={imagemDoProduto(item)!} alt={item.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-honest-leaf to-honest-green rounded-lg">
                        <span className="text-white text-3xl">🍓</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1">
                    <h3 className="font-semibold text-sm text-honest-ink">{(() => { const { sabor, tamanho } = identificar(item.name); return sabor && tamanho ? `${sabor.nome} ${tamanho} ml` : item.name; })()}</h3>
                    <p className="text-gray-600 text-sm tabular-nums">{brl(item.price)}</p>
                    
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
                        className="ml-auto text-gray-500 text-sm hover:text-red-600 underline-offset-2 hover:underline"
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
          <div className="border-t border-black/5 p-4 bg-white">
            {/* Frete Grátis — SOMENTE na área atendida (provisoriamente Goiânia e Aparecida) */}
            <div className="mb-3 p-3 bg-honest-light rounded-2xl">
              <p className="text-sm font-bold text-honest-forest flex items-center gap-2">
                <span aria-hidden="true">🚚</span>
                Frete Grátis para {TEXTO_AREA_ATENDIDA}
              </p>
              <p className="text-xs text-honest-forest/80 mt-1">
                Confirmamos o seu CEP na próxima etapa. Ainda não entregamos fora dessa
                região — estamos ampliando a cobertura aos poucos.
              </p>
            </div>

            {/* Aviso de Pedido Mínimo */}
            {!meetsMinimum && (
              <div className="mb-3 p-3 bg-amber-50 rounded-2xl">
                <p className="text-sm font-bold text-amber-700 flex items-center gap-2">
                                    Pedido mínimo: {brl(minimumOrder)}
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  Adicione mais {brl(missingAmount)} para finalizar seu pedido
                </p>
                <div className="mt-2 h-2 rounded-full bg-amber-100 overflow-hidden" aria-hidden="true">
                  <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${Math.min(100, (subtotal / minimumOrder) * 100)}%` }} />
                </div>
              </div>
            )}
            
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-sm">
                <span>Subtotal</span>
                <span>{brl(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm text-honest-green">
                <span>Frete</span>
                <span className="font-semibold">Grátis na área atendida</span>
              </div>
              <div className="flex justify-between items-baseline font-display text-xl font-bold text-honest-ink border-t border-black/10 pt-2">
                <span>Total</span>
                <span className="tabular-nums" data-testid="cart-total">{brl(total)}</span>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2">
              <button
                onClick={onClose}
                className="w-full py-3 rounded-full font-bold border-2 border-honest-green text-honest-green hover:bg-honest-green hover:bg-opacity-10 transition-all"
                data-testid="btn-continue-shopping"
              >
                Continuar comprando
              </button>
              
              <button
                onClick={onCheckout}
                disabled={!meetsMinimum}
                className={`w-full py-3 rounded-full font-bold transition-all ${
                  meetsMinimum
                    ? 'btn-primary'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
                data-testid="btn-checkout"
              >
                {meetsMinimum ? 'Finalizar pedido' : `Pedido mínimo: ${brl(minimumOrder)}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
