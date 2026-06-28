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
import { registrarBoleto, testarConexaoBoleto, consultarBoleto, boletoIsSandbox, processBoletoWebhook, checkAndSettleBoleto } from "./bb-boleto-service";
import { storage } from "./storage";
import { createReceivableFromPipelineItem } from "./billing-pipeline-routes";

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
  express.json({ limit: '25mb' })(req, res, next);
});

// Middleware condicional para urlencoded - NÃO processar requisições multipart/form-data
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Deixar o multer processar essas requisições
    return next();
  }
  express.urlencoded({ extended: false, limit: '25mb' })(req, res, next);
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

  // ===== BOLETO BB (Cobranca v2) — emissao/diagnostico. Default HOMOLOGACAO. =====
  // Para producao: env BB_BOLETO_SANDBOX=false. Conta financeira precisa de
  // bbBoletoEnabled + bbConvenio + bbClientId/bbClientSecret/bbDevAppKey.
  app.get("/api/admin/boleto/status", async (_req, res) => {
    try {
      const accs = await db.execute(sql`
        SELECT id, name, omie_instance_id, bb_boleto_enabled,
               (bb_convenio IS NOT NULL AND bb_convenio <> '') AS has_convenio,
               (bb_client_id IS NOT NULL AND bb_client_secret IS NOT NULL AND bb_dev_app_key IS NOT NULL) AS has_credentials,
               bb_carteira, bb_variacao_carteira
        FROM financial_accounts ORDER BY name`);
      const tot = await db.execute(sql`SELECT COUNT(*)::int AS n FROM boleto_charges`);
      res.json({
        sandbox: boletoIsSandbox(),
        envSandboxFlag: process.env.BB_BOLETO_SANDBOX ?? "(unset -> homologacao)",
        boletosArmazenados: (tot.rows?.[0] as any)?.n ?? 0,
        contas: accs.rows,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/admin/boleto/test-connection", async (req, res) => {
    try {
      const accountId = (req.body || {}).accountId;
      if (!accountId) return res.status(400).json({ error: "accountId obrigatorio" });
      res.json(await testarConexaoBoleto(accountId));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Resolve os dados do pagador a partir do recebivel + cliente.
  async function boletoParamsFromReceivable(receivableId: string): Promise<any | null> {
    const rec: any = await db.execute(sql`
      SELECT r.id, r.amount, r.due_date, r.customer_id, r.customer_name, r.customer_document,
             r.fiscal_invoice_id, r.billing_pipeline_id, r.omie_instance_id,
             c.address, c.city, c.neighborhood, c.state, c.zip_code, c.cpf, c.cnpj, c.name AS c_name
      FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ${receivableId} LIMIT 1`);
    const row = rec.rows?.[0];
    if (!row) return null;
    return {
      omieInstanceId: row.omie_instance_id,
      params: {
        amount: parseFloat(row.amount),
        dueDate: row.due_date ? new Date(row.due_date) : new Date(Date.now() + 30 * 864e5),
        debtorName: row.customer_name || row.c_name || "Cliente",
        debtorDocument: row.customer_document || row.cnpj || row.cpf || "",
        debtorAddress: row.address, debtorCity: row.city, debtorNeighborhood: row.neighborhood,
        debtorState: row.state, debtorZip: row.zip_code,
        receivableId: row.id, fiscalInvoiceId: row.fiscal_invoice_id,
        customerId: row.customer_id, billingPipelineId: row.billing_pipeline_id,
      },
    };
  }

  // Registra boleto por receivableId (puxa dados) OU por params crus.
  app.post("/api/admin/boleto/registrar", async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.accountId) return res.status(400).json({ error: "accountId obrigatorio" });
      let params: any;
      if (b.receivableId) {
        const resolved = await boletoParamsFromReceivable(b.receivableId);
        if (!resolved) return res.status(404).json({ error: "receivable nao encontrado" });
        params = resolved.params;
      } else {
        if (!b.amount || !b.debtorName || !b.debtorDocument) {
          return res.status(400).json({ error: "informe receivableId OU (amount, debtorName, debtorDocument)" });
        }
        params = {
          amount: parseFloat(b.amount),
          dueDate: b.dueDate ? new Date(b.dueDate) : new Date(Date.now() + 30 * 864e5),
          debtorName: b.debtorName, debtorDocument: b.debtorDocument,
          debtorAddress: b.debtorAddress, debtorCity: b.debtorCity, debtorNeighborhood: b.debtorNeighborhood,
          debtorState: b.debtorState, debtorZip: b.debtorZip,
          receivableId: b.receivableId || null, customerId: b.customerId || null,
        };
      }
      const r = await registrarBoleto(b.accountId, params);
      res.status(r.success ? 200 : 422).json(r);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Botao do pipeline: gera boleto p/ um item faturado (resolve recebivel + conta BB da instancia).
// ===== BOLETO BB — webhook de liquidacao (BAIXA OPERACIONAL) + conciliacao =====
  // BB faz POST aqui quando um boleto e liquidado. Sempre responder 200.
  app.post("/api/webhooks/bb-boleto", async (req, res) => {
    try {
      const payload = req.body || {};
      try { await db.execute(sql`INSERT INTO webhook_debug_log (raw_remote_jid, payload, created_at) VALUES (${'BB-BOLETO'}, ${JSON.stringify(payload)}, now())`); } catch {}
      const out = await processBoletoWebhook(payload);
      res.status(200).json({ ok: true, ...out });
    } catch (e: any) { res.status(200).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Verifica pagamento de um boleto via consulta BB e da baixa (fallback/teste/cron).
  // Batch (cron-friendly, GET): dispara em 2o plano a varredura de boletos em aberto e baixa os pagos.
  app.get("/api/admin/boleto/check-open", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String((req.query as any).limit || "300"), 10) || 300, 2000);
      const days = parseInt(String((req.query as any).days || "120"), 10) || 120;
      const r: any = await db.execute(sql`SELECT bc.id FROM boleto_charges bc JOIN receivables r ON r.id = bc.receivable_id WHERE COALESCE(bc.status,'') NOT IN ('liquidado','pago','recebido','cancelado','baixado') AND r.status IN ('a_vencer','vencida') AND bc.created_at > now() - make_interval(days => ${days}) ORDER BY bc.created_at DESC LIMIT ${limit}`);
      const ids = (r.rows || []).map((x: any) => x.id);
      // fire-and-forget: nao bloqueia a resposta (evita timeout do gateway)
      (async () => {
        let checked = 0, paid = 0, settled = 0; const errors: any[] = [];
        for (const id of ids) {
          try { const o: any = await checkAndSettleBoleto(id); checked++; if (o && o.paid) { paid++; if (!o.alreadyPaid) settled++; } }
          catch (e: any) { errors.push({ id, error: e?.message }); }
        }
        try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('boleto_check_open_last', ${JSON.stringify({ at: new Date().toISOString(), candidates: ids.length, checked, paid, settled, errors: errors.slice(0, 10) })}, 'cron-boleto') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch (e) {}
        console.log(`[BB-BOLETO] check-open concluido: candidates=${ids.length} checked=${checked} paid=${paid} settled=${settled}`);
      })();
      res.json({ ok: true, started: true, candidates: ids.length });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Le o resumo da ultima varredura check-open (gravado em system_settings).
  app.get("/api/admin/boleto/check-open/last", async (_req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'boleto_check_open_last' LIMIT 1`);
      const v = r.rows?.[0]?.value;
      res.json(v ? (typeof v === 'string' ? JSON.parse(v) : v) : { none: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/admin/boleto/check-payment", async (req, res) => {
    try {
      const id = (req.body || {}).boletoChargeId;
      if (!id) return res.status(400).json({ error: "boletoChargeId obrigatorio" });
      res.json(await checkAndSettleBoleto(id));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Cria e vincula um recebivel a um boleto avulso (para aparecer/baixar no Contas a Receber).
  app.post("/api/admin/boleto/ensure-receivable", async (req, res) => {
    try {
      const { boletoChargeId, customerId } = req.body || {};
      if (!boletoChargeId) return res.status(400).json({ error: "boletoChargeId obrigatorio" });
      const r: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE id = ${boletoChargeId} LIMIT 1`);
      const c = r.rows?.[0];
      if (!c) return res.status(404).json({ error: "boleto nao encontrado" });
      if (c.receivable_id) return res.json({ ok: true, alreadyLinked: true, receivableId: c.receivable_id });
      const rec: any = await storage.createReceivable({
        titleNumber: c.nosso_numero || null,
        customerId: customerId || c.customer_id || null,
        customerName: c.debtor_name || "Cliente",
        customerDocument: c.debtor_document || null,
        description: `Boleto BB nosso ${c.nosso_numero}`,
        issueDate: new Date(),
        dueDate: c.data_vencimento ? new Date(c.data_vencimento) : new Date(Date.now() + 30 * 864e5),
        amount: String(c.valor_original || "0"),
        amountPaid: "0",
        status: "a_vencer" as any,
        paymentMethod: "boleto" as any,
        createdBy: "sistema",
      } as any);
      await db.execute(sql`UPDATE boleto_charges SET receivable_id = ${rec.id} WHERE id = ${boletoChargeId}`);
      res.json({ ok: true, receivableId: rec.id });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

// Cobranca vinculada a um recebivel (botao "Cobranca" no Contas a Receber).
// TEST: cria recebivel + dispara o hook de cobranca (boleto/pix) como num faturamento de venda.
// DIAG: compara credenciais BB (mascaradas) entre 1.0 (Neon/REPLIT_DATABASE_URL) e 2.0.
// DIAG: testa variacoes de OAuth do BB para PIX e reporta qual o BB aceita (nao expoe segredos).
// DIAG/TESTE: reporta presenca do certificado mTLS de PIX e tenta criar 1 cobranca PIX (mostra erro real do BB).
// Upload do certificado mTLS de PIX (.p12/.pfx) — pagina + endpoint. Guarda no banco (system_settings).
  app.post("/api/admin/pix/cert", async (req, res) => {
    try {
      const b = req.body || {};
      const clean = String(b.pfxBase64 || "").replace(/\s+/g, "");
      if (!clean) return res.status(400).json({ error: "pfxBase64 obrigatorio" });
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('bb_pix_cert_pfx_base64', ${clean}, 'cert-upload') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('bb_pix_cert_password', ${String(b.password || "")}, 'cert-upload') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      try { const pix: any = await import("./bb-pix-service"); pix.resetPixAgentCache?.(); } catch {}
      res.json({ ok: true, savedBytes: clean.length, hasPassword: !!b.password });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

// AUDITORIA FISCAL (read-only): ultima NF por instancia/CNPJ/serie e cenarios fiscais — 1.0 (Neon) vs 2.0.
  app.get("/api/admin/fiscal/audit", async (_req, res) => {
    const invSql = `
      SELECT omie_instance_id, issuer_cnpj, series, environment,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE lower(coalesce(status,'')) LIKE '%autoriz%')::int AS n_autorizadas,
             MAX(invoice_number) FILTER (WHERE lower(coalesce(status,'')) LIKE '%autoriz%') AS max_autorizada,
             MAX(invoice_number) AS max_qualquer,
             MAX(emission_date) AS ultima_emissao
      FROM fiscal_invoices
      WHERE invoice_number IS NOT NULL
      GROUP BY omie_instance_id, issuer_cnpj, series, environment
      ORDER BY omie_instance_id, issuer_cnpj, series, environment`;
    const out: any = { invoices_2_0: null, invoices_1_0: null, scenarios_2_0: null, scenarios_1_0: null, srcErr: null };
    try {
      const r: any = await db.execute(sql`${sql.raw(invSql)}`);
      out.invoices_2_0 = r.rows;
      const sc: any = await db.execute(sql`SELECT id, name, operation_type, state_scope, cfop, tax_regime, csosn, cst_icms, cst_pis, cst_cofins, nature_of_operation, is_active FROM fiscal_scenarios ORDER BY operation_type, state_scope, cfop`);
      out.scenarios_2_0 = sc.rows;
    } catch (e: any) { out.err2 = e?.message; }
    if (process.env.REPLIT_DATABASE_URL) {
      const pg: any = await import("pg");
      const Client = pg.Client || pg.default?.Client;
      const c = new Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      try {
        await c.connect();
        const r = await c.query(invSql);
        out.invoices_1_0 = r.rows;
        try {
          const sc = await c.query("SELECT id, name, operation_type, state_scope, cfop, tax_regime, csosn, cst_icms, cst_pis, cst_cofins, nature_of_operation, is_active FROM fiscal_scenarios ORDER BY operation_type, state_scope, cfop");
          out.scenarios_1_0 = sc.rows;
        } catch (e: any) { out.scenErr1 = e?.message; }
      } catch (e: any) { out.srcErr = e?.message; } finally { try { await c.end(); } catch {} }
    } else out.srcErr = "REPLIT_DATABASE_URL nao definido";
    res.json(out);
  });

  app.get("/api/admin/pix/cert-upload", async (_req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><html lang=pt-br><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Upload Certificado PIX (.p12)</title><style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111}.card{max-width:520px;margin:24px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 6px}.muted{color:#666;font-size:13px;margin-bottom:14px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px}button{margin-top:16px;background:#059669;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-size:14px;cursor:pointer}button:disabled{opacity:.6}#out{margin-top:14px;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:12px;background:#f3f4f6;border-radius:8px;padding:10px;display:none}.ok{color:#065f46}.err{color:#991b1b}</style></head><body><div class=card><h1>Certificado mTLS do PIX (Banco do Brasil)</h1><div class=muted>Selecione o arquivo <b>.p12 / .pfx</b> e informe a senha. O certificado é convertido em base64 no navegador e salvo de forma segura no servidor (usado para autenticar a API de PIX). Nada é exibido aqui.</div><label>Arquivo do certificado (.p12 / .pfx)</label><input type=file id=file accept=".p12,.pfx,application/x-pkcs12"><label>Senha do certificado</label><input type=password id=pass placeholder="senha do .p12 (deixe vazio se nao tiver)"><button id=btn onclick="up()">Enviar certificado</button><div id=out></div></div><script>
function show(msg,ok){var o=document.getElementById('out');o.style.display='block';o.className=ok?'ok':'err';o.textContent=msg;}
function up(){var f=document.getElementById('file').files[0];if(!f){show('Selecione o arquivo .p12',false);return;}var btn=document.getElementById('btn');btn.disabled=true;btn.textContent='Enviando...';var r=new FileReader();r.onload=function(){try{var bytes=new Uint8Array(r.result);var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);var b64=btoa(bin);fetch('/api/admin/pix/cert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pfxBase64:b64,password:document.getElementById('pass').value})}).then(function(x){return x.json();}).then(function(j){btn.disabled=false;btn.textContent='Enviar certificado';if(j.ok){show('Certificado salvo com sucesso ('+j.savedBytes+' bytes, senha: '+(j.hasPassword?'sim':'nao')+'). Agora avise o Claude para validar a emissao de PIX.',true);}else{show('Erro: '+(j.error||JSON.stringify(j)),false);}}).catch(function(e){btn.disabled=false;btn.textContent='Enviar certificado';show('Erro de rede: '+e.message,false);});}catch(e){btn.disabled=false;btn.textContent='Enviar certificado';show('Erro: '+e.message,false);}};r.onerror=function(){btn.disabled=false;btn.textContent='Enviar certificado';show('Falha ao ler o arquivo',false);};r.readAsArrayBuffer(f);}
</script></body></html>`);
  });

  app.get("/api/financial/receivables/:id/cobranca", async (req, res) => {
    try {
      const id = req.params.id;
      const b: any = await db.execute(sql`SELECT id, status FROM boleto_charges WHERE receivable_id = ${id} ORDER BY created_at DESC LIMIT 1`);
      if (b.rows?.[0]) { const bc = b.rows[0]; return res.json({ hasCharge: true, type: "boleto", id: bc.id, status: bc.status, viewUrl: `/api/boleto-view/${bc.id}` }); }
      const p: any = await db.execute(sql`SELECT id, status FROM pix_charges WHERE receivable_id = ${id} ORDER BY created_at DESC LIMIT 1`);
      if (p.rows?.[0]) { const pc = p.rows[0]; return res.json({ hasCharge: true, type: "pix", id: pc.id, status: pc.status, viewUrl: `/api/pix-view/${pc.id}` }); }
      res.json({ hasCharge: false });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Emite um boleto (hibrido boleto+PIX) para um recebivel e devolve a viewUrl.
  app.post("/api/financial/receivables/:id/emit-boleto", async (req, res) => {
    try {
      const recId = req.params.id;
      const ex: any = await db.execute(sql`SELECT id FROM boleto_charges WHERE receivable_id = ${recId} ORDER BY created_at DESC LIMIT 1`);
      if (ex.rows?.[0]) return res.json({ ok: true, alreadyExists: true, boletoChargeId: ex.rows[0].id, viewUrl: `/api/boleto-view/${ex.rows[0].id}` });
      const resolved = await boletoParamsFromReceivable(recId);
      if (!resolved) return res.status(404).json({ error: "recebivel nao encontrado" });
      const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL ORDER BY (omie_instance_id = ${resolved.omieInstanceId}) DESC NULLS LAST LIMIT 1`);
      const accId = accq.rows?.[0]?.id;
      if (!accId) return res.status(422).json({ error: "nenhuma conta com boleto BB habilitado" });
      const result: any = await registrarBoleto(accId, resolved.params);
      if (result.success && result.boletoChargeId) result.viewUrl = `/api/boleto-view/${result.boletoChargeId}`;
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Pagina publica de visualizacao de cobranca PIX (espelha a do boleto).
  app.get("/api/pix-view/:id", async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT txid, amount, status, debtor_name, debtor_document, description, pix_copia_e_cola, qr_code_base64, due_date FROM pix_charges WHERE id = ${req.params.id} LIMIT 1`);
      const c = r.rows?.[0];
      if (!c) { res.status(404).send("PIX nao encontrado"); return; }
      const paid = /(conclu|pag|receb|liquid)/i.test(String(c.status || ""));
      const qr = c.qr_code_base64 ? `<img alt="QR PIX" src="data:image/png;base64,${c.qr_code_base64}" width="240" height="240"/>` : "";
      const venc = c.due_date ? new Date(c.due_date).toLocaleDateString("pt-BR") : "";
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(`<!doctype html><html lang=pt-br><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Cobranca PIX</title><style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111}.card{max-width:480px;margin:24px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 4px}.muted{color:#666;font-size:13px}.val{font-size:30px;font-weight:700;color:#059669;margin:10px 0}.box{background:#f3f4f6;border-radius:8px;padding:12px;word-break:break-all;font-family:monospace;font-size:13px;margin:8px 0}.lbl{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-top:16px;font-weight:600}button{background:#059669;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer;margin-top:6px}.status{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}.s-pg{background:#d1fae5;color:#065f46}.s-ab{background:#fef3c7;color:#92400e}.center{text-align:center}</style></head><body><div class=card><h1>Cobranca PIX</h1><div class=muted>Pagador: ${c.debtor_name || ""} ${c.debtor_document ? "&mdash; " + c.debtor_document : ""}</div><div class=muted>${c.description || ""} ${venc ? "&middot; Venc.: " + venc : ""}</div><div class=val>R$ ${Number(c.amount || 0).toFixed(2).replace(".", ",")}</div><span class="status ${paid ? "s-pg" : "s-ab"}">${(String(c.status || "").toUpperCase()) || "ATIVA"}</span><div class=lbl>Pague via PIX</div><div class=center>${qr}</div><div class=box id=pix>${c.pix_copia_e_cola || "(sem pix)"}</div><button onclick="navigator.clipboard.writeText(document.getElementById('pix').innerText);this.innerText='Copiado!'">Copiar PIX copia e cola</button></div></body></html>`);
    } catch (e: any) { res.status(500).send("erro"); }
  });

  // Pagina publica de pagamento do boleto (PIX copia-e-cola + QR + linha digitavel).
  app.get("/api/boleto-view/:id", async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT nosso_numero, linha_digitavel, codigo_barras, valor_original, data_vencimento, debtor_name, debtor_document, pix_copia_e_cola, pix_qr_code_base64, status FROM boleto_charges WHERE id = ${req.params.id} LIMIT 1`);
      const c = r.rows?.[0];
      if (!c) { res.status(404).send("Boleto nao encontrado"); return; }
      const paid = /(liquid|pag|receb)/i.test(String(c.status || ""));
      const qr = c.pix_qr_code_base64 ? `<img alt="QR PIX" src="data:image/png;base64,${c.pix_qr_code_base64}" width="240" height="240"/>` : "";
      const venc = c.data_vencimento ? new Date(c.data_vencimento).toLocaleDateString("pt-BR") : "";
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(`<!doctype html><html lang=pt-br><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Boleto BB</title><style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111}.card{max-width:480px;margin:24px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 4px}.muted{color:#666;font-size:13px}.val{font-size:30px;font-weight:700;color:#059669;margin:10px 0}.box{background:#f3f4f6;border-radius:8px;padding:12px;word-break:break-all;font-family:monospace;font-size:13px;margin:8px 0}.lbl{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-top:16px;font-weight:600}button{background:#059669;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer;margin-top:6px}.status{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}.s-pg{background:#d1fae5;color:#065f46}.s-ab{background:#fef3c7;color:#92400e}.center{text-align:center}</style></head><body><div class=card><h1>Boleto Banco do Brasil</h1><div class=muted>Pagador: ${c.debtor_name || ""} — ${c.debtor_document || ""}</div><div class=muted>Vencimento: ${venc} · Nosso numero: ${c.nosso_numero || ""}</div><div class=val>R$ ${Number(c.valor_original || 0).toFixed(2).replace(".", ",")}</div><span class="status ${paid ? "s-pg" : "s-ab"}">${(String(c.status || "").toUpperCase()) || "EM ABERTO"}</span><div class=lbl>Pague via PIX (instantaneo)</div><div class=center>${qr}</div><div class=box id=pix>${c.pix_copia_e_cola || "(sem pix)"}</div><button onclick="navigator.clipboard.writeText(document.getElementById('pix').innerText);this.innerText='Copiado!'">Copiar PIX copia e cola</button><div class=lbl>Linha digitavel (boleto)</div><div class=box>${c.linha_digitavel || "(sem linha)"}</div></div></body></html>`);
    } catch (e: any) { res.status(500).send("erro"); }
  });


  app.post("/api/billing-pipeline/boleto", async (req, res) => {
    try {
      const itemId = (req.body || {}).itemId;
      if (!itemId) return res.status(400).json({ error: "itemId obrigatorio" });
      const recq: any = await db.execute(sql`
        SELECT r.id AS receivable_id, r.omie_instance_id
        FROM receivables r WHERE r.billing_pipeline_id = ${itemId}
        ORDER BY r.created_at DESC LIMIT 1`);
      const rrow = recq.rows?.[0];
      if (!rrow) return res.status(404).json({ error: "recebivel do item nao encontrado (item faturado?)" });
      const accq: any = await db.execute(sql`
        SELECT id FROM financial_accounts
        WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL
        ORDER BY (omie_instance_id = ${rrow.omie_instance_id}) DESC NULLS LAST LIMIT 1`);
      const accId = accq.rows?.[0]?.id;
      if (!accId) return res.status(422).json({ error: "nenhuma conta com boleto BB habilitado" });
      const resolved = await boletoParamsFromReceivable(rrow.receivable_id);
      if (!resolved) return res.status(404).json({ error: "recebivel nao encontrado" });
      const result = await registrarBoleto(accId, resolved.params);
      res.status(result.success ? 200 : 422).json(result);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });



  // ===== Agentes de IA (config de comportamento dos agentes de WhatsApp) =====
  async function ensureAgentesTables() {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS config_global (chave text PRIMARY KEY, valor text NOT NULL, descricao text, updated_at timestamp DEFAULT now())`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS agentes_config (id text PRIMARY KEY, nome text NOT NULL, modelo text NOT NULL, system_prompt text NOT NULL, ferramentas jsonb NOT NULL DEFAULT '[]'::jsonb, limites jsonb NOT NULL DEFAULT '{}'::jsonb, ativo boolean NOT NULL DEFAULT true, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())`);
  }
  app.post("/api/admin/agentes/setup", async (_req: any, res: any) => {
    try { await ensureAgentesTables(); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/admin/agentes", async (_req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const base = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum'`);
      const ags = await db.execute(sql`SELECT id, nome, modelo, system_prompt, ferramentas, limites, ativo, updated_at FROM agentes_config ORDER BY id`);
      res.json({ baseComum: (base.rows[0] && (base.rows[0] as any).valor) || null, agentes: ags.rows });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/admin/agentes/:id", async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const base = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum'`);
      const ag = await db.execute(sql`SELECT * FROM agentes_config WHERE id = ${req.params.id}`);
      const row: any = ag.rows[0];
      if (!row) return res.status(404).json({ error: "agente nao encontrado" });
      const baseComum = (base.rows[0] && (base.rows[0] as any).valor) || "";
      res.json(Object.assign({}, row, { system_prompt_efetivo: baseComum + "\n\n" + row.system_prompt }));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/admin/agentes/upsert", async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const b = req.body || {};
      if (!b.id || !b.nome || !b.modelo || !b.system_prompt) return res.status(400).json({ error: "id, nome, modelo, system_prompt obrigatorios" });
      await db.execute(sql`INSERT INTO agentes_config (id, nome, modelo, system_prompt, ferramentas, limites, ativo) VALUES (${b.id}, ${b.nome}, ${b.modelo}, ${b.system_prompt}, ${JSON.stringify(b.ferramentas || [])}::jsonb, ${JSON.stringify(b.limites || {})}::jsonb, ${b.ativo !== false}) ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, modelo = EXCLUDED.modelo, system_prompt = EXCLUDED.system_prompt, ferramentas = EXCLUDED.ferramentas, limites = EXCLUDED.limites, ativo = EXCLUDED.ativo, updated_at = now()`);
      res.json({ ok: true, id: b.id });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.put("/api/admin/config/base-comum", async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const valor = (req.body || {}).valor;
      if (!valor) return res.status(400).json({ error: "valor obrigatorio" });
      await db.execute(sql`INSERT INTO config_global (chave, valor, descricao) VALUES ('base_comum', ${valor}, 'Prompt base compartilhado pelos agentes de WhatsApp') ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== IMPRESSAO DE COBRANCAS (boleto/pix ja sincronizados) — endpoint read-only =====
  app.post("/api/billing-pipeline/charges", async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      const valid = ids.filter((x) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x));
      if (valid.length === 0) return res.json([]);
      const inList = valid.map((x) => "'" + x + "'").join(",");
      const text =
        "SELECT bp.id AS item_id, r.id AS receivable_id, fi.id AS fiscal_invoice_id, " +
        "COALESCE((SELECT to_jsonb(b) FROM boleto_charges b WHERE b.receivable_id = r.id ORDER BY b.created_at DESC LIMIT 1), " +
        "(SELECT to_jsonb(b) FROM boleto_charges b WHERE fi.id IS NOT NULL AND b.fiscal_invoice_id = fi.id ORDER BY b.created_at DESC LIMIT 1)) AS boleto, " +
        "(SELECT to_jsonb(p) FROM pix_charges p WHERE p.receivable_id = r.id ORDER BY p.created_at DESC LIMIT 1) AS pix " +
        "FROM billing_pipeline bp " +
        "LEFT JOIN receivables r ON r.billing_pipeline_id = bp.id " +
        "LEFT JOIN fiscal_invoices fi ON fi.invoice_number::text = regexp_replace(COALESCE(bp.invoice_number, ''), '[^0-9]', '', 'g') " +
        "WHERE bp.id IN (" + inList + ")";
      const rows = (await db.execute(sql.raw(text))).rows;
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });


  // ====== PARIDADE DASHBOARD 2.0=1.0 — endpoint novo (inserido) ======
  app.get("/api/dashboard2/full", async (_req, res) => {
    try {
      const tz = "America/Sao_Paulo";
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const a2 = new Date(todayStr + "T12:00:00Z");
      const dates: string[] = [todayStr];
      let rr = 0;
      while (rr < 3) { a2.setUTCDate(a2.getUTCDate() - 1); const dow = a2.getUTCDay(); if (dow >= 1 && dow <= 5) { dates.push(a2.toISOString().slice(0, 10)); rr++; } }
      dates.sort();
      const startDate = dates[0];
      const endDate = todayStr;
      const q2 = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
      const statsRows = await q2(`SELECT COALESCE(SUM(sale_value) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS today_sales, COALESCE(SUM(sale_value) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), 0) AS yesterday_sales, COALESCE(SUM(sale_value) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo'))::date), 0) AS week_sales, COALESCE(SUM(sale_value) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date), 0) AS month_sales FROM billing_pipeline`);
      const stats = { todaySales: statsRows[0]?.today_sales ?? 0, yesterdaySales: statsRows[0]?.yesterday_sales ?? 0, weekSales: statsRows[0]?.week_sales ?? 0, monthSales: statsRows[0]?.month_sales ?? 0 };
      const vendasEfetivasMes: any = { label: null, value: 0, approx: true };
      const blocked = await q2(`SELECT bo.id, COALESCE(c.name, '-') AS customer_name, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS seller_name, bo.total_amount, bo.block_reason, bo.blocked_at FROM blocked_orders bo LEFT JOIN customers c ON c.id = bo.customer_id LEFT JOIN users u ON (u.omie_vendor_code = bo.seller_id OR u.omie_vendor_code = replace(bo.seller_id,'omie-vendor-','') OR u.id = bo.seller_id) WHERE bo.status = 'blocked' ORDER BY bo.blocked_at DESC NULLS LAST`);
      const aFaturar = await q2(`SELECT bp.id, COALESCE(c.name, '-') AS customer_name, COALESCE(bp.seller_name, '') AS seller_name, bp.sale_value, bp.created_at FROM billing_pipeline bp LEFT JOIN customers c ON c.id = bp.customer_id WHERE bp.stage IN ('pedido','a_faturar') ORDER BY bp.created_at DESC NULLS LAST`);
      const nfsHoje = await q2(`SELECT fi.id, COALESCE(fi.customer_name, '-') AS customer_name, fi.invoice_number, fi.total_invoice, COALESCE(fi.authorization_date, fi.emission_date) AS authorization_date, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS seller_name FROM fiscal_invoices fi LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN users u ON (u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = replace(sc.seller_id,'omie-vendor-','') OR u.id = sc.seller_id) WHERE fi.status = 'authorized' AND (COALESCE(fi.authorization_date, fi.emission_date) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY COALESCE(fi.authorization_date, fi.emission_date) DESC NULLS LAST`);
      const ordersOverview = { blocked, aFaturar, nfsHoje };
      const sched = await q2(`SELECT customer_id, (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, BOOL_OR(check_in_time IS NOT NULL) AS visited FROM sales_cards WHERE scheduled_date IS NOT NULL AND (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      const orders = await q2(`SELECT customer_id, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, COALESCE(SUM(sale_value),0) AS v, COUNT(*) AS n FROM billing_pipeline WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      let metas: any[] = [];
      try { metas = await q2(`SELECT customer_id, AVG(sale_value) AS meta FROM billing_pipeline WHERE sale_value > 0 AND customer_id IS NOT NULL GROUP BY customer_id`); } catch (e) {}
      const custInfo = await q2(`SELECT c.id AS customer_id, c.name AS customer_name, c.seller_id, TRIM(CONCAT(u.first_name,' ',u.last_name)) AS seller_name FROM customers c LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(c.seller_id,'omie-vendor-','') OR u.id = c.seller_id)`);
      const metaMap = new Map<string, number>();
      for (const m of metas) metaMap.set(m.customer_id, Number(m.meta) || 0);
      const infoMap = new Map<string, any>();
      for (const c of custInfo) infoMap.set(c.customer_id, c);
      type Cell = { isScheduled: boolean; hasVisit: boolean; hasOrder: boolean; orderValue: number };
      const byCust = new Map<string, Map<string, Cell>>();
      const ensure = (cid: string, d: string): Cell => { let m = byCust.get(cid); if (!m) { m = new Map(); byCust.set(cid, m); } let cell = m.get(d); if (!cell) { cell = { isScheduled: false, hasVisit: false, hasOrder: false, orderValue: 0 }; m.set(d, cell); } return cell; };
      for (const s of sched) { const cell = ensure(s.customer_id, s.d); cell.isScheduled = true; if (s.visited === true || s.visited === "t") cell.hasVisit = true; }
      for (const o of orders) { const cell = ensure(o.customer_id, o.d); cell.hasOrder = Number(o.n) > 0; cell.orderValue = Number(o.v) || 0; }
      const rows = Array.from(byCust.entries()).map(([cid, cellMap]) => {
        const info = infoMap.get(cid) || {};
        const meta = metaMap.get(cid) || 0;
        const visits = Array.from(cellMap.entries()).map(([d, cell]) => ({ date: d, isPast: d <= todayStr, isScheduled: cell.isScheduled, hasVisit: cell.hasVisit, hasOrder: cell.hasOrder, hasVirtualAttendance: false, orderValue: cell.orderValue, metaValue: meta, nextSaleValue: 0, visitStatus: null }));
        return { customerId: cid, customerName: info.customer_name || "-", sellerId: info.seller_name ? info.seller_id : "admin-flavio", sellerName: info.seller_name || "Flavio Administrador", visits };
      });
      const visitSummary = { start: startDate, end: endDate, dates, rows };
      res.json({ stats, vendasEfetivasMes, ordersOverview, visitSummary });
    } catch (err: any) { res.status(500).json({ error: String(err?.message || err) }); }
  });
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

  // ── Diagnóstico das entregas: billings 'Aguardando Rota' 1.0 vs 2.0 ──────
  // POST /api/admin/sync/deliveries-diag  (read-only) — pode aplicar resync de stage com {apply:true}
  app.post('/api/admin/sync/deliveries-diag', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const qAR = "SELECT count(*)::int AS c FROM billings WHERE invoice_stage='Aguardando Rota' AND invoice_date IS NOT NULL";
      const srcAR = (await src.query(qAR)).rows[0].c;
      const tgtAR = (await tgt.query(qAR)).rows[0].c;
      const tgtIds = (await tgt.query("SELECT id FROM billings WHERE invoice_stage='Aguardando Rota' AND invoice_date IS NOT NULL")).rows.map((r: any) => r.id);
      const srcRows = tgtIds.length ? (await src.query("SELECT id, invoice_stage FROM billings WHERE id = ANY($1::text[])", [tgtIds])).rows : [];
      const srcMap = new Map<string, string>(srcRows.map((r: any) => [r.id, r.invoice_stage]));
      let notInSrc = 0, stageDrift = 0, sameAR = 0; const driftIds: string[] = []; const extraIds: string[] = [];
      for (const id of tgtIds) {
        if (!srcMap.has(id)) { notInSrc++; if (extraIds.length < 1000) extraIds.push(id); }
        else if (srcMap.get(id) !== 'Aguardando Rota') { stageDrift++; if (driftIds.length < 2000) driftIds.push(id); }
        else sameAR++;
      }
      const out: any = {
        srcTotalBillings: (await src.query('SELECT count(*)::int AS c FROM billings')).rows[0].c,
        tgtTotalBillings: (await tgt.query('SELECT count(*)::int AS c FROM billings')).rows[0].c,
        srcAguardandoRota: srcAR, tgtAguardandoRota: tgtAR,
        tgtBreakdown: { notInSrc, stageDrift, sameAR },
      };
      if (apply) {
        // (1) Corrigir stage dos que existem no 1.0 com estágio diferente (puxa o stage do 1.0)
        let stageFixed = 0;
        if (driftIds.length) {
          const drv = (await src.query("SELECT id, invoice_stage FROM billings WHERE id = ANY($1::text[])", [driftIds])).rows;
          for (let i = 0; i < drv.length; i += 200) {
            const batch = drv.slice(i, i + 200);
            const params: any[] = []; const tuples = batch.map((r: any, k: number) => { params.push(r.id, r.invoice_stage); return '($' + (2*k+1) + '::text,$' + (2*k+2) + '::text)'; }).join(',');
            const r = await tgt.query('UPDATE billings AS b SET invoice_stage = v.st FROM (VALUES ' + tuples + ') AS v(id, st) WHERE b.id = v.id', params);
            stageFixed += r.rowCount || 0;
          }
        }
        // (2) Marcar como 'Entregue' os 'Aguardando Rota' do 2.0 que NÃO existem mais no 1.0 (stale — saem da fila sem deletar)
        let staleClosed = 0;
        if (extraIds.length) {
          for (let i = 0; i < extraIds.length; i += 500) {
            const batch = extraIds.slice(i, i + 500);
            const r = await tgt.query("UPDATE billings SET invoice_stage='Entregue' WHERE id = ANY($1::text[]) AND invoice_stage='Aguardando Rota'", [batch]);
            staleClosed += r.rowCount || 0;
          }
        }
        out.applied = { stageFixed, staleClosed };
        out.tgtAguardandoRotaAfter = (await tgt.query(qAR)).rows[0].c;
      }
      res.json(out);
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

  // -- Cria no Railway as tabelas que existem no neondb e faltam aqui (schema replicado, sem FK) --
  app.post('/api/admin/sync/create-missing-tables', async (req: Request, res: Response) => {
    const dryRun = req.body?.dryRun === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const KNOWN = /^(text|character varying|character|varchar|char|integer|int|int4|int8|bigint|smallint|numeric|decimal|real|double precision|boolean|bool|date|timestamp|timestamp with time zone|timestamp without time zone|time|json|jsonb|uuid|bytea)(\(|\[|$| )/i;
    try {
      await src.connect(); await tgt.connect();
      const tq = "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'";
      const sT = (await src.query(tq)).rows.map((r: any) => r.table_name);
      const tT = new Set((await tgt.query(tq)).rows.map((r: any) => r.table_name));
      const missing = sT.filter((t: string) => !tT.has(t));
      const results: any[] = [];
      for (const t of missing) {
        const cols = (await src.query("SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS coltype FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [t])).rows;
        if (cols.length === 0) { results.push({ table: t, skipped: 'no cols' }); continue; }
        const defs = cols.map((c: any) => { let ct = c.coltype; if (!KNOWN.test(ct)) ct = 'text'; return '"' + c.col + '" ' + ct; });
        const hasId = cols.some((c: any) => c.col === 'id');
        const ddl = 'CREATE TABLE IF NOT EXISTS "' + t + '" (' + defs.join(', ') + (hasId ? ', PRIMARY KEY ("id")' : '') + ')';
        if (dryRun) { results.push({ table: t, cols: cols.length, ddl: ddl.slice(0, 180) }); continue; }
        try { await tgt.query(ddl); results.push({ table: t, ok: true, cols: cols.length }); } catch (e: any) { results.push({ table: t, error: e.message.slice(0, 180) }); }
      }
      res.json({ missingCount: missing.length, createdCount: results.filter((r: any) => r.ok).length, errorCount: results.filter((r: any) => r.error).length, results });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

  // -- Backfill genérico: sincroniza TODAS as tabelas comuns neondb->Railway (full upsert por id) --
  app.post('/api/admin/sync/backfill-all', async (_req: Request, res: Response) => {
    res.json({ started: true, note: 'backfill rodando em background; ver /api/admin/sync/backfill-status' });
    (async () => {
      const pgMod = await import('pg');
      const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const summary: any[] = [];
      try {
        await src.connect(); await tgt.connect();
        const block = new Set(['sessions','sync_status','sync_states','omie_sync_attempts','webhook_debug_log','omie_stage_logs']);
        const tq = "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'";
        const sTabs = (await src.query(tq)).rows.map((r: any) => r.table_name);
        const tTabs = new Set((await tgt.query(tq)).rows.map((r: any) => r.table_name));
        const tables = sTabs.filter((t: string) => tTabs.has(t) && !block.has(t));
        for (const t of tables) {
          try {
            const tcols = (await tgt.query("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t])).rows as any[];
            const tgtCols = new Set(tcols.map((r) => r.column_name));
            const jsonCols = new Set(tcols.filter((r) => r.udt_name === 'json' || r.udt_name === 'jsonb').map((r) => r.column_name));
            if (!tgtCols.has('id')) { summary.push({ t, skipped: 'no id' }); continue; }
            let offset = 0; let up = 0;
            while (true) {
              const data = await src.query('SELECT * FROM "' + t + '" ORDER BY "id" LIMIT 1000 OFFSET ' + offset);
              if (data.rows.length === 0) break;
              const cols = Object.keys(data.rows[0]).filter((c) => tgtCols.has(c));
              const colsSql = cols.map((c) => '"' + c + '"').join(',');
              const setSql = cols.filter((c) => c !== 'id').map((c) => '"' + c + '"=EXCLUDED."' + c + '"').join(',');
              const conflict = setSql ? ' ON CONFLICT ("id") DO UPDATE SET ' + setSql : ' ON CONFLICT ("id") DO NOTHING';
              const enc = (row: any) => cols.map((c) => { const v = row[c]; if (v !== null && jsonCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; });
              for (let i = 0; i < data.rows.length; i += 200) {
                const batch = data.rows.slice(i, i + 200);
                const ph = batch.map((_: any, ri: number) => '(' + cols.map((_: any, ci: number) => '$' + (ri * cols.length + ci + 1)).join(',') + ')').join(',');
                const flat = batch.flatMap((row: any) => enc(row));
                try { await tgt.query('INSERT INTO "' + t + '" (' + colsSql + ') VALUES ' + ph + conflict, flat); up += batch.length; }
                catch (be: any) { for (const row of batch) { const rph = cols.map((_: any, k: number) => '$' + (k + 1)).join(','); try { await tgt.query('INSERT INTO "' + t + '" (' + colsSql + ') VALUES (' + rph + ')' + conflict, enc(row)); up++; } catch (re: any) {} } }
              }
              if (data.rows.length < 1000) break;
              offset += 1000;
            }
            summary.push({ t, up });
          } catch (te: any) { summary.push({ t, error: te.message.slice(0, 120) }); }
        }
        await tgt.query("INSERT INTO system_settings (id, key, value, description, updated_by, updated_at) VALUES (gen_random_uuid(), 'backfill_all_last', $1, 'backfill', 'sync', NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify({ at: new Date().toISOString(), summary }).slice(0, 9000)]);
      } catch (e: any) { console.error('backfill-all', e.message); }
      finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
    })().catch((e) => console.error('backfill-all outer', e));
  });
  app.get('/api/admin/sync/backfill-status', async (_req: Request, res: Response) => {
    try { const r: any = await db.execute(sql.raw("SELECT value, updated_at FROM system_settings WHERE key='backfill_all_last'")); res.json(r.rows[0] || { empty: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
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

  // POST /api/admin/sync/align-enums { table, dryRun? } — adiciona aos enums do 2.0 os valores presentes nos dados do 1.0.
  // ADITIVO/SEGURO: ALTER TYPE ... ADD VALUE IF NOT EXISTS. Resolve "invalid input value for enum" no sync.
  app.post('/api/admin/sync/align-enums', async (req: Request, res: Response) => {
    const tbl = (req.body?.table || '') as string;
    if (!tbl) { res.status(400).json({ error: 'informe table' }); return; }
    const dryRun = req.body?.dryRun === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const enumColsRes = await tgt.query(`SELECT a.attname AS col, t.typname AS enumtype
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped AND t.typtype='e'`, [tbl]);
      if (enumColsRes.rows.length === 0) { res.json({ table: tbl, enums: [], note: 'tabela sem colunas enum no 2.0' }); return; }
      const report: any[] = [];
      for (const ec of enumColsRes.rows as Array<{ col: string; enumtype: string }>) {
        const curRes = await tgt.query(`SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1`, [ec.enumtype]);
        const cur = new Set((curRes.rows as any[]).map(r => r.v as string));
        let used: string[] = [];
        try {
          const usedRes = await src.query(`SELECT DISTINCT "${ec.col}"::text AS v FROM "${tbl}" WHERE "${ec.col}" IS NOT NULL`);
          used = (usedRes.rows as any[]).map(r => r.v as string);
        } catch {}
        const missing = used.filter(v => !cur.has(v));
        const added: string[] = []; const errors: any[] = [];
        if (!dryRun) {
          for (const v of missing) {
            try { await tgt.query(`ALTER TYPE "${ec.enumtype}" ADD VALUE IF NOT EXISTS '${String(v).replace(/'/g, "''")}'`); added.push(v); }
            catch (e: any) { errors.push({ value: v, error: (e.message || '').substring(0, 120) }); }
          }
        }
        report.push({ col: ec.col, enumtype: ec.enumtype, missing, added, errors });
      }
      res.json({ table: tbl, dryRun, enums: report });
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
