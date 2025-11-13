import { useState } from 'react';
import type { Product } from '../types';
import ImageGallery from './ImageGallery';
import ProductReviews from './ProductReviews';
import { useCustomerType } from '../contexts/CustomerTypeContext';
import { getProductPrice } from '../utils/pricing';
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
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-honest-green to-honest-orange">
            <span className="text-white text-6xl">🍊</span>
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
              onClick={() => setShowDetails(true)}
              className="flex-1 border border-honest-green text-honest-green py-2 px-3 rounded-lg text-sm font-semibold hover:bg-green-50 transition-colors"
              data-testid={`btn-details-${product.id}`}
            >
              Ver detalhes
            </button>
            <button
              onClick={() => onAddToCart(product)}
              className="flex-1 btn-primary text-sm py-2 px-3"
              data-testid={`btn-add-cart-${product.id}`}
            >
              Adicionar
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
                onClick={() => { onAddToCart(product); setShowDetails(false); }}
                className="w-full btn-primary py-3 text-lg"
                data-testid={`btn-add-cart-modal-${product.id}`}
              >
                🛒 Adicionar ao Carrinho
              </button>
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
