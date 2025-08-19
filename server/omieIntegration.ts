import { z } from 'zod';

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

  private async makeRequest(endpoint: string, call: string, params: any = {}) {
    const payload = {
      call,
      app_key: this.config.appKey,
      app_secret: this.config.appSecret,
      param: [params]
    };

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Omie API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
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
    const isCompany = omieClient.cnpj_cpf && omieClient.cnpj_cpf.length === 18;
    
    return {
      name: omieClient.razao_social || omieClient.nome_fantasia || '',
      customerType: isCompany ? 'pessoa_juridica' : 'pessoa_fisica',
      cpf: !isCompany ? omieClient.cnpj_cpf : '',
      cnpj: isCompany ? omieClient.cnpj_cpf : '',
      companyName: omieClient.razao_social || '',
      fantasyName: omieClient.nome_fantasia || '',
      phone: omieClient.telefone1_ddd && omieClient.telefone1_numero 
        ? `(${omieClient.telefone1_ddd}) ${omieClient.telefone1_numero}`
        : '',
      email: omieClient.email || '',
      address: [
        omieClient.endereco,
        omieClient.endereco_numero && `nº ${omieClient.endereco_numero}`,
      ].filter(Boolean).join(', '),
      city: omieClient.cidade || '',
      state: omieClient.estado || '',
      zipCode: omieClient.cep || '',
      route: omieClient.bairro || '',
      isActive: omieClient.inativo !== 'S',
      // Campos específicos do Omie para referência
      omieId: omieClient.codigo_cliente_omie,
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
      const response = await this.makeRequest('/financas/contareceber/', 'ListarContasReceber', {
        pagina: 1,
        registros_por_pagina: 100,
        apenas_pendentes: 'S',
        ordenar_por: 'DATA_VENCIMENTO'
      });

      const contas = response.conta_receber_cadastro || [];
      const hoje = new Date();
      const debtorsMap = new Map();
      let totalAmount = 0;

      for (const conta of contas) {
        if (!conta.data_vencimento) continue;

        const vencimento = new Date(conta.data_vencimento);
        const diffTime = hoje.getTime() - vencimento.getTime();
        const diasAtraso = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diasAtraso > 0) {
          const clientId = conta.codigo_cliente_omie;
          const valor = conta.valor_documento || 0;
          totalAmount += valor;

          if (!debtorsMap.has(clientId)) {
            // Buscar dados do cliente
            try {
              const cliente = await this.getClientByCode(clientId);
              debtorsMap.set(clientId, {
                cliente,
                debitos: [],
                valorTotal: 0,
                diasMaximoAtraso: 0
              });
            } catch (error) {
              console.error(`Erro ao buscar cliente ${clientId}:`, error);
              continue;
            }
          }

          const debtor = debtorsMap.get(clientId);
          debtor.debitos.push({
            numero_documento: conta.numero_documento,
            valor: valor,
            data_vencimento: conta.data_vencimento,
            dias_atraso: diasAtraso,
            observacao: conta.observacao
          });
          debtor.valorTotal += valor;
          debtor.diasMaximoAtraso = Math.max(debtor.diasMaximoAtraso, diasAtraso);
        }
      }

      return {
        debts: Array.from(debtorsMap.values()),
        totalAmount,
        totalClients: debtorsMap.size
      };
    } catch (error) {
      console.error('Erro ao buscar débitos em atraso no Omie:', error);
      throw error;
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
      
      // Filtrar apenas produtos ativos
      const activeProducts = mappedProducts.filter((product: any) => product.inativo !== 'S');
      console.log(`Produtos ativos filtrados: ${activeProducts.length} de ${mappedProducts.length}`);
      
      return {
        products: activeProducts,
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
      firstName: omieVendor.nome.split(' ')[0] || '',
      lastName: omieVendor.nome.split(' ').slice(1).join(' ') || '',
      email: omieVendor.email || `vendedor${omieVendor.codigo}@honest.com`,
      phone: omieVendor.telefone || '',
      role: 'vendedor' as const,
      isActive: true, // Importar todos como ativos
      omieId: omieVendor.codigo,
      commission: omieVendor.comissao || 0,
      inactiveInOmie: omieVendor.inativo === 'S' // Guardar status do Omie separadamente
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