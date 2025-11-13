import { useCustomerType } from '../contexts/CustomerTypeContext';
import { HonestLogo } from './HonestLogo';
import { ShoppingCart, Store, MapPin } from 'lucide-react';

export function CustomerTypeSelector() {
  const {
    category,
    consumerTier,
    resellerLocation,
    setCategory,
    setConsumerTier,
    setResellerLocation,
    reset,
  } = useCustomerType();

  // Tela inicial: Escolher entre Consumidor ou Revendedor
  if (category === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-500 to-pink-400 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" className="text-white drop-shadow-lg" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-3 drop-shadow-md">
              Bem-vindo! 🍓
            </h1>
            <p className="text-xl text-white/90 drop-shadow">
              Como deseja comprar?
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setCategory('consumer')}
              className="bg-white rounded-2xl p-8 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-rose-400"
              data-testid="button-select-consumer"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-rose-100 to-pink-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <ShoppingCart className="w-12 h-12 text-rose-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Consumidor
                </h2>
                <p className="text-gray-600">
                  Compre para consumo próprio ou família
                </p>
              </div>
            </button>

            <button
              onClick={() => setCategory('reseller')}
              className="bg-white rounded-2xl p-8 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-rose-400"
              data-testid="button-select-reseller"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-emerald-100 to-green-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <Store className="w-12 h-12 text-emerald-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Revendedor
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

  // Tela para Consumidores: Escolher Varejo ou Atacado
  if (category === 'consumer' && consumerTier === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-500 to-pink-400 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-white hover:text-white/80 font-semibold flex items-center gap-2 transition-all"
            data-testid="button-back"
          >
            ← Voltar
          </button>

          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" className="text-white drop-shadow-lg" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-3 drop-shadow-md">
              Escolha sua opção
            </h1>
            <p className="text-xl text-white/90 drop-shadow">
              Selecione o tipo de compra
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setConsumerTier('retail')}
              className="bg-white rounded-2xl p-8 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-blue-400"
              data-testid="button-select-retail"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <ShoppingCart className="w-12 h-12 text-blue-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Varejo
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras até R$ 200
                </p>
                <div className="text-sm text-blue-600 font-semibold">
                  Preços regulares
                </div>
              </div>
            </button>

            <button
              onClick={() => setConsumerTier('wholesale')}
              className="bg-white rounded-2xl p-8 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-purple-400"
              data-testid="button-select-wholesale"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-purple-100 to-pink-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <ShoppingCart className="w-12 h-12 text-purple-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">
                  Atacado
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras acima de R$ 200
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

  // Tela para Revendedores: Escolher Localização
  if (category === 'reseller' && resellerLocation === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-500 to-pink-400 flex items-center justify-center p-4">
        <div className="max-w-3xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-white hover:text-white/80 font-semibold flex items-center gap-2 transition-all"
            data-testid="button-back-reseller"
          >
            ← Voltar
          </button>

          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" className="text-white drop-shadow-lg" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-3 drop-shadow-md">
              Onde está seu negócio?
            </h1>
            <p className="text-xl text-white/90 drop-shadow">
              Selecione sua região para ver preços especiais
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setResellerLocation('goiania')}
              className="bg-white rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-emerald-400"
              data-testid="button-select-goiania"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-gradient-to-br from-emerald-100 to-green-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <MapPin className="w-10 h-10 text-emerald-600" />
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
              className="bg-white rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all transform hover:scale-105 border-4 border-transparent hover:border-emerald-400"
              data-testid="button-select-interior"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-gradient-to-br from-amber-100 to-yellow-100 rounded-full flex items-center justify-center mb-4 shadow-inner">
                  <MapPin className="w-10 h-10 text-amber-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">
                  Interior
                </h2>
                <p className="text-sm text-gray-600">
                  Cidades do interior de Goiás
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Se chegou aqui, a seleção está completa
  return null;
}
