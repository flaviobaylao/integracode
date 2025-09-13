import {
  users,
  customers,
  products,
  salesCards,
  messageTemplates,
  messageHistory,
  systemSettings,
  locations,
  salesGoals,
  billings,
  type User,
  type UpsertUser,
  type InsertCustomer,
  type Customer,
  type CustomerWithSeller,
  type InsertProduct,
  type Product,
  type InsertSalesCard,
  type SalesCard,
  type SalesCardWithRelations,
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
  insertSystemSettingSchema,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, gte, lte, gt, sql, inArray, or, isNotNull, ne } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  upsertUser(user: UpsertUser): Promise<User>;
  createUser(user: UpsertUser): Promise<User>;
  updateUser(id: string, user: Partial<UpsertUser>): Promise<User>;
  
  // Customer operations
  getCustomers(sellerId?: string): Promise<CustomerWithSeller[]>;
  getCustomer(id: string): Promise<CustomerWithSeller | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, customer: Partial<InsertCustomer>): Promise<Customer>;
  deleteCustomer(id: string): Promise<void>;
  getCustomersByRoute(route: string): Promise<Customer[]>;
  getCustomersByWeekday(weekday: string, sellerId?: string): Promise<Customer[]>;
  
  // Product operations
  getProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
  
  // Sales card operations
  getSalesCards(sellerId?: string, filters?: { routeDay?: string; status?: string }): Promise<SalesCardWithRelations[]>;
  getSalesCard(id: string): Promise<SalesCardWithRelations | undefined>;
  createSalesCard(salesCard: InsertSalesCard): Promise<SalesCard>;
  updateSalesCard(id: string, salesCard: Partial<InsertSalesCard>): Promise<SalesCard>;
  deleteSalesCard(id: string): Promise<void>;
  getSalesCardsByDate(date: Date, sellerId?: string): Promise<SalesCardWithRelations[]>;
  getOverdueSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]>;
  duplicateSalesCard(id: string, newDate: Date): Promise<SalesCard>;
  
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
  getPendingDeliveries(): Promise<SalesCard[]>;
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
  
  // Dashboard stats
  getDashboardStats(sellerId?: string): Promise<{
    todaySales: number;
    todayClients: number;
    overdueClients: number;
    conversionRate: number;
  }>;
  
  // Additional methods needed
  getSalesCardsByDayAndDate(sellerId: string, routeDay: string, startDate: Date, endDate: Date, limit?: number, offset?: number): Promise<SalesCardWithRelations[]>;
  generateNextSalesCard(parentCardId: string): Promise<SalesCard | null>;
  
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
  upsertBilling(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<Billing>;
  saveBillingIfValid(billing: Partial<InsertBilling> & { omieInvoiceId: string }): Promise<{
    success: boolean;
    billing?: Billing;
    reason?: string;
    action?: 'created' | 'updated' | 'skipped';
  }>;
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

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
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
    
    // Para cada cliente, vamos buscar informações de positivação e última atividade
    const customersWithExtendedInfo = await Promise.all(
      result.map(async (row) => {
        const customerId = row.customers!.id;
        
        // Verificar se cliente foi positivado no mês atual
        const currentMonthStart = new Date();
        currentMonthStart.setDate(1);
        currentMonthStart.setHours(0, 0, 0, 0);
        
        const [positivatedThisMonth] = await db
          .select({ count: sql`COUNT(*)`.mapWith(Number) })
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, customerId),
              eq(salesCards.status, 'completed'),
              gte(salesCards.completedDate, currentMonthStart),
              sql`${salesCards.saleValue} > 0`
            )
          );
        
        // Buscar informações da última atividade (card mais recente)
        const [lastActivity] = await db
          .select()
          .from(salesCards)
          .where(eq(salesCards.customerId, customerId))
          .orderBy(desc(salesCards.scheduledDate))
          .limit(1);
        
        let lastActivityStatus = 'none'; // none, success, failed, pending
        
        if (lastActivity) {
          if (lastActivity.status === 'completed') {
            lastActivityStatus = lastActivity.saleValue && lastActivity.saleValue > 0 ? 'success' : 'failed';
          } else if (lastActivity.status === 'in_progress') {
            lastActivityStatus = 'pending';
          } else if (lastActivity.status === 'scheduled') {
            // Verificar se está atrasado
            const scheduledDate = new Date(lastActivity.scheduledDate);
            const now = new Date();
            lastActivityStatus = scheduledDate < now ? 'overdue' : 'scheduled';
          }
        }
        
        return {
          ...row.customers!,
          seller: row.users!,
          isPositivatedThisMonth: (positivatedThisMonth?.count || 0) > 0,
          lastActivityStatus,
          lastActivityDate: lastActivity?.scheduledDate || null,
        };
      })
    );
    
    return customersWithExtendedInfo;
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

  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const [newCustomer] = await db.insert(customers).values(customer).returning();
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

  // Product operations
  async getProducts(): Promise<Product[]> {
    return await db.select().from(products).where(eq(products.isActive, true));
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
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
    const [newSalesCard] = await db.insert(salesCards).values(salesCard as any).returning();
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
        throw new Error('Card pai não encontrado');
      }

      // Verificar se já tem próximo card gerado
      if (parentCard.nextCardId) {
        const [existingNextCard] = await db
          .select()
          .from(salesCards)
          .where(eq(salesCards.id, parentCard.nextCardId));
        
        if (existingNextCard) {
          return existingNextCard;
        }
      }

      // Calcular próxima data
      const nextDate = this.calculateNextRecurrenceDate(
        parentCard.routeDay,
        parentCard.recurrenceType,
        parentCard.scheduledDate
      );

      // Criar novo card
      const nextCardData: InsertSalesCard = {
        customerId: parentCard.customerId,
        sellerId: parentCard.sellerId,
        status: 'pending',
        scheduledDate: nextDate,
        routeDay: parentCard.routeDay,
        recurrenceType: parentCard.recurrenceType,
        isRecurring: parentCard.isRecurring,
        parentCardId: parentCardId,
        paymentMethod: parentCard.paymentMethod,
        operationType: parentCard.operationType
      };

      const [newCard] = await db.insert(salesCards).values(nextCardData as any).returning();

      // Atualizar card pai com referência ao próximo
      await db
        .update(salesCards)
        .set({ nextCardId: newCard.id })
        .where(eq(salesCards.id, parentCardId));

      return newCard;
    } catch (error) {
      console.error('Erro ao gerar próximo card:', error);
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
        and(
          eq(salesCards.sellerId, sellerId),
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

  async deleteSalesCard(id: string): Promise<void> {
    await db.delete(salesCards).where(eq(salesCards.id, id));
  }

  async getSalesCardsByDate(date: Date, sellerId?: string): Promise<SalesCardWithRelations[]> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    let whereConditions = and(
      gte(salesCards.scheduledDate, startOfDay),
      lte(salesCards.scheduledDate, endOfDay)
    );
    
    if (sellerId) {
      whereConditions = and(
        gte(salesCards.scheduledDate, startOfDay),
        lte(salesCards.scheduledDate, endOfDay),
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

  async getPendingDeliveries(): Promise<SalesCard[]> {
    const result = await db.execute(sql`
      SELECT sc.*, c.name as customer_name, c.address as customer_address
      FROM sales_cards sc
      JOIN customers c ON sc.customer_id = c.id
      WHERE sc.status = 'completed' 
      AND sc.delivery_status IN ('pending', 'in_transit')
      ORDER BY sc.scheduled_date ASC
    `);
    return result.rows as SalesCard[];
  }

  async createDeliveryHistory(data: any): Promise<any> {
    const result = await db.execute(sql`
      INSERT INTO delivery_history (sales_card_id, status, timestamp, location, notes, driver_id)
      VALUES (${data.salesCardId}, ${data.status}, ${data.timestamp || new Date()}, ${data.location}, ${data.notes}, ${data.driverId})
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
      SELECT * FROM delivery_drivers 
      WHERE is_active = true 
      ORDER BY name
    `);
    return result.rows;
  }

  async createDeliveryDriver(data: any): Promise<any> {
    const result = await db.execute(sql`
      INSERT INTO delivery_drivers (name, phone, vehicle_type, license_plate, current_location)
      VALUES (${data.name}, ${data.phone}, ${data.vehicleType}, ${data.licensePlate}, ${data.currentLocation})
      RETURNING *
    `);
    return result.rows[0];
  }

  async updateDriverLocation(driverId: string, location: string): Promise<any> {
    const result = await db.execute(sql`
      UPDATE delivery_drivers 
      SET current_location = ${location}, updated_at = NOW() 
      WHERE id = ${driverId}
      RETURNING *
    `);
    return result.rows[0];
  }

  // ===== SISTEMA DE VENDAS RECORRENTES =====

  // Criar próximo card de venda baseado na recorrência
  async createNextRecurringCard(parentCard: SalesCard): Promise<SalesCard> {
    const nextDate = this.calculateNextScheduledDate(
      parentCard.scheduledDate,
      parentCard.routeDay,
      parentCard.recurrenceType
    );

    const nextCard = {
      customerId: parentCard.customerId,
      sellerId: parentCard.sellerId,
      scheduledDate: nextDate,
      status: 'pending' as const,
      products: parentCard.products,
      routeDay: parentCard.routeDay,
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
    let query = db.select().from(salesGoals);
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
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    return await query.orderBy(desc(salesGoals.year), desc(salesGoals.month));
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
      const currentDate = new Date();
      const targetMonth = month || (currentDate.getMonth() + 1);
      const targetYear = year || currentDate.getFullYear();
      
      // Calcular dias úteis do mês (excluindo domingos)
      const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
      const workingDays = [];
      
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(targetYear, targetMonth - 1, day);
        if (date.getDay() !== 0) { // 0 = Sunday
          workingDays.push(date);
        }
      }
      
      const workingDaysInMonth = workingDays.length;
      const workingDaysElapsed = workingDays.filter(date => date <= currentDate).length;
      
      // Base query conditions
      const conditions = [];
      
      if (sellerId) {
        conditions.push(eq(salesCards.sellerId, sellerId));
      }
      
      // Data range for the month
      const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
      const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59);
      
      conditions.push(
        and(
          gte(salesCards.scheduledDate, startOfMonth),
          lte(salesCards.scheduledDate, endOfMonth)
        )
      );

      // Buscar cards de venda do mês
      const salesCardsQuery = db.select({
        id: salesCards.id,
        status: salesCards.status,
        totalValue: salesCards.totalValue,
        scheduledDate: salesCards.scheduledDate,
        customerId: salesCards.customerId,
        sellerId: salesCards.sellerId
      })
      .from(salesCards)
      .innerJoin(customers, eq(salesCards.customerId, customers.id))
      .where(and(...conditions));

      const monthSalesCards = await salesCardsQuery;

      // Calcular métricas
      const totalCards = monthSalesCards.length;
      const successfulCards = monthSalesCards.filter(card => card.status === 'success').length;
      const positivationRate = totalCards > 0 ? (successfulCards / totalCards) * 100 : 0;
      
      const totalRevenue = monthSalesCards
        .filter(card => card.status === 'success' && card.totalValue)
        .reduce((sum, card) => sum + parseFloat(card.totalValue?.toString() || '0'), 0);
      
      const dailyAverageRevenue = workingDaysElapsed > 0 ? totalRevenue / workingDaysElapsed : 0;
      const revenueProjection = dailyAverageRevenue * workingDaysInMonth;

      // Para débito vencido, vamos simular por enquanto (precisa integração com dados do Omie)
      const overdueDebtRatio = Math.random() * 10; // Temporário - deve vir dos dados reais

      // Para atendimento, calcular baseado em clientes únicos atendidos vs total da rota
      // Excluindo clientes com virtualService = true
      const uniqueCustomersAttended = new Set(
        monthSalesCards
          .filter(card => card.status === 'success')
          .map(card => card.customerId)
      ).size;

      // Contar total de clientes na rota do vendedor (excluindo virtualService)
      let totalCustomersInRoute = 0;
      if (sellerId) {
        const routeCustomers = await db.select({ id: customers.id })
          .from(customers)
          .where(and(
            eq(customers.sellerId, sellerId),
            eq(customers.omieStatus, 'ativo'),
            eq(customers.virtualService, false)
          ));
        totalCustomersInRoute = routeCustomers.length;
      }

      const serviceRate = totalCustomersInRoute > 0 ? (uniqueCustomersAttended / totalCustomersInRoute) * 100 : 0;

      return {
        positivationRate,
        totalRevenue,
        revenueProjection,
        overdueDebtRatio,
        serviceRate,
        workingDaysInMonth,
        workingDaysElapsed,
        totalCards,
        successfulCards,
        uniqueCustomersAttended,
        totalCustomersInRoute,
        dailyAverageRevenue
      };
    } catch (error) {
      console.error('Erro ao calcular métricas de vendas:', error);
      throw error;
    }
  }

  // Billing operations
  async getBillings(sellerId?: string): Promise<Billing[]> {
    let query = db.select().from(billings);
    
    if (sellerId) {
      query = query.where(eq(billings.sellerId, sellerId));
    }
    
    const result = await query.orderBy(desc(billings.invoiceDate));
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

  async createBilling(billing: InsertBilling): Promise<Billing> {
    const [newBilling] = await db
      .insert(billings)
      .values(billing)
      .returning();
    return newBilling;
  }

  async updateBilling(id: string, billing: Partial<InsertBilling>): Promise<Billing> {
    const [updatedBilling] = await db
      .update(billings)
      .set({ ...billing, updatedAt: new Date() })
      .where(eq(billings.id, id))
      .returning();
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
      conditions.push(eq(billings.invoiceNumber, invoiceNumber));
    }
    
    if (cfop) {
      // Mapear tipos para múltiplos CFOPs
      const cfopGroups: Record<string, string[]> = {
        'VENDA': ['5.102', '5.101', '6.102', '6.101'],
        'TROCA': ['5.949', '6.949'],
        'AMOSTRA': ['5.911', '6.911'],
        'BONIFICAÇÃO': ['5.910', '6.910', '5.915'],
        'ENTRADA': ['1.102', '1.202'],
        'DEVOLUÇÃO': ['2.556', '1.556', '1.201']
      };

      const cfopCodes = cfopGroups[cfop];
      if (cfopCodes) {
        // Filtrar por múltiplos CFOPs (OR condition)
        const cfopConditions = cfopCodes.map(code => eq(billings.cfop, code));
        conditions.push(or(...cfopConditions));
      } else {
        // Filtro direto por CFOP específico
        conditions.push(eq(billings.cfop, cfop));
      }
    }
    
    if (invoiceStage) {
      conditions.push(eq(billings.invoiceStage, invoiceStage));
    }
    
    // Query com filtros
    let query = db.select().from(billings);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    // Contar total de registros
    const totalQuery = db.select({ count: sql`count(*)` }).from(billings);
    const totalWithConditions = conditions.length > 0 ? 
      totalQuery.where(and(...conditions)) : 
      totalQuery;
    
    const [{ count: totalCount }] = await totalWithConditions;
    const total = parseInt(totalCount.toString());
    
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
      
      // Validação 1: Status da nota fiscal deve ser 100 (autorizada) ou 150 (autorizada fora do prazo)
      const invoiceStatus = billing.invoiceStatus?.toString().trim();
      console.log(`🔧 DEBUG VALIDATION PROCESSED: invoiceStatus="${invoiceStatus}"`);
      
      if (!invoiceStatus || (invoiceStatus !== '100' && invoiceStatus !== '150')) {
        const reason = `Status inválido: ${invoiceStatus || 'NULL'} (deve ser 100 ou 150)`;
        console.log(`⚠️ REJEITADO - ${billing.invoiceNumber || billing.omieInvoiceId}: ${reason}`);
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      // Validação 2: Data da nota fiscal deve ser >= 01/09/2025
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
      const cutoffDate = new Date(2025, 8, 1); // 1º setembro 2025 (mês 8 = setembro)
      
      if (isNaN(invoiceDate.getTime()) || invoiceDate < cutoffDate) {
        const reason = `Data inválida ou anterior a 01/09/2025: ${invoiceDate.toISOString().split('T')[0]}`;
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
      const existing = await this.getBillingByOmieId(billing.omieInvoiceId);
      
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
      SELECT * FROM delivery_drivers 
      WHERE is_active = true 
      ORDER BY name ASC
    `);
    return result.rows || [];
  }

  async updateDeliveryDriver(id: string, data: any): Promise<any> {
    const result = await db.execute(sql`
      UPDATE delivery_drivers 
      SET 
        name = COALESCE(${data.name}, name),
        phone = COALESCE(${data.phone}, phone),
        vehicle_type = COALESCE(${data.vehicleType}, vehicle_type),
        license_plate = COALESCE(${data.licensePlate}, license_plate),
        is_active = COALESCE(${data.isActive}, is_active),
        current_location = COALESCE(${data.currentLocation}, current_location),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `);
    return result.rows[0];
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
      todayDeliveries: parseInt(metrics.todayDeliveries) || 0,
      successRate: parseFloat(metrics.successRate) || 0,
      averageDeliveryTime: metrics.averageDeliveryTime,
      activeDrivers: parseInt(metrics.activeDrivers) || 0
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
      totalDeliveries: parseInt(stats.totalDeliveries) || 0,
      delivered: parseInt(stats.delivered) || 0,
      failed: parseInt(stats.failed) || 0,
      pending: parseInt(stats.pending) || 0,
      in_transit: parseInt(stats.in_transit) || 0,
      returned: parseInt(stats.returned) || 0,
      successRate: parseFloat(stats.successRate) || 0,
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
}

export const storage = new DatabaseStorage();
