import OpenAI from "openai";
import type { MessageWithSender, WhatsappConversationAnalysis, InsertWhatsappConversationAnalysis } from "@shared/schema";
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ExtractedCommercialData {
  customerName?: string;
  companyRepresentative?: string;
  orderDate?: string;
  orderItems?: Array<{
    productName: string;
    quantity: number;
    price?: string;
    size?: string;
  }>;
  totalAmount?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  paymentMethod?: string;
  orderStatus?: string;
  notes?: string;
}

export class WhatsAppAnalysisService {
  private openai: OpenAI;
  private knowledgeBaseDir: string = './knowledge-base';

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.ensureKnowledgeBaseDirectory();
  }

  private async ensureKnowledgeBaseDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.knowledgeBaseDir, { recursive: true });
    } catch (error) {
      console.error('Error creating knowledge base directory:', error);
    }
  }

  async analyzeConversation(
    conversationId: string,
    messages: MessageWithSender[],
    customerInfo: { name: string; phone: string }
  ): Promise<ExtractedCommercialData> {
    try {
      // Prepare conversation text for analysis
      const conversationText = this.formatConversationForAnalysis(messages, customerInfo);

      // Create analysis prompt
      const analysisPrompt = `
Analise a seguinte conversa do WhatsApp de um negócio e extraia as informações comerciais importantes.
Retorne apenas um JSON válido com as informações encontradas.

Conversa:
${conversationText}

Extraia APENAS as informações que estão claramente presentes na conversa. Se uma informação não estiver disponível, não invente - deixe o campo vazio ou omita.

Estrutura JSON esperada:
{
  "customerName": "nome do cliente (se mencionado)",
  "companyRepresentative": "nome do representante da empresa (se identificado)",
  "orderDate": "data do pedido em formato ISO (se mencionada)",
  "orderItems": [
    {
      "productName": "nome do produto",
      "quantity": número_quantidade,
      "price": "preço como string (ex: '9,90')",
      "size": "tamanho (se aplicável)"
    }
  ],
  "totalAmount": "valor total como string",
  "customerPhone": "telefone do cliente",
  "deliveryAddress": "endereço de entrega (se mencionado)",
  "paymentMethod": "método de pagamento (se mencionado)",
  "orderStatus": "status do pedido (se mencionado)",
  "notes": "observações importantes da conversa"
}

Responda APENAS com o JSON, sem texto adicional:`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "Você é um especialista em análise de conversas comerciais. Extraia apenas informações que estão claramente presentes no texto. Retorne apenas JSON válido."
          },
          {
            role: "user",
            content: analysisPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 1500
      });

      const responseText = completion.choices[0]?.message?.content?.trim();
      if (!responseText) {
        throw new Error("Resposta vazia da API OpenAI");
      }

      // Parse JSON response
      try {
        const extractedData: ExtractedCommercialData = JSON.parse(responseText);
        
        // Ensure customerPhone is set from customerInfo if not extracted
        if (!extractedData.customerPhone && customerInfo.phone) {
          extractedData.customerPhone = customerInfo.phone;
        }

        // Ensure customerName is set if not extracted
        if (!extractedData.customerName && customerInfo.name) {
          extractedData.customerName = customerInfo.name;
        }

        return extractedData;
      } catch (parseError) {
        console.error("Error parsing JSON response:", parseError);
        console.error("Raw response:", responseText);
        throw new Error("Erro ao processar resposta da análise");
      }

    } catch (error) {
      console.error("Error analyzing conversation:", error);
      throw new Error("Erro ao analisar conversa com OpenAI");
    }
  }

  private formatConversationForAnalysis(
    messages: MessageWithSender[],
    customerInfo: { name: string; phone: string }
  ): string {
    const formattedMessages = messages.map(message => {
      const sender = message.senderType === 'customer' 
        ? `${customerInfo.name} (Cliente)` 
        : message.senderType === 'agent' && message.sender
        ? `${message.sender.name || 'Agente'} (Representante)`
        : message.senderType === 'system'
        ? 'Sistema'
        : 'Desconhecido';
      
      const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString('pt-BR') : 'Data não informada';
      return `[${timestamp}] ${sender}: ${message.content}`;
    });

    return `Informações do Cliente:
Nome: ${customerInfo.name}
Telefone: ${customerInfo.phone}

Mensagens da Conversa:
${formattedMessages.join('\n')}`;
  }

  async generateKnowledgeFile(analysisData: WhatsappConversationAnalysis[]): Promise<{ fileName: string; filePath: string; fileSize: number }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `knowledge-base-${timestamp}.txt`;
      const filePath = path.join(this.knowledgeBaseDir, fileName);

      // Generate knowledge content
      const knowledgeContent = this.formatKnowledgeContent(analysisData);

      // Write file
      await fs.writeFile(filePath, knowledgeContent, 'utf8');
      
      // Get file size
      const stats = await fs.stat(filePath);
      
      return {
        fileName,
        filePath,
        fileSize: stats.size
      };
    } catch (error) {
      console.error("Error generating knowledge file:", error);
      throw new Error("Erro ao gerar arquivo de conhecimento");
    }
  }

  private formatKnowledgeContent(analysisData: WhatsappConversationAnalysis[]): string {
    const header = `# Base de Conhecimento de Conversas WhatsApp
# Gerado em: ${new Date().toLocaleString('pt-BR')}
# Total de conversas analisadas: ${analysisData.length}

Este arquivo contém informações extraídas de conversas do WhatsApp para uso pelo assistente ChatGPT.
Use essas informações para personalizar respostas e manter continuidade nas conversas com clientes.

---

`;

    const conversationsContent = analysisData.map((analysis, index) => {
      const data = analysis.extractedData as ExtractedCommercialData;
      
      return `## CONVERSA ${index + 1}
### Dados do Cliente:
- Nome: ${analysis.customerName || data.customerName || 'Não informado'}
- Telefone: ${data.customerPhone || 'Não informado'}

### Dados Comerciais:
- Representante da Empresa: ${analysis.companyRepresentative || data.companyRepresentative || 'Não informado'}
- Data do Pedido: ${analysis.orderDate ? new Date(analysis.orderDate.toString()).toLocaleDateString('pt-BR') : data.orderDate || 'Não informada'}
- Valor Total: ${analysis.totalAmount || data.totalAmount || 'Não informado'}

### Itens do Pedido:
${data.orderItems && data.orderItems.length > 0 
  ? data.orderItems.map(item => `- ${item.productName} (Qtd: ${item.quantity}${item.size ? `, ${item.size}` : ''}${item.price ? `, R$ ${item.price}` : ''})`).join('\n')
  : '- Nenhum item específico registrado'}

### Informações Adicionais:
${data.deliveryAddress ? `- Endereço: ${data.deliveryAddress}` : ''}
${data.paymentMethod ? `- Forma de Pagamento: ${data.paymentMethod}` : ''}
${data.orderStatus ? `- Status do Pedido: ${data.orderStatus}` : ''}
${data.notes ? `- Observações: ${data.notes}` : ''}

### Contexto da Conversa:
Data da Análise: ${analysis.analysisDate ? new Date(analysis.analysisDate.toString()).toLocaleString('pt-BR') : 'Não informada'}
ID da Conversa: ${analysis.conversationId}

---

`;
    }).join('');

    const footer = `
# INSTRUÇÕES PARA O ASSISTENTE CHATGPT:

1. Use essas informações para reconhecer clientes em futuras conversas
2. Mantenha o histórico de pedidos e preferências dos clientes
3. Seja proativo ao sugerir produtos baseados no histórico
4. Sempre confirme informações importantes antes de processar novos pedidos
5. Mantenha um tom personalizado e amigável baseado no histórico de interações

# FIM DA BASE DE CONHECIMENTO
`;

    return header + conversationsContent + footer;
  }

  async updateKnowledgeFileWithNewAnalysis(
    existingFilePath: string,
    newAnalysis: WhatsappConversationAnalysis
  ): Promise<void> {
    try {
      // Read existing file
      const existingContent = await fs.readFile(existingFilePath, 'utf8');
      
      // Extract existing data and add new analysis
      const newData = newAnalysis.extractedData as ExtractedCommercialData;
      
      const newConversationContent = `
## NOVA CONVERSA (Adicionada em ${new Date().toLocaleString('pt-BR')})
### Dados do Cliente:
- Nome: ${newAnalysis.customerName || newData.customerName || 'Não informado'}
- Telefone: ${newData.customerPhone || 'Não informado'}

### Dados Comerciais:
- Representante da Empresa: ${newAnalysis.companyRepresentative || newData.companyRepresentative || 'Não informado'}
- Data do Pedido: ${newAnalysis.orderDate ? new Date(newAnalysis.orderDate.toString()).toLocaleDateString('pt-BR') : newData.orderDate || 'Não informada'}
- Valor Total: ${newAnalysis.totalAmount || newData.totalAmount || 'Não informado'}

### Itens do Pedido:
${newData.orderItems && newData.orderItems.length > 0 
  ? newData.orderItems.map(item => `- ${item.productName} (Qtd: ${item.quantity}${item.size ? `, ${item.size}` : ''}${item.price ? `, R$ ${item.price}` : ''})`).join('\n')
  : '- Nenhum item específico registrado'}

### Informações Adicionais:
${newData.deliveryAddress ? `- Endereço: ${newData.deliveryAddress}` : ''}
${newData.paymentMethod ? `- Forma de Pagamento: ${newData.paymentMethod}` : ''}
${newData.orderStatus ? `- Status do Pedido: ${newData.orderStatus}` : ''}
${newData.notes ? `- Observações: ${newData.notes}` : ''}

### Contexto da Conversa:
Data da Análise: ${newAnalysis.analysisDate ? new Date(newAnalysis.analysisDate.toString()).toLocaleString('pt-BR') : 'Não informada'}
ID da Conversa: ${newAnalysis.conversationId}

---
`;

      // Insert new content before the footer
      const footerIndex = existingContent.indexOf('# INSTRUÇÕES PARA O ASSISTENTE CHATGPT:');
      if (footerIndex !== -1) {
        const updatedContent = existingContent.slice(0, footerIndex) + newConversationContent + existingContent.slice(footerIndex);
        await fs.writeFile(existingFilePath, updatedContent, 'utf8');
      } else {
        // If footer not found, append to end
        await fs.appendFile(existingFilePath, newConversationContent);
      }
    } catch (error) {
      console.error("Error updating knowledge file:", error);
      throw new Error("Erro ao atualizar arquivo de conhecimento");
    }
  }

  async getLatestKnowledgeFile(): Promise<string | null> {
    try {
      const files = await fs.readdir(this.knowledgeBaseDir);
      const knowledgeFiles = files.filter(file => file.startsWith('knowledge-base-') && file.endsWith('.txt'));
      
      if (knowledgeFiles.length === 0) {
        return null;
      }

      // Sort by creation time (newest first)
      knowledgeFiles.sort((a, b) => b.localeCompare(a));
      
      return path.join(this.knowledgeBaseDir, knowledgeFiles[0]);
    } catch (error) {
      console.error("Error getting latest knowledge file:", error);
      return null;
    }
  }

  async readKnowledgeFileContent(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      console.error("Error reading knowledge file:", error);
      throw new Error("Erro ao ler arquivo de conhecimento");
    }
  }
}

// Export singleton instance
export const whatsappAnalysisService = new WhatsAppAnalysisService();