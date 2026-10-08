import { useCustomerType } from '../contexts/CustomerTypeContext';
import { garrafaUrl } from '../utils/garrafas';
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
      <div className="min-h-screen bg-honest-forest flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-8 md:mb-12">
            <div className="flex justify-center mb-6">
              <img src="/shop/honest-logo-white.png" alt="Honest Sucos" className="h-24 w-auto" />
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-extrabold text-white mb-3">
              Bem-vindo à Honest
            </h1>
            <p className="text-lg text-white/80">
              Como deseja comprar?
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setCategory('consumer')}
              className="bg-white rounded-[28px] p-6 md:p-8 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-consumer"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 md:w-24 md:h-24 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-8 h-8 md:w-12 md:h-12 text-honest-forest" />
                </div>
                <h2 className="font-display text-2xl font-bold text-honest-ink mb-2">
                  Consumidor
                </h2>
                <p className="text-gray-600">
                  Compre para consumo próprio ou família
                </p>
              </div>
            </button>

            <button
              onClick={() => setCategory('reseller')}
              className="bg-white rounded-[28px] p-6 md:p-8 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-reseller"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 md:w-24 md:h-24 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <Store className="w-8 h-8 md:w-12 md:h-12 text-honest-forest" />
                </div>
                <h2 className="font-display text-2xl font-bold text-honest-ink mb-2">
                  Revendedor
                </h2>
                <p className="text-gray-600">
                  Compre para revender em seu estabelecimento
                </p>
              </div>
            </button>
          </div>

          <div className="mt-12 flex items-end justify-center gap-6 md:gap-10" aria-hidden="true">
            {['acerola', 'pink-lemonade', 'uva', 'maracuja'].map((k, i) => (
              <img
                key={k}
                src={garrafaUrl(k, '350')}
                alt=""
                className="garrafa-sobe garrafa-sombra h-28 md:h-36 w-auto"
                style={{ animationDelay: `${100 + i * 100}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Tela para Consumidores: Escolher Varejo ou Atacado
  if (category === 'consumer' && consumerTier === null) {
    return (
      <div className="min-h-screen bg-honest-forest flex items-center justify-center p-4">
        <div className="max-w-2xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-white/80 hover:text-white font-semibold flex items-center gap-2 transition-all"
            data-testid="button-back"
          >
            ← Voltar
          </button>

          <div className="text-center mb-8 md:mb-12">
            <div className="flex justify-center mb-6">
              <img src="/shop/honest-logo-white.png" alt="Honest Sucos" className="h-24 w-auto" />
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-extrabold text-white mb-3">
              Escolha sua opção
            </h1>
            <p className="text-lg text-white/80">
              Selecione o tipo de compra
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setConsumerTier('retail')}
              className="bg-white rounded-[28px] p-6 md:p-8 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-retail"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 md:w-24 md:h-24 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-8 h-8 md:w-12 md:h-12 text-honest-forest" />
                </div>
                <h2 className="font-display text-2xl font-bold text-honest-ink mb-2">
                  Varejo
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras até R$ 200
                </p>
                <div className="text-sm text-honest-forest font-semibold">
                  Preços regulares
                </div>
              </div>
            </button>

            <button
              onClick={() => setConsumerTier('wholesale')}
              className="bg-white rounded-[28px] p-6 md:p-8 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-wholesale"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-16 h-16 md:w-24 md:h-24 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <ShoppingCart className="w-8 h-8 md:w-12 md:h-12 text-honest-forest" />
                </div>
                <h2 className="font-display text-2xl font-bold text-honest-ink mb-2">
                  Atacado
                </h2>
                <p className="text-gray-600 mb-3">
                  Compras acima de R$ 200
                </p>
                <div className="text-sm text-honest-forest font-semibold">
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
      <div className="min-h-screen bg-honest-forest flex items-center justify-center p-4">
        <div className="max-w-3xl w-full">
          <button
            onClick={reset}
            className="mb-6 text-white/80 hover:text-white font-semibold flex items-center gap-2 transition-all"
            data-testid="button-back-reseller"
          >
            ← Voltar
          </button>

          <div className="text-center mb-8 md:mb-12">
            <div className="flex justify-center mb-6">
              <img src="/shop/honest-logo-white.png" alt="Honest Sucos" className="h-24 w-auto" />
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-extrabold text-white mb-3">
              Onde está seu negócio?
            </h1>
            <p className="text-lg text-white/80">
              Selecione sua região para ver preços especiais
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setResellerLocation('goiania')}
              className="bg-white rounded-[28px] p-6 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-goiania"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <MapPin className="w-10 h-10 text-honest-forest" />
                </div>
                <h2 className="font-display text-xl font-bold text-honest-ink mb-2">
                  Goiânia
                </h2>
                <p className="text-sm text-gray-600">
                  Capital de Goiás
                </p>
              </div>
            </button>

            <button
              onClick={() => setResellerLocation('interior')}
              className="bg-white rounded-[28px] p-6 transition-colors border-4 border-transparent hover:border-honest-leaf focus-visible:border-honest-leaf"
              data-testid="button-select-interior"
            >
              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-honest-light rounded-full flex items-center justify-center mb-4">
                  <MapPin className="w-10 h-10 text-honest-forest" />
                </div>
                <h2 className="font-display text-xl font-bold text-honest-ink mb-2">
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
