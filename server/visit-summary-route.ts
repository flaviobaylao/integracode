import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

// ====== RESUMO DE VISITAS E ATENDIMENTOS — paridade com o 1.0 (calendário por cliente) ======
export function registerVisitSummary(app: Express) {
  app.get("/api/visit-summary", async (req: Request, res: Response) => {
    try {
      const tz = "America/Sao_Paulo";
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const norm = (s: any, def: string) => { const m = String(s || "").match(/^\d{4}-\d{2}-\d{2}$/); return m ? m[0] : def; };
      const dAdd = (base: string, days: number) => { const d = new Date(base + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
      const startDate = norm(req.query.startDate, dAdd(todayStr, -30));
      const endDate = norm(req.query.endDate, dAdd(todayStr, 30));
      const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

      // Clientes ativos "de rota" (com dia de visita), vendedor resolvido via users
      const clients = await q(`
        SELECT c.id AS customer_id, c.name AS customer_name, c.city, c.neighborhood,
               c.visit_periodicity AS periodicity, c.weekdays,
               TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS seller_name
        FROM customers c
        LEFT JOIN users u ON (u.omie_vendor_code = c.seller_id OR u.omie_vendor_code = replace(c.seller_id, 'omie-vendor-', '') OR u.id = c.seller_id)
        WHERE c.is_active = true AND c.is_lead IS NOT TRUE AND c.is_supplier IS NOT TRUE
          AND c.weekdays IS NOT NULL AND c.weekdays::text NOT IN ('', '[]', 'null')
      `);

      // Fallback de vendedor pelo pedido mais recente (billing_pipeline)
      const bpSeller = await q(`SELECT DISTINCT ON (customer_id) customer_id, seller_name FROM billing_pipeline WHERE customer_id IS NOT NULL AND seller_name IS NOT NULL AND seller_name <> '' ORDER BY customer_id, created_at DESC`);
      const bpSellerMap = new Map<string, string>();
      for (const r of bpSeller) bpSellerMap.set(r.customer_id, r.seller_name);

      const win = `(scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}'`;
      // Agendamentos + check-in (visit_agenda) e (sales_cards)
      const schedVA = await q(`SELECT customer_id, (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, BOOL_OR(actual_check_in IS NOT NULL OR visit_status = 'completed') AS visited, BOOL_OR(is_virtual = true) AS is_virtual FROM visit_agenda WHERE scheduled_date IS NOT NULL AND ${win} AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      const schedSC = await q(`SELECT customer_id, (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, BOOL_OR(check_in_time IS NOT NULL) AS visited FROM sales_cards WHERE scheduled_date IS NOT NULL AND (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      // Pedidos (billing_pipeline)
      const orders = await q(`SELECT customer_id, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, COALESCE(SUM(sale_value),0) AS v, COUNT(*) AS n FROM billing_pipeline WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      // Atendimento virtual (virtual_service_logs)
      let virt: any[] = [];
      try { virt = await q(`SELECT customer_id, (attendance_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM virtual_service_logs WHERE (attendance_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`); } catch (e) { virt = []; }
      // Meta aproximada por cliente (média histórica de sale_value)
      let metas: any[] = [];
      try { metas = await q(`SELECT customer_id, AVG(sale_value) AS meta FROM billing_pipeline WHERE sale_value > 0 AND customer_id IS NOT NULL GROUP BY customer_id`); } catch (e) { metas = []; }
      const metaMap = new Map<string, number>();
      for (const m of metas) metaMap.set(m.customer_id, Number(m.meta) || 0);

      type Cell = { isScheduled: boolean; hasVisit: boolean; hasOrder: boolean; hasVirtualAttendance: boolean; orderValue: number };
      const byCust = new Map<string, Map<string, Cell>>();
      const ensure = (cid: string, d: string): Cell => { let m = byCust.get(cid); if (!m) { m = new Map(); byCust.set(cid, m); } let c = m.get(d); if (!c) { c = { isScheduled: false, hasVisit: false, hasOrder: false, hasVirtualAttendance: false, orderValue: 0 }; m.set(d, c); } return c; };
      for (const s of schedVA) { const c = ensure(s.customer_id, s.d); c.isScheduled = true; if (s.visited === true || s.visited === "t") c.hasVisit = true; }
      for (const s of schedSC) { const c = ensure(s.customer_id, s.d); c.isScheduled = true; if (s.visited === true || s.visited === "t") c.hasVisit = true; }
      for (const o of orders) { const c = ensure(o.customer_id, o.d); c.hasOrder = Number(o.n) > 0; c.orderValue = Number(o.v) || 0; }
      for (const v of virt) { const c = ensure(v.customer_id, v.d); c.hasVirtualAttendance = true; }

      const rows = clients.map((cl: any) => {
        const cellMap = byCust.get(cl.customer_id) || new Map<string, Cell>();
        const meta = metaMap.get(cl.customer_id) || 0;
        const visits = Array.from(cellMap.entries()).map(([d, cell]) => ({
          date: d, isPast: d <= todayStr, isScheduled: cell.isScheduled, hasVisit: cell.hasVisit,
          hasOrder: cell.hasOrder, hasVirtualAttendance: cell.hasVirtualAttendance, orderValue: cell.orderValue,
          metaValue: meta, nextSaleValue: 0, visitStatus: null,
        }));
        return {
          customerId: cl.customer_id,
          customerName: cl.customer_name || "-",
          sellerName: (cl.seller_name && cl.seller_name.trim()) || bpSellerMap.get(cl.customer_id) || "Sem vendedor",
          city: cl.city || "", neighborhood: cl.neighborhood || "",
          periodicity: cl.periodicity || "", weekdays: cl.weekdays || "[]",
          visits,
        };
      });
      res.json({ start: startDate, end: endDate, today: todayStr, rows });
    } catch (err: any) { res.status(500).json({ error: String(err?.message || err) }); }
  });
}
