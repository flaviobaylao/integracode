import type { Product, Order } from '../types';

const API_BASE = '/api/public';

export const api = {
  async getProducts(): Promise<Product[]> {
    const response = await fetch(`${API_BASE}/products`);
    if (!response.ok) throw new Error('Erro ao carregar produtos');
    return response.json();
  },

  async getProduct(id: string): Promise<Product> {
    const response = await fetch(`${API_BASE}/products/${id}`);
    if (!response.ok) throw new Error('Produto não encontrado');
    return response.json();
  },

  async checkCustomer(email?: string, phone?: string): Promise<{
    exists: boolean;
    customerType?: string;
    id?: string;
    name?: string;
  }> {
    const response = await fetch(`${API_BASE}/customers/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone }),
    });
    if (!response.ok) throw new Error('Erro ao verificar cliente');
    return response.json();
  },

  async createOrder(order: Order): Promise<{
    success: boolean;
    orderId: string;
    orderNumber: string;
    message: string;
  }> {
    const response = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Erro ao criar pedido');
    }
    
    return data;
  },
};
