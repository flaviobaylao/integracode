// ============================================================================
// Lead Capture + Presenca de vendedores + Notificacao por WhatsApp.
// - Presenca: cada vendedor logado no Integra faz "ping" -> users.last_seen_at.
//   Online = ativo nos ultimos LEAD_ONLINE_MINUTES (default 3).
// - Cliente cadastrado (PF/PJ) comprando (IG/Hotsite): pedido vai para o vendedor
//   da carteira (customers.seller_id). Se a carteira for telemarketing, avisa por WhatsApp.
// - Cliente NAO cadastrado: cria um "lead a capturar" e manda WhatsApp com link unico
//   para cada vendedor/telemarketing ONLINE. O 1o que capturar leva o cliente pra carteira.
// Gate de envio: system_settings 'lead_capture_mode' = off|test|on (default off).
// ============================================================================
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";
const ONLINE_MINUTES = parseInt(process.env.LEAD_ONLINE_MINUTES || "3", 10);

function onlyDigits(s: any) { return String(s || "").replace(/\D/g, ""); }
function esc(s: any) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)); }
function channelLabel(c: string) { return c === "instagram" ? "Instagram Direct" : c === "hotsite" ? "Loja online (Hotsite)" : c; }

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, "");
  } catch { return def; }
}

// Envia WhatsApp respeitando o gate lead_capture_mode (off|test|on).
async function sendWa(phone: string, text: string): Promise<boolean> {
  const to = onlyDigits(phone);
  if (!to) return false;
  const mode = (await getSetting("lead_capture_mode", "off")).toLowerCase();
  if (mode === "off") { console.log(`[LEAD] (mode=off) WhatsApp suprimido para ${to}`); return false; }
  if (mode === "test") {
    const allow = (await getSetting("lead_capture_test_phones", "")).split(/[,;\s]+/).map(onlyDigits).filter(Boolean);
    if (!allow.length || !allow.includes(to)) { console.log(`[LEAD] (mode=test) ${to} nao esta na lista de teste; suprimido`); return false; }
  }
  try {
    const { sendUmblerTalkText } = await import("./chat-routes");
    const r = await sendUmblerTalkText(to, text);
    if (!r?.success) console.error(`[LEAD] falha WhatsApp ${to}:`, r?.error);
    return !!r?.success;
  } catch (e: any) { console.error("[LEAD] erro WhatsApp:", e?.message || e); return false; }
}

export function isTelemarketing(user: any): boolean {
  if (!user) return false;
  return String(user.role || "") === "telemarketing" || String(user.sellerType || user.seller_type || "") === "telemarketing";
}

// Garante as estruturas (idempotente): coluna de presenca + tabelas de captura.
export async function ensureLeadTables(): Promise<void> {
  try { await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`); } catch {}
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_captures (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar,
      sales_card_id varchar,
      order_number varchar,
      channel varchar,
      customer_name varchar,
      customer_document varchar,
      status varchar DEFAULT 'open',
      captured_by varchar,
      captured_by_name varchar,
      captured_at timestamptz,
      created_at timestamptz DEFAULT now()
    )`);
  } catch {}
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_capture_targets (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      capture_id varchar,
      seller_id varchar,
      seller_name varchar,
      token varchar UNIQUE,
      whatsapp_sent boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    )`);
  } catch {}
}

// Vendedores/telemarketing ATIVOS e ONLINE (ping recente) com telefone.
export async function getOnlineSellers(): Promise<any[]> {
  try {
    const r: any = await db.execute(sql`
      SELECT id, first_name, last_name, phone, role, seller_type, last_seen_at
      FROM users
      WHERE is_active = true
        AND (role IN ('vendedor','telemarketing') OR seller_type IN ('telemarketing','vendedor_clt','vendedor_pj'))
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - make_interval(mins => ${ONLINE_MINUTES})`);
    return r.rows || [];
  } catch (e: any) { console.error("[LEAD] getOnlineSellers", e?.message || e); return []; }
}

// Avisa por WhatsApp o vendedor telemarketing dono da carteira sobre um novo pedido.
export async function notifyTelemarketingOrder(seller: any, info: { orderNumber?: string; customerName?: string; channel: string }): Promise<void> {
  try {
    if (!seller || !isTelemarketing(seller)) return;
    // So notifica se estiver online (regra do usuario: apenas quem esta logado no Integra).
    const online = await getOnlineSellers();
    if (!online.find((s) => String(s.id) === String(seller.id))) { console.log(`[LEAD] telemarketing ${seller.id} offline; sem alerta`); return; }
    const nome = `${seller.firstName || seller.first_name || ""}`.trim() || "vendedor";
    const msg = `📦 Olá ${nome}! Novo pedido do SEU cliente *${info.customerName || "cliente"}* (${info.orderNumber || "-"}) via ${channelLabel(info.channel)}.\n` +
      `Acompanhe a logística e o faturamento no Integra.`;
    await sendWa(seller.phone, msg);
  } catch (e: any) { console.error("[LEAD] notifyTelemarketingOrder", e?.message || e); }
}

// Cria um lead a capturar e dispara WhatsApp (com link unico) para cada vendedor ONLINE.
export async function broadcastLeadCapture(info: { customerId?: string | null; salesCardId?: string | null; orderNumber?: string; channel: string; customerName?: string; customerDocument?: string }): Promise<void> {
  try {
    await ensureLeadTables();
    const online = await getOnlineSellers();
    if (!online.length) { console.log(`[LEAD] nenhum vendedor online para capturar (${info.orderNumber})`); return; }
    const capId = (await db.execute(sql`INSERT INTO lead_captures (customer_id, sales_card_id, order_number, channel, customer_name, customer_document, status)
      VALUES (${info.customerId || null}, ${info.salesCardId || null}, ${info.orderNumber || null}, ${info.channel}, ${info.customerName || null}, ${onlyDigits(info.customerDocument) || null}, 'open') RETURNING id`)).rows?.[0]?.id;
    if (!capId) return;
    for (const s of online) {
      try {
        const token = onlyDigits(String(Date.now())) + Math.random().toString(36).slice(2, 12);
        const nome = `${s.first_name || ""} ${s.last_name || ""}`.trim();
        await db.execute(sql`INSERT INTO lead_capture_targets (capture_id, seller_id, seller_name, token) VALUES (${capId}, ${s.id}, ${nome}, ${token})`);
        const msg = `🆕 Cliente NOVO (sem carteira) comprou via ${channelLabel(info.channel)}:\n*${info.customerName || "cliente"}*  ·  Pedido ${info.orderNumber || "-"}\n` +
          `Quer atender esse cliente? Toque para CAPTURAR:\n${APP_URL}/capturar/${token}\n(o primeiro que capturar leva o cliente para a carteira)`;
        const sent = await sendWa(s.phone, msg);
        if (sent) { try { await db.execute(sql`UPDATE lead_capture_targets SET whatsapp_sent = true WHERE token = ${token}`); } catch {} }
      } catch (e: any) { console.error("[LEAD] target", s?.id, e?.message || e); }
    }
    console.log(`[LEAD] broadcast lead ${capId} para ${online.length} vendedor(es) online (${info.orderNumber})`);
  } catch (e: any) { console.error("[LEAD] broadcastLeadCapture", e?.message || e); }
}

function pageShell(title: string, bodyInner: string): string {
  return `<!doctype html><html lang=pt-br><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#f3f4f6;color:#111}.card{max-width:460px;margin:28px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{font-size:19px;margin:0 0 6px}.muted{color:#555;font-size:14px;line-height:1.5}.big{font-size:22px;font-weight:700;margin:12px 0}button{width:100%;margin-top:18px;padding:14px;background:#7c3aed;color:#fff;border:0;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}button:disabled{opacity:.5}.ok{color:#065f46}.warn{color:#92400e}.pill{display:inline-block;padding:3px 10px;border-radius:999px;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:700}</style></head><body><div class=card>${bodyInner}</div></body></html>`;
}

export function registerLeadCapture(app: Express) {
  ensureLeadTables();

  // Presenca: o front chama isso periodicamente enquanto o vendedor esta logado.
  app.post("/api/presence/ping", authenticateUser, async (req: Request, res: Response) => {
    try {
      const uid = (req as any).currentUser?.id;
      if (uid) await db.execute(sql`UPDATE users SET last_seen_at = now() WHERE id = ${uid}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Diagnostico: quem esta online agora (protegido).
  app.get("/api/presence/online-sellers", authenticateUser, async (_req: Request, res: Response) => {
    try {
      const rows = await getOnlineSellers();
      res.json(rows.map((s: any) => ({ id: s.id, name: `${s.first_name || ""} ${s.last_name || ""}`.trim(), role: s.role, sellerType: s.seller_type, lastSeenAt: s.last_seen_at })));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Config do gate de WhatsApp (off|test|on) — leitura e escrita (admin/coordenacao).
  app.get("/api/lead-capture/config", authenticateUser, async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, mode: await getSetting("lead_capture_mode", "off"), testPhones: await getSetting("lead_capture_test_phones", ""), onlineMinutes: ONLINE_MINUTES });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  app.post("/api/lead-capture/config", authenticateUser, async (req: Request, res: Response) => {
    try {
      const u: any = (req as any).currentUser;
      const role = String(u?.role || "");
      if (!u || !["admin", "coordinator", "administrative"].includes(role)) return res.status(403).json({ ok: false, error: "forbidden" });
      const by = String(u.email || u.id);
      const mode = req.body?.mode == null ? null : String(req.body.mode).toLowerCase();
      const testPhones = req.body?.testPhones == null ? null : String(req.body.testPhones);
      if (mode != null) {
        if (!["off", "test", "on"].includes(mode)) return res.status(400).json({ ok: false, error: "mode invalido (off|test|on)" });
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('lead_capture_mode', ${mode}, ${by}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      if (testPhones != null) {
        await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('lead_capture_test_phones', ${testPhones}, ${by}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      res.json({ ok: true, mode: await getSetting("lead_capture_mode", "off"), testPhones: await getSetting("lead_capture_test_phones", "") });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Pagina publica de captura (aberta pelo link do WhatsApp; token identifica o vendedor).
  app.get("/capturar/:token", async (req: Request, res: Response) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    try {
      const token = String(req.params.token || "");
      const t: any = (await db.execute(sql`SELECT capture_id, seller_id, seller_name FROM lead_capture_targets WHERE token = ${token} LIMIT 1`)).rows?.[0];
      if (!t) { res.status(404).send(pageShell("Link invalido", `<h1>Link inválido</h1><p class=muted>Este link de captura não foi encontrado ou expirou.</p>`)); return; }
      const c: any = (await db.execute(sql`SELECT order_number, channel, customer_name, status, captured_by_name FROM lead_captures WHERE id = ${t.capture_id} LIMIT 1`)).rows?.[0];
      if (!c) { res.status(404).send(pageShell("Não encontrado", `<h1>Não encontrado</h1><p class=muted>Pedido não localizado.</p>`)); return; }
      if (String(c.status) !== "open") {
        res.send(pageShell("Já capturado", `<span class=pill>${esc(channelLabel(c.channel))}</span><h1>Cliente já capturado</h1><p class=muted>O cliente <b>${esc(c.customer_name)}</b> já foi capturado por <b>${esc(c.captured_by_name || "outro vendedor")}</b>.</p>`));
        return;
      }
      res.send(pageShell("Capturar cliente",
        `<span class=pill>${esc(channelLabel(c.channel))}</span><h1>Capturar cliente</h1>` +
        `<p class=muted>Cliente novo, sem carteira, que comprou agora:</p>` +
        `<div class=big>${esc(c.customer_name || "Cliente")}</div>` +
        `<p class=muted>Pedido ${esc(c.order_number || "-")}. Ao capturar, este cliente vai para a <b>sua carteira</b> (vendedor ${esc(t.seller_name || "")}).</p>` +
        `<button id=b onclick="cap()">Capturar cliente</button><div id=out class=muted style="margin-top:14px"></div>` +
        `<script>async function cap(){var b=document.getElementById('b'),o=document.getElementById('out');b.disabled=true;o.textContent='Capturando...';try{var r=await fetch('/api/capturar/${esc(token)}',{method:'POST'});var j=await r.json();if(j.ok){o.innerHTML='<span class=\\'ok\\'>✅ '+(j.message||'Cliente capturado! Agora está na sua carteira.')+'</span>';b.style.display='none';}else{o.innerHTML='<span class=\\'warn\\'>'+(j.message||'Não foi possível capturar.')+'</span>';b.style.display='none';}}catch(e){o.textContent='Falha: '+e;b.disabled=false;}}</script>`));
    } catch (e: any) { res.status(500).send(pageShell("Erro", `<h1>Erro</h1><p class=muted>${esc(e?.message || String(e))}</p>`)); }
  });

  // Efetiva a captura (primeiro que chegar leva; corrida resolvida por UPDATE atomico).
  app.post("/api/capturar/:token", async (req: Request, res: Response) => {
    try {
      const token = String(req.params.token || "");
      const t: any = (await db.execute(sql`SELECT capture_id, seller_id, seller_name FROM lead_capture_targets WHERE token = ${token} LIMIT 1`)).rows?.[0];
      if (!t) return res.status(404).json({ ok: false, message: "Link inválido." });
      const cap: any = (await db.execute(sql`SELECT id, customer_id, sales_card_id, status, captured_by_name FROM lead_captures WHERE id = ${t.capture_id} LIMIT 1`)).rows?.[0];
      if (!cap) return res.status(404).json({ ok: false, message: "Pedido não encontrado." });
      if (String(cap.status) !== "open") return res.json({ ok: false, message: `Cliente já capturado por ${cap.captured_by_name || "outro vendedor"}.` });

      // Trava de corrida: so 1 UPDATE consegue mudar de 'open' -> 'captured'.
      const won: any = await db.execute(sql`UPDATE lead_captures SET status='captured', captured_by=${t.seller_id}, captured_by_name=${t.seller_name}, captured_at=now() WHERE id=${cap.id} AND status='open' RETURNING id`);
      if (!won.rows?.length) {
        const again: any = (await db.execute(sql`SELECT captured_by_name FROM lead_captures WHERE id = ${cap.id} LIMIT 1`)).rows?.[0];
        return res.json({ ok: false, message: `Cliente já capturado por ${again?.captured_by_name || "outro vendedor"}.` });
      }

      // Move o cliente e o pedido para a carteira do vendedor que capturou.
      if (cap.customer_id) { try { await db.execute(sql`UPDATE customers SET seller_id = ${t.seller_id}, updated_at = now() WHERE id = ${cap.customer_id}`); } catch (e: any) { console.error("[LEAD] update customer", e?.message || e); } }
      if (cap.sales_card_id) {
        try { await db.execute(sql`UPDATE sales_cards SET seller_id = ${t.seller_id} WHERE id = ${cap.sales_card_id}`); } catch {}
        try { await db.execute(sql`UPDATE billing_pipeline SET seller_id = ${t.seller_id}, seller_name = ${t.seller_name}, updated_at = now() WHERE sales_card_id = ${cap.sales_card_id}`); } catch {}
      }
      console.log(`[LEAD] capturado lead=${cap.id} por ${t.seller_id} (${t.seller_name})`);
      res.json({ ok: true, message: `Cliente capturado! Agora está na sua carteira, ${t.seller_name || ""}.` });
    } catch (e: any) { console.error("[LEAD] capturar", e?.message || e); res.status(500).json({ ok: false, message: "Erro ao capturar." }); }
  });
}
