/**
 * Evolution API Integration Service
 * Handles WhatsApp integration via Evolution API
 */

export interface EvolutionAPIConfig {
  apiUrl: string;
  apiKey: string;
  instanceName: string;
}

export interface EvolutionInstance {
  instanceName: string;
  status: 'open' | 'close' | 'connecting';
  qrcode?: {
    base64: string;
    code: string;
  };
  owner?: string;
}

export interface EvolutionMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message: {
    conversation?: string;
    extendedTextMessage?: {
      text: string;
    };
  };
  messageType: string;
  messageTimestamp: number;
  pushName?: string;
  instanceName: string;
}

export interface EvolutionWebhookData {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
    };
    message?: any;
    messageType?: string;
    messageTimestamp?: number;
    pushName?: string;
    status?: string;
  };
}

class EvolutionAPIService {
  private config: EvolutionAPIConfig | null = null;

  public configure(config: EvolutionAPIConfig): void {
    this.config = config;
    console.log('✅ Evolution API configurada:', config.apiUrl);
  }

  public isConfigured(): boolean {
    return this.config !== null && this.config.apiUrl !== '' && this.config.apiKey !== '';
  }

  public getConfig(): EvolutionAPIConfig | null {
    return this.config;
  }

  // Create a new instance
  public async createInstance(instanceName: string): Promise<{ success: boolean; qrcode?: any; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config!.apiKey
        },
        body: JSON.stringify({
          instanceName: instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS'
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ Erro ao criar instância:', data);
        return { success: false, error: data.message || 'Erro ao criar instância' };
      }

      console.log('✅ Instância criada:', instanceName);
      return { success: true, qrcode: data.qrcode };
    } catch (error: any) {
      console.error('❌ Erro ao criar instância:', error);
      return { success: false, error: error.message };
    }
  }

  // Get instance connection status
  public async getInstanceStatus(instanceName: string): Promise<{ success: boolean; status?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/connectionState/${instanceName}`, {
        method: 'GET',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      const data = await response.json();

      console.log('🔍 Evolution API /instance/connectionState response:', {
        ok: response.ok,
        status: response.status,
        data: JSON.stringify(data)
      });

      if (!response.ok) {
        return { success: false, error: data.message || 'Erro ao buscar status' };
      }

      console.log(`📡 Instance status: ${data.instance?.state}`);
      return { success: true, status: data.instance?.state };
    } catch (error: any) {
      console.error('❌ Erro ao buscar status:', error);
      return { success: false, error: error.message };
    }
  }

  // Get QR Code for connection
  public async getQRCode(instanceName: string): Promise<{ success: boolean; qrcode?: any; error?: string; alreadyConnected?: boolean }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/connect/${instanceName}`, {
        method: 'GET',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      const data = await response.json();

      console.log('📱 Evolution API /instance/connect response:', JSON.stringify(data, null, 2));

      if (!response.ok) {
        return { success: false, error: data.message || 'Erro ao gerar QR Code' };
      }

      // Check if instance is already connected (state: "open")
      if (data.instance && data.instance.state === 'open') {
        console.log('✅ Instância já está conectada ao WhatsApp');
        return { 
          success: true, 
          alreadyConnected: true,
          error: 'WhatsApp já está conectado nesta instância' 
        };
      }

      // Check if we have a QR code
      if (data.qrcode) {
        console.log('📱 QR Code recebido:', {
          hasBase64: !!data.qrcode.base64,
          hasCode: !!data.qrcode.code,
        });
        return { success: true, qrcode: data.qrcode };
      }

      // No QR code and not connected
      return { 
        success: false, 
        error: 'Nenhum QR Code disponível. A instância pode estar em estado inconsistente.' 
      };

    } catch (error: any) {
      console.error('❌ Erro ao gerar QR Code:', error);
      return { success: false, error: error.message };
    }
  }

  // Logout/disconnect instance
  public async logoutInstance(instanceName: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/logout/${instanceName}`, {
        method: 'DELETE',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      if (!response.ok) {
        const data = await response.json();
        return { success: false, error: data.message || 'Erro ao desconectar' };
      }

      console.log('✅ Instância desconectada:', instanceName);
      return { success: true };
    } catch (error: any) {
      console.error('❌ Erro ao desconectar:', error);
      return { success: false, error: error.message };
    }
  }

  // Delete instance
  public async deleteInstance(instanceName: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/delete/${instanceName}`, {
        method: 'DELETE',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      if (!response.ok) {
        const data = await response.json();
        return { success: false, error: data.message || 'Erro ao deletar instância' };
      }

      console.log('✅ Instância deletada:', instanceName);
      return { success: true };
    } catch (error: any) {
      console.error('❌ Erro ao deletar instância:', error);
      return { success: false, error: error.message };
    }
  }

  // Send text message with retry logic
  public async sendTextMessage(instanceName: string, to: string, text: string, retries = 3): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    // Format phone number for WhatsApp (add @s.whatsapp.net if not present)
    // Input pode ser: 5585987654321, 85987654321, 5585987654321@s.whatsapp.net, etc.
    let formattedNumber: string;
    
    if (to.includes('@')) {
      // Já tem @, usar como está (mas verificar número)
      formattedNumber = to;
      console.log(`📤 [EVOLUTION] Número já formatado com @: ${formattedNumber}`);
    } else {
      let digitsOnly = to.replace(/\D/g, ''); // Remove tudo que não é dígito
      console.log(`📤 [EVOLUTION] Dígitos extraídos: ${digitsOnly} (length: ${digitsOnly.length})`);
      
      // Se começar com 55, é número internacional completo (55 + DDD + número = 13 dígitos)
      if (digitsOnly.startsWith('55')) {
        if (digitsOnly.length !== 13) {
          console.warn(`⚠️  [EVOLUTION] Aviso: Número com 55 tem ${digitsOnly.length} dígitos, esperado 13`);
          // Pegar últimos 11 depois do 55
          digitsOnly = digitsOnly.slice(0, 2) + digitsOnly.slice(digitsOnly.length - 11);
        }
        formattedNumber = `${digitsOnly}@s.whatsapp.net`;
      } else if (digitsOnly.length === 11) {
        // Se tem 11 dígitos (DDD + número), adicionar 55
        formattedNumber = `55${digitsOnly}@s.whatsapp.net`;
      } else if (digitsOnly.length === 9 || digitsOnly.length === 10) {
        // Se menos de 11, adicionar 55 e usar como está
        formattedNumber = `55${digitsOnly}@s.whatsapp.net`;
      } else if (digitsOnly.length > 13) {
        // Se mais de 13, pegar últimos 13 (55 + DDD + número)
        console.warn(`⚠️  [EVOLUTION] Número com ${digitsOnly.length} dígitos, usando últimos 13`);
        digitsOnly = digitsOnly.slice(digitsOnly.length - 13);
        formattedNumber = `${digitsOnly}@s.whatsapp.net`;
      } else {
        // Default: usar como está
        console.warn(`⚠️  [EVOLUTION] Formato não identificado (${digitsOnly.length} dígitos), usando como está`);
        formattedNumber = `${digitsOnly}@s.whatsapp.net`;
      }
    }

    console.log(`📤 [EVOLUTION] Enviando mensagem - Input: ${to}, Formatado FINAL: ${formattedNumber}, Instância: ${instanceName}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`📤 [EVOLUTION] Tentativa ${attempt}/${retries}: POST ${this.config!.apiUrl}/message/sendText/${instanceName}`);
        console.log(`📤 [EVOLUTION] Payload: { number: "${formattedNumber}", text: "${text.substring(0, 50)}..." }`);
        
        const response = await fetch(`${this.config!.apiUrl}/message/sendText/${instanceName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.config!.apiKey
          },
          body: JSON.stringify({
            number: formattedNumber,
            text: text
          }),
          signal: AbortSignal.timeout(30000) // 30 segundos ao invés de 10
        });

        const data = await response.json();
        console.log(`📤 [EVOLUTION] Response status: ${response.status}, Body:`, data);

        if (!response.ok) {
          console.error(`❌ [EVOLUTION] Erro (tentativa ${attempt}): ${JSON.stringify(data)}`);
          if (attempt === retries) {
            return { success: false, error: data.message || `HTTP ${response.status}: Erro ao enviar mensagem` };
          }
          await new Promise(resolve => setTimeout(resolve, 2000)); // Aguardar 2s antes de retry
          continue;
        }

        console.log('✅ [EVOLUTION] Mensagem enviada com sucesso');
        return { success: true, messageId: data.key?.id };
      } catch (error: any) {
        console.error(`❌ [EVOLUTION] Erro na tentativa ${attempt}: ${error.message}`);
        if (attempt === retries) {
          console.error('❌ [EVOLUTION] Todas as tentativas falharam:', error);
          return { success: false, error: error.message };
        }
        await new Promise(resolve => setTimeout(resolve, 2000)); // Aguardar 2s antes de retry
      }
    }

    return { success: false, error: 'Falha ao enviar mensagem após múltiplas tentativas' };
  }

  // Send media message (image, audio, video, document) with retry logic
  public async sendMediaMessage(
    instanceName: string, 
    to: string, 
    mediaUrl: string, 
    caption?: string,
    mediaType?: 'image' | 'audio' | 'video' | 'document',
    retries = 3
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    const formattedNumber = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    // Determine endpoint based on media type
    const endpoint = mediaType === 'audio' ? 'sendAudio' : 
                    mediaType === 'video' ? 'sendVideo' :
                    mediaType === 'document' ? 'sendDocument' : 'sendMedia';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`📤 Tentativa ${attempt}/${retries} de enviar mídia (${mediaType}) para ${formattedNumber}`);
        
        const response = await fetch(`${this.config!.apiUrl}/message/${endpoint}/${instanceName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.config!.apiKey
          },
          body: JSON.stringify({
            number: formattedNumber,
            mediaUrl: mediaUrl,
            caption: caption || ''
          }),
          signal: AbortSignal.timeout(30000) // 30 segundos
        });

        const data = await response.json();

        if (!response.ok) {
          console.error(`❌ Erro (tentativa ${attempt}):`, data);
          if (attempt === retries) {
            return { success: false, error: data.message || 'Erro ao enviar mídia' };
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        console.log(`✅ Mídia enviada via Evolution API (${mediaType})`);
        return { success: true, messageId: data.key?.id };
      } catch (error: any) {
        console.error(`❌ Erro na tentativa ${attempt}:`, error.message);
        if (attempt === retries) {
          console.error('❌ Todas as tentativas falharam:', error);
          return { success: false, error: error.message };
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return { success: false, error: 'Falha ao enviar mídia após múltiplas tentativas' };
  }

  // Send location message
  public async sendLocationMessage(
    instanceName: string, 
    to: string, 
    latitude: number, 
    longitude: number,
    name?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    const formattedNumber = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

    try {
      const response = await fetch(`${this.config!.apiUrl}/message/sendLocation/${instanceName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config!.apiKey
        },
        body: JSON.stringify({
          number: formattedNumber,
          latitude: latitude,
          longitude: longitude,
          name: name || 'Localização'
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ Erro ao enviar localização:', data);
        return { success: false, error: data.message || 'Erro ao enviar localização' };
      }

      console.log('✅ Localização enviada via Evolution API');
      return { success: true, messageId: data.key?.id };
    } catch (error: any) {
      console.error('❌ Erro ao enviar localização:', error);
      return { success: false, error: error.message };
    }
  }

  // Set webhook for receiving messages
  public async setWebhook(instanceName: string, webhookUrl: string, events: string[] = ['messages.upsert']): Promise<{ success: boolean; error?: string; data?: any }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      console.log('🔧 Configurando webhook:', { instanceName, webhookUrl, events });
      
      const response = await fetch(`${this.config!.apiUrl}/webhook/set/${instanceName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config!.apiKey
        },
        body: JSON.stringify({
          webhook: {
            url: webhookUrl,
            enabled: true,
            webhook_by_events: false,
            webhook_base64: false,
            events: events
          }
        })
      });

      const data = await response.json();
      
      // Log complete response
      console.log('📡 Status da resposta:', response.status);
      console.log('📡 Dados brutos da API:', data);
      
      if (data.response?.message) {
        console.log('📡 Message field type:', typeof data.response.message);
        console.log('📡 Message field is Array:', Array.isArray(data.response.message));
        if (Array.isArray(data.response.message)) {
          console.log('📡 Message array contents:');
          data.response.message.forEach((msg: any, index: number) => {
            console.log(`  [${index}]:`, msg);
          });
        }
      }

      if (!response.ok) {
        // Extract detailed error message
        let errorMessage = 'Erro ao configurar webhook';
        
        if (data.response?.message) {
          if (Array.isArray(data.response.message)) {
            errorMessage = data.response.message.join(', ');
          } else {
            errorMessage = String(data.response.message);
          }
        } else if (data.message) {
          errorMessage = data.message;
        }
        
        console.error('❌ Mensagem de erro final:', errorMessage);
        return { success: false, error: errorMessage };
      }

      // Check if Evolution API returned success: false even with HTTP 200
      if (data.webhook && data.webhook.enabled === false) {
        return { success: false, error: 'Webhook não foi ativado pela API' };
      }

      console.log('✅ Webhook configurado com sucesso:', webhookUrl);
      return { success: true, data };
    } catch (error: any) {
      console.error('❌ Erro ao configurar webhook:', error);
      return { success: false, error: error.message };
    }
  }

  // Get webhook configuration
  public async getWebhook(instanceName: string): Promise<{ success: boolean; webhook?: any; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/webhook/find/${instanceName}`, {
        method: 'GET',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      const data = await response.json();
      console.log('📡 Configuração atual do webhook:', data);

      if (!response.ok) {
        return { success: false, error: data.message || 'Erro ao buscar webhook' };
      }

      return { success: true, webhook: data };
    } catch (error: any) {
      console.error('❌ Erro ao buscar webhook:', error);
      return { success: false, error: error.message };
    }
  }

  // Test connection to Evolution API
  public async testConnection(): Promise<{ success: boolean; instances?: any[]; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/instance/fetchInstances`, {
        method: 'GET',
        headers: {
          'apikey': this.config!.apiKey
        }
      });

      if (!response.ok) {
        const data = await response.json();
        return { success: false, error: data.message || 'Erro ao conectar com Evolution API' };
      }

      const data = await response.json();
      console.log('✅ Conexão com Evolution API testada com sucesso');
      return { success: true, instances: data };
    } catch (error: any) {
      console.error('❌ Erro ao testar conexão:', error);
      return { success: false, error: error.message };
    }
  }

  // Extract phone number from WhatsApp JID (removes @s.whatsapp.net, @c.us, and device suffix like :40)
  public extractPhoneNumber(jid: string): string {
    return jid
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '')
      .split(':')[0]; // Remove device suffix like :40
  }

  // Fetch chat history for a specific contact (all pages)
  public async fetchChatHistory(
    instanceName: string, 
    contactPhone: string | null,
    limit: number = 1000 // Limit to avoid overwhelming the system
  ): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    // Null-safe check
    if (!contactPhone) {
      return { success: false, error: 'Número de contato inválido' };
    }

    // Format phone number with @s.whatsapp.net suffix if not present
    let cleanPhone = contactPhone.replace(/\D/g, ''); // Remove tudo que não é dígito
    console.log(`🔍 [FETCH-HISTORY] Telefone recebido: ${contactPhone} -> Dígitos: ${cleanPhone} (length: ${cleanPhone.length})`);
    
    // Se começar com 55, remove (será re-adicionado)
    if (cleanPhone.startsWith('55')) {
      cleanPhone = cleanPhone.slice(2);
      console.log(`🔍 [FETCH-HISTORY] Removido prefixo 55 -> ${cleanPhone} (length: ${cleanPhone.length})`);
    }
    
    // Garante exatamente 11 dígitos (DDD + número)
    if (cleanPhone.length > 11) {
      console.log(`🔍 [FETCH-HISTORY] ⚠️ Telefone com ${cleanPhone.length} dígitos, pegando últimos 11`);
      cleanPhone = cleanPhone.slice(cleanPhone.length - 11);
    }
    
    const remoteJid = `55${cleanPhone}@s.whatsapp.net`;
    
    console.log(`🔍 Buscando mensagens para: ${contactPhone} -> ${remoteJid}`);

    try {
      // Fetch first page to get total pages
      const requestBody = {
        where: {
          key: {
            remoteJid: remoteJid
          }
        },
        page: 1
      };
      
      console.log(`📤 Request body:`, JSON.stringify(requestBody));
      
      const response = await fetch(`${this.config!.apiUrl}/chat/findMessages/${instanceName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config!.apiKey
        },
        body: JSON.stringify(requestBody)
      });

      const firstPageData = await response.json();
      console.log(`📡 Status: ${response.status}, Response:`, JSON.stringify(firstPageData).substring(0, 200));

      if (!response.ok) {
        console.error('❌ Erro ao buscar histórico de chat (HTTP):', response.status, firstPageData);
        return { success: false, error: firstPageData.message || `HTTP ${response.status}` };
      }

      // Parse the pagination info
      let allMessages: any[] = [];
      
      if (firstPageData.messages && firstPageData.messages.records) {
        const { total, pages, records } = firstPageData.messages;
        allMessages = [...records];
        
        console.log(`📊 Total de mensagens: ${total}, Páginas: ${pages}`);
        
        // Limit the number of messages to fetch
        const maxMessages = Math.min(total, limit);
        const maxPages = Math.min(pages, Math.ceil(maxMessages / 50)); // Assuming 50 per page
        
        // Fetch remaining pages (limit to avoid overload)
        if (maxPages > 1) {
          console.log(`📥 Buscando páginas 2-${maxPages}...`);
          
          for (let page = 2; page <= maxPages; page++) {
            try {
              const pageResponse = await fetch(`${this.config!.apiUrl}/chat/findMessages/${instanceName}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': this.config!.apiKey
                },
                body: JSON.stringify({
                  where: {
                    key: {
                      remoteJid: remoteJid
                    }
                  },
                  page: page
                })
              });

              if (pageResponse.ok) {
                const pageData = await pageResponse.json();
                if (pageData.messages && pageData.messages.records) {
                  allMessages = [...allMessages, ...pageData.messages.records];
                }
              }
            } catch (pageError) {
              console.error(`⚠️  Erro ao buscar página ${page}:`, pageError);
            }
          }
        }
      } else if (Array.isArray(firstPageData)) {
        // Old format - direct array
        allMessages = firstPageData;
      } else if (firstPageData.data) {
        // Another format - data field
        allMessages = Array.isArray(firstPageData.data) ? firstPageData.data : [];
      } else {
        // Empty or unexpected format
        console.log(`⚪ Nenhuma mensagem encontrada para ${remoteJid}`);
        allMessages = [];
      }
      
      console.log(`✅ Total de mensagens obtidas: ${allMessages.length}`);
      
      return { success: true, messages: allMessages };
    } catch (error: any) {
      console.error('❌ Erro ao buscar histórico de chat:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Fetch all chats from the instance
  public async fetchAllChats(instanceName: string): Promise<{ success: boolean; chats?: any[]; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      const response = await fetch(`${this.config!.apiUrl}/chat/findChats/${instanceName}`, {
        method: 'POST',
        headers: {
          'apikey': this.config!.apiKey,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const data = await response.json();
        console.error('❌ Erro ao buscar lista de chats:', data);
        return { success: false, error: data.message || 'Erro ao buscar chats' };
      }

      const data = await response.json();
      
      // Parse Evolution API response structure (could be array or wrapped object)
      const chats = Array.isArray(data) ? data : 
                   Array.isArray(data.chats) ? data.chats :
                   Array.isArray(data.response) ? data.response :
                   Array.isArray(data.data) ? data.data : [];
      
      console.log(`✅ Lista de chats obtida: ${chats.length} conversas`);
      if (chats.length > 0) {
        console.log(`🔍 Estrutura do primeiro chat:`, JSON.stringify(chats[0], null, 2));
      }
      
      return { success: true, chats };
    } catch (error: any) {
      console.error('❌ Erro ao buscar lista de chats:', error);
      return { success: false, error: error.message };
    }
  }

  // Extract message text from Evolution API message object
  public extractMessageText(message: any): string {
    if (message.conversation) {
      return message.conversation;
    }
    if (message.extendedTextMessage?.text) {
      return message.extendedTextMessage.text;
    }
    if (message.imageMessage?.caption) {
      return message.imageMessage.caption;
    }
    if (message.videoMessage?.caption) {
      return message.videoMessage.caption;
    }
    if (message.audioMessage) {
      return '[Áudio]';
    }
    if (message.documentMessage?.fileName) {
      return message.documentMessage.fileName;
    }
    return '[Mensagem de mídia]';
  }

  // Extract media information from Evolution API message object
  public extractMediaInfo(message: any): {
    messageType: 'text' | 'image' | 'audio' | 'video' | 'document';
    mediaUrl?: string;
    mediaType?: string;
    mediaSize?: number;
    mediaFilename?: string;
  } {
    // Image
    if (message.imageMessage) {
      return {
        messageType: 'image',
        mediaUrl: message.imageMessage.url,
        mediaType: message.imageMessage.mimetype || 'image/jpeg',
        mediaSize: message.imageMessage.fileLength,
        mediaFilename: 'image.jpg'
      };
    }
    
    // Video
    if (message.videoMessage) {
      return {
        messageType: 'video',
        mediaUrl: message.videoMessage.url,
        mediaType: message.videoMessage.mimetype || 'video/mp4',
        mediaSize: message.videoMessage.fileLength,
        mediaFilename: 'video.mp4'
      };
    }
    
    // Audio
    if (message.audioMessage) {
      return {
        messageType: 'audio',
        mediaUrl: message.audioMessage.url,
        mediaType: message.audioMessage.mimetype || 'audio/ogg',
        mediaSize: message.audioMessage.fileLength,
        mediaFilename: 'audio.ogg'
      };
    }
    
    // Document
    if (message.documentMessage) {
      return {
        messageType: 'document',
        mediaUrl: message.documentMessage.url,
        mediaType: message.documentMessage.mimetype || 'application/pdf',
        mediaSize: message.documentMessage.fileLength,
        mediaFilename: message.documentMessage.fileName || 'document'
      };
    }
    
    // Text (default)
    return {
      messageType: 'text'
    };
  }
}

// Singleton instance
export const evolutionAPIService = new EvolutionAPIService();
