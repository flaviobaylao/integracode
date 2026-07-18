// =============================================================================
//  INTEGRA 2.0 — Módulo Acessos e Delegações — schema (Drizzle ORM)
//  Arquivo standalone: shared/delegations-schema.ts
//  É reexportado por shared/schema.ts (`export * from "./delegations-schema";`),
//  então entra automaticamente no drizzle({ schema }) e no drizzle-kit push.
// =============================================================================
import { pgTable, pgEnum, varchar, boolean, timestamp, jsonb, integer, decimal, index, unique } from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./schema";

// Referência LOCAL ao enum user_role (já existente no banco, definido em shared/schema.ts).
// NÃO importar de "./schema": o ciclo de módulos (schema.ts re-exporta este arquivo via
// `export *`, que é hoisted no ESM) faz este arquivo inicializar ANTES do corpo do schema.ts,
// e o valor importado estaria undefined no momento do uso (ReferenceError que derrubou o boot).
// Como esta const não é exportada, o drizzle-kit não vê enum duplicado — só o tipo 'user_role'.
const userRoleEnum = pgEnum('user_role', ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing', 'motorista', 'industria']);

// Tipo da delegação
export const delegationTypeEnum = pgEnum('delegation_type', [
  'carteira_transferencia', // carteira de 1 vendedor -> 1 destinatário
  'carteira_rateio',        // carteira de 1 vendedor -> 2/3 destinatários
  'acesso_funcao',          // acessos de uma função -> 1 usuário
]);

// Critério usado no rateio
export const delegationCriteriaEnum = pgEnum('delegation_criteria', [
  'segmento',
  'faturamento',
  'segmento_faturamento',
  'quantidade',
  'nenhum',
]);

export const delegationStatusEnum = pgEnum('delegation_status', [
  'agendada', // startsAt no futuro
  'ativa',    // dentro do período
  'expirada', // endsAt no passado
  'revogada', // encerrada manualmente
]);

// -----------------------------------------------------------------------------
//  Tabela principal de delegações
// -----------------------------------------------------------------------------
export const delegations = pgTable("delegations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: delegationTypeEnum("type").notNull(),
  status: delegationStatusEnum("status").notNull().default('agendada'),

  // Origem: vendedor titular da carteira (carteira_*) OU perfil de origem (acesso_funcao)
  fromUserId: varchar("from_user_id"),              // titular da carteira
  originRole: userRoleEnum("origin_role"),          // função de origem (acesso_funcao)

  // Rateio
  criteria: delegationCriteriaEnum("criteria").notNull().default('nenhum'),

  // Acessos delegados (acesso_funcao): lista de ids/labels de acesso
  accesses: jsonb("accesses").$type<string[]>(),

  // Período
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  autoReturn: boolean("auto_return").notNull().default(true), // devolve ao titular no fim

  // Metadados / auditoria
  reason: varchar("reason"),
  createdBy: varchar("created_by").notNull(),       // admin que criou
  revokedBy: varchar("revoked_by"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// -----------------------------------------------------------------------------
//  Destinatários de uma delegação (1 linha p/ transferência, 2-3 p/ rateio,
//  1 p/ acesso_funcao). Guarda o resultado consolidado por destinatário.
// -----------------------------------------------------------------------------
export const delegationTargets = pgTable("delegation_targets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  delegationId: varchar("delegation_id").notNull(),
  toUserId: varchar("to_user_id").notNull(),
  customerCount: integer("customer_count").notNull().default(0),
  avgRevenue3m: decimal("avg_revenue_3m", { precision: 12, scale: 2 }).default('0'),
  segments: jsonb("segments").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow(),
});

// -----------------------------------------------------------------------------
//  Mapeamento cliente -> destinatário (overlay não destrutivo da carteira).
//  Enquanto a delegação estiver ativa, o cliente aparece para o destinatário
//  sem alterar customers.sellerId (o titular é preservado e devolvido ao fim).
// -----------------------------------------------------------------------------
export const delegationCustomers = pgTable("delegation_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  delegationId: varchar("delegation_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  toUserId: varchar("to_user_id").notNull(),
}, (table) => ({
  idxDelegCustomer: index("idx_deleg_customer").on(table.customerId),
  idxDelegTo: index("idx_deleg_to").on(table.toUserId),
}));

// -----------------------------------------------------------------------------
//  Relations
// -----------------------------------------------------------------------------
export const delegationsRelations = relations(delegations, ({ one, many }) => ({
  fromUser: one(users, { fields: [delegations.fromUserId], references: [users.id] }),
  creator: one(users, { fields: [delegations.createdBy], references: [users.id] }),
  targets: many(delegationTargets),
  customers: many(delegationCustomers),
}));

export const delegationTargetsRelations = relations(delegationTargets, ({ one }) => ({
  delegation: one(delegations, { fields: [delegationTargets.delegationId], references: [delegations.id] }),
  toUser: one(users, { fields: [delegationTargets.toUserId], references: [users.id] }),
}));

// -----------------------------------------------------------------------------
//  Zod insert schemas + tipos
// -----------------------------------------------------------------------------
export const insertDelegationSchema = createInsertSchema(delegations).omit({
  id: true, status: true, revokedBy: true, revokedAt: true, createdAt: true, updatedAt: true,
});
export const insertDelegationTargetSchema = createInsertSchema(delegationTargets).omit({ id: true, createdAt: true });

export type Delegation = typeof delegations.$inferSelect;
export type InsertDelegation = z.infer<typeof insertDelegationSchema>;
export type DelegationTarget = typeof delegationTargets.$inferSelect;
export type DelegationCustomer = typeof delegationCustomers.$inferSelect;

// =============================================================================
//  Permissões granulares por usuário (aba "Acessos por Usuário")
//  Guarda apenas OVERRIDES sobre o padrão da função. Um card/flag ausente =
//  herda o padrão do papel (calculado em flagsPadrao() no front/back).
//  Estrutura de flags por card: { ver, criar, editar, excluir, exportar }.
// =============================================================================
export type PermissionFlags = {
  ver: boolean; criar: boolean; editar: boolean; excluir: boolean; exportar: boolean;
};

export const userPermissions = pgTable("user_permissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  // mapa { [cardLabel|cardId]: PermissionFlags } — conjunto completo salvo pelo admin
  permissions: jsonb("permissions").$type<Record<string, PermissionFlags>>().notNull(),
  updatedBy: varchar("updated_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  uniqUser: unique("uniq_user_permissions").on(table.userId),
}));

export const userPermissionsRelations = relations(userPermissions, ({ one }) => ({
  user: one(users, { fields: [userPermissions.userId], references: [users.id] }),
}));

export type UserPermissions = typeof userPermissions.$inferSelect;
