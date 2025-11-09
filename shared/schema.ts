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
  date,
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
export const userRoleEnum = pgEnum('user_role', ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing', 'motorista']);

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

// Visit periodicity enum (semanal=7d, quinzenal=14d, mensal=28d)
export const visitPeriodicityEnum = pgEnum('visit_periodicity', ['semanal', 'quinzenal', 'mensal']);

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
  inactivatedAt: timestamp("inactivated_at"),
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
  
  // Tempo médio de entrega em minutos (calculado com base em check-ins/check-outs dos entregadores)
  averageDeliveryTime: integer("average_delivery_time").notNull().default(10),
  
  // Status no Omie (ativo/inativo)
  omieStatus: varchar("omie_status").default('ativo'), // 'ativo' ou 'inativo'
  situacao: varchar("situacao"), // Campo direto do Omie (ativo/inativo/suspenso/etc)
  omieClientCode: varchar("omie_client_code"), // Código numérico do cliente no Omie (codigo_cliente_omie)
  
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
  price: decimal("price", { precision: 10, scale: 2 }).notNull(), // Mantido para compatibilidade (equivalente ao retail_price)
  
  // Tabelas de preço para diferentes tipos de cliente
  retailPrice: decimal("retail_price", { precision: 10, scale: 2 }), // Varejo (consumidor < R$200)
  wholesalePrice: decimal("wholesale_price", { precision: 10, scale: 2 }), // Atacado (consumidor >= R$200)
  resaleGoianiaPrice: decimal("resale_goiania_price", { precision: 10, scale: 2 }), // Revenda Goiânia
  resaleInteriorPrice: decimal("resale_interior_price", { precision: 10, scale: 2 }), // Revenda Interior Goiás
  resaleBrasiliaPrice: decimal("resale_brasilia_price", { precision: 10, scale: 2 }), // Revenda Brasília/Entorno
  
  stock: integer("stock").notNull().default(0),
  imageUrl: varchar("image_url"), // Imagem principal (mantido para compatibilidade)
  images: text("images").array(), // Array de URLs de imagens (galeria)
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Product reviews table - Avaliações de produtos no hotsite
export const productReviews = pgTable("product_reviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull(),
  customerName: varchar("customer_name").notNull(),
  customerEmail: varchar("customer_email"),
  rating: integer("rating").notNull(), // 1-5 estrelas
  comment: text("comment"),
  isApproved: boolean("is_approved").notNull().default(false), // Reviews precisam aprovação antes de aparecer
  createdAt: timestamp("created_at").defaultNow(),
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
  status: varchar("status").notNull().default('pending'), // pending, overdue, failed, completed, invoiced, telemarketing, cancelled, transferred
  
  // NOVO SISTEMA: Cards permanentes com histórico
  isPermanent: boolean("is_permanent").notNull().default(false), // Flag de card permanente (1 por cliente ativo)
  lastVisitDate: timestamp("last_visit_date"), // Última visita realizada (calculado do order_history)
  nextVisitDate: timestamp("next_visit_date"), // Próxima visita calculada (baseada em weekdays + periodicity)
  daysOverdue: integer("days_overdue").notNull().default(0), // Dias de atraso (0, 1, 2, 3+)
  
  // DEPRECATED: scheduledDate agora é NULLABLE (calculado dinamicamente para cards permanentes)
  scheduledDate: timestamp("scheduled_date"), // Mantido apenas para compatibilidade durante migração
  attendanceStartDate: timestamp("attendance_start_date"), // Data de início de atendimento (prioriza checkInTime > scheduledDate > serviceStartDate)
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
  
  // Configurações de entrega com veículo exclusivo (admin-only)
  exclusiveVehicle: boolean("exclusive_vehicle").notNull().default(false), // Entrega em veículo exclusivo
  vehicleTypes: jsonb("vehicle_types").$type<string[]>().default([]), // Tipos de veículos: ["caminhao", "carro", "moto"] - max 2
  isUrgent: boolean("is_urgent").notNull().default(false), // Marcador de entrega urgente
  
  // Origem do pedido
  source: varchar("source").default('integra'), // Origem: 'integra', 'hotsite', 'telemarketing', etc
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Order History - Histórico de pedidos dentro de cada sales card
export const orderHistory = pgTable("order_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesCardId: varchar("sales_card_id").notNull().references(() => salesCards.id, { onDelete: 'cascade' }), // FK para sales_cards
  
  // Dados do pedido
  orderDate: timestamp("order_date").notNull().defaultNow(), // Data em que o pedido foi realizado
  products: jsonb("products").$type<Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>().notNull(),
  totalValue: decimal("total_value", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  
  // Status do pedido individual
  status: varchar("status").notNull().default('pending'), // pending, completed, delivered, cancelled
  
  // Check-in/Check-out do vendedor neste pedido específico
  checkInTime: timestamp("check_in_time"),
  checkOutTime: timestamp("check_out_time"),
  checkInLatitude: decimal("check_in_latitude", { precision: 10, scale: 8 }),
  checkInLongitude: decimal("check_in_longitude", { precision: 11, scale: 8 }),
  checkOutLatitude: decimal("check_out_latitude", { precision: 10, scale: 8 }),
  checkOutLongitude: decimal("check_out_longitude", { precision: 11, scale: 8 }),
  distanceToCustomer: decimal("distance_to_customer", { precision: 10, scale: 2 }),
  checkInPhotoUrl: text("check_in_photo_url"),
  
  // Entrega específica deste pedido
  deliveryStatus: deliveryStatusEnum("delivery_status").default('pending'),
  deliveryScheduledDate: timestamp("delivery_scheduled_date"),
  deliveryCompletedDate: timestamp("delivery_completed_date"),
  deliveryNotes: text("delivery_notes"),
  trackingCode: varchar("tracking_code"),
  
  // Integração Omie para este pedido
  omieOrderId: varchar("omie_order_id"),
  invoiceNumber: varchar("invoice_number"),
  
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

// Delivery routes table - Rotas de entrega planejadas
export const deliveryRoutes = pgTable("delivery_routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  routeDate: timestamp("route_date").notNull(),
  vehicleType: varchar("vehicle_type").notNull(), // caminhao, carro, moto
  driverId: varchar("driver_id"), // ID do motorista (se já atribuído)
  startLatitude: decimal("start_latitude", { precision: 10, scale: 8 }).notNull(),
  startLongitude: decimal("start_longitude", { precision: 11, scale: 8 }).notNull(),
  totalDistance: decimal("total_distance", { precision: 10, scale: 2 }), // Distância total em km
  totalDeliveries: integer("total_deliveries").notNull().default(0),
  estimatedDuration: integer("estimated_duration"), // Duração estimada em minutos
  estimatedReturnTime: timestamp("estimated_return_time"), // Horário estimado de retorno
  timeWindowStart: varchar("time_window_start"), // Início da janela de horário (ex: "08:00")
  timeWindowEnd: varchar("time_window_end"), // Fim da janela de horário (ex: "12:00")
  status: varchar("status").notNull().default('planned'), // planned, in_progress, completed, cancelled
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Delivery route stops table - Paradas de cada rota
export const deliveryRouteStops = pgTable("delivery_route_stops", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  routeId: varchar("route_id").notNull(),
  salesCardId: varchar("sales_card_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  customerName: varchar("customer_name").notNull(),
  customerAddress: text("customer_address").notNull(),
  customerLatitude: decimal("customer_latitude", { precision: 10, scale: 8 }).notNull(),
  customerLongitude: decimal("customer_longitude", { precision: 11, scale: 8 }).notNull(),
  stopOrder: integer("stop_order").notNull(), // Ordem da parada na rota
  estimatedArrival: timestamp("estimated_arrival"), // Horário estimado de chegada
  estimatedDuration: integer("estimated_duration").notNull().default(10), // Tempo estimado de permanência em minutos
  distanceFromPrevious: decimal("distance_from_previous", { precision: 10, scale: 2 }), // Distância da parada anterior em km
  isPriority: boolean("is_priority").notNull().default(false),
  status: varchar("status").notNull().default('pending'), // pending, completed, failed
  completedAt: timestamp("completed_at"),
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
  vendedores: jsonb("vendedores").$type<number[]>(), // Array de códigos de vendedores
  debts: jsonb("debts").$type<Array<{
    numero_documento: string;
    codigo_lancamento_omie: number;
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
  vendorCode: varchar("vendor_code"), // Código do vendedor no Omie (titulo_vendedor_id)
  billingType: billingTypeEnum("billing_type").notNull(), // Tipo de faturamento
  invoiceStatus: varchar("invoice_status"), // Status da nota fiscal no Omie
  invoiceStage: varchar("invoice_stage"), // Etapa do pedido/nota fiscal (cEtapa do Omie)
  stageName: varchar("stage_name"), // Nome da etapa (etapa_descricao)
  isCancelled: boolean("is_cancelled").notNull().default(false), // Se a nota foi cancelada
  
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
  blockReason: varchar("block_reason").notNull(), // 'operation_type', 'overdue_debt', 'credit_limit', 'payment_term'
  blockDetails: text("block_details"), // Detalhes específicos do bloqueio
  operationType: operationTypeEnum("operation_type"),
  paymentMethod: paymentMethodEnum("payment_method"), // Método de pagamento
  boletoDays: integer("boleto_days"), // Prazo do boleto em dias (se aplicável)
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

// Daily Routes table - rotas otimizadas diárias para vendedores
export const dailyRoutes = pgTable("daily_routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sellerId: varchar("seller_id").notNull(),
  routeDate: timestamp("route_date").notNull(), // Data da rota
  
  // Ponto inicial (casa do vendedor)
  startLatitude: decimal("start_latitude", { precision: 10, scale: 8 }).notNull(),
  startLongitude: decimal("start_longitude", { precision: 11, scale: 8 }).notNull(),
  startAddress: text("start_address"),
  
  // Rota otimizada (array de IDs de visitas na ordem)
  optimizedOrder: jsonb("optimized_order").$type<string[]>().notNull(), // Array de visit IDs
  
  // Estatísticas da rota
  totalEstimatedDistance: decimal("total_estimated_distance", { precision: 10, scale: 2 }), // km
  totalActualDistance: decimal("total_actual_distance", { precision: 10, scale: 2 }), // km percorrido real
  totalVisits: integer("total_visits").notNull(),
  completedVisits: integer("completed_visits").notNull().default(0),
  
  // Status da rota
  routeStatus: varchar("route_status").notNull().default('pending'), // pending, in_progress, completed
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_daily_routes_seller_date").on(table.sellerId, table.routeDate),
  unique("unique_daily_route_seller_date").on(table.sellerId, table.routeDate),
]);

// Route Checkpoints table - registra cada ponto da rota (check-in/check-out)
export const routeCheckpoints = pgTable("route_checkpoints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dailyRouteId: varchar("daily_route_id").notNull(),
  visitId: varchar("visit_id").notNull(), // Referência ao sales_card
  customerId: varchar("customer_id").notNull(), // Referência ao cliente visitado
  sellerId: varchar("seller_id").notNull(),
  
  // Dados do checkpoint
  checkpointType: varchar("checkpoint_type").notNull(), // check_in, check_out
  checkpointLatitude: decimal("checkpoint_latitude", { precision: 10, scale: 8 }).notNull(),
  checkpointLongitude: decimal("checkpoint_longitude", { precision: 11, scale: 8 }).notNull(),
  checkpointTime: timestamp("checkpoint_time").notNull(),
  
  // Controle de visitas extras (fora da rota planejada)
  isOffRoute: boolean("is_off_route").default(false).notNull(), // true se não estava na rota original
  validationStatus: varchar("validation_status").default("pending"), // pending, validated, cancelled
  validatedBy: varchar("validated_by"), // ID do admin que validou/cancelou
  validatedAt: timestamp("validated_at"),
  
  // Distância desde o ponto anterior
  distanceFromPrevious: decimal("distance_from_previous", { precision: 10, scale: 2 }), // km
  
  // Localização do ponto anterior
  previousLatitude: decimal("previous_latitude", { precision: 10, scale: 8 }),
  previousLongitude: decimal("previous_longitude", { precision: 11, scale: 8 }),
  
  // Sequência na rota
  sequenceNumber: integer("sequence_number").notNull(),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_route_checkpoints_route").on(table.dailyRouteId),
  index("idx_route_checkpoints_visit").on(table.visitId),
  index("idx_route_checkpoints_customer").on(table.customerId),
]);

// Visit Schedule History - Histórico de visitas agendadas e realizadas
export const visitScheduleHistory = pgTable("visit_schedule_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  
  // Data agendada da visita
  scheduledDate: date("scheduled_date").notNull(), // Apenas data, sem hora
  weekday: varchar("weekday").notNull(), // "Seg", "Ter", "Qua", etc
  periodicity: visitPeriodicityEnum("periodicity").notNull(), // semanal, quinzenal, mensal, bimestral
  
  // Status da visita
  visitStatus: varchar("visit_status").notNull().default('scheduled'), // scheduled, completed, missed, cancelled
  
  // Dados de execução (quando há check-in)
  checkInTime: timestamp("check_in_time"),
  checkOutTime: timestamp("check_out_time"),
  checkInLatitude: decimal("check_in_latitude", { precision: 10, scale: 8 }),
  checkInLongitude: decimal("check_in_longitude", { precision: 11, scale: 8 }),
  
  // Referência ao checkpoint (se fez check-in)
  routeCheckpointId: varchar("route_checkpoint_id"),
  
  // Dados do cliente (cache para performance)
  customerName: varchar("customer_name").notNull(),
  customerAddress: text("customer_address"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_visit_schedule_customer").on(table.customerId),
  index("idx_visit_schedule_seller_date").on(table.sellerId, table.scheduledDate),
  index("idx_visit_schedule_status").on(table.visitStatus),
  unique("unique_visit_schedule_customer_date").on(table.customerId, table.scheduledDate),
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
  orders: many(orderHistory), // Histórico de pedidos do card
}));

export const orderHistoryRelations = relations(orderHistory, ({ one }) => ({
  salesCard: one(salesCards, {
    fields: [orderHistory.salesCardId],
    references: [salesCards.id],
  }),
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
  // Data de início do fornecimento como opcional (aceita string ISO ou Date)
  serviceStartDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  // Validação de weekdays: deve ser JSON array com 1 ou 2 dias (opcional)
  weekdays: z.string().refine(
    (val) => {
      if (!val) return true; // Permitir vazio
      try {
        const days = JSON.parse(val);
        return Array.isArray(days) && days.length >= 1 && days.length <= 2;
      } catch {
        return false;
      }
    },
    { message: "Cliente deve ter entre 1 e 2 dias de rota por semana" }
  ).optional(),
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
}).extend({
  // Aceitar números ou strings para campos de preço e converter para string
  price: z.union([z.string(), z.number()]).transform(val => String(val)).optional(),
  retailPrice: z.union([z.string(), z.number(), z.null()]).transform(val => val === null ? null : String(val)).optional().nullable(),
  wholesalePrice: z.union([z.string(), z.number(), z.null()]).transform(val => val === null ? null : String(val)).optional().nullable(),
  resaleGoianiaPrice: z.union([z.string(), z.number(), z.null()]).transform(val => val === null ? null : String(val)).optional().nullable(),
  resaleInteriorPrice: z.union([z.string(), z.number(), z.null()]).transform(val => val === null ? null : String(val)).optional().nullable(),
  resaleBrasiliaPrice: z.union([z.string(), z.number(), z.null()]).transform(val => val === null ? null : String(val)).optional().nullable(),
});

export const insertProductReviewSchema = createInsertSchema(productReviews).omit({
  id: true,
  createdAt: true,
}).extend({
  rating: z.number().min(1).max(5),
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
  
  // Validação de configuração de veículo exclusivo
  exclusiveVehicle: z.boolean().default(false),
  vehicleTypes: z.array(z.enum(['caminhao', 'carro', 'moto'])).max(2, 'Selecione no máximo 2 tipos de veículos').default([]),
});

export const insertOrderHistorySchema = createInsertSchema(orderHistory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // Campos de data aceitam string ISO ou Date
  orderDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional(),
  checkInTime: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  checkOutTime: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  deliveryScheduledDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  deliveryCompletedDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  // Coordenadas GPS podem ser números ou strings
  checkInLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkInLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLatitude: z.union([z.string(), z.number()]).optional().nullable(),
  checkOutLongitude: z.union([z.string(), z.number()]).optional().nullable(),
  distanceToCustomer: z.union([z.string(), z.number()]).optional().nullable(),
  // Valor total pode ser número ou string
  totalValue: z.union([z.string(), z.number()]).transform(val => String(val)),
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
}).extend({
  // Aceitar números e converter para string (PostgreSQL decimal)
  // Preserva zero como valor válido, apenas converte null/undefined/string vazia
  positivationGoal: z.union([z.string(), z.number()]).nullable().optional().transform(val => 
    (val === null || val === undefined || val === '') ? null : String(val)
  ),
  revenueGoal: z.union([z.string(), z.number()]).nullable().optional().transform(val => 
    (val === null || val === undefined || val === '') ? null : String(val)
  ),
  overdueDebtGoal: z.union([z.string(), z.number()]).nullable().optional().transform(val => 
    (val === null || val === undefined || val === '') ? null : String(val)
  ),
  serviceGoal: z.union([z.string(), z.number()]).nullable().optional().transform(val => 
    (val === null || val === undefined || val === '') ? null : String(val)
  ),
});

export const insertVisitAgendaSchema = createInsertSchema(visitAgenda).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertVisitScheduleHistorySchema = createInsertSchema(visitScheduleHistory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  scheduledDate: z.union([z.string(), z.date()]).transform(val => {
    if (typeof val === 'string') return val;
    return val.toISOString().split('T')[0]; // Convert to YYYY-MM-DD
  }),
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

export const insertDeliveryRouteSchema = createInsertSchema(deliveryRoutes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  routeDate: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val),
  estimatedReturnTime: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  startLatitude: z.union([z.string(), z.number()]).transform(val => typeof val === 'number' ? val : parseFloat(val)),
  startLongitude: z.union([z.string(), z.number()]).transform(val => typeof val === 'number' ? val : parseFloat(val)),
});

export const insertDeliveryRouteStopSchema = createInsertSchema(deliveryRouteStops).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  estimatedArrival: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  completedAt: z.union([z.string(), z.date()]).transform(val => typeof val === 'string' ? new Date(val) : val).optional().nullable(),
  customerLatitude: z.union([z.string(), z.number()]).transform(val => typeof val === 'number' ? val : parseFloat(val)),
  customerLongitude: z.union([z.string(), z.number()]).transform(val => typeof val === 'number' ? val : parseFloat(val)),
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
export type InsertProductReview = z.infer<typeof insertProductReviewSchema>;
export type ProductReview = typeof productReviews.$inferSelect;
export type InsertSalesCard = z.infer<typeof insertSalesCardSchema>;
export type SalesCard = typeof salesCards.$inferSelect;
export type InsertOrderHistory = z.infer<typeof insertOrderHistorySchema>;
export type OrderHistory = typeof orderHistory.$inferSelect;
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

export type VisitScheduleHistory = typeof visitScheduleHistory.$inferSelect;
export type InsertVisitScheduleHistory = z.infer<typeof insertVisitScheduleHistorySchema>;

export type Billing = typeof billings.$inferSelect;
export type InsertBilling = z.infer<typeof insertBillingSchema>;

export type SyncState = typeof syncStates.$inferSelect;
export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;

export type DeliveryRoute = typeof deliveryRoutes.$inferSelect;
export type InsertDeliveryRoute = z.infer<typeof insertDeliveryRouteSchema>;

export type DeliveryRouteStop = typeof deliveryRouteStops.$inferSelect;
export type InsertDeliveryRouteStop = z.infer<typeof insertDeliveryRouteStopSchema>;

// Exported Reports table - stores automatically generated Excel reports
export const exportedReports = pgTable("exported_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportType: varchar("report_type").notNull(), // 'overdue_debts', 'sales', etc.
  fileName: varchar("file_name").notNull(),
  fileData: text("file_data").notNull(), // Base64 encoded Excel file
  metadata: jsonb("metadata"), // Store additional info like totalClients, totalAmount, etc.
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: varchar("created_by"),
});

export const insertExportedReportSchema = createInsertSchema(exportedReports).omit({ id: true, createdAt: true });
export type ExportedReport = typeof exportedReports.$inferSelect;
export type InsertExportedReport = z.infer<typeof insertExportedReportSchema>;

// Payment methods type for frontend forms
export type PaymentMethod = 'a_vista' | 'boleto' | 'pix';
export type OperationType = 'venda' | 'troca' | 'amostra';

// Mapeamento dos métodos de pagamento para contas do Omie
export const PAYMENT_METHOD_TO_OMIE_ACCOUNT = {
  'a_vista': 4081856009,  // Omie.CASH (à vista)
  'boleto': 3275551305,   // BB - FILIAL (boleto)
  'pix': 4081856009       // Omie.CASH (PIX)
} as const;

// Mapeamento de dias de boleto para código de parcela do Omie (códigos reais da API)
export const BOLETO_DAYS_TO_PARCELA_CODE = {
  7: 'A07',   // Para 7 dias
  14: 'A14',  // Para 14 dias
  21: 'A21',  // Para 21 dias
  28: 'A28',  // Para 28 dias
  32: 'U85',  // Para 32 dias
  35: 'A35'   // Para 35 dias
} as const;

// Opções de prazo de boleto disponíveis
export const BOLETO_DAYS_OPTIONS = [7, 14, 21, 28, 32, 35] as const;

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

// Sync Status enum
export const syncStatusEnum = pgEnum('sync_status_enum', ['success', 'error', 'in_progress']);

// Sync Status table - tracks last synchronization timestamps for all sync operations
export const syncStatus = pgTable("sync_status", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  syncType: varchar("sync_type").notNull().unique(), // 'omie_clients', 'omie_products', 'omie_billings', 'omie_vendors', 'omie_overdue_debts'
  lastSyncAt: timestamp("last_sync_at").notNull(),
  status: syncStatusEnum("status").notNull().default('success'),
  message: text("message"),
  recordsProcessed: integer("records_processed"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSyncStatusSchema = createInsertSchema(syncStatus).omit({ id: true, updatedAt: true });
export type SyncStatus = typeof syncStatus.$inferSelect;
export type InsertSyncStatus = z.infer<typeof insertSyncStatusSchema>;

// Daily Attendance Performance types - for HR tracking of visit completion rates
export type DailyAttendanceData = {
  date: string; // ISO date string (YYYY-MM-DD)
  scheduledVisits: number; // Total de visitas agendadas no dia
  completedVisits: number; // Total de visitas completadas (com check-out)
  attendancePercentage: number; // Percentual de atendimento (completedVisits / scheduledVisits * 100)
};

export type SellerAttendancePerformance = {
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  dailyData: DailyAttendanceData[];
  monthlyAverage: number; // Média mensal do percentual de atendimento
  totalScheduled: number; // Total de visitas agendadas no mês
  totalCompleted: number; // Total de visitas completadas no mês
  overallPercentage: number; // Percentual geral do mês
};

// Lead status enum - tracks prospect lifecycle
export const leadStatusEnum = pgEnum('lead_status', [
  'pending',      // Aguardando contato inicial
  'scheduled',    // Visita agendada
  'visited',      // Visita realizada
  'converted',    // Convertido em cliente
  'discarded'     // Descartado/Desqualificado
]);

// Leads table - prospects without recurring visits
export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fantasyName: varchar("fantasy_name").notNull(), // Nome fantasia do prospect
  contactName: varchar("contact_name").notNull(), // Nome da pessoa de contato
  phone: varchar("phone").notNull(),
  
  // Geolocalização
  latitude: decimal("latitude", { precision: 9, scale: 6 }),
  longitude: decimal("longitude", { precision: 10, scale: 6 }),
  
  // Foto do local/prospect (base64)
  photoUrl: text("photo_url"), // Foto capturada da câmera em base64
  
  // Data agendada para visita (inclusão na rota) - timestamp para integração com sistema de rotas
  scheduledDate: timestamp("scheduled_date"),
  
  // Vendedor responsável
  sellerId: varchar("seller_id").notNull(),
  
  // Status do lead no pipeline
  status: leadStatusEnum("status").notNull().default('pending'),
  
  // Rastreamento de conversão
  convertedCustomerId: varchar("converted_customer_id"), // ID do cliente criado quando convertido
  convertedAt: timestamp("converted_at"), // Data da conversão
  
  // Rastreamento de descarte
  discardReason: text("discard_reason"), // Motivo de descarte (se status = discarded)
  discardedAt: timestamp("discarded_at"), // Data do descarte
  
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true,
  convertedAt: true,
  discardedAt: true
});
export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;
