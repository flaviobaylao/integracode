/**
 * Evolution API Polling Service
 * Alternative to webhooks - polls for new messages periodically
 */

import { evolutionAPIService } from './evolution-api-service';
import { storage } from './storage';
import { uploadMediaFromBase64 } from './whatsapp-media-storage';

// 🔧 FUNÇÃO DE NORMALIZAÇÃO DE TELEFONE - INCLUI MAPEAMENTOS CONHECIDOS
function normalizePhoneNumber(phone: string): string {
  if (!phone) {
    console.warn(`⚠️  [POLLING-NORMALIZE] Telefone vazio recebido`);
    return '';
  }
  
  // Remove tudo que não é dígito e o sufixo @lid/@s.whatsapp.net se vier na string
  let digitsOnly = phone.split('@')[0].replace(/\D/g, '');
  
  // IDs internos da Evolution API (padrão 5550...) ou números problemáticos conhecidos
  const mappings: { [key: string]: string } = {
    '5550575396912': '5562996353860',
    '5504884295924': '5562995782812',
    '173250575396912': '5562996353860',
    '50575396912': '5562996353860',
    '04884295924': '5562995782812',
    '5550575396012': '5562996353860',
    '5504884295924@s.whatsapp.net': '5562995782812'
  };

  if (mappings[digitsOnly]) {
    console.log(`🎯 [POLLING-NORMALIZE] Mapeando ID conhecido ${digitsOnly} para ${mappings[digitsOnly]}`);
    return mappings[digitsOnly];
  }

  // Se começar com 55 e tiver 12 ou 13 dígitos, remove o 55 para normalizar o resto
  if (digitsOnly.startsWith('55') && (digitsOnly.length === 12 || digitsOnly.length === 13)) {
    const candidate = digitsOnly.slice(2);
    if (mappings[candidate]) {
      console.log(`🎯 [POLLING-NORMALIZE] Mapeando ID conhecido (sem 55) ${candidate} para ${mappings[candidate]}`);
      return mappings[candidate];
    }
  }
  
  // No Brasil, celulares têm 11 dígitos (DDD + 9 + número) ou 10 dígitos (DDD + número)
  if (digitsOnly.length === 10) {
    const ddd = digitsOnly.slice(0, 2);
    const rest = digitsOnly.slice(2);
    digitsOnly = `${ddd}9${rest}`;
    console.log(`📞 [POLLING-NORMALIZE] Adicionado 9: ${digitsOnly}`);
  }
  
  // Adicionar prefixo 55 para formato brasileiro completo
  if (digitsOnly.length === 11) {
    return `55${digitsOnly}`;
  } else if (digitsOnly.startsWith('55') && digitsOnly.length === 13) {
    return digitsOnly;
  } else if (digitsOnly.startsWith('55')) {
    return digitsOnly;
  } else {
    return `55${digitsOnly}`;
  }
}

interface PollingState {
  isPolling: boolean;
  intervalId: NodeJS.Timeout | null;
  lastPollTime: Date | null;
  processedMessageIds: Set<string>;
  pollingIntervalMs: number;
}

class EvolutionPollingService {
  private state: PollingState = {
    isPolling: false,
    intervalId: null,
    lastPollTime: null,
    processedMessageIds: new Set(),
    pollingIntervalMs: 10000 // 10 seconds default
  };

  private maxCachedMessageIds = 10000; // Limit cache size

  /**
   * Start the polling service
   */
  public start(intervalMs: number = 10000): void {
    if (this.state.isPolling) {
      console.log('⚠️ [POLLING] Serviço de polling já está ativo');
      return;
    }

    this.state.pollingIntervalMs = intervalMs;
    this.state.isPolling = true;

    console.log(`🔄 [POLLING] Iniciando serviço de polling a cada ${intervalMs / 1000}s`);

    // Run immediately
    this.poll();

    // schedule periodic polling
    this.state.intervalId = setInterval(() => {
      this.poll();
    }, 30000); // Changed to 30s to match scheduler and avoid overlapping logic
  }

  /**
   * Stop the polling service
   */
  public stop(): void {
    if (!this.state.isPolling) {
      console.log('⚠️ [POLLING] Serviço de polling já está parado');
      return;
    }

    if (this.state.intervalId) {
      clearInterval(this.state.intervalId);
      this.state.intervalId = null;
    }

    this.state.isPolling = false;
    console.log('🛑 [POLLING] Serviço de polling parado');
  }

  /**
   * Get polling status
   */
  public getStatus(): { 
    isPolling: boolean; 
    lastPollTime: Date | null; 
    intervalMs: number;
    cachedMessageCount: number;
  } {
    return {
      isPolling: this.state.isPolling,
      lastPollTime: this.state.lastPollTime,
      intervalMs: this.state.pollingIntervalMs,
      cachedMessageCount: this.state.processedMessageIds.size
    };
  }

  /**
   * Main polling function - fetches and processes new messages
   */
  private async poll(): Promise<void> {
    if (!evolutionAPIService.isConfigured()) {
      return;
    }

    const config = evolutionAPIService.getConfig();
    if (!config) {
      return;
    }

    try {
      // 1. Fetch all active chats
      const chatsResult = await evolutionAPIService.fetchAllChats(config.instanceName);
      
      if (!chatsResult.success || !chatsResult.chats) {
        return;
      }

      const chats = chatsResult.chats;
      
      // Filter only individual chats (not groups)
      const individualChats = chats.filter((chat: any) => {
        const jid = chat.id || chat.jid || chat.remoteJid || '';
        return jid.includes('@s.whatsapp.net') && !jid.includes('@g.us');
      });

      // 2. For each chat, fetch recent messages
      for (const chat of individualChats.slice(0, 20)) { // Limit to 20 most recent chats
        const jid = chat.id || chat.jid || chat.remoteJid;
        const phoneNumber = evolutionAPIService.extractPhoneNumber(jid);
        
        await this.fetchAndProcessMessages(config.instanceName, phoneNumber);
      }

      this.state.lastPollTime = new Date();

      // Cleanup old message IDs to prevent memory bloat
      if (this.state.processedMessageIds.size > this.maxCachedMessageIds) {
        const idsArray = Array.from(this.state.processedMessageIds);
        const toRemove = idsArray.slice(0, idsArray.length - this.maxCachedMessageIds / 2);
        toRemove.forEach(id => this.state.processedMessageIds.delete(id));
      }

    } catch (error: any) {
      console.error('❌ [POLLING] Erro no ciclo de polling:', error.message);
    }
  }

  /**
   * Fetch and process messages for a specific phone number
   */
  private async fetchAndProcessMessages(instanceName: string, phoneNumber: string): Promise<number> {
    try {
      const result = await evolutionAPIService.fetchChatHistory(instanceName, phoneNumber, 50);
      
      if (!result.success || !result.messages) {
        return 0;
      }

      let processedCount = 0;

      for (const msg of result.messages) {
        const messageId = msg.key?.id;
        
        if (!messageId) continue;

        // Skip if already processed in memory
        if (this.state.processedMessageIds.has(messageId)) {
          continue;
        }

        // Process the message
        const wasProcessed = await this.processMessage(msg, phoneNumber);
        
        if (wasProcessed) {
          processedCount++;
        }

        // Mark as processed
        this.state.processedMessageIds.add(messageId);
      }

      if (processedCount > 0) {
        console.log(`📥 [POLLING] Processadas ${processedCount} novas mensagens de ${phoneNumber}`);
      }

      return processedCount;
    } catch (error: any) {
      console.error(`❌ [POLLING] Erro ao processar mensagens de ${phoneNumber}:`, error.message);
      return 0;
    }
  }

  /**
   * Detect message type from Evolution API message structure
   */
  private detectMessageType(message: any): { type: 'text' | 'image' | 'audio' | 'video' | 'document', hasMedia: boolean } {
    if (!message) return { type: 'text', hasMedia: false };
    
    if (message.imageMessage) return { type: 'image', hasMedia: true };
    if (message.audioMessage) return { type: 'audio', hasMedia: true };
    if (message.videoMessage) return { type: 'video', hasMedia: true };
    if (message.documentMessage) return { type: 'document', hasMedia: true };
    if (message.stickerMessage) return { type: 'image', hasMedia: true };
    
    return { type: 'text', hasMedia: false };
  }

  /**
   * Download media from Evolution API and upload to object storage
   */
  private async downloadAndStoreMedia(messageId: string, messageType: string): Promise<string | null> {
    try {
      const config = evolutionAPIService.getConfig();
      if (!config) {
        console.warn('📷 [POLLING-MEDIA] Evolution API não configurada');
        return null;
      }

      console.log(`📷 [POLLING-MEDIA] Baixando mídia: ${messageId} (tipo: ${messageType})`);

      const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(
        config.instanceName,
        messageId
      );

      if (!mediaResult.success || !mediaResult.base64) {
        console.warn(`⚠️  [POLLING-MEDIA] Falha ao baixar mídia ${messageId}: ${mediaResult.error || 'sem dados'}`);
        return null;
      }

      const mimeType = mediaResult.mimetype || this.getMimeTypeFromMessageType(messageType);
      const extension = this.getExtensionFromMimeType(mimeType);
      const fileName = `${messageId}.${extension}`;

      console.log(`📤 [POLLING-MEDIA] Fazendo upload: ${fileName} (${mimeType})`);

      const uploadResult = await uploadMediaFromBase64(
        mediaResult.base64,
        mimeType,
        fileName
      );

      if (uploadResult.success && uploadResult.objectPath) {
        console.log(`✅ [POLLING-MEDIA] Upload concluído: ${uploadResult.objectPath}`);
        return uploadResult.objectPath;
      }

      console.warn(`⚠️  [POLLING-MEDIA] Falha no upload: ${uploadResult.error || 'erro desconhecido'}`);
      return null;

    } catch (error: any) {
      console.error(`❌ [POLLING-MEDIA] Erro ao processar mídia ${messageId}:`, error.message);
      return null;
    }
  }

  private getMimeTypeFromMessageType(messageType: string): string {
    switch (messageType) {
      case 'image': return 'image/jpeg';
      case 'audio': return 'audio/ogg';
      case 'video': return 'video/mp4';
      case 'document': return 'application/octet-stream';
      default: return 'application/octet-stream';
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const map: { [key: string]: string } = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    };
    return map[mimeType] || 'bin';
  }

  /**
   * Process a single message (similar to webhook handler)
   */
  private async processMessage(data: any, originalPhone: string): Promise<boolean> {
    try {
      const rawRemoteJid = data.key?.remoteJid;
      if (!rawRemoteJid || rawRemoteJid.includes('@g.us')) {
        return false; // Skip groups
      }

      const phoneNumber = evolutionAPIService.extractPhoneNumber(rawRemoteJid);
      const cleanPhone = phoneNumber.replace(/\D/g, '');

      // Phone mapping lookup
      let targetPhone = phoneNumber;
      const phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
      
      if (phoneMapping) {
        targetPhone = phoneMapping.canonicalPhone;
        console.log(`🔄 [POLLING] Remapeando: ${phoneNumber} -> ${targetPhone}`);
      }

      const normalizedPhone = normalizePhoneNumber(targetPhone);
      const isFromMe = data.key?.fromMe === true;
      const messageText = evolutionAPIService.extractMessageText(data.message || {}) || '';
      const messageId = data.key?.id;

      // Detect message type (text, image, audio, video, document)
      const { type: messageType, hasMedia } = this.detectMessageType(data.message);

      // Lookup contact in phonebook
      const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
      const identifiedName = phonebookContact?.name || data.pushName || `Cliente ${normalizedPhone}`;

      // 1. Ensure customer and conversation exist
      let conversation = await storage.getChatConversationByPhone(normalizedPhone);
      let customer = await storage.getChatCustomerByPhone(normalizedPhone);

      if (!customer) {
        customer = await storage.createChatCustomer({
          phone: normalizedPhone,
          name: identifiedName
        });
      } else if (phonebookContact && customer.name !== identifiedName) {
        await storage.updateChatCustomer(customer.id, { name: identifiedName });
      }

      if (!conversation) {
        conversation = await storage.createChatConversation({
          customerId: customer.id,
          customerName: identifiedName,
          customerPhone: normalizedPhone,
          status: 'new',
          priority: 'normal'
        });
      } else if (phonebookContact && conversation.customerName !== identifiedName) {
        await storage.updateChatConversation(conversation.id, { customerName: identifiedName });
      }

      // 2. Check for duplicate (by externalId in database)
      const isDuplicate = await storage.getChatMessageByExternalId(messageId);
      
      if (isDuplicate) {
        return false; // Already exists
      }

      // 3. Process media if present
      let mediaUrl: string | null = null;
      let content = messageText;

      if (hasMedia) {
        console.log(`📷 [POLLING] Mensagem com mídia detectada: ${messageId} (${messageType})`);
        mediaUrl = await this.downloadAndStoreMedia(messageId, messageType);
        
        if (!content || content === '') {
          content = '[Mensagem de mídia]';
        }
      }

      // 4. Save message with correct type and media URL
      await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: isFromMe ? 'system' : customer.id,
        senderType: isFromMe ? 'system' : 'customer',
        content: content || '[Mídia/Outro]',
        messageType: messageType,
        mediaUrl: mediaUrl || undefined,
        externalId: messageId
      });

      // 5. Update conversation (lastMessage and status are handled by storage layer)
      await storage.updateChatConversation(conversation.id, {
        status: isFromMe ? conversation.status : 'new'
      });

      const mediaInfo = hasMedia ? ` | Mídia: ${mediaUrl ? '✅' : '❌'}` : '';
      console.log(`✅ [POLLING] Mensagem salva: ${normalizedPhone} | Tipo: ${messageType}${mediaInfo} | ${content.substring(0, 30)}...`);
      return true;

    } catch (error: any) {
      console.error('❌ [POLLING] Erro ao processar mensagem:', error.message);
      return false;
    }
  }

  /**
   * Force poll for a specific phone number (on-demand)
   */
  public async pollForPhone(phoneNumber: string): Promise<{ success: boolean; count: number; error?: string }> {
    if (!evolutionAPIService.isConfigured()) {
      return { success: false, count: 0, error: 'Evolution API não configurada' };
    }

    const config = evolutionAPIService.getConfig();
    if (!config) {
      return { success: false, count: 0, error: 'Configuração não encontrada' };
    }

    try {
      const count = await this.fetchAndProcessMessages(config.instanceName, phoneNumber);
      return { success: true, count };
    } catch (error: any) {
      return { success: false, count: 0, error: error.message };
    }
  }
}

export const evolutionPollingService = new EvolutionPollingService();
