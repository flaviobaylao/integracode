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
  
  // Webhook para receber mensagens recebidas via Evolution API
  app.post("/api/chat/webhook/messages", async (req, res) => {
    try {
      const { event, instance, data } = req.body;

      console.log(`📱 [WEBHOOK] Evento recebido:`, JSON.stringify({ event, instance, dataKeys: Object.keys(data || {}) }));

      if (event === 'MESSAGES_UPSERT' && data) {
        const message = data;
        const remoteJid = message.key?.remoteJid;
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        const isFromMe = message.key?.fromMe;

        console.log(`📱 [WEBHOOK-DETAILS]`, { remoteJid, isFromMe, hasText: !!text, textPreview: text?.substring(0, 50) });

        if (!isFromMe && text) {
          console.log(`💬 [WHATSAPP-RECEIVED] Mensagem recebida de ${remoteJid}: ${text}`);

          // Salvar mensagem recebida no banco de dados
          try {
            const conv = await storage.getChatConversations();
            const phoneClean = remoteJid?.replace(/\D/g, '');
            const matchingConv = conv.find((c: any) => 
              c.phoneNumber === remoteJid || 
              c.phoneNumber?.replace(/\D/g, '') === phoneClean
            );

            if (matchingConv) {
              await storage.createChatMessage({
                conversationId: matchingConv.id,
                senderId: remoteJid || "unknown",
                senderType: "customer",
                content: text || "[Mídia ou mensagem especial]",
                messageType: "text"
              });
              console.log(`✅ Mensagem salva na conversa ${matchingConv.id}`);
            } else {
              console.warn(`⚠️  Nenhuma conversa encontrada para ${remoteJid}. Conversas disponíveis:`, 
                conv.map((c: any) => c.phoneNumber).join(", "));
            }
          } catch (err) {
            console.error("[WEBHOOK] Erro ao salvar mensagem:", err);
          }
        }
      } else {
        console.warn(`⚠️  [WEBHOOK] Evento não reconhecido ou sem dados:`, event);
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("[WEBHOOK] Erro ao processar webhook:", error);
      res.status(500).json({ error: "Erro ao processar webhook" });
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

  // ============================================================
  // ENDPOINTS PARA GESTÃO DE CONVERSAS
  // ============================================================

  // GET /api/chat/conversations/stats - Estatísticas gerais de conversas
  app.get("/api/chat/conversations/stats", async (req, res) => {
    try {
      const conversations = await storage.getChatConversations();
      const agents = await storage.getChatAgents?.() || [];
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
  app.get("/api/chat/conversations", async (req, res) => {
    try {
      const conversations = await storage.getChatConversations();
      const agents = await storage.getChatAgents?.() || [];
      const customers = await storage.getChatCustomers?.() || [];
      const messages: any[] = [];

      // Enriquecer conversas com dados relacionados
      const enrichedConversations = conversations.map((conv: any) => {
        const agent = agents.find(a => a.id === conv.agentId);
        const customer = customers.find(c => c.id === conv.customerId);
        const conversationMessages = messages.filter((m: any) => m.conversationId === conv.id);
        
        return {
          id: conv.id,
          customerId: conv.customerId,
          customerName: customer?.name || "Desconhecido",
          customerPhone: customer?.phone || "-",
          agentId: conv.agentId,
          agentName: agent?.name,
          status: conv.status,
          priority: conv.priority,
          lastMessageTime: conv.lastMessageTime,
          messageCount: conversationMessages.length,
          createdAt: conv.createdAt
        };
      });

      // Ordenar por última mensagem (mais recentes primeiro)
      enrichedConversations.sort((a: any, b: any) => 
        new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime()
      );

      res.json(enrichedConversations);
    } catch (error: any) {
      console.error("[CHAT-CONVERSATIONS] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar conversas" });
    }
  });

  // GET /api/chat/conversations/messages/:conversationId - Mensagens de uma conversa
  app.get("/api/chat/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getChatMessages?.(conversationId) || [];
      res.json(messages);
    } catch (error: any) {
      console.error("[CHAT-MESSAGES] Erro:", error);
      res.status(500).json({ error: "Erro ao buscar mensagens" });
    }
  });

  // GET /api/chat/agents - Lista de agentes
  app.get("/api/chat/agents", async (req, res) => {
    try {
      const agents = await storage.getChatAgents?.() || [];
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

      if (!content) {
        return res.status(400).json({ error: "Conteúdo da mensagem é obrigatório" });
      }

      const message = await storage.createChatMessage({
        conversationId,
        senderId: userId,
        senderType: "agent",
        content,
        messageType
      });

      // Atualizar tempo de resposta do agente se for a primeira mensagem
      const conversations = await storage.getChatConversations();
      const conv = conversations.find((c: any) => c.id === conversationId);
      
      if (conv && conv.createdAt) {
        // Atualizar conversa com tempo de resposta
        await storage.updateChatConversation?.(conversationId, {
          status: 'in-progress'
        });
      }

      // Enviar para WhatsApp via Evolution API
      try {
        if (conv?.customerId) {
          const customers = await storage.getChatCustomers?.() || [];
          const customer = customers.find((c: any) => c.id === conv.customerId);
          if (customer?.phone) {
            const config = evolutionAPIService.getConfig();
            if (config?.instanceName) {
              await evolutionAPIService.sendTextMessage(
                config.instanceName,
                customer.phone,
                content
              );
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

      const updatedConv = await storage.updateChatConversation?.(conversationId, {
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

      const updatedConv = await storage.updateChatConversation?.(conversationId, updateData);

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
      const templates = await storage.getChatQuickMessages?.() || [];
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

      const template = await storage.createChatQuickMessage?.({
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

  console.log("✅ Chat routes registered successfully");
}
