import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, integer, jsonb, index, decimal } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table for express-session
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Users table for authentication (agents + admin)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: varchar("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("agent"), // agent, admin, delivery
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  lastLogin: timestamp("last_login"),
});

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // null for ChatGPT bot
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  type: text("type").notNull().default("human"), // human, bot
  status: text("status").notNull().default("offline"), // online, offline, busy
  activeConversations: integer("active_conversations").notNull().default(0),
  totalConversations: integer("total_conversations").notNull().default(0),
  lastActivity: timestamp("last_activity").defaultNow(),
  lastHeartbeat: timestamp("last_heartbeat").defaultNow(), // para controle de inatividade
  averageResponseTime: integer("average_response_time").default(0), // em segundos
  totalHandledTime: integer("total_handled_time").default(0), // tempo total em segundos
});

export const customers = pgTable("customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  totalConversations: integer("total_conversations").notNull().default(0),
  lastContact: timestamp("last_contact").defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull().references(() => customers.id),
  agentId: varchar("agent_id").references(() => agents.id),
  status: text("status").notNull().default("new"), // new, assigned, in-progress, resolved
  priority: text("priority").notNull().default("normal"), // normal, urgent
  lastMessageTime: timestamp("last_message_time").defaultNow(),
  lastAgentResponseTime: timestamp("last_agent_response_time"), // para controle de 5 min
  assignedAt: timestamp("assigned_at"), // quando foi atribuído ao agente
  waitingTime: integer("waiting_time"), // tempo de espera em segundos
  responseTime: integer("response_time"), // tempo total de atendimento em segundos
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  senderId: varchar("sender_id").notNull(), // customer or agent id
  senderType: text("sender_type").notNull(), // customer, agent, system
  content: text("content").notNull(),
  messageType: text("message_type").notNull().default("text"), // text, image, file, audio, video, document, location
  mediaUrl: text("media_url"), // URL for media files
  mediaType: text("media_type"), // MIME type (image/jpeg, audio/ogg, etc)
  mediaSize: integer("media_size"), // file size in bytes
  mediaFilename: text("media_filename"), // original filename
  latitude: decimal("latitude", { precision: 10, scale: 7 }), // for location messages
  longitude: decimal("longitude", { precision: 10, scale: 7 }), // for location messages
  locationName: text("location_name"), // location description/name
  timestamp: timestamp("timestamp").defaultNow(),
  isRead: boolean("is_read").notNull().default(false),
});

// Reports and analytics table
export const reports = pgTable("reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // daily, weekly, monthly, custom
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  data: jsonb("data").notNull(), // analytics data
  generatedBy: varchar("generated_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Audit log for tracking all activities
export const auditLog = pgTable("audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  action: text("action").notNull(), // login, logout, conversation_assigned, message_sent, etc
  entityType: text("entity_type"), // conversation, message, user, etc
  entityId: varchar("entity_id"),
  details: jsonb("details"), // additional context
  timestamp: timestamp("timestamp").defaultNow(),
});

// Products table for order management
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  price: text("price").notNull(), // stored as text to match format "9,90"
  size: text("size"), // 350ml, 900ml, etc
  category: text("category").notNull().default("suco"), // suco, etc
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Quick messages templates for agents
export const quickMessages = pgTable("quick_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  content: text("content").notNull(),
  messageType: text("message_type").notNull().default("text"), // text, product_menu, order_form
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Orders table for tracking customer orders
export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  customerId: varchar("customer_id").notNull().references(() => customers.id),
  items: jsonb("items").notNull(), // array of {productId, quantity, price}
  totalAmount: text("total_amount").notNull(),
  status: text("status").notNull().default("pending"), // pending, confirmed, preparing, delivered, cancelled
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  lastLogin: true,
});

export const insertAgentSchema = createInsertSchema(agents).omit({
  id: true,
  activeConversations: true,
  totalConversations: true,
  lastActivity: true,
  lastHeartbeat: true,
  averageResponseTime: true,
  totalHandledTime: true,
});

export const insertCustomerSchema = createInsertSchema(customers).omit({
  id: true,
  totalConversations: true,
  lastContact: true,
});

export const updateCustomerSchema = createInsertSchema(customers).pick({
  name: true,
}).partial();

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  lastMessageTime: true,
  lastAgentResponseTime: true,
  assignedAt: true,
  waitingTime: true,
  responseTime: true,
  createdAt: true,
  resolvedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  timestamp: true,
});

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
});

export const insertAuditLogSchema = createInsertSchema(auditLog).omit({
  id: true,
  timestamp: true,
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
});

export const insertQuickMessageSchema = createInsertSchema(quickMessages).omit({
  id: true,
  createdAt: true,
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type UpdateCustomer = z.infer<typeof updateCustomerSchema>;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type Report = typeof reports.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;

export type AuditLog = typeof auditLog.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;

export type Product = typeof products.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;

export type QuickMessage = typeof quickMessages.$inferSelect;
export type InsertQuickMessage = z.infer<typeof insertQuickMessageSchema>;

export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;

// Extended types for UI
export type ConversationWithCustomer = Conversation & {
  customer: Customer;
  agent?: Agent;
  lastMessage?: Message;
};

export type MessageWithSender = Message & {
  sender?: Agent | Customer;
};

export type AgentWithUser = Agent & {
  user?: User;
};

export type DeliveryWithPerson = Delivery & {
  deliveryPerson: {
    id: string;
    username: string;
    email: string;
  };
};

// Delivery rejection reasons table
export const deliveryRejectionReasons = pgTable("delivery_rejection_reasons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reason: varchar("reason", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Deliveries table
export const deliveries = pgTable("deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").references(() => conversations.id),
  deliveryPersonId: varchar("delivery_person_id").references(() => users.id),
  customerName: varchar("customer_name", { length: 255 }).notNull(),
  customerPhone: varchar("customer_phone", { length: 50 }).notNull(),
  customerAddress: text("customer_address").notNull(),
  orderDetails: jsonb("order_details").notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  scheduledDate: timestamp("scheduled_date").notNull(),
  status: varchar("status", { length: 50 }).default("pending").notNull(), // pending, confirmed, rejected, delivered
  deliveryTime: timestamp("delivery_time"),
  latitude: decimal("latitude", { precision: 10, scale: 8 }),
  longitude: decimal("longitude", { precision: 11, scale: 8 }),
  rejectionReasonId: varchar("rejection_reason_id").references(() => deliveryRejectionReasons.id),
  rejectionNotes: text("rejection_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations for deliveries
export const deliveriesRelations = relations(deliveries, ({ one }) => ({
  conversation: one(conversations, {
    fields: [deliveries.conversationId],
    references: [conversations.id],
  }),
  deliveryPerson: one(users, {
    fields: [deliveries.deliveryPersonId],
    references: [users.id],
  }),
  rejectionReason: one(deliveryRejectionReasons, {
    fields: [deliveries.rejectionReasonId],
    references: [deliveryRejectionReasons.id],
  }),
}));

export const deliveryRejectionReasonsRelations = relations(deliveryRejectionReasons, ({ many }) => ({
  deliveries: many(deliveries),
}));

// Insert schemas for deliveries
export const insertDeliveryRejectionReasonSchema = createInsertSchema(deliveryRejectionReasons).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDeliverySchema = createInsertSchema(deliveries).omit({
  id: true,
  deliveryTime: true,
  latitude: true,
  longitude: true,
  createdAt: true,
  updatedAt: true,
});

// Types for deliveries
export type DeliveryRejectionReason = typeof deliveryRejectionReasons.$inferSelect;
export type InsertDeliveryRejectionReason = z.infer<typeof insertDeliveryRejectionReasonSchema>;

export type Delivery = typeof deliveries.$inferSelect;
export type InsertDelivery = z.infer<typeof insertDeliverySchema>;

export interface DeliveryWithRelations extends Delivery {
  conversation?: ConversationWithCustomer;
  deliveryPerson?: User;
  rejectionReason?: DeliveryRejectionReason;
}

// WhatsApp conversation analysis table
export const whatsappConversationAnalysis = pgTable("whatsapp_conversation_analysis", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id),
  rawConversationData: jsonb("raw_conversation_data").notNull(), // original messages
  extractedData: jsonb("extracted_data").notNull(), // extracted commercial info
  customerName: text("customer_name"),
  companyRepresentative: text("company_representative"),
  orderDate: timestamp("order_date"),
  orderItems: jsonb("order_items"), // array of purchased items
  totalAmount: text("total_amount"),
  analysisStatus: text("analysis_status").notNull().default("pending"), // pending, completed, failed
  analysisDate: timestamp("analysis_date").defaultNow(),
  lastKnowledgeFileUpdate: timestamp("last_knowledge_file_update"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Knowledge base file table
export const knowledgeBase = pgTable("knowledge_base", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  fileSize: integer("file_size").notNull(),
  conversationCount: integer("conversation_count").notNull().default(0),
  lastGenerated: timestamp("last_generated").defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// System settings table for configuration
export const systemSettings = pgTable("system_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  description: text("description"),
  updatedBy: varchar("updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Relations for WhatsApp analysis
export const whatsappConversationAnalysisRelations = relations(whatsappConversationAnalysis, ({ one }) => ({
  conversation: one(conversations, {
    fields: [whatsappConversationAnalysis.conversationId],
    references: [conversations.id],
  }),
}));

// Insert schemas for new tables
export const insertWhatsappConversationAnalysisSchema = createInsertSchema(whatsappConversationAnalysis).omit({
  id: true,
  analysisDate: true,
  createdAt: true,
  updatedAt: true,
});

export const insertKnowledgeBaseSchema = createInsertSchema(knowledgeBase).omit({
  id: true,
  lastGenerated: true,
  createdAt: true,
});

export const insertSystemSettingsSchema = createInsertSchema(systemSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types for new tables
export type WhatsappConversationAnalysis = typeof whatsappConversationAnalysis.$inferSelect;
export type InsertWhatsappConversationAnalysis = z.infer<typeof insertWhatsappConversationAnalysisSchema>;

export type KnowledgeBase = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBase = z.infer<typeof insertKnowledgeBaseSchema>;

export type SystemSettings = typeof systemSettings.$inferSelect;
export type InsertSystemSettings = z.infer<typeof insertSystemSettingsSchema>;
