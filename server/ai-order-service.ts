import { storage } from "./storage";
import { chatOrderFormSchema, type ChatOrderForm } from "@shared/schema";
import { nanoid } from "nanoid";

export const ORDER_FORM_TEMPLATE = `📋 *FORMULÁRIO DE PEDIDO*

Para finalizar seu pedido, por favor preencha os dados abaixo e envie de volta:

━━━━━━━━━━━━━━━━━━━━━━━━
📝 *DADOS DO CLIENTE*
━━━━━━━━━━━━━━━━━━━━━━━━
Nome Completo: 
CPF ou CNPJ: 
Telefone: 

━━━━━━━━━━━━━━━━━━━━━━━━
📍 *ENDEREÇO DE ENTREGA*
━━━━━━━━━━━━━━━━━━━━━━━━
Rua/Avenida e Número: 
Bairro: 
Cidade: 
CEP (opcional): 

━━━━━━━━━━━━━━━━━━━━━━━━
🛒 *PRODUTOS*
━━━━━━━━━━━━━━━━━━━━━━━━
(Liste os produtos, quantidade e valor)
Exemplo: Suco de Laranja 1L - 2 unidades - R$ 15,00 cada

1. 
2. 
3. 

━━━━━━━━━━━━━━━━━━━━━━━━
💳 *PAGAMENTO E ENTREGA*
━━━━━━━━━━━━━━━━━━━━━━━━
Forma de Pagamento: (PIX / Dinheiro / Cartão Crédito / Cartão Débito / Boleto / A Prazo)
Dia Preferido para Entrega: 
Horário Preferido (opcional): 

━━━━━━━━━━━━━━━━━━━━━━━━
📝 *OBSERVAÇÕES*
━━━━━━━━━━━━━━━━━━━━━━━━
(Instruções especiais, ponto de referência, etc.)


━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ *Após preencher, envie esta mensagem completa que validaremos seu pedido!*`;

export interface ParsedOrderResult {
  success: boolean;
  order?: ChatOrderForm;
  errors?: string[];
  rawData?: Record<string, string>;
}

export function parseOrderFormMessage(message: string): ParsedOrderResult {
  try {
    console.log(`📋 [AI-ORDER] Tentando parsear formulário de pedido...`);
    
    const lines = message.split('\n').map(l => l.trim()).filter(l => l);
    const data: Record<string, string> = {};
    
    for (const line of lines) {
      if (line.includes(':')) {
        const colonIndex = line.indexOf(':');
        const key = line.substring(0, colonIndex).trim().toLowerCase();
        const value = line.substring(colonIndex + 1).trim();
        
        if (value && value.length > 0) {
          if (key.includes('nome completo') || key === 'nome') {
            data.nomeCompleto = value;
          } else if (key.includes('cpf') || key.includes('cnpj')) {
            data.cpfCnpj = value.replace(/[^\d]/g, '');
          } else if (key.includes('telefone') || key.includes('celular') || key.includes('whatsapp')) {
            data.telefone = value.replace(/[^\d]/g, '');
          } else if (key.includes('rua') || key.includes('avenida') || key.includes('endereço') || key.includes('endereco')) {
            data.endereco = value;
          } else if (key.includes('bairro')) {
            data.bairro = value;
          } else if (key.includes('cidade')) {
            data.cidade = value;
          } else if (key.includes('cep')) {
            data.cep = value.replace(/[^\d]/g, '');
          } else if (key.includes('forma de pagamento') || key.includes('pagamento')) {
            data.formaPagamento = normalizePaymentMethod(value);
          } else if (key.includes('dia') && key.includes('entrega')) {
            data.diaEntrega = value;
          } else if (key.includes('horário') || key.includes('horario')) {
            data.horarioEntrega = value;
          } else if (key.includes('observa')) {
            data.observacoes = value;
          }
        }
      }
    }
    
    const produtos = parseProductsFromMessage(message);
    
    if (Object.keys(data).length < 3 || produtos.length === 0) {
      console.log(`📋 [AI-ORDER] Formulário incompleto: ${Object.keys(data).length} campos, ${produtos.length} produtos`);
      return {
        success: false,
        errors: ["Formulário incompleto. Por favor, preencha todos os campos obrigatórios."],
        rawData: data
      };
    }
    
    const orderData: ChatOrderForm = {
      nomeCompleto: data.nomeCompleto || '',
      cpfCnpj: data.cpfCnpj || '',
      telefone: data.telefone || '',
      endereco: data.endereco || '',
      bairro: data.bairro || '',
      cidade: data.cidade || '',
      cep: data.cep,
      produtos,
      formaPagamento: (data.formaPagamento as any) || 'pix',
      diaEntrega: data.diaEntrega || '',
      horarioEntrega: data.horarioEntrega,
      observacoes: data.observacoes
    };
    
    const validation = chatOrderFormSchema.safeParse(orderData);
    
    if (!validation.success) {
      const errors = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
      console.log(`📋 [AI-ORDER] Validação falhou:`, errors);
      return {
        success: false,
        errors,
        rawData: data
      };
    }
    
    console.log(`✅ [AI-ORDER] Formulário parseado com sucesso!`);
    return {
      success: true,
      order: validation.data,
      rawData: data
    };
  } catch (error: any) {
    console.error(`❌ [AI-ORDER] Erro ao parsear formulário:`, error.message);
    return {
      success: false,
      errors: [`Erro ao processar formulário: ${error.message}`]
    };
  }
}

function normalizePaymentMethod(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('pix')) return 'pix';
  if (lower.includes('dinheiro')) return 'dinheiro';
  if (lower.includes('crédito') || lower.includes('credito')) return 'cartao_credito';
  if (lower.includes('débito') || lower.includes('debito')) return 'cartao_debito';
  if (lower.includes('boleto')) return 'boleto';
  if (lower.includes('prazo') || lower.includes('fiado') || lower.includes('faturado')) return 'a_prazo';
  return 'pix';
}

function parseProductsFromMessage(message: string): Array<{ nome: string; quantidade: number; precoUnitario: number }> {
  const produtos: Array<{ nome: string; quantidade: number; precoUnitario: number }> = [];
  const lines = message.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('━') || trimmed.startsWith('*')) continue;
    
    const productMatch = trimmed.match(/^(\d+\.?\s*)?(.+?)\s*[-–]\s*(\d+)\s*(un|unidade|x|pc|pç)?\w*\s*[-–]?\s*R?\$?\s*([\d.,]+)/i);
    
    if (productMatch) {
      const nome = productMatch[2].trim();
      const quantidade = parseInt(productMatch[3]) || 1;
      const precoStr = productMatch[5].replace(',', '.');
      const precoUnitario = parseFloat(precoStr) || 0;
      
      if (nome && quantidade > 0 && precoUnitario > 0) {
        produtos.push({ nome, quantidade, precoUnitario });
      }
    }
  }
  
  return produtos;
}

export async function createSalesCardFromChatOrder(
  order: ChatOrderForm,
  conversationId: string,
  customerPhone: string
): Promise<{ success: boolean; salesCardId?: string; error?: string }> {
  try {
    console.log(`🛒 [AI-ORDER] Criando sales_card a partir de pedido do chat...`);
    
    let customer = await storage.getCustomerByCnpj(order.cpfCnpj);
    
    if (!customer) {
      const customers = await storage.getCustomers();
      customer = customers.find(c => 
        c.phone?.replace(/\D/g, '').includes(customerPhone.replace(/\D/g, '').slice(-8))
      );
    }
    
    const products = order.produtos.map(p => ({
      id: nanoid(8),
      name: p.nome,
      quantity: p.quantidade,
      unitPrice: p.precoUnitario,
      totalPrice: p.quantidade * p.precoUnitario
    }));
    
    const totalValue = products.reduce((sum, p) => sum + p.totalPrice, 0);
    
    const paymentMethodMap: Record<string, string> = {
      'pix': 'PIX',
      'dinheiro': 'Dinheiro',
      'cartao_credito': 'Cartão de Crédito',
      'cartao_debito': 'Cartão de Débito',
      'boleto': 'Boleto',
      'a_prazo': 'A Prazo'
    };
    
    const observacoes = [
      `📱 Pedido via WhatsApp (ChatGPT)`,
      `👤 Cliente: ${order.nomeCompleto}`,
      `📄 CPF/CNPJ: ${order.cpfCnpj}`,
      `📍 Endereço: ${order.endereco}, ${order.bairro}, ${order.cidade}${order.cep ? ` - CEP: ${order.cep}` : ''}`,
      `💳 Pagamento: ${paymentMethodMap[order.formaPagamento] || order.formaPagamento}`,
      `📅 Entrega: ${order.diaEntrega}${order.horarioEntrega ? ` às ${order.horarioEntrega}` : ''}`,
      order.observacoes ? `📝 Obs: ${order.observacoes}` : ''
    ].filter(Boolean).join('\n');
    
    const salesCard = await storage.createSalesCard({
      customerId: customer?.id || 'chat-order-' + nanoid(8),
      sellerId: 'chatgpt-ai',
      status: 'pending',
      source: 'whatsapp_chatgpt',
      saleValue: totalValue.toFixed(2),
      products: products,
      notes: observacoes,
      routeDay: getWeekdayFromDate(order.diaEntrega),
      recurrenceType: 'semanal',
      isRecurring: false,
      isPermanent: false,
      exclusiveVehicle: false,
      vehicleTypes: ['carro']
    });
    
    console.log(`✅ [AI-ORDER] Sales card criado: ${salesCard.id}`);
    
    try {
      await storage.createChatAiLog({
        conversationId,
        customerMessage: `Pedido recebido: ${order.nomeCompleto} - ${products.length} produtos - R$ ${totalValue.toFixed(2)}`,
        botResponse: `Sales card criado: ${salesCard.id}`,
        tokensUsed: 0,
        responseTimeMs: 0,
        status: 'success'
      });
    } catch (logErr) {
      console.warn(`⚠️ [AI-ORDER] Erro ao criar log:`, logErr);
    }
    
    return {
      success: true,
      salesCardId: salesCard.id
    };
  } catch (error: any) {
    console.error(`❌ [AI-ORDER] Erro ao criar sales_card:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

function getWeekdayFromDate(dateStr: string): string {
  const lower = dateStr.toLowerCase();
  
  if (lower.includes('segunda')) return 'segunda';
  if (lower.includes('terça') || lower.includes('terca')) return 'terca';
  if (lower.includes('quarta')) return 'quarta';
  if (lower.includes('quinta')) return 'quinta';
  if (lower.includes('sexta')) return 'sexta';
  if (lower.includes('sábado') || lower.includes('sabado')) return 'sabado';
  if (lower.includes('domingo')) return 'domingo';
  
  if (lower.includes('hoje')) {
    const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    return days[new Date().getDay()];
  }
  
  if (lower.includes('amanhã') || lower.includes('amanha')) {
    const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    return days[(new Date().getDay() + 1) % 7];
  }
  
  return 'segunda';
}

export function generateOrderConfirmation(order: ChatOrderForm): string {
  const totalValue = order.produtos.reduce((sum, p) => sum + (p.quantidade * p.precoUnitario), 0);
  
  const productsList = order.produtos
    .map((p, i) => `${i + 1}. ${p.nome} - ${p.quantidade}x R$ ${p.precoUnitario.toFixed(2)} = R$ ${(p.quantidade * p.precoUnitario).toFixed(2)}`)
    .join('\n');
  
  const paymentMethodMap: Record<string, string> = {
    'pix': 'PIX',
    'dinheiro': 'Dinheiro',
    'cartao_credito': 'Cartão de Crédito',
    'cartao_debito': 'Cartão de Débito',
    'boleto': 'Boleto',
    'a_prazo': 'A Prazo'
  };
  
  return `✅ *PEDIDO CONFIRMADO!*

━━━━━━━━━━━━━━━━━━━━━━━━
📋 *RESUMO DO PEDIDO*
━━━━━━━━━━━━━━━━━━━━━━━━

👤 *Cliente:* ${order.nomeCompleto}
📄 *CPF/CNPJ:* ${order.cpfCnpj}
📱 *Telefone:* ${order.telefone}

📍 *Entrega:*
${order.endereco}
${order.bairro} - ${order.cidade}${order.cep ? ` - CEP: ${order.cep}` : ''}

🛒 *Produtos:*
${productsList}

━━━━━━━━━━━━━━━━━━━━━━━━
💰 *TOTAL: R$ ${totalValue.toFixed(2)}*
━━━━━━━━━━━━━━━━━━━━━━━━

💳 *Pagamento:* ${paymentMethodMap[order.formaPagamento] || order.formaPagamento}
📅 *Entrega:* ${order.diaEntrega}${order.horarioEntrega ? ` às ${order.horarioEntrega}` : ''}
${order.observacoes ? `\n📝 *Observações:* ${order.observacoes}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━

Seu pedido foi registrado e será processado em breve! 🎉
Nossa equipe entrará em contato para confirmar a entrega.

Obrigado por comprar com a Honest Sucos! 🧃`;
}

export function isOrderFormResponse(message: string): boolean {
  const lowerMsg = message.toLowerCase();
  const hasMultipleFields = 
    (lowerMsg.includes('nome completo') || lowerMsg.includes('nome:')) &&
    (lowerMsg.includes('cpf') || lowerMsg.includes('cnpj')) &&
    (lowerMsg.includes('endereço') || lowerMsg.includes('endereco') || lowerMsg.includes('rua')) &&
    (lowerMsg.includes('pagamento') || lowerMsg.includes('pix') || lowerMsg.includes('dinheiro'));
  
  return hasMultipleFields;
}

export function shouldSendOrderForm(message: string): boolean {
  const lowerMsg = message.toLowerCase();
  const orderKeywords = [
    'quero fazer pedido',
    'quero pedir',
    'fazer um pedido',
    'gostaria de pedir',
    'quero comprar',
    'gostaria de comprar',
    'fazer pedido',
    'quero encomendar',
    'fazer uma encomenda',
    'me manda o formulário',
    'me manda o formulario',
    'enviar pedido',
    'fechar pedido',
    'finalizar pedido',
    'confirmar pedido'
  ];
  
  return orderKeywords.some(keyword => lowerMsg.includes(keyword));
}
