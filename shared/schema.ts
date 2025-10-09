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
  unique,
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
export const userRoleEnum = pgEnum('user_role', ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing']);

// User storage table.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  password: varchar("password"), // Hash bcrypt da senha
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: userRoleEnum("role").notNull().default('vendedor'),
  route: varchar("route"),
  isActive: boolean("is_active").notNull().default(true),
  
  // Geolocalização da casa do vendedor
  homeLatitude: decimal("home_latitude", { precision: 9, scale: 6 }),
  homeLongitude: decimal("home_longitude", { precision: 10, scale: 6 }),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Routes table - Define routes with multiple weekdays
export const routes = pgTable("routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull().unique(),
  weekdays: varchar("weekdays").notNull(), // JSON string of selected days: ["segunda", "terca", ...]
  sellerId: varchar("seller_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Customer type enum  
export const customerTypeEnum = pgEnum('customer_type', ['pessoa_fisica', 'pessoa_juridica']);

// Visit periodicity enum
export const visitPeriodicityEnum = pgEnum('visit_periodicity', ['semanal', 'quinzenal', 'mensal', 'bimestral']);

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
  route: varchar("route"), // DEPRECATED: Use weekdays instead
  sellerId: varchar("seller_id").notNull(),
  weekdays: varchar("weekdays").notNull(), // JSON array with 1-2 weekdays: ["segunda"] or ["segunda","quarta"]
  visitPeriodicity: visitPeriodicityEnum("visit_periodicity").notNull().default('semanal'),
  isActive: boolean("is_active").notNull().default(true),
  lastSaleDate: timestamp("last_sale_date"),
  lastSaleValue: decimal("last_sale_value", { precision: 10, scale: 2 }),
  
  // Geolocalização do cliente
  latitude: decimal("latitude", { precision: 9, scale: 6 }),
  longitude: decimal("longitude", { precision: 10, scale: 6 }),
  coordinatesLocked: boolean("coordinates_locked").notNull().default(false),
  
  // Atendimento virtual (não conta para meta de atendimento)
  virtualService: boolean("virtual_service").notNull().default(false),
  
  // Data de início do fornecimento - só pode ser alterada por admins
  serviceStartDate: timestamp("service_start_date"),
  
  // Status no Omie (ativo/inativo)
  omieStatus: varchar("omie_status").default('ativo'), // 'ativo' ou 'inativo'
  situacao: varchar("situacao"), // Campo direto do Omie (ativo/inativo/suspenso/etc)
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Products table
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  omieCode: varchar("omie_code"), // Código de integração do produto no Omie (ex: PRD-MA-350)
  omieCodigo: varchar("omie_codigo"), // Código alfanumérico do Omie (ex: PRD00003)
  omieCodigoProduto: varchar("omie_codigo_produto"), // ID numérico do produto no Omie como string (ex: "2425693571")
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
  distanceToCustomer: decimal("distance_to_customer", { precision: 10, scale: 2 }), // Distância em metros entre vendedor e cliente no check-in
  checkOutDistanceToCustomer: decimal("check_out_distance_to_customer", { precision: 10, scale: 2 }), // Distância em metros entre vendedor e cliente no check-out
  checkInPhotoUrl: text("check_in_photo_url"), // URL da foto tirada no check-in
  
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

// Billing type enum  
export const billingTypeEnum = pgEnum('billing_type', ['venda', 'troca', 'amostra']);

// Billing/Invoice table - Pedidos e notas fiscais do Omie
export const billings = pgTable("billings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  omieOrderId: varchar("omie_order_id").unique(), // ID único do pedido no Omie
  orderNumber: varchar("order_number").notNull(), // Número do pedido no Omie
  omieInvoiceId: varchar("omie_invoice_id"), // ID único da nota fiscal no Omie (quando faturado)
  invoiceNumber: varchar("invoice_number"), // Número da nota fiscal (quando faturado)
  customerFantasyName: varchar("customer_fantasy_name").notNull(), // Nome fantasia do cliente
  customerDocument: varchar("customer_document"), // CPF/CNPJ do cliente
  cfop: varchar("cfop"), // CFOP da nota fiscal
  invoiceDate: timestamp("invoice_date"), // Data de faturamento (quando aplicável)
  orderDate: timestamp("order_date").notNull(), // Data do pedido
  totalValue: decimal("total_value", { precision: 10, scale: 2 }).notNull(), // Valor total
  dueDate: timestamp("due_date"), // Data de vencimento
  paymentMethod: varchar("payment_method"), // Método de pagamento
  sellerName: varchar("seller_name"), // Nome do vendedor
  
  // Dados adicionais do Omie
  omieCustomerCode: varchar("omie_customer_code"), // Código do cliente no Omie
  sellerId: varchar("seller_id"), // ID do vendedor
  billingType: billingTypeEnum("billing_type").notNull(), // Tipo de faturamento
  invoiceStatus: varchar("invoice_status"), // Status da nota fiscal no Omie
  invoiceStage: varchar("invoice_stage"), // Etapa do pedido/nota fiscal (cEtapa do Omie)
  
  // Produtos da nota fiscal
  products: jsonb("products").$type<Array<{
    code: string;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>(),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Sync state table for Omie integrations
export const syncStates = pgTable("sync_states", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  syncType: varchar("sync_type").notNull().unique(), // 'billings', 'customers', etc.
  lastSyncedId: varchar("last_synced_id"), // ID da última nota/cliente sincronizado
  lastSyncedDate: timestamp("last_synced_date"), // Data da última sincronização
  totalProcessed: integer("total_processed").notNull().default(0), // Total de registros processados
  syncStatus: varchar("sync_status").notNull().default('active'), // 'active', 'completed', 'error'
  errorMessage: text("error_message"), // Mensagem de erro, se houver
  
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

// Visit agenda table - agenda de visitas automática baseada na recorrência
export const visitAgenda = pgTable("visit_agenda", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  scheduledDate: timestamp("scheduled_date").notNull(), // Data da visita agendada
  routeDay: varchar("route_day").notNull(), // Dia da semana (segunda, terca, etc)
  recurrenceType: varchar("recurrence_type").notNull(), // semanal, quinzenal, trisemanal, mensal
  isVirtual: boolean("is_virtual").notNull().default(false), // Atendimento virtual
  
  // Status da visita
  visitStatus: varchar("visit_status").notNull().default('pending'), // pending, completed, missed, cancelled
  
  // Dados de execução da visita
  actualCheckIn: timestamp("actual_check_in"),
  actualCheckOut: timestamp("actual_check_out"),
  checkInLatitude: decimal("check_in_latitude", { precision: 10, scale: 8 }),
  checkInLongitude: decimal("check_in_longitude", { precision: 11, scale: 8 }),
  checkOutLatitude: decimal("check_out_latitude", { precision: 10, scale: 8 }),
  checkOutLongitude: decimal("check_out_longitude", { precision: 11, scale: 8 }),
  distanceToCustomer: decimal("distance_to_customer", { precision: 10, scale: 2 }),
  
  // Dados do cliente na data da visita (cache para performance)
  customerName: varchar("customer_name").notNull(),
  customerLatitude: decimal("customer_latitude", { precision: 10, scale: 8 }),
  customerLongitude: decimal("customer_longitude", { precision: 11, scale: 8 }),
  customerAddress: text("customer_address"),
  
  // Vínculo com sales card gerado (se houver venda)
  salesCardId: varchar("sales_card_id"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_visit_agenda_seller_date").on(table.sellerId, table.scheduledDate),
  index("idx_visit_agenda_customer_date").on(table.customerId, table.scheduledDate),
  unique("unique_visit_agenda_customer_date").on(table.customerId, table.scheduledDate),
]);

// Sales Goals table - para definição de metas mensais por vendedor
export const salesGoals = pgTable("sales_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sellerId: varchar("seller_id").notNull(), // ID do vendedor
  month: integer("month").notNull(), // Mês (1-12)
  year: integer("year").notNull(), // Ano
  
  // Meta de Positivação (em percentual)
  positivationGoal: decimal("positivation_goal", { precision: 5, scale: 2 }), // Ex: 85.50%
  
  // Meta de Faturamento (em reais)
  revenueGoal: decimal("revenue_goal", { precision: 12, scale: 2 }), // Ex: 50000.00
  
  // Meta de Débito Vencido (relação percentual)
  overdueDebtGoal: decimal("overdue_debt_goal", { precision: 5, scale: 2 }), // Ex: 5.00%
  
  // Meta de Atendimento (em percentual)
  serviceGoal: decimal("service_goal", { precision: 5, scale: 2 }), // Ex: 90.00%
  
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by").notNull(), // ID do usuário que criou
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_sales_goals_seller_month_year").on(table.sellerId, table.month, table.year),
]);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  customers: many(customers),
  salesCards: many(salesCards),
  messageHistory: many(messageHistory),
  salesGoals: many(salesGoals),
  visitAgenda: many(visitAgenda),
}));

export const salesGoalsRelations = relations(salesGoals, ({ one }) => ({
  seller: one(users, {
    fields: [salesGoals.sellerId],
    references: [users.id],
  }),
  creator: one(users, {
    fields: [salesGoals.createdBy],
    references: [users.id],
  }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  seller: one(users, {
    fields: [customers.sellerId],
    references: [users.id],
  }),
  salesCards: many(salesCards),
  messageHistory: many(messageHistory),
  visitAgenda: many(visitAgenda),
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

export const visitAgendaRelations = relations(visitAgenda, ({ one }) => ({
  customer: one(customers, {
    fields: [visitAgenda.customerId],
    references: [customers.id],
  }),
  seller: one(users, {
    fields: [visitAgenda.sellerId],
    references: [users.id],
  }),
  salesCard: one(salesCards, {
    fields: [visitAgenda.salesCardId],
    references: [salesCards.id],
  }),
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

export const insertRouteSchema = createInsertSchema(routes).omit({
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
  // Data de início do fornecimento como opcional
  serviceStartDate: z.date().nullable().optional(),
  // Validação de weekdays: deve ser JSON array com 1 ou 2 dias
  weekdays: z.string().refine(
    (val) => {
      try {
        const days = JSON.parse(val);
        return Array.isArray(days) && days.length >= 1 && days.length <= 2;
      } catch {
        return false;
      }
    },
    { message: "Cliente deve ter entre 1 e 2 dias de rota por semana" }
  ),
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
  // Campos de data aceitam string ISO ou Date
  scheduledDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional(),
  completedDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  telemarketingDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  deliveryScheduledDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  deliveryCompletedDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  // Coordenadas GPS podem ser números ou strings
  customerLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  customerLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkInLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkInLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  distanceToCustomer: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutDistanceToCustomer: z.union([z.string(), z.number()]).optional().nullable(),
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

export const insertSalesGoalSchema = createInsertSchema(salesGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertVisitAgendaSchema = createInsertSchema(visitAgenda).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBillingSchema = createInsertSchema(billings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSyncStateSchema = createInsertSchema(syncStates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types
export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type InsertRoute = z.infer<typeof insertRouteSchema>;
export type Route = typeof routes.$inferSelect;
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
  isPositivatedThisMonth?: boolean;
  lastActivityStatus?: 'none' | 'success' | 'failed' | 'pending' | 'overdue' | 'scheduled';
  lastActivityDate?: string | null;
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

export type SalesGoal = typeof salesGoals.$inferSelect;
export type InsertSalesGoal = z.infer<typeof insertSalesGoalSchema>;

export type VisitAgenda = typeof visitAgenda.$inferSelect;
export type InsertVisitAgenda = z.infer<typeof insertVisitAgendaSchema>;

export type Billing = typeof billings.$inferSelect;
export type InsertBilling = z.infer<typeof insertBillingSchema>;

export type SyncState = typeof syncStates.$inferSelect;
export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;

// Payment methods type for frontend forms
export type PaymentMethod = 'a_vista' | 'boleto' | 'pix';
export type OperationType = 'venda' | 'troca' | 'amostra';

// Mapeamento dos métodos de pagamento para contas do Omie
export const PAYMENT_METHOD_TO_OMIE_ACCOUNT = {
  'a_vista': 4081856009,  // Omie.CASH (à vista)
  'boleto': 3275551305,   // BB - FILIAL (boleto)
  'pix': 4081856009       // Omie.CASH (PIX)
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
