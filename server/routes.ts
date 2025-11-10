import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { validateLocalAdmin, createLocalSession, validateUser, setUserPassword, initializeDefaultAdmin } from "./localAuth";
import { authenticateUser, authenticateAdmin, requireRole, checkSellerAccess } from "./authMiddleware";
import { getOmieService, isOmieConfigured } from "./omieIntegration";
import { generateVisitAgenda, ensureFutureAgendaCoverage, updateExistingSalesCardsFromCustomer, propagateRecurrenceChange } from "./visitScheduleService";
import { applyCustomerRecurrenceChange } from "./customerRecurrenceService";
import { optimizeRouteAdvanced, type RouteLocation } from "../shared/routeOptimization.js";
import { receitaService } from "./receitaIntegration";
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
  insertLeadSchema,
  visitAgenda,
  users,
  salesCards,
  blockedOrders,
  customers,
  billings as billingsTable,
  syncStates,
  dailyRoutes,
  routeCheckpoints,
} from "@shared/schema";
import { z } from "zod";
import { sql, eq, and, gte, lte, isNotNull, inArray, ne, or, isNull, asc, desc } from "drizzle-orm";
import { db } from "./db";
import multer from 'multer';
import * as XLSX from 'xlsx';
import bcrypt from 'bcrypt';
import path from 'path';
import fs from 'fs';
import { APP_VERSION, VERSION_HISTORY } from '../shared/version';

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

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

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
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
      const customers = await storage.getCustomers(sellerId);
      res.json(customers);
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ message: "Failed to fetch customers" });
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
      
      // Check if customer exists and capture previous state for recurrence detection
      const existingCustomer = await storage.getCustomer(id);
      if (!existingCustomer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Capture previous state for recurrence comparison
      const previousState = {
        sellerId: existingCustomer.sellerId || undefined,
        weekdays: existingCustomer.weekdays || undefined,
        visitPeriodicity: existingCustomer.visitPeriodicity || undefined
      };
      
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
        name: updatedCustomer.fantasyName || updatedCustomer.name,
        weekdays: updatedCustomer.weekdays,
        visitPeriodicity: updatedCustomer.visitPeriodicity,
        sellerId: updatedCustomer.sellerId
      });
      
      // Detect recurrence changes
      const normalizeWeekdays = (wd: any): string[] => {
        if (!wd) return [];
        if (Array.isArray(wd)) return wd;
        if (typeof wd === 'string') {
          try {
            return JSON.parse(wd);
          } catch {
            return [];
          }
        }
        return [];
      };
      
      const previousWeekdays = normalizeWeekdays(previousState.weekdays);
      const newWeekdays = normalizeWeekdays(updatedCustomer.weekdays);
      const weekdaysChanged = JSON.stringify(previousWeekdays.sort()) !== JSON.stringify(newWeekdays.sort());
      const periodicityChanged = previousState.visitPeriodicity !== updatedCustomer.visitPeriodicity;
      const sellerChanged = previousState.sellerId !== updatedCustomer.sellerId;
      
      // Apply recurrence changes if any recurrence field changed
      if (weekdaysChanged || periodicityChanged || sellerChanged) {
        try {
          console.log(`🔄 Detectadas mudanças de recorrência para cliente ${updatedCustomer.fantasyName || updatedCustomer.name}...`);
          const recurrenceResult = await applyCustomerRecurrenceChange(id, {
            weekdays: newWeekdays.length > 0 ? newWeekdays : undefined,
            visitPeriodicity: updatedCustomer.visitPeriodicity || undefined,
            sellerId: updatedCustomer.sellerId || undefined
          }, {
            sellerId: previousState.sellerId,
            weekdays: previousWeekdays.length > 0 ? previousWeekdays : undefined,
            visitPeriodicity: previousState.visitPeriodicity
          });
          
          if (recurrenceResult.success) {
            console.log(`✅ Recorrência atualizada: ${recurrenceResult.invalidatedRoutes.length} rotas invalidadas`);
          } else {
            console.warn(`⚠️ Falha ao atualizar recorrência: ${recurrenceResult.message}`);
          }
        } catch (recurrenceError: any) {
          console.error('⚠️ Erro ao aplicar mudanças de recorrência:', recurrenceError);
        }
      }
      
      // Atualizar automaticamente os salesCards futuros com os novos dados do cliente
      try {
        console.log(`🔄 Iniciando recalculo de nextVisitDate para cliente ${updatedCustomer.fantasyName || updatedCustomer.name}...`);
        const { updateExistingSalesCardsFromCustomer } = await import('./visitScheduleService');
        const updateResult = await updateExistingSalesCardsFromCustomer(id);
        
        if (updateResult.updated > 0 || updateResult.reallocated > 0) {
          console.log(`✅ Cards do cliente atualizados: ${updateResult.updated} atualizados, ${updateResult.reallocated} realocados`);
        } else {
          console.log(`ℹ️ Nenhum card foi atualizado. Verifique se o cliente tem um permanent card ativo.`);
        }
      } catch (updateError: any) {
        console.error('⚠️ Erro ao atualizar cards do cliente:', updateError);
        console.error('⚠️ Stack:', updateError.stack);
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
      
      // Build success message and sync with Omie if applicable
      let message = "Cliente inativado com sucesso no sistema";
      let omieInactivationResult = null;
      
      if (result.customer.omieClientCode) {
        try {
          // Extract numeric code from omieClientCode (format: "omie-client-XXXXXX")
          const numericCode = parseInt(result.customer.omieClientCode.replace('omie-client-', ''));
          
          if (!isNaN(numericCode)) {
            console.log(`🔄 Sincronizando inativação com Omie para cliente ${numericCode}...`);
            const omieResult = await omieIntegration.inactivateClient(numericCode);
            omieInactivationResult = omieResult;
            
            if (omieResult.success) {
              message += `. Cliente também foi inativado no Omie ERP com sucesso!`;
            } else {
              message += `. ATENÇÃO: Erro ao inativar no Omie ERP: ${omieResult.message}. Por favor, inative manualmente no Omie.`;
            }
          } else {
            message += ". ATENÇÃO: Código Omie inválido. Por favor, inative manualmente no Omie ERP.";
          }
        } catch (omieError) {
          console.error('❌ Erro ao sincronizar inativação com Omie:', omieError);
          message += `. ATENÇÃO: Erro ao comunicar com Omie ERP. Por favor, inative manualmente no Omie.`;
        }
      }
      
      res.json({
        message,
        customer: result.customer,
        deletedCards: result.deletedCards,
        omieInactivation: omieInactivationResult
      });
    } catch (error) {
      console.error("Error inactivating customer:", error);
      res.status(500).json({ message: "Falha ao inativar cliente" });
    }
  });

  // Gerenciar TAG "NAO CLIENTE"
  app.post('/api/customers/:id/tags', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { tag, action } = req.body; // action: "add" or "remove"
      const user = req.currentUser;
      
      // Only admin, coordinator, and administrative can manage the "NAO CLIENTE" tag
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Acesso negado. Apenas administradores, coordenadores e administrativos podem gerenciar tags de clientes." });
      }
      
      // Validate tag (currently only "NAO CLIENTE" is supported)
      if (tag !== 'NAO CLIENTE') {
        return res.status(400).json({ message: "Tag inválida. Apenas a tag 'NAO CLIENTE' é suportada atualmente." });
      }
      
      // Validate action
      if (!['add', 'remove'].includes(action)) {
        return res.status(400).json({ message: "Ação inválida. Use 'add' ou 'remove'." });
      }
      
      // Get customer
      const customer = await storage.getCustomer(id);
      if (!customer) {
        return res.status(404).json({ message: "Cliente não encontrado" });
      }
      
      // Get current tags array (ensure it's always an array)
      let currentTags: string[] = [];
      if (customer.tags) {
        currentTags = Array.isArray(customer.tags) ? customer.tags : [];
      }
      
      // Add or remove tag
      let newTags: string[];
      let message: string;
      
      if (action === 'add') {
        if (currentTags.includes(tag)) {
          return res.status(400).json({ message: `Cliente já possui a tag '${tag}'` });
        }
        newTags = [...currentTags, tag];
        message = `Tag '${tag}' adicionada com sucesso. Este cliente não aparecerá mais nas rotinas de vendas (positivação, rotas, metas).`;
      } else {
        if (!currentTags.includes(tag)) {
          return res.status(400).json({ message: `Cliente não possui a tag '${tag}'` });
        }
        newTags = currentTags.filter(t => t !== tag);
        message = `Tag '${tag}' removida com sucesso. Este cliente voltará a aparecer nas rotinas de vendas.`;
      }
      
      // Update customer with new tags
      const updatedCustomer = await storage.updateCustomer(id, { tags: newTags });
      
      res.json({
        message,
        customer: updatedCustomer,
        tags: newTags
      });
    } catch (error) {
      console.error("Error managing customer tags:", error);
      res.status(500).json({ message: "Falha ao gerenciar tags do cliente" });
    }
  });

  app.post('/api/customers', authenticateUser, async (req: any, res) => {
    try {
      // Transformar strings vazias em null para campos numéricos
      const cleanedData = {
        ...req.body,
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        lastSaleValue: req.body.lastSaleValue === '' ? null : req.body.lastSaleValue,
        route: req.body.route || '', // Default vazio para route (campo deprecated)
        serviceStartDate: req.body.serviceStartDate 
          ? (typeof req.body.serviceStartDate === 'string' ? new Date(req.body.serviceStartDate) : req.body.serviceStartDate)
          : undefined,
      };
      
      const data = insertCustomerSchema.parse(cleanedData);
      
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
      
      // Tentar cadastrar automaticamente no Omie (se tiver CPF/CNPJ)
      let omieMessage = '';
      if (customer.cpf || customer.cnpj) {
        try {
          const omieService = getOmieService(storage);
          if (omieService) {
            console.log(`📤 Tentando cadastrar cliente no Omie: ${customer.name}...`);
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
              console.log(`✅ Cliente ${customer.name} cadastrado no Omie com sucesso`);
            } else {
              omieMessage = ` ⚠️ Cliente criado no Integra, mas não foi possível cadastrar no Omie: ${omieResult.message}`;
              console.warn(`⚠️ Não foi possível cadastrar no Omie: ${omieResult.message}`);
            }
          }
        } catch (omieError: any) {
          console.error('Erro ao cadastrar cliente no Omie:', omieError);
          omieMessage = ` ⚠️ Cliente criado no Integra, mas houve erro ao cadastrar no Omie`;
        }
      }
      
      res.json({
        ...customer,
        _omieMessage: omieMessage // Mensagem informativa sobre o cadastro no Omie
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
      
      // Transformar strings vazias em null para campos numéricos
      const data = {
        ...req.body,
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        lastSaleValue: req.body.lastSaleValue === '' ? null : req.body.lastSaleValue,
        serviceStartDate: req.body.serviceStartDate 
          ? (typeof req.body.serviceStartDate === 'string' ? new Date(req.body.serviceStartDate) : req.body.serviceStartDate)
          : undefined,
      };
      
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
      
      const hasWeekdaysChanged = data.weekdays && 
        JSON.stringify([...(Array.isArray(data.weekdays) ? data.weekdays : [data.weekdays])].sort()) !== 
        JSON.stringify([...(Array.isArray(currentCustomer.weekdays) ? currentCustomer.weekdays : [currentCustomer.weekdays])].sort());
      
      const hasPeriodicityChanged = data.visitPeriodicity && data.visitPeriodicity !== currentCustomer.visitPeriodicity;
      const hasSellerChanged = data.sellerId && data.sellerId !== currentCustomer.sellerId;
      
      if (hasWeekdaysChanged || hasPeriodicityChanged || hasSellerChanged) {
        console.info('[CUSTOMER-UPDATE] Detectadas mudanças de recorrência', {
          customerId: id,
          hasWeekdaysChanged,
          hasPeriodicityChanged,
          hasSellerChanged
        });
        
        try {
          const parseWeekdays = (wd: any): string[] | undefined => {
            if (!wd) return undefined;
            if (Array.isArray(wd)) return wd;
            if (typeof wd === 'string') {
              try {
                const parsed = JSON.parse(wd);
                return Array.isArray(parsed) ? parsed : [wd];
              } catch {
                return [wd];
              }
            }
            return undefined;
          };

          const result = await applyCustomerRecurrenceChange(
            id,
            {
              weekdays: parseWeekdays(customer.weekdays),
              visitPeriodicity: customer.visitPeriodicity || undefined,
              sellerId: customer.sellerId || undefined
            },
            {
              sellerId: currentCustomer.sellerId || undefined,
              weekdays: parseWeekdays(currentCustomer.weekdays),
              visitPeriodicity: currentCustomer.visitPeriodicity || undefined
            }
          );
          
          if (result.success) {
            console.info('[CUSTOMER-UPDATE] Recorrência atualizada com sucesso', {
              customerId: id,
              previousNextVisitDate: result.previousNextVisitDate,
              newNextVisitDate: result.newNextVisitDate,
              invalidatedRoutes: result.invalidatedRoutes
            });
          } else {
            console.warn('[CUSTOMER-UPDATE] Falha ao atualizar recorrência', {
              customerId: id,
              message: result.message
            });
          }
        } catch (recurrenceError: any) {
          console.error('[CUSTOMER-UPDATE] Erro ao atualizar recorrência', {
            customerId: id,
            error: recurrenceError.message
          });
        }
      }

      // Sincronizar mudança de vendedor com Omie
      if (hasSellerChanged && customer.sellerId) {
        try {
          // Verificar se é cliente do Omie (id começa com "omie-client-")
          const isOmieClient = id.startsWith('omie-client-');
          // Verificar se é vendedor do Omie (sellerId começa com "omie-vendor-")
          const isOmieVendor = customer.sellerId.startsWith('omie-vendor-');
          
          if (isOmieClient && isOmieVendor) {
            // Extrair códigos numéricos do Omie
            const omieClientCode = parseInt(id.replace('omie-client-', ''));
            const omieVendorCode = parseInt(customer.sellerId.replace('omie-vendor-', ''));
            
            // Validar códigos numéricos
            if (isNaN(omieClientCode) || isNaN(omieVendorCode)) {
              console.error('[OMIE-SYNC] Códigos Omie inválidos', {
                customerId: id,
                omieClientCode,
                omieVendorCode
              });
            } else {
              const omieService = getOmieService(storage);
              if (!omieService) {
                console.warn('[OMIE-SYNC] Serviço Omie não está configurado');
              } else {
                console.info('[OMIE-SYNC] Sincronizando mudança de vendedor com Omie', {
                  customerId: id,
                  omieClientCode,
                  previousSellerId: currentCustomer.sellerId,
                  newSellerId: customer.sellerId,
                  omieVendorCode
                });
                
                const omieResult = await omieService.updateCustomerVendor(omieClientCode, omieVendorCode);
                
                if (omieResult.success) {
                  console.info('[OMIE-SYNC] Vendedor atualizado no Omie com sucesso', {
                    customerId: id,
                    omieClientCode,
                    omieVendorCode,
                    message: omieResult.message
                  });
                } else {
                  console.warn('[OMIE-SYNC] Falha ao atualizar vendedor no Omie', {
                    customerId: id,
                    message: omieResult.message
                  });
                }
              }
            }
          } else {
            if (!isOmieClient) {
              console.log('[OMIE-SYNC] Cliente não é do Omie, pulando sincronização de vendedor');
            }
            if (!isOmieVendor) {
              console.log('[OMIE-SYNC] Vendedor não é do Omie, pulando sincronização de vendedor');
            }
          }
        } catch (omieError: any) {
          console.error('[OMIE-SYNC] Erro ao sincronizar vendedor com Omie', {
            customerId: id,
            error: omieError.message
          });
          // Não bloquear a atualização do cliente em caso de erro no Omie
        }
      }
      
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
            // Normalizar e validar dias da semana
            const weekdayMap: Record<string, string> = {
              'segunda': 'segunda',
              'segunda-feira': 'segunda',
              'seg': 'segunda',
              'terça': 'terca',
              'terca': 'terca',
              'terça-feira': 'terca',
              'terca-feira': 'terca',
              'ter': 'terca',
              'quarta': 'quarta',
              'quarta-feira': 'quarta',
              'qua': 'quarta',
              'quinta': 'quinta',
              'quinta-feira': 'quinta',
              'qui': 'quinta',
              'sexta': 'sexta',
              'sexta-feira': 'sexta',
              'sex': 'sexta',
              'sábado': 'sabado',
              'sabado': 'sabado',
              'sáb': 'sabado',
              'sab': 'sabado',
              'domingo': 'domingo',
              'dom': 'domingo'
            };
            
            const inputDays = weekdaysRaw.split(/[,;\/]/).map(d => d.trim()).filter(d => d);
            const normalizedDays = inputDays
              .map(day => weekdayMap[day])
              .filter(day => day !== undefined);
            
            if (normalizedDays.length === 0 && inputDays.length > 0) {
              results.errors.push(`Linha ${i + 2}: Nenhum dia da semana válido encontrado em '${weekdaysRaw}'`);
            } else if (normalizedDays.length > 2) {
              results.errors.push(`Linha ${i + 2}: Máximo de 2 dias da semana permitido. Encontrados ${normalizedDays.length} dias.`);
            } else if (normalizedDays.length > 0) {
              // Remover duplicatas e salvar como JSON array
              const uniqueDays = Array.from(new Set(normalizedDays));
              updateData.weekdays = JSON.stringify(uniqueDays);
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
      
      const data = insertProductSchema.partial().parse(req.body);
      const product = await storage.updateProduct(id, data);
      res.json(product);
    } catch (error) {
      console.error("Error updating product:", error);
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

  // ============================================================================
  // LEADS MANAGEMENT ROUTES
  // ============================================================================
  
  // GET all leads with filters (name, date, seller, status)
  app.get('/api/leads', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, scheduledDate, status } = req.query;
      
      // Controle de acesso: vendedores veem apenas seus leads
      let targetSellerId: string | undefined;
      if (user.role === 'vendedor') {
        targetSellerId = user.id; // Vendedor vê apenas seus leads
      } else if (['admin', 'coordinator', 'administrative'].includes(user.role)) {
        targetSellerId = sellerId; // Admin/coordinator pode filtrar por vendedor
      } else {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const filters: any = {};
      if (targetSellerId) filters.sellerId = targetSellerId;
      if (scheduledDate) filters.scheduledDate = new Date(scheduledDate as string);
      if (status) filters.status = status as string;
      
      const leads = await storage.getLeads(filters);
      res.json(leads);
    } catch (error) {
      console.error("Error fetching leads:", error);
      res.status(500).json({ message: "Failed to fetch leads" });
    }
  });
  
  // GET single lead
  app.get('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      const lead = await storage.getLead(id);
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Controle de acesso: vendedores só podem ver seus próprios leads
      if (user.role === 'vendedor' && lead.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(lead);
    } catch (error) {
      console.error("Error fetching lead:", error);
      res.status(500).json({ message: "Failed to fetch lead" });
    }
  });
  
  // CREATE new lead
  app.post('/api/leads', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      
      // Apenas admin, coordinator, administrative e vendedor podem criar leads
      if (!['admin', 'coordinator', 'administrative', 'vendedor'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Processar scheduledDate para timezone Brasil
      const cleanedData = {
        ...req.body,
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        scheduledDate: req.body.scheduledDate 
          ? fromZonedTime(`${req.body.scheduledDate}T00:00:00`, 'America/Sao_Paulo')
          : null,
      };
      
      const data = insertLeadSchema.parse(cleanedData);
      
      // Vendedores só podem criar leads para si mesmos
      if (user.role === 'vendedor' && data.sellerId !== user.id) {
        return res.status(403).json({ message: "Vendedores só podem criar leads para si mesmos" });
      }
      
      const lead = await storage.createLead(data);
      res.status(201).json(lead);
    } catch (error) {
      console.error("Error creating lead:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create lead" });
    }
  });
  
  // UPDATE lead
  app.put('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      const existingLead = await storage.getLead(id);
      if (!existingLead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Controle de acesso: vendedores só podem editar seus próprios leads
      if (user.role === 'vendedor' && existingLead.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Processar scheduledDate para timezone Brasil
      const cleanedData = {
        ...req.body,
        latitude: req.body.latitude === '' ? null : req.body.latitude,
        longitude: req.body.longitude === '' ? null : req.body.longitude,
        scheduledDate: req.body.scheduledDate 
          ? fromZonedTime(`${req.body.scheduledDate}T00:00:00`, 'America/Sao_Paulo')
          : undefined,
      };
      
      const lead = await storage.updateLead(id, cleanedData);
      res.json(lead);
    } catch (error) {
      console.error("Error updating lead:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update lead" });
    }
  });
  
  // DELETE lead (soft delete)
  app.delete('/api/leads/:id', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      const existingLead = await storage.getLead(id);
      if (!existingLead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Apenas admin/coordinator podem deletar leads
      if (!['admin', 'coordinator'].includes(user.role)) {
        return res.status(403).json({ message: "Apenas administradores podem deletar leads" });
      }
      
      await storage.deleteLead(id);
      res.json({ message: "Lead deleted successfully" });
    } catch (error) {
      console.error("Error deleting lead:", error);
      res.status(500).json({ message: "Failed to delete lead" });
    }
  });
  
  // DISCARD lead with reason
  app.post('/api/leads/:id/discard', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      const { reason } = req.body;
      
      if (!reason) {
        return res.status(400).json({ message: "Motivo de descarte é obrigatório" });
      }
      
      const existingLead = await storage.getLead(id);
      if (!existingLead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Controle de acesso: vendedores podem descartar seus próprios leads
      if (user.role === 'vendedor' && existingLead.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const lead = await storage.discardLead(id, reason);
      res.json(lead);
    } catch (error) {
      console.error("Error discarding lead:", error);
      res.status(500).json({ message: "Failed to discard lead" });
    }
  });
  
  // CONVERT lead to customer (transactional)
  app.post('/api/leads/:id/convert', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      const customerData = req.body;
      
      const existingLead = await storage.getLead(id);
      if (!existingLead) {
        return res.status(404).json({ message: "Lead not found" });
      }
      
      // Controle de acesso
      if (user.role === 'vendedor' && existingLead.sellerId !== user.id) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      if (existingLead.status === 'converted') {
        return res.status(400).json({ message: "Lead já foi convertido" });
      }
      
      // Pré-processar dados do cliente
      const cleanedCustomerData = {
        ...customerData,
        latitude: existingLead.latitude,
        longitude: existingLead.longitude,
        sellerId: existingLead.sellerId,
        fantasyName: customerData.fantasyName || existingLead.fantasyName,
        phone: customerData.phone || existingLead.phone,
      };
      
      const validatedData = insertCustomerSchema.parse(cleanedCustomerData);
      
      // TRANSAÇÃO ATÔMICA: Criar cliente + Atualizar lead + Criar permanent card
      const customer = await storage.createCustomer(validatedData);
      
      // Criar permanent card para o novo cliente
      await storage.getOrCreatePermanentCard(customer.id, customer.sellerId);
      
      // Marcar lead como convertido
      const updatedLead = await storage.convertLeadToCustomer(id, customer.id);
      
      res.status(201).json({
        message: "Lead convertido com sucesso",
        customer,
        lead: updatedLead
      });
    } catch (error) {
      console.error("Error converting lead:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Dados inválidos", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to convert lead" });
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
      
      // Buscar TODOS os pedidos (sem filtro de sellerId)
      const allCards = await storage.getSalesCards();
      console.log('📊 [HOTSITE-ORDERS] Total de sales_cards:', allCards.length);
      
      // Filtrar apenas pedidos do hotsite
      const hotsiteOrders = allCards.filter(card => card.source === 'hotsite');
      console.log('📊 [HOTSITE-ORDERS] Sales_cards com source="hotsite":', hotsiteOrders.length);
      
      // Ordenar por data
      hotsiteOrders.sort((a, b) => {
        const dateA = new Date(a.scheduledDate).getTime();
        const dateB = new Date(b.scheduledDate).getTime();
        return dateB - dateA; // Mais recentes primeiro
      });
      
      console.log('✅ [HOTSITE-ORDERS] Retornando', hotsiteOrders.length, 'pedidos');
      
      res.json({ orders: hotsiteOrders });
    } catch (error) {
      console.error("❌ [HOTSITE-ORDERS] Error fetching hotsite orders:", error);
      res.status(500).json({ message: "Failed to fetch hotsite orders" });
    }
  });

  // Enviar pedido do hotsite para o Omie (Nov 2025)
  app.post('/api/hotsite-orders/:id/send-to-omie', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { id } = req.params;
      
      // Apenas admin, coordinator e administrative podem enviar
      if (!['admin', 'coordinator', 'administrative'].includes(user.role)) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      console.log(`📤 [SEND-TO-OMIE] Sending order ${id} to Omie`);
      
      // Buscar pedido
      const order = await storage.getSalesCardById(id);
      if (!order) {
        return res.status(404).json({ message: "Pedido não encontrado" });
      }
      
      // Verificar se já foi enviado ou está aguardando
      if (order.omieSyncStatus === 'enviado_omie') {
        return res.status(400).json({ message: "Pedido já foi enviado ao Omie" });
      }
      if (order.omieSyncStatus === 'aguardando_omie') {
        return res.status(400).json({ message: "Pedido já está sendo processado" });
      }
      
      // TODO: Implementar integração com Omie (Task 4 pendente)
      // Por enquanto, retorna resposta mock para testar fluxo
      console.log(`⚠️ [SEND-TO-OMIE] STUB: Simulando envio bem-sucedido (integração real pendente)`);
      
      res.json({ 
        success: true,
        omieOrderNumber: `STUB-${Date.now()}`,
        message: 'DEMO: Pedido marcado para envio (integração com Omie em desenvolvimento)'
      });
      
    } catch (error) {
      console.error("❌ [SEND-TO-OMIE] Error:", error);
      res.status(500).json({ message: "Failed to send order to Omie" });
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
      
      // Validar que o sellerId existe no banco de dados e é um vendedor
      if (sellerId) {
        const seller = await storage.getUserById(sellerId);
        if (!seller) {
          return res.status(400).json({ 
            message: "Vendedor não encontrado. Por favor, selecione um vendedor válido." 
          });
        }
        // Verificar se o usuário selecionado é realmente um vendedor
        if (seller.role !== 'vendedor') {
          return res.status(400).json({ 
            message: "O usuário selecionado não é um vendedor. Por favor, selecione um vendedor válido." 
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
      const sellerId = req.sellerId;
      
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
          const systemClient = {
            ...converted,
            // Usar sellerId do Omie se disponível, senão usar sellerId da planilha
            sellerId: converted.sellerId || sellerId || '',
            weekdays: "segunda,terça,quarta,quinta,sexta" // Padrão
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
              
              const systemClient = {
                ...converted,
                sellerId: finalSellerId,
                weekdays: "segunda,terça,quarta,quinta,sexta"
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
          visitStatus: 'completed'
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
          clients: null,
          billings: null,
          overdueDebts: null,
          errors: [],
          startTime: new Date(),
          endTime: null
        };

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
        clientes: results.clients,
        faturamentos: results.billings,
        debitos: results.overdueDebts,
        erros: results.errors.length
      });

      // Registrar timestamp da sincronização completa
      try {
        const totalRecords = (results.clients?.totalProcessed || 0) + 
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
      console.log(`[${timestamp}] Fetching ALL contas receber from Omie...`);
      const contasData = await omieService.getAllContasReceber();
      console.log(`[${timestamp}] Contas receber fetch complete - returning ${contasData.totalTitulos} títulos`);
      res.json(contasData);

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

  // ===== DELIVERY DRIVERS APIS =====
  
  // Buscar todos os motoristas
  app.get("/api/delivery-drivers", async (req, res) => {
    try {
      const drivers = await storage.getDeliveryDrivers();
      res.json(drivers);
    } catch (error) {
      console.error("Error fetching delivery drivers:", error);
      res.status(500).json({ message: "Failed to fetch delivery drivers" });
    }
  });

  // Buscar motoristas ativos
  app.get("/api/delivery-drivers/active", async (req, res) => {
    try {
      const activeDrivers = await storage.getActiveDeliveryDrivers();
      res.json(activeDrivers);
    } catch (error) {
      console.error("Error fetching active delivery drivers:", error);
      res.status(500).json({ message: "Failed to fetch active delivery drivers" });
    }
  });

  // Criar motorista
  app.post("/api/delivery-drivers", async (req, res) => {
    try {
      const driverData = req.body;
      const driver = await storage.createDeliveryDriver(driverData);
      res.json(driver);
    } catch (error) {
      console.error("Error creating delivery driver:", error);
      res.status(500).json({ message: "Failed to create delivery driver" });
    }
  });

  // Atualizar motorista
  app.put("/api/delivery-drivers/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const driverData = req.body;
      const driver = await storage.updateDeliveryDriver(id, driverData);
      res.json(driver);
    } catch (error) {
      console.error("Error updating delivery driver:", error);
      res.status(500).json({ message: "Failed to update delivery driver" });
    }
  });

  // Alternar status do motorista
  app.put("/api/delivery-drivers/:id/toggle-status", async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      const driver = await storage.updateDeliveryDriver(id, { isActive });
      res.json(driver);
    } catch (error) {
      console.error("Error toggling driver status:", error);
      res.status(500).json({ message: "Failed to toggle driver status" });
    }
  });

  // Estatísticas de motoristas
  app.get("/api/delivery-drivers/stats", async (req, res) => {
    try {
      const stats = await storage.getDeliveryDriverStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching driver stats:", error);
      res.status(500).json({ message: "Failed to fetch driver stats" });
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

  // Buscar motoristas ativos
  app.get("/api/delivery-drivers", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const drivers = await storage.getActiveDeliveryDrivers();
      res.json(drivers);
    } catch (error: any) {
      console.error("Error fetching delivery drivers:", error);
      res.status(500).json({ message: "Failed to fetch delivery drivers", error: error.message });
    }
  });

  // Buscar pedidos aguardando rota (para gestão de entregas)
  app.get("/api/deliveries", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { status = 'aguardando-rota' } = req.query;
      
      // Buscar notas fiscais (billings) com etapa "Aguardando Rota"
      const deliveries = await db.select({
        id: billingsTable.id,
        invoiceNumber: billingsTable.invoiceNumber,
        omieOrderId: billingsTable.omieOrderId,
        orderNumber: billingsTable.orderNumber,
        // Customer data with fallback to billing data
        customerId: sql<string>`COALESCE(${customers.id}, 'billing-' || ${billingsTable.id})`,
        customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name}, ${billingsTable.customerFantasyName})`,
        customerAddress: sql<string>`COALESCE(${customers.address}, '')`,
        customerLatitude: sql<number>`COALESCE(${customers.latitude}, 0)`,
        customerLongitude: sql<number>`COALESCE(${customers.longitude}, 0)`,
        averageDeliveryTime: sql<number>`COALESCE(${customers.averageDeliveryTime}, 30)`,
        exclusiveVehicle: sql<boolean>`false`,
        vehicleTypes: sql<string[]>`ARRAY[]::text[]`,
        isUrgent: sql<boolean>`false`,
        saleValue: billingsTable.totalValue,
        products: billingsTable.products,
        scheduledDate: billingsTable.invoiceDate,
        completedDate: billingsTable.invoiceDate,
        paymentMethod: billingsTable.paymentMethod,
        operationType: billingsTable.billingType,
      })
      .from(billingsTable)
      .leftJoin(customers, 
        sql`(
          ${customers.id} = CONCAT('omie-client-', ${billingsTable.omieCustomerCode})
          OR REGEXP_REPLACE(${customers.cpf}, '[^0-9]', '', 'g') = REGEXP_REPLACE(${billingsTable.customerDocument}, '[^0-9]', '', 'g')
          OR REGEXP_REPLACE(${customers.cnpj}, '[^0-9]', '', 'g') = REGEXP_REPLACE(${billingsTable.customerDocument}, '[^0-9]', '', 'g')
        )`
      )
      .where(
        and(
          eq(billingsTable.invoiceStage, 'Aguardando Rota'),
          // Apenas notas com dados de invoice
          sql`${billingsTable.invoiceNumber} IS NOT NULL`,
          sql`${billingsTable.invoiceDate} IS NOT NULL`,
          // Notas que ainda não têm rota de entrega (usando invoice_number para buscar)
          sql`NOT EXISTS (
            SELECT 1 FROM delivery_route_stops drs
            JOIN billings b ON b.id = drs.sales_card_id
            WHERE b.invoice_number = ${billingsTable.invoiceNumber}
          )`
        )
      )
      .orderBy(billingsTable.invoiceDate);
      
      res.json(deliveries);
    } catch (error: any) {
      console.error("Error fetching deliveries:", error);
      res.status(500).json({ message: "Failed to fetch deliveries", error: error.message });
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

      // Buscar pedidos completos
      const orders = await db.select({
        id: salesCards.id,
        customerId: salesCards.customerId,
        customerName: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
        customerAddress: customers.address,
        customerLatitude: customers.latitude,
        customerLongitude: customers.longitude,
        averageDeliveryTime: customers.averageDeliveryTime,
        exclusiveVehicle: salesCards.exclusiveVehicle,
        vehicleTypes: salesCards.vehicleTypes,
        isUrgent: salesCards.isUrgent,
        saleValue: salesCards.saleValue,
        products: salesCards.products,
        scheduledDate: salesCards.scheduledDate,
        completedDate: salesCards.completedDate,
        paymentMethod: salesCards.paymentMethod,
        operationType: salesCards.operationType,
      })
      .from(salesCards)
      .innerJoin(customers, eq(salesCards.customerId, customers.id))
      .where(inArray(salesCards.id, orderIds));

      // Validar que todos os pedidos têm coordenadas
      const invalidOrders = orders.filter(o => !o.customerLatitude || !o.customerLongitude);
      if (invalidOrders.length > 0) {
        return res.status(400).json({ 
          message: "Some orders don't have customer coordinates",
          invalidOrders: invalidOrders.map(o => ({ id: o.id, name: o.customerName }))
        });
      }

      // Converter para formato do serviço
      const deliveryOrders = orders.map(o => ({
        id: o.id,
        customerId: o.customerId,
        customerName: o.customerName,
        customerAddress: o.customerAddress,
        customerLatitude: parseFloat(o.customerLatitude as string),
        customerLongitude: parseFloat(o.customerLongitude as string),
        averageDeliveryTime: o.averageDeliveryTime || 10,
        exclusiveVehicle: o.exclusiveVehicle || false,
        vehicleTypes: o.vehicleTypes || [],
        isUrgent: o.isUrgent || false,
        saleValue: o.saleValue || 0,
        products: o.products,
        scheduledDate: o.scheduledDate,
        completedDate: o.completedDate,
        paymentMethod: o.paymentMethod,
        operationType: o.operationType,
      }));

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

  // Buscar rotas de entrega
  app.get("/api/delivery-routes", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      const { status, routeDate } = req.query;
      
      const filters: any = {};
      if (status) filters.status = status;
      if (routeDate) filters.routeDate = new Date(routeDate);
      
      const routes = await storage.getDeliveryRoutes(filters);
      res.json(routes);
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
        const clienteComDebito = await storage.getOverdueDebtByDocument(clientDocument);

        if (clienteComDebito) {
          console.log(`⚠️ BLOQUEANDO PEDIDO: Cliente ${clienteComDebito.clientName} com débito vencido`);
          
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
          
          return res.status(403).json({ 
            blocked: true,
            message: `Pedido bloqueado: Cliente possui débito vencido de R$ ${parseFloat(clienteComDebito.totalAmount).toFixed(2)} com ${clienteComDebito.maxDaysOverdue} dias de atraso. Regularize a situação financeira antes de realizar novas vendas.`,
            blockReason: 'overdue_debt',
            debtAmount: parseFloat(clienteComDebito.totalAmount),
            daysOverdue: clienteComDebito.maxDaysOverdue
          });
        }
      } catch (error) {
        console.error('Erro ao verificar débitos vencidos:', error);
        // Continua o fluxo mesmo se houver erro na consulta de débitos
      }
      
      // VERIFICAR BLOQUEIO POR PRAZO DE BOLETO
      const paymentMethod = card.paymentMethod || 'a_vista';
      const boletoDays = card.boletoDays || 7;
      
      if (paymentMethod === 'boleto' && boletoDays > 7) {
        console.log(`⚠️ BLOQUEANDO PEDIDO: Boleto com prazo de ${boletoDays} dias (limite: 7 dias)`);
        
        // Criar registro de pedido bloqueado
        const blockedOrderData = {
          salesCardId: card.id,
          customerId: card.customerId,
          sellerId: card.sellerId,
          blockReason: 'payment_term',
          blockDetails: `Boleto com prazo de ${boletoDays} dias excede o limite de 7 dias permitido. Aguardando aprovação administrativa.`,
          operationType: card.operationType || 'venda',
          paymentMethod: paymentMethod,
          boletoDays: boletoDays,
          totalAmount: parseFloat(card.saleValue),
          products: card.products || []
        };
        
        await db.insert(blockedOrders).values(blockedOrderData);
        
        return res.status(403).json({ 
          blocked: true,
          message: `Pedido bloqueado: Boleto com prazo de ${boletoDays} dias excede o limite de 7 dias. O pedido foi enviado para aprovação administrativa.`,
          blockReason: 'payment_term',
          boletoDays: boletoDays
        });
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
          COALESCE(c.fantasy_name, c.name) as cliente,
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
          COALESCE(c.fantasy_name, c.name) as cliente,
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
        saveForReuse
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
      };

      const salesCard = await storage.updateSalesCard(id, updateData);

      // Se coordenadas GPS foram capturadas durante a venda, atualizar o cliente
      if (req.body.customerLatitude && req.body.customerLongitude) {
        try {
          const card = await storage.getSalesCard(id);
          if (card) {
            await storage.updateCustomer(card.customerId, {
              latitude: req.body.customerLatitude,
              longitude: req.body.customerLongitude
            });
          }
        } catch (coordError) {
          console.error('Erro ao atualizar coordenadas do cliente após venda:', coordError);
          // Não falhar a finalização da venda se a atualização de coordenadas falhar
        }
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

  // ========================================
  // ROTAS DE ROTEIRIZAÇÃO DIÁRIA
  // ========================================
  
  // Importar serviço de otimização de rotas
  const { generateDailyRoute, registerCheckpoint } = await import('./routeOptimizationService');

  // Gerar rota otimizada do dia para um vendedor
  app.post('/api/daily-routes/generate', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.body;
      
      // Vendedor só pode gerar sua própria rota
      const targetSellerId = user.role === 'vendedor' ? user.id : (sellerId || user.id);
      
      if (!date) {
        return res.status(400).json({ message: 'Data é obrigatória' });
      }

      // Converter data string para timezone do Brasil (America/Sao_Paulo)
      // IMPORTANTE: new Date('2025-11-10') interpreta como UTC midnight, que em BRT é 21h do dia anterior!
      // Usar fromZonedTime garante que 2025-11-10 seja interpretado como 2025-11-10 00:00 BRT
      const routeDate = fromZonedTime(`${date}T00:00:00`, 'America/Sao_Paulo');
      
      // Verificar se já existe rota para este dia
      const existingRoute = await storage.getDailyRouteBySellerAndDate(targetSellerId, routeDate);
      
      if (existingRoute) {
        // Regenerar rota atualizando os dados (preserva checkpoints, status, e visitas em andamento)
        console.log(`🔄 Regenerando rota existente: ${existingRoute.id}`);
        
        // Buscar checkpoints existentes para identificar visitas já iniciadas
        const existingCheckpoints = await storage.getRouteCheckpoints(existingRoute.id);
        
        // Separar em 3 grupos:
        // 1. Completadas (com checkout)
        // 2. In Progress (com checkin mas sem checkout)
        // 3. Pendentes (sem checkin)
        const completedCheckpoints = existingCheckpoints.filter((cp: any) => cp.actualCheckOut);
        const inProgressCheckpoints = existingCheckpoints.filter((cp: any) => cp.actualCheckIn && !cp.actualCheckOut);
        
        const completedCardIds = completedCheckpoints.map((cp: any) => cp.salesCardId);
        const inProgressCardIds = inProgressCheckpoints.map((cp: any) => cp.salesCardId);
        const allProcessedCardIds = new Set([...completedCardIds, ...inProgressCardIds]);
        
        console.log(`📍 Visitas completadas: ${completedCardIds.length}, Em andamento: ${inProgressCardIds.length}`);
        
        // Buscar informações do vendedor
        const seller = await storage.getUserById(targetSellerId);
        
        if (!seller) {
          return res.status(404).json({ message: 'Vendedor não encontrado' });
        }

        if (!seller.homeLatitude || !seller.homeLongitude) {
          return res.status(400).json({ message: 'Vendedor não possui coordenadas de residência cadastradas' });
        }

        // Buscar sales cards do dia
        const startOfDay = new Date(routeDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(routeDate);
        endOfDay.setHours(23, 59, 59, 999);

        const salesCards = await storage.getSalesCardsByDate(startOfDay, targetSellerId);
        
        // Filtrar apenas cards que NÃO foram processados (nem completados nem in_progress)
        const trulyPendingCards = salesCards.filter((c: any) => 
          c.status === 'pending' && !allProcessedCardIds.has(c.id)
        );

        // Converter para formato de visitas com dados do cliente
        const visits: any[] = [];
        for (const card of trulyPendingCards) {
          const customer = await storage.getCustomer(card.customerId);
          if (customer) {
            visits.push({
              id: card.id,
              customerId: customer.id,
              customerName: customer.fantasyName || customer.name,
              customerLatitude: customer.latitude,
              customerLongitude: customer.longitude,
              customerAddress: customer.address,
              isVirtual: customer.virtualService || false,
              scheduledDate: card.scheduledDate
            });
          }
        }

        // Filtrar apenas visitas presenciais com coordenadas válidas
        const validVisits = visits.filter(v => 
          !v.isVirtual &&
          v.customerLatitude && 
          v.customerLongitude &&
          !isNaN(parseFloat(v.customerLatitude as any)) &&
          !isNaN(parseFloat(v.customerLongitude as any))
        );

        // Se não houver novas visitas pendentes, manter ordem atual
        if (validVisits.length === 0) {
          console.log('⚠️ Nenhuma nova visita pendente, mantendo ordem atual');
          return res.json({
            routeId: existingRoute.id,
            message: 'Nenhuma visita pendente nova encontrada',
            totalVisits: existingRoute.totalVisits || 0,  // CORRIGIDO: Usar totalVisits do banco
            completedVisits: completedCardIds.length,
            regenerated: true
          });
        }

        // Otimizar APENAS as visitas realmente pendentes (não processadas)
        const { optimizeRoute } = await import('./routeOptimizationService');
        const routePoints = validVisits.map(v => ({
          id: v.customerId, // CORRIGIDO: Usar customerId ao invés de card.id
          latitude: parseFloat(v.customerLatitude as any),
          longitude: parseFloat(v.customerLongitude as any),
          customerName: v.customerName,
          customerAddress: v.customerAddress || ''
        }));

        const optimizedRoute = await optimizeRoute(
          parseFloat(seller.homeLatitude as any),
          parseFloat(seller.homeLongitude as any),
          routePoints
        );

        // CORRIGIDO: Buscar customerIds dos cards completados e em andamento
        // E VALIDAR se ainda deveriam estar na rota (baseado em nextVisitDate)
        const completedCustomerIds: string[] = [];
        for (const cp of completedCheckpoints) {
          const card = await storage.getSalesCard(cp.salesCardId);
          if (card?.customerId) {
            // Verificar se o cliente ainda deveria estar na rota deste dia
            const customer = await storage.getCustomer(card.customerId);
            if (customer && customer.isActive) {
              // Buscar permanent card do cliente
              const permanentCard = await db.select()
                .from(salesCards)
                .where(and(
                  eq(salesCards.customerId, customer.id),
                  eq(salesCards.isPermanent, true)
                ))
                .limit(1);
              
              if (permanentCard.length > 0) {
                const nextVisitDate = permanentCard[0].nextVisitDate;
                if (nextVisitDate) {
                  // Comparar datas (ignora hora)
                  const visitDateStr = new Date(nextVisitDate).toISOString().split('T')[0];
                  const routeDateStr = routeDate.toISOString().split('T')[0];
                  
                  if (visitDateStr === routeDateStr) {
                    // Cliente ainda deveria estar nesta rota
                    completedCustomerIds.push(card.customerId);
                  } else {
                    console.log(`⚠️ Cliente ${customer.fantasyName || customer.name} completado mas nextVisitDate mudou: ${visitDateStr} ≠ ${routeDateStr}`);
                  }
                } else {
                  // Se não tem nextVisitDate, manter para não perder dados
                  completedCustomerIds.push(card.customerId);
                }
              } else {
                // Se não tem permanent card, manter
                completedCustomerIds.push(card.customerId);
              }
            }
          }
        }
        
        const inProgressCustomerIds: string[] = [];
        for (const cp of inProgressCheckpoints) {
          const card = await storage.getSalesCard(cp.salesCardId);
          if (card?.customerId) {
            // Verificar se o cliente ainda deveria estar na rota deste dia
            const customer = await storage.getCustomer(card.customerId);
            if (customer && customer.isActive) {
              // Buscar permanent card do cliente
              const permanentCard = await db.select()
                .from(salesCards)
                .where(and(
                  eq(salesCards.customerId, customer.id),
                  eq(salesCards.isPermanent, true)
                ))
                .limit(1);
              
              if (permanentCard.length > 0) {
                const nextVisitDate = permanentCard[0].nextVisitDate;
                if (nextVisitDate) {
                  // Comparar datas (ignora hora)
                  const visitDateStr = new Date(nextVisitDate).toISOString().split('T')[0];
                  const routeDateStr = routeDate.toISOString().split('T')[0];
                  
                  if (visitDateStr === routeDateStr) {
                    // Cliente ainda deveria estar nesta rota
                    inProgressCustomerIds.push(card.customerId);
                  } else {
                    console.log(`⚠️ Cliente ${customer.fantasyName || customer.name} em andamento mas nextVisitDate mudou: ${visitDateStr} ≠ ${routeDateStr}`);
                  }
                } else {
                  // Se não tem nextVisitDate, manter para não perder dados
                  inProgressCustomerIds.push(card.customerId);
                }
              } else {
                // Se não tem permanent card, manter
                inProgressCustomerIds.push(card.customerId);
              }
            }
          }
        }

        // Construir ordem final preservando APENAS visitas que ainda deveriam estar neste dia
        const finalOrder = [
          ...completedCustomerIds,        // 1. Visitas completadas E que ainda deveriam estar aqui
          ...inProgressCustomerIds,       // 2. Visitas em andamento E que ainda deveriam estar aqui
          ...optimizedRoute.orderedPoints.map(p => p.id) // 3. Novas pendentes
        ];

        const totalVisits = finalOrder.length;
        const completedVisits = completedCardIds.length;

        console.log(`✅ Rota atualizada: ${completedVisits} completadas + ${inProgressCardIds.length} em andamento + ${optimizedRoute.orderedPoints.length} pendentes = ${totalVisits} total`);
        console.log(`📊 Retornando para frontend: totalVisits=${totalVisits}, completedVisits=${completedVisits}`);

        // Atualizar rota existente (PRESERVA routeStatus e checkpoints)
        const updatedRoute = await storage.updateDailyRoute(existingRoute.id, {
          optimizedOrder: finalOrder,
          totalEstimatedDistance: optimizedRoute.totalDistance.toString(),
          totalVisits,
          completedVisits,
          // PRESERVA o status atual (in_progress, paused, etc)
          routeStatus: existingRoute.routeStatus
        });

        return res.json({
          success: true,
          regenerated: true,
          routeId: updatedRoute.id,
          totalVisits,
          completedVisits,
          inProgressVisits: inProgressCardIds.length,
          totalEstimatedDistance: optimizedRoute.totalDistance
        });
      }

      // Gerar nova rota
      const result = await generateDailyRoute(storage, targetSellerId, routeDate);
      
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
            isVirtual: customers.virtualService
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
          progress: {
            totalVisits,
            completedVisits,
            // Converter de km para metros (banco salva em km, frontend espera metros)
            totalEstimatedDistance: Math.round(parseFloat(route.totalEstimatedDistance || '0') * 1000),
            totalActualDistance: Math.round(parseFloat(route.totalActualDistance || '0') * 1000),
            percentComplete
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

  // Buscar rota de uma data específica para um vendedor
  app.get('/api/daily-routes/:sellerId/date/:date', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const { sellerId, date } = req.params;
      
      console.log(`📡 [API REQUEST] GET /api/daily-routes/${sellerId}/date/${date}`);
      
      // Vendedor só pode ver sua própria rota
      if (user.role === 'vendedor' && sellerId !== user.id) {
        return res.status(403).json({ message: 'Acesso negado' });
      }

      const routeDate = new Date(date);
      routeDate.setHours(0, 0, 0, 0);
      
      const route = await storage.getDailyRouteBySellerAndDate(sellerId, routeDate);
      
      console.log(`📊 [ROUTE DATA] totalVisits do banco: ${route?.totalVisits}, optimizedOrder.length: ${route?.optimizedOrder?.length}`);
      
      if (!route) {
        return res.json({
          message: 'Nenhuma rota encontrada para esta data. Gere uma rota primeiro.',
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
            isVirtual: customers.virtualService
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
          progress: {
            totalVisits,
            completedVisits,
            // Converter de km para metros (banco salva em km, frontend espera metros)
            totalEstimatedDistance: Math.round(parseFloat(route.totalEstimatedDistance || '0') * 1000),
            totalActualDistance: Math.round(parseFloat(route.totalActualDistance || '0') * 1000),
            percentComplete
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

      // Buscar detalhes das visitas (DIRETO de customers - fonte única)
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
            scheduledDate: sql<Date>`${route.routeDate}::timestamp`,
            isVirtual: customers.virtualService
          })
            .from(customers)
            .where(eq(customers.id, customerId))
            .limit(1);
          
          return customer;
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

      // Buscar visitas da rota com coordenadas (DIRETO de customers - fonte única)
      const visitsData = await Promise.all(
        (route.optimizedOrder || []).map(async (customerId: string) => {
          // optimizedOrder agora contém IDs de clientes, não de sales_cards
          const [customer] = await db
            .select({
              id: customers.id,
              customerId: customers.id,
              customerName: customers.fantasyName,
              customerAddress: customers.address,
              latitude: customers.latitude,
              longitude: customers.longitude
            })
            .from(customers)
            .where(eq(customers.id, customerId))
            .limit(1);

          return customer;
        })
      );

      // Filtrar apenas visitas com coordenadas válidas (aceitar string ou number)
      const validVisits = visitsData
        .filter((v): v is NonNullable<typeof v> => {
          if (!v || v === null || v === undefined) return false;
          if (v.latitude === null || v.longitude === null) return false;
          
          // Converter para número se for string
          const lat = typeof v.latitude === 'string' ? parseFloat(v.latitude) : v.latitude;
          const lon = typeof v.longitude === 'string' ? parseFloat(v.longitude) : v.longitude;
          
          // Validar se são números válidos
          return !isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0;
        });

      console.log(`📊 Debug re-otimização - Total visitas na rota: ${route.optimizedOrder?.length || 0}, Visitas encontradas: ${visitsData.filter(v => v).length}, Válidas: ${validVisits.length}`);

      if (validVisits.length === 0) {
        console.error(`❌ Nenhuma visita válida encontrada para rota ${routeId}. Visitas: ${JSON.stringify(visitsData.map(v => v ? { id: v.id, lat: v.latitude, lon: v.longitude } : null))}`);
        return res.status(400).json({ message: 'Nenhuma visita com coordenadas válidas encontrada' });
      }

      // Preparar pontos para otimização (converter coordenadas para número)
      const points = validVisits.map(visit => ({
        id: visit.id,
        latitude: typeof visit.latitude === 'string' ? parseFloat(visit.latitude) : visit.latitude,
        longitude: typeof visit.longitude === 'string' ? parseFloat(visit.longitude) : visit.longitude,
        customerName: visit.customerName || 'Cliente',
        customerAddress: visit.customerAddress || ''
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
      
      // Remover visita do optimizedOrder (com tratamento para rotas antigas sem optimizedOrder)
      const currentOrder = (route.optimizedOrder as string[]) || [];
      const newOrder = currentOrder.filter((id: string) => id !== visitId);
      
      if (currentOrder.length === newOrder.length) {
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
        paymentMethod: z.enum(['pix', 'boleto']).default('pix'),
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
      
      // Aplicar desconto de 10% se subtotal >= R$ 200
      const hasDiscount = serverSubtotal >= 200;
      const discount = hasDiscount ? serverSubtotal * 0.1 : 0;
      const serverTotal = serverSubtotal - discount;
      
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
        
        // Atualizar informações se necessário
        await storage.updateCustomer(customerId, {
          address: validatedData.customer.address,
          name: validatedData.customer.name
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
        products: validatedData.items,
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

  const httpServer = createServer(app);
  return httpServer;
}
