import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { validateLocalAdmin, createLocalSession, validateUser, setUserPassword, initializeDefaultAdmin } from "./localAuth";
import { authenticateUser, requireRole, checkSellerAccess } from "./authMiddleware";
import { getOmieService, isOmieConfigured } from "./omieIntegration";
import { generateVisitAgenda } from "./visitScheduleService";
import { optimizeRouteAdvanced, type RouteLocation } from "../shared/routeOptimization.js";
import { receitaService } from "./receitaIntegration";
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
} from "@shared/schema";
import { z } from "zod";
import { sql, eq, and, gte, lte, isNotNull, inArray } from "drizzle-orm";
import { db } from "./db";
import multer from 'multer';
import * as XLSX from 'xlsx';
import bcrypt from 'bcrypt';

// Configurar multer para upload de arquivos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Endpoint público para inicializar admin padrão (útil para primeira configuração)
  app.post('/api/setup-admin', async (req, res) => {
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
      
      // If not found by ID but we have an email, try to find by email
      if (!user && userEmail) {
        user = await storage.getUserByEmail(userEmail);
        
        // If found by email but with different ID, this means we need to update the user
        if (user && user.id !== userId) {
          console.log(`Updating user ID from ${user.id} to ${userId} for email ${userEmail}`);
          // Note: This scenario might need special handling for data consistency
        }
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
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
      console.log(`Fetching customers for user ${user.email} (role: ${user.role}, sellerId: ${sellerId})`);
      
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
      
      const customer = await storage.createCustomer(data);
      res.json(customer);
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
          const latitude = row['LATITUDE'] || row['Latitude'] || row['latitude'] || row['lat'];
          const longitude = row['LONGITUDE'] || row['Longitude'] || row['longitude'] || row['lng'];
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
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
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
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
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
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
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

  // Sales metrics routes
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
      const user = req.currentUser;
      const sellerId = req.sellerId;
      const routeDay = req.query.route_day; // Filter by route day (segunda, terca, etc)
      const status = req.query.status; // Filter by status
      
      console.log(`Fetching sales cards for user ${user.email} (role: ${user.role}, sellerId: ${sellerId})`);
      
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

  app.post('/api/sales-cards', authenticateUser, async (req: any, res) => {
    try {
      console.log('POST /api/sales-cards - Request body:', req.body);
      
      // Processar a data corretamente
      const processedData = {
        ...req.body,
        scheduledDate: new Date(req.body.scheduledDate),
        status: req.body.status || 'pending',
        isRecurring: req.body.isRecurring || true,
      };
      
      console.log('POST /api/sales-cards - Processed data:', processedData);
      
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
          console.log(`Coordenadas GPS atualizadas para cliente ${processedData.customerId}: ${req.body.customerLatitude}, ${req.body.customerLongitude}`);
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
        errors: [] as any[]
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

          // Limpar CNPJ
          const cnpj = cnpjRaw.toString().replace(/\D/g, '');
          
          // Verificar se cliente existe
          let customer = await storage.getCustomerByCnpj(cnpj);
          
          // Se não existe, buscar na Receita Federal e criar
          if (!customer) {
            console.log(`Cliente não encontrado para CNPJ ${cnpj}, consultando Receita Federal...`);
            
            const receitaData = await receitaService.consultarCNPJ(cnpj);
            
            if (!receitaData) {
              results.errors.push({
                row: i + 2,
                cnpj,
                error: "CNPJ não encontrado na Receita Federal"
              });
              continue;
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
              weekdays: (row['Dias da Semana'] || row['dias da semana']) ? JSON.stringify(
                (row['Dias da Semana'] || row['dias da semana']).toString().split(',').map((d: string) => d.trim().toLowerCase())
              ) : JSON.stringify([]),
              visitPeriodicity: (row.Periodicidade || row.periodicidade)?.toLowerCase() || 'semanal'
            });
            
            results.created++;
            console.log(`Cliente criado: ${customer.fantasyName} (${cnpj})`);
          } else {
            // Atualizar weekdays e periodicidade se fornecidos
            const updateData: any = {};
            
            const weekdaysCol = row['Dias da Semana'] || row['dias da semana'];
            if (weekdaysCol) {
              updateData.weekdays = JSON.stringify(
                weekdaysCol.toString().split(',').map((d: string) => d.trim().toLowerCase())
              );
            }
            
            const periodicityCol = row.Periodicidade || row.periodicidade;
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
          const hasActiveCard = existingCards.some(
            card => card.customerId === customer.id && ACTIVE_STATUSES.includes(card.status)
          );

          if (hasActiveCard) {
            results.errors.push({
              row: i + 2,
              cnpj,
              customer: customer.fantasyName,
              error: "Cliente já possui card ativo (pendente ou em telemarketing)"
            });
            continue;
          }

          // Calcular próxima data de visita
          let scheduledDate = new Date();
          
          if (customer.weekdays && customer.visitPeriodicity) {
            const { calculateNextVisitDate } = await import('@shared/visitSchedule');
            
            let parsedWeekdays: string[] = [];
            try {
              parsedWeekdays = typeof customer.weekdays === 'string' 
                ? JSON.parse(customer.weekdays) 
                : customer.weekdays;
            } catch (e) {
              parsedWeekdays = [];
            }

            if (parsedWeekdays.length > 0) {
              const result = calculateNextVisitDate({
                weekdays: parsedWeekdays as any[],
                periodicity: customer.visitPeriodicity as any,
                lastCompletedDate: new Date()
              });
              scheduledDate = result.nextDate;
            }
          }

          // Derivar routeDay do scheduledDate
          const dayOfWeek = scheduledDate.getDay();
          const weekdayNames = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
          const routeDay = weekdayNames[dayOfWeek];

          // Criar card de venda
          await storage.createSalesCard({
            customerId: customer.id,
            sellerId: user.role === 'vendedor' ? user.id : (customer.sellerId || user.id),
            status: 'pending',
            scheduledDate,
            routeDay,
            recurrenceType: customer.visitPeriodicity || 'semanal',
            isRecurring: true,
            exclusiveVehicle: false,
            vehicleTypes: ['moto', 'carro', 'caminhao']
          });

        } catch (rowError: any) {
          console.error(`Erro ao processar linha ${i + 2}:`, rowError);
          results.errors.push({
            row: i + 2,
            error: rowError.message || 'Erro desconhecido'
          });
        }
      }

      res.json({
        success: true,
        message: `Importação concluída: ${results.created} clientes criados, ${results.updated} atualizados`,
        results
      });

    } catch (error: any) {
      console.error("Erro na importação em massa:", error);
      res.status(500).json({ 
        message: "Erro ao processar planilha", 
        error: error.message 
      });
    }
  });

  app.put('/api/sales-cards/:id', authenticateUser, async (req: any, res) => {
    try {
      const { id } = req.params;
      console.log('PUT /api/sales-cards/:id - Request body:', req.body);
      console.log('PUT /api/sales-cards/:id - User ID:', req.userId);
      
      const data = insertSalesCardSchema.partial().parse(req.body);
      console.log('PUT /api/sales-cards/:id - Parsed data:', data);
      
      // Check permissions for reassigning sales cards
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (data.sellerId && user?.role === 'vendedor') {
        return res.status(403).json({ message: "Vendedores cannot reassign sales cards" });
      }
      
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
      
      // Se o status mudou para completed, no_sale ou failed, usar função helper para fechar e reagendar
      let salesCard;
      if (data.status && ['completed', 'no_sale', 'failed'].includes(data.status)) {
        const result = await storage.closeCardAndScheduleNext(id, data.status as any, data);
        salesCard = result.closedCard;
        
        if (result.nextCard) {
          console.log(`Card fechado e próxima visita agendada: ${result.nextCard.id} para ${result.nextCard.scheduledDate}`);
        }
      } else {
        // Atualização normal sem mudança de status final
        salesCard = await storage.updateSalesCard(id, data);
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

  // Dashboard routes
  app.get('/api/dashboard/stats', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
      console.log(`Fetching dashboard stats for user ${user.email} (role: ${user.role}, sellerId: ${sellerId})`);
      
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
      const sellerId = req.sellerId;
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
      const { startDate, endDate, page = 1, limit = 20 } = req.query;
      
      const user = req.currentUser;
      const sellerId = req.sellerId; // Set by checkSellerAccess middleware
      
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
          const systemClient = {
            ...omieService.convertClientToSystemFormat(omieClient),
            sellerId: sellerId || '', // Deixar vazio se não houver vendedor atribuído
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
              const systemClient = {
                ...omieService.convertClientToSystemFormat(omieClient),
                sellerId: defaultSellerId || '',
                weekdays: "segunda,terça,quarta,quinta,sexta"
              };

              // Verificar se cliente já existe
              let existingCustomer = await storage.getCustomer(systemClient.id);
              
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
  
  // Listar faturamentos com filtros avançados
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

      const visits = await db.select({
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
      await db.update(visitAgenda)
        .set({
          actualCheckIn: new Date(),
          checkInLatitude: latitude.toString(),
          checkInLongitude: longitude.toString(),
          distanceToCustomer: distanceToCustomer ? distanceToCustomer.toString() : null,
          visitStatus: 'in_progress'
        })
        .where(eq(visitAgenda.id, id));

      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentVisit.sellerId, today);
        
        if (dailyRoute) {
          const { registerCheckpoint } = await import('./routeOptimizationService');
          routeProgress = await registerCheckpoint(
            storage,
            dailyRoute.id,
            id,
            currentVisit.sellerId,
            'check_in',
            latitude,
            longitude
          );
        }
      } catch (error) {
        console.error('Erro ao registrar checkpoint:', error);
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

      // Registrar checkpoint na rota diária (se existir)
      let routeProgress = null;
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dailyRoute = await storage.getDailyRouteBySellerAndDate(currentVisit.sellerId, today);
        
        if (dailyRoute) {
          const { registerCheckpoint } = await import('./routeOptimizationService');
          routeProgress = await registerCheckpoint(
            storage,
            dailyRoute.id,
            id,
            currentVisit.sellerId,
            'check_out',
            latitude,
            longitude
          );
        }
      } catch (error) {
        console.error('Erro ao registrar checkpoint:', error);
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
        .leftJoin(users, eq(visitAgenda.sellerId, users.id))
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

      res.json({
        success: true,
        duration: `${duration}s`,
        results,
        summary: {
          clientsProcessed: results.clients?.totalProcessed || 0,
          billingsProcessed: results.billings?.totalProcessed || 0,
          overdueClientsFound: results.overdueDebts?.totalClients || 0,
          totalErrors: results.errors.length
        }
      });

    } catch (error: any) {
      console.error('❌ Erro geral na sincronização completa:', error);
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
      res.json(result);
      
    } catch (error: any) {
      console.error('❌ Erro na sincronização de faturamentos:', error);
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
      
      console.log(`Fetching blocked orders for user ${user.email} (role: ${user.role})`);
      
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
      
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ message: "Lista de IDs de pedidos é obrigatória" });
      }
      
      console.log(`Releasing ${orderIds.length} blocked orders by user ${req.currentUser.email}`);
      
      let released = 0;
      const errors = [];
      
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Integração Omie não configurada' });
      }
      
      for (const orderId of orderIds) {
        try {
          // Buscar pedido bloqueado
          const blockedOrder = await db.select()
            .from(blockedOrders)
            .where(eq(blockedOrders.id, orderId))
            .limit(1);
          
          if (blockedOrder.length === 0) {
            errors.push(`Pedido ${orderId} não encontrado`);
            continue;
          }
          
          const order = blockedOrder[0];
          
          // Buscar sales card relacionado
          const salesCard = await storage.getSalesCard(order.salesCardId);
          if (!salesCard) {
            errors.push(`Sales card ${order.salesCardId} não encontrado`);
            continue;
          }
          
          // Buscar dados completos dos produtos
          let products = [];
          if (order.products && Array.isArray(order.products) && order.products.length > 0) {
            const productPromises = order.products.map(async (cardProduct: any) => {
              let product = await storage.getProduct(cardProduct.id);
              if (!product) {
                product = await storage.getProductByOmieCode(cardProduct.id);
              }
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
          }
          
          // Enviar para Omie
          const omieResponse = await omieService.createSalesOrder(
            salesCard,
            salesCard.customer,
            products,
            order.paymentMethod || 'a_vista',
            order.operationType || 'venda',
            order.sellerId
          );
          
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
          console.error(`❌ Erro ao liberar pedido ${orderId}:`, error);
          errors.push(`Pedido ${orderId}: ${error.message}`);
        }
      }
      
      res.json({
        released,
        errors,
        message: `${released} pedido(s) liberado(s) com sucesso${errors.length > 0 ? `, ${errors.length} erro(s)` : ''}`
      });
      
    } catch (error) {
      console.error("Error releasing blocked orders:", error);
      res.status(500).json({ message: "Failed to release blocked orders" });
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

  // Rota LEGADO para sincronizar apenas notas fiscais do Omie
  app.post('/api/omie/sync-billings', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService(storage);
      if (!omieService) {
        return res.status(503).json({ message: 'Serviço Omie não configurado' });
      }

      const result = await omieService.syncBillings();
      res.json(result);
    } catch (error) {
      console.error('Erro na sincronização de faturamentos:', error);
      res.status(500).json({ message: 'Erro interno do servidor' });
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
            if (!billing.omieOrderId) continue;

            // Buscar a etapa atualizada do pedido
            const stageData = await (omieService as any).fetchPedidoStage(billing.omieOrderId);
            
            if (stageData && stageData.stageName) {
              // Atualizar apenas se a etapa mudou
              if (billing.invoiceStage !== stageData.stageName) {
                await db.update(billingsTable)
                  .set({ 
                    invoiceStage: stageData.stageName,
                    updatedAt: new Date()
                  })
                  .where(eq(billingsTable.id, billing.id));
                
                console.log(`✅ ${billing.invoiceNumber}: ${billing.invoiceStage} → ${stageData.stageName}`);
                updated++;
              }
            }
          } catch (error: any) {
            console.error(`❌ Erro ao atualizar nota ${billing.invoiceNumber}:`, error.message);
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
      
      // Buscar sales cards completados que ainda não têm rota definida
      const deliveries = await db.select({
        id: salesCards.id,
        customerId: salesCards.customerId,
        customerName: customers.name,
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
      .where(
        and(
          eq(salesCards.status, 'completed'),
          // Pedidos que ainda não têm rota de entrega
          sql`NOT EXISTS (
            SELECT 1 FROM delivery_route_stops 
            WHERE delivery_route_stops.sales_card_id = ${salesCards.id}
          )`
        )
      )
      .orderBy(salesCards.completedDate);
      
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
        customerName: customers.name,
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
      await storage.updateSalesCard(cardId, {
        omieOrderId: omieResponse.codigo_pedido?.toString() || `HS-${Date.now()}`,
        notes: (card.notes || '') + `\n\nEnviado para Omie: ${new Date().toLocaleString('pt-BR')}`
      });
      
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
      
      res.json({
        success: true,
        message: 'Check-in realizado com sucesso',
        checkInTime: updateData.checkInTime,
        distance: checkInDistance,
        hasPhoto: !!photoUrl
      });
    } catch (error) {
      console.error("Error during check-in:", error);
      res.status(500).json({ message: "Failed to perform check-in" });
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
      
      res.json({
        success: true,
        message: 'Check-out realizado com sucesso',
        checkOutTime: updateData.checkOutTime,
        checkOutDistance
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
        
        // For now, just set status as blocked in sales card
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
          notes: (await storage.getSalesCard(id))?.notes + `\n\nPedido bloqueado: ${blockDetails}`
        };

        await storage.updateSalesCard(id, updateData);
        
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
            console.log(`Coordenadas GPS atualizadas para cliente ${card.customerId} após venda finalizada: ${req.body.customerLatitude}, ${req.body.customerLongitude}`);
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

      const routeDate = new Date(date);
      
      // Verificar se já existe rota para este dia
      const existingRoute = await storage.getDailyRouteBySellerAndDate(targetSellerId, routeDate);
      
      if (existingRoute) {
        return res.json({
          message: 'Rota já existe para esta data',
          route: existingRoute,
          alreadyExists: true
        });
      }

      // Gerar nova rota
      const result = await generateDailyRoute(storage, targetSellerId, routeDate);
      
      res.json({
        success: true,
        ...result
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

      // Buscar detalhes das visitas na ordem otimizada
      const visits = await Promise.all(
        (route.optimizedOrder || []).map(async (visitId: string) => {
          const [visit] = await db.select()
            .from(visitAgenda)
            .where(eq(visitAgenda.id, visitId))
            .limit(1);
          return visit;
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
            const distance = calculateDistance(
              prevLat, 
              prevLon,
              parseFloat(visit.customerLatitude as any),
              parseFloat(visit.customerLongitude as any)
            );
            
            segments.push({
              visitId: visit.id,
              from: i === 0 ? 'Casa' : visits[i-1]?.customerName,
              to: visit.customerName,
              distance: distance
            });
            
            prevLat = parseFloat(visit.customerLatitude as any);
            prevLon = parseFloat(visit.customerLongitude as any);
          }
        }
        
        // Distância de retorno para casa
        if (visits.length > 0) {
          const lastVisit = visits[visits.length - 1];
          if (lastVisit?.customerLatitude && lastVisit?.customerLongitude) {
            const returnDistance = calculateDistance(
              parseFloat(lastVisit.customerLatitude as any),
              parseFloat(lastVisit.customerLongitude as any),
              parseFloat(route.startLatitude),
              parseFloat(route.startLongitude)
            );
            
            segments.push({
              visitId: 'return',
              from: lastVisit.customerName,
              to: 'Casa',
              distance: returnDistance
            });
          }
        }
      }

      // Buscar checkpoints da rota
      const checkpoints = await storage.getRouteCheckpoints(route.id);

      res.json({
        route: {
          ...route,
          visits: visits.filter(Boolean),
          checkpoints,
          segments,
          progress: {
            totalVisits: route.totalVisits || 0,
            completedVisits: route.completedVisits || 0,
            totalEstimatedDistance: parseFloat(route.totalEstimatedDistance || '0'),
            totalActualDistance: parseFloat(route.totalActualDistance || '0'),
            percentComplete: route.totalVisits > 0 
              ? Math.round((route.completedVisits / route.totalVisits) * 100) 
              : 0
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
          customerName: customers.name,
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


  const httpServer = createServer(app);
  return httpServer;
}
