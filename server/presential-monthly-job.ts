// server/presential-monthly-job.ts
// -----------------------------------------------------------------------------
// VISITA PRESENCIAL POR CICLO — avaliação diária de check-in (out/2026; ciclo em nov/2026)
//
// Clientes marcados com presential_monthly=true (clientes virtuais de vendedores
// externos) recebem visita PRESENCIAL dentro da própria cadência (regra do ciclo em
// visitScheduleService.aplicarCicloPresencial: semanal e quinzenal 1 a cada 4 visitas,
// mensal mês sim, mês não — contados da última presencial realizada). Regra do Flávio:
//   - Se o vendedor NÃO executa a visita presencial do dia COM CHECK-IN, o cliente
//     passa automaticamente a PRESENCIAL (virtual_service=false) — deixa de ser virtual.
//   - Ele só VOLTA a virtual se a visita presencial ocorrer (check-in) no dia.
//
// "Virada do dia (job diário à noite)": todo dia às 22:50 BRT o job olha a visita
// PRESENCIAL (is_virtual=false) agendada para HOJE de cada cliente presential_monthly:
//   • teve check-in  → se estava presencial, VOLTA a virtual;
//   • sem check-in   → se estava virtual, VIRA presencial e a visita é marcada 'missed'.
// Toda transição é gravada no histórico do cliente (customer_change_history).
// Depois regenera a agenda para refletir o novo estado (demovido = periodicidade inteira
// presencial, até a 1ª visita com check-in) e reaplica o ciclo de todos os clientes da regra.
//
// Seguro por padrão: idempotente, try/catch por cliente, nunca derruba o boot.
// -----------------------------------------------------------------------------
import type { Express } from "express";
import cron from "node-cron";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { logCustomerChanges, logCustomerNote } from "./customerAudit";
import { regenerateCustomerAgenda, aplicarCicloPresencial } from "./visitScheduleService";
import { authenticateUser, requireRole } from "./authMiddleware";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => (r?.rows ?? r ?? []) as any[];
const ATOR = { id: "system", name: "Sistema (ciclo presencial)" };
const NOTA = "Visita presencial do ciclo";

function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function brDate(d: string): string {
  // 'YYYY-MM-DD' -> 'DD/MM/YYYY'
  const [y, m, dd] = String(d).split("-");
  return dd && m && y ? `${dd}/${m}/${y}` : String(d);
}

/**
 * Executa a avaliação de HOJE (ou de uma data BRT informada, p/ testes).
 * Retorna um resumo com quem foi convertido/revertido.
 */
export async function avaliarVisitasPresenciaisMensais(dataBR?: string): Promise<{
  dia: string;
  avaliados: number;
  convertidosPresencial: string[];
  revertidosVirtual: string[];
}> {
  const dia = (dataBR && /^\d{4}-\d{2}-\d{2}$/.test(dataBR)) ? dataBR : hojeBR();
  const diaBR = brDate(dia);
  const convertidosPresencial: string[] = [];
  const revertidosVirtual: string[] = [];

  // Clientes presential_monthly com visita PRESENCIAL (is_virtual=false) agendada p/ o dia.
  // scheduled_date é gravado às 12:00 UTC (meio-dia), então o dia BRT bate com o dia calendário.
  const r: any = await db.execute(sql`
    SELECT c.id,
           COALESCE(c.virtual_service, false) AS virtual_service,
           COALESCE(c.fantasy_name, c.name) AS nome,
           va.id AS visit_id,
           va.actual_check_in,
           va.visit_status,
           -- O check-in da Rota do Dia grava em route_checkpoints (não em visit_agenda):
           -- sem isto o job convertia para presencial quem FEZ check-in.
           EXISTS (SELECT 1 FROM route_checkpoints rc
                    WHERE rc.customer_id = c.id AND rc.checkpoint_type = 'check_in'
                      AND (rc.checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date = ${dia}::date) AS rc_checkin
      FROM customers c
      JOIN visit_agenda va ON va.customer_id = c.id
     WHERE COALESCE(c.presential_monthly, false) = true
       AND COALESCE(c.is_active, true) = true
       AND COALESCE(va.is_virtual, false) = false
       AND COALESCE(va.visit_status, 'pending') <> 'cancelled'
       AND (va.scheduled_date AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date = ${dia}::date`);

  // Agrega por cliente: teve check-in em QUALQUER visita presencial do dia?
  const porCliente = new Map<string, { nome: string; virtual: boolean; temCheckin: boolean; visitSemCheckin: string[] }>();
  for (const row of rows(r)) {
    const id = String(row.id);
    const cur = porCliente.get(id) || { nome: String(row.nome || id), virtual: row.virtual_service === true, temCheckin: false, visitSemCheckin: [] };
    const checou = row.actual_check_in != null || String(row.visit_status || "") === "completed" || row.rc_checkin === true;
    if (checou) cur.temCheckin = true;
    else if (row.visit_id) cur.visitSemCheckin.push(String(row.visit_id));
    porCliente.set(id, cur);
  }

  for (const [customerId, info] of Array.from(porCliente.entries())) {
    try {
      if (info.temCheckin) {
        // Visita presencial realizada → volta (ou permanece) VIRTUAL.
        if (info.virtual !== true) {
          await db.execute(sql`UPDATE customers SET virtual_service = true WHERE id = ${customerId}`);
          await logCustomerChanges({ customerId, before: { virtualService: false }, changes: { virtualService: true }, actor: ATOR, source: "presential-monthly" });
          await logCustomerNote({ customerId, label: NOTA, text: `Retornou a VIRTUAL: visita presencial do ciclo realizada (check-in) em ${diaBR}.`, actor: ATOR, source: "presential-monthly" });
          try { await regenerateCustomerAgenda(customerId); } catch { /* noop */ }
          revertidosVirtual.push(info.nome);
        }
      } else {
        // Sem check-in na visita presencial do dia → VIRA presencial (não mais virtual).
        // Marca a(s) visita(s) do dia como 'missed' (não houve check-in).
        for (const vid of info.visitSemCheckin) {
          await db.execute(sql`UPDATE visit_agenda SET visit_status = 'missed', updated_at = now() WHERE id = ${vid} AND actual_check_in IS NULL AND COALESCE(visit_status,'pending') = 'pending'`);
        }
        if (info.virtual === true) {
          await db.execute(sql`UPDATE customers SET virtual_service = false WHERE id = ${customerId}`);
          await logCustomerChanges({ customerId, before: { virtualService: true }, changes: { virtualService: false }, actor: ATOR, source: "presential-monthly" });
          await logCustomerNote({ customerId, label: NOTA, text: `Convertido para PRESENCIAL: a visita presencial do ciclo de ${diaBR} não teve check-in do vendedor. Toda a periodicidade passa a ser presencial até a próxima visita com check-in.`, actor: ATOR, source: "presential-monthly" });
          try { await regenerateCustomerAgenda(customerId); } catch { /* noop */ }
          convertidosPresencial.push(info.nome);
        }
      }
    } catch (e: any) {
      console.error(`[visita-mensal] falha ao avaliar cliente ${customerId}:`, e?.message || e);
    }
  }

  // Reaplica o ciclo presencial de TODOS os clientes da regra (cobre visitas gravadas por
  // outros caminhos — repescagem, reclassificação — que não passam pelo motor de agenda).
  try {
    const todos: any = await db.execute(sql`SELECT id FROM customers WHERE COALESCE(presential_monthly, false) = true AND COALESCE(is_active, true) = true`);
    for (const row of rows(todos)) { try { await aplicarCicloPresencial(String(row.id)); } catch { /* noop */ } }
  } catch (e: any) { console.error("[visita-mensal] ciclo presencial (todos) falhou:", e?.message || e); }

  console.log(`[visita-mensal] ${dia}: ${porCliente.size} avaliado(s) · ${convertidosPresencial.length} → presencial · ${revertidosVirtual.length} → virtual`);
  return { dia, avaliados: porCliente.size, convertidosPresencial, revertidosVirtual };
}

/** Agenda o job (22:50 BRT, todo dia) e expõe o disparo manual (admin). */
export function registerPresentialMonthlyJob(app: Express): void {
  // Cron diário — "virada do dia à noite".
  try {
    cron.schedule("50 22 * * *", () => { void avaliarVisitasPresenciaisMensais().catch((e) => console.error("[visita-mensal] cron falhou:", e?.message || e)); }, { timezone: TZ });
    console.log("[visita-mensal] job agendado (22:50 BRT, diário).");
  } catch (e: any) {
    console.error("[visita-mensal] falha ao agendar cron:", e?.message || e);
  }

  // Disparo manual (admin) — útil p/ testar sem esperar a noite. Aceita ?data=YYYY-MM-DD.
  app.post("/api/admin/presential-monthly/run", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const dataBR = typeof req.query?.data === "string" ? req.query.data : (req.body?.data || undefined);
      const out = await avaliarVisitasPresenciaisMensais(dataBR);
      res.json({ ok: true, ...out });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });

  // Aplicação EM MASSA (admin): marca presential_monthly=true em todos os clientes VIRTUAIS de
  // VENDEDOR EXTERNO (users.role='vendedor') e regenera a agenda (injeta a visita presencial mensal).
  // ?dryRun=true apenas CONTA/lista (não grava) — use antes de aplicar de fato.
  app.post("/api/admin/presential-monthly/apply-bulk", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
      const r: any = await db.execute(sql`
        SELECT c.id, COALESCE(c.fantasy_name, c.name) AS nome, COALESCE(c.presential_monthly, false) AS ja
          FROM customers c
          JOIN users u ON u.id = c.seller_id
         WHERE COALESCE(c.virtual_service, false) = true
           AND u.role = 'vendedor'
           AND COALESCE(c.is_active, true) = true
           AND COALESCE(c.is_lead, false) = false
           AND COALESCE(c.is_supplier, false) = false`);
      const alvo = rows(r);
      const pendentes = alvo.filter((x: any) => x.ja !== true);
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, total: alvo.length, jaMarcados: alvo.length - pendentes.length, aMarcar: pendentes.length, amostra: pendentes.slice(0, 25).map((x: any) => x.nome) });
      }
      // ?force=true → reprocessa TODOS os já marcados (regenera a agenda), além de marcar os novos.
      const force = req.query?.force === "true" || req.body?.force === true;
      const lista = force ? alvo : pendentes;
      let marcados = 0, regenerados = 0;
      for (const row of lista) {
        try {
          // Só marca + registra no histórico quem ainda não estava marcado (evita nota duplicada no force).
          if (row.ja !== true) {
            await db.execute(sql`UPDATE customers SET presential_monthly = true WHERE id = ${row.id}`);
            marcados++;
            try { await logCustomerNote({ customerId: String(row.id), label: NOTA, text: "Ativada em massa (cliente virtual de vendedor externo).", actor: ATOR, source: "presential-monthly" }); } catch { /* noop */ }
          }
          try { const n = await regenerateCustomerAgenda(String(row.id)); if (n > 0) regenerados++; } catch { /* noop */ }
        } catch (e: any) { console.error("[visita-mensal] bulk falhou", row.id, e?.message); }
      }
      res.json({ ok: true, total: alvo.length, marcados, regenerados });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });
  // APLICAR A REGRA DO CICLO (nov/2026) a todos os clientes da regra: regrava a agenda (motor
  // único + ciclo) e registra no histórico de cada cliente. ?dryRun=true só simula a contagem.
  app.post("/api/admin/presential-monthly/aplicar-ciclo", authenticateUser, requireRole(["admin"]), async (req, res) => {
    try {
      const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
      const r: any = await db.execute(sql`
        SELECT id, COALESCE(fantasy_name, name) AS nome, visit_periodicity AS per, COALESCE(virtual_service, false) AS vs
          FROM customers
         WHERE COALESCE(presential_monthly, false) = true AND COALESCE(is_active, true) = true
         ORDER BY 2`);
      const alvo = rows(r);
      if (dryRun) {
        const porPer: Record<string, number> = {};
        for (const x of alvo) { const k = `${x.per || "semanal"}${x.vs ? "" : " (demovido)"}`; porPer[k] = (porPer[k] || 0) + 1; }
        return res.json({ ok: true, dryRun: true, total: alvo.length, porPeriodicidade: porPer });
      }
      const REGRA = "Regra do ciclo presencial aplicada: semanal e quinzenal, 1 visita presencial a cada 4 visitas; mensal, mês sim, mês não (contando da última presencial realizada). Sem check-in na presencial, toda a periodicidade passa a presencial até a próxima visita com check-in.";
      const resultado: any[] = [];
      let erros = 0;
      for (const x of alvo) {
        try {
          await regenerateCustomerAgenda(String(x.id));
          const ciclo = await aplicarCicloPresencial(String(x.id));
          try { await logCustomerNote({ customerId: String(x.id), label: NOTA, text: `${REGRA} Próximas visitas: ${ciclo?.padrao || "—"} (P = presencial, V = virtual).`, actor: ATOR, source: "presential-monthly" }); } catch { /* noop */ }
          resultado.push({ nome: x.nome, per: x.per, modo: ciclo?.modo, padrao: ciclo?.padrao });
        } catch (e: any) { erros++; console.error("[ciclo-presencial] aplicar falhou", x.id, e?.message); }
      }
      res.json({ ok: true, total: alvo.length, erros, resultado });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "falha" });
    }
  });
}
