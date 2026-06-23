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
    app.get('/api/reports/clientes-sem-pedido', async (req: Request, res: Response) => {
    try {
      const dias = Math.max(1, Math.min(parseInt(String(req.query.dias)) || 30, 365));
      const result: any = await db.execute(sql`
        WITH pip AS (
          SELECT customer_id, max(created_at) AS last_order
          FROM billing_pipeline
          GROUP BY customer_id
        ),
        bil AS (
          SELECT translate(coalesce(customer_document, ''), './- ', '') AS doc,
                 max(invoice_date) AS last_inv
          FROM billings
          WHERE char_length(translate(coalesce(customer_document, ''), './- ', '')) >= 11
          GROUP BY 1
        ),
        base AS (
          SELECT c.id, c.name,
                 coalesce(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), c.seller_id, 'sem vendedor') AS vendedor,
                 greatest(pip.last_order, bil.last_inv) AS ultima_compra
          FROM customers c
          LEFT JOIN pip ON pip.customer_id = c.id
          LEFT JOIN bil ON bil.doc = translate(coalesce(NULLIF(c.document, ''), c.cpf, c.cnpj, ''), './- ', '')
          LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(c.seller_id, 'omie-vendor-', ''))
          WHERE c.is_active = true AND c.is_lead = false
        )
        SELECT id, name, vendedor,
               to_char(ultima_compra, 'YYYY-MM-DD') AS ultima_compra,
               CASE WHEN ultima_compra IS NULL THEN 'nunca_comprou'
                    WHEN ultima_compra > now() - make_interval(days => ${dias}::int) THEN 'comprou'
                    ELSE 'parou' END AS status
        FROM base
        ORDER BY vendedor, status, ultima_compra NULLS LAST
      `);
      const rows: any[] = result.rows || [];
      const porVendedor: Record<string, any> = {};
      for (const r of rows) {
        const v = r.vendedor || 'sem vendedor';
        porVendedor[v] = porVendedor[v] || { vendedor: v, total: 0, comprou: 0, parou: 0, nunca_comprou: 0 };
        porVendedor[v].total++;
        porVendedor[v][r.status] = (porVendedor[v][r.status] || 0) + 1;
      }
      res.json({
        gerado_em: new Date().toISOString(),
        dias,
        total: rows.length,
        resumo: {
          comprou: rows.filter(r => r.status === 'comprou').length,
          parou: rows.filter(r => r.status === 'parou').length,
          nunca_comprou: rows.filter(r => r.status === 'nunca_comprou').length,
        },
        por_vendedor: Object.values(porVendedor).sort((a: any, b: any) => (b.parou + b.nunca_comprou) - (a.parou + a.nunca_comprou)),
        clientes: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Relatório IA: dashboard consolidado de vendas ────────────────────────
  // GET /api/reports/ia-dashboard?dias=30  — READ-ONLY
  // Fonte-verdade de vendas = billing_pipeline (vivo); débitos = overdue_debts.
  app.get('/api/reports/ia-dashboard', async (req: Request, res: Response) => {
    try {
      const dias = Math.max(1, Math.min(parseInt(String(req.query.dias)) || 30, 365));

      // 1) Resumo de carteira: comprou / parou / nunca (clientes ativos não-lead)
      const carteira: any = await db.execute(sql`
        WITH pip AS (
          SELECT customer_id, max(created_at) AS last_order
          FROM billing_pipeline GROUP BY customer_id
        ),
        base AS (
          SELECT c.id,
                 coalesce(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), c.seller_id, 'sem vendedor') AS vendedor,
                 pip.last_order AS ultima_compra
          FROM customers c
          LEFT JOIN pip ON pip.customer_id = c.id
          LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(c.seller_id, 'omie-vendor-', ''))
          WHERE c.is_active = true AND c.is_lead = false
        )
        SELECT vendedor,
               count(*)::int AS ativos,
               count(*) FILTER (WHERE ultima_compra > now() - make_interval(days => ${dias}::int))::int AS comprou,
               count(*) FILTER (WHERE ultima_compra IS NOT NULL AND ultima_compra <= now() - make_interval(days => ${dias}::int))::int AS parou,
               count(*) FILTER (WHERE ultima_compra IS NULL)::int AS nunca
        FROM base GROUP BY vendedor
      `);
      const cart = (carteira.rows || []) as any[];
      const resumo_carteira = cart.reduce((a: any, r: any) => ({
        ativos: a.ativos + Number(r.ativos),
        comprou: a.comprou + Number(r.comprou),
        parou: a.parou + Number(r.parou),
        nunca: a.nunca + Number(r.nunca),
      }), { ativos: 0, comprou: 0, parou: 0, nunca: 0 });

      // 2) Vendas no período (billing_pipeline) por vendedor
      const vendas: any = await db.execute(sql`
        SELECT coalesce(NULLIF(trim(bp.seller_name), ''),
                        NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''),
                        bp.seller_id, 'sem vendedor') AS vendedor,
               count(*)::int AS pedidos,
               coalesce(sum(bp.sale_value), 0)::float AS valor_total
        FROM billing_pipeline bp
        LEFT JOIN users u ON (u.omie_vendor_code = bp.seller_id OR u.omie_vendor_code = replace(coalesce(bp.seller_id,''), 'omie-vendor-', ''))
        WHERE bp.created_at > now() - make_interval(days => ${dias}::int)
        GROUP BY 1 ORDER BY valor_total DESC
      `);
      const vendasRows = (vendas.rows || []) as any[];

      // merge ranking: vendas + carteira(parou/nunca)
      const cartMap: Record<string, any> = {};
      for (const r of cart) cartMap[r.vendedor] = r;
      const rankSet = new Set<string>([...vendasRows.map(v => v.vendedor), ...cart.map(c => c.vendedor)]);
      const ranking_vendedores = Array.from(rankSet).map((v) => {
        const ven = vendasRows.find(x => x.vendedor === v) || { pedidos: 0, valor_total: 0 };
        const c = cartMap[v] || { ativos: 0, comprou: 0, parou: 0, nunca: 0 };
        const pedidos = Number(ven.pedidos) || 0;
        const valor = Number(ven.valor_total) || 0;
        return {
          vendedor: v,
          pedidos,
          valor_total: valor,
          ticket_medio: pedidos > 0 ? valor / pedidos : 0,
          ativos: Number(c.ativos) || 0,
          comprou: Number(c.comprou) || 0,
          parou: Number(c.parou) || 0,
          nunca: Number(c.nunca) || 0,
        };
      }).sort((a, b) => b.valor_total - a.valor_total);

      // 3) Pipeline por estágio (snapshot atual, total)
      const estagios: any = await db.execute(sql`
        SELECT stage, count(*)::int AS qtd, coalesce(sum(sale_value), 0)::float AS valor
        FROM billing_pipeline GROUP BY stage ORDER BY qtd DESC
      `);

      // 4) Vendas por dia no período (para gráfico)
      const porDia: any = await db.execute(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS dia,
               count(*)::int AS pedidos,
               coalesce(sum(sale_value), 0)::float AS valor
        FROM billing_pipeline
        WHERE created_at > now() - make_interval(days => ${dias}::int)
        GROUP BY 1 ORDER BY 1
      `);

      // 5) Débitos vencidos (overdue_debts)
      const debitosResumo: any = await db.execute(sql`
        SELECT count(*)::int AS clientes, coalesce(sum(total_amount), 0)::float AS valor_total
        FROM overdue_debts
      `);
      const debitosTop: any = await db.execute(sql`
        SELECT client_name, total_amount::float AS total_amount, max_days_overdue
        FROM overdue_debts ORDER BY total_amount DESC LIMIT 15
      `);

      const totalVendidoPeriodo = vendasRows.reduce((s, r) => s + (Number(r.valor_total) || 0), 0);
      const totalPedidosPeriodo = vendasRows.reduce((s, r) => s + (Number(r.pedidos) || 0), 0);

      res.json({
        gerado_em: new Date().toISOString(),
        dias,
        resumo_carteira,
        kpis: {
          total_vendido_periodo: totalVendidoPeriodo,
          total_pedidos_periodo: totalPedidosPeriodo,
          ticket_medio_periodo: totalPedidosPeriodo > 0 ? totalVendidoPeriodo / totalPedidosPeriodo : 0,
          debitos_clientes: Number((debitosResumo.rows?.[0] || {}).clientes) || 0,
          debitos_valor: Number((debitosResumo.rows?.[0] || {}).valor_total) || 0,
        },
        ranking_vendedores,
        pipeline_estagios: (estagios.rows || []),
        vendas_por_dia: (porDia.rows || []),
        debitos_top: (debitosTop.rows || []),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Auditoria/correção de cadastro de clientes: 1.0 (Neon) vs 2.0 (Railway) ──
  // POST /api/admin/audit/customer-fields
  // Body: { applyFields?: string[] }  — sem applyFields = READ-ONLY (auditoria).
  // Campos operacionais; junta por id; trata null/'' como iguais; normaliza weekdays (JSON ordenado).
  // Apply: 2.0 := 1.0 nos applyFields onde divergem, NUNCA apagando dado do 2.0 com vazio do 1.0.
  app.post('/api/admin/audit/customer-fields', async (req: Request, res: Response) => {
    const FIELDS = ['weekdays', 'visit_periodicity', 'seller_id', 'virtual_service', 'route', 'contact', 'phone'];
    const SAFE = new Set(['weekdays', 'visit_periodicity', 'seller_id', 'virtual_service', 'route', 'contact', 'phone']);
    const applyFields: string[] = Array.isArray(req.body?.applyFields)
      ? req.body.applyFields.filter((f: string) => FIELDS.includes(f) && SAFE.has(f)) : [];
    const ENUM_CAST: Record<string, string> = { visit_periodicity: '::visit_periodicity', virtual_service: '::boolean' };
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const norm = (field: string, v: any): string => {
      if (v === null || v === undefined) return '';
      let s = String(v).trim();
      if (field === 'weekdays') { try { const a = JSON.parse(s); if (Array.isArray(a)) return JSON.stringify(a.map((x: any) => String(x)).sort()); } catch (e) {} return s; }
      if (field === 'virtual_service') return s.toLowerCase();
      return s;
    };
    try {
      await src.connect(); await tgt.connect();
      const colList = ['id', 'name'].concat(FIELDS).map((c) => '"' + c + '"::text AS "' + c + '"').join(', ');
      const [sr, tr] = await Promise.all([
        src.query('SELECT ' + colList + ' FROM customers'),
        tgt.query('SELECT ' + colList + ' FROM customers'),
      ]);
      const tMap = new Map<string, any>((tr.rows as any[]).map((r) => [r.id, r]));
      const diffs: any[] = [];
      const perField: Record<string, number> = {};
      for (const s of (sr.rows as any[])) {
        const t = tMap.get(s.id);
        if (!t) continue; // só clientes presentes nos dois lados
        for (const f of FIELDS) {
          const sv = norm(f, s[f]); const tv = norm(f, t[f]);
          if (sv !== tv) {
            const blank = (x: string) => x === '' || x === '[]';
            const direction = blank(sv) ? 'erase_block' : (blank(tv) ? 'fill' : 'change');
            diffs.push({ id: s.id, name: s.name, field: f, v_1_0: s[f], v_2_0: t[f], direction });
            perField[f] = (perField[f] || 0) + 1;
          }
        }
      }
      const applied: Record<string, number> = {};
      if (applyFields.length > 0) {
        for (const f of applyFields) {
          // só aplica onde 1.0 tem valor (direction != erase_block) → nunca apaga dado do 2.0
          const rows = diffs.filter((d) => d.field === f && d.direction !== 'erase_block');
          if (rows.length === 0) { applied[f] = 0; continue; }
          const cast = ENUM_CAST[f] || '';
          const params: any[] = [];
          const tuples = rows.map((d, i) => { params.push(d.id, d.v_1_0); return '($' + (2 * i + 1) + '::text, $' + (2 * i + 2) + '::text)'; }).join(',');
          await tgt.query(
            'UPDATE customers AS c SET "' + f + '" = v.val' + cast + ', updated_at = now() ' +
            'FROM (VALUES ' + tuples + ') AS v(id, val) WHERE c.id = v.id', params);
          applied[f] = rows.length;
        }
      }
      res.json({
        bothSides: tMap.size,
        srcTotal: sr.rows.length,
        perField,
        totalDiffs: diffs.length,
        applyFields,
        applied,
        diffs: applyFields.length > 0 ? undefined : diffs,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      await src.end().catch(() => {}); await tgt.end().catch(() => {});
    }
  });

  // ── Pipeline: re-sync 1.0→2.0 do billing_pipeline (helper compartilhado) ──
  async function resyncBillingPipeline(src: any, tgt: any) {
    const colQ = "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_pipeline'";
    const [scr, tcr] = await Promise.all([src.query(colQ), tgt.query(colQ)]);
    const tgtCols = new Set((tcr.rows as any[]).map((r) => r.column_name));
    const jsonbCols = new Set((tcr.rows as any[]).filter((r) => r.udt_name === 'json' || r.udt_name === 'jsonb').map((r) => r.column_name));
    const cols = (scr.rows as any[]).map((r) => r.column_name).filter((c) => tgtCols.has(c));
    const colsSql = cols.map((c) => '"' + c + '"').join(',');
    const setSql = cols.filter((c) => c !== 'id').map((c) => '"' + c + '"=EXCLUDED."' + c + '"').join(',');
    const flatten = (row: any) => cols.map((c) => { const v = row[c]; if (v !== null && jsonbCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; });
    const all = await src.query('SELECT ' + colsSql + ' FROM billing_pipeline');
    let upserted = 0, failed = 0; const errors: any[] = [];
    const BATCH = 200;
    for (let i = 0; i < all.rows.length; i += BATCH) {
      const batch = all.rows.slice(i, i + BATCH);
      const ph = batch.map((_: any, ri: number) => '(' + cols.map((_c: any, ci: number) => '$' + (ri * cols.length + ci + 1)).join(',') + ')').join(',');
      try {
        await tgt.query('INSERT INTO billing_pipeline (' + colsSql + ') VALUES ' + ph + ' ON CONFLICT (id) DO UPDATE SET ' + setSql, batch.flatMap(flatten));
        upserted += batch.length;
      } catch (e: any) {
        for (const row of batch) {
          const rph = cols.map((_c: any, i2: number) => '$' + (i2 + 1)).join(',');
          try { await tgt.query('INSERT INTO billing_pipeline (' + colsSql + ') VALUES (' + rph + ') ON CONFLICT (id) DO UPDATE SET ' + setSql, flatten(row)); upserted++; }
          catch (e2: any) { failed++; if (errors.length < 10) errors.push({ id: row.id, err: String(e2.message).slice(0, 160) }); }
        }
      }
    }
    return { total: all.rows.length, upserted, failed, errors };
  }

  // POST /api/admin/pipeline/fix-sync — corrige enum (estágios faltantes) + colunas e re-sincroniza billing_pipeline.
  // READ-ONLY por padrão; Body { apply:true } para aplicar.
  app.post('/api/admin/pipeline/fix-sync', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const mkTgt = () => new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    let tgt = mkTgt();
    try {
      await src.connect(); await tgt.connect();
      const [ss, tsr] = await Promise.all([
        src.query("SELECT stage::text AS stage, count(*)::int AS c FROM billing_pipeline GROUP BY 1 ORDER BY 2 DESC"),
        tgt.query("SELECT stage::text AS stage, count(*)::int AS c FROM billing_pipeline GROUP BY 1 ORDER BY 2 DESC"),
      ]);
      const enumRes = await tgt.query("SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='billing_pipeline_stage' ORDER BY e.enumsortorder");
      const enumLabels = new Set((enumRes.rows as any[]).map((r) => r.l));
      const srcStages = (ss.rows as any[]).map((r) => r.stage).filter(Boolean);
      const KNOWN_STAGES = ['agendado', 'bsb', 'aguardando_rota_bsb', 'outras_cidades'];
      const missingEnum = [...new Set([...srcStages, ...KNOWN_STAGES])].filter((s: string) => !enumLabels.has(s));
      const colQ = "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_pipeline'";
      const [sc, tc] = await Promise.all([src.query(colQ), tgt.query(colQ)]);
      const tgtColSet = new Set((tc.rows as any[]).map((r) => r.column_name));
      const missingCols = (sc.rows as any[]).filter((r) => !tgtColSet.has(r.column_name));
      const out: any = { srcStages: ss.rows, tgtStages: tsr.rows, currentEnum: [...enumLabels], missingEnum, missingCols: missingCols.map((r: any) => r.column_name) };
      if (apply) {
        for (const v of missingEnum) await tgt.query("ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS '" + String(v).replace(/'/g, "''") + "'");
        for (const r of missingCols) {
          const typ = r.data_type === 'USER-DEFINED' ? 'text' : r.data_type;
          await tgt.query('ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS "' + r.column_name + '" ' + typ);
        }
        // reconecta o target para que os novos valores de enum fiquem visíveis ao INSERT
        await tgt.end().catch(() => {});
        tgt = mkTgt(); await tgt.connect();
        out.resync = await resyncBillingPipeline(src, tgt);
        out.applied = { enumAdded: missingEnum, colsAdded: missingCols.map((r: any) => r.column_name) };
      }
      res.json(out);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

  // POST /api/billing-pipeline/sync-now — sincroniza billing_pipeline 1.0→2.0 sob demanda (botão Atualizar).
  app.post('/api/billing-pipeline/sync-now', async (_req: Request, res: Response) => {
    if (!process.env.REPLIT_DATABASE_URL) { res.json({ synced: false, reason: '1.0 não configurado' }); return; }
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const r = await resyncBillingPipeline(src, tgt);
      res.json({ synced: true, ...r });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

  await initializeDefaultAdmin();

  // -- Dashboard 2.0 (espelho do 1.0) --
  app.get('/api/dashboard2/all', async (_req: Request, res: Response) => {
    const out: any = { stats: {}, ordersOverview: { blocked: [], unbilled: [], todayInvoices: [], totals: {} }, monthly: {}, sellerComparison: [], errors: [] };
    async function q(label: string, text: string) { try { const r: any = await db.execute(sql.raw(text)); return r.rows || []; } catch (e: any) { out.errors.push(label + ': ' + e.message); return []; } }
    try {
      const s = await q('stats', "SELECT COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date),0) AS today_sales, COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')),0) AS week_sales, COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')),0) AS month_sales");
      out.stats = s[0] || {};
      out.ordersOverview.todayInvoices = await q('todayInvoices', "SELECT fi.id, fi.invoice_number, fi.customer_name, fi.total_invoice, fi.authorization_date, fi.emission_date, fi.issuer_cnpj, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''), sc.seller_id) AS seller_name FROM fiscal_invoices fi LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN users u ON (u.id = sc.seller_id OR u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = REPLACE(COALESCE(sc.seller_id,''),'omie-vendor-','')) WHERE fi.status='authorized' AND (COALESCE(fi.emission_date,fi.authorization_date) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY COALESCE(fi.authorization_date,fi.emission_date) DESC LIMIT 400");
      out.ordersOverview.unbilled = await q('unbilled', "SELECT id, customer_name, seller_name, stage, sale_value, omie_instance_name, created_at FROM billing_pipeline WHERE stage IN ('pedido','a_faturar') ORDER BY created_at DESC LIMIT 400");
      out.ordersOverview.blocked = await q('blocked', "SELECT bo.id, COALESCE(c.name, bo.customer_id) AS customer_name, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''), bo.seller_id) AS seller_name, bo.total_amount, bo.block_reason, bo.blocked_at FROM blocked_orders bo LEFT JOIN customers c ON c.id = bo.customer_id LEFT JOIN users u ON (u.id = bo.seller_id OR u.omie_vendor_code = bo.seller_id) WHERE bo.status='blocked' ORDER BY bo.blocked_at DESC LIMIT 400");
      const sm = (arr: any[], k: string) => arr.reduce((a: number, x: any) => a + (parseFloat(x[k]) || 0), 0);
      out.ordersOverview.totals = { blockedCount: out.ordersOverview.blocked.length, blockedAmount: sm(out.ordersOverview.blocked, 'total_amount'), unbilledCount: out.ordersOverview.unbilled.length, unbilledAmount: sm(out.ordersOverview.unbilled, 'sale_value'), todayInvoicesCount: out.ordersOverview.todayInvoices.length, todayInvoicesAmount: sm(out.ordersOverview.todayInvoices, 'total_invoice') };
      out.monthly = { byInstance: await q('monthlyByInstance', "SELECT COALESCE(omie_instance_name,'-') AS instance, COALESCE(SUM(sale_value),0) AS revenue, COUNT(*)::int AS cnt FROM billing_pipeline WHERE (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') GROUP BY 1 ORDER BY 2 DESC") };
      out.sellerComparison = await q('sellerComparison', "SELECT COALESCE(seller_name, seller_id, 'sem vendedor') AS seller_name, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia, COALESCE(SUM(sale_value),0) AS revenue, COUNT(*)::int AS pedidos FROM billing_pipeline WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) GROUP BY 1,2 ORDER BY 1,2");
      res.json(out);
    } catch (err: any) { res.status(500).json({ error: err.message, partial: out }); }
  });

  // -- Auditoria de sync: todas as tabelas (src=neondb 1.0 vs tgt=Railway 2.0) --
  app.get('/api/admin/sync/audit-all', async (_req: Request, res: Response) => {
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const Q = "SELECT c.relname AS t, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r'";
      const sr: any = await src.query(Q); const tr: any = await tgt.query(Q);
      const sMap: any = {}; sr.rows.forEach((r: any) => { sMap[r.t] = Number(r.n); });
      const tMap: any = {}; tr.rows.forEach((r: any) => { tMap[r.t] = Number(r.n); });
      const rows = Object.keys(sMap).sort().map((t) => ({ table: t, src: sMap[t], tgt: (t in tMap) ? tMap[t] : null, tgtExists: t in tMap }));
      const missingInTarget = rows.filter((r) => !r.tgtExists).map((r) => r.table);
      const tgtOnly = Object.keys(tMap).filter((t) => !(t in sMap)).sort();
      res.json({ srcTableCount: Object.keys(sMap).length, tgtTableCount: Object.keys(tMap).length, missingInTarget, tgtOnly, rows });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

  // -- Ambiente fiscal por instancia (homologacao/producao) --
  app.get('/api/admin/fiscal/environments', async (_req: Request, res: Response) => {
    try {
      const insts: any = await db.execute(sql`SELECT id, name FROM omie_instances ORDER BY name`);
      const sett: any = await db.execute(sql`SELECT key, value FROM system_settings WHERE key LIKE 'fiscal_env_%'`);
      const map: any = {}; (sett.rows||[]).forEach((r: any) => { map[r.key] = r.value; });
      const norm = (v: any) => (v === 'producao' || v === '"producao"') ? 'producao' : 'homologacao';
      const out = (insts.rows||[]).map((i: any) => ({ instanceId: i.id, name: i.name, environment: norm(map['fiscal_env_' + i.id]) }));
      res.json(out);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/admin/fiscal/environment', async (req: Request, res: Response) => {
    try {
      const instanceId = req.body?.instanceId; const environment = req.body?.environment;
      if (!instanceId || !['homologacao', 'producao'].includes(environment)) return res.status(400).json({ error: 'instanceId e environment obrigatorios' });
      await db.execute(sql`INSERT INTO system_settings (id, key, value, description, updated_by, updated_at) VALUES (gen_random_uuid(), ${'fiscal_env_' + instanceId}, ${environment}, 'Ambiente NF-e por instancia', 'fiscal-toggle', NOW()) ON CONFLICT (key) DO UPDATE SET value = ${environment}, updated_at = NOW()`);
      res.json({ success: true, instanceId, environment });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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
