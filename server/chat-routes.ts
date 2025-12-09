import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { whatsappService } from "./whatsapp-service";
import { telegramService } from "./telegram-service";
import { evolutionAPIService } from "./evolution-api-service";
import {
  insertChatAgentSchema,
  insertChatConversationSchema,
  insertChatMessageSchema,
  insertChatProductSchema,
  insertChatQuickMessageSchema,
  insertChatOrderSchema,
  insertChatDeliverySchema,
  insertWhatsappConversationAnalysisSchema,
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
  
  // Remove tudo que não é dígito
  let digitsOnly = phone.replace(/\D/g, '');
  console.log(`📞 [NORMALIZE] Input: ${phone} -> Digits: ${digitsOnly} (length: ${digitsOnly.length})`);
  
  // Se começar com 55, remove para recalcular
  if (digitsOnly.startsWith('55')) {
    digitsOnly = digitsOnly.slice(2);
  }
  
  // Remover dígitos EXTRAS à esquerda (não tomar os últimos 11)
  // O Brasil usa 11 dígitos (DDD + número), não take arbitrariamente
  if (digitsOnly.length > 11) {
    console.log(`📞 [NORMALIZE] Telefone com ${digitsOnly.length} dígitos, cortando extras da esquerda`);
    digitsOnly = digitsOnly.slice(digitsOnly.length - 11); // Pega os 11 últimos sem perder dados críticos
  }
  
  // Garante exatamente 11 dígitos - ADICIONA 9 SE FALTAR
  // Formato: 55 + DDD(2) + 9 + número(8) = 55 + 11 dígitos
  if (digitsOnly.length === 10) {
    // DDD + número sem o 9 -> adicionar 9 após DDD
    const ddd = digitsOnly.slice(0, 2);
    const number = digitsOnly.slice(2);
    digitsOnly = `${ddd}9${number}`;
    console.log(`📞 [NORMALIZE] Telefone com 10 dígitos (sem 9). Adicionado 9: ${digitsOnly}`);
  }
  
  // Garante exatamente 11 dígitos
  const normalized = `55${digitsOnly}`;
  
  console.log(`📞 [NORMALIZE] Output: ${normalized} (length: ${normalized.length})`);
  return normalized;
}

// 🔧 FUNÇÃO PARA ENCONTRAR CONVERSA COM NÚMERO "SIMILAR" (COM/SEM 9)
function getPhoneVariants(normalizedPhone: string): string[] {
  // Retorna variações do telefone (com/sem o 9 obrigatório)
  const variants = [normalizedPhone];
  
  // Se tem 13 dígitos (55 + 11): tentar remover o 9
  if (normalizedPhone.length === 13 && normalizedPhone.startsWith('55')) {
    const withoutNine = normalizedPhone.slice(0, 3) + normalizedPhone.slice(4); // Remove o 9
    if (!variants.includes(withoutNine)) {
      variants.push(withoutNine);
      console.log(`📞 [VARIANTS] ${normalizedPhone} -> Variantes: [${variants.join(', ')}]`);
    }
  }
  
  return variants;
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
    },
    fileFilter: (req, file, cb) => {
      // Accept images, audio, video, and documents
      const allowedMimes = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "audio/mpeg",
        "audio/ogg",
        "audio/wav",
        "audio/mp4",
        "video/mp4",
        "video/mpeg",
        "video/quicktime",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ];

      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}`));
      }
    },
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
  // CHAT CONVERSATIONS CRUD
  // ============================================================

  // Get all conversations - REMOVIDO: use o endpoint sem autenticação na linha 860
  /*
  app.get("/api/chat/conversations", authenticateUser, async (req, res) => {
    try {
      const { status, agentId } = req.query;
      
      let conversations = await storage.getChatConversations();
      
      // Filter on the server side
      if (status) {
        conversations = conversations.filter(c => c.status === status);
      }
      if (agentId) {
        conversations = conversations.filter(c => c.agentId === agentId);
      }
      
      res.json(conversations);
    } catch (error) {
      console.error("[CHAT] Get conversations error:", error);
      res.status(500).json({ error: "Erro ao buscar conversas" });
    }
  });
  */

  // Create conversation - comentado em favor do endpoint sem autenticação
  /*
  app.post("/api/chat/conversations", authenticateUser, async (req, res) => {
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
  */

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
            return res.json(message); // Still return success, message saved to DB
          }
          
          const config = {
            instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST',
            apiUrl: process.env.EVOLUTION_API_BASE_URL || 'https://api.bothonest.com.br',
            apiKey: process.env.EVOLUTION_API_KEY || ''
          };
          
          if (!config.apiKey) {
            console.warn(`⚠️  [CHAT-MESSAGE] Evolution API não configurada`);
            return res.json(message);
          }
          
          console.log(`📱 [CHAT-MESSAGE] Telefone do cliente: ${conversation.customerPhone}, Tipo: ${typeof conversation.customerPhone}`);
          console.log(`📱 [CHAT-MESSAGE] Instância: ${config.instanceName}, URL: ${config.apiUrl}`);
          
          const sendResult = await evolutionAPIService.sendTextMessage(
            config.instanceName,
            conversation.customerPhone,
            message.content
          );
          
          if (sendResult.success) {
            console.log(`✅ [CHAT-MESSAGE] Mensagem entregue via WhatsApp! ID:`, sendResult.messageId);
          } else {
            console.warn(`⚠️  [CHAT-MESSAGE] Erro ao enviar via WhatsApp:`, sendResult.error);
            // Still return success to user - message is saved
          }
        } catch (sendError: any) {
          console.error(`❌ [CHAT-MESSAGE] Erro ao enviar mensagem:`, sendError.message);
          // Don't fail the request - message is already saved
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
    try {
      let { event, instance, data } = req.body;
      
      // Debug: Log COMPLETO para diagnóstico
      console.log(`\n📬 [WEBHOOK-MIRROR] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📬 [WEBHOOK-MIRROR] Evento: ${event} | Instância: ${instance}`);
      console.log(`📬 [WEBHOOK-MIRROR] Payload:`, JSON.stringify(req.body, null, 2).substring(0, 800));
      
      // Suportar múltiplos formatos de webhook (Evolution API pode enviar de diferentes formas)
      if (!event && req.body.webhook?.event) {
        event = req.body.webhook.event;
        instance = req.body.webhook.instance;
        data = req.body.webhook.data;
        console.log(`📬 [WEBHOOK-MIRROR] Detectado formato aninhado: evento=${event}`);
      }
      
      // Aceitar múltiplos tipos de eventos de mensagem
      const messageEvents = [
        'messages.upsert', 'MESSAGES_UPSERT',
        'send.message', 'SEND_MESSAGE', 
        'message.create', 'MESSAGE_CREATE',
        'messages.set', 'MESSAGES_SET',
        'messages.edited', 'MESSAGES_EDITED'
      ];
      
      if (!event) {
        console.warn(`⚠️  [WEBHOOK-MIRROR] Evento não identificado no payload`);
        console.log(`📬 [WEBHOOK-MIRROR] Keys no body:`, Object.keys(req.body));
        return res.json({ received: false, reason: 'Evento não identificado' });
      }
      
      if (!messageEvents.includes(event)) {
        console.log(`⏭️  [WEBHOOK-MIRROR] Evento não é de mensagem: ${event}`);
        return res.json({ received: false, reason: `Evento ${event} não é de mensagem` });
      }

      if (!data || !data.key) {
        console.warn(`⚠️  [WEBHOOK-MIRROR] Dados inválidos recebidos`);
        console.log(`📬 [WEBHOOK-MIRROR] data exist: ${!!data}, key exist: ${data?.key ? 'sim' : 'não'}`);
        return res.json({ received: false, reason: 'Dados inválidos' });
      }

      // Extrair informações da mensagem
      const rawRemoteJid = data.key.remoteJid;
      console.log(`🔍🔍🔍 [PHONE-DEBUG-CRITICAL] RemoteJid RAW EXATO: "${rawRemoteJid}"`);
      console.log(`🔍 [PHONE-DEBUG] RemoteJid tipo: ${typeof rawRemoteJid}, length: ${String(rawRemoteJid).length}`);
      console.log(`🔍 [PHONE-DEBUG] RemoteJid completo JSON: ${JSON.stringify(data.key)}`);  
      
      const phoneNumber = evolutionAPIService.extractPhoneNumber(rawRemoteJid);
      console.log(`🔍 [PHONE-DEBUG] PhoneNumber após extract: ${phoneNumber} (length: ${phoneNumber.length})`);
      
      const messageText = evolutionAPIService.extractMessageText(data.message);
      const isFromMe = data.key.fromMe === true; // Mensagem enviada PELO número WhatsApp (celular ou sistema)
      const messageId = data.key.id;
      const timestamp = data.messageTimestamp || Math.floor(Date.now() / 1000);
      const pushName = data.pushName || '';

      console.log(`📱 [WEBHOOK-MIRROR] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📱 [WEBHOOK-MIRROR] RemoteJid RAW: ${rawRemoteJid}`);
      console.log(`📱 [WEBHOOK-MIRROR] PhoneNumber após extract: ${phoneNumber}`);
      console.log(`📱 [WEBHOOK-MIRROR] IsFromMe: ${isFromMe}`);
      console.log(`📱 [WEBHOOK-MIRROR] Direção: ${isFromMe ? '📤 ENVIADA (celular/sistema)' : '📥 RECEBIDA (cliente)'}`);
      console.log(`📱 [WEBHOOK-MIRROR] Texto: ${messageText?.substring(0, 100) || '(sem texto)'}`);
      console.log(`📱 [WEBHOOK-MIRROR] MessageId: ${messageId}`);
      console.log(`📱 [WEBHOOK-MIRROR] PushName: ${pushName}`);
      console.log(`📱 [WEBHOOK-MIRROR] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // 🪞 ESPELHO COMPLETO: Processar TODAS as mensagens (enviadas E recebidas)
      // Inclui mensagens de texto, mídia, voz, stickers, etc.
      if (phoneNumber) {
        try {
          // Normalizar telefone
          console.log(`📞 [NORMALIZE-START] Input para normalização: ${phoneNumber} (length: ${phoneNumber.length})`);
          let normalizedPhone = normalizePhoneNumber(phoneNumber);
          console.log(`📞 [NORMALIZE-END] Telefone normalizado: ${normalizedPhone} (length: ${normalizedPhone.length})`);

          // Buscar ou criar cliente (o "outro lado" da conversa)
          let customer = await storage.getChatCustomerByPhone(normalizedPhone);
          let matchingConv: any = null;
          
          if (!customer) {
            // ⚠️ Cliente não encontrado pelo normalizedPhone
            // Tentar variantes (com/sem 9)
            const phoneVariants = getPhoneVariants(normalizedPhone);
            for (const variant of phoneVariants) {
              if (variant !== normalizedPhone) {
                console.log(`📞 [WEBHOOK-MIRROR] Tentando variante: ${variant}`);
                customer = await storage.getChatCustomerByPhone(variant);
                if (customer) {
                  console.log(`✅ [WEBHOOK-MIRROR] Cliente encontrado com variante! ${variant}`);
                  normalizedPhone = variant; // Usar a variante encontrada
                  break;
                }
              }
            }
            
            if (!customer && !isFromMe) {
              console.log(`⚠️  [WEBHOOK-MIRROR] Cliente ${normalizedPhone} não encontrado. Procurando conversa ativa com nossas mensagens...`);
              try {
                const allConversations = await storage.getChatConversations();
                // Ordenar por mais recente (updated)
                const sortedConvs = allConversations.sort((a: any, b: any) => 
                  new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
                );
                
                console.log(`📋 [WEBHOOK-MIRROR] Buscando entre ${sortedConvs.length} conversas...`);
                
                // Usar a conversa MAIS RECENTE onde enviamos mensagens
                // Também verificar se o telefone é uma variante similar
                for (const conv of sortedConvs) {
                  const convPhone = conv.customerPhone;
                  const convPhoneVariants = getPhoneVariants(convPhone);
                  
                  // Verificar se normalizedPhone é uma variante do telefone da conversa
                  if (convPhoneVariants.includes(normalizedPhone)) {
                    console.log(`✅ [WEBHOOK-MIRROR] REUTILIZANDO CONVERSA! ${convPhone} <- Variante: ${normalizedPhone}`);
                    console.log(`📞 [WEBHOOK-MIRROR] Mapeamento fuzzy: ${normalizedPhone} → ${convPhone} (mesma pessoa)`);
                    matchingConv = conv;
                    customer = await storage.getChatCustomer(conv.customerId);
                    normalizedPhone = convPhone; // Usar o número original da conversa
                    break; // SEMPRE usar a primeira encontrada (mais recente)
                  }
                  
                  const convMessages = await storage.getChatMessages(conv.id);
                  const hasOurMessage = convMessages.some((m: any) => m.senderType === 'agent');
                  
                  if (hasOurMessage) {
                    console.log(`✅ [WEBHOOK-MIRROR] REUTILIZANDO CONVERSA! ${convPhone} -> Novo número: ${normalizedPhone}`);
                    console.log(`📞 [WEBHOOK-MIRROR] Mapeamento: ${normalizedPhone} → ${convPhone}`);
                    matchingConv = conv;
                    customer = await storage.getChatCustomer(conv.customerId);
                    normalizedPhone = convPhone; // Usar o número original da conversa
                    break; // SEMPRE usar a primeira encontrada (mais recente)
                  }
                }
              } catch (err) {
                console.warn(`⚠️  [WEBHOOK-MIRROR] Erro ao procurar conversa ativa:`, err);
              }
            }
            
            // Se ainda não encontrou conversa, criar novo cliente
            if (!matchingConv) {
              const customerName = !isFromMe && pushName ? pushName : `Cliente ${normalizedPhone}`;
              console.log(`👤 [WEBHOOK-MIRROR] Criando novo cliente: phone=${normalizedPhone}, name=${customerName}`);
              try {
                customer = await storage.createChatCustomer({
                  phone: normalizedPhone,
                  name: customerName
                });
                console.log(`✅ [WEBHOOK-MIRROR] Cliente criado: ${customer.id} - ${customerName}`);
              } catch (createError: any) {
                console.error(`❌ [WEBHOOK-MIRROR] ERRO ao criar cliente:`, createError.message);
                throw createError;
              }
            }
          } else if (!isFromMe && pushName && customer.name?.startsWith('Cliente ')) {
            // Atualizar nome do cliente se recebemos pushName e o nome atual é genérico
            await storage.updateChatCustomer(customer.id, { name: pushName });
            console.log(`✅ [WEBHOOK-MIRROR] Nome do cliente atualizado: ${pushName}`);
          }

          // Buscar ou criar conversa (com UPSERT para evitar duplicatas)
          if (!matchingConv) {
            console.log(`💭 [WEBHOOK-MIRROR] Criando conversa para cliente ${customer!.id}...`);
            try {
              matchingConv = await storage.upsertChatConversation({
                customerId: customer!.id,
                customerName: customer!.name || `Cliente ${normalizedPhone}`,
                customerPhone: normalizedPhone,
                status: 'new' as const,
                priority: 'normal' as const
              });
              console.log(`✅ [WEBHOOK-MIRROR] Conversa criada/atualizada: ${matchingConv.id}`);
            } catch (convError: any) {
              console.error(`❌ [WEBHOOK-MIRROR] ERRO ao criar/atualizar conversa:`, convError.message);
              throw convError;
            }
          } else {
            console.log(`✅ [WEBHOOK-MIRROR] Conversa reutilizada: ${matchingConv.id}`);
          }

          // Determinar tipo de mensagem e conteúdo
          let finalContent = messageText || '';
          let finalMessageType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' = 'text';
          let mediaUrl: string | undefined;
          
          // Detectar tipo de mídia a partir do payload
          const msgData = data.message || {};
          if (msgData.imageMessage) {
            finalMessageType = 'image';
            finalContent = msgData.imageMessage.caption || '[Imagem]';
            mediaUrl = msgData.imageMessage.url;
          } else if (msgData.audioMessage || msgData.ptt) {
            finalMessageType = 'audio';
            finalContent = '[Áudio]';
          } else if (msgData.videoMessage) {
            finalMessageType = 'video';
            finalContent = msgData.videoMessage.caption || '[Vídeo]';
            mediaUrl = msgData.videoMessage.url;
          } else if (msgData.documentMessage) {
            finalMessageType = 'document';
            finalContent = msgData.documentMessage.fileName || '[Documento]';
            mediaUrl = msgData.documentMessage.url;
          } else if (msgData.stickerMessage) {
            finalContent = '[Sticker]';
          } else if (msgData.locationMessage) {
            finalMessageType = 'location';
            finalContent = `[Localização: ${msgData.locationMessage.degreesLatitude}, ${msgData.locationMessage.degreesLongitude}]`;
          } else if (!finalContent) {
            finalContent = '[Mensagem sem texto]';
          }

          // Verificar se mensagem já existe (evitar duplicatas por externalId)
          const existingMessages = await storage.getChatMessages(matchingConv.id);
          const isDuplicate = existingMessages.some((m: any) => 
            m.externalId === messageId || 
            (m.content === finalContent && Math.abs((m.createdAt?.getTime() || 0) - timestamp * 1000) < 3000)
          );

          if (isDuplicate) {
            console.log(`⏭️  [WEBHOOK-MIRROR] Mensagem duplicada ignorada: ${messageId}`);
          } else {
            // Salvar mensagem com identificação correta do remetente
            // isFromMe = true: mensagem enviada pelo nosso número (via celular ou sistema)
            // isFromMe = false: mensagem recebida do cliente
            console.log(`📝 [WEBHOOK-MIRROR] Salvando mensagem: tipo=${finalMessageType}, conteúdo=${finalContent?.substring(0, 50)}`);
            try {
              const message = await storage.createChatMessage({
                conversationId: matchingConv.id,
                senderId: isFromMe ? 'system' : customer.id,
                senderType: isFromMe ? 'agent' : 'customer',
                content: finalContent,
                messageType: finalMessageType,
                mediaUrl: mediaUrl,
                isRead: isFromMe, // Mensagens enviadas por nós já são "lidas"
                externalId: messageId // Guardar ID externo para evitar duplicatas
              });
              console.log(`💬 [WEBHOOK-MIRROR] ✅ Mensagem salva: ${message.id} | Tipo: ${finalMessageType} | Direção: ${isFromMe ? 'ENVIADA' : 'RECEBIDA'}`);
              
              // 🟢 Incrementar contador de unread APENAS para mensagens recebidas
              if (!isFromMe) {
                try {
                  await storage.incrementUnreadCount(matchingConv.id);
                  console.log(`📬 [WEBHOOK-MIRROR] Contador de unread incrementado para conversa ${matchingConv.id}`);
                } catch (err) {
                  console.warn(`⚠️  [WEBHOOK-MIRROR] Erro ao incrementar unreadCount:`, err);
                }
              }
            } catch (msgError: any) {
              console.error(`❌ [WEBHOOK-MIRROR] ERRO ao salvar mensagem:`, msgError.message);
              console.error(`❌ [WEBHOOK-MIRROR] Stack completo:`, msgError.stack);
              throw msgError;
            }
          }

          console.log(`✅ [WEBHOOK-MIRROR] Processamento concluído com sucesso`);
        } catch (processError: any) {
          console.error(`❌ [WEBHOOK-MIRROR] Erro ao processar mensagem:`, processError.message);
          console.error(`❌ [WEBHOOK-MIRROR] Stack:`, processError.stack);
          // Não falhar o webhook - sempre retornar 200
        }
      } else {
        console.log(`⏭️  [WEBHOOK-MIRROR] Mensagem sem telefone ignorada`);
      }

      // Sempre retornar 200 OK para Evolution API não retentar
      res.status(200).json({ 
        success: true, 
        received: true,
        messageId: messageId,
        processed: !!(phoneNumber && messageText)
      });
    } catch (error: any) {
      console.error(`❌ [WEBHOOK-MIRROR] Erro no webhook:`, error);
      // Sempre retornar 200 para não retentar
      res.status(200).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

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

      // Normalizar telefone com MESMA função do webhook
      const normalizedPhone = normalizePhoneNumber(phoneNumber);
      console.log(`📨 [WHATSAPP-SEND] Enviando para: ${phoneNumber} -> ${normalizedPhone}`);

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📨 [WHATSAPP-SEND] Enviando mensagem para ${normalizedPhone} via ${messageType}`);

      let result;
      if (messageType === 'media' && mediaUrl) {
        result = await evolutionAPIService.sendMediaMessage(config.instanceName, normalizedPhone, mediaUrl, caption, 'image');
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
          priority: 'normal' as const
        });
        console.log(`✅ [WHATSAPP-SEND] Conversa: ${conversation.id}`);

        // 3. Salvar mensagem ENVIADA
        await storage.createChatMessage({
          conversationId: conversation.id,
          senderId: (req as any).user?.id || "system",
          senderType: "system",
          content: message,
          messageType: "text",
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

      // 🔐 Filtrar conversas - admins veem TODAS, agents veem só suas
      let filteredConversations = conversations;
      if (!isAdmin && currentUser?.id) {
        // Buscar agente ligado ao usuário
        const userAgent = agents.find(a => a.userId === currentUser.id);
        if (userAgent) {
          // Filtrar conversas atribuídas a este agente
          filteredConversations = conversations.filter(c => c.agentId === userAgent.id);
        } else {
          // Usuário sem agente - vê conversas não atribuídas
          filteredConversations = conversations.filter(c => !c.agentId);
        }
      }

      // Enriquecer conversas com dados relacionados
      const enrichedConversations = filteredConversations.map((conv: any) => {
        const agent = agents.find(a => a.id === conv.agentId);
        const customer = customers.find(c => c.id === conv.customerId);
        
        // 🟢 Usar unreadCount do banco de dados
        const unreadCount = conv.unreadCount || 0;
        return {
          id: conv.id,
          customerId: conv.customerId,
          customerName: customer?.name || conv.customerName || "Desconhecido",
          customerPhone: conv.customerPhone || customer?.phone || "-",
          agentId: conv.agentId,
          agentName: agent?.name,
          status: conv.status,
          priority: conv.priority,
          lastMessageTime: conv.lastMessageTime,
          createdAt: conv.createdAt,
          unreadCount: unreadCount,
          hasUnread: unreadCount > 0
        };
      });

      // 🔴 ORDENAÇÃO: conversas com unread no TOPO, depois por data
      enrichedConversations.sort((a: any, b: any) => {
        if (a.hasUnread && !b.hasUnread) return -1;
        if (!a.hasUnread && b.hasUnread) return 1;
        return new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime();
      });

      res.json(enrichedConversations);
    } catch (error: any) {
      console.error("[CHAT-CONVERSATIONS] Erro fatal:", error.message || error);
      res.status(500).json({ error: "Erro ao buscar conversas", details: error.message });
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
      
      // 🟢 Marcar TODAS as mensagens de clientes como lidas ao abrir a conversa
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
      
      // Buscar mensagens novamente após marcar como lidas
      const updatedMessages = await storage.getChatMessages(conversationId) || [];
      res.json(updatedMessages);
    } catch (error: any) {
      console.error("[CHAT-MESSAGES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // GET /api/chat/agents - Lista de agentes
  app.get("/api/chat/agents", async (req, res) => {
    try {
      const agents = await storage.getChatAgents() || [];
      res.json(agents);
    } catch (error: any) {
      console.error("[CHAT-AGENTS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar agentes" });
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
                sendResult = await evolutionAPIService.sendMediaMessage(
                  config.instanceName,
                  phoneFormatted,
                  mediaUrl,
                  mediaCaption || content || undefined,
                  messageType as 'image' | 'audio' | 'video' | 'document'
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

      const updatedConv = await storage.updateChatConversation(conversationId, {
        agentId,
        status: 'assigned'
      });

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

  console.log("✅ Chat routes registered successfully");
}
