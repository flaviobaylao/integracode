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

// ============================================================================
// WEEKDAY CANONICAL TYPE & NORMALIZATION
// ============================================================================

export const WEEKDAY_CODES = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'] as const;
export type WeekdayCode = typeof WEEKDAY_CODES[number];

export const WeekdayArraySchema = z.array(z.enum(['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom']));

const WEEKDAY_MAP: Record<string, WeekdayCode> = {
  'seg': 'Seg', 'segunda': 'Seg', 'segunda-feira': 'Seg',
  'ter': 'Ter', 'terca': 'Ter', 'terça': 'Ter', 'terca-feira': 'Ter', 'terça-feira': 'Ter',
  'qua': 'Qua', 'quarta': 'Qua', 'quarta-feira': 'Qua',
  'qui': 'Qui', 'quinta': 'Qui', 'quinta-feira': 'Qui',
  'sex': 'Sex', 'sexta': 'Sex', 'sexta-feira': 'Sex',
  'sab': 'Sab', 'sáb': 'Sab', 'sabado': 'Sab', 'sábado': 'Sab',
  'dom': 'Dom', 'domingo': 'Dom',
};

export function normalizeWeekdayInput(input: any): WeekdayCode[] {
  // Reject string literals "null" and "undefined" - these are invalid inputs
  if (input === 'null' || input === 'undefined') {
    throw new Error('Formato inválido de weekdays: valores "null" ou "undefined" não são permitidos');
  }
  
  // Allow truly empty values
  if (!input || input === '[]') return [];
  
  let weekdaysArray: any[];
  
  if (Array.isArray(input)) {
    weekdaysArray = input;
  } else if (typeof input === 'string') {
    // Convert PostgreSQL array format {value1,value2} to JSON array format [value1,value2]
    let normalized = input.trim();
    if (normalized.startsWith('{') && normalized.endsWith('}')) {
      // PostgreSQL array: {"Qua"} or {Seg,Qui}
      normalized = normalized.slice(1, -1); // Remove outer braces
      // Parse elements (handle both quoted and unquoted)
      const elements = [];
      const regex = /"([^"]*)"|([^,]+)/g;
      let match;
      while ((match = regex.exec(normalized)) !== null) {
        const element = (match[1] || match[2]).trim();
        if (element) elements.push(element);
      }
      weekdaysArray = elements;
    } else {
      // Try JSON parse first
      try {
        const parsed = JSON.parse(normalized);
        weekdaysArray = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Not valid JSON - try comma/semicolon separated
        weekdaysArray = normalized.split(/[,;\/]/).map(d => d.trim()).filter(d => d);
      }
    }
  } else {
    // Reject unexpected types (objects, numbers, etc.)
    throw new Error(`Formato inválido de weekdays: esperado array ou string, recebido ${typeof input}`);
  }
  
  if (weekdaysArray.length === 0) return [];
  
  const normalized: WeekdayCode[] = [];
  const unmapped: string[] = [];
  
  for (const day of weekdaysArray) {
    const dayStr = day.toString().trim();
    
    // Handle legacy data: split tokens that contain separators (/, ;, " e ", etc.)
    // Example: "Seg/Qui" → ["Seg", "Qui"], "segunda e quarta" → ["segunda", "quarta"]
    const subDays = dayStr.split(/[\/;,]|\s+e\s+/).map((d: string) => d.trim()).filter((d: string) => d);
    
    for (const subDay of subDays) {
      const dayLower = subDay.toLowerCase().trim();
      const canonical = WEEKDAY_MAP[dayLower];
      
      if (canonical && !normalized.includes(canonical)) {
        normalized.push(canonical);
      } else if (!canonical) {
        unmapped.push(subDay);
      }
    }
  }
  
  if (unmapped.length > 0) {
    throw new Error(`Dias da semana inválidos: ${unmapped.join(', ')}`);
  }
  
  return normalized;
}

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

// ============================================================================
// OMIE INSTANCES - Multi-tenant Omie ERP support
// ============================================================================

// Omie instances table - stores API credentials for multiple Omie accounts
export const omieInstances = pgTable("omie_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull().unique(), // Nome da instância (ex: "GYN", "BSB", "RJ")
  displayName: varchar("display_name").notNull(), // Nome completo (ex: "OMIE GYN - Goiânia")
  appKey: varchar("app_key").notNull(), // Chave APP do Omie
  appSecret: varchar("app_secret").notNull(), // Chave Secret do Omie
  tagColor: varchar("tag_color").notNull().default('#3B82F6'), // Cor da tag em hex (azul padrão)
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false), // Instância padrão para novos registros
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertOmieInstanceSchema = createInsertSchema(omieInstances).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOmieInstance = z.infer<typeof insertOmieInstanceSchema>;
export type OmieInstance = typeof omieInstances.$inferSelect;

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
  
  // Código do vendedor no Omie (para mapeamento correto de clientes)
  omieVendorCode: varchar("omie_vendor_code"),
  
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
  contact: varchar("contact"), // Nome do contato principal
  email: varchar("email"),
  address: text("address").notNull(),
  city: varchar("city"),
  neighborhood: varchar("neighborhood"),
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
  
  // Lead flag (se é um lead ou cliente)
  isLead: boolean("is_lead").notNull().default(false),
  
  // Cliente Consumidor flag (cliente especial com destaque verde)
  isConsumerClient: boolean("is_consumer_client").notNull().default(false),
  
  // Data de início do fornecimento - só pode ser alterada por admins
  serviceStartDate: timestamp("service_start_date"),
  
  // Tempo médio de entrega em minutos (calculado com base em check-ins/check-outs dos entregadores)
  averageDeliveryTime: integer("average_delivery_time").notNull().default(10),
  
  // Configurações de entrega (preferências padrão do cliente)
  exclusiveVehicle: boolean("exclusive_vehicle").notNull().default(false), // Se requer veículo exclusivo para entrega
  vehicleTypes: jsonb("vehicle_types").$type<string[]>().default([]), // Tipos de veículos permitidos: ["caminhao", "carro", "moto"]
  deliveryWeekdays: jsonb("delivery_weekdays").$type<string[]>().default([]), // Dias da semana para entrega (calculados automaticamente: 2 dias úteis após dia de visita)
  receivingWeekdays: jsonb("receiving_weekdays").$type<string[]>().default([]), // Dias da semana em que o cliente aceita receber mercadorias (configurado manualmente via checkboxes)
  deliveryTimeSlots: jsonb("delivery_time_slots").$type<string[]>().default([]), // Horários de recebimento (seg-sex) - quando cliente aceita receber
  deliverySaturdayTimeSlots: jsonb("delivery_saturday_time_slots").$type<string[]>().default([]), // Horários de recebimento aos sábados - quando cliente aceita receber
  
  // Status no Omie (ativo/inativo)
  omieStatus: varchar("omie_status").default('ativo'), // 'ativo' ou 'inativo'
  situacao: varchar("situacao"), // Campo direto do Omie (ativo/inativo/suspenso/etc)
  omieClientCode: varchar("omie_client_code"), // Código numérico do cliente no Omie (codigo_cliente_omie)
  
  // Multi-tenant Omie: identificação da instância de origem
  omieInstanceId: varchar("omie_instance_id"), // Referência à instância Omie de origem (ex: "GYN")
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Virtual Service Logs - Registros de atendimento virtual
export const virtualServiceLogs = pgTable("virtual_service_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(), // ID do cliente ou lead atendido
  entityType: varchar("entity_type").notNull().default('customer'), // Tipo de entidade: 'customer' ou 'lead'
  attendantId: varchar("attendant_id").notNull(), // Usuário que realizou o atendimento
  attendantName: varchar("attendant_name").notNull(), // Nome do atendente (snapshot)
  attendanceDate: timestamp("attendance_date").notNull().defaultNow(), // Data/hora do atendimento
  serviceType: varchar("service_type").notNull().default('prospecao'), // Tipo de atendimento: 'debito_vencido', 'venda', 'prospecao'
  notes: text("notes"), // Notas escritas do atendimento
  images: jsonb("images").$type<string[]>().default([]), // URLs das imagens anexadas
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Virtual Service Logs Insert Schema
export const insertVirtualServiceLogSchema = createInsertSchema(virtualServiceLogs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVirtualServiceLog = z.infer<typeof insertVirtualServiceLogSchema>;
export type VirtualServiceLog = typeof virtualServiceLogs.$inferSelect;

// Prospections table - Acumulação de prospecções por lead
export const prospections = pgTable("prospections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull(), // ID do lead
  type: varchar("type").notNull(), // 'lead_created' ou 'service_registered'
  userId: varchar("user_id").notNull(), // Usuário que criou/atendeu
  userName: varchar("user_name").notNull(), // Nome do usuário (snapshot)
  serviceLogId: varchar("service_log_id"), // ID do virtual_service_log (se type='service_registered')
  notes: text("notes"), // Observações opcionais
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertProspectionSchema = createInsertSchema(prospections).omit({
  id: true,
  createdAt: true,
});

export type InsertProspection = z.infer<typeof insertProspectionSchema>;
export type Prospection = typeof prospections.$inferSelect;

// Products table
export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  omieCode: varchar("omie_code"), // Código de integração do produto no Omie (ex: PRD-MA-350)
  omieCodigo: varchar("omie_codigo"), // Código alfanumérico do Omie (ex: PRD00003)
  omieCodigoProduto: varchar("omie_codigo_produto"), // ID numérico do produto no Omie como string (ex: "2425693571")
  name: varchar("name").notNull(),
  description: text("description"),
  details: text("details"), // Ficha técnica detalhada do produto (exibida no hotsite)
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
  
  // Multi-tenant Omie: identificação da instância de origem
  omieInstanceId: varchar("omie_instance_id"), // Referência à instância Omie de origem
  
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
  customerAddress: text("customer_address"), // Endereço de entrega informado pelo cliente (usado principalmente no hotsite)
  
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
  
  // Vendedor que registrou o pedido (pode ser diferente do seller_id do sales_card/carteira)
  sellerId: varchar("seller_id"), // ID do vendedor que registrou o pedido
  sellerName: varchar("seller_name"), // Nome do vendedor que registrou
  
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

// Delivery history/tracking table - Histórico completo de entregas realizadas
export const deliveryHistory = pgTable("delivery_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceNumber: varchar("invoice_number").notNull(), // Chave primária lógica - número da nota fiscal
  salesCardId: varchar("sales_card_id").notNull(),
  customerId: varchar("customer_id").notNull(), // ID do cliente que recebeu a entrega
  customerName: varchar("customer_name").notNull(), // Nome do cliente
  status: deliveryStatusEnum("status").notNull(),
  timestamp: timestamp("timestamp").defaultNow(), // Data/hora da entrega
  location: varchar("location"), // Localização atual da entrega
  notes: text("notes"),
  
  // Informações do motorista e veículo
  driverId: varchar("driver_id").notNull(), // ID do motorista que efetuou a entrega
  driverName: varchar("driver_name").notNull(), // Nome do motorista
  vehicleType: varchar("vehicle_type").notNull(), // Tipo de veículo usado (caminhao, carro, moto)
  
  // Tempos de check-in e check-out
  checkInTime: timestamp("check_in_time"), // Horário de check-in na entrega
  checkOutTime: timestamp("check_out_time"), // Horário de check-out da entrega
  deliveryDuration: integer("delivery_duration"), // Tempo total da entrega em minutos (check-out - check-in)
  
  createdAt: timestamp("created_at").defaultNow(),
});

// Delivery drivers table
export const deliveryDrivers = pgTable("delivery_drivers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  phone: varchar("phone").notNull(),
  email: varchar("email"), // Email para vinculação com conta de usuário motorista
  vehicleType: varchar("vehicle_type"), // Tipo de veículo (moto, carro, etc)
  licensePlate: varchar("license_plate"),
  isActive: boolean("is_active").notNull().default(true),
  currentLocation: varchar("current_location"),
  homeLatitude: decimal("home_latitude", { precision: 10, scale: 8 }), // Latitude da casa/base do motorista
  homeLongitude: decimal("home_longitude", { precision: 11, scale: 8 }), // Longitude da casa/base do motorista
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Delivery routes table - Rotas de entrega planejadas
export const deliveryRoutes = pgTable("delivery_routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  routeName: varchar("route_name").notNull(), // ROTA-DATA-ENTREGADOR-NUMERO
  routeDate: date("route_date").notNull(),
  vehicleType: varchar("vehicle_type").notNull(), // caminhao, carro, moto
  driverId: varchar("driver_id").notNull(), // ID do motorista
  driverName: varchar("driver_name").notNull(), // Nome do motorista
  driverEmail: varchar("driver_email").notNull(), // Email do motorista (chave de busca)
  startLatitude: decimal("start_latitude", { precision: 10, scale: 8 }).notNull(),
  startLongitude: decimal("start_longitude", { precision: 11, scale: 8 }).notNull(),
  totalDistance: decimal("total_distance", { precision: 10, scale: 2 }).notNull(), // Distância total em km
  totalDeliveries: integer("total_deliveries").notNull().default(0),
  totalDuration: integer("total_duration").notNull(), // Duração total em minutos
  estimatedReturnTime: timestamp("estimated_return_time"), // Horário estimado de retorno
  timeWindowStart: varchar("time_window_start"), // Início da janela de horário (ex: "08:00")
  timeWindowEnd: varchar("time_window_end"), // Fim da janela de horário (ex: "12:00")
  status: varchar("status").notNull().default('planejada'), // planejada, rota salva, rota_enviada, em_andamento, concluida, cancelada
  sentToDriverAt: timestamp("sent_to_driver_at"), // Quando a rota foi enviada para o motorista
  startTime: timestamp("start_time"), // Quando o entregador iniciou a rota
  endTime: timestamp("end_time"), // Quando o entregador finalizou a rota
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Delivery route stops table - Paradas de cada rota
export const deliveryRouteStops = pgTable("delivery_route_stops", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  routeId: varchar("route_id").notNull(),
  salesCardId: varchar("sales_card_id"), // Pode ser nulo quando adicionado via billing
  billingId: varchar("billing_id"), // ID do billing (nota fiscal) relacionado
  orderNumber: varchar("order_number"), // Número do pedido no Omie (para display e identificação)
  omieOrderId: varchar("omie_order_id"), // ID interno do pedido no Omie (codigo_pedido para API)
  customerId: varchar("customer_id").notNull(),
  customerName: varchar("customer_name").notNull(),
  customerAddress: text("customer_address").notNull(),
  customerLatitude: decimal("customer_latitude", { precision: 10, scale: 8 }).notNull(),
  customerLongitude: decimal("customer_longitude", { precision: 11, scale: 8 }).notNull(),
  stopOrder: integer("stop_order").notNull(), // Ordem da parada na rota
  estimatedArrival: varchar("estimated_arrival"), // Horário estimado de chegada (formato HH:mm)
  estimatedDeparture: varchar("estimated_departure"), // Horário estimado de saída (formato HH:mm)
  estimatedServiceTime: integer("estimated_service_time").notNull().default(10), // Tempo estimado de permanência em minutos
  distanceFromPrevious: decimal("distance_from_previous", { precision: 10, scale: 2 }), // Distância da parada anterior em km
  isPriority: boolean("is_priority").notNull().default(false),
  status: varchar("status").notNull().default('pendente'), // pendente, efetuada, em_pausa, devolvida
  checkInTime: timestamp("check_in_time"), // Horário real de check-in
  checkInLatitude: decimal("check_in_latitude", { precision: 10, scale: 8 }), // Coordenadas do check-in
  checkInLongitude: decimal("check_in_longitude", { precision: 11, scale: 8 }),
  checkOutTime: timestamp("check_out_time"), // Horário real de check-out
  checkOutLatitude: decimal("check_out_latitude", { precision: 10, scale: 8 }), // Coordenadas do check-out
  checkOutLongitude: decimal("check_out_longitude", { precision: 11, scale: 8 }),
  photos: jsonb("photos").$type<string[]>().default([]), // Array de URLs de fotos
  notes: text("notes"), // Observações do motorista (motivo de devolução, etc)
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
  
  // Multi-tenant Omie: identificação da instância de origem
  omieInstanceId: varchar("omie_instance_id"), // Referência à instância Omie de origem
  
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
  isUrgent: boolean("is_urgent").notNull().default(false), // Entrega urgente (priorizada na roteirização)
  
  // Configurações de entrega (para billings que não têm sales_card)
  exclusiveVehicle: boolean("exclusive_vehicle").default(false), // Se requer veículo exclusivo
  vehicleTypes: text("vehicle_types").array(), // Tipos de veículo permitidos: ['caminhão', 'carro', 'moto']
  deliveryWeekdays: text("delivery_weekdays").array(), // Dias da semana para entrega
  deliveryTimeSlots: text("delivery_time_slots").array(), // Horários de entrega (seg-sex)
  deliverySaturdayTimeSlots: text("delivery_saturday_time_slots").array(), // Horários de entrega sábado
  
  // Produtos da nota fiscal
  products: jsonb("products").$type<Array<{
    code: string;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>(),
  
  // Multi-tenant Omie: identificação da instância de origem
  omieInstanceId: varchar("omie_instance_id"), // Referência à instância Omie de origem
  
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
  visitDuration: integer("visit_duration"), // Duração em minutos
  isAutoCheckout: boolean("is_auto_checkout").default(false), // Indica se check-out foi automático (30min sem ação)
  
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
  
  // Rota otimizada (array de stopIds na ordem: "customer:<visitId>" ou "lead:<leadId>")
  optimizedOrder: jsonb("optimized_order").$type<string[]>().notNull(), // Array de stop IDs
  
  // Metadata de stops (lookup para cada stopId)
  visitStops: jsonb("visit_stops").$type<{
    [stopId: string]: {
      entityType: 'customer' | 'lead';
      entityId: string;
      visitId?: string; // Para customers, referencia visit_agenda
    };
  }>(),
  
  // Estatísticas da rota
  totalEstimatedDistance: decimal("total_estimated_distance", { precision: 10, scale: 2 }), // km
  totalActualDistance: decimal("total_actual_distance", { precision: 10, scale: 2 }), // km percorrido real
  totalVisits: integer("total_visits").notNull(),
  completedVisits: integer("completed_visits").notNull().default(0),
  
  // Status da rota
  routeStatus: varchar("route_status").notNull().default('pending'), // pending, in_progress, completed
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  
  // Horário de almoço
  lunchBreakActivatedAt: timestamp("lunch_break_activated_at"), // Quando o vendedor marcou início do almoço
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_daily_routes_seller_date").on(table.sellerId, table.routeDate),
  unique("unique_daily_route_seller_date").on(table.sellerId, table.routeDate),
]);

// Zod schemas for Daily Routes API responses
export const dailyRouteVisitSchema = z.object({
  id: z.string(),
  visitType: z.enum(['customer', 'lead']).default('customer'), // Tipo de visita
  entityId: z.string(), // customerId ou leadId
  customerId: z.string().optional(), // Mantido para compatibilidade
  leadId: z.string().optional(), // ID do lead, se aplicável
  customerName: z.string(), // Nome fantasia (customer ou lead)
  customerLatitude: z.union([z.string(), z.number()]).nullable(),
  customerLongitude: z.union([z.string(), z.number()]).nullable(),
  customerAddress: z.string().nullable(),
  scheduledDate: z.string(),
  isVirtual: z.boolean().nullable(),
  visitDuration: z.number().nullable().optional(), // Duração em minutos
  isAutoCheckout: z.boolean().optional(), // Check-out automático (30min)
});

export const routeSegmentSchema = z.object({
  visitId: z.string(),
  from: z.string(),
  to: z.string(),
  distance: z.number(), // metros
});

export const routeProgressSchema = z.object({
  totalVisits: z.number(),
  completedVisits: z.number(),
  totalEstimatedDistance: z.number(),
  totalActualDistance: z.number(),
  percentComplete: z.number(),
});

export const dailyRouteWithDataSchema = z.object({
  id: z.string(),
  sellerId: z.string(),
  routeDate: z.string(),
  startLatitude: z.string(),
  startLongitude: z.string(),
  startAddress: z.string().nullable(),
  optimizedOrder: z.array(z.string()),
  totalEstimatedDistance: z.string().nullable(),
  totalActualDistance: z.string().nullable(),
  totalVisits: z.number(),
  completedVisits: z.number(),
  routeStatus: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  visits: z.array(dailyRouteVisitSchema),
  segments: z.array(routeSegmentSchema),
  sellerHome: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  progress: routeProgressSchema,
  checkpoints: z.array(z.any()),
});

export const dailyRouteResponseSchema = z.object({
  message: z.string().optional(),
  route: dailyRouteWithDataSchema.nullable(),
});

// TypeScript types inferred from Zod schemas
export type DailyRouteVisit = z.infer<typeof dailyRouteVisitSchema>;
export type RouteSegment = z.infer<typeof routeSegmentSchema>;
export type RouteProgress = z.infer<typeof routeProgressSchema>;
export type DailyRouteWithData = z.infer<typeof dailyRouteWithDataSchema>;
export type DailyRouteResponse = z.infer<typeof dailyRouteResponseSchema>;

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
  isAutomatic: boolean("is_automatic").default(false).notNull(), // true se foi gerado automaticamente (ex: por criação de pedido)
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
  
  // Meta de Clientes Novos (número inteiro)
  newClientsGoal: integer("new_clients_goal"), // Ex: 10 clientes novos
  
  // Resultado real de Clientes Novos (inserido por admin/coordenador)
  newClientsResult: integer("new_clients_result"), // Ex: 8 clientes conquistados
  
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
  // Validação de weekdays: deve ser JSON array com 0-2 dias (opcional)
  weekdays: z.string().optional().default('[]').refine(
    (val) => {
      try {
        const days = JSON.parse(val);
        return Array.isArray(days) && days.length <= 2;
      } catch {
        return false;
      }
    },
    { message: "Weekdays deve ser um JSON array com até 2 dias" }
  ),
  // Para leads, permitir telefone e endereço vazios
  phone: z.string().optional(),
  address: z.string().optional(),
  // isLead é optional aqui mas será true para leads
  isLead: z.boolean().optional().default(false),
  // sellerId é obrigatório para leads
  sellerId: z.string().optional(),
}).refine(
  (data) => {
    // Leads podem não ter CPF/CNPJ, mas clientes normais precisam
    if (data.isLead) return true; // Leads não precisam de CPF/CNPJ
    return data.cpf || data.cnpj; // Clientes normais precisam de um deles
  },
  {
    message: "CPF ou CNPJ é obrigatório para clientes",
    path: ["cpf"],
  }
).refine(
  (data) => {
    // Leads PRECISAM ter sellerId
    if (data.isLead) return !!data.sellerId;
    return true; // Clientes podem não ter sellerId (será atribuído depois)
  },
  {
    message: "Vendedor responsável é obrigatório para leads",
    path: ["sellerId"],
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
  vehicleTypes: z.array(z.enum(['caminhao', 'carro', 'moto', 'baruc'])).max(2, 'Selecione no máximo 2 tipos de veículos').default([]),
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
  estimatedArrival: z.string().optional().nullable(),
  estimatedDeparture: z.string().optional().nullable(),
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
  totalRecords: integer("total_records"), // Total de registros a serem processados
  currentProgress: integer("current_progress"), // Progresso atual (0-100 ou contagem)
  lastFinishedAt: timestamp("last_finished_at"), // Data/hora da última conclusão bem-sucedida
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSyncStatusSchema = createInsertSchema(syncStatus).omit({ id: true, updatedAt: true });
export type SyncStatus = typeof syncStatus.$inferSelect;
export type InsertSyncStatus = z.infer<typeof insertSyncStatusSchema>;

// Lead status enum
export const leadStatusEnum = pgEnum('lead_status', ['pending', 'scheduled', 'visited', 'converted', 'discarded']);

// Lead temperature enum - classification of lead interest level
export const leadTemperatureEnum = pgEnum('lead_temperature', ['cold', 'warm', 'hot', 'very_hot']);

// Leads table - prospective customers to be contacted by sellers
export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fantasyName: varchar("fantasy_name").notNull(),
  latitude: decimal("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: decimal("longitude", { precision: 10, scale: 6 }).notNull(),
  contact: varchar("contact"),
  phone: varchar("phone"),
  photo: varchar("photo"), // URL da foto capturada no check-in
  observation: text("observation"),
  status: leadStatusEnum("status").notNull().default('pending'),
  temperature: leadTemperatureEnum("temperature"), // Temperature classification (enforced in frontend)
  
  // Quem criou o lead (admin)
  createdBy: varchar("created_by").notNull(),
  createdByName: varchar("created_by_name"), // Nome do usuário que criou
  
  // Quem está atendendo o lead (vendedor)
  assignedTo: varchar("assigned_to"),
  
  // Informações de check-in/check-out
  lastCheckInAt: timestamp("last_check_in_at"),
  lastCheckOutAt: timestamp("last_check_out_at"),
  
  // Data do próximo contato (definida no registro de atendimento, padrão: 7 dias após último atendimento)
  nextContactDate: timestamp("next_contact_date"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({ 
  id: true, 
  createdAt: true, 
  updatedAt: true,
  lastCheckInAt: true,
  lastCheckOutAt: true,
  nextContactDate: true
}).extend({
  latitude: z.string().or(z.number()),
  longitude: z.string().or(z.number()),
  fantasyName: z.string().min(1, "Nome fantasia é obrigatório"),
  contact: z.string().optional(),
  phone: z.string().optional(),
  observation: z.string().optional(),
  temperature: z.enum(['cold', 'warm', 'hot', 'very_hot'], { required_error: "Temperatura do lead é obrigatória" }),
});

export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;

// Lead Visits table - history of visits/interactions with leads
export const leadVisits = pgTable("lead_visits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: 'cascade' }),
  userId: varchar("user_id").notNull(), // Who registered the visit
  userName: varchar("user_name").notNull(), // Name of the user who registered
  observation: text("observation").notNull(), // Notes about what was discussed
  temperature: leadTemperatureEnum("temperature"), // Optional temperature update
  visitDate: timestamp("visit_date").defaultNow(), // When the visit was registered
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLeadVisitSchema = createInsertSchema(leadVisits).omit({ 
  id: true, 
  createdAt: true,
  visitDate: true,
}).extend({
  observation: z.string().min(1, "Observação é obrigatória"),
  temperature: z.enum(['cold', 'warm', 'hot', 'very_hot']).optional(),
});

export type LeadVisit = typeof leadVisits.$inferSelect;
export type InsertLeadVisit = z.infer<typeof insertLeadVisitSchema>;

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

// ============================================================
// CHAT HONEST INTEGRATION - WhatsApp/Telegram Chat System
// ============================================================

// Chat Agents table - agentes de atendimento do chat (humanos e bots)
export const chatAgents = pgTable("chat_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id"), // 🔗 Link para usuário do sistema
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  status: text("status").notNull().default("offline"), // online, offline, busy
  avatar: text("avatar"),
  isActive: boolean("is_active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"), // 🟢 Última vez que o agente foi visto online (heartbeat)
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Chat Customers table - clientes do WhatsApp/Telegram (separados dos customers de venda)
export const chatCustomers = pgTable("chat_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  avatar: text("avatar"),
  tags: text("tags"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  lastInteractionAt: timestamp("last_interaction_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Phone Number Mapping - mapeamento de números alternativos para o número canônico
// Exemplo: 5504884295924 -> 5562949981841 (mesma pessoa/negócio, diferentes remetentes)
export const phoneNumberMappings = pgTable("phone_number_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  canonicalPhone: varchar("canonical_phone").notNull(), // Número principal/oficial
  alternativePhone: varchar("alternative_phone").notNull(), // Número alternativo/variação
  description: text("description"), // Ex: "Número pessoal" ou "Número anterior"
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique("unique_phone_mapping").on(table.canonicalPhone, table.alternativePhone),
  index("idx_canonical_phone").on(table.canonicalPhone),
  index("idx_alternative_phone").on(table.alternativePhone),
]);

// Chat Conversations status enum
export const chatConversationStatusEnum = pgEnum('chat_conversation_status', ['new', 'assigned', 'in-progress', 'resolved']);
export const chatPriorityEnum = pgEnum('chat_priority', ['normal', 'urgent']);

// Iniciador da conversa enum
export const chatInitiatedByEnum = pgEnum('chat_initiated_by', ['customer', 'user']);

// Chat Conversations table
export const chatConversations = pgTable("chat_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  customerName: varchar("customer_name"),
  customerPhone: varchar("customer_phone"),
  agentId: varchar("agent_id"),
  assignedAgentId: varchar("assigned_agent_id"), // 🔄 Atendente atribuído via round-robin
  assignedAgentColor: varchar("assigned_agent_color"), // 🎨 Cor do atendente para visualização
  lastAttendedAt: timestamp("last_attended_at"), // ⏱️ Última interação do atendente
  initiatedBy: chatInitiatedByEnum("initiated_by").default("customer"), // Quem iniciou: cliente ou usuário
  initiatedByUserId: varchar("initiated_by_user_id"), // Se iniciado por usuário, qual usuário
  status: chatConversationStatusEnum("status").notNull().default("new"),
  priority: chatPriorityEnum("priority").notNull().default("normal"),
  lastMessageTime: timestamp("last_message_time").defaultNow(),
  unreadCount: integer("unread_count").notNull().default(0), // 🟢 Contador de mensagens não lidas
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique("unique_customer_phone").on(table.customerPhone),
]);

// Histórico de atribuições de conversas
export const chatAssignmentHistory = pgTable("chat_assignment_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  assignedAgentId: varchar("assigned_agent_id").notNull(), // ID do atendente (ou 'chatgpt')
  assignedAgentName: varchar("assigned_agent_name"), // Nome do atendente para fácil visualização
  assignedByUserId: varchar("assigned_by_user_id"), // Quem fez a atribuição (null = sistema)
  assignedByUserName: varchar("assigned_by_user_name"), // Nome de quem atribuiu
  reason: varchar("reason"), // Motivo: 'initial', 'transfer', 'redistribution', 'manual'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Chat Messages type enum
export const chatMessageTypeEnum = pgEnum('chat_message_type', ['text', 'image', 'file', 'audio', 'video', 'document', 'location']);
export const chatSenderTypeEnum = pgEnum('chat_sender_type', ['customer', 'agent', 'system']);

// Chat Messages table
export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  senderId: varchar("sender_id").notNull(),
  senderType: chatSenderTypeEnum("sender_type").notNull(),
  content: text("content").notNull(),
  messageType: chatMessageTypeEnum("message_type").notNull().default("text"),
  mediaUrl: text("media_url"),
  metadata: jsonb("metadata"),
  isRead: boolean("is_read").notNull().default(false),
  externalId: varchar("external_id"), // ID externo do WhatsApp para evitar duplicatas de mensagens
  ack: integer("ack").default(0), // Status de entrega: 0=pending, 1=sent, 2=delivered, 3=read
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  unique("unique_external_id").on(table.externalId),
]);

// Chat Reports type enum
export const chatReportTypeEnum = pgEnum('chat_report_type', ['daily', 'weekly', 'monthly', 'custom']);

// Chat Reports table
export const chatReports = pgTable("chat_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: chatReportTypeEnum("type").notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  data: jsonb("data").notNull(),
  generatedBy: varchar("generated_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Chat Audit Log table
export const chatAuditLog = pgTable("chat_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: varchar("entity_id"),
  details: jsonb("details"),
  timestamp: timestamp("timestamp").defaultNow(),
});

// Chat Products table - catálogo de produtos para o chat
export const chatProducts = pgTable("chat_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  price: text("price").notNull(),
  size: text("size"),
  category: text("category").notNull().default("suco"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Chat Quick Messages type enum
export const chatQuickMessageTypeEnum = pgEnum('chat_quick_message_type', ['text', 'product_menu', 'order_form', 'image']);

// Chat Quick Messages table
export const chatQuickMessages = pgTable("chat_quick_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  content: text("content").notNull(),
  messageType: chatQuickMessageTypeEnum("message_type").notNull().default("text"),
  imageUrl: text("image_url"),
  category: text("category"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Chat Orders status enum
export const chatOrderStatusEnum = pgEnum('chat_order_status', ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled']);

// Chat Orders table
export const chatOrders = pgTable("chat_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  items: jsonb("items").notNull(),
  totalAmount: text("total_amount").notNull(),
  status: chatOrderStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Chat Delivery Rejection Reasons table
export const chatDeliveryRejectionReasons = pgTable("chat_delivery_rejection_reasons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reason: varchar("reason", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Chat Deliveries status enum
export const chatDeliveryStatusEnum = pgEnum('chat_delivery_status', ['pending', 'confirmed', 'rejected', 'delivered']);

// Chat Deliveries table
export const chatDeliveries = pgTable("chat_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id"),
  deliveryPersonId: varchar("delivery_person_id"),
  customerName: varchar("customer_name", { length: 255 }).notNull(),
  customerPhone: varchar("customer_phone", { length: 50 }).notNull(),
  customerAddress: text("customer_address").notNull(),
  orderDetails: jsonb("order_details").notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  scheduledDate: timestamp("scheduled_date").notNull(),
  status: chatDeliveryStatusEnum("status").default("pending").notNull(),
  deliveryTime: timestamp("delivery_time"),
  latitude: decimal("latitude", { precision: 10, scale: 8 }),
  longitude: decimal("longitude", { precision: 11, scale: 8 }),
  rejectionReasonId: varchar("rejection_reason_id"),
  rejectionNotes: text("rejection_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// WhatsApp Conversation Analysis status enum
export const whatsappAnalysisStatusEnum = pgEnum('whatsapp_analysis_status', ['pending', 'completed', 'failed']);

// WhatsApp Conversation Analysis table
export const whatsappConversationAnalysis = pgTable("whatsapp_conversation_analysis", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  rawConversationData: jsonb("raw_conversation_data").notNull(),
  extractedData: jsonb("extracted_data").notNull(),
  customerName: text("customer_name"),
  companyRepresentative: text("company_representative"),
  orderDate: timestamp("order_date"),
  orderItems: jsonb("order_items"),
  totalAmount: text("total_amount"),
  analysisStatus: whatsappAnalysisStatusEnum("analysis_status").notNull().default("pending"),
  analysisDate: timestamp("analysis_date").defaultNow(),
  lastKnowledgeFileUpdate: timestamp("last_knowledge_file_update"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Knowledge Base table
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

// Chat Honest - Insert Schemas
export const insertChatAgentSchema = createInsertSchema(chatAgents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatCustomerSchema = createInsertSchema(chatCustomers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastInteractionAt: true,
});

export const updateChatCustomerSchema = createInsertSchema(chatCustomers).pick({
  name: true,
}).partial();

export const insertChatConversationSchema = createInsertSchema(chatConversations).omit({
  id: true,
  createdAt: true,
});

// Extended schema for updating conversations (allows updatedAt and lastMessageTime)
export const updateChatConversationSchema = createInsertSchema(chatConversations).omit({
  id: true,
  createdAt: true,
}).partial();

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
}).extend({
  createdAt: z.date().optional(),
});

export const insertChatReportSchema = createInsertSchema(chatReports).omit({
  id: true,
  createdAt: true,
});

export const insertChatAuditLogSchema = createInsertSchema(chatAuditLog).omit({
  id: true,
  timestamp: true,
});

export const insertChatProductSchema = createInsertSchema(chatProducts).omit({
  id: true,
  createdAt: true,
});

export const insertChatQuickMessageSchema = createInsertSchema(chatQuickMessages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateChatQuickMessageSchema = createInsertSchema(chatQuickMessages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
}).partial();

export const insertChatOrderSchema = createInsertSchema(chatOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatDeliveryRejectionReasonSchema = createInsertSchema(chatDeliveryRejectionReasons).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatDeliverySchema = createInsertSchema(chatDeliveries).omit({
  id: true,
  deliveryTime: true,
  latitude: true,
  longitude: true,
  createdAt: true,
  updatedAt: true,
});

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

// Schema para validar pedidos submetidos via ChatGPT
export const chatOrderFormSchema = z.object({
  nomeCompleto: z.string().min(3, "Nome deve ter pelo menos 3 caracteres"),
  cpfCnpj: z.string().min(11, "CPF/CNPJ inválido").max(18, "CPF/CNPJ inválido"),
  telefone: z.string().min(10, "Telefone inválido"),
  endereco: z.string().min(10, "Endereço deve ser completo"),
  bairro: z.string().min(2, "Bairro é obrigatório"),
  cidade: z.string().min(2, "Cidade é obrigatória"),
  cep: z.string().optional(),
  produtos: z.array(z.object({
    nome: z.string(),
    quantidade: z.number().min(1),
    precoUnitario: z.number().min(0),
  })).min(1, "Pelo menos um produto é necessário"),
  formaPagamento: z.enum(["pix", "dinheiro", "cartao_credito", "cartao_debito", "boleto", "a_prazo"]),
  diaEntrega: z.string().min(1, "Dia de entrega é obrigatório"),
  horarioEntrega: z.string().optional(),
  observacoes: z.string().optional(),
});

export type ChatOrderForm = z.infer<typeof chatOrderFormSchema>;

// Chat Honest - Types
export type ChatAgent = typeof chatAgents.$inferSelect;
export type InsertChatAgent = z.infer<typeof insertChatAgentSchema>;

export type ChatCustomer = typeof chatCustomers.$inferSelect;
export type InsertChatCustomer = z.infer<typeof insertChatCustomerSchema>;
export type UpdateChatCustomer = z.infer<typeof updateChatCustomerSchema>;

export type ChatConversation = typeof chatConversations.$inferSelect;
export type InsertChatConversation = z.infer<typeof insertChatConversationSchema>;
export type UpdateChatConversation = z.infer<typeof updateChatConversationSchema>;

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

export type ChatReport = typeof chatReports.$inferSelect;
export type InsertChatReport = z.infer<typeof insertChatReportSchema>;

export type ChatAuditLog = typeof chatAuditLog.$inferSelect;
export type InsertChatAuditLog = z.infer<typeof insertChatAuditLogSchema>;

export type ChatProduct = typeof chatProducts.$inferSelect;
export type InsertChatProduct = z.infer<typeof insertChatProductSchema>;

export type ChatQuickMessage = typeof chatQuickMessages.$inferSelect;
export type InsertChatQuickMessage = z.infer<typeof insertChatQuickMessageSchema>;

export type ChatOrder = typeof chatOrders.$inferSelect;
export type InsertChatOrder = z.infer<typeof insertChatOrderSchema>;

export type ChatDeliveryRejectionReason = typeof chatDeliveryRejectionReasons.$inferSelect;
export type InsertChatDeliveryRejectionReason = z.infer<typeof insertChatDeliveryRejectionReasonSchema>;

export type ChatDelivery = typeof chatDeliveries.$inferSelect;
export type InsertChatDelivery = z.infer<typeof insertChatDeliverySchema>;

export type WhatsappConversationAnalysis = typeof whatsappConversationAnalysis.$inferSelect;
export type InsertWhatsappConversationAnalysis = z.infer<typeof insertWhatsappConversationAnalysisSchema>;

export type KnowledgeBase = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBase = z.infer<typeof insertKnowledgeBaseSchema>;

// Chat Honest - Extended types for UI
export type ChatConversationWithCustomer = ChatConversation & {
  customer: ChatCustomer;
  agent?: ChatAgent;
  lastMessage?: ChatMessage;
};

export type ChatMessageWithSender = ChatMessage & {
  sender?: ChatAgent | ChatCustomer;
};

export type ChatAgentWithUser = ChatAgent & {
  user?: typeof users.$inferSelect;
};

export type ChatDeliveryWithPerson = ChatDelivery & {
  deliveryPerson: {
    id: string;
    email: string;
  };
};

export interface ChatDeliveryWithRelations extends ChatDelivery {
  conversation?: ChatConversationWithCustomer;
  deliveryPerson?: typeof users.$inferSelect;
  rejectionReason?: ChatDeliveryRejectionReason;
}

// ============================================================================
// PENDING DELIVERY TYPE (for getPendingDeliveries from billings)
// ============================================================================

export interface PendingDelivery {
  id: string;
  invoiceNumber: string;
  omieOrderId: string | null;
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  customerCpf: string | null;
  customerCnpj: string | null;
  customerAddress: string;
  customerLatitude: string | null;
  customerLongitude: string | null;
  customerWeekdays: string[] | null;
  averageDeliveryTime: number;
  exclusiveVehicle: boolean;
  vehicleTypes: string[];
  isUrgent: boolean;
  saleValue: number | null;
  products: unknown | null;
  scheduledDate: string | null;
  completedDate: string | null;
  paymentMethod: string | null;
  operationType: string | null;
  receivingWeekdays: string[]; // Dias que cliente aceita receber (configurado manualmente)
  deliveryWeekdays: string[]; // Dias preferidos de entrega (calculado automaticamente)
  deliveryTimeSlots: string[];
  deliverySaturdayTimeSlots: string[];
}

// ============================================================================
// ACTIVE CUSTOMERS - Lista de clientes ativos para rotas e visitas
// ============================================================================

// Tabela de uploads de lista de clientes ativos
export const activeCustomerUploads = pgTable("active_customer_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: varchar("file_name").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(), // ID do usuário que fez upload
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  totalRecords: integer("total_records").notNull().default(0),
  matchedRecords: integer("matched_records").notNull().default(0),
  unmatchedRecords: integer("unmatched_records").notNull().default(0),
  addedCustomers: integer("added_customers").notNull().default(0),
  removedCustomers: integer("removed_customers").notNull().default(0),
  keptCustomers: integer("kept_customers").notNull().default(0),
  processingStatus: varchar("processing_status").notNull().default('pending'), // pending, processing, completed, error
  errorMessage: text("error_message"),
  fileHash: varchar("file_hash"), // Para evitar reprocessamento do mesmo arquivo
}, (table) => [
  index("idx_active_uploads_date").on(table.uploadedAt),
  index("idx_active_uploads_status").on(table.processingStatus),
]);

// Tabela de clientes ativos (lista importada)
export const activeCustomers = pgTable("active_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  document: varchar("document").notNull(), // CPF ou CNPJ normalizado (apenas números)
  documentType: varchar("document_type").notNull(), // 'cpf' ou 'cnpj'
  fantasyNameImported: varchar("fantasy_name_imported"), // Nome fantasia da planilha
  customerId: varchar("customer_id"), // Referência ao customer encontrado (pode ser null se não encontrou)
  omieInstanceId: varchar("omie_instance_id"), // Referência à instância Omie de origem (multi-tenant)
  uploadId: varchar("upload_id").notNull(), // Referência ao upload que trouxe este registro
  matchStatus: varchar("match_status").notNull().default('pending'), // pending, matched, unmatched
  latitude: decimal("latitude", { precision: 10, scale: 8 }), // Coordenada do cliente
  longitude: decimal("longitude", { precision: 11, scale: 8 }), // Coordenada do cliente
  isActive: boolean("is_active").notNull().default(true),
  activatedAt: timestamp("activated_at").defaultNow(),
  deactivatedAt: timestamp("deactivated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_active_customers_document").on(table.document),
  index("idx_active_customers_customer_id").on(table.customerId),
  index("idx_active_customers_active").on(table.isActive),
  index("idx_active_customers_omie_instance").on(table.omieInstanceId),
]);

// Schemas e types para Active Customers
export const insertActiveCustomerUploadSchema = createInsertSchema(activeCustomerUploads).omit({
  id: true,
  uploadedAt: true,
});

export const insertActiveCustomerSchema = createInsertSchema(activeCustomers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ActiveCustomerUpload = typeof activeCustomerUploads.$inferSelect;
export type InsertActiveCustomerUpload = z.infer<typeof insertActiveCustomerUploadSchema>;

export type ActiveCustomer = typeof activeCustomers.$inferSelect;
export type InsertActiveCustomer = z.infer<typeof insertActiveCustomerSchema>;

// Type para exibição com dados de visita
export interface ActiveCustomerWithVisits extends ActiveCustomer {
  customer?: Customer;
  lastTwoVisits: Array<{ date: string; status: string }>;
  nextThreeVisits: Array<{ date: string; status: string }>;
  previousMonthTotal?: number;
  currentMonthTotal?: number;
}

// ============================================================================
// CHATGPT ATENDIMENTO AUTOMÁTICO - CONFIGURAÇÕES
// ============================================================================

// Enum para modo de ativação do ChatGPT
export const chatGptModeEnum = pgEnum("chat_gpt_mode", [
  "disabled",      // Desabilitado
  "manual",        // Habilitado manualmente (sempre ativo quando ligado)
  "schedule",      // Ativo apenas em horários configurados
  "timeout"        // Assume após timeout sem resposta de atendente
]);

// Enum para provedor de IA
export const aiProviderEnum = pgEnum("ai_provider", [
  "openai",        // OpenAI (GPT-4, GPT-4o, etc.)
  "grok"           // xAI Grok
]);

// Tabela de configurações do atendimento ChatGPT
export const chatAiSettings = pgTable("chat_ai_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Configuração principal de ativação
  isEnabled: boolean("is_enabled").notNull().default(false),
  isStandby: boolean("is_standby").notNull().default(true), // 🔄 Modo standby - ativa quando nenhum atendente disponível
  mode: chatGptModeEnum("mode").notNull().default("disabled"),
  
  // 🚀 Prioridade do ChatGPT na fila de atendimento
  // 0 = ChatGPT só atende quando não há humanos online (padrão/standby)
  // 1+ = Posição do ChatGPT na fila (ex: 1 = primeiro, antes de humanos)
  chatgptQueuePosition: integer("chatgpt_queue_position").notNull().default(0),
  
  // Provedor de IA (openai ou grok)
  aiProvider: aiProviderEnum("ai_provider").notNull().default("openai"),
  
  // Configuração de horário (para mode = "schedule")
  // Formato: { "weekdays": ["Seg", "Ter", ...], "startTime": "18:00", "endTime": "08:00" }
  businessHours: jsonb("business_hours"),
  
  // Configuração de timeout (para mode = "timeout")
  timeoutMinutes: integer("timeout_minutes").notNull().default(5),
  
  // Limites de interação
  maxTurnsBeforeEscalation: integer("max_turns_before_escalation").notNull().default(10),
  
  // Palavras-chave que forçam transferência para humano
  handoffKeywords: text("handoff_keywords").array(),
  
  // Prompt do sistema para o ChatGPT
  systemPrompt: text("system_prompt"),
  
  // Contexto da empresa para incluir no prompt
  companyContext: text("company_context"),
  
  // Modelo GPT a usar
  gptModel: varchar("gpt_model").notNull().default("gpt-4o-mini"),
  
  // ID do Assistente OpenAI (ex: asst_4AM6M50fsOXKXlz5Ijc7IA9k)
  assistantId: varchar("assistant_id"),
  
  // URLs das imagens que o ChatGPT pode enviar durante conversas
  chatgptImages: text("chatgpt_images").array(),
  
  // ============================================================================
  // CONFIGURAÇÕES DE FINALIZAÇÃO E AUSÊNCIA
  // ============================================================================
  
  // Timeout de inatividade para auto-finalização (em minutos)
  inactivityTimeoutMinutes: integer("inactivity_timeout_minutes").notNull().default(30),
  
  // Mensagem enviada ao cliente quando a conversa é finalizada (manual ou por inatividade)
  finalizeMessage: text("finalize_message").default("Atendimento finalizado. Obrigado pelo contato! Caso precise de algo mais, estamos à disposição."),
  
  // Mensagem enviada ao cliente quando não há atendentes online
  absenceMessage: text("absence_message").default("No momento não há atendentes disponíveis. Por favor, tente novamente em instantes ou envie sua mensagem que responderemos assim que possível."),
  
  // Metadados
  updatedBy: varchar("updated_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Schema e types para ChatAI Settings
export const insertChatAiSettingsSchema = createInsertSchema(chatAiSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ChatAiSettings = typeof chatAiSettings.$inferSelect;
export type InsertChatAiSettings = z.infer<typeof insertChatAiSettingsSchema>;

// Tabela de relatórios automáticos para IA
export const chatAiReports = pgTable("chat_ai_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Tipo de relatório
  reportType: varchar("report_type").notNull(), // 'customers', 'overdue_debts', 'billings_summary'
  
  // Conteúdo do relatório (formato texto otimizado para IA)
  content: text("content").notNull(),
  
  // Metadados
  recordCount: integer("record_count").notNull().default(0),
  generatedAt: timestamp("generated_at").defaultNow(),
  expiresAt: timestamp("expires_at"), // Para limpeza automática de relatórios antigos
});

export type ChatAiReport = typeof chatAiReports.$inferSelect;
export type InsertChatAiReport = typeof chatAiReports.$inferInsert;

// Interface para horário de funcionamento
export interface BusinessHoursConfig {
  weekdays: WeekdayCode[];
  startTime: string; // Formato "HH:MM"
  endTime: string;   // Formato "HH:MM"
}

// Tabela de log de interações do ChatGPT
export const chatAiLogs = pgTable("chat_ai_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  messageId: varchar("message_id"), // Mensagem do cliente que gerou a resposta
  responseMessageId: varchar("response_message_id"), // Mensagem de resposta do bot
  
  // Dados da interação
  customerMessage: text("customer_message"),
  botResponse: text("bot_response"),
  shouldTransfer: boolean("should_transfer").notNull().default(false),
  transferReason: text("transfer_reason"),
  
  // Métricas
  tokensUsed: integer("tokens_used"),
  responseTimeMs: integer("response_time_ms"),
  
  // Status
  status: varchar("status").notNull().default("success"), // success, error, escalated
  errorMessage: text("error_message"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_chat_ai_logs_conversation").on(table.conversationId),
  index("idx_chat_ai_logs_created").on(table.createdAt),
]);

export const insertChatAiLogSchema = createInsertSchema(chatAiLogs).omit({
  id: true,
  createdAt: true,
});

export type ChatAiLog = typeof chatAiLogs.$inferSelect;
export type InsertChatAiLog = z.infer<typeof insertChatAiLogSchema>;

// Tabela de controle de distribuição round-robin de atendentes
export const chatDistributionState = pgTable("chat_distribution_state", {
  id: varchar("id").primaryKey().default("singleton"), // Sempre "singleton" - apenas um registro
  lastAssignedAgentId: varchar("last_assigned_agent_id"), // Último atendente que recebeu mensagem
  lastAssignedAt: timestamp("last_assigned_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type ChatDistributionState = typeof chatDistributionState.$inferSelect;

// Cores disponíveis para atendentes (para identificação visual)
export const AGENT_COLORS = [
  "#FF6B6B", // Vermelho coral
  "#4ECDC4", // Turquesa
  "#45B7D1", // Azul claro
  "#96CEB4", // Verde menta
  "#FFEAA7", // Amarelo suave
  "#DDA0DD", // Lilás
  "#98D8C8", // Verde água
  "#F7DC6F", // Amarelo
  "#BB8FCE", // Roxo
  "#85C1E9", // Azul céu
] as const;

// ============================================================================
// PHONEBOOK CONTACTS - Agenda telefônica da central de atendimento
// ============================================================================

export const phonebookContacts = pgTable("phonebook_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  phone: varchar("phone").notNull(),
  notes: text("notes"),
  customerId: varchar("customer_id").references(() => customers.id, { onDelete: 'set null' }),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  lastContactedAt: timestamp("last_contacted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_phonebook_contacts_phone").on(table.phone),
  index("idx_phonebook_contacts_name").on(table.name),
  index("idx_phonebook_contacts_customer").on(table.customerId),
]);

export const phonebookContactsRelations = relations(phonebookContacts, ({ one }) => ({
  customer: one(customers, {
    fields: [phonebookContacts.customerId],
    references: [customers.id],
  }),
  createdBy: one(users, {
    fields: [phonebookContacts.createdByUserId],
    references: [users.id],
  }),
}));

export const insertPhonebookContactSchema = createInsertSchema(phonebookContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PhonebookContact = typeof phonebookContacts.$inferSelect;
export type InsertPhonebookContact = z.infer<typeof insertPhonebookContactSchema>;

// ============================================================================
// VIRTUAL ATTENDANCE STATS - Estatísticas de atendimentos virtuais por agente/data
// ============================================================================

export const virtualAttendanceStats = pgTable("virtual_attendance_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  serviceDate: date("service_date").notNull(),
  countedAt: timestamp("counted_at").defaultNow(),
}, (table) => [
  unique("unique_conversation_agent_date").on(table.conversationId, table.agentId, table.serviceDate),
  index("idx_attendance_agent").on(table.agentId),
  index("idx_attendance_date").on(table.serviceDate),
  index("idx_attendance_agent_date").on(table.agentId, table.serviceDate),
]);

export const virtualAttendanceStatsRelations = relations(virtualAttendanceStats, ({ one }) => ({
  agent: one(users, {
    fields: [virtualAttendanceStats.agentId],
    references: [users.id],
  }),
  conversation: one(chatConversations, {
    fields: [virtualAttendanceStats.conversationId],
    references: [chatConversations.id],
  }),
}));

export const insertVirtualAttendanceStatsSchema = createInsertSchema(virtualAttendanceStats).omit({
  id: true,
  countedAt: true,
});

export type VirtualAttendanceStat = typeof virtualAttendanceStats.$inferSelect;
export type InsertVirtualAttendanceStat = z.infer<typeof insertVirtualAttendanceStatsSchema>;

// ============================================================================
// OMIE STAGE LOGS - Logs de transição de etapas de pedidos no Omie
// ============================================================================

export const omieStageLogs = pgTable("omie_stage_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  omieOrderId: integer("omie_order_id").notNull(),
  orderNumber: varchar("order_number"),
  customerName: varchar("customer_name"),
  previousStage: varchar("previous_stage"),
  newStage: varchar("new_stage").notNull(),
  stageDescription: varchar("stage_description"),
  trigger: varchar("trigger").notNull(),
  triggerDetail: varchar("trigger_detail"),
  routeId: varchar("route_id"),
  stopId: varchar("stop_id"),
  billingId: varchar("billing_id"),
  driverEmail: varchar("driver_email"),
  triggeredBy: varchar("triggered_by"),
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
  omieResponse: jsonb("omie_response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_stage_logs_order").on(table.omieOrderId),
  index("idx_stage_logs_created").on(table.createdAt),
  index("idx_stage_logs_trigger").on(table.trigger),
  index("idx_stage_logs_success").on(table.success),
]);

export const insertOmieStageLogSchema = createInsertSchema(omieStageLogs).omit({
  id: true,
  createdAt: true,
});

export type OmieStageLog = typeof omieStageLogs.$inferSelect;
export type InsertOmieStageLog = z.infer<typeof insertOmieStageLogSchema>;

// ============================================================================
// NF-e (NOTA FISCAL ELETRÔNICA) MODULE
// ============================================================================

export const fiscalScenarios = pgTable("fiscal_scenarios", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  operationType: varchar("operation_type").notNull(),
  stateScope: varchar("state_scope").notNull(),
  cfop: varchar("cfop").notNull(),
  csosn: varchar("csosn"),
  cstIcms: varchar("cst_icms"),
  cstPis: varchar("cst_pis"),
  cstCofins: varchar("cst_cofins"),
  aliqIcms: decimal("aliq_icms", { precision: 5, scale: 2 }),
  aliqPis: decimal("aliq_pis", { precision: 5, scale: 4 }),
  aliqCofins: decimal("aliq_cofins", { precision: 5, scale: 4 }),
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertFiscalScenarioSchema = createInsertSchema(fiscalScenarios).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type FiscalScenario = typeof fiscalScenarios.$inferSelect;
export type InsertFiscalScenario = z.infer<typeof insertFiscalScenarioSchema>;

export const digitalCertificates = pgTable("digital_certificates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  companyName: varchar("company_name").notNull(),
  cnpj: varchar("cnpj").notNull(),
  serialNumber: varchar("serial_number"),
  issuer: varchar("issuer"),
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  certificateType: varchar("certificate_type").notNull().default('A1'),
  storageKey: varchar("storage_key").notNull(),
  certificatePassword: varchar("certificate_password"),
  isActive: boolean("is_active").default(true),
  uploadedBy: varchar("uploaded_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const digitalCertificatesRelations = relations(digitalCertificates, ({ one }) => ({
  uploader: one(users, {
    fields: [digitalCertificates.uploadedBy],
    references: [users.id],
  }),
}));

export const insertDigitalCertificateSchema = createInsertSchema(digitalCertificates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type DigitalCertificate = typeof digitalCertificates.$inferSelect;
export type InsertDigitalCertificate = z.infer<typeof insertDigitalCertificateSchema>;

export const fiscalInvoices = pgTable("fiscal_invoices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceNumber: integer("invoice_number"),
  series: varchar("series").default('1'),
  accessKey: varchar("access_key"),
  protocolNumber: varchar("protocol_number"),
  status: varchar("status").notNull().default('draft'),
  operationType: varchar("operation_type").notNull().default('saida'),
  fiscalScenarioId: varchar("fiscal_scenario_id"),
  certificateId: varchar("certificate_id"),
  issuerName: varchar("issuer_name"),
  issuerCnpj: varchar("issuer_cnpj"),
  issuerIe: varchar("issuer_ie"),
  issuerAddress: text("issuer_address"),
  issuerUf: varchar("issuer_uf"),
  issuerCityCode: varchar("issuer_city_code"),
  issuerCity: varchar("issuer_city"),
  issuerPhone: varchar("issuer_phone"),
  customerId: varchar("customer_id"),
  customerName: varchar("customer_name"),
  customerCnpjCpf: varchar("customer_cnpj_cpf"),
  customerIe: varchar("customer_ie"),
  customerAddress: text("customer_address"),
  natureOfOperation: varchar("nature_of_operation"),
  cfop: varchar("cfop"),
  totalProducts: decimal("total_products", { precision: 12, scale: 2 }).default('0'),
  totalDiscount: decimal("total_discount", { precision: 12, scale: 2 }).default('0'),
  totalFreight: decimal("total_freight", { precision: 12, scale: 2 }).default('0'),
  totalInsurance: decimal("total_insurance", { precision: 12, scale: 2 }).default('0'),
  totalOtherExpenses: decimal("total_other_expenses", { precision: 12, scale: 2 }).default('0'),
  totalIcms: decimal("total_icms", { precision: 12, scale: 2 }).default('0'),
  totalPis: decimal("total_pis", { precision: 12, scale: 2 }).default('0'),
  totalCofins: decimal("total_cofins", { precision: 12, scale: 2 }).default('0'),
  totalIpi: decimal("total_ipi", { precision: 12, scale: 2 }).default('0'),
  totalInvoice: decimal("total_invoice", { precision: 12, scale: 2 }).default('0'),
  paymentMethod: varchar("payment_method").default('a_prazo'),
  notes: text("notes"),
  emissionDate: timestamp("emission_date"),
  authorizationDate: timestamp("authorization_date"),
  cancellationDate: timestamp("cancellation_date"),
  xmlEnvio: text("xml_envio"),
  xmlRetorno: text("xml_retorno"),
  xmlAutorizacao: text("xml_autorizacao"),
  danfePdfUrl: varchar("danfe_pdf_url"),
  environment: varchar("environment").notNull().default('homologacao'),
  omieInstanceId: varchar("omie_instance_id"),
  salesCardId: varchar("sales_card_id"),
  orderHistoryId: varchar("order_history_id"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_fiscal_invoices_status").on(table.status),
  index("idx_fiscal_invoices_customer").on(table.customerId),
  index("idx_fiscal_invoices_number").on(table.invoiceNumber),
  index("idx_fiscal_invoices_access_key").on(table.accessKey),
  index("idx_fiscal_invoices_emission").on(table.emissionDate),
  index("idx_fiscal_invoices_created").on(table.createdAt),
]);

export const fiscalInvoicesRelations = relations(fiscalInvoices, ({ one, many }) => ({
  fiscalScenario: one(fiscalScenarios, {
    fields: [fiscalInvoices.fiscalScenarioId],
    references: [fiscalScenarios.id],
  }),
  certificate: one(digitalCertificates, {
    fields: [fiscalInvoices.certificateId],
    references: [digitalCertificates.id],
  }),
  customer: one(customers, {
    fields: [fiscalInvoices.customerId],
    references: [customers.id],
  }),
  items: many(fiscalInvoiceItems),
  events: many(fiscalInvoiceEvents),
}));

export const insertFiscalInvoiceSchema = createInsertSchema(fiscalInvoices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type FiscalInvoice = typeof fiscalInvoices.$inferSelect;
export type InsertFiscalInvoice = z.infer<typeof insertFiscalInvoiceSchema>;

export const fiscalInvoiceItems = pgTable("fiscal_invoice_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id").notNull(),
  itemNumber: integer("item_number").notNull(),
  productId: varchar("product_id"),
  productCode: varchar("product_code"),
  productName: varchar("product_name").notNull(),
  ncm: varchar("ncm"),
  cest: varchar("cest"),
  cfop: varchar("cfop"),
  unit: varchar("unit").notNull().default('UN'),
  quantity: decimal("quantity", { precision: 12, scale: 4 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 12, scale: 4 }).notNull(),
  totalPrice: decimal("total_price", { precision: 12, scale: 2 }).notNull(),
  discount: decimal("discount", { precision: 12, scale: 2 }).default('0'),
  lotNumber: varchar("lot_number"),
  lotId: varchar("lot_id"),
  csosn: varchar("csosn"),
  cstIcms: varchar("cst_icms"),
  baseIcms: decimal("base_icms", { precision: 12, scale: 2 }).default('0'),
  aliqIcms: decimal("aliq_icms", { precision: 5, scale: 2 }).default('0'),
  valorIcms: decimal("valor_icms", { precision: 12, scale: 2 }).default('0'),
  cstPis: varchar("cst_pis"),
  basePis: decimal("base_pis", { precision: 12, scale: 2 }).default('0'),
  aliqPis: decimal("aliq_pis", { precision: 5, scale: 4 }).default('0'),
  valorPis: decimal("valor_pis", { precision: 12, scale: 2 }).default('0'),
  cstCofins: varchar("cst_cofins"),
  baseCofins: decimal("base_cofins", { precision: 12, scale: 2 }).default('0'),
  aliqCofins: decimal("aliq_cofins", { precision: 5, scale: 4 }).default('0'),
  valorCofins: decimal("valor_cofins", { precision: 12, scale: 2 }).default('0'),
  cstIpi: varchar("cst_ipi"),
  baseIpi: decimal("base_ipi", { precision: 12, scale: 2 }).default('0'),
  aliqIpi: decimal("aliq_ipi", { precision: 5, scale: 2 }).default('0'),
  valorIpi: decimal("valor_ipi", { precision: 12, scale: 2 }).default('0'),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_fiscal_invoice_items_invoice").on(table.invoiceId),
]);

export const fiscalInvoiceItemsRelations = relations(fiscalInvoiceItems, ({ one }) => ({
  invoice: one(fiscalInvoices, {
    fields: [fiscalInvoiceItems.invoiceId],
    references: [fiscalInvoices.id],
  }),
}));

export const insertFiscalInvoiceItemSchema = createInsertSchema(fiscalInvoiceItems).omit({
  id: true,
  createdAt: true,
});

export type FiscalInvoiceItem = typeof fiscalInvoiceItems.$inferSelect;
export type InsertFiscalInvoiceItem = z.infer<typeof insertFiscalInvoiceItemSchema>;

export const fiscalInvoiceEvents = pgTable("fiscal_invoice_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  invoiceId: varchar("invoice_id").notNull(),
  eventType: varchar("event_type").notNull(),
  eventSequence: integer("event_sequence").default(1),
  protocolNumber: varchar("protocol_number"),
  status: varchar("status").notNull(),
  description: text("description"),
  xmlRequest: text("xml_request"),
  xmlResponse: text("xml_response"),
  errorCode: varchar("error_code"),
  errorMessage: text("error_message"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_fiscal_invoice_events_invoice").on(table.invoiceId),
  index("idx_fiscal_invoice_events_type").on(table.eventType),
]);

export const fiscalInvoiceEventsRelations = relations(fiscalInvoiceEvents, ({ one }) => ({
  invoice: one(fiscalInvoices, {
    fields: [fiscalInvoiceEvents.invoiceId],
    references: [fiscalInvoices.id],
  }),
}));

export const insertFiscalInvoiceEventSchema = createInsertSchema(fiscalInvoiceEvents).omit({
  id: true,
  createdAt: true,
});

export type FiscalInvoiceEvent = typeof fiscalInvoiceEvents.$inferSelect;
export type InsertFiscalInvoiceEvent = z.infer<typeof insertFiscalInvoiceEventSchema>;

export const fiscalBackups = pgTable("fiscal_backups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  backupType: varchar("backup_type").notNull(),
  referenceId: varchar("reference_id"),
  referenceKey: varchar("reference_key"),
  storageKey: varchar("storage_key").notNull(),
  fileSize: integer("file_size"),
  checksum: varchar("checksum"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_fiscal_backups_type").on(table.backupType),
  index("idx_fiscal_backups_reference").on(table.referenceId),
  index("idx_fiscal_backups_created").on(table.createdAt),
]);

export const insertFiscalBackupSchema = createInsertSchema(fiscalBackups).omit({
  id: true,
  createdAt: true,
});

export type FiscalBackup = typeof fiscalBackups.$inferSelect;
export type InsertFiscalBackup = z.infer<typeof insertFiscalBackupSchema>;

// ============================================================================
// INVENTORY / STOCK MANAGEMENT
// ============================================================================

export const stockTypeEnum = pgEnum('stock_type', ['in_use', 'blocked']);
export const movementTypeEnum = pgEnum('movement_type', ['consume', 'replenish', 'transfer', 'adjust', 'cancel_reversal']);
export const movementSourceEnum = pgEnum('movement_source', ['invoice', 'order', 'manual']);

export const inventoryLots = pgTable("inventory_lots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull(),
  instanceId: varchar("instance_id").notNull(),
  stockType: stockTypeEnum("stock_type").notNull(),
  lotNumber: varchar("lot_number").notNull(),
  quantity: decimal("quantity", { precision: 12, scale: 4 }).notNull().default('0'),
  minQuantity: decimal("min_quantity", { precision: 12, scale: 4 }).default('0'),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_inventory_lots_product").on(table.productId),
  index("idx_inventory_lots_instance").on(table.instanceId),
  index("idx_inventory_lots_type").on(table.stockType),
  index("idx_inventory_lots_active").on(table.isActive),
]);

export const inventoryLotsRelations = relations(inventoryLots, ({ one, many }) => ({
  product: one(products, {
    fields: [inventoryLots.productId],
    references: [products.id],
  }),
  instance: one(omieInstances, {
    fields: [inventoryLots.instanceId],
    references: [omieInstances.id],
  }),
  movements: many(inventoryMovements),
}));

export const insertInventoryLotSchema = createInsertSchema(inventoryLots).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InventoryLot = typeof inventoryLots.$inferSelect;
export type InsertInventoryLot = z.infer<typeof insertInventoryLotSchema>;

export const inventoryMovements = pgTable("inventory_movements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lotId: varchar("lot_id").notNull(),
  productId: varchar("product_id").notNull(),
  instanceId: varchar("instance_id").notNull(),
  movementType: movementTypeEnum("movement_type").notNull(),
  quantity: decimal("quantity", { precision: 12, scale: 4 }).notNull(),
  previousQuantity: decimal("previous_quantity", { precision: 12, scale: 4 }),
  newQuantity: decimal("new_quantity", { precision: 12, scale: 4 }),
  sourceType: movementSourceEnum("source_type"),
  sourceId: varchar("source_id"),
  lotNumber: varchar("lot_number"),
  notes: text("notes"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_inventory_movements_lot").on(table.lotId),
  index("idx_inventory_movements_product").on(table.productId),
  index("idx_inventory_movements_source").on(table.sourceType, table.sourceId),
  index("idx_inventory_movements_created").on(table.createdAt),
]);

export const inventoryMovementsRelations = relations(inventoryMovements, ({ one }) => ({
  lot: one(inventoryLots, {
    fields: [inventoryMovements.lotId],
    references: [inventoryLots.id],
  }),
  product: one(products, {
    fields: [inventoryMovements.productId],
    references: [products.id],
  }),
  instance: one(omieInstances, {
    fields: [inventoryMovements.instanceId],
    references: [omieInstances.id],
  }),
}));

export const insertInventoryMovementSchema = createInsertSchema(inventoryMovements).omit({
  id: true,
  createdAt: true,
});

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = z.infer<typeof insertInventoryMovementSchema>;

// ============================================================================
// BILLING PIPELINE (Kanban de Faturamento)
// ============================================================================

export const billingPipelineStageEnum = pgEnum("billing_pipeline_stage", [
  "pedido",
  "a_faturar",
  "faturado",
  "impresso",
  "aguardando_rota",
  "em_rota",
  "entregue",
]);

export const billingPipeline = pgTable("billing_pipeline", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesCardId: varchar("sales_card_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  customerName: varchar("customer_name").notNull(),
  customerDocument: varchar("customer_document"),
  sellerId: varchar("seller_id"),
  sellerName: varchar("seller_name"),
  stage: billingPipelineStageEnum("stage").notNull().default("pedido"),
  orderNumber: varchar("order_number"),
  invoiceNumber: varchar("invoice_number"),
  saleValue: decimal("sale_value", { precision: 10, scale: 2 }),
  paymentMethod: varchar("payment_method"),
  operationType: varchar("operation_type"),
  products: jsonb("products").$type<Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>>(),
  notes: text("notes"),
  omieInstanceId: varchar("omie_instance_id"),
  omieInstanceName: varchar("omie_instance_name"),
  stageHistory: jsonb("stage_history").$type<Array<{
    stage: string;
    changedAt: string;
    changedBy: string;
  }>>().default([]),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_billing_pipeline_stage").on(table.stage),
  index("idx_billing_pipeline_sales_card").on(table.salesCardId),
  index("idx_billing_pipeline_customer").on(table.customerId),
]);

export const billingPipelineRelations = relations(billingPipeline, ({ one }) => ({
  salesCard: one(salesCards, {
    fields: [billingPipeline.salesCardId],
    references: [salesCards.id],
  }),
  customer: one(customers, {
    fields: [billingPipeline.customerId],
    references: [customers.id],
  }),
}));

export const insertBillingPipelineSchema = createInsertSchema(billingPipeline).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BillingPipeline = typeof billingPipeline.$inferSelect;
export type InsertBillingPipeline = z.infer<typeof insertBillingPipelineSchema>;

