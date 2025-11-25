import { calculateDeliveryDays } from '@shared/deliveryDaysCalculator';
import {
  users,
  routes,
  customers,
  products,
  productReviews,
  salesCards,
  orderHistory,
  messageTemplates,
  messageHistory,
  systemSettings,
  locations,
  salesGoals,
  billings,
  overdueDebts,
  exportedReports,
  visitAgenda,
  dailyRoutes,
  routeCheckpoints,
  deliveryRoutes,
  deliveryRouteStops,
  deliveryDrivers,
  syncStatus,
  leads,
  chatAgents,
  chatCustomers,
  chatConversations,
  chatMessages,
  chatReports,
  chatAuditLog,
  chatProducts,
  chatQuickMessages,
  chatOrders,
  chatDeliveries,
  chatDeliveryRejectionReasons,
  whatsappConversationAnalysis,
  knowledgeBase,
  type User,
  type UpsertUser,
  type Route,
  type InsertRoute,
  type InsertCustomer,
  type Customer,
  type CustomerWithSeller,
  type InsertProduct,
  type Product,
  type InsertProductReview,
  type ProductReview,
  type InsertSalesCard,
  type SalesCard,
  type SalesCardWithRelations,
  type InsertOrderHistory,
  type OrderHistory,
  type InsertMessageTemplate,
  type MessageTemplate,
  type InsertMessageHistory,
  type MessageHistory,
  type Location,
  type InsertLocation,
  type SalesGoal,
  type InsertSalesGoal,
  type Billing,
  type InsertBilling,
  type ExportedReport,
  type SyncStatus,
  type PendingDelivery,
  type InsertSyncStatus,
  type Lead,
  type InsertLead,
  type ChatAgent,
  type InsertChatAgent,
  type ChatCustomer,
  type InsertChatCustomer,
  type UpdateChatCustomer,
  type ChatConversation,
  type InsertChatConversation,
  type ChatMessage,
  type InsertChatMessage,
  type ChatReport,
  type InsertChatReport,
  type ChatAuditLog,
  type InsertChatAuditLog,
  type ChatProduct,
  type InsertChatProduct,
  type ChatQuickMessage,
  type InsertChatQuickMessage,
  type ChatOrder,
  type InsertChatOrder,
  type ChatDelivery,
  type InsertChatDelivery,
  type ChatDeliveryRejectionReason,
  type InsertChatDeliveryRejectionReason,
  type WhatsappConversationAnalysis,
  type InsertWhatsappConversationAnalysis,
  type KnowledgeBase,
  type InsertKnowledgeBase,
  insertSystemSettingSchema,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, gte, lte, gt, sql, inArray, or, isNotNull, isNull, ne, like } from "drizzle-orm";
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { calculateNextVisitDate } from "@shared/visitSchedule";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  upsertUser(user: UpsertUser): Promise<User>;
  createUser(user: UpsertUser): Promise<User>;
  updateUser(id: string, user: Partial<UpsertUser>): Promise<User>;
  updateUserPassword(id: string, hashedPassword: string): Promise<User>;
  deleteUser(id: string): Promise<void>;
  
  // Route operations
  getRoutes(): Promise<Route[]>;
  getRoute(id: string): Promise<Route | undefined>;
  getRouteByName(name: string): Promise<Route | undefined>;
  createRoute(route: InsertRoute): Promise<Route>;
  updateRoute(id: string, route: Partial<InsertRoute>): Promise<Route>;
  deleteRoute(id: string): Promise<void>;
  getRoutesBySellerId(sellerId: string): Promise<Route[]>;
  
  // Customer operations
  getCustomers(sellerId?: string): Promise<CustomerWithSeller[]>;
  getAllCustomers(): Promise<Customer[]>;
  getCustomer(id: string): Promise<CustomerWithSeller | undefined>;
  getCustomerByCpf(cpf: string): Promise<Customer | undefined>;
  getCustomerByCnpj(cnpj: string): Promise<Customer | undefined>;
  getCustomerByDocument(document: string): Promise<Customer | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, customer: Partial<InsertCustomer>): Promise<Customer>;
  inactivateCustomer(customerId: string, currentCardId: string): Promise<{ customer: Customer; deletedCards: number }>;
  deleteCustomer(id: string): Promise<void>;
  getCustomersByRoute(route: string): Promise<Customer[]>;
  getCustomersByWeekday(weekday: string, sellerId?: string): Promise<Customer[]>;
  getCustomersForDate(sellerId: string, date: Date): Promise<Customer[]>;
  
  // Product operations
  getProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  getProductByOmieCode(omieCode: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
  
  // Product review operations
  createProductReview(review: InsertProductReview): Promise<ProductReview>;
  getProductReviews(productId: string): Promise<ProductReview[]>;
  getAllProductReviews(): Promise<ProductReview[]>;
  updateProductReview(id: string, data: Partial<InsertProductReview>): Promise<ProductReview>;
  deleteProductReview(id: string): Promise<void>;
  
  // Sales card operations
  getSalesCards(sellerId?: string, filters?: { routeDay?: string; status?: string }): Promise<SalesCardWithRelations[]>;
  getSalesCard(id: string): Promise<SalesCardWithRelations | undefined>;
  createSalesCard(salesCard: InsertSalesCard): Promise<SalesCard>;
  updateSalesCard(id: string, salesCard: Partial<InsertSalesCard>): Promise<SalesCard>;
  deleteSalesCard(id: string): Promise<void>;
  deleteAllSalesCards(): Promise<number>;
  getSalesCardsByDate(date: Date, sellerId?: string): Promise<SalesCardWithRelations[]>;
  getOverdueSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]>;
  duplicateSalesCard(id: string, newDate: Date): Promise<SalesCard>;
  getOrCreatePermanentCard(customerId: string, sellerId: string): Promise<SalesCard>;
  getPermanentCardByCustomer(customerId: string): Promise<SalesCard | undefined>;
  
  // Order history operations
  createOrderHistory(order: InsertOrderHistory): Promise<OrderHistory>;
  getOrderHistoryByCard(salesCardId: string): Promise<OrderHistory[]>;
  getOrderHistoryById(id: string): Promise<OrderHistory | undefined>;
  updateOrderHistory(id: string, order: Partial<InsertOrderHistory>): Promise<OrderHistory>;
  deleteOrderHistory(id: string): Promise<void>;
  
  // Message template operations
  getMessageTemplates(): Promise<MessageTemplate[]>;
  getMessageTemplate(id: string): Promise<MessageTemplate | undefined>;
  createMessageTemplate(template: InsertMessageTemplate): Promise<MessageTemplate>;
  updateMessageTemplate(id: string, template: Partial<InsertMessageTemplate>): Promise<MessageTemplate>;
  deleteMessageTemplate(id: string): Promise<void>;
  
  // Message history operations
  getMessageHistory(customerId?: string): Promise<MessageHistory[]>;
  createMessageHistory(history: InsertMessageHistory): Promise<MessageHistory>;
  
  // Delivery operations
  updateSalesCardDeliveryStatus(id: string, data: any): Promise<SalesCard>;
  getSalesCardByTrackingCode(trackingCode: string): Promise<SalesCard | undefined>;
  getPendingDeliveries(): Promise<PendingDelivery[]>;
  createDeliveryHistory(data: any): Promise<any>;
  getDeliveryHistory(salesCardId: string): Promise<any[]>;
  getDeliveryDrivers(): Promise<any[]>;
  getActiveDeliveryDrivers(): Promise<any[]>;
  createDeliveryDriver(data: any): Promise<any>;
  updateDeliveryDriver(id: string, data: any): Promise<any>;
  updateDriverLocation(driverId: string, location: string): Promise<any>;
  getDeliveryStats(period: string): Promise<any>;
  getDeliveryMetrics(period: string): Promise<any>;
  getAllDeliveries(): Promise<any[]>;
  getDeliveryReport(period: string, startDate?: string, endDate?: string): Promise<any>;
  getDeliveryReportComparison(period: string): Promise<any>;
  getDeliveryDriverStats(): Promise<any>;
  
  // Delivery routes operations
  getDeliveryRoutes(filters?: { status?: string; routeDate?: Date; driverId?: string; savedOnly?: boolean }): Promise<any[]>;
  getDeliveryRoute(id: string): Promise<any | undefined>;
  createDeliveryRoute(route: any): Promise<any>;
  updateDeliveryRoute(id: string, route: any): Promise<any>;
  deleteDeliveryRoute(id: string): Promise<void>;
  createDeliveryRouteStop(stop: any): Promise<any>;
  getDeliveryRouteStops(routeId: string): Promise<any[]>;
  updateDeliveryRouteStop(id: string, stop: any): Promise<any>;
  countRoutesForDriverOnDate(driverId: string, date: Date): Promise<number>;
  saveRouteWithStops(route: any, stops: any[]): Promise<{ route: any; stops: any[] }>;
  updateBillingsStatus(billingIds: string[], newStage: string): Promise<void>;
  
  // Dashboard stats
  getDashboardStats(sellerId?: string): Promise<{
    todaySales: number;
    todayClients: number;
    overdueClients: number;
    conversionRate: number;
  }>;
  
  // Additional methods needed
  getSalesCardsByDayAndDate(sellerId: string, routeDay: string, startDate: Date, endDate: Date, limit?: number, offset?: number): Promise<SalesCardWithRelations[]>;
  getSalesCardsByDateRange(sellerId: string | undefined, startDate: Date, endDate: Date, limit?: number, offset?: number): Promise<SalesCardWithRelations[]>;
  generateNextSalesCard(parentCardId: string): Promise<SalesCard | null>;
  updateAllCustomerCardsConfig(currentCardId: string, configUpdates: Partial<InsertSalesCard>): Promise<number>;
  updateFutureCardsConfig(currentCardId: string, configUpdates: Partial<InsertSalesCard>): Promise<number>;
  closeCardAndScheduleNext(cardId: string, status: 'completed' | 'no_sale' | 'failed', updateData?: Partial<InsertSalesCard>): Promise<{ closedCard: SalesCard; nextCard: SalesCard | null }>;
  
  // Location operations
  getLocations(): Promise<Location[]>;
  getLocation(id: string): Promise<Location | undefined>;
  createLocation(location: InsertLocation): Promise<Location>;
  updateLocation(id: string, location: Partial<InsertLocation>): Promise<Location>;
  deleteLocation(id: string): Promise<void>;
  getLocationByCpfCnpj(cpfCnpj: string): Promise<Location | undefined>;
  bulkCreateLocations(locations: InsertLocation[]): Promise<Location[]>;
  updateCustomerCoordinatesFromLocations(): Promise<{ updated: number; matched: number; total: number }>;
  
  // Sales Goals operations
  getSalesGoals(sellerId?: string, month?: number, year?: number): Promise<SalesGoal[]>;
  getSalesGoal(id: string): Promise<SalesGoal | undefined>;
  getSalesGoalBySeller(sellerId: string, month: number, year: number): Promise<SalesGoal | undefined>;
  createSalesGoal(goal: InsertSalesGoal): Promise<SalesGoal>;
  updateSalesGoal(id: string, goal: Partial<InsertSalesGoal>): Promise<SalesGoal>;
  deleteSalesGoal(id: string): Promise<void>;
  
  // Sales Metrics operations
  getSalesMetrics(sellerId?: string, month?: number, year?: number): Promise<any>;
  
  // Billing operations
  getBillings(sellerId?: string): Promise<Billing[]>;
  getBilling(id: string): Promise<Billing | undefined>;
  getBillingByOmieId(omieInvoiceId: string): Promise<Billing | undefined>;
  getBillingByInvoiceNumber(invoiceNumber: string): Promise<Billing | undefined>;
  createBilling(billing: InsertBilling): Promise<Billing>;
  updateBilling(id: string, billing: Partial<InsertBilling>): Promise<Billing>;
  deleteBilling(id: string): Promise<void>;
  getBillingsWithFilters(filters: {
    sellerId?: string;
    startDate?: Date;
    endDate?: Date;
    customerDocument?: string;
    invoiceNumber?: string;
    cfop?: string;
    invoiceStage?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ billings: Billing[]; total: number }>;
  getUniqueSellers(): Promise<Array<{seller_id: string; seller_name: string}>>;
  getBillingsStats(filters: {
    sellerId?: string;
    startDate?: Date;
    endDate?: Date;
    customerDocument?: string;
    invoiceNumber?: string;
    cfop?: string;
    invoiceStage?: string;
  }): Promise<{
    totalInvoices: number;
    totalValue: number;
    averageValue: number;
    paymentMethods: Record<string, { count: number; total: number }>;
  }>;
  upsertBilling(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<Billing>;
  saveBillingIfValid(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<{
    success: boolean;
    billing?: Billing;
    reason?: string;
    action?: 'created' | 'updated' | 'skipped';
  }>;

  // Overdue debts operations
  getOverdueDebts(): Promise<any[]>;
  getOverdueDebtByDocument(document: string): Promise<any | undefined>;
  syncOverdueDebts(debts: any[]): Promise<void>;
  clearOverdueDebts(): Promise<void>;

  // Exported reports operations
  saveExportedReport(reportType: string, fileName: string, fileData: string, metadata?: any, createdBy?: string): Promise<any>;
  getLatestExportedReport(reportType: string): Promise<any | undefined>;
  deleteOldReports(reportType: string): Promise<void>;
  
  // Billing stage operations
  getAllBillingsWithOrderId(): Promise<any[]>;

  // Sync status operations
  getSyncStatus(syncType: string): Promise<SyncStatus | undefined>;
  getAllSyncStatus(): Promise<SyncStatus[]>;
  upsertSyncStatus(syncStatus: InsertSyncStatus): Promise<SyncStatus>;
  updateSyncStatus(syncType: string, data: { 
    status: 'success' | 'error' | 'in_progress'; 
    message?: string; 
    recordsProcessed?: number;
  }): Promise<SyncStatus>;
  
  // Lead operations
  getLeads(): Promise<Lead[]>;
  getLead(id: string): Promise<Lead | undefined>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLead(id: string, lead: Partial<InsertLead>): Promise<Lead>;
  deleteLead(id: string): Promise<void>;
  
  // Chat Agents operations
  getChatAgents(): Promise<ChatAgent[]>;
  createChatAgent(agent: InsertChatAgent): Promise<ChatAgent>;
  deleteChatAgent(id: string): Promise<void>;
  updateChatAgentStatus(id: string, status: string): Promise<ChatAgent>;
  
  // Chat Customers operations
  getChatCustomers(): Promise<ChatCustomer[]>;
  getChatCustomer(id: string): Promise<ChatCustomer | undefined>;
  createChatCustomer(customer: InsertChatCustomer): Promise<ChatCustomer>;
  updateChatCustomer(id: string, customer: UpdateChatCustomer): Promise<ChatCustomer>;
  
  // Chat Conversations operations
  getChatConversations(): Promise<ChatConversation[]>;
  getChatConversation(id: string): Promise<ChatConversation | undefined>;
  createChatConversation(conversation: InsertChatConversation): Promise<ChatConversation>;
  updateChatConversation(id: string, conversation: Partial<InsertChatConversation>): Promise<ChatConversation>;
  
  // Chat Messages operations
  getChatMessages(conversationId: string): Promise<ChatMessage[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  
  // Chat Products operations
  getChatProducts(): Promise<ChatProduct[]>;
  createChatProduct(product: InsertChatProduct): Promise<ChatProduct>;
  updateChatProduct(id: string, product: Partial<InsertChatProduct>): Promise<ChatProduct>;
  
  // Chat Quick Messages operations
  getChatQuickMessages(): Promise<ChatQuickMessage[]>;
  createChatQuickMessage(message: InsertChatQuickMessage): Promise<ChatQuickMessage>;
  
  // Chat Orders operations
  getChatOrders(): Promise<ChatOrder[]>;
  createChatOrder(order: InsertChatOrder): Promise<ChatOrder>;
  updateChatOrder(id: string, order: Partial<InsertChatOrder>): Promise<ChatOrder>;
  
  // Chat Deliveries operations
  getChatDeliveries(): Promise<ChatDelivery[]>;
  createChatDelivery(delivery: InsertChatDelivery): Promise<ChatDelivery>;
  updateChatDelivery(id: string, delivery: Partial<InsertChatDelivery>): Promise<ChatDelivery>;
  
  // Chat Reports operations
  createChatReport(report: InsertChatReport): Promise<ChatReport>;
  getChatReports(): Promise<ChatReport[]>;
  
  // Chat Audit Log operations
  createChatAuditLog(log: InsertChatAuditLog): Promise<ChatAuditLog>;
  
  // WhatsApp Analysis operations
  createWhatsappAnalysis(analysis: InsertWhatsappConversationAnalysis): Promise<WhatsappConversationAnalysis>;
  getWhatsappAnalyses(): Promise<WhatsappConversationAnalysis[]>;
  
  // Knowledge Base operations
  createKnowledgeBase(kb: InsertKnowledgeBase): Promise<KnowledgeBase>;
  getKnowledgeBase(): Promise<KnowledgeBase[]>;
}

export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async getUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async createUser(userData: UpsertUser): Promise<User> {
    const [user] = await db.insert(users).values(userData).returning();
    return user;
  }

  async updateUser(id: string, userData: Partial<UpsertUser>): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ ...userData, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateUserPassword(id: string, hashedPassword: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    try {
      // First attempt: try to insert the user
      const [user] = await db
        .insert(users)
        .values(userData)
        .onConflictDoUpdate({
          target: users.email,
          set: {
            ...userData,
            updatedAt: new Date(),
          },
        })
        .returning();
      return user;
    } catch (error: any) {
      // Handle any remaining conflicts (e.g., if both id and email conflict in different ways)
      console.error('Error in upsertUser:', error);
      
      // Try to find existing user by email and update it
      const existingUser = await this.getUserByEmail(userData.email!);
      if (existingUser) {
        return await this.updateUser(existingUser.id, userData);
      }
      
      // If no existing user found, try to find by id and update
      if (userData.id) {
        const existingUserById = await this.getUser(userData.id);
        if (existingUserById) {
          return await this.updateUser(userData.id, userData);
        }
      }
      
      // If all else fails, throw the original error
      throw error;
    }
  }

  // Route operations
  async getRoutes(): Promise<Route[]> {
    return await db.select().from(routes).where(eq(routes.isActive, true));
  }

  async getRoute(id: string): Promise<Route | undefined> {
    const [route] = await db.select().from(routes).where(eq(routes.id, id));
    return route;
  }

  async getRouteByName(name: string): Promise<Route | undefined> {
    const [route] = await db.select().from(routes).where(eq(routes.name, name));
    return route;
  }

  async createRoute(routeData: InsertRoute): Promise<Route> {
    const [route] = await db.insert(routes).values(routeData).returning();
    return route;
  }

  async updateRoute(id: string, routeData: Partial<InsertRoute>): Promise<Route> {
    const [route] = await db
      .update(routes)
      .set({ ...routeData, updatedAt: new Date() })
      .where(eq(routes.id, id))
      .returning();
    return route;
  }

  async deleteRoute(id: string): Promise<void> {
    await db.update(routes).set({ isActive: false }).where(eq(routes.id, id));
  }

  async getRoutesBySellerId(sellerId: string): Promise<Route[]> {
    return await db
      .select()
      .from(routes)
      .where(and(eq(routes.sellerId, sellerId), eq(routes.isActive, true)));
  }

  // Customer operations
  async getCustomers(sellerId?: string): Promise<CustomerWithSeller[]> {
    const baseQuery = db
      .select()
      .from(customers)
      .leftJoin(users, eq(customers.sellerId, users.id));
    
    const whereConditions = [eq(customers.omieStatus, 'ativo')];
    if (sellerId) {
      whereConditions.push(eq(customers.sellerId, sellerId));
    }
    
    const query = baseQuery.where(and(...whereConditions));
    
    const result = await query;
    
    if (result.length === 0) {
      return [];
    }
    
    // Extrair IDs dos clientes
    const customerIds = result.map(row => row.customers!.id);
    
    // Buscar positivações do mês atual através dos faturamentos (billings)
    const currentMonthStart = new Date();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);
    
    const currentMonthEnd = new Date();
    currentMonthEnd.setMonth(currentMonthEnd.getMonth() + 1);
    currentMonthEnd.setDate(0);
    currentMonthEnd.setHours(23, 59, 59, 999);
    
    // Buscar códigos Omie dos clientes (filtrar nulls e garantir tipo string[])
    const customerOmieCodes = result
      .map(row => row.customers?.omieClientCode)
      .filter((code): code is string => !!code);
    
    let positivationMap = new Map();
    
    if (customerOmieCodes.length > 0) {
      const positivations = await db
        .select({
          omieCustomerCode: billings.omieCustomerCode,
          count: sql<number>`COUNT(*)`.mapWith(Number),
        })
        .from(billings)
        .where(
          and(
            inArray(billings.omieCustomerCode, customerOmieCodes),
            isNotNull(billings.invoiceDate),
            gte(billings.invoiceDate, currentMonthStart),
            sql`${billings.invoiceDate} <= ${currentMonthEnd}`,
            eq(billings.isCancelled, false),
            sql`${billings.totalValue} > 0`
          )
        )
        .groupBy(billings.omieCustomerCode);
      
      // Criar mapa: omieCustomerCode -> true/false
      const omieCodeMap = new Map(
        positivations.map(p => [p.omieCustomerCode, p.count > 0])
      );
      
      // Converter para customerId -> true/false
      positivationMap = new Map(
        result.map(row => [
          row.customers!.id,
          row.customers!.omieClientCode ? omieCodeMap.get(row.customers!.omieClientCode) || false : false
        ])
      );
    }
    
    // Buscar última venda real de todos os clientes através dos faturamentos (billings)
    let lastActivityMap = new Map<string, Date>();
    
    if (customerOmieCodes.length > 0) {
      const lastBillings = await db
        .select()
        .from(billings)
        .where(
          and(
            inArray(billings.omieCustomerCode, customerOmieCodes),
            isNotNull(billings.invoiceDate),
            eq(billings.isCancelled, false),
            sql`${billings.totalValue} > 0`
          )
        )
        .orderBy(billings.omieCustomerCode, desc(billings.invoiceDate));
      
      // Agrupar por omieCustomerCode e pegar a primeira (mais recente)
      const omieLastActivityMap = new Map<string, Date>();
      for (const billing of lastBillings) {
        if (billing.omieCustomerCode && billing.invoiceDate && !omieLastActivityMap.has(billing.omieCustomerCode)) {
          omieLastActivityMap.set(billing.omieCustomerCode, billing.invoiceDate);
        }
      }
      
      // Converter de omieCustomerCode para customerId
      lastActivityMap = new Map(
        result
          .filter(row => row.customers?.omieClientCode)
          .map(row => [
            row.customers!.id,
            omieLastActivityMap.get(row.customers!.omieClientCode!) || null
          ])
          .filter((entry): entry is [string, Date] => entry[1] !== null)
      );
    }
    
    // Montar resultado final
    const customersWithExtendedInfo = result.map((row) => {
      const customerId = row.customers!.id;
      const lastActivityDate = lastActivityMap.get(customerId);
      
      return {
        ...row.customers!,
        seller: row.users!,
        isPositivatedThisMonth: positivationMap.get(customerId) || false,
        lastActivityStatus: 'none' as const,
        lastActivityDate: lastActivityDate?.toISOString() || null,
      };
    });
    
    return customersWithExtendedInfo;
  }

  async getAllCustomers(): Promise<Customer[]> {
    return await db.select().from(customers);
  }

  async getCustomer(id: string): Promise<CustomerWithSeller | undefined> {
    const [result] = await db
      .select()
      .from(customers)
      .leftJoin(users, eq(customers.sellerId, users.id))
      .where(eq(customers.id, id));
    
    if (!result) return undefined;
    
    return {
      ...result.customers,
      seller: result.users!,
    };
  }

  async getCustomerByCpf(cpf: string): Promise<Customer | undefined> {
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.cpf, cpf));
    
    return customer;
  }

  async getCustomerByCnpj(cnpj: string): Promise<Customer | undefined> {
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.cnpj, cnpj));
    
    return customer;
  }

  async getCustomerByDocument(document: string): Promise<Customer | undefined> {
    // Busca tanto em CPF quanto em CNPJ
    const [customer] = await db
      .select()
      .from(customers)
      .where(
        or(
          eq(customers.cpf, document),
          eq(customers.cnpj, document)
        )
      );
    
    return customer;
  }

  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const [newCustomer] = await db.insert(customers).values(customer as any).returning();
    return newCustomer;
  }

  async updateCustomer(id: string, customer: Partial<InsertCustomer>): Promise<Customer> {
    const [updatedCustomer] = await db
      .update(customers)
      .set({ ...customer, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return updatedCustomer;
  }

  async bulkUpdateAllCustomersTimeSlots(): Promise<{ updated: number; total: number }> {
    // Horários padrão: segunda-sexta 08:00-18:00
    const weekdaySlots = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    // Dias de recebimento: segunda a sexta
    const receivingDays = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
    
    // Buscar todos os clientes
    const allCustomers = await db.select().from(customers);
    const total = allCustomers.length;
    
    // Atualizar todos com os novos horários e dias de recebimento
    const result = await db
      .update(customers)
      .set({
        deliveryTimeSlots: weekdaySlots, // Seg-Sex 08:00-18:00
        deliverySaturdayTimeSlots: [], // Vazio para sábado
        receivingWeekdays: receivingDays, // Segunda-Sexta
        updatedAt: new Date()
      })
      .returning({ id: customers.id });
    
    const updated = result.length;
    console.log(`✅ [BULK-UPDATE-TIME-SLOTS] Atualizados ${updated} de ${total} clientes com:`);
    console.log(`   - Horários (Seg-Sex): 08:00 a 18:00 (${weekdaySlots.length} slots)`);
    console.log(`   - Dias de recebimento: ${receivingDays.join(', ')}`);
    
    return { updated, total };
  }

  async inactivateCustomer(customerId: string, currentCardId: string): Promise<{ customer: Customer; deletedCards: number }> {
    // Get customer data first
    const [customerData] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    
    if (!customerData) {
      throw new Error('Cliente não encontrado');
    }
    
    // Note: Omie API does not support inactivating clients programmatically
    // Users must inactivate clients manually in the Omie ERP interface
    if (customerData.omieClientCode) {
      console.log(`ℹ️ Cliente possui código Omie (${customerData.omieClientCode}). Inativação no Omie deve ser feita manualmente no ERP.`);
    }
    
    // 1. Update customer: set isActive = false and inactivatedAt = now
    const [inactivatedCustomer] = await db
      .update(customers)
      .set({ 
        isActive: false, 
        inactivatedAt: new Date(),
        updatedAt: new Date() 
      })
      .where(eq(customers.id, customerId))
      .returning();
    
    // 2. Delete all future pending sales cards for this customer, except the current one
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const result = await db
      .delete(salesCards)
      .where(
        and(
          eq(salesCards.customerId, customerId),
          ne(salesCards.id, currentCardId),
          or(
            eq(salesCards.status, 'pending'),
            eq(salesCards.status, 'in_progress')
          ),
          gte(salesCards.scheduledDate, today)
        )
      )
      .returning();
    
    return {
      customer: inactivatedCustomer,
      deletedCards: result.length
    };
  }

  async deleteCustomer(id: string): Promise<void> {
    await db.update(customers).set({ omieStatus: 'inativo' }).where(eq(customers.id, id));
  }

  async getCustomersByRoute(route: string): Promise<Customer[]> {
    return await db
      .select()
      .from(customers)
      .where(and(eq(customers.route, route), eq(customers.omieStatus, 'ativo')));
  }

  async getCustomersByWeekday(weekday: string, sellerId?: string): Promise<Customer[]> {
    let whereConditions = and(
      eq(customers.omieStatus, 'ativo'),
      sql`${customers.weekdays} LIKE ${`%${weekday}%`}`
    );
    
    if (sellerId) {
      whereConditions = and(
        eq(customers.omieStatus, 'ativo'),
        eq(customers.sellerId, sellerId),
        sql`${customers.weekdays} LIKE ${`%${weekday}%`}`
      );
    }
    
    return await db
      .select()
      .from(customers)
      .where(whereConditions);
  }

  async getCustomersForDate(sellerId: string, date: Date): Promise<Customer[]> {
    const BRAZIL_TZ = 'America/Sao_Paulo';
    
    // Construir data BRT corretamente (sem deslocamento)
    // Se date é "2025-11-12T00:00:00.000Z", queremos 2025-11-12 00:00 em BRT
    const dateStr = date.toISOString().split('T')[0]; // "2025-11-12"
    // fromZonedTime converte "2025-11-12 00:00:00" BRT → "2025-11-12T03:00:00.000Z" UTC
    const targetDateBRT = fromZonedTime(new Date(`${dateStr}T00:00:00`), BRAZIL_TZ);
    
    // Buscar clientes ativos do vendedor com coordenadas
    const activeCustomers = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.sellerId, sellerId),
          eq(customers.omieStatus, 'ativo'),
          isNotNull(customers.latitude),
          isNotNull(customers.longitude),
          isNotNull(customers.weekdays),
          isNotNull(customers.visitPeriodicity)
        )
      );
    
    console.log(`📅 getCustomersForDate: Encontrados ${activeCustomers.length} clientes ativos com coordenadas para vendedor ${sellerId}`);
    
    // Buscar última visita completada de cada cliente
    const customerIds = activeCustomers.map(c => c.id);
    
    if (customerIds.length === 0) {
      return [];
    }
    
    // Query para pegar última visita de cada cliente usando salesCards
    // Usa completedDate se disponível, senão scheduledDate (para compatibilidade)
    const lastVisits = await db
      .select({
        customerId: salesCards.customerId,
        lastCompletedDate: sql<Date>`MAX(COALESCE(${salesCards.completedDate}, ${salesCards.scheduledDate}))`.as('last_completed_date')
      })
      .from(salesCards)
      .where(
        and(
          inArray(salesCards.customerId, customerIds),
          or(
            eq(salesCards.status, 'completed'),
            eq(salesCards.status, 'invoiced')
          )
        )
      )
      .groupBy(salesCards.customerId);
    
    const lastVisitMap = new Map(
      lastVisits.map(v => [v.customerId, v.lastCompletedDate])
    );
    
    console.log(`📊 getCustomersForDate: Encontradas ${lastVisits.length} últimas visitas completadas`);
    
    // Filtrar clientes que devem ser visitados na data alvo
    const customersToVisit: Customer[] = [];
    
    let clientsWithoutServiceStartDate = 0;
    
    for (const customer of activeCustomers) {
      try {
        // Pegar última visita (se existir)
        const lastCompletedDate = lastVisitMap.get(customer.id);
        
        // Normalizar weekdays: pode vir como string JSON ou array
        let weekdaysArray: string[] = [];
        if (customer.weekdays) {
          if (typeof customer.weekdays === 'string') {
            try {
              weekdaysArray = JSON.parse(customer.weekdays);
            } catch {
              console.warn(`⚠️ weekdays inválido para cliente ${customer.fantasyName}: ${customer.weekdays}`);
              continue; // Pular cliente com dados inválidos
            }
          } else if (Array.isArray(customer.weekdays)) {
            weekdaysArray = customer.weekdays;
          }
        }
        
        if (weekdaysArray.length === 0) {
          console.warn(`⚠️ Cliente ${customer.fantasyName} sem dias da semana configurados`);
          continue;
        }
        
        // ✅ CORREÇÃO (Nov 13, 2025): NÃO usar serviceStartDate como lastCompletedDate
        // serviceStartDate é data de início do contrato, NÃO última visita
        // Filtrar apenas clientes cuja data de início já passou
        if (customer.serviceStartDate) {
          const serviceStart = new Date(customer.serviceStartDate);
          serviceStart.setHours(0, 0, 0, 0);
          const targetNormalized = new Date(targetDateBRT);
          targetNormalized.setHours(0, 0, 0, 0);
          
          // Se a rota é ANTES do início do serviço, pular cliente
          if (targetNormalized < serviceStart) {
            continue; // Contrato ainda não iniciou
          }
        } else {
          // Log clientes sem serviceStartDate
          clientsWithoutServiceStartDate++;
        }
        
        // Calcular próxima visita - lastCompletedDate APENAS de visitas reais
        // Se não há visitas anteriores, calculateNextVisitDate retorna o primeiro dia válido
        const scheduleResult = calculateNextVisitDate({
          weekdays: weekdaysArray,
          periodicity: customer.visitPeriodicity || 'semanal',
          lastCompletedDate: lastCompletedDate, // undefined se não há visitas
          referenceDate: targetDateBRT
        });
        
        // Normalizar ambas as datas para comparação simples (YYYY-MM-DD)
        // Ignora timezone completamente, compara apenas a data calendário
        const nextDateStr = scheduleResult.nextDate.toISOString().split('T')[0];
        const targetDateStr = targetDateBRT.toISOString().split('T')[0];
        
        // Incluir visitas atrasadas e da data alvo (nextVisitDate <= targetDate)
        if (nextDateStr <= targetDateStr) {
          customersToVisit.push(customer);
        }
      } catch (error: any) {
        console.warn(`⚠️ Erro ao calcular próxima visita para cliente ${customer.fantasyName}: ${error.message}`);
      }
    }
    
    if (clientsWithoutServiceStartDate > 0) {
      console.warn(`⚠️ ${clientsWithoutServiceStartDate} clientes sem serviceStartDate (usando createdAt ou data atual como fallback)`);
    }
    
    console.log(`✅ getCustomersForDate: ${customersToVisit.length} clientes devem ser visitados em ${targetDateBRT.toLocaleDateString('pt-BR')}`);
    
    return customersToVisit;
  }

  // Product operations
  async getProducts(): Promise<Product[]> {
    return await db.select().from(products).where(eq(products.isActive, true));
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async getProductByOmieCode(omieCode: string): Promise<Product | undefined> {
    // Busca case-insensitive usando UPPER
    const [product] = await db
      .select()
      .from(products)
      .where(sql`UPPER(${products.omieCode}) = UPPER(${omieCode})`);
    return product;
  }

  async createProduct(product: InsertProduct): Promise<Product> {
    const [newProduct] = await db.insert(products).values(product).returning();
    return newProduct;
  }

  async updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product> {
    const [updatedProduct] = await db
      .update(products)
      .set({ ...product, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return updatedProduct;
  }

  async deleteProduct(id: string): Promise<void> {
    await db.update(products).set({ isActive: false }).where(eq(products.id, id));
  }

  // Product review operations
  async createProductReview(review: InsertProductReview): Promise<ProductReview> {
    const [newReview] = await db.insert(productReviews).values(review).returning();
    return newReview;
  }

  async getProductReviews(productId: string): Promise<ProductReview[]> {
    return db.select().from(productReviews).where(eq(productReviews.productId, productId));
  }

  async getAllProductReviews(): Promise<ProductReview[]> {
    return db.select().from(productReviews);
  }

  async updateProductReview(id: string, data: Partial<InsertProductReview>): Promise<ProductReview> {
    const [updatedReview] = await db
      .update(productReviews)
      .set(data)
      .where(eq(productReviews.id, id))
      .returning();
    return updatedReview;
  }

  async deleteProductReview(id: string): Promise<void> {
    await db.delete(productReviews).where(eq(productReviews.id, id));
  }

  // Sales card operations
  async getSalesCards(sellerId?: string, filters?: { routeDay?: string; status?: string }): Promise<SalesCardWithRelations[]> {
    let query = db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .orderBy(desc(salesCards.scheduledDate));
    
    let conditions = [];
    
    if (sellerId) {
      conditions.push(eq(salesCards.sellerId, sellerId));
    }
    
    if (filters?.routeDay) {
      conditions.push(sql`${salesCards.routeDay} = ${filters.routeDay}`);
    }
    
    if (filters?.status) {
      conditions.push(sql`${salesCards.status} = ${filters.status}`);
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    const result = await query;
    return result.map(row => ({
      ...row.sales_cards,
      customer: row.customers!,
      seller: row.users!,
    }));
  }

  async getSalesCard(id: string): Promise<SalesCardWithRelations | undefined> {
    const [result] = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(eq(salesCards.id, id));
    
    if (!result) return undefined;
    
    return {
      ...result.sales_cards,
      customer: result.customers!,
      seller: result.users!,
    };
  }

  async createSalesCard(salesCard: InsertSalesCard): Promise<SalesCard> {
    // Derivar routeDay do scheduledDate se não for fornecido
    let processedSalesCard = { ...salesCard };
    
    if (!processedSalesCard.routeDay && processedSalesCard.scheduledDate) {
      const scheduledDate = new Date(processedSalesCard.scheduledDate);
      const dayOfWeek = scheduledDate.getDay();
      const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
      processedSalesCard.routeDay = weekdayNames[dayOfWeek];
    }
    
    // VALIDAÇÃO CRÍTICA 1: Garantir que seller_id do card corresponda ao seller_id do cliente
    if (processedSalesCard.customerId) {
      const customer = await this.getCustomer(processedSalesCard.customerId);
      
      if (customer && customer.sellerId) {
        // Se o seller_id fornecido é diferente do seller_id do cliente, usar o do cliente
        if (processedSalesCard.sellerId !== customer.sellerId) {
          console.warn(`⚠️ [createSalesCard] Seller_id fornecido (${processedSalesCard.sellerId}) diferente do seller_id do cliente (${customer.sellerId}). Usando seller_id do cliente.`);
          processedSalesCard.sellerId = customer.sellerId;
        }
      }
    }
    
    // VALIDAÇÃO CRÍTICA 2: Log de informação sobre weekdays (validação movida para o handler)
    // EXCEÇÃO: Pular validação para:
    //  - 'manual_route_addition': adições manuais à rota
    //  - 'rota_do_dia': visualização de cards na rota do dia (cliente já foi alocado)
    const skipWeekdayValidation = processedSalesCard.source === 'manual_route_addition' || 
                                  processedSalesCard.source === 'rota_do_dia';
    
    if (processedSalesCard.customerId && processedSalesCard.scheduledDate && !skipWeekdayValidation) {
      const customer = await this.getCustomer(processedSalesCard.customerId);
      
      if (customer && customer.weekdays) {
        let customerWeekdays: string[] = [];
        try {
          customerWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays || [];
        } catch (e) {
          console.warn(`⚠️ Cliente ${customer.id} tem weekdays inválido, pulando validação`);
          customerWeekdays = []; // Garantir que seja array vazio
        }
        
        if (customerWeekdays.length > 0) {
          const scheduledDate = new Date(processedSalesCard.scheduledDate);
          const scheduledDayOfWeek = scheduledDate.getDay();
          const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
          const scheduledDayName = weekdayNames[scheduledDayOfWeek];
          
          // Log de informação (validação feita no handler)
          console.log(`ℹ️ Card agendado para ${scheduledDayName}, cliente atende em: ${customerWeekdays.join(', ')}`);
        }
      }
    } else if (skipWeekdayValidation) {
      console.log(`ℹ️ [manual_route_addition] Pulando validação de weekdays - visita manual`);
    }
    
    // Sempre definir attendanceStartDate como data atual de criação
    if (!processedSalesCard.attendanceStartDate) {
      processedSalesCard.attendanceStartDate = new Date();
    }
    
    const [newSalesCard] = await db.insert(salesCards).values(processedSalesCard as any).returning();
    return newSalesCard;
  }

  async updateSalesCard(id: string, salesCard: Partial<InsertSalesCard>): Promise<SalesCard> {
    const [updatedSalesCard] = await db
      .update(salesCards)
      .set({ ...salesCard as any, updatedAt: new Date() })
      .where(eq(salesCards.id, id))
      .returning();
    return updatedSalesCard;
  }

  // Atualizar configurações de todos os cards futuros do mesmo cliente
  async updateAllCustomerCardsConfig(currentCardId: string, configUpdates: Partial<InsertSalesCard>): Promise<number> {
    try {
      // 1. Buscar o card atual para pegar o customerId
      const currentCard = await this.getSalesCard(currentCardId);
      if (!currentCard) {
        console.log('Card não encontrado:', currentCardId);
        return 0;
      }

      // 2. Extrair apenas os campos de configuração que devem ser replicados
      const replicableFields: Partial<InsertSalesCard> = {};
      
      const configFieldsToReplicate = [
        'routeDay',
        'recurrenceType', 
        'paymentMethod',
        'deliveryWeekdays',
        'deliveryTimeSlots',
        'deliverySaturdayTimeSlots',
        'boletoDays',
        'exclusiveVehicle',
        'vehicleTypes',
        'customerLatitude',
        'customerLongitude'
      ];

      for (const field of configFieldsToReplicate) {
        if (configUpdates[field as keyof InsertSalesCard] !== undefined) {
          (replicableFields as any)[field] = configUpdates[field as keyof InsertSalesCard];
        }
      }

      // 3. Se não há campos de configuração para replicar, retornar 0
      if (Object.keys(replicableFields).length === 0) {
        console.log('Nenhum campo de configuração para replicar');
        return 0;
      }

      console.log('📋 [PROPAGAÇÃO ADMIN] Replicando configurações para TODOS os cards do cliente:', currentCard.customerId);
      console.log('   Campos a replicar:', Object.keys(replicableFields));

      // 4. Atualizar TODOS os cards do mesmo cliente (futuros E passados)
      // EXCETO: cards finalizados (completed, no_sale, failed) e o próprio card atual
      const result = await db
        .update(salesCards)
        .set({ 
          ...replicableFields as any, 
          updatedAt: new Date() 
        })
        .where(
          and(
            eq(salesCards.customerId, currentCard.customerId),
            inArray(salesCards.status, ['scheduled', 'pending', 'in_progress']), // Cards não finalizados
            ne(salesCards.id, currentCardId) // Excluir o próprio card
          )
        )
        .returning({ id: salesCards.id });

      const updatedCount = result.length;
      console.log(`✅ [PROPAGAÇÃO ADMIN] ${updatedCount} card(s) atualizado(s) com as novas configurações`);
      
      if (updatedCount > 0) {
        // Log detalhado dos cards atualizados
        const updatedIds = result.map(r => r.id).slice(0, 5); // Primeiros 5
        console.log(`   IDs atualizados (amostra): ${updatedIds.join(', ')}${result.length > 5 ? '...' : ''}`);
      }

      // 5. Se routeDay foi alterado, recalcular scheduledDate para todos os cards afetados
      if (replicableFields.routeDay !== undefined) {
        console.log('📅 [REALOCAÇÃO] Detectada mudança de routeDay, recalculando datas dos cards...');
        
        // Buscar todos os cards afetados para recalcular suas datas
        // INCLUINDO o card atual para garantir que ele também seja realocado
        const affectedCards = await db
          .select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, currentCard.customerId),
              inArray(salesCards.status, ['scheduled', 'pending', 'in_progress'])
              // REMOVIDO: ne(salesCards.id, currentCardId) - card atual DEVE ser incluído
            )
          );

        let reallocatedCount = 0;
        
        for (const card of affectedCards) {
          try {
            // Extrair horário original do card
            const originalDate = new Date(card.scheduledDate);
            const originalHours = originalDate.getHours();
            const originalMinutes = originalDate.getMinutes();

            // Normalizar datas para início do dia (00:00:00) para comparação
            const originalDateStart = new Date(originalDate);
            originalDateStart.setHours(0, 0, 0, 0);
            
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            // Para cards atrasados, usar data atual como referência mínima
            // Para cards futuros, manter a data original
            const referenceDate = originalDateStart < todayStart ? todayStart : originalDateStart;

            // Calcular próxima data para o novo routeDay
            const { nextDate } = calculateNextVisitDate({
              weekdays: [replicableFields.routeDay as string],
              periodicity: (card.recurrenceType || 'semanal') as 'semanal' | 'quinzenal' | 'mensal' | 'bimestral',
              referenceDate: referenceDate, // Usar max(originalDate, now) como referência
            });

            // Preservar horário original
            nextDate.setHours(originalHours, originalMinutes, 0, 0);

            // Verificação final: garantir que a nova data está no futuro
            // Se ainda está no passado (ex: hoje mas horário já passou), avançar para próximo dia válido
            const nowFinal = new Date();
            if (nextDate <= nowFinal) {
              console.log(`   ⚠️ Card ${card.id}: Data calculada (${nextDate.toISOString()}) está no passado, avançando para próximo ciclo...`);
              
              // Avançar um dia e calcular novamente
              const tomorrowStart = new Date(todayStart);
              tomorrowStart.setDate(todayStart.getDate() + 1);
              
              const { nextDate: futureDate } = calculateNextVisitDate({
                weekdays: [replicableFields.routeDay as string],
                periodicity: (card.recurrenceType || 'semanal') as 'semanal' | 'quinzenal' | 'mensal' | 'bimestral',
                referenceDate: tomorrowStart, // Partir de amanhã
              });
              
              futureDate.setHours(originalHours, originalMinutes, 0, 0);
              nextDate.setTime(futureDate.getTime()); // Copiar nova data
            }

            // Atualizar scheduledDate do card
            await db
              .update(salesCards)
              .set({ 
                scheduledDate: nextDate,
                updatedAt: new Date()
              })
              .where(eq(salesCards.id, card.id));

            reallocatedCount++;
            
            console.log(`   ✅ Card ${card.id} realocado: ${originalDate.toISOString().split('T')[0]} → ${nextDate.toISOString().split('T')[0]}`);
          } catch (error) {
            console.error(`   ❌ Erro ao realocar card ${card.id}:`, error);
          }
        }

        console.log(`✅ [REALOCAÇÃO] ${reallocatedCount} card(s) tiveram suas datas recalculadas`);
      }

      return updatedCount;
    } catch (error) {
      console.error('❌ Erro ao replicar configurações para todos os cards:', error);
      return 0;
    }
  }

  async updateFutureCardsConfig(currentCardId: string, configUpdates: Partial<InsertSalesCard>): Promise<number> {
    try {
      // 1. Buscar o card atual para pegar o customerId
      const currentCard = await this.getSalesCard(currentCardId);
      if (!currentCard) {
        console.log('Card não encontrado:', currentCardId);
        return 0;
      }

      // 2. Extrair apenas os campos de configuração que devem ser replicados
      const replicableFields: Partial<InsertSalesCard> = {};
      
      const configFieldsToReplicate = [
        'routeDay',
        'recurrenceType', 
        'paymentMethod',
        'deliveryWeekdays',
        'deliveryTimeSlots',
        'deliverySaturdayTimeSlots',
        'boletoDays',
        'exclusiveVehicle',
        'vehicleTypes',
        'customerLatitude',
        'customerLongitude'
      ];

      for (const field of configFieldsToReplicate) {
        if (configUpdates[field as keyof InsertSalesCard] !== undefined) {
          (replicableFields as any)[field] = configUpdates[field as keyof InsertSalesCard];
        }
      }

      // 3. Se não há campos de configuração para replicar, retornar 0
      if (Object.keys(replicableFields).length === 0) {
        console.log('Nenhum campo de configuração para replicar');
        return 0;
      }

      console.log('📋 Replicando configurações para cards futuros do cliente:', currentCard.customerId);
      console.log('Campos a replicar:', Object.keys(replicableFields));

      // 4. Atualizar todos os cards futuros (pending) do mesmo cliente
      const result = await db
        .update(salesCards)
        .set({ 
          ...replicableFields as any, 
          updatedAt: new Date() 
        })
        .where(
          and(
            eq(salesCards.customerId, currentCard.customerId),
            eq(salesCards.status, 'pending'),
            gt(salesCards.scheduledDate, currentCard.scheduledDate), // apenas cards com data futura
            ne(salesCards.id, currentCardId) // excluir o próprio card
          )
        )
        .returning({ id: salesCards.id });

      const updatedCount = result.length;
      console.log(`✅ ${updatedCount} cards futuros atualizados com as novas configurações`);
      
      // 5. Se routeDay foi alterado, recalcular scheduledDate para todos os cards afetados
      if (replicableFields.routeDay !== undefined) {
        console.log('📅 [REALOCAÇÃO] Detectada mudança de routeDay, recalculando datas dos cards futuros...');
        
        // Buscar todos os cards afetados para recalcular suas datas
        // INCLUINDO o card atual (vendedores só realocam card atual + futuros)
        const affectedCards = await db
          .select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, currentCard.customerId),
              eq(salesCards.status, 'pending'),
              or(
                eq(salesCards.id, currentCardId), // Incluir card atual
                gt(salesCards.scheduledDate, currentCard.scheduledDate) // Ou cards futuros
              )
            )
          );

        let reallocatedCount = 0;
        
        for (const card of affectedCards) {
          try {
            // Extrair horário original do card
            const originalDate = new Date(card.scheduledDate);
            const originalHours = originalDate.getHours();
            const originalMinutes = originalDate.getMinutes();

            // Normalizar datas para início do dia (00:00:00) para comparação
            const originalDateStart = new Date(originalDate);
            originalDateStart.setHours(0, 0, 0, 0);
            
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            // Para cards atrasados, usar data atual como referência mínima
            // Para cards futuros, manter a data original
            const referenceDate = originalDateStart < todayStart ? todayStart : originalDateStart;

            // Calcular próxima data para o novo routeDay
            const { nextDate } = calculateNextVisitDate({
              weekdays: [replicableFields.routeDay as string],
              periodicity: (card.recurrenceType || 'semanal') as 'semanal' | 'quinzenal' | 'mensal' | 'bimestral',
              referenceDate: referenceDate, // Usar max(originalDate, now) como referência
            });

            // Preservar horário original
            nextDate.setHours(originalHours, originalMinutes, 0, 0);

            // Verificação final: garantir que a nova data está no futuro
            // Se ainda está no passado (ex: hoje mas horário já passou), avançar para próximo dia válido
            const nowFinal = new Date();
            if (nextDate <= nowFinal) {
              console.log(`   ⚠️ Card ${card.id}: Data calculada (${nextDate.toISOString()}) está no passado, avançando para próximo ciclo...`);
              
              // Avançar um dia e calcular novamente
              const tomorrowStart = new Date(todayStart);
              tomorrowStart.setDate(todayStart.getDate() + 1);
              
              const { nextDate: futureDate } = calculateNextVisitDate({
                weekdays: [replicableFields.routeDay as string],
                periodicity: (card.recurrenceType || 'semanal') as 'semanal' | 'quinzenal' | 'mensal' | 'bimestral',
                referenceDate: tomorrowStart, // Partir de amanhã
              });
              
              futureDate.setHours(originalHours, originalMinutes, 0, 0);
              nextDate.setTime(futureDate.getTime()); // Copiar nova data
            }

            // Atualizar scheduledDate do card
            await db
              .update(salesCards)
              .set({ 
                scheduledDate: nextDate,
                updatedAt: new Date()
              })
              .where(eq(salesCards.id, card.id));

            reallocatedCount++;
            
            console.log(`   ✅ Card ${card.id} realocado: ${originalDate.toISOString().split('T')[0]} → ${nextDate.toISOString().split('T')[0]}`);
          } catch (error) {
            console.error(`   ❌ Erro ao realocar card ${card.id}:`, error);
          }
        }

        console.log(`✅ [REALOCAÇÃO] ${reallocatedCount} card(s) futuro(s) tiveram suas datas recalculadas`);
      }
      
      return updatedCount;
    } catch (error) {
      console.error('Erro ao atualizar cards futuros:', error);
      return 0;
    }
  }

  // Função helper transacional: fecha card atual e cria próximo automaticamente
  async closeCardAndScheduleNext(
    cardId: string, 
    status: 'completed' | 'no_sale' | 'failed',
    updateData: Partial<InsertSalesCard>
  ): Promise<{ closedCard: SalesCard; nextCard: SalesCard | null }> {
    try {
      // 1. Atualizar o card atual com novo status e completedDate
      const completedData = {
        ...updateData,
        status,
        completedDate: new Date(),
        updatedAt: new Date()
      };

      const [closedCard] = await db
        .update(salesCards)
        .set(completedData as any)
        .where(eq(salesCards.id, cardId))
        .returning();

      if (!closedCard) {
        throw new Error('Card não encontrado');
      }

      // 2. Gerar próximo card automaticamente
      const nextCard = await this.generateNextSalesCard(cardId);

      console.log(`Card ${cardId} fechado com status ${status}, próximo card: ${nextCard?.id || 'nenhum'}`);

      return { closedCard, nextCard };
    } catch (error) {
      console.error('Erro ao fechar card e agendar próximo:', error);
      throw error;
    }
  }

  // Função para calcular próxima data baseada no dia da semana e periodicidade
  private calculateNextRecurrenceDate(routeDay: string, recurrenceType: string, fromDate: Date = new Date()): Date {
    const daysOfWeek: { [key: string]: number } = {
      'domingo': 0,
      'segunda': 1,
      'terca': 2,
      'quarta': 3,
      'quinta': 4,
      'sexta': 5,
      'sabado': 6
    };

    const targetDay = daysOfWeek[routeDay.toLowerCase()];
    if (targetDay === undefined) {
      throw new Error(`Dia da semana inválido: ${routeDay}`);
    }

    const nextDate = new Date(fromDate);
    
    // Encontrar a próxima ocorrência do dia da semana
    const currentDay = nextDate.getDay();
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    
    // Se é o mesmo dia, vai para a próxima semana
    if (daysToAdd === 0) {
      daysToAdd = 7;
    }

    nextDate.setDate(nextDate.getDate() + daysToAdd);

    // Aplicar periodicidade
    switch (recurrenceType) {
      case 'semanal':
        // Já calculado acima
        break;
      case 'quinzenal':
        nextDate.setDate(nextDate.getDate() + 7); // +1 semana
        break;
      case 'trisemanal':
        nextDate.setDate(nextDate.getDate() + 14); // +2 semanas
        break;
      case 'mensal':
        nextDate.setMonth(nextDate.getMonth() + 1);
        break;
      default:
        throw new Error(`Tipo de recorrência inválido: ${recurrenceType}`);
    }

    return nextDate;
  }

  // Gerar próximo card de vendas automaticamente
  async generateNextSalesCard(parentCardId: string): Promise<SalesCard | null> {
    try {
      // Buscar card pai
      const [parentCard] = await db
        .select()
        .from(salesCards)
        .where(eq(salesCards.id, parentCardId));

      if (!parentCard) {
        console.error(`❌ generateNextSalesCard: Card pai ${parentCardId} não encontrado`);
        throw new Error('Card pai não encontrado');
      }

      // Verificar se já tem próximo card gerado
      if (parentCard.nextCardId) {
        const [existingNextCard] = await db
          .select()
          .from(salesCards)
          .where(eq(salesCards.id, parentCard.nextCardId));
        
        if (existingNextCard) {
          console.log(`♻️ generateNextSalesCard: Retornando card existente ${existingNextCard.id} para cliente ${parentCard.customerId}`);
          return existingNextCard;
        }
      }

      // Buscar dados do cliente para usar weekdays e visitPeriodicity
      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, parentCard.customerId));

      if (!customer) {
        throw new Error('Cliente não encontrado');
      }

      // Usar o novo módulo de agendamento se cliente tiver weekdays e visitPeriodicity
      let nextDate: Date;
      
      if (customer.weekdays && customer.visitPeriodicity) {
        const { calculateNextVisitDate } = await import('@shared/visitSchedule');
        
        let parsedWeekdays: string[] = [];
        try {
          parsedWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays;
        } catch (e) {
          console.error('Erro ao parsear weekdays:', e);
          parsedWeekdays = [];
        }

        if (parsedWeekdays.length > 0) {
          const result = calculateNextVisitDate({
            weekdays: parsedWeekdays as any[],
            periodicity: customer.visitPeriodicity as any,
            lastCompletedDate: parentCard.completedDate || parentCard.scheduledDate
          });
          nextDate = result.nextDate;
        } else {
          // Fallback para lógica antiga se weekdays não estiver configurado
          nextDate = this.calculateNextRecurrenceDate(
            parentCard.routeDay,
            parentCard.recurrenceType,
            parentCard.scheduledDate
          );
        }
      } else {
        // Fallback para lógica antiga se cliente não tiver novos campos
        nextDate = this.calculateNextRecurrenceDate(
          parentCard.routeDay,
          parentCard.recurrenceType,
          parentCard.scheduledDate
        );
      }

      // Derivar routeDay do scheduledDate
      const dayOfWeek = nextDate.getDay();
      const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
      const derivedRouteDay = weekdayNames[dayOfWeek];
      
      // Verificar se já existe um card para este cliente nesta data (prevenir duplicatas)
      const [existingCard] = await db
        .select()
        .from(salesCards)
        .where(
          and(
            eq(salesCards.customerId, parentCard.customerId),
            sql`DATE(${salesCards.scheduledDate}) = DATE(${nextDate.toISOString()})`
          )
        )
        .limit(1);
      
      if (existingCard) {
        console.log(`♻️ generateNextSalesCard: Card já existe para ${parentCard.customerId} na data ${nextDate.toISOString().split('T')[0]}, retornando card existente ${existingCard.id}`);
        
        // Atualizar card pai com referência ao card existente se ainda não tiver
        if (!parentCard.nextCardId) {
          await db
            .update(salesCards)
            .set({ nextCardId: existingCard.id })
            .where(eq(salesCards.id, parentCardId));
          console.log(`🔗 Card pai ${parentCardId} atualizado com next_card_id existente: ${existingCard.id}`);
        }
        
        return existingCard;
      }
      
      // Criar novo card copiando dados da venda anterior
      // IMPORTANTE: Usar seller_id do CLIENTE, não do card pai (para corrigir vendedores incorretos)
      const nextCardData: InsertSalesCard = {
        customerId: parentCard.customerId,
        sellerId: customer.sellerId || parentCard.sellerId, // Priorizar seller_id do cliente
        status: 'pending',
        scheduledDate: nextDate,
        attendanceStartDate: new Date(), // Data de início de atendimento = data de criação
        routeDay: derivedRouteDay, // Usar dia derivado do scheduledDate
        recurrenceType: customer.visitPeriodicity || parentCard.recurrenceType,
        isRecurring: parentCard.isRecurring,
        parentCardId: parentCardId,
        // Copiar dados da venda anterior
        products: parentCard.products,
        saleValue: parentCard.saleValue,
        paymentMethod: parentCard.paymentMethod,
        operationType: parentCard.operationType,
        boletoDays: parentCard.boletoDays,
        deliveryTimeSlots: parentCard.deliveryTimeSlots,
        deliverySaturdayTimeSlots: parentCard.deliverySaturdayTimeSlots,
        customerLatitude: parentCard.customerLatitude,
        customerLongitude: parentCard.customerLongitude,
        exclusiveVehicle: parentCard.exclusiveVehicle || false,
        vehicleTypes: (parentCard.vehicleTypes || []) as any
      };

      console.log(`📝 Tentando criar card para cliente ${parentCard.customerId}, data: ${nextDate.toISOString().split('T')[0]}`);
      
      // Usar onConflictDoNothing para evitar erros em caso de duplicatas
      const newCards = await db.insert(salesCards)
        .values(nextCardData as any)
        .onConflictDoNothing()
        .returning();

      // Se nenhum card foi retornado, significa que já existia (conflito)
      if (!newCards || newCards.length === 0) {
        console.log(`⚠️ Card já existe para cliente ${parentCard.customerId} na data ${nextDate.toISOString().split('T')[0]}, buscando card existente`);
        
        // Buscar o card existente
        const [found] = await db.select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, parentCard.customerId),
              sql`DATE(${salesCards.scheduledDate}) = DATE(${nextDate.toISOString()})`
            )
          )
          .limit(1);
        
        if (found) {
          // Atualizar card pai com referência ao card existente
          if (!parentCard.nextCardId) {
            await db.update(salesCards)
              .set({ nextCardId: found.id })
              .where(eq(salesCards.id, parentCardId));
          }
          return found;
        }
        
        console.error(`❌ Card não foi criado e não foi encontrado para cliente ${parentCard.customerId}`);
        return null;
      }

      const newCard = newCards[0];
      console.log(`✅ Card criado: ${newCard.id} para cliente ${parentCard.customerId}, data: ${newCard.scheduledDate}`);

      // Atualizar card pai com referência ao próximo
      await db
        .update(salesCards)
        .set({ nextCardId: newCard.id })
        .where(eq(salesCards.id, parentCardId));

      console.log(`🔗 Card pai ${parentCardId} atualizado com next_card_id: ${newCard.id}`);

      return newCard;
    } catch (error) {
      console.error(`❌ ERRO ao gerar próximo card para ${parentCardId}:`, error);
      return null;
    }
  }

  // Buscar cards por dia da semana e data
  async getSalesCardsByDayAndDate(
    sellerId: string, 
    routeDay: string, 
    startDate: Date, 
    endDate: Date,
    limit: number = 20,
    offset: number = 0
  ): Promise<SalesCardWithRelations[]> {
    const cardsWithRelations = await db
      .select({
        // Sales card fields
        id: salesCards.id,
        customerId: salesCards.customerId,
        sellerId: salesCards.sellerId,
        status: salesCards.status,
        scheduledDate: salesCards.scheduledDate,
        completedDate: salesCards.completedDate,
        saleValue: salesCards.saleValue,
        noSaleReason: salesCards.noSaleReason,
        notes: salesCards.notes,
        products: salesCards.products,
        routeDay: salesCards.routeDay,
        recurrenceType: salesCards.recurrenceType,
        isRecurring: salesCards.isRecurring,
        parentCardId: salesCards.parentCardId,
        nextCardId: salesCards.nextCardId,
        duplicatedFromId: salesCards.duplicatedFromId,
        telemarketingAssignedTo: salesCards.telemarketingAssignedTo,
        telemarketingDate: salesCards.telemarketingDate,
        telemarketingNotes: salesCards.telemarketingNotes,
        deliveryStatus: salesCards.deliveryStatus,
        deliveryScheduledDate: salesCards.deliveryScheduledDate,
        deliveryCompletedDate: salesCards.deliveryCompletedDate,
        deliveryFailureReason: salesCards.deliveryFailureReason,
        deliveryNotes: salesCards.deliveryNotes,
        deliveryDriverId: salesCards.deliveryDriverId,
        trackingCode: salesCards.trackingCode,
        omieOrderId: salesCards.omieOrderId,
        invoiceNumber: salesCards.invoiceNumber,
        paymentMethod: salesCards.paymentMethod,
        operationType: salesCards.operationType,
        createdAt: salesCards.createdAt,
        updatedAt: salesCards.updatedAt,
        // Customer fields
        customer: {
          id: customers.id,
          name: customers.name,
          customerType: customers.customerType,
          cpf: customers.cpf,
          cnpj: customers.cnpj,
          companyName: customers.companyName,
          fantasyName: customers.fantasyName,
          phone: customers.phone,
          email: customers.email,
          address: customers.address,
          city: customers.city,
          state: customers.state,
          zipCode: customers.zipCode,
          route: customers.route,
          sellerId: customers.sellerId,
          weekdays: customers.weekdays,
          visitPeriodicity: customers.visitPeriodicity,
          latitude: customers.latitude,
          longitude: customers.longitude,
          virtualService: customers.virtualService,
          isActive: customers.isActive,
          lastSaleDate: customers.lastSaleDate,
          lastSaleValue: customers.lastSaleValue,
          createdAt: customers.createdAt,
          updatedAt: customers.updatedAt,
        },
        // Seller fields
        seller: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
          role: users.role,
          route: users.route,
          isActive: users.isActive,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        }
      })
      .from(salesCards)
      .innerJoin(customers, eq(salesCards.customerId, customers.id))
      .innerJoin(users, eq(salesCards.sellerId, users.id))
      .where(
        sellerId
          ? and(
              eq(salesCards.sellerId, sellerId),
              eq(salesCards.routeDay, routeDay),
              gte(salesCards.scheduledDate, startDate),
              lte(salesCards.scheduledDate, endDate)
            )
          : and(
              eq(salesCards.routeDay, routeDay),
              gte(salesCards.scheduledDate, startDate),
              lte(salesCards.scheduledDate, endDate)
            )
      )
      .orderBy(salesCards.scheduledDate)
      .limit(limit)
      .offset(offset);

    return cardsWithRelations as SalesCardWithRelations[];
  }

  // Buscar cards por intervalo de datas (todos os dias da semana)
  async getSalesCardsByDateRange(
    sellerId: string | undefined,
    startDate: Date,
    endDate: Date,
    limit: number = 20,
    offset: number = 0
  ): Promise<SalesCardWithRelations[]> {
    const cardsWithRelations = await db
      .select({
        // Sales card fields
        id: salesCards.id,
        customerId: salesCards.customerId,
        sellerId: salesCards.sellerId,
        status: salesCards.status,
        scheduledDate: salesCards.scheduledDate,
        completedDate: salesCards.completedDate,
        saleValue: salesCards.saleValue,
        noSaleReason: salesCards.noSaleReason,
        notes: salesCards.notes,
        products: salesCards.products,
        routeDay: salesCards.routeDay,
        recurrenceType: salesCards.recurrenceType,
        isRecurring: salesCards.isRecurring,
        parentCardId: salesCards.parentCardId,
        nextCardId: salesCards.nextCardId,
        duplicatedFromId: salesCards.duplicatedFromId,
        telemarketingAssignedTo: salesCards.telemarketingAssignedTo,
        telemarketingDate: salesCards.telemarketingDate,
        telemarketingNotes: salesCards.telemarketingNotes,
        deliveryStatus: salesCards.deliveryStatus,
        deliveryScheduledDate: salesCards.deliveryScheduledDate,
        deliveryCompletedDate: salesCards.deliveryCompletedDate,
        deliveryFailureReason: salesCards.deliveryFailureReason,
        deliveryNotes: salesCards.deliveryNotes,
        deliveryDriverId: salesCards.deliveryDriverId,
        trackingCode: salesCards.trackingCode,
        omieOrderId: salesCards.omieOrderId,
        invoiceNumber: salesCards.invoiceNumber,
        paymentMethod: salesCards.paymentMethod,
        operationType: salesCards.operationType,
        createdAt: salesCards.createdAt,
        updatedAt: salesCards.updatedAt,
        // Customer fields
        customer: {
          id: customers.id,
          name: customers.name,
          customerType: customers.customerType,
          cpf: customers.cpf,
          cnpj: customers.cnpj,
          companyName: customers.companyName,
          fantasyName: customers.fantasyName,
          phone: customers.phone,
          email: customers.email,
          address: customers.address,
          city: customers.city,
          state: customers.state,
          zipCode: customers.zipCode,
          route: customers.route,
          sellerId: customers.sellerId,
          weekdays: customers.weekdays,
          visitPeriodicity: customers.visitPeriodicity,
          latitude: customers.latitude,
          longitude: customers.longitude,
          virtualService: customers.virtualService,
          isActive: customers.isActive,
          lastSaleDate: customers.lastSaleDate,
          lastSaleValue: customers.lastSaleValue,
          createdAt: customers.createdAt,
          updatedAt: customers.updatedAt,
        },
        // Seller fields
        seller: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
          role: users.role,
          route: users.route,
          isActive: users.isActive,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        }
      })
      .from(salesCards)
      .innerJoin(customers, eq(salesCards.customerId, customers.id))
      .innerJoin(users, eq(salesCards.sellerId, users.id))
      .where(
        sellerId
          ? and(
              eq(salesCards.sellerId, sellerId),
              gte(salesCards.scheduledDate, startDate),
              lte(salesCards.scheduledDate, endDate)
            )
          : and(
              gte(salesCards.scheduledDate, startDate),
              lte(salesCards.scheduledDate, endDate)
            )
      )
      .orderBy(salesCards.scheduledDate)
      .limit(limit)
      .offset(offset);

    return cardsWithRelations as SalesCardWithRelations[];
  }

  async deleteSalesCard(id: string): Promise<void> {
    await db.delete(salesCards).where(eq(salesCards.id, id));
  }

  async deleteAllSalesCards(): Promise<number> {
    const result = await db.delete(salesCards);
    return result.rowCount || 0;
  }

  async getSalesCardsByDate(date: Date, sellerId?: string): Promise<SalesCardWithRelations[]> {
    // Formatar data como YYYY-MM-DD para comparação
    const targetDate = date.toISOString().split('T')[0];
    
    // Converter timestamptz para date no timezone de São Paulo
    // Sintaxe correta: (col AT TIME ZONE 'America/Sao_Paulo')::date
    let whereConditions;
    
    if (sellerId) {
      whereConditions = and(
        eq(salesCards.sellerId, sellerId),
        or(
          // Permanent cards: converter nextVisitDate para date em BRT
          and(
            eq(salesCards.isPermanent, true),
            sql`(${salesCards.nextVisitDate} AT TIME ZONE 'America/Sao_Paulo')::date = ${targetDate}`,
            inArray(salesCards.status, ['pending', 'open'])
          ),
          // Legacy cards: converter scheduledDate para date em BRT
          and(
            or(
              eq(salesCards.isPermanent, false),
              isNull(salesCards.isPermanent)
            ),
            sql`(${salesCards.scheduledDate} AT TIME ZONE 'America/Sao_Paulo')::date = ${targetDate}`
          )
        )
      );
    } else {
      whereConditions = or(
        // Permanent cards: converter nextVisitDate para date em BRT
        and(
          eq(salesCards.isPermanent, true),
          sql`(${salesCards.nextVisitDate} AT TIME ZONE 'America/Sao_Paulo')::date = ${targetDate}`,
          inArray(salesCards.status, ['pending', 'open'])
        ),
        // Legacy cards: converter scheduledDate para date em BRT
        and(
          or(
            eq(salesCards.isPermanent, false),
            isNull(salesCards.isPermanent)
          ),
          sql`(${salesCards.scheduledDate} AT TIME ZONE 'America/Sao_Paulo')::date = ${targetDate}`
        )
      );
    }
    
    const result = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(whereConditions)
      .orderBy(desc(salesCards.scheduledDate));
    
    console.log(`📊 getSalesCardsByDate: Encontrados ${result.length} cards para ${date.toLocaleDateString('pt-BR')} ${sellerId ? `(vendedor: ${sellerId})` : ''}`);
    
    return result.map(row => ({
      ...row.sales_cards,
      customer: row.customers!,
      seller: row.users!,
    }));
  }

  async getOverdueSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]> {
    const now = new Date();
    
    let whereConditions = and(
      lte(salesCards.scheduledDate, now),
      inArray(salesCards.status, ['pending', 'in_progress'])
    );
    
    if (sellerId) {
      whereConditions = and(
        lte(salesCards.scheduledDate, now),
        inArray(salesCards.status, ['pending', 'in_progress']),
        eq(salesCards.sellerId, sellerId)
      );
    }
    
    const result = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(whereConditions)
      .orderBy(desc(salesCards.scheduledDate));
    
    return result.map(row => ({
      ...row.sales_cards,
      customer: row.customers!,
      seller: row.users!,
    }));
  }

  // Buscar cards criticamente atrasados (pending com mais de 3 dias de atraso)
  async getCriticallyOverdueCards(sellerId?: string): Promise<SalesCardWithRelations[]> {
    // Calcular data limite: hoje - 3 dias no timezone do Brasil (UTC-3)
    const now = new Date();
    const brazilOffset = -3 * 60; // UTC-3 em minutos
    const localOffset = now.getTimezoneOffset();
    const brazilTime = new Date(now.getTime() + (localOffset + brazilOffset) * 60 * 1000);
    
    const threeDaysAgo = new Date(brazilTime);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    threeDaysAgo.setHours(23, 59, 59, 999); // Fim do dia há 3 dias
    
    let whereConditions = and(
      lte(salesCards.scheduledDate, threeDaysAgo),
      eq(salesCards.status, 'pending')
    );
    
    if (sellerId) {
      whereConditions = and(
        lte(salesCards.scheduledDate, threeDaysAgo),
        eq(salesCards.status, 'pending'),
        eq(salesCards.sellerId, sellerId)
      );
    }
    
    const result = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(whereConditions)
      .orderBy(salesCards.scheduledDate);
    
    return result.map(row => ({
      ...row.sales_cards,
      customer: row.customers!,
      seller: row.users!,
    }));
  }

  async duplicateSalesCard(id: string, newDate: Date): Promise<SalesCard> {
    const originalCard = await this.getSalesCard(id);
    if (!originalCard) {
      throw new Error('Sales card not found');
    }
    
    const [newCard] = await db
      .insert(salesCards)
      .values({
        customerId: originalCard.customerId,
        sellerId: originalCard.sellerId,
        status: 'pending',
        scheduledDate: newDate,
        duplicatedFromId: id,
        notes: originalCard.notes,
        routeDay: originalCard.routeDay,
        recurrenceType: originalCard.recurrenceType,
        paymentMethod: originalCard.paymentMethod,
        operationType: originalCard.operationType,
      } as any)
      .returning();
    
    return newCard;
  }

  /**
   * Busca o card permanente de um cliente ou cria um novo se não existir
   * Card permanente: único card por cliente usado para registrar todos os pedidos
   */
  async getOrCreatePermanentCard(customerId: string, sellerId: string): Promise<SalesCard> {
    // Tentar buscar card permanente existente
    const existingCard = await this.getPermanentCardByCustomer(customerId);
    
    if (existingCard) {
      return existingCard;
    }
    
    // Buscar informações do cliente para configurar o card
    const customer = await this.getCustomer(customerId);
    if (!customer) {
      throw new Error('Cliente não encontrado');
    }
    
    // Pegar primeiro dia de visita do cliente
    let weekdays: string[] = [];
    try {
      weekdays = JSON.parse(customer.weekdays || '[]');
    } catch (e) {
      weekdays = ['Dom']; // Fallback
    }
    
    const firstWeekday = weekdays[0] || 'Dom';
    
    // Criar card permanente
    const [permanentCard] = await db
      .insert(salesCards)
      .values({
        customerId,
        sellerId,
        status: 'pending',
        scheduledDate: new Date(), // Data de criação
        routeDay: firstWeekday,
        recurrenceType: customer.visitPeriodicity || 'semanal',
        paymentMethod: 'a_vista',
        operationType: 'venda',
        isRecurring: false, // Card permanente não gera novos cards
        notes: 'Card permanente - histórico de pedidos',
      } as any)
      .returning();
    
    return permanentCard;
  }

  /**
   * Busca o card permanente de um cliente
   * Critério: card mais antigo ativo do cliente (será consolidado na migração)
   */
  async getPermanentCardByCustomer(customerId: string): Promise<SalesCard | undefined> {
    const [card] = await db
      .select()
      .from(salesCards)
      .where(eq(salesCards.customerId, customerId))
      .orderBy(salesCards.createdAt) // Card mais antigo
      .limit(1);
    
    return card;
  }

  // ==================== ORDER HISTORY OPERATIONS ====================

  async createOrderHistory(order: InsertOrderHistory): Promise<OrderHistory> {
    const [newOrder] = await db
      .insert(orderHistory)
      .values(order as any)
      .returning();
    
    return newOrder;
  }

  async getOrderHistoryByCard(salesCardId: string): Promise<OrderHistory[]> {
    const orders = await db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.salesCardId, salesCardId))
      .orderBy(desc(orderHistory.orderDate));
    
    return orders;
  }

  async getOrderHistoryById(id: string): Promise<OrderHistory | undefined> {
    const [order] = await db
      .select()
      .from(orderHistory)
      .where(eq(orderHistory.id, id));
    
    return order;
  }

  async updateOrderHistory(id: string, orderData: Partial<InsertOrderHistory>): Promise<OrderHistory> {
    const [updatedOrder] = await db
      .update(orderHistory)
      .set({ ...orderData, updatedAt: new Date() })
      .where(eq(orderHistory.id, id))
      .returning();
    
    if (!updatedOrder) {
      throw new Error('Pedido não encontrado');
    }
    
    return updatedOrder;
  }

  async deleteOrderHistory(id: string): Promise<void> {
    await db.delete(orderHistory).where(eq(orderHistory.id, id));
  }

  // Função helper para calcular distância entre dois pontos (Haversine formula)
  private calculateDistance(
    lat1: number, 
    lon1: number, 
    lat2: number, 
    lon2: number
  ): number {
    const R = 6371; // Raio da Terra em km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distância em km
  }

  // Otimizar rota usando algoritmo Nearest Neighbor (TSP simplificado)
  async getOptimizedRoute(
    sellerId: string,
    date: Date
  ): Promise<{ cards: SalesCardWithRelations[]; totalDistance: number; seller: any }> {
    // 1. Buscar vendedor com coordenadas de casa
    const [seller] = await db
      .select()
      .from(users)
      .where(eq(users.id, sellerId));

    if (!seller || !seller.homeLatitude || !seller.homeLongitude) {
      throw new Error('Vendedor não encontrado ou sem coordenadas de casa cadastradas');
    }

    const homeCoords = {
      lat: parseFloat(seller.homeLatitude),
      lng: parseFloat(seller.homeLongitude)
    };

    // 2. Buscar cards da data especificada
    const cards = await this.getSalesCardsByDate(date, sellerId);

    // 3. Filtrar apenas cards com coordenadas válidas
    const cardsWithCoords = cards.filter(card => 
      card.customer.latitude && 
      card.customer.longitude
    );

    if (cardsWithCoords.length === 0) {
      return { cards: [], totalDistance: 0, seller };
    }

    // 4. Aplicar algoritmo Nearest Neighbor
    const optimizedCards: SalesCardWithRelations[] = [];
    const remaining = [...cardsWithCoords];
    let currentPosition = homeCoords;
    let totalDistance = 0;

    while (remaining.length > 0) {
      // Encontrar o card mais próximo da posição atual
      let nearestIndex = 0;
      let nearestDistance = Infinity;

      remaining.forEach((card, index) => {
        const distance = this.calculateDistance(
          currentPosition.lat,
          currentPosition.lng,
          parseFloat(card.customer.latitude!),
          parseFloat(card.customer.longitude!)
        );

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      // Adicionar o card mais próximo à rota
      const nearestCard = remaining[nearestIndex];
      optimizedCards.push(nearestCard);
      totalDistance += nearestDistance;

      // Atualizar posição atual
      currentPosition = {
        lat: parseFloat(nearestCard.customer.latitude!),
        lng: parseFloat(nearestCard.customer.longitude!)
      };

      // Remover card da lista de pendentes
      remaining.splice(nearestIndex, 1);
    }

    // 5. Adicionar distância de volta para casa
    if (optimizedCards.length > 0) {
      const lastCard = optimizedCards[optimizedCards.length - 1];
      const returnDistance = this.calculateDistance(
        parseFloat(lastCard.customer.latitude!),
        parseFloat(lastCard.customer.longitude!),
        homeCoords.lat,
        homeCoords.lng
      );
      totalDistance += returnDistance;
    }

    return {
      cards: optimizedCards,
      totalDistance: Math.round(totalDistance * 10) / 10, // Arredondar para 1 casa decimal
      seller
    };
  }

  // Message template operations
  async getMessageTemplates(): Promise<MessageTemplate[]> {
    return await db.select().from(messageTemplates).where(eq(messageTemplates.isActive, true));
  }

  async getMessageTemplate(id: string): Promise<MessageTemplate | undefined> {
    const [template] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, id));
    return template;
  }

  async createMessageTemplate(template: InsertMessageTemplate): Promise<MessageTemplate> {
    const [newTemplate] = await db.insert(messageTemplates).values(template).returning();
    return newTemplate;
  }

  async updateMessageTemplate(id: string, template: Partial<InsertMessageTemplate>): Promise<MessageTemplate> {
    const [updatedTemplate] = await db
      .update(messageTemplates)
      .set({ ...template, updatedAt: new Date() })
      .where(eq(messageTemplates.id, id))
      .returning();
    return updatedTemplate;
  }

  async deleteMessageTemplate(id: string): Promise<void> {
    await db.update(messageTemplates).set({ isActive: false }).where(eq(messageTemplates.id, id));
  }

  // Message history operations
  async getMessageHistory(customerId?: string): Promise<MessageHistory[]> {
    if (customerId) {
      return await db.select().from(messageHistory)
        .where(eq(messageHistory.customerId, customerId))
        .orderBy(desc(messageHistory.sentAt));
    }
    
    return await db.select().from(messageHistory).orderBy(desc(messageHistory.sentAt));
  }

  async createMessageHistory(history: InsertMessageHistory): Promise<MessageHistory> {
    const [newHistory] = await db.insert(messageHistory).values(history).returning();
    return newHistory;
  }

  // Dashboard stats
  async getDashboardStats(sellerId?: string): Promise<{
    todaySales: number;
    todayClients: number;
    overdueClients: number;
    conversionRate: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Today's sales
    let todaySalesQuery = db
      .select({ value: sql<number>`COALESCE(SUM(${salesCards.saleValue}), 0)` })
      .from(salesCards)
      .where(
        and(
          gte(salesCards.completedDate, today),
          lte(salesCards.completedDate, tomorrow),
          eq(salesCards.status, 'completed')
        )
      );
    
    if (sellerId) {
      todaySalesQuery = db
        .select({ value: sql<number>`COALESCE(SUM(${salesCards.saleValue}), 0)` })
        .from(salesCards)
        .where(
          and(
            gte(salesCards.completedDate, today),
            lte(salesCards.completedDate, tomorrow),
            eq(salesCards.status, 'completed'),
            eq(salesCards.sellerId, sellerId)
          )
        );
    }
    
    const [todaySalesResult] = await todaySalesQuery;
    
    // Today's clients
    let todayClientsQuery = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(salesCards)
      .where(
        and(
          gte(salesCards.scheduledDate, today),
          lte(salesCards.scheduledDate, tomorrow)
        )
      );
    
    if (sellerId) {
      todayClientsQuery = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(salesCards)
        .where(
          and(
            gte(salesCards.scheduledDate, today),
            lte(salesCards.scheduledDate, tomorrow),
            eq(salesCards.sellerId, sellerId)
          )
        );
    }
    
    const [todayClientsResult] = await todayClientsQuery;
    
    // Overdue clients
    const overdueCards = await this.getOverdueSalesCards(sellerId);
    
    // Conversion rate (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    let totalCardsQuery = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(salesCards)
      .where(gte(salesCards.completedDate, thirtyDaysAgo));
    
    let completedCardsQuery = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(salesCards)
      .where(
        and(
          gte(salesCards.completedDate, thirtyDaysAgo),
          eq(salesCards.status, 'completed')
        )
      );
    
    if (sellerId) {
      totalCardsQuery = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(salesCards)
        .where(
          and(
            gte(salesCards.completedDate, thirtyDaysAgo),
            eq(salesCards.sellerId, sellerId)
          )
        );
      
      completedCardsQuery = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(salesCards)
        .where(
          and(
            gte(salesCards.completedDate, thirtyDaysAgo),
            eq(salesCards.status, 'completed'),
            eq(salesCards.sellerId, sellerId)
          )
        );
    }
    
    const [totalCardsResult] = await totalCardsQuery;
    const [completedCardsResult] = await completedCardsQuery;
    
    const conversionRate = totalCardsResult.count > 0 
      ? Math.round((completedCardsResult.count / totalCardsResult.count) * 100)
      : 0;
    
    return {
      todaySales: todaySalesResult.value || 0,
      todayClients: todayClientsResult.count || 0,
      overdueClients: overdueCards.length,
      conversionRate,
    };
  }

  async getSellersStats(): Promise<Array<{
    sellerId: string;
    sellerName: string;
    activeClients: number;
    positivatedThisMonth: number;
    positivationRate: number;
  }>> {
    // Buscar todos os vendedores ativos
    const activeUsers = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          inArray(users.role, ['vendedor', 'coordinator', 'admin'])
        )
      );

    // Definir início do mês atual
    const currentMonthStart = new Date();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);

    const sellersStats = [];

    for (const user of activeUsers) {
      // Contar clientes ativos usando o mesmo critério da listagem de clientes
      const [activeClientsCount] = await db
        .select({ count: sql`COUNT(*)`.mapWith(Number) })
        .from(customers)
        .where(
          and(
            eq(customers.sellerId, user.id),
            eq(customers.omieStatus, 'ativo')
          )
        );

      // Contar clientes positivados no mês atual
      const [positivatedCount] = await db
        .select({ count: sql`COUNT(DISTINCT ${salesCards.customerId})`.mapWith(Number) })
        .from(salesCards)
        .innerJoin(customers, eq(salesCards.customerId, customers.id))
        .where(
          and(
            eq(customers.sellerId, user.id),
            eq(salesCards.status, 'completed'),
            gte(salesCards.completedDate, currentMonthStart),
            sql`${salesCards.saleValue} > 0`
          )
        );

      const activeClients = activeClientsCount?.count || 0;
      const positivatedThisMonth = positivatedCount?.count || 0;
      const positivationRate = activeClients > 0 
        ? Math.round((positivatedThisMonth / activeClients) * 100) 
        : 0;

      // Só inclui vendedores que têm pelo menos 1 cliente ativo
      if (activeClients > 0) {
        sellersStats.push({
          sellerId: user.id,
          sellerName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || user.id,
          activeClients,
          positivatedThisMonth,
          positivationRate
        });
      }
    }

    return sellersStats;
  }

  // ===== DELIVERY OPERATIONS =====

  async updateSalesCardDeliveryStatus(id: string, data: any): Promise<SalesCard> {
    const result = await db.execute(sql`
      UPDATE sales_cards 
      SET 
        delivery_status = ${data.deliveryStatus},
        delivery_completed_date = ${data.deliveryCompletedDate},
        delivery_failure_reason = ${data.deliveryFailureReason},
        delivery_notes = ${data.deliveryNotes},
        delivery_driver_id = ${data.deliveryDriverId},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `);
    return result.rows[0] as SalesCard;
  }

  async getSalesCardByTrackingCode(trackingCode: string): Promise<SalesCard | undefined> {
    const result = await db.execute(sql`
      SELECT * FROM sales_cards 
      WHERE tracking_code = ${trackingCode}
      LIMIT 1
    `);
    return result.rows[0] as SalesCard;
  }

  async getPendingDeliveries(): Promise<PendingDelivery[]> {
    // Retornar dados dos billings com latitude/longitude dos clientes cadastrados
    const result = await db.execute(sql`
      SELECT 
        b.id,
        b.invoice_number as "invoiceNumber",
        b.omie_order_id as "omieOrderId",
        b.order_number as "orderNumber",
        b.customer_fantasy_name as "customerName",
        b.customer_document as "customerDocument",
        b.omie_customer_code,
        b.invoice_date as "scheduledDate",
        b.invoice_date as "invoiceDate",
        b.total_value as "saleValue",
        b.products,
        b.payment_method as "paymentMethod",
        b.billing_type as "operationType",
        COALESCE(c.exclusive_vehicle, b.exclusive_vehicle) as "exclusiveVehicle",
        COALESCE(c.vehicle_types::text, b.vehicle_types::text)::jsonb as "vehicleTypes",
        b.is_urgent as "isUrgent",
        b.delivery_weekdays as "deliveryWeekdays",
        COALESCE(c.latitude, NULL)::text as "customerLatitude",
        COALESCE(c.longitude, NULL)::text as "customerLongitude",
        COALESCE(c.address, '')::text as "customerAddress",
        COALESCE(c.receiving_weekdays, '[]'::jsonb) as "receivingWeekdays",
        COALESCE(c.delivery_time_slots, '[]'::jsonb) as "deliveryTimeSlots",
        COALESCE(c.delivery_saturday_time_slots, '[]'::jsonb) as "deliverySaturdayTimeSlots",
        COALESCE(c.average_delivery_time, 10) as "averageDeliveryTime",
        c.id as "customerId",
        c.weekdays as "customerWeekdays"
      FROM billings b
      LEFT JOIN customers c ON b.customer_fantasy_name = c.fantasy_name
      WHERE b.invoice_stage = 'Aguardando Rota'
        AND b.invoice_number IS NOT NULL
        AND b.invoice_date IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM delivery_route_stops drs
          WHERE drs.billing_id = b.id
        )
      ORDER BY b.invoice_date DESC, b.customer_fantasy_name
    `);
    
    // Mapear billings para deliveries com customerId genérico
    return result.rows.map((row: any) => {
      // Extrair CPF/CNPJ do customer_document (removendo caracteres especiais)
      const docNumeros = row.customerDocument ? row.customerDocument.replace(/\D/g, '') : '';
      const isCnpj = docNumeros.length === 14;
      
      // Calcular dias de entrega automáticamente baseado no dia de rota (customerWeekdays)
      // Se o dia de rota é SEX, os dias de entrega são SEG e TER (próximos 2 dias úteis)
      let calculatedDeliveryDays: string[] = [];
      if (row.customerWeekdays) {
        calculatedDeliveryDays = calculateDeliveryDays(row.customerWeekdays) as string[];
      }
      
      return {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        omieOrderId: row.omieOrderId,
        orderNumber: row.orderNumber,
        customerId: row.customerId || ('billing-' + row.id),
        customerName: row.customerName,
        customerCpf: !isCnpj ? row.customerDocument : null,
        customerCnpj: isCnpj ? row.customerDocument : null,
        customerAddress: row.customerAddress || '',
        customerLatitude: row.customerLatitude ? parseFloat(row.customerLatitude) : null,
        customerLongitude: row.customerLongitude ? parseFloat(row.customerLongitude) : null,
        customerWeekdays: row.customerWeekdays || null,
        averageDeliveryTime: row.averageDeliveryTime || 10,
        exclusiveVehicle: row.exclusiveVehicle || false,
        vehicleTypes: this.parseJsonField(row.vehicleTypes, []),
        isUrgent: row.isUrgent || false,
        saleValue: row.saleValue,
        products: this.parseJsonField(row.products, []),
        scheduledDate: row.invoiceDate,
        completedDate: row.invoiceDate,
        paymentMethod: row.paymentMethod || '',
        operationType: row.operationType || '',
        receivingWeekdays: this.parseJsonField(row.receivingWeekdays, []),
        deliveryWeekdays: calculatedDeliveryDays.length > 0 ? calculatedDeliveryDays : this.parseJsonField(row.deliveryWeekdays, []),
        deliveryTimeSlots: this.parseJsonField(row.deliveryTimeSlots, []),
        deliverySaturdayTimeSlots: this.parseJsonField(row.deliverySaturdayTimeSlots, [])
      };
    });
  }

  // Helper method to safely parse JSON fields
  private parseJsonField(field: any, defaultValue: any = null): any {
    if (field === null || field === undefined) return defaultValue;
    if (typeof field === 'string') {
      try {
        return JSON.parse(field);
      } catch {
        return defaultValue;
      }
    }
    return field; // Already parsed or is the correct type
  }

  async createDeliveryHistory(data: any): Promise<any> {
    const result = await db.execute(sql`
      INSERT INTO delivery_history (
        sales_card_id, 
        invoice_number,
        customer_id,
        customer_name,
        driver_id,
        driver_name,
        vehicle_type,
        status, 
        check_in_time,
        check_out_time,
        delivery_duration,
        timestamp, 
        location, 
        notes
      )
      VALUES (
        ${data.salesCardId}, 
        ${data.invoiceNumber || null},
        ${data.customerId || null},
        ${data.customerName || null},
        ${data.driverId || null},
        ${data.driverName || null},
        ${data.vehicleType || null},
        ${data.status}, 
        ${data.checkInTime || null},
        ${data.checkOutTime || null},
        ${data.deliveryDuration || null},
        ${data.timestamp || new Date()}, 
        ${data.location}, 
        ${data.notes}
      )
      RETURNING *
    `);
    return result.rows[0];
  }

  async getDeliveryHistory(salesCardId: string): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT dh.*, dd.name as driver_name
      FROM delivery_history dh
      LEFT JOIN delivery_drivers dd ON dh.driver_id = dd.id
      WHERE dh.sales_card_id = ${salesCardId} 
      ORDER BY dh.timestamp DESC
    `);
    return result.rows;
  }

  async getDeliveryDrivers(): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT 
        id,
        name,
        phone,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM delivery_drivers
      ORDER BY name
    `);
    return result.rows;
  }

  async createDeliveryDriver(data: any): Promise<any> {
    const isActive = data.isActive !== undefined ? data.isActive : true;
    const result = await db.execute(sql`
      INSERT INTO delivery_drivers (name, phone, vehicle_type, license_plate, is_active, current_location)
      VALUES (${data.name}, ${data.phone}, ${data.vehicleType}, ${data.licensePlate}, ${isActive}, ${data.currentLocation || null})
      RETURNING 
        id,
        name,
        phone,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `);
    return result.rows[0];
  }

  async updateDriverLocation(driverId: string, location: string): Promise<any> {
    const result = await db.execute(sql`
      UPDATE delivery_drivers 
      SET current_location = ${location}, updated_at = NOW() 
      WHERE id = ${driverId}
      RETURNING 
        id,
        name,
        phone,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `);
    return result.rows[0];
  }

  // ===== SISTEMA DE VENDAS RECORRENTES =====

  // Criar próximo card de venda baseado na recorrência
  async createNextRecurringCard(parentCard: SalesCard): Promise<SalesCard> {
    // Buscar dados do cliente para usar weekdays e visitPeriodicity
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, parentCard.customerId));

    if (!customer) {
      throw new Error('Cliente não encontrado');
    }

    let nextDate: Date;
    let derivedRouteDay: string;

    // Usar o módulo de agendamento centralizado se cliente tiver weekdays e visitPeriodicity
    if (customer.weekdays && customer.visitPeriodicity) {
      const { calculateNextVisitDate } = await import('@shared/visitSchedule');
      
      let parsedWeekdays: string[] = [];
      try {
        parsedWeekdays = typeof customer.weekdays === 'string' 
          ? JSON.parse(customer.weekdays) 
          : customer.weekdays;
      } catch (e) {
        console.error('Erro ao parsear weekdays:', e);
        parsedWeekdays = [];
      }

      if (parsedWeekdays.length > 0) {
        const result = calculateNextVisitDate({
          weekdays: parsedWeekdays as any[],
          periodicity: customer.visitPeriodicity as any,
          lastCompletedDate: parentCard.completedDate || parentCard.scheduledDate
        });
        nextDate = result.nextDate;
        
        // Derivar routeDay da data calculada
        const dayOfWeek = nextDate.getDay();
        const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        derivedRouteDay = weekdayNames[dayOfWeek];
      } else {
        // Fallback para lógica antiga se weekdays não estiver configurado
        nextDate = this.calculateNextScheduledDate(
          parentCard.scheduledDate,
          parentCard.routeDay,
          parentCard.recurrenceType
        );
        derivedRouteDay = parentCard.routeDay;
      }
    } else {
      // Fallback para lógica antiga se cliente não tiver novos campos
      nextDate = this.calculateNextScheduledDate(
        parentCard.scheduledDate,
        parentCard.routeDay,
        parentCard.recurrenceType
      );
      derivedRouteDay = parentCard.routeDay;
    }

    const nextCard = {
      customerId: parentCard.customerId,
      sellerId: parentCard.sellerId,
      scheduledDate: nextDate,
      status: 'pending' as const,
      products: parentCard.products,
      routeDay: derivedRouteDay,
      recurrenceType: parentCard.recurrenceType,
      isRecurring: parentCard.isRecurring,
      parentCardId: parentCard.id,
      saleValue: parentCard.saleValue,
      notes: `Card recorrente gerado automaticamente a partir do card ${parentCard.id}`
    };

    const [createdCard] = await db.insert(salesCards).values({
      customerId: nextCard.customerId,
      sellerId: nextCard.sellerId,
      scheduledDate: nextCard.scheduledDate,
      attendanceStartDate: new Date(), // Data de início de atendimento = data de criação
      status: nextCard.status,
      products: nextCard.products,
      routeDay: nextCard.routeDay,
      recurrenceType: nextCard.recurrenceType,
      isRecurring: nextCard.isRecurring,
      parentCardId: nextCard.parentCardId,
      saleValue: nextCard.saleValue,
      notes: nextCard.notes
    }).returning();

    // Atualizar card pai com referência ao próximo card
    await db.update(salesCards)
      .set({ nextCardId: createdCard.id, updatedAt: new Date() })
      .where(eq(salesCards.id, parentCard.id));

    return createdCard;
  }

  // Calcular próxima data baseada na recorrência
  private calculateNextScheduledDate(
    currentDate: Date,
    routeDay: string,
    recurrenceType: string
  ): Date {
    const dayMap = {
      'domingo': 0, 'segunda': 1, 'terca': 2, 'quarta': 3,
      'quinta': 4, 'sexta': 5, 'sabado': 6
    };

    const targetDayOfWeek = dayMap[routeDay as keyof typeof dayMap];
    const nextDate = new Date(currentDate);

    // Adicionar intervalo baseado no tipo de recorrência
    switch (recurrenceType) {
      case 'semanal':
        nextDate.setDate(nextDate.getDate() + 7);
        break;
      case 'quinzenal':
        nextDate.setDate(nextDate.getDate() + 14);
        break;
      case 'trisemanal':
        nextDate.setDate(nextDate.getDate() + 21);
        break;
      case 'mensal':
        nextDate.setMonth(nextDate.getMonth() + 1);
        break;
      default:
        nextDate.setDate(nextDate.getDate() + 7); // Padrão semanal
    }

    // Ajustar para o dia da semana correto
    const currentDayOfWeek = nextDate.getDay();
    const daysUntilTarget = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
    nextDate.setDate(nextDate.getDate() + daysUntilTarget);

    return nextDate;
  }

  // Processar cards não atendidos e enviar para telemarketing
  async processOverdueCards(): Promise<{
    processedCount: number;
    sentToTelemarketing: number;
    transferred: number;
    errors: string[];
  }> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Buscar cards pendentes que deveriam ter sido atendidos ontem
      const overdueCards = await db
        .select()
        .from(salesCards)
        .where(
          and(
            eq(salesCards.status, 'pending'),
            gte(salesCards.scheduledDate, yesterday),
            lte(salesCards.scheduledDate, today)
          )
        );

      // Buscar cards de telemarketing não atendidos ontem
      const overdueTelemarketingCards = await db
        .select()
        .from(salesCards)
        .where(
          and(
            eq(salesCards.status, 'telemarketing'),
            gte(salesCards.scheduledDate, yesterday),
            lte(salesCards.scheduledDate, today)
          )
        );

      let processedCount = 0;
      let sentToTelemarketing = 0;
      let transferred = 0;
      const errors: string[] = [];

      // Processar cards normais para telemarketing (primeira tentativa)
      for (const card of overdueCards) {
        try {
          // Atribuir ao próximo atendente de telemarketing
          const assignedAgent = await this.getNextTelemarketingAgent();
          
          if (assignedAgent) {
            // Adicionar prefixo RESGATE ao nome do cliente
            const customer = await this.getCustomer(card.customerId);
            const newNotes = `RESGATE - ${customer?.name || 'Cliente'}\n${card.notes || ''}`;

            await db.update(salesCards)
              .set({
                status: 'telemarketing',
                telemarketingAssignedTo: assignedAgent.id,
                telemarketingDate: new Date(),
                scheduledDate: today,
                notes: newNotes,
                updatedAt: new Date()
              })
              .where(eq(salesCards.id, card.id));

            sentToTelemarketing++;
          } else {
            errors.push(`Nenhum atendente de telemarketing disponível para o card ${card.id}`);
          }

          processedCount++;
        } catch (error: any) {
          errors.push(`Erro ao processar card ${card.id}: ${error.message}`);
        }
      }

      // Processar cards de telemarketing não atendidos (segunda tentativa = transferir cliente)
      for (const card of overdueTelemarketingCards) {
        try {
          if (card.telemarketingAssignedTo) {
            const customer = await this.getCustomer(card.customerId);
            
            // Alterar prefixo para TRANSFERIDO
            const newNotes = card.notes?.replace('RESGATE', 'TRANSFERIDO') || `TRANSFERIDO - ${customer?.name || 'Cliente'}`;
            
            // Transferir cliente definitivamente para o atendente de telemarketing
            await this.updateCustomer(card.customerId, {
              sellerId: card.telemarketingAssignedTo // Atendente de telemarketing vira o novo vendedor
            });

            // Atualizar card
            await db.update(salesCards)
              .set({
                status: 'transferred',
                sellerId: card.telemarketingAssignedTo, // Atendente vira novo vendedor do card
                scheduledDate: today,
                notes: newNotes,
                updatedAt: new Date()
              })
              .where(eq(salesCards.id, card.id));

            transferred++;
          }

          processedCount++;
        } catch (error: any) {
          errors.push(`Erro ao transferir card ${card.id}: ${error.message}`);
        }
      }

      return {
        processedCount,
        sentToTelemarketing,
        transferred,
        errors
      };

    } catch (error) {
      console.error('Erro ao processar cards em atraso:', error);
      throw error;
    }
  }

  // Obter próximo agente de telemarketing na fila (round-robin)
  async getNextTelemarketingAgent(): Promise<any> {
    try {
      // Buscar agentes ativos ordenados por última atribuição
      const agents = await db.execute(sql`
        SELECT * FROM telemarketing_agents 
        WHERE is_active = true 
        AND (current_cards_count < max_cards_per_day OR max_cards_per_day IS NULL)
        ORDER BY COALESCE(last_assigned_at, '1900-01-01'::timestamp) ASC, created_at ASC
        LIMIT 1
      `);

      if (agents.rows.length === 0) {
        return null;
      }

      const agent = agents.rows[0];

      // Atualizar contadores do agente
      await db.execute(sql`
        UPDATE telemarketing_agents 
        SET 
          current_cards_count = current_cards_count + 1,
          last_assigned_at = NOW(),
          updated_at = NOW()
        WHERE id = ${agent.id}
      `);

      return agent;
    } catch (error) {
      console.error('Erro ao obter próximo agente de telemarketing:', error);
      return null;
    }
  }

  // Finalizar card de venda e criar próximo (se recorrente)
  async completeRecurringSalesCard(cardId: string, outcome: 'sale' | 'no_sale', saleValue?: number): Promise<{
    completedCard: SalesCard;
    nextCard?: SalesCard;
  }> {
    const card = await this.getSalesCard(cardId);
    if (!card) {
      throw new Error('Sales card not found');
    }

    // Marcar card como completed
    const [completedCard] = await db.update(salesCards)
      .set({
        status: 'completed',
        completedDate: new Date(),
        saleValue: outcome === 'sale' ? (saleValue ? saleValue.toString() : card.saleValue) : null,
        updatedAt: new Date()
      } as any)
      .where(eq(salesCards.id, cardId))
      .returning();

    let nextCard: SalesCard | undefined;

    // Se foi venda e card é recorrente, criar próximo card
    if (outcome === 'sale' && card.isRecurring) {
      nextCard = await this.createNextRecurringCard(completedCard);
    }

    return {
      completedCard,
      nextCard
    };
  }

  // System settings methods
  async getSystemSettings(): Promise<any[]> {
    return await db.select().from(systemSettings);
  }

  async upsertSystemSetting(setting: any): Promise<any> {
    const [result] = await db
      .insert(systemSettings)
      .values(setting)
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: setting.value,
          description: setting.description,
          updatedBy: setting.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async getSalesCardById(id: string): Promise<SalesCardWithRelations | undefined> {
    const result = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(eq(salesCards.id, id));

    if (result.length === 0) return undefined;

    const row = result[0];
    return {
      ...row.sales_cards,
      customer: row.customers,
      seller: row.users,
    } as SalesCardWithRelations;
  }

  // Location operations
  async getLocations(): Promise<Location[]> {
    return await db.select().from(locations).where(eq(locations.isActive, true)).orderBy(locations.fantasyName);
  }

  async getLocation(id: string): Promise<Location | undefined> {
    const [location] = await db.select().from(locations).where(eq(locations.id, id));
    return location;
  }

  async createLocation(location: InsertLocation): Promise<Location> {
    const [newLocation] = await db.insert(locations).values(location).returning();
    return newLocation;
  }

  async updateLocation(id: string, location: Partial<InsertLocation>): Promise<Location> {
    const [updatedLocation] = await db
      .update(locations)
      .set({ ...location, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning();
    return updatedLocation;
  }

  async deleteLocation(id: string): Promise<void> {
    await db.update(locations).set({ isActive: false }).where(eq(locations.id, id));
  }

  async getLocationByCpfCnpj(cpfCnpj: string): Promise<Location | undefined> {
    const [location] = await db.select().from(locations).where(eq(locations.cpfCnpj, cpfCnpj));
    return location;
  }

  async bulkCreateLocations(locationsData: InsertLocation[]): Promise<Location[]> {
    try {
      // Inserir todas as localizações em uma única operação
      const insertedLocations = await db.insert(locations).values(locationsData).returning();
      return insertedLocations;
    } catch (error) {
      console.error('Erro ao inserir localizações em lote:', error);
      throw error;
    }
  }

  // Atualizar coordenadas dos clientes baseado nas localizações cadastradas
  async updateCustomerCoordinatesFromLocations(): Promise<{ updated: number; matched: number; total: number }> {
    try {
      // Buscar todas as localizações ativas
      const allLocations = await db.select().from(locations).where(eq(locations.isActive, true));
      
      let updated = 0;
      let matched = 0;
      
      for (const location of allLocations) {
        // Buscar clientes que tenham o mesmo CPF/CNPJ
        const matchingCustomers = await db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.omieStatus, 'ativo'),
              or(
                eq(customers.cpf, location.cpfCnpj),
                eq(customers.cnpj, location.cpfCnpj)
              )
            )
          );

        matched += matchingCustomers.length;

        // Atualizar coordenadas dos clientes encontrados
        for (const customer of matchingCustomers) {
          await db
            .update(customers)
            .set({
              latitude: location.latitude,
              longitude: location.longitude,
              updatedAt: new Date()
            })
            .where(eq(customers.id, customer.id));
          
          updated++;
        }
      }

      return {
        updated,
        matched,
        total: allLocations.length
      };
    } catch (error) {
      console.error('Erro ao atualizar coordenadas dos clientes:', error);
      throw error;
    }
  }

  // Sales Goals operations
  async getSalesGoals(sellerId?: string, month?: number, year?: number): Promise<SalesGoal[]> {
    const conditions = [];

    if (sellerId) {
      conditions.push(eq(salesGoals.sellerId, sellerId));
    }
    if (month) {
      conditions.push(eq(salesGoals.month, month));
    }
    if (year) {
      conditions.push(eq(salesGoals.year, year));
    }
    
    const baseQuery = db.select().from(salesGoals);
    const queryWithConditions = conditions.length > 0 ? 
      baseQuery.where(and(...conditions)) : 
      baseQuery;

    return await queryWithConditions.orderBy(desc(salesGoals.year), desc(salesGoals.month));
  }

  async getSalesGoal(id: string): Promise<SalesGoal | undefined> {
    const [goal] = await db.select().from(salesGoals).where(eq(salesGoals.id, id));
    return goal;
  }

  async getSalesGoalBySeller(sellerId: string, month: number, year: number): Promise<SalesGoal | undefined> {
    const [goal] = await db.select().from(salesGoals)
      .where(and(
        eq(salesGoals.sellerId, sellerId),
        eq(salesGoals.month, month),
        eq(salesGoals.year, year)
      ));
    return goal;
  }

  async createSalesGoal(goalData: InsertSalesGoal): Promise<SalesGoal> {
    const [goal] = await db.insert(salesGoals).values(goalData).returning();
    return goal;
  }

  async updateSalesGoal(id: string, goalData: Partial<InsertSalesGoal>): Promise<SalesGoal> {
    const [goal] = await db.update(salesGoals)
      .set({ ...goalData, updatedAt: sql`now()` })
      .where(eq(salesGoals.id, id))
      .returning();
    if (!goal) {
      throw new Error('Meta não encontrada');
    }
    return goal;
  }

  async deleteSalesGoal(id: string): Promise<void> {
    await db.delete(salesGoals).where(eq(salesGoals.id, id));
  }

  // Sales Metrics operations
  async getSalesMetrics(sellerId?: string, month?: number, year?: number): Promise<any> {
    try {
      console.log(`📊 getSalesMetrics chamado:`, { sellerId, month, year });
      console.log(`  Verificando tabela billings:`, { 
        definida: !!billings,
        tipo: typeof billings,
        keys: billings ? Object.keys(billings).slice(0, 5) : 'undefined'
      });
      
      // Usar timezone de Brasília (UTC-3)
      const now = new Date();
      const brasiliaOffset = -3 * 60; // UTC-3 em minutos
      const currentDate = new Date(now.getTime() + (now.getTimezoneOffset() + brasiliaOffset) * 60000);
      
      const targetMonth = month || (currentDate.getMonth() + 1);
      const targetYear = year || currentDate.getFullYear();
      
      console.log(`  📅 Data atual (Brasília):`, currentDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
      
      // Normalizar sellerId: billings usa ID numérico, mas customers/users usam prefixo "omie-vendor-"
      const numericSellerId = sellerId ? sellerId.replace('omie-vendor-', '') : undefined;
      const prefixedSellerId = sellerId; // Mantém o ID original com prefixo para queries de customers
      
      console.log(`  IDs normalizados:`, { numericSellerId, prefixedSellerId });
      
      // Feriados nacionais brasileiros (formato: 'YYYY-MM-DD')
      const nationalHolidays = new Set([
        // 2025
        '2025-01-01', // Ano Novo
        '2025-02-24', // Carnaval (segunda)
        '2025-02-25', // Carnaval (terça)
        '2025-04-18', // Paixão de Cristo
        '2025-04-21', // Tiradentes
        '2025-05-01', // Dia do Trabalho
        '2025-06-19', // Corpus Christi
        '2025-09-07', // Independência
        '2025-10-12', // Nossa Senhora Aparecida
        '2025-11-02', // Finados
        '2025-11-15', // Proclamação da República
        '2025-11-20', // Consciência Negra
        '2025-12-25', // Natal
        // 2026 (adicionar conforme necessário)
        '2026-01-01',
        '2026-02-16',
        '2026-02-17',
        '2026-04-03',
        '2026-04-21',
        '2026-05-01',
        '2026-06-04',
        '2026-09-07',
        '2026-10-12',
        '2026-11-02',
        '2026-11-15',
        '2026-11-20',
        '2026-12-25'
      ]);
      
      // Calcular dias úteis do mês (segunda a sexta, excluindo sábados, domingos e feriados)
      const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
      const workingDays = [];
      
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(targetYear, targetMonth - 1, day);
        const dayOfWeek = date.getDay(); // 0=domingo, 1=segunda, ..., 6=sábado
        const dateStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        // Incluir apenas segunda (1) a sexta (5), excluindo sábados (6), domingos (0) e feriados
        if (dayOfWeek >= 1 && dayOfWeek <= 5 && !nationalHolidays.has(dateStr)) {
          workingDays.push(date);
        }
      }
      
      const workingDaysInMonth = workingDays.length;
      const workingDaysElapsed = workingDays.filter(date => date <= currentDate).length;
      
      console.log(`  📆 DIAS ÚTEIS:`, {
        mes: `${targetMonth}/${targetYear}`,
        totalDiasUteis: workingDaysInMonth,
        diasDecorridos: workingDaysElapsed,
        diaAtual: currentDate.getDate()
      });
      
      // Data range for the month
      const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
      const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59);
      
      // IMPORTANTE: Se estivermos no mês atual, buscar apenas até a data atual
      // Caso contrário, buscar até o final do mês
      const isCurrentMonth = currentDate.getMonth() === (targetMonth - 1) && currentDate.getFullYear() === targetYear;
      const searchEndDate = isCurrentMonth ? currentDate : endOfMonth;
      
      // === 1. POSITIVAÇÃO: Clientes únicos que tiveram venda no mês (via faturamentos) ===
      const billingConditions = [];
      
      if (numericSellerId) {
        billingConditions.push(eq(billings.sellerId, numericSellerId));
      }
      
      billingConditions.push(
        and(
          gte(billings.invoiceDate, startOfMonth),
          lte(billings.invoiceDate, searchEndDate)
        )
      );

      // Buscar faturamentos do mês usando SQL raw para evitar problemas do Drizzle
      console.log(`  Buscando faturamentos para:`, { 
        numericSellerId, 
        startOfMonth, 
        searchEndDate,
        isCurrentMonth,
        note: isCurrentMonth ? 'Usando data atual como limite' : 'Usando fim do mês como limite'
      });
      console.log(`  Tipo de numericSellerId:`, typeof numericSellerId, 'Valor:', numericSellerId);
      
      const monthBillings = await db.execute(sql`
        SELECT id, customer_document, cfop, total_value, seller_id, billing_type
        FROM billings
        WHERE invoice_date >= ${startOfMonth}
          AND invoice_date <= ${searchEndDate}
          AND invoice_status = '100'
          AND is_cancelled = false
          AND billing_type IN ('venda', 'devolução')
          ${numericSellerId ? sql`AND seller_id = ${numericSellerId}` : sql``}
      `);
      
      console.log(`  ✅ Faturamentos encontrados: ${monthBillings.rows.length}`);
      if (monthBillings.rows.length > 0) {
        console.log(`    Amostra (3 primeiros):`, monthBillings.rows.slice(0, 3).map((r: any) => ({
          seller_id: r.seller_id,
          total_value: r.total_value,
          cfop: r.cfop
        })));
      }

      // Clientes únicos positivados (que tiveram venda)
      const uniqueCustomers = new Set(monthBillings.rows.map((b: any) => b.customer_document));
      const positivatedCustomers = uniqueCustomers.size;

      // Total de clientes ativos na carteira do vendedor
      let totalCustomersInRoute = 0;
      if (prefixedSellerId) {
        const routeCustomersResult = await db.execute(sql`
          SELECT id FROM customers
          WHERE seller_id = ${prefixedSellerId}
            AND omie_status = 'ativo'
            AND virtual_service = false
        `);
        totalCustomersInRoute = routeCustomersResult.rows.length;
      }

      const positivationRate = totalCustomersInRoute > 0 
        ? (positivatedCustomers / totalCustomersInRoute) * 100 
        : 0;

      // === 2. VENDAS: Somar faturamentos INCLUINDO apenas CFOPs de venda ===
      // CFOPs a INCLUIR (mesma lógica do Omie):
      // - 5.101 / 5101: Venda de Producao do Estabelecimento
      // - 1.201 / 1201: Devolucao de Venda de Producao do Estabelecimento
      const includedCFOPs = [
        '5.101', '5101',  // Venda de produção
        '1.201', '1201'   // Devolução de venda
      ];

      const validBillings = monthBillings.rows.filter((billing: any) => {
        const cfop = (billing.cfop ?? '').toString().trim();
        // IMPORTANTE: Se CFOP estiver vazio/null, incluir o billing
        // Caso contrário, aplicar filtro de CFOPs permitidos
        if (cfop === '') {
          return true; // Incluir quando CFOP não está preenchido
        }
        return includedCFOPs.includes(cfop);
      });
      
      console.log(`  🔍 FILTRO CFOP:`, {
        total: monthBillings.rows.length,
        afterFilter: validBillings.length,
        excluded: monthBillings.rows.length - validBillings.length,
        nullCfops: monthBillings.rows.filter((b: any) => !b.cfop).length,
        sample: monthBillings.rows.slice(0, 2).map((b: any) => ({
          cfop: b.cfop,
          isEmpty: !b.cfop || b.cfop.trim() === ''
        }))
      });

      const totalRevenue = validBillings.reduce((sum: number, billing: any) => {
        const value = parseFloat(billing.total_value?.toString() || '0');
        return sum + (isNaN(value) ? 0 : value);
      }, 0);

      const dailyAverageRevenue = workingDaysElapsed > 0 ? totalRevenue / workingDaysElapsed : 0;
      const revenueProjection = dailyAverageRevenue * workingDaysInMonth;
      
      console.log(`  💰 FATURAMENTO:`, {
        totalRevenue: totalRevenue.toFixed(2),
        validBillings: validBillings.length,
        dailyAverage: dailyAverageRevenue.toFixed(2),
        projection: revenueProjection.toFixed(2)
      });

      // === 3. DÉBITO VENCIDO: Soma dos débitos vencidos / Projeção de faturamento ===
      let overdueDebtRatio = 0;
      
      if (prefixedSellerId && revenueProjection > 0) {
        // Buscar débitos vencidos da carteira usando JOIN
        const overdueDebtsResult = await db.execute(sql`
          SELECT 
            od.client_document,
            od.total_amount
          FROM overdue_debts od
          INNER JOIN customers c ON (
            REPLACE(REPLACE(REPLACE(od.client_document, '.', ''), '-', ''), '/', '') = 
            COALESCE(c.cpf, c.cnpj)
          )
          WHERE c.seller_id = ${prefixedSellerId}
            AND c.omie_status = 'ativo'
        `);

        const totalOverdueDebt = overdueDebtsResult.rows.reduce((sum: number, debt: any) => {
          const value = parseFloat(debt.total_amount?.toString() || '0');
          return sum + (isNaN(value) ? 0 : value);
        }, 0);

        if (totalOverdueDebt > 0) {
          overdueDebtRatio = (totalOverdueDebt / revenueProjection) * 100;
        }
        
        console.log(`  📉 DÉBITO VENCIDO:`, {
          totalOverdueDebt: totalOverdueDebt.toFixed(2),
          revenueProjection: revenueProjection.toFixed(2),
          overdueDebtRatio: overdueDebtRatio.toFixed(2) + '%',
          overdueDebtsCount: overdueDebtsResult.rows.length,
          formula: `${totalOverdueDebt.toFixed(2)} / ${revenueProjection.toFixed(2)} * 100`
        });
      }

      // === 4. META DE ATENDIMENTO: Média do percentual de visitas completadas vs agendadas ===
      // Calcular baseado em daily_routes (visitas agendadas) e route_checkpoints (visitas completadas)
      
      // Construir condições de filtro
      const routeConditions = [
        gte(dailyRoutes.routeDate, startOfMonth),
        lte(dailyRoutes.routeDate, endOfMonth),
        lte(dailyRoutes.routeDate, currentDate) // Apenas rotas até hoje
      ];
      
      // Adicionar filtro de seller apenas se especificado
      if (prefixedSellerId) {
        routeConditions.push(eq(dailyRoutes.sellerId, prefixedSellerId));
      }
      
      // Buscar todas as rotas diárias do mês (apenas dias já decorridos)
      const routes = await db.select({
        id: dailyRoutes.id,
        routeDate: dailyRoutes.routeDate,
        optimizedOrder: dailyRoutes.optimizedOrder,
        totalVisits: dailyRoutes.totalVisits
      })
      .from(dailyRoutes)
      .where(and(...routeConditions))
      .orderBy(desc(dailyRoutes.routeDate));

      const dailyServiceRates: number[] = [];
      
      // Para cada rota do mês (apenas dias já decorridos), calcular o percentual de atendimento
      for (const route of routes) {
        const visitIdsArray = (route.optimizedOrder as string[] | null) || [];
        const scheduledVisits = visitIdsArray.length;
        
        if (scheduledVisits === 0) continue;
        
        // Contar visitas completadas (checkpoints com check_out)
        const checkpoints = await db.select({
          id: routeCheckpoints.id
        })
        .from(routeCheckpoints)
        .where(
          and(
            eq(routeCheckpoints.dailyRouteId, route.id),
            eq(routeCheckpoints.checkpointType, 'check_out')
          )
        );
        
        const completedVisits = checkpoints.length;
        const dayServiceRate = (completedVisits / scheduledVisits) * 100;
        dailyServiceRates.push(dayServiceRate);
      }

      // Média dos percentuais diários (apenas dias com rotas)
      const serviceRate = dailyServiceRates.length > 0
        ? dailyServiceRates.reduce((sum, rate) => sum + rate, 0) / dailyServiceRates.length
        : 0;
      
      console.log(`  📈 ATENDIMENTO (RH):`, {
        totalRoutes: routes.length,
        daysWithData: dailyServiceRates.length,
        dailyRates: dailyServiceRates.map(r => r.toFixed(1) + '%').join(', '),
        serviceRate: serviceRate.toFixed(2) + '%'
      });

      console.log(`  📊 RESUMO FINAL:`, {
        sellerId: prefixedSellerId,
        positivationRate: positivationRate.toFixed(2) + '%',
        totalRevenue: totalRevenue.toFixed(2),
        revenueProjection: revenueProjection.toFixed(2),
        overdueDebtRatio: overdueDebtRatio.toFixed(2) + '%',
        serviceRate: serviceRate.toFixed(2) + '%'
      });

      return {
        positivationRate,
        totalRevenue,
        revenueProjection,
        overdueDebtRatio,
        serviceRate,
        workingDaysInMonth,
        workingDaysElapsed,
        positivatedCustomers,
        totalCustomersInRoute,
        dailyAverageRevenue,
        totalBillings: monthBillings.rows.length,
        validBillings: validBillings.length
      };
    } catch (error) {
      console.error('Erro ao calcular métricas de vendas:', error);
      throw error;
    }
  }

  // Billing operations
  async getBillings(sellerId?: string): Promise<Billing[]> {
    const baseQuery = db.select().from(billings);
    
    // Filtrar notas canceladas e aplicar filtro de sellerId se fornecido
    const conditions = [eq(billings.isCancelled, false)];
    if (sellerId) {
      conditions.push(eq(billings.sellerId, sellerId));
    }
    
    const result = await baseQuery
      .where(and(...conditions))
      .orderBy(desc(billings.invoiceDate));
    return result;
  }

  async getBilling(id: string): Promise<Billing | undefined> {
    const [billing] = await db
      .select()
      .from(billings)
      .where(eq(billings.id, id));
    return billing;
  }

  async getBillingByOmieId(omieInvoiceId: string): Promise<Billing | undefined> {
    const [billing] = await db
      .select()
      .from(billings)
      .where(eq(billings.omieInvoiceId, omieInvoiceId));
    return billing;
  }

  async getBillingByOrderId(omieOrderId: string): Promise<Billing | undefined> {
    const [billing] = await db
      .select()
      .from(billings)
      .where(eq(billings.omieOrderId, omieOrderId));
    return billing;
  }

  async getBillingByInvoiceNumber(invoiceNumber: string): Promise<Billing | undefined> {
    const [billing] = await db
      .select()
      .from(billings)
      .where(eq(billings.invoiceNumber, invoiceNumber));
    return billing;
  }

  async getAllBillings(): Promise<Billing[]> {
    const result = await db
      .select()
      .from(billings)
      .orderBy(desc(billings.invoiceDate));
    return result;
  }

  async createBilling(billing: InsertBilling): Promise<Billing> {
    const [newBilling] = await db
      .insert(billings)
      .values(billing as any)
      .returning();
    return newBilling;
  }

  async updateBilling(id: string, billing: Partial<InsertBilling>): Promise<Billing> {
    const [updatedBilling] = await db
      .update(billings)
      .set({ ...billing as any, updatedAt: new Date() })
      .where(eq(billings.id, id))
      .returning();
    return updatedBilling;
  }

  async updateBillingUrgency(id: string, isUrgent: boolean): Promise<Billing> {
    const [updatedBilling] = await db
      .update(billings)
      .set({ isUrgent, updatedAt: new Date() })
      .where(eq(billings.id, id))
      .returning();
    
    if (!updatedBilling) {
      throw new Error(`Billing with id ${id} not found`);
    }
    
    return updatedBilling;
  }

  async deleteBilling(id: string): Promise<void> {
    await db
      .delete(billings)
      .where(eq(billings.id, id));
  }

  async getBillingsWithFilters(filters: {
    sellerId?: string;
    startDate?: Date;
    endDate?: Date;
    customerDocument?: string;
    invoiceNumber?: string;
    cfop?: string;
    invoiceStage?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ billings: Billing[]; total: number }> {
    const { sellerId, startDate, endDate, customerDocument, invoiceNumber, cfop, invoiceStage, page = 1, pageSize = 50 } = filters;
    
    let conditions: any[] = [];
    
    // FILTRO PRINCIPAL: Apenas pedidos JÁ FATURADOS (com nota fiscal)
    conditions.push(and(
      isNotNull(billings.invoiceNumber),
      ne(billings.invoiceNumber, '')
    ));
    
    if (sellerId) {
      conditions.push(eq(billings.sellerId, sellerId));
    }
    
    if (startDate) {
      conditions.push(gte(billings.invoiceDate, startDate));
    }
    
    if (endDate) {
      conditions.push(lte(billings.invoiceDate, endDate));
    }
    
    if (customerDocument) {
      conditions.push(eq(billings.customerDocument, customerDocument));
    }
    
    if (invoiceNumber) {
      // Busca parcial normalizada: apenas dígitos, tanto no campo quanto no valor buscado
      const digitsOnly = invoiceNumber.replace(/\D/g, '');
      if (digitsOnly) {
        conditions.push(
          or(
            // Buscar em invoice_number normalizado
            sql`regexp_replace(${billings.invoiceNumber}, '[^0-9]', '', 'g') ILIKE ${'%' + digitsOnly + '%'}`,
            // Buscar também em order_number normalizado
            sql`regexp_replace(${billings.orderNumber}, '[^0-9]', '', 'g') ILIKE ${'%' + digitsOnly + '%'}`
          )
        );
      }
    }
    
    if (cfop) {
      // Normalizar input para robustez (uppercase, trim)
      const normalizedInput = cfop.trim().toUpperCase();
      
      // Mapear tipos para múltiplos CFOPs (incluindo formatos com e sem pontos)
      const cfopGroups: Record<string, string[]> = {
        'VENDA': ['5.102', '5.101', '6.102', '6.101', '5102', '5101', '6102', '6101'],
        'TROCA': ['5.949', '6.949', '5949', '6949'],
        'AMOSTRA': ['5.911', '6.911', '5911', '6911'],
        'BONIFICAÇÃO': ['5.910', '6.910', '5.915', '5910', '6910', '5915'],
        'ENTRADA': ['1.102', '1.202', '1102', '1202'],
        'DEVOLUÇÃO': ['2.556', '1.556', '1.201', '2556', '1556', '1201']
      };

      const cfopCodes = cfopGroups[normalizedInput];
      if (cfopCodes) {
        // Filtrar por múltiplos CFOPs (OR condition)
        const cfopConditions = cfopCodes.map(code => eq(billings.cfop, code));
        conditions.push(or(...cfopConditions));
      } else {
        // Filtro direto por CFOP específico - normalizar formato (com/sem pontos)
        const normalizedCfop = normalizedInput.replace(/\./g, ''); // Remove pontos
        
        if (normalizedCfop.length === 4 && /^\d{4}$/.test(normalizedCfop)) {
          // CFOP válido de 4 dígitos - testar com e sem ponto
          const withDot = normalizedCfop.replace(/(\d)(\d{3})/, '$1.$2');
          conditions.push(
            or(
              eq(billings.cfop, normalizedInput), // Formato original
              eq(billings.cfop, normalizedCfop), // Sem pontos
              eq(billings.cfop, withDot) // Com ponto
            )
          );
        } else {
          // Busca flexível para formatos inesperados
          conditions.push(
            or(
              eq(billings.cfop, normalizedInput),
              sql`${billings.cfop} ILIKE ${'%' + normalizedCfop + '%'}`
            )
          );
        }
      }
    }
    
    if (invoiceStage) {
      conditions.push(eq(billings.invoiceStage, invoiceStage));
    }
    
    // Query com filtros
    const baseQuery = db.select().from(billings);
    
    const query = conditions.length > 0 ? 
      baseQuery.where(and(...conditions)) : 
      baseQuery;
    
    // Contar total de registros
    const totalQuery = db.select({ count: sql`count(*)` }).from(billings);
    const totalWithConditions = conditions.length > 0 ? 
      totalQuery.where(and(...conditions)) : 
      totalQuery;
    
    const [countResult] = await totalWithConditions;
    const total = parseInt(countResult.count?.toString() || '0');
    
    // Aplicar paginação e ordenação
    const offset = (page - 1) * pageSize;
    const paginatedQuery = query
      .orderBy(desc(billings.invoiceDate))
      .limit(pageSize)
      .offset(offset);
    
    const result = await paginatedQuery;
    
    return {
      billings: result,
      total
    };
  }

  async getUniqueSellers(): Promise<Array<{seller_id: string; seller_name: string}>> {
    const result = await db
      .select({
        seller_id: billings.sellerId,
        seller_name: billings.sellerName
      })
      .from(billings)
      .where(and(
        isNotNull(billings.sellerId),
        isNotNull(billings.sellerName),
        ne(billings.sellerId, ''),
        ne(billings.sellerName, '')
      ))
      .groupBy(billings.sellerId, billings.sellerName)
      .orderBy(billings.sellerName);
    
    return result.map(row => ({
      seller_id: row.seller_id || '',
      seller_name: row.seller_name || ''
    }));
  }

  async getBillingsStats(filters: {
    sellerId?: string;
    startDate?: Date;
    endDate?: Date;
    customerDocument?: string;
    invoiceNumber?: string;
    cfop?: string;
    invoiceStage?: string;
  }): Promise<{
    totalInvoices: number;
    totalValue: number;
    averageValue: number;
    paymentMethods: Record<string, { count: number; total: number }>;
  }> {
    // Construir condições WHERE baseado nos filtros
    const conditions: any[] = [];

    if (filters.sellerId) {
      conditions.push(eq(billings.sellerId, filters.sellerId));
    }

    if (filters.startDate) {
      conditions.push(gte(billings.invoiceDate, filters.startDate));
    }

    if (filters.endDate) {
      conditions.push(lte(billings.invoiceDate, filters.endDate));
    }

    if (filters.customerDocument) {
      conditions.push(like(billings.customerDocument, `%${filters.customerDocument}%`));
    }

    if (filters.invoiceNumber) {
      conditions.push(like(billings.invoiceNumber, `%${filters.invoiceNumber}%`));
    }

    if (filters.cfop) {
      // Mapear nome amigável para valores reais de CFOP
      const cfopValues: Record<string, string[]> = {
        'VENDA': ['5.101', '5.102', '6.101', '6.102', '5101', '5102', '6101', '6102'],
        'TROCA': ['5.949', '6.949', '5949', '6949'],
        'AMOSTRA': ['5.911', '6.911', '5911', '6911'],
        'BONIFICAÇÃO': ['5.910', '6.910', '5.915', '5910', '6910', '5915'],
        'ENTRADA': ['1.102', '1.202', '1102', '1202'],
        'DEVOLUÇÃO': ['1.151', '1.201', '1.556', '2.556', '1151', '1201', '1556', '2556']
      };

      if (cfopValues[filters.cfop]) {
        const cfopConditions = cfopValues[filters.cfop].map(cfopValue => 
          eq(billings.cfop, cfopValue)
        );
        conditions.push(or(...cfopConditions));
      }
    }

    if (filters.invoiceStage) {
      conditions.push(eq(billings.invoiceStage, filters.invoiceStage));
    }

    // Query para estatísticas básicas usando SQL aggregates
    const baseQuery = db.select({
      totalInvoices: sql<number>`COUNT(*)`,
      totalValue: sql<number>`COALESCE(SUM(CAST(${billings.totalValue} AS NUMERIC)), 0)`,
      averageValue: sql<number>`COALESCE(AVG(CAST(${billings.totalValue} AS NUMERIC)), 0)`
    }).from(billings);

    const statsWithConditions = conditions.length > 0 ? 
      baseQuery.where(and(...conditions)) : 
      baseQuery;

    const [statsResult] = await statsWithConditions;

    // Query separada para métodos de pagamento (GROUP BY)
    const paymentQuery = db.select({
      paymentMethod: billings.paymentMethod,
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(CAST(${billings.totalValue} AS NUMERIC)), 0)`
    }).from(billings);

    const paymentWithConditions = conditions.length > 0 ? 
      paymentQuery.where(and(...conditions)) : 
      paymentQuery;

    const paymentResults = await paymentWithConditions
      .groupBy(billings.paymentMethod);

    // Processar resultados dos métodos de pagamento
    const paymentMethods: Record<string, { count: number; total: number }> = {};
    
    for (const result of paymentResults) {
      const method = result.paymentMethod || 'Não informado';
      paymentMethods[method] = {
        count: parseInt(result.count.toString()),
        total: parseFloat(result.total.toString())
      };
    }

    return {
      totalInvoices: parseInt(statsResult.totalInvoices.toString()),
      totalValue: parseFloat(statsResult.totalValue.toString()),
      averageValue: parseFloat(statsResult.averageValue.toString()),
      paymentMethods
    };
  }

  async upsertBilling(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<Billing> {
    // Verificar se já existe
    const existing = await this.getBillingByOmieId(billing.omieInvoiceId);
    
    if (existing) {
      // Atualizar existente
      return this.updateBilling(existing.id, billing);
    } else {
      // Criar novo
      return this.createBilling(billing as InsertBilling);
    }
  }

  async saveBillingIfValid(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<{
    success: boolean;
    billing?: Billing;
    reason?: string;
    action?: 'created' | 'updated' | 'skipped';
  }> {
    try {
      console.log(`🔍 Validando billing para omieInvoiceId: ${billing.omieInvoiceId}`);
      console.log(`🔧 DEBUG VALIDATION INPUT: invoiceStatus=${JSON.stringify(billing.invoiceStatus)}, type=${typeof billing.invoiceStatus}`);
      
      // Validação 1: Status da nota fiscal - aceitar autorizadas (100/150) E canceladas para dar etapa CANCELADO
      const invoiceStatus = billing.invoiceStatus?.toString().trim();
      console.log(`🔧 DEBUG VALIDATION PROCESSED: invoiceStatus="${invoiceStatus}"`);
      
      // Status códigos SEFAZ: 100=autorizada, 150=autorizada fora prazo, 101=cancelada, 135=evento cancelamento, 155=cancelada extemporânea
      const validStatuses = ['100', '150', '101', '135', '155']; // Apenas códigos essenciais: autorizadas e canceladas
      const isValidStatus = invoiceStatus && validStatuses.includes(invoiceStatus);
      const isCanceled = invoiceStatus && ['101', '135', '155'].includes(invoiceStatus); // Status de cancelamento
      
      if (!invoiceStatus || !isValidStatus) {
        // Só rejeitar se for realmente status inválido - não cancelado
        if (!invoiceStatus || (!invoiceStatus.match(/^\d+$/) || invoiceStatus.length > 3)) {
          const reason = `Status inválido: ${invoiceStatus || 'NULL'} (deve ser código SEFAZ numérico)`;
          console.log(`⚠️ REJEITADO - ${billing.invoiceNumber || billing.omieInvoiceId}: ${reason}`);
          return {
            success: false,
            reason,
            action: 'skipped'
          };
        } else {
          // Status numérico desconhecido - assumir como possível cancelamento e permitir
          console.log(`⚠️ Status desconhecido ${invoiceStatus} para NF ${billing.invoiceNumber} - processando como possível cancelada`);
        }
      }
      
      // NOVA LÓGICA: Dar etapa "CANCELADO" APENAS para notas realmente canceladas
      if (isCanceled) {
        console.log(`📋 Aplicando etapa CANCELADO para NF ${billing.invoiceNumber} (status cancelado: ${invoiceStatus})`);
        billing.invoiceStage = 'CANCELADO';
      }
      
      // Validação 2: Data da nota fiscal deve ser válida
      if (!billing.invoiceDate) {
        const reason = 'Data da nota fiscal não informada';
        console.log(`⚠️ REJEITADO - ${billing.invoiceNumber || billing.omieInvoiceId}: ${reason}`);
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      const invoiceDate = new Date(billing.invoiceDate);
      
      // Validação básica de data válida (sem restrição de período)
      if (isNaN(invoiceDate.getTime())) {
        const reason = `Data inválida: ${billing.invoiceDate}`;
        console.log(`⚠️ REJEITADO - ${billing.invoiceNumber || billing.omieInvoiceId}: ${reason}`);
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      // Validação 3: Verificar se tem número de nota fiscal
      if (!billing.invoiceNumber || billing.invoiceNumber.trim() === '') {
        const reason = 'Número da nota fiscal não informado';
        console.log(`⚠️ REJEITADO - ${billing.omieInvoiceId}: ${reason}`);
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      // Se passou em todas as validações, salvar no banco
      console.log(`✅ VÁLIDO - ${billing.invoiceNumber}: Status ${invoiceStatus}, Data ${invoiceDate.toISOString().split('T')[0]}`);
      
      // Verificar se já existe para determinar se é criação ou atualização
      // PRIORIDADE: Buscar primeiro por invoice_number (mais confiável e tem índice único)
      let existing = await this.getBillingByInvoiceNumber(billing.invoiceNumber!);
      
      // Fallback: Se não encontrou por invoice_number, buscar por omieInvoiceId
      if (!existing && billing.omieInvoiceId) {
        existing = await this.getBillingByOmieId(billing.omieInvoiceId);
      }
      
      let savedBilling: Billing;
      let action: 'created' | 'updated';
      
      if (existing) {
        savedBilling = await this.updateBilling(existing.id, billing);
        action = 'updated';
        console.log(`📝 ATUALIZADO - ${billing.invoiceNumber}: Billing ID ${existing.id}`);
      } else {
        savedBilling = await this.createBilling(billing as InsertBilling);
        action = 'created';
        console.log(`📝 CRIADO - ${billing.invoiceNumber}: Novo billing ID ${savedBilling.id}`);
      }
      
      return {
        success: true,
        billing: savedBilling,
        action
      };
      
    } catch (error) {
      const reason = `Erro interno: ${error instanceof Error ? error.message : 'Erro desconhecido'}`;
      console.error(`❌ ERRO ao processar ${billing.invoiceNumber || billing.omieInvoiceId}:`, error);
      return {
        success: false,
        reason,
        action: 'skipped'
      };
    }
  }

  // Métodos de entregas faltantes
  async getActiveDeliveryDrivers(): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT 
        id,
        name,
        phone,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM delivery_drivers
      WHERE is_active = true
      ORDER BY name
    `);
    return result.rows || [];
  }

  async updateDeliveryDriver(id: string, data: any): Promise<any> {
    const updateData: any = {};
    
    if (data.name !== undefined) updateData.name = data.name;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.vehicleType !== undefined) updateData.vehicleType = data.vehicleType;
    if (data.licensePlate !== undefined) updateData.licensePlate = data.licensePlate;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.currentLocation !== undefined) updateData.currentLocation = data.currentLocation;
    
    updateData.updatedAt = new Date();
    
    const [result] = await db
      .update(deliveryDrivers)
      .set(updateData)
      .where(eq(deliveryDrivers.id, id))
      .returning();
    
    return result;
  }

  async getDeliveryStats(period: string): Promise<any> {
    let dateCondition = "true";
    
    switch (period) {
      case "today":
        dateCondition = "DATE(scheduled_date) = CURRENT_DATE";
        break;
      case "week":
        dateCondition = "scheduled_date >= DATE_TRUNC('week', CURRENT_DATE)";
        break;
      case "month":
        dateCondition = "scheduled_date >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
    }

    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN delivery_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN delivery_status = 'in_transit' THEN 1 END) as in_transit,
        COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN delivery_status = 'returned' THEN 1 END) as returned
      FROM sales_cards 
      WHERE status = 'completed' AND ${sql.raw(dateCondition)}
    `);
    return result.rows[0] || { total: 0, pending: 0, in_transit: 0, delivered: 0, failed: 0, returned: 0 };
  }

  async getDeliveryMetrics(period: string): Promise<any> {
    let dateCondition = "true";
    
    switch (period) {
      case "today":
        dateCondition = "DATE(scheduled_date) = CURRENT_DATE";
        break;
      case "week":
        dateCondition = "scheduled_date >= DATE_TRUNC('week', CURRENT_DATE)";
        break;
      case "month":
        dateCondition = "scheduled_date >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
    }

    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as todayDeliveries,
        CASE 
          WHEN COUNT(*) > 0 THEN 
            ROUND(COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END)::numeric / COUNT(*)::numeric, 3)
          ELSE 0 
        END as successRate,
        '2h 30min' as averageDeliveryTime,
        (SELECT COUNT(*) FROM delivery_drivers WHERE is_active = true) as activeDrivers
      FROM sales_cards 
      WHERE status = 'completed' AND ${sql.raw(dateCondition)}
    `);
    
    const metrics = result.rows[0] || { todayDeliveries: 0, successRate: 0, averageDeliveryTime: 'N/A', activeDrivers: 0 };
    return {
      todayDeliveries: parseInt(metrics.todayDeliveries?.toString() || '0') || 0,
      successRate: parseFloat(metrics.successRate?.toString() || '0') || 0,
      averageDeliveryTime: metrics.averageDeliveryTime?.toString() || 'N/A',
      activeDrivers: parseInt(metrics.activeDrivers?.toString() || '0') || 0
    };
  }

  async getAllDeliveries(): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT 
        sc.*,
        c.name as customerName,
        c.address as customerAddress,
        c.phone as customerPhone,
        d.name as driverName
      FROM sales_cards sc
      JOIN customers c ON sc.customer_id = c.id
      LEFT JOIN delivery_drivers d ON sc.delivery_driver_id = d.id
      WHERE sc.status = 'completed'
      ORDER BY sc.scheduled_date DESC
    `);
    return result.rows || [];
  }

  async getDeliveryReport(period: string, startDate?: string, endDate?: string): Promise<any> {
    let dateCondition = "true";
    
    if (period === "custom" && startDate && endDate) {
      dateCondition = `scheduled_date BETWEEN '${startDate}' AND '${endDate}'`;
    } else {
      switch (period) {
        case "today":
          dateCondition = "DATE(scheduled_date) = CURRENT_DATE";
          break;
        case "week":
          dateCondition = "scheduled_date >= DATE_TRUNC('week', CURRENT_DATE)";
          break;
        case "month":
          dateCondition = "scheduled_date >= DATE_TRUNC('month', CURRENT_DATE)";
          break;
      }
    }

    const statsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as totalDeliveries,
        COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN delivery_status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN delivery_status = 'in_transit' THEN 1 END) as in_transit,
        COUNT(CASE WHEN delivery_status = 'returned' THEN 1 END) as returned,
        CASE 
          WHEN COUNT(*) > 0 THEN 
            COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END)::numeric / COUNT(*)::numeric
          ELSE 0 
        END as successRate
      FROM sales_cards 
      WHERE status = 'completed' AND ${sql.raw(dateCondition)}
    `);

    const topDriversResult = await db.execute(sql`
      SELECT 
        d.id as driverId,
        d.name as driverName,
        COUNT(*) as deliveries,
        CASE 
          WHEN COUNT(*) > 0 THEN 
            COUNT(CASE WHEN sc.delivery_status = 'delivered' THEN 1 END)::numeric / COUNT(*)::numeric
          ELSE 0 
        END as successRate
      FROM sales_cards sc
      JOIN delivery_drivers d ON sc.delivery_driver_id = d.id
      WHERE sc.status = 'completed' AND ${sql.raw(dateCondition)}
      GROUP BY d.id, d.name
      ORDER BY deliveries DESC, successRate DESC
      LIMIT 5
    `);

    const dailyStatsResult = await db.execute(sql`
      SELECT 
        DATE(scheduled_date) as date,
        COUNT(*) as deliveries,
        COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as success,
        COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as failed
      FROM sales_cards 
      WHERE status = 'completed' AND ${sql.raw(dateCondition)}
      GROUP BY DATE(scheduled_date)
      ORDER BY date DESC
      LIMIT 30
    `);

    const stats = statsResult.rows[0] || {};
    return {
      period,
      totalDeliveries: parseInt(stats.totalDeliveries?.toString() || '0') || 0,
      delivered: parseInt(stats.delivered?.toString() || '0') || 0,
      failed: parseInt(stats.failed?.toString() || '0') || 0,
      pending: parseInt(stats.pending?.toString() || '0') || 0,
      in_transit: parseInt(stats.in_transit?.toString() || '0') || 0,
      returned: parseInt(stats.returned?.toString() || '0') || 0,
      successRate: parseFloat(stats.successRate?.toString() || '0') || 0,
      averageDeliveryTime: "2h 30min",
      topDrivers: topDriversResult.rows || [],
      dailyStats: dailyStatsResult.rows || []
    };
  }

  async getDeliveryReportComparison(period: string): Promise<any> {
    // Implementação simplificada para comparação
    return {
      totalDeliveries: 0,
      successRate: 0,
      failed: 0
    };
  }

  async getDeliveryDriverStats(): Promise<any> {
    const result = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active,
        COUNT(CASE WHEN is_active = false THEN 1 END) as inactive
      FROM delivery_drivers
    `);
    return result.rows[0] || { total: 0, active: 0, inactive: 0 };
  }

  // Delivery routes operations
  async getDeliveryRoutes(filters?: { status?: string; routeDate?: Date; driverId?: string; savedOnly?: boolean }): Promise<any[]> {
    let query = db.select().from(deliveryRoutes);
    
    const conditions: any[] = [];
    if (filters?.status) {
      conditions.push(eq(deliveryRoutes.status, filters.status));
    }
    if (filters?.driverId) {
      conditions.push(eq(deliveryRoutes.driverId, filters.driverId));
    }
    if (filters?.routeDate) {
      conditions.push(eq(deliveryRoutes.routeDate, sql`${filters.routeDate}::date`));
    }
    if (filters?.savedOnly) {
      // Filtrar apenas rotas salvas (que têm routeName)
      conditions.push(isNotNull(deliveryRoutes.routeName));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    const routes = await query.orderBy(desc(deliveryRoutes.routeDate));
    
    // Buscar as paradas de cada rota
    const routesWithStops = await Promise.all(
      routes.map(async (route) => {
        const stops = await db
          .select()
          .from(deliveryRouteStops)
          .where(eq(deliveryRouteStops.routeId, route.id))
          .orderBy(deliveryRouteStops.stopOrder);
        
        return {
          ...route,
          stops
        };
      })
    );
    
    return routesWithStops;
  }

  async getDeliveryRoute(id: string): Promise<any | undefined> {
    const [route] = await db.select().from(deliveryRoutes).where(eq(deliveryRoutes.id, id));
    return route;
  }

  async createDeliveryRoute(route: any): Promise<any> {
    const [newRoute] = await db.insert(deliveryRoutes).values(route).returning();
    return newRoute;
  }

  async updateDeliveryRoute(id: string, route: any): Promise<any> {
    const [updated] = await db
      .update(deliveryRoutes)
      .set({ ...route, updatedAt: new Date() })
      .where(eq(deliveryRoutes.id, id))
      .returning();
    return updated;
  }

  async deleteDeliveryRoute(id: string): Promise<void> {
    await db.delete(deliveryRoutes).where(eq(deliveryRoutes.id, id));
  }

  async createDeliveryRouteStop(stop: any): Promise<any> {
    const [newStop] = await db.insert(deliveryRouteStops).values(stop).returning();
    return newStop;
  }

  async getDeliveryRouteStops(routeId: string): Promise<any[]> {
    return await db
      .select()
      .from(deliveryRouteStops)
      .where(eq(deliveryRouteStops.routeId, routeId))
      .orderBy(deliveryRouteStops.stopOrder);
  }

  async updateDeliveryRouteStop(id: string, stop: any): Promise<any> {
    const [updated] = await db
      .update(deliveryRouteStops)
      .set({ ...stop, updatedAt: new Date() })
      .where(eq(deliveryRouteStops.id, id))
      .returning();
    return updated;
  }

  async countRoutesForDriverOnDate(driverId: string, date: Date): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryRoutes)
      .where(
        and(
          eq(deliveryRoutes.driverId, driverId),
          eq(deliveryRoutes.routeDate, sql`${date}::date`)
        )
      );
    return result[0]?.count || 0;
  }

  async saveRouteWithStops(route: any, stops: any[]): Promise<{ route: any; stops: any[] }> {
    // Usar transação para garantir atomicidade
    return await db.transaction(async (tx) => {
      // Salvar a rota
      const [savedRoute] = await tx.insert(deliveryRoutes).values(route).returning();
      
      // Salvar as paradas com routeId
      const stopsWithRouteId = stops.map(stop => ({
        ...stop,
        routeId: savedRoute.id
      }));
      
      const savedStops = await tx.insert(deliveryRouteStops).values(stopsWithRouteId).returning();
      
      return { route: savedRoute, stops: savedStops };
    });
  }

  async updateBillingsStatus(billingIds: string[], newStage: string): Promise<void> {
    if (billingIds.length === 0) return;
    
    await db
      .update(billings)
      .set({ invoiceStage: newStage, updatedAt: new Date() })
      .where(inArray(billings.id, billingIds));
    
    console.log(`✅ Atualizados ${billingIds.length} billings para status: ${newStage}`);
  }

  // Overdue debts operations
  async getOverdueDebts(): Promise<any[]> {
    return await db.select().from(overdueDebts).orderBy(desc(overdueDebts.lastSyncAt));
  }

  async getOverdueDebtByDocument(document: string): Promise<any | undefined> {
    // Normalizar documento de busca: remover pontos, barras, traços
    const normalizedSearchDocument = document.replace(/[.\-\/]/g, '');
    console.log(`🔍 [STORAGE] Buscando débito para documento normalizado: ${normalizedSearchDocument}`);
    
    // Buscar débitos onde o documento (sem formatação) corresponda
    const allDebts = await db.select().from(overdueDebts);
    const debt = allDebts.find(d => {
      const normalizedDbDocument = d.clientDocument.replace(/[.\-\/]/g, '');
      return normalizedDbDocument === normalizedSearchDocument;
    });
    
    if (debt) {
      console.log(`✅ [STORAGE] Débito encontrado: ${debt.clientName} - R$ ${debt.totalAmount}`);
    } else {
      console.log(`ℹ️ [STORAGE] Nenhum débito encontrado para: ${normalizedSearchDocument}`);
    }
    
    return debt;
  }

  async syncOverdueDebts(debts: any[]): Promise<void> {
    console.log(`💾 [SYNC-DEBTS] Recebidos ${debts.length} débitos para sincronizar`);
    
    // Clear existing debts
    await db.delete(overdueDebts);
    console.log(`🗑️ [SYNC-DEBTS] Tabela overdue_debts limpa`);
    
    // Insert new debts
    if (debts.length > 0) {
      const debtsToInsert = debts.map((debt, index) => {
        const mapped = {
          clientId: debt.cliente.codigo_cliente_omie?.toString() || 'unknown',
          omieClientId: debt.cliente.codigo_cliente_omie?.toString() || '0',
          clientName: debt.cliente.nome_fantasia || 'Cliente Desconhecido',
          clientDocument: debt.cliente.cnpj_cpf || '',
          totalAmount: debt.valorTotal.toString(),
          maxDaysOverdue: debt.diasMaximoAtraso,
          vendedores: debt.vendedores || [], // Salvar array de vendedores
          debts: debt.debitos || []
        };
        
        if (index === 0) {
          console.log(`📝 [SYNC-DEBTS] Exemplo de débito mapeado:`, {
            cliente: mapped.clientName,
            documento: mapped.clientDocument,
            valor: mapped.totalAmount,
            diasAtraso: mapped.maxDaysOverdue
          });
        }
        
        return mapped;
      });
      
      console.log(`💾 [SYNC-DEBTS] Inserindo ${debtsToInsert.length} débitos no banco...`);
      await db.insert(overdueDebts).values(debtsToInsert);
      console.log(`✅ [SYNC-DEBTS] ${debtsToInsert.length} débitos inseridos com sucesso`);
    } else {
      console.log(`⚠️ [SYNC-DEBTS] Nenhum débito para inserir (array vazio)`);
    }
  }

  async clearOverdueDebts(): Promise<void> {
    await db.delete(overdueDebts);
  }

  // Exported reports operations
  async saveExportedReport(reportType: string, fileName: string, fileData: string, metadata?: any, createdBy?: string): Promise<ExportedReport> {
    // Delete old reports of the same type before saving new one
    await this.deleteOldReports(reportType);
    
    const [report] = await db
      .insert(exportedReports)
      .values({
        reportType,
        fileName,
        fileData,
        metadata,
        createdBy
      })
      .returning();
    
    return report;
  }

  async getLatestExportedReport(reportType: string): Promise<ExportedReport | undefined> {
    const [report] = await db
      .select()
      .from(exportedReports)
      .where(eq(exportedReports.reportType, reportType))
      .orderBy(desc(exportedReports.createdAt))
      .limit(1);
    
    return report;
  }

  async deleteOldReports(reportType: string): Promise<void> {
    await db
      .delete(exportedReports)
      .where(eq(exportedReports.reportType, reportType));
  }

  async getAllBillingsWithOrderId(): Promise<any[]> {
    return await db
      .select()
      .from(billings)
      .where(isNotNull(billings.omieOrderId))
      .orderBy(desc(billings.invoiceDate));
  }

  // Route optimization operations
  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return user;
  }

  async getVisitAgenda(filters: {
    sellerId?: string;
    startDate?: string;
    endDate?: string;
    visitStatus?: string;
  }): Promise<any[]> {
    const conditions = [];
    
    if (filters.sellerId) {
      conditions.push(eq(visitAgenda.sellerId, filters.sellerId));
    }
    if (filters.startDate) {
      conditions.push(gte(visitAgenda.scheduledDate, new Date(filters.startDate)));
    }
    if (filters.endDate) {
      conditions.push(lte(visitAgenda.scheduledDate, new Date(filters.endDate)));
    }
    if (filters.visitStatus) {
      conditions.push(eq(visitAgenda.visitStatus, filters.visitStatus));
    }

    return await db
      .select()
      .from(visitAgenda)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(visitAgenda.scheduledDate);
  }

  async createDailyRoute(data: any): Promise<any> {
    const [route] = await db
      .insert(dailyRoutes)
      .values(data)
      .returning();
    return route;
  }

  async getDailyRoute(id: string): Promise<any | undefined> {
    const [route] = await db
      .select()
      .from(dailyRoutes)
      .where(eq(dailyRoutes.id, id))
      .limit(1);
    return route;
  }

  async getDailyRouteBySellerAndDate(sellerId: string, date: Date): Promise<any | undefined> {
    // Input date is in UTC (e.g., 2025-11-12T00:00:00.000Z)
    // Create start/end of that calendar day in UTC using UTC methods
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const [route] = await db
      .select()
      .from(dailyRoutes)
      .where(and(
        eq(dailyRoutes.sellerId, sellerId),
        gte(dailyRoutes.routeDate, startOfDay),
        lte(dailyRoutes.routeDate, endOfDay)
      ))
      .limit(1);
    return route;
  }

  async updateDailyRoute(id: string, data: any): Promise<any> {
    const [route] = await db
      .update(dailyRoutes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dailyRoutes.id, id))
      .returning();
    return route;
  }

  async getLastCheckpoint(dailyRouteId: string): Promise<any | undefined> {
    const [checkpoint] = await db
      .select()
      .from(routeCheckpoints)
      .where(eq(routeCheckpoints.dailyRouteId, dailyRouteId))
      .orderBy(desc(routeCheckpoints.sequenceNumber))
      .limit(1);
    return checkpoint;
  }

  async getRouteCheckpoints(dailyRouteId: string): Promise<any[]> {
    const results = await db
      .select()
      .from(routeCheckpoints)
      .leftJoin(customers, eq(routeCheckpoints.customerId, customers.id))
      .leftJoin(salesCards, eq(routeCheckpoints.visitId, salesCards.id))
      .where(eq(routeCheckpoints.dailyRouteId, dailyRouteId))
      .orderBy(routeCheckpoints.sequenceNumber);
    
    // Drizzle retorna campos em camelCase automaticamente, adicionar customerName, photoUrl e coordenadas cadastradas
    return results.map(row => ({
      ...row.route_checkpoints,
      customerName: row.customers?.fantasyName || row.customers?.name || null,
      photoUrl: row.sales_cards?.checkInPhotoUrl || null,
      customerRegisteredLatitude: row.customers?.latitude || null,
      customerRegisteredLongitude: row.customers?.longitude || null
    }));
  }

  async createRouteCheckpoint(data: any): Promise<any> {
    const [checkpoint] = await db
      .insert(routeCheckpoints)
      .values(data)
      .returning();
    return checkpoint;
  }

  async getRouteCheckpointById(checkpointId: string): Promise<any | undefined> {
    const [checkpoint] = await db
      .select()
      .from(routeCheckpoints)
      .where(eq(routeCheckpoints.id, checkpointId))
      .limit(1);
    return checkpoint;
  }

  async updateRouteCheckpoint(id: string, data: Partial<{
    validationStatus: string;
    validatedBy: string;
    validatedAt: Date;
  }>): Promise<any> {
    const [checkpoint] = await db
      .update(routeCheckpoints)
      .set(data)
      .where(eq(routeCheckpoints.id, id))
      .returning();
    return checkpoint;
  }

  // Gerar agenda futura de visitas para os próximos meses
  async generateFutureVisitAgenda(monthsAhead: number = 3): Promise<{
    processed: number;
    generated: number;
    errors: number;
    details: any[];
  }> {
    const results = {
      processed: 0,
      generated: 0,
      errors: 0,
      details: [] as any[]
    };

    try {
      // Buscar todos os clientes com periodicidade configurada
      const clientsWithPeriodicity = await db
        .select()
        .from(customers)
        .where(and(
          isNotNull(customers.visitPeriodicity),
          isNotNull(customers.weekdays)
        ));

      console.log(`📋 Encontrados ${clientsWithPeriodicity.length} clientes com periodicidade configurada`);

      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + monthsAhead);

      for (const customer of clientsWithPeriodicity) {
        results.processed++;

        try {
          // Buscar último card pendente deste cliente
          const [lastCard] = await db
            .select()
            .from(salesCards)
            .where(and(
              eq(salesCards.customerId, customer.id),
              eq(salesCards.status, 'pending')
            ))
            .orderBy(desc(salesCards.scheduledDate))
            .limit(1);

          if (!lastCard) {
            results.details.push({
              customerId: customer.id,
              customerName: customer.name,
              warning: 'Nenhum card pendente encontrado'
            });
            continue;
          }

          // Gerar cards futuros até a data limite
          let cardsGenerated = 0;
          const maxCards = 50; // Limite de segurança

          while (cardsGenerated < maxCards) {
            // Buscar SEMPRE o último card pendente do cliente
            const [latestCard] = await db
              .select()
              .from(salesCards)
              .where(and(
                eq(salesCards.customerId, customer.id),
                eq(salesCards.status, 'pending')
              ))
              .orderBy(desc(salesCards.scheduledDate))
              .limit(1);

            if (!latestCard) {
              console.log(`❌ Cliente ${customer.id} sem card pendente`);
              break;
            }
            
            // Verificar se já atingiu a data futura
            if (new Date(latestCard.scheduledDate) >= futureDate) {
              console.log(`✅ Cliente ${customer.id} já tem cards até ${latestCard.scheduledDate.toISOString().split('T')[0]}`);
              break;
            }

            // Gerar próximo card
            console.log(`🔄 Gerando próximo card para ${customer.id} (último: ${latestCard.scheduledDate.toISOString().split('T')[0]})`);
            const nextCard = await this.generateNextSalesCard(latestCard.id);
            
            if (!nextCard) {
              console.log(`❌ generateNextSalesCard retornou NULL para cliente ${customer.id} (${customer.name}), card ${latestCard.id}`);
              results.details.push({
                customerId: customer.id,
                customerName: customer.name,
                error: 'generateNextSalesCard retornou NULL'
              });
              results.errors++;
              break;
            }
            
            // Verificar se realmente gerou um card novo (não retornou o mesmo)
            if (nextCard.id === latestCard.id) {
              console.log(`⚠️ generateNextSalesCard retornou o mesmo card para ${customer.id}`);
              break;
            }

            console.log(`✅ Card gerado para ${customer.id}: ${nextCard.scheduledDate.toISOString().split('T')[0]}`);
            cardsGenerated++;
            results.generated++;
          }

          results.details.push({
            customerId: customer.id,
            customerName: customer.name,
            periodicity: customer.visitPeriodicity,
            cardsGenerated
          });

        } catch (error: any) {
          results.errors++;
          results.details.push({
            customerId: customer.id,
            customerName: customer.name,
            error: error.message
          });
        }
      }

      console.log(`✅ Geração de agenda futura concluída: ${results.generated} cards criados`);
      return results;

    } catch (error) {
      console.error('❌ Erro ao gerar agenda futura:', error);
      throw error;
    }
  }

  // Recalcular datas de visita para todos os cards baseado no cronograma do cliente
  async recalculateAllVisitDates(): Promise<{
    processed: number;
    updated: number;
    errors: number;
    details: any[];
  }> {
    const results = {
      processed: 0,
      updated: 0,
      errors: 0,
      details: [] as any[]
    };

    try {
      // Buscar todos os cards pendentes
      const allCards = await db
        .select()
        .from(salesCards)
        .where(eq(salesCards.status, 'pending'))
        .orderBy(salesCards.attendanceStartDate);

      console.log(`📋 Encontrados ${allCards.length} cards pendentes para recalcular`);

      for (const card of allCards) {
        results.processed++;

        try {
          // Buscar dados do cliente
          const [customer] = await db
            .select()
            .from(customers)
            .where(eq(customers.id, card.customerId));

          if (!customer) {
            results.errors++;
            results.details.push({
              cardId: card.id,
              error: 'Cliente não encontrado'
            });
            continue;
          }

          let newScheduledDate: Date;
          let calculationMethod: string;

          // Verificar se cliente tem cronograma avançado configurado
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
              // Usar attendanceStartDate como referência para primeira visita
              const result = calculateNextVisitDate({
                weekdays: parsedWeekdays as any[],
                periodicity: customer.visitPeriodicity as any,
                referenceDate: card.attendanceStartDate || card.createdAt || undefined
              });
              newScheduledDate = result.nextDate;
              calculationMethod = 'advanced_schedule';
            } else {
              // Fallback para lógica antiga
              newScheduledDate = this.calculateNextRecurrenceDate(
                card.routeDay,
                card.recurrenceType,
                card.attendanceStartDate || card.createdAt || undefined
              );
              calculationMethod = 'legacy_schedule';
            }
          } else {
            // Usar lógica antiga
            newScheduledDate = this.calculateNextRecurrenceDate(
              card.routeDay,
              card.recurrenceType,
              card.attendanceStartDate || card.createdAt || undefined
            );
            calculationMethod = 'legacy_schedule';
          }

          // Derivar routeDay da nova data
          const dayOfWeek = newScheduledDate.getDay();
          const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
          const derivedRouteDay = weekdayNames[dayOfWeek];

          // Atualizar card apenas se a data mudou
          if (card.scheduledDate.getTime() !== newScheduledDate.getTime()) {
            await db
              .update(salesCards)
              .set({
                scheduledDate: newScheduledDate,
                routeDay: derivedRouteDay,
                updatedAt: new Date()
              })
              .where(eq(salesCards.id, card.id));

            results.updated++;
            results.details.push({
              cardId: card.id,
              customerId: customer.id,
              customerName: customer.name,
              oldDate: card.scheduledDate,
              newDate: newScheduledDate,
              method: calculationMethod
            });
          }

        } catch (error: any) {
          results.errors++;
          results.details.push({
            cardId: card.id,
            error: error.message
          });
        }
      }

      console.log(`✅ Recálculo concluído: ${results.updated} atualizados, ${results.errors} erros`);
      return results;

    } catch (error) {
      console.error('❌ Erro ao recalcular datas de visita:', error);
      throw error;
    }
  }

  // Sync status operations
  async getSyncStatus(syncType: string): Promise<SyncStatus | undefined> {
    const [status] = await db
      .select()
      .from(syncStatus)
      .where(eq(syncStatus.syncType, syncType))
      .limit(1);
    return status;
  }

  async getAllSyncStatus(): Promise<SyncStatus[]> {
    return await db
      .select()
      .from(syncStatus)
      .orderBy(desc(syncStatus.lastSyncAt));
  }

  async upsertSyncStatus(data: InsertSyncStatus): Promise<SyncStatus> {
    const [status] = await db
      .insert(syncStatus)
      .values(data)
      .onConflictDoUpdate({
        target: syncStatus.syncType,
        set: {
          ...data,
          updatedAt: new Date(),
        },
      })
      .returning();
    return status;
  }

  async updateSyncStatus(syncType: string, data: { 
    status: 'success' | 'error' | 'in_progress'; 
    message?: string; 
    recordsProcessed?: number;
  }): Promise<SyncStatus> {
    // Tentar atualizar primeiro
    const [existing] = await db
      .select()
      .from(syncStatus)
      .where(eq(syncStatus.syncType, syncType));
    
    if (existing) {
      // Atualizar registro existente
      const [status] = await db
        .update(syncStatus)
        .set({
          status: data.status,
          message: data.message,
          recordsProcessed: data.recordsProcessed,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncStatus.syncType, syncType))
        .returning();
      return status;
    } else {
      // Criar novo registro
      const [status] = await db
        .insert(syncStatus)
        .values({
          syncType,
          status: data.status,
          message: data.message,
          recordsProcessed: data.recordsProcessed,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      return status;
    }
  }

  async getSyncStatuses(): Promise<SyncStatus[]> {
    return await db.select().from(syncStatus);
  }
  
  // Lead operations
  async getLeads(): Promise<Lead[]> {
    return await db.select().from(leads).orderBy(desc(leads.createdAt));
  }
  
  async getLead(id: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id));
    return lead;
  }
  
  async createLead(leadData: InsertLead): Promise<Lead> {
    const values = {
      ...leadData,
      latitude: leadData.latitude.toString(),
      longitude: leadData.longitude.toString(),
    };
    const [lead] = await db.insert(leads).values(values).returning();
    return lead;
  }
  
  async updateLead(id: string, leadData: Partial<InsertLead>): Promise<Lead> {
    const values = {
      ...leadData,
      ...(leadData.latitude && { latitude: leadData.latitude.toString() }),
      ...(leadData.longitude && { longitude: leadData.longitude.toString() }),
      updatedAt: new Date(),
    };
    const [lead] = await db
      .update(leads)
      .set(values)
      .where(eq(leads.id, id))
      .returning();
    return lead;
  }
  
  async deleteLead(id: string): Promise<void> {
    await db.delete(leads).where(eq(leads.id, id));
  }
  
  // Chat Agents operations
  async getChatAgents(): Promise<ChatAgent[]> {
    return await db.select().from(chatAgents);
  }
  
  async createChatAgent(agentData: InsertChatAgent): Promise<ChatAgent> {
    const [agent] = await db.insert(chatAgents).values(agentData).returning();
    return agent;
  }
  
  async deleteChatAgent(id: string): Promise<void> {
    await db.delete(chatAgents).where(eq(chatAgents.id, id));
  }
  
  async updateChatAgentStatus(id: string, status: string): Promise<ChatAgent> {
    const [agent] = await db
      .update(chatAgents)
      .set({ status, lastActivity: new Date() })
      .where(eq(chatAgents.id, id))
      .returning();
    return agent;
  }
  
  // Chat Customers operations
  async getChatCustomers(): Promise<ChatCustomer[]> {
    return await db.select().from(chatCustomers);
  }
  
  async getChatCustomer(id: string): Promise<ChatCustomer | undefined> {
    const [customer] = await db.select().from(chatCustomers).where(eq(chatCustomers.id, id));
    return customer;
  }
  
  async createChatCustomer(customerData: InsertChatCustomer): Promise<ChatCustomer> {
    const [customer] = await db.insert(chatCustomers).values(customerData).returning();
    return customer;
  }
  
  async updateChatCustomer(id: string, customerData: UpdateChatCustomer): Promise<ChatCustomer> {
    const [customer] = await db
      .update(chatCustomers)
      .set(customerData)
      .where(eq(chatCustomers.id, id))
      .returning();
    return customer;
  }
  
  // Chat Conversations operations
  async getChatConversations(): Promise<ChatConversation[]> {
    return await db.select().from(chatConversations).orderBy(desc(chatConversations.lastMessageTime));
  }
  
  async getChatConversation(id: string): Promise<ChatConversation | undefined> {
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, id));
    return conversation;
  }
  
  async createChatConversation(conversationData: InsertChatConversation): Promise<ChatConversation> {
    const [conversation] = await db.insert(chatConversations).values(conversationData).returning();
    return conversation;
  }
  
  async updateChatConversation(id: string, conversationData: Partial<InsertChatConversation>): Promise<ChatConversation> {
    const [conversation] = await db
      .update(chatConversations)
      .set(conversationData)
      .where(eq(chatConversations.id, id))
      .returning();
    return conversation;
  }
  
  // Chat Messages operations
  async getChatMessages(conversationId: string): Promise<ChatMessage[]> {
    return await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.timestamp);
  }
  
  async createChatMessage(messageData: InsertChatMessage): Promise<ChatMessage> {
    const [message] = await db.insert(chatMessages).values(messageData).returning();
    return message;
  }
  
  // Chat Products operations
  async getChatProducts(): Promise<ChatProduct[]> {
    return await db.select().from(chatProducts).where(eq(chatProducts.isActive, true));
  }
  
  async createChatProduct(productData: InsertChatProduct): Promise<ChatProduct> {
    const [product] = await db.insert(chatProducts).values(productData).returning();
    return product;
  }
  
  async updateChatProduct(id: string, productData: Partial<InsertChatProduct>): Promise<ChatProduct> {
    const [product] = await db
      .update(chatProducts)
      .set(productData)
      .where(eq(chatProducts.id, id))
      .returning();
    return product;
  }
  
  // Chat Quick Messages operations
  async getChatQuickMessages(): Promise<ChatQuickMessage[]> {
    return await db.select().from(chatQuickMessages).where(eq(chatQuickMessages.isActive, true));
  }
  
  async createChatQuickMessage(messageData: InsertChatQuickMessage): Promise<ChatQuickMessage> {
    const [message] = await db.insert(chatQuickMessages).values(messageData).returning();
    return message;
  }
  
  // Chat Orders operations
  async getChatOrders(): Promise<ChatOrder[]> {
    return await db.select().from(chatOrders).orderBy(desc(chatOrders.createdAt));
  }
  
  async createChatOrder(orderData: InsertChatOrder): Promise<ChatOrder> {
    const [order] = await db.insert(chatOrders).values(orderData).returning();
    return order;
  }
  
  async updateChatOrder(id: string, orderData: Partial<InsertChatOrder>): Promise<ChatOrder> {
    const [order] = await db
      .update(chatOrders)
      .set({ ...orderData, updatedAt: new Date() })
      .where(eq(chatOrders.id, id))
      .returning();
    return order;
  }
  
  // Chat Deliveries operations
  async getChatDeliveries(): Promise<ChatDelivery[]> {
    return await db.select().from(chatDeliveries).orderBy(desc(chatDeliveries.createdAt));
  }
  
  async createChatDelivery(deliveryData: InsertChatDelivery): Promise<ChatDelivery> {
    const [delivery] = await db.insert(chatDeliveries).values(deliveryData).returning();
    return delivery;
  }
  
  async updateChatDelivery(id: string, deliveryData: Partial<InsertChatDelivery>): Promise<ChatDelivery> {
    const [delivery] = await db
      .update(chatDeliveries)
      .set({ ...deliveryData, updatedAt: new Date() })
      .where(eq(chatDeliveries.id, id))
      .returning();
    return delivery;
  }
  
  // Chat Reports operations
  async createChatReport(reportData: InsertChatReport): Promise<ChatReport> {
    const [report] = await db.insert(chatReports).values(reportData).returning();
    return report;
  }
  
  async getChatReports(): Promise<ChatReport[]> {
    return await db.select().from(chatReports).orderBy(desc(chatReports.createdAt));
  }
  
  // Chat Audit Log operations
  async createChatAuditLog(logData: InsertChatAuditLog): Promise<ChatAuditLog> {
    const [log] = await db.insert(chatAuditLog).values(logData).returning();
    return log;
  }
  
  // WhatsApp Analysis operations
  async createWhatsappAnalysis(analysisData: InsertWhatsappConversationAnalysis): Promise<WhatsappConversationAnalysis> {
    const [analysis] = await db.insert(whatsappConversationAnalysis).values(analysisData).returning();
    return analysis;
  }
  
  async getWhatsappAnalyses(): Promise<WhatsappConversationAnalysis[]> {
    return await db.select().from(whatsappConversationAnalysis).orderBy(desc(whatsappConversationAnalysis.createdAt));
  }
  
  // Knowledge Base operations
  async createKnowledgeBase(kbData: InsertKnowledgeBase): Promise<KnowledgeBase> {
    const [kb] = await db.insert(knowledgeBase).values(kbData).returning();
    return kb;
  }
  
  async getKnowledgeBase(): Promise<KnowledgeBase[]> {
    return await db.select().from(knowledgeBase).where(eq(knowledgeBase.isActive, true)).orderBy(desc(knowledgeBase.createdAt));
  }
}

export const storage = new DatabaseStorage();
