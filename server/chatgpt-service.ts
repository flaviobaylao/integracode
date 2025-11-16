import OpenAI from "openai";
import type { ConversationWithCustomer, MessageWithSender } from "@shared/schema";
import { storage } from "./storage";
import { whatsappAnalysisService } from "./whatsapp-analysis-service";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user

export class ChatGPTService {
  private openai: OpenAI;
  private assistantId: string = "asst_4AM6M50fsOXKXlz5Ijc7IA9k"; // Fixed Assistant ID
  private isOnline: boolean = true;
  private knowledgeBaseCache: string | null = null;
  private knowledgeBaseCacheTime: number = 0;
  private knowledgeBaseCacheTTL: number = 5 * 60 * 1000; // 5 minutes
  
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async generateResponse(
    customerMessage: string,
    conversationHistory: MessageWithSender[],
    customer: { name: string; phone: string }
  ): Promise<{ response: string; shouldTransferToHuman: boolean }> {
    try {
      // Check if assistant is offline
      if (!this.isOnline) {
        return {
          response: "Nosso assistente virtual está temporariamente offline. Vou transferir você para um de nossos agentes humanos.",
          shouldTransferToHuman: true,
        };
      }

      // Use exclusively Assistants API with specific Assistant ID
      return await this.generateAssistantResponse(customerMessage, conversationHistory, customer);
    } catch (error) {
      console.error("ChatGPT API error:", error);
      return {
        response: "Desculpe, estou com dificuldades técnicas no momento. Vou transferir você para um de nossos agentes humanos que poderá ajudá-lo melhor.",
        shouldTransferToHuman: true,
      };
    }
  }

  private async loadKnowledgeBase(): Promise<string | null> {
    try {
      const now = Date.now();
      
      // Check if we have a valid cached version
      if (this.knowledgeBaseCache && (now - this.knowledgeBaseCacheTime) < this.knowledgeBaseCacheTTL) {
        return this.knowledgeBaseCache;
      }

      // Load latest knowledge base
      const latestKnowledge = await storage.getLatestKnowledgeBase();
      if (!latestKnowledge) {
        return null;
      }

      const content = await whatsappAnalysisService.readKnowledgeFileContent(latestKnowledge.filePath);
      
      // Cache the content
      this.knowledgeBaseCache = content;
      this.knowledgeBaseCacheTime = now;
      
      return content;
    } catch (error) {
      console.error("Error loading knowledge base:", error);
      return null;
    }
  }

  private async getCustomerContext(customer: { name: string; phone: string }): Promise<string> {
    try {
      const knowledgeBase = await this.loadKnowledgeBase();
      if (!knowledgeBase) {
        return "";
      }

      // Search for customer information in knowledge base
      const lines = knowledgeBase.split('\n');
      const customerSections: string[] = [];
      let currentSection = "";
      let isInCustomerSection = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check if this is the start of a conversation section
        if (line.startsWith('## CONVERSA ') || line.startsWith('## NOVA CONVERSA')) {
          if (isInCustomerSection && currentSection.trim()) {
            customerSections.push(currentSection.trim());
          }
          currentSection = line + '\n';
          isInCustomerSection = false;
          
          // Look ahead to check if this section is for our customer
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const checkLine = lines[j];
            if (checkLine.includes(`Nome: ${customer.name}`) || 
                checkLine.includes(`Telefone: ${customer.phone}`)) {
              isInCustomerSection = true;
              break;
            }
            if (checkLine.startsWith('## ')) {
              break;
            }
          }
        } else if (currentSection) {
          currentSection += line + '\n';
          
          // If we reached the end of a section
          if (line.startsWith('---') && isInCustomerSection) {
            if (currentSection.trim()) {
              customerSections.push(currentSection.trim());
            }
            currentSection = "";
            isInCustomerSection = false;
          }
        }
      }

      // Add the last section if it was for our customer
      if (isInCustomerSection && currentSection.trim()) {
        customerSections.push(currentSection.trim());
      }

      if (customerSections.length > 0) {
        return `\n\n=== HISTÓRICO DE CONVERSAS ANTERIORES ===\n${customerSections.join('\n\n')}\n=== FIM DO HISTÓRICO ===\n\n`;
      }

      return "";
    } catch (error) {
      console.error("Error getting customer context:", error);
      return "";
    }
  }

  private async generateAssistantResponse(
    customerMessage: string,
    conversationHistory: MessageWithSender[],
    customer: { name: string; phone: string }
  ): Promise<{ response: string; shouldTransferToHuman: boolean }> {
    try {
      // Create a thread for the conversation
      const thread = await this.openai.beta.threads.create();

      // Get customer context from knowledge base
      const customerContext = await this.getCustomerContext(customer);

      // Add conversation history to thread
      for (const msg of conversationHistory.slice(-5)) {
        const role = msg.senderType === 'customer' ? 'user' : 'assistant';
        await this.openai.beta.threads.messages.create(thread.id, {
          role: role,
          content: msg.content,
        });
      }

      // Add the current customer message with context
      const messageWithContext = customerContext 
        ? `${customerContext}Cliente: ${customer.name} (${customer.phone})\nMensagem atual: ${customerMessage}\n\nIMPORTANTE: Use as informações do histórico acima para personalizar sua resposta e reconhecer pedidos ou preferências anteriores do cliente.`
        : `Cliente: ${customer.name} (${customer.phone})\nMensagem: ${customerMessage}`;

      await this.openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: messageWithContext,
      });

      // Run the assistant
      const run = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: this.assistantId,
      });

      // Wait for completion
      let runStatus = await this.openai.beta.threads.runs.retrieve(run.id, {
        thread_id: thread.id
      });
      
      while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        runStatus = await this.openai.beta.threads.runs.retrieve(run.id, {
          thread_id: thread.id
        });
      }

      if (runStatus.status === 'completed') {
        // Get the assistant's response
        const messages = await this.openai.beta.threads.messages.list(thread.id);
        const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
        
        if (assistantMessage && assistantMessage.content[0].type === 'text') {
          const content = assistantMessage.content[0].text.value;
          const shouldTransferToHuman = content.includes("[TRANSFER_TO_HUMAN]");
          const cleanResponse = content.replace("[TRANSFER_TO_HUMAN]", "").trim();

          return {
            response: cleanResponse,
            shouldTransferToHuman,
          };
        }
      }

      // If assistant fails to respond properly
      throw new Error("Assistant failed to generate a response");
    } catch (error) {
      console.error("Error with OpenAI Assistant:", error);
      throw error;
    }
  }

  // Always auto-assign simple messages to the Assistant
  async shouldAutoAssignToChatGPT(customerMessage: string): Promise<boolean> {
    try {
      // Simple keyword-based analysis for basic greetings
      const greetings = ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'hey', 'hi', 'hello'];
      const simple = ['obrigado', 'obrigada', 'valeu', 'ok', 'tá', 'sim', 'não', 'nao'];
      
      const lowerMessage = customerMessage.toLowerCase();
      
      // Auto-assign greetings and simple responses
      const isGreeting = greetings.some(greeting => lowerMessage.includes(greeting));
      const isSimple = simple.some(word => lowerMessage === word.toLowerCase());
      
      // Auto-assign short messages (likely greetings or simple questions)
      const isShort = customerMessage.length < 50;
      
      return isGreeting || isSimple || isShort;
    } catch (error) {
      console.error("Error analyzing message for auto-assignment:", error);
      // Default to human assignment if analysis fails
      return false;
    }
  }

  // Update API key or Assistant ID dynamically
  updateApiKey(newApiKey: string): void {
    if (newApiKey.startsWith('asst-') || newApiKey.startsWith('asst_')) {
      this.assistantId = newApiKey;
      // Keep existing OpenAI client with environment API key for assistant API calls
    } else if (newApiKey.startsWith('sk-')) {
      this.openai = new OpenAI({ apiKey: newApiKey });
      // Keep the fixed Assistant ID
    }
  }

  // Test connection with OpenAI API
  async testConnection(): Promise<boolean> {
    try {
      // Test assistant connection
      const assistant = await this.openai.beta.assistants.retrieve(this.assistantId);
      return !!assistant && assistant.id === this.assistantId;
    } catch (error) {
      console.error("OpenAI connection test failed:", error);
      return false;
    }
  }

  // Control assistant online/offline status
  setOnlineStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
  }

  // Check if assistant is online
  getOnlineStatus(): boolean {
    return this.isOnline;
  }

  // Get current assistant configuration
  getAssistantInfo(): { assistantId: string; isOnline: boolean } {
    return {
      assistantId: this.assistantId,
      isOnline: this.isOnline,
    };
  }

  // Clear knowledge base cache (call this when knowledge base is updated)
  clearKnowledgeBaseCache(): void {
    this.knowledgeBaseCache = null;
    this.knowledgeBaseCacheTime = 0;
    console.log("Knowledge base cache cleared - will reload on next conversation");
  }

  // Get knowledge base status
  getKnowledgeBaseStatus(): { cached: boolean; cacheAge: number } {
    const now = Date.now();
    return {
      cached: this.knowledgeBaseCache !== null,
      cacheAge: this.knowledgeBaseCacheTime > 0 ? now - this.knowledgeBaseCacheTime : 0
    };
  }

  // Check if ChatGPT can handle new conversations
  canHandleNewConversations(): boolean {
    return this.isOnline;
  }
}

// Export singleton instance
export const chatGPTService = new ChatGPTService();