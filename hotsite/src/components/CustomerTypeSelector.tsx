import { useState } from 'react';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { HonestLogo } from './HonestLogo';
import { ShoppingCart, Store, MapPin, Building2, Check, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../utils/api';

export function CustomerTypeSelector() {
  const {
    category,
    consumerTier,
    resellerLocation,
    companyData,
    consumerData,
    setCategory,
    setConsumerTier,
    setResellerLocation,
    setCompanyData,
    setConsumerData,
    reset,
  } = useCustomerType();

  // Estados para CNPJ (revendedores)
  const [cnpjInput, setCnpjInput] = useState('');
  const [isLoadingCNPJ, setIsLoadingCNPJ] = useState(false);
  const [cnpjError, setCnpjError] = useState('');
  
  // Estados para edição de dados da empresa
  const [editableData, setEditableData] = useState<any>(null);
  const [isEditMode, setIsEditMode] = useState(false);

  // Estados para CPF (consumidores)
  const [cpfInput, setCpfInput] = useState('');
  const [isLoadingCPF, setIsLoadingCPF] = useState(false);
  const [cpfError, setCpfError] = useState('');
  
  // Estados para edição de dados do consumidor
  const [editableConsumerData, setEditableConsumerData] = useState<any>(null);
  const [isConsumerEditMode, setIsConsumerEditMode] = useState(false);

  // Formatar CNPJ
  const formatCNPJ = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 14) {
      return numbers.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return numbers.slice(0, 14).replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  };

  // Validar CNPJ
  const validarCNPJ = (cnpj: string): boolean => {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    
    if (cnpjLimpo.length !== 14) return false;
    
    // Verifica CNPJs inválidos conhecidos
    if (/^(\d)\1{13}$/.test(cnpjLimpo)) return false;
    
    // Validação dos dígitos verificadores
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

  // Formatar CPF
  const formatCPF = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    if (numbers.length <= 11) {
      return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
    }
    return numbers.slice(0, 11).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  };

  // Validar CPF
  const validarCPF = (cpf: string): boolean => {
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    console.log('🔍 Validando CPF:', cpf);
    console.log('🔍 CPF limpo:', cpfLimpo);
    
    if (cpfLimpo.length !== 11) {
      console.log('❌ CPF não tem 11 dígitos');
      return false;
    }
    
    // Verifica CPFs inválidos conhecidos
    if (/^(\d)\1{10}$/.test(cpfLimpo)) {
      console.log('❌ CPF é sequência repetida');
      return false;
    }
    
    // Validação dos dígitos verificadores
    let soma = 0;
    let resto;
    
    for (let i = 1; i <= 9; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (11 - i);
    }
    
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    
    console.log('🔍 Primeiro dígito verificador calculado:', resto);
    console.log('🔍 Primeiro dígito verificador no CPF:', parseInt(cpfLimpo.substring(9, 10)));
    
    if (resto !== parseInt(cpfLimpo.substring(9, 10))) {
      console.log('❌ Primeiro dígito verificador inválido');
      return false;
    }
    
    soma = 0;
    for (let i = 1; i <= 10; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i);
    }
    
    resto = (soma * 10) % 11;
    if (resto === 10 || resto === 11) resto = 0;
    
    console.log('🔍 Segundo dígito verificador calculado:', resto);
    console.log('🔍 Segundo dígito verificador no CPF:', parseInt(cpfLimpo.substring(10, 11)));
    
    if (resto !== parseInt(cpfLimpo.substring(10, 11))) {
      console.log('❌ Segundo dígito verificador inválido');
      return false;
    }
    
    console.log('✅ CPF válido!');
    return true;
  };

  // Buscar dados do CPF (verifica se já existe no sistema)
  const handleConsultarCPF = async () => {
    setCpfError('');
    
    if (!cpfInput) {
      setCpfError('Por favor, informe o CPF');
      return;
    }

    if (!validarCPF(cpfInput)) {
      setCpfError('CPF inválido');
      return;
    }

    setIsLoadingCPF(true);

    try {
      // Verificar se já existe cliente cadastrado com este CPF
      const cpfLimpo = cpfInput.replace(/\D/g, '');
      const checkResult = await api.checkCustomer('', '', cpfLimpo);
      
      if (checkResult.exists && checkResult.name) {
        // Cliente já existe - usar dados cadastrados
        const dados = {
          cpf: cpfInput,
          nome: checkResult.name || '',
          endereco: checkResult.address || '',
          telefone: checkResult.phone || '',
          email: checkResult.email || '',
          existingCustomerId: checkResult.id
        };
        
        setEditableConsumerData(dados);
        setIsConsumerEditMode(false);
      } else {
        // Novo cliente - formulário vazio
        setEditableConsumerData({
          cpf: cpfInput,
          nome: '',
          endereco: '',
          telefone: '',
          email: ''
        });
        setIsConsumerEditMode(true);
      }
    } catch (error: any) {
      setCpfError(error.message || 'Erro ao verificar CPF. Tente novamente.');
    } finally {
      setIsLoadingCPF(false);
    }
  };

  // Confirmar dados do consumidor
  const handleConfirmarDadosConsumidor = () => {
    if (!editableConsumerData) return;
    
    // Validar campos obrigatórios
    if (!editableConsumerData.nome.trim()) {
      setCpfError('Nome é obrigatório');
      return;
    }
    if (!editableConsumerData.endereco.trim()) {
      setCpfError('Endereço é obrigatório');
      return;
    }
    if (!editableConsumerData.telefone.trim()) {
      setCpfError('Telefone é obrigatório');
      return;
    }
    
    setConsumerData(editableConsumerData);
  };

  // Buscar dados do CNPJ
  const handleConsultarCNPJ = async () => {
    setCnpjError('');
    
    if (!cnpjInput) {
      setCnpjError('Por favor, informe o CNPJ');
      return;
    }

    if (!validarCNPJ(cnpjInput)) {
      setCnpjError('CNPJ inválido');
      return;
    }

    setIsLoadingCNPJ(true);

    try {
      // Primeiro verifica se já existe cliente cadastrado
      const checkResult = await api.checkCustomerByCNPJ(cnpjInput);
      
      if (checkResult.exists && checkResult.customer) {
        // Cliente já existe - usar dados cadastrados
        const customer = checkResult.customer;
        const dados = {
          cnpj: customer.cnpj,
          razaoSocial: customer.companyName,
          nomeFantasia: customer.fantasyName || customer.companyName,
          endereco: customer.address || '',
          cidade: customer.city || '',
          estado: customer.state || '',
          cep: customer.zipCode || '',
          telefone: customer.phone || '',
          email: customer.email || '',
          existingCustomerId: customer.id
        };
        
        setEditableData(dados);
        setIsEditMode(false);
      } else {
        // Buscar na Receita Federal
        const dados = await api.consultarCNPJ(cnpjInput);
        
        if (dados.situacao !== 'ATIVA') {
          setCnpjError(`Este CNPJ está com situação: ${dados.situacao}. Por favor, verifique.`);
          setIsLoadingCNPJ(false);
          return;
        }
        
        setEditableData({
          cnpj: dados.cnpj,
          razaoSocial: dados.razaoSocial,
          nomeFantasia: dados.nomeFantasia || dados.razaoSocial,
          endereco: dados.endereco,
          cidade: dados.cidade,
          estado: dados.estado,
          cep: dados.cep,
          telefone: dados.telefone || '',
          email: dados.email || ''
        });
        setIsEditMode(false);
      }
    } catch (error: any) {
      setCnpjError(error.message || 'Erro ao consultar CNPJ. Tente novamente.');
    } finally {
      setIsLoadingCNPJ(false);
    }
  };

  // Confirmar dados da empresa
  const handleConfirmarDados = () => {
    if (!editableData) return;
    setCompanyData(editableData);
  };

  if (category === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" />
            </div>
            <h1 className="text-4xl font-bold text-green-800 mb-3">
              Bem-vindo! 🌿
            </h1>
            <p className="text-lg text-gray-700">
              Selecione como deseja comprar nossos produtos
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setCategory('consumer')}
              className="bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-consumer"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-10 h-10 text-green-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Consumidor
                </h2>
                <p className="text-gray-600">
                  Compre para consumo próprio ou sua família
                </p>
              </div>
            </button>

            <button
              onClick={() => setCategory('reseller')}
              className="bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-reseller"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
                  <Store className="w-10 h-10 text-emerald-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Revenda
                </h2>
                <p className="text-gray-600">
                  Compre para revender em seu estabelecimento
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (category === 'consumer' && consumerTier === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back"
          >
            ← Voltar
          </button>

          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" />
            </div>
            <h1 className="text-4xl font-bold text-green-800 mb-3">
              Como deseja comprar?
            </h1>
            <p className="text-lg text-gray-700">
              Escolha a melhor opção para você
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setConsumerTier('retail')}
              className="bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-retail"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-10 h-10 text-blue-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Varejo
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras abaixo de R$ 200,00
                </p>
                <div className="text-sm text-blue-600 font-semibold">
                  Preços regulares
                </div>
              </div>
            </button>

            <button
              onClick={() => setConsumerTier('wholesale')}
              className="bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-wholesale"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-10 h-10 text-purple-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Atacado
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras acima de R$ 200,00
                </p>
                <div className="text-sm text-purple-600 font-semibold">
                  Preços especiais
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Tela de captura de CPF (após selecionar tier de consumidor)
  if (category === 'consumer' && consumerTier !== null && !editableConsumerData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <button
            onClick={() => {
              setCategory('consumer');
              setConsumerData(null);
              setEditableConsumerData(null);
              setCpfInput('');
              setCpfError('');
            }}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back-cpf"
          >
            ← Voltar
          </button>

          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                <ShoppingCart className="w-10 h-10 text-green-600" />
              </div>
            </div>

            <h1 className="text-3xl font-bold text-green-800 text-center mb-3">
              Informe seu CPF
            </h1>
            <p className="text-gray-600 text-center mb-8">
              Vamos verificar se você já é nosso cliente
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  CPF
                </label>
                <input
                  type="text"
                  value={cpfInput}
                  onChange={(e) => {
                    setCpfInput(formatCPF(e.target.value));
                    setCpfError('');
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      handleConsultarCPF();
                    }
                  }}
                  placeholder="000.000.000-00"
                  className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 transition-all ${
                    cpfError 
                      ? 'border-red-300 focus:ring-red-500' 
                      : 'border-gray-200 focus:ring-green-500'
                  }`}
                  maxLength={14}
                  data-testid="input-cpf"
                  disabled={isLoadingCPF}
                />
                {cpfError && (
                  <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{cpfError}</span>
                  </div>
                )}
              </div>

              <button
                onClick={handleConsultarCPF}
                disabled={isLoadingCPF || !cpfInput}
                className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                data-testid="button-consultar-cpf"
              >
                {isLoadingCPF ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Verificando...
                  </>
                ) : (
                  'Continuar'
                )}
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-50 rounded-xl">
              <p className="text-sm text-blue-800">
                <strong>ℹ️ Informação:</strong> Se você já for cliente, vamos preencher 
                seus dados automaticamente para agilizar sua compra.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Tela de confirmação/edição de dados do consumidor
  if (category === 'consumer' && editableConsumerData && !consumerData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <button
            onClick={() => {
              setEditableConsumerData(null);
              setConsumerData(null);
              setCpfInput('');
              setCpfError('');
            }}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back-edit-consumer"
          >
            ← Voltar
          </button>

          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-10 h-10 text-green-600" />
              </div>
            </div>

            <h1 className="text-3xl font-bold text-green-800 text-center mb-2">
              {editableConsumerData.existingCustomerId ? 'Bem-vindo de volta!' : 'Confirme seus dados'}
            </h1>
            <p className="text-gray-600 text-center mb-8">
              {editableConsumerData.existingCustomerId 
                ? 'Encontramos seu cadastro em nosso sistema' 
                : 'Preencha seus dados para continuar'}
            </p>

            {editableConsumerData.existingCustomerId && (
              <div className="mb-6 p-4 bg-green-50 border-2 border-green-200 rounded-xl">
                <p className="text-sm text-green-800 text-center">
                  ✅ Cliente já cadastrado! Você pode editar os dados se necessário.
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  CPF
                </label>
                <input
                  type="text"
                  value={editableConsumerData.cpf}
                  disabled
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl bg-gray-50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Nome Completo {isConsumerEditMode && <span className="text-red-500">*</span>}
                </label>
                <input
                  type="text"
                  value={editableConsumerData.nome}
                  onChange={(e) => setEditableConsumerData({ ...editableConsumerData, nome: e.target.value })}
                  disabled={!isConsumerEditMode}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                  data-testid="input-nome"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Endereço {isConsumerEditMode && <span className="text-red-500">*</span>}
                </label>
                <input
                  type="text"
                  value={editableConsumerData.endereco}
                  onChange={(e) => setEditableConsumerData({ ...editableConsumerData, endereco: e.target.value })}
                  disabled={!isConsumerEditMode}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                  data-testid="input-endereco-consumer"
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Telefone {isConsumerEditMode && <span className="text-red-500">*</span>}
                  </label>
                  <input
                    type="text"
                    value={editableConsumerData.telefone}
                    onChange={(e) => setEditableConsumerData({ ...editableConsumerData, telefone: e.target.value })}
                    disabled={!isConsumerEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-telefone-consumer"
                    placeholder="(00) 00000-0000"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Email (opcional)
                  </label>
                  <input
                    type="email"
                    value={editableConsumerData.email}
                    onChange={(e) => setEditableConsumerData({ ...editableConsumerData, email: e.target.value })}
                    disabled={!isConsumerEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-email-consumer"
                  />
                </div>
              </div>

              {!editableConsumerData.existingCustomerId && (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
                  <p className="text-sm text-yellow-800">
                    <strong>📝 Novo cliente:</strong> Preencha todos os campos obrigatórios (*) para continuar.
                  </p>
                </div>
              )}

              {cpfError && (
                <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{cpfError}</span>
                </div>
              )}

              <div className="flex gap-4">
                {editableConsumerData.existingCustomerId && !isConsumerEditMode && (
                  <button
                    onClick={() => setIsConsumerEditMode(true)}
                    className="flex-1 bg-gray-200 text-gray-800 py-3 rounded-xl font-semibold hover:bg-gray-300 transition-colors"
                    data-testid="button-editar"
                  >
                    Editar Dados
                  </button>
                )}
                <button
                  onClick={handleConfirmarDadosConsumidor}
                  className="flex-1 bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors flex items-center justify-center gap-2"
                  data-testid="button-confirmar-consumidor"
                >
                  <Check className="w-5 h-5" />
                  Confirmar e Continuar
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (category === 'reseller' && resellerLocation === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-3xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back"
          >
            ← Voltar
          </button>

          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" />
            </div>
            <h1 className="text-4xl font-bold text-green-800 mb-3">
              Onde sua revenda está localizada?
            </h1>
            <p className="text-lg text-gray-700">
              Temos preços especiais por região
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <button
              onClick={() => setResellerLocation('goiania')}
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-goiania"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
                  <MapPin className="w-8 h-8 text-amber-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">
                  Goiânia
                </h2>
                <p className="text-sm text-gray-600">
                  Capital de Goiás
                </p>
              </div>
            </button>

            <button
              onClick={() => setResellerLocation('interior')}
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-interior"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-teal-100 rounded-full flex items-center justify-center mb-4">
                  <MapPin className="w-8 h-8 text-teal-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">
                  Interior de Goiás
                </h2>
                <p className="text-sm text-gray-600">
                  Cidades do interior
                </p>
              </div>
            </button>

            <button
              onClick={() => setResellerLocation('brasilia')}
              className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all transform hover:scale-105 border-2 border-transparent hover:border-green-500"
              data-testid="button-select-brasilia"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mb-4">
                  <MapPin className="w-8 h-8 text-indigo-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">
                  Brasília e Entorno
                </h2>
                <p className="text-sm text-gray-600">
                  DF e entorno de Goiás
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Tela de captura de CNPJ (após selecionar localização)
  if (category === 'reseller' && resellerLocation !== null && !editableData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <button
            onClick={() => {
              setResellerLocation(null);
              setCompanyData(null);
              setEditableData(null);
              setCnpjInput('');
              setCnpjError('');
            }}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back-cnpj"
          >
            ← Voltar
          </button>

          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                <Building2 className="w-10 h-10 text-green-600" />
              </div>
            </div>

            <h1 className="text-3xl font-bold text-green-800 text-center mb-3">
              Informe seu CNPJ
            </h1>
            <p className="text-gray-600 text-center mb-8">
              Vamos buscar os dados da sua empresa
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  CNPJ da Empresa
                </label>
                <input
                  type="text"
                  value={cnpjInput}
                  onChange={(e) => {
                    setCnpjInput(formatCNPJ(e.target.value));
                    setCnpjError('');
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      handleConsultarCNPJ();
                    }
                  }}
                  placeholder="00.000.000/0000-00"
                  className={`w-full px-4 py-3 border-2 rounded-xl focus:outline-none focus:ring-2 transition-all ${
                    cnpjError 
                      ? 'border-red-300 focus:ring-red-500' 
                      : 'border-gray-200 focus:ring-green-500'
                  }`}
                  maxLength={18}
                  data-testid="input-cnpj"
                  disabled={isLoadingCNPJ}
                />
                {cnpjError && (
                  <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>{cnpjError}</span>
                  </div>
                )}
              </div>

              <button
                onClick={handleConsultarCNPJ}
                disabled={isLoadingCNPJ || !cnpjInput}
                className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                data-testid="button-consultar-cnpj"
              >
                {isLoadingCNPJ ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Consultando...
                  </>
                ) : (
                  'Consultar CNPJ'
                )}
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-50 rounded-xl">
              <p className="text-sm text-blue-800">
                <strong>ℹ️ Importante:</strong> Vamos consultar seus dados na Receita Federal 
                para agilizar seu cadastro.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Tela de confirmação/edição de dados da empresa
  if (category === 'reseller' && editableData && !companyData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <button
            onClick={() => {
              setEditableData(null);
              setCompanyData(null);
              setCnpjInput('');
              setCnpjError('');
            }}
            className="mb-6 text-green-700 hover:text-green-900 font-medium"
            data-testid="button-back-edit"
          >
            ← Voltar
          </button>

          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-10 h-10 text-green-600" />
              </div>
            </div>

            <h1 className="text-3xl font-bold text-green-800 text-center mb-2">
              {editableData.existingCustomerId ? 'Bem-vindo de volta!' : 'Confirme seus dados'}
            </h1>
            <p className="text-gray-600 text-center mb-8">
              {editableData.existingCustomerId 
                ? 'Encontramos seu cadastro em nosso sistema' 
                : 'Verifique se os dados estão corretos'}
            </p>

            {editableData.existingCustomerId && (
              <div className="mb-6 p-4 bg-green-50 border-2 border-green-200 rounded-xl">
                <p className="text-sm text-green-800 text-center">
                  ✅ Cliente já cadastrado! Você pode prosseguir para o catálogo.
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    CNPJ
                  </label>
                  <input
                    type="text"
                    value={editableData.cnpj}
                    disabled
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl bg-gray-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Razão Social
                  </label>
                  <input
                    type="text"
                    value={editableData.razaoSocial}
                    onChange={(e) => setEditableData({ ...editableData, razaoSocial: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-razao-social"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Nome Fantasia
                </label>
                <input
                  type="text"
                  value={editableData.nomeFantasia}
                  onChange={(e) => setEditableData({ ...editableData, nomeFantasia: e.target.value })}
                  disabled={!isEditMode}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                  data-testid="input-nome-fantasia"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Endereço {isEditMode && <span className="text-red-500">*</span>}
                </label>
                <input
                  type="text"
                  value={editableData.endereco}
                  onChange={(e) => setEditableData({ ...editableData, endereco: e.target.value })}
                  disabled={!isEditMode}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                  data-testid="input-endereco"
                />
              </div>

              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Cidade
                  </label>
                  <input
                    type="text"
                    value={editableData.cidade}
                    onChange={(e) => setEditableData({ ...editableData, cidade: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-cidade"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Estado
                  </label>
                  <input
                    type="text"
                    value={editableData.estado}
                    onChange={(e) => setEditableData({ ...editableData, estado: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    maxLength={2}
                    data-testid="input-estado"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    CEP
                  </label>
                  <input
                    type="text"
                    value={editableData.cep}
                    onChange={(e) => setEditableData({ ...editableData, cep: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-cep"
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Telefone
                  </label>
                  <input
                    type="text"
                    value={editableData.telefone}
                    onChange={(e) => setEditableData({ ...editableData, telefone: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-telefone"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    E-mail
                  </label>
                  <input
                    type="email"
                    value={editableData.email}
                    onChange={(e) => setEditableData({ ...editableData, email: e.target.value })}
                    disabled={!isEditMode}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-50"
                    data-testid="input-email"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                {!isEditMode ? (
                  <>
                    <button
                      onClick={() => setIsEditMode(true)}
                      className="flex-1 bg-gray-600 text-white py-3 rounded-xl font-semibold hover:bg-gray-700 transition-colors"
                      data-testid="button-editar"
                    >
                      Editar Dados
                    </button>
                    <button
                      onClick={handleConfirmarDados}
                      className="flex-1 bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors"
                      data-testid="button-confirmar"
                    >
                      Confirmar e Continuar
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setIsEditMode(false)}
                      className="flex-1 bg-gray-600 text-white py-3 rounded-xl font-semibold hover:bg-gray-700 transition-colors"
                      data-testid="button-cancelar-edicao"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => {
                        setIsEditMode(false);
                        handleConfirmarDados();
                      }}
                      className="flex-1 bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 transition-colors"
                      data-testid="button-salvar"
                    >
                      Salvar e Continuar
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
