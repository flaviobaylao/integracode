// server/repescagem-retirar.ts
// -----------------------------------------------------------------------------
// TIRAR DA REPESCAGEM (Admin, a partir do Inbox) — 10/nov/2026.
//
// Regra do Flavio: o admin pode tirar um cliente da repescagem, com JUSTIFICATIVA
// obrigatória. O efeito vale SÓ NAQUELE DIA:
//   • as alocações ativas do cliente (pendente, ou na rota de hoje) são canceladas →
//     ele some de todas as listas de repescagem e das rotas do dia;
//   • o sorteio/reconciliação do dia não o recoloca (computeRedCandidates filtra
//     os retirados de hoje);
//   • quem estava com ele (atribuído ou capturado) é avisado do motivo — WhatsApp
//     interno + alerta em tela ao entrar no Integra.
// No dia seguinte nada disso vale mais: ele volta às regras normais de repescagem.
//
// 16/nov/2026 (Flavio) — novas regras:
//   • cliente CAPTURADO por alguém não pode ser tirado (fica na repescagem);
//   • tirado, ele sai NA HORA e não volta NESTE CICLO: é como se tivesse sido atendido. Só volta
//     a cair se perder a PRÓXIMA visita (nova âncora). A âncora (visita perdida) fica gravada;
//   • o envio forçado do próximo dia útil (botão "Repescagem") é cancelado junto.
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { hojeBR } from "@shared/tempo";
import { logCustomerNote } from "./customerAudit";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);

let ensured = false;
export async function ensureRetiradosTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql.raw(
    "CREATE TABLE IF NOT EXISTS repescagem_retirados (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "customer_id varchar NOT NULL, " +
    "dia varchar NOT NULL, " +
    "motivo text NOT NULL, " +
    "report_id varchar, " +
    "created_by varchar, " +
    "created_by_name varchar, " +
    "notificados jsonb NOT NULL DEFAULT '[]'::jsonb, " +
    "created_at timestamptz DEFAULT now())"
  ));
  await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS ux_rep_retirados_cust_dia ON repescagem_retirados (customer_id, dia)"));
  await db.execute(sql.raw("ALTER TABLE repescagem_retirados ADD COLUMN IF NOT EXISTS ancora varchar"));
  await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS forced_at timestamp"));
  ensured = true;
}

/** Clientes retirados da repescagem HOJE (BR). Nunca estoura: em erro devolve vazio. */
export async function retiradosHoje(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    await ensureRetiradosTable();
    const r = rowsOf(await db.execute(sql`SELECT customer_id FROM repescagem_retirados WHERE dia = ${hojeBR()}`));
    for (const x of r) if (x.customer_id) out.add(String(x.customer_id));
  } catch (e: any) { console.warn("[repescagem-retirar] retiradosHoje:", e?.message); }
  return out;
}

/** "customerId|âncora" dos clientes tirados pelo Admin no ciclo da âncora (não voltam até nova visita perdida). */
export async function retiradosNoCiclo(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    await ensureRetiradosTable();
    const r = rowsOf(await db.execute(sql`SELECT customer_id, ancora FROM repescagem_retirados
      WHERE ancora IS NOT NULL AND created_at > now() - interval '120 days'`));
    for (const x of r) if (x.customer_id && x.ancora) out.add(`${x.customer_id}|${x.ancora}`);
  } catch (e: any) { console.warn("[repescagem-retirar] retiradosNoCiclo:", e?.message); }
  return out;
}

function nomeUser(u: any): string {
  return (((u?.first_name || "") + " " + (u?.last_name || "")).trim() || (u?.email ? String(u.email).split("@")[0] : "")) || "Admin";
}

export function registerRepescagemRetirar(app: Express, opts: { authenticateUser: any; requireRole: (roles: string[]) => any }) {
  const { authenticateUser, requireRole } = opts;

  // POST /api/repescagem/retirar { customerId, motivo, reportId? } — admin.
  app.post("/api/repescagem/retirar", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureRetiradosTable();
      const u = req.currentUser || {};
      const customerId = String(req.body?.customerId || "").trim();
      const motivo = String(req.body?.motivo || "").trim().slice(0, 1000);
      const reportId = req.body?.reportId ? String(req.body.reportId) : null;
      if (!customerId) return res.status(400).json({ message: "customerId obrigatório" });
      if (motivo.length < 5) return res.status(400).json({ message: "Informe a justificativa (mínimo 5 caracteres)." });
      const hoje = hojeBR();
      const cli = rowsOf(await db.execute(sql`SELECT id, COALESCE(NULLIF(fantasy_name, ''), name) AS nome FROM customers WHERE id = ${customerId} LIMIT 1`))[0];
      if (!cli) return res.status(404).json({ message: "Cliente não encontrado" });
      const adminNome = nomeUser({ first_name: u.firstName, last_name: u.lastName, email: u.email }) || u.name || "Admin";

      // Alocações ativas hoje: pendente, ou na rota (sorteio) de hoje.
      const ativas = rowsOf(await db.execute(sql`
        SELECT id, assigned_user_id, status, locked, locked_by, locked_date
          FROM repescagem_assignments
         WHERE customer_id = ${customerId}
           AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${hoje}))`));

      // CAPTURADO por alguém hoje: não sai da repescagem (16/nov/2026).
      const capt = ativas.find((a: any) => a.locked && a.locked_by && String(a.locked_date || "") === hoje);
      if (capt) {
        const cu = rowsOf(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${String(capt.locked_by)} LIMIT 1`))[0];
        return res.status(409).json({ message: `${cli.nome} está capturado por ${cu ? nomeUser(cu) : "um atendente"} e continua na repescagem. Ele só pode ser tirado se não estiver capturado.` });
      }
      // Âncora do ciclo (visita perdida que fez o cliente cair): com ela, ele não volta neste ciclo.
      const anc = rowsOf(await db.execute(sql`
        SELECT last_red_date FROM repescagem_assignments
         WHERE customer_id = ${customerId} AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${hoje}))
           AND forced_at IS NULL AND last_red_date IS NOT NULL AND last_red_date < ${hoje}
         ORDER BY last_red_date DESC LIMIT 1`).catch(() => ({ rows: [] })))[0];
      const ancora: string | null = anc?.last_red_date ? String(anc.last_red_date) : null;

      // Quem precisa ser avisado: o atendente atribuído e quem capturou hoje.
      const afetados = new Set<string>();
      for (const a of ativas) {
        if (a.assigned_user_id) afetados.add(String(a.assigned_user_id));
        if (a.locked && a.locked_by && String(a.locked_date || "") === hoje) afetados.add(String(a.locked_by));
      }

      if (ativas.length) {
        const ids = sql.join(ativas.map((a: any) => sql`${String(a.id)}`), sql`, `);
        await db.execute(sql`
          UPDATE repescagem_assignments
             SET status = 'cancelled', locked = false, updated_at = now()
           WHERE id IN (${ids})`);
        for (const a of ativas) {
          try {
            await db.execute(sql`
              INSERT INTO repescagem_assignment_history (id, assignment_id, customer_id, from_user_id, to_user_id, action, reason, created_at)
              VALUES (gen_random_uuid(), ${String(a.id)}, ${customerId}, ${a.assigned_user_id || null}, NULL, 'cancelled',
                      ${"Retirado da repescagem pelo Admin (sai neste ciclo): " + motivo}, now())`);
          } catch (e: any) { console.warn("[repescagem-retirar] history:", e?.message); }
        }
      }

      // Aviso a quem estava com o cliente: WhatsApp interno (melhor esforço) + alerta em tela.
      const notificados: any[] = [];
      if (afetados.size) {
        // O atendente pode estar gravado como users.id ou como "omie-vendor-<código>".
        const lista = sql.join(Array.from(afetados).map((x) => sql`${x}`), sql`, `);
        const us = rowsOf(await db.execute(sql`
          SELECT DISTINCT id, first_name, last_name, email, phone FROM users
           WHERE id IN (${lista}) OR ('omie-vendor-' || omie_vendor_code) IN (${lista})`));
        const texto = `Olá! O cliente ${cli.nome} foi RETIRADO da repescagem hoje pelo Admin (${adminNome}).\n` +
          `Motivo: ${motivo}\n\nEle saiu da sua lista/rota de repescagem e não volta neste ciclo; só cai de novo se perder a próxima visita. — INTEGRA 2.0`;
        for (const x of us) {
          let whatsapp = false;
          if (x.phone) {
            try {
              const { enviarInterno } = await import("./envio-texto");
              const r: any = await enviarInterno(String(x.phone), texto);
              whatsapp = !!r?.success;
            } catch (e: any) { console.warn("[repescagem-retirar] whatsapp:", e?.message); }
          }
          notificados.push({ userId: String(x.id), nome: nomeUser(x), whatsapp });
        }
      }

      // O envio forçado para o próximo dia útil (botão "Repescagem") também é cancelado.
      try { await db.execute(sql`DELETE FROM repescagem_forced WHERE customer_id = ${customerId} AND forced_date > ${hoje}`); } catch { /* tabela pode não existir */ }
      await db.execute(sql`
        INSERT INTO repescagem_retirados (customer_id, dia, motivo, report_id, created_by, created_by_name, notificados, ancora)
        VALUES (${customerId}, ${hoje}, ${motivo}, ${reportId}, ${u.id || null}, ${adminNome}, ${JSON.stringify(notificados)}::jsonb, ${ancora})
        ON CONFLICT (customer_id, dia) DO UPDATE
          SET motivo = EXCLUDED.motivo, report_id = EXCLUDED.report_id, created_by = EXCLUDED.created_by,
              created_by_name = EXCLUDED.created_by_name, ancora = COALESCE(EXCLUDED.ancora, repescagem_retirados.ancora),
              notificados = repescagem_retirados.notificados || EXCLUDED.notificados, created_at = now()`);

      try {
        await logCustomerNote({
          customerId, label: "Retirado da repescagem (Admin)",
          text: `Retirado da repescagem em ${hoje.split("-").reverse().join("/")} (não volta neste ciclo; só cai de novo se perder a próxima visita). Motivo: ${motivo}` +
            (notificados.length ? ` — avisado(s): ${notificados.map((n) => n.nome).join(", ")}` : ""),
          actor: { id: u.id || "admin", name: adminNome } as any, source: "repescagem",
        });
      } catch (_e) {}

      // Registra na conversa do report de origem (se veio de um report do Inbox).
      if (reportId) {
        try {
          const msg = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            role: "admin", by: u.id || null, byName: adminNome, at: new Date().toISOString(), kind: "repescagem_retirada",
            text: `🚫 Retirado da repescagem (não volta neste ciclo). Motivo: ${motivo}` + (notificados.length ? ` (avisado: ${notificados.map((n) => n.nome).join(", ")})` : ""),
          };
          await db.execute(sql`UPDATE change_requests SET messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb WHERE id = ${reportId}`);
        } catch (_e) {}
      }

      res.json({ ok: true, customerId, dia: hoje, ancora, cancelados: ativas.length, notificados });
    } catch (e: any) {
      console.error("POST /api/repescagem/retirar", e);
      res.status(500).json({ message: e?.message || "erro" });
    }
  });

  // GET /api/repescagem/meus-retirados — avisos de HOJE para quem estava com o cliente.
  app.get("/api/repescagem/meus-retirados", authenticateUser, async (req: any, res) => {
    try {
      await ensureRetiradosTable();
      const uid = String(req.currentUser?.id || "");
      if (!uid) return res.json({ itens: [] });
      const r = rowsOf(await db.execute(sql`
        SELECT rr.customer_id, rr.motivo, rr.created_by_name, COALESCE(NULLIF(c.fantasy_name, ''), c.name) AS nome
          FROM repescagem_retirados rr LEFT JOIN customers c ON c.id = rr.customer_id
         WHERE rr.dia = ${hojeBR()}
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(rr.notificados) n WHERE n->>'userId' = ${uid})`));
      res.json({ itens: r.map((x: any) => ({ customerId: x.customer_id, cliente: x.nome || x.customer_id, motivo: x.motivo, por: x.created_by_name })) });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "erro" });
    }
  });
}
