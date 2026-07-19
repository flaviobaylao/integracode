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
//
//  Este arquivo é AUTOSSUFICIENTE (só ele precisa subir):
//   - ensureModuleTables(): cria as 4 tabelas do módulo no boot (idempotente).
//     Resolve o fato de o build de produção NÃO rodar `db:push`.
//   - runDelegationReturns(): devolve carteiras ao titular quando a delegação
//     expira (autoReturn) — grava customers.sellerId. Rodado por agendador.
//   - startAutoReturnScheduler(): agenda o executor (a cada 15 min + no boot).
//   - POST /api/delegations/import-carteira: registra uma carteira JÁ distribuída
//     (lista explícita de clientes) com devolução automática no fim do período.
// =============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { and, eq, desc, lte, gte, inArray, sql } from "drizzle-orm";
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

// =============================================================================
//  Bootstrap de tabelas (o build de produção não roda db:push).
//  Idempotente: CREATE TABLE IF NOT EXISTS + enums protegidos por DO/EXCEPTION.
//  Cada statement roda isolado; um erro não impede os demais.
// =============================================================================
const DDL: string[] = [
  `DO $$ BEGIN CREATE TYPE delegation_type AS ENUM ('carteira_transferencia','carteira_rateio','acesso_funcao'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  `DO $$ BEGIN CREATE TYPE delegation_criteria AS ENUM ('segmento','faturamento','segmento_faturamento','quantidade','nenhum'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  `DO $$ BEGIN CREATE TYPE delegation_status AS ENUM ('agendada','ativa','expirada','revogada'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  `CREATE TABLE IF NOT EXISTS delegations (
     id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     type         delegation_type NOT NULL,
     status       delegation_status NOT NULL DEFAULT 'agendada',
     from_user_id varchar,
     origin_role  user_role,
     criteria     delegation_criteria NOT NULL DEFAULT 'nenhum',
     accesses     jsonb,
     starts_at    timestamp NOT NULL,
     ends_at      timestamp NOT NULL,
     auto_return  boolean NOT NULL DEFAULT true,
     reason       varchar,
     created_by   varchar NOT NULL,
     revoked_by   varchar,
     revoked_at   timestamp,
     created_at   timestamp DEFAULT now(),
     updated_at   timestamp DEFAULT now()
   );`,
  `CREATE TABLE IF NOT EXISTS delegation_targets (
     id             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     delegation_id  varchar NOT NULL,
     to_user_id     varchar NOT NULL,
     customer_count integer NOT NULL DEFAULT 0,
     avg_revenue_3m numeric(12,2) DEFAULT 0,
     segments       jsonb,
     created_at     timestamp DEFAULT now()
   );`,
  `CREATE TABLE IF NOT EXISTS delegation_customers (
     id            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     delegation_id varchar NOT NULL,
     customer_id   varchar NOT NULL,
     to_user_id    varchar NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_deleg_customer ON delegation_customers (customer_id);`,
  `CREATE INDEX IF NOT EXISTS idx_deleg_to       ON delegation_customers (to_user_id);`,
  `CREATE TABLE IF NOT EXISTS user_permissions (
     id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id     varchar NOT NULL,
     permissions jsonb NOT NULL,
     updated_by  varchar,
     updated_at  timestamp DEFAULT now(),
     CONSTRAINT uniq_user_permissions UNIQUE (user_id)
   );`,
];

let _tablesReady: Promise<void> | null = null;
export function ensureModuleTables(): Promise<void> {
  if (_tablesReady) return _tablesReady;
  _tablesReady = (async () => {
    for (const stmt of DDL) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (e: any) {
        console.error("[acessos-delegacoes] ensureModuleTables stmt falhou:", e?.message);
      }
    }
    console.log("[acessos-delegacoes] ensureModuleTables: tabelas verificadas/criadas.");
  })();
  return _tablesReady;
}

// ---- Algoritmo de rateio (espelha o preview do front) -----------------------
type Cli = { id: string; segment: string; avg: number };
function ratear(clientes: Cli[], targets: string[], criteria: string) {
  const recs = targets.map((id) => ({ toUserId: id, cs: [] as Cli[], fat: 0 }));
  // menor faturamento — empate resolvido por menor quantidade (evita despejar tudo no 1º)
  const menorFat = () => recs.reduce((a, b) => (b.fat < a.fat || (b.fat === a.fat && b.cs.length < a.cs.length) ? b : a));
  const menorQtd = () => recs.reduce((a, b) => (b.cs.length < a.cs.length ? b : a));

  if (targets.length <= 1) { // transferência (ou nenhum)
    if (recs[0]) { recs[0].cs = clientes; recs[0].fat = clientes.reduce((s, c) => s + c.avg, 0); }
    return recs;
  }
  const bySeg = criteria === "segmento" || criteria === "segmento_faturamento";
  const byFat = criteria === "faturamento" || criteria === "segmento_faturamento";
  // só pesa por faturamento se existir dado real; senão distribui por quantidade
  const temFat = clientes.some((c) => c.avg > 0);
  const usarFat = byFat && temFat;

  if (bySeg) {
    const grupos: Record<string, Cli[]> = {};
    clientes.forEach((c) => (grupos[c.segment] = grupos[c.segment] || []).push(c));
    const blocos = Object.values(grupos)
      .map((g) => ({ cs: g, fat: g.reduce((s, c) => s + c.avg, 0) }))
      .sort((a, b) => (usarFat ? b.fat - a.fat : b.cs.length - a.cs.length));
    blocos.forEach((bl) => { const r = usarFat ? menorFat() : menorQtd(); r.cs.push(...bl.cs); r.fat += bl.fat; });
  } else {
    const arr = usarFat ? [...clientes].sort((a, b) => b.avg - a.avg) : [...clientes];
    arr.forEach((c) => { const r = usarFat ? menorFat() : menorQtd(); r.cs.push(c); r.fat += c.avg; });
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

// =============================================================================
//  Executor de devolução automática (grava customers.sellerId).
//  Para toda delegação de carteira com autoReturn=true cujo período expirou e
//  que ainda não foi devolvida/revogada, devolve TODOS os clientes mapeados em
//  delegation_customers ao titular (from_user_id) e marca status 'expirada'.
//  Idempotente e blindado: um erro num cliente não interrompe os demais.
// =============================================================================
export async function runDelegationReturns(): Promise<void> {
  try {
    const now = new Date();
    const due = await db.select().from(delegations).where(and(
      eq(delegations.autoReturn, true),
      inArray(delegations.status, ["agendada", "ativa"]),
      inArray(delegations.type, ["carteira_transferencia", "carteira_rateio"]),
      lte(delegations.endsAt, now),
    ));
    for (const d of due) {
      if (!d.fromUserId) continue;
      const rows = await db.select().from(delegationCustomers).where(eq(delegationCustomers.delegationId, d.id));
      if (!rows.length) {
        // nada a devolver: apenas expira para não reprocessar
        await db.update(delegations).set({ status: "expirada", updatedAt: now }).where(eq(delegations.id, d.id));
        continue;
      }
      let ok = 0, fail = 0;
      for (const c of rows) {
        try {
          await db.update(customers).set({ sellerId: d.fromUserId }).where(eq(customers.id, c.customerId));
          ok++;
        } catch (e: any) {
          fail++;
          console.error("[acessos-delegacoes] devolução falhou p/ cliente", c.customerId, e?.message);
        }
      }
      await db.update(delegations).set({ status: "expirada", updatedAt: now }).where(eq(delegations.id, d.id));
      console.log(`[acessos-delegacoes] auto-retorno delegação ${d.id}: ${ok} devolvidos, ${fail} falhas -> titular ${d.fromUserId}`);
    }
  } catch (e: any) {
    console.error("[acessos-delegacoes] runDelegationReturns:", e?.message);
  }
}

// agendador: roda o executor logo após o boot e a cada 15 minutos (guardado p/ não duplicar)
export function startAutoReturnScheduler(): void {
  const g = globalThis as any;
  if (g.__delegAutoReturnStarted) return;
  g.__delegAutoReturnStarted = true;
  setTimeout(() => { void ensureModuleTables().then(runDelegationReturns); }, 20_000);
  setInterval(() => { void runDelegationReturns(); }, 15 * 60 * 1000);
  console.log("[acessos-delegacoes] agendador de devolução automática iniciado (a cada 15 min).");
}

export function registerDelegationRoutes(app: Express) {
  // bootstrap de tabelas + agendador (idempotentes; seguros para chamar no boot)
  void ensureModuleTables();
  startAutoReturnScheduler();

  // Lista de delegações — SELECT simples (sem API relacional) + targets numa 2ª query
  app.get("/api/delegations", authenticateAdmin, safe(async (_req, res) => {
    await ensureModuleTables();
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

  // Cria delegação (carteira ou acesso).
  // Parsing tolerante: aceita datas em texto (ISO) e injeta createdBy no servidor.
  app.post("/api/delegations", authenticateAdmin, safe(async (req, res) => {
    await ensureModuleTables();
    const b = req.body || {};
    if (!b.type || !b.startsAt || !b.endsAt)
      return res.status(400).json({ error: "type, startsAt e endsAt são obrigatórios" });
    const starts = new Date(b.startsAt), ends = new Date(b.endsAt);
    if (isNaN(starts.getTime()) || isNaN(ends.getTime()))
      return res.status(400).json({ error: "datas inválidas" });
    const targets: string[] = b.targets ?? [];
    const createdBy = (req as any).currentUser.id;

    const [deleg] = await db.insert(delegations).values({
      type: b.type,
      status: starts > new Date() ? "agendada" : "ativa",
      fromUserId: b.fromUserId ?? null,
      originRole: b.originRole ?? null,
      criteria: b.criteria ?? "nenhum",
      accesses: b.accesses ?? null,
      startsAt: starts,
      endsAt: ends,
      autoReturn: b.autoReturn ?? true,
      reason: b.reason ?? null,
      createdBy,
    } as any).returning();

    if (b.type === "acesso_funcao") {
      if (targets[0]) await db.insert(delegationTargets).values({ delegationId: deleg.id, toUserId: targets[0] });
    } else {
      const clientes = await carteiraDe(b.fromUserId);
      const recs = ratear(clientes, targets, b.criteria ?? "nenhum");
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

  // Importa uma carteira JÁ distribuída: registra a delegação a partir de uma
  // lista explícita de clientes, capturando o vendedor ATUAL de cada um como
  // destinatário (para auditoria). Na expiração, TODOS voltam ao titular.
  // body: { fromUserId, startsAt, endsAt, customerIds: string[], reason?, criteria? }
  app.post("/api/delegations/import-carteira", authenticateAdmin, safe(async (req, res) => {
    await ensureModuleTables();
    const { fromUserId, startsAt, endsAt, customerIds, reason, criteria } = req.body as {
      fromUserId: string; startsAt: string; endsAt: string; customerIds: string[]; reason?: string; criteria?: string;
    };
    if (!fromUserId || !Array.isArray(customerIds) || !customerIds.length || !startsAt || !endsAt) {
      return res.status(400).json({ error: "fromUserId, startsAt, endsAt e customerIds são obrigatórios" });
    }
    const createdBy = (req as any).currentUser.id;
    const starts = new Date(startsAt);
    const ends = new Date(endsAt);
    const now = new Date();
    const status = now < starts ? "agendada" : "ativa";

    // vendedor atual de cada cliente (destinatário para auditoria)
    const uniqIds = [...new Set(customerIds)];
    const rows = await db.select().from(customers).where(inArray(customers.id, uniqIds));
    const holderOf: Record<string, string> = {};
    rows.forEach((c: any) => { holderOf[c.id] = c.sellerId ?? "(sem)"; });
    const notFound = uniqIds.filter((id) => !(id in holderOf));

    const [deleg] = await db.insert(delegations).values({
      type: "carteira_rateio",
      status,
      fromUserId,
      criteria: (criteria as any) ?? "nenhum",
      startsAt: starts,
      endsAt: ends,
      autoReturn: true,
      reason: reason ?? "Importação de carteira já distribuída",
      createdBy,
    } as any).returning();

    // agrupa por destinatário atual
    const byHolder: Record<string, string[]> = {};
    for (const id of uniqIds) {
      const h = holderOf[id] ?? "(sem)";
      (byHolder[h] = byHolder[h] || []).push(id);
    }
    for (const [holder, ids] of Object.entries(byHolder)) {
      await db.insert(delegationTargets).values({
        delegationId: deleg.id, toUserId: holder, customerCount: ids.length,
      });
      await db.insert(delegationCustomers).values(
        ids.map((cid) => ({ delegationId: deleg.id, customerId: cid, toUserId: holder }))
      );
    }

    res.status(201).json({
      delegation: deleg,
      totalClientes: uniqIds.length,
      registrados: uniqIds.length - notFound.length,
      naoEncontrados: notFound,
      porDestinatarioAtual: Object.fromEntries(Object.entries(byHolder).map(([h, ids]) => [h, ids.length])),
    });
  }));

  // Revoga (devolve carteira/acessos ao titular)
  app.post("/api/delegations/:id/revoke", authenticateAdmin, safe(async (req, res) => {
    await db.update(delegations)
      .set({ status: "revogada", revokedBy: (req as any).currentUser.id, revokedAt: new Date() })
      .where(eq(delegations.id, req.params.id));
    res.json({ ok: true });
  }));

  // Executa a devolução AGORA (manual), respeitando o mesmo executor idempotente
  app.post("/api/delegations/run-returns", authenticateAdmin, safe(async (_req, res) => {
    await runDelegationReturns();
    res.json({ ok: true });
  }));

  // GET: overrides salvos p/ um usuário (o front mescla sobre o padrão da função)
  app.get("/api/user-permissions/:userId", authenticateAdmin, safe(async (req, res) => {
    await ensureModuleTables();
    const [row] = await db.select().from(userPermissions).where(eq(userPermissions.userId, req.params.userId));
    res.json(row?.permissions ?? {});
  }));

  // PUT: grava o mapa completo de permissões (upsert por usuário)
  app.put("/api/user-permissions/:userId", authenticateAdmin, safe(async (req, res) => {
    await ensureModuleTables();
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
