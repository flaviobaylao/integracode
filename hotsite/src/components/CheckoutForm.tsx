import { useState } from 'react';
import { HonestLogo } from './HonestLogo';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { api } from '../utils/api';
import type { Customer, CartItem } from '../types';
import { Loader2, AlertCircle, Check } from 'lucide-react';

interface CheckoutFormProps {
  cartItems: CartItem[];
  total: number;
  onSubmit: (customer: Customer, paymentMethod: 'pix' | 'card' | 'boleto') => void;
  onBack: () => void;
  isProcessing: boolean;
}

export default function CheckoutForm({ cartItems, total, onSubmit, onBack, isProcessing }: CheckoutFormProps) {
  const { category } = useCustomerType();
  
  // Determinar tipo de cliente baseado na categoria selecionada
  const customerType = category === 'reseller' ? 'pessoa_juridica' : 'pessoa_fisica';
  
  const [formData, setFormData] = useState<Customer>({
    name: '',
    email: '',
    phone: '',
    address: '',
    cpfCnpj: '',
    customerType,
  });
  
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card' | 'boleto'>('pix');
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  // Estados para validação de CPF/CNPJ
  const [documentInput, setDocumentInput] = useState('');
  const [isValidatingDocument, setIsValidatingDocument] = useState(false);
  const [documentValidated, setDocumentValidated] = useState(false);
  const [documentError, setDocumentError] = useState('');
  
  // Estados para captura de localização GPS
  const [deliveryLocation, setDeliveryLocation] = useState<{ latitude: number; longitude: number; capturedAt: Date } | null>(null);
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // Helper para atualizar formData preservando sempre o cpfCnpj validado
  const updateFormData = (updates: Partial<Customer>) => {
    setFormData(prev => ({
      ...prev,
      ...updates,
      // Sempre preservar cpfCnpj se já foi validado
      cpfCnpj: updates.cpfCnpj !== undefined ? updates.cpfCnpj : prev.cpfCnpj
    }));
  };

  // Formatar CPF
  const formatCPF = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 11) {
      return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
    }
    return numbers.slice(0, 11).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  };

  // Formatar CNPJ
  const formatCNPJ = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 14) {
      return numbers.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return numbers.slice(0, 14).replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  };

  // Validar CPF
  const validarCPF = (cpf: string): boolean => {
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (cpfLimpo.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpfLimpo)) return false;
    
    let soma = 0;
    for (let i = 1; i <= 9; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (11 - i);
    }
    
    let resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(9, 10))) return false;
    
    soma = 0;
    for (let i = 1; i <= 10; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i);
    }
    
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(10, 11))) return false;
    
    return true;
  };

  // Validar CNPJ
  const validarCNPJ = (cnpj: string): boolean => {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    
    if (cnpjLimpo.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(cnpjLimpo)) return false;
    
    let tamanho = cnpjLimpo.length - 2;
    let numeros = cnpjLimpo.substring(0, tamanho);
    const digitos = cnpjLimpo.substring(tamanho);
    let soma = 0;
    let pos = tamanho - 7;
    
    for (let i = tamanho; i >= 1; i--) {
      soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
      if (pos < 2) pos = 9;
    }
    
    let resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (resultado !== parseInt(digitos.charAt(0))) return false;
    
    tamanho = tamanho + 1;
    numeros = cnpjLimpo.substring(0, tamanho);
    soma = 0;
    pos = tamanho - 7;
    
    for (let i = tamanho; i >= 1; i--) {
      soma += parseInt(numeros.charAt(tamanho - i)) * pos--;
      if (pos < 2) pos = 9;
    }
    
    resultado = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (resultado !== parseInt(digitos.charAt(1))) return false;
    
    return true;
  };

  // Validar documento e buscar dados
  const handleValidateDocument = async () => {
    setDocumentError('');
    
    if (!documentInput) {
      setDocumentError('Por favor, informe o documento');
      return;
    }

    const isReseller = customerType === 'pessoa_juridica';
    
    // Validar formato
    const isValid = isReseller ? validarCNPJ(documentInput) : validarCPF(documentInput);
    if (!isValid) {
      setDocumentError(isReseller ? 'CNPJ inválido' : 'CPF inválido');
      return;
    }

    setIsValidatingDocument(true);

    try {
      if (isReseller) {
        // CNPJ: Buscar na Receita Federal ou sistema
        const checkResult = await api.checkCustomerByCNPJ(documentInput);
        
        if (checkResult.exists && checkResult.customer) {
          // Cliente já existe
          const customer = checkResult.customer;
          updateFormData({
            name: customer.fantasyName || customer.companyName,
            cpfCnpj: customer.cnpj,
            address: customer.address || '',
            phone: customer.phone || '',
            email: customer.email || '',
          });
        } else {
          // Buscar na Receita Federal
          const dados = await api.consultarCNPJ(documentInput);
          
          if (dados.situacao !== 'ATIVA') {
            setDocumentError(`Este CNPJ está com situação: ${dados.situacao}`);
            setIsValidatingDocument(false);
            return;
          }
          
          updateFormData({
            name: dados.nomeFantasia || dados.razaoSocial,
            cpfCnpj: dados.cnpj,
            address: dados.endereco,
            phone: dados.telefone || '',
            email: dados.email || '',
          });
        }
      } else {
        // CPF: Verificar se já existe
        const cpfLimpo = documentInput.replace(/\D/g, '');
        const checkResult = await api.checkCustomer('', '', cpfLimpo);
        
        if (checkResult.exists && checkResult.name) {
          // Cliente já existe
          updateFormData({
            name: checkResult.name,
            cpfCnpj: documentInput,
            address: checkResult.address || '',
            phone: checkResult.phone || '',
            email: checkResult.email || '',
          });
        } else {
          // Novo cliente - apenas setar o CPF
          updateFormData({
            cpfCnpj: documentInput,
          });
        }
      }
      
      setDocumentValidated(true);
    } catch (error: any) {
      setDocumentError(error.message || 'Erro ao validar documento');
    } finally {
      setIsValidatingDocument(false);
    }
  };

  const formatPhone = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 10) {
      return numbers.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    }
    return numbers.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
  };

  // Capturar localização GPS
  const handleCaptureLocation = () => {
    setLocationError(null);
    
    if (!navigator.geolocation) {
      setLocationError('Seu navegador não suporta geolocalização');
      return;
    }

    setIsCapturingLocation(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          capturedAt: new Date()
        };
        setDeliveryLocation(location);
        setIsCapturingLocation(false);
      },
      (error) => {
        setIsCapturingLocation(false);
        let errorMessage = 'Erro ao capturar localização';
        
        switch(error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Permissão negada. Habilite a localização no seu navegador.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Localização indisponível no momento.';
            break;
          case error.TIMEOUT:
            errorMessage = 'Tempo esgotado ao tentar capturar localização.';
            break;
        }
        
        setLocationError(errorMessage);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!documentValidated) {
      newErrors.document = 'Valide o documento antes de continuar';
    }
    if (!formData.name.trim()) newErrors.name = 'Nome é obrigatório';
    if (!formData.phone.trim()) newErrors.phone = 'Telefone é obrigatório';
    if (formData.phone.replace(/\D/g, '').length < 10) newErrors.phone = 'Telefone inválido';
    if (!formData.address.trim()) newErrors.address = 'Endereço é obrigatório';
    if (formData.email && formData.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Email inválido';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (validate()) {
      const customerWithLocation = {
        ...formData,
        deliveryLocation: deliveryLocation || null
      };
      onSubmit(customerWithLocation, paymentMethod);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-r from-rose-500 to-pink-400 text-white p-4 sticky top-0 z-10 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <button onClick={onBack} className="flex items-center gap-2 hover:text-white/80 transition-all" data-testid="btn-back">
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
              <span className="text-rose-600">R$ {total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Validação de Documento */}
          {!documentValidated ? (
            <div className="bg-white rounded-xl p-6 shadow-sm border-2 border-rose-300">
              <h2 className="font-bold text-lg mb-4">
                1. Informe seu {customerType === 'pessoa_juridica' ? 'CNPJ' : 'CPF'}
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    {customerType === 'pessoa_juridica' ? 'CNPJ' : 'CPF'} *
                  </label>
                  <input
                    type="text"
                    value={documentInput}
                    onChange={(e) => {
                      const formatted = customerType === 'pessoa_juridica' 
                        ? formatCNPJ(e.target.value)
                        : formatCPF(e.target.value);
                      setDocumentInput(formatted);
                      setDocumentError('');
                    }}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleValidateDocument();
                      }
                    }}
                    className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 ${
                      documentError 
                        ? 'border-red-300 focus:ring-red-500' 
                        : 'border-gray-200 focus:ring-rose-500'
                    }`}
                    placeholder={customerType === 'pessoa_juridica' ? '00.000.000/0000-00' : '000.000.000-00'}
                    maxLength={customerType === 'pessoa_juridica' ? 18 : 14}
                    disabled={isValidatingDocument}
                    data-testid="input-document"
                  />
                  {documentError && (
                    <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{documentError}</span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleValidateDocument}
                  disabled={isValidatingDocument || !documentInput}
                  className="w-full bg-rose-600 text-white py-3 rounded-xl font-semibold hover:bg-rose-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  data-testid="btn-validate-document"
                >
                  {isValidatingDocument ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Validando...
                    </>
                  ) : (
                    <>
                      <Check className="w-5 h-5" />
                      Validar {customerType === 'pessoa_juridica' ? 'CNPJ' : 'CPF'}
                    </>
                  )}
                </button>

                {errors.document && (
                  <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <p className="text-sm text-red-800">❌ {errors.document}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Documento Validado - Badge */}
              <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 flex items-center gap-3">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center">
                    <Check className="w-6 h-6 text-white" />
                  </div>
                </div>
                <div className="flex-1">
                  <p className="font-bold text-green-900">
                    {customerType === 'pessoa_juridica' ? 'CNPJ' : 'CPF'} Validado!
                  </p>
                  <p className="text-sm text-green-700">{formData.cpfCnpj}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDocumentValidated(false);
                    setDocumentInput('');
                    updateFormData({ cpfCnpj: '', name: '', address: '', phone: '', email: '' });
                  }}
                  className="text-sm text-green-700 hover:text-green-900 underline"
                >
                  Alterar
                </button>
              </div>

              {/* Dados do Cliente */}
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <h2 className="font-bold text-lg mb-4">2. Seus Dados</h2>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {customerType === 'pessoa_juridica' ? 'Nome Fantasia / Razão Social' : 'Nome Completo'} *
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => updateFormData({ name: e.target.value })}
                      className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                        errors.name ? 'border-red-300' : 'border-gray-200'
                      }`}
                      placeholder={customerType === 'pessoa_juridica' ? 'Nome da Empresa' : 'João Silva'}
                      data-testid="input-name"
                    />
                    {errors.name && <p className="text-red-500 text-sm mt-1">{errors.name}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Telefone/WhatsApp *</label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => updateFormData({ phone: formatPhone(e.target.value) })}
                      className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                        errors.phone ? 'border-red-300' : 'border-gray-200'
                      }`}
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
                      onChange={(e) => updateFormData({ email: e.target.value })}
                      className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                        errors.email ? 'border-red-300' : 'border-gray-200'
                      }`}
                      placeholder="seuemail@exemplo.com"
                      data-testid="input-email"
                    />
                    {errors.email && <p className="text-red-500 text-sm mt-1">{errors.email}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Endereço de Entrega *</label>
                    <textarea
                      value={formData.address}
                      onChange={(e) => updateFormData({ address: e.target.value })}
                      className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                        errors.address ? 'border-red-300' : 'border-gray-200'
                      }`}
                      placeholder="Rua, número, complemento, bairro, cidade"
                      rows={3}
                      data-testid="input-address"
                    />
                    {errors.address && <p className="text-red-500 text-sm mt-1">{errors.address}</p>}
                  </div>
                </div>
              </div>

              {/* Localização (Opcional) */}
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <h2 className="font-bold text-lg mb-4">3. Localização de Entrega (Opcional)</h2>
                
                {/* Aviso Importante */}
                <div className="mb-4 p-3 bg-amber-50 border-2 border-amber-400 rounded-lg">
                  <p className="text-sm font-semibold text-amber-800 flex items-center gap-2">
                    <span className="text-lg">⚠️</span>
                    Importante: Capture a localização somente se você estiver no local da entrega!
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    Isso ajuda nossa equipe a encontrar seu endereço com mais facilidade.
                  </p>
                </div>
                
                {!deliveryLocation ? (
                  <div>
                    <button
                      type="button"
                      onClick={handleCaptureLocation}
                      disabled={isCapturingLocation}
                      className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      data-testid="button-capture-location"
                    >
                      {isCapturingLocation ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Capturando...
                        </>
                      ) : (
                        <>
                          📍 Capturar Localização
                        </>
                      )}
                    </button>
                    {locationError && (
                      <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-xl">
                        <p className="text-sm text-red-800">❌ {locationError}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 mb-3">
                      <p className="font-bold text-green-900 mb-2">✅ Localização Capturada!</p>
                      <p className="text-sm text-green-800">
                        Lat: {deliveryLocation.latitude.toFixed(6)} | Long: {deliveryLocation.longitude.toFixed(6)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDeliveryLocation(null)}
                      className="w-full bg-gray-200 text-gray-800 py-2 rounded-xl font-medium hover:bg-gray-300 transition-colors"
                    >
                      Capturar Novamente
                    </button>
                  </div>
                )}
              </div>

              {/* Forma de Pagamento */}
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <h2 className="font-bold text-lg mb-4">4. Forma de Pagamento</h2>
                
                <div className="space-y-3">
                  <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-rose-500 transition-colors">
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

                  {customerType === 'pessoa_fisica' && (
                    <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-rose-500 transition-colors">
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
                  )}

                  {customerType === 'pessoa_juridica' && (
                    <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:border-rose-500 transition-colors">
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
                        <div className="text-sm text-gray-600">Sujeito à aprovação de crédito</div>
                      </div>
                      <span className="text-2xl">📄</span>
                    </label>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={isProcessing}
                className="w-full bg-gradient-to-r from-rose-500 to-pink-500 text-white py-4 rounded-xl font-bold text-lg hover:from-rose-600 hover:to-pink-600 transition-all disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed shadow-lg"
                data-testid="btn-submit-order"
              >
                {isProcessing ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processando...
                  </span>
                ) : (
                  `Confirmar Pedido - R$ ${total.toFixed(2)}`
                )}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
