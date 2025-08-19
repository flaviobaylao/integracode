import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
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

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Customer routes
  app.get('/api/customers', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Vendedores only see their own customers
      const sellerId = user.role === 'vendedor' ? userId : undefined;
      const customers = await storage.getCustomers(sellerId);
      res.json(customers);
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ message: "Failed to fetch customers" });
    }
  });

  app.get('/api/customers/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const customer = await storage.getCustomer(id);
      
      if (!customer) {
        return res.status(404).json({ message: "Customer not found" });
      }
      
      // Check if vendedor can access this customer
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (user?.role === 'vendedor' && customer.sellerId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ message: "Failed to fetch customer" });
    }
  });

  app.post('/api/customers', isAuthenticated, async (req: any, res) => {
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
  app.get('/api/products', isAuthenticated, async (req, res) => {
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
  app.get('/api/sales-cards', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      // Vendedores only see their own sales cards
      const sellerId = user?.role === 'vendedor' ? userId : undefined;
      const salesCards = await storage.getSalesCards(sellerId);
      res.json(salesCards);
    } catch (error) {
      console.error("Error fetching sales cards:", error);
      res.status(500).json({ message: "Failed to fetch sales cards" });
    }
  });

  app.post('/api/sales-cards', isAuthenticated, async (req: any, res) => {
    try {
      const data = insertSalesCardSchema.parse(req.body);
      const salesCard = await storage.createSalesCard(data);
      res.json(salesCard);
    } catch (error) {
      console.error("Error creating sales card:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create sales card" });
    }
  });

  app.put('/api/sales-cards/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const data = insertSalesCardSchema.partial().parse(req.body);
      
      // Check permissions for reassigning sales cards
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      if (data.sellerId && user?.role === 'vendedor') {
        return res.status(403).json({ message: "Vendedores cannot reassign sales cards" });
      }
      
      const salesCard = await storage.updateSalesCard(id, data);
      res.json(salesCard);
    } catch (error) {
      console.error("Error updating sales card:", error);
      res.status(500).json({ message: "Failed to update sales card" });
    }
  });

  app.post('/api/sales-cards/:id/duplicate', isAuthenticated, async (req: any, res) => {
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

  app.delete('/api/sales-cards/:id', isAuthenticated, async (req: any, res) => {
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

  app.get('/api/dashboard/today-clients', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      const sellerId = user?.role === 'vendedor' ? userId : undefined;
      const todayClients = await storage.getSalesCardsByDate(new Date(), sellerId);
      res.json(todayClients);
    } catch (error) {
      console.error("Error fetching today's clients:", error);
      res.status(500).json({ message: "Failed to fetch today's clients" });
    }
  });

  app.get('/api/dashboard/overdue-clients', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      
      const sellerId = user?.role === 'vendedor' ? userId : undefined;
      const overdueClients = await storage.getOverdueSalesCards(sellerId);
      res.json(overdueClients);
    } catch (error) {
      console.error("Error fetching overdue clients:", error);
      res.status(500).json({ message: "Failed to fetch overdue clients" });
    }
  });

  // Message template routes
  app.get('/api/message-templates', isAuthenticated, async (req, res) => {
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

  const httpServer = createServer(app);
  return httpServer;
}
