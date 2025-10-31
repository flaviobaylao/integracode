import type { Product } from '../types';

interface ProductCardProps {
  product: Product;
  onAddToCart: (product: Product) => void;
}

export default function ProductCard({ product, onAddToCart }: ProductCardProps) {
  return (
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
        {product.stock <= 0 && (
          <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <span className="text-white font-bold text-lg">Esgotado</span>
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
        
        <div className="flex items-center justify-between">
          <div>
            <span className="text-2xl font-bold text-honest-green" data-testid={`product-price-${product.id}`}>
              R$ {product.price.toFixed(2)}
            </span>
            {product.stock > 0 && product.stock <= 10 && (
              <p className="text-xs text-honest-orange mt-1">
                Restam apenas {product.stock}
              </p>
            )}
          </div>
          
          <button
            onClick={() => onAddToCart(product)}
            disabled={product.stock <= 0}
            className="btn-primary text-sm py-2 px-4"
            data-testid={`btn-add-cart-${product.id}`}
          >
            {product.stock <= 0 ? 'Esgotado' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>
  );
}
