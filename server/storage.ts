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
  leadVisits,
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
  activeCustomers,
  activeCustomerUploads,
  phoneNumberMappings,
  chatAiSettings,
  chatAiLogs,
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
  type LeadVisit,
  type InsertLeadVisit,
  type ChatAgent,
  type InsertChatAgent,
  type ChatCustomer,
  type InsertChatCustomer,
  type UpdateChatCustomer,
  type ChatConversation,
  type InsertChatConversation,
  type UpdateChatConversation,
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
  type ActiveCustomer,
  type InsertActiveCustomer,
  type ActiveCustomerUpload,
  type InsertActiveCustomerUpload,
  type ActiveCustomerWithVisits,
  type ChatAiSettings,
  type InsertChatAiSettings,
  type ChatAiLog,
  type InsertChatAiLog,
  insertSystemSettingSchema,
  phonebookContacts,
  AGENT_COLORS,
  virtualAttendanceStats,
  omieInstances,
  fiscalScenarios,
  digitalCertificates,
  fiscalInvoices,
  fiscalInvoiceItems,
  fiscalInvoiceEvents,
  fiscalBackups,
  inventoryLots,
  inventoryMovements,
  type PhonebookContact,
  type InsertPhonebookContact,
  type VirtualAttendanceStat,
  type OmieInstance,
  type InsertOmieInstance,
  type FiscalScenario,
  type InsertFiscalScenario,
  type DigitalCertificate,
  type InsertDigitalCertificate,
  type FiscalInvoice,
  type InsertFiscalInvoice,
  type FiscalInvoiceItem,
  type InsertFiscalInvoiceItem,
  type FiscalInvoiceEvent,
  type InsertFiscalInvoiceEvent,
  type FiscalBackup,
  type InsertFiscalBackup,
  type InventoryLot,
  type InsertInventoryLot,
  type InventoryMovement,
  type InsertInventoryMovement,
  billingPipeline,
  type BillingPipeline,
  type InsertBillingPipeline,
  chartOfAccounts,
  financialAccounts,
  receivables,
  receivablePayments,
  payables,
  payablePayments,
  spedExports,
  accountMovements,
  pixCharges,
  type ChartOfAccount,
  type InsertChartOfAccount,
  type FinancialAccount,
  type InsertFinancialAccount,
  type AccountMovement,
  type InsertAccountMovement,
  type PixCharge,
  type InsertPixCharge,
  type Receivable,
  type InsertReceivable,
  type ReceivablePayment,
  type InsertReceivablePayment,
  type Payable,
  type InsertPayable,
  type PayablePayment,
  type InsertPayablePayment,
  type SpedExport,
  type InsertSpedExport,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, asc, gte, lte, gt, lt, sql, inArray, or, isNotNull, isNull, ne, like } from "drizzle-orm";
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { calculateNextVisitDate } from "@shared/visitSchedule";
import { nowBrazil } from './brazilTimezone';

export interface IStorage {
  getAgentDetailedStats(): Promise<Array<{ 
    id: string; 
    name: string; 
    email: string;
    status: string;
    color: string;
    lastActivity?: Date;
    messagesAnswered: number;
    messagesToRespond: number;
  }>>;

  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByOmieVendorCode(omieVendorCode: string): Promise<User | undefined>;
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
  getCustomerByPhone(phone: string): Promise<CustomerWithSeller | undefined>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, customer: Partial<InsertCustomer>): Promise<Customer>;
  inactivateCustomer(customerId: string, currentCardId: string): Promise<{ customer: Customer; deletedCards: number }>;
  deleteCustomer(id: string): Promise<void>;
  getCustomersByRoute(route: string): Promise<Customer[]>;
  getCustomersByWeekday(weekday: string, sellerId?: string): Promise<Customer[]>;
  getCustomersForDate(sellerId: string, date: Date): Promise<Customer[]>;
  getCustomersFromPlannedVisits(sellerId: string, date: Date): Promise<Customer[]>;
  
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
  getDeliveryDriverById(id: string): Promise<any | undefined>;
  getDeliveryDriverByEmail(email: string): Promise<any | undefined>;
  updateDriverLocation(driverId: string, location: string): Promise<any>;
  getDeliveryStats(period: string): Promise<any>;
  getDeliveryMetrics(period: string): Promise<any>;
  getAllDeliveries(): Promise<any[]>;
  getDeliveryReport(period: string, startDate?: string, endDate?: string): Promise<any>;
  getDeliveryReportComparison(period: string): Promise<any>;
  getDeliveryReportDetailed(startDate: string, endDate: string, driverFilter?: string, statusFilter?: string): Promise<any[]>;
  getDeliveryDriverStats(): Promise<any>;
  
  // Delivery routes operations
  getDeliveryRoutes(filters?: { status?: string; routeDate?: string | Date; driverId?: string; savedOnly?: boolean }): Promise<any[]>;
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
  resetAllBillings(): Promise<{ deleted: number }>;
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
  upsertBilling(billing: Partial<InsertBilling> & { omieInvoiceId?: string }): Promise<Billing>;
  saveBillingIfValid(billing: Partial<InsertBilling> & { omieInvoiceId?: string }): Promise<{
    success: boolean;
    billing?: Billing;
    reason?: string;
    action?: 'created' | 'updated' | 'skipped';
  }>;
  markBillingsCancelledByOrderIds(omieOrderIds: string[]): Promise<number>;

  // Overdue debts operations
  getOverdueDebts(): Promise<any[]>;
  getOverdueDebtByDocument(document: string): Promise<any | undefined>;
  syncOverdueDebts(debts: any[], forceEmpty?: boolean, omieInstanceId?: string | null): Promise<void>;
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
    totalRecords?: number;
    currentProgress?: number;
    lastFinishedAt?: Date;
    lastSyncAt?: Date;
  }): Promise<SyncStatus>;
  
  // Lead operations
  getLeads(): Promise<Lead[]>;
  getLead(id: string): Promise<Lead | undefined>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLead(id: string, lead: Partial<InsertLead>): Promise<Lead>;
  deleteLead(id: string): Promise<void>;
  
  // Lead Visit operations
  getLeadVisits(leadId: string): Promise<LeadVisit[]>;
  createLeadVisit(visit: InsertLeadVisit): Promise<LeadVisit>;
  
  // Chat Agents operations
  getChatAgents(): Promise<ChatAgent[]>;
  createChatAgent(agent: InsertChatAgent): Promise<ChatAgent>;
  deleteChatAgent(id: string): Promise<void>;
  updateChatAgentStatus(id: string, status: string): Promise<ChatAgent>;
  updateChatAgentPresence(id: string, status: string): Promise<ChatAgent>;
  syncUsersAsAgents(): Promise<void>;
  closeInactiveConversations(): Promise<{ count: number; conversations: Array<{ id: string; customerPhone: string; customerName: string }> }>;
  getConversationsCountByAgent(): Promise<Array<{ agentId: string | null; agentName: string | null; count: number; conversations: ChatConversation[] }>>;
  transferConversation(conversationId: string, newAgentId: string): Promise<ChatConversation>;
  getChatAiSettings(): Promise<ChatAiSettings | null>;
  updateChatAiSettings(settings: Partial<InsertChatAiSettings>): Promise<ChatAiSettings>;
  
  // Chat Customers operations
  getChatCustomers(): Promise<ChatCustomer[]>;
  getChatCustomer(id: string): Promise<ChatCustomer | undefined>;
  createChatCustomer(customer: InsertChatCustomer): Promise<ChatCustomer>;
  updateChatCustomer(id: string, customer: UpdateChatCustomer): Promise<ChatCustomer>;
  
  // Chat Conversations operations
  getChatConversations(): Promise<ChatConversation[]>;
  getChatConversation(id: string): Promise<ChatConversation | undefined>;
  getChatConversationByPhone(phone: string): Promise<ChatConversation | undefined>;
  createChatConversation(conversation: InsertChatConversation): Promise<ChatConversation>;
  updateChatConversation(id: string, conversation: UpdateChatConversation): Promise<ChatConversation>;
  upsertChatConversation(conversation: InsertChatConversation): Promise<ChatConversation>;
  
  // Phone Mapping operations
  getPhoneMappingBySource(sourcePhone: string): Promise<{ canonicalPhone: string; alternativePhone: string } | undefined>;
  
  // Chat Messages operations
  getChatMessages(conversationId: string): Promise<ChatMessage[]>;
  getChatMessageByExternalId(externalId: string): Promise<ChatMessage | undefined>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  
  // Chat Products operations
  getChatProducts(): Promise<ChatProduct[]>;
  createChatProduct(product: InsertChatProduct): Promise<ChatProduct>;
  updateChatProduct(id: string, product: Partial<InsertChatProduct>): Promise<ChatProduct>;
  
  // Chat Quick Messages operations
  getChatQuickMessages(): Promise<ChatQuickMessage[]>;
  getChatQuickMessage(id: string): Promise<ChatQuickMessage | undefined>;
  createChatQuickMessage(message: InsertChatQuickMessage): Promise<ChatQuickMessage>;
  updateChatQuickMessage(id: string, message: Partial<InsertChatQuickMessage>): Promise<ChatQuickMessage>;
  deleteChatQuickMessage(id: string): Promise<void>;
  
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
  
  // Active Customers operations
  getActiveCustomers(): Promise<ActiveCustomer[]>;
  getActiveCustomersWithVisits(): Promise<ActiveCustomerWithVisits[]>;
  getActiveCustomer(id: string): Promise<ActiveCustomer | undefined>;
  getActiveCustomerByDocument(document: string): Promise<ActiveCustomer | undefined>;
  getActiveCustomerByDocumentAndInstance(document: string, omieInstanceId: string | null): Promise<ActiveCustomer | undefined>;
  createActiveCustomer(customer: InsertActiveCustomer): Promise<ActiveCustomer>;
  updateActiveCustomer(id: string, customer: Partial<InsertActiveCustomer>): Promise<ActiveCustomer>;
  deleteActiveCustomer(id: string): Promise<void>;
  bulkUpsertActiveCustomers(customers: InsertActiveCustomer[]): Promise<{ added: number; updated: number }>;
  deactivateRemovedCustomers(uploadId: string, currentDocuments: string[], scopedInstanceIds?: string[]): Promise<number>;
  getActiveCustomerUploads(): Promise<ActiveCustomerUpload[]>;
  createActiveCustomerUpload(upload: InsertActiveCustomerUpload): Promise<ActiveCustomerUpload>;
  updateActiveCustomerUpload(id: string, upload: Partial<InsertActiveCustomerUpload>): Promise<ActiveCustomerUpload>;
  getCustomerByDocument(document: string): Promise<Customer | undefined>;
  isCustomerInActiveList(customerId: string): Promise<boolean>;

  // Phonebook contacts operations
  getPhonebookContacts(filters?: { search?: string; customerId?: string }): Promise<PhonebookContact[]>;
  getPhonebookContact(id: string): Promise<PhonebookContact | undefined>;
  getPhonebookContactByPhone(phone: string): Promise<PhonebookContact | undefined>;
  createPhonebookContact(contact: InsertPhonebookContact): Promise<PhonebookContact>;
  updatePhonebookContact(id: string, contact: Partial<InsertPhonebookContact>): Promise<PhonebookContact>;
  deletePhonebookContact(id: string): Promise<void>;
  upsertPhonebookContactByPhone(contact: InsertPhonebookContact): Promise<PhonebookContact>;
  syncActiveCustomersToPhonebook(): Promise<{ synced: number; errors: number }>;
  getCustomerByPhone(phone: string): Promise<Customer | undefined>;
  
  // Virtual Attendance Stats operations
  logVirtualAttendance(conversationId: string, agentId: string, serviceDate: Date): Promise<void>;
  getVirtualAttendanceSummary(filters: { startDate: Date; endDate: Date; agentId?: string }): Promise<Array<{
    agentId: string;
    agentName: string;
    serviceDate: string;
    conversationCount: number;
  }>>;
  
  // Omie Instances operations (multi-tenant)
  getOmieInstances(): Promise<OmieInstance[]>;
  getOmieInstance(id: string): Promise<OmieInstance | undefined>;
  getOmieInstanceByName(name: string): Promise<OmieInstance | undefined>;
  getDefaultOmieInstance(): Promise<OmieInstance | undefined>;
  createOmieInstance(data: InsertOmieInstance): Promise<OmieInstance>;
  updateOmieInstance(id: string, data: Partial<InsertOmieInstance>): Promise<OmieInstance>;
  deleteOmieInstance(id: string): Promise<void>;
  setDefaultOmieInstance(id: string): Promise<OmieInstance>;

  // Fiscal Scenarios
  getFiscalScenarios(): Promise<FiscalScenario[]>;
  getFiscalScenario(id: string): Promise<FiscalScenario | undefined>;
  createFiscalScenario(data: InsertFiscalScenario): Promise<FiscalScenario>;
  updateFiscalScenario(id: string, data: Partial<InsertFiscalScenario>): Promise<FiscalScenario>;
  deleteFiscalScenario(id: string): Promise<void>;

  // Digital Certificates
  getDigitalCertificates(): Promise<DigitalCertificate[]>;
  getDigitalCertificate(id: string): Promise<DigitalCertificate | undefined>;
  createDigitalCertificate(data: InsertDigitalCertificate): Promise<DigitalCertificate>;
  updateDigitalCertificate(id: string, data: Partial<InsertDigitalCertificate>): Promise<DigitalCertificate>;
  deleteDigitalCertificate(id: string): Promise<void>;

  // Fiscal Invoices
  getFiscalInvoices(filters?: { status?: string; customerId?: string; environment?: string }): Promise<FiscalInvoice[]>;
  getFiscalInvoice(id: string): Promise<FiscalInvoice | undefined>;
  getNextInvoiceNumber(series?: string, issuerCnpj?: string): Promise<number>;
  createFiscalInvoice(data: InsertFiscalInvoice): Promise<FiscalInvoice>;
  updateFiscalInvoice(id: string, data: Partial<InsertFiscalInvoice>): Promise<FiscalInvoice>;
  deleteFiscalInvoice(id: string): Promise<void>;

  // Fiscal Invoice Items
  getFiscalInvoiceItems(invoiceId: string): Promise<FiscalInvoiceItem[]>;
  createFiscalInvoiceItem(data: InsertFiscalInvoiceItem): Promise<FiscalInvoiceItem>;
  updateFiscalInvoiceItem(id: string, data: Partial<InsertFiscalInvoiceItem>): Promise<FiscalInvoiceItem>;
  deleteFiscalInvoiceItem(id: string): Promise<void>;
  deleteFiscalInvoiceItems(invoiceId: string): Promise<void>;

  // Fiscal Invoice Events
  getFiscalInvoiceEvents(invoiceId: string): Promise<FiscalInvoiceEvent[]>;
  createFiscalInvoiceEvent(data: InsertFiscalInvoiceEvent): Promise<FiscalInvoiceEvent>;

  // Fiscal Backups
  getFiscalBackups(filters?: { backupType?: string; referenceId?: string }): Promise<FiscalBackup[]>;
  createFiscalBackup(data: InsertFiscalBackup): Promise<FiscalBackup>;

  // Inventory Lots
  getInventoryLots(filters?: { productId?: string; instanceId?: string; stockType?: string; isActive?: boolean }): Promise<InventoryLot[]>;
  getInventoryLot(id: string): Promise<InventoryLot | undefined>;
  createInventoryLot(data: InsertInventoryLot): Promise<InventoryLot>;
  updateInventoryLot(id: string, data: Partial<InsertInventoryLot>): Promise<InventoryLot>;
  deleteInventoryLot(id: string): Promise<void>;

  // Inventory Movements
  getInventoryMovements(filters?: { lotId?: string; productId?: string; instanceId?: string; sourceType?: string; sourceId?: string }): Promise<InventoryMovement[]>;
  createInventoryMovement(data: InsertInventoryMovement): Promise<InventoryMovement>;

  // Billing Pipeline
  getBillingPipelineItems(filters?: { stage?: string }): Promise<BillingPipeline[]>;
  getBillingPipelineItem(id: string): Promise<BillingPipeline | undefined>;
  createBillingPipelineItem(data: InsertBillingPipeline): Promise<BillingPipeline>;
  updateBillingPipelineItem(id: string, data: Partial<InsertBillingPipeline>): Promise<BillingPipeline>;
  deleteBillingPipelineItem(id: string): Promise<void>;

  // Financial Module - Chart of Accounts
  getChartOfAccounts(instanceId?: string): Promise<ChartOfAccount[]>;
  getChartOfAccount(id: string): Promise<ChartOfAccount | undefined>;
  createChartOfAccount(data: InsertChartOfAccount): Promise<ChartOfAccount>;
  updateChartOfAccount(id: string, data: Partial<InsertChartOfAccount>): Promise<ChartOfAccount>;
  deleteChartOfAccount(id: string): Promise<void>;

  // Financial Module - Financial Accounts
  getFinancialAccounts(instanceId?: string): Promise<FinancialAccount[]>;
  getFinancialAccount(id: string): Promise<FinancialAccount | undefined>;
  createFinancialAccount(data: InsertFinancialAccount): Promise<FinancialAccount>;
  updateFinancialAccount(id: string, data: Partial<InsertFinancialAccount>): Promise<FinancialAccount>;
  deleteFinancialAccount(id: string): Promise<void>;

  // Financial Module - Account Movements (immutable)
  getAccountMovements(accountId: string, filters?: { startDate?: Date; endDate?: Date; limit?: number; offset?: number }): Promise<AccountMovement[]>;
  createAccountMovement(data: InsertAccountMovement): Promise<AccountMovement>;

  // Financial Module - PIX Charges
  getPixCharges(filters?: { financialAccountId?: string; status?: string; instanceId?: string; receivableId?: string; startDate?: Date; endDate?: Date }): Promise<PixCharge[]>;
  getPixCharge(id: string): Promise<PixCharge | undefined>;
  getPixChargeByTxid(txid: string): Promise<PixCharge | undefined>;
  createPixCharge(data: InsertPixCharge): Promise<PixCharge>;
  updatePixCharge(id: string, data: Partial<InsertPixCharge>): Promise<PixCharge>;

  // Financial Module - Receivables
  getReceivables(filters?: { customerId?: string; status?: string; instanceId?: string; startDate?: Date; endDate?: Date; dueDateStart?: Date; dueDateEnd?: Date; paymentMethod?: string; chartAccountId?: string }): Promise<Receivable[]>;
  getReceivable(id: string): Promise<Receivable | undefined>;
  createReceivable(data: InsertReceivable): Promise<Receivable>;
  updateReceivable(id: string, data: Partial<InsertReceivable>): Promise<Receivable>;
  deleteReceivable(id: string): Promise<void>;
  
  // Financial Module - Receivable Payments
  getReceivablePayments(receivableId: string): Promise<ReceivablePayment[]>;
  createReceivablePayment(data: InsertReceivablePayment): Promise<ReceivablePayment>;

  // Financial Module - Payables
  getPayables(filters?: { supplierDocument?: string; status?: string; instanceId?: string; startDate?: Date; endDate?: Date; dueDateStart?: Date; dueDateEnd?: Date; source?: string; chartAccountId?: string }): Promise<Payable[]>;
  getPayable(id: string): Promise<Payable | undefined>;
  createPayable(data: InsertPayable): Promise<Payable>;
  updatePayable(id: string, data: Partial<InsertPayable>): Promise<Payable>;
  deletePayable(id: string): Promise<void>;

  // Financial Module - Payable Payments
  getPayablePayments(payableId: string): Promise<PayablePayment[]>;
  createPayablePayment(data: InsertPayablePayment): Promise<PayablePayment>;

  // Financial Module - SPED
  getSpedExports(instanceId?: string): Promise<SpedExport[]>;
  createSpedExport(data: InsertSpedExport): Promise<SpedExport>;
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

  async getUserByOmieVendorCode(omieVendorCode: string): Promise<User | undefined> {
    // First try the legacy single-code field
    const [user] = await db.select().from(users).where(eq(users.omieVendorCode, omieVendorCode));
    if (user) return user;
    // Then search in the multi-instance JSON codes field
    const allUsers = await db.select().from(users).where(sql`omie_vendor_codes IS NOT NULL`);
    return allUsers.find(u => {
      if (u.omieVendorCodes && typeof u.omieVendorCodes === 'object') {
        return Object.values(u.omieVendorCodes as Record<string, string>).includes(omieVendorCode);
      }
      return false;
    });
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
      .set({ ...userData, updatedAt: nowBrazil() })
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async updateUserPassword(id: string, hashedPassword: string): Promise<User> {
    const [user] = await db
      .update(users)
      .set({ password: hashedPassword, updatedAt: nowBrazil() })
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
            updatedAt: nowBrazil(),
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
      .set({ ...routeData, updatedAt: nowBrazil() })
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
    const currentMonthStart = nowBrazil();
    currentMonthStart.setDate(1);
    currentMonthStart.setHours(0, 0, 0, 0);
    
    const currentMonthEnd = nowBrazil();
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


  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const [newCustomer] = await db.insert(customers).values(customer as any).returning();
    return newCustomer;
  }

  async updateCustomer(id: string, customer: Partial<InsertCustomer>): Promise<Customer> {
    const [updatedCustomer] = await db
      .update(customers)
      .set({ ...customer, updatedAt: nowBrazil() })
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
        updatedAt: nowBrazil()
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
        inactivatedAt: nowBrazil(),
        updatedAt: nowBrazil() 
      })
      .where(eq(customers.id, customerId))
      .returning();
    
    // 2. Also update activeCustomers table to remove from active list
    await db
      .update(activeCustomers)
      .set({ 
        isActive: false, 
        deactivatedAt: nowBrazil(),
        updatedAt: nowBrazil() 
      })
      .where(eq(activeCustomers.customerId, customerId));
    
    console.log(`✅ Cliente ${customerId} removido da lista de clientes ativos`);
    
    // 3. Delete all future pending sales cards for this customer, except the current one
    const today = nowBrazil();
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
    // Janela por DIA CALENDARIO UTC (02/jul/2026): scheduled_date tem horarios mistos
    // (00:00Z sync do 1.0, 03:00Z seed generate-from-1-0, 08:00 gerador antigo) e todos
    // pertencem ao MESMO dia calendario. A janela BRT (fromZonedTime) jogava as visitas
    // de 00:00Z para o dia anterior (faltavam hoje / sobravam amanha).
    const dateStr = date.toISOString().split('T')[0];
    const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
    const endOfDay = new Date(dateStr + 'T23:59:59.999Z');

    // OPÇÃO A (01/jul/2026): a ROTA DO DIA vem da AGENDA (visit_agenda), que é ancorada na
    // ÚLTIMA VISITA AGENDADA do 1.0 (via gerar-agendamentos). Cliente entra na rota do dia
    // quando tem visita PENDENTE agendada nesse dia. (Antes recalculava por last_sale_date.)
    const scheduled = await db
      .select({ customerId: visitAgenda.customerId })
      .from(visitAgenda)
      .where(
        and(
          eq(visitAgenda.visitStatus, 'pending'),
          gte(visitAgenda.scheduledDate, startOfDay),
          lte(visitAgenda.scheduledDate, endOfDay)
        )
      );
    const scheduledIds = Array.from(new Set(scheduled.map(sv => sv.customerId).filter(Boolean)));
    if (scheduledIds.length === 0) {
      console.log(`📅 getCustomersForDate: 0 visitas agendadas em ${dateStr} (vendedor ${sellerId})`);
      return [];
    }
    // Restringe aos clientes ATIVOS desse vendedor, com coordenadas (necessário p/ otimização).
    const custs = await db
      .select()
      .from(customers)
      .where(
        and(
          inArray(customers.id, scheduledIds),
          eq(customers.sellerId, sellerId),
          eq(customers.omieStatus, 'ativo'),
          eq(customers.isActive, true), // cliente desativado no cadastro nao entra na rota (02/jul/2026)
          sql`(${customers.isSupplier} IS NOT TRUE)`,
          isNotNull(customers.latitude),
          isNotNull(customers.longitude)
        )
      );
    console.log(`✅ getCustomersForDate: ${custs.length} clientes com visita agendada em ${dateStr} para vendedor ${sellerId}`);
    return custs;
  }

  // NOVA FUNÇÃO: Buscar clientes das visitas planejadas (visitAgenda) 
  // CRUZANDO COM active_customers para usar APENAS clientes da planilha importada
  // IMPORTANTE: Respeita o limite de 3 PRÓXIMAS VISITAS por cliente
  // Buscar clientes com visitas virtuais marcadas na visitAgenda para uma data específica
  async getCustomersWithVirtualVisitsOnDate(sellerId: string, date: Date): Promise<Customer[]> {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
      const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);
      
      // Buscar visitas marcadas como virtuais para esta data
      const virtualVisits = await db.select({
        customerId: visitAgenda.customerId
      })
      .from(visitAgenda)
      .where(
        and(
          gte(visitAgenda.scheduledDate, startOfDay),
          lte(visitAgenda.scheduledDate, endOfDay),
          eq(visitAgenda.sellerId, sellerId),
          eq(visitAgenda.isVirtual, true)
        )
      );
      
      if (virtualVisits.length === 0) return [];
      
      const customerIds = [...new Set(virtualVisits.map(v => v.customerId))];
      
      return await db.select().from(customers).where(inArray(customers.id, customerIds));
    } catch (error: any) {
      console.warn(`⚠️ Erro em getCustomersWithVirtualVisitsOnDate:`, error.message);
      return [];
    }
  }

  async getCustomersFromPlannedVisits(sellerId: string, date: Date): Promise<Customer[]> {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
      const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);
      
      console.log(`📅 getCustomersFromPlannedVisits: Buscando visitas para ${dateStr} do vendedor ${sellerId}`);
      
      // 1. Buscar IDs de clientes ativos (da planilha de Clientes Ativos)
      const activeCustomersList = await db
        .select({ customerId: activeCustomers.customerId })
        .from(activeCustomers)
        .where(
          and(
            eq(activeCustomers.isActive, true),
            isNotNull(activeCustomers.customerId)
          )
        );
      
      const activeCustomerIds = activeCustomersList
        .map(ac => ac.customerId)
        .filter((id): id is string => id !== null);
      
      console.log(`   📋 ${activeCustomerIds.length} clientes na lista de Clientes Ativos`);
      
      if (activeCustomerIds.length === 0) {
        console.log(`   ⚠️ Nenhum cliente ativo encontrado, retornando vazio`);
        return [];
      }
      
      // 2. Buscar TODAS as próximas visitas (sem limit global) e filtrar por cliente
      const today = nowBrazil();
      today.setHours(0, 0, 0, 0);
      
      const allUpcomingVisits = await db
        .select({
          customerId: visitAgenda.customerId,
          scheduledDate: visitAgenda.scheduledDate,
          visitStatus: visitAgenda.visitStatus,
          isVirtual: visitAgenda.isVirtual
        })
        .from(visitAgenda)
        .where(
          and(
            gte(visitAgenda.scheduledDate, today),
            inArray(visitAgenda.customerId, activeCustomerIds),
            eq(visitAgenda.sellerId, sellerId),
            or(
              eq(visitAgenda.visitStatus, 'pending'),
              eq(visitAgenda.visitStatus, 'scheduled')
            )
          )
        )
        .orderBy(asc(visitAgenda.scheduledDate));
      
      // 3. Agrupar por cliente e manter apenas as 3 PRIMEIRAS visitas
      const nextThreeVisitsMap = new Map<string, Array<{
        customerId: string;
        scheduledDate: Date;
        visitStatus: string;
        isVirtual: boolean;
      }>>();
      
      for (const visit of allUpcomingVisits) {
        if (!nextThreeVisitsMap.has(visit.customerId)) {
          nextThreeVisitsMap.set(visit.customerId, []);
        }
        const visits = nextThreeVisitsMap.get(visit.customerId)!;
        if (visits.length < 3) {
          visits.push(visit);
        }
      }
      
      // 4. Filtrar apenas visitas na data alvo E que estão entre as próximas 3 visitas
      const plannedVisits = allUpcomingVisits.filter(visit => {
        const dateStrVisit = visit.scheduledDate.toISOString().split('T')[0];
        const nextThree = nextThreeVisitsMap.get(visit.customerId) || [];
        return dateStrVisit === dateStr && nextThree.some(v => v.scheduledDate.toISOString().split('T')[0] === dateStr);
      });
      
      console.log(`   📋 Encontradas ${plannedVisits.length} visitas planejadas na agenda (entre próximas 3 visitas de cada cliente)`);
      
      if (plannedVisits.length === 0) {
        return [];
      }
      
      // Contar virtuais e presenciais
      const virtualCount = plannedVisits.filter(v => v.isVirtual).length;
      const physicalCount = plannedVisits.length - virtualCount;
      console.log(`   📊 ${physicalCount} presenciais + ${virtualCount} virtuais = ${plannedVisits.length} total`);
      
      // 5. Buscar os clientes correspondentes às visitas
      const customerIds = [...new Set(plannedVisits.map(v => v.customerId))];
      
      const customersData = await db
        .select()
        .from(customers)
        .where(
          and(
            inArray(customers.id, customerIds),
            eq(customers.sellerId, sellerId),
            eq(customers.omieStatus, 'ativo')
          )
        );
      
      console.log(`   ✅ ${customersData.length} clientes encontrados para as visitas planejadas`);
      
      return customersData;
    } catch (error: any) {
      console.error(`❌ Erro em getCustomersFromPlannedVisits:`, error.message);
      return [];
    }
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
      .set({ ...product, updatedAt: nowBrazil() })
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
      // 🎯 CORREÇÃO 2025-11-27: Vendedores veem:
      // 1. Cards que eles criaram (salesCards.sellerId = sellerId) OU
      // 2. Cards de clientes atribuídos a eles (customers.sellerId = sellerId)
      // Isso garante visibilidade mesmo se cliente sem sellerId ou card histórico
      const sellerCardCondition = eq(salesCards.sellerId, sellerId);
      const customerSellerCondition = eq(customers.sellerId, sellerId);
      conditions.push(or(sellerCardCondition, customerSellerCondition));
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
    // Filtrar cards com customer ou seller inválido para evitar erros
    return result
      .filter(row => row.customers !== null && row.sales_cards !== null && row.sales_cards !== undefined)
      .map(row => ({
        ...(row.sales_cards || {}),
        customer: row.customers!,
        seller: row.users || null,
      }));
  }

  async getSalesCard(id: string): Promise<SalesCardWithRelations | undefined> {
    const [result] = await db
      .select()
      .from(salesCards)
      .leftJoin(customers, eq(salesCards.customerId, customers.id))
      .leftJoin(users, eq(salesCards.sellerId, users.id))
      .where(eq(salesCards.id, id));
    
    if (!result || !result.customers || !result.sales_cards) return undefined;
    
    return {
      ...(result.sales_cards || {}),
      customer: result.customers,
      seller: result.users || null,
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
      processedSalesCard.attendanceStartDate = nowBrazil();
    }
    
    const [newSalesCard] = await db.insert(salesCards).values(processedSalesCard as any).returning();
    return newSalesCard;
  }

  async updateSalesCard(id: string, salesCard: Partial<InsertSalesCard>): Promise<SalesCard> {
    const [updatedSalesCard] = await db
      .update(salesCards)
      .set({ ...salesCard as any, updatedAt: nowBrazil() })
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
          updatedAt: nowBrazil() 
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
            
            const todayStart = nowBrazil();
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
            const nowFinal = nowBrazil();
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
                updatedAt: nowBrazil()
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
          updatedAt: nowBrazil() 
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
            
            const todayStart = nowBrazil();
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
            const nowFinal = nowBrazil();
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
                updatedAt: nowBrazil()
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
        completedDate: nowBrazil(),
        updatedAt: nowBrazil()
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
  private calculateNextRecurrenceDate(routeDay: string, recurrenceType: string, fromDate: Date = nowBrazil()): Date {
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
        attendanceStartDate: nowBrazil(), // Data de início de atendimento = data de criação
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
              or(
                eq(salesCards.sellerId, sellerId),
                eq(customers.sellerId, sellerId)
              ),
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
              or(
                eq(salesCards.sellerId, sellerId),
                eq(customers.sellerId, sellerId)
              ),
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
        or(
          eq(salesCards.sellerId, sellerId),
          eq(customers.sellerId, sellerId)
        ),
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
    
    // Filtrar cards com customer inválido para evitar erros
    return result
      .filter(row => row.customers !== null && row.sales_cards !== null && row.sales_cards !== undefined)
      .map(row => ({
        ...(row.sales_cards || {}),
        customer: row.customers!,
        seller: row.users || null,
      }));
  }

  async getOverdueSalesCards(sellerId?: string): Promise<SalesCardWithRelations[]> {
    const now = nowBrazil();
    
    let whereConditions = and(
      lte(salesCards.scheduledDate, now),
      inArray(salesCards.status, ['pending', 'in_progress'])
    );
    
    if (sellerId) {
      whereConditions = and(
        lte(salesCards.scheduledDate, now),
        inArray(salesCards.status, ['pending', 'in_progress']),
        or(
          eq(salesCards.sellerId, sellerId),
          eq(customers.sellerId, sellerId)
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
    
    // Filtrar cards com customer inválido para evitar erros
    return result
      .filter(row => row.customers !== null && row.sales_cards !== null && row.sales_cards !== undefined)
      .map(row => ({
        ...(row.sales_cards || {}),
        customer: row.customers!,
        seller: row.users || null,
      }));
  }

  // Buscar cards criticamente atrasados (pending com mais de 3 dias de atraso)
  async getCriticallyOverdueCards(sellerId?: string): Promise<SalesCardWithRelations[]> {
    // Calcular data limite: hoje - 3 dias no timezone do Brasil (UTC-3)
    const now = nowBrazil();
    
    const threeDaysAgo = new Date(now);
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
    
    // Filtrar cards com customer inválido para evitar erros
    return result
      .filter(row => row.customers !== null && row.sales_cards !== null && row.sales_cards !== undefined)
      .map(row => ({
        ...(row.sales_cards || {}),
        customer: row.customers!,
        seller: row.users || null,
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
    
    // Criar ou vincular visit_agenda para permitir check-in/check-out
    try {
      // Buscar dados do cliente para a visita
      const customer = await this.getCustomer(originalCard.customerId);
      
      if (customer) {
        // Verificar se já existe visita para este cliente na data
        const existingVisit = await db.select()
          .from(visitAgenda)
          .where(and(
            eq(visitAgenda.customerId, originalCard.customerId),
            sql`DATE(${visitAgenda.scheduledDate}) = DATE(${newDate})`
          ))
          .limit(1);
        
        if (existingVisit.length > 0) {
          // Atualizar visita existente com novo salesCardId
          await db.update(visitAgenda)
            .set({ 
              salesCardId: newCard.id,
              visitStatus: 'pending' // Reset status
            })
            .where(eq(visitAgenda.id, existingVisit[0].id));
          console.log(`✅ [DUPLICATE] Visita existente ${existingVisit[0].id} vinculada ao card duplicado ${newCard.id}`);
        } else {
          // Criar nova visita
          await db.insert(visitAgenda)
            .values({
              customerId: originalCard.customerId,
              sellerId: originalCard.sellerId,
              scheduledDate: newDate,
              routeDay: originalCard.routeDay || 'Seg',
              recurrenceType: originalCard.recurrenceType || 'semanal',
              visitStatus: 'pending',
              customerName: customer.fantasyName || customer.name || 'Cliente',
              customerLatitude: customer.latitude,
              customerLongitude: customer.longitude,
              customerAddress: customer.address,
              salesCardId: newCard.id,
              isVirtual: false
            } as any);
          console.log(`✅ [DUPLICATE] Nova visita criada para card duplicado ${newCard.id}`);
        }
      }
    } catch (visitError) {
      // Não falhar a duplicação se não conseguir criar visita
      console.error(`⚠️ [DUPLICATE] Erro ao criar visita para card duplicado:`, visitError);
    }
    
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
        scheduledDate: nowBrazil(), // Data de criação
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
      .set({ ...orderData, updatedAt: nowBrazil() })
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
      .set({ ...template, updatedAt: nowBrazil() })
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
    const today = nowBrazil();
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
    
    // Conversion rate (today: completed sales / total clients today)
    let todayCompletedQuery = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(salesCards)
      .where(
        and(
          gte(salesCards.scheduledDate, today),
          lte(salesCards.scheduledDate, tomorrow),
          eq(salesCards.status, 'completed')
        )
      );
    
    if (sellerId) {
      todayCompletedQuery = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(salesCards)
        .where(
          and(
            gte(salesCards.scheduledDate, today),
            lte(salesCards.scheduledDate, tomorrow),
            eq(salesCards.status, 'completed'),
            eq(salesCards.sellerId, sellerId)
          )
        );
    }
    
    const [todayCompletedResult] = await todayCompletedQuery;
    
    const conversionRate = todayClientsResult.count > 0 
      ? Math.round((todayCompletedResult.count / todayClientsResult.count) * 100)
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
    const currentMonthStart = nowBrazil();
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
    // PRIORIDADE: fantasy_name é CRÍTICO - sempre deve retornar nome fantasia
    const result = await db.execute(sql`
      SELECT DISTINCT ON (bp.id)
        bp.id,
        bp.invoice_number as "invoiceNumber",
        NULL as "omieOrderId",
        bp.order_number as "orderNumber",
        COALESCE(c.fantasy_name, bp.customer_name) as "customerName",
        bp.customer_document as "customerDocument",
        bp.created_at as "scheduledDate",
        bp.created_at as "invoiceDate",
        bp.sale_value as "saleValue",
        bp.products,
        bp.payment_method as "paymentMethod",
        bp.operation_type as "operationType",
        COALESCE(c.exclusive_vehicle, false) as "exclusiveVehicle",
        COALESCE(c.vehicle_types::text, '[]')::jsonb as "vehicleTypes",
        false as "isUrgent",
        c.delivery_weekdays as "deliveryWeekdays",
        COALESCE(c.latitude, NULL)::text as "customerLatitude",
        COALESCE(c.longitude, NULL)::text as "customerLongitude",
        COALESCE(c.address, '')::text as "customerAddress",
        COALESCE(c.city, '') as "customerCity",
        COALESCE(c.neighborhood, '') as "customerNeighborhood",
        COALESCE(c.receiving_weekdays, '[]'::jsonb) as "receivingWeekdays",
        COALESCE(c.delivery_time_slots, '[]'::jsonb) as "deliveryTimeSlots",
        COALESCE(c.delivery_saturday_time_slots, '[]'::jsonb) as "deliverySaturdayTimeSlots",
        COALESCE(c.average_delivery_time, 10) as "averageDeliveryTime",
        c.id as "customerId",
        c.weekdays as "customerWeekdays",
        bp.omie_instance_id as "omieInstanceId"
      FROM billing_pipeline bp
      LEFT JOIN customers c ON c.id = bp.customer_id
      WHERE bp.stage IN ('impresso', 'aguardando_rota', 'aguardando_rota_bsb')
        AND NOT EXISTS (
          SELECT 1 FROM delivery_route_stops drs
          JOIN delivery_routes dr ON dr.id = drs.route_id
          WHERE drs.billing_id = bp.id
            AND drs.status NOT IN ('devolvida', 'cancelada', 'entregue')
            AND dr.route_date >= CURRENT_DATE
        )
      ORDER BY bp.id, bp.created_at DESC, bp.customer_name
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
        customerCity: row.customerCity || '',
        customerNeighborhood: row.customerNeighborhood || '',
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
        deliverySaturdayTimeSlots: this.parseJsonField(row.deliverySaturdayTimeSlots, []),
        omieInstanceId: row.omieInstanceId || null,
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
        ${data.timestamp || nowBrazil()}, 
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
      attendanceStartDate: nowBrazil(), // Data de início de atendimento = data de criação
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
      .set({ nextCardId: createdCard.id, updatedAt: nowBrazil() })
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
      const today = nowBrazil();
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
                telemarketingDate: nowBrazil(),
                scheduledDate: today,
                notes: newNotes,
                updatedAt: nowBrazil()
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
                updatedAt: nowBrazil()
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
        completedDate: nowBrazil(),
        saleValue: outcome === 'sale' ? (saleValue ? saleValue.toString() : card.saleValue) : null,
        updatedAt: nowBrazil()
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
          updatedAt: nowBrazil(),
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

    if (result.length === 0 || !result[0].sales_cards) return undefined;

    const row = result[0];
    return {
      ...(row.sales_cards || {}),
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
      .set({ ...location, updatedAt: nowBrazil() })
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
              updatedAt: nowBrazil()
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
      const currentDate = nowBrazil();
      
      const targetMonth = month || (currentDate.getMonth() + 1);
      const targetYear = year || currentDate.getFullYear();
      
      console.log(`  📅 Data atual (Brasília):`, currentDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
      
      // ✅ CORREÇÃO: sellerId é o UUID do usuário do sistema
      // - Para billings: usar TODOS os omieVendorCodes (códigos de todas as instâncias Omie)
      // - Para customers: usar o UUID diretamente (seller_id agora é o ID real do usuário)
      let allVendorCodes: string[] = [];
      const userSellerId = sellerId;
      
      if (sellerId) {
        const userResult = await db.execute(sql`
          SELECT omie_vendor_code, omie_vendor_codes FROM users WHERE id = ${sellerId}
        `);
        if (userResult.rows.length > 0) {
          const row = userResult.rows[0] as any;
          if (row.omie_vendor_codes && typeof row.omie_vendor_codes === 'object') {
            allVendorCodes = Object.values(row.omie_vendor_codes).filter((v: any) => v) as string[];
          }
          if (allVendorCodes.length === 0 && row.omie_vendor_code) {
            allVendorCodes = [row.omie_vendor_code as string];
          }
        }
      }
      
      // Build ALL possible seller ID formats used across instances:
      // - customers.seller_id uses 'omie-vendor-{code}' format (one per instance)
      // - billings.seller_id uses raw numeric code (from fetchSellerData) OR 'omie-vendor-{code}' (from syncVendors cache)
      const allSellerUserIds = [...new Set([
        userSellerId,
        ...allVendorCodes.map(code => `omie-vendor-${code}`)
      ].filter(Boolean))] as string[];
      
      const allBillingSellerIds = [...new Set([
        ...allVendorCodes,
        ...allVendorCodes.map(code => `omie-vendor-${code}`)
      ].filter(Boolean))] as string[];
      
      const omieVendorCode = allVendorCodes.length > 0 ? allVendorCodes[0] : undefined;
      console.log(`  IDs resolvidos:`, { userSellerId, allVendorCodes, allSellerUserIds, allBillingSellerIds });
      
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
      // Buscar faturamentos do mês usando SQL raw para evitar problemas do Drizzle
      console.log(`  Buscando faturamentos para:`, { 
        omieVendorCode, 
        startOfMonth, 
        searchEndDate,
        isCurrentMonth,
        note: isCurrentMonth ? 'Usando data atual como limite' : 'Usando fim do mês como limite'
      });
      console.log(`  Tipo de omieVendorCode:`, typeof omieVendorCode, 'Valor:', omieVendorCode);
      
      let monthBillings: { rows: any[] } = { rows: [] };
      
      const startStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
      const endD = isCurrentMonth ? currentDate : endOfMonth;
      const endStr = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
      
      const billingDateFilter = sql`
        b.invoice_date >= ${startStr}::date
        AND b.invoice_date <= ${endStr}::date + interval '1 day' - interval '1 second'
        AND b.invoice_status = '100'
        AND b.is_cancelled = false
        AND b.billing_type = 'venda'
        AND b.cfop IN ('5.101','5101','5.102','5102','6.101','6101','6.102','6102')
      `;
      
      if (userSellerId) {
        monthBillings = await db.execute(sql`
          SELECT id, customer_document, cfop, total_value, seller_id, billing_type, omie_instance_id FROM (
            SELECT b.id, b.customer_document, b.cfop, b.total_value, b.seller_id, b.billing_type, b.omie_instance_id
            FROM billings b
            INNER JOIN customers c ON c.id = CONCAT('omie-client-', b.omie_customer_code)
            WHERE ${billingDateFilter}
              AND c.seller_id IN (${sql.join(allSellerUserIds.map(id => sql`${id}`), sql`, `)})
            ${allBillingSellerIds.length > 0 ? sql`
            UNION
            SELECT b.id, b.customer_document, b.cfop, b.total_value, b.seller_id, b.billing_type, b.omie_instance_id
            FROM billings b
            WHERE ${billingDateFilter}
              AND b.seller_id IN (${sql.join(allBillingSellerIds.map(c => sql`${c}`), sql`, `)})
            ` : sql``}
          ) combined
        `);
        console.log(`  🔗 Billings encontrados: ${monthBillings.rows.length} (via omie_customer_code + direct seller_id)`);
      } else {
        monthBillings = await db.execute(sql`
          SELECT id, customer_document, cfop, total_value, seller_id, billing_type, omie_instance_id
          FROM billings b
          WHERE ${billingDateFilter}
        `);
      }
      
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
      // ✅ CORREÇÃO: Usar tabela activeCustomers que é a fonte de verdade para clientes ativos
      let totalCustomersInRoute = 0;
      if (userSellerId) {
        const routeCustomersResult = await db.execute(sql`
          SELECT DISTINCT ac.customer_id FROM active_customers ac
          INNER JOIN customers c ON ac.customer_id = c.id
          WHERE c.seller_id = ${userSellerId}
            AND ac.is_active = true
        `);
        totalCustomersInRoute = routeCustomersResult.rows.length;
        console.log(`  👥 CLIENTES NA CARTEIRA (activeCustomers):`, {
          sellerId: userSellerId,
          total: totalCustomersInRoute,
          positivados: positivatedCustomers
        });
      }

      const positivationRate = totalCustomersInRoute > 0 
        ? (positivatedCustomers / totalCustomersInRoute) * 100 
        : 0;

      // === 2. VENDAS: Apenas CFOPs 5102 e 6102 são vendas reais ===
      // CFOP 5102: Venda de Mercadoria Adquirida (intra-estado)
      // CFOP 6102: Venda de Mercadoria Adquirida (inter-estado)
      // O filtro já foi aplicado no SQL acima (billingDateFilter inclui cfop IN ('5102','5.102','6102','6.102'))
      const validBillings = monthBillings.rows;
      
      console.log(`  🔍 FATURAMENTOS VÁLIDOS (CFOP 5102/6102):`, {
        total: validBillings.length,
        cfops: [...new Set(validBillings.map((b: any) => b.cfop))],
      });

      const totalRevenue = validBillings.reduce((sum: number, billing: any) => {
        const value = parseFloat(billing.total_value?.toString() || '0');
        return sum + (isNaN(value) ? 0 : value);
      }, 0);

      const revenueByInstance: Record<string, number> = {};
      for (const billing of validBillings) {
        const instId = billing.omie_instance_id || 'unknown';
        const value = parseFloat(billing.total_value?.toString() || '0');
        if (!isNaN(value)) {
          revenueByInstance[instId] = (revenueByInstance[instId] || 0) + value;
        }
      }

      const dailyAverageRevenue = workingDaysElapsed > 0 ? totalRevenue / workingDaysElapsed : 0;
      const revenueProjection = dailyAverageRevenue * workingDaysInMonth;
      
      console.log(`  💰 FATURAMENTO:`, {
        totalRevenue: totalRevenue.toFixed(2),
        validBillings: validBillings.length,
        dailyAverage: dailyAverageRevenue.toFixed(2),
        projection: revenueProjection.toFixed(2),
        byInstance: revenueByInstance
      });

      // === 3. DÉBITO VENCIDO: Soma dos débitos vencidos / Projeção de faturamento ===
      let overdueDebtRatio = 0;
      let totalOverdueDebt = 0; // Valor absoluto do débito vencido
      
      // ✅ CORREÇÃO: Usar userSellerId (UUID do usuário) para buscar débitos via customers
      if (userSellerId) {
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
          WHERE c.seller_id = ${userSellerId}
            AND c.omie_status = 'ativo'
        `);

        totalOverdueDebt = overdueDebtsResult.rows.reduce((sum: number, debt: any) => {
          const value = parseFloat(debt.total_amount?.toString() || '0');
          return sum + (isNaN(value) ? 0 : value);
        }, 0);

        if (totalOverdueDebt > 0 && revenueProjection > 0) {
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
      // ✅ CORREÇÃO: Usar userSellerId (UUID) para filtrar rotas
      if (userSellerId) {
        routeConditions.push(eq(dailyRoutes.sellerId, userSellerId));
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
        sellerId: userSellerId,
        omieVendorCode: omieVendorCode,
        positivationRate: positivationRate.toFixed(2) + '%',
        totalRevenue: totalRevenue.toFixed(2),
        revenueProjection: revenueProjection.toFixed(2),
        overdueDebtRatio: overdueDebtRatio.toFixed(2) + '%',
        serviceRate: serviceRate.toFixed(2) + '%'
      });

      return {
        positivationRate,
        totalRevenue,
        revenueByInstance,
        revenueProjection,
        overdueDebtRatio,
        totalOverdueDebt,
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
    const conditions = [eq(billings.isCancelled, false)];
    if (sellerId) {
      conditions.push(eq(billings.sellerId, sellerId));
    }
    
    const result = await db.select({
      id: billings.id,
      omieInvoiceId: billings.omieInvoiceId,
      invoiceNumber: billings.invoiceNumber,
      customerFantasyName: billings.customerFantasyName,
      billingType: billings.billingType,
      totalValue: billings.totalValue,
      invoiceDate: billings.invoiceDate,
      sellerId: billings.sellerId,
      sellerName: billings.sellerName,
      paymentMethod: billings.paymentMethod,
      dueDate: billings.dueDate,
      omieCustomerCode: billings.omieCustomerCode,
      customerDocument: billings.customerDocument,
      invoiceStatus: billings.invoiceStatus,
      createdAt: billings.createdAt,
      updatedAt: billings.updatedAt,
      cfop: billings.cfop,
      invoiceStage: billings.invoiceStage,
      omieOrderId: billings.omieOrderId,
      orderNumber: billings.orderNumber,
      orderDate: billings.orderDate,
      vendorCode: billings.vendorCode,
      stageName: billings.stageName,
      isCancelled: billings.isCancelled,
      isUrgent: billings.isUrgent,
      exclusiveVehicle: billings.exclusiveVehicle,
      vehicleTypes: billings.vehicleTypes,
      deliveryWeekdays: billings.deliveryWeekdays,
      deliveryTimeSlots: billings.deliveryTimeSlots,
      deliverySaturdayTimeSlots: billings.deliverySaturdayTimeSlots,
      omieInstanceId: billings.omieInstanceId,
    })
      .from(billings)
      .where(and(...conditions))
      .orderBy(desc(billings.invoiceDate));
    return result as Billing[];
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
      .set({ ...billing as any, updatedAt: nowBrazil() })
      .where(eq(billings.id, id))
      .returning();
    return updatedBilling;
  }

  async updateBillingUrgency(id: string, isUrgent: boolean): Promise<Billing> {
    const [updatedBilling] = await db
      .update(billings)
      .set({ isUrgent, updatedAt: nowBrazil() })
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

  async resetAllBillings(): Promise<{ deleted: number }> {
    console.log('🗑️ Removendo todos os faturamentos para sincronização total...');
    const result = await db.delete(billings).returning({ id: billings.id });
    const deleted = result.length;
    console.log(`✅ ${deleted} faturamentos removidos.`);
    return { deleted };
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

  async upsertBilling(billing: Partial<InsertBilling> & { omieInvoiceId?: string }): Promise<Billing> {
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

  async saveBillingIfValid(billing: Partial<InsertBilling> & { omieInvoiceId?: string }): Promise<{
    success: boolean;
    billing?: Billing;
    reason?: string;
    action?: 'created' | 'updated' | 'skipped';
  }> {
    try {
      const invoiceStatus = billing.invoiceStatus?.toString().trim();
      
      // Status códigos SEFAZ: 100=autorizada, 150=autorizada fora prazo, 101=cancelada, 135=evento cancelamento, 155=cancelada extemporânea
      const validStatuses = ['100', '150', '101', '135', '155']; // Apenas códigos essenciais: autorizadas e canceladas
      const isValidStatus = invoiceStatus && validStatuses.includes(invoiceStatus);
      const isCanceled = invoiceStatus && ['101', '135', '155'].includes(invoiceStatus); // Status de cancelamento
      
      if (!invoiceStatus || !isValidStatus) {
        if (!invoiceStatus || (!invoiceStatus.match(/^\d+$/) || invoiceStatus.length > 3)) {
          const reason = `Status inválido: ${invoiceStatus || 'NULL'}`;
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
        billing.invoiceStage = 'CANCELADO';
      }
      
      // Validação 2: Data da nota fiscal deve ser válida
      if (!billing.invoiceDate) {
        const reason = 'Data da nota fiscal não informada';
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
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      if (invoiceDate.getFullYear() < 2000) {
        const reason = `Data inválida (muito antiga): ${invoiceDate.toLocaleDateString()}`;
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      // Validação: Rejeitar valor total zero ou inválido (exceto para notas canceladas)
      const totalValue = typeof billing.totalValue === 'string' 
        ? parseFloat(billing.totalValue.replace(',', '.')) 
        : Number(billing.totalValue);
      
      if ((isNaN(totalValue) || totalValue <= 0) && !isCanceled) {
        const reason = `Valor total inválido: ${billing.totalValue}`;
        return {
          success: false,
          reason,
          action: 'skipped'
        };
      }
      
      // Buscar registro existente por invoice number, omieInvoiceId, ou omieOrderId
      let existing: Billing | undefined;
      
      if (billing.invoiceNumber && billing.invoiceNumber.trim() !== '') {
        existing = await this.getBillingByInvoiceNumber(billing.invoiceNumber);
      }
      
      if (!existing && billing.omieInvoiceId) {
        existing = await this.getBillingByOmieId(billing.omieInvoiceId);
      }
      
      if (!existing && (billing as any).omieOrderId) {
        existing = await this.getBillingByOrderId((billing as any).omieOrderId);
      }
      
      let savedBilling: Billing;
      let action: 'created' | 'updated';
      
      if (existing) {
        // Preservar etapa existente se a nova etapa estiver vazia
        if (!billing.invoiceStage && existing.invoiceStage) {
          billing.invoiceStage = existing.invoiceStage;
        }
        // Preservar invoiceNumber existente se o sync não trouxer NF
        if (!billing.invoiceNumber && existing.invoiceNumber) {
          billing.invoiceNumber = existing.invoiceNumber;
        }
        // Preservar omieInvoiceId existente se o sync não trouxer
        if (!(billing as any).omieInvoiceId && (existing as any).omieInvoiceId) {
          (billing as any).omieInvoiceId = (existing as any).omieInvoiceId;
        }
        // Preservar sellerName existente se o sync não trouxer vendedor
        if (!billing.sellerName && existing.sellerName) {
          (billing as any).sellerName = existing.sellerName;
        }
        // Preservar sellerId existente se o sync não trouxer vendedor
        if (!(billing as any).sellerId && (existing as any).sellerId) {
          (billing as any).sellerId = (existing as any).sellerId;
        }
        // Preservar omieInstanceId existente — NUNCA sobrescrever com instância diferente
        // Isso evita que IND/BSB/SERV corrompam registros que pertencem a outra instância
        if (existing.omieInstanceId) {
          if (billing.omieInstanceId && billing.omieInstanceId !== existing.omieInstanceId) {
            // O mesmo pedido (mesmo omieOrderId/invoiceNumber) está sendo trazido por instância diferente
            // Isso indica credenciais sobrepostas ou pedido pertence à instância original
            console.warn(`⚠️ [INSTANCE-CONFLICT] Pedido ${(billing as any).omieOrderId || billing.invoiceNumber} já pertence à instância ${existing.omieInstanceId}, ignorando atualização da instância ${billing.omieInstanceId}`);
          }
          // Sempre preservar a instância original do registro
          billing.omieInstanceId = existing.omieInstanceId;
        } else if (!billing.omieInstanceId) {
          // Ambos vazios — manter como está
        }
        savedBilling = await this.updateBilling(existing.id, billing);
        action = 'updated';
      } else {
        savedBilling = await this.createBilling(billing as InsertBilling);
        action = 'created';
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

  async markBillingsCancelledByOrderIds(omieOrderIds: string[]): Promise<number> {
    if (!omieOrderIds || omieOrderIds.length === 0) return 0;
    try {
      const result = await db.execute(sql`
        UPDATE billings
        SET is_cancelled = true, invoice_stage = 'CANCELADO'
        WHERE omie_order_id = ANY(${omieOrderIds}::text[])
          AND is_cancelled = false
      `);
      const rowsAffected = (result as any).rowCount || 0;
      if (rowsAffected > 0) {
        console.log(`✅ [CANCEL-SYNC] ${rowsAffected} faturamento(s) marcado(s) como cancelado(s)`);
      }
      return rowsAffected;
    } catch (error) {
      console.error('❌ [CANCEL-SYNC] Erro ao marcar cancelamentos:', error);
      return 0;
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
        home_latitude as "homeLatitude",
        home_longitude as "homeLongitude",
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
    if (data.email !== undefined) updateData.email = data.email;
    if (data.vehicleType !== undefined) updateData.vehicleType = data.vehicleType;
    if (data.licensePlate !== undefined) updateData.licensePlate = data.licensePlate;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.currentLocation !== undefined) updateData.currentLocation = data.currentLocation;
    
    updateData.updatedAt = nowBrazil();
    
    const [result] = await db
      .update(deliveryDrivers)
      .set(updateData)
      .where(eq(deliveryDrivers.id, id))
      .returning();
    
    return result;
  }

  async getDeliveryDriverById(id: string): Promise<any | undefined> {
    const result = await db.execute(sql`
      SELECT 
        id,
        name,
        phone,
        email,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        home_latitude as "homeLatitude",
        home_longitude as "homeLongitude",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM delivery_drivers
      WHERE id = ${id}
      LIMIT 1
    `);
    
    return result.rows && result.rows.length > 0 ? result.rows[0] : undefined;
  }

  async getDeliveryDriverByEmail(email: string): Promise<any | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`🔍 [STORAGE] Buscando motorista por email: "${email}" -> normalizado: "${normalizedEmail}"`);
    
    const result = await db.execute(sql`
      SELECT 
        id,
        name,
        phone,
        email,
        vehicle_type as "vehicleType",
        license_plate as "licensePlate",
        is_active as "isActive",
        current_location as "currentLocation",
        home_latitude as "homeLatitude",
        home_longitude as "homeLongitude",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM delivery_drivers
      WHERE LOWER(email) = ${normalizedEmail}
      LIMIT 1
    `);
    
    console.log(`🔍 [STORAGE] Resultado da busca: ${result.rows?.length || 0} motoristas encontrados`);
    if (result.rows && result.rows.length > 0) {
      console.log(`✅ [STORAGE] Motorista encontrado: id=${result.rows[0].id}, email=${result.rows[0].email}`);
    }
    
    return result.rows && result.rows.length > 0 ? result.rows[0] : undefined;
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
        COALESCE(c.fantasy_name, c.company_name) as customerName,
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
    return {
      totalDeliveries: 0,
      successRate: 0,
      failed: 0
    };
  }

  async getDeliveryReportDetailed(startDate: string, endDate: string, driverFilter?: string, statusFilter?: string): Promise<any[]> {
    const conditions = [
      sql`dr.route_date >= ${startDate}`,
      sql`dr.route_date <= ${endDate}`,
    ];
    if (driverFilter && driverFilter !== "all") {
      conditions.push(sql`(dr.driver_name = ${driverFilter} OR dr.driver_email = ${driverFilter})`);
    }
    if (statusFilter && statusFilter !== "all") {
      conditions.push(sql`drs.status = ${statusFilter}`);
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const result = await db.execute(sql`
      SELECT 
        drs.order_number,
        drs.customer_name,
        COALESCE(NULLIF(dr.driver_name, ''), INITCAP(SPLIT_PART(dr.driver_email, '@', 1)), 'Não atribuído') as driver_name,
        dr.driver_email,
        dr.route_date,
        drs.status,
        drs.check_in_time AT TIME ZONE 'America/Sao_Paulo' as check_in_time,
        drs.check_out_time AT TIME ZONE 'America/Sao_Paulo' as check_out_time,
        drs.completed_at AT TIME ZONE 'America/Sao_Paulo' as completed_at,
        drs.notes,
        dr.route_name,
        drs.stop_order,
        b.invoice_number,
        b.invoice_stage
      FROM delivery_route_stops drs
      JOIN delivery_routes dr ON dr.id = drs.route_id
      LEFT JOIN billings b ON b.id = drs.billing_id
      WHERE ${whereClause}
      ORDER BY dr.route_date DESC, dr.driver_name, drs.stop_order
    `);

    return result.rows.map((row: any) => ({
      orderNumber: row.order_number || row.invoice_number || '-',
      customerName: row.customer_name,
      driverName: row.driver_name,
      routeDate: row.route_date,
      status: row.status,
      checkInTime: row.check_in_time,
      checkOutTime: row.check_out_time,
      completedAt: row.completed_at,
      notes: row.notes,
      routeName: row.route_name,
      invoiceStage: row.invoice_stage,
      delivered: ['efetuada', 'entregue'].includes(row.status),
    }));
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
  async getDeliveryRoutes(filters?: { status?: string; routeDate?: string | Date; driverId?: string; savedOnly?: boolean }): Promise<any[]> {
    let query = db.select().from(deliveryRoutes);
    
    const conditions: any[] = [];
    if (filters?.status) {
      conditions.push(eq(deliveryRoutes.status, filters.status));
    }
    if (filters?.driverId) {
      conditions.push(eq(deliveryRoutes.driverId, filters.driverId));
    }
    if (filters?.routeDate) {
      // Usar comparação de string YYYY-MM-DD para evitar problemas de timezone
      const dateStr = typeof filters.routeDate === 'string' 
        ? filters.routeDate.split('T')[0]
        : filters.routeDate.toISOString().split('T')[0];
      conditions.push(sql`${deliveryRoutes.routeDate}::text LIKE ${dateStr + '%'}`);
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
      .set({ ...route, updatedAt: nowBrazil() })
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
      .set({ ...stop, updatedAt: nowBrazil() })
      .where(eq(deliveryRouteStops.id, id))
      .returning();
    return updated;
  }

  async reorderStop(stopId: string, routeId: string, newPosition: number): Promise<any> {
    return await db.transaction(async (tx) => {
      // Buscar a parada atual
      const [currentStop] = await tx.select().from(deliveryRouteStops).where(eq(deliveryRouteStops.id, stopId));
      if (!currentStop) throw new Error('Parada não encontrada');

      const oldPosition = currentStop.stopOrder;

      // Se está subindo na fila (nova posição < antiga)
      if (newPosition < oldPosition) {
        await tx.update(deliveryRouteStops)
          .set({ stopOrder: sql`${deliveryRouteStops.stopOrder} + 1`, updatedAt: nowBrazil() })
          .where(
            and(
              eq(deliveryRouteStops.routeId, routeId),
              sql`${deliveryRouteStops.stopOrder} >= ${newPosition} AND ${deliveryRouteStops.stopOrder} < ${oldPosition}`
            )
          );
      }
      // Se está descendo na fila (nova posição > antiga)
      else if (newPosition > oldPosition) {
        await tx.update(deliveryRouteStops)
          .set({ stopOrder: sql`${deliveryRouteStops.stopOrder} - 1`, updatedAt: nowBrazil() })
          .where(
            and(
              eq(deliveryRouteStops.routeId, routeId),
              sql`${deliveryRouteStops.stopOrder} > ${oldPosition} AND ${deliveryRouteStops.stopOrder} <= ${newPosition}`
            )
          );
      }

      // Atualizar a posição da parada
      const [updated] = await tx.update(deliveryRouteStops)
        .set({ stopOrder: newPosition, updatedAt: nowBrazil() })
        .where(eq(deliveryRouteStops.id, stopId))
        .returning();

      return updated;
    });
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
    console.log(`💾 [STORAGE] saveRouteWithStops - Iniciando transação`);
    console.log(`💾 [STORAGE] Route data:`, JSON.stringify(route, null, 2));
    console.log(`💾 [STORAGE] Stops count: ${stops.length}`);
    
    // Usar transação para garantir atomicidade
    return await db.transaction(async (tx) => {
      console.log(`💾 [STORAGE] Inserindo rota no banco...`);
      // Salvar a rota
      const [savedRoute] = await tx.insert(deliveryRoutes).values(route).returning();
      console.log(`✅ [STORAGE] Rota salva com ID: ${savedRoute.id}, routeDate: ${savedRoute.routeDate}`);
      
      // Salvar as paradas com routeId (se houver)
      const stopsWithRouteId = stops.map(stop => ({
        ...stop,
        routeId: savedRoute.id
      }));
      
      console.log(`💾 [STORAGE] Inserindo ${stopsWithRouteId.length} paradas...`);
      const savedStops = stopsWithRouteId.length > 0 
        ? await tx.insert(deliveryRouteStops).values(stopsWithRouteId).returning()
        : [];
      console.log(`✅ [STORAGE] ${savedStops.length} paradas salvas`);
      
      return { route: savedRoute, stops: savedStops };
    });
  }

  async updateBillingsStatus(billingIds: string[], newStage: string): Promise<void> {
    if (billingIds.length === 0) return;
    
    await db
      .update(billings)
      .set({ invoiceStage: newStage, updatedAt: nowBrazil() })
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

  async syncOverdueDebts(debts: any[], forceEmpty: boolean = false, omieInstanceId?: string | null): Promise<void> {
    console.log(`💾 [SYNC-DEBTS] Recebidos ${debts.length} débitos para sincronizar${omieInstanceId ? ` (instância: ${omieInstanceId})` : ''}`);
    
    // PROTEÇÃO: Não limpar dados existentes se receber array vazio (exceto se forceEmpty=true)
    if (debts.length === 0 && !forceEmpty) {
      console.log(`⚠️ [SYNC-DEBTS] Array vazio recebido - MANTENDO dados existentes para evitar perda de dados`);
      console.log(`⚠️ [SYNC-DEBTS] Se realmente deseja limpar, use forceEmpty=true`);
      return;
    }
    
    // Mapear dados antes de limpar (para garantir que temos dados válidos)
    const debtsToInsert = debts.map((debt, index) => {
      const mapped = {
        clientId: debt.cliente.codigo_cliente_omie?.toString() || 'unknown',
        omieClientId: debt.cliente.codigo_cliente_omie?.toString() || '0',
        clientName: debt.cliente.nome_fantasia || 'Cliente Desconhecido',
        clientDocument: debt.cliente.cnpj_cpf || '',
        totalAmount: debt.valorTotal.toString(),
        maxDaysOverdue: debt.diasMaximoAtraso,
        vendedores: debt.vendedores || [],
        debts: debt.debitos || [],
        omieInstanceId: omieInstanceId || null // Tag multi-tenant
      };
      
      if (index === 0) {
        console.log(`📝 [SYNC-DEBTS] Exemplo de débito mapeado:`, {
          cliente: mapped.clientName,
          documento: mapped.clientDocument,
          valor: mapped.totalAmount,
          diasAtraso: mapped.maxDaysOverdue,
          omieInstanceId: mapped.omieInstanceId
        });
      }
      
      return mapped;
    });
    
    // Se temos uma instância específica, limpar apenas débitos dessa instância
    if (omieInstanceId) {
      await db.delete(overdueDebts).where(eq(overdueDebts.omieInstanceId, omieInstanceId));
      console.log(`🗑️ [SYNC-DEBTS] Débitos da instância ${omieInstanceId} removidos`);
    } else {
      // Limpar todos os débitos (comportamento legado)
      await db.delete(overdueDebts);
      console.log(`🗑️ [SYNC-DEBTS] Tabela overdue_debts limpa`);
    }
    
    console.log(`💾 [SYNC-DEBTS] Inserindo ${debtsToInsert.length} débitos no banco...`);
    await db.insert(overdueDebts).values(debtsToInsert);
    console.log(`✅ [SYNC-DEBTS] ${debtsToInsert.length} débitos inseridos com sucesso`);
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
      .set({ ...data, updatedAt: nowBrazil() })
      .where(eq(dailyRoutes.id, id))
      .returning();
    return route;
  }

  async deleteDailyRoute(id: string): Promise<void> {
    await db
      .delete(dailyRoutes)
      .where(eq(dailyRoutes.id, id));
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
    
    // Retornar com coordenadas do checkpoint (capturadas durante check-in/check-out)
    return results.filter(row => row.route_checkpoints !== null && row.route_checkpoints !== undefined).map(row => ({
      ...(row.route_checkpoints || {}),
      latitude: row.route_checkpoints?.checkpointLatitude ? parseFloat(row.route_checkpoints.checkpointLatitude.toString()) : null,
      longitude: row.route_checkpoints?.checkpointLongitude ? parseFloat(row.route_checkpoints.checkpointLongitude.toString()) : null,
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

      const futureDate = nowBrazil();
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
                updatedAt: nowBrazil()
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
          updatedAt: nowBrazil(),
        },
      })
      .returning();
    return status;
  }

  async updateSyncStatus(syncType: string, data: { 
    status: 'success' | 'error' | 'in_progress'; 
    message?: string; 
    recordsProcessed?: number;
    totalRecords?: number;
    currentProgress?: number;
    lastFinishedAt?: Date;
    lastSyncAt?: Date;
  }): Promise<SyncStatus> {
    // Tentar atualizar primeiro
    const [existing] = await db
      .select()
      .from(syncStatus)
      .where(eq(syncStatus.syncType, syncType));
    
    if (existing) {
      // Atualizar registro existente
      const updateData: any = {
        status: data.status,
        updatedAt: nowBrazil()
      };

      if (data.message !== undefined) updateData.message = data.message;
      if (data.recordsProcessed !== undefined) updateData.recordsProcessed = data.recordsProcessed;
      if (data.totalRecords !== undefined) updateData.totalRecords = data.totalRecords;
      if (data.currentProgress !== undefined) updateData.currentProgress = data.currentProgress;
      if (data.lastFinishedAt !== undefined) updateData.lastFinishedAt = data.lastFinishedAt;
      if (data.lastSyncAt !== undefined) updateData.lastSyncAt = data.lastSyncAt;
      if ((data as any).syncDurationSeconds !== undefined) updateData.syncDurationSeconds = (data as any).syncDurationSeconds;
      if (data.status === 'success') updateData.lastSyncAt = new Date();

      const [status] = await db
        .update(syncStatus)
        .set(updateData)
        .where(eq(syncStatus.syncType, syncType))
        .returning();
      return status;
    } else {
      // Criar novo registro
      const insertData: any = {
        syncType,
        status: data.status,
        lastSyncAt: data.lastSyncAt || new Date(),
        updatedAt: new Date()
      };

      if (data.message !== undefined) insertData.message = data.message;
      if (data.recordsProcessed !== undefined) insertData.recordsProcessed = data.recordsProcessed;
      if (data.totalRecords !== undefined) insertData.totalRecords = data.totalRecords;
      if (data.currentProgress !== undefined) insertData.currentProgress = data.currentProgress;
      if (data.lastFinishedAt !== undefined) insertData.lastFinishedAt = data.lastFinishedAt;

      const [status] = await db
        .insert(syncStatus)
        .values(insertData)
        .returning();
      return status;
    }
  }

  async getSyncStatuses(): Promise<SyncStatus[]> {
    return await db.select().from(syncStatus);
  }
  
  // Lead operations
  async getLeads(): Promise<Lead[]> {
    try {
      const result = await db.select().from(leads).orderBy(desc(leads.createdAt));
      console.log('📋 [STORAGE] getLeads: Query retornou', result.length, 'leads');
      return result;
    } catch (error) {
      console.error('❌ [STORAGE] Erro no getLeads:', error);
      throw error;
    }
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
      updatedAt: nowBrazil(),
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
  
  // Lead Visit operations
  async getLeadVisits(leadId: string): Promise<LeadVisit[]> {
    return await db
      .select()
      .from(leadVisits)
      .where(eq(leadVisits.leadId, leadId))
      .orderBy(desc(leadVisits.visitDate));
  }
  
  async createLeadVisit(visitData: InsertLeadVisit): Promise<LeadVisit> {
    const [visit] = await db.insert(leadVisits).values(visitData).returning();
    
    // If temperature was provided, update the lead's temperature as well
    if (visitData.temperature) {
      await db.update(leads)
        .set({ temperature: visitData.temperature, updatedAt: nowBrazil() })
        .where(eq(leads.id, visitData.leadId));
    }
    
    return visit;
  }
  
  // Chat Agents operations
  async getChatAgents(): Promise<ChatAgent[]> {
    // Retornar apenas agentes ativos (cadastrados e ativos no Integra)
    return await db.select().from(chatAgents).where(eq(chatAgents.isActive, true));
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
      .set({ status, updatedAt: nowBrazil() })
      .where(eq(chatAgents.id, id))
      .returning();
    return agent;
  }

  async updateChatAgentPresence(id: string, status: string): Promise<ChatAgent> {
    const [agent] = await db
      .update(chatAgents)
      .set({ status, lastSeenAt: nowBrazil(), updatedAt: nowBrazil() })
      .where(eq(chatAgents.id, id))
      .returning();
    return agent;
  }

  // Sincronizar usuários ativos como agentes de chat
  async syncUsersAsAgents(): Promise<void> {
    try {
      // 🗑️ Limpar agentes existentes para garantir carga limpa
      await db.delete(chatAgents);
      console.log(`🧹 [SYNC-AGENTS] Agentes existentes removidos para nova carga`);

      const allUsers = await this.getUsers();
      let synced = 0;
      
      const relevantRoles = ['admin', 'coordinator', 'telemarketing', 'administrative'];
      const activeUsers = allUsers.filter(u => u.isActive && relevantRoles.includes(u.role));

      for (const user of activeUsers) {
        await db.insert(chatAgents).values({
          userId: user.id,
          name: user.name || user.email,
          email: user.email,
          phone: user.phone,
          status: 'offline',
          isActive: true
        }).onConflictDoNothing();
        synced++;
      }
      
      console.log(`✅ [SYNC-AGENTS] Sincronizados ${synced} usuários ativos como agentes`);
    } catch (error) {
      console.error(`❌ [SYNC-AGENTS] Erro ao sincronizar agentes:`, error);
    }
  }

  // Encerrar conversas inativas (timeout configurável, padrão 30 min)
  // Retorna objeto com conversas fechadas para envio de mensagem de finalização
  async closeInactiveConversations(): Promise<{ count: number; conversations: Array<{ id: string; customerPhone: string; customerName: string }> }> {
    try {
      // Buscar configurações de timeout
      const aiSettings = await this.getChatAiSettings();
      const timeoutMinutes = aiSettings?.inactivityTimeoutMinutes ?? 30;
      const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);
      
      // Encerrar todas as conversas não finalizadas que estão inativas há X minutos
      // Status a fechar: 'new', 'assigned', 'in-progress'
      // Também limpa assignedAgentId para que cliente possa ser atendido novamente
      const result = await db
        .update(chatConversations)
        .set({ 
          status: 'resolved',
          assignedAgentId: null,
          assignedAgentColor: null,
          updatedAt: nowBrazil()
        })
        .where(
          and(
            sql`${chatConversations.status} IN ('new', 'assigned', 'in-progress')`,
            lt(chatConversations.lastMessageTime, cutoffTime)
          )
        )
        .returning();
      
      if (result.length > 0) {
        console.log(`⏰ [INACTIVE-CONV] ${result.length} conversa(s) encerrada(s) por inatividade (${timeoutMinutes} min)`);
        result.forEach(conv => {
          console.log(`   📌 Conversa ${conv.id} (${conv.customerPhone}) finalizada - atendente desvinculado`);
        });
      }
      
      return {
        count: result.length,
        conversations: result.map(c => ({
          id: c.id,
          customerPhone: c.customerPhone || '',
          customerName: c.customerName || ''
        }))
      };
    } catch (error) {
      console.error(`❌ [INACTIVE-CONV] Erro ao encerrar conversas inativas:`, error);
      return { count: 0, conversations: [] };
    }
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
    // 🔧 Normalizar telefone ao criar
    const normalizedData = {
      ...customerData,
      phone: this.normalizePhoneForStorage(customerData.phone)
    };
    const [customer] = await db.insert(chatCustomers).values(normalizedData).returning();
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

  async getChatCustomerByPhone(phone: string): Promise<ChatCustomer | undefined> {
    // 🔧 Normalizar telefone na busca
    let normalizedPhone = this.normalizePhoneForStorage(phone);
    console.log(`🔍 [getChatCustomerByPhone] Buscando cliente com número: ${normalizedPhone}`);
    
    // Buscar cliente direto pelo número normalizado
    let [customer] = await db.select().from(chatCustomers).where(eq(chatCustomers.phone, normalizedPhone));
    if (customer) {
      console.log(`✅ [getChatCustomerByPhone] Cliente encontrado direto: ${customer.id}`);
      return customer;
    }
    
    // Se não encontrou, buscar mapeamento de números alternativos
    console.log(`🔄 [getChatCustomerByPhone] Cliente não encontrado. Buscando mapeamento de números alternativos...`);
    try {
      const [mapping] = await db.select().from(phoneNumberMappings)
        .where(and(
          eq(phoneNumberMappings.alternativePhone, normalizedPhone),
          eq(phoneNumberMappings.isActive, true)
        ));
      
      if (mapping) {
        console.log(`📍 [getChatCustomerByPhone] Mapeamento encontrado: ${normalizedPhone} -> ${mapping.canonicalPhone}`);
        normalizedPhone = mapping.canonicalPhone;
        // Buscar com o número canônico
        [customer] = await db.select().from(chatCustomers).where(eq(chatCustomers.phone, normalizedPhone));
        if (customer) {
          console.log(`✅ [getChatCustomerByPhone] Cliente encontrado via mapeamento: ${customer.id}`);
          return customer;
        }
      }
    } catch (err) {
      console.warn(`⚠️ [getChatCustomerByPhone] Erro ao buscar mapeamento:`, err);
    }
    
    console.log(`❌ [getChatCustomerByPhone] Cliente não encontrado para: ${normalizedPhone}`);
    return undefined;
  }
  
  private normalizePhoneForStorage(phone: string): string {
    if (!phone) return '';
    let digitsOnly = phone.replace(/\D/g, '');
    if (digitsOnly.startsWith('55')) {
      digitsOnly = digitsOnly.slice(2);
    }
    while (digitsOnly.length > 11) {
      digitsOnly = digitsOnly.slice(-11);
    }
    return `55${digitsOnly.slice(-11)}`;
  }

  async getChatConversationByCustomerId(customerId: string): Promise<ChatConversation | undefined> {
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.customerId, customerId));
    return conversation;
  }
  
  // Obter conversas em andamento agrupadas por agente
  async getConversationsCountByAgent(): Promise<Array<{ agentId: string | null; agentName: string | null; count: number; conversations: ChatConversation[] }>> {
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.status, 'in-progress' as any));
    
    // Agrupar por agente
    const grouped = new Map<string | null, ChatConversation[]>();
    for (const conv of conversations) {
      const key = conv.agentId || 'unassigned';
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(conv);
    }

    // Buscar nomes dos agentes
    const agents = await db.select().from(chatAgents);
    const result = Array.from(grouped.entries()).map(([agentId, convs]) => {
      const agent = agents.find(a => a.id === agentId);
      return {
        agentId: agentId === 'unassigned' ? null : agentId,
        agentName: agent?.name || (agentId === 'unassigned' ? 'Sem Atribução' : 'Desconhecido'),
        count: convs.length,
        conversations: convs
      };
    });

    return result;
  }

  // Transferir conversa para outro agente
  async transferConversation(conversationId: string, newAgentId: string): Promise<ChatConversation> {
    const [conversation] = await db
      .update(chatConversations)
      .set({ 
        agentId: newAgentId,
        updatedAt: nowBrazil()
      })
      .where(eq(chatConversations.id, conversationId))
      .returning();
    
    console.log(`✅ [TRANSFER] Conversa ${conversationId} transferida para agente ${newAgentId}`);
    return conversation;
  }

  // Obter stats detalhados de todos os agentes ATIVOS
  async getAgentDetailedStats(): Promise<Array<{ 
    id: string; 
    name: string; 
    email: string;
    status: string;
    color: string;
    lastActivity?: Date;
    messagesAnswered: number;
    messagesToRespond: number;
  }>> {
    // Apenas agentes ativos (cadastrados e ativos no Integra)
    const agents = await db.select().from(chatAgents).where(eq(chatAgents.isActive, true));
    const conversations = await db.select().from(chatConversations);
    const messages = await db.select().from(chatMessages);

    // 🕒 Início do dia vigente no fuso America/Sao_Paulo (BRT, UTC-3) — "Respondidas" zera na virada do dia
    const brtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const startOfTodayBRT = new Date(`${brtDate}T00:00:00-03:00`);

    // 📌 Última mensagem de cada conversa (para detectar conversas aguardando resposta do atendente)
    const latestMsgByConv = new Map<string, any>();
    for (const m of messages) {
      const prev = latestMsgByConv.get(m.conversationId);
      if (!prev || (m.createdAt && prev.createdAt && new Date(m.createdAt as any) > new Date(prev.createdAt))) {
        latestMsgByConv.set(m.conversationId, m);
      }
    }

    return agents.map((agent, index) => {
      // 🔗 IDs que representam este atendente: o envio grava senderId = user.id; a distribuição usa chat_agents.id
      const ownIds = new Set([agent.id, agent.userId].filter(Boolean) as string[]);

      // 🔍 Conversas do agente — a atribuição usa assignedAgentId (agentId como fallback legado)
      const agentConversations = conversations.filter(c =>
        (c.assignedAgentId && ownIds.has(c.assignedAgentId)) ||
        (c.agentId && ownIds.has(c.agentId))
      );

      // ✅ RESPONDIDAS (dia vigente / BRT): mensagens de resposta enviadas pelo atendente HOJE — zera à meia-noite
      const answeredToday = messages.filter(m =>
        m.senderType === 'agent' &&
        ownIds.has(m.senderId) &&
        m.createdAt && new Date(m.createdAt as any) >= startOfTodayBRT
      );

      // 📥 A RESPONDER: conversas em andamento (não resolvidas) do atendente cuja ÚLTIMA mensagem é do cliente — independe do dia
      const awaitingReply = agentConversations.filter(c => {
        if (c.status === 'resolved') return false;
        const last = latestMsgByConv.get(c.id);
        return !!last && last.senderType === 'customer';
      });

      // 🎨 Cor do atendente baseada no índice (consistente com chat-distribution-service)
      const agentColor = AGENT_COLORS[index % AGENT_COLORS.length];

      return {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        status: agent.status === 'online' ? 'online' : 'offline',
        color: agentColor,
        lastActivity: agent.lastSeenAt,
        messagesAnswered: answeredToday.length,
        messagesToRespond: awaitingReply.length
      };
    });
  }

  // Chat Conversations operations
  async getChatConversations(): Promise<ChatConversation[]> {
    return await db.select().from(chatConversations).orderBy(desc(chatConversations.lastMessageTime));
  }
  
  async getChatConversation(id: string): Promise<ChatConversation | undefined> {
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, id));
    return conversation;
  }

  async getChatConversationByPhone(phone: string): Promise<ChatConversation | undefined> {
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.customerPhone, phone));
    return conversation;
  }

  async createChatConversation(conversationData: InsertChatConversation): Promise<ChatConversation> {
    const [conversation] = await db.insert(chatConversations).values(conversationData).returning();
    return conversation;
  }
  
  async updateChatConversation(id: string, conversationData: UpdateChatConversation): Promise<ChatConversation> {
    const [conversation] = await db
      .update(chatConversations)
      .set(conversationData)
      .where(eq(chatConversations.id, id))
      .returning();
    return conversation;
  }

  async upsertChatConversation(conversationData: InsertChatConversation): Promise<ChatConversation> {
    const now = nowBrazil();
    // Se customerPhone está definido, tenta buscar conversa existente
    if (conversationData.customerPhone) {
      // 🔧 UNIFICAÇÃO: Buscar por variações do número (com/sem 9)
      const phone = conversationData.customerPhone;
      let digitsOnly = phone.replace(/\D/g, '');
      
      // IDs conhecidos que devem ser mapeados ANTES da busca
      const idMappings: { [key: string]: string } = {
        '5550575396912': '5562996353860',
        '5504884295924': '5562995782812',
        '5504884295924@s.whatsapp.net': '5562995782812',
        '173250575396912': '5562996353860',
        '50575396912': '5562996353860',
        '04884295924': '5562995782812',
        '5550575396012': '5562996353860'
      };
      
      let targetPhone = phone;
      if (idMappings[digitsOnly]) {
        targetPhone = idMappings[digitsOnly];
        digitsOnly = targetPhone.replace(/\D/g, '');
      }
      
      if (digitsOnly.startsWith('55')) digitsOnly = digitsOnly.slice(2);
      
      const variants = [
        `55${digitsOnly}`, // Original
      ];
      
      // Se tem 11 dígitos (DDD + 9 + número), adicionar variante sem o 9
      if (digitsOnly.length === 11 && digitsOnly[2] === '9') {
        variants.push(`55${digitsOnly.slice(0, 2)}${digitsOnly.slice(3)}`);
      } 
      // Se tem 10 dígitos (DDD + número), adicionar variante com o 9
      else if (digitsOnly.length === 10) {
        variants.push(`55${digitsOnly.slice(0, 2)}9${digitsOnly.slice(2)}`);
      }

      console.log(`🔍 [UPSERT-CONV] Buscando variantes de ${phone} (target: ${targetPhone}):`, variants);

      const existing = await db
        .select()
        .from(chatConversations)
        .where(inArray(chatConversations.customerPhone, variants))
        .limit(1);
      
      if (existing.length > 0) {
        // Atualizar conversa existente (usando o ID original para manter o diálogo)
        const [updated] = await db
          .update(chatConversations)
          .set({
            ...conversationData,
            customerPhone: existing[0].customerPhone, // Mantém o telefone que já estava no banco para evitar trocas
            updatedAt: now,
            lastMessageTime: conversationData.lastMessageTime || now
          })
          .where(eq(chatConversations.id, existing[0].id))
          .returning();
        return updated;
      }
    }
    
    // Criar nova conversa
    const [conversation] = await db.insert(chatConversations).values({
      ...conversationData,
      createdAt: now,
      updatedAt: now,
      lastMessageTime: conversationData.lastMessageTime || now
    }).returning();
    return conversation;
  }
  
  // Chat Messages operations
  async getChatMessages(conversationId: string): Promise<ChatMessage[]> {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt); // Ordenar cronologicamente por data de criação (crescente)
    
    // DEBUG: Verificar ordenação
    if (messages.length > 0) {
      console.log(`📊 [MESSAGES-ORDER] Conversa ${conversationId}: ${messages.length} mensagens | Primeira: ${messages[0].createdAt} | Última: ${messages[messages.length-1].createdAt}`);
    }
    
    return messages;
  }
  
  async getChatMessageByExternalId(externalId: string): Promise<ChatMessage | undefined> {
    const [message] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.externalId, externalId))
      .limit(1);
    return message;
  }
  
  async createChatMessage(messageData: InsertChatMessage): Promise<ChatMessage> {
    // 🪞 ESPELHO WHATSAPP: Inserir com proteção contra race conditions
    // Se mensagem com mesmo externalId já existe, retorna a existente sem erro
    if (messageData.externalId) {
      try {
        // Tentar inserir diretamente - o índice único irá rejeitar duplicatas
        const [message] = await db.insert(chatMessages).values(messageData).returning();
        return message;
      } catch (error: any) {
        // Se for erro de duplicata (código 23505 = unique_violation), buscar existente
        if (error.code === '23505' && error.constraint?.includes('external_id')) {
          console.log(`⏭️  [STORAGE] Mensagem duplicada (race condition), buscando existente: ${messageData.externalId}`);
          const existing = await db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.externalId, messageData.externalId))
            .limit(1);
          
          if (existing.length > 0) {
            return existing[0];
          }
        }
        // Re-lançar outros erros
        throw error;
      }
    }
    
    // Fallback para mensagens sem externalId (mensagens internas do sistema)
    const [message] = await db.insert(chatMessages).values(messageData).returning();
    return message;
  }

  // 🟢 Atualizar status de leitura de mensagem
  async updateChatMessage(id: string, updates: Partial<ChatMessage>): Promise<ChatMessage> {
    const [message] = await db
      .update(chatMessages)
      .set(updates)
      .where(eq(chatMessages.id, id))
      .returning();
    return message;
  }

  // 🟢 Incrementar contador de mensagens não lidas
  async incrementUnreadCount(conversationId: string): Promise<ChatConversation> {
    const [conversation] = await db
      .update(chatConversations)
      .set({
        unreadCount: sql`${chatConversations.unreadCount} + 1`
      })
      .where(eq(chatConversations.id, conversationId))
      .returning();
    return conversation;
  }

  // 🟢 Resetar contador de mensagens não lidas
  async resetUnreadCount(conversationId: string): Promise<ChatConversation> {
    const [conversation] = await db
      .update(chatConversations)
      .set({ unreadCount: 0 })
      .where(eq(chatConversations.id, conversationId))
      .returning();
    return conversation;
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
    return await db.select().from(chatQuickMessages).where(eq(chatQuickMessages.isActive, true)).orderBy(chatQuickMessages.sortOrder);
  }
  
  async getChatQuickMessage(id: string): Promise<ChatQuickMessage | undefined> {
    const [message] = await db.select().from(chatQuickMessages).where(eq(chatQuickMessages.id, id));
    return message;
  }
  
  async createChatQuickMessage(messageData: InsertChatQuickMessage): Promise<ChatQuickMessage> {
    const [message] = await db.insert(chatQuickMessages).values(messageData).returning();
    return message;
  }
  
  async updateChatQuickMessage(id: string, messageData: Partial<InsertChatQuickMessage>): Promise<ChatQuickMessage> {
    const [message] = await db
      .update(chatQuickMessages)
      .set({ ...messageData, updatedAt: nowBrazil() })
      .where(eq(chatQuickMessages.id, id))
      .returning();
    return message;
  }
  
  async deleteChatQuickMessage(id: string): Promise<void> {
    await db.update(chatQuickMessages).set({ isActive: false }).where(eq(chatQuickMessages.id, id));
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
      .set({ ...orderData, updatedAt: nowBrazil() })
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
      .set({ ...deliveryData, updatedAt: nowBrazil() })
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

  // Sync chat history from Evolution API
  async syncChatHistory(
    customerPhone: string,
    customerName: string,
    messages: any[]
  ): Promise<{ conversationId: string; messageCount: number }> {
    // Get or create chat customer
    let chatCustomer = await db
      .select()
      .from(chatCustomers)
      .where(eq(chatCustomers.phone, customerPhone))
      .limit(1)
      .then(rows => rows[0]);

    if (!chatCustomer) {
      const [newCustomer] = await db
        .insert(chatCustomers)
        .values({
          phone: customerPhone,
          name: customerName,
          isActive: true
        })
        .returning();
      chatCustomer = newCustomer;
    }

    // Get or create conversation
    let conversation = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.chatCustomerId, chatCustomer.id))
      .limit(1)
      .then(rows => rows[0]);

    if (!conversation) {
      const [newConversation] = await db
        .insert(chatConversations)
        .values({
          chatCustomerId: chatCustomer.id,
          status: 'active',
          lastMessageAt: nowBrazil(),
          isRead: false
        })
        .returning();
      conversation = newConversation;
    }

    // Insert messages (avoid duplicates by messageId)
    let messageCount = 0;
    for (const msg of messages) {
      try {
        const existingMsg = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.messageId, msg.key?.id || `msg-${Date.now()}`))
          .limit(1)
          .then(rows => rows[0]);

        if (!existingMsg) {
          const isFromMe = msg.key?.fromMe || false;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Mensagem de mídia]';
          
          await db.insert(chatMessages).values({
            conversationId: conversation.id,
            content: text,
            messageId: msg.key?.id || `msg-${Date.now()}`,
            senderPhone: isFromMe ? 'honest_sucos' : customerPhone,
            isRead: true, // Mark old messages as read
            messageType: 'text',
            createdAt: new Date(msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now())
          });
          messageCount++;
        }
      } catch (error) {
        console.error('Erro ao inserir mensagem de sincronização:', error);
      }
    }

    return {
      conversationId: conversation.id,
      messageCount
    };
  }

  // ============================================================================
  // Active Customers operations
  // ============================================================================
  
  async getActiveCustomers(): Promise<ActiveCustomer[]> {
    return await db.select().from(activeCustomers).where(eq(activeCustomers.isActive, true)).orderBy(desc(activeCustomers.createdAt));
  }
  
  async getActiveCustomersWithVisits(): Promise<ActiveCustomerWithVisits[]> {
    try {
      const active = await db.select().from(activeCustomers).where(eq(activeCustomers.isActive, true));
      
      if (active.length === 0) return [];
      
      // Buscar clientes associados COM JOIN de vendedores (otimizado - single query)
      const customerIds = active.map(ac => ac.customerId).filter((id) => id != null) as string[];
      const customerMap = new Map<string, any>();
      
      // Data de hoje em Brasília (sem timezone issues)
      const todayBrasilia = nowBrazil();
      const todayYear = todayBrasilia.getFullYear();
      const todayMonth = String(todayBrasilia.getMonth() + 1).padStart(2, '0');
      const todayDay = String(todayBrasilia.getDate()).padStart(2, '0');
      const todayStr = `${todayYear}-${todayMonth}-${todayDay}`;
      
      const today = new Date(todayStr);
      today.setHours(0, 0, 0, 0);
      
      // Mapas para positivação, última atividade e totais mensais
      let positivationMap = new Map<string, boolean>();
      let lastActivityMap = new Map<string, Date>();
      let monthlyTotalsMap = new Map<string, { previousMonth: number; currentMonth: number }>();
      let avg3mMap = new Map<string, number>();

      // Buscar instância Omie padrão para fallback de clientes sem omieInstanceId
      let defaultOmieInstanceId: string | null = null;
      try {
        const [defaultInstance] = await db.select().from(omieInstances).where(eq(omieInstances.isDefault, true));
        if (defaultInstance) {
          defaultOmieInstanceId = defaultInstance.id;
        } else {
          // Se não há padrão, pegar a primeira instância ativa
          const [firstActive] = await db.select().from(omieInstances).where(eq(omieInstances.isActive, true));
          if (firstActive) defaultOmieInstanceId = firstActive.id;
        }
      } catch (e) {
        // silently ignore
      }
      
      if (customerIds.length > 0) {
        try {
          // 1. Buscar TODOS os vendedores de uma vez
          const customersData = await db.select().from(customers).where(inArray(customers.id, customerIds));
          const sellerIds = Array.from(new Set(customersData.map(c => c.sellerId).filter(Boolean)));
          
          let sellerMap = new Map<string, string>();
          if (sellerIds.length > 0) {
            const sellersData = await db.select().from(users).where(inArray(users.id, sellerIds));
            for (const seller of sellersData) {
              const firstName = seller.firstName?.trim() || '';
              const lastName = seller.lastName?.trim() || '';
              const sellerName = firstName || lastName
                ? `${firstName} ${lastName}`.trim()
                : seller.email?.split('@')[0] || seller.email || 'Desconhecido';
              sellerMap.set(seller.id, sellerName);
            }
          }
          
          // 2. Mapear clientes com nomes de vendedores
          for (const c of customersData) {
            const sellerName = c.sellerId ? sellerMap.get(c.sellerId) : undefined;
            customerMap.set(c.id, { ...c, sellerName });
          }
          
          // 3. Buscar positivações do mês atual através dos faturamentos (billings)
          const currentMonthStart = nowBrazil();
          currentMonthStart.setDate(1);
          currentMonthStart.setHours(0, 0, 0, 0);
          
          const currentMonthEnd = nowBrazil();
          currentMonthEnd.setMonth(currentMonthEnd.getMonth() + 1);
          currentMonthEnd.setDate(0);
          currentMonthEnd.setHours(23, 59, 59, 999);
          
          // Buscar códigos Omie dos clientes
          const customerOmieCodes = customersData
            .map(c => c.omieClientCode)
            .filter((code): code is string => !!code);
          
          if (customerOmieCodes.length > 0) {
            // Buscar positivações
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
            const omieCodePositivationMap = new Map(
              positivations.map(p => [p.omieCustomerCode, p.count > 0])
            );
            
            // Converter para customerId -> true/false
            for (const c of customersData) {
              if (c.omieClientCode) {
                positivationMap.set(c.id, omieCodePositivationMap.get(c.omieClientCode) || false);
              }
            }
            
            // Buscar última atividade (última fatura)
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
            for (const c of customersData) {
              if (c.omieClientCode && omieLastActivityMap.has(c.omieClientCode)) {
                lastActivityMap.set(c.id, omieLastActivityMap.get(c.omieClientCode)!);
              }
            }
            
            // 4. Buscar totais de compras do mês anterior e atual
            const previousMonthStart = new Date(currentMonthStart);
            previousMonthStart.setMonth(previousMonthStart.getMonth() - 1);
            
            const previousMonthEnd = new Date(currentMonthStart);
            previousMonthEnd.setDate(previousMonthEnd.getDate() - 1);
            previousMonthEnd.setHours(23, 59, 59, 999);
            
            // Totais do mês anterior
            const customerIds = customersData.map((c: any) => c.id).filter(Boolean);

      const previousMonthTotals = customerIds.length ? await db
        .select({
          customerId: billingPipeline.customerId,
          total: sql<number>`COALESCE(SUM(${billingPipeline.saleValue}), 0)`.mapWith(Number),
        })
        .from(billingPipeline)
        .where(and(
          inArray(billingPipeline.customerId, customerIds),
          gte(billingPipeline.createdAt, previousMonthStart),
          sql`${billingPipeline.createdAt} <= ${previousMonthEnd}`,
        ))
        .groupBy(billingPipeline.customerId) : [];

      const currentMonthTotals = customerIds.length ? await db
        .select({
          customerId: billingPipeline.customerId,
          total: sql<number>`COALESCE(SUM(${billingPipeline.saleValue}), 0)`.mapWith(Number),
        })
        .from(billingPipeline)
        .where(and(
          inArray(billingPipeline.customerId, customerIds),
          gte(billingPipeline.createdAt, currentMonthStart),
          sql`${billingPipeline.createdAt} <= ${currentMonthEnd}`,
        ))
        .groupBy(billingPipeline.customerId) : [];

      const previousMonthMap = new Map(previousMonthTotals.map((p: any) => [p.customerId, p.total]));
      const currentMonthMap = new Map(currentMonthTotals.map((p: any) => [p.customerId, p.total]));

      for (const c of customersData) {
        const prevTotal = previousMonthMap.get(c.id) || 0;
        const currTotal = currentMonthMap.get(c.id) || 0;
        monthlyTotalsMap.set(c.id, { previousMonth: prevTotal, currentMonth: currTotal });
      }

      // POSITIVAÇÃO do mês (comprou no mês) — abrangente e incluindo faturas do INTEGRA 1.0.
      // Fonte: billing_pipeline (venda registrada no 2.0) OU receivables (todo faturamento vira
      // recebível; a tabela receivables é sincronizada do 1.0 e também nativa do 2.0).
      try {
        const recMonth = await db
          .select({ customerId: receivables.customerId, customerDocument: receivables.customerDocument })
          .from(receivables)
          .where(and(
            gte(receivables.issueDate, currentMonthStart),
            sql`${receivables.issueDate} <= ${currentMonthEnd}`,
            sql`${receivables.amount}::numeric > 0`,
            sql`${receivables.status} <> 'cancelada'`,
          ));
        const recIds = new Set<string>();
        const recDocs = new Set<string>();
        for (const r of recMonth) {
          if (r.customerId) recIds.add(String(r.customerId));
          const d = String(r.customerDocument || '').replace(/\D/g, '');
          if (d.length >= 11) recDocs.add(d);
        }
        for (const c of customersData) {
          const byPipeline = (currentMonthMap.get(c.id) || 0) > 0;
          const byRecId = recIds.has(String(c.id));
          const doc = String((c as any).cnpj || '').replace(/\D/g, '') || String((c as any).cpf || '').replace(/\D/g, '');
          const byRecDoc = doc.length >= 11 && recDocs.has(doc);
          positivationMap.set(c.id, byPipeline || byRecId || byRecDoc);
        }
      } catch (e: any) { console.warn('positivação (receivables) falhou:', e?.message); }

      // MÉDIA de vendas dos ÚLTIMOS 3 MESES (por cliente) — inclui faturas do 1.0.
      // Fonte: receivables (1 recebível por faturamento → sem dupla contagem; sincronizado do 1.0 + nativo do 2.0).
      try {
        const threeStart = nowBrazil(); threeStart.setMonth(threeStart.getMonth() - 3); threeStart.setHours(0, 0, 0, 0);
        const rec3 = await db
          .select({ customerId: receivables.customerId, customerDocument: receivables.customerDocument, amount: receivables.amount })
          .from(receivables)
          .where(and(
            gte(receivables.issueDate, threeStart),
            sql`${receivables.amount}::numeric > 0`,
            sql`${receivables.status} <> 'cancelada'`,
          ));
        const docToId = new Map<string, string>();
        const idSet = new Set<string>();
        for (const c of customersData) {
          idSet.add(String(c.id));
          const d = String((c as any).cnpj || '').replace(/\D/g, '') || String((c as any).cpf || '').replace(/\D/g, '');
          if (d.length >= 11 && !docToId.has(d)) docToId.set(d, c.id);
        }
        const sum3 = new Map<string, number>();
        for (const r of rec3) {
          let key: string | null = null;
          if (r.customerId && idSet.has(String(r.customerId))) key = String(r.customerId);
          else { const d = String(r.customerDocument || '').replace(/\D/g, ''); if (d.length >= 11 && docToId.has(d)) key = docToId.get(d)!; }
          if (key) sum3.set(key, (sum3.get(key) || 0) + Number(r.amount || 0));
        }
        for (const [id, total] of sum3) avg3mMap.set(id, total / 3);
      } catch (e: any) { console.warn('média 3 meses (receivables) falhou:', e?.message); }
          }
        } catch (err) {
          console.warn('Erro ao buscar clientes, continuando sem eles:', err);
        }
      }
      
      // Buscar próximas 3 visitas para cada cliente
      const visitMap = new Map<string, Array<{ date: string; status: string }>>();
      try {
        if (customerIds.length > 0) {
          console.log('🔍 DEBUG: Buscando visitas para', customerIds.length, 'clientes, data:', today);
          
          // Buscar TODAS as visitas futuras (sem limit global que prejudica clientes no final)
          const upcomingVisits = await db.select({
            customerId: visitAgenda.customerId,
            scheduledDate: visitAgenda.scheduledDate,
            visitStatus: visitAgenda.visitStatus,
            isVirtual: visitAgenda.isVirtual
          }).from(visitAgenda)
            .where(and(
              inArray(visitAgenda.customerId, customerIds),
              gte(visitAgenda.scheduledDate, today)
            ))
            .orderBy(asc(visitAgenda.scheduledDate));
          
          console.log('📊 DEBUG: Encontradas', upcomingVisits.length, 'visitas futuras');
          
          // Agrupar por cliente e manter apenas 3 primeiras visitas de cada
          for (const visit of upcomingVisits) {
            if (!visitMap.has(visit.customerId)) {
              visitMap.set(visit.customerId, []);
            }
            const visits = visitMap.get(visit.customerId)!;
            if (visits.length < 3) {
              // Extrair data SEM converter para UTC (usar apenas a data do banco)
              const visitDate = new Date(visit.scheduledDate);
              const year = visitDate.getFullYear();
              const month = String(visitDate.getMonth() + 1).padStart(2, '0');
              const day = String(visitDate.getDate()).padStart(2, '0');
              const dateStr = `${year}-${month}-${day}`;
              visits.push({ date: dateStr, status: visit.visitStatus || 'pending' });
              console.log(`  ✅ Visita adicionada para ${visit.customerId}: ${dateStr}`);
            }
          }
          
          console.log('📍 DEBUG: visitMap tem', visitMap.size, 'clientes com visitas');
          
          // Debug TUTTO PANE
          for (const [custId, visits] of visitMap) {
            const cust = customerMap.get(custId);
            if (cust && (cust.fantasyName?.includes('TUTTO') || cust.name?.includes('TUTTO'))) {
              console.log(`🎯 TUTTO PANE (${custId}): ${visits.length} visitas:`, visits);
            }
          }
        }
      } catch (err) {
        console.error('❌ Erro ao buscar próximas visitas:', err);
      }
      
      // Fallback por DOCUMENTO p/ linhas cujo customerId nao resolve no 2.0 (conflito de identidade 1.0/2.0)
      const _digits = (x: any) => String(x || '').replace(/\D/g, '');
      const customerByDoc = new Map<string, any>();
      try {
        const _unresolved = active.filter((ac) => (!ac.customerId || !customerMap.has(ac.customerId)) && (ac as any).document);
        if (_unresolved.length > 0) {
          const _allUsers = await db.select().from(users);
          const _uById = new Map<string, any>(); const _uByCode = new Map<string, any>();
          const _nm = (u: any) => ((`${u.firstName || ''} ${u.lastName || ''}`.trim()) || (u.email ? String(u.email).split('@')[0] : '') || undefined);
          for (const u of _allUsers) { _uById.set(u.id, u); if ((u as any).omieVendorCode) _uByCode.set(String((u as any).omieVendorCode), u); }
          const _resolveSeller = (sid: any) => { if (!sid) return undefined; const str = String(sid); const u = _uById.get(str) || _uByCode.get(str) || _uByCode.get(str.replace('omie-vendor-', '')); return u ? _nm(u) : undefined; };
          const _allCusts = await db.select().from(customers);
          for (const c of _allCusts) { const d = _digits((c as any).cnpj) || _digits((c as any).cpf); if (d && d.length >= 11 && !customerByDoc.has(d)) customerByDoc.set(d, { ...c, sellerName: c.sellerId ? _resolveSeller(c.sellerId) : undefined }); }
        }
      } catch (e) { /* fallback best-effort */ }

      // Buscar visitas tambem para clientes resolvidos por DOCUMENTO (id diferente de ac.customerId)
      try {
        const effIds = new Set<string>();
        for (const ac of active) {
          let cust = ac.customerId ? customerMap.get(ac.customerId) : undefined;
          if (!cust && (ac as any).document) cust = customerByDoc.get(_digits((ac as any).document));
          const eid = (cust as any)?.id || ac.customerId;
          if (eid && !visitMap.has(eid)) effIds.add(eid);
        }
        if (effIds.size > 0) {
          const extra = await db.select({ customerId: visitAgenda.customerId, scheduledDate: visitAgenda.scheduledDate, visitStatus: visitAgenda.visitStatus })
            .from(visitAgenda)
            .where(and(inArray(visitAgenda.customerId, Array.from(effIds)), gte(visitAgenda.scheduledDate, today)))
            .orderBy(asc(visitAgenda.scheduledDate));
          for (const visit of extra) {
            if (!visitMap.has(visit.customerId)) visitMap.set(visit.customerId, []);
            const vs = visitMap.get(visit.customerId)!;
            if (vs.length < 3) { const d = new Date(visit.scheduledDate); const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; vs.push({ date: ds, status: visit.visitStatus || 'pending' }); }
          }
        }
      } catch (e) { /* best-effort */ }

      // Retornar dados com clientes disponíveis
      const result: ActiveCustomerWithVisits[] = active.map((ac) => {
        let customer = ac.customerId ? customerMap.get(ac.customerId) : undefined;
        if (!customer && (ac as any).document) customer = customerByDoc.get(_digits((ac as any).document));
        const _effId = (customer as any)?.id || ac.customerId;
        const visits = _effId ? (visitMap.get(_effId) || []) : [];
        
        // Adicionar dados de positivação e última atividade
        const isPositivated = ac.customerId ? (positivationMap.get(ac.customerId) || false) : false;
        const lastActivity = ac.customerId ? lastActivityMap.get(ac.customerId) : undefined;
        const monthlyTotals = ac.customerId ? monthlyTotalsMap.get(ac.customerId) : undefined;
        
        // Debug TUTTO PANE final
        if (customer && (customer.fantasyName?.includes('TUTTO') || customer.name?.includes('TUTTO'))) {
          console.log(`🎯 TUTTO PANE final: ${visits.length} visitas, periodicity=${customer.visitPeriodicity}`);
        }
        
        return {
          ...ac,
          customer: customer ? {
            ...customer,
            // Fallback: se omieInstanceId nulo, usar instância padrão (todos os clientes ativos pertencem a alguma instância)
            omieInstanceId: customer.omieInstanceId || ac.omieInstanceId || defaultOmieInstanceId,
            isPositivatedThisMonth: isPositivated,
            lastActivityDate: lastActivity?.toISOString() || null
          } : undefined,
          lastTwoVisits: [],
          nextThreeVisits: visits,
          previousMonthTotal: monthlyTotals?.previousMonth || 0,
          currentMonthTotal: monthlyTotals?.currentMonth || 0,
          last3MonthsAvg: _effId ? (avg3mMap.get(String(_effId)) || 0) : 0
        };
      });
      
      return result;
    } catch (error) {
      console.error('Erro em getActiveCustomersWithVisits:', error);
      return [];
    }
  }
  
  async getActiveCustomer(id: string): Promise<ActiveCustomer | undefined> {
    const [ac] = await db.select().from(activeCustomers).where(eq(activeCustomers.id, id));
    return ac;
  }
  
  async getActiveCustomerByDocument(document: string): Promise<ActiveCustomer | undefined> {
    const normalizedDoc = document.replace(/\D/g, '');
    const [ac] = await db.select().from(activeCustomers).where(eq(activeCustomers.document, normalizedDoc));
    return ac;
  }
  
  async getActiveCustomerByDocumentAndInstance(document: string, omieInstanceId: string | null): Promise<ActiveCustomer | undefined> {
    const normalizedDoc = document.replace(/\D/g, '');
    // Multi-tenant: buscar por documento E instância Omie
    if (omieInstanceId) {
      const [ac] = await db.select().from(activeCustomers).where(
        and(
          eq(activeCustomers.document, normalizedDoc),
          eq(activeCustomers.omieInstanceId, omieInstanceId)
        )
      );
      return ac;
    } else {
      // Se não tem instância, buscar por documento com instância null
      const [ac] = await db.select().from(activeCustomers).where(
        and(
          eq(activeCustomers.document, normalizedDoc),
          isNull(activeCustomers.omieInstanceId)
        )
      );
      return ac;
    }
  }
  
  async createActiveCustomer(customerData: InsertActiveCustomer): Promise<ActiveCustomer> {
    const [ac] = await db.insert(activeCustomers).values(customerData).returning();
    return ac;
  }
  
  async updateActiveCustomer(id: string, customerData: Partial<InsertActiveCustomer>): Promise<ActiveCustomer> {
    const [ac] = await db
      .update(activeCustomers)
      .set({ ...customerData, updatedAt: nowBrazil() })
      .where(eq(activeCustomers.id, id))
      .returning();
    return ac;
  }
  
  async deleteActiveCustomer(id: string): Promise<void> {
    await db.delete(activeCustomers).where(eq(activeCustomers.id, id));
  }
  
  async bulkUpsertActiveCustomers(customersList: InsertActiveCustomer[]): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;
    
    for (const cust of customersList) {
      const existing = await this.getActiveCustomerByDocument(cust.document);
      if (existing) {
        await db
          .update(activeCustomers)
          .set({
            ...cust,
            isActive: true,
            deactivatedAt: null,
            updatedAt: nowBrazil()
          })
          .where(eq(activeCustomers.id, existing.id));
        updated++;
      } else {
        await db.insert(activeCustomers).values(cust);
        added++;
      }
    }
    
    return { added, updated };
  }

  async correctInvalidVisitsForActiveCustomers(): Promise<{ corrected: number; generated: number }> {
    const WEEKDAY_MAP: Record<string, number> = {
      'Seg': 1, 'Ter': 2, 'Qua': 3, 'Qui': 4, 'Sex': 5, 'Sab': 6, 'Dom': 0
    };

    let corrected = 0;
    let generated = 0;

    try {
      const activeCustomersList = await db
        .select()
        .from(activeCustomers)
        .where(eq(activeCustomers.isActive, true));

      const today = nowBrazil();
      today.setHours(0, 0, 0, 0);

      for (const activeCustomer of activeCustomersList) {
        if (!activeCustomer.customerId) continue;

        const customer = await db
          .select()
          .from(customers)
          .where(eq(customers.id, activeCustomer.customerId))
          .then(rows => rows[0]);

        if (!customer || !customer.weekdays) continue;

        let weekdaysArray = [];
        try {
          weekdaysArray = typeof customer.weekdays === 'string' ? JSON.parse(customer.weekdays) : customer.weekdays || [];
        } catch (e) {
          continue;
        }

        if (weekdaysArray.length === 0) continue;

        // Buscar visitas futuras
        const futureVisits = await db
          .select()
          .from(visitAgenda)
          .where(
            and(
              eq(visitAgenda.customerId, activeCustomer.customerId),
              gte(visitAgenda.scheduledDate, today)
            )
          )
          .orderBy(asc(visitAgenda.scheduledDate));

        // Deletar visitas em dias ERRADOS
        for (const visit of futureVisits) {
          const visitDate = new Date(visit.scheduledDate);
          const dayOfWeek = visitDate.getDay();
          const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
          const dayName = dayNames[dayOfWeek];

          if (!weekdaysArray.includes(dayName)) {
            await db.delete(visitAgenda).where(eq(visitAgenda.id, visit.id));
            corrected++;
          }
        }

        // Verificar se precisa regenerar visitas
        const validFutureVisits = await db
          .select()
          .from(visitAgenda)
          .where(
            and(
              eq(visitAgenda.customerId, activeCustomer.customerId),
              gte(visitAgenda.scheduledDate, today)
            )
          );

        if (validFutureVisits.length < 3) {
          const visitsNeeded = 3 - validFutureVisits.length;
          
          let baseDate = today;
          if (validFutureVisits.length > 0) {
            const lastVisit = validFutureVisits[validFutureVisits.length - 1];
            baseDate = new Date(lastVisit.scheduledDate);
            baseDate.setDate(baseDate.getDate() + 1);
          }

          for (let i = 0; i < visitsNeeded; i++) {
            let currentDate = new Date(baseDate);
            let found = false;

            for (let attempt = 0; attempt < 14; attempt++) {
              const dayOfWeek = currentDate.getDay();
              const dayName = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'][dayOfWeek];

              if (weekdaysArray.includes(dayName)) {
                const exists = await db
                  .select()
                  .from(visitAgenda)
                  .where(
                    and(
                      eq(visitAgenda.customerId, activeCustomer.customerId),
                      gte(visitAgenda.scheduledDate, new Date(currentDate.toISOString().split('T')[0] + 'T00:00:00')),
                      lte(visitAgenda.scheduledDate, new Date(currentDate.toISOString().split('T')[0] + 'T23:59:59'))
                    )
                  )
                  .then(rows => rows.length > 0);

                if (!exists) {
                  await db.insert(visitAgenda).values({
                    customerId: activeCustomer.customerId,
                    sellerId: customer.sellerId,
                    scheduledDate: currentDate,
                    routeDay: dayName,
                    recurrenceType: customer.visitPeriodicity || 'semanal',
                    isVirtual: customer.virtualService || false,
                    visitStatus: 'pending',
                    customerName: customer.name,
                    customerLatitude: customer.latitude || null,
                    customerLongitude: customer.longitude || null,
                    customerAddress: customer.address || null,
                    createdAt: nowBrazil()
                  });
                  generated++;
                  baseDate = new Date(currentDate);
                  baseDate.setDate(baseDate.getDate() + 1);
                  found = true;
                  break;
                }
              }

              currentDate.setDate(currentDate.getDate() + 1);
            }

            if (!found) break;
          }
        }
      }

      console.log(`✅ [VISIT-CORRECTION] Visitas corrigidas: ${corrected}, regeneradas: ${generated}`);
      return { corrected, generated };
    } catch (error: any) {
      console.error(`❌ Erro ao corrigir visitas:`, error.message);
      return { corrected: 0, generated: 0 };
    }
  }
  
  async deactivateRemovedCustomers(uploadId: string, currentDocuments: string[], scopedInstanceIds?: string[]): Promise<number> {
    const notManual = or(isNull(activeCustomers.uploadId), ne(activeCustomers.uploadId, 'manual-add'));

    if (currentDocuments.length === 0) {
      // Deactivate all (or only scoped instances), but never manually-added customers
      let whereClause: any = and(
        eq(activeCustomers.isActive, true),
        notManual
      );
      if (scopedInstanceIds && scopedInstanceIds.length > 0) {
        whereClause = and(
          eq(activeCustomers.isActive, true),
          notManual,
          inArray(activeCustomers.omieInstanceId, scopedInstanceIds)
        );
      }
      const result = await db
        .update(activeCustomers)
        .set({ isActive: false, deactivatedAt: nowBrazil(), updatedAt: nowBrazil() })
        .where(whereClause)
        .returning();
      return result.length;
    }
    
    // Get all active within scope that are NOT in the current list
    let queryWhere: any = and(
      eq(activeCustomers.isActive, true),
      notManual // Nunca desativar clientes adicionados manualmente
    );
    if (scopedInstanceIds && scopedInstanceIds.length > 0) {
      // Only deactivate customers from the same instance(s) as the upload
      queryWhere = and(
        eq(activeCustomers.isActive, true),
        notManual,
        or(
          inArray(activeCustomers.omieInstanceId, scopedInstanceIds),
          isNull(activeCustomers.omieInstanceId)
        )
      );
    }
    
    const active = await db.select().from(activeCustomers).where(queryWhere);
    const toDeactivate = active.filter(a => !currentDocuments.includes(a.document));
    
    for (const ac of toDeactivate) {
      await db
        .update(activeCustomers)
        .set({ isActive: false, deactivatedAt: nowBrazil(), updatedAt: nowBrazil() })
        .where(eq(activeCustomers.id, ac.id));
    }
    
    return toDeactivate.length;
  }
  
  async getActiveCustomerUploads(): Promise<ActiveCustomerUpload[]> {
    return await db.select().from(activeCustomerUploads).orderBy(desc(activeCustomerUploads.uploadedAt));
  }
  
  async createActiveCustomerUpload(uploadData: InsertActiveCustomerUpload): Promise<ActiveCustomerUpload> {
    const [upload] = await db.insert(activeCustomerUploads).values(uploadData).returning();
    return upload;
  }

  async generateNextVisitsForActiveCustomers(): Promise<{ processed: number; generated: number; errors: number; corrected?: number }> {
    const WEEKDAY_MAP: Record<string, number> = {
      'Seg': 1, 'Segunda': 1, 'segunda': 1,
      'Ter': 2, 'Terça': 2, 'terça': 2,
      'Qua': 3, 'Quarta': 3, 'quarta': 3,
      'Qui': 4, 'Quinta': 4, 'quinta': 4,
      'Sex': 5, 'Sexta': 5, 'sexta': 5,
      'Sab': 6, 'Sábado': 6, 'sábado': 6,
      'Dom': 0, 'Domingo': 0, 'domingo': 0
    };

    const REVERSE_WEEKDAY_MAP: Record<number, string> = {
      0: 'Dom', 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sab'
    };

    try {
      // 1. Obter todos os clientes ativos
      const activeCustomersList = await db
        .select()
        .from(activeCustomers)
        .where(eq(activeCustomers.isActive, true));

      console.log(`📅 [VISIT-SCHEDULER] Processando ${activeCustomersList.length} clientes ativos`);

      let processed = 0;
      let skipped = 0;
      let generated = 0;
      let corrected = 0;
      let errors = 0;

      const today = nowBrazil();
      today.setHours(0, 0, 0, 0);

      for (const activeCustomer of activeCustomersList) {
        try {
          if (!activeCustomer.customerId) {
            skipped++;
            continue;
          }
          processed++;

          // 2. Obter dados do cliente
          const customer = await db
            .select()
            .from(customers)
            .where(eq(customers.id, activeCustomer.customerId))
            .then(rows => rows[0]);

          if (!customer) {
            console.warn(`⚠️ [VISIT-SCHEDULER] Cliente ${activeCustomer.customerId} não encontrado`);
            skipped++;
            continue;
          }

          if (!customer.weekdays) {
            console.warn(`⚠️ [VISIT-SCHEDULER] Cliente ${customer.id} sem weekdays configurados`);
            skipped++;
            continue;
          }

          // Parse weekdays
          let weekdaysArray = [];
          try {
            weekdaysArray = typeof customer.weekdays === 'string' ? JSON.parse(customer.weekdays) : customer.weekdays || [];
          } catch (e) {
            console.warn(`⚠️ [VISIT-SCHEDULER] Erro ao parsear weekdays para ${customer.id}:`, customer.weekdays);
            skipped++;
            continue;
          }

          // 3. AGRESSIVAMENTE: Deletar TODAS as próximas visitas futuras para este cliente
          // Isso força a regeneração completa quando o dia da rota muda
          const futureCutoff = new Date(today);
          futureCutoff.setDate(futureCutoff.getDate() + 90); // Próximos 90 dias

          // Deletar TODAS as visitas futuras (não apenas as em dias incorretos)
          const visitsToDelete = await db
            .select()
            .from(visitAgenda)
            .where(
              and(
                eq(visitAgenda.customerId, activeCustomer.customerId),
                gte(visitAgenda.scheduledDate, today)
              )
            );

          if (visitsToDelete.length > 0) {
            console.log(`🔧 [VISIT-SCHEDULER] ${customer.name}: Deletando ${visitsToDelete.length} visita(s) futuras para regeneração...`);
            await db
              .delete(visitAgenda)
              .where(
                and(
                  eq(visitAgenda.customerId, activeCustomer.customerId),
                  gte(visitAgenda.scheduledDate, today)
                )
              );
            corrected += visitsToDelete.length;
          }

          // Após deletar, contar visitas restantes (deve ser 0)
          const validFutureVisits = 0;

          console.log(`📊 [VISIT-SCHEDULER] Cliente ${customer.name}: ${validFutureVisits} visitas futuras válidas`);

          // 5. Se tiver menos de 3 visitas, gerar as que faltam
          if (validFutureVisits < 3) {
            const visitsNeeded = 3 - validFutureVisits;
            console.log(`📋 [VISIT-SCHEDULER] Gerando ${visitsNeeded} visita(s) para ${customer.name}`);
            const periodicity = customer.visitPeriodicity || 'semanal';

            let daysToAdd = 7;
            if (periodicity === 'quinzenal') daysToAdd = 14;
            else if (periodicity === 'mensal') daysToAdd = 30;

            // Buscar a ÚLTIMA VISITA FUTURA (não histórica) para manter sequência
            const lastFutureVisit = await db
              .select()
              .from(visitAgenda)
              .where(
                and(
                  eq(visitAgenda.customerId, activeCustomer.customerId),
                  gte(visitAgenda.scheduledDate, today)
                )
              )
              .orderBy(desc(visitAgenda.scheduledDate))
              .limit(1)
              .then(rows => rows[0]);

            // Começar a partir de HOJE, procurando o primeiro dia da semana válido
            let baseDate = new Date(today);
            if (lastFutureVisit) {
              baseDate = new Date(lastFutureVisit.scheduledDate);
              baseDate.setDate(baseDate.getDate() + daysToAdd);
            }

            // Gerar as 3 próximas visitas
            for (let i = 0; i < visitsNeeded; i++) {
              let currentDate = new Date(baseDate);
              let attempts = 0;
              const maxAttempts = 14; // Aumentado para 14 dias (2 semanas) para garantir encontrar o dia

              // Procurar o próximo dia válido dentro dos próximos dias
              while (attempts < maxAttempts) {
                const dayOfWeek = currentDate.getDay();
                const dayName = Object.keys(WEEKDAY_MAP).find(key => WEEKDAY_MAP[key] === dayOfWeek);

                if (dayName && weekdaysArray.includes(dayName)) {
                  console.log(`🔍 [VISIT-SCHEDULER] ${customer.name}: Tentativa ${attempts + 1}, verificando ${dayName} em ${currentDate.toISOString().split('T')[0]}`);
                  // Verificar se já existe visita nesse dia
                  const dateStr = currentDate.toISOString().split('T')[0];
                  const dateStart = new Date(dateStr + 'T00:00:00');
                  const dateEnd = new Date(dateStr + 'T23:59:59');
                  
                  const exists = await db
                    .select()
                    .from(visitAgenda)
                    .where(
                      and(
                        eq(visitAgenda.customerId, activeCustomer.customerId),
                        gte(visitAgenda.scheduledDate, dateStart),
                        lte(visitAgenda.scheduledDate, dateEnd)
                      )
                    )
                    .then(rows => rows.length > 0);

                  if (!exists) {
                    console.log(`✅ [VISIT-SCHEDULER] Gerando visita para ${customer.name} em ${currentDate.toISOString().split('T')[0]}`);
                    // Criar visita
                    await db.insert(visitAgenda).values({
                      customerId: activeCustomer.customerId,
                      sellerId: customer.sellerId,
                      scheduledDate: currentDate,
                      routeDay: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'][currentDate.getDay()],
                      recurrenceType: customer.visitPeriodicity || 'semanal',
                      isVirtual: customer.virtualService || false,
                      visitStatus: 'pending',
                      customerName: customer.name,
                      customerLatitude: customer.latitude || null,
                      customerLongitude: customer.longitude || null,
                      customerAddress: customer.address || null,
                      createdAt: nowBrazil()
                    });
                    generated++;
                    break;
                  }
                }

                currentDate.setDate(currentDate.getDate() + 1);
                attempts++;
              }

              // Próxima iteração começa a partir da data atual + dias
              baseDate = new Date(currentDate);
              baseDate.setDate(baseDate.getDate() + daysToAdd);
            }
          }
        } catch (error: any) {
          console.error(`❌ Erro ao processar cliente ${activeCustomer.id}:`, error.message);
          errors++;
        }
      }

      console.log(`✅ [VISIT-SCHEDULER] Processamento concluído:`);
      console.log(`   - ${processed} processados`);
      console.log(`   - ${corrected} visita(s) corrigida(s) (dias incorretos removidos)`);
      console.log(`   - ${generated} visitas geradas`);
      console.log(`   - ${skipped} pulados (sem customer_id ou weekdays)`);
      console.log(`   - ${errors} erros`);
      return { processed, generated, errors, corrected };
    } catch (error: any) {
      console.error(`❌ [VISIT-SCHEDULER] Erro crítico:`, error.message);
      return { processed: 0, generated: 0, errors: 1 };
    }
  }
  
  async updateActiveCustomerUpload(id: string, uploadData: Partial<InsertActiveCustomerUpload>): Promise<ActiveCustomerUpload> {
    const [upload] = await db
      .update(activeCustomerUploads)
      .set(uploadData)
      .where(eq(activeCustomerUploads.id, id))
      .returning();
    return upload;
  }
  
  async getCustomerByDocument(document: string): Promise<Customer | undefined> {
    const normalizedDoc = document.replace(/\D/g, '');
    // Try CPF first
    let [customer] = await db.select().from(customers).where(eq(customers.cpf, normalizedDoc));
    if (customer) return customer;
    
    // Try CNPJ
    [customer] = await db.select().from(customers).where(eq(customers.cnpj, normalizedDoc));
    return customer;
  }
  
  async getCustomerByPhone(phone: string): Promise<CustomerWithSeller | undefined> {
    // Casa o telefone pelos ÚLTIMOS 8 DÍGITOS (robusto a DDI 55 e ao 9º dígito) e
    // resolve o vendedor pelos dois critérios: users.id = seller_id OU omie_vendor_code = seller_id.
    const cleanPhone = (phone || '').replace(/\D/g, '');
    if (cleanPhone.length < 8) return undefined;
    const last8 = cleanPhone.slice(-8);
    const [row] = await db
      .select()
      .from(customers)
      .leftJoin(users, or(eq(users.id, customers.sellerId), eq(users.omieVendorCode, customers.sellerId)))
      .where(sql`RIGHT(REGEXP_REPLACE(${customers.phone}, '\\D', '', 'g'), 8) = ${last8}`)
      .limit(1);
    if (!row || !row.customers) return undefined;
    return { ...row.customers, seller: (row.users as any) || null } as any;
  }
  
  async isCustomerInActiveList(customerId: string): Promise<boolean> {
    const [ac] = await db
      .select()
      .from(activeCustomers)
      .where(and(
        eq(activeCustomers.customerId, customerId),
        eq(activeCustomers.isActive, true)
      ));
    return !!ac;
  }

  // ============================================================================
  // CHATGPT ATENDIMENTO AUTOMÁTICO - STORAGE
  // ============================================================================

  async getChatAiSettings(): Promise<ChatAiSettings | null> {
    const [settings] = await db.select().from(chatAiSettings).limit(1);
    return settings || null;
  }

  async upsertChatAiSettings(data: InsertChatAiSettings): Promise<ChatAiSettings> {
    const existing = await this.getChatAiSettings();
    
    if (existing) {
      const [updated] = await db
        .update(chatAiSettings)
        .set({ ...data, updatedAt: nowBrazil() })
        .where(eq(chatAiSettings.id, existing.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(chatAiSettings)
        .values(data)
        .returning();
      return created;
    }
  }

  async updateChatAiSettings(settings: Partial<InsertChatAiSettings>): Promise<ChatAiSettings> {
    const existing = await this.getChatAiSettings();
    
    if (existing) {
      const [updated] = await db
        .update(chatAiSettings)
        .set({ ...settings, updatedAt: nowBrazil() })
        .where(eq(chatAiSettings.id, existing.id))
        .returning();
      return updated;
    } else {
      // Se não existir, criar com os dados fornecidos
      const [created] = await db
        .insert(chatAiSettings)
        .values(settings as InsertChatAiSettings)
        .returning();
      return created;
    }
  }

  async createChatAiLog(logData: InsertChatAiLog): Promise<ChatAiLog> {
    const [log] = await db
      .insert(chatAiLogs)
      .values(logData)
      .returning();
    return log;
  }

  async getChatAiLogs(conversationId?: string, limit: number = 50): Promise<ChatAiLog[]> {
    if (conversationId) {
      return await db
        .select()
        .from(chatAiLogs)
        .where(eq(chatAiLogs.conversationId, conversationId))
        .orderBy(desc(chatAiLogs.createdAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(chatAiLogs)
      .orderBy(desc(chatAiLogs.createdAt))
      .limit(limit);
  }

  async getConversationsAwaitingResponse(timeoutMinutes: number): Promise<ChatConversation[]> {
    const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    
    const conversations = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          sql`${chatConversations.status} IN ('new', 'assigned', 'in-progress')`,
          sql`${chatConversations.lastMessageTime} < ${cutoffTime}`
        )
      );
    
    return conversations;
  }

  async getLastHumanResponseTime(conversationId: string): Promise<Date | null> {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          eq(chatMessages.senderType, 'agent'),
          sql`${chatMessages.senderId} != 'system'`,
          sql`${chatMessages.senderId} != 'bot'`
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);
    
    return messages[0]?.createdAt || null;
  }

  async getLastBotResponseTime(conversationId: string): Promise<Date | null> {
    const messages = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          sql`${chatMessages.senderId} = 'bot'`
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);
    
    return messages[0]?.createdAt || null;
  }

  async getPhoneMappingBySource(sourcePhone: string): Promise<{ canonicalPhone: string; alternativePhone: string } | undefined> {
    // Normalizar o telefone de origem
    const cleanPhone = sourcePhone.replace(/\D/g, '');
    console.log(`🔍 [getPhoneMappingBySource] Buscando mapeamento para: ${cleanPhone}`);
    
    try {
      // Buscar mapeamento onde o telefone alternativo corresponde EXATAMENTE
      // (sem LIKE para evitar falsos positivos)
      const [mapping] = await db.select()
        .from(phoneNumberMappings)
        .where(
          and(
            eq(phoneNumberMappings.isActive, true),
            or(
              eq(phoneNumberMappings.alternativePhone, cleanPhone),
              eq(phoneNumberMappings.alternativePhone, `55${cleanPhone}`)
            )
          )
        )
        .limit(1);
      
      if (mapping) {
        console.log(`✅ [getPhoneMappingBySource] Mapeamento encontrado: ${cleanPhone} -> ${mapping.canonicalPhone}`);
        return { 
          canonicalPhone: mapping.canonicalPhone, 
          alternativePhone: mapping.alternativePhone 
        };
      }
      
      console.log(`❌ [getPhoneMappingBySource] Nenhum mapeamento encontrado para: ${cleanPhone}`);
      return undefined;
    } catch (err) {
      console.error(`⚠️ [getPhoneMappingBySource] Erro ao buscar mapeamento:`, err);
      return undefined;
    }
  }

  // Phonebook contacts operations
  async getPhonebookContacts(filters?: { search?: string; customerId?: string }): Promise<PhonebookContact[]> {
    let query = db.select().from(phonebookContacts);
    
    const conditions: any[] = [];
    
    if (filters?.search) {
      const searchPattern = `%${filters.search}%`;
      conditions.push(
        or(
          like(phonebookContacts.name, searchPattern),
          like(phonebookContacts.phone, searchPattern)
        )
      );
    }
    
    if (filters?.customerId) {
      conditions.push(eq(phonebookContacts.customerId, filters.customerId));
    }
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }
    
    return await (query.orderBy(asc(phonebookContacts.name)) as any);
  }

  async getPhonebookContact(id: string): Promise<PhonebookContact | undefined> {
    const [contact] = await db.select().from(phonebookContacts).where(eq(phonebookContacts.id, id));
    return contact;
  }

  async getPhonebookContactByPhone(phone: string): Promise<PhonebookContact | undefined> {
    const cleanPhone = phone.replace(/\D/g, '');
    // 1) match exato por substring (comportamento original)
    const [contact] = await db.select().from(phonebookContacts)
      .where(like(phonebookContacts.phone, `%${cleanPhone}%`));
    if (contact) return contact;
    // 2) fallback FLEXIVEL: casa por DDD + ultimos 8 digitos, ignorando o 9o digito (com/sem).
    //    So retorna se houver UM UNICO contato com esse DDD+8 (evita casar DDD/pessoa errada).
    const local = cleanPhone.startsWith('55') ? cleanPhone.slice(2) : cleanPhone; // DD + [9] + 8
    if (local.length >= 10) {
      const dd = local.slice(0, 2);
      const last8 = local.slice(-8);
      const cands = await db.select().from(phonebookContacts)
        .where(like(phonebookContacts.phone, `%${last8}`));
      const matches = (cands || []).filter((c: any) => {
        const cl = String(c.phone || '').replace(/\D/g, '');
        const loc = cl.startsWith('55') ? cl.slice(2) : cl;
        return loc.length >= 10 && loc.slice(0, 2) === dd && loc.slice(-8) === last8;
      });
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  async createPhonebookContact(contact: InsertPhonebookContact): Promise<PhonebookContact> {
    const [newContact] = await db.insert(phonebookContacts).values(contact).returning();
    return newContact;
  }

  async updatePhonebookContact(id: string, contact: Partial<InsertPhonebookContact>): Promise<PhonebookContact> {
    const [updated] = await db
      .update(phonebookContacts)
      .set({ ...contact, updatedAt: nowBrazil() })
      .where(eq(phonebookContacts.id, id))
      .returning();
    return updated;
  }

  async deletePhonebookContact(id: string): Promise<void> {
    await db.delete(phonebookContacts).where(eq(phonebookContacts.id, id));
  }

  async upsertPhonebookContactByPhone(contact: InsertPhonebookContact): Promise<PhonebookContact> {
    const cleanPhone = contact.phone.replace(/\D/g, '');
    const existing = await this.getPhonebookContactByPhone(cleanPhone);
    
    if (existing) {
      return await this.updatePhonebookContact(existing.id, {
        name: contact.name,
        customerId: contact.customerId,
        notes: contact.notes,
      });
    } else {
      return await this.createPhonebookContact(contact);
    }
  }

  async syncActiveCustomersToPhonebook(): Promise<{ synced: number; errors: number }> {
    const activeCustomers = await db.select().from(customers).where(eq(customers.isActive, true));
    let synced = 0;
    let errors = 0;

    for (const customer of activeCustomers) {
      try {
        if (!customer.phone) continue;
        
        const cleanPhone = customer.phone.replace(/\D/g, '');
        const normalizedPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
        const displayName = customer.fantasyName || customer.name;
        
        await this.upsertPhonebookContactByPhone({
          name: displayName,
          phone: normalizedPhone,
          customerId: customer.id,
          notes: `Cliente ativo - ${customer.customerType === 'pj' ? 'PJ' : 'PF'}`,
        });
        synced++;
      } catch (err) {
        console.error(`[SYNC-PHONEBOOK] Erro ao sincronizar cliente ${customer.id}:`, err);
        errors++;
      }
    }

    console.log(`✅ [SYNC-PHONEBOOK] Sincronizados ${synced} clientes para agenda (${errors} erros)`);
    return { synced, errors };
  }

  // Virtual Attendance Stats operations
  async logVirtualAttendance(conversationId: string, agentId: string, serviceDate: Date): Promise<void> {
    const formattedDate = serviceDate.toISOString().split('T')[0];
    
    try {
      await db.insert(virtualAttendanceStats).values({
        conversationId,
        agentId,
        serviceDate: formattedDate,
      }).onConflictDoNothing();
    } catch (error) {
      console.error('[STORAGE] Error logging virtual attendance:', error);
    }
  }
  
  async getVirtualAttendanceSummary(filters: { startDate: Date; endDate: Date; agentId?: string }): Promise<Array<{
    agentId: string;
    agentName: string;
    serviceDate: string;
    conversationCount: number;
  }>> {
    const startDateStr = filters.startDate.toISOString().split('T')[0];
    const endDateStr = filters.endDate.toISOString().split('T')[0];
    
    const conditions = [
      gte(virtualAttendanceStats.serviceDate, startDateStr),
      lte(virtualAttendanceStats.serviceDate, endDateStr),
    ];
    
    if (filters.agentId) {
      conditions.push(eq(virtualAttendanceStats.agentId, filters.agentId));
    }
    
    const results = await db
      .select({
        agentId: virtualAttendanceStats.agentId,
        serviceDate: virtualAttendanceStats.serviceDate,
        conversationCount: sql<number>`count(*)::int`,
      })
      .from(virtualAttendanceStats)
      .where(and(...conditions))
      .groupBy(virtualAttendanceStats.agentId, virtualAttendanceStats.serviceDate)
      .orderBy(desc(virtualAttendanceStats.serviceDate), asc(virtualAttendanceStats.agentId));
    
    // Get agent names
    const agentIds = [...new Set(results.map(r => r.agentId))];
    const agents = agentIds.length > 0 
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, agentIds))
      : [];
    
    const agentNameMap = new Map(agents.map(a => [a.id, a.name]));
    
    return results.map(r => ({
      agentId: r.agentId,
      agentName: agentNameMap.get(r.agentId) || 'Desconhecido',
      serviceDate: r.serviceDate,
      conversationCount: r.conversationCount,
    }));
  }

  // Omie Instances operations (multi-tenant)
  async getOmieInstances(): Promise<OmieInstance[]> {
    return await db.select().from(omieInstances).orderBy(omieInstances.name);
  }

  async getOmieInstance(id: string): Promise<OmieInstance | undefined> {
    const [instance] = await db.select().from(omieInstances).where(eq(omieInstances.id, id));
    return instance;
  }

  async getOmieInstanceByName(name: string): Promise<OmieInstance | undefined> {
    const [instance] = await db.select().from(omieInstances).where(eq(omieInstances.name, name));
    return instance;
  }

  async getDefaultOmieInstance(): Promise<OmieInstance | undefined> {
    const [instance] = await db.select().from(omieInstances).where(eq(omieInstances.isDefault, true));
    return instance;
  }

  async createOmieInstance(data: InsertOmieInstance): Promise<OmieInstance> {
    const [instance] = await db.insert(omieInstances).values(data).returning();
    return instance;
  }

  async updateOmieInstance(id: string, data: Partial<InsertOmieInstance>): Promise<OmieInstance> {
    const [instance] = await db
      .update(omieInstances)
      .set({ ...data, updatedAt: nowBrazil() })
      .where(eq(omieInstances.id, id))
      .returning();
    return instance;
  }

  async deleteOmieInstance(id: string): Promise<void> {
    await db.delete(omieInstances).where(eq(omieInstances.id, id));
  }

  async setDefaultOmieInstance(id: string): Promise<OmieInstance> {
    // Remove default flag from all instances
    await db.update(omieInstances).set({ isDefault: false });
    // Set the new default
    const [instance] = await db
      .update(omieInstances)
      .set({ isDefault: true, updatedAt: nowBrazil() })
      .where(eq(omieInstances.id, id))
      .returning();
    return instance;
  }

  // ============================================================================
  // FISCAL SCENARIOS
  // ============================================================================

  async getFiscalScenarios(): Promise<FiscalScenario[]> {
    return db.select().from(fiscalScenarios).orderBy(asc(fiscalScenarios.name));
  }

  async getFiscalScenario(id: string): Promise<FiscalScenario | undefined> {
    const [scenario] = await db.select().from(fiscalScenarios).where(eq(fiscalScenarios.id, id));
    return scenario;
  }

  async createFiscalScenario(data: InsertFiscalScenario): Promise<FiscalScenario> {
    const [scenario] = await db.insert(fiscalScenarios).values(data).returning();
    return scenario;
  }

  async updateFiscalScenario(id: string, data: Partial<InsertFiscalScenario>): Promise<FiscalScenario> {
    const [scenario] = await db.update(fiscalScenarios)
      .set({ ...data, updatedAt: nowBrazil() })
      .where(eq(fiscalScenarios.id, id))
      .returning();
    return scenario;
  }

  async deleteFiscalScenario(id: string): Promise<void> {
    await db.delete(fiscalScenarios).where(eq(fiscalScenarios.id, id));
  }

  // ============================================================================
  // DIGITAL CERTIFICATES
  // ============================================================================

  async getDigitalCertificates(): Promise<DigitalCertificate[]> {
    return db.select().from(digitalCertificates).orderBy(desc(digitalCertificates.createdAt));
  }

  async getDigitalCertificate(id: string): Promise<DigitalCertificate | undefined> {
    const [cert] = await db.select().from(digitalCertificates).where(eq(digitalCertificates.id, id));
    return cert;
  }

  async createDigitalCertificate(data: InsertDigitalCertificate): Promise<DigitalCertificate> {
    const [cert] = await db.insert(digitalCertificates).values(data).returning();
    return cert;
  }

  async updateDigitalCertificate(id: string, data: Partial<InsertDigitalCertificate>): Promise<DigitalCertificate> {
    const [cert] = await db.update(digitalCertificates)
      .set({ ...data, updatedAt: nowBrazil() })
      .where(eq(digitalCertificates.id, id))
      .returning();
    return cert;
  }

  async deleteDigitalCertificate(id: string): Promise<void> {
    await db.delete(digitalCertificates).where(eq(digitalCertificates.id, id));
  }

  // ============================================================================
  // FISCAL INVOICES
  // ============================================================================

  async getFiscalInvoices(filters?: { status?: string; customerId?: string; environment?: string }): Promise<FiscalInvoice[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(fiscalInvoices.status, filters.status));
    if (filters?.customerId) conditions.push(eq(fiscalInvoices.customerId, filters.customerId));
    if (filters?.environment) conditions.push(eq(fiscalInvoices.environment, filters.environment));

    if (conditions.length > 0) {
      return db.select().from(fiscalInvoices)
        .where(and(...conditions))
        .orderBy(desc(fiscalInvoices.createdAt));
    }
    return db.select().from(fiscalInvoices).orderBy(desc(fiscalInvoices.createdAt));
  }

  async getFiscalInvoice(id: string): Promise<FiscalInvoice | undefined> {
    const [invoice] = await db.select().from(fiscalInvoices).where(eq(fiscalInvoices.id, id));
    return invoice;
  }

  async getNextInvoiceNumber(series: string = '1', issuerCnpj?: string): Promise<number> {
    // Numeracao de NF-e por CNPJ EMITENTE + serie: cada CNPJ tem sequencia SEFAZ propria.
    // Base = notas de PRODUCAO desse CNPJ (ignora rascunhos/homologacao). Normaliza o CNPJ (so digitos),
    // pois ele e gravado em 2 formatos (com mascara e so digitos).
    if (issuerCnpj && issuerCnpj.replace(/\D/g, '').length >= 11) {
      const digits = issuerCnpj.replace(/\D/g, '');
      const prod: any = await db.execute(sql`
        SELECT COALESCE(MAX(invoice_number), 0) AS max_num
        FROM fiscal_invoices
        WHERE series = ${series}
          AND environment = 'producao'
          AND regexp_replace(COALESCE(issuer_cnpj, ''), '[^0-9]', '', 'g') = ${digits}`);
      let maxNum = Number(prod?.rows?.[0]?.max_num || 0);
      if (!maxNum) {
        const anyEnv: any = await db.execute(sql`
          SELECT COALESCE(MAX(invoice_number), 0) AS max_num
          FROM fiscal_invoices
          WHERE series = ${series}
            AND regexp_replace(COALESCE(issuer_cnpj, ''), '[^0-9]', '', 'g') = ${digits}`);
        maxNum = Number(anyEnv?.rows?.[0]?.max_num || 0);
      }
      return maxNum + 1;
    }
    // Fallback legado (sem CNPJ): numera por serie (comportamento antigo).
    const result = await db.select({ maxNum: sql<number>`COALESCE(MAX(invoice_number), 0)` })
      .from(fiscalInvoices)
      .where(eq(fiscalInvoices.series, series));
    return (result[0]?.maxNum || 0) + 1;
  }

  async createFiscalInvoice(data: InsertFiscalInvoice): Promise<FiscalInvoice> {
    const [invoice] = await db.insert(fiscalInvoices).values(data).returning();
    return invoice;
  }

  async updateFiscalInvoice(id: string, data: Partial<InsertFiscalInvoice>): Promise<FiscalInvoice> {
    const [invoice] = await db.update(fiscalInvoices)
      .set({ ...data, updatedAt: nowBrazil() })
      .where(eq(fiscalInvoices.id, id))
      .returning();
    return invoice;
  }

  async deleteFiscalInvoice(id: string): Promise<void> {
    await db.delete(fiscalInvoiceItems).where(eq(fiscalInvoiceItems.invoiceId, id));
    await db.delete(fiscalInvoiceEvents).where(eq(fiscalInvoiceEvents.invoiceId, id));
    await db.delete(fiscalInvoices).where(eq(fiscalInvoices.id, id));
  }

  // ============================================================================
  // FISCAL INVOICE ITEMS
  // ============================================================================

  async getFiscalInvoiceItems(invoiceId: string): Promise<FiscalInvoiceItem[]> {
    return db.select().from(fiscalInvoiceItems)
      .where(eq(fiscalInvoiceItems.invoiceId, invoiceId))
      .orderBy(asc(fiscalInvoiceItems.itemNumber));
  }

  async createFiscalInvoiceItem(data: InsertFiscalInvoiceItem): Promise<FiscalInvoiceItem> {
    const [item] = await db.insert(fiscalInvoiceItems).values(data).returning();
    return item;
  }

  async updateFiscalInvoiceItem(id: string, data: Partial<InsertFiscalInvoiceItem>): Promise<FiscalInvoiceItem> {
    const [item] = await db.update(fiscalInvoiceItems)
      .set(data)
      .where(eq(fiscalInvoiceItems.id, id))
      .returning();
    return item;
  }

  async deleteFiscalInvoiceItem(id: string): Promise<void> {
    await db.delete(fiscalInvoiceItems).where(eq(fiscalInvoiceItems.id, id));
  }

  async deleteFiscalInvoiceItems(invoiceId: string): Promise<void> {
    await db.delete(fiscalInvoiceItems).where(eq(fiscalInvoiceItems.invoiceId, invoiceId));
  }

  // ============================================================================
  // FISCAL INVOICE EVENTS
  // ============================================================================

  async getFiscalInvoiceEvents(invoiceId: string): Promise<FiscalInvoiceEvent[]> {
    return db.select().from(fiscalInvoiceEvents)
      .where(eq(fiscalInvoiceEvents.invoiceId, invoiceId))
      .orderBy(desc(fiscalInvoiceEvents.createdAt));
  }

  async createFiscalInvoiceEvent(data: InsertFiscalInvoiceEvent): Promise<FiscalInvoiceEvent> {
    const [event] = await db.insert(fiscalInvoiceEvents).values(data).returning();
    return event;
  }

  // ============================================================================
  // FISCAL BACKUPS
  // ============================================================================

  async getFiscalBackups(filters?: { backupType?: string; referenceId?: string }): Promise<FiscalBackup[]> {
    const conditions = [];
    if (filters?.backupType) conditions.push(eq(fiscalBackups.backupType, filters.backupType));
    if (filters?.referenceId) conditions.push(eq(fiscalBackups.referenceId, filters.referenceId));

    if (conditions.length > 0) {
      return db.select().from(fiscalBackups)
        .where(and(...conditions))
        .orderBy(desc(fiscalBackups.createdAt));
    }
    return db.select().from(fiscalBackups).orderBy(desc(fiscalBackups.createdAt));
  }

  async createFiscalBackup(data: InsertFiscalBackup): Promise<FiscalBackup> {
    const [backup] = await db.insert(fiscalBackups).values(data).returning();
    return backup;
  }

  // ============================================================================
  // INVENTORY LOTS
  // ============================================================================

  async getInventoryLots(filters?: { productId?: string; instanceId?: string; stockType?: string; isActive?: boolean }): Promise<InventoryLot[]> {
    const conditions = [];
    if (filters?.productId) conditions.push(eq(inventoryLots.productId, filters.productId));
    if (filters?.instanceId) conditions.push(eq(inventoryLots.instanceId, filters.instanceId));
    if (filters?.stockType) conditions.push(eq(inventoryLots.stockType, filters.stockType as any));
    if (filters?.isActive !== undefined) conditions.push(eq(inventoryLots.isActive, filters.isActive));

    if (conditions.length > 0) {
      return db.select().from(inventoryLots)
        .where(and(...conditions))
        .orderBy(asc(inventoryLots.createdAt), asc(inventoryLots.lotNumber));
    }
    return db.select().from(inventoryLots)
      .orderBy(asc(inventoryLots.createdAt), asc(inventoryLots.lotNumber));
  }

  async getInventoryLot(id: string): Promise<InventoryLot | undefined> {
    const [lot] = await db.select().from(inventoryLots).where(eq(inventoryLots.id, id));
    return lot;
  }

  async createInventoryLot(data: InsertInventoryLot): Promise<InventoryLot> {
    const [lot] = await db.insert(inventoryLots).values(data).returning();
    return lot;
  }

  async updateInventoryLot(id: string, data: Partial<InsertInventoryLot>): Promise<InventoryLot> {
    const [lot] = await db.update(inventoryLots)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(inventoryLots.id, id))
      .returning();
    return lot;
  }

  async deleteInventoryLot(id: string): Promise<void> {
    await db.delete(inventoryLots).where(eq(inventoryLots.id, id));
  }

  // ============================================================================
  // INVENTORY MOVEMENTS
  // ============================================================================

  async getInventoryMovements(filters?: { lotId?: string; productId?: string; instanceId?: string; sourceType?: string; sourceId?: string }): Promise<InventoryMovement[]> {
    const conditions = [];
    if (filters?.lotId) conditions.push(eq(inventoryMovements.lotId, filters.lotId));
    if (filters?.productId) conditions.push(eq(inventoryMovements.productId, filters.productId));
    if (filters?.instanceId) conditions.push(eq(inventoryMovements.instanceId, filters.instanceId));
    if (filters?.sourceType) conditions.push(eq(inventoryMovements.sourceType, filters.sourceType as any));
    if (filters?.sourceId) conditions.push(eq(inventoryMovements.sourceId, filters.sourceId));

    if (conditions.length > 0) {
      return db.select().from(inventoryMovements)
        .where(and(...conditions))
        .orderBy(desc(inventoryMovements.createdAt));
    }
    return db.select().from(inventoryMovements).orderBy(desc(inventoryMovements.createdAt)).limit(500);
  }

  async createInventoryMovement(data: InsertInventoryMovement): Promise<InventoryMovement> {
    const [movement] = await db.insert(inventoryMovements).values(data).returning();
    return movement;
  }

  // Billing Pipeline
  async getBillingPipelineItems(filters?: { stage?: string }): Promise<BillingPipeline[]> {
    const conditions = [];
    if (filters?.stage) conditions.push(eq(billingPipeline.stage, filters.stage as any));
    const rows = conditions.length > 0
      ? await db.select().from(billingPipeline).where(and(...conditions)).orderBy(desc(billingPipeline.createdAt))
      : await db.select().from(billingPipeline).orderBy(desc(billingPipeline.createdAt));
    // Enriquece com o status fiscal da NF (autorizada/cancelada/rejeitada) p/ colorir o card no pipeline.
    try {
      const rowsA = rows as any[];
      // Resolve a NF de CADA item por sales_card_id → ref(notes) → número (nesta ordem de
      // especificidade). Casar só por número herdava o status da nota de OUTRA filial que
      // compartilha o mesmo número (ex.: 104147 autorizada de um CNPJ x rejeitada de outro).
      const cards = Array.from(new Set(rowsA.map(r => r.salesCardId).filter(Boolean)));
      const refs = Array.from(new Set(rowsA.map(r => r.orderNumber ? ('Pedido pipeline interno - ' + r.orderNumber) : null).filter(Boolean)));
      const nums = Array.from(new Set(rowsA.map(r => String(r.invoiceNumber || '').replace(/\D/g, '')).filter(Boolean).map(Number)));
      if (cards.length || refs.length || nums.length) {
        const conds: any[] = [];
        if (cards.length) conds.push(inArray(fiscalInvoices.salesCardId, cards as any));
        if (refs.length) conds.push(inArray(fiscalInvoices.notes, refs as any));
        if (nums.length) conds.push(inArray(fiscalInvoices.invoiceNumber, nums as any));
        const fis = await db.select({ n: fiscalInvoices.invoiceNumber, st: fiscalInvoices.status, id: fiscalInvoices.id, card: fiscalInvoices.salesCardId, notes: fiscalInvoices.notes })
          .from(fiscalInvoices).where(or(...conds));
        const byCard = new Map<string, any>();
        const byRef = new Map<string, any>();
        const byNum = new Map<string, any>();
        for (const f of fis as any[]) {
          if (f.card) byCard.set(String(f.card), f);
          if (f.notes) byRef.set(String(f.notes), f);
          if (f.n != null && !byNum.has(String(f.n))) byNum.set(String(f.n), f); // fallback (1º encontrado)
        }
        const resolved: Array<{ r: any; f: any }> = [];
        const errIds: string[] = [];
        for (const r of rowsA) {
          let f = (r.salesCardId && byCard.get(String(r.salesCardId)))
            || (r.orderNumber && byRef.get('Pedido pipeline interno - ' + r.orderNumber))
            || null;
          if (!f) { const k = String(r.invoiceNumber || '').replace(/\D/g, ''); if (k) f = byNum.get(k) || null; }
          if (f) { resolved.push({ r, f }); if (['rejected', 'rejeitada', 'draft'].includes(String(f.st))) errIds.push(f.id); }
        }
        // Motivo do erro (último evento de erro) p/ NFs rejeitadas/rascunho — mostra no card + habilita re-tentar.
        const errByInvId = new Map<string, string>();
        if (errIds.length > 0) {
          try {
            const evs = await db.select({ inv: fiscalInvoiceEvents.invoiceId, msg: fiscalInvoiceEvents.errorMessage, dsc: fiscalInvoiceEvents.description })
              .from(fiscalInvoiceEvents)
              .where(and(inArray(fiscalInvoiceEvents.invoiceId, errIds as any), eq(fiscalInvoiceEvents.status, 'error')))
              .orderBy(desc(fiscalInvoiceEvents.createdAt));
            for (const e of evs as any[]) { if (e.inv && !errByInvId.has(String(e.inv))) errByInvId.set(String(e.inv), e.msg || e.dsc || ''); }
          } catch {}
        }
        for (const { r, f } of resolved) {
          r.fiscalStatus = f.st;
          if (f.id && errByInvId.has(String(f.id))) (r as any).fiscalError = errByInvId.get(String(f.id));
        }
      }
    } catch {}
    return rows as any;
  }

  async getBillingPipelineItem(id: string): Promise<BillingPipeline | undefined> {
    const [item] = await db.select().from(billingPipeline).where(eq(billingPipeline.id, id));
    return item;
  }

  async createBillingPipelineItem(data: InsertBillingPipeline): Promise<BillingPipeline> {
    const [item] = await db.insert(billingPipeline).values(data).returning();
    return item;
  }

  async updateBillingPipelineItem(id: string, data: Partial<InsertBillingPipeline>): Promise<BillingPipeline> {
    const [item] = await db.update(billingPipeline).set({ ...data, updatedAt: new Date() }).where(eq(billingPipeline.id, id)).returning();
    return item;
  }

  async deleteBillingPipelineItem(id: string): Promise<void> {
    await db.delete(billingPipeline).where(eq(billingPipeline.id, id));
  }

  // ============================================================================
  // Financial Module - Chart of Accounts
  // ============================================================================

  async getChartOfAccounts(instanceId?: string): Promise<ChartOfAccount[]> {
    if (instanceId) {
      return db.select().from(chartOfAccounts).where(
        or(eq(chartOfAccounts.omieInstanceId, instanceId), isNull(chartOfAccounts.omieInstanceId))
      ).orderBy(asc(chartOfAccounts.code));
    }
    return db.select().from(chartOfAccounts).orderBy(asc(chartOfAccounts.code));
  }

  async getChartOfAccount(id: string): Promise<ChartOfAccount | undefined> {
    const [item] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.id, id));
    return item;
  }

  async createChartOfAccount(data: InsertChartOfAccount): Promise<ChartOfAccount> {
    const [item] = await db.insert(chartOfAccounts).values(data).returning();
    return item;
  }

  async updateChartOfAccount(id: string, data: Partial<InsertChartOfAccount>): Promise<ChartOfAccount> {
    const [item] = await db.update(chartOfAccounts).set(data).where(eq(chartOfAccounts.id, id)).returning();
    return item;
  }

  async deleteChartOfAccount(id: string): Promise<void> {
    await db.delete(chartOfAccounts).where(eq(chartOfAccounts.id, id));
  }

  // ============================================================================
  // Financial Module - Financial Accounts
  // ============================================================================

  async getFinancialAccounts(instanceId?: string): Promise<FinancialAccount[]> {
    if (instanceId) {
      return db.select().from(financialAccounts).where(eq(financialAccounts.omieInstanceId, instanceId)).orderBy(desc(financialAccounts.createdAt));
    }
    return db.select().from(financialAccounts).orderBy(desc(financialAccounts.createdAt));
  }

  async getFinancialAccount(id: string): Promise<FinancialAccount | undefined> {
    const [item] = await db.select().from(financialAccounts).where(eq(financialAccounts.id, id));
    return item;
  }

  async createFinancialAccount(data: InsertFinancialAccount): Promise<FinancialAccount> {
    const [item] = await db.insert(financialAccounts).values(data).returning();
    return item;
  }

  async updateFinancialAccount(id: string, data: Partial<InsertFinancialAccount>): Promise<FinancialAccount> {
    const [item] = await db.update(financialAccounts).set(data).where(eq(financialAccounts.id, id)).returning();
    return item;
  }

  async deleteFinancialAccount(id: string): Promise<void> {
    await db.delete(financialAccounts).where(eq(financialAccounts.id, id));
  }

  // ============================================================================
  // Financial Module - Account Movements (immutable)
  // ============================================================================

  async getAccountMovements(accountId: string, filters?: { startDate?: Date; endDate?: Date; limit?: number; offset?: number }): Promise<AccountMovement[]> {
    const conditions = [eq(accountMovements.financialAccountId, accountId)];
    if (filters?.startDate) conditions.push(gte(accountMovements.createdAt, filters.startDate));
    if (filters?.endDate) conditions.push(lte(accountMovements.createdAt, filters.endDate));
    
    let query = db.select().from(accountMovements).where(and(...conditions)).orderBy(desc(accountMovements.createdAt));
    if (filters?.limit) query = (query as any).limit(filters.limit);
    if (filters?.offset) query = (query as any).offset(filters.offset);
    return query;
  }

  async createAccountMovement(data: InsertAccountMovement): Promise<AccountMovement> {
    const [item] = await db.insert(accountMovements).values(data).returning();
    return item;
  }

  // ============================================================================
  // Financial Module - PIX Charges
  // ============================================================================

  async getPixCharges(filters?: { financialAccountId?: string; status?: string; instanceId?: string; receivableId?: string; startDate?: Date; endDate?: Date }): Promise<PixCharge[]> {
    const conditions = [];
    if (filters?.financialAccountId) conditions.push(eq(pixCharges.financialAccountId, filters.financialAccountId));
    if (filters?.status) conditions.push(eq(pixCharges.status, filters.status as any));
    if (filters?.instanceId) conditions.push(eq(pixCharges.omieInstanceId, filters.instanceId));
    if (filters?.receivableId) conditions.push(eq(pixCharges.receivableId, filters.receivableId));
    if (filters?.startDate) conditions.push(gte(pixCharges.createdAt, filters.startDate));
    if (filters?.endDate) conditions.push(lte(pixCharges.createdAt, filters.endDate));

    if (conditions.length > 0) {
      return db.select().from(pixCharges).where(and(...conditions)).orderBy(desc(pixCharges.createdAt));
    }
    return db.select().from(pixCharges).orderBy(desc(pixCharges.createdAt));
  }

  async getPixCharge(id: string): Promise<PixCharge | undefined> {
    const [item] = await db.select().from(pixCharges).where(eq(pixCharges.id, id));
    return item;
  }

  async getPixChargeByTxid(txid: string): Promise<PixCharge | undefined> {
    const [item] = await db.select().from(pixCharges).where(eq(pixCharges.txid, txid));
    return item;
  }

  async createPixCharge(data: InsertPixCharge): Promise<PixCharge> {
    const [item] = await db.insert(pixCharges).values(data).returning();
    return item;
  }

  async updatePixCharge(id: string, data: Partial<InsertPixCharge>): Promise<PixCharge> {
    const [item] = await db.update(pixCharges).set({ ...data, updatedAt: new Date() }).where(eq(pixCharges.id, id)).returning();
    return item;
  }

  // ============================================================================
  // Financial Module - Receivables
  // ============================================================================

  async getReceivables(filters?: { customerId?: string; status?: string; instanceId?: string; startDate?: Date; endDate?: Date; dueDateStart?: Date; dueDateEnd?: Date; paymentMethod?: string; chartAccountId?: string }): Promise<Receivable[]> {
    const conditions = [];
    if (filters?.customerId) conditions.push(eq(receivables.customerId, filters.customerId));
    if (filters?.status === 'vencida') {
      conditions.push(or(eq(receivables.status, 'vencida' as any), and(eq(receivables.status, 'a_vencer' as any), lt(receivables.dueDate, new Date())))!);
    } else if (filters?.status === 'a_vencer') {
      conditions.push(and(eq(receivables.status, 'a_vencer' as any), gte(receivables.dueDate, new Date()))!);
    } else if (filters?.status) {
      conditions.push(eq(receivables.status, filters.status as any));
    }
    if (filters?.instanceId) conditions.push(eq(receivables.omieInstanceId, filters.instanceId));
    if (filters?.startDate) conditions.push(gte(receivables.issueDate, filters.startDate));
    if (filters?.endDate) conditions.push(lte(receivables.issueDate, filters.endDate));
    if (filters?.dueDateStart) conditions.push(gte(receivables.dueDate, filters.dueDateStart));
    if (filters?.dueDateEnd) conditions.push(lte(receivables.dueDate, filters.dueDateEnd));
    if (filters?.paymentMethod) conditions.push(eq(receivables.paymentMethod, filters.paymentMethod as any));
    if (filters?.chartAccountId) conditions.push(eq(receivables.chartAccountId, filters.chartAccountId));

    const rows = conditions.length > 0
      ? await db.select().from(receivables).where(and(...conditions)).orderBy(desc(receivables.createdAt))
      : await db.select().from(receivables).orderBy(desc(receivables.createdAt));
    // Recomputa status exibido por DATA (paridade c/ 1.0): a_vencer com vencimento passado => vencida
    const _hojeRec = new Date();
    for (const r of rows) {
      if ((r.status as any) === 'a_vencer' && r.dueDate && new Date(r.dueDate) < _hojeRec) {
        (r as any).status = 'vencida';
      }
    }
    try {
      const pipeIds = Array.from(new Set(rows.map((r) => r.billingPipelineId).filter(Boolean)));
      if (pipeIds.length > 0) {
        const pipes = await db.select({ id: billingPipeline.id, sellerName: billingPipeline.sellerName }).from(billingPipeline).where(inArray(billingPipeline.id, pipeIds));
        const sm = new Map(pipes.map((p) => [p.id, p.sellerName]));
        for (const r of rows) { r.sellerName = sm.get(r.billingPipelineId) || null; }
      }
      // Fallback (paridade c/ 1.0): vendedor a partir do cadastro do cliente (por id OU por documento) p/ recebiveis sem pipeline
      const needSeller = rows.filter((r) => !r.sellerName);
      if (needSeller.length > 0) {
        const allUsers = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, omieVendorCode: users.omieVendorCode }).from(users);
        const nameOf = (u: any) => (`${u.firstName || ''} ${u.lastName || ''}`.trim()) || u.email || null;
        const byId = new Map<string, any>(); const byCode = new Map<string, any>();
        for (const u of allUsers) { byId.set(u.id, u); if (u.omieVendorCode) byCode.set(String(u.omieVendorCode), u); }
        const resolveSeller = (sid: any): string | null => {
          if (!sid) return null;
          const str = String(sid);
          const u = byId.get(str) || byCode.get(str) || byCode.get(str.replace('omie-vendor-', ''));
          return u ? nameOf(u) : null;
        };
        const digitsOnly = (x: any) => String(x || '').replace(/\D/g, '');
        const allCusts = await db.select({ id: customers.id, cnpj: customers.cnpj, cpf: customers.cpf, sellerId: customers.sellerId }).from(customers);
        const sellerById = new Map<string, any>(); const sellerByDoc = new Map<string, any>();
        for (const c of allCusts) {
          if (c.id) sellerById.set(c.id, c.sellerId);
          const d = digitsOnly(c.cnpj) || digitsOnly(c.cpf);
          if (d && d.length >= 11 && c.sellerId && !sellerByDoc.has(d)) sellerByDoc.set(d, c.sellerId);
        }
        for (const r of needSeller) {
          let sid: any = r.customerId ? sellerById.get(r.customerId) : null;
          if (!sid && (r as any).customerDocument) sid = sellerByDoc.get(digitsOnly((r as any).customerDocument));
          const nm = resolveSeller(sid);
          if (nm) r.sellerName = nm;
        }
      }
    } catch (e) { /* enrich sellerName: best-effort */ }
    return rows;
  }

  async getReceivable(id: string): Promise<Receivable | undefined> {
    const [item] = await db.select().from(receivables).where(eq(receivables.id, id));
    return item;
  }

  async createReceivable(data: InsertReceivable): Promise<Receivable> {
    const [item] = await db.insert(receivables).values(data).returning();
    return item;
  }

  async updateReceivable(id: string, data: Partial<InsertReceivable>): Promise<Receivable> {
    const [item] = await db.update(receivables).set({ ...data, updatedAt: new Date() }).where(eq(receivables.id, id)).returning();
    return item;
  }

  async deleteReceivable(id: string): Promise<void> {
    await db.delete(receivables).where(eq(receivables.id, id));
  }

  // ============================================================================
  // Financial Module - Receivable Payments
  // ============================================================================

  async getReceivablePayments(receivableId: string): Promise<ReceivablePayment[]> {
    return db.select().from(receivablePayments).where(eq(receivablePayments.receivableId, receivableId)).orderBy(desc(receivablePayments.createdAt));
  }

  async createReceivablePayment(data: InsertReceivablePayment): Promise<ReceivablePayment> {
    const [item] = await db.insert(receivablePayments).values(data).returning();
    return item;
  }

  // ============================================================================
  // Financial Module - Payables
  // ============================================================================

  async getPayables(filters?: { supplierDocument?: string; status?: string; instanceId?: string; startDate?: Date; endDate?: Date; dueDateStart?: Date; dueDateEnd?: Date; source?: string; chartAccountId?: string }): Promise<Payable[]> {
    const conditions = [];
    if (filters?.supplierDocument) conditions.push(eq(payables.supplierDocument, filters.supplierDocument));
    if (filters?.status) conditions.push(eq(payables.status, filters.status as any));
    if (filters?.instanceId) conditions.push(eq(payables.omieInstanceId, filters.instanceId));
    if (filters?.startDate) conditions.push(gte(payables.issueDate, filters.startDate));
    if (filters?.endDate) conditions.push(lte(payables.issueDate, filters.endDate));
    if (filters?.dueDateStart) conditions.push(gte(payables.dueDate, filters.dueDateStart));
    if (filters?.dueDateEnd) conditions.push(lte(payables.dueDate, filters.dueDateEnd));
    if (filters?.source) conditions.push(eq(payables.source, filters.source as any));
    if (filters?.chartAccountId) conditions.push(eq(payables.chartAccountId, filters.chartAccountId));

    if (conditions.length > 0) {
      return db.select().from(payables).where(and(...conditions)).orderBy(desc(payables.createdAt));
    }
    return db.select().from(payables).orderBy(desc(payables.createdAt));
  }

  async getPayable(id: string): Promise<Payable | undefined> {
    const [item] = await db.select().from(payables).where(eq(payables.id, id));
    return item;
  }

  async createPayable(data: InsertPayable): Promise<Payable> {
    const [item] = await db.insert(payables).values(data).returning();
    return item;
  }

  async updatePayable(id: string, data: Partial<InsertPayable>): Promise<Payable> {
    const [item] = await db.update(payables).set({ ...data, updatedAt: new Date() }).where(eq(payables.id, id)).returning();
    return item;
  }

  async deletePayable(id: string): Promise<void> {
    await db.delete(payables).where(eq(payables.id, id));
  }

  // ============================================================================
  // Financial Module - Payable Payments
  // ============================================================================

  async getPayablePayments(payableId: string): Promise<PayablePayment[]> {
    return db.select().from(payablePayments).where(eq(payablePayments.payableId, payableId)).orderBy(desc(payablePayments.createdAt));
  }

  async createPayablePayment(data: InsertPayablePayment): Promise<PayablePayment> {
    const [item] = await db.insert(payablePayments).values(data).returning();
    return item;
  }

  // ============================================================================
  // Financial Module - SPED Exports
  // ============================================================================

  async getSpedExports(instanceId?: string): Promise<SpedExport[]> {
    if (instanceId) {
      return db.select().from(spedExports).where(eq(spedExports.omieInstanceId, instanceId)).orderBy(desc(spedExports.createdAt));
    }
    return db.select().from(spedExports).orderBy(desc(spedExports.createdAt));
  }

  async createSpedExport(data: InsertSpedExport): Promise<SpedExport> {
    const [item] = await db.insert(spedExports).values(data).returning();
    return item;
  }
}

export const storage = new DatabaseStorage();
