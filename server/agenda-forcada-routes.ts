// =============================================================================
//  INTEGRA 2.0 — Visitas FORÇADAS na agenda (27/out/2026)
//  "Todos os clientes que não foram positivados no mês devem aparecer nas rotas desta
//  semana conforme seus dias de rota, independente da periodicidade." (Flavio)
//
//  POST /api/admin/agenda/incluir-nao-positivados  { mes?: 'YYYY-MM', apply?: boolean }
//    - universo: clientes ativos com vendedor e dia de rota (não fornecedor/lead/colaborador),
//      início de fornecimento já iniciado;
//    - positivado = comprou no mês (billing_pipeline fora da lixeira, valor > 0, OU título em
//      receivables não cancelado) — mesma fonte do relatório de Positivação, por id ou documento;
//    - semana atual (seg–sex). Se o cliente já tem visita (não cancelada) nesta semana, nada muda;
//      senão entra no PRIMEIRO dia de rota dele de HOJE até sexta;
//    - quem só tem dia de rota já passado nesta semana fica listado em "diaJaPassou".
//  A linha nasce com visit_agenda.forcada = 'nao_positivado:YYYY-MM' e a regeneração não a apaga.
//  apply=false (padrão) só simula.
// =============================================================================
import type { Express, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : Array.isArray(r) ? r : []);
const digits = (v: any) => String(v || "").replace(/[^0-9]/g, "");
const DOW_TOK: Record<string, number> = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6, "sáb": 6 };
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
const hojeBRIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const addDias = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowDe = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();

export function registerAgendaForcadaRoutes(app: Express) {
  app.post("/api/admin/agenda/incluir-nao-positivados", authenticateUser, requireRole(["admin"]), async (req: any, res: Response) => {
    try {
      const { ensureAgendaForcadaColumn } = await import("./visitScheduleService");
      await ensureAgendaForcadaColumn();
      const apply = req.body?.apply === true;
      const hoje = hojeBRIso();
      const mes = /^\d{4}-\d{2}$/.test(String(req.body?.mes || "")) ? String(req.body.mes) : hoje.slice(0, 7);
      const iniMes = mes + "-01";
      const fimMes = (() => { const [y, m] = mes.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })();
      // Semana atual (segunda a sexta).
      const segunda = addDias(hoje, -((dowDe(hoje) + 6) % 7));
      const sexta = addDias(segunda, 4);
      const diasRestantes: string[] = [];
      for (let d = hoje; d <= sexta; d = addDias(d, 1)) { const w = dowDe(d); if (w >= 1 && w <= 5) diasRestantes.push(d); }

      // Universo.
      const cust = rowsOf(await db.execute(sql`
        SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, c.seller_id, c.weekdays, c.visit_periodicity,
               c.virtual_service, c.cnpj, c.cpf, c.latitude, c.longitude, c.address, c.service_start_date,
               COALESCE(NULLIF(u.name,''), u.email, c.seller_id) AS vendedor, u.role AS seller_role
          FROM customers c
          LEFT JOIN users u ON u.id = c.seller_id OR u.omie_vendor_code = c.seller_id
         WHERE c.is_active = true AND (c.is_supplier IS NOT TRUE) AND (c.is_lead IS NOT TRUE)
           AND (c.is_colaborador IS NOT TRUE) AND c.seller_id IS NOT NULL
           AND c.weekdays IS NOT NULL AND c.weekdays NOT IN ('[]','null','')`));

      { const vistos = new Set<string>(); for (let i = cust.length - 1; i >= 0; i--) { const id = String(cust[i].id); if (vistos.has(id)) cust.splice(i, 1); else vistos.add(id); } }

      // Positivados no mês (id ou documento).
      const posId = new Set<string>(); const posDoc = new Set<string>();
      for (const r of rowsOf(await db.execute(sql`
        SELECT DISTINCT customer_id, REGEXP_REPLACE(COALESCE(customer_document,''), '[^0-9]', '', 'g') AS doc
          FROM billing_pipeline
         WHERE COALESCE(sale_value,0) > 0 AND COALESCE(stage::text,'') <> 'lixeira'
           AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${iniMes}::date AND ${fimMes}::date`))) {
        if (r.customer_id) posId.add(String(r.customer_id)); if (digits(r.doc).length >= 11) posDoc.add(digits(r.doc));
      }
      try {
        for (const r of rowsOf(await db.execute(sql`
          SELECT DISTINCT customer_id, customer_document AS doc FROM receivables
           WHERE issue_date::date BETWEEN ${iniMes}::date AND ${fimMes}::date
             AND COALESCE(amount,0) > 0 AND status <> 'cancelada' AND deleted_at IS NULL`))) {
          if (r.customer_id) posId.add(String(r.customer_id)); if (digits(r.doc).length >= 11) posDoc.add(digits(r.doc));
        }
      } catch (e: any) { console.warn("[agenda-forcada] receivables:", e?.message); }

      // Quem já tem visita (não cancelada) nesta semana.
      const jaNaSemana = new Set<string>();
      for (const r of rowsOf(await db.execute(sql`
        SELECT DISTINCT customer_id FROM visit_agenda
         WHERE scheduled_date::date BETWEEN ${segunda}::date AND ${sexta}::date
           AND COALESCE(visit_status,'pending') <> 'cancelled'`))) jaNaSemana.add(String(r.customer_id));

      const incluir: any[] = []; const diaJaPassou: any[] = [];
      let naoPositivados = 0, jaTinhamVisita = 0, inicioFuturo = 0;
      for (const c of cust) {
        const doc = digits(c.cnpj) || digits(c.cpf);
        if (posId.has(String(c.id)) || (doc && posDoc.has(doc))) continue;
        naoPositivados++;
        if (c.service_start_date && new Date(c.service_start_date).toISOString().slice(0, 10) > sexta) { inicioFuturo++; continue; }
        if (jaNaSemana.has(String(c.id))) { jaTinhamVisita++; continue; }
        let w: any = c.weekdays; if (typeof w === "string") { try { w = JSON.parse(w); } catch { w = []; } }
        const dows = new Set<number>((Array.isArray(w) ? w : []).map((t: any) => DOW_TOK[String(t || "").trim().toLowerCase().slice(0, 3)]).filter((n: any) => n !== undefined && n >= 1 && n <= 5));
        const alvo = diasRestantes.find((d) => dows.has(dowDe(d)));
        const item = { customerId: c.id, nome: c.nome, vendedor: c.vendedor, periodicidade: c.visit_periodicity, diasRota: Array.from(dows).map((n) => DIAS[n]).join("/"), data: alvo || null };
        if (!alvo) { diaJaPassou.push(item); continue; }
        const virtual = c.virtual_service === true || String(c.seller_role || "") === "telemarketing";
        incluir.push({ ...item, virtual, _c: c });
      }

      let gravadas = 0;
      if (apply) {
        const { applyHolidayShiftsForCustomer } = await import("./holidays-routes");
        for (const it of incluir) {
          const c = it._c; const ds = new Date(it.data + "T12:00:00Z");
          const r: any = await db.execute(sql`
            INSERT INTO visit_agenda (customer_id, seller_id, scheduled_date, route_day, recurrence_type, is_virtual, visit_status,
                                      customer_name, customer_latitude, customer_longitude, customer_address, forcada)
            VALUES (${c.id}, ${c.seller_id}, ${ds}, ${DIAS[ds.getUTCDay()]}, ${String(c.visit_periodicity || "semanal")}, ${it.virtual},
                    'pending', ${String(c.nome || "Cliente")}, ${c.latitude ?? null}, ${c.longitude ?? null}, ${c.address ?? null},
                    ${"nao_positivado:" + mes})
            ON CONFLICT (customer_id, scheduled_date) DO NOTHING`);
          if ((r?.rowCount ?? 0) > 0) gravadas++;
          try { await applyHolidayShiftsForCustomer(String(c.id)); } catch { /* noop */ }
        }
      }

      const porVendedor: Record<string, { incluidos: number; diaJaPassou: number }> = {};
      for (const it of incluir) { const k = it.vendedor || "—"; (porVendedor[k] ||= { incluidos: 0, diaJaPassou: 0 }).incluidos++; }
      for (const it of diaJaPassou) { const k = it.vendedor || "—"; (porVendedor[k] ||= { incluidos: 0, diaJaPassou: 0 }).diaJaPassou++; }
      const porDia: Record<string, number> = {};
      for (const it of incluir) porDia[it.data] = (porDia[it.data] || 0) + 1;

      res.json({
        ok: true, apply, mes, semana: { segunda, sexta }, diasRestantes,
        universo: cust.length, naoPositivados, jaTinhamVisita, inicioFuturo,
        incluir: incluir.length, gravadas, porDia, porVendedor,
        diaJaPassouTotal: diaJaPassou.length,
        diaJaPassou: diaJaPassou.slice(0, 300),
        amostraIncluir: incluir.slice(0, 50).map(({ _c, ...x }) => x),
      });
    } catch (e: any) {
      console.error("[agenda-forcada]", e?.message);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
