import { useState } from 'react';
import type { Product } from '../types';
import ImageGallery from './ImageGallery';
import ProductReviews from './ProductReviews';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { getProductPrice } from '../utils/pricing';
import { pixel } from '../utils/pixel';
import { X, Plus } from 'lucide-react';
import { type GrupoSabor, garrafaUrl, brl, FOTOS } from '../utils/garrafas';

interface ProductCardProps {
  grupo: GrupoSabor;
  onAddToCart: (product: Product) => void;
}

// 🍾 Cartão por SABOR (out/2026): 350 ml e 900 ml no mesmo cartão, com a garrafa
// oficial sobre a cor do rótulo. O que vai para o carrinho continua sendo o PRODUTO
// do cadastro (id, nome e preço da tabela do visitante) — só a vitrine mudou.
export default function ProductCard({ grupo, onAddToCart }: ProductCardProps) {
  const { priceTable } = useCustomerType();
  const [idx, setIdx] = useState(0);
  const [showDetails, setShowDetails] = useState(false);

  const variante = grupo.variantes[Math.min(idx, grupo.variantes.length - 1)];
  const product = variante.produto;
  const sabor = grupo.sabor;
  const displayPrice = getProductPrice(product, priceTable);

  // DISPONIBILIDADE (set/2026): o produto continua na vitrine — o cliente precisa saber
  // que ele existe — mas nao entra no carrinho. `=== false` de proposito: resposta
  // antiga sem o campo segue vendendo.
  const indisponivel = product.availableForSale === false;

  const nome = sabor ? sabor.nome : product.name;
  const cor = sabor ? sabor.cor : '#E6F0DC';
  const tinta = sabor ? sabor.tinta : '#174328';
  const ingredientes = sabor && variante.tamanho ? sabor.ingredientes[variante.tamanho] : null;
  const imagem = sabor && variante.tamanho ? garrafaUrl(sabor.key, variante.tamanho) : product.imageUrl;
  const imagemGrande = sabor && variante.tamanho ? garrafaUrl(sabor.key, variante.tamanho, true) : product.imageUrl;

  // Galeria do detalhe: garrafa oficial primeiro, depois as fotos do cadastro.
  const fotosCadastro = product.images && product.images.length > 0
    ? product.images
    : (product.imageUrl ? [product.imageUrl] : []);
  const fotosCena = sabor ? (FOTOS[sabor.key] || []) : [];
  const galeria = imagemGrande && imagemGrande !== product.imageUrl
    ? [imagemGrande, ...fotosCena, ...fotosCadastro]
    : fotosCadastro;

  const abrirDetalhes = () => {
    // ViewContent = interesse de verdade (abrir os detalhes), não só rolar a grade.
    pixel('ViewContent', {
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name,
      value: displayPrice,
      currency: 'BRL',
    });
    setShowDetails(true);
  };

  const rotuloTamanho = (t: string | null, p: Product) => (t ? `${t} ml` : p.name);

  return (
    <>
      <article
        id={`sabor-${grupo.key}`}
        className="bg-white rounded-[28px] overflow-hidden flex flex-col shadow-[0_1px_0_rgba(20,38,26,.06)] ring-1 ring-black/5 scroll-mt-24"
        data-testid={`product-card-${product.id}`}
      >
        <button
          type="button"
          onClick={abrirDetalhes}
          className="relative h-72 sm:h-80 flex items-end justify-center overflow-hidden"
          style={{ backgroundColor: cor }}
          aria-label={`Ver detalhes de ${nome} ${variante.tamanho ? variante.tamanho + ' ml' : ''}`}
        >
          {/* folha da marca, grande e discreta, atrás da garrafa */}
          <svg viewBox="0 0 100 120" className="absolute -right-6 -top-4 w-48 opacity-[0.14]" aria-hidden="true">
            <path d="M50 0 C80 30 100 55 100 78 A50 42 0 0 1 0 78 C0 55 20 30 50 0Z" fill={tinta} />
          </svg>
          {imagem ? (
            <img
              key={imagem}
              src={imagem}
              alt={`Garrafa Honest ${nome}${variante.tamanho ? ' ' + variante.tamanho + ' ml' : ''}`}
              className={`relative garrafa-sombra object-contain transition-[height] duration-300 ${
                variante.tamanho === '900' ? 'h-[94%]' : variante.tamanho === '350' ? 'h-[82%]' : 'h-full w-full object-cover'
              }`}
              style={{ marginBottom: variante.tamanho ? '3%' : 0 }}
              loading="lazy"
            />
          ) : (
            <span className="text-6xl mb-24" aria-hidden="true">🍓</span>
          )}
          {indisponivel && (
            <span className="absolute top-4 left-4 bg-white/90 text-honest-ink text-xs font-semibold px-3 py-1 rounded-full">
              Ainda não disponível
            </span>
          )}
        </button>

        <div className="p-5 flex flex-col gap-4 flex-1">
          <div>
            <h3 className="font-display text-2xl font-bold text-honest-ink leading-tight" data-testid={`product-name-${product.id}`}>
              {nome}
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              {ingredientes ? <>Suco misto de {ingredientes}</> : (product.description || '')}
            </p>
          </div>

          {grupo.variantes.length > 1 && (
            <div className="grid grid-cols-2 gap-1 p-1 bg-honest-paper rounded-full" role="radiogroup" aria-label="Tamanho">
              {grupo.variantes.map((v, i) => (
                <button
                  key={v.produto.id}
                  type="button"
                  role="radio"
                  aria-checked={i === idx}
                  onClick={() => setIdx(i)}
                  className={`py-2 rounded-full text-sm font-semibold transition-colors ${
                    i === idx ? 'bg-honest-forest text-white' : 'text-honest-forest hover:bg-white'
                  }`}
                  data-testid={`btn-size-${v.produto.id}`}
                >
                  {rotuloTamanho(v.tamanho, v.produto)}
                </button>
              ))}
            </div>
          )}

          <div className="mt-auto flex items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-bold text-honest-ink tabular-nums" data-testid={`product-price-${product.id}`}>
                {brl(displayPrice)}
              </div>
              <button
                type="button"
                onClick={abrirDetalhes}
                className="text-sm text-honest-green font-semibold underline-offset-2 hover:underline"
                data-testid={`btn-details-${product.id}`}
              >
                Ver detalhes
              </button>
            </div>
            <button
              onClick={() => { if (!indisponivel) onAddToCart(product); }}
              disabled={indisponivel}
              className={`inline-flex items-center gap-1.5 px-5 py-3 rounded-full text-sm font-semibold transition-all active:scale-95 ${
                indisponivel
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                  : 'bg-honest-green text-white hover:bg-honest-forest'
              }`}
              data-testid={`btn-add-cart-${product.id}`}
            >
              {indisponivel ? 'Indisponível' : (<><Plus className="w-4 h-4" aria-hidden="true" /> Adicionar</>)}
            </button>
          </div>
        </div>
      </article>

      {/* Modal de Detalhes */}
      {showDetails && (
        <div
          className="fixed inset-0 bg-honest-ink/60 z-50 flex items-start justify-center overflow-y-auto p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDetails(false); }}
          role="dialog"
          aria-modal="true"
          aria-label={nome}
        >
          <div className="bg-honest-paper w-full max-w-2xl my-8 rounded-[28px] shadow-xl overflow-hidden">
            <div className="sticky top-0 p-4 flex items-center justify-between z-10" style={{ backgroundColor: cor, color: tinta }}>
              <h2 className="font-display text-xl font-bold">
                {nome}{variante.tamanho ? ` · ${variante.tamanho} ml` : ''}
              </h2>
              <button
                onClick={() => setShowDetails(false)}
                className="p-2 hover:bg-black/10 rounded-full transition-colors"
                aria-label="Fechar"
                data-testid={`btn-close-details-${product.id}`}
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-5">
              <ImageGallery images={galeria} productName={product.name} />

              <div className="bg-white rounded-2xl p-5">
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div>
                    <h3 className="font-display text-2xl font-bold text-honest-ink">{nome}</h3>
                    <p className="text-gray-600 mt-1">
                      {ingredientes ? <>Suco misto de {ingredientes}. 100% suco, sem adição de açúcares.</> : product.description}
                    </p>
                    <p className="text-xs text-gray-500 mt-2">{product.name}</p>
                  </div>
                  <div className="text-2xl font-bold text-honest-ink tabular-nums whitespace-nowrap">
                    {brl(displayPrice)}
                  </div>
                </div>

                {grupo.variantes.length > 1 && (
                  <div className="grid grid-cols-2 gap-1 p-1 bg-honest-paper rounded-full mb-4" role="radiogroup" aria-label="Tamanho">
                    {grupo.variantes.map((v, i) => (
                      <button
                        key={v.produto.id}
                        type="button"
                        role="radio"
                        aria-checked={i === idx}
                        onClick={() => setIdx(i)}
                        className={`py-2 rounded-full text-sm font-semibold transition-colors ${
                          i === idx ? 'bg-honest-forest text-white' : 'text-honest-forest hover:bg-white'
                        }`}
                      >
                        {rotuloTamanho(v.tamanho, v.produto)}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => { if (!indisponivel) onAddToCart(product); }}
                  disabled={indisponivel}
                  className={`w-full py-3 text-lg ${
                    indisponivel
                      ? 'rounded-full bg-gray-200 text-gray-500 font-semibold cursor-not-allowed'
                      : 'btn-primary'
                  }`}
                  data-testid={`btn-add-cart-modal-${product.id}`}
                >
                  {indisponivel ? 'Ainda não disponível' : `Adicionar ao carrinho · ${brl(displayPrice)}`}
                </button>
                {indisponivel && (
                  <p className="mt-2 text-center text-sm text-amber-700">
                    Este sabor está temporariamente fora de linha. Avisaremos assim que voltar.
                  </p>
                )}
              </div>

              {product.details && (
                <div className="bg-white rounded-2xl p-5">
                  <h4 className="font-display text-lg font-bold text-honest-ink mb-3">Detalhes técnicos</h4>
                  <div className="text-gray-700 whitespace-pre-wrap text-sm leading-relaxed" data-testid={`product-details-${product.id}`}>
                    {product.details}
                  </div>
                </div>
              )}

              <ProductReviews productId={product.id} productName={product.name} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
