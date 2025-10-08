// Integração com API da Receita Federal para consulta de CNPJ
import axios from 'axios';

export interface ReceitaFederalResponse {
  cnpj: string;
  nome: string; // Razão Social
  fantasia?: string; // Nome Fantasia
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone?: string;
  email?: string;
  situacao: string;
  data_situacao: string;
  atividade_principal: Array<{
    code: string;
    text: string;
  }>;
  atividades_secundarias?: Array<{
    code: string;
    text: string;
  }>;
  capital_social?: string;
  porte?: string;
  natureza_juridica?: string;
}

export class ReceitaFederalService {
  private baseUrl = 'https://www.receitaws.com.br/v1/cnpj';

  async consultarCNPJ(cnpj: string): Promise<ReceitaFederalResponse | null> {
    try {
      // Remove formatação do CNPJ
      const cnpjLimpo = cnpj.replace(/\D/g, '');
      
      if (cnpjLimpo.length !== 14) {
        throw new Error('CNPJ deve conter 14 dígitos');
      }

      const response = await axios.get(`${this.baseUrl}/${cnpjLimpo}`, {
        timeout: 10000, // 10 segundos de timeout
        headers: {
          'User-Agent': 'HonestSucos-CRM/1.0',
          'Accept': 'application/json',
        }
      });

      if (response.data.status === 'ERROR') {
        throw new Error(response.data.message || 'Erro ao consultar CNPJ');
      }

      return response.data;
    } catch (error) {
      console.error('Erro ao consultar CNPJ na Receita Federal:', error);
      
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          throw new Error('Muitas consultas realizadas. Tente novamente em alguns minutos.');
        }
        if (error.response?.status === 404) {
          throw new Error('CNPJ não encontrado na Receita Federal');
        }
        if (error.code === 'ECONNABORTED') {
          throw new Error('Timeout na consulta. Tente novamente.');
        }
      }
      
      throw new Error('Erro interno na consulta do CNPJ');
    }
  }

  formatarEndereco(dados: ReceitaFederalResponse): string {
    const partes = [
      dados.logradouro,
      dados.numero,
      dados.complemento,
      dados.bairro
    ].filter(Boolean);
    
    return partes.join(', ');
  }

  // Valida se CNPJ é válido (algoritmo)
  validarCNPJ(cnpj: string): boolean {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    
    if (cnpjLimpo.length !== 14) return false;
    
    // Elimina CNPJs conhecidos como inválidos
    if (/^(\d)\1{13}$/.test(cnpjLimpo)) return false;
    
    // Validação do primeiro dígito verificador
    let soma = 0;
    let peso = 2;
    
    for (let i = 11; i >= 0; i--) {
      soma += parseInt(cnpjLimpo[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    
    let digito1 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    
    if (parseInt(cnpjLimpo[12]) !== digito1) return false;
    
    // Validação do segundo dígito verificador
    soma = 0;
    peso = 2;
    
    for (let i = 12; i >= 0; i--) {
      soma += parseInt(cnpjLimpo[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    
    let digito2 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    
    return parseInt(cnpjLimpo[13]) === digito2;
  }

  // Valida se CPF é válido (algoritmo)
  validarCPF(cpf: string): boolean {
    const cpfLimpo = cpf.replace(/\D/g, '');
    
    if (cpfLimpo.length !== 11) return false;
    
    // Elimina CPFs conhecidos como inválidos
    if (/^(\d)\1{10}$/.test(cpfLimpo)) return false;
    
    // Validação do primeiro dígito verificador
    let soma = 0;
    for (let i = 0; i < 9; i++) {
      soma += parseInt(cpfLimpo[i]) * (10 - i);
    }
    
    let digito1 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    
    if (parseInt(cpfLimpo[9]) !== digito1) return false;
    
    // Validação do segundo dígito verificador
    soma = 0;
    for (let i = 0; i < 10; i++) {
      soma += parseInt(cpfLimpo[i]) * (11 - i);
    }
    
    let digito2 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    
    return parseInt(cpfLimpo[10]) === digito2;
  }

  formatarCNPJ(cnpj: string): string {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    return cnpjLimpo.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  }

  formatarCPF(cpf: string): string {
    const cpfLimpo = cpf.replace(/\D/g, '');
    return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
}

// Singleton instance
export const receitaService = new ReceitaFederalService();