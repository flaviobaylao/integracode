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

    // Auto-configurar webhook na inicialização
    const instanceName = config.instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
    const isDev = process.env.NODE_ENV === 'development';
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const prodDomain = process.env.REPLIT_DOMAIN || process.env.REPLIT_DOMAINS;

    if (isDev && devDomain) {
      // No modo dev (Workspace), não configuramos webhook automaticamente para evitar quebrar o de produção
      // O usuário pode forçar a configuração se quiser testar localmente via endpoint /api/chat/webhook/force-dev-config
      console.log(`⚠️  [WEBHOOK-INIT] Modo desenvolvimento: Webhook automático desativado para proteger produção.`);
      console.log(`💡 [WEBHOOK-INIT] Para testar localmente, use: POST /api/chat/webhook/force-dev-config`);
    } else if (!isDev && prodDomain) {
      // Priorizar REPLIT_DOMAIN para Autoscale (singular)
      const primaryDomain = process.env.REPLIT_DOMAIN || (Array.isArray(prodDomain) ? prodDomain[0] : prodDomain.split(',')[0]);
      const webhookUrl = `https://${primaryDomain}/api/chat/webhook/messages`;
      console.log(`🚀 [WEBHOOK-INIT] Configurando para produção: ${webhookUrl}`);
      this.setWebhook(instanceName, webhookUrl).catch(err => console.error('❌ [WEBHOOK-INIT] Erro:', err.message));
    }
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
  public async setWebhook(instanceName: string, webhookUrl: string, events: string[] = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE', 'MESSAGES_SET', 'MESSAGES_EDITED']): Promise<{ success: boolean; error?: string; data?: any }> {
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
      .replace('@lid', '')  // Evolution API internal ID suffix
      .split(':')[0]; // Remove device suffix like :40
  }

  /**
   * Resolve o número de telefone CANÔNICO a partir do payload do webhook.
   * Faz busca RECURSIVA em todo o payload procurando por @s.whatsapp.net (número real)
   * antes de usar @lid (ID interno).
   */
  public resolveCanonicalPhone(data: any): { phone: string; source: string } {
    const candidates: { jid: string; source: string }[] = [];

    // 🔍 BUSCA RECURSIVA: Encontrar TODOS os JIDs em qualquer nível do payload
    const findAllJids = (obj: any, path: string = '') => {
      if (!obj || typeof obj !== 'object') return;
      
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const currentPath = path ? `${path}.${key}` : key;
        
        if (typeof value === 'string' && value.includes('@')) {
          // Encontrou um JID!
          candidates.push({ jid: value, source: currentPath });
        } else if (typeof value === 'object' && value !== null) {
          // Continuar buscando recursivamente
          findAllJids(value, currentPath);
        }
      }
    };

    // Executar busca recursiva em todo o payload
    findAllJids(data);

    console.log(`🔍 [RESOLVE-PHONE] TODOS os JIDs encontrados no payload:`);
    candidates.forEach(c => console.log(`   📍 ${c.source}: ${c.jid}`));

    // PRIORIDADE 1: Procurar por @s.whatsapp.net (número real) - EXCLUINDO grupos
    const realNumber = candidates.find(c => 
      c.jid.includes('@s.whatsapp.net') && !c.jid.includes('@g.us')
    );
    if (realNumber) {
      const phone = this.extractPhoneNumber(realNumber.jid);
      console.log(`✅ [RESOLVE-PHONE] NÚMERO REAL encontrado: ${phone} (fonte: ${realNumber.source})`);
      return { phone, source: realNumber.source };
    }

    // PRIORIDADE 2: Procurar por @c.us (formato antigo, mas ainda real)
    const oldFormat = candidates.find(c => c.jid.includes('@c.us'));
    if (oldFormat) {
      const phone = this.extractPhoneNumber(oldFormat.jid);
      console.log(`✅ [RESOLVE-PHONE] Número @c.us encontrado: ${phone} (fonte: ${oldFormat.source})`);
      return { phone, source: oldFormat.source };
    }

    // FALLBACK: Usar @lid (ID interno - precisará de mapeamento se não houver número real)
    const lidFormat = candidates.find(c => c.jid.includes('@lid'));
    if (lidFormat) {
      const phone = this.extractPhoneNumber(lidFormat.jid);
      console.log(`⚠️ [RESOLVE-PHONE] Apenas @lid disponível: ${phone} (fonte: ${lidFormat.source})`);
      return { phone, source: `${lidFormat.source} (@lid)` };
    }

    // Último recurso: primeiro candidato disponível
    if (candidates.length > 0) {
      const phone = this.extractPhoneNumber(candidates[0].jid);
      console.log(`⚠️ [RESOLVE-PHONE] Fallback para primeiro candidato: ${phone}`);
      return { phone, source: candidates[0].source };
    }

    // Nenhum candidato
    console.error(`❌ [RESOLVE-PHONE] Nenhum JID encontrado no payload`);
    return { phone: '', source: 'none' };
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

    // Format phone number - try multiple variations to match Evolution API
    let cleanPhone = contactPhone.replace(/\D/g, ''); // Remove tudo que não é dígito
    console.log(`🔍 [FETCH-HISTORY] Telefone recebido: ${contactPhone} -> Dígitos: ${cleanPhone} (length: ${cleanPhone.length})`);
    
    // Build list of phone variations to try
    // Brazilian numbers can be 12 digits (55 + DDD + 8) or 13 digits (55 + DDD + 9 + 8)
    const phoneVariations: string[] = [];
    
    // Add original format
    if (cleanPhone.startsWith('55')) {
      phoneVariations.push(cleanPhone);
      
      // If 13 digits, also try removing the 9 (position 4 after 55)
      if (cleanPhone.length === 13) {
        const without9 = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
        phoneVariations.push(without9);
      }
      // If 12 digits, also try adding the 9
      else if (cleanPhone.length === 12) {
        const with9 = cleanPhone.slice(0, 4) + '9' + cleanPhone.slice(4);
        phoneVariations.push(with9);
      }
    } else if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
      // Número nacional sem código de país
      phoneVariations.push(`55${cleanPhone}`);
      if (cleanPhone.length === 11) {
        // Try without 9
        const without9 = cleanPhone.slice(0, 2) + cleanPhone.slice(3);
        phoneVariations.push(`55${without9}`);
      } else if (cleanPhone.length === 10) {
        // Try with 9
        const with9 = cleanPhone.slice(0, 2) + '9' + cleanPhone.slice(2);
        phoneVariations.push(`55${with9}`);
      }
    } else {
      phoneVariations.push(cleanPhone);
    }
    
    console.log(`🔍 [FETCH-HISTORY] Variações a tentar: ${phoneVariations.join(', ')}`);
    
    // Try each variation until we find messages
    for (const phoneVar of phoneVariations) {
      const remoteJid = `${phoneVar}@s.whatsapp.net`;
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
        
        const response = await fetch(`${this.config!.apiUrl}/chat/findMessages/${instanceName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.config!.apiKey
          },
          body: JSON.stringify(requestBody)
        });

        const firstPageData = await response.json();

        if (!response.ok) {
          console.error('❌ Erro ao buscar histórico de chat (HTTP):', response.status, firstPageData);
          continue; // Try next variation
        }

        // Parse the pagination info
        let allMessages: any[] = [];
        
        if (firstPageData.messages && firstPageData.messages.records) {
          const { total, pages, records } = firstPageData.messages;
          
          // If no messages found, try next variation
          if (total === 0) {
            console.log(`⚪ Nenhuma mensagem para ${remoteJid}, tentando próxima variação...`);
            continue;
          }
          
          allMessages = [...records];
          console.log(`📊 Total de mensagens: ${total}, Páginas: ${pages} (usando ${phoneVar})`);
          
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
          
          console.log(`✅ Total de mensagens obtidas: ${allMessages.length}`);
          return { success: true, messages: allMessages };
          
        } else if (Array.isArray(firstPageData) && firstPageData.length > 0) {
          // Old format - direct array
          console.log(`✅ Total de mensagens obtidas: ${firstPageData.length}`);
          return { success: true, messages: firstPageData };
        } else if (firstPageData.data && Array.isArray(firstPageData.data) && firstPageData.data.length > 0) {
          // Another format - data field
          console.log(`✅ Total de mensagens obtidas: ${firstPageData.data.length}`);
          return { success: true, messages: firstPageData.data };
        }
        
        // No messages in this format, try next variation
        console.log(`⚪ Nenhuma mensagem encontrada para ${remoteJid}`);
        
      } catch (error: any) {
        console.error(`❌ Erro ao buscar para ${phoneVar}:`, error.message);
        continue; // Try next variation
      }
    }
    
    // None of the variations found messages
    console.log(`⚪ Nenhuma mensagem encontrada para nenhuma variação de ${contactPhone}`);
    return { success: true, messages: [] };
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

  // Download media as base64 from Evolution API
  public async getBase64FromMediaMessage(
    instanceName: string,
    messageId: string
  ): Promise<{ success: boolean; base64?: string; mimetype?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Evolution API não está configurada' };
    }

    try {
      console.log(`📥 [EVOLUTION] Baixando mídia da mensagem: ${messageId}`);
      
      const response = await fetch(`${this.config!.apiUrl}/chat/getBase64FromMediaMessage/${instanceName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config!.apiKey
        },
        body: JSON.stringify({
          message: {
            key: {
              id: messageId
            }
          },
          convertToMp4: true
        }),
        signal: AbortSignal.timeout(60000) // 60 segundos para downloads grandes
      });

      const data = await response.json();

      if (!response.ok) {
        console.error(`❌ [EVOLUTION] Erro ao baixar mídia:`, data);
        return { success: false, error: data.message || 'Erro ao baixar mídia' };
      }

      if (data.base64) {
        console.log(`✅ [EVOLUTION] Mídia baixada com sucesso (${data.mimetype || 'unknown'})`);
        return { 
          success: true, 
          base64: data.base64,
          mimetype: data.mimetype
        };
      }

      return { success: false, error: 'Resposta sem base64' };
    } catch (error: any) {
      console.error(`❌ [EVOLUTION] Erro ao baixar mídia:`, error.message);
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
    // Evolution API v2 can wrap message in 'message' or send it directly
    const msg = message?.message || message;
    
    // Check for direct base64 in the message object (Evolution API v2 feature)
    const base64Data = msg?.base64 || message?.base64;
    const mimeType = msg?.mimetype || message?.mimetype;

    // Image
    if (msg?.imageMessage) {
      return {
        messageType: 'image',
        mediaUrl: msg.imageMessage.url || (base64Data ? `data:${mimeType || 'image/jpeg'};base64,${base64Data}` : undefined),
        mediaType: msg.imageMessage.mimetype || mimeType || 'image/jpeg',
        mediaSize: msg.imageMessage.fileLength,
        mediaFilename: 'image.jpg'
      };
    }
    
    // Video
    if (msg?.videoMessage) {
      return {
        messageType: 'video',
        mediaUrl: msg.videoMessage.url || (base64Data ? `data:${mimeType || 'video/mp4'};base64,${base64Data}` : undefined),
        mediaType: msg.videoMessage.mimetype || mimeType || 'video/mp4',
        mediaSize: msg.videoMessage.fileLength,
        mediaFilename: 'video.mp4'
      };
    }
    
    // Audio
    if (msg?.audioMessage) {
      return {
        messageType: 'audio',
        mediaUrl: msg.audioMessage.url || (base64Data ? `data:${mimeType || 'audio/ogg'};base64,${base64Data}` : undefined),
        mediaType: msg.audioMessage.mimetype || mimeType || 'audio/ogg',
        mediaSize: msg.audioMessage.fileLength,
        mediaFilename: 'audio.ogg'
      };
    }
    
    // Document
    if (msg?.documentMessage) {
      return {
        messageType: 'document',
        mediaUrl: msg.documentMessage.url || (base64Data ? `data:${mimeType || 'application/pdf'};base64,${base64Data}` : undefined),
        mediaType: msg.documentMessage.mimetype || mimeType || 'application/pdf',
        mediaSize: msg.documentMessage.fileLength,
        mediaFilename: msg.documentMessage.fileName || 'document'
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
