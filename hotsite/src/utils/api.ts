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

  async checkCustomer(email?: string, phone?: string, cpf?: string): Promise<{
    exists: boolean;
    customerType?: string;
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    cpfCnpj?: string;
  }> {
    const response = await fetch(`${API_BASE}/customers/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone, cpf }),
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

  // 💚 PIX pagar-antes: gera a cobrança (QR + copia-e-cola). O pedido só é
  // criado no sistema depois que o pagamento for confirmado pelo banco.
  async initPixOrder(order: any): Promise<{
    pendingId: string;
    txid: string;
    amount: number;
    qrCodeBase64: string;
    pixCopiaECola: string;
    expiresAt: string;
    referralDiscount: { pct: number; amount: number; total: number } | null;
  }> {
    const response = await fetch(`${API_BASE}/orders/pix/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erro ao gerar o PIX');
    return data;
  },

  async getPixStatus(pendingId: string): Promise<{
    status: string;
    orderId?: string;
    orderNumber?: string;
  }> {
    const response = await fetch(`${API_BASE}/orders/pix/${encodeURIComponent(pendingId)}/status`);
    if (!response.ok) throw new Error('Erro ao consultar o pagamento');
    return response.json();
  },

  // 💳 Cartão pagar-antes (Cielo): autoriza+captura e, só se aprovado, cria o pedido.
  async payWithCard(order: any, card: { number: string; holder: string; expiry: string; cvv: string }, installments: number): Promise<{
    success: boolean;
    orderId?: string;
    orderNumber?: string;
    orderPending?: boolean;
    paymentId?: string;
    message?: string;
  }> {
    const response = await fetch(`${API_BASE}/orders/card/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order, card, installments }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Pagamento não autorizado');
    return data;
  },

  // Google Pay (Cielo): manda o token da carteira; so se aprovado, cria o pedido.
  async payGooglePay(order: any, googlePayToken: string): Promise<{
    success: boolean;
    orderId?: string;
    orderNumber?: string;
    orderPending?: boolean;
    paymentId?: string;
    message?: string;
  }> {
    const response = await fetch(`${API_BASE}/orders/card/pay-googlepay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order, googlePayToken }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Pagamento Google Pay nao autorizado');
    return data;
  },

  async getCardConfig(): Promise<{ enabled: boolean; maxInstallments: number; googlePay?: any }> {
    try {
      const response = await fetch(`${API_BASE}/orders/card/config`);
      if (!response.ok) throw new Error('x');
      return response.json();
    } catch {
      return { enabled: true, maxInstallments: 3 };
    }
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
