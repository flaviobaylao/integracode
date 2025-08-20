import {
  users,
  customers,
  products,
  salesCards,
  messageTemplates,
  messageHistory,
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
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, gte, lte, sql, inArray, or } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
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
  getSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]>;
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
  createDeliveryDriver(data: any): Promise<any>;
  updateDriverLocation(driverId: string, location: string): Promise<any>;
  
  // Dashboard stats
  getDashboardStats(sellerId?: string): Promise<{
    todaySales: number;
    todayClients: number;
    overdueClients: number;
    conversionRate: number;
  }>;
}

export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
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
    
    const whereConditions = [eq(customers.isActive, true)];
    if (sellerId) {
      whereConditions.push(eq(customers.sellerId, sellerId));
    }
    
    const query = baseQuery.where(and(...whereConditions));
    
    const result = await query;
    return result.map(row => ({
      ...row.customers!,
      seller: row.users!,
    }));
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
    await db.update(customers).set({ isActive: false }).where(eq(customers.id, id));
  }

  async getCustomersByRoute(route: string): Promise<Customer[]> {
    return await db
      .select()
      .from(customers)
      .where(and(eq(customers.route, route), eq(customers.isActive, true)));
  }

  async getCustomersByWeekday(weekday: string, sellerId?: string): Promise<Customer[]> {
    let whereConditions = and(
      eq(customers.isActive, true),
      sql`${customers.weekdays} LIKE ${`%${weekday}%`}`
    );
    
    if (sellerId) {
      whereConditions = and(
        eq(customers.isActive, true),
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
  async getSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]> {
    let query = db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .orderBy(desc(salesCards.scheduledDate));
    
    if (sellerId) {
      query = query.where(eq(salesCards.sellerId, sellerId));
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
    const [newSalesCard] = await db.insert(salesCards).values(salesCard).returning();
    return newSalesCard;
  }

  async updateSalesCard(id: string, salesCard: Partial<InsertSalesCard>): Promise<SalesCard> {
    const [updatedSalesCard] = await db
      .update(salesCards)
      .set({ ...salesCard, updatedAt: new Date() })
      .where(eq(salesCards.id, id))
      .returning();
    return updatedSalesCard;
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
      })
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
    let query = db.select().from(messageHistory).orderBy(desc(messageHistory.sentAt));
    
    if (customerId) {
      query = query.where(eq(messageHistory.customerId, customerId));
    }
    
    return await query;
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

  // ===== DELIVERY OPERATIONS =====

  async updateSalesCardDeliveryStatus(id: string, data: any): Promise<SalesCard> {
    const [updatedCard] = await db.execute(sql`
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
    return updatedCard as SalesCard;
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
        outcome,
        saleValue: outcome === 'sale' ? (saleValue ? saleValue.toString() : card.saleValue) : null,
        updatedAt: new Date()
      })
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
}

export const storage = new DatabaseStorage();
