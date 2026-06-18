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
