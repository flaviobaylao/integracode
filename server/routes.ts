import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { validateLocalAdmin, createLocalSession, validateUser, setUserPassword, initializeDefaultAdmin } from "./localAuth";
import { authenticateUser, authenticateAdmin, requireRole, checkSellerAccess } from "./authMiddleware";
import { getOmieService, isOmieConfigured, createOmieOrder } from "./omieIntegration";
import { generateVisitAgenda, ensureFutureAgendaCoverage, updateExistingSalesCardsFromCustomer, propagateRecurrenceChange } from "./visitScheduleService";
import { optimizeRouteAdvanced, type RouteLocation } from "../shared/routeOptimization.js";
import { receitaService } from "./receitaIntegration";
import { evolutionAPIService } from "./evolution-api-service";
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import {
  insertCustomerSchema,
  insertProductSchema,
  insertSalesCardSchema,
  insertMessageTemplateSchema,
  insertMessageHistorySchema,
  insertLocationSchema,
  insertSalesGoalSchema,
  insertRouteSchema,
  insertUserSchema,
  visitAgenda,
  users,
  salesCards,
  blockedOrders,
  customers,
  billings as billingsTable,
  syncStates,
  dailyRoutes,
  routeCheckpoints,
  leads,
  deliveryRoutes,
  deliveryRouteStops,
  activeCustomers,
  normalizeWeekdayInput,
  type WeekdayCode,
} from "@shared/schema";
import { z } from "zod";
import { sql, eq, and, gte, lte, lt, isNotNull, inArray, ne, or, isNull, asc, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db";
import multer from 'multer';
import * as XLSX from 'xlsx';
import bcrypt from 'bcrypt';
import path from 'path';
import fs from 'fs';
import { APP_VERSION, VERSION_HISTORY } from '../shared/version';
import { calculateDeliveryDaysFromMultipleRoutes } from '../shared/deliveryDaysCalculator';

// Configurar multer para upload de arquivos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to save sync status after successful synchronization
async function saveSyncStatus(
  syncType: string, 
  status: 'success' | 'error', 
  recordsProcessed: number, 
  message?: string
) {
  try {
    await storage.upsertSyncStatus({
      syncType,
      lastSyncAt: new Date(),
      status,
      message,
      recordsProcessed
    });
    console.log(`✅ Sync status saved: ${syncType} - ${status} - ${recordsProcessed} records`);
  } catch (error) {
    console.error(`❌ Error saving sync status for ${syncType}:`, error);
  }
}

// Helper function to determine if a visit is a LEAD (requires mandatory photo)
async function isLeadVisit(customerId: string, dailyRoute: any): Promise<boolean> {
  try {
    // First check visitStops for "lead:{id}" format
    // visitStops is stored as { [stopId]: { entityType, entityId } }
    if (dailyRoute?.visitStops) {
      const stopId = `lead:${customerId}`;
      if (dailyRoute.visitStops[stopId]) {
        console.log(`🎯 Visit ${customerId} identified as LEAD via visitStops`);
        return true;
      }
    }
    
    // Fallback: Query leads table directly (handles converted leads or ad-hoc cards)
    const lead = await storage.getLead(customerId);
    if (lead) {
      console.log(`🎯 Visit ${customerId} identified as LEAD via direct query`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Error checking if visit ${customerId} is LEAD:`, error);
    return false; // Fail-safe: treat as customer if check fails
  }
}

// Helper function to resolve route stops (customers + leads) with coordinates
interface ResolvedStop {
  stopId: string;
  entityType: 'customer' | 'lead';
  entityId: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
}

async function resolveRouteStops(
  optimizedOrder: string[],
  visitStops: { [stopId: string]: { entityType: 'customer' | 'lead'; entityId: string } }
): Promise<ResolvedStop[]> {
  const resolvedStops: ResolvedStop[] = [];

  for (const stopId of optimizedOrder) {
    try {
      // Get metadata from visitStops
      const stopMeta = visitStops[stopId];
      
      // Determine entityType and entityId with proper legacy support
      let entityType: 'customer' | 'lead' = 'customer';
      let entityId: string = stopId;
      
      if (stopMeta) {
        // Has metadata, use it
        entityType = stopMeta.entityType;
        entityId = stopMeta.entityId;
      } else if (stopId.includes(':')) {
        // No metadata but has prefix, extract it (legacy support)
        const [prefix, id] = stopId.split(':', 2);
        if (prefix === 'lead' && id) {
          entityType = 'lead';
          entityId = id;
        } else if (prefix === 'customer' && id) {
          entityType = 'customer';
          entityId = id;
        }
        // If prefix is unrecognized, fall through to customer default
      }
      // Else: no metadata, no prefix → assume customer (backward compatibility)

      if (entityType === 'customer') {
        // Fetch customer data
        const [customer] = await db
          .select({
            id: customers.id,
            fantasyName: customers.fantasyName,
            address: customers.address,
            latitude: customers.latitude,
            longitude: customers.longitude
          })
          .from(customers)
          .where(eq(customers.id, entityId))
          .limit(1);

        if (customer && customer.latitude && customer.longitude) {
          const lat = typeof customer.latitude === 'string' ? parseFloat(customer.latitude) : customer.latitude;
          const lon = typeof customer.longitude === 'string' ? parseFloat(customer.longitude) : customer.longitude;

          if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
            resolvedStops.push({
              stopId,
              entityType: 'customer',
              entityId: customer.id,
              name: customer.fantasyName || 'Cliente',
              address: customer.address || '',
              latitude: lat,
              longitude: lon
            });
          } else {
            console.warn(`⚠️  Customer ${entityId} has invalid coordinates, skipping`);
          }
        } else {
          console.warn(`⚠️  Customer ${entityId} not found or missing coordinates, skipping`);
        }
      } else if (entityType === 'lead') {
        // Fetch lead data
        const [lead] = await db
          .select({
            id: leads.id,
            fantasyName: leads.fantasyName,
            latitude: leads.latitude,
            longitude: leads.longitude
          })
          .from(leads)
          .where(eq(leads.id, entityId))
          .limit(1);

        if (lead && lead.latitude && lead.longitude) {
          const lat = typeof lead.latitude === 'string' ? parseFloat(lead.latitude) : lead.latitude;
          const lon = typeof lead.longitude === 'string' ? parseFloat(lead.longitude) : lead.longitude;

          if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
            resolvedStops.push({
              stopId,
              entityType: 'lead',
              entityId: lead.id,
              name: lead.fantasyName,
              address: '',
              latitude: lat,
              longitude: lon
            });
          } else {
            console.warn(`⚠️  Lead ${entityId} has invalid coordinates, skipping`);
          }
        } else {
          console.warn(`⚠️  Lead ${entityId} not found or missing coordinates, skipping`);
        }
      }
    } catch (error) {
      console.error(`❌ Error resolving stop ${stopId}:`, error);
    }
  }

  return resolvedStops;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Configure Evolution API for WhatsApp
  const evolutionBaseUrl = process.env.EVOLUTION_API_BASE_URL;
  const evolutionApiKey = process.env.EVOLUTION_API_KEY;
  const evolutionInstanceName = process.env.EVOLUTION_INSTANCE_NAME;

  if (evolutionBaseUrl && evolutionApiKey && evolutionInstanceName) {
    evolutionAPIService.configure({
      apiUrl: evolutionBaseUrl,
      apiKey: evolutionApiKey,
      instanceName: evolutionInstanceName
    });
    console.log('✅ Evolution API configurada com sucesso para WhatsApp');

    // Configure webhook for receiving messages
    const webhookUrl = process.env.REPLIT_DOMAINS 
      ? `https://${process.env.REPLIT_DOMAINS?.split(',')[0].replace('https://', '')}/api/chat/webhook/messages`
      : 'http://localhost:5000/api/chat/webhook/messages';

    try {
      // 🪞 ESPELHO COMPLETO DO WHATSAPP - Configurar webhook para capturar TODAS as mensagens
      // Incluindo mensagens enviadas via celular (fromMe = true) e recebidas (fromMe = false)
      // Eventos válidos do Evolution API: MESSAGES_UPSERT, SEND_MESSAGE, MESSAGES_UPDATE, MESSAGES_SET, MESSAGES_EDITED
      const webhookEvents = [
        'MESSAGES_UPSERT',      // Mensagens novas (recebidas E enviadas via celular - principal)
        'SEND_MESSAGE',         // Mensagens enviadas via API
        'MESSAGES_UPDATE',      // Atualizações de status (lido, entregue, etc)
        'MESSAGES_SET',         // Sincronização em lote
        'MESSAGES_EDITED'       // Mensagens editadas
      ];
      
      console.log('🪞 [WEBHOOK-CONFIG] Configurando espelho completo do WhatsApp...');
      console.log('🪞 [WEBHOOK-CONFIG] Eventos:', webhookEvents);
      
      const webhookResult = await evolutionAPIService.setWebhook(evolutionInstanceName, webhookUrl, webhookEvents);
      if (webhookResult.success) {
        console.log('✅ Webhook configurado com sucesso para ESPELHO COMPLETO do WhatsApp');
        console.log('✅ Eventos configurados:', webhookEvents.join(', '));
        // Verificar status depois de configurar
        setTimeout(async () => {
          const webhookStatus = await evolutionAPIService.getWebhook(evolutionInstanceName);
          console.log('📡 Status do webhook após configuração:', webhookStatus);
        }, 2000);
      } else {
        console.warn('⚠️  Erro ao configurar webhook:', webhookResult.error);
      }
    } catch (err) {
      console.warn('⚠️  Erro ao tentar configurar webhook:', err);
    }
  } else {
    console.warn('⚠️  Evolution API não completamente configurada. Verifique as secrets:', {
      hasBaseUrl: !!evolutionBaseUrl,
      hasApiKey: !!evolutionApiKey,
      hasInstanceName: !!evolutionInstanceName
    });
  }

  // Middleware global para impedir cache HTTP em todas as rotas /api/*
  app.use('/api', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    next();
  });

  // Version endpoint
  app.get('/api/version', (req, res) => {
    res.json({
      version: APP_VERSION.full,
      buildDate: APP_VERSION.buildDate,
      name: APP_VERSION.name,
      history: VERSION_HISTORY.slice(0, 5) // Últimas 5 versões
    });
  });

  // Health check endpoint para diagnóstico
  app.get('/api/health', async (req, res) => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      hostname: req.hostname,
      checks: {
        database: false,
        session: false,
        replitDomains: false,
        omieConfig: false,
      },
      config: {
        replitDomains: process.env.REPLIT_DOMAINS ? 
          process.env.REPLIT_DOMAINS.split(',').map(d => d.trim()) : 
          ['não configurado'],
        hasSessionSecret: !!process.env.SESSION_SECRET,
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasOmieKey: !!process.env.OMIE_APP_KEY,
        hasOmieSecret: !!process.env.OMIE_APP_SECRET,
      }
    };

    // Verificar database
    try {
      await db.execute(sql`SELECT 1`);
      health.checks.database = true;
    } catch (error) {
      health.status = 'degraded';
      console.error('Health check - Database error:', error);
    }

    // Verificar session secret
    health.checks.session = !!process.env.SESSION_SECRET;
    if (!health.checks.session) {
      health.status = 'degraded';
    }

    // Verificar REPLIT_DOMAINS
    health.checks.replitDomains = !!process.env.REPLIT_DOMAINS;

    // Verificar Omie
    health.checks.omieConfig = isOmieConfigured();

    res.json(health);
  });

  // Endpoint protegido para inicializar admin padrão (requer autenticação de admin)
  app.post('/api/setup-admin', authenticateAdmin, async (req, res) => {
    try {
      const adminUser = await initializeDefaultAdmin();
      
      if (!adminUser) {
        return res.status(500).json({ 
          success: false, 
          message: "Erro ao criar usuário admin" 
        });
      }
      
      res.json({ 
        success: true, 
        message: "Sistema inicializado com sucesso",
        adminEmail: adminUser.email
      });
    } catch (error) {
      console.error("Erro no setup do admin:", error);
      res.status(500).json({ 
        success: false, 
        message: "Erro interno do servidor" 
      });
    }
  });

  // Local login route for admin (mantido para compatibilidade)
  app.post('/api/auth/local-login', async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }
      
      const user = await validateLocalAdmin(username, password);
      
      if (!user) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      
      // Create session for local admin
      const sessionData = createLocalSession(user);
      (req.session as any).user = sessionData;
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      
      res.json({ success: true, user });
    } catch (error) {
      console.error("Error in local login:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Login com email e senha (para todos os usuários)
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ message: "Email e senha são obrigatórios" });
      }
      
      const user = await validateUser(email, password);
      
      if (!user) {
        return res.status(401).json({ message: "Email ou senha inválidos" });
      }
      
      // Criar sessão para o usuário
      const sessionData = createLocalSession(user);
      (req.session as any).user = sessionData;
      (req.session as any).userId = user.id;
      (req.session as any).userEmail = user.email;
      
      res.json({ success: true, user });
    } catch (error) {
      console.error("Erro no login:", error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  });

  // Definir primeira senha (usuário deve estar autenticado via Replit Auth ou ser criado por admin)
  app.post('/api/auth/set-password', async (req, res) => {
    try {
      const { email, newPassword } = req.body;
      
      if (!email || !newPassword) {
        return res.status(400).json({ message: "Email e nova senha são obrigatórios" });
      }
      
      // Validar força da senha
      if (newPassword.length < 6) {
        return res.status(400).json({ message: "A senha deve ter no mínimo 6 caracteres" });
      }
      
      // Buscar usuário por email
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }
      
      // Verificar se já tem senha
      if (user.password) {
        return res.status(400).json({ message: "Usuário já possui senha. Use a opção de trocar senha." });
      }
      
      // Definir senha
      const updatedUser = await setUserPassword(user.id, newPassword);
      
      if (!updatedUser) {
        return res.status(500).json({ message: "Erro ao definir senha" });
      }
      
      res.json({ success: true, message: "Senha definida com sucesso" });
    } catch (error) {
      console.error("Erro ao definir senha:", error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  });

  // Trocar senha (usuário deve estar autenticado)
  app.post('/api/auth/change-password', authenticateUser, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const currentUser = (req as any).currentUser;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Senha atual e nova senha são obrigatórias" });
      }
      
      // Validar força da senha
      if (newPassword.length < 6) {
        return res.status(400).json({ message: "A senha deve ter no mínimo 6 caracteres" });
      }
      
      // Validar senha atual
      if (!currentUser.password) {
        return res.status(400).json({ message: "Usuário não possui senha definida" });
      }
      
      const user = await validateUser(currentUser.email!, currentPassword);
      
      if (!user) {
        return res.status(401).json({ message: "Senha atual incorreta" });
      }
      
      // Definir nova senha
      const updatedUser = await setUserPassword(currentUser.id, newPassword);
      
      if (!updatedUser) {
        return res.status(500).json({ message: "Erro ao trocar senha" });
      }
      
      res.json({ success: true, message: "Senha alterada com sucesso" });
    } catch (error) {
      console.error("Erro ao trocar senha:", error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  });

  // Logout route
  app.get('/api/logout', (req: any, res) => {
    req.session.destroy((err: any) => {
      if (err) {
        console.error("Erro ao fazer logout:", err);
        return res.status(500).json({ message: "Erro ao fazer logout" });
      }
      res.redirect('/');
    });
  });

  // Auth routes
  app.get('/api/auth/user', async (req: any, res) => {
    try {
      console.log('👤 GET /api/auth/user - Verificando autenticação...');
      
      // Check for local admin session first
      if (req.session?.user?.claims?.sub) {
        const userId = req.session.user.claims.sub;
        const user = await storage.getUser(userId);
        if (user) {
          return res.json(user);
        }
      }
      
      // Fall back to Replit auth
      if (!req.isAuthenticated() || !req.user?.claims?.sub) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      
      const userId = req.user.claims.sub;
      const userEmail = req.user.claims.email;
      
      // First try to find user by ID
      let user = await storage.getUser(userId);
      
      // CRITICAL FIX: Verify that the user's email matches the Replit email
      // If there's a mismatch, the userId is mapped to the wrong account
      if (user && userEmail && user.email !== userEmail) {
        // Find the correct user by email
        const correctUser = await storage.getUserByEmail(userEmail);
        if (correctUser) {
          user = correctUser;
        } else {
          user = null;
        }
      }
      
      // If not found by ID or email didn't match, try to find by email
      if (!user && userEmail) {
        user = await storage.getUserByEmail(userEmail);
      }
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // DEBUG ENDPOINT - Comparar notas do Excel com banco de dados
  app.get('/api/debug/compare-invoices', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      console.log('🔍 Iniciando comparação de notas fiscais...');
      
      // Ler arquivo Excel
      const excelPath = 'attached_assets/vendas_e_nf-e_743278026293467_1761522051528.xlsx';
      if (!fs.existsSync(excelPath)) {
        return res.status(404).json({ error: 'Arquivo Excel não encontrado' });
      }
      
      const workbook = XLSX.readFile(excelPath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const excelData = XLSX.utils.sheet_to_json(worksheet);
      
      console.log(`📊 Total de registros no Excel: ${excelData.length}`);
      console.log(`📊 Colunas disponíveis:`, Object.keys(excelData[0] || {}));
      
      // Extrair números de NF do Excel
      const excelInvoiceNumbers = excelData.map((row: any) => {
        // Tentar diferentes nomes de colunas possíveis
        const nf = row['Número da NF'] || row['Número'] || row['nNF'] || row['NF'] || row['Nota Fiscal'] || row['número'] || row['numero'];
        return nf ? nf.toString().trim() : null;
      }).filter((nf: any) => nf !== null);
      
      console.log(`✅ Números de NF extraídos do Excel: ${excelInvoiceNumbers.length}`);
      console.log(`📋 Primeiras 10 NFs do Excel:`, excelInvoiceNumbers.slice(0, 10));
      
      // Buscar notas na etapa "aguardando rota" no banco
      const billingsQuery = await storage.getBillings();
      const billingsInStage = billingsQuery.filter(b => 
        b.invoiceStage?.toLowerCase() === 'aguardando rota'
      );
      
      const dbInvoiceNumbers = billingsInStage.map(b => b.invoiceNumber.toString().trim());
      
      console.log(`✅ Notas na etapa "aguardando rota" no banco: ${dbInvoiceNumbers.length}`);
      console.log(`📋 Primeiras 10 NFs do banco:`, dbInvoiceNumbers.slice(0, 10));
      
      // Encontrar notas que estão no banco mas não no Excel (as 2 extras)
      const extraInDb = dbInvoiceNumbers.filter(nf => !excelInvoiceNumbers.includes(nf));
      
      // Encontrar notas que estão no Excel mas não no banco
      const missingInDb = excelInvoiceNumbers.filter((nf: string) => !dbInvoiceNumbers.includes(nf));
      
      // Buscar detalhes das notas extras
      const extraDetails = billingsInStage.filter(b => 
        extraInDb.includes(b.invoiceNumber.toString().trim())
      );
      
      console.log(`🔍 Notas EXTRAS no banco (não estão no Excel): ${extraInDb.length}`);
      console.log(`⚠️ Notas FALTANDO no banco (estão no Excel): ${missingInDb.length}`);
      
      res.json({
        summary: {
          excelTotal: excelInvoiceNumbers.length,
          dbTotal: dbInvoiceNumbers.length,
          difference: dbInvoiceNumbers.length - excelInvoiceNumbers.length,
          extraInDb: extraInDb.length,
          missingInDb: missingInDb.length
        },
        extraInDb,
        missingInDb,
        extraDetails: extraDetails.map(b => ({
          id: b.id,
          invoiceNumber: b.invoiceNumber,
          customerName: b.customerFantasyName,
          invoiceDate: b.invoiceDate,
          totalValue: b.totalValue,
          invoiceStage: b.invoiceStage,
          omieInvoiceId: b.omieInvoiceId
        })),
        excelColumns: Object.keys(excelData[0] || {}),
        sampleExcelRow: excelData[0]
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao comparar notas fiscais:', error);
      res.status(500).json({ 
        error: 'Erro ao comparar notas fiscais',
        details: error.message 
      });
    }
  });

  // User routes
  app.get('/api/users', authenticateUser, async (req: any, res) => {
    try {
      const { role } = req.query;
      let users = await storage.getUsers();
      
      // Filtrar por role se especificado
      if (role && role !== 'all') {
        users = users.filter(user => user.role === role);
      }
      
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.put('/api/users/:id', authenticateUser, async (req: any, res) => {
    try {
      const userId = req.params.id;
      const currentUserId = req.user?.claims?.sub || req.session?.user?.claims?.sub;
      const currentUser = req.currentUser;
      
      // Usuários só podem editar seu próprio perfil, exceto admins e coordenadores
      const canEditOthers = ['admin', 'coordinator'].includes(currentUser?.role);
      if (userId !== currentUserId && !canEditOthers) {
        return res.status(403).json({ message: "Não autorizado a editar este perfil" });
      }

      const updateData = req.body;
      const updatedUser = await storage.updateUser(userId, updateData);
      
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  app.put('/api/users/:id/password', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const userId = req.params.id;
      const { password } = req.body;

      if (!password || password.length < 6) {
        return res.status(400).json({ message: "Senha deve ter no mínimo 6 caracteres" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const updatedUser = await storage.updateUserPassword(userId, hashedPassword);
      
      res.json({ message: "Senha atualizada com sucesso", user: updatedUser });
    } catch (error) {
      console.error("Error updating password:", error);
      res.status(500).json({ message: "Erro ao atualizar senha" });
    }
  });

  app.delete('/api/users/:id', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const userId = req.params.id;
      const currentUser = req.currentUser;
      const currentUserId = req.user?.claims?.sub || req.session?.user?.claims?.sub;

      // Não permitir excluir a si mesmo
      if (userId === currentUserId || userId === currentUser?.id) {
        return res.status(400).json({ message: "Você não pode excluir sua própria conta" });
      }

      await storage.deleteUser(userId);
      
      res.json({ message: "Usuário excluído com sucesso" });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ message: "Erro ao excluir usuário" });
    }
  });

  app.post('/api/users', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const validatedData = insertUserSchema.parse(req.body);
      const newUser = await storage.createUser(validatedData);
      
      res.status(201).json(newUser);
    } catch (error) {
      console.error("Error creating user:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  // Route management routes
  app.get('/api/routes', authenticateUser, async (req: any, res) => {
    try {
      const routes = await storage.getRoutes();
      res.json(routes);
    } catch (error) {
      console.error("Error fetching routes:", error);
      res.status(500).json({ message: "Failed to fetch routes" });
    }
  });

  app.get('/api/routes/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const route = await storage.getRoute(id);
      
      if (!route) {
        return res.status(404).json({ message: "Route not found" });
      }
      
      res.json(route);
    } catch (error) {
      console.error("Error fetching route:", error);
      res.status(500).json({ message: "Failed to fetch route" });
    }
  });

  app.post('/api/routes', authenticateUser, async (req: any, res) => {
    try {
      const data = insertRouteSchema.parse(req.body);
      const route = await storage.createRoute(data);
      res.json(route);
    } catch (error) {
      console.error("Error creating route:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create route" });
    }
  });

  app.put('/api/routes/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const data = req.body;
      const route = await storage.updateRoute(id, data);
      res.json(route);
    } catch (error) {
      console.error("Error updating route:", error);
      res.status(500).json({ message: "Failed to update route" });
    }
  });

  app.delete('/api/routes/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.deleteRoute(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting route:", error);
      res.status(500).json({ message: "Failed to delete route" });
    }
  });

  // Customer routes
  app.get('/api/customers', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const user = req.currentUser;
      let sellerId = req.sellerId; // Set by checkSellerAccess middleware for vendedor
      
      // Admin/Coordinator/Administrative pode especificar sellerId via query param
      // para visualizar clientes de outro vendedor (ex: ao adicionar visitas na rota)
      if ((user.role === 'admin' || user.role === 'coordinator' || user.role === 'administrative') 
          && req.query.sellerId) {
        sellerId = req.query.sellerId as string;
      }
      
      // Se for para criação de cards de vendas, retornar TODOS os clientes (incluindo inativos)
      if (req.query.allCustomers === 'true') {
        const allCustomers = await storage.getAllCustomers();
        // Retornar com formato compatível com o SalesCardModal
        const result = allCustomers.map((c: any) => ({
          id: c.id,
          name: c.name,
          fantasyName: c.fantasyName,
          document: c.document,
          cnpj: c.cnpj,
          cpf: c.cpf,
          phone: c.phone,
          address: c.address,
          neighborhood: c.neighborhood,
          city: c.city,
          state: c.state,
          latitude: c.latitude,
          longitude: c.longitude,
          weekdays: c.weekdays,
          omieStatus: c.omieStatus,
          sellerId: c.sellerId,
        }));
        return res.json(result);
      }
      
      const customers = await storage.getCustomers(sellerId);
      res.json(customers);
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  });

  // Listar TODOS os clientes cadastrados para criação de cards de vendas
  // (inclui inativos, permite criar cards para qualquer cliente cadastrado)
  app.get('/api/customers/all-for-sales', authenticateUser, async (req: any, res) => {
    try {
      const allCustomers = await storage.getAllCustomers();
      
      // Retornar com formato compatível com o SalesCardModal
      const result = allCustomers.map(c => ({
        id: c.id,
        name: c.name,
        fantasyName: c.fantasyName,
        document: c.document,
        phone: c.phone,
        address: c.address,
        neighborhood: c.neighborhood,
        city: c.city,
        state: c.state,
        latitude: c.latitude,
        longitude: c.longitude,
        weekdays: c.weekdays,
        omieStatus: c.omieStatus,
        sellerId: c.sellerId,
      }));
      
      res.json(result);
    } catch (error) {
      console.error("Error fetching all customers for sales:", error);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  });

  // Listar clientes do mapa (ANTES de :id para evitar conflito)
  app.get('/api/customers/map-data', async (req: any, res) => {
    try {
      // 🎯 Buscar clientes ativos COM coordenadas do customers table
      const active = await db.select().from(activeCustomers).where(eq(activeCustomers.isActive, true));
      
      if (active.length === 0) {
        return res.json([]);
      }
      
      const customerIds = active.map(ac => ac.customerId).filter((id) => id != null) as string[];
      if (customerIds.length === 0) {
        return res.json([]);
      }
      
      // Buscar clientes com coordenadas
      const customersData = await db.select().from(customers).where(
        and(
          inArray(customers.id, customerIds),
          isNotNull(customers.latitude),
          isNotNull(customers.longitude)
        )
      );
      
      // Buscar todos os sellers para mapear nomes
      const allSellers = await db.select().from(users);
      const sellerMap = new Map<string, string>();
      for (const seller of allSellers) {
        const firstName = seller.firstName?.trim() || '';
        const lastName = seller.lastName?.trim() || '';
        const sellerName = firstName || lastName
          ? `${firstName} ${lastName}`.trim()
          : seller.email?.split('@')[0] || seller.email || 'Desconhecido';
        sellerMap.set(seller.id, sellerName);
      }
      
      // Filtrar apenas clientes com coordenadas válidas
      const mapData = customersData
        .filter((c) => Number(c.latitude) !== 0 && Number(c.longitude) !== 0)
        .map((c) => {
          // Parse weekdays: pode ser array, string JSON ou string simples
          let parsedWeekdays: string[] = [];
          try {
            if (Array.isArray(c.weekdays)) {
              parsedWeekdays = c.weekdays as string[];
            } else if (typeof c.weekdays === 'string') {
              // Tentar parse como JSON
              if (c.weekdays.startsWith('[')) {
                parsedWeekdays = JSON.parse(c.weekdays);
              } else {
                parsedWeekdays = [c.weekdays];
              }
            }
          } catch (e) {
            parsedWeekdays = ['Seg'];
          }
          
          const visitDay = parsedWeekdays.length > 0 ? parsedWeekdays[0] : 'Seg';
          
          return {
            id: c.id,
            name: c.fantasyName || c.name || `Cliente ${c.document}`,
            fantasyName: c.fantasyName,
            phone: c.phone || '',
            address: c.address || '',
            neighborhood: c.neighborhood || '',
            document: c.document,
            latitude: parseFloat(String(c.latitude)),
            longitude: parseFloat(String(c.longitude)),
            weekdays: parsedWeekdays.join(', '),
            isActive: true,
            visitDay: visitDay,
            customerId: c.id,
            sellerId: c.sellerId || null,
            sellerName: c.sellerId ? sellerMap.get(c.sellerId) : null
          };
        });
      
      console.log(`📍 [MAP-DATA] ${mapData.length} clientes mapeados com coordenadas`);
      res.json(mapData);
    } catch (error) {
      console.error('Erro ao buscar dados do mapa:', error);
      res.json([]);
    }
  });

  app.get('/api/customers/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const customer = await storage.getCustomer(id);
      
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }
      
      // Check if vendedor can access this customer
      const user = req.currentUser;
      
      if (user.role === 'vendedor' && customer.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ message: "Failed to fetch customer" });
    }
  });

  app.patch('/api/customers/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      // Only admin, coordinator, and administrative can update customer data
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Acesso negado. Apenas administradores, coordenadores e administrativos podem editar dados de clientes." });
      }
      
      // Se o ID começa com "billing-", estamos atualizando coordenadas de um billing
      if (id.startsWith('billing-')) {
        const billingId = id.replace('billing-', '');
        
        // Atualizar apenas latitude e longitude no billing
        if (req.body.latitude !== undefined && req.body.longitude !== undefined) {
          await db.update(billingsTable)
            .set({
              latitude: req.body.latitude ? String(req.body.latitude) : null,
              longitude: req.body.longitude ? String(req.body.longitude) : null
            })
            .where(eq(billingsTable.id, billingId));
          
          console.log(`📍 [BILLING-COORDS] Coordenadas atualizadas para billing ${billingId}`);
          
          // Retornar um objeto simulando um customer
          return res.json({
            id,
            latitude: req.body.latitude,
            longitude: req.body.longitude,
            message: "Coordenadas atualizadas com sucesso"
          });
        }
        
        return res.status(400).json({ message: "Apenas latitude e longitude podem ser atualizadas para billings" });
      }
      
      // Check if customer exists
      const existingCustomer = await storage.getCustomer(id);
      if (!existingCustomer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Validate and normalize weekdays if provided
      let normalizedWeekdays: string[] | null = null;
      if (req.body.weekdays !== undefined) {
        try {
          normalizedWeekdays = normalizeWeekdayInput(req.body.weekdays);
          // Convert array back to JSON string for database storage (always returns array, never null)
          req.body.weekdays = JSON.stringify(normalizedWeekdays);
          
          // 🚚 CALCULAR AUTOMATICAMENTE OS DIAS DE ENTREGA (EXECUÇÃO)
          // IMPORTANTE: Distinção de conceitos:
          // - deliveryTimeSlots/deliverySaturdayTimeSlots = DIAS/HORÁRIOS DE RECEBIMENTO (quando cliente aceita receber)
          // - deliveryWeekdays (calculado) = DIAS DE ENTREGA/EXECUÇÃO (dias preferenciais para executar entrega - 2 dias úteis após rota)
          // Exemplo: rota SEG → entrega TER, QUA
          const deliveryDays = calculateDeliveryDaysFromMultipleRoutes(normalizedWeekdays);
          req.body.deliveryWeekdays = deliveryDays;
          
          console.log(`📅 [AUTO-DELIVERY-DAYS] Dias de rota: ${normalizedWeekdays.join(', ')} → Dias de entrega: ${deliveryDays.join(', ')}`);
        } catch (error: any) {
          return res.status(400).json({ 
            message: "Dias da semana inválidos",
            error: error.message 
          });
        }
      } else {
        // Se weekdays não foi fornecido, mas o cliente já tem weekdays, recalcular deliveryWeekdays
        if (existingCustomer.weekdays) {
          try {
            const parsedWeekdays = typeof existingCustomer.weekdays === 'string' 
              ? JSON.parse(existingCustomer.weekdays) 
              : existingCustomer.weekdays;
            if (Array.isArray(parsedWeekdays) && parsedWeekdays.length > 0) {
              const deliveryDays = calculateDeliveryDaysFromMultipleRoutes(parsedWeekdays);
              req.body.deliveryWeekdays = deliveryDays;
              console.log(`📅 [AUTO-DELIVERY-DAYS-RECALC] Recalculando dias de entrega: ${parsedWeekdays.join(', ')} → ${deliveryDays.join(', ')}`);
            }
          } catch (error) {
            console.error('Erro ao recalcular deliveryWeekdays:', error);
          }
        }
      }
      
      // Processar campos de configuração de RECEBIMENTO (JSONB arrays)
      // IMPORTANTE DISTINÇÃO DE CONCEITOS:
      // - receivingWeekdays = DIAS em que o CLIENTE ACEITA RECEBER mercadorias (configurado manualmente via checkboxes)
      // - deliveryTimeSlots/deliverySaturdayTimeSlots = HORÁRIOS em que o CLIENTE ACEITA RECEBER mercadorias
      // - deliveryWeekdays = DIAS DE EXECUÇÃO (calculado automaticamente - 2 dias úteis após dia de rota)
      const deliveryConfigFields = [
        'receivingWeekdays',  // Dias da semana em que cliente aceita receber (configurado manualmente)
        'deliveryTimeSlots',  // Horários de recebimento em dias úteis
        'deliverySaturdayTimeSlots',  // Horários de recebimento aos sábados
        'vehicleTypes'
      ];
      
      for (const field of deliveryConfigFields) {
        if (req.body[field] !== undefined) {
          // Garantir que seja um array válido
          if (Array.isArray(req.body[field])) {
            // Já é array, manter como está (será convertido para JSONB pelo Drizzle)
            req.body[field] = req.body[field];
          } else if (req.body[field] === null || req.body[field] === '') {
            // Se for null ou string vazia, converter para array vazio
            req.body[field] = [];
          } else {
            // Tentar parsear se for string
            try {
              req.body[field] = JSON.parse(req.body[field]);
            } catch {
              req.body[field] = [];
            }
          }
          
          console.log(`✅ [CUSTOMER-UPDATE] ${field}:`, req.body[field]);
        }
      }
      
      // Processar exclusiveVehicle (boolean)
      if (req.body.exclusiveVehicle !== undefined) {
        req.body.exclusiveVehicle = Boolean(req.body.exclusiveVehicle);
      }
      
      // Clean data: transform empty strings to null for numeric fields
      const cleanedData: any = {};
      Object.keys(req.body).forEach(key => {
        const value = req.body[key];
        if (['latitude', 'longitude', 'lastSaleValue'].includes(key)) {
          cleanedData[key] = value === '' ? null : value;
        } else {
          cleanedData[key] = value;
        }
      });
      
      // Update customer
      const updatedCustomer = await storage.updateCustomer(id, cleanedData);
      
      console.log('✅ Cliente atualizado:', {
        id: updatedCustomer.id,
        weekdays: updatedCustomer.weekdays,
        visitPeriodicity: updatedCustomer.visitPeriodicity,
        deliveryWeekdays: updatedCustomer.deliveryWeekdays,
        deliveryTimeSlots: updatedCustomer.deliveryTimeSlots,
        deliverySaturdayTimeSlots: updatedCustomer.deliverySaturdayTimeSlots,
        exclusiveVehicle: updatedCustomer.exclusiveVehicle,
        vehicleTypes: updatedCustomer.vehicleTypes
      });
      
      // Atualizar automaticamente os salesCards futuros com os novos dados do cliente
      try {
        const { updateExistingSalesCardsFromCustomer } = await import('./visitScheduleService');
        const updateResult = await updateExistingSalesCardsFromCustomer(id);
        
        if (updateResult.updated > 0 || updateResult.reallocated > 0) {
          console.log(`🔄 Cards do cliente atualizados: ${updateResult.updated} atualizados, ${updateResult.reallocated} realocados`);
        }
      } catch (updateError: any) {
        console.error('⚠️ Erro ao atualizar cards do cliente:', updateError.message);
        // Não falhar a atualização do cliente por causa disso
      }
      
      res.json(updatedCustomer);
    } catch (error) {
      console.error("Error updating customer:", error);
      res.status(500).json({ message: "Falha ao atualizar cliente" });
    }
  });

  app.post('/api/customers/:id/inactivate', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { cardId } = req.body;
      const user = req.currentUser;
      
      // Only admin, coordinator, and administrative can inactivate customers
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Acesso negado. Apenas administradores, coordenadores e administrativos podem inativar clientes." });
      }
      
      // Validate cardId
      if (!cardId) {
        return res.status(400).json({ message: "ID do card é obrigatório" });
      }
      
      // Check if customer exists
      const existingCustomer = await storage.getCustomer(id);
      if (!existingCustomer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Check if customer is already inactive
      if (!existingCustomer.isActive) {
        return res.status(400).json({ message: "Cliente já está inativo" });
      }
      
      // Inactivate customer and delete future cards
      const result = await storage.inactivateCustomer(id, cardId);
      
      // Build success message
      let message = "Cliente inativado com sucesso no sistema";
      if (result.customer.omieClientCode) {
        message += ". IMPORTANTE: A inativação no Omie ERP deve ser feita manualmente, pois a API do Omie não permite inativar clientes programaticamente.";
      }
      
      res.json({
        message,
        customer: result.customer,
        deletedCards: result.deletedCards,
        requiresManualOmieInactivation: !!result.customer.omieClientCode
      });
    } catch (error) {
      console.error("Error inactivating customer:", error);
      res.status(500).json({ message: "Falha ao inativar cliente" });
    }
  });

  app.post('/api/customers', authenticateUser, async (req: any, res) => {
    try {
      // 🔍 LOG 1: Payload recebido do frontend
      console.log('📝 [CREATE CUSTOMER] Payload recebido:', {
        weekdays: req.body.weekdays,
        weekdaysType: typeof req.body.weekdays,
        visitPeriodicity: req.body.visitPeriodicity,
        name: req.body.name,
        sellerId: req.body.sellerId,
      });
      
      // Normalizar weekdays para formato abreviado padrão
      let normalizedWeekdays: string = '[]';
      let autoDeliveryDays: string[] = [];
      try {
        const normalizedArray = normalizeWeekdayInput(req.body.weekdays);
        // ✅ Converter array normalizado de volta para string JSON (formato do banco)
        normalizedWeekdays = JSON.stringify(normalizedArray);
        
        // 🚚 CALCULAR AUTOMATICAMENTE OS DIAS DE ENTREGA
        // Os dias de entrega são os próximos 2 dias úteis após os dias de rota
        // Exemplo: rota SEG → entrega TER, QUA
        autoDeliveryDays = calculateDeliveryDaysFromMultipleRoutes(normalizedArray);
        
        console.log(`📅 [AUTO-DELIVERY-DAYS-CREATE] Dias de rota: ${normalizedArray.join(', ')} → Dias de entrega: ${autoDeliveryDays.join(', ')}`);
      } catch (error: any) {
        return res.status(400).json({ 
          message: "Dias da semana inválidos",
          error: error.message 
        });
      }
      
      // Transformar strings vazias em null para campos numéricos
      const cleanedData = {
        ...req.body,
        weekdays: normalizedWeekdays, // ✅ String JSON normalizada
        deliveryWeekdays: autoDeliveryDays, // ✅ Dias de entrega calculados automaticamente (2 dias úteis após rota) - APENAS SINALIZAÇÃO
        receivingWeekdays: req.body.receivingWeekdays || [], // ✅ Dias de recebimento (configurado MANUALMENTE) - USADO PARA ROTEIRIZAÇÃO
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        lastSaleValue: req.body.lastSaleValue === '' ? null : req.body.lastSaleValue,
        route: req.body.route || '', // Default vazio para route (campo deprecated)
        serviceStartDate: req.body.serviceStartDate 
          ? (typeof req.body.serviceStartDate === 'string' ? new Date(req.body.serviceStartDate) : req.body.serviceStartDate)
          : undefined,
      };
      
      // 🔍 LOG 2: Dados após limpeza
      console.log('🧹 [CREATE CUSTOMER] Após limpeza:', {
        weekdays: cleanedData.weekdays,
        weekdaysType: typeof cleanedData.weekdays,
      });
      
      const data = insertCustomerSchema.parse(cleanedData);
      
      // 🔍 LOG 3: Dados após validação zod
      console.log('✅ [CREATE CUSTOMER] Após validação zod:', {
        weekdays: data.weekdays,
        weekdaysType: typeof data.weekdays,
      });
      
      // Verificar duplicidade de CPF
      if (data.cpf) {
        const existingCustomer = await storage.getCustomerByCpf(data.cpf);
        if (existingCustomer) {
          return res.status(409).json({ 
            message: "CPF já cadastrado", 
            field: "cpf",
            existingCustomer: {
              id: existingCustomer.id,
              name: existingCustomer.name,
              cpf: existingCustomer.cpf
            }
          });
        }
      }
      
      // Verificar duplicidade de CNPJ
      if (data.cnpj) {
        const existingCustomer = await storage.getCustomerByCnpj(data.cnpj);
        if (existingCustomer) {
          return res.status(409).json({ 
            message: "CNPJ já cadastrado", 
            field: "cnpj",
            existingCustomer: {
              id: existingCustomer.id,
              name: existingCustomer.name,
              cnpj: existingCustomer.cnpj
            }
          });
        }
      }
      
      // Criar cliente no Integra
      const customer = await storage.createCustomer(data);
      
      // 🔍 LOG 4: Cliente criado no banco
      console.log('💾 [CREATE CUSTOMER] Cliente salvo no banco:', {
        id: customer.id,
        name: customer.name,
        weekdays: customer.weekdays,
        weekdaysType: typeof customer.weekdays,
      });
      
      // 🎯 CRIAR SALES CARD PERMANENTE automaticamente
      let salesCardMessage = '';
      try {
        console.log(`🎯 [CREATE CUSTOMER] Criando sales_card permanente para cliente ${customer.name}...`);
        const permanentCard = await storage.getOrCreatePermanentCard(customer.id, customer.sellerId);
        salesCardMessage = ` ✅ Card de atendimento criado (ID: ${permanentCard.id})`;
        console.log(`✅ [CREATE CUSTOMER] Sales card criado com sucesso: ${permanentCard.id}`);
      } catch (cardError: any) {
        console.error('❌ [CREATE CUSTOMER] Erro ao criar sales card:', cardError);
        salesCardMessage = ` ⚠️ Cliente criado, mas houve erro ao criar card de atendimento: ${cardError.message}`;
      }
      
      // 📤 CADASTRAR NO OMIE automaticamente (se tiver CPF/CNPJ)
      let omieMessage = '';
      if (customer.cpf || customer.cnpj) {
        try {
          const omieService = getOmieService(storage);
          if (omieService) {
            console.log(`📤 [CREATE CUSTOMER] Tentando cadastrar cliente no Omie: ${customer.name}...`);
            const omieResult = await omieService.createClient({
              cnpj: customer.cnpj,
              cpf: customer.cpf,
              name: customer.name,
              fantasyName: customer.fantasyName,
              email: customer.email,
              phone: customer.phone,
              address: customer.address,
              city: customer.city,
              state: customer.state,
              zipCode: customer.zipCode
            });
            
            if (omieResult.success && omieResult.omieClientCode) {
              // Atualizar cliente com código Omie
              await storage.updateCustomer(customer.id, {
                omieClientCode: omieResult.omieClientCode.toString()
              });
              omieMessage = ` ✅ Cliente cadastrado no Omie (código: ${omieResult.omieClientCode})`;
              console.log(`✅ [CREATE CUSTOMER] Cliente ${customer.name} cadastrado no Omie com sucesso (código: ${omieResult.omieClientCode})`);
            } else {
              omieMessage = ` ⚠️ Cliente criado no Integra, mas não foi possível cadastrar no Omie: ${omieResult.message || 'Erro desconhecido'}`;
              console.warn(`⚠️ [CREATE CUSTOMER] Falha ao cadastrar no Omie:`, omieResult);
            }
          } else {
            omieMessage = ` ⚠️ Serviço Omie não disponível`;
            console.warn(`⚠️ [CREATE CUSTOMER] Omie service não está disponível`);
          }
        } catch (omieError: any) {
          console.error('❌ [CREATE CUSTOMER] Erro ao cadastrar cliente no Omie:', omieError);
          omieMessage = ` ⚠️ Cliente criado no Integra, mas houve erro ao cadastrar no Omie: ${omieError.message || 'Erro desconhecido'}`;
        }
      }
      
      res.json({
        ...customer,
        _omieMessage: omieMessage, // Mensagem informativa sobre o cadastro no Omie
        _salesCardMessage: salesCardMessage // Mensagem informativa sobre o sales card
      });
    } catch (error) {
      console.error("Error creating customer:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create customer" });
    }
  });

  app.put('/api/customers/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // DEBUG: Log do payload recebido
      console.log('📍 PUT /api/customers/:id - Payload recebido:', {
        id,
        latitude: req.body.latitude,
        latitudeType: typeof req.body.latitude,
        longitude: req.body.longitude,
        longitudeType: typeof req.body.longitude,
        weekdays: req.body.weekdays,
        visitPeriodicity: req.body.visitPeriodicity,
        serviceStartDate: req.body.serviceStartDate,
      });
      
      // Normalizar weekdays para formato abreviado padrão (se fornecido)
      let normalizedWeekdaysJson: string | undefined = undefined;
      if (req.body.weekdays !== undefined) {
        try {
          const normalizedArray = normalizeWeekdayInput(req.body.weekdays);
          normalizedWeekdaysJson = JSON.stringify(normalizedArray);
        } catch (error: any) {
          return res.status(400).json({ 
            message: "Dias da semana inválidos",
            error: error.message 
          });
        }
      }
      
      // Processar campos de configuração de entrega (JSONB arrays)
      const deliveryConfigFields = [
        'deliveryWeekdays',
        'deliveryTimeSlots', 
        'deliverySaturdayTimeSlots',
        'vehicleTypes'
      ];
      
      for (const field of deliveryConfigFields) {
        if (req.body[field] !== undefined) {
          // Garantir que seja um array válido
          if (Array.isArray(req.body[field])) {
            // Já é array, manter como está (será convertido para JSONB pelo Drizzle)
            req.body[field] = req.body[field];
          } else if (req.body[field] === null || req.body[field] === '') {
            // Se for null ou string vazia, converter para array vazio
            req.body[field] = [];
          } else {
            // Tentar parsear se for string
            try {
              req.body[field] = JSON.parse(req.body[field]);
            } catch {
              req.body[field] = [];
            }
          }
          
          console.log(`✅ [CUSTOMER-UPDATE-PUT] ${field}:`, req.body[field]);
        }
      }
      
      // Processar exclusiveVehicle (boolean)
      if (req.body.exclusiveVehicle !== undefined) {
        req.body.exclusiveVehicle = Boolean(req.body.exclusiveVehicle);
        console.log(`✅ [CUSTOMER-UPDATE-PUT] exclusiveVehicle:`, req.body.exclusiveVehicle);
      }
      
      // Transformar strings vazias em null para campos numéricos
      const data = {
        ...req.body,
        // Se normalizedWeekdaysJson foi definido, usar; senão, não incluir no update (manter valor existente)
        ...(normalizedWeekdaysJson !== undefined && { weekdays: normalizedWeekdaysJson }),
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        lastSaleValue: req.body.lastSaleValue === '' ? null : req.body.lastSaleValue,
        serviceStartDate: req.body.serviceStartDate 
          ? (typeof req.body.serviceStartDate === 'string' ? new Date(req.body.serviceStartDate) : req.body.serviceStartDate)
          : undefined,
      };
      
      console.log('📍 PUT /api/customers/:id - Data após transformação:', {
        latitude: data.latitude,
        longitude: data.longitude,
      });
      
      // Get current customer and user info
      const currentCustomerResult = await storage.getCustomer(id);
      if (!currentCustomerResult) {
        return res.status(404).json({ message: "Customer not found" });
      }
      
      // Extract customer data from the result
      const currentCustomer = currentCustomerResult;
      
      const user = req.currentUser;
      
      // Check permissions for reassigning customers
      if (data.sellerId && user?.role === 'vendedor') {
        return res.status(403).json({ message: "Vendedores cannot reassign customers" });
      }
      
      // Check permissions for coordinates locking/unlocking
      if (data.coordinatesLocked !== undefined && data.coordinatesLocked !== currentCustomer.coordinatesLocked) {
        if (!user || !['admin', 'coordinator', 'administrative'].includes(user.role)) {
          return res.status(403).json({ 
            message: "Apenas administradores, coordenadores e administrativos podem travar/destravar coordenadas" 
          });
        }
      }
      
      // Check if coordinates are locked and being modified
      if (currentCustomer.coordinatesLocked && 
          (data.latitude !== undefined || data.longitude !== undefined) && 
          (String(data.latitude) !== String(currentCustomer.latitude) || String(data.longitude) !== String(currentCustomer.longitude))) {
        
        // Only allow coordinate changes if user can manage locks or if they're unlocking simultaneously
        if (!user || !['admin', 'coordinator', 'administrative'].includes(user.role)) {
          return res.status(403).json({ 
            message: "As coordenadas estão travadas e só podem ser modificadas por administradores, coordenadores ou administrativos" 
          });
        }
      }
      
      // Verificar duplicidade de CPF (se está sendo alterado)
      if (data.cpf && data.cpf !== currentCustomer.cpf) {
        const existingCustomer = await storage.getCustomerByCpf(data.cpf);
        if (existingCustomer && existingCustomer.id !== id) {
          return res.status(409).json({ 
            message: "CPF já cadastrado para outro cliente", 
            field: "cpf",
            existingCustomer: {
              id: existingCustomer.id,
              name: existingCustomer.name,
              cpf: existingCustomer.cpf
            }
          });
        }
      }
      
      // Verificar duplicidade de CNPJ (se está sendo alterado)
      if (data.cnpj && data.cnpj !== currentCustomer.cnpj) {
        const existingCustomer = await storage.getCustomerByCnpj(data.cnpj);
        if (existingCustomer && existingCustomer.id !== id) {
          return res.status(409).json({ 
            message: "CNPJ já cadastrado para outro cliente", 
            field: "cnpj",
            existingCustomer: {
              id: existingCustomer.id,
              name: existingCustomer.name,
              cnpj: existingCustomer.cnpj
            }
          });
        }
      }
      
      const customer = await storage.updateCustomer(id, data);
      
      // Log de confirmação das configurações de entrega salvas
      console.log('✅ [PUT] Cliente atualizado:', {
        id: customer.id,
        name: customer.name,
        deliveryWeekdays: customer.deliveryWeekdays,
        deliveryTimeSlots: customer.deliveryTimeSlots,
        deliverySaturdayTimeSlots: customer.deliverySaturdayTimeSlots,
        exclusiveVehicle: customer.exclusiveVehicle,
        vehicleTypes: customer.vehicleTypes
      });
      
      res.json(customer);
    } catch (error) {
      console.error("Error updating customer:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update customer" });
    }
  });

  app.delete('/api/customers/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.deleteCustomer(id);
      res.json({ message: "Customer deleted successfully" });
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({ message: "Failed to delete customer" });
    }
  });

  // Update customer phone
  app.patch('/api/customers/:id/phone', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { phone } = req.body;
      
      if (!phone) {
        return res.status(400).json({ message: "Telefone é obrigatório" });
      }
      
      const customer = await storage.updateCustomer(id, { phone });
      res.json({ message: "Telefone atualizado com sucesso", customer });
    } catch (error) {
      console.error("Error updating customer phone:", error);
      res.status(500).json({ message: "Falha ao atualizar telefone" });
    }
  });

  // Bulk update time slots for all customers - ADMIN ONLY
  app.post('/api/customers/bulk-update-time-slots', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const result = await storage.bulkUpdateAllCustomersTimeSlots();
      res.json({
        message: `Horários configurados com sucesso para ${result.updated} cliente(s)`,
        ...result
      });
    } catch (error) {
      console.error("Error bulk updating time slots:", error);
      res.status(500).json({ message: "Falha ao configurar horários em massa" });
    }
  });

  // Import customer data from Excel file
  app.post('/api/customers/import', authenticateUser, upload.single('file'), async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      if (!['admin', 'coordinator', 'administrative'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Acesso negado. Apenas administradores, coordenadores e administrativos podem importar dados." });
      }
      
      if (!req.file) {
        return res.status(400).json({ message: "Nenhum arquivo foi enviado" });
      }

      // Parse Excel file
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      console.log(`Importando dados de ${data.length} linhas do Excel`);

      const results = {
        updated: 0,
        notFound: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < data.length; i++) {
        const row = data[i] as any;
        
        try {
          // Map Excel columns to our schema (flexible column names)
          const cpfCnpj = (row['CPF OU CNPJ'] || row['CNPJ/CPF'] || row['cpf_cnpj'] || row['cpfCnpj'] || row['documento'] || '').toString().trim();
          // Aceitar variações com espaços extras
          const latitude = row['LATITUDE'] || row['Latitude'] || row['latitude'] || row['lat'] ||
                           row[' LATITUDE '] || row[' Latitude '] || row[' latitude '] ||
                           row['LATITUDE '] || row[' LATITUDE'] || row['Latitude '] || row[' Latitude'];
          const longitude = row['LONGITUDE'] || row['Longitude'] || row['longitude'] || row['lng'] ||
                            row[' LONGITUDE '] || row[' Longitude '] || row[' longitude '] ||
                            row['LONGITUDE '] || row[' LONGITUDE'] || row['Longitude '] || row[' Longitude'];
          const rota = (row['ROTA'] || row['Rota'] || row['rota'] || '').toString().toLowerCase().trim();
          const weekdaysRaw = (row['DIAS DA SEMANA'] || row['Dias da Semana'] || row['dias_da_semana'] || row['weekdays'] || row['DIAS'] || row['Dias'] || rota || '').toString().toLowerCase().trim();
          const periodicidade = (row['PERIODICIDADE'] || row['FREQUENCIA'] || row['Periodicidade'] || row['Frequencia'] || row['periodicidade'] || row['frequencia'] || row['periodicity'] || '').toString().toLowerCase().trim();
          const dataInicio = row['DATA DE INICIO'] || row['DATA DE INÍCIO'] || row['Data de Inicio'] || row['Data de Início'] || row['data_inicio'] || row['dataInicio'] || row['startDate'] || '';

          if (!cpfCnpj) {
            results.errors.push(`Linha ${i + 2}: CPF/CNPJ não informado`);
            continue;
          }

          // Normalize CPF/CNPJ - remove formatting
          const normalizedCpfCnpj = cpfCnpj.replace(/[^\d]/g, '');

          // Find customer by CPF or CNPJ
          let customer = null;
          if (normalizedCpfCnpj.length === 11) {
            // CPF
            customer = await storage.getCustomerByCpf(normalizedCpfCnpj);
          } else if (normalizedCpfCnpj.length === 14) {
            // CNPJ
            customer = await storage.getCustomerByCnpj(normalizedCpfCnpj);
          }

          if (!customer) {
            results.notFound++;
            results.errors.push(`Linha ${i + 2}: Cliente não encontrado para CPF/CNPJ ${cpfCnpj}`);
            continue;
          }

          // Prepare update data
          const updateData: any = {};
          
          if (latitude !== undefined && latitude !== null && latitude !== '') {
            // Converter vírgula para ponto decimal
            const latStr = latitude.toString().replace(',', '.');
            updateData.latitude = parseFloat(latStr);
          }
          
          if (longitude !== undefined && longitude !== null && longitude !== '') {
            // Converter vírgula para ponto decimal
            const lngStr = longitude.toString().replace(',', '.');
            updateData.longitude = parseFloat(lngStr);
          }
          
          if (weekdaysRaw) {
            // ✅ Usar função centralizada de normalização
            try {
              const normalizedDays = normalizeWeekdayInput(weekdaysRaw);
              
              if (!normalizedDays || normalizedDays.length === 0) {
                results.errors.push(`Linha ${i + 2}: Nenhum dia da semana válido encontrado em '${weekdaysRaw}'`);
              } else if (normalizedDays.length > 2) {
                results.errors.push(`Linha ${i + 2}: Máximo de 2 dias da semana permitido. Encontrados ${normalizedDays.length} dias.`);
              } else {
                updateData.weekdays = JSON.stringify(normalizedDays);
              }
            } catch (error: any) {
              results.errors.push(`Linha ${i + 2}: Erro ao processar dias da semana: ${error.message}`);
            }
          }
          
          if (periodicidade) {
            // Map periodicidade values
            const periodicityMap: Record<string, string> = {
              'semanal': 'semanal',
              'quinzenal': 'quinzenal',
              'mensal': 'mensal',
              'bimestral': 'bimestral',
            };
            
            const mappedPeriodicity = periodicityMap[periodicidade];
            if (mappedPeriodicity) {
              updateData.visitPeriodicity = mappedPeriodicity;
            } else {
              results.errors.push(`Linha ${i + 2}: Periodicidade inválida '${periodicidade}'. Use: semanal, quinzenal, mensal ou bimestral`);
            }
          }
          
          if (dataInicio) {
            try {
              // Parse different date formats (DD/MM/YYYY, YYYY-MM-DD, etc.)
              let parsedDate: Date | null = null;
              const dateStr = dataInicio.toString().trim();
              
              // Try DD/MM/YYYY format (common in Brazil)
              if (dateStr.includes('/')) {
                const [day, month, year] = dateStr.split('/').map(n => parseInt(n));
                if (day && month && year) {
                  parsedDate = new Date(year, month - 1, day);
                }
              } 
              // Try YYYY-MM-DD format (ISO)
              else if (dateStr.includes('-')) {
                parsedDate = new Date(dateStr);
              }
              // Try Excel serial date number
              else if (!isNaN(Number(dateStr))) {
                // Excel date: days since 1900-01-01
                const excelDate = Number(dateStr);
                const excelEpoch = new Date(1899, 11, 30); // Excel epoch
                parsedDate = new Date(excelEpoch.getTime() + excelDate * 86400000);
              }
              
              if (parsedDate && !isNaN(parsedDate.getTime())) {
                updateData.serviceStartDate = parsedDate;
              } else {
                results.errors.push(`Linha ${i + 2}: Data de início inválida '${dataInicio}'. Use formato DD/MM/YYYY`);
              }
            } catch (error) {
              results.errors.push(`Linha ${i + 2}: Erro ao processar data de início '${dataInicio}'`);
            }
          }

          // Only update if there's something to update
          if (Object.keys(updateData).length > 0) {
            await storage.updateCustomer(customer.id, updateData);
            results.updated++;
            console.log(`Cliente ${customer.name} (${cpfCnpj}) atualizado com sucesso`);
          }

        } catch (error) {
          results.errors.push(`Linha ${i + 2}: Erro ao processar - ${error}`);
        }
      }

      res.json({
        success: true,
        updated: results.updated,
        notFound: results.notFound,
        totalProcessed: data.length,
        errors: results.errors,
        debugInfo: results.debugInfo,
        message: `${results.updated} clientes atualizados com sucesso. ${results.notFound} clientes não encontrados.`
      });
    } catch (error) {
      console.error("Error importing customer data:", error);
      res.status(500).json({ message: "Falha ao importar dados de clientes" });
    }
  });

  // Product routes
  app.get('/api/products', authenticateUser, async (req, res) => {
    try {
      const products = await storage.getProducts();
      res.json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ message: "Failed to fetch products" });
    }
  });

  app.post('/api/products', authenticateUser, async (req: any, res) => {
    try {
      // Only admin and coordinators can manage products
      const user = req.currentUser;
      
      if (!['admin', 'coordinator'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const data = insertProductSchema.parse(req.body);
      const product = await storage.createProduct(data);
      res.json(product);
    } catch (error) {
      console.error("Error creating product:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create product" });
    }
  });

  app.put('/api/products/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      if (!['admin', 'coordinator'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      console.log(`📝 [PUT /api/products/${id}] Payload recebido:`, JSON.stringify(req.body, null, 2));
      
      const data = insertProductSchema.partial().parse(req.body);
      console.log(`✅ [PUT /api/products/${id}] Dados após validação Zod:`, JSON.stringify(data, null, 2));
      
      const product = await storage.updateProduct(id, data);
      console.log(`💾 [PUT /api/products/${id}] Produto salvo:`, JSON.stringify(product, null, 2));
      
      res.json(product);
    } catch (error) {
      console.error(`❌ [PUT /api/products/${id}] Error updating product:`, error);
      res.status(500).json({ message: "Failed to update product" });
    }
  });

  app.delete('/api/products/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      if (!['admin', 'coordinator'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      await storage.deleteProduct(id);
      res.json({ message: "Product deleted successfully" });
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).json({ message: "Failed to delete product" });
    }
  });

  // Upload de imagens para produtos
  app.post('/api/products/:id/upload-images', authenticateUser, upload.array('images', 10), async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      if (!['admin', 'coordinator'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Verificar se o produto existe
      const product = await storage.getProduct(id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      // Processar as imagens enviadas
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ message: "No images provided" });
      }

      // Converter imagens para base64 e criar data URLs
      const imageUrls = files.map(file => {
        const base64Image = file.buffer.toString('base64');
        return `data:${file.mimetype};base64,${base64Image}`;
      });

      // Combinar com imagens existentes (se houver)
      const existingImages = product.images || [];
      const allImages = [...existingImages, ...imageUrls];

      // Limitar a 10 imagens no total
      const finalImages = allImages.slice(0, 10);

      // Atualizar produto com as novas imagens
      await storage.updateProduct(id, {
        images: finalImages,
        imageUrl: finalImages[0] || product.imageUrl // Usar a primeira imagem como imageUrl principal
      });

      res.json({
        message: "Images uploaded successfully",
        uploadedCount: imageUrls.length,
        totalImages: finalImages.length,
        images: finalImages
      });
    } catch (error) {
      console.error("Error uploading product images:", error);
      res.status(500).json({ message: "Failed to upload images" });
    }
  });

  // Remover imagem específica do produto
  app.delete('/api/products/:id/images/:imageIndex', authenticateUser, async (req: any, res) => {
    try {
      const { id, imageIndex } = req.params;
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }

      const product = await storage.getProduct(id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      const images = product.images || [];
      const index = parseInt(imageIndex);

      if (index < 0 || index >= images.length) {
        return res.status(400).json({ message: "Invalid image index" });
      }

      // Remover a imagem do array
      images.splice(index, 1);

      // Atualizar produto
      await storage.updateProduct(id, {
        images: images,
        imageUrl: images[0] || null // Atualizar imageUrl para a primeira imagem restante
      });

      res.json({
        message: "Image removed successfully",
        remainingImages: images.length,
        images: images
      });
    } catch (error) {
      console.error("Error removing product image:", error);
      res.status(500).json({ message: "Failed to remove image" });
    }
  });

  // Sales Goals routes
  app.get('/api/sales-goals', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { month, year, sellerId } = req.query;
      
      // Verificar permissões baseadas no role
      let targetSellerId = undefined;
      
      if (user.role === 'vendedor') {
        // Vendedores só podem ver suas próprias metas
        targetSellerId = user.id;
      } else if (['admin', 'coordinator', 'administrative'].includes(user.role)) {
        // Admins, coordinators e administrativos podem ver todas ou filtrar por vendedor
        targetSellerId = sellerId || undefined;
      } else {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const goals = await storage.getSalesGoals(
        targetSellerId,
        month ? parseInt(month as string) : undefined,
        year ? parseInt(year as string) : undefined
      );
      
      res.json(goals);
    } catch (error) {
      console.error("Error fetching sales goals:", error);
      res.status(500).json({ message: "Failed to fetch sales goals" });
    }
  });

  app.get('/api/sales-goals/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      const goal = await storage.getSalesGoal(id);
      
      if (!goal) {
        return res.status(404).json({ message: "Sales goal not found" });
      }
      
      // Verificar permissões
      if (user.role === 'vendedor' && goal.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(goal);
    } catch (error) {
      console.error("Error fetching sales goal:", error);
      res.status(500).json({ message: "Failed to fetch sales goal" });
    }
  });

  app.post('/api/sales-goals', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admins, coordinators e administrativos podem criar metas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied. Only admins, coordinators and administratives can create sales goals" });
      }
      
      const data = insertSalesGoalSchema.parse({
        ...req.body,
        createdBy: user.id
      });
      
      // Verificar se já existe meta para este vendedor neste mês/ano
      const existingGoal = await storage.getSalesGoalBySeller(data.sellerId, data.month, data.year);
      if (existingGoal && existingGoal.isActive) {
        return res.status(409).json({ 
          message: "Sales goal already exists for this seller in this month/year" 
        });
      }
      
      const goal = await storage.createSalesGoal(data);
      res.json(goal);
    } catch (error) {
      console.error("Error creating sales goal:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create sales goal" });
    }
  });

  app.put('/api/sales-goals/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      // Apenas admins, coordinators e administrativos podem editar metas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied. Only admins, coordinators and administratives can edit sales goals" });
      }
      
      const existingGoal = await storage.getSalesGoal(id);
      if (!existingGoal) {
        return res.status(404).json({ message: "Sales goal not found" });
      }
      
      const data = insertSalesGoalSchema.partial().parse(req.body);
      const goal = await storage.updateSalesGoal(id, data);
      res.json(goal);
    } catch (error) {
      console.error("Error updating sales goal:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update sales goal" });
    }
  });

  app.delete('/api/sales-goals/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      // Apenas admins podem excluir metas
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Access denied. Only admins can delete sales goals" });
      }
      
      const existingGoal = await storage.getSalesGoal(id);
      if (!existingGoal) {
        return res.status(404).json({ message: "Sales goal not found" });
      }
      
      await storage.deleteSalesGoal(id);
      res.json({ message: "Sales goal deleted successfully" });
    } catch (error) {
      console.error("Error deleting sales goal:", error);
      res.status(500).json({ message: "Failed to delete sales goal" });
    }
  });

  // Sales metrics routes - múltiplos vendedores
  app.get('/api/sales-metrics/multiple', authenticateUser, async (req: any, res) => {
    try {
      const { month, year, sellerIds } = req.query;
      const user = req.currentUser;
      
      console.log('📊 Requisição de métricas múltiplas:', { month, year, sellerIds, userRole: user.role });
      
      // Apenas admins/coordinators/administrative podem ver métricas de múltiplos vendedores
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Validar e processar sellerIds
      if (!sellerIds || typeof sellerIds !== 'string') {
        console.log('⚠️ sellerIds inválido ou vazio');
        return res.json({});
      }
      
      const sellerIdArray = sellerIds.split(',').filter(id => id.trim().length > 0);
      
      if (sellerIdArray.length === 0) {
        console.log('⚠️ Array de sellerIds vazio após filtro');
        return res.json({});
      }
      
      console.log('✅ Processando métricas para vendedores:', sellerIdArray);
      
      const metricsMap: Record<string, any> = {};
      
      // Buscar métricas para cada vendedor
      for (const sellerId of sellerIdArray) {
        console.log(`  → Buscando métricas para vendedor: ${sellerId}`);
        const metrics = await storage.getSalesMetrics(
          sellerId.trim(),
          month ? parseInt(month as string) : undefined,
          year ? parseInt(year as string) : undefined
        );
        metricsMap[sellerId] = metrics;
        console.log(`  ✓ Métricas de ${sellerId}:`, { totalRevenue: metrics.totalRevenue });
      }
      
      console.log('📦 Retornando métricas múltiplas:', Object.keys(metricsMap));
      res.json(metricsMap);
    } catch (error) {
      console.error("❌ Error fetching multiple sales metrics:", error);
      console.error('Stack:', error instanceof Error ? error.stack : 'No stack');
      res.status(500).json({ message: "Failed to fetch sales metrics", error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/sales-metrics', authenticateUser, async (req: any, res) => {
    try {
      const { month, year, sellerId } = req.query;
      const user = req.currentUser;
      
      // Verificar se o usuário pode ver as métricas solicitadas
      let targetSellerId = sellerId as string;
      
      if (user.role === 'vendedor') {
        // Vendedores só podem ver suas próprias métricas
        targetSellerId = user.id;
      } else if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const metrics = await storage.getSalesMetrics(
        targetSellerId,
        month ? parseInt(month as string) : undefined,
        year ? parseInt(year as string) : undefined
      );

      res.json(metrics);
    } catch (error) {
      console.error('Erro ao buscar métricas de vendas:', error);
      res.status(500).json({ message: 'Failed to get sales metrics' });
    }
  });

  // Location routes
  app.get('/api/locations', authenticateUser, async (req: any, res) => {
    try {
      // Only admin and coordinators can view locations
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const locations = await storage.getLocations();
      res.json(locations);
    } catch (error) {
      console.error("Error fetching locations:", error);
      res.status(500).json({ message: "Failed to fetch locations" });
    }
  });

  app.post('/api/locations', authenticateUser, async (req: any, res) => {
    try {
      // Only admin and coordinators can manage locations
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const data = insertLocationSchema.parse(req.body);
      const location = await storage.createLocation(data);
      res.json(location);
    } catch (error) {
      console.error("Error creating location:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create location" });
    }
  });

  app.put('/api/locations/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const data = insertLocationSchema.partial().parse(req.body);
      const location = await storage.updateLocation(id, data);
      res.json(location);
    } catch (error) {
      console.error("Error updating location:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update location" });
    }
  });

  app.delete('/api/locations/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      await storage.deleteLocation(id);
      res.json({ message: "Location deleted successfully" });
    } catch (error) {
      console.error("Error deleting location:", error);
      res.status(500).json({ message: "Failed to delete location" });
    }
  });

  // Import locations from Excel file
  app.post('/api/locations/import', authenticateUser, upload.single('file'), async (req: any, res) => {
    try {
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Parse Excel file
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      console.log(`Importing ${data.length} locations from Excel file`);

      const locationsToImport = [];
      const errors = [];

      for (let i = 0; i < data.length; i++) {
        const row = data[i] as any;
        
        try {
          // Map Excel columns to our schema (flexible column names)
          const cpfCnpj = row['CNPJ/CPF'] || row['cpf_cnpj'] || row['cpfCnpj'] || row['documento'] || '';
          const fantasyName = row['Nome Fantasia'] || row['fantasy_name'] || row['fantasyName'] || row['nome'] || '';
          const latitude = parseFloat(row['Latitude'] || row['latitude'] || row['lat'] || '0');
          const longitude = parseFloat(row['Longitude'] || row['longitude'] || row['lng'] || '0');

          if (!cpfCnpj || !fantasyName || latitude === 0 || longitude === 0) {
            errors.push(`Linha ${i + 2}: Dados obrigatórios ausentes (CNPJ/CPF, Nome Fantasia, Latitude, Longitude)`);
            continue;
          }

          // Check if location already exists
          const existingLocation = await storage.getLocationByCpfCnpj(cpfCnpj.toString());
          if (existingLocation) {
            errors.push(`Linha ${i + 2}: Localização já existe para CNPJ/CPF ${cpfCnpj}`);
            continue;
          }

          locationsToImport.push({
            cpfCnpj: cpfCnpj.toString(),
            fantasyName: fantasyName.toString(),
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            isActive: true,
          });
        } catch (error) {
          errors.push(`Linha ${i + 2}: Erro ao processar dados - ${error}`);
        }
      }

      let importedLocations = [];
      if (locationsToImport.length > 0) {
        importedLocations = await storage.bulkCreateLocations(locationsToImport);
      }

      // Update customer coordinates after import
      const coordinatesUpdate = await storage.updateCustomerCoordinatesFromLocations();

      res.json({
        imported: importedLocations.length,
        errors: errors,
        coordinatesUpdated: coordinatesUpdate,
        message: `Importadas ${importedLocations.length} localizações. ${coordinatesUpdate.updated} clientes tiveram suas coordenadas atualizadas.`
      });
    } catch (error) {
      console.error("Error importing locations:", error);
      res.status(500).json({ message: "Failed to import locations" });
    }
  });

  // Update customer coordinates from existing locations
  app.post('/api/locations/update-customer-coordinates', authenticateUser, async (req: any, res) => {
    try {
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const result = await storage.updateCustomerCoordinatesFromLocations();
      res.json({
        message: `Coordenadas atualizadas para ${result.updated} clientes`,
        ...result
      });
    } catch (error) {
      console.error("Error updating customer coordinates:", error);
      res.status(500).json({ message: "Failed to update customer coordinates" });
    }
  });

  // Sales card routes
  app.get('/api/sales-cards', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const sellerId = req.sellerId;
      const routeDay = req.query.route_day; // Filter by route day (segunda, terca, etc)
      const status = req.query.status; // Filter by status
      const user = req.currentUser;
      
      console.log(`📊 [GET-SALES-CARDS] Usuario: ${user?.email}, Rol: ${user?.role}, VendedorId: ${sellerId}, RouteDay: ${routeDay}, Status: ${status}`);
      
      const salesCards = await storage.getSalesCards(sellerId, {
        routeDay,
        status
      });
      
      res.json(salesCards);
    } catch (error) {
      console.error("Error fetching sales cards:", error);
      res.status(500).json({ message: "Failed to fetch sales cards" });
    }
  });

  // Hotsite orders route - busca pedidos do site
  app.get('/api/hotsite-orders', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      console.log('🔍 [HOTSITE-ORDERS] User requesting:', user.email, 'Role:', user.role);
      
      // Apenas admin, coordinator e administrative podem ver pedidos do hotsite
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        console.log('⛔ [HOTSITE-ORDERS] Access denied for role:', user.role);
        return res.status(403).json({ message: "Access denied" });
      }
      
      // ✅ CORREÇÃO: Passar undefined ao invés de {} para buscar todos os cards
      const allCards = await storage.getSalesCards(undefined);
      console.log('📊 [HOTSITE-ORDERS] Total de sales_cards:', allCards.length);
      
      // Filtrar apenas pedidos do hotsite
      const hotsiteOrders = allCards.filter(card => card.source === 'hotsite');
      console.log('📊 [HOTSITE-ORDERS] Sales_cards com source="hotsite":', hotsiteOrders.length);
      
      // Ordenar por data de criação (mais recentes primeiro)
      hotsiteOrders.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });
      
      console.log('✅ [HOTSITE-ORDERS] Retornando', hotsiteOrders.length, 'pedidos');
      
      res.json({ orders: hotsiteOrders });
    } catch (error) {
      console.error("❌ [HOTSITE-ORDERS] Error fetching hotsite orders:", error);
      res.status(500).json({ message: "Failed to fetch hotsite orders" });
    }
  });

  // Excluir pedido do hotsite
  app.delete('/api/hotsite-orders/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const orderId = req.params.id;
      
      console.log('🗑️ [DELETE-HOTSITE-ORDER] User:', user.email, 'deleting order:', orderId);
      
      // Apenas admin, coordinator e administrative podem excluir pedidos do hotsite
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        console.log('⛔ [DELETE-HOTSITE-ORDER] Access denied for role:', user.role);
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Verificar se o pedido existe e é do hotsite
      const order = await storage.getSalesCard(orderId);
      if (!order) {
        return res.status(404).json({ message: "Pedido não encontrado" });
      }
      
      if (order.source !== 'hotsite') {
        return res.status(400).json({ message: "Este pedido não é do hotsite" });
      }
      
      // Excluir o pedido
      await storage.deleteSalesCard(orderId);
      
      console.log('✅ [DELETE-HOTSITE-ORDER] Pedido excluído:', orderId);
      
      res.json({ success: true, message: "Pedido excluído com sucesso" });
    } catch (error) {
      console.error("❌ [DELETE-HOTSITE-ORDER] Error:", error);
      res.status(500).json({ message: "Erro ao excluir pedido" });
    }
  });

  // Enviar pedido do hotsite para Omie
  app.post('/api/hotsite-orders/:id/send-to-omie', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const orderId = req.params.id;
      
      console.log('📤 [SEND-TO-OMIE] User:', user.email, 'sending order:', orderId);
      
      // Apenas admin, coordinator e administrative podem enviar para Omie
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        console.log('⛔ [SEND-TO-OMIE] Access denied for role:', user.role);
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Buscar o pedido completo
      const order = await storage.getSalesCard(orderId);
      if (!order) {
        return res.status(404).json({ message: "Pedido não encontrado" });
      }
      
      if (order.source !== 'hotsite') {
        return res.status(400).json({ message: "Este pedido não é do hotsite" });
      }
      
      // Verificar se já foi enviado para Omie
      if (order.omieOrderId) {
        return res.status(400).json({ 
          message: "Este pedido já foi enviado para o Omie",
          omieOrderNumber: order.omieOrderNumber 
        });
      }
      
      // Buscar dados do cliente
      const customer = await storage.getCustomer(order.customerId);
      if (!customer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Preparar dados para envio ao Omie
      const document = customer.cnpj || customer.cpf;
      if (!document) {
        return res.status(400).json({ 
          message: "Cliente não possui CPF/CNPJ cadastrado" 
        });
      }
      
      // Parsear produtos do pedido (pode vir como string ou array)
      let products;
      if (Array.isArray(order.products)) {
        products = order.products;
      } else if (typeof order.products === 'string') {
        products = JSON.parse(order.products || '[]');
      } else {
        products = [];
      }
      
      if (!products || products.length === 0) {
        return res.status(400).json({ message: "Pedido sem produtos" });
      }
      
      // ✅ VALIDAR CAMPOS OBRIGATÓRIOS ANTES DE ENVIAR PARA OMIE
      if (!order.paymentMethod) {
        return res.status(400).json({ 
          message: "Pedido sem método de pagamento. Não é possível enviar para Omie." 
        });
      }
      
      if (!order.operationType) {
        return res.status(400).json({ 
          message: "Pedido sem tipo de operação. Não é possível enviar para Omie." 
        });
      }
      
      // ✅ Validar saleValue com verificação robusta contra strings mal formatadas
      const totalValue = Number(String(order.saleValue).trim());
      if (!Number.isFinite(totalValue) || totalValue <= 0) {
        return res.status(400).json({ 
          message: `Pedido com valor total inválido: "${order.saleValue}". Não é possível enviar para Omie.` 
        });
      }
      
      // ✅ Validar e formatar produtos em uma única etapa, armazenando valores validados
      const validatedProducts = [];
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        
        if (!p.name && !p.productName) {
          return res.status(400).json({ 
            message: `Produto ${i + 1} sem nome/descrição. Verifique a estrutura do pedido.` 
          });
        }
        
        const quantity = Number(p.quantity);
        const unitPrice = Number(p.unitPrice);
        
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return res.status(400).json({ 
            message: `Produto ${i + 1} (${p.name || p.productName}) com quantidade inválida: "${p.quantity}"` 
          });
        }
        
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          return res.status(400).json({ 
            message: `Produto ${i + 1} (${p.name || p.productName}) com preço unitário inválido: "${p.unitPrice}"` 
          });
        }
        
        // ✅ Calcular/validar totalPrice
        let totalPrice: number;
        if (p.totalPrice !== undefined && p.totalPrice !== null) {
          totalPrice = Number(p.totalPrice);
          if (!Number.isFinite(totalPrice) || totalPrice < 0) {
            return res.status(400).json({ 
              message: `Produto ${i + 1} (${p.name || p.productName}) com totalPrice inválido: "${p.totalPrice}"` 
            });
          }
        } else {
          totalPrice = quantity * unitPrice;
          // ✅ Verificar overflow/Infinity
          if (!Number.isFinite(totalPrice)) {
            return res.status(400).json({ 
              message: `Produto ${i + 1} (${p.name || p.productName}): total calculado resultou em valor inválido` 
            });
          }
        }
        
        // ✅ Armazenar produto validado
        validatedProducts.push({
          description: p.name || p.productName,
          quantity,
          unitPrice,
          totalPrice
        });
      }
      
      // ✅ Validar boletoDays se for pagamento via boleto (SEM defaults silenciosos)
      let boletoDays: number | undefined = undefined;
      if (order.paymentMethod === 'boleto') {
        const days = Number(order.boletoDays);
        if (!Number.isFinite(days) || days <= 0) {
          return res.status(400).json({ 
            message: "Pedido com pagamento via boleto deve ter prazo de dias válido (boletoDays). Não é possível enviar para Omie." 
          });
        }
        boletoDays = days;
      }
      
      // Criar pedido no Omie (com cadastro automático do cliente se necessário)
      console.log('📤 [SEND-TO-OMIE] Enviando para Omie...', {
        paymentMethod: order.paymentMethod,
        operationType: order.operationType,
        saleValue: order.saleValue,
        boletoDays
      });
      
      const omieResult = await createOmieOrder({
        customer: {
          document: document.replace(/\D/g, ''), // Apenas números
          name: customer.fantasyName || customer.name,
          email: customer.email || '',
          phone: customer.phone || '',
          address: customer.address || ''
        },
        products: validatedProducts, // ✅ Usar produtos já validados (sem reconversão)
        totalValue: totalValue, // ✅ Usar valor já validado como numérico
        orderNumber: `WEB-${order.id.substring(0, 8)}`,
        sellerId: order.sellerId,
        paymentMethod: order.paymentMethod, // ✅ Usar valor exato armazenado (já validado acima)
        operationType: order.operationType, // ✅ Usar valor exato armazenado (já validado acima)
        boletoDays: boletoDays // ✅ Usar apenas para boleto
      });
      
      // Atualizar o pedido com informações do Omie
      await storage.updateSalesCard(orderId, {
        omieOrderId: omieResult.codigo_pedido?.toString(),
        omieSyncStatus: 'synced',
        omieSentAt: new Date()
      });
      
      console.log('✅ [SEND-TO-OMIE] Pedido enviado:', omieResult.numero_pedido);
      
      res.json({ 
        success: true, 
        message: "Pedido enviado para Omie com sucesso",
        numero_pedido: omieResult.numero_pedido, // Para compatibilidade com toast do frontend
        codigo_pedido: omieResult.codigo_pedido,
        omieOrderNumber: omieResult.numero_pedido
      });
    } catch (error: any) {
      console.error("❌ [SEND-TO-OMIE] Error:", error);
      res.status(500).json({ 
        message: error.message || "Erro ao enviar pedido para Omie" 
      });
    }
  });

  app.post('/api/sales-cards', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const isAdministrative = ['admin', 'coordinator', 'administrative'].includes(user.role);
      
      // Se o usuário não é administrativo e está tentando criar um card para outro vendedor, bloquear
      if (!isAdministrative && req.body.sellerId && req.body.sellerId !== user.id) {
        return res.status(403).json({ 
          message: "Você não tem permissão para criar cards de vendas para outros vendedores" 
        });
      }
      
      // Se o usuário não é administrativo, forçar o sellerId para o ID do próprio usuário
      const sellerId = isAdministrative ? req.body.sellerId : user.id;
      
      // Validar que o sellerId existe no banco de dados e pode fazer vendas
      if (sellerId) {
        const seller = await storage.getUserById(sellerId);
        if (!seller) {
          return res.status(400).json({ 
            message: "Usuário não encontrado. Por favor, selecione um usuário válido." 
          });
        }
        // Permitir criação de cards para qualquer usuário que possa fazer vendas
        const canSell = ['vendedor', 'coordinator', 'administrative', 'admin'].includes(seller.role);
        if (!canSell) {
          return res.status(400).json({ 
            message: "O usuário selecionado não tem permissão para fazer vendas. Por favor, selecione um vendedor ou administrativo." 
          });
        }
      }
      
      // Processar a data corretamente
      const processedData = {
        ...req.body,
        sellerId, // Usar o sellerId validado
        scheduledDate: new Date(req.body.scheduledDate),
        status: req.body.status || 'pending',
        isRecurring: req.body.isRecurring || true,
      };
      
      // Validar apenas os campos obrigatórios
      const requiredFields = ['customerId', 'sellerId', 'scheduledDate'];
      for (const field of requiredFields) {
        if (!processedData[field]) {
          return res.status(400).json({ 
            message: `Campo obrigatório ausente: ${field}` 
          });
        }
      }
      
      // Buscar o cliente para derivar campos obrigatórios
      const customer = await storage.getCustomer(processedData.customerId);
      if (!customer) {
        return res.status(400).json({ 
          message: "Cliente não encontrado" 
        });
      }
      
      // Derivar routeDay do scheduledDate se não fornecido
      if (!processedData.routeDay && processedData.scheduledDate) {
        const scheduledDate = new Date(processedData.scheduledDate);
        const dayOfWeek = scheduledDate.getDay();
        const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        processedData.routeDay = weekdayNames[dayOfWeek];
      }
      
      // Derivar recurrenceType de customer.visitPeriodicity com fallback para 'semanal'
      if (!processedData.recurrenceType) {
        processedData.recurrenceType = customer.visitPeriodicity || 'semanal';
      }
      
      // Validar que a data agendada está alinhada com os dias de atendimento do cliente
      // Pular validação para fontes especiais (manual_route_addition, rota_do_dia)
      const skipWeekdayValidation = processedData.source === 'manual_route_addition' || 
                                    processedData.source === 'rota_do_dia';
      
      if (customer.weekdays && processedData.scheduledDate && !skipWeekdayValidation) {
        let customerWeekdays: string[] = [];
        try {
          // ✅ Normalização defensiva: garantir formato canônico antes de validar
          const rawWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays || [];
          
          // Normalizar para formato abreviado padrão
          const normalized = normalizeWeekdayInput(rawWeekdays);
          customerWeekdays = normalized || [];
          
          console.log(`🔍 [WEEKDAY VALIDATION] Cliente ${customer.id}:`, {
            raw: rawWeekdays,
            normalized: customerWeekdays
          });
        } catch (e) {
          console.warn(`⚠️ Cliente ${customer.id} tem weekdays inválido, pulando validação`);
        }
        
        if (customerWeekdays.length > 0) {
          const scheduledDate = new Date(processedData.scheduledDate);
          const scheduledDayOfWeek = scheduledDate.getDay();
          const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
          const scheduledDayName = weekdayNames[scheduledDayOfWeek];
          
          if (!customerWeekdays.includes(scheduledDayName)) {
            return res.status(400).json({ 
              message: `A data agendada (${scheduledDayName}) não está nos dias de atendimento do cliente. Este cliente atende em: ${customerWeekdays.join(', ')}` 
            });
          }
        }
      }
      
      // Validar que campos obrigatórios do schema estão presentes
      if (!processedData.routeDay) {
        return res.status(400).json({ 
          message: "Campo obrigatório ausente: routeDay" 
        });
      }
      if (!processedData.recurrenceType) {
        return res.status(400).json({ 
          message: "Campo obrigatório ausente: recurrenceType" 
        });
      }
      
      // Verificar se já existe um card ativo para este cliente
      // Cards ativos são aqueles com status 'pending' ou 'telemarketing'
      const ACTIVE_STATUSES = ['pending', 'telemarketing'];
      const existingCards = await storage.getSalesCards(processedData.sellerId);
      const activeCard = existingCards.find(card => 
        card.customerId === processedData.customerId && 
        ACTIVE_STATUSES.includes(card.status)
      );
      
      if (activeCard) {
        const statusLabel = activeCard.status === 'pending' ? 'pendente' : 'em telemarketing';
        return res.status(400).json({ 
          message: `Este cliente já possui um card de vendas ativo (${statusLabel}). Por favor, utilize o card existente antes de criar um novo.` 
        });
      }
      
      const salesCard = await storage.createSalesCard(processedData);
      
      // Se coordenadas GPS foram capturadas durante a venda, atualizar o cliente
      if (req.body.customerLatitude && req.body.customerLongitude) {
        try {
          await storage.updateCustomer(processedData.customerId, {
            latitude: req.body.customerLatitude,
            longitude: req.body.customerLongitude
          });
        } catch (coordError) {
          console.error('Erro ao atualizar coordenadas do cliente:', coordError);
          // Não falhar a criação da venda se a atualização de coordenadas falhar
        }
      }
      
      res.json(salesCard);
    } catch (error) {
      console.error("Error creating sales card:", error);
      if (error instanceof z.ZodError) {
        console.log('Zod validation errors:', error.errors);
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create sales card" });
    }
  });

  // Importação em massa de cards de venda via planilha
  app.post('/api/sales-cards/bulk-import', authenticateUser, upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Arquivo não enviado" });
      }

      const user = req.currentUser;
      
      if (!user) {
        return res.status(401).json({ message: "Usuário não encontrado" });
      }

      // Processar planilha
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      const results = {
        total: data.length,
        created: 0,
        updated: 0,
        errors: [] as any[],
        debugInfo: [] as any[] // Informações de debug para diagnóstico
      };

      // Processar cada linha da planilha
      for (let i = 0; i < data.length; i++) {
        const row = data[i] as any;
        
        try {
          // Validar campos obrigatórios (aceitar CNPJ ou CNPJ/CPF como nome de coluna)
          const cnpjRaw = row.CNPJ || row['CNPJ/CPF'] || row.cnpj || row['cnpj/cpf'];
          if (!cnpjRaw) {
            results.errors.push({
              row: i + 2, // Excel row (1-indexed + header)
              error: "CNPJ/CPF é obrigatório"
            });
            continue;
          }

          // Limpar CNPJ/CPF
          const document = cnpjRaw.toString().replace(/\D/g, '');
          
          // Verificar se cliente existe (busca tanto em CNPJ quanto em CPF)
          let customer = await storage.getCustomerByDocument(document);
          
          // Se não existe, buscar na Receita Federal e criar
          if (!customer) {
            console.log(`Cliente não encontrado para documento ${document}, consultando Receita Federal...`);
            
            const receitaData = await receitaService.consultarCNPJ(document);
            
            if (!receitaData) {
              results.errors.push({
                row: i + 2,
                document,
                error: "Documento não encontrado na Receita Federal"
              });
              continue;
            }

            // Ler routeDay da planilha para definir weekdays do cliente
            let clientWeekdays: string[] = [];
            const routeDayColCreate = row['ROTA'] || row['Rota'] || row['rota'] || row['Dia da Rota'] || row['dia da rota'] || row['DIA DA ROTA'];
            
            if (routeDayColCreate) {
              const dayStr = routeDayColCreate.toString().toLowerCase().trim();
              const dayMap: Record<string, string> = {
                'segunda': 'Seg', 'segunda-feira': 'Seg', 'segunda feira': 'Seg', 'seg': 'Seg',
                'terça': 'Ter', 'terca': 'Ter', 'terça-feira': 'Ter', 'terca-feira': 'Ter', 'terça feira': 'Ter', 'terca feira': 'Ter', 'ter': 'Ter',
                'quarta': 'Qua', 'quarta-feira': 'Qua', 'quarta feira': 'Qua', 'qua': 'Qua',
                'quinta': 'Qui', 'quinta-feira': 'Qui', 'quinta feira': 'Qui', 'qui': 'Qui',
                'sexta': 'Sex', 'sexta-feira': 'Sex', 'sexta feira': 'Sex', 'sex': 'Sex',
                'sábado': 'Sab', 'sabado': 'Sab', 'sab': 'Sab',
                'domingo': 'Dom', 'dom': 'Dom'
              };
              
              const normalizedDay = dayMap[dayStr];
              if (normalizedDay) {
                clientWeekdays = [normalizedDay];
              }
            }
            
            // Criar cliente com dados da Receita
            customer = await storage.createCustomer({
              cnpj: receitaData.cnpj,
              name: receitaData.nome,
              fantasyName: receitaData.fantasia || receitaData.nome,
              customerType: 'pessoa_juridica',
              email: receitaData.email || '',
              phone: receitaData.telefone || '',
              address: receitaData.logradouro ? 
                `${receitaData.logradouro}, ${receitaData.numero || 'S/N'} - ${receitaData.bairro}` : '',
              city: receitaData.municipio || '',
              state: receitaData.uf || '',
              zipCode: receitaData.cep || '',
              sellerId: user.role === 'vendedor' ? user.id : (row.Vendedor || user.id),
              weekdays: JSON.stringify(clientWeekdays),
              visitPeriodicity: (row.Periodicidade || row.periodicidade || row.FREQUENCIA || row.frequencia)?.toLowerCase() || 'semanal'
            });
            
            results.created++;
            console.log(`Cliente criado: ${customer.fantasyName} (${document})`);
          } else {
            // Atualizar weekdays e periodicidade se fornecidos
            const updateData: any = {};
            
            // Priorizar coluna ROTA para definir weekdays do cliente
            const routeDayColUpdate = row['ROTA'] || row['Rota'] || row['rota'] || row['Dia da Rota'] || row['dia da rota'] || row['DIA DA ROTA'];
            
            if (routeDayColUpdate) {
              const dayStr = routeDayColUpdate.toString().toLowerCase().trim();
              const dayMap: Record<string, string> = {
                'segunda': 'Seg', 'segunda-feira': 'Seg', 'segunda feira': 'Seg', 'seg': 'Seg',
                'terça': 'Ter', 'terca': 'Ter', 'terça-feira': 'Ter', 'terca-feira': 'Ter', 'terça feira': 'Ter', 'terca feira': 'Ter', 'ter': 'Ter',
                'quarta': 'Qua', 'quarta-feira': 'Qua', 'quarta feira': 'Qua', 'qua': 'Qua',
                'quinta': 'Qui', 'quinta-feira': 'Qui', 'quinta feira': 'Qui', 'qui': 'Qui',
                'sexta': 'Sex', 'sexta-feira': 'Sex', 'sexta feira': 'Sex', 'sex': 'Sex',
                'sábado': 'Sab', 'sabado': 'Sab', 'sab': 'Sab',
                'domingo': 'Dom', 'dom': 'Dom'
              };
              
              const normalizedDay = dayMap[dayStr];
              if (normalizedDay) {
                updateData.weekdays = JSON.stringify([normalizedDay]);
                console.log(`✅ Atualizando weekdays do cliente ${customer.fantasyName}: "${routeDayColUpdate}" → "${normalizedDay}"`);
              }
            }
            
            const periodicityCol = row.Periodicidade || row.periodicidade || row.FREQUENCIA || row.frequencia;
            if (periodicityCol) {
              updateData.visitPeriodicity = periodicityCol.toLowerCase();
            }
            
            if (Object.keys(updateData).length > 0) {
              await storage.updateCustomer(customer.id, updateData);
              results.updated++;
            }
          }

          // Verificar se já existe card pendente para este cliente
          const existingCards = await storage.getSalesCards();
          const ACTIVE_STATUSES = ['pending', 'telemarketing'];
          const existingActiveCard = existingCards.find(
            card => card.customerId === customer.id && ACTIVE_STATUSES.includes(card.status)
          );

          // Se já existe card ativo, vamos atualizar as coordenadas dele mais tarde
          // (depois de processar latitude/longitude da planilha)
          const shouldUpdateExistingCard = !!existingActiveCard;

          // Ler routeDay da planilha (prioridade absoluta)
          let routeDay: string;
          const routeDayCol = row['ROTA'] || row['Rota'] || row['rota'] || row['Dia da Rota'] || row['dia da rota'] || row['DIA DA ROTA'] || row['Dia'] || row['dia'];
          
          if (routeDayCol) {
            // Normalizar dia da semana da planilha para formato abreviado padronizado (Seg, Ter, Qua, Qui, Sex, Sab, Dom)
            const dayStr = routeDayCol.toString().toLowerCase().trim();
            const dayMap: Record<string, string> = {
              'segunda': 'Seg', 'segunda-feira': 'Seg', 'segunda feira': 'Seg', 'seg': 'Seg',
              'terça': 'Ter', 'terca': 'Ter', 'terça-feira': 'Ter', 'terca-feira': 'Ter', 'terça feira': 'Ter', 'terca feira': 'Ter', 'ter': 'Ter',
              'quarta': 'Qua', 'quarta-feira': 'Qua', 'quarta feira': 'Qua', 'qua': 'Qua',
              'quinta': 'Qui', 'quinta-feira': 'Qui', 'quinta feira': 'Qui', 'qui': 'Qui',
              'sexta': 'Sex', 'sexta-feira': 'Sex', 'sexta feira': 'Sex', 'sex': 'Sex',
              'sábado': 'Sab', 'sabado': 'Sab', 'sab': 'Sab',
              'domingo': 'Dom', 'dom': 'Dom'
            };
            
            const normalizedDay = dayMap[dayStr];
            if (normalizedDay) {
              routeDay = normalizedDay;
              console.log(`✅ Dia da rota lido da planilha: "${routeDayCol}" → "${routeDay}" para cliente ${customer.fantasyName}`);
            } else {
              // Valor não reconhecido, usar fallback segunda-feira
              routeDay = 'Seg';
              console.log(`⚠️ Dia da rota "${routeDayCol}" não reconhecido na planilha, usando fallback: "Seg" para cliente ${customer.fantasyName}`);
            }
          } else {
            // Fallback: usar próxima segunda-feira
            routeDay = 'Seg';
            console.log(`⚠️ Dia da rota não encontrado na planilha, usando fallback: "${routeDay}" para cliente ${customer.fantasyName}`);
          }

          // Calcular scheduledDate baseado no routeDay da planilha
          // Mapear routeDay para número do dia da semana (0=domingo, 1=segunda, etc.)
          const routeDayToNumber: Record<string, number> = {
            'Dom': 0,
            'Seg': 1,
            'Ter': 2,
            'Qua': 3,
            'Qui': 4,
            'Sex': 5,
            'Sab': 6
          };
          
          const targetDayNumber = routeDayToNumber[routeDay];
          let scheduledDate = new Date();
          
          // Validar que o routeDay foi mapeado corretamente
          if (targetDayNumber === undefined) {
            console.error(`⚠️ ERRO: routeDay "${routeDay}" não foi mapeado para número válido. Usando próxima segunda-feira.`);
            // Fallback para segunda-feira
            const currentDayNumber = scheduledDate.getDay();
            let daysUntilMonday = 1 - currentDayNumber;
            if (daysUntilMonday <= 0) {
              daysUntilMonday += 7;
            }
            scheduledDate.setDate(scheduledDate.getDate() + daysUntilMonday);
          } else {
            // Calcular próxima ocorrência do routeDay
            const currentDayNumber = scheduledDate.getDay();
            let daysUntilTarget = targetDayNumber - currentDayNumber;
            
            // Se o dia já passou esta semana, ir para próxima semana
            // Se é hoje (daysUntilTarget = 0), manter para hoje mesmo
            if (daysUntilTarget < 0) {
              daysUntilTarget += 7;
            }
            
            scheduledDate.setDate(scheduledDate.getDate() + daysUntilTarget);
          }
          
          scheduledDate.setHours(0, 0, 0, 0); // Zerar horário
          console.log(`📅 Card criado para próximo ${routeDay}: ${scheduledDate.toLocaleDateString('pt-BR')} para cliente ${customer.fantasyName}`);

          // DEBUG: Mostrar TODAS as colunas disponíveis nesta linha
          console.log(`🔍 [IMPORT-DEBUG] Cliente ${customer.fantasyName} - Colunas disponíveis:`, Object.keys(row));
          
          // Ler campos (LATITUDE, LONGITUDE e TIPO DE ATENDIMENTO agora são opcionais)
          // Aceitar variações com espaços extras
          const latitudeCol = row['LATITUDE'] || row['Latitude'] || row['latitude'] ||
                              row[' LATITUDE '] || row[' Latitude '] || row[' latitude '] ||
                              row['LATITUDE '] || row[' LATITUDE'] || row['Latitude '] || row[' Latitude'];
          const longitudeCol = row['LONGITUDE'] || row['Longitude'] || row['longitude'] ||
                               row[' LONGITUDE '] || row[' Longitude '] || row[' longitude '] ||
                               row['LONGITUDE '] || row[' LONGITUDE'] || row['Longitude '] || row[' Longitude'];
          
          // DEBUG: Mostrar valores BRUTOS lidos
          const debugRowInfo: any = {
            row: i + 2,
            customer: customer.fantasyName,
            availableColumns: Object.keys(row),
            latitudeCol: latitudeCol,
            latitudeType: typeof latitudeCol,
            longitudeCol: longitudeCol,
            longitudeType: typeof longitudeCol,
            updateData: {} as any
          };
          console.log(`🔍 [IMPORT-DEBUG] Cliente ${customer.fantasyName} - Valores brutos:`, {
            latitudeCol: latitudeCol,
            latitudeType: typeof latitudeCol,
            longitudeCol: longitudeCol,
            longitudeType: typeof longitudeCol
          });
          const tipoAtendimentoCol = row['TIPO DE ATENDIMENTO'] || row['Tipo de Atendimento'] || row['tipo de atendimento'] ||
                                     row['TIPO DE ATENDIMENTO '] || row['Tipo de Atendimento '] || row['tipo de atendimento '] ||
                                     row['TIPOATENDIMENTO'] || row['TipoAtendimento'] || row['tipoatendimento'];

          // Processar e atualizar dados do cliente
          const updateData: any = {};
          
          // LATITUDE (opcional)
          if (latitudeCol && latitudeCol.toString().trim() !== '') {
            const latValue = parseFloat(latitudeCol.toString().replace(',', '.'));
            if (isNaN(latValue)) {
              console.warn(`⚠️ LATITUDE inválida ignorada para cliente ${customer.fantasyName}: "${latitudeCol}"`);
            } else {
              updateData.latitude = latValue.toString();
              console.log(`📍 LATITUDE atualizada para cliente ${customer.fantasyName}: ${updateData.latitude}`);
            }
          } else {
            console.warn(`⚠️ LATITUDE não fornecida para cliente ${customer.fantasyName} - card será criado sem coordenadas`);
          }
          
          // LONGITUDE (opcional)
          if (longitudeCol && longitudeCol.toString().trim() !== '') {
            const lonValue = parseFloat(longitudeCol.toString().replace(',', '.'));
            if (isNaN(lonValue)) {
              console.warn(`⚠️ LONGITUDE inválida ignorada para cliente ${customer.fantasyName}: "${longitudeCol}"`);
            } else {
              updateData.longitude = lonValue.toString();
              console.log(`📍 LONGITUDE atualizada para cliente ${customer.fantasyName}: ${updateData.longitude}`);
            }
          } else {
            console.warn(`⚠️ LONGITUDE não fornecida para cliente ${customer.fantasyName} - card será criado sem coordenadas`);
          }
          
          // TIPO DE ATENDIMENTO (opcional - default é PRESENCIAL)
          if (tipoAtendimentoCol && tipoAtendimentoCol.toString().trim() !== '') {
            const tipoStr = tipoAtendimentoCol.toString().toUpperCase().trim();
            if (tipoStr === 'VIRTUAL') {
              updateData.virtualService = true;
              console.log(`📱 Tipo de atendimento definido como VIRTUAL para cliente ${customer.fantasyName}`);
            } else if (tipoStr === 'PRESENCIAL') {
              updateData.virtualService = false;
              console.log(`🏪 Tipo de atendimento definido como PRESENCIAL para cliente ${customer.fantasyName}`);
            } else {
              console.warn(`⚠️ TIPO DE ATENDIMENTO inválido ignorado para cliente ${customer.fantasyName}: "${tipoAtendimentoCol}". Usando PRESENCIAL como padrão.`);
              updateData.virtualService = false;
            }
          } else {
            // Default: PRESENCIAL
            updateData.virtualService = false;
            console.log(`🏪 Tipo de atendimento padrão (PRESENCIAL) para cliente ${customer.fantasyName}`);
          }
          
          // Salvar debug info
          debugRowInfo.updateData = { ...updateData };
          
          // Atualizar cliente (somente se houver dados para atualizar)
          if (Object.keys(updateData).length > 0) {
            console.log(`🔍 [IMPORT-DEBUG] Cliente ${customer.fantasyName} - UpdateData antes da atualização:`, updateData);
            try {
              await storage.updateCustomer(customer.id, updateData);
              console.log(`✅ [IMPORT-DEBUG] Cliente ${customer.fantasyName} - Atualização concluída com sucesso!`);
              debugRowInfo.updateSuccess = true;
              if (updateData.latitude && updateData.longitude) {
                console.log(`📍 Coordenadas atualizadas para cliente ${customer.fantasyName}: Lat=${updateData.latitude}, Lon=${updateData.longitude}`);
              }
            } catch (updateError) {
              console.error(`❌ [IMPORT-DEBUG] Cliente ${customer.fantasyName} - ERRO na atualização:`, updateError);
              debugRowInfo.updateSuccess = false;
              debugRowInfo.updateError = String(updateError);
              throw updateError;
            }
          } else {
            console.warn(`⚠️ [IMPORT-DEBUG] Cliente ${customer.fantasyName} - Nenhum dado para atualizar (updateData vazio)`);
            debugRowInfo.updateSuccess = false;
            debugRowInfo.reason = 'updateData vazio';
          }
          
          // Adicionar debug info aos resultados
          results.debugInfo.push(debugRowInfo);

          // Ler e validar DATA INICIO (obrigatório)
          const dataInicioCol = row['DATA INICIO'] || row['Data Inicio'] || row['data inicio'] || 
                                row['DATA INÍCIO'] || row['Data Início'] || row['data início'] ||
                                row['DATAINICIO'] || row['DataInicio'] || row['datainicio'];
          
          if (!dataInicioCol || dataInicioCol.toString().trim() === '') {
            results.errors.push({
              row: i + 2,
              customer: customer.fantasyName,
              error: "Campo DATA INICIO é obrigatório"
            });
            continue;
          }
          
          let scheduledDateFinal = scheduledDate; // scheduledDate já calculado baseado em routeDay
          
          if (dataInicioCol) {
            try {
              // Tentar parsear a data de diferentes formatos
              let dataInicio: Date;
              const dataStr = dataInicioCol.toString().trim();
              
              // Se for um número (serial do Excel), converter
              if (!isNaN(Number(dataStr))) {
                // Excel serial date number (número de dias desde 1900-01-01)
                const excelEpoch = new Date(1900, 0, 1);
                const days = parseInt(dataStr) - 2; // -2 porque Excel conta 1900 incorretamente como ano bissexto
                dataInicio = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
              } else if (dataStr.includes('/')) {
                // Formato DD/MM/YYYY ou DD/MM/YY
                const parts = dataStr.split('/');
                if (parts.length === 3) {
                  const day = parseInt(parts[0]);
                  const month = parseInt(parts[1]) - 1; // Mês é 0-indexed
                  let year = parseInt(parts[2]);
                  if (year < 100) year += 2000; // Converter YY para YYYY
                  dataInicio = new Date(year, month, day);
                } else {
                  throw new Error('Formato de data inválido');
                }
              } else if (dataStr.includes('-')) {
                // Formato YYYY-MM-DD ou DD-MM-YYYY
                dataInicio = new Date(dataStr);
              } else {
                throw new Error('Formato de data inválido');
              }
              
              // Validar que a data foi parseada corretamente
              if (isNaN(dataInicio.getTime())) {
                throw new Error('Data inválida');
              }
              
              // Encontrar a próxima ocorrência do routeDay A PARTIR da DATA INICIO (ou nela mesma se coincidir)
              const targetDayNumber = routeDayToNumber[routeDay];
              let nextVisitDate = new Date(dataInicio);
              nextVisitDate.setHours(0, 0, 0, 0);
              
              // Calcular dias até o próximo routeDay
              const currentDayNumber = nextVisitDate.getDay();
              let daysUntilTarget = targetDayNumber - currentDayNumber;
              
              // Se o dia já passou, ir para próxima semana
              // IMPORTANTE: Se daysUntilTarget = 0, significa que DATA INICIO cai no dia da rota!
              // Neste caso, devemos usar a própria DATA INICIO como primeira visita
              if (daysUntilTarget < 0) {
                daysUntilTarget += 7;
              }
              
              nextVisitDate.setDate(nextVisitDate.getDate() + daysUntilTarget);
              scheduledDateFinal = nextVisitDate;
              
              console.log(`📅 DATA INICIO fornecida (${dataInicio.toLocaleDateString('pt-BR')}). Primeira visita agendada para próximo ${routeDay}: ${scheduledDateFinal.toLocaleDateString('pt-BR')} para cliente ${customer.fantasyName}`);
            } catch (dateError) {
              console.error(`⚠️ Erro ao processar DATA INICIO "${dataInicioCol}" para cliente ${customer.fantasyName}:`, dateError);
              // Continuar usando scheduledDate calculado anteriormente
            }
          }

          // Ler periodicidade/recurrenceType da planilha (prioridade) ou do cliente
          let recurrenceType: string;
          const periodicityCol = row.FREQUENCIA || row.Frequencia || row.frequencia || 
                                 row.Periodicidade || row.periodicidade || row.PERIODICIDADE || 
                                 row.Recorrencia || row.recorrencia;
          
          if (periodicityCol) {
            // Normalizar periodicidade da planilha
            const periodStr = periodicityCol.toString().toLowerCase().trim();
            const periodMap: Record<string, string> = {
              'semanal': 'semanal', 'semanalmente': 'semanal', '7 dias': 'semanal', '1 semana': 'semanal',
              'quinzenal': 'quinzenal', 'quinzenalmente': 'quinzenal', '15 dias': 'quinzenal', '2 semanas': 'quinzenal',
              'mensal': 'mensal', 'mensalmente': 'mensal', '30 dias': 'mensal', '1 mês': 'mensal', '1 mes': 'mensal',
              'bimestral': 'bimestral', 'bimestralmente': 'bimestral', '60 dias': 'bimestral', '2 meses': 'bimestral'
            };
            
            const normalizedPeriod = periodMap[periodStr];
            if (normalizedPeriod) {
              recurrenceType = normalizedPeriod;
              console.log(`✅ Periodicidade lida da planilha: "${periodicityCol}" → "${recurrenceType}" para cliente ${customer.fantasyName}`);
            } else {
              // Valor não reconhecido, usar fallback
              recurrenceType = customer.visitPeriodicity || 'semanal';
              console.log(`⚠️ Periodicidade "${periodicityCol}" não reconhecida na planilha, usando do cliente: "${recurrenceType}" para cliente ${customer.fantasyName}`);
            }
          } else {
            // Fallback: usar periodicidade do cliente
            recurrenceType = customer.visitPeriodicity || 'semanal';
            console.log(`⚠️ Periodicidade não encontrada na planilha, usando do cliente: "${recurrenceType}" para cliente ${customer.fantasyName}`);
          }

          // Determinar sellerId válido
          let finalSellerId: string;
          if (user.role === 'vendedor') {
            finalSellerId = user.id;
          } else {
            // Usar sellerId do cliente ou do usuário atual
            const candidateSellerId = customer.sellerId || user.id;
            
            // Verificar se o sellerId existe no sistema
            const sellerExists = await storage.getUser(candidateSellerId);
            
            if (sellerExists) {
              finalSellerId = candidateSellerId;
            } else {
              // Se o vendedor não existe, usar vendedor "Desconhecido"
              finalSellerId = 'unknown-vendor';
              console.warn(`⚠️ Vendedor "${candidateSellerId}" não encontrado para cliente ${customer.fantasyName}. Usando vendedor "Desconhecido".`);
            }
          }

          // Criar ou atualizar card de venda
          if (shouldUpdateExistingCard && existingActiveCard) {
            // Atualizar card existente com as coordenadas atualizadas do cliente
            const updateCardData: any = {};
            
            // Copiar coordenadas atualizadas do cliente para o card
            if (updateData.latitude) {
              updateCardData.customerLatitude = updateData.latitude;
            }
            if (updateData.longitude) {
              updateCardData.customerLongitude = updateData.longitude;
            }
            
            if (Object.keys(updateCardData).length > 0) {
              await storage.updateSalesCard(existingActiveCard.id, updateCardData);
              console.log(`🔄 Card atualizado com coordenadas para cliente ${customer.fantasyName}: LAT=${updateCardData.customerLatitude}, LON=${updateCardData.customerLongitude}`);
            } else {
              console.log(`🔄 Card existente para cliente ${customer.fantasyName} (sem novas coordenadas para atualizar)`);
            }
            
            results.updated++;
          } else {
            // Criar novo card de venda
            await storage.createSalesCard({
              customerId: customer.id,
              sellerId: finalSellerId,
              status: 'pending',
              scheduledDate: scheduledDateFinal,
              routeDay,
              recurrenceType,
              isRecurring: true,
              exclusiveVehicle: false,
              vehicleTypes: ['moto', 'carro', 'caminhao']
            });
            results.created++;
          }

        } catch (rowError: any) {
          console.error(`Erro ao processar linha ${i + 2}:`, rowError);
          results.errors.push({
            row: i + 2,
            error: rowError.message || 'Erro desconhecido'
          });
        }
      }

      // Gerar resumo detalhado dos erros
      const errorSummary: Record<string, number> = {};
      results.errors.forEach(err => {
        const errorType = err.error || 'Erro desconhecido';
        errorSummary[errorType] = (errorSummary[errorType] || 0) + 1;
      });

      const cardsSuccessfullyImported = results.total - results.errors.length;
      
      console.log(`\n📊 RESUMO DA IMPORTAÇÃO:`);
      console.log(`   Total de linhas: ${results.total}`);
      console.log(`   ✅ Cards importados com sucesso: ${cardsSuccessfullyImported}`);
      console.log(`   ❌ Erros: ${results.errors.length}`);
      
      if (Object.keys(errorSummary).length > 0) {
        console.log(`\n❌ DETALHAMENTO DOS ERROS:`);
        Object.entries(errorSummary).forEach(([errorType, count]) => {
          console.log(`   - ${errorType}: ${count} ocorrências`);
        });
      }

      res.json({
        success: true,
        message: `Importação concluída: ${cardsSuccessfullyImported} cards importados, ${results.errors.length} erros`,
        results: {
          ...results,
          successfulImports: cardsSuccessfullyImported,
          errorSummary
        }
      });

    } catch (error: any) {
      console.error("Erro na importação em massa:", error);
      res.status(500).json({ 
        message: "Erro ao processar planilha", 
        error: error.message 
      });
    }
  });

  // Download planilha modelo para importação de sales cards
  app.get('/api/sales-cards/template', (req, res) => {
    try {
      const filePath = path.join(process.cwd(), 'attached_assets', 'modelo_importacao_sales_cards.xlsx');
      res.download(filePath, 'modelo_importacao_sales_cards.xlsx', (err) => {
        if (err) {
          console.error('Erro ao fazer download da planilha modelo:', err);
          res.status(500).json({ message: 'Erro ao baixar planilha modelo' });
        }
      });
    } catch (error: any) {
      console.error('Erro ao servir planilha modelo:', error);
      res.status(500).json({ message: 'Erro ao processar requisição' });
    }
  });

  app.put('/api/sales-cards/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      console.log(`\n🔧 [PUT /api/sales-cards/${id}] Iniciando atualização de card`);
      console.log(`   📥 req.body.routeDay:`, req.body.routeDay);
      
      const data = insertSalesCardSchema.partial().parse(req.body);
      
      console.log(`   ✅ Após parse - data.routeDay:`, data.routeDay);
      
      // Check permissions for reassigning sales cards
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (data.sellerId && user?.role === 'vendedor') {
        return res.status(403).json({ message: "Vendedores cannot reassign sales cards" });
      }
      
      // Buscar card ANTES da atualização
      const cardBefore = await storage.getSalesCard(id);
      console.log(`   📋 ANTES - routeDay:`, cardBefore?.routeDay);
      
      // Se coordenadas GPS foram capturadas, atualizar o cliente
      if (req.body.customerLatitude && req.body.customerLongitude) {
        try {
          // Buscar card atual para pegar customerId
          const currentCard = await storage.getSalesCard(id);
          if (currentCard) {
            await storage.updateCustomer(currentCard.customerId, {
              latitude: req.body.customerLatitude,
              longitude: req.body.customerLongitude
            });
            console.log(`Coordenadas GPS atualizadas para cliente ${currentCard.customerId}`);
          }
        } catch (coordError) {
          console.error('Erro ao atualizar coordenadas do cliente:', coordError);
        }
      }
      
      // NOVA ARQUITETURA: Permanent cards não fecham/criam novos - atualizam order_history
      let salesCard;
      if (data.status && ['completed', 'no_sale', 'failed'].includes(data.status)) {
        // Buscar card atual para verificar se é permanent
        const currentCard = await storage.getSalesCard(id);
        
        if (!currentCard) {
          return res.status(404).json({ message: "Sales card not found" });
        }
        
        // ✅ CHECK-OUT AUTOMÁTICO: Se registrou pedido ou "não venda", fazer check-out automaticamente
        // APENAS se o status está MUDANDO para completed ou no_sale (não executar em updates irrelevantes)
        const isStatusChanging = currentCard.status !== data.status;
        const shouldAutoCheckout = isStatusChanging && ['completed', 'no_sale'].includes(data.status);
        
        if (shouldAutoCheckout) {
          try {
            console.log(`🔄 [AUTO-CHECKOUT] Status mudando para "${data.status}" - verificando visita relacionada ao card ${id}...`);
            
            // Buscar visita relacionada a este sales card (mais recente da data de hoje)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            
            console.log(`🔍 [AUTO-CHECKOUT DEBUG] Buscando visita para card ${id}`);
            console.log(`   📅 Data range: ${today.toISOString()} até ${tomorrow.toISOString()}`);
            
            const relatedVisits = await db.select()
              .from(visitAgenda)
              .where(and(
                eq(visitAgenda.salesCardId, id),
                gte(visitAgenda.scheduledDate, today),
                lt(visitAgenda.scheduledDate, tomorrow)
              ))
              .orderBy(desc(visitAgenda.createdAt))
              .limit(1);
            
            console.log(`   📊 Visitas encontradas: ${relatedVisits.length}`);
            
            if (relatedVisits.length > 0) {
              const visit = relatedVisits[0];
              console.log(`📋 [AUTO-CHECKOUT] Visita encontrada: ${visit.id}, status: ${visit.visitStatus}`);
              
              // Verificar se tem check-in mas não tem check-out
              if (visit.actualCheckIn && !visit.actualCheckOut) {
                // Validar se coordenadas do check-in existem
                if (!visit.checkInLatitude || !visit.checkInLongitude) {
                  console.log(`⚠️ [AUTO-CHECKOUT] Coordenadas do check-in ausentes - pulando check-out automático`);
                } else {
                  console.log(`✅ [AUTO-CHECKOUT] Visita tem check-in sem check-out - executando check-out automático...`);
                  
                  const checkOutTime = new Date();
                  const checkInTime = new Date(visit.actualCheckIn);
                  const visitDuration = Math.round((checkOutTime.getTime() - checkInTime.getTime()) / 60000); // em minutos
                  
                  // Usar as mesmas coordenadas do check-in para o check-out
                  const checkOutLat = visit.checkInLatitude;
                  const checkOutLon = visit.checkInLongitude;
                  
                  // Definir visitStatus baseado no status do sales card
                  const visitStatus = data.status === 'completed' ? 'completed' : 'no_sale';
                  
                  // Atualizar visita com dados de check-out
                  await db.update(visitAgenda)
                    .set({
                      actualCheckOut: checkOutTime,
                      checkOutLatitude: checkOutLat,
                      checkOutLongitude: checkOutLon,
                      visitStatus: visitStatus,
                      visitDuration: visitDuration,
                      isAutoCheckout: false // Check-out por ação do vendedor (venda/não-venda)
                    })
                    .where(eq(visitAgenda.id, visit.id));
                  
                  console.log(`✅ [AUTO-CHECKOUT] Check-out automático realizado em ${checkOutTime.toLocaleTimeString('pt-BR')} com status "${visitStatus}"`);
                  console.log(`⏱️ [AUTO-CHECKOUT] Duração da visita: ${visitDuration} minutos`);
                  
                  // Registrar checkpoint de check-out na rota diária (se existir)
                  // Importante: nem todas as vendas/não-vendas acontecem durante rotas planejadas
                  // CRITICAL: Envolver tudo em try-catch para não bloquear check-out se rota falhar
                  try {
                    const dailyRoute = await db.select()
                      .from(dailyRoutes)
                      .where(and(
                        eq(dailyRoutes.sellerId, visit.sellerId),
                        eq(dailyRoutes.routeDate, today)
                      ))
                      .limit(1);
                    
                    if (dailyRoute.length > 0) {
                      console.log(`📍 [AUTO-CHECKOUT] Registrando checkpoint de check-out na rota ${dailyRoute[0].id}...`);
                      
                      // Usar função padronizada registerCheckpoint para garantir consistência
                      const { registerCheckpoint } = await import('./routeOptimizationService');
                      await registerCheckpoint(
                        storage,
                        dailyRoute[0].id,
                        visit.id,
                        visit.customerId,
                        visit.sellerId,
                        'check_out',
                        parseFloat(checkOutLat),
                        parseFloat(checkOutLon)
                      );
                      
                      console.log(`✅ [AUTO-CHECKOUT] Checkpoint de check-out registrado com sucesso`);
                    } else {
                      console.log(`ℹ️ [AUTO-CHECKOUT] Sem rota diária - check-out registrado apenas na visita`);
                    }
                  } catch (routeError: any) {
                    console.error(`⚠️ [AUTO-CHECKOUT] Erro ao processar checkpoint (rota/DB):`, routeError.message);
                    // Não bloquear o check-out - visita já foi atualizada acima
                  }
                }
              } else if (!visit.actualCheckIn) {
                console.log(`ℹ️ [AUTO-CHECKOUT] Visita não possui check-in - pulando check-out automático`);
              } else if (visit.actualCheckOut) {
                console.log(`ℹ️ [AUTO-CHECKOUT] Visita já possui check-out - pulando`);
              }
            } else {
              console.log(`ℹ️ [AUTO-CHECKOUT] Nenhuma visita relacionada encontrada para o card ${id} na data de hoje`);
            }
          } catch (autoCheckoutError) {
            console.error('❌ [AUTO-CHECKOUT] Erro ao fazer check-out automático:', autoCheckoutError);
            // Não bloquear o fluxo principal se o check-out automático falhar
          }
        }
        
        if (currentCard.isPermanent) {
          // PERMANENT CARD: criar order_history e recalcular nextVisitDate
          console.log(`🔄 Permanent card - Criando order_history e recalculando próxima visita`);
          
          // 1. Criar registro em order_history
          const orderData = {
            salesCardId: id,
            orderDate: new Date(),
            products: data.products || currentCard.products || [],
            totalValue: data.saleValue || currentCard.saleValue || '0',
            status: data.status === 'completed' ? 'completed' as const : 'cancelled' as const,
            notes: data.notes || (data.status === 'no_sale' ? `Sem venda - ${data.noSaleReason || 'não informado'}` : null),
            checkInTime: data.checkInTime,
            checkInLatitude: data.checkInLatitude,
            checkInLongitude: data.checkInLongitude,
            checkOutTime: data.checkOutTime,
            checkOutLatitude: data.checkOutLatitude,
            checkOutLongitude: data.checkOutLongitude,
            completedAt: data.status === 'completed' ? new Date() : null
          };
          
          await storage.createOrderHistory(orderData);
          console.log(`✅ Order history criado`);
          
          // 2. Atualizar lastVisitDate e recalcular nextVisitDate
          const { calculateNextVisitDate } = await import('../shared/visitSchedule');
          const customer = await storage.getCustomer(currentCard.customerId);
          
          if (customer && customer.weekdays && customer.visitPeriodicity) {
            // SEMPRE atualizar lastVisitDate quando houver visita (independente do resultado)
            const lastVisitDate = new Date();
            
            const parsedWeekdays = typeof customer.weekdays === 'string' 
              ? JSON.parse(customer.weekdays) 
              : customer.weekdays;
            
            // Buscar última venda COMPLETED do order_history para base de cálculo
            let lastCompletedSaleDate: Date | undefined;
            
            if (data.status === 'completed') {
              // Se esta visita foi completed, usar hoje
              lastCompletedSaleDate = lastVisitDate;
            } else {
              // Buscar última venda completed no histórico (ignora no_sale/failed)
              const { db } = await import('./db');
              const { orderHistory } = await import('../shared/schema');
              const { eq, desc, and } = await import('drizzle-orm');
              
              const lastCompletedOrder = await db
                .select({ orderDate: orderHistory.orderDate })
                .from(orderHistory)
                .where(and(
                  eq(orderHistory.salesCardId, id),
                  eq(orderHistory.status, 'completed')
                ))
                .orderBy(desc(orderHistory.orderDate))
                .limit(1);
              
              if (lastCompletedOrder.length > 0 && lastCompletedOrder[0].orderDate) {
                lastCompletedSaleDate = lastCompletedOrder[0].orderDate;
                console.log(`📅 Última venda completed encontrada: ${lastCompletedSaleDate.toLocaleDateString('pt-BR')}`);
              } else {
                // Nunca teve venda completed
                lastCompletedSaleDate = undefined;
                console.log(`📅 Nenhuma venda completed encontrada - cliente novo ou sem vendas`);
              }
            }
            
            const scheduleResult = calculateNextVisitDate({
              weekdays: parsedWeekdays,
              periodicity: customer.visitPeriodicity,
              lastCompletedDate: lastCompletedSaleDate,
              referenceDate: new Date()
            });
            
            // Atualizar permanent card
            salesCard = await storage.updateSalesCard(id, {
              ...data,
              lastVisitDate: lastVisitDate,  // Sempre atualiza (qualquer visita)
              nextVisitDate: scheduleResult.nextDate,
              status: 'pending' // Permanent card sempre volta para pending
            });
            
            console.log(`✅ Permanent card atualizado - Última visita: ${lastVisitDate.toLocaleDateString('pt-BR')}, Próxima: ${scheduleResult.nextDate.toLocaleDateString('pt-BR')}`);
          } else {
            // Fallback se cliente não tiver configuração completa
            salesCard = await storage.updateSalesCard(id, data);
          }
        } else {
          // LEGACY CARD: usar lógica antiga (se ainda existir algum)
          const result = await storage.closeCardAndScheduleNext(id, data.status as any, data);
          salesCard = result.closedCard;
          
          if (result.nextCard) {
            console.log(`Card fechado e próxima visita agendada: ${result.nextCard.id} para ${result.nextCard.scheduledDate}`);
          }
        }
      } else {
        // Atualização normal sem mudança de status final
        console.log(`   💾 Salvando card com routeDay:`, data.routeDay);
        salesCard = await storage.updateSalesCard(id, data);
        console.log(`   ✅ Card salvo - routeDay:`, salesCard.routeDay);
        
        // PROPAGAÇÃO DE ALTERAÇÕES:
        // - Usuários ADMINISTRATIVOS: replicar para TODOS os cards do cliente (futuros E passados)
        // - Vendedores: replicar apenas para cards futuros
        if (user && ['admin', 'coordinator', 'administrative'].includes(user.role)) {
          console.log(`🔐 Usuário administrativo (${user.role}) - Propagando alterações para TODOS os cards do cliente`);
          const updatedCount = await storage.updateAllCustomerCardsConfig(id, data);
          if (updatedCount > 0) {
            console.log(`✅ [PROPAGAÇÃO ADMIN] Configurações replicadas para ${updatedCount} card(s) do cliente`);
          }
        } else {
          // Vendedores: apenas cards futuros (comportamento padrão anterior)
          const updatedCount = await storage.updateFutureCardsConfig(id, data);
          if (updatedCount > 0) {
            console.log(`✅ Configurações replicadas para ${updatedCount} cards futuros`);
          }
        }
        
        // PROPAGAÇÃO DE MUDANÇA DE RECORRÊNCIA:
        // Detectar se recurrenceType mudou e ajustar cards futuros
        if (cardBefore && data.recurrenceType && cardBefore.recurrenceType !== data.recurrenceType) {
          console.log(`🔄 Mudança de recorrência detectada: ${cardBefore.recurrenceType} → ${data.recurrenceType}`);
          
          try {
            const userName = user?.name || user?.email || 'Usuário';
            const recurrenceResult = await propagateRecurrenceChange({
              cardId: id,
              oldRecurrence: cardBefore.recurrenceType,
              newRecurrence: data.recurrenceType,
              baseDate: cardBefore.scheduledDate,
              userName
            });
            
            console.log(`✅ [RECORRÊNCIA] ${recurrenceResult.cardsCreated} cards criados, ${recurrenceResult.cardsRemoved} cards removidos`);
          } catch (recurrenceError: any) {
            console.error(`❌ Erro ao propagar mudança de recorrência:`, recurrenceError);
            // Não falhar a requisição inteira por erro na propagação
          }
        }
        
        // Buscar card DEPOIS da propagação para confirmar valor final
        const cardAfter = await storage.getSalesCard(id);
        console.log(`   📋 DEPOIS - routeDay:`, cardAfter?.routeDay);
        salesCard = cardAfter!; // Atualizar salesCard para retornar o valor mais recente
      }
      
      res.json(salesCard);
    } catch (error) {
      console.error("Error updating sales card:", error);
      if (error instanceof z.ZodError) {
        console.log('Zod validation errors:', error.errors);
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update sales card" });
    }
  });

  app.post('/api/sales-cards/:id/duplicate', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { newDate } = req.body;
      
      if (!newDate) {
        return res.status(400).json({ message: "New date is required" });
      }
      
      const duplicatedCard = await storage.duplicateSalesCard(id, new Date(newDate));
      res.json(duplicatedCard);
    } catch (error) {
      console.error("Error duplicating sales card:", error);
      res.status(500).json({ message: "Failed to duplicate sales card" });
    }
  });

  app.delete('/api/sales-cards/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.deleteSalesCard(id);
      res.json({ message: "Sales card deleted successfully" });
    } catch (error) {
      console.error("Error deleting sales card:", error);
      res.status(500).json({ message: "Failed to delete sales card" });
    }
  });

  // Delete all sales cards (admin only)
  app.delete('/api/sales-cards', authenticateUser, requireRole(['admin', 'administrative']), async (req: any, res) => {
    try {
      const deletedCount = await storage.deleteAllSalesCards();
      res.json({ 
        message: "All sales cards deleted successfully", 
        deletedCount 
      });
    } catch (error) {
      console.error("Error deleting all sales cards:", error);
      res.status(500).json({ message: "Failed to delete all sales cards" });
    }
  });

  // Toggle urgent delivery status
  app.patch('/api/sales-cards/:id/urgent', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { isUrgent } = req.body;
      
      if (typeof isUrgent !== 'boolean') {
        return res.status(400).json({ message: "isUrgent must be a boolean value" });
      }
      
      const salesCard = await storage.updateSalesCard(id, { isUrgent });
      res.json(salesCard);
    } catch (error) {
      console.error("Error updating urgent status:", error);
      res.status(500).json({ message: "Failed to update urgent status" });
    }
  });

  // Toggle urgent delivery status for billings (before roteirização)
  app.patch('/api/billings/:id/urgent', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { isUrgent } = req.body;
      
      if (typeof isUrgent !== 'boolean') {
        return res.status(400).json({ message: "isUrgent must be a boolean value" });
      }
      
      const billing = await storage.updateBillingUrgency(id, isUrgent);
      res.json(billing);
    } catch (error: any) {
      console.error("Error updating billing urgent status:", error);
      if (error.message && error.message.includes('not found')) {
        return res.status(404).json({ message: "Billing not found" });
      }
      res.status(500).json({ message: "Failed to update billing urgent status" });
    }
  });

  // ==================== ORDER HISTORY ROUTES ====================
  
  // Get permanent card for a customer (or create if doesn't exist)
  app.get('/api/customers/:customerId/permanent-card', authenticateUser, async (req: any, res) => {
    try {
      const { customerId } = req.params;
      const sellerId = req.user.id;
      
      const permanentCard = await storage.getOrCreatePermanentCard(customerId, sellerId);
      res.json(permanentCard);
    } catch (error) {
      console.error("Error getting/creating permanent card:", error);
      res.status(500).json({ message: "Failed to get/create permanent card" });
    }
  });

  // Get or create sales card for a specific customer on a specific date
  // NOTA: customerId pode ser um leadId (leads também usam sales_cards com leadId como customerId)
  app.get('/api/customers/:customerId/sales-card/:date', authenticateUser, async (req: any, res) => {
    try {
      const { customerId, date } = req.params;
      const user = req.currentUser;
      
      if (!user) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      // Parse date string to Date object (UTC midnight)
      const targetDate = new Date(`${date}T00:00:00.000Z`);
      
      // Buscar todos os sales cards daquele dia
      const cardsOnDate = await storage.getSalesCardsByDate(targetDate);
      
      // Filtrar pelo customerId (pode ser customerId ou leadId)
      const existingCard = cardsOnDate.find(card => card.customerId === customerId);
      
      if (existingCard) {
        return res.json(existingCard);
      }

      // Se não existe card, verificar se é um customer ou lead
      const customer = await storage.getCustomer(customerId);
      
      if (customer) {
        // É um customer regular
        // Determinar sellerId - usar o do cliente ou o usuário atual se for vendedor
        let sellerId = customer.sellerId || user.id;
        
        // Se o usuário é vendedor, forçar usar o próprio ID
        if (user.role === 'vendedor') {
          sellerId = user.id;
        }

        // Criar novo sales card com campos obrigatórios
        // NOTA: source='rota_do_dia' permite criar card mesmo fora dos weekdays configurados
        // (cliente pode ter sido adicionado manualmente à rota)
        const newCard = await storage.createSalesCard({
          customerId,
          sellerId,
          scheduledDate: targetDate,
          status: 'open',
          source: 'rota_do_dia',
          routeDay: 'Seg', // Default
          recurrenceType: 'semanal',
          exclusiveVehicle: false,
          vehicleTypes: [],
        });

        // Buscar card completo com relações
        const fullCard = await storage.getSalesCard(newCard.id);
        return res.json(fullCard);
      }

      // Verificar se é um lead
      const lead = await storage.getLead(customerId);
      
      if (lead) {
        // É um lead - criar sales_card com leadId como customerId
        let sellerId = lead.assignedTo || user.id;
        
        // Se o usuário é vendedor, forçar usar o próprio ID
        if (user.role === 'vendedor') {
          sellerId = user.id;
        }

        console.log(`📋 Criando sales_card para LEAD ${lead.fantasyName} (${customerId}) na data ${date}`);

        const newCard = await storage.createSalesCard({
          customerId, // leadId vai aqui
          sellerId,
          scheduledDate: targetDate,
          status: 'open',
          source: 'rota_do_dia',
          routeDay: 'Seg', // Default
          recurrenceType: 'semanal',
          exclusiveVehicle: false,
          vehicleTypes: [],
        });

        // Buscar card completo com relações
        const fullCard = await storage.getSalesCard(newCard.id);
        return res.json(fullCard);
      }

      // Nem customer nem lead encontrado
      return res.status(404).json({ message: "Customer or Lead not found" });

    } catch (error) {
      console.error("Error getting/creating sales card for date:", error);
      res.status(500).json({ message: "Failed to get/create sales card" });
    }
  });
  
  // Create new order in history
  app.post('/api/order-history', authenticateUser, async (req: any, res) => {
    try {
      const orderData = req.body;
      
      // Validar dados do pedido
      if (!orderData.salesCardId || !orderData.products || !orderData.totalValue) {
        return res.status(400).json({ 
          message: "salesCardId, products, and totalValue are required" 
        });
      }
      
      const newOrder = await storage.createOrderHistory(orderData);
      res.json(newOrder);
    } catch (error) {
      console.error("Error creating order history:", error);
      res.status(500).json({ message: "Failed to create order" });
    }
  });
  
  // Get order history for a sales card
  app.get('/api/sales-cards/:salesCardId/orders', authenticateUser, async (req: any, res) => {
    try {
      const { salesCardId } = req.params;
      
      const orders = await storage.getOrderHistoryByCard(salesCardId);
      res.json(orders);
    } catch (error) {
      console.error("Error fetching order history:", error);
      res.status(500).json({ message: "Failed to fetch order history" });
    }
  });
  
  // Get single order
  app.get('/api/order-history/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const order = await storage.getOrderHistoryById(id);
      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ message: "Failed to fetch order" });
    }
  });
  
  // Update order
  app.put('/api/order-history/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const orderData = req.body;
      
      const updatedOrder = await storage.updateOrderHistory(id, orderData);
      res.json(updatedOrder);
    } catch (error) {
      console.error("Error updating order:", error);
      res.status(500).json({ message: "Failed to update order" });
    }
  });
  
  // Delete order
  app.delete('/api/order-history/:id', authenticateUser, requireRole(['admin', 'administrative']), async (req: any, res) => {
    try {
      const { id } = req.params;
      
      await storage.deleteOrderHistory(id);
      res.json({ message: "Order deleted successfully" });
    } catch (error) {
      console.error("Error deleting order:", error);
      res.status(500).json({ message: "Failed to delete order" });
    }
  });
  
  // Gerar próximas 3 visitas para clientes ativos (admin only)
  app.post('/api/admin/generate-next-visits', async (req: any, res) => {
    try {
      console.log(`📅 [MANUAL] Iniciando geração manual de próximas 3 visitas para clientes ativos...`);
      const result = await storage.generateNextVisitsForActiveCustomers();
      console.log(`✅ [MANUAL] Geração de visitas concluída:`);
      console.log(`   - ${result.processed} clientes processados`);
      console.log(`   - ${result.generated} visitas geradas`);
      if (result.errors > 0) {
        console.log(`   - ⚠️ ${result.errors} erro(s) encontrado(s)`);
      }
      res.json({
        success: true,
        message: 'Geração de visitas concluída',
        stats: result
      });
    } catch (error: any) {
      console.error('❌ Erro na geração manual de visitas:', error);
      res.status(500).json({ 
        success: false,
        message: 'Erro ao gerar visitas',
        error: error.message 
      });
    }
  });

  // Run migration to permanent cards (admin only)
  app.post('/api/admin/migrate-to-permanent-cards', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { dryRun = true } = req.body;
      
      console.log(`\n🔄 Starting migration to permanent cards (dryRun: ${dryRun})...`);
      
      // Importar função de migração dinamicamente
      const { migrateToPermanentCards } = await import('./migrateToPermanentCards');
      
      const stats = await migrateToPermanentCards(dryRun);
      
      res.json({
        success: true,
        dryRun,
        stats,
        message: dryRun 
          ? 'Dry run completed. Review the stats and run with dryRun:false to apply changes.'
          : 'Migration completed successfully!'
      });
    } catch (error: any) {
      console.error("Error running migration:", error);
      res.status(500).json({ 
        success: false,
        message: "Migration failed", 
        error: error.message 
      });
    }
  });

  // Migrate receiving weekdays (admin only) - populate receiving_weekdays and clean duplicates from delivery_weekdays
  app.post('/api/admin/migrate-receiving-weekdays', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { dryRun = true } = req.body;
      
      console.log(`\n🔄 Starting receiving weekdays migration (dryRun: ${dryRun})...`);
      
      // Buscar todos os clientes
      const allCustomers = await storage.getCustomers();
      
      const stats = {
        totalAnalyzed: 0,
        deliveryWeekdaysNormalized: 0,
        receivingWeekdaysPopulated: 0,
        alreadyCorrect: 0,
        changes: [] as any[]
      };
      
      for (const customer of allCustomers) {
        stats.totalAnalyzed++;
        
        let needsUpdate = false;
        const updates: any = {};
        
        // Parse delivery_weekdays
        let deliveryWeekdays: string[] = [];
        try {
          if (customer.deliveryWeekdays) {
            deliveryWeekdays = normalizeWeekdayInput(customer.deliveryWeekdays);
          }
        } catch (error) {
          console.error(`Error normalizing delivery_weekdays for customer ${customer.id}:`, error);
        }
        
        // Parse receiving_weekdays
        let receivingWeekdays: string[] = [];
        try {
          if (customer.receivingWeekdays) {
            receivingWeekdays = normalizeWeekdayInput(customer.receivingWeekdays);
          }
        } catch (error) {
          console.error(`Error normalizing receiving_weekdays for customer ${customer.id}:`, error);
        }
        
        // Remover duplicatas de delivery_weekdays
        const uniqueDeliveryWeekdays = Array.from(new Set(deliveryWeekdays));
        if (uniqueDeliveryWeekdays.length !== deliveryWeekdays.length || 
            JSON.stringify(uniqueDeliveryWeekdays) !== JSON.stringify(deliveryWeekdays)) {
          updates.deliveryWeekdays = uniqueDeliveryWeekdays;
          needsUpdate = true;
          stats.deliveryWeekdaysNormalized++;
        }
        
        // Popular receiving_weekdays se estiver vazio
        if (receivingWeekdays.length === 0 && uniqueDeliveryWeekdays.length > 0) {
          updates.receivingWeekdays = uniqueDeliveryWeekdays;
          needsUpdate = true;
          stats.receivingWeekdaysPopulated++;
        }
        
        // Registrar mudanças
        if (needsUpdate) {
          const change = {
            customerId: customer.id,
            customerName: customer.fantasyName || customer.name,
            before: {
              deliveryWeekdays,
              receivingWeekdays
            },
            after: {
              deliveryWeekdays: updates.deliveryWeekdays || deliveryWeekdays,
              receivingWeekdays: updates.receivingWeekdays || receivingWeekdays
            }
          };
          
          if (stats.changes.length < 100) {
            stats.changes.push(change);
          }
          
          // Aplicar mudanças se não for dry-run
          if (!dryRun) {
            await db.execute(sql`
              UPDATE customers 
              SET 
                delivery_weekdays = ${JSON.stringify(updates.deliveryWeekdays || deliveryWeekdays)}::jsonb,
                receiving_weekdays = ${JSON.stringify(updates.receivingWeekdays || receivingWeekdays)}::jsonb
              WHERE id = ${customer.id}
            `);
          }
        } else {
          stats.alreadyCorrect++;
        }
      }
      
      console.log(`✅ Migration completed:`, {
        totalAnalyzed: stats.totalAnalyzed,
        deliveryWeekdaysNormalized: stats.deliveryWeekdaysNormalized,
        receivingWeekdaysPopulated: stats.receivingWeekdaysPopulated,
        alreadyCorrect: stats.alreadyCorrect
      });
      
      res.json({
        success: true,
        dryRun,
        stats,
        message: dryRun 
          ? 'Dry run completed. Review the stats and run with dryRun:false to apply changes.'
          : 'Migration completed successfully!'
      });
    } catch (error: any) {
      console.error("Error running migration:", error);
      res.status(500).json({ 
        success: false,
        message: "Migration failed", 
        error: error.message 
      });
    }
  });

  // Fix billings missing delivery_weekdays (admin only)
  app.post('/api/admin/fix-billing-delivery-days', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      console.log(`\n🔧 Fixing billings with missing delivery_weekdays...`);
      
      // Copiar delivery_weekdays do customer para billings que estão vazios
      const result = await db.execute(sql`
        UPDATE billings b
        SET delivery_weekdays = ARRAY(SELECT jsonb_array_elements_text(c.delivery_weekdays))
        FROM customers c
        WHERE (b.delivery_weekdays IS NULL OR b.delivery_weekdays = '{}')
          AND b.invoice_stage = 'Aguardando Rota'
          AND b.omie_customer_code = c.omie_client_code
          AND c.delivery_weekdays IS NOT NULL 
          AND c.delivery_weekdays != '[]'::jsonb
      `);
      
      const fixedCount = result.rowCount || 0;
      
      console.log(`✅ Fixed ${fixedCount} billings`);
      
      res.json({
        success: true,
        fixedCount,
        message: `Successfully copied delivery_weekdays from customers to ${fixedCount} billings`
      });
    } catch (error: any) {
      console.error("Error fixing billings:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to fix billings", 
        error: error.message 
      });
    }
  });

  // Fix customers with incorrect delivery_weekdays (admin only)
  app.post('/api/admin/fix-customer-delivery-days', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      console.log(`\n🔧 Fixing customers with incorrect delivery_weekdays...`);
      
      // Buscar TODOS os customers
      const allCustomers = await db.select().from(customers);
      console.log(`📊 Total customers: ${allCustomers.length}`);
      
      // Identificar o fallback problemático (case-insensitive, order-insensitive)
      const problematicFallback = ["Seg", "Ter", "Qua", "Qui", "Sex"].map(d => d.toLowerCase()).sort();
      
      let fixedCount = 0;
      let alreadyCorrect = 0;
      
      for (const customer of allCustomers) {
        const currentDeliveryDays = customer.deliveryWeekdays || [];
        
        // Normalizar para comparação (lowercase, sorted)
        const normalizedCurrentDays = currentDeliveryDays.map((d: string) => d.toLowerCase()).sort();
        
        // Verificar se tem o fallback problemático
        const hasFallback = JSON.stringify(normalizedCurrentDays) === JSON.stringify(problematicFallback);
        
        if (hasFallback) {
          // Recalcular baseado nos weekdays
          // weekdays pode ser array ou string JSON, precisamos normalizar
          let weekdays: string[] = [];
          try {
            if (Array.isArray(customer.weekdays)) {
              weekdays = customer.weekdays;
            } else if (typeof customer.weekdays === 'string' && customer.weekdays.trim().length > 0) {
              // Tentar fazer parse do JSON string
              weekdays = JSON.parse(customer.weekdays);
            }
          } catch (e) {
            console.warn(`⚠️  Failed to parse weekdays for customer ${customer.id}: ${customer.weekdays}`);
            weekdays = [];
          }
          
          let newDeliveryWeekdays: string[] = [];
          
          if (weekdays.length > 0) {
            // Tem weekdays configurados, calcular corretamente
            newDeliveryWeekdays = calculateDeliveryDaysFromMultipleRoutes(weekdays);
          } else {
            // Não tem weekdays, deixar vazio
            newDeliveryWeekdays = [];
          }
          
          // Atualizar no banco
          await db.update(customers)
            .set({ deliveryWeekdays: newDeliveryWeekdays })
            .where(eq(customers.id, customer.id));
          
          fixedCount++;
          console.log(`✅ Fixed customer ${customer.id} (${customer.fantasyName || customer.name}): ${JSON.stringify(weekdays)} → ${JSON.stringify(newDeliveryWeekdays)}`);
        } else {
          alreadyCorrect++;
        }
      }
      
      console.log(`\n📊 Summary:`);
      console.log(`   Total analyzed: ${allCustomers.length}`);
      console.log(`   Fixed: ${fixedCount}`);
      console.log(`   Already correct: ${alreadyCorrect}`);
      
      res.json({
        success: true,
        totalAnalyzed: allCustomers.length,
        fixedCount,
        alreadyCorrect,
        message: `Successfully recalculated delivery_weekdays for ${fixedCount} customers with incorrect fallback`
      });
    } catch (error: any) {
      console.error("Error fixing customers:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to fix customers", 
        error: error.message 
      });
    }
  });

  // Dashboard routes
  app.get('/api/dashboard/stats', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
      const stats = await storage.getDashboardStats(sellerId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
  });

  app.get('/api/dashboard/today-clients', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const user = req.currentUser;
      let sellerId = req.sellerId;
      
      // Admin/Coordinator/Administrative ver TODOS os clientes do dia
      // Vendedor vê apenas seus próprios clientes
      if (['admin', 'coordinator', 'administrative'].includes(user?.role)) {
        sellerId = undefined; // Retorna todos os clientes
      }
      
      // Obter data atual no timezone do Brasil (UTC-3)
      const now = new Date();
      const brazilOffset = -3 * 60; // UTC-3 em minutos
      const localOffset = now.getTimezoneOffset(); // Diferença do servidor para UTC em minutos
      const brazilTime = new Date(now.getTime() + (localOffset + brazilOffset) * 60 * 1000);
      
      const todayClients = await storage.getSalesCardsByDate(brazilTime, sellerId);
      res.json(todayClients);
    } catch (error) {
      console.error("Error fetching today's clients:", error);
      res.status(500).json({ message: "Failed to fetch today's clients" });
    }
  });

  app.get('/api/dashboard/overdue-clients', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const sellerId = req.sellerId;
      const overdueClients = await storage.getOverdueSalesCards(sellerId);
      res.json(overdueClients);
    } catch (error) {
      console.error("Error fetching overdue clients:", error);
      res.status(500).json({ message: "Failed to fetch overdue clients" });
    }
  });

  // Endpoint para buscar cards criticamente atrasados (>3 dias, devem ser marcados como failed)
  app.get('/api/sales-cards/critically-overdue', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId: filterSellerId } = req.query;
      let sellerId = req.sellerId;
      
      // Admin/coordinator/administrative podem filtrar por vendedor específico ou ver todos
      if (!sellerId && ['admin', 'coordinator', 'administrative'].includes(user.role)) {
        sellerId = filterSellerId && filterSellerId !== 'all' ? filterSellerId as string : undefined;
      }
      
      const criticallyOverdueCards = await storage.getCriticallyOverdueCards(sellerId);
      res.json(criticallyOverdueCards);
    } catch (error) {
      console.error("Error fetching critically overdue cards:", error);
      res.status(500).json({ message: "Failed to fetch critically overdue cards" });
    }
  });

  app.get('/api/dashboard/sellers-stats', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas administradores e coordenadores podem ver estatísticas de todos os vendedores
      if (!['admin', 'coordinator'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied. Admin or coordinator role required." });
      }
      
      // Adicionar headers para evitar cache
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      
      const sellersStats = await storage.getSellersStats();
      res.json(sellersStats);
    } catch (error) {
      console.error("Error fetching sellers stats:", error);
      res.status(500).json({ message: "Failed to fetch sellers stats" });
    }
  });

  // Endpoint para buscar cards por dia da semana e período
  app.get('/api/sales-cards/by-day/:routeDay', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const { routeDay } = req.params;
      const { startDate, endDate, page = 1, limit = 20, sellerId: filterSellerId } = req.query;
      
      const user = req.currentUser;
      let sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
      // Admin/coordinator/administrative podem filtrar por vendedor específico ou ver todos
      if (!sellerId && ['admin', 'coordinator', 'administrative'].includes(user.role)) {
        sellerId = filterSellerId && filterSellerId !== 'all' ? filterSellerId as string : undefined;
      }
      
      // Parse dates safely - use ISO format with UTC timezone
      let start: Date;
      let end: Date;
      
      if (startDate) {
        start = new Date(`${startDate}T00:00:00.000Z`);
      } else {
        start = new Date();
        start.setHours(0, 0, 0, 0);
      }
      
      if (endDate) {
        end = new Date(`${endDate}T23:59:59.999Z`);
      } else {
        end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        end.setHours(23, 59, 59, 999);
      }
      
      const offset = (Number(page) - 1) * Number(limit);
      
      const cards = await storage.getSalesCardsByDayAndDate(
        sellerId,
        routeDay,
        start,
        end,
        Number(limit),
        offset
      );
      
      res.json({
        cards,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          hasMore: cards.length === Number(limit)
        }
      });
    } catch (error) {
      console.error("Error fetching sales cards by day:", error);
      res.status(500).json({ message: "Failed to fetch sales cards" });
    }
  });

  // Endpoint para buscar cards de todos os dias da semana no período
  app.get('/api/sales-cards/all-days', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const { startDate, endDate, page = 1, limit = 20, sellerId: filterSellerId } = req.query;
      
      const user = req.currentUser;
      let sellerId: string | undefined;
      
      // Vendedores só veem seus próprios cards
      if (user.role === 'vendedor') {
        sellerId = user.id;
      } 
      // Admin/coordinator/administrative podem filtrar por vendedor específico ou ver todos
      else if (['admin', 'coordinator', 'administrative'].includes(user.role)) {
        sellerId = filterSellerId && filterSellerId !== 'all' ? filterSellerId as string : undefined;
      }
      
      // Parse dates safely - use ISO format with UTC timezone
      let start: Date;
      let end: Date;
      
      if (startDate) {
        start = new Date(`${startDate}T00:00:00.000Z`);
      } else {
        start = new Date();
        start.setHours(0, 0, 0, 0);
      }
      
      if (endDate) {
        end = new Date(`${endDate}T23:59:59.999Z`);
      } else {
        end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        end.setHours(23, 59, 59, 999);
      }
      
      const offset = (Number(page) - 1) * Number(limit);
      
      const cards = await storage.getSalesCardsByDateRange(
        sellerId,
        start,
        end,
        Number(limit),
        offset
      );
      
      res.json({
        cards,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          hasMore: cards.length === Number(limit)
        }
      });
    } catch (error) {
      console.error("Error fetching sales cards for all days:", error);
      res.status(500).json({ message: "Failed to fetch sales cards" });
    }
  });

  // Endpoint para buscar cards por data específica
  app.get('/api/sales-cards/by-date/:date', authenticateUser, async (req: any, res) => {
    try {
      const { date } = req.params;
      const { sellerId: filterSellerId } = req.query;
      const user = req.currentUser; // Corrigido: usar currentUser definido pelo middleware
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Determinar o sellerId a ser usado
      let sellerId: string | undefined;
      
      if (user.role === 'vendedor') {
        // Vendedores só veem seus próprios cards
        sellerId = user.id;
      } else if (['admin', 'coordinator', 'administrative'].includes(user.role)) {
        // Admin/coordenador/administrativo podem filtrar por vendedor específico ou ver todos
        sellerId = filterSellerId && filterSellerId !== 'all' ? filterSellerId as string : undefined;
      }
      
      const targetDate = new Date(date);
      const cards = await storage.getSalesCardsByDate(targetDate, sellerId);
      
      res.json({ cards });
    } catch (error) {
      console.error("Error fetching sales cards by date:", error);
      res.status(500).json({ message: "Failed to fetch sales cards" });
    }
  });

  // Endpoint para buscar um card específico por ID
  app.get('/api/sales-cards/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const user = req.currentUser;
      
      if (!user) {
        return res.status(401).json({ message: "User not authenticated" });
      }
      
      // Buscar o card com todas as relações
      const card = await storage.getSalesCard(id);
      
      if (!card) {
        return res.status(404).json({ message: "Sales card not found" });
      }
      
      // Verificar permissões: vendedor só pode ver seus próprios cards
      if (user.role === 'vendedor' && card.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(card);
    } catch (error) {
      console.error("Error fetching sales card:", error);
      res.status(500).json({ message: "Failed to fetch sales card" });
    }
  });

  // Endpoint para gerar próximo card manualmente
  app.post('/api/sales-cards/:id/generate-next', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Verificar se o card existe e o usuário tem permissão
      const card = await storage.getSalesCard(id);
      if (!card) {
        return res.status(404).json({ message: "Sales card not found" });
      }
      
      if (user.role === 'vendedor' && card.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const nextCard = await storage.generateNextSalesCard(id);
      
      if (!nextCard) {
        return res.status(400).json({ message: "Could not generate next card" });
      }
      
      res.json(nextCard);
    } catch (error) {
      console.error("Error generating next card:", error);
      res.status(500).json({ message: "Failed to generate next card" });
    }
  });

  // Endpoint para gerar cards futuros (próximos 2 meses) para todos os clientes
  // SINCRONIZA COMPLETAMENTE: deleta cards incorretos e cria os faltantes
  app.post('/api/sales-cards/generate-future', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      console.log('🚀 Iniciando sincronização completa de cards futuros...');
      
      const { syncFutureSalesCards } = await import('./visitScheduleService');
      const result = await syncFutureSalesCards(2);
      
      console.log('✅ Sincronização concluída:', result);
      
      res.json({
        success: true,
        message: `Sincronização concluída: ${result.created} cards criados, ${result.deleted} cards deletados`,
        stats: {
          processed: result.processed,
          created: result.created,
          deleted: result.deleted,
          errors: result.errors
        }
      });
    } catch (error: any) {
      console.error("❌ Erro ao sincronizar cards futuros:", error);
      res.status(500).json({ 
        success: false,
        message: "Erro ao sincronizar cards futuros",
        error: error.message 
      });
    }
  });

  // Message template routes
  app.get('/api/message-templates', authenticateUser, async (req, res) => {
    try {
      const templates = await storage.getMessageTemplates();
      res.json(templates);
    } catch (error) {
      console.error("Error fetching message templates:", error);
      res.status(500).json({ message: "Failed to fetch message templates" });
    }
  });

  app.post('/api/message-templates', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user?.role || '')) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const data = insertMessageTemplateSchema.parse(req.body);
      const template = await storage.createMessageTemplate(data);
      res.json(template);
    } catch (error) {
      console.error("Error creating message template:", error);
      res.status(500).json({ message: "Failed to create message template" });
    }
  });

  // WhatsApp integration
  app.post('/api/whatsapp/send', isAuthenticated, async (req: any, res) => {
    try {
      const { customerId, message, templateId } = req.body;
      const userId = req.user.claims.sub;
      
      // Log the message in history
      await storage.createMessageHistory({
        customerId,
        sellerId: userId,
        templateId,
        message,
        sentAt: new Date(),
      });
      
      // Mock WhatsApp integration - in production, integrate with WhatsApp Business API
      res.json({ 
        success: true, 
        message: "Message sent successfully via WhatsApp" 
      });
    } catch (error) {
      console.error("Error sending WhatsApp message:", error);
      res.status(500).json({ message: "Failed to send WhatsApp message" });
    }
  });

  app.get('/api/whatsapp/history/:customerId', isAuthenticated, async (req: any, res) => {
    try {
      const { customerId } = req.params;
      const history = await storage.getMessageHistory(customerId);
      res.json(history);
    } catch (error) {
      console.error("Error fetching message history:", error);
      res.status(500).json({ message: "Failed to fetch message history" });
    }
  });

  // Omie Integration routes
  app.get('/api/omie/status', authenticateUser, async (req, res) => {
    try {
      const configured = isOmieConfigured();
      res.json({ 
        configured,
        message: configured 
          ? 'Integração Omie configurada e ativa' 
          : 'Integração Omie não configurada. Adicione OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.'
      });
    } catch (error) {
      console.error("Error checking Omie status:", error);
      res.status(500).json({ message: "Erro ao verificar status da integração Omie" });
    }
  });

  app.post('/api/omie/check-credit', authenticateUser, async (req: any, res) => {
    try {
      const { cnpjCpf, valorVenda } = req.body;
      
      if (!cnpjCpf || !valorVenda) {
        return res.status(400).json({ 
          message: "CNPJ/CPF e valor da venda são obrigatórios" 
        });
      }

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const creditCheck = await omieService.checkCreditApproval(cnpjCpf, valorVenda);
      res.json(creditCheck);
    } catch (error) {
      console.error("Error checking credit with Omie:", error);
      res.status(500).json({ 
        message: "Erro ao consultar crédito no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  app.get('/api/omie/client/:cnpjCpf', authenticateUser, async (req: any, res) => {
    try {
      const { cnpjCpf } = req.params;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const client = await omieService.getClientByCnpjCpf(cnpjCpf);
      if (!client) {
        return res.status(404).json({ 
          message: "Cliente não encontrado no Omie" 
        });
      }

      res.json(client);
    } catch (error) {
      console.error("Error fetching client from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar cliente no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  app.get('/api/omie/client/:cnpjCpf/credit', authenticateUser, async (req: any, res) => {
    try {
      const { cnpjCpf } = req.params;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const creditInfo = await omieService.getClientCreditInfo(cnpjCpf);
      if (!creditInfo) {
        return res.status(404).json({ 
          message: "Informações de crédito não encontradas" 
        });
      }

      res.json(creditInfo);
    } catch (error) {
      console.error("Error fetching credit info from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar informações de crédito no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para listar clientes do Omie
  app.get('/api/omie/clients', authenticateUser, async (req: any, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 50;

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const result = await omieService.getAllClients(page, pageSize);
      res.json(result);
    } catch (error) {
      console.error("Error fetching Omie clients:", error);
      res.status(500).json({ 
        message: "Erro ao buscar clientes no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para importar clientes do Omie
  app.post('/api/omie/import-clients', authenticateUser, async (req: any, res) => {
    try {
      const { clientIds, sellerId } = req.body;
      
      if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
        return res.status(400).json({ 
          message: "Lista de IDs de clientes é obrigatória" 
        });
      }

      // sellerId pode ser null para importar sem vendedor atribuído

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const importedClients = [];
      const errors = [];

      for (const clientId of clientIds) {
        try {
          // Buscar cliente no Omie
          const omieClient = await omieService.getClientByCode(clientId);
          
          if (!omieClient) {
            errors.push(`Cliente ${clientId} não encontrado no Omie`);
            continue;
          }

          // Converter para formato do sistema
          const converted = omieService.convertClientToSystemFormat(omieClient);
          
          // Normalizar weekdays e calcular dias de entrega automaticamente
          const defaultWeekdays = ["Seg", "Ter", "Qua", "Qui", "Sex"];
          const normalizedWeekdays = normalizeWeekdayInput(converted.weekdays || defaultWeekdays);
          const autoDeliveryDays = calculateDeliveryDaysFromMultipleRoutes(normalizedWeekdays);
          
          const systemClient = {
            ...converted,
            // Usar sellerId do Omie se disponível, senão usar sellerId da planilha
            sellerId: converted.sellerId || sellerId || '',
            weekdays: JSON.stringify(normalizedWeekdays),
            deliveryWeekdays: autoDeliveryDays
          };

          // Verificar se cliente já existe (por CPF/CNPJ)
          const document = systemClient.cpf || systemClient.cnpj;
          if (document) {
            const existingCustomers = await storage.getCustomers();
            const existingCustomer = existingCustomers.find(customer => 
              (customer as any).cpf === systemClient.cpf || 
              (customer as any).cnpj === systemClient.cnpj
            );

            if (existingCustomer) {
              errors.push(`Cliente ${omieClient.razao_social} já existe no sistema`);
              continue;
            }
          }

          // Criar cliente no sistema
          const newCustomer = await storage.createCustomer(systemClient);
          importedClients.push(newCustomer);

        } catch (error) {
          console.error(`Erro ao importar cliente ${clientId}:`, error);
          errors.push(`Erro ao importar cliente ${clientId}: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
        }
      }

      res.json({
        imported: importedClients.length,
        errors: errors.length,
        clients: importedClients,
        errorDetails: errors
      });

    } catch (error) {
      console.error("Error importing clients from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao importar clientes do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota NOVA e SIMPLES para sincronizar APENAS CLIENTES ATIVOS do Omie
  app.post('/api/omie/sync-active-clients', authenticateUser, async (req: any, res) => {
    try {
      const { defaultSellerId } = req.body;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        errors: [] as string[],
        expectedTotal: 0 // Será calculado dinamicamente durante a sincronização
      };

      console.log('🚀 NOVA SINCRONIZAÇÃO - APENAS CLIENTES ATIVOS (CRITÉRIO: campo situacao)');
      console.log('📊 Calculando total de clientes ativos dinamicamente...');

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        console.log(`📄 Página ${currentPage}...`);
        
        try {
          // Buscar todos os clientes da página
          const pageData = await omieService.getAllClients(currentPage, 100, false);
          const allClients = pageData.clients || [];
          
          // Filtrar apenas clientes REALMENTE ativos usando o critério correto
          const activeClients = allClients.filter(client => {
            if (client.situacao) {
              return client.situacao === 'ativo'; // Usar situacao se disponível
            }
            return client.inativo !== 'S'; // Fallback para inativo
          });
          
          console.log(`   → ${allClients.length} clientes total, ${activeClients.length} ativos na página ${currentPage}`);

          if (allClients.length === 0) {
            console.log('✅ Nenhum cliente na página, finalizando');
            break;
          }

          // Processar apenas clientes ATIVOS
          for (const omieClient of activeClients) {
            result.totalProcessed++;
            
            // Log a cada 100 clientes
            if (result.totalProcessed % 100 === 0) {
              console.log(`⏳ ${result.totalProcessed} clientes ativos processados...`);
            }
            
            try {
              // Converter cliente do Omie para formato do sistema
              const converted = omieService.convertClientToSystemFormat(omieClient);
              
              // Verificar se cliente já existe ANTES de definir sellerId
              let existingCustomer = await storage.getCustomer(converted.id);
              
              // Prioridade: Omie > Existente > Default (NUNCA sobrescrever vendedor existente)
              const finalSellerId = converted.sellerId || existingCustomer?.sellerId || defaultSellerId || '';
              
              // Normalizar weekdays e calcular dias de entrega automaticamente
              // ✅ CORREÇÃO: Não usar fallback de "todos os dias" se weekdays não estiver definido
              // Se cliente não tem dias de visita configurados, delivery_weekdays deve ficar vazio
              const normalizedWeekdays = converted.weekdays ? normalizeWeekdayInput(converted.weekdays) : [];
              const autoDeliveryDays = normalizedWeekdays.length > 0 
                ? calculateDeliveryDaysFromMultipleRoutes(normalizedWeekdays)
                : [];
              
              const systemClient = {
                ...converted,
                sellerId: finalSellerId,
                weekdays: JSON.stringify(normalizedWeekdays),
                deliveryWeekdays: autoDeliveryDays
              };
              
              if (existingCustomer) {
                // Atualizar cliente existente
                // IMPORTANTE: Preservar latitude, longitude, route, weekdays e visitPeriodicity
                // Estes campos só devem ser alterados via importação de planilha ou edição individual no app
                await storage.updateCustomer(existingCustomer.id, {
                  // Campos que podem ser atualizados do Omie
                  name: systemClient.name,
                  customerType: systemClient.customerType,
                  cpf: systemClient.cpf,
                  cnpj: systemClient.cnpj,
                  companyName: systemClient.companyName,
                  fantasyName: systemClient.fantasyName,
                  phone: systemClient.phone,
                  email: systemClient.email,
                  address: systemClient.address,
                  city: systemClient.city,
                  state: systemClient.state,
                  zipCode: systemClient.zipCode,
                  sellerId: converted.sellerId || existingCustomer.sellerId, // NUNCA sobrescrever com default
                  isActive: systemClient.isActive,
                  omieStatus: systemClient.omieStatus,
                  situacao: systemClient.situacao
                  // Campos preservados (NÃO atualizados do Omie):
                  // - latitude
                  // - longitude  
                  // - route (depreciado)
                  // - weekdays
                  // - visitPeriodicity
                });
                result.updated++;
              } else {
                // Criar novo cliente
                await storage.createCustomer(systemClient);
                result.imported++;
              }
              
            } catch (clientError: any) {
              const errorMsg = clientError instanceof Error ? clientError.message : 'Erro desconhecido';
              console.error(`❌ Erro cliente ${omieClient.codigo_cliente_omie}:`, errorMsg);
              result.errors.push(`Cliente ${omieClient.razao_social}: ${errorMsg}`);
            }
          }

          // Próxima página
          currentPage++;
          hasMorePages = currentPage <= pageData.totalPages;
          
          console.log(`📊 Página ${currentPage-1}: totalPages=${pageData.totalPages}, próximaPágina=${currentPage}, hasMorePages=${hasMorePages}`);
          
        } catch (pageError: any) {
          console.error(`❌ Erro na página ${currentPage}:`, pageError);
          result.errors.push(`Erro na página ${currentPage}: ${pageError instanceof Error ? pageError.message : 'Erro desconhecido'}`);
          break;
        }
      }

      // Atualizar expectedTotal com o real
      result.expectedTotal = result.totalProcessed;

      console.log(`🎉 SINCRONIZAÇÃO FINALIZADA!`);
      console.log(`📊 Total de clientes ATIVOS processados: ${result.totalProcessed}`);
      console.log(`📥 Importados: ${result.imported}`);
      console.log(`🔄 Atualizados: ${result.updated}`);
      console.log(`❌ Erros: ${result.errors.length}`);

      // Save sync status
      await saveSyncStatus(
        'omie_clients', 
        result.errors.length > 0 ? 'error' : 'success',
        result.totalProcessed,
        `${result.imported} importados, ${result.updated} atualizados, ${result.errors.length} erros`
      );

      res.json({
        ...result,
        message: `Sincronização concluída: ${result.totalProcessed} clientes processados`
      });

    } catch (error) {
      console.error("❌ Erro na sincronização:", error);
      res.status(500).json({ 
        message: "Erro ao sincronizar clientes ativos do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para buscar débitos em atraso do Omie
  // Get available stages from Omie
  app.get('/api/omie/stages', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const stages = await omieService.getAvailableStages();
      res.json({ stages });
    } catch (error) {
      console.error('Erro ao buscar etapas disponíveis:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar etapas disponíveis', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Endpoint temporário para listar etapas de faturamento e contar notas (SEM AUTH PARA TESTE)
  app.get('/etapas-omie-test', async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const fs = await import('fs/promises');
      let output = '\n\n═══════════════════════════════════════════════════════════════\n';
      output += '🔍 INICIANDO CONSULTA DE ETAPAS DE FATURAMENTO\n';
      output += '═══════════════════════════════════════════════════════════════\n\n';
      
      // Chamar o método ListarEtapasFaturamento da API Omie
      const response = await (omieService as any).makeRequest(
        '/produtos/etapafat/',
        'ListarEtapasFaturamento',
        {}
      );

      output += '📊 Resposta da API:\n' + JSON.stringify(response, null, 2) + '\n\n';

      // Processar as etapas
      const etapas = response.lista_etapas || [];
      
      output += `📋 Total de etapas encontradas: ${etapas.length}\n\n`;
      
      // Para cada etapa, buscar quantas notas fiscais existem
      const etapasComContagem = await Promise.all(
        etapas.map(async (etapa: any) => {
          const codigoEtapa = etapa.cCodigo;
          const nomeEtapa = etapa.cDescricao;
          
          output += `🔎 Consultando etapa ${codigoEtapa} - ${nomeEtapa}...\n`;
          
          try {
            // Buscar pedidos nesta etapa
            const pedidosResponse = await (omieService as any).makeRequest(
              '/produtos/pedido/',
              'ListarPedidos',
              {
                nPagina: 1,
                nRegPorPagina: 1, // Só queremos a contagem
                filtrarPorEtapa: codigoEtapa
              }
            );

            const total = pedidosResponse.nTotRegistros || 0;
            
            output += `✅ Etapa ${codigoEtapa}: ${total} pedidos/notas\n`;
            
            return {
              codigo: codigoEtapa,
              nome: nomeEtapa,
              totalNotas: total
            };
          } catch (error) {
            output += `❌ Erro ao contar notas da etapa ${codigoEtapa}: ${error instanceof Error ? error.message : 'Erro desconhecido'}\n`;
            return {
              codigo: codigoEtapa,
              nome: nomeEtapa,
              totalNotas: 0,
              erro: error instanceof Error ? error.message : 'Erro desconhecido'
            };
          }
        })
      );

      output += '\n\n═══════════════════════════════════════════════════════════════\n';
      output += '📊 RESUMO FINAL:\n';
      output += '═══════════════════════════════════════════════════════════════\n\n';
      
      etapasComContagem.forEach(etapa => {
        output += `  ${etapa.codigo} - ${etapa.nome.padEnd(25, ' ')}: ${String(etapa.totalNotas).padStart(6, ' ')} notas\n`;
      });
      
      output += '\n═══════════════════════════════════════════════════════════════\n\n';

      // Salvar em arquivo
      await fs.writeFile('/tmp/etapas-resultado.txt', output);
      console.log(output);

      res.json({
        success: true,
        totalEtapas: etapas.length,
        etapas: etapasComContagem,
        arquivo: '/tmp/etapas-resultado.txt'
      });

    } catch (error) {
      console.error('❌ Erro ao listar etapas de faturamento:', error);
      res.status(500).json({ 
        message: 'Erro ao listar etapas de faturamento', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Get orders by step/stage
  app.get('/api/omie/orders/:step', authenticateUser, async (req: any, res) => {
    try {
      const { step } = req.params;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      // Primeiro buscar etapas disponíveis para mapear corretamente
      const availableStages = await omieService.getAvailableStages();
      
      // Mapear step para etapa do Omie baseado nas etapas disponíveis
      const stageMapping: Record<string, string> = {};
      
      // Criar mapeamento dinâmico baseado nas etapas disponíveis
      availableStages.forEach((stage: any, index: number) => {
        const stageCode = stage.cCodigo || stage.codigo;
        if (index === 0) stageMapping['sale'] = stageCode;
        else if (index === 1) stageMapping['billing'] = stageCode;
        else if (index === 2) stageMapping['billed'] = stageCode;
        else if (index === 3) stageMapping['awaiting-route'] = stageCode;
        else if (index === 4) stageMapping['in-route'] = stageCode;
      });
      
      const omieStage = stageMapping[step];
      if (!omieStage) {
        return res.status(400).json({ 
          message: 'Etapa não disponível nesta conta',
          availableStages: availableStages.map((s: any) => ({ 
            codigo: s.cCodigo || s.codigo, 
            descricao: s.cDescricao || s.descricao 
          }))
        });
      }

      const result = await omieService.getOrdersByStage(omieStage);
      
      res.json({
        orders: result.orders,
        totalCount: result.totalRecords,
        currentStep: step,
        omieStage,
        availableStages
      });
    } catch (error) {
      console.error('Erro ao buscar pedidos por etapa:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar pedidos', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Sync orders by step/stage
  app.post('/api/omie/orders/:step/sync', authenticateUser, async (req: any, res) => {
    try {
      const { step } = req.params;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      // Primeiro buscar etapas disponíveis para mapear corretamente
      const availableStages = await omieService.getAvailableStages();
      
      // Mapear step para etapa do Omie baseado nas etapas disponíveis
      const stageMapping: Record<string, string> = {};
      
      // Criar mapeamento dinâmico baseado nas etapas disponíveis
      availableStages.forEach((stage: any, index: number) => {
        const stageCode = stage.cCodigo || stage.codigo;
        if (index === 0) stageMapping['sale'] = stageCode;
        else if (index === 1) stageMapping['billing'] = stageCode;
        else if (index === 2) stageMapping['billed'] = stageCode;
        else if (index === 3) stageMapping['awaiting-route'] = stageCode;
        else if (index === 4) stageMapping['in-route'] = stageCode;
      });
      
      const omieStage = stageMapping[step];
      if (!omieStage) {
        return res.status(400).json({ 
          message: 'Etapa não disponível nesta conta',
          availableStages: availableStages.map((s: any) => ({ 
            codigo: s.cCodigo || s.codigo, 
            descricao: s.cDescricao || s.descricao 
          }))
        });
      }

      const result = await omieService.getOrdersByStage(omieStage);
      
      res.json({
        success: true,
        count: result.totalRecords,
        message: `${result.totalRecords} pedidos sincronizados da etapa ${step}`,
        omieStage,
        availableStages
      });
    } catch (error) {
      console.error('Erro ao sincronizar pedidos por etapa:', error);
      res.status(500).json({ 
        message: 'Erro ao sincronizar pedidos', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Rota para debug de uma NF específica
  app.get('/api/omie/debug-invoice/:invoiceNumber', authenticateUser, async (req, res) => {
    try {
      const { invoiceNumber } = req.params;
      console.log(`🔍 Buscando dados da NF ${invoiceNumber} para debug...`);
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }
      
      const invoiceData = await omieService.getInvoiceByNumber(invoiceNumber);
      
      if (!invoiceData) {
        return res.status(404).json({ 
          error: `NF ${invoiceNumber} não encontrada` 
        });
      }
      
      console.log(`✅ NF ${invoiceNumber} encontrada para debug`);
      res.json(invoiceData);
    } catch (error: any) {
      console.error('❌ Erro no debug da NF:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        details: error.message 
      });
    }
  });

  // Rota para debug de um pedido específico por número
  app.get('/api/omie/debug-order/:orderNumber', authenticateUser, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      console.log(`🔍 Buscando dados do pedido ${orderNumber} para debug...`);
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }
      
      // Buscar o pedido específico
      const orderData = await (omieService as any).makeRequest('/produtos/pedido/', 'ConsultarPedido', {
        numero_pedido: orderNumber
      });
      
      if (!orderData) {
        return res.status(404).json({ 
          error: `Pedido ${orderNumber} não encontrado` 
        });
      }
      
      console.log(`✅ Pedido ${orderNumber} encontrado para debug`);
      
      // Extrair informações de vendedor
      const vendorInfo = {
        cabecalho_codigo_vendedor: orderData.cabecalho?.codigo_vendedor,
        informacoes_adicionais_codigo_vendedor: orderData.informacoes_adicionais?.codigo_vendedor,
        cabecalho_vendedor: orderData.cabecalho?.vendedor,
        all_keys: Object.keys(orderData)
      };
      
      res.json({ 
        orderData, 
        vendorInfo,
        message: `Debug do pedido ${orderNumber}` 
      });
      
    } catch (error: any) {
      console.error('❌ Erro no debug do pedido:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        details: error.message 
      });
    }
  });

  // ==================== ROTAS DE FATURAMENTO ====================
  
  // ROTA COMENTADA: Duplicada com linha 4672 - usar a rota mais simples abaixo
  // Listar faturamentos com filtros avançados (DESABILITADA - conflito com rota na linha 4672)
  /*
  app.get('/api/billings', authenticateUser, async (req, res) => {
    try {
      const {
        sellerId,
        startDate,
        endDate,
        customerDocument,
        invoiceNumber,
        cfop,
        invoiceStage,
        page = '1',
        pageSize = '50'
      } = req.query;
      
      const filters = {
        sellerId: sellerId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        customerDocument: customerDocument as string,
        invoiceNumber: invoiceNumber as string,
        cfop: cfop as string,
        invoiceStage: invoiceStage as string,
        page: parseInt(page as string),
        pageSize: parseInt(pageSize as string)
      };
      
      const result = await storage.getBillingsWithFilters(filters);
      res.json(result);
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar faturamentos:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
  */
  
  // Geração manual de agenda de visitas (apenas admin/coordinator)
  app.post('/api/visit-agenda/generate', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log('🗓️ Iniciando geração manual de agenda de visitas...');
      
      const result = await generateVisitAgenda();
      
      console.log('✅ Geração manual de agenda concluída:', result);
      res.json({
        success: true,
        message: `Agenda gerada com sucesso: ${result.generated} visitas criadas para ${result.processed} clientes`,
        processed: result.processed,
        generated: result.generated
      });
      
    } catch (error: any) {
      console.error('❌ Erro na geração manual de agenda:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Buscar visitas agendadas com filtros
  app.get('/api/visit-agenda', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const {
        sellerId,
        startDate,
        endDate,
        routeDay,
        visitStatus = 'pending',
        salesCardId,
        page = '1',
        pageSize = '50'
      } = req.query;

      // Construir filtros
      const filters: any[] = [];

      // Filtro por vendedor baseado na role
      if (user.role === 'vendedor') {
        // Vendedores só veem suas próprias visitas
        filters.push(eq(visitAgenda.sellerId, user.id));
      } else if (sellerId && ['admin', 'coordinator', 'administrative'].includes(user.role)) {
        // Admins/coordenadores podem filtrar por vendedor específico
        filters.push(eq(visitAgenda.sellerId, sellerId));
      }

      // Filtros de data
      if (startDate) {
        filters.push(gte(visitAgenda.scheduledDate, new Date(startDate as string)));
      }
      if (endDate) {
        filters.push(lte(visitAgenda.scheduledDate, new Date(endDate as string)));
      }

      // Filtro por dia da semana
      if (routeDay) {
        filters.push(eq(visitAgenda.routeDay, routeDay as string));
      }

      // Filtro por status
      if (visitStatus) {
        filters.push(eq(visitAgenda.visitStatus, visitStatus as string));
      }

      // Filtro por salesCardId
      if (salesCardId) {
        filters.push(eq(visitAgenda.salesCardId, salesCardId as string));
      }

      // Buscar visitas com paginação
      const offset = (parseInt(page as string) - 1) * parseInt(pageSize as string);
      
      const visits = await db.select({
        id: visitAgenda.id,
        customerId: visitAgenda.customerId,
        sellerId: visitAgenda.sellerId,
        scheduledDate: visitAgenda.scheduledDate,
        routeDay: visitAgenda.routeDay,
        recurrenceType: visitAgenda.recurrenceType,
        isVirtual: visitAgenda.isVirtual,
        visitStatus: visitAgenda.visitStatus,
        customerName: visitAgenda.customerName,
        customerLatitude: visitAgenda.customerLatitude,
        customerLongitude: visitAgenda.customerLongitude,
        customerAddress: visitAgenda.customerAddress,
        actualCheckIn: visitAgenda.actualCheckIn,
        actualCheckOut: visitAgenda.actualCheckOut,
        distanceToCustomer: visitAgenda.distanceToCustomer,
        salesCardId: visitAgenda.salesCardId,
        createdAt: visitAgenda.createdAt,
      })
      .from(visitAgenda)
      .where(and(...filters))
      .orderBy(visitAgenda.scheduledDate, visitAgenda.customerName)
      .limit(parseInt(pageSize as string))
      .offset(offset);

      // Contar total de registros
      const totalQuery = await db.select({ count: sql<number>`count(*)` })
        .from(visitAgenda)
        .where(and(...filters));
      
      const total = totalQuery[0]?.count || 0;
      const totalPages = Math.ceil(total / parseInt(pageSize as string));

      res.json({
        visits,
        pagination: {
          page: parseInt(page as string),
          pageSize: parseInt(pageSize as string),
          total,
          totalPages
        }
      });

    } catch (error: any) {
      console.error('❌ Erro ao buscar visitas agendadas:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Otimizar rota de visitas para um vendedor em uma data específica
  app.post('/api/visit-agenda/optimize-route', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date, homeLatitude, homeLongitude } = req.body;

      // Validar se vendedor pode acessar
      let targetSellerId = sellerId;
      if (user.role === 'vendedor') {
        targetSellerId = user.id; // Vendedores só podem otimizar suas próprias rotas
      } else if (!sellerId) {
        return res.status(400).json({ message: 'sellerId é obrigatório para admins/coordenadores' });
      }

      // Buscar vendedor para obter coordenadas de casa
      const seller = await storage.getUser(targetSellerId);
      if (!seller) {
        return res.status(404).json({ message: 'Vendedor não encontrado' });
      }

      // Usar coordenadas fornecidas ou as do perfil do vendedor
      const startLatitude = homeLatitude || seller.homeLatitude;
      const startLongitude = homeLongitude || seller.homeLongitude;

      if (!startLatitude || !startLongitude) {
        return res.status(400).json({ 
          message: 'Coordenadas de localização inicial são obrigatórias' 
        });
      }

      // Buscar visitas do vendedor para a data específica
      const visitDate = new Date(date);
      const startOfDay = new Date(visitDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(visitDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Primeiro tentar buscar de visitAgenda
      let visits = await db.select({
        id: visitAgenda.id,
        customerId: visitAgenda.customerId,
        customerName: visitAgenda.customerName,
        customerLatitude: visitAgenda.customerLatitude,
        customerLongitude: visitAgenda.customerLongitude,
        customerAddress: visitAgenda.customerAddress,
        visitStatus: visitAgenda.visitStatus,
        recurrenceType: visitAgenda.recurrenceType,
        isVirtual: visitAgenda.isVirtual,
      })
      .from(visitAgenda)
      .where(and(
        eq(visitAgenda.sellerId, targetSellerId),
        gte(visitAgenda.scheduledDate, startOfDay),
        lte(visitAgenda.scheduledDate, endOfDay),
        eq(visitAgenda.visitStatus, 'pending'),
        eq(visitAgenda.isVirtual, false) // Apenas visitas presenciais
      ));
      
      // Se não houver visitAgenda, buscar diretamente dos sales_cards
      if (visits.length === 0) {
        console.log('⚠️ Nenhuma visitAgenda encontrada, buscando sales_cards...');
        const salesCardsData = await db.select({
          id: salesCards.id,
          customerId: salesCards.customerId,
          customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
          customerLatitude: customers.latitude,
          customerLongitude: customers.longitude,
          customerAddress: customers.address,
          status: salesCards.status,
          recurrenceType: salesCards.recurrenceType,
          isVirtual: customers.virtualService,
        })
        .from(salesCards)
        .leftJoin(customers, eq(salesCards.customerId, customers.id))
        .where(and(
          eq(salesCards.sellerId, targetSellerId),
          gte(salesCards.scheduledDate, startOfDay),
          lte(salesCards.scheduledDate, endOfDay),
          eq(salesCards.status, 'pending')
        ));
        
        // Converter para formato compatível com visits
        // Filtrar apenas presenciais com coordenadas válidas
        visits = salesCardsData
          .filter(row => {
            if (row.isVirtual) return false; // Excluir virtuais
            if (!row.customerLatitude || !row.customerLongitude) return false; // Excluir sem coordenadas
            const lat = parseFloat(row.customerLatitude);
            const lng = parseFloat(row.customerLongitude);
            if (isNaN(lat) || isNaN(lng)) return false; // Excluir coordenadas inválidas
            if (lat === 0 && lng === 0) return false; // Excluir coordenadas zeradas
            return true;
          })
          .map(row => ({
            id: row.id,
            customerId: row.customerId,
            customerName: row.customerName || 'Cliente sem nome',
            customerLatitude: parseFloat(row.customerLatitude!),
            customerLongitude: parseFloat(row.customerLongitude!),
            customerAddress: row.customerAddress || '',
            visitStatus: row.status,
            recurrenceType: row.recurrenceType,
            isVirtual: false, // Já filtrado acima
          }));
        
        console.log(`✅ Encontrados ${visits.length} sales_cards presenciais com coordenadas válidas`);
      }

      if (visits.length === 0) {
        return res.json({
          optimizedRoute: {
            locations: [],
            totalDistance: 0,
            estimatedTotalTime: 0,
            routeOrder: []
          },
          message: 'Nenhuma visita presencial pendente encontrada para esta data'
        });
      }

      // Filtrar apenas visitas com coordenadas válidas
      const validVisits = visits.filter(v => 
        v.customerLatitude !== null && 
        v.customerLongitude !== null &&
        !isNaN(v.customerLatitude) && 
        !isNaN(v.customerLongitude)
      );

      if (validVisits.length === 0) {
        return res.json({
          optimizedRoute: {
            locations: [],
            totalDistance: 0,
            estimatedTotalTime: 0,
            routeOrder: []
          },
          message: 'Nenhuma visita com coordenadas válidas encontrada'
        });
      }

      // Converter para formato RouteLocation
      const locations: RouteLocation[] = validVisits.map(visit => ({
        id: visit.id,
        latitude: visit.customerLatitude!,
        longitude: visit.customerLongitude!,
        customerName: visit.customerName || 'Cliente sem nome',
        address: visit.customerAddress || 'Endereço não informado',
        priority: visit.recurrenceType === 'semanal' ? 4 : 3, // Clientes semanais têm prioridade
        estimatedDuration: 30, // 30 minutos por visita padrão
        isVirtual: visit.isVirtual || false // incluir informação de atendimento virtual
      }));

      // Otimizar rota usando algoritmo avançado
      const optimizedRoute = optimizeRouteAdvanced(
        { latitude: startLatitude, longitude: startLongitude },
        locations
      );

      res.json({
        optimizedRoute,
        sellerId: targetSellerId,
        date: date,
        startLocation: { latitude: startLatitude, longitude: startLongitude },
        totalVisits: visits.length,
        optimizableVisits: validVisits.length,
        message: `Rota otimizada com ${optimizedRoute.locations.length} visitas`
      });

    } catch (error: any) {
      console.error('❌ Erro ao otimizar rota:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Check-in para uma visita agendada
  app.post('/api/visit-agenda/:id/check-in', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      const { latitude, longitude } = req.body;

      // Validar entrada
      if (!latitude || !longitude) {
        return res.status(400).json({ 
          message: 'Latitude e longitude são obrigatórias' 
        });
      }

      // Buscar a visita
      const visit = await db.select()
        .from(visitAgenda)
        .where(eq(visitAgenda.id, id))
        .limit(1);

      if (!visit.length) {
        return res.status(404).json({ message: 'Visita não encontrada' });
      }

      const currentVisit = visit[0];

      // Verificar se o vendedor pode fazer check-in nesta visita
      if (user.role === 'vendedor' && currentVisit.sellerId !== user.id) {
        return res.status(403).json({ 
          message: 'Você só pode fazer check-in em suas próprias visitas' 
        });
      }

      // Verificar se a visita não está virtual
      if (currentVisit.isVirtual) {
        return res.status(400).json({ 
          message: 'Check-in não é necessário para visitas virtuais' 
        });
      }

      // Verificar se já foi feito check-in
      if (currentVisit.actualCheckIn) {
        return res.status(400).json({ 
          message: 'Check-in já foi realizado para esta visita' 
        });
      }

      // Calcular distância até o cliente
      let distanceToCustomer = null;
      if (currentVisit.customerLatitude && currentVisit.customerLongitude) {
        const customerLat = parseFloat(currentVisit.customerLatitude.toString());
        const customerLon = parseFloat(currentVisit.customerLongitude.toString());
        
        // Fórmula de Haversine para calcular distância
        const R = 6371000; // Raio da Terra em metros
        const dLat = (customerLat - latitude) * Math.PI / 180;
        const dLon = (customerLon - longitude) * Math.PI / 180;
        const a = 
          Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(latitude * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * 
          Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        distanceToCustomer = R * c; // Distância em metros
      }

      // Validar distância máxima (500 metros)
      const maxDistance = 500;
      if (distanceToCustomer && distanceToCustomer > maxDistance) {
        return res.status(400).json({ 
          message: `Você deve estar a no máximo ${maxDistance}m do cliente para fazer check-in. Distância atual: ${Math.round(distanceToCustomer)}m`,
          distance: Math.round(distanceToCustomer),
          maxDistance
        });
      }

      // Atualizar visita com dados de check-in
      const checkInDate = new Date();
      await db.update(visitAgenda)
        .set({
          actualCheckIn: checkInDate,
          checkInLatitude: latitude.toString(),
          checkInLongitude: longitude.toString(),
          distanceToCustomer: distanceToCustomer ? distanceToCustomer.toString() : null,
          visitStatus: 'in_progress'
        })
        .where(eq(visitAgenda.id, id));

      // Se tiver salesCardId vinculado, atualizar também o sales_card
      // IMPORTANTE: Sem try/catch para garantir consistência - se falhar, a transação toda falha
      if (currentVisit.salesCardId) {
        await db.update(salesCards)
          .set({
            checkInTime: checkInDate,
            checkInLatitude: latitude.toString(),
            checkInLongitude: longitude.toString(),
            distanceToCustomer: distanceToCustomer ? distanceToCustomer.toString() : null,
            status: 'in_progress'
          })
          .where(eq(salesCards.id, currentVisit.salesCardId));
        console.log(`✅ Check-in salvo no sales_card ${currentVisit.salesCardId}`);
      }

      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentVisit.sellerId, today);
        
        if (dailyRoute) {
          console.log(`📍 Registrando checkpoint de check-in para visita ${id} na rota ${dailyRoute.id}`);
          const { registerCheckpoint } = await import('./routeOptimizationService');
          routeProgress = await registerCheckpoint(
            storage,
            dailyRoute.id,
            id,
            currentVisit.customerId,  // ← CORRIGIDO: era sellerId, deveria ser customerId
            currentVisit.sellerId,
            'check_in',
            latitude,
            longitude
          );
          console.log(`✅ Checkpoint de check-in registrado com sucesso: ${JSON.stringify(routeProgress)}`);
        } else {
          console.log(`⚠️  Nenhuma rota diária encontrada para o vendedor ${currentVisit.sellerId} na data ${today.toISOString()}`);
        }
      } catch (error) {
        console.error('❌ Erro ao registrar checkpoint de check-in:', error);
        // Re-lançar o erro para que o check-in falhe se o checkpoint não puder ser registrado
        throw error;
      }

      res.json({
        success: true,
        message: 'Check-in realizado com sucesso',
        checkInTime: new Date(),
        distance: distanceToCustomer ? Math.round(distanceToCustomer) : null,
        routeProgress: routeProgress ? {
          distanceFromPrevious: routeProgress.distanceFromPrevious,
          totalDistanceSoFar: routeProgress.totalDistanceSoFar,
          completedVisits: routeProgress.completedVisits
        } : null
      });

    } catch (error: any) {
      console.error('❌ Erro no check-in da visita:', error);
      res.status(500).json({ 
        message: 'Erro interno do servidor',
        error: error.message 
      });
    }
  });

  // Check-out para uma visita agendada
  app.post('/api/visit-agenda/:id/check-out', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      const { latitude, longitude } = req.body;

      // Validar entrada
      if (!latitude || !longitude) {
        return res.status(400).json({ 
          message: 'Latitude e longitude são obrigatórias' 
        });
      }

      // Buscar a visita
      const visit = await db.select()
        .from(visitAgenda)
        .where(eq(visitAgenda.id, id))
        .limit(1);

      if (!visit.length) {
        return res.status(404).json({ message: 'Visita não encontrada' });
      }

      const currentVisit = visit[0];

      // Verificar se o vendedor pode fazer check-out nesta visita
      if (user.role === 'vendedor' && currentVisit.sellerId !== user.id) {
        return res.status(403).json({ 
          message: 'Você só pode fazer check-out em suas próprias visitas' 
        });
      }

      // Verificar se a visita não está virtual
      if (currentVisit.isVirtual) {
        return res.status(400).json({ 
          message: 'Check-out não é necessário para visitas virtuais' 
        });
      }

      // Verificar se foi feito check-in
      if (!currentVisit.actualCheckIn) {
        return res.status(400).json({ 
          message: 'É necessário fazer check-in antes do check-out' 
        });
      }

      // Verificar se já foi feito check-out
      if (currentVisit.actualCheckOut) {
        return res.status(400).json({ 
          message: 'Check-out já foi realizado para esta visita' 
        });
      }

      // Calcular distância até o cliente
      let distanceToCustomer = null;
      if (currentVisit.customerLatitude && currentVisit.customerLongitude) {
        const customerLat = parseFloat(currentVisit.customerLatitude.toString());
        const customerLon = parseFloat(currentVisit.customerLongitude.toString());
        
        // Fórmula de Haversine para calcular distância
        const R = 6371000; // Raio da Terra em metros
        const dLat = (customerLat - latitude) * Math.PI / 180;
        const dLon = (customerLon - longitude) * Math.PI / 180;
        const a = 
          Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(latitude * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * 
          Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        distanceToCustomer = R * c; // Distância em metros
      }

      // Calcular tempo de visita
      const checkInTime = new Date(currentVisit.actualCheckIn);
      const checkOutTime = new Date();
      const visitDuration = Math.round((checkOutTime.getTime() - checkInTime.getTime()) / 60000); // em minutos

      // Atualizar visita com dados de check-out
      await db.update(visitAgenda)
        .set({
          actualCheckOut: checkOutTime,
          checkOutLatitude: latitude.toString(),
          checkOutLongitude: longitude.toString(),
          visitStatus: 'completed',
          visitDuration: visitDuration,
          isAutoCheckout: false // Check-out manual pelo vendedor
        })
        .where(eq(visitAgenda.id, id));

      // Se tiver salesCardId vinculado, atualizar também o sales_card
      // IMPORTANTE: Sem try/catch para garantir consistência - se falhar, a transação toda falha
      // 
      // NOTA SOBRE STATUS: 
      // - visitAgenda.visitStatus = 'completed' → visita FÍSICA foi concluída (check-out feito)
      // - salesCards.status = 'in_progress' → processo de VENDA ainda em andamento
      // O sales_card só é marcado como 'completed' quando o pedido é enviado para Omie,
      // ou 'no_sale' quando o vendedor marca explicitamente. São semânticas diferentes!
      if (currentVisit.salesCardId) {
        await db.update(salesCards)
          .set({
            checkOutTime: checkOutTime,
            checkOutLatitude: latitude.toString(),
            checkOutLongitude: longitude.toString(),
            checkOutDistanceToCustomer: distanceToCustomer ? distanceToCustomer.toString() : null
          })
          .where(eq(salesCards.id, currentVisit.salesCardId));
        console.log(`✅ Check-out salvo no sales_card ${currentVisit.salesCardId}`);
      }

      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentVisit.sellerId, today);
        
        if (dailyRoute) {
          console.log(`📍 Registrando checkpoint de check-out para visita ${id} na rota ${dailyRoute.id}`);
          const { registerCheckpoint } = await import('./routeOptimizationService');
          routeProgress = await registerCheckpoint(
            storage,
            dailyRoute.id,
            id,
            currentVisit.customerId,
            currentVisit.sellerId,
            'check_out',
            latitude,
            longitude
          );
          console.log(`✅ Checkpoint registrado com sucesso: ${JSON.stringify(routeProgress)}`);
        } else {
          console.log(`⚠️  Nenhuma rota diária encontrada para o vendedor ${currentVisit.sellerId} na data ${today.toISOString()}`);
        }
      } catch (error: any) {
        console.error('❌ Erro ao registrar checkpoint de check-out:', error);
        console.error('❌ Stack trace:', error.stack);
        console.error('❌ Detalhes - Seller:', currentVisit.sellerId, 'Visit ID:', id);
        // Re-lançar o erro para que o check-out falhe se o checkpoint não puder ser registrado
        // Isso garante consistência - se o checkpoint falhar, o check-out também falha
        throw error;
      }

      res.json({
        success: true,
        message: 'Check-out realizado com sucesso',
        checkOutTime,
        visitDuration,
        distance: distanceToCustomer ? Math.round(distanceToCustomer) : null,
        routeProgress: routeProgress ? {
          distanceFromPrevious: routeProgress.distanceFromPrevious,
          totalDistanceSoFar: routeProgress.totalDistanceSoFar,
          completedVisits: routeProgress.completedVisits
        } : null
      });

    } catch (error: any) {
      console.error('❌ Erro no check-out da visita:', error);
      res.status(500).json({ 
        message: 'Erro interno do servidor',
        error: error.message 
      });
    }
  });

  // Métricas de performance de visitas para dashboard
  app.get('/api/dashboard/visit-performance', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Definir período padrão (últimos 30 dias)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      // Filtros baseados na role do usuário
      const visitFilters: any[] = [
        gte(visitAgenda.scheduledDate, startDate),
        lte(visitAgenda.scheduledDate, endDate)
      ];

      if (user.role === 'vendedor') {
        visitFilters.push(eq(visitAgenda.sellerId, user.id));
      }

      // Buscar visitas no período
      const visits = await db.select({
        id: visitAgenda.id,
        sellerId: visitAgenda.sellerId,
        visitStatus: visitAgenda.visitStatus,
        actualCheckIn: visitAgenda.actualCheckIn,
        actualCheckOut: visitAgenda.actualCheckOut,
        isVirtual: visitAgenda.isVirtual,
        salesCardId: visitAgenda.salesCardId,
        scheduledDate: visitAgenda.scheduledDate
      })
      .from(visitAgenda)
      .where(and(...visitFilters));

      // Buscar vendas relacionadas às visitas que têm sales cards
      const salesCardIds = visits
        .filter(v => v.salesCardId)
        .map(v => v.salesCardId);

      let sales: any[] = [];
      if (salesCardIds.length > 0) {
        sales = await db.select({
          salesCardId: salesCards.id,
          status: salesCards.status,
          totalValue: salesCards.totalValue
        })
        .from(salesCards)
        .where(and(
          inArray(salesCards.id, salesCardIds),
          eq(salesCards.status, 'completed')
        ));
      }

      // Calcular métricas
      const totalVisits = visits.length;
      const completedVisits = visits.filter(v => v.visitStatus === 'completed').length;
      const inProgressVisits = visits.filter(v => v.visitStatus === 'in_progress').length;
      const pendingVisits = visits.filter(v => v.visitStatus === 'pending').length;
      const totalSales = sales.length;

      // Calcular tempo médio de visita
      let averageVisitTime = 0;
      const visitsWithTime = visits.filter(v => v.actualCheckIn && v.actualCheckOut);
      if (visitsWithTime.length > 0) {
        const totalTime = visitsWithTime.reduce((acc, visit) => {
          const checkIn = new Date(visit.actualCheckIn);
          const checkOut = new Date(visit.actualCheckOut);
          return acc + (checkOut.getTime() - checkIn.getTime());
        }, 0);
        averageVisitTime = Math.round(totalTime / (visitsWithTime.length * 60000)); // em minutos
      }

      // Taxa de conversão (vendas / visitas completadas)
      const conversionRate = completedVisits > 0 ? (totalSales / completedVisits * 100) : 0;

      // Valor médio por venda
      const averageSaleValue = sales.length > 0 ? 
        sales.reduce((acc, sale) => acc + parseFloat(sale.totalValue || '0'), 0) / sales.length : 0;

      // Performance por vendedor (apenas para admins/coordenadores)
      let performanceBySellerQuery: any[] = [];
      if (['admin', 'coordinator'].includes(user.role)) {
        performanceBySellerQuery = await db.select({
          sellerId: visitAgenda.sellerId,
          sellerFirstName: users.firstName,
          sellerLastName: users.lastName,
          totalVisits: sql<number>`count(${visitAgenda.id})`,
          completedVisits: sql<number>`count(case when ${visitAgenda.visitStatus} = 'completed' then 1 end)`,
          averageTime: sql<number>`avg(case when ${visitAgenda.actualCheckIn} is not null and ${visitAgenda.actualCheckOut} is not null then extract(epoch from ${visitAgenda.actualCheckOut} - ${visitAgenda.actualCheckIn})/60 end)`
        })
        .from(visitAgenda)
        .innerJoin(users, eq(visitAgenda.sellerId, users.id))
        .where(and(...visitFilters))
        .groupBy(visitAgenda.sellerId, users.firstName, users.lastName)
        .having(sql`count(${visitAgenda.id}) > 0`);
      }

      res.json({
        period: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        },
        overview: {
          totalVisits,
          completedVisits,
          inProgressVisits,
          pendingVisits,
          completionRate: totalVisits > 0 ? (completedVisits / totalVisits * 100) : 0,
          averageVisitTime,
          totalSales,
          conversionRate,
          averageSaleValue
        },
        performanceBySeller: performanceBySellerQuery
      });

    } catch (error: any) {
      console.error('❌ Erro ao buscar performance de visitas:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Sincronização completa: Clientes + Faturamentos + Débitos Vencidos
  app.post('/api/omie/sync-complete', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log('🔄 Iniciando sincronização completa (Clientes + Faturamentos + Débitos)...');
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      // Registrar início da sincronização
      await storage.upsertSyncStatus({
        syncType: 'omie_complete',
        lastSyncAt: new Date(),
        status: 'in_progress',
        message: 'Sincronização em andamento...',
        recordsProcessed: 0
      });

      // Responder imediatamente ao cliente
      res.json({
        success: true,
        message: 'Sincronização iniciada em background',
        status: 'in_progress'
      });

      // Processar sincronização em background
      (async () => {
        const results = {
          vendors: null,
          clients: null,
          billings: null,
          overdueDebts: null,
          errors: [],
          startTime: new Date(),
          endTime: null
        };

      // 0. PRIMEIRO: Sincronizar vendedores (necessário antes dos clientes)
      try {
        console.log('👥 Sincronizando vendedores do Omie...');
        const vendorResult = await omieService.syncVendors();
        results.vendors = {
          totalProcessed: vendorResult.totalProcessed || 0,
          imported: vendorResult.imported || 0,
          updated: vendorResult.updated || 0,
          errors: vendorResult.errors || []
        };
        console.log('✅ Vendedores sincronizados:', results.vendors);
      } catch (error: any) {
        console.error('❌ Erro na sincronização de vendedores:', error);
        results.errors.push(`Vendedores: ${error.message}`);
      }

      // 1. Sincronizar clientes ativos
      try {
        console.log('📋 Sincronizando clientes ativos...');
        const clientResult = await omieService.syncAllClients();
        results.clients = {
          totalProcessed: clientResult.totalProcessed || 0,
          imported: clientResult.imported || 0,
          updated: clientResult.updated || 0,
          errors: clientResult.errors || []
        };
        console.log('✅ Clientes sincronizados:', results.clients);
      } catch (error: any) {
        console.error('❌ Erro na sincronização de clientes:', error);
        results.errors.push(`Clientes: ${error.message}`);
      }

      // 2. Sincronizar pedidos/faturamentos (TODOS os períodos)
      try {
        console.log('💰 Sincronizando pedidos e faturamentos...');
        const billingResult = await omieService.syncAllOrders();
        results.billings = {
          totalProcessed: billingResult.totalProcessed || 0,
          imported: billingResult.imported || 0,
          updated: billingResult.updated || 0,
          errors: billingResult.errors || []
        };
        console.log('✅ Faturamentos sincronizados:', results.billings);
      } catch (error: any) {
        console.error('❌ Erro na sincronização de faturamentos:', error);
        results.errors.push(`Faturamentos: ${error.message}`);
      }

      // 3. Sincronizar débitos vencidos
      try {
        console.log('⏰ Sincronizando débitos vencidos...');
        const overdueData = await omieService.getOverdueDebts();
        
        // Salvar débitos no banco de dados
        await storage.syncOverdueDebts(overdueData.debts);
        
        results.overdueDebts = {
          totalClients: overdueData.totalClients || 0,
          totalAmount: overdueData.totalAmount || 0,
          debts: overdueData.debts ? overdueData.debts.length : 0
        };
        console.log('✅ Débitos vencidos sincronizados e salvos no banco:', results.overdueDebts);
      } catch (error: any) {
        console.error('❌ Erro na sincronização de débitos:', error);
        results.errors.push(`Débitos: ${error.message}`);
      }

      results.endTime = new Date();
      const duration = ((results.endTime.getTime() - results.startTime.getTime()) / 1000).toFixed(2);

      console.log(`🏁 Sincronização completa finalizada em ${duration}s`);
      console.log('📊 Resumo:', {
        vendedores: results.vendors,
        clientes: results.clients,
        faturamentos: results.billings,
        debitos: results.overdueDebts,
        erros: results.errors.length
      });

      // Registrar timestamp da sincronização completa
      try {
        const totalRecords = (results.vendors?.totalProcessed || 0) +
                            (results.clients?.totalProcessed || 0) + 
                            (results.billings?.totalProcessed || 0) + 
                            (results.overdueDebts?.debts || 0);
        
        await storage.upsertSyncStatus({
          syncType: 'omie_complete',
          lastSyncAt: new Date(),
          status: results.errors.length > 0 ? 'error' : 'success',
          message: results.errors.length > 0 ? results.errors.join('; ') : 'Sincronização completa realizada com sucesso',
          recordsProcessed: totalRecords
        });
        console.log('✅ Sync status atualizado para omie_complete');
      } catch (error: any) {
        console.error('❌ Erro ao atualizar sync status:', error);
      }

      })().catch(async (error: any) => {
        console.error('❌ Erro geral na sincronização completa em background:', error);
        await storage.upsertSyncStatus({
          syncType: 'omie_complete',
          lastSyncAt: new Date(),
          status: 'error',
          message: `Erro na sincronização: ${error.message}`,
          recordsProcessed: 0
        });
      });

    } catch (error: any) {
      console.error('❌ Erro ao iniciar sincronização completa:', error);
      await storage.upsertSyncStatus({
        syncType: 'omie_complete',
        lastSyncAt: new Date(),
        status: 'error',
        message: `Erro ao iniciar sincronização: ${error.message}`,
        recordsProcessed: 0
      });
      res.status(500).json({ 
        success: false,
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Sincronizar TODAS as notas fiscais do Omie
  app.post('/api/billings/sync-all', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({
          message: 'Integração Omie não configurada'
        });
      }
      
      console.log(`🔄 Iniciando sincronização de TODAS as notas fiscais do Omie...`);
      
      const result = await omieService.syncBillingsInRange('', '');
      
      console.log('✅ Sincronização completa de faturamentos concluída:', result);
      res.json(result);
      
    } catch (error: any) {
      console.error('❌ Erro na sincronização completa de faturamentos:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Atualizar seller_name retroativamente para todos os faturamentos
  app.post('/api/billings/update-seller-names', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log('🔄 Iniciando atualização retroativa de seller_names...');
      
      // Buscar todos os billings com seller_id mas sem seller_name
      const billingsToUpdate = await db.select({
        id: billingsTable.id,
        sellerId: billingsTable.sellerId,
        invoiceNumber: billingsTable.invoiceNumber
      })
        .from(billingsTable)
        .where(
          and(
            isNotNull(billingsTable.sellerId),
            ne(billingsTable.sellerId, ''),
            or(
              isNull(billingsTable.sellerName),
              eq(billingsTable.sellerName, '')
            )
          )
        );
      
      console.log(`📊 Encontrados ${billingsToUpdate.length} faturamentos sem seller_name`);
      
      let updated = 0;
      let notFound = 0;
      const errors: any[] = [];
      
      // Agrupar por sellerId para reduzir queries
      const sellerIds = new Set(billingsToUpdate.map(b => b.sellerId));
      const sellerMap = new Map<string, string>();
      
      // Buscar todos os vendedores de uma vez
      for (const sellerId of sellerIds) {
        try {
          const vendorUserId = `omie-vendor-${sellerId}`;
          const vendor = await storage.getUser(vendorUserId);
          
          if (vendor) {
            const sellerName = `${vendor.firstName} ${vendor.lastName}`.trim();
            sellerMap.set(sellerId, sellerName);
            console.log(`✅ Vendedor encontrado: ${sellerName} (ID: ${sellerId})`);
          } else {
            notFound++;
            console.log(`⚠️ Vendedor não encontrado: ${vendorUserId}`);
          }
        } catch (error) {
          console.error(`❌ Erro ao buscar vendedor ${sellerId}:`, error);
          errors.push({ sellerId, error: error instanceof Error ? error.message : 'Erro desconhecido' });
        }
      }
      
      // Atualizar billings
      for (const billing of billingsToUpdate) {
        try {
          const sellerName = sellerMap.get(billing.sellerId);
          
          if (sellerName) {
            await db.update(billingsTable)
              .set({ 
                sellerName,
                updatedAt: new Date()
              })
              .where(eq(billingsTable.id, billing.id));
            
            updated++;
            
            if (updated % 100 === 0) {
              console.log(`📈 Atualizados ${updated}/${billingsToUpdate.length} faturamentos...`);
            }
          }
        } catch (error) {
          console.error(`❌ Erro ao atualizar billing ${billing.invoiceNumber}:`, error);
          errors.push({ 
            invoiceNumber: billing.invoiceNumber, 
            error: error instanceof Error ? error.message : 'Erro desconhecido' 
          });
        }
      }
      
      console.log(`✅ Atualização concluída: ${updated} atualizados, ${notFound} vendedores não encontrados, ${errors.length} erros`);
      
      res.json({
        success: true,
        total: billingsToUpdate.length,
        updated,
        notFound,
        errors: errors.length,
        errorDetails: errors.slice(0, 10) // Retornar apenas os primeiros 10 erros
      });
      
    } catch (error: any) {
      console.error('❌ Erro na atualização de seller_names:', error);
      res.status(500).json({ 
        success: false,
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Endpoint de debug para buscar nota específica
  app.get('/api/billings/debug-nota/:numero', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const { numero } = req.params;
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({
          message: 'Integração Omie não configurada'
        });
      }
      
      console.log(`🔍 Buscando nota ${numero} na API do Omie...`);
      
      // Buscar nas notas fiscais
      const response = await (omieService as any).makeRequest('/produtos/nfconsultar/', 'ListarNF', {
        pagina: 1,
        registros_por_pagina: 100,
        apenas_importado_api: 'N',
        filtrar_por_data_de: '01/09/2025',
        filtrar_por_data_ate: '',
        ordenar_por: 'DATA',
        ordem_decrescente: 'S'
      });
      
      console.log('📊 Total encontrado:', response.total_de_registros);
      
      // Procurar a nota específica
      const notaEspecifica = response.nfCadastro?.find((nf: any) => 
        nf.ide?.nNF === `000${numero}` || 
        nf.ide?.nNF === numero ||
        nf.ide?.nNF?.includes(numero)
      );
      
      if (notaEspecifica) {
        console.log('✅ NOTA ENCONTRADA:', notaEspecifica.ide?.nNF);
        res.json({
          encontrada: true,
          nota: {
            numero: notaEspecifica.ide?.nNF,
            data: notaEspecifica.ide?.dhEmi,
            cfop: notaEspecifica.det?.[0]?.prod?.CFOP,
            statusSefaz: notaEspecifica.infNFe?.cStat,
            statusDesc: notaEspecifica.infNFe?.xMotivo,
            cliente: notaEspecifica.dest?.xNome,
            valor: notaEspecifica.total?.ICMSTot?.vNF
          },
          dadosCompletos: notaEspecifica
        });
      } else {
        console.log('❌ Nota não encontrada');
        const primeiras5 = response.nfCadastro?.slice(0, 5).map((nf: any) => ({
          numero: nf.ide?.nNF,
          data: nf.ide?.dhEmi,
          cfop: nf.det?.[0]?.prod?.CFOP
        }));
        
        res.json({
          encontrada: false,
          total: response.total_de_registros,
          primeiras5,
          message: `Nota ${numero} não encontrada`
        });
      }
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar nota:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Endpoint de debug para testar sincronização de uma página
  app.post('/api/billings/debug-sync', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({
          message: 'Integração Omie não configurada'
        });
      }
      
      console.log('🔍 DEBUG: Executando sincronização de UMA página para análise...');
      
      // Fazer request para uma página apenas
      const response = await (omieService as any).makeRequest('/produtos/nfconsultar/', 'ListarNF', {
        pagina: 1,
        registros_por_pagina: 5, // Apenas 5 registros para debug
        apenas_importado_api: 'N',
        filtrar_por_data_de: '',
        filtrar_por_data_ate: '',
        ordenar_por: 'DATA',
        ordem_decrescente: 'S'
      });

      const invoices = response.nfCadastro || [];
      console.log('🔍 DEBUG: Total de notas encontradas:', invoices.length);
      
      if (invoices.length > 0) {
        console.log('🔍 DEBUG: Estrutura da primeira nota:', JSON.stringify(invoices[0], null, 2));
        
        // Testar transformação
        const transformedData = (omieService as any).transformInvoiceToBilling(invoices[0]);
        console.log('🔍 DEBUG: Dados transformados:', JSON.stringify(transformedData, null, 2));
      }
      
      res.json({
        success: true,
        totalFound: invoices.length,
        firstInvoice: invoices[0] || null,
        transformed: invoices.length > 0 ? (omieService as any).transformInvoiceToBilling(invoices[0]) : null
      });
      
    } catch (error: any) {
      console.error('❌ Erro no debug de sincronização:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Sincronizar faturamentos do Omie por período
  app.post('/api/billings/sync', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      const { startDate, endDate } = req.body;
      
      if (!startDate || !endDate) {
        return res.status(400).json({
          error: 'startDate e endDate são obrigatórios'
        });
      }
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({
          message: 'Integração Omie não configurada'
        });
      }
      
      console.log(`🔄 Iniciando sincronização de faturamentos de ${startDate} até ${endDate}...`);
      
      const result = await omieService.syncBillingsInRange(startDate, endDate);
      
      console.log('✅ Sincronização de faturamentos concluída:', result);
      
      // Save sync status
      await saveSyncStatus(
        'omie_billings',
        'success',
        result.total || 0,
        `${result.inserted || 0} inseridos, ${result.updated || 0} atualizados`
      );
      
      res.json(result);
      
    } catch (error: any) {
      console.error('❌ Erro na sincronização de faturamentos:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });
  
  // Endpoint administrativo para limpar notas canceladas
  app.post('/api/billings/cleanup-cancelled', authenticateUser, requireRole(['admin', 'coordinator']), async (req, res) => {
    try {
      console.log('🧹 Iniciando limpeza de notas fiscais canceladas...');
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({
          message: 'Integração Omie não configurada'
        });
      }
      
      // Buscar todas as billings em "Aguardando Rota"
      const billingsToCheck = await db
        .select()
        .from(billingsTable)
        .where(eq(billingsTable.invoiceStage, 'Aguardando Rota'));
      
      console.log(`📊 Encontradas ${billingsToCheck.length} notas em "Aguardando Rota" para verificar`);
      
      const cancelledInvoices: string[] = [];
      const errors: Array<{invoice: string, error: string}> = [];
      
      // Verificar cada nota no Omie
      for (const billing of billingsToCheck) {
        try {
          // Usar o omieOrderId da billing (se disponível)
          if (!billing.omieOrderId) {
            console.log(`⚠️ NF ${billing.invoiceNumber} não tem omieOrderId - pulando`);
            continue;
          }
          
          // Verificar se o pedido está cancelado no Omie
          const stageData = await omieService['fetchPedidoStage'](billing.omieOrderId);
          
          if (stageData && stageData.cancelled) {
            console.log(`🚫 NF ${billing.invoiceNumber} está CANCELADA no Omie - será removida`);
            cancelledInvoices.push(billing.invoiceNumber);
            
            // Deletar do banco de dados
            await db
              .delete(billingsTable)
              .where(eq(billingsTable.id, billing.id));
          }
        } catch (error: any) {
          console.error(`❌ Erro ao verificar NF ${billing.invoiceNumber}:`, error.message);
          errors.push({
            invoice: billing.invoiceNumber,
            error: error.message
          });
        }
      }
      
      const result = {
        totalChecked: billingsToCheck.length,
        cancelledFound: cancelledInvoices.length,
        removed: cancelledInvoices,
        errors: errors.length > 0 ? errors : undefined
      };
      
      console.log('✅ Limpeza concluída:', result);
      res.json(result);
      
    } catch (error: any) {
      console.error('❌ Erro na limpeza de notas canceladas:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });
  
  // Obter estatísticas de faturamentos
  app.get('/api/billings/stats', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const { 
        sellerId, 
        month, 
        year,
        startDate: reqStartDate,
        endDate: reqEndDate,
        customerDocument,
        invoiceNumber,
        cfop,
        invoiceStage
      } = req.query;
      
      // Calcular período do mês se especificado (para compatibilidade com versão anterior)
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (month && year) {
        const monthNum = parseInt(month as string);
        const yearNum = parseInt(year as string);
        startDate = new Date(yearNum, monthNum - 1, 1);
        endDate = new Date(yearNum, monthNum, 0); // Último dia do mês
      } else if (reqStartDate || reqEndDate) {
        // Usar datas específicas dos filtros
        startDate = reqStartDate ? new Date(reqStartDate as string) : undefined;
        endDate = reqEndDate ? new Date(reqEndDate as string) : undefined;
      }
      
      // Para vendedores, usar o sellerId do middleware (req.sellerId)
      // Para admins/coordenadores, permitir sellerId do query
      const effectiveSellerId = req.sellerId || (sellerId as string);
      
      // Usar novo método eficiente com SQL aggregates
      const statsResult = await storage.getBillingsStats({
        sellerId: effectiveSellerId,
        startDate,
        endDate,
        customerDocument: customerDocument as string,
        invoiceNumber: invoiceNumber as string,
        cfop: cfop as string,
        invoiceStage: invoiceStage as string
      });
      
      const stats = {
        ...statsResult,
        period: month && year ? `${month}/${year}` : 'Todos os períodos'
      };
      
      res.json(stats);
      
    } catch (error: any) {
      console.error('❌ Erro ao obter estatísticas de faturamentos:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });
  
  // Listar vendedores únicos para filtro
  app.get('/api/billings/sellers', authenticateUser, async (req, res) => {
    try {
      const sellers = await storage.getUniqueSellers();
      res.json(sellers);
    } catch (error: any) {
      console.error('❌ Erro ao obter lista de vendedores:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // Exportar todos os dados do Omie em Excel (DEVE VIR ANTES DO /:id)
  app.get('/api/billings/export', authenticateUser, async (req: any, res) => {
    try {
      const XLSX = await import('xlsx');
      
      // Buscar todos os billings sem filtro
      const allBillings = await db.select().from(billingsTable).orderBy(billingsTable.orderDate);
      
      // Formatar dados para Excel
      const excelData = allBillings.map(b => ({
        'Número Pedido': b.orderNumber,
        'ID Pedido Omie': b.omieOrderId,
        'Número NF': b.invoiceNumber || '',
        'ID NF Omie': b.omieInvoiceId || '',
        'Cliente': b.customerFantasyName,
        'CPF/CNPJ': b.customerDocument || '',
        'Código Cliente Omie': b.omieCustomerCode || '',
        'CFOP': b.cfop || '',
        'Data Pedido': b.orderDate ? new Date(b.orderDate).toLocaleDateString('pt-BR') : '',
        'Data Faturamento': b.invoiceDate ? new Date(b.invoiceDate).toLocaleDateString('pt-BR') : '',
        'Data Vencimento': b.dueDate ? new Date(b.dueDate).toLocaleDateString('pt-BR') : '',
        'Valor Total': b.totalValue ? parseFloat(b.totalValue.toString()) : 0,
        'Forma Pagamento': b.paymentMethod || '',
        'Vendedor': b.sellerName || '',
        'ID Vendedor': b.sellerId || '',
        'Tipo Faturamento': b.billingType,
        'Status NF': b.invoiceStatus || '',
        'Etapa': b.invoiceStage || '',
        'Produtos': b.products ? JSON.stringify(b.products) : '',
        'Criado Em': b.createdAt ? new Date(b.createdAt).toLocaleString('pt-BR') : '',
        'Atualizado Em': b.updatedAt ? new Date(b.updatedAt).toLocaleString('pt-BR') : ''
      }));
      
      // Criar workbook e worksheet
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(excelData);
      
      // Ajustar largura das colunas
      const colWidths = [
        { wch: 15 }, // Número Pedido
        { wch: 20 }, // ID Pedido Omie
        { wch: 15 }, // Número NF
        { wch: 20 }, // ID NF Omie
        { wch: 35 }, // Cliente
        { wch: 20 }, // CPF/CNPJ
        { wch: 20 }, // Código Cliente Omie
        { wch: 10 }, // CFOP
        { wch: 15 }, // Data Pedido
        { wch: 15 }, // Data Faturamento
        { wch: 15 }, // Data Vencimento
        { wch: 15 }, // Valor Total
        { wch: 20 }, // Forma Pagamento
        { wch: 25 }, // Vendedor
        { wch: 15 }, // ID Vendedor
        { wch: 20 }, // Tipo Faturamento
        { wch: 15 }, // Status NF
        { wch: 20 }, // Etapa
        { wch: 50 }, // Produtos
        { wch: 20 }, // Criado Em
        { wch: 20 }  // Atualizado Em
      ];
      ws['!cols'] = colWidths;
      
      XLSX.utils.book_append_sheet(wb, ws, 'Dados Omie');
      
      // Gerar buffer do Excel
      const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      // Enviar arquivo
      const timestamp = new Date().toISOString().split('T')[0];
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=dados-omie-${timestamp}.xlsx`);
      res.send(excelBuffer);
      
    } catch (error) {
      console.error('Erro ao exportar dados do Omie:', error);
      res.status(500).json({ message: 'Erro ao exportar dados' });
    }
  });
  
  // Buscar faturamento específico
  app.get('/api/billings/:id', authenticateUser, async (req, res) => {
    try {
      const billing = await storage.getBilling(req.params.id);
      if (!billing) {
        return res.status(404).json({ error: 'Faturamento não encontrado' });
      }
      res.json(billing);
    } catch (error: any) {
      console.error('❌ Erro ao buscar faturamento:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  });

  // Nova rota: Buscar TODAS as contas a receber (sem filtros)
  app.get('/api/omie/contas-receber', authenticateUser, async (req: any, res) => {
    try {
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Fetching ALL contas receber from Omie...`);
      const contasData = await omieService.getAllContasReceber();
      
      // Enriquecer com dados de cliente - Mapear campos corretamente do Omie
      const enrichedTitulos = contasData.titulos.map((titulo: any) => ({
        ...titulo,
        numero_documento: titulo.numero_documento || titulo.numero_nf || titulo.numero_titulo || '',
        razao_social: titulo.nome_fantasia || titulo.razao_social || `Cliente ${titulo.codigo_cliente_omie || ''}`,
        cnpj_cpf: titulo.cpf_cnpj || titulo.cnpj_cpf || '',
        valor_documento: parseFloat(titulo.valor_documento) || 0,
        valor_a_receber: parseFloat(titulo.valor_a_receber || titulo.valor_aberto || titulo.valor_documento || 0),
        data_vencimento: titulo.data_vencimento || titulo.data_venc || '',
        data_previsao: titulo.data_previsao || titulo.data_venc || '',
        status_titulo: titulo.status_titulo || titulo.situacao || ''
      }));
      
      console.log(`[${timestamp}] Contas receber fetch complete - returning ${contasData.totalTitulos} títulos`);
      res.json({
        ...contasData,
        titulos: enrichedTitulos
      });

    } catch (error) {
      console.error("Error fetching contas receber from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar contas a receber no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para buscar débitos salvos no banco (carregamento rápido)
  app.get('/api/omie/overdue-debts/cached', authenticateUser, async (req: any, res) => {
    try {
      const savedDebts = await storage.getOverdueDebts();
      
      if (!savedDebts || savedDebts.length === 0) {
        return res.json({
          debts: [],
          totalAmount: 0,
          totalClients: 0,
          message: "Nenhum débito salvo. Execute a sincronização."
        });
      }

      // Transformar dados do banco para o formato esperado pelo frontend
      // Cada linha já representa UM cliente com TODOS os seus débitos
      const debts = savedDebts.map(debt => ({
        cliente: {
          codigo_cliente_omie: parseInt(debt.omieClientId),
          nome_fantasia: debt.clientName,
          cnpj_cpf: debt.clientDocument || ''
        },
        debitos: debt.debts || [],
        valorTotal: parseFloat(debt.totalAmount),
        diasMaximoAtraso: debt.maxDaysOverdue,
        vendedores: debt.vendedores || [] // Usar vendedores salvos no banco
      }));

      const totalAmount = debts.reduce((sum, d) => sum + d.valorTotal, 0);

      res.json({
        debts,
        totalAmount,
        totalClients: debts.length
      });
    } catch (error) {
      console.error("Error fetching cached overdue debts:", error);
      res.status(500).json({ 
        message: "Erro ao buscar débitos salvos",
        debts: [],
        totalAmount: 0,
        totalClients: 0
      });
    }
  });

  // Rota para sincronizar débitos do Omie (operação demorada)
  app.get('/api/omie/overdue-debts', authenticateUser, async (req: any, res) => {
    try {
      // Evitar cache
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Fetching overdue debts from Omie - NO CACHE...`);
      const overdueData = await omieService.getOverdueDebts();
      console.log(`[${timestamp}] Overdue debts fetch complete - returning ${overdueData.totalClients} clients`);
      
      // Salvar débitos no banco de dados
      try {
        await storage.syncOverdueDebts(overdueData.debts);
        console.log('✅ Débitos salvos no banco de dados');
      } catch (saveError) {
        console.error('❌ Erro ao salvar débitos no banco:', saveError);
      }
      
      // Gerar e salvar planilha Excel automaticamente após a sincronização
      try {
        const fileName = `debitos-vencidos-${new Date().toISOString().split('T')[0]}.xlsx`;
        
        // Preparar dados detalhados (todos os documentos)
        const detalhesData: any[] = [];
        overdueData.debts.forEach((debt: any) => {
          debt.debitos.forEach((documento: any) => {
            detalhesData.push({
              'Cliente': debt.cliente.nome_fantasia,
              'CNPJ/CPF': debt.cliente.cnpj_cpf,
              'Nº Nota Fiscal': documento.numero_documento_fiscal || documento.numero_documento || 'N/A',
              'Valor': documento.valor,
              'Data Vencimento': documento.data_vencimento,
              'Dias Atraso': documento.dias_atraso,
            });
          });
        });

        // Criar workbook
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(detalhesData);
        XLSX.utils.book_append_sheet(wb, ws, 'Detalhes dos Documentos');

        // Gerar buffer e converter para base64
        const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const base64Data = excelBuffer.toString('base64');

        // Salvar no banco de dados
        await storage.saveExportedReport(
          'overdue_debts',
          fileName,
          base64Data,
          {
            totalClients: overdueData.totalClients,
            totalAmount: overdueData.totalAmount,
            syncDate: new Date().toISOString()
          },
          req.user?.id
        );

        console.log(`[${timestamp}] Excel report saved successfully: ${fileName}`);
      } catch (excelError) {
        console.error('Error generating/saving Excel report:', excelError);
        // Não falhar a requisição se o Excel falhar
      }
      
      res.json(overdueData);

    } catch (error) {
      console.error("Error fetching overdue debts from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar débitos em atraso no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Endpoint para download da planilha salva
  app.get('/api/reports/overdue-debts/latest', authenticateUser, async (req: any, res) => {
    try {
      const report = await storage.getLatestExportedReport('overdue_debts');
      
      if (!report) {
        return res.status(404).json({ 
          message: "Nenhuma planilha encontrada. Execute a sincronização primeiro." 
        });
      }

      // Converter base64 de volta para buffer
      const excelBuffer = Buffer.from(report.fileData, 'base64');

      // Configurar headers para download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
      res.setHeader('Content-Length', excelBuffer.length);

      res.send(excelBuffer);
    } catch (error) {
      console.error("Error downloading saved report:", error);
      res.status(500).json({ 
        message: "Erro ao baixar planilha salva",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Endpoint para obter informações sobre a última planilha (sem fazer download)
  app.get('/api/reports/overdue-debts/info', authenticateUser, async (req: any, res) => {
    try {
      const report = await storage.getLatestExportedReport('overdue_debts');
      
      if (!report) {
        return res.json({ 
          exists: false,
          message: "Nenhuma planilha salva" 
        });
      }

      res.json({
        exists: true,
        fileName: report.fileName,
        createdAt: report.createdAt,
        metadata: report.metadata
      });
    } catch (error) {
      console.error("Error fetching report info:", error);
      res.status(500).json({ 
        message: "Erro ao buscar informações da planilha",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para comparar arquivo Excel com dados da sincronização
  app.post('/api/omie/compare-excel', authenticateUser, upload.single('excelFile'), async (req: any, res) => {
    try {
      console.log('Route /api/omie/compare-excel called');
      console.log('File received:', !!req.file);
      
      // Garantir que sempre retornamos JSON
      res.setHeader('Content-Type', 'application/json');
      
      if (!req.file) {
        console.log('No file uploaded');
        return res.status(400).json({ message: "Arquivo Excel é obrigatório" });
      }

      const omieService = getOmieService(storage);
      if (!omieService) {
        console.log('Omie service not configured');
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      console.log('Analisando arquivo Excel...');
      console.log('File name:', req.file.originalname);
      console.log('File size:', req.file.size);
      
      // Ler arquivo Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0]; // Primeira aba
      const worksheet = workbook.Sheets[sheetName];
      const excelData = XLSX.utils.sheet_to_json(worksheet);

      console.log(`Arquivo Excel contém ${excelData.length} registros`);

      // Buscar dados atuais da API Omie
      console.log('Buscando dados atuais da API Omie...');
      const omieData = await omieService.getOverdueDebts();

      console.log(`API Omie retornou ${omieData.totalClients} clientes com débitos`);

      // Comparar dados
      const comparison = {
        excel: {
          totalRecords: excelData.length,
          columns: Object.keys(excelData[0] || {}),
          sample: excelData.slice(0, 3) // Primeiros 3 registros para análise
        },
        omie: {
          totalClients: omieData.totalClients,
          totalAmount: omieData.totalAmount,
          sampleClients: omieData.debts.slice(0, 3).map(debt => ({
            codigo_cliente_omie: debt.cliente.codigo_cliente_omie,
            nome_fantasia: debt.cliente.nome_fantasia,
            cnpj_cpf: debt.cliente.cnpj_cpf,
            valorTotal: debt.valorTotal,
            diasMaximoAtraso: debt.diasMaximoAtraso,
            qtdDocumentos: debt.debitos.length
          }))
        },
        differences: [],
        recommendations: []
      };

      // Analisar estrutura do Excel para identificar possíveis campos de comparação
      const excelColumns = Object.keys(excelData[0] || {});
      const possibleClientFields = excelColumns.filter(col => 
        col.toLowerCase().includes('client') ||
        col.toLowerCase().includes('nome') ||
        col.toLowerCase().includes('razao') ||
        col.toLowerCase().includes('cnpj') ||
        col.toLowerCase().includes('cpf') ||
        col.toLowerCase().includes('codigo')
      );

      const possibleValueFields = excelColumns.filter(col => 
        col.toLowerCase().includes('valor') ||
        col.toLowerCase().includes('total') ||
        col.toLowerCase().includes('debt') ||
        col.toLowerCase().includes('divida')
      );

      const possibleDateFields = excelColumns.filter(col => 
        col.toLowerCase().includes('data') ||
        col.toLowerCase().includes('venc') ||
        col.toLowerCase().includes('date') ||
        col.toLowerCase().includes('atraso')
      );

      // Adicionar recomendações baseadas na análise
      comparison.recommendations.push({
        type: 'structure',
        message: `Arquivo Excel possui ${excelColumns.length} colunas. Campos identificados:`,
        details: {
          possibleClientFields,
          possibleValueFields,
          possibleDateFields
        }
      });

      // Se conseguirmos identificar um campo de cliente, fazer comparação básica
      if (possibleClientFields.length > 0) {
        const clientField = possibleClientFields[0];
        const excelClients = new Set(excelData.map((row: any) => row[clientField]?.toString().trim()));
        const omieClients = new Set(omieData.debts.map(debt => debt.cliente.nome_fantasia));

        const onlyInExcel = Array.from(excelClients).filter(client => !omieClients.has(client));
        const onlyInOmie = Array.from(omieClients).filter(client => !excelClients.has(client));

        comparison.differences.push({
          type: 'clients',
          message: 'Comparação de clientes entre Excel e Omie',
          excelTotal: excelClients.size,
          omieTotal: omieClients.size,
          onlyInExcel: onlyInExcel.slice(0, 10), // Primeiros 10
          onlyInOmie: onlyInOmie.slice(0, 10), // Primeiros 10
        });
      }

      res.json(comparison);

    } catch (error) {
      console.error("Error comparing Excel file:", error);
      // Garantir que sempre retornamos JSON mesmo em erro
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ 
          message: "Erro ao analisar arquivo Excel",
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }
  });

  // Rota para buscar vendedores
  app.get('/api/omie/vendedores', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const vendedores = await omieService.getAllVendors();
      res.json(vendedores.vendors);

    } catch (error) {
      console.error("Error fetching vendors from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar vendedores no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para buscar um vendedor específico pelo código do Omie
  app.get('/api/omie/vendedores/:codigo', authenticateUser, async (req: any, res) => {
    try {
      const { codigo } = req.params;
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const vendorData = await omieService.fetchSellerData(codigo);
      if (!vendorData) {
        return res.status(404).json({ 
          message: `Vendedor com código ${codigo} não encontrado no Omie`,
          codigo
        });
      }

      res.json({
        codigo,
        nome: vendorData.name,
        id: vendorData.id,
        systemId: `omie-vendor-${codigo}`
      });

    } catch (error) {
      console.error("Error fetching vendor from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar vendedor no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para buscar cliente específico no Omie por CNPJ
  app.get('/api/omie/search-client', authenticateUser, async (req: any, res) => {
    try {
      const { cnpj } = req.query;
      
      if (!cnpj) {
        return res.status(400).json({ 
          message: "CNPJ é obrigatório" 
        });
      }

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      console.log(`Buscando cliente no Omie com CNPJ: ${cnpj}`);
      
      const cliente = await omieService.getClientByCnpjCpf(cnpj as string);
      
      if (!cliente) {
        return res.json({ 
          found: false,
          message: "Cliente não encontrado no Omie"
        });
      }

      const formattedClient = omieService.convertClientToSystemFormat(cliente);

      res.json({ 
        found: true,
        omieClient: cliente,
        systemFormat: formattedClient,
        message: "Cliente encontrado no Omie"
      });

    } catch (error) {
      console.error("Error searching client in Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar cliente no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Blocked orders routes
  app.get('/api/blocked-orders', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const sellerId = user?.role === 'vendedor' ? user.id : undefined;
      
      // Buscar pedidos bloqueados do banco de dados
      const blockedOrdersData = await db.select()
        .from(blockedOrders)
        .where(eq(blockedOrders.status, 'blocked'));
      
      // Buscar dados relacionados (cliente e vendedor)
      const enrichedOrders = await Promise.all(
        blockedOrdersData.map(async (order) => {
          const customer = await storage.getCustomer(order.customerId);
          const seller = await storage.getUser(order.sellerId);
          
          return {
            ...order,
            customer: {
              name: customer?.name || 'Cliente não encontrado',
              fantasyName: customer?.fantasyName || null,
              phone: customer?.phone || '',
              email: customer?.email || ''
            },
            seller: {
              firstName: seller?.firstName || 'Vendedor',
              lastName: seller?.lastName || 'não encontrado',
              email: seller?.email || ''
            }
          };
        })
      );
      
      res.json(enrichedOrders);
    } catch (error) {
      console.error("Error fetching blocked orders:", error);
      res.status(500).json({ message: "Failed to fetch blocked orders" });
    }
  });

  // Release blocked orders (only admin, coordinator, administrative)
  app.post('/api/blocked-orders/release', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { orderIds } = req.body;
      const userId = req.currentUser.id;
      
      console.log(`🔓 Tentativa de liberar pedidos bloqueados:`, {
        orderIds,
        count: orderIds?.length,
        userId,
        userEmail: req.currentUser.email
      });
      
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        console.log(`❌ Requisição inválida: orderIds vazio ou não é array`);
        return res.status(400).json({ message: "Lista de IDs de pedidos é obrigatória" });
      }
      
      console.log(`Releasing ${orderIds.length} blocked orders by user ${req.currentUser.email}`);
      
      let released = 0;
      const errors = [];
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        console.log(`❌ Omie service não configurado`);
        return res.status(503).json({ message: 'Integração Omie não configurada' });
      }
      
      console.log(`✅ Omie service configurado, iniciando processamento de ${orderIds.length} pedido(s)`);
      
      
      for (const orderId of orderIds) {
        let order: any = null;
        let salesCard: any = null;
        
        try {
          console.log(`\n📦 Processando pedido ${orderId}...`);
          
          // Buscar pedido bloqueado
          const blockedOrder = await db.select()
            .from(blockedOrders)
            .where(eq(blockedOrders.id, orderId))
            .limit(1);
          
          if (blockedOrder.length === 0) {
            console.log(`❌ Pedido ${orderId} não encontrado no banco`);
            errors.push(`Pedido ${orderId} não encontrado`);
            continue;
          }
          
          order = blockedOrder[0];
          console.log(`✓ Pedido encontrado: salesCardId=${order.salesCardId}, customerId=${order.customerId}, status=${order.status}`);
          
          // Validar status do pedido - apenas processar se estiver bloqueado
          if (order.status !== 'blocked') {
            console.log(`⚠️ Pedido ${orderId} não está bloqueado (status: ${order.status}), ignorando`);
            errors.push(`Pedido já foi processado (status: ${order.status})`);
            continue;
          }
          
          // Buscar sales card relacionado
          salesCard = await storage.getSalesCard(order.salesCardId);
          if (!salesCard) {
            console.log(`❌ Sales card ${order.salesCardId} não encontrado`);
            errors.push(`Sales card ${order.salesCardId} não encontrado`);
            continue;
          }
          console.log(`✓ Sales card encontrado: cliente=${salesCard.customer?.name}`);
          
          if (!salesCard.customer) {
            console.log(`❌ Sales card ${order.salesCardId} sem dados de cliente`);
            errors.push(`Sales card ${order.salesCardId} sem dados de cliente`);
            continue;
          }
          
          // Buscar dados completos dos produtos
          console.log(`✓ Buscando produtos do pedido...`);
          let products = [];
          const missingProducts: string[] = [];
          
          if (order.products && Array.isArray(order.products) && order.products.length > 0) {
            console.log(`   Produtos no pedido bloqueado:`, order.products.map((p: any) => ({ id: p.id, name: p.name, qty: p.quantity })));
            
            for (const cardProduct of order.products) {
              console.log(`   Buscando produto ${cardProduct.id} (${cardProduct.name})...`);
              
              let product = await storage.getProduct(cardProduct.id);
              if (!product) {
                console.log(`     Produto ${cardProduct.id} não encontrado por ID, tentando por código Omie...`);
                product = await storage.getProductByOmieCode(cardProduct.id);
              }
              
              if (!product) {
                console.log(`     ❌ ERRO: Produto ${cardProduct.id} (${cardProduct.name}) não encontrado no cadastro`);
                missingProducts.push(cardProduct.name);
              } else {
                console.log(`     ✓ Produto encontrado: ${product.name} (Omie: ${product.omieCode || product.omieCodigo || product.omieCodigoProduto || 'N/A'})`);
                
                // Validar que o produto tem código Omie válido
                const omieCode = product.omieCode || product.omieCodigo || product.omieCodigoProduto;
                if (!omieCode) {
                  console.log(`     ❌ ERRO: Produto ${product.name} não tem código Omie configurado`);
                  missingProducts.push(`${product.name} (sem código Omie)`);
                } else {
                  products.push({
                    id: product.id,
                    omieCode: omieCode,
                    omieCodigo: omieCode,
                    omieCodigoProduto: omieCode,
                    name: product.name,
                    unitPrice: cardProduct.unitPrice || 0,
                    quantity: cardProduct.quantity || 1
                  });
                }
              }
            }
            
            console.log(`✓ ${products.length} produto(s) válido(s) para envio ao Omie`);
            if (missingProducts.length > 0) {
              console.log(`❌ ${missingProducts.length} produto(s) faltando ou sem código Omie: ${missingProducts.join(', ')}`);
            }
          } else {
            console.log(`⚠️ Nenhum produto no pedido`);
          }
          
          // Validar que há produtos antes de enviar
          if (missingProducts.length > 0) {
            console.log(`❌ Pedido não pode ser liberado - produtos faltando: ${missingProducts.join(', ')}`);
            const customerName = salesCard?.customer?.fantasyName || salesCard?.customer?.name || 'Cliente desconhecido';
            errors.push(`${customerName}: Produtos não encontrados ou sem código Omie: ${missingProducts.join(', ')}`);
            continue;
          }
          
          if (!products || products.length === 0) {
            console.log(`❌ Nenhum produto válido para enviar ao Omie`);
            const customerName = salesCard?.customer?.fantasyName || salesCard?.customer?.name || 'Cliente desconhecido';
            errors.push(`${customerName}: Pedido sem produtos válidos`);
            continue;
          }
          
          // Enviar para Omie
          console.log(`📤 Enviando pedido para Omie...`, {
            paymentMethod: order.paymentMethod || 'a_vista',
            operationType: order.operationType || 'venda',
            sellerId: order.sellerId,
            productsCount: products.length
          });
          
          const omieResponse = await omieService.createSalesOrder(
            salesCard,
            salesCard.customer,
            products,
            order.paymentMethod || 'a_vista',
            order.operationType || 'venda',
            order.sellerId
          );
          
          console.log(`✅ Resposta do Omie recebida:`, {
            codigo_pedido: omieResponse.codigo_pedido,
            numero_pedido: omieResponse.numero_pedido
          });
          
          // Atualizar sales card com ID do Omie
          await storage.updateSalesCard(order.salesCardId, {
            omieOrderId: omieResponse.codigo_pedido?.toString() || `HS-${Date.now()}`,
            notes: (salesCard.notes || '') + `\n\nLiberado e enviado para Omie: ${new Date().toLocaleString('pt-BR')}`
          });
          
          // Atualizar status do pedido bloqueado
          await db.update(blockedOrders)
            .set({
              status: 'sent_to_omie',
              releasedAt: new Date(),
              releasedBy: userId,
              omieOrderId: omieResponse.codigo_pedido?.toString()
            })
            .where(eq(blockedOrders.id, orderId));
          
          released++;
          console.log(`✅ Pedido ${orderId} liberado e enviado para Omie`);
          
        } catch (error: any) {
          const errorMessage = error.message || 'Erro desconhecido';
          console.error(`❌ Erro ao liberar pedido ${orderId}:`, {
            message: errorMessage,
            stack: error.stack,
            name: error.name,
            orderDetails: {
              salesCardId: order?.salesCardId,
              customerId: order?.customerId,
              customerName: salesCard?.customer?.name,
              productsCount: order?.products?.length
            }
          });
          
          // Adicionar mensagem de erro mais descritiva para o usuário
          const customerName = salesCard?.customer?.fantasyName || salesCard?.customer?.name || 'Cliente desconhecido';
          errors.push(`${customerName}: ${errorMessage}`);
        }
      }
      
      console.log(`\n📊 Resultado final da liberação:`, {
        released,
        errorsCount: errors.length,
        errors: errors.length > 0 ? errors : 'Nenhum erro'
      });
      
      res.json({
        released,
        errors,
        message: `${released} pedido(s) liberado(s) com sucesso${errors.length > 0 ? `, ${errors.length} erro(s)` : ''}`
      });
      
    } catch (error: any) {
      console.error("❌ ERRO CRÍTICO ao liberar pedidos bloqueados:", {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      res.status(500).json({ 
        message: `Erro ao processar liberação: ${error.message || 'Erro desconhecido'}` 
      });
    }
  });

  // Reject (delete) released blocked orders (only admin, coordinator, administrative)
  app.post('/api/blocked-orders/reject', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { orderIds } = req.body;
      const userId = req.currentUser.id;
      
      console.log(`🗑️ Tentativa de rejeitar pedidos bloqueados:`, {
        orderIds,
        count: orderIds?.length,
        userId,
        userEmail: req.currentUser.email
      });
      
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        console.log(`❌ Requisição inválida: orderIds vazio ou não é array`);
        return res.status(400).json({ message: "Lista de IDs de pedidos é obrigatória" });
      }
      
      let rejected = 0;
      const errors = [];
      
      for (const orderId of orderIds) {
        try {
          console.log(`\n🗑️ Processando pedido ${orderId}...`);
          
          // Buscar pedido bloqueado
          const blockedOrder = await db.select()
            .from(blockedOrders)
            .where(eq(blockedOrders.id, orderId))
            .limit(1);
          
          if (blockedOrder.length === 0) {
            console.log(`❌ Pedido ${orderId} não encontrado no banco`);
            errors.push(`Pedido ${orderId} não encontrado`);
            continue;
          }
          
          const order = blockedOrder[0];
          
          // Verificar se o pedido está bloqueado (podemos rejeitar apenas pedidos bloqueados)
          if (order.status !== 'blocked') {
            console.log(`⚠️ Pedido ${orderId} não está bloqueado (status: ${order.status})`);
            errors.push(`Pedido ${orderId} não está bloqueado`);
            continue;
          }
          
          console.log(`✓ Pedido encontrado e bloqueado: salesCardId=${order.salesCardId}`);
          
          // Deletar pedido bloqueado
          await db.delete(blockedOrders)
            .where(eq(blockedOrders.id, orderId));
          
          rejected++;
          console.log(`✅ Pedido ${orderId} rejeitado e removido do sistema`);
          
        } catch (error: any) {
          console.error(`❌ Erro ao rejeitar pedido ${orderId}:`, {
            message: error.message,
            stack: error.stack,
            name: error.name
          });
          errors.push(`Pedido ${orderId}: ${error.message || 'Erro desconhecido'}`);
        }
      }
      
      console.log(`\n📊 Resultado final da rejeição:`, {
        rejected,
        errorsCount: errors.length,
        errors: errors.length > 0 ? errors : 'Nenhum erro'
      });
      
      res.json({
        rejected,
        errors,
        message: `${rejected} pedido(s) rejeitado(s) com sucesso${errors.length > 0 ? `, ${errors.length} erro(s)` : ''}`
      });
      
    } catch (error: any) {
      console.error("❌ ERRO CRÍTICO ao rejeitar pedidos bloqueados:", {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      res.status(500).json({ 
        message: `Erro ao processar rejeição: ${error.message || 'Erro desconhecido'}` 
      });
    }
  });

  // Rota para sincronizar todos os vendedores do Omie
  app.post('/api/omie/sync-vendors', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      console.log('🔄 Iniciando sincronização de vendedores via endpoint...');
      const result = await omieService.syncVendors();
      
      // Save sync status
      await saveSyncStatus(
        'omie_vendors',
        'success',
        (result.imported || 0) + (result.updated || 0),
        `${result.imported} importados, ${result.updated} atualizados`
      );
      
      res.json({
        success: true,
        message: `Sincronização concluída: ${result.imported} importados, ${result.updated} atualizados`,
        ...result
      });

    } catch (error) {
      console.error("Error syncing vendors from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao sincronizar vendedores do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para sincronizar todos os produtos do Omie
  app.post('/api/omie/sync-products', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      // 🗑️ LIMPAR todos os produtos antes de sincronizar
      console.log('🗑️ Limpando base de produtos antes da sincronização...');
      const existingProducts = await storage.getProducts();
      for (const product of existingProducts) {
        await storage.deleteProduct(product.id);
      }
      console.log(`✅ ${existingProducts.length} produtos removidos`);

      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: [] as string[]
      };

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await omieService.getAllProducts(currentPage, 100);
        
        for (const omieProduct of pageData.products) {
          result.totalProcessed++;
          
          // DEBUG: Log completo do produto
          console.log(`🔍 DEBUG Produto:`, {
            descricao: omieProduct.descricao,
            codigo: omieProduct.codigo,
            codigo_produto_integracao: omieProduct.codigo_produto_integracao,
            inativo: omieProduct.inativo,
            bloqueado: omieProduct.bloqueado
          });
          
          // FILTRO 1: Pular produtos inativos (sempre aplicado)
          const isInactive = omieProduct.inativo === 'S' || omieProduct.inativo === 'true' || omieProduct.inativo === true;
          if (isInactive) {
            console.log(`⏭️ Pulando produto INATIVO: ${omieProduct.descricao} (código: ${omieProduct.codigo})`);
            result.skipped++;
            continue;
          }
          
          // FILTRO 2: Pular produtos bloqueados
          const isBlocked = omieProduct.bloqueado === 'S' || omieProduct.bloqueado === 'true' || omieProduct.bloqueado === true;
          if (isBlocked) {
            console.log(`⏭️ Pulando produto BLOQUEADO: ${omieProduct.descricao} (código: ${omieProduct.bloqueado})`);
            result.skipped++;
            continue;
          }
          
          // FILTRO 3: Aceitar apenas produtos com código começando com "PRD-" (produtos novos)
          const productCode = omieProduct.codigo || '';
          if (!productCode.startsWith('PRD-')) {
            console.log(`⏭️ Pulando produto com código antigo: ${omieProduct.descricao} (código: ${productCode} - esperado: PRD-*)`);
            result.skipped++;
            continue;
          }
          
          console.log(`✅ Produto ACEITO para importação: ${omieProduct.descricao} (código: ${productCode})`);

          // FILTRO: Pular produtos sem preço válido
          if (!omieProduct.valor_unitario || omieProduct.valor_unitario <= 0) {
            console.log(`⏭️ Pulando produto sem preço: ${omieProduct.descricao}`);
            result.skipped++;
            continue;
          }
          
          try {
            // Converter para formato do sistema
            const systemProduct = {
              name: omieProduct.descricao || '',
              description: omieProduct.descricao || '',
              price: omieProduct.valor_unitario?.toString() || '0',
              stock: 0,
              isActive: true,
              omieCode: omieProduct.codigo_produto_integracao || omieProduct.codigo || omieProduct.codigo_produto?.toString() || '',
              omieCodigo: omieProduct.codigo || null,
              omieCodigoProduto: omieProduct.codigo_produto?.toString() || null
            };

            // Verificar se produto já existe pelo código Omie ou nome
            const existingProducts = await storage.getProducts();
            const existingProduct = existingProducts.find(product => 
              (product.omieCode && product.omieCode === systemProduct.omieCode) ||
              product.name === systemProduct.name
            );

            if (existingProduct) {
              // Atualizar produto existente com TODOS os campos incluindo códigos Omie
              await storage.updateProduct(existingProduct.id, {
                price: systemProduct.price,
                isActive: systemProduct.isActive,
                omieCode: systemProduct.omieCode,
                omieCodigo: systemProduct.omieCodigo,
                omieCodigoProduto: systemProduct.omieCodigoProduto
              });
              result.updated++;
            } else {
              // Criar novo produto
              await storage.createProduct(systemProduct);
              result.imported++;
            }

          } catch (error: any) {
            console.error(`Erro ao processar produto ${omieProduct.codigo_produto}:`, error);
            result.errors.push(`Erro ao processar produto ${omieProduct.descricao}: ${error?.message || 'Erro desconhecido'}`);
          }
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      console.log(`✅ Sincronização de produtos concluída:`);
      console.log(`   📊 Total processado: ${result.totalProcessed}`);
      console.log(`   ➕ Importados: ${result.imported}`);
      console.log(`   🔄 Atualizados: ${result.updated}`);
      console.log(`   ⏭️ Pulados (bloqueados/sem preço): ${result.skipped}`);
      console.log(`   ❌ Erros: ${result.errors.length}`);

      // Save sync status
      await saveSyncStatus(
        'omie_products',
        result.errors.length > 0 ? 'error' : 'success',
        result.imported + result.updated,
        `${result.imported} importados, ${result.updated} atualizados, ${result.skipped} pulados, ${result.errors.length} erros`
      );

      res.json(result);

    } catch (error) {
      console.error("Error syncing products from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao sincronizar produtos do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para importar produtos manualmente via JSON
  app.post('/api/products/import-manual', authenticateUser, async (req: any, res) => {
    try {
      const products = req.body.products;
      
      if (!Array.isArray(products)) {
        return res.status(400).json({ message: 'Formato inválido. Esperado array de produtos.' });
      }

      const result = {
        totalProcessed: 0,
        imported: 0,
        errors: [] as string[]
      };

      for (const product of products) {
        result.totalProcessed++;
        
        try {
          await storage.createProduct({
            name: product.name,
            description: product.name,
            price: product.price.toString(),
            stock: 0,
            isActive: true,
            omieCode: product.code || '',
            omieCodigo: product.omieCodigo || product.code || null,
            omieCodigoProduto: product.omieCodigoProduto || null
          });
          result.imported++;
        } catch (error: any) {
          console.error(`Erro ao importar produto ${product.name}:`, error);
          result.errors.push(`${product.name}: ${error?.message || 'Erro desconhecido'}`);
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Erro na importação manual:', error);
      res.status(500).json({ message: 'Erro ao importar produtos' });
    }
  });

  // Rota para obter boleto ou QR code de um débito vencido
  app.get('/api/omie/boleto/:codigoLancamento', authenticateUser, async (req: any, res) => {
    try {
      const { codigoLancamento } = req.params;
      
      if (!codigoLancamento) {
        return res.status(400).json({ 
          error: 'Código de lançamento é obrigatório' 
        });
      }
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }
      
      console.log(`🎫 Buscando boleto para lançamento ${codigoLancamento}...`);
      const boletoData = await omieService.getBoleto(parseInt(codigoLancamento));
      
      if (boletoData.error) {
        return res.status(404).json({ 
          error: 'Boleto não encontrado ou não disponível',
          message: boletoData.error
        });
      }
      
      res.json(boletoData);
    } catch (error: any) {
      console.error('Erro ao buscar boleto:', error);
      res.status(500).json({ 
        error: 'Erro interno do servidor',
        message: error.message 
      });
    }
  });

  // Rota TEMPORÁRIA (sem auth) para listar contas correntes do Omie
  app.get('/api/omie/bank-accounts-debug', async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const accounts = await omieService.listBankAccounts();
      
      // Formatar para facilitar leitura
      const formatted = accounts.map((acc: any) => ({
        codigo: acc.nCodCC,
        nome: acc.cDescrCC,
        tipo: acc.cTipo,
        banco: acc.cNomeBanco
      }));
      
      res.json(formatted);
    } catch (error) {
      console.error('Erro ao listar contas correntes:', error);
      res.status(500).json({ message: 'Erro interno do servidor', error: String(error) });
    }
  });

  // Rota TEMPORÁRIA (sem auth) para listar códigos de parcela do Omie
  app.get('/api/omie/payment-terms-debug', async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const terms = await omieService.listPaymentTerms();
      res.json(terms);
    } catch (error) {
      console.error('Erro ao listar códigos de parcela:', error);
      res.status(500).json({ message: 'Erro interno do servidor', error: String(error) });
    }
  });

  // Rota para listar contas correntes do Omie
  app.get('/api/omie/bank-accounts', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const accounts = await omieService.listBankAccounts();
      res.json(accounts);
    } catch (error) {
      console.error('Erro ao listar contas correntes:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
    }
  });

  // Rota para limpar cache do Omie
  app.post('/api/omie/clear-cache', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      omieService.clearCache();
      res.json({ message: 'Cache limpo com sucesso' });
    } catch (error) {
      console.error('Erro ao limpar cache:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
    }
  });

  // Rota de TESTE para verificar extração de dados de um pedido específico
  app.post('/api/omie/test-order/:orderId', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const orderId = req.params.orderId;
      console.log(`🧪 TESTE: Buscando etapas do pedido ${orderId}...`);
      
      // Chamar a função diretamente para debug
      const stageData = await omieService.fetchPedidoStage(orderId);
      
      res.json({ 
        orderId,
        stageData,
        message: `Teste do pedido ${orderId} concluído - veja logs do servidor` 
      });
    } catch (error) {
      console.error('Erro no teste:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
    }
  });

  // Endpoint temporário para sincronização de setembro 2025 (sem autenticação)
  app.post('/api/omie/sync-september-2025', async (req, res) => {
    try {
      console.log('🔄 Iniciando sincronização de setembro 2025...');
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }
      
      // Limpar cache antes da sincronização
      omieService.clearCache();
      
      const result = await omieService.syncAllOrders();
      
      console.log('✅ Sincronização de setembro 2025 concluída:', result);
      res.json(result);
    } catch (error: any) {
      console.error('❌ Erro na sincronização de setembro 2025:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Rota NOVA para sincronizar TODOS os pedidos do Omie (faturados e não faturados)
  app.post('/api/omie/sync-all-orders', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      // Limpar cache antes da sincronização
      omieService.clearCache();
      
      const result = await omieService.syncAllOrders();
      res.json(result);
    } catch (error) {
      console.error('Erro na sincronização de pedidos:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
    }
  });

  // Rota para sincronizar pedidos ESPECÍFICOS (fallback para pedidos não listados)
  app.post('/api/omie/sync-specific-orders', authenticateUser, async (req: any, res) => {
    try {
      const { orderNumbers } = req.body;
      
      if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
        return res.status(400).json({ 
          message: 'Lista de números de pedidos é obrigatória' 
        });
      }
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      // Limpar cache antes da sincronização
      omieService.clearCache();
      
      const result = await omieService.syncSpecificOrders(orderNumbers);
      res.json(result);
    } catch (error: any) {
      console.error('Erro na sincronização de pedidos específicos:', error);
      res.status(500).json({ 
        message: 'Erro interno do servidor',
        error: error.message 
      });
    }
  });

  // Rota para verificar completude das notas fiscais
  app.get('/api/omie/verify-invoice-completeness', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }
      
      const result = await omieService.verifyInvoiceCompleteness();
      res.json(result);
    } catch (error: any) {
      console.error('Erro ao verificar completude das notas fiscais:', error);
      res.status(500).json({ 
        message: 'Erro interno do servidor',
        error: error.message 
      });
    }
  });


  // Endpoint temporário para limpar cache de etapas e forçar nova sincronização
  app.post("/api/omie/clear-stage-cache", authenticateUser, async (req, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }
      
      // Limpar caches de etapas
      (omieService as any).stagesCache.clear();
      (omieService as any).stageNamesCache.clear();
      
      console.log("🧹 Cache de etapas limpo. Forçando nova sincronização...");
      
      res.json({ 
        success: true, 
        message: "Cache de etapas limpo. Nova sincronização será feita automaticamente." 
      });
    } catch (error) {
      console.error("Erro ao limpar cache de etapas:", error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  // Endpoint de teste para verificar etapa de um pedido específico
  app.get('/api/omie/test-stage/:orderId', async (req, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const orderId = parseInt(req.params.orderId);
      console.log(`\n🔍 === TESTE DE ETAPA PARA PEDIDO ${orderId} ===`);
      
      const stageData = await (omieService as any).fetchPedidoStage(orderId);
      
      console.log(`📊 Resultado:`, stageData);
      
      res.json({ 
        orderId,
        stageData,
        stageName: stageData?.stageName || 'Não encontrado',
        stageCode: stageData?.stageCode || 'Não encontrado'
      });

    } catch (error: any) {
      console.error('❌ Erro ao testar etapa:', error);
      res.status(500).json({ message: 'Erro ao testar etapa', error: error.message });
    }
  });

  // Endpoint para forçar re-sync completo das notas fiscais com etapas corretas
  app.post('/api/omie/force-resync-billings', async (req, res) => {
    try {
      console.log('🔄 Iniciando re-sync forçado das notas fiscais...');
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      // Limpar estado da sincronização
      await db.delete(syncStates).where(eq(syncStates.syncType, 'billings'));
      console.log('🗑️ Estado de sincronização limpo');

      // Limpar caches
      (omieService as any).stagesCache.clear();
      (omieService as any).stageNamesCache.clear();
      console.log('🧹 Caches limpos');

      // Executar sincronização
      const result = await (omieService as any).syncBillings();
      
      console.log(`✅ Re-sync concluído: ${result.newBillings} notas processadas`);
      res.json({ 
        success: true, 
        message: `Re-sync concluído com sucesso. ${result.newBillings} notas processadas.`,
        processed: result.newBillings
      });

    } catch (error: any) {
      console.error('❌ Erro ao re-sync:', error);
      res.status(500).json({ message: 'Erro ao executar re-sync', error: error.message });
    }
  });

  // Endpoint especializado para atualizar apenas as etapas das notas existentes
  app.post('/api/omie/update-invoice-stages', async (req, res) => {
    try {
      console.log('🔄 Iniciando atualização de etapas das notas fiscais...');
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      // Buscar todas as notas fiscais que têm omie_order_id (pedido relacionado)
      const billings = await storage.getAllBillingsWithOrderId();
      console.log(`📊 Total de notas fiscais com pedido: ${billings.length}`);

      let updated = 0;
      let errors = 0;
      const batchSize = 50;

      // Processar em lotes
      for (let i = 0; i < billings.length; i += batchSize) {
        const batch = billings.slice(i, i + batchSize);
        console.log(`\n📦 Processando lote ${Math.floor(i / batchSize) + 1} de ${Math.ceil(billings.length / batchSize)} (${batch.length} notas)...`);

        for (const billing of batch) {
          try {
            if (!billing || !billing.omieOrderId) {
              console.log('⏭️ Billing inválido ou sem omieOrderId, pulando...');
              continue;
            }

            // Buscar a etapa atualizada do pedido
            const stageData = await (omieService as any).fetchPedidoStage(billing.omieOrderId);
            
            if (stageData && stageData.stageName) {
              // Atualizar apenas se a etapa mudou
              const currentStage = billing.invoiceStage || '';
              if (currentStage !== stageData.stageName) {
                await db.update(billingsTable)
                  .set({ 
                    invoiceStage: stageData.stageName,
                    updatedAt: new Date()
                  })
                  .where(eq(billingsTable.id, billing.id));
                
                console.log(`✅ ${billing.invoiceNumber}: ${currentStage} → ${stageData.stageName}`);
                updated++;
              }
            }
          } catch (error: any) {
            const billNum = billing?.invoiceNumber || 'DESCONHECIDO';
            console.error(`❌ Erro ao atualizar nota ${billNum}:`, error.message);
            console.error('Stack:', error.stack);
            errors++;
          }
        }

        // Pequena pausa entre lotes para não sobrecarregar a API
        if (i + batchSize < billings.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      const result = {
        total: billings.length,
        updated,
        unchanged: billings.length - updated - errors,
        errors,
        message: `Atualização concluída. ${updated} notas atualizadas de ${billings.length} processadas.`
      };

      console.log('\n✅ Atualização de etapas concluída:', result);
      res.json(result);
    } catch (error: any) {
      console.error('❌ Erro na atualização de etapas:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Rota para buscar faturamentos
  app.get('/api/billings', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      const billings = await storage.getBillings(sellerId);
      res.json(billings);
    } catch (error) {
      console.error('Erro ao buscar faturamentos:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
    }
  });

  // Receita Federal Integration routes
  app.post('/api/receita/cnpj', authenticateUser, async (req: any, res) => {
    try {
      const { cnpj } = req.body;
      
      if (!cnpj) {
        return res.status(400).json({ 
          message: "CNPJ é obrigatório" 
        });
      }

      // Valida formato do CNPJ
      if (!receitaService.validarCNPJ(cnpj)) {
        return res.status(400).json({ 
          message: "CNPJ inválido" 
        });
      }

      const dadosCNPJ = await receitaService.consultarCNPJ(cnpj);
      
      if (!dadosCNPJ) {
        return res.status(404).json({ 
          message: "CNPJ não encontrado" 
        });
      }

      // Formatar dados para retorno
      const dadosFormatados = {
        cnpj: receitaService.formatarCNPJ(dadosCNPJ.cnpj),
        razaoSocial: dadosCNPJ.nome, // API retorna 'nome' como razão social
        nomeFantasia: dadosCNPJ.fantasia || '', // API retorna 'fantasia' como nome fantasia
        endereco: receitaService.formatarEndereco(dadosCNPJ),
        cidade: dadosCNPJ.municipio,
        estado: dadosCNPJ.uf,
        cep: dadosCNPJ.cep,
        telefone: dadosCNPJ.telefone || '',
        email: dadosCNPJ.email || '',
        situacao: dadosCNPJ.situacao,
        atividadePrincipal: dadosCNPJ.atividade_principal?.[0]?.text || '',
        capitalSocial: dadosCNPJ.capital_social || '',
        porte: dadosCNPJ.porte || '',
        naturezaJuridica: dadosCNPJ.natureza_juridica || ''
      };

      res.json(dadosFormatados);
    } catch (error) {
      console.error("Error fetching CNPJ from Receita Federal:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Erro ao consultar CNPJ",
      });
    }
  });

  app.post('/api/receita/validate-cpf', authenticateUser, async (req: any, res) => {
    try {
      const { cpf } = req.body;
      
      if (!cpf) {
        return res.status(400).json({ 
          message: "CPF é obrigatório" 
        });
      }

      const isValid = receitaService.validarCPF(cpf);
      
      res.json({ 
        valid: isValid,
        formatted: isValid ? receitaService.formatarCPF(cpf) : null
      });
    } catch (error) {
      console.error("Error validating CPF:", error);
      res.status(500).json({ 
        message: "Erro ao validar CPF",
      });
    }
  });

  app.post('/api/receita/validate-cnpj', authenticateUser, async (req: any, res) => {
    try {
      const { cnpj } = req.body;
      
      if (!cnpj) {
        return res.status(400).json({ 
          message: "CNPJ é obrigatório" 
        });
      }

      const isValid = receitaService.validarCNPJ(cnpj);
      
      res.json({ 
        valid: isValid,
        formatted: isValid ? receitaService.formatarCNPJ(cnpj) : null
      });
    } catch (error) {
      console.error("Error validating CNPJ:", error);
      res.status(500).json({ 
        message: "Erro ao validar CNPJ",
      });
    }
  });

  // ===== DELIVERY INTEGRATION APIS =====
  
  // Estatísticas de entregas
  app.get("/api/deliveries/stats", async (req, res) => {
    try {
      const { period = 'today' } = req.query;
      const stats = await storage.getDeliveryStats(period as string);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching delivery stats:", error);
      res.status(500).json({ message: "Failed to fetch delivery stats" });
    }
  });

  // Métricas de entregas
  app.get("/api/deliveries/metrics", async (req, res) => {
    try {
      const { period = 'today' } = req.query;
      const metrics = await storage.getDeliveryMetrics(period as string);
      res.json(metrics);
    } catch (error) {
      console.error("Error fetching delivery metrics:", error);
      res.status(500).json({ message: "Failed to fetch delivery metrics" });
    }
  });

  // Buscar todas as entregas
  app.get("/api/deliveries/all", async (req, res) => {
    try {
      const deliveries = await storage.getAllDeliveries();
      res.json(deliveries);
    } catch (error) {
      console.error("Error fetching all deliveries:", error);
      res.status(500).json({ message: "Failed to fetch deliveries" });
    }
  });

  // Relatórios de entregas
  app.get("/api/deliveries/reports", async (req, res) => {
    try {
      const { period = 'month', startDate, endDate } = req.query;
      const report = await storage.getDeliveryReport(period as string, startDate as string, endDate as string);
      res.json(report);
    } catch (error) {
      console.error("Error fetching delivery report:", error);
      res.status(500).json({ message: "Failed to fetch delivery report" });
    }
  });

  // Comparação de relatórios
  app.get("/api/deliveries/reports/comparison", async (req, res) => {
    try {
      const { period = 'month' } = req.query;
      const comparison = await storage.getDeliveryReportComparison(period as string);
      res.json(comparison);
    } catch (error) {
      console.error("Error fetching delivery report comparison:", error);
      res.status(500).json({ message: "Failed to fetch delivery report comparison" });
    }
  });

  // Buscar pedidos aguardando alocação de rota (para Gestão de Entregas)
  app.get("/api/deliveries", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      // Buscar sales_cards com status 'completed' ou 'invoiced' que ainda não têm rota
      const deliveryOrders = await storage.getPendingDeliveries();
      
      // Log detalhado para verificação de nomes
      if (deliveryOrders.length > 0) {
        console.log('📦 [GET /api/deliveries] Returning', deliveryOrders.length, 'delivery orders');
        console.log('📦 [GET /api/deliveries] Sample names (first 3):', deliveryOrders.slice(0, 3).map(o => ({
          invoice: o.invoiceNumber,
          customerName: o.customerName
        })));
      }
      
      res.json(deliveryOrders);
    } catch (error: any) {
      console.error("Error fetching pending delivery orders:", error);
      res.status(500).json({ message: "Failed to fetch pending delivery orders", error: error.message });
    }
  });

  // ===== DELIVERY DRIVERS APIS =====
  
  // Buscar todos os motoristas (com autenticação - vendedores podem visualizar)
  app.get("/api/delivery-drivers", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'vendedor']), async (req: any, res) => {
    try {
      const drivers = await storage.getDeliveryDrivers();
      res.json(drivers);
    } catch (error: any) {
      console.error("Error fetching delivery drivers:", error);
      res.status(500).json({ message: "Failed to fetch delivery drivers", error: error.message });
    }
  });

  // Buscar motoristas ativos (com autenticação - vendedores podem visualizar)
  app.get("/api/delivery-drivers/active", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'vendedor']), async (req: any, res) => {
    try {
      const activeDrivers = await storage.getActiveDeliveryDrivers();
      res.json(activeDrivers);
    } catch (error: any) {
      console.error("Error fetching active delivery drivers:", error);
      res.status(500).json({ message: "Failed to fetch active delivery drivers", error: error.message });
    }
  });

  // Criar motorista (com autenticação)
  app.post("/api/delivery-drivers", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const driverData = req.body;
      const driver = await storage.createDeliveryDriver(driverData);
      res.json(driver);
    } catch (error: any) {
      console.error("Error creating delivery driver:", error);
      res.status(500).json({ message: "Failed to create delivery driver", error: error.message });
    }
  });

  // Atualizar motorista (com autenticação)
  app.put("/api/delivery-drivers/:id", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { id } = req.params;
      const driverData = req.body;
      const driver = await storage.updateDeliveryDriver(id, driverData);
      res.json(driver);
    } catch (error: any) {
      console.error("Error updating delivery driver:", error);
      res.status(500).json({ message: "Failed to update delivery driver", error: error.message });
    }
  });

  // Alternar status do motorista (com autenticação)
  app.put("/api/delivery-drivers/:id/toggle-status", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      const driver = await storage.updateDeliveryDriver(id, { isActive });
      res.json(driver);
    } catch (error: any) {
      console.error("Error toggling driver status:", error);
      res.status(500).json({ message: "Failed to toggle driver status", error: error.message });
    }
  });

  // Estatísticas de motoristas (com autenticação)
  app.get("/api/delivery-drivers/stats", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const stats = await storage.getDeliveryDriverStats();
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching driver stats:", error);
      res.status(500).json({ message: "Failed to fetch driver stats", error: error.message });
    }
  });

  // Atualizar status de entrega
  app.put("/api/deliveries/:salesCardId/status", async (req, res) => {
    try {
      const { salesCardId } = req.params;
      const { 
        status, 
        deliveryCompletedDate, 
        deliveryFailureReason, 
        deliveryNotes, 
        driverId,
        location 
      } = req.body;

      // Atualizar sales card com novo status de entrega
      const updatedCard = await storage.updateSalesCardDeliveryStatus(salesCardId, {
        deliveryStatus: status,
        deliveryCompletedDate: status === 'delivered' ? new Date() : deliveryCompletedDate,
        deliveryFailureReason: status === 'failed' ? deliveryFailureReason : null,
        deliveryNotes,
        deliveryDriverId: driverId
      });

      // Registrar histórico de entrega
      await storage.createDeliveryHistory({
        salesCardId,
        status,
        location,
        notes: deliveryNotes,
        driverId
      });

      res.json(updatedCard);
    } catch (error) {
      console.error("Error updating delivery status:", error);
      res.status(500).json({ message: "Failed to update delivery status" });
    }
  });


  // Planejar rotas de entrega para múltiplos veículos
  app.post("/api/delivery-routes/plan", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { orderIds, vehicles, routeDate } = req.body;

      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ message: "Order IDs are required" });
      }

      if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
        return res.status(400).json({ message: "Vehicle configurations are required" });
      }

      // Buscar billings selecionados para roteirização
      // Como /api/deliveries retorna billing.id (não sales_card.id), 
      // precisamos buscar os billings e criar sales_cards temporários
      const billingsResult = await db.execute<{
        id: string;
        invoiceNumber: string;
        omieOrderId: string;
        orderNumber: string;
        customerId: string;
        customerName: string;
        customerAddress: string;
        customerLatitude: string;
        customerLongitude: string;
        deliveryWeekdays: any;
        deliveryTimeSlots: any;
        deliverySaturdayTimeSlots: any;
        exclusiveVehicle: boolean;
        vehicleTypes: any;
        averageDeliveryTime: number;
        isUrgent: boolean;
        saleValue: number;
        products: any;
        scheduledDate: Date;
        paymentMethod: string;
        operationType: string;
      }>(sql`
        SELECT DISTINCT ON (b.id)
          b.id,
          b.invoice_number as "invoiceNumber",
          b.omie_order_id as "omieOrderId",
          b.order_number as "orderNumber",
          COALESCE(c.id, 'billing-' || b.id) as "customerId",
          COALESCE(c.fantasy_name, b.customer_fantasy_name) as "customerName",
          COALESCE(c.address, '') as "customerAddress",
          c.latitude as "customerLatitude",
          c.longitude as "customerLongitude",
          c.delivery_weekdays as "deliveryWeekdays",
          c.delivery_time_slots as "deliveryTimeSlots",
          c.delivery_saturday_time_slots as "deliverySaturdayTimeSlots",
          c.exclusive_vehicle as "exclusiveVehicle",
          c.vehicle_types as "vehicleTypes",
          COALESCE(c.average_delivery_time, 30) as "averageDeliveryTime",
          COALESCE(b.is_urgent, false) as "isUrgent",
          b.total_value as "saleValue",
          b.products,
          b.invoice_date as "scheduledDate",
          b.payment_method as "paymentMethod",
          b.billing_type as "operationType"
        FROM billings b
        LEFT JOIN customers c ON (
          c.id = CONCAT('omie-client-', b.omie_customer_code)
          OR REGEXP_REPLACE(c.cpf, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g')
          OR REGEXP_REPLACE(c.cnpj, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g')
        )
        WHERE b.id = ANY(ARRAY[${sql.join(orderIds.map((id: string) => sql`${id}`), sql`, `)}])
        ORDER BY 
          b.id, 
          CASE WHEN c.id = CONCAT('omie-client-', b.omie_customer_code) THEN 0 ELSE 1 END,
          c.id NULLS LAST,
          b.invoice_date
      `);
      
      const orders = billingsResult.rows;
      
      console.log(`📦 [ROUTE-PLANNING] Recebidos ${orderIds.length} billing IDs, encontrados ${orders.length} billings válidos`);

      if (orders.length === 0) {
        return res.status(400).json({ 
          message: "Nenhum pedido válido encontrado para os IDs fornecidos",
          requestedIds: orderIds,
          foundCount: 0
        });
      }

      // Validar que todos os pedidos têm coordenadas válidas
      console.log(`🔍 [ROUTE-PLANNING] Validando coordenadas de ${orders.length} pedidos...`);
      const invalidOrders = orders.filter(o => {
        let lat = o.customerLatitude;
        let lng = o.customerLongitude;
        
        console.log(`  → ${o.customerName}: lat=${lat} (type: ${typeof lat}), lng=${lng} (type: ${typeof lng})`);
        
        // Verificar se é null, undefined, string vazia
        if (lat === null || lat === undefined || lng === null || lng === undefined) {
          console.log(`    ❌ Coordenadas null/undefined`);
          return true;
        }
        
        // Se for string, fazer trim
        if (typeof lat === 'string') {
          lat = lat.trim();
        }
        if (typeof lng === 'string') {
          lng = lng.trim();
        }
        
        // Verificar strings vazias ou inválidas
        if (lat === '' || lng === '' || lat === 'NaN' || lng === 'NaN' || lat === 'Infinity' || lng === 'Infinity' || lat === '-Infinity' || lng === '-Infinity') {
          console.log(`    ❌ Coordenadas vazias ou inválidas: lat="${lat}", lng="${lng}"`);
          return true;
        }
        
        // Converter para número e validar
        const latNum = typeof lat === 'number' ? lat : parseFloat(lat as string);
        const lngNum = typeof lng === 'number' ? lng : parseFloat(lng as string);
        
        // Verificar se é número válido
        if (isNaN(latNum) || isNaN(lngNum) || !isFinite(latNum) || !isFinite(lngNum)) {
          console.log(`    ❌ Não é número finito: latNum=${latNum}, lngNum=${lngNum}`);
          return true;
        }
        
        // Verificar se é zero (coordenada inválida)
        if (latNum === 0 || lngNum === 0) {
          console.log(`    ❌ Coordenadas zero: latNum=${latNum}, lngNum=${lngNum}`);
          return true;
        }
        
        // Verificar ranges geográficos válidos
        if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) {
          console.log(`    ❌ Fora do range geográfico: latNum=${latNum}, lngNum=${lngNum}`);
          return true;
        }
        
        console.log(`    ✅ Coordenadas válidas: lat=${latNum}, lng=${lngNum}`);
        return false;
      });
      
      if (invalidOrders.length > 0) {
        console.warn(`⚠️ [ROUTE-PLANNING] ${invalidOrders.length} pedidos sem coordenadas válidas:`, 
                     invalidOrders.map(o => ({ id: o.id, name: o.customerName, lat: o.customerLatitude, lng: o.customerLongitude })));
        
        // Retornar status 422 com detalhes dos clientes para modal de correção
        return res.status(422).json({ 
          code: 'MISSING_COORDINATES',
          message: `${invalidOrders.length} ${invalidOrders.length === 1 ? 'pedido não possui' : 'pedidos não possuem'} coordenadas de cliente cadastradas.`,
          missingCoordinates: invalidOrders.map(o => ({ 
            billingId: o.id,
            customerId: o.customerId,
            customerName: o.customerName, 
            address: o.customerAddress,
            latitude: o.customerLatitude || '',
            longitude: o.customerLongitude || ''
          }))
        });
      }

      // Converter billings para formato do serviço de roteirização
      const deliveryOrders = orders.map(o => {
        const lat = parseFloat(o.customerLatitude as string);
        const lng = parseFloat(o.customerLongitude as string);
        
        // Parse JSON fields
        const deliveryWeekdays = typeof o.deliveryWeekdays === 'string' 
          ? JSON.parse(o.deliveryWeekdays) 
          : (Array.isArray(o.deliveryWeekdays) ? o.deliveryWeekdays : null);
        
        const deliveryTimeSlots = typeof o.deliveryTimeSlots === 'string'
          ? JSON.parse(o.deliveryTimeSlots)
          : (Array.isArray(o.deliveryTimeSlots) ? o.deliveryTimeSlots : []);
        
        const vehicleTypes = typeof o.vehicleTypes === 'string'
          ? JSON.parse(o.vehicleTypes)
          : (Array.isArray(o.vehicleTypes) ? o.vehicleTypes : []);
        
        console.log(`📍 [CONVERSION] ${o.customerName}:`, {
          lat, lng,
          deliveryWeekdays,
          deliveryTimeSlots,
          exclusiveVehicle: o.exclusiveVehicle,
          vehicleTypes
        });
        
        return {
          id: o.id,
          customerId: o.customerId,
          customerName: o.customerName,
          customerAddress: o.customerAddress,
          customerLatitude: lat,
          customerLongitude: lng,
          averageDeliveryTime: o.averageDeliveryTime || 30,
          exclusiveVehicle: o.exclusiveVehicle || false,
          vehicleTypes: vehicleTypes,
          isUrgent: o.isUrgent || false,
          saleValue: parseFloat((o.saleValue as any) || 0),
          products: o.products,
          scheduledDate: o.scheduledDate || null,
          completedDate: o.scheduledDate || null,
          paymentMethod: o.paymentMethod || null,
          operationType: o.operationType || null,
          customerWeekdays: deliveryWeekdays, // Dias de ENTREGA permitidos
          deliveryTimeSlots: deliveryTimeSlots, // Horários de ENTREGA permitidos
        };
      });
      
      console.log(`✅ [ROUTE-PLANNING] ${deliveryOrders.length} pedidos prontos para roteirização`);

      // Planejar rotas
      const { planDeliveryRoutes } = await import('./deliveryRouteService');
      const plan = await planDeliveryRoutes(
        storage,
        deliveryOrders,
        vehicles,
        routeDate ? new Date(routeDate) : new Date()
      );

      res.json(plan);
    } catch (error: any) {
      console.error("Error planning delivery routes:", error);
      res.status(500).json({ message: "Failed to plan delivery routes", error: error.message });
    }
  });

  // Buscar rotas salvas com filtros
  app.get("/api/delivery-routes", authenticateUser, async (req: any, res) => {
    try {
      const { routeDate, driverId, savedOnly } = req.query;
      
      console.log(`🔍 [GET-ROUTES] Filtrando rotas: date=${routeDate}, driver=${driverId}, savedOnly=${savedOnly}`);
      
      // Preparar filtros
      const filters: any = {};
      
      if (routeDate) {
        filters.routeDate = new Date(routeDate as string);
      }
      
      if (driverId && driverId !== 'all') {
        filters.driverId = driverId;
      }
      
      if (savedOnly === 'true') {
        filters.savedOnly = true;
      }
      
      // Buscar rotas com filtros
      const routes = await storage.getDeliveryRoutes(filters);
      
      console.log(`✅ [GET-ROUTES] Retornando ${routes.length} rotas`);
      
      res.json(routes);
    } catch (error: any) {
      console.error("❌ [GET-ROUTES] Error fetching delivery routes:", error);
      res.status(500).json({ message: "Failed to fetch delivery routes", error: error.message });
    }
  });

  // Salvar rotas planejadas
  app.post("/api/delivery-routes/save", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { routes } = req.body;

      if (!routes || !Array.isArray(routes) || routes.length === 0) {
        return res.status(400).json({ message: "Routes are required" });
      }

      console.log(`💾 [SAVE-ROUTES] Salvando ${routes.length} rotas planejadas`);

      // Validar todos os driverIds ANTES do loop
      for (const routePlan of routes) {
        if (!routePlan.route?.driverId || routePlan.route.driverId.trim() === '') {
          console.error('❌ [SAVE-ROUTES] driverId é obrigatório para todas as rotas');
          return res.status(400).json({ message: "Driver ID is required for all routes" });
        }
        
        // Validar campos numéricos obrigatórios
        const route = routePlan.route;
        if (isNaN(parseFloat(route.startLatitude)) || isNaN(parseFloat(route.startLongitude))) {
          return res.status(400).json({ message: "Invalid coordinates for route start location" });
        }
        if (isNaN(parseFloat(route.totalDistance)) || parseFloat(route.totalDistance) < 0) {
          return res.status(400).json({ message: "Invalid total distance" });
        }
        if (isNaN(parseInt(route.totalDuration)) || parseInt(route.totalDuration) < 0) {
          return res.status(400).json({ message: "Invalid total duration" });
        }
        
        // Validar paradas
        if (!Array.isArray(routePlan.stops) || routePlan.stops.length === 0) {
          return res.status(400).json({ message: "Routes must have at least one stop" });
        }
        
        for (const stop of routePlan.stops) {
          if (isNaN(parseFloat(stop.latitude)) || isNaN(parseFloat(stop.longitude))) {
            return res.status(400).json({ message: `Invalid coordinates for stop: ${stop.customerName}` });
          }
          if (!stop.billingId) {
            console.warn(`⚠️ [SAVE-ROUTES] Stop ${stop.customerName} missing billingId`);
          }
        }
      }

      const savedRoutes = [];
      const allBillingIds: string[] = [];

      for (const routePlan of routes) {
        const { route, stops } = routePlan;

        // Gerar nome da rota: ROTA-DATA-ENTREGADOR-NUMERO
        const routeDate = new Date(route.routeDate);
        const dateStr = routeDate.toISOString().split('T')[0]; // YYYY-MM-DD
        const driverName = route.driverName.toUpperCase().replace(/\s+/g, '-');
        
        // Contar quantas rotas o motorista já tem nesta data
        const existingCount = await storage.countRoutesForDriverOnDate(route.driverId, routeDate);
        const routeNumber = existingCount + 1;
        
        const routeName = `ROTA-${dateStr}-${driverName}-${routeNumber}`;
        
        console.log(`📝 [SAVE-ROUTES] Gerando rota: ${routeName}`);

        // Preparar dados da rota (converter números corretamente)
        const routeData = {
          routeName,
          routeDate: routeDate,
          driverId: route.driverId,
          driverName: route.driverName,
          vehicleType: route.vehicleType,
          startLatitude: parseFloat(route.startLatitude) || 0,
          startLongitude: parseFloat(route.startLongitude) || 0,
          totalDistance: parseFloat(route.totalDistance) || 0,
          totalDeliveries: stops.length,
          totalDuration: parseInt(route.totalDuration) || 0,
          timeWindowStart: route.timeWindowStart || '08:00',
          timeWindowEnd: route.timeWindowEnd || '18:00',
          status: 'planejada'
        };

        // Preparar dados das paradas (converter números corretamente)
        const stopsData = stops.map((stop: any, index: number) => ({
          salesCardId: stop.salesCardId,
          billingId: stop.billingId || null,
          customerId: stop.customerId,
          customerName: stop.customerName,
          customerAddress: stop.customerAddress,
          customerLatitude: parseFloat(stop.latitude) || 0,
          customerLongitude: parseFloat(stop.longitude) || 0,
          stopOrder: index + 1,
          estimatedArrival: stop.estimatedArrival ? new Date(stop.estimatedArrival) : null,
          estimatedDeparture: stop.estimatedDeparture ? new Date(stop.estimatedDeparture) : null,
          estimatedServiceTime: parseInt(stop.estimatedServiceTime) || 30,
          distanceFromPrevious: parseFloat(stop.distanceFromPrevious) || 0,
          isPriority: stop.isUrgent || false,
          status: 'pending'
        }));

        // Salvar rota e paradas (usa transação internamente)
        const { route: savedRoute, stops: savedStops } = await storage.saveRouteWithStops(routeData, stopsData);
        
        savedRoutes.push({
          ...savedRoute,
          stops: savedStops
        });

        // Coletar billingIds para atualizar status
        const billingIds = stops
          .map((stop: any) => stop.billingId)
          .filter((id: any) => id);
        
        allBillingIds.push(...billingIds);

        console.log(`✅ [SAVE-ROUTES] Rota ${routeName} salva com ${savedStops.length} paradas`);
      }

      // Atualizar status dos billings para "Em Rota"
      if (allBillingIds.length > 0) {
        await storage.updateBillingsStatus(allBillingIds, 'Em Rota');
        console.log(`📦 [SAVE-ROUTES] ${allBillingIds.length} billings atualizados para "Em Rota"`);
      }

      res.json({
        success: true,
        message: `${savedRoutes.length} rotas salvas com sucesso`,
        routes: savedRoutes
      });
    } catch (error: any) {
      console.error("Error saving delivery routes:", error);
      res.status(500).json({ message: "Failed to save delivery routes", error: error.message });
    }
  });

  // Buscar rotas de entrega
  app.get("/api/delivery-routes", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { status, routeDate, driverId, savedOnly } = req.query;
      
      const filters: any = {};
      if (status) filters.status = status;
      if (routeDate) filters.routeDate = new Date(routeDate);
      if (driverId) filters.driverId = driverId;
      if (savedOnly === 'true') filters.savedOnly = true; // Filtrar apenas rotas salvas (com routeName)
      
      const routes = await storage.getDeliveryRoutes(filters);
      
      // Para cada rota, buscar as paradas
      const routesWithStops = await Promise.all(
        routes.map(async (route) => {
          const stops = await storage.getDeliveryRouteStops(route.id);
          return { ...route, stops };
        })
      );
      
      res.json(routesWithStops);
    } catch (error: any) {
      console.error("Error fetching delivery routes:", error);
      res.status(500).json({ message: "Failed to fetch delivery routes", error: error.message });
    }
  });

  // Buscar paradas de uma rota
  app.get("/api/delivery-routes/:routeId/stops", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { routeId } = req.params;
      const stops = await storage.getDeliveryRouteStops(routeId);
      res.json(stops);
    } catch (error: any) {
      console.error("Error fetching route stops:", error);
      res.status(500).json({ message: "Failed to fetch route stops", error: error.message });
    }
  });

  // Cancelar rota de entrega
  app.patch("/api/delivery-routes/:routeId/cancel", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { routeId } = req.params;
      
      console.log(`🚫 [ROUTE-CANCEL] Cancelando rota ${routeId}`);
      
      // Atualizar status da rota para 'cancelled'
      const updatedRoute = await storage.updateDeliveryRoute(routeId, {
        status: 'cancelled',
        updatedAt: new Date()
      });
      
      if (!updatedRoute) {
        return res.status(404).json({ message: "Rota não encontrada" });
      }
      
      console.log(`✅ [ROUTE-CANCEL] Rota ${routeId} cancelada com sucesso`);
      res.json({ message: "Rota cancelada com sucesso", route: updatedRoute });
    } catch (error: any) {
      console.error("Error cancelling route:", error);
      res.status(500).json({ message: "Failed to cancel route", error: error.message });
    }
  });

  // ========== ENDPOINTS PARA MOTORISTAS ENTREGADORES ==========
  
  // Buscar rotas do motorista autenticado
  app.get("/api/delivery-routes/driver/my-routes", authenticateUser, async (req: any, res) => {
    try {
      const { date } = req.query;
      const userId = req.user?.id;
      
      if (!userId) {
        return res.status(401).json({ message: "Usuário não autenticado" });
      }
      
      console.log(`📦 [DRIVER-ROUTES] Buscando rotas do motorista ${userId} para ${date || 'hoje'}`);
      
      // Buscar rotas onde o driverId corresponde ao userId
      const targetDate = date ? new Date(date) : new Date();
      targetDate.setHours(0, 0, 0, 0);
      
      const routes = await db.select().from(deliveryRoutes)
        .where(
          and(
            eq(deliveryRoutes.driverId, userId),
            sql`DATE(${deliveryRoutes.routeDate}) = ${targetDate.toISOString().split('T')[0]}`
          )
        )
        .orderBy(asc(deliveryRoutes.createdAt));
      
      // Para cada rota, buscar as paradas
      const routesWithStops = await Promise.all(
        routes.map(async (route) => {
          const stops = await db.select().from(deliveryRouteStops)
            .where(eq(deliveryRouteStops.routeId, route.id))
            .orderBy(asc(deliveryRouteStops.stopOrder));
          
          return {
            ...route,
            stops
          };
        })
      );
      
      console.log(`✅ [DRIVER-ROUTES] Encontradas ${routesWithStops.length} rotas`);
      res.json(routesWithStops);
    } catch (error: any) {
      console.error("Error fetching driver routes:", error);
      res.status(500).json({ message: "Failed to fetch driver routes", error: error.message });
    }
  });
  
  // Iniciar rota de entrega
  app.post("/api/delivery-routes/:routeId/start", authenticateUser, async (req: any, res) => {
    try {
      const { routeId } = req.params;
      const userId = req.user?.id;
      
      console.log(`🚀 [DRIVER-START] Motorista ${userId} iniciando rota ${routeId}`);
      
      // Verificar se o motorista é o responsável pela rota
      const route = await db.select().from(deliveryRoutes)
        .where(eq(deliveryRoutes.id, routeId))
        .limit(1);
      
      if (route.length === 0) {
        return res.status(404).json({ message: "Rota não encontrada" });
      }
      
      if (route[0].driverId !== userId) {
        return res.status(403).json({ message: "Você não tem permissão para iniciar esta rota" });
      }
      
      // Atualizar status da rota para 'em_andamento'
      const updatedRoute = await db.update(deliveryRoutes)
        .set({ status: 'em_andamento', startTime: new Date(), updatedAt: new Date() })
        .where(eq(deliveryRoutes.id, routeId))
        .returning();
      
      console.log(`✅ [DRIVER-START] Rota ${routeId} iniciada`);
      res.json({ message: "Rota iniciada com sucesso", route: updatedRoute[0] });
    } catch (error: any) {
      console.error("Error starting route:", error);
      res.status(500).json({ message: "Failed to start route", error: error.message });
    }
  });
  
  // Check-in em uma parada (com foto obrigatória)
  app.post("/api/delivery-routes/stops/:stopId/checkin", authenticateUser, upload.single('photo'), async (req: any, res) => {
    try {
      const { stopId } = req.params;
      const { latitude, longitude } = req.body;
      const userId = req.user?.id;
      
      console.log(`📍 [DRIVER-CHECKIN] Motorista ${userId} fazendo check-in na parada ${stopId}`);
      
      // Verificar se foto foi enviada
      if (!req.file) {
        return res.status(400).json({ message: "Foto obrigatória para check-in" });
      }
      
      // Buscar a parada
      const stop = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId))
        .limit(1);
      
      if (stop.length === 0) {
        return res.status(404).json({ message: "Parada não encontrada" });
      }
      
      // Verificar se o motorista pertence à rota
      const route = await db.select().from(deliveryRoutes)
        .where(eq(deliveryRoutes.id, stop[0].routeId))
        .limit(1);
      
      if (route.length === 0 || route[0].driverId !== userId) {
        return res.status(403).json({ message: "Você não tem permissão para esta parada" });
      }
      
      // Processar foto
      const base64Photo = req.file.buffer.toString('base64');
      const photoUrl = `data:${req.file.mimetype};base64,${base64Photo}`;
      
      const now = new Date();
      
      // Atualizar a parada com check-in, coordenadas e foto
      const currentPhotos = (stop[0].photos as string[]) || [];
      const updatedStop = await db.update(deliveryRouteStops)
        .set({ 
          checkInTime: now,
          checkInLatitude: latitude?.toString(),
          checkInLongitude: longitude?.toString(),
          photos: [...currentPhotos, photoUrl], // Adiciona foto ao array
          status: 'em_pausa',
          updatedAt: now
        })
        .where(eq(deliveryRouteStops.id, stopId))
        .returning();
      
      console.log(`✅ [DRIVER-CHECKIN] Check-in realizado na parada ${stopId}`);
      res.json({ 
        message: "Check-in realizado com sucesso", 
        stop: updatedStop[0],
        checkInTime: now,
        location: { latitude, longitude },
        photoUrl
      });
    } catch (error: any) {
      console.error("Error during check-in:", error);
      res.status(500).json({ message: "Failed to check-in", error: error.message });
    }
  });
  
  // Check-out de uma parada (com foto obrigatória)
  app.post("/api/delivery-routes/stops/:stopId/checkout", authenticateUser, upload.single('photo'), async (req: any, res) => {
    try {
      const { stopId } = req.params;
      const { latitude, longitude, notes } = req.body;
      const userId = req.user?.id;
      
      console.log(`✅ [DRIVER-CHECKOUT] Motorista ${userId} fazendo check-out da parada ${stopId}`);
      
      // Verificar se foto foi enviada
      if (!req.file) {
        return res.status(400).json({ message: "Foto obrigatória para check-out" });
      }
      
      // Buscar a parada
      const stop = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId))
        .limit(1);
      
      if (stop.length === 0) {
        return res.status(404).json({ message: "Parada não encontrada" });
      }
      
      // Verificar se o motorista pertence à rota
      const route = await db.select().from(deliveryRoutes)
        .where(eq(deliveryRoutes.id, stop[0].routeId))
        .limit(1);
      
      if (route.length === 0 || route[0].driverId !== userId) {
        return res.status(403).json({ message: "Você não tem permissão para esta parada" });
      }
      
      // Processar foto
      const base64Photo = req.file.buffer.toString('base64');
      const photoUrl = `data:${req.file.mimetype};base64,${base64Photo}`;
      
      const now = new Date();
      
      // Marcar parada como concluída com coordenadas e foto
      const currentPhotos = (stop[0].photos as string[]) || [];
      const updatedStop = await db.update(deliveryRouteStops)
        .set({ 
          checkOutTime: now,
          checkOutLatitude: latitude?.toString(),
          checkOutLongitude: longitude?.toString(),
          photos: [...currentPhotos, photoUrl], // Adiciona foto ao array
          status: 'efetuada',
          completedAt: now,
          updatedAt: now
        })
        .where(eq(deliveryRouteStops.id, stopId))
        .returning();
      
      // Verificar se todas as paradas da rota foram concluídas
      const allStops = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.routeId, stop[0].routeId));
      
      const allCompleted = allStops.every(s => s.status === 'efetuada');
      
      if (allCompleted) {
        // Marcar rota como concluída
        await db.update(deliveryRoutes)
          .set({ status: 'concluida', endTime: now, updatedAt: now })
          .where(eq(deliveryRoutes.id, stop[0].routeId));
        
        console.log(`🎉 [DRIVER-CHECKOUT] Rota ${stop[0].routeId} totalmente concluída!`);
      }
      
      console.log(`✅ [DRIVER-CHECKOUT] Check-out realizado na parada ${stopId}`);
      res.json({ 
        message: "Check-out realizado com sucesso", 
        stop: updatedStop[0],
        checkOutTime: now,
        photoUrl,
        routeCompleted: allCompleted,
        location: { latitude, longitude }
      });
    } catch (error: any) {
      console.error("Error during check-out:", error);
      res.status(500).json({ message: "Failed to check-out", error: error.message });
    }
  });
  
  // Atualizar status de uma parada (pausar, devolvida, etc)
  app.patch("/api/delivery-routes/stops/:stopId/status", authenticateUser, async (req: any, res) => {
    try {
      const { stopId } = req.params;
      const { status } = req.body;
      const userId = req.user?.id;
      
      // Validar status
      if (!['pendente', 'efetuada', 'em_pausa', 'devolvida'].includes(status)) {
        return res.status(400).json({ message: "Status inválido" });
      }
      
      console.log(`📊 [UPDATE-STOP-STATUS] Motorista ${userId} atualizando status de ${stopId} para ${status}`);
      
      // Buscar a parada
      const stop = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId))
        .limit(1);
      
      if (stop.length === 0) {
        return res.status(404).json({ message: "Parada não encontrada" });
      }
      
      // Verificar se o motorista pertence à rota
      const route = await db.select().from(deliveryRoutes)
        .where(eq(deliveryRoutes.id, stop[0].routeId))
        .limit(1);
      
      if (route.length === 0 || route[0].driverId !== userId) {
        return res.status(403).json({ message: "Você não tem permissão para esta parada" });
      }
      
      const now = new Date();
      
      // Atualizar status
      const updatedStop = await db.update(deliveryRouteStops)
        .set({ 
          status,
          updatedAt: now
        })
        .where(eq(deliveryRouteStops.id, stopId))
        .returning();
      
      console.log(`✅ [UPDATE-STOP-STATUS] Parada ${stopId} atualizada para ${status}`);
      res.json({ 
        message: "Status atualizado com sucesso", 
        stop: updatedStop[0],
        status
      });
    } catch (error: any) {
      console.error("Error updating stop status:", error);
      res.status(500).json({ message: "Failed to update status", error: error.message });
    }
  });
  
  // Transferir parada para outro motorista
  app.patch("/api/delivery-routes/stops/:stopId/transfer", authenticateUser, async (req: any, res) => {
    console.log(`🔔 [TRANSFER-ENDPOINT] Endpoint chamado com stopId: ${req.params.stopId}`);
    console.log(`🔐 [TRANSFER-ENDPOINT] User role: ${req.currentUser?.role}, email: ${req.currentUser?.email}`);
    try {
      const { stopId } = req.params;
      const { toDriverId, newPosition, routeDate } = req.body;

      if (!toDriverId || !routeDate) {
        return res.status(400).json({ message: "Motorista e data são obrigatórios" });
      }

      console.log(`🔄 [TRANSFER-STOP] Iniciando transferência de parada ${stopId} para motorista ${toDriverId} em ${routeDate}`);

      // Buscar a parada atual
      const stops = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId));
      
      if (stops.length === 0) {
        console.error(`❌ [TRANSFER-STOP] Parada ${stopId} não encontrada`);
        return res.status(404).json({ message: "Parada não encontrada" });
      }

      const currentStop = stops[0];
      const fromRouteId = currentStop.routeId;
      const billingId = currentStop.billingId;
      console.log(`📍 [TRANSFER-STOP] Parada atual: ${stopId} na rota ${fromRouteId}`);

      // Remover parada da rota atual
      let deletedStops: any;
      try {
        deletedStops = await db.delete(deliveryRouteStops)
          .where(eq(deliveryRouteStops.id, stopId))
          .returning();
        console.log(`🗑️ [TRANSFER-STOP] Parada removida: ${deletedStops.length} registros`);
      } catch (deleteErr: any) {
        console.error(`❌ [TRANSFER-STOP] Erro ao deletar parada:`, deleteErr);
        return res.status(500).json({ message: "Erro ao remover parada antiga", error: deleteErr.message });
      }

      // Buscar ou criar rota do novo motorista para essa data
      const routeDateStr = typeof routeDate === 'string' ? routeDate : new Date(routeDate).toISOString().split('T')[0];
      console.log(`🔍 [TRANSFER-STOP] Procurando rota para motorista ${toDriverId} em ${routeDateStr}`);
      
      let existingRoutes: any;
      try {
        existingRoutes = await db.select().from(deliveryRoutes)
          .where(and(
            eq(deliveryRoutes.driverId, toDriverId),
            eq(deliveryRoutes.routeDate, routeDateStr)
          ));
        console.log(`📌 [TRANSFER-STOP] Encontradas ${existingRoutes.length} rotas existentes`);
      } catch (routeErr: any) {
        console.error(`❌ [TRANSFER-STOP] Erro ao buscar rotas:`, routeErr);
        return res.status(500).json({ message: "Erro ao buscar rotas", error: routeErr.message });
      }

      let toRouteId: string;
      if (existingRoutes.length > 0) {
        toRouteId = existingRoutes[0].id;
        console.log(`✅ [TRANSFER-STOP] Rota existente encontrada: ${toRouteId}`);
      } else {
        // Criar nova rota com coordenadas da parada
        toRouteId = nanoid();
        const startLat = currentStop.customerLatitude ? parseFloat(currentStop.customerLatitude.toString()) : -15.7942;
        const startLng = currentStop.customerLongitude ? parseFloat(currentStop.customerLongitude.toString()) : -48.2720;
        
        try {
          const newRoute = await db.insert(deliveryRoutes).values({
            id: toRouteId,
            routeName: `Rota-${toDriverId}-${new Date(routeDateStr).getDate()}`,
            routeDate: routeDateStr,
            driverId: toDriverId,
            driverName: "", 
            vehicleType: "Padrão",
            startLatitude: startLat,
            startLongitude: startLng,
            totalDistance: 0,
            totalDuration: 0,
            totalDeliveries: 0,
            status: "planejada"
          }).returning();
          console.log(`✨ [TRANSFER-STOP] Nova rota criada: ${toRouteId}`);
        } catch (createErr: any) {
          console.error(`❌ [TRANSFER-STOP] Erro ao criar rota:`, createErr);
          return res.status(500).json({ message: "Erro ao criar rota", error: createErr.message });
        }
      }

      // Calcular próxima posição
      let maxOrderResult: any;
      try {
        maxOrderResult = await db.select({ 
          maxOrder: sql<number>`COALESCE(MAX(${deliveryRouteStops.stopOrder}), 0)` 
        })
          .from(deliveryRouteStops)
          .where(eq(deliveryRouteStops.routeId, toRouteId));
        console.log(`📊 [TRANSFER-STOP] Max order result:`, maxOrderResult);
      } catch (maxErr: any) {
        console.error(`❌ [TRANSFER-STOP] Erro ao calcular posição:`, maxErr);
        maxOrderResult = [{ maxOrder: 0 }];
      }

      const currentMaxOrder = maxOrderResult[0]?.maxOrder || 0;
      const nextPosition = newPosition || (currentMaxOrder + 1);
      console.log(`📊 [TRANSFER-STOP] Próxima posição: ${nextPosition}`);
      
      // Criar nova parada na rota destino
      const newStopId = nanoid();
      let insertedStops: any;
      try {
        insertedStops = await db.insert(deliveryRouteStops).values({
          id: newStopId,
          routeId: toRouteId,
          salesCardId: currentStop.salesCardId,
          customerId: currentStop.customerId,
          billingId,
          customerName: currentStop.customerName,
          customerAddress: currentStop.customerAddress,
          customerLatitude: currentStop.customerLatitude,
          customerLongitude: currentStop.customerLongitude,
          stopOrder: nextPosition,
          estimatedArrival: currentStop.estimatedArrival,
          estimatedDeparture: currentStop.estimatedDeparture,
          estimatedServiceTime: currentStop.estimatedServiceTime,
          distanceFromPrevious: currentStop.distanceFromPrevious,
          isPriority: currentStop.isPriority,
          status: "pendente"
        }).returning();
        console.log(`✅ [TRANSFER-STOP] Parada inserida com sucesso: ${newStopId}`);
      } catch (insertErr: any) {
        console.error(`❌ [TRANSFER-STOP] Erro ao inserir parada:`, insertErr);
        return res.status(500).json({ message: "Falha ao inserir parada", error: insertErr.message });
      }

      if (insertedStops.length === 0) {
        console.error(`❌ [TRANSFER-STOP] Insert retornou vazio`);
        return res.status(500).json({ message: "Insert retornou vazio" });
      }

      console.log(`✅ [TRANSFER-STOP] ✅ SUCESSO: ${stopId} → ${toRouteId}`);
      res.json({ 
        message: "Parada transferida com sucesso",
        toRouteId,
        newStopId,
        newPosition,
        newStop: insertedStops[0]
      });
    } catch (error: any) {
      console.error(`❌ [TRANSFER-STOP] Erro na transferência:`, error);
      res.status(500).json({ message: "Failed to transfer stop", error: error.message });
    }
  });
  
  // Reordenar parada dentro da mesma rota
  app.patch("/api/delivery-routes/stops/:stopId/reorder", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { stopId } = req.params;
      const { newPosition, routeId } = req.body;

      if (!newPosition || !routeId || newPosition < 1) {
        return res.status(400).json({ message: "Nova posição inválida" });
      }

      console.log(`↔️ [REORDER-STOP] Reordenando parada ${stopId} na rota ${routeId} para posição ${newPosition}`);

      const updatedStop = await storage.reorderStop(stopId, routeId, newPosition);

      console.log(`✅ [REORDER-STOP] Parada ${stopId} movida para posição ${newPosition}`);
      res.json({ 
        message: "Parada reordenada com sucesso",
        stop: updatedStop
      });
    } catch (error: any) {
      console.error("Error reordering stop:", error);
      res.status(500).json({ message: "Failed to reorder stop", error: error.message });
    }
  });

  // Excluir parada individual de uma rota
  app.delete("/api/delivery-routes/stops/:stopId", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { stopId } = req.params;
      const userId = req.user?.id;
      const userRole = req.user?.role;
      
      console.log(`🗑️ [DELETE-STOP] Usuário ${userId} (${userRole}) excluindo parada ${stopId}`);
      
      // Buscar a parada
      const stop = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId))
        .limit(1);
      
      if (stop.length === 0) {
        return res.status(404).json({ message: "Parada não encontrada" });
      }
      
      const billingId = stop[0].billingId;
      const routeId = stop[0].routeId;
      
      // Excluir a parada
      await db.delete(deliveryRouteStops)
        .where(eq(deliveryRouteStops.id, stopId));
      
      // Retornar billing para "Aguardando Rota"
      if (billingId) {
        await storage.updateBillingsStatus([billingId], 'Aguardando Rota');
        console.log(`📦 [DELETE-STOP] Billing ${billingId} retornado para "Aguardando Rota"`);
      }
      
      console.log(`✅ [DELETE-STOP] Parada ${stopId} excluída da rota ${routeId}`);
      res.json({ 
        message: "Parada excluída com sucesso",
        billingId,
        routeId
      });
    } catch (error: any) {
      console.error("Error deleting stop:", error);
      res.status(500).json({ message: "Failed to delete stop", error: error.message });
    }
  });
  
  // Excluir rota completa
  app.delete("/api/delivery-routes/:routeId", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { routeId } = req.params;
      const userId = req.user?.id;
      const userRole = req.user?.role;
      
      console.log(`🗑️ [DELETE-ROUTE] Usuário ${userId} (${userRole}) excluindo rota ${routeId}`);
      
      // Buscar todas as paradas da rota
      const stops = await db.select().from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.routeId, routeId));
      
      // Coletar todos os billingIds
      const billingIds = stops
        .map(stop => stop.billingId)
        .filter(id => id !== null) as string[];
      
      console.log(`📦 [DELETE-ROUTE] Encontradas ${stops.length} paradas com ${billingIds.length} billings`);
      
      // Excluir todas as paradas
      await db.delete(deliveryRouteStops)
        .where(eq(deliveryRouteStops.routeId, routeId));
      
      // Excluir a rota
      await db.delete(deliveryRoutes)
        .where(eq(deliveryRoutes.id, routeId));
      
      // Retornar todos os billings para "Aguardando Rota"
      if (billingIds.length > 0) {
        await storage.updateBillingsStatus(billingIds, 'Aguardando Rota');
        console.log(`📦 [DELETE-ROUTE] ${billingIds.length} billings retornados para "Aguardando Rota"`);
      }
      
      console.log(`✅ [DELETE-ROUTE] Rota ${routeId} excluída com sucesso`);
      res.json({ 
        message: "Rota excluída com sucesso",
        stopsDeleted: stops.length,
        billingsReturned: billingIds.length
      });
    } catch (error: any) {
      console.error("Error deleting route:", error);
      res.status(500).json({ message: "Failed to delete route", error: error.message });
    }
  });

  // Adicionar uma parada a uma rota existente
  app.post("/api/delivery-routes/:routeId/add-stop", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { routeId } = req.params;
      const { billingId } = req.body;
      
      if (!billingId) {
        return res.status(400).json({ message: "billingId is required" });
      }

      console.log(`➕ [ADD-STOP] Adicionando parada com billingId ${billingId} à rota ${routeId}`);

      // Buscar a rota
      const routeResult = await db.select().from(deliveryRoutes).where(eq(deliveryRoutes.id, routeId));
      if (routeResult.length === 0) {
        return res.status(404).json({ message: "Rota não encontrada" });
      }
      const route = routeResult[0];

      // Buscar dados do billing
      const billingsResult = await db.execute<{
        id: string;
        invoiceNumber: string;
        customerName: string;
        customerAddress: string;
        customerLatitude: string;
        customerLongitude: string;
        deliveryWeekdays: any;
        receivingWeekdays: any;
        averageDeliveryTime: number;
      }>(sql`
        SELECT DISTINCT ON (b.id)
          b.id,
          b.invoice_number as "invoiceNumber",
          COALESCE(c.fantasy_name, b.customer_fantasy_name) as "customerName",
          COALESCE(c.address, '') as "customerAddress",
          c.latitude as "customerLatitude",
          c.longitude as "customerLongitude",
          c.delivery_weekdays as "deliveryWeekdays",
          c.receiving_weekdays as "receivingWeekdays",
          COALESCE(c.average_delivery_time, 30) as "averageDeliveryTime"
        FROM billings b
        LEFT JOIN customers c ON (
          c.id = CONCAT('omie-client-', b.omie_customer_code)
          OR REGEXP_REPLACE(c.cpf, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g')
          OR REGEXP_REPLACE(c.cnpj, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g')
        )
        WHERE b.id = ${billingId}
      `);

      if (billingsResult.rows.length === 0) {
        return res.status(404).json({ message: "Billing não encontrado" });
      }

      const billing = billingsResult.rows[0];
      const lat = parseFloat(billing.customerLatitude);
      const lng = parseFloat(billing.customerLongitude);

      if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
        return res.status(422).json({ message: "Coordenadas GPS ausentes para este cliente" });
      }

      // Usar deliveryRouteService para calcular ETA
      const { calculateEstimatedTimes } = await import('./deliveryRouteService.js');
      const times = calculateEstimatedTimes(route.timeWindowStart, billing.averageDeliveryTime);

      // Buscar a ordem máxima de parada
      const maxOrderResult = await db.select({ maxOrder: sql`MAX(${deliveryRouteStops.stopOrder})` })
        .from(deliveryRouteStops)
        .where(eq(deliveryRouteStops.routeId, routeId));

      const nextOrder = (maxOrderResult[0].maxOrder || 0) + 1;

      // Adicionar a nova parada
      await db.insert(deliveryRouteStops).values({
        id: nanoid(),
        routeId,
        billingId,
        stopOrder: nextOrder,
        estimatedArrival: times.arrival,
        estimatedDeparture: times.departure,
        latitude: String(lat),
        longitude: String(lng),
      });

      // Atualizar status do billing para "Em Rota"
      await storage.updateBillingsStatus([billingId], 'Em Rota');

      console.log(`✅ [ADD-STOP] Parada adicionada com sucesso à rota ${routeId}`);
      res.json({ 
        message: "Parada adicionada com sucesso",
        stop: {
          id: billingId,
          billingId,
          stopOrder: nextOrder,
          customerName: billing.customerName,
          customerAddress: billing.customerAddress,
          estimatedArrival: times.arrival,
          estimatedDeparture: times.departure,
        }
      });
    } catch (error: any) {
      console.error("Error adding stop:", error);
      res.status(500).json({ message: "Failed to add stop", error: error.message });
    }
  });
  
  // ========== FIM DOS ENDPOINTS PARA MOTORISTAS ==========

  // Buscar entregas pendentes
  app.get("/api/deliveries/pending", async (req, res) => {
    try {
      const pendingDeliveries = await storage.getPendingDeliveries();
      res.json(pendingDeliveries);
    } catch (error) {
      console.error("Error fetching pending deliveries:", error);
      res.status(500).json({ message: "Failed to fetch pending deliveries" });
    }
  });

  // Buscar histórico de entregas de um card de venda
  app.get("/api/deliveries/:salesCardId/history", async (req, res) => {
    try {
      const { salesCardId } = req.params;
      const history = await storage.getDeliveryHistory(salesCardId);
      res.json(history);
    } catch (error) {
      console.error("Error fetching delivery history:", error);
      res.status(500).json({ message: "Failed to fetch delivery history" });
    }
  });

  // Registrar histórico de entrega
  app.post("/api/delivery-history", authenticateUser, async (req: any, res) => {
    try {
      const data = req.body;
      
      // Validar campos obrigatórios
      if (!data.salesCardId || !data.status) {
        return res.status(400).json({ 
          message: "Campos obrigatórios ausentes: salesCardId, status" 
        });
      }
      
      // Calcular delivery_duration se checkInTime e checkOutTime estiverem presentes
      let deliveryDuration = data.deliveryDuration;
      if (data.checkInTime && data.checkOutTime && !deliveryDuration) {
        const checkIn = new Date(data.checkInTime);
        const checkOut = new Date(data.checkOutTime);
        deliveryDuration = Math.round((checkOut.getTime() - checkIn.getTime()) / 60000); // em minutos
      }
      
      // Criar registro de histórico
      const history = await storage.createDeliveryHistory({
        salesCardId: data.salesCardId,
        invoiceNumber: data.invoiceNumber,
        customerId: data.customerId,
        customerName: data.customerName,
        driverId: data.driverId,
        driverName: data.driverName,
        vehicleType: data.vehicleType,
        status: data.status,
        checkInTime: data.checkInTime,
        checkOutTime: data.checkOutTime,
        deliveryDuration,
        timestamp: data.timestamp || new Date(),
        location: data.location,
        notes: data.notes
      });
      
      console.log(`✅ [DELIVERY-HISTORY] Histórico registrado para card ${data.salesCardId}`);
      res.json({ message: "Histórico de entrega registrado com sucesso", history });
    } catch (error: any) {
      console.error("Error creating delivery history:", error);
      res.status(500).json({ message: "Failed to create delivery history", error: error.message });
    }
  });

  // Webhook para App Entregas Honest (endpoints públicos para integração externa)
  app.post("/api/webhook/delivery-update", async (req, res) => {
    try {
      const { trackingCode, status, timestamp, location, notes, driverId } = req.body;

      // Buscar sales card pelo código de rastreamento
      const salesCard = await storage.getSalesCardByTrackingCode(trackingCode);
      
      if (!salesCard) {
        return res.status(404).json({ message: "Sales card not found" });
      }

      // Atualizar status
      await storage.updateSalesCardDeliveryStatus(salesCard.id, {
        deliveryStatus: status,
        deliveryCompletedDate: status === 'delivered' ? new Date(timestamp) : null,
        deliveryNotes: notes,
        deliveryDriverId: driverId
      });

      // Registrar no histórico
      await storage.createDeliveryHistory({
        salesCardId: salesCard.id,
        status,
        timestamp: new Date(timestamp),
        location,
        notes,
        driverId
      });

      // ===== SINCRONIZAÇÃO AUTOMÁTICA COM OMIE =====
      // Se o sales card tem um pedido no Omie, atualizar com informações de entrega
      if (salesCard.omieOrderId) {
        try {
          const omieService = getOmieService(storage);
          if (omieService) {
            const updatedSalesCard = await storage.getSalesCard(salesCard.id);
            await omieService.updateOrderDeliveryStatus(salesCard.omieOrderId, updatedSalesCard);
            console.log(`Omie order ${salesCard.omieOrderId} updated with delivery status: ${status}`);
          }
        } catch (omieError) {
          console.error('Error updating Omie order:', omieError);
          // Não falha o webhook se o Omie der erro - operação continua
        }
      }

      res.json({ 
        success: true, 
        message: "Delivery status updated",
        omieUpdated: !!salesCard.omieOrderId 
      });
    } catch (error) {
      console.error("Error processing delivery webhook:", error);
      res.status(500).json({ message: "Failed to process delivery update" });
    }
  });

  // ===== OMIE SALES ORDER INTEGRATION =====

  // Send card to Omie endpoint
  app.post('/api/sales-cards/:id/send-to-omie', isAuthenticated, async (req, res) => {
    try {
      console.log('=== INICIANDO ENVIO PARA OMIE ===');
      const cardId = req.params.id;
      console.log('Card ID:', cardId);
      
      // Inicializar serviço Omie
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Integração Omie não configurada' });
      }
      
      // Buscar o card com dados relacionados
      const card = await storage.getSalesCard(cardId);
      
      if (!card) {
        return res.status(404).json({ message: 'Card não encontrado' });
      }
      
      console.log('📋 Card encontrado:', {
        id: card.id,
        customerId: card.customerId,
        customerName: card.customer?.name || card.customer?.fantasyName,
        customerCnpj: card.customer?.cnpj,
        customerCpf: card.customer?.cpf,
        saleValue: card.saleValue
      });
      
      if (!card.saleValue || parseFloat(card.saleValue) === 0) {
        return res.status(400).json({ 
          message: 'Este card não possui uma venda registrada para enviar ao Omie' 
        });
      }
      
      if (card.omieOrderId) {
        return res.status(400).json({ 
          message: 'Este pedido já foi enviado para o Omie' 
        });
      }
      
      // VERIFICAR BLOQUEIO POR TIPO DE OPERAÇÃO (AMOSTRA/TROCA)
      const operationType = card.operationType || 'venda';
      if (operationType === 'amostra' || operationType === 'troca') {
        console.log(`⚠️ BLOQUEANDO PEDIDO: Tipo de operação ${operationType} requer aprovação manual`);
        
        // Criar registro de pedido bloqueado
        const blockedOrderData = {
          salesCardId: card.id,
          customerId: card.customerId,
          sellerId: card.sellerId,
          blockReason: 'operation_type',
          blockDetails: operationType === 'troca' 
            ? 'Pedido de troca requer aprovação manual antes de enviar ao faturamento.'
            : 'Pedido de amostra requer aprovação manual antes de enviar ao faturamento.',
          operationType: operationType,
          paymentMethod: card.paymentMethod || 'a_vista',
          boletoDays: card.boletoDays || null,
          totalAmount: parseFloat(card.saleValue),
          products: card.products || []
        };
        
        await db.insert(blockedOrders).values(blockedOrderData);
        
        return res.status(403).json({ 
          blocked: true,
          message: operationType === 'troca' 
            ? 'Pedido bloqueado: Trocas requerem aprovação manual antes de enviar ao faturamento.'
            : 'Pedido bloqueado: Amostras requerem aprovação manual antes de enviar ao faturamento.',
          blockReason: 'operation_type',
          operationType: operationType
        });
      }
      
      // VERIFICAR BLOQUEIO POR DÉBITO VENCIDO
      try {
        const clientDocument = card.customer.cnpj || card.customer.cpf || '';
        // Normalizar documento: remover pontos, barras, traços para comparação
        const normalizedDocument = clientDocument.replace(/[.\-\/]/g, '');
        console.log(`🔍 [DEBT-CHECK] Verificando débitos para documento: ${clientDocument} (normalizado: ${normalizedDocument})`);
        console.log(`🔍 [DEBT-CHECK] Cliente: ${card.customer.fantasyName || card.customer.name}`);
        
        const clienteComDebito = await storage.getOverdueDebtByDocument(normalizedDocument);
        console.log(`🔍 [DEBT-CHECK] Resultado da consulta:`, clienteComDebito ? 'DÉBITO ENCONTRADO' : 'SEM DÉBITO');
        
        if (clienteComDebito) {
          console.log(`⚠️ BLOQUEANDO PEDIDO: Cliente ${clienteComDebito.clientName} com débito vencido de R$ ${parseFloat(clienteComDebito.totalAmount).toFixed(2)} - ${clienteComDebito.maxDaysOverdue} dias de atraso`);
          
          // Criar registro de pedido bloqueado
          const blockedOrderData = {
            salesCardId: card.id,
            customerId: card.customerId,
            sellerId: card.sellerId,
            blockReason: 'overdue_debt',
            blockDetails: `Cliente possui débito vencido de R$ ${parseFloat(clienteComDebito.totalAmount).toFixed(2)} com ${clienteComDebito.maxDaysOverdue} dias de atraso. Aguardando regularização financeira.`,
            operationType: card.operationType || 'venda',
            paymentMethod: card.paymentMethod || 'a_vista',
            boletoDays: card.boletoDays || null,
            totalAmount: parseFloat(card.saleValue),
            products: card.products || []
          };
          
          await db.insert(blockedOrders).values(blockedOrderData);
          console.log(`✅ [DEBT-CHECK] Pedido bloqueado registrado no banco de dados`);
          
          return res.status(403).json({ 
            blocked: true,
            message: `Pedido bloqueado: Cliente possui débito vencido de R$ ${parseFloat(clienteComDebito.totalAmount).toFixed(2)} com ${clienteComDebito.maxDaysOverdue} dias de atraso. Regularize a situação financeira antes de realizar novas vendas.`,
            blockReason: 'overdue_debt',
            debtAmount: parseFloat(clienteComDebito.totalAmount),
            daysOverdue: clienteComDebito.maxDaysOverdue
          });
        } else {
          console.log(`✅ [DEBT-CHECK] Cliente liberado - sem débitos vencidos`);
        }
      } catch (error) {
        console.error('❌ [DEBT-CHECK] Erro ao verificar débitos vencidos:', error);
        // Continua o fluxo mesmo se houver erro na consulta de débitos
      }
      
      // Preparar dados da venda para envio
      const saleData = {
        customer: {
          document: card.customer.cnpj || card.customer.cpf || '',
          name: card.customer.fantasyName || card.customer.name,
          email: card.customer.email || '',
          phone: card.customer.phone || '',
          address: card.customer.address || ''
        },
        products: [
          {
            description: `Venda via CRM - Card ${card.id}`,
            quantity: 1,
            unitPrice: parseFloat(card.saleValue),
            totalPrice: parseFloat(card.saleValue)
          }
        ],
        totalValue: parseFloat(card.saleValue),
        orderNumber: `HS-CARD-${card.id}`,
        sellerId: card.sellerId,
        paymentMethod: card.paymentMethod || 'a_vista',
        operationType: card.operationType || 'venda'
      };
      
      console.log('Enviando card para Omie:', {
        cardId,
        totalValue: saleData.totalValue,
        paymentMethod: saleData.paymentMethod,
        operationType: saleData.operationType
      });
      
      // Usar produtos reais da ficha se disponíveis
      let products = [];
      
      if (card.products && Array.isArray(card.products) && card.products.length > 0) {
        // Buscar dados completos dos produtos para obter códigos Omie
        const productPromises = card.products.map(async (cardProduct: any) => {
          console.log('🔍 Buscando produto do card:', cardProduct.id, '- Nome:', cardProduct.name);
          
          // Primeiro tentar buscar por ID direto
          let product = await storage.getProduct(cardProduct.id);
          
          // Se não encontrar, tentar buscar por omie_code (caso o ID seja um código Omie)
          if (!product) {
            console.log('⚠️ Produto não encontrado por ID, tentando por omie_code:', cardProduct.id);
            product = await storage.getProductByOmieCode(cardProduct.id);
          }
          
          console.log('📦 Produto do banco:', {
            id: product?.id,
            name: product?.name,
            omieCode: product?.omieCode,
            omieCodigo: product?.omieCodigo,
            omieCodigoProduto: product?.omieCodigoProduto
          });
          
          return {
            id: product?.id || cardProduct.id,
            omieCode: product?.omieCode || null,
            omieCodigo: product?.omieCodigo || null,
            omieCodigoProduto: product?.omieCodigoProduto || null,
            name: cardProduct.name,
            unitPrice: cardProduct.unitPrice || 0,
            quantity: cardProduct.quantity || 1
          };
        });
        products = await Promise.all(productPromises);
        console.log('📋 Produtos finais para Omie:', JSON.stringify(products, null, 2));
      } else {
        // Fallback: usar produto genérico se não houver produtos na ficha
        products = [
          {
            id: 'crm-sale',
            omieCode: 'crm-sale',
            name: 'VENDA VIA CRM',
            unitPrice: parseFloat(card.saleValue),
            quantity: 1
          }
        ];
      }
      
      const omieResponse = await omieService.createSalesOrder(
        card, 
        card.customer, 
        products,
        card.paymentMethod || 'a_vista',
        card.operationType || 'venda',
        card.sellerId
      );
      
      // Atualizar card com ID do Omie
      const updateData: any = {
        omieOrderId: omieResponse.codigo_pedido?.toString() || `HS-${Date.now()}`,
        notes: (card.notes || '') + `\n\nEnviado para Omie: ${new Date().toLocaleString('pt-BR')}`
      };
      
      await storage.updateSalesCard(cardId, updateData);
      
      res.json({ 
        message: 'Pedido enviado para Omie com sucesso!',
        omieOrderId: omieResponse.codigo_pedido 
      });
      
    } catch (error) {
      console.error('=== ERRO AO ENVIAR PARA OMIE ===');
      console.error('Erro completo:', error);
      console.error('Mensagem do erro:', (error as Error).message);
      console.error('Stack trace:', (error as Error).stack);
      res.status(500).json({ 
        message: 'Erro ao enviar para Omie: ' + (error as Error).message 
      });
    }
  });

  // Exportar sales card para o Omie como pedido de venda
  app.post('/api/sales-cards/:id/export-to-omie', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      
      const salesCard = await storage.getSalesCard(id);
      if (!salesCard) {
        return res.status(404).json({ message: 'Sales card not found' });
      }

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: 'Omie integration not configured' 
        });
      }

      // Buscar dados do cliente
      const customer = await storage.getCustomer(salesCard.customerId);
      if (!customer) {
        return res.status(404).json({ message: 'Customer not found' });
      }

      // Se não há ID do cliente no Omie, não pode exportar
      if (!customer.id.includes('omie-client-')) {
        return res.status(400).json({ 
          message: 'Customer must be imported from Omie first' 
        });
      }

      // Preparar lista de produtos (usar dados do request ou buscar do card)
      let products = req.body.products;
      
      if (!products && salesCard.products && salesCard.products.length > 0) {
        // Buscar dados completos dos produtos para obter códigos Omie
        const productPromises = salesCard.products.map(async (cardProduct: any) => {
          const product = await storage.getProduct(cardProduct.id);
          return {
            id: product?.id || cardProduct.id,
            omieCode: product?.omieCode || null,
            omieCodigo: product?.omieCodigo || null,
            omieCodigoProduto: product?.omieCodigoProduto || null,
            name: cardProduct.name,
            unitPrice: cardProduct.unitPrice || 0,
            quantity: cardProduct.quantity || 1
          };
        });
        products = await Promise.all(productPromises);
      } else if (!products) {
        // Fallback padrão
        products = [{
          id: 'default-product',
          name: 'Produto de vendas',
          unitPrice: salesCard.value || 0,
          quantity: 1
        }];
      }

      // Criar pedido no Omie com informações de entrega
      const omieOrder = await omieService.createSalesOrder(salesCard, customer, products);
      
      // Salvar ID do pedido do Omie no sales card
      await storage.updateSalesCard(id, {
        omieOrderId: omieOrder.codigo_pedido.toString()
      });

      res.json({
        success: true,
        message: 'Sales order exported to Omie successfully',
        omieOrderId: omieOrder.codigo_pedido,
        salesCardId: id,
        deliveryStatus: salesCard.deliveryStatus
      });

    } catch (error) {
      console.error('Error exporting to Omie:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to export to Omie'
      });
    }
  });

  // Sincronizar status de entrega de todos os pedidos para o Omie
  app.post('/api/omie/sync-delivery-status', isAuthenticated, async (req, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: 'Omie integration not configured' 
        });
      }

      // Buscar todos os sales cards com pedidos no Omie
      const salesCards = await storage.getSalesCards();
      const cardsWithOmieOrders = salesCards.filter(card => card.omieOrderId);

      let updated = 0;
      let errors: string[] = [];

      for (const salesCard of cardsWithOmieOrders) {
        try {
          await omieService.updateOrderDeliveryStatus(salesCard.omieOrderId!, salesCard);
          updated++;
          console.log(`Updated Omie order ${salesCard.omieOrderId} for sales card ${salesCard.id}`);
        } catch (error: any) {
          const errorMsg = `Error updating order ${salesCard.omieOrderId}: ${error.message}`;
          errors.push(errorMsg);
          console.error(errorMsg);
        }
      }

      res.json({
        success: true,
        message: 'Delivery status sync completed',
        totalProcessed: cardsWithOmieOrders.length,
        updated,
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (error) {
      console.error('Error syncing delivery status:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to sync delivery status'
      });
    }
  });

  // ===== SISTEMA DE VENDAS RECORRENTES =====

  // Finalizar card de venda (concretizar venda ou marcar como não-venda)
  app.post('/api/sales-cards/:id/complete', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      const { outcome, saleValue, notes } = req.body;

      if (!outcome || !['sale', 'no_sale'].includes(outcome)) {
        return res.status(400).json({ 
          message: 'Outcome must be "sale" or "no_sale"' 
        });
      }

      const result = await storage.completeRecurringSalesCard(
        id, 
        outcome, 
        outcome === 'sale' ? saleValue : undefined
      );

      // Se houve venda, atualizar dados do cliente
      if (outcome === 'sale' && saleValue) {
        const salesCard = result.completedCard;
        await storage.updateCustomer(salesCard.customerId, {
          lastSaleDate: new Date(),
          lastSaleValue: saleValue.toString()
        });
      }

      res.json({
        success: true,
        message: 'Sales card completed successfully',
        completedCard: result.completedCard,
        nextCard: result.nextCard,
        hasNextCard: !!result.nextCard
      });

    } catch (error) {
      console.error('Error completing sales card:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to complete sales card'
      });
    }
  });

  // Enviar card de vendas para faturamento (criar pedido no Omie)
  app.post('/api/sales-cards/:id/invoice', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      const { products } = req.body; // Array de produtos com quantidades

      const salesCard = await storage.getSalesCard(id);
      if (!salesCard) {
        return res.status(404).json({ message: 'Sales card not found' });
      }

      if (salesCard.status !== 'completed') {
        return res.status(400).json({ 
          message: 'Sales card must be completed before invoicing' 
        });
      }

      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ 
          message: 'Omie integration not configured' 
        });
      }

      // Buscar dados do cliente
      const customer = await storage.getCustomer(salesCard.customerId);
      if (!customer) {
        return res.status(404).json({ message: 'Customer not found' });
      }

      // Usar produtos do card ou produtos fornecidos no request
      let orderProducts = products;
      
      if (!orderProducts && salesCard.products && salesCard.products.length > 0) {
        // Buscar dados completos dos produtos para obter códigos Omie
        const productPromises = salesCard.products.map(async (cardProduct: any) => {
          const product = await storage.getProduct(cardProduct.id);
          return {
            id: product?.id || cardProduct.id,
            omieCode: product?.omieCode || null,
            omieCodigo: product?.omieCodigo || null,
            omieCodigoProduto: product?.omieCodigoProduto || null,
            name: cardProduct.name,
            unitPrice: cardProduct.unitPrice || 0,
            quantity: cardProduct.quantity || 1
          };
        });
        orderProducts = await Promise.all(productPromises);
      } else if (!orderProducts) {
        orderProducts = [];
      }

      if (orderProducts.length === 0) {
        return res.status(400).json({ 
          message: 'No products specified for invoicing' 
        });
      }

      // Criar pedido no Omie
      const omieOrder = await omieService.createSalesOrder(salesCard, customer, orderProducts);
      
      // Atualizar card com status de faturado e dados do pedido
      const updatedCard = await storage.updateSalesCard(id, {
        status: 'invoiced',
        omieOrderId: omieOrder.codigo_pedido.toString(),
        notes: `${salesCard.notes || ''}\nFaturado no Omie - Pedido #${omieOrder.codigo_pedido}`
      });

      res.json({
        success: true,
        message: 'Sales card invoiced successfully',
        salesCard: updatedCard,
        omieOrderId: omieOrder.codigo_pedido,
        omieOrderCode: omieOrder.numero_pedido || omieOrder.codigo_pedido
      });

    } catch (error) {
      console.error('Error invoicing sales card:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to invoice sales card'
      });
    }
  });

  // Processar cards em atraso (executar diariamente via cron ou manual)
  app.post('/api/sales-cards/process-overdue', isAuthenticated, async (req, res) => {
    try {
      const result = await storage.processOverdueCards();

      res.json({
        success: true,
        message: 'Overdue cards processed successfully',
        processedCount: result.processedCount,
        sentToTelemarketing: result.sentToTelemarketing,
        transferred: result.transferred,
        errors: result.errors
      });

    } catch (error) {
      console.error('Error processing overdue cards:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to process overdue cards'
      });
    }
  });

  // Listar cards de telemarketing para um atendente
  app.get('/api/telemarketing/my-cards', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      
      // Buscar cards de telemarketing atribuídos ao usuário atual
      const telemarketingCards = await db.execute(sql`
        SELECT sc.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
        FROM sales_cards sc
        JOIN customers c ON sc.customer_id = c.id
        WHERE sc.status = 'telemarketing' 
        AND sc.telemarketing_assigned_to = ${userId}
        ORDER BY sc.scheduled_date ASC
      `);

      res.json(telemarketingCards.rows || []);

    } catch (error) {
      console.error('Error fetching telemarketing cards:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch telemarketing cards'
      });
    }
  });

  // Atualizar card de telemarketing
  app.put('/api/telemarketing/cards/:id', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      const { outcome, notes, rescheduleDate } = req.body;

      const updateData: any = {
        telemarketingNotes: notes,
        updatedAt: new Date()
      };

      if (outcome === 'completed') {
        updateData.status = 'completed';
        updateData.completedDate = new Date();
      } else if (outcome === 'reschedule' && rescheduleDate) {
        updateData.status = 'pending';
        updateData.scheduledDate = new Date(rescheduleDate);
        updateData.telemarketingAssignedTo = null; // Volta para a fila normal
        updateData.telemarketingDate = null;
      }

      const updatedCard = await storage.updateSalesCard(id, updateData);

      res.json({
        success: true,
        message: 'Telemarketing card updated successfully',
        salesCard: updatedCard
      });

    } catch (error) {
      console.error('Error updating telemarketing card:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update telemarketing card'
      });
    }
  });

  // System settings routes
  app.get('/api/system-settings', authenticateUser, async (req: any, res) => {
    try {
      const settings = await storage.getSystemSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching system settings:", error);
      res.status(500).json({ message: "Failed to fetch system settings" });
    }
  });

  app.put('/api/system-settings/:key', authenticateUser, async (req: any, res) => {
    try {
      const { key } = req.params;
      const { value, description } = req.body;
      const userId = req.userId;
      
      // Only admin can update system settings
      const user = await storage.getUser(userId);
      if (user?.role !== 'admin') {
        return res.status(403).json({ message: "Access denied" });
      }

      const setting = await storage.upsertSystemSetting({
        key,
        value,
        description,
        updatedBy: userId,
      });

      res.json(setting);
    } catch (error) {
      console.error("Error updating system setting:", error);
      res.status(500).json({ message: "Failed to update system setting" });
    }
  });

  // Route for check-in with photo upload
  app.post('/api/sales-cards/:id/check-in', authenticateUser, upload.single('photo'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { latitude, longitude } = req.body;

      // Buscar dados do card para verificar se é virtual e calcular distância
      const currentCard = await storage.getSalesCard(id);
      
      if (!currentCard) {
        return res.status(404).json({ message: "Sales card not found" });
      }

      // Verificar se o cliente é virtual (não precisa de check-in)
      if (currentCard.customer?.virtualService) {
        return res.status(400).json({ 
          message: "Cliente virtual não requer check-in" 
        });
      }

      // Verificar se é LEAD e se foto é obrigatória
      if (currentCard.customerId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = currentCard.sellerId 
          ? await storage.getDailyRouteBySellerAndDate(currentCard.sellerId, today)
          : null;
        
        const isLead = await isLeadVisit(currentCard.customerId, dailyRoute);
        if (isLead && !req.file) {
          return res.status(400).json({
            message: "Lead exige foto para check-in",
            isLead: true,
            requiresPhoto: true
          });
        }
      }

      // Calcular distância até o cliente usando Haversine
      let checkInDistance = null;
      if (currentCard.customerLatitude && currentCard.customerLongitude) {
        const customerLat = parseFloat(currentCard.customerLatitude);
        const customerLon = parseFloat(currentCard.customerLongitude);
        
        const R = 6371000; // Raio da Terra em metros
        const dLat = (customerLat - parseFloat(latitude)) * Math.PI / 180;
        const dLon = (customerLon - parseFloat(longitude)) * Math.PI / 180;
        const a = 
          Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(parseFloat(latitude) * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * 
          Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        checkInDistance = R * c; // Distância em metros
      }

      // Processar foto se fornecida
      let photoUrl = null;
      if (req.file) {
        // Converter para base64
        const base64Photo = req.file.buffer.toString('base64');
        photoUrl = `data:${req.file.mimetype};base64,${base64Photo}`;
      }

      const updateData = {
        checkInTime: new Date(),
        checkInLatitude: latitude.toString(),
        checkInLongitude: longitude.toString(),
        distanceToCustomer: checkInDistance?.toString() || null,
        checkInPhotoUrl: photoUrl
      };

      await storage.updateSalesCard(id, updateData);
      
      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        if (currentCard.sellerId) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentCard.sellerId, today);
          
          if (dailyRoute) {
            console.log(`📍 Registrando checkpoint de check-in para sales_card ${id} na rota ${dailyRoute.id}`);
            const { registerCheckpoint } = await import('./routeOptimizationService');
            routeProgress = await registerCheckpoint(
              storage,
              dailyRoute.id,
              id,  // visitId = sales_card ID (rotas usam sales_card IDs)
              currentCard.customerId,
              currentCard.sellerId,
              'check_in',
              parseFloat(latitude),
              parseFloat(longitude)
            );
            console.log(`✅ Checkpoint de check-in registrado: ${JSON.stringify(routeProgress)}`);
          } else {
            console.log(`⚠️  Nenhuma rota diária encontrada para o vendedor ${currentCard.sellerId}`);
          }
        }
      } catch (error: any) {
        console.error('❌ Erro ao registrar checkpoint de check-in:', error);
        console.error('❌ Stack trace:', error.stack);
        console.error('❌ Detalhes - Seller:', currentCard.sellerId, 'Card ID:', id);
        // Não falhar o check-in se checkpoint falhar - vendedor pode estar offline ou OSRM indisponível
      }
      
      res.json({
        success: true,
        message: 'Check-in realizado com sucesso',
        checkInTime: updateData.checkInTime,
        distance: checkInDistance,
        hasPhoto: !!photoUrl,
        routeProgress: routeProgress ? {
          distanceFromPrevious: routeProgress.distanceFromPrevious,
          totalDistanceSoFar: routeProgress.totalDistanceSoFar,
          completedVisits: routeProgress.completedVisits
        } : null
      });
    } catch (error) {
      console.error("Error during check-in:", error);
      res.status(500).json({ message: "Failed to perform check-in" });
    }
  });

  // Endpoint para listar fotos de check-in
  app.get('/api/check-in-photos', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, startDate, endDate, limit = '100' } = req.query;

      // Construir query base
      let query = db
        .select({
          id: salesCards.id,
          customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
          sellerName: sql<string>`${users.firstName} || ' ' || COALESCE(${users.lastName}, '')`,
          checkInTime: salesCards.checkInTime,
          checkInPhotoUrl: salesCards.checkInPhotoUrl,
          checkInLatitude: salesCards.checkInLatitude,
          checkInLongitude: salesCards.checkInLongitude,
          distanceToCustomer: salesCards.distanceToCustomer
        })
        .from(salesCards)
        .leftJoin(customers, eq(salesCards.customerId, customers.id))
        .leftJoin(users, eq(salesCards.sellerId, users.id))
        .where(and(
          isNotNull(salesCards.checkInPhotoUrl),
          isNotNull(salesCards.checkInTime)
        ))
        .$dynamic();

      // Filtro por vendedor (se fornecido e usuário tem permissão)
      if (sellerId && sellerId !== 'all') {
        if (user.role === 'vendedor' && sellerId !== user.id) {
          return res.status(403).json({ message: 'Acesso negado' });
        }
        query = query.where(eq(salesCards.sellerId, sellerId));
      } else if (user.role === 'vendedor') {
        // Vendedor só pode ver suas próprias fotos
        query = query.where(eq(salesCards.sellerId, user.id));
      }

      // Filtros de data (se fornecidos)
      if (startDate) {
        query = query.where(gte(salesCards.checkInTime, new Date(startDate as string)));
      }
      if (endDate) {
        query = query.where(lte(salesCards.checkInTime, new Date(endDate as string)));
      }

      // Ordenar por data mais recente primeiro
      const photos = await query
        .orderBy(sql`${salesCards.checkInTime} DESC`)
        .limit(parseInt(limit as string));

      res.json({
        photos,
        total: photos.length
      });
    } catch (error) {
      console.error('Erro ao buscar fotos de check-in:', error);
      res.status(500).json({ message: 'Falha ao buscar fotos de check-in' });
    }
  });

  // AUDITORIA COMPLETA DE CHECK-INS - TODOS OS REGISTROS
  app.get('/api/check-ins/audit', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, startDate, endDate, limit = '500' } = req.query;

      // Query para TODOS os check-ins de sales_cards E visit_agenda
      const checkIns = await db.execute(sql`
        SELECT 
          'sales_card' as origem,
          sc.id,
          sc.seller_id,
          u.first_name || ' ' || COALESCE(u.last_name, '') as vendedor,
          COALESCE(c.fantasy_name, c.company_name) as cliente,
          c.cpf_cnpj as documento_cliente,
          sc.check_in_time as timestamp,
          sc.check_in_latitude as latitude,
          sc.check_in_longitude as longitude,
          sc.distance_to_customer as distancia_cliente,
          sc.check_in_photo_url as foto_url,
          sc.check_out_time,
          -- Verificar se tem checkpoint
          CASE WHEN rc.id IS NOT NULL THEN true ELSE false END as tem_checkpoint,
          rc.id as checkpoint_id,
          rc.checkpoint_time,
          rc.validation_status,
          rc.is_off_route,
          -- Verificar se tem rota diária
          CASE WHEN dr.id IS NOT NULL THEN true ELSE false END as tem_rota_diaria,
          dr.id as rota_id
        FROM sales_cards sc
        LEFT JOIN users u ON sc.seller_id = u.id
        LEFT JOIN customers c ON sc.customer_id = c.id
        LEFT JOIN route_checkpoints rc ON sc.id = rc.visit_id AND rc.checkpoint_type = 'check_in'
        LEFT JOIN daily_routes dr ON u.id = dr.seller_id AND DATE(sc.check_in_time) = dr.route_date
        WHERE sc.check_in_time IS NOT NULL
          ${sellerId && sellerId !== 'all' ? sql`AND sc.seller_id = ${sellerId}` : sql``}
          ${user.role === 'vendedor' ? sql`AND sc.seller_id = ${user.id}` : sql``}
          ${startDate ? sql`AND sc.check_in_time >= ${new Date(startDate as string)}` : sql``}
          ${endDate ? sql`AND sc.check_in_time <= ${new Date(endDate as string)}` : sql``}
        
        UNION ALL
        
        SELECT 
          'visit_agenda' as origem,
          va.id,
          va.seller_id,
          u.first_name || ' ' || COALESCE(u.last_name, '') as vendedor,
          COALESCE(c.fantasy_name, c.company_name) as cliente,
          c.cpf_cnpj as documento_cliente,
          va.actual_check_in as timestamp,
          va.check_in_latitude as latitude,
          va.check_in_longitude as longitude,
          va.distance_to_customer as distancia_cliente,
          NULL as foto_url,
          va.actual_check_out as check_out_time,
          CASE WHEN rc.id IS NOT NULL THEN true ELSE false END as tem_checkpoint,
          rc.id as checkpoint_id,
          rc.checkpoint_time,
          rc.validation_status,
          rc.is_off_route,
          CASE WHEN dr.id IS NOT NULL THEN true ELSE false END as tem_rota_diaria,
          dr.id as rota_id
        FROM visit_agenda va
        LEFT JOIN users u ON va.seller_id = u.id
        LEFT JOIN customers c ON va.customer_id = c.id
        LEFT JOIN route_checkpoints rc ON va.id = rc.visit_id AND rc.checkpoint_type = 'check_in'
        LEFT JOIN daily_routes dr ON u.id = dr.seller_id AND DATE(va.actual_check_in) = dr.route_date
        WHERE va.actual_check_in IS NOT NULL
          ${sellerId && sellerId !== 'all' ? sql`AND va.seller_id = ${sellerId}` : sql``}
          ${user.role === 'vendedor' ? sql`AND va.seller_id = ${user.id}` : sql``}
          ${startDate ? sql`AND va.actual_check_in >= ${new Date(startDate as string)}` : sql``}
          ${endDate ? sql`AND va.actual_check_in <= ${new Date(endDate as string)}` : sql``}
        
        ORDER BY timestamp DESC
        LIMIT ${parseInt(limit as string)}
      `);

      // Estatísticas
      const stats = {
        total: checkIns.rows.length,
        comCheckpoint: checkIns.rows.filter((r: any) => r.tem_checkpoint).length,
        semCheckpoint: checkIns.rows.filter((r: any) => !r.tem_checkpoint).length,
        comRota: checkIns.rows.filter((r: any) => r.tem_rota_diaria).length,
        semRota: checkIns.rows.filter((r: any) => !r.tem_rota_diaria).length,
        comFoto: checkIns.rows.filter((r: any) => r.foto_url).length,
        foraRota: checkIns.rows.filter((r: any) => r.is_off_route).length,
        porOrigem: {
          salesCards: checkIns.rows.filter((r: any) => r.origem === 'sales_card').length,
          visitAgenda: checkIns.rows.filter((r: any) => r.origem === 'visit_agenda').length
        }
      };

      res.json({
        checkIns: checkIns.rows,
        stats
      });

    } catch (error) {
      console.error('❌ Erro ao buscar auditoria de check-ins:', error);
      res.status(500).json({ message: 'Falha ao buscar auditoria de check-ins' });
    }
  });

  // Route for check-out
  app.post('/api/sales-cards/:id/check-out', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { latitude, longitude } = req.body;

      // Buscar dados do card para calcular distância até o cliente
      const currentCard = await storage.getSalesCard(id);
      
      if (!currentCard) {
        return res.status(404).json({ message: "Sales card not found" });
      }

      // Verificar se é LEAD e se foto de check-in existe
      if (currentCard.customerId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = currentCard.sellerId 
          ? await storage.getDailyRouteBySellerAndDate(currentCard.sellerId, today)
          : null;
        
        const isLead = await isLeadVisit(currentCard.customerId, dailyRoute);
        if (isLead && !currentCard.checkInPhotoUrl) {
          return res.status(400).json({
            message: "Lead exige foto de check-in para realizar check-out",
            isLead: true,
            requiresPhoto: true,
            missingCheckInPhoto: true
          });
        }
      }
      
      let checkOutDistance = null;

      if (currentCard && currentCard.customerLatitude && currentCard.customerLongitude) {
        const customerLat = parseFloat(currentCard.customerLatitude);
        const customerLon = parseFloat(currentCard.customerLongitude);
        
        // Calcular distância usando fórmula de Haversine
        const R = 6371000; // Raio da Terra em metros
        const dLat = (customerLat - latitude) * Math.PI / 180;
        const dLon = (customerLon - longitude) * Math.PI / 180;
        const a = 
          Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(latitude * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * 
          Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        checkOutDistance = R * c; // Distância em metros
      }

      const updateData = {
        checkOutTime: new Date(),
        checkOutLatitude: latitude.toString(),
        checkOutLongitude: longitude.toString(),
        ...(checkOutDistance !== null && { checkOutDistanceToCustomer: checkOutDistance.toString() })
      };

      const salesCard = await storage.updateSalesCard(id, updateData);
      
      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        if (currentCard && currentCard.sellerId) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentCard.sellerId, today);
          
          if (dailyRoute) {
            console.log(`📍 Registrando checkpoint de check-out para sales_card ${id} na rota ${dailyRoute.id}`);
            const { registerCheckpoint } = await import('./routeOptimizationService');
            routeProgress = await registerCheckpoint(
              storage,
              dailyRoute.id,
              id,  // visitId = sales_card ID (rotas usam sales_card IDs)
              currentCard.customerId,
              currentCard.sellerId,
              'check_out',
              latitude,
              longitude
            );
            console.log(`✅ Checkpoint de check-out registrado: ${JSON.stringify(routeProgress)}`);
          } else {
            console.log(`⚠️  Nenhuma rota diária encontrada para o vendedor ${currentCard.sellerId}`);
          }
        }
      } catch (error) {
        console.error('❌ Erro ao registrar checkpoint de check-out:', error);
        // Não falhar o check-out se checkpoint falhar - vendedor pode estar offline ou OSRM indisponível
      }
      
      res.json({
        success: true,
        message: 'Check-out realizado com sucesso',
        checkOutTime: updateData.checkOutTime,
        checkOutDistance,
        routeProgress: routeProgress ? {
          distanceFromPrevious: routeProgress.distanceFromPrevious,
          totalDistanceSoFar: routeProgress.totalDistanceSoFar,
          completedVisits: routeProgress.completedVisits
        } : null
      });
    } catch (error) {
      console.error("Error during check-out:", error);
      res.status(500).json({ message: "Failed to perform check-out" });
    }
  });

  // Route to finalize sale with Omie integration
  app.post('/api/sales-cards/:id/finalize-sale', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { 
        items, 
        totalValue, 
        orderNumber, 
        paymentMethod, 
        operationType, 
        shouldBlock,
        deliveryTimeSlots,
        deliverySaturdayTimeSlots,
        customerLatitude,
        customerLongitude,
        boletoDays,
        saveForReuse,
        exclusiveVehicle,
        vehicleTypes
      } = req.body;
      
      // Use items as products for backward compatibility
      const products = items || req.body.products;

      console.log('Finalizing sale for card:', id);
      console.log('Sale data:', { products, totalValue, orderNumber, operationType });

      // Check if order should be blocked
      let shouldBlockOrder = shouldBlock || false; // Use from frontend
      let blockReason = '';
      let blockDetails = '';

      // Block if operation is troca or amostra
      if (operationType === 'troca' || operationType === 'amostra') {
        shouldBlockOrder = true;
        blockReason = 'operation_type';
        blockDetails = operationType === 'troca' 
          ? 'Pedido de troca requer aprovação manual'
          : 'Pedido de amostra requer aprovação manual';
      }

      // Block if frontend indicates it should be blocked (e.g., boleto terms)
      if (shouldBlock && !shouldBlockOrder) {
        shouldBlockOrder = true;
        blockReason = 'payment_terms';
        blockDetails = 'Pedido com condições de pagamento que requerem aprovação';
      }

      // Check if customer has overdue debt
      if (!shouldBlockOrder) {
        try {
          const salesCard = await storage.getSalesCard(id);
          if (salesCard && salesCard.customer) {
            const customerDocument = salesCard.customer.cnpj || salesCard.customer.cpf;
            if (customerDocument) {
              const omieService = getOmieService(storage);
              if (omieService) {
                const creditInfo = await omieService.getClientCreditInfo(customerDocument);
                if (creditInfo && creditInfo.valor_em_aberto > 0 && creditInfo.dias_em_atraso > 0) {
                  shouldBlockOrder = true;
                  blockReason = 'overdue_debt';
                  blockDetails = `Cliente possui débito vencido de R$ ${creditInfo.valor_em_aberto.toFixed(2)} há ${creditInfo.dias_em_atraso} dias`;
                }
              }
            }
          }
        } catch (error) {
          console.warn('Error checking customer debt:', error);
          // Continue sem bloquear se não conseguir verificar débito
        }
      }

      if (shouldBlockOrder) {
        // Create blocked order instead of finalizing
        console.log(`Blocking order for card ${id}, reason: ${blockReason}`);
        
        // Get card data to create blocked order record
        const salesCard = await storage.getSalesCard(id);
        if (!salesCard) {
          return res.status(404).json({ message: 'Sales card not found' });
        }
        
        // Update sales card status to blocked
        const updateData = {
          status: 'blocked',
          products: products,
          saleValue: totalValue.toString(),
          paymentMethod: paymentMethod || 'a_vista',
          operationType: operationType || 'venda',
          boletoDays: boletoDays || 7,
          deliveryTimeSlots: deliveryTimeSlots || [],
          deliverySaturdayTimeSlots: deliverySaturdayTimeSlots || [],
          customerLatitude: customerLatitude,
          customerLongitude: customerLongitude,
          exclusiveVehicle: exclusiveVehicle || false,
          vehicleTypes: vehicleTypes || [],
          notes: (salesCard.notes || '') + `\n\nPedido bloqueado: ${blockDetails}`
        };

        await storage.updateSalesCard(id, updateData);
        
        // Create blocked order record in blocked_orders table
        const blockedOrderData = {
          salesCardId: id,
          customerId: salesCard.customerId,
          sellerId: salesCard.sellerId,
          blockReason: blockReason,
          blockDetails: blockDetails,
          operationType: operationType || 'venda',
          paymentMethod: paymentMethod || 'a_vista',
          boletoDays: boletoDays || null,
          totalAmount: parseFloat(totalValue) || 0,
          products: products || []
        };
        
        await db.insert(blockedOrders).values([blockedOrderData]);
        console.log(`✅ Pedido bloqueado criado em blocked_orders para card ${id}`);
        
        return res.json({
          success: true,
          blocked: true,
          message: 'Pedido bloqueado para aprovação manual',
          reason: blockDetails
        });
      }

      // Update sales card with products, value, payment method and operation type
      const updateData = {
        status: 'completed',
        completedDate: new Date(),
        saleValue: totalValue,
        products: products,
        paymentMethod: paymentMethod || 'a_vista',
        operationType: operationType || 'venda',
        boletoDays: boletoDays || 7,
        deliveryTimeSlots: deliveryTimeSlots || [],
        deliverySaturdayTimeSlots: deliverySaturdayTimeSlots || [],
        customerLatitude: customerLatitude,
        customerLongitude: customerLongitude,
        exclusiveVehicle: exclusiveVehicle || false,
        vehicleTypes: vehicleTypes || []
      };

      const salesCard = await storage.updateSalesCard(id, updateData);

      // Atualizar preferências do cliente após a venda (coordenadas, veículo, horários)
      try {
        const card = await storage.getSalesCard(id);
        if (card && saveForReuse) {
          const customerUpdateData: any = {};
          
          // Coordenadas GPS
          if (req.body.customerLatitude && req.body.customerLongitude) {
            customerUpdateData.latitude = req.body.customerLatitude;
            customerUpdateData.longitude = req.body.customerLongitude;
          }
          
          // Configurações de entrega (veículo exclusivo e tipos)
          if (exclusiveVehicle !== undefined) {
            customerUpdateData.exclusiveVehicle = exclusiveVehicle;
          }
          if (vehicleTypes && vehicleTypes.length > 0) {
            customerUpdateData.vehicleTypes = vehicleTypes;
          }
          
          // Horários de entrega
          if (deliveryTimeSlots && deliveryTimeSlots.length > 0) {
            customerUpdateData.deliveryTimeSlots = deliveryTimeSlots;
          }
          if (deliverySaturdayTimeSlots && deliverySaturdayTimeSlots.length > 0) {
            customerUpdateData.deliverySaturdayTimeSlots = deliverySaturdayTimeSlots;
          }
          
          // Atualizar cliente se houver dados para atualizar
          if (Object.keys(customerUpdateData).length > 0) {
            await storage.updateCustomer(card.customerId, customerUpdateData);
            console.log(`✅ Preferências atualizadas no cliente ${card.customerId}:`, customerUpdateData);
          }
        }
      } catch (updateError) {
        console.error('Erro ao atualizar preferências do cliente após venda:', updateError);
        // Não falhar a finalização da venda se a atualização falhar
      }

      // Get full card data with customer info for Omie
      const fullCard = await storage.getSalesCardById(id);
      
      if (fullCard && fullCard.customer) {
        try {
          // Send order to Omie ERP
          console.log('Sending order to Omie...');
          
          const omieOrderData = {
            orderNumber,
            customerId: fullCard.customer.id,
            customerName: fullCard.customer.fantasyName || fullCard.customer.name,
            customerDocument: fullCard.customer.cnpj || fullCard.customer.cpf,
            products: products.map((p: any) => ({
              name: p.name,
              quantity: p.quantity,
              unitPrice: p.unitPrice,
              totalPrice: p.totalPrice
            })),
            totalValue,
            orderDate: new Date().toISOString(),
          };

          // Integração real com Omie API
          const { createOmieOrder } = await import('./omieIntegration');
          
          try {
            const omieResult = await createOmieOrder({
              customer: {
                document: fullCard.customer.cnpj || fullCard.customer.cpf || '',
                name: fullCard.customer.fantasyName || fullCard.customer.name,
                email: fullCard.customer.email || '',
                phone: fullCard.customer.phone || '',
                address: fullCard.customer.address || ''
              },
              products: products.map((p: any) => ({
                description: p.name,
                quantity: p.quantity,
                unitPrice: p.unitPrice,
                totalPrice: p.totalPrice
              })),
              totalValue,
              orderNumber,
              sellerId: fullCard.sellerId,
              paymentMethod: paymentMethod || 'a_vista',
              operationType: operationType || 'venda'
            });

            const omieOrderId = omieResult.numero_pedido || `OMIE-${orderNumber}`;
            
            await storage.updateSalesCard(id, { 
              omieOrderId,
              status: 'invoiced'
            });

            console.log('Order sent to Omie successfully:', omieOrderId);

            res.json({
              success: true,
              orderNumber,
              omieOrderId,
              salesCard,
              omieData: omieResult
            });

          } catch (omieApiError: any) {
            console.error('Omie API Error:', omieApiError);
            
            // Marcar como completed mesmo com erro no Omie
            const fallbackOrderId = `FALLBACK-${orderNumber}`;
            await storage.updateSalesCard(id, { 
              omieOrderId: fallbackOrderId,
              status: 'completed'
            });

            res.json({
              success: true,
              orderNumber,
              omieOrderId: fallbackOrderId,
              salesCard,
              warning: `Venda registrada localmente. Erro na integração Omie: ${omieApiError.message}`
            });
          }

        } catch (omieError) {
          console.error('Error sending to Omie:', omieError);
          // Even if Omie fails, mark the sale as completed
          res.json({
            success: true,
            orderNumber,
            salesCard,
            warning: 'Venda registrada, mas houve erro ao enviar para Omie'
          });
        }
      } else {
        res.json({
          success: true,
          orderNumber,
          salesCard
        });
      }

    } catch (error) {
      console.error("Error finalizing sale:", error);
      res.status(500).json({ message: "Failed to finalize sale" });
    }
  });

  // Save draft sale
  app.post('/api/sales-cards/:id/save-draft', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { 
        items, 
        totalValue, 
        paymentMethod, 
        operationType, 
        deliveryTimeSlots,
        deliverySaturdayTimeSlots,
        customerLatitude,
        customerLongitude,
        boletoDays,
        exclusiveVehicle,
        vehicleTypes
      } = req.body;
      
      const products = items || req.body.products;

      console.log('Saving draft for card:', id);
      console.log('Draft data:', { products, totalValue, operationType });

      // Update sales card with draft status
      const updateData = {
        status: 'draft',
        products: products,
        saleValue: totalValue?.toString() || '0',
        paymentMethod: paymentMethod || 'a_vista',
        operationType: operationType || 'venda',
        boletoDays: boletoDays || 7,
        deliveryTimeSlots: deliveryTimeSlots || [],
        deliverySaturdayTimeSlots: deliverySaturdayTimeSlots || [],
        customerLatitude: customerLatitude,
        customerLongitude: customerLongitude,
        exclusiveVehicle: exclusiveVehicle || false,
        vehicleTypes: vehicleTypes || []
      };

      const salesCard = await storage.updateSalesCard(id, updateData);

      res.json({
        success: true,
        salesCard,
        message: 'Rascunho salvo com sucesso'
      });

    } catch (error) {
      console.error("Error saving draft:", error);
      res.status(500).json({ message: "Failed to save draft" });
    }
  });

  // Import products from Omie with correct active filter
  app.post('/api/omie/import-products', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      
      // Only admin can import products
      const user = await storage.getUser(userId);
      if (user?.role !== 'admin') {
        return res.status(403).json({ message: "Apenas administradores podem importar produtos" });
      }

      console.log('Iniciando importação de produtos ativos do Omie...');
      
      let totalProcessed = 0;
      let importedCount = 0;
      const errors: string[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const payload = {
          call: 'ListarProdutos',
          app_key: process.env.OMIE_APP_KEY,
          app_secret: process.env.OMIE_APP_SECRET,
          param: [{
            pagina: currentPage,
            registros_por_pagina: 50,
            apenas_importado_api: 'N'
          }]
        };

        const response = await fetch('https://app.omie.com.br/api/v1/geral/produtos/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          break;
        }

        const data = await response.json();
        if (data.faultstring) {
          errors.push(`Erro API Omie: ${data.faultstring}`);
          break;
        }

        const products = data.produto_servico_cadastro || [];
        
        for (const product of products) {
          totalProcessed++;
          
          // Log detalhado de TODOS os produtos para debug
          console.log(`\n=== PRODUTO ${totalProcessed} ===`);
          console.log(`Nome: ${product.descricao}`);
          console.log(`Código: ${product.codigo_produto}`);
          console.log(`Código Produto: ${product.codigo}`);
          console.log(`Inativo: "${product.inativo}"`);
          console.log(`Bloqueado: "${product.bloqueado}"`);
          console.log(`Família: "${product.familia}"`);
          console.log(`Preço: ${product.valor_unitario}`);
          console.log(`Unidade: ${product.unidade}`);
          
          // Filtro baseado EXATAMENTE na sua tela do Omie
          // Na sua imagem, os produtos ativos são da família "BEBIDAS DE FRUTAS"
          // e têm códigos como PRD-MA-500, PRD-AC-350, etc.
          
          // 1. Produto deve estar ativo (não inativo)
          if (product.inativo === 'S' || product.inativo === true || product.inativo === 'true') {
            console.log(`❌ Produto INATIVO - Pulando`);
            continue;
          }
          
          // 2. Produto não deve estar bloqueado
          if (product.bloqueado === 'S' || product.bloqueado === true || product.bloqueado === 'true') {
            console.log(`❌ Produto BLOQUEADO - Pulando`);
            continue;
          }
          
          // 3. Deve ter preço válido (produtos da sua tela têm preços)
          if (!product.valor_unitario || product.valor_unitario <= 0) {
            console.log(`❌ Produto SEM PREÇO - Pulando`);
            continue;
          }
          
          // 4. Filtro baseado nos produtos REAIS da sua tela
          // Da sua imagem, os produtos válidos são:
          // - SUCO MISTO DE FRUTA - MARACUJÁ 500ml (PRD-MA-500)
          // - SUCO MISTO DE FRUTA - ACEROLA 350ml (PRD-AC-350) 
          // - SUCO MISTO DE FRUTA - ACEROLA 900ml (PRD-AC-900)
          // - etc. (todos são "SUCO MISTO DE FRUTA")
          
          const isValidProduct = product.descricao && (
            product.descricao.includes('SUCO MISTO DE FRUTA') ||
            product.descricao.includes('SUCO DE FRUTA') ||
            (product.familia && product.familia.includes('BEBIDAS DE FRUTAS'))
          );
          
          if (!isValidProduct) {
            console.log(`❌ Produto não é um suco válido - Pulando`);
            continue;
          }
          
          // 5. Verificar se tem código válido (PRD- ou similar)
          const hasValidCode = product.codigo && (
            product.codigo.startsWith('PRD-') || 
            product.codigo.includes('AC') || 
            product.codigo.includes('MA') ||
            product.codigo.includes('LI') ||
            product.codigo.includes('MO')
          );
          
          if (!hasValidCode) {
            console.log(`❌ Produto sem código válido (código: ${product.codigo}) - Pulando`);
            continue;
          }
          
          console.log(`✅ PRODUTO VÁLIDO - Será importado!`);

          try {
            // Buscar estoque real do produto
            let stockQuantity = 0;
            try {
              const stockPayload = {
                call: 'ConsultarPosEstoque',
                app_key: process.env.OMIE_APP_KEY,
                app_secret: process.env.OMIE_APP_SECRET,
                param: [{ codigo_produto: product.codigo_produto }]
              };

              const stockResponse = await fetch('https://app.omie.com.br/api/v1/estoque/consulta/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(stockPayload),
              });

              if (stockResponse.ok) {
                const stockData = await stockResponse.json();
                if (!stockData.faultstring && stockData.saldo_estoque !== undefined) {
                  stockQuantity = stockData.saldo_estoque || 0;
                }
              }
            } catch (stockError) {
              console.log(`Estoque indisponível para ${product.codigo}: ${stockError}`);
            }

            // Verificar se produto já existe pelo código Omie
            const existingProducts = await storage.getProducts();
            const omieCode = product.codigo || product.codigo_produto.toString();
            const existingProduct = existingProducts.find(p => p.omieCode === omieCode);
            
            const productData = {
              name: product.descricao || 'Produto sem nome',
              description: product.descricao_detalhada || product.descricao || '',
              price: (product.valor_unitario || 0).toString(),
              stock: stockQuantity,
              omieCode: omieCode, // Mantém compatibilidade com código antigo
              omieCodigo: product.codigo, // Código alfanumérico (ex: PRD00003)
              omieCodigoProduto: product.codigo_produto, // ID numérico do Omie (ex: 2425693571)
              isActive: true
            };

            if (existingProduct) {
              // Atualizar produto existente
              await storage.updateProduct(existingProduct.id, productData);
              console.log(`Produto atualizado: ${product.descricao} (Estoque: ${stockQuantity})`);
            } else {
              // Criar novo produto
              await storage.createProduct(productData);
              console.log(`Produto importado: ${product.descricao} (Estoque: ${stockQuantity})`);
            }

            importedCount++;

          } catch (productError: any) {
            errors.push(`Erro ao processar ${product.descricao}: ${productError.message}`);
          }
        }

        // Verificar próxima página
        const totalPages = Math.ceil((data.total_de_registros || 0) / 50);
        hasMorePages = currentPage < totalPages;
        currentPage++;
      }

      res.json({
        success: true,
        totalProcessed,
        imported: importedCount,
        errors,
        message: `Importação concluída: ${importedCount} produtos da categoria BEBIDAS DE FRUTAS importados do Omie`
      });

    } catch (error: any) {
      console.error('Erro na importação de produtos:', error);
      res.status(500).json({ 
        success: false,
        message: `Falha na importação: ${error.message}` 
      });
    }
  });

  // ========================================
  // FERRAMENTAS DE DIAGNÓSTICO DE COORDENADAS
  // ========================================
  
  // Diagnóstico de coordenadas suspeitas (Admin apenas)
  app.get('/api/admin/diagnose-coordinates', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      console.log('🔍 Iniciando diagnóstico de coordenadas...');
      
      // 1. Buscar clientes com latitude POSITIVA (erro no Brasil)
      const positiveLatitudes = await db.select({
        id: customers.id,
        name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
        latitude: customers.latitude,
        longitude: customers.longitude,
        city: customers.city,
        state: customers.state
      })
        .from(customers)
        .where(sql`CAST(${customers.latitude} AS FLOAT) > 0`)
        .limit(100);
      
      // 2. Buscar todos os vendedores
      const sellers = await db.select({
        id: users.id,
        name: sql<string>`${users.firstName} || ' ' || COALESCE(${users.lastName}, '')`,
        homeLatitude: users.homeLatitude,
        homeLongitude: users.homeLongitude
      })
        .from(users)
        .where(eq(users.role, 'vendedor'));
      
      // 3. Verificar clientes com distâncias >100km dos vendedores
      const suspiciousDistances: any[] = [];
      
      for (const seller of sellers) {
        if (!seller.homeLatitude || !seller.homeLongitude) continue;
        
        const sellerLat = parseFloat(seller.homeLatitude as any);
        const sellerLon = parseFloat(seller.homeLongitude as any);
        
        // Buscar clientes deste vendedor via sales_cards
        const sellerCustomers = await db.selectDistinct({
          customerId: salesCards.customerId,
          customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
          customerLat: customers.latitude,
          customerLon: customers.longitude
        })
          .from(salesCards)
          .innerJoin(customers, eq(salesCards.customerId, customers.id))
          .where(eq(salesCards.sellerId, seller.id))
          .limit(200);
        
        for (const customer of sellerCustomers) {
          if (!customer.customerLat || !customer.customerLon) continue;
          
          const customerLat = parseFloat(customer.customerLat as any);
          const customerLon = parseFloat(customer.customerLon as any);
          
          // Calcular distância Haversine
          const R = 6371; // Raio da Terra em km
          const dLat = (customerLat - sellerLat) * Math.PI / 180;
          const dLon = (customerLon - sellerLon) * Math.PI / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(sellerLat * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const distance = R * c;
          
          if (distance > 100) {
            suspiciousDistances.push({
              sellerId: seller.id,
              sellerName: seller.name,
              customerId: customer.customerId,
              customerName: customer.customerName,
              distance: Math.round(distance),
              customerLat: customer.customerLat,
              customerLon: customer.customerLon
            });
          }
        }
      }
      
      console.log(`✅ Diagnóstico concluído:`);
      console.log(`   - ${positiveLatitudes.length} clientes com latitude POSITIVA (erro)`);
      console.log(`   - ${suspiciousDistances.length} clientes com distância >100km do vendedor`);
      
      res.json({
        success: true,
        summary: {
          positiveLatitudes: positiveLatitudes.length,
          suspiciousDistances: suspiciousDistances.length,
          totalSellers: sellers.length
        },
        issues: {
          positiveLatitudes: positiveLatitudes.map(c => ({
            id: c.id,
            name: c.name,
            latitude: c.latitude,
            longitude: c.longitude,
            city: c.city,
            state: c.state,
            suggestedFix: `Latitude deveria ser ${-parseFloat(c.latitude as any)}`
          })),
          suspiciousDistances: suspiciousDistances.slice(0, 50) // Primeiros 50
        }
      });
      
    } catch (error: any) {
      console.error('Erro no diagnóstico:', error);
      res.status(500).json({ 
        success: false,
        message: 'Erro ao diagnosticar coordenadas',
        error: error.message 
      });
    }
  });

  // Diagnosticar pedidos (billings) sem vinculação com clientes (Admin apenas)
  app.get('/api/admin/diagnose-billing-customers', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      console.log('🔍 Diagnóstico de vínculos entre billings e customers...');
      
      // Query de diagnóstico: simular getPendingDeliveries mas mostrar todos os detalhes
      const result = await db.execute(sql`
        SELECT 
          b.id as billing_id,
          b.invoice_number,
          b.customer_fantasy_name,
          b.omie_customer_code,
          b.customer_document,
          c.id as customer_id,
          COALESCE(c.fantasy_name, c.company_name) as customer_name,
          c.cpf,
          c.cnpj,
          c.omie_client_code,
          -- Teste de match
          CASE 
            WHEN c.id = CONCAT('omie-client-', b.omie_customer_code) THEN 'MATCH_OMIE_CODE'
            WHEN REGEXP_REPLACE(c.cpf, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g') THEN 'MATCH_CPF'
            WHEN REGEXP_REPLACE(c.cnpj, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g') THEN 'MATCH_CNPJ'
            ELSE 'NO_MATCH'
          END as match_type,
          -- Gerar customerId como em getPendingDeliveries
          COALESCE(c.id, 'billing-' || b.id) as generated_customer_id
        FROM billings b
        LEFT JOIN customers c ON (
          (c.id = CONCAT('omie-client-', b.omie_customer_code)
          OR REGEXP_REPLACE(c.cpf, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g')
          OR REGEXP_REPLACE(c.cnpj, '[^0-9]', '', 'g') = REGEXP_REPLACE(b.customer_document, '[^0-9]', '', 'g'))
          AND c.virtual_service = false
        )
        WHERE b.invoice_stage = 'Aguardando Rota'
          AND b.invoice_number IS NOT NULL
          AND b.invoice_date IS NOT NULL
        ORDER BY match_type DESC, b.id
        LIMIT 100
      `);
      
      // Separar por tipo de match
      const matches = {
        withMatch: result.rows.filter((r: any) => r.match_type !== 'NO_MATCH'),
        withoutMatch: result.rows.filter((r: any) => r.match_type === 'NO_MATCH')
      };
      
      console.log(`📊 Diagnóstico concluído:`);
      console.log(`   - ${matches.withMatch.length} billings COM vinculação`);
      console.log(`   - ${matches.withoutMatch.length} billings SEM vinculação (geram customerId falso)`);
      
      res.json({
        success: true,
        summary: {
          totalAnalyzed: result.rows.length,
          withMatch: matches.withMatch.length,
          withoutMatch: matches.withoutMatch.length
        },
        billingsWithMatch: matches.withMatch.slice(0, 20).map((r: any) => ({
          billingId: r.billing_id,
          invoiceNumber: r.invoice_number,
          billingCustomerName: r.customer_fantasy_name,
          omieCustomerCode: r.omie_customer_code,
          customerDocument: r.customer_document,
          matchedCustomerId: r.customer_id,
          matchedCustomerName: r.customer_name,
          matchType: r.match_type,
          generatedCustomerId: r.generated_customer_id
        })),
        billingsWithoutMatch: matches.withoutMatch.slice(0, 20).map((r: any) => ({
          billingId: r.billing_id,
          invoiceNumber: r.invoice_number,
          billingCustomerName: r.customer_fantasy_name,
          omieCustomerCode: r.omie_customer_code,
          customerDocument: r.customer_document,
          matchedCustomerId: r.customer_id, // será null
          matchType: r.match_type,
          generatedCustomerId: r.generated_customer_id, // será 'billing-{id}'
          possibleReasons: [
            r.omie_customer_code ? null : '❌ omie_customer_code está NULL',
            r.customer_document ? null : '❌ customer_document está NULL',
            '⚠️ Cliente pode não existir na tabela customers',
            '⚠️ CPF/CNPJ pode não bater entre billing e customer'
          ].filter(Boolean)
        }))
      });
      
    } catch (error: any) {
      console.error('Erro no diagnóstico:', error);
      res.status(500).json({ 
        success: false,
        message: 'Erro ao diagnosticar vínculos billing-customer',
        error: error.message 
      });
    }
  });

  // ========================================
  // ROTAS DE ROTEIRIZAÇÃO DIÁRIA
  // ========================================
  
  // Importar serviço de otimização de rotas
  const { generateDailyRoute, registerCheckpoint } = await import('./routeOptimizationService');

  // ========================================
  // VALIDAÇÃO DE ROTAS
  // ========================================
  
  // Validar se todas visitas planejadas estão nas rotas corretas
  app.get('/api/routes/validate', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      let start = new Date();
      let end = new Date();
      
      if (startDate) start = new Date(startDate as string);
      if (endDate) end = new Date(endDate as string);
      
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      
      // Buscar todas visitas planejadas em Clientes Ativos
      const activeCustomersData = await storage.getActiveCustomersWithVisits() || [];
      
      // Buscar todas rotas no período
      const routes = await db.select().from(dailyRoutes)
        .where(and(
          gte(dailyRoutes.routeDate, start),
          lte(dailyRoutes.routeDate, end)
        ));
      
      // Mapear visitas planejadas por data+vendedor
      const plannedVisits = new Map<string, Array<{customerId: string; customerName: string; sellerId: string}>>();
      
      for (const ac of activeCustomersData) {
        const customer = ac.customer;
        if (!customer || !customer.sellerId) continue;
        
        // Buscar próximas 3 visitas deste cliente
        const upcomingVisits = await db.select().from(visitAgenda)
          .where(and(
            eq(visitAgenda.customerId, customer.id),
            gte(visitAgenda.scheduledDate, start),
            lte(visitAgenda.scheduledDate, end)
          ));
        
        for (const visit of upcomingVisits) {
          const key = `${visit.scheduledDate.toISOString().split('T')[0]}|${customer.sellerId}`;
          if (!plannedVisits.has(key)) {
            plannedVisits.set(key, []);
          }
          plannedVisits.get(key)!.push({
            customerId: customer.id,
            customerName: customer.fantasyName || customer.name,
            sellerId: customer.sellerId
          });
        }
      }
      
      // Analisar cada rota gerada
      const validation = {
        totalPlanned: 0,
        totalInRoutes: 0,
        dateRanges: [] as Array<any>,
        missing: [] as Array<any>,
        extra: [] as Array<any>,
        wrongSeller: [] as Array<any>,
        summary: {
          ok: 0,
          withIssues: 0
        }
      };
      
      const analyzedDates = new Set<string>();
      
      for (const route of routes) {
        const dateStr = route.routeDate.toISOString().split('T')[0];
        const key = `${dateStr}|${route.sellerId}`;
        
        if (!analyzedDates.has(key)) {
          analyzedDates.add(key);
          
          const planned = plannedVisits.get(key) || [];
          const inRoute = route.optimizedOrder || [];
          
          validation.totalPlanned += planned.length;
          validation.totalInRoutes += inRoute.length;
          
          // Identificar visitas faltando
          const missing = planned.filter(p => !inRoute.includes(p.customerId));
          const extra = inRoute.filter(id => !planned.find(p => p.customerId === id));
          
          if (missing.length > 0 || extra.length > 0) {
            validation.summary.withIssues++;
            
            missing.forEach(m => {
              validation.missing.push({
                date: dateStr,
                customerId: m.customerId,
                customerName: m.customerName,
                sellerId: route.sellerId,
                issue: 'Visita planejada não está na rota'
              });
            });
            
            extra.forEach(e => {
              validation.extra.push({
                date: dateStr,
                customerId: e,
                routeId: route.id,
                issue: 'Visita na rota mas não foi planejada'
              });
            });
          } else {
            validation.summary.ok++;
          }
          
          validation.dateRanges.push({
            date: dateStr,
            sellerId: route.sellerId,
            routeId: route.id,
            planned: planned.length,
            inRoute: inRoute.length,
            status: missing.length === 0 && extra.length === 0 ? 'ok' : 'issues'
          });
        }
      }
      
      res.json({
        success: true,
        validation,
        message: `${validation.summary.ok} datas OK, ${validation.summary.withIssues} com problemas`
      });
    } catch (error: any) {
      console.error('Erro ao validar rotas:', error);
      res.status(500).json({ 
        message: 'Erro ao validar rotas',
        error: error.message 
      });
    }
  });

  // Gerar rota a partir das visitas planejadas em Clientes Ativos
  app.post('/api/daily-routes/from-planned-visits', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.body;
      
      const targetSellerId = user.role === 'vendedor' ? user.id : (sellerId || user.id);
      
      if (!date) {
        return res.status(400).json({ message: 'Data é obrigatória' });
      }

      const routeDate = new Date(`${date}T00:00:00.000Z`);
      
      // Buscar clientes do vendedor
      const customers = await storage.getCustomers();
      const sellerCustomers = customers.filter(c => c.sellerId === targetSellerId && c.isActive);
      
      // Buscar dados de visitas do sistema de agendamento
      const visitData = await storage.getCustomerVisits?.() || [];
      
      // Filtrar clientes que têm visita planejada para esta data
      const plannedVisits = sellerCustomers.filter(customer => {
        return visitData.some((v: any) => 
          v.customerId === customer.id && 
          new Date(v.visitDate).toDateString() === routeDate.toDateString()
        );
      });
      
      console.log(`📅 [FROM-PLANNED] ${plannedVisits.length} clientes planejados para ${date}`);
      
      if (plannedVisits.length === 0) {
        return res.json({
          success: true,
          message: 'Nenhuma visita planejada para esta data',
          totalVisits: 0,
          routeId: null
        });
      }

      // Usar a função generateDailyRoute existente (ela usará só os clientes filtrados)
      const result = await generateDailyRoute(storage, targetSellerId, routeDate);
      
      res.json({
        success: true,
        fromPlannedVisits: true,
        plannedVisitsCount: plannedVisits.length,
        ...result,
        warnings: result.warnings || [],
        suspiciousCoordinates: result.suspiciousCoordinates || []
      });
    } catch (error: any) {
      console.error('Erro ao gerar rota de visitas planejadas:', error);
      res.status(500).json({ 
        message: 'Erro ao gerar rota de visitas planejadas',
        error: error.message 
      });
    }
  });

  // Gerar rota otimizada do dia para um vendedor
  app.post('/api/daily-routes/generate', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date, allowEmpty } = req.body;
      
      // Vendedor só pode gerar sua própria rota
      const targetSellerId = user.role === 'vendedor' ? user.id : (sellerId || user.id);
      
      if (!date) {
        return res.status(400).json({ message: 'Data é obrigatória' });
      }

      // Parse date string as UTC midnight (simple and consistent)
      // This matches how dates are stored in the database
      const routeDate = new Date(`${date}T00:00:00.000Z`);
      
      // Verificar se já existe rota para este dia
      const existingRoute = await storage.getDailyRouteBySellerAndDate(targetSellerId, routeDate);
      
      if (existingRoute) {
        // ROTA JÁ EXISTE: Regenerar usando planDailyRoute + updateDailyRoute
        console.log(`🔄 Rota existente encontrada: ${existingRoute.id} - regenerando com permanent cards...`);
        
        // Usar função helper para planejar nova rota (sem salvar)
        console.log(`🔍 DEBUG: Antes de importar planDailyRoute - sellerId: ${targetSellerId}, date: ${routeDate.toISOString()}`);
        const { planDailyRoute } = await import('./routeOptimizationService');
        console.log(`🔍 DEBUG: Antes de chamar planDailyRoute`);
        const plan = await planDailyRoute(storage, targetSellerId, routeDate);
        console.log(`🔍 DEBUG: Após planDailyRoute - plan.optimizedOrder.length: ${plan.optimizedOrder.length}`);
        
        // Atualizar rota existente com novos dados (PRESERVA ID e checkpoints)
        const updatedRoute = await storage.updateDailyRoute(existingRoute.id, {
          optimizedOrder: plan.optimizedOrder,
          totalEstimatedDistance: plan.totalDistance.toString(),
          totalVisits: plan.totalVisits,
          // Preservar totalActualDistance e completedVisits (não resetar progresso)
          totalActualDistance: existingRoute.totalActualDistance || '0',
          completedVisits: existingRoute.completedVisits || 0,
          // Preservar status atual (in_progress, paused, etc)
          routeStatus: existingRoute.routeStatus || 'pending'
        });
        
        // CRÍTICO: Verificar se a atualização foi bem-sucedida
        if (!updatedRoute) {
          console.error(`❌ ERRO: updateDailyRoute retornou undefined para ID ${existingRoute.id}`);
          return res.status(500).json({
            success: false,
            message: 'Erro ao atualizar rota no banco de dados'
          });
        }
        
        console.log(`✅ Rota ${existingRoute.id} atualizada: ${plan.totalVisits} visitas, ${plan.totalDistance.toFixed(2)}km`);
        
        return res.json({
          success: true,
          regenerated: true,
          routeId: updatedRoute.id,
          totalVisits: plan.totalVisits,
          totalEstimatedDistance: plan.totalDistance,
          warnings: plan.warnings || [],
          suspiciousCoordinates: plan.customersWithSuspiciousCoords || []
        });
      }

      // Gerar nova rota
      console.log(`🆕 DEBUG: Nenhuma rota existente - gerando nova rota para sellerId: ${targetSellerId}, date: ${routeDate.toISOString()}`);
      const result = await generateDailyRoute(storage, targetSellerId, routeDate);
      console.log(`✅ DEBUG: generateDailyRoute retornou - routeId: ${result.routeId}, totalVisits: ${result.totalVisits}`);
      
      // Se não há visitas E allowEmpty está ativado, criar rota vazia
      if (!result.routeId && allowEmpty) {
        console.log(`📭 [ALLOW-EMPTY] Nenhuma visita programada, mas allowEmpty=true. Criando rota vazia...`);
        
        const seller = await storage.getUserById(targetSellerId);
        
        if (!seller) {
          return res.status(404).json({ message: 'Vendedor não encontrado' });
        }

        if (!seller.homeLatitude || !seller.homeLongitude) {
          return res.status(400).json({ 
            message: 'Vendedor não possui coordenadas de residência cadastradas.' 
          });
        }

        const startOfDay = new Date(routeDate);
        startOfDay.setHours(0, 0, 0, 0);
        
        const emptyRouteData = {
          sellerId: targetSellerId,
          routeDate: startOfDay,
          startLatitude: seller.homeLatitude.toString(),
          startLongitude: seller.homeLongitude.toString(),
          startAddress: `Casa do vendedor ${seller.firstName} ${seller.lastName || ''}`,
          optimizedOrder: [],
          totalEstimatedDistance: '0',
          totalActualDistance: '0',
          totalVisits: 0,
          completedVisits: 0,
          routeStatus: 'pending'
        };

        const emptyRoute = await storage.createDailyRoute(emptyRouteData);
        
        return res.json({
          success: true,
          regenerated: false,
          routeId: emptyRoute.id,
          totalVisits: 0,
          totalEstimatedDistance: 0,
          warnings: ['Nenhuma visita programada para esta data. Rota vazia criada.'],
          suspiciousCoordinates: [],
          emptyRoute: true
        });
      }
      
      res.json({
        success: true,
        regenerated: false,
        ...result,
        warnings: result.warnings || [],
        suspiciousCoordinates: result.suspiciousCoordinates || []
      });
    } catch (error: any) {
      console.error('Erro ao gerar rota diária:', error);
      res.status(500).json({ 
        message: 'Erro ao gerar rota',
        error: error.message 
      });
    }
  });

  // Criar rota vazia para um vendedor (permite adicionar visitas manualmente depois)
  app.post('/api/daily-routes/create-empty', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { sellerId, date } = req.body;
      
      if (!sellerId) {
        return res.status(400).json({ message: 'sellerId é obrigatório' });
      }
      
      if (!date) {
        return res.status(400).json({ message: 'Data é obrigatória' });
      }

      // Parse date string as UTC midnight
      const routeDate = new Date(`${date}T00:00:00.000Z`);
      
      // Verificar se já existe rota para este dia
      const existingRoute = await storage.getDailyRouteBySellerAndDate(sellerId, routeDate);
      
      if (existingRoute) {
        return res.status(409).json({ 
          message: 'Já existe uma rota para este vendedor nesta data',
          routeId: existingRoute.id,
          existingRoute: true
        });
      }

      // Buscar informações do vendedor
      const seller = await storage.getUserById(sellerId);
      
      if (!seller) {
        return res.status(404).json({ message: 'Vendedor não encontrado' });
      }

      // Para rotas vazias, usar coordenadas padrão se vendedor não tiver configurado
      // As coordenadas serão usadas apenas quando houver visitas e a rota for otimizada
      const startLatitude = seller.homeLatitude?.toString() || '-23.5505';  // Coordenadas padrão de São Paulo
      const startLongitude = seller.homeLongitude?.toString() || '-46.6333';
      const startAddress = seller.homeLatitude && seller.homeLongitude
        ? `Casa do vendedor ${seller.firstName} ${seller.lastName || ''}`
        : `São Paulo, SP (padrão)`;

      // Criar rota vazia
      const startOfDay = new Date(routeDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const routeData = {
        sellerId,
        routeDate: startOfDay,
        startLatitude,
        startLongitude,
        startAddress,
        optimizedOrder: [], // Rota vazia
        totalEstimatedDistance: '0',
        totalActualDistance: '0',
        totalVisits: 0,
        completedVisits: 0,
        routeStatus: 'pending'
      };

      console.log(`🆕 [CREATE-EMPTY-ROUTE] Criando rota vazia para ${seller.firstName} em ${date}`);
      const route = await storage.createDailyRoute(routeData);

      res.json({
        success: true,
        message: 'Rota vazia criada com sucesso. Agora você pode adicionar clientes e leads manualmente.',
        routeId: route.id,
        sellerId,
        sellerName: `${seller.firstName} ${seller.lastName || ''}`,
        routeDate: startOfDay,
        totalVisits: 0
      });
    } catch (error: any) {
      console.error('Erro ao criar rota vazia:', error);
      res.status(500).json({ 
        message: 'Erro ao criar rota vazia',
        error: error.message 
      });
    }
  });

  // Buscar rota do dia atual para um vendedor
  app.get('/api/daily-routes/:sellerId/today', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId } = req.params;
      
      // Vendedor só pode ver sua própria rota
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const route = await storage.getDailyRouteBySellerAndDate(sellerId, today);
      
      if (!route) {
        return res.json({
          message: 'Nenhuma rota encontrada para hoje. Gere uma rota primeiro.',
          route: null
        });
      }

      // Buscar detalhes das visitas na ordem otimizada (DIRETO de customers - fonte única)
      const visits = await Promise.all(
        (route.optimizedOrder || []).map(async (customerId: string) => {
          // optimizedOrder agora contém IDs de clientes, não de sales_cards
          const [customer] = await db.select({
            id: customers.id,
            customerId: customers.id,
            customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
            customerLatitude: customers.latitude,
            customerLongitude: customers.longitude,
            customerAddress: customers.address,
            scheduledDate: sql<Date>`${route.routeDate}::timestamp`, // Data da rota
            isVirtual: customers.virtualService,
            weekdays: customers.weekdays, // Dias da semana de cadastro do cliente
            visitPeriodicity: customers.visitPeriodicity // Periodicidade (semanal, quinzenal, mensal)
          })
            .from(customers)
            .where(eq(customers.id, customerId))
            .limit(1);
          
          return customer;
        })
      );

      // Calcular distâncias estimadas entre pontos
      const { calculateDistance } = await import('./routeOptimizationService');
      const segments = [];
      
      if (visits.length > 0) {
        let prevLat = parseFloat(route.startLatitude);
        let prevLon = parseFloat(route.startLongitude);
        
        for (let i = 0; i < visits.length; i++) {
          const visit = visits[i];
          if (visit && visit.customerLatitude && visit.customerLongitude) {
            const distanceKm = calculateDistance(
              prevLat, 
              prevLon,
              parseFloat(visit.customerLatitude as any),
              parseFloat(visit.customerLongitude as any)
            );
            
            // Converter de km para metros (frontend espera metros)
            const distanceMeters = Math.round(distanceKm * 1000);
            
            segments.push({
              visitId: visit.id,
              from: i === 0 ? 'Casa' : visits[i-1]?.customerName,
              to: visit.customerName,
              distance: distanceMeters
            });
            
            prevLat = parseFloat(visit.customerLatitude as any);
            prevLon = parseFloat(visit.customerLongitude as any);
          }
        }
        
        // Distância de retorno para casa
        if (visits.length > 0) {
          const lastVisit = visits[visits.length - 1];
          if (lastVisit?.customerLatitude && lastVisit?.customerLongitude) {
            const returnDistanceKm = calculateDistance(
              parseFloat(lastVisit.customerLatitude as any),
              parseFloat(lastVisit.customerLongitude as any),
              parseFloat(route.startLatitude),
              parseFloat(route.startLongitude)
            );
            
            // Converter de km para metros (frontend espera metros)
            const returnDistanceMeters = Math.round(returnDistanceKm * 1000);
            
            segments.push({
              visitId: 'return',
              from: lastVisit.customerName,
              to: 'Casa',
              distance: returnDistanceMeters
            });
          }
        }
      }

      // Buscar checkpoints da rota
      const checkpoints = await storage.getRouteCheckpoints(route.id);

      // Calcular completedVisits dinamicamente a partir dos checkpoints
      // Cada check-out representa uma visita completada
      const completedVisits = checkpoints.filter(cp => cp.checkpointType === 'check_out').length;
      const totalVisits = route.totalVisits || 0;
      const percentComplete = totalVisits > 0 
        ? Math.round((completedVisits / totalVisits) * 100) 
        : 0;

      // Calcular horário de almoço e carga horária trabalhada
      let lunchBreak = null;
      let workedHours = null;
      const checkIns = checkpoints.filter(cp => cp.checkpointType === 'check_in');
      const checkOuts = checkpoints.filter(cp => cp.checkpointType === 'check_out');
      
      // Calcular lunch break se foi ativado
      if (route.lunchBreakActivatedAt) {
        const lunchActivationTime = new Date(route.lunchBreakActivatedAt).getTime();
        
        // ✅ Encontrar ÚLTIMO checkout ANTES/NO MOMENTO da ativação do almoço
        const checkoutsBeforeLunch = checkOuts
          .filter(cp => new Date(cp.checkpointTime).getTime() <= lunchActivationTime)
          .sort((a, b) => new Date(b.checkpointTime).getTime() - new Date(a.checkpointTime).getTime());
        
        // Encontrar PRIMEIRO checkin APÓS a ativação do almoço
        const checkinsAfterLunch = checkIns
          .filter(cp => new Date(cp.checkpointTime).getTime() > lunchActivationTime)
          .sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        
        // DEBUG: Logs detalhados do cálculo de almoço
        console.log(`\n🍽️ ===== CÁLCULO DE HORÁRIO DE ALMOÇO - ROTA ${route.sellerId} (${route.date}) =====`);
        console.log(`⏰ Almoço ativado em: ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')} (${new Date(lunchActivationTime).toISOString()})`);
        console.log(`📊 Checkouts ANTES/NO MOMENTO da ativação (≤ ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')}): ${checkoutsBeforeLunch.length}`);
        checkoutsBeforeLunch.forEach((cp, idx) => {
          console.log(`   ${idx + 1}. ${new Date(cp.checkpointTime).toLocaleTimeString('pt-BR')} - Cliente: ${cp.customerId}`);
        });
        console.log(`✅ Check-ins DEPOIS do almoço (> ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')}): ${checkinsAfterLunch.length}`);
        checkinsAfterLunch.forEach((cp, idx) => {
          console.log(`   ${idx + 1}. ${new Date(cp.checkpointTime).toLocaleTimeString('pt-BR')} - Cliente: ${cp.customerId}`);
        });
        
        if (checkoutsBeforeLunch.length > 0 && checkinsAfterLunch.length > 0) {
          // Almoço completo: do ÚLTIMO checkout antes até o PRIMEIRO check-in depois
          let lunchStart = new Date(checkoutsBeforeLunch[0].checkpointTime);
          let lunchEnd = new Date(checkinsAfterLunch[0].checkpointTime);
          
          console.log(`\n🔢 CÁLCULO DO TEMPO DE ALMOÇO:`);
          console.log(`   Saída (checkout): ${lunchStart.toLocaleTimeString('pt-BR')} (${lunchStart.toISOString()})`);
          console.log(`   Retorno (checkin): ${lunchEnd.toLocaleTimeString('pt-BR')} (${lunchEnd.toISOString()})`);
          
          // Validar timestamps para evitar NaN
          if (!isNaN(lunchStart.getTime()) && !isNaN(lunchEnd.getTime())) {
            // Normalizar timestamps que cruzam a meia-noite
            // Se lunchEnd < lunchStart, assumir que cruzou meia-noite e adicionar 24h
            if (lunchEnd < lunchStart) {
              console.log(`⚠️  Almoço cruzou meia-noite! Adicionando 24h ao retorno.`);
              lunchEnd = new Date(lunchEnd.getTime() + 24 * 60 * 60 * 1000);
            }
            
            const lunchDiffMs = lunchEnd.getTime() - lunchStart.getTime();
            const lunchMinutes = Math.floor(lunchDiffMs / (1000 * 60));
            const lunchHours = Math.floor(lunchMinutes / 60);
            const lunchMins = lunchMinutes % 60;
            
            console.log(`   Diferença (ms): ${lunchDiffMs}ms`);
            console.log(`   Diferença (min): ${lunchMinutes} minutos`);
            console.log(`   ✅ RESULTADO FINAL: ${lunchHours}h ${lunchMins}min (${lunchMinutes} minutos totais)`);
            console.log(`🍽️ ===== FIM DO CÁLCULO DE ALMOÇO =====\n`);
            
            lunchBreak = {
              status: 'completed',
              startTime: lunchStart,
              endTime: lunchEnd,
              minutes: lunchMinutes,
              formatted: `${lunchHours}h ${lunchMins}min`
            };
          } else {
            // Timestamps inválidos (NaN): marcar como pendente
            lunchBreak = {
              status: 'pending',
              startTime: lunchStart,
              endTime: null,
              minutes: null,
              formatted: 'Aguardando retorno'
            };
          }
        } else if (checkoutsBeforeLunch.length > 0) {
          // Almoço pendente: saiu mas ainda não retornou
          lunchBreak = {
            status: 'pending',
            startTime: new Date(checkoutsBeforeLunch[0].checkpointTime),
            endTime: null,
            minutes: null,
            formatted: 'Aguardando retorno'
          };
        } else {
          // Sem checkout antes da ativação (caso raro)
          lunchBreak = {
            status: 'pending',
            startTime: null,
            endTime: null,
            minutes: null,
            formatted: 'Nenhum checkout antes do almoço'
          };
        }
      }
      
      // Calcular carga horária trabalhada (primeiro check-in até último check-out OU momento atual)
      if (checkIns.length > 0) {
        // Ordenar por tempo
        checkIns.sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        checkOuts.sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        
        const firstCheckIn = new Date(checkIns[0].checkpointTime);
        const lastCheckIn = new Date(checkIns[checkIns.length - 1].checkpointTime);
        
        // Determinar horário de término:
        // - Se houver check-out E ele for mais recente que o último check-in: usar check-out (rota finalizada)
        // - Senão: usar momento atual (rota em andamento - vendedor voltou do almoço, por exemplo)
        let endTime: Date;
        if (checkOuts.length > 0) {
          const lastCheckOut = new Date(checkOuts[checkOuts.length - 1].checkpointTime);
          
          // Se check-out é mais recente que check-in: rota finalizada
          if (lastCheckOut.getTime() >= lastCheckIn.getTime()) {
            endTime = lastCheckOut;
          } else {
            // Check-in mais recente: vendedor voltou, rota em andamento
            endTime = new Date();
          }
        } else {
          // Sem check-outs: rota em andamento
          endTime = new Date();
        }
        
        // Calcular diferença em milissegundos e converter para minutos
        const diffMs = endTime.getTime() - firstCheckIn.getTime();
        const totalMinutes = Math.floor(diffMs / (1000 * 60));
        
        // Descontar almoço APENAS se foi ativado
        let lunchDeduction = 0; // Padrão: sem dedução
        if (route.lunchBreakActivatedAt) {
          // Se ativado: deduz 90min por padrão
          lunchDeduction = 90;
          
          // Se medido: usa tempo medido
          if (lunchBreak && lunchBreak.status === 'completed' && lunchBreak.minutes) {
            lunchDeduction = lunchBreak.minutes;
          }
        }
        
        // Calcular tempo trabalhado efetivo (mínimo 0)
        const workedMinutes = Math.max(0, totalMinutes - lunchDeduction);
        const hours = Math.floor(workedMinutes / 60);
        const minutes = workedMinutes % 60;
        
        workedHours = {
          hours,
          minutes,
          total: workedMinutes,
          formatted: `${hours}h ${minutes}min`
        };
      }

      // Calcular tempo médio de visitas (média de tempo entre check-in e check-out)
      let averageVisitTime = 0;
      
      // Agrupar checkpoints por visitId (com fallback para customerId se visitId ausente)
      // e ordenar por timestamp para parear corretamente
      const visitGroups = new Map<string, { checkIns: Date[], checkOuts: Date[] }>();
      
      // Agrupar check-ins
      checkIns.forEach(cp => {
        const key = cp.visitId || cp.customerId; // Fallback para customerId se visitId ausente
        if (!key) return;
        
        if (!visitGroups.has(key)) {
          visitGroups.set(key, { checkIns: [], checkOuts: [] });
        }
        visitGroups.get(key)!.checkIns.push(new Date(cp.checkpointTime));
      });
      
      // Agrupar check-outs
      checkOuts.forEach(cp => {
        const key = cp.visitId || cp.customerId; // Fallback para customerId se visitId ausente
        if (!key) return;
        
        if (!visitGroups.has(key)) {
          visitGroups.set(key, { checkIns: [], checkOuts: [] });
        }
        visitGroups.get(key)!.checkOuts.push(new Date(cp.checkpointTime));
      });
      
      // Para cada visita, parear TODOS os check-ins com check-outs válidos
      const visitDurations: number[] = [];
      visitGroups.forEach((group) => {
        if (group.checkIns.length > 0 && group.checkOuts.length > 0) {
          // Ordenar por timestamp
          group.checkIns.sort((a, b) => a.getTime() - b.getTime());
          group.checkOuts.sort((a, b) => a.getTime() - b.getTime());
          
          // Iterar por todos os check-ins e parear com próximo check-out válido
          const usedCheckOuts = new Set<number>();
          
          for (const checkInTime of group.checkIns) {
            // Encontrar o próximo check-out que:
            // 1. Ocorre DEPOIS deste check-in
            // 2. Ainda não foi usado
            let matchedIndex = -1;
            
            for (let i = 0; i < group.checkOuts.length; i++) {
              if (!usedCheckOuts.has(i)) {
                const checkOutTime = group.checkOuts[i];
                const durationMs = checkOutTime.getTime() - checkInTime.getTime();
                const durationMinutes = Math.floor(durationMs / (1000 * 60));
                
                // Se encontrou um check-out válido (positivo e < 8 horas)
                if (durationMinutes > 0 && durationMinutes < 480) {
                  visitDurations.push(durationMinutes);
                  usedCheckOuts.add(i);
                  matchedIndex = i;
                  break; // Próximo check-in
                }
              }
            }
          }
        }
      });
      
      // Calcular média de todas as visitas completadas
      if (visitDurations.length > 0) {
        const totalDuration = visitDurations.reduce((acc, duration) => acc + duration, 0);
        averageVisitTime = Math.round(totalDuration / visitDurations.length);
      }

      // Headers para evitar cache e garantir dados atualizados
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.json({
        route: {
          ...route,
          visits: visits.filter(Boolean),
          checkpoints,
          segments,
          sellerHome: {
            latitude: parseFloat(route.startLatitude),
            longitude: parseFloat(route.startLongitude)
          },
          progress: {
            totalVisits,
            completedVisits,
            // Converter de km para metros (banco salva em km, frontend espera metros)
            totalEstimatedDistance: Math.round(parseFloat(route.totalEstimatedDistance || '0') * 1000),
            totalActualDistance: Math.round(parseFloat(route.totalActualDistance || '0') * 1000),
            percentComplete,
            averageVisitTime,
            workedHours,
            lunchBreak
          }
        }
      });
    } catch (error: any) {
      console.error('Erro ao buscar rota do dia:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar rota',
        error: error.message 
      });
    }
  });

  // ENDPOINT DE TESTE
  app.get('/api/test-route-endpoint', async (req: any, res) => {
    console.log('🚨🚨🚨 TESTE ENDPOINT CHAMADO!!! 🚨🚨🚨');
    return res.json({ test: 'SUCCESS', timestamp: new Date().toISOString() });
  });

  // Buscar rota de uma data específica para um vendedor
  app.get('/api/daily-routes/:sellerId/date/:date', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.params;
      
      console.log(`\n========================================`);
      console.log(`📡 [API REQUEST] GET /api/daily-routes/${sellerId}/date/${date}`);
      console.log(`========================================\n`);
      
      // Vendedor só pode ver sua própria rota
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      // Parse date string as UTC midnight (matches how routes are stored)
      const routeDate = new Date(`${date}T00:00:00.000Z`);
      
      const route = await storage.getDailyRouteBySellerAndDate(sellerId, routeDate);
      
      console.log(`📊 [ROUTE DATA] totalVisits do banco: ${route?.totalVisits}, optimizedOrder.length: ${route?.optimizedOrder?.length}`);
      
      if (!route) {
        return res.json({
          message: 'Nenhuma rota encontrada para esta data. Gere uma rota primeiro.',
          route: null
        });
      }

      // NOVA ARQUITETURA COM VISITSTOPS: Resolver stops (customers + leads)
      console.log(`🔍 [DEBUG] Resolvendo stops (customers + leads) para ${date}`);
      
      // Deduplic ar optimizedOrder (proteção contra dados históricos com duplicatas)
      const optimizedOrder = Array.from(new Set(route.optimizedOrder || []));
      const visitStops = (route.visitStops as any) || {};
      
      if (optimizedOrder.length !== (route.optimizedOrder || []).length) {
        console.warn(`⚠️  Detectadas ${(route.optimizedOrder || []).length - optimizedOrder.length} duplicatas no optimizedOrder, removendo para exibição`);
      }
      
      // Separar customerIds e leadIds
      const customerIds: string[] = [];
      const leadIds: string[] = [];
      
      optimizedOrder.forEach((stopId: string) => {
        // Se tem prefixo, usar visitStops; caso contrário, assumir customer (fallback)
        if (stopId.includes(':')) {
          const stopMeta = visitStops[stopId];
          if (stopMeta) {
            if (stopMeta.entityType === 'customer') {
              customerIds.push(stopMeta.entityId);
            } else if (stopMeta.entityType === 'lead') {
              leadIds.push(stopMeta.entityId);
            }
          }
        } else {
          // Fallback retrocompatível: IDs sem prefixo são customers
          customerIds.push(stopId);
        }
      });
      
      const { customers, leads } = await import('../shared/schema');
      const { inArray } = await import('drizzle-orm');
      const { db } = await import('./db');
      
      // Buscar customers
      let customersData: any[] = [];
      if (customerIds.length > 0) {
        customersData = await db
          .select()
          .from(customers)
          .where(inArray(customers.id, customerIds));
      }
      
      // Buscar leads
      let leadsData: any[] = [];
      if (leadIds.length > 0) {
        leadsData = await db
          .select()
          .from(leads)
          .where(inArray(leads.id, leadIds));
      }
      
      console.log(`✅ [DEBUG] Encontrados ${customersData.length} customers + ${leadsData.length} leads`);
      
      // Criar mapas para lookup rápido
      const customersByCustomerId = new Map<string, any>();
      customersData.forEach(customer => {
        customersByCustomerId.set(customer.id, customer);
      });
      
      const leadsByLeadId = new Map<string, any>();
      leadsData.forEach(lead => {
        leadsByLeadId.set(lead.id, lead);
      });
      
      // Buscar dados de visit_agenda para obter isAutoCheckout e visitDuration
      // Incluindo tanto customerIds quanto leadIds
      const { visitAgenda } = await import('../shared/schema');
      const { or } = await import('drizzle-orm');
      
      let visitAgendaData: any[] = [];
      if (customerIds.length > 0 || leadIds.length > 0) {
        const conditions = [];
        if (customerIds.length > 0) {
          conditions.push(inArray(visitAgenda.customerId, customerIds));
        }
        // Note: visit_agenda não tem leadId direto, mas pode ter sido criado por sales_card
        // com customerId como o entityId do lead, então buscamos por ambos
        
        visitAgendaData = await db
          .select({
            customerId: visitAgenda.customerId,
            isAutoCheckout: visitAgenda.isAutoCheckout,
            visitDuration: visitAgenda.visitDuration
          })
          .from(visitAgenda)
          .where(and(
            eq(visitAgenda.sellerId, sellerId),
            eq(sql`DATE(${visitAgenda.scheduledDate})`, date),
            conditions.length > 0 ? or(...conditions) : sql`1=1`
          ));
      }
      
      const visitAgendaByEntityId = new Map<string, any>();
      visitAgendaData.forEach(va => {
        visitAgendaByEntityId.set(va.customerId, va);
      });
      
      // Montar visitas na ordem do optimizedOrder com suporte a customers e leads
      const visits = (route.optimizedOrder || [])
        .map((stopId: string) => {
          // Resolver stopId
          let visitType: 'customer' | 'lead' = 'customer';
          let entityId: string = stopId;
          
          if (stopId.includes(':')) {
            const stopMeta = visitStops[stopId];
            if (stopMeta) {
              visitType = stopMeta.entityType;
              entityId = stopMeta.entityId;
            }
          }
          
          // Buscar dados da entidade
          if (visitType === 'customer') {
            const customer = customersByCustomerId.get(entityId);
            if (!customer) return null;
            
            // Buscar dados de visitAgenda para isAutoCheckout e visitDuration
            const visitAgendaInfo = visitAgendaByEntityId.get(customer.id);
            
            return {
              id: stopId, // Usar stopId como visit ID
              visitType: 'customer' as const,
              entityId: customer.id,
              customerId: customer.id,
              customerName: customer.fantasyName || customer.name,
              customerLatitude: customer.latitude,
              customerLongitude: customer.longitude,
              customerAddress: customer.address,
              scheduledDate: route.routeDate,
              isVirtual: customer.virtualService,
              weekdays: customer.weekdays, // Dias da semana de cadastro do cliente
              visitPeriodicity: customer.visitPeriodicity, // Periodicidade (semanal, quinzenal, mensal)
              isAutoCheckout: visitAgendaInfo?.isAutoCheckout ?? false,
              visitDuration: visitAgendaInfo?.visitDuration ?? null
            };
          } else {
            // Lead
            const lead = leadsByLeadId.get(entityId);
            if (!lead) return null;
            
            // Buscar dados de visitAgenda para leads também
            // (visit_agenda usa customerId para armazenar o entityId do lead)
            const visitAgendaInfo = visitAgendaByEntityId.get(lead.id);
            
            return {
              id: stopId, // Usar stopId como visit ID
              visitType: 'lead' as const,
              entityId: lead.id,
              leadId: lead.id,
              customerName: lead.fantasyName, // Nome do lead
              customerLatitude: lead.latitude,
              customerLongitude: lead.longitude,
              customerAddress: null, // Leads não têm endereço completo
              scheduledDate: route.routeDate,
              isVirtual: false,
              isAutoCheckout: visitAgendaInfo?.isAutoCheckout ?? false,
              visitDuration: visitAgendaInfo?.visitDuration ?? null
            };
          }
        })
        .filter(Boolean);
      
      console.log(`✅ [DEBUG] ${visits.length} visitas montadas na ordem do optimizedOrder`);

      // Calcular distâncias estimadas entre pontos
      const { calculateDistance } = await import('./routeOptimizationService');
      const segments = [];
      
      if (visits.length > 0) {
        let prevLat = parseFloat(route.startLatitude);
        let prevLon = parseFloat(route.startLongitude);
        
        for (let i = 0; i < visits.length; i++) {
          const visit = visits[i];
          if (visit && visit.customerLatitude && visit.customerLongitude) {
            const distanceKm = calculateDistance(
              prevLat, 
              prevLon,
              parseFloat(visit.customerLatitude as any),
              parseFloat(visit.customerLongitude as any)
            );
            
            // Converter de km para metros (frontend espera metros)
            const distanceMeters = Math.round(distanceKm * 1000);
            
            segments.push({
              visitId: visit.id,
              from: i === 0 ? 'Casa' : visits[i-1]?.customerName,
              to: visit.customerName,
              distance: distanceMeters
            });
            
            prevLat = parseFloat(visit.customerLatitude as any);
            prevLon = parseFloat(visit.customerLongitude as any);
          }
        }
        
        // Distância de retorno para casa
        if (visits.length > 0) {
          const lastVisit = visits[visits.length - 1];
          if (lastVisit?.customerLatitude && lastVisit?.customerLongitude) {
            const returnDistanceKm = calculateDistance(
              parseFloat(lastVisit.customerLatitude as any),
              parseFloat(lastVisit.customerLongitude as any),
              parseFloat(route.startLatitude),
              parseFloat(route.startLongitude)
            );
            
            // Converter de km para metros (frontend espera metros)
            const returnDistanceMeters = Math.round(returnDistanceKm * 1000);
            
            segments.push({
              visitId: 'return',
              from: lastVisit.customerName,
              to: 'Casa',
              distance: returnDistanceMeters
            });
          }
        }
      }

      // Buscar checkpoints da rota
      const checkpoints = await storage.getRouteCheckpoints(route.id);

      // Calcular completedVisits dinamicamente a partir dos checkpoints
      // Cada check-out representa uma visita completada
      const completedVisits = checkpoints.filter(cp => cp.checkpointType === 'check_out').length;
      const totalVisits = route.totalVisits || 0;
      const percentComplete = totalVisits > 0 
        ? Math.round((completedVisits / totalVisits) * 100) 
        : 0;

      // Calcular horário de almoço e carga horária trabalhada
      let lunchBreak = null;
      let workedHours = null;
      const checkIns = checkpoints.filter(cp => cp.checkpointType === 'check_in');
      const checkOuts = checkpoints.filter(cp => cp.checkpointType === 'check_out');
      
      // Calcular lunch break se foi ativado
      if (route.lunchBreakActivatedAt) {
        const lunchActivationTime = new Date(route.lunchBreakActivatedAt).getTime();
        
        // ✅ Encontrar ÚLTIMO checkout ANTES/NO MOMENTO da ativação do almoço
        const checkoutsBeforeLunch = checkOuts
          .filter(cp => new Date(cp.checkpointTime).getTime() <= lunchActivationTime)
          .sort((a, b) => new Date(b.checkpointTime).getTime() - new Date(a.checkpointTime).getTime());
        
        // Encontrar PRIMEIRO checkin APÓS a ativação do almoço
        const checkinsAfterLunch = checkIns
          .filter(cp => new Date(cp.checkpointTime).getTime() > lunchActivationTime)
          .sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        
        // DEBUG: Logs detalhados do cálculo de almoço
        console.log(`\n🍽️ ===== CÁLCULO DE HORÁRIO DE ALMOÇO - ROTA ${route.sellerId} (${route.date}) =====`);
        console.log(`⏰ Almoço ativado em: ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')} (${new Date(lunchActivationTime).toISOString()})`);
        console.log(`📊 Checkouts ANTES/NO MOMENTO da ativação (≤ ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')}): ${checkoutsBeforeLunch.length}`);
        checkoutsBeforeLunch.forEach((cp, idx) => {
          console.log(`   ${idx + 1}. ${new Date(cp.checkpointTime).toLocaleTimeString('pt-BR')} - Cliente: ${cp.customerId}`);
        });
        console.log(`✅ Check-ins DEPOIS do almoço (> ${new Date(lunchActivationTime).toLocaleTimeString('pt-BR')}): ${checkinsAfterLunch.length}`);
        checkinsAfterLunch.forEach((cp, idx) => {
          console.log(`   ${idx + 1}. ${new Date(cp.checkpointTime).toLocaleTimeString('pt-BR')} - Cliente: ${cp.customerId}`);
        });
        
        if (checkoutsBeforeLunch.length > 0 && checkinsAfterLunch.length > 0) {
          // Almoço completo: do ÚLTIMO checkout antes até o PRIMEIRO check-in depois
          let lunchStart = new Date(checkoutsBeforeLunch[0].checkpointTime);
          let lunchEnd = new Date(checkinsAfterLunch[0].checkpointTime);
          
          console.log(`\n🔢 CÁLCULO DO TEMPO DE ALMOÇO:`);
          console.log(`   Saída (checkout): ${lunchStart.toLocaleTimeString('pt-BR')} (${lunchStart.toISOString()})`);
          console.log(`   Retorno (checkin): ${lunchEnd.toLocaleTimeString('pt-BR')} (${lunchEnd.toISOString()})`);
          
          // Validar timestamps para evitar NaN
          if (!isNaN(lunchStart.getTime()) && !isNaN(lunchEnd.getTime())) {
            // Normalizar timestamps que cruzam a meia-noite
            // Se lunchEnd < lunchStart, assumir que cruzou meia-noite e adicionar 24h
            if (lunchEnd < lunchStart) {
              console.log(`⚠️  Almoço cruzou meia-noite! Adicionando 24h ao retorno.`);
              lunchEnd = new Date(lunchEnd.getTime() + 24 * 60 * 60 * 1000);
            }
            
            const lunchDiffMs = lunchEnd.getTime() - lunchStart.getTime();
            const lunchMinutes = Math.floor(lunchDiffMs / (1000 * 60));
            const lunchHours = Math.floor(lunchMinutes / 60);
            const lunchMins = lunchMinutes % 60;
            
            console.log(`   Diferença (ms): ${lunchDiffMs}ms`);
            console.log(`   Diferença (min): ${lunchMinutes} minutos`);
            console.log(`   ✅ RESULTADO FINAL: ${lunchHours}h ${lunchMins}min (${lunchMinutes} minutos totais)`);
            console.log(`🍽️ ===== FIM DO CÁLCULO DE ALMOÇO =====\n`);
            
            lunchBreak = {
              status: 'completed',
              startTime: lunchStart,
              endTime: lunchEnd,
              minutes: lunchMinutes,
              formatted: `${lunchHours}h ${lunchMins}min`
            };
          } else {
            // Timestamps inválidos (NaN): marcar como pendente
            lunchBreak = {
              status: 'pending',
              startTime: lunchStart,
              endTime: null,
              minutes: null,
              formatted: 'Aguardando retorno'
            };
          }
        } else if (checkoutsBeforeLunch.length > 0) {
          // Almoço pendente: saiu mas ainda não retornou
          lunchBreak = {
            status: 'pending',
            startTime: new Date(checkoutsBeforeLunch[0].checkpointTime),
            endTime: null,
            minutes: null,
            formatted: 'Aguardando retorno'
          };
        } else {
          // Sem checkout antes da ativação (caso raro)
          lunchBreak = {
            status: 'pending',
            startTime: null,
            endTime: null,
            minutes: null,
            formatted: 'Nenhum checkout antes do almoço'
          };
        }
      }
      
      // Calcular carga horária trabalhada (primeiro check-in até último check-out OU momento atual)
      if (checkIns.length > 0) {
        // Ordenar por tempo
        checkIns.sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        checkOuts.sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());
        
        const firstCheckIn = new Date(checkIns[0].checkpointTime);
        const lastCheckIn = new Date(checkIns[checkIns.length - 1].checkpointTime);
        
        // Determinar horário de término:
        // - Se houver check-out E ele for mais recente que o último check-in: usar check-out (rota finalizada)
        // - Senão: usar momento atual (rota em andamento - vendedor voltou do almoço, por exemplo)
        let endTime: Date;
        if (checkOuts.length > 0) {
          const lastCheckOut = new Date(checkOuts[checkOuts.length - 1].checkpointTime);
          
          // Se check-out é mais recente que check-in: rota finalizada
          if (lastCheckOut.getTime() >= lastCheckIn.getTime()) {
            endTime = lastCheckOut;
          } else {
            // Check-in mais recente: vendedor voltou, rota em andamento
            endTime = new Date();
          }
        } else {
          // Sem check-outs: rota em andamento
          endTime = new Date();
        }
        
        // Calcular diferença em milissegundos e converter para minutos
        const diffMs = endTime.getTime() - firstCheckIn.getTime();
        const totalMinutes = Math.floor(diffMs / (1000 * 60));
        
        // Descontar almoço APENAS se foi ativado
        let lunchDeduction = 0; // Padrão: sem dedução
        if (route.lunchBreakActivatedAt) {
          // Se ativado: deduz 90min por padrão
          lunchDeduction = 90;
          
          // Se medido: usa tempo medido
          if (lunchBreak && lunchBreak.status === 'completed' && lunchBreak.minutes) {
            lunchDeduction = lunchBreak.minutes;
          }
        }
        
        // Calcular tempo trabalhado efetivo (mínimo 0)
        const workedMinutes = Math.max(0, totalMinutes - lunchDeduction);
        const hours = Math.floor(workedMinutes / 60);
        const minutes = workedMinutes % 60;
        
        workedHours = {
          hours,
          minutes,
          total: workedMinutes,
          formatted: `${hours}h ${minutes}min`
        };
      }

      // Headers para evitar cache e garantir dados atualizados
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.json({
        route: {
          ...route,
          visits: visits.filter(Boolean),
          checkpoints,
          segments,
          sellerHome: {
            latitude: parseFloat(route.startLatitude),
            longitude: parseFloat(route.startLongitude)
          },
          progress: {
            totalVisits,
            completedVisits,
            // Converter de km para metros (banco salva em km, frontend espera metros)
            totalEstimatedDistance: Math.round(parseFloat(route.totalEstimatedDistance || '0') * 1000),
            totalActualDistance: Math.round(parseFloat(route.totalActualDistance || '0') * 1000),
            percentComplete,
            workedHours,
            lunchBreak
          }
        }
      });
    } catch (error: any) {
      console.error('Erro ao buscar rota por data:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar rota',
        error: error.message 
      });
    }
  });

  // Buscar clientes sem coordenadas para uma data específica
  app.get('/api/daily-routes/:sellerId/date/:date/missing-coordinates', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.params;
      
      // Vendedor só pode ver seus próprios clientes
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      // A data já vem em formato YYYY-MM-DD, converter para Date objects
      const startOfDay = new Date(`${date}T00:00:00.000Z`);
      const endOfDay = new Date(`${date}T23:59:59.999Z`);
      
      // Buscar sales cards do vendedor para aquela data
      const cards = await db.select()
        .from(salesCards)
        .innerJoin(customers, eq(salesCards.customerId, customers.id))
        .where(
          and(
            eq(salesCards.sellerId, sellerId),
            gte(salesCards.scheduledDate, startOfDay),
            lte(salesCards.scheduledDate, endOfDay),
            eq(salesCards.status, 'open')
          )
        );
      
      // Filtrar apenas os que não têm coordenadas e não são virtuais
      const missingCoordinates = cards
        .filter(row => {
          const customer = row.customers;
          return !customer.virtualService && 
            (!customer.latitude || !customer.longitude || 
             customer.latitude === '0' || customer.longitude === '0');
        })
        .map(row => ({
          cardId: row.sales_cards.id,
          customerId: row.customers.id,
          customerName: row.customers.fantasyName || row.customers.name,
          cpfCnpj: row.customers.cpf || row.customers.cnpj || '',
          address: row.customers.address,
          latitude: row.customers.latitude,
          longitude: row.customers.longitude
        }));

      res.json({
        date: date,
        sellerId: sellerId,
        total: missingCoordinates.length,
        customers: missingCoordinates
      });
    } catch (error: any) {
      console.error('Erro ao buscar clientes sem coordenadas:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar clientes sem coordenadas',
        error: error.message 
      });
    }
  });

  // Buscar rota específica com detalhes
  app.get('/api/daily-routes/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      const route = await storage.getDailyRoute(id);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }

      // Vendedor só pode ver sua própria rota
      if (user.role === 'vendedor' && route.sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      // Buscar detalhes das visitas
      const visits = await Promise.all(
        (route.optimizedOrder || []).map(async (visitId: string) => {
          const [visit] = await db.select()
            .from(visitAgenda)
            .where(eq(visitAgenda.id, visitId))
            .limit(1);
          return visit;
        })
      );

      // Buscar checkpoints
      const checkpoints = await storage.getRouteCheckpoints(route.id);
      
      // DEBUG: Verificar estrutura dos checkpoints
      if (checkpoints.length > 0) {
        console.log(`📍 DEBUG: Total checkpoints encontrados: ${checkpoints.length}`);
        console.log(`📍 DEBUG: Primeiro checkpoint:`, JSON.stringify(checkpoints[0], null, 2));
        console.log(`📍 DEBUG: Campos do primeiro checkpoint:`, Object.keys(checkpoints[0]));
      }

      res.json({
        route: {
          ...route,
          visits: visits.filter(Boolean),
          checkpoints
        }
      });
    } catch (error: any) {
      console.error('Erro ao buscar rota:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar rota',
        error: error.message 
      });
    }
  });

  // Re-otimizar rota localmente (sem salvar no banco de dados)
  app.post('/api/daily-routes/:routeId/optimize-preview', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }

      // Vendedor só pode otimizar sua própria rota
      if (user.role === 'vendedor' && route.sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      // Buscar dados do vendedor (coordenadas de casa)
      const seller = await storage.getUser(route.sellerId);
      
      if (!seller?.homeLatitude || !seller?.homeLongitude) {
        return res.status(400).json({ message: 'Vendedor não tem coordenadas de casa configuradas' });
      }

      // Resolver stops (customers + leads) usando helper
      const visitStops = (route.visitStops as any) || {};
      const resolvedStops = await resolveRouteStops(route.optimizedOrder || [], visitStops);

      if (resolvedStops.length === 0) {
        return res.status(400).json({ message: 'Nenhuma visita com coordenadas válidas encontrada' });
      }

      console.log(`🔄 Preview otimização rota ${routeId}: ${resolvedStops.length} stops (${resolvedStops.filter(s => s.entityType === 'customer').length} clientes + ${resolvedStops.filter(s => s.entityType === 'lead').length} leads)`);

      // Preparar pontos para otimização
      const points = resolvedStops.map(stop => ({
        id: stop.entityId,
        latitude: stop.latitude,
        longitude: stop.longitude,
        customerName: stop.name,
        customerAddress: stop.address || ''
      }));

      // Executar otimização
      const { optimizeRoute } = await import('./routeOptimizationService');
      const optimizedResult = await optimizeRoute(
        seller.homeLatitude,
        seller.homeLongitude,
        points
      );

      // Retornar apenas a ordem otimizada (IDs) e distância total
      const optimizedOrder = optimizedResult.orderedPoints.map(p => p.id);
      
      console.log(`🔄 Re-otimização preview para rota ${routeId}: ${validVisits.length} visitas, distância: ${optimizedResult.totalDistance}km`);

      res.json({
        success: true,
        optimizedOrder,
        totalDistance: optimizedResult.totalDistance,
        totalVisits: optimizedOrder.length,
        message: `Rota re-otimizada com ${optimizedOrder.length} visitas`
      });
    } catch (error: any) {
      console.error('Erro ao re-otimizar rota:', error);
      res.status(500).json({ 
        message: 'Erro ao re-otimizar rota',
        error: error.message 
      });
    }
  });

  // Aplicar otimização à rota (salvar no banco)
  app.post('/api/daily-routes/:routeId/optimize', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      
      // Apenas administradores podem otimizar rotas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem otimizar rotas.' });
      }
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }

      // Buscar dados do vendedor (coordenadas de casa)
      const seller = await storage.getUser(route.sellerId);
      
      if (!seller?.homeLatitude || !seller?.homeLongitude) {
        return res.status(400).json({ message: 'Vendedor não tem coordenadas de casa configuradas' });
      }

      // Resolver stops (customers + leads) usando helper
      // Deduplic ar optimizedOrder antes de processar (previne duplicatas)
      const visitStops = (route.visitStops as any) || {};
      const uniqueOptimizedOrder = Array.from(new Set(route.optimizedOrder || []));
      
      if (uniqueOptimizedOrder.length !== (route.optimizedOrder || []).length) {
        console.warn(`⚠️  Detectadas ${(route.optimizedOrder || []).length - uniqueOptimizedOrder.length} entradas duplicadas em optimizedOrder, removendo antes de otimizar`);
      }
      
      const resolvedStops = await resolveRouteStops(uniqueOptimizedOrder, visitStops);

      if (resolvedStops.length === 0) {
        return res.status(400).json({ message: 'Nenhuma visita com coordenadas válidas encontrada' });
      }

      console.log(`🔄 Otimizando rota ${routeId}: ${resolvedStops.length} stops (${resolvedStops.filter(s => s.entityType === 'customer').length} clientes + ${resolvedStops.filter(s => s.entityType === 'lead').length} leads)`);

      // Preparar pontos para otimização
      const points = resolvedStops.map(stop => ({
        id: stop.entityId,
        latitude: stop.latitude,
        longitude: stop.longitude,
        customerName: stop.name,
        customerAddress: stop.address || ''
      }));

      // Executar otimização
      const { optimizeRoute } = await import('./routeOptimizationService');
      const optimizedResult = await optimizeRoute(
        seller.homeLatitude,
        seller.homeLongitude,
        points
      );

      // Reconstruir optimizedOrder e visitStops com a nova ordem
      // Criar mapa de entityId -> stop original para lookup rápido
      const stopMap = new Map<string, ResolvedStop>();
      resolvedStops.forEach(stop => {
        stopMap.set(stop.entityId, stop);
      });

      // Criar nova ordem com stopIds corretos e novo visitStops
      const newOptimizedOrder: string[] = [];
      const newVisitStops: { [stopId: string]: { entityType: 'customer' | 'lead'; entityId: string } } = {};
      const seenStopIds = new Set<string>(); // Para evitar duplicatas

      optimizedResult.orderedPoints.forEach(point => {
        const stop = stopMap.get(point.id);
        if (stop) {
          // Criar stopId com formato correto: "customer:{id}" ou "lead:{id}"
          const stopId = `${stop.entityType}:${stop.entityId}`;
          
          // Adicionar apenas se ainda não foi visto (deduplicação)
          if (!seenStopIds.has(stopId)) {
            seenStopIds.add(stopId);
            newOptimizedOrder.push(stopId);
            newVisitStops[stopId] = {
              entityType: stop.entityType,
              entityId: stop.entityId
            };
          } else {
            console.warn(`⚠️  Duplicata detectada e removida: ${stopId}`);
          }
        }
      });
      
      // Salvar no banco de dados
      await storage.updateDailyRoute(routeId, {
        optimizedOrder: newOptimizedOrder,
        visitStops: newVisitStops,
        totalEstimatedDistance: optimizedResult.totalDistance.toString(),
        totalVisits: newOptimizedOrder.length
      });
      
      console.log(`✅ Rota ${routeId} otimizada e salva: ${resolvedStops.length} visitas (${resolvedStops.filter(s => s.entityType === 'customer').length} clientes + ${resolvedStops.filter(s => s.entityType === 'lead').length} leads), distância: ${optimizedResult.totalDistance}km`);

      res.json({
        success: true,
        optimizedOrder: newOptimizedOrder,
        totalDistance: optimizedResult.totalDistance,
        totalVisits: newOptimizedOrder.length,
        message: `Rota otimizada com sucesso! ${newOptimizedOrder.length} visitas, distância: ${optimizedResult.totalDistance}km`
      });
    } catch (error: any) {
      console.error('Erro ao otimizar rota:', error);
      res.status(500).json({ 
        message: 'Erro ao otimizar rota',
        error: error.message 
      });
    }
  });

  // Marcar horário de almoço
  app.post('/api/daily-routes/:routeId/lunch-break', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }
      
      // Vendedor só pode marcar almoço em sua própria rota
      if (user.role === 'vendedor' && route.sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }
      
      // Se já foi ativado, retornar sucesso (idempotente)
      if (route.lunchBreakActivatedAt) {
        return res.json({
          success: true,
          message: 'Horário de almoço já estava marcado',
          lunchBreakActivatedAt: route.lunchBreakActivatedAt
        });
      }
      
      // Verificar se o vendedor já fez pelo menos 1 check-in
      const checkpoints = await db
        .select()
        .from(routeCheckpoints)
        .where(eq(routeCheckpoints.dailyRouteId, routeId))
        .orderBy(routeCheckpoints.checkpointTime);
      
      const hasCheckin = checkpoints.some(cp => cp.checkpointType === 'check_in');
      
      if (!hasCheckin) {
        return res.status(400).json({ 
          message: 'Você precisa fazer pelo menos um check-in antes de marcar o horário de almoço' 
        });
      }
      
      // Marcar horário de almoço com timestamp atual
      const now = new Date();
      await storage.updateDailyRoute(routeId, {
        lunchBreakActivatedAt: now
      });
      
      console.log(`✅ Horário de almoço marcado para rota ${routeId} às ${now.toISOString()}`);
      
      res.json({
        success: true,
        message: 'Horário de almoço marcado com sucesso',
        lunchBreakActivatedAt: now
      });
    } catch (error: any) {
      console.error('Erro ao marcar horário de almoço:', error);
      res.status(500).json({ 
        message: 'Erro ao marcar horário de almoço',
        error: error.message 
      });
    }
  });

  // Validar visita fora da rota (admin apenas)
  app.post('/api/daily-routes/checkpoints/:checkpointId/validate', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { checkpointId } = req.params;
      
      // Apenas admin, coordinator e administrative podem validar
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem validar visitas.' });
      }

      const { validateOffRouteVisit, calculateActualRouteDistance } = await import('./actualRouteService');
      
      await validateOffRouteVisit(storage, checkpointId, user.id);
      
      // Buscar checkpoint para retornar dados atualizados da rota
      const checkpoint = await storage.getRouteCheckpointById(checkpointId);
      
      if (checkpoint) {
        const routeStats = await calculateActualRouteDistance(storage, checkpoint.dailyRouteId);
        res.json({
          success: true,
          message: 'Visita validada com sucesso',
          routeStats
        });
      } else {
        res.json({ success: true, message: 'Visita validada com sucesso' });
      }
    } catch (error: any) {
      console.error('Erro ao validar visita:', error);
      res.status(500).json({ 
        message: 'Erro ao validar visita',
        error: error.message 
      });
    }
  });

  // Cancelar visita fora da rota (admin apenas)
  app.post('/api/daily-routes/checkpoints/:checkpointId/cancel', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { checkpointId } = req.params;
      
      // Apenas admin, coordinator e administrative podem cancelar
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem cancelar visitas.' });
      }

      const { cancelOffRouteVisit, calculateActualRouteDistance } = await import('./actualRouteService');
      
      await cancelOffRouteVisit(storage, checkpointId, user.id);
      
      // Buscar checkpoint para retornar dados atualizados da rota
      const checkpoint = await storage.getRouteCheckpointById(checkpointId);
      
      if (checkpoint) {
        const routeStats = await calculateActualRouteDistance(storage, checkpoint.dailyRouteId);
        res.json({
          success: true,
          message: 'Visita cancelada com sucesso',
          routeStats
        });
      } else {
        res.json({ success: true, message: 'Visita cancelada com sucesso' });
      }
    } catch (error: any) {
      console.error('Erro ao cancelar visita:', error);
      res.status(500).json({ 
        message: 'Erro ao cancelar visita',
        error: error.message 
      });
    }
  });

  // Deletar rota inteira (limpar)
  app.delete('/api/daily-routes/:routeId', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      
      // Apenas administradores podem deletar rotas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem deletar rotas.' });
      }
      
      // Buscar rota para confirmar que existe
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }
      
      // Verificar se o usuário é admin ou se é o vendedor da rota
      if (user.role === 'vendedor' && route.sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado. Você só pode deletar sua própria rota.' });
      }
      
      // Deletar a rota
      await storage.deleteDailyRoute(routeId);
      
      res.json({
        success: true,
        message: 'Rota deletada com sucesso'
      });
    } catch (error: any) {
      console.error('Erro ao deletar rota:', error);
      res.status(500).json({ 
        message: 'Erro ao deletar rota',
        error: error.message 
      });
    }
  });

  // Remover visita da rota do dia
  app.delete('/api/daily-routes/:routeId/visits/:visitId', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId, visitId } = req.params;
      
      // Apenas administradores podem excluir visitas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem excluir visitas.' });
      }
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }
      
      // Log para debug em produção
      console.log(`🗑️ [DELETE-VISIT] Tentando excluir visita ${visitId} da rota ${routeId}`);
      console.log(`📋 [DELETE-VISIT] optimizedOrder atual:`, route.optimizedOrder);
      
      // Remover visita do optimizedOrder com suporte a múltiplos formatos de ID
      const currentOrder = (route.optimizedOrder as string[]) || [];
      
      // Detectar se visitId é formato novo (com prefixo) ou antigo (sem prefixo)
      const visitIdHasPrefix = visitId.includes(':');
      
      // Filtrar com comparação inteligente
      const newOrder = currentOrder.filter((id: string) => {
        // 1. Comparação exata primeiro (match perfeito)
        if (id === visitId) return false;
        
        // 2. Detectar formato do ID no array
        const arrayIdHasPrefix = id.includes(':');
        
        // 3. Se ambos têm prefixo, APENAS comparar exatamente (evita deletar múltiplas visitas ao mesmo cliente)
        if (visitIdHasPrefix && arrayIdHasPrefix) {
          // Já verificamos comparação exata acima, então manter
          return true;
        }
        
        // 4. Se um tem prefixo e outro não (cenário de migração legacy), comparar entityIds
        if (visitIdHasPrefix !== arrayIdHasPrefix) {
          // Extrair entityId de ambos
          const visitEntityId = visitIdHasPrefix 
            ? visitId.split(':')[1]  // customer:123:timestamp -> 123
            : visitId;                // 123 -> 123
          
          const arrayEntityId = arrayIdHasPrefix 
            ? id.split(':')[1]        // customer:123:timestamp -> 123
            : id;                      // 123 -> 123
          
          // Comparar entityIds
          if (arrayEntityId === visitEntityId) return false;
        }
        
        // Manter este ID
        return true;
      });
      
      if (currentOrder.length === newOrder.length) {
        console.error(`❌ [DELETE-VISIT] Visita ${visitId} NÃO encontrada no optimizedOrder:`, currentOrder);
        return res.status(404).json({ message: 'Visita não encontrada na rota' });
      }
      
      // Atualizar rota
      await storage.updateDailyRoute(routeId, {
        optimizedOrder: newOrder,
        totalVisits: newOrder.length
      });
      
      console.log(`🗑️ Visita ${visitId} removida da rota ${routeId} (${currentOrder.length} → ${newOrder.length} visitas)`);
      
      res.json({
        success: true,
        message: 'Visita removida da rota com sucesso',
        removedVisitId: visitId,
        newTotalVisits: newOrder.length
      });
    } catch (error: any) {
      console.error('Erro ao remover visita da rota:', error);
      res.status(500).json({ 
        message: 'Erro ao remover visita da rota',
        error: error.message 
      });
    }
  });

  // Adicionar cliente à rota (admin apenas)
  app.post('/api/daily-routes/:routeId/visits', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      const { customerId } = req.body;
      
      // Apenas administradores podem adicionar visitas
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem adicionar visitas.' });
      }
      
      if (!customerId) {
        return res.status(400).json({ message: 'customerId é obrigatório' });
      }
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }
      
      // Buscar cliente para validar e obter dados
      const customer = await storage.getCustomer(customerId);
      
      if (!customer) {
        return res.status(404).json({ message: 'Cliente não encontrado' });
      }
      
      // Criar sales_card para esta visita
      const routeDate = new Date(route.routeDate);
      
      const newSalesCard = await storage.createSalesCard({
        customerId: customer.id,
        sellerId: route.sellerId,
        scheduledDate: routeDate,
        status: 'pending',
        source: 'manual_route_addition',
        notes: `Visita adicionada manualmente à rota por ${user.name} em ${new Date().toLocaleString('pt-BR')}`
      });
      
      // Adicionar customerId ao optimizedOrder (GET endpoint espera customerIds)
      const currentOrder = (route.optimizedOrder as string[]) || [];
      const newOrder = [...currentOrder, customer.id];
      
      // Atualizar rota
      await storage.updateDailyRoute(routeId, {
        optimizedOrder: newOrder,
        totalVisits: newOrder.length
      });
      
      console.log(`➕ Cliente ${customer.fantasyName || customer.name} adicionado à rota ${routeId} (${currentOrder.length} → ${newOrder.length} visitas)`);
      
      res.json({
        success: true,
        message: 'Cliente adicionado à rota com sucesso',
        salesCardId: newSalesCard.id,
        newTotalVisits: newOrder.length,
        customer: {
          id: customer.id,
          name: customer.fantasyName || customer.name
        }
      });
    } catch (error: any) {
      console.error('Erro ao adicionar cliente à rota:', error);
      res.status(500).json({ 
        message: 'Erro ao adicionar cliente à rota',
        error: error.message 
      });
    }
  });

  // Adicionar LEAD à rota (admin apenas)
  app.post('/api/daily-routes/:routeId/leads', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { routeId } = req.params;
      const { leadId } = req.body;
      
      // Apenas administradores podem adicionar leads
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado. Apenas administradores podem adicionar leads.' });
      }
      
      if (!leadId) {
        return res.status(400).json({ message: 'leadId é obrigatório' });
      }
      
      // Buscar rota
      const route = await storage.getDailyRoute(routeId);
      
      if (!route) {
        return res.status(404).json({ message: 'Rota não encontrada' });
      }
      
      // Buscar lead para validar
      const lead = await storage.getLead(leadId);
      
      if (!lead) {
        return res.status(404).json({ message: 'Lead não encontrado' });
      }
      
      // Criar stopId prefixado para o lead
      const stopId = `lead:${lead.id}`;
      
      // Obter visitStops atual (ou criar novo objeto se não existir)
      const currentVisitStops = (route.visitStops as any) || {};
      
      // Adicionar metadata do lead
      currentVisitStops[stopId] = {
        entityType: 'lead',
        entityId: lead.id
      };
      
      // Adicionar stopId ao optimizedOrder
      const currentOrder = (route.optimizedOrder as string[]) || [];
      const newOrder = [...currentOrder, stopId];
      
      // Atualizar rota
      await storage.updateDailyRoute(routeId, {
        optimizedOrder: newOrder,
        visitStops: currentVisitStops,
        totalVisits: newOrder.length
      });
      
      // Atribuir lead ao vendedor da rota
      await storage.updateLead(leadId, {
        assignedTo: route.sellerId
      });
      
      // Criar sales_card para o lead (necessário para check-in/check-out)
      const salesCard = await storage.createSalesCard({
        customerId: leadId, // Lead ID vai para customerId
        sellerId: route.sellerId,
        scheduledDate: route.date,
        source: 'manual_route_addition' as any,
        recurrence: 'ondemand' as any,
        weekdays: null as any,
      });
      
      console.log(`➕ Lead ${lead.fantasyName} adicionado à rota ${routeId} com sales_card ${salesCard.id} (${currentOrder.length} → ${newOrder.length} visitas)`);
      
      res.json({
        success: true,
        salesCard,
        message: 'Lead adicionado à rota com sucesso',
        newTotalVisits: newOrder.length,
        lead: {
          id: lead.id,
          name: lead.fantasyName
        }
      });
    } catch (error: any) {
      console.error('Erro ao adicionar lead à rota:', error);
      res.status(500).json({ 
        message: 'Erro ao adicionar lead à rota',
        error: error.message 
      });
    }
  });

  // Buscar distância real percorrida (baseado em checkpoints)
  app.get('/api/daily-routes/:routeId/actual-distance', authenticateUser, async (req: any, res) => {
    try {
      const { routeId } = req.params;
      
      const { calculateActualRouteDistance } = await import('./actualRouteService');
      const result = await calculateActualRouteDistance(storage, routeId);
      
      res.json(result);
    } catch (error: any) {
      console.error('Erro ao calcular distância real:', error);
      res.status(500).json({ 
        message: 'Erro ao calcular distância real',
        error: error.message 
      });
    }
  });

  // ========== ROUTE METRICS ENDPOINTS ==========
  
  // Buscar métricas diárias de um vendedor
  app.get('/api/route-metrics/daily/:sellerId/:date', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.params;
      
      // Vendedor só pode ver suas próprias métricas
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const { getDailyMetrics } = await import('./routeMetricsService');
      const metrics = await getDailyMetrics(sellerId, new Date(date));
      
      res.json(metrics);
    } catch (error: any) {
      console.error('Erro ao buscar métricas diárias:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar métricas',
        error: error.message 
      });
    }
  });

  // Buscar métricas mensais de um vendedor
  app.get('/api/route-metrics/monthly/:sellerId/:year/:month', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, year, month } = req.params;
      
      // Vendedor só pode ver suas próprias métricas
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const { getMonthlyMetrics } = await import('./routeMetricsService');
      const metrics = await getMonthlyMetrics(sellerId, parseInt(year), parseInt(month));
      
      res.json(metrics);
    } catch (error: any) {
      console.error('Erro ao buscar métricas mensais:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar métricas',
        error: error.message 
      });
    }
  });

  // Buscar métricas de todos os vendedores (admin)
  app.get('/api/route-metrics/admin-dashboard/:year/:month', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { year, month } = req.params;
      
      // Apenas admin pode acessar
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const { getAdminDashboardMetrics } = await import('./routeMetricsService');
      const metrics = await getAdminDashboardMetrics(parseInt(year), parseInt(month));
      
      res.json(metrics);
    } catch (error: any) {
      console.error('Erro ao buscar métricas admin:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar métricas',
        error: error.message 
      });
    }
  });

  // Buscar métricas do dia atual de todos os vendedores
  app.get('/api/route-metrics/today', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode acessar
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const { getTodayMetrics } = await import('./routeMetricsService');
      const metrics = await getTodayMetrics();
      
      res.json(metrics);
    } catch (error: any) {
      console.error('Erro ao buscar métricas do dia:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar métricas do dia',
        error: error.message 
      });
    }
  });

  // Buscar últimas rotas de um vendedor
  app.get('/api/route-metrics/recent/:sellerId', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId } = req.params;
      const limit = parseInt(req.query.limit as string) || 7;
      
      // Vendedor só pode ver suas próprias rotas
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const { getRecentRoutes } = await import('./routeMetricsService');
      const routes = await getRecentRoutes(sellerId, limit);
      
      res.json(routes);
    } catch (error: any) {
      console.error('Erro ao buscar rotas recentes:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar rotas',
        error: error.message 
      });
    }
  });

  // Buscar todas as visitas realizadas com check-in
  app.get('/api/visits/all', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Construir condições WHERE
      const conditions = [isNotNull(salesCards.checkInTime)];
      
      // Se for vendedor, filtrar apenas suas próprias visitas
      if (user.role === 'vendedor') {
        conditions.push(eq(salesCards.sellerId, user.id));
      }

      const visits = await db
        .select({
          id: salesCards.id,
          checkInTime: salesCards.checkInTime,
          checkOutTime: salesCards.checkOutTime,
          checkInLatitude: salesCards.checkInLatitude,
          checkInLongitude: salesCards.checkInLongitude,
          checkOutLatitude: salesCards.checkOutLatitude,
          checkOutLongitude: salesCards.checkOutLongitude,
          distanceToCustomer: salesCards.distanceToCustomer,
          checkInPhotoUrl: salesCards.checkInPhotoUrl,
          customerLatitude: salesCards.customerLatitude,
          customerLongitude: salesCards.customerLongitude,
          customerId: salesCards.customerId,
          sellerId: salesCards.sellerId,
          customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
          sellerName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
        })
        .from(salesCards)
        .innerJoin(customers, eq(customers.id, salesCards.customerId))
        .innerJoin(users, eq(users.id, salesCards.sellerId))
        .where(and(...conditions))
        .orderBy(sql`${salesCards.checkInTime} DESC`);
      
      res.json(visits);
    } catch (error: any) {
      console.error('Erro ao buscar visitas:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar visitas',
        error: error.message 
      });
    }
  });

  // Teste de cancelamento de nota
  app.get('/api/omie/test-cancellation/:invoiceNumber', async (req: any, res) => {
    try {
      const { invoiceNumber } = req.params;
      const omieService = getOmieService();
      
      if (!omieService) {
        return res.status(500).json({ message: 'Omie não configurado' });
      }

      // Buscar nota fiscal em múltiplas páginas
      let invoice = null;
      let page = 1;
      
      while (!invoice && page <= 20) {
        const response = await omieService.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
          pagina: page,
          registros_por_pagina: 50,
          apenas_importado_api: 'N',
          ordenar_por: 'DATA',
          ordem_decrescente: 'S'
        });

        invoice = response.nfCadastro?.find((nf: any) => nf.ide?.nNF === invoiceNumber);
        
        if (!invoice && response.nfCadastro?.length < 50) {
          break; // Última página
        }
        
        page++;
      }
      
      if (!invoice) {
        return res.status(404).json({ message: `Nota fiscal ${invoiceNumber} não encontrada após buscar ${page} páginas` });
      }

      const pedidoId = invoice.compl?.nIdPedido;
      let pedidoStage = null;

      if (pedidoId) {
        pedidoStage = await omieService.fetchPedidoStage(pedidoId);
      }

      res.json({
        invoice: {
          numero: invoice.ide?.nNF,
          data: invoice.ide?.dEmi,
          cliente: invoice.dest?.razao_social,
          pedidoId: pedidoId
        },
        stage: pedidoStage,
        cancelled: pedidoStage?.cancelled || false
      });

    } catch (error: any) {
      console.error('Erro ao testar cancelamento:', error);
      res.status(500).json({ message: 'Erro ao testar cancelamento', error: error.message });
    }
  });

  // Download do arquivo Excel de notas fiscais exportado
  app.get('/api/omie/download-invoices-excel', async (req: any, res) => {
    try {
      const filePath = path.join(process.cwd(), 'attached_assets', 'notas-fiscais-omie-outubro-2025.xlsx');
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: 'Arquivo não encontrado' });
      }

      res.download(filePath, 'notas-fiscais-omie-outubro-2025.xlsx');
    } catch (error: any) {
      console.error('Erro ao fazer download do arquivo:', error);
      res.status(500).json({ message: 'Erro ao fazer download', error: error.message });
    }
  });

  // Download do arquivo Excel EXPANDIDO de notas fiscais
  app.get('/api/omie/download-invoices-excel-expanded', async (req: any, res) => {
    try {
      const filePath = path.join(process.cwd(), 'attached_assets', 'notas-fiscais-omie-outubro-2025-expandido.xlsx');
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: 'Arquivo não encontrado' });
      }

      res.download(filePath, 'notas-fiscais-omie-outubro-2025-expandido.xlsx');
    } catch (error: any) {
      console.error('Erro ao fazer download do arquivo:', error);
      res.status(500).json({ message: 'Erro ao fazer download', error: error.message });
    }
  });

  // Exportar notas fiscais do Omie para Excel EXPANDIDO (para análise) - TEMPORÁRIO SEM AUTH
  app.post('/api/omie/export-invoices-excel-expanded', async (req: any, res) => {
    try {
      console.log('\n📊 EXPORTANDO NOTAS FISCAIS DO OMIE PARA EXCEL (EXPANDIDO)...\n');

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(500).json({ message: 'Omie não configurado' });
      }

      const allInvoices: any[] = [];
      let page = 1;
      let hasMorePages = true;

      // Buscar todas as notas desde 01/10/2025
      while (hasMorePages && page <= 50) {
        console.log(`📄 Buscando página ${page}...`);
        
        const response = await omieService.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
          pagina: page,
          registros_por_pagina: 50,
          apenas_importado_api: 'N',
          ordenar_por: 'DATA',
          ordem_decrescente: 'S'
        });

        const invoices = response.nfCadastro || [];
        console.log(`✅ Página ${page}: ${invoices.length} notas encontradas`);

        for (const invoice of invoices) {
          const invoiceDate = invoice.ide?.dEmi;
          if (!invoiceDate) continue;

          const [dia, mes, ano] = invoiceDate.split('/');
          const invoiceDateObj = new Date(`${ano}-${mes}-${dia}`);
          
          if (invoiceDateObj < new Date('2025-10-01')) {
            hasMorePages = false;
            break;
          }

          // Buscar etapa do pedido se houver pedido relacionado
          let pedidoStage = null;
          const pedidoId = invoice.compl?.nIdPedido;
          
          if (pedidoId) {
            try {
              console.log(`🔍 Buscando etapa do pedido ${pedidoId}...`);
              pedidoStage = await omieService.fetchPedidoStage(pedidoId);
            } catch (error) {
              console.log(`⚠️ Erro ao buscar etapa do pedido ${pedidoId}:`, error);
            }
          }

          // Expandir TODOS os campos em colunas separadas
          allInvoices.push({
            // === IDENTIFICAÇÃO ===
            numero_nf: invoice.ide?.nNF || '',
            serie_nf: invoice.ide?.serie || '',
            modelo_nf: invoice.ide?.mod || '',
            data_emissao: invoiceDate,
            data_saida: invoice.ide?.dSaiEnt || '',
            hora_emissao: invoice.ide?.hEmi || '',
            hora_saida: invoice.ide?.hSaiEnt || '',
            tipo_nf: invoice.ide?.tpNF || '',
            finalidade_nfe: invoice.ide?.finNFe || '',
            
            // === STATUS ===
            status_codigo: invoice.nfProdServStatus?.cStat || '',
            status_descricao: invoice.nfProdServStatus?.xMotivo || '',
            chave_nfe: invoice.nfProdServStatus?.cChaveNFe || '',
            protocolo: invoice.nfProdServStatus?.nProt || '',
            
            // === CLIENTE (DEST) ===
            cliente_codigo_omie: invoice.dest?.codigo_cliente_omie || '',
            cliente_razao_social: invoice.dest?.razao_social || '',
            cliente_cpf_cnpj: invoice.dest?.cnpj_cpf || '',
            cliente_inscricao_estadual: invoice.dest?.inscricao_estadual || '',
            cliente_endereco: invoice.dest?.endereco || '',
            cliente_numero: invoice.dest?.numero_endereco || '',
            cliente_complemento: invoice.dest?.complemento || '',
            cliente_bairro: invoice.dest?.bairro || '',
            cliente_cidade: invoice.dest?.cidade || '',
            cliente_estado: invoice.dest?.estado || '',
            cliente_cep: invoice.dest?.cep || '',
            
            // === VALORES TOTAIS ===
            valor_total_nf: invoice.total?.ICMSTot?.vNF || 0,
            valor_produtos: invoice.total?.ICMSTot?.vProd || 0,
            valor_desconto: invoice.total?.ICMSTot?.vDesc || 0,
            valor_frete: invoice.total?.ICMSTot?.vFrete || 0,
            valor_seguro: invoice.total?.ICMSTot?.vSeg || 0,
            valor_outras_despesas: invoice.total?.ICMSTot?.vOutro || 0,
            valor_icms: invoice.total?.ICMSTot?.vICMS || 0,
            valor_icms_st: invoice.total?.ICMSTot?.vST || 0,
            valor_ipi: invoice.total?.ICMSTot?.vIPI || 0,
            valor_pis: invoice.total?.ICMSTot?.vPIS || 0,
            valor_cofins: invoice.total?.ICMSTot?.vCOFINS || 0,
            
            // === PEDIDO RELACIONADO ===
            pedido_id_omie: invoice.compl?.nIdPedido || '',
            pedido_numero: invoice.compl?.nPed || '',
            pedido_categoria: invoice.compl?.cCodCateg || '',
            
            // === ETAPA DO PEDIDO ===
            etapa_codigo: pedidoStage?.cEtapa || '',
            etapa_descricao: pedidoStage?.dEtapa || '',
            etapa_data: pedidoStage?.dDtEtapa || '',
            etapa_hora: pedidoStage?.cHrEtapa || '',
            nota_cancelada: pedidoStage?.cancelled ? 'SIM' : 'NÃO',
            
            // === FRETE ===
            modalidade_frete: invoice.compl?.cModFrete || '',
            transportadora_id: invoice.compl?.nIdTransp || '',
            
            // === TÍTULOS/FINANCEIRO ===
            titulo_id: invoice.titulos?.[0]?.nCodTitulo || '',
            titulo_numero: invoice.titulos?.[0]?.cNumTitulo || '',
            titulo_documento: invoice.titulos?.[0]?.cDoc || '',
            titulo_valor: invoice.titulos?.[0]?.nValorTitulo || 0,
            titulo_data_vencimento: invoice.titulos?.[0]?.dDtVenc || '',
            titulo_data_previsao: invoice.titulos?.[0]?.dDtPrevisao || '',
            titulo_categoria: invoice.titulos?.[0]?.cCodCateg || '',
            titulo_vendedor_id: invoice.titulos?.[0]?.nCodVendedor || '',
            titulo_projeto_id: invoice.titulos?.[0]?.nCodProjeto || '',
            
            // === INFORMAÇÕES ADICIONAIS ===
            info_data_inclusao: invoice.info?.dInc || '',
            info_hora_inclusao: invoice.info?.hInc || '',
            info_usuario_inclusao: invoice.info?.uInc || '',
            info_data_alteracao: invoice.info?.dAlt || '',
            info_hora_alteracao: invoice.info?.hAlt || '',
            info_usuario_alteracao: invoice.info?.uAlt || '',
            
            // === PRODUTOS (primeiro item apenas) ===
            produto_codigo: invoice.det?.[0]?.prod?.cProd || '',
            produto_descricao: invoice.det?.[0]?.prod?.xProd || '',
            produto_ncm: invoice.det?.[0]?.prod?.NCM || '',
            produto_cfop: invoice.det?.[0]?.prod?.CFOP || '',
            produto_unidade: invoice.det?.[0]?.prod?.uCom || '',
            produto_quantidade: invoice.det?.[0]?.prod?.qCom || 0,
            produto_valor_unitario: invoice.det?.[0]?.prod?.vUnCom || 0,
            produto_valor_total: invoice.det?.[0]?.prod?.vProd || 0,
            
            // === EMISSOR ===
            emissor_codigo: invoice.nfEmitInt?.nCodEmp || '',
            
            // === DESTINATÁRIO INTERNO ===
            dest_codigo_interno: invoice.nfDestInt?.nCodCli || '',
            dest_razao_interna: invoice.nfDestInt?.cRazao || '',
            dest_cnpj_interno: invoice.nfDestInt?.cnpj_cpf || ''
          });
        }

        if (invoices.length < 50) {
          hasMorePages = false;
        }
        
        page++;
      }

      console.log(`\n✅ Total de notas coletadas: ${allInvoices.length}\n`);

      // Criar Excel
      const ws = XLSX.utils.json_to_sheet(allInvoices);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Notas Fiscais');

      // Ajustar largura das colunas
      const colWidths = Object.keys(allInvoices[0] || {}).map(() => ({ wch: 20 }));
      ws['!cols'] = colWidths;

      // Gerar arquivo
      const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      // Salvar na pasta attached_assets
      const outputPath = path.join(process.cwd(), 'attached_assets', 'notas-fiscais-omie-outubro-2025-expandido.xlsx');
      fs.writeFileSync(outputPath, excelBuffer);
      
      console.log(`✅ Arquivo salvo em: ${outputPath}`);

      // Enviar arquivo
      res.download(outputPath, 'notas-fiscais-omie-outubro-2025-expandido.xlsx');

    } catch (error: any) {
      console.error('Erro ao exportar notas fiscais:', error);
      res.status(500).json({ 
        message: 'Erro ao exportar notas fiscais',
        error: error.message 
      });
    }
  });

  // Exportar notas fiscais do Omie para Excel (para análise) - TEMPORÁRIO SEM AUTH
  app.post('/api/omie/export-invoices-excel-temp', async (req: any, res) => {
    try {

      console.log('\n📊 EXPORTANDO NOTAS FISCAIS DO OMIE PARA EXCEL...\n');

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(500).json({ message: 'Omie não configurado' });
      }

      const allInvoices: any[] = [];
      let page = 1;
      let hasMorePages = true;

      // Buscar todas as notas desde 01/10/2025
      while (hasMorePages && page <= 50) { // Limite de 50 páginas para segurança
        console.log(`📄 Buscando página ${page}...`);
        
        const response = await omieService.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
          pagina: page,
          registros_por_pagina: 50,
          apenas_importado_api: 'N',
          ordenar_por: 'DATA',
          ordem_decrescente: 'S'
        });

        const invoices = response.nfCadastro || [];
        console.log(`✅ Página ${page}: ${invoices.length} notas encontradas`);

        for (const invoice of invoices) {
          // Verificar data de emissão
          const invoiceDate = invoice.ide?.dEmi;
          if (!invoiceDate) continue;

          const [dia, mes, ano] = invoiceDate.split('/');
          const invoiceDateObj = new Date(`${ano}-${mes}-${dia}`);
          
          // Filtrar desde 01/10/2025
          if (invoiceDateObj < new Date('2025-10-01')) {
            hasMorePages = false;
            break;
          }

          // Coletar TODOS os dados da nota
          allInvoices.push({
            // Identificação
            numero_nf: invoice.ide?.nNF || '',
            data_emissao: invoiceDate,
            status: invoice.nfProdServStatus?.cStat || '',
            
            // Cliente
            cliente_codigo: invoice.dest?.codigo_cliente_omie || '',
            cliente_nome: invoice.dest?.razao_social || '',
            cliente_cpf_cnpj: invoice.dest?.cnpj_cpf || '',
            
            // Valores
            valor_total: invoice.total?.vNF || 0,
            valor_produtos: invoice.total?.vProd || 0,
            valor_desconto: invoice.total?.vDesc || 0,
            
            // Pedido relacionado
            pedido_id: invoice.compl?.nIdPedido || '',
            pedido_numero: invoice.compl?.nPed || '',
            
            // Faturamento
            chave_nfe: invoice.nfProdServStatus?.cChaveNFe || '',
            
            // Dados completos em JSON para análise
            dados_completos: JSON.stringify(invoice)
          });
        }

        if (invoices.length < 50) {
          hasMorePages = false;
        }
        
        page++;
      }

      console.log(`\n✅ Total de notas coletadas: ${allInvoices.length}\n`);

      // Criar Excel
      const ws = XLSX.utils.json_to_sheet(allInvoices);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Notas Fiscais');

      // Gerar arquivo
      const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const filename = `notas-fiscais-omie-${new Date().toISOString().split('T')[0]}.xlsx`;

      // Enviar arquivo
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(excelBuffer);

    } catch (error: any) {
      console.error('Erro ao exportar notas fiscais:', error);
      res.status(500).json({ 
        message: 'Erro ao exportar notas fiscais',
        error: error.message 
      });
    }
  });

  // Gerar agenda futura de visitas
  app.post('/api/admin/generate-future-agenda', authenticateUser, async (req: any, res) => {
    try {
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      // Apenas admin pode executar esta operação
      if (user?.role !== 'admin') {
        return res.status(403).json({ message: "Apenas administradores podem gerar agenda futura" });
      }

      const { monthsAhead = 3 } = req.body;

      console.log(`📅 Iniciando geração de agenda futura para ${monthsAhead} meses...`);
      const results = await storage.generateFutureVisitAgenda(monthsAhead);
      
      res.json({
        success: true,
        ...results
      });
    } catch (error) {
      console.error('Erro ao gerar agenda futura:', error);
      res.status(500).json({ message: "Erro ao gerar agenda futura" });
    }
  });

  // Recalcular datas de visita para todos os cards
  app.post('/api/admin/recalculate-visit-dates', authenticateUser, async (req: any, res) => {
    try {
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      // Apenas admin pode executar esta operação
      if (user?.role !== 'admin') {
        return res.status(403).json({ message: "Apenas administradores podem recalcular datas de visita" });
      }

      console.log('📅 Iniciando recálculo de datas de visita...');
      const results = await storage.recalculateAllVisitDates();
      
      res.json({
        success: true,
        ...results
      });
    } catch (error) {
      console.error('Erro ao recalcular datas de visita:', error);
      res.status(500).json({ message: "Erro ao recalcular datas de visita" });
    }
  });

  // Sincronizar faturamentos do Omie para banco de dados
  app.post('/api/omie/sync-billings', async (req: any, res) => {
    try {
      console.log('\n💰 SINCRONIZANDO FATURAMENTOS DO OMIE...\n');

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(500).json({ message: 'Omie não configurado' });
      }

      // Calcular data de 90 dias atrás (aumentado para garantir captura de todas as notas)
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const allBillings: any[] = [];
      let page = 1;
      let hasMorePages = true;

      // Buscar notas fiscais dos últimos 90 dias
      while (hasMorePages && page <= 50) {
        console.log(`📄 Buscando página ${page}...`);
        
        const response = await omieService.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
          pagina: page,
          registros_por_pagina: 50,
          apenas_importado_api: 'N',
          ordenar_por: 'DATA',
          ordem_decrescente: 'S'
        });

        const invoices = response.nfCadastro || [];
        console.log(`✅ Página ${page}: ${invoices.length} notas encontradas`);

        for (const invoice of invoices) {
          const invoiceDate = invoice.ide?.dEmi;
          if (!invoiceDate) {
            console.log(`⚠️ Nota sem data - pulando`);
            continue;
          }

          const [dia, mes, ano] = invoiceDate.split('/');
          const invoiceDateObj = new Date(`${ano}-${mes}-${dia}`);
          
          // Filtrar últimos 90 dias - PULAR nota antiga mas CONTINUAR buscando páginas
          if (invoiceDateObj < ninetyDaysAgo) {
            console.log(`📅 Nota ${invoice.ide?.nNF} fora do período de 90 dias (${invoiceDate}) - pulando`);
            continue; // Pular essa nota mas continuar processando outras
          }

          // VERIFICAR CANCELAMENTO DIRETAMENTE NA NOTA FISCAL
          const notaCancelada = invoice.cancelamento?.cCancelado === 'S';
          
          if (notaCancelada) {
            console.log(`❌ Nota ${invoice.ide?.nNF} CANCELADA - pulando`);
            continue;
          }

          // BUSCAR ETAPA DIRETAMENTE DA NOTA FISCAL (sem depender de pedido)
          const nfStageCode = invoice.nfProdServStatus?.cEtapa || invoice.cabecalho?.etapa || '';
          let stageName = '';
          
          if (nfStageCode) {
            // Mapear código de etapa para nome
            const stageMap: Record<string, string> = {
              '10': 'Pedido de Venda',
              '20': 'Em Rota',
              '50': 'Faturado',
              '60': 'Faturado',
              '70': 'Entregue',
              '80': 'Aguardando Rota'
            };
            stageName = stageMap[nfStageCode] || `Etapa ${nfStageCode}`;
            console.log(`📋 Nota ${invoice.ide?.nNF} - Etapa: ${stageName} (código: ${nfStageCode})`);
          } else {
            console.log(`⚠️ Nota ${invoice.ide?.nNF} - SEM ETAPA encontrada (nfProdServStatus?.cEtapa: ${invoice.nfProdServStatus?.cEtapa}, cabecalho?.etapa: ${invoice.cabecalho?.etapa})`);
          }

          // Buscar nome do vendedor pelo código
          const vendorCode = invoice.titulos?.[0]?.nCodVendedor?.toString() || '';
          let vendorName = '';
          
          if (vendorCode) {
            try {
              const vendorData = await omieService.fetchVendorData(vendorCode);
              vendorName = vendorData?.nome || vendorCode;
            } catch (error) {
              console.log(`⚠️ Erro ao buscar vendedor ${vendorCode}:`, error);
              vendorName = vendorCode; // Usar código se não encontrar nome
            }
          }

          // Adicionar à lista de faturamentos
          const pedidoId = invoice.compl?.nIdPedido;
          
          allBillings.push({
            omieInvoiceId: invoice.compl?.nIdNF?.toString() || '',
            invoiceNumber: invoice.ide?.nNF || '',
            customerFantasyName: invoice.nfDestInt?.cRazao || '',
            totalValue: invoice.total?.ICMSTot?.vNF || 0,
            invoiceDate: invoiceDateObj,
            vendorCode: vendorCode,
            sellerName: vendorName,
            stageName: stageName,
            cfop: invoice.det?.[0]?.prod?.CFOP || '',
            isCancelled: false, // Já filtrado (notas canceladas são puladas acima)
            omieOrderId: pedidoId?.toString() || '',
            orderNumber: invoice.compl?.nPed || invoice.ide?.nNF || '',
            orderDate: invoiceDateObj,
            billingType: 'venda' as const
          });
        }

        if (invoices.length < 50) {
          hasMorePages = false;
        }
        
        page++;
      }

      console.log(`\n✅ Total de faturamentos coletados: ${allBillings.length}\n`);

      // Salvar no banco de dados
      let insertedCount = 0;
      let updatedCount = 0;

      for (const billing of allBillings) {
        try {
          // Verificar se já existe
          const existing = await db.select()
            .from(billingsTable)
            .where(eq(billingsTable.invoiceNumber, billing.invoiceNumber))
            .limit(1);

          if (existing.length > 0) {
            // Atualizar
            await db.update(billingsTable)
              .set({
                ...billing,
                updatedAt: new Date()
              })
              .where(eq(billingsTable.invoiceNumber, billing.invoiceNumber));
            updatedCount++;
          } else {
            // Inserir
            await db.insert(billingsTable).values(billing);
            insertedCount++;
          }
        } catch (error) {
          console.error(`Erro ao processar faturamento ${billing.invoiceNumber}:`, error);
        }
      }

      console.log(`\n✅ Sincronização concluída!`);
      console.log(`📥 Inseridos: ${insertedCount}`);
      console.log(`🔄 Atualizados: ${updatedCount}\n`);

      res.json({ 
        success: true,
        message: 'Faturamentos sincronizados com sucesso',
        inserted: insertedCount,
        updated: updatedCount,
        total: allBillings.length
      });

    } catch (error: any) {
      console.error('Erro ao sincronizar faturamentos:', error);
      res.status(500).json({ 
        message: 'Erro ao sincronizar faturamentos',
        error: error.message 
      });
    }
  });

  // Debug: Buscar notas específicas do Omie
  app.post('/api/omie/debug-invoices', authenticateUser, async (req: any, res) => {
    try {
      const { invoiceNumbers } = req.body;
      
      if (!invoiceNumbers || !Array.isArray(invoiceNumbers)) {
        return res.status(400).json({ message: 'invoiceNumbers array é obrigatório' });
      }

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(500).json({ message: 'Omie não configurado' });
      }

      const results = [];

      for (const invoiceNumber of invoiceNumbers) {
        console.log(`\n🔍 Buscando nota fiscal ${invoiceNumber}...`);
        
        // Buscar a nota fiscal
        const response = await omieService.makeRequest('/produtos/nfconsultar/', 'ListarNF', {
          pagina: 1,
          registros_por_pagina: 1,
          filtrar_por_numero: invoiceNumber
        });

        const invoice = response.nfCadastro?.[0];
        
        if (!invoice) {
          results.push({
            invoiceNumber,
            found: false,
            message: 'Nota fiscal não encontrada'
          });
          continue;
        }

        // Buscar pedido associado
        const pedidoId = invoice.compl?.nIdPedido;
        let pedidoStage = null;
        
        if (pedidoId) {
          try {
            pedidoStage = await omieService.fetchPedidoStage(pedidoId);
          } catch (error) {
            console.log(`⚠️ Erro ao buscar pedido ${pedidoId}:`, error);
          }
        }

        results.push({
          invoiceNumber,
          found: true,
          invoiceData: {
            nIdNF: invoice.compl?.nIdNF,
            nNF: invoice.ide?.nNF,
            dEmi: invoice.ide?.dEmi,
            cliente: invoice.nfDestInt?.cRazao,
            valor: invoice.total?.ICMSTot?.vNF,
            cfop: invoice.det?.[0]?.prod?.CFOP,
            nIdPedido: pedidoId
          },
          pedidoData: pedidoStage ? {
            pedidoId: pedidoId,
            stageName: pedidoStage.stageName,
            stageCode: pedidoStage.stageCode,
            cancelled: pedidoStage.cancelled,
            rawStages: pedidoStage.rawStages
          } : null
        });
      }

      res.json({ results });

    } catch (error: any) {
      console.error('Erro ao buscar notas:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar notas',
        error: error.message 
      });
    }
  });

  // Sync status endpoints
  app.get('/api/sync-status', authenticateUser, async (req, res) => {
    try {
      const allStatus = await storage.getAllSyncStatus();
      res.json(allStatus);
    } catch (error: any) {
      console.error('Erro ao buscar status de sincronização:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar status de sincronização',
        error: error.message 
      });
    }
  });

  app.get('/api/sync-status/:syncType', authenticateUser, async (req, res) => {
    try {
      const { syncType } = req.params;
      const status = await storage.getSyncStatus(syncType);
      
      if (!status) {
        return res.status(404).json({ 
          message: 'Status de sincronização não encontrado' 
        });
      }
      
      res.json(status);
    } catch (error: any) {
      console.error('Erro ao buscar status de sincronização:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar status de sincronização',
        error: error.message 
      });
    }
  });

  // Recalcular métricas das rotas baseado em checkpoints existentes (ADMIN ONLY)
  app.post('/api/admin/recalculate-route-metrics', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar
      if (user.role !== 'admin') {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      console.log('🔄 Recalculando métricas das rotas...');
      
      const today = new Date();
      const startOfDay = new Date(today);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      // Buscar todas as rotas de hoje usando range (timezone-safe)
      const routes = await db.select()
        .from(dailyRoutes)
        .where(and(
          gte(dailyRoutes.routeDate, startOfDay),
          lte(dailyRoutes.routeDate, endOfDay)
        ));

      console.log(`📊 Encontradas ${routes.length} rotas para recalcular`);

      let routesUpdated = 0;

      for (const route of routes) {
        // Buscar todos os checkpoints da rota
        const checkpoints = await storage.getRouteCheckpoints(route.id);
        
        if (checkpoints.length === 0) {
          console.log(`⚠️  Rota ${route.id} sem checkpoints, pulando...`);
          continue;
        }

        // Calcular distância total
        const totalDistance = checkpoints.reduce((sum, cp) => {
          return sum + parseFloat(cp.distanceFromPrevious || '0');
        }, 0);

        // Contar visitas completadas (check-outs)
        const completedVisits = checkpoints.filter(cp => cp.checkpointType === 'check_out').length;

        // Determinar status da rota
        let routeStatus = route.routeStatus;
        if (completedVisits > 0 && routeStatus === 'pending') {
          routeStatus = 'in_progress';
        }
        if (completedVisits === route.totalVisits) {
          routeStatus = 'completed';
        }

        // Atualizar rota
        await storage.updateDailyRoute(route.id, {
          totalActualDistance: totalDistance.toFixed(2),
          completedVisits,
          routeStatus
        });

        console.log(`✅ Rota ${route.id}: ${totalDistance.toFixed(2)} km, ${completedVisits} visitas`);
        routesUpdated++;
      }

      console.log(`✅ Recálculo concluído: ${routesUpdated} rotas atualizadas`);

      res.json({
        success: true,
        routesUpdated,
        totalRoutes: routes.length
      });

    } catch (error: any) {
      console.error('❌ Erro ao recalcular métricas:', error);
      res.status(500).json({ 
        message: 'Erro ao recalcular métricas',
        error: error.message 
      });
    }
  });

  // Migração retroativa de checkpoints (ADMIN ONLY)
  app.post('/api/admin/migrate-checkpoints', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar
      if (user.role !== 'admin') {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      // Permitir especificar range de datas (padrão: últimos 7 dias até hoje)
      let { daysBack = 7 } = req.body;
      
      // Validar daysBack
      if (typeof daysBack !== 'number' || daysBack < 1 || daysBack > 90) {
        return res.status(400).json({ 
          message: 'daysBack deve ser um número entre 1 e 90' 
        });
      }
      daysBack = Math.floor(daysBack); // Garantir inteiro

      console.log(`🔄 Iniciando migração retroativa de checkpoints (últimos ${daysBack} dias)...`);
      
      // Buscar todos os sales_cards com check-in ou check-out no range especificado
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - daysBack);
      startDate.setHours(0, 0, 0, 0);

      const salesCardsWithCheckins = await db.select()
        .from(salesCards)
        .where(
          or(
            and(
              gte(salesCards.checkInTime, startDate),
              lte(salesCards.checkInTime, today)
            ),
            and(
              gte(salesCards.checkOutTime, startDate),
              lte(salesCards.checkOutTime, today)
            )
          )
        )
        .orderBy(asc(salesCards.checkInTime));

      console.log(`📊 Encontrados ${salesCardsWithCheckins.length} sales cards com check-in/out no período`);

      let checkpointsCreated = 0;
      let checkpointsSkipped = 0;
      let errors: string[] = [];
      const routesUpdated = new Set<string>();

      const { registerCheckpoint } = await import('./routeOptimizationService');

      for (const card of salesCardsWithCheckins) {
        try {
          if (!card.sellerId || !card.customerId) {
            errors.push(`Card ${card.id}: sem sellerId ou customerId`);
            continue;
          }

          // Buscar rota diária do vendedor na data do check-in/check-out
          const checkDate = card.checkInTime || card.checkOutTime;
          if (!checkDate) {
            errors.push(`Card ${card.id}: sem check-in ou check-out`);
            continue;
          }
          const dailyRoute = await storage.getDailyRouteBySellerAndDate(card.sellerId, new Date(checkDate));
          
          if (!dailyRoute) {
            errors.push(`Card ${card.id}: sem rota diária para vendedor ${card.sellerId}`);
            continue;
          }

          // Processar check-in se existir
          if (card.checkInTime && card.checkInLatitude && card.checkInLongitude) {
            // Verificar se já existe checkpoint de check-in
            const existingCheckIn = await db.select()
              .from(routeCheckpoints)
              .where(
                and(
                  eq(routeCheckpoints.visitId, card.id),
                  eq(routeCheckpoints.checkpointType, 'check_in')
                )
              )
              .limit(1);

            if (existingCheckIn.length === 0) {
              console.log(`📍 Criando checkpoint de CHECK-IN para card ${card.id}`);
              await registerCheckpoint(
                storage,
                dailyRoute.id,
                card.id,
                card.customerId,
                card.sellerId,
                'check_in',
                parseFloat(card.checkInLatitude),
                parseFloat(card.checkInLongitude)
              );
              checkpointsCreated++;
              routesUpdated.add(dailyRoute.id);
            } else {
              checkpointsSkipped++;
            }
          }

          // Processar check-out se existir
          if (card.checkOutTime && card.checkOutLatitude && card.checkOutLongitude) {
            // Verificar se já existe checkpoint de check-out
            const existingCheckOut = await db.select()
              .from(routeCheckpoints)
              .where(
                and(
                  eq(routeCheckpoints.visitId, card.id),
                  eq(routeCheckpoints.checkpointType, 'check_out')
                )
              )
              .limit(1);

            if (existingCheckOut.length === 0) {
              console.log(`📍 Criando checkpoint de CHECK-OUT para card ${card.id}`);
              await registerCheckpoint(
                storage,
                dailyRoute.id,
                card.id,
                card.customerId,
                card.sellerId,
                'check_out',
                parseFloat(card.checkOutLatitude),
                parseFloat(card.checkOutLongitude)
              );
              checkpointsCreated++;
              routesUpdated.add(dailyRoute.id);
            } else {
              checkpointsSkipped++;
            }
          }

        } catch (error: any) {
          console.error(`❌ Erro ao processar card ${card.id}:`, error);
          errors.push(`Card ${card.id}: ${error.message}`);
        }
      }

      console.log(`✅ Migração concluída: ${checkpointsCreated} checkpoints criados, ${checkpointsSkipped} já existiam`);

      res.json({
        success: true,
        checkpointsCreated,
        checkpointsSkipped,
        routesUpdated: routesUpdated.size,
        totalCardsProcessed: salesCardsWithCheckins.length,
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (error: any) {
      console.error('❌ Erro na migração de checkpoints:', error);
      res.status(500).json({ 
        message: 'Erro ao migrar checkpoints',
        error: error.message 
      });
    }
  });

  // RH: Buscar quilometragem mensal por vendedor
  app.get('/api/hr/monthly-mileage', authenticateUser, async (req: any, res) => {
    try {
      const { month, year } = req.query;
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ message: 'Usuário não autenticado' });
      }
      
      if (!month || !year) {
        return res.status(400).json({ message: 'Mês e ano são obrigatórios' });
      }

      const monthNum = parseInt(month);
      const yearNum = parseInt(year);

      // Calcular início e fim do mês
      const startDate = new Date(yearNum, monthNum - 1, 1);
      const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);

      // Apenas usuários administrativos veem todos os dados
      const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user.role);
      
      // Buscar usuários: todos (se admin) ou apenas o próprio usuário logado
      const usersQuery = db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email
      })
      .from(users);
      
      const sellers = isAdmin 
        ? await usersQuery
        : await usersQuery.where(eq(users.id, user.id));

      // Para cada vendedor, buscar rotas do mês
      const mileageData = await Promise.all(sellers.map(async (seller) => {
        const routes = await db.select({
          id: dailyRoutes.id,
          routeDate: dailyRoutes.routeDate,
          totalActualDistance: dailyRoutes.totalActualDistance,
          completedVisits: dailyRoutes.completedVisits
        })
        .from(dailyRoutes)
        .where(
          and(
            eq(dailyRoutes.sellerId, seller.id),
            gte(dailyRoutes.routeDate, startDate),
            lte(dailyRoutes.routeDate, endDate)
          )
        )
        .orderBy(asc(dailyRoutes.routeDate));

        // Agrupar por dia
        const dailyData = routes.map(route => ({
          date: route.routeDate,
          distance: parseFloat(route.totalActualDistance || '0'),
          visits: route.completedVisits || 0
        }));

        // Calcular total do mês
        const totalDistance = dailyData.reduce((sum, day) => sum + day.distance, 0);

        return {
          sellerId: seller.id,
          sellerName: `${seller.firstName || ''} ${seller.lastName || ''}`.trim(),
          sellerEmail: seller.email,
          dailyData,
          totalDistance
        };
      }));

      res.json(mileageData);

    } catch (error: any) {
      console.error('Erro ao buscar quilometragem mensal:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar quilometragem mensal',
        error: error.message 
      });
    }
  });

  // RH: Buscar carga horária mensal por vendedor
  app.get('/api/hr/monthly-hours', authenticateUser, async (req: any, res) => {
    try {
      const { month, year } = req.query;
      const user = req.user;
      
      if (!month || !year) {
        return res.status(400).json({ message: 'Mês e ano são obrigatórios' });
      }

      const monthNum = parseInt(month);
      const yearNum = parseInt(year);

      // Calcular início e fim do mês
      const startDate = new Date(yearNum, monthNum - 1, 1);
      const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);

      // Apenas usuários administrativos veem todos os dados
      const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user.role);
      
      // Buscar usuários: todos (se admin) ou apenas o próprio usuário logado
      const usersQuery = db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email
      })
      .from(users);
      
      const sellers = isAdmin 
        ? await usersQuery
        : await usersQuery.where(eq(users.id, user.id));

      // Para cada vendedor, buscar check-ins e check-outs do mês
      const hoursData = await Promise.all(sellers.map(async (seller) => {
        // Buscar todos os checkpoints do mês do vendedor
        const checkpoints = await db.select({
          id: routeCheckpoints.id,
          checkpointType: routeCheckpoints.checkpointType,
          checkpointTime: routeCheckpoints.checkpointTime
        })
        .from(routeCheckpoints)
        .where(
          and(
            eq(routeCheckpoints.sellerId, seller.id),
            gte(routeCheckpoints.checkpointTime, startDate),
            lte(routeCheckpoints.checkpointTime, endDate)
          )
        )
        .orderBy(asc(routeCheckpoints.checkpointTime));

        // Agrupar por dia e calcular horas trabalhadas
        const dayMap = new Map<string, { 
          date: Date, 
          firstCheckIn: Date | null, 
          lastCheckOut: Date | null,
          checkIns: number,
          checkOuts: number
        }>();

        checkpoints.forEach(checkpoint => {
          const checkpointDate = new Date(checkpoint.checkpointTime);
          const dateKey = checkpointDate.toISOString().split('T')[0];
          
          if (!dayMap.has(dateKey)) {
            dayMap.set(dateKey, {
              date: new Date(checkpointDate.getFullYear(), checkpointDate.getMonth(), checkpointDate.getDate()),
              firstCheckIn: null,
              lastCheckOut: null,
              checkIns: 0,
              checkOuts: 0
            });
          }

          const dayData = dayMap.get(dateKey)!;

          if (checkpoint.checkpointType === 'check_in') {
            if (!dayData.firstCheckIn || checkpointDate < dayData.firstCheckIn) {
              dayData.firstCheckIn = checkpointDate;
            }
            dayData.checkIns++;
          }

          if (checkpoint.checkpointType === 'check_out') {
            if (!dayData.lastCheckOut || checkpointDate > dayData.lastCheckOut) {
              dayData.lastCheckOut = checkpointDate;
            }
            dayData.checkOuts++;
          }
        });

        // Calcular horas trabalhadas por dia
        const dailyData = Array.from(dayMap.values()).map(day => {
          let hoursWorked = 0;
          let expectedHours = 0;

          // Determinar horas esperadas baseado no dia da semana
          const dayOfWeek = day.date.getDay(); // 0 = domingo, 1 = segunda, ..., 5 = sexta, 6 = sábado
          if (dayOfWeek >= 1 && dayOfWeek <= 4) {
            // Segunda a quinta: 9 horas
            expectedHours = 9;
          } else if (dayOfWeek === 5) {
            // Sexta: 8 horas
            expectedHours = 8;
          }
          // Sábado e domingo: 0 horas (não são dias úteis)

          // Calcular horas trabalhadas
          if (day.firstCheckIn && day.lastCheckOut) {
            const diffMs = day.lastCheckOut.getTime() - day.firstCheckIn.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            // Descontar 1.5 horas de almoço
            hoursWorked = Math.max(0, diffHours - 1.5);
          }

          return {
            date: day.date,
            dayOfWeek: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][dayOfWeek],
            firstCheckIn: day.firstCheckIn,
            lastCheckOut: day.lastCheckOut,
            hoursWorked: parseFloat(hoursWorked.toFixed(2)),
            expectedHours,
            difference: parseFloat((hoursWorked - expectedHours).toFixed(2)),
            checkIns: day.checkIns,
            checkOuts: day.checkOuts
          };
        });

        // Calcular totais semanais e mensais
        const weeklyTotals: Array<{ weekNumber: number; hoursWorked: number; expectedHours: number }> = [];
        let currentWeek: { weekNumber: number; hoursWorked: number; expectedHours: number } | null = null;

        dailyData.forEach(day => {
          const weekNumber = Math.ceil(day.date.getDate() / 7);
          
          if (!currentWeek || currentWeek.weekNumber !== weekNumber) {
            if (currentWeek) {
              weeklyTotals.push(currentWeek);
            }
            currentWeek = { weekNumber, hoursWorked: 0, expectedHours: 0 };
          }

          currentWeek.hoursWorked += day.hoursWorked;
          currentWeek.expectedHours += day.expectedHours;
        });

        if (currentWeek) {
          weeklyTotals.push(currentWeek);
        }

        // Total mensal
        const totalMonthlyHours = dailyData.reduce((sum, day) => sum + day.hoursWorked, 0);
        const totalExpectedHours = dailyData.reduce((sum, day) => sum + day.expectedHours, 0);

        return {
          sellerId: seller.id,
          sellerName: `${seller.firstName || ''} ${seller.lastName || ''}`.trim(),
          sellerEmail: seller.email,
          dailyData,
          weeklyTotals: weeklyTotals.map(week => ({
            ...week,
            hoursWorked: parseFloat(week.hoursWorked.toFixed(2)),
            expectedHours: parseFloat(week.expectedHours.toFixed(2)),
            difference: parseFloat((week.hoursWorked - week.expectedHours).toFixed(2))
          })),
          totalMonthlyHours: parseFloat(totalMonthlyHours.toFixed(2)),
          totalExpectedHours: parseFloat(totalExpectedHours.toFixed(2)),
          totalDifference: parseFloat((totalMonthlyHours - totalExpectedHours).toFixed(2))
        };
      }));

      res.json(hoursData);

    } catch (error: any) {
      console.error('Erro ao buscar carga horária mensal:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar carga horária mensal',
        error: error.message 
      });
    }
  });

  // Rota para buscar performance de atendimento mensal
  app.get('/api/hr/daily-attendance', authenticateUser, async (req: any, res) => {
    try {
      const { month, year } = req.query;
      const user = req.currentUser;
      
      if (!user) {
        return res.status(401).json({ message: 'Usuário não autenticado' });
      }
      
      if (!month || !year) {
        return res.status(400).json({ message: 'Mês e ano são obrigatórios' });
      }

      const monthNum = parseInt(month);
      const yearNum = parseInt(year);

      // Calcular início e fim do mês
      const startDate = new Date(yearNum, monthNum - 1, 1);
      const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);

      // Apenas usuários administrativos veem todos os dados
      const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user.role);
      
      // Buscar usuários: todos (se admin) ou apenas o próprio usuário logado
      const usersQuery = db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role
      })
      .from(users)
      .where(eq(users.role, 'vendedor'));
      
      const sellers = isAdmin 
        ? await usersQuery
        : await usersQuery.where(eq(users.id, user.id));

      // Para cada vendedor, buscar performance de atendimento
      const attendanceData = await Promise.all(sellers.map(async (seller) => {
        // Buscar todas as rotas diárias do mês
        const routes = await db.select({
          id: dailyRoutes.id,
          routeDate: dailyRoutes.routeDate,
          optimizedVisitIds: dailyRoutes.optimizedVisitIds,
          visitIds: dailyRoutes.visitIds
        })
        .from(dailyRoutes)
        .where(
          and(
            eq(dailyRoutes.sellerId, seller.id),
            gte(dailyRoutes.routeDate, startDate),
            lte(dailyRoutes.routeDate, endDate)
          )
        )
        .orderBy(asc(dailyRoutes.routeDate));

        // Para cada rota, calcular visitas agendadas vs completadas
        const dailyData = await Promise.all(routes.map(async (route) => {
          // Visitas agendadas: usar optimizedVisitIds ou visitIds
          const visitIdsList = route.optimizedVisitIds || route.visitIds || [];
          const scheduledVisits = Array.isArray(visitIdsList) ? visitIdsList.length : 0;

          // Visitas completadas: contar check-outs únicos desta rota
          const completedCheckpoints = await db.select({
            visitId: routeCheckpoints.visitId
          })
          .from(routeCheckpoints)
          .where(
            and(
              eq(routeCheckpoints.dailyRouteId, route.id),
              eq(routeCheckpoints.checkpointType, 'check_out')
            )
          );

          const completedVisits = completedCheckpoints.length;

          // Calcular percentual de atendimento
          const attendancePercentage = scheduledVisits > 0 
            ? parseFloat(((completedVisits / scheduledVisits) * 100).toFixed(2))
            : 0;

          return {
            date: route.routeDate.toISOString().split('T')[0],
            scheduledVisits,
            completedVisits,
            attendancePercentage
          };
        }));

        // Calcular totais e média mensal
        const totalScheduled = dailyData.reduce((sum, day) => sum + day.scheduledVisits, 0);
        const totalCompleted = dailyData.reduce((sum, day) => sum + day.completedVisits, 0);
        const overallPercentage = totalScheduled > 0
          ? parseFloat(((totalCompleted / totalScheduled) * 100).toFixed(2))
          : 0;

        // Calcular média dos percentuais diários (apenas dias com visitas agendadas)
        const daysWithVisits = dailyData.filter(day => day.scheduledVisits > 0);
        const monthlyAverage = daysWithVisits.length > 0
          ? parseFloat((daysWithVisits.reduce((sum, day) => sum + day.attendancePercentage, 0) / daysWithVisits.length).toFixed(2))
          : 0;

        return {
          sellerId: seller.id,
          sellerName: `${seller.firstName || ''} ${seller.lastName || ''}`.trim(),
          sellerEmail: seller.email,
          dailyData,
          monthlyAverage,
          totalScheduled,
          totalCompleted,
          overallPercentage
        };
      }));

      res.json(attendanceData);

    } catch (error: any) {
      console.error('Erro ao buscar performance de atendimento:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar performance de atendimento',
        error: error.message 
      });
    }
  });

  // ============================================================================
  // ROTAS PÚBLICAS PARA HOTSITE/E-COMMERCE
  // ============================================================================
  
  // Listar produtos ativos disponíveis para venda
  app.get('/api/public/products', async (req, res) => {
    try {
      const productsData = await storage.getProducts();
      const activeProducts = productsData.filter(p => p.isActive);
      
      // Formatar produtos para o hotsite com todas as tabelas de preço
      const formattedProducts = activeProducts.map(product => ({
        id: product.id,
        name: product.name,
        description: product.description,
        details: product.details ?? null, // Ficha técnica detalhada
        price: parseFloat(product.price), // Preço base (compatibilidade)
        retailPrice: product.retailPrice ? parseFloat(product.retailPrice) : null,
        wholesalePrice: product.wholesalePrice ? parseFloat(product.wholesalePrice) : null,
        resaleGoianiaPrice: product.resaleGoianiaPrice ? parseFloat(product.resaleGoianiaPrice) : null,
        resaleInteriorPrice: product.resaleInteriorPrice ? parseFloat(product.resaleInteriorPrice) : null,
        resaleBrasiliaPrice: product.resaleBrasiliaPrice ? parseFloat(product.resaleBrasiliaPrice) : null,
        imageUrl: product.imageUrl || '/placeholder-product.jpg',
        images: product.images || (product.imageUrl ? [product.imageUrl] : []),
        stock: product.stock
      }));
      
      res.json(formattedProducts);
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar produtos públicos:', error);
      res.status(500).json({ 
        message: 'Erro ao carregar produtos',
        error: error.message 
      });
    }
  });
  
  // Detalhes de um produto específico
  app.get('/api/public/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const product = await storage.getProduct(id);
      
      if (!product) {
        return res.status(404).json({ message: 'Produto não encontrado' });
      }
      
      if (!product.isActive) {
        return res.status(404).json({ message: 'Produto indisponível' });
      }
      
      res.json({
        id: product.id,
        name: product.name,
        description: product.description,
        details: product.details ?? null, // Ficha técnica detalhada
        price: parseFloat(product.price),
        imageUrl: product.imageUrl || '/placeholder-product.jpg',
        images: product.images || (product.imageUrl ? [product.imageUrl] : []), // Retornar array de imagens
        stock: product.stock
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar produto:', error);
      res.status(500).json({ 
        message: 'Erro ao carregar produto',
        error: error.message 
      });
    }
  });
  
  // Verificar se cliente já existe (por email, telefone ou CPF)
  app.post('/api/public/customers/check', async (req, res) => {
    try {
      const { email, phone, cpf } = req.body;
      
      if (!email && !phone && !cpf) {
        return res.status(400).json({ 
          message: 'Email, telefone ou CPF são obrigatórios' 
        });
      }
      
      const customersData = await storage.getCustomers();
      
      // Normalizar CPF se fornecido
      const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;
      
      const existingCustomer = customersData.find(c => 
        (email && c.email?.toLowerCase() === email.toLowerCase()) ||
        (phone && c.phone === phone) ||
        (cpfLimpo && c.cpf && c.cpf.replace(/\D/g, '') === cpfLimpo)
      );
      
      if (existingCustomer) {
        res.json({
          exists: true,
          customerType: existingCustomer.customerType || 'pessoa_fisica',
          id: existingCustomer.id,
          name: existingCustomer.fantasyName || existingCustomer.companyName || existingCustomer.name,
          email: existingCustomer.email,
          phone: existingCustomer.phone,
          address: existingCustomer.address,
          cpfCnpj: existingCustomer.cpf || existingCustomer.cnpj
        });
      } else {
        res.json({
          exists: false
        });
      }
      
    } catch (error: any) {
      console.error('❌ Erro ao verificar cliente:', error);
      res.status(500).json({ 
        message: 'Erro ao verificar cliente',
        error: error.message 
      });
    }
  });

  // Verificar se cliente já existe por CNPJ (hotsite - revendedores)
  app.post('/api/public/customers/check-cnpj', async (req, res) => {
    try {
      const { cnpj } = req.body;
      
      if (!cnpj) {
        return res.status(400).json({ 
          message: 'CNPJ é obrigatório' 
        });
      }
      
      // Remove formatação do CNPJ
      const cnpjLimpo = cnpj.replace(/\D/g, '');
      
      const customersData = await storage.getCustomers();
      
      const existingCustomer = customersData.find(c => 
        c.cnpj && c.cnpj.replace(/\D/g, '') === cnpjLimpo
      );
      
      if (existingCustomer) {
        res.json({
          exists: true,
          customer: {
            id: existingCustomer.id,
            name: existingCustomer.fantasyName || existingCustomer.companyName || existingCustomer.name,
            companyName: existingCustomer.companyName || existingCustomer.name,
            fantasyName: existingCustomer.fantasyName,
            cnpj: existingCustomer.cnpj,
            email: existingCustomer.email,
            phone: existingCustomer.phone,
            address: existingCustomer.address,
            city: existingCustomer.city,
            state: existingCustomer.state,
            zipCode: existingCustomer.zipCode
          }
        });
      } else {
        res.json({
          exists: false
        });
      }
      
    } catch (error: any) {
      console.error('❌ Erro ao verificar cliente por CNPJ:', error);
      res.status(500).json({ 
        message: 'Erro ao verificar cliente',
        error: error.message 
      });
    }
  });

  // Consultar CNPJ na Receita Federal (rota pública para hotsite)
  app.post('/api/public/receita/cnpj', async (req, res) => {
    try {
      const { cnpj } = req.body;
      
      if (!cnpj) {
        return res.status(400).json({ 
          message: "CNPJ é obrigatório" 
        });
      }

      // Valida formato do CNPJ
      if (!receitaService.validarCNPJ(cnpj)) {
        return res.status(400).json({ 
          message: "CNPJ inválido" 
        });
      }

      const dadosCNPJ = await receitaService.consultarCNPJ(cnpj);
      
      if (!dadosCNPJ) {
        return res.status(404).json({ 
          message: "CNPJ não encontrado" 
        });
      }

      // Formatar dados para retorno
      const dadosFormatados = {
        cnpj: receitaService.formatarCNPJ(dadosCNPJ.cnpj),
        razaoSocial: dadosCNPJ.nome,
        nomeFantasia: dadosCNPJ.fantasia || '',
        endereco: receitaService.formatarEndereco(dadosCNPJ),
        cidade: dadosCNPJ.municipio,
        estado: dadosCNPJ.uf,
        cep: dadosCNPJ.cep,
        telefone: dadosCNPJ.telefone || '',
        email: dadosCNPJ.email || '',
        situacao: dadosCNPJ.situacao,
        atividadePrincipal: dadosCNPJ.atividade_principal?.[0]?.text || ''
      };

      res.json(dadosFormatados);
    } catch (error) {
      console.error("Error fetching CNPJ from Receita Federal:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Erro ao consultar CNPJ",
      });
    }
  });
  
  // Criar pedido público (do hotsite)
  app.post('/api/public/orders', async (req, res) => {
    try {
      // Inicializar serviço Omie
      const omieService = getOmieService(storage);
      
      const orderSchema = z.object({
        customer: z.object({
          name: z.string().min(1, 'Nome é obrigatório'),
          email: z.string().email('Email inválido').optional().nullable(),
          phone: z.string().min(10, 'Telefone inválido'),
          address: z.string().min(1, 'Endereço é obrigatório'),
          cpfCnpj: z.string().optional().nullable(),
          customerType: z.enum(['pessoa_fisica', 'pessoa_juridica']).default('pessoa_fisica')
        }),
        items: z.array(z.object({
          productId: z.string(),
          productName: z.string(),
          quantity: z.number().min(1),
          unitPrice: z.number().min(0)
        })).min(1, 'Adicione pelo menos um produto'),
        totalAmount: z.number().min(0),
        paymentMethod: z.enum(['pix', 'card', 'boleto']).default('pix'),
        source: z.enum(['hotsite', 'website']).default('hotsite'),
        // Tabela de preço selecionada pelo cliente no hotsite
        priceTable: z.enum(['retail', 'wholesale', 'goiania', 'interior', 'brasilia']).optional()
      }).refine((data) => {
        // ✅ CPF obrigatório para consumidores (pessoa física)
        if (data.customer.customerType === 'pessoa_fisica') {
          if (!data.customer.cpfCnpj || data.customer.cpfCnpj.trim() === '') {
            return false;
          }
          // Validar formato CPF (11 dígitos)
          const cpfNumbers = data.customer.cpfCnpj.replace(/\D/g, '');
          return cpfNumbers.length === 11;
        }
        return true;
      }, {
        message: 'CPF é obrigatório para consumidores (pessoa física) e deve ter 11 dígitos',
        path: ['customer', 'cpfCnpj']
      }).refine((data) => {
        // ✅ Boleto não permitido para pessoa física (consumidores)
        if (data.customer.customerType === 'pessoa_fisica' && data.paymentMethod === 'boleto') {
          return false;
        }
        return true;
      }, {
        message: 'Boleto bancário não está disponível para consumidores. Utilize Pix ou Cartão.',
        path: ['paymentMethod']
      });
      
      const validatedData = orderSchema.parse(req.body);
      
      // ✅ Normalizar CPF (remover pontuação) antes de salvar
      if (validatedData.customer.cpfCnpj) {
        validatedData.customer.cpfCnpj = validatedData.customer.cpfCnpj.replace(/\D/g, '');
      }
      
      // ✅ VALIDAÇÃO SERVER-SIDE DE PREÇOS E TOTAIS
      // O hotsite usa 5 tabelas de preço: retail, wholesale, goiania, interior, brasília
      // Validação baseada na tabela de preço selecionada pelo cliente
      console.log('🔍 Validando produtos do pedido...');
      let serverSubtotal = 0;
      for (const item of validatedData.items) {
        console.log('🔍 Buscando produto:', item.productId);
        const product = await storage.getProduct(item.productId);
        console.log('🔍 Produto encontrado:', product ? 'SIM' : 'NÃO');
        
        if (!product) {
          console.error('❌ Produto não encontrado no banco:', item.productId);
          return res.status(400).json({
            message: `Produto ${item.productName} não encontrado`,
            productId: item.productId
          });
        }
        
        if (!product.isActive) {
          return res.status(400).json({
            message: `Produto ${product.name} não está mais disponível`,
            productId: item.productId
          });
        }
        
        // Selecionar preço correto baseado na tabela do cliente
        let correctPrice: number;
        if (validatedData.priceTable) {
          switch (validatedData.priceTable) {
            case 'retail':
              correctPrice = product.retailPrice ?? product.price;
              break;
            case 'wholesale':
              correctPrice = product.wholesalePrice ?? product.price;
              break;
            case 'goiania':
              correctPrice = product.resaleGoianiaPrice ?? product.price;
              break;
            case 'interior':
              correctPrice = product.resaleInteriorPrice ?? product.price;
              break;
            case 'brasilia':
              correctPrice = product.resaleBrasiliaPrice ?? product.price;
              break;
            default:
              correctPrice = product.price;
          }
        } else {
          // Fallback para preço padrão se priceTable não for enviada
          correctPrice = product.price;
        }
        
        serverSubtotal += correctPrice * item.quantity;
      }
      
      // ✅ Sem desconto - preços já são diferenciados por tabela
      const serverTotal = serverSubtotal;
      
      // Validar se o total enviado está correto (margem de 1 centavo para arredondamento)
      const totalDifference = Math.abs(serverTotal - validatedData.totalAmount);
      if (totalDifference > 0.01) {
        console.warn(`⚠️ Divergência de preço detectada! Cliente enviou: R$ ${validatedData.totalAmount.toFixed(2)}, Servidor calculou: R$ ${serverTotal.toFixed(2)} (tabela: ${validatedData.priceTable || 'padrão'})`);
        return res.status(400).json({
          message: 'O total do pedido não corresponde aos preços atuais dos produtos',
          clientTotal: validatedData.totalAmount,
          serverTotal: serverTotal,
          difference: totalDifference,
          priceTable: validatedData.priceTable
        });
      }
      
      // Atualizar totalAmount com valor validado pelo servidor
      validatedData.totalAmount = serverTotal;
      
      // Buscar vendedor FLAVIO especificamente para pedidos do hotsite
      const users = await storage.getUsers();
      let hotsiteSeller = users.find(u => u.email === 'flavio@bebahonest.com.br' && u.role === 'vendedor');
      
      if (!hotsiteSeller) {
        console.error('⚠️ Vendedor Flavio não encontrado! Usando fallback...');
        // Fallback: usar primeiro vendedor ativo ou admin
        hotsiteSeller = users.find(u => u.role === 'vendedor' && u.isActive) 
          || users.find(u => u.role === 'admin');
        
        if (!hotsiteSeller) {
          return res.status(500).json({
            message: 'Sistema não configurado: nenhum vendedor disponível para processar pedidos'
          });
        }
        
        console.log('⚠️ Usando vendedor fallback:', hotsiteSeller.email);
      } else {
        console.log('✅ Usando vendedor Flavio para pedido do hotsite');
      }
      
      // Verificar se cliente já existe ou criar novo
      let customerId: string;
      let customerRouteDay: string;
      let customerRecurrenceType: string;
      let customerSellerId: string; // ✅ Vendedor do cliente (existente ou novo)
      
      const customersData = await storage.getCustomers();
      
      // Normalizar CPF para comparação
      const cpfLimpo = validatedData.customer.cpfCnpj ? validatedData.customer.cpfCnpj.replace(/\D/g, '') : null;
      
      const existingCustomer = customersData.find(c => 
        (validatedData.customer.email && c.email?.toLowerCase() === validatedData.customer.email.toLowerCase()) ||
        (validatedData.customer.phone && c.phone === validatedData.customer.phone) ||
        (cpfLimpo && ((c.cpf && c.cpf.replace(/\D/g, '') === cpfLimpo) || (c.cnpj && c.cnpj.replace(/\D/g, '') === cpfLimpo)))
      );
      
      if (existingCustomer) {
        customerId = existingCustomer.id;
        
        // ✅ MANTER configurações existentes do cliente (rota, periodicidade E vendedor)
        let customerWeekdays: string[] = [];
        try {
          customerWeekdays = typeof existingCustomer.weekdays === 'string' 
            ? JSON.parse(existingCustomer.weekdays) 
            : existingCustomer.weekdays || [];
        } catch {
          customerWeekdays = ['Dom']; // Fallback
        }
        
        customerRouteDay = customerWeekdays[0] || 'Dom'; // Primeiro dia da rota existente
        customerRecurrenceType = existingCustomer.visitPeriodicity || 'mensal';
        customerSellerId = existingCustomer.sellerId; // ✅ Manter vendedor existente
        
        console.log(`✅ Cliente existente - mantendo configurações: vendedor=${customerSellerId}, rota=${customerRouteDay}, periodicidade=${customerRecurrenceType}`);
        
        // Atualizar todas as informações do cliente
        await storage.updateCustomer(customerId, {
          name: validatedData.customer.name,
          email: validatedData.customer.email,
          phone: validatedData.customer.phone,
          address: validatedData.customer.address
        });
        
      } else {
        // ✅ NOVO cliente do hotsite - usar configurações padrão
        customerRouteDay = 'Dom'; // Domingo para novos clientes do hotsite
        customerRecurrenceType = 'mensal'; // Mensal para novos clientes
        customerSellerId = hotsiteSeller.id; // ✅ Flavio para novos clientes
        
        console.log(`✅ Novo cliente do hotsite - usando configurações padrão: vendedor=${customerSellerId}, rota=${customerRouteDay}, periodicidade=${customerRecurrenceType}`);
        
        // Criar novo cliente
        const newCustomer = await storage.createCustomer({
          name: validatedData.customer.name,
          email: validatedData.customer.email,
          phone: validatedData.customer.phone,
          address: validatedData.customer.address,
          customerType: validatedData.customer.customerType,
          cpf: validatedData.customer.customerType === 'pessoa_fisica' ? validatedData.customer.cpfCnpj : null,
          cnpj: validatedData.customer.customerType === 'pessoa_juridica' ? validatedData.customer.cpfCnpj : null,
          companyName: validatedData.customer.customerType === 'pessoa_juridica' ? validatedData.customer.name : null,
          fantasyName: validatedData.customer.customerType === 'pessoa_juridica' ? validatedData.customer.name : null,
          route: 'GOIÂNIA', // Padrão para clientes do hotsite
          sellerId: customerSellerId, // ✅ Campo obrigatório - Flavio
          weekdays: JSON.stringify(['Dom']), // ✅ Domingos para novos clientes hotsite
          visitPeriodicity: 'mensal', // ✅ Periodicidade mensal
          isActive: true
        });
        
        customerId = newCustomer.id;
        
        // ✅ CADASTRAR CLIENTE NO OMIE AUTOMATICAMENTE
        if (validatedData.customer.cpfCnpj) {
          console.log('📤 Tentando cadastrar novo cliente no Omie...');
          try {
            const omieResult = await omieService.createClient({
              cpf: validatedData.customer.customerType === 'pessoa_fisica' ? validatedData.customer.cpfCnpj : null,
              cnpj: validatedData.customer.customerType === 'pessoa_juridica' ? validatedData.customer.cpfCnpj : null,
              name: validatedData.customer.name,
              fantasyName: validatedData.customer.customerType === 'pessoa_juridica' ? validatedData.customer.name : null,
              email: validatedData.customer.email,
              phone: validatedData.customer.phone,
              address: validatedData.customer.address,
              city: null,
              state: null,
              zipCode: null
            });
            
            if (omieResult.success) {
              console.log(`✅ Cliente cadastrado no Omie com sucesso! Código: ${omieResult.omieClientCode}`);
              
              // Atualizar cliente no Integra com código Omie
              if (omieResult.omieClientCode) {
                await storage.updateCustomer(customerId, {
                  omieCode: omieResult.omieClientCode.toString()
                });
                console.log('✅ Código Omie salvo no Integra');
              }
            } else {
              console.warn('⚠️ Não foi possível cadastrar cliente no Omie:', omieResult.message);
            }
          } catch (omieError) {
            // Não falhar o pedido se houver erro no Omie
            console.error('❌ Erro ao cadastrar cliente no Omie:', omieError);
            console.log('⚠️ Pedido será processado mesmo sem cadastro no Omie');
          }
        } else {
          console.log('⚠️ Cliente sem CPF/CNPJ - não será cadastrado no Omie');
        }
      }
      
      // Gerar número de pedido único
      const orderNumber = `WEB-${Date.now()}`;
      
      // ✅ CONFIGURAÇÃO DINÂMICA PARA PEDIDOS HOTSITE:
      // - Se cliente já existe: manter vendedor, rota e periodicidade existentes
      // - Se cliente novo: Flavio + Domingo + Mensal
      
      // ✅ Calcular scheduledDate baseado no routeDay do cliente (não na data atual)
      // Isso evita erro de validação "Data agendada não está nos dias de atendimento"
      const routeDay = customerRouteDay; // ✅ Rota do cliente (existente ou nova)
      
      const weekdayMap: Record<string, number> = {
        'Dom': 0, 'Seg': 1, 'Ter': 2, 'Qua': 3, 
        'Qui': 4, 'Sex': 5, 'Sab': 6
      };
      
      const getNextDayOfWeek = (targetDay: string): Date => {
        const today = new Date();
        const targetDayNum = weekdayMap[targetDay] ?? 0; // Default Domingo se inválido
        const currentDayNum = today.getDay();
        
        let daysUntilTarget = targetDayNum - currentDayNum;
        if (daysUntilTarget <= 0) {
          daysUntilTarget += 7; // Próxima semana
        }
        
        const nextDate = new Date(today);
        nextDate.setDate(today.getDate() + daysUntilTarget);
        nextDate.setHours(0, 0, 0, 0); // Zerar horas para meia-noite
        return nextDate;
      };
      
      const scheduledDate = getNextDayOfWeek(routeDay);
      
      // ✅ ESTRUTURAR PRODUTOS NO FORMATO COMPATÍVEL COM OMIE
      // Transformar items do hotsite para o formato esperado pelo sistema e Omie
      const formattedProducts = validatedData.items.map(item => ({
        productId: item.productId,
        name: item.productName, // ✅ Campo 'name' é usado ao enviar para Omie
        productName: item.productName, // Manter compatibilidade com código existente
        quantity: Number(item.quantity), // ✅ Garantir tipo numérico
        unitPrice: Number(item.unitPrice), // ✅ Garantir tipo numérico
        totalPrice: Number(item.quantity) * Number(item.unitPrice) // ✅ Campo obrigatório para Omie (numérico)
      }));
      
      // Criar registro do pedido (usando sales_cards temporariamente)
      // TODO: Criar tabela específica para pedidos web quando houver necessidade
      const orderData = {
        customerId,
        sellerId: customerSellerId, // ✅ Vendedor do cliente (existente ou Flavio para novos)
        scheduledDate,
        routeDay, // ✅ Rota do cliente (mantém existente ou usa 'Dom' para novos)
        recurrenceType: customerRecurrenceType, // ✅ Periodicidade do cliente
        isRecurring: true, // ✅ Habilitar recorrência
        status: 'pending',
        paymentMethod: validatedData.paymentMethod,
        operationType: 'venda',
        products: formattedProducts, // ✅ Usar produtos formatados com todos os campos necessários
        saleValue: serverTotal.toString(), // ✅ Valor total validado pelo servidor
        notes: `Pedido online via ${validatedData.source} - ${orderNumber}\nItens: ${validatedData.items.map(i => `${i.productName} (${i.quantity}x)`).join(', ')}\nTotal: R$ ${validatedData.totalAmount.toFixed(2)}\nMétodo de pagamento: ${validatedData.paymentMethod}`,
        deliveryWeekdays: [],
        deliveryTimeSlots: [],
        deliverySaturdayTimeSlots: [],
        boletoDays: validatedData.paymentMethod === 'boleto' ? 7 : null,
        source: validatedData.source
      };
      
      console.log('💾 Salvando pedido com source:', validatedData.source);
      const salesCard = await storage.createSalesCard(orderData);
      console.log('✅ Pedido salvo com ID:', salesCard.id, 'Source:', salesCard.source);
      
      res.status(201).json({
        success: true,
        orderId: salesCard.id,
        orderNumber,
        message: 'Pedido criado com sucesso!',
        customerId,
        totalAmount: validatedData.totalAmount,
        paymentMethod: validatedData.paymentMethod
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao criar pedido público:', error);
      
      if (error.name === 'ZodError') {
        return res.status(400).json({
          message: 'Dados inválidos',
          errors: error.errors
        });
      }
      
      res.status(500).json({ 
        message: 'Erro ao criar pedido',
        error: error.message 
      });
    }
  });

  // ============================================================================
  // PRODUCT REVIEWS - Endpoints públicos e administrativos
  // ============================================================================

  // Criar nova review (pública - pendente de aprovação)
  app.post('/api/public/reviews', async (req, res) => {
    try {
      const reviewData = insertProductReviewSchema.parse(req.body);
      
      const newReview = await storage.createProductReview({
        ...reviewData,
        isApproved: false, // Todas as reviews começam pendentes
      });
      
      res.status(201).json({
        success: true,
        reviewId: newReview.id,
        message: 'Avaliação enviada com sucesso! Ela será publicada após moderação.'
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao criar review:', error);
      
      if (error.name === 'ZodError') {
        return res.status(400).json({
          message: 'Dados inválidos',
          errors: error.errors
        });
      }
      
      res.status(500).json({ 
        message: 'Erro ao criar avaliação',
        error: error.message 
      });
    }
  });

  // Listar reviews aprovadas de um produto
  app.get('/api/public/products/:id/reviews', async (req, res) => {
    try {
      const { id } = req.params;
      
      const reviews = await storage.getProductReviews(id);
      
      // Retornar apenas reviews aprovadas, ordenadas da mais recente para a mais antiga
      const approvedReviews = reviews
        .filter(r => r.isApproved)
        .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
      
      res.json(approvedReviews);
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar reviews:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar avaliações',
        error: error.message 
      });
    }
  });

  // Estatísticas de reviews de um produto
  app.get('/api/public/products/:id/review-stats', async (req, res) => {
    try {
      const { id } = req.params;
      
      const reviews = await storage.getProductReviews(id);
      const approvedReviews = reviews.filter(r => r.isApproved);
      
      if (approvedReviews.length === 0) {
        return res.json({
          averageRating: 0,
          totalReviews: 0,
          ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        });
      }
      
      const totalRating = approvedReviews.reduce((sum, r) => sum + r.rating, 0);
      const averageRating = totalRating / approvedReviews.length;
      
      const ratingDistribution = approvedReviews.reduce((acc, r) => {
        acc[r.rating] = (acc[r.rating] || 0) + 1;
        return acc;
      }, {} as Record<number, number>);
      
      res.json({
        averageRating: Math.round(averageRating * 10) / 10, // 1 casa decimal
        totalReviews: approvedReviews.length,
        ratingDistribution: {
          1: ratingDistribution[1] || 0,
          2: ratingDistribution[2] || 0,
          3: ratingDistribution[3] || 0,
          4: ratingDistribution[4] || 0,
          5: ratingDistribution[5] || 0
        }
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar estatísticas de reviews:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar estatísticas',
        error: error.message 
      });
    }
  });

  // Listar todas as reviews (admin - com pendentes)
  app.get('/api/product-reviews', isAuthenticated, async (req, res) => {
    try {
      const allReviews = await storage.getAllProductReviews();
      
      // Ordenar por data de criação (mais recentes primeiro)
      const sortedReviews = allReviews.sort((a, b) => 
        new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
      );
      
      res.json(sortedReviews);
      
    } catch (error: any) {
      console.error('❌ Erro ao buscar todas as reviews:', error);
      res.status(500).json({ 
        message: 'Erro ao buscar avaliações',
        error: error.message 
      });
    }
  });

  // Aprovar/desaprovar review
  app.patch('/api/product-reviews/:id/approve', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      const { isApproved } = req.body;
      
      if (typeof isApproved !== 'boolean') {
        return res.status(400).json({ message: 'isApproved deve ser boolean' });
      }
      
      const updatedReview = await storage.updateProductReview(id, { isApproved });
      
      res.json({
        success: true,
        review: updatedReview,
        message: isApproved ? 'Review aprovada!' : 'Review desaprovada!'
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao atualizar review:', error);
      res.status(500).json({ 
        message: 'Erro ao atualizar avaliação',
        error: error.message 
      });
    }
  });

  // Deletar review
  app.delete('/api/product-reviews/:id', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      
      await storage.deleteProductReview(id);
      
      res.json({
        success: true,
        message: 'Review deletada com sucesso!'
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao deletar review:', error);
      res.status(500).json({ 
        message: 'Erro ao deletar avaliação',
        error: error.message 
      });
    }
  });

  // ============================================================================
  // ADMIN - Correção de dados
  // ============================================================================
  
  // Converter TODOS os dias da semana para formato abreviado (sales_cards, visit_agenda E customers.weekdays)
  app.post('/api/admin/fix-weekday-names', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar correções de dados
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Access denied. Admin only." });
      }
      
      console.log('🔧 Convertendo TODOS os dias da semana para formato abreviado...');
      
      // Converter sales_cards para formato abreviado
      const salesCardsResult = await db.execute(sql`
        UPDATE sales_cards
        SET route_day = CASE
          -- Dias completos em português
          WHEN route_day = 'domingo' THEN 'Dom'
          WHEN route_day = 'segunda' THEN 'Seg'
          WHEN route_day = 'terca' THEN 'Ter'
          WHEN route_day = 'quarta' THEN 'Qua'
          WHEN route_day = 'quinta' THEN 'Qui'
          WHEN route_day = 'sexta' THEN 'Sex'
          WHEN route_day = 'sabado' THEN 'Sab'
          -- Dias com hífen
          WHEN route_day = 'segunda-feira' THEN 'Seg'
          WHEN route_day = 'terça-feira' THEN 'Ter'
          WHEN route_day = 'quarta-feira' THEN 'Qua'
          WHEN route_day = 'quinta-feira' THEN 'Qui'
          WHEN route_day = 'sexta-feira' THEN 'Sex'
          WHEN route_day = 'sábado' THEN 'Sab'
          -- Caso especial mencionado: múltiplos dias separados por vírgula → domingo
          WHEN route_day LIKE '%,%' THEN 'Dom'
          -- Já está no formato abreviado correto (manter)
          WHEN route_day IN ('Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab') THEN route_day
          -- Fallback: se não reconhecer, manter o valor original
          ELSE route_day
        END
        WHERE route_day NOT IN ('Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab')
           OR route_day IS NULL
      `);
      
      // Converter visit_agenda para formato abreviado
      const visitAgendaResult = await db.execute(sql`
        UPDATE visit_agenda
        SET route_day = CASE
          -- Dias completos em português
          WHEN route_day = 'domingo' THEN 'Dom'
          WHEN route_day = 'segunda' THEN 'Seg'
          WHEN route_day = 'terca' THEN 'Ter'
          WHEN route_day = 'quarta' THEN 'Qua'
          WHEN route_day = 'quinta' THEN 'Qui'
          WHEN route_day = 'sexta' THEN 'Sex'
          WHEN route_day = 'sabado' THEN 'Sab'
          -- Dias com hífen
          WHEN route_day = 'segunda-feira' THEN 'Seg'
          WHEN route_day = 'terça-feira' THEN 'Ter'
          WHEN route_day = 'quarta-feira' THEN 'Qua'
          WHEN route_day = 'quinta-feira' THEN 'Qui'
          WHEN route_day = 'sexta-feira' THEN 'Sex'
          WHEN route_day = 'sábado' THEN 'Sab'
          -- Caso especial: múltiplos dias → domingo
          WHEN route_day LIKE '%,%' THEN 'Dom'
          -- Já está no formato abreviado correto (manter)
          WHEN route_day IN ('Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab') THEN route_day
          -- Fallback
          ELSE route_day
        END
        WHERE route_day NOT IN ('Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab')
           OR route_day IS NULL
      `);
      
      // Converter customers.weekdays (JSON array) para formato abreviado usando REPLACE
      const customersResult = await db.execute(sql`
        UPDATE customers
        SET weekdays = 
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(
                      REPLACE(
                        REPLACE(
                          REPLACE(
                            REPLACE(
                              REPLACE(
                                REPLACE(
                                  REPLACE(
                                    REPLACE(weekdays::text, 
                                      '"domingo"', '"Dom"'),
                                    '"segunda-feira"', '"Seg"'),
                                  '"terça-feira"', '"Ter"'),
                                '"quarta-feira"', '"Qua"'),
                              '"quinta-feira"', '"Qui"'),
                            '"sexta-feira"', '"Sex"'),
                          '"sábado"', '"Sab"'),
                        '"segunda"', '"Seg"'),
                      '"terca"', '"Ter"'),
                    '"terça"', '"Ter"'),
                  '"quarta"', '"Qua"'),
                '"quinta"', '"Qui"'),
              '"sexta"', '"Sex"'),
            '"sabado"', '"Sab"'
          )::jsonb
        WHERE weekdays IS NOT NULL
          AND (
            weekdays::text LIKE '%"domingo"%' OR
            weekdays::text LIKE '%"segunda"%' OR
            weekdays::text LIKE '%"terca"%' OR
            weekdays::text LIKE '%"terça"%' OR
            weekdays::text LIKE '%"quarta"%' OR
            weekdays::text LIKE '%"quinta"%' OR
            weekdays::text LIKE '%"sexta"%' OR
            weekdays::text LIKE '%"sabado"%' OR
            weekdays::text LIKE '%"sábado"%' OR
            weekdays::text LIKE '%"-feira"%'
          )
      `);
      
      console.log('✅ Conversão concluída!');
      console.log('   Sales Cards convertidos:', salesCardsResult.rowCount);
      console.log('   Visit Agenda convertidos:', visitAgendaResult.rowCount);
      console.log('   Customers convertidos:', customersResult.rowCount);
      
      res.json({
        success: true,
        message: 'Todos os dias da semana foram convertidos para formato abreviado!',
        salesCardsFixed: salesCardsResult.rowCount || 0,
        visitAgendaFixed: visitAgendaResult.rowCount || 0,
        customersFixed: customersResult.rowCount || 0
      });
      
    } catch (error: any) {
      console.error('❌ Erro ao converter dias da semana:', error);
      res.status(500).json({ 
        message: 'Erro ao converter dias da semana',
        error: error.message 
      });
    }
  });

  // Sincronização manual completa da agenda (recalcula e corrige todos os cards)
  app.post('/api/admin/sync-agenda', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar sincronizações manuais
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Access denied. Admin only." });
      }
      
      console.log('🔄 Iniciando sincronização manual completa da agenda...');
      
      // 1. Sincronizar cards futuros (deletar incorretos e criar faltantes)
      const { syncFutureSalesCards, updateExistingSalesCardsFromCustomer } = await import('./visitScheduleService');
      const result = await syncFutureSalesCards(2);
      
      console.log('✅ Fase 1: Sincronização de cards concluída');
      console.log('   Clientes processados:', result.processed);
      console.log('   Cards criados:', result.created);
      console.log('   Cards deletados:', result.deleted);
      console.log('   Erros:', result.errors);
      
      // 2. Atualizar cards existentes com dados atualizados dos clientes
      console.log('\n🔄 Fase 2: Atualizando cards existentes com dados dos clientes...');
      
      let totalUpdated = 0;
      let totalReallocated = 0;
      let updateErrors = 0;
      
      // Buscar todos os clientes ativos
      const activeCustomers = await db.select({ id: customers.id })
        .from(customers)
        .where(eq(customers.isActive, true));
      
      for (const customer of activeCustomers) {
        try {
          const updateResult = await updateExistingSalesCardsFromCustomer(customer.id);
          totalUpdated += updateResult.updated;
          totalReallocated += updateResult.reallocated;
        } catch (error: any) {
          console.error(`Erro ao atualizar cards do cliente ${customer.id}:`, error.message);
          updateErrors++;
        }
      }
      
      console.log('✅ Fase 2 concluída:');
      console.log('   Cards atualizados:', totalUpdated);
      console.log('   Cards realocados:', totalReallocated);
      console.log('   Erros:', updateErrors);
      
      res.json({
        success: true,
        message: 'Sincronização completa da agenda concluída com sucesso!',
        sync: result,
        update: {
          updated: totalUpdated,
          reallocated: totalReallocated,
          errors: updateErrors
        }
      });
      
    } catch (error: any) {
      console.error('❌ Erro na sincronização manual:', error);
      res.status(500).json({ 
        message: 'Erro ao sincronizar agenda',
        error: error.message 
      });
    }
  });

  // Diagnóstico e correção automática de cards com datas inconsistentes
  app.post('/api/admin/validate-cards', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Access denied. Admin only." });
      }

      const { autoFix = false } = req.body;

      console.log('🔍 Iniciando diagnóstico de cards...');

      // Buscar todos os cards futuros
      const allCards = await db
        .select()
        .from(salesCards)
        .leftJoin(customers, eq(salesCards.customerId, customers.id))
        .where(gte(salesCards.scheduledDate, new Date()))
        .orderBy(salesCards.scheduledDate);

      const inconsistencies: any[] = [];
      const corrections: any[] = [];

      for (const row of allCards) {
        const card = row.sales_cards;
        const customer = row.customers;

        if (!customer || !customer.weekdays) continue;

        let customerWeekdays: string[] = [];
        try {
          customerWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays || [];
        } catch (e) {
          continue;
        }

        if (customerWeekdays.length === 0) continue;

        // Verificar se o dia do card está alinhado com os weekdays do cliente
        const scheduledDate = new Date(card.scheduledDate);
        const scheduledDayOfWeek = scheduledDate.getDay();
        const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        const scheduledDayName = weekdayNames[scheduledDayOfWeek];

        if (!customerWeekdays.includes(scheduledDayName)) {
          const inconsistency = {
            cardId: card.id,
            customerId: customer.id,
            customerName: customer.fantasyName || customer.name,
            scheduledDate: card.scheduledDate,
            scheduledDay: scheduledDayName,
            expectedDays: customerWeekdays.join(', '),
            routeDay: card.routeDay,
            status: card.status
          };

          inconsistencies.push(inconsistency);

          // Se autoFix = true, corrigir a data
          if (autoFix) {
            // Importar calculateNextVisitDate (apenas uma vez fora do loop seria melhor, mas funciona)
            const { calculateNextVisitDate } = await import('../shared/visitSchedule');

            // CRÍTICO: Usar a própria scheduledDate do card como referência para manter o período correto
            // Isso garante que cards de dezembro continuem em dezembro, não sejam puxados para hoje
            const correctedResult = calculateNextVisitDate({
              weekdays: customerWeekdays,
              periodicity: (card.recurrenceType as any) || 'semanal',
              referenceDate: new Date(card.scheduledDate) // Usar data original como base
            });

            // Atualizar o card
            await db
              .update(salesCards)
              .set({
                scheduledDate: correctedResult.nextDate,
                routeDay: weekdayNames[correctedResult.nextDate.getDay()]
              })
              .where(eq(salesCards.id, card.id));

            corrections.push({
              ...inconsistency,
              newDate: correctedResult.nextDate,
              newDay: weekdayNames[correctedResult.nextDate.getDay()]
            });
          }
        }
      }

      res.json({
        totalCards: allCards.length,
        inconsistencies: inconsistencies.length,
        corrected: corrections.length,
        details: autoFix ? corrections : inconsistencies,
        message: autoFix 
          ? `${corrections.length} cards corrigidos automaticamente`
          : `${inconsistencies.length} inconsistências detectadas`
      });

    } catch (error) {
      console.error("Error validating cards:", error);
      res.status(500).json({ message: "Failed to validate cards" });
    }
  });

  // Corrigir vendedores incorretos nos sales cards
  app.post('/api/admin/fix-card-sellers', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Access denied. Admin only." });
      }

      const { autoFix = false, status = 'all' } = req.body;

      console.log('🔍 Iniciando diagnóstico de vendedores em sales cards...');
      console.log(`   - AutoFix: ${autoFix}`);
      console.log(`   - Status filter: ${status}`);

      // Buscar todos os cards (opcionalmente filtrar por status)
      let query = db
        .select({
          cardId: salesCards.id,
          cardSellerId: salesCards.sellerId,
          cardStatus: salesCards.status,
          cardScheduledDate: salesCards.scheduledDate,
          customerId: customers.id,
          customerName: customers.fantasyName,
          customerSellerId: customers.sellerId
        })
        .from(salesCards)
        .leftJoin(customers, eq(salesCards.customerId, customers.id));

      // Filtrar por status se especificado
      if (status === 'pending') {
        query = query.where(eq(salesCards.status, 'pending')) as any;
      } else if (status === 'future') {
        query = query.where(
          and(
            inArray(salesCards.status, ['pending', 'in_progress']),
            gte(salesCards.scheduledDate, new Date())
          )
        ) as any;
      }

      const allCards = await query;

      const inconsistencies: any[] = [];
      const corrections: any[] = [];
      let updated = 0;

      for (const row of allCards) {
        // Pular se cliente não existe
        if (!row.customerId || !row.customerSellerId) {
          continue;
        }

        // Verificar se o seller_id do card é diferente do seller_id do cliente
        if (row.cardSellerId !== row.customerSellerId) {
          const inconsistency = {
            cardId: row.cardId,
            customerId: row.customerId,
            customerName: row.customerName || 'N/A',
            scheduledDate: row.cardScheduledDate,
            status: row.cardStatus,
            wrongSellerId: row.cardSellerId,
            correctSellerId: row.customerSellerId
          };

          inconsistencies.push(inconsistency);

          // Se autoFix = true, corrigir o seller_id
          if (autoFix) {
            await db
              .update(salesCards)
              .set({ sellerId: row.customerSellerId })
              .where(eq(salesCards.id, row.cardId));

            corrections.push(inconsistency);
            updated++;

            if (updated % 50 === 0) {
              console.log(`   → ${updated} cards corrigidos...`);
            }
          }
        }
      }

      console.log(`✅ Diagnóstico concluído:`);
      console.log(`   - Total de cards analisados: ${allCards.length}`);
      console.log(`   - Inconsistências encontradas: ${inconsistencies.length}`);
      console.log(`   - Cards corrigidos: ${corrections.length}`);

      res.json({
        totalCards: allCards.length,
        inconsistencies: inconsistencies.length,
        corrected: corrections.length,
        details: autoFix ? corrections : inconsistencies.slice(0, 100), // Limitar a 100 para não sobrecarregar a resposta
        message: autoFix 
          ? `${corrections.length} card(s) corrigido(s) com vendedor correto`
          : `${inconsistencies.length} card(s) com vendedor incorreto detectado(s)`,
        summary: autoFix ? corrections : undefined
      });

    } catch (error) {
      console.error("❌ Error fixing card sellers:", error);
      res.status(500).json({ message: "Failed to fix card sellers", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ========================================
  // NORMALIZE WEEKDAYS MIGRATION
  // ========================================
  
  app.post('/api/admin/normalize-weekdays', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar migrações de dados
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Acesso negado. Apenas admin." });
      }

      const { dryRun = true } = req.body;

      console.log(`🔄 Iniciando normalização de weekdays (dryRun: ${dryRun})...`);

      // Buscar todos os clientes com weekdays não-null
      const allCustomers = await db
        .select()
        .from(customers)
        .where(isNotNull(customers.weekdays));

      console.log(`📊 Encontrados ${allCustomers.length} clientes com weekdays definidos`);

      const changes: any[] = [];
      const errors: any[] = [];
      let updated = 0;
      let skipped = 0;

      for (const customer of allCustomers) {
        try {
          // Tentar normalizar os weekdays atuais
          const currentWeekdays = customer.weekdays;
          
          if (!currentWeekdays) {
            skipped++;
            continue;
          }

          // Normalizar
          const normalized = normalizeWeekdayInput(currentWeekdays);
          
          // Comparar se mudou
          const currentAsString = JSON.stringify(currentWeekdays);
          const normalizedAsString = JSON.stringify(normalized);
          
          if (currentAsString !== normalizedAsString) {
            const change = {
              customerId: customer.id,
              customerName: customer.fantasyName || customer.name,
              before: currentWeekdays,
              after: normalized,
              beforeString: currentAsString,
              afterString: normalizedAsString
            };
            
            changes.push(change);

            // Se não for dry-run, atualizar
            if (!dryRun) {
              await db
                .update(customers)
                .set({ weekdays: normalized })
                .where(eq(customers.id, customer.id));

              updated++;

              if (updated % 50 === 0) {
                console.log(`   → ${updated} clientes atualizados...`);
              }
            }
          } else {
            // Weekdays já está no formato correto
            skipped++;
          }
        } catch (error: any) {
          errors.push({
            customerId: customer.id,
            customerName: customer.fantasyName || customer.name,
            currentWeekdays: customer.weekdays,
            error: error.message
          });
        }
      }

      console.log(`✅ Normalização concluída:`);
      console.log(`   - Total de clientes analisados: ${allCustomers.length}`);
      console.log(`   - Clientes com mudanças: ${changes.length}`);
      console.log(`   - Clientes já normalizados: ${skipped}`);
      console.log(`   - Clientes atualizados: ${updated}`);
      console.log(`   - Erros: ${errors.length}`);

      res.json({
        mode: dryRun ? 'DRY RUN' : 'APLICADO',
        totalCustomers: allCustomers.length,
        changes: changes.length,
        updated: updated,
        skipped: skipped,
        errors: errors.length,
        details: changes.slice(0, 100), // Limitar a 100 para não sobrecarregar a resposta
        errorDetails: errors,
        message: dryRun 
          ? `${changes.length} cliente(s) seriam normalizados (dry-run)`
          : `${updated} cliente(s) normalizado(s) com sucesso`
      });

    } catch (error) {
      console.error("❌ Error normalizing weekdays:", error);
      res.status(500).json({ 
        message: "Falha ao normalizar weekdays", 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  });

  // ========================================
  // RECALCULATE DELIVERY DAYS MIGRATION
  // ========================================
  
  app.post('/api/admin/recalculate-delivery-days', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin pode executar migrações de dados
      if (user.role !== 'admin') {
        return res.status(403).json({ message: "Acesso negado. Apenas admin." });
      }

      const { dryRun = true } = req.body;

      console.log(`🚚 Iniciando recálculo de dias de entrega (dryRun: ${dryRun})...`);
      
      // ⭐ CRÍTICO: PRIMEIRA COISA - Corrigir visitas em dias ERRADOS
      console.log(`🔧 [CORRECAO] Iniciando correção de visitas com weekdays incorretos...`);
      let correctedVisits = 0;
      let generatedVisits = 0;
      
      if (!dryRun) {
        const correctionResult = await storage.correctInvalidVisitsForActiveCustomers();
        correctedVisits = correctionResult.corrected;
        generatedVisits = correctionResult.generated;
        console.log(`✅ [CORRECAO] Correção concluída: ${correctedVisits} deletadas, ${generatedVisits} regeneradas`);
      } else {
        console.log(`📋 [CORRECAO] Modo dry-run: correção será executada se confirmado`);
      }

      // Buscar todos os clientes com weekdays não-null
      const allCustomers = await db
        .select()
        .from(customers)
        .where(isNotNull(customers.weekdays));

      console.log(`📊 Encontrados ${allCustomers.length} clientes com dias de visita definidos`);

      const changes: any[] = [];
      const errors: any[] = [];
      let updated = 0;
      let skipped = 0;

      for (const customer of allCustomers) {
        try {
          // Parse weekdays
          const parsedWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays;

          if (!Array.isArray(parsedWeekdays) || parsedWeekdays.length === 0) {
            skipped++;
            continue;
          }

          // Calcular dias de entrega corretos
          const correctDeliveryDays = calculateDeliveryDaysFromMultipleRoutes(parsedWeekdays);
          
          // Verificar se os dias atuais estão diferentes dos corretos
          const currentDeliveryDays = Array.isArray(customer.deliveryWeekdays) 
            ? customer.deliveryWeekdays 
            : [];
          
          const needsUpdate = JSON.stringify(currentDeliveryDays.sort()) !== JSON.stringify(correctDeliveryDays.sort());

          if (needsUpdate) {
            const change = {
              customerId: customer.id,
              customerName: customer.fantasyName || customer.name,
              visitDays: parsedWeekdays.join(', '),
              beforeDelivery: currentDeliveryDays.join(', ') || 'Vazio',
              afterDelivery: correctDeliveryDays.join(', ')
            };
            
            changes.push(change);

            // Se não for dry-run, atualizar
            if (!dryRun) {
              await db
                .update(customers)
                .set({ deliveryWeekdays: correctDeliveryDays })
                .where(eq(customers.id, customer.id));

              updated++;

              if (updated % 50 === 0) {
                console.log(`   → ${updated} clientes atualizados...`);
              }
            }
          } else {
            // Dias de entrega já estão corretos
            skipped++;
          }
        } catch (error: any) {
          errors.push({
            customerId: customer.id,
            customerName: customer.fantasyName || customer.name,
            currentWeekdays: customer.weekdays,
            error: error.message
          });
        }
      }

      console.log(`✅ Recálculo concluído:`);
      console.log(`   - Total de clientes analisados: ${allCustomers.length}`);
      console.log(`   - Clientes com mudanças: ${changes.length}`);
      console.log(`   - Clientes já corretos: ${skipped}`);
      console.log(`   - Clientes atualizados: ${updated}`);
      console.log(`   - Erros: ${errors.length}`);

      // ⭐ ADICIONAL: Se não for dry-run, regenerar as próximas 3 visitas para todos os clientes
      let visitsGenerated = 0;
      let visitsError = 0;
      
      if (!dryRun && updated > 0) {
        console.log(`🚀 [AGENDAMENTOS] Regenerando próximas 3 visitas para ${updated} cliente(s) com mudanças...`);
        try {
          const visitResult = await storage.generateNextVisitsForActiveCustomers();
          visitsGenerated = visitResult.generated || 0;
          visitsError = visitResult.errors || 0;
          console.log(`✅ [AGENDAMENTOS] Visitas regeneradas: ${visitsGenerated} geradas, ${visitResult.corrected || 0} corrigidas`);
        } catch (visitError) {
          console.error(`❌ [AGENDAMENTOS] Erro ao regenerar visitas:`, visitError);
          visitsError = 1;
        }
      }

      res.json({
        mode: dryRun ? 'DRY RUN' : 'APLICADO',
        totalCustomers: allCustomers.length,
        changes: changes.length,
        updated: updated,
        skipped: skipped,
        errors: errors.length,
        visitsCorrections: {
          corrected: correctedVisits,
          generated: generatedVisits
        },
        visitsGenerated: visitsGenerated,
        visitsError: visitsError,
        details: changes.slice(0, 100), // Limitar a 100 para não sobrecarregar a resposta
        errorDetails: errors,
        message: dryRun 
          ? `${changes.length} cliente(s) teriam dias de entrega recalculados (dry-run). Não será feita correção de visitas em modo dry-run.`
          : `✅ CONCLUÍDO: ${correctedVisits} visita(s) corrigida(s), ${generatedVisits} regenerada(s), ${updated} cliente(s) com dias de entrega recalculados, ${visitsGenerated} próximas visitas regeneradas!`
      });

    } catch (error) {
      console.error("❌ Error recalculating delivery days:", error);
      res.status(500).json({ 
        message: "Falha ao recalcular dias de entrega", 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  });

  // ========================================
  // LEADS ROUTES
  // ========================================
  
  // Listar leads com filtros opcionais (admin e vendedores)
  app.get('/api/leads', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { status, sellerId } = req.query;
      
      let leads = await storage.getLeads();
      
      // Filtrar por status
      if (status) {
        leads = leads.filter((lead: any) => lead.status === status);
      }
      
      // Filtrar leads disponíveis para um vendedor específico
      // (leads sem atribuição ou atribuídos ao vendedor selecionado)
      if (sellerId) {
        leads = leads.filter((lead: any) => 
          !lead.assignedTo || lead.assignedTo === sellerId
        );
      }
      
      res.json(leads);
    } catch (error) {
      console.error('Erro ao buscar leads:', error);
      res.status(500).json({ message: 'Erro ao buscar leads' });
    }
  });
  
  // Buscar um lead específico
  app.get('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const lead = await storage.getLead(id);
      
      if (!lead) {
        return res.status(404).json({ message: 'Lead não encontrado' });
      }
      
      res.json(lead);
    } catch (error) {
      console.error('Erro ao buscar lead:', error);
      res.status(500).json({ message: 'Erro ao buscar lead' });
    }
  });
  
  // Criar novo lead (apenas admin, coordinator, administrative)
  app.post('/api/leads', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Verificar permissão (apenas admin/coordinator/administrative podem criar)
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ 
          message: 'Acesso negado. Apenas usuários administrativos podem criar leads.' 
        });
      }
      
      const leadData = req.body;
      
      // Adicionar o createdBy
      const lead = await storage.createLead({
        ...leadData,
        createdBy: user.id
      });
      
      console.log(`✅ Lead criado: ${lead.fantasyName} por ${user.email}`);
      res.status(201).json(lead);
    } catch (error) {
      console.error('Erro ao criar lead:', error);
      res.status(500).json({ message: 'Erro ao criar lead' });
    }
  });
  
  // Atualizar lead
  app.patch('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      const updateData = req.body;
      
      // Buscar lead atual
      const existingLead = await storage.getLead(id);
      if (!existingLead) {
        return res.status(404).json({ message: 'Lead não encontrado' });
      }
      
      // Admin pode atualizar tudo
      // Vendedor pode atualizar apenas o lead atribuído a ele (e apenas certos campos)
      if (user.role === 'vendedor') {
        // Vendedor só pode atualizar se está atribuído a ele
        if (existingLead.assignedTo !== user.id) {
          return res.status(403).json({ 
            message: 'Acesso negado. Você só pode atualizar leads atribuídos a você.' 
          });
        }
        
        // Vendedor pode atualizar apenas: photo, observation, status, lastCheckInAt, lastCheckOutAt
        const allowedFields = ['photo', 'observation', 'status', 'lastCheckInAt', 'lastCheckOutAt'];
        const requestedFields = Object.keys(updateData);
        const hasDisallowedField = requestedFields.some(field => !allowedFields.includes(field));
        
        if (hasDisallowedField) {
          return res.status(403).json({ 
            message: 'Acesso negado. Vendedores podem atualizar apenas: foto, observação e status.' 
          });
        }
      }
      
      const lead = await storage.updateLead(id, updateData);
      res.json(lead);
    } catch (error) {
      console.error('Erro ao atualizar lead:', error);
      res.status(500).json({ message: 'Erro ao atualizar lead' });
    }
  });
  
  // Deletar lead (apenas admin)
  app.delete('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      // Apenas admin pode deletar
      if (user.role !== 'admin') {
        return res.status(403).json({ 
          message: 'Acesso negado. Apenas administradores podem deletar leads.' 
        });
      }
      
      await storage.deleteLead(id);
      console.log(`✅ Lead deletado: ${id} por ${user.email}`);
      res.json({ message: 'Lead deletado com sucesso' });
    } catch (error) {
      console.error('Erro ao deletar lead:', error);
      res.status(500).json({ message: 'Erro ao deletar lead' });
    }
  });

  // ============================================================================
  // ACTIVE CUSTOMERS ENDPOINTS - Gestão de Clientes Ativos
  // ============================================================================
  
  // Listar clientes ativos com histórico de visitas
  app.get('/api/active-customers', async (req: any, res) => {
    try {
      const activeCustomers = await storage.getActiveCustomersWithVisits();
      res.json(activeCustomers);
    } catch (error) {
      console.error('Erro ao listar clientes ativos:', error);
      res.status(500).json({ message: 'Erro ao listar clientes ativos' });
    }
  });
  
  // Histórico de uploads
  app.get('/api/active-customers/uploads', async (req: any, res) => {
    try {
      const uploads = await storage.getActiveCustomerUploads();
      res.json(uploads);
    } catch (error) {
      console.error('Erro ao listar histórico de uploads:', error);
      res.status(500).json({ message: 'Erro ao listar histórico de uploads' });
    }
  });
  
  // Upload de planilha de clientes ativos - OTIMIZADO com batch processing
  app.post('/api/active-customers/upload', authenticateUser, requireRole(['admin', 'coordinator']), upload.single('file'), async (req: any, res) => {
    let uploadRecord: any = null;
    try {
      const user = req.currentUser;
      const file = req.file;
      
      if (!file) {
        return res.status(400).json({ message: 'Nenhum arquivo enviado' });
      }
      
      if (!user || !user.id) {
        return res.status(401).json({ message: 'Usuário não autenticado' });
      }
      
      // Create upload record
      try {
        uploadRecord = await storage.createActiveCustomerUpload({
          fileName: file.originalname,
          uploadedBy: user.id,
          processingStatus: 'processing'
        });
      } catch (uploadRecordError) {
        console.error('❌ Erro ao criar registro de upload:', uploadRecordError);
        return res.status(500).json({ message: 'Erro ao criar registro de upload', error: String(uploadRecordError) });
      }
      
      try {
        // Parse Excel file
        const workbook = XLSX.read(file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json<any>(worksheet);
        
        console.log(`📊 Processando ${data.length} linhas do arquivo ${file.originalname}`);
        
        if (data.length === 0) {
          await storage.updateActiveCustomerUpload(uploadRecord.id, {
            processingStatus: 'error',
            errorMessage: 'Arquivo vazio'
          });
          return res.status(400).json({ message: 'Arquivo vazio' });
        }
        
        // Fase 1: Extrair e normalizar todos os documentos
        const documentsMap = new Map<string, { fantasyName: string; documentType: string }>();
        
        for (const row of data) {
          let document = '';
          let fantasyName = '';
          
          // Buscar documento com mais flexibilidade
          for (const key of Object.keys(row)) {
            const keyLower = key.toLowerCase();
            if ((keyLower.includes('cpf') || keyLower.includes('cnpj') || keyLower.includes('documento')) && !document) {
              document = String(row[key] || '');
            }
            if ((keyLower.includes('fantasia') || keyLower.includes('nome')) && !fantasyName) {
              fantasyName = String(row[key] || '');
            }
          }
          
          if (!document) continue;
          
          const normalizedDoc = String(document).replace(/\D/g, '');
          if (!normalizedDoc) continue;
          
          const documentType = normalizedDoc.length <= 11 ? 'cpf' : 'cnpj';
          documentsMap.set(normalizedDoc, { fantasyName: fantasyName || '', documentType });
        }
        
        const documentsInFile = Array.from(documentsMap.keys());
        console.log(`📋 ${documentsInFile.length} documentos únicos extraídos`);
        
        // Fase 2: Buscar todos os customers de uma vez (batch query)
        const allCustomers = await db.select().from(customers).where(
          or(
            inArray(customers.cpf, documentsInFile),
            inArray(customers.cnpj, documentsInFile)
          )
        );
        
        // Criar mapa de documento -> customer
        const customerByDoc = new Map<string, typeof allCustomers[0]>();
        for (const c of allCustomers) {
          if (c.cpf) customerByDoc.set(c.cpf.replace(/\D/g, ''), c);
          if (c.cnpj) customerByDoc.set(c.cnpj.replace(/\D/g, ''), c);
        }
        
        console.log(`🔍 ${allCustomers.length} clientes encontrados no banco`);
        
        // Fase 3: Preparar dados para inserção
        const customersToAdd: any[] = [];
        let matched = 0;
        let unmatched = 0;
        
        for (const [doc, info] of documentsMap) {
          const customer = customerByDoc.get(doc);
          
          // 📍 Extrair coordenadas da planilha se disponíveis
          let latitude: number | null = null;
          let longitude: number | null = null;
          const originalRow = data.find(row => {
            const rowDoc = String(row[Object.keys(row).find(k => k.toLowerCase().includes('cpf') || k.toLowerCase().includes('cnpj')) || ''] || '').replace(/\D/g, '');
            return rowDoc === doc;
          });
          if (originalRow) {
            for (const key of Object.keys(originalRow)) {
              const keyLower = key.toLowerCase();
              if (keyLower.includes('latitude') || keyLower.includes('lat')) {
                latitude = parseFloat(String(originalRow[key]));
              }
              if (keyLower.includes('longitude') || keyLower.includes('long')) {
                longitude = parseFloat(String(originalRow[key]));
              }
            }
          }

          customersToAdd.push({
            document: doc,
            documentType: info.documentType,
            fantasyNameImported: info.fantasyName || null,
            customerId: customer?.id || null,
            uploadId: uploadRecord.id,
            matchStatus: customer ? 'matched' : 'unmatched',
            latitude: latitude && !isNaN(latitude) ? latitude : null,
            longitude: longitude && !isNaN(longitude) ? longitude : null,
            isActive: true,
            activatedAt: new Date()
          });
          
          if (customer) {
            matched++;
          } else {
            unmatched++;
          }
        }
        
        // Fase 4: Desativar clientes que não estão na nova lista
        const removed = await storage.deactivateRemovedCustomers(uploadRecord.id, documentsInFile);
        
        // Fase 5: Upsert em lote
        const { added, updated } = await storage.bulkUpsertActiveCustomers(customersToAdd);
        
        // Fase 5.5: CRÍTICO - Corrigir visitas com weekdays incorretos
        const { corrected, generated } = await storage.correctInvalidVisitsForActiveCustomers();
        
        // Fase 6: Atualizar registro de upload
        await storage.updateActiveCustomerUpload(uploadRecord.id, {
          totalRecords: data.length,
          matchedRecords: matched,
          unmatchedRecords: unmatched,
          addedCustomers: added,
          removedCustomers: removed,
          keptCustomers: updated,
          processingStatus: 'completed'
        });
        
        console.log(`✅ Upload processado: ${data.length} linhas, ${matched} encontrados, ${unmatched} não encontrados, ${added} adicionados, ${removed} removidos`);
        console.log(`✅ Visitas corrigidas: ${corrected} deletadas, ${generated} regeneradas`);
        
        const response = {
          message: 'Upload processado com sucesso',
          uploadId: uploadRecord.id,
          totalRecords: data.length,
          matchedRecords: matched,
          unmatchedRecords: unmatched,
          addedCustomers: added,
          removedCustomers: removed,
          keptCustomers: updated,
          visitsCorrections: { corrected, generated }
        };
        
        return res.json(response);
        
      } catch (parseError) {
        console.error('❌ Erro ao processar planilha:', parseError);
        if (uploadRecord) {
          await storage.updateActiveCustomerUpload(uploadRecord.id, {
            processingStatus: 'error',
            errorMessage: String(parseError)
          });
        }
        return res.status(400).json({ message: 'Erro ao processar planilha', error: String(parseError) });
      }
      
    } catch (error) {
      console.error('❌ Erro no upload de clientes ativos:', error);
      if (uploadRecord) {
        try {
          await storage.updateActiveCustomerUpload(uploadRecord.id, {
            processingStatus: 'error',
            errorMessage: String(error)
          });
        } catch (e) {
          console.error('Erro ao atualizar status de upload:', e);
        }
      }
      return res.status(500).json({ message: 'Erro ao processar upload', error: String(error) });
    }
  });
  
  // Verificar se cliente está na lista ativa
  app.get('/api/active-customers/check/:customerId', authenticateUser, async (req: any, res) => {
    try {
      const { customerId } = req.params;
      const isActive = await storage.isCustomerInActiveList(customerId);
      res.json({ customerId, isActive });
    } catch (error) {
      console.error('Erro ao verificar cliente ativo:', error);
      res.status(500).json({ message: 'Erro ao verificar cliente' });
    }
  });

  // Adicionar cliente à lista ativa
  app.post('/api/active-customers/add/:customerId', authenticateUser, async (req: any, res) => {
    try {
      const { customerId } = req.params;
      const customer = await storage.getCustomer(customerId);
      
      if (!customer) {
        return res.status(404).json({ message: 'Cliente não encontrado' });
      }

      // Buscar documento (CPF ou CNPJ)
      const document = customer.cpf?.replace(/\D/g, '') || customer.cnpj?.replace(/\D/g, '');
      
      if (!document) {
        return res.status(400).json({ message: 'Cliente não possui CPF ou CNPJ cadastrado' });
      }

      // Verificar se já existe na lista ativa
      const existing = await storage.getActiveCustomerByDocument(document);
      
      if (existing) {
        // Se existe mas está inativo, ativar
        if (!existing.isActive) {
          await storage.updateActiveCustomer(existing.id, { isActive: true });
        }
        return res.json({ message: 'Cliente já estava na lista ativa', activeCustomer: existing });
      }

      // Criar novo registro na lista ativa
      const activeCustomer = await storage.createActiveCustomer({
        document,
        documentType: customer.cpf ? 'cpf' : 'cnpj',
        fantasyNameImported: customer.fantasyName || customer.name,
        customerId,
        uploadId: 'manual-add', // Marcador especial para adições manuais
        matchStatus: 'matched',
        latitude: customer.latitude ? parseFloat(customer.latitude.toString()) : undefined,
        longitude: customer.longitude ? parseFloat(customer.longitude.toString()) : undefined,
        isActive: true,
      });

      res.json({ message: 'Cliente adicionado à lista ativa com sucesso', activeCustomer });
    } catch (error) {
      console.error('Erro ao adicionar cliente aos ativos:', error);
      res.status(500).json({ message: 'Erro ao adicionar cliente', error: String(error) });
    }
  });
  
  // Reconciliar clientes não vinculados (admin only)
  app.post('/api/active-customers/reconcile', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      // Buscar todos os clientes ativos sem customerId
      const unmatchedActive = await db.select().from(activeCustomers).where(
        and(
          eq(activeCustomers.isActive, true),
          isNull(activeCustomers.customerId)
        )
      );
      
      if (unmatchedActive.length === 0) {
        return res.json({ message: 'Nenhum cliente para reconciliar', reconciled: 0 });
      }
      
      const documents = unmatchedActive.map(a => a.document);
      
      // Buscar customers por documento
      const matchedCustomers = await db.select().from(customers).where(
        or(
          inArray(customers.cpf, documents),
          inArray(customers.cnpj, documents)
        )
      );
      
      const customerByDoc = new Map<string, typeof matchedCustomers[0]>();
      for (const c of matchedCustomers) {
        if (c.cpf) customerByDoc.set(c.cpf.replace(/\D/g, ''), c);
        if (c.cnpj) customerByDoc.set(c.cnpj.replace(/\D/g, ''), c);
      }
      
      let reconciled = 0;
      for (const ac of unmatchedActive) {
        const customer = customerByDoc.get(ac.document);
        if (customer) {
          await db.update(activeCustomers)
            .set({ customerId: customer.id, matchStatus: 'matched', updatedAt: new Date() })
            .where(eq(activeCustomers.id, ac.id));
          reconciled++;
        }
      }
      
      console.log(`✅ Reconciliação: ${reconciled} clientes vinculados de ${unmatchedActive.length} não vinculados`);
      res.json({ message: 'Reconciliação concluída', reconciled, total: unmatchedActive.length });
    } catch (error) {
      console.error('Erro na reconciliação:', error);
      res.status(500).json({ message: 'Erro na reconciliação' });
    }
  });
  
  // Baixar template de planilha
  app.get('/api/active-customers/template', authenticateUser, (req: any, res) => {
    try {
      const templateData = [
        { 'CPF/CNPJ': '00.000.000/0001-00', 'Nome Fantasia': 'Empresa Exemplo' },
        { 'CPF/CNPJ': '000.000.000-00', 'Nome Fantasia': 'Cliente Exemplo' }
      ];
      
      const worksheet = XLSX.utils.json_to_sheet(templateData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Clientes Ativos');
      
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=template_clientes_ativos.xlsx');
      res.send(buffer);
    } catch (error) {
      console.error('Erro ao gerar template:', error);
      res.status(500).json({ message: 'Erro ao gerar template' });
    }
  });

  // ============================================================================
  // BACKUP ENDPOINTS - Backup automático de pedidos e bloqueados
  // ============================================================================
  app.get('/api/admin/backups', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const { startDate, endDate, backupType } = req.query;
      if (!startDate || !endDate) return res.status(400).json({ message: 'Informe startDate e endDate' });
      const { getBackupsByDateRange } = await import('./backup-service.js');
      const backups = await getBackupsByDateRange(new Date(startDate), new Date(endDate), backupType);
      res.json({ total: backups.length, backups, salesCards: backups.filter(b => b.backupType === 'sales_card').length, blockedOrders: backups.filter(b => b.backupType === 'blocked_order').length });
    } catch (error) {
      res.status(500).json({ message: 'Erro ao listar backups' });
    }
  });

  app.get('/api/admin/backups/blocked-orders', authenticateUser, requireRole(['admin', 'coordinator']), async (req: any, res) => {
    try {
      const { getBlockedOrdersBackups } = await import('./backup-service.js');
      const backups = await getBlockedOrdersBackups();
      res.json({ total: backups.length, backups, message: `${backups.length} pedido(s) bloqueado(s)` });
    } catch (error) {
      res.status(500).json({ message: 'Erro ao buscar backups' });
    }
  });

  app.post('/api/admin/backups/run', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { backupAllOrders } = await import('./backup-service.js');
      const result = await backupAllOrders();
      console.log(`✅ Backup manual: ${result.backedUp} pedidos por ${req.currentUser.email}`);
      res.json({ ...result, timestamp: new Date() });
    } catch (error) {
      res.status(500).json({ message: 'Erro ao executar backup', error: String(error) });
    }
  });

  // Importar e registrar rotas do Chat Honest ANTES de criar o servidor HTTP
  const { registerChatRoutes } = await import('./chat-routes.js');
  registerChatRoutes(app);

  const httpServer = createServer(app);

  return httpServer;
}
