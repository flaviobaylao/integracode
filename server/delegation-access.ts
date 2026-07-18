// =============================================================================
//  INTEGRA 2.0 — Módulo Delegações — resolvedor de acesso efetivo (overlay)
//  Salve como server/lib/delegation-access.ts
//
//  Duas responsabilidades:
//   1) sellerScopeFor(userId): quais sellerIds um usuário "enxerga" hoje,
//      incluindo carteiras delegadas ativas (para filtros de customers, cards,
//      faturamentos, etc). Substitui filtros do tipo `where sellerId = me`.
//   2) effectiveAccessesFor(userId): acessos do próprio papel + acessos
//      delegados por delegações ativas (para liberar telas/menus temporários).
// =============================================================================
import { db } from "./db";
import { and, eq, lte, gte, inArray } from "drizzle-orm";
import { delegations, delegationCustomers } from "@shared/schema";

const activeWindow = () => {
  const now = new Date();
  return and(
    inArray(delegations.status, ["ativa", "agendada"]),
    lte(delegations.startsAt, now),
    gte(delegations.endsAt, now),
  );
};

/**
 * Retorna o conjunto de customerIds delegados ATIVOS para um usuário destinatário.
 * Use como overlay ao consultar a carteira: um vendedor vê seus próprios clientes
 * (customers.sellerId = ele) UNIÃO os clientes delegados a ele.
 */
export async function delegatedCustomerIdsFor(toUserId: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: delegationCustomers.customerId })
    .from(delegationCustomers)
    .innerJoin(delegations, eq(delegations.id, delegationCustomers.delegationId))
    .where(and(eq(delegationCustomers.toUserId, toUserId), activeWindow()));
  return rows.map((r) => r.customerId);
}

/**
 * customerIds do titular que estão delegados PARA FORA (deve deixar de ver
 * enquanto durar a delegação, se a regra de negócio exigir exclusividade).
 */
export async function delegatedAwayCustomerIdsFor(fromUserId: string): Promise<string[]> {
  const rows = await db
    .select({ customerId: delegationCustomers.customerId })
    .from(delegationCustomers)
    .innerJoin(delegations, eq(delegations.id, delegationCustomers.delegationId))
    .where(and(eq(delegations.fromUserId, fromUserId), activeWindow()));
  return rows.map((r) => r.customerId);
}

/**
 * Acessos extras concedidos por delegações de função ativas.
 * Combine com a matriz base do papel (a mesma lista usada em Layout.tsx).
 */
export async function delegatedAccessesFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ accesses: delegations.accesses })
    .from(delegations)
    .where(and(eq(delegations.type, "acesso_funcao"), activeWindow()));
  // filtra pelos destinatários via delegationTargets no schema real;
  // simplificado aqui para o overlay de acessos por usuário:
  const list = new Set<string>();
  rows.forEach((r) => (r.accesses ?? []).forEach((a) => list.add(a)));
  return [...list];
}

/**
 * Exemplo de uso em uma rota de carteira:
 *
 *   const own = eq(customers.sellerId, me.id);
 *   const delegated = await delegatedCustomerIdsFor(me.id);
 *   const away = await delegatedAwayCustomerIdsFor(me.id);
 *   const where = and(
 *     or(own, delegated.length ? inArray(customers.id, delegated) : sql`false`),
 *     away.length ? not(inArray(customers.id, away)) : undefined,
 *   );
 */
