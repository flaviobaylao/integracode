// server/telefone-padronizacao.ts
// -----------------------------------------------------------------------------
// PADRONIZAÇÃO DOS TELEFONES DOS CLIENTES (nov/2026 — pedido do Flávio)
// Regra em shared/telefone.ts (analisarTelefoneBR). Aqui:
//   POST /api/admin/telefones/padronizar  { dry?: boolean (padrão true), limite?: number }
//     → percorre TODOS os cadastros (ativos e inativos), corrige/esvazia customers.phone
//       e grava cada mudança no histórico do cliente (de → para, quem, quando, motivo).
//   Confirmação de WhatsApp: quando a mudança é só de formato (tirar +55 / incluir o 9),
//   o número é o mesmo — a confirmação já feita acompanha o número novo.
// customers.phone é NOT NULL → "vazio" = ''.
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { randomUUID } from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { analisarTelefoneBR } from "../shared/telefone";

const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);

type Mudanca = {
  id: string; cliente: string; ativo: boolean; vendedor: string;
  antes: string; depois: string; situacao: string; motivo: string;
};

export async function padronizarTelefones(opts: { dry: boolean; limite?: number; actor: { id: string | null; name: string } }) {
  const lista = rows(await db.execute(sql`
    SELECT c.id, c.phone, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome,
           COALESCE(c.is_active, true) AS ativo, COALESCE(c.seller_id,'') AS seller_id,
           COALESCE(NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),''), '') AS vendedor
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT first_name, last_name FROM users
      WHERE id = c.seller_id OR ('omie-vendor-' || COALESCE(omie_vendor_code,'')) = c.seller_id OR omie_vendor_code = c.seller_id
      LIMIT 1) u ON true
    ORDER BY c.id`));

  const contagem: Record<string, number> = { manter: 0, vazio: 0, corrigir: 0, esvaziar: 0 };
  const porMotivo: Record<string, number> = {};
  const mudancas: Mudanca[] = [];
  for (const c of lista) {
    const a = analisarTelefoneBR(c.phone);
    contagem[a.situacao] = (contagem[a.situacao] || 0) + 1;
    if (a.situacao !== "corrigir" && a.situacao !== "esvaziar") continue;
    porMotivo[a.motivo] = (porMotivo[a.motivo] || 0) + 1;
    mudancas.push({
      id: String(c.id), cliente: String(c.nome || ""), ativo: c.ativo !== false, vendedor: String(c.vendedor || c.seller_id || ""),
      antes: String(c.phone ?? ""), depois: a.novo, situacao: a.situacao, motivo: a.motivo,
    });
  }

  const alvo = opts.limite && opts.limite > 0 ? mudancas.slice(0, opts.limite) : mudancas;
  let aplicadas = 0, confirmacoesMantidas = 0, falhas = 0;
  if (!opts.dry) {
    for (const m of alvo) {
      try {
        // Só altera se o telefone ainda for o mesmo lido acima (não atropela edição feita no meio).
        const up = rows(await db.execute(sql`
          UPDATE customers SET phone = ${m.depois}, updated_at = now()
          WHERE id = ${m.id} AND phone IS NOT DISTINCT FROM ${m.antes}
          RETURNING id`));
        if (!up.length) continue;
        aplicadas++;
        const label = m.situacao === "esvaziar"
          ? `Telefone — padronização: apagado (${m.motivo})`
          : `Telefone — padronização (${m.motivo})`;
        const novoTxt = m.depois || "— (vazio: preencher no próximo pedido)";
        // A trigger de auditoria pode já ter gravado esta mudança: assume a linha dela em vez de duplicar.
        const tr = rows(await db.execute(sql`
          UPDATE customer_change_history SET label = ${label}, old_value = ${m.antes}, new_value = ${novoTxt},
                 changed_by_user_id = ${opts.actor.id}, changed_by_name = ${opts.actor.name}, source = 'padronizacao-telefone'
          WHERE id = (SELECT id FROM customer_change_history
                      WHERE customer_id = ${m.id} AND field IN ('phone','telefone') AND source = 'trigger'
                        AND created_at > now() - interval '20 seconds'
                      ORDER BY created_at DESC LIMIT 1)
          RETURNING id`));
        if (!tr.length) {
          await db.execute(sql`
            INSERT INTO customer_change_history (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source)
            VALUES (${m.id}, 'phone', ${label}, ${m.antes}, ${novoTxt}, ${opts.actor.id}, ${opts.actor.name}, 'padronizacao-telefone')`);
        }
        // Mesmo número, só formato (+55 / 9 do celular): a confirmação de WhatsApp acompanha.
        if (m.situacao === "corrigir" && !m.motivo.includes("pôs o 9 na frente")) {
          const velho = m.antes.replace(/\D/g, "");
          const novo = m.depois.replace(/\D/g, "");
          const conf = rows(await db.execute(sql`
            SELECT customer_name, created_by, confirmed_at FROM phone_verifications
            WHERE customer_id = ${m.id} AND phone_digits = ${velho} AND status = 'confirmed'
            ORDER BY confirmed_at DESC NULLS LAST LIMIT 1`).catch(() => []));
          if (conf.length) {
            await db.execute(sql`
              INSERT INTO phone_verifications (customer_id, phone, phone_digits, customer_name, token, status, created_by, sent_at, confirmed_at)
              VALUES (${m.id}, ${m.depois}, ${novo}, ${conf[0].customer_name}, ${randomUUID().replace(/-/g, "")}, 'confirmed',
                      ${conf[0].created_by || "padronizacao-telefone"}, now(), ${conf[0].confirmed_at || null})`);
            confirmacoesMantidas++;
          }
        }
      } catch (e: any) {
        falhas++;
        console.warn("[telefone-padronizacao] falha", m.id, e?.message);
      }
    }
  }

  return {
    dry: opts.dry,
    totalCadastros: lista.length,
    contagem,
    porMotivo,
    aMudar: mudancas.length,
    aMudarAtivos: mudancas.filter((m) => m.ativo).length,
    aplicadas,
    confirmacoesMantidas,
    falhas,
    mudancas: alvo,
  };
}

export function registerTelefonePadronizacao(app: Express): void {
  app.post("/api/admin/telefones/padronizar", authenticateUser, requireRole(["admin"]), async (req: any, res) => {
    try {
      const b: any = req.body || {};
      const u: any = req.user || {};
      const actor = {
        id: u.id ? String(u.id) : null,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Admin",
      };
      const dry = !(b.dry === false || b.dry === "0" || b.dry === "false");
      const out = await padronizarTelefones({ dry, limite: Number(b.limite) || 0, actor });
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });
}
