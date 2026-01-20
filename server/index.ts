import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeDefaultAdmin } from "./localAuth";
import path from "path";
import "./scheduler";

const app = express();

// MIDDLEWARE DE CACHE-BUSTING - Force o navegador a buscar versões novas
app.use((req, res, next) => {
  // Para HTML e JavaScript, NUNCA fazer cache
  if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path === '/' || !req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// DEBUG: Log ALL POST requests immediately to console
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`📫 [POST-DETECT] ${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

// Middleware condicional para JSON - NÃO processar requisições multipart/form-data
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Deixar o multer processar essas requisições
    return next();
  }
  express.json()(req, res, next);
});

// Middleware condicional para urlencoded - NÃO processar requisições multipart/form-data
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Deixar o multer processar essas requisições
    return next();
  }
  express.urlencoded({ extended: false })(req, res, next);
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Configurar hotsite ANTES de todas as rotas para evitar interceptação do Vite
  const isDevelopment = app.get("env") === "development";
  
  // ✅ SERVIR HOTSITE EM AMBOS OS MODOS (desenvolvimento e produção)
  const distHotsitePath = path.join(process.cwd(), "server", "public-hotsite");
  log("🏪 Servindo hotsite de " + distHotsitePath);
  
  // Servir arquivos estáticos do hotsite com fallthrough disabled
  app.use('/shop', express.static(distHotsitePath, { fallthrough: false }));
  
  // Catch-all para servir index.html em rotas do hotsite
  app.all('/shop*', (_req, res) => {
    res.sendFile(path.join(distHotsitePath, "index.html"));
  });
  
  const server = await registerRoutes(app);

  // Inicializar admin padrão se não existir (importante para primeira execução em produção)
  await initializeDefaultAdmin();

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    console.error(`🔥 [ERROR HANDLER] ${req.method} ${req.path}:`, err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
