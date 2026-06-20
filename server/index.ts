import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, log } from "./vite";
import { initializeDefaultAdmin } from "./localAuth";
import path from "path";
import "./scheduler";
import { startSyncWorker, runSync, resetSyncTimestamp } from "./sync-1.0";
import { startSync20Worker, runSync20, resetSync20Timestamp } from "./sync-2.0";
import { db } from "./db";
import { sql } from "drizzle-orm";

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
  
  app.get('/clear-cache', (_req, res) => {
    res.set({
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.send(`<!DOCTYPE html>
<html><head><title>Limpando Cache</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#059669}
.card{background:#fff;border-radius:16px;padding:32px;max-width:400px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2)}
h1{color:#059669;font-size:1.5rem}#status{color:#333;margin:16px 0}#logs{background:#f3f4f6;border-radius:8px;padding:12px;text-align:left;font-size:13px;max-height:200px;overflow-y:auto}
.log{padding:4px 0;border-bottom:1px solid #e5e7eb;color:#555}.spinner{display:inline-block;width:40px;height:40px;border:4px solid #d1fae5;border-top:4px solid #059669;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="card"><h1>Limpando Cache</h1><div class="spinner" id="spinner"></div>
<div id="status">Iniciando...</div><div id="logs"></div></div>
<script>
var logs=document.getElementById('logs'),st=document.getElementById('status'),sp=document.getElementById('spinner');
function addLog(m){var d=document.createElement('div');d.className='log';d.textContent=m;logs.appendChild(d)}
async function run(){try{
if('serviceWorker' in navigator){var regs=await navigator.serviceWorker.getRegistrations();for(var r of regs){await r.unregister();addLog('Service Worker removido')}}
if('caches' in window){var keys=await caches.keys();for(var k of keys){await caches.delete(k);addLog('Cache '+k+' removido')}}
localStorage.clear();addLog('localStorage limpo');
sessionStorage.clear();addLog('sessionStorage limpo');
st.textContent='Limpeza concluida!';sp.style.display='none';
addLog('Redirecionando em 2s...');
setTimeout(function(){window.location.href='/?t='+Date.now()},2000);
}catch(e){st.textContent='Erro: '+e.message;setTimeout(function(){window.location.href='/?t='+Date.now()},3000)}}
run();
</script></body></html>`);
  });

  const server = await registerRoutes(app);

  await initializeDefaultAdmin();

  startSyncWorker();      // Sync 1.0 → 2.0
  startSync20Worker();    // Sync 2.0 → 1.0

  // ── Sync Monitor API ──────────────────────────────────────────────────
  // GET /api/admin/sync-status — last sync timestamps from system_settings
  app.get('/api/admin/sync-status', async (_req, res) => {
    try {
      const result = await db.execute(
        sql`SELECT key, value, updated_at FROM system_settings WHERE key IN ('sync_1_0_last_at','sync_2_0_last_at')`
      );
      res.json(result.rows || []);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // POST /api/admin/sync/trigger-1to2 — manual trigger Integra 1.0→2.0
  app.post('/api/admin/sync/trigger-1to2', async (_req, res) => {
    try {
      await runSync();
      res.json({ success: true, message: 'Sync 1.0→2.0 executado com sucesso' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // POST /api/admin/sync/trigger-2to1 — manual trigger Integra 2.0→1.0
  app.post('/api/admin/sync/trigger-2to1', async (_req, res) => {
    try {
      const result = await runSync20();
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // ─────────────────────────────────────────────────────────────────────

  // GET /api/admin/sync/source-tables
  app.get('/api/admin/sync/source-tables', async (_req, res) => {
    const pg = await import('pg');
    const client = new pg.default.Client({
      connectionString: process.env.REPLIT_DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
      );
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      await client.end().catch(() => {});
    }
  });

  // GET /api/admin/sync/audit — row counts in both source (Neon) and target (Railway)
  app.get('/api/admin/sync/audit', async (_req, res) => {
    const pgMod = await import('pg');
    const TABLES = ['omie_instances','users','routes','customers','billings','products','sales_cards','virtual_service_logs','prospections'];
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      await tgt.connect();
      const results = await Promise.all(TABLES.map(async t => {
        const [s, d] = await Promise.all([
          src.query('SELECT COUNT(*)::int AS n FROM ' + '"'+ t +'"').catch(() => ({rows:[{n:-1}]})),
          tgt.query('SELECT COUNT(*)::int AS n FROM ' + '"'+ t +'"').catch(() => ({rows:[{n:-1}]}))
        ]);
        return { table: t, source: s.rows[0].n, target: d.rows[0].n, diff: d.rows[0].n - s.rows[0].n };
      }));
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      await src.end().catch(() => {});
      await tgt.end().catch(() => {});
    }
  });

  // POST /api/admin/sync/full-reset
  app.post('/api/admin/sync/full-reset', async (_req, res) => {
    try {
      await resetSyncTimestamp();
      await runSync();
      res.json({ success: true, message: "Full resync concluído — todos os dados sincronizados desde o início" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/sync/full-reset-both — reset AMBOS timestamps e roda sync bidirecional
  app.post('/api/admin/sync/full-reset-both', async (_req, res) => {
    try {
      await resetSyncTimestamp();        // reset 1.0→2.0 timestamp
      await resetSync20Timestamp();      // reset 2.0→1.0 timestamp
      const r1 = await runSync();        // sync 1.0→2.0
      const r2 = await runSync20();      // sync 2.0→1.0
      res.json({ success: true, sync1to2: r1, sync2to1: r2 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
  });

  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    const distPath = path.join(process.cwd(), "dist", "public");
    app.use(express.static(distPath));
    app.use("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
