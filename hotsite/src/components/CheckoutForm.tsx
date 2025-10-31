import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import type { Customer, CartItem } from '../types';

interface CheckoutFormProps {
  cartItems: CartItem[];
  total: number;
  onSubmit: (customer: Customer, paymentMethod: 'pix' | 'card' | 'boleto') => void;
  onBack: () => void;
  isProcessing: boolean;
}

export default function CheckoutForm({ cartItems, total, onSubmit, onBack, isProcessing }: CheckoutFormProps) {
  const [formData, setFormData] = useState<Customer>({
    name: '',
    email: '',
    phone: '',
    address: '',
    cpfCnpj: '',
    customerType: 'pessoa_fisica',
  });
  
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card' | 'boleto'>('pix');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isCheckingCustomer, setIsCheckingCustomer] = useState(false);
  const [customerFound, setCustomerFound] = useState(false);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) newErrors.name = 'Nome é obrigatório';
    if (!formData.phone.trim()) newErrors.phone = 'Telefone é obrigatório';
    if (formData.phone.replace(/\D/g, '').length < 10) newErrors.phone = 'Telefone inválido';
    if (!formData.address.trim()) newErrors.address = 'Endereço é obrigatório';
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Email inválido';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (validate()) {
      onSubmit(formData, paymentMethod);
    }
  };

  const formatPhone = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 10) {
      return numbers.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    }
    return numbers.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
  };

  // Verificar se cliente já existe quando email ou telefone for preenchido
  const checkExistingCustomer = useCallback(async () => {
    const email = formData.email?.trim();
    const phone = formData.phone.replace(/\D/g, '');

    // Resetar estado se ambos os campos estiverem vazios
    if (!email && !phone) {
      setCustomerFound(false);
      setIsCheckingCustomer(false);
      return;
    }

    // Só verificar se tiver email válido OU telefone com pelo menos 10 dígitos
    if ((!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) && phone.length < 10) {
      setCustomerFound(false);
      return;
    }

    try {
      setIsCheckingCustomer(true);
      const result = await api.checkCustomer(email, phone);

      if (result.exists && result.name) {
        // Cliente encontrado! Preencher dados automaticamente
        setCustomerFound(true);
        setFormData(prev => ({
          ...prev,
          name: result.name || prev.name,
          customerType: (result.customerType as 'pessoa_fisica' | 'pessoa_juridica') || prev.customerType
        }));
      } else {
        setCustomerFound(false);
      }
    } catch (error) {
      console.error('Erro ao verificar cliente:', error);
      setCustomerFound(false);
    } finally {
      setIsCheckingCustomer(false);
    }
  }, [formData.email, formData.phone]);

  // Verificar cliente quando email ou telefone mudar (com debounce)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      checkExistingCustomer();
    }, 800);

    return () => clearTimeout(timeoutId);
  }, [checkExistingCustomer]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-honest-green text-white p-4 sticky top-0 z-10">
        <button onClick={onBack} className="flex items-center gap-2 mb-2" data-testid="btn-back">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Voltar
        </button>
        <h1 className="text-2xl font-bold">Finalizar Pedido</h1>
      </div>

      <div className="p-4 max-w-2xl mx-auto">
        {/* Resumo do Pedido */}
        <div className="bg-white rounded-xl p-4 mb-4 shadow-sm">
          <h2 className="font-bold text-lg mb-3">Resumo do Pedido</h2>
          <div className="space-y-2 text-sm">
            {cartItems.map((item) => (
              <div key={item.id} className="flex justify-between">
                <span>{item.quantity}x {item.name}</span>
                <span className="font-semibold">R$ {(item.price * item.quantity).toFixed(2)}</span>
              </div>
            ))}
            <div className="border-t pt-2 flex justify-between font-bold text-lg">
              <span>Total:</span>
              <span className="text-honest-green">R$ {total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <h2 className="font-bold text-lg mb-4">Seus Dados</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Nome Completo *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className={`input-field ${errors.name ? 'border-red-500' : ''}`}
                  placeholder="João Silva"
                  data-testid="input-name"
                />
                {errors.name && <p className="text-red-500 text-sm mt-1">{errors.name}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Telefone/WhatsApp *</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: formatPhone(e.target.value) })}
                  className={`input-field ${errors.phone ? 'border-red-500' : customerFound ? 'border-honest-green' : ''}`}
                  placeholder="(62) 99999-9999"
                  data-testid="input-phone"
                />
                {errors.phone && <p className="text-red-500 text-sm mt-1">{errors.phone}</p>}
                {isCheckingCustomer && (
                  <p className="text-gray-500 text-sm mt-1 flex items-center gap-1">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Verificando...
                  </p>
                )}
                {customerFound && !isCheckingCustomer && (
                  <p className="text-honest-green text-sm mt-1 flex items-center gap-1" data-testid="customer-found-message">
                    ✅ Cliente reconhecido! Bem-vindo de volta.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Email (opcional)</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={`input-field ${errors.email ? 'border-red-500' : customerFound ? 'border-honest-green' : ''}`}
                  placeholder="seuemail@exemplo.com"
                  data-testid="input-email"
                />
                {errors.email && <p className="text-red-500 text-sm mt-1">{errors.email}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Endereço de Entrega *</label>
                <textarea
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className={`input-field ${errors.address ? 'border-red-500' : ''}`}
                  placeholder="Rua, número, complemento, bairro, cidade"
                  rows={3}
                  data-testid="input-address"
                />
                {errors.address && <p className="text-red-500 text-sm mt-1">{errors.address}</p>}
              </div>
            </div>
          </div>

          {/* Forma de Pagamento */}
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <h2 className="font-bold text-lg mb-4">Forma de Pagamento</h2>
            
            <div className="space-y-3">
              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-honest-green transition-colors">
                <input
                  type="radio"
                  name="payment"
                  value="pix"
                  checked={paymentMethod === 'pix'}
                  onChange={() => setPaymentMethod('pix')}
                  className="w-5 h-5"
                  data-testid="payment-pix"
                />
                <div className="flex-1">
                  <div className="font-semibold">Pix</div>
                  <div className="text-sm text-gray-600">Aprovação instantânea</div>
                </div>
                <span className="text-2xl">💳</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-honest-green transition-colors">
                <input
                  type="radio"
                  name="payment"
                  value="card"
                  checked={paymentMethod === 'card'}
                  onChange={() => setPaymentMethod('card')}
                  className="w-5 h-5"
                  data-testid="payment-card"
                />
                <div className="flex-1">
                  <div className="font-semibold">Cartão de Crédito/Débito</div>
                  <div className="text-sm text-gray-600">Parcelamento disponível</div>
                </div>
                <span className="text-2xl">💳</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-honest-green transition-colors">
                <input
                  type="radio"
                  name="payment"
                  value="boleto"
                  checked={paymentMethod === 'boleto'}
                  onChange={() => setPaymentMethod('boleto')}
                  className="w-5 h-5"
                  data-testid="payment-boleto"
                />
                <div className="flex-1">
                  <div className="font-semibold">Boleto Bancário</div>
                  <div className="text-sm text-gray-600">Vence em 7 dias</div>
                </div>
                <span className="text-2xl">📄</span>
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={isProcessing}
            className="btn-primary w-full text-lg"
            data-testid="btn-submit-order"
          >
            {isProcessing ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Processando...
              </span>
            ) : (
              `Confirmar Pedido - R$ ${total.toFixed(2)}`
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
