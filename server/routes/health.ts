// ATENCAO: este router NAO esta montado. `mountRouters()` (server/routes/index.ts) nunca e
// chamado — server/index.ts importa `registerRoutes` de "./routes", que o bundler resolve para
// o ARQUIVO server/routes.ts, nao para este diretorio. O /api/health que o Railway usa
// (healthcheckPath no railway.json) e o de server/routes.ts. Este arquivo e o esqueleto da
// refatoracao descrita em server/routes/index.ts; mantido de proposito, mas nao vale nada em
// runtime — nao edite este esperando mudar o health check.
import { Router } from "express";

export const healthRouter = Router();

/**
 * GET /api/health
 * Liveness probe for Railway and load balancers.
 */
healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV ?? "development",
  });
});
