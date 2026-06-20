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
  app.post('/api/admin/sync/trigger-2to1', (_req, res) => {
    res.json({ success: true, message: 'Sync 2.0→1.0 iniciado em background' });
    runSync20().catch((err: any) => logger.error({ err: err.message }, 'trigger-2to1 falhou'));
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

  // GET /api/admin/sync/billing-debug — compare billings columns in source vs target
  app.get('/api/admin/sync/billing-debug', async (_req, res) => {
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const colQuery = "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' ORDER BY ordinal_position";
      const [srcCols, tgtCols] = await Promise.all([src.query(colQuery), tgt.query(colQuery)]);
      const srcNames = new Set(srcCols.rows.map((r:any) => r.column_name));
      const tgtNames = new Set(tgtCols.rows.map((r:any) => r.column_name));
      const inBoth = tgtCols.rows.filter((r:any) => srcNames.has(r.column_name));
      const tgtOnly = tgtCols.rows.filter((r:any) => !srcNames.has(r.column_name));
      const srcOnly = srcCols.rows.filter((r:any) => !tgtNames.has(r.column_name));
      // Also try inserting 1 row
      const sample = await src.query("SELECT * FROM billings LIMIT 1");
      res.json({ inBoth: inBoth.map((r:any)=>r.column_name), tgtOnly, srcOnly: srcOnly.map((r:any)=>r.column_name), sampleKeys: sample.rows[0] ? Object.keys(sample.rows[0]) : [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      await src.end().catch(()=>{}); await tgt.end().catch(()=>{});
    }
  });

  // GET /api/admin/sync/billing-col-types — compare column data types between source and target billings
app.get('/api/admin/sync/billing-col-types', async (_req, res) => {
  const pgMod = await import('pg');
  const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await src.connect(); await tgt.connect();
    const q = "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' ORDER BY ordinal_position";
    const [srcT, tgtT] = await Promise.all([src.query(q), tgt.query(q)]);
    const srcMap: any = {}; srcT.rows.forEach((r: any) => { srcMap[r.column_name] = r.data_type + '/' + r.udt_name; });
    const tgtMap: any = {}; tgtT.rows.forEach((r: any) => { tgtMap[r.column_name] = r.data_type + '/' + r.udt_name; });
    const diffs = Object.keys(srcMap).filter(c => srcMap[c] !== tgtMap[c]).map(c => ({ col: c, src: srcMap[c], tgt: tgtMap[c] }));
    res.json({ diffs, srcCols: srcMap, tgtCols: tgtMap });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await src.end().catch(() => {}); await tgt.end().catch(() => {});
  }
});

// GET /api/admin/sync/billing-dry-run — try inserting 1 billing with type coercion
app.get('/api/admin/sync/billing-dry-run', async (_req, res) => {
  const pgMod = await import('pg');
  const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await src.connect(); await tgt.connect();
    const [srcColsRes, tgtColsRes, tgtTypesRes] = await Promise.all([
      src.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' ORDER BY ordinal_position"),
      tgt.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' ORDER BY ordinal_position"),
      tgt.query("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings'"),
    ]);
    const tgtSet = new Set(tgtColsRes.rows.map((r: any) => r.column_name));
    const jsonbSet = new Set(tgtTypesRes.rows.filter((r: any) => r.udt_name === 'json' || r.udt_name === 'jsonb').map((r: any) => r.column_name));
    const cols = srcColsRes.rows.map((r: any) => r.column_name).filter((c: string) => tgtSet.has(c));
    const colsSql = cols.map((c: string) => `"${c}"`).join(", ");
    const setClauses = cols.filter((c: string) => c !== "id").map((c: string) => `"${c}" = EXCLUDED."${c}"`).join(", ");
    const row1 = await src.query("SELECT * FROM billings LIMIT 1");
    if (!row1.rows[0]) { res.json({ result: "no source rows" }); return; }
    const row = row1.rows[0];
    // Type-coerce values: serialize objects for json/jsonb columns
    const vals = cols.map((c: string) => {
      const v = row[c];
      if (v !== null && jsonbSet.has(c) && typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    const ph = cols.map((_: any, i: number) => "$" + (i + 1)).join(", ");
    const nullCols = cols.filter((c: string) => row[c] === null || row[c] === undefined);
    const productsType = typeof row.products;
    const productsIsObj = row.products !== null && typeof row.products === 'object';
    try {
      await tgt.query(`INSERT INTO "billings" (${colsSql}) VALUES (${ph}) ON CONFLICT ("id") DO UPDATE SET ${setClauses}`, vals);
      res.json({ result: "success", id: row.id, nullCols, productsType, productsIsObj });
    } catch (insertErr: any) {
      res.json({ result: "error", error: insertErr.message, id: row.id, nullCols, productsType, productsIsObj, billing_type: row.billing_type });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await src.end().catch(() => {}); await tgt.end().catch(() => {});
  }
});


// GET /api/admin/sync/billing-type-values — distinct billing_type values in source
app.get('/api/admin/sync/billing-type-values', async (_req, res) => {
  const pgMod = await import('pg');
  const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await src.connect();
    const [types, nulls, total] = await Promise.all([
      src.query("SELECT billing_type::text, COUNT(*)::int AS n FROM billings GROUP BY billing_type ORDER BY n DESC"),
      src.query("SELECT COUNT(*)::int AS nulls FROM billings WHERE billing_type IS NULL"),
      src.query("SELECT COUNT(*)::int AS total FROM billings"),
    ]);
    res.json({ total: total.rows[0].total, nullCount: nulls.rows[0].nulls, distinctValues: types.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    await src.end().catch(() => {});
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
      res.json({ success: true, message: 'Timestamps resetados. Sync bidirecional iniciado em background.' });
      runSync().catch((e: any) => logger.error({ err: e.message }, '1.0→2.0 bg falhou'));
      runSync20().catch((e: any) => logger.error({ err: e.message }, '2.0→1.0 bg falhou'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/sync/debug-billings — sync billings only with detailed error reporting
  app.post('/api/admin/sync/debug-billings', async (_req: Request, res: Response) => {
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const [tgtColsRes, tgtJsonRes] = await Promise.all([
        tgt.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' ORDER BY ordinal_position"),
        tgt.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billings' AND udt_name IN ('json','jsonb')")
      ]);
      const tgtColSet = new Set(tgtColsRes.rows.map((r: any) => r.column_name as string));
      const jsonbCols = new Set(tgtJsonRes.rows.map((r: any) => r.column_name as string));
      const LIMIT = 500; const BATCH = 50;
      let offset = 0; let upserted = 0; const errors: string[] = [];
      while (true) {
        const dataRes = await src.query(`SELECT * FROM "billings" ORDER BY "id" LIMIT ${LIMIT} OFFSET $1`, [offset]);
        if (dataRes.rows.length === 0) break;
        const cols = Object.keys(dataRes.rows[0]).filter(c => tgtColSet.has(c));
        const colsSql = cols.map(c => `"${c}"`).join(', ');
        const setClauses = cols.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
        for (let i = 0; i < dataRes.rows.length; i += BATCH) {
          const batch = dataRes.rows.slice(i, i + BATCH);
          const ph = batch.map((_: any, ri: number) => '(' + cols.map((_: any, ci: number) => '$' + (ri * cols.length + ci + 1)).join(',') + ')').join(',');
          const flat = batch.flatMap((r: any) => cols.map(c => { const v = r[c]; if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; }));
          try {
            await tgt.query(`INSERT INTO "billings" (${colsSql}) VALUES ${ph} ON CONFLICT ("id") DO UPDATE SET ${setClauses}`, flat);
            upserted += batch.length;
          } catch (be: any) {
            for (const row of batch) {
              const rv = cols.map(c => { const v = row[c]; if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; });
              const rph = cols.map((_: any, i: number) => '$' + (i + 1)).join(',');
              try { await tgt.query(`INSERT INTO "billings" (${colsSql}) VALUES (${rph}) ON CONFLICT ("id") DO UPDATE SET ${setClauses}`, rv); upserted++; }
              catch (re: any) { if (errors.length < 10) errors.push('id=' + row.id + ': ' + re.message.substring(0, 120)); }
            }
          }
        }
        if (dataRes.rows.length < LIMIT) break;
        offset += LIMIT;
      }
      res.json({ success: true, upserted, errorCount: errors.length, firstErrors: errors });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      await src.end().catch(() => {}); await tgt.end().catch(() => {});
    }
  });

  // POST /api/admin/sync/fix-billings-schema — drop NOT NULL on nullable columns
  app.post('/api/admin/sync/fix-billings-schema', async (_req: Request, res: Response) => {
    try {
      const pgMod = await import('pg');
      const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await tgt.connect();
      try {
        const results: string[] = [];
        // Check which columns are NOT NULL in target but nullable in source
        const nullableCols = await tgt.query(`
          SELECT column_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'billings'
          AND is_nullable = 'NO'
          AND column_name NOT IN ('id')
          ORDER BY ordinal_position
        `);
        // Drop NOT NULL on order_date specifically (null in source)
        const colsToDrop = ['order_date', 'order_number', 'customer_id', 'customer_fantasy_name', 'seller_id', 'route_id', 'total_value', 'billing_type', 'is_cancelled', 'is_urgent', 'stage_name', 'vehicle_types', 'delivery_time_slots', 'delivery_saturday_time_slots'];
        for (const col of colsToDrop) {
          const exists = nullableCols.rows.find((r: any) => r.column_name === col);
          if (exists) {
            await tgt.query(`ALTER TABLE billings ALTER COLUMN "${col}" DROP NOT NULL`);
            results.push(`Dropped NOT NULL on ${col}`);
          }
        }
        res.json({ success: true, changes: results, notNullCols: nullableCols.rows.map((r: any) => r.column_name) });
      } finally {
        await tgt.end().catch(() => {});
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });


  // POST /api/admin/sync/diagnose — find rows in 1.0 not in 2.0 and capture exact errors
  app.post('/api/admin/sync/diagnose', async (req: Request, res: Response) => {
    const tbl = (req.body?.table || 'billings') as string;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      // Get column lists
      const srcColsRes = await src.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [tbl]);
      const tgtColsRes = await tgt.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [tbl]);
      const tgtSet = new Set(tgtColsRes.rows.map((r: any) => r.column_name as string));
      const jsonRes = await tgt.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND udt_name IN ('json','jsonb')", [tbl]);
      const jsonCols = new Set(jsonRes.rows.map((r: any) => r.column_name as string));
      const cols = srcColsRes.rows.map((r: any) => r.column_name as string).filter((c: string) => tgtSet.has(c));
      const colsSql = cols.map((c: string) => '"' + c + '"').join(', ');
      const setClauses = cols.filter((c: string) => c !== 'id').map((c: string) => '"' + c + '" = EXCLUDED."' + c + '"').join(', ');
      const ph = cols.map((_: any, i: number) => '$' + (i + 1)).join(', ');
      // Counts
      const srcCnt = (await src.query('SELECT COUNT(*) FROM "' + tbl + '"')).rows[0].count;
      const tgtCnt = (await tgt.query('SELECT COUNT(*) FROM "' + tbl + '"')).rows[0].count;
      // Find IDs in src not in tgt (sample 200)
      const srcIds = (await src.query('SELECT id FROM "' + tbl + '" ORDER BY id LIMIT 500')).rows.map((r: any) => r.id);
      const tgtIds = new Set((await tgt.query('SELECT id FROM "' + tbl + '" WHERE id = ANY($1::text[])', [srcIds])).rows.map((r: any) => r.id));
      const missingIds = srcIds.filter((id: string) => !tgtIds.has(id)).slice(0, 20);
      // Try inserting each missing row
      const errors: any[] = [];
      for (const id of missingIds) {
        const rowRes = await src.query('SELECT ' + cols.map((c: string) => '"' + c + '"').join(',') + ' FROM "' + tbl + '" WHERE id=$1', [id]);
        if (!rowRes.rows[0]) continue;
        const row = rowRes.rows[0];
        const vals = cols.map((c: string) => { const v = row[c]; if (v !== null && jsonCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; });
        try {
          await tgt.query('INSERT INTO "' + tbl + '" (' + colsSql + ') VALUES (' + ph + ') ON CONFLICT (id) DO UPDATE SET ' + setClauses, vals);
          errors.push({ id, result: 'ok' });
        } catch (e: any) {
          errors.push({ id, error: e.message.substring(0, 200) });
        }
      }
      res.json({ srcCnt, tgtCnt, missingCount: missingIds.length, results: errors });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(()=>{}); await tgt.end().catch(()=>{}); }
  });

  // POST /api/admin/sync/compare — compara CONTEÚDO real linha-a-linha (hash dos campos) entre 1.0 (Neon) e 2.0 (Railway)
  // READ-ONLY: apenas SELECTs nos dois bancos. Body: { table, exclude?: string[], sample?: number }
  app.post('/api/admin/sync/compare', async (req: Request, res: Response) => {
    const tbl = (req.body?.table || 'customers') as string;
    const excludeCols: string[] = Array.isArray(req.body?.exclude) ? req.body.exclude : [];
    const sampleLimit = Math.min(parseInt(req.body?.sample) || 15, 50);
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      // Força UTC nas duas conexões para timestamps comparáveis (evita falso-positivo de fuso)
      await src.query("SET TIME ZONE 'UTC'"); await tgt.query("SET TIME ZONE 'UTC'");
      const colQ = "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name";
      const [sc, tc] = await Promise.all([src.query(colQ, [tbl]), tgt.query(colQ, [tbl])]);
      const sCols = new Set(sc.rows.map((r: any) => r.column_name as string));
      const tCols = new Set(tc.rows.map((r: any) => r.column_name as string));
      const cols = [...sCols].filter(c => tCols.has(c) && !excludeCols.includes(c)).sort();
      const srcOnlyCols = [...sCols].filter(c => !tCols.has(c));
      const tgtOnlyCols = [...tCols].filter(c => !sCols.has(c));
      if (cols.length === 0) { res.json({ error: 'sem colunas comuns', table: tbl }); return; }
      if (!cols.includes('id')) { res.json({ error: 'tabela sem coluna id', table: tbl }); return; }
      // Expressão de hash: md5 do concat de todas as colunas comuns (ordem alfabética estável) como texto
      const hashExpr = 'md5(concat_ws(\'|\', ' + cols.map(c => `COALESCE("${c}"::text,'∅')`).join(', ') + '))';
      const sel = `SELECT id::text AS id, ${hashExpr} AS h FROM "${tbl}"`;
      const [sr, tr] = await Promise.all([src.query(sel), tgt.query(sel)]);
      const sMap = new Map<string, string>(sr.rows.map((r: any) => [r.id, r.h]));
      const tMap = new Map<string, string>(tr.rows.map((r: any) => [r.id, r.h]));
      const onlySrc: string[] = []; const diff: string[] = [];
      for (const [id, h] of sMap) { if (!tMap.has(id)) onlySrc.push(id); else if (tMap.get(id) !== h) diff.push(id); }
      const onlyTgt: string[] = [];
      for (const id of tMap.keys()) { if (!sMap.has(id)) onlyTgt.push(id); }
      // Amostra de divergências de conteúdo: busca as linhas e aponta exatamente os campos diferentes
      const sampleDiffs: any[] = [];
      const colListSel = cols.map(c => `"${c}"::text AS "${c}"`).join(', ');
      for (const id of diff.slice(0, sampleLimit)) {
        const [sRow, tRow] = await Promise.all([
          src.query(`SELECT ${colListSel} FROM "${tbl}" WHERE id::text=$1`, [id]),
          tgt.query(`SELECT ${colListSel} FROM "${tbl}" WHERE id::text=$1`, [id]),
        ]);
        const a = sRow.rows[0] || {}; const b = tRow.rows[0] || {};
        const fields: any = {};
        for (const c of cols) {
          const av = a[c] ?? null; const bv = b[c] ?? null;
          if (av !== bv) fields[c] = { src: av, tgt: bv };
        }
        if (Object.keys(fields).length > 0) sampleDiffs.push({ id, fields });
      }
      res.json({
        table: tbl,
        columnsCompared: cols.length,
        excluded: excludeCols,
        srcOnlyColumns: srcOnlyCols,
        tgtOnlyColumns: tgtOnlyCols,
        srcCount: sMap.size,
        tgtCount: tMap.size,
        onlyInSrc: onlySrc.length,
        onlyInTgt: onlyTgt.length,
        contentDiff: diff.length,
        identical: onlySrc.length === 0 && onlyTgt.length === 0 && diff.length === 0,
        onlyInSrcSample: onlySrc.slice(0, 10),
        onlyInTgtSample: onlyTgt.slice(0, 10),
        sampleDiffs,
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

  // POST /api/admin/sync/align-columns — adiciona ao 2.0 as colunas que existem no 1.0 (Neon) e faltam no 2.0 (Railway).
  // ADITIVO e SEGURO: ADD COLUMN IF NOT EXISTS, sempre nullable, sem default, sem reescrita de tabela. Tipos copiados do 1.0.
  // Body: { table: string, dryRun?: boolean }. Use dryRun:true para PRÉ-VISUALIZAR o que seria criado sem executar.
  app.post('/api/admin/sync/align-columns', async (req: Request, res: Response) => {
    const tbl = (req.body?.table || '') as string;
    if (!tbl) { res.status(400).json({ error: 'informe table' }); return; }
    const dryRun = req.body?.dryRun === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      // Tipos exatos do 1.0 via format_type (cobre varchar(n), numeric(p,s), text[], jsonb, timestamp, etc.)
      const typeQ = `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS coltype
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`;
      const srcTypes = (await src.query(typeQ, [tbl])).rows as Array<{ col: string; coltype: string }>;
      if (srcTypes.length === 0) { res.json({ table: tbl, error: 'tabela não existe no 1.0 (source)' }); return; }
      const tgtCols = new Set((await tgt.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [tbl]
      )).rows.map((r: any) => r.column_name as string));
      if (tgtCols.size === 0) { res.json({ table: tbl, error: 'tabela não existe no 2.0 (target)' }); return; }
      const missing = srcTypes.filter(r => !tgtCols.has(r.col));
      const planned = missing.map(m => `ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "${m.col}" ${m.coltype}`);
      if (dryRun) { res.json({ table: tbl, dryRun: true, missing: missing.map(m => ({ col: m.col, type: m.coltype })), planned }); return; }
      const added: string[] = []; const errors: any[] = [];
      for (const m of missing) {
        try {
          await tgt.query(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "${m.col}" ${m.coltype}`);
          added.push(m.col);
        } catch (e: any) {
          errors.push({ col: m.col, type: m.coltype, error: e.message.substring(0, 150) });
        }
      }
      res.json({ table: tbl, added, errors, message: `Adicionadas ${added.length} coluna(s). Rode full-reset para popular.` });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
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
