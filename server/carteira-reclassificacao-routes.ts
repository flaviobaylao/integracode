// server/carteira-reclassificacao-routes.ts
// -----------------------------------------------------------------------------
// ROTAS DE ADMIN DA AGENDA DE VISITAS (em lote, sem tela).
//
// Este arquivo e' o que sobrou de server/agenda-carteira-routes.ts depois que a
// aba "Agenda da carteira" foi retirada da Gestao de Carteiras (Flavio,
// 04/10/2026). Sairam com a aba: o quadro de atendimentos por dia da semana, o
// teto de clientes por dia e a varredura das 07h que avisava a Inbox. Ficaram
// as rotas de lote, que nunca tiveram tela e sao chamadas a mao pelo admin:
//
//   POST /api/admin/carteira/reclassificar-lote          (+ /status)
//   POST /api/admin/carteira/regenerar-agenda-todos      (+ /status)
//   POST /api/admin/carteira/set-primeira-data-lote
//
// Todas terminam em `reprogramarAgenda`, que REGRAVA as visitas pendentes de
// `visit_agenda` na cadencia nova. E' dessa tabela que a Rota do Dia e a tela
// de Visitas vivem — por isso `reprogramarAgenda` e `gravarAgenda` vieram para
// ca inteiras, do jeito que estavam.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { calculateNextVisitDate, datasPelaRegra, normalizarSemana } from "@shared/visitSchedule";
import { normalizeWeekdayInput } from "@shared/schema";

const TZ = "America/Sao_Paulo";

/** Quem e' o usuario da requisicao (o lote e' restrito ao admin). */
function escopo(req: any) {
  const usuario: any = req?.currentUser || req?.user || null;
  const papel = String(usuario?.role || "");
  const restrito = ["vendedor", "telemarketing"].includes(papel);
  const limpa = (x: any) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "");
  const ids: string[] = [];
  if (restrito) {
    const add = (x: any) => { const v = limpa(x); if (v && !ids.includes(v)) ids.push(v); };
    add(usuario?.id);
    const codigos: any[] = [];
    if (usuario?.omieVendorCode) codigos.push(usuario.omieVendorCode);
    const mapa = usuario?.omieVendorCodes;
    if (mapa && typeof mapa === "object") for (const v of Object.values(mapa)) if (v) codigos.push(v);
    for (const c of codigos) { add(c); add(`omie-vendor-${limpa(c)}`); }
    if (!ids.length) ids.push("__sem_carteira__");
  }
  const nome = [usuario?.firstName, usuario?.lastName].filter(Boolean).join(" ").trim() || usuario?.email || "";
  const email = String(usuario?.email || "").toLowerCase().trim();
  return { usuario, papel, restrito, ids, nome, email };
}

/** Só estes admins podem ALTERAR dia/periodicidade já preenchidos — mesma
 *  trava do PATCH /api/customers/:id (guardVisitFieldsAlteration). */
const ADMINS_VISITA = ["cinthiamarque90@gmail.com", "flavio@bebahonest.com.br", "flaviobaylao@gmail.com"];

const DIA_NUM: Record<string, number> = { Dom: 0, Seg: 1, Ter: 2, Qua: 3, Qui: 4, Sex: 5, Sab: 6 };
const NUM_DIA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

/** weekdays do banco (string JSON, array ou texto solto) -> ['Seg','Qua']. */
function diasDoCadastro(v: any): string[] {
  try {
    const arr = normalizeWeekdayInput(v);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

/** 'YYYY-MM-DD' -> Date local, meia-noite (sem susto de fuso). */
function dataLocal(s: string): Date {
  const [a, m, d] = String(s).split("-").map(Number);
  return new Date(a, (m || 1) - 1, d || 1);
}

/**
 * `customers.semana_atendimento` existe? Guarda de migracao idempotente: a
 * reprogramacao le essa coluna para respeitar a semana fixa do cadastro.
 * Default 'toda' = o comportamento de sempre para quem ja existe.
 */
let colunaPronta: Promise<void> | null = null;
function garantirColunaSemana(): Promise<void> {
  if (!colunaPronta) {
    colunaPronta = db
      .execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS semana_atendimento varchar NOT NULL DEFAULT 'toda'`)
      .then(() => { console.log("[carteira-agenda] coluna semana_atendimento pronta"); })
      .catch((e: any) => { console.error("[carteira-agenda] semana_atendimento:", e?.message); colunaPronta = null; });
  }
  return colunaPronta as Promise<void>;
}

export function registerCarteiraReclassificacao(app: Express) {
  void garantirColunaSemana();

  // ---------------------------------------------------------------------------
  // LOTE — reclassificacao de periodicidade + 1a visita fixada (fire-and-forget).
  // Body: { items: [{ id, periodicidade, primeiraData }], dryRun? }
  // Idempotente: pula quem ja esta na periodicidade alvo. Grava progresso em
  // system_settings 'reclassif_lote_last' (lido pelo endpoint de status).
  // ---------------------------------------------------------------------------
  app.post("/api/admin/carteira/reclassificar-lote", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      if (!ADMINS_VISITA.includes(esc.email)) return res.status(403).json({ ok: false, error: "Restrito ao Admin." });
      const items = Array.isArray((req.body || {}).items) ? (req.body as any).items : [];
      const dry = (req.body || {}).dryRun === true;
      if (!items.length) return res.status(400).json({ ok: false, error: "items vazio." });
      res.json({ ok: true, started: true, total: items.length, dryRun: dry });
      (async () => {
        const prog: any = { at: new Date().toISOString(), total: items.length, ok: 0, skip: 0, erros: [], finished: false, dryRun: dry };
        const salvar = async () => {
          try {
            const payload = JSON.stringify(prog).slice(0, 100000);
            const ex: any = await db.execute(sql.raw("SELECT 1 FROM system_settings WHERE key='reclassif_lote_last'"));
            if (((ex.rows || ex) as any[]).length > 0) await db.execute(sql`UPDATE system_settings SET value=${payload}, updated_at=now() WHERE key='reclassif_lote_last'`);
            else await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by) VALUES ('reclassif_lote_last', ${payload}, 'ultima reclassificacao em lote', 'reclassif-lote')`);
          } catch (e) { /* ignora */ }
        };
        for (const it of items) {
          const id = String((it && it.id) || "");
          const per = String((it && it.periodicidade) || "");
          const pd = String((it && it.primeiraData) || "");
          if (!id || !["semanal", "quinzenal", "mensal"].includes(per) || !/^\d{4}-\d{2}-\d{2}$/.test(pd)) { prog.skip++; if (prog.erros.length < 50) prog.erros.push({ id, err: "payload" }); continue; }
          try {
            const rows = (await db.execute(sql`SELECT visit_periodicity::text AS per, weekdays FROM customers WHERE id = ${id} LIMIT 1`)).rows as any[];
            if (!rows.length) { prog.skip++; if (prog.erros.length < 50) prog.erros.push({ id, err: "nao encontrado" }); continue; }
            const atualPer = String(rows[0].per || "");
            const dias = diasDoCadastro(rows[0].weekdays);
            if (atualPer === per) { prog.skip++; continue; } // idempotente
            if (!dias.length) { prog.skip++; if (prog.erros.length < 50) prog.erros.push({ id, err: "sem dia de rota" }); continue; }
            if (!dry) {
              await db.execute(sql`UPDATE customers SET visit_periodicity = ${per}::visit_periodicity, updated_at = now() WHERE id = ${id}`);
              await reprogramarAgenda(id, dias, per, null, pd);
              try { const { updateExistingSalesCardsFromCustomer } = await import("./visitScheduleService"); await updateExistingSalesCardsFromCustomer(id); } catch (e) { /* ignora */ }
            }
            prog.ok++;
          } catch (e: any) { if (prog.erros.length < 50) prog.erros.push({ id, err: String(e?.message || e).slice(0, 100) }); }
          if ((prog.ok + prog.skip) % 20 === 0) await salvar();
        }
        prog.finished = true; prog.at = new Date().toISOString();
        await salvar();
      })().catch((e) => console.error("[reclassif-lote] erro geral", e));
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get("/api/admin/carteira/reclassificar-lote/status", authenticateUser, async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='reclassif_lote_last'"));
      const rows = (r.rows || r) as any[];
      res.json(rows[0] ? JSON.parse(rows[0].value) : { finished: true, total: 0, ok: 0, skip: 0, erros: [] });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // REGENERAR-AGENDA-TODOS: regenera a agenda (dia de rota + periodicidade, ancorada em HOJE)
  // de TODOS os clientes elegiveis (ativos, nao fornecedor, nao lead, nao colaborador, com dia
  // de rota valido), independente de divergencia. Usa regenerateCustomerAgenda, que preserva HOJE
  // e o passado e respeita semana de atendimento / BSB / fase do inicio de fornecimento. Preenche
  // service_start_date faltante antes (mantem a fase dos quinzenais). Roda em segundo plano e
  // grava o progresso em system_settings (key regen_agenda_todos_last). Restrito ao Admin.
  app.post("/api/admin/carteira/regenerar-agenda-todos", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      if (!ADMINS_VISITA.includes(esc.email)) return res.status(403).json({ ok: false, error: "Restrito ao Admin." });
      const bf: any = await db.execute(sql`
        UPDATE customers SET service_start_date = COALESCE(created_at, now())::date
        WHERE is_active = true AND (is_supplier IS NOT TRUE) AND (is_lead IS NOT TRUE)
          AND (is_colaborador IS NOT TRUE) AND seller_id IS NOT NULL AND service_start_date IS NULL
          AND weekdays IS NOT NULL AND weekdays NOT IN ('[]','null','')`);
      const datasPreenchidas = bf.rowCount ?? 0;
      const elig: any = await db.execute(sql`
        SELECT id FROM customers
        WHERE is_active = true AND (is_supplier IS NOT TRUE) AND (is_lead IS NOT TRUE)
          AND (is_colaborador IS NOT TRUE) AND seller_id IS NOT NULL
          AND weekdays IS NOT NULL AND weekdays NOT IN ('[]','null','')`);
      const ids: string[] = (((elig as any).rows || elig) as any[]).map((r: any) => String(r.id)).filter(Boolean);
      res.json({ ok: true, started: true, total: ids.length, datasPreenchidas });
      (async () => {
        const prog: any = { at: new Date().toISOString(), total: ids.length, datasPreenchidas, regenerados: 0, semData: 0, erros: [], finished: false };
        const salvar = async () => {
          try {
            const payload = JSON.stringify(prog).slice(0, 100000);
            const ex: any = await db.execute(sql.raw("SELECT 1 FROM system_settings WHERE key='regen_agenda_todos_last'"));
            if ((((ex as any).rows || ex) as any[]).length > 0) await db.execute(sql`UPDATE system_settings SET value=${payload}, updated_at=now() WHERE key='regen_agenda_todos_last'`);
            else await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by) VALUES ('regen_agenda_todos_last', ${payload}, 'ultima regeneracao de agenda de todos', 'regen-agenda-todos')`);
          } catch (e) { /* ignora */ }
        };
        try {
          const { regenerateCustomerAgenda } = await import("./visitScheduleService");
          for (const id of ids) {
            try { const n = await regenerateCustomerAgenda(id); if (n > 0) prog.regenerados++; else prog.semData++; }
            catch (e: any) { if (prog.erros.length < 50) prog.erros.push({ id: id.slice(0, 8), err: String(e?.message || e).slice(0, 100) }); }
            if ((prog.regenerados + prog.semData) % 25 === 0) await salvar();
          }
          await db.execute(sql`
            DELETE FROM visit_agenda
            WHERE visit_status = 'pending' AND EXTRACT(DOW FROM scheduled_date) = 0
              AND scheduled_date >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '1 day')`);
        } catch (e: any) { if (prog.erros.length < 50) prog.erros.push({ id: 'GERAL', err: String(e?.message || e).slice(0, 120) }); }
        prog.finished = true; prog.at = new Date().toISOString();
        await salvar();
        console.log(`[REGEN-AGENDA-TODOS] total=${prog.total}, regenerados=${prog.regenerados}, semData=${prog.semData}, erros=${prog.erros.length}, datasPreenchidas=${datasPreenchidas}`);
      })().catch((e) => console.error("[regen-agenda-todos] erro geral", e));
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get("/api/admin/carteira/regenerar-agenda-todos/status", authenticateUser, async (_req: Request, res: Response) => {
    try {
      const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='regen_agenda_todos_last'"));
      const rows = (((r as any).rows || r) as any[]);
      res.json(rows[0] ? JSON.parse(rows[0].value) : { finished: true, total: 0, regenerados: 0, semData: 0, erros: [] });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // SET-PRIMEIRA-DATA-LOTE: fixa a PRIMEIRA visita futura de cada cliente numa data escolhida e
  // encadeia a periodicidade a partir dela (mantendo dia de rota e periodicidade do cadastro).
  // Usado p/ rebalancear rota (ex.: quem nao comprou vem para hoje; quem comprou fica na proxima).
  // items: [{ id, primeiraData 'YYYY-MM-DD' }]. Restrito ao Admin.
  app.post("/api/admin/carteira/set-primeira-data-lote", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      if (!ADMINS_VISITA.includes(esc.email)) return res.status(403).json({ ok: false, error: "Restrito ao Admin." });
      const items = Array.isArray((req.body || {}).items) ? (req.body as any).items : [];
      if (!items.length) return res.status(400).json({ ok: false, error: "items vazio." });
      const out: any[] = [];
      for (const it of items) {
        const id = String((it && it.id) || "");
        const pd = String((it && it.primeiraData) || "");
        if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(pd)) { out.push({ id, ok: false, err: "payload" }); continue; }
        try {
          const rows = (await db.execute(sql`SELECT visit_periodicity::text AS per, weekdays FROM customers WHERE id = ${id} LIMIT 1`)).rows as any[];
          if (!rows.length) { out.push({ id, ok: false, err: "nao encontrado" }); continue; }
          const per = String(rows[0].per || "semanal");
          const dias = diasDoCadastro(rows[0].weekdays);
          if (!dias.length) { out.push({ id, ok: false, err: "sem dia de rota" }); continue; }
          const n = await reprogramarAgenda(id, dias, per, null, pd);
          out.push({ id, ok: true, gravadas: n });
        } catch (e: any) { out.push({ id, ok: false, err: String(e?.message || e).slice(0, 120) }); }
      }
      return res.json({ ok: true, total: items.length, resultados: out });
    } catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
}

/**
 * Apaga as visitas PENDENTES futuras do cliente e regrava as 4 proximas na nova
 * cadencia, ancorando na ultima visita CONCLUIDA — igual ao que a Rota do Dia
 * espera encontrar. Visita ja concluida nunca e' tocada.
 */
async function reprogramarAgenda(customerId: string, dias: string[], periodicidade: string, semanaRegra?: string | null, primeiraData?: string | null): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.name, c.seller_id, c.latitude, c.longitude, c.address,
           COALESCE(c.virtual_service,false) AS virtual,
           c.service_start_date::date::text AS inicio,
           COALESCE(c.semana_atendimento,'toda') AS semana_atendimento,
           (SELECT MAX(COALESCE(v.actual_check_in, v.scheduled_date))::date
              FROM visit_agenda v WHERE v.customer_id = c.id AND v.visit_status = 'completed') AS ultima
    FROM customers c WHERE c.id = ${customerId} LIMIT 1`)).rows as any[];
  if (!rows.length) return 0;
  const c = rows[0];
  const per = (["semanal", "quinzenal", "mensal"].includes(periodicidade) ? periodicidade : "semanal") as any;
  if (!dias.length) return 0;

  const hojeStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hoje = dataLocal(hojeStr);
  const ultima = c.ultima ? dataLocal(String(c.ultima).slice(0, 10)) : undefined;
  const inicio = c.inicio ? dataLocal(String(c.inicio).slice(0, 10)) : undefined;

  // 1a VISITA FIXADA (reclassificacao de periodicidade): a proxima visita e' a
  // data pedida (dia de rota dentro da semana-alvo) e as demais encadeiam a
  // cadencia a partir dela. Tem prioridade sobre a regra de semana do cadastro.
  if (primeiraData && /^\d{4}-\d{2}-\d{2}$/.test(String(primeiraData))) {
    const first = dataLocal(String(primeiraData)); first.setHours(8, 0, 0, 0);
    if (first >= hoje) {
      const datasF: Date[] = [first];
      let cur = first;
      for (let volta = 0; volta < 200 && datasF.length < 4; volta++) {
        const r = calculateNextVisitDate({ weekdays: dias, periodicity: per, lastCompletedDate: cur, serviceStartDate: inicio });
        const d = new Date(r.nextDate); d.setHours(8, 0, 0, 0);
        if (d <= cur) break; // trava de seguranca: cadeia parada
        cur = d;
        datasF.push(d);
      }
      return gravarAgenda(customerId, c, per, datasF, hojeStr);
    }
  }

  // SEMANA FIXA: a agenda real sai do calendario, igual ao quadro. Sem isto a
  // Rota do Dia e a Agenda da Carteira mostrariam datas diferentes.
  const semana = normalizarSemana(semanaRegra ?? c.semana_atendimento);
  if (semana !== "toda") {
    const fim = new Date(hoje);
    fim.setMonth(fim.getMonth() + 5); // 5 meses cobrem 4 visitas ate no mensal
    const alvos = dias.map((d) => DIA_NUM[d]).filter((n) => n !== undefined && n >= 1 && n <= 5);
    const daRegra = datasPelaRegra(hoje, fim, alvos, semana)
      .filter((d) => !inicio || d >= inicio)
      .slice(0, 4)
      .map((d) => { const x = new Date(d); x.setHours(8, 0, 0, 0); return x; });
    return gravarAgenda(customerId, c, per, daRegra, hojeStr);
  }

  const datas: Date[] = [];
  let cursor = ultima;
  // Anda na cadeia ate juntar 4 visitas futuras. O teto de voltas evita loop
  // quando a ancora e' muito antiga (ex.: cliente parado ha um ano).
  for (let volta = 0; volta < 200 && datas.length < 4; volta++) {
    const r = cursor
      ? calculateNextVisitDate({ weekdays: dias, periodicity: per, lastCompletedDate: cursor, serviceStartDate: inicio })
      : calculateNextVisitDate({ weekdays: dias, periodicity: per, referenceDate: hoje, serviceStartDate: inicio });
    const d = new Date(r.nextDate);
    d.setHours(8, 0, 0, 0);
    if (cursor && d <= cursor) break; // trava de seguranca: cadeia parada
    cursor = d;
    if (d >= hoje) datas.push(d);
  }
  return gravarAgenda(customerId, c, per, datas, hojeStr);
}

/** Apaga as pendentes futuras e regrava as datas passadas. */
async function gravarAgenda(customerId: string, c: any, per: string, datas: Date[], hojeStr: string): Promise<number> {
  if (!datas.length) return 0;

  // 🛡️ NUNCA remove a ocorrência de HOJE (nem o passado): limpa só o pendente de AMANHÃ em
  // diante. A visita de hoje já agendada é preservada — a Rota do Dia não encolhe no meio do dia.
  await db.execute(sql`
    DELETE FROM visit_agenda
    WHERE customer_id = ${customerId} AND visit_status = 'pending' AND scheduled_date::date > ${hojeStr}::date`);

  let n = 0;
  for (const d of datas) {
    const routeDay = NUM_DIA[d.getDay()];
    // 🛡️ Não duplica um dia que já tem linha (a visita de HOJE preservada no delete acima).
    const dStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const jaTem: any = await db.execute(sql`SELECT 1 FROM visit_agenda WHERE customer_id = ${customerId} AND scheduled_date::date = ${dStr}::date LIMIT 1`);
    if ((((jaTem as any).rows || jaTem) as any[]).length > 0) continue;
    await db.execute(sql`
      INSERT INTO visit_agenda (customer_id, seller_id, scheduled_date, route_day, recurrence_type,
                                is_virtual, visit_status, customer_name, customer_latitude,
                                customer_longitude, customer_address)
      VALUES (${customerId}, ${c.seller_id}, ${d}, ${routeDay}, ${per},
              ${c.virtual === true}, 'pending', ${c.name}, ${c.latitude}, ${c.longitude}, ${c.address})
      ON CONFLICT DO NOTHING`);
    n++;
  }
  return n;
}
