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

// Customers table
export const customers = pgTable("customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  document: varchar("document").notNull().unique(),
  phone: varchar("phone").notNull(),
  email: varchar("email"),
  address: text("address").notNull(),
  route: varchar("route").notNull(),
  sellerId: varchar("seller_id").notNull(),
  weekdays: varchar("weekdays").notNull(), // JSON string of selected days
  isActive: boolean("is_active").notNull().default(true),
  lastSaleDate: timestamp("last_sale_date"),
  lastSaleValue: decimal("last_sale_value", { precision: 10, scale: 2 }),
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

// Sales cards table
export const salesCards = pgTable("sales_cards", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  customerId: varchar("customer_id").notNull(),
  sellerId: varchar("seller_id").notNull(),
  status: salesCardStatusEnum("status").notNull().default('pending'),
  scheduledDate: timestamp("scheduled_date").notNull(),
  completedDate: timestamp("completed_date"),
  saleValue: decimal("sale_value", { precision: 10, scale: 2 }),
  noSaleReason: text("no_sale_reason"),
  notes: text("notes"),
  duplicatedFromId: varchar("duplicated_from_id"),
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

export const salesCardsRelations = relations(salesCards, ({ one }) => ({
  customer: one(customers, {
    fields: [salesCards.customerId],
    references: [customers.id],
  }),
  seller: one(users, {
    fields: [salesCards.sellerId],
    references: [users.id],
  }),
  duplicatedFrom: one(salesCards, {
    fields: [salesCards.duplicatedFromId],
    references: [salesCards.id],
  }),
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
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSalesCardSchema = createInsertSchema(salesCards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageTemplateSchema = createInsertSchema(messageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageHistorySchema = createInsertSchema(messageHistory).omit({
  id: true,
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
};
