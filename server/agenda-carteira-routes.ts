// server/agenda-carteira-routes.ts
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba AGENDA DA CARTEIRA
//
// Tabela dinamica de nº de atendimentos por dia da semana dentro de cada semana
// do mes, separando PRESENCIAL de VIRTUAL, mais a relacao de clientes que
// sustenta cada numero.
//
// DEFINICOES (dadas pelo Flavio, 23/ago/2026):
//
//  1. SEMANA = segunda a sexta, SEM ancoragem no dia 1º. Uma semana pertence ao
//     mes que contem a SEGUNDA-FEIRA dela. Ou seja: se o dia 1º cai no meio da
//     ultima semana do mes anterior, essa semana ainda e' do mes anterior e a
//     semana seguinte e' a 1ª semana do mes novo. Um mes tem 4 ou 5 semanas.
//
//  2. ANCORA = a ULTIMA VISITA CONCLUIDA (visit_agenda.visit_status='completed'),
//     exatamente o mesmo raciocinio da montagem da Rota do Dia: a cadencia se
//     conta a partir dela, encadeando calculateNextVisitDate(). Sem visita
//     concluida, a cadencia parte do inicio da janela.
//
//  3. LEADS SAO SEMPRE PRESENCIAIS. Eles entram pela data de proximo contato
//     (leads.next_contact_date), que e' o que os coloca na rota.
//
//  4. Cliente com virtual_service = true conta como VIRTUAL; o resto e'
//     PRESENCIAL.
//
// A projecao e' recalculada a cada chamada a partir do cadastro — por isso
// qualquer mudanca de periodicidade ou de dia de atendimento aparece na hora,
// sem depender de a visit_agenda ja ter sido regravada.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { calculateNextVisitDate } from "@shared/visitSchedule";
import { normalizeWeekdayInput } from "@shared/schema";
import { calculateDeliveryDaysFromMultipleRoutes } from "@shared/deliveryDaysCalculator";

const TZ = "America/Sao_Paulo";

/** 'YYYY-MM' do mes corrente em horario de Brasilia. */
function mesCorrente(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;

export type SemanaMes = { i: number; ini: string; fim: string; rotulo: string };

/**
 * As semanas (seg–sex) de um mes. Regra: a semana pertence ao mes da SEGUNDA
 * dela. Logo a 1ª semana comeca na 1ª segunda do mes — se o dia 1º for terca,
 * a semana que o contem e' a ultima do mes anterior, como pediu o Flavio.
 */
export function semanasDoMes(mes: string): SemanaMes[] {
  const [ano, m] = mes.split("-").map(Number);
  const primeiraSegunda = new Date(ano, m - 1, 1);
  while (primeiraSegunda.getDay() !== 1) primeiraSegunda.setDate(primeiraSegunda.getDate() + 1);

  const out: SemanaMes[] = [];
  const cursor = new Date(primeiraSegunda);
  while (cursor.getMonth() === m - 1 && cursor.getFullYear() === ano) {
    const sexta = new Date(cursor);
    sexta.setDate(sexta.getDate() + 4);
    out.push({ i: out.length + 1, ini: iso(cursor), fim: iso(sexta), rotulo: `${ddmm(cursor)} a ${ddmm(sexta)}` });
    cursor.setDate(cursor.getDate() + 7);
  }
  return out;
}

/** Escopo: vendedor e telemarketing so enxergam a carteira deles. */
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
 * Datas projetadas de um cliente dentro da janela [ini, fim].
 *
 * Encadeia calculateNextVisitDate a partir da ultima visita concluida — a mesma
 * cadeia que a Rota do Dia usa. Para SEMANAL e QUINZENAL, a semana em que a
 * cadeia cai e' aberta em TODOS os dias configurados do cliente (quem atende
 * Seg e Qua aparece nos dois dias, senao o dia da quarta some do planejamento).
 * MENSAL fica na data unica da cadeia.
 */
export function projetarDatas(params: {
  dias: string[];
  periodicidade: string;
  ancora: string | null;
  inicioFornecimento: string | null;
  ini: string;
  fim: string;
}): string[] {
  const { dias, periodicidade, ancora, inicioFornecimento, ini, fim } = params;
  const alvos = dias.map((d) => DIA_NUM[d]).filter((n) => n !== undefined && n >= 1 && n <= 5);
  if (!alvos.length) return [];

  const dIni = dataLocal(ini);
  const dFim = dataLocal(fim);
  const inicio = inicioFornecimento ? dataLocal(inicioFornecimento) : undefined;
  const per = (["semanal", "quinzenal", "mensal"] as const).includes(periodicidade as any)
    ? (periodicidade as any)
    : "semanal";

  const achadas = new Set<string>();
  const marca = (d: Date) => {
    if (d >= dIni && d <= dFim && d.getDay() >= 1 && d.getDay() <= 5) achadas.add(iso(d));
  };
  /** Abre a semana da data em todos os dias configurados do cliente. */
  const marcaSemana = (d: Date) => {
    const segunda = new Date(d);
    segunda.setDate(segunda.getDate() - ((segunda.getDay() + 6) % 7));
    for (const n of alvos) {
      const dia = new Date(segunda);
      dia.setDate(dia.getDate() + (n - 1));
      marca(dia);
    }
  };

  let cursor: Date | undefined = ancora ? dataLocal(ancora) : undefined;
  // Ancora muito antiga (cliente parado ha meses): adianta a cadeia em ciclos
  // inteiros ate a beira da janela. Sem isso a cadeia gastaria centenas de
  // voltas — ou nem chegaria — em quem nao e' visitado ha um ano.
  if (cursor && cursor < dIni) {
    const passo = per === "semanal" ? 7 : per === "quinzenal" ? 14 : 28;
    const ciclos = Math.floor((dIni.getTime() - cursor.getTime()) / 86400000 / passo) - 1;
    if (ciclos > 0) cursor.setDate(cursor.getDate() + ciclos * passo);
  }
  // Sem visita concluida: a cadeia comeca na 1ª data valida da janela.
  let atual: Date;
  try {
    atual = cursor
      ? calculateNextVisitDate({ weekdays: dias, periodicity: per, lastCompletedDate: cursor, serviceStartDate: inicio }).nextDate
      : calculateNextVisitDate({ weekdays: dias, periodicity: per, referenceDate: dIni, serviceStartDate: inicio }).nextDate;
  } catch {
    return [];
  }

  for (let i = 0; i < 80; i++) {
    if (atual > dFim) break;
    if (per === "mensal") marca(atual);
    else marcaSemana(atual);
    let prox: Date;
    try {
      prox = calculateNextVisitDate({ weekdays: dias, periodicity: per, lastCompletedDate: atual, serviceStartDate: inicio }).nextDate;
    } catch {
      break;
    }
    if (prox <= atual) break; // trava de seguranca
    atual = prox;
  }
  return Array.from(achadas).sort();
}

export function registerAgendaCarteira(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/carteira/agenda?mes=YYYY-MM
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/agenda", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      const mes = (String(req.query.mes || "").match(/^\d{4}-\d{2}$/) ? String(req.query.mes) : mesCorrente());
      const semanas = semanasDoMes(mes);
      if (!semanas.length) return res.json({ mes, semanas: [], itens: [] });
      const ini = semanas[0].ini;
      const fim = semanas[semanas.length - 1].fim;

      const filtroCarteira = esc.restrito
        ? ` AND c.seller_id IN (${esc.ids.map((i) => `'${i}'`).join(",")})`
        : "";
      const filtroLead = esc.restrito
        ? ` AND (l.assigned_to IN (${esc.ids.map((i) => `'${i}'`).join(",")}))`
        : "";

      // Clientes ativos do cadastro + a ultima visita CONCLUIDA de cada um.
      const clientes = (await db.execute(sql.raw(`
        SELECT c.id, c.name, c.fantasy_name, c.city, c.weekdays, c.visit_periodicity::text AS periodicidade,
               COALESCE(c.virtual_service,false) AS virtual, COALESCE(c.is_lead,false) AS is_lead,
               c.seller_id, c.service_start_date::date::text AS inicio_fornecimento,
               COALESCE(vend.nome,'Sem vendedor') AS vendedor,
               va.ultima::text AS ultima_visita
        FROM customers c
        LEFT JOIN LATERAL (
          SELECT NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),'') AS nome
          FROM users u
          WHERE c.seller_id IS NOT NULL AND c.seller_id <> '' AND (
                u.id = c.seller_id
             OR u.omie_vendor_code = c.seller_id
             OR u.omie_vendor_code = REPLACE(c.seller_id,'omie-vendor-','')
          )
          LIMIT 1
        ) vend ON TRUE
        LEFT JOIN LATERAL (
          SELECT MAX(COALESCE(v.actual_check_in, v.scheduled_date))::date AS ultima
          FROM visit_agenda v
          WHERE v.customer_id = c.id AND v.visit_status = 'completed'
        ) va ON TRUE
        WHERE COALESCE(c.is_supplier,false) = false
          AND c.is_active = true
          AND COALESCE(c.omie_status,'ativo') = 'ativo'
          ${filtroCarteira}
        LIMIT 20000`))).rows as any[];

      const itens: any[] = [];
      for (const r of clientes) {
        const dias = diasDoCadastro(r.weekdays);
        const datas = projetarDatas({
          dias,
          periodicidade: String(r.periodicidade || "semanal"),
          ancora: r.ultima_visita || null,
          inicioFornecimento: r.inicio_fornecimento || null,
          ini, fim,
        });
        itens.push({
          id: String(r.id),
          tipo: r.is_lead ? "lead" : "cliente",
          nome: String(r.fantasy_name || r.name || "").trim() || "(sem nome)",
          cidade: r.city || "",
          vendedor: String(r.vendedor || "Sem vendedor"),
          sellerId: String(r.seller_id || ""),
          // Lead e' SEMPRE presencial, mesmo que o cadastro esteja marcado virtual.
          canal: r.is_lead ? "presencial" : (r.virtual ? "virtual" : "presencial"),
          periodicidade: String(r.periodicidade || "semanal"),
          dias,
          ultimaVisita: r.ultima_visita || null,
          datas,
        });
      }

      // LEADS (tabela propria): entram pela data de proximo contato e sao
      // SEMPRE presenciais. Nao tem periodicidade — e' um retorno agendado.
      try {
        const leads = (await db.execute(sql.raw(`
          SELECT l.id, l.fantasy_name, l.city, l.assigned_to, l.next_contact_date::date::text AS retorno,
                 COALESCE(vend.nome,'Sem vendedor') AS vendedor
          FROM leads l
          LEFT JOIN LATERAL (
            SELECT NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),'') AS nome
            FROM users u WHERE l.assigned_to IS NOT NULL AND u.id = l.assigned_to LIMIT 1
          ) vend ON TRUE
          WHERE COALESCE(l.status::text,'pending') NOT IN ('converted','discarded','descartado','convertido')
            AND l.next_contact_date::date BETWEEN '${ini}' AND '${fim}'
            ${filtroLead}
          LIMIT 5000`))).rows as any[];
        for (const l of leads) {
          const d = l.retorno ? dataLocal(l.retorno) : null;
          if (!d || d.getDay() === 0 || d.getDay() === 6) continue;
          itens.push({
            id: String(l.id),
            tipo: "lead",
            nome: String(l.fantasy_name || "").trim() || "(lead sem nome)",
            cidade: l.city || "",
            vendedor: String(l.vendedor || "Sem vendedor"),
            sellerId: String(l.assigned_to || ""),
            canal: "presencial",
            periodicidade: "retorno",
            dias: [NUM_DIA[d.getDay()]],
            ultimaVisita: null,
            datas: [l.retorno],
          });
        }
      } catch (e: any) {
        console.warn("[carteira-agenda] leads:", e?.message);
      }

      res.json({
        mes, semanas, itens,
        escopo: { restrito: esc.restrito, papel: esc.papel, vendedor: esc.nome },
        podeEditarVisita: ADMINS_VISITA.includes(esc.email),
      });
    } catch (e: any) {
      console.error("[carteira-agenda GET]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/carteira/agenda/cliente/:id
  // Altera periodicidade, dia da semana e cidade — grava no CADASTRO e reescreve
  // a visit_agenda pendente, que e' de onde a Rota do Dia le.
  // ---------------------------------------------------------------------------
  app.patch("/api/carteira/agenda/cliente/:id", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      const id = String(req.params.id || "");
      const b: any = req.body || {};
      const ehLead = String(b.tipo || "") === "lead";

      if (ehLead) {
        // Lead: so' cidade e o dia do proximo retorno (nao tem periodicidade).
        const alvo = (await db.execute(sql`SELECT id, assigned_to, city, next_contact_date FROM leads WHERE id = ${id} LIMIT 1`)).rows as any[];
        if (!alvo.length) return res.status(404).json({ ok: false, error: "Lead não encontrado." });
        if (esc.restrito && !esc.ids.includes(String(alvo[0].assigned_to || ""))) {
          return res.status(403).json({ ok: false, error: "Esse lead não está na sua carteira." });
        }
        const cidade = b.cidade === undefined ? undefined : String(b.cidade || "").slice(0, 120);
        const dia = Array.isArray(b.dias) ? String(b.dias[0] || "") : String(b.dia || "");
        const alvoNum = DIA_NUM[dia];
        let novaData: Date | null = null;
        if (alvoNum !== undefined && alvoNum >= 1 && alvoNum <= 5) {
          const base = alvo[0].next_contact_date ? new Date(alvo[0].next_contact_date) : new Date();
          base.setHours(8, 0, 0, 0);
          // Move o retorno para o dia pedido DENTRO da mesma semana (seg como inicio).
          const segunda = new Date(base);
          segunda.setDate(segunda.getDate() - ((segunda.getDay() + 6) % 7));
          novaData = new Date(segunda);
          novaData.setDate(novaData.getDate() + (alvoNum - 1));
          novaData.setHours(8, 0, 0, 0);
        }
        if (cidade !== undefined) await db.execute(sql`UPDATE leads SET city = ${cidade || null}, updated_at = now() WHERE id = ${id}`);
        if (novaData) await db.execute(sql`UPDATE leads SET next_contact_date = ${novaData}, updated_at = now() WHERE id = ${id}`);
        return res.json({ ok: true, tipo: "lead" });
      }

      const atualRows = (await db.execute(sql`
        SELECT id, name, seller_id, city, weekdays, visit_periodicity::text AS periodicidade,
               COALESCE(virtual_service,false) AS virtual, latitude, longitude, address
        FROM customers WHERE id = ${id} LIMIT 1`)).rows as any[];
      if (!atualRows.length) return res.status(404).json({ ok: false, error: "Cliente não encontrado." });
      const atual = atualRows[0];
      if (esc.restrito && !esc.ids.includes(String(atual.seller_id || ""))) {
        return res.status(403).json({ ok: false, error: "Esse cliente não está na sua carteira." });
      }

      const diasAtuais = diasDoCadastro(atual.weekdays);
      const perAtual = String(atual.periodicidade || "");
      const podeAlterar = ADMINS_VISITA.includes(esc.email);

      // --- dias da semana ------------------------------------------------------
      let novosDias: string[] | null = null;
      if (b.dias !== undefined) {
        try { novosDias = normalizeWeekdayInput(b.dias) as string[]; }
        catch { return res.status(400).json({ ok: false, error: "Dia da semana inválido." }); }
        if (!novosDias.length) return res.status(400).json({ ok: false, error: "Escolha pelo menos um dia." });
        const igual = [...diasAtuais].sort().join(",") === [...novosDias].sort().join(",");
        if (igual) novosDias = null;
        else if (diasAtuais.length > 0 && !podeAlterar) {
          return res.status(403).json({ ok: false, error: "Alterar o dia de atendimento de um cliente que já tem dia definido é restrito ao Admin." });
        }
      }

      // --- periodicidade -------------------------------------------------------
      let novaPer: string | null = null;
      if (b.periodicidade !== undefined) {
        const p = String(b.periodicidade || "");
        if (!["semanal", "quinzenal", "mensal"].includes(p)) {
          return res.status(400).json({ ok: false, error: "Periodicidade inválida." });
        }
        if (p === perAtual) novaPer = null;
        else if (perAtual && !podeAlterar) {
          return res.status(403).json({ ok: false, error: "Alterar a periodicidade de um cliente que já tem periodicidade definida é restrito ao Admin." });
        } else novaPer = p;
      }

      const novaCidade = b.cidade === undefined ? null : String(b.cidade || "").slice(0, 120);

      if (novosDias === null && novaPer === null && novaCidade === null) {
        return res.json({ ok: true, semMudanca: true });
      }

      // --- grava o cadastro ----------------------------------------------------
      const sets: any[] = [];
      if (novosDias) {
        sets.push(sql`weekdays = ${JSON.stringify(novosDias)}`);
        try {
          const entrega = calculateDeliveryDaysFromMultipleRoutes(novosDias as any);
          sets.push(sql`delivery_weekdays = ${JSON.stringify(entrega)}::jsonb`);
        } catch { /* dias de entrega sao sinalizacao; nao travam a edicao */ }
      }
      if (novaPer) sets.push(sql`visit_periodicity = ${novaPer}::visit_periodicity`);
      if (novaCidade !== null) sets.push(sql`city = ${novaCidade || null}`);
      sets.push(sql`updated_at = now()`);
      await db.execute(sql`UPDATE customers SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);

      // --- auditoria do cadastro ----------------------------------------------
      try {
        const { logCustomerChanges } = await import("./customerAudit");
        const mudou: any = {};
        if (novosDias) mudou.weekdays = JSON.stringify(novosDias);
        if (novaPer) mudou.visitPeriodicity = novaPer;
        if (novaCidade !== null) mudou.city = novaCidade || null;
        await logCustomerChanges({
          customerId: id,
          before: { weekdays: atual.weekdays, visitPeriodicity: perAtual, city: atual.city },
          changes: mudou,
          actor: { id: esc.usuario?.id, name: esc.nome },
          source: "edit",
        } as any);
      } catch (e: any) { console.warn("[carteira-agenda] auditoria:", e?.message); }

      // --- reescreve a agenda pendente (e' dai que sai a Rota do Dia) ----------
      let regravadas = 0;
      if (novosDias || novaPer) {
        try {
          regravadas = await reprogramarAgenda(id, novosDias || diasAtuais, novaPer || perAtual || "semanal");
        } catch (e: any) { console.warn("[carteira-agenda] agenda:", e?.message); }
        // Alinha os sales cards futuros com o novo cadastro (mesma rotina do PATCH de cliente).
        try {
          const { updateExistingSalesCardsFromCustomer } = await import("./visitScheduleService");
          await updateExistingSalesCardsFromCustomer(id);
        } catch (e: any) { console.warn("[carteira-agenda] cards:", e?.message); }
      }

      res.json({ ok: true, visitasRegravadas: regravadas });
    } catch (e: any) {
      console.error("[carteira-agenda PATCH]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}

/**
 * Apaga as visitas PENDENTES futuras do cliente e regrava as 4 proximas na nova
 * cadencia, ancorando na ultima visita CONCLUIDA — igual ao que a Rota do Dia
 * espera encontrar. Visita ja concluida nunca e' tocada.
 */
async function reprogramarAgenda(customerId: string, dias: string[], periodicidade: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.name, c.seller_id, c.latitude, c.longitude, c.address,
           COALESCE(c.virtual_service,false) AS virtual,
           c.service_start_date::date::text AS inicio,
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
  if (!datas.length) return 0;

  await db.execute(sql`
    DELETE FROM visit_agenda
    WHERE customer_id = ${customerId} AND visit_status = 'pending' AND scheduled_date::date >= ${hojeStr}::date`);

  let n = 0;
  for (const d of datas) {
    const routeDay = NUM_DIA[d.getDay()];
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
