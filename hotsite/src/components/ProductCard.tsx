import { useState } from 'react';
import type { Product } from '../types';
import ImageGallery from './ImageGallery';
import ProductReviews from './ProductReviews';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { getProductPrice } from '../utils/pricing';
import { pixel } from '../utils/pixel';
import { X } from 'lucide-react';

interface ProductCardProps {
  product: Product;
  onAddToCart: (product: Product) => void;
}

export default function ProductCard({ product, onAddToCart }: ProductCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const { priceTable } = useCustomerType();
  
  const images = product.images && product.images.length > 0 
    ? product.images 
    : (product.imageUrl ? [product.imageUrl] : []);
  
  const displayPrice = getProductPrice(product, priceTable);

  // DISPONIBILIDADE (set/2026): o produto continua na vitrine — o cliente precisa saber
  // que ele existe — mas nao entra no carrinho. Ligado/desligado por produto na tela de
  // Produtos. `=== false` de proposito: resposta antiga sem o campo segue vendendo.
  const indisponivel = product.availableForSale === false;

  return (
    <>
    <div className="product-card" data-testid={`product-card-${product.id}`}>
      <div className="aspect-square bg-gray-200 relative overflow-hidden">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-rose-400 to-pink-500">
            <span className="text-white text-6xl">🍓</span>
          </div>
        )}
      </div>
      
      <div className="p-4">
        <h3 className="font-semibold text-lg text-gray-800 mb-1" data-testid={`product-name-${product.id}`}>
          {product.name}
        </h3>
        
        {product.description && (
          <p className="text-sm text-gray-600 mb-3 line-clamp-2">
            {product.description}
          </p>
        )}
        
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold text-honest-green" data-testid={`product-price-${product.id}`}>
              R$ {displayPrice.toFixed(2)}
            </span>
          </div>
          
          <div className="flex gap-2">
            <button
              onClick={() => {
                // ViewContent = interesse de verdade. Abrir os detalhes e o unico
                // sinal honesto que a loja tem: o card sozinho aparece na grade
                // para todo mundo que rola a pagina, e disparar por isso encheria
                // o publico de quem nem olhou.
                pixel('ViewContent', {
                  content_type: 'product',
                  content_ids: [String(product.id)],
                  content_name: product.name,
                  value: displayPrice,
                  currency: 'BRL',
                });
                setShowDetails(true);
              }}
              className="flex-1 border border-honest-green text-honest-green py-2 px-3 rounded-lg text-sm font-semibold hover:bg-green-50 transition-colors"
              data-testid={`btn-details-${product.id}`}
            >
              Ver detalhes
            </button>
            <button
              onClick={() => { if (!indisponivel) onAddToCart(product); }}
              disabled={indisponivel}
              className={`flex-1 text-sm py-2 px-3 ${
                indisponivel
                  ? 'rounded-lg bg-gray-200 text-gray-500 font-semibold cursor-not-allowed'
                  : 'btn-primary'
              }`}
              data-testid={`btn-add-cart-${product.id}`}
            >
              {indisponivel ? 'Ainda não disponível' : 'Adicionar'}
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* Modal de Detalhes */}
    {showDetails && (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto p-4">
        <div className="bg-gray-50 min-h-full w-full max-w-2xl my-8 rounded-xl shadow-xl">
          {/* Header */}
          <div className="sticky top-0 bg-honest-green text-white p-4 rounded-t-xl flex items-center justify-between z-10">
            <h2 className="text-xl font-bold">{product.name}</h2>
            <button
              onClick={() => setShowDetails(false)}
              className="p-2 hover:bg-white/20 rounded-full transition-colors"
              data-testid={`btn-close-details-${product.id}`}
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {/* Galeria de Imagens */}
            <ImageGallery images={images} productName={product.name} />

            {/* Informações do Produto */}
            <div className="bg-white rounded-xl p-6 shadow-sm">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-2xl font-bold text-gray-800">{product.name}</h3>
                  {product.description && (
                    <p className="text-gray-600 mt-2">{product.description}</p>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-honest-green">
                    R$ {displayPrice.toFixed(2)}
                  </div>
                </div>
              </div>

              <button
                onClick={() => { if (!indisponivel) onAddToCart(product); }}
                disabled={indisponivel}
                className={`w-full py-3 text-lg ${
                  indisponivel
                    ? 'rounded-lg bg-gray-200 text-gray-500 font-semibold cursor-not-allowed'
                    : 'btn-primary'
                }`}
                data-testid={`btn-add-cart-modal-${product.id}`}
              >
                {indisponivel ? 'Ainda não disponível' : '🛒 Adicionar ao Carrinho'}
              </button>
              {indisponivel && (
                <p className="mt-2 text-center text-sm text-amber-700">
                  Este sabor está temporariamente fora de linha. Avisaremos assim que voltar.
                </p>
              )}
            </div>

            {/* Detalhes Técnicos */}
            {product.details && (
              <div className="bg-white rounded-xl p-6 shadow-sm">
                <h4 className="text-lg font-bold text-gray-800 mb-3 flex items-center gap-2">
                  <span className="text-honest-orange">📋</span>
                  Detalhes Técnicos
                </h4>
                <div className="text-gray-700 whitespace-pre-wrap text-sm leading-relaxed" data-testid={`product-details-${product.id}`}>
                  {product.details}
                </div>
              </div>
            )}

            {/* Reviews */}
            <ProductReviews productId={product.id} productName={product.name} />
          </div>
        </div>
      </div>
    )}
    </>
  );
}
