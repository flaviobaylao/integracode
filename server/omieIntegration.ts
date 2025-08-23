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

  constructor(config: OmieConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl || 'https://app.omie.com.br/api/v1';
  }

  static createFromEnv(): OmieService {
    const appKey = process.env.OMIE_APP_KEY;
    const appSecret = process.env.OMIE_APP_SECRET;
    
    if (!appKey || !appSecret) {
      throw new Error('OMIE_APP_KEY and OMIE_APP_SECRET environment variables are required');
    }
    
    return new OmieService({
      appKey,
      appSecret
    });
  }

  private async makeRequest(endpoint: string, call: string, params: any = {}) {
    const payload = {
      call,
      app_key: this.config.appKey,
      app_secret: this.config.appSecret,
      param: [params]
    };

    console.log(`Making request to ${endpoint} with call ${call}`);
    console.log('Request URL:', `${this.baseUrl}${endpoint}`);
    console.log('Request payload:', JSON.stringify(payload, null, 2));
    console.log('App Key exists:', !!this.config.appKey);
    console.log('App Secret exists:', !!this.config.appSecret);

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
      throw new Error(`Omie API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('Response data:', JSON.stringify(data, null, 2));
    
    if (data.faultstring) {
      throw new Error(`Omie API fault: ${data.faultstring}`);
    }

    return data;
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
      throw new Error(`Falha ao criar pedido no Omie: ${error.message}`);
    }
  }

  // Listar todos os clientes do Omie
  async getAllClients(page = 1, pageSize = 50): Promise<{
    clients: OmieClient[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      const response = await this.makeRequest('/geral/clientes/', 'ListarClientes', {
        pagina: page,
        registros_por_pagina: pageSize,
        apenas_importado_api: 'N'
      });

      const clients = response.clientes_cadastro || [];
      
      return {
        clients: clients.map((client: any) => {
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
      isActive: omieClient.inativo !== 'S',
      document: documento || null // Documento original apenas se houver
    };
  }

  // Sincronizar todos os clientes do Omie
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

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await this.getAllClients(currentPage, 100);
        
        for (const client of pageData.clients) {
          result.totalProcessed++;
          // Este método retorna apenas os dados formatados
          // A lógica de salvamento será feita na rota
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      return result;
    } catch (error) {
      console.error('Erro ao sincronizar clientes do Omie:', error);
      throw error;
    }
  }

  // Buscar débitos em atraso
  async getOverdueDebts(): Promise<{
    debts: any[];
    totalAmount: number;
    totalClients: number;
  }> {
    try {
      console.log('Starting overdue debts query...');
      
      // Primeiro, vamos testar se a API está funcionando com uma chamada simples
      console.log('Testing API with client listing first...');
      try {
        const testResponse = await this.makeRequest('/geral/clientes/', 'ListarClientes', {
          pagina: 1,
          registros_por_pagina: 5,
          apenas_importado_api: 'N'
        });
        console.log('API test successful, proceeding with overdue debts...');
      } catch (testError) {
        console.error('API test failed:', testError);
        throw new Error('API authentication or connection failed');
      }
      
      // Usar o endpoint oficial do Omie para contas a receber
      const today = new Date();
      
      const response = await this.makeRequest('/financas/contareceber/', 'ListarContasReceber', {
        pagina: 1,
        registros_por_pagina: 100,
        apenas_importado_api: 'N'
      });

      console.log(`API response received:`, JSON.stringify(response, null, 2));
      console.log(`Processing ${response.total_de_registros || 0} records...`);

      // Diferentes endpoints podem ter estruturas diferentes
      const contas = response.conta_receber_cadastro || 
                     response.cadastro || 
                     response.contasReceber || 
                     response.lista_contas_receber || 
                     [];
      const hoje = new Date();
      const debtorsMap = new Map();
      let totalAmount = 0;

      console.log(`Found ${contas.length} accounts to process`);
      
      // Analisar os status disponíveis para entender melhor os dados
      const statusCount = {};
      const statusWithAtraso = [];
      contas.forEach(conta => {
        const status = conta.status_titulo || 'UNDEFINED';
        statusCount[status] = (statusCount[status] || 0) + 1;
        
        // Verificar todos os status que não são finalizados
        if (status !== 'RECEBIDO' && status !== 'LIQUIDADO' && 
            status !== 'PAGO' && status !== 'CANCELADO') {
          statusWithAtraso.push(status);
        }
      });
      console.log('Status distribution:', statusCount);
      console.log('Status não finalizados (possíveis débitos):', [...new Set(statusWithAtraso)]);
      
      for (const conta of contas) {
        if (!conta.data_vencimento) continue;
        
        console.log(`Processing account:`, JSON.stringify({
          numero_documento: conta.numero_documento,
          numero_documento_fiscal: conta.numero_documento_fiscal,
          data_vencimento: conta.data_vencimento,
          data_emissao: conta.data_emissao,
          valor_documento: conta.valor_documento,
          codigo_cliente_fornecedor: conta.codigo_cliente_fornecedor,
          status_titulo: conta.status_titulo,
          situacao: conta.situacao,
          observacao: conta.observacao
        }, null, 2));

        // Converter data de vencimento do formato brasileiro DD/MM/YYYY
        const [dia, mes, ano] = conta.data_vencimento.split('/');
        const vencimento = new Date(parseInt(ano), parseInt(mes) - 1, parseInt(dia));
        const diffTime = hoje.getTime() - vencimento.getTime();
        const diasAtraso = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const statusAberto = !conta.status_titulo || 
                           conta.status_titulo === 'ABERTO' || 
                           conta.status_titulo === 'PENDENTE' ||
                           conta.status_titulo === 'VENCIDO';
        
        console.log(`Account ${conta.numero_documento}: dias_atraso=${diasAtraso}, status=${conta.status_titulo}, situacao=${conta.situacao}, isOpen=${statusAberto}`);

        // Critério principal: vencido em data anterior à data atual
        // Excluir apenas status claramente finalizados (pago/cancelado)
        const statusTitulo = conta.status_titulo || '';
        const isFinalized = statusTitulo === 'RECEBIDO' || 
                           statusTitulo === 'LIQUIDADO' ||
                           statusTitulo === 'PAGO' ||
                           statusTitulo === 'CANCELADO';
        
        // Se venceu e não está finalizado, é considerado em atraso
        if (diasAtraso > 0 && !isFinalized) {
          const clientId = conta.codigo_cliente_fornecedor;
          const valor = parseFloat(conta.valor_documento || '0');
          
          console.log(`Found overdue account: clientId=${clientId}, valor=${valor}, diasAtraso=${diasAtraso}`);
          
          if (valor > 0) {
            totalAmount += valor;

            if (!debtorsMap.has(clientId)) {
              // Buscar dados reais do cliente no Omie
              let clienteCompleto;
              try {
                console.log(`Fetching client data for ${clientId}...`);
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
                diasMaximoAtraso: 0
              });
              
              console.log(`Created new debtor entry for client ${clienteBasico.nome_fantasia} (${clientId})`);
            }

            const debtor = debtorsMap.get(clientId);
            debtor.debitos.push({
              numero_documento: conta.numero_documento || 'N/A',
              numero_documento_fiscal: conta.numero_documento_fiscal || 'N/A',
              codigo_lancamento_omie: conta.codigo_lancamento_omie,
              valor: valor,
              data_vencimento: conta.data_vencimento,
              data_emissao: conta.data_emissao || '',
              dias_atraso: diasAtraso,
              observacao: conta.observacao || '',
              status_titulo: conta.status_titulo || 'N/A'
            });
            debtor.valorTotal += valor;
            debtor.diasMaximoAtraso = Math.max(debtor.diasMaximoAtraso, diasAtraso);
            
            console.log(`Added debt to client ${debtor.cliente.nome_fantasia}: R$ ${valor} (${diasAtraso} dias em atraso) - Doc: ${conta.numero_documento} - NF: ${conta.numero_documento_fiscal}`);
          }
        }
      }

      const result = {
        debts: Array.from(debtorsMap.values()),
        totalAmount,
        totalClients: debtorsMap.size
      };
      
      console.log(`Final result:`, JSON.stringify(result, null, 2));
      console.log(`Total debtors found: ${result.totalClients}, Total amount: R$ ${result.totalAmount}`);
      
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

  // Listar todos os vendedores ativos do Omie
  async getAllVendors(page = 1, pageSize = 50): Promise<{
    vendors: OmieVendor[];
    totalPages: number;
    totalRecords: number;
    currentPage: number;
  }> {
    try {
      const response = await this.makeRequest('/geral/vendedores/', 'ListarVendedores', {
        pagina: page,
        registros_por_pagina: pageSize,
        apenas_importado_api: 'N'
      });

      console.log('Resposta da API Omie vendedores:', JSON.stringify(response, null, 2));

      const vendors = response.cadastro || response.vendedores_cadastro || [];
      console.log(`Encontrados ${vendors.length} vendedores na página ${page}`);
      
      const mappedVendors = vendors.map((vendor: any) => ({
        codigo: vendor.codigo,
        nome: vendor.nome,
        email: vendor.email,
        telefone: vendor.telefone,
        inativo: vendor.inativo,
        comissao: vendor.comissao
      }));

      console.log('Vendedores mapeados:', mappedVendors);
      
      // Filtrar apenas vendedores ativos
      const activeVendors = mappedVendors.filter((vendor: any) => vendor.inativo !== 'S');
      console.log(`Vendedores ativos filtrados: ${activeVendors.length} de ${mappedVendors.length}`);
      
      return {
        vendors: activeVendors,
        totalPages: response.total_de_paginas || 1,
        totalRecords: response.total_de_registros || 0,
        currentPage: page
      };
    } catch (error) {
      console.error('Erro ao listar vendedores no Omie:', error);
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

  // ===== INTEGRAÇÃO DE PEDIDOS COM INFORMAÇÕES DE ENTREGA =====

  // Criar pedido de venda no Omie com informações de entrega
  async createSalesOrder(salesCard: any, customer: any, products: any[]): Promise<any> {
    try {
      // Mapear status de entrega para observações do Omie
      const deliveryStatusMap = {
        'pending': 'ENTREGA: Aguardando entrega',
        'in_transit': 'ENTREGA: Em trânsito',
        'delivered': 'ENTREGA: Entregue com sucesso',
        'failed': 'ENTREGA: Falha na entrega',
        'returned': 'ENTREGA: Produto devolvido'
      };

      const deliveryInfo = salesCard.deliveryStatus 
        ? deliveryStatusMap[salesCard.deliveryStatus as keyof typeof deliveryStatusMap] || ''
        : '';

      const deliveryNotes = salesCard.deliveryNotes 
        ? `\nOBS ENTREGA: ${salesCard.deliveryNotes}` 
        : '';

      const trackingInfo = salesCard.trackingCode 
        ? `\nCÓDIGO RASTREAMENTO: ${salesCard.trackingCode}` 
        : '';

      const deliveryDate = salesCard.deliveryCompletedDate 
        ? `\nDATA ENTREGA: ${new Date(salesCard.deliveryCompletedDate).toLocaleString('pt-BR')}` 
        : '';

      const observacoes = `Pedido CRM: ${salesCard.id}\n${deliveryInfo}${deliveryNotes}${trackingInfo}${deliveryDate}`.trim();

      // Determinar etapa baseada no status
      let etapa = '10'; // Pedido
      if (salesCard.deliveryStatus === 'delivered') {
        etapa = '60'; // Entregue
      } else if (salesCard.deliveryStatus === 'failed') {
        etapa = '50'; // Faturado mas com problema
      } else if (salesCard.deliveryStatus === 'in_transit') {
        etapa = '50'; // Faturado, em trânsito
      } else if (salesCard.status === 'completed') {
        etapa = '50'; // Faturado
      }

      const omieCustomerId = customer.id.includes('omie-client-') 
        ? parseInt(customer.id.replace('omie-client-', ''))
        : customer.omieId || null;

      if (!omieCustomerId) {
        throw new Error('ID do cliente no Omie não encontrado');
      }

      const salesOrder = {
        codigo_cliente_omie: omieCustomerId,
        codigo_pedido_integracao: salesCard.id,
        data_previsao: salesCard.deliveryScheduledDate || salesCard.scheduledDate,
        etapa,
        codigo_cenario_impostos: '1000000001',
        observacoes,
        det: products.map((product: any, index: number) => ({
          ide: {
            codigo_item_integracao: `${salesCard.id}-item-${index + 1}`,
            simples_nacional: 'S'
          },
          produto: {
            codigo_produto_integracao: product.id,
            descricao: product.name,
            unidade: 'UN',
            quantidade: product.quantity || 1,
            valor_unitario: parseFloat(product.price) || 0,
            valor_total: (parseFloat(product.price) || 0) * (product.quantity || 1)
          }
        }))
      };

      const response = await this.makeRequest('/produtos/pedidovenda/', 'IncluirPedido', {
        pedido_venda_produto: salesOrder
      });

      return response.pedido_venda_produto;
    } catch (error) {
      console.error('Erro ao criar pedido no Omie:', error);
      throw error;
    }
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

export function getOmieService(): OmieService | null {
  if (!omieService && process.env.OMIE_APP_KEY && process.env.OMIE_APP_SECRET) {
    omieService = new OmieService({
      appKey: process.env.OMIE_APP_KEY,
      appSecret: process.env.OMIE_APP_SECRET,
    });
  }
  return omieService;
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
      errors: []
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
          result.errors.push(`Erro ao processar produto ${product.codigo}: ${productError.message}`);
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