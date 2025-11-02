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

  if (category === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-12">
            <div className="flex justify-center mb-6">
              <HonestLogo size="xl" showText={true} />
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
              <HonestLogo size="lg" showText={true} />
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
                  Desconto de 10%
                </div>
              </div>
            </button>
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
              <HonestLogo size="lg" showText={true} />
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

  return null;
}
