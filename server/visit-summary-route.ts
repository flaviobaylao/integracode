import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { computeCycles, cyclesToShow } from "./repescagem-cycles";

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
          AND EXISTS (SELECT 1 FROM active_customers ac WHERE ac.customer_id = c.id AND ac.is_active IS TRUE)
      `);

      // Fallback de vendedor pelo pedido mais recente (billing_pipeline)
      const bpSeller = await q(`SELECT DISTINCT ON (customer_id) customer_id, seller_name FROM billing_pipeline WHERE customer_id IS NOT NULL AND seller_name IS NOT NULL AND seller_name <> '' ORDER BY customer_id, created_at DESC`);
      const bpSellerMap = new Map<string, string>();
      for (const r of bpSeller) bpSellerMap.set(r.customer_id, r.seller_name);

      const winSC = `(scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}'`;
      // Check-in (visita efetuada) — sales_cards.check_in_time (esparso; gap conhecido)
      const checkins = await q(`SELECT customer_id, (scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM sales_cards WHERE scheduled_date IS NOT NULL AND ${winSC} AND check_in_time IS NOT NULL AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      // Pedidos (billing_pipeline)
      const orders = await q(`SELECT customer_id, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, COALESCE(SUM(sale_value),0) AS v, COUNT(*) AS n FROM billing_pipeline WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`);
      // VENDAS reais (ultimos ~130 dias) p/ a coluna "Efetividade em vendas" (bolinhas por ciclo).
      // Combina pipeline 'venda' + faturamentos com valor>0 (mesma base do gatilho de repescagem).
      const saleStart = dAdd(todayStr, -130);
      const saleDatesByCustomer = new Map<string, Set<string>>();
      const addSale = (cid: any, d: any) => { if (!cid || !d) return; let s = saleDatesByCustomer.get(cid); if (!s) { s = new Set(); saleDatesByCustomer.set(cid, s); } s.add(d); };
      try {
        const salesP = await q(`SELECT customer_id, DATE(COALESCE(scheduled_billing_date::timestamp, created_at))::text AS d FROM billing_pipeline WHERE LOWER(COALESCE(NULLIF(operation_type::text,''),'venda'))='venda' AND customer_id IS NOT NULL AND DATE(COALESCE(scheduled_billing_date::timestamp, created_at)) BETWEEN '${saleStart}' AND '${todayStr}'`);
        for (const r of salesP) addSale(r.customer_id, r.d);
      } catch (e) { /* ignora */ }
      try {
        const salesB = await q(`SELECT CONCAT('omie-client-', omie_customer_code) AS customer_id, DATE(COALESCE(order_date, invoice_date))::text AS d FROM billings WHERE is_cancelled = false AND COALESCE(CAST(total_value AS NUMERIC),0) > 0 AND omie_customer_code IS NOT NULL AND DATE(COALESCE(order_date, invoice_date)) BETWEEN '${saleStart}' AND '${todayStr}'`);
        for (const r of salesB) addSale(r.customer_id, r.d);
      } catch (e) { /* ignora */ }
      // Atendimento virtual (virtual_service_logs)
      let virt: any[] = [];
      try { virt = await q(`SELECT customer_id, (attendance_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d FROM virtual_service_logs WHERE (attendance_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND customer_id IS NOT NULL GROUP BY customer_id, d`); } catch (e) { virt = []; }
      // Meta aproximada por cliente (média histórica de sale_value)
      let metas: any[] = [];
      try { metas = await q(`SELECT customer_id, AVG(sale_value) AS meta FROM billing_pipeline WHERE sale_value > 0 AND customer_id IS NOT NULL GROUP BY customer_id`); } catch (e) { metas = []; }
      const metaMap = new Map<string, number>();
      for (const m of metas) metaMap.set(m.customer_id, Number(m.meta) || 0);

      type Cell = { isScheduled: boolean; hasVisit: boolean; hasOrder: boolean; hasVirtualAttendance: boolean; orderValue: number };
      const checkinMap = new Map<string, Set<string>>();
      for (const c of checkins) { let s = checkinMap.get(c.customer_id); if (!s) { s = new Set(); checkinMap.set(c.customer_id, s); } s.add(c.d); }
      const orderMap = new Map<string, Map<string, any>>();
      for (const o of orders) { let m = orderMap.get(o.customer_id); if (!m) { m = new Map(); orderMap.set(o.customer_id, m); } m.set(o.d, { v: Number(o.v) || 0, n: Number(o.n) || 0 }); }
      const virtMap = new Map<string, Set<string>>();
      for (const v of virt) { let s = virtMap.get(v.customer_id); if (!s) { s = new Set(); virtMap.set(v.customer_id, s); } s.add(v.d); }
      const allDates: string[] = [];
      { const d = new Date(startDate + 'T12:00:00Z'); const e2 = new Date(endDate + 'T12:00:00Z'); while (d <= e2) { allDates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
      const DOW: Record<string, number> = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
      const parseDows = (w: any): number[] => { let arr: any = w; try { if (typeof w === 'string') arr = JSON.parse(w); } catch (e) { arr = []; } if (!Array.isArray(arr)) return []; const out: number[] = []; for (const x of arr) { const k = String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 3); if (DOW[k] !== undefined) out.push(DOW[k]); } return out; };
      const firstDowOfMonth = (dt: Date, dow: number): number => { const first = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1)); const shift = (dow - first.getUTCDay() + 7) % 7; return 1 + shift; };
      const isPlanned = (dateStr: string, dows: number[], periodicity: string): boolean => { const dt = new Date(dateStr + 'T12:00:00Z'); const dow = dt.getUTCDay(); if (!dows.includes(dow)) return false; const p = String(periodicity || 'semanal').toLowerCase(); if (p.indexOf('quinz') >= 0) { const weekIdx = Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) / (7 * 864e5)); return weekIdx % 2 === 0; } if (p.indexOf('mens') >= 0) return dt.getUTCDate() === firstDowOfMonth(dt, dow); if (p.indexOf('bime') >= 0) return dt.getUTCDate() === firstDowOfMonth(dt, dow) && (dt.getUTCMonth() % 2 === 0); return true; };
      const rows = clients.map((cl: any) => {
        const cid = cl.customer_id;
        const dows = parseDows(cl.weekdays);
        const meta = metaMap.get(cid) || 0;
        const ci = checkinMap.get(cid);
        const om = orderMap.get(cid);
        const vm = virtMap.get(cid);
        const cells = new Map<string, Cell>();
        const ensure = (d: string): Cell => { let c = cells.get(d); if (!c) { c = { isScheduled: false, hasVisit: false, hasOrder: false, hasVirtualAttendance: false, orderValue: 0 }; cells.set(d, c); } return c; };
        for (const d of allDates) { if (isPlanned(d, dows, cl.periodicity)) ensure(d).isScheduled = true; }
        if (ci) for (const d of ci) ensure(d).hasVisit = true;
        if (om) for (const [d, o] of om) { const c = ensure(d); c.hasOrder = o.n > 0; c.orderValue = o.v; }
        if (vm) for (const d of vm) ensure(d).hasVirtualAttendance = true;
        const visits = Array.from(cells.entries()).map(([d, cell]) => ({ date: d, isPast: d <= todayStr, isScheduled: cell.isScheduled, hasVisit: cell.hasVisit, hasOrder: cell.hasOrder, hasVirtualAttendance: cell.hasVirtualAttendance, orderValue: cell.orderValue, metaValue: meta, nextSaleValue: 0, visitStatus: null }));
        // Efetividade em vendas: bolinhas por ciclo (Semanal 4 / Quinzenal 2 / Mensal 1).
        const cycles = computeCycles(dows, cl.periodicity || 'semanal', saleDatesByCustomer.get(cid) || new Set<string>(), todayStr, cyclesToShow(cl.periodicity || 'semanal'));
        return { customerId: cid, customerName: cl.customer_name || '-', sellerName: (cl.seller_name && cl.seller_name.trim()) || bpSellerMap.get(cid) || 'Sem vendedor', city: cl.city || '', neighborhood: cl.neighborhood || '', periodicity: cl.periodicity || '', weekdays: cl.weekdays || '[]', cycles, visits };
      });

      res.json({ start: startDate, end: endDate, today: todayStr, rows });
    } catch (err: any) { res.status(500).json({ error: String(err?.message || err) }); }
  });

  app.get('/api/routes/validate', async (req: Request, res: Response) => {
    try {
      const tz = 'America/Sao_Paulo';
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const norm = (s: any, def: string) => { const m = String(s || '').match(/^\d{4}-\d{2}-\d{2}$/); return m ? m[0] : def; };
      const startDate = norm(req.query.startDate, todayStr);
      const endDate = norm(req.query.endDate, startDate);
      const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
      const planned = await q(`SELECT DISTINCT va.customer_id, va.seller_id, (va.scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, COALESCE(c.name, va.customer_id) AS customer_name FROM visit_agenda va LEFT JOIN customers c ON c.id = va.customer_id WHERE va.scheduled_date IS NOT NULL AND (va.scheduled_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}' AND (va.visit_status = 'pending' OR va.visit_status IS NULL) AND va.is_virtual = false AND va.customer_id IS NOT NULL`);
      const routes = await q(`SELECT seller_id, (route_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS d, visit_stops FROM daily_routes WHERE (route_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN '${startDate}' AND '${endDate}'`);
      const routeEntries: any[] = [];
      const custIds = new Set<string>();
      for (const r of routes) { let stops: any = r.visit_stops; if (typeof stops === 'string') { try { stops = JSON.parse(stops); } catch (e) { stops = null; } } if (!stops || typeof stops !== 'object') continue; for (const k of Object.keys(stops)) { const st = stops[k]; if (st && st.entityType === 'customer' && st.entityId) { routeEntries.push({ customerId: st.entityId, sellerId: r.seller_id, d: r.d }); custIds.add(st.entityId); } } }
      const nameMap = new Map<string, string>();
      if (custIds.size) { const ids = Array.from(custIds).map((x) => `'${x}'`).join(','); const names = await q(`SELECT id, name FROM customers WHERE id IN (${ids})`); for (const n of names) nameMap.set(n.id, n.name); }
      const nv = (s: any) => String(s || '').replace(/^omie-vendor-/, '');
      const plannedMap = new Map<string, any>();
      for (const p of planned) plannedMap.set(p.customer_id + '|' + p.d, { sellerId: p.seller_id, customerName: p.customer_name });
      const routeMap = new Map<string, any>();
      for (const e of routeEntries) if (!routeMap.has(e.customerId + '|' + e.d)) routeMap.set(e.customerId + '|' + e.d, { sellerId: e.sellerId, customerName: nameMap.get(e.customerId) || e.customerId });
      const missing: any[] = []; const extra: any[] = []; const wrongSeller: any[] = [];
      for (const [k, p] of plannedMap) { const rr = routeMap.get(k); const d = k.split('|')[1]; if (!rr) missing.push({ customerName: p.customerName, date: d, sellerId: p.sellerId }); else if (nv(rr.sellerId) !== nv(p.sellerId)) wrongSeller.push({ customerName: p.customerName, date: d, sellerId: p.sellerId, routeSellerId: rr.sellerId }); }
      for (const [k, rr] of routeMap) { if (!plannedMap.has(k)) { const d = k.split('|')[1]; extra.push({ customerName: rr.customerName, date: d, sellerId: rr.sellerId }); } }
      const totalPlanned = plannedMap.size; const totalInRoutes = routeMap.size;
      const withIssues = missing.length + extra.length + wrongSeller.length;
      const okCount = Math.max(0, totalPlanned - missing.length - wrongSeller.length);
      res.json({ success: true, validation: { totalPlanned, totalInRoutes, dateRanges: [{ startDate, endDate }], missing: missing.slice(0, 1000), extra: extra.slice(0, 1000), wrongSeller: wrongSeller.slice(0, 1000), summary: { ok: okCount, withIssues } }, message: 'Validacao ' + startDate + ' a ' + endDate + ': ' + totalPlanned + ' planejadas, ' + totalInRoutes + ' nas rotas, ' + withIssues + ' divergencias.' });
    } catch (err: any) { res.status(500).json({ error: String(err?.message || err) }); }
  });
}
