import axios, { AxiosInstance } from 'axios';

interface EvolutionConfig {
  baseURL: string;
  apiKey: string;
  instanceName: string;
}

interface SendMessageParams {
  number: string;
  text: string;
  mediaUrl?: string;
}

interface EvolutionMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message: {
    conversation?: string;
    imageMessage?: {
      url: string;
      caption?: string;
    };
  };
  messageTimestamp: number;
}

export class EvolutionService {
  private client: AxiosInstance;
  private config: EvolutionConfig;

  constructor(baseURL: string, apiKey: string, instanceName: string) {
    this.config = {
      baseURL,
      apiKey,
      instanceName
    };

    this.client = axios.create({
      baseURL: `${baseURL}/message`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 10000
    });
  }

  /**
   * Enviar mensagem de texto via WhatsApp usando Evolution API
   */
  async sendText(params: SendMessageParams): Promise<any> {
    try {
      const response = await this.client.post('/sendText', {
        number: this.formatPhoneNumber(params.number),
        text: params.text
      });

      console.log(`✅ Mensagem enviada para ${params.number}`);
      return response.data;
    } catch (error: any) {
      console.error(`❌ Erro ao enviar mensagem para ${params.number}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar imagem com legenda via Evolution API
   */
  async sendImage(params: SendMessageParams & { mediaUrl: string; caption?: string }): Promise<any> {
    try {
      const response = await this.client.post('/sendImage', {
        number: this.formatPhoneNumber(params.number),
        image: params.mediaUrl,
        caption: params.caption || ''
      });

      console.log(`✅ Imagem enviada para ${params.number}`);
      return response.data;
    } catch (error: any) {
      console.error(`❌ Erro ao enviar imagem para ${params.number}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Obter histórico de mensagens de um contato
   */
  async getMessages(number: string, limit: number = 100): Promise<EvolutionMessage[]> {
    try {
      const response = await this.client.get(`/fetchMessages/${this.formatPhoneNumber(number)}`, {
        params: { limit }
      });

      return response.data.messages || [];
    } catch (error: any) {
      console.error(`❌ Erro ao buscar mensagens de ${number}:`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Verificar status da instância
   */
  async getInstanceStatus(): Promise<any> {
    try {
      const response = await this.client.get(`/chatFind/${this.config.instanceName}`);
      return response.data;
    } catch (error: any) {
      console.error(`❌ Erro ao verificar status da instância:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Enviar mensagem com template (se suportado)
   */
  async sendTemplate(number: string, templateName: string, parameters?: any[]): Promise<any> {
    try {
      const response = await this.client.post('/sendTemplate', {
        number: this.formatPhoneNumber(number),
        templateName,
        templateLanguageCode: 'pt',
        parameters: parameters || []
      });

      console.log(`✅ Template enviado para ${number}`);
      return response.data;
    } catch (error: any) {
      console.error(`❌ Erro ao enviar template para ${number}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Formatar número para o padrão da Evolution API (55XXXXXXXXXXX)
   */
  private formatPhoneNumber(number: string): string {
    // Remover caracteres especiais
    let cleaned = number.replace(/\D/g, '');

    // Se não começar com 55, adicionar código do Brasil
    if (!cleaned.startsWith('55')) {
      cleaned = '55' + cleaned;
    }

    return cleaned;
  }

  /**
   * Obter configuração atual
   */
  getConfig(): EvolutionConfig {
    return this.config;
  }
}

/**
 * Factory function para criar instância do serviço
 */
export function createEvolutionService(): EvolutionService | null {
  const baseURL = process.env.EVOLUTION_API_BASE_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'honest-sucos';

  if (!baseURL || !apiKey) {
    console.warn('⚠️ Evolution API não configurada. Defina EVOLUTION_API_BASE_URL e EVOLUTION_API_KEY');
    return null;
  }

  return new EvolutionService(baseURL, apiKey, instanceName);
}

/**
 * Singleton pattern
 */
let evolutionServiceInstance: EvolutionService | null = null;

export function getEvolutionService(): EvolutionService | null {
  if (!evolutionServiceInstance) {
    evolutionServiceInstance = createEvolutionService();
  }
  return evolutionServiceInstance;
}
