// server/ultimo-atendimento.ts
// -----------------------------------------------------------------------------
// ÚLTIMO ATENDIMENTO por cliente (nov/2026 — Clientes Ativos)
// Substitui a coluna "Último Atend. Virtual", que olhava só o registro virtual e
// ficava velha (ex.: cliente com pedido em 24/11 mostrando atendimento de 09/09).
// Agora vale o atendimento MAIS RECENTE, de qualquer tipo, e QUEM fez:
//   • Virtual    — registro de atendimento virtual (virtual_service_logs; fora o
//                  contato automático da repescagem por IA);
//   • Presencial — check-in na Rota do Dia (route_checkpoints, não cancelado);
//   • Pedido     — pedido implantado (billing_pipeline, fora a lixeira) — quem implantou;
//   • Não venda  — card fechado como "não venda" (sales_cards.status = 'no_sale').
// GET /api/clientes/ultimo-atendimento → { [customerId]: { data, tipo, quem } }
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);

let cache: { em: number; mapa: Record<string, { data: string; tipo: string; quem: string }> } | null = null;

export function registerUltimoAtendimento(app: Express): void {
  app.get("/api/clientes/ultimo-atendimento", authenticateUser, async (_req, res) => {
    try {
      if (cache && Date.now() - cache.em < 30_000) return res.json(cache.mapa);
      const r = rows(await db.execute(sql`
        WITH ev AS (
          (SELECT DISTINCT ON (v.customer_id) v.customer_id, v.attendance_date AS data,
                  CASE WHEN COALESCE(v.service_type,'') = 'nao_venda' THEN 'Virtual · não venda' ELSE 'Virtual' END AS tipo,
                  v.attendant_id AS uid, v.attendant_name AS nome_txt
             FROM virtual_service_logs v
            WHERE v.entity_type = 'customer' AND v.customer_id IS NOT NULL AND v.attendance_date IS NOT NULL
              AND NOT (COALESCE(v.attendant_id,'') = 'ia' AND COALESCE(v.service_type,'') = 'repescagem_ia')
            ORDER BY v.customer_id, v.attendance_date DESC)
          UNION ALL
          (SELECT DISTINCT ON (rc.customer_id) rc.customer_id, rc.checkpoint_time AS data, 'Presencial' AS tipo,
                  rc.seller_id AS uid, NULL::text AS nome_txt
             FROM route_checkpoints rc
            WHERE rc.checkpoint_type = 'check_in' AND rc.checkpoint_time IS NOT NULL
              AND COALESCE(rc.validation_status,'') <> 'cancelled'
            ORDER BY rc.customer_id, rc.checkpoint_time DESC)
          UNION ALL
          (SELECT DISTINCT ON (bp.customer_id) bp.customer_id, bp.created_at AS data,
                  CASE WHEN COALESCE(bp.operation_type,'venda') = 'troca' THEN 'Troca'
                       WHEN COALESCE(bp.operation_type,'venda') = 'amostra' THEN 'Amostra'
                       ELSE 'Pedido' END AS tipo,
                  COALESCE(NULLIF(bp.seller_id,''), bp.created_by) AS uid, NULL::text AS nome_txt
             FROM billing_pipeline bp
            WHERE bp.stage::text <> 'lixeira' AND bp.created_at IS NOT NULL
            ORDER BY bp.customer_id, bp.created_at DESC)
          UNION ALL
          (SELECT DISTINCT ON (sc.customer_id) sc.customer_id, sc.completed_date AS data, 'Não venda' AS tipo,
                  sc.seller_id AS uid, NULL::text AS nome_txt
             FROM sales_cards sc
            WHERE sc.status = 'no_sale' AND sc.completed_date IS NOT NULL
            ORDER BY sc.customer_id, sc.completed_date DESC)
        ), ultimo AS (
          SELECT DISTINCT ON (customer_id) * FROM ev ORDER BY customer_id, data DESC
        )
        SELECT u.customer_id, u.data, u.tipo,
               CASE WHEN u.uid = 'ia' THEN 'IA'
                    ELSE COALESCE(NULLIF(TRIM(CONCAT(us.first_name, ' ', us.last_name)), ''), us.email, u.nome_txt, u.uid, '')
               END AS quem
          FROM ultimo u
          LEFT JOIN LATERAL (
            SELECT first_name, last_name, email FROM users
             WHERE id = u.uid
                OR (u.uid LIKE 'omie-vendor-%' AND omie_vendor_code = substring(u.uid from 13))
                OR (u.uid IS NOT NULL AND u.uid LIKE '%@%' AND lower(email) = lower(u.uid))
             LIMIT 1) us ON true`));
      const mapa: Record<string, { data: string; tipo: string; quem: string }> = {};
      for (const x of r) {
        let quem = String(x.quem || "").trim();
        // Nome de e-mail ("leticia@bebahonest...") vira só o nome antes do @.
        if (quem.includes("@")) quem = quem.split("@")[0];
        mapa[String(x.customer_id)] = { data: x.data, tipo: String(x.tipo || ""), quem };
      }
      cache = { em: Date.now(), mapa };
      res.json(mapa);
    } catch (e: any) {
      console.error("[ultimo-atendimento]", e?.message);
      res.status(500).json({ message: "Falha ao buscar últimos atendimentos" });
    }
  });
}
