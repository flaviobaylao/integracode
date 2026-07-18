// =============================================================================
//  INTEGRA 2.0 — Módulo Acessos e Delegações — rotas do servidor (Express)
//  server/delegations-routes.ts — registrar em server/index.ts:
//      import { registerDelegationRoutes } from "./delegations-routes";
//      registerDelegationRoutes(app);
//  Auth: authenticateAdmin (mesmo padrão de authMiddleware.ts; injeta req.currentUser).
// =============================================================================
import type { Express } from "express";
import { db } from "./db";
import { and, eq, lte, gte, inArray } from "drizzle-orm";
import {
  delegations, delegationTargets, delegationCustomers, userPermissions,
  customers, insertDelegationSchema,
} from "@shared/schema";
import { authenticateAdmin } from "./authMiddleware";

// ---- Algoritmo de rateio (espelha o preview do front) -----------------------
type Cli = { id: string; segment: string; avg: number };
function ratear(clientes: Cli[], targets: string[], criteria: string) {
  const recs = targets.map((id) => ({ toUserId: id, cs: [] as Cli[], fat: 0 }));
  const menorFat = () => recs.reduce((a, b) => (b.fat < a.fat ? b : a));
  const menorQtd = () => recs.reduce((a, b) => (b.cs.length < a.cs.length ? b : a));

  if (targets.length === 1) { // transferência
    recs[0].cs = clientes; recs[0].fat = clientes.reduce((s, c) => s + c.avg, 0);
    return recs;
  }
  const bySeg = criteria === "segmento" || criteria === "segmento_faturamento";
  const byFat = criteria === "faturamento" || criteria === "segmento_faturamento";

  if (bySeg) {
    const grupos: Record<string, Cli[]> = {};
    clientes.forEach((c) => (grupos[c.segment] = grupos[c.segment] || []).push(c));
    const blocos = Object.values(grupos)
      .map((g) => ({ cs: g, fat: g.reduce((s, c) => s + c.avg, 0) }))
      .sort((a, b) => b.fat - a.fat);
    blocos.forEach((bl) => { const r = byFat ? menorFat() : menorQtd(); r.cs.push(...bl.cs); r.fat += bl.fat; });
  } else {
    [...clientes].sort((a, b) => b.avg - a.avg).forEach((c) => { const r = menorFat(); r.cs.push(c); r.fat += c.avg; });
  }
  return recs;
}

export function registerDelegationRoutes(app: Express) {
  // Lista de delegações (com status calculado)
  app.get("/api/delegations", authenticateAdmin, async (_req, res) => {
    const rows = await db.query.delegations.findMany({
      with: { targets: true, fromUser: true },
      orderBy: (d, { desc }) => [desc(d.createdAt)],
    });
    res.json(rows);
  });

  // Pré-visualização do rateio (não persiste)
  app.post("/api/delegations/preview", authenticateAdmin, async (req, res) => {
    const { fromUserId, targets, criteria } = req.body as { fromUserId: string; targets: string[]; criteria: string };
    const carteira = await db.select().from(customers).where(eq(customers.sellerId, fromUserId));
    const clientes: Cli[] = carteira.map((c: any) => ({
      id: c.id, segment: c.segment ?? "Sem segmento", avg: Number(c.avgRevenue3m ?? 0),
    }));
    res.json(ratear(clientes, targets, criteria));
  });

  // Cria delegação (carteira ou acesso)
  app.post("/api/delegations", authenticateAdmin, async (req, res) => {
    const parsed = insertDelegationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const body = parsed.data as any;
    const targets: string[] = req.body.targets ?? [];
    const createdBy = (req as any).currentUser.id;

    const [deleg] = await db.insert(delegations).values({ ...body, createdBy }).returning();

    if (body.type === "acesso_funcao") {
      await db.insert(delegationTargets).values({ delegationId: deleg.id, toUserId: targets[0] });
    } else {
      const carteira = await db.select().from(customers).where(eq(customers.sellerId, body.fromUserId));
      const clientes: Cli[] = carteira.map((c: any) => ({ id: c.id, segment: c.segment ?? "Sem segmento", avg: Number(c.avgRevenue3m ?? 0) }));
      const recs = ratear(clientes, targets, body.criteria);
      for (const r of recs) {
        await db.insert(delegationTargets).values({
          delegationId: deleg.id, toUserId: r.toUserId, customerCount: r.cs.length,
          avgRevenue3m: String(r.fat), segments: [...new Set(r.cs.map((c) => c.segment))],
        });
        if (r.cs.length)
          await db.insert(delegationCustomers).values(
            r.cs.map((c) => ({ delegationId: deleg.id, customerId: c.id, toUserId: r.toUserId }))
          );
      }
    }
    res.status(201).json(deleg);
  });

  // Revoga (devolve carteira/acessos ao titular)
  app.post("/api/delegations/:id/revoke", authenticateAdmin, async (req, res) => {
    await db.update(delegations)
      .set({ status: "revogada", revokedBy: (req as any).currentUser.id, revokedAt: new Date() })
      .where(eq(delegations.id, req.params.id));
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  //  Permissões granulares por usuário (aba "Acessos por Usuário")
  // -------------------------------------------------------------------------
  // GET: overrides salvos p/ um usuário (o front mescla sobre o padrão da função)
  app.get("/api/user-permissions/:userId", authenticateAdmin, async (req, res) => {
    const [row] = await db.select().from(userPermissions).where(eq(userPermissions.userId, req.params.userId));
    res.json(row?.permissions ?? {});
  });

  // PUT: grava o mapa completo de permissões (upsert por usuário)
  app.put("/api/user-permissions/:userId", authenticateAdmin, async (req, res) => {
    const permissions = req.body.permissions ?? {};
    const updatedBy = (req as any).currentUser.id;
    await db.insert(userPermissions)
      .values({ userId: req.params.userId, permissions, updatedBy })
      .onConflictDoUpdate({ target: userPermissions.userId, set: { permissions, updatedBy, updatedAt: new Date() } });
    res.json({ ok: true });
  });
}

// -----------------------------------------------------------------------------
//  Job de manutenção de status (rode em cron a cada minuto/hora):
//  agendada -> ativa (startsAt<=agora), ativa -> expirada (endsAt<agora).
//  Ao expirar/revogar, o overlay some e customers.sellerId (intacto) volta a valer.
// -----------------------------------------------------------------------------
export async function tickDelegationStatuses() {
  const now = new Date();
  await db.update(delegations).set({ status: "ativa" })
    .where(and(eq(delegations.status, "agendada"), lte(delegations.startsAt, now), gte(delegations.endsAt, now)));
  await db.update(delegations).set({ status: "expirada" })
    .where(and(inArray(delegations.status, ["agendada", "ativa"]), lte(delegations.endsAt, now)));
}
