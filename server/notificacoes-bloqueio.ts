// server/notificacoes-bloqueio.ts
// -----------------------------------------------------------------------------
// 🔕 NÃO ENVIAR NOTIFICAÇÕES PARA ESTE TELEFONE (nov/2026 — regra do Flávio)
// Flag SOMENTE ADMIN no cadastro do cliente: o telefone está confirmado, mas o
// cliente não quer receber notificações. Enquanto marcada:
//   • NENHUM template oficial (WhatsApp 1841) é enfileirado para o cliente ou para
//     o número dele — campanhas, confirmações, rota do dia, recompra, pedido etc.;
//   • mensagens automáticas/proativas por texto (Umbler Talk e 1841) para esse
//     número são barradas;
//   • RESPOSTA em conversa continua: se o cliente escreveu nas últimas 24h, o
//     atendimento (humano ou IA) responde normalmente — responder não é notificar.
// O bloqueio vale para o NÚMERO: qualquer cadastro com o mesmo telefone fica protegido.
// Toda marcação/desmarcação fica no histórico do cliente (quem, quando, motivo).
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { analisarTelefoneBR } from "../shared/telefone";

const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);

let __colPronta: Promise<void> | null = null;
export function ensureColunasNotificacao(): Promise<void> {
  if (!__colPronta) {
    __colPronta = (async () => {
      await db.execute(sql`ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS notificacoes_bloqueadas boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS notificacoes_bloqueadas_em timestamptz,
        ADD COLUMN IF NOT EXISTS notificacoes_bloqueadas_por text,
        ADD COLUMN IF NOT EXISTS notificacoes_bloqueadas_motivo text`);
    })().catch((e) => { __colPronta = null; throw e; });
  }
  return __colPronta;
}

/** Chave do telefone: DDD + número no padrão (sem 55, com o 9). '' quando não dá. */
export function chaveTelefone(v: any): string {
  let d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  const a = analisarTelefoneBR(d);
  return a.valido ? a.digitos : d.slice(-10);
}

// Cache curto (60s) — consultado a cada envio.
let __cache: { em: number; ids: Set<string>; fones: Set<string>; equipe: Set<string> } | null = null;
async function carregar(): Promise<{ ids: Set<string>; fones: Set<string>; equipe: Set<string> }> {
  if (__cache && Date.now() - __cache.em < 60_000) return __cache;
  const ids = new Set<string>();
  const fones = new Set<string>();
  // Telefones da EQUIPE (usuários do Integra) nunca são barrados: há cadastro de cliente com
  // o celular do vendedor, e marcar esse cliente não pode calar os avisos internos do vendedor.
  const equipe = new Set<string>();
  try {
    await ensureColunasNotificacao();
    for (const r of rows(await db.execute(sql`SELECT id, phone FROM customers WHERE notificacoes_bloqueadas = true`))) {
      ids.add(String(r.id));
      const k = chaveTelefone(r.phone);
      if (k) fones.add(k);
    }
    if (ids.size) {
      for (const u of rows(await db.execute(sql`SELECT phone FROM users WHERE phone IS NOT NULL AND phone <> ''`))) {
        const k = chaveTelefone(u.phone);
        if (k) equipe.add(k);
      }
    }
  } catch { /* sem conseguir ler, não bloqueia ninguém */ }
  __cache = { em: Date.now(), ids, fones, equipe };
  return __cache;
}
export function limparCacheNotificacao() { __cache = null; }

/** true quando o cliente (ou o número) está marcado para NÃO receber notificações. */
export async function notificacaoBloqueada(p: { customerId?: string | null; phone?: string | null }): Promise<boolean> {
  const c = await carregar();
  if (!c.ids.size) return false;
  if (p.customerId && c.ids.has(String(p.customerId))) return true;
  const k = chaveTelefone(p.phone);
  if (!k || c.equipe.has(k)) return false; // telefone de usuário do Integra: aviso interno passa
  return c.fones.has(k);
}

/** O cliente escreveu nas últimas `horas` (é conversa, não notificação)? */
export async function clienteFalouRecente(phone: any, horas = 24): Promise<boolean> {
  const k = chaveTelefone(phone);
  if (!k) return false;
  const k8 = k.slice(-8);
  try {
    const r = rows(await db.execute(sql`
      SELECT 1
        FROM chat_conversations c
        JOIN chat_messages m ON m.conversation_id = c.id
       WHERE right(regexp_replace(COALESCE(c.customer_phone,''), '[^0-9]', '', 'g'), 8) = ${k8}
         AND m.sender_type = 'customer'
         AND m.created_at > now() - make_interval(hours => ${horas})
       LIMIT 1`));
    return r.length > 0;
  } catch {
    return false;
  }
}

/** Para envios de TEXTO: barra só quando o número está bloqueado E não é resposta a conversa. */
export async function envioTextoBarrado(phone: any): Promise<boolean> {
  try {
    if (!(await notificacaoBloqueada({ phone }))) return false;
    return !(await clienteFalouRecente(phone));
  } catch {
    return false;
  }
}

export function registerNotificacoesBloqueio(app: Express): void {
  void ensureColunasNotificacao().catch((e) => console.warn("[notificacoes-bloqueio] coluna:", e?.message));

  // Situação do cliente (qualquer usuário logado pode ver o selo).
  app.get("/api/customers/:id/notificacoes", authenticateUser, async (req: any, res) => {
    try {
      await ensureColunasNotificacao();
      const r = rows(await db.execute(sql`
        SELECT notificacoes_bloqueadas AS b, notificacoes_bloqueadas_em AS em,
               notificacoes_bloqueadas_por AS por, notificacoes_bloqueadas_motivo AS motivo
          FROM customers WHERE id = ${String(req.params.id)} LIMIT 1`))[0];
      if (!r) return res.status(404).json({ message: "Cliente não encontrado" });
      res.json({ bloqueado: r.b === true, em: r.em || null, por: r.por || null, motivo: r.motivo || null });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "falha" });
    }
  });

  // Lista de ids bloqueados (para o selo nas listas).
  app.get("/api/notificacoes-bloqueadas", authenticateUser, async (_req, res) => {
    try {
      const c = await carregar();
      res.json({ ids: Array.from(c.ids) });
    } catch (e: any) {
      res.status(500).json({ ids: [], message: e?.message || "falha" });
    }
  });

  // Marca/desmarca — SOMENTE ADMIN. Body: { bloquear: boolean, motivo?: string }
  app.put("/api/customers/:id/notificacoes", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      await ensureColunasNotificacao();
      const id = String(req.params.id);
      const bloquear = req.body?.bloquear === true;
      const motivo = String(req.body?.motivo || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const u: any = req.user || {};
      const quem = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Admin";
      const atual = rows(await db.execute(sql`SELECT notificacoes_bloqueadas AS b, phone FROM customers WHERE id = ${id} LIMIT 1`))[0];
      if (!atual) return res.status(404).json({ message: "Cliente não encontrado" });
      if (bloquear) {
        await db.execute(sql`UPDATE customers SET notificacoes_bloqueadas = true, notificacoes_bloqueadas_em = now(),
                               notificacoes_bloqueadas_por = ${quem}, notificacoes_bloqueadas_motivo = ${motivo || null}
                             WHERE id = ${id}`);
      } else {
        await db.execute(sql`UPDATE customers SET notificacoes_bloqueadas = false, notificacoes_bloqueadas_em = now(),
                               notificacoes_bloqueadas_por = ${quem}, notificacoes_bloqueadas_motivo = NULL
                             WHERE id = ${id}`);
      }
      limparCacheNotificacao();
      if ((atual.b === true) !== bloquear) {
        try {
          await db.execute(sql`
            INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source)
            VALUES (${id}, 'notificacoes', 'Notificações do telefone',
                    ${atual.b === true ? "Bloqueadas" : "Recebe"},
                    ${bloquear ? `Bloqueadas (${atual.phone || "sem telefone"})${motivo ? " — Motivo: " + motivo : ""}` : "Recebe"},
                    ${u.id ? String(u.id) : null}, ${quem}, 'admin-notificacoes')`);
        } catch (e: any) { console.warn("[notificacoes-bloqueio] histórico:", e?.message); }
      }
      res.json({ ok: true, bloqueado: bloquear });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "falha" });
    }
  });
}
