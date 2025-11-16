import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { initializeProducts, initializeQuickMessages } from "./init-products";
import { storage } from "./storage";
import { agentActivityService } from "./agent-activity-service";
import { whatsappOfficialAPI } from "./whatsapp-official-api";
import { evolutionAPIService } from "./evolution-api-service";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
  const server = await registerRoutes(app);
  
  // Inicializar produtos e mensagens rápidas
  setTimeout(async () => {
    await initializeProducts();
    // Obter ID do admin para criar mensagens rápidas
    const admin = await storage.getUserByUsername("Flavio");
    if (admin) {
      await initializeQuickMessages(admin.id);
    }
    
    // Iniciar sistema de monitoramento de atividade dos agentes
    agentActivityService.startHeartbeatMonitoring();
    
    // Inicializar API oficial do WhatsApp se configurada
    try {
      const accessTokenSetting = await storage.getSystemSetting('whatsapp_access_token');
      const phoneNumberIdSetting = await storage.getSystemSetting('whatsapp_phone_number_id');
      const webhookTokenSetting = await storage.getSystemSetting('whatsapp_webhook_verify_token');
      const businessAccountIdSetting = await storage.getSystemSetting('whatsapp_business_account_id');
      
      if (accessTokenSetting && phoneNumberIdSetting && webhookTokenSetting) {
        whatsappOfficialAPI.configure({
          accessToken: accessTokenSetting.value,
          phoneNumberId: phoneNumberIdSetting.value,
          webhookVerifyToken: webhookTokenSetting.value,
          businessAccountId: businessAccountIdSetting?.value
        });
        console.log('✅ API oficial do WhatsApp inicializada automaticamente');
      } else {
        console.log('⚠️  API oficial do WhatsApp não configurada - use o painel administrativo para configurar');
      }
    } catch (error) {
      console.error('❌ Erro ao inicializar API oficial do WhatsApp:', error);
    }

    // Inicializar Evolution API se configurada
    try {
      const evolutionApiUrl = await storage.getSystemSetting('evolution_api_url');
      const evolutionApiKey = await storage.getSystemSetting('evolution_api_key');
      const evolutionInstanceName = await storage.getSystemSetting('evolution_instance_name');
      
      if (evolutionApiUrl && evolutionApiKey && evolutionInstanceName) {
        evolutionAPIService.configure({
          apiUrl: evolutionApiUrl.value,
          apiKey: evolutionApiKey.value,
          instanceName: evolutionInstanceName.value
        });
        console.log('✅ Evolution API inicializada automaticamente');
      } else {
        console.log('⚠️  Evolution API não configurada - use o painel administrativo para configurar');
      }
    } catch (error) {
      console.error('❌ Erro ao inicializar Evolution API:', error);
    }
  }, 2000); // Aguardar 2 segundos para garantir que o banco esteja pronto

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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
