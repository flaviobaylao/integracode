/**
 * server/routes/index.ts
 *
 * Central router registry for Integra 2.0.
 *
 * MIGRATION PLAN (task #6):
 * The current monolithic routes.ts (~2500 lines) is being incrementally
 * split into domain-specific sub-routers.  Each sub-module exports a single
 * Router that is mounted here.
 *
 * Migration order (safest-first):
 *   1. auth       — login/logout/session   ← NEXT
 *   2. users      — CRUD + roles
 *   3. customers  — customer endpoints
 *   4. products   — product catalogue
 *   5. orders     — sales cards / Omie orders
 *   6. billing    — billings + sync
 *   7. reports    — report engine
 *   8. routes     — route planning
 *   9. ai         — OpenAI / chat endpoints
 *  10. misc       — everything else
 *
 * Until a domain is migrated, its routes are still served by the legacy
 * server/routes.ts (registered via registerRoutes()).
 */

import { Router, type Express } from "express";
import { createServer, type Server } from "http";

// ── Domain sub-routers (added as they are extracted from routes.ts) ──────────
// import { authRouter }      from "./auth";
// import { usersRouter }     from "./users";
// import { customersRouter } from "./customers";

// ── Health-check (always present) ─────────────────────────────────────────────
import { healthRouter } from "./health";

export function mountRouters(app: Express): Server {
  const server = createServer(app);

  // Health (no auth required)
  app.use("/api", healthRouter);

  // TODO: mount domain routers here as they are extracted
  // app.use("/api/auth",      authRouter);
  // app.use("/api/users",     usersRouter);
  // app.use("/api/customers", customersRouter);

  return server;
}
