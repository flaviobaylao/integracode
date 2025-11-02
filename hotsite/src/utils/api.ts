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
    console.log('📤 api.createOrder chamado');
    console.log('📤 Order data:', order);
    console.log('📤 URL:', `${API_BASE}/orders`);
    
    const response = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    
    console.log('📥 Response status:', response.status);
    console.log('📥 Response ok:', response.ok);
    
    const data = await response.json();
    console.log('📥 Response data:', data);
    
    if (!response.ok) {
      console.error('❌ Request failed:', data);
      throw new Error(data.message || 'Erro ao criar pedido');
    }
    
    return data;
  },

  async checkCustomerByCNPJ(cnpj: string): Promise<{
    exists: boolean;
    customer?: {
      id: string;
      name: string;
      companyName: string;
      fantasyName: string;
      cnpj: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      zipCode?: string;
    };
  }> {
    const response = await fetch(`${API_BASE}/customers/check-cnpj`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnpj }),
    });
    if (!response.ok) throw new Error('Erro ao verificar CNPJ');
    return response.json();
  },

  async consultarCNPJ(cnpj: string): Promise<{
    cnpj: string;
    razaoSocial: string;
    nomeFantasia: string;
    endereco: string;
    cidade: string;
    estado: string;
    cep: string;
    telefone?: string;
    email?: string;
    situacao: string;
    atividadePrincipal?: string;
  }> {
    const response = await fetch(`${API_BASE}/receita/cnpj`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnpj }),
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Erro ao consultar CNPJ');
    }
    
    return data;
  },
};
