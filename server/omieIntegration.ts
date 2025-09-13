import { z } from 'zod';
import { PAYMENT_METHOD_TO_OMIE_ACCOUNT } from '@shared/schema';

// Schemas para validação das respostas da API Omie
const OmieClientSchema = z.object({
  codigo_cliente_omie: z.number(),
  cnpj_cpf: z.string(),
  razao_social: z.string(),
  nome_fantasia: z.string().optional(),
  email: z.string().optional(),
  telefone1_ddd: z.string().optional(),
  telefone1_numero: z.string().optional(),
  endereco: z.string().optional(),
  endereco_numero: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  estado: z.string().optional(),
  cep: z.string().optional(),
  bloqueado: z.string().optional(),
  inativo: z.string().optional(),
  situacao: z.string().optional(), // Campo situacao para determinar se cliente está ativo
  limite_credito: z.number().optional(),
});

const OmieCreditInfoSchema = z.object({
  limite_credito: z.number().optional(),
  valor_em_aberto: z.number().optional(),
  dias_em_atraso: z.number().optional(),
  bloqueado_financeiro: z.string().optional(),
});

const OmieVendorSchema = z.object({
  codigo: z.number(),
  nome: z.string(),
  email: z.string().optional(),
  telefone: z.string().optional(),
  inativo: z.string().optional(),
  comissao: z.number().optional()
});

const OmieProductSchema = z.object({
  codigo_produto: z.number(),
  codigo: z.string().optional(),
  descricao: z.string(),
  unidade: z.string().optional(),
  valor_unitario: z.number().optional(),
  inativo: z.string().optional(),
  ncm: z.string().optional(),
  ean: z.string().optional(),
  peso_liq: z.number().optional(),
  altura: z.number().optional(),
  largura: z.number().optional(),
  profundidade: z.number().optional()
});

export type OmieClient = z.infer<typeof OmieClientSchema>;
export type OmieVendor = z.infer<typeof OmieVendorSchema>;
export type OmieProduct = z.infer<typeof OmieProductSchema>;
export type OmieCreditInfo = z.infer<typeof OmieCreditInfoSchema>;

export interface OmieConfig {
  appKey: string;
  appSecret: string;
  baseUrl?: string;
}

export class OmieService {
  private config: OmieConfig;
  private baseUrl: string;
  private storage: any;
  private appKey: string;
  private appSecret: string;

  constructor(config: OmieConfig, storage?: any) {
    this.config = config;
    this.baseUrl = config.baseUrl || 'https://app.omie.com.br/api/v1';
    this.storage = storage;
    this.appKey = config.appKey;
    this.appSecret = config.appSecret;
  }

  static createFromEnv(storage?: any): OmieService {
    const appKey = process.env.OMIE_APP_KEY;
    const appSecret = process.env.OMIE_APP_SECRET;
    
    if (!appKey || !appSecret) {
      throw new Error('OMIE_APP_KEY and OMIE_APP_SECRET environment variables are required');
    }
    
    return new OmieService({
      appKey,
      appSecret
    }, storage);
  }

  private async makeRequest(endpoint: string, call: string, params: any = {}) {
    const payload = {
      call,
      app_key: this.config.appKey,
      app_secret: this.config.appSecret,
      param: [params]
    };

    // Create safe payload for logging (redacting sensitive credentials)
    const safePayload = {
      call,
      app_key: this.config.appKey ? '[REDACTED]' : 'NOT_SET',
      app_secret: this.config.appSecret ? '[REDACTED]' : 'NOT_SET',
      param: params,
      paramsSize: JSON.stringify(params).length
    };

    console.log(`Making request to ${endpoint} with call ${call}`);
    console.log('Request URL:', `${this.baseUrl}${endpoint}`);
    console.log('Safe request payload:', JSON.stringify(safePayload, null, 2));
    console.log('Credentials configured:', !!this.config.appKey && !!this.config.appSecret);

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response body:', errorText);
      
      // Capturar erro específico de "não existem registros"
      if (errorText.includes('NÃ£o existem registros para a pÃ¡gina')) {
        const error = new Error(`Omie API error: ${response.status} ${response.statusText}`);
        (error as any).response = errorText;
        throw error;
      }
      
      throw new Error(`Omie API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('Response data:', JSON.stringify(data, null, 2));
    
    if (data.faultstring) {
      throw new Error(`Omie API fault: ${data.faultstring}`);
    }

    return data;
  }

  // Método auxiliar para mapear status da SEFAZ
  private mapSefazStatus(rawStatus: string | number): string {
    // Se já é um código numérico SEFAZ, retornar como string
    if (typeof rawStatus === 'number' || /^\d+$/.test(rawStatus?.toString() || '')) {
      return rawStatus.toString();
    }
    
    // Normalizar o status para comparação
    const status = rawStatus?.toString()?.toLowerCase()?.trim() || '';
    
    // Mapeamento de status textuais para códigos SEFAZ
    const statusMap: { [key: string]: string } = {
      'autorizada': '100',
      'autorizado': '100', 
      'emitida': '100',
      'autorizado o uso da nf-e': '100',
      'uso autorizado': '100',
      'autorizado (entrada)': '100',
      'entrada autorizada': '100',
      'autorizada fora do prazo': '150',
      'autorizada fora prazo': '150',
      'autorizada_fora_prazo': '150',
      'autorizado o uso da nf-e fora de prazo': '150'
    };
    
    // Retornar código SEFAZ ou o valor original se não encontrar mapeamento
    return statusMap[status] || rawStatus?.toString() || '';
  }

  // Método auxiliar para determinar o tipo de faturamento baseado no CFOP
  private determineBillingType(cfop: string): 'venda' | 'troca' | 'amostra' | 'devolucao' {
    // Normalizar CFOP (remover pontos)
    const normalizedCfop = cfop?.replace(/\./g, '') || '';
    
    // CFOPs específicos de devolução (lista precisa)
    const devolucaoCfops = ['1201', '1202', '1203', '1204', '1411', '1556', '2201', '2202', '2203', '2204', '2411', '2556'];
    if (devolucaoCfops.includes(normalizedCfop)) {
      return 'devolucao';
    }
    
    // CFOPs de troca
    if (['5949', '6949'].includes(normalizedCfop)) {
      return 'troca';
    }
    
    // CFOPs de amostra
    if (['5911', '6911'].includes(normalizedCfop)) {
      return 'amostra';
    }
    
    // Padrão: venda
    return 'venda';
  }

  // Buscar cliente por CNPJ/CPF
  async getClientByCnpjCpf(cnpjCpf: string): Promise<OmieClient | null> {
    try {
      const response = await this.makeRequest('/geral/clientes/', 'ConsultarCliente', {
        cnpj_cpf: cnpjCpf
      });

      if (response && response.cnpj_cpf) {
        return OmieClientSchema.parse(response);
      }

      return null;
    } catch (error) {
      console.error('Erro ao buscar cliente no Omie:', error);
      throw error;
    }
  }

  // ==================== MÉTODOS AUXILIARES PARA VENDEDORES E ETAPAS ====================
  
  // Cache para vendedores, etapas e clientes (para evitar múltiplas requisições)
  private sellersCache: Map<string, any> = new Map();
  private stagesCache: Map<string, any> = new Map();
  private clientsCache: Map<string, any> = new Map();
  private stageNamesCache: Map<string, string> = new Map(); // Cache para nomes das etapas
  private paymentMethodsCache: Map<string, string> = new Map(); // Cache para formas de pagamento

  // Limpar cache
  public clearCache(): void {
    this.sellersCache.clear();
    this.stagesCache.clear();
    this.clientsCache.clear();
    this.stageNamesCache.clear();
    this.paymentMethodsCache.clear();
    console.log('🧹 Cache limpo!');
  }

  // Método para buscar dados de um vendedor específico
  async fetchSellerData(sellerCode: string): Promise<{name: string, id: string} | null> {
    if (!sellerCode) return null;
    
    // Verificar cache primeiro
    if (this.sellersCache.has(sellerCode)) {
      return this.sellersCache.get(sellerCode);
    }

    try {
      console.log(`🔍 Buscando dados do vendedor: ${sellerCode}`);
      
      const response = await this.makeRequest('/geral/vendedores/', 'ConsultarVendedor', {
        codigo: parseInt(sellerCode)
      });
      
      const sellerData = {
        name: response.nome || '',
        id: response.codigo?.toString() || sellerCode
      };
      
      // Armazenar no cache
      this.sellersCache.set(sellerCode, sellerData);
      return sellerData;
      
    } catch (error) {
      console.log(`⚠️ Erro ao buscar vendedor ${sellerCode}:`, error);
      return null;
    }
  }

  // Método para buscar dados de forma de pagamento
  async fetchPaymentMethod(paymentCode: string): Promise<string | null> {
    if (!paymentCode) return null;
    
    // Cache key
    const cacheKey = `payment_${paymentCode}`;
    if (this.paymentMethodsCache && this.paymentMethodsCache.has(cacheKey)) {
      return this.paymentMethodsCache.get(cacheKey) || null;
    }
    
    try {
      console.log(`🔍 Buscando forma de pagamento: ${paymentCode}`);
      
      const response = await this.makeRequest('/produtos/formaspagvendas/', 'ListarFormasPagVendas', {
        pagina: 1,
        registros_por_pagina: 100
      });
      
      // Procurar pelo código da forma de pagamento
      const paymentMethods = response.cadastros || [];
      const foundMethod = paymentMethods.find((method: any) => method.cCodigo === paymentCode);
      
      const paymentName = foundMethod ? foundMethod.cDescricao : paymentCode;
      console.log(`✅ Forma de pagamento encontrada: ${paymentCode} -> ${paymentName}`);
      
      // Inicializar cache se não existir
      if (!this.paymentMethodsCache) {
        this.paymentMethodsCache = new Map<string, string>();
      }
      
      // Armazenar no cache
      this.paymentMethodsCache.set(cacheKey, paymentName);
      
      return paymentName;
    } catch (error) {
      console.log(`⚠️ Erro ao buscar forma de pagamento ${paymentCode}:`, error);
      return null;
    }
  }

  // Método para consultar um pedido completo
  async fetchCompleteOrder(orderId: string): Promise<any | null> {
    if (!orderId) return null;
    
    try {
      console.log(`🔍 Consultando pedido completo: ${orderId}`);
      
      const response = await this.makeRequest('/produtos/pedido/', 'ConsultarPedido', {
        codigo_pedido: parseInt(orderId)
      });
      
      console.log(`✅ Pedido completo consultado: ${orderId}`);
      return response;
    } catch (error) {
      console.log(`⚠️ Erro ao consultar pedido completo ${orderId}:`, error);
      return null;
    }
  }

  // Método para buscar dados completos de um cliente específico
  async fetchClientData(clientCode: string): Promise<{fantasyName: string, companyName: string, rawData?: any} | null> {
    if (!clientCode) return null;
    
    // Verificar cache primeiro
    if (this.clientsCache.has(clientCode)) {
      return this.clientsCache.get(clientCode);
    }

    try {
      console.log(`🔍 Buscando dados do cliente: ${clientCode}`);
      
      const response = await this.makeRequest('/geral/clientes/', 'ConsultarCliente', {
        codigo_cliente_omie: parseInt(clientCode)
      });
      
      const clientData = {
        fantasyName: response.nome_fantasia || '',
        companyName: response.razao_social || '',
        rawData: response  // Incluir dados brutos para acessar recomendações
      };
      
      // Armazenar no cache
      this.clientsCache.set(clientCode, clientData);
      return clientData;
      
    } catch (error) {
      console.log(`⚠️ Erro ao buscar cliente ${clientCode}:`, error);
      return null;
    }
  }

  // Método para buscar configurações das etapas e seus nomes
  async fetchStageNames(): Promise<void> {
    if (this.stageNamesCache.size > 0) return; // Já carregado
    
    try {
      console.log('🔍 Carregando nomes das etapas do sistema...');
      
      const response = await this.makeRequest('/geral/etapas/', 'ListarEtapasFaturamento', {});
      const etapas = response.etapas || [];
      
      // Mapear códigos para nomes
      for (const etapa of etapas) {
        const codigo = etapa.cCodigo;
        const nome = etapa.cDescricao || etapa.cDescrPadrao || `Etapa ${codigo}`;
        this.stageNamesCache.set(codigo, nome);
        console.log(`📝 Etapa mapeada: ${codigo} -> ${nome}`);
      }
      
    } catch (error) {
      console.log('⚠️ Erro ao carregar nomes das etapas:', error);
      // Mapeamento de fallback para códigos comuns conforme processo da empresa
      this.stageNamesCache.set('10', 'Pedido de Venda');
      this.stageNamesCache.set('20', 'faturar');
      this.stageNamesCache.set('50', 'Faturado');
      this.stageNamesCache.set('60', 'Aguardando Rota');
      this.stageNamesCache.set('70', 'Em Rota');
      this.stageNamesCache.set('80', 'AGUARDANDO ENTREGA');
    }
  }

  // Método para buscar etapa de um pedido específico com nome E dados de faturamento
  async fetchPedidoStage(pedidoId: string): Promise<{stageName: string, invoiceData: any} | null> {
    if (!pedidoId) return null;
    
    // Verificar cache primeiro
    if (this.stagesCache.has(pedidoId)) {
      const stageCode = this.stagesCache.get(pedidoId);
      // Garantir que os nomes das etapas estão carregados
      await this.fetchStageNames();
      return this.stageNamesCache.get(stageCode) || stageCode;
    }

    try {
      console.log(`🔍 Buscando etapa do pedido: ${pedidoId}`);
      
      const response = await this.makeRequest('/produtos/pedidoetapas/', 'ListarEtapasPedido', {
        nPagina: 1,
        nRegPorPagina: 50,
        nCodPed: parseInt(pedidoId)
      });
      
      // Pegar a etapa mais recente ordenando por data e hora
      const etapas = response.etapasPedido || [];
      
      if (etapas.length === 0) {
        console.log(`⚠️ Nenhuma etapa encontrada para o pedido ${pedidoId}`);
        return null;
      }
      
      // Ordenar etapas por data e hora (mais recente primeiro)
      const etapasOrdenadas = etapas.sort((a: any, b: any) => {
        const dateTimeA = new Date(`${a.dDtEtapa} ${a.cHrEtapa}`);
        const dateTimeB = new Date(`${b.dDtEtapa} ${b.cHrEtapa}`);
        return dateTimeB.getTime() - dateTimeA.getTime(); // Mais recente primeiro
      });
      
      const ultimaEtapaCode = etapasOrdenadas[0].cEtapa;
      console.log(`📅 Etapas encontradas: ${etapas.length}, ordenando por data/hora...`);
      console.log(`📍 Etapa mais recente: ${ultimaEtapaCode} em ${etapasOrdenadas[0].dDtEtapa} ${etapasOrdenadas[0].cHrEtapa}`);
      
      // NOVO: Buscar dados de faturamento das etapas
      let stageInvoiceData = null;
      console.log(`🔍 DEBUG: Verificando faturamento em ${etapasOrdenadas.length} etapas...`);
      
      for (const etapa of etapasOrdenadas) {
        console.log(`🔍 DEBUG: Etapa ${etapa.cEtapa} - faturamento:`, JSON.stringify(etapa.faturamento, null, 2));
        
        if (etapa.faturamento && etapa.faturamento.cFaturado === 'S' && etapa.faturamento.cNumNFE) {
          stageInvoiceData = {
            omieInvoiceId: etapa.faturamento.cNumNFE || '',
            invoiceNumber: etapa.faturamento.cNumNFE || '',
            invoiceDate: etapa.faturamento.dDtFat ? this.parseOmieDate(etapa.faturamento.dDtFat) : null
          };
          console.log(`📋 ✅ Dados de faturamento encontrados nas etapas: NF=${stageInvoiceData.invoiceNumber}, Data=${etapa.faturamento.dDtFat}`);
          break; // Pegar o primeiro encontrado (mais recente com faturamento)
        }
      }
      
      if (!stageInvoiceData) {
        console.log(`⚠️ Nenhum dado de faturamento encontrado nas etapas do pedido ${pedidoId}`);
      } else {
        console.log(`✅ SALVANDO dados de faturamento no cache: invoice_${pedidoId}`, stageInvoiceData);
      }
      
      // Armazenar código no cache
      this.stagesCache.set(pedidoId, ultimaEtapaCode);
      
      // Garantir que os nomes das etapas estão carregados
      await this.fetchStageNames();
      
      // Retornar nome da etapa
      const stageName = this.stageNamesCache.get(ultimaEtapaCode) || ultimaEtapaCode;
      console.log(`📝 Etapa encontrada: ${ultimaEtapaCode} -> ${stageName}`);
      
      // Armazenar dados de faturamento no cache também (usar um cache específico para isso)
      if (stageInvoiceData) {
        this.stagesCache.set(`invoice_${pedidoId}`, stageInvoiceData);
        console.log(`💾 Cache atualizado com dados de faturamento para pedido ${pedidoId}:`, stageInvoiceData);
      }
      
      return {
        stageName: stageName,
        invoiceData: stageInvoiceData
      };
      
    } catch (error) {
      console.log(`⚠️ Erro ao buscar etapa do pedido ${pedidoId}:`, error);
      return null;
    }
  }

  // ==================== MÉTODOS DE FATURAMENTO ====================
  
  // Método para listar TODOS os pedidos (faturados e não faturados) com paginação
  async listOrders(page: number = 1, pageSize: number = 50): Promise<any> {
    try {
      console.log(`🔍 Listando TODOS os pedidos - Página ${page} (${pageSize} registros) - 🗓️ FILTRO: A partir de 01/09/2025...`);
      
      const payload = {
        call: 'ListarPedidos',
        param: [{
          pagina: page,
          registros_por_pagina: pageSize,
          apenas_importado_api: 'N',
          filtrar_por_data_de: '01/09/2025', // 🗓️ FILTRO: Apenas pedidos de setembro 2025
          filtrar_por_data_ate: '30/09/2025' // Final de setembro 2025
        }]
      };

      console.log(`📤 Enviando payload ListarPedidos (parâmetros seguros):`, JSON.stringify({ call: payload.call, paramCount: payload.param.length }, null, 2));
      
      const response = await this.makeRequest('/produtos/pedido/', payload.call, payload.param[0]);
      console.log(`✅ Resposta ListarPedidos recebida: ${response.pedido_venda_produto?.length || 0} pedidos encontrados`);
      
      return response;
    } catch (error) {
      console.error('❌ Erro ao listar pedidos:', error);
      throw error;
    }
  }

  // Método legado para listar apenas notas fiscais (manter para compatibilidade)
  async listInvoices(page: number = 1, pageSize: number = 50): Promise<any> {
    try {
      console.log(`🔍 Listando notas fiscais - Página ${page} (${pageSize} registros)...`);
      
      const payload = {
        call: 'ListarNF',
        param: [{
          pagina: page,
          registros_por_pagina: pageSize,
          filtrar_apenas_inclusao: 'N',
          filtrar_por_data_de: '', // Deixar vazio para buscar todas
          filtrar_por_data_ate: '' // Deixar vazio para buscar todas
        }]
      };

      console.log(`📤 Enviando payload ListarNF (parâmetros seguros):`, JSON.stringify({ call: payload.call, paramCount: payload.param.length }, null, 2));
      
      const response = await this.makeRequest('/produtos/nfconsultar/', payload.call, payload.param[0]);
      console.log(`✅ Resposta ListarNF recebida: ${response.nfCadastro?.length || 0} notas encontradas`);
      
      return response;
    } catch (error) {
      console.error('❌ Erro ao listar notas fiscais:', error);
      throw error;
    }
  }

  // Método NOVO para sincronizar TODOS os pedidos do Omie (faturados e não faturados)
  async syncAllOrders(): Promise<{
    totalProcessed: number;
    imported: number;
    updated: number;
    errors: any[];
  }> {
    try {
      console.log(`🔄 Sincronizando TODOS os pedidos do Omie (faturados e não faturados)...`);
      console.log(`🔐 Chaves configuradas: app_key=${this.appKey ? 'SIM' : 'NÃO'}, app_secret=${this.appSecret ? 'SIM' : 'NÃO'}`);
      
      let totalProcessed = 0;
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: any[] = [];
      
      let page = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        try {
          console.log(`📄 Processando página ${page}...`);
          
          const response = await this.listOrders(page, 50);
          
          const orders = response.pedido_venda_produto || [];
          console.log(`📊 Página ${page}: Encontrados ${orders.length} pedidos`);
          
          // Debug: mostrar estrutura da resposta na primeira página
          if (page === 1) {
            console.log(`🔍 DEBUG: Estrutura da resposta da API:`, JSON.stringify({
              hasPedidos: !!response.pedido_venda_produto,
              totalRegistros: response.total_de_registros,
              pagina: response.pagina,
              keys: Object.keys(response)
            }, null, 2));
            
            if (orders.length > 0) {
              console.log(`🔍 DEBUG: Primeiro pedido:`, JSON.stringify(orders[0], null, 2));
            }
          }
          
          if (orders.length === 0) {
            console.log(`⚠️ Página ${page}: Nenhum pedido encontrado. Parando sincronização.`);
            hasMorePages = false;
            break;
          }
          
          for (const order of orders) {
            try {
              const billingData = await this.transformOrderToBilling(order);
              if (billingData) {
                // Usar validação centralizada para salvar no storage
                const result = await this.storage.saveBillingIfValid(billingData);
                
                if (result.success) {
                  if (result.action === 'created') {
                    imported++;
                  } else if (result.action === 'updated') {
                    updated++;
                  }
                  totalProcessed++;
                } else {
                  // Registro rejeitado pela validação
                  console.log(`⚠️ REJEITADO - Pedido ${order.numero_pedido}: ${result.reason}`);
                  errors.push({ 
                    orderNumber: order.numero_pedido, 
                    error: `Validation failed: ${result.reason}`,
                    type: 'validation_rejected'
                  });
                }
              }
            } catch (error: any) {
              console.error(`❌ Erro ao processar pedido ${order.numero_pedido}:`, error);
              errors.push({ 
                orderNumber: order.numero_pedido, 
                error: error.message,
                type: 'processing_error'
              });
            }
          }
          
          page++;
          
          // Limite para evitar loop infinito
          if (page > 1000) {
            console.log('⚠️ Limite de 1000 páginas atingido, parando sincronização');
            hasMorePages = false;
          }
          
        } catch (error: any) {
          console.error(`❌ Erro na página ${page}:`, error);
          console.error(`❌ Stack trace:`, error.stack);
          errors.push({ 
            page, 
            error: error.message,
            details: error.response?.data || error.toString()
          });
          hasMorePages = false;
        }
      }
      
      console.log(`✅ Sincronização de pedidos concluída: ${totalProcessed} processados, ${imported} importados, ${updated} atualizados, ${skipped} rejeitados`);
      
      return {
        totalProcessed,
        imported,
        updated,
        skipped,
        errors
      };
      
    } catch (error) {
      console.error('❌ Erro ao sincronizar pedidos:', error);
      throw error;
    }
  }

  // Método LEGADO para sincronizar apenas notas fiscais 
  async syncBillingsInRange(startDate: string, endDate: string): Promise<{
    totalProcessed: number;
    imported: number;
    updated: number;
    errors: any[];
  }> {
    try {
      console.log(`🔄 Sincronizando TODAS as notas fiscais do Omie (sem filtro de data)...`);
      console.log(`🔐 Chaves configuradas: app_key=${this.appKey ? 'SIM' : 'NÃO'}, app_secret=${this.appSecret ? 'SIM' : 'NÃO'}`);
      
      let totalProcessed = 0;
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: any[] = [];
      
      let page = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        try {
          console.log(`📄 Processando página ${page}...`);
          
          const response = await this.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
            pagina: page,
            registros_por_pagina: 50,
            apenas_importado_api: 'N',
            filtrar_por_data_de: '', // SEM FILTRO - busca todas as notas
            filtrar_por_data_ate: '', // SEM FILTRO - busca todas as notas
            ordenar_por: 'DATA',
            ordem_decrescente: 'S'
          });
          
          const invoices = response.nfCadastro || [];
          console.log(`📊 Página ${page}: Encontradas ${invoices.length} notas fiscais`);
          
          // Debug: mostrar estrutura da resposta na primeira página
          if (page === 1) {
            console.log(`🔍 DEBUG: Estrutura da resposta da API:`, JSON.stringify({
              hasNfCadastro: !!response.nfCadastro,
              totalRegistros: response.total_de_registros,
              pagina: response.pagina,
              keys: Object.keys(response)
            }, null, 2));
            
            if (invoices.length > 0) {
              console.log(`🔍 DEBUG: Primeira nota fiscal:`, JSON.stringify(invoices[0], null, 2));
            }
          }
          
          if (invoices.length === 0) {
            console.log(`⚠️ Página ${page}: Nenhuma nota fiscal encontrada. Parando sincronização.`);
            hasMorePages = false;
            break;
          }
          
          for (const invoice of invoices) {
            try {
              const billingData = await this.transformInvoiceToBilling(invoice);
              if (billingData) {
                // Usar validação centralizada para salvar no storage
                const result = await this.storage.saveBillingIfValid(billingData);
                
                if (result.success) {
                  if (result.action === 'created') {
                    imported++;
                  } else if (result.action === 'updated') {
                    updated++;
                  }
                  totalProcessed++;
                } else {
                  // Registro rejeitado pela validação
                  console.log(`⚠️ REJEITADO - NF ${invoice.ide?.nNF}: ${result.reason}`);
                  skipped++;
                  errors.push({ 
                    invoiceNumber: invoice.ide?.nNF, 
                    error: `Validation failed: ${result.reason}`,
                    type: 'validation_rejected'
                  });
                }
              }
            } catch (error: any) {
              console.error(`❌ Erro ao processar nota ${invoice.ide?.nNF}:`, error);
              errors.push({ 
                invoiceNumber: invoice.ide?.nNF, 
                error: error.message,
                type: 'processing_error'
              });
            }
          }
          
          page++;
          
          // Limite para evitar loop infinito
          if (page > 1000) {
            console.log('⚠️ Limite de 1000 páginas atingido, parando sincronização');
            hasMorePages = false;
          }
          
        } catch (error: any) {
          console.error(`❌ Erro na página ${page}:`, error);
          console.error(`❌ Stack trace:`, error.stack);
          errors.push({ 
            page, 
            error: error.message,
            details: error.response?.data || error.toString()
          });
          hasMorePages = false;
        }
      }
      
      console.log(`✅ Sincronização concluída: ${totalProcessed} processadas, ${imported} importadas, ${updated} atualizadas, ${skipped} rejeitadas`);
      
      return {
        totalProcessed,
        imported,
        updated,
        skipped,
        errors
      };
      
    } catch (error) {
      console.error('❌ Erro ao sincronizar faturamentos:', error);
      throw error;
    }
  }

  // Método para transformar dados de PEDIDOS do Omie para formato do sistema
  private async transformOrderToBilling(order: any): Promise<any> {
    try {
      // DEBUG: Mostrar estrutura do pedido
      console.log(`🔧 DEBUG: Estrutura do pedido recebido:`, JSON.stringify({
        cabecalho: order.cabecalho,
        faturamento: order.faturamento,
        keys: Object.keys(order)
      }, null, 2));
      
      // ESTRUTURA CORRETA da API do Omie (baseado na documentação oficial)
      const orderNumber = order.cabecalho?.numero_pedido?.toString() || '';
      const omieOrderId = order.cabecalho?.codigo_pedido?.toString() || '';
      const clientCode = order.cabecalho?.codigo_cliente?.toString() || '';
      const etapa = order.cabecalho?.etapa || '';
      
      console.log(`🔧 Transformando pedido: ${orderNumber} (ID: ${omieOrderId})`);
      
      if (!orderNumber && !omieOrderId) {
        console.log('⚠️ Pedido sem número ou ID válido, ignorando...');
        console.log('🔧 DEBUG: Dados do cabeçalho:', JSON.stringify(order.cabecalho, null, 2));
        return null;
      }
      
      // Verificar se tem nota fiscal vinculada
      let omieInvoiceId = '';
      let invoiceNumber = '';
      let invoiceDate = null;
      
      // Buscar dados da NF se existir - estrutura correta da API
      if (order.faturamento?.cNumNFE || order.informacoes_adicionais?.numero_nf) {
        // Priorizar dados do faturamento
        omieInvoiceId = order.faturamento?.cNumNFE || order.informacoes_adicionais?.codigo_nf?.toString() || '';
        invoiceNumber = order.faturamento?.cNumNFE || order.informacoes_adicionais?.numero_nf || '';
        
        // Data de faturamento
        if (order.faturamento?.dDtFat) {
          invoiceDate = this.parseOmieDate(order.faturamento.dDtFat);
        } else if (order.informacoes_adicionais?.data_faturamento) {
          invoiceDate = this.parseOmieDate(order.informacoes_adicionais.data_faturamento);
        }
      }
      
      // Nome fantasia do cliente - buscar na API de clientes
      let customerFantasyName = '';
      let clientApiData = null;
      
      if (clientCode) {
        try {
          clientApiData = await this.fetchClientData(clientCode);
          if (clientApiData) {
            customerFantasyName = clientApiData.fantasyName || clientApiData.companyName;
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar nome fantasia do cliente ${clientCode}:`, error);
        }
      }
      
      // Fallbacks caso não consiga buscar pela API
      if (!customerFantasyName) {
        customerFantasyName = order.cliente?.razao_social ||
                             order.cliente?.nome_fantasia ||
                             order.cabecalho?.cliente ||
                             'Cliente não encontrado';
      }
      const customerDocument = order.cliente?.cnpj_cpf || '';
      
      console.log(`🔧 IDs extraídos: omieOrderId=${omieOrderId}, orderNumber=${orderNumber}, invoiceNumber=${invoiceNumber}`);
      
      // CFOP - pegar do primeiro produto
      const cfop = order.det?.[0]?.produto?.cfop || '';
      
      // Data do pedido
      const orderDate = order.cabecalho?.data_previsao ? 
        this.parseOmieDate(order.cabecalho.data_previsao) : 
        new Date();
      
      // Valor total do pedido
      const totalValue = order.total_pedido?.valor_total_pedido || 
                        order.total_pedido?.valor_mercadorias || 
                        order.cabecalho?.valor_total || 0;
      
      // Dados do título/financeiro
      const dueDate = order.lista_parcelas?.parcela?.[0]?.data_vencimento ? 
        this.parseOmieDate(order.lista_parcelas.parcela[0].data_vencimento) : null;
      // Nota: paymentMethod será extraído no código mais abaixo usando fetchPaymentMethod()
      
      // Vendedor - buscar das recomendações do cliente (onde realmente está)
      let sellerCode = order.cabecalho?.codigo_vendedor?.toString() || 
                       order.informacoes_adicionais?.codigo_vendedor?.toString();
      
      // Se não encontrou no pedido, buscar das recomendações do cliente
      if (!sellerCode && clientApiData && clientApiData.rawData) {
        sellerCode = clientApiData.rawData.recomendacoes?.codigo_vendedor?.toString();
        console.log(`🔍 Código do vendedor extraído das recomendações do cliente: ${sellerCode}`);
      }
      
      let sellerName = '';
      let sellerId = null;
      let paymentMethod = '';
      
      if (sellerCode) {
        try {
          const sellerData = await this.fetchSellerData(sellerCode);
          if (sellerData) {
            sellerName = sellerData.name;
            sellerId = sellerData.id;
            console.log(`✅ Vendedor extraído: ${sellerCode} -> ${sellerName}`);
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar dados do vendedor ${sellerCode}:`, error);
        }
      } else {
        console.log(`⚠️ Código do vendedor não encontrado para o pedido ${orderNumber}`);
      }
      
      // Buscar forma de pagamento baseada no código da parcela
      const parcelaCode = order.cabecalho?.codigo_parcela || '';
      if (parcelaCode) {
        try {
          const payment = await this.fetchPaymentMethod(parcelaCode);
          if (payment) {
            paymentMethod = payment;
            console.log(`✅ Forma de pagamento extraída: ${parcelaCode} -> ${paymentMethod}`);
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar forma de pagamento ${parcelaCode}:`, error);
        }
      }
      
      // Etapa do pedido E dados de faturamento das etapas
      let invoiceStage = '';
      
      if (omieOrderId) {
        try {
          const stageResult = await this.fetchPedidoStage(omieOrderId);
          if (stageResult) {
            invoiceStage = stageResult.stageName;
            
            // NOVO: Aplicar dados de faturamento das etapas diretamente
            if (!omieInvoiceId && !invoiceNumber && stageResult.invoiceData) {
              omieInvoiceId = stageResult.invoiceData.omieInvoiceId;
              invoiceNumber = stageResult.invoiceData.invoiceNumber;
              invoiceDate = stageResult.invoiceData.invoiceDate;
              console.log(`📋 ✅ APLICANDO dados de faturamento das etapas DIRETO: NF=${invoiceNumber}, Data=${invoiceDate?.toLocaleDateString()}`);
            }
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar etapa do pedido ${omieOrderId}:`, error);
          // Usar etapa do cabeçalho como fallback
          invoiceStage = etapa || '';
        }
      }
      
      // Determinar tipo de faturamento
      let billingType = 'venda';
      if (order.informacoes_adicionais?.tipo_operacao) {
        const tipoOp = order.informacoes_adicionais.tipo_operacao.toLowerCase();
        if (tipoOp.includes('troca')) billingType = 'troca';
        else if (tipoOp.includes('amostra')) billingType = 'amostra';
      }
      
      // Produtos do pedido
      const products = (order.det || []).map((item: any) => ({
        code: item.produto?.codigo_produto || '',
        description: item.produto?.descricao || '',
        quantity: item.produto?.quantidade || 0,
        unitPrice: item.produto?.valor_unitario || 0,
        totalPrice: item.produto?.valor_total || 0,
      }));
      
      console.log(`✅ Pedido validado: ID=${omieOrderId}, Número=${orderNumber}, Cliente=${customerFantasyName}`);
      
      const billingData = {
        omieOrderId,
        orderNumber,
        omieInvoiceId: omieInvoiceId || null,
        invoiceNumber: invoiceNumber || null,
        customerFantasyName,
        customerDocument,
        cfop,
        invoiceDate,
        orderDate,
        totalValue: parseFloat(totalValue.toString()) || 0,
        dueDate,
        paymentMethod,
        sellerName,
        omieCustomerCode: clientCode,
        sellerId,
        billingType,
        invoiceStatus: this.mapSefazStatus('emitida'), // Pedidos faturados sempre têm status "emitida"
        invoiceStage,
        products
      };
      
      console.log(`🔧 DEBUG BILLING STATUS: invoiceStatus="${billingData.invoiceStatus}", mapeado de "emitida"`);
      
      return billingData;
      
    } catch (error) {
      console.error(`❌ Erro ao transformar pedido:`, error);
      console.error(`❌ Dados do pedido que causou erro:`, JSON.stringify(order, null, 2));
      return null;
    }
  }

  // Método para transformar dados da API Omie para formato do sistema (LEGADO - apenas notas fiscais)
  private async transformInvoiceToBilling(invoice: any): Promise<any> {
    try {
      console.log(`🔧 Transformando nota fiscal: ${invoice.ide?.nNF || 'SEM_NUMERO'}`);
      
      // Extrair campos conforme mapeamento do debug NF 23369
      const omieInvoiceId = invoice.ide?.nIdNF?.toString() || invoice.ide?.cNF?.toString() || '';
      const invoiceNumber = invoice.ide?.nNF?.toString() || invoice.ide?.cNF?.toString() || '';
      // Nome fantasia do cliente - buscar na API de clientes
      let customerFantasyName = '';
      let clientCode = invoice.nfDestInt?.nCodCli?.toString();
      
      if (clientCode) {
        try {
          const clientData = await this.fetchClientData(clientCode);
          if (clientData) {
            customerFantasyName = clientData.fantasyName || clientData.companyName;
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar nome fantasia do cliente ${clientCode}:`, error);
        }
      }
      
      // Fallbacks caso não consiga buscar pela API
      if (!customerFantasyName) {
        customerFantasyName = invoice.dest?.xNome ||                  // Fallback 1
                             invoice.destinatario?.razao_social ||   // Fallback 2
                             invoice.cliente?.razao_social ||        // Fallback 3
                             invoice.nfDestInt?.cRazao ||            // Fallback 4
                             '';
      }
      const customerDocument = invoice.dest?.cCNPJCPF || '';
      
      console.log(`🔧 IDs extraídos: omieId=${omieInvoiceId}, number=${invoiceNumber}`);
      
      // Data de emissão
      const invoiceDate = invoice.ide?.dEmi ? this.parseOmieDate(invoice.ide.dEmi) : null;
      
      // Valor total da nota
      const totalValue = invoice.total?.ICMSTot?.vNF || 0;
      
      // CFOP - extrair do primeiro produto
      const cfop = invoice.det?.[0]?.prod?.CFOP || '5101';
      
      // Dados do título/financeiro
      const titulo = invoice.titulos?.[0] || {};
      const dueDate = titulo.dDtVenc ? this.parseOmieDate(titulo.dDtVenc) : null;
      
      // Usar clientCode já definido anteriormente ou buscar alternativas
      if (!clientCode) {
        clientCode = invoice.dest?.nIdDest?.toString() || invoice.cliente?.codigo_cliente_omie?.toString();
      }
      let sellerName = '';
      let sellerId = null;
      let paymentMethod = '';
      
      // Buscar vendedor através do cliente
      if (clientCode) {
        try {
          const clientApiData = await this.fetchClientData(clientCode);
          if (clientApiData && clientApiData.rawData) {
            const sellerCode = clientApiData.rawData.recomendacoes?.codigo_vendedor?.toString();
            if (sellerCode) {
              console.log(`🔍 Código do vendedor extraído das recomendações do cliente: ${sellerCode}`);
              const sellerData = await this.fetchSellerData(sellerCode);
              if (sellerData) {
                sellerName = sellerData.name;
                sellerId = sellerData.id;
                console.log(`✅ Vendedor extraído: ${sellerCode} -> ${sellerName}`);
              }
            }
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar dados do cliente/vendedor ${clientCode}:`, error);
        }
      }
      
      // Fallback: buscar vendedor do título se não encontrou pelo cliente
      if (!sellerName) {
        const sellerCode = titulo.nCodVendedor?.toString();
        if (sellerCode) {
          try {
            const sellerData = await this.fetchSellerData(sellerCode);
            if (sellerData) {
              sellerName = sellerData.name;
              sellerId = sellerData.id;
              console.log(`✅ Vendedor extraído do título: ${sellerCode} -> ${sellerName}`);
            }
          } catch (error) {
            console.log(`⚠️ Erro ao buscar dados do vendedor ${sellerCode}:`, error);
          }
        }
      }
      
      // Buscar forma de pagamento correta - primeiro do pedido relacionado se existir
      let pedidoId = invoice.compl?.nIdPedido?.toString();
      if (pedidoId) {
        try {
          console.log(`🔍 Buscando forma de pagamento do pedido relacionado: ${pedidoId}`);
          const pedidoCompleto = await this.fetchCompleteOrder(pedidoId);
          if (pedidoCompleto) {
            const parcelaCode = pedidoCompleto.cabecalho?.codigo_parcela;
            if (parcelaCode) {
              const payment = await this.fetchPaymentMethod(parcelaCode);
              if (payment) {
                paymentMethod = payment;
                console.log(`✅ Forma de pagamento extraída do pedido: ${parcelaCode} -> ${paymentMethod}`);
              }
            }
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar forma de pagamento do pedido ${pedidoId}:`, error);
        }
      }
      
      // Fallback: buscar forma de pagamento do título
      if (!paymentMethod) {
        const formaPagCod = titulo.cFormaPag || titulo.cCodFormaPag;
        if (formaPagCod) {
          try {
            const payment = await this.fetchPaymentMethod(formaPagCod);
            if (payment) {
              paymentMethod = payment;
              console.log(`✅ Forma de pagamento extraída do título: ${formaPagCod} -> ${paymentMethod}`);
            }
          } catch (error) {
            console.log(`⚠️ Erro ao buscar forma de pagamento ${formaPagCod}:`, error);
          }
        }
      }
      
      // Se ainda não encontrou, usar descrição do documento como fallback
      if (!paymentMethod) {
        paymentMethod = titulo.cDoc || 'Não informado';
      }
      
      // Etapa da nota fiscal - buscar do pedido relacionado  
      let invoiceStage = invoice.ide?.cEtapa || '';
      // pedidoId já foi definido anteriormente
      
      if (pedidoId && !invoiceStage) {
        try {
          const stageData = await this.fetchPedidoStage(pedidoId);
          if (stageData && stageData.stageName) {
            invoiceStage = stageData.stageName;
          }
        } catch (error) {
          console.log(`⚠️ Erro ao buscar etapa do pedido ${pedidoId}:`, error);
        }
      }
      
      // LOG para debug - ver estrutura dos dados rejeitados e dados do cliente
      if (!omieInvoiceId && !invoiceNumber) {
        console.log('🔍 DEBUG - Estrutura da nota rejeitada:', JSON.stringify({
          ide: invoice.ide,
          nIdNF: invoice.ide?.nIdNF,
          nNF: invoice.ide?.nNF,
          cNF: invoice.ide?.cNF
        }, null, 2));
      }
      
      // Usar número da NF como fallback para ID se necessário
      const finalOmieId = omieInvoiceId || invoiceNumber;
      const finalInvoiceNumber = invoiceNumber || omieInvoiceId;

      // Debug para nome do cliente se estiver vazio
      if (!customerFantasyName && finalInvoiceNumber) {
        console.log('🔍 DEBUG - Dados do destinatário vazios para NF:', finalInvoiceNumber);
        console.log('  nfDestInt:', JSON.stringify(invoice.nfDestInt, null, 2));
        console.log('  dest:', JSON.stringify(invoice.dest, null, 2));
        console.log('  destinatario:', JSON.stringify(invoice.destinatario, null, 2));
        console.log('  cliente:', JSON.stringify(invoice.cliente, null, 2));
      }
      
      // Validação mais flexível - aceitar qualquer ID válido
      if (!omieInvoiceId && !invoiceNumber) {
        console.log('⚠️ Nota fiscal sem ID ou número válido, ignorando');
        console.log('🔍 DEBUG - Estrutura ide:', JSON.stringify(invoice.ide, null, 2));
        return null;
      }
      
      console.log(`✅ Nota validada: ID=${finalOmieId}, Número=${finalInvoiceNumber}`);
      
      const billingData = {
        omieInvoiceId: finalOmieId,
        invoiceNumber: finalInvoiceNumber,
        customerFantasyName,
        customerDocument,
        cfop,
        invoiceDate,
        totalValue: parseFloat(totalValue.toString()),
        dueDate,
        paymentMethod,
        sellerName,
        sellerId,
        billingType: this.determineBillingType(cfop),
        invoiceStatus: this.mapSefazStatus(
          invoice.infNFe?.cStat ||          // Status SEFAZ numérico (preferencial)
          invoice.protNFe?.infProt?.cStat || // Status de protocolo
          invoice.ide?.cStat ||             // Status na identificação
          'emitida'                         // Fallback para emitida/100
        ),
        invoiceStage: typeof invoiceStage === 'string' ? invoiceStage.substring(0, 100) : '', // Truncar para 100 caracteres com verificação de tipo
        
        // Produtos da nota
        products: invoice.det?.map((item: any) => ({
          code: item.prod?.cProd || '',
          description: item.prod?.xProd || '',
          quantity: parseFloat(item.prod?.qCom || '0'),
          unitPrice: parseFloat(item.prod?.vUnCom || '0'),
          totalPrice: parseFloat(item.prod?.vProd || '0')
        })) || []
      };
      
      return billingData;
      
    } catch (error: any) {
      console.error('❌ Erro ao transformar dados da nota fiscal:', error);
      return null;
    }
  }

  // Método auxiliar para converter data do Omie (DD/MM/YYYY) para Date
  private parseOmieDate(omieDate: string): Date | null {
    try {
      if (!omieDate || typeof omieDate !== 'string') return null;
      
      // Formato esperado: DD/MM/YYYY
      const parts = omieDate.split('/');
      if (parts.length !== 3) return null;
      
      const [day, month, year] = parts;
      const dayNum = parseInt(day);
      const monthNum = parseInt(month);
      const yearNum = parseInt(year);
      
      // Validações para evitar datas inválidas
      if (isNaN(dayNum) || isNaN(monthNum) || isNaN(yearNum)) return null;
      if (yearNum < 1900 || yearNum > 2100) return null;
      if (monthNum < 1 || monthNum > 12) return null;
      if (dayNum < 1 || dayNum > 31) return null;
      
      const date = new Date(yearNum, monthNum - 1, dayNum);
      return isNaN(date.getTime()) ? null : date;
    } catch (error) {
      console.error('❌ Erro ao converter data do Omie:', omieDate, error);
      return null;
    }
  }

  // Método para buscar uma nota fiscal específica pelo número
  async getInvoiceByNumber(invoiceNumber: string): Promise<any> {
    try {
      console.log(`🔍 Buscando NF ${invoiceNumber} na API do Omie usando ConsultarNF...`);
      console.log(`🔐 Chaves Omie: app_key=${this.appKey ? 'PRESENTE' : 'AUSENTE'}, app_secret=${this.appSecret ? 'PRESENTE' : 'AUSENTE'}`);
      
      // Usar ConsultarNF diretamente com o número da NF
      const payload = {
        call: 'ConsultarNF',
        app_key: this.appKey,
        app_secret: this.appSecret,
        param: [{
          nNF: invoiceNumber
        }]
      };
      
      console.log(`📤 Enviando payload:`, JSON.stringify({
        call: payload.call,
        app_key: payload.app_key ? 'HIDDEN' : 'MISSING',
        app_secret: payload.app_secret ? 'HIDDEN' : 'MISSING',
        param: payload.param
      }, null, 2));
      
      const response = await fetch('https://app.omie.com.br/api/v1/produtos/nfconsultar/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      console.log(`📥 Status da resposta: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`❌ Resposta de erro: ${errorText}`);
        throw new Error(`Erro HTTP: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log(`📋 Dados recebidos:`, JSON.stringify(data, null, 2));
      
      if (data.faultstring) {
        console.log(`❌ Erro da API Omie: ${data.faultstring}`);
        throw new Error(`Erro da API Omie: ${data.faultstring}`);
      }
      
      if (data) {
        console.log(`✅ NF ${invoiceNumber} encontrada com ConsultarNF!`);
        return data;
      }
      
      console.log(`❌ NF ${invoiceNumber} não encontrada`);
      return null;
    } catch (error: any) {
      console.error(`❌ Erro ao buscar NF ${invoiceNumber}:`, error);
      throw error;
    }
  }

  // Buscar cliente por código interno Omie
  async getClientByCode(codigoCliente: number): Promise<OmieClient | null> {
    try {
      const response = await this.makeRequest('/geral/clientes/', 'ConsultarCliente', {
        codigo_cliente_omie: codigoCliente
      });

      if (response && response.codigo_cliente_omie) {
        return OmieClientSchema.parse(response);
      }

      return null;
    } catch (error) {
      console.error('Erro ao buscar cliente no Omie:', error);
      throw error;
    }
  }

  // Verificar informações de crédito do cliente
  async getClientCreditInfo(cnpjCpf: string): Promise<OmieCreditInfo | null> {
    try {
      const client = await this.getClientByCnpjCpf(cnpjCpf);
      
      if (!client) {
        return null;
      }

      // Buscar informações financeiras do cliente
      const response = await this.makeRequest('/financas/contareceber/', 'ListarContasReceber', {
        filtrar_cliente: client.codigo_cliente_omie,
        apenas_pendentes: 'S'
      });

      let valorEmAberto = 0;
      let diasEmAtraso = 0;

      if (response && response.conta_receber_cadastro) {
        const contas = Array.isArray(response.conta_receber_cadastro) 
          ? response.conta_receber_cadastro 
          : [response.conta_receber_cadastro];

        for (const conta of contas) {
          valorEmAberto += conta.valor_documento || 0;
          
          if (conta.data_vencimento) {
            const vencimento = new Date(conta.data_vencimento);
            const hoje = new Date();
            const diffTime = hoje.getTime() - vencimento.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays > diasEmAtraso) {
              diasEmAtraso = diffDays;
            }
          }
        }
      }

      return {
        limite_credito: client.limite_credito || 0,
        valor_em_aberto: valorEmAberto,
        dias_em_atraso: Math.max(0, diasEmAtraso),
        bloqueado_financeiro: client.bloqueado || 'N',
      };
    } catch (error) {
      console.error('Erro ao buscar informações de crédito no Omie:', error);
      throw error;
    }
  }

  // Verificar se cliente está apto para nova venda
  async checkCreditApproval(cnpjCpf: string, valorVenda: number): Promise<{
    aprovado: boolean;
    motivo?: string;
    limiteCreditoDisponivel?: number;
    diasEmAtraso?: number;
  }> {
    try {
      // Primeiro, verificar se cliente está na lista de débitos vencidos
      const overdueDebts = await this.getOverdueDebts();
      const clienteComDebito = overdueDebts.debts.find(debt => 
        debt.cliente.cnpj_cpf === cnpjCpf
      );

      if (clienteComDebito) {
        return {
          aprovado: false,
          motivo: `Cliente com débitos vencidos: ${this.formatCurrency(clienteComDebito.valorTotal)}`,
          diasEmAtraso: clienteComDebito.diasMaximoAtraso
        };
      }

      const creditInfo = await this.getClientCreditInfo(cnpjCpf);
      
      if (!creditInfo) {
        return {
          aprovado: false,
          motivo: 'Cliente não encontrado no Omie'
        };
      }

      // Cliente bloqueado financeiramente
      if (creditInfo.bloqueado_financeiro === 'S') {
        return {
          aprovado: false,
          motivo: 'Cliente bloqueado financeiramente',
          diasEmAtraso: creditInfo.dias_em_atraso
        };
      }

      // Cliente com mais de 30 dias de atraso
      if ((creditInfo.dias_em_atraso || 0) > 30) {
        return {
          aprovado: false,
          motivo: `Cliente com ${creditInfo.dias_em_atraso} dias em atraso`,
          diasEmAtraso: creditInfo.dias_em_atraso
        };
      }

      // Verificar limite de crédito
      const limiteCredito = creditInfo.limite_credito || 0;
      const valorEmAberto = creditInfo.valor_em_aberto || 0;
      const limiteCreditoDisponivel = limiteCredito - valorEmAberto;

      if (limiteCredito > 0 && valorVenda > limiteCreditoDisponivel) {
        return {
          aprovado: false,
          motivo: 'Valor da venda excede limite de crédito disponível',
          limiteCreditoDisponivel
        };
      }

      return {
        aprovado: true,
        limiteCreditoDisponivel,
        diasEmAtraso: creditInfo.dias_em_atraso
      };
    } catch (error) {
      console.error('Erro ao verificar aprovação de crédito:', error);
      return {
        aprovado: false,
        motivo: 'Erro interno na consulta de crédito'
      };
    }
  }

  // Método auxiliar para formatação de moeda
  private formatCurrency(value: number): string {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  }

  // Criar pedido de venda no Omie
  async createSalesOrder(salesCard: any, customer: any, products: any[], paymentMethod?: string, operationType?: string): Promise<any> {
    try {
      console.log('Criando pedido no Omie para cliente:', customer.name);
      
      // Gerar número único para o pedido
      const orderNumber = `HS-${Date.now()}`;
      const integrationCode = `CRM-${salesCard.id}`;
      
      // Buscar código do cliente no Omie
      let omieClientCode = null;
      
      // Tentar encontrar cliente pelo CPF/CNPJ
      const document = customer.cnpj || customer.cpf;
      if (document) {
        const omieClient = await this.getClientByCnpjCpf(document);
        if (omieClient) {
          omieClientCode = omieClient.codigo_cliente_omie;
        }
      }

      if (!omieClientCode) {
        throw new Error('Cliente não encontrado no Omie ERP');
      }

      // Preparar detalhes dos produtos
      const orderItems = products.map((product, index) => ({
        ide: {
          codigo_item_integracao: `${integrationCode}-ITEM-${index + 1}`
        },
        produto: {
          codigo_produto_integracao: product.id,
          descricao: product.name,
          quantidade: product.quantity,
          valor_unitario: product.unitPrice
        }
      }));

      const totalValue = products.reduce((sum, p) => sum + (p.quantity * p.unitPrice), 0);

      // Determinar conta do Omie baseada no método de pagamento
      const omieAccountCode = paymentMethod 
        ? PAYMENT_METHOD_TO_OMIE_ACCOUNT[paymentMethod as keyof typeof PAYMENT_METHOD_TO_OMIE_ACCOUNT]
        : 2425423833; // Padrão: Caixinha (À vista)

      // Determinar código da parcela baseado no método de pagamento
      const parcelaCode = paymentMethod === 'boleto' ? '030' : '999'; // 30 dias para boleto, à vista para outros

      // Payload para API Omie (estrutura correta)
      const orderPayload = {
        cabecalho: {
          codigo_pedido_integracao: integrationCode,
          codigo_cliente: omieClientCode,
          data_previsao: new Date().toLocaleDateString('pt-BR'),
          etapa: "50", // Pedido de venda
          numero_pedido: orderNumber.slice(0, 15), // Máximo 15 caracteres
          codigo_parcela: parcelaCode,
          quantidade_itens: products.length
        },
        det: orderItems,
        frete: {
          modalidade: "9" // Sem ocorrência de transporte
        },
        informacoes_adicionais: {
          codigo_categoria: "1.01.03", // Categoria fiscal
          codigo_conta_corrente: omieAccountCode,
          consumidor_final: "S",
          enviar_email: "N",
          observacoes: `Pedido ${operationType || 'venda'} via CRM - Pagamento: ${paymentMethod || 'a_vista'} - Card: ${salesCard.id}`
        }
      };

      console.log('Enviando pedido para Omie:', orderNumber);
      console.log('Cliente Omie ID:', omieClientCode);
      console.log('Total de itens:', products.length);
      console.log('Valor total:', totalValue);

      const response = await this.makeRequest('/produtos/pedido/', 'IncluirPedido', orderPayload);

      if (response && response.codigo_pedido) {
        console.log('Pedido criado com sucesso no Omie:', response.codigo_pedido);
        return {
          codigo_pedido: response.codigo_pedido,
          numero_pedido: response.numero_pedido || orderNumber,
          codigo_status: response.codigo_status || '0',
          descricao_status: response.descricao_status || 'Pedido incluído com sucesso'
        };
      } else {
        throw new Error('Resposta inválida da API Omie');
      }

    } catch (error) {
      console.error('Erro ao criar pedido no Omie:', error);
      throw new Error(`Falha ao criar pedido no Omie: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  // Listar todos os clientes do Omie (ativos e inativos)
  async getAllClients(page = 1, pageSize = 50, includeInactive = false): Promise<{
    clients: OmieClient[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      const requestParams: any = {
        pagina: page,
        registros_por_pagina: pageSize,
        apenas_importado_api: 'N'
      };

      // Se queremos incluir inativos, adicionar filtro específico
      if (includeInactive) {
        requestParams.clientesFiltrar = {
          inativo: 'S'
        };
      }

      const response = await this.makeRequest('/geral/clientes/', 'ListarClientes', requestParams);

      const clients = response.clientes_cadastro || [];
      
      return {
        clients: clients.map((client: any) => {
          // Log para verificar campos disponíveis no primeiro cliente
          if (clients.indexOf(client) === 0) {
            console.log('📋 Campos disponíveis no cliente Omie:', Object.keys(client));
            console.log('📋 Situação do cliente:', client.situacao);
            console.log('📋 Inativo do cliente:', client.inativo);
          }
          
          // Garantir que todos os campos obrigatórios estão presentes
          return {
            codigo_cliente_omie: client.codigo_cliente_omie,
            cnpj_cpf: client.cnpj_cpf || '',
            razao_social: client.razao_social || '',
            nome_fantasia: client.nome_fantasia,
            email: client.email,
            telefone1_ddd: client.telefone1_ddd,
            telefone1_numero: client.telefone1_numero,
            endereco: client.endereco,
            endereco_numero: client.endereco_numero,
            bairro: client.bairro,
            cidade: client.cidade,
            estado: client.estado,
            cep: client.cep,
            bloqueado: client.bloqueado,
            inativo: client.inativo,
            situacao: client.situacao, // Adicionar campo situacao
            limite_credito: client.limite_credito
          };
        }),
        totalPages: response.total_de_paginas || 1,
        totalRecords: response.total_de_registros || 0,
        currentPage: page
      };
    } catch (error) {
      console.error('Erro ao listar clientes no Omie:', error);
      throw error;
    }
  }

  // Converter cliente do Omie para formato do sistema
  convertClientToSystemFormat(omieClient: OmieClient) {
    // Limpar e validar documento
    const documento = omieClient.cnpj_cpf || '';
    const docLimpo = documento.replace(/\D/g, '');
    const isCompany = docLimpo.length === 14;
    
    // Só incluir CPF/CNPJ se houver um documento válido
    let cpf = null;
    let cnpj = null;
    
    if (docLimpo.length === 11) {
      cpf = docLimpo;
    } else if (docLimpo.length === 14) {
      cnpj = docLimpo;
    }
    
    return {
      id: `omie-client-${omieClient.codigo_cliente_omie}`, // ID único baseado no código do Omie
      name: omieClient.razao_social || omieClient.nome_fantasia || 'Cliente sem nome',
      customerType: isCompany ? 'pessoa_juridica' as const : 'pessoa_fisica' as const,
      cpf,
      cnpj,
      companyName: omieClient.razao_social || null,
      fantasyName: omieClient.nome_fantasia || null,
      phone: omieClient.telefone1_ddd && omieClient.telefone1_numero 
        ? `(${omieClient.telefone1_ddd}) ${omieClient.telefone1_numero}`
        : '(00) 00000-0000',
      email: omieClient.email || 'sempreenchimento@omie.com.br',
      address: [
        omieClient.endereco,
        omieClient.endereco_numero && `nº ${omieClient.endereco_numero}`,
      ].filter(Boolean).join(', '),
      city: omieClient.cidade || '',
      state: omieClient.estado || '',
      zipCode: omieClient.cep || '',
      route: omieClient.bairro || '',
      // Usar campo 'situacao' como critério correto (se disponível) ou fallback para 'inativo'
      isActive: omieClient.situacao ? omieClient.situacao === 'ativo' : omieClient.inativo !== 'S',
      omieStatus: omieClient.situacao || (omieClient.inativo === 'S' ? 'inativo' : 'ativo'),
      situacao: omieClient.situacao || (omieClient.inativo === 'S' ? 'inativo' : 'ativo'), // Campo direto do Omie com fallback
      document: documento || null // Documento original apenas se houver
    };
  }

  // Sincronizar todos os clientes do Omie (ativos + inativos)
  async syncAllClients(): Promise<{
    totalProcessed: number;
    imported: number;
    updated: number;
    errors: string[];
  }> {
    try {
      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        errors: []
      };

      console.log('Iniciando sincronização COMPLETA de clientes (ativos + inativos)...');

      // PRIMEIRA PASSADA: Clientes ATIVOS (padrão)
      console.log('Sincronizando clientes ATIVOS...');
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await this.getAllClients(currentPage, 100, false); // false = apenas ativos
        
        for (const client of pageData.clients) {
          result.totalProcessed++;
          // Este método retorna apenas os dados formatados
          // A lógica de salvamento será feita na rota
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      console.log(`Clientes ativos processados: ${result.totalProcessed}`);

      // SEGUNDA PASSADA: Clientes INATIVOS 
      console.log('Sincronizando clientes INATIVOS...');
      currentPage = 1;
      hasMorePages = true;

      while (hasMorePages) {
        const pageData = await this.getAllClients(currentPage, 100, true); // true = apenas inativos
        
        for (const client of pageData.clients) {
          result.totalProcessed++;
          // Este método retorna apenas os dados formatados
          // A lógica de salvamento será feita na rota
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      console.log(`Total de clientes processados (ativos + inativos): ${result.totalProcessed}`);

      return result;
    } catch (error) {
      console.error('Erro ao sincronizar clientes do Omie:', error);
      throw error;
    }
  }

  // Buscar débitos em atraso - TODOS os títulos vencidos
  async getOverdueDebts(): Promise<{
    debts: any[];
    totalAmount: number;
    totalClients: number;
  }> {
    try {
      const executionId = Date.now();
      console.log(`[EXEC-${executionId}] Starting comprehensive overdue debts query with situacao filter...`);
      
      const hoje = new Date();
      const debtorsMap = new Map();
      let totalAmount = 0;
      let totalProcessed = 0;
      
      // Implementar paginação para buscar TODOS os títulos
      let currentPage = 1;
      let hasMorePages = true;
      const pageSize = 500; // Aumentar para processar mais registros por vez
      
      while (hasMorePages) {
        console.log(`Fetching page ${currentPage} with ${pageSize} records...`);
        
        const response = await this.makeRequest('/financas/contareceber/', 'ListarContasReceber', {
          pagina: currentPage,
          registros_por_pagina: pageSize,
          apenas_importado_api: 'N'
        });

        // Diferentes endpoints podem ter estruturas diferentes
        const contas = response.conta_receber_cadastro || 
                       response.cadastro || 
                       response.contasReceber || 
                       response.lista_contas_receber || 
                       [];

        console.log(`Page ${currentPage}: Found ${contas.length} accounts to process`);
        
        // Log básico para debug
        if (currentPage <= 2) {
          console.log(`\n=== DEBUG PÁGINA ${currentPage} ===`);
          console.log(`Total de contas na página: ${contas.length}`);
        }

        let contaIndex = 0;
        for (const conta of contas) {
          contaIndex++;
          totalProcessed++;
          
          // Log primeiras contas para debug
          if (totalProcessed <= 10) {
            console.log(`\nConta ${totalProcessed + 1}:`);
            console.log(`  Numero: ${conta.numero_documento}`);
            console.log(`  Data previsao: ${conta.data_previsao}`);
            console.log(`  Status: ${conta.status_titulo}`);
            console.log(`  Valor: ${conta.valor_documento}`);
          }
          
          if (!conta.data_previsao) {
            if (totalProcessed <= 5) console.log(`  -> SEM DATA DE PREVISÃO, pulando`);
            continue;
          }
          
          // Converter data de PREVISÃO do formato brasileiro DD/MM/YYYY
          const [dia, mes, ano] = conta.data_previsao.split('/');
          const dataPrevisao = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia));
          const diffTime = hoje.getTime() - dataPrevisao.getTime();
          const diasAtraso = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (totalProcessed <= 10) {
            console.log(`  -> Data hoje: ${hoje.toLocaleDateString()}`);
            console.log(`  -> Data previsão: ${dataPrevisao.toLocaleDateString()}`);
            console.log(`  -> Dias atraso: ${diasAtraso}`);
          }

          // FILTRO: Títulos com previsão de recebimento vencida (diasAtraso > 0) E que estão REALMENTE em aberto
          const isVencido = diasAtraso > 0;
          
          // Lista rígida de status que indicam títulos PAGOS/CANCELADOS/RESOLVIDOS
          const statusesFechados = ['RECEBIDO', 'CANCELADO', 'LIQUIDADO', 'BAIXADO', 'PAGO', 'QUITADO', 'COMPENSADO', 'ESTORNADO'];
          const isAberto = !statusesFechados.includes(conta.status_titulo);
          
          // Log dos status encontrados para entender quais estão sendo incluídos
          if (isVencido && totalProcessed <= 30) {
            console.log(`  Status: ${conta.status_titulo} - ${isAberto ? '✓ INCLUÍDO' : '✗ EXCLUÍDO'} - Doc: ${conta.numero_documento} - Valor: ${conta.valor_documento} - Dias: ${diasAtraso}`);
          }
          
          if (isVencido && isAberto) {
            const clientId = conta.codigo_cliente_fornecedor;
            const valor = parseFloat(conta.valor_documento || '0');
            
            if (valor > 0) {
              totalAmount += valor;

              if (!debtorsMap.has(clientId)) {
                // Buscar dados reais do cliente no Omie (com cache para otimizar)
                let clienteCompleto;
                try {
                  clienteCompleto = await this.getClientByCode(clientId);
                } catch (error) {
                  console.warn(`Failed to fetch client ${clientId}, using basic data`);
                }
                
                const clienteBasico = clienteCompleto ? {
                  codigo_cliente_omie: clienteCompleto.codigo_cliente_omie,
                  nome_fantasia: clienteCompleto.nome_fantasia || clienteCompleto.razao_social,
                  cnpj_cpf: clienteCompleto.cnpj_cpf
                } : {
                  codigo_cliente_omie: clientId,
                  nome_fantasia: conta.razao_social || conta.nome_fantasia || `Cliente ${clientId}`,
                  cnpj_cpf: conta.cpf_cnpj || 'Documento não informado'
                };
                
                debtorsMap.set(clientId, {
                  cliente: clienteBasico,
                  debitos: [],
                  valorTotal: 0,
                  diasMaximoAtraso: 0,
                  vendedores: new Set() // Para agrupar vendedores únicos do cliente
                });
              }

              const debtor = debtorsMap.get(clientId);
              debtor.debitos.push({
                numero_documento: conta.numero_documento || 'N/A',
                numero_documento_fiscal: conta.numero_documento_fiscal || 'N/A',
                codigo_lancamento_omie: conta.codigo_lancamento_omie,
                valor: valor,
                data_vencimento: conta.data_vencimento,
                data_previsao: conta.data_previsao,
                data_emissao: conta.data_emissao || '',
                dias_atraso: diasAtraso,
                observacao: conta.observacao || '',
                status_titulo: conta.status_titulo || 'N/A',
                // Novos campos solicitados
                nota_fiscal_cupom: conta.numero_documento_fiscal || conta.numero_documento || 'N/A',
                tipo_documento: conta.codigo_tipo_documento || 'N/A',
                codigo_vendedor: conta.codigo_vendedor || null
              });
              debtor.valorTotal += valor;
              debtor.diasMaximoAtraso = Math.max(debtor.diasMaximoAtraso, diasAtraso);
              
              // Adicionar vendedor ao conjunto se existir
              if (conta.codigo_vendedor) {
                debtor.vendedores.add(conta.codigo_vendedor);
              }
            }
          }
        }

        // Verificar se há mais páginas
        const totalPages = response.total_de_paginas || 1;
        const totalRegistros = response.total_de_registros || 0;
        
        console.log(`Page ${currentPage}/${totalPages} - Total records: ${totalRegistros}`);
        
        currentPage++;
        hasMorePages = currentPage <= totalPages && contas.length === pageSize;
      }

      // Converter Sets de vendedores para arrays antes de retornar
      const debtsList = Array.from(debtorsMap.values()).map(debtor => ({
        ...debtor,
        vendedores: Array.from(debtor.vendedores)
      }));

      const result = {
        debts: debtsList,
        totalAmount,
        totalClients: debtorsMap.size
      };
      
      console.log(`Processamento completo: ${totalProcessed} registros analisados`);
      console.log(`Débitos vencidos encontrados: ${result.totalClients} clientes, Total: R$ ${result.totalAmount.toFixed(2)}`);
      
      console.log(`[${new Date().toISOString()}] Overdue debts fetch complete - returning ${result.totalClients} clients`);
      
      return result;
    } catch (error) {
      console.error('Erro ao buscar débitos em atraso no Omie:', error);
      // Retornar estrutura vazia para não quebrar a aplicação
      return {
        debts: [],
        totalAmount: 0,
        totalClients: 0
      };
    }
  }

  // Função auxiliar para converter data brasileira DD/MM/YYYY para Date
  private parseBrazilianDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    
    const parts = dateStr.split('/');
    if (parts.length !== 3) return null;
    
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // JavaScript mês começa em 0
    const year = parseInt(parts[2], 10);
    
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    
    return new Date(year, month, day);
  }

  // Método para sincronizar faturamentos/notas fiscais do Omie
  async syncBillings(): Promise<{
    totalProcessed: number;
    imported: number;
    updated: number;
    errors: any[];
    isComplete: boolean;
    message: string;
  }> {
    try {
      console.log('🔄 Iniciando sincronização de faturamentos a partir de 01/09/2025 (apenas NF-e autorizadas)...');
      
      let totalProcessed = 0;
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: any[] = [];
      
      let page = 1;
      let hasMorePages = true;
      const maxRecordsPerSync = 10000; // Processar até 10.000 notas por vez (sem limite prático)
      let recordsProcessedThisSync = 0;
      let pagesWithoutValidData = 0;
      const maxPagesWithoutData = 5; // Parar se 5 páginas consecutivas sem dados válidos
      
      while (hasMorePages) {
        try {
          console.log(`📄 Processando página ${page}...`);
          
          const response = await this.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
            pagina: page,
            registros_por_pagina: 50,
            apenas_importado_api: 'N',
            filtrar_por_data_de: '01/09/2025', // FILTRAR desde 1º de setembro
            filtrar_por_data_ate: '', // Até hoje (sem limite superior)
            ordenar_por: 'DATA',
            ordem_decrescente: 'S'
          });
          
          const invoices = response.nfCadastro || [];
          console.log(`📊 Página ${page}: Encontradas ${invoices.length} notas fiscais - Processando...`);
          
          
          if (invoices.length === 0) {
            hasMorePages = false;
            break;
          }
          
          let pageHasValidData = false;
          
          for (const invoice of invoices) {
            try {
              // Validar campos obrigatórios
              const omieInvoiceId = invoice.ide?.nIdNF?.toString() || invoice.ide?.nNF?.toString();
              const invoiceNumber = invoice.ide?.nNF || '';
              
              // DEBUG: Capturar detalhes da NF 23369 para análise
              if (invoiceNumber === '23369') {
                console.log('\n🔍 DEBUG NF 23369 - ESTRUTURA COMPLETA:');
                console.log('='.repeat(60));
                console.log('📋 CAMPOS IDE (identificação):');
                console.log('ide.dEmi:', invoice.ide?.dEmi);
                console.log('ide.dSaiEnt:', invoice.ide?.dSaiEnt);
                console.log('ide.dhEmi:', invoice.ide?.dhEmi);
                console.log('ide.dhSaiEnt:', invoice.ide?.dhSaiEnt);
                
                console.log('\n📋 CAMPOS TITULOS (financeiro):');
                if (invoice.titulos?.length > 0) {
                  invoice.titulos.forEach((titulo: any, idx: number) => {
                    console.log(`titulo[${idx}].dDtEmissao:`, titulo.dDtEmissao);
                    console.log(`titulo[${idx}].dReg:`, titulo.dReg);
                    console.log(`titulo[${idx}].dDtVencimento:`, titulo.dDtVencimento);
                  });
                }
                
                console.log('\n📋 CAMPOS INFO (meta-dados):');
                console.log('info.dInc:', invoice.info?.dInc);
                console.log('info.dAlt:', invoice.info?.dAlt);
                
                console.log('\n📋 TODOS OS CAMPOS DO INVOICE:');
                console.log(JSON.stringify(invoice, null, 2));
                console.log('='.repeat(60));
              }
              
              // Buscar data de faturamento - priorizar dEmi (data de emissão da nota fiscal)
              let invoiceDate = '';
              // Usar PRIMEIRO a data de emissão da nota fiscal (dEmi)
              invoiceDate = invoice.ide?.dEmi || invoice.ide?.dSaiEnt || '';
              // Buscar valor total nos diferentes campos possíveis
              const totalValue = parseFloat(
                invoice.total?.ICMSTot?.vNF || 
                invoice.total?.vNF || 
                invoice.titulos?.[0]?.nValorTitulo?.toString() || 
                '0'
              );
              
              // Pular se não tiver ID ou número da nota
              if (!omieInvoiceId || !invoiceNumber) {
                console.warn(`⚠️ Nota fiscal sem ID ou número válido, pulando...`);
                continue;
              }
              
              // Validar e converter data brasileira
              const invoiceDateObj = this.parseBrazilianDate(invoiceDate);
              if (!invoiceDateObj || isNaN(invoiceDateObj.getTime())) {
                console.warn(`⚠️ Data inválida para nota ${invoiceNumber} (${invoiceDate}), pulando...`);
                continue;
              }
              
              // Processar todas as notas filtradas por data
              
              pageHasValidData = true;
              
              // Extrair dados do cliente e vendedor diretamente da nota fiscal
              const clientCode = invoice.dest?.codigo_cliente_omie || invoice.nfDestInt?.nCodCli;
              
              // Buscar nome fantasia do cliente
              let customerFantasyName = 'Cliente não identificado';
              if (clientCode) {
                try {
                  const clientData = await this.getClientByCode(parseInt(clientCode.toString()));
                  customerFantasyName = clientData?.nome_fantasia || clientData?.razao_social || invoice.nfDestInt?.cRazao || 'Cliente não identificado';
                } catch (error: any) {
                  console.log(`⚠️ Erro ao buscar dados do cliente ${clientCode}:`, error?.message || error);
                  customerFantasyName = invoice.nfDestInt?.cRazao || invoice.dest?.xNome || 'Cliente não identificado';
                }
              } else {
                customerFantasyName = invoice.nfDestInt?.cRazao || invoice.dest?.xNome || 'Cliente não identificado';
              }
              
              const customerDocument = invoice.nfDestInt?.cnpj_cpf || invoice.dest?.CNPJ || invoice.dest?.CPF || '';
              
              // Extrair vendedor dos títulos (se disponível)
              let sellerId = '';
              let sellerName = '';
              if (invoice.titulos && invoice.titulos.length > 0) {
                const firstTitle = invoice.titulos[0];
                if (firstTitle.nCodVendedor) {
                  sellerId = firstTitle.nCodVendedor.toString();
                }
              }
              
              // Determinar tipo de faturamento (simplificado)
              let billingType: 'venda' | 'troca' | 'amostra' = 'venda';
              const operationDescription = invoice.ide?.xJust || invoice.infAdic?.infCpl || '';
              if (operationDescription.toLowerCase().includes('troca')) {
                billingType = 'troca';
              } else if (operationDescription.toLowerCase().includes('amostra')) {
                billingType = 'amostra';
              }
              
              // Extrair produtos da nota fiscal
              const products = (invoice.det || []).map((item: any) => ({
                code: item.prod?.cProd || '',
                description: item.prod?.xProd || '',
                quantity: parseFloat(item.prod?.qCom || '0'),
                unitPrice: parseFloat(item.prod?.vUnCom || '0'),
                totalPrice: parseFloat(item.prod?.vProd || '0')
              }));
              
              // Determinar método de pagamento
              let paymentMethod = '';
              if (invoice.pag?.detPag) {
                const paymentDetail = Array.isArray(invoice.pag.detPag) ? invoice.pag.detPag[0] : invoice.pag.detPag;
                switch (paymentDetail.tPag) {
                  case '01':
                    paymentMethod = 'Dinheiro';
                    break;
                  case '03':
                    paymentMethod = 'Cartão de Crédito';
                    break;
                  case '04':
                    paymentMethod = 'Cartão de Débito';
                    break;
                  case '05':
                    paymentMethod = 'Crédito Loja';
                    break;
                  case '15':
                    paymentMethod = 'Boleto Bancário';
                    break;
                  case '17':
                    paymentMethod = 'PIX';
                    break;
                  default:
                    paymentMethod = 'Outros';
                }
              }
              
              // Data de vencimento (se houver) - validação robusta
              let dueDate = null;
              if (invoice.cobr?.dup && invoice.cobr.dup.length > 0) {
                const firstDup = Array.isArray(invoice.cobr.dup) ? invoice.cobr.dup[0] : invoice.cobr.dup;
                if (firstDup.dVenc) {
                  const dueDateParsed = this.parseBrazilianDate(firstDup.dVenc);
                  if (dueDateParsed && !isNaN(dueDateParsed.getTime())) {
                    dueDate = dueDateParsed;
                  }
                }
              }
              
              const billingData = {
                omieInvoiceId,
                invoiceNumber,
                customerFantasyName: customerFantasyName || 'Cliente não identificado',
                billingType,
                totalValue,
                invoiceDate: invoiceDateObj,
                sellerId: sellerId || '',
                sellerName: sellerName || '',
                paymentMethod: paymentMethod || '',
                dueDate: dueDate && !isNaN(dueDate.getTime()) ? dueDate : null,
                omieCustomerCode: clientCode?.toString() || '',
                customerDocument: customerDocument || '',
                invoiceStatus: this.mapSefazStatus(invoice.ide?.cStat || ''),
                products
              };
              
              // Usar validação centralizada para salvar
              const result = await this.storage.saveBillingIfValid(billingData);
              
              if (result.success) {
                if (result.action === 'created') {
                  imported++;
                } else if (result.action === 'updated') {
                  updated++;
                }
                totalProcessed++;
                recordsProcessedThisSync++;
              } else {
                // Registro rejeitado pela validação
                console.log(`⚠️ REJEITADO - NF ${invoiceNumber}: ${result.reason}`);
                skipped++;
                recordsProcessedThisSync++; // Contar como processado para limite
              }
              
              // Parar se já processamos o suficiente nesta sincronização
              if (recordsProcessedThisSync >= maxRecordsPerSync) {
                console.log(`🛑 Limite de ${maxRecordsPerSync} registros atingido nesta sincronização. Próxima sincronização continuará de onde parou.`);
                hasMorePages = false;
                break;
              }
              
              // Log a cada 10 notas processadas para acompanhamento
              if (totalProcessed % 10 === 0) {
                console.log(`📈 Processadas ${totalProcessed} notas fiscais...`);
              }
              
            } catch (error) {
              // Pular apenas este registro específico em caso de erro
              errors.push({
                invoice: invoice.ide?.nNF || 'Desconhecida',
                error: error instanceof Error ? error.message : 'Erro desconhecido'
              });
              continue; // Continuar com próxima nota
            }
          }
          
          // Verificar se há mais páginas
          const totalPages = response.total_de_paginas || 1;
          hasMorePages = page < totalPages && recordsProcessedThisSync < maxRecordsPerSync;
          page++;
          
          // Verificar se esta página teve dados válidos
          if (!pageHasValidData) {
            pagesWithoutValidData++;
            console.log(`⚠️ Página ${page-1} sem dados válidos (${pagesWithoutValidData}/${maxPagesWithoutData})`);
            
            if (pagesWithoutValidData >= maxPagesWithoutData) {
              console.log(`🛑 ${maxPagesWithoutData} páginas consecutivas sem dados válidos, parando sincronização...`);
              hasMorePages = false;
              break;
            }
          } else {
            pagesWithoutValidData = 0; // Reset contador
          }
          
          // Log de progresso
          console.log(`📈 Página ${page-1} concluída. Processadas: ${totalProcessed}, Importadas: ${imported}`);
          
        } catch (pageError) {
          console.error(`❌ Erro ao processar página ${page}:`, pageError);
          errors.push({
            page,
            error: pageError instanceof Error ? pageError.message : 'Erro desconhecido'
          });
          hasMorePages = false;
        }
      }
      
      console.log(`✅ Sincronização de faturamentos concluída:`);
      console.log(`📊 Total processado: ${totalProcessed}`);
      console.log(`📥 Importados: ${imported}`);
      console.log(`🔄 Atualizados: ${updated}`);
      console.log(`⚠️ Rejeitados: ${skipped}`);
      console.log(`❌ Erros: ${errors.length}`);
      
      const isComplete = recordsProcessedThisSync < maxRecordsPerSync;
      
      return {
        totalProcessed,
        imported,
        updated,
        skipped,
        errors,
        isComplete,
        message: `Sincronização concluída. Total: ${totalProcessed}, Importados: ${imported}, Atualizados: ${updated}, Rejeitados: ${skipped}. ${recordsProcessedThisSync} registros processados nesta execução.`
      };
      
    } catch (error) {
      console.error('❌ Erro na sincronização de faturamentos:', error);
      throw error;
    }
  }

  // Listar todos os vendedores ativos do Omie - buscar TODAS as páginas
  async getAllVendors(page = 1, pageSize = 50): Promise<{
    vendors: OmieVendor[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      // Buscar TODAS as páginas de vendedores para garantir que não perca nenhum
      let allVendors: any[] = [];
      let currentPage = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        const response = await this.makeRequest('/geral/vendedores/', 'ListarVendedores', {
          pagina: currentPage,
          registros_por_pagina: pageSize,
          apenas_importado_api: 'N'
        });

        const vendors = response.cadastro || response.vendedores_cadastro || [];
        console.log(`Página ${currentPage}: Encontrados ${vendors.length} vendedores`);
        
        allVendors = allVendors.concat(vendors);
        
        // Verificar se há mais páginas
        const totalPages = response.total_de_paginas || 1;
        hasMorePages = currentPage < totalPages;
        currentPage++;
      }
      
      console.log(`Total de vendedores encontrados em todas as páginas: ${allVendors.length}`);
      
      const mappedVendors = allVendors.map((vendor: any) => ({
        codigo: vendor.codigo,
        nome: vendor.nome,
        email: vendor.email,
        telefone: vendor.telefone,
        inativo: vendor.inativo,
        comissao: vendor.comissao
      }));

      // Filtrar apenas vendedores ativos
      const activeVendors = mappedVendors.filter((vendor: any) => vendor.inativo !== 'S');
      console.log(`Vendedores ativos filtrados: ${activeVendors.length} de ${mappedVendors.length}`);
      
      // Log dos nomes dos vendedores ativos para verificar se Mariangela está incluída
      console.log('Vendedores ativos encontrados:', activeVendors.map(v => v.nome).sort());
      
      return {
        vendors: activeVendors,
        totalPages: 1, // Como agregamos tudo, é só uma página
        totalRecords: activeVendors.length,
        currentPage: 1
      };
    } catch (error) {
      console.error('Erro ao listar vendedores no Omie:', error);
      throw error;
    }
  }

  // Listar etapas de faturamento disponíveis
  async getAvailableStages(): Promise<any[]> {
    try {
      const response = await this.makeRequest('/produtos/pedido/', 'ListarEtapasFaturamento', {});
      
      // A resposta pode vir em diferentes formatos dependendo da versão
      const stages = response.etapas || response.lista_etapas || [];
      console.log('Etapas de faturamento disponíveis:', stages);
      
      return stages.filter((stage: any) => stage.cInativo !== 'S'); // Apenas etapas ativas
    } catch (error) {
      console.error('Erro ao buscar etapas de faturamento:', error);
      return [];
    }
  }

  // Listar pedidos por etapa do Omie
  async getOrdersByStage(stage: string, page = 1, pageSize = 50): Promise<{
    orders: any[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      let allOrders: any[] = [];
      let currentPage = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        try {
          const response = await this.makeRequest('/produtos/pedido/', 'ListarPedidosVenda', {
            pagina: currentPage,
            registros_por_pagina: pageSize,
            etapa: stage, // Filtrar por etapa específica
            apenas_importado_api: 'N'
          });

          const orders = response.pedido_venda_produto || [];
          console.log(`Página ${currentPage}: Encontrados ${orders.length} pedidos na etapa ${stage}`);
          
          allOrders = allOrders.concat(orders);
          
          // Verificar se há mais páginas
          const totalPages = response.total_de_paginas || 1;
          hasMorePages = currentPage < totalPages;
          currentPage++;
        } catch (error: any) {
          // Tratar caso específico onde não há registros na etapa
          const errorMessage = error.message || '';
          const errorResponse = error.response || '';
          
          // Verificar se é o erro específico de "não existem registros"
          const isNoRecordsError = errorMessage.includes('500 Internal Server Error') && 
                                  (errorResponse.includes('NÃ£o existem registros para a pÃ¡gina') ||
                                   errorResponse.includes('Não existem registros para a página'));
          
          if (isNoRecordsError) {
            console.log(`Nenhum pedido encontrado na etapa ${stage} - retornando lista vazia`);
            hasMorePages = false;
            break;
          }
          
          // Se for outro tipo de erro, rejeitar
          console.error(`Erro não tratado na etapa ${stage}:`, error);
          throw error;
        }
      }
      
      console.log(`Total de pedidos encontrados na etapa ${stage}: ${allOrders.length}`);
      
      // Mapear e enriquecer os pedidos com dados dos clientes
      const enrichedOrders = await Promise.all(
        allOrders.map(async (order: any) => {
          try {
            // Buscar dados do cliente
            const clientResponse = await this.makeRequest('/geral/clientes/', 'ConsultarCliente', {
              codigo_cliente_omie: order.cabecalho?.codigo_cliente
            });

            return {
              codigo_pedido: order.cabecalho?.codigo_pedido,
              numero_pedido: order.cabecalho?.numero_pedido,
              codigo_cliente: order.cabecalho?.codigo_cliente,
              cliente: {
                nome_fantasia: clientResponse.nome_fantasia || 'Cliente não encontrado',
                cnpj_cpf: clientResponse.cnpj_cpf || '',
              },
              etapa: order.cabecalho?.etapa,
              data_pedido: order.cabecalho?.data_pedido,
              qtde_itens: order.cabecalho?.qtde_itens || 0,
              valor_total_pedido: parseFloat(order.cabecalho?.valor_total_pedido || '0'),
              codigo_vendedor: order.cabecalho?.codigo_vendedor,
              vendedor: order.cabecalho?.vendedor
            };
          } catch (error) {
            console.error(`Erro ao buscar cliente ${order.cabecalho?.codigo_cliente}:`, error);
            return {
              codigo_pedido: order.cabecalho?.codigo_pedido,
              numero_pedido: order.cabecalho?.numero_pedido,
              codigo_cliente: order.cabecalho?.codigo_cliente,
              cliente: {
                nome_fantasia: 'Cliente não encontrado',
                cnpj_cpf: '',
              },
              etapa: order.cabecalho?.etapa,
              data_pedido: order.cabecalho?.data_pedido,
              qtde_itens: order.cabecalho?.qtde_itens || 0,
              valor_total_pedido: parseFloat(order.cabecalho?.valor_total_pedido || '0'),
              codigo_vendedor: order.cabecalho?.codigo_vendedor,
              vendedor: order.cabecalho?.vendedor
            };
          }
        })
      );
      
      return {
        orders: enrichedOrders,
        totalPages: 1, // Como agregamos tudo, é só uma página
        totalRecords: enrichedOrders.length,
        currentPage: 1
      };
    } catch (error) {
      console.error(`Erro ao listar pedidos da etapa ${stage} no Omie:`, error);
      throw error;
    }
  }

  // Listar todos os produtos ativos do Omie
  async getAllProducts(page = 1, pageSize = 50): Promise<{
    products: OmieProduct[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      const response = await this.makeRequest('/geral/produtos/', 'ListarProdutos', {
        pagina: page,
        registros_por_pagina: pageSize,
        apenas_importado_api: 'N'
      });

      console.log('Resposta da API Omie produtos:', JSON.stringify(response, null, 2));

      const products = response.produto_servico_cadastro || [];
      console.log(`Encontrados ${products.length} produtos na página ${page}`);
      
      const mappedProducts = products.map((product: any) => ({
        codigo_produto: product.codigo_produto,
        codigo: product.codigo,
        descricao: product.descricao,
        unidade: product.unidade,
        valor_unitario: product.valor_unitario,
        inativo: product.inativo,
        ncm: product.ncm,
        ean: product.ean,
        peso_liq: product.peso_liq,
        altura: product.altura,
        largura: product.largura,
        profundidade: product.profundidade
      }));

      console.log('Produtos mapeados:', mappedProducts);
      
      // Como todos os produtos no Omie estão marcados como inativos, vamos importar todos
      // e marcar como ativos no sistema (podem ser desativados manualmente depois)
      console.log(`Produtos encontrados: ${mappedProducts.length} (todos serão importados como ativos)`);
      
      return {
        products: mappedProducts, // Importar todos os produtos
        totalPages: response.total_de_paginas || 1,
        totalRecords: response.total_de_registros || 0,
        currentPage: page
      };
    } catch (error) {
      console.error('Erro ao listar produtos no Omie:', error);
      throw error;
    }
  }

  // Converter vendedor do Omie para formato do sistema
  convertVendorToSystemFormat(omieVendor: OmieVendor) {
    return {
      id: `omie-vendor-${omieVendor.codigo}`, // ID único baseado no código do Omie
      firstName: omieVendor.nome.split(' ')[0] || '',
      lastName: omieVendor.nome.split(' ').slice(1).join(' ') || '',
      email: omieVendor.email || '',
      role: 'vendedor' as const,
      route: 'geral',
      isActive: omieVendor.inativo !== 'S' // Respeitar status do Omie
    };
  }

  // Converter produto do Omie para formato do sistema
  convertProductToSystemFormat(omieProduct: OmieProduct) {
    return {
      name: omieProduct.descricao,
      code: omieProduct.codigo || omieProduct.codigo_produto.toString(),
      price: omieProduct.valor_unitario || 0,
      stock: 0, // Sempre iniciar com estoque 0
      isActive: true, // Importar todos como ativos (pode ser editado depois)
      omieId: omieProduct.codigo_produto,
      ncm: omieProduct.ncm || '',
      ean: omieProduct.ean || '',
      inactiveInOmie: omieProduct.inativo === 'S', // Guardar status do Omie separadamente
      weight: omieProduct.peso_liq || 0,
      dimensions: {
        height: omieProduct.altura || 0,
        width: omieProduct.largura || 0,
        depth: omieProduct.profundidade || 0
      }
    };
  }


  // Atualizar pedido existente no Omie com informações de entrega
  async updateOrderDeliveryStatus(omieOrderId: string, salesCard: any): Promise<any> {
    try {
      const deliveryStatusMap = {
        'pending': 'ENTREGA: Aguardando entrega',
        'in_transit': 'ENTREGA: Em trânsito', 
        'delivered': 'ENTREGA: Entregue com sucesso',
        'failed': 'ENTREGA: Falha na entrega - verificar com cliente',
        'returned': 'ENTREGA: Produto devolvido'
      };

      const deliveryInfo = salesCard.deliveryStatus 
        ? deliveryStatusMap[salesCard.deliveryStatus as keyof typeof deliveryStatusMap] || ''
        : '';

      const deliveryDate = salesCard.deliveryCompletedDate 
        ? `\nEntregue em: ${new Date(salesCard.deliveryCompletedDate).toLocaleString('pt-BR')}` 
        : '';

      const trackingInfo = salesCard.trackingCode 
        ? `\nRastreamento: ${salesCard.trackingCode}` 
        : '';

      const failureReason = salesCard.deliveryFailureReason && salesCard.deliveryStatus === 'failed'
        ? `\nMotivo: ${this.getFailureReasonLabel(salesCard.deliveryFailureReason)}`
        : '';

      const observacoes = `Pedido CRM: ${salesCard.id}\n${deliveryInfo}${deliveryDate}${trackingInfo}${failureReason}`.trim();

      // Determinar nova etapa
      let etapa = '10';
      if (salesCard.deliveryStatus === 'delivered') {
        etapa = '60';
      } else if (salesCard.deliveryStatus === 'failed') {
        etapa = '50';
      } else if (salesCard.deliveryStatus === 'in_transit') {
        etapa = '50';
      }

      const response = await this.makeRequest('/produtos/pedidovenda/', 'AlterarPedidoVenda', {
        pedido_venda_produto: {
          codigo_pedido: omieOrderId,
          observacoes,
          etapa
        }
      });

      return response;
    } catch (error) {
      console.error('Erro ao atualizar pedido no Omie:', error);
      throw error;
    }
  }

  private getFailureReasonLabel(reason: string): string {
    const reasonLabels = {
      'customer_absent': 'Cliente ausente',
      'address_incorrect': 'Endereço incorreto',
      'customer_refused': 'Cliente recusou',
      'payment_issue': 'Problema no pagamento',
      'product_damaged': 'Produto danificado',
      'other': 'Outros motivos'
    };
    
    return reasonLabels[reason as keyof typeof reasonLabels] || reason;
  }
}

// Singleton instance - configuração será feita via variáveis de ambiente
let omieService: OmieService | null = null;

export function getOmieService(storage?: any): OmieService | null {
  if (!process.env.OMIE_APP_KEY || !process.env.OMIE_APP_SECRET) {
    return null;
  }
  
  return new OmieService({
    appKey: process.env.OMIE_APP_KEY,
    appSecret: process.env.OMIE_APP_SECRET,
  }, storage);
}

export function isOmieConfigured(): boolean {
  return !!(process.env.OMIE_APP_KEY && process.env.OMIE_APP_SECRET);
}

// Função para importar produtos ativos do Omie
export async function importActiveProducts(): Promise<{
  totalProcessed: number;
  imported: number;
  errors: string[];
}> {
  try {
    const result = {
      totalProcessed: 0,
      imported: 0,
      errors: [] as string[]
    };

    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      // Buscar produtos do Omie
      const payload = {
        call: 'ListarProdutos',
        app_key: process.env.OMIE_APP_KEY,
        app_secret: process.env.OMIE_APP_SECRET,
        param: [{
          pagina: currentPage,
          registros_por_pagina: 50,
          apenas_importado_api: 'N'
        }]
      };

      const response = await fetch('https://app.omie.com.br/api/v1/geral/produtos/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Erro API Omie: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.faultstring) {
        throw new Error(`Erro Omie: ${data.faultstring}`);
      }

      const products = data.produto_servico_cadastro || [];
      
      for (const product of products) {
        result.totalProcessed++;
        
        // Filtro mais rigoroso para produtos realmente ativos
        const isInactive = product.inativo === 'S' || product.inativo === 'true' || product.inativo === true;
        const isBlocked = product.bloqueado === 'S' || product.bloqueado === 'true' || product.bloqueado === true;
        
        if (isInactive || isBlocked) {
          console.log(`Pulando produto inativo/bloqueado: ${product.descricao} (inativo: ${product.inativo}, bloqueado: ${product.bloqueado})`);
          continue;
        }

        // Verificar se o produto tem preço válido (produtos sem preço podem estar inativos na prática)
        if (!product.valor_unitario || product.valor_unitario <= 0) {
          console.log(`Pulando produto sem preço: ${product.descricao}`);
          continue;
        }

        try {
          // Buscar estoque do produto
          let stockQuantity = 0;
          try {
            const stockPayload = {
              call: 'ConsultarPosEstoque',
              app_key: process.env.OMIE_APP_KEY,
              app_secret: process.env.OMIE_APP_SECRET,
              param: [{
                codigo_produto: product.codigo_produto
              }]
            };

            const stockResponse = await fetch('https://app.omie.com.br/api/v1/estoque/consulta/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(stockPayload),
            });

            if (stockResponse.ok) {
              const stockData = await stockResponse.json();
              if (!stockData.faultstring && stockData.saldo_estoque) {
                stockQuantity = stockData.saldo_estoque || 0;
              }
            }
          } catch (stockError) {
            console.log(`Não foi possível obter estoque para produto ${product.codigo}: ${stockError}`);
          }

          // Converter produto do Omie para formato do sistema
          const systemProduct = {
            id: `omie-product-${product.codigo_produto}`,
            name: product.descricao || 'Produto sem nome',
            description: product.descricao_detalhada || product.descricao || '',
            price: product.valor_unitario || 0,
            categoryId: 'categoria-sucos', // Categoria padrão baseada na imagem
            isActive: true,
            stockQuantity: stockQuantity,
            unit: product.unidade || 'UN',
            omieProductId: product.codigo_produto,
            omieCode: product.codigo || product.codigo_produto.toString(),
            ncm: product.ncm || '',
            ean: product.ean || '',
            weight: product.peso_liq || 0,
            height: product.altura || 0,
            width: product.largura || 0,
            depth: product.profundidade || 0
          };

          console.log(`Importando produto ativo: ${systemProduct.name} (Estoque: ${stockQuantity})`);
          result.imported++;
          
          // Aqui você salvaria no banco - será implementado na rota
          
        } catch (productError: any) {
          result.errors.push(`Erro ao processar produto ${product.codigo || 'N/A'}: ${productError?.message || 'Erro desconhecido'}`);
        }
      }

      // Verificar se há mais páginas
      const totalPages = Math.ceil((data.total_de_registros || 0) / 50);
      hasMorePages = currentPage < totalPages;
      currentPage++;
    }

    return result;
  } catch (error: any) {
    console.error('Erro ao importar produtos do Omie:', error);
    throw new Error(`Falha na importação: ${error.message}`);
  }
}

// Função para criar pedido no Omie
export async function createOmieOrder(orderData: {
  customer: {
    document: string;
    name: string;
    email: string;
    phone: string;
    address: string;
  };
  products: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  totalValue: number;
  orderNumber: string;
  sellerId: string;
  paymentMethod?: string;
  operationType?: string;
}) {
  const omieService = OmieService.createFromEnv();

  try {
    // 1. Buscar ou criar cliente no Omie
    let omieCustomerId;
    try {
      const existingCustomer = await omieService.getClientByCnpjCpf(orderData.customer.document);
      if (existingCustomer) {
        omieCustomerId = existingCustomer.codigo_cliente_omie;
        console.log('Cliente encontrado no Omie:', omieCustomerId);
      } else {
        throw new Error('Cliente não encontrado');
      }
    } catch (error) {
      // Cliente não existe, criar novo
      console.log('Criando novo cliente no Omie...');
      // Criar cliente diretamente via API
      const clientPayload = {
        call: 'IncluirCliente',
        app_key: process.env.OMIE_APP_KEY,
        app_secret: process.env.OMIE_APP_SECRET,
        param: [{
          cnpj_cpf: orderData.customer.document,
          razao_social: orderData.customer.name,
          nome_fantasia: orderData.customer.name,
          email: orderData.customer.email,
          telefone1_numero: orderData.customer.phone,
          endereco: orderData.customer.address
        }]
      };

      const clientResponse = await fetch('https://app.omie.com.br/api/v1/geral/clientes/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clientPayload),
      });

      if (!clientResponse.ok) {
        throw new Error(`Erro ao criar cliente: ${clientResponse.status}`);
      }

      const newCustomer = await clientResponse.json();
      
      if (newCustomer.faultstring) {
        throw new Error(`Erro Omie cliente: ${newCustomer.faultstring}`);
      }
      omieCustomerId = newCustomer.codigo_cliente_omie;
      console.log('Cliente criado no Omie:', omieCustomerId);
    }

    // 2. Criar pedido de venda no Omie
    // Determinar conta do Omie baseada no método de pagamento
    const omieAccountCode = orderData.paymentMethod 
      ? PAYMENT_METHOD_TO_OMIE_ACCOUNT[orderData.paymentMethod as keyof typeof PAYMENT_METHOD_TO_OMIE_ACCOUNT]
      : 2425423833; // Padrão: Caixinha (À vista)

    // Determinar código da parcela baseado no método de pagamento
    const parcelaCode = orderData.paymentMethod === 'boleto' ? '030' : '999';

    const omieOrderPayload = {
      cabecalho: {
        numero_pedido: orderData.orderNumber.slice(0, 15), // Máximo 15 caracteres
        codigo_cliente: omieCustomerId,
        data_previsao: new Date().toLocaleDateString('pt-BR'),
        etapa: '50', // Pedido de venda
        codigo_parcela: parcelaCode,
        origem_pedido: 'CRM-HonestSucos'
      },
      det: orderData.products.map((product, index) => ({
        ide: {
          codigo_item_integracao: `ITEM-${index + 1}-${orderData.orderNumber}`
        },
        produto: {
          descricao: product.description,
          quantidade: product.quantity,
          valor_unitario: product.unitPrice
        }
      })),
      frete: {
        modalidade: "9" // Sem ocorrência de transporte
      },
      informacoes_adicionais: {
        codigo_categoria: "1.01.03", // Categoria fiscal
        codigo_conta_corrente: omieAccountCode,
        consumidor_final: "S",
        enviar_email: "N",
        observacoes: `Pedido ${orderData.operationType || 'venda'} via CRM - Pagamento: ${orderData.paymentMethod || 'a_vista'} - Vendedor: ${orderData.sellerId}`
      }
    };

    console.log('Enviando pedido para Omie:', JSON.stringify(omieOrderPayload, null, 2));

    // Fazer chamada direta para API Omie
    const payload = {
      call: 'IncluirPedido',
      app_key: process.env.OMIE_APP_KEY,
      app_secret: process.env.OMIE_APP_SECRET,
      param: [omieOrderPayload]
    };

    const response = await fetch('https://app.omie.com.br/api/v1/produtos/pedido/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Omie API error: ${response.status} ${response.statusText}`);
    }

    const omieOrder = await response.json();
    
    if (omieOrder.faultstring) {
      throw new Error(`Omie API fault: ${omieOrder.faultstring}`);
    }

    console.log('Pedido criado no Omie com sucesso:', omieOrder);

    return {
      numero_pedido: omieOrder.numero_pedido || orderData.orderNumber,
      codigo_pedido: omieOrder.codigo_pedido,
      codigo_cliente_omie: omieCustomerId,
      status: 'success'
    };

  } catch (error: any) {
    console.error('Erro ao criar pedido no Omie:', error);
    throw new Error(`Falha na integração Omie: ${error.message}`);
  }
}