import OpenAI from "openai";
import type { ChatConversation, ChatMessage, ChatAiSettings } from "@shared/schema";
import { storage } from "./storage";
import { whatsappAnalysisService } from "./whatsapp-analysis-service";
import { grokService } from "./grok";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user

/**
 * Lógica central para processar mensagens de entrada e gerar respostas
 */
export async function handleIncomingMessage(
  conversation: { id: string; customerName: string; customerPhone: string },
  message: { content: string; timestamp: Date },
  settings: ChatAiSettings
) {
  try {
    console.log(`🤖 [AI-SERVICE] Processando mensagem de ${conversation.customerName} (${conversation.customerPhone})`);
    
    // 1. Buscar histórico recente
    const messages = await storage.getChatMessages(conversation.id);
    const recentMessages = messages.slice(-10).map((msg: any) => ({
      role: (msg.senderType === 'customer' ? 'customer' : (msg.senderId === 'system' ? 'bot' : 'agent')) as 'customer' | 'agent' | 'bot',
      content: msg.content || '',
      timestamp: new Date(msg.createdAt || msg.timestamp || Date.now())
    }));

    // 2. Gerar resposta
    const result = await generateAutoResponse({
      customerName: conversation.customerName,
      customerPhone: conversation.customerPhone,
      conversationId: conversation.id,
      recentMessages
    }, settings);

    console.log(`✨ [AI-SERVICE] Resposta gerada: "${result.response.reply.substring(0, 50)}..."`);

    // 3. Salvar log de auditoria
    await storage.createChatAiLog({
      conversationId: conversation.id,
      customerMessage: message.content,
      botResponse: result.response.reply,
      provider: (settings as any).aiProvider || 'openai',
      model: settings.gptModel || 'gpt-4o-mini',
      tokensUsed: result.tokensUsed,
      responseTimeMs: result.responseTimeMs,
      status: 'success'
    });

    // 4. Se a IA decidir que deve transferir, apenas atualizar status da conversa
    if (result.response.shouldTransfer) {
      console.log(`🔀 [AI-SERVICE] IA solicitou transferência: ${result.response.transferReason}`);
      await storage.updateChatConversation(conversation.id, {
        status: 'new' // Volta para a fila de atendimento humano
      });
    }

    // 5. Enviar resposta via WhatsApp (Evolution API)
    const { evolutionAPIService } = await import("./evolution-api-service");
    const config = evolutionAPIService.getConfig();
    
    if (config && config.instanceName) {
      const sendResult = await evolutionAPIService.sendTextMessage(
        config.instanceName,
        conversation.customerPhone,
        result.response.reply
      );

      if (sendResult.success) {
        // 6. Registrar a mensagem enviada pela IA no banco local
        await storage.createChatMessage({
          conversationId: conversation.id,
          senderId: 'system',
          senderType: 'agent',
          content: result.response.reply,
          messageType: 'text',
          externalId: sendResult.messageId || `ai_${Date.now()}`,
          isRead: true
        });
        
        console.log(`✅ [AI-SERVICE] Resposta enviada e registrada com sucesso!`);
      } else {
        console.error(`❌ [AI-SERVICE] Erro ao enviar via Evolution API:`, sendResult.error);
      }
    } else {
      console.error(`❌ [AI-SERVICE] Evolution API não configurada para enviar resposta`);
    }

  } catch (error: any) {
    console.error(`❌ [AI-SERVICE] Erro crítico ao processar mensagem:`, error.message);
    
    // Registrar erro no log
    try {
      await storage.createChatAiLog({
        conversationId: conversation.id,
        customerMessage: message.content,
        botResponse: null,
        errorMessage: error.message,
        status: 'error'
      });
    } catch (logErr) {
      console.error(`⚠️ [AI-SERVICE] Erro ao registrar log de erro:`, logErr);
    }
  }
}

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
    conversationHistory: ChatMessage[],
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
      const knowledge = await storage.getKnowledgeBase();
      const latestKnowledge = knowledge[knowledge.length - 1];
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
    conversationHistory: ChatMessage[],
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
          content: msg.content || '',
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

// ============================================================================
// FUNÇÕES AUXILIARES PARA ATENDIMENTO AUTOMÁTICO
// ============================================================================

import pLimit from "p-limit";
import pRetry from "p-retry";
import { type ChatAiSettings } from "@shared/schema";

// Rate limiter para evitar exceder limites da API
const limit = pLimit(2);

// Helper para verificar se é erro de rate limit
function isRateLimitError(error: any): boolean {
  const errorMsg = error?.message || String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

// Interface para resposta estruturada do ChatGPT para atendimento automático
export interface AutoChatResponse {
  reply: string;
  shouldTransfer: boolean;
  transferReason?: string;
}

// Interface para contexto da conversa
export interface ConversationContext {
  customerName: string;
  customerPhone: string;
  recentMessages: Array<{
    role: 'customer' | 'agent' | 'bot';
    content: string;
    timestamp: Date;
  }>;
  conversationId: string;
}

// Prompt padrão do sistema para atendimento automático
const DEFAULT_SYSTEM_PROMPT = `Você é um assistente virtual da empresa Honest Sucos, especializada em sucos naturais e bebidas saudáveis.

Seu objetivo é:
1. Responder dúvidas sobre produtos, preços e entregas
2. Auxiliar clientes com pedidos e informações
3. Ser cordial, profissional e objetivo
4. Identificar quando o cliente precisa falar com um atendente humano

Regras importantes:
- NUNCA invente informações sobre preços ou produtos específicos
- Se não souber algo, diga que vai verificar com a equipe
- Se o cliente pedir para falar com humano, atendente, gerente ou vendedor, SEMPRE transfira
- Se detectar reclamação grave, problema financeiro ou situação complexa, transfira para humano
- Mantenha respostas curtas e objetivas (máximo 3 parágrafos)
- Use linguagem informal mas profissional

Palavras-chave para transferir para humano:
- "falar com atendente", "humano", "pessoa", "gerente", "vendedor"
- "reclamação", "problema", "cancelar", "reembolso"
- Assuntos financeiros complexos ou dívidas`;

const DEFAULT_COMPANY_CONTEXT = `A Honest Sucos é uma empresa de sucos naturais localizada em Goiânia-GO.
Horário de funcionamento: Segunda a Sexta das 8h às 18h, Sábado das 8h às 12h.
Oferecemos entregas em toda região metropolitana.
Principais produtos: sucos naturais, polpas de frutas, açaí, smoothies.`;

// Cache de relatórios de IA (recarregado automaticamente)
let aiReportsCache: string | null = null;
let aiReportsCacheTime: number = 0;
const AI_REPORTS_CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function getAiReportsForContext(): Promise<string> {
  try {
    const now = Date.now();
    
    if (aiReportsCache && (now - aiReportsCacheTime) < AI_REPORTS_CACHE_TTL) {
      return aiReportsCache;
    }

    const { getAiReportsContext } = await import('./ai-reports-service');
    const reportsContext = await getAiReportsContext();
    
    aiReportsCache = reportsContext;
    aiReportsCacheTime = now;
    
    console.log(`📊 [AI-CONTEXT] Relatórios carregados para contexto (${reportsContext.length} chars)`);
    return reportsContext;
  } catch (error: any) {
    console.error(`❌ [AI-CONTEXT] Erro ao carregar relatórios:`, error.message);
    return "";
  }
}

// Gerar resposta automática usando configurações
export async function generateAutoResponse(
  context: ConversationContext,
  settings: ChatAiSettings
): Promise<{ response: AutoChatResponse; tokensUsed: number; responseTimeMs: number }> {
  const startTime = Date.now();

  const systemPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const companyContext = settings.companyContext || DEFAULT_COMPANY_CONTEXT;
  const model = settings.gptModel || "gpt-4o-mini";
  
  const aiReports = await getAiReportsForContext();
  const fullCompanyContext = aiReports 
    ? `${companyContext}\n\n--- DADOS ATUALIZADOS DO SISTEMA ---\n${aiReports}`
    : companyContext;

  // Construir histórico de mensagens para contexto
  const messageHistory = context.recentMessages.slice(-10).map(msg => ({
    role: msg.role === 'customer' ? 'user' as const : 'assistant' as const,
    content: msg.content
  }));

  // Verificar se deve transferir baseado em palavras-chave
  const lastCustomerMessage = context.recentMessages
    .filter(m => m.role === 'customer')
    .pop()?.content || '';
  
  const handoffKeywords = settings.handoffKeywords || [
    'atendente', 'humano', 'pessoa', 'gerente', 'vendedor',
    'reclamação', 'problema grave', 'cancelar pedido', 'reembolso'
  ];
  
  const shouldTransferByKeyword = handoffKeywords.some(keyword => 
    lastCustomerMessage.toLowerCase().includes(keyword.toLowerCase())
  );

  if (shouldTransferByKeyword) {
    return {
      response: {
        reply: "Entendo! Vou transferir você para um de nossos atendentes humanos que poderá ajudá-lo melhor. Aguarde um momento, por favor.",
        shouldTransfer: true,
        transferReason: "Cliente solicitou atendimento humano ou mencionou palavra-chave de escalonamento"
      },
      tokensUsed: 0,
      responseTimeMs: Date.now() - startTime
    };
  }

  // Verificar provedor de IA configurado
  const aiProvider = (settings as any).aiProvider || 'openai';
  
  // Se o provedor for Grok, usar o serviço do Grok
  if (aiProvider === 'grok') {
    console.log(`🔮 [GROK-AUTO] Usando Grok para responder`);
    
    try {
      if (!grokService.isAvailable()) {
        console.error('❌ [GROK-AUTO] Grok não está disponível');
        return {
          response: {
            reply: "O assistente Grok não está configurado. Um atendente humano irá ajudá-lo em breve.",
            shouldTransfer: true,
            transferReason: "Grok não configurado"
          },
          tokensUsed: 0,
          responseTimeMs: Date.now() - startTime
        };
      }

      const grokMessages = context.recentMessages.slice(-10).map(msg => ({
        senderType: msg.role === 'customer' ? 'customer' : 'agent',
        content: msg.content
      })) as any[];

      const grokResult = await grokService.generateResponse(
        lastCustomerMessage,
        grokMessages,
        { name: context.customerName, phone: context.customerPhone },
        systemPrompt,
        fullCompanyContext
      );

      return {
        response: {
          reply: grokResult.response,
          shouldTransfer: grokResult.shouldTransferToHuman,
          transferReason: grokResult.shouldTransferToHuman ? "Transferência solicitada pelo Grok" : undefined
        },
        tokensUsed: 0,
        responseTimeMs: Date.now() - startTime
      };
    } catch (error: any) {
      console.error('❌ [GROK-AUTO] Erro ao gerar resposta:', error.message);
      return {
        response: {
          reply: "Desculpe, estou com dificuldades técnicas no momento. Um atendente humano irá ajudá-lo em breve.",
          shouldTransfer: true,
          transferReason: `Erro técnico Grok: ${error.message}`
        },
        tokensUsed: 0,
        responseTimeMs: Date.now() - startTime
      };
    }
  }

  // Usar OpenAI como padrão
  console.log(`🤖 [OPENAI-AUTO] Usando OpenAI para responder`);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const result = await limit(() =>
      pRetry(
        async () => {
          const response = await openai.chat.completions.create({
            model,
            messages: [
              {
                role: "system",
                content: `${systemPrompt}

CONTEXTO DA EMPRESA:
${fullCompanyContext}

INFORMAÇÕES DO CLIENTE:
- Nome: ${context.customerName}
- Telefone: ${context.customerPhone}

INSTRUÇÕES DE RESPOSTA:
Responda em JSON com o seguinte formato:
{
  "reply": "sua resposta ao cliente",
  "shouldTransfer": false,
  "transferReason": null
}

Se precisar transferir para humano, use:
{
  "reply": "mensagem de despedida antes da transferência",
  "shouldTransfer": true,
  "transferReason": "motivo da transferência"
}`
              },
              ...messageHistory
            ],
            response_format: { type: "json_object" },
            max_tokens: 500,
            temperature: 0.7,
          });

          const content = response.choices[0]?.message?.content || '{}';
          const parsed = JSON.parse(content) as AutoChatResponse;
          
          return {
            response: {
              reply: parsed.reply || "Desculpe, não consegui processar sua mensagem. Posso ajudar com algo mais?",
              shouldTransfer: parsed.shouldTransfer || false,
              transferReason: parsed.transferReason
            },
            tokensUsed: response.usage?.total_tokens || 0
          };
        },
        {
          retries: 3,
          minTimeout: 1000,
          maxTimeout: 10000,
          factor: 2
        }
      )
    );

    return {
      ...result,
      responseTimeMs: Date.now() - startTime
    };
  } catch (error: any) {
    console.error('❌ [CHATGPT-AUTO] Erro ao gerar resposta:', error.message);
    
    // Retornar resposta de fallback em caso de erro
    return {
      response: {
        reply: "Desculpe, estou com dificuldades técnicas no momento. Um atendente humano irá ajudá-lo em breve.",
        shouldTransfer: true,
        transferReason: `Erro técnico: ${error.message}`
      },
      tokensUsed: 0,
      responseTimeMs: Date.now() - startTime
    };
  }
}

// Verificar se ChatGPT deve responder baseado nas configurações
export function shouldAutoRespond(
  settings: ChatAiSettings,
  hasHumanAgent: boolean,
  lastHumanResponseTime: Date | null,
  currentTime: Date = new Date()
): { shouldRespond: boolean; reason: string } {
  if (!settings.isEnabled) {
    return { shouldRespond: false, reason: "ChatGPT está desabilitado" };
  }

  switch (settings.mode) {
    case "disabled":
      return { shouldRespond: false, reason: "Modo desabilitado" };

    case "manual":
      // Sempre responde quando habilitado manualmente
      return { shouldRespond: true, reason: "Modo manual ativo" };

    case "schedule":
      // Verificar se está dentro do horário configurado
      const isInSchedule = isWithinBusinessHours(settings.businessHours, currentTime);
      return { 
        shouldRespond: isInSchedule, 
        reason: isInSchedule ? "Dentro do horário configurado" : "Fora do horário configurado"
      };

    case "timeout":
      // Verificar se passou o tempo de timeout sem resposta humana
      if (!lastHumanResponseTime) {
        // Se nunca houve resposta humana, assumir conversa
        return { shouldRespond: true, reason: "Sem resposta humana, assumindo conversa" };
      }
      
      const timeoutMs = (settings.timeoutMinutes || 5) * 60 * 1000;
      const timeSinceLastResponse = currentTime.getTime() - lastHumanResponseTime.getTime();
      
      if (timeSinceLastResponse >= timeoutMs) {
        return { shouldRespond: true, reason: `Timeout de ${settings.timeoutMinutes} minutos atingido` };
      }
      
      return { shouldRespond: false, reason: "Aguardando resposta humana (timeout não atingido)" };

    default:
      return { shouldRespond: false, reason: "Modo desconhecido" };
  }
}

// Verificar se está dentro do horário de atendimento configurado
function isWithinBusinessHours(
  businessHours: any,
  currentTime: Date = new Date()
): boolean {
  if (!businessHours) return false;

  try {
    const config = typeof businessHours === 'string' 
      ? JSON.parse(businessHours) 
      : businessHours;

    if (!config.weekdays || !config.startTime || !config.endTime) {
      return false;
    }

    // Mapear dia da semana para código
    const dayMap: Record<number, string> = {
      0: 'Dom', 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sab'
    };
    
    const currentDay = dayMap[currentTime.getDay()];
    
    // Verificar se é um dia configurado
    if (config.weekdays && !config.weekdays.includes(currentDay)) {
      return false;
    }

    // Verificar horário
    const currentHour = currentTime.getHours();
    const currentMinute = currentTime.getMinutes();
    const currentTimeMinutes = currentHour * 60 + currentMinute;

    const [startH, startM] = config.startTime.split(':').map(Number);
    const [endH, endM] = config.endTime.split(':').map(Number);
    
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    return currentTimeMinutes >= startMinutes && currentTimeMinutes <= endMinutes;
  } catch (e) {
    console.error("Error parsing business hours:", e);
    return false;
  }
}

// Check if OpenAI API is configured
export function isOpenAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

console.log(`✅ [CHATGPT] Serviço inicializado | OpenAI configurada: ${isOpenAIConfigured()}`);