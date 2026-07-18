// =============================================================================
//  INTEGRA 2.0 — Módulo Acessos e Delegações — rotas do servidor (Express)
//  server/delegations-routes.ts — registrar em server/index.ts:
//      import { registerDelegationRoutes } from "./delegations-routes";
//      registerDelegationRoutes(app);
//  Auth: authenticateAdmin (mesmo padrão de authMiddleware.ts; injeta req.currentUser).
//
//  IMPORTANTE: todo handler é assíncrono e envolvido em try/catch. Um erro de
//  query NUNCA pode virar unhandled rejection (derruba o processo -> 502 no app
//  inteiro). Em erro, respondemos 500 com a mensagem e logamos no console.
// =============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { and, eq, desc, lte, gte, inArray } from "drizzle-orm";
import {
  delegations, delegationTargets, delegationCustomers, userPermissions,
  customers, insertDelegationSchema,
} from "@shared/schema";
import { authenticateAdmin } from "./authMiddleware";

// wrapper: captura qualquer rejeição do handler async e responde 500 (nunca derruba o processo)
const safe = (fn: (req: Request, res: Response) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error("[acessos-delegacoes] erro na rota:", req.method, req.path, e?.message, e?.stack);
      if (!res.headersSent) res.status(500).json({ error: e?.message || "erro interno", code: e?.code });
    }
  };

// ---- Algoritmo de rateio (espelha o preview do front) -----------------------
type Cli = { id: string; segment: string; avg: number };
function ratear(clientes: Cli[], targets: string[], criteria: string) {
  const recs = targets.map((id) => ({ toUserId: id, cs: [] as Cli[], fat: 0 }));
  const menorFat = () => recs.reduce((a, b) => (b.fat < a.fat ? b : a));
  const menorQtd = () => recs.reduce((a, b) => (b.cs.length < a.cs.length ? b : a));

  if (targets.length <= 1) { // transferência (ou nenhum)
    if (recs[0]) { recs[0].cs = clientes; recs[0].fat = clientes.reduce((s, c) => s + c.avg, 0); }
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

// carteira de um vendedor como lista de Cli (tolerante a colunas ausentes)
async function carteiraDe(sellerId: string): Promise<Cli[]> {
  const rows = await db.select().from(customers).where(eq(customers.sellerId, sellerId));
  return rows.map((c: any) => ({
    id: c.id,
    segment: c.segment ?? "Sem segmento",
    avg: Number(c.avgRevenue3m ?? c.avg_revenue_3m ?? 0),
  }));
}

export function registerDelegationRoutes(app: Express) {
  // Lista de delegações — SELECT simples (sem API relacional) + targets numa 2ª query
  app.get("/api/delegations", authenticateAdmin, safe(async (_req, res) => {
    const rows = await db.select().from(delegations).orderBy(desc(delegations.createdAt));
    let targets: any[] = [];
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      targets = await db.select().from(delegationTargets).where(inArray(delegationTargets.delegationId, ids));
    }
    const byDeleg: Record<string, any[]> = {};
    targets.forEach((t) => (byDeleg[t.delegationId] = byDeleg[t.delegationId] || []).push(t));
    res.json(rows.map((r) => ({ ...r, targets: byDeleg[r.id] || [] })));
  }));

  // Pré-visualização do rateio (não persiste)
  app.post("/api/delegations/preview", authenticateAdmin, safe(async (req, res) => {
    const { fromUserId, targets, criteria } = req.body as { fromUserId: string; targets: string[]; criteria: string };
    if (!fromUserId || !Array.isArray(targets)) return res.json([]);
    const clientes = await carteiraDe(fromUserId);
    res.json(ratear(clientes, targets, criteria));
  }));

  // Cria delegação (carteira ou acesso)
  app.post("/api/delegations", authenticateAdmin, safe(async (req, res) => {
    const parsed = insertDelegationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const body = parsed.data as any;
    const targets: string[] = req.body.targets ?? [];
    const createdBy = (req as any).currentUser.id;

    const [deleg] = await db.insert(delegations).values({ ...body, createdBy }).returning();

    if (body.type === "acesso_funcao") {
      if (targets[0]) await db.insert(delegationTargets).values({ delegationId: deleg.id, toUserId: targets[0] });
    } else {
      const clientes = await carteiraDe(body.fromUserId);
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
  }));

  // Revoga (devolve carteira/acessos ao titular)
  app.post("/api/delegations/:id/revoke", authenticateAdmin, safe(async (req, res) => {
    await db.update(delegations)
      .set({ status: "revogada", revokedBy: (req as any).currentUser.id, revokedAt: new Date() })
      .where(eq(delegations.id, req.params.id));
    res.json({ ok: true });
  }));

  // GET: overrides salvos p/ um usuário (o front mescla sobre o padrão da função)
  app.get("/api/user-permissions/:userId", authenticateAdmin, safe(async (req, res) => {
    const [row] = await db.select().from(userPermissions).where(eq(userPermissions.userId, req.params.userId));
    res.json(row?.permissions ?? {});
  }));

  // PUT: grava o mapa completo de permissões (upsert por usuário)
  app.put("/api/user-permissions/:userId", authenticateAdmin, safe(async (req, res) => {
    const permissions = req.body.permissions ?? {};
    const updatedBy = (req as any).currentUser.id;
    await db.insert(userPermissions)
      .values({ userId: req.params.userId, permissions, updatedBy })
      .onConflictDoUpdate({ target: userPermissions.userId, set: { permissions, updatedBy, updatedAt: new Date() } });
    res.json({ ok: true });
  }));
}

// -----------------------------------------------------------------------------
//  Job de manutenção de status (opcional; rode em cron). Também blindado.
// -----------------------------------------------------------------------------
export async function tickDelegationStatuses() {
  try {
    const now = new Date();
    await db.update(delegations).set({ status: "ativa" })
      .where(and(eq(delegations.status, "agendada"), lte(delegations.startsAt, now), gte(delegations.endsAt, now)));
    await db.update(delegations).set({ status: "expirada" })
      .where(and(inArray(delegations.status, ["agendada", "ativa"]), lte(delegations.endsAt, now)));
  } catch (e: any) {
    console.error("[acessos-delegacoes] tickDelegationStatuses:", e?.message);
  }
}
