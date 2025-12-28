/**
 * Evolution API Polling Service
 * Alternative to webhooks - polls for new messages periodically
 */

import { evolutionAPIService } from './evolution-api-service';
import { storage } from './storage';

function normalizePhoneNumber(phone: string): string {
  let digitsOnly = phone.replace(/\D/g, '');
  if (digitsOnly.startsWith('55') && digitsOnly.length === 13) {
    return digitsOnly;
  } else if (digitsOnly.length === 11) {
    return `55${digitsOnly}`;
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

    // Then schedule periodic polling
    this.state.intervalId = setInterval(() => {
      this.poll();
    }, intervalMs);
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
      const existingMessages = await storage.getChatMessages(conversation.id);
      const isDuplicate = existingMessages.some(m => m.externalId === messageId);
      
      if (isDuplicate) {
        return false; // Already exists
      }

      // 3. Save message
      await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: isFromMe ? 'system' : customer.id,
        senderType: isFromMe ? 'system' : 'customer',
        content: messageText || '[Mídia/Outro]',
        messageType: 'text',
        externalId: messageId
      });

      // 4. Update conversation (lastMessage and status are handled by storage layer)
      await storage.updateChatConversation(conversation.id, {
        status: isFromMe ? conversation.status : 'new'
      });

      console.log(`✅ [POLLING] Mensagem salva: ${normalizedPhone} | FromMe: ${isFromMe} | ${messageText.substring(0, 30)}...`);
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
