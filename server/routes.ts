import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { validateLocalAdmin, createLocalSession } from "./localAuth";
import { authenticateUser, requireRole, checkSellerAccess } from "./authMiddleware";
import { getOmieService, isOmieConfigured } from "./omieIntegration";
import { receitaService } from "./receitaIntegration";
import {
  insertCustomerSchema,
  insertProductSchema,
  insertSalesCardSchema,
  insertMessageTemplateSchema,
  insertMessageHistorySchema,
} from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Local login route for admin
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
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // User routes
  app.get('/api/users', authenticateUser, async (req: any, res) => {
    try {
      const users = await storage.getUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Customer routes
  app.get('/api/customers', authenticateUser, checkSellerAccess, async (req: any, res) => {
    try {
      const user = req.currentUser;
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

  app.post('/api/customers', authenticateUser, async (req: any, res) => {
    try {
      const data = insertCustomerSchema.parse(req.body);
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

  app.put('/api/customers/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const data = insertCustomerSchema.partial().parse(req.body);
      
      // Check permissions for reassigning customers
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (data.sellerId && user?.role === 'vendedor') {
        return res.status(403).json({ message: "Vendedores cannot reassign customers" });
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

  app.delete('/api/customers/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.deleteCustomer(id);
      res.json({ message: "Customer deleted successfully" });
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({ message: "Failed to delete customer" });
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

  app.post('/api/products', isAuthenticated, async (req: any, res) => {
    try {
      // Only admin and coordinators can manage products
      const userId = req.user.claims.sub;
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

  app.put('/api/products/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.claims.sub;
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

  app.delete('/api/products/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.claims.sub;
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
      const requiredFields = ['customerId', 'sellerId', 'scheduledDate', 'routeDay', 'recurrenceType'];
      for (const field of requiredFields) {
        if (!processedData[field]) {
          return res.status(400).json({ 
            message: `Campo obrigatório ausente: ${field}` 
          });
        }
      }
      
      const data = processedData;
      const salesCard = await storage.createSalesCard(data);
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
      
      const salesCard = await storage.updateSalesCard(id, data);
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

  // Dashboard routes
  app.get('/api/dashboard/stats', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      // Vendedores only see their own stats
      const sellerId = user?.role === 'vendedor' ? userId : undefined;
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
      const todayClients = await storage.getSalesCardsByDate(new Date(), sellerId);
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
      
      if (!['admin', 'coordinator', 'administrative'].includes(user?.role || '')) {
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

      const omieService = getOmieService();
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
      
      const omieService = getOmieService();
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
      
      const omieService = getOmieService();
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

      const omieService = getOmieService();
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

      if (!sellerId) {
        return res.status(400).json({ 
          message: "ID do vendedor é obrigatório" 
        });
      }

      const omieService = getOmieService();
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
            sellerId: sellerId,
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

  // Rota para sincronizar todos os clientes do Omie
  app.post('/api/omie/sync-all-clients', authenticateUser, async (req: any, res) => {
    try {
      const { defaultSellerId } = req.body;
      
      if (!defaultSellerId) {
        return res.status(400).json({ 
          message: "ID do vendedor padrão é obrigatório" 
        });
      }

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        errors: [] as string[]
      };

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await omieService.getAllClients(currentPage, 100);
        
        for (const omieClient of pageData.clients) {
          result.totalProcessed++;
          
          try {
            // Converter para formato do sistema
            const systemClient = {
              ...omieService.convertClientToSystemFormat(omieClient),
              sellerId: defaultSellerId,
              weekdays: "segunda,terça,quarta,quinta,sexta" // Padrão para todos
            };

            // Verificar se cliente já existe pelo documento (CPF/CNPJ) ou código do Omie
            const existingCustomers = await storage.getCustomers();
            const existingCustomer = existingCustomers.find(customer => {
              // Verificar por documento
              if (systemClient.cpf && (customer as any).cpf === systemClient.cpf) return true;
              if (systemClient.cnpj && (customer as any).cnpj === systemClient.cnpj) return true;
              // Verificar por código do Omie se disponível
              if ((customer as any).omieId === omieClient.codigo_cliente_omie) return true;
              return false;
            });

            if (existingCustomer) {
              // Atualizar cliente existente
              await storage.updateCustomer(existingCustomer.id, {
                name: systemClient.name,
                phone: systemClient.phone,
                email: systemClient.email,
                address: systemClient.address,
                city: systemClient.city,
                state: systemClient.state,
                isActive: systemClient.isActive
              });
              result.updated++;
            } else {
              // Criar novo cliente
              await storage.createCustomer(systemClient);
              result.imported++;
            }

          } catch (error: any) {
            console.error(`Erro ao processar cliente ${omieClient.codigo_cliente_omie}:`, error);
            result.errors.push(`Erro ao processar cliente ${omieClient.razao_social || omieClient.nome_fantasia}: ${error?.message || 'Erro desconhecido'}`);
          }
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      res.json(result);

    } catch (error) {
      console.error("Error syncing all clients from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao sincronizar clientes do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para buscar débitos em atraso do Omie
  app.get('/api/omie/overdue-debts', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService();
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const overdueData = await omieService.getOverdueDebts();
      res.json(overdueData);

    } catch (error) {
      console.error("Error fetching overdue debts from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar débitos em atraso no Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  });

  // Rota para sincronizar todos os vendedores do Omie
  app.post('/api/omie/sync-vendors', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService();
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        errors: [] as string[]
      };

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await omieService.getAllVendors(currentPage, 100);
        
        for (const omieVendor of pageData.vendors) {
          result.totalProcessed++;
          
          try {
            // Converter para formato do sistema
            const systemVendor = omieService.convertVendorToSystemFormat(omieVendor);

            // Verificar se vendedor já existe pelo ID do Omie ou email
            const existingUsers = await storage.getUsers();
            const existingVendor = existingUsers.find(user => 
              user.role === 'vendedor' && 
              (user.id === `omie-vendor-${omieVendor.codigo}` || 
               (user.email && user.email === systemVendor.email))
            );

            if (existingVendor) {
              // Atualizar vendedor existente
              await storage.updateUser(existingVendor.id, {
                firstName: systemVendor.firstName,
                lastName: systemVendor.lastName,
                email: systemVendor.email,
                isActive: systemVendor.isActive
              });
              result.updated++;
            } else {
              // Criar novo vendedor
              await storage.createUser(systemVendor);
              result.imported++;
            }

          } catch (error: any) {
            console.error(`Erro ao processar vendedor ${omieVendor.codigo}:`, error);
            result.errors.push(`Erro ao processar vendedor ${omieVendor.nome}: ${error?.message || 'Erro desconhecido'}`);
          }
        }

        currentPage++;
        hasMorePages = currentPage <= pageData.totalPages;
      }

      res.json(result);

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
      const omieService = getOmieService();
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const result = {
        totalProcessed: 0,
        imported: 0,
        updated: 0,
        errors: [] as string[]
      };

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const pageData = await omieService.getAllProducts(currentPage, 100);
        
        for (const omieProduct of pageData.products) {
          result.totalProcessed++;
          
          try {
            // Converter para formato do sistema
            const systemProduct = {
              name: omieProduct.descricao || '',
              description: omieProduct.descricao || '',
              price: omieProduct.valor_unitario?.toString() || '0',
              stock: 0,
              isActive: true
            };

            // Verificar se produto já existe pelo nome
            const existingProducts = await storage.getProducts();
            const existingProduct = existingProducts.find(product => 
              product.name === systemProduct.name
            );

            if (existingProduct) {
              // Atualizar produto existente
              await storage.updateProduct(existingProduct.id, {
                price: systemProduct.price,
                isActive: systemProduct.isActive
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

      res.json(result);

    } catch (error) {
      console.error("Error syncing products from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao sincronizar produtos do Omie",
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
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
        razaoSocial: dadosCNPJ.razao_social,
        nomeFantasia: dadosCNPJ.nome_fantasia || '',
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
          const omieService = getOmieService();
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

  // Exportar sales card para o Omie como pedido de venda
  app.post('/api/sales-cards/:id/export-to-omie', isAuthenticated, async (req, res) => {
    try {
      const { id } = req.params;
      
      const salesCard = await storage.getSalesCard(id);
      if (!salesCard) {
        return res.status(404).json({ message: 'Sales card not found' });
      }

      const omieService = getOmieService();
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

      // Preparar lista de produtos (usar dados do request ou produtos padrão)
      const products = req.body.products || [
        {
          id: 'default-product',
          name: 'Produto de vendas',
          price: salesCard.value || 0,
          quantity: 1
        }
      ];

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
      const omieService = getOmieService();
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

      const omieService = getOmieService();
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
      const orderProducts = products || salesCard.products || [];

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

  const httpServer = createServer(app);
  return httpServer;
}
