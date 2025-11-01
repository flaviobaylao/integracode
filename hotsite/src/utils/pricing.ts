import type { Product } from '../types';
import type { PriceTable } from '../contexts/CustomerTypeContext';

export function getProductPrice(product: Product, priceTable: PriceTable | null): number {
  if (!priceTable) {
    return product.price;
  }

  const priceMap: Record<PriceTable, keyof Product> = {
    retail_price: 'retailPrice',
    wholesale_price: 'wholesalePrice',
    resale_goiania_price: 'resaleGoianiaPrice',
    resale_interior_price: 'resaleInteriorPrice',
    resale_brasilia_price: 'resaleBrasiliaPrice',
  };

  const priceField = priceMap[priceTable];
  const selectedPrice = product[priceField];
  
  // Fallback para price se o preço específico não estiver disponível
  return (selectedPrice as number | null) ?? product.price;
}
