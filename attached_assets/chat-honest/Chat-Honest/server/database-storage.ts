import type {
  User,
  InsertUser,
  Agent,
  InsertAgent,
  Customer,
  InsertCustomer,
  Conversation,
  InsertConversation,
  Message,
  InsertMessage,
  Report,
  InsertReport,
  AuditLog,
  InsertAuditLog,
  Product,
  InsertProduct,
  QuickMessage,
  InsertQuickMessage,
  Order,
  InsertOrder,
  Delivery,
  InsertDelivery,
  DeliveryWithPerson,
  DeliveryRejectionReason,
  InsertDeliveryRejectionReason,
  WhatsappConversationAnalysis,
  InsertWhatsappConversationAnalysis,
  KnowledgeBase,
  InsertKnowledgeBase,
  SystemSettings,
  InsertSystemSettings,
  ConversationWithCustomer,
  MessageWithSender,
  AgentWithUser,
} from "@shared/schema";
import { users, agents, customers, conversations, messages, reports, auditLog, products, quickMessages, orders, deliveries, deliveryRejectionReasons, whatsappConversationAnalysis, knowledgeBase, systemSettings } from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or, count, sql, like, gte, lte, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";

export interface IAuthStorage {
  // Authentication
  createUser(user: InsertUser): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  validatePassword(username: string, password: string): Promise<User | undefined>;
  updateLastLogin(userId: string): Promise<void>;
  getAllUsers(): Promise<User[]>;
  deleteUser(userId: string): Promise<void>;
  createDefaultAdmin(): Promise<User>;
  
  // Audit logging
  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;
  getAuditLogs(limit?: number): Promise<AuditLog[]>;
  
  // Reports
  createReport(report: InsertReport): Promise<Report>;
  getReports(userId: string): Promise<Report[]>;
  getReportById(id: string): Promise<Report | undefined>;
}

export interface IStorage extends IAuthStorage {
  // Agents
  getAgent(id: string): Promise<Agent | undefined>;
  getAgentByEmail(email: string): Promise<Agent | undefined>;
  getAgentByUserId(userId: string): Promise<Agent | undefined>;
  createAgent(agent: InsertAgent): Promise<Agent>;
  updateAgentStatus(id: string, status: string): Promise<Agent | undefined>;
  getOnlineAgents(): Promise<Agent[]>;
  getOnlineHumanAgents(): Promise<Agent[]>;
  getBotAgent(): Promise<Agent | undefined>;
  getAllAgents(): Promise<AgentWithUser[]>;
  incrementAgentConversations(id: string): Promise<void>;
  decrementAgentConversations(id: string): Promise<void>;
  
  // Customers
  getCustomer(id: string): Promise<Customer | undefined>;
  getCustomerByPhone(phone: string): Promise<Customer | undefined>;
  searchCustomers(query: string): Promise<Customer[]>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, customerData: Partial<InsertCustomer>): Promise<Customer | undefined>;
  updateCustomerLastContact(id: string): Promise<void>;
  
  // Conversations
  getConversation(id: string): Promise<Conversation | undefined>;
  getConversationWithCustomer(id: string): Promise<ConversationWithCustomer | undefined>;
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  updateConversationStatus(id: string, status: string): Promise<Conversation | undefined>;
  assignConversationToAgent(conversationId: string, agentId: string): Promise<Conversation | undefined>;
  transferConversation(conversationId: string, fromAgentId: string, toAgentId: string): Promise<ConversationWithCustomer>;
  getConversationsWithCustomers(): Promise<ConversationWithCustomer[]>;
  getConversationsForUser(userId: string, userRole: string): Promise<ConversationWithCustomer[]>;
  getAgentConversations(agentId: string): Promise<ConversationWithCustomer[]>;
  getUnassignedConversations(): Promise<ConversationWithCustomer[]>;
  getLastConversationByCustomer(customerId: string): Promise<Conversation | undefined>;
  
  // Messages
  getMessage(id: string): Promise<Message | undefined>;
  createMessage(message: InsertMessage): Promise<Message>;
  getConversationMessages(conversationId: string): Promise<MessageWithSender[]>;
  markMessageAsRead(id: string): Promise<void>;
  
  // Statistics
  getStats(): Promise<{
    waiting: number;
    inProgress: number;
    resolved: number;
    agentsOnline: number;
  }>;
  
  // Analytics for reports
  getConversationMetrics(startDate: Date, endDate: Date): Promise<{
    totalConversations: number;
    resolvedConversations: number;
    averageResolutionTime: number;
    agentPerformance: Array<{
      agentId: string;
      agentName: string;
      conversationsHandled: number;
      averageResponseTime: number;
    }>;
    customerSatisfaction: number;
  }>;

  // Products
  getProduct(id: string): Promise<Product | undefined>;
  getAllProducts(): Promise<Product[]>;
  getActiveProducts(): Promise<Product[]>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: string, product: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: string): Promise<void>;

  // Quick Messages
  getQuickMessage(id: string): Promise<QuickMessage | undefined>;
  getAllQuickMessages(): Promise<QuickMessage[]>;
  getActiveQuickMessages(): Promise<QuickMessage[]>;
  createQuickMessage(message: InsertQuickMessage): Promise<QuickMessage>;
  updateQuickMessage(id: string, message: Partial<InsertQuickMessage>): Promise<QuickMessage | undefined>;
  deleteQuickMessage(id: string): Promise<void>;

  // Orders
  getOrder(id: string): Promise<Order | undefined>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrderStatus(id: string, status: string): Promise<Order | undefined>;
  getCustomerOrders(customerId: string): Promise<Order[]>;
  getConversationOrders(conversationId: string): Promise<Order[]>;

  // WhatsApp Conversation Analysis
  getWhatsappAnalysis(id: string): Promise<WhatsappConversationAnalysis | undefined>;
  createWhatsappAnalysis(analysis: InsertWhatsappConversationAnalysis): Promise<WhatsappConversationAnalysis>;
  updateWhatsappAnalysis(id: string, analysis: Partial<InsertWhatsappConversationAnalysis>): Promise<WhatsappConversationAnalysis | undefined>;
  getAllWhatsappAnalyses(): Promise<WhatsappConversationAnalysis[]>;
  getWhatsappAnalysesByStatus(status: string): Promise<WhatsappConversationAnalysis[]>;
  getWhatsappAnalysisByConversationId(conversationId: string): Promise<WhatsappConversationAnalysis | undefined>;
  updateAnalysisKnowledgeFileUpdate(id: string): Promise<void>;

  // Knowledge Base
  getKnowledgeBase(id: string): Promise<KnowledgeBase | undefined>;
  createKnowledgeBase(knowledge: InsertKnowledgeBase): Promise<KnowledgeBase>;
  getLatestKnowledgeBase(): Promise<KnowledgeBase | undefined>;
  getAllKnowledgeBases(): Promise<KnowledgeBase[]>;
  updateKnowledgeBaseStats(id: string, conversationCount: number): Promise<KnowledgeBase | undefined>;

  // System Settings
  getSystemSetting(key: string): Promise<SystemSettings | undefined>;
  setSystemSetting(key: string, value: string, description?: string, updatedBy?: string): Promise<SystemSettings>;
  getAllSystemSettings(): Promise<SystemSettings[]>;
  deleteSystemSetting(key: string): Promise<void>;

  // Export and Statistics
  getConversationsForExport(startDate: Date, endDate: Date): Promise<any[]>;
  getTopCustomersByTime(startDate: Date, limit: number): Promise<any[]>;
  getTopCustomersByConversations(startDate: Date, limit: number): Promise<any[]>;
}

export class DatabaseStorage implements IStorage {
  // Authentication methods
  async createUser(userData: InsertUser): Promise<User> {
    const hashedPassword = await bcrypt.hash(userData.passwordHash, 10);
    const [user] = await db
      .insert(users)
      .values({
        ...userData,
        passwordHash: hashedPassword,
      })
      .returning();
    return user;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async validatePassword(username: string, password: string): Promise<User | undefined> {
    const user = await this.getUserByUsername(username);
    if (!user) return undefined;
    
    const isValid = await bcrypt.compare(password, user.passwordHash);
    return isValid ? user : undefined;
  }

  async updateLastLogin(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ lastLogin: new Date() })
      .where(eq(users.id, userId));
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async deleteUser(userId: string): Promise<void> {
    // Deletar primeiro o agente associado (se existir)
    await db.delete(agents).where(eq(agents.userId, userId));
    
    // Depois deletar o usuário
    await db.delete(users).where(eq(users.id, userId));
  }

  async createDefaultAdmin(): Promise<User> {
    const existingAdmin = await db.select().from(users).where(eq(users.role, "admin"));
    if (existingAdmin.length > 0) {
      return existingAdmin[0];
    }

    return await this.createUser({
      username: "Flavio",
      email: "flavio@whatsapp-system.com",
      passwordHash: "M@riafe1", // Will be hashed in createUser
      role: "admin",
    });
  }

  // Audit logging
  async createAuditLog(logData: InsertAuditLog): Promise<AuditLog> {
    const [log] = await db.insert(auditLog).values(logData).returning();
    return log;
  }

  async getAuditLogs(limit = 100): Promise<AuditLog[]> {
    return await db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit);
  }

  // Reports
  async createReport(reportData: InsertReport): Promise<Report> {
    const [report] = await db.insert(reports).values(reportData).returning();
    return report;
  }

  async getReports(userId: string): Promise<Report[]> {
    return await db
      .select()
      .from(reports)
      .where(eq(reports.generatedBy, userId))
      .orderBy(desc(reports.createdAt));
  }

  async getReportById(id: string): Promise<Report | undefined> {
    const [report] = await db.select().from(reports).where(eq(reports.id, id));
    return report;
  }

  // Agent methods
  async getAgent(id: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    return agent;
  }

  async getAgentByEmail(email: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.email, email));
    return agent;
  }

  async getAgentByUserId(userId: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.userId, userId));
    return agent;
  }

  async createAgent(agentData: InsertAgent): Promise<Agent> {
    const [agent] = await db.insert(agents).values(agentData).returning();
    return agent;
  }

  async updateAgentStatus(id: string, status: string): Promise<Agent | undefined> {
    const [agent] = await db
      .update(agents)
      .set({ status, lastActivity: new Date() })
      .where(eq(agents.id, id))
      .returning();
    return agent;
  }

  async getOnlineAgents(): Promise<Agent[]> {
    return await db.select().from(agents).where(eq(agents.status, "online"));
  }

  async getOnlineHumanAgents(): Promise<Agent[]> {
    return await db
      .select()
      .from(agents)
      .where(and(eq(agents.status, "online"), eq(agents.type, "human")));
  }

  async getBotAgent(): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.type, "bot"));
    return agent;
  }

  async getAllAgents(): Promise<AgentWithUser[]> {
    const result = await db
      .select({
        id: agents.id,
        userId: agents.userId,
        name: agents.name,
        email: agents.email,
        type: agents.type,
        status: agents.status,
        activeConversations: agents.activeConversations,
        totalConversations: agents.totalConversations,
        lastActivity: agents.lastActivity,
        user: {
          id: users.id,
          username: users.username,
          email: users.email,
          passwordHash: users.passwordHash,
          role: users.role,
          isActive: users.isActive,
          createdAt: users.createdAt,
          lastLogin: users.lastLogin,
        },
      })
      .from(agents)
      .leftJoin(users, eq(agents.userId, users.id));
    
    return result.map(row => ({
      ...row,
      user: row.user && row.user.id ? row.user : undefined
    }));
  }

  async incrementAgentConversations(id: string): Promise<void> {
    await db
      .update(agents)
      .set({ 
        activeConversations: sql`${agents.activeConversations} + 1`,
        totalConversations: sql`${agents.totalConversations} + 1`
      })
      .where(eq(agents.id, id));
  }

  async decrementAgentConversations(id: string): Promise<void> {
    await db
      .update(agents)
      .set({ activeConversations: sql`${agents.activeConversations} - 1` })
      .where(eq(agents.id, id));
  }

  // Customer methods
  async getCustomer(id: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    return customer;
  }

  async getCustomerByPhone(phone: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.phone, phone));
    return customer;
  }

  async searchCustomers(query: string): Promise<Customer[]> {
    const searchTerm = `%${query}%`;
    const results = await db
      .select()
      .from(customers)
      .where(
        sql`${customers.name} ILIKE ${searchTerm} OR ${customers.phone} LIKE ${searchTerm}`
      )
      .orderBy(desc(customers.lastContact))
      .limit(20);
    return results;
  }

  async createCustomer(customerData: InsertCustomer): Promise<Customer> {
    const [customer] = await db.insert(customers).values(customerData).returning();
    return customer;
  }

  async updateCustomer(id: string, customerData: Partial<InsertCustomer>): Promise<Customer | undefined> {
    const [customer] = await db.update(customers)
      .set(customerData)
      .where(eq(customers.id, id))
      .returning();
    return customer;
  }

  async updateCustomerLastContact(id: string): Promise<void> {
    await db
      .update(customers)
      .set({ lastContact: new Date(), totalConversations: sql`${customers.totalConversations} + 1` })
      .where(eq(customers.id, id));
  }

  // Conversation methods
  async getConversation(id: string): Promise<Conversation | undefined> {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation;
  }

  async getConversationWithCustomer(id: string): Promise<ConversationWithCustomer | undefined> {
    const result = await db
      .select({
        conversation: conversations,
        customer: customers,
        agent: agents,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id))
      .where(eq(conversations.id, id));

    if (result.length === 0) return undefined;

    const { conversation, customer, agent } = result[0];
    return {
      ...conversation,
      customer: customer!,
      agent: agent || undefined,
    };
  }

  async createConversation(conversationData: InsertConversation): Promise<Conversation> {
    const [conversation] = await db.insert(conversations).values(conversationData).returning();
    return conversation;
  }

  async updateConversationStatus(id: string, status: string): Promise<Conversation | undefined> {
    const updateData: any = { status };
    if (status === "resolved") {
      updateData.resolvedAt = new Date();
    }

    const [conversation] = await db
      .update(conversations)
      .set(updateData)
      .where(eq(conversations.id, id))
      .returning();
    return conversation;
  }

  async updateConversationLastMessage(id: string): Promise<void> {
    await db
      .update(conversations)
      .set({ lastMessageTime: new Date() })
      .where(eq(conversations.id, id));
  }

  async getActiveConversationByCustomer(customerId: string): Promise<Conversation | undefined> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.customerId, customerId),
          or(
            eq(conversations.status, 'new'),
            eq(conversations.status, 'assigned'),
            eq(conversations.status, 'in-progress')
          )
        )
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return conversation;
  }

  async getLastConversationByCustomer(customerId: string): Promise<Conversation | undefined> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.customerId, customerId))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return conversation;
  }

  async assignConversationToAgent(conversationId: string, agentId: string): Promise<Conversation | undefined> {
    const now = new Date();
    const [conversation] = await db
      .update(conversations)
      .set({ 
        agentId, 
        status: "assigned",
        assignedAt: now,
        lastAgentResponseTime: now
      })
      .where(eq(conversations.id, conversationId))
      .returning();
      
    // Incrementar contador de conversas ativas do agente
    await this.incrementAgentConversations(agentId);
    
    return conversation;
  }

  async transferConversation(conversationId: string, fromAgentId: string, toAgentId: string): Promise<ConversationWithCustomer> {
    const now = new Date();
    
    // Verificar se a conversa existe e está atribuída ao agente atual
    const [currentConversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, fromAgentId)));
    
    if (!currentConversation) {
      throw new Error("Conversa não encontrada ou não atribuída ao agente atual");
    }
    
    // Verificar se o agente de destino está online
    const [targetAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, toAgentId), eq(agents.status, "online"), eq(agents.type, "human")));
    
    if (!targetAgent) {
      throw new Error("Agente de destino não está online ou não existe");
    }
    
    // Atualizar a conversa para o novo agente
    const [conversation] = await db
      .update(conversations)
      .set({ 
        agentId: toAgentId,
        assignedAt: now,
        lastAgentResponseTime: now
      })
      .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, fromAgentId)))
      .returning();
    
    if (!conversation) {
      throw new Error("Falha ao transferir conversa - possível condição de corrida");
    }
    
    // Decrementar contador do agente antigo e incrementar do novo
    await this.decrementAgentConversations(fromAgentId);
    await this.incrementAgentConversations(toAgentId);
    
    // Criar mensagem de sistema sobre a transferência
    await this.createMessage({
      conversationId,
      senderId: "system",
      senderType: "system",
      content: `Conversa transferida para ${targetAgent.name}`,
      messageType: "text",
      isRead: false
    });
    
    // Criar log de auditoria
    await this.createAuditLog({
      userId: null,
      action: "conversation_transferred",
      entityType: "conversation",
      entityId: conversationId,
      details: {
        fromAgentId,
        toAgentId,
        fromAgentName: (await this.getAgent(fromAgentId))?.name,
        toAgentName: targetAgent.name
      }
    });
    
    // Retornar a conversa com informações do cliente
    return await this.getConversationWithCustomer(conversationId) as ConversationWithCustomer;
  }

  async getConversationsWithCustomers(): Promise<ConversationWithCustomer[]> {
    const result = await db
      .select({
        conversation: conversations,
        customer: customers,
        agent: agents,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id))
      .orderBy(desc(conversations.lastMessageTime));

    return result.map(({ conversation, customer, agent }) => ({
      ...conversation,
      customer: customer!,
      agent: agent || undefined,
    }));
  }

  async getAgentConversations(agentId: string): Promise<ConversationWithCustomer[]> {
    const result = await db
      .select({
        conversation: conversations,
        customer: customers,
        agent: agents,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id))
      .where(eq(conversations.agentId, agentId))
      .orderBy(desc(conversations.lastMessageTime));

    return result.map(({ conversation, customer, agent }) => ({
      ...conversation,
      customer: customer!,
      agent: agent || undefined,
    }));
  }

  async getUnassignedConversations(): Promise<ConversationWithCustomer[]> {
    const result = await db
      .select({
        conversation: conversations,
        customer: customers,
        agent: agents,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id))
      .where(eq(conversations.status, "new"))
      .orderBy(desc(conversations.lastMessageTime));

    return result.map(({ conversation, customer, agent }) => ({
      ...conversation,
      customer: customer!,
      agent: agent || undefined,
    }));
  }

  // Buscar conversas filtradas por usuário baseado no role
  async getConversationsForUser(userId: string, userRole: string): Promise<ConversationWithCustomer[]> {
    let query = db
      .select({
        conversation: conversations,
        customer: customers,
        agent: agents,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id));

    // Se for atendente (agent), só mostrar suas conversas
    if (userRole === "agent") {
      // Buscar o agentId do usuário
      const userAgent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.userId, userId))
        .limit(1);

      if (userAgent.length > 0) {
        query = query.where(eq(conversations.agentId, userAgent[0].id));
      } else {
        // Se não encontrar agente, retornar vazio
        return [];
      }
    }
    // Se for admin ou outro role, mostrar todas as conversas (sem filtro adicional)

    const result = await query.orderBy(desc(conversations.lastMessageTime));

    return result.map(({ conversation, customer, agent }) => ({
      ...conversation,
      customer: customer!,
      agent: agent || undefined,
    }));
  }

  // Message methods
  async getMessage(id: string): Promise<Message | undefined> {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message;
  }

  async createMessage(messageData: InsertMessage): Promise<Message> {
    const [message] = await db.insert(messages).values(messageData).returning();
    
    const now = new Date();
    const updateData: any = { lastMessageTime: now };
    
    // Se for uma mensagem de um agente, atualizar também o lastAgentResponseTime
    if (messageData.senderType === "agent") {
      updateData.lastAgentResponseTime = now;
    }
    
    // Update conversation's timestamps
    await db
      .update(conversations)
      .set(updateData)
      .where(eq(conversations.id, messageData.conversationId));

    return message;
  }

  async getConversationMessages(conversationId: string): Promise<MessageWithSender[]> {
    const result = await db
      .select({
        message: messages,
        agent: agents,
        customer: customers,
      })
      .from(messages)
      .leftJoin(agents, and(eq(messages.senderId, agents.id), eq(messages.senderType, "agent")))
      .leftJoin(customers, and(eq(messages.senderId, customers.id), eq(messages.senderType, "customer")))
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.timestamp);

    return result.map(({ message, agent, customer }) => ({
      ...message,
      sender: agent || customer || undefined,
    }));
  }

  async markMessageAsRead(id: string): Promise<void> {
    await db.update(messages).set({ isRead: true }).where(eq(messages.id, id));
  }

  // Statistics
  async getStats(): Promise<{
    waiting: number;
    inProgress: number;
    resolved: number;
    agentsOnline: number;
  }> {
    const [waitingCount] = await db
      .select({ count: count() })
      .from(conversations)
      .where(eq(conversations.status, "new"));

    const [inProgressCount] = await db
      .select({ count: count() })
      .from(conversations)
      .where(eq(conversations.status, "in-progress"));

    const [resolvedCount] = await db
      .select({ count: count() })
      .from(conversations)
      .where(eq(conversations.status, "resolved"));

    const [agentsOnlineCount] = await db
      .select({ count: count() })
      .from(agents)
      .where(eq(agents.status, "online"));

    return {
      waiting: waitingCount.count,
      inProgress: inProgressCount.count,
      resolved: resolvedCount.count,
      agentsOnline: agentsOnlineCount.count,
    };
  }

  // Analytics for reports
  async getConversationMetrics(startDate: Date, endDate: Date): Promise<{
    totalConversations: number;
    resolvedConversations: number;
    averageResolutionTime: number;
    agentPerformance: Array<{
      agentId: string;
      agentName: string;
      conversationsHandled: number;
      averageResponseTime: number;
    }>;
    customerSatisfaction: number;
  }> {
    // Get total conversations in period
    const [totalResult] = await db
      .select({ count: count() })
      .from(conversations)
      .where(and(
        gte(conversations.createdAt, startDate),
        lte(conversations.createdAt, endDate)
      ));

    // Get resolved conversations in period
    const [resolvedResult] = await db
      .select({ count: count() })
      .from(conversations)
      .where(and(
        eq(conversations.status, "resolved"),
        gte(conversations.createdAt, startDate),
        lte(conversations.createdAt, endDate)
      ));

    // Get agent performance
    const agentPerformance = await db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        conversationsHandled: count(conversations.id),
      })
      .from(agents)
      .leftJoin(conversations, eq(agents.id, conversations.agentId))
      .where(and(
        gte(conversations.createdAt, startDate),
        lte(conversations.createdAt, endDate)
      ))
      .groupBy(agents.id, agents.name);

    return {
      totalConversations: totalResult.count,
      resolvedConversations: resolvedResult.count,
      averageResolutionTime: 0, // TODO: Calculate based on created vs resolved timestamps
      agentPerformance: agentPerformance.map(perf => ({
        ...perf,
        averageResponseTime: 0, // TODO: Calculate based on message timestamps
      })),
      customerSatisfaction: 85, // TODO: Implement satisfaction survey system
    };
  }

  // Products operations
  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async getAllProducts(): Promise<Product[]> {
    return await db.select().from(products).orderBy(products.name);
  }

  async getActiveProducts(): Promise<Product[]> {
    return await db.select().from(products)
      .where(eq(products.isActive, true))
      .orderBy(products.name);
  }

  async createProduct(productData: InsertProduct): Promise<Product> {
    const [product] = await db.insert(products).values(productData).returning();
    return product;
  }

  async updateProduct(id: string, productData: Partial<InsertProduct>): Promise<Product | undefined> {
    const [product] = await db.update(products)
      .set(productData)
      .where(eq(products.id, id))
      .returning();
    return product;
  }

  async deleteProduct(id: string): Promise<void> {
    await db.delete(products).where(eq(products.id, id));
  }

  // Quick Messages operations
  async getQuickMessage(id: string): Promise<QuickMessage | undefined> {
    const [message] = await db.select().from(quickMessages).where(eq(quickMessages.id, id));
    return message;
  }

  async getAllQuickMessages(): Promise<QuickMessage[]> {
    return await db.select().from(quickMessages).orderBy(quickMessages.title);
  }

  async getActiveQuickMessages(): Promise<QuickMessage[]> {
    return await db.select().from(quickMessages)
      .where(eq(quickMessages.isActive, true))
      .orderBy(quickMessages.title);
  }

  async createQuickMessage(messageData: InsertQuickMessage): Promise<QuickMessage> {
    const [message] = await db.insert(quickMessages).values(messageData).returning();
    return message;
  }

  async updateQuickMessage(id: string, messageData: Partial<InsertQuickMessage>): Promise<QuickMessage | undefined> {
    const [message] = await db.update(quickMessages)
      .set(messageData)
      .where(eq(quickMessages.id, id))
      .returning();
    return message;
  }

  async deleteQuickMessage(id: string): Promise<void> {
    await db.delete(quickMessages).where(eq(quickMessages.id, id));
  }

  // Orders operations
  async getOrder(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order;
  }

  async createOrder(orderData: InsertOrder): Promise<Order> {
    const [order] = await db.insert(orders).values(orderData).returning();
    return order;
  }

  async updateOrderStatus(id: string, status: string): Promise<Order | undefined> {
    const [order] = await db.update(orders)
      .set({ status, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    return order;
  }

  async getCustomerOrders(customerId: string): Promise<Order[]> {
    return await db.select().from(orders)
      .where(eq(orders.customerId, customerId))
      .orderBy(desc(orders.createdAt));
  }

  async getConversationOrders(conversationId: string): Promise<Order[]> {
    return await db.select().from(orders)
      .where(eq(orders.conversationId, conversationId))
      .orderBy(desc(orders.createdAt));
  }

  // Delivery operations
  async getDelivery(id: string): Promise<DeliveryWithPerson | undefined> {
    const [delivery] = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(eq(deliveries.id, id));
    
    if (!delivery) return undefined;

    return {
      ...delivery.deliveries,
      deliveryPerson: {
        id: delivery.users.id,
        username: delivery.users.username,
        email: delivery.users.email,
      }
    } as DeliveryWithPerson;
  }

  async getTodayDeliveries(deliveryPersonId: string): Promise<DeliveryWithPerson[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const results = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(and(
        eq(deliveries.deliveryPersonId, deliveryPersonId),
        gte(deliveries.scheduledDate, today),
        lt(deliveries.scheduledDate, tomorrow)
      ))
      .orderBy(deliveries.scheduledDate);

    return results.map(result => ({
      ...result.deliveries,
      deliveryPerson: {
        id: result.users.id,
        username: result.users.username,
        email: result.users.email,
      }
    })) as DeliveryWithPerson[];
  }

  async searchDeliveries(filters: {
    startDate?: Date;
    endDate?: Date;
    status?: string;
    deliveryPersonId?: string;
  }): Promise<DeliveryWithPerson[]> {
    const conditions = [];
    
    if (filters.startDate) {
      conditions.push(gte(deliveries.scheduledDate, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(deliveries.scheduledDate, filters.endDate));
    }
    if (filters.status) {
      conditions.push(eq(deliveries.status, filters.status));
    }
    if (filters.deliveryPersonId) {
      conditions.push(eq(deliveries.deliveryPersonId, filters.deliveryPersonId));
    }

    const results = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(and(...conditions))
      .orderBy(desc(deliveries.scheduledDate));

    return results.map(result => ({
      ...result.deliveries,
      deliveryPerson: {
        id: result.users.id,
        username: result.users.username,
        email: result.users.email,
      }
    })) as DeliveryWithPerson[];
  }

  async createDelivery(deliveryData: InsertDelivery): Promise<DeliveryWithPerson> {
    const [delivery] = await db.insert(deliveries).values(deliveryData).returning();
    
    const result = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(eq(deliveries.id, delivery.id));

    return {
      ...result[0].deliveries,
      deliveryPerson: {
        id: result[0].users.id,
        username: result[0].users.username,
        email: result[0].users.email,
      }
    } as DeliveryWithPerson;
  }

  async confirmDelivery(
    deliveryId: string, 
    deliveryPersonId: string, 
    location: { latitude: number; longitude: number }
  ): Promise<DeliveryWithPerson | undefined> {
    const [delivery] = await db.update(deliveries)
      .set({
        status: 'delivered',
        deliveryTime: new Date(),
        latitude: location.latitude.toString(),
        longitude: location.longitude.toString(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.deliveryPersonId, deliveryPersonId)
      ))
      .returning();

    if (!delivery) return undefined;

    const result = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(eq(deliveries.id, deliveryId));

    return {
      ...result[0].deliveries,
      deliveryPerson: {
        id: result[0].users.id,
        username: result[0].users.username,
        email: result[0].users.email,
      }
    } as DeliveryWithPerson;
  }

  async rejectDelivery(
    deliveryId: string,
    deliveryPersonId: string,
    rejection: { rejectionReasonId: string; rejectionNotes?: string }
  ): Promise<DeliveryWithPerson | undefined> {
    const [delivery] = await db.update(deliveries)
      .set({
        status: 'failed',
        rejectionReasonId: rejection.rejectionReasonId,
        rejectionNotes: rejection.rejectionNotes,
        updatedAt: new Date(),
      })
      .where(and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.deliveryPersonId, deliveryPersonId)
      ))
      .returning();

    if (!delivery) return undefined;

    const result = await db.select()
      .from(deliveries)
      .innerJoin(users, eq(deliveries.deliveryPersonId, users.id))
      .where(eq(deliveries.id, deliveryId));

    return {
      ...result[0].deliveries,
      deliveryPerson: {
        id: result[0].users.id,
        username: result[0].users.username,
        email: result[0].users.email,
      }
    } as DeliveryWithPerson;
  }

  // Delivery Rejection Reasons operations
  async getDeliveryRejectionReason(id: string): Promise<DeliveryRejectionReason | undefined> {
    const [reason] = await db.select().from(deliveryRejectionReasons)
      .where(eq(deliveryRejectionReasons.id, id));
    return reason;
  }

  async getAllDeliveryRejectionReasons(): Promise<DeliveryRejectionReason[]> {
    return await db.select().from(deliveryRejectionReasons)
      .orderBy(deliveryRejectionReasons.reason);
  }

  async getActiveDeliveryRejectionReasons(): Promise<DeliveryRejectionReason[]> {
    return await db.select().from(deliveryRejectionReasons)
      .where(eq(deliveryRejectionReasons.isActive, true))
      .orderBy(deliveryRejectionReasons.reason);
  }

  async createDeliveryRejectionReason(reasonData: InsertDeliveryRejectionReason): Promise<DeliveryRejectionReason> {
    const [reason] = await db.insert(deliveryRejectionReasons).values(reasonData).returning();
    return reason;
  }

  async updateDeliveryRejectionReason(
    id: string, 
    reasonData: Partial<InsertDeliveryRejectionReason>
  ): Promise<DeliveryRejectionReason | undefined> {
    const [reason] = await db.update(deliveryRejectionReasons)
      .set({ ...reasonData, updatedAt: new Date() })
      .where(eq(deliveryRejectionReasons.id, id))
      .returning();
    return reason;
  }

  async deleteDeliveryRejectionReason(id: string): Promise<void> {
    await db.delete(deliveryRejectionReasons).where(eq(deliveryRejectionReasons.id, id));
  }

  // WhatsApp Conversation Analysis operations
  async getWhatsappAnalysis(id: string): Promise<WhatsappConversationAnalysis | undefined> {
    const [analysis] = await db.select().from(whatsappConversationAnalysis)
      .where(eq(whatsappConversationAnalysis.id, id));
    return analysis;
  }

  async createWhatsappAnalysis(analysisData: InsertWhatsappConversationAnalysis): Promise<WhatsappConversationAnalysis> {
    const [analysis] = await db.insert(whatsappConversationAnalysis).values({
      ...analysisData,
      updatedAt: new Date()
    }).returning();
    return analysis;
  }

  async updateWhatsappAnalysis(
    id: string, 
    analysisData: Partial<InsertWhatsappConversationAnalysis>
  ): Promise<WhatsappConversationAnalysis | undefined> {
    const [analysis] = await db.update(whatsappConversationAnalysis)
      .set({ ...analysisData, updatedAt: new Date() })
      .where(eq(whatsappConversationAnalysis.id, id))
      .returning();
    return analysis;
  }

  async getAllWhatsappAnalyses(): Promise<WhatsappConversationAnalysis[]> {
    return await db.select().from(whatsappConversationAnalysis)
      .orderBy(desc(whatsappConversationAnalysis.analysisDate));
  }

  async getWhatsappAnalysesByStatus(status: string): Promise<WhatsappConversationAnalysis[]> {
    return await db.select().from(whatsappConversationAnalysis)
      .where(eq(whatsappConversationAnalysis.analysisStatus, status))
      .orderBy(desc(whatsappConversationAnalysis.analysisDate));
  }

  async getWhatsappAnalysisByConversationId(conversationId: string): Promise<WhatsappConversationAnalysis | undefined> {
    const [analysis] = await db.select().from(whatsappConversationAnalysis)
      .where(eq(whatsappConversationAnalysis.conversationId, conversationId));
    return analysis;
  }

  async updateAnalysisKnowledgeFileUpdate(id: string): Promise<void> {
    await db.update(whatsappConversationAnalysis)
      .set({ lastKnowledgeFileUpdate: new Date(), updatedAt: new Date() })
      .where(eq(whatsappConversationAnalysis.id, id));
  }

  // Knowledge Base operations
  async getKnowledgeBase(id: string): Promise<KnowledgeBase | undefined> {
    const [knowledge] = await db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.id, id));
    return knowledge;
  }

  async createKnowledgeBase(knowledgeData: InsertKnowledgeBase): Promise<KnowledgeBase> {
    const [knowledge] = await db.insert(knowledgeBase).values(knowledgeData).returning();
    return knowledge;
  }

  async getLatestKnowledgeBase(): Promise<KnowledgeBase | undefined> {
    const [knowledge] = await db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.isActive, true))
      .orderBy(desc(knowledgeBase.lastGenerated))
      .limit(1);
    return knowledge;
  }

  async getAllKnowledgeBases(): Promise<KnowledgeBase[]> {
    return await db.select().from(knowledgeBase)
      .orderBy(desc(knowledgeBase.lastGenerated));
  }

  async updateKnowledgeBaseStats(id: string, conversationCount: number): Promise<KnowledgeBase | undefined> {
    const [knowledge] = await db.update(knowledgeBase)
      .set({ conversationCount, lastGenerated: new Date() })
      .where(eq(knowledgeBase.id, id))
      .returning();
    return knowledge;
  }

  // System Settings operations
  async getSystemSetting(key: string): Promise<SystemSettings | undefined> {
    const [setting] = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, key));
    return setting;
  }

  async setSystemSetting(key: string, value: string, description?: string, updatedBy?: string): Promise<SystemSettings> {
    const existing = await this.getSystemSetting(key);
    
    if (existing) {
      // Update existing setting
      const [setting] = await db.update(systemSettings)
        .set({ 
          value, 
          description: description || existing.description,
          updatedBy,
          updatedAt: new Date() 
        })
        .where(eq(systemSettings.key, key))
        .returning();
      return setting;
    } else {
      // Create new setting
      const [setting] = await db.insert(systemSettings)
        .values({ 
          key, 
          value, 
          description,
          updatedBy 
        })
        .returning();
      return setting;
    }
  }

  async getAllSystemSettings(): Promise<SystemSettings[]> {
    return await db.select().from(systemSettings)
      .orderBy(systemSettings.key);
  }

  async deleteSystemSetting(key: string): Promise<void> {
    await db.delete(systemSettings)
      .where(eq(systemSettings.key, key));
  }

  // Export and Statistics methods
  async getConversationsForExport(startDate: Date, endDate: Date): Promise<any[]> {
    const result = await db
      .select({
        id: conversations.id,
        status: conversations.status,
        priority: conversations.priority,
        createdAt: conversations.createdAt,
        resolvedAt: conversations.resolvedAt,
        responseTime: conversations.responseTime,
        waitingTime: conversations.waitingTime,
        customer: {
          name: customers.name,
          phone: customers.phone,
        },
        agent: {
          name: agents.name,
        },
        messageCount: sql<number>`count(${messages.id})`.as('messageCount'),
        finishedByInactivity: sql<boolean>`EXISTS(
          SELECT 1 FROM ${auditLog} 
          WHERE ${auditLog.action} = 'conversation_auto_finished' 
          AND ${auditLog.entityId} = ${conversations.id}
        )`.as('finishedByInactivity'),
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .leftJoin(agents, eq(conversations.agentId, agents.id))
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .where(
        and(
          gte(conversations.createdAt, startDate),
          lte(conversations.createdAt, endDate)
        )
      )
      .groupBy(
        conversations.id,
        customers.name,
        customers.phone,
        agents.name
      )
      .orderBy(desc(conversations.createdAt));

    return result;
  }

  async getTopCustomersByTime(startDate: Date, limit: number): Promise<any[]> {
    const result = await db
      .select({
        customerName: customers.name,
        customerPhone: customers.phone,
        totalTimeMinutes: sql<number>`COALESCE(SUM(${conversations.responseTime}), 0) / 60`.as('totalTimeMinutes'),
        conversationCount: sql<number>`COUNT(${conversations.id})`.as('conversationCount'),
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(
        and(
          gte(conversations.createdAt, startDate),
          eq(conversations.status, 'resolved')
        )
      )
      .groupBy(customers.id, customers.name, customers.phone)
      .orderBy(desc(sql`SUM(${conversations.responseTime})`))
      .limit(limit);

    return result;
  }

  async getTopCustomersByConversations(startDate: Date, limit: number): Promise<any[]> {
    const result = await db
      .select({
        customerName: customers.name,
        customerPhone: customers.phone,
        conversationCount: sql<number>`COUNT(${conversations.id})`.as('conversationCount'),
        totalTimeMinutes: sql<number>`COALESCE(SUM(${conversations.responseTime}), 0) / 60`.as('totalTimeMinutes'),
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(gte(conversations.createdAt, startDate))
      .groupBy(customers.id, customers.name, customers.phone)
      .orderBy(desc(sql`COUNT(${conversations.id})`))
      .limit(limit);

    return result;
  }
}

export const storage = new DatabaseStorage();