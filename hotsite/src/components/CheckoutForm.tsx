import { useState, useEffect } from 'react';
import { HonestLogo } from './HonestLogo';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import type { Customer, CartItem } from '../types';

interface CheckoutFormProps {
  cartItems: CartItem[];
  total: number;
  onSubmit: (customer: Customer, paymentMethod: 'pix' | 'card' | 'boleto') => void;
  onBack: () => void;
  isProcessing: boolean;
}

export default function CheckoutForm({ cartItems, total, onSubmit, onBack, isProcessing }: CheckoutFormProps) {
  const { consumerData, companyData } = useCustomerType();

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

  // Preencher dados do contexto quando disponível
  useEffect(() => {
    if (consumerData) {
      setFormData({
        name: consumerData.nome,
        email: consumerData.email || '',
        phone: consumerData.telefone || '',
        address: consumerData.endereco,
        cpfCnpj: consumerData.cpf,
        customerType: 'pessoa_fisica',
      });
    } else if (companyData) {
      setFormData({
        name: companyData.nomeFantasia,
        email: companyData.email || '',
        phone: companyData.telefone || '',
        address: companyData.endereco,
        cpfCnpj: companyData.cnpj,
        customerType: 'pessoa_juridica',
      });
    }
  }, [consumerData, companyData]);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) newErrors.name = 'Nome é obrigatório';
    if (!formData.phone.trim()) newErrors.phone = 'Telefone é obrigatório';
    if (formData.phone.replace(/\D/g, '').length < 10) newErrors.phone = 'Telefone inválido';
    if (!formData.address.trim()) newErrors.address = 'Endereço é obrigatório';
    if (formData.email && formData.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Email inválido';
    }
    
    // ✅ CPF obrigatório para consumidores (pessoa física)
    if (formData.customerType === 'pessoa_fisica') {
      if (!formData.cpfCnpj || !formData.cpfCnpj.trim()) {
        newErrors.cpfCnpj = 'CPF é obrigatório para consumidores';
      } else {
        const cpfNumbers = formData.cpfCnpj.replace(/\D/g, '');
        if (cpfNumbers.length !== 11) {
          newErrors.cpfCnpj = 'CPF deve ter 11 dígitos';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    console.log('🟢 Form submitted');
    console.log('🟢 Form data:', formData);
    console.log('🟢 Payment method:', paymentMethod);
    
    const isValid = validate();
    console.log('🟢 Validation result:', isValid);
    
    if (isValid) {
      console.log('🟢 Calling onSubmit...');
      onSubmit(formData, paymentMethod);
    } else {
      console.log('❌ Validation failed, errors:', errors);
    }
  };

  const formatPhone = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 10) {
      return numbers.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    }
    return numbers.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
  };

  const formatCPF = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
  };

  // ✅ Forçar mudança de pagamento se pessoa_fisica tentar usar boleto
  useEffect(() => {
    if (formData.customerType === 'pessoa_fisica' && paymentMethod === 'boleto') {
      setPaymentMethod('pix');
    }
  }, [formData.customerType, paymentMethod]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-honest-green text-white p-4 sticky top-0 z-10">
        <div className="flex items-center justify-between mb-3">
          <button onClick={onBack} className="flex items-center gap-2" data-testid="btn-back">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Voltar
          </button>
          <HonestLogo size="xl" className="text-white" />
        </div>
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
                  className={`input-field ${errors.phone ? 'border-red-500' : ''}`}
                  placeholder="(62) 99999-9999"
                  data-testid="input-phone"
                />
                {errors.phone && <p className="text-red-500 text-sm mt-1">{errors.phone}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Email (opcional)</label>
                <input
                  type="email"
                  value={formData.email || ''}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={`input-field ${errors.email ? 'border-red-500' : ''}`}
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

              <div>
                <label className="block text-sm font-medium mb-1">
                  CPF * <span className="text-xs text-gray-500">(para faturamento)</span>
                </label>
                <input
                  type="text"
                  value={formData.cpfCnpj || ''}
                  onChange={(e) => setFormData({ ...formData, cpfCnpj: formatCPF(e.target.value) })}
                  className={`input-field ${errors.cpfCnpj ? 'border-red-500' : ''}`}
                  placeholder="000.000.000-00"
                  maxLength={14}
                  data-testid="input-cpf"
                />
                {errors.cpfCnpj && <p className="text-red-500 text-sm mt-1">{errors.cpfCnpj}</p>}
                <p className="text-xs text-gray-500 mt-1">Necessário para emissão da nota fiscal</p>
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

              {/* Boleto disponível apenas para pessoa jurídica */}
              {formData.customerType === 'pessoa_juridica' && (
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
              )}
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
