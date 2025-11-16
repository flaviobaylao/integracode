export interface WhatsAppMessage {
  id: string;
  from: string;
  to: string;
  text?: {
    body: string;
  };
  timestamp: number;
  type: 'text' | 'image' | 'document' | 'audio' | 'video';
}

export interface WhatsAppTemplate {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  components: any[];
}

export interface WhatsAppWebhookData {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: {
            name: string;
          };
          wa_id: string;
        }>;
        messages?: WhatsAppMessage[];
        statuses?: Array<{
          id: string;
          status: 'sent' | 'delivered' | 'read' | 'failed';
          timestamp: number;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

export interface WhatsAppApiConfig {
  accessToken: string;
  phoneNumberId: string;
  webhookVerifyToken: string;
  businessAccountId?: string;
  apiVersion?: string;
}

class WhatsAppOfficialAPI {
  private config: WhatsAppApiConfig | null = null;
  private baseUrl: string;
  private messageCallbacks: ((message: WhatsAppMessage) => void)[] = [];
  private statusCallbacks: ((status: any) => void)[] = [];

  constructor() {
    this.baseUrl = 'https://graph.facebook.com';
  }

  public configure(config: WhatsAppApiConfig): void {
    this.config = {
      ...config,
      apiVersion: config.apiVersion || 'v19.0'
    };
    console.log('✅ WhatsApp Official API configured');
  }

  public isConfigured(): boolean {
    return this.config !== null && 
           this.config.accessToken !== '' && 
           this.config.phoneNumberId !== '';
  }

  public getConfig(): WhatsAppApiConfig | null {
    return this.config;
  }

  // Alias for compatibility
  public async sendMessage(to: string, text: string): Promise<void> {
    const result = await this.sendTextMessage(to, text);
    if (result.error) {
      throw new Error(result.error);
    }
  }

  // Send a text message
  public async sendTextMessage(to: string, text: string): Promise<{ messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/\D/g, ''), // Remove non-numeric characters
      type: 'text',
      text: {
        preview_url: true,
        body: text
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp API Error:', data);
        return { 
          error: data.error?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }

      console.log('✅ Message sent successfully:', data);
      return { messageId: data.messages?.[0]?.id };
    } catch (error: any) {
      console.error('❌ Error sending WhatsApp message:', error);
      return { error: error.message };
    }
  }

  // Send a template message
  public async sendTemplateMessage(
    to: string, 
    templateName: string, 
    languageCode: string = 'pt_BR',
    components?: any[]
  ): Promise<{ messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/\D/g, ''),
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode
        },
        components: components || []
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp Template API Error:', data);
        return { 
          error: data.error?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }

      console.log('✅ Template message sent successfully:', data);
      return { messageId: data.messages?.[0]?.id };
    } catch (error: any) {
      console.error('❌ Error sending WhatsApp template:', error);
      return { error: error.message };
    }
  }

  // Send media message (image, audio, video, document)
  public async sendMediaMessage(
    to: string,
    mediaUrl: string,
    mediaType: 'image' | 'audio' | 'video' | 'document',
    caption?: string
  ): Promise<{ messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.phoneNumberId}/messages`;
    
    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/\D/g, ''),
      type: mediaType,
      [mediaType]: {
        link: mediaUrl
      }
    };

    if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
      payload[mediaType].caption = caption;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp Media API Error:', data);
        return { 
          error: data.error?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }

      console.log(`✅ ${mediaType} sent successfully via WhatsApp Official API`);
      return { messageId: data.messages?.[0]?.id };
    } catch (error: any) {
      console.error(`❌ Error sending ${mediaType}:`, error);
      return { error: error.message };
    }
  }

  // Send location message
  public async sendLocationMessage(
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string
  ): Promise<{ messageId?: string; error?: string }> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/\D/g, ''),
      type: 'location',
      location: {
        latitude: latitude,
        longitude: longitude,
        name: name || 'Localização',
        address: address || `${latitude}, ${longitude}`
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp Location API Error:', data);
        return { 
          error: data.error?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }

      console.log('✅ Location sent successfully via WhatsApp Official API');
      return { messageId: data.messages?.[0]?.id };
    } catch (error: any) {
      console.error('❌ Error sending location:', error);
      return { error: error.message };
    }
  }

  // Get business phone number info
  public async getPhoneNumberInfo(): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.phoneNumberId}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp Phone Info Error:', data);
        throw new Error(data.error?.message || 'Erro ao buscar informações do número');
      }

      return data;
    } catch (error: any) {
      console.error('❌ Error getting phone number info:', error);
      throw error;
    }
  }

  // Get message templates
  public async getTemplates(): Promise<WhatsAppTemplate[]> {
    if (!this.isConfigured()) {
      throw new Error('WhatsApp API não está configurada');
    }

    if (!this.config!.businessAccountId) {
      throw new Error('Business Account ID não configurado');
    }

    const url = `${this.baseUrl}/${this.config!.apiVersion}/${this.config!.businessAccountId}/message_templates`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config!.accessToken}`
        }
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('❌ WhatsApp Templates Error:', data);
        throw new Error(data.error?.message || 'Erro ao buscar templates');
      }

      return data.data || [];
    } catch (error: any) {
      console.error('❌ Error getting templates:', error);
      throw error;
    }
  }

  // Verify webhook
  public verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (!this.config) {
      console.error('❌ WhatsApp API not configured for webhook verification');
      return null;
    }

    if (mode === 'subscribe' && token === this.config.webhookVerifyToken) {
      console.log('✅ Webhook verified successfully');
      return challenge;
    }

    console.error('❌ Webhook verification failed');
    return null;
  }

  // Process incoming webhook data
  public processWebhook(data: WhatsAppWebhookData): void {
    console.log('📨 Processing WhatsApp webhook data:', JSON.stringify(data, null, 2));

    if (data.object !== 'whatsapp_business_account') {
      console.log('⚠️ Ignoring non-WhatsApp webhook');
      return;
    }

    data.entry.forEach(entry => {
      entry.changes.forEach(change => {
        if (change.field === 'messages') {
          const { messages, contacts, statuses } = change.value;

          // Process incoming messages
          if (messages) {
            messages.forEach(message => {
              console.log(`📩 Received message from ${message.from}: ${message.text?.body || '[media]'}`);
              this.notifyMessageReceived(message);
            });
          }

          // Process message statuses
          if (statuses) {
            statuses.forEach(status => {
              console.log(`📊 Message ${status.id} status: ${status.status}`);
              this.notifyStatusChange(status);
            });
          }
        }
      });
    });
  }

  // Test connection
  public async testConnection(): Promise<{ success: boolean; error?: string; phoneNumber?: string }> {
    try {
      const phoneInfo = await this.getPhoneNumberInfo();
      return { 
        success: true, 
        phoneNumber: phoneInfo.display_phone_number 
      };
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Callback management
  public onMessageReceived(callback: (message: WhatsAppMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  public onStatusChange(callback: (status: any) => void): void {
    this.statusCallbacks.push(callback);
  }

  private notifyMessageReceived(message: WhatsAppMessage): void {
    this.messageCallbacks.forEach(callback => {
      try {
        callback(message);
      } catch (error) {
        console.error('❌ Error in message callback:', error);
      }
    });
  }

  private notifyStatusChange(status: any): void {
    this.statusCallbacks.forEach(callback => {
      try {
        callback(status);
      } catch (error) {
        console.error('❌ Error in status callback:', error);
      }
    });
  }
}

// Singleton instance
export const whatsappOfficialAPI = new WhatsAppOfficialAPI();