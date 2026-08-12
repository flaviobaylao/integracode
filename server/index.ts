import { nfVendaWhere, nfVendaFrom, nfData, PIPELINE_POR_NF, VIGENCIA_REGRA_OFICIAL } from "./faturamento-oficial";
// Hora oficial do Brasil — regra unica em shared/tempo.ts.
import { agora, hojeBR, dataCalendario, instanteBR } from '@shared/tempo';
import { registerOfficialPanel } from "./official-panel";
import { registerIaAtendimento } from "./ia-atendimento-panel";
import { registerIaFinalizar } from "./ia-finalizar";
import { registerIaTakeover } from "./ia-takeover";
import { registerIaFila } from "./ia-fila";
import { registerIaDiag } from "./ia-diag";
import { registerCanaisGestao } from "./canais-gestao";
import { registerPolishGestao } from "./polish-gestao";
import { registerCommunicationAutomationsRoutes } from "./communication-automations-routes";
import { registerPaymentVerificationRoutes } from "./payment-verification-routes";
import { registerDelegationRoutes } from "./delegations-routes";
import { registerHotsitePix } from "./hotsite-pix";
import { registerHotsiteCard } from "./hotsite-card";
import { registerPaymentLink } from "./payment-link";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerChangeRequestsRoutes } from "./change-requests-routes";
import { setupVite, log } from "./vite";
import { initializeDefaultAdmin } from "./localAuth";
import path from "path";
import "./scheduler";
import { startSyncWorker, runSync, resetSyncTimestamp } from "./sync-1.0";
import { startSync20Worker, runSync20, resetSync20Timestamp } from "./sync-2.0";
import { db } from "./db";
import { registerOfficialDispatch } from "./official-dispatch";
import { enviarAlertaPositivacaoVendedores } from './positivacao-alert';
import { enviarAlertaNaoVisitados } from './rota-nao-visitados-alert';
import { enviarAlertaDebitosVencidos } from './debitos-vencidos-alert';
import { ensureFinancialAuditSchema } from './financial-audit';
import { webhookTokenGuard } from './webhook-security';
import { registerVisitSummary } from "./visit-summary-route";
import { registerCarteira } from "./carteira-routes";
import { registerCadastroReceitaSync } from "./cadastro-receita-sync";
import { geocodeOne, geocodeProvider, geocodeThrottleMs } from "./geocode-provider";
import { registerGeocodeAnalyze } from "./geocode-analyze";
import { registerReconciliation } from "./reconciliation-routes";
import { registerPaymentTerms } from "./payment-terms-routes";
import { registerChargeGuarantee } from "./charge-guarantee-routes";
import { registerInstagram } from "./instagram-routes";
import { registerLeadCapture } from "./lead-capture";
import { sql } from "drizzle-orm";
import { registerRepescagemRoutes } from './repescagem-routes';
import { registerDashboardHistoryRoutes } from './dashboard-history';
import { authenticateUser, requireRole } from './authMiddleware';
import { registrarBoleto, testarConexaoBoleto, consultarBoleto, boletoIsSandbox, processBoletoWebhook, checkAndSettleBoleto, cancelarBoleto, sweepOpenBoletos } from "./bb-boleto-service";
import { storage } from "./storage";
import { createReceivableFromPipelineItem } from "./billing-pipeline-routes";
import { calculateNextVisitDate } from "../shared/visitSchedule";

const app = express();
registerOfficialDispatch(app);
registerOfficialPanel(app);
registerIaAtendimento(app);
registerIaFinalizar(app);
registerIaTakeover(app);
registerIaFila(app);
registerIaDiag(app);
registerCanaisGestao(app);
registerPolishGestao(app);

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

  // Redireciona a RAIZ do subdominio da loja (loja.bebahonest.com.br) direto para /shop,
  // para que a bio do Instagram possa usar o link limpo (sem o /shop). So afeta o path "/"
  // desse host; qualquer outra rota (/api, /shop, admin em outros hosts) segue normal.
  app.get('/', (req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (host.startsWith('loja.bebahonest.com.br')) {
      return res.redirect(302, '/shop');
    }
    next();
  });

  // ── CENTRAL DE MARKETING — buraco 2: A PORTA DO FIO DE ATRIBUIÇÃO ──
  // `GET /r/:slug` registra o clique e redireciona para o destino já com UTM + cid.
  // É o link curto que vai na bio, no story, na legenda e no anúncio.
  //
  // Fica AQUI de propósito: antes do express.static do /shop e muito antes do
  // catch-all do SPA, para nunca ser interceptado por nenhum dos dois.
  //
  // Três decisões que evitam prejuízo:
  //  1. O clique é gravado SEM await — o cliente nunca espera o banco para ser
  //     redirecionado. Clique perdido é aceitável; cliente esperando não é.
  //  2. Slug desconhecido ou banco fora do ar NÃO dá 404: cai no destino padrão
  //     (/shop). Um link impresso num post não pode morrer por erro nosso.
  //  3. Cache desligado — senão o CDN/navegador serve o 302 antigo e o clique
  //     seguinte nunca chega ao servidor.
  app.get('/r/:slug', async (req, res) => {
    const base = `${req.protocol}://${req.get('host') || 'integracode-production.up.railway.app'}`;
    let destino = new URL('/shop', base).toString();
    try {
      const { resolverSlug, registrarClique, montarDestino } = await import('./mkt-atribuicao');
      const slug = String(req.params.slug || '').toLowerCase().slice(0, 60);
      const link = await resolverSlug(slug);
      if (link) {
        destino = montarDestino(link, base);
        void registrarClique({
          link,
          ua: req.get('user-agent') || '',
          ip: (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || ''),
          referer: req.get('referer') || '',
        });
      } else {
        console.warn('[MKT-ATRIB] slug desconhecido (redirecionado p/ /shop):', slug);
      }
    } catch (e: any) {
      console.error('[MKT-ATRIB] /r/:slug falhou (redireciona mesmo assim):', e?.message || e);
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.redirect(302, destino);
  });

  // ── CENTRAL DE MARKETING — buraco 9: PRESENÇA EM GOOGLE ──
  // robots.txt e sitemap.xml PRECISAM ficar aqui, antes do catch-all do SPA.
  // Antes disso os dois respondiam 200 com o HTML do painel — e robots.txt que
  // devolve HTML não é "faltando", é QUEBRADO: o robô trata como malformado.
  app.get('/robots.txt', async (_req, res) => {
    try {
      const { robotsTxt } = await import('./mkt-google');
      res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(await robotsTxt());
    } catch {
      // Sem o módulo, o mínimo seguro: liberar a loja e apontar o resto.
      res.type('text/plain').send('User-agent: *\nAllow: /shop\nDisallow: /api/\n');
    }
  });
  app.get('/sitemap.xml', async (_req, res) => {
    try {
      const { sitemapXml } = await import('./mkt-google');
      res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(await sitemapXml());
    } catch (e: any) {
      console.error('[MKT-GOOGLE] sitemap falhou:', e?.message || e);
      res.status(500).type('text/plain').send('sitemap indisponivel');
    }
  });

  // O HTML do hotsite servido COM o bloco de SEO (canonical, og:image, JSON-LD,
  // tag do GA4/Ads quando houver ID). À prova de falha: qualquer erro devolve o
  // arquivo original — loja fora do ar por causa de SEO seria o pior negócio.
  let _htmlShopCache: { em: number; html: string } | null = null;
  const servirShop = async (res: any) => {
    const arquivo = path.join(distHotsitePath, "index.html");
    try {
      if (_htmlShopCache && Date.now() - _htmlShopCache.em < 300_000) {
        return res.type('text/html').send(_htmlShopCache.html);
      }
      const fsp = await import('fs/promises');
      const original = await fsp.readFile(arquivo, 'utf8');
      const { injetarSeo } = await import('./mkt-google');
      const html = await injetarSeo(original);
      _htmlShopCache = { em: Date.now(), html };
      return res.type('text/html').send(html);
    } catch (e: any) {
      console.error('[MKT-GOOGLE] injecao de SEO falhou, servindo o original:', e?.message || e);
      return res.sendFile(arquivo);
    }
  };
  // Foto do produto num endereco PUBLICO. As fotos estao gravadas como base64
  // dentro do banco: funciona dentro da loja, mas para o Google nao existe -
  // rich result de produto praticamente exige imagem com endereco buscavel.
  // Fica antes do express.static porque o /shop tem fallthrough desligado.
  app.get('/shop/foto/:produtoId', async (req: any, res: any) => {
    try {
      const { fotoDoProduto } = await import('./mkt-google');
      const f = await fotoDoProduto(String(req.params.produtoId));
      if (!f) return res.status(404).type('text/plain').send('sem foto');
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(f.buf);
    } catch (e: any) {
      console.error('[MKT-GOOGLE] foto do produto falhou:', e?.message || e);
      res.status(404).type('text/plain').send('sem foto');
    }
  });

  app.get(['/shop', '/shop/', '/shop/index.html'], (_req, res) => { void servirShop(res); });

  // Servir arquivos estáticos do hotsite com fallthrough disabled
  app.use('/shop', express.static(distHotsitePath, { fallthrough: false }));

  // Catch-all para servir index.html em rotas do hotsite
  app.all('/shop*', (req, res) => {
    if (req.method === 'GET') return void servirShop(res);
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

  const { fireAutomation } = await import('./automation-engine');
  const server = await registerRoutes(app);

  // 📋 Solicitações de Alteração (inbox admin + botão nos cards). DEVE ficar aqui, entre
  // registerRoutes e o catch-all do SPA (app.use("*")). Removido por engano no refactor
  // "IA linha de frente" (b257db4) — sem isto, POST/GET /api/change-requests caíam no
  // index.html do SPA ("Failed to parse JSON response"). Re-registrado. (29/jul/2026)
  registerChangeRequestsRoutes(app);
  try { registerDashboardHistoryRoutes(app); } catch (e) { console.error('[dashboard-history]', e); }

  // ── Repescagem2: colunas do ciclo diário de sorteio/alocação (idempotente) ──
  (async () => {
    try {
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS draw_date varchar"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS phase varchar"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS carteira_seller_id varchar"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS route_stop_id varchar"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false"));
      await db.execute(sql.raw("CREATE INDEX IF NOT EXISTS idx_repescagem_assign_draw ON repescagem_assignments(draw_date)"));
      await db.execute(sql.raw("ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS check_in_notes text"));
      // Prioridade do card na roteirização (checkbox nas etapas "Aguardando Rota").
      // ⚠️ Coluna adicionada ao schema drizzle → o ALTER PRECISA ficar aqui no boot,
      // senão todo SELECT de billing_pipeline quebra entre o deploy e o ALTER.
      await db.execute(sql.raw("ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS is_priority boolean NOT NULL DEFAULT false"));
      await db.execute(sql.raw("ALTER TABLE leads ADD COLUMN IF NOT EXISTS coordinates_locked boolean NOT NULL DEFAULT false"));
      // Fluxo de retorno de lead (15 dias): colunas de controle (aditivas, idempotentes).
      await db.execute(sql.raw("ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_return_date timestamp"));
      await db.execute(sql.raw("ALTER TABLE leads ADD COLUMN IF NOT EXISTS postponement_count integer NOT NULL DEFAULT 0"));
      await db.execute(sql.raw("ALTER TABLE leads ADD COLUMN IF NOT EXISTS non_conversion_reason varchar"));
      await db.execute(sql.raw("ALTER TABLE leads ADD COLUMN IF NOT EXISTS return_overdue boolean NOT NULL DEFAULT false"));
      // Garante o DEFAULT do id em repescagem_attendants (tabela pode ter sido criada sem ele → INSERT quebrava com NOT NULL).
      await db.execute(sql.raw("ALTER TABLE repescagem_attendants ALTER COLUMN id SET DEFAULT gen_random_uuid()")).catch(() => {});
    } catch (e: any) {
      console.warn('[REPESCAGEM2-MIGRATION] falha (ignorada):', e?.message);
    }
  })();

  // ── CENTRAL DE MARKETING — buraco 7: mkt_agent_runs (custo/token por execucao) ──
  // Aditivo e idempotente. Nao bloqueia o boot: se falhar, o proprio registrarRun
  // tenta de novo na primeira execucao de agente.
  (async () => {
    try {
      const { ensureMktRunsSchema } = await import('./mkt-agent-runs');
      const r = await ensureMktRunsSchema();
      if (!r.ok) console.warn('[MKT-RUNS-MIGRATION] passos com falha:', r.steps.filter((s: any) => !s.ok));
      else console.log('[MKT-RUNS-MIGRATION] ok');
    } catch (e: any) {
      console.warn('[MKT-RUNS-MIGRATION] falha (ignorada):', e?.message);
    }
  })();

  // ── CENTRAL DE MARKETING — buraco 2: fio de atribuição ──
  // Cria mkt_campanhas / mkt_links / mkt_cliques / mkt_toques E as 3 colunas de
  // sales_cards (campaign_id, utm, attribution_kind).
  // ⚠️ Estas 3 colunas ESTÃO no schema drizzle (shared/schema.ts) — por isso este
  // ALTER precisa rodar no boot, senão entre o deploy e a migração todo SELECT de
  // sales_cards quebra. Mesma lição que já custou caro no is_priority.
  (async () => {
    try {
      const { ensureMktAtribuicaoSchema } = await import('./mkt-atribuicao');
      const r = await ensureMktAtribuicaoSchema();
      if (!r.ok) console.warn('[MKT-ATRIB-MIGRATION] passos com falha:', r.steps.filter((s: any) => !s.ok));
      else console.log('[MKT-ATRIB-MIGRATION] ok');
    } catch (e: any) {
      console.warn('[MKT-ATRIB-MIGRATION] falha (ignorada):', e?.message);
    }
  })();

  // ── CENTRAL DE MARKETING — buraco 3: CTWA + Conversions API ──
  // Colunas de origem em chat_conversations + fila mkt_capi_eventos.
  // NASCE DESLIGADO: sem META_PIXEL_ID/META_CAPI_TOKEN e com mkt_capi_mode='off',
  // nada e enviado para a Meta — so gravado para auditoria.
  (async () => {
    try {
      const { ensureMktCtwaSchema } = await import('./mkt-ctwa');
      const r = await ensureMktCtwaSchema();
      if (!r.ok) console.warn('[MKT-CTWA-MIGRATION] passos com falha:', r.steps.filter((s: any) => !s.ok));
      else console.log('[MKT-CTWA-MIGRATION] ok');
    } catch (e: any) {
      console.warn('[MKT-CTWA-MIGRATION] falha (ignorada):', e?.message);
    }
  })();

  // ── Automacoes de Comunicacao: controle de modo (off/test/on) + teste ─────────
  app.get('/api/admin/automations/mode', async (_req, res) => {
    try {
      const m: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'automations_mode'`);
      const t: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'automations_test_number'`);
      const autos: any = await db.execute(sql`SELECT id, name, trigger_event, is_active, recipient_type, recipient_fixed_phone, sent_count, failed_count, last_triggered_at FROM communication_automations ORDER BY name`);
      const strip = (v: any) => v == null ? null : String(v).replace(/^"(.*)"$/, '$1');
      res.json({ mode: strip(m?.rows?.[0]?.value) || 'off', testNumber: strip(t?.rows?.[0]?.value) || '5562995782812', automations: autos?.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/automations/mode', async (req, res) => {
    try {
      const mode = String(req.body?.mode || '').toLowerCase();
      // mode é OPCIONAL: permite salvar só o número de teste (sem trocar o modo).
      if (mode && !['off', 'test', 'on'].includes(mode)) return res.status(400).json({ error: "mode deve ser off|test|on" });
      if (mode) await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('automations_mode', ${mode}, 'automations') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      if (req.body?.testNumber !== undefined) {
        const tn = String(req.body.testNumber).replace(/\D/g, '');
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('automations_test_number', ${tn}, 'automations') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      }
      const _m: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'automations_mode'`);
      const _t: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'automations_test_number'`);
      const _strip = (v: any) => v == null ? null : String(v).replace(/^"(.*)"$/, '$1');
      res.json({ ok: true, mode: _strip(_m?.rows?.[0]?.value) || 'off', testNumber: _strip(_t?.rows?.[0]?.value) || '5562995782812' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/automations/test', async (req, res) => {
    try {
      const ev = String(req.body?.triggerEvent || 'pedido.criado');
      const ctx = req.body?.ctx || {
        customer: { name: 'CLIENTE TESTE' },
        order: { id: 'INT-TESTE01', value: 'R$ 99,90' },
        seller: { name: 'Vendedor Teste' },
        delivery: { orderNumber: 'INT-TESTE01' },
        driver: { name: 'Motorista Teste' },
        sellerPhone: null,
      };
      await fireAutomation(ev, ctx);
      const log: any = await db.execute(sql`SELECT trigger_event, recipient_phone, status, error, mode, created_at FROM automation_dispatch_log ORDER BY created_at DESC LIMIT 5`).catch(() => ({ rows: [] }));
      res.json({ ok: true, fired: ev, recentLog: log?.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  try { registerRepescagemRoutes(app, { authenticateUser, requireRole }); } catch (e) { console.error('[repescagem routes]', e); }

  // ==========================================================================
  // TRAVA DE ACESSO DAS ROTAS DE SYNC (06/ago/2026)
  //
  // As ~33 rotas /api/admin/sync/* estavam TODAS sem autenticacao, expostas na
  // internet. A pior, POST /api/admin/sync/backfill-all, copia o banco do 1.0
  // por cima do 2.0 com ON CONFLICT (id) DO UPDATE SET <todas as colunas> =
  // EXCLUDED, e nao excluia nenhuma tabela financeira. Em 06/08 as 10:43 UTC
  // ela sobrescreveu 14.053 bank_statement_items, 1.207 matches, 2.837
  // receivable_payments e as 5 financial_accounts — revertendo o fechamento de
  // saldo da auditoria (BB-MATRIZ fechara em R$ 5.059,87 com divergencia zero e
  // voltou a divergir R$ 60.055,43 do razao de account_movements).
  //
  // E a causa-raiz que reconciliation-routes.ts:640 ja descrevia como
  // "corrigida em 26/jul": corrigiram criando o endpoint de reparo, mas o
  // caminho de dano continuou aberto.
  //
  // A trava e no PREFIXO, de proposito: cobre as rotas que existem hoje e as
  // que forem criadas depois, sem depender de alguem lembrar do middleware.
  // ==========================================================================
  app.use('/api/admin/sync', authenticateUser, requireRole(['admin']));
  app.use('/api/synced-table', authenticateUser, requireRole(['admin']));

  app.post('/api/admin/sync/customer-ie', async (req, res) => {
    const apply = !!(req.body && req.body.apply === true);
    res.json({ started: true, apply });
    (async () => {
      try {
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS state_registration varchar`).catch(() => {});
        // Envio automatico de documentos por e-mail ao faturar NF (replicado do Integra 1.0)
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_email varchar`).catch(() => {});
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_xml boolean DEFAULT false`).catch(() => {});
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_danfe boolean DEFAULT false`).catch(() => {});
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_boleto boolean DEFAULT false`).catch(() => {});
        await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_pedido boolean DEFAULT false`).catch(() => {});
                const pgMod = await import('pg');
        const PgClient = (pgMod.default && pgMod.default.Client) || pgMod.Client;
        const client = new PgClient({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await client.connect();
        const srcRes = await client.query("SELECT cnpj, cpf, state_registration AS ie FROM customers WHERE state_registration IS NOT NULL AND btrim(state_registration) <> ''");
        await client.end();
        let seen = 0, updated = 0;
        for (const row of srcRes.rows) {
          const doc = String(row.cnpj || row.cpf || '').replace(/\D/g, '');
          const ie = String(row.ie || '').trim();
          if (doc.length < 11 || !ie) continue;
          seen++;
          if (apply) {
            const u = await db.execute(sql`UPDATE customers SET state_registration = ${ie} WHERE (regexp_replace(coalesce(cnpj, ''), '[^0-9]', '', 'g') = ${doc} OR regexp_replace(coalesce(cpf, ''), '[^0-9]', '', 'g') = ${doc}) AND (state_registration IS NULL OR btrim(state_registration) = '')`);
            updated += ((u).rowCount || 0);
          }
        }
        const summary = JSON.stringify({ seen, updated, apply, at: new Date().toISOString() });
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('customer_ie_sync_last', ${summary}, 'nfe-port') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'nfe-port'`);
      } catch (e) { console.error('[customer-ie sync]', e); }
    })();
  });

  app.get('/api/admin/sync/customer-ie/status', async (req, res) => {
    try {
      const r = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'customer_ie_sync_last'`);
      res.json({ last: (r.rows && r.rows[0]) ? r.rows[0].value : null });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/admin/nfe/cert-upload', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(Buffer.from('PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0icHQtYnIiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij48bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSI+PHRpdGxlPlVwbG9hZCBDZXJ0aWZpY2FkbyBBMTwvdGl0bGU+PHN0eWxlPmJvZHl7Zm9udC1mYW1pbHk6c3lzdGVtLXVpLEFyaWFsLHNhbnMtc2VyaWY7bWF4LXdpZHRoOjU2MHB4O21hcmdpbjo0MHB4IGF1dG87cGFkZGluZzowIDE2cHg7Y29sb3I6IzExMX1oMXtmb250LXNpemU6MjBweH1sYWJlbHtkaXNwbGF5OmJsb2NrO21hcmdpbjoxNHB4IDAgNHB4O2ZvbnQtd2VpZ2h0OjYwMH1pbnB1dHt3aWR0aDoxMDAlO3BhZGRpbmc6MTBweDtib3JkZXI6MXB4IHNvbGlkICNjY2M7Ym9yZGVyLXJhZGl1czo4cHg7Ym94LXNpemluZzpib3JkZXItYm94fWJ1dHRvbnttYXJnaW4tdG9wOjE4cHg7cGFkZGluZzoxMnB4IDE4cHg7YmFja2dyb3VuZDojMUY2RjQzO2NvbG9yOiNmZmY7Ym9yZGVyOjA7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjE1cHg7Y3Vyc29yOnBvaW50ZXJ9I291dHttYXJnaW4tdG9wOjE4cHg7d2hpdGUtc3BhY2U6cHJlLXdyYXA7YmFja2dyb3VuZDojZjVmNWY1O3BhZGRpbmc6MTJweDtib3JkZXItcmFkaXVzOjhweH1zbWFsbHtjb2xvcjojNjY2fTwvc3R5bGU+PC9oZWFkPjxib2R5PjxoMT5VcGxvYWQgZGUgQ2VydGlmaWNhZG8gQTEgKE5GLWUpPC9oMT48cD48c21hbGw+RW52aWUgbyAucGZ4Ly5wMTIgZSBhIHNlbmhhLiBGaWNhIGNpZnJhZG8gbm8gYmFuY28uIEVzdGVqYSBsb2dhZG8gbm8gSU5URUdSQSAyLjAgbmVzdGEgbWVzbWEgamFuZWxhLjwvc21hbGw+PC9wPjxsYWJlbD5BcnF1aXZvIC5wZnggLyAucDEyPC9sYWJlbD48aW5wdXQgaWQ9ImYiIHR5cGU9ImZpbGUiIGFjY2VwdD0iLnBmeCwucDEyIj48bGFiZWw+U2VuaGEgZG8gY2VydGlmaWNhZG88L2xhYmVsPjxpbnB1dCBpZD0icCIgdHlwZT0icGFzc3dvcmQiIGF1dG9jb21wbGV0ZT0ib2ZmIj48YnV0dG9uIGlkPSJiIj5FbnZpYXIgY2VydGlmaWNhZG88L2J1dHRvbj48ZGl2IGlkPSJvdXQiPjwvZGl2PjxzY3JpcHQ+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImIiKS5vbmNsaWNrPWFzeW5jIGZ1bmN0aW9uKCl7dmFyIG91dD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgib3V0Iik7dmFyIGY9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImYiKS5maWxlc1swXTt2YXIgcD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicCIpLnZhbHVlO2lmKCFmKXtvdXQudGV4dENvbnRlbnQ9IlNlbGVjaW9uZSBvIGFycXVpdm8gLnBmeCI7cmV0dXJufW91dC50ZXh0Q29udGVudD0iRW52aWFuZG8uLi4iO3ZhciBmZD1uZXcgRm9ybURhdGEoKTtmZC5hcHBlbmQoInBmeEZpbGUiLGYpO2ZkLmFwcGVuZCgicGFzc3dvcmQiLHApO3RyeXt2YXIgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaWdpdGFsLWNlcnRpZmljYXRlcyIse21ldGhvZDoiUE9TVCIsYm9keTpmZCxjcmVkZW50aWFsczoiaW5jbHVkZSJ9KTt2YXIgaj17fTt0cnl7aj1hd2FpdCByLmpzb24oKX1jYXRjaChlKXt9aWYoci5vayl7b3V0LnRleHRDb250ZW50PSJPSyEgQ2VydGlmaWNhZG8gY2FkYXN0cmFkbzogIitKU09OLnN0cmluZ2lmeShqKX1lbHNle291dC50ZXh0Q29udGVudD0iRVJSTyAoIityLnN0YXR1cysiKTogIisoai5tZXNzYWdlfHxKU09OLnN0cmluZ2lmeShqKSl9fWNhdGNoKGUpe291dC50ZXh0Q29udGVudD0iRmFsaGE6ICIrZX19PC9zY3JpcHQ+PC9ib2R5PjwvaHRtbD4=', 'base64').toString('utf8')); });
  registerPaymentVerificationRoutes(app);
  registerCommunicationAutomationsRoutes(app);
  registerHotsitePix(app);
  registerHotsiteCard(app);

  // 📣 CANAIS DE VENDA (Hotsite + Instagram) — pagina unica de gestao (04/ago/2026)
  try {
    const { registerCanaisRoutes } = await import('./canais-routes');
    registerCanaisRoutes(app);
  } catch (e: any) { console.error('[canais routes]', e?.message || e); }
  registerPaymentLink(app);
  registerVisitSummary(app);
  registerCarteira(app);
  registerCadastroReceitaSync(app);
  registerGeocodeAnalyze(app);
  registerReconciliation(app);
  registerPaymentTerms(app);
  registerChargeGuarantee(app);
  registerInstagram(app);
  registerLeadCapture(app);
  registerDelegationRoutes(app);

  // Re-vincula active_customers.customerId ao cliente correto do 2.0 POR DOCUMENTO (corrige id orfao/conflito de identidade).
  app.post('/api/admin/sync/relink-active-customers', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    try {
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const RAD = 'e9149282-adfc-448e-8d0e-a07765a06637';
      const cr: any = await db.execute(sql.raw("SELECT id, cnpj, cpf, seller_id FROM customers"));
      const cust = (cr.rows || cr) as any[];
      const norm = (x: any) => String(x || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const docToId = new Map<string, string>(); const sellerById = new Map<string, string>(); const nameToId = new Map<string, string | null>();
      const cnR: any = await db.execute(sql.raw("SELECT id, name, fantasy_name FROM customers"));
      const nameRows = (cnR.rows || cnR) as any[];
      for (const c of cust) { sellerById.set(String(c.id), String(c.seller_id || '')); for (const d of [dg(c.cnpj), dg(c.cpf)]) { if (d && d.length >= 11 && !docToId.has(d)) docToId.set(d, String(c.id)); } }
      for (const c of nameRows) { for (const nm of [norm(c.name), norm(c.fantasy_name)]) { if (nm.length >= 5) { if (!nameToId.has(nm)) nameToId.set(nm, String(c.id)); else if (nameToId.get(nm) !== String(c.id)) nameToId.set(nm, null); } } }
      const ar: any = await db.execute(sql.raw("SELECT id, document, customer_id, is_active, fantasy_name_imported FROM active_customers"));
      const acs = (ar.rows || ar) as any[];
      let relink = 0, jaOk = 0, semMatch = 0, ativos = 0, viaNome = 0;
      const toFix: Array<{ id: string; cid: string }> = [];
      const cidOf = (a: any): string | undefined => {
        const d = dg(a.document);
        let cid = (d && d.length >= 11) ? docToId.get(d) : undefined;
        if (!cid) { const nm = norm(a.fantasy_name_imported); if (nm.length >= 5) { const v = nameToId.get(nm); if (v) cid = v; } }
        return cid;
      };
      for (const a of acs) {
        if (a.is_active === true) ativos++;
        const d = dg(a.document); const byDoc = (d && d.length >= 11) ? docToId.get(d) : undefined;
        const cid = cidOf(a);
        if (!cid) { semMatch++; continue; }
        if (!byDoc && cid) viaNome++;
        if (String(a.customer_id || '') === cid) { jaOk++; } else { toFix.push({ id: String(a.id), cid }); }
      }
      const result: any = { totalActive: acs.length, ativosOn: ativos, jaVinculadosOk: jaOk, aReligar: toFix.length, semMatchDoc: semMatch, apply, relinked: 0 };
      if (apply) {
        for (const f of toFix) { try { const u: any = await db.execute(sql`UPDATE active_customers SET customer_id = ${f.cid}, match_status = 'matched', updated_at = now() WHERE id = ${f.id}`); relink += (u.rowCount || 0); } catch (e) {} }
        result.relinked = relink;
      }
      // Radilton: linhas ATIVAS cujo cliente vinculado (por doc) tem seller = RAD
      let radAtivo = 0;
      for (const a of acs) {
        if (a.is_active !== true) continue;
        const cid = cidOf(a);
        if (cid && sellerById.get(cid) === RAD) radAtivo++;
      }
      result.radiltonAtivos = radAtivo; result.viaNome = viaNome;
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) }); }
  });

  // CHECAGEM DE PARIDADE do cadastro de clientes 1.0 x 2.0, casado por DOCUMENTO. Reporta diffs por campo.
  app.get('/api/admin/sync/customers-parity', async (_req: Request, res: Response) => {
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const nz = (v: any) => (v === null || v === undefined) ? '' : String(v).trim();
      const colQ = "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'";
      const sCols = new Set((await src.query(colQ)).rows.map((r: any) => r.column_name));
      const tCols = new Set((await tgt.query(colQ)).rows.map((r: any) => r.column_name));
      const EXCLUDE = new Set(['id', 'created_at', 'updated_at']);
      const cmpCols = [...sCols].filter((c: any) => tCols.has(c) && !EXCLUDE.has(c));
      const sel = 'SELECT ' + ['cnpj','cpf',...cmpCols.filter((c)=>c!=='cnpj'&&c!=='cpf')].map((c)=>'"'+c+'"::text AS "'+c+'"').join(',') + ' FROM customers';
      const s1 = (await src.query(sel)).rows as any[];
      const t2 = (await tgt.query(sel)).rows as any[];
      const t2doc = new Map<string, any>();
      for (const c of t2) { for (const d of [dg(c.cnpj), dg(c.cpf)]) { if (d && d.length >= 11 && !t2doc.has(d)) t2doc.set(d, c); } }
      const perField: Record<string, number> = {};
      let matched = 0, only1 = 0, semDoc1 = 0;
      for (const a of s1) {
        const dc = dg(a.cnpj), dp = dg(a.cpf);
        if (!((dc && dc.length >= 11) || (dp && dp.length >= 11))) { semDoc1++; continue; }
        const b = t2doc.get((dc && dc.length>=11 && t2doc.has(dc)) ? dc : dp);
        if (!b) { only1++; continue; }
        matched++;
        const numEq = (x: any, y: any) => { const nx = parseFloat(x), ny = parseFloat(y); if (!isNaN(nx) && !isNaN(ny)) return Math.abs(nx - ny) < 0.0000015; return null; };
        const normVal = (v: any) => { const t = nz(v); if (t.startsWith('[') || t.startsWith('{')) { try { return JSON.stringify(JSON.parse(t)); } catch (e) {} } return t; };
        for (const c of cmpCols) { const av = a[c], bv = b[c]; const ne = numEq(av, bv); if (ne === true) continue; if (ne === false) { perField[c] = (perField[c] || 0) + 1; continue; } if (normVal(av) !== normVal(bv)) perField[c] = (perField[c] || 0) + 1; }
      }
      const perFieldSorted = Object.entries(perField).sort((x, y) => y[1] - x[1]).reduce((o: any, [k, v]) => (o[k] = v, o), {});
      res.json({ src1_0: s1.length, tgt2_0: t2.length, casadosPorDoc: matched, so_no_1_0: only1, no_1_0_sem_doc: semDoc1, diffsPorCampo: perFieldSorted });
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) }); }
    finally { await src.end().catch(()=>{}); await tgt.end().catch(()=>{}); }
  });

  // ROTINA: gera agendamentos no 2.0 ancorando na ULTIMA VISITA AGENDADA no 1.0 (pre go-live).
  // Regra: proxima = ultima agendada(1.0) + intervalo (7/14/28/56), no dia da semana do cliente,
  // pulando atrasos ate a proxima data FUTURA na cadencia. Sem ancora -> comeca de hoje.
  app.post('/api/admin/visits/generate-from-1-0', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const count = Math.max(1, Math.min(6, Number(req.body?.count) || 4));
    const replaceFuture = req.body?.replaceFuture !== false; // default true no apply
    try {
      // 1) ÚLTIMO ATENDIMENTO por cliente (Integra 2.0). Âncora = data do último atendimento real
      //    ao cliente: atendimento virtual (virtual_service_logs) ou visita/venda concluída no card
      //    de venda (sales_cards: completed_date / check_in_time). NÃO usa mais a agenda do Integra 1.0.
      const lastAtendR: any = await db.execute(sql`
        SELECT customer_id, MAX(dt) AS last_atend FROM (
          SELECT customer_id, attendance_date AS dt FROM virtual_service_logs
            WHERE entity_type = 'customer' AND attendance_date IS NOT NULL
          UNION ALL
          SELECT customer_id, completed_date AS dt FROM sales_cards
            WHERE completed_date IS NOT NULL AND status IN ('completed','no_sale')
          UNION ALL
          SELECT customer_id, check_in_time AS dt FROM sales_cards
            WHERE check_in_time IS NOT NULL
        ) t GROUP BY customer_id`);
      const lastAtendByCustomer = new Map<string, Date>();
      for (const r of ((lastAtendR.rows || lastAtendR) as any[])) {
        if (r.customer_id && r.last_atend) lastAtendByCustomer.set(String(r.customer_id), new Date(r.last_atend));
      }
      // 2) clientes ativos do 2.0 (com dias + periodicidade, nao-fornecedor)
      const custR: any = await db.execute(sql`SELECT id, seller_id, name, cnpj, cpf, weekdays, visit_periodicity, virtual_service, latitude, longitude, address, service_start_date
        FROM customers WHERE (is_supplier IS NOT TRUE) AND weekdays IS NOT NULL AND visit_periodicity IS NOT NULL AND is_active = true AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = customers.id AND ac.is_active IS TRUE)`);
      const cust = (custR.rows || custR) as any[];
      const ABBR: any = { Dom: 0, Seg: 1, Ter: 2, Qua: 3, Qui: 4, Sex: 5, Sab: 6, dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
      const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      // BLINDAGEM (31/jul/2026): mesmo o seed replaceFuture nunca remove a visita de HOJE nem do
      // passado; substitui apenas do dia seguinte em diante, preservando a Rota do Dia vigente.
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const parseWk = (w: any): string[] => { let x = w; if (typeof x === 'string') { const tt = x.trim(); if (tt.startsWith('[')) { try { x = JSON.parse(tt); } catch (e) { x = []; } } else x = tt ? [tt] : []; } if (!Array.isArray(x)) x = []; return x.map((d: any) => String(d)); };
      const result: any = { apply, count, totalClientes: cust.length, comAncora: 0, semAncora: 0, semDiaValido: 0, visitasInseridas: 0, futurasRemovidas: 0, amostras: [] as any[], erros: 0 };
      // por cliente: guarda ancoraThreshold p/ delete seletivo (preserva visitas ate a ancora)
      const insertRows: any[] = [];
      const delThreshold: Record<string, string> = {}; // customerId -> ISO (apaga futuras pendentes > este)
      for (const c of cust) {
        try {
          const weekdaysRaw = parseWk(c.weekdays);
          const targetNums = weekdaysRaw.map((d) => ABBR[d]).filter((n: any) => n != null);
          if (targetNums.length === 0) { result.semDiaValido++; continue; }
          const periodicity = String(c.visit_periodicity) as any;
          // ÂNCORA = data do último atendimento do cliente (2.0). Sem atendimento → agenda a partir de hoje.
          const anchor = lastAtendByCustomer.get(String(c.id)) || null;
          if (anchor) result.comAncora++; else result.semAncora++;
          // Data de início do fornecimento: quando registrada, é a âncora de início da
          // periodicidade — nenhuma visita antes dela (o núcleo aplica o piso).
          const svcStart = c.service_start_date ? new Date(c.service_start_date) : null;
          if (svcStart) svcStart.setHours(0, 0, 0, 0);
          const startFuture = svcStart && svcStart.getTime() >= today.getTime();
          // Gera `count` próximas visitas seguindo as REGRAS BASE (calculateNextVisitDate):
          // semanal=+7, quinzenal=+14, mensal=1ª ocorrência do dia de rota no mês seguinte.
          // Avança a partir da âncora até cair em data futura (>= hoje), depois encadeia.
          const dates: Date[] = [];
          let cursor: Date | null = anchor ? new Date(anchor) : null;
          let guard = 0;
          while (dates.length < count && guard < 2000) {
            guard++;
            let next: Date;
            try {
              next = calculateNextVisitDate(cursor
                ? { weekdays: weekdaysRaw, periodicity, lastCompletedDate: cursor, serviceStartDate: svcStart || undefined }
                : { weekdays: weekdaysRaw, periodicity, referenceDate: today, serviceStartDate: svcStart || undefined }).nextDate;
            } catch (e) { break; }
            if (cursor && next.getTime() <= cursor.getTime()) break; // trava anti-loop
            cursor = next;
            if (next >= today) dates.push(next);
          }
          if (dates.length === 0) { result.semDiaValido++; continue; }
          // limite de exclusao:
          //  - início do fornecimento futuro → apaga TODAS as futuras (inclui as erradas antes do início) e recria a partir dele;
          //  - senão, se âncora futura, preserva até ela (apaga > âncora); caso contrário apaga tudo futuro (> ontem).
          const aDate = anchor ? new Date(anchor) : null; if (aDate) aDate.setHours(23,59,59,0);
          delThreshold[c.id] = startFuture
            ? new Date(today.getTime() - 86400000).toISOString()
            : ((aDate && aDate >= today) ? aDate.toISOString() : new Date(today.getTime() - 86400000).toISOString());
          if (result.amostras.length < 12) result.amostras.push({ periodicidade: c.visit_periodicity, dias: targetNums.map((n: number) => DOW[n]).join(','), ancora: anchor ? new Date(anchor).toISOString().slice(0, 10) : null, geradas: dates.map((x) => x.toISOString().slice(0, 10)) });
          for (const dt of dates) insertRows.push({ cid: c.id, sid: c.seller_id || '', name: c.name || '', sd: dt.toISOString(), rd: DOW[dt.getDay()], rec: c.visit_periodicity, iv: c.virtual_service === true, lat: c.latitude, lng: c.longitude, addr: c.address });
        } catch (e) { result.erros++; }
      }
      if (!apply) {
        result.visitasInseridas = insertRows.length; // seria inserido
        return res.json(result);
      }
      // APPLY em segundo plano (evita timeout do gateway). Status em system_settings 'visits_seed_last'.
      res.json({ started: true, ...result, visitasPlanejadas: insertRows.length, msg: 'Gerando em segundo plano. Consulte /api/admin/visits/generate-from-1-0/status' });
      (async () => {
        let removed = 0, inserted = 0, errs = 0;
        try {
          if (replaceFuture) {
            for (const c of cust) {
              const th = delThreshold[c.id]; if (!th) continue;
              try { const del: any = await db.execute(sql`DELETE FROM visit_agenda WHERE customer_id = ${c.id} AND visit_status = 'pending' AND scheduled_date >= ${tomorrow.toISOString()} AND scheduled_date > ${th}`); removed += (del.rowCount || 0); } catch (e) { errs++; }
            }
          }
          for (let i = 0; i < insertRows.length; i += 400) {
            const batch = insertRows.slice(i, i + 400);
            const vals = batch.map((b) => sql`(${b.cid}, ${b.sid}, ${b.sd}, ${b.rd}, ${b.rec}, ${b.iv}, 'pending', ${b.name}, ${b.lat}, ${b.lng}, ${b.addr})`);
            try { await db.execute(sql`INSERT INTO visit_agenda (customer_id, seller_id, scheduled_date, route_day, recurrence_type, is_virtual, visit_status, customer_name, customer_latitude, customer_longitude, customer_address) VALUES ${sql.join(vals, sql`, `)} ON CONFLICT DO NOTHING`); inserted += batch.length; } catch (e) { errs++; }
          }
        } catch (e) { errs++; }
        try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('visits_seed_last', ${JSON.stringify({ at: new Date().toISOString(), clientes: cust.length, comAncora: result.comAncora, semAncora: result.semAncora, semDiaValido: result.semDiaValido, futurasRemovidas: removed, visitasInseridas: inserted, erros: errs })}, 'visits-seed') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch (e) {}
      })();
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) }); }
  });

  app.get('/api/admin/routes/day-check', async (req: Request, res: Response) => {
    try {
      const raw = String(req.query.date || hojeBR());
      const dateStr = raw.replace(/[^0-9-]/g, '');
      const q = "SELECT c.seller_id AS sid, COUNT(DISTINCT va.customer_id)::int AS n, COUNT(DISTINCT va.customer_id) FILTER (WHERE va.is_virtual IS TRUE)::int AS virt FROM visit_agenda va JOIN customers c ON c.id = va.customer_id WHERE va.visit_status = 'pending' AND va.scheduled_date >= '" + dateStr + " 00:00:00' AND va.scheduled_date <= '" + dateStr + " 23:59:59' AND c.omie_status = 'ativo' AND c.is_active IS TRUE AND c.is_supplier IS NOT TRUE AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL GROUP BY c.seller_id ORDER BY n DESC LIMIT 12";
      const ag: any = await db.execute(sql.raw(q));
      const rowsAg = (ag.rows || ag) as any[];
      const out: any[] = [];
      for (const r of rowsAg) {
        const sid = String(r.sid);
        const rota = await storage.getCustomersForDate(sid, new Date(dateStr + 'T12:00:00.000Z'));
        let gravada: any = null;
        try {
          const dr: any = await db.execute(sql.raw("SELECT total_visits FROM daily_routes WHERE seller_id = '" + sid.replace(/[^0-9a-zA-Z-]/g, '') + "' AND route_date >= '" + dateStr + " 00:00:00' AND route_date <= '" + dateStr + " 23:59:59' LIMIT 1"));
          const drr = (dr.rows || dr) as any[];
          gravada = drr.length ? Number(drr[0].total_visits) : null;
        } catch {}
        const esperadaFisica = Number(r.n) - Number(r.virt || 0);
        out.push({ seller: sid, agenda: Number(r.n), virtuais: Number(r.virt || 0), rotaCalc: rota.length, rotaGravada: gravada, esperadaFisica, bate: rota.length === Number(r.n) });
      }
      res.json({ data: dateStr, comparacao: out });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) }); }
  });

  // VIGIA (03/jul/2026): validacao de rota (planejado x rota gravada) — alimenta /validacao-rotas.
  // Planejado = storage.getCustomersForDate (mesma fonte que gera a rota, Opcao A).
  // Rota gravada = daily_routes.visit_stops (entityType customer). Read-only.
  app.get('/api/routes/validate', async (req: Request, res: Response) => {
    try {
      const clean = (v: any) => String(v || '').replace(/[^0-9-]/g, '');
      const startDate = clean(req.query.startDate) || hojeBR();
      const endDate = clean(req.query.endDate) || startDate;
      const start = new Date(startDate + 'T00:00:00.000Z');
      const end = new Date(endDate + 'T00:00:00.000Z');
      let days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
      if (!(days > 0)) days = 1;
      if (days > 62) days = 62;
      const dateRanges: any[] = [];
      const missing: any[] = [];
      const extra: any[] = [];
      let totalPlanned = 0;
      let totalInRoutes = 0;
      for (let d = 0; d < days; d++) {
        const dt = new Date(start.getTime());
        dt.setUTCDate(dt.getUTCDate() + d);
        const ds = dt.toISOString().split('T')[0];
        const rq = "SELECT id::text AS id, seller_id AS sid, visit_stops FROM daily_routes WHERE route_date >= '" + ds + " 00:00:00' AND route_date <= '" + ds + " 23:59:59'";
        const rr: any = await db.execute(sql.raw(rq));
        const routes = (rr.rows || rr) as any[];
        for (const route of routes) {
          const sid = String(route.sid || '');
          const stops = route.visit_stops || {};
          const routeCustomerIds = new Set<string>();
          for (const k of Object.keys(stops)) {
            const st = (stops as any)[k];
            if (st && st.entityType === 'customer' && st.entityId) routeCustomerIds.add(String(st.entityId));
          }
          let planned: any[] = [];
          try { planned = await storage.getCustomersForDate(sid, new Date(ds + 'T12:00:00.000Z')); } catch {}
          const plannedIds = new Set(planned.map((p: any) => String(p.id)));
          for (const p of planned) {
            if (!routeCustomerIds.has(String(p.id))) {
              missing.push({ customerName: (p.name || String(p.id)), date: ds, sellerId: sid });
            }
          }
          for (const cid of Array.from(routeCustomerIds)) {
            if (!plannedIds.has(cid)) {
              extra.push({ customerId: cid, date: ds, routeId: String(route.id) });
            }
          }
          const dayMissing = planned.filter((p: any) => !routeCustomerIds.has(String(p.id))).length;
          const dayExtra = Array.from(routeCustomerIds).filter((cid) => !plannedIds.has(cid)).length;
          totalPlanned += planned.length;
          totalInRoutes += routeCustomerIds.size;
          dateRanges.push({ date: ds, sellerId: sid, planned: planned.length, inRoute: routeCustomerIds.size, status: (dayMissing === 0 && dayExtra === 0) ? 'ok' : 'issues' });
        }
      }
      const withIssues = dateRanges.filter((r) => r.status !== 'ok').length;
      const ok = dateRanges.length - withIssues;
      res.json({ success: true, validation: { totalPlanned, totalInRoutes, dateRanges, missing, extra, wrongSeller: [], summary: { ok, withIssues } }, message: dateRanges.length + ' rota(s) verificada(s)' });
    } catch (e: any) {
      res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
    }
  });

  // REBUILD de rotas do dia a partir da agenda (02/jul/2026): apaga daily_routes sem checkpoint
  // na(s) data(s) e regenera pela visit_agenda (planDailyRoute corrigido p/ Opcao A).
  app.post('/api/admin/routes/rebuild-day', async (req: Request, res: Response) => {
    try {
      const raw = String((req.body && req.body.date) || hojeBR());
      const dateStr = raw.replace(/[^0-9-]/g, '');
      const days = Math.min(Math.max(parseInt(String((req.body && req.body.days) || '1'), 10) || 1, 1), 14);
      res.json({ ok: true, started: true, date: dateStr, days });
      (async () => {
        const summary: any[] = [];
        const { generateDailyRoute } = await import('./routeOptimizationService');
        for (let d = 0; d < days; d++) {
          const dt = new Date(dateStr + 'T00:00:00.000Z');
          dt.setUTCDate(dt.getUTCDate() + d);
          const ds = dt.toISOString().split('T')[0];
          const day: any = { date: ds, deleted: 0, regenerated: 0, keptWithCheckpoints: 0, errors: [] };
          try {
            const rq = "SELECT dr.id::text AS id, (SELECT COUNT(*) FROM route_checkpoints rc WHERE rc.daily_route_id = dr.id)::int AS cps FROM daily_routes dr WHERE dr.route_date >= '" + ds + " 00:00:00' AND dr.route_date <= '" + ds + " 23:59:59'";
            const rr: any = await db.execute(sql.raw(rq));
            for (const r of ((rr.rows || rr) as any[])) {
              if (Number(r.cps) > 0) { day.keptWithCheckpoints++; continue; }
              await db.execute(sql.raw("DELETE FROM daily_routes WHERE id = '" + String(r.id).replace(/[^0-9a-fA-F-]/g, '') + "'"));
              day.deleted++;
            }
            const sq = "SELECT c.seller_id AS sid FROM visit_agenda va JOIN customers c ON c.id = va.customer_id WHERE va.visit_status = 'pending' AND va.scheduled_date >= '" + ds + " 00:00:00' AND va.scheduled_date <= '" + ds + " 23:59:59' AND c.omie_status = 'ativo' AND c.is_active IS TRUE AND c.is_supplier IS NOT TRUE AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL AND c.seller_id IS NOT NULL GROUP BY c.seller_id";
            const sr: any = await db.execute(sql.raw(sq));
            for (const s of ((sr.rows || sr) as any[])) {
              const sid = String(s.sid || '');
              if (!sid) continue;
              try {
                const routeDate = new Date(ds + 'T00:00:00.000Z');
                const existing = await storage.getDailyRouteBySellerAndDate(sid, routeDate);
                if (existing) continue;
                await generateDailyRoute(storage as any, sid, routeDate);
                day.regenerated++;
              } catch (e: any) { if (day.errors.length < 6) day.errors.push(sid + ': ' + String((e && e.message) || e).slice(0, 90)); }
            }
          } catch (e: any) { day.errors.push(String((e && e.message) || e).slice(0, 140)); }
          summary.push(day);
        }
        try {
          const payload = JSON.stringify({ at: new Date().toISOString(), summary });
          const ex: any = await db.execute(sql.raw("SELECT 1 FROM system_settings WHERE key = 'routes_rebuild_last'"));
          if (((ex.rows || ex) as any[]).length > 0) {
            await db.execute(sql`UPDATE system_settings SET value = ${payload}, updated_at = now() WHERE key = 'routes_rebuild_last'`);
          } else {
            await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by) VALUES ('routes_rebuild_last', ${payload}, 'ultimo rebuild de rotas do dia', 'rebuild-day')`);
          }
        } catch (e) { console.error('rebuild-day: erro ao salvar resumo', e); }
      })().catch((e) => console.error('rebuild-day: erro geral', e));
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  app.get('/api/admin/routes/rebuild-day/status', async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'routes_rebuild_last'"));
      const rows = (r.rows || r) as any[];
      res.json(rows.length ? JSON.parse(rows[0].value) : { none: true });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  // AVISO ROTA DO DIA (02/jul/2026): clientes com visita pendente no dia SEM coordenada (ficam fora da rota otimizada)
  app.get('/api/admin/routes/missing-coords', async (req: Request, res: Response) => {
    try {
      const sellerId = String(req.query.sellerId || '');
      const dateStr = String(req.query.date || '').replace(/[^0-9-]/g, '');
      if (!sellerId || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { res.status(400).json({ error: 'sellerId e date (YYYY-MM-DD) obrigatorios' }); return; }
      const r: any = await db.execute(sql`SELECT DISTINCT c.id, c.name, c.city FROM visit_agenda va JOIN customers c ON c.id = va.customer_id LEFT JOIN users u ON u.id = ${sellerId} WHERE va.visit_status = 'pending' AND va.scheduled_date >= ${dateStr + ' 00:00:00'}::timestamp AND va.scheduled_date <= ${dateStr + ' 23:59:59'}::timestamp AND (va.is_virtual IS NOT TRUE) AND c.omie_status = 'ativo' AND c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND (c.latitude IS NULL OR c.longitude IS NULL) AND (c.seller_id = ${sellerId} OR (u.omie_vendor_code IS NOT NULL AND (c.seller_id = u.omie_vendor_code OR c.seller_id = ('omie-vendor-' || u.omie_vendor_code)))) ORDER BY c.name`);
      const rows = ((r.rows || r) as any[]).map((x) => ({ id: x.id, name: x.name, city: x.city }));
      res.json({ count: rows.length, customers: rows });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  // GEOCODIFICACAO (02/jul/2026): preenche lat/long por endereco p/ clientes da lista de Ativos sem coordenada.
  // Provedor: Google Geocoding quando ha GOOGLE_MAPS_API_KEY; senao Nominatim/OSM (ver geocode-provider.ts).
  // Dry-run por padrao; {apply:true} grava apenas quando a cidade retornada confere com a do cadastro.
  // {skipApproximate:true} descarta centroide de bairro/cidade em vez de grava-lo. Fire-and-forget (resumo em geocode_missing_last).
  // ADMIN ONLY: a rota grava lat/long no banco quando {apply:true}. Estava sem
  // authenticateUser/requireRole — qualquer um com a URL podia disparar
  // geocodificacao em massa e gravar em producao. Alinhada com geocode-all.
  app.post('/api/admin/customers/geocode-missing', authenticateUser, requireRole(['admin']), async (req: Request, res: Response) => {
    try {
      const apply = !!(req.body && req.body.apply);
      const skipApproximate = !!(req.body && req.body.skipApproximate);
      const limit = Math.min(Number((req.body && req.body.limit) || 80), 200);
      const sel: any = await db.execute(sql`SELECT c.id, c.name, c.address, c.city FROM customers c WHERE c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND (c.latitude IS NULL OR c.longitude IS NULL) AND COALESCE(TRIM(c.address), '') <> '' AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE) ORDER BY c.name LIMIT ${limit}`);
      const cands = ((sel.rows || sel) as any[]);
      res.json({ ok: true, started: true, apply, candidates: cands.length });
      (async () => {
        const norm = (s: any) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const results: any[] = [];
        let updated = 0, dryOk = 0, unverified = 0, notFound = 0, errors = 0, aproximados = 0;
        for (const c of cands) {
          try {
            const q = [c.address, c.city, 'Brasil'].filter(Boolean).join(', ');
            const hit = await geocodeOne(q);
            if (!hit) { notFound++; results.push({ id: c.id, name: c.name, status: 'nao_encontrado' }); }
            else if (skipApproximate && hit.aproximado) {
              // Centroide de bairro/cidade: varios clientes cairiam no mesmo ponto.
              aproximados++;
              results.push({ id: c.id, name: c.name, status: 'aproximado_ignorado', precisao: hit.precisao, display: String(hit.display_name).slice(0, 90) });
            }
            else {
              const cityToken = norm(c.city).split(' ')[0] || '';
              const cityOk = !!cityToken && norm(hit.display_name).includes(cityToken);
              if (cityOk && apply) {
                await db.execute(sql`UPDATE customers SET latitude = ${String(hit.lat)}, longitude = ${String(hit.lon)}, updated_at = now() WHERE id = ${c.id}`);
                updated++; results.push({ id: c.id, name: c.name, status: 'atualizado', precisao: hit.precisao, lat: hit.lat, lon: hit.lon });
              } else if (cityOk) { dryOk++; results.push({ id: c.id, name: c.name, status: 'ok_dry_run', precisao: hit.precisao, lat: hit.lat, lon: hit.lon, display: String(hit.display_name).slice(0, 90) }); }
              else { unverified++; results.push({ id: c.id, name: c.name, status: 'cidade_nao_confere', precisao: hit.precisao, display: String(hit.display_name).slice(0, 90) }); }
            }
          } catch (e: any) { errors++; results.push({ id: c.id, name: c.name, status: 'erro', err: String((e && e.message) || e).slice(0, 80) }); }
          await new Promise((rs) => setTimeout(rs, geocodeThrottleMs()));
        }
        try {
          const payload = JSON.stringify({ at: new Date().toISOString(), provider: geocodeProvider(), apply, skipApproximate, candidates: cands.length, updated, dryOk, unverified, notFound, aproximados, errors, results });
          const ex: any = await db.execute(sql.raw("SELECT 1 FROM system_settings WHERE key = 'geocode_missing_last'"));
          if (((ex.rows || ex) as any[]).length > 0) {
            await db.execute(sql`UPDATE system_settings SET value = ${payload}, updated_at = now() WHERE key = 'geocode_missing_last'`);
          } else {
            await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by) VALUES ('geocode_missing_last', ${payload}, 'ultima geocodificacao em lote', 'geocode-missing')`);
          }
        } catch (e) { console.error('geocode-missing: erro ao salvar resumo', e); }
      })().catch((e) => console.error('geocode-missing: erro geral', e));
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  // ADMIN ONLY: o resumo expõe nome e coordenada dos clientes processados.
  app.get('/api/admin/customers/geocode-missing/status', authenticateUser, requireRole(['admin']), async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'geocode_missing_last'"));
      const rows = (r.rows || r) as any[];
      res.json(rows.length ? JSON.parse(rows[0].value) : { none: true });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  // GEOCODIFICACAO EM LOTE - TODOS (14/jul/2026): preenche/recalcula lat/long de TODOS os clientes (exceto coordenadas travadas).
  // PJ (com CNPJ) usa o endereco fiscal ja cadastrado (origem do CNPJ); PF usa o endereco de cadastro no Integra.
  // Provedor: Google Geocoding quando ha GOOGLE_MAPS_API_KEY; senao Nominatim/OSM (ver geocode-provider.ts).
  // Verifica se a cidade retornada confere com a do cadastro antes de gravar. Dry-run por padrao; {apply:true} grava.
  // {recalc:true} reprocessa quem ja tem coordenada; senao apenas os sem coordenada.
  // {skipApproximate:true} descarta centroide de bairro/cidade em vez de grava-lo (evita clientes empilhados no mesmo ponto).
  // Fire-and-forget (resumo em geocode_all_last, admin only).
  app.post('/api/admin/customers/geocode-all', authenticateUser, requireRole(['admin']), async (req: Request, res: Response) => {
    try {
      const apply = !!(req.body && req.body.apply);
      const recalc = !!(req.body && req.body.recalc);
      const skipApproximate = !!(req.body && req.body.skipApproximate);
      const limit = Math.min(Math.max(Number((req.body && req.body.limit) || 1200), 1), 3000);
      // Escopo opcional: geocodificar SOMENTE os clientes selecionados (edição em massa).
      const customerIds: string[] | null = Array.isArray(req.body?.customerIds)
        ? (req.body.customerIds as any[]).map((x) => String(x)).filter(Boolean)
        : null;
      const hasSelection = !!(customerIds && customerIds.length);
      const selectedFilter = hasSelection
        ? sql` AND c.id = ANY(string_to_array(${customerIds!.join(',')}, ','))`
        : sql``;
      // Quando há seleção, recalcula todos os selecionados (ignora o filtro "só sem coordenada").
      const missingOnly = (recalc || hasSelection) ? sql`` : sql` AND (c.latitude IS NULL OR c.longitude IS NULL)`;
      const sel: any = await db.execute(sql`SELECT c.id, c.name, c.cnpj, c.cpf, c.address, c.neighborhood, c.city, c.state, c.zip_code FROM customers c WHERE (c.is_supplier IS NOT TRUE) AND (c.coordinates_locked IS NOT TRUE) AND COALESCE(TRIM(c.address), '') <> ''${selectedFilter}${missingOnly} ORDER BY (c.latitude IS NULL OR c.longitude IS NULL) DESC, c.is_active DESC, c.updated_at ASC NULLS FIRST LIMIT ${limit}`);
      const cands = ((sel.rows || sel) as any[]);
      let eligibleTotal = cands.length;
      try {
        const cnt: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM customers c WHERE (c.is_supplier IS NOT TRUE) AND (c.coordinates_locked IS NOT TRUE) AND COALESCE(TRIM(c.address), '') <> ''${selectedFilter}${missingOnly}`);
        eligibleTotal = Number(((cnt.rows || cnt) as any[])[0]?.n || cands.length);
      } catch {}
      const remainingAfter = Math.max(0, eligibleTotal - cands.length);
      res.json({ ok: true, started: true, provider: geocodeProvider(), apply, recalc, skipApproximate, candidates: cands.length, eligibleTotal, remainingAfter });
      (async () => {
        const norm = (s: any) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const results: any[] = [];
        let updated = 0, dryOk = 0, unverified = 0, notFound = 0, errors = 0, pj = 0, pf = 0, processed = 0, aproximados = 0;
        const saveSummary = async (running: boolean) => {
          try {
            const payload = JSON.stringify({ at: new Date().toISOString(), running, provider: geocodeProvider(), apply, recalc, skipApproximate, candidates: cands.length, eligibleTotal, remainingAfter, processed, pj, pf, updated, dryOk, unverified, notFound, aproximados, errors, results: results.slice(-400) });
            const ex: any = await db.execute(sql.raw("SELECT 1 FROM system_settings WHERE key = 'geocode_all_last'"));
            if (((ex.rows || ex) as any[]).length > 0) {
              await db.execute(sql`UPDATE system_settings SET value = ${payload}, updated_at = now() WHERE key = 'geocode_all_last'`);
            } else {
              await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by) VALUES ('geocode_all_last', ${payload}, 'ultima geocodificacao em lote (todos)', 'geocode-all')`);
            }
          } catch (e) { console.error('geocode-all: erro ao salvar resumo', e); }
        };
        await saveSummary(true);
        for (const c of cands) {
          const isPJ = !!(c.cnpj && String(c.cnpj).replace(/\D/g, '').length >= 11);
          if (isPJ) pj++; else pf++;
          try {
            // Limpa ruído do endereço p/ melhorar a resolução no Nominatim:
            // remove "nº"/"n°", "S/N"/"SN", conteúdo entre parênteses e ";" viram vírgula.
            const cleanAddr = (s: any) => String(s || '')
              .replace(/;/g, ', ')
              .replace(/n[º°]/gi, ' ')
              .replace(/\bs\s*\/\s*n\b/gi, ' ')
              .replace(/\bsn\b/gi, ' ')
              .replace(/\([^)]*\)/g, ' ')
              .replace(/\s+/g, ' ').replace(/(\s*,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
            const cepRaw = String(c.zip_code || '').replace(/\D/g, '');
            const cepFmt = cepRaw.length === 8 ? (cepRaw.slice(0, 5) + '-' + cepRaw.slice(5)) : '';
            const addrC = cleanAddr(c.address);
            const cityC = cleanAddr(c.city);
            // Tentativas em ordem decrescente de precisão. Primeiro endereço+CEP; se falhar,
            // CEP sozinho; por fim bairro+cidade (coordenada aproximada, melhor que "sem coordenada").
            const attempts: { parts: any[]; level: string }[] = [];
            if (addrC) attempts.push({ parts: [addrC, c.neighborhood, cityC, c.state, cepFmt, 'Brasil'], level: 'endereco' });
            if (cepFmt) attempts.push({ parts: [cepFmt, cityC, 'Brasil'], level: 'cep' });
            if (c.neighborhood) attempts.push({ parts: [c.neighborhood, cityC, c.state, 'Brasil'], level: 'bairro' });
            let hit: any = null; let matchLevel = '';
            for (let ai = 0; ai < attempts.length; ai++) {
              const q = attempts[ai].parts.filter(Boolean).join(', ');
              if (!q) continue;
              const cand = await geocodeOne(q);
              if (cand) {
                // Rua vaga faz o geocodificador devolver ponto errado na mesma cidade. Se o cliente tem CEP
                // e o CEP do resultado nao bate (5 primeiros digitos), rejeita e tenta o proximo nivel.
                if (attempts[ai].level === 'endereco' && cepRaw.length === 8) {
                  const dc = cand.postcode || '';
                  if (dc && dc.slice(0, 5) !== cepRaw.slice(0, 5)) {
                    if (ai < attempts.length - 1) await new Promise((rs) => setTimeout(rs, geocodeThrottleMs()));
                    continue;
                  }
                }
                hit = cand; matchLevel = attempts[ai].level; break;
              }
              if (ai < attempts.length - 1) await new Promise((rs) => setTimeout(rs, geocodeThrottleMs()));
            }
            if (!hit) { notFound++; results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'nao_encontrado' }); }
            else if (skipApproximate && hit.aproximado) {
              // Centroide de bairro/cidade: gravar isso e o que empilha varios
              // clientes exatamente na mesma coordenada. Melhor reportar.
              aproximados++;
              results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'aproximado_ignorado', nivel: matchLevel, precisao: hit.precisao, display: String(hit.display_name).slice(0, 90) });
            }
            else {
              const cityToken = norm(c.city).split(' ')[0] || '';
              const cityOk = !!cityToken && norm(hit.display_name).includes(cityToken);
              if (cityOk && apply) {
                await db.execute(sql`UPDATE customers SET latitude = ${String(hit.lat)}, longitude = ${String(hit.lon)}, updated_at = now() WHERE id = ${c.id}`);
                updated++; results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'atualizado', nivel: matchLevel, precisao: hit.precisao, lat: hit.lat, lon: hit.lon });
              } else if (cityOk) { dryOk++; results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'ok_dry_run', nivel: matchLevel, precisao: hit.precisao, lat: hit.lat, lon: hit.lon, display: String(hit.display_name).slice(0, 90) }); }
              else { unverified++; results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'cidade_nao_confere', nivel: matchLevel, precisao: hit.precisao, display: String(hit.display_name).slice(0, 90) }); }
            }
          } catch (e: any) { errors++; results.push({ id: c.id, name: c.name, tipo: isPJ ? 'PJ' : 'PF', status: 'erro', err: String((e && e.message) || e).slice(0, 80) }); }
          processed++;
          if (processed % 25 === 0) await saveSummary(true);
          await new Promise((rs) => setTimeout(rs, geocodeThrottleMs()));
        }
        await saveSummary(false);
      })().catch((e) => console.error('geocode-all: erro geral', e));
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  app.get('/api/admin/customers/geocode-all/status', authenticateUser, requireRole(['admin']), async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'geocode_all_last'"));
      const rows = (r.rows || r) as any[];
      res.json(rows.length ? JSON.parse(rows[0].value) : { none: true });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

    // VIGIA 1A (03/jul/2026): Execucao de Rota do dia — planejados x check-ins x vendas x nao-vendas por vendedor
  app.get('/api/admin/routes/execution', async (req: Request, res: Response) => {
    try {
      const raw = String(req.query.date || hojeBR());
      const d = raw.replace(/[^0-9-]/g, '');
      const t1s = "(('" + d + "'::date + INTERVAL '1 day')::timestamp + INTERVAL '3 hours')";
      const evWin = (col: string) => "(" + col + " >= '" + d + " 03:00:00' AND " + col + " < " + t1s + ")";
      const ex = async (q: string) => { const r: any = await db.execute(sql.raw(q)); return (r.rows || r) as any[]; };

      const qPlan = "SELECT c.seller_id AS sid, va.customer_id AS cid, MAX(c.name) AS nome, MAX(c.city) AS cidade FROM visit_agenda va JOIN customers c ON c.id = va.customer_id WHERE va.visit_status = 'pending' AND va.scheduled_date >= '" + d + " 00:00:00' AND va.scheduled_date <= '" + d + " 23:59:59' AND (va.is_virtual IS NOT TRUE) AND c.omie_status = 'ativo' AND c.is_active IS TRUE AND c.is_supplier IS NOT TRUE AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL GROUP BY c.seller_id, va.customer_id";
      const qChk = "SELECT DISTINCT customer_id AS cid FROM sales_cards WHERE " + evWin('check_in_time') + " UNION SELECT DISTINCT customer_id AS cid FROM route_checkpoints WHERE checkpoint_type = 'check_in' AND " + evWin('checkpoint_time');
      const qVen = "SELECT seller_id AS sid, COALESCE(seller_name,'') AS snome, customer_id AS cid, COALESCE(sale_value::numeric,0) AS valor FROM billing_pipeline WHERE " + evWin('created_at');
      const qNos = "SELECT sc.customer_id AS cid, sc.seller_id AS sid, MAX(sc.no_sale_reason) AS motivo, MAX(c.name) AS nome FROM sales_cards sc LEFT JOIN customers c ON c.id = sc.customer_id WHERE sc.no_sale_reason IS NOT NULL AND (" + evWin('sc.check_in_time') + " OR " + evWin('sc.completed_date') + ") GROUP BY sc.customer_id, sc.seller_id";
      const qUsr = "SELECT id, COALESCE(omie_vendor_code,'') AS code, TRIM(CONCAT_WS(' ', first_name, last_name)) AS nome FROM users";

      const plan = await ex(qPlan);
      const chk = await ex(qChk);
      const ven = await ex(qVen);
      const nos = await ex(qNos);
      const usr = await ex(qUsr);

      const byId = new Map<string, string>();
      const codeToId = new Map<string, string>();
      for (const u of usr) {
        byId.set(String(u.id), String(u.nome || u.id));
        const code = String(u.code || '');
        if (code) { codeToId.set(code, String(u.id)); codeToId.set('omie-vendor-' + code, String(u.id)); }
      }
      const canon = (sid: any) => { const k = String(sid || ''); if (byId.has(k)) return k; return codeToId.get(k) || k; };
      const nameOf = (k: string) => byId.get(k) || (k ? k : 'Sem vendedor');

      const chkSet = new Set(chk.map((r: any) => String(r.cid)));
      const sellers = new Map<string, any>();
      const S = (sidRaw: any) => {
        const k = canon(sidRaw);
        if (!sellers.has(k)) sellers.set(k, { sellerId: k, sellerName: nameOf(k), planejados: 0, checkins: 0, vendas: 0, valorVendas: 0, naoVendas: 0, pendentes: [] as any[], naoVendasLista: [] as any[], vendaClientes: new Set<string>() });
        return sellers.get(k);
      };
      for (const v of ven) {
        const s = S(v.sid);
        s.vendas++; s.valorVendas += Number(v.valor) || 0;
        if (v.cid) s.vendaClientes.add(String(v.cid));
        if (s.sellerName === s.sellerId && v.snome) s.sellerName = String(v.snome);
      }
      for (const n of nos) { const s = S(n.sid); s.naoVendas++; s.naoVendasLista.push({ customerId: String(n.cid || ''), nome: n.nome, motivo: n.motivo }); }
      for (const p of plan) {
        const s = S(p.sid);
        s.planejados++;
        const cid = String(p.cid);
        const visitado = chkSet.has(cid);
        if (visitado) s.checkins++;
        if (!visitado && !s.vendaClientes.has(cid)) s.pendentes.push({ customerId: cid, nome: p.nome, cidade: p.cidade });
      }
      const out = Array.from(sellers.values()).map((s: any) => {
        const atendidos = s.planejados - s.pendentes.length;
        return {
          sellerId: s.sellerId, sellerName: s.sellerName,
          planejados: s.planejados, checkins: s.checkins, atendidos,
          vendas: s.vendas, valorVendas: Math.round(s.valorVendas * 100) / 100,
          naoVendas: s.naoVendas,
          cobertura: s.planejados > 0 ? Math.round((atendidos / s.planejados) * 100) : null,
          pendentes: s.pendentes, naoVendasLista: s.naoVendasLista
        };
      }).sort((a: any, b: any) => (b.planejados - a.planejados) || (b.vendas - a.vendas));
      const tot = out.reduce((a: any, s: any) => { a.planejados += s.planejados; a.checkins += s.checkins; a.atendidos += s.atendidos; a.vendas += s.vendas; a.valorVendas += s.valorVendas; a.naoVendas += s.naoVendas; return a; }, { planejados: 0, checkins: 0, atendidos: 0, vendas: 0, valorVendas: 0, naoVendas: 0 });
      res.json({ ok: true, date: d, totais: { ...tot, valorVendas: Math.round(tot.valorVendas * 100) / 100, cobertura: tot.planejados > 0 ? Math.round((tot.atendidos / tot.planejados) * 100) : null }, sellers: out });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 1B (03/jul/2026): texto de fechamento de rota (PT) — reusa o endpoint execution
  app.get('/api/admin/routes/execution/summary-text', async (req: Request, res: Response) => {
    try {
      const raw = String(req.query.date || hojeBR());
      const d = raw.replace(/[^0-9-]/g, '');
      const port = process.env.PORT || '8080';
      const r = await fetch('http://127.0.0.1:' + port + '/api/admin/routes/execution?date=' + d);
      const j: any = await r.json();
      if (!j || !j.ok) return res.status(500).json({ error: 'execution falhou' });
      const br = (n: number) => (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const parts = d.split('-');
      let text = '*Fechamento de Rota — ' + parts[2] + '/' + parts[1] + '/' + parts[0] + '*\n';
      const t = j.totais || {};
      text += 'Cobertura: ' + (t.cobertura === null ? '—' : t.cobertura + '%') + ' (' + t.atendidos + '/' + t.planejados + ') · Check-ins: ' + t.checkins + ' · Vendas: ' + t.vendas + ' (R$ ' + br(t.valorVendas) + ') · Não-vendas: ' + t.naoVendas + '\n';
      for (const s of (j.sellers || [])) {
        if (!s.planejados && !s.vendas) continue;
        text += '\n' + s.sellerName + ': ' + s.atendidos + '/' + s.planejados + (s.cobertura === null ? '' : ' (' + s.cobertura + '%)') + ' · vendas ' + s.vendas + ' (R$ ' + br(s.valorVendas) + ')';
        const pend = (s.pendentes || []);
        if (pend.length) {
          const nomes = pend.slice(0, 8).map((p: any) => p.nome).join(', ');
          text += '\n  ⚠️ Faltou visitar (' + pend.length + '): ' + nomes + (pend.length > 8 ? ' +' + (pend.length - 8) : '');
        }
      }
      try { const _pT = process.env.PORT || '8080'; const _trT = await fetch('http://127.0.0.1:' + _pT + '/api/admin/vendas-telemarketing?date=' + d); const _tk: any = await _trT.json(); if (_tk && _tk.ok && _tk.text) text += _tk.text; } catch (_e) {}
      text += '\n📋 Vendedores: justifiquem as visitas nao realizadas em Justificar Visitas.';
      res.json({ ok: true, date: d, text });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 1B: envia texto ao WhatsApp do GESTOR via Umbler Talk (nunca a cliente)
  app.post('/api/admin/notify/gestor', async (req: Request, res: Response) => {
    try {
      const text = String((req.body && req.body.text) || '').slice(0, 3500);
      if (!text) return res.status(400).json({ error: 'text obrigatorio' });
      const token = process.env.UMBLER_TALK_TOKEN || '';
      const from = process.env.UMBLER_TALK_FROM_PHONE || '5562992682630';
      if (!token) return res.status(400).json({ error: 'UMBLER_TALK_TOKEN ausente' });
      let tos: string[] = ['5562995782812'];
      try {
        const rs: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'gestor_whatsapp' LIMIT 1"));
        const rows = (rs.rows || rs) as any[];
        if (rows.length && rows[0].value) {
          const list = String(rows[0].value).split(',').map((x: string) => x.replace(/[^0-9]/g, '')).filter((x: string) => x.length >= 10);
          if (list.length) tos = list;
        }
      } catch (e) {}
      const g: any = global as any;
      if (!g.__umblerOrgId) {
        const mr = await fetch('https://app-utalk.umbler.com/api/v1/members/me/', { headers: { Authorization: 'Bearer ' + token } });
        const mj: any = await mr.json().catch(() => null);
        g.__umblerOrgId = mj && mj.organizations && mj.organizations[0] ? mj.organizations[0].id : null;
      }
      if (!g.__umblerOrgId) return res.status(500).json({ error: 'organizationId nao resolvido' });
      // Umbler simplified limita ~2000 chars — divide em partes (quebra em linha) e envia em sequencia
      const chunks: string[] = [];
      let rest = text;
      while (rest.length > 0) {
        if (rest.length <= 1800) { chunks.push(rest); break; }
        let cut = rest.lastIndexOf('\n', 1800);
        if (cut < 400) cut = 1800;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, '');
      }
      const results: any[] = [];
      for (const to of tos) {
        for (const part of chunks) {
          const sr = await fetch('https://app-utalk.umbler.com/api/v1/messages/simplified/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ fromPhone: from, toPhone: to, organizationId: g.__umblerOrgId, message: part })
          });
          const sj: any = await sr.json().catch(() => ({}));
          results.push({ to, ok: sr.ok, status: sr.status, messageId: sj && sj.id ? sj.id : null });
          await new Promise((rs2) => setTimeout(rs2, 800));
        }
      }
      res.json({ ok: results.length > 0 && results.every((x: any) => x.ok), parts: chunks.length, recipients: tos, results });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 1C (03/jul/2026): resumo executivo (texto PT) p/ WhatsApp do gestor — 7h/19h
  app.get('/api/admin/exec-summary-text', async (req: Request, res: Response) => {
    try {
      const port = process.env.PORT || '8080';
      const base = 'http://127.0.0.1:' + port;
      const d = String(req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())).replace(/[^0-9-]/g, '');
      const jget = async (p: string) => { try { const r = await fetch(base + p); return await r.json(); } catch (e) { return null; } };
      const d2: any = await jget('/api/dashboard2/full');
      const fin: any = await jget('/api/admin/financial/dashboard');
      const exq: any = await jget('/api/admin/routes/execution?date=' + d);
      const churn: any = await jget('/api/admin/churn/radar?snapshot=1');
      const br = (n: any) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const parts = d.split('-');
      const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date());
      let text = '*Resumo Executivo — ' + parts[2] + '/' + parts[1] + '/' + parts[0] + ' ' + hora + '*\n';
      if (d2 && d2.stats) {
        text += '\n💰 Vendas hoje: R$ ' + br(d2.stats.todaySales) + ' (ontem R$ ' + br(d2.stats.yesterdaySales) + ' · mês R$ ' + br(d2.stats.monthSales) + ')';
      }
      if (d2 && d2.ordersOverview) {
        const ov: any = d2.ordersOverview;
        const cnt = (a: any) => Array.isArray(a) ? a.length : 0;
        text += '\n📦 Pedidos: bloqueados ' + cnt(ov.blocked) + ' · a faturar ' + cnt(ov.aFaturar || ov.unbilled) + ' · NFs hoje ' + cnt(ov.nfsHoje || ov.todayInvoices);
      }
      if (exq && exq.ok && exq.totais) {
        const t: any = exq.totais;
        text += '\n🗺️ Rota: cobertura ' + (t.cobertura === null ? '—' : t.cobertura + '%') + ' (' + t.atendidos + '/' + t.planejados + ') · check-ins ' + t.checkins + ' · vendas ' + t.vendas + ' (R$ ' + br(t.valorVendas) + ') · não-vendas ' + t.naoVendas;
        const fracos = (exq.sellers || []).filter((s: any) => s.planejados > 0 && s.cobertura !== null && s.cobertura < 60);
        if (fracos.length) text += '\n  ⚠️ Cobertura <60%: ' + fracos.slice(0, 10).map((s: any) => s.sellerName + ' (' + s.cobertura + '%)').join(', ');
      }
      if (fin && fin.kpis) {
        const k: any = fin.kpis;
        text += '\n💳 Receber: hoje ' + (k.receberHojeN || 0) + ' (R$ ' + br(k.receberHoje) + ') · vencidas ' + (k.receberVencidoN || 0) + ' (R$ ' + br(k.receberVencido) + ')';
        text += '\n💸 Pagar: hoje ' + (k.pagarHojeN || 0) + ' (R$ ' + br(k.pagarHoje) + ') · vencidas ' + (k.pagarVencidoN || 0) + ' (R$ ' + br(k.pagarVencido) + ')';
      }
      if (churn && churn.ok && churn.resumo) {
        const cr: any = churn.resumo;
        text += '\n🔻 Churn: em risco ' + cr.em_risco + ' · perdido ' + cr.perdido + ' · R$ ' + br(cr.valorEmRisco) + ' em risco';
        const nv: any[] = (churn.transicoes && churn.transicoes.novosEmRisco) || [];
        if (nv.length) {
          text += '\n  ⚠️ Entraram em risco hoje (' + nv.length + '): ' + nv.slice(0, 10).map((n: any) => n.nome + ' (' + n.sellerName + ', R$ ' + br(n.valorHistorico) + ')').join('; ') + (nv.length > 10 ? ' +' + (nv.length - 10) : '');
        }
      }
      try { const _tk: any = await jget('/api/admin/vendas-telemarketing?date=' + d); if (_tk && _tk.ok && _tk.text) text += _tk.text; } catch (_e) {}
      try { const _sla: any = await db.execute(sql.raw("SELECT l.fantasy_name AS nome, TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS vendedor FROM leads l LEFT JOIN users u ON (u.id = l.assigned_to OR u.omie_vendor_code = l.assigned_to OR ('omie-vendor-' || u.omie_vendor_code) = l.assigned_to) WHERE l.status = 'pending' AND l.created_at < (now() - interval '24 hours') ORDER BY l.created_at ASC")); const _rows: any[] = (_sla && _sla.rows) || []; if (_rows.length) { text += '\n🔔 Leads sem 1º contato >24h (' + _rows.length + '): ' + _rows.slice(0, 8).map((r: any) => (r.nome || '?') + (r.vendedor && r.vendedor.trim() ? ' (' + r.vendedor.trim() + ')' : '')).join('; ') + (_rows.length > 8 ? ' +' + (_rows.length - 8) : ''); } } catch (_e) {}
      res.json({ ok: true, date: d, text });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  app.get('/api/admin/analise-semanal-ia', async (req: Request, res: Response) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY ausente' });
      const port = process.env.PORT || '8080';
      const base = 'http://127.0.0.1:' + port;
      const jget = async (p: string) => { try { const r = await fetch(base + p); return await r.json(); } catch (e) { return null; } };
      const churn: any = await jget('/api/admin/churn/radar');
      const cov: any = await jget('/api/admin/routes/coverage-weekly?days=7');
      const br = (n: any) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const byUser: any = (cov && cov.byUser) || {};
      const covFor = (sid: any) => { const k = String(sid || ''); return byUser[k] || byUser[k.replace('omie-vendor-', '')] || byUser['omie-vendor-' + k.replace('omie-vendor-', '')]; };
      let dados = '';
      if (churn && churn.resumo) { const r: any = churn.resumo; dados += 'RESUMO GERAL: em dia ' + r.em_dia + ', esfriando ' + r.esfriando + ', em risco ' + r.em_risco + ', perdido ' + r.perdido + ', sem historico ' + r.sem_historico + '; R$ ' + br(r.valorEmRisco) + ' em risco.\n\nPOR VENDEDOR:\n'; }
      const pv: any[] = (churn && churn.por_vendedor) || [];
      for (const s of pv) { const c: any = covFor(s.sellerId); const covTxt = c ? ('cobertura rota ' + c.cobertura + '% (' + c.atendidos + '/' + c.planejados + ')') : 'cobertura n/d'; dados += '- ' + s.sellerName + ': em risco ' + s.em_risco + ' (R$ ' + br(s.valorEmRisco) + '), perdido ' + s.perdido + ', esfriando ' + s.esfriando + ', em dia ' + s.em_dia + '; ' + covTxt + '.\n'; }
      const system = 'Voce e analista comercial da Honest Sucos (distribuidora de sucos em Goiania). Escreva uma ANALISE SEMANAL objetiva e acionavel para o gestor, a partir dos indicadores por vendedor. Comece com 1-2 linhas de panorama geral. Depois, por vendedor, destaque risco de churn (clientes em risco/perdidos e R$ em risco) e cobertura de rota (baixa cobertura = atencao), com 1 recomendacao pratica. Maximo cerca de 2 linhas por vendedor. Portugues do Brasil, tom profissional e direto. Use somente os dados fornecidos, nao invente numeros.';
      const userMsg = 'Dados da semana:\n\n' + dados + '\nEscreva a analise semanal.';
      const abody: any = { model: 'claude-sonnet-4-6', max_tokens: 1500, system, messages: [{ role: 'user', content: userMsg }] };
      const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(abody) });
      const aj: any = await resp.json().catch(() => ({}));
      if (!resp.ok) return res.status(502).json({ ok: false, error: 'Anthropic ' + resp.status, detail: JSON.stringify(aj).slice(0, 300) });
      const textOut = (aj.content && aj.content[0] && aj.content[0].text) || '';
      const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      res.json({ ok: true, model: abody.model, text: '*Analise Semanal — Honest Sucos (' + hoje + ')*\n\n' + textOut });
    } catch (e: any) { res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  app.get('/api/admin/analise-semanal-ia/enviar', async (req: Request, res: Response) => {
    res.json({ ok: true, started: true });
    (async () => {
      try {
        const port = process.env.PORT || '8080';
        const base = 'http://127.0.0.1:' + port;
        const r = await fetch(base + '/api/admin/analise-semanal-ia');
        const j: any = await r.json().catch(() => null);
        if (j && j.ok && j.text) { await fetch(base + '/api/admin/notify/gestor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: j.text }) }); }
      } catch (e) { console.error('analise-semanal-ia/enviar:', e); }
    })();
  });

  app.post('/api/admin/referral/coupon-active', async (req: Request, res: Response) => {
    try {
      const code = String((req.body && req.body.code) || '').trim();
      const active = (req.body && req.body.active) === undefined ? false : !!req.body.active;
      if (!code) return res.status(400).json({ ok: false, error: 'Informe o code do cupom.' });
      const r: any = await db.execute(sql`UPDATE referral_coupons SET active = ${active}, updated_at = now() WHERE upper(code) = upper(${code}) RETURNING id, code, active, used_count`);
      if (!r.rows || !r.rows.length) return res.status(404).json({ ok: false, error: 'Cupom nao encontrado: ' + code });
      res.json({ ok: true, coupon: r.rows[0] });
    } catch (e: any) { res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }); }
  });

  app.get('/api/admin/vendas-telemarketing', async (req: Request, res: Response) => {
  try {
    const d = String(req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())).replace(/[^0-9-]/g, '');
    const br = (n: any) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const JTL = "JOIN users u ON (u.seller_type = 'telemarketing' AND (bp.seller_id = u.id OR bp.seller_id = u.omie_vendor_code OR bp.seller_id = ('omie-vendor-' || u.omie_vendor_code)))";
    const vendasR: any = await db.execute(sql.raw("SELECT COALESCE(NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),''), bp.seller_name, bp.seller_id) AS nome, COUNT(*)::int AS qtd, COALESCE(SUM(bp.sale_value),0)::float AS valor FROM billing_pipeline bp " + JTL + " WHERE bp.sale_value > 0 AND (bp.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = '" + d + "'::date GROUP BY 1 ORDER BY valor DESC"));
    const vendas = (vendasR.rows || vendasR) as any[];
    const atendR: any = await db.execute(sql.raw("SELECT attendant_name AS nome, COUNT(*)::int AS qtd FROM virtual_service_logs WHERE service_type = 'venda' AND (attendance_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = '" + d + "'::date GROUP BY 1 ORDER BY qtd DESC"));
    const atend = (atendR.rows || atendR) as any[];
    const diagR: any = await db.execute(sql.raw("SELECT (SELECT COUNT(*) FROM users WHERE seller_type = 'telemarketing') AS tlmk_users, (SELECT COUNT(*) FROM billing_pipeline bp " + JTL + " WHERE bp.sale_value > 0) AS pipe_tlmk_all, (SELECT COUNT(*) FROM sales_cards WHERE telemarketing_assigned_to IS NOT NULL) AS cards_tlmk, (SELECT COUNT(*) FROM virtual_service_logs WHERE service_type = 'venda') AS venda_logs"));
    const diag = ((diagR.rows || diagR) as any[])[0] || {};
    const vTot = vendas.reduce((a: number, c: any) => a + (Number(c.qtd) || 0), 0);
    const vVal = vendas.reduce((a: number, c: any) => a + (Number(c.valor) || 0), 0);
    const aTot = atend.reduce((a: number, c: any) => a + (Number(c.qtd) || 0), 0);
    let text = '';
    if (vTot > 0 || aTot > 0) {
      text += '\n📞 Telemarketing (hoje): vendas ' + vTot + ' (R$ ' + br(vVal) + ') · atendimentos venda ' + aTot;
      if (vendas.length) text += '\n  • ' + vendas.slice(0, 10).map((c: any) => c.nome + ': ' + c.qtd + ' (R$ ' + br(c.valor) + ')').join(' · ');
      if (atend.length) text += '\n  • atend.: ' + atend.slice(0, 10).map((a: any) => a.nome + ' ' + a.qtd).join(' · ');
    }
    res.json({ ok: true, date: d, vendas, atendimentos: atend, diag, text });
  } catch (e: any) {
    res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
});

// VIGIA 3E: Programa de indicacao (cupom) — FUNDACAO (nao altera valor de pedido)
app.post('/api/admin/referral/setup', async (req: Request, res: Response) => {
  try {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS referral_coupons (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar UNIQUE NOT NULL, code varchar UNIQUE NOT NULL, discount_new_pct int NOT NULL DEFAULT 15, discount_referrer_pct int NOT NULL DEFAULT 10, max_referrals int NOT NULL DEFAULT 5, used_count int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())"));
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS referral_redemptions (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), code varchar NOT NULL, referrer_customer_id varchar, referred_customer_id varchar, referred_document varchar, channel varchar NOT NULL DEFAULT 'hotsite', order_ref varchar, order_value numeric(10,2), discount_new_amount numeric(10,2), reward_referrer_pct int DEFAULT 10, reward_referrer_amount numeric(10,2), reward_referrer_status varchar DEFAULT 'pending', status varchar NOT NULL DEFAULT 'pending', notes text, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())"));
    await db.execute(sql.raw("ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS reward_consumed_at timestamp"));
    await db.execute(sql.raw("ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS reward_order_ref varchar"));
    await db.execute(sql.raw("CREATE INDEX IF NOT EXISTS idx_ref_red_code ON referral_redemptions(code)"));
    await db.execute(sql.raw("CREATE INDEX IF NOT EXISTS idx_ref_red_referred ON referral_redemptions(referred_customer_id)"));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/referral/code', async (req: Request, res: Response) => {
  try {
    const customerId = String((req.body && req.body.customerId) || req.query.customerId || '').trim();
    if (!customerId) return res.status(400).json({ error: 'customerId obrigatorio' });
    const cid = customerId.replace(/'/g, "''");
    const ex: any = await db.execute(sql.raw("SELECT * FROM referral_coupons WHERE customer_id = '" + cid + "' LIMIT 1"));
    let row = ((ex.rows || ex) as any[])[0];
    if (!row) {
      let code = ''; let tries = 0;
      while (tries < 8) {
        const cand = 'IND' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const chk: any = await db.execute(sql.raw("SELECT 1 FROM referral_coupons WHERE code = '" + cand + "' LIMIT 1"));
        if (((chk.rows || chk) as any[]).length === 0) { code = cand; break; }
        tries++;
      }
      if (!code) code = 'IND' + Date.now().toString(36).toUpperCase();
      const ins: any = await db.execute(sql.raw("INSERT INTO referral_coupons (customer_id, code) VALUES ('" + cid + "', '" + code + "') ON CONFLICT (customer_id) DO UPDATE SET updated_at = now() RETURNING *"));
      row = ((ins.rows || ins) as any[])[0];
    }
    res.json({ ok: true, code: row.code, discountNewPct: row.discount_new_pct, discountReferrerPct: row.discount_referrer_pct, maxReferrals: row.max_referrals, usedCount: row.used_count, active: row.active });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.get('/api/referral/validate', async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const referredId = String(req.query.referredCustomerId || '').trim().replace(/'/g, "''");
    const referredDoc = String(req.query.referredDocument || '').replace(/[^0-9]/g, '');
    if (!code) return res.json({ valid: false, reason: 'sem_codigo' });
    const cr: any = await db.execute(sql.raw("SELECT * FROM referral_coupons WHERE code = '" + code + "' LIMIT 1"));
    const coupon = ((cr.rows || cr) as any[])[0];
    if (!coupon) return res.json({ valid: false, reason: 'inexistente' });
    if (!coupon.active) return res.json({ valid: false, reason: 'inativo' });
    if (Number(coupon.used_count) >= Number(coupon.max_referrals)) return res.json({ valid: false, reason: 'teto_atingido' });
    if (referredId && referredId === coupon.customer_id) return res.json({ valid: false, reason: 'auto_indicacao' });
    let dupWhere = '';
    if (referredId) dupWhere = "referred_customer_id = '" + referredId + "'";
    if (referredDoc) dupWhere = (dupWhere ? dupWhere + ' OR ' : '') + "referred_document = '" + referredDoc + "'";
    if (dupWhere) {
      const dr: any = await db.execute(sql.raw("SELECT 1 FROM referral_redemptions WHERE status <> 'cancelled' AND (" + dupWhere + ") LIMIT 1"));
      if (((dr.rows || dr) as any[]).length > 0) return res.json({ valid: false, reason: 'ja_usou' });
    }
    res.json({ valid: true, discountPct: coupon.discount_new_pct, referrerCustomerId: coupon.customer_id, code: coupon.code });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/referral/redeem', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return res.status(400).json({ error: 'code obrigatorio' });
    const cr: any = await db.execute(sql.raw("SELECT * FROM referral_coupons WHERE code = '" + code + "' LIMIT 1"));
    const coupon = ((cr.rows || cr) as any[])[0];
    if (!coupon) return res.status(404).json({ error: 'codigo inexistente' });
    const referredId = String(b.referredCustomerId || '').replace(/'/g, "''");
    const referredDoc = String(b.referredDocument || '').replace(/[^0-9]/g, '');
    const channel = (String(b.channel || 'hotsite').replace(/[^a-z]/g, '')) || 'hotsite';
    const orderRef = String(b.orderRef || '').replace(/'/g, "''");
    const orderValue = Number(b.orderValue) || 0;
    const discNew = Math.round(orderValue * (Number(coupon.discount_new_pct) / 100) * 100) / 100;
    const ins: any = await db.execute(sql.raw("INSERT INTO referral_redemptions (code, referrer_customer_id, referred_customer_id, referred_document, channel, order_ref, order_value, discount_new_amount, reward_referrer_pct) VALUES ('" + code + "', '" + coupon.customer_id + "', " + (referredId ? "'" + referredId + "'" : 'NULL') + ", " + (referredDoc ? "'" + referredDoc + "'" : 'NULL') + ", '" + channel + "', " + (orderRef ? "'" + orderRef + "'" : 'NULL') + ", " + orderValue + ", " + discNew + ", " + Number(coupon.discount_referrer_pct) + ") RETURNING id"));
    const idr = ((ins.rows || ins) as any[])[0];
    res.json({ ok: true, redemptionId: idr && idr.id, discountNewPct: coupon.discount_new_pct, discountNewAmount: discNew, referrerCustomerId: coupon.customer_id });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/admin/referral/confirm', async (req: Request, res: Response) => {
  try {
    const id = String((req.body && req.body.redemptionId) || '').replace(/'/g, "''");
    if (!id) return res.status(400).json({ error: 'redemptionId obrigatorio' });
    const rq: any = await db.execute(sql.raw("SELECT * FROM referral_redemptions WHERE id = '" + id + "' LIMIT 1"));
    const red = ((rq.rows || rq) as any[])[0];
    if (!red) return res.status(404).json({ error: 'inexistente' });
    if (red.status === 'confirmed') return res.json({ ok: true, already: true });
    await db.execute(sql.raw("UPDATE referral_redemptions SET status = 'confirmed', reward_referrer_status = 'released', updated_at = now() WHERE id = '" + id + "'"));
    await db.execute(sql.raw("UPDATE referral_coupons SET used_count = used_count + 1, updated_at = now() WHERE code = '" + String(red.code).replace(/'/g, "''") + "'"));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.get('/api/admin/referral/list', async (req: Request, res: Response) => {
  try {
    const co: any = await db.execute(sql.raw("SELECT c.*, (SELECT name FROM customers WHERE id = c.customer_id) AS customer_name FROM referral_coupons c ORDER BY c.used_count DESC, c.created_at DESC LIMIT 500"));
    const rd: any = await db.execute(sql.raw("SELECT * FROM referral_redemptions ORDER BY created_at DESC LIMIT 500"));
    const coupons = (co.rows || co) as any[];
    const redemptions = (rd.rows || rd) as any[];
    const resumo = { coupons: coupons.length, redemptions: redemptions.length, confirmadas: redemptions.filter((r: any) => r.status === 'confirmed').length, pendentes: redemptions.filter((r: any) => r.status === 'pending').length };
    res.json({ ok: true, resumo, coupons, redemptions });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// VIGIA 3E-checkout: status/consumo da recompensa 10% do indicador
app.get('/api/referral/reward-status', async (req: Request, res: Response) => {
  try {
    const customerId = String(req.query.customerId || '').trim().replace(/'/g, "''");
    const doc = String(req.query.document || '').replace(/[^0-9]/g, '');
    let refId = customerId;
    if (!refId && doc) {
      const cq: any = await db.execute(sql.raw("SELECT id FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') = '" + doc + "' OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') = '" + doc + "' LIMIT 1"));
      const cr = ((cq.rows || cq) as any[])[0];
      if (cr) refId = String(cr.id).replace(/'/g, "''");
    }
    if (!refId) return res.json({ hasReward: false });
    const q: any = await db.execute(sql.raw("SELECT id, reward_referrer_pct FROM referral_redemptions WHERE referrer_customer_id = '" + refId + "' AND reward_referrer_status = 'released' AND status = 'confirmed' AND reward_consumed_at IS NULL ORDER BY created_at ASC LIMIT 1"));
    const row = ((q.rows || q) as any[])[0];
    if (!row) return res.json({ hasReward: false, referrerCustomerId: refId });
    res.json({ hasReward: true, pct: Number(row.reward_referrer_pct) || 10, redemptionId: row.id, referrerCustomerId: refId });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/referral/consume-reward', async (req: Request, res: Response) => {
  try {
    const id = String((req.body && req.body.redemptionId) || '').replace(/'/g, "''");
    const orderRef = String((req.body && req.body.orderRef) || '').replace(/'/g, "''");
    if (!id) return res.status(400).json({ error: 'redemptionId obrigatorio' });
    const q: any = await db.execute(sql.raw("SELECT * FROM referral_redemptions WHERE id = '" + id + "' LIMIT 1"));
    const row = ((q.rows || q) as any[])[0];
    if (!row) return res.status(404).json({ error: 'inexistente' });
    if (row.reward_consumed_at) return res.json({ ok: true, already: true });
    await db.execute(sql.raw("UPDATE referral_redemptions SET reward_consumed_at = now(), reward_order_ref = " + (orderRef ? "'" + orderRef + "'" : 'NULL') + ", updated_at = now() WHERE id = '" + id + "'"));
    res.json({ ok: true, pct: Number(row.reward_referrer_pct) || 10 });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// VIGIA CUPOM: cupons promocionais (tabela coupons) — gestao no 2.0 + validacao/aplicacao server-side.
// Regras por cupom: percentual OU valor fixo, vigencia, pedido minimo, teto de usos, 1x por cliente, canal.
// SEGURANCA: so vale cupom habilitado no 2.0 (enabled_2_0), o registro do resgate e pre-requisito do desconto,
// e o desconto e REAPLICADO ao reabrir o pedido (o front sempre envia o valor cheio).
const _cupEsc = (s: any) => String(s == null ? '' : s).replace(/'/g, "''");
const _cupCode = (s: any) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const _cupNum = (v: any) => {
  let s = String(v == null ? '' : v).trim().replace(/[^0-9.,-]/g, '');
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : 0;
};
const _cupIsPct = (t: any) => /perc|%/i.test(String(t || 'percent'));
const _cupTrue = (v: any) => v === true || v === 't' || v === 'true' || v === 1;
// Chamada interna (o hook do pedido chama por 127.0.0.1). Requisicao vinda de fora traz x-forwarded-for.
const _cupInternal = (req: Request) => {
  const ra = String((req.socket && (req.socket as any).remoteAddress) || '');
  const loopback = ra.indexOf('127.0.0.1') >= 0 || ra === '::1' || ra === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'];
};
// Vigencia em dia BRT: 'YYYY-MM-DD' -> inicio 00:00 BRT / fim 23:59:59 BRT (gravado em UTC, igual ao 1.0)
const _cupFrom = (d: any) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00-03:00').toISOString().replace('T', ' ').replace('Z', '') : null; };
const _cupUntil = (d: any) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T23:59:59-03:00').toISOString().replace('T', ' ').replace('Z', '') : null; };

async function _cupResolveCustomerByDoc(doc: string): Promise<string> {
  const d = String(doc || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  try {
    const q: any = await db.execute(sql.raw("SELECT id FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') = '" + d + "' OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') = '" + d + "' LIMIT 1"));
    const r = ((q.rows || q) as any[])[0];
    return r ? String(r.id) : '';
  } catch { return ''; }
}

// Garante estrutura (as tabelas vieram do 1.0 via create-missing-tables: sem DEFAULT no id e sem UNIQUE).
async function _cupEnsureSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }); }
  };
  await run('create_coupons', "CREATE TABLE IF NOT EXISTS coupons (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), code varchar NOT NULL, description text, discount_type varchar NOT NULL DEFAULT 'percent', discount_value numeric(10,2) NOT NULL DEFAULT 0, valid_from timestamp, valid_until timestamp, is_active boolean NOT NULL DEFAULT true, max_uses int, used_count int NOT NULL DEFAULT 0, min_order_value numeric(10,2), created_by_user_id varchar, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())");
  await run('create_redemptions', "CREATE TABLE IF NOT EXISTS coupon_redemptions (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), coupon_id varchar, coupon_code varchar, sales_card_id varchar, customer_id varchar, order_total_before numeric(10,2), discount_applied numeric(10,2), order_total_after numeric(10,2), redeemed_at timestamp DEFAULT now())");
  await run('col_once', "ALTER TABLE coupons ADD COLUMN IF NOT EXISTS once_per_customer boolean NOT NULL DEFAULT true");
  await run('col_channels', "ALTER TABLE coupons ADD COLUMN IF NOT EXISTS channels varchar NOT NULL DEFAULT 'todos'");
  await run('col_enabled', "ALTER TABLE coupons ADD COLUMN IF NOT EXISTS enabled_2_0 boolean NOT NULL DEFAULT false");
  await run('red_order_ref', "ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS order_ref varchar");
  await run('red_snap_type', "ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS discount_type varchar");
  await run('red_snap_value', "ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS discount_value numeric(10,2)");
  await run('red_cancelled', "ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS cancelled_at timestamp");
  await run('def_id_coupons', "ALTER TABLE coupons ALTER COLUMN id SET DEFAULT gen_random_uuid()");
  await run('def_id_redemptions', "ALTER TABLE coupon_redemptions ALTER COLUMN id SET DEFAULT gen_random_uuid()");
  await run('def_used', "ALTER TABLE coupons ALTER COLUMN used_count SET DEFAULT 0");
  await run('fix_used_null', "UPDATE coupons SET used_count = 0 WHERE used_count IS NULL");
  await run('def_redeemed_at', "ALTER TABLE coupon_redemptions ALTER COLUMN redeemed_at SET DEFAULT now()");
  await run('uidx_code', "CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_uidx ON coupons (upper(code))");
  await run('uidx_red', "CREATE UNIQUE INDEX IF NOT EXISTS coupon_red_order_uidx ON coupon_redemptions (upper(coupon_code), order_ref) WHERE order_ref IS NOT NULL AND cancelled_at IS NULL");
  await run('idx_red_code', "CREATE INDEX IF NOT EXISTS idx_coupon_red_code ON coupon_redemptions(coupon_code)");
  const ok = steps.every((s) => s.ok);
  if (!ok) console.warn('🎟️ [CUPOM] schema incompleto:', JSON.stringify(steps.filter((s) => !s.ok)));
  return { ok, steps };
}

let _cupSchemaOnce: Promise<any> | null = null;
const _cupSchemaReady = () => (_cupSchemaOnce || (_cupSchemaOnce = _cupEnsureSchema().catch(() => ({ ok: false, steps: [] }))));

app.post('/api/admin/coupons/setup', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req: Request, res: Response) => {
  try { const r = await _cupEnsureSchema(); res.json({ ok: true, schema: r }); }
  catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// Resgate ja existente para este pedido (base da reaplicacao quando a venda fechada e reeditada). Chamada interna.
app.get('/api/coupons/applied', async (req: Request, res: Response) => {
  try {
    if (!_cupInternal(req)) return res.status(403).json({ error: 'somente chamada interna' });
    await _cupSchemaReady();
    const salesCardId = _cupEsc(String(req.query.salesCardId || '').trim());
    if (!salesCardId) return res.json({ applied: false });
    const q: any = await db.execute(sql.raw("SELECT * FROM coupon_redemptions WHERE sales_card_id = '" + salesCardId + "' ORDER BY redeemed_at DESC LIMIT 10"));
    const r = ((q.rows || q) as any[]).filter((x: any) => !x.cancelled_at)[0];
    if (!r) return res.json({ applied: false });
    res.json({ applied: true, redemptionId: r.id, code: r.coupon_code, discountApplied: Number(r.discount_applied) || 0, orderTotalBefore: Number(r.order_total_before) || 0, redeemedAt: r.redeemed_at });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// Reaplicacao ao reeditar um pedido ja fechado: RECALCULA pela regra do cupom sobre o total atual
// (nao repete o valor antigo) e atualiza o resgate, mantendo o razao fiel ao pedido. Chamada interna.
app.post('/api/coupons/reapply', async (req: Request, res: Response) => {
  try {
    if (!_cupInternal(req)) return res.status(403).json({ error: 'somente chamada interna' });
    await _cupSchemaReady();
    const b = req.body || {};
    const salesCardId = _cupEsc(String(b.salesCardId || '').trim());
    const total = _cupNum(b.total);
    if (!salesCardId || !(total > 0)) return res.json({ applied: false });
    const q: any = await db.execute(sql.raw("SELECT * FROM coupon_redemptions WHERE sales_card_id = '" + salesCardId + "' ORDER BY redeemed_at DESC LIMIT 10"));
    const r = ((q.rows || q) as any[]).filter((x: any) => !x.cancelled_at)[0];
    if (!r) return res.json({ applied: false });
    // Regra congelada no momento da venda (snapshot). Sem snapshot (resgate antigo), preserva o valor concedido.
    let disc = 0;
    if (r.discount_value != null) {
      const isPct = _cupIsPct(r.discount_type);
      disc = isPct ? (total * (Number(r.discount_value) || 0) / 100) : (Number(r.discount_value) || 0);
    } else {
      disc = Number(r.discount_applied) || 0;
    }
    disc = Math.round(disc * 100) / 100;
    const maxDisc = Math.round((total - 0.01) * 100) / 100;
    if (disc > maxDisc) disc = maxDisc;
    if (!(disc > 0)) return res.json({ applied: false, reason: 'desconto_invalido_para_este_valor' });
    const after = Math.round((total - disc) * 100) / 100;
    await db.execute(sql.raw("UPDATE coupon_redemptions SET order_total_before = " + total + ", discount_applied = " + disc + ", order_total_after = " + after + " WHERE id = '" + _cupEsc(r.id) + "'"));
    res.json({ applied: true, code: r.coupon_code, discount: disc, totalAfter: after });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// Validacao (read-only, nao grava): usada pelos canais de venda antes de aplicar o desconto.
app.get('/api/coupons/validate', async (req: Request, res: Response) => {
  try {
    await _cupSchemaReady();
    const code = _cupCode(req.query.code);
    const total = _cupNum(req.query.total);
    const channel = String(req.query.channel || '').toLowerCase().replace(/[^a-z]/g, '');
    let customerId = _cupEsc(String(req.query.customerId || '').trim());
    const doc = String(req.query.document || '').replace(/[^0-9]/g, '');
    if (!code) return res.json({ valid: false, reason: 'sem_codigo' });
    if (!(total > 0)) return res.json({ valid: false, reason: 'sem_valor' });
    const q: any = await db.execute(sql.raw("SELECT *, (valid_from IS NULL OR valid_from <= (now() AT TIME ZONE 'UTC')) AS started, (valid_until IS NULL OR valid_until >= (now() AT TIME ZONE 'UTC')) AS not_expired FROM coupons WHERE upper(code) = '" + code + "' LIMIT 1"));
    const c = ((q.rows || q) as any[])[0];
    if (!c) return res.json({ valid: false, reason: 'inexistente' });
    // Cupom so vale depois de habilitado na tela do 2.0 (protege os codigos legados espelhados do 1.0)
    if (!_cupTrue(c.enabled_2_0)) return res.json({ valid: false, reason: 'nao_habilitado_no_2_0' });
    if (!_cupTrue(c.is_active)) return res.json({ valid: false, reason: 'inativo' });
    if (!c.started) return res.json({ valid: false, reason: 'nao_iniciado', validFrom: c.valid_from });
    if (!c.not_expired) return res.json({ valid: false, reason: 'expirado', validUntil: c.valid_until });
    if (c.max_uses != null && Number(c.used_count || 0) >= Number(c.max_uses)) return res.json({ valid: false, reason: 'esgotado', maxUses: Number(c.max_uses) });
    if (c.min_order_value != null && total < Number(c.min_order_value)) return res.json({ valid: false, reason: 'pedido_minimo', minOrderValue: Number(c.min_order_value) });
    if (c.channels && String(c.channels) !== 'todos' && channel && String(c.channels) !== channel) return res.json({ valid: false, reason: 'canal_nao_permitido', channels: c.channels });
    if (!customerId && doc) customerId = _cupEsc(await _cupResolveCustomerByDoc(doc));
    if (c.once_per_customer !== false && customerId) {
      const dr: any = await db.execute(sql.raw("SELECT * FROM coupon_redemptions WHERE upper(coupon_code) = '" + code + "' AND customer_id = '" + customerId + "' LIMIT 20"));
      if (((dr.rows || dr) as any[]).filter((x: any) => !x.cancelled_at).length > 0) return res.json({ valid: false, reason: 'ja_usado_por_este_cliente' });
    }
    const isPct = _cupIsPct(c.discount_type);
    let disc = isPct ? (total * (Number(c.discount_value) || 0) / 100) : (Number(c.discount_value) || 0);
    disc = Math.round(disc * 100) / 100;
    // Nunca zera o pedido (pedido zerado sairia do pipeline de faturamento)
    const maxDisc = Math.round((total - 0.01) * 100) / 100;
    if (disc > maxDisc) disc = maxDisc;
    if (!(disc > 0)) return res.json({ valid: false, reason: 'desconto_invalido_para_este_valor' });
    res.json({ valid: true, couponId: c.id, code: c.code, type: isPct ? 'percent' : 'fixed', value: Number(c.discount_value) || 0, discount: disc, totalAfter: Math.round((total - disc) * 100) / 100, description: c.description || null, customerId: customerId || null });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// Registro do uso (grava resgate + incrementa used_count). Idempotente por pedido. Somente chamada interna.
app.post('/api/coupons/redeem', async (req: Request, res: Response) => {
  try {
    if (!_cupInternal(req)) return res.status(403).json({ error: 'somente chamada interna' });
    await _cupSchemaReady();
    const b = req.body || {};
    const code = _cupCode(b.code);
    if (!code) return res.status(400).json({ error: 'code obrigatorio' });
    const disc = _cupNum(b.discountApplied);
    if (!(disc > 0)) return res.status(400).json({ error: 'discountApplied invalido' });
    const before = _cupNum(b.orderTotalBefore);
    if (!(before > 0) || disc > before) return res.status(400).json({ error: 'valores do pedido invalidos' });
    const cq: any = await db.execute(sql.raw("SELECT id, code, discount_type, discount_value FROM coupons WHERE upper(code) = '" + code + "' LIMIT 1"));
    const c = ((cq.rows || cq) as any[])[0];
    if (!c) return res.status(404).json({ error: 'codigo inexistente' });
    const salesCardId = _cupEsc(b.salesCardId);
    const customerId = _cupEsc(b.customerId);
    const orderRef = _cupEsc(String(b.orderRef || '').slice(0, 120));
    if (orderRef) {
      const ex: any = await db.execute(sql.raw("SELECT * FROM coupon_redemptions WHERE upper(coupon_code) = '" + code + "' AND order_ref = '" + orderRef + "' LIMIT 5"));
      const prev = ((ex.rows || ex) as any[]).filter((x: any) => !x.cancelled_at)[0];
      if (prev) return res.json({ ok: true, already: true, redemptionId: prev.id, discountApplied: Number(prev.discount_applied) || 0 });
    }
    const after = Math.round((before - disc) * 100) / 100;
    let row: any = null;
    try {
      const ins: any = await db.execute(sql.raw("INSERT INTO coupon_redemptions (id, coupon_id, coupon_code, sales_card_id, customer_id, order_ref, discount_type, discount_value, order_total_before, discount_applied, order_total_after, redeemed_at) VALUES (gen_random_uuid(), '" + _cupEsc(c.id) + "', '" + _cupEsc(c.code) + "', " + (salesCardId ? "'" + salesCardId + "'" : 'NULL') + ", " + (customerId ? "'" + customerId + "'" : 'NULL') + ", " + (orderRef ? "'" + orderRef + "'" : 'NULL') + ", '" + (_cupIsPct(c.discount_type) ? 'percent' : 'fixed') + "', " + (Number(c.discount_value) || 0) + ", " + before + ", " + disc + ", " + after + ", now()) RETURNING id"));
      row = ((ins.rows || ins) as any[])[0];
    } catch (eIns: any) {
      // corrida (duplo clique) barrada pelo indice unico -> trata como ja resgatado
      const ex2: any = await db.execute(sql.raw("SELECT * FROM coupon_redemptions WHERE upper(coupon_code) = '" + code + "' AND order_ref = '" + orderRef + "' LIMIT 5"));
      const prev2 = ((ex2.rows || ex2) as any[]).filter((x: any) => !x.cancelled_at)[0];
      if (prev2) return res.json({ ok: true, already: true, redemptionId: prev2.id });
      throw eIns;
    }
    if (!row || !row.id) return res.status(500).json({ error: 'resgate nao registrado' });
    await db.execute(sql.raw("UPDATE coupons SET used_count = COALESCE(used_count, 0) + 1, updated_at = now() WHERE id = '" + _cupEsc(c.id) + "'"));
    console.log('🎟️ [CUPOM] resgate', c.code, 'pedido', salesCardId || '-', 'desconto', disc);
    res.json({ ok: true, redemptionId: row.id, code: c.code, discountApplied: disc, orderTotalAfter: after });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.get('/api/admin/coupons', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req: Request, res: Response) => {
  try {
    await _cupSchemaReady();
    const co: any = await db.execute(sql.raw("SELECT * FROM coupons ORDER BY is_active DESC, created_at DESC LIMIT 500"));
    const rd: any = await db.execute(sql.raw("SELECT r.*, (SELECT name FROM customers WHERE id = r.customer_id) AS customer_name FROM coupon_redemptions r WHERE r.cancelled_at IS NULL ORDER BY r.redeemed_at DESC LIMIT 300"));
    const coupons = (co.rows || co) as any[];
    const redemptions = (rd.rows || rd) as any[];
    const totalDesc = redemptions.reduce((s: number, r: any) => s + (Number(r.discount_applied) || 0), 0);
    const resumo = { coupons: coupons.length, ativos: coupons.filter((c: any) => _cupTrue(c.is_active) && _cupTrue(c.enabled_2_0)).length, usos: redemptions.length, descontoConcedido: Math.round(totalDesc * 100) / 100 };
    res.json({ ok: true, resumo, coupons, redemptions });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/admin/coupons', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const code = _cupCode(b.code);
    if (!code || code.length < 3) return res.status(400).json({ error: 'codigo invalido (min 3, apenas letras e numeros)' });
    const isPct = _cupIsPct(b.discountType);
    const value = _cupNum(b.discountValue);
    if (!(value > 0)) return res.status(400).json({ error: 'valor do desconto deve ser maior que zero' });
    if (isPct && value > 100) return res.status(400).json({ error: 'percentual nao pode passar de 100' });
    const from = _cupFrom(b.validFrom);
    const until = _cupUntil(b.validUntil);
    if (from && until && from > until) return res.status(400).json({ error: 'vigencia invalida (inicio depois do fim)' });
    const maxUsesRaw = b.maxUses === '' || b.maxUses == null ? null : Math.round(_cupNum(b.maxUses));
    if (maxUsesRaw != null && !(maxUsesRaw > 0)) return res.status(400).json({ error: 'maximo de usos invalido (deixe vazio para ilimitado)' });
    const minOrderRaw = b.minOrderValue === '' || b.minOrderValue == null ? null : _cupNum(b.minOrderValue);
    if (minOrderRaw != null && !(minOrderRaw >= 0)) return res.status(400).json({ error: 'pedido minimo invalido' });
    const desc = _cupEsc(String(b.description || '').slice(0, 300));
    const active = b.isActive === false ? 'false' : 'true';
    const once = b.oncePerCustomer === false ? 'false' : 'true';
    const channels = ['todos', 'hotsite', 'vendedor'].includes(String(b.channels || 'todos')) ? String(b.channels || 'todos') : 'todos';
    const by = _cupEsc(((req as any).currentUser && ((req as any).currentUser.email || (req as any).currentUser.id)) || 'admin');
    await _cupEnsureSchema();
    const cols = "description = " + (desc ? "'" + desc + "'" : 'NULL') + ", discount_type = '" + (isPct ? 'percent' : 'fixed') + "', discount_value = " + value + ", valid_from = " + (from ? "'" + from + "'" : 'NULL') + ", valid_until = " + (until ? "'" + until + "'" : 'NULL') + ", is_active = " + active + ", max_uses = " + (maxUsesRaw == null ? 'NULL' : maxUsesRaw) + ", min_order_value = " + (minOrderRaw == null ? 'NULL' : minOrderRaw) + ", once_per_customer = " + once + ", channels = '" + channels + "', enabled_2_0 = true, updated_at = now()";
    const ex: any = await db.execute(sql.raw("SELECT id FROM coupons WHERE upper(code) = '" + code + "' LIMIT 1"));
    const prev = ((ex.rows || ex) as any[])[0];
    let row: any = null;
    if (prev) {
      const up: any = await db.execute(sql.raw("UPDATE coupons SET " + cols + " WHERE id = '" + _cupEsc(prev.id) + "' RETURNING *"));
      row = ((up.rows || up) as any[])[0];
    } else {
      const ins: any = await db.execute(sql.raw("INSERT INTO coupons (id, code, used_count, created_by_user_id, created_at, " + "description, discount_type, discount_value, valid_from, valid_until, is_active, max_uses, min_order_value, once_per_customer, channels, enabled_2_0, updated_at) VALUES (gen_random_uuid(), '" + code + "', 0, '" + by + "', now(), " + (desc ? "'" + desc + "'" : 'NULL') + ", '" + (isPct ? 'percent' : 'fixed') + "', " + value + ", " + (from ? "'" + from + "'" : 'NULL') + ", " + (until ? "'" + until + "'" : 'NULL') + ", " + active + ", " + (maxUsesRaw == null ? 'NULL' : maxUsesRaw) + ", " + (minOrderRaw == null ? 'NULL' : minOrderRaw) + ", " + once + ", '" + channels + "', true, now()) RETURNING *"));
      row = ((ins.rows || ins) as any[])[0];
    }
    console.log('🎟️ [CUPOM] cadastro', code, isPct ? value + '%' : 'R$ ' + value, 'por', by);
    res.json({ ok: true, coupon: row });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/admin/coupons/estornar', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
  try {
    const id = _cupEsc(String((req.body && req.body.redemptionId) || '').trim());
    if (!id) return res.status(400).json({ error: 'redemptionId obrigatorio' });
    await _cupEnsureSchema();
    const q: any = await db.execute(sql.raw("SELECT id, coupon_id, coupon_code, cancelled_at FROM coupon_redemptions WHERE id = '" + id + "' LIMIT 1"));
    const r = ((q.rows || q) as any[])[0];
    if (!r) return res.status(404).json({ error: 'resgate inexistente' });
    if (r.cancelled_at) return res.json({ ok: true, already: true });
    await db.execute(sql.raw("UPDATE coupon_redemptions SET cancelled_at = now() WHERE id = '" + id + "'"));
    if (r.coupon_id) await db.execute(sql.raw("UPDATE coupons SET used_count = GREATEST(COALESCE(used_count, 0) - 1, 0), updated_at = now() WHERE id = '" + _cupEsc(r.coupon_id) + "'"));
    console.log('🎟️ [CUPOM] estorno do resgate', id, r.coupon_code);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

app.post('/api/admin/coupons/active', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
  try {
    const code = _cupCode(req.body && req.body.code);
    if (!code) return res.status(400).json({ error: 'code obrigatorio' });
    const active = (req.body && req.body.active) === false ? 'false' : 'true';
    await _cupEnsureSchema();
    const q: any = await db.execute(sql.raw("UPDATE coupons SET is_active = " + active + ", updated_at = now() WHERE upper(code) = '" + code + "' RETURNING code, is_active, used_count, enabled_2_0"));
    const row = ((q.rows || q) as any[])[0];
    if (!row) return res.status(404).json({ error: 'codigo inexistente' });
    res.json({ ok: true, coupon: row });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
});

// VIGIA 2D: config do limiar de distancia do check-in (anti-fraude)
app.get('/api/admin/checkin/max-dist', async (_req: Request, res: Response) => {
  try {
    const rs: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'checkin_max_dist' LIMIT 1"));
    const rows = (rs.rows || rs) as any[];
    res.json({ ok: true, maxDist: rows.length ? (Number(rows[0].value) || 300) : 300, isDefault: rows.length === 0 });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 200) }); }
});
app.post('/api/admin/checkin/max-dist', async (req: Request, res: Response) => {
  try {
    const n = Math.round(Number((req.body && req.body.maxDist)) || 0);
    if (!n || n < 10 || n > 100000) return res.status(400).json({ error: 'maxDist invalido (10..100000 metros)' });
    await db.execute(sql.raw("INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('checkin_max_dist', '" + n + "', 'vigia-config', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'vigia-config', updated_at = now()"));
    res.json({ ok: true, maxDist: n });
  } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 200) }); }
});
// VIGIA: configura numeros do gestor p/ notificacoes (CSV) em system_settings gestor_whatsapp
  app.get('/api/admin/notify/gestor-config', async (_req: Request, res: Response) => {
    try {
      const rs: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'gestor_whatsapp' LIMIT 1"));
      const rows = (rs.rows || rs) as any[];
      res.json({ ok: true, numbers: rows.length ? String(rows[0].value || '') : '', default: '5562995782812' });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 200) }); }
  });
  app.post('/api/admin/notify/gestor-config', async (req: Request, res: Response) => {
    try {
      const v = String((req.body && req.body.numbers) || '').replace(/[^0-9,]/g, '');
      if (!v) return res.status(400).json({ error: 'numbers obrigatorio (CSV de telefones)' });
      const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value = '" + v + "', updated_by = 'vigia-config', updated_at = now() WHERE key = 'gestor_whatsapp'"));
      const n = (upd && typeof upd.rowCount === 'number') ? upd.rowCount : (upd && upd.rows ? upd.rows.length : 0);
      if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key, value, updated_by) VALUES ('gestor_whatsapp', '" + v + "', 'vigia-config')"));
      res.json({ ok: true, numbers: v });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 200) }); }
  });

  // VIGIA 2A (03/jul/2026): Radar de Churn por cadencia — clientes ativos por faixa de risco.
  // faixa = ciclos perdidos (dias_sem_compra / intervalo da periodicidade). ?snapshot=1 grava churn_snapshots do dia.
  app.get('/api/admin/churn/radar', async (req: Request, res: Response) => {
    try {
      const doSnap = /^(1|true)$/i.test(String(req.query.snapshot || ''));
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS churn_snapshots (snapshot_date date NOT NULL, customer_id text NOT NULL, faixa text NOT NULL, seller_id text, valor_hist numeric, created_at timestamptz DEFAULT now(), PRIMARY KEY (snapshot_date, customer_id))"));

      const q = "WITH base AS (SELECT c.id AS customer_id, c.name AS nome, c.city AS cidade, COALESCE(c.visit_periodicity::text, 'semanal') AS periodicidade, c.seller_id AS seller_id, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS seller_name FROM customers c LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id = c.seller_id) WHERE c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE)), buys AS (SELECT customer_id, MAX(created_at) AS last_created, COALESCE(SUM(sale_value::numeric), 0) AS total_hist, COALESCE(SUM(sale_value::numeric) FILTER (WHERE created_at >= (now() - interval '6 months')), 0) AS total_6m, COUNT(*)::int AS n_pedidos FROM billing_pipeline WHERE customer_id IS NOT NULL GROUP BY customer_id) SELECT b.customer_id, b.nome, b.cidade, b.periodicidade, b.seller_id, b.seller_name, bu.last_created, COALESCE(bu.total_hist, 0) AS total_hist, COALESCE(bu.total_6m, 0) AS total_6m, COALESCE(bu.n_pedidos, 0) AS n_pedidos FROM base b LEFT JOIN buys bu ON bu.customer_id = b.customer_id";
      const r: any = await db.execute(sql.raw(q));
      const rowsRaw = (r.rows || r) as any[];
      // dedupe por cliente: o LEFT JOIN users pode casar >1 usuario (codigos repetidos) e duplicar a linha
      const _seen = new Set<string>();
      const rows = rowsRaw.filter((x: any) => { const k = String(x.customer_id); if (_seen.has(k)) return false; _seen.add(k); return true; });

      const interval: Record<string, number> = { semanal: 7, quinzenal: 14, mensal: 28, bimestral: 56 };
      const rank: Record<string, number> = { em_dia: 0, esfriando: 1, em_risco: 2, perdido: 3, sem_historico: 2 };
      const now = Date.now();

      const clientes = rows.map((x: any) => {
        const per = String(x.periodicidade || 'semanal');
        const intv = interval[per] || 7;
        let dias: number | null = null;
        let ciclos: number | null = null;
        let faixa = 'sem_historico';
        if (x.last_created) {
          dias = Math.floor((now - new Date(x.last_created).getTime()) / 86400000);
          ciclos = Math.round((dias / intv) * 100) / 100;
          if (ciclos < 1) faixa = 'em_dia';
          else if (ciclos < 2) faixa = 'esfriando';
          else if (ciclos < 3) faixa = 'em_risco';
          else faixa = 'perdido';
        }
        const skRaw = String(x.seller_id || '');
        const sName = x.seller_name || (skRaw ? skRaw : 'Sem vendedor');
        return {
          customerId: String(x.customer_id), nome: x.nome, cidade: x.cidade || '',
          sellerId: skRaw, sellerName: sName,
          periodicidade: per, intervalo: intv,
          ultimaCompra: x.last_created ? new Date(x.last_created).toISOString() : null,
          diasSemCompra: dias, ciclos,
          valorHistorico: Math.round(Number(x.total_hist || 0) * 100) / 100,
          valorHistorico6m: Math.round(Number(x.total_6m || 0) * 100) / 100,
          nPedidos: Number(x.n_pedidos || 0), faixa,
        };
      });

      const prev = new Map<string, string>();
      try {
        const pr: any = await db.execute(sql.raw("SELECT DISTINCT ON (customer_id) customer_id, faixa FROM churn_snapshots WHERE snapshot_date < '" + today + "' ORDER BY customer_id, snapshot_date DESC"));
        for (const p of ((pr.rows || pr) as any[])) prev.set(String(p.customer_id), String(p.faixa));
      } catch (e) {}
      const novosEmRisco: any[] = [];
      for (const c of clientes) {
        const before = prev.get(c.customerId);
        const piora = (c.faixa === 'em_risco' || c.faixa === 'perdido') && before !== undefined && rank[c.faixa] > (rank[before] ?? -1);
        if (piora) novosEmRisco.push({ customerId: c.customerId, nome: c.nome, sellerName: c.sellerName, faixa: c.faixa, faixaAnterior: before, valorHistorico: c.valorHistorico });
      }

      let snapshotGravado = false;
      let snapErr: string | null = null;
      if (doSnap && clientes.length) {
        try {
          for (let i = 0; i < clientes.length; i += 300) {
            const batch = clientes.slice(i, i + 300);
            const vals = batch.map((c) => sql`(${today}, ${c.customerId}, ${c.faixa}, ${c.sellerId || null}, ${c.valorHistorico})`);
            await db.execute(sql`INSERT INTO churn_snapshots (snapshot_date, customer_id, faixa, seller_id, valor_hist) VALUES ${sql.join(vals, sql`, `)} ON CONFLICT (snapshot_date, customer_id) DO UPDATE SET faixa = EXCLUDED.faixa, seller_id = EXCLUDED.seller_id, valor_hist = EXCLUDED.valor_hist`);
          }
          snapshotGravado = true;
        } catch (e: any) { snapErr = String(e && e.message ? e.message : e).slice(0, 220); }
      }

      const zero = () => ({ em_dia: 0, esfriando: 0, em_risco: 0, perdido: 0, sem_historico: 0 });
      const resumo: any = { total: clientes.length, ...zero(), valorEmRisco: 0 };
      const bySeller = new Map<string, any>();
      for (const c of clientes) {
        resumo[c.faixa]++;
        if (c.faixa === 'em_risco' || c.faixa === 'perdido') resumo.valorEmRisco += c.valorHistorico;
        const key = c.sellerName;
        if (!bySeller.has(key)) bySeller.set(key, { sellerId: c.sellerId, sellerName: c.sellerName, total: 0, ...zero(), valorEmRisco: 0 });
        const sv = bySeller.get(key);
        sv.total++; sv[c.faixa]++;
        if (c.faixa === 'em_risco' || c.faixa === 'perdido') sv.valorEmRisco += c.valorHistorico;
      }
      resumo.valorEmRisco = Math.round(resumo.valorEmRisco * 100) / 100;
      const por_vendedor = Array.from(bySeller.values()).map((s: any) => ({ ...s, valorEmRisco: Math.round(s.valorEmRisco * 100) / 100 })).sort((a: any, b: any) => (b.em_risco + b.perdido) - (a.em_risco + a.perdido) || b.total - a.total);

      res.json({ ok: true, date: today, snapshotGravado, snapErr, resumo, por_vendedor, transicoes: { count: novosEmRisco.length, novosEmRisco }, clientes });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 2D (03/jul/2026): Anti-fraude de check-in — check-ins com distancia ao cliente acima do limiar.
  // limiar (metros) em system_settings 'checkin_max_dist' (default 300); override ?maxDist=. Fonte: sales_cards.distance_to_customer.
  app.get('/api/admin/checkin/anti-fraude', async (req: Request, res: Response) => {
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const start = String(req.query.startDate || today).replace(/[^0-9-]/g, '');
      const end = String(req.query.endDate || start).replace(/[^0-9-]/g, '');
      let maxDist = Number(req.query.maxDist);
      if (!Number.isFinite(maxDist) || maxDist <= 0) {
        try {
          const cfg: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'checkin_max_dist' LIMIT 1"));
          const rows = (cfg.rows || cfg) as any[];
          const v = rows.length ? Number(String(rows[0].value).replace(/[^0-9.]/g, '')) : NaN;
          maxDist = Number.isFinite(v) && v > 0 ? v : 300;
        } catch (e) { maxDist = 300; }
      }
      const q = "SELECT sc.customer_id AS cid, MAX(c.name) AS nome, sc.seller_id AS sid, sc.check_in_time AS checkin, MAX(sc.distance_to_customer::numeric) AS dist, (SELECT NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') FROM users u WHERE u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = replace(COALESCE(sc.seller_id,''),'omie-vendor-','') OR u.id = sc.seller_id LIMIT 1) AS seller_name FROM sales_cards sc LEFT JOIN customers c ON c.id = sc.customer_id WHERE sc.check_in_time IS NOT NULL AND sc.distance_to_customer IS NOT NULL AND (sc.check_in_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= '" + start + "'::date AND (sc.check_in_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date <= '" + end + "'::date GROUP BY sc.customer_id, sc.seller_id, sc.check_in_time";
      const r: any = await db.execute(sql.raw(q));
      const rows = (r.rows || r) as any[];

      const sellers = new Map<string, any>();
      const ocorrencias: any[] = [];
      let flaggedTot = 0;
      for (const x of rows) {
        const sid = String(x.sid || '');
        const nome = x.seller_name || (sid || 'Sem vendedor');
        const dist = Number(x.dist) || 0;
        const flagged = dist > maxDist;
        if (!sellers.has(nome)) sellers.set(nome, { sellerId: sid, sellerName: nome, checkins: 0, flagged: 0, maxDist: 0 });
        const sv = sellers.get(nome);
        sv.checkins++;
        if (dist > sv.maxDist) sv.maxDist = Math.round(dist);
        if (flagged) {
          sv.flagged++; flaggedTot++;
          ocorrencias.push({ customerId: String(x.cid || ''), nome: x.nome || x.cid, sellerName: nome, checkInTime: x.checkin ? new Date(x.checkin).toISOString() : null, distancia: Math.round(dist) });
        }
      }
      const por_vendedor = Array.from(sellers.values()).sort((a: any, b: any) => (b.flagged - a.flagged) || (b.maxDist - a.maxDist));
      ocorrencias.sort((a: any, b: any) => b.distancia - a.distancia);
      res.json({ ok: true, startDate: start, endDate: end, maxDist, totais: { checkins: rows.length, flagged: flaggedTot }, por_vendedor, ocorrencias });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 2C (03/jul/2026): cobertura de rota agregada dos ultimos N dias por vendedor (user id). SO EXIBICAO — nao toca comissao.
  // planejado = SUM(daily_routes.total_visits); atendido = clientes-dia com venda (billing_pipeline). cobertura = atendido/planejado.
  app.get('/api/admin/routes/coverage-weekly', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(String(req.query.days || '7'), 10) || 7, 1), 90);
      const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const startD = new Date(end + 'T12:00:00Z'); startD.setUTCDate(startD.getUTCDate() - (days - 1));
      const start = startD.toISOString().split('T')[0];
      const planQ = "SELECT COALESCE((SELECT u.id FROM users u WHERE u.omie_vendor_code = dr.seller_id OR u.omie_vendor_code = replace(COALESCE(dr.seller_id,''),'omie-vendor-','') OR u.id = dr.seller_id LIMIT 1), dr.seller_id) AS uid, SUM(dr.total_visits)::int AS planejados FROM daily_routes dr WHERE (dr.route_date)::date >= '" + start + "'::date AND (dr.route_date)::date <= '" + end + "'::date GROUP BY 1";
      const atendQ = "SELECT uid, COUNT(*)::int AS atendidos FROM (SELECT DISTINCT COALESCE((SELECT u.id FROM users u WHERE u.omie_vendor_code = bp.seller_id OR u.omie_vendor_code = replace(COALESCE(bp.seller_id,''),'omie-vendor-','') OR u.id = bp.seller_id LIMIT 1), bp.seller_id) AS uid, bp.customer_id AS cid, (bp.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date AS d FROM billing_pipeline bp WHERE bp.customer_id IS NOT NULL AND (bp.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= '" + start + "'::date AND (bp.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date <= '" + end + "'::date) t GROUP BY uid";
      const pr: any = await db.execute(sql.raw(planQ));
      const ar: any = await db.execute(sql.raw(atendQ));
      const byUser: Record<string, any> = {};
      for (const r of ((pr.rows || pr) as any[])) { const k = String(r.uid || ''); if (!k) continue; byUser[k] = { planejados: Number(r.planejados) || 0, atendidos: 0, cobertura: null }; }
      for (const r of ((ar.rows || ar) as any[])) { const k = String(r.uid || ''); if (!k) continue; if (!byUser[k]) byUser[k] = { planejados: 0, atendidos: 0, cobertura: null }; byUser[k].atendidos = Number(r.atendidos) || 0; }
      for (const k of Object.keys(byUser)) { const v = byUser[k]; v.cobertura = v.planejados > 0 ? Math.min(100, Math.round((v.atendidos / v.planejados) * 100)) : null; }
      res.json({ ok: true, days, start, end, byUser });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 3A (03/jul/2026): FILA DE RESGATE (dry-run) — candidatos ao telemarketing por faixa de churn, priorizados por valor 6m.
  // READ-ONLY: apenas lista quem ENTRARIA na fila (com contexto de contato). Nao grava. A gravacao/tela do telemarketing entra apos OK do Flavio.
  app.get('/api/admin/churn/fila-resgate', async (req: Request, res: Response) => {
    try {
      const faixaParam = String(req.query.faixa || 'em_risco').toLowerCase();
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '300'), 10) || 300, 1), 2000);
      const q = "WITH base AS (SELECT c.id AS customer_id, c.name AS nome, c.city AS cidade, c.neighborhood AS bairro, c.phone AS telefone, c.contact AS contato, COALESCE(NULLIF(c.cnpj,''), NULLIF(c.cpf,'')) AS documento, COALESCE(c.visit_periodicity::text, 'semanal') AS periodicidade, c.seller_id AS seller_id, (SELECT NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') FROM users u WHERE u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id = c.seller_id LIMIT 1) AS seller_name FROM customers c WHERE c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE)), buys AS (SELECT customer_id, MAX(created_at) AS last_created, COALESCE(SUM(sale_value::numeric), 0) AS total_hist, COALESCE(SUM(sale_value::numeric) FILTER (WHERE created_at >= (now() - interval '6 months')), 0) AS total_6m FROM billing_pipeline WHERE customer_id IS NOT NULL GROUP BY customer_id) SELECT b.customer_id, b.nome, b.cidade, b.bairro, b.telefone, b.contato, b.documento, b.periodicidade, b.seller_id, b.seller_name, bu.last_created, COALESCE(bu.total_hist,0) AS total_hist, COALESCE(bu.total_6m,0) AS total_6m FROM base b LEFT JOIN buys bu ON bu.customer_id = b.customer_id";
      const r: any = await db.execute(sql.raw(q));
      const rowsRaw = (r.rows || r) as any[];
      const seen = new Set<string>();
      const rows = rowsRaw.filter((x: any) => { const k = String(x.customer_id); if (seen.has(k)) return false; seen.add(k); return true; });
      const interval: Record<string, number> = { semanal: 7, quinzenal: 14, mensal: 28, bimestral: 56 };
      const now = Date.now();
      const wantRisco = faixaParam === 'em_risco' || faixaParam === 'ambos';
      const wantPerdido = faixaParam === 'perdido' || faixaParam === 'ambos';
      const cand: any[] = [];
      for (const x of rows) {
        if (!x.last_created) continue;
        const intv = interval[String(x.periodicidade || 'semanal')] || 7;
        const dias = Math.floor((now - new Date(x.last_created).getTime()) / 86400000);
        const ciclos = dias / intv;
        let faixa = '';
        if (ciclos >= 2 && ciclos < 3) faixa = 'em_risco';
        else if (ciclos >= 3) faixa = 'perdido';
        else continue;
        if ((faixa === 'em_risco' && !wantRisco) || (faixa === 'perdido' && !wantPerdido)) continue;
        cand.push({
          customerId: String(x.customer_id), nome: x.nome, cidade: x.cidade || '', bairro: x.bairro || '',
          telefone: x.telefone || '', contato: x.contato || '', documento: x.documento || '',
          vendedor: x.seller_name || (x.seller_id || 'Sem vendedor'),
          faixa, diasSemCompra: dias,
          ultimaCompra: new Date(x.last_created).toISOString(),
          valorHistorico: Math.round(Number(x.total_hist || 0) * 100) / 100,
          valorHistorico6m: Math.round(Number(x.total_6m || 0) * 100) / 100,
        });
      }
      cand.sort((a, b) => b.valorHistorico6m - a.valorHistorico6m || b.valorHistorico - a.valorHistorico);
      const limited = cand.slice(0, limit);
      const porVendedor: Record<string, number> = {};
      for (const c of cand) porVendedor[c.vendedor] = (porVendedor[c.vendedor] || 0) + 1;
      res.json({ ok: true, dryRun: true, faixa: faixaParam, total: cand.length, mostrando: limited.length, valorTotal6m: Math.round(cand.reduce((s, c) => s + c.valorHistorico6m, 0) * 100) / 100, porVendedor, candidatos: limited });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 3A (grava) — cria/alimenta a fila de resgate (tabela PROPRIA churn_resgate_queue; NAO usa telemarketing_queue).
  async function ensureResgateTable() {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS churn_resgate_queue (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id text NOT NULL, customer_name text, cidade text, bairro text, telefone text, contato text, documento text, seller_name text, faixa text NOT NULL, dias_sem_compra int, ultima_compra timestamptz, valor_hist numeric, valor_6m numeric, status text NOT NULL DEFAULT 'pendente', outcome text, outcome_reason text, notes text, agent_id varchar, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), outcome_at timestamptz)"));
    await db.execute(sql.raw("CREATE INDEX IF NOT EXISTS idx_churn_resgate_status ON churn_resgate_queue (status)"));
  }

  app.post('/api/admin/churn/fila-resgate/apply', async (req: Request, res: Response) => {
    try {
      await ensureResgateTable();
      const faixa = String((req.body && req.body.faixa) || 'ambos').toLowerCase();
      const port = process.env.PORT || '8080';
      const j: any = await fetch('http://127.0.0.1:' + port + '/api/admin/churn/fila-resgate?faixa=' + encodeURIComponent(faixa) + '&limit=2000').then((r) => r.json());
      const cand: any[] = (j && j.candidatos) || [];
      const exq: any = await db.execute(sql.raw("SELECT customer_id, faixa FROM churn_resgate_queue WHERE status IN ('pendente','em_atendimento')"));
      const openSet = new Set(((exq.rows || exq) as any[]).map((r: any) => String(r.customer_id) + '|' + String(r.faixa)));
      const toInsert = cand.filter((c: any) => !openSet.has(String(c.customerId) + '|' + String(c.faixa)));
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += 200) {
        const batch = toInsert.slice(i, i + 200);
        const vals = batch.map((c: any) => sql`(${c.customerId}, ${c.nome || null}, ${c.cidade || null}, ${c.bairro || null}, ${c.telefone || null}, ${c.contato || null}, ${c.documento || null}, ${c.vendedor || null}, ${c.faixa}, ${c.diasSemCompra ?? null}, ${c.ultimaCompra || null}, ${c.valorHistorico ?? null}, ${c.valorHistorico6m ?? null})`);
        await db.execute(sql`INSERT INTO churn_resgate_queue (customer_id, customer_name, cidade, bairro, telefone, contato, documento, seller_name, faixa, dias_sem_compra, ultima_compra, valor_hist, valor_6m) VALUES ${sql.join(vals, sql`, `)}`);
        inserted += batch.length;
      }
      res.json({ ok: true, faixa, totalCandidatos: cand.length, jaEnfileirados: cand.length - toInsert.length, inseridos: inserted });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  app.get('/api/admin/churn/resgate-queue', async (req: Request, res: Response) => {
    try {
      await ensureResgateTable();
      const status = String(req.query.status || '').replace(/[^a-z_]/g, '');
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '500'), 10) || 500, 1), 3000);
      const where = status ? "WHERE status = '" + status + "'" : "";
      const q = "SELECT id, customer_id, customer_name, cidade, bairro, telefone, contato, documento, seller_name, faixa, dias_sem_compra, ultima_compra, valor_hist, valor_6m, status, outcome, outcome_reason, notes, created_at, outcome_at FROM churn_resgate_queue " + where + " ORDER BY (status = 'pendente') DESC, valor_6m DESC NULLS LAST LIMIT " + limit;
      const r: any = await db.execute(sql.raw(q));
      const rows = (r.rows || r) as any[];
      const cnt: any = await db.execute(sql.raw("SELECT status, COUNT(*)::int AS n FROM churn_resgate_queue GROUP BY status"));
      const resumo: Record<string, number> = {};
      for (const c of ((cnt.rows || cnt) as any[])) resumo[String(c.status)] = Number(c.n);
      res.json({ ok: true, resumo, total: rows.length, itens: rows });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  const RESGATE_MOTIVOS = ['preco', 'concorrente', 'fechou', 'entrega', 'sem_contato', 'voltou', 'outro'];
  app.post('/api/admin/churn/resgate-queue/:id/desfecho', async (req: Request, res: Response) => {
    try {
      await ensureResgateTable();
      const id = String(req.params.id || '').replace(/[^0-9a-fA-F-]/g, '');
      if (!id) return res.status(400).json({ error: 'id invalido' });
      const b = req.body || {};
      const status = ['pendente', 'em_atendimento', 'concluido'].includes(String(b.status)) ? String(b.status) : 'em_atendimento';
      const reason = b.outcome_reason && RESGATE_MOTIVOS.includes(String(b.outcome_reason)) ? String(b.outcome_reason) : null;
      const outcome = b.outcome != null ? String(b.outcome).slice(0, 300) : null;
      const notes = b.notes != null ? String(b.notes).slice(0, 1000) : null;
      const agent = b.agentId != null ? String(b.agentId).slice(0, 60) : null;
      const setOutcomeAt = status === 'concluido';
      await db.execute(sql`UPDATE churn_resgate_queue SET status = ${status}, outcome = COALESCE(${outcome}, outcome), outcome_reason = COALESCE(${reason}, outcome_reason), notes = COALESCE(${notes}, notes), agent_id = COALESCE(${agent}, agent_id), outcome_at = ${setOutcomeAt ? sql`now()` : sql`outcome_at`}, updated_at = now() WHERE id = ${id}`);
      res.json({ ok: true, id, status, outcome_reason: reason });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  app.get('/api/admin/churn/resgate-motivos', async (req: Request, res: Response) => {
    try {
      await ensureResgateTable();
      const now = new Date();
      const mes = Math.min(Math.max(parseInt(String(req.query.mes || (now.getUTCMonth() + 1)), 10) || (now.getUTCMonth() + 1), 1), 12);
      const ano = parseInt(String(req.query.ano || now.getUTCFullYear()), 10) || now.getUTCFullYear();
      const q = "SELECT outcome_reason, COUNT(*)::int AS n, COALESCE(SUM(valor_6m),0)::numeric AS valor FROM churn_resgate_queue WHERE status = 'concluido' AND outcome_reason IS NOT NULL AND EXTRACT(MONTH FROM outcome_at) = " + mes + " AND EXTRACT(YEAR FROM outcome_at) = " + ano + " GROUP BY outcome_reason ORDER BY n DESC";
      const r: any = await db.execute(sql.raw(q));
      const rows = ((r.rows || r) as any[]).map((x: any) => ({ motivo: x.outcome_reason, quantidade: Number(x.n), valor6m: Math.round(Number(x.valor || 0) * 100) / 100 }));
      res.json({ ok: true, mes, ano, motivos: rows });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 3C (03/jul/2026): REPESCAGEM turbinada (dry-run) — perdidos por valor historico que ainda NAO tem repescagem pendente.
  // READ-ONLY: apenas preview de quem entraria em repescagem_assignments. Nao grava. Regra de atribuicao (atendente) fica p/ o apply apos OK do Flavio.
  app.get('/api/admin/churn/repescagem-preview', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '500'), 10) || 500, 1), 3000);
      const q = "WITH base AS (SELECT c.id AS customer_id, c.name AS nome, c.city AS cidade, c.phone AS telefone, c.contact AS contato, COALESCE(NULLIF(c.cnpj,''), NULLIF(c.cpf,'')) AS documento, COALESCE(c.visit_periodicity::text, 'semanal') AS periodicidade, c.seller_id AS seller_id, (SELECT NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') FROM users u WHERE u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(COALESCE(c.seller_id,''),'omie-vendor-','') OR u.id = c.seller_id LIMIT 1) AS seller_name, EXISTS (SELECT 1 FROM repescagem_assignments ra WHERE ra.customer_id = c.id AND ra.status = 'pending') AS ja_pendente FROM customers c WHERE c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE)), buys AS (SELECT customer_id, MAX(created_at) AS last_created, COALESCE(SUM(sale_value::numeric), 0) AS total_hist, COALESCE(SUM(sale_value::numeric) FILTER (WHERE created_at >= (now() - interval '6 months')), 0) AS total_6m FROM billing_pipeline WHERE customer_id IS NOT NULL GROUP BY customer_id) SELECT b.customer_id, b.nome, b.cidade, b.telefone, b.contato, b.documento, b.periodicidade, b.seller_id, b.seller_name, b.ja_pendente, bu.last_created, COALESCE(bu.total_hist,0) AS total_hist, COALESCE(bu.total_6m,0) AS total_6m FROM base b LEFT JOIN buys bu ON bu.customer_id = b.customer_id";
      const r: any = await db.execute(sql.raw(q));
      const rowsRaw = (r.rows || r) as any[];
      const seen = new Set<string>();
      const rows = rowsRaw.filter((x: any) => { const k = String(x.customer_id); if (seen.has(k)) return false; seen.add(k); return true; });
      const interval: Record<string, number> = { semanal: 7, quinzenal: 14, mensal: 28, bimestral: 56 };
      const now = Date.now();
      const cand: any[] = [];
      let jaPendentes = 0;
      for (const x of rows) {
        if (!x.last_created) continue;
        const intv = interval[String(x.periodicidade || 'semanal')] || 7;
        const dias = Math.floor((now - new Date(x.last_created).getTime()) / 86400000);
        if (dias / intv < 3) continue; // apenas 'perdido'
        if (x.ja_pendente) { jaPendentes++; continue; }
        cand.push({
          customerId: String(x.customer_id), nome: x.nome, cidade: x.cidade || '',
          telefone: x.telefone || '', contato: x.contato || '', documento: x.documento || '',
          vendedor: x.seller_name || (x.seller_id || 'Sem vendedor'),
          diasSemCompra: dias,
          ultimaCompra: new Date(x.last_created).toISOString(),
          valorHistorico: Math.round(Number(x.total_hist || 0) * 100) / 100,
          valorHistorico6m: Math.round(Number(x.total_6m || 0) * 100) / 100,
        });
      }
      cand.sort((a, b) => b.valorHistorico - a.valorHistorico || b.valorHistorico6m - a.valorHistorico6m);
      const limited = cand.slice(0, limit);
      const porVendedor: Record<string, number> = {};
      for (const c of cand) porVendedor[c.vendedor] = (porVendedor[c.vendedor] || 0) + 1;
      res.json({ ok: true, dryRun: true, total: cand.length, jaEmRepescagemPendente: jaPendentes, mostrando: limited.length, valorTotalHist: Math.round(cand.reduce((s, c) => s + c.valorHistorico, 0) * 100) / 100, porVendedor, candidatos: limited });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // VIGIA 3B (03/jul/2026): Justificativa de nao-atendimento — pendencias do dia anterior (visita planejada sem check-in e sem venda).
  async function ensureJustifTable() {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS visit_justifications (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), visit_date date NOT NULL, customer_id text NOT NULL, seller_id text NOT NULL, reason text NOT NULL, notes text, created_at timestamptz DEFAULT now(), created_by varchar)"));
    await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS uq_visit_justif ON visit_justifications (visit_date, customer_id, seller_id)"));
  }
  const JUSTIF_MOTIVOS = ['fechado', 'ausente', 'sem_tempo', 'ja_comprou', 'endereco', 'sem_interesse', 'remarcou', 'rota_inviavel', 'imprevisto', 'cancelou', 'debito', 'outro', 'removido'];

  // lista pendencias (nao atendidas) de uma data p/ um vendedor, que ainda NAO foram justificadas
  app.get('/api/vendedor/justificativas/pendentes', async (req: Request, res: Response) => {
    try {
      await ensureJustifTable();
      const seller = String(req.query.sellerId || '');
      if (!seller) return res.status(400).json({ error: 'sellerId obrigatorio' });
      // data padrao = ontem (BRT)
      let date = String(req.query.date || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const y = new Date(Date.now() - 86400000);
        date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(y);
      }
      const q = "SELECT sc.customer_id AS cid, MAX(c.name) AS nome, MAX(c.city) AS cidade FROM sales_cards sc JOIN customers c ON c.id = sc.customer_id WHERE sc.seller_id = '" + seller.replace(/'/g, "") + "' AND (sc.scheduled_date)::date = '" + date + "'::date AND sc.check_in_time IS NULL AND COALESCE(sc.sale_value::numeric, 0) = 0 AND c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) AND NOT EXISTS (SELECT 1 FROM visit_justifications vj WHERE vj.visit_date = '" + date + "'::date AND vj.customer_id = sc.customer_id AND vj.seller_id = sc.seller_id) GROUP BY sc.customer_id ORDER BY MAX(c.name)";
      const r: any = await db.execute(sql.raw(q));
      const rows = ((r.rows || r) as any[]).map((x: any) => ({ customerId: String(x.cid), nome: x.nome, cidade: x.cidade || '' }));
      res.json({ ok: true, date, sellerId: seller, total: rows.length, pendentes: rows, motivos: JUSTIF_MOTIVOS });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // ADMIN: pendências de não-atendimento de TODOS os vendedores, agrupadas por vendedor (com telefone).
  app.get('/api/admin/justificativas/pendentes-todos', async (req: Request, res: Response) => {
    try {
      await ensureJustifTable();
      let date = String(req.query.date || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const y = new Date(Date.now() - 86400000);
        date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(y);
      }
      const nomeSub = "(SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = replace(COALESCE(sc.seller_id,''),'omie-vendor-','') OR u.id = sc.seller_id LIMIT 1)";
      const foneSub = "(SELECT u.phone FROM users u WHERE u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = replace(COALESCE(sc.seller_id,''),'omie-vendor-','') OR u.id = sc.seller_id LIMIT 1)";
      const q = "SELECT sc.seller_id AS sid, " + nomeSub + " AS vendedor, " + foneSub + " AS telefone, "
        + "sc.customer_id AS cid, MAX(c.name) AS nome, MAX(c.city) AS cidade "
        + "FROM sales_cards sc JOIN customers c ON c.id = sc.customer_id "
        + "WHERE (sc.scheduled_date)::date = '" + date + "'::date "
        + "AND sc.check_in_time IS NULL AND COALESCE(sc.sale_value::numeric, 0) = 0 "
        + "AND c.is_active IS TRUE AND (c.is_supplier IS NOT TRUE) "
        + "AND NOT EXISTS (SELECT 1 FROM visit_justifications vj WHERE vj.visit_date = '" + date + "'::date AND vj.customer_id = sc.customer_id AND vj.seller_id = sc.seller_id) "
        + "GROUP BY sc.seller_id, sc.customer_id ORDER BY vendedor NULLS LAST, MAX(c.name)";
      const r: any = await db.execute(sql.raw(q));
      const rows = (r.rows || r) as any[];
      const bySeller: Record<string, any> = {};
      for (const x of rows) {
        const sid = String(x.sid);
        if (!bySeller[sid]) bySeller[sid] = { sellerId: sid, sellerName: x.vendedor || sid, phone: x.telefone || null, clientes: [] };
        bySeller[sid].clientes.push({ customerId: String(x.cid), nome: x.nome, cidade: x.cidade || '' });
      }
      const vendedores = Object.values(bySeller).sort((a: any, b: any) => b.clientes.length - a.clientes.length);
      res.json({ ok: true, date, totalClientes: rows.length, vendedores });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // Justificativas JA REGISTRADAS de um vendedor num dia (mapa customerId -> {reason, notes}).
  // Usado pelo Fechar Rota para nao repedir o que ja foi justificado (ex.: debito no check-in).
  app.get('/api/vendedor/justificativas', async (req: Request, res: Response) => {
    try {
      await ensureJustifTable();
      const seller = String(req.query.sellerId || '');
      const date = String(req.query.date || '').replace(/[^0-9-]/g, '');
      const dateOk = date.length === 10 && date[4] === '-' && date[7] === '-';
      if (!seller || !dateOk) return res.status(400).json({ error: 'sellerId e date obrigatorios' });
      const r: any = await db.execute(sql`SELECT customer_id AS cid, reason, notes FROM visit_justifications WHERE visit_date = ${date}::date AND seller_id = ${seller} AND reason <> 'removido'`);
      const map: Record<string, { reason: string; notes: string }> = {};
      for (const x of ((r.rows || r) as any[])) map[String(x.cid)] = { reason: String(x.reason || ''), notes: String(x.notes || '') };
      res.json({ ok: true, date, sellerId: seller, justificativas: map });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  app.post('/api/vendedor/justificativas', async (req: Request, res: Response) => {
    try {
      await ensureJustifTable();
      const b = req.body || {};
      const date = String(b.date || '').replace(/[^0-9-]/g, '');
      const customerId = String(b.customerId || '');
      const seller = String(b.sellerId || '');
      const reason = JUSTIF_MOTIVOS.includes(String(b.reason)) ? String(b.reason) : null;
      const notes = b.notes != null ? String(b.notes).slice(0, 500) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !customerId || !seller || !reason) return res.status(400).json({ error: 'date, customerId, sellerId e reason (motivo valido) obrigatorios' });
      await db.execute(sql`INSERT INTO visit_justifications (visit_date, customer_id, seller_id, reason, notes, created_by) VALUES (${date}, ${customerId}, ${seller}, ${reason}, ${notes}, ${seller}) ON CONFLICT (visit_date, customer_id, seller_id) DO UPDATE SET reason = EXCLUDED.reason, notes = EXCLUDED.notes`);
      res.json({ ok: true, date, customerId, reason });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // relatorio semanal por vendedor (justificativas por motivo nos ultimos N dias)
  app.get('/api/admin/justificativas/semana', async (req: Request, res: Response) => {
    try {
      await ensureJustifTable();
      const days = Math.min(Math.max(parseInt(String(req.query.days || '7'), 10) || 7, 1), 60);
      const q = "SELECT vj.seller_id AS sid, (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.omie_vendor_code = vj.seller_id OR u.omie_vendor_code = replace(COALESCE(vj.seller_id,''),'omie-vendor-','') OR u.id = vj.seller_id LIMIT 1) AS nome, vj.reason AS motivo, COUNT(*)::int AS n FROM visit_justifications vj WHERE vj.visit_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - " + days + " GROUP BY vj.seller_id, vj.reason ORDER BY vj.seller_id";
      const r: any = await db.execute(sql.raw(q));
      const rows = (r.rows || r) as any[];
      const bySeller: Record<string, any> = {};
      for (const x of rows) {
        const nome = x.nome || x.sid || 'Sem vendedor';
        if (!bySeller[nome]) bySeller[nome] = { sellerId: x.sid, sellerName: nome, total: 0, motivos: {} };
        bySeller[nome].motivos[x.motivo] = Number(x.n);
        bySeller[nome].total += Number(x.n);
      }
      res.json({ ok: true, days, porVendedor: Object.values(bySeller).sort((a: any, b: any) => b.total - a.total) });
    } catch (e: any) {
      res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });

  // FECHAMENTO DE ROTA (Ago/2026): regras configuraveis pelo admin (config_global, chave 'fechamento_config').
  async function ensureConfigGlobal() {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS config_global (chave text PRIMARY KEY, valor text NOT NULL, descricao text, updated_at timestamp DEFAULT now())"));
  }
  const FECHAMENTO_DEFAULTS: any = { travaObrigatoria: true, bloqueioDiaSeguinte: true, fechoAutomatico: false, fechoHorario: '19:00', tipos: ['presencial', 'virtual', 'lead'], bloqueioDesde: null, exigirDebito: false };
  async function getFechamentoConfig() {
    await ensureConfigGlobal();
    const r: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'fechamento_config' LIMIT 1`);
    const row = ((r.rows || r) as any[])[0];
    let cfg: any = { ...FECHAMENTO_DEFAULTS };
    if (row && row.valor) { try { cfg = { ...FECHAMENTO_DEFAULTS, ...JSON.parse(row.valor) }; } catch { /* usa defaults */ } }
    return cfg;
  }
  app.get('/api/admin/fechamento/config', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req: Request, res: Response) => {
    try { res.json({ ok: true, config: await getFechamentoConfig() }); }
    catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });
  app.post('/api/admin/fechamento/config', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      const cur = await getFechamentoConfig();
      const b = req.body || {};
      const next: any = { ...cur };
      if (typeof b.travaObrigatoria === 'boolean') next.travaObrigatoria = b.travaObrigatoria;
      if (typeof b.bloqueioDiaSeguinte === 'boolean') next.bloqueioDiaSeguinte = b.bloqueioDiaSeguinte;
      if (typeof b.fechoAutomatico === 'boolean') next.fechoAutomatico = b.fechoAutomatico;
      if (typeof b.fechoHorario === 'string' && /^\d{2}:\d{2}$/.test(b.fechoHorario)) next.fechoHorario = b.fechoHorario;
      if (Array.isArray(b.tipos)) next.tipos = b.tipos.filter((t: any) => ['presencial', 'virtual', 'lead'].includes(t));
      if (typeof b.exigirDebito === 'boolean') next.exigirDebito = b.exigirDebito;
      if (b.bloqueioDesde === null || (typeof b.bloqueioDesde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.bloqueioDesde))) next.bloqueioDesde = b.bloqueioDesde;
      const valor = JSON.stringify(next);
      await db.execute(sql`INSERT INTO config_global (chave, valor, descricao) VALUES ('fechamento_config', ${valor}, 'Regras do Fechamento de Rota') ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`);
      res.json({ ok: true, config: next });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // FECHAMENTO DE ROTA (Fase 2): registro do fechamento do dia por vendedor + status.
  async function ensureRouteClosures() {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS route_closures (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), seller_id text NOT NULL, close_date date NOT NULL, closed_at timestamptz DEFAULT now(), closed_by varchar, nao_visitados int DEFAULT 0, justificados int DEFAULT 0, pendentes int DEFAULT 0)"));
    await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS uq_route_closure ON route_closures (seller_id, close_date)"));
  }
  app.get('/api/vendedor/fechamento/status', async (req: Request, res: Response) => {
    try {
      await ensureRouteClosures();
      const seller = String(req.query.sellerId || '');
      let date = String(req.query.date || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
      const cfg = await getFechamentoConfig();
      const vendorCfg = { travaObrigatoria: !!cfg.travaObrigatoria, bloqueioDiaSeguinte: !!cfg.bloqueioDiaSeguinte, tipos: cfg.tipos, exigirDebito: !!cfg.exigirDebito };
      let closure: any = null;
      if (seller) {
        const r: any = await db.execute(sql`SELECT id, seller_id, close_date, closed_at, nao_visitados, justificados, pendentes FROM route_closures WHERE seller_id = ${seller} AND close_date = ${date}::date AND COALESCE(closed_by, '') <> 'auto' LIMIT 1`);
        const row = ((r.rows || r) as any[])[0];
        if (row) closure = { id: row.id, sellerId: row.seller_id, date, closedAt: row.closed_at, naoVisitados: row.nao_visitados, justificados: row.justificados, pendentes: row.pendentes };
      }
      res.json({ ok: true, date, closed: !!closure, closure, config: vendorCfg });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });
  app.post('/api/vendedor/fechamento/fechar', async (req: Request, res: Response) => {
    try {
      await ensureRouteClosures();
      const b = req.body || {};
      const seller = String(b.sellerId || '');
      const date = String(b.date || '').replace(/[^0-9-]/g, '');
      if (!seller || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'sellerId e date obrigatorios' });
      const pend = Math.max(0, parseInt(String(b.pendentes), 10) || 0);
      const just = Math.max(0, parseInt(String(b.justificados), 10) || 0);
      const nv = Math.max(0, parseInt(String(b.naoVisitados), 10) || 0);
      const cfg = await getFechamentoConfig();
      if (cfg.travaObrigatoria && pend > 0) return res.status(400).json({ error: 'Ha ' + pend + ' cliente(s) sem justificativa. Justifique para fechar.', pendentes: pend });
      await db.execute(sql`INSERT INTO route_closures (seller_id, close_date, closed_by, nao_visitados, justificados, pendentes) VALUES (${seller}, ${date}, ${seller}, ${nv}, ${just}, ${pend}) ON CONFLICT (seller_id, close_date) DO UPDATE SET closed_at = now(), closed_by = EXCLUDED.closed_by, nao_visitados = EXCLUDED.nao_visitados, justificados = EXCLUDED.justificados, pendentes = EXCLUDED.pendentes`);
      res.json({ ok: true, date, closed: true });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // FECHAMENTO DE ROTA (Fase 4): bloqueio da rota de hoje se um dia anterior (>= bloqueioDesde) nao foi fechado.
  app.get('/api/vendedor/fechamento/bloqueio', async (req: Request, res: Response) => {
    try {
      await ensureRouteClosures();
      const seller = String(req.query.sellerId || '');
      let date = String(req.query.date || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
      const cfg = await getFechamentoConfig();
      if (!seller || !cfg.bloqueioDiaSeguinte) return res.json({ ok: true, blocked: false });
      const desde = (typeof cfg.bloqueioDesde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.bloqueioDesde)) ? cfg.bloqueioDesde : date;
      const r: any = await db.execute(sql`SELECT to_char(dr.route_date::date, 'YYYY-MM-DD') AS d FROM daily_routes dr WHERE dr.seller_id = ${seller} AND dr.route_date::date < ${date}::date AND dr.route_date::date >= ${desde}::date AND NOT EXISTS (SELECT 1 FROM route_closures rc WHERE rc.seller_id = dr.seller_id AND rc.close_date = dr.route_date::date AND COALESCE(rc.closed_by, '') <> 'auto') ORDER BY dr.route_date DESC LIMIT 1`);
      const row = ((r.rows || r) as any[])[0];
      res.json({ ok: true, blocked: !!row, pendingDate: row ? row.d : null });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });
  app.post('/api/admin/fechamento/liberar', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      await ensureRouteClosures();
      const b = req.body || {};
      const seller = String(b.sellerId || '');
      const date = String(b.date || '').replace(/[^0-9-]/g, '');
      if (!seller || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'sellerId e date obrigatorios' });
      await db.execute(sql`INSERT INTO route_closures (seller_id, close_date, closed_by, nao_visitados, justificados, pendentes) VALUES (${seller}, ${date}, 'admin-liberado', 0, 0, 0) ON CONFLICT (seller_id, close_date) DO UPDATE SET closed_at = now(), closed_by = 'admin-liberado'`);
      res.json({ ok: true, date, liberado: true });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });
  app.post('/api/admin/fechamento/reabrir', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      await ensureRouteClosures();
      const b = req.body || {};
      const seller = String(b.sellerId || '');
      const date = String(b.date || '').replace(/[^0-9-]/g, '');
      if (!seller || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'sellerId e date obrigatorios' });
      await db.execute(sql`DELETE FROM route_closures WHERE seller_id = ${seller} AND close_date = ${date}::date`);
      res.json({ ok: true, date, reaberto: true });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // FECHAMENTO (Fase 5): painel mensal — agregados de justificativas e fechamentos do mes.
  app.get('/api/admin/fechamento/mensal', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      await ensureJustifTable(); await ensureRouteClosures(); await ensureJustifSuspensions();
      let mes = String(req.query.mes || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}$/.test(mes)) { mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).slice(0, 7); }
      const sid = String(req.query.sellerId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const fVJ = sid ? (" AND vj.seller_id = '" + sid + "'") : '';
      const fRC = sid ? (" AND rc.seller_id = '" + sid + "'") : '';
      const rm: any = await db.execute(sql`SELECT reason AS motivo, COUNT(*)::int AS n FROM visit_justifications vj WHERE to_char(vj.visit_date, 'YYYY-MM') = ${mes} AND vj.reason <> 'removido'${sql.raw(fVJ)} GROUP BY reason ORDER BY n DESC`);
      const porMotivo = ((rm.rows || rm) as any[]).map((x: any) => ({ motivo: x.motivo, n: Number(x.n) }));
      const rc: any = await db.execute(sql.raw("SELECT vj.customer_id AS cid, vj.seller_id AS sid, MAX(c.name) AS nome, MAX(c.city) AS cidade, MAX(c.visit_periodicity) AS periodicidade, COUNT(*)::int AS n, (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.omie_vendor_code = vj.seller_id OR u.omie_vendor_code = replace(COALESCE(vj.seller_id,''),'omie-vendor-','') OR u.id = vj.seller_id LIMIT 1) AS vendedor, (array_agg(vj.reason ORDER BY vj.visit_date DESC))[1] AS motivo, (array_agg(vj.notes ORDER BY vj.visit_date DESC))[1] AS obs FROM visit_justifications vj LEFT JOIN customers c ON c.id = vj.customer_id WHERE to_char(vj.visit_date,'YYYY-MM') = '" + mes + "' AND vj.reason <> 'removido'" + fVJ + " GROUP BY vj.customer_id, vj.seller_id ORDER BY n DESC, nome LIMIT 200"));
      // Suspensoes de justificativa (gestao admin) do mes: mapa por customer_id { visita, debito }.
      const rsp: any = await db.execute(sql`SELECT customer_id AS cid, tipo FROM justif_suspensions WHERE mes = ${mes}`);
      const suspV = new Set<string>(); const suspD = new Set<string>();
      for (const s of ((rsp.rows || rsp) as any[])) { if (s.tipo === 'debito') suspD.add(String(s.cid)); else suspV.add(String(s.cid)); }
      const clientes = ((rc.rows || rc) as any[]).map((x: any) => ({ customerId: String(x.cid), sellerId: String(x.sid || ''), nome: x.nome || x.cid, cidade: x.cidade || '', periodicidade: String(x.periodicidade || ''), vendedor: x.vendedor || '', n: Number(x.n), motivo: x.motivo, obs: String(x.obs || '').trim(), flagVisita: suspV.has(String(x.cid)), flagDebito: suspD.has(String(x.cid)) }));
      const rv: any = await db.execute(sql.raw("SELECT rc.seller_id AS sid, (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.omie_vendor_code = rc.seller_id OR u.omie_vendor_code = replace(COALESCE(rc.seller_id,''),'omie-vendor-','') OR u.id = rc.seller_id LIMIT 1) AS vendedor, COUNT(*)::int AS dias, COALESCE(SUM(rc.nao_visitados),0)::int AS nv, COALESCE(SUM(rc.justificados),0)::int AS just, COALESCE(SUM(rc.pendentes),0)::int AS pend FROM route_closures rc WHERE to_char(rc.close_date,'YYYY-MM') = '" + mes + "'" + fRC + " GROUP BY rc.seller_id ORDER BY nv DESC"));
      const porVendedor = ((rv.rows || rv) as any[]).map((x: any) => ({ sellerId: String(x.sid), vendedor: x.vendedor || x.sid, dias: Number(x.dias), naoVisitados: Number(x.nv), justificados: Number(x.just), pendentes: Number(x.pend) }));
      const rvd: any = await db.execute(sql.raw("SELECT vj.seller_id AS sid, (SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.omie_vendor_code = vj.seller_id OR u.omie_vendor_code = replace(COALESCE(vj.seller_id,''),'omie-vendor-','') OR u.id = vj.seller_id LIMIT 1) AS vendedor FROM visit_justifications vj WHERE to_char(vj.visit_date,'YYYY-MM') = '" + mes + "' AND vj.reason <> 'removido' GROUP BY vj.seller_id ORDER BY vendedor"));
      const vendedores = ((rvd.rows || rvd) as any[]).map((x: any) => ({ sellerId: String(x.sid || ''), vendedor: x.vendedor || x.sid })).filter((v: any) => v.sellerId);
      // "Fechou hoje": vendedores com fechamento REAL (nao-auto) da rota de HOJE (BRT).
      // Reinicia a cada dia — no dia seguinte, sem fechamento ainda, volta a ❌.
      const hojeBRT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const rfh: any = await db.execute(sql`SELECT DISTINCT seller_id AS sid FROM route_closures WHERE close_date = ${hojeBRT}::date AND COALESCE(closed_by, '') <> 'auto'`);
      const fechadosHoje = ((rfh.rows || rfh) as any[]).map((x: any) => String(x.sid));
      res.json({ ok: true, mes, sellerId: sid || null, hoje: hojeBRT, fechadosHoje, totalNaoVisitados: porMotivo.reduce((s: number, x: any) => s + x.n, 0), porMotivo, clientes, porVendedor, vendedores });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // FECHAMENTO — SUSPENSAO DE JUSTIFICATIVA (gestao admin, por mes vigente).
  // O admin marca "Visita" e/ou "Debito" para um cliente: enquanto marcado, aquele
  // motivo NAO precisa ser justificado pelo vendedor naquele mes (o cliente sai da
  // lista de justificativas do Fechar Rota). Chave: (mes, customer_id, tipo).
  async function ensureJustifSuspensions() {
    await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS justif_suspensions (mes text NOT NULL, customer_id text NOT NULL, tipo text NOT NULL, created_at timestamptz DEFAULT now(), created_by varchar, PRIMARY KEY (mes, customer_id, tipo))"));
  }
  const SUSP_TIPOS = new Set(['visita', 'debito']);
  function mesAtualBRT() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).slice(0, 7); }

  // GET suspensoes do mes (usado pelo Fechar Rota do vendedor). Retorna listas de customerIds.
  app.get('/api/fechamento/suspensoes', async (req: Request, res: Response) => {
    try {
      await ensureJustifSuspensions();
      let mes = String(req.query.mes || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}$/.test(mes)) mes = mesAtualBRT();
      const r: any = await db.execute(sql`SELECT customer_id AS cid, tipo FROM justif_suspensions WHERE mes = ${mes}`);
      const visita: string[] = []; const debito: string[] = [];
      for (const s of ((r.rows || r) as any[])) { if (s.tipo === 'debito') debito.push(String(s.cid)); else visita.push(String(s.cid)); }
      res.json({ ok: true, mes, visita, debito });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // POST marca/desmarca UMA suspensao. body: { mes, customerId, tipo:'visita'|'debito', value:bool }
  app.post('/api/admin/fechamento/suspensao', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      await ensureJustifSuspensions();
      const b = req.body || {};
      let mes = String(b.mes || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}$/.test(mes)) mes = mesAtualBRT();
      const customerId = String(b.customerId || '');
      const tipo = String(b.tipo || '');
      const value = !!b.value;
      if (!customerId || !SUSP_TIPOS.has(tipo)) return res.status(400).json({ error: 'customerId e tipo (visita|debito) obrigatorios' });
      const uid = (req as any).currentUser?.id || null;
      if (value) {
        await db.execute(sql`INSERT INTO justif_suspensions (mes, customer_id, tipo, created_by) VALUES (${mes}, ${customerId}, ${tipo}, ${uid}) ON CONFLICT (mes, customer_id, tipo) DO NOTHING`);
      } else {
        await db.execute(sql`DELETE FROM justif_suspensions WHERE mes = ${mes} AND customer_id = ${customerId} AND tipo = ${tipo}`);
      }
      res.json({ ok: true, mes, customerId, tipo, value });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // POST bulk: marcar tudo / limpar tudo de UMA coluna. body: { mes, tipo, value, customerIds:[] }
  app.post('/api/admin/fechamento/suspensao/bulk', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: Request, res: Response) => {
    try {
      await ensureJustifSuspensions();
      const b = req.body || {};
      let mes = String(b.mes || '').replace(/[^0-9-]/g, '');
      if (!/^\d{4}-\d{2}$/.test(mes)) mes = mesAtualBRT();
      const tipo = String(b.tipo || '');
      const value = !!b.value;
      if (!SUSP_TIPOS.has(tipo)) return res.status(400).json({ error: 'tipo (visita|debito) obrigatorio' });
      const ids = Array.isArray(b.customerIds) ? b.customerIds.map((x: any) => String(x)).filter(Boolean) : [];
      const uid = (req as any).currentUser?.id || null;
      if (value) {
        for (const cid of ids) {
          await db.execute(sql`INSERT INTO justif_suspensions (mes, customer_id, tipo, created_by) VALUES (${mes}, ${cid}, ${tipo}, ${uid}) ON CONFLICT (mes, customer_id, tipo) DO NOTHING`);
        }
      } else if (ids.length > 0) {
        // DELETE por id (loop), igual ao INSERT acima. O `= ANY(${ids})` com bind de
        // array falhava e derrubava o "limpar" em massa (erro "atualizar em massa").
        for (const cid of ids) {
          await db.execute(sql`DELETE FROM justif_suspensions WHERE mes = ${mes} AND tipo = ${tipo} AND customer_id = ${cid}`);
        }
      }
      res.json({ ok: true, mes, tipo, value, afetados: ids.length });
    } catch (e: any) { res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) }); }
  });

  // FECHAMENTO (Fase 5): fecho automatico no horario de corte (se ligado). Verifica a cada 10 min, roda 1x/dia.
  async function fechamentoAutoTick() {
    try {
      const cfg = await getFechamentoConfig();
      if (!cfg.fechoAutomatico) return;
      const now = new Date();
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
      if (String(hhmm) < String(cfg.fechoHorario || '19:00')) return;
      await ensureConfigGlobal();
      const lr: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'fechamento_auto_last' LIMIT 1`);
      if (((lr.rows || lr) as any[])[0]?.valor === today) return;
      await ensureRouteClosures();
      await db.execute(sql`INSERT INTO route_closures (seller_id, close_date, closed_by) SELECT dr.seller_id, ${today}::date, 'auto' FROM daily_routes dr WHERE dr.route_date::date = ${today}::date AND NOT EXISTS (SELECT 1 FROM route_closures rc WHERE rc.seller_id = dr.seller_id AND rc.close_date = ${today}::date) ON CONFLICT (seller_id, close_date) DO NOTHING`);
      await db.execute(sql`INSERT INTO config_global (chave, valor, descricao) VALUES ('fechamento_auto_last', ${today}, 'Ultimo fecho automatico do dia') ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`);
    } catch { /* noop */ }
  }
  setInterval(fechamentoAutoTick, 10 * 60 * 1000);

// Limpeza (02/jul/2026): remove visitas PENDENTES (hoje+futuras) de clientes fora da lista de Clientes Ativos
  app.post('/api/admin/visits/cleanup-off-list', async (req: Request, res: Response) => {
    try {
      const apply = !!(req.body && req.body.apply);
      const cond = "va.visit_status = 'pending' AND va.scheduled_date >= (now() at time zone 'utc')::date AND NOT EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = va.customer_id AND ac.is_active IS TRUE)";
      const cnt: any = await db.execute(sql.raw("SELECT COUNT(*)::int AS n, COUNT(DISTINCT va.customer_id)::int AS clientes FROM visit_agenda va WHERE " + cond));
      const row = ((cnt.rows || cnt) as any[])[0] || {};
      let deleted = 0;
      if (apply) {
        const del: any = await db.execute(sql.raw("DELETE FROM visit_agenda va WHERE " + cond));
        deleted = Number((del && del.rowCount) || 0);
      }
      res.json({ apply, visitasPendentesForaDaLista: Number(row.n || 0), clientes: Number(row.clientes || 0), deleted });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  // DASHBOARD FINANCEIRO (02/jul/2026): agregados de contas a receber/pagar p/ a tela /dashboard-financeiro
  // [Blindagem Financeira - Fase 1] AUDITORIA DE INTEGRIDADE (read-only, risco zero): detecta vazamentos.
  app.get('/api/admin/financial/auditoria-integridade', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req: Request, res: Response) => {
    try {
      const many = async (q: string) => { const r: any = await db.execute(sql.raw(q)); return ((r.rows || r) as any[]); };
      // 1) Faturado SEM cobranca: recebivel de VENDA (billing_pipeline_id), em aberto, sem boleto E sem pix vinculado
      const semCobBase = "FROM receivables r WHERE r.deleted_at IS NULL AND r.billing_pipeline_id IS NOT NULL AND r.status IN ('a_vencer','vencida') AND (r.amount - COALESCE(r.amount_paid,0)) > 0 AND NOT EXISTS (SELECT 1 FROM boleto_charges b WHERE b.receivable_id = r.id) AND NOT EXISTS (SELECT 1 FROM boleto_charge_receivables jr WHERE jr.receivable_id = r.id) AND NOT EXISTS (SELECT 1 FROM pix_charges pc WHERE pc.receivable_id = r.id)";
      const semCobTot = (await many("SELECT COUNT(*)::int AS n, COALESCE(SUM(r.amount - COALESCE(r.amount_paid,0)),0)::float AS v " + semCobBase))[0] || {};
      const semCobItens = await many("SELECT r.id, r.title_number AS titulo, r.customer_name AS cliente, (r.amount - COALESCE(r.amount_paid,0))::float AS saldo, r.due_date AS vencimento, r.payment_method AS forma, r.omie_instance_id AS instancia " + semCobBase + " ORDER BY saldo DESC LIMIT 200");
      // 2) Baixa SEM lastro bancario: pagamento de recebivel registrado sem conta financeira (nao lastreado em banco)
      const semLastroTot = (await many("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS v FROM receivable_payments WHERE financial_account_id IS NULL"))[0] || {};
      const semLastroItens = await many("SELECT rp.id, rp.receivable_id, rp.amount::float AS valor, rp.paid_at AS pago_em, rp.payment_method AS forma, rp.created_by, rp.notes FROM receivable_payments rp WHERE rp.financial_account_id IS NULL ORDER BY rp.paid_at DESC NULLS LAST LIMIT 200");
      // Contexto: totais de referencia
      const ctx = (await many("SELECT (SELECT COUNT(*) FROM receivables WHERE billing_pipeline_id IS NOT NULL)::int AS receb_venda, (SELECT COUNT(*) FROM boleto_charges)::int AS boletos, (SELECT COUNT(*) FROM pix_charges)::int AS pix, (SELECT COUNT(*) FROM receivable_payments)::int AS pagamentos, (SELECT COUNT(*) FROM account_movements)::int AS movimentos, (SELECT COUNT(*) FROM bank_statement_items)::int AS itens_extrato"))[0] || {};
      res.json({
        geradoEm: new Date().toISOString(),
        faturadoSemCobranca: { n: Number(semCobTot.n || 0), valor: Number(semCobTot.v || 0), itens: semCobItens },
        baixaSemLastroBancario: { n: Number(semLastroTot.n || 0), valor: Number(semLastroTot.v || 0), itens: semLastroItens },
        contexto: ctx,
      });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) }); }
  });

  app.get('/api/admin/financial/dashboard', async (_req: Request, res: Response) => {
    try {
      const HOJE = "(now() at time zone 'America/Sao_Paulo')::date";
      const openRec = "FROM receivables WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0";
      const openPay = "FROM payables WHERE deleted_at IS NULL AND status IN ('a_vencer','vencida') AND (amount - COALESCE(amount_paid,0)) > 0";
      const many = async (q: string) => { const r: any = await db.execute(sql.raw(q)); return ((r.rows || r) as any[]); };
      const one = async (q: string) => (await many(q))[0] || {};
      const kq = (base: string) => "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS v, COUNT(*) FILTER (WHERE due_date::date < " + HOJE + ")::int AS n_venc, COALESCE(SUM(amount - COALESCE(amount_paid,0)) FILTER (WHERE due_date::date < " + HOJE + "),0)::float AS v_venc, COUNT(*) FILTER (WHERE due_date::date = " + HOJE + ")::int AS n_hoje, COALESCE(SUM(amount - COALESCE(amount_paid,0)) FILTER (WHERE due_date::date = " + HOJE + "),0)::float AS v_hoje " + base;
      const kr = await one(kq(openRec));
      const kp = await one(kq(openPay));
      const winRec = openRec + " AND due_date >= date_trunc('month', " + HOJE + ") - interval '2 months' AND due_date < date_trunc('month', " + HOJE + ") + interval '7 months'";
      const winPay = openPay + " AND due_date >= date_trunc('month', " + HOJE + ") - interval '2 months' AND due_date < date_trunc('month', " + HOJE + ") + interval '7 months'";
      const fluxoRec = await many("SELECT to_char(due_date, 'YYYY-MM') AS mes, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS v " + winRec + " GROUP BY 1 ORDER BY 1");
      const fluxoPay = await many("SELECT to_char(due_date, 'YYYY-MM') AS mes, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS v " + winPay + " GROUP BY 1 ORDER BY 1");
      const meses = Array.from(new Set([...fluxoRec.map((r: any) => r.mes), ...fluxoPay.map((r: any) => r.mes)])).sort();
      const fr = new Map(fluxoRec.map((r: any) => [r.mes, Number(r.v)]));
      const fp = new Map(fluxoPay.map((r: any) => [r.mes, Number(r.v)]));
      const fluxo = meses.map((m) => ({ mes: m, entradas: fr.get(m) || 0, saidas: fp.get(m) || 0 }));
      // Fluxo de caixa DIARIO — proximos 30 dias (hoje..hoje+29), com saldo do dia e acumulado
      const winRecD = openRec + " AND due_date::date >= " + HOJE + " AND due_date::date < " + HOJE + " + 30";
      const winPayD = openPay + " AND due_date::date >= " + HOJE + " AND due_date::date < " + HOJE + " + 30";
      const fluxoRecD = await many("SELECT due_date::date::text AS dia, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS v " + winRecD + " GROUP BY 1");
      const fluxoPayD = await many("SELECT due_date::date::text AS dia, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS v " + winPayD + " GROUP BY 1");
      const frD = new Map(fluxoRecD.map((r: any) => [r.dia, Number(r.v)]));
      const fpD = new Map(fluxoPayD.map((r: any) => [r.dia, Number(r.v)]));
      const diasD = await many("SELECT (" + HOJE + " + g)::text AS dia FROM generate_series(0,29) g ORDER BY 1");
      let accD = 0;
      const fluxoDiario = diasD.map((row: any) => { const e = frD.get(row.dia) || 0; const s = fpD.get(row.dia) || 0; accD += (e - s); return { dia: row.dia, entradas: e, saidas: s, saldo: e - s, saldoAcumulado: accD }; });
      const pagarHoje = await many("SELECT title_number AS titulo, supplier_name AS fornecedor, description AS descricao, due_date AS vencimento, (amount - COALESCE(amount_paid,0))::float AS saldo " + openPay + " AND due_date::date = " + HOJE + " ORDER BY saldo DESC LIMIT 100");
      const pagarVencidas = await many("SELECT title_number AS titulo, supplier_name AS fornecedor, description AS descricao, due_date AS vencimento, (amount - COALESCE(amount_paid,0))::float AS saldo " + openPay + " AND due_date::date < " + HOJE + " ORDER BY due_date ASC LIMIT 100");
      const receberHoje = await many("SELECT title_number AS titulo, customer_name AS cliente, (amount - COALESCE(amount_paid,0))::float AS saldo " + openRec + " AND due_date::date = " + HOJE + " ORDER BY saldo DESC LIMIT 100");
      const agingQ = (base: string) => "SELECT CASE WHEN (" + HOJE + " - due_date::date) <= 30 THEN '1-30' WHEN (" + HOJE + " - due_date::date) <= 60 THEN '31-60' WHEN (" + HOJE + " - due_date::date) <= 90 THEN '61-90' ELSE '90+' END AS faixa, COUNT(*)::int AS n, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS valor " + base + " AND due_date::date < " + HOJE + " GROUP BY 1 ORDER BY 1";
      const agingReceber = await many(agingQ(openRec));
      const agingPagar = await many(agingQ(openPay));
      const topDevedores = await many("SELECT COALESCE(customer_name,'(sem nome)') AS cliente, COUNT(*)::int AS n, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0)::float AS valor " + openRec + " AND due_date::date < " + HOJE + " GROUP BY 1 ORDER BY valor DESC LIMIT 10");
      const hojeR: any = await one("SELECT (" + HOJE + ")::text AS d");
      res.json({
        hoje: hojeR.d,
        kpis: {
          receberAberto: Number(kr.v || 0), receberAbertoN: Number(kr.n || 0),
          pagarAberto: Number(kp.v || 0), pagarAbertoN: Number(kp.n || 0),
          receberVencido: Number(kr.v_venc || 0), receberVencidoN: Number(kr.n_venc || 0),
          pagarVencido: Number(kp.v_venc || 0), pagarVencidoN: Number(kp.n_venc || 0),
          receberHoje: Number(kr.v_hoje || 0), receberHojeN: Number(kr.n_hoje || 0),
          pagarHoje: Number(kp.v_hoje || 0), pagarHojeN: Number(kp.n_hoje || 0)
        },
        fluxo, fluxoDiario, pagarHoje, pagarVencidas, receberHoje, agingReceber, agingPagar, topDevedores
      });
    } catch (e: any) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) }); }
  });

  app.get('/api/admin/visits/generate-from-1-0/status', async (_req: Request, res: Response) => {
    try { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'visits_seed_last'`); const row = (r.rows || r)[0]; res.json(row ? JSON.parse(row.value) : { pending: true }); }
    catch (e: any) { res.status(500).json({ error: String(e).slice(0, 200) }); }
  });

  // IMPORTAÇÃO COMPLETA do cadastro de clientes 1.0 -> 2.0 por DOCUMENTO (chave confiável). Traz TODOS os campos comuns.
  // Match: por documento (cnpj/cpf normalizado); senão por id; senão INSERT. dryRun/apply. + checagem de paridade.
  app.post('/api/admin/sync/import-all-customers', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      await src.query("SET TIME ZONE 'UTC'"); await tgt.query("SET TIME ZONE 'UTC'");
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const colQ = "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'";
      const sc = (await src.query(colQ)).rows as any[];
      const tc = (await tgt.query(colQ)).rows as any[];
      const tgtCols = new Map(tc.map((r) => [r.column_name, r.udt_name]));
      const EXCLUDE = new Set(['id', 'created_at', 'updated_at']);
      const cols = sc.map((r) => r.column_name).filter((c) => tgtCols.has(c) && !EXCLUDE.has(c));
      const jsonCols = new Set(tc.filter((r) => r.udt_name === 'json' || r.udt_name === 'jsonb').map((r) => r.column_name));
      const enumCols = new Set(tc.filter((r) => !['text','varchar','bpchar','int4','int8','numeric','bool','timestamp','timestamptz','date','float8','json','jsonb','uuid'].includes(r.udt_name)).map((r) => r.column_name));
      const s1 = (await src.query('SELECT * FROM customers')).rows as any[];
      // index 2.0 por doc e por id
      const t2 = (await tgt.query('SELECT id, cnpj, cpf FROM customers')).rows as any[];
      const docToId = new Map<string, string>(); const idSet = new Set<string>();
      for (const c of t2) { idSet.add(String(c.id)); for (const d of [dg(c.cnpj), dg(c.cpf)]) { if (d && d.length >= 11 && !docToId.has(d)) docToId.set(d, String(c.id)); } }
      const result: any = { srcCustomers: s1.length, colsImportadas: cols.length, apply, updated: 0, inserted: 0, skipped: 0, errors: [] as string[] };
      const enc = (row: any, c: string) => { let v = row[c]; if (v !== null && jsonCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; };
      // DEDUP no 1.0: quando o mesmo documento aparece em >1 linha do 1.0, escolhe a MELHOR (ativa + mais campos preenchidos).
      const nonEmpty = (r: any) => cols.reduce((n: number, c: string) => { const v = r[c]; const t = (v === null || v === undefined) ? '' : String(v).trim(); return n + ((t !== '' && t !== '[]' && t !== '{}') ? 1 : 0); }, 0);
      const activeScore = (r: any) => ((String(r.omie_status || '').toLowerCase() === 'ativo' ? 1 : 0) + ((r.is_active === true || String(r.is_active) === 'true') ? 1 : 0));
      const bestByDoc = new Map<string, any>(); const noDocRows: any[] = [];
      for (const row of s1) {
        const dc0 = dg(row.cnpj), dp0 = dg(row.cpf);
        const d0 = (dc0 && dc0.length >= 11) ? dc0 : ((dp0 && dp0.length >= 11) ? dp0 : '');
        if (!d0) { noDocRows.push(row); continue; }
        const prev = bestByDoc.get(d0);
        if (!prev) { bestByDoc.set(d0, row); continue; }
        const sPrev = activeScore(prev) * 1000 + nonEmpty(prev);
        const sCur = activeScore(row) * 1000 + nonEmpty(row);
        if (sCur > sPrev) bestByDoc.set(d0, row);
      }
      const s1dedup = [...bestByDoc.values(), ...noDocRows];
      result.srcDupCollapsed = s1.length - s1dedup.length;
      for (const row of s1dedup) {
        const dc = dg(row.cnpj), dp = dg(row.cpf);
        // CHAVE = DOCUMENTO (cpf/cnpj). SEM vinculo/ID do Omie.
        const dkey = (dc && dc.length >= 11 && docToId.has(dc)) ? dc : ((dp && dp.length >= 11 && docToId.has(dp)) ? dp : null);
        const targetId = dkey ? docToId.get(dkey)! : null;
        const hasValidDoc = (dc && dc.length >= 11) || (dp && dp.length >= 11);
        if (!apply) {
          if (targetId) result.updated++;
          else if (hasValidDoc) result.inserted++;
          else result.skipped++;
          continue;
        }
        try {
          if (targetId) {
            const setCols = cols.filter((c) => c !== 'cpf' && c !== 'cnpj');
            const setSql = setCols.map((c, i) => '"' + c + '" = $' + (i + 1) + (enumCols.has(c) ? '::text::"' + tc.find((x)=>x.column_name===c)!.udt_name + '"' : '')).join(', ');
            const vals = setCols.map((c) => enc(row, c)); vals.push(targetId);
            await tgt.query('UPDATE customers SET ' + setSql + ' WHERE id = $' + (setCols.length + 1), vals);
            result.updated++;
          } else if (hasValidDoc) {
            // Cliente do 1.0 ausente no 2.0 -> INSERE com uuid PROPRIO (nao o id do Omie), chave = documento
            const insCols = cols; // sem 'id' -> default gen_random_uuid()
            const ph = insCols.map((c, i) => '$' + (i + 1) + (enumCols.has(c) ? '::text::"' + (tc.find((x)=>x.column_name===c)?.udt_name||'text') + '"' : '')).join(', ');
            const vals = cols.map((c) => {
              // nulifica documento invalido/vazio p/ nao colidir no unique (NULL nao colide)
              if (c === 'cpf') return (dp && dp.length >= 11) ? row.cpf : null;
              if (c === 'cnpj') return (dc && dc.length >= 11) ? row.cnpj : null;
              return enc(row, c);
            });
            await tgt.query('INSERT INTO customers (' + insCols.map((c)=>'"'+c+'"').join(',') + ') VALUES (' + ph + ')', vals);
            const dk = (dc && dc.length >= 11) ? dc : dp!;
            docToId.set(dk, '__inserted__');
            result.inserted++;
          } else {
            result.skipped++;
          }
        } catch (e: any) { result.skipped++; if (result.errors.length < 12) result.errors.push(String(e.message).slice(0, 120)); }
      }
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) }); }
    finally { await src.end().catch(()=>{}); await tgt.end().catch(()=>{}); }
  });

  // Reconcilia seller_id de TODOS os clientes 2.0:=1.0 casando por DOCUMENTO e, quando nao ha doc-match, por NOME+CIDADE (nao-ambiguo).
  app.post('/api/admin/sync/reconcile-customers', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const norm = (x: any) => String(x || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const s1 = (await src.query("SELECT cnpj, cpf, name, fantasy_name, city, seller_id FROM customers WHERE seller_id IS NOT NULL AND seller_id <> ''")).rows as any[];
      const docSeller = new Map<string, string>();
      const nameCity = new Map<string, string | null>(); // null = ambiguo
      for (const c of s1) {
        const d = dg(c.cnpj) || dg(c.cpf);
        if (d && d.length >= 11 && !docSeller.has(d)) docSeller.set(d, c.seller_id);
        const nk = norm(c.name || c.fantasy_name) + '|' + norm(c.city);
        if (norm(c.name || c.fantasy_name).length >= 4) {
          if (!nameCity.has(nk)) nameCity.set(nk, c.seller_id);
          else if (nameCity.get(nk) !== c.seller_id) nameCity.set(nk, null); // conflito -> ambiguo
        }
      }
      const t2: any = await db.execute(sql.raw("SELECT id, cnpj, cpf, name, fantasy_name, city, seller_id FROM customers"));
      const rows2 = (t2.rows || t2) as any[];
      // PROTECAO: nao sobrescrever clientes com rezoneamento manual (historico do sellerId por edit/bulk).
      // Sem isto, o reconcile 1.0:=fonte revertia vendedores ajustados a mao no 2.0 (ex.: cliente volta p/ "MW TRADING").
      const rezonedIds = new Set<string>();
      try {
        const rz: any = await db.execute(sql.raw("SELECT DISTINCT customer_id FROM customer_change_history WHERE field = 'sellerId' AND source IN ('edit','bulk')"));
        for (const r of (rz.rows || rz) as any[]) rezonedIds.add(String(r.customer_id));
      } catch (_e) {}
      const toFixDoc: any[] = []; const toFixName: any[] = []; let protegidosPorRezoneamento = 0;
      for (const c of rows2) {
        if (rezonedIds.has(String(c.id))) { protegidosPorRezoneamento++; continue; }
        const d = dg(c.cnpj) || dg(c.cpf);
        let want: string | null | undefined = (d && d.length >= 11) ? docSeller.get(d) : undefined;
        let via = 'doc';
        if (!want) { const nk = norm(c.name || c.fantasy_name) + '|' + norm(c.city); const nv = nameCity.get(nk); if (nv) { want = nv; via = 'name'; } }
        if (want && String(c.seller_id || '') !== String(want)) { (via === 'doc' ? toFixDoc : toFixName).push({ id: c.id, val: want }); }
      }
      const RAD = 'e9149282-adfc-448e-8d0e-a07765a06637';
      const radBefore: any = await db.execute(sql`SELECT count(*)::int n FROM customers WHERE seller_id = ${RAD}`);
      const result: any = { srcSellers: s1.length, docKeys: docSeller.size, nameKeys: nameCity.size, protegidosPorRezoneamento, corrigirPorDoc: toFixDoc.length, corrigirPorNome: toFixName.length, apply, updated: 0, radiltonAntes: (radBefore.rows || radBefore)[0].n };
      if (apply) {
        let upd = 0;
        for (const f of [...toFixDoc, ...toFixName]) { try { const u: any = await db.execute(sql`UPDATE customers SET seller_id = ${f.val}, updated_at = now() WHERE id = ${f.id}`); upd += (u.rowCount || 0); } catch (e) {} }
        result.updated = upd;
        const radAfter: any = await db.execute(sql`SELECT count(*)::int n FROM customers WHERE seller_id = ${RAD}`);
        result.radiltonDepois = (radAfter.rows || radAfter)[0].n;
      }
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) }); }
    finally { await src.end().catch(() => {}); }
  });

  // Read-only: clientes ATIVOS (nao-lead) SEM cpf/cnpj, todas as instancias, com vendedor resolvido.
  app.get('/api/admin/customers/no-document', async (_req: Request, res: Response) => {
    try {
      const usR: any = await db.execute(sql.raw("SELECT id, first_name, last_name, email, omie_vendor_code FROM users"));
      const us = (usR.rows || usR) as any[];
      const byId = new Map<string, any>(); const byCode = new Map<string, any>();
      const nm = (u: any) => ((`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email || u.id);
      for (const u of us) { byId.set(u.id, u); if (u.omie_vendor_code) byCode.set(String(u.omie_vendor_code), u); }
      const sellerName = (sid: any) => { if (!sid) return '(sem vendedor)'; const t = String(sid); const u = byId.get(t) || byCode.get(t) || byCode.get(t.replace('omie-vendor-', '')); return u ? nm(u) : ('(cod ' + t + ')'); };
      const cR: any = await db.execute(sql.raw("SELECT name, fantasy_name, city, neighborhood, seller_id, omie_instance_id FROM customers WHERE coalesce(is_active,true)=true AND coalesce(is_lead,false)=false AND length(regexp_replace(coalesce(cnpj,''),'[^0-9]','','g')) < 11 AND length(regexp_replace(coalesce(cpf,''),'[^0-9]','','g')) < 11"));
      const rows = (cR.rows || cR) as any[];
      const grp: Record<string, any[]> = {};
      for (const c of rows) { const v = sellerName(c.seller_id); (grp[v] = grp[v] || []).push({ nome: c.name || c.fantasy_name || '(sem nome)', cidade: c.city || '', bairro: c.neighborhood || '', instancia: c.omie_instance_id || '' }); }
      const porVendedor = Object.entries(grp).map(([v, l]) => ({ vendedor: v, n: l.length })).sort((a, b) => b.n - a.n);
      res.json({ total: rows.length, porVendedor, grupos: grp });
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 200) }); }
  });

  // Dedup de clientes por DOCUMENTO no 2.0: mantem 1 registro ativo por cpf/cnpj; re-aponta FKs dos duplicados p/ o primario e desativa os duplicados (is_active=false, reversivel, NAO apaga).
  app.post('/api/admin/customers/dedup', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    try {
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const rowsR: any = await db.execute(sql.raw("SELECT id, cnpj, cpf, name, fantasy_name, is_active, seller_id, created_at FROM customers"));
      const rows = (rowsR.rows || rowsR) as any[];
      const groups = new Map<string, any[]>();
      for (const c of rows) { const d = dg(c.cnpj) || dg(c.cpf); if (!d || d.length < 11) continue; if (!groups.has(d)) groups.set(d, []); groups.get(d)!.push(c); }
      const dupGroups = [...groups.entries()].filter(([_d, m]) => m.length > 1);
      // tabelas com coluna customer_id
      const fkR: any = await db.execute(sql.raw("SELECT table_name FROM information_schema.columns WHERE column_name='customer_id' AND table_schema='public' AND table_name <> 'customers'"));
      const fkTables = (fkR.rows || fkR).map((r: any) => r.table_name);
      const result: any = { totalCustomers: rows.length, dupGroups: dupGroups.length, dupExtraRows: dupGroups.reduce((a, [_d, m]) => a + (m.length - 1), 0), fkTables, apply, merged: 0, repointed: {}, deactivated: 0, errors: [] };
      // amostra (mascarada)
      result.sample = dupGroups.slice(0, 8).map(([d, m]) => ({ docMask: '***' + d.slice(-4), n: m.length, membros: m.map((c) => ({ idP: String(c.id).slice(0, 8), ativo: c.is_active === true, seller: String(c.seller_id || '').slice(0, 12), criado: c.created_at })) }));
      if (apply) {
        for (const [_d, members] of dupGroups) {
          // primario: ativo primeiro, depois mais antigo
          const sorted = [...members].sort((a, b) => { const aw = (a.is_active === true ? 0 : 1); const bw = (b.is_active === true ? 0 : 1); if (aw !== bw) return aw - bw; return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(); });
          const primary = sorted[0]; const dups = sorted.slice(1);
          for (const dup of dups) {
            for (const t of fkTables) {
              try { const u: any = await db.execute(sql`UPDATE ${sql.identifier(t)} SET customer_id = ${primary.id} WHERE customer_id = ${dup.id}`); result.repointed[t] = (result.repointed[t] || 0) + (u.rowCount || 0); }
              catch (e2: any) { result.errors.push(t + ': ' + String(e2.message).slice(0, 60)); }
            }
            try { await db.execute(sql`UPDATE customers SET is_active = false, omie_status = 'inativo', updated_at = now() WHERE id = ${dup.id}`); result.deactivated++; } catch (e: any) { result.errors.push('deact ' + String(dup.id).slice(0, 8) + ': ' + String(e.message).slice(0, 60)); }
          }
          result.merged++;
        }
      }
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 200) }); }
  });

  // Sincroniza seller_id 2.0:=1.0 por DOCUMENTO (cobre clientes com id divergente que o audit-por-id nao pega).
  app.post('/api/admin/sync/seller-by-doc', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
      const s1 = (await src.query("SELECT cnpj, cpf, seller_id FROM customers WHERE seller_id IS NOT NULL AND seller_id <> ''")).rows;
      const docToSeller = new Map<string, string>();
      for (const r of s1 as any[]) { const d = dg(r.cnpj) || dg(r.cpf); if (d && d.length >= 11 && !docToSeller.has(d)) docToSeller.set(d, r.seller_id); }
      const t2: any = await db.execute(sql.raw("SELECT id, cnpj, cpf, seller_id FROM customers"));
      const rows2 = (t2.rows || t2) as any[];
      const toFix: Array<{ id: string; val: string }> = [];
      // PROTECAO: nao sobrescrever clientes com rezoneamento manual (historico do sellerId por edit/bulk)
      const rezonedIds = new Set<string>();
      try {
        const rz: any = await db.execute(sql.raw("SELECT DISTINCT customer_id FROM customer_change_history WHERE field = 'sellerId' AND source IN ('edit','bulk')"));
        for (const r of (rz.rows || rz) as any[]) rezonedIds.add(String(r.customer_id));
      } catch (_e) {}
      for (const c of rows2) { const d = dg(c.cnpj) || dg(c.cpf); if (!d || d.length < 11) continue; if (rezonedIds.has(String(c.id))) continue; const want = docToSeller.get(d); if (want && String(c.seller_id || '') !== String(want)) toFix.push({ id: c.id, val: want }); }
      const RAD = 'e9149282-adfc-448e-8d0e-a07765a06637';
      const radBefore: any = await db.execute(sql`SELECT count(*)::int n FROM customers WHERE seller_id = ${RAD}`);
      const result: any = { srcSellersPorDoc: docToSeller.size, tgtCustomers: rows2.length, protegidosPorRezoneamento: rezonedIds.size, divergentesPorDoc: toFix.length, apply, updated: 0, radiltonAntes: (radBefore.rows || radBefore)[0].n };
      if (apply && toFix.length) {
        let upd = 0;
        for (const d of toFix) { try { const u: any = await db.execute(sql`UPDATE customers SET seller_id = ${d.val}, updated_at = now() WHERE id = ${d.id}`); upd += (u.rowCount || 0); } catch (e) {} }
        result.updated = upd;
        const radAfter: any = await db.execute(sql`SELECT count(*)::int n FROM customers WHERE seller_id = ${RAD}`);
        result.radiltonDepois = (radAfter.rows || radAfter)[0].n;
      }
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 200) }); }
    finally { await src.end().catch(() => {}); }
  });

  // ============================================================================
  // AUDITORIA/CORRECAO: rezoneamentos revertidos. READ-ONLY salvo apply:true.
  //   Um cliente foi "revertido" quando o seller_id ATUAL difere do ULTIMO
  //   rezoneamento AUDITADO (customer_change_history.field='sellerId'). Como o
  //   sync por documento (seller-by-doc) grava seller_id sem auditar, essa
  //   divergencia denuncia a reversao. Filtro: o vendedor PRETENDIDO (destino do
  //   ultimo rezoneamento) e' Telemarketing.
  //   body: { apply?, list?, roleFilter? ('telemarketing' default | 'all') }
  //   apply:true -> corrige (seller_id := pretendido) e registra no historico.
  // ============================================================================
  app.post('/api/admin/audit/rezone-reverts', async (req: Request, res: Response) => {
    const b: any = req.body || {};
    const apply = b.apply === true;
    const wantList = b.list === true;
    const roleFilter = (b.roleFilter === 'all') ? 'all' : 'telemarketing';
    const out: any = { apply, roleFilter };
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const dg = (x: any) => String(x || '').replace(/[^0-9]/g, '');
    try {
      // usuarios (nome + role)
      const uR: any = await db.execute(sql.raw("SELECT id, first_name, last_name, role FROM users"));
      const uMap = new Map<string, any>();
      for (const u of (uR.rows || uR) as any[]) uMap.set(String(u.id), { name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || String(u.id), role: u.role });

      // ultimo rezoneamento auditado por cliente (qualquer source de app)
      const lrR: any = await db.execute(sql.raw(`
        SELECT DISTINCT ON (customer_id) customer_id, new_value, old_value, source, created_at
        FROM customer_change_history
        WHERE field = 'sellerId'
        ORDER BY customer_id, created_at DESC`));
      const lastRez = (lrR.rows || lrR) as any[];
      out.clientesComHistoricoSeller = lastRez.length;

      // seller_id atual + doc dos candidatos (em lotes)
      const ids = lastRez.map((r) => String(r.customer_id));
      const curMap = new Map<string, any>();
      const CH = 500;
      for (let i = 0; i < ids.length; i += CH) {
        const chunk = ids.slice(i, i + CH);
        const inList = sql.join(chunk.map((d) => sql`${d}`), sql`, `);
        const r: any = await db.execute(sql`SELECT id, seller_id, cnpj, cpf, name, fantasy_name FROM customers WHERE id IN (${inList})`);
        for (const c of (r.rows || r) as any[]) curMap.set(String(c.id), c);
      }

      // detectar reversoes
      const reverts: any[] = [];
      for (const lr of lastRez) {
        const cid = String(lr.customer_id);
        const cur = curMap.get(cid);
        if (!cur) continue;
        const intended = String(lr.new_value || '');
        const current = String(cur.seller_id || '');
        if (!intended || intended === current) continue; // sem divergencia
        const intUser = uMap.get(intended);
        const curUser = uMap.get(current);
        // filtro: destino pretendido e' telemarketing (a menos que roleFilter='all')
        if (roleFilter === 'telemarketing' && (!intUser || intUser.role !== 'telemarketing')) continue;
        reverts.push({
          id: cid,
          doc: dg(cur.cnpj) || dg(cur.cpf),
          nome: cur.fantasy_name || cur.name,
          pretendidoId: intended, pretendido: intUser?.name || intended, pretendidoRole: intUser?.role || '?',
          atualId: current, atual: curUser?.name || current, atualRole: curUser?.role || '?',
          rezoneadoEm: lr.created_at, source: lr.source,
        });
      }
      out.totalRevertidos = reverts.length;

      // 1.0 (opt-in via check10; consulta pesada e o 1.0/Replit pode estar dormindo -> travava)
      if (b.check10 === true) try {
        await src.connect();
        const s1: any = await src.query("SELECT cnpj, cpf, seller_id FROM customers WHERE seller_id IS NOT NULL AND seller_id <> ''");
        const docToSeller10 = new Map<string, string>();
        for (const r of s1.rows as any[]) { const d = dg(r.cnpj) || dg(r.cpf); if (d && d.length >= 11 && !docToSeller10.has(d)) docToSeller10.set(d, String(r.seller_id)); }
        let batemCom10 = 0;
        for (const rv of reverts) { if (rv.doc && docToSeller10.get(rv.doc) === rv.atualId) { rv.veioDo10 = true; batemCom10++; } else rv.veioDo10 = false; }
        out.atualBateComVendedorDo10 = batemCom10;
      } catch (e: any) { out.err10 = (e?.message || String(e)).slice(0, 120); }

      // resumo por carteira pretendida (telemarketing)
      const porCarteira: Record<string, number> = {};
      for (const rv of reverts) { porCarteira[rv.pretendido] = (porCarteira[rv.pretendido] || 0) + 1; }
      out.porCarteiraPretendida = porCarteira;

      if (wantList) out.rows = reverts;

      // CORRECAO
      if (apply && reverts.length) {
        let ok = 0, fail = 0;
        for (const rv of reverts) {
          try {
            await db.execute(sql`UPDATE customers SET seller_id = ${rv.pretendidoId}, updated_at = now() WHERE id = ${rv.id}`);
            await db.execute(sql`INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source, created_at)
              VALUES (${rv.id}, 'sellerId', 'Vendedor (rezoneamento)', ${rv.atualId}, ${rv.pretendidoId}, 'system', 'Correcao de reversao de rezoneamento', 'bulk', now())`);
            ok++;
          } catch (e) { fail++; }
        }
        out.corrigidos = ok; out.falhas = fail;
      }

      return res.json(out);
    } catch (e: any) { out.err = (e?.message || String(e)).slice(0, 300); return res.status(500).json(out); }
    finally { await src.end().catch(() => {}); }
  });

  // Espelha active_customers do 1.0 no 2.0: upsert das linhas do 1.0 (valores exatos) + desativa extras do 2.0 (reversivel, is_active=false). NAO apaga.
  app.post('/api/admin/sync/active-customers-mirror', async (req: Request, res: Response) => {
    const apply = req.body?.apply === true;
    const pgMod = await import('pg');
    const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect(); await tgt.connect();
      const colQ = "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='active_customers'";
      const [sc, tc] = await Promise.all([src.query(colQ), tgt.query(colQ)]);
      const tgtCols = new Map((tc.rows as any[]).map((r) => [r.column_name, r.udt_name]));
      const cols = (sc.rows as any[]).map((r) => r.column_name).filter((c) => tgtCols.has(c));
      const jsonCols = new Set((tc.rows as any[]).filter((r) => r.udt_name === 'json' || r.udt_name === 'jsonb').map((r) => r.column_name));
      const srcRows = (await src.query('SELECT ' + cols.map((c) => '"' + c + '"').join(',') + ' FROM active_customers')).rows;
      const srcIds = new Set(srcRows.map((r: any) => String(r.id)));
      const tgtIdsRes = await tgt.query('SELECT id::text AS id, is_active FROM active_customers');
      const tgtActiveExtras = (tgtIdsRes.rows as any[]).filter((r) => !srcIds.has(String(r.id)));
      const extrasAtivos = tgtActiveExtras.filter((r) => r.is_active === true || r.is_active === 't').length;
      const result: any = { srcCount: srcRows.length, tgtCount: tgtIdsRes.rows.length, srcOnlyToUpsert: srcRows.length, tgtExtras: tgtActiveExtras.length, tgtExtrasAtivos: extrasAtivos, apply, upserted: 0, deactivated: 0, errors: [] };
      if (apply) {
        const colsSql = cols.map((c) => '"' + c + '"').join(',');
        const setSql = cols.filter((c) => c !== 'id').map((c) => '"' + c + '"=EXCLUDED."' + c + '"').join(',');
        const enc = (row: any) => cols.map((c) => { const v = row[c]; if (v !== null && jsonCols.has(c) && typeof v === 'object') return JSON.stringify(v); return v; });
        for (let i = 0; i < srcRows.length; i += 200) {
          const batch = srcRows.slice(i, i + 200);
          const ph = batch.map((_: any, ri: number) => '(' + cols.map((_: any, ci: number) => '$' + (ri * cols.length + ci + 1)).join(',') + ')').join(',');
          const flat = batch.flatMap((row: any) => enc(row));
          try { await tgt.query('INSERT INTO active_customers (' + colsSql + ') VALUES ' + ph + ' ON CONFLICT ("id") DO UPDATE SET ' + setSql, flat); result.upserted += batch.length; }
          catch (be: any) { for (const row of batch) { try { const rph = cols.map((_: any, k: number) => '$' + (k + 1)).join(','); await tgt.query('INSERT INTO active_customers (' + colsSql + ') VALUES (' + rph + ') ON CONFLICT ("id") DO UPDATE SET ' + setSql, enc(row)); result.upserted++; } catch (re: any) { result.errors.push(String(re.message).slice(0, 80)); } } }
        }
        // desativa extras (reversivel)
        const extraIds = tgtActiveExtras.map((r) => String(r.id));
        for (let i = 0; i < extraIds.length; i += 500) {
          const chunk = extraIds.slice(i, i + 500);
          const ph = chunk.map((_: any, k: number) => '$' + (k + 1)).join(',');
          try { const u: any = await tgt.query('UPDATE active_customers SET is_active=false WHERE id::text IN (' + ph + ') AND is_active=true', chunk); result.deactivated += (u.rowCount || 0); }
          catch (ue: any) { result.errors.push('deact: ' + String(ue.message).slice(0, 80)); }
        }
        const after = await tgt.query('SELECT count(*)::int n, count(*) FILTER (WHERE is_active) AS ativos FROM active_customers');
        result.tgtAfter = after.rows[0];
      }
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: (e?.message || String(e)).slice(0, 200) }); }
    finally { await src.end().catch(() => {}); await tgt.end().catch(() => {}); }
  });

    app.post("/api/admin/financial/reconcile", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const cancelIds: string[] = Array.isArray(req.body?.cancelIds) ? req.body.cancelIds : [];
      const result: any = { cancelled: 0, backfilled: { receivables: 0, payables: 0 }, errors: [] };
      for (const id of cancelIds) {
        try {
          // TRAVA DE BAIXA (Honest): título conciliado não pode ser cancelado/estornado
          // sem desfazer antes a conciliação bancária.
          const cj: any = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM bank_statement_item_matches m WHERE m.receivable_id = ${id}) AS conciliado`);
          if ((cj.rows || cj)?.[0]?.conciliado === true) { result.errors.push("cancel " + id + ": titulo conciliado — desfaca a conciliacao bancaria antes"); continue; }
          await db.execute(sql`UPDATE receivables SET status = 'cancelada', amount_paid = '0.00', updated_at = now() WHERE id = ${id}`); result.cancelled++;
        }
        catch (e: any) { result.errors.push("cancel " + id + ": " + e?.message); }
      }
      const pgMod: any = await import("pg");
      const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await src.connect();
      for (const table of ["receivables", "payables"]) {
        try {
          const colsRes: any = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY ordinal_position`);
          const cols = (colsRes.rows || colsRes).map((r: any) => r.column_name);
          const tgtIdsRes: any = await db.execute(sql.raw(`SELECT id FROM ${table}`));
          const tgtIds = new Set((tgtIdsRes.rows || tgtIdsRes).map((r: any) => r.id));
          const colList = cols.map((c: string) => `"${c}"`).join(", ");
          const srcRows = (await src.query(`SELECT ${colList} FROM ${table}`)).rows;
          const missing = srcRows.filter((r: any) => !tgtIds.has(r.id));
          for (const row of missing) {
            try {
              const idents = cols.map((c: string) => sql.identifier(c));
              const vals = cols.map((c: string) => {
                let v: any = row[c];
                if (v !== null && typeof v === "object" && !(v instanceof Date)) v = JSON.stringify(v);
                return sql`${v}`;
              });
              await db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(idents, sql`, `)}) VALUES (${sql.join(vals, sql`, `)}) ON CONFLICT (id) DO NOTHING`);
              result.backfilled[table]++;
            } catch (e: any) { result.errors.push(table + " ins: " + e?.message); }
          }
        } catch (e: any) { result.errors.push(table + ": " + e?.message); }
      }
      await src.end();
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post("/api/admin/financial/totals", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const pgMod: any = await import("pg");
      const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await src.connect();
      const out: any = {};
      for (const t of ["receivables", "payables"]) {
        const q = `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS amount, COALESCE(SUM(amount_paid),0)::float8 AS paid FROM ${t} GROUP BY status ORDER BY status`;
        const s = await src.query(q);
        const tg: any = await db.execute(sql.raw(q));
        const tgRows = tg.rows || tg;
        const sum = (rows: any[]) => rows.reduce((a, r) => ({ n: a.n + Number(r.n), amount: Math.round((a.amount + Number(r.amount)) * 100) / 100, paid: Math.round((a.paid + Number(r.paid)) * 100) / 100 }), { n: 0, amount: 0, paid: 0 });
        out[t] = { src: { byStatus: s.rows, total: sum(s.rows) }, tgt: { byStatus: tgRows, total: sum(tgRows) } };
      }
      await src.end();
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // ===== Controle do RUNTIME dos Agentes de IA (auto-resposta no ChatCenter) =====
  app.get('/api/admin/agente-runtime', async (_req, res) => {
    try {
      const get = async (k: string, d: string) => { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key=${k} LIMIT 1`); const v = r.rows?.[0]?.value; return v == null ? d : String(v).replace(/^"|"$/g, ''); };
      res.json({ mode: await get('agents_runtime_mode', 'off'), defaultAgent: await get('agents_default', 'sdr'), testNumbers: await get('agents_test_numbers', '5562995782812'), igMode: await get('agents_ig_mode', 'off'), igTestHandles: await get('agents_ig_test_handles', ''), hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/admin/agente-runtime', async (req: any, res) => {
    try {
      const b = req.body || {};
      const setK = async (k: string, v: string) => { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${v}, ${'agent-runtime-admin'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); };
      if (b.mode != null) { if (!['off','test','on'].includes(b.mode)) return res.status(400).json({ error: 'mode invalido' }); await setK('agents_runtime_mode', b.mode); }
      if (b.defaultAgent != null) await setK('agents_default', String(b.defaultAgent));
      if (b.testNumbers != null) await setK('agents_test_numbers', String(b.testNumbers));
      if (b.igMode != null) { if (!['off','test','on'].includes(b.igMode)) return res.status(400).json({ error: 'igMode invalido' }); await setK('agents_ig_mode', b.igMode); }
      if (b.igTestHandles != null) await setK('agents_ig_test_handles', String(b.igTestHandles));
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // Testar um agente SEM enviar WhatsApp (retorna a resposta gerada)
  app.post('/api/admin/agente-test', async (req: any, res) => {
    try {
      const { agentId, message, phone, documento, withTools } = req.body || {};
      if (!agentId || !message) return res.status(400).json({ error: 'agentId e message obrigatorios' });
      const { generateAgentReply } = await import('./agent-runtime');
      // ctx habilita as ferramentas; resolve cliente por documento/telefone se informado
      let ctx: any = undefined;
      if (withTools || phone || documento) {
        let customerId: string | null = null;
        try {
          if (documento) { const d = String(documento).replace(/\D/g, ''); const r1: any = await db.execute(sql`SELECT id FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=${d} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')=${d} LIMIT 1`); customerId = r1.rows?.[0]?.id || null; }
          if (!customerId && phone) { const d = String(phone).replace(/\D/g, ''); const r2: any = await db.execute(sql`SELECT id FROM customers WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE ${'%' + d.slice(-8)} LIMIT 1`); customerId = r2.rows?.[0]?.id || null; }
        } catch {}
        ctx = { conversationId: null, customerId, phone: phone || null };
      }
      const r = await generateAgentReply(String(agentId), [{ role: 'user', content: String(message) }], ctx);
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ===== Sincronizar VISITAS PLANEJADAS (visit_agenda) FUTURAS do 1.0 -> 2.0 (corrige rota do dia) =====
  // A rota do dia usa o visit_agenda; o do 2.0 está incompleto p/ datas futuras. dryRun por padrao; {apply:true} insere.
  app.post('/api/admin/sync/visit-agenda', async (req: any, res) => {
    if (!process.env.REPLIT_DATABASE_URL) return res.status(400).json({ error: '1.0 nao configurado' });
    const apply = req.body?.apply === true;
    const days = Math.min(Number(req.body?.days) || 90, 180);
    const pgMod: any = await import('pg');
    const Client = pgMod.Client || pgMod.default?.Client;
    const src = new Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      const until = new Date(Date.now() + days * 86400000).toISOString();
      const r1 = await src.query(`
        SELECT id, customer_id, seller_id, scheduled_date, route_day, recurrence_type,
               COALESCE(is_virtual,false) AS is_virtual, COALESCE(visit_status,'pending') AS visit_status,
               customer_name, sales_card_id, customer_latitude, customer_longitude, customer_address
        FROM visit_agenda
        WHERE scheduled_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AND scheduled_date <= $1`, [until]);
      const srcRows = r1.rows;
      // ids ja existentes no 2.0
      const idset = new Set<string>();
      const cur: any = await db.execute(sql`SELECT id FROM visit_agenda WHERE scheduled_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
      for (const x of (cur.rows || [])) idset.add(x.id);
      let inserted = 0, skipped = 0, failed = 0;
      if (apply) {
        for (const r of srcRows) {
          if (idset.has(r.id)) { skipped++; continue; }
          try {
            await db.execute(sql`INSERT INTO visit_agenda
              (id, customer_id, seller_id, scheduled_date, route_day, recurrence_type, is_virtual, visit_status, customer_name, sales_card_id, customer_latitude, customer_longitude, customer_address)
              VALUES (${r.id}, ${r.customer_id}, ${r.seller_id}, ${r.scheduled_date}, ${r.route_day || 'segunda'}, ${r.recurrence_type || 'semanal'}, ${r.is_virtual}, ${r.visit_status}, ${r.customer_name || 'Cliente'}, ${r.sales_card_id}, ${r.customer_latitude}, ${r.customer_longitude}, ${r.customer_address})
              ON CONFLICT (id) DO NOTHING`);
            inserted++;
          } catch { failed++; }
        }
      }
      // PRUNE: remover do 2.0 as visit_agenda FUTURAS pending/scheduled que NAO existem no 1.0
      // (excesso que empurra clientes p/ fora da "janela das proximas 3 visitas" e diverge a rota).
      let pruned = 0;
      if (req.body?.prune === true) {
        const srcIds = new Set<string>(srcRows.map((x: any) => x.id));
        const tgt: any = await db.execute(sql`SELECT id FROM visit_agenda WHERE scheduled_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AND visit_status IN ('pending','scheduled')`);
        const toDelete = (tgt.rows || []).map((x: any) => x.id).filter((id: string) => !srcIds.has(id));
        for (const id of toDelete) {
          try { await db.execute(sql`DELETE FROM visit_agenda WHERE id = ${id}`); pruned++; } catch {}
        }
      }
      res.json({ srcFuturas: srcRows.length, tgtFuturasAntes: idset.size, applied: apply, inserted, skipped, failed, pruned });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
    finally { try { await src.end(); } catch {} }
  });

  // ===== Sincronizar ULTIMA VISITA do 1.0 -> 2.0 (customers.last_sale_date) p/ rota por periodicidade =====
  // Lê o MAX(completed/scheduled) dos sales_cards concluidos do 1.0 por cliente e grava em customers.last_sale_date no 2.0.
  // dryRun por padrao; {apply:true} aplica.
  app.post('/api/admin/sync/last-visit', async (req: any, res) => {
    if (!process.env.REPLIT_DATABASE_URL) return res.status(400).json({ error: '1.0 nao configurado' });
    const apply = req.body?.apply === true;
    const pgMod: any = await import('pg');
    const Client = pgMod.Client || pgMod.default?.Client;
    const src = new Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      const r1 = await src.query(`
        SELECT customer_id, MAX(COALESCE(completed_date, scheduled_date)) AS last_visit
        FROM sales_cards
        WHERE status IN ('completed','invoiced') AND customer_id IS NOT NULL
        GROUP BY customer_id`);
      const map = new Map<string, string>();
      for (const row of r1.rows) if (row.last_visit) map.set(row.customer_id, new Date(row.last_visit).toISOString());
      let updated = 0, failed = 0;
      if (apply) {
        for (const [cid, dt] of map.entries()) {
          try { await db.execute(sql`UPDATE customers SET last_sale_date = ${dt} WHERE id = ${cid}`); updated++; }
          catch { failed++; }
        }
      }
      res.json({ srcCustomersWithVisit: map.size, applied: apply, updated, failed });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
    finally { try { await src.end(); } catch {} }
  });

  // ===== Sincronizar COORDENADAS do 1.0 (Neon) -> 2.0 (corrige rotas do dia) =====
  // dryRun por padrao (quantifica). {apply:true} aplica. {onlyNull:true} só preenche nulos (nao mexe nos divergentes).
  app.post('/api/admin/sync/coordinates', async (req: any, res) => {
    if (!process.env.REPLIT_DATABASE_URL) return res.status(400).json({ error: '1.0 (REPLIT_DATABASE_URL) nao configurado' });
    const apply = req.body?.apply === true;
    const onlyNull = req.body?.onlyNull === true;
    const pgMod: any = await import('pg');
    const Client = pgMod.Client || pgMod.default?.Client;
    const src = new Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await src.connect();
      const r1 = await src.query("SELECT id, latitude, longitude FROM customers WHERE latitude IS NOT NULL AND longitude IS NOT NULL");
      const map = new Map<string, { lat: string; lng: string }>();
      for (const row of r1.rows) map.set(row.id, { lat: String(row.latitude), lng: String(row.longitude) });
      const r2: any = await db.execute(sql`SELECT id, latitude, longitude FROM customers`);
      let missing = 0, differ = 0, updated = 0, failed = 0;
      const toUpdate: Array<{ id: string; lat: string; lng: string }> = [];
      for (const row of (r2.rows || [])) {
        const sc = map.get(row.id);
        if (!sc) continue;
        const has = row.latitude != null && row.longitude != null && Number(row.latitude) !== 0 && Number(row.longitude) !== 0;
        const same = has && Math.abs(Number(row.latitude) - Number(sc.lat)) < 1e-5 && Math.abs(Number(row.longitude) - Number(sc.lng)) < 1e-5;
        if (!has) { missing++; toUpdate.push({ id: row.id, ...sc }); }
        else if (!same) { differ++; if (!onlyNull) toUpdate.push({ id: row.id, ...sc }); }
      }
      if (apply) {
        for (const u of toUpdate) {
          try { await db.execute(sql`UPDATE customers SET latitude = ${u.lat}, longitude = ${u.lng} WHERE id = ${u.id}`); updated++; }
          catch { failed++; }
        }
      }
      res.json({ srcWithCoords: map.size, tgtTotal: (r2.rows || []).length, missingInTgt: missing, differ, toUpdate: toUpdate.length, applied: apply, onlyNull, updated, failed });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
    finally { try { await src.end(); } catch {} }
  });

  // ============ Visualizacao read-only de tabelas SINCRONIZADAS (paridade de telas 2.0 x 1.0) ============
  // Serve dados crus das tabelas sincronizadas do 1.0 que ainda nao tem schema drizzle/endpoint proprio.
  // Whitelist + read-only + introspeccao de colunas (information_schema). Garante FIDELIDADE ao dado.
  const SYNCED_VIEW_TABLES = new Set([
    'price_tables','price_table_items','coupons','coupon_redemptions','suppliers',
    'recovery_charges','recovery_invoices','recovery_orders','recovery_uploads',
    'bank_statements','bank_statement_items','bank_statement_item_matches','reconciliation_patterns',
    'communication_automations','communication_automation_logs','message_history','message_templates',
    'raw_materials','raw_material_movements','recipes','recipe_items','production_orders','production_order_items',
    'saved_reports','cielo_credentials','cielo_pix_charges','cielo_card_authorizations','cielo_reconciliation_records',
    'boleto_charges','pix_charges','receivable_events','category_mappings','personal_agenda_items','repescagem_assignments','repescagem_attendants','visit_agenda'
  ]);
  app.get('/api/synced-table/:name', async (req, res) => {
    const name = String(req.params.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!SYNCED_VIEW_TABLES.has(name)) return res.status(400).json({ error: 'tabela nao permitida', table: name });
    try {
      const cols: any = await db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ${name} ORDER BY ordinal_position`);
      if (!cols.rows || cols.rows.length === 0) return res.status(404).json({ error: 'tabela inexistente', table: name });
      const limit = Math.min(Number(req.query.limit) || 2000, 5000);
      const cnt: any = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM "${name}"`));
      const rows: any = await db.execute(sql.raw(`SELECT * FROM "${name}" LIMIT ${limit}`));
      res.json({ table: name, total: cnt.rows?.[0]?.n ?? null, columns: cols.rows, rows: rows.rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e), table: name }); }
  });

  // Garante a coluna icms_csosn em customers (CSOSN por cliente p/ NF-e Simples: '101'/'102', default '102'). Idempotente.
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS icms_csosn varchar DEFAULT '102'`).catch(() => {});
  db.execute(sql`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS channel_phone varchar`).catch(() => {});
  // Flag Fornecedor: cadastro que nao e cliente -> nao entra em rota/agenda de visitas. Idempotente.
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_supplier boolean DEFAULT false`).catch(() => {});
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS collection_discount numeric DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_installments integer DEFAULT 1`).catch(() => {});
  // ==========================================================================
  // INSTRUMENTACAO: toda mudanca de reconciliation_status fica registrada.
  //
  // Em 06/08 apareceram 55 lancamentos com vinculo e baixa intactos constando
  // como PENDENTES. Descartamos restauracao de backup (trilha de auditoria sem
  // buraco), cron (nenhum toca a tabela), drizzle push (a tabela nao esta no
  // schema) e sync do 1.0 (nao esta em SYNC_TABLES) — e mesmo assim nao deu para
  // provar QUEM desconciliou: o rastro que sobrou (matched_by nulo) nao bate com
  // nenhum caminho do codigo atual.
  //
  // O log fica no BANCO, por TRIGGER, e nao na aplicacao, de proposito: assim ele
  // pega tambem UPDATE feito por fora do sistema (console, script, migracao) —
  // justamente a hipotese que nao conseguimos descartar. Grava o usuario do banco,
  // o application_name e o IP do cliente, que e o que identifica a origem.
  // Idempotente: pode rodar em todo boot.
  // ==========================================================================
  db.execute(sql`CREATE TABLE IF NOT EXISTS bank_statement_item_status_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_statement_item_id varchar NOT NULL,
    status_de varchar, status_para varchar,
    matched_by_de varchar, matched_by_para varchar,
    mirror_de varchar, mirror_para varchar,
    changed_at timestamp DEFAULT now(),
    db_user text, app_name text, client_addr text
  )`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bsi_status_log_item ON bank_statement_item_status_log (bank_statement_item_id)`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bsi_status_log_at ON bank_statement_item_status_log (changed_at DESC)`).catch(() => {});
  db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION log_bsi_status_change() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.reconciliation_status IS DISTINCT FROM OLD.reconciliation_status
         OR NEW.mirror_of IS DISTINCT FROM OLD.mirror_of THEN
        INSERT INTO bank_statement_item_status_log
          (bank_statement_item_id, status_de, status_para, matched_by_de, matched_by_para,
           mirror_de, mirror_para, changed_at, db_user, app_name, client_addr)
        VALUES
          (OLD.id, OLD.reconciliation_status, NEW.reconciliation_status,
           OLD.matched_by, NEW.matched_by, OLD.mirror_of, NEW.mirror_of, now(),
           current_user, current_setting('application_name', true),
           COALESCE(host(inet_client_addr()), 'local'));
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;`)).catch((e: any) => console.warn('[instrumentacao] funcao:', e?.message));
  db.execute(sql.raw(`DROP TRIGGER IF EXISTS trg_bsi_status_change ON bank_statement_items`)).catch(() => {});
  db.execute(sql.raw(`
    CREATE TRIGGER trg_bsi_status_change AFTER UPDATE ON bank_statement_items
    FOR EACH ROW EXECUTE FUNCTION log_bsi_status_change()`)).catch((e: any) => console.warn('[instrumentacao] trigger:', e?.message));

  // created_at das tabelas de extrato parou de ser gravado em 21/07/2026: dos
  // 24.081 lancamentos, so 14.053 tem data. O INSERT da ingestao monta as colunas
  // por introspeccao e nao inclui created_at — sem DEFAULT, entra NULL. Isso nao
  // apaga conciliacao, mas cega qualquer investigacao por data (foi o que
  // atrapalhou a apuracao de 06/08). Restaura o DEFAULT; o passado fica como esta,
  // porque nao ha como inventar a data de quem entrou sem ela.
  db.execute(sql`ALTER TABLE bank_statement_items ALTER COLUMN created_at SET DEFAULT now()`).catch(() => {});
  db.execute(sql`ALTER TABLE bank_statements ALTER COLUMN created_at SET DEFAULT now()`).catch(() => {});

  // DESCONTO na baixa (04/08/2026). As colunas estao no shared/schema.ts, mas o
  // `drizzle-kit push` do deploy NAO as criou — e sem elas TODA baixa manual quebra,
  // porque o insert do pagamento passou a mandar `discount`. Estes ALTER garantem a
  // coluna no boot, sao idempotentes e nao dependem do push.
  db.execute(sql`ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS discount numeric(12,2) DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS discount numeric(12,2) DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE receivables ADD COLUMN IF NOT EXISTS original_amount numeric(12,2)`).catch(() => {});
  db.execute(sql`ALTER TABLE payables ADD COLUMN IF NOT EXISTS original_amount numeric(12,2)`).catch(() => {});
  // MULTA e JUROS na baixa (05/08/2026). Mesma licao do desconto: declarar no
  // shared/schema.ts NAO basta (o `drizzle-kit push` do deploy nao criou as de
  // desconto) e sem as colunas TODA baixa manual quebraria, porque o insert do
  // pagamento passa a mandar `fine`/`interest`. Idempotentes.
  db.execute(sql`ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS fine numeric(12,2) DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE receivable_payments ADD COLUMN IF NOT EXISTS interest numeric(12,2) DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS fine numeric(12,2) DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS interest numeric(12,2) DEFAULT 0`).catch(() => {});
  // Colunas de estorno de payable_payments: existiam so via ALTER dentro do
  // endpoint de estorno; agora estao no schema, mas o push pode nao cria-las.
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS deleted_at timestamp`).catch(() => {});
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS deleted_by varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS deleted_reason text`).catch(() => {});
  // Importacao do historico de NF-e do Omie: marcadores de origem/lote (dedup por access_key).
  db.execute(sql`ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS import_origin varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE fiscal_invoices ADD COLUMN IF NOT EXISTS import_batch_id varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE fiscal_invoice_items ADD COLUMN IF NOT EXISTS import_origin varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE fiscal_invoice_items ADD COLUMN IF NOT EXISTS import_batch_id varchar`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fiscal_invoices_import_batch ON fiscal_invoices(import_batch_id)`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fii_import_batch ON fiscal_invoice_items(import_batch_id)`).catch(() => {});
  // Condição de pagamento por cliente (editada em Clientes Ativos): forma + prazo do boleto.
  // Sem estas colunas o salvamento da "Forma de Pagamento" não persistia. Idempotente.
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_method varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS boleto_days integer DEFAULT 7`).catch(() => {});
  // FIX (08/jul): sales_cards tambem tem collection_discount/payment_installments no schema drizzle (l.486/487) -> criar no banco p/ nao quebrar SELECT/RETURNING de sales_cards. Idempotente.
  db.execute(sql`ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS collection_discount numeric DEFAULT 0`).catch(() => {});
  db.execute(sql`ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS payment_installments integer DEFAULT 1`).catch(() => {});
  db.execute(sql`ALTER TABLE digital_certificates ADD COLUMN IF NOT EXISTS pfx_data varchar`).catch(() => {});
  db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar`).catch(() => {});
  // FASE 1a — trilha de auditoria financeira: cria financial_audit_log + colunas updated_by/deleted_by/deleted_at (aditivo, idempotente).
  ensureFinancialAuditSchema().catch(() => {});
  db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS state_registration varchar`).catch(() => {});
  // Ajuste admin de check-in/out na Rota do Dia (marca card roxo + tag "Adm - email"). Mapa por customerId.
  db.execute(sql`ALTER TABLE daily_routes ADD COLUMN IF NOT EXISTS admin_adjustments jsonb DEFAULT '{}'::jsonb`).catch(() => {});
  // Agendamento de pedidos: data para a qual o pedido foi agendado (etapa 'agendado' do pipeline) + valor de enum. Idempotente.
  db.execute(sql`ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS scheduled_billing_date timestamp`).catch(() => {});

  // Meta Desafio (igual ao Integra 1.0): faturamento alvo + bônus por bater.
  db.execute(sql`ALTER TABLE sales_goals ADD COLUMN IF NOT EXISTS challenge_goal numeric(12,2)`).catch(() => {});
  db.execute(sql`ALTER TABLE sales_goals ADD COLUMN IF NOT EXISTS challenge_bonus numeric(12,2)`).catch(() => {});
  db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'agendado'`).catch(() => {});
  // Etapas geográficas do funil (colunas BSB / Ag. Rota BSB / Outras Cidades). Idempotente.
  db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'bsb'`).catch(() => {});
  db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'aguardando_rota_bsb'`).catch(() => {});
  db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'outras_cidades'`).catch(() => {});
  // Etapa "Em Rota BSB": mesmo comportamento de "em_rota", separa as entregas de Brasília (motorista BARUC). Idempotente.
  db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'em_rota_bsb'`).catch(() => {});
  // Tipo de operacao Transferencia entre filiais (NF de transferencia). Idempotente.
  db.execute(sql`ALTER TYPE operation_type ADD VALUE IF NOT EXISTS 'transferencia'`).catch(() => {});
  // Boleto UNIFICADO: liga um boleto a varios titulos (contas a receber). Quando o
  // boleto e pago, TODOS os titulos ligados sao baixados. Idempotente.
  db.execute(sql`CREATE TABLE IF NOT EXISTS boleto_charge_receivables (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), boleto_charge_id varchar NOT NULL, receivable_id varchar NOT NULL, amount numeric(12,2) NOT NULL DEFAULT 0, created_at timestamp DEFAULT now(), CONSTRAINT uq_bcr UNIQUE (boleto_charge_id, receivable_id))`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bcr_receivable ON boleto_charge_receivables (receivable_id)`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_bcr_boleto ON boleto_charge_receivables (boleto_charge_id)`).catch(() => {});
  // Anexos (DANFE/boleto) de contas a pagar — armazenados no banco (base64) para
  // durabilidade no Railway (disco efemero). Idempotente.
  db.execute(sql`CREATE TABLE IF NOT EXISTS payable_attachments (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), payable_id varchar NOT NULL, kind varchar NOT NULL DEFAULT 'outro', file_name varchar NOT NULL, mime_type varchar, size_bytes integer, content_base64 text NOT NULL, created_by varchar, created_at timestamp DEFAULT now())`).catch(() => {});
  db.execute(sql`CREATE INDEX IF NOT EXISTS idx_payable_attachments_payable ON payable_attachments (payable_id)`).catch(() => {});
  // Comprovante de entrega anexado às contas a receber (foto do entregador no
  // check-in). A imagem fica em photo_media; aqui guardamos o vínculo com o título.
  import('./deliveryPipelineSync')
    .then((m) => m.ensureReceivableAttachmentsTable())
    .then(() => console.log('✅ [BOOT] receivable_attachments pronta (comprovantes de entrega)'))
    .catch((e: any) => console.warn('[BOOT] Falha ao garantir receivable_attachments:', e?.message));
  // Object storage durável no banco (mídia WhatsApp/anexos). Evita perda no disco
  // efemero do Railway. Se UPLOAD_DIR (volume) estiver setado, usa disco no lugar. Idempotente.
  db.execute(sql`CREATE TABLE IF NOT EXISTS stored_objects (id varchar PRIMARY KEY, mime_type varchar, size_bytes integer, content_base64 text NOT NULL, created_at timestamp DEFAULT now())`).catch(() => {});

  // Trilha imutavel de pedidos -> pipeline (rede de seguranca: nenhum pedido pode desaparecer). Idempotente.
  db.execute(sql`CREATE TABLE IF NOT EXISTS order_pipeline_audit (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_card_id varchar,
    outcome varchar,
    error text,
    created_at timestamp DEFAULT now()
  )`).catch(() => {});

  // ===== BOLETO BB (Cobranca v2) — emissao/diagnostico. Default HOMOLOGACAO. =====
  // Para producao: env BB_BOLETO_SANDBOX=false. Conta financeira precisa de
  // bbBoletoEnabled + bbConvenio + bbClientId/bbClientSecret/bbDevAppKey.
  app.get("/api/admin/boleto/status", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req, res) => {
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

  app.post("/api/admin/boleto/test-connection", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const accountId = (req.body || {}).accountId;
      if (!accountId) return res.status(400).json({ error: "accountId obrigatorio" });
      res.json(await testarConexaoBoleto(accountId));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Resolve os dados do pagador a partir do recebivel + cliente.
  async function boletoParamsFromReceivable(receivableId: string): Promise<any | null> {
    const rec: any = await db.execute(sql`
      SELECT r.id, r.amount, COALESCE(r.amount_paid,0) AS amount_paid, r.status,
             r.due_date, r.customer_id, r.customer_name, r.customer_document,
             r.fiscal_invoice_id, r.billing_pipeline_id, r.omie_instance_id,
             c.address, c.city, c.neighborhood, c.state, c.zip_code, c.cpf, c.cnpj, c.name AS c_name,
             c.collection_discount
      FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ${receivableId} AND r.deleted_at IS NULL LIMIT 1`);
    const row = rec.rows?.[0];
    if (!row) return null;
    // FIX: emitia boleto pelo valor CHEIO do titulo. Titulo de R$ 1.000 com R$ 400 ja
    // pagos gerava cobranca de R$ 1.000 — o cliente era cobrado de novo pelo que ja
    // quitou. Agora cobra o SALDO, e recusa emitir para titulo quitado/cancelado.
    const _saldo = parseFloat(row.amount) - parseFloat(row.amount_paid || '0');
    if (String(row.status) === 'recebida' || String(row.status) === 'cancelada' || _saldo <= 0.005) {
      console.warn(`[BOLETO] emissao recusada para ${receivableId}: status=${row.status} saldo=${_saldo.toFixed(2)}`);
      return null;
    }
    return {
      omieInstanceId: row.omie_instance_id,
      params: {
        amount: _saldo,
        dueDate: row.due_date ? new Date(row.due_date) : new Date(Date.now() + 30 * 864e5),
        debtorName: row.customer_name || row.c_name || "Cliente",
        debtorDocument: row.customer_document || row.cnpj || row.cpf || "",
        debtorAddress: row.address, debtorCity: row.city, debtorNeighborhood: row.neighborhood,
        debtorState: row.state, debtorZip: row.zip_code,
        receivableId: row.id, fiscalInvoiceId: row.fiscal_invoice_id,
        customerId: row.customer_id, billingPipelineId: row.billing_pipeline_id,
        descontoPct: parseFloat(String(row.collection_discount ?? '0')) || 0,
      },
    };
  }

  // Registra boleto por receivableId (puxa dados) OU por params crus.
  app.post("/api/admin/boleto/registrar", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
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
  app.post("/api/webhooks/bb-boleto", webhookTokenGuard, async (req, res) => {
    try {
      const payload = req.body || {};
      try { await db.execute(sql`INSERT INTO webhook_debug_log (raw_remote_jid, payload, created_at) VALUES (${'BB-BOLETO'}, ${JSON.stringify(payload)}, now())`); } catch {}
      const out = await processBoletoWebhook(payload);
      res.status(200).json({ ok: true, ...out });
    } catch (e: any) { res.status(200).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Verifica pagamento de um boleto via consulta BB e da baixa (fallback/teste/cron).
  // Batch (cron-friendly, GET): dispara em 2o plano a varredura de boletos em aberto e baixa os pagos.
  app.get("/api/admin/boleto/check-open", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const limit = Math.min(parseInt(String((req.query as any).limit || "300"), 10) || 300, 2000);
      const days = parseInt(String((req.query as any).days || "120"), 10) || 120;
      // FASE 1c - a varredura roda no agendador interno; aqui apenas dispara sob demanda.
      void sweepOpenBoletos(limit, days);
      res.json({ ok: true, started: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Le o resumo da ultima varredura check-open (gravado em system_settings).
  app.get("/api/admin/boleto/check-open/last", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'boleto_check_open_last' LIMIT 1`);
      const v = r.rows?.[0]?.value;
      res.json(v ? (typeof v === 'string' ? JSON.parse(v) : v) : { none: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/admin/boleto/check-payment", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const id = (req.body || {}).boletoChargeId;
      if (!id) return res.status(400).json({ error: "boletoChargeId obrigatorio" });
      res.json(await checkAndSettleBoleto(id));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Cria e vincula um recebivel a um boleto avulso (para aparecer/baixar no Contas a Receber).
  app.post("/api/admin/boleto/ensure-receivable", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
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
  app.post("/api/admin/pix/cert", authenticateUser, requireRole(['admin']), async (req, res) => {
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
  app.get("/api/admin/fiscal/audit", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req, res) => {
    const invSql = `
      SELECT omie_instance_id, issuer_cnpj, series, environment,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE (status = 'authorized' OR lower(coalesce(status,'')) LIKE '%autoriz%'))::int AS n_autorizadas,
             MAX(invoice_number) FILTER (WHERE (status = 'authorized' OR lower(coalesce(status,'')) LIKE '%autoriz%')) AS max_autorizada,
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
        // distribuicao real de status (p/ identificar o valor de "autorizada")
        try {
          const st = await c.query("SELECT environment, status, COUNT(*)::int AS n FROM fiscal_invoices WHERE invoice_number IS NOT NULL GROUP BY environment, status ORDER BY n DESC");
          out.status_dist_1_0 = st.rows;
        } catch (e: any) { out.statusErr1 = e?.message; }
        // codigos fiscais REALMENTE emitidos por CNPJ (verdade de campo do que o SEFAZ aceitou)
        try {
          const it = await c.query(`
            SELECT fi.issuer_cnpj, fi.uf AS issuer_uf, ii.cfop,
                   ii.csosn, ii.cst_icms, ii.cst_pis, ii.cst_cofins,
                   COUNT(*)::int AS n,
                   MAX(fi.invoice_number) AS max_nf
            FROM fiscal_invoice_items ii
            JOIN fiscal_invoices fi ON fi.id = ii.invoice_id
            WHERE fi.environment = 'producao'
            GROUP BY fi.issuer_cnpj, fi.uf, ii.cfop, ii.csosn, ii.cst_icms, ii.cst_pis, ii.cst_cofins
            ORDER BY fi.issuer_cnpj, n DESC`);
          out.items_by_cnpj_1_0 = it.rows;
        } catch (e: any) {
          out.itemsErr1 = e?.message;
          // fallback sem fi.uf caso a coluna nao exista
          try {
            const it2 = await c.query(`
              SELECT fi.issuer_cnpj, ii.cfop, ii.csosn, ii.cst_icms, ii.cst_pis, ii.cst_cofins,
                     COUNT(*)::int AS n, MAX(fi.invoice_number) AS max_nf
              FROM fiscal_invoice_items ii JOIN fiscal_invoices fi ON fi.id = ii.invoice_id
              WHERE fi.environment = 'producao'
              GROUP BY fi.issuer_cnpj, ii.cfop, ii.csosn, ii.cst_icms, ii.cst_pis, ii.cst_cofins
              ORDER BY fi.issuer_cnpj, n DESC`);
            out.items_by_cnpj_1_0 = it2.rows;
          } catch (e2: any) { out.itemsErr1b = e2?.message; }
        }
      } catch (e: any) { out.srcErr = e?.message; } finally { try { await c.end(); } catch {} }
    } else out.srcErr = "REPLIT_DATABASE_URL nao definido";
    res.json(out);
  });

  app.get("/api/admin/pix/cert-upload", authenticateUser, requireRole(['admin']), async (_req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><html lang=pt-br><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Upload Certificado PIX (.p12)</title><style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111}.card{max-width:520px;margin:24px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 6px}.muted{color:#666;font-size:13px;margin-bottom:14px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px}button{margin-top:16px;background:#059669;color:#fff;border:0;border-radius:8px;padding:11px 16px;font-size:14px;cursor:pointer}button:disabled{opacity:.6}#out{margin-top:14px;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:12px;background:#f3f4f6;border-radius:8px;padding:10px;display:none}.ok{color:#065f46}.err{color:#991b1b}</style></head><body><div class=card><h1>Certificado mTLS do PIX (Banco do Brasil)</h1><div class=muted>Selecione o arquivo <b>.p12 / .pfx</b> e informe a senha. O certificado é convertido em base64 no navegador e salvo de forma segura no servidor (usado para autenticar a API de PIX). Nada é exibido aqui.</div><label>Arquivo do certificado (.p12 / .pfx)</label><input type=file id=file accept=".p12,.pfx,application/x-pkcs12"><label>Senha do certificado</label><input type=password id=pass placeholder="senha do .p12 (deixe vazio se nao tiver)"><button id=btn onclick="up()">Enviar certificado</button><div id=out></div></div><script>
function show(msg,ok){var o=document.getElementById('out');o.style.display='block';o.className=ok?'ok':'err';o.textContent=msg;}
function up(){var f=document.getElementById('file').files[0];if(!f){show('Selecione o arquivo .p12',false);return;}var btn=document.getElementById('btn');btn.disabled=true;btn.textContent='Enviando...';var r=new FileReader();r.onload=function(){try{var bytes=new Uint8Array(r.result);var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);var b64=btoa(bin);fetch('/api/admin/pix/cert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pfxBase64:b64,password:document.getElementById('pass').value})}).then(function(x){return x.json();}).then(function(j){btn.disabled=false;btn.textContent='Enviar certificado';if(j.ok){show('Certificado salvo com sucesso ('+j.savedBytes+' bytes, senha: '+(j.hasPassword?'sim':'nao')+'). Agora avise o Claude para validar a emissao de PIX.',true);}else{show('Erro: '+(j.error||JSON.stringify(j)),false);}}).catch(function(e){btn.disabled=false;btn.textContent='Enviar certificado';show('Erro de rede: '+e.message,false);});}catch(e){btn.disabled=false;btn.textContent='Enviar certificado';show('Erro: '+e.message,false);}};r.onerror=function(){btn.disabled=false;btn.textContent='Enviar certificado';show('Falha ao ler o arquivo',false);};r.readAsArrayBuffer(f);}
</script></body></html>`);
  });

  app.get("/api/financial/receivables/:id/cobranca", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing']), async (req, res) => {
    try {
      const id = req.params.id;
      const ymd = (d: any) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; } };
      const rq: any = await db.execute(sql`SELECT due_date, customer_name, amount FROM receivables WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`);
      const recDue = rq.rows?.[0]?.due_date || null;
      const customerName = rq.rows?.[0]?.customer_name || null;
      const amount = rq.rows?.[0]?.amount || null;
      const b: any = await db.execute(sql`SELECT to_jsonb(bc) AS row, bc.id, bc.status, bc.data_vencimento, (SELECT COUNT(*) FROM boleto_charge_receivables jr2 WHERE jr2.boleto_charge_id = bc.id)::int AS combined_count FROM boleto_charges bc WHERE (bc.receivable_id = ${id} OR bc.id IN (SELECT boleto_charge_id FROM boleto_charge_receivables WHERE receivable_id = ${id})) AND bc.status <> 'cancelado' AND bc.status <> 'cancelada' ORDER BY bc.created_at DESC LIMIT 1`);
      if (b.rows?.[0]) { const bc = b.rows[0]; const changed = !!(recDue && bc.data_vencimento && ymd(recDue) !== ymd(bc.data_vencimento)); return res.json({ hasCharge: true, type: "boleto", id: bc.id, status: bc.status, viewUrl: `/api/boleto-view/${bc.id}`, chargeDueDate: bc.data_vencimento, receivableDueDate: recDue, dueDateChanged: changed, customerName, amount, boleto: bc.row, combined: Number(bc.combined_count || 0) > 1, combinedCount: Number(bc.combined_count || 0) }); }
      const p: any = await db.execute(sql`SELECT to_jsonb(pc) AS row, pc.id, pc.status, pc.due_date FROM pix_charges pc WHERE pc.receivable_id = ${id} AND pc.status NOT IN ('REMOVIDA_PELO_USUARIO_RECEBEDOR','REMOVIDA_PELO_PSP') ORDER BY pc.created_at DESC LIMIT 1`);
      if (p.rows?.[0]) { const pc = p.rows[0]; const changed = !!(recDue && pc.due_date && ymd(recDue) !== ymd(pc.due_date)); return res.json({ hasCharge: true, type: "pix", id: pc.id, status: pc.status, viewUrl: `/api/pix-view/${pc.id}`, chargeDueDate: pc.due_date, receivableDueDate: recDue, dueDateChanged: changed, customerName, amount, pix: pc.row }); }
      res.json({ hasCharge: false });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Gera NOVA cobranca (boleto hibrido) com o vencimento ATUAL do recebivel, CANCELANDO a anterior no BB.
  // Uso: apos alterar a data de vencimento de um recebivel que ja tem cobranca.
  app.post("/api/financial/receivables/:id/regenerate-charge", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const recId = req.params.id;
      const resolved = await boletoParamsFromReceivable(recId);
      if (!resolved) return res.status(404).json({ error: "recebivel nao encontrado" });
      const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL ORDER BY (omie_instance_id = ${resolved.omieInstanceId}) DESC NULLS LAST LIMIT 1`);
      const accId = accq.rows?.[0]?.id;
      if (!accId) return res.status(422).json({ error: "nenhuma conta com boleto BB habilitado" });

      // Cobranca ativa atual (boleto tem prioridade).
      const bq: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${recId} AND status <> 'cancelado' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
      const boleto = bq.rows?.[0];
      let canceladoAnterior = false;
      if (boleto) {
        if (/(liquid|pag|receb)/i.test(String(boleto.status || ''))) return res.status(409).json({ error: "Boleto anterior ja liquidado — nao e possivel regerar." });
        const cancel = await cancelarBoleto(accId, boleto);
        if (!cancel.ok) return res.status(422).json({ error: "Falha ao cancelar o boleto anterior no BB: " + (cancel.error || "") });
        await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado' WHERE id = ${boleto.id}`);
        canceladoAnterior = true;
      } else {
        // PIX ativo: marca cancelado no sistema (cob PIX expira; baixa no BB e follow-up).
        const upd: any = await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR' WHERE receivable_id = ${recId} AND status = 'ATIVA'`);
        canceladoAnterior = ((upd?.rowCount ?? 0) as number) > 0;
      }

      const result: any = await registrarBoleto(accId, resolved.params);
      if (result.success && result.boletoChargeId) result.viewUrl = `/api/boleto-view/${result.boletoChargeId}`;
      return res.status(result.success ? 200 : 422).json({ ...result, canceladoAnterior });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Cancela a cobranca ATIVA de um recebivel (baixa o boleto no BB / remove o PIX), SEM recriar.
  // Uso: limpeza de cobrancas de NF-e devolvidas/rejeitadas (multiplicidade de faturamento).
  // Nao toca em boleto ja liquidado/pago (protecao contra estorno indevido).
  app.post("/api/financial/receivables/:id/cancel-charge", authenticateUser, requireRole(['admin']), async (req, res) => {
    try {
      const recId = req.params.id;
      const out: any = { boletosCancelados: 0, pixCancelados: 0, erros: [] as string[] };
      const bq: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${recId} AND status NOT IN ('cancelado','cancelada','liquidado','pago','recebido') ORDER BY created_at DESC`);
      for (const boleto of ((bq as any).rows || [])) {
        if (/(liquid|pag|receb)/i.test(String(boleto.status || ''))) { out.erros.push('boleto ' + (boleto.nosso_numero || boleto.id) + ' ja liquidado - nao cancelado'); continue; }
        const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL LIMIT 1`);
        const accId = (accq as any).rows?.[0]?.id;
        if (accId) {
          const cancel = await cancelarBoleto(accId, boleto);
          if (!cancel.ok && !cancel.alreadyBaixado) { out.erros.push('boleto ' + (boleto.nosso_numero || boleto.id) + ': ' + (cancel.error || 'falha')); continue; }
        }
        await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado' WHERE id = ${boleto.id}`);
        out.boletosCancelados++;
      }
      const pu: any = await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR' WHERE receivable_id = ${recId} AND status = 'ATIVA'`);
      out.pixCancelados = ((pu as any)?.rowCount ?? 0) as number;
      res.status(200).json({ ok: out.erros.length === 0, ...out });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Emite um boleto (hibrido boleto+PIX) para um recebivel e devolve a viewUrl.
  // BOLETO UNIFICADO: junta a cobranca de 2+ titulos (mesmo cliente) em UM unico boleto.
  // Quando pago, o settleBoletoCharge da baixa em TODOS os titulos ligados (boleto_charge_receivables).
  // Body: { receivableIds: string[], dueDate?: 'YYYY-MM-DD' }.
  app.post("/api/financial/boleto/combined", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.receivableIds) ? req.body.receivableIds.map((x: any) => String(x)).filter(Boolean) : [];
      const uniqIds = Array.from(new Set(ids));
      if (uniqIds.length < 2) return res.status(400).json({ error: "Selecione ao menos 2 titulos para unir em um boleto." });

      // Carrega e valida cada titulo
      const recs: any[] = [];
      for (const id of uniqIds) {
        const r: any = await storage.getReceivable(id);
        if (!r || r.deletedAt) return res.status(404).json({ error: `Titulo ${id} nao encontrado.` });
        if (!['a_vencer', 'vencida'].includes(String(r.status))) return res.status(422).json({ error: `Titulo ${r.titleNumber || id} nao esta em aberto (status ${r.status}).` });
        const saldo = parseFloat(r.amount) - parseFloat(r.amountPaid || '0');
        if (!(saldo > 0)) return res.status(422).json({ error: `Titulo ${r.titleNumber || id} nao possui saldo em aberto.` });
        recs.push(r);
      }

      // Mesmo cliente (um boleto = um pagador)
      const docKey = (r: any) => String(r.customerDocument || '').replace(/\D/g, '') || String(r.customerId || '');
      const docs = new Set(recs.map(docKey));
      if (docs.size > 1) return res.status(422).json({ error: "Os titulos devem ser do mesmo cliente (um boleto tem um unico pagador)." });

      // Cancela AUTOMATICAMENTE qualquer cobranca anterior dos titulos que serao unidos
      // (boleto simples, boleto unificado anterior e PIX). Antes bloqueava com 409; agora cancela
      // no BB e marca 'cancelado' antes de gerar o boleto unico. Titulos ja liquidados/pagos nao
      // chegam aqui (validados acima como a_vencer/vencida), entao nao ha risco de estornar pago.
      const cancelamentos = { boletos: 0, combinados: 0, pix: 0, erros: [] as string[] };
      {
        const accCancelQ: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL LIMIT 1`);
        const accCancelId = (accCancelQ as any).rows?.[0]?.id;
        const cancelarChargeRow = async (boleto: any, tipo: 'boleto' | 'combinado') => {
          if (/(liquid|pag|receb)/i.test(String(boleto.status || ''))) return; // nunca cancela cobranca liquidada
          if (accCancelId) {
            try {
              const c = await cancelarBoleto(accCancelId, boleto);
              if (!c.ok && !c.alreadyBaixado) { cancelamentos.erros.push((tipo === 'combinado' ? 'boleto unificado ' : 'boleto ') + (boleto.nosso_numero || boleto.id) + ': ' + (c.error || 'falha')); return; }
            } catch (e: any) { cancelamentos.erros.push((tipo === 'combinado' ? 'boleto unificado ' : 'boleto ') + (boleto.nosso_numero || boleto.id) + ': ' + (e?.message || 'falha')); return; }
          }
          await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado' WHERE id = ${boleto.id}`);
          if (tipo === 'combinado') cancelamentos.combinados++; else cancelamentos.boletos++;
        };
        for (const r of recs) {
          const bq: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${r.id} AND COALESCE(status,'') NOT IN ('cancelado','cancelada','liquidado','pago','recebido')`);
          for (const boleto of ((bq as any).rows || [])) await cancelarChargeRow(boleto, 'boleto');
          const jq: any = await db.execute(sql`SELECT b2.* FROM boleto_charge_receivables jr JOIN boleto_charges b2 ON b2.id = jr.boleto_charge_id WHERE jr.receivable_id = ${r.id} AND COALESCE(b2.status,'') NOT IN ('cancelado','cancelada','liquidado','pago','recebido')`);
          for (const boleto of ((jq as any).rows || [])) await cancelarChargeRow(boleto, 'combinado');
          const pu: any = await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR' WHERE receivable_id = ${r.id} AND status = 'ATIVA'`);
          cancelamentos.pix += ((pu?.rowCount ?? 0) as number);
        }
        if (cancelamentos.erros.length) return res.status(422).json({ error: 'Nao foi possivel cancelar a cobranca anterior de um dos titulos: ' + cancelamentos.erros.join('; ') });
      }

      const total = recs.reduce((s, r) => s + (parseFloat(r.amount) - parseFloat(r.amountPaid || '0')), 0);
      const dueDates = recs.map((r) => new Date(r.dueDate)).sort((a, b) => a.getTime() - b.getTime());
      const dueDate = req.body?.dueDate ? new Date(String(req.body.dueDate) + 'T12:00:00-03:00') : dueDates[0];

      const base = await boletoParamsFromReceivable(recs[0].id);
      if (!base) return res.status(404).json({ error: "Falha ao montar dados do pagador." });
      const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL ORDER BY (omie_instance_id = ${base.omieInstanceId}) DESC NULLS LAST LIMIT 1`);
      const accId = accq.rows?.[0]?.id;
      if (!accId) return res.status(422).json({ error: "Nenhuma conta com boleto BB habilitado." });

      const titulos = recs.map((r) => r.titleNumber).filter(Boolean).join(', ');
      const params = {
        ...base.params,
        amount: Number(total.toFixed(2)),
        dueDate,
        receivableId: null,            // boleto unificado: vinculo fica na juncao, nao no receivable_id
        fiscalInvoiceId: null,
        billingPipelineId: null,
        description: `Boleto unificado de ${recs.length} titulos${titulos ? ' (' + titulos + ')' : ''}`,
        instrucoes: `Cobranca unificada de ${recs.length} titulos${titulos ? ': ' + titulos : ''}.`,
      };
      const result: any = await registrarBoleto(accId, params);
      if (!result?.success || !result?.boletoChargeId) return res.status(422).json(result || { error: "Falha ao registrar boleto." });

      // Grava a juncao (titulo -> boleto) com o saldo de cada titulo
      for (const r of recs) {
        const saldo = (parseFloat(r.amount) - parseFloat(r.amountPaid || '0')).toFixed(2);
        try {
          await db.execute(sql`INSERT INTO boleto_charge_receivables (id, boleto_charge_id, receivable_id, amount, created_at) VALUES (gen_random_uuid(), ${result.boletoChargeId}, ${r.id}, ${saldo}, now()) ON CONFLICT ON CONSTRAINT uq_bcr DO NOTHING`);
        } catch (e: any) { console.warn('[BOLETO-UNIFICADO] falha ao gravar juncao', r.id, e?.message); }
      }

      result.viewUrl = `/api/boleto-view/${result.boletoChargeId}`;
      result.combined = { receivableIds: uniqIds, count: recs.length, total: total.toFixed(2), dueDate };
      result.cancelamentos = cancelamentos;
      return res.json(result);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/financial/receivables/:id/emit-boleto", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing']), async (req, res) => {
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


  // FIX: esta rota REGISTRA boleto de verdade no BB e estava sem autenticacao.
  app.post("/api/billing-pipeline/boleto", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const itemId = (req.body || {}).itemId;
      if (!itemId) return res.status(400).json({ error: "itemId obrigatorio" });
      const recq: any = await db.execute(sql`
        SELECT r.id AS receivable_id, r.omie_instance_id
        FROM receivables r WHERE r.deleted_at IS NULL AND r.billing_pipeline_id = ${itemId}
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
    await db.execute(sql`ALTER TABLE agentes_config ADD COLUMN IF NOT EXISTS base_conhecimento text NOT NULL DEFAULT ''`);
  }
  app.post("/api/admin/agentes/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { await ensureAgentesTables(); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== CENTRAL DE MARKETING — buraco 7: custo e token por execucao de IA =====
  // Cria/garante mkt_agent_runs + coluna de teto. Idempotente.
  app.post("/api/mkt/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktRunsSchema } = await import('./mkt-agent-runs'); res.json(await ensureMktRunsSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Quanto a IA custou: por agente, por dia, e o gasto de HOJE em BRT.
  app.get("/api/mkt/custos", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktRunsSchema, resumoCustos } = await import('./mkt-agent-runs');
      await ensureMktRunsSchema();
      res.json(await resumoCustos(Number(req.query?.dias) || 30));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Ultimas execucoes (auditoria: o que a IA fez, com que modelo, quanto custou)
  app.get("/api/mkt/runs", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktRunsSchema } = await import('./mkt-agent-runs');
      await ensureMktRunsSchema();
      const lim = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
      const ag = String(req.query?.agente || '').trim();
      const r: any = ag
        ? await db.execute(sql`SELECT * FROM mkt_agent_runs WHERE agente = ${ag} ORDER BY criado_em DESC LIMIT ${lim}`)
        : await db.execute(sql`SELECT * FROM mkt_agent_runs ORDER BY criado_em DESC LIMIT ${lim}`);
      res.json({ runs: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // ===== CENTRAL DE MARKETING — buraco 2: fio de atribuicao =====
  app.post("/api/mkt/atribuicao/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktAtribuicaoSchema } = await import('./mkt-atribuicao'); res.json(await ensureMktAtribuicaoSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // Campanhas — o codigo (ex.: IG0825) e o que costura link, cupom e pedido
  app.get("/api/mkt/campanhas", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { ensureMktAtribuicaoSchema } = await import('./mkt-atribuicao');
      await ensureMktAtribuicaoSchema();
      const r: any = await db.execute(sql`SELECT * FROM mkt_campanhas ORDER BY criado_em DESC`);
      res.json({ campanhas: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/campanhas", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktAtribuicaoSchema } = await import('./mkt-atribuicao');
      await ensureMktAtribuicaoSchema();
      const b = req.body || {};
      const codigo = String(b.codigo || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
      if (!codigo || !String(b.nome || '').trim()) return res.status(400).json({ error: 'codigo e nome obrigatorios' });
      const verba = b.verba == null || b.verba === '' ? null : Number(b.verba);
      await db.execute(sql`
        INSERT INTO mkt_campanhas (codigo, nome, objetivo, canal, publico, verba, inicio, fim, cupom, ativo)
        VALUES (${codigo}, ${String(b.nome).trim()}, ${b.objetivo || null}, ${b.canal || null}, ${b.publico || null},
                ${Number.isFinite(verba as number) ? verba : null}, ${b.inicio || null}, ${b.fim || null},
                ${b.cupom ? String(b.cupom).toUpperCase() : null}, ${b.ativo !== false})
        ON CONFLICT (codigo) DO UPDATE SET nome = EXCLUDED.nome, objetivo = EXCLUDED.objetivo,
          canal = EXCLUDED.canal, publico = EXCLUDED.publico, verba = EXCLUDED.verba,
          inicio = EXCLUDED.inicio, fim = EXCLUDED.fim, cupom = EXCLUDED.cupom, ativo = EXCLUDED.ativo`);
      res.json({ ok: true, codigo });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // Links curtos /r/<slug>
  app.get("/api/mkt/links", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { ensureMktAtribuicaoSchema } = await import('./mkt-atribuicao');
      await ensureMktAtribuicaoSchema();
      const r: any = await db.execute(sql`
        SELECT l.*, c.codigo AS campanha_codigo, c.nome AS campanha_nome
          FROM mkt_links l LEFT JOIN mkt_campanhas c ON c.id = l.campanha_id
         ORDER BY l.criado_em DESC LIMIT 300`);
      res.json({ links: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/links", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktAtribuicaoSchema, normalizarSlug } = await import('./mkt-atribuicao');
      await ensureMktAtribuicaoSchema();
      const b = req.body || {};
      const slug = normalizarSlug(b.slug || b.nome || '');
      if (!slug) return res.status(400).json({ error: 'slug invalido' });
      // Resolve a campanha por codigo (mais amigavel que pedir o uuid na tela)
      let campanhaId: string | null = b.campanha_id || null;
      if (!campanhaId && b.campanha_codigo) {
        const c: any = await db.execute(sql`SELECT id FROM mkt_campanhas WHERE upper(codigo) = ${String(b.campanha_codigo).toUpperCase()} LIMIT 1`);
        campanhaId = c.rows?.[0]?.id || null;
      }
      await db.execute(sql`
        INSERT INTO mkt_links (slug, destino, campanha_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, post_ref, ativo, criado_por)
        VALUES (${slug}, ${String(b.destino || '/shop')}, ${campanhaId},
                ${b.utm_source || 'instagram'}, ${b.utm_medium || 'organic'}, ${b.utm_campaign || slug},
                ${b.utm_content || null}, ${b.utm_term || null}, ${b.post_ref || null},
                ${b.ativo !== false}, ${req.user?.email || req.user?.id || null})
        ON CONFLICT (slug) DO UPDATE SET destino = EXCLUDED.destino, campanha_id = EXCLUDED.campanha_id,
          utm_source = EXCLUDED.utm_source, utm_medium = EXCLUDED.utm_medium, utm_campaign = EXCLUDED.utm_campaign,
          utm_content = EXCLUDED.utm_content, utm_term = EXCLUDED.utm_term, post_ref = EXCLUDED.post_ref,
          ativo = EXCLUDED.ativo`);
      res.json({ ok: true, slug, url: `${req.protocol}://${req.get('host')}/r/${slug}` });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // O relatorio que este buraco existe para entregar: RECEITA POR CAMPANHA
  app.get("/api/mkt/atribuicao", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktAtribuicaoSchema, relatorioPorCampanha } = await import('./mkt-atribuicao');
      await ensureMktAtribuicaoSchema();
      res.json(await relatorioPorCampanha(Number(req.query?.dias) || 30));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== CENTRAL DE MARKETING — buraco 3: CTWA + CAPI =====
  app.post("/api/mkt/ctwa/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktCtwaSchema } = await import('./mkt-ctwa'); res.json(await ensureMktCtwaSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Funil do canal pago + estado da fila de eventos devolvidos a Meta
  app.get("/api/mkt/ctwa", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { ensureMktCtwaSchema, relatorioCtwa } = await import('./mkt-ctwa');
      await ensureMktCtwaSchema();
      res.json(await relatorioCtwa(Number(req.query?.dias) || 30));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Modo do CAPI: off (so grava) | test (monta e grava, NAO envia) | on (envia)
  app.post("/api/mkt/ctwa/modo", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const modo = String((req.body || {}).modo || '').trim();
      if (!['off', 'test', 'on'].includes(modo)) return res.status(400).json({ error: "modo deve ser off, test ou on" });
      if (modo === 'on' && !(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN)) {
        return res.status(400).json({ error: 'faltam META_PIXEL_ID e/ou META_CAPI_TOKEN nas variaveis do Railway' });
      }
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_capi_mode', ${modo}, ${'mkt-ctwa'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      res.json({ ok: true, modo });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Reenvia a fila (idempotente; tambem roda no cron)
  app.post("/api/mkt/ctwa/enviar", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { enviarPendentes } = await import('./mkt-ctwa'); res.json(await enviarPendentes(50)); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== CENTRAL DE MARKETING — buraco 8: regua de recompra sobre a base =====
  app.post("/api/mkt/recompra/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktRecompraSchema } = await import('./mkt-recompra'); res.json(await ensureMktRecompraSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Panorama: retrato da base, quem se encaixa em cada regua HOJE e o que ja rendeu
  app.get("/api/mkt/recompra", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { ensureMktRecompraSchema, panorama } = await import('./mkt-recompra');
      await ensureMktRecompraSchema();
      res.json(await panorama());
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Monta o lote. NAO envia nada — so calcula quem entra, quanto custa e quanto pode render.
  app.post("/api/mkt/recompra/lote", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { montarLote } = await import('./mkt-recompra');
      res.json(await montarLote({ regua: req.body?.regua || undefined, limite: req.body?.limite, criadoPor: req.user?.email }));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/recompra/lote/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { verLote } = await import('./mkt-recompra'); res.json(await verLote(String(req.params.id))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // O PORTAO: so aqui as mensagens entram na fila do 1841 (que ainda aplica as travas dela)
  app.post("/api/mkt/recompra/lote/:id/liberar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { liberarLote } = await import('./mkt-recompra');
      res.json(await liberarLote(String(req.params.id), req.user?.email || req.user?.id || 'admin'));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/recompra/lote/:id/descartar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { descartarLote } = await import('./mkt-recompra'); res.json(await descartarLote(String(req.params.id))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Parametros da regua — editaveis sem deploy
  app.post("/api/mkt/recompra/parametros", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const permitidas = ['mkt_recompra_antecedencia_dias','mkt_recompra_folga_dias','mkt_recompra_reativacao_dias',
        'mkt_recompra_reativacao_max','mkt_recompra_mix_min_skus','mkt_recompra_frequencia_dias',
        'mkt_recompra_lote_max','mkt_recompra_pular_inadimplente','mkt_recompra_min_pedidos_ciclo'];
      for (const k of Object.keys(b)) {
        if (!permitidas.includes(k)) continue;
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${String(b[k])}, ${'mkt-recompra'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      }
      const { parametros } = await import('./mkt-recompra');
      res.json({ ok: true, parametros: await parametros() });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== CENTRAL DE MARKETING — buraco 4: cartao de marca (brand voice) =====
  app.post("/api/mkt/marca/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktMarcaSchema } = await import('./mkt-marca'); res.json(await ensureMktMarcaSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/marca", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { ensureMktMarcaSchema, marcaAtiva, historico } = await import('./mkt-marca');
      await ensureMktMarcaSchema();
      res.json({ marca: await marcaAtiva(), historico: await historico() });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Mudou o tom? Nasce uma VERSAO NOVA — nunca se edita no lugar, porque as pecas
  // antigas guardam a versao que usaram.
  app.post("/api/mkt/marca", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { novaVersao } = await import('./mkt-marca');
      res.json(await novaVersao(req.body || {}, req.user?.email || req.user?.id || 'admin'));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // O REVISOR — cola o texto, ve o veredito. E o mesmo que os buracos 5 e 6 vao usar.
  app.post("/api/mkt/marca/revisar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { revisarTexto } = await import('./mkt-marca');
      const b = req.body || {};
      if (!String(b.texto || '').trim()) return res.status(400).json({ error: 'informe o texto' });
      res.json(await revisarTexto(String(b.texto), { canal: b.canal, exigirCodigo: !!b.exigirCodigo, categoria: b.categoria }));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // O cartao em texto, do jeito que entra no prompt dos agentes que escrevem
  app.get("/api/mkt/marca/prompt", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { blocoDePrompt } = await import('./mkt-marca'); res.type('text/plain').send(await blocoDePrompt()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== Central de Marketing - buraco 5: biblioteca de criativos com tags =====
  app.post("/api/mkt/assets/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktAssetsSchema } = await import('./mkt-assets'); res.json(await ensureMktAssetsSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/assets/panorama", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { panorama } = await import('./mkt-assets'); res.json(await panorama()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // O motivo do buraco 5 existir: qual gancho vende mais.
  // Vem ANTES de /api/mkt/assets/:id/... para "desempenho" nao virar um id.
  app.get("/api/mkt/assets/desempenho", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { desempenhoPorTag } = await import('./mkt-assets');
      res.json(await desempenhoPorTag((req.query?.eixo || 'gancho') as any, Number(req.query?.dias || 90)));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // O que falta fotografar
  app.get("/api/mkt/assets/lacunas", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { lacunas } = await import('./mkt-assets'); res.json(await lacunas()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/assets", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { buscar } = await import('./mkt-assets');
      const q = req.query || {};
      res.json(await buscar({
        gancho: q.gancho, cenario: q.cenario, publico: q.publico, produto: q.produto,
        formato: q.formato, origem: q.origem, fonte: q.fonte, texto: q.texto,
        soElegiveis: String(q.soElegiveis) === 'true',
        limite: q.limite ? Number(q.limite) : undefined,
      }));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Miniatura: a listagem manda o endereco, o navegador busca a imagem aqui.
  app.get("/api/mkt/assets/:id/arquivo", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { arquivoDoAsset } = await import('./mkt-assets');
      const a = await arquivoDoAsset(Number(req.params.id));
      if (!a) return res.status(404).json({ error: 'sem arquivo embutido' });
      res.setHeader('Content-Type', a.mime);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(a.buf);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/assets", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { cadastrarAsset } = await import('./mkt-assets');
      const r = await cadastrarAsset({ ...(req.body || {}), criadoPor: req.user?.username || req.user?.email || 'admin' });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.patch("/api/mkt/assets/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { atualizarAsset } = await import('./mkt-assets');
      const r = await atualizarAsset(Number(req.params.id), req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Popula a biblioteca com o que a Honest ja tem, em vez de pedir recadastro
  app.post("/api/mkt/assets/importar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { importarDoCatalogo } = await import('./mkt-assets');
      res.json(await importarDoCatalogo(req.user?.username || req.user?.email || 'admin'));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.delete("/api/mkt/assets/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { removerAsset } = await import('./mkt-assets');
      const r = await removerAsset(Number(req.params.id), String(req.query?.confirmar) === 'true');
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/assets/:id/uso", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { registrarUso } = await import('./mkt-assets');
      const r = await registrarUso({ ...(req.body || {}), assetId: Number(req.params.id), criadoPor: req.user?.username || req.user?.email || 'admin' });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== Central de Marketing - buraco 6: esteira de estados + fila de aprovacao =====
  const quem = (req: any) => req.user?.username || req.user?.email || 'admin';

  app.post("/api/mkt/esteira/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktEsteiraSchema } = await import('./mkt-esteira'); res.json(await ensureMktEsteiraSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/esteira/panorama", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { panoramaEsteira } = await import('./mkt-esteira'); res.json(await panoramaEsteira(Number(req.query?.dias || 30))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // A tela que decide o projeto
  app.get("/api/mkt/fila-aprovacao", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { fila } = await import('./mkt-esteira'); res.json(await fila(Number(req.query?.limite || 40))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/pieces", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { listarPorEstado } = await import('./mkt-esteira');
      res.json(await listarPorEstado(String(req.query?.estado || 'aprovado'), Number(req.query?.limite || 30)));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/pieces", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { criarPeca } = await import('./mkt-esteira');
      const r = await criarPeca({ ...(req.body || {}), criadoPor: quem(req) });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.patch("/api/mkt/pieces/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { editarPeca } = await import('./mkt-esteira');
      const r = await editarPeca(String(req.params.id), req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.delete("/api/mkt/pieces/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { removerPeca } = await import('./mkt-esteira');
      const r = await removerPeca(String(req.params.id));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/pieces/:id/historico", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { historicoDaPeca } = await import('./mkt-esteira'); res.json(await historicoDaPeca(String(req.params.id))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/pieces/:id/revisar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { enviarParaRevisao } = await import('./mkt-esteira');
      const r = await enviarParaRevisao(String(req.params.id), quem(req));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Decisao EM LOTE - aceita 1 ou 40 pecas no mesmo gesto
  app.post("/api/mkt/pieces/decisao", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { decidir } = await import('./mkt-esteira');
      const b = req.body || {};
      const r = await decidir(b.ids || [], b.decisao, { comentario: b.comentario, quem: quem(req), assumirBloqueio: b.assumirBloqueio === true });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/pieces/aprovar-exceto", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { aprovarTudoExceto } = await import('./mkt-esteira');
      const b = req.body || {};
      const r = await aprovarTudoExceto(b.excecoes || [], { quem: quem(req), assumirBloqueio: b.assumirBloqueio === true });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/pieces/:id/agendar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { agendar } = await import('./mkt-esteira');
      const r = await agendar(String(req.params.id), String(req.body?.quando || ''), quem(req));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Ate o App Review da Meta sair, a publicacao e sua - e e aqui que o criativo conta uso
  app.post("/api/mkt/pieces/:id/publicada", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { marcarPublicada } = await import('./mkt-esteira');
      const r = await marcarPublicada(String(req.params.id), { ...(req.body || {}), quem: quem(req) });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== Central de Marketing - buraco 1: registro de post e serie historica =====
  app.post("/api/mkt/posts/setup", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { ensureMktPostsSchema } = await import('./mkt-posts'); res.json(await ensureMktPostsSchema()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/posts/panorama", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { panoramaPosts } = await import('./mkt-posts'); res.json(await panoramaPosts(Number(req.query?.dias || 90))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/posts", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { listarPosts } = await import('./mkt-posts'); res.json(await listarPosts(Number(req.query?.dias || 90))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/posts", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { registrarPost } = await import('./mkt-posts');
      const r = await registrarPost({ ...(req.body || {}), criadoPor: req.user?.username || req.user?.email || 'admin' });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.delete("/api/mkt/posts/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { removerPost } = await import('./mkt-posts');
      const r = await removerPost(String(req.params.id));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Os numeros digitados do celular - e o que faz a serie comecar hoje
  app.post("/api/mkt/posts/:id/medicao", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { anotarMedicao } = await import('./mkt-posts');
      const r = await anotarMedicao(String(req.params.id), { ...(req.body || {}), criadoPor: req.user?.username || req.user?.email || 'admin' });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/posts/:id/serie", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { serieDoPost } = await import('./mkt-posts'); res.json(await serieDoPost(String(req.params.id))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Coleta automatica: escrita e desligada ate o App Review da Meta sair
  app.post("/api/mkt/posts/coleta/modo", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { definirModoColeta } = await import('./mkt-posts');
      const r = await definirModoColeta(String(req.body?.modo || 'off'), req.user?.username || req.user?.email || 'admin');
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/posts/coleta/rodar", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { coletarTodos } = await import('./mkt-posts'); res.json(await coletarTodos(Number(req.body?.dias || 30))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== Fase 0: os riscos que o plano manda fechar antes do trafego =====
  app.get("/api/mkt/fase0", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { panoramaFase0 } = await import('./mkt-fase0'); res.json(await panoramaFase0()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/fase0", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { salvarConfigFase0 } = await import('./mkt-fase0');
      const r = await salvarConfigFase0(req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // A distribuicao real dos pedidos - para o teto sair de dado, nao de palpite
  app.get("/api/mkt/fase0/distribuicao", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { distribuicaoPedidos } = await import('./mkt-fase0'); res.json(await distribuicaoPedidos(Number(req.query?.dias || 180))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Cobrancas que a IA NAO gerou por estarem acima do teto - a fila que precisa de gente
  app.get("/api/mkt/fase0/pix-barrados", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try { const { pixBarrados } = await import('./mkt-fase0'); res.json(await pixBarrados(Number(req.query?.dias || 30))); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/fase0/limpar-pausas", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try { const { limparPausasVencidas } = await import('./mkt-fase0'); res.json(await limparPausasVencidas()); }
    catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== Central de Marketing - buraco 9: presenca em Google =====
  app.get("/api/mkt/google", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { configGoogle, diagnosticoGoogle } = await import('./mkt-google');
      res.json({ config: await configGoogle(true), diagnostico: await diagnosticoGoogle() });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/google", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { salvarConfigGoogle } = await import('./mkt-google');
      const r = await salvarConfigGoogle(req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/mkt/google/conversoes", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { conversoesOffline } = await import('./mkt-google');
      res.json(await conversoesOffline(Number(req.query?.dias || 90)));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // CSV no formato exato de "Importar conversoes" do Google Ads
  app.get("/api/mkt/google/conversoes.csv", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const { csvGoogleAds } = await import('./mkt-google');
      res.type('text/csv').set('Content-Disposition', 'attachment; filename="conversoes-google-ads.csv"')
         .send(await csvGoogleAds(Number(req.query?.dias || 90)));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  // Espelho do que o robo do Google recebe - para conferir sem sair da tela
  app.get("/api/mkt/google/previa", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const { robotsTxt, sitemapXml, jsonLd, blocoSeo } = await import('./mkt-google');
      const sm = await sitemapXml();
      res.json({
        robots: await robotsTxt(),
        sitemapUrls: (sm.match(/<loc>/g) || []).length,
        sitemapInicio: sm.slice(0, 600),
        jsonLd: await jsonLd(),
        cabecalho: await blocoSeo(),
      });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // Preco por modelo e cambio — editaveis SEM deploy (motivo: preco de token muda)
  app.get("/api/mkt/precos", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      const g = async (k: string, d: string) => { const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key=${k} LIMIT 1`); const v = r.rows?.[0]?.value; return v == null ? d : String(v).replace(/^"|"$/g, ''); };
      res.json({ precosModelo: await g('mkt_precos_modelo', ''), usdBrl: await g('mkt_usd_brl', '5.40') });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/mkt/precos", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const setK = async (k: string, v: string) => { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${v}, ${'mkt-precos'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); };
      if (b.precosModelo != null) {
        const s = String(b.precosModelo).trim();
        if (s) { try { JSON.parse(s); } catch { return res.status(400).json({ error: 'precosModelo nao e JSON valido' }); } }
        await setK('mkt_precos_modelo', s);
      }
      if (b.usdBrl != null) {
        const n = Number(b.usdBrl);
        if (!(n > 0)) return res.status(400).json({ error: 'usdBrl invalido' });
        await setK('mkt_usd_brl', String(n));
      }
      const { limparCacheDePreco } = await import('./mkt-agent-runs');
      limparCacheDePreco();
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/admin/agentes", authenticateUser, requireRole(['admin']), async (_req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const base = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum'`);
      // teto_custo_dia entra aqui (Central de Marketing, buraco 7). O ALTER e idempotente
      // e barato: garante que o painel nao quebre em instancia que ainda nao subiu o boot novo.
      try { await db.execute(sql.raw("ALTER TABLE agentes_config ADD COLUMN IF NOT EXISTS teto_custo_dia numeric(10,2)")); } catch {}
      const ags = await db.execute(sql`SELECT id, nome, modelo, system_prompt, base_conhecimento, ferramentas, limites, ativo, teto_custo_dia, updated_at FROM agentes_config ORDER BY id`);
      res.json({ baseComum: (base.rows[0] && (base.rows[0] as any).valor) || null, agentes: ags.rows });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.get("/api/admin/agentes/:id", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const base = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum'`);
      const ag = await db.execute(sql`SELECT * FROM agentes_config WHERE id = ${req.params.id}`);
      const row: any = ag.rows[0];
      if (!row) return res.status(404).json({ error: "agente nao encontrado" });
      const baseComum = (base.rows[0] && (base.rows[0] as any).valor) || "";
      const kb = (row.base_conhecimento || "").trim();
      res.json(Object.assign({}, row, { system_prompt_efetivo: (baseComum ? baseComum + "\n\n" : "") + (kb ? "# BASE DE CONHECIMENTO\n" + kb + "\n\n" : "") + row.system_prompt }));
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.post("/api/admin/agentes/upsert", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const b = req.body || {};
      if (!b.id || !b.nome || !b.modelo || !b.system_prompt) return res.status(400).json({ error: "id, nome, modelo, system_prompt obrigatorios" });
      try { await db.execute(sql.raw("ALTER TABLE agentes_config ADD COLUMN IF NOT EXISTS teto_custo_dia numeric(10,2)")); } catch {}
      // teto_custo_dia: null/ausente = SEM teto (comportamento de hoje). 0 tambem = sem teto.
      // Guarda contra NaN: valor invalido vira null em vez de quebrar o INSERT.
      let _teto: number | null = null;
      if (!(b.teto_custo_dia === '' || b.teto_custo_dia == null)) {
        const n = Number(b.teto_custo_dia);
        _teto = Number.isFinite(n) && n > 0 ? n : null;
      }
      await db.execute(sql`INSERT INTO agentes_config (id, nome, modelo, system_prompt, base_conhecimento, ferramentas, limites, ativo, teto_custo_dia) VALUES (${b.id}, ${b.nome}, ${b.modelo}, ${b.system_prompt}, ${String(b.base_conhecimento || '')}, ${JSON.stringify(b.ferramentas || [])}::jsonb, ${JSON.stringify(b.limites || {})}::jsonb, ${b.ativo !== false}, ${_teto}) ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, modelo = EXCLUDED.modelo, system_prompt = EXCLUDED.system_prompt, base_conhecimento = EXCLUDED.base_conhecimento, ferramentas = EXCLUDED.ferramentas, limites = EXCLUDED.limites, ativo = EXCLUDED.ativo, teto_custo_dia = EXCLUDED.teto_custo_dia, updated_at = now()`);
      res.json({ ok: true, id: b.id });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });
  app.put("/api/admin/config/base-comum", authenticateUser, requireRole(['admin']), async (req: any, res: any) => {
    try {
      await ensureAgentesTables();
      const valor = (req.body || {}).valor;
      if (!valor) return res.status(400).json({ error: "valor obrigatorio" });
      await db.execute(sql`INSERT INTO config_global (chave, valor, descricao) VALUES ('base_comum', ${valor}, 'Prompt base compartilhado pelos agentes de WhatsApp') ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: (e && e.message) || String(e) }); }
  });

  // ===== IMPRESSAO DE COBRANCAS (boleto/pix ja sincronizados) — endpoint read-only =====
  // FIX: idem — devolve dados de cobranca (linha digitavel/PIX) sem autenticacao.
  app.post("/api/billing-pipeline/charges", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
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

  // ===== ITENS DO PIPELINE POR ID — impressão a partir das ROTAS DE ENTREGA =====
  // A folha de pedido precisa de produtos/vendedor/valor/observação. Quem imprime
  // pela roteirização (pop-up de rotas ou tela "Rotas de Entrega") só tem em mãos o
  // `billing_id` da parada, e não o card do Kanban — daí este read-only por ids.
  app.post("/api/billing-pipeline/items-by-ids", authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      const valid = ids.filter((x: any) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x));
      if (valid.length === 0) return res.json([]);
      const inList = valid.map((x: string) => "'" + x + "'").join(",");
      const text =
        "SELECT id, customer_name, seller_name, order_number, invoice_number, " +
        "sale_value, products, notes, stage FROM billing_pipeline WHERE id IN (" + inList + ")";
      const rows = (await db.execute(sql.raw(text))).rows as any[];
      res.json(rows.map((r: any) => ({
        id: r.id,
        customerName: r.customer_name,
        sellerName: r.seller_name,
        orderNumber: r.order_number,
        invoiceNumber: r.invoice_number,
        saleValue: r.sale_value,
        products: r.products,
        notes: r.notes,
        stage: r.stage,
      })));
    } catch (e: any) {
      res.status(500).json({ error: (e && e.message) ? e.message : String(e) });
    }
  });

  // Resolve as DANFEs dos itens do pipeline pelo VÍNCULO REAL da nota (sales_card_id),
  // NÃO só pelo invoice_number do card. Muitos itens ficam "faturado" com invoice_number
  // NULO (a NF-e é autorizada de forma assíncrona pela SEFAZ e o número não é gravado de
  // volta no card) — então a impressão "completo"/DANFE saía SEM a nota. Aqui achamos a NF
  // pelo cartão de venda (à prova de colisão de número entre emitentes/clientes), retornamos
  // no MESMO formato do /batch e AINDA cicatrizamos o card (grava o NF-xxxx que faltava).
  app.post("/api/billing-pipeline/danfes", async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      const valid = ids.filter((x: any) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x));
      if (valid.length === 0) return res.json([]);
      const results: any[] = [];
      for (const id of valid) {
        try {
          const item: any = await storage.getBillingPipelineItem(id);
          if (!item) continue;
          let nf: any = null;
          // 1) VÍNCULO FORTE: sales_card_id (melhor NF: produção + autorizada primeiro).
          if (item.salesCardId) {
            const r: any = await db.execute(sql`SELECT id, invoice_number, status FROM fiscal_invoices WHERE sales_card_id = ${item.salesCardId} AND status NOT IN ('cancelled','cancelada') ORDER BY (COALESCE(environment,'producao')='producao') DESC, (status='authorized') DESC, created_at DESC LIMIT 1`);
            nf = ((r?.rows ?? r) as any[])[0] || null;
          }
          // 2) número + MESMO cliente (nunca só por número — ele se repete entre emitentes).
          if (!nf) {
            const numRef = String(item.invoiceNumber || '').replace(/\D/g, '');
            if (numRef && item.customerId) {
              const r: any = await db.execute(sql`SELECT id, invoice_number, status FROM fiscal_invoices WHERE invoice_number = ${Number(numRef)} AND customer_id = ${item.customerId} AND status NOT IN ('cancelled','cancelada') ORDER BY (COALESCE(environment,'producao')='producao') DESC, (status='authorized') DESC, created_at DESC LIMIT 1`);
              nf = ((r?.rows ?? r) as any[])[0] || null;
            }
          }
          // 3) referência por notes (pedido pipeline interno sem sales_card_id).
          if (!nf && !item.salesCardId && item.orderNumber) {
            const r: any = await db.execute(sql`SELECT id, invoice_number, status FROM fiscal_invoices WHERE notes = ${'Pedido pipeline interno - ' + item.orderNumber} AND sales_card_id IS NULL AND status NOT IN ('cancelled','cancelada') ORDER BY (status='authorized') DESC, created_at DESC LIMIT 1`);
            nf = ((r?.rows ?? r) as any[])[0] || null;
          }
          if (!nf) continue;
          const inv: any = await storage.getFiscalInvoice(nf.id);
          if (!inv) continue;
          const invItems = await storage.getFiscalInvoiceItems(nf.id);
          results.push({ itemId: id, ...inv, items: invItems });
          // Cicatriza o card: grava o número da NF que faltava (idempotente).
          if (!item.invoiceNumber && nf.invoice_number) {
            try { await storage.updateBillingPipelineItem(id, { invoiceNumber: `NF-${nf.invoice_number}` } as any); } catch (e) {}
          }
        } catch (e) { /* item a item: uma falha não derruba o lote */ }
      }
      res.json(results);
    } catch (e: any) {
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
      const startDate = todayStr.slice(0, 8) + "01";
      const endDate = todayStr.slice(0, 8) + String(new Date(Date.UTC(Number(todayStr.slice(0,4)), Number(todayStr.slice(5,7)), 0)).getUTCDate()).padStart(2, "0");
      const q2 = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
      // ── REGRA OFICIAL DE FATURAMENTO (vigencia 01/07/2026) — server/faturamento-oficial.ts
      // NF-e autorizada de venda, deduplicada por CNPJ+serie+numero, data SEM AT TIME ZONE
      // (as datas ja estao em horario de Brasilia). now() e timestamptz, esse sim converte.
      const VF = nfVendaWhere('fi'); const VFROM = nfVendaFrom('fi'); const VDATA = nfData('fi');
      const statsRows = await q2(`SELECT COALESCE(SUM(total_invoice) FILTER (WHERE fdate = (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS today_sales, COALESCE(SUM(total_invoice) FILTER (WHERE fdate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), 0) AS yesterday_sales, COALESCE(SUM(total_invoice) FILTER (WHERE fdate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 7), 0) AS last_week_same_day_sales, COALESCE(SUM(total_invoice) FILTER (WHERE fdate >= date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo'))::date), 0) AS week_sales, COALESCE(SUM(total_invoice) FILTER (WHERE fdate >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date), 0) AS month_sales FROM (SELECT fi.total_invoice, ${VDATA}::date AS fdate FROM ${VFROM} WHERE ${VF}) t`);
      const stats = { todaySales: statsRows[0]?.today_sales ?? 0, lastWeekSameDaySales: statsRows[0]?.last_week_same_day_sales ?? 0, yesterdaySales: statsRows[0]?.yesterday_sales ?? 0, weekSales: statsRows[0]?.week_sales ?? 0, monthSales: statsRows[0]?.month_sales ?? 0 };
      // FIX (18/jul): número grande de "Faturamento do Mês" = NF-e autorizada do mês (faturamento real, = dashboard2/all),
      // para bater com a barra do mês vigente do gráfico anual. Dia/semana seguem em billing_pipeline (já validados).
      const fiscalMonthRows = await q2(`SELECT COALESCE(SUM(fi.total_invoice),0) AS v FROM ${VFROM} WHERE ${VF} AND ${VDATA}::date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date`);
      stats.monthSales = fiscalMonthRows[0]?.v ?? stats.monthSales;
      // Séries para os mini gráficos do dashboard (faturamento = billing_pipeline.sale_value):
      //  - daily: faturamento por dia do MÊS corrente; monthly: por mês do ANO corrente.
      const dailySeriesRows = await q2(`SELECT ${VDATA}::date::text AS d, COALESCE(SUM(fi.total_invoice),0) AS v FROM ${VFROM} WHERE ${VF} AND ${VDATA}::date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date GROUP BY d ORDER BY d`);
      // FIX (18/jul): "Faturamento do Mês" (gráfico anual) passa a usar NF-e AUTORIZADA por mês de emissão/autorização
      // (faturamento real), e não SUM(billing_pipeline.sale_value) por created_at — que inflava meses de importação/backfill
      // (ex.: mai/26 aparecia R$777k por causa de pedidos criados/sincronizados em maio, não faturamento real do mês).
      // Grafico anual: meses ANTERIORES a vigencia mantem o calculo legado (nao reprocessamos
      // o passado); de 01/07/2026 em diante vale a Regra Oficial.
      const _legado = "status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND UPPER(COALESCE(nature_of_operation,'')) LIKE '%VENDA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TROCA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%TRANSFER%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%REMESSA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%BONIFICA%' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%AMOSTRA%' AND (import_origin IS NULL OR TRIM(import_origin) = '')";
      const monthlySeriesRows = await q2(`SELECT m, COALESCE(SUM(v),0) AS v FROM (SELECT to_char(date_trunc('month', COALESCE(emission_date,authorization_date,created_at)),'YYYY-MM') AS m, total_invoice AS v FROM fiscal_invoices WHERE ${_legado} AND COALESCE(emission_date,authorization_date,created_at)::date >= date_trunc('year',(now() AT TIME ZONE 'America/Sao_Paulo'))::date AND COALESCE(emission_date,authorization_date,created_at)::date < '${VIGENCIA_REGRA_OFICIAL}'::date UNION ALL SELECT to_char(date_trunc('month', ${VDATA}),'YYYY-MM') AS m, fi.total_invoice AS v FROM ${VFROM} WHERE ${VF} AND ${VDATA}::date >= '${VIGENCIA_REGRA_OFICIAL}'::date) s GROUP BY m ORDER BY m`);
      const series = { daily: dailySeriesRows.map((r: any) => ({ d: r.d, v: Number(r.v) || 0 })), monthly: monthlySeriesRows.map((r: any) => ({ m: r.m, v: Number(r.v) || 0 })) };
      const vendasEfetivasMes: any = { label: null, value: 0, approx: true };
      const blocked = await q2(`SELECT bo.id, COALESCE(c.name, '-') AS customer_name, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS seller_name, bo.total_amount, bo.block_reason, bo.blocked_at FROM blocked_orders bo LEFT JOIN customers c ON c.id = bo.customer_id LEFT JOIN users u ON (u.omie_vendor_code = bo.seller_id OR u.omie_vendor_code = replace(bo.seller_id,'omie-vendor-','') OR u.id = bo.seller_id) WHERE bo.status = 'blocked' ORDER BY bo.blocked_at DESC NULLS LAST`);
      const aFaturar = await q2(`SELECT bp.id, COALESCE(c.name, '-') AS customer_name, COALESCE(bp.seller_name, '') AS seller_name, bp.sale_value, bp.created_at FROM billing_pipeline bp LEFT JOIN customers c ON c.id = bp.customer_id WHERE bp.stage IN ('pedido','a_faturar') ORDER BY bp.created_at DESC NULLS LAST`);
      const nfsHoje = await q2(`SELECT fi.id, COALESCE(fi.customer_name,'-') AS customer_name, fi.invoice_number, fi.total_invoice, COALESCE(fi.authorization_date, fi.emission_date) AS authorization_date, COALESCE(vend.nome,'Sem vendedor') AS seller_name FROM ${VFROM} LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN ${PIPELINE_POR_NF} bp ON bp.num = fi.invoice_number LEFT JOIN LATERAL (SELECT NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS nome FROM users u WHERE u.id = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id) OR u.omie_vendor_code = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id) OR u.omie_vendor_code = REPLACE(COALESCE(NULLIF(bp.seller_id,''), sc.seller_id,''),'omie-vendor-','') LIMIT 1) vend ON true WHERE ${VF} AND ${VDATA}::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY COALESCE(fi.authorization_date, fi.emission_date) DESC NULLS LAST`);

      const faturadosDia = await q2(`SELECT COALESCE(NULLIF(TRIM(fi.customer_name),''),'-') AS customer_name, COALESCE(SUM(fi.total_invoice),0) AS total FROM ${VFROM} WHERE ${VF} AND ${VDATA}::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date GROUP BY 1 HAVING COALESCE(SUM(fi.total_invoice),0) > 0 ORDER BY total DESC`);
      const faturadosSemana = await q2(`SELECT COALESCE(NULLIF(TRIM(fi.customer_name),''),'-') AS customer_name, COALESCE(SUM(fi.total_invoice),0) AS total FROM ${VFROM} WHERE ${VF} AND ${VDATA}::date >= date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo'))::date GROUP BY 1 HAVING COALESCE(SUM(fi.total_invoice),0) > 0 ORDER BY total DESC`);
      const ordersOverview = { blocked, aFaturar, nfsHoje, faturadosDia, faturadosSemana };
      // Clientes a atender no dia = clientes agendados (sales_cards.scheduled_date = a Rota do Dia).
      // Visitado (Visitas Efetivadas) = existe CHECK-IN em route_checkpoints na mesma data.
      const sched = await q2(`SELECT sc.customer_id AS customer_id, (sc.scheduled_date)::date::text AS d, BOOL_OR(EXISTS (SELECT 1 FROM route_checkpoints rc WHERE rc.customer_id = sc.customer_id AND rc.checkpoint_type = 'check_in' AND (rc.checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (sc.scheduled_date)::date)) AS visited FROM sales_cards sc WHERE sc.scheduled_date IS NOT NULL AND (sc.scheduled_date)::date BETWEEN '${startDate}' AND '${endDate}' AND sc.customer_id IS NOT NULL GROUP BY sc.customer_id, d`);
      const orders = await q2(`SELECT customer_id, (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, COALESCE(SUM(sale_value),0) AS v, COUNT(*) AS n FROM billing_pipeline WHERE stage <> 'lixeira' AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      let metas: any[] = [];
      // Meta = média dos ÚLTIMOS 3 faturamentos (pedidos) de cada cliente
      try { metas = await q2(`SELECT customer_id, AVG(sale_value) AS meta FROM (SELECT customer_id, sale_value, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn FROM billing_pipeline WHERE stage <> 'lixeira' AND sale_value > 0 AND customer_id IS NOT NULL) t WHERE rn <= 3 GROUP BY customer_id`); } catch (e) {}
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
      // REGRA (Flavio): a venda e de QUEM IMPLANTOU O PEDIDO (billing_pipeline.seller_id pelo
      // numero da NF), nunca do dono atual da carteira. Fallback: vendedor do sales_card.
      const sellerDailyRows = await q2(`WITH fx AS (SELECT fi.total_invoice AS v, ${VDATA}::date::text AS d, COALESCE(vend.nome,'Sem vendedor') AS seller FROM ${VFROM} LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN ${PIPELINE_POR_NF} bp ON bp.num = fi.invoice_number LEFT JOIN LATERAL (SELECT NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS nome FROM users u WHERE u.id = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id) OR u.omie_vendor_code = COALESCE(NULLIF(bp.seller_id,''), sc.seller_id) OR u.omie_vendor_code = REPLACE(COALESCE(NULLIF(bp.seller_id,''), sc.seller_id,''),'omie-vendor-','') LIMIT 1) vend ON true WHERE ${VF} AND ${VDATA}::date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date) SELECT seller, d, COALESCE(SUM(v),0) AS v FROM fx GROUP BY seller, d`);
      // REGRA (Flavio): faturamento por vendedor no comparativo = quem COLOCOU o pedido (billing_pipeline.seller_name),
      // e nao o dono atual do cliente. O cliente permanece na carteira de origem.
      const visitSummary = { start: startDate, end: endDate, dates, rows, sellerDaily: sellerDailyRows.map((r) => ({ seller: r.seller, d: r.d, v: Number(r.v) || 0 })) };
      res.json({ stats, series, vendasEfetivasMes, ordersOverview, visitSummary });
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

  // ── Relatório GRÁFICO: Positivação do mês (% atual + projeção por dias úteis) ──
  // READ-ONLY. Universo = clientes na lista de Ativos. Positivado = comprou no mês
  // (billing_pipeline 2.0 OU receivable — inclui faturas do 1.0). Projeção linear
  // pela cadência de positivação sobre os dias úteis do mês (feriados não considerados).
  app.get('/api/reports/positivacao-mes', async (req: Request, res: Response) => {
    try {
      const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
      const digits = (v: any) => String(v || '').replace(/[^0-9]/g, '');

      const au = rowsOf(await db.execute(sql`
        SELECT c.id AS rid, c.cnpj AS cnpj, c.cpf AS cpf, c.seller_id AS sid
        FROM active_customers ac
        LEFT JOIN customers c ON c.id = ac.customer_id
        WHERE ac.is_active IS NOT FALSE`));
      const universe: { id: string | null; doc: string; sid: string | null; pos: boolean }[] = [];
      const seen = new Set<string>();
      for (const r of au) {
        const rid = r.rid ? String(r.rid) : null;
        const doc = digits(r.cnpj) || digits(r.cpf);
        const key = rid || (doc ? 'doc:' + doc : '');
        if (!key || seen.has(key)) { if (!key) universe.push({ id: null, doc: '', sid: r.sid ? String(r.sid) : null, pos: false }); continue; }
        seen.add(key);
        universe.push({ id: rid, doc, sid: r.sid ? String(r.sid) : null, pos: false });
      }
      const totalAtivos = universe.length;

      const bp = rowsOf(await db.execute(sql`
        SELECT customer_id AS cid, MIN(created_at) AS first
        FROM billing_pipeline
        WHERE created_at >= date_trunc('month', (now() at time zone 'America/Sao_Paulo'))
          AND created_at < date_trunc('month', (now() at time zone 'America/Sao_Paulo')) + interval '1 month'
          AND COALESCE(sale_value,0) > 0
        GROUP BY customer_id`));
      const rc = rowsOf(await db.execute(sql`
        SELECT customer_id AS cid, customer_document AS doc, MIN(issue_date) AS first
        FROM receivables
        WHERE issue_date >= date_trunc('month', (now() at time zone 'America/Sao_Paulo'))
          AND issue_date < date_trunc('month', (now() at time zone 'America/Sao_Paulo')) + interval '1 month'
          AND COALESCE(amount,0) > 0 AND status <> 'cancelada' AND deleted_at IS NULL
        GROUP BY customer_id, customer_document`));

      const firstById = new Map<string, Date>();
      const firstByDoc = new Map<string, Date>();
      const setMin = (m: Map<string, Date>, k: string, d: any) => { if (!k || !d) return; const dt = new Date(d); if (isNaN(dt.getTime())) return; const cur = m.get(k); if (!cur || dt < cur) m.set(k, dt); };
      for (const r of bp) setMin(firstById, String(r.cid), r.first);
      for (const r of rc) { if (r.cid) setMin(firstById, String(r.cid), r.first); const dd = digits(r.doc); if (dd.length >= 11) setMin(firstByDoc, dd, r.first); }

      const firstDates: Date[] = [];
      let positivados = 0;
      for (const u of universe) {
        let d: Date | null = null;
        if (u.id && firstById.has(u.id)) d = firstById.get(u.id) as Date;
        if (u.doc && firstByDoc.has(u.doc)) { const dd = firstByDoc.get(u.doc) as Date; if (!d || dd < d) d = dd; }
        if (d) { positivados++; firstDates.push(d); u.pos = true; }
      }

      const nowBr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const y = nowBr.getFullYear(), mo = nowBr.getMonth(), todayDay = nowBr.getDate();
      const lastDay = new Date(y, mo + 1, 0).getDate();
      const isBiz = (dt: Date) => { const w = dt.getDay(); return w >= 1 && w <= 5; };
      let diasUteisTotal = 0, diasUteisDecorridos = 0;
      for (let day = 1; day <= lastDay; day++) {
        const dt = new Date(y, mo, day);
        if (isBiz(dt)) { diasUteisTotal++; if (day <= todayDay) diasUteisDecorridos++; }
      }
      const diasUteisRestantes = Math.max(0, diasUteisTotal - diasUteisDecorridos);
      const projetadoPositivados = diasUteisDecorridos > 0
        ? Math.min(totalAtivos, Math.round(positivados * diasUteisTotal / diasUteisDecorridos))
        : positivados;
      const pct = (n: number) => totalAtivos > 0 ? Math.round((n / totalAtivos) * 1000) / 10 : 0;
      const pctAtual = pct(positivados);
      const pctProjetado = pct(projetadoPositivados);

      const firstByDay: number[] = new Array(lastDay + 2).fill(0);
      for (const d of firstDates) { const day = d.getDate(); if (day >= 1 && day <= lastDay) firstByDay[day]++; }
      const serie: any[] = [];
      let cum = 0;
      for (let day = 1; day <= lastDay; day++) {
        const dt = new Date(y, mo, day);
        if (!isBiz(dt)) continue;
        const isPast = day <= todayDay;
        if (isPast) cum += firstByDay[day];
        serie.push({ dia: String(day).padStart(2, '0') + '/' + String(mo + 1).padStart(2, '0'), real: isPast ? pct(cum) : null, projecao: null, _past: isPast });
      }
      const futuros = serie.filter(s => !s._past).length;
      let fi = 0;
      for (const s of serie) {
        if (s._past) { s.projecao = null; }
        else { fi++; s.projecao = Math.round((pctAtual + (pctProjetado - pctAtual) * (fi / Math.max(1, futuros))) * 10) / 10; }
      }
      // conecta a projeção ao último ponto real (hoje)
      for (let i = serie.length - 1; i >= 0; i--) { if (serie[i]._past && serie[i].real !== null) { serie[i].projecao = serie[i].real; break; } }
      for (const s of serie) delete s._past;

      // ── Comparativo POR VENDEDOR (positivação % + faturamento do mês) ──
      const fatByCid = new Map<string, number>();
      for (const r of rowsOf(await db.execute(sql`
        SELECT customer_id AS cid, COALESCE(SUM(sale_value),0) AS total
        FROM billing_pipeline
        WHERE created_at >= date_trunc('month', (now() at time zone 'America/Sao_Paulo'))
          AND created_at < date_trunc('month', (now() at time zone 'America/Sao_Paulo')) + interval '1 month'
          AND COALESCE(sale_value,0) > 0
        GROUP BY customer_id`))) fatByCid.set(String(r.cid), Number(r.total || 0));
      const us = rowsOf(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code FROM users`));
      const uById = new Map<string, any>(); const uByCode = new Map<string, any>();
      const nm = (u: any) => ((String(u.first_name || '').trim() + ' ' + String(u.last_name || '').trim()).trim() || (u.email ? String(u.email).split('@')[0] : '') || 'Sem vendedor');
      for (const u of us) { uById.set(String(u.id), u); if (u.omie_vendor_code) uByCode.set(String(u.omie_vendor_code), u); }
      const resolveSeller = (sid: string | null) => { if (!sid) return 'Sem vendedor'; const st = String(sid); const u = uById.get(st) || uByCode.get(st) || uByCode.get(st.replace('omie-vendor-', '')); return u ? nm(u) : 'Sem vendedor'; };
      const perSeller = new Map<string, { total: number; positivados: number; faturamento: number }>();
      for (const u of universe) {
        const sname = resolveSeller(u.sid);
        const e = perSeller.get(sname) || { total: 0, positivados: 0, faturamento: 0 };
        e.total++;
        if (u.pos) e.positivados++;
        if (u.id && fatByCid.has(u.id)) e.faturamento += fatByCid.get(u.id) as number;
        perSeller.set(sname, e);
      }
      const porVendedor = Array.from(perSeller.entries())
        .map(([vendedor, e]) => ({ vendedor, total: e.total, positivados: e.positivados, percentual: e.total > 0 ? Math.round((e.positivados / e.total) * 1000) / 10 : 0, faturamento: Math.round(e.faturamento * 100) / 100 }))
        .filter(v => v.total >= 3)
        .sort((a, b) => b.faturamento - a.faturamento);

      res.json({
        mes: mo + 1, ano: y,
        porVendedor,
        totalAtivos, positivados, percentual: pctAtual,
        diasUteisTotal, diasUteisDecorridos, diasUteisRestantes,
        projetadoPositivados, projetadoPercentual: pctProjetado,
        serie,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Alerta diário de NÃO positivados por vendedor (WhatsApp). dryRun por padrão; ?apply=1 envia.
  app.get('/api/admin/positivacao/alerta-vendedores', async (req: Request, res: Response) => {
    try {
      const apply = String(req.query.apply || '') === '1' || String(req.query.apply || '') === 'true';
      const toOverride = req.query.to ? String(req.query.to) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
      const out = await enviarAlertaPositivacaoVendedores(apply, { toOverride, limit });
      res.json(out);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // Liga/desliga o disparo automático 07:50 e configura números fixos.
  app.get('/api/admin/positivacao/alerta-config', async (_req: Request, res: Response) => {
    try {
      const rd = async (k: string) => { const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='" + k + "' LIMIT 1")); const rows = r && r.rows ? r.rows : []; return rows[0] ? String(rows[0].value) : null; };
      res.json({ ativo: (await rd('positivacao_alerta_ativo')) === 'on', fixos: (await rd('positivacao_fixos')) || '5562995782812', ultimoEnvio: await rd('positivacao_alerta_last') });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/admin/positivacao/alerta-config', async (req: Request, res: Response) => {
    try {
      const setKV = async (k: string, v: string) => {
        const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + v.replace(/'/g, "") + "', updated_by='admin', updated_at=now() WHERE key='" + k + "'"));
        const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
        if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('" + k + "','" + v.replace(/'/g, "") + "','admin')"));
      };
      if (req.body && typeof req.body.ativo !== 'undefined') await setKV('positivacao_alerta_ativo', req.body.ativo ? 'on' : 'off');
      if (req.body && typeof req.body.fixos === 'string') await setKV('positivacao_fixos', String(req.body.fixos));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Alerta fim de dia: clientes da rota de HOJE (presenciais/virtuais) NÃO visitados ──────
  // Preview (não envia): /api/admin/rota-nao-visitados/alerta?apply=0
  // Enviar de verdade:    ?apply=1   | testar num só número: ?apply=1&to=5562999883656&limit=1
  app.get('/api/admin/rota-nao-visitados/alerta', async (req: Request, res: Response) => {
    try {
      const apply = String(req.query.apply || '') === '1' || String(req.query.apply || '') === 'true';
      const toOverride = req.query.to ? String(req.query.to) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
      const out = await enviarAlertaNaoVisitados(apply, { toOverride, limit });
      res.json(out);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // Liga/desliga o disparo automático 18:30 (dias úteis).
  app.get('/api/admin/rota-nao-visitados/config', async (_req: Request, res: Response) => {
    try {
      const rd = async (k: string) => { const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='" + k + "' LIMIT 1")); const rows = r && r.rows ? r.rows : []; return rows[0] ? String(rows[0].value) : null; };
      res.json({ ativo: (await rd('rota_nao_visitados_ativo')) === 'on', ultimoEnvio: await rd('rota_nao_visitados_last') });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/admin/rota-nao-visitados/config', async (req: Request, res: Response) => {
    try {
      const setKV = async (k: string, v: string) => {
        const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + v.replace(/'/g, "") + "', updated_by='admin', updated_at=now() WHERE key='" + k + "'"));
        const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
        if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('" + k + "','" + v.replace(/'/g, "") + "','admin')"));
      };
      if (req.body && typeof req.body.ativo !== 'undefined') await setKV('rota_nao_visitados_ativo', req.body.ativo ? 'on' : 'off');
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Alerta diário de DÉBITOS VENCIDOS por vendedor (WhatsApp) ─────────────
  // dias úteis 08:00 BRT. dryRun por padrão; ?apply=1 envia.
  app.get('/api/admin/debitos/alerta-vendedores', async (req: Request, res: Response) => {
    try {
      const apply = String(req.query.apply || '') === '1' || String(req.query.apply || '') === 'true';
      const toOverride = req.query.to ? String(req.query.to) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
      const out = await enviarAlertaDebitosVencidos(apply, { toOverride, limit });
      res.json(out);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // Liga/desliga o disparo automático de débitos vencidos e configura números fixos.
  app.get('/api/admin/debitos/alerta-config', async (_req: Request, res: Response) => {
    try {
      const rd = async (k: string) => { const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='" + k + "' LIMIT 1")); const rows = r && r.rows ? r.rows : []; return rows[0] ? String(rows[0].value) : null; };
      res.json({ ativo: (await rd('debitos_alerta_ativo')) === 'on', fixos: (await rd('debitos_fixos')) || '5562995782812', ultimoEnvio: await rd('debitos_alerta_last') });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/admin/debitos/alerta-config', async (req: Request, res: Response) => {
    try {
      const setKV = async (k: string, v: string) => {
        const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + v.replace(/'/g, "") + "', updated_by='admin', updated_at=now() WHERE key='" + k + "'"));
        const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
        if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('" + k + "','" + v.replace(/'/g, "") + "','admin')"));
      };
      if (req.body && typeof req.body.ativo !== 'undefined') await setKV('debitos_alerta_ativo', req.body.ativo ? 'on' : 'off');
      if (req.body && typeof req.body.fixos === 'string') await setKV('debitos_fixos', String(req.body.fixos));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
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
          AND EXISTS (
            SELECT 1 FROM fiscal_invoices fi
            WHERE fi.status = 'authorized'
              AND fi.invoice_number = NULLIF(regexp_replace(coalesce(bp.invoice_number, ''), '[^0-9]', '', 'g'), '')::bigint
          )
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
        SELECT to_char(date_trunc('day', bp.created_at), 'YYYY-MM-DD') AS dia,
               count(*)::int AS pedidos,
               coalesce(sum(bp.sale_value), 0)::float AS valor
        FROM billing_pipeline bp
        WHERE bp.created_at > now() - make_interval(days => ${dias}::int)
          AND EXISTS (
            SELECT 1 FROM fiscal_invoices fi
            WHERE fi.status = 'authorized'
              AND fi.invoice_number = NULLIF(regexp_replace(coalesce(bp.invoice_number, ''), '[^0-9]', '', 'g'), '')::bigint
          )
        GROUP BY 1 ORDER BY 1
      `);

      // 5) Débitos vencidos — fonte 2.0 (Contas a Receber), NAO mais overdue_debts (Omie desligado).
      //    Mesma regra de "vencida" do getOverdueDebtByDocument / aba Contas a Receber.
      const debitosTop: any = await db.execute(sql`
        SELECT max(customer_name) AS client_name,
               sum(amount - coalesce(amount_paid, 0))::float AS total_amount,
               max(((now() AT TIME ZONE 'America/Sao_Paulo')::date - (due_date)::date))::int AS max_days_overdue
        FROM receivables
        WHERE deleted_at IS NULL
          AND (amount - coalesce(amount_paid, 0)) > 0
          AND coalesce(import_origin, '') <> 'omie_historico'
          AND (status IN ('a_vencer', 'vencida') AND (due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date)
        GROUP BY coalesce(nullif(regexp_replace(coalesce(customer_document, ''), '[^0-9]', '', 'g'), ''), customer_id, customer_name)
        ORDER BY total_amount DESC LIMIT 15
      `);
      const debitosResumo: any = await db.execute(sql`
        SELECT count(*)::int AS clientes, coalesce(sum(saldo), 0)::float AS valor_total FROM (
          SELECT sum(amount - coalesce(amount_paid, 0)) AS saldo
          FROM receivables
          WHERE deleted_at IS NULL
            AND (amount - coalesce(amount_paid, 0)) > 0
            AND coalesce(import_origin, '') <> 'omie_historico'
            AND (status IN ('a_vencer', 'vencida') AND (due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date)
          GROUP BY coalesce(nullif(regexp_replace(coalesce(customer_document, ''), '[^0-9]', '', 'g'), ''), customer_id, customer_name)
        ) t
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
    const FIELDS = ['weekdays', 'visit_periodicity', 'seller_id', 'virtual_service', 'route', 'contact', 'phone', 'cpf', 'cnpj'];
    const SAFE = new Set(['weekdays', 'visit_periodicity', 'seller_id', 'virtual_service', 'route', 'contact', 'phone', 'cpf', 'cnpj']);
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
          const DOC_FILL_ONLY = new Set(['cpf', 'cnpj']);
          const rows = diffs.filter((d) => d.field === f && (DOC_FILL_ONLY.has(f) ? d.direction === 'fill' : d.direction !== 'erase_block'));
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
      const s = await q('stats', "SELECT COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date),0) AS today_sales, COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')),0) AS week_sales, COALESCE((SELECT SUM(total_invoice) FROM fiscal_invoices WHERE status='authorized' AND COALESCE(operation_type,'saida') <> 'entrada' AND COALESCE(fin_nfe,'1') <> '4' AND UPPER(COALESCE(nature_of_operation,'')) NOT LIKE '%DEVOL%' AND (COALESCE(emission_date,authorization_date,created_at) AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')),0) AS month_sales");
      out.stats = s[0] || {};
      out.ordersOverview.todayInvoices = await q('todayInvoices', "SELECT fi.id, fi.invoice_number, fi.customer_name, fi.total_invoice, fi.authorization_date, fi.emission_date, fi.issuer_cnpj, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''), sc.seller_id) AS seller_name FROM fiscal_invoices fi LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id LEFT JOIN users u ON (u.id = sc.seller_id OR u.omie_vendor_code = sc.seller_id OR u.omie_vendor_code = REPLACE(COALESCE(sc.seller_id,''),'omie-vendor-','')) WHERE fi.status='authorized' AND COALESCE(fi.operation_type,'saida') <> 'entrada' AND COALESCE(fi.fin_nfe,'1') <> '4' AND UPPER(COALESCE(fi.nature_of_operation,'')) NOT LIKE '%DEVOL%' AND (COALESCE(fi.emission_date,fi.authorization_date) AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY COALESCE(fi.authorization_date,fi.emission_date) DESC LIMIT 400");
      out.ordersOverview.unbilled = await q('unbilled', "SELECT id, customer_name, seller_name, stage, sale_value, omie_instance_name, created_at FROM billing_pipeline WHERE stage IN ('pedido','a_faturar') ORDER BY created_at DESC LIMIT 400");
      out.ordersOverview.blocked = await q('blocked', "SELECT bo.id, COALESCE(c.name, bo.customer_id) AS customer_name, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)),''), bo.seller_id) AS seller_name, bo.total_amount, bo.block_reason, bo.blocked_at FROM blocked_orders bo LEFT JOIN customers c ON c.id = bo.customer_id LEFT JOIN users u ON (u.id = bo.seller_id OR u.omie_vendor_code = bo.seller_id) WHERE bo.status='blocked' ORDER BY bo.blocked_at DESC LIMIT 400");
      const sm = (arr: any[], k: string) => arr.reduce((a: number, x: any) => a + (parseFloat(x[k]) || 0), 0);
      out.ordersOverview.totals = { blockedCount: out.ordersOverview.blocked.length, blockedAmount: sm(out.ordersOverview.blocked, 'total_amount'), unbilledCount: out.ordersOverview.unbilled.length, unbilledAmount: sm(out.ordersOverview.unbilled, 'sale_value'), todayInvoicesCount: out.ordersOverview.todayInvoices.length, todayInvoicesAmount: sm(out.ordersOverview.todayInvoices, 'total_invoice') };
      out.monthly = { byInstance: await q('monthlyByInstance', "SELECT COALESCE(omie_instance_name,'-') AS instance, COALESCE(SUM(sale_value),0) AS revenue, COUNT(*)::int AS cnt FROM billing_pipeline WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') GROUP BY 1 ORDER BY 2 DESC") };
      out.sellerComparison = await q('sellerComparison', "SELECT COALESCE(seller_name, seller_id, 'sem vendedor') AS seller_name, (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia, COALESCE(SUM(sale_value),0) AS revenue, COUNT(*)::int AS pedidos FROM billing_pipeline WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) GROUP BY 1,2 ORDER BY 1,2");
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
  app.post('/api/admin/sync/backfill-all', async (req: Request, res: Response) => {
    // Confirmacao explicita: um POST vazio disparava a copia de 333 mil linhas
    // por cima do banco de producao, em background, respondendo {started:true}
    // antes de comecar — quem chamava nunca via o estrago.
    if (String((req.body as any)?.confirmo || '') !== 'SIM') {
      res.status(400).json({ error: 'Operacao destrutiva: sobrescreve o 2.0 com os dados do 1.0. Reenvie com {"confirmo":"SIM"}.', tabelasProtegidas: 'extrato, conciliacao e financeiro estao bloqueados e nao sao tocados' });
      return;
    }
    res.json({ started: true, note: 'backfill rodando em background; ver /api/admin/sync/backfill-status' });
    (async () => {
      const pgMod = await import('pg');
      const src = new pgMod.default.Client({ connectionString: process.env.REPLIT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const tgt = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const summary: any[] = [];
      try {
        await src.connect(); await tgt.connect();
        // NUNCA copiar do 1.0: extrato, conciliacao e financeiro sao verdade
        // exclusiva do 2.0 — o sync dessas tabelas ja tinha sido desligado em
        // 08/jul no sync-1.0.ts por reverter baixa, mas o backfill nao usa
        // SYNC_TABLES: ele introspecta o information_schema e pega tudo.
        // Como o upsert abaixo escreve TODAS as colunas, incluir estas tabelas
        // apagava conciliacao, baixa e saldo com os valores vazios do 1.0.
        const block = new Set(['sessions','sync_status','sync_states','omie_sync_attempts','webhook_debug_log','omie_stage_logs','billing_pipeline','suppliers','coupons','coupon_redemptions',
          'bank_statements','bank_statement_items','bank_statement_item_matches','bank_statement_item_status_log','reconciliation_audit_log','reconciliation_patterns',
          'financial_accounts','account_movements','financial_audit_log','financial_sync_log',
          'receivables','receivable_payments','receivable_events','payables','payable_payments',
          'boleto_charges','boleto_charge_receivables','pix_charges','payment_links']);
        const tq = "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'";
        const sTabs = (await src.query(tq)).rows.map((r: any) => r.table_name);
        const tTabs = new Set((await tgt.query(tq)).rows.map((r: any) => r.table_name));
        const only: string[] = Array.isArray((req.body as any)?.tables) ? (req.body as any).tables : [];
        const tables = sTabs.filter((t: string) => tTabs.has(t) && !block.has(t) && (only.length === 0 || only.includes(t)));
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

  // HOTFIX (14/jul): garante as colunas de envio de documentos ANTES dos workers de sync e do listen.
  // getCustomers() usa db.select().from(customers) com TODAS as colunas do schema; se as colunas nao
  // existirem no banco, a query quebra e o worker de sync derruba o processo (502). Idempotente.
  try {
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_email varchar`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_xml boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_danfe boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_boleto boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS docs_send_pedido boolean DEFAULT false`);
  } catch (e: any) { console.warn('[DOCS-EMAIL-MIGRATION] falha ao garantir colunas:', e?.message); }

  // Garante as colunas de condicao de pagamento do cliente ANTES dos workers de sync e do listen.
  // Elas ja eram gravadas por SQL cru (payment-terms), mas nao existiam no schema drizzle -> getCustomers
  // nao as retornava e a "Forma de Pagamento" recarregava vazia. Idempotente (IF NOT EXISTS).
  try {
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_method varchar`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS boleto_days integer`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS collection_discount numeric DEFAULT 0`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_installments integer DEFAULT 1`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS installment_schedule varchar`);
  } catch (e: any) { console.warn('[PAYMENT-COLS-MIGRATION] falha ao garantir colunas:', e?.message); }

  // Envio automatico de documentos por e-mail (replicado do cadastro do Integra 1.0):
  // notification_email + flags por tipo de documento. AWAITED antes dos workers e do
  // listen porque as colunas tambem entram no schema drizzle de customers (qualquer
  // select de customers falharia se a coluna nao existisse). Idempotente.
  try {
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS notification_email varchar`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_danfe_email boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_xml_email boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_boleto_pix_email boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS send_pedido_email boolean DEFAULT false`);
  } catch (e: any) { console.warn('[DOCS-EMAIL-COLS-MIGRATION] falha ao garantir colunas:', e?.message); }

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

  // Digital Asset Links — verifica o APK (TWA "br.com.bebahonest.integra") p/
  // abrir em TELA CHEIA, sem a barra de URL do Chrome. Servido por rota
  // EXPLÍCITA porque o express.static ignora dotfolders (.well-known) por padrão
  // — sem isto o arquivo cairia no fallback do SPA (index.html) e a verificação
  // do TWA falharia. O fingerprint é o SHA-256 do keystore de release do app.
  app.get('/.well-known/assetlinks.json', (_req: Request, res: Response) => {
    res.type('application/json').send(JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'br.com.bebahonest.integra',
          sha256_cert_fingerprints: [
            'B8:E7:9B:96:F2:67:77:EA:55:8D:71:44:62:EA:A6:6F:DF:2C:BE:B1:E0:F1:9F:9B:04:93:0E:17:F9:84:AF:CC'
          ]
        }
      }
    ]));
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
