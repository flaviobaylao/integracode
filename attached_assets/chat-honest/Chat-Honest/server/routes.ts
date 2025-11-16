import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { chatGPTService } from "./chatgpt-service";
import { getSession, requireAuth, requireAdmin, requireAgent, initializeDefaultUsers } from "./auth";
import { insertMessageSchema, insertConversationSchema, insertCustomerSchema, updateCustomerSchema, insertUserSchema, insertProductSchema, insertQuickMessageSchema, insertOrderSchema, insertDeliverySchema, insertDeliveryRejectionReasonSchema, insertWhatsappConversationAnalysisSchema } from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import { whatsappService } from "./whatsapp-service";
import { whatsappOfficialAPI } from "./whatsapp-official-api";
import { evolutionAPIService, type EvolutionWebhookData } from "./evolution-api-service";
import { telegramService } from "./telegram-service";
import { whatsappAnalysisService } from "./whatsapp-analysis-service";
import { agentActivityService } from "./agent-activity-service";
import * as XLSX from 'xlsx';
import { db } from "./db";
import { conversations } from "@shared/schema";
import { eq } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";

interface WebSocketClient extends WebSocket {
  agentId?: string;
  isAlive?: boolean;
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  
  // Configure sessions
  app.use(getSession());
  
  // Initialize default users
  await initializeDefaultUsers();
  
  // Load Evolution API settings from database on startup
  setTimeout(async () => {
    try {
      const evolutionApiUrl = await storage.getSystemSetting('evolution_api_url');
      const evolutionApiKey = await storage.getSystemSetting('evolution_api_key');
      const evolutionInstanceName = await storage.getSystemSetting('evolution_instance_name');

      if (evolutionApiUrl && evolutionApiKey && evolutionInstanceName) {
        evolutionAPIService.configure({
          apiUrl: evolutionApiUrl.value,
          apiKey: evolutionApiKey.value,
          instanceName: evolutionInstanceName.value
        });
        console.log('✅ Evolution API configurada do banco de dados:', {
          apiUrl: evolutionApiUrl.value,
          instanceName: evolutionInstanceName.value
        });
      } else {
        console.log('ℹ️ Evolution API não está configurada no banco de dados');
      }
    } catch (error) {
      console.error('❌ Erro ao carregar configurações da Evolution API:', error);
    }
  }, 1000); // Wait 1 second for database to be ready
  
  // WebSocket server for real-time communication
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  const clients = new Set<WebSocketClient>();

  // WebSocket connection handling
  wss.on('connection', (ws: WebSocketClient) => {
    console.log(`🔌 WebSocket client connected. Total clients: ${clients.size + 1}`);
    clients.add(ws);
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'agent_connect':
            ws.agentId = message.agentId;
            await storage.updateAgentStatus(message.agentId, 'online');
            broadcast({ type: 'agent_status_update', agentId: message.agentId, status: 'online' });
            break;
            
          case 'agent_disconnect':
            if (ws.agentId) {
              await storage.updateAgentStatus(ws.agentId, 'offline');
              broadcast({ type: 'agent_status_update', agentId: ws.agentId, status: 'offline' });
            }
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', async () => {
      console.log(`🔌 WebSocket client disconnected. Total clients: ${clients.size - 1}`);
      clients.delete(ws);
      if (ws.agentId) {
        await storage.updateAgentStatus(ws.agentId, 'offline');
        broadcast({ type: 'agent_status_update', agentId: ws.agentId, status: 'offline' });
      }
    });
  });

  // Heartbeat to detect broken connections
  const interval = setInterval(() => {
    clients.forEach((ws: WebSocketClient) => {
      if (!ws.isAlive) {
        clients.delete(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  function broadcast(message: any) {
    const data = JSON.stringify(message);
    clients.forEach((client: WebSocketClient) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  // Configure multer for file uploads
  const uploadDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const storageConfig = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
  });

  const upload = multer({
    storage: storageConfig,
    limits: {
      fileSize: 16 * 1024 * 1024, // 16MB limit
    },
    fileFilter: (req, file, cb) => {
      // Accept images, audio, video, and documents
      const allowedMimes = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
        'video/mp4', 'video/mpeg', 'video/quicktime',
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ];
      
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo de arquivo não suportado: ${file.mimetype}`));
      }
    }
  });

  // File upload endpoint
  app.post("/api/messages/upload", requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }

      const fileUrl = `/uploads/${req.file.filename}`;
      
      res.json({
        success: true,
        file: {
          url: fileUrl,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        }
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Erro ao fazer upload do arquivo" });
    }
  });

  // Serve uploaded files
  app.use('/uploads', requireAuth, (req, res, next) => {
    next();
  }, (req, res, next) => {
    const filePath = path.join(uploadDir, path.basename(req.path));
    res.sendFile(filePath);
  });

  // Authentication Routes
  
  // Login
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username e senha são obrigatórios" });
      }

      const user = await storage.validatePassword(username, password);
      if (!user) {
        // Log failed login attempt
        await storage.createAuditLog({
          action: "login_failed",
          details: { username, ip: req.ip },
        });
        return res.status(401).json({ error: "Credenciais inválidas" });
      }

      // Update last login
      await storage.updateLastLogin(user.id);
      
      // Store user ID in session
      (req.session as any).userId = user.id;
      
      // Se for um agente, definir como online
      if (user.role === "agent") {
        const agent = await storage.getAgentByUserId(user.id);
        if (agent) {
          await agentActivityService.setAgentOnline(agent.id);
        }
      }
      
      // Log successful login
      await storage.createAuditLog({
        userId: user.id,
        action: "login_success",
        details: { ip: req.ip },
      });

      res.json({ 
        success: true, 
        user: { 
          id: user.id, 
          username: user.username, 
          email: user.email, 
          role: user.role 
        } 
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  // Logout
  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    try {
      // Se for um agente, definir como offline
      if (req.user!.role === "agent") {
        const agent = await storage.getAgentByUserId(req.user!.id);
        if (agent) {
          await agentActivityService.setAgentOffline(agent.id);
        }
      }

      // Log logout
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "logout",
        details: { ip: req.ip },
      });

      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
          return res.status(500).json({ error: "Erro ao fazer logout" });
        }
        res.json({ success: true });
      });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  // Get current user
  app.get("/api/auth/user", requireAuth, async (req, res) => {
    res.json({
      id: req.user!.id,
      username: req.user!.username,
      email: req.user!.email,
      role: req.user!.role,
    });
  });

  // Agent Activity Routes

  // Heartbeat para manter agente ativo
  app.post("/api/agent/heartbeat", requireAuth, requireAgent, async (req, res) => {
    try {
      const agent = await storage.getAgentByUserId(req.user!.id);
      if (agent) {
        await agentActivityService.updateAgentHeartbeat(agent.id);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "Agente não encontrado" });
      }
    } catch (error) {
      console.error("Heartbeat error:", error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  // Finalizar atendimento
  app.post("/api/conversations/:id/finish", requireAuth, requireAgent, async (req, res) => {
    try {
      const { id: conversationId } = req.params;
      const { thankYouMessage } = req.body;
      
      const agent = await storage.getAgentByUserId(req.user!.id);
      if (!agent) {
        return res.status(404).json({ error: "Agente não encontrado" });
      }

      // Verificar se a conversa pertence ao agente ou se pode ser finalizada por ele
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Verificar autorização: a conversa deve pertencer ao agente OU ser do ChatGPT (que pode ser finalizada por qualquer agente humano) OU o usuário ser admin
      const conversationAgent = conversation.agentId ? await storage.getAgent(conversation.agentId) : null;
      const isAdmin = req.user!.role === "admin";
      const canFinish = conversation.agentId === agent.id || 
                       (conversationAgent?.type === "bot" && agent.type === "human") ||
                       isAdmin;
      
      if (!canFinish) {
        return res.status(403).json({ error: "Não autorizado para esta conversa" });
      }

      // Finalizar o atendimento
      const metrics = await agentActivityService.finishConversation(conversationId, agent.id);

      // Enviar mensagem de agradecimento se fornecida
      if (thankYouMessage) {
        await storage.createMessage({
          conversationId,
          senderId: agent.id,
          senderType: "agent",
          content: thankYouMessage,
          messageType: "text",
        });

        // Enviar via WebSocket para atualizar interface
        broadcast({
          type: 'new_message',
          conversationId,
          message: {
            id: Date.now().toString(),
            conversationId,
            senderId: agent.id,
            senderType: "agent",
            content: thankYouMessage,
            messageType: "text",
            timestamp: new Date(),
            isRead: false,
          }
        });

        // Enviar via WhatsApp se disponível
        try {
          const customer = await storage.getCustomer(conversation.customerId);
          if (customer?.phone && whatsappService.client) {
            await whatsappService.sendMessage(customer.phone, thankYouMessage);
          }
        } catch (whatsappError) {
          console.log("WhatsApp envio falhou:", whatsappError);
        }
      }

      res.json({ 
        success: true, 
        metrics,
        message: "Atendimento finalizado com sucesso" 
      });
    } catch (error) {
      console.error("Finish conversation error:", error);
      res.status(500).json({ error: "Erro ao finalizar atendimento" });
    }
  });

  // Admin Routes
  
  // Create new agent (admin only)
  app.post("/api/admin/agents", requireAuth, requireAdmin, async (req, res) => {
    try {
      const userData = insertUserSchema.parse({
        ...req.body,
        role: req.body.role || "agent",
      });

      // Create user account
      const user = await storage.createUser(userData);
      
      // Create agent profile
      const agent = await storage.createAgent({
        userId: user.id,
        name: req.body.name,
        email: user.email,
        type: "human",
        status: "offline",
      });

      // Log agent creation
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "agent_created",
        entityType: "agent",
        entityId: agent.id,
        details: { agentName: agent.name, agentEmail: agent.email },
      });

      res.json({ success: true, agent, user });
    } catch (error) {
      console.error("Create agent error:", error);
      res.status(500).json({ error: "Erro ao criar agente" });
    }
  });

  // Delete agent (admin only)
  app.delete("/api/admin/agents/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Não permitir deletar o próprio usuário admin
      if (id === req.user!.id) {
        return res.status(400).json({ error: "Não é possível deletar seu próprio usuário" });
      }

      await storage.deleteUser(id);
      
      // Log de auditoria
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "DELETE_AGENT",
        details: `Agente ${id} foi deletado`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Delete agent error:", error);
      res.status(500).json({ error: "Erro ao deletar agente" });
    }
  });

  // Get all users (admin only)
  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      })));
    } catch (error) {
      console.error("Get users error:", error);
      res.status(500).json({ error: "Erro ao buscar usuários" });
    }
  });

  // Generate reports (admin only)
  app.post("/api/admin/reports", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { type, startDate, endDate } = req.body;
      
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      const metrics = await storage.getConversationMetrics(start, end);
      
      const report = await storage.createReport({
        type,
        startDate: start,
        endDate: end,
        data: metrics,
        generatedBy: req.user!.id,
      });

      res.json({ success: true, report });
    } catch (error) {
      console.error("Generate report error:", error);
      res.status(500).json({ error: "Erro ao gerar relatório" });
    }
  });

  // Get reports (admin only)
  app.get("/api/admin/reports", requireAuth, requireAdmin, async (req, res) => {
    try {
      const reports = await storage.getReports(req.user!.id);
      res.json(reports);
    } catch (error) {
      console.error("Get reports error:", error);
      res.status(500).json({ error: "Erro ao buscar relatórios" });
    }
  });

  // Get audit logs (admin only)
  app.get("/api/admin/audit", requireAuth, requireAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getAuditLogs(limit);
      res.json(logs);
    } catch (error) {
      console.error("Get audit logs error:", error);
      res.status(500).json({ error: "Erro ao buscar logs de auditoria" });
    }
  });

  // System Settings Routes (Admin only)
  
  // Get all system settings
  app.get("/api/admin/settings", requireAuth, requireAdmin, async (req, res) => {
    try {
      const settings = await storage.getAllSystemSettings();
      res.json(settings);
    } catch (error) {
      console.error("Get system settings error:", error);
      res.status(500).json({ error: "Erro ao buscar configurações do sistema" });
    }
  });

  // Get specific system setting
  app.get("/api/admin/settings/:key", requireAuth, requireAdmin, async (req, res) => {
    try {
      console.log(`🔍 Getting system setting for key: ${req.params.key}`);
      const setting = await storage.getSystemSetting(req.params.key);
      console.log(`📋 System setting result:`, setting);
      
      if (!setting) {
        console.log(`❌ Setting not found for key: ${req.params.key}`);
        return res.status(404).json({ error: "Configuração não encontrada" });
      }
      
      console.log(`✅ Returning setting:`, JSON.stringify(setting, null, 2));
      res.json(setting);
    } catch (error) {
      console.error("Get system setting error:", error);
      res.status(500).json({ error: "Erro ao buscar configuração" });
    }
  });

  // Set system setting
  app.post("/api/admin/settings", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { key, value, description } = req.body;
      
      if (!key || !value) {
        return res.status(400).json({ error: "Chave e valor são obrigatórios" });
      }

      const setting = await storage.setSystemSetting(key, value, description, req.user!.id);
      
      // Log the action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "system_setting_updated",
        entityType: "system_setting",
        entityId: setting.id,
        details: { key, value, description },
      });

      res.json({ success: true, setting });
    } catch (error) {
      console.error("Set system setting error:", error);
      res.status(500).json({ error: "Erro ao definir configuração" });
    }
  });

  // Toggle ChatGPT priority mode (specific endpoint for the feature)
  app.post("/api/admin/chatgpt-priority", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { enabled } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: "Campo 'enabled' deve ser um valor booleano" });
      }

      const setting = await storage.setSystemSetting(
        'chatgpt_priority_mode', 
        enabled.toString(), 
        'Habilita modo de prioridade do ChatGPT sobre agentes humanos',
        req.user!.id
      );
      
      // Log the action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "chatgpt_priority_toggled",
        entityType: "system_setting",
        entityId: setting.id,
        details: { enabled, previousValue: !enabled },
      });

      console.log(`🤖 ChatGPT Priority Mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${req.user!.username}`);
      
      res.json({ success: true, enabled, setting });
    } catch (error) {
      console.error("Toggle ChatGPT priority error:", error);
      res.status(500).json({ error: "Erro ao alterar modo de prioridade do ChatGPT" });
    }
  });

  // WhatsApp Official API Routes (Admin only)
  
  // Configure WhatsApp Official API
  app.post("/api/admin/whatsapp-official/configure", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { accessToken, phoneNumberId, webhookVerifyToken, businessAccountId } = req.body;
      
      if (!accessToken || !phoneNumberId || !webhookVerifyToken) {
        return res.status(400).json({ 
          error: "Access Token, Phone Number ID e Webhook Verify Token são obrigatórios" 
        });
      }

      // Save settings in database
      await storage.setSystemSetting('whatsapp_access_token', accessToken, 'WhatsApp API Access Token', req.user!.id);
      await storage.setSystemSetting('whatsapp_phone_number_id', phoneNumberId, 'WhatsApp Phone Number ID', req.user!.id);
      await storage.setSystemSetting('whatsapp_webhook_verify_token', webhookVerifyToken, 'WhatsApp Webhook Verify Token', req.user!.id);
      
      if (businessAccountId) {
        await storage.setSystemSetting('whatsapp_business_account_id', businessAccountId, 'WhatsApp Business Account ID', req.user!.id);
      }

      // Configure the API service
      whatsappOfficialAPI.configure({
        accessToken,
        phoneNumberId,
        webhookVerifyToken,
        businessAccountId
      });

      // Log the action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "whatsapp_api_configured",
        entityType: "system_setting",
        entityId: "whatsapp_official",
        details: { phoneNumberId, hasBusinessAccountId: !!businessAccountId },
      });

      console.log(`📱 WhatsApp Official API configured by ${req.user!.username}`);
      
      res.json({ success: true, message: "API oficial do WhatsApp configurada com sucesso" });
    } catch (error) {
      console.error("Configure WhatsApp API error:", error);
      res.status(500).json({ error: "Erro ao configurar API oficial do WhatsApp" });
    }
  });

  // Test WhatsApp Official API connection
  app.post("/api/admin/whatsapp-official/test", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!whatsappOfficialAPI.isConfigured()) {
        return res.status(400).json({ error: "API oficial do WhatsApp não está configurada" });
      }

      const result = await whatsappOfficialAPI.testConnection();
      
      if (result.success) {
        console.log(`✅ WhatsApp API test successful: ${result.phoneNumber}`);
        res.json({ 
          success: true, 
          message: "Conexão testada com sucesso",
          phoneNumber: result.phoneNumber 
        });
      } else {
        console.log(`❌ WhatsApp API test failed: ${result.error}`);
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao testar conexão" 
        });
      }
    } catch (error) {
      console.error("Test WhatsApp API error:", error);
      res.status(500).json({ error: "Erro ao testar API oficial do WhatsApp" });
    }
  });

  // Get WhatsApp Official API configuration status
  app.get("/api/admin/whatsapp-official/status", requireAuth, requireAdmin, async (req, res) => {
    try {
      const config = whatsappOfficialAPI.getConfig();
      const isConfigured = whatsappOfficialAPI.isConfigured();

      res.json({
        isConfigured,
        phoneNumberId: config?.phoneNumberId || null,
        businessAccountId: config?.businessAccountId || null,
        hasAccessToken: !!config?.accessToken,
        hasWebhookToken: !!config?.webhookVerifyToken
      });
    } catch (error) {
      console.error("Get WhatsApp API status error:", error);
      res.status(500).json({ error: "Erro ao buscar status da API oficial" });
    }
  });

  // Get WhatsApp templates
  app.get("/api/admin/whatsapp-official/templates", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!whatsappOfficialAPI.isConfigured()) {
        return res.status(400).json({ error: "API oficial do WhatsApp não está configurada" });
      }

      const templates = await whatsappOfficialAPI.getTemplates();
      res.json(templates);
    } catch (error) {
      console.error("Get WhatsApp templates error:", error);
      res.status(500).json({ error: error.message || "Erro ao buscar templates do WhatsApp" });
    }
  });

  // WhatsApp Webhook endpoint (for receiving messages)
  app.get("/api/whatsapp/webhook", (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const result = whatsappOfficialAPI.verifyWebhook(mode as string, token as string, challenge as string);
    
    if (result) {
      res.status(200).send(result);
    } else {
      res.status(403).send('Webhook verification failed');
    }
  });

  // WhatsApp Webhook endpoint (for receiving messages)
  app.post("/api/whatsapp/webhook", (req, res) => {
    try {
      whatsappOfficialAPI.processWebhook(req.body);
      res.status(200).send('Webhook processed');
    } catch (error) {
      console.error("Process webhook error:", error);
      res.status(500).send('Webhook processing failed');
    }
  });

  // Evolution API Routes (Admin only)
  
  // Configure Evolution API
  app.post("/api/admin/evolution/configure", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { apiUrl, apiKey, instanceName } = req.body;
      
      if (!apiUrl || !apiKey || !instanceName) {
        return res.status(400).json({ 
          error: "URL da API, API Key e Nome da Instância são obrigatórios" 
        });
      }

      // Save settings in database
      await storage.setSystemSetting('evolution_api_url', apiUrl, 'Evolution API URL', req.user!.id);
      await storage.setSystemSetting('evolution_api_key', apiKey, 'Evolution API Key', req.user!.id);
      await storage.setSystemSetting('evolution_instance_name', instanceName, 'Evolution Instance Name', req.user!.id);

      // Configure the service
      evolutionAPIService.configure({ apiUrl, apiKey, instanceName });

      // Log the action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "evolution_api_configured",
        entityType: "system_setting",
        entityId: "evolution_api",
        details: { apiUrl, instanceName },
      });

      console.log(`📱 Evolution API configurada por ${req.user!.username}`);
      
      res.json({ success: true, message: "Evolution API configurada com sucesso" });
    } catch (error) {
      console.error("Configure Evolution API error:", error);
      res.status(500).json({ error: "Erro ao configurar Evolution API" });
    }
  });

  // Test Evolution API connection
  app.post("/api/admin/evolution/test", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const result = await evolutionAPIService.testConnection();
      
      if (result.success) {
        console.log(`✅ Evolution API teste bem-sucedido`);
        res.json({ 
          success: true, 
          message: "Conexão com Evolution API estabelecida com sucesso",
          instances: result.instances
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao testar conexão" 
        });
      }
    } catch (error) {
      console.error("Test Evolution API error:", error);
      res.status(500).json({ error: "Erro ao testar Evolution API" });
    }
  });

  // Test sending message via Evolution API
  app.post("/api/admin/evolution/test-send", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const { phone, message } = req.body;
      
      if (!phone || !message) {
        return res.status(400).json({ error: "Telefone e mensagem são obrigatórios" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      // Check if instance is connected
      const statusResult = await evolutionAPIService.getInstanceStatus(instanceName.value);
      
      if (statusResult.status !== 'open') {
        return res.status(400).json({ 
          error: "WhatsApp não está conectado. Conecte primeiro antes de enviar mensagens." 
        });
      }

      const result = await evolutionAPIService.sendTextMessage(
        instanceName.value,
        phone,
        message
      );
      
      if (result.success) {
        await storage.createAuditLog({
          userId: req.user!.id,
          action: "evolution_test_message_sent",
          entityType: "whatsapp",
          entityId: instanceName.value,
          details: { phone, messageId: result.messageId },
        });

        console.log(`✅ Mensagem de teste enviada para ${phone}`);
        res.json({ 
          success: true, 
          message: "Mensagem enviada com sucesso!",
          messageId: result.messageId
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao enviar mensagem" 
        });
      }
    } catch (error) {
      console.error("Test send message error:", error);
      res.status(500).json({ error: "Erro ao enviar mensagem de teste" });
    }
  });

  // Get Evolution API status
  app.get("/api/admin/evolution/status", requireAuth, requireAdmin, async (req, res) => {
    try {
      const apiUrl = await storage.getSystemSetting('evolution_api_url');
      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      const isConfigured = evolutionAPIService.isConfigured();
      
      if (!isConfigured) {
        return res.json({ 
          isConfigured: false,
          status: 'not_configured'
        });
      }

      // Get instance status - handle 401 gracefully
      const statusResult = await evolutionAPIService.getInstanceStatus(instanceName?.value || '');
      
      console.log('📊 Evolution status result:', {
        statusResult,
        instanceName: instanceName?.value,
        connected: statusResult.status === 'open'
      });

      // Even if status check fails (401), return configured=true if credentials are set
      res.json({ 
        isConfigured: true,
        apiUrl: apiUrl?.value,
        instanceName: instanceName?.value,
        status: statusResult.status || 'unknown',
        connected: statusResult.status === 'open',
        statusCheckFailed: !statusResult.success
      });
    } catch (error) {
      console.error("Get Evolution API status error:", error);
      // Return configured status even if there's an error
      const apiUrl = await storage.getSystemSetting('evolution_api_url');
      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      res.json({ 
        isConfigured: evolutionAPIService.isConfigured(),
        apiUrl: apiUrl?.value,
        instanceName: instanceName?.value,
        status: 'error',
        connected: false,
        error: true
      });
    }
  });

  // Get current webhook configuration
  app.get("/api/admin/evolution/webhook-status", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      const webhookConfig = await evolutionAPIService.getWebhook(instanceName.value);

      if (webhookConfig.success) {
        res.json({ 
          success: true, 
          webhookUrl: webhookConfig.webhook?.webhook?.url || webhookConfig.webhook?.url || null,
          events: webhookConfig.webhook?.webhook?.events || webhookConfig.webhook?.events || [],
          enabled: webhookConfig.webhook?.webhook?.enabled || webhookConfig.webhook?.enabled || false,
          rawConfig: webhookConfig.webhook
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: webhookConfig.error || "Erro ao buscar configuração do webhook" 
        });
      }
    } catch (error) {
      console.error("Get webhook status error:", error);
      res.status(500).json({ error: "Erro ao buscar status do webhook" });
    }
  });

  // Force webhook reconfiguration with production URL
  app.post("/api/admin/evolution/fix-webhook", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      // Use production URL
      const productionUrl = 'https://chathonest.replit.app/api/evolution/webhook';
      const events = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];

      const result = await evolutionAPIService.setWebhook(
        instanceName.value, 
        productionUrl,
        events
      );

      if (result.success) {
        await storage.createAuditLog({
          userId: req.user!.id,
          action: "evolution_webhook_fixed",
          entityType: "whatsapp",
          entityId: instanceName.value,
          details: {
            webhookUrl: productionUrl,
            events
          }
        });

        res.json({ 
          success: true, 
          message: "Webhook reconfigurado com sucesso para produção",
          webhookUrl: productionUrl,
          events
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao reconfigurar webhook" 
        });
      }
    } catch (error) {
      console.error("Fix webhook error:", error);
      res.status(500).json({ error: "Erro ao reconfigurar webhook" });
    }
  });

  // Restart Evolution API connection (disconnect + reconnect to fix webhook issues)
  app.post("/api/admin/evolution/restart-connection", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      // Step 1: Disconnect
      console.log('🔄 Passo 1: Desconectando instância...');
      const logoutResult = await evolutionAPIService.logoutInstance(instanceName.value);
      
      if (!logoutResult.success) {
        return res.status(400).json({ 
          success: false, 
          error: `Erro ao desconectar: ${logoutResult.error}` 
        });
      }

      // Step 2: Wait 2 seconds
      console.log('⏳ Aguardando 2 segundos...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Reconnect and get QR Code
      console.log('🔄 Passo 2: Gerando novo QR Code...');
      const connectResult = await evolutionAPIService.getQRCode(instanceName.value);

      if (!connectResult.success || !connectResult.qrcode) {
        return res.status(400).json({ 
          success: false, 
          error: `Erro ao gerar QR Code: ${connectResult.error}` 
        });
      }

      // Step 4: Reconfigure webhook with production URL
      console.log('🔄 Passo 3: Reconfigurando webhook...');
      const productionUrl = 'https://chathonest.replit.app/api/evolution/webhook';
      const events = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];
      
      await evolutionAPIService.setWebhook(
        instanceName.value, 
        productionUrl,
        events
      );

      await storage.createAuditLog({
        userId: req.user!.id,
        action: "evolution_connection_restarted",
        entityType: "whatsapp",
        entityId: instanceName.value,
        details: {
          webhookUrl: productionUrl,
          events
        }
      });

      res.json({ 
        success: true, 
        message: "Conexão reiniciada com sucesso! Escaneie o novo QR Code.",
        qrcode: connectResult.qrcode
      });
    } catch (error) {
      console.error("Restart connection error:", error);
      res.status(500).json({ error: "Erro ao reiniciar conexão" });
    }
  });

  // Create/Connect Evolution API instance
  app.post("/api/admin/evolution/connect", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      // Try to get QR code first (works if instance already exists)
      let result = await evolutionAPIService.getQRCode(instanceName.value);
      
      // Check if already connected
      if (result.success && result.alreadyConnected) {
        return res.json({ 
          success: true, 
          alreadyConnected: true,
          message: "WhatsApp já está conectado! Nenhuma ação necessária." 
        });
      }
      
      // If getQRCode succeeded and has QR code, we're good - don't try to create!
      if (!result.success || !result.qrcode) {
        // getQRCode failed - check if instance exists
        const statusResult = await evolutionAPIService.getInstanceStatus(instanceName.value);
        
        // Only create if instance doesn't exist at all
        if (!statusResult.success) {
          const createResult = await evolutionAPIService.createInstance(instanceName.value);
          // Only overwrite result if creation succeeded
          if (createResult.success) {
            result = createResult;
          }
          // If creation failed, keep original getQRCode result
        }
      }

      if (result.success && result.qrcode) {
        // Set webhook URL for this instance
        // Use REPLIT_DEV_DOMAIN for the webhook URL (reliable in dev environment)
        const webhookUrl = process.env.REPLIT_DEV_DOMAIN 
          ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/evolution/webhook`
          : `${req.protocol}://${req.get('host')}/api/evolution/webhook`;
        await evolutionAPIService.setWebhook(
          instanceName.value, 
          webhookUrl,
          ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']
        );

        await storage.createAuditLog({
          userId: req.user!.id,
          action: "evolution_qr_generated",
          entityType: "whatsapp",
          entityId: instanceName.value,
        });

        res.json({ 
          success: true, 
          qrcode: result.qrcode,
          message: "QR Code gerado. Escaneie com WhatsApp." 
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao conectar instância" 
        });
      }
    } catch (error) {
      console.error("Connect Evolution instance error:", error);
      res.status(500).json({ error: "Erro ao conectar instância" });
    }
  });

  // Disconnect Evolution API instance
  app.post("/api/admin/evolution/disconnect", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      const result = await evolutionAPIService.logoutInstance(instanceName.value);

      if (result.success) {
        await storage.createAuditLog({
          userId: req.user!.id,
          action: "evolution_instance_disconnected",
          entityType: "whatsapp",
          entityId: instanceName.value,
        });

        res.json({ success: true, message: "Instância desconectada com sucesso" });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || "Erro ao desconectar" 
        });
      }
    } catch (error) {
      console.error("Disconnect Evolution instance error:", error);
      res.status(500).json({ error: "Erro ao desconectar instância" });
    }
  });

  // Reconfigure Evolution API Webhook (admin only)
  app.post("/api/evolution/reconfigure-webhook", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ error: "Evolution API não está configurada" });
      }

      const instanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (!instanceName) {
        return res.status(400).json({ error: "Nome da instância não configurado" });
      }

      // Use REPLIT_DEV_DOMAIN for the webhook URL (reliable in dev environment)
      const webhookUrl = process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/evolution/webhook`
        : `${req.protocol}://${req.get('host')}/api/evolution/webhook`;
      
      const events = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];
      
      console.log('🔄 Reconfigurando webhook:', { instanceName: instanceName.value, webhookUrl, events });
      
      const result = await evolutionAPIService.setWebhook(
        instanceName.value, 
        webhookUrl,
        events
      );

      if (!result.success) {
        console.error('❌ Webhook reconfigure failed:', result.error);
        return res.status(502).json({ 
          success: false, 
          error: result.error || "Erro ao reconfigurar webhook" 
        });
      }

      // Read back webhook configuration to verify
      const webhookConfig = await evolutionAPIService.getWebhook(instanceName.value);
      const effectiveEvents = webhookConfig.webhook?.webhook?.events || events;

      await storage.createAuditLog({
        userId: req.user!.id,
        action: "evolution_webhook_reconfigured",
        entityType: "whatsapp",
        entityId: instanceName.value,
        details: {
          webhookUrl,
          requestedEvents: events,
          effectiveEvents
        }
      });

      const response = { 
        success: true, 
        message: "Webhook reconfigurado com sucesso",
        webhookUrl,
        events: effectiveEvents
      };
      console.log('✅ Sending webhook reconfigure response:', response);
      return res.json(response);
    } catch (error) {
      console.error("Reconfigure webhook error:", error);
      return res.status(500).json({ error: "Erro ao reconfigurar webhook" });
    }
  });

  // Evolution API Webhook (for receiving messages)
  app.post("/api/evolution/webhook", async (req, res) => {
    try {
      // Sanitize webhook data for logging (remove sensitive info)
      const sanitizedBody = { ...req.body };
      if (sanitizedBody.apikey) delete sanitizedBody.apikey;
      console.log('📨 Evolution Webhook recebido:', JSON.stringify(sanitizedBody, null, 2));
      
      // DEBUG: Log webhook to audit for production troubleshooting
      try {
        await storage.createAuditLog({
          userId: 'system',
          action: 'evolution_webhook_received',
          entityType: 'webhook',
          entityId: sanitizedBody.event || 'unknown',
          details: sanitizedBody
        });
      } catch (auditError) {
        console.error('Failed to log webhook to audit:', auditError);
      }
      
      const webhookData = req.body as EvolutionWebhookData;
      
      // Handle different event types
      if (webhookData.event === 'MESSAGES_UPSERT' || webhookData.event === 'messages.upsert') {
        const message = webhookData.data;
        
        // Ignore messages sent by us (fromMe = true)
        if (message.key?.fromMe) {
          return res.status(200).send('OK');
        }

        // Extract phone number and message info
        const phone = evolutionAPIService.extractPhoneNumber(message.key.remoteJid);
        const messageText = evolutionAPIService.extractMessageText(message.message);
        const mediaInfo = evolutionAPIService.extractMediaInfo(message.message);
        const senderName = message.pushName || phone;

        console.log(`📩 Nova mensagem de ${senderName} (${phone}): ${messageText} [${mediaInfo.messageType}]`);
        if (mediaInfo.mediaUrl) {
          console.log(`📎 Mídia detectada: ${mediaInfo.messageType} - ${mediaInfo.mediaUrl}`);
        }

        // Find or create customer
        let customer = await storage.getCustomerByPhone(phone);
        
        if (!customer) {
          customer = await storage.createCustomer({
            name: senderName,
            phone: phone,
          });
          console.log(`✅ Novo cliente criado: ${customer.name} (${customer.phone})`);
        }

        // Find or reopen conversation - using single history per customer
        let conversation = await storage.getActiveConversationByCustomer(customer.id);
        
        if (!conversation) {
          // Check if there's a resolved conversation to reopen
          const lastConversation = await storage.getLastConversationByCustomer(customer.id);
          
          if (lastConversation && lastConversation.status === 'resolved') {
            // Reopen resolved conversation
            conversation = await storage.updateConversationStatus(lastConversation.id, 'new');
            console.log(`♻️ Conversa reaberta: ${conversation?.id}`);
            
            // Auto-assign to first available online agent
            const onlineAgents = await storage.getOnlineAgents();
            if (onlineAgents && onlineAgents.length > 0) {
              const agent = onlineAgents[0];
              const previousAgentId = conversation?.agentId;
              
              await storage.assignConversationToAgent(conversation!.id, agent.id);
              console.log(`✅ Conversa auto-atribuída ao agente ${agent.name} (${agent.id})`);
              
              // Add system message if agent changed
              if (previousAgentId && previousAgentId !== agent.id) {
                const previousAgent = await storage.getAgent(previousAgentId);
                await storage.createMessage({
                  conversationId: conversation!.id,
                  senderId: agent.id,
                  senderType: 'system',
                  content: `Atendimento transferido de ${previousAgent?.name || 'Agente anterior'} para ${agent.name}`,
                  messageType: 'text',
                  isRead: true,
                });
              } else {
                // First message after reopening
                await storage.createMessage({
                  conversationId: conversation!.id,
                  senderId: agent.id,
                  senderType: 'system',
                  content: `Conversa reaberta - Atendente: ${agent.name}`,
                  messageType: 'text',
                  isRead: true,
                });
              }
              
              conversation!.agentId = agent.id;
            }
          } else {
            // Create new conversation
            conversation = await storage.createConversation({
              customerId: customer.id,
              status: 'new',
              priority: 'normal',
            });
            console.log(`✅ Nova conversa criada: ${conversation.id}`);
            
            // Auto-assign to first available online agent
            const onlineAgents = await storage.getOnlineAgents();
            if (onlineAgents && onlineAgents.length > 0) {
              const agent = onlineAgents[0];
              await storage.assignConversationToAgent(conversation.id, agent.id);
              console.log(`✅ Conversa auto-atribuída ao agente ${agent.name} (${agent.id})`);
              
              // Add system message with agent name
              await storage.createMessage({
                conversationId: conversation.id,
                senderId: agent.id,
                senderType: 'system',
                content: `Atendimento iniciado - Atendente: ${agent.name}`,
                messageType: 'text',
                isRead: true,
              });
              
              conversation.agentId = agent.id;
            } else {
              console.log('⚠️ Nenhum agente online disponível para atribuição automática');
            }
          }
        }

        // Safety check
        if (!conversation) {
          console.error('❌ Erro: conversa não foi criada/encontrada');
          return res.status(500).send('Error: conversation not created');
        }

        // Create message with media info
        await storage.createMessage({
          conversationId: conversation.id,
          senderId: customer.id,
          senderType: 'customer',
          content: messageText,
          messageType: mediaInfo.messageType,
          mediaUrl: mediaInfo.mediaUrl,
          mediaType: mediaInfo.mediaType,
          mediaSize: mediaInfo.mediaSize,
          mediaFilename: mediaInfo.mediaFilename,
          isRead: false,
        });

        // Update conversation last message time
        await storage.updateConversationLastMessage(conversation.id);

        // Broadcast to WebSocket clients
        console.log(`📡 Broadcasting new message to ${wss.clients.size} WebSocket clients`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            console.log(`✅ Sending WebSocket message to client`);
            client.send(JSON.stringify({
              type: 'new_message',
              conversationId: conversation.id,
              customerId: customer.id,
            }));
          }
        });

        res.status(200).send('OK');
      } else if (webhookData.event === 'CONNECTION_UPDATE' || webhookData.event === 'connection.update') {
        console.log(`🔌 Status da conexão: ${webhookData.data.status}`);
        res.status(200).send('OK');
      } else {
        res.status(200).send('OK');
      }
    } catch (error) {
      console.error("Evolution webhook error:", error);
      res.status(500).send('Error processing webhook');
    }
  });

  // Sync all chats history from Evolution API (when connecting)
  app.post("/api/evolution/sync-all-chats", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get Evolution API instance name
      const instanceNameSetting = await storage.getSystemSetting('evolution_instance_name');
      if (!instanceNameSetting || !instanceNameSetting.value) {
        return res.status(400).json({ error: "Nome da instância Evolution não configurado" });
      }

      const instanceName = instanceNameSetting.value;

      console.log(`📥 Iniciando sincronização completa de todos os chats...`);

      // Fetch all chats from Evolution API
      const chatsResult = await evolutionAPIService.fetchAllChats(instanceName);
      
      if (!chatsResult.success || !chatsResult.chats) {
        return res.status(400).json({ 
          error: chatsResult.error || 'Erro ao buscar lista de chats' 
        });
      }

      const chats = chatsResult.chats;
      console.log(`📊 ${chats.length} conversas encontradas no WhatsApp`);

      let totalMessagesSynced = 0;
      let totalChatsSynced = 0;

      // Process each chat
      for (const chat of chats) {
        try {
          // Use remoteJid (with device suffix like :40) - don't normalize!
          const remoteJid = chat.remoteJid || chat.id?.remoteJid || chat.id;
          
          if (!remoteJid) {
            console.log(`⏭️ Pulando chat sem remoteJid válido`);
            continue;
          }
          
          console.log(`📱 Processando chat: ${remoteJid}`);
          
          // Fetch chat history using EXACT remoteJid (with device suffix)
          const historyResult = await evolutionAPIService.fetchChatHistory(instanceName, remoteJid);
          
          if (!historyResult.success || !historyResult.messages || historyResult.messages.length === 0) {
            console.log(`⏭️ Pulando chat ${remoteJid}: sem mensagens`);
            continue;
          }

          const messages = historyResult.messages;
          
          // Extract phone number for customer record (remove device suffix and @s.whatsapp.net)
          const phone = evolutionAPIService.extractPhoneNumber(remoteJid);
          let customer = await storage.getCustomerByPhone(phone);
          
          if (!customer) {
            customer = await storage.createCustomer({
              name: chat.name || messages[0]?.pushName || phone,
              phone: phone,
            });
          }

          // Find or create conversation
          let conversation = await storage.getActiveConversationByCustomer(customer.id);
          
          if (!conversation) {
            const lastConversation = await storage.getLastConversationByCustomer(customer.id);
            
            if (lastConversation) {
              conversation = await storage.updateConversationStatus(lastConversation.id, 'new');
            } else {
              conversation = await storage.createConversation({
                customerId: customer.id,
                status: 'new',
                priority: 'normal',
              });
            }
          }

          if (!conversation) {
            console.log(`❌ Erro ao criar conversa para ${phone}`);
            continue;
          }

          // Save historical messages
          for (const msg of messages) {
            const messageText = evolutionAPIService.extractMessageText(msg.message);
            const isFromCustomer = !msg.key?.fromMe;
            
            await storage.createMessage({
              conversationId: conversation.id,
              senderId: isFromCustomer ? customer.id : (conversation.agentId || customer.id),
              senderType: isFromCustomer ? 'customer' : 'agent',
              content: messageText,
              messageType: 'text',
              isRead: true,
            });
            totalMessagesSynced++;
          }

          totalChatsSynced++;
          console.log(`✅ Chat ${phone}: ${messages.length} mensagens sincronizadas`);
        } catch (chatError) {
          console.error(`❌ Erro ao processar chat:`, chatError);
          continue;
        }
      }

      console.log(`🎉 Sincronização completa: ${totalChatsSynced} chats, ${totalMessagesSynced} mensagens`);

      // Log the sync action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "all_chats_synced",
        entityType: "system",
        details: { 
          chatCount: totalChatsSynced,
          messageCount: totalMessagesSynced 
        },
      });

      res.json({ 
        success: true, 
        message: `Sincronização completa: ${totalChatsSynced} chats, ${totalMessagesSynced} mensagens`,
        chatCount: totalChatsSynced,
        messageCount: totalMessagesSynced
      });
    } catch (error) {
      console.error("Sync all chats error:", error);
      res.status(500).json({ error: "Erro ao sincronizar todos os chats" });
    }
  });

  // Sync chat history from Evolution API
  app.post("/api/evolution/sync-history", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { contactPhone } = req.body;
      
      if (!contactPhone) {
        return res.status(400).json({ error: "Telefone do contato é obrigatório" });
      }

      // Get Evolution API instance name
      const instanceNameSetting = await storage.getSystemSetting('evolution_instance_name');
      if (!instanceNameSetting || !instanceNameSetting.value) {
        return res.status(400).json({ error: "Nome da instância Evolution não configurado" });
      }

      const instanceName = instanceNameSetting.value;

      console.log(`📥 Iniciando sincronização de histórico para ${contactPhone}...`);

      // Fetch chat history from Evolution API
      const historyResult = await evolutionAPIService.fetchChatHistory(instanceName, contactPhone);
      
      if (!historyResult.success || !historyResult.messages) {
        return res.status(400).json({ 
          error: historyResult.error || 'Erro ao buscar histórico' 
        });
      }

      const messages = historyResult.messages;
      console.log(`📊 ${messages.length} mensagens encontradas no histórico`);

      // Find or create customer
      const phone = evolutionAPIService.extractPhoneNumber(contactPhone);
      let customer = await storage.getCustomerByPhone(phone);
      
      if (!customer) {
        // Create customer from first message
        const firstMessage = messages[0];
        customer = await storage.createCustomer({
          name: firstMessage?.pushName || phone,
          phone: phone,
        });
        console.log(`✅ Cliente criado: ${customer.name} (${customer.phone})`);
      }

      // Find or create conversation
      let conversation = await storage.getActiveConversationByCustomer(customer.id);
      
      if (!conversation) {
        const lastConversation = await storage.getLastConversationByCustomer(customer.id);
        
        if (lastConversation) {
          // Reopen last conversation
          conversation = await storage.updateConversationStatus(lastConversation.id, 'new');
          console.log(`♻️ Conversa reaberta para sincronização: ${conversation?.id}`);
        } else {
          // Create new conversation
          conversation = await storage.createConversation({
            customerId: customer.id,
            status: 'new',
            priority: 'normal',
          });
          console.log(`✅ Nova conversa criada para sincronização: ${conversation.id}`);
        }
      }

      if (!conversation) {
        return res.status(500).json({ error: 'Erro ao criar/encontrar conversa' });
      }

      // Process and save historical messages
      let savedCount = 0;
      for (const msg of messages) {
        const messageText = evolutionAPIService.extractMessageText(msg.message);
        const isFromCustomer = !msg.key?.fromMe;
        
        // Save message
        await storage.createMessage({
          conversationId: conversation.id,
          senderId: isFromCustomer ? customer.id : (conversation.agentId || customer.id),
          senderType: isFromCustomer ? 'customer' : 'agent',
          content: messageText,
          messageType: 'text',
          isRead: true, // Mark historical messages as read
        });
        savedCount++;
      }

      console.log(`✅ ${savedCount} mensagens históricas salvas no banco de dados`);

      // Log the sync action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "chat_history_synced",
        entityType: "conversation",
        entityId: conversation.id,
        details: { 
          contactPhone,
          messageCount: savedCount 
        },
      });

      res.json({ 
        success: true, 
        message: `${savedCount} mensagens sincronizadas com sucesso`,
        conversationId: conversation.id,
        customerId: customer.id,
        messageCount: savedCount
      });
    } catch (error) {
      console.error("Sync history error:", error);
      res.status(500).json({ error: "Erro ao sincronizar histórico" });
    }
  });

  // Auto-sync conversation history (available to all authenticated users)
  app.post("/api/conversations/:id/sync-history", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      
      // Get conversation with customer info
      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      // Check if Evolution API is configured
      if (!evolutionAPIService.isConfigured()) {
        return res.status(400).json({ 
          error: "Evolution API não está configurada",
          success: false 
        });
      }

      // Get Evolution API instance name
      const instanceNameSetting = await storage.getSystemSetting('evolution_instance_name');
      if (!instanceNameSetting || !instanceNameSetting.value) {
        return res.status(400).json({ 
          error: "Nome da instância Evolution não configurado",
          success: false 
        });
      }

      const instanceName = instanceNameSetting.value;

      // Get customer info
      const customer = await storage.getCustomerById(conversation.customerId);
      if (!customer || !customer.phone) {
        return res.status(400).json({ error: "Cliente não encontrado ou sem telefone" });
      }

      // Check if conversation already has messages
      const existingMessages = await storage.getMessagesByConversation(conversationId);
      if (existingMessages.length > 0) {
        return res.json({ 
          success: true,
          alreadySynced: true,
          message: "Conversa já possui mensagens",
          messageCount: existingMessages.length
        });
      }

      console.log(`📥 Auto-sincronizando histórico para conversa ${conversationId} (${customer.phone})...`);

      // Fetch chat history from Evolution API
      const historyResult = await evolutionAPIService.fetchChatHistory(instanceName, customer.phone);
      
      if (!historyResult.success || !historyResult.messages || historyResult.messages.length === 0) {
        return res.json({ 
          success: true,
          alreadySynced: false,
          message: 'Nenhuma mensagem histórica encontrada',
          messageCount: 0
        });
      }

      const messages = historyResult.messages;
      console.log(`📊 ${messages.length} mensagens encontradas no histórico`);

      // Process and save historical messages
      let savedCount = 0;
      for (const msg of messages) {
        const messageText = evolutionAPIService.extractMessageText(msg.message);
        const isFromCustomer = !msg.key?.fromMe;
        
        // Save message
        await storage.createMessage({
          conversationId: conversation.id,
          senderId: isFromCustomer ? customer.id : (conversation.agentId || customer.id),
          senderType: isFromCustomer ? 'customer' : 'agent',
          content: messageText,
          messageType: 'text',
          isRead: true, // Mark historical messages as read
        });
        savedCount++;
      }

      console.log(`✅ ${savedCount} mensagens históricas salvas no banco de dados`);

      // Log the sync action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "conversation_auto_synced",
        entityType: "conversation",
        entityId: conversation.id,
        details: { 
          customerPhone: customer.phone,
          messageCount: savedCount 
        },
      });

      res.json({ 
        success: true,
        alreadySynced: false,
        message: `${savedCount} mensagens sincronizadas com sucesso`,
        messageCount: savedCount
      });
    } catch (error) {
      console.error("Auto-sync history error:", error);
      res.status(500).json({ 
        success: false,
        error: "Erro ao sincronizar histórico" 
      });
    }
  });

  // Export conversations to Excel (admin only)
  app.get("/api/admin/export/conversations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "Data de início e fim são obrigatórias" });
      }

      // Get conversations data with all related information
      const conversationsData = await storage.getConversationsForExport(
        new Date(startDate as string),
        new Date(endDate as string)
      );

      // Prepare data for Excel
      const excelData = conversationsData.map((conv: any) => ({
        'ID da Conversa': conv.id,
        'Cliente': conv.customer.name,
        'Telefone': conv.customer.phone,
        'Agente': conv.agent?.name || 'ChatGPT',
        'Status': conv.status,
        'Data/Hora Início': conv.createdAt ? new Date(conv.createdAt).toLocaleString('pt-BR') : '',
        'Data/Hora Fim': conv.resolvedAt ? new Date(conv.resolvedAt).toLocaleString('pt-BR') : '',
        'Tempo Total (min)': conv.responseTime ? Math.round(conv.responseTime / 60) : 0,
        'Tempo de Espera (min)': conv.waitingTime ? Math.round(conv.waitingTime / 60) : 0,
        'Finalizada por Inatividade': conv.finishedByInactivity ? 'Sim' : 'Não',
        'Prioridade': conv.priority,
        'Total de Mensagens': conv.messageCount || 0,
      }));

      // Create workbook
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      
      // Set column widths
      const columnWidths = [
        { wch: 25 }, // ID da Conversa
        { wch: 20 }, // Cliente
        { wch: 15 }, // Telefone
        { wch: 15 }, // Agente
        { wch: 12 }, // Status
        { wch: 20 }, // Data/Hora Início
        { wch: 20 }, // Data/Hora Fim
        { wch: 15 }, // Tempo Total
        { wch: 15 }, // Tempo de Espera
        { wch: 18 }, // Finalizada por Inatividade
        { wch: 10 }, // Prioridade
        { wch: 15 }, // Total de Mensagens
      ];
      worksheet['!cols'] = columnWidths;

      XLSX.utils.book_append_sheet(workbook, worksheet, 'Conversas');

      // Generate buffer
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      // Set response headers for file download
      const fileName = `conversas_${startDate}_${endDate}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      // Log the export action
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "conversations_exported",
        entityType: "report",
        details: { 
          startDate, 
          endDate, 
          recordCount: conversationsData.length,
          fileName 
        },
      });

      res.send(buffer);
    } catch (error) {
      console.error("Export conversations error:", error);
      res.status(500).json({ error: "Erro ao exportar conversas" });
    }
  });

  // Get dashboard statistics (real data for charts)
  app.get("/api/admin/stats/dashboard", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { days = '30' } = req.query;
      const daysNumber = parseInt(days as string);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNumber);
      const endDate = new Date();

      const metrics = await storage.getConversationMetrics(startDate, endDate);
      
      res.json({
        period: `${daysNumber} dias`,
        ...metrics
      });
    } catch (error) {
      console.error("Get dashboard stats error:", error);
      res.status(500).json({ error: "Erro ao buscar estatísticas do dashboard" });
    }
  });

  // Get top customers statistics (admin only)
  app.get("/api/admin/stats/top-customers", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { days = '30', metric = 'conversations' } = req.query;
      
      const daysNumber = parseInt(days as string);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNumber);

      let topCustomers;
      if (metric === 'time') {
        topCustomers = await storage.getTopCustomersByTime(startDate, 10);
      } else {
        topCustomers = await storage.getTopCustomersByConversations(startDate, 10);
      }

      res.json({
        period: `${daysNumber} dias`,
        metric: metric === 'time' ? 'Tempo total em conversas' : 'Quantidade de conversas',
        customers: topCustomers
      });
    } catch (error) {
      console.error("Get top customers error:", error);
      res.status(500).json({ error: "Erro ao buscar estatísticas de clientes" });
    }
  });

  // REST API Routes (Protected)

  // Get dashboard statistics
  app.get("/api/stats", requireAuth, async (req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Failed to get statistics" });
    }
  });

  // Get conversations filtered by user role
  app.get("/api/conversations", requireAuth, async (req, res) => {
    try {
      // Admin vê todas as conversas, agent só vê as suas
      const conversations = await storage.getConversationsForUser(req.user!.id, req.user!.role);
      res.json(conversations);
    } catch (error) {
      res.status(500).json({ message: "Failed to get conversations" });
    }
  });

  // Get specific conversation with messages
  app.get("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationWithCustomer(req.params.id);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const messages = await storage.getConversationMessages(req.params.id);
      res.json({ conversation, messages });
    } catch (error) {
      res.status(500).json({ message: "Failed to get conversation" });
    }
  });

  // Search customers by name or phone
  app.get("/api/customers/search", requireAuth, async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ message: "Query parameter 'q' is required" });
      }
      
      const customers = await storage.searchCustomers(q);
      res.json(customers);
    } catch (error) {
      console.error("Search customers error:", error);
      res.status(500).json({ message: "Failed to search customers" });
    }
  });

  // Create new customer
  app.post("/api/customers", requireAuth, async (req, res) => {
    try {
      const customerData = insertCustomerSchema.parse(req.body);
      
      // Check if customer with this phone already exists
      const existingCustomer = await storage.getCustomerByPhone(customerData.phone);
      if (existingCustomer) {
        return res.status(409).json({ message: "Cliente com este número já existe", customer: existingCustomer });
      }
      
      const customer = await storage.createCustomer(customerData);
      res.json(customer);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Dados do cliente inválidos", errors: error.errors });
      } else {
        console.error("Create customer error:", error);
        res.status(500).json({ message: "Erro ao criar cliente" });
      }
    }
  });

  // Update customer
  app.put("/api/customers/:id", requireAuth, async (req, res) => {
    try {
      const customerId = req.params.id;
      const updateData = updateCustomerSchema.parse(req.body);
      
      // Check if customer exists
      const existingCustomer = await storage.getCustomer(customerId);
      if (!existingCustomer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      const updatedCustomer = await storage.updateCustomer(customerId, updateData);
      res.json(updatedCustomer);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Dados do cliente inválidos", errors: error.errors });
      } else {
        console.error("Update customer error:", error);
        res.status(500).json({ message: "Erro ao atualizar cliente" });
      }
    }
  });

  // Start new conversation with specific customer (agent initiated)
  app.post("/api/conversations/start", requireAuth, async (req, res) => {
    try {
      const { customerId, customerPhone, customerName } = req.body;
      
      if (!customerId && !customerPhone) {
        return res.status(400).json({ message: "Customer ID or phone is required" });
      }

      // Get customer by ID or phone
      let customer;
      if (customerId) {
        customer = await storage.getCustomer(customerId);
      } else if (customerPhone) {
        customer = await storage.getCustomerByPhone(customerPhone);
        if (!customer && customerName) {
          customer = await storage.createCustomer({ name: customerName, phone: customerPhone });
        }
      }

      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }

      // Check if there's already an active conversation with this customer
      const existingConversations = await storage.getConversationsWithCustomers();
      const activeConversation = existingConversations.find(conv => 
        conv.customer.id === customer.id && 
        (conv.status === 'new' || conv.status === 'in_progress' || conv.status === 'waiting')
      );

      if (activeConversation) {
        // Return existing conversation
        return res.json(activeConversation);
      }

      // Create new conversation
      const conversation = await storage.createConversation({
        customerId: customer.id,
        status: "new",
        priority: "normal",
      });

      // Get agent from authenticated user
      const agent = await storage.getAgentByUserId(req.user!.id);
      if (agent) {
        // Assign conversation to current agent
        await storage.assignConversationToAgent(conversation.id, agent.id);
        await storage.incrementAgentConversations(agent.id);
      }

      // Get conversation with customer data
      const conversationWithCustomer = await storage.getConversationWithCustomer(conversation.id);
      
      if (!conversationWithCustomer) {
        return res.status(500).json({ message: "Failed to create conversation" });
      }

      // Broadcast new conversation to WebSocket clients
      broadcast({ 
        type: 'new_conversation', 
        conversation: conversationWithCustomer 
      });

      res.json(conversationWithCustomer);
    } catch (error) {
      console.error("Start conversation error:", error);
      res.status(500).json({ message: "Failed to start conversation" });
    }
  });

  // Helper function to check if ChatGPT priority mode is enabled
  const isChatGPTPriorityEnabled = async (): Promise<boolean> => {
    try {
      const setting = await storage.getSystemSetting('chatgpt_priority_mode');
      return setting?.value === 'true';
    } catch (error) {
      console.error("Error checking ChatGPT priority mode:", error);
      return false;
    }
  };

  // Create new conversation (from WhatsApp webhook simulation)
  app.post("/api/conversations", async (req, res) => {
    try {
      const { customerPhone, customerName, message } = req.body;
      
      // Get or create customer
      let customer = await storage.getCustomerByPhone(customerPhone);
      if (!customer) {
        customer = await storage.createCustomer({ name: customerName, phone: customerPhone });
      }

      // Create conversation
      const conversation = await storage.createConversation({
        customerId: customer.id,
        status: "new",
        priority: "normal",
      });

      // Create initial message
      await storage.createMessage({
        conversationId: conversation.id,
        senderId: customer.id,
        senderType: "customer",
        content: message,
        messageType: "text",
        isRead: false,
      });

      // Check if ChatGPT priority mode is enabled
      const chatGPTPriorityEnabled = await isChatGPTPriorityEnabled();
      console.log("ChatGPT Priority Mode enabled:", chatGPTPriorityEnabled);

      // Try to auto-assign to ChatGPT first, then to human agents
      const botAgent = await storage.getBotAgent();
      console.log("Bot agent found:", botAgent?.name);
      
      // Determine if should assign to bot based on priority mode or normal logic
      let shouldAssignToBot = false;
      if (chatGPTPriorityEnabled) {
        // In priority mode, always try ChatGPT first
        shouldAssignToBot = botAgent !== undefined;
        console.log("Priority mode: assigning to bot if available:", shouldAssignToBot);
      } else {
        // Normal mode: use existing logic
        shouldAssignToBot = await chatGPTService.shouldAutoAssignToChatGPT(message);
        console.log("Normal mode: should assign to bot:", shouldAssignToBot, "for message:", message);
      }
      
      if (botAgent && shouldAssignToBot) {
        await storage.assignConversationToAgent(conversation.id, botAgent.id);
        
        // Generate automatic response from ChatGPT
        setTimeout(async () => {
          try {
            console.log("Starting ChatGPT response generation for conversation:", conversation.id);
            const conversationMessages = await storage.getConversationMessages(conversation.id);
            console.log("Got conversation messages, generating response...");
            const { response, shouldTransferToHuman } = await chatGPTService.generateResponse(
              message,
              conversationMessages,
              customer
            );
            console.log("ChatGPT response generated:", response.substring(0, 50) + "...");

            // Send ChatGPT response
            const botMessage = await storage.createMessage({
              conversationId: conversation.id,
              senderId: botAgent.id,
              senderType: "agent",
              content: response,
              messageType: "text",
              isRead: true,
            });

            const messageWithSender = await storage.getConversationMessages(conversation.id);
            const newMessage = messageWithSender[messageWithSender.length - 1];

            // Broadcast the bot response
            broadcast({ 
              type: 'new_message', 
              message: newMessage,
              conversationId: conversation.id
            });

            // If ChatGPT determined to transfer to human
            if (shouldTransferToHuman) {
              const onlineHumanAgents = await storage.getOnlineHumanAgents();
              if (onlineHumanAgents.length > 0) {
                const leastBusyAgent = onlineHumanAgents.reduce((prev, current) => 
                  prev.activeConversations < current.activeConversations ? prev : current
                );
                
                await storage.assignConversationToAgent(conversation.id, leastBusyAgent.id);
                
                // Send transfer notification
                const transferMessage = await storage.createMessage({
                  conversationId: conversation.id,
                  senderId: botAgent.id,
                  senderType: "system",
                  content: `Conversa transferida para ${leastBusyAgent.name}`,
                  messageType: "text",
                  isRead: true,
                });

                const transferNotification = await storage.getConversationMessages(conversation.id);
                const lastTransferMessage = transferNotification[transferNotification.length - 1];

                broadcast({ 
                  type: 'new_message', 
                  message: lastTransferMessage,
                  conversationId: conversation.id
                });

                const updatedConversation = await storage.getConversationWithCustomer(conversation.id);
                broadcast({ 
                  type: 'conversation_assigned', 
                  conversation: updatedConversation 
                });
              }
            }
          } catch (error) {
            console.error("Error generating ChatGPT response:", error);
            console.error("Error details:", error.message);
          }
        }, 1000); // 1 second delay to simulate typing
      } else {
        // Assign to human agent
        const onlineHumanAgents = await storage.getOnlineHumanAgents();
        if (onlineHumanAgents.length > 0) {
          const leastBusyAgent = onlineHumanAgents.reduce((prev, current) => 
            prev.activeConversations < current.activeConversations ? prev : current
          );
          
          await storage.assignConversationToAgent(conversation.id, leastBusyAgent.id);
        }
      }

      const conversationWithCustomer = await storage.getConversationWithCustomer(conversation.id);
      
      // Broadcast new conversation to all connected clients
      broadcast({ 
        type: 'new_conversation', 
        conversation: conversationWithCustomer 
      });

      res.json(conversationWithCustomer);
    } catch (error) {
      res.status(500).json({ message: "Failed to create conversation" });
    }
  });

  // Assign conversation to agent
  app.post("/api/conversations/:id/assign", async (req, res) => {
    try {
      const { agentId } = req.body;
      const conversation = await storage.assignConversationToAgent(req.params.id, agentId);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const conversationWithCustomer = await storage.getConversationWithCustomer(req.params.id);
      
      // Broadcast assignment update
      broadcast({ 
        type: 'conversation_assigned', 
        conversation: conversationWithCustomer 
      });

      res.json(conversationWithCustomer);
    } catch (error) {
      res.status(500).json({ message: "Failed to assign conversation" });
    }
  });

  // Transfer conversation from bot to human agent
  app.post("/api/conversations/:id/transfer-to-human", async (req, res) => {
    try {
      const { id } = req.params;
      
      const conversation = await storage.getConversationWithCustomer(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Check if currently assigned to bot
      if (conversation.agent?.type !== "bot") {
        return res.status(400).json({ error: "Conversation is not currently with ChatGPT" });
      }

      // Find available human agents
      const onlineHumanAgents = await storage.getOnlineHumanAgents();
      if (onlineHumanAgents.length === 0) {
        return res.status(400).json({ error: "No human agents available" });
      }

      // Assign to least busy human agent
      const leastBusyAgent = onlineHumanAgents.reduce((prev, current) => 
        prev.activeConversations < current.activeConversations ? prev : current
      );

      await storage.assignConversationToAgent(id, leastBusyAgent.id);

      // Send transfer notification
      const botAgent = await storage.getBotAgent();
      if (botAgent) {
        await storage.createMessage({
          conversationId: id,
          senderId: botAgent.id,
          senderType: "system",
          content: `Conversa transferida para ${leastBusyAgent.name}`,
          messageType: "text",
          isRead: true,
        });

        const messages = await storage.getConversationMessages(id);
        const transferMessage = messages[messages.length - 1];

        broadcast({ 
          type: 'new_message', 
          message: transferMessage,
          conversationId: id
        });
      }

      const updatedConversation = await storage.getConversationWithCustomer(id);
      broadcast({ type: 'conversation_assigned', conversation: updatedConversation });
      
      res.json(updatedConversation);
    } catch (error) {
      console.error("Error transferring conversation to human:", error);
      res.status(500).json({ error: "Failed to transfer conversation" });
    }
  });

  // Transfer conversation to specific agent (agents can transfer their own, admins can transfer any)
  app.post("/api/conversations/:id/transfer", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { targetAgentId } = req.body;
      const currentUser = req.user!;
      
      if (!targetAgentId) {
        return res.status(400).json({ error: "Target agent ID is required" });
      }

      const conversation = await storage.getConversationWithCustomer(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Get current user's agent (if they are an agent)
      const currentAgent = await storage.getAgentByUserId(currentUser.id);
      
      // Authorization check: admin can transfer any conversation, agent can only transfer their own
      if (currentUser.role !== 'admin') {
        if (!currentAgent) {
          return res.status(403).json({ error: "Only agents can transfer conversations" });
        }
        if (conversation.agentId !== currentAgent.id) {
          return res.status(403).json({ error: "You can only transfer conversations assigned to you" });
        }
      }

      // Validate target agent
      const targetAgent = await storage.getAgent(targetAgentId);
      if (!targetAgent || targetAgent.type !== 'human') {
        return res.status(400).json({ error: "Target agent not found or is not a human agent" });
      }

      // Check if target agent is online
      if (targetAgent.status !== 'online') {
        return res.status(400).json({ error: "Target agent is not online" });
      }

      // Prevent self-transfer
      if (currentAgent && targetAgentId === currentAgent.id) {
        return res.status(400).json({ error: "Cannot transfer conversation to yourself" });
      }

      if (!conversation.agentId) {
        return res.status(400).json({ error: "Conversation is not assigned to any agent" });
      }

      // Use the new transferConversation method
      const updatedConversation = await storage.transferConversation(
        id, 
        conversation.agentId, 
        targetAgentId
      );

      // Broadcast conversation transfer
      broadcast({ 
        type: 'conversation_transferred', 
        conversationId: id,
        fromAgentId: conversation.agentId,
        toAgentId: targetAgentId,
        conversation: updatedConversation 
      });

      res.json(updatedConversation);
    } catch (error) {
      console.error("Error transferring conversation:", error);
      if (error instanceof Error) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to transfer conversation" });
    }
  });

  // Pull conversation to self (admin only)
  app.post("/api/conversations/:id/pull", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const currentUser = req.user!;
      
      const conversation = await storage.getConversationWithCustomer(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Buscar agente do usuário admin
      const adminAgent = await storage.getAgentByUserId(currentUser.id);
      if (!adminAgent) {
        return res.status(400).json({ error: "Admin user does not have an agent profile" });
      }

      // Se já está com este agente, não fazer nada
      if (conversation.agentId === adminAgent.id) {
        return res.status(400).json({ error: "Conversation is already assigned to you" });
      }

      // Decrementar contador do agente atual (se houver)
      if (conversation.agentId) {
        await storage.decrementAgentConversations(conversation.agentId);
      }

      // Atribuir para o admin
      await storage.assignConversationToAgent(id, adminAgent.id);

      // Criar mensagem de sistema
      await storage.createMessage({
        conversationId: id,
        senderId: currentUser.id,
        senderType: "system",
        content: `Conversa assumida por ${adminAgent.name}`,
        messageType: "text",
        isRead: true,
      });

      const messages = await storage.getConversationMessages(id);
      const pullMessage = messages[messages.length - 1];

      broadcast({ 
        type: 'new_message', 
        message: pullMessage,
        conversationId: id
      });

      const updatedConversation = await storage.getConversationWithCustomer(id);
      broadcast({ type: 'conversation_assigned', conversation: updatedConversation });

      // Log da ação
      await storage.createAuditLog({
        userId: currentUser.id,
        action: "conversation_pulled",
        entityType: "conversation",
        entityId: id,
        details: {
          fromAgentId: conversation.agentId,
          pulledBy: currentUser.username,
        },
      });
      
      res.json(updatedConversation);
    } catch (error) {
      console.error("Error pulling conversation:", error);
      res.status(500).json({ error: "Failed to pull conversation" });
    }
  });

  // Update conversation status
  app.patch("/api/conversations/:id", async (req, res) => {
    try {
      const { status } = req.body;
      const conversation = await storage.updateConversationStatus(req.params.id, status);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (status === "resolved" && conversation.agentId) {
        await storage.decrementAgentConversations(conversation.agentId);
      }

      const conversationWithCustomer = await storage.getConversationWithCustomer(req.params.id);
      
      // Broadcast status update
      broadcast({ 
        type: 'conversation_status_update', 
        conversation: conversationWithCustomer 
      });

      res.json(conversationWithCustomer);
    } catch (error) {
      res.status(500).json({ message: "Failed to update conversation" });
    }
  });

  // Reopen a resolved conversation
  app.post("/api/conversations/:id/reopen", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      const currentUser = req.user!;
      
      const conversation = await storage.getConversationWithCustomer(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      if (conversation.status !== "resolved") {
        return res.status(400).json({ error: "Apenas conversas finalizadas podem ser reabertas" });
      }

      if (!conversation.agentId) {
        return res.status(400).json({ error: "Conversa não tem agente atribuído" });
      }

      // Reopen conversation with status "in-progress" keeping the same agent
      await db
        .update(conversations)
        .set({ 
          status: "in-progress",
          lastAgentResponseTime: new Date()
        })
        .where(eq(conversations.id, conversationId));

      // Increment agent conversations count
      await storage.incrementAgentConversations(conversation.agentId);

      // Create system message
      await storage.createMessage({
        conversationId,
        senderId: conversation.agentId,
        senderType: "system",
        content: `Conversa reaberta por ${currentUser.username}`,
        messageType: "text",
        isRead: true,
      });

      const updatedConversation = await storage.getConversationWithCustomer(conversationId);

      // Broadcast update
      broadcast({ 
        type: 'conversation_reopened', 
        conversation: updatedConversation 
      });

      // Log da ação
      await storage.createAuditLog({
        userId: currentUser.id,
        action: "conversation_reopened",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          reopenedBy: currentUser.username,
          agentId: conversation.agentId,
        },
      });

      res.json(updatedConversation);
    } catch (error) {
      console.error("Error reopening conversation:", error);
      res.status(500).json({ error: "Erro ao reabrir conversa" });
    }
  });

  // Send message
  app.post("/api/conversations/:id/messages", async (req, res) => {
    try {
      const messageData = insertMessageSchema.parse({
        ...req.body,
        conversationId: req.params.id,
      });

      const message = await storage.createMessage(messageData);
      const messageWithSender = await storage.getConversationMessages(req.params.id);
      const newMessage = messageWithSender[messageWithSender.length - 1];

      // Update conversation status if agent is responding
      if (messageData.senderType === "agent") {
        const conversation = await storage.getConversationWithCustomer(req.params.id);
        
        // Auto-assign conversation if not assigned yet
        if (conversation && !conversation.agentId && messageData.senderId) {
          await storage.assignConversationToAgent(req.params.id, messageData.senderId);
          console.log(`✅ Conversa auto-atribuída ao agente ${messageData.senderId}`);
        }
        
        await storage.updateConversationStatus(req.params.id, "in-progress");
        
        // Send message via WhatsApp when agent responds
        try {
          if (conversation && conversation.customer) {
            const customerPhone = conversation.customer.phone;
            
            // Handle different message types
            if (messageData.messageType === 'location' && messageData.latitude && messageData.longitude) {
              // Send location
              console.log(`📍 Enviando localização para ${customerPhone}`);
              
              let sent = false;
              
              // Try Evolution API first
              const evolutionConfig = await storage.getSystemSetting('evolution_instance_name');
              if (evolutionConfig && evolutionConfig.value) {
                const result = await evolutionAPIService.sendLocationMessage(
                  evolutionConfig.value,
                  customerPhone,
                  parseFloat(messageData.latitude),
                  parseFloat(messageData.longitude),
                  messageData.locationName
                );
                if (result.success) {
                  console.log(`✅ Localização enviada via Evolution API`);
                  sent = true;
                } else {
                  console.log(`⚠️ Evolution API falhou: ${result.error}`);
                }
              }
              
              // Fallback to WhatsApp Official API
              if (!sent && whatsappOfficialAPI.isConfigured()) {
                console.log(`🔄 Tentando WhatsApp Official API...`);
                const result = await whatsappOfficialAPI.sendLocationMessage(
                  customerPhone,
                  parseFloat(messageData.latitude),
                  parseFloat(messageData.longitude),
                  messageData.locationName
                );
                if (result.error) {
                  console.log(`⚠️ WhatsApp Official API falhou: ${result.error}`);
                } else {
                  console.log(`✅ Localização enviada via WhatsApp Official API`);
                  sent = true;
                }
              }
              
              // Final fallback: send text with link
              if (!sent) {
                await whatsappService.sendMessage(customerPhone, `Localização: https://www.google.com/maps?q=${messageData.latitude},${messageData.longitude}`);
              }
            } else if (messageData.mediaUrl && (messageData.messageType === 'image' || messageData.messageType === 'audio' || messageData.messageType === 'video' || messageData.messageType === 'document')) {
              // Send media file
              console.log(`📎 Enviando ${messageData.messageType} para ${customerPhone}`);
              
              // Build full URL for media
              const baseUrl = process.env.REPLIT_DEV_DOMAIN ? 
                `https://${process.env.REPLIT_DEV_DOMAIN}` : 
                `http://localhost:${process.env.PORT || 5000}`;
              const fullMediaUrl = messageData.mediaUrl.startsWith('http') ? 
                messageData.mediaUrl : 
                `${baseUrl}${messageData.mediaUrl}`;
              
              let sent = false;
              
              // Try Evolution API first
              const evolutionConfig = await storage.getSystemSetting('evolution_instance_name');
              if (evolutionConfig && evolutionConfig.value) {
                const result = await evolutionAPIService.sendMediaMessage(
                  evolutionConfig.value,
                  customerPhone,
                  fullMediaUrl,
                  messageData.content || undefined,
                  messageData.messageType as 'image' | 'audio' | 'video' | 'document'
                );
                if (result.success) {
                  console.log(`✅ ${messageData.messageType} enviado via Evolution API`);
                  sent = true;
                } else {
                  console.log(`⚠️ Evolution API falhou: ${result.error}`);
                }
              }
              
              // Fallback to WhatsApp Official API
              if (!sent && whatsappOfficialAPI.isConfigured()) {
                console.log(`🔄 Tentando WhatsApp Official API...`);
                const result = await whatsappOfficialAPI.sendMediaMessage(
                  customerPhone,
                  fullMediaUrl,
                  messageData.messageType as 'image' | 'audio' | 'video' | 'document',
                  messageData.content || undefined
                );
                if (result.error) {
                  console.log(`⚠️ WhatsApp Official API falhou: ${result.error}`);
                } else {
                  console.log(`✅ ${messageData.messageType} enviado via WhatsApp Official API`);
                  sent = true;
                }
              }
              
              // Final fallback: send text with link
              if (!sent) {
                await whatsappService.sendMessage(customerPhone, `${messageData.content || 'Arquivo'}: ${fullMediaUrl}`);
              }
            } else {
              // Send text message
              console.log(`📤 Enviando mensagem do agente para ${customerPhone}: "${messageData.content}"`);
              await whatsappService.sendMessage(customerPhone, messageData.content);
              console.log(`✅ Mensagem enviada via WhatsApp para ${customerPhone}`);
            }
          }
        } catch (whatsappError) {
          console.error("❌ Erro ao enviar mensagem via WhatsApp:", whatsappError);
          // Continue even if WhatsApp send fails - message is still saved
        }
      }

      // Broadcast new message
      broadcast({ 
        type: 'new_message', 
        message: newMessage,
        conversationId: req.params.id
      });

      res.json(newMessage);
    } catch (error) {
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  // Get all agents
  app.get("/api/agents", requireAuth, async (req, res) => {
    try {
      const agents = await storage.getAllAgents();
      res.json(agents);
    } catch (error) {
      res.status(500).json({ message: "Failed to get agents" });
    }
  });

  // Get online agents (for conversation transfer)
  app.get("/api/agents/online", requireAuth, async (req, res) => {
    try {
      const onlineAgents = await storage.getOnlineHumanAgents();
      res.json(onlineAgents);
    } catch (error) {
      res.status(500).json({ message: "Failed to get online agents" });
    }
  });

  // Update OpenAI API key
  app.post("/api/settings/openai-key", async (req, res) => {
    try {
      const { apiKey } = req.body;
      
      if (!apiKey || typeof apiKey !== 'string' || (!apiKey.startsWith('sk-') && !apiKey.startsWith('asst-') && !apiKey.startsWith('asst_'))) {
        return res.status(400).json({ error: "Chave da API inválida. Deve começar com 'sk-', 'asst-' ou 'asst_'" });
      }

      // Update the API key in the ChatGPT service
      chatGPTService.updateApiKey(apiKey);
      
      res.json({ success: true, message: "Chave da API atualizada com sucesso" });
    } catch (error) {
      console.error("Error updating API key:", error);
      res.status(500).json({ error: "Erro ao atualizar a chave da API" });
    }
  });

  // Test OpenAI connection
  app.post("/api/settings/test-openai", async (req, res) => {
    try {
      const isWorking = await chatGPTService.testConnection();
      
      if (isWorking) {
        res.json({ success: true, message: "Conexão com ChatGPT funcionando corretamente" });
      } else {
        res.status(400).json({ error: "Não foi possível conectar com a API do OpenAI. Verifique a chave da API." });
      }
    } catch (error) {
      console.error("Error testing OpenAI connection:", error);
      res.status(500).json({ error: "Erro ao testar a conexão com a API" });
    }
  });

  // Toggle ChatGPT assistant online/offline status
  app.post("/api/settings/toggle-assistant", async (req, res) => {
    try {
      const { isOnline } = req.body;
      
      if (typeof isOnline !== 'boolean') {
        return res.status(400).json({ error: "Status deve ser um valor booleano" });
      }

      chatGPTService.setOnlineStatus(isOnline);
      
      res.json({ 
        success: true, 
        message: `Assistente ChatGPT ${isOnline ? 'ativado' : 'desativado'} com sucesso`,
        isOnline 
      });
    } catch (error) {
      console.error("Error toggling assistant status:", error);
      res.status(500).json({ error: "Erro ao alterar status do assistente" });
    }
  });

  // Get ChatGPT assistant status
  app.get("/api/settings/assistant-status", async (req, res) => {
    try {
      const isOnline = chatGPTService.getOnlineStatus();
      const canHandle = chatGPTService.canHandleNewConversations();
      
      res.json({ 
        isOnline,
        canHandleConversations: canHandle
      });
    } catch (error) {
      console.error("Error getting assistant status:", error);
      res.status(500).json({ error: "Erro ao obter status do assistente" });
    }
  });

  // Simulate incoming WhatsApp message (for testing)
  app.post("/api/webhook/whatsapp", async (req, res) => {
    try {
      const { from, body } = req.body;
      
      // Extract customer info (simplified)
      const customerPhone = from;
      const customerName = req.body.name || `Customer ${from.slice(-4)}`;
      
      // Get or create customer
      let customer = await storage.getCustomerByPhone(customerPhone);
      if (!customer) {
        customer = await storage.createCustomer({ name: customerName, phone: customerPhone });
      }

      // Find existing open conversation or create new one
      const existingConversations = await storage.getConversationsWithCustomers();
      let conversation = existingConversations.find(c => 
        c.customerId === customer.id && 
        (c.status === "new" || c.status === "assigned" || c.status === "in-progress")
      );

      if (!conversation) {
        const newConv = await storage.createConversation({
          customerId: customer.id,
          status: "new",
          priority: body.toLowerCase().includes("urgente") ? "urgent" : "normal",
        });
        conversation = await storage.getConversationWithCustomer(newConv.id);
      }

      // Create message
      const message = await storage.createMessage({
        conversationId: conversation!.id,
        senderId: customer.id,
        senderType: "customer",
        content: body,
        messageType: "text",
        isRead: false,
      });

      // Auto-assign if no agent assigned - prioritize ChatGPT for appropriate messages
      if (!conversation!.agentId) {
        const botAgent = await storage.getBotAgent();
        if (botAgent && await chatGPTService.shouldAutoAssignToChatGPT(body)) {
          await storage.assignConversationToAgent(conversation!.id, botAgent.id);
          conversation = await storage.getConversationWithCustomer(conversation!.id);
          
          // Generate automatic response from ChatGPT
          setTimeout(async () => {
            try {
              const conversationMessages = await storage.getConversationMessages(conversation!.id);
              const { response, shouldTransferToHuman } = await chatGPTService.generateResponse(
                body,
                conversationMessages,
                customer
              );

              // Send ChatGPT response
              const botMessage = await storage.createMessage({
                conversationId: conversation!.id,
                senderId: botAgent.id,
                senderType: "agent",
                content: response,
                messageType: "text",
                isRead: true,
              });

              const messageWithSender = await storage.getConversationMessages(conversation!.id);
              const botResponse = messageWithSender[messageWithSender.length - 1];

              // Broadcast the bot response
              broadcast({ 
                type: 'new_message', 
                message: botResponse,
                conversationId: conversation!.id
              });

              // If ChatGPT determined to transfer to human
              if (shouldTransferToHuman) {
                const onlineHumanAgents = await storage.getOnlineHumanAgents();
                if (onlineHumanAgents.length > 0) {
                  const leastBusyAgent = onlineHumanAgents.reduce((prev, current) => 
                    prev.activeConversations < current.activeConversations ? prev : current
                  );
                  
                  await storage.assignConversationToAgent(conversation!.id, leastBusyAgent.id);
                  
                  // Send transfer notification
                  const transferMessage = await storage.createMessage({
                    conversationId: conversation!.id,
                    senderId: botAgent.id,
                    senderType: "system",
                    content: `Conversa transferida para ${leastBusyAgent.name}`,
                    messageType: "text",
                    isRead: true,
                  });

                  const transferNotification = await storage.getConversationMessages(conversation!.id);
                  const lastTransferMessage = transferNotification[transferNotification.length - 1];

                  broadcast({ 
                    type: 'new_message', 
                    message: lastTransferMessage,
                    conversationId: conversation!.id
                  });

                  const updatedConversation = await storage.getConversationWithCustomer(conversation!.id);
                  broadcast({ 
                    type: 'conversation_assigned', 
                    conversation: updatedConversation 
                  });
                }
              }
            } catch (error) {
              console.error("Error generating ChatGPT response in webhook:", error);
            }
          }, 1500); // 1.5 second delay to simulate typing
        } else {
          // Assign to human agent
          const onlineHumanAgents = await storage.getOnlineHumanAgents();
          if (onlineHumanAgents.length > 0) {
            const leastBusyAgent = onlineHumanAgents.reduce((prev, current) => 
              prev.activeConversations < current.activeConversations ? prev : current
            );
            
            await storage.assignConversationToAgent(conversation!.id, leastBusyAgent.id);
            conversation = await storage.getConversationWithCustomer(conversation!.id);
          }
        }
      }

      const messageWithSender = await storage.getConversationMessages(conversation!.id);
      const newMessage = messageWithSender[messageWithSender.length - 1];

      // Broadcast updates
      broadcast({ 
        type: 'new_message', 
        message: newMessage,
        conversationId: conversation!.id
      });
      
      broadcast({ 
        type: 'conversation_update', 
        conversation 
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to process webhook" });
    }
  });

  // WhatsApp Business API Routes

  // Get WhatsApp connection status
  app.get("/api/whatsapp/status", requireAuth, async (req, res) => {
    try {
      const status = await whatsappService.getStatus();
      res.json(status);
    } catch (error) {
      console.error("Error getting WhatsApp status:", error);
      res.status(500).json({ error: "Erro ao obter status do WhatsApp" });
    }
  });

  // Generate QR Code for WhatsApp connection
  app.post("/api/whatsapp/generate-qr", requireAuth, async (req, res) => {
    try {
      const qrCodeData = await whatsappService.generateQRCode();
      
      // Extract base64 data from data URL if it's a data URL
      const qrCodeBase64 = qrCodeData.startsWith('data:') 
        ? qrCodeData.replace(/^data:image\/png;base64,/, '')
        : qrCodeData;
      
      res.json({ 
        success: true, 
        qrCode: qrCodeBase64,
        message: "QR Code gerado com sucesso. Escaneie com seu WhatsApp para conectar."
      });
    } catch (error) {
      console.error("Error generating QR code:", error);
      res.status(500).json({ error: error.message || "Erro ao gerar QR Code" });
    }
  });

  // Disconnect WhatsApp Business
  app.post("/api/whatsapp/disconnect", requireAuth, async (req, res) => {
    try {
      await whatsappService.disconnect();
      
      res.json({ 
        success: true, 
        message: "WhatsApp Business desconectado com sucesso" 
      });
    } catch (error) {
      console.error("Error disconnecting WhatsApp:", error);
      res.status(500).json({ error: "Erro ao desconectar WhatsApp" });
    }
  });

  // Send WhatsApp message (for outbound messages)
  app.post("/api/whatsapp/send", requireAuth, async (req, res) => {
    try {
      const { to, message, conversationId } = req.body;
      
      if (!to || !message) {
        return res.status(400).json({ error: "Destinatário e mensagem são obrigatórios" });
      }
      
      // Check if WhatsApp is connected
      const status = await whatsappService.getStatus();
      if (status.status !== 'connected') {
        return res.status(400).json({ error: "WhatsApp não está conectado" });
      }
      
      // Send message through WhatsApp service
      await whatsappService.sendMessage(to, message);
      
      res.json({ 
        success: true, 
        messageId: `msg_${Date.now()}`,
        message: "Mensagem enviada com sucesso" 
      });
    } catch (error) {
      console.error("Error sending WhatsApp message:", error);
      res.status(500).json({ error: error.message || "Erro ao enviar mensagem" });
    }
  });

  // Get hybrid WhatsApp status (Evolution + Official + Simulation)
  app.get("/api/whatsapp/hybrid-status", requireAuth, async (req, res) => {
    try {
      const hybridStatus = await whatsappService.getHybridStatus();
      res.json(hybridStatus);
    } catch (error) {
      console.error("Error getting hybrid WhatsApp status:", error);
      res.status(500).json({ error: "Erro ao obter status híbrido do WhatsApp" });
    }
  });

  // Test message sending (admin only) - sends via configured provider
  app.post("/api/whatsapp/test-message", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { to, message } = req.body;
      
      if (!to || !message) {
        return res.status(400).json({ error: "Destinatário e mensagem são obrigatórios" });
      }
      
      const result = await whatsappService.sendMessage(to, message);
      
      res.json({ 
        success: true, 
        provider: result.provider,
        message: `Mensagem enviada com sucesso via ${result.provider}`
      });
    } catch (error) {
      console.error("Error sending test message:", error);
      res.status(500).json({ error: error.message || "Erro ao enviar mensagem de teste" });
    }
  });

  // Telegram Bot routes
  app.get('/api/telegram/status', requireAuth, async (req, res) => {
    try {
      const status = telegramService.getStatus();
      res.json(status);
    } catch (error) {
      console.error('Error getting Telegram status:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  app.post('/api/telegram/generate-setup-qr', requireAuth, async (req, res) => {
    try {
      const qrCode = await telegramService.generateSetupQR();
      res.json({
        success: true,
        qrCode: qrCode,
        message: "QR Code de configuração gerado. Escaneie para ver as instruções de setup do bot."
      });
    } catch (error: any) {
      console.error('Error generating Telegram setup QR:', error);
      res.status(500).json({
        error: error.message || 'Erro ao gerar QR Code de configuração'
      });
    }
  });

  app.post('/api/telegram/connect', requireAuth, async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: 'Token do bot é obrigatório' });
      }
      
      await telegramService.connectWithToken(token);
      res.json({
        success: true,
        message: "Bot Telegram conectado com sucesso"
      });
    } catch (error: any) {
      console.error('Error connecting Telegram bot:', error);
      res.status(500).json({
        error: error.message || 'Erro ao conectar bot Telegram'
      });
    }
  });

  app.post('/api/telegram/disconnect', requireAuth, async (req, res) => {
    try {
      await telegramService.disconnect();
      res.json({
        success: true,
        message: "Bot Telegram desconectado com sucesso"
      });
    } catch (error: any) {
      console.error('Error disconnecting Telegram bot:', error);
      res.status(500).json({
        error: error.message || 'Erro ao desconectar bot Telegram'
      });
    }
  });

  app.post('/api/telegram/send', requireAuth, async (req, res) => {
    try {
      const { to, message, conversationId } = req.body;
      
      if (!to || !message) {
        return res.status(400).json({ error: "Destinatário e mensagem são obrigatórios" });
      }
      
      // Check if Telegram is connected
      const status = telegramService.getStatus();
      if (status.status !== 'connected') {
        return res.status(400).json({ error: "Bot Telegram não está conectado" });
      }
      
      // Send message through Telegram service
      await telegramService.sendMessage(to, message);
      
      res.json({ 
        success: true, 
        messageId: `msg_${Date.now()}`,
        message: "Mensagem enviada com sucesso" 
      });
    } catch (error: any) {
      console.error("Error sending Telegram message:", error);
      res.status(500).json({ error: error.message || "Erro ao enviar mensagem" });
    }
  });

  // ===== PRODUCTS ROUTES =====
  
  // Get all products
  app.get("/api/products", requireAuth, async (req, res) => {
    try {
      const products = await storage.getAllProducts();
      res.json(products);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch products" });
    }
  });

  // Get active products
  app.get("/api/products/active", requireAuth, async (req, res) => {
    try {
      const products = await storage.getActiveProducts();
      res.json(products);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch active products" });
    }
  });

  // Create product
  app.post("/api/products", requireAdmin, async (req, res) => {
    try {
      const productData = insertProductSchema.parse(req.body);
      const product = await storage.createProduct(productData);
      res.json(product);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid product data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create product" });
      }
    }
  });

  // Update product
  app.put("/api/products/:id", requireAdmin, async (req, res) => {
    try {
      const productData = insertProductSchema.partial().parse(req.body);
      const product = await storage.updateProduct(req.params.id, productData);
      
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }
      
      res.json(product);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid product data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to update product" });
      }
    }
  });

  // Delete product
  app.delete("/api/products/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteProduct(req.params.id);
      res.json({ message: "Product deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete product" });
    }
  });

  // ===== QUICK MESSAGES ROUTES =====
  
  // Get all quick messages
  app.get("/api/quick-messages", requireAuth, async (req, res) => {
    try {
      const messages = await storage.getAllQuickMessages();
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch quick messages" });
    }
  });

  // Get active quick messages
  app.get("/api/quick-messages/active", requireAuth, async (req, res) => {
    try {
      const messages = await storage.getActiveQuickMessages();
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch active quick messages" });
    }
  });

  // Create quick message
  app.post("/api/quick-messages", requireAuth, async (req, res) => {
    try {
      const messageData = insertQuickMessageSchema.parse({
        ...req.body,
        createdBy: (req as any).user.id
      });
      const message = await storage.createQuickMessage(messageData);
      res.json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid message data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create quick message" });
      }
    }
  });

  // Update quick message
  app.put("/api/quick-messages/:id", requireAuth, async (req, res) => {
    try {
      const messageData = insertQuickMessageSchema.partial().parse(req.body);
      const message = await storage.updateQuickMessage(req.params.id, messageData);
      
      if (!message) {
        return res.status(404).json({ message: "Quick message not found" });
      }
      
      res.json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid message data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to update quick message" });
      }
    }
  });

  // Delete quick message
  app.delete("/api/quick-messages/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteQuickMessage(req.params.id);
      res.json({ message: "Quick message deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete quick message" });
    }
  });

  // ===== ORDERS ROUTES =====
  
  // Get customer orders
  app.get("/api/customers/:customerId/orders", requireAuth, async (req, res) => {
    try {
      const orders = await storage.getCustomerOrders(req.params.customerId);
      res.json(orders);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch customer orders" });
    }
  });

  // Get conversation orders
  app.get("/api/conversations/:conversationId/orders", requireAuth, async (req, res) => {
    try {
      const orders = await storage.getConversationOrders(req.params.conversationId);
      res.json(orders);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch conversation orders" });
    }
  });

  // Create order
  app.post("/api/orders", requireAuth, async (req, res) => {
    try {
      const orderData = insertOrderSchema.parse(req.body);
      const order = await storage.createOrder(orderData);
      res.json(order);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid order data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create order" });
      }
    }
  });

  // Update order status
  app.put("/api/orders/:id/status", requireAuth, async (req, res) => {
    try {
      const { status } = req.body;
      if (!status || typeof status !== 'string') {
        return res.status(400).json({ message: "Status is required" });
      }
      
      const order = await storage.updateOrderStatus(req.params.id, status);
      
      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      res.status(500).json({ message: "Failed to update order status" });
    }
  });

  // ===== DELIVERY ROUTES =====
  
  // Middleware to check if user is delivery person
  const requireDelivery = (req: any, res: any, next: any) => {
    if (req.user.role !== 'delivery') {
      return res.status(403).json({ error: "Acesso negado. Somente entregadores podem acessar esta rota." });
    }
    next();
  };

  // Get delivery person's deliveries for today
  app.get("/api/deliveries/today", requireAuth, requireDelivery, async (req, res) => {
    try {
      const deliveries = await storage.getTodayDeliveries(req.user.id);
      res.json(deliveries);
    } catch (error) {
      console.error("Error fetching today's deliveries:", error);
      res.status(500).json({ error: "Erro ao buscar entregas do dia" });
    }
  });

  // Get all deliveries for admin
  app.get("/api/admin/deliveries", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { startDate, endDate, status, deliveryPersonId } = req.query;
      const deliveries = await storage.searchDeliveries({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        status: status as string,
        deliveryPersonId: deliveryPersonId as string,
      });
      res.json(deliveries);
    } catch (error) {
      console.error("Error searching deliveries:", error);
      res.status(500).json({ error: "Erro ao buscar entregas" });
    }
  });

  // Create new delivery
  app.post("/api/deliveries", requireAuth, requireAdmin, async (req, res) => {
    try {
      const deliveryData = insertDeliverySchema.parse(req.body);
      const delivery = await storage.createDelivery(deliveryData);
      res.json(delivery);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Dados de entrega inválidos", details: error.errors });
      } else {
        console.error("Error creating delivery:", error);
        res.status(500).json({ error: "Erro ao criar entrega" });
      }
    }
  });

  // Confirm delivery
  app.post("/api/deliveries/:id/confirm", requireAuth, requireDelivery, async (req, res) => {
    try {
      const { latitude, longitude } = req.body;
      
      if (!latitude || !longitude) {
        return res.status(400).json({ error: "Latitude e longitude são obrigatórias" });
      }

      const delivery = await storage.confirmDelivery(req.params.id, req.user.id, {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
      });

      if (!delivery) {
        return res.status(404).json({ error: "Entrega não encontrada ou não pertence a você" });
      }

      res.json({ 
        success: true, 
        message: "Entrega confirmada com sucesso",
        delivery 
      });
    } catch (error) {
      console.error("Error confirming delivery:", error);
      res.status(500).json({ error: "Erro ao confirmar entrega" });
    }
  });

  // Reject delivery
  app.post("/api/deliveries/:id/reject", requireAuth, requireDelivery, async (req, res) => {
    try {
      const { rejectionReasonId, rejectionNotes } = req.body;
      
      if (!rejectionReasonId) {
        return res.status(400).json({ error: "Motivo da recusa é obrigatório" });
      }

      const delivery = await storage.rejectDelivery(req.params.id, req.user.id, {
        rejectionReasonId,
        rejectionNotes,
      });

      if (!delivery) {
        return res.status(404).json({ error: "Entrega não encontrada ou não pertence a você" });
      }

      res.json({ 
        success: true, 
        message: "Entrega recusada com sucesso",
        delivery 
      });
    } catch (error) {
      console.error("Error rejecting delivery:", error);
      res.status(500).json({ error: "Erro ao recusar entrega" });
    }
  });

  // Get delivery rejection reasons
  app.get("/api/delivery-rejection-reasons", requireAuth, async (req, res) => {
    try {
      const reasons = await storage.getActiveDeliveryRejectionReasons();
      res.json(reasons);
    } catch (error) {
      console.error("Error fetching rejection reasons:", error);
      res.status(500).json({ error: "Erro ao buscar motivos de recusa" });
    }
  });

  // Admin routes for delivery rejection reasons
  app.get("/api/admin/delivery-rejection-reasons", requireAuth, requireAdmin, async (req, res) => {
    try {
      const reasons = await storage.getAllDeliveryRejectionReasons();
      res.json(reasons);
    } catch (error) {
      console.error("Error fetching all rejection reasons:", error);
      res.status(500).json({ error: "Erro ao buscar motivos de recusa" });
    }
  });

  app.post("/api/admin/delivery-rejection-reasons", requireAuth, requireAdmin, async (req, res) => {
    try {
      const reasonData = insertDeliveryRejectionReasonSchema.parse(req.body);
      const reason = await storage.createDeliveryRejectionReason(reasonData);
      
      // Log de auditoria
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "CREATE_REJECTION_REASON",
        details: `Motivo de recusa criado: ${reason.reason}`,
      });

      res.json(reason);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Dados inválidos", details: error.errors });
      } else {
        console.error("Error creating rejection reason:", error);
        res.status(500).json({ error: "Erro ao criar motivo de recusa" });
      }
    }
  });

  app.put("/api/admin/delivery-rejection-reasons/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const reasonData = insertDeliveryRejectionReasonSchema.partial().parse(req.body);
      const reason = await storage.updateDeliveryRejectionReason(req.params.id, reasonData);
      
      if (!reason) {
        return res.status(404).json({ error: "Motivo de recusa não encontrado" });
      }

      // Log de auditoria
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "UPDATE_REJECTION_REASON",
        details: `Motivo de recusa atualizado: ${reason.reason}`,
      });

      res.json(reason);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Dados inválidos", details: error.errors });
      } else {
        console.error("Error updating rejection reason:", error);
        res.status(500).json({ error: "Erro ao atualizar motivo de recusa" });
      }
    }
  });

  app.delete("/api/admin/delivery-rejection-reasons/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const reason = await storage.getDeliveryRejectionReason(req.params.id);
      if (!reason) {
        return res.status(404).json({ error: "Motivo de recusa não encontrado" });
      }

      await storage.deleteDeliveryRejectionReason(req.params.id);
      
      // Log de auditoria
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "DELETE_REJECTION_REASON",
        details: `Motivo de recusa deletado: ${reason.reason}`,
      });

      res.json({ success: true, message: "Motivo de recusa deletado com sucesso" });
    } catch (error) {
      console.error("Error deleting rejection reason:", error);
      res.status(500).json({ error: "Erro ao deletar motivo de recusa" });
    }
  });

  // WhatsApp Conversation Analysis Routes
  
  // Analyze a specific conversation
  app.post("/api/whatsapp-analysis/analyze/:conversationId", requireAuth, requireAdmin, async (req, res) => {
    try {
      const conversationId = req.params.conversationId;
      
      // Get conversation and messages
      const conversation = await storage.getConversationWithCustomer(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversa não encontrada" });
      }

      const messages = await storage.getConversationMessages(conversationId);
      if (messages.length === 0) {
        return res.status(400).json({ error: "Conversa não possui mensagens para análise" });
      }

      // Check if analysis already exists
      const existingAnalysis = await storage.getWhatsappAnalysisByConversationId(conversationId);
      if (existingAnalysis) {
        return res.status(400).json({ error: "Esta conversa já foi analisada", analysisId: existingAnalysis.id });
      }

      // Perform analysis
      const extractedData = await whatsappAnalysisService.analyzeConversation(
        conversationId,
        messages,
        { name: conversation.customer.name, phone: conversation.customer.phone }
      );

      // Save analysis to database
      const analysis = await storage.createWhatsappAnalysis({
        conversationId,
        rawConversationData: messages,
        extractedData,
        customerName: extractedData.customerName || conversation.customer.name,
        companyRepresentative: extractedData.companyRepresentative,
        orderDate: extractedData.orderDate ? new Date(extractedData.orderDate) : null,
        orderItems: extractedData.orderItems || [],
        totalAmount: extractedData.totalAmount,
        analysisStatus: "completed"
      });

      // Log audit
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "ANALYZE_WHATSAPP_CONVERSATION",
        entityType: "conversation",
        entityId: conversationId,
        details: { analysisId: analysis.id, customerName: extractedData.customerName }
      });

      res.json({ success: true, analysis, extractedData });
    } catch (error) {
      console.error("Error analyzing conversation:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Erro ao analisar conversa" });
    }
  });

  // Get all analyses
  app.get("/api/whatsapp-analysis", requireAuth, requireAdmin, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      
      let analyses;
      if (status) {
        analyses = await storage.getWhatsappAnalysesByStatus(status);
      } else {
        analyses = await storage.getAllWhatsappAnalyses();
      }

      res.json(analyses);
    } catch (error) {
      console.error("Error getting analyses:", error);
      res.status(500).json({ error: "Erro ao buscar análises" });
    }
  });

  // Get specific analysis
  app.get("/api/whatsapp-analysis/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const analysis = await storage.getWhatsappAnalysis(req.params.id);
      if (!analysis) {
        return res.status(404).json({ error: "Análise não encontrada" });
      }

      res.json(analysis);
    } catch (error) {
      console.error("Error getting analysis:", error);
      res.status(500).json({ error: "Erro ao buscar análise" });
    }
  });

  // Generate knowledge base file
  app.post("/api/whatsapp-analysis/generate-knowledge", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get all completed analyses
      const analyses = await storage.getWhatsappAnalysesByStatus("completed");
      
      if (analyses.length === 0) {
        return res.status(400).json({ error: "Nenhuma análise encontrada para gerar base de conhecimento" });
      }

      // Generate knowledge file
      const fileInfo = await whatsappAnalysisService.generateKnowledgeFile(analyses);
      
      // Save knowledge base info to database
      const knowledgeBase = await storage.createKnowledgeBase({
        fileName: fileInfo.fileName,
        filePath: fileInfo.filePath,
        fileSize: fileInfo.fileSize,
        conversationCount: analyses.length
      });

      // Update analyses with knowledge file update timestamp
      for (const analysis of analyses) {
        await storage.updateAnalysisKnowledgeFileUpdate(analysis.id);
      }

      // Clear ChatGPT knowledge base cache so it loads the new file
      chatGPTService.clearKnowledgeBaseCache();

      // Log audit
      await storage.createAuditLog({
        userId: req.user!.id,
        action: "GENERATE_KNOWLEDGE_BASE",
        details: { 
          knowledgeBaseId: knowledgeBase.id, 
          fileName: fileInfo.fileName,
          conversationCount: analyses.length 
        }
      });

      res.json({ 
        success: true, 
        knowledgeBase,
        fileInfo,
        message: `Base de conhecimento gerada com ${analyses.length} conversas analisadas` 
      });
    } catch (error) {
      console.error("Error generating knowledge base:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Erro ao gerar base de conhecimento" });
    }
  });

  // Get knowledge base files
  app.get("/api/whatsapp-analysis/knowledge-base", requireAuth, requireAdmin, async (req, res) => {
    try {
      const knowledgeBases = await storage.getAllKnowledgeBases();
      res.json(knowledgeBases);
    } catch (error) {
      console.error("Error getting knowledge bases:", error);
      res.status(500).json({ error: "Erro ao buscar bases de conhecimento" });
    }
  });

  // Get latest knowledge base content
  app.get("/api/whatsapp-analysis/knowledge-base/latest/content", requireAuth, requireAdmin, async (req, res) => {
    try {
      const latestKnowledge = await storage.getLatestKnowledgeBase();
      if (!latestKnowledge) {
        return res.status(404).json({ error: "Nenhuma base de conhecimento encontrada" });
      }

      const content = await whatsappAnalysisService.readKnowledgeFileContent(latestKnowledge.filePath);
      
      res.json({
        knowledgeBase: latestKnowledge,
        content: content
      });
    } catch (error) {
      console.error("Error getting knowledge base content:", error);
      res.status(500).json({ error: "Erro ao ler conteúdo da base de conhecimento" });
    }
  });

  return httpServer;
}
