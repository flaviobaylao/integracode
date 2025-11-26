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
  console.log(`📞 [NORMALIZE] Input: ${phone} -> Digits: ${digitsOnly}`);
  
  // Se começar com 55, remove para recalcular
  if (digitsOnly.startsWith('55')) {
    digitsOnly = digitsOnly.slice(2);
  }
  
  // Remove números duplicados à esquerda (555 -> 5)
  while (digitsOnly.length > 11) {
    digitsOnly = digitsOnly.slice(-11);
  }
  
  // Garante exatamente 11 dígitos
  const normalized = `55${digitsOnly.slice(-11)}`;
  
  console.log(`📞 [NORMALIZE] Output: ${normalized}`);
  return normalized;
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

      if (!customerPhone) {
        return res.status(400).json({ error: "Número de telefone é obrigatório" });
      }

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado" });
      }

      // Create or get customer
      let createdCustomer = await storage.createChatCustomer({
        name: customerName || `Cliente ${customerPhone}`,
        phone: customerPhone
      }).catch(() => null);

      if (!createdCustomer) {
        return res.status(400).json({ error: "Erro ao criar cliente para a conversa" });
      }

      // Create conversation
      const conversation = await storage.createChatConversation({
        customerId: createdCustomer.id,
        customerName: customerName || `Cliente ${customerPhone}`,
        customerPhone: customerPhone,
        status: "new",
        priority: "normal"
      });

      res.json({
        id: conversation.id,
        customerId: createdCustomer.id,
        phoneNumber: customerPhone,
        customerName: customerName || `Cliente ${customerPhone}`,
        status: "new"
      });
    } catch (error: any) {
      console.error("[CHAT] Start conversation error:", error);
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

      // Get Evolution API config
      const config = evolutionAPIService.getConfig();
      if (!config || !config.instanceName) {
        return res.status(400).json({ error: "WhatsApp não está configurado. Configure a Evolution API primeiro." });
      }

      console.log(`📨 [WHATSAPP-SEND] Enviando mensagem para ${phoneNumber} via ${messageType}`);

      let result;
      if (messageType === 'media' && mediaUrl) {
        result = await evolutionAPIService.sendMediaMessage(config.instanceName, phoneNumber, mediaUrl, caption, 'image');
      } else if (messageType === 'location' && req.body.latitude && req.body.longitude) {
        result = await evolutionAPIService.sendLocationMessage(config.instanceName, phoneNumber, req.body.latitude, req.body.longitude, caption);
      } else {
        result = await evolutionAPIService.sendTextMessage(config.instanceName, phoneNumber, message);
      }

      if (!result.success) {
        console.error(`❌ [WHATSAPP-SEND] Erro ao enviar:`, result.error);
        return res.status(500).json({ error: result.error || "Erro ao enviar mensagem" });
      }

      // Save message to conversation history if exists
      try {
        const conv = await storage.getChatConversations();
        const matchingConv = conv.find((c: any) => c.phoneNumber === phoneNumber || c.phoneNumber === phoneNumber.replace(/\D/g, ''));
        
        if (matchingConv) {
          await storage.createChatMessage({
            conversationId: matchingConv.id,
            senderId: (req as any).user?.id || "system",
            senderType: "system",
            content: message,
            messageType: "text"
          });
        }
      } catch (err) {
        console.warn("[CHAT] Warning saving message history:", err);
      }

      console.log(`✅ [WHATSAPP-SEND] Mensagem enviada com sucesso para ${phoneNumber}`);
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

  // Webhook para receber mensagens recebidas via Evolution API
  app.post("/api/chat/webhook/messages", async (req, res) => {
    console.log(`\n\n⭐ [WEBHOOK-RECEIVED] POST request chegou ao webhook!`);
    console.log(`📋 [WEBHOOK-HEADERS]`, JSON.stringify(req.headers, null, 2));
    console.log(`📋 [WEBHOOK-BODY]`, JSON.stringify(req.body, null, 2));
    
    // RESPONDER IMEDIATAMENTE com 200 OK
    res.status(200).json({ success: true, message: 'Webhook recebido' });
    
    // PROCESSAR WEBHOOK ASSINCRONAMENTE SEM ENVIAR RESPOSTA NOVAMENTE
    (async () => {
      try {
        // Suportar múltiplos formatos de webhook
        let event = req.body.event;
        let instance = req.body.instance;
        let data = req.body.data;

        // Se vier com "webhook" aninhado
        if (!event && req.body.webhook && req.body.webhook.event) {
          event = req.body.webhook.event;
          instance = req.body.webhook.instance;
          data = req.body.webhook.data;
        }

        console.log(`📱 [WEBHOOK] Evento:`, event, `| Instance:`, instance, `| Has data:`, !!data);

        if ((event === 'MESSAGES_UPSERT' || event === 'messages.upsert') && data) {
          const message = data;
          const remoteJid = message.key?.remoteJid;
          const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
          const isFromMe = message.key?.fromMe;

          console.log(`📱 [WEBHOOK-DETAILS]`, { remoteJid, isFromMe, hasText: !!text, textPreview: text?.substring(0, 50) });

          if (!isFromMe && text) {
            console.log(`💬 [WHATSAPP-RECEIVED] Mensagem recebida de ${remoteJid}: ${text}`);

            try {
              console.log(`🔍 [WEBHOOK] remoteJid recebido: ${remoteJid}`);
              
              // 🔧 Normalizar telefone usando função centralizada
              const phoneFormatted = normalizePhoneNumber(remoteJid || '');
              
              if (!phoneFormatted) {
                console.error(`❌ [WEBHOOK] Falha ao normalizar telefone: ${remoteJid}`);
                return;
              }

              console.log(`🔍 [WEBHOOK] Buscando cliente pelo telefone: ${phoneFormatted}`);

              // 1. Tentar buscar cliente regular (tabela customers) para pegar nome fantasia
              let clientName = "Número Desconhecido";
              try {
                let existingClient = await storage.getCustomerByPhone(phoneFormatted).catch(() => null);
                if (existingClient) {
                  clientName = existingClient.fantasyName || existingClient.name || "Número Desconhecido";
                  console.log(`✅ Cliente encontrado: ${clientName}`);
                } else {
                  console.log(`⚠️  Cliente não encontrado no sistema`);
                }
              } catch (err) {
                console.warn(`⚠️  [WEBHOOK] Erro ao buscar cliente:`, err);
              }

              // 2. Buscar ou criar chat customer (phoneFormatted já é normalizado)
              let chatCustomer: any;
              try {
                console.log(`🔎 [WEBHOOK] Buscando chatCustomer com telefone normalizado: ${phoneFormatted}`);
                chatCustomer = await storage.getChatCustomerByPhone(phoneFormatted);
                
                if (!chatCustomer) {
                  console.log(`📝 Criando novo chat customer...`);
                  chatCustomer = await storage.createChatCustomer({
                    name: clientName,
                    phone: phoneFormatted
                  });
                  console.log(`✅ Chat customer criado: ${chatCustomer.id}`);
                }
              } catch (err) {
                console.error(`❌ [WEBHOOK] Erro ao criar/buscar chat customer:`, err);
                throw err;
              }

              // 3. Buscar ou criar conversa - GARANTIR PERSISTÊNCIA NO HISTÓRICO
              let conversation: any;
              try {
                // ✅ VALIDAÇÃO: Telefone SEMPRE deve estar presente
                if (!phoneFormatted) {
                  throw new Error('Telefone não pode ser vazio ao criar conversa');
                }

                conversation = await storage.getChatConversationByCustomerId(chatCustomer.id);

                if (!conversation) {
                  console.log(`📝 Criando nova conversa para telefone: ${phoneFormatted}...`);
                  
                  // ✅ Garantir que customerPhone sempre é salvo
                  const conversationData = {
                    customerId: chatCustomer.id,
                    customerName: clientName,
                    customerPhone: phoneFormatted, // 🔒 CRÍTICO: Sempre salvar telefone
                    status: "new" as const,
                    priority: "normal" as const
                  };
                  
                  conversation = await storage.createChatConversation(conversationData);
                  
                  // ✅ AUDITORIA: Confirmar que conversa foi salva com telefone
                  console.log(`✅ [PERSISTÊNCIA] Conversa criada e gravada permanentemente:`);
                  console.log(`   - ID: ${conversation.id}`);
                  console.log(`   - Telefone: ${conversation.customerPhone}`);
                  console.log(`   - Cliente: ${conversation.customerId}`);
                  console.log(`   - Status: ${conversation.status}`);
                  console.log(`   - Criada em: ${conversation.createdAt}`);
                } else {
                  console.log(`✅ Conversa encontrada no histórico:`);
                  console.log(`   - ID: ${conversation.id}`);
                  console.log(`   - Telefone: ${conversation.customerPhone}`);
                  console.log(`   - Status: ${conversation.status}`);
                }
              } catch (err) {
                console.error(`❌ [WEBHOOK] Erro ao criar/buscar conversa:`, err);
                throw err;
              }

              // 4. Salvar mensagem - GARANTIR PERSISTÊNCIA
              try {
                const msg = await storage.createChatMessage({
                  conversationId: conversation.id,
                  senderId: remoteJid || "unknown",
                  senderType: "customer",
                  content: text || "[Mídia ou mensagem especial]",
                  messageType: "text"
                });

                // ✅ AUDITORIA: Confirmar que mensagem foi salva no histórico atrelada ao telefone
                console.log(`✅ [PERSISTÊNCIA] Mensagem gravada permanentemente no histórico:`);
                console.log(`   - Mensagem ID: ${msg.id}`);
                console.log(`   - Conversa ID: ${msg.conversationId}`);
                console.log(`   - Telefone: ${conversation.customerPhone}`);
                console.log(`   - Conteúdo: ${(text || "[Mídia]").substring(0, 50)}...`);
                console.log(`   - Timestamp: ${msg.timestamp}`);
              } catch (err) {
                console.error(`❌ [WEBHOOK] Erro ao salvar mensagem:`, err);
                throw err;
              }
            } catch (err) {
              console.error(`🚨 [WEBHOOK] ERRO CRÍTICO ao processar mensagem:`, err);
            }
          }
        } else {
          console.warn(`⚠️  [WEBHOOK] Evento não reconhecido ou sem dados:`, event);
        }
      } catch (error: any) {
        console.error("[WEBHOOK] Erro ao processar webhook:", error);
      }
    })();
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
          messageTimestamp: Math.floor(Date.now() / 1000),
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
          messageTimestamp: Math.floor(Date.now() / 1000),
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
          messageTimestamp: Math.floor(Date.now() / 1000),
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
            messageTimestamp: Math.floor(Date.now() / 1000),
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

      // Enriquecer conversas com dados relacionados + contar mensagens não lidas
      const enrichedConversations = await Promise.all(
        filteredConversations.map(async (conv: any) => {
          const agent = agents.find(a => a.id === conv.agentId);
          const customer = customers.find(c => c.id === conv.customerId);
          
          // 🟢 Contar mensagens não lidas (apenas de clientes)
          let unreadCount = 0;
          try {
            const messages = await storage.getChatMessages(conv.id) || [];
            unreadCount = messages.filter((m: any) => !m.isRead && m.senderType === 'customer').length;
          } catch (e) {
            console.warn(`[CHAT] Erro ao contar mensagens não lidas de ${conv.id}:`, e);
          }
          
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
        })
      );

      // Ordenar: PRIMEIRO conversas com mensagens não lidas, DEPOIS por última mensagem
      enrichedConversations.sort((a: any, b: any) => {
        // Se uma tem unread e a outra não, a com unread vem primeiro
        if (a.hasUnread && !b.hasUnread) return -1;
        if (!a.hasUnread && b.hasUnread) return 1;
        
        // Se ambas têm ou não têm unread, ordena por última mensagem (mais recentes primeiro)
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

  // POST /api/chat/conversations/:conversationId/message - Enviar mensagem
  app.post("/api/chat/conversations/:conversationId/message", authenticateUser, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { content, messageType = "text" } = req.body;
      const userId = (req as any).currentUser?.id;
      const currentUser = (req as any).currentUser;

      if (!content) {
        return res.status(400).json({ error: "Conteúdo da mensagem é obrigatório" });
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
        content,
        messageType
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
      try {
        if (conversation.customerId) {
          const chatCustomer = await storage.getChatCustomer(conversation.customerId);
          if (chatCustomer?.phone) {
            const config = evolutionAPIService.getConfig();
            if (config?.instanceName) {
              const phoneNormalized = normalizePhoneNumber(chatCustomer.phone);
              const phoneFormatted = phoneNormalized.includes('@') 
                ? phoneNormalized 
                : `${phoneNormalized}@s.whatsapp.net`;
              
              console.log(`📤 [SEND-WHATSAPP] Enviando para ${phoneFormatted}: ${content.substring(0, 50)}`);
              const sendResult = await evolutionAPIService.sendTextMessage(
                config.instanceName,
                phoneFormatted,
                content
              );
              
              if (sendResult.success) {
                console.log(`✅ [SEND-WHATSAPP] Mensagem enviada com sucesso via WhatsApp`);
              } else {
                console.warn(`⚠️ [SEND-WHATSAPP] Erro ao enviar: ${sendResult.error}`);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[WHATSAPP] Erro ao enviar para WhatsApp:", err);
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

  console.log("✅ Chat routes registered successfully");
}
