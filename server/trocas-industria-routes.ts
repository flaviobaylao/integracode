// ---------------------------------------------------------------------------
// TROCAS (módulo Indústria › aba Trocas) — 28/set/2026
// ---------------------------------------------------------------------------
// Lista todas as solicitações de TROCA que passaram pelo pipeline de
// faturamento: cliente, quem solicitou (vendedor do card), motivo/descrição
// (observação escrita pelo vendedor na implantação — sales_cards.notes),
// data, etapa atual e link(s) da(s) foto(s) dos produtos anexadas na troca.
//
// Fontes (somente leitura — nenhuma escrita aqui):
//   billing_pipeline (operation_type = 'troca')      → trocas liberadas no pipeline
//   blocked_orders  (operation_type = 'troca',
//                    status = 'blocked')             → trocas ainda aguardando liberação
//   sales_cards                                     → motivo (notes), vendedor, produtos,
//                                                     parent_card_id (card de origem)
//   order_pipeline_audit (outcome = 'troca_photo')  → URL da foto (coluna `error`), gravada
//                                                     contra o card de ORIGEM — por isso
//                                                     resolvemos id e parent_card_id, igual
//                                                     ao pipeline (billing-pipeline-routes.ts)
//
// Acesso: o prefixo /api/industria já exige admin no index.ts (o perfil
// "industria" chega aqui como admin, com req.perfilIndustria = true). Regra do
// Flavio (28/set): esta aba é só para ADMINS e para a NAIARA — então um perfil
// industria só passa se for um dos e-mails em TROCAS_EMAILS_PERMITIDOS.
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

// Usuários com perfil "industria" autorizados a ver as trocas (além dos admins).
export const TROCAS_EMAILS_PERMITIDOS = ["industria@bebahonest.com.br"]; // Naiara Gomes

export function podeVerTrocas(req: any): boolean {
  const u = req?.currentUser;
  if (!u) return false;
  const email = String(u.email || "").toLowerCase();
  if (TROCAS_EMAILS_PERMITIDOS.includes(email)) return true;
  // Perfil industria (mapeado para admin no middleware) que NÃO está na lista: barrado.
  if (req.perfilIndustria) return false;
  return String(u.role || "") === "admin";
}

export function registerTrocasIndustriaRoutes(app: Express) {
  // Só diz se o usuário logado pode ver a aba (o front esconde a aba com isto).
  app.get("/api/industria/trocas/acesso", async (req: any, res) => {
    res.json({ ok: podeVerTrocas(req) });
  });

  // Lista completa. Filtros opcionais: ?de=YYYY-MM-DD&ate=YYYY-MM-DD (data da solicitação).
  app.get("/api/industria/trocas", async (req: any, res) => {
    try {
      if (!podeVerTrocas(req)) return res.status(403).json({ message: "Acesso restrito a administradores e à Naiara" });

      const de = typeof req.query.de === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? req.query.de : null;
      const ate = typeof req.query.ate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate) ? req.query.ate : null;

      // 1) Trocas no pipeline de faturamento (todas as etapas, inclusive entregue e lixeira).
      const pipeRs: any = await db.execute(sql`
        SELECT bp.id, bp.sales_card_id, bp.customer_id, bp.customer_name, bp.customer_document,
               bp.seller_id, bp.seller_name, bp.stage, bp.order_number, bp.invoice_number,
               bp.sale_value, bp.notes AS pipeline_notes, bp.created_at AS pipeline_created_at,
               bp.updated_at AS pipeline_updated_at,
               sc.notes AS motivo, sc.seller_id AS card_seller_id, sc.parent_card_id, sc.products,
               sc.created_at AS card_created_at,
               c.name AS c_name, c.fantasy_name AS c_fantasy_name,
               u.first_name AS s_first_name, u.last_name AS s_last_name
        FROM billing_pipeline bp
        LEFT JOIN sales_cards sc ON sc.id = bp.sales_card_id
        LEFT JOIN customers c ON c.id = bp.customer_id
        LEFT JOIN users u ON u.id = COALESCE(sc.seller_id, bp.seller_id)
        WHERE bp.operation_type = 'troca'
        ORDER BY bp.created_at DESC`);

      // 2) Trocas ainda bloqueadas (aguardando liberação) — ainda não estão no pipeline.
      const blockRs: any = await db.execute(sql`
        SELECT bo.id, bo.sales_card_id, bo.customer_id, bo.seller_id, bo.block_details, bo.total_amount,
               bo.products AS bo_products, bo.blocked_at, bo.created_at AS blocked_created_at,
               sc.notes AS motivo, sc.parent_card_id, sc.products, sc.created_at AS card_created_at,
               c.name AS c_name, c.fantasy_name AS c_fantasy_name,
               u.first_name AS s_first_name, u.last_name AS s_last_name
        FROM blocked_orders bo
        LEFT JOIN sales_cards sc ON sc.id = bo.sales_card_id
        LEFT JOIN customers c ON c.id = bo.customer_id
        LEFT JOIN users u ON u.id = COALESCE(sc.seller_id, bo.seller_id)
        WHERE bo.operation_type = 'troca' AND bo.status = 'blocked'
        ORDER BY bo.blocked_at DESC`);

      const pipeRows = (pipeRs.rows || pipeRs) as any[];
      const blockRows = (blockRs.rows || blockRs) as any[];

      // Cards já representados no pipeline não repetem como bloqueados.
      const noPipeline = new Set(pipeRows.map((r) => String(r.sales_card_id)));
      const bloqueados = blockRows.filter((r) => !noPipeline.has(String(r.sales_card_id)));

      // 3) Fotos: por id do card e pelo id do card de origem (parent_card_id).
      const ids = new Set<string>();
      for (const r of [...pipeRows, ...bloqueados]) {
        if (r.sales_card_id) ids.add(String(r.sales_card_id));
        if (r.parent_card_id) ids.add(String(r.parent_card_id));
      }
      const fotosPorCard = new Map<string, { url: string; em: string }[]>();
      if (ids.size) {
        const idList = sql.join(Array.from(ids).map((c) => sql`${c}`), sql`, `);
        const tp: any = await db.execute(sql`
          SELECT sales_card_id, error AS url, created_at
          FROM order_pipeline_audit
          WHERE outcome = 'troca_photo' AND sales_card_id IN (${idList})
          ORDER BY sales_card_id, created_at ASC`);
        for (const x of (tp.rows || tp) as any[]) {
          if (!x.url) continue;
          const k = String(x.sales_card_id);
          const lista = fotosPorCard.get(k) || [];
          if (!lista.some((f) => f.url === String(x.url))) lista.push({ url: String(x.url), em: x.created_at });
          fotosPorCard.set(k, lista);
        }
      }
      const fotosDo = (r: any) => {
        const own = fotosPorCard.get(String(r.sales_card_id)) || [];
        if (own.length) return own;
        return (r.parent_card_id && fotosPorCard.get(String(r.parent_card_id))) || [];
      };

      const nomeVendedor = (r: any) =>
        [r.s_first_name, r.s_last_name].filter(Boolean).join(" ").trim() || r.seller_name || "—";
      const produtos = (arr: any): string => {
        if (!Array.isArray(arr)) return "";
        return arr.map((p: any) => `${p?.quantity ?? ""}x ${p?.name ?? ""}`.trim()).filter(Boolean).join("; ");
      };

      const itens = [
        ...pipeRows.map((r) => ({
          id: r.id,
          origem: "pipeline" as const,
          salesCardId: r.sales_card_id,
          customerId: r.customer_id,
          cliente: r.c_name || r.customer_name || "Cliente não encontrado",
          clienteFantasia: r.c_fantasy_name || null,
          clienteDocumento: r.customer_document || null,
          solicitante: nomeVendedor(r),
          sellerId: r.card_seller_id || r.seller_id || null,
          motivo: (r.motivo && String(r.motivo).trim()) || (r.pipeline_notes && String(r.pipeline_notes).trim()) || "",
          produtos: produtos(r.products),
          valor: r.sale_value != null ? Number(r.sale_value) : null,
          etapa: r.stage,
          pedido: r.order_number || null,
          nf: r.invoice_number || null,
          data: r.card_created_at || r.pipeline_created_at,
          dataPipeline: r.pipeline_created_at,
          atualizadoEm: r.pipeline_updated_at,
          fotos: fotosDo(r),
        })),
        ...bloqueados.map((r) => ({
          id: r.id,
          origem: "bloqueado" as const,
          salesCardId: r.sales_card_id,
          customerId: r.customer_id,
          cliente: r.c_name || "Cliente não encontrado",
          clienteFantasia: r.c_fantasy_name || null,
          clienteDocumento: null,
          solicitante: nomeVendedor(r),
          sellerId: r.seller_id || null,
          motivo: (r.motivo && String(r.motivo).trim()) || (r.block_details && String(r.block_details).trim()) || "",
          produtos: produtos(r.products || r.bo_products),
          valor: r.total_amount != null ? Number(r.total_amount) : null,
          etapa: "bloqueado",
          pedido: null,
          nf: null,
          data: r.card_created_at || r.blocked_at || r.blocked_created_at,
          dataPipeline: r.blocked_at,
          atualizadoEm: r.blocked_at,
          fotos: fotosDo(r),
        })),
      ];

      const dia = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "");
      const filtrados = itens.filter((i) => {
        const d = dia(i.data);
        if (de && d && d < de) return false;
        if (ate && d && d > ate) return false;
        return true;
      });
      filtrados.sort((a, b) => new Date(b.data || 0).getTime() - new Date(a.data || 0).getTime());

      res.json({
        total: filtrados.length,
        comFoto: filtrados.filter((i) => i.fotos.length > 0).length,
        bloqueadas: filtrados.filter((i) => i.etapa === "bloqueado").length,
        itens: filtrados,
      });
    } catch (e: any) {
      console.error("[INDUSTRIA-TROCAS] erro ao listar:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar as trocas" });
    }
  });
}
