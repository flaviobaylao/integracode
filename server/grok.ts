import OpenAI from "openai";
import type { MessageWithSender } from "@shared/schema";

const XAI_API_KEY = process.env.XAI_API_KEY;

export class GrokService {
  private client: OpenAI | null = null;
  private isOnline: boolean = true;

  constructor() {
    if (XAI_API_KEY) {
      this.client = new OpenAI({ 
        baseURL: "https://api.x.ai/v1", 
        apiKey: XAI_API_KEY 
      });
    }
  }

  isAvailable(): boolean {
    return !!this.client && this.isOnline;
  }

  async generateResponse(
    customerMessage: string,
    conversationHistory: MessageWithSender[],
    customer: { name: string; phone: string },
    systemPrompt: string,
    companyContext: string
  ): Promise<{ response: string; shouldTransferToHuman: boolean }> {
    try {
      if (!this.client) {
        console.error("[GROK] API key não configurada");
        return {
          response: "O assistente Grok não está configurado. Por favor, configure a chave de API nas configurações.",
          shouldTransferToHuman: true,
        };
      }

      if (!this.isOnline) {
        return {
          response: "Nosso assistente virtual está temporariamente offline. Vou transferir você para um de nossos agentes humanos.",
          shouldTransferToHuman: true,
        };
      }

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

      const fullSystemPrompt = `${systemPrompt}

=== CONTEXTO DA EMPRESA ===
${companyContext}

=== INFORMAÇÕES DO CLIENTE ===
Nome: ${customer.name}
Telefone: ${customer.phone}

INSTRUÇÕES IMPORTANTES:
- Seja prestativo, profissional e amigável
- Responda em português do Brasil
- Se não souber a resposta, indique que vai transferir para um atendente humano
- Mantenha as respostas concisas e diretas`;

      messages.push({
        role: "system",
        content: fullSystemPrompt,
      });

      const recentHistory = conversationHistory.slice(-10);
      for (const msg of recentHistory) {
        messages.push({
          role: msg.senderType === "customer" ? "user" : "assistant",
          content: msg.content,
        });
      }

      messages.push({
        role: "user",
        content: customerMessage,
      });

      console.log(`[GROK] Enviando ${messages.length} mensagens para o modelo grok-2-1212`);

      const response = await this.client.chat.completions.create({
        model: "grok-2-1212",
        messages: messages,
        temperature: 0.7,
        max_tokens: 800,
      });

      const responseText = response.choices[0]?.message?.content?.trim() || "";

      console.log(`[GROK] Resposta gerada com ${responseText.length} caracteres`);

      const transferKeywords = [
        "transferir",
        "atendente humano",
        "falar com pessoa",
        "pessoa real",
        "humano",
        "não consigo ajudar",
        "não sei responder",
      ];

      const shouldTransfer = transferKeywords.some((keyword) =>
        responseText.toLowerCase().includes(keyword)
      );

      return {
        response: responseText,
        shouldTransferToHuman: shouldTransfer,
      };
    } catch (error: any) {
      console.error("[GROK] Erro ao gerar resposta:", error.response?.data || error.message);
      return {
        response: "Desculpe, estou com dificuldades técnicas no momento. Vou transferir você para um de nossos agentes humanos.",
        shouldTransferToHuman: true,
      };
    }
  }

  setOnline(status: boolean): void {
    this.isOnline = status;
  }

  getStatus(): { online: boolean; configured: boolean } {
    return {
      online: this.isOnline,
      configured: !!this.client,
    };
  }
}

export const grokService = new GrokService();
