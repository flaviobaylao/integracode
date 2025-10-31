export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  images?: string[] | null; // Array de URLs de imagens para galeria
  stock: number;
}

export interface CartItem extends Product {
  quantity: number;
}

export interface Customer {
  name: string;
  email?: string;
  phone: string;
  address: string;
  cpfCnpj?: string;
  customerType: 'pessoa_fisica' | 'pessoa_juridica';
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
}
