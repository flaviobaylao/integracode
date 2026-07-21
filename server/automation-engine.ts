// ─────────────────────────────────────────────────────────────────────────────
// Motor de Automações de Comunicação (nativo do INTEGRA 2.0)
// Escuta eventos de pedido (criado/bloqueado/entrega) e dispara WhatsApp via
// Umbler Talk, usando a config da tabela communication_automations (espelho do 1.0).
// Modo (system_settings 'automations_mode'): 'off' (padrao) | 'test' | 'on'.
//   - off  = nao envia nada
//   - test = envia SOMENTE para 'automations_test_number' (loga normalmente)
//   - on   = envia para os destinatarios configurados
// Fire-and-forget: nunca lanca; nunca quebra o fluxo que o chamou.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { sendUmblerTalkText } from "./chat-routes";

let logTableReady = false;
async function ensureLogTable(): Promise<void> {
  if (logTableReady) return;
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS automation_dispatch_log (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      automation_id varchar,
      automation_name varchar,
      trigger_event varchar,
      recipient_phone varchar,
      message text,
      status varchar,
      error text,
      mode varchar,
      created_at timestamp DEFAULT now()
    )`);
    logTableReady = true;
  } catch (e: any) {
    console.error("[AUTOMATION-ENGINE] ensureLogTable:", e?.message);
  }
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key}`);
    const v = r?.rows?.[0]?.value;
    if (v === null || v === undefined) return def;
    return String(v).replace(/^"(.*)"$/, "$1");
  } catch {
    return def;
  }
}

export function normalizeBrPhone(raw: any): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = "55" + d;
  if (d.length < 12 || d.length > 13) return d.length >= 12 ? d : null;
  return d;
}

function brl(v: any): string {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!isFinite(n)) return String(v ?? "");
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTemplate(tpl: string, ctx: any): string {
  return String(tpl ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const val = String(path).split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), ctx);
    return val == null ? "" : String(val);
  });
}

async function resolveRecipients(a: any, ctx: any): Promise<string[]> {
  const set = new Set<string>();
  const type = String(a.recipient_type || "");
  if (type.includes("fixo") && a.recipient_fixed_phone) {
    for (const p of String(a.recipient_fixed_phone).split(/[;,]/)) {
      const n = normalizeBrPhone(p);
      if (n) set.add(n);
    }
  }
  if (type.includes("vendedor_pedido") && ctx?.sellerPhone) {
    const n = normalizeBrPhone(ctx.sellerPhone);
    if (n) set.add(n);
  }
  if (a.recipient_user_id) {
    try {
      const u = await storage.getUser(a.recipient_user_id);
      const n = normalizeBrPhone((u as any)?.phone);
      if (n) set.add(n);
    } catch {}
  }
  return [...set];
}

/**
 * Dispara todas as automacoes ATIVAS de whatsapp para um trigger_event.
 * ctx deve conter os campos referenciados nos templates:
 *   customer.name, order.id, order.value, seller.name,
 *   delivery.orderNumber, driver.name
 * e opcionalmente ctx.sellerPhone (para o destinatario vendedor_pedido).
 */
export async function fireAutomation(triggerEvent: string, ctx: any): Promise<void> {
  try {
    const mode = (await getSetting("automations_mode", "off")).toLowerCase();
    if (mode !== "test" && mode !== "on") return;

    const autos: any = await db.execute(sql`
      SELECT * FROM communication_automations
      WHERE trigger_event = ${triggerEvent} AND is_active = true AND channel = 'whatsapp'`);
    const rows = autos?.rows || [];
    if (!rows.length) return;

    await ensureLogTable();
    const testNumber = mode === "test" ? normalizeBrPhone(await getSetting("automations_test_number", "5562995782812")) : null;

    for (const a of rows) {
      let msg = renderTemplate(a.message_template, ctx);
      // Aviso de BLOQUEIO (caixa alta) anexado à MESMA mensagem de implantação quando o pedido
      // nasce bloqueado. Vale para qualquer template: se ele não usar {{blockNotice}}, anexamos ao final.
      if (ctx?.blockNotice && !msg.includes(String(ctx.blockNotice))) {
        msg = (msg ? msg + "\n\n" : "") + String(ctx.blockNotice);
      }
      let recipients = await resolveRecipients(a, ctx);
      if (mode === "test") recipients = testNumber ? [testNumber] : [];

      let sent = 0, failed = 0;
      for (const phone of recipients) {
        let ok = false, err: string | null = null;
        try {
          const r = await sendUmblerTalkText(phone, msg);
          ok = !!r?.success;
          err = r?.error || null;
        } catch (e: any) {
          err = e?.message || "erro";
        }
        ok ? sent++ : failed++;
        try {
          await db.execute(sql`INSERT INTO automation_dispatch_log
            (automation_id, automation_name, trigger_event, recipient_phone, message, status, error, mode)
            VALUES (${a.id}, ${a.name}, ${triggerEvent}, ${phone}, ${msg}, ${ok ? "sent" : "failed"}, ${err}, ${mode})`);
        } catch {}
      }

      try {
        await db.execute(sql`UPDATE communication_automations
          SET sent_count = COALESCE(sent_count,0) + ${sent},
              failed_count = COALESCE(failed_count,0) + ${failed},
              last_triggered_at = now()
          WHERE id = ${a.id}`);
      } catch {}

      console.log(`[AUTOMATION-ENGINE] ${triggerEvent} "${a.name}" mode=${mode} sent=${sent} failed=${failed}`);
    }
  } catch (e: any) {
    console.error("[AUTOMATION-ENGINE]", triggerEvent, e?.message);
  }
}


/**
 * Helper: resolve cliente/vendedor a partir de um sales_card/card e dispara.
 * Usado nos ganchos de pedido (criado/bloqueado) onde so temos o card.
 */
export async function fireOrderAutomation(triggerEvent: string, card: any, extra: any = {}): Promise<void> {
  try {
    const customer = card?.customerId ? await storage.getCustomer(card.customerId) : (card?.customer || null);
    const seller = card?.sellerId ? await storage.getUser(card.sellerId) : null;
    const ctx = {
      customer: { name: (customer as any)?.fantasyName || (customer as any)?.name || card?.customer?.name || 'Cliente' },
      order: {
        id: card?.orderNumber || (card?.id ? `INT-${String(card.id).substring(0, 8)}` : ''),
        value: (Number(card?.saleValue) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      },
      seller: { name: seller ? `${(seller as any).firstName || ''} ${(seller as any).lastName || ''}`.trim() : '' },
      sellerPhone: (seller as any)?.phone || null,
      ...extra,
    };
    await fireAutomation(triggerEvent, ctx);
  } catch (e: any) {
    console.error('[AUTOMATION-ENGINE] fireOrderAutomation', e?.message);
  }
}
