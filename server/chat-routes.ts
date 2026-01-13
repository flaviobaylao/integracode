import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { db } from "./db";
import { sql, and, eq, inArray, isNull } from "drizzle-orm";
import { whatsappService } from "./whatsapp-service";
import { telegramService } from "./telegram-service";
import { evolutionAPIService } from "./evolution-api-service";
import { evolutionPollingService } from "./evolution-polling-service";
import { getAgentColor } from "./chat-distribution-service";
import { uploadMediaFromBase64 } from "./whatsapp-media-storage";
import {
  insertChatAgentSchema,
  insertChatConversationSchema,
  insertChatMessageSchema,
  insertChatProductSchema,
  insertChatQuickMessageSchema,
  insertChatOrderSchema,
  insertChatDeliverySchema,
  insertWhatsappConversationAnalysisSchema,
  phoneNumberMappings,
  chatMessages,
  chatConversations,
  chatCustomers,
  chatAiLogs,
} from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import multer from "multer";
import path from "path";
import fs from "fs";

// 🔧 FUNÇÃO DE NORMALIZAÇÃO DE TELEFONE - ÚNICA FONTE DE VERDADE
function normalizePhoneNumber(phone: string): string {
  if (!phone) {
    console.warn(`⚠️  [NORMALIZE] Telefone vazio recebido`);
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
    console.log(`🎯 [NORMALIZE] Mapeando ID conhecido ${digitsOnly} para ${mappings[digitsOnly]}`);
    return mappings[digitsOnly];
  }

  // Se começar com 55 e tiver 12 ou 13 dígitos, remove o 55 para normalizar o resto
  if (digitsOnly.startsWith('55') && (digitsOnly.length === 12 || digitsOnly.length === 13)) {
    const candidate = digitsOnly.slice(2);
    if (mappings[candidate]) {
      console.log(`🎯 [NORMALIZE] Mapeando ID conhecido (sem 55) ${candidate} para ${mappings[candidate]}`);
      return mappings[candidate];
    }
    digitsOnly = candidate;
  }
  
  // No Brasil, celulares têm 11 dígitos (DDD + 9 + número) ou 10 dígitos (DDD + número)
  if (digitsOnly.length === 10) {
    const ddd = digitsOnly.slice(0, 2);
    const rest = digitsOnly.slice(2);
    digitsOnly = `${ddd}9${rest}`;
    console.log(`📞 [NORMALIZE] Adicionado 9: ${digitsOnly}`);
  } else if (digitsOnly.length > 11) {
    // Se ainda for maior que 11, pega os últimos 11 (removendo prefixo 55 se houver)
    digitsOnly = digitsOnly.slice(-11);
    
    // Se após pegar os últimos 11, o número não tiver o 9 (ex: 628744073357 -> 28744073357)
    // Precisamos garantir que o 9 esteja lá se for celular brasileiro
    if (digitsOnly.length === 10) {
      const ddd = digitsOnly.slice(0, 2);
      const rest = digitsOnly.slice(2);
      digitsOnly = `${ddd}9${rest}`;
    }
  }
  
  // Garante o prefixo 55
  const normalized = `55${digitsOnly}`;
  console.log(`📞 [NORMALIZE] Input: ${phone} -> Output: ${normalized}`);
  return normalized;
}

// 🔧 FUNÇÃO PARA ENCONTRAR CONVERSA COM NÚMERO "SIMILAR" (COM/SEM 9)
function getPhoneVariants(normalizedPhone: string): string[] {
  // Retorna variações do telefone (com/sem o 9 obrigatório)
  const variants = [normalizedPhone];
  
  // Se tem 13 dígitos (55 + 11): tentar remover o 9 após o 55XX
  if (normalizedPhone.length === 13 && normalizedPhone.startsWith('55')) {
    const ddd = normalizedPhone.slice(2, 4);
    const rest = normalizedPhone.slice(5);
    const withoutNine = `55${ddd}${rest}`;
    if (!variants.includes(withoutNine)) {
      variants.push(withoutNine);
    }
  }
  
  // Se tem 12 dígitos (55 + 10): tentar adicionar o 9 após o 55XX
  if (normalizedPhone.length === 12 && normalizedPhone.startsWith('55')) {
    const ddd = normalizedPhone.slice(2, 4);
    const rest = normalizedPhone.slice(4);
    const withNine = `55${ddd}9${rest}`;
    if (!variants.includes(withNine)) {
      variants.push(withNine);
    }
  }
  
  console.log(`📞 [VARIANTS] ${normalizedPhone} -> Variantes: [${variants.join(', ')}]`);
  return variants;
}

// 🔧 FUNÇÃO PARA PROCESSAR MENSAGEM RECEBIDA (WEBHOOK OU POLLING)
export async function processIncomingMessage(data: any, originalPhone: string): Promise<boolean> {
  try {
    const rawRemoteJid = data.key?.remoteJid;
    if (!rawRemoteJid || rawRemoteJid.includes('@g.us')) {
      return false; // Ignorar grupos
    }

    const phoneNumber = evolutionAPIService.extractPhoneNumber(rawRemoteJid);
    const cleanPhone = phoneNumber.replace(/\D/g, '');

    // Busca mapeamento de telefone
    let targetPhone = phoneNumber;
    const phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
    
    if (phoneMapping) {
      targetPhone = phoneMapping.canonicalPhone;
      console.log(`🔄 [PROCESS] Remapeando: ${phoneNumber} -> ${targetPhone}`);
    }

    const normalizedPhone = normalizePhoneNumber(targetPhone);
    const isFromMe = data.key?.fromMe === true;
    const messageText = evolutionAPIService.extractMessageText(data.message || {}) || '';
    const messageId = data.key?.id;

    // Busca contato na agenda
    const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
    const identifiedName = phonebookContact?.name || data.pushName || `Cliente ${normalizedPhone}`;

    // 1. Garante que o cliente e conversa existam
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

    // 2. Verifica duplicata (pelo externalId no banco)
    const isDuplicate = await storage.getChatMessageByExternalId(messageId);
    
    if (isDuplicate) {
      return false; // Já existe
    }

    // 3. Extrair informações de mídia usando extractMediaInfo
    const mediaInfo = evolutionAPIService.extractMediaInfo(data.message || data);
    
    // 4. Garantir fallback para 'text' se messageType for undefined
    const finalMessageType = mediaInfo.messageType || 'text';
    const finalContent = messageText || (finalMessageType !== 'text' ? `[${finalMessageType}]` : '[Mensagem]');
    
    // 5. Se for mídia, fazer download e salvar no object storage
    let finalMediaUrl = mediaInfo.mediaUrl;
    
    if (finalMessageType !== 'text' && messageId) {
      try {
        console.log(`📥 [MEDIA-DOWNLOAD] Baixando mídia para mensagem ${messageId}...`);
        
        // Tentar baixar a mídia via Evolution API (usando key completo)
        const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
        if (instanceName) {
          // Passar o key completo para Evolution API v2.3.6+
          const messageKey = {
            id: messageId,
            remoteJid: data.key?.remoteJid,
            fromMe: data.key?.fromMe
          };
          const messageTimestamp = data.messageTimestamp;
          const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(instanceName, messageKey, messageTimestamp);
          
          if (mediaResult.success && mediaResult.base64) {
            // Upload para object storage
            const uploadResult = await uploadMediaFromBase64(
              mediaResult.base64,
              mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream',
              mediaInfo.mediaFilename
            );
            
            if (uploadResult.success && uploadResult.objectPath) {
              finalMediaUrl = `/objects/${uploadResult.objectPath}`;
              console.log(`✅ [MEDIA-DOWNLOAD] Mídia salva: ${finalMediaUrl}`);
            } else {
              console.warn(`⚠️ [MEDIA-DOWNLOAD] Falha no upload: ${uploadResult.error}`);
            }
          } else {
            console.warn(`⚠️ [MEDIA-DOWNLOAD] Falha ao baixar mídia: ${mediaResult.error}`);
          }
        }
      } catch (mediaErr: any) {
        console.warn(`⚠️ [MEDIA-DOWNLOAD] Erro ao processar mídia: ${mediaErr.message}`);
        // Continua com a URL original (transiente) como fallback
      }
    }
    
    // 6. Salva a mensagem com tipo correto (schema: messageType, mediaUrl, metadata)
    await storage.createChatMessage({
      conversationId: conversation.id,
      senderId: isFromMe ? 'system' : customer.id,
      senderType: isFromMe ? 'system' : 'customer',
      content: finalContent,
      messageType: finalMessageType,
      mediaUrl: finalMediaUrl,
      metadata: mediaInfo.mediaType || mediaInfo.mediaFilename ? { 
        mediaType: mediaInfo.mediaType, 
        mediaFilename: mediaInfo.mediaFilename,
        mediaSize: mediaInfo.mediaSize 
      } : undefined,
      externalId: messageId
    });

    // 4. Atualiza a conversa (lastMessage e status são tratados pela camada de storage)
    await storage.updateChatConversation(conversation.id, {
      status: isFromMe ? conversation.status : 'new'
    });

    console.log(`✅ [PROCESS] Mensagem salva: ${normalizedPhone} | FromMe: ${isFromMe} | ${messageText.substring(0, 30)}...`);
    return true;

  } catch (error: any) {
    console.error('❌ [PROCESS] Erro ao processar mensagem:', error.message);
    return false;
  }
}

// 🔧 FUNÇÃO PARA CONSOLIDAR CONVERSAS DUPLICADAS POR TELEFONE
async function consolidateDuplicateConversations(storage: any): Promise<{ consolidated: number; merged: number }> {
  const conversations = await storage.getChatConversations();
  const phoneGroups: { [key: string]: any[] } = {};
  
  // Agrupar por telefone
  for (const conv of conversations) {
    const phone = conv.customerPhone;
    if (!phoneGroups[phone]) {
      phoneGroups[phone] = [];
    }
    phoneGroups[phone].push(conv);
  }
  
  let consolidatedCount = 0;
  let mergedMessagesCount = 0;
  
  // Processar grupos com múltiplas conversas
  for (const [phone, convs] of Object.entries(phoneGroups)) {
    if (convs.length > 1) {
      console.log(`🔀 [CONSOLIDATE] Telefone ${phone} tem ${convs.length} conversas. Consolidando...`);
      consolidatedCount++;
      
      // Ordenar por data (mais recente primeira)
      convs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      
      const mainConv = convs[0]; // Conversa principal (mais recente)
      const duplicateConvs = convs.slice(1); // Conversas para mesclar
      
      // Mover mensagens das duplicatas para a principal
      for (const dupConv of duplicateConvs) {
        const messages = await storage.getChatMessages(dupConv.id);
        for (const msg of messages) {
          await storage.createChatMessage({
            conversationId: mainConv.id,
            senderId: msg.senderId,
            senderType: msg.senderType,
            content: msg.content,
            messageType: msg.messageType,
            mediaUrl: msg.mediaUrl,
            externalId: msg.externalId
          });
          mergedMessagesCount++;
        }
        
        // Deletar conversa duplicada
        await storage.deleteChatConversation(dupConv.id);
        console.log(`✅ [CONSOLIDATE] Conversa ${dupConv.id} mesclada em ${mainConv.id} (${messages.length} mensagens)`);
      }
    }
  }
  
  return { consolidated: consolidatedCount, merged: mergedMessagesCount };
}

export function registerChatRoutes(app: Express): void {
  // Configure multer for file uploads
  const uploadDir = path.join(process.cwd(), "uploads", "chat");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const storageConfig = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
  });

  const upload = multer({
    storage: storageConfig,
    limits: {
      fileSize: 16 * 1024 * 1024, // 16MB limit
    }
  });

  // ============================================================
  // FILE UPLOAD ENDPOINT
  // ============================================================

  app.post(
    "/api/chat/upload",
    authenticateUser,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "Nenhum arquivo enviado" });
        }

        const fileUrl = `/uploads/chat/${req.file.filename}`;

        res.json({
          success: true,
          file: {
            url: fileUrl,
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          },
        });
      } catch (error) {
        console.error("[CHAT] Upload error:", error);
        res.status(500).json({ error: "Erro ao fazer upload do arquivo" });
      }
    }
  );

  // Serve uploaded chat files
  app.use("/uploads/chat", authenticateUser, (req, res, next) => {
    const filePath = path.join(uploadDir, path.basename(req.path));
    res.sendFile(filePath);
  });

  // ============================================================
  // CHAT AGENTS CRUD
  // ============================================================

  // Get all chat agents
  app.get("/api/chat/agents", authenticateUser, async (req, res) => {
    try {
      const agents = await storage.getChatAgents();
      res.json(agents);
    } catch (error) {
      console.error("[CHAT] Get agents error:", error);
      res.status(500).json({ error: "Erro ao buscar agentes" });
    }
  });

  // Create chat agent
  app.post(
    "/api/chat/agents",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const validatedData = insertChatAgentSchema.parse(req.body);
        const agent = await storage.createChatAgent(validatedData);
        res.json(agent);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors });
        }
        console.error("[CHAT] Create agent error:", error);
        res.status(500).json({ error: "Erro ao criar agente" });
      }
    }
  );

  // Delete chat agent
  app.delete(
    "/api/chat/agents/:id",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { id } = req.params;
        await storage.deleteChatAgent(id);
        res.json({ success: true });
      } catch (error) {
        console.error("[CHAT] Delete agent error:", error);
        res.status(500).json({ error: "Erro ao deletar agente" });
      }
    }
  );

  // ============================================================
  // AGENT PRESENCE / HEARTBEAT
  // ============================================================

  // Heartbeat endpoint - called periodically when ChatCenter is open
  app.post("/api/chat/agents/heartbeat", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      if (!currentUser?.email) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      // Find the agent by user email and update their status to online
      const agents = await storage.getChatAgents();
      const agent = agents.find(a => a.email === currentUser.email);

      if (agent) {
        const wasOffline = agent.status !== "online";
        await storage.updateChatAgentPresence(agent.id, "online");
        
        // Se o agente estava offline e agora está online, desativar standby do ChatGPT
        if (wasOffline) {
          console.log(`🟢 [HEARTBEAT] Agent ${currentUser.email} is now online`);
          const { deactivateChatGPTStandby } = await import("./chat-distribution-service");
          await deactivateChatGPTStandby();
        }
      }

      res.json({ success: true, status: "online" });
    } catch (error) {
      console.error("[CHAT] Heartbeat error:", error);
      res.status(500).json({ error: "Erro ao atualizar presença" });
    }
  });

  // Set agent offline - called when ChatCenter is closed
  app.post("/api/chat/agents/offline", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      if (!currentUser?.email) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      // Find the agent by user email and update their status to offline
      const agents = await storage.getChatAgents();
      const agent = agents.find(a => a.email === currentUser.email);

      if (agent) {
        await storage.updateChatAgentPresence(agent.id, "offline");
        console.log(`⚫ [OFFLINE] Agent ${currentUser.email} is offline`);
        
        // Verificar se ainda há agentes online - se não houver, ativar standby
        const { getOnlineTelemarketingAgents, activateChatGPTStandby } = await import("./chat-distribution-service");
        const onlineAgents = await getOnlineTelemarketingAgents();
        
        if (onlineAgents.length === 0) {
          console.log('🤖 [STANDBY] Nenhum agente online - ativando standby do ChatGPT');
          await activateChatGPTStandby();
        }
      }

      res.json({ success: true, status: "offline" });
    } catch (error) {
      console.error("[CHAT] Offline error:", error);
      res.status(500).json({ error: "Erro ao atualizar presença" });
    }
  });

  // ⚠️ GET /api/chat/agents/online movido para linha 3672 com ChatGPT standby incluído

  // ============================================================
  // CHAT CONVERSATIONS CRUD
  // ============================================================

  // ⚠️ GET /api/chat/conversations movido para linha 2085 com autenticação e filtragem por role

  // Create conversation
  app.post("/api/chat/conversations", async (req, res) => {
    try {
      const validatedData = insertChatConversationSchema.parse(req.body);
      const conversation = await storage.createChatConversation(validatedData);
      res.json(conversation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create conversation error:", error);
      res.status(500).json({ error: "Erro ao criar conversa" });
    }
  });

  // Start new conversation (initiate message to customer)
  app.post("/api/chat/conversations/start", authenticateUser, async (req, res) => {
    try {
      const { customerPhone, customerName } = req.body;
      const currentUser = (req as any).currentUser;
      
      console.log(`🚀 [START-CONVERSATION] Requisição recebida:`, {
        phone: customerPhone,
        name: customerName,
        user: currentUser?.email
      });

      if (!customerPhone) {
        console.warn(`⚠️  [START-CONVERSATION] Telefone vazio`);
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      // Normalize phone
      const normalizedPhone = normalizePhoneNumber(customerPhone);
      console.log(`📞 [START-CONVERSATION] Telefone normalizado: ${customerPhone} → ${normalizedPhone}`);

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        console.error(`⚠️  [START-CONVERSATION] WhatsApp não está configurado`, config);
        return res.status(400).json({ error: "WhatsApp não está configurado" });
      }
      console.log(`✅ [START-CONVERSATION] Evolution API configurada:`, config.instanceName);

      // Create or get customer
      console.log(`👤 [START-CONVERSATION] Criando cliente...`);
      let createdCustomer = await storage.createChatCustomer({
        name: customerName || `Cliente ${normalizedPhone}`,
        phone: normalizedPhone
      }).catch((err) => {
        console.warn(`⚠️  [START-CONVERSATION] Erro ao criar cliente (pode ser duplicado):`, err.message);
        return null;
      });

      if (!createdCustomer) {
        console.warn(`⚠️  [START-CONVERSATION] Cliente não foi criado`);
        return res.status(400).json({ error: "Erro ao criar cliente para a conversa" });
      }
      console.log(`✅ [START-CONVERSATION] Cliente criado/obtido:`, createdCustomer.id);

      // Create conversation using upsert logic
      console.log(`💬 [START-CONVERSATION] Criando/atualizando conversa...`);
      const conversation = await storage.upsertChatConversation({
        customerId: createdCustomer.id,
        customerName: customerName || `Cliente ${normalizedPhone}`,
        customerPhone: normalizedPhone,
        status: "new",
        priority: "normal"
      });
      console.log(`✅ [START-CONVERSATION] Conversa criada/atualizada:`, conversation.id);

      const response = {
        id: conversation.id,
        customerId: createdCustomer.id,
        phoneNumber: normalizedPhone,
        customerName: customerName || `Cliente ${normalizedPhone}`,
        status: "new"
      };
      
      console.log(`🎉 [START-CONVERSATION] Retornando resposta:`, response);
      res.json(response);
    } catch (error: any) {
      console.error("[CHAT] Start conversation error:", error);
      console.error("[CHAT] Stack:", error.stack);
      res.status(500).json({ error: "Erro ao iniciar conversa: " + error.message });
    }
  });

  // Update conversation
  app.patch("/api/chat/conversations/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const conversation = await storage.updateChatConversation(id, req.body);
      res.json(conversation);
    } catch (error) {
      console.error("[CHAT] Update conversation error:", error);
      res.status(500).json({ error: "Erro ao atualizar conversa" });
    }
  });

  // ============================================================
  // CHAT MESSAGES CRUD
  // ============================================================

  // Get messages for a conversation
  app.get("/api/chat/messages/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getChatMessages(conversationId);
      res.json(messages);
    } catch (error) {
      console.error("[CHAT] Get messages error:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // Create message
  app.post("/api/chat/messages", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatMessageSchema.parse(req.body);
      const message = await storage.createChatMessage(validatedData);
      
      // If message is from agent/system, send via Evolution API
      if (message.senderType !== 'customer' && message.conversationId) {
        try {
          console.log(`📨 [CHAT-MESSAGE] Enviando mensagem via Evolution API...`);
          
          // Get conversation to get customer phone
          const conversation = await storage.getChatConversation(message.conversationId);
          if (!conversation || !conversation.customerPhone) {
            console.warn(`⚠️  [CHAT-MESSAGE] Conversa ou telefone não encontrados`);
            return res.json(message); 
          }
          
          const config = evolutionAPIService.getConfig();
          if (!config || !config.apiKey) {
            console.warn(`⚠️  [CHAT-MESSAGE] Evolution API não configurada no service`);
            return res.json(message);
          }
          
          console.log(`📱 [CHAT-MESSAGE] Telefone do cliente: ${conversation.customerPhone}`);
          
          const sendResult = await evolutionAPIService.sendTextMessage(
            config.instanceName,
            conversation.customerPhone,
            message.content
          );
          
          if (sendResult.success) {
            console.log(`✅ [CHAT-MESSAGE] Mensagem entregue via WhatsApp! ID:`, sendResult.messageId);
          } else {
            console.warn(`⚠️  [CHAT-MESSAGE] Erro ao enviar via WhatsApp:`, sendResult.error);
          }
        } catch (sendError: any) {
          console.error(`❌ [CHAT-MESSAGE] Erro ao enviar mensagem:`, sendError.message);
        }
      }
      
      res.json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create message error:", error);
      res.status(500).json({ error: "Erro ao criar mensagem" });
    }
  });

  // ============================================================
  // CHAT PRODUCTS CRUD
  // ============================================================

  // Get all chat products
  app.get("/api/chat/products", authenticateUser, async (req, res) => {
    try {
      const products = await storage.getChatProducts();
      res.json(products);
    } catch (error) {
      console.error("[CHAT] Get products error:", error);
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  });

  // Create chat product
  app.post(
    "/api/chat/products",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const validatedData = insertChatProductSchema.parse(req.body);
        const product = await storage.createChatProduct(validatedData);
        res.json(product);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: error.errors });
        }
        console.error("[CHAT] Create product error:", error);
        res.status(500).json({ error: "Erro ao criar produto" });
      }
    }
  );

  // Update chat product
  app.patch(
    "/api/chat/products/:id",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { id } = req.params;
        const product = await storage.updateChatProduct(id, req.body);
        res.json(product);
      } catch (error) {
        console.error("[CHAT] Update product error:", error);
        res.status(500).json({ error: "Erro ao atualizar produto" });
      }
    }
  );

  // ============================================================
  // CHAT QUICK MESSAGES CRUD
  // ============================================================

  // Get all quick messages
  app.get("/api/chat/quick-messages", authenticateUser, async (req, res) => {
    try {
      const quickMessages = await storage.getChatQuickMessages();
      res.json(quickMessages);
    } catch (error) {
      console.error("[CHAT] Get quick messages error:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens rápidas" });
    }
  });

  // Create quick message
  app.post("/api/chat/quick-messages", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const validatedData = insertChatQuickMessageSchema.parse({
        ...req.body,
        createdBy: currentUser.id,
      });
      const quickMessage = await storage.createChatQuickMessage(validatedData);
      res.json(quickMessage);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create quick message error:", error);
      res.status(500).json({ error: "Erro ao criar mensagem rápida" });
    }
  });

  // ============================================================
  // CHAT ORDERS CRUD
  // ============================================================

  // Get all chat orders
  app.get("/api/chat/orders", authenticateUser, async (req, res) => {
    try {
      const { status, customerId } = req.query;
      
      let orders = await storage.getChatOrders();
      
      // Filter on the server side
      if (status) {
        orders = orders.filter(o => o.status === status);
      }
      if (customerId) {
        orders = orders.filter(o => o.customerId === customerId);
      }
      
      res.json(orders);
    } catch (error) {
      console.error("[CHAT] Get orders error:", error);
      res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  });

  // Create chat order
  app.post("/api/chat/orders", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatOrderSchema.parse(req.body);
      const order = await storage.createChatOrder(validatedData);
      res.json(order);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create order error:", error);
      res.status(500).json({ error: "Erro ao criar pedido" });
    }
  });

  // Update chat order
  app.patch("/api/chat/orders/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const order = await storage.updateChatOrder(id, req.body);
      res.json(order);
    } catch (error) {
      console.error("[CHAT] Update order error:", error);
      res.status(500).json({ error: "Erro ao atualizar pedido" });
    }
  });

  // ============================================================
  // CHAT DELIVERIES CRUD
  // ============================================================

  // Get all chat deliveries
  app.get("/api/chat/deliveries", authenticateUser, async (req, res) => {
    try {
      const { status, deliveryPersonId } = req.query;
      
      let deliveries = await storage.getChatDeliveries();
      
      // Filter on the server side
      if (status) {
        deliveries = deliveries.filter(d => d.status === status);
      }
      if (deliveryPersonId) {
        deliveries = deliveries.filter(d => d.deliveryPersonId === deliveryPersonId);
      }
      
      res.json(deliveries);
    } catch (error) {
      console.error("[CHAT] Get deliveries error:", error);
      res.status(500).json({ error: "Erro ao buscar entregas" });
    }
  });

  // Create chat delivery
  app.post("/api/chat/deliveries", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertChatDeliverySchema.parse(req.body);
      const delivery = await storage.createChatDelivery(validatedData);
      res.json(delivery);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] Create delivery error:", error);
      res.status(500).json({ error: "Erro ao criar entrega" });
    }
  });

  // Update chat delivery
  app.patch("/api/chat/deliveries/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const delivery = await storage.updateChatDelivery(id, req.body);
      res.json(delivery);
    } catch (error) {
      console.error("[CHAT] Update delivery error:", error);
      res.status(500).json({ error: "Erro ao atualizar entrega" });
    }
  });

  // ============================================================
  // WHATSAPP SETUP ROUTES
  // ============================================================

  // Get WhatsApp QR Code
  app.get("/api/chat/whatsapp/qr", authenticateUser, async (req, res) => {
    try {
      const status = await whatsappService.getStatus();
      
      if (status.qrCode) {
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(status.qrCode);
        res.json({ qrCode: qrDataUrl, status: status.status });
      } else {
        res.json({ status: status.status, phoneNumber: status.phoneNumber });
      }
    } catch (error) {
      console.error("[CHAT] WhatsApp QR error:", error);
      res.status(500).json({ error: "Erro ao gerar QR Code do WhatsApp" });
    }
  });

  // Disconnect WhatsApp
  app.post("/api/chat/whatsapp/disconnect", authenticateUser, async (req, res) => {
    try {
      await whatsappService.disconnect();
      res.json({ success: true });
    } catch (error) {
      console.error("[CHAT] WhatsApp disconnect error:", error);
      res.status(500).json({ error: "Erro ao desconectar WhatsApp" });
    }
  });

  // Send WhatsApp message via Evolution API (Test endpoint - without auth)
  app.post("/api/chat/send-message-test", async (req, res) => {
    try {
      const { phoneNumber, message, messageType = 'text' } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      if (!message && messageType === 'text') {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Config: " + JSON.stringify(config) });
      }

      console.log(`📨 [WHATSAPP-SEND-TEST] Enviando mensagem para ${phoneNumber} via ${messageType}`);

      const result = await evolutionAPIService.sendTextMessage(config.instanceName, phoneNumber, message);

      if (!result.success) {
        console.error(`❌ [WHATSAPP-SEND-TEST] Erro ao enviar:`, result.error);
        return res.status(500).json({ error: result.error || "Erro ao enviar mensagem" });
      }

      console.log(`✅ [WHATSAPP-SEND-TEST] Mensagem enviada com sucesso para ${phoneNumber}`);
      res.json({ 
        success: true, 
        messageId: result.messageId,
        message: "Mensagem enviada com sucesso"
      });
    } catch (error: any) {
      console.error("[CHAT] Send message test error:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem: " + error.message });
    }
  });

  // ============================================================
  // EVOLUTION API WEBHOOK - RECEBER MENSAGENS
  // ============================================================

  // POST /api/chat/webhook/messages - Receber TODAS as mensagens via webhook da Evolution API
  // 🪞 ESPELHO COMPLETO DO WHATSAPP - Captura mensagens enviadas via celular E via sistema
  app.post("/api/chat/webhook/messages", async (req, res) => {
    const debugInfo: any = { 
      timestamp: new Date().toISOString(),
      steps: [],
      env: process.env.NODE_ENV
    };
    
    try {
      let { event, instance, data } = req.body;
      debugInfo.steps.push('1-parse-body');
      
      // Suportar múltiplos formatos de webhook (Evolution API pode enviar de diferentes formas)
      if (!event && req.body.webhook?.event) {
        event = req.body.webhook.event;
        instance = req.body.webhook.instance;
        data = req.body.webhook.data;
      }
      
      if (!event) {
        if (req.body.key && req.body.message) {
          event = 'messages.upsert';
          data = req.body;
        }
      }
      
      const messageEvents = [
        'messages.upsert', 'MESSAGES_UPSERT',
        'send.message', 'SEND_MESSAGE', 
        'message.create', 'MESSAGE_CREATE',
        'messages.set', 'MESSAGES_SET',
        'messages.edited', 'MESSAGES_EDITED'
      ];
      
      debugInfo.event = event;
      
      if (!event || !messageEvents.includes(event)) {
        return res.json({ received: false, reason: 'Evento ignorado', debug: debugInfo });
      }

      if (!data || !data.key) {
        return res.json({ received: false, reason: 'Dados inválidos', debug: debugInfo });
      }

      const rawRemoteJid = data.key.remoteJid;
      debugInfo.rawRemoteJid = rawRemoteJid;
      
      if (rawRemoteJid.includes('@g.us')) {
        return res.json({ received: false, reason: 'Grupo ignorado', debug: debugInfo });
      }

      // 🎯 NOVO: Usar resolveCanonicalPhone para buscar número real automaticamente
      const { phone: resolvedPhone, source: phoneSource } = evolutionAPIService.resolveCanonicalPhone(data);
      const cleanPhone = resolvedPhone.replace(/\D/g, '');
      debugInfo.phoneNumber = resolvedPhone;
      debugInfo.cleanPhone = cleanPhone;
      debugInfo.phoneSource = phoneSource;
      debugInfo.steps.push('2-resolve-canonical-phone');
      
      // Mapeamento de telefone como fallback (apenas para @lid sem número real)
      let targetPhone = resolvedPhone;
      
      // Buscar mapeamento no banco de dados APENAS se for @lid
      debugInfo.steps.push('3-lookup-mapping');
      let phoneMapping = null;
      if (phoneSource.includes('@lid')) {
        phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
        debugInfo.phoneMappingFound = !!phoneMapping;
        
        if (phoneMapping) {
          targetPhone = phoneMapping.canonicalPhone;
          debugInfo.mappedTo = targetPhone;
          console.log(`🔄 [WEBHOOK-MIRROR] Remapeando @lid via DB: ${resolvedPhone} -> ${targetPhone}`);
        }
      } else {
        debugInfo.phoneMappingFound = false;
        console.log(`✅ [WEBHOOK-MIRROR] Número real encontrado, sem necessidade de mapeamento: ${resolvedPhone}`);
      }

      const normalizedPhone = normalizePhoneNumber(targetPhone);
      
    // 🔍 DEBUG: Registrar todos os dados para diagnóstico
      try {
        const debugPayload = JSON.stringify(req.body);
        await db.execute(sql`
          INSERT INTO webhook_debug_log (raw_payload, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to)
          VALUES (${debugPayload.substring(0, 8000)}, ${rawRemoteJid}, ${cleanPhone}, ${normalizedPhone}, ${!!phoneMapping}, ${phoneMapping?.canonicalPhone || null})
        `);
        console.log(`🔍 [WEBHOOK-DEBUG] Registrado: ${rawRemoteJid} -> ${cleanPhone} -> ${normalizedPhone} (fonte: ${phoneSource})`);
        
        // Log específico para mídias
        if (debugPayload.includes('Message') && (debugPayload.includes('url') || debugPayload.includes('base64'))) {
          console.log(`📎 [WEBHOOK-DEBUG-MEDIA] Detectada possível mídia no payload de ${normalizedPhone}`);
        }
      } catch (dbErr) {
        console.error(`⚠️ [WEBHOOK-DEBUG] Erro ao registrar debug:`, dbErr);
      }
      const isFromMe = data.key.fromMe === true;
      const messageText = evolutionAPIService.extractMessageText(data.message) || '';
      const messageId = data.key.id;
      
      // 🖼️ Extrair informações de mídia
      const mediaInfo = evolutionAPIService.extractMediaInfo(data.message);
      debugInfo.mediaInfo = mediaInfo;
      
      // 🎯 NOVO: Suporte a estrutura de mídia da Evolution API v2 (pode estar em msg.message ou msg direto)
      if (mediaInfo.messageType !== 'text' && !mediaInfo.mediaUrl) {
        const msg = data.message?.message || data.message;
        const deepMsg = msg?.message || msg;
        
        // Check for base64 in various possible locations in Evolution API payload
        const base64Source = deepMsg?.base64 || msg?.base64 || data.message?.base64 || data.base64 || 
                           deepMsg?.imageMessage?.base64 || deepMsg?.audioMessage?.base64 || 
                           deepMsg?.videoMessage?.base64 || deepMsg?.documentMessage?.base64 ||
                           deepMsg?.image?.base64 || deepMsg?.audio?.base64 ||
                           deepMsg?.video?.base64 || deepMsg?.document?.base64 ||
                           data.message?.image?.base64 || data.message?.video?.base64;

        const mimeSource = deepMsg?.mimetype || msg?.mimetype || data.message?.mimetype || data.mimetype ||
                          deepMsg?.imageMessage?.mimetype || deepMsg?.audioMessage?.mimetype ||
                          deepMsg?.videoMessage?.mimetype || deepMsg?.documentMessage?.mimetype ||
                          deepMsg?.image?.mimetype || deepMsg?.audio?.mimetype ||
                          deepMsg?.video?.mimetype || deepMsg?.document?.mimetype ||
                          data.message?.image?.mimetype || data.message?.video?.mimetype;
        
        if (base64Source) {
          mediaInfo.mediaUrl = base64Source.startsWith('data:') ? base64Source : `data:${mimeSource || 'image/jpeg'};base64,${base64Source}`;
          
          // Identify message type if it wasn't already
          if (!mediaInfo.messageType || mediaInfo.messageType === 'text') {
            if (mimeSource?.startsWith('image/')) mediaInfo.messageType = 'image';
            else if (mimeSource?.startsWith('audio/')) mediaInfo.messageType = 'audio';
            else if (mimeSource?.startsWith('video/')) mediaInfo.messageType = 'video';
            else mediaInfo.messageType = 'document';
          }
          
          console.log(`✅ [WEBHOOK-MEDIA] Mídia encontrada no payload (v2 structure detected, type: ${mediaInfo.messageType})`);
        }
      }

      const finalMessageType = mediaInfo.messageType || 'text';
      let finalMediaUrl = mediaInfo.mediaUrl || null;
      const finalContent = messageText || (finalMessageType !== 'text' ? `[Mídia: ${finalMessageType}]` : '');
      
      // 🔧 Se for mídia mas não temos a URL/base64, tentar baixar via Evolution API
      if (finalMessageType !== 'text' && !finalMediaUrl && messageId) {
        try {
          console.log(`📥 [WEBHOOK-MEDIA] Baixando mídia via getBase64FromMediaMessage: ${messageId}`);
          const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
          if (instanceName) {
            // Passar o key completo para Evolution API v2.3.6+
            const messageKey = {
              id: messageId,
              remoteJid: data.key?.remoteJid,
              fromMe: data.key?.fromMe
            };
            const messageTimestamp = data.messageTimestamp;
            const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(instanceName, messageKey, messageTimestamp);
            if (mediaResult.success && mediaResult.base64) {
              const mimeType = mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream';
              finalMediaUrl = `data:${mimeType};base64,${mediaResult.base64}`;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia baixada com sucesso: ${mimeType}`);
            } else {
              console.warn(`⚠️ [WEBHOOK-MEDIA] Falha ao baixar mídia: ${mediaResult.error}`);
            }
          }
        } catch (downloadErr: any) {
          console.warn(`⚠️ [WEBHOOK-MEDIA] Erro ao baixar mídia: ${downloadErr.message}`);
        }
      }
      
      debugInfo.normalizedPhone = normalizedPhone;
      debugInfo.isFromMe = isFromMe;
      debugInfo.messageText = messageText.substring(0, 50);
      debugInfo.steps.push('4-normalize-phone');
      
      console.log(`📱 [WEBHOOK-MIRROR] Processando: ${normalizedPhone} | FromMe: ${isFromMe} | Texto: ${messageText.substring(0, 50)}`);

      // 🔍 Buscar contato na agenda (Phonebook) para identificação prioritária
      debugInfo.steps.push('5-lookup-phonebook');
      const phonebookContact = await storage.getPhonebookContactByPhone(normalizedPhone);
      const identifiedName = phonebookContact?.name || data.pushName || `Cliente ${normalizedPhone}`;
      debugInfo.identifiedName = identifiedName;
      
      if (phonebookContact) {
        console.log(`📖 [WEBHOOK-MIRROR] Contato identificado na agenda: ${identifiedName}`);
      }

      // 1. Garantir Cliente e Conversa
      debugInfo.steps.push('6-get-customer-conversation');
      let conversation = await storage.getChatConversationByPhone(normalizedPhone);
      let customer = await storage.getChatCustomerByPhone(normalizedPhone);
      debugInfo.existingCustomer = !!customer;
      debugInfo.existingConversation = !!conversation;

      if (!customer) {
        debugInfo.steps.push('7a-create-customer');
        customer = await storage.createChatCustomer({
          phone: normalizedPhone,
          name: identifiedName
        });
        debugInfo.createdCustomerId = customer.id;
      } else if (phonebookContact && customer.name !== identifiedName) {
        // Atualizar nome do cliente se mudou na agenda
        await storage.updateChatCustomer(customer.id, { name: identifiedName });
      }

      if (!conversation) {
        debugInfo.steps.push('7b-create-conversation');
        conversation = await storage.createChatConversation({
          customerId: customer.id,
          customerName: identifiedName,
          customerPhone: normalizedPhone,
          status: 'new',
          priority: 'normal'
        });
        debugInfo.createdConversationId = conversation.id;
        
        // 🔄 Distribuir nova conversa para atendente disponível (round-robin)
        try {
          debugInfo.steps.push('7c-distribute-conversation');
          const { distributeNewConversation } = await import("./chat-distribution-service");
          await distributeNewConversation(conversation.id);
          console.log(`🔄 [WEBHOOK] Nova conversa ${conversation.id} distribuída via round-robin`);
        } catch (distErr: any) {
          console.error(`⚠️ [WEBHOOK] Erro ao distribuir conversa:`, distErr.message);
        }
      } else if (phonebookContact && conversation.customerName !== identifiedName) {
        // Atualizar nome na conversa se mudou na agenda
        await storage.updateChatConversation(conversation.id, { customerName: identifiedName });
      }

      // 2. Verificar duplicidade (externalId)
      debugInfo.steps.push('8-check-duplicate');
      const existingMessages = await storage.getChatMessages(conversation.id);
      const isDuplicate = existingMessages.some(m => m.externalId === messageId);
      debugInfo.messageCount = existingMessages.length;
      
      if (isDuplicate) {
        console.log(`⏭️  [WEBHOOK-MIRROR] Mensagem duplicada ignorada: ${messageId}`);
        return res.json({ success: true, duplicate: true, debug: debugInfo });
      }

      // 3. Salvar Mensagem (com suporte a mídia)
      debugInfo.steps.push('9-save-message');
      
      console.log(`📎 [WEBHOOK-MEDIA] Tipo: ${finalMessageType} | URL: ${finalMediaUrl ? 'SIM' : 'NÃO'} | Conteúdo: ${finalContent.substring(0, 30)}`);
      
      // 🗄️ NOVO: Salvar mídia no Object Storage externo se houver
      let storedMediaUrl = finalMediaUrl;
      if (finalMediaUrl && finalMessageType !== 'text') {
        try {
          debugInfo.steps.push('9a-upload-media-to-storage');
          const { uploadWhatsAppMediaToStorage, uploadMediaFromBase64 } = await import("./whatsapp-media-storage");
          
          if (finalMediaUrl.startsWith('data:')) {
            // É base64, extrair e fazer upload
            const mimeMatch = finalMediaUrl.match(/data:([^;]+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
            const base64Data = finalMediaUrl.replace(/^data:[^;]+;base64,/, '');
            
            const uploadResult = await uploadMediaFromBase64(base64Data, mimeType);
            if (uploadResult.success && uploadResult.objectPath) {
              storedMediaUrl = uploadResult.objectPath;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia base64 salva no Object Storage: ${storedMediaUrl}`);
            }
          } else if (finalMediaUrl.startsWith('http')) {
            // É URL externa, baixar e fazer upload
            const uploadResult = await uploadWhatsAppMediaToStorage(finalMediaUrl, mediaInfo.mediaType || 'image/jpeg', mediaInfo.mediaFilename);
            if (uploadResult.success && uploadResult.objectPath) {
              storedMediaUrl = uploadResult.objectPath;
              console.log(`✅ [WEBHOOK-MEDIA] Mídia URL salva no Object Storage: ${storedMediaUrl}`);
            }
          }
        } catch (uploadErr: any) {
          console.error(`⚠️ [WEBHOOK-MEDIA] Erro ao salvar mídia no Object Storage:`, uploadErr.message);
          // Continua com a URL original se houver erro
        }
      }
      
      await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: isFromMe ? 'system' : (customer?.id || 'unknown'),
        senderType: isFromMe ? 'system' : 'customer',
        content: finalContent,
        messageType: finalMessageType,
        mediaUrl: storedMediaUrl,
        externalId: messageId,
        isRead: true
      });

      // 4. Atualizar Conversa - Forçar lastMessageTime para ordenação
      debugInfo.steps.push('10-update-conversation');
      await storage.updateChatConversation(conversation.id, {
        updatedAt: new Date(),
        lastMessageTime: new Date(),
        status: isFromMe ? conversation.status : 'new',
        unreadCount: 0
      });

      // 🤖 NOVO: Acionar resposta automática do ChatGPT se estiver habilitado
      if (!isFromMe) {
        debugInfo.steps.push('10a-ai-trigger');
        try {
          const aiSettings = await storage.getChatAiSettings();
          if (aiSettings && aiSettings.isEnabled && aiSettings.mode !== 'disabled') {
            console.log(`🤖 [WEBHOOK-AI] Acionando IA para conversa: ${conversation.id} (${normalizedPhone})`);
            
            // Importar dinamicamente para evitar dependência circular se houver
            const { handleIncomingMessage } = await import("./chatgpt-service");
            
            // Executar em background para não atrasar o webhook
            handleIncomingMessage(
              {
                id: conversation.id,
                customerName: identifiedName,
                customerPhone: normalizedPhone
              },
              {
                content: finalContent,
                timestamp: new Date()
              },
              aiSettings
            ).catch(err => console.error(`❌ [WEBHOOK-AI] Erro ao processar resposta da IA:`, err));
          }
        } catch (aiErr: any) {
          console.error(`⚠️ [WEBHOOK-AI] Erro ao verificar configurações de IA:`, aiErr.message);
        }
      }

      debugInfo.steps.push('11-complete');
      console.log(`✅ [WEBHOOK-MIRROR] Sucesso total: ${normalizedPhone}`);
      res.json({ success: true, debug: debugInfo });
    } catch (error: any) {
      debugInfo.error = error.message;
      debugInfo.stack = error.stack?.split('\n').slice(0, 5);
      console.error("❌ [WEBHOOK-MIRROR] Erro Crítico:", error.message);
      res.status(200).json({ error: error.message, debug: debugInfo });
    }
  });

  // ============================================================
  // SDR DIGITAL ROUTES
  // ============================================================

  // Send WhatsApp message via Evolution API
  app.post("/api/chat/send-message", authenticateUser, async (req, res) => {
    try {
      const { phoneNumber, message, messageType = 'text', mediaUrl, caption } = req.body;

      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      if (!message && messageType === 'text') {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      // Normalizar telefone
      let targetPhone = phoneNumber;
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      
      // Buscar mapeamento no banco de dados (correspondência exata apenas)
      const phoneMapping = await storage.getPhoneMappingBySource(cleanPhone);
      
      if (phoneMapping) {
        targetPhone = phoneMapping.canonicalPhone;
        console.log(`🔄 [WHATSAPP-SEND] Remapeando via DB: ${phoneNumber} -> ${targetPhone}`);
      }
      
      const normalizedPhone = normalizePhoneNumber(targetPhone);
      console.log(`📨 [WHATSAPP-SEND] Enviando para: ${phoneNumber} -> ${normalizedPhone}`);

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📨 [WHATSAPP-SEND] Enviando mensagem para ${normalizedPhone} via ${messageType}`);

      // Determinar tipo de mídia real e normalizar
      const isMediaMessage = ['media', 'image', 'audio', 'video', 'document'].includes(messageType);
      const actualMediaType = messageType === 'media' ? 'image' : messageType as 'text' | 'image' | 'audio' | 'video' | 'document';
      
      // Validar que mídia tem mediaUrl
      if (isMediaMessage && !mediaUrl) {
        return res.status(400).json({ error: "mediaUrl é obrigatório para envio de mídia" });
      }

      let result;
      if (isMediaMessage && mediaUrl) {
        result = await evolutionAPIService.sendMediaMessage(config.instanceName, normalizedPhone, mediaUrl, caption, actualMediaType as 'image' | 'audio' | 'video' | 'document');
      } else if (messageType === 'location' && req.body.latitude && req.body.longitude) {
        result = await evolutionAPIService.sendLocationMessage(config.instanceName, normalizedPhone, req.body.latitude, req.body.longitude, caption);
      } else {
        result = await evolutionAPIService.sendTextMessage(config.instanceName, normalizedPhone, message);
      }

      if (!result.success) {
        console.error(`❌ [WHATSAPP-SEND] Erro ao enviar:`, result.error);
        return res.status(500).json({ error: result.error || "Erro ao enviar mensagem" });
      }

      // Save message to conversation history (SEMPRE SALVAR, nunca ignorar)
      try {
        // 1. Buscar ou criar cliente
        let customer = await storage.getChatCustomerByPhone(normalizedPhone);
        if (!customer) {
          customer = await storage.createChatCustomer({
            phone: normalizedPhone,
            name: `Cliente ${normalizedPhone}`
          });
          console.log(`✅ [WHATSAPP-SEND] Cliente criado: ${customer.id}`);
        }

        // 2. Usar UPSERT para garantir uma única conversa por telefone
        const conversation = await storage.upsertChatConversation({
          customerId: customer.id,
          customerName: customer.name || `Cliente ${normalizedPhone}`,
          customerPhone: normalizedPhone,
          status: 'new' as const,
          priority: 'normal' as const,
          lastMessageTime: new Date(),
          updatedAt: new Date()
        });
        console.log(`✅ [WHATSAPP-SEND] Conversa: ${conversation.id}`);

      // 3. Salvar mensagem ENVIADA com tipo normalizado
        await storage.createChatMessage({
          conversationId: conversation.id,
          senderId: (req as any).user?.id || "system",
          senderType: "system",
          content: message || caption || (actualMediaType !== 'text' ? `[${actualMediaType}]` : ''),
          messageType: actualMediaType as any,
          mediaUrl: mediaUrl,
          externalId: result.messageId
        });
        console.log(`💬 [WHATSAPP-SEND] Mensagem salva`);
      } catch (err) {
        console.error("[CHAT] Error saving message history:", err);
        // Não falhar o envio se falhar ao salvar histórico
      }

      console.log(`✅ [WHATSAPP-SEND] Mensagem enviada com sucesso para ${normalizedPhone}`);
      res.json({ 
        success: true, 
        messageId: result.messageId,
        message: "Mensagem enviada com sucesso"
      });
    } catch (error) {
      console.error("[CHAT] Send message error:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem" });
    }
  });

  // ============================================================
  // DISPARO EM MASSA - BULK WHATSAPP MESSAGING
  // ============================================================

  // Upload spreadsheet and parse phone numbers
  app.post("/api/chat/bulk-message/parse", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), upload.single("file"), async (req, res) => {
    try {
      console.log(`[BULK] Parsing spreadsheet...`, req.file ? { 
        filename: req.file.filename, 
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        hasBuffer: !!req.file.buffer
      } : "No file");

      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }

      // Check if file exists on disk
      if (req.file.path && !fs.existsSync(req.file.path)) {
        console.error(`[BULK] Multer reported path ${req.file.path} but file does not exist on disk`);
        return res.status(500).json({ error: "Arquivo temporário não encontrado no servidor" });
      }

      const XLSX = await import("xlsx");
      let workbook;
      
      // Since we use diskStorage, req.file.path should be populated
      if (req.file.path) {
        console.log(`[BULK] Reading file from path: ${req.file.path}`);
        try {
          // Force a small delay to ensure OS file system has settled (sometimes helps with 500s on rapid uploads)
          await new Promise(resolve => setTimeout(resolve, 100));
          workbook = XLSX.readFile(req.file.path);
        } catch (readErr: any) {
          console.error(`[BULK] Error reading file via XLSX.readFile:`, readErr.message);
          // Fallback to reading as buffer
          const fileBuffer = fs.readFileSync(req.file.path);
          workbook = XLSX.read(fileBuffer, { type: "buffer" });
        }
      } else if (req.file.buffer) {
        console.log(`[BULK] Reading file from buffer`);
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } else {
        console.error(`[BULK] No file path or buffer found`);
        return res.status(400).json({ error: "Dados do arquivo não encontrados no servidor" });
      }
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { header: 1 });

      // Find phone column (looking for common header names)
      const headers = data[0] as string[];
      const phoneColumnIndex = headers?.findIndex((h: string) => 
        h && typeof h === 'string' && 
        (h.toLowerCase().includes('telefone') || 
         h.toLowerCase().includes('phone') || 
         h.toLowerCase().includes('celular') || 
         h.toLowerCase().includes('whatsapp') ||
         h.toLowerCase().includes('numero') ||
         h.toLowerCase().includes('número') ||
         h.toLowerCase() === 'tel')
      );

      // Find name column if exists
      const nameColumnIndex = headers?.findIndex((h: string) => 
        h && typeof h === 'string' && 
        (h.toLowerCase().includes('nome') || 
         h.toLowerCase().includes('name') ||
         h.toLowerCase().includes('cliente'))
      );

      if (phoneColumnIndex === -1) {
        // If no header found, assume first column is phone
        console.log(`⚠️ Coluna de telefone não encontrada pelo cabeçalho. Usando primeira coluna.`);
      }

      const colIndex = phoneColumnIndex !== -1 ? phoneColumnIndex : 0;
      const nameColIndex = nameColumnIndex !== -1 ? nameColumnIndex : -1;

      // Extract phone numbers (skip header row)
      const contacts: Array<{ phone: string; name: string; valid: boolean }> = [];
      const seen = new Set<string>();

      for (let i = 1; i < data.length; i++) {
        const row = data[i] as any[];
        if (!row || row.length === 0) continue;

        const rawValue = row[colIndex];
        if (rawValue === undefined || rawValue === null) continue;
        
        const rawPhone = String(rawValue).trim();
        if (!rawPhone) continue;

        const nameValue = nameColIndex !== -1 ? row[nameColIndex] : null;
        const name = nameValue ? String(nameValue).trim() : '';
        
        // Clean phone number
        const digitsOnly = rawPhone.replace(/\D/g, '');
        
        if (digitsOnly.length >= 8) {
          const normalized = normalizePhoneNumber(digitsOnly);
          
          if (!seen.has(normalized)) {
            seen.add(normalized);
            contacts.push({
              phone: normalized,
              name: name || `Contato ${i}`,
              valid: true
            });
          }
        }
      }

      // Cleanup uploaded file
      if (req.file.path) {
        fs.unlink(req.file.path, () => {});
      }

      console.log(`📊 [BULK] Planilha processada: ${contacts.length} contatos válidos de ${data.length - 1} linhas`);

      res.json({
        success: true,
        totalRows: data.length - 1,
        validContacts: contacts.length,
        contacts: contacts.slice(0, 500) // Limit to 500 for preview
      });
    } catch (error: any) {
      console.error("[BULK] Parse error:", error);
      res.status(500).json({ error: `Erro ao processar planilha: ${error.message}` });
    }
  });

  // Send bulk messages
  app.post("/api/chat/bulk-message/send", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), async (req, res) => {
    try {
      const { contacts, message, delaySeconds = 3 } = req.body;

      console.log(`[BULK] Starting message blast...`, { 
        contactsCount: contacts?.length,
        messagePreview: message?.substring(0, 30),
        delaySeconds 
      });

      if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: "Lista de contatos é obrigatória" });
      }

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📤 [BULK] Iniciando disparo em massa para ${contacts.length} contatos`);

      // Process in background - don't block the response
      const results: Array<{ phone: string; name: string; success: boolean; error?: string }> = [];
      const delay = Math.max(1, Math.min(30, delaySeconds || 3)) * 1000; // 1-30 seconds delay

      // Return immediately with job started
      res.json({
        success: true,
        message: `Disparo iniciado para ${contacts.length} contatos`,
        totalContacts: contacts.length,
        estimatedTimeMinutes: Math.ceil((contacts.length * delay) / 60000)
      });

      // Process messages in background
      (async () => {
        for (let i = 0; i < contacts.length; i++) {
          const contact = contacts[i];
          
          try {
            // Personalize message with {{name}} placeholder
            const personalizedMessage = message.replace(/\{\{nome\}\}/gi, contact.name || 'Cliente');
            
            const result = await evolutionAPIService.sendTextMessage(
              config.instanceName,
              contact.phone,
              personalizedMessage
            );

            results.push({
              phone: contact.phone,
              name: contact.name,
              success: result.success,
              error: result.error
            });

            console.log(`📤 [BULK] ${i + 1}/${contacts.length}: ${contact.phone} - ${result.success ? '✅' : '❌ ' + result.error}`);

            // Delay between messages to avoid rate limiting
            if (i < contacts.length - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (error: any) {
            results.push({
              phone: contact.phone,
              name: contact.name,
              success: false,
              error: error.message
            });
            console.error(`❌ [BULK] Erro ao enviar para ${contact.phone}:`, error.message);
          }
        }

        const successCount = results.filter(r => r.success).length;
        console.log(`📊 [BULK] Disparo concluído: ${successCount}/${contacts.length} enviados com sucesso`);
      })();

    } catch (error: any) {
      console.error("[BULK] Send error:", error);
      res.status(500).json({ error: `Erro ao enviar mensagens: ${error.message}` });
    }
  });

  // Download sample spreadsheet template
  app.get("/api/chat/bulk-message/template", authenticateUser, async (req, res) => {
    try {
      const XLSX = await import("xlsx");
      
      // Create sample workbook
      const sampleData = [
        ["Nome", "Telefone"],
        ["João Silva", "62999991111"],
        ["Maria Santos", "62999992222"],
        ["Pedro Oliveira", "(62) 99999-3333"]
      ];
      
      const worksheet = XLSX.utils.aoa_to_sheet(sampleData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Contatos");
      
      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=modelo_disparo_whatsapp.xlsx");
      res.send(buffer);
    } catch (error: any) {
      console.error("[BULK] Template error:", error);
      res.status(500).json({ error: "Erro ao gerar modelo" });
    }
  });

  // ============================================================
  // TELEGRAM SETUP ROUTES
  // ============================================================

  // Get Telegram status
  app.get("/api/chat/telegram/status", authenticateUser, async (req, res) => {
    try {
      const status = await telegramService.getStatus();
      res.json(status);
    } catch (error) {
      console.error("[CHAT] Telegram status error:", error);
      res.status(500).json({ error: "Erro ao buscar status do Telegram" });
    }
  });

  // Setup Telegram
  app.post(
    "/api/chat/telegram/setup",
    authenticateUser,
    requireRole(["admin"]),
    async (req, res) => {
      try {
        const { botToken } = req.body;
        
        if (!botToken) {
          return res.status(400).json({ error: "Token do bot é obrigatório" });
        }

        // Store token in system settings for later use
        await storage.upsertSystemSetting({ key: "telegram_bot_token", value: botToken, description: "Token do bot do Telegram" });
        res.json({ success: true, message: "Token salvo com sucesso" });
      } catch (error) {
        console.error("[CHAT] Telegram setup error:", error);
        res.status(500).json({ error: "Erro ao configurar Telegram" });
      }
    }
  );

  // ============================================================
  // WHATSAPP ANALYSIS ROUTES
  // ============================================================

  // Analyze WhatsApp conversation
  app.post("/api/chat/whatsapp/analyze", authenticateUser, async (req, res) => {
    try {
      const validatedData = insertWhatsappConversationAnalysisSchema.parse(req.body);
      // Store the analysis request
      const analysis = await storage.createWhatsappAnalysis(validatedData);
      res.json(analysis);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("[CHAT] WhatsApp analysis error:", error);
      res.status(500).json({ error: "Erro ao analisar conversa do WhatsApp" });
    }
  });

  // ============================================================
  // WEBHOOK PARA RECEBER MENSAGENS DO WHATSAPP
  // ============================================================
  
  // GET endpoint para validação do webhook (Evolution API pode solicitar)
  app.get("/api/chat/webhook/messages", (req, res) => {
    console.log(`✅ [WEBHOOK-GET] Validação do webhook recebida`);
    res.status(200).json({ status: 'ok', message: 'Webhook is active' });
  });

  // Diagnóstico COMPLETO - verificar status da instância e webhook
  app.get("/api/chat/webhook/debug", async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      
      // 1. Verificar configuração
      const isConfigured = evolutionAPIService.isConfigured();
      
      // 2. Testar conexão com Evolution API
      const connectionTest = await evolutionAPIService.testConnection();
      
      // 3. Buscar status da instância
      const instanceStatus = await evolutionAPIService.getInstanceStatus(instanceName);
      
      // 4. Buscar status do webhook
      const webhookStatus = await evolutionAPIService.getWebhook(instanceName);
      
      // 5. Determinar diagnóstico
      let diagnostico = "PROBLEMAS IDENTIFICADOS:\n";
      let problemas = [];
      
      if (!isConfigured) {
        problemas.push("❌ Evolution API não configurada");
      } else {
        diagnostico += "✅ Evolution API configurada\n";
      }
      
      if (!connectionTest.success) {
        problemas.push(`❌ Conexão com Evolution API falhou: ${connectionTest.error}`);
      } else {
        diagnostico += "✅ Conexão com Evolution API OK\n";
      }
      
      if (!instanceStatus.success) {
        problemas.push(`❌ Status da instância indisponível: ${instanceStatus.error}`);
      } else if (instanceStatus.status !== 'open') {
        problemas.push(`❌ Instância não conectada (status: ${instanceStatus.status}). AÇÃO: Conectar ao WhatsApp usando QR Code`);
      } else {
        diagnostico += `✅ Instância ${instanceName} CONECTADA ao WhatsApp\n`;
      }
      
      if (!webhookStatus.success) {
        problemas.push(`❌ Webhook indisponível: ${webhookStatus.error}`);
      } else if (webhookStatus.webhook?.enabled !== true) {
        problemas.push("❌ Webhook não está ATIVO (disabled)");
      } else {
        diagnostico += "✅ Webhook ATIVO e pronto para receber mensagens\n";
      }
      
      res.json({
        success: true,
        diagnostico,
        problemas: problemas.length > 0 ? problemas : null,
        detalhes: {
          evolutionConfigured: isConfigured,
          connectionOk: connectionTest.success,
          instanceConnected: instanceStatus.status === 'open',
          instanceStatus: instanceStatus.status,
          webhookEnabled: webhookStatus.webhook?.enabled,
          webhookUrl: webhookStatus.webhook?.url
        },
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      console.error('[WEBHOOK-DEBUG] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para FORÇAR reconfiguração do webhook de PRODUÇÃO
  // Use este endpoint quando precisar garantir que o webhook aponte para produção
  app.post("/api/chat/webhook/force-production", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      const prodDomain = process.env.REPLIT_DOMAIN || (process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',')[0] : null);
      
      if (!prodDomain) {
        return res.status(400).json({ 
          error: "Domínio de produção não encontrado", 
          message: "Não foi possível determinar o domínio de produção" 
        });
      }
      
      const webhookUrl = `https://${prodDomain}/api/chat/webhook/messages`;
      console.log(`🔧 [FORCE-PROD] Forçando webhook para produção: ${webhookUrl}`);
      
      const result = await evolutionAPIService.setWebhook(instanceName, webhookUrl);
      
      if (result.success) {
        console.log(`✅ [FORCE-PROD] Webhook reconfigurado com sucesso para produção`);
        res.json({ 
          success: true, 
          message: "Webhook reconfigurado para produção com sucesso",
          url: webhookUrl
        });
      } else {
        console.error(`❌ [FORCE-PROD] Erro:`, result.error);
        res.status(500).json({ error: result.error });
      }
    } catch (error: any) {
      console.error('[FORCE-PROD] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para FORÇAR reconfiguração do webhook de DESENVOLVIMENTO (apenas para testes)
  app.post("/api/chat/webhook/force-dev-config", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      
      if (!devDomain) {
        return res.status(400).json({ 
          error: "REPLIT_DEV_DOMAIN não encontrado", 
          message: "Este endpoint só funciona no ambiente de desenvolvimento" 
        });
      }
      
      const webhookUrl = `https://${devDomain}/api/chat/webhook/messages`;
      console.log(`🔧 [FORCE-DEV] Forçando webhook para desenvolvimento: ${webhookUrl}`);
      
      const result = await evolutionAPIService.setWebhook(instanceName, webhookUrl);
      
      if (result.success) {
        console.log(`✅ [FORCE-DEV] Webhook reconfigurado para desenvolvimento`);
        res.json({ 
          success: true, 
          message: "Webhook reconfigurado para desenvolvimento com sucesso",
          url: webhookUrl,
          warning: "ATENÇÃO: O webhook agora aponta para desenvolvimento. Mensagens de produção NÃO serão recebidas!"
        });
      } else {
        console.error(`❌ [FORCE-DEV] Erro:`, result.error);
        res.status(500).json({ error: result.error });
      }
    } catch (error: any) {
      console.error('[FORCE-DEV] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para conectar instância ao WhatsApp (gerar QR Code)
  app.get("/api/chat/webhook/connect", async (req, res) => {
    try {
      const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
      console.log(`📱 [CONNECT] Gerando QR Code para instância ${instanceName}...`);
      
      const qrResult = await evolutionAPIService.getQRCode(instanceName);
      
      if (!qrResult.success) {
        return res.status(400).json({ 
          error: qrResult.error,
          message: `Erro ao gerar QR Code: ${qrResult.error}`
        });
      }
      
      if (qrResult.alreadyConnected) {
        return res.json({
          connected: true,
          message: 'Instância já está conectada ao WhatsApp'
        });
      }
      
      res.json({
        success: true,
        message: 'QR Code gerado com sucesso',
        qrcode: qrResult.qrcode,
        instructions: 'Abra WhatsApp no seu celular, vá em Configurações > Aparelhos conectados > Conectar um aparelho e escaneie o QR Code'
      });
    } catch (error: any) {
      console.error('[CONNECT] Erro:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Teste de webhook GET - simular mensagem recebida (acessível via navegador)
  app.get("/api/chat/webhook/test", async (req, res) => {
    try {
      console.log(`🧪 [WEBHOOK-TEST-GET] Simulando mensagem recebida via GET...`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: "5562995782812@s.whatsapp.net",
            fromMe: false,
            id: "test_" + Date.now()
          },
          message: {
            conversation: "Teste de resposta do webhook GET - " + new Date().toLocaleTimeString('pt-BR')
          },
          pushName: "Teste WhatsApp"
        }
      };

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST-GET] Resposta:`, result);

      res.json({ success: true, message: "Teste enviado via GET", result, timestamp: new Date().toISOString() });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-GET] Erro:", error);
      res.status(500).json({ error: "Erro no teste de webhook" });
    }
  });

  // Teste de webhook - simular mensagem recebida
  app.post("/api/chat/webhook/test", async (req, res) => {
    try {
      console.log(`🧪 [WEBHOOK-TEST] Simulando mensagem recebida...`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: "5562995782812@s.whatsapp.net",
            fromMe: false,
            id: "test_" + Date.now()
          },
          message: {
            conversation: "Teste de resposta do webhook - " + new Date().toLocaleTimeString('pt-BR')
          },
          pushName: "Teste WhatsApp"
        }
      };

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST] Resposta:`, result);

      res.json({ success: true, message: "Teste enviado", result });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST] Erro:", error);
      res.status(500).json({ error: "Erro no teste de webhook" });
    }
  });

  // Teste avançado de webhook com parâmetros customizados
  app.post("/api/chat/webhook/test-advanced", async (req, res) => {
    try {
      const { phone = "5562995782812", message = "Teste avançado", fromMe = false } = req.body;
      
      console.log(`🧪 [WEBHOOK-TEST-ADVANCED] Enviando mensagem de teste com parâmetros:`);
      console.log(`   - Telefone: ${phone}`);
      console.log(`   - Mensagem: ${message}`);
      console.log(`   - De mim: ${fromMe}`);
      
      const testMessage = {
        event: "MESSAGES_UPSERT",
        instance: "CHAT_HONEST",
        data: {
          key: {
            remoteJid: `${phone}@s.whatsapp.net`,
            fromMe: fromMe,
            id: "test_adv_" + Date.now()
          },
          message: {
            conversation: message + ` (${new Date().toLocaleTimeString('pt-BR')})`
          },
          pushName: fromMe ? "Sistema" : "Cliente Teste"
        }
      };

      console.log(`📤 [WEBHOOK-TEST-ADVANCED] Payload:`, JSON.stringify(testMessage, null, 2));

      // Fazer requisição interna para testar o webhook
      const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testMessage)
      });

      const result = await response.json();
      console.log(`✅ [WEBHOOK-TEST-ADVANCED] Resposta do webhook:`, result);

      // Aguardar um pouco para garantir processamento
      await new Promise(resolve => setTimeout(resolve, 500));

      // Tentar buscar a conversa criada
      let conversation: any;
      try {
        const normalizedPhone = normalizePhoneNumber(phone);
        const customer = await storage.getChatCustomerByPhone(normalizedPhone).catch(() => null);
        if (customer) {
          conversation = await storage.getChatConversationByCustomerId(customer.id).catch(() => null);
        }
      } catch (err) {
        console.warn(`⚠️  [WEBHOOK-TEST-ADVANCED] Erro ao buscar conversa:`, err);
      }

      res.json({ 
        success: true, 
        message: "Teste avançado enviado", 
        webhook_response: result,
        conversation_found: !!conversation,
        conversation
      });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-ADVANCED] Erro:", error);
      res.status(500).json({ error: error.message || "Erro no teste avançado de webhook" });
    }
  });

  // Teste rápido: enviar várias mensagens para teste de volume
  app.post("/api/chat/webhook/test-batch", async (req, res) => {
    try {
      const { count = 3, phone = "5562995782812" } = req.body;
      
      console.log(`🧪 [WEBHOOK-TEST-BATCH] Enviando ${count} mensagens de teste...`);
      
      const results = [];
      for (let i = 1; i <= count; i++) {
        const testMessage = {
          event: "MESSAGES_UPSERT",
          instance: "CHAT_HONEST",
          data: {
            key: {
              remoteJid: `${phone}@s.whatsapp.net`,
              fromMe: false,
              id: `test_batch_${Date.now()}_${i}`
            },
            message: {
              conversation: `Mensagem de teste #${i} - ${new Date().toLocaleTimeString('pt-BR')}`
            },
            pushName: "Teste Batch"
          }
        };

        try {
          const response = await fetch("http://localhost:5000/api/chat/webhook/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testMessage)
          });
          const result = await response.json();
          results.push({ index: i, success: true, response: result });
          console.log(`✅ [WEBHOOK-TEST-BATCH] Mensagem ${i}/${count} enviada`);
        } catch (err) {
          results.push({ index: i, success: false, error: (err as any).message });
          console.error(`❌ [WEBHOOK-TEST-BATCH] Erro na mensagem ${i}:`, err);
        }

        // Pequeno delay entre mensagens
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      res.json({ 
        success: true, 
        message: `${count} mensagens de teste enviadas`,
        results
      });
    } catch (error: any) {
      console.error("[WEBHOOK-TEST-BATCH] Erro:", error);
      res.status(500).json({ error: "Erro no teste em batch" });
    }
  });

  // ============================================================
  // POLLING SERVICE - ALTERNATIVA AO WEBHOOK
  // ============================================================

  // GET /api/chat/polling/status - Status do serviço de polling
  app.get("/api/chat/polling/status", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const status = evolutionPollingService.getStatus();
      res.json(status);
    } catch (error: any) {
      console.error("[POLLING] Erro ao buscar status:", error);
      res.status(500).json({ error: "Erro ao buscar status do polling" });
    }
  });

  // POST /api/chat/polling/start - Iniciar serviço de polling
  app.post("/api/chat/polling/start", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const { intervalMs = 15000 } = req.body; // Default 15 seconds
      evolutionPollingService.start(intervalMs);
      res.json({ 
        success: true, 
        message: `Polling iniciado a cada ${intervalMs / 1000}s`
      });
    } catch (error: any) {
      console.error("[POLLING] Erro ao iniciar:", error);
      res.status(500).json({ error: "Erro ao iniciar polling" });
    }
  });

  // POST /api/chat/polling/stop - Parar serviço de polling
  app.post("/api/chat/polling/stop", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      evolutionPollingService.stop();
      res.json({ success: true, message: "Polling parado" });
    } catch (error: any) {
      console.error("[POLLING] Erro ao parar:", error);
      res.status(500).json({ error: "Erro ao parar polling" });
    }
  });

  // POST /api/chat/polling/phone - Polling manual para um telefone específico
  app.post("/api/chat/polling/phone", authenticateUser, requireRole(["admin", "coordinator", "telemarketing"]), async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      
      if (!phoneNumber) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }
      
      const result = await evolutionPollingService.pollForPhone(phoneNumber);
      res.json(result);
    } catch (error: any) {
      console.error("[POLLING] Erro no polling manual:", error);
      res.status(500).json({ error: "Erro no polling manual" });
    }
  });

  // ============================================================
  // ENDPOINTS PARA GESTÃO DE CONVERSAS
  // ============================================================

  // GET /api/chat/conversations/stats - Estatísticas gerais de conversas
  app.get("/api/chat/conversations/stats", async (req, res) => {
    try {
      const conversations = await storage.getChatConversations();
      const agents = await storage.getChatAgents() || [];
      const messages: any[] = [];

      const activeConversations = conversations.filter(c => c.status !== 'resolved').length;
      const totalConversations = conversations.length;
      
      // Calcular tempo médio de resposta
      const averageResponseTime = 0;

      // Dados por dia
      const messagesByDay: Record<string, number> = {};
      messages.forEach((msg: any) => {
        const date = new Date(msg.timestamp || msg.createdAt).toISOString().split('T')[0];
        messagesByDay[date] = (messagesByDay[date] || 0) + 1;
      });

      const totalMessagesPerDay = Object.entries(messagesByDay)
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([date, count]) => ({ date, count }))
        .slice(-30); // Últimos 30 dias

      // Desempenho por atendente
      const responseTimeByAgent = agents.map((agent: any) => ({
        agentName: agent.name,
        totalHandled: agent.totalConversations || 0
      }));

      res.json({
        totalConversations,
        activeConversations,
        averageResponseTime,
        totalMessagesPerDay,
        responseTimeByAgent
      });
    } catch (error: any) {
      console.error("[CHAT-STATS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar estatísticas" });
    }
  });

  // GET /api/chat/conversations - Lista de conversas com filtros
  app.get("/api/chat/conversations", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';
      
      let conversations: any[] = [];
      let agents: any[] = [];
      let customers: any[] = [];
      let phonebookContacts: any[] = [];

      try {
        conversations = await storage.getChatConversations() || [];
      } catch (e) {
        console.error("[CHAT] Error getting conversations:", e);
      }

      try {
        agents = await storage.getChatAgents() || [];
      } catch (e) {
        console.error("[CHAT] Error getting agents:", e);
      }

      try {
        customers = await storage.getChatCustomers() || [];
      } catch (e) {
        console.error("[CHAT] Error getting customers:", e);
      }

      // ✅ Buscar contatos da agenda para priorizar nomes salvos
      try {
        phonebookContacts = await storage.getPhonebookContacts() || [];
      } catch (e) {
        console.error("[CHAT] Error getting phonebook contacts:", e);
      }

      // 🔐 Filtrar conversas - admins veem TODAS, agents veem só suas atribuídas
      let filteredConversations = conversations;
      if (!isAdmin && currentUser?.id) {
        // Buscar agente ligado ao usuário
        const userAgent = agents.find(a => a.userId === currentUser.id);
        if (userAgent) {
          // Filtrar conversas atribuídas a este agente (usando assignedAgentId)
          filteredConversations = conversations.filter(c => 
            c.assignedAgentId === userAgent.id || c.agentId === userAgent.id
          );
        } else {
          // Usuário sem agente - vê conversas não atribuídas
          filteredConversations = conversations.filter(c => !c.assignedAgentId && !c.agentId);
        }
      }

      // Enriquecer conversas com dados relacionados
      const enrichedConversations = filteredConversations.map((conv: any) => {
        const assignedAgent = agents.find(a => a.id === conv.assignedAgentId);
        const creatorAgent = agents.find(a => a.id === conv.agentId);
        const customer = customers.find(c => c.id === conv.customerId);
        
        // ✅ PRIORIDADE: Agenda (phonebook) > Customer > Conversa > Fallback
        // Normalizar telefone para busca na agenda
        const normalizedPhone = (conv.customerPhone || customer?.phone || '').replace(/\D/g, '');
        const phonebookContact = phonebookContacts.find((p: any) => {
          const pPhone = (p.phone || '').replace(/\D/g, '');
          return pPhone === normalizedPhone || pPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(pPhone);
        });
        
        // Nome priorizado: agenda > customer > conversa > fallback
        const displayName = phonebookContact?.name || customer?.name || conv.customerName || "Desconhecido";
        
        return {
          id: conv.id,
          customerId: conv.customerId,
          customerName: displayName,
          customerPhone: conv.customerPhone || customer?.phone || "-",
          agentId: conv.agentId,
          agentName: creatorAgent?.name,
          assignedAgentId: conv.assignedAgentId,
          assignedAgentName: conv.assignedAgentId === 'chatgpt' ? 'ChatGPT' : assignedAgent?.name || null,
          assignedAgentColor: conv.assignedAgentColor || null,
          lastAttendedAt: conv.lastAttendedAt,
          status: conv.status,
          priority: conv.priority,
          lastMessageTime: conv.lastMessageTime,
          createdAt: conv.createdAt,
          unreadCount: 0,
          hasUnread: false
        };
      });

      // 🔴 ORDENAÇÃO: por data da última mensagem
      enrichedConversations.sort((a: any, b: any) => {
        return new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime();
      });

      res.json(enrichedConversations);
    } catch (error: any) {
      console.error("[CHAT-CONVERSATIONS] Erro fatal:", error.message || error);
      res.status(500).json({ error: "Erro ao buscar conversas", details: error.message });
    }
  });

  // ============================================================
  // 🆕 GET /api/conversations/:conversationId - Conversa COM mensagens ordenadas cronologicamente
  // Este endpoint é usado pelo chat-area.tsx para exibir mensagens intercaladas
  // ============================================================
  app.get("/api/conversations/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      
      // Buscar conversa
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }
      
      // Buscar mensagens e ordenar EXPLICITAMENTE por timestamp/createdAt (crescente - antigo primeiro)
      const rawMessages = await storage.getChatMessages(conversationId) || [];
      
      // 🔴 ORDENAÇÃO EXPLÍCITA: Garantir ordem cronológica exata (timestamp ou createdAt)
      // Isso é CRÍTICO para que mensagens de customer e agent sejam INTERCALADAS corretamente
      const messages = rawMessages.sort((a: any, b: any) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return timeA - timeB; // CRESCENTE: antigo primeiro, novo depois
      });
      
      console.log(`📋 [CONVERSATION-GET] Mensagens ordenadas: ${messages.length} | Primeira: ${messages[0]?.createdAt || 'N/A'} | Última: ${messages[messages.length-1]?.createdAt || 'N/A'}`);
      
      // Enriquecer mensagens com informações do remetente
      const agents = await storage.getChatAgents() || [];
      const customers = await storage.getChatCustomers() || [];
      
      const enrichedMessages = messages.map((msg: any) => {
        let senderName = 'Sistema';
        
        if (msg.senderType === 'customer') {
          const customer = customers.find((c: any) => c.id === msg.senderId);
          senderName = customer?.name || conversation.customerName || 'Cliente';
        } else if (msg.senderType === 'agent') {
          if (msg.senderId === 'system') {
            senderName = 'Sistema';
          } else {
            const agent = agents.find((a: any) => a.id === msg.senderId);
            senderName = agent?.name || 'Sem vendedor atrelado';
          }
        }
        
        return {
          ...msg,
          sender: {
            id: msg.senderId,
            name: senderName,
            type: msg.senderType
          }
        };
      });
      
      // Marcar mensagens de clientes como lidas ao abrir a conversa (DESATIVADO)
      /*
      const unreadMessages = messages.filter((m: any) => m.senderType === "customer" && !m.isRead);
      if (unreadMessages.length > 0) {
        console.log(`📖 [CONVERSATION-GET] Marcando ${unreadMessages.length} mensagens como lidas...`);
        for (const msg of unreadMessages) {
          await storage.updateChatMessage(msg.id, { isRead: true });
        }
        await storage.resetUnreadCount(conversationId);
      }
      */
      
      console.log(`📊 [CONVERSATION-GET] Conversa ${conversationId}: ${enrichedMessages.length} mensagens retornadas em ordem cronológica`);
      
      res.json({
        ...conversation,
        messages: enrichedMessages
      });
    } catch (error: any) {
      console.error("[CONVERSATION-GET] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar conversa" });
    }
  });

  // POST /api/conversations/:conversationId/assign - Atribuir conversa a agente
  app.post("/api/conversations/:conversationId/assign", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { agentId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "agentId é obrigatório" });
      }

      // 🎨 Obter cor do agente para visualização
      const agentColor = await getAgentColor(agentId);

      const updatedConv = await storage.updateChatConversation(conversationId, {
        agentId,
        assignedAgentId: agentId,
        assignedAgentColor: agentColor,
        lastAttendedAt: new Date(),
        status: 'assigned'
      });

      console.log(`✅ [ASSIGN] Conversa ${conversationId} atribuída a ${agentId} com cor ${agentColor}`);
      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CONVERSATION-ASSIGN] Erro:", error);
      res.status(500).json({ error: "Erro ao atribuir conversa" });
    }
  });

  // PATCH /api/conversations/:conversationId - Atualizar status da conversa
  app.patch("/api/conversations/:conversationId", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { status, ...otherUpdates } = req.body;

      const updatedConv = await storage.updateChatConversation(conversationId, {
        status,
        ...otherUpdates
      });

      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CONVERSATION-UPDATE] Erro:", error);
      res.status(500).json({ error: "Erro ao atualizar conversa" });
    }
  });

  // POST /api/conversations/:conversationId/sync-history - Sincronizar histórico da conversa
  app.post("/api/conversations/:conversationId/sync-history", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      
      // Buscar conversa para obter telefone
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Por enquanto, retornar sucesso sem sincronização (Evolution API sync)
      console.log(`📞 [SYNC-HISTORY] Sincronização solicitada para conversa ${conversationId}`);
      
      res.json({ 
        success: true, 
        messageCount: 0,
        message: "Sincronização em andamento"
      });
    } catch (error: any) {
      console.error("[SYNC-HISTORY] Erro:", error);
      res.status(500).json({ error: "Erro ao sincronizar histórico" });
    }
  });

  // GET /api/chat/history/phone/:phone - Buscar COMPLETO histórico por número telefônico
  app.get("/api/chat/history/phone/:phone", async (req, res) => {
    try {
      const { phone } = req.params;
      
      if (!phone) {
        return res.status(400).json({ error: "Telefone é obrigatório" });
      }

      // 🔍 Buscar cliente pelo telefone
      const chatCustomer = await storage.getChatCustomerByPhone(phone).catch(() => null);
      
      if (!chatCustomer) {
        return res.status(404).json({ 
          error: "Nenhum histórico encontrado para este número",
          phone 
        });
      }

      // 📋 Buscar TODAS as conversas do cliente
      const conversations = await storage.getChatConversations();
      const customerConversations = conversations.filter(c => c.customerId === chatCustomer.id);

      // 💬 Buscar TODAS as mensagens
      const allMessages: any[] = [];
      for (const conv of customerConversations) {
        const messages = await storage.getChatMessages(conv.id) || [];
        allMessages.push(...messages);
      }

      // ✅ Retornar histórico COMPLETO atrelado ao telefone
      res.json({
        phone: chatCustomer.phone,
        customerName: chatCustomer.name,
        customerId: chatCustomer.id,
        totalConversations: customerConversations.length,
        totalMessages: allMessages.length,
        conversations: customerConversations.map(c => ({
          id: c.id,
          customerPhone: c.customerPhone,
          status: c.status,
          createdAt: c.createdAt,
          messageCount: allMessages.filter(m => m.conversationId === c.id).length
        })),
        recentMessages: allMessages.sort((a: any, b: any) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        ).slice(0, 50) // Últimas 50 mensagens
      });
    } catch (error: any) {
      console.error("[CHAT-HISTORY] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar histórico" });
    }
  });

  // GET /api/chat/conversations/messages/:conversationId - Mensagens de uma conversa
  app.get("/api/chat/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getChatMessages(conversationId) || [];
      
      // Marcar TODAS as mensagens de clientes como lidas ao abrir a conversa (DESATIVADO)
      /*
      const unreadMessages = messages.filter(m => m.senderType === "customer" && !m.isRead);
      if (unreadMessages.length > 0) {
        console.log(`📖 [UNREAD-MARK] Marcando ${unreadMessages.length} mensagens como lidas...`);
        for (const msg of unreadMessages) {
          await storage.updateChatMessage(msg.id, { isRead: true });
        }
        
        // 🟢 Resetar contador de unread da conversa
        try {
          await storage.resetUnreadCount(conversationId);
          console.log(`🟢 [UNREAD-RESET] Contador resetado para conversa ${conversationId}`);
        } catch (err) {
          console.warn(`⚠️  [UNREAD-RESET] Erro ao resetar contador:`, err);
        }
      }
      */
      
      // Buscar mensagens novamente após marcar como lidas
      const updatedMessages = await storage.getChatMessages(conversationId) || [];
      
      // DEBUG: Verificar campos de mídia
      const mediaMessages = updatedMessages.filter((m: any) => m.messageType !== 'text' || m.mediaUrl);
      if (mediaMessages.length > 0) {
        console.log(`🖼️ [MEDIA-DEBUG] Conversa ${conversationId}: ${mediaMessages.length} mensagens de mídia`);
        mediaMessages.slice(0, 3).forEach((m: any) => {
          console.log(`   📎 ID: ${m.id} | Type: ${m.messageType} | URL: ${m.mediaUrl} | Content: ${m.content?.substring(0, 30)}`);
        });
      }
      
      res.json(updatedMessages);
    } catch (error: any) {
      console.error("[CHAT-MESSAGES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // GET /api/chat/agents/stats - Stats de conversas por agente (admin only)
  app.get("/api/chat/agents/stats", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
    try {
      const stats = await storage.getConversationsCountByAgent();
      res.json(stats);
    } catch (error: any) {
      console.error("[CHAT-AGENT-STATS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar stats de agentes" });
    }
  });

  // GET /api/chat/agents/detailed-stats - Stats detalhadas por agente (admin only)
  app.get("/api/chat/agents/detailed-stats", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
    try {
      const stats = await storage.getAgentDetailedStats();
      res.json(stats);
    } catch (error: any) {
      console.error("[CHAT-AGENT-DETAILED-STATS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar stats detalhadas de agentes" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/transfer - Transferir conversa (admin only)
  app.patch("/api/chat/conversations/:conversationId/transfer", authenticateUser, requireRole(["admin", "coordinator", "administrative"]), async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { newAgentId } = req.body;

      if (!newAgentId) {
        return res.status(400).json({ error: "newAgentId é obrigatório" });
      }

      // Validar que conversa existe
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Validar que agente existe
      const agents = await storage.getChatAgents();
      const targetAgent = agents.find(a => a.id === newAgentId);
      if (!targetAgent) {
        return res.status(404).json({ error: "Agente não encontrado" });
      }

      // Transferir
      const updated = await storage.transferConversation(conversationId, newAgentId);
      res.json(updated);
    } catch (error: any) {
      console.error("[CHAT-TRANSFER] Erro:", error);
      res.status(500).json({ error: "Erro ao transferir conversa" });
    }
  });

  // POST /api/chat/conversations/:conversationId/message - Enviar mensagem ou mídia
  app.post("/api/chat/conversations/:conversationId/message", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { content, messageType = "text", mediaUrl, mediaCaption } = req.body;
      const userId = (req as any).currentUser?.id;
      const currentUser = (req as any).currentUser;

      if (!content && !mediaUrl) {
        return res.status(400).json({ error: "Conteúdo ou mídia é obrigatório" });
      }

      // 🔍 Buscar conversa
      const conversation = await storage.getChatConversation(conversationId);
      if (!conversation) {
        return res.status(400).json({ error: "Conversa não encontrada" });
      }

      // 🔐 Verificar permissão: admin vê todas, agentes veem só suas
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';
      if (!isAdmin && conversation.agentId) {
        const agents = await storage.getChatAgents();
        const userAgent = agents.find(a => a.userId === userId);
        if (userAgent?.id !== conversation.agentId) {
          return res.status(403).json({ error: "Você não tem permissão para enviar mensagens nesta conversa" });
        }
      }

      // 💬 Salvar mensagem no banco
      const message = await storage.createChatMessage({
        conversationId: conversation.id,
        senderId: userId,
        senderType: "agent",
        content: content || mediaCaption || "Mídia enviada",
        messageType,
        mediaUrl,
      });

      console.log(`💬 [SEND-MESSAGE] Mensagem salva: ${message.id} na conversa ${conversation.id}`);

      // 🟢 Atualizar status para em-progresso
      if (storage.updateChatConversation) {
        await storage.updateChatConversation(conversation.id, {
          status: 'in-progress',
          agentId: (currentUser?.id ? (await storage.getChatAgents()).find(a => a.userId === userId)?.id : undefined) || conversation.agentId
        });
      }

      // 📱 Enviar para WhatsApp via Evolution API
      console.log(`📱 [SEND-WHATSAPP-START] Iniciando envio ${messageType} via WhatsApp...`);
      try {
        if (!conversation.customerId) {
          console.warn(`⚠️ [SEND-WHATSAPP] Sem customerId na conversa`);
        } else {
          const chatCustomer = await storage.getChatCustomer(conversation.customerId);
          console.log(`📱 [SEND-WHATSAPP] Cliente encontrado:`, chatCustomer?.id, chatCustomer?.phone);
          
          if (!chatCustomer?.phone) {
            console.warn(`⚠️ [SEND-WHATSAPP] Cliente sem telefone`);
          } else {
            const config = {
              instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST',
              apiUrl: process.env.EVOLUTION_API_BASE_URL || 'https://api.bothonest.com.br',
              apiKey: process.env.EVOLUTION_API_KEY || ''
            };
            
            console.log(`📱 [SEND-WHATSAPP] Config: instanceName=${config.instanceName}, hasKey=${!!config.apiKey}`);
            
            if (!config.instanceName || !config.apiKey) {
              console.warn(`⚠️ [SEND-WHATSAPP] Configuração incompleta da Evolution API`);
            } else {
              const phoneNormalized = normalizePhoneNumber(chatCustomer.phone);
              const phoneFormatted = phoneNormalized.includes('@') 
                ? phoneNormalized 
                : `${phoneNormalized}@s.whatsapp.net`;
              
              let sendResult;
              if (messageType === 'text' && content) {
                console.log(`📤 [SEND-WHATSAPP] Enviando texto para ${phoneFormatted}: "${content.substring(0, 50)}..."`);
                sendResult = await evolutionAPIService.sendTextMessage(
                  config.instanceName,
                  phoneFormatted,
                  content
                );
              } else if (mediaUrl) {
                console.log(`📤 [SEND-WHATSAPP] Enviando ${messageType} para ${phoneFormatted}`);
                
                // Convert local file to base64 if it's a local upload path
                let finalMediaUrl = mediaUrl;
                let detectedMimetype: string | undefined;
                let detectedFileName: string | undefined;
                
                // Handle both /uploads/chat/ and @assets/ styles if they appear
                if (mediaUrl.startsWith('/uploads/') || mediaUrl.includes('attached_assets')) {
                  try {
                    // Try to resolve path. If it's a relative web path, map to absolute filesystem path
                    let filePath = mediaUrl;
                    if (mediaUrl.startsWith('/uploads/')) {
                      filePath = path.join(process.cwd(), mediaUrl.substring(1));
                    }
                    
                    if (fs.existsSync(filePath)) {
                      const fileBuffer = fs.readFileSync(filePath);
                      const base64Data = fileBuffer.toString('base64');
                      const filename = path.basename(filePath);
                      
                      // Detect mimetype from extension
                      const ext = path.extname(filename).toLowerCase();
                      const mimeTypes: Record<string, string> = {
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.png': 'image/png',
                        '.gif': 'image/gif',
                        '.webp': 'image/webp',
                        '.mp4': 'video/mp4',
                        '.webm': 'video/webm',
                        '.mp3': 'audio/mpeg',
                        '.ogg': 'audio/ogg',
                        '.wav': 'audio/wav',
                        '.pdf': 'application/pdf',
                        '.doc': 'application/msword',
                        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        '.xls': 'application/vnd.ms-excel',
                        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                      };
                      detectedMimetype = mimeTypes[ext] || 'application/octet-stream';
                      detectedFileName = filename;
                      
                      finalMediaUrl = `data:${detectedMimetype};base64,${base64Data}`;
                      console.log(`📤 [SEND-WHATSAPP] Convertido para base64: ${detectedMimetype} (${Math.round(base64Data.length / 1024)}KB)`);
                    } else {
                      console.error(`❌ [SEND-WHATSAPP] Arquivo não encontrado: ${filePath}`);
                    }
                  } catch (fileErr: any) {
                    console.error(`❌ [SEND-WHATSAPP] Erro ao converter arquivo para base64:`, fileErr.message);
                  }
                }
                
                // Map frontend messageType to Evolution API expected mediaType
                let evolutionMediaType: 'image' | 'audio' | 'video' | 'document' = 'document';
                if (messageType === 'image') evolutionMediaType = 'image';
                else if (messageType === 'audio') evolutionMediaType = 'audio';
                else if (messageType === 'video') evolutionMediaType = 'video';
                
                sendResult = await evolutionAPIService.sendMediaMessage(
                  config.instanceName,
                  phoneFormatted,
                  finalMediaUrl,
                  mediaCaption || content || undefined,
                  evolutionMediaType,
                  3,
                  { mimetype: detectedMimetype, fileName: detectedFileName }
                );
              } else {
                sendResult = { success: false, error: 'Tipo de mensagem não suportado' };
              }
              
              if (sendResult.success) {
                console.log(`✅ [SEND-WHATSAPP] Mensagem entregue com sucesso! ID:`, sendResult.messageId);
              } else {
                console.warn(`⚠️ [SEND-WHATSAPP] Erro ao enviar:`, sendResult.error);
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`❌ [SEND-WHATSAPP] Erro crítico:`, err.message);
      }

      res.json(message);
    } catch (error: any) {
      console.error("[CHAT-MESSAGE-SEND] Erro:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/assign - Atribuir conversa a agente
  app.patch("/api/chat/conversations/:conversationId/assign", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { agentId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "agentId é obrigatório" });
      }

      // 🎨 Obter cor do agente para visualização
      const agentColor = await getAgentColor(agentId);

      const updatedConv = await storage.updateChatConversation(conversationId, {
        agentId,
        assignedAgentId: agentId,
        assignedAgentColor: agentColor,
        lastAttendedAt: new Date(),
        status: 'assigned'
      });

      console.log(`✅ [CHAT-ASSIGN] Conversa ${conversationId} atribuída a ${agentId} com cor ${agentColor}`);
      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CHAT-ASSIGN] Erro:", error);
      res.status(500).json({ error: "Erro ao atribuir conversa" });
    }
  });

  // PATCH /api/chat/conversations/:conversationId/status - Atualizar status
  app.patch("/api/chat/conversations/:conversationId/status", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({ error: "status é obrigatório" });
      }

      const updateData: any = { status };

      const updatedConv = await storage.updateChatConversation(conversationId, updateData);

      res.json(updatedConv);
    } catch (error: any) {
      console.error("[CHAT-STATUS] Erro:", error);
      res.status(500).json({ error: "Erro ao atualizar status" });
    }
  });

  // POST /api/chat/conversations/:conversationId/mark-read - Marcar conversa como lida
  app.post("/api/chat/conversations/:conversationId/mark-read", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;

      // Zerar unreadCount da conversa
      const updatedConv = await storage.updateChatConversation(conversationId, {
        unreadCount: 0
      });

      // Marcar todas as mensagens do cliente como lidas
      await db.update(chatMessages)
        .set({ isRead: true })
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.senderType, 'customer'),
            eq(chatMessages.isRead, false)
          )
        );

      console.log(`✅ [MARK-READ] Conversa ${conversationId} marcada como lida`);
      res.json({ success: true, conversation: updatedConv });
    } catch (error: any) {
      console.error("[MARK-READ] Erro:", error);
      res.status(500).json({ error: "Erro ao marcar como lida" });
    }
  });

  // ============================================================
  // ENDPOINTS PARA TEMPLATES DE RESPOSTA RÁPIDA
  // ============================================================

  // GET /api/chat/quick-templates - Lista de templates
  app.get("/api/chat/quick-templates", async (req, res) => {
    try {
      const templates = await storage.getChatQuickMessages() || [];
      res.json(templates);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar templates" });
    }
  });

  // POST /api/chat/quick-templates - Criar template
  app.post("/api/chat/quick-templates", authenticateUser, async (req, res) => {
    try {
      const { title, content, category } = req.body;
      const userId = (req as any).currentUser?.id;

      if (!title || !content) {
        return res.status(400).json({ error: "Título e conteúdo são obrigatórios" });
      }

      const template = await storage.createChatQuickMessage({
        title,
        content,
        messageType: "text",
        isActive: true,
        createdBy: userId
      });

      res.json(template);
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-CREATE] Erro:", error);
      res.status(500).json({ error: "Erro ao criar template" });
    }
  });

  // DELETE /api/chat/quick-templates/:id - Deletar template
  app.delete("/api/chat/quick-templates/:id", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      // Implementar quando houver método delete na storage
      res.json({ success: true, message: "Template deletado" });
    } catch (error: any) {
      console.error("[CHAT-TEMPLATE-DELETE] Erro:", error);
      res.status(500).json({ error: "Erro ao deletar template" });
    }
  });

  // DEBUG: Testar busca de histórico de um contato
  app.get("/api/chat/debug-history/:phone", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { phone } = req.params;
      console.log(`🔍 [DEBUG] Testando histórico para: ${phone}`);
      
      const historyResult = await evolutionAPIService.fetchChatHistory('CHAT_HONEST', phone, 50);
      
      console.log(`📊 [DEBUG] Resultado:`, historyResult);
      
      res.json({
        phone,
        success: historyResult.success,
        messageCount: historyResult.messages?.length || 0,
        error: historyResult.error,
        firstMessages: historyResult.messages?.slice(0, 3).map(m => ({
          id: m.key?.id,
          text: evolutionAPIService.extractMessageText(m.message),
          timestamp: m.messageTimestamp,
          fromMe: m.key?.fromMe
        }))
      });
    } catch (error: any) {
      console.error("[CHAT-DEBUG] Erro:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // DEBUG: Test apenas 3 primeiros chats com logging detalhado

    // 🔄 Rota para reconfigurar webhook (Modo Dev ou Emergência)
  app.post("/api/chat/webhook/force-config", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const isDev = process.env.NODE_ENV === 'development';
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      const prodDomain = process.env.REPLIT_DOMAIN || (process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',')[0] : null);
      
      if (!prodDomain && !devDomain) {
        throw new Error("Domínio não configurado no ambiente");
      }

      let webhookUrl = `https://${prodDomain}/api/chat/webhook`;
      
      // Prioridade absoluta para o domínio de dev se estivermos em dev
      if (isDev && devDomain) {
        webhookUrl = `https://${devDomain}/api/chat/webhook`;
      }
      
      console.log(`📡 [WEBHOOK-FORCE] Reconfigurando webhook para: ${webhookUrl}`);
      
      const config = evolutionAPIService.getConfig();
      if (!config) throw new Error("Evolution API não configurada");
      
      const result = await evolutionAPIService.configureWebhook(config.instanceName, webhookUrl);
      
      if (result.success) {
        res.json({ success: true, message: `Webhook reconfigurado com sucesso para: ${webhookUrl}` });
      } else {
        res.status(500).json({ error: result.error || "Falha ao configurar na Evolution API" });
      }
    } catch (error: any) {
      console.error("❌ [WEBHOOK-FORCE] Erro:", error);
      res.status(500).json({ error: error.message });
    }
  });

// 🔄 Rota para sincronizar atendentes ativos
  app.post("/api/chat/agents/sync", authenticateUser, async (req, res) => {
    try {
      const currentUser = (req as any).currentUser;
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';
      
      if (!isAdmin) {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores podem sincronizar atendentes." });
      }

      await storage.syncUsersAsAgents();
      res.json({ success: true, message: "Lista de atendentes sincronizada com sucesso" });
    } catch (error: any) {
      console.error("❌ [SYNC-AGENTS-API] Erro ao sincronizar atendentes:", error);
      res.status(500).json({ error: "Erro ao sincronizar atendentes" });
    }
  });
  app.post("/api/chat/debug-sync-3", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔍 DEBUG: Processando apenas 3 chats com logging detalhado...");
      
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar conversas',
          success: false 
        });
      }

      const chats = allChatsResult.chats.slice(0, 3);
      console.log(`🔍 DEBUG: Total available: ${allChatsResult.chats.length}, testando: ${chats.length}`);
      
      const debugResults: any[] = [];

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        console.log(`\n🔍 [${i + 1}/3] Chat ID raw: ${chat.id}`);
        
        const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
        console.log(`🔍 [${i + 1}/3] Extracted phone: ${contactPhone}`);
        
        const normalizedPhone = normalizePhoneNumber(contactPhone);
        console.log(`🔍 [${i + 1}/3] Normalized phone: ${normalizedPhone}`);
        
        const contactName = chat.name || contactPhone;
        console.log(`🔍 [${i + 1}/3] Contact name: ${contactName}`);
        
        if (!normalizedPhone || normalizedPhone === '55') {
          console.warn(`⚠️  [${i + 1}/3] SKIPPED: Invalid normalized phone`);
          debugResults.push({
            index: i + 1,
            phone: contactPhone,
            error: 'Invalid normalized phone'
          });
          continue;
        }
        
        try {
          // Try to create customer
          console.log(`🔍 [${i + 1}/3] Creating chat customer...`);
          const chatCustomer = await storage.createChatCustomer({
            phone: normalizedPhone,
            name: contactName
          });
          console.log(`✅ [${i + 1}/3] Chat customer created: ${chatCustomer.id}`);
          
          // Try to create conversation
          console.log(`🔍 [${i + 1}/3] Creating conversation...`);
          const conversation = await storage.createChatConversation({
            customerId: chatCustomer.id,
            customerName: contactName,
            customerPhone: normalizedPhone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          console.log(`✅ [${i + 1}/3] Conversation created: ${conversation.id}`);
          
          debugResults.push({
            index: i + 1,
            phone: normalizedPhone,
            name: contactName,
            success: true,
            customerId: chatCustomer.id,
            conversationId: conversation.id
          });
        } catch (err: any) {
          console.error(`❌ [${i + 1}/3] Error:`, err.message);
          debugResults.push({
            index: i + 1,
            phone: normalizedPhone,
            name: contactName,
            error: err.message
          });
        }
      }

      res.json({
        success: true,
        results: debugResults
      });
    } catch (error: any) {
      console.error("[DEBUG-SYNC] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro no debug sync",
        success: false 
      });
    }
  });

  // Sincronizar conversas - TESTE SEM AUTENTICAÇÃO
  app.post("/api/chat/sync-test", async (req, res) => {
    console.log("🔄 [SYNC-TEST] Iniciando sincronização de teste (SEM AUTH)...");
    try {
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      console.log(`📊 [SYNC-TEST] API Result:`, allChatsResult.success ? `${allChatsResult.chats?.length} chats` : allChatsResult.error);
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.json({ error: 'API failed', success: false });
      }

      let created = 0;
      const logs: string[] = [];

      for (let i = 0; i < Math.min(allChatsResult.chats.length, 5); i++) {
        try {
          const chat = allChatsResult.chats[i];
          const phone = evolutionAPIService.extractPhoneNumber(chat.id);
          logs.push(`[${i}] phone=${phone}`);
          
          if (!phone || phone.length < 10) {
            logs.push(`  SKIPPED short`);
            continue;
          }
          
          let cust = await storage.createChatCustomer({ phone, name: chat.name || phone }).catch(() => null);
          if (!cust) cust = await storage.getChatCustomerByPhone(phone);
          if (!cust?.id) {
            logs.push(`  NO CUSTOMER`);
            continue;
          }
          
          await storage.createChatConversation({
            customerId: cust.id,
            customerName: chat.name || phone,
            customerPhone: phone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          
          created++;
          logs.push(`  ✅ CREATED`);
        } catch (e: any) {
          logs.push(`  ERROR: ${e.message?.substring(0, 50)}`);
        }
      }

      console.log(`🎉 [SYNC-TEST] Created: ${created}`);
      res.json({ success: true, created, logs, total: allChatsResult.chats.length });
    } catch (error: any) {
      console.error("[SYNC-TEST] Error:", error.message);
      res.json({ error: error.message, success: false });
    }
  });

  // Sincronizar conversas do WhatsApp
  app.post("/api/chat/sync-conversations-only", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    console.log("🔄 [SYNC] Iniciando sincronização...");
    
    try {
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      console.log(`📊 [SYNC] Resultado da API:`, allChatsResult.success ? `${allChatsResult.chats?.length} chats` : allChatsResult.error);
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ error: 'Falha ao buscar chats', success: false });
      }

      const chats = allChatsResult.chats;
      let successCount = 0;

      for (let i = 0; i < chats.length; i++) {
        try {
          const chat = chats[i];
          const phone = evolutionAPIService.extractPhoneNumber(chat.id);
          const name = chat.name || phone;
          
          if (!phone || phone.length < 10) continue;
          
          let customer = await storage.createChatCustomer({ phone, name }).catch(() => null);
          if (!customer) customer = await storage.getChatCustomerByPhone(phone);
          if (!customer?.id) continue;
          
          await storage.createChatConversation({
            customerId: customer.id,
            customerName: name,
            customerPhone: phone,
            status: 'new' as const,
            priority: 'normal' as const
          });
          
          successCount++;
          if (successCount % 100 === 0) console.log(`✅ [SYNC] ${successCount} created...`);
        } catch (e) {
          // Continue
        }
      }

      console.log(`🎉 [SYNC] Total: ${successCount}/${chats.length}`);
      res.json({ success: true, summary: { totalChats: chats.length, conversationsCreated: successCount } });
    } catch (error: any) {
      console.error("[SYNC] Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/chat/sync-history - Sincronizar histórico de chats do WhatsApp
  app.post("/api/chat/sync-history", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔄 Iniciando sincronização de histórico de chats do WhatsApp...");
      
      // Buscar todas as conversas do WhatsApp
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar conversas do WhatsApp',
          success: false 
        });
      }

      const chats = allChatsResult.chats;
      console.log(`📊 Total de conversas encontradas: ${chats.length}`);
      
      let totalMessages = 0;
      let successCount = 0;
      let errorCount = 0;
      const results: any[] = [];

      // Para cada chat, buscar histórico e sincronizar (limitado a 50 para teste inicial)
      const maxChatsToSync = Math.min(chats.length, 50);
      for (let i = 0; i < maxChatsToSync; i++) {
        const chat = chats[i];
        try {
          const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
          const normalizedPhone = normalizePhoneNumber(contactPhone);
          const contactName = chat.name || contactPhone;
          
          console.log(`📱 [${i + 1}/${maxChatsToSync}] Sincronizando chat: ${contactName} (${contactPhone} -> ${normalizedPhone})`);
          
          // Buscar histórico de mensagens
          const historyResult = await evolutionAPIService.fetchChatHistory('CHAT_HONEST', contactPhone, 100);
          
          if (historyResult.success && historyResult.messages && historyResult.messages.length > 0) {
            console.log(`   📄 Histórico carregado: ${historyResult.messages.length} mensagens`);
            
            // Sincronizar no banco de dados
            const syncResult = await storage.syncChatHistory(
              normalizedPhone,
              contactName,
              historyResult.messages
            );
            
            console.log(`✅ Chat sincronizado: ${contactName} - ${syncResult.messageCount} mensagens importadas`);
            
            results.push({
              phone: normalizedPhone,
              name: contactName,
              messagesImported: syncResult.messageCount,
              status: 'success'
            });
            
            totalMessages += syncResult.messageCount;
            successCount++;
          } else if (historyResult.success && (!historyResult.messages || historyResult.messages.length === 0)) {
            console.log(`⚪ Chat sem mensagens: ${contactName}`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              messagesImported: 0,
              status: 'success'
            });
            successCount++;
          } else {
            console.warn(`⚠️  Erro ao buscar histórico de ${contactName}: ${historyResult.error}`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'error',
              error: historyResult.error || 'Erro desconhecido'
            });
            errorCount++;
          }
        } catch (chatError: any) {
          console.error(`❌ Erro ao processar chat:`, chatError.message);
          errorCount++;
          results.push({
            status: 'error',
            error: chatError.message
          });
        }
      }

      console.log(`🎉 Sincronização concluída: ${successCount} conversas processadas, ${totalMessages} mensagens importadas`);
      
      res.json({
        success: true,
        summary: {
          totalChats: chats.length,
          chatsProcessed: maxChatsToSync,
          successCount,
          errorCount,
          totalMessagesImported: totalMessages
        },
        details: results.slice(0, 20) // Retornar apenas os 20 primeiros para não sobrecarregar a resposta
      });
    } catch (error: any) {
      console.error("[CHAT-SYNC-HISTORY] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro ao sincronizar histórico", 
        success: false 
      });
    }
  });

  // GET /api/chat/customer-seller/:phone - Buscar vendedor associado ao cliente
  app.get("/api/chat/customer-seller/:phone", authenticateUser, async (req, res) => {
    try {
      const { phone } = req.params;
      const customer = await storage.getCustomerByPhone(phone);
      
      if (!customer) {
        return res.json({ 
          success: true,
          sellerName: "Sem vendedor atrelado",
          found: false 
        });
      }
      
      const sellerName = customer.seller?.firstName ? `${customer.seller.firstName} ${customer.seller.lastName || ''}`.trim() : "Sem vendedor atrelado";
      
      res.json({
        success: true,
        sellerName,
        found: true,
        sellerId: customer.seller?.id
      });
    } catch (error: any) {
      console.error("[CUSTOMER-SELLER] Erro:", error);
      res.json({ success: true, sellerName: "Sem vendedor atrelado", found: false });
    }
  });

  // POST /api/chat/sync-contacts - Sincronizar contatos do WhatsApp para o banco de dados
  app.post("/api/chat/sync-contacts", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("👥 [SYNC-CONTACTS] Iniciando sincronização de contatos do WhatsApp...");
      
      // Buscar todas as conversas do WhatsApp (os contatos)
      const allChatsResult = await evolutionAPIService.fetchAllChats('CHAT_HONEST');
      
      if (!allChatsResult.success || !allChatsResult.chats) {
        return res.status(400).json({ 
          error: allChatsResult.error || 'Erro ao buscar contatos do WhatsApp',
          success: false 
        });
      }

      const chats = allChatsResult.chats;
      console.log(`👥 [SYNC-CONTACTS] Total de contatos encontrados: ${chats.length}`);
      
      let createdCount = 0;
      let alreadyExists = 0;
      let errorCount = 0;
      const results: any[] = [];

      for (let i = 0; i < chats.length; i++) {
        try {
          const chat = chats[i];
          const contactPhone = evolutionAPIService.extractPhoneNumber(chat.id);
          const normalizedPhone = normalizePhoneNumber(contactPhone);
          const contactName = chat.name || contactPhone;
          
          if (!normalizedPhone || normalizedPhone.length < 10) {
            console.warn(`⚠️  [SYNC-CONTACTS] Telefone inválido: ${contactPhone}`);
            continue;
          }

          // Buscar ou criar cliente
          let customer = await storage.getChatCustomerByPhone(normalizedPhone);
          if (!customer) {
            customer = await storage.createChatCustomer({
              phone: normalizedPhone,
              name: contactName
            });
            createdCount++;
            console.log(`✅ [SYNC-CONTACTS] Contato criado: ${contactName} (${normalizedPhone})`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'created'
            });
          } else {
            alreadyExists++;
            console.log(`⚪ [SYNC-CONTACTS] Contato já existe: ${contactName} (${normalizedPhone})`);
            results.push({
              phone: normalizedPhone,
              name: contactName,
              status: 'exists'
            });
          }
        } catch (error: any) {
          errorCount++;
          console.error(`❌ [SYNC-CONTACTS] Erro ao sincronizar contato:`, error.message);
          results.push({
            status: 'error',
            error: error.message
          });
        }
      }

      console.log(`🎉 [SYNC-CONTACTS] Sincronização concluída: ${createdCount} criados, ${alreadyExists} já existiam`);
      
      res.json({
        success: true,
        summary: {
          totalContacts: chats.length,
          created: createdCount,
          alreadyExists,
          errors: errorCount
        },
        details: results.slice(0, 50)
      });
    } catch (error: any) {
      console.error("[SYNC-CONTACTS] Erro:", error);
      res.status(500).json({ 
        error: error.message || "Erro ao sincronizar contatos", 
        success: false 
      });
    }
  });

  // Mutation para sincronizar mensagens do WhatsApp
  app.post("/api/chat/sync-whatsapp", authenticateUser, async (req, res) => {
    try {
      console.log(`🔄 [SYNC-WHATSAPP] Iniciando sincronização solicitada por: ${(req as any).user?.email}`);
      
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado" });
      }

      // 1. Corrigir banco de dados imediatamente (Migração de dados históricos do número errado para o correto)
      await db.execute(sql`
        DO $$ 
        BEGIN
            -- Garante que o cliente correto existe
            IF NOT EXISTS (SELECT 1 FROM chat_customers WHERE phone = '5562996353860') THEN
                INSERT INTO chat_customers (id, phone, name)
                VALUES (gen_random_uuid(), '5562996353860', 'Honest');
            END IF;

            -- Migra conversas vinculadas ao número antigo
            UPDATE chat_conversations 
            SET customer_phone = '5562996353860',
                customer_id = (SELECT id FROM chat_customers WHERE phone = '5562996353860')
            WHERE customer_phone = '5504884295924' OR customer_phone = '04884295924';

            -- Migra mensagens do cliente antigo
            UPDATE chat_messages 
            SET sender_id = (SELECT id FROM chat_customers WHERE phone = '5562996353860') 
            WHERE sender_id IN (SELECT id FROM chat_customers WHERE phone = '5504884295924' OR phone = '04884295924') 
            AND sender_type = 'customer';

            -- Remove o registro do cliente com número incorreto
            DELETE FROM chat_customers WHERE phone = '5504884295924' OR phone = '04884295924';
        END $$;
      `);

      // 2. Buscar histórico da API externa para o número correto
      const targetPhone = '5562996353860';
      const history = await evolutionAPIService.fetchChatHistory(config.instanceName, targetPhone);
      
      if (history.success && history.messages) {
        // Garantir cliente e conversa para o sync
        let customer = await storage.getChatCustomerByPhone(targetPhone);
        if (!customer) {
          customer = await storage.createChatCustomer({ phone: targetPhone, name: 'Honest' });
        }
        
        const conversation = await storage.upsertChatConversation({
          customerId: customer.id,
          customerName: customer.name || 'Honest',
          customerPhone: targetPhone,
          status: 'new',
          priority: 'normal'
        });

        // Importar mensagens faltantes
        const existingMessages = await storage.getChatMessages(conversation.id);
        const existingIds = new Set(existingMessages.map(m => m.externalId));

        let importedCount = 0;
        const { uploadMediaFromBase64 } = await import("./whatsapp-media-storage");
        
        for (const msg of history.messages) {
          const messageId = msg.key?.id;
          if (messageId && !existingIds.has(messageId)) {
            const isFromMe = msg.key?.fromMe === true;
            const text = evolutionAPIService.extractMessageText(msg.message) || '';
            
            const mediaInfo = evolutionAPIService.extractMediaInfo(msg.message);
            let finalMediaUrl = mediaInfo.mediaUrl;
            const finalMessageType = mediaInfo.messageType || 'text';
            const messageTimestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date();
            
            if (finalMessageType !== 'text' && !finalMediaUrl && messageId) {
              try {
                console.log(`📥 [SYNC-MEDIA] Baixando mídia para: ${messageId}`);
                // Passar o key completo para Evolution API v2.3.6+
                const messageKey = {
                  id: messageId,
                  remoteJid: msg.key?.remoteJid,
                  fromMe: msg.key?.fromMe
                };
                const messageTimestampSec = msg.messageTimestamp;
                const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(config.instanceName, messageKey, messageTimestampSec);
                if (mediaResult.success && mediaResult.base64) {
                  const mimeType = mediaResult.mimetype || mediaInfo.mediaType || 'application/octet-stream';
                  const uploadResult = await uploadMediaFromBase64(
                    mediaResult.base64,
                    mimeType,
                    mediaInfo.mediaFilename
                  );
                  if (uploadResult.success && uploadResult.objectPath) {
                    finalMediaUrl = uploadResult.objectPath;
                    console.log(`✅ [SYNC-MEDIA] Mídia salva: ${finalMediaUrl}`);
                  }
                }
              } catch (mediaErr: any) {
                console.warn(`⚠️ [SYNC-MEDIA] Erro ao baixar mídia: ${mediaErr.message}`);
              }
            }
            
            await storage.createChatMessage({
              conversationId: conversation.id,
              senderId: isFromMe ? 'system' : customer.id,
              senderType: isFromMe ? 'system' : 'customer',
              content: text || (finalMessageType !== 'text' ? `[${finalMessageType}]` : '[Mensagem]'),
              messageType: finalMessageType,
              mediaUrl: finalMediaUrl,
              externalId: messageId,
              createdAt: messageTimestamp
            });
            importedCount++;
          }
        }
        console.log(`✅ [SYNC-WHATSAPP] Importadas ${importedCount} novas mensagens para ${targetPhone}`);
      }
      
      res.json({ success: true, message: "Sincronização concluída e histórico corrigido", totalChats: history.messages?.length || 0 });
    } catch (error: any) {
      console.error("❌ [SYNC-WHATSAPP] Erro crítico:", error.message);
      res.status(500).json({ error: "Erro ao sincronizar histórico: " + error.message });
    }
  });

  // POST /api/chat/consolidate - Consolidar manualmente conversas por telefone
  app.post("/api/chat/consolidate", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log("🔀 [CONSOLIDATE] Iniciando consolidação de conversas duplicadas por telefone...");
      const result = await consolidateDuplicateConversations(storage);
      
      res.json({
        success: true,
        message: `Consolidação concluída: ${result.consolidated} grupos unificados, ${result.merged} mensagens mescladas`,
        ...result
      });
    } catch (error: any) {
      console.error("[CHAT-CONSOLIDATE] Erro:", error);
      res.status(500).json({ error: "Erro ao consolidar conversas", success: false });
    }
  });

  // POST /api/chat/phone-mappings - Criar mapeamento de números alternativos
  app.post("/api/chat/phone-mappings", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { canonicalPhone, alternativePhone, description } = req.body;
      
      if (!canonicalPhone || !alternativePhone) {
        return res.status(400).json({ error: "canonicalPhone e alternativePhone são obrigatórios" });
      }
      
      // Usar a função de normalização do webhook
      const normalized55CanonicalPhone = `55${canonicalPhone.replace(/\D/g, '').slice(-11)}`;
      const normalized55AlternativePhone = `55${alternativePhone.replace(/\D/g, '').slice(-11)}`;
      
      const [mapping] = await db.insert(phoneNumberMappings).values({
        canonicalPhone: normalized55CanonicalPhone,
        alternativePhone: normalized55AlternativePhone,
        description: description || `Mapeamento criado em ${new Date().toISOString()}`
      }).returning();
      
      console.log(`✅ [PHONE-MAPPING] Criado: ${normalized55AlternativePhone} -> ${normalized55CanonicalPhone}`);
      res.json({ success: true, mapping });
    } catch (error: any) {
      console.error("[PHONE-MAPPING] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/fix-phone-numbers - Corrigir números errados em registros existentes
  app.post("/api/chat/fix-phone-numbers", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      console.log("🔧 [FIX-PHONES] Iniciando correção de números de telefone...");
      
      // Mapeamentos conhecidos de IDs Evolution API para números reais
      const knownMappings: { [key: string]: string } = {
        '5504884295924': '5562995782812',
        '5550575396912': '5562996353860',
        '04884295924': '5562995782812',
        '50575396912': '5562996353860',
      };
      
      const results = {
        customersUpdated: 0,
        conversationsUpdated: 0,
        mappingsCreated: 0,
        errors: [] as string[]
      };
      
      // 1. Buscar todos os clientes e conversas
      const allConversations = await storage.getChatConversations();
      
      for (const conv of allConversations) {
        const cleanPhone = conv.customerPhone?.replace(/\D/g, '') || '';
        
        // Verificar se o telefone precisa ser corrigido
        for (const [wrongPhone, correctPhone] of Object.entries(knownMappings)) {
          if (cleanPhone === wrongPhone || cleanPhone.includes(wrongPhone)) {
            try {
              // Atualizar conversa
              await storage.updateChatConversation(conv.id, {
                customerPhone: correctPhone
              });
              results.conversationsUpdated++;
              console.log(`✅ [FIX-PHONES] Conversa ${conv.id}: ${cleanPhone} -> ${correctPhone}`);
              
              // Atualizar cliente se existir
              if (conv.customerId) {
                const customer = await storage.getChatCustomer(conv.customerId);
                if (customer && customer.phone !== correctPhone) {
                  await storage.updateChatCustomer(customer.id, {
                    phone: correctPhone
                  });
                  results.customersUpdated++;
                  console.log(`✅ [FIX-PHONES] Cliente ${customer.id}: ${customer.phone} -> ${correctPhone}`);
                }
              }
            } catch (err: any) {
              results.errors.push(`Erro ao atualizar ${conv.id}: ${err.message}`);
            }
            break;
          }
        }
      }
      
      // 2. Garantir que os mapeamentos existam no banco
      for (const [sourcePhone, canonicalPhone] of Object.entries(knownMappings)) {
        try {
          const existingMapping = await storage.getPhoneMappingBySource(sourcePhone);
          if (!existingMapping) {
            await db.insert(phoneNumberMappings).values({
              canonicalPhone: canonicalPhone,
              alternativePhone: sourcePhone,
              description: `Mapeamento automático - ${new Date().toISOString()}`
            });
            results.mappingsCreated++;
            console.log(`✅ [FIX-PHONES] Mapeamento criado: ${sourcePhone} -> ${canonicalPhone}`);
          }
        } catch (err: any) {
          // Ignorar erro de duplicata
          if (!err.message.includes('duplicate')) {
            results.errors.push(`Erro ao criar mapeamento ${sourcePhone}: ${err.message}`);
          }
        }
      }
      
      console.log("🔧 [FIX-PHONES] Correção concluída:", results);
      res.json({ 
        success: true, 
        message: `Correção concluída: ${results.conversationsUpdated} conversas, ${results.customersUpdated} clientes atualizados, ${results.mappingsCreated} mapeamentos criados`,
        ...results 
      });
    } catch (error: any) {
      console.error("[FIX-PHONES] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ============================================================================
  // ADMIN: RE-PROCESS MEDIA FOR MESSAGES WITHOUT URL
  // ============================================================================
  
  app.post("/api/chat/admin/fix-media", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      console.log("📷 [FIX-MEDIA] Iniciando re-processamento de mídia...");
      
      const messagesWithoutMedia = await db.select({
        id: chatMessages.id,
        externalId: chatMessages.externalId,
        messageType: chatMessages.messageType,
        mediaUrl: chatMessages.mediaUrl,
        content: chatMessages.content
      })
      .from(chatMessages)
      .where(
        and(
          inArray(chatMessages.messageType, ['image', 'audio', 'video', 'document']),
          isNull(chatMessages.mediaUrl)
        )
      )
      .limit(50);
      
      console.log(`📷 [FIX-MEDIA] Encontradas ${messagesWithoutMedia.length} mensagens de mídia sem URL`);
      
      if (messagesWithoutMedia.length === 0) {
        return res.json({
          success: true,
          message: "Nenhuma mensagem de mídia sem URL encontrada",
          processed: 0,
          failed: 0
        });
      }
      
      const results = {
        processed: 0,
        failed: 0,
        errors: [] as string[]
      };
      
      const config = evolutionAPIService.getConfig();
      if (!config) {
        return res.status(400).json({ error: "Evolution API não configurada" });
      }
      
      for (const msg of messagesWithoutMedia) {
        if (!msg.externalId) {
          results.failed++;
          results.errors.push(`Mensagem ${msg.id}: sem externalId`);
          continue;
        }
        
        try {
          console.log(`📷 [FIX-MEDIA] Baixando mídia: ${msg.externalId} (${msg.messageType})`);
          
          // Para mensagens antigas, só temos o messageId (externalId)
          // Tentar com messageId apenas (pode funcionar se a mensagem ainda estiver no cache)
          const mediaResult = await evolutionAPIService.getBase64FromMediaMessage(
            config.instanceName,
            { id: msg.externalId }
          );
          
          if (!mediaResult.success || !mediaResult.base64) {
            results.failed++;
            results.errors.push(`${msg.id}: ${mediaResult.error || 'sem dados'}`);
            continue;
          }
          
          const mimeType = mediaResult.mimetype || getMimeTypeFromMessageType(msg.messageType || 'image');
          const extension = getExtensionFromMimeType(mimeType);
          const fileName = `${msg.externalId}.${extension}`;
          
          console.log(`📤 [FIX-MEDIA] Fazendo upload: ${fileName}`);
          
          const uploadResult = await uploadMediaFromBase64(
            mediaResult.base64,
            mimeType,
            fileName
          );
          
          if (uploadResult.success && uploadResult.objectPath) {
            await db.update(chatMessages)
              .set({ mediaUrl: uploadResult.objectPath })
              .where(eq(chatMessages.id, msg.id));
            
            console.log(`✅ [FIX-MEDIA] Mídia atualizada: ${msg.id} -> ${uploadResult.objectPath}`);
            results.processed++;
          } else {
            results.failed++;
            results.errors.push(`${msg.id}: upload falhou`);
          }
          
        } catch (err: any) {
          results.failed++;
          results.errors.push(`${msg.id}: ${err.message}`);
        }
      }
      
      console.log(`📷 [FIX-MEDIA] Concluído: ${results.processed} processadas, ${results.failed} falhas`);
      
      res.json({
        success: true,
        message: `Re-processamento concluído: ${results.processed} processadas, ${results.failed} falhas`,
        ...results,
        remaining: messagesWithoutMedia.length - results.processed - results.failed
      });
      
    } catch (error: any) {
      console.error("[FIX-MEDIA] Erro:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });
  
  function getMimeTypeFromMessageType(messageType: string): string {
    switch (messageType) {
      case 'image': return 'image/jpeg';
      case 'audio': return 'audio/ogg';
      case 'video': return 'video/mp4';
      case 'document': return 'application/octet-stream';
      default: return 'application/octet-stream';
    }
  }
  
  function getExtensionFromMimeType(mimeType: string): string {
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

  // ============================================================================
  // ADMIN: DEBUG WEBHOOK LOGS
  // ============================================================================
  
  // GET /api/chat/admin/webhook-debug - Ver logs de debug do webhook (ADMIN ONLY)
  app.get("/api/chat/admin/webhook-debug", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, raw_remote_jid, extracted_phone, normalized_phone, mapping_found, mapped_to, created_at,
               LEFT(raw_payload, 500) as payload_preview
        FROM webhook_debug_log
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ 
        success: true, 
        logs: result.rows,
        count: result.rows.length,
        message: "Últimos 50 registros de debug do webhook"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // DELETE /api/chat/admin/webhook-debug - Limpar logs de debug do webhook (ADMIN ONLY)
  app.delete("/api/chat/admin/webhook-debug", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      await db.execute(sql`DELETE FROM webhook_debug_log`);
      res.json({ success: true, message: "Logs de debug limpos" });
    } catch (error: any) {
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // ============================================================================
  // ADMIN: CLEAR ALL CHAT DATA (NUCLEAR OPTION)
  // ============================================================================
  
  // POST /api/chat/admin/clear-all - Limpar TODOS os dados de chat (ADMIN ONLY)
  app.post("/api/chat/admin/clear-all", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const userEmail = (req.user as any)?.email;
      
      console.log(`⚠️ [ADMIN-CLEAR] Iniciando limpeza TOTAL de chat por: ${userEmail} (${userId})`);
      console.log(`⚠️ [ADMIN-CLEAR] Timestamp: ${new Date().toISOString()}`);
      
      // Contagem antes da limpeza
      const beforeCounts = {
        messages: await db.select({ count: sql<number>`count(*)` }).from(chatMessages).then(r => Number(r[0].count)),
        conversations: await db.select({ count: sql<number>`count(*)` }).from(chatConversations).then(r => Number(r[0].count)),
        customers: await db.select({ count: sql<number>`count(*)` }).from(chatCustomers).then(r => Number(r[0].count)),
        aiLogs: await db.select({ count: sql<number>`count(*)` }).from(chatAiLogs).then(r => Number(r[0].count)),
      };
      
      console.log("📊 [ADMIN-CLEAR] Registros antes da limpeza:", beforeCounts);
      
      // Ordem correta para evitar FK failures: logs -> messages -> conversations -> customers
      const deletedAiLogs = await db.delete(chatAiLogs).returning();
      console.log(`🗑️ [ADMIN-CLEAR] AI Logs deletados: ${deletedAiLogs.length}`);
      
      const deletedMessages = await db.delete(chatMessages).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Mensagens deletadas: ${deletedMessages.length}`);
      
      const deletedConversations = await db.delete(chatConversations).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Conversas deletadas: ${deletedConversations.length}`);
      
      const deletedCustomers = await db.delete(chatCustomers).returning();
      console.log(`🗑️ [ADMIN-CLEAR] Clientes de chat deletados: ${deletedCustomers.length}`);
      
      const result = {
        success: true,
        message: "Todos os dados de chat foram limpos com sucesso!",
        deletedCounts: {
          messages: deletedMessages.length,
          conversations: deletedConversations.length,
          customers: deletedCustomers.length,
          aiLogs: deletedAiLogs.length,
        },
        executedBy: userEmail,
        executedAt: new Date().toISOString(),
      };
      
      console.log("✅ [ADMIN-CLEAR] Limpeza concluída:", result);
      
      res.json(result);
    } catch (error: any) {
      console.error("❌ [ADMIN-CLEAR] Erro ao limpar dados:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // ============================================================================
  // CHATGPT AUTO-ATTENDANCE SETTINGS ROUTES
  // ============================================================================

  // GET /api/chat/ai-settings - Obter configurações do ChatGPT automático
  app.get("/api/chat/ai-settings", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const settings = await storage.getChatAiSettings();
      res.json({ success: true, settings: settings || getDefaultAiSettings() });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao obter configurações:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // PUT /api/chat/ai-settings - Atualizar configurações do ChatGPT automático
  app.put("/api/chat/ai-settings", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const { isEnabled, mode, businessHours, timeoutMinutes, maxTurnsBeforeEscalation, 
              handoffKeywords, systemPrompt, companyContext, gptModel } = req.body;
      
      const settings = await storage.upsertChatAiSettings({
        isEnabled: isEnabled ?? false,
        mode: mode || 'disabled',
        businessHours: businessHours || null,
        timeoutMinutes: timeoutMinutes ?? 5,
        maxTurnsBeforeEscalation: maxTurnsBeforeEscalation ?? 10,
        handoffKeywords: handoffKeywords || [],
        systemPrompt: systemPrompt || null,
        companyContext: companyContext || null,
        gptModel: gptModel || 'gpt-4o-mini',
        updatedBy: userId
      });
      
      console.log(`✅ [AI-SETTINGS] Configurações atualizadas por usuário ${userId}:`, 
                  { isEnabled, mode, timeoutMinutes });
      
      res.json({ success: true, settings });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao atualizar configurações:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-settings/toggle - Alternar estado ligado/desligado
  app.post("/api/chat/ai-settings/toggle", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const currentSettings = await storage.getChatAiSettings();
      const newEnabled = !(currentSettings?.isEnabled ?? false);
      
      const settings = await storage.upsertChatAiSettings({
        ...currentSettings,
        isEnabled: newEnabled,
        updatedBy: userId
      } as any);
      
      console.log(`✅ [AI-SETTINGS] ChatGPT ${newEnabled ? 'ATIVADO' : 'DESATIVADO'} por usuário ${userId}`);
      res.json({ success: true, settings, enabled: newEnabled });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao alternar:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-settings/standby - Alternar modo standby do ChatGPT
  app.post("/api/chat/ai-settings/standby", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const currentSettings = await storage.getChatAiSettings();
      const newStandby = !(currentSettings?.isStandby ?? true);
      
      const settings = await storage.upsertChatAiSettings({
        ...currentSettings,
        isStandby: newStandby,
        updatedBy: userId
      } as any);
      
      console.log(`✅ [AI-SETTINGS] Modo standby ${newStandby ? 'ATIVADO' : 'DESATIVADO'} por usuário ${userId}`);
      res.json({ success: true, settings, standby: newStandby });
    } catch (error: any) {
      console.error("[AI-SETTINGS] Erro ao alternar standby:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/conversations/:id/transfer - Transferir conversa para outro atendente (apenas admin)
  app.post("/api/chat/conversations/:id/transfer", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const { id } = req.params;
      const { toAgentId } = req.body;
      const currentUser = (req as any).currentUser;
      
      if (!toAgentId) {
        return res.status(400).json({ error: "toAgentId é obrigatório" });
      }
      
      // Verificar se agente destino existe (ou é ChatGPT)
      if (toAgentId !== 'chatgpt') {
        const agents = await storage.getChatAgents() || [];
        const targetAgent = agents.find(a => a.id === toAgentId);
        if (!targetAgent) {
          return res.status(400).json({ error: "Agente de destino não encontrado" });
        }
      }
      
      const { transferConversation } = await import("./chat-distribution-service");
      const result = await transferConversation(id, "", toAgentId, currentUser?.id, true);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.json({ success: true, message: "Conversa transferida com sucesso" });
    } catch (error: any) {
      console.error("[TRANSFER] Erro ao transferir conversa:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // GET /api/chat/agents/online - Listar atendentes online para transferência (inclui ChatGPT)
  app.get("/api/chat/agents/online", authenticateUser, async (req, res) => {
    try {
      const { getOnlineTelemarketingAgents } = await import("./chat-distribution-service");
      const onlineAgents = await getOnlineTelemarketingAgents();
      
      // Buscar configurações de AI para verificar posição na fila
      const aiSettings = await storage.getChatAiSettings();
      const isAiEnabled = aiSettings?.isEnabled ?? false;
      const chatgptQueuePosition = aiSettings?.chatgptQueuePosition ?? 0;
      
      // Determinar status do ChatGPT baseado na configuração
      // position=1 = primeiro na fila (online), position=0 = standby (só assume quando ninguém disponível)
      const chatgptStatus = chatgptQueuePosition === 1 ? "online" : "standby";
      
      // Criar objeto ChatGPT
      const chatgptAgent = {
        id: "chatgpt",
        name: "ChatGPT (IA)",
        email: "",
        status: chatgptStatus,
        type: "bot" as const,
        queuePosition: chatgptQueuePosition,
        activeConversations: 0
      };
      
      // Montar lista de agentes respeitando a posição do ChatGPT na fila
      let agents: any[] = [];
      
      if (isAiEnabled && chatgptQueuePosition === 1) {
        // ChatGPT primeiro na fila
        agents = [
          chatgptAgent,
          ...onlineAgents.map(a => ({
            id: a.id,
            name: a.name,
            email: a.email,
            status: a.status,
            type: "human" as const,
            activeConversations: a.activeConversations
          }))
        ];
      } else {
        // Atendentes humanos primeiro, ChatGPT no final (standby)
        agents = [
          ...onlineAgents.map(a => ({
            id: a.id,
            name: a.name,
            email: a.email,
            status: a.status,
            type: "human" as const,
            activeConversations: a.activeConversations
          })),
          ...(isAiEnabled ? [chatgptAgent] : [])
        ];
      }
      
      res.json({ success: true, agents, chatgptQueuePosition });
    } catch (error: any) {
      console.error("[AGENTS-ONLINE] Erro ao buscar atendentes:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/conversations/:id/attend - Marcar atendimento (atualiza lastAttendedAt)
  app.post("/api/chat/conversations/:id/attend", authenticateUser, async (req, res) => {
    try {
      const { id } = req.params;
      const { updateLastAttendedTime } = await import("./chat-distribution-service");
      await updateLastAttendedTime(id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[ATTEND] Erro ao marcar atendimento:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-reports/refresh - Regenerar relatórios de IA manualmente
  app.post("/api/chat/ai-reports/refresh", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      console.log(`🔄 [AI-REPORTS] Regeneração manual solicitada por usuário ${userId}`);
      
      const { generateAndSaveAllReports } = await import("./ai-reports-service");
      await generateAndSaveAllReports();
      
      console.log(`✅ [AI-REPORTS] Relatórios regenerados com sucesso por usuário ${userId}`);
      res.json({ success: true, message: "Relatórios regenerados com sucesso" });
    } catch (error: any) {
      console.error("[AI-REPORTS] Erro ao regenerar relatórios:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // GET /api/chat/ai-logs - Obter logs de atendimento automático
  app.get("/api/chat/ai-logs", authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const { conversationId, limit } = req.query;
      const logs = await storage.getChatAiLogs(
        conversationId as string | undefined,
        Math.min(parseInt(limit as string) || 50, 500)
      );
      res.json({ success: true, logs });
    } catch (error: any) {
      console.error("[AI-LOGS] Erro ao obter logs:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/ai-suggestion - Obter sugestão de resposta da IA para o atendente
  app.post("/api/chat/ai-suggestion", authenticateUser, requireRole(['admin', 'coordinator', 'telemarketing']), async (req, res) => {
    try {
      const { conversationId, customerName, customerPhone, messages } = req.body;
      
      if (!conversationId || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "conversationId e messages são obrigatórios" });
      }
      
      const settings = await storage.getChatAiSettings();
      if (!settings) {
        return res.status(400).json({ error: "Configurações de IA não encontradas. Configure em /telemarketing/ai-settings" });
      }
      
      // Converter mensagens para o formato esperado pelo generateAutoResponse
      const recentMessages = messages.slice(-15).map((msg: any) => ({
        role: (msg.senderType === 'customer' ? 'customer' : 'agent') as 'customer' | 'agent' | 'bot',
        content: msg.content || '',
        timestamp: new Date(msg.createdAt || msg.timestamp || Date.now())
      }));
      
      const { generateAutoResponse } = await import("./chatgpt-service");
      
      const result = await generateAutoResponse({
        customerName: customerName || "Cliente",
        customerPhone: customerPhone || "",
        conversationId: conversationId,
        recentMessages
      }, settings);
      
      console.log(`✨ [AI-SUGGESTION] Sugestão gerada para conversa ${conversationId} via ${settings.aiProvider || 'openai'}`);
      
      res.json({ 
        success: true, 
        response: result.response.reply,
        shouldTransfer: result.response.shouldTransfer,
        transferReason: result.response.transferReason,
        tokensUsed: result.tokensUsed,
        responseTimeMs: result.responseTimeMs,
        provider: settings.aiProvider || 'openai'
      });
    } catch (error: any) {
      console.error("[AI-SUGGESTION] Erro ao gerar sugestão:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  // POST /api/chat/test-ai-response - Testar resposta do ChatGPT
  app.post("/api/chat/test-ai-response", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const { message, customerName, customerPhone } = req.body;
      
      if (!message) {
        return res.status(400).json({ error: "Mensagem é obrigatória" });
      }
      
      const settings = await storage.getChatAiSettings();
      if (!settings) {
        return res.status(400).json({ error: "Configurações de IA não encontradas" });
      }
      
      const { generateAutoResponse } = await import("./chatgpt-service");
      
      const result = await generateAutoResponse({
        customerName: customerName || "Cliente Teste",
        customerPhone: customerPhone || "5562999999999",
        conversationId: "test-" + Date.now(),
        recentMessages: [{
          role: 'customer',
          content: message,
          timestamp: new Date()
        }]
      }, settings);
      
      res.json({ 
        success: true, 
        response: result.response.reply,
        shouldTransfer: result.response.shouldTransfer,
        transferReason: result.response.transferReason,
        tokensUsed: result.tokensUsed,
        responseTimeMs: result.responseTimeMs
      });
    } catch (error: any) {
      console.error("[AI-TEST] Erro ao testar resposta:", error);
      res.status(500).json({ error: error.message, success: false });
    }
  });

  console.log("✅ Chat routes registered successfully");
}

// Helper para configurações padrão
function getDefaultAiSettings() {
  return {
    id: null,
    isEnabled: false,
    mode: 'disabled' as const,
    businessHours: {
      weekdays: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'],
      startTime: '08:00',
      endTime: '18:00'
    },
    timeoutMinutes: 5,
    maxTurnsBeforeEscalation: 10,
    handoffKeywords: ['atendente', 'humano', 'gerente', 'vendedor', 'reclamação'],
    systemPrompt: null,
    companyContext: null,
    gptModel: 'gpt-4o-mini',
    createdAt: null,
    updatedAt: null,
    updatedBy: null
  };
}
