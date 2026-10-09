import { useEffect, useState, type ReactNode } from 'react';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { ShoppingCart, Store, MapPin, Package, ChevronRight, ChevronLeft } from 'lucide-react';

// 🌿 Tela de entrada (out/2026): foto de produto de um lado, escolhas do outro.
// As três etapas (tipo de cliente → varejo/atacado → região) usam a mesma moldura;
// só a foto, o título e as opções mudam. A lógica de escolha é a mesma de antes.

function Moldura({
  foto, fotoAlt, titulo, subtitulo, voltar, voltarTestId, children,
}: {
  foto: string;
  fotoAlt: string;
  titulo: string;
  subtitulo: string;
  voltar?: () => void;
  voltarTestId?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-honest-paper lg:grid lg:grid-cols-2">
      {/* Foto */}
      <div className="relative h-[38vh] min-h-[260px] lg:h-auto lg:min-h-screen overflow-hidden bg-honest-forest">
        <img
          src={foto}
          alt={fotoAlt}
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-honest-forest/70 via-transparent to-honest-forest/40 lg:bg-gradient-to-r lg:from-honest-forest/50 lg:via-transparent lg:to-transparent" />
        <img
          src="/shop/honest-logo-white.png"
          alt="Honest Sucos"
          className="absolute top-5 left-5 lg:top-10 lg:left-10 h-16 lg:h-24 w-auto drop-shadow"
        />
      </div>

      {/* Escolhas */}
      <div className="relative -mt-8 lg:mt-0 rounded-t-[28px] lg:rounded-none bg-honest-paper flex items-start lg:items-center">
        <div className="w-full max-w-lg mx-auto px-5 pt-8 pb-12 lg:px-12 lg:py-16">
          {voltar && (
            <button
              onClick={voltar}
              className="mb-6 -ml-2 inline-flex items-center gap-1 text-honest-forest font-semibold px-2 py-1 rounded-full hover:bg-white transition-colors"
              data-testid={voltarTestId}
            >
              <ChevronLeft className="w-5 h-5" aria-hidden="true" /> Voltar
            </button>
          )}
          <h1 className="font-display text-4xl md:text-5xl font-extrabold text-honest-ink leading-[1.02]">
            {titulo}
          </h1>
          <p className="text-lg text-gray-600 mt-3">{subtitulo}</p>

          <div className="mt-8 space-y-3">{children}</div>

          <p className="mt-10 text-sm text-gray-500">
            100% suco, sem adição de açúcares. Feito em Bela Vista de Goiás.
          </p>
        </div>
      </div>
    </div>
  );
}

function Opcao({
  icone: Icone, titulo, descricao, detalhe, onClick, testId,
}: {
  icone: typeof ShoppingCart;
  titulo: string;
  descricao: string;
  detalhe?: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group w-full text-left bg-white rounded-3xl p-5 flex items-center gap-4 ring-1 ring-black/5 hover:ring-2 hover:ring-honest-green focus-visible:ring-2 focus-visible:ring-honest-green transition-shadow"
      data-testid={testId}
    >
      <span className="w-14 h-14 shrink-0 rounded-2xl bg-honest-light text-honest-forest flex items-center justify-center">
        <Icone className="w-7 h-7" aria-hidden="true" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-display text-lg sm:text-xl font-bold text-honest-ink leading-tight">{titulo}</span>
        <span className="block text-gray-600 text-sm mt-0.5">{descricao}</span>
        {detalhe && <span className="block text-honest-green text-sm font-semibold mt-1">{detalhe}</span>}
      </span>
      <ChevronRight className="w-6 h-6 text-gray-400 group-hover:text-honest-green group-hover:translate-x-0.5 transition-all shrink-0" aria-hidden="true" />
    </button>
  );
}

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

  // 🔒 O limite entre varejo e atacado é o MESMO valor da trava do pedido mínimo do
  // atacado (Canais > Hotsite > Configurações). Lido do servidor para o texto nunca
  // divergir da trava; se a consulta falhar, usa o padrão.
  const [limiteAtacado, setLimiteAtacado] = useState(200);
  const [minVarejo, setMinVarejo] = useState(80);
  useEffect(() => {
    let vivo = true;
    fetch('/api/public/canais/minimos')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        const a = Number(cfg?.consumidor?.atacado);
        if (vivo && Number.isFinite(a) && a > 0) setLimiteAtacado(a);
        const v = Number(cfg?.consumidor?.varejo);
        if (vivo && Number.isFinite(v) && v > 0) setMinVarejo(v);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);
  const reais = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: n % 1 ? 2 : 0 });
  const limiteTxt = reais(limiteAtacado);

  // Etapa 1: Consumidor ou Revendedor
  if (category === null) {
    return (
      <Moldura
        foto="/shop/images/cenas/acerola-pomar.webp"
        fotoAlt="Suco Honest de acerola numa mesa de madeira, com aceroleira ao fundo"
        titulo="Bem-vindo à Honest"
        subtitulo="Como você quer comprar?"
      >
        <Opcao
          icone={ShoppingCart}
          titulo="Para mim ou minha família"
          descricao="Compra de consumidor, entregue em casa"
          onClick={() => setCategory('consumer')}
          testId="button-select-consumer"
        />
        <Opcao
          icone={Store}
          titulo="Para revender"
          descricao="Para o seu mercado, empório, academia ou lanchonete"
          onClick={() => setCategory('reseller')}
          testId="button-select-reseller"
        />
      </Moldura>
    );
  }

  // Etapa 2 (consumidor): Varejo ou Atacado
  if (category === 'consumer' && consumerTier === null) {
    return (
      <Moldura
        foto="/shop/images/cenas/morango-maracuja-cozinha.webp"
        fotoAlt="Suco Honest de morango com maracujá na mesa da cozinha"
        titulo="Qual o tamanho do pedido?"
        subtitulo="O preço muda conforme o volume."
        voltar={reset}
        voltarTestId="button-back"
      >
        <Opcao
          icone={ShoppingCart}
          titulo="Varejo"
          descricao={`Compras abaixo de ${limiteTxt} · pedido mínimo de ${reais(minVarejo)}`}
          detalhe="Preços regulares"
          onClick={() => setConsumerTier('retail')}
          testId="button-select-retail"
        />
        <Opcao
          icone={Package}
          titulo="Atacado"
          descricao={`Compras a partir de ${limiteTxt}`}
          detalhe="Preços especiais"
          onClick={() => setConsumerTier('wholesale')}
          testId="button-select-wholesale"
        />
      </Moldura>
    );
  }

  // Etapa 2 (revendedor): Região
  if (category === 'reseller' && resellerLocation === null) {
    return (
      <Moldura
        foto="/shop/images/cenas/pink-lemonade-splash.webp"
        fotoAlt="Suco Honest pink lemonade com framboesas e limão"
        titulo="Onde está o seu negócio?"
        subtitulo="Os preços de revenda variam por região."
        voltar={reset}
        voltarTestId="button-back-reseller"
      >
        <Opcao
          icone={MapPin}
          titulo="Goiânia"
          descricao="Capital de Goiás"
          onClick={() => setResellerLocation('goiania')}
          testId="button-select-goiania"
        />
        <Opcao
          icone={MapPin}
          titulo="Interior"
          descricao="Cidades do interior de Goiás"
          onClick={() => setResellerLocation('interior')}
          testId="button-select-interior"
        />
      </Moldura>
    );
  }

  // Se chegou aqui, a seleção está completa
  return null;
}
