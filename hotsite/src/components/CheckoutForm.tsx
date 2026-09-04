import { useEffect, useState } from 'react';
import { HonestLogo } from './HonestLogo';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { api } from '../utils/api';
import type { Customer, CartItem } from '../types';
import { Loader2, AlertCircle, Check } from 'lucide-react';
// 🚚 ÁREA DE ENTREGA (frete grátis só para Grande Goiânia + Brasília/DF e entorno)
import {
  buscarCep,
  formatarCep,
  limparCep,
  avaliarCobertura,
  montarEnderecoCompleto,
  TEXTO_AREA_ATENDIDA,
  WHATSAPP_HONEST,
  type EnderecoCep,
  type ResultadoCobertura,
} from '../utils/entrega';

interface CheckoutFormProps {
  cartItems: CartItem[];
  total: number;
  onSubmit: (customer: Customer, paymentMethod: 'pix' | 'card' | 'boleto') => void;
  onBack: () => void;
  isProcessing: boolean;
  // VIGIA CUPOM: o codigo mora no App (vai junto no pedido); aqui so entra a UI.
  code: string;
  onCodeChange: (value: string) => void;
}

export default function CheckoutForm({ cartItems, total, onSubmit, onBack, isProcessing, code, onCodeChange }: CheckoutFormProps) {
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

  // CARTAO SOB CHAVE GERAL (03/ago/2026): a opcao so aparece se o servidor disser que o
  // cartao esta habilitado (/api/public/orders/card/config -> enabled). Enquanto a credencial
  // da Cielo estiver recusando, o checkout nao oferece cartao — evita o cliente "pagar" e o
  // pedido nem existir. Em caso de falha na consulta, assume DESLIGADO (fail-safe).
  const [cardEnabled, setCardEnabled] = useState(false);
  useEffect(() => {
    let vivo = true;
    fetch('/api/public/orders/card/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => { if (vivo) setCardEnabled(!!cfg?.enabled); })
      .catch(() => { if (vivo) setCardEnabled(false); });
    return () => { vivo = false; };
  }, []);
  // Se o cartao cair enquanto a tela esta aberta, volta para PIX.
  useEffect(() => { if (!cardEnabled && paymentMethod === 'card') setPaymentMethod('pix'); }, [cardEnabled, paymentMethod]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  // Estados para validação de CPF/CNPJ
  const [documentInput, setDocumentInput] = useState('');
  const [isValidatingDocument, setIsValidatingDocument] = useState(false);
  const [documentValidated, setDocumentValidated] = useState(false);
  const [documentError, setDocumentError] = useState('');
  
  // VIGIA CUPOM: previa do desconto na propria tela (botao Aplicar).
  // O servidor continua sendo a fonte de verdade — o pedido sai com o valor CHEIO
  // e quem abate e o /api/public/orders. Aqui e so previa para o cliente ver.
  type CupomPreview = { ok: boolean; msg: string; code?: string; discount?: number; total?: number };
  const [codeChecking, setCodeChecking] = useState(false);
  const [codePreview, setCodePreview] = useState<CupomPreview | null>(null);
  // Mexeu no campo (ou no carrinho) => previa antiga nao vale mais.
  useEffect(() => { setCodePreview(null); }, [code, total]);

  const motivoCupom = (r: any, temDoc: boolean): string => {
    const motivo = String((r && r.reason) || '');
    switch (motivo) {
      case 'inexistente':
        return temDoc
          ? 'Código não encontrado.'
          : 'Código não encontrado. Se for código de indicação, informe seu CPF/CNPJ abaixo e tente de novo.';
      case 'inativo':
      case 'nao_habilitado_no_2_0': return 'Este código não está ativo.';
      case 'nao_iniciado': return 'Este cupom ainda não começou a valer.';
      case 'expirado': return 'Este cupom já expirou.';
      case 'esgotado': return 'Este cupom já atingiu o limite de usos.';
      case 'teto_atingido': return 'Este código de indicação já atingiu o limite de usos.';
      case 'pedido_minimo':
        return `Este cupom vale a partir de R$ ${Number(r?.minOrderValue || 0).toFixed(2)}.`;
      case 'canal_nao_permitido': return 'Este cupom não vale para compras pelo site.';
      case 'ja_usado_por_este_cliente':
      case 'ja_usou': return 'Você já usou este código.';
      case 'auto_indicacao': return 'Você não pode usar o seu próprio código de indicação.';
      case 'desconto_invalido_para_este_valor': return 'O desconto não se aplica a este valor de pedido.';
      case 'sem_codigo': return 'Digite um código.';
      default: return 'Código inválido para este pedido.';
    }
  };

  const aplicarCodigo = async () => {
    const limpo = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!limpo) { setCodePreview({ ok: false, msg: 'Digite um código.' }); return; }
    const doc = String(formData.cpfCnpj || '').replace(/\D/g, '');
    setCodeChecking(true);
    try {
      // 1) cupom promocional (tabela coupons) — tem prioridade, igual ao servidor
      const qs = new URLSearchParams({ code: limpo, total: String(total), channel: 'hotsite' });
      if (doc) qs.set('document', doc);
      const cup = await fetch(`/api/coupons/validate?${qs.toString()}`).then((r) => r.json()).catch(() => null);
      if (cup && cup.valid) {
        const desconto = Number(cup.discount) || 0;
        setCodePreview({
          ok: true,
          code: String(cup.code || limpo),
          discount: desconto,
          total: Number(cup.totalAfter ?? (total - desconto)),
          msg: `Cupom ${cup.code || limpo} aplicado.`,
        });
        return;
      }
      // 2) codigo de indicacao (tabela referral_coupons) — precisa do documento
      if (doc) {
        const ind = await fetch(`/api/referral/validate?code=${encodeURIComponent(limpo)}&referredDocument=${doc}`)
          .then((r) => r.json())
          .catch(() => null);
        if (ind && ind.valid) {
          const pct = Number(ind.discountPct) || 15;
          const desconto = Math.round(total * (pct / 100) * 100) / 100;
          setCodePreview({
            ok: true,
            code: String(ind.code || limpo),
            discount: desconto,
            total: Math.round((total - desconto) * 100) / 100,
            msg: `Código de indicação aplicado: ${pct}% de desconto.`,
          });
          return;
        }
        setCodePreview({ ok: false, msg: motivoCupom(ind && ind.reason ? ind : cup, true) });
        return;
      }
      setCodePreview({ ok: false, msg: motivoCupom(cup, false) });
    } catch {
      setCodePreview({ ok: false, msg: 'Não deu para validar agora. Tente de novo em alguns segundos.' });
    } finally {
      setCodeChecking(false);
    }
  };

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

  // ── 🚚 ENDEREÇO POR CEP + ÁREA DE ENTREGA ──────────────────────────────────
  // O frete grátis (e a entrega) valem só para a Grande Goiânia e Brasília/DF
  // e entorno do Plano Piloto. O CEP é consultado no ViaCEP; se a cidade estiver
  // fora da área, abre o popup e o pedido NÃO pode ser finalizado.
  const [cepInput, setCepInput] = useState('');
  const [enderecoCep, setEnderecoCep] = useState<EnderecoCep | null>(null);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [cepError, setCepError] = useState('');
  const [numero, setNumero] = useState('');
  const [complemento, setComplemento] = useState('');
  // Alguns CEPs (gerais de cidade) vêm sem logradouro no ViaCEP — aí o cliente digita.
  const [logradouroManual, setLogradouroManual] = useState('');
  const [cobertura, setCobertura] = useState<ResultadoCobertura | null>(null);
  const [modalForaArea, setModalForaArea] = useState(false);

  const foraDaArea = cobertura !== null && !cobertura.atendido;

  const handleBuscarCep = async (valorBruto: string) => {
    const limpo = limparCep(valorBruto);
    if (limpo.length !== 8) return;

    setBuscandoCep(true);
    setCepError('');
    setEnderecoCep(null);
    setCobertura(null);

    try {
      const endereco = await buscarCep(limpo);
      const resultado = avaliarCobertura(endereco.cidade, endereco.uf);
      setEnderecoCep(endereco);
      setCobertura(resultado);
      if (!resultado.atendido) setModalForaArea(true);
    } catch (erro: any) {
      setCepError(erro?.message || 'Não foi possível consultar o CEP');
    } finally {
      setBuscandoCep(false);
    }
  };

  const limparEndereco = () => {
    setCepInput('');
    setEnderecoCep(null);
    setCobertura(null);
    setCepError('');
    setNumero('');
    setComplemento('');
    setLogradouroManual('');
    setModalForaArea(false);
    updateFormData({ address: '' });
  };

  // Mantém o endereço do pedido sempre montado a partir do CEP + número.
  useEffect(() => {
    if (!enderecoCep || !cobertura?.atendido) return;
    updateFormData({
      address: montarEnderecoCompleto({
        logradouro: enderecoCep.logradouro || logradouroManual,
        numero,
        complemento,
        bairro: enderecoCep.bairro,
        cidade: enderecoCep.cidade,
        uf: enderecoCep.uf,
        cep: enderecoCep.cep,
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enderecoCep, cobertura, numero, complemento, logradouroManual]);


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
    // 🚚 ÁREA DE ENTREGA — sem CEP válido e dentro da área, não finaliza.
    if (!enderecoCep) {
      newErrors.cep = 'Informe o CEP de entrega';
    } else if (!cobertura?.atendido) {
      newErrors.cep = `Ainda não entregamos em ${enderecoCep.cidade}/${enderecoCep.uf}`;
    } else if (!numero.trim()) {
      newErrors.numero = 'Informe o número';
    } else if (!enderecoCep.logradouro && !logradouroManual.trim()) {
      newErrors.logradouro = 'Informe a rua e o bairro';
    }
    if (!formData.address.trim()) newErrors.address = 'Endereço é obrigatório';
    if (formData.email && formData.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Email inválido';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // 🚚 Trava dupla: mesmo que algo escape da validação, endereço fora da área
    // não vira pedido — reabre o popup e para aqui.
    if (foraDaArea) {
      setModalForaArea(true);
      return;
    }

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
        {/* VIGIA CUPOM: cupom/indicacao logo acima do resumo, com botao Aplicar */}
        <div className="bg-white rounded-xl p-4 mb-4 shadow-sm">
          <label htmlFor="campo-cupom" className="block text-sm font-semibold text-gray-700 mb-2">
            Cupom ou código de indicação (opcional)
          </label>
          <div className="flex gap-2">
            <input
              id="campo-cupom"
              value={code}
              onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); aplicarCodigo(); } }}
              placeholder="Ex.: HONEST8 ou INDXXXXXX"
              className="flex-1 min-w-0 border-2 border-gray-200 rounded-lg px-3 py-2 text-sm uppercase focus:border-rose-400 focus:outline-none"
              data-testid="input-cupom"
            />
            <button
              type="button"
              onClick={aplicarCodigo}
              disabled={codeChecking || !String(code || '').trim()}
              className="shrink-0 bg-rose-500 hover:bg-rose-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold px-5 py-2 rounded-lg text-sm transition-all active:scale-95"
              data-testid="btn-aplicar-cupom"
            >
              {codeChecking ? 'Validando...' : 'Aplicar'}
            </button>
          </div>
          {codePreview && (
            <p
              className={`text-sm mt-2 flex items-start gap-1 ${codePreview.ok ? 'text-green-700' : 'text-red-600'}`}
              data-testid="msg-cupom"
            >
              <span>{codePreview.ok ? '✓' : '✕'}</span>
              <span>
                {codePreview.msg}
                {codePreview.ok && codePreview.discount ? ` Você economiza R$ ${codePreview.discount.toFixed(2)}.` : ''}
              </span>
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">
            Vale um desconto por pedido — o cupom tem prioridade sobre a indicação. Novo cliente ganha 15% no 1º pedido
            com o código de quem indicou; se você já indicou alguém, o desconto entra sozinho.
          </p>
        </div>

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
            {codePreview?.ok && codePreview.discount ? (
              <>
                <div className="border-t pt-2 flex justify-between text-gray-600">
                  <span>Subtotal</span>
                  <span>R$ {total.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-green-700 font-semibold" data-testid="linha-desconto">
                  <span>Desconto ({codePreview.code})</span>
                  <span>− R$ {codePreview.discount.toFixed(2)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between font-bold text-lg">
                  <span>Total:</span>
                  <span className="text-rose-600">R$ {Number(codePreview.total ?? total).toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="border-t pt-2 flex justify-between font-bold text-lg">
                <span>Total:</span>
                <span className="text-rose-600">R$ {total.toFixed(2)}</span>
              </div>
            )}
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

                  {/* 🚚 ENDEREÇO DE ENTREGA POR CEP */}
                  <div>
                    <label className="block text-sm font-medium mb-1">CEP de Entrega *</label>
                    <div className="relative">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={cepInput}
                        onChange={(e) => {
                          const formatado = formatarCep(e.target.value);
                          setCepInput(formatado);
                          setCepError('');
                          if (limparCep(formatado).length === 8) {
                            handleBuscarCep(formatado);
                          } else {
                            setEnderecoCep(null);
                            setCobertura(null);
                          }
                        }}
                        className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                          cepError || errors.cep || foraDaArea ? 'border-red-300' : 'border-gray-200'
                        }`}
                        placeholder="00000-000"
                        maxLength={9}
                        data-testid="input-cep"
                      />
                      {buscandoCep && (
                        <Loader2 className="w-5 h-5 animate-spin text-rose-500 absolute right-4 top-1/2 -translate-y-1/2" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Entregamos em {TEXTO_AREA_ATENDIDA}.
                    </p>
                    {cepError && <p className="text-red-500 text-sm mt-1">{cepError}</p>}
                    {errors.cep && <p className="text-red-500 text-sm mt-1">{errors.cep}</p>}
                  </div>

                  {/* Endereço encontrado + fora de área */}
                  {enderecoCep && cobertura?.atendido && (
                    <>
                      <div className="p-3 bg-green-50 border-2 border-green-300 rounded-xl" data-testid="endereco-encontrado">
                        <p className="text-sm font-semibold text-green-900">
                          ✅ Entregamos no seu endereço — frete grátis!
                        </p>
                        <p className="text-sm text-green-800 mt-1">
                          {enderecoCep.logradouro ? `${enderecoCep.logradouro}, ` : ''}
                          {enderecoCep.bairro ? `${enderecoCep.bairro} — ` : ''}
                          {enderecoCep.cidade}/{enderecoCep.uf}
                        </p>
                        <button
                          type="button"
                          onClick={limparEndereco}
                          className="text-sm text-green-700 hover:text-green-900 underline mt-1"
                        >
                          Trocar CEP
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">Número *</label>
                          <input
                            type="text"
                            value={numero}
                            onChange={(e) => setNumero(e.target.value)}
                            className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                              errors.numero ? 'border-red-300' : 'border-gray-200'
                            }`}
                            placeholder="123"
                            data-testid="input-numero"
                          />
                          {errors.numero && <p className="text-red-500 text-sm mt-1">{errors.numero}</p>}
                        </div>
                        <div className="col-span-2">
                          <label className="block text-sm font-medium mb-1">Complemento</label>
                          <input
                            type="text"
                            value={complemento}
                            onChange={(e) => setComplemento(e.target.value)}
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500"
                            placeholder="Apto 101, Bloco B, ponto de referência"
                            data-testid="input-complemento"
                          />
                        </div>
                      </div>

                      {/* Rua não preenchida pelo ViaCEP (CEP geral de cidade) */}
                      {!enderecoCep.logradouro && (
                        <div>
                          <label className="block text-sm font-medium mb-1">Rua / Bairro *</label>
                          <input
                            type="text"
                            value={logradouroManual}
                            onChange={(e) => setLogradouroManual(e.target.value)}
                            className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                              errors.logradouro ? 'border-red-300' : 'border-gray-200'
                            }`}
                            placeholder="Rua, bairro"
                            data-testid="input-address"
                          />
                          {errors.logradouro && <p className="text-red-500 text-sm mt-1">{errors.logradouro}</p>}
                        </div>
                      )}
                    </>
                  )}

                  {foraDaArea && enderecoCep && (
                    <div className="p-4 bg-red-50 border-2 border-red-300 rounded-xl" data-testid="aviso-fora-area">
                      <p className="text-sm font-bold text-red-800">
                        😔 Ainda não entregamos em {enderecoCep.cidade}/{enderecoCep.uf}
                      </p>
                      <p className="text-sm text-red-700 mt-1">
                        Nossa entrega cobre {TEXTO_AREA_ATENDIDA}.
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <a
                          href={`https://wa.me/${WHATSAPP_HONEST}?text=${encodeURIComponent(
                            `Olá! Meu CEP é ${cepInput} (${enderecoCep.cidade}/${enderecoCep.uf}) e gostaria de saber sobre entrega.`
                          )}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700"
                        >
                          Falar no WhatsApp
                        </a>
                        <button
                          type="button"
                          onClick={limparEndereco}
                          className="px-4 py-2 bg-white border-2 border-red-300 text-red-700 rounded-lg text-sm font-semibold hover:bg-red-100"
                        >
                          Informar outro CEP
                        </button>
                      </div>
                    </div>
                  )}
                  {errors.address && <p className="text-red-500 text-sm mt-1">{errors.address}</p>}
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

                  {customerType === 'pessoa_fisica' && cardEnabled && (
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
                        <div className="text-sm text-gray-600">Pagamento à vista</div>
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
                disabled={isProcessing || foraDaArea}
                className="w-full bg-gradient-to-r from-rose-500 to-pink-500 text-white py-4 rounded-xl font-bold text-lg hover:from-rose-600 hover:to-pink-600 transition-all disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed shadow-lg"
                data-testid="btn-submit-order"
              >
                {isProcessing ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processando...
                  </span>
                ) : foraDaArea ? (
                  'Endereço fora da área de entrega'
                ) : (
                  `Confirmar Pedido - R$ ${total.toFixed(2)}`
                )}
              </button>
            </>
          )}
        </form>
      </div>

      {/* 🚚 POPUP — ENDEREÇO FORA DA ÁREA DE ENTREGA */}
      {modalForaArea && enderecoCep && (
        <div
          className="fixed inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center p-4"
          data-testid="modal-fora-area"
          onClick={() => setModalForaArea(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="text-5xl mb-3">🚚</div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">
                Ainda não entregamos nesse endereço
              </h3>
              <p className="text-gray-700">
                No momento entregamos apenas em <strong>{TEXTO_AREA_ATENDIDA}</strong>.
              </p>
              <p className="text-gray-600 text-sm mt-3">
                O CEP informado é de <strong>{enderecoCep.cidade}/{enderecoCep.uf}</strong>, fora
                da nossa área de cobertura — por isso não é possível finalizar o pedido.
              </p>
              <p className="text-gray-600 text-sm mt-2">
                Fale com a nossa equipe pelo WhatsApp: podemos avaliar a entrega ou indicar um
                revendedor perto de você.
              </p>
            </div>

            <div className="mt-6 space-y-2">
              <a
                href={`https://wa.me/${WHATSAPP_HONEST}?text=${encodeURIComponent(
                  `Olá! Meu CEP é ${cepInput} (${enderecoCep.cidade}/${enderecoCep.uf}) e gostaria de saber sobre entrega.`
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 transition-colors"
                data-testid="btn-whatsapp-fora-area"
              >
                Falar no WhatsApp
              </a>
              <button
                type="button"
                onClick={() => {
                  setModalForaArea(false);
                  limparEndereco();
                }}
                className="w-full py-3 rounded-xl font-bold border-2 border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                data-testid="btn-trocar-cep"
              >
                Informar outro CEP
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
