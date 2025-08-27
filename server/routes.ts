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
  insertLocationSchema,
} from "@shared/schema";
import { z } from "zod";
import multer from 'multer';
import * as XLSX from 'xlsx';

// Configurar multer para upload de arquivos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

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
      const data = req.body;
      
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
      const requiredFields = ['customerId', 'sellerId', 'scheduledDate', 'routeDay', 'recurrenceType'];
      for (const field of requiredFields) {
        if (!processedData[field]) {
          return res.status(400).json({ 
            message: `Campo obrigatório ausente: ${field}` 
          });
        }
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
      
      // Se coordenadas GPS foram capturadas durante a atualização da venda, atualizar o cliente
      if (req.body.customerLatitude && req.body.customerLongitude) {
        try {
          await storage.updateCustomer(salesCard.customerId, {
            latitude: req.body.customerLatitude,
            longitude: req.body.customerLongitude
          });
          console.log(`Coordenadas GPS atualizadas para cliente ${salesCard.customerId}: ${req.body.customerLatitude}, ${req.body.customerLongitude}`);
        } catch (coordError) {
          console.error('Erro ao atualizar coordenadas do cliente:', coordError);
          // Não falhar a atualização da venda se a atualização de coordenadas falhar
        }
      }
      
      // Se o card foi completado e tem recorrência ativa, gerar próximo card
      if (data.status === 'completed' && salesCard.isRecurring) {
        const nextCard = await storage.generateNextSalesCard(salesCard.id);
        if (nextCard) {
          console.log(`Próximo card gerado para o cliente ${salesCard.customerId}: ${nextCard.id}`);
        }
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

  // Endpoint para buscar cards por dia da semana e período
  app.get('/api/sales-cards/by-day/:routeDay', authenticateUser, async (req: any, res) => {
    try {
      const { routeDay } = req.params;
      const { startDate, endDate, page = 1, limit = 20, sellerId: querySellerId } = req.query;
      
      const userId = req.userId;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Para vendedores, mostrar apenas seus cards
      const sellerId = user.role === 'vendedor' ? user.id : querySellerId;
      
      if (!sellerId) {
        return res.status(400).json({ message: "sellerId is required for non-vendedor users" });
      }
      
      const start = startDate ? new Date(startDate as string) : new Date();
      const end = endDate ? new Date(endDate as string) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias
      
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
  // Get available stages from Omie
  app.get('/api/omie/stages', authenticateUser, async (req: any, res) => {
    try {
      const omieService = getOmieService();
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
      
      const omieService = getOmieService();
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
      
      const omieService = getOmieService();
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

  app.get('/api/omie/overdue-debts', authenticateUser, async (req: any, res) => {
    try {
      // Evitar cache
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      const omieService = getOmieService();
      if (!omieService) {
        return res.status(503).json({ 
          message: "Integração Omie não configurada" 
        });
      }

      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Fetching overdue debts from Omie - NO CACHE...`);
      const overdueData = await omieService.getOverdueDebts();
      console.log(`[${timestamp}] Overdue debts fetch complete - returning ${overdueData.totalClients} clients`);
      res.json(overdueData);

    } catch (error) {
      console.error("Error fetching overdue debts from Omie:", error);
      res.status(500).json({ 
        message: "Erro ao buscar débitos em atraso no Omie",
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

      const omieService = getOmieService();
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
      const omieService = getOmieService();
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

  // Blocked orders routes
  app.get('/api/blocked-orders', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const sellerId = user?.role === 'vendedor' ? user.id : undefined;
      
      console.log(`Fetching blocked orders for user ${user.email} (role: ${user.role})`);
      
      // Para implementação inicial, retornar lista vazia
      // TODO: Implementar storage.getBlockedOrders quando schema estiver aplicado
      const blockedOrders = [];
      res.json(blockedOrders);
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
      
      // Para implementação inicial, simular liberação
      // TODO: Implementar lógica real quando schema estiver aplicado
      res.json({
        released: orderIds.length,
        errors: [],
        message: `${orderIds.length} pedido(s) liberado(s) com sucesso`
      });
      
    } catch (error) {
      console.error("Error releasing blocked orders:", error);
      res.status(500).json({ message: "Failed to release blocked orders" });
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

  // Send card to Omie endpoint
  app.post('/api/sales-cards/:id/send-to-omie', isAuthenticated, async (req, res) => {
    try {
      const cardId = req.params.id;
      
      // Buscar o card com dados relacionados
      const card = await storage.getSalesCardWithRelations(cardId);
      
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
      
      // Enviar para Omie
      const omieResponse = await createOmieOrder(saleData);
      
      // Atualizar card com ID do Omie
      await storage.updateSalesCard(cardId, {
        omieOrderId: omieResponse.orderNumber || `HS-${Date.now()}`,
        notes: (card.notes || '') + `\n\nEnviado para Omie: ${new Date().toLocaleString('pt-BR')}`
      });
      
      res.json({ 
        message: 'Pedido enviado para Omie com sucesso!',
        omieOrderId: omieResponse.orderNumber 
      });
      
    } catch (error) {
      console.error('Erro ao enviar para Omie:', error);
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

  // Route for check-in
  app.post('/api/sales-cards/:id/check-in', authenticateUser, async (req: any, res) => {
    try {
      console.log('Check-in route called - User:', req.currentUser?.id || 'undefined');
      const { id } = req.params;
      const { latitude, longitude, distance } = req.body;

      const updateData = {
        checkInTime: new Date(),
        checkInLatitude: latitude.toString(),
        checkInLongitude: longitude.toString(),
        distanceToCustomer: distance.toString()
      };

      const salesCard = await storage.updateSalesCard(id, updateData);
      
      res.json({
        success: true,
        message: 'Check-in realizado com sucesso',
        checkInTime: updateData.checkInTime,
        distance
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

      const updateData = {
        checkOutTime: new Date(),
        checkOutLatitude: latitude.toString(),
        checkOutLongitude: longitude.toString()
      };

      const salesCard = await storage.updateSalesCard(id, updateData);
      
      res.json({
        success: true,
        message: 'Check-out realizado com sucesso',
        checkOutTime: updateData.checkOutTime
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
              const omieService = getOmieService();
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

            // Verificar se produto já existe
            const existingProducts = await storage.getAllProducts();
            const existingProduct = existingProducts.find(p => p.omieProductId === product.codigo_produto);
            
            const productData = {
              name: product.descricao || 'Produto sem nome',
              description: product.descricao_detalhada || product.descricao || '',
              price: (product.valor_unitario || 0).toString(),
              stock: stockQuantity,
              stockQuantity: stockQuantity,
              unit: product.unidade || 'UN',
              omieProductId: product.codigo_produto,
              omieCode: product.codigo || product.codigo_produto.toString(),
              ncm: product.ncm || '',
              ean: product.ean || '',
              categoryId: 'bebidas-frutas',
              isActive: true
            };

            if (existingProduct) {
              // Atualizar produto existente
              await storage.updateProduct(existingProduct.id, productData);
              console.log(`Produto atualizado: ${product.descricao} (Estoque: ${stockQuantity})`);
            } else {
              // Criar novo produto
              await storage.createProduct({
                id: `omie-${product.codigo_produto}`,
                ...productData
              });
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

  const httpServer = createServer(app);
  return httpServer;
}
