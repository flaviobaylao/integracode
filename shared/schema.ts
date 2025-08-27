import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
  decimal,
  integer,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// System settings table for admin configurations
export const systemSettings = pgTable("system_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key").notNull().unique(),
  value: text("value").notNull(),
  description: text("description"),
  updatedBy: varchar("updated_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// User roles enum
export const userRoleEnum = pgEnum('user_role', ['admin', 'coordinator', 'administrative', 'vendedor']);

// User storage table.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: userRoleEnum("role").notNull().default('vendedor'),
  route: varchar("route"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Customer type enum  
export const customerTypeEnum = pgEnum('customer_type', ['pessoa_fisica', 'pessoa_juridica']);

// Customers table
export const customers = pgTable("customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  customerType: customerTypeEnum("customer_type").notNull(),
  cpf: varchar("cpf").unique(),
  cnpj: varchar("cnpj").unique(),
  companyName: varchar("company_name"), // Razão social para PJ
  fantasyName: varchar("fantasy_name"), // Nome fantasia para PJ
  phone: varchar("phone").notNull(),
  email: varchar("email"),
  address: text("address").notNull(),
  city: varchar("city"),
  state: varchar("state"),
  zipCode: varchar("zip_code"),
  route: varchar("route").notNull(),
  sellerId: varchar("seller_id").notNull(),
  weekdays: varchar("weekdays").notNull(), // JSON string of selected days
  isActive: boolean("is_active").notNull().default(true),
  lastSaleDate: timestamp("last_sale_date"),
  lastSaleValue: decimal("last_sale_value", { precision: 10, scale: 2 }),
  
  // Geolocalização do cliente
  latitude: decimal("latitude", { precision: 10, scale: 8 }),
  longitude: decimal("longitude", { precision: 11, scale: 8 }),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Products table
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  description: text("description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  stock: integer("stock").notNull().default(0),
  imageUrl: varchar("image_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Sales cards status enum
export const salesCardStatusEnum = pgEnum('sales_card_status', ['pending', 'in_progress', 'completed', 'no_sale']);

// Payment method enum - linked to Omie accounts
export const paymentMethodEnum = pgEnum('payment_method', [
  'a_vista',    // Caixinha (2425423833) 
  'boleto',     // Boleto (2427900197)
  'pix'         // PIX (novo)
]);

// Operation type enum
export const operationTypeEnum = pgEnum('operation_type', [
  'venda',     // Venda normal
  'troca',     // Troca de produto
  'amostra'    // Amostra grátis
]);

// Delivery status enum
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',      // Aguardando entrega
  'in_transit',   // Em trânsito
  'delivered',    // Entregue
  'failed',       // Falha na entrega
  'returned'      // Devolvido
]);

// Blocked orders status enum
export const blockedOrderStatusEnum = pgEnum('blocked_order_status', [
  'blocked',      // Bloqueado
  'released',     // Liberado
  'sent_to_omie'  // Enviado para Omie
]);

// Delivery failure reasons enum
export const deliveryFailureReasonEnum = pgEnum('delivery_failure_reason', [
  'customer_absent',     // Cliente ausente
  'address_incorrect',   // Endereço incorreto
  'customer_refused',    // Cliente recusou
  'payment_issue',       // Problema de pagamento
  'product_damaged',     // Produto danificado
  'other'                // Outros motivos
]);

// Sales cards table - Sistema de vendas recorrentes
export const salesCards = pgTable("sales_cards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  status: varchar("status").notNull().default('pending'), // pending, completed, invoiced, telemarketing, cancelled, transferred
  scheduledDate: timestamp("scheduled_date").notNull(),
  completedDate: timestamp("completed_date"),
  saleValue: decimal("sale_value", { precision: 10, scale: 2 }),
  noSaleReason: text("no_sale_reason"),
  notes: text("notes"),
  
  // Produtos do card de vendas
  products: jsonb("products").$type<Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>(),
  
  // Configuração de recorrência obrigatória
  routeDay: varchar("route_day").notNull(), // segunda, terca, quarta, quinta, sexta, sabado, domingo
  recurrenceType: varchar("recurrence_type").notNull(), // semanal, quinzenal, trisemanal, mensal
  
  // Controle de recorrência
  isRecurring: boolean("is_recurring").default(true), // Se gera próximo card automaticamente
  parentCardId: varchar("parent_card_id"), // ID do card original que gerou este
  nextCardId: varchar("next_card_id"), // ID do próximo card gerado
  duplicatedFromId: varchar("duplicated_from_id"), // Compatibilidade com sistema anterior
  
  // Sistema de telemarketing para cards não atendidos
  telemarketingAssignedTo: varchar("telemarketing_assigned_to"), // ID do atendente de telemarketing
  telemarketingDate: timestamp("telemarketing_date"), // Data que foi para telemarketing
  telemarketingNotes: text("telemarketing_notes"),
  
  // Delivery integration fields
  deliveryStatus: deliveryStatusEnum("delivery_status").default('pending'),
  deliveryScheduledDate: timestamp("delivery_scheduled_date"),
  deliveryCompletedDate: timestamp("delivery_completed_date"),
  deliveryFailureReason: deliveryFailureReasonEnum("delivery_failure_reason"),
  deliveryNotes: text("delivery_notes"),
  deliveryDriverId: varchar("delivery_driver_id"),
  trackingCode: varchar("tracking_code"),
  
  // Integração com Omie ERP
  omieOrderId: varchar("omie_order_id"), // ID do pedido no Omie ERP
  invoiceNumber: varchar("invoice_number"), // Número da nota fiscal emitida
  
  // Novas funcionalidades - Pagamento e Operação
  paymentMethod: paymentMethodEnum("payment_method").notNull().default('a_vista'),
  operationType: operationTypeEnum("operation_type").notNull().default('venda'),
  
  // Configurações de entrega - dias da semana e horários
  deliveryWeekdays: jsonb("delivery_weekdays").$type<string[]>().default([]), // dias da semana selecionados para entrega
  deliveryTimeSlots: jsonb("delivery_time_slots").$type<string[]>().default([]), // horários selecionados para entrega
  deliverySaturdayTimeSlots: jsonb("delivery_saturday_time_slots").$type<string[]>().default([]), // horários específicos para sábados
  
  // Configurações de pagamento boleto
  boletoDays: integer("boleto_days").default(7), // prazo em dias para pagamento boleto
  
  // Georreferenciamento do cliente
  customerLatitude: decimal("customer_latitude", { precision: 10, scale: 8 }), // Latitude da localização do cliente
  customerLongitude: decimal("customer_longitude", { precision: 11, scale: 8 }), // Longitude da localização do cliente
  
  // Controle de check-in e check-out do vendedor
  checkInTime: timestamp("check_in_time"), // Horário de check-in do vendedor
  checkOutTime: timestamp("check_out_time"), // Horário de check-out do vendedor
  checkInLatitude: decimal("check_in_latitude", { precision: 10, scale: 8 }), // Latitude do vendedor no check-in
  checkInLongitude: decimal("check_in_longitude", { precision: 11, scale: 8 }), // Longitude do vendedor no check-in
  checkOutLatitude: decimal("check_out_latitude", { precision: 10, scale: 8 }), // Latitude do vendedor no check-out
  checkOutLongitude: decimal("check_out_longitude", { precision: 11, scale: 8 }), // Longitude do vendedor no check-out
  distanceToCustomer: decimal("distance_to_customer", { precision: 10, scale: 2 }), // Distância em metros entre vendedor e cliente
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// WhatsApp message templates
export const messageTemplates = pgTable("message_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  category: varchar("category").notNull(),
  message: text("message").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// WhatsApp message history
export const messageHistory = pgTable("message_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  templateId: varchar("template_id"),
  message: text("message").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
});

// Delivery history/tracking table
export const deliveryHistory = pgTable("delivery_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesCardId: varchar("sales_card_id").notNull(),
  status: deliveryStatusEnum("status").notNull(),
  timestamp: timestamp("timestamp").defaultNow(),
  location: varchar("location"), // Localização atual da entrega
  notes: text("notes"),
  driverId: varchar("driver_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Delivery drivers table
export const deliveryDrivers = pgTable("delivery_drivers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  phone: varchar("phone").notNull(),
  vehicleType: varchar("vehicle_type"), // Tipo de veículo (moto, carro, etc)
  licensePlate: varchar("license_plate"),
  isActive: boolean("is_active").notNull().default(true),
  currentLocation: varchar("current_location"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Telemarketing agents table
export const telemarketingAgents = pgTable("telemarketing_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // Referência ao usuário do sistema
  name: varchar("name").notNull(),
  phone: varchar("phone"),
  email: varchar("email"),
  isActive: boolean("is_active").notNull().default(true),
  maxCardsPerDay: integer("max_cards_per_day").default(50), // Limite de cards por dia
  currentCardsCount: integer("current_cards_count").default(0), // Cards atuais do dia
  lastAssignedAt: timestamp("last_assigned_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Telemarketing queue control - para controlar fila round-robin
export const telemarketingQueue = pgTable("telemarketing_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lastAssignedAgentId: varchar("last_assigned_agent_id"),
  queuePosition: integer("queue_position").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Overdue debts table - para armazenar débitos vencidos do Omie
export const overdueDebts = pgTable("overdue_debts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull(), // ID do cliente no sistema
  omieClientId: varchar("omie_client_id").notNull(), // ID do cliente no Omie
  clientName: varchar("client_name").notNull(),
  clientDocument: varchar("client_document"), // CPF/CNPJ
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  maxDaysOverdue: integer("max_days_overdue").notNull(),
  debts: jsonb("debts").$type<Array<{
    numero_documento: string;
    valor: number;
    data_vencimento: string;
    dias_atraso: number;
    observacao?: string;
  }>>(),
  lastSyncAt: timestamp("last_sync_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Blocked orders table - para pedidos bloqueados
export const blockedOrders = pgTable("blocked_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesCardId: varchar("sales_card_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  status: blockedOrderStatusEnum("status").notNull().default('blocked'),
  blockReason: varchar("block_reason").notNull(), // 'operation_type', 'overdue_debt', 'credit_limit'
  blockDetails: text("block_details"), // Detalhes específicos do bloqueio
  operationType: operationTypeEnum("operation_type"),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  products: jsonb("products").$type<Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>(),
  blockedAt: timestamp("blocked_at").defaultNow(),
  releasedAt: timestamp("released_at"),
  releasedBy: varchar("released_by"), // ID do usuário que liberou
  omieOrderId: varchar("omie_order_id"), // ID do pedido no Omie após liberação
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Locations table - para cadastro de localizações
export const locations = pgTable("locations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cpfCnpj: varchar("cpf_cnpj").notNull().unique(), // CPF ou CNPJ do cliente
  fantasyName: varchar("fantasy_name").notNull(), // Nome fantasia do cliente
  latitude: decimal("latitude", { precision: 10, scale: 8 }).notNull(),
  longitude: decimal("longitude", { precision: 11, scale: 8 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  importedAt: timestamp("imported_at").defaultNow(), // Data da importação
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  customers: many(customers),
  salesCards: many(salesCards),
  messageHistory: many(messageHistory),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  seller: one(users, {
    fields: [customers.sellerId],
    references: [users.id],
  }),
  salesCards: many(salesCards),
  messageHistory: many(messageHistory),
}));

export const salesCardsRelations = relations(salesCards, ({ one, many }) => ({
  customer: one(customers, {
    fields: [salesCards.customerId],
    references: [customers.id],
  }),
  seller: one(users, {
    fields: [salesCards.sellerId],
    references: [users.id],
  }),
  deliveryDriver: one(deliveryDrivers, {
    fields: [salesCards.deliveryDriverId],
    references: [deliveryDrivers.id],
  }),
  duplicatedFrom: one(salesCards, {
    fields: [salesCards.duplicatedFromId],
    references: [salesCards.id],
  }),
  deliveryHistory: many(deliveryHistory),
}));

export const deliveryHistoryRelations = relations(deliveryHistory, ({ one }) => ({
  salesCard: one(salesCards, {
    fields: [deliveryHistory.salesCardId],
    references: [salesCards.id],
  }),
  driver: one(deliveryDrivers, {
    fields: [deliveryHistory.driverId],
    references: [deliveryDrivers.id],
  }),
}));

export const deliveryDriversRelations = relations(deliveryDrivers, ({ many }) => ({
  salesCards: many(salesCards),
  deliveryHistory: many(deliveryHistory),
}));

export const telemarketingAgentsRelations = relations(telemarketingAgents, ({ one, many }) => ({
  user: one(users, {
    fields: [telemarketingAgents.userId],
    references: [users.id],
  }),
  assignedCards: many(salesCards),
}));

export const messageHistoryRelations = relations(messageHistory, ({ one }) => ({
  customer: one(customers, {
    fields: [messageHistory.customerId],
    references: [customers.id],
  }),
  seller: one(users, {
    fields: [messageHistory.sellerId],
    references: [users.id],
  }),
  template: one(messageTemplates, {
    fields: [messageHistory.templateId],
    references: [messageTemplates.id],
  }),
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCustomerSchema = createInsertSchema(customers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSaleDate: true,
  lastSaleValue: true,
}).extend({
  // Validação customizada para CPF ou CNPJ obrigatório
  cpf: z.string().nullable().optional(),
  cnpj: z.string().nullable().optional(),
}).refine(
  (data) => data.cpf || data.cnpj,
  {
    message: "CPF ou CNPJ é obrigatório",
    path: ["cpf"],
  }
);

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSalesCardSchema = createInsertSchema(salesCards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // Coordenadas GPS podem ser números ou strings
  customerLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  customerLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkInLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkInLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  distanceToCustomer: z.union([z.string(), z.number()]).optional().nullable(),
});

export const insertMessageTemplateSchema = createInsertSchema(messageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageHistorySchema = createInsertSchema(messageHistory).omit({
  id: true,
});

export const insertSystemSettingSchema = createInsertSchema(systemSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertLocationSchema = createInsertSchema(locations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  importedAt: true,
});

// Types
export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customers.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;
export type InsertSalesCard = z.infer<typeof insertSalesCardSchema>;
export type SalesCard = typeof salesCards.$inferSelect;
export type InsertMessageTemplate = z.infer<typeof insertMessageTemplateSchema>;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type InsertMessageHistory = z.infer<typeof insertMessageHistorySchema>;
export type MessageHistory = typeof messageHistory.$inferSelect;

// Extended types with relations
export type CustomerWithSeller = Customer & {
  seller: User;
};

export type SalesCardWithRelations = SalesCard & {
  customer: Customer;
  seller: User;
  deliveryDriver?: any;
};

export type DeliveryDriver = typeof deliveryDrivers.$inferSelect;
export type InsertDeliveryDriver = typeof deliveryDrivers.$inferInsert;

export type OverdueDebt = typeof overdueDebts.$inferSelect;
export type InsertOverdueDebt = typeof overdueDebts.$inferInsert;

export type BlockedOrder = typeof blockedOrders.$inferSelect;
export type InsertBlockedOrder = typeof blockedOrders.$inferInsert;
export type BlockedOrderWithRelations = BlockedOrder & {
  customer: Customer;
  seller: User;
};

export type Location = typeof locations.$inferSelect;
export type InsertLocation = z.infer<typeof insertLocationSchema>;

// Payment methods type for frontend forms
export type PaymentMethod = 'a_vista' | 'boleto' | 'pix';
export type OperationType = 'venda' | 'troca' | 'amostra';

// Mapeamento dos métodos de pagamento para contas do Omie
export const PAYMENT_METHOD_TO_OMIE_ACCOUNT = {
  'a_vista': 2425423833,  // Caixinha
  'boleto': 2427900197,   // Boleto
  'pix': 2425423833       // PIX usa mesma conta da Caixinha por enquanto
} as const;

// Labels para exibição na interface
export const PAYMENT_METHOD_LABELS = {
  'a_vista': 'À Vista',
  'boleto': 'Boleto',
  'pix': 'PIX'
} as const;

export const OPERATION_TYPE_LABELS = {
  'venda': 'Venda',
  'troca': 'Troca',
  'amostra': 'Amostra'
} as const;
