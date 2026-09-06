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

/** 'YYYY-MM-DD' de hoje em horario de Brasilia. */
function hojeBrasilia(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const ddmm = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;

export type SemanaJanela = { i: number; off: number; ini: string; fim: string; rotulo: string; atual: boolean; passada: boolean };

/** Quantas semanas para tras e para frente da semana vigente o quadro mostra. */
export const SEMANAS_ATRAS = 8;
export const SEMANAS_FRENTE = 8;

/**
 * A JANELA DESLIZANTE de semanas (seg–sex): as 8 passadas, a vigente e as 8
 * proximas. Nao acompanha o mes — o quadro anda junto com a semana de hoje.
 *
 * Semana continua sendo segunda a sexta, ancorada na SEGUNDA. Fim de semana cai
 * na semana que acabou de passar (sabado e domingo pertencem a segunda anterior),
 * que e' como o vendedor le "esta semana" na sexta a tarde.
 */
export function semanasDaJanela(ref: string): SemanaJanela[] {
  const [a, m, d] = ref.split("-").map(Number);
  const hoje = new Date(a, (m || 1) - 1, d || 1);
  const segundaAtual = new Date(hoje);
  segundaAtual.setDate(segundaAtual.getDate() - ((segundaAtual.getDay() + 6) % 7));

  const out: SemanaJanela[] = [];
  for (let off = -SEMANAS_ATRAS; off <= SEMANAS_FRENTE; off++) {
    const ini = new Date(segundaAtual);
    ini.setDate(ini.getDate() + off * 7);
    const fim = new Date(ini);
    fim.setDate(fim.getDate() + 4);
    out.push({
      i: off + SEMANAS_ATRAS + 1,
      off,
      ini: iso(ini),
      fim: iso(fim),
      rotulo: `${ddmm(ini)} a ${ddmm(fim)}`,
      atual: off === 0,
      passada: off < 0,
    });
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
  // GET /api/carteira/agenda   (janela deslizante: 8 semanas atras -> 8 a frente)
  //
  // PASSADO x FUTURO. O quadro cobre semanas que ja aconteceram e semanas que
  // ainda vao acontecer, e as duas metades nao podem sair da mesma conta:
  //   - ate HOJE  -> vem da AGENDA REAL (visit_agenda), o que de fato esteve
  //                  marcado no dia. Projetar o passado a partir da ultima visita
  //                  concluida devolveria vazio, porque a ancora fica no fim dele.
  //   - de AMANHA -> vem da PROJECAO do cadastro, ancorada na ultima visita
  //                  concluida. E' o que faz mudanca de periodicidade/dia
  //                  aparecer na hora, como o Flavio pediu.
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/agenda", authenticateUser, async (req: Request, res: Response) => {
    try {
      const esc = escopo(req);
      const hoje = String(req.query.ref || "").match(/^\d{4}-\d{2}-\d{2}$/) ? String(req.query.ref) : hojeBrasilia();
      const semanas = semanasDaJanela(hoje);
      const ini = semanas[0].ini;
      const fim = semanas[semanas.length - 1].fim;
      // 1º dia projetado: o quadro so' projeta o que ainda nao aconteceu.
      const amanha = (() => { const d = dataLocal(hoje); d.setDate(d.getDate() + 1); return iso(d); })();

      const filtroCarteira = esc.restrito
        ? ` AND c.seller_id IN (${esc.ids.map((i) => `'${i}'`).join(",")})`
        : "";
      const filtroLead = esc.restrito
        ? ` AND (l.assigned_to IN (${esc.ids.map((i) => `'${i}'`).join(",")}))`
        : "";

      // Clientes do cadastro + a ultima visita CONCLUIDA de cada um. Entra quem
      // esta ativo hoje E TAMBEM quem foi inativado mas teve visita na janela —
      // senao o passado do quadro ficaria menor do que realmente foi.
      const clientes = (await db.execute(sql.raw(`
        SELECT c.id, c.name, c.fantasy_name, c.city, c.weekdays, c.visit_periodicity::text AS periodicidade,
               COALESCE(c.virtual_service,false) AS virtual, COALESCE(c.is_lead,false) AS is_lead,
               c.is_active, c.seller_id, c.service_start_date::date::text AS inicio_fornecimento,
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
          AND (
            c.is_active = true
            OR EXISTS (SELECT 1 FROM visit_agenda vj
                        WHERE vj.customer_id = c.id
                          AND vj.scheduled_date::date BETWEEN '${ini}'::date AND '${hoje}'::date)
          )
          ${filtroCarteira}
        LIMIT 20000`))).rows as any[];

      // O que REALMENTE esteve na agenda ate hoje, dentro da janela.
      const passadoPorCliente = new Map<string, string[]>();
      try {
        const passado = (await db.execute(sql.raw(`
          SELECT v.customer_id, v.scheduled_date::date::text AS d
          FROM visit_agenda v
          WHERE v.scheduled_date::date BETWEEN '${ini}'::date AND '${hoje}'::date
          LIMIT 400000`))).rows as any[];
        for (const p of passado) {
          const k = String(p.customer_id || "");
          if (!k || !p.d) continue;
          const l = passadoPorCliente.get(k);
          if (l) { if (!l.includes(p.d)) l.push(p.d); } else passadoPorCliente.set(k, [p.d]);
        }
      } catch (e: any) { console.warn("[carteira-agenda] passado:", e?.message); }

      // PEDIDO NA ULTIMA VISITA. O fechamento de um card grava sempre uma linha
      // em order_history — com venda (status 'completed') ou sem venda. Entao a
      // linha MAIS RECENTE de cada cliente e' o registro da ultima visita, e o
      // valor dela responde "teve pedido?". Sem venda vira 0.
      // Uma varredura so' (DISTINCT ON), nao um lateral por cliente.
      const pedidoPorCliente = new Map<string, { valor: number; data: string | null }>();
      try {
        const pedidos = (await db.execute(sql.raw(`
          SELECT DISTINCT ON (sc.customer_id)
                 sc.customer_id,
                 oh.order_date::date::text AS d,
                 CASE WHEN oh.status = 'completed'
                      THEN COALESCE(NULLIF(oh.total_value::text,'')::numeric, 0)
                      ELSE 0 END::float AS valor
          FROM order_history oh
          JOIN sales_cards sc ON sc.id = oh.sales_card_id
          WHERE oh.order_date >= (now() - interval '18 months')
          ORDER BY sc.customer_id, oh.order_date DESC
          LIMIT 100000`))).rows as any[];
        for (const p of pedidos) {
          const k = String(p.customer_id || "");
          if (k) pedidoPorCliente.set(k, { valor: Number(p.valor || 0), data: p.d || null });
        }
      } catch (e: any) { console.warn("[carteira-agenda] pedidos:", e?.message); }

      const itens: any[] = [];
      for (const r of clientes) {
        const dias = diasDoCadastro(r.weekdays);
        // Futuro: projetado do cadastro. Passado: o que esteve marcado de fato.
        const futuro = projetarDatas({
          dias,
          periodicidade: String(r.periodicidade || "semanal"),
          ancora: r.ultima_visita || null,
          inicioFornecimento: r.inicio_fornecimento || null,
          ini: amanha, fim,
        });
        const anteriores = (passadoPorCliente.get(String(r.id)) || []).filter((d) => {
          const w = dataLocal(d).getDay();
          return w >= 1 && w <= 5;
        });
        const datas = Array.from(new Set([...anteriores, ...futuro])).sort();
        if (!datas.length) continue;
        itens.push({
          id: String(r.id),
          tipo: r.is_lead ? "lead" : "cliente",
          nome: String(r.fantasy_name || r.name || "").trim() || "(sem nome)",
          cidade: r.city || "",
          vendedor: String(r.vendedor || "Sem vendedor"),
          sellerId: String(r.seller_id || ""),
          ativo: r.is_active !== false,
          // Lead e' SEMPRE presencial, mesmo que o cadastro esteja marcado virtual.
          canal: r.is_lead ? "presencial" : (r.virtual ? "virtual" : "presencial"),
          periodicidade: String(r.periodicidade || "semanal"),
          dias,
          ultimaVisita: r.ultima_visita || null,
          pedidoUltimaVisita: pedidoPorCliente.get(String(r.id))?.valor ?? 0,
          dataUltimoPedido: pedidoPorCliente.get(String(r.id))?.data ?? null,
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
            ativo: true,
            canal: "presencial",
            periodicidade: "retorno",
            dias: [NUM_DIA[d.getDay()]],
            ultimaVisita: null,
            // Lead nao tem card de venda fechado — nao ha pedido anterior.
            pedidoUltimaVisita: 0,
            dataUltimoPedido: null,
            datas: [l.retorno],
          });
        }
      } catch (e: any) {
        console.warn("[carteira-agenda] leads:", e?.message);
      }

      res.json({
        hoje, semanas, itens,
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
