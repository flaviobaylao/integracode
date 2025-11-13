export interface Product {
  id: string;
  name: string;
  description: string | null;
  details: string | null; // Ficha técnica detalhada do produto
  price: number; // Mantido para compatibilidade
  retailPrice: number | null;
  wholesalePrice: number | null;
  resaleGoianiaPrice: number | null;
  resaleInteriorPrice: number | null;
  resaleBrasiliaPrice: number | null;
  imageUrl: string | null;
  images?: string[] | null; // Array de URLs de imagens para galeria
  stock: number;
}

export interface CartItem extends Product {
  quantity: number;
}

export interface Customer {
  name: string;
  email?: string | null;
  phone: string;
  address: string;
  cpfCnpj?: string | null;
  customerType: 'pessoa_fisica' | 'pessoa_juridica';
  deliveryLocation?: {
    latitude: number;
    longitude: number;
    capturedAt: Date;
  } | null;
}

export interface Order {
  customer: Customer;
  items: {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
  }[];
  totalAmount: number;
  paymentMethod: 'pix' | 'card' | 'boleto';
  source: 'hotsite' | 'website';
  priceTable?: 'retail' | 'wholesale' | 'goiania' | 'interior' | 'brasilia';
  deliveryLocation?: {
    latitude: number;
    longitude: number;
    capturedAt: Date;
  } | null;
}
