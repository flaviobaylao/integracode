// ============================================================================
// Gestão de Automações de Comunicação (WhatsApp) — CRUD + teste + modo global.
// Consumido pela aba "🔔 Notificações" dentro de Agentes IA. Admin-only.
// A tabela communication_automations NÃO é sincronizada do 1.0 (sync desligado),
// então edições feitas aqui persistem e valem no próximo disparo, sem deploy.
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { sendUmblerTalkText } from "./chat-routes";
import { normalizeBrPhone } from "./automation-engine";

// Gatilhos que o CÓDIGO realmente dispara hoje (fired=true). Outros podem existir
// na base por herança do 1.0, mas não enviam até haver um gancho no código.
const KNOWN_TRIGGERS = [
  { event: "pedido.criado", label: "Pedido implantado (inclui bloqueados, com aviso em CAIXA ALTA)", fired: true },
  { event: "entrega.finalizada", label: "Entrega finalizada", fired: true },
  { event: "pedido.bloqueado", label: "Pedido bloqueado (evento NÃO disparado pelo código — use 'pedido.criado')", fired: false },
];

const PLACEHOLDERS = [
  { token: "{{customer.name}}", desc: "Nome do cliente (fantasia)" },
  { token: "{{order.id}}", desc: "Nº do pedido (ex.: INT-1a2b3c4d)" },
  { token: "{{order.value}}", desc: "Valor do pedido (ex.: R$ 123,45)" },
  { token: "{{seller.name}}", desc: "Nome do vendedor" },
  { token: "{{delivery.orderNumber}}", desc: "Nº do pedido na entrega" },
  { token: "{{driver.name}}", desc: "Nome do motorista" },
  { token: "{{blockNotice}}", desc: "Aviso de bloqueio em CAIXA ALTA (só quando o pedido nasce bloqueado)" },
];

function renderTemplate(tpl: string, ctx: any): string {
  return String(tpl ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const val = String(path).split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), ctx);
    return val == null ? "" : String(val);
  });
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null || v === undefined ? def : String(v);
  } catch { return def; }
}

async function setSetting(key: string, value: string, by: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
    VALUES (${key}, ${value}, ${by})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
}

// Monta o recipient_type (conjunto separado por ';') a partir dos flags do formulário.
function buildRecipientType(body: any): string {
  const parts: string[] = [];
  if (body?.toSeller) parts.push("vendedor_pedido");
  if (body?.toFixed) parts.push("fixo");
  if (body?.toUser) parts.push("usuario");
  // fallback: se vier recipient_type cru, respeita
  if (parts.length === 0 && typeof body?.recipient_type === "string" && body.recipient_type.trim()) {
    return body.recipient_type.trim();
  }
  return parts.join(";");
}

export function registerCommunicationAutomationsRoutes(app: Express) {
  // Lista todas as automações
  app.get("/api/admin/automations", authenticateUser, requireRole(["admin"]), async (_req: any, res: any) => {
    try {
      const r: any = await db.execute(sql`SELECT * FROM communication_automations ORDER BY name NULLS LAST, created_at DESC`);
      res.json({ automations: r.rows || [] });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao listar automações" });
    }
  });

  // Metadados p/ a tela: modo global, nº de teste, gatilhos, placeholders, usuários
  app.get("/api/admin/automations/meta", authenticateUser, requireRole(["admin"]), async (_req: any, res: any) => {
    try {
      const mode = (await getSetting("automations_mode", "off")).toLowerCase();
      const testNumber = await getSetting("automations_test_number", "5562995782812");
      let users: any[] = [];
      try {
        const u: any = await db.execute(sql`SELECT id, first_name, last_name, phone, role FROM users WHERE is_active = true ORDER BY first_name NULLS LAST`);
        users = (u.rows || []).map((x: any) => ({
          id: x.id,
          name: `${x.first_name || ""} ${x.last_name || ""}`.trim() || x.id,
          phone: x.phone || null,
          role: x.role || null,
        }));
      } catch {}
      res.json({ mode, testNumber, triggers: KNOWN_TRIGGERS, placeholders: PLACEHOLDERS, users });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao carregar metadados" });
    }
  });

  // Cria uma automação
  app.post("/api/admin/automations", authenticateUser, requireRole(["admin"]), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const name = String(b.name || "").trim();
      const triggerEvent = String(b.trigger_event || "").trim();
      const template = String(b.message_template || "");
      if (!name) return res.status(400).json({ error: "Informe um nome." });
      if (!triggerEvent) return res.status(400).json({ error: "Escolha um gatilho." });
      if (!template.trim()) return res.status(400).json({ error: "Escreva a mensagem." });
      const recipientType = buildRecipientType(b);
      const fixedPhone = b.recipient_fixed_phone ? String(b.recipient_fixed_phone).trim() : null;
      const userId = b.recipient_user_id ? String(b.recipient_user_id).trim() : null;
      const isActive = b.is_active === undefined ? true : !!b.is_active;
      const by = req.currentUser?.email || req.user?.email || "admin";
      const r: any = await db.execute(sql`
        INSERT INTO communication_automations
          (id, name, description, is_active, trigger_event, recipient_type, recipient_fixed_phone, recipient_user_id, message_template, channel, sent_count, failed_count, created_by, created_at, updated_at)
        VALUES
          (gen_random_uuid(), ${name}, ${b.description ? String(b.description) : null}, ${isActive}, ${triggerEvent}, ${recipientType || null}, ${fixedPhone}, ${userId}, ${template}, 'whatsapp', 0, 0, ${by}, now(), now())
        RETURNING *`);
      res.json({ ok: true, automation: (r.rows || [])[0] || null });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao criar automação" });
    }
  });

  // Edita uma automação (campos parciais)
  app.patch("/api/admin/automations/:id", authenticateUser, requireRole(["admin"]), async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const b = req.body || {};
      const sets: any[] = [];
      if (b.name !== undefined) sets.push(sql`name = ${String(b.name)}`);
      if (b.description !== undefined) sets.push(sql`description = ${b.description ? String(b.description) : null}`);
      if (b.trigger_event !== undefined) sets.push(sql`trigger_event = ${String(b.trigger_event)}`);
      if (b.message_template !== undefined) sets.push(sql`message_template = ${String(b.message_template)}`);
      if (b.is_active !== undefined) sets.push(sql`is_active = ${!!b.is_active}`);
      // Destinatário: aceita flags (toSeller/toFixed/toUser) OU recipient_type cru
      if (b.toSeller !== undefined || b.toFixed !== undefined || b.toUser !== undefined || b.recipient_type !== undefined) {
        sets.push(sql`recipient_type = ${buildRecipientType(b) || null}`);
      }
      if (b.recipient_fixed_phone !== undefined) sets.push(sql`recipient_fixed_phone = ${b.recipient_fixed_phone ? String(b.recipient_fixed_phone).trim() : null}`);
      if (b.recipient_user_id !== undefined) sets.push(sql`recipient_user_id = ${b.recipient_user_id ? String(b.recipient_user_id).trim() : null}`);
      if (sets.length === 0) return res.status(400).json({ error: "Nada para atualizar." });
      sets.push(sql`updated_at = now()`);
      const r: any = await db.execute(sql`UPDATE communication_automations SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING *`);
      if (!(r.rows || []).length) return res.status(404).json({ error: "Automação não encontrada." });
      res.json({ ok: true, automation: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao atualizar automação" });
    }
  });

  // Exclui uma automação
  app.delete("/api/admin/automations/:id", authenticateUser, requireRole(["admin"]), async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const r: any = await db.execute(sql`DELETE FROM communication_automations WHERE id = ${id}`);
      const n = (r.rowCount ?? r.rowsAffected ?? 0) as number;
      if (!n) return res.status(404).json({ error: "Automação não encontrada." });
      res.json({ ok: true, deleted: n });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao excluir automação" });
    }
  });

  // Envia um TESTE: renderiza o template com dados de exemplo e manda pro número de teste
  // (ou para um telefone informado no corpo). Envio REAL de WhatsApp — consome cota.
  app.post("/api/admin/automations/:id/test", authenticateUser, requireRole(["admin"]), async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const r: any = await db.execute(sql`SELECT * FROM communication_automations WHERE id = ${id} LIMIT 1`);
      const a = (r.rows || [])[0];
      if (!a) return res.status(404).json({ error: "Automação não encontrada." });
      const target = normalizeBrPhone(req.body?.phone || await getSetting("automations_test_number", "5562995782812"));
      if (!target) return res.status(400).json({ error: "Número de teste inválido." });
      const ctx = {
        customer: { name: "CLIENTE TESTE" },
        order: { id: "INT-TESTE01", value: "R$ 123,45" },
        seller: { name: "Vendedor Teste" },
        delivery: { orderNumber: "INT-TESTE01" },
        driver: { name: "Motorista Teste" },
        blockNotice: "🚫 *PEDIDO BLOQUEADO — DÉBITO VENCIDO DO CLIENTE.* (exemplo de teste)",
      };
      let msg = renderTemplate(a.message_template, ctx);
      msg = "🧪 [TESTE] " + msg;
      const sent = await sendUmblerTalkText(target, msg);
      res.json({ ok: !!sent?.success, to: target, preview: msg, error: sent?.error || null });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro no teste" });
    }
  });

  // Define o modo global (off/test/on) e, opcionalmente, o número de teste
  app.post("/api/admin/automations/mode", authenticateUser, requireRole(["admin"]), async (req: any, res: any) => {
    try {
      const by = req.currentUser?.email || req.user?.email || "admin";
      const mode = String(req.body?.mode || "").toLowerCase();
      if (mode && !["off", "test", "on"].includes(mode)) return res.status(400).json({ error: "Modo inválido (use off/test/on)." });
      if (mode) await setSetting("automations_mode", mode, by);
      if (req.body?.testNumber !== undefined) {
        const n = normalizeBrPhone(req.body.testNumber);
        await setSetting("automations_test_number", n || String(req.body.testNumber || ""), by);
      }
      const cur = (await getSetting("automations_mode", "off")).toLowerCase();
      const testNumber = await getSetting("automations_test_number", "5562995782812");
      res.json({ ok: true, mode: cur, testNumber });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "erro ao salvar modo" });
    }
  });
}
