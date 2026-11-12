import type { Express } from 'express';
import { db } from './db';
import { geocodeOne, geocodeThrottleMs } from './geocode-provider';
import { sql, and, eq, gte, lte, isNotNull, inArray, desc } from 'drizzle-orm';
import {
  repescagemAttendants,
  repescagemAssignments,
  repescagemAssignmentHistory,
  users,
  customers,
  activeCustomers,
  visitScheduleHistory,
  routeCheckpoints,
  billings,
  billingPipeline as billingPipelineTable,
  virtualServiceLogs,
  dailyRoutes,
  leads,
} from '@shared/schema';
import { computeCycles, evaluateRepescagem, cyclesToShow, parseDows as parseDowsCycle, isPlanned as isPlannedCycle } from './repescagem-cycles';
import { whatsappService } from './whatsapp-service';
import { storage } from './storage';
import { logCustomerChanges, logCustomerNote } from './customerAudit';
import { retiradosHoje, registerRepescagemRetirar } from './repescagem-retirar';

const ALLOWED_ROLES = ['admin', 'gerente', 'supervisor', 'administrative', 'coordinator', 'telemarketing'];

// ── Repescagem2 ──────────────────────────────────────────────────────────────
// Elegibilidade do sorteio: usuários com função de vendedor externo OU
// telemarketing, EXCETO os três abaixo. Admins gerenciam a habilitação, mas
// não entram no sorteio. Não há auto-habilitação (somente admin habilita).
const REPESCAGEM_ELIGIBLE_ROLES = ['vendedor', 'telemarketing'];
const REPESCAGEM_EXCLUDED_USER_IDS = new Set<string>([
  'omie-vendor-2425693369',               // Flavio E
  'omie-vendor-4253571754',               // Fabio H
  'a0903a77-a217-4989-8e0c-7d9ca2ac36cf', // HOTSITE
  'bcdda258-90cb-408a-9d40-dfc0ced2d481', // INSTAGRAM
  'omie-vendor-4324270246',               // Lorenna Pina
  // NAO sao atendentes de repescagem (manter apenas os ativos da operacao: Leticia e Robson):
  '58f7ba0b-dcd1-4d0e-abc2-458cdddb2794', // Honest Admin (conta Honest 1)
  'f87166f7-0431-4bd1-8c8c-074d13b2c861', // Honest Fornecedores (conta Honest 2)
  'omie-vendor-4317814615',               // Natalia B.
  'omie-vendor-4323360115',               // Maria E.
]);

// CONTAS DE SISTEMA/CANAL: nunca aparecem como atendentes de repescagem (nov/2026).
// As PESSOAS que estavam fixas fora (Flavio E, Fabio H, Lorenna, Natalia B, Maria E) passaram a
// ser incluídas/tiradas pelo admin no painel ("Fora da repescagem" -> Incluir). A lista acima
// (REPESCAGEM_EXCLUDED_USER_IDS) continua valendo só para a MIGRAÇÃO de carteira.
const REPESCAGEM_SYSTEM_USER_IDS = new Set<string>([
  'a0903a77-a217-4989-8e0c-7d9ca2ac36cf', // HOTSITE
  'bcdda258-90cb-408a-9d40-dfc0ced2d481', // INSTAGRAM
  '58f7ba0b-dcd1-4d0e-abc2-458cdddb2794', // Honest Admin (conta Honest 1)
  'f87166f7-0431-4bd1-8c8c-074d13b2c861', // Honest Fornecedores (conta Honest 2)
]);
const REPESCAGEM_FORMER_EXCLUDED_PEOPLE = Array.from(REPESCAGEM_EXCLUDED_USER_IDS).filter(id => !REPESCAGEM_SYSTEM_USER_IDS.has(id));
// Uma única vez: quem estava fixo fora começa DESLIGADO (o painel passa a mandar). Idempotente.
let __pessoasForaMigradas: Promise<void> | null = null;
function ensureFormerExcludedOff(): Promise<void> {
  if (!__pessoasForaMigradas) {
    __pessoasForaMigradas = (async () => {
      await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS repescagem_flags (key text PRIMARY KEY, done_at timestamptz DEFAULT now())"));
      const r: any = await db.execute(sql`INSERT INTO repescagem_flags (key) VALUES ('pessoas_fora_desligadas') ON CONFLICT (key) DO NOTHING RETURNING key`);
      if (((r.rows || r) as any[]).length > 0 && REPESCAGEM_FORMER_EXCLUDED_PEOPLE.length > 0) {
        await db.update(repescagemAttendants).set({ isEnabled: false, updatedAt: new Date() })
          .where(inArray(repescagemAttendants.userId, REPESCAGEM_FORMER_EXCLUDED_PEOPLE));
      }
    })().catch((e) => { console.error('[repescagem][pessoas-fora]', (e as any)?.message); __pessoasForaMigradas = null; });
  }
  return __pessoasForaMigradas;
}

// Carteiras (vendedor dono do cliente) que NAO entram em repescagem: canais/sistema
// Honest 1/2/3, HOTSITE, INSTAGRAM. Clientes dessas carteiras sao ignorados no gatilho.
const REPESCAGEM_EXCLUDED_SELLER_IDS = new Set<string>([
  '58f7ba0b-dcd1-4d0e-abc2-458cdddb2794', // Honest 1
  'f87166f7-0431-4bd1-8c8c-074d13b2c861', // Honest 2
  'c5868c11-790a-46d1-ba87-2023452c8303', // Honest 3
  'a0903a77-a217-4989-8e0c-7d9ca2ac36cf', // HOTSITE
  'bcdda258-90cb-408a-9d40-dfc0ced2d481', // INSTAGRAM
]);

// Roteamento especial por carteira (dono) e idade na repescagem (dias):
//  - Gilmar (até 3 dias)   -> Letícia (travado)
//  - Jhonatan (até 3 dias) -> Robson  (travado)
//  - Carlos (até 3 dias)   -> Letícia/Robson 50/50 (travado, determinístico por cliente)
// Fora da janela e demais vendedores seguem a distribuição normal entre habilitados.
const REP_ROUTE = {
  GILMAR: 'omie-vendor-3882132483',
  CARLOS: 'omie-vendor-4325830798',
  RADILTON: 'e9149282-adfc-448e-8d0e-a07765a06637',
  JHONATAN: 'b35a9dd5-7a49-4c65-9002-01407b859961',
  CLEBER: '883af1f5-0400-40b5-8add-091a29bbbe1e',
  LETICIA: '9faf8fa3-698d-4f90-9607-3f1ff7787a2b',
  ROBSON: 'omie-vendor-4077616122',
};
// Repescagem2 (carteiras configuraveis): o roteamento ESPECIAL (carteira -> atendente) agora
// vem da CONFIG do painel (repescagem_attendants.carteiras), nao mais de constantes fixas.
// Regra: uma carteira que aparece no campo de um atendente que NAO e o proprio dono dela =
// roteamento especial para esse atendente (e "card duplo" na rota do dono). Se a mesma carteira
// estiver em 2+ atendentes (fora o dono), os clientes sao divididos IGUALMENTE entre eles
// (split deterministico por customerId). A carteira PROPRIA (sellerId == userId do atendente)
// NAO e especial: cai na distribuicao normal por perimetro (comportamento inalterado).
// Os defaults semeados espelham o de hoje: Carlos+Radilton->Leticia, Jhonatan+Cleber->Robson,
// Gilmar->Leticia+Robson (50/50).

// Receptor de uma carteira: atendente + peso (% escolhido no painel, 10..100). pct=null => sem
// escolha explicita (usa rateio igualitario como fallback, comportamento antigo).
type Receiver = { userId: string; pct: number | null };

// Carrega o mapa carteira(sellerId de origem) -> [receptores {userId, pct}, exceto o proprio dono],
// considerando apenas atendentes habilitados (com >= 1 carteira). Ordem estavel por userId.
async function loadSpecialCrossReceivers(): Promise<Map<string, Receiver[]>> {
  const rows = await db.select().from(repescagemAttendants);
  const map = new Map<string, Receiver[]>();
  for (const r of rows) {
    const cart = Array.isArray((r as any).carteiras) ? ((r as any).carteiras as string[]) : [];
    if (cart.length === 0) continue; // sem carteira = nao recebe roteamento especial
    if ((r as any).isEnabled === false || REPESCAGEM_SYSTEM_USER_IDS.has(r.userId)) continue; // desligado no painel
    const pcts = ((r as any).carteiraPcts && typeof (r as any).carteiraPcts === 'object') ? (r as any).carteiraPcts as Record<string, number> : {};
    for (const src of cart) {
      if (!src || src === r.userId) continue; // carteira propria nao e roteamento especial
      if (!map.has(src)) map.set(src, []);
      const arr = map.get(src)!;
      if (!arr.some(x => x.userId === r.userId)) {
        const raw = Number(pcts[src]);
        arr.push({ userId: r.userId, pct: Number.isFinite(raw) && raw > 0 ? raw : null });
      }
    }
  }
  for (const [, arr] of map) arr.sort((a, b) => a.userId.localeCompare(b.userId));
  return map;
}

// Alvo do roteamento especial da carteira `ownerId`, ou null (sem especial -> distribuicao normal).
// splitTarget = alvo pre-calculado (por peso) quando a carteira tem 2+ receptores.
function repescagemSpecialTarget(ownerId: string | null, crossReceivers: Map<string, Receiver[]>, splitTarget?: string): string | null {
  if (!ownerId) return null;
  const recs = crossReceivers.get(ownerId);
  if (!recs || recs.length === 0) return null;
  if (recs.length === 1) return recs[0].userId;
  return splitTarget || recs[0].userId;
}

// Split deterministico dos clientes de carteiras com 2+ receptores, POR PESO (% escolhido). Se
// nenhum receptor da carteira tem % explicito, cai no rateio IGUALITARIO (comportamento antigo).
// Usa maior-resto para contagens exatas e blocos contiguos por customerId ordenado (estavel).
function repescagemSplitLR(cands: Array<{ customerId: string }>, ownerOf: (id: string) => string | null, crossReceivers: Map<string, Receiver[]>): Map<string, string> {
  const out = new Map<string, string>();
  const byCarteira = new Map<string, string[]>();
  for (const c of cands) {
    const o = ownerOf(c.customerId);
    if (!o) continue;
    const recs = crossReceivers.get(o);
    if (!recs || recs.length < 2) continue;
    if (!byCarteira.has(o)) byCarteira.set(o, []);
    byCarteira.get(o)!.push(c.customerId);
  }
  for (const [carteira, idsRaw] of byCarteira) {
    const recs = crossReceivers.get(carteira)!;
    const ids = idsRaw.slice().sort();
    // pesos: % escolhido; % NAO escolhido = 100 (antes virava peso zero quando outro receptor
    // tinha %, e o atendente nunca recebia — caso Leticia, nov/2026). A atribuicao aqui e so o
    // "responsavel principal": a rota do dia mostra a carteira a TODOS que a recebem (compartilhada).
    const weights = recs.map(r => (r.pct != null && r.pct > 0 ? r.pct : 100));
    const totalW = weights.reduce((a, b) => a + b, 0) || recs.length;
    const n = ids.length;
    // contagem alvo por receptor (maior-resto)
    const exact = weights.map(w => (n * w) / totalW);
    const counts = exact.map(x => Math.floor(x));
    let rem = n - counts.reduce((a, b) => a + b, 0);
    const order = exact
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < order.length && rem > 0; k++) { counts[order[k].i]++; rem--; }
    // atribui blocos contiguos na ordem dos receptores
    let pos = 0;
    for (let i = 0; i < recs.length; i++) {
      for (let j = 0; j < counts[i] && pos < n; j++, pos++) out.set(ids[pos], recs[i].userId);
    }
  }
  return out;
}

// Defaults de carteiras que ESPELHAM o roteamento de hoje. Semeados uma unica vez por atendente
// (apenas quando o campo ainda esta vazio). A carteira propria e adicionada para todo atendente
// habilitado; Leticia/Robson recebem tambem as carteiras cruzadas de hoje.
function defaultCarteirasFor(userId: string, wasEnabled: boolean): string[] {
  const set = new Set<string>();
  if (wasEnabled) set.add(userId); // carteira propria (pre-marcada, editavel)
  if (userId === REP_ROUTE.LETICIA) { set.add(REP_ROUTE.LETICIA); set.add(REP_ROUTE.CARLOS); set.add(REP_ROUTE.RADILTON); set.add(REP_ROUTE.GILMAR); }
  if (userId === REP_ROUTE.ROBSON) { set.add(REP_ROUTE.ROBSON); set.add(REP_ROUTE.JHONATAN); set.add(REP_ROUTE.CLEBER); set.add(REP_ROUTE.GILMAR); }
  return Array.from(set);
}

// Semeia as carteiras UMA UNICA VEZ (quando nenhum atendente tem carteira configurada ainda),
// espelhando exatamente o roteamento de hoje. Depois disso, o painel e a fonte da verdade.
async function seedRepescagemCarteirasIfEmpty(): Promise<void> {
  const rows = await db.select().from(repescagemAttendants);
  if (rows.length === 0) return;
  const anyConfigured = rows.some(r => Array.isArray((r as any).carteiras) && ((r as any).carteiras as string[]).length > 0);
  if (anyConfigured) return; // ja configurado — nao mexe
  let n = 0;
  for (const r of rows) {
    const def = defaultCarteirasFor(r.userId, !!r.isEnabled);
    if (def.length === 0) continue; // desabilitado sem papel especial — fica sem carteira
    await db.update(repescagemAttendants)
      .set({ carteiras: def as any, isEnabled: true, updatedAt: new Date() })
      .where(eq(repescagemAttendants.userId, r.userId));
    n++;
  }
  if (n > 0) console.log(`[REPESCAGEM2] carteiras semeadas para ${n} atendente(s) (espelho do roteamento atual).`);
}

function brTodayStr(): string {
  const now = new Date();
  const offset = -3 * 60; // BRT
  const local = new Date(now.getTime() + (offset - now.getTimezoneOffset()) * 60000);
  return local.toISOString().split('T')[0];
}

// Computa o conjunto de candidatos vermelhos: clientes ativos cuja
// ÚLTIMA visita registrada (passada) é "vermelha" (agendada não efetuada
// e SEM pedido na data).
type SkipCiclo = { customerId: string; anchor: string };
// Data (YYYY-MM-DD) de início do fornecimento/atendimento do cliente (quarentena), ou null.
function dataInicioAtendimento(v: any): string | null {
  if (!v) return null;
  try {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
    if (m) return m[1];
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  } catch { return null; }
}
// Pular ciclo automatico por venda fora do dia de rota: desligado (ver gatilho abaixo).
const AUTO_PULAR_CICLO = false;
async function computeRedCandidates(opts: { startDate: string; endDate: string }, skipOut?: SkipCiclo[]): Promise<any[]> {
  try {
    const cands = await __computeRedCandidatesRaw(opts, skipOut);
    // 10/nov/2026 — Retirados da repescagem HOJE pelo Admin (Inbox) não entram em nada hoje.
    const fora = await retiradosHoje();
    return fora.size ? cands.filter((c: any) => !fora.has(String(c.customerId))) : cands;
  } catch (e) { console.error('[computeRedCandidates] fallback:', (e as any)?.message); return []; }
}

async function __computeRedCandidatesRaw(opts: { startDate: string; endDate: string }, skipOut?: SkipCiclo[]) {
  const { startDate, endDate } = opts;

  // 1) Clientes ativos
  const activeRows = await db.select({ customerId: activeCustomers.customerId })
    .from(activeCustomers)
    .where(and(eq(activeCustomers.isActive, true), isNotNull(activeCustomers.customerId)));
  const customerIds = Array.from(new Set(activeRows.map(r => r.customerId).filter(Boolean) as string[]));
  if (customerIds.length === 0) return [];

  const cs = await db.select({
    id: customers.id,
    name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
    sellerId: customers.sellerId,
    weekdays: customers.weekdays,
    periodicity: customers.visitPeriodicity,
    semanaAtendimento: customers.semanaAtendimento,
    serviceStartDate: customers.serviceStartDate,
    omieClientCode: customers.omieClientCode,
    isActive: customers.isActive,
    isSupplier: customers.isSupplier,
    situacao: customers.situacao,
  }).from(customers).where(inArray(customers.id, customerIds));

  // Função (role) do DONO da carteira de cada candidato. Regra: SOMENTE clientes de
  // carteira de VENDEDOR EXTERNO (role 'vendedor') entram em repescagem. Clientes de
  // carteira de telemarketing (ou sem dono/outro papel) NÃO caem em repescagem.
  const candSellerIds = Array.from(new Set(cs.map(c => c.sellerId).filter(Boolean) as string[]));
  const candSellerRoleRows = candSellerIds.length
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, candSellerIds))
    : [];
  const candSellerRoleById = new Map(candSellerRoleRows.map(u => [u.id, u.role]));

  // Clientes vinculados a uma REDE de clientes (cliente_rede_membros) NÃO entram em
  // repescagem — a negociação/atendimento da rede é conduzido pelo destinatário da rede,
  // não pelo fluxo de repescagem individual. (Set global; a tabela tem 1 linha por membro.)
  const redeMemberIds = new Set<string>();
  try {
    const rm: any = await db.execute(sql`SELECT customer_id FROM cliente_rede_membros`);
    for (const r of ((rm.rows || []) as any[])) if (r.customer_id) redeMemberIds.add(String(r.customer_id));
  } catch (e) { console.warn('[computeRedCandidates][rede] tabela ausente/erro:', (e as any)?.message); }

  // 2) Visitas registradas (visit_schedule_history) — usado para marcar "efetuada"
  const visits = await db.select({
    customerId: visitScheduleHistory.customerId,
    scheduledDate: visitScheduleHistory.scheduledDate,
    visitStatus: visitScheduleHistory.visitStatus,
    checkInTime: visitScheduleHistory.checkInTime,
  }).from(visitScheduleHistory).where(
    and(
      sql`${visitScheduleHistory.scheduledDate} >= ${startDate}`,
      sql`${visitScheduleHistory.scheduledDate} <= ${endDate}`,
    )
  );
  const visitMap = new Map<string, any[]>();
  for (const v of visits) {
    const key = `${v.customerId}_${v.scheduledDate}`;
    if (!visitMap.has(key)) visitMap.set(key, []);
    visitMap.get(key)!.push(v);
  }

  // 2b) Datas agendadas inferidas de weekdays + periodicity (mesma lógica do VisitSummary)
  const WEEKDAY_MAP: Record<string, number> = {
    'Dom': 0, 'Seg': 1, 'Ter': 2, 'Qua': 3, 'Qui': 4, 'Sex': 5, 'Sab': 6,
    'domingo': 0, 'segunda': 1, 'terca': 2, 'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6,
  };
  const PERIODICITY_DAYS: Record<string, number> = { semanal: 7, quinzenal: 14, mensal: 28 };
  function parseWeekdays(raw: any): string[] {
    try {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') return JSON.parse(raw);
      return [];
    } catch { return []; }
  }
  // MESMA logica do Resumo de Visitas: uma data e "dia de rota" (agendada) via isPlanned
  // (semanal = todo dia da semana marcado; quinzenal = semana de indice par; mensal = 1a
  // ocorrencia do dia no mes). Antes usava intervalo de ~14/28 dias a partir do inicio da janela,
  // o que divergia do Resumo de Visitas para quinzenal/mensal.
  function getScheduledDates(weekdays: string[], periodicity: string, startStr: string, endStr: string, semana?: any): string[] {
    const dows = parseDowsCycle(weekdays as any);
    if (dows.length === 0) return [];
    const dates: string[] = [];
    const current = new Date(startStr + 'T12:00:00Z');
    const end = new Date(endStr + 'T12:00:00Z');
    while (current <= end) {
      const ds = current.toISOString().split('T')[0];
      if (isPlannedCycle(ds, dows, periodicity, semana)) dates.push(ds);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }
  const scheduledByCustomer = new Map<string, Set<string>>();
  for (const c of cs) {
    const wd = parseWeekdays(c.weekdays);
    const dates = getScheduledDates(wd, c.periodicity || 'semanal', startDate, endDate, (c as any).semanaAtendimento);
    if (dates.length > 0) scheduledByCustomer.set(c.id, new Set(dates));
  }
  // 2c) DIA DE ROTA REAL (23/out/2026, pedido do Flavio): a data da agenda (visit_agenda) e o dia
  // de rota de verdade — inclui a visita POSTERGADA/ANTECIPADA por feriado (ex.: feriado 12/10,
  // visita na terca 13/10). Antes so valia o calendario puro (toda segunda), entao a venda feita
  // na visita deslocada era lida como "venda fora do dia de rota" e o cliente perdia o ciclo
  // seguinte (ZOI, Della, Padoca sumiram da rota de 19/10). Une a agenda real ao calendario e
  // retira do calendario o dia original de uma visita deslocada por feriado.
  try {
    const ag: any = await db.execute(sql`
      SELECT customer_id, scheduled_date::date::text AS d, holiday_original_date::date::text AS orig
        FROM visit_agenda
       WHERE scheduled_date::date >= ${startDate}::date
         AND scheduled_date::date <= ${endDate}::date
         AND COALESCE(visit_status, 'pending') <> 'cancelled'
         AND customer_id = ANY(${sql.raw("ARRAY[" + customerIds.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',') + "]::text[]")})`);
    for (const r of ((ag.rows || ag) as any[])) {
      const cid = String(r.customer_id || ''); if (!cid || !r.d) continue;
      let set = scheduledByCustomer.get(cid);
      if (!set) { set = new Set<string>(); scheduledByCustomer.set(cid, set); }
      set.add(String(r.d));
      if (r.orig) set.delete(String(r.orig)); // o dia do feriado deixou de ser dia de rota
    }
  } catch (e) { console.warn('[computeRedCandidates][agenda-real] falha (segue so com calendario):', (e as any)?.message); }

  // 3) Checkpoints (route check-ins indicam visita efetuada)
  const cps = await db.select({
    customerId: routeCheckpoints.customerId,
    checkpointTime: routeCheckpoints.checkpointTime,
  }).from(routeCheckpoints).where(
    and(
      sql`DATE(${routeCheckpoints.checkpointTime}) >= ${startDate}`,
      sql`DATE(${routeCheckpoints.checkpointTime}) <= ${endDate}`,
      eq(routeCheckpoints.checkpointType, 'check_in'),
    )
  );
  const checkpointSet = new Set<string>();
  for (const c of cps) {
    if (!c.customerId || !c.checkpointTime) continue;
    const ds = new Date(c.checkpointTime).toISOString().split('T')[0];
    checkpointSet.add(`${c.customerId}_${ds}`);
  }

  // 3.1) Check-in do CARD de venda (sales_cards.check_in_time) — MESMA fonte de "visita efetuada"
  // usada no Resumo de Visitas (bolinha amarela = visitado sem pedido). Sem isto, um cliente
  // visitado que aparece AMARELO no Resumo ainda cairia em repescagem. A data da visita = a
  // scheduled_date do card. Consolidado no mesmo conjunto de checkpoints ("visita feita").
  try {
    const scc = (await db.execute(sql`
      SELECT customer_id AS cid, (scheduled_date)::date::text AS d
      FROM sales_cards
      WHERE scheduled_date IS NOT NULL
        AND (scheduled_date)::date >= ${startDate} AND (scheduled_date)::date <= ${endDate}
        AND check_in_time IS NOT NULL AND customer_id IS NOT NULL
      GROUP BY customer_id, d
    `)).rows as any[];
    for (const r of scc) {
      if (!r.cid || !r.d) continue;
      checkpointSet.add(`${r.cid}_${r.d}`);
    }
  } catch (e) { console.warn('[computeRedCandidates] sales_cards check-in:', (e as any)?.message); }

  // 3.2) Check-in da AGENDA de visita (visit_agenda.actual_check_in) — quando o vendedor faz o
  // check-in na Rota do Dia, o registro pode ficar so' aqui. Conta como "visita feita" (data BR).
  try {
    const vac = (await db.execute(sql`
      SELECT customer_id AS cid,
             (actual_check_in AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS d
      FROM visit_agenda
      WHERE actual_check_in IS NOT NULL AND customer_id IS NOT NULL
        AND (actual_check_in AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= ${startDate}
        AND (actual_check_in AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date <= ${endDate}
      GROUP BY customer_id, d
    `)).rows as any[];
    for (const r of vac) { if (r.cid && r.d) checkpointSet.add(`${r.cid}_${r.d}`); }
  } catch (e) { console.warn('[computeRedCandidates] visit_agenda check-in:', (e as any)?.message); }

  // 3.3) Atendimento REGISTRADO na propria repescagem (assignment concluido) — o atendente marcou
  // o cliente como atendido. Conta como atendimento (data da conclusao, BR), mesmo que por algum
  // motivo nao haja log virtual espelhado. Garante que "atendido nao cai no dia seguinte".
  try {
    const rc = (await db.execute(sql`
      SELECT customer_id AS cid,
             (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date::text AS d
      FROM repescagem_assignments
      WHERE status = 'completed' AND completed_at IS NOT NULL AND customer_id IS NOT NULL
        AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= ${startDate}
        AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date <= ${endDate}
      GROUP BY customer_id, d
    `)).rows as any[];
    for (const r of rc) { if (r.cid && r.d) checkpointSet.add(`${r.cid}_${r.d}`); }
  } catch (e) { console.warn('[computeRedCandidates] repescagem concluida:', (e as any)?.message); }

  // 3.5) Atendimentos virtuais (registrados em resgate) contam como visita
  const vlogs = await db.select({
    customerId: virtualServiceLogs.customerId,
    attendanceDate: virtualServiceLogs.attendanceDate,
  }).from(virtualServiceLogs).where(
    and(
      sql`DATE(${virtualServiceLogs.attendanceDate}) >= ${startDate}`,
      sql`DATE(${virtualServiceLogs.attendanceDate}) <= ${endDate}`,
      // Contato automático da IA da repescagem NÃO é atendimento (nov/2026).
      sql`NOT (${virtualServiceLogs.attendantId} = 'ia' AND COALESCE(${virtualServiceLogs.serviceType}, '') = 'repescagem_ia')`,
    )
  );
  const virtualLogSet = new Set<string>();
  for (const v of vlogs) {
    if (!v.customerId || !v.attendanceDate) continue;
    const ds = new Date(v.attendanceDate).toISOString().split('T')[0];
    virtualLogSet.add(`${v.customerId}_${ds}`);
  }

  // 4) Pedidos (billings + pipeline)
  const orderSet = new Set<string>();
  const omieCodeToCustomerId = new Map<string, string>();
  for (const c of cs) {
    if (c.omieClientCode) omieCodeToCustomerId.set(c.omieClientCode, c.id);
  }
  const billingOrders = await db.select({
    omieCustomerCode: billings.omieCustomerCode,
    orderStr: sql<string>`DATE(${billings.orderDate})::text`,
    invoiceStr: sql<string>`DATE(${billings.invoiceDate})::text`,
  }).from(billings).where(
    and(
      eq(billings.isCancelled, false),
      sql`COALESCE(CAST(${billings.totalValue} AS NUMERIC), 0) > 0`,
      // Conta a venda pela data do PEDIDO **ou** pela data da NOTA (faturamento): basta uma das
      // duas cair na janela. Antes usava so COALESCE(pedido, nota), entao um faturamento do mes
      // vindo de um pedido de mes anterior nao contava e o cliente mensal caia na repescagem.
      sql`(
        (${billings.orderDate} IS NOT NULL AND DATE(${billings.orderDate}) >= ${startDate} AND DATE(${billings.orderDate}) <= ${endDate})
        OR (${billings.invoiceDate} IS NOT NULL AND DATE(${billings.invoiceDate}) >= ${startDate} AND DATE(${billings.invoiceDate}) <= ${endDate})
      )`,
    )
  );
  // Datas que contam como venda deste faturamento: pedido E nota (sem duplicar se forem iguais).
  const billingDatesOf = (b: { orderStr?: string | null; invoiceStr?: string | null }): string[] => {
    const out: string[] = [];
    if (b.orderStr) out.push(b.orderStr);
    if (b.invoiceStr && b.invoiceStr !== b.orderStr) out.push(b.invoiceStr);
    return out;
  };
  for (const b of billingOrders) {
    const cid = omieCodeToCustomerId.get(b.omieCustomerCode || '');
    if (!cid) continue;
    for (const ds of billingDatesOf(b)) orderSet.add(`${cid}_${ds}`);
  }

  const pipelineOrders = await db.select({
    customerId: billingPipelineTable.customerId,
    dateStr: sql<string>`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt}))::text`,
  }).from(billingPipelineTable).where(
    and(
      sql`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt})) >= ${startDate}`,
      sql`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt})) <= ${endDate}`,
    )
  );
  for (const p of pipelineOrders) {
    if (!p.customerId || !p.dateStr) continue;
    orderSet.add(`${p.customerId}_${p.dateStr}`);
  }

  // Pedidos de VENDA (operação = venda) — usados APENAS para o gatilho "pular ciclo" da repescagem.
  // Troca/Amostra/Devolução etc. NÃO disparam o pulo (mesma regra do "com pedido" da rota).
  const vendaOrderDatesByCustomer = new Map<string, Set<string>>();
  try {
    const vendaPipeline = await db.select({
      customerId: billingPipelineTable.customerId,
      dateStr: sql<string>`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt}))::text`,
    }).from(billingPipelineTable).where(
      and(
        sql`LOWER(COALESCE(NULLIF(${billingPipelineTable.operationType}::text, ''), 'venda')) = 'venda'`,
        sql`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt})) >= ${startDate}`,
        sql`DATE(COALESCE(${billingPipelineTable.scheduledBillingDate}::timestamp, ${billingPipelineTable.createdAt})) <= ${endDate}`,
      )
    );
    for (const p of vendaPipeline) {
      if (!p.customerId || !p.dateStr) continue;
      if (!vendaOrderDatesByCustomer.has(p.customerId)) vendaOrderDatesByCustomer.set(p.customerId, new Set());
      vendaOrderDatesByCustomer.get(p.customerId)!.add(p.dateStr);
    }
  } catch (e) { console.error('[computeRedCandidates] venda set:', (e as any)?.message); }

  // Datas de VENDAS reais por cliente (faturamentos value>0 + pipeline 'venda'), usadas nos CICLOS.
  const saleDatesByCustomer = new Map<string, Set<string>>();
  const addSale = (cid: string | undefined | null, ds: string | undefined | null) => {
    if (!cid || !ds) return;
    let set = saleDatesByCustomer.get(cid); if (!set) { set = new Set(); saleDatesByCustomer.set(cid, set); } set.add(ds);
  };
  for (const b of billingOrders) { const cid = omieCodeToCustomerId.get(b.omieCustomerCode || ''); for (const ds of billingDatesOf(b)) addSale(cid, ds); }
  for (const [cid, set] of vendaOrderDatesByCustomer) for (const ds of set) addSale(cid, ds);

  const todayStr = brTodayStr();
  const candidates: Array<{
    customerId: string;
    customerName: string;
    sellerId: string | null;
    sellerName?: string;
    periodicity: string;
    weekdays: string[];
    lastRedDate: string;
    daysSince: number;
  }> = [];

  // Index dates of visits / orders / logs / checkpoints PER customer so we can
  // detect atendimentos OU pedidos posteriores ao último vermelho.
  const orderDatesByCustomer = new Map<string, Set<string>>();
  for (const k of orderSet) {
    const [cid, ds] = k.split('_');
    if (!orderDatesByCustomer.has(cid)) orderDatesByCustomer.set(cid, new Set());
    orderDatesByCustomer.get(cid)!.add(ds);
  }
  const checkpointDatesByCustomer = new Map<string, Set<string>>();
  for (const k of checkpointSet) {
    const [cid, ds] = k.split('_');
    if (!checkpointDatesByCustomer.has(cid)) checkpointDatesByCustomer.set(cid, new Set());
    checkpointDatesByCustomer.get(cid)!.add(ds);
  }
  const virtualLogDatesByCustomer = new Map<string, Set<string>>();
  for (const k of virtualLogSet) {
    const [cid, ds] = k.split('_');
    if (!virtualLogDatesByCustomer.has(cid)) virtualLogDatesByCustomer.set(cid, new Set());
    virtualLogDatesByCustomer.get(cid)!.add(ds);
  }
  const completedVisitDatesByCustomer = new Map<string, Set<string>>();
  for (const v of visits) {
    if (!v.customerId || !v.scheduledDate) continue;
    if (v.visitStatus === 'completed' || v.checkInTime) {
      if (!completedVisitDatesByCustomer.has(v.customerId)) completedVisitDatesByCustomer.set(v.customerId, new Set());
      completedVisitDatesByCustomer.get(v.customerId)!.add(v.scheduledDate);
    }
  }

  for (const c of cs) {
    // Carteiras de canal/sistema (Honest 1/2/3, HOTSITE, INSTAGRAM) NAO entram em repescagem.
    if (REPESCAGEM_EXCLUDED_SELLER_IDS.has(c.sellerId || '')) continue;
    // Clientes vinculados a uma REDE de clientes NAO caem em repescagem.
    if (redeMemberIds.has(c.id)) continue;
    // FORNECEDORES (is_supplier) sao cadastro, nao cliente — NUNCA entram na Rota do Dia,
    // nem pela repescagem. (A rota regular ja os exclui via getCustomersForDate.)
    if ((c as any).isSupplier === true) continue;
    // Elegiveis: carteira de VENDEDOR EXTERNO ('vendedor') OU TELEMARKETING ('telemarketing').
    // (A pedido: as carteiras da Leticia/Robson tambem entram; seus clientes ficam com eles.)
    // Carteiras de canal/sistema e sem dono continuam de fora.
    { const _role = candSellerRoleById.get(c.sellerId || ''); if (_role !== 'vendedor' && _role !== 'telemarketing') continue; }
    // Clientes INATIVOS nao entram em repescagem (cobre dessincronizacao entre
    // customers.isActive e active_customers). E2-C: is_active e a unica regra de ativo.
    if ((c as any).isActive === false
      || String((c as any).situacao || '').toLowerCase() === 'inativo') continue;
    // 🔒 QUARENTENA (nov/2026, decisão do Flavio): cliente com início de fornecimento/atendimento
    // FUTURO (service_start_date > hoje — selo "Atend. a partir de DD/MM/AAAA") NÃO cai em
    // repescagem. Depois da data, só cai por visita perdida A PARTIR dela (as anteriores não contam).
    const inicioAtend = dataInicioAtendimento((c as any).serviceStartDate);
    if (inicioAtend && inicioAtend > todayStr) continue;
    const scheduled = Array.from(scheduledByCustomer.get(c.id) || []).filter(d => d < todayStr && (!inicioAtend || d >= inicioAtend)).sort();
    if (scheduled.length === 0) continue;
    const lastDate = scheduled[scheduled.length - 1];

    // GATILHO "PULAR CICLO" — DESLIGADO (23/out/2026, decisao do Flavio): venda fora do dia de rota
    // NAO pula mais a proxima visita; o cliente segue a periodicidade normalmente e a Rota do Dia
    // destaca a ultima compra no card. (Este gatilho apagava a visita seguinte da agenda — ex.: ZOI
    // vendeu na visita postergada pelo feriado e sumiu de 19/10 e 26/10.) O endpoint manual de
    // "pular ciclo" continua disponivel para uso consciente do admin.
    if (skipOut && AUTO_PULAR_CICLO) {
      const vendaDates = vendaOrderDatesByCustomer.get(c.id);
      if (vendaDates) {
        const scheduledSet = scheduledByCustomer.get(c.id) || new Set<string>();
        const foraRotaComVenda = Array.from(vendaDates).some(d => d > lastDate && !scheduledSet.has(d));
        if (foraRotaComVenda) skipOut.push({ customerId: c.id, anchor: lastDate });
      }
    }

    const dows = parseDowsCycle(c.weekdays);
    const saleDates = saleDatesByCustomer.get(c.id) || new Set<string>();

    // ===== REGRA UNICA (igual ao Resumo de Visitas): cai em repescagem SE E SOMENTE SE a ULTIMA
    // bolinha (ciclo mais recente, por periodicidade e dia de rota via isPlanned) estiver VERMELHA
    // — visita agendada mais recente SEM venda na janela do ciclo. Cai no dia seguinte a essa
    // visita. Assim que houver venda (ultima bolinha verde), sai. Sem regra por atendimento e sem
    // sair por tempo: enquanto a ultima bolinha estiver vermelha, permanece. =====
    const n = cyclesToShow(c.periodicity || 'semanal');
    const cycles = computeCycles(dows, c.periodicity || 'semanal', saleDates, todayStr, n, (c as any).semanaAtendimento);
    const ev = evaluateRepescagem(cycles, c.periodicity || 'semanal', todayStr);
    if (!ev.falls || !ev.lastRedAnchor) continue;
    if (inicioAtend && ev.lastRedAnchor < inicioAtend) continue; // visita perdida antes do início do atendimento

    // REFINO (proxima data de visita): para QUINZENAL e MENSAL, se ainda ha uma visita agendada
    // NESTA semana (de hoje ate domingo) o cliente esta na SEMANA DA PROXIMA VISITA -> NAO cai em
    // repescagem ainda (aguarda a visita para vender). So cai 1 dia DEPOIS da data prevista, se a
    // bolinha continuar vermelha (a partir dai o ciclo ancora nessa visita e a regra base assume).
    // SEMANAL nao tem essa carencia: cai 1 dia apos o dia de rota se a ultima bolinha estiver vermelha.
    {
      const isSemanal = String(c.periodicity || 'semanal').toLowerCase().indexOf('seman') >= 0;
      if (!isSemanal) {
        const mkU = (s: string) => new Date(s + 'T12:00:00Z');
        const isoU = (dt: Date) => dt.toISOString().slice(0, 10);
        const td = mkU(todayStr);
        const toSun = (7 - td.getUTCDay()) % 7; // dias ate o domingo desta semana
        const eow = new Date(td); eow.setUTCDate(td.getUTCDate() + toSun);
        let upcomingThisWeek = false;
        for (let d = new Date(td); d <= eow; d.setUTCDate(d.getUTCDate() + 1)) {
          if (isPlannedCycle(isoU(d), dows, c.periodicity || 'semanal', (c as any).semanaAtendimento)) { upcomingThisWeek = true; break; }
        }
        if (upcomingThisWeek) continue; // dentro da semana da proxima visita -> nao cai ainda
      }
    }

    // PEDIDO FEITO -> SAI + NOVO CICLO: se houve VENDA (pedido) na data da visita que gerou o
    // vermelho OU depois, o cliente ja foi resolvido -> sai da repescagem e so retorna se a PROXIMA
    // visita ficar vermelha (novo ciclo). Complementa a "bolinha verde" cobrindo brechas da janela
    // do ciclo (ex.: venda em fim de semana ou apos o fim da janela).
    {
      const sset = saleDatesByCustomer.get(c.id);
      let pedidoNoCicloAtual = false;
      if (sset) { for (const d of sset) { if (d >= ev.lastRedAnchor) { pedidoNoCicloAtual = true; break; } } }
      if (pedidoNoCicloAtual) continue;
    }

    // ATENDIMENTO FEITO -> SAI + NOVO CICLO: alem do pedido, QUALQUER registro de atendimento
    // (check-in na rota, atendimento virtual/resgate ou visita concluida) na data do ultimo
    // vermelho OU depois tambem resolve o cliente -> sai da repescagem. So retorna se a PROXIMA
    // visita ficar vermelha (novo ciclo). Isso alinha o gatilho a "ultima bolinha vermelha": a
    // bolinha amarela (atendido, sem pedido) deixa de manter o cliente na lista.
    {
      let atendidoNoCicloAtual = false;
      for (const map of [checkpointDatesByCustomer, virtualLogDatesByCustomer, completedVisitDatesByCustomer]) {
        const set = map.get(c.id);
        if (!set) continue;
        for (const d of set) { if (d >= ev.lastRedAnchor) { atendidoNoCicloAtual = true; break; } }
        if (atendidoNoCicloAtual) break;
      }
      if (atendidoNoCicloAtual) continue;
    }

    // EMENDA (proximidade da proxima visita): o cliente NAO permanece em repescagem coladinho na
    // proxima visita agendada. Se a PROXIMA visita da rota e HOJE (tem visita na rota do dia) ou
    // AMANHA (um dia antes), o cliente SAI da lista e aguarda o novo ciclo — se essa visita ficar
    // sem atendimento/venda, ele volta a cair 1 dia depois (novo ciclo). Vale para todas as
    // periodicidades. (Ate aqui o cliente ja esta "vermelho": sem pedido e sem atendimento no ciclo.)
    {
      const mkU = (s: string) => new Date(s + 'T12:00:00Z');
      const isoU = (dt: Date) => dt.toISOString().slice(0, 10);
      let nextPlanned: string | null = null;
      const d = mkU(todayStr);
      for (let i = 0; i < 40; i++) {
        const ds = isoU(d);
        if (isPlannedCycle(ds, dows, c.periodicity || 'semanal', (c as any).semanaAtendimento)) { nextPlanned = ds; break; }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      if (nextPlanned) {
        const diff = Math.floor((mkU(nextPlanned).getTime() - mkU(todayStr).getTime()) / 864e5);
        if (diff <= 1) continue; // visita hoje ou amanha -> sai da repescagem, aguarda novo ciclo
      }
    }

    const lastRedDate = ev.lastRedAnchor;
    const days = Math.floor((new Date(todayStr).getTime() - new Date(lastRedDate).getTime()) / 86400000);
    candidates.push({
      customerId: c.id,
      customerName: c.name || 'Sem nome',
      sellerId: c.sellerId || null,
      periodicity: c.periodicity || 'semanal',
      weekdays: (c.weekdays as unknown as string[]) || [],
      lastRedDate,
      daysSince: days,
    });
  }

  return candidates;
}

// Distribui clientes entre atendentes habilitados de forma equilibrada.
// - Mantém atribuições existentes válidas (atendente ainda habilitado)
// - Reatribui quando atendente foi desabilitado
// - Cria novas atribuições para candidatos sem atribuição ativa
// - Marca como completed se houve service log após assignedAt para esse customer
async function reconcileAssignments(actorUserId?: string): Promise<void> {
  await ensureFormerExcludedOff();
  try { await __reconcileAssignmentsRaw(actorUserId); } catch (e) { console.error('[reconcileAssignments] skip:', (e as any)?.message); }
}

async function __reconcileAssignmentsRaw(actorUserId?: string): Promise<void> {
  // Janela ampla para localizar candidatos
  const today = brTodayStr();
  const startDate = (() => {
    const d = new Date(today); d.setDate(d.getDate() - 90); return d.toISOString().split('T')[0];
  })();
  const endDate = (() => {
    const d = new Date(today); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0];
  })();

  // Travas manuais: valem só para o dia vigente. Zera as de dias anteriores.
  await resetStaleLocks(today);
  // Uma linha travada HOJE não sofre redistribuição automática (reatribuição/rebalanceamento).
  const isLockedToday = (a: any) => !!a?.locked && a?.lockedDate === today;

  const skipCands: SkipCiclo[] = [];
  const candidates = await computeRedCandidates({ startDate, endDate }, skipCands);
  const candidateByCustomerId = new Map(candidates.map(c => [c.customerId, c]));

  // PULAR CICLO: clientes atendidos com PEDIDO (venda) FORA do dia de rota -> reescreve agenda
  // pendente pulando 1 ciclo. Idempotente (so reescreve se ainda nao foi pulado).
  if (skipCands.length > 0) {
    try {
      const { recalcularAgendaPulandoCiclo } = await import('./visitScheduleService');
      const seen = new Set<string>();
      for (const s of skipCands) {
        if (seen.has(s.customerId)) continue;
        seen.add(s.customerId);
        try { await recalcularAgendaPulandoCiclo(s.customerId, new Date(`${s.anchor}T00:00:00`)); }
        catch (e) { console.error('[PULAR-CICLO][reconcile] cliente', s.customerId, (e as any)?.message); }
      }
    } catch (e) { console.error('[PULAR-CICLO][reconcile] import:', (e as any)?.message); }
  }

  // ── Atendentes habilitados, separados por funcao (Repescagem2 — distribuicao por PERIMETRO) ──
  // Vendedores externos (role 'vendedor') recebem por PERIMETRO: cliente de carteira externa,
  // com coordenada, a ate REPESCAGEM_PERIMETER_KM de alguma parada da rota do dia do vendedor,
  // com teto EXTERNAL_MAX_PER_SELLER/dia e PRIORIDADE para o proprio vendedor do cliente.
  // O restante (sem coordenada, fora de perimetro, ou carteira nao-externa) vai para o
  // telemarketing habilitado por MENOR CARGA. Admins/excluidos gerenciam mas nao recebem.
  const enabledRaw = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.isEnabled, true));
  const enabledRawIds = enabledRaw.map(a => a.userId);
  const enabledUsers = enabledRawIds.length > 0
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, enabledRawIds))
    : [];
  const roleById = new Map(enabledUsers.map(u => [u.id, u.role]));
  const allEnabledIds = enabledRawIds.filter(id => !REPESCAGEM_SYSTEM_USER_IDS.has(id));
  const externalIds = allEnabledIds.filter(id => roleById.get(id) === 'vendedor');
  const internalIds = allEnabledIds.filter(id => roleById.get(id) !== 'vendedor');
  const externalSet = new Set(externalIds);
  const internalSet = new Set(internalIds);
  const enabledSet = new Set(allEnabledIds);

  // Carteira (dono) + coordenadas de cada candidato; e funcao do dono (p/ saber
  // quais clientes sao "de vendedor externo").
  const candIds = candidates.map(c => c.customerId);
  const custInfo = candIds.length > 0
    ? await db.select({ id: customers.id, lat: customers.latitude, lng: customers.longitude, sellerId: customers.sellerId })
        .from(customers).where(inArray(customers.id, candIds))
    : [];
  const coordById = new Map(custInfo.map(c => [c.id, {
    lat: c.lat != null ? Number(c.lat) : null,
    lng: c.lng != null ? Number(c.lng) : null,
    sellerId: (c.sellerId as string | null) || null,
  }]));
  // Roteamento especial por carteira (config do painel). Split igualitario para carteiras com 2+ receptores.
  const crossReceivers = await loadSpecialCrossReceivers();
  const splitLR = repescagemSplitLR(candidates as any, (id) => coordById.get(id)?.sellerId || null, crossReceivers);
  const specialTargetFor = (customerId: string) => repescagemSpecialTarget(
    coordById.get(customerId)?.sellerId || null,
    crossReceivers, splitLR.get(customerId));
  const ownerSellerIds = Array.from(new Set(custInfo.map(c => c.sellerId).filter(Boolean) as string[]));
  const ownerRoleRows = ownerSellerIds.length > 0
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ownerSellerIds))
    : [];
  const ownerRoleById = new Map(ownerRoleRows.map(u => [u.id, u.role]));
  const isExternalPortfolio = (custId: string): boolean => {
    const sid = coordById.get(custId)?.sellerId;
    return !!sid && ownerRoleById.get(sid) === 'vendedor';
  };
  // 🧭 Dono TELEMARKETING do cliente (id do vendedor), ou null se o dono não é telemarketing.
  // Regra de carteira: um cliente de telemarketing NUNCA pode cair na repescagem de OUTRO
  // telemarketing — só do próprio dono (se habilitado). (30/jul/2026)
  const ownerTelemarketingId = (custId: string): string | null => {
    const sid = coordById.get(custId)?.sellerId || null;
    return (sid && ownerRoleById.get(sid) === 'telemarketing') ? sid : null;
  };

  // Ancoras (paradas com coordenada) da rota do dia de cada vendedor externo habilitado.
  const anchorsBySeller = new Map<string, Array<{ lat: number; lng: number }>>();
  for (const extId of externalIds) {
    try { anchorsBySeller.set(extId, await repGetRouteAnchors(extId, today)); }
    catch { anchorsBySeller.set(extId, []); }
  }
  const withinPerimeter = (custId: string, extId: string): boolean => {
    const info = coordById.get(custId);
    if (!info || info.lat == null || info.lng == null) return false;
    const anchors = anchorsBySeller.get(extId) || [];
    return anchors.some(a => repHaversineKm(info.lat as number, info.lng as number, a.lat, a.lng) <= REPESCAGEM_PERIMETER_KM);
  };

  // Atribuicoes pendentes existentes
  const pending = await db.select().from(repescagemAssignments)
    .where(eq(repescagemAssignments.status, 'pending'));

  // 1) Marcar como completed quando houve service log apos assignedAt
  // Batch: buscar TODOS os logs relevantes de uma vez para os pending atuais
  if (pending.length > 0) {
    const customerIds = Array.from(new Set(pending.map(p => p.customerId)));
    const minAssignedAt = pending.reduce<Date>((min, p) => {
      const d = new Date(p.assignedAt);
      return d < min ? d : min;
    }, new Date(pending[0].assignedAt));
    const allLogs = await db.select().from(virtualServiceLogs)
      .where(
        and(
          inArray(virtualServiceLogs.customerId, customerIds),
          sql`${virtualServiceLogs.attendanceDate} >= ${minAssignedAt}`,
          sql`NOT (${virtualServiceLogs.attendantId} = 'ia' AND COALESCE(${virtualServiceLogs.serviceType}, '') = 'repescagem_ia')`,
        )
      );
    const logsByCustomer = new Map<string, typeof allLogs>();
    for (const l of allLogs) {
      if (!logsByCustomer.has(l.customerId)) logsByCustomer.set(l.customerId, []);
      logsByCustomer.get(l.customerId)!.push(l);
    }
    for (const a of pending) {
      if (isLockedToday(a)) continue;               // trava manual do dia: não auto-conclui
      const cLogs = logsByCustomer.get(a.customerId) || [];
      const matching = cLogs
        .filter(l => new Date(l.attendanceDate) >= new Date(a.assignedAt))
        .sort((x, y) => new Date(y.attendanceDate).getTime() - new Date(x.attendanceDate).getTime());
      if (matching.length > 0) {
        const log = matching[0];
        await db.update(repescagemAssignments).set({
          status: 'completed',
          completedAt: new Date(),
          completedByUserId: log.attendantId,
          completedServiceLogId: log.id,
          updatedAt: new Date(),
        }).where(eq(repescagemAssignments.id, a.id));
        await db.insert(repescagemAssignmentHistory).values({
          assignmentId: a.id,
          customerId: a.customerId,
          fromUserId: a.assignedUserId,
          toUserId: log.attendantId,
          action: 'completed',
          reason: 'Atendimento registrado',
        });
      }
    }
  }

  // Recarregar pendentes
  const pendingNow = await db.select().from(repescagemAssignments)
    .where(eq(repescagemAssignments.status, 'pending'));

  // 2) Cancelar atribuicoes para clientes que NAO sao mais candidatos
  // (ex: cliente foi atendido por outra via, mudanca de status)
  for (const a of pendingNow) {
    if (isLockedToday(a)) continue;                 // trava manual do dia: não cancela
    if (!candidateByCustomerId.has(a.customerId)) {
      await db.update(repescagemAssignments).set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id,
        customerId: a.customerId,
        fromUserId: a.assignedUserId,
        toUserId: null,
        action: 'cancelled',
        reason: 'Cliente saiu da lista de repescagem',
      });
    }
  }

  // 2.6) 🧭 CARTEIRA (telemarketing): cliente de UM telemarketing atribuído a OUTRO telemarketing
  // volta para o DONO (se habilitado na repescagem) ou é CANCELADO (se o dono não está habilitado).
  // Corrige as atribuições cruzadas existentes — nenhum cliente fica na repescagem de outra
  // carteira de telemarketing. (30/jul/2026)
  for (const a of pendingNow) {
    if (!candidateByCustomerId.has(a.customerId)) continue;
    if (isLockedToday(a)) continue;               // trava manual do dia: não reatribui
    const ownerTmId = ownerTelemarketingId(a.customerId);
    if (!ownerTmId) continue;                     // dono não é telemarketing → regra não se aplica
    if (a.assignedUserId === ownerTmId) continue; // já está com o dono
    if (externalSet.has(a.assignedUserId)) continue; // atribuído a externo (perímetro) → não mexe
    if (internalSet.has(ownerTmId)) {
      await db.update(repescagemAssignments).set({
        assignedUserId: ownerTmId, phase: 'telemarketing',
        carteiraSellerId: ownerTmId, assignedAt: new Date(), updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id, customerId: a.customerId,
        fromUserId: a.assignedUserId, toUserId: ownerTmId,
        action: 'reassigned', reason: 'Carteira: cliente volta ao telemarketing dono',
      });
    } else {
      await db.update(repescagemAssignments).set({
        status: 'cancelled', completedAt: new Date(), updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id, customerId: a.customerId,
        fromUserId: a.assignedUserId, toUserId: null,
        action: 'cancelled', reason: 'Carteira: dono telemarketing nao habilitado na repescagem',
      });
    }
  }

  // 3) Carga atual por atendente habilitado (externos e internos), a partir dos pendentes validos
  const stillPending = await db.select().from(repescagemAssignments)
    .where(eq(repescagemAssignments.status, 'pending'));
  const externalLoad = new Map<string, number>();
  for (const id of externalIds) externalLoad.set(id, 0);
  const internalLoad = new Map<string, number>();
  for (const id of internalIds) internalLoad.set(id, 0);
  const validPendingByCustomer = new Map<string, typeof stillPending[number]>();
  for (const a of stillPending) {
    if (!candidateByCustomerId.has(a.customerId)) continue;
    if (externalSet.has(a.assignedUserId)) {
      externalLoad.set(a.assignedUserId, (externalLoad.get(a.assignedUserId) || 0) + 1);
      validPendingByCustomer.set(a.customerId, a);
    } else if (internalSet.has(a.assignedUserId)) {
      internalLoad.set(a.assignedUserId, (internalLoad.get(a.assignedUserId) || 0) + 1);
      validPendingByCustomer.set(a.customerId, a);
    }
  }

  function pickLeastLoadedInternal(): string | null {
    if (internalIds.length === 0) return null;
    let best: string | null = null; let bestLoad = Infinity;
    for (const id of internalIds) { const l = internalLoad.get(id) || 0; if (l < bestLoad) { bestLoad = l; best = id; } }
    return best;
  }

  // Escolhe o alvo de um candidato: Fase A (externo por perimetro, dono primeiro,
  // teto EXTERNAL_MAX_PER_SELLER) -> Fase B (telemarketing por menor carga).
  function chooseTarget(customerId: string): { userId: string; phase: 'external' | 'telemarketing' } | null {
    // Roteamento especial (carteira -> atendente configurado no painel) tem prioridade, se o alvo
    // estiver habilitado. O alvo pode ser TELEMARKETING ou VENDEDOR EXTERNO (cross-carteira).
    const spTarget = specialTargetFor(customerId);
    if (spTarget && enabledSet.has(spTarget)) return { userId: spTarget, phase: externalSet.has(spTarget) ? 'external' : 'telemarketing' };
    if (isExternalPortfolio(customerId)) {
      const ownerId = coordById.get(customerId)?.sellerId || null;
      const qualifying = externalIds.filter(extId =>
        (externalLoad.get(extId) || 0) < EXTERNAL_MAX_PER_SELLER && withinPerimeter(customerId, extId));
      if (qualifying.length > 0) {
        let pick: string;
        if (ownerId && qualifying.includes(ownerId)) {
          pick = ownerId; // prioridade: o proprio vendedor do cliente
        } else {
          pick = qualifying.reduce((best, id) =>
            (externalLoad.get(id) || 0) < (externalLoad.get(best) || 0) ? id : best, qualifying[0]);
        }
        return { userId: pick, phase: 'external' };
      }
    }
    // Fase B (telemarketing): NÃO cruzar carteira. Cliente de um TELEMARKETING só pode ir para o
    // PRÓPRIO dono (se habilitado na repescagem); nunca para outro telemarketing. Se o dono é
    // telemarketing mas NÃO está habilitado, o cliente fica SEM repescagem (não vai para ninguém).
    const ownerTmId = ownerTelemarketingId(customerId);
    if (ownerTmId) {
      return internalSet.has(ownerTmId) ? { userId: ownerTmId, phase: 'telemarketing' } : null;
    }
    const t = pickLeastLoadedInternal();
    if (t) return { userId: t, phase: 'telemarketing' };
    return null;
  }

  function applyLoad(userId: string, phase: 'external' | 'telemarketing') {
    if (phase === 'external') externalLoad.set(userId, (externalLoad.get(userId) || 0) + 1);
    else internalLoad.set(userId, (internalLoad.get(userId) || 0) + 1);
  }

  // 3.4) ROTEAMENTO ESPECIAL: carteiras Gilmar/Jhonatan/Carlos dentro de 3 dias vão para
  // Letícia/Robson e ficam TRAVADAS no dia (não sofrem promoção/rebalanceamento). Respeita
  // uma troca manual do admin (linha travada no dia). Reaplicado a cada rodada.
  const pinnedSpecial = new Set<string>();
  for (const cand of candidates) {
    const target = specialTargetFor(cand.customerId);
    if (target && enabledSet.has(target)) pinnedSpecial.add(cand.customerId);
  }
  for (const a of stillPending) {
    if (!candidateByCustomerId.has(a.customerId) || !pinnedSpecial.has(a.customerId)) continue;
    // Roteamento especial é AUTORITATIVO: mesmo travado em outro atendente, corrige para o alvo.
    const target = specialTargetFor(a.customerId)!;
    if (a.assignedUserId !== target) {
      const oldUser = a.assignedUserId;
      const targetIsExternal = externalSet.has(target);
      await db.update(repescagemAssignments).set({
        assignedUserId: target, phase: targetIsExternal ? 'external' : 'telemarketing', locked: false, lockedDate: null, assignedAt: new Date(), updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id, customerId: a.customerId, fromUserId: oldUser, toUserId: target,
        action: 'reassigned', reason: 'Roteamento especial da carteira (ate 3 dias)',
      });
      if (externalSet.has(oldUser)) externalLoad.set(oldUser, Math.max(0, (externalLoad.get(oldUser) || 0) - 1));
      else if (internalSet.has(oldUser)) internalLoad.set(oldUser, Math.max(0, (internalLoad.get(oldUser) || 0) - 1));
      if (targetIsExternal) externalLoad.set(target, (externalLoad.get(target) || 0) + 1);
      else internalLoad.set(target, (internalLoad.get(target) || 0) + 1);
      validPendingByCustomer.set(a.customerId, { ...a, assignedUserId: target } as any);
    }
    // (removida a trava automatica das carteiras especiais — as linhas ficam livres;
    //  o roteamento especial continua autoritativo e é reaplicado a cada reconcile.)
  }

  // 3.5) Promover para o vendedor externo: clientes de carteira externa que hoje
  // estao no telemarketing mas passaram a qualificar no perimetro (<=2km) da rota
  // do dia de um vendedor externo habilitado (dono primeiro, respeitando o teto).
  // Faz a nova regra valer de imediato na lista existente. So promove (nunca rebaixa
  // por mudanca de rota) para evitar churn diario.
  for (const a of stillPending) {
    if (!candidateByCustomerId.has(a.customerId)) continue;
    if (isLockedToday(a)) continue;                   // trava manual do dia: não promove
    if (pinnedSpecial.has(a.customerId)) continue;    // roteamento especial: fica no telemarketing alvo
    if (!internalSet.has(a.assignedUserId)) continue; // so mexe em quem esta no telemarketing
    if (!isExternalPortfolio(a.customerId)) continue;
    const ownerId = coordById.get(a.customerId)?.sellerId || null;
    const qualifying = externalIds.filter(extId =>
      (externalLoad.get(extId) || 0) < EXTERNAL_MAX_PER_SELLER && withinPerimeter(a.customerId, extId));
    if (qualifying.length === 0) continue;
    const pick = (ownerId && qualifying.includes(ownerId))
      ? ownerId
      : qualifying.reduce((b, id) => (externalLoad.get(id) || 0) < (externalLoad.get(b) || 0) ? id : b, qualifying[0]);
    const oldUser = a.assignedUserId;
    await db.update(repescagemAssignments).set({
      assignedUserId: pick,
      phase: 'external',
      carteiraSellerId: ownerId,
      assignedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(repescagemAssignments.id, a.id));
    await db.insert(repescagemAssignmentHistory).values({
      assignmentId: a.id,
      customerId: a.customerId,
      fromUserId: oldUser,
      toUserId: pick,
      action: 'reassigned',
      reason: 'Realocado ao vendedor externo por perimetro',
    });
    internalLoad.set(oldUser, Math.max(0, (internalLoad.get(oldUser) || 0) - 1));
    externalLoad.set(pick, (externalLoad.get(pick) || 0) + 1);
    validPendingByCustomer.set(a.customerId, { ...a, assignedUserId: pick });
  }

  // 4) Reatribuir os pendentes cujo atendente foi desabilitado
  for (const a of stillPending) {
    if (!candidateByCustomerId.has(a.customerId)) continue;
    if (isLockedToday(a)) continue;                 // trava manual do dia: mantém o atendente escolhido
    if (enabledSet.has(a.assignedUserId)) continue; // atribuicao ainda valida
    const target = chooseTarget(a.customerId);
    if (!target) {
      await db.update(repescagemAssignments).set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id,
        customerId: a.customerId,
        fromUserId: a.assignedUserId,
        toUserId: null,
        action: 'cancelled',
        reason: 'Atendente desabilitado e nenhum outro disponivel',
      });
      continue;
    }
    const oldUser = a.assignedUserId;
    await db.update(repescagemAssignments).set({
      assignedUserId: target.userId,
      phase: target.phase,
      carteiraSellerId: coordById.get(a.customerId)?.sellerId || null,
      assignedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(repescagemAssignments.id, a.id));
    await db.insert(repescagemAssignmentHistory).values({
      assignmentId: a.id,
      customerId: a.customerId,
      fromUserId: oldUser,
      toUserId: target.userId,
      action: 'reassigned',
      reason: 'Atendente anterior desabilitado',
    });
    applyLoad(target.userId, target.phase);
    validPendingByCustomer.set(a.customerId, { ...a, assignedUserId: target.userId });
  }

  // 4.5) Rebalancear SO o telemarketing (as alocacoes externas ficam presas a rota
  // do dia). Move do mais carregado para o menos carregado ate a diferenca ser <= 1.
  if (internalIds.length > 1) {
    const getMax = () => {
      let id: string | null = null; let v = -Infinity;
      for (const u of internalIds) { const l = internalLoad.get(u) || 0; if (l > v) { v = l; id = u; } }
      return { id, v };
    };
    const getMin = () => {
      let id: string | null = null; let v = Infinity;
      for (const u of internalIds) { const l = internalLoad.get(u) || 0; if (l < v) { v = l; id = u; } }
      return { id, v };
    };
    let safety = 10000;
    while (safety-- > 0) {
      const max = getMax(); const min = getMin();
      if (!max.id || !min.id || max.v - min.v <= 1) break;
      // Só move clientes SEM dono de telemarketing (externos/sem dono). Cliente de carteira de
      // telemarketing fica preso ao próprio dono — o rebalanceamento nunca cruza carteira.
      const toMove = Array.from(validPendingByCustomer.values()).find(a => a.assignedUserId === max.id && !ownerTelemarketingId(a.customerId) && !isLockedToday(a) && !pinnedSpecial.has(a.customerId));
      if (!toMove) break;
      await db.update(repescagemAssignments).set({
        assignedUserId: min.id,
        phase: 'telemarketing',
        assignedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, toMove.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: toMove.id,
        customerId: toMove.customerId,
        fromUserId: max.id,
        toUserId: min.id,
        action: 'reassigned',
        reason: 'Rebalanceamento telemarketing',
      });
      internalLoad.set(max.id, max.v - 1);
      internalLoad.set(min.id, min.v + 1);
      validPendingByCustomer.set(toMove.customerId, { ...toMove, assignedUserId: min.id });
    }
  }

  // 5) Atribuir candidatos novos (sem pendente valido) via perimetro -> telemarketing
  if (allEnabledIds.length > 0) {
    const candidateIds = candidates
      .filter(c => !validPendingByCustomer.has(c.customerId))
      .map(c => c.customerId);
    const priorMap = new Map<string, string[]>();
    if (candidateIds.length > 0) {
      const allPrior = await db.select({
        customerId: repescagemAssignments.customerId,
        lastRedDate: repescagemAssignments.lastRedDate,
        status: repescagemAssignments.status,
      }).from(repescagemAssignments).where(
        inArray(repescagemAssignments.customerId, candidateIds)
      );
      for (const p of allPrior) {
        const k = `${p.customerId}_${p.lastRedDate}`;
        if (!priorMap.has(k)) priorMap.set(k, []);
        priorMap.get(k)!.push(p.status);
      }
    }
    for (const cand of candidates) {
      if (validPendingByCustomer.has(cand.customerId)) {
        const a = validPendingByCustomer.get(cand.customerId)!;
        if (a.lastRedDate !== cand.lastRedDate) {
          await db.update(repescagemAssignments).set({
            lastRedDate: cand.lastRedDate,
            updatedAt: new Date(),
          }).where(eq(repescagemAssignments.id, a.id));
        }
        continue;
      }
      const priorStatuses = priorMap.get(`${cand.customerId}_${cand.lastRedDate}`) || [];
      // Cliente atendido (completed) sem venda continua vermelho: para o roteamento especial
      // ele DEVE ser re-atribuído ao alvo (só sai da repescagem com venda). Demais: pula.
      if (priorStatuses.includes('completed') && !pinnedSpecial.has(cand.customerId)) continue;
      const target = chooseTarget(cand.customerId);
      if (!target) continue; // ninguem habilitado apto — fica sem atribuicao (fallback de orfaos)
      const isSpecial = pinnedSpecial.has(cand.customerId);
      const inserted = await db.insert(repescagemAssignments).values({
        customerId: cand.customerId,
        lastRedDate: cand.lastRedDate,
        assignedUserId: target.userId,
        status: 'pending',
        phase: target.phase,
        carteiraSellerId: coordById.get(cand.customerId)?.sellerId || null,
        locked: false, lockedDate: null,
      }).returning();
      const newAssign = inserted[0];
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: newAssign.id,
        customerId: cand.customerId,
        fromUserId: null,
        toUserId: target.userId,
        action: 'assigned',
        reason: isSpecial ? 'Roteamento especial da carteira (ate 3 dias)' : (target.phase === 'external' ? 'Distribuicao por perimetro (vendedor externo)' : 'Distribuicao telemarketing'),
      });
      applyLoad(target.userId, target.phase);
    }
  }
}

// ============================================================================
// Repescagem2 — Fase 2: sorteio diário e alocação
// Fase A (externos): até 3 clientes por vendedor, dentro de 3 km de qualquer
//   parada da rota do dia, com coordenada. Prioriza OUTRA carteira; usa a própria
//   como preenchimento quando não houver de outras.
// Fase B (telemarketing): o restante (inclui sem-coordenada) via aleatório
//   ponderado (inverso à carga). Persistência em repescagem_assignments com
//   draw_date + phase + status 'in_route'. Idempotente por dia.
// Observação: esta fase NÃO injeta na rota nem trava paradas (isso é a Fase 3);
// é validável por API/log. Não interfere na lista antiga (status 'pending').
// ============================================================================
const REPESCAGEM_PERIMETER_KM = 2;
// SEM teto por vendedor externo (a pedido): cada vendedor recebe TODOS os seus clientes em
// repescagem dentro do perimetro da rota do dia. (Antes era 3/dia.) Infinity remove o limite
// em todas as comparacoes `< EXTERNAL_MAX_PER_SELLER`.
const EXTERNAL_MAX_PER_SELLER = Number.POSITIVE_INFINITY;
let __drawRunning = false;
let __lastDrawCheckMs = 0;
// Reconcile em SEGUNDO PLANO (throttled) — a tela de Repescagem/Rota nao espera o recalculo
// de 400+ candidatos a cada carregamento; retorna o estado atual do banco e o reconcile roda
// em background (o proximo load ja reflete). Mantem a tela rapida.
let __reconcileRunning = false;
let __lastReconcileMs = 0;

function repHaversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Chave pseudo-aleatória estável por (id, dia): mantém o "sorteio" reproduzível
// dentro do mesmo dia (idempotência) sem depender de Math.random.
function repShuffleKey(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Coordenadas das paradas (customers + leads) da rota do vendedor no dia.
async function repGetRouteAnchors(sellerId: string, dayStr: string): Promise<Array<{ lat: number; lng: number }>> {
  const r = await db.execute(sql`
    SELECT optimized_order, visit_stops FROM daily_routes
    WHERE seller_id = ${sellerId} AND DATE(route_date) = ${dayStr}::date
    ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
  const rows = r.rows as any[];
  if (rows.length === 0) return [];
  const vs = rows[0].visit_stops || {};
  const oo: string[] = Array.isArray(rows[0].optimized_order) ? rows[0].optimized_order : [];
  const custIds = new Set<string>(); const leadIds = new Set<string>();
  // 1) visit_stops (formato documentado: stopId -> {entityType, entityId})
  for (const k of Object.keys(vs)) {
    const s = vs[k]; if (!s || !s.entityId) continue;
    if (s.entityType === 'lead') leadIds.add(s.entityId);
    else custIds.add(s.entityId);
  }
  // 2) optimized_order (fallback quando visit_stops está vazio): as paradas
  //    reais das rotas ficam aqui, como IDs diretos (às vezes com prefixo
  //    "customer:"/"lead:"). Sem isso, a Fase A ficava sem âncoras e os
  //    vendedores externos nunca recebiam clientes por perímetro.
  for (const raw of oo) {
    if (typeof raw !== 'string' || !raw) continue;
    if (raw.startsWith('lead:')) { leadIds.add(raw.slice(5)); continue; }
    if (raw.startsWith('customer:')) { custIds.add(raw.slice(9)); continue; }
    custIds.add(raw); leadIds.add(raw); // sem prefixo: tenta como cliente e como lead
  }
  const out: Array<{ lat: number; lng: number }> = [];
  if (custIds.size) {
    const cr = await db.select({ lat: customers.latitude, lng: customers.longitude })
      .from(customers).where(inArray(customers.id, Array.from(custIds)));
    for (const c of cr) if (c.lat != null && c.lng != null) out.push({ lat: Number(c.lat), lng: Number(c.lng) });
  }
  if (leadIds.size) {
    const lr = await db.select({ lat: leads.latitude, lng: leads.longitude })
      .from(leads).where(inArray(leads.id, Array.from(leadIds)));
    for (const l of lr) if (l.lat != null && l.lng != null) out.push({ lat: Number(l.lat), lng: Number(l.lng) });
  }
  return out;
}

// Geocodifica em SEGUNDO PLANO candidatos da repescagem sem coordenada (mas com endereço),
// para que os vendedores externos voltem a recebê-los por perímetro nos próximos sorteios.
// Throttled (1x/30min), limitado por rodada, usa CEP + limpeza + fallback + verificação de CEP.
let __lastGeoRepMs = 0;
let __geoRepRunning = false;
async function geocodeMissingCandidates(customerIds: string[]): Promise<void> {
  const nowMs = Date.now();
  if (__geoRepRunning || (nowMs - __lastGeoRepMs) < 1800000) return;
  if (!customerIds.length) return;
  __lastGeoRepMs = nowMs; __geoRepRunning = true;
  try {
    const rows = await db.select({
      id: customers.id, address: customers.address, neighborhood: customers.neighborhood,
      city: customers.city, state: customers.state, zipCode: customers.zipCode,
    }).from(customers).where(and(
      inArray(customers.id, customerIds.slice(0, 500)),
      sql`(${customers.latitude} IS NULL OR ${customers.longitude} IS NULL)`,
      sql`(${customers.coordinatesLocked} IS NOT TRUE)`,
      sql`COALESCE(TRIM(${customers.address}), '') <> ''`,
    ));
    const norm = (s: any) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const clean = (s: any) => String(s || '')
      .replace(/;/g, ', ').replace(/n[º°]/gi, ' ').replace(/\bs\s*\/\s*n\b/gi, ' ').replace(/\bsn\b/gi, ' ')
      .replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').replace(/(\s*,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
    let done = 0;
    for (const c of rows.slice(0, 40)) {
      try {
        const cep = String(c.zipCode || '').replace(/\D/g, '');
        const cepFmt = cep.length === 8 ? (cep.slice(0, 5) + '-' + cep.slice(5)) : '';
        const addrC = clean(c.address); const cityC = clean(c.city);
        const attempts: { parts: any[]; level: string }[] = [];
        if (addrC) attempts.push({ parts: [addrC, c.neighborhood, cityC, c.state, cepFmt, 'Brasil'], level: 'endereco' });
        if (cepFmt) attempts.push({ parts: [cepFmt, cityC, 'Brasil'], level: 'cep' });
        if (c.neighborhood) attempts.push({ parts: [c.neighborhood, cityC, c.state, 'Brasil'], level: 'bairro' });
        let hit: any = null;
        for (let ai = 0; ai < attempts.length; ai++) {
          const q = attempts[ai].parts.filter(Boolean).join(', ');
          if (!q) continue;
          const cand = await geocodeOne(q);
          if (cand) {
            if (attempts[ai].level === 'endereco' && cep.length === 8) {
              const dc = cand.postcode || '';
              if (dc && dc.slice(0, 5) !== cep.slice(0, 5)) { if (ai < attempts.length - 1) await new Promise(rs => setTimeout(rs, geocodeThrottleMs())); continue; }
            }
            hit = cand; break;
          }
          if (ai < attempts.length - 1) await new Promise(rs => setTimeout(rs, geocodeThrottleMs()));
        }
        if (hit) {
          const cityToken = norm(c.city).split(' ')[0] || '';
          const cityOk = !!cityToken && norm(hit.display_name).includes(cityToken);
          if (cityOk) { await db.execute(sql`UPDATE customers SET latitude = ${String(hit.lat)}, longitude = ${String(hit.lon)}, updated_at = now() WHERE id = ${c.id}`); done++; }
        }
      } catch { /* ignora cliente individual */ }
      await new Promise(rs => setTimeout(rs, geocodeThrottleMs()));
    }
    if (done) console.log(`[REPESCAGEM2-GEO] geocodificados ${done} candidato(s) sem coordenada`);
  } catch (e: any) { console.warn('[REPESCAGEM2-GEO] falha:', e?.message); }
  finally { __geoRepRunning = false; }
}

// REPESCAGEM SÓ DE SEGUNDA A SEXTA (nov/2026, decisão do Flavio): não há sorteio no sábado nem
// no domingo. O cliente não atendido na sexta cai na SEGUNDA (o motor reavalia na segunda e a
// visita perdida de sexta continua vermelha). Envios manuais ("Repescagem" do report e "Voltar
// para a repescagem" do report das 18h) vão para o PRÓXIMO DIA ÚTIL.
function isDiaUtilRep(d: string): boolean { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w >= 1 && w <= 5; }
function proximoDiaUtilRep(d: string): string {
  const x = new Date(d + 'T12:00:00Z');
  do { x.setUTCDate(x.getUTCDate() + 1); } while (x.getUTCDay() === 0 || x.getUTCDay() === 6);
  return x.toISOString().slice(0, 10);
}
function diaUtilAnteriorRep(d: string): string {
  const x = new Date(d + 'T12:00:00Z');
  do { x.setUTCDate(x.getUTCDate() - 1); } while (x.getUTCDay() === 0 || x.getUTCDay() === 6);
  return x.toISOString().slice(0, 10);
}

async function runDailyDraw(opts: { drawDate: string; force?: boolean }): Promise<any> {
  const drawDate = opts.drawDate;
  if (!isDiaUtilRep(drawDate)) {
    return { skipped: true, reason: 'fim de semana: repescagem só de segunda a sexta', drawDate,
      externalSellers: 0, telemarketers: 0, candidates: 0, withoutCoords: 0, allocatedExternal: 0, allocatedTelemarketing: 0, inserted: 0 };
  }
  await ensureFormerExcludedOff();

  // Idempotência: se o dia já foi sorteado, não refaz (a menos que force).
  const existing = await db.select({ id: repescagemAssignments.id })
    .from(repescagemAssignments)
    .where(and(eq(repescagemAssignments.drawDate, drawDate), isNotNull(repescagemAssignments.phase)));
  if (existing.length > 0 && !opts.force) {
    return { skipped: true, reason: 'dia já sorteado', drawDate, existing: existing.length };
  }
  if (existing.length > 0 && opts.force) {
    await ensureRepescagemLockCol();
    // Refaz apenas o que ainda não foi atendido (não apaga 'completed') e PRESERVA as
    // alocações TRAVADAS manualmente para o dia vigente (locked + locked_date = drawDate).
    await db.execute(sql`DELETE FROM repescagem_assignments
      WHERE draw_date = ${drawDate} AND phase IS NOT NULL
        AND status IN ('in_route','returned','pending')
        AND NOT (locked = true AND locked_date = ${drawDate})`);
  }

  // Atendentes habilitados, separados por função.
  const enabled = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.isEnabled, true));
  const enabledIds = enabled.map(a => a.userId).filter(id => !REPESCAGEM_SYSTEM_USER_IDS.has(id));
  const roleRows = enabledIds.length
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, enabledIds))
    : [];
  const roleById = new Map(roleRows.map(u => [u.id, u.role]));
  const externalSellers = enabledIds.filter(id => roleById.get(id) === 'vendedor').sort();
  const telemarketers = enabledIds.filter(id => roleById.get(id) === 'telemarketing').sort();

  // Candidatos vermelhos + coordenadas + carteira.
  const startDate = (() => { const d = new Date(drawDate); d.setDate(d.getDate() - 90); return d.toISOString().split('T')[0]; })();
  const endDate = (() => { const d = new Date(drawDate); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();
  const candidates = await computeRedCandidates({ startDate, endDate });

  // INJEÇÃO MANUAL (Admin): clientes forçados via botão "Repescagem" do report entram neste dia
  // mesmo que NÃO estejam vermelhos pelas regras normais (decisão do Admin, só para forced_date).
  // Depois deste dia não são reinjetados — voltam a respeitar todas as regras de repescagem.
  try {
    await ensureRepescagemForcedTable();
    const forced: any = await db.execute(sql`
      SELECT f.customer_id AS cid
      FROM repescagem_forced f
      JOIN customers c ON c.id = f.customer_id
      -- Na segunda também entram os forçados que caíram no sábado/domingo (sem sorteio no fim de semana).
      WHERE f.forced_date > ${diaUtilAnteriorRep(drawDate)} AND f.forced_date <= ${drawDate}
        AND COALESCE(c.is_active, true) = true
        AND COALESCE(c.situacao, '') NOT ILIKE 'inativo'
        AND COALESCE(c.is_supplier, false) = false`);
    const already = new Set(candidates.map((c: any) => c.customerId));
    const retirados = await retiradosHoje(); // retirado hoje pelo Admin também não é injetado
    let injected = 0;
    for (const r of ((forced.rows || forced) as any[])) {
      if (!r.cid || already.has(r.cid) || retirados.has(String(r.cid))) continue;
      already.add(r.cid);
      candidates.push({ customerId: r.cid, lastRedDate: drawDate, daysSince: 0, forcedByAdmin: true });
      injected++;
    }
    if (injected) console.log(`🎯 [REPESCAGEM-FORÇADO] ${drawDate}: ${injected} cliente(s) injetado(s) por decisão do Admin`);
  } catch (e) { console.error('[runDailyDraw] forced injection:', (e as any)?.message); }

  // SEM REPETICAO (plano 11/10/2026): cliente contatado nos ultimos N dias (atendimento
  // virtual, check-in de rota, alocacao concluida ou contato da IA) nao volta ao sorteio.
  // Em julho 927 clientes geraram 8.974 alocacoes (~10 por cliente) e 92% voltaram sem
  // contato. Gate: repescagem_sem_repeticao_dias (default 7; 0 desliga). Forcados passam.
  try {
    const _dias = Math.max(0, parseInt(String((await db.execute(sql`SELECT value FROM system_settings WHERE key = 'repescagem_sem_repeticao_dias' LIMIT 1`)).rows?.[0]?.value ?? '7').replace(/"/g, ''), 10) || 0);
    if (_dias > 0 && candidates.length) {
      const _ids = candidates.map((c: any) => c.customerId).join(',');
      const _rec: any = await db.execute(sql`
        SELECT DISTINCT customer_id FROM (
          SELECT customer_id FROM virtual_service_logs
            WHERE attendance_date > now() - make_interval(days => ${_dias}) AND customer_id = ANY(string_to_array(${_ids}, ','))
              AND NOT (attendant_id = 'ia' AND COALESCE(service_type, '') = 'repescagem_ia')
          UNION ALL
          SELECT customer_id FROM route_checkpoints
            WHERE checkpoint_type = 'check_in' AND checkpoint_time > now() - make_interval(days => ${_dias}) AND customer_id = ANY(string_to_array(${_ids}, ','))
          UNION ALL
          SELECT customer_id FROM repescagem_assignments
            WHERE completed_at > now() - make_interval(days => ${_dias}) AND customer_id = ANY(string_to_array(${_ids}, ','))
        ) x`);
      const _recentes = new Set(((_rec.rows || []) as any[]).map(r => String(r.customer_id)));
      const _antes = candidates.length;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c: any = candidates[i];
        if (!c.forcedByAdmin && _recentes.has(String(c.customerId))) candidates.splice(i, 1);
      }
      if (_antes !== candidates.length) console.log(`🔁 [REPESCAGEM] ${drawDate}: ${_antes - candidates.length} cliente(s) fora do sorteio (contato nos ultimos ${_dias} dias)`);
    }
  } catch (e) { console.error('[runDailyDraw] sem-repeticao:', (e as any)?.message); }

  const candIds = candidates.map((c: any) => c.customerId);
  const coordRows = candIds.length
    ? await db.select({ id: customers.id, lat: customers.latitude, lng: customers.longitude, sellerId: customers.sellerId })
        .from(customers).where(inArray(customers.id, candIds))
    : [];
  const coordById = new Map(coordRows.map(c => [c.id, {
    lat: c.lat != null ? Number(c.lat) : null,
    lng: c.lng != null ? Number(c.lng) : null,
    sellerId: c.sellerId as string | null,
  }]));

  const allocated = new Set<string>();
  const rows: any[] = [];

  // Funcao (role) dos DONOS de carteira dos candidatos (p/ saber quais sao de vendedor externo).
  const ownerIds = Array.from(new Set(coordRows.map(c => c.sellerId).filter(Boolean) as string[]));
  const ownerRoleRows = ownerIds.length
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const ownerRoleById = new Map(ownerRoleRows.map(u => [u.id, u.role]));
  const isExtPortfolio = (custId: string): boolean => {
    const sid = coordById.get(custId)?.sellerId;
    return !!sid && ownerRoleById.get(sid) === 'vendedor';
  };

  // ---- Fase A: externos (perimetro 2 km, teto EXTERNAL_MAX_PER_SELLER, PRIORIDADE do proprio vendedor) ----
  // Somente clientes de carteira de vendedor externo entram aqui; o resto vai p/ telemarketing (Fase B).
  const extLoad = new Map<string, number>(externalSellers.map(id => [id, 0]));
  // Alocações TRAVADAS que sobreviveram ao force-delete: o cliente já está alocado (não
  // re-sorteia) e o atendente já ocupou uma vaga (conta no teto/carga da redistribuição).
  const preTeleLoad = new Map<string, number>();
  try {
    const lockedSurvivors: any = await db.execute(sql`SELECT customer_id, assigned_user_id FROM repescagem_assignments
      WHERE draw_date = ${drawDate} AND status = 'in_route' AND locked = true AND locked_date = ${drawDate}`);
    for (const r of (lockedSurvivors.rows || []) as any[]) {
      allocated.add(r.customer_id);
      if (extLoad.has(r.assigned_user_id)) extLoad.set(r.assigned_user_id, (extLoad.get(r.assigned_user_id) || 0) + 1);
      else preTeleLoad.set(r.assigned_user_id, (preTeleLoad.get(r.assigned_user_id) || 0) + 1);
    }
  } catch (e) { console.error('[runDailyDraw] lockedSurvivors:', (e as any)?.message); }

  // ROTEAMENTO ESPECIAL (carteira -> atendente configurado no painel): o alvo pode ser
  // TELEMARKETING ou VENDEDOR EXTERNO (cross-carteira). Tem prioridade sobre o perímetro.
  const teleSet = new Set(telemarketers);
  const extSellerSet = new Set(externalSellers);
  const crossReceiversDraw = await loadSpecialCrossReceivers();
  const splitLRDraw = repescagemSplitLR(candidates as any, (id) => coordById.get(id)?.sellerId || null, crossReceiversDraw);
  for (const cand of candidates) {
    if (allocated.has(cand.customerId)) continue; // já preservado (travado) ou alocado
    const owner = coordById.get(cand.customerId)?.sellerId || null;
    const target = repescagemSpecialTarget(owner, crossReceiversDraw, splitLRDraw.get(cand.customerId));
    if (!target || (!teleSet.has(target) && !extSellerSet.has(target))) continue;
    const targetIsExternal = extSellerSet.has(target);
    allocated.add(cand.customerId);
    if (targetIsExternal) extLoad.set(target, (extLoad.get(target) || 0) + 1);
    else preTeleLoad.set(target, (preTeleLoad.get(target) || 0) + 1);
    rows.push({ customerId: cand.customerId, lastRedDate: cand.lastRedDate, assignedUserId: target,
      carteiraSellerId: owner, phase: targetIsExternal ? 'external' : 'telemarketing', drawDate, status: 'in_route',
      locked: false, lockedDate: null });
  }

  const anchorsBySeller = new Map<string, Array<{ lat: number; lng: number }>>();
  for (const sellerId of externalSellers) {
    anchorsBySeller.set(sellerId, await repGetRouteAnchors(sellerId, drawDate));
  }
  const nearRoute = (custId: string, sellerId: string): boolean => {
    const info = coordById.get(custId);
    if (!info || info.lat == null || info.lng == null) return false;
    const anchors = anchorsBySeller.get(sellerId) || [];
    return anchors.some(a => repHaversineKm(info.lat as number, info.lng as number, a.lat, a.lng) <= REPESCAGEM_PERIMETER_KM);
  };
  const allocExternal = (custId: string, sellerId: string, cand: any) => {
    allocated.add(custId);
    extLoad.set(sellerId, (extLoad.get(sellerId) || 0) + 1);
    rows.push({ customerId: custId, lastRedDate: cand.lastRedDate, assignedUserId: sellerId,
      carteiraSellerId: coordById.get(custId)?.sellerId || cand.sellerId || null,
      phase: 'external', drawDate, status: 'in_route' });
  };
  const extCandidates = candidates
    .filter((c: any) => isExtPortfolio(c.customerId))
    .sort((a: any, b: any) => repShuffleKey(a.customerId + '|' + drawDate) - repShuffleKey(b.customerId + '|' + drawDate));
  // Pre-passo: o PROPRIO vendedor do cliente primeiro (se habilitado, perto da rota e abaixo do teto).
  for (const c of extCandidates) {
    if (allocated.has(c.customerId)) continue;
    const owner = coordById.get(c.customerId)?.sellerId || null;
    if (owner && extLoad.has(owner) && (extLoad.get(owner) || 0) < EXTERNAL_MAX_PER_SELLER && nearRoute(c.customerId, owner)) {
      allocExternal(c.customerId, owner, c);
    }
  }
  // Preenchimento: outro vendedor externo cuja rota do dia passe perto, respeitando o teto.
  for (const sellerId of externalSellers) {
    for (const c of extCandidates) {
      if ((extLoad.get(sellerId) || 0) >= EXTERNAL_MAX_PER_SELLER) break;
      if (allocated.has(c.customerId)) continue;
      if (nearRoute(c.customerId, sellerId)) allocExternal(c.customerId, sellerId, c);
    }
  }

  // ---- Fase B: telemarketing (aleatório ponderado, inverso à carga) ----
  const remaining = candidates
    .filter((c: any) => !allocated.has(c.customerId))
    .sort((a: any, b: any) => repShuffleKey(a.customerId + '|' + drawDate) - repShuffleKey(b.customerId + '|' + drawDate));
  if (telemarketers.length > 0) {
    const load = new Map<string, number>(telemarketers.map(id => [id, preTeleLoad.get(id) || 0]));
    for (const c of remaining) {
      let best: string | null = null; let bestScore = Infinity;
      for (const t of telemarketers) {
        // score = carga atual + ruído determinístico pequeno (peso inverso à carga).
        const noise = (repShuffleKey(c.customerId + '|' + t) % 1000) / 100000;
        const score = (load.get(t) || 0) + noise;
        if (score < bestScore) { bestScore = score; best = t; }
      }
      if (!best) break;
      load.set(best, (load.get(best) || 0) + 1);
      allocated.add(c.customerId);
      rows.push({ customerId: c.customerId, lastRedDate: c.lastRedDate, assignedUserId: best,
        carteiraSellerId: coordById.get(c.customerId)?.sellerId || c.sellerId || null,
        phase: 'telemarketing', drawDate, status: 'in_route' });
    }
  }

  // Persistência + histórico.
  let inserted = 0;
  for (const r of rows) {
    const ins = await db.insert(repescagemAssignments).values(r).returning();
    await db.insert(repescagemAssignmentHistory).values({
      assignmentId: ins[0].id, customerId: r.customerId, fromUserId: null, toUserId: r.assignedUserId,
      action: 'assigned', reason: `Sorteio ${r.phase} (${drawDate})`,
    });
    inserted++;
  }

  const missingCoordIds = candidates.filter((c: any) => { const i = coordById.get(c.customerId); return !i || i.lat == null; }).map((c: any) => c.customerId);
  const withoutCoords = missingCoordIds.length;
  // Prioriza a geocodificação dos candidatos sem coordenada (segundo plano) — próximos
  // sorteios passam a colocá-los no perímetro dos vendedores externos.
  if (missingCoordIds.length) geocodeMissingCandidates(missingCoordIds).catch(() => {});
  return {
    drawDate, externalSellers: externalSellers.length, telemarketers: telemarketers.length,
    candidates: candidates.length, withoutCoords,
    allocatedExternal: rows.filter(r => r.phase === 'external').length,
    allocatedTelemarketing: rows.filter(r => r.phase === 'telemarketing').length,
    inserted,
  };
}

// Auto-sorteio do dia (throttled, fire-and-forget). Idempotente: só sorteia se
// o dia ainda não foi sorteado. Disparado ao abrir a Repescagem. (Fase 3 moverá
// o gatilho para o carregamento das rotas, para rodar cedo pela manhã.)
async function maybeAutoDraw(): Promise<void> {
  const nowMs = Date.now();
  if (__drawRunning || (nowMs - __lastDrawCheckMs) < 300000) return;
  __lastDrawCheckMs = nowMs;
  __drawRunning = true;
  try {
    const now = new Date();
    const local = new Date(now.getTime() + (-3 * 60 - now.getTimezoneOffset()) * 60000);
    const drawDate = local.toISOString().split('T')[0];
    const r = await runDailyDraw({ drawDate });
    if (!r.skipped) console.log(`🎲 [REPESCAGEM2-DRAW] ${drawDate}: ext=${r.allocatedExternal} tele=${r.allocatedTelemarketing} (cand=${r.candidates}, semCoord=${r.withoutCoords})`);
  } catch (e: any) {
    console.warn('[REPESCAGEM2-DRAW] falha:', e?.message);
  } finally { __drawRunning = false; }
}

// Reconcile throttled + fire-and-forget: usado nos GETs (lista/rota) para nao bloquear a tela.
async function maybeReconcile(actorUserId?: string): Promise<void> {
  const nowMs = Date.now();
  if (__reconcileRunning || (nowMs - __lastReconcileMs) < 60000) return;
  __lastReconcileMs = nowMs;
  __reconcileRunning = true;
  try { await reconcileAssignments(actorUserId); }
  catch (e: any) { console.warn('[REPESCAGEM2-RECONCILE] falha:', e?.message); }
  finally { __reconcileRunning = false; }
}

// ============================================================================
// Repescagem2 — Fase 4: fechamento e devolução
// "Atendido = tem registro de atendimento OU pedido no dia" → conclui a
// alocação (status 'completed'), atribuindo a venda/atendimento a QUEM ATENDEU.
// As alocações 'in_route' de dias anteriores que não foram atendidas expiram
// (status 'returned') e o cliente volta ao bolo p/ o sorteio do dia seguinte.
// ============================================================================
let __closeRunning = false;
let __lastCloseCheckMs = 0;

// Histórico simples de migrações de carteira (data/hora + ocorrência) — item 1.
async function ensureCarteiraMigrations(): Promise<void> {
  await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS carteira_migrations (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar NOT NULL, from_seller_id varchar, to_seller_id varchar NOT NULL, ocorrencia text, occurred_at timestamptz DEFAULT now())"));
  // Fluxo de aprovação (opção 2): a migração deixou de ser automática. Cada detecção vira SUGESTÃO
  // pendente; o admin aprova/rejeita. status: pendente | aprovada | rejeitada (NULL = histórico antigo já aplicado).
  await db.execute(sql.raw("ALTER TABLE carteira_migrations ADD COLUMN IF NOT EXISTS status text"));
  await db.execute(sql.raw("ALTER TABLE carteira_migrations ADD COLUMN IF NOT EXISTS decided_by varchar"));
  await db.execute(sql.raw("ALTER TABLE carteira_migrations ADD COLUMN IF NOT EXISTS decided_at timestamptz"));
}

// Marca, na alocação, se o fechamento veio de um PEDIDO IMPLANTADO (billing_pipeline
// operation_type='venda') pelo MESMO vendedor — e não apenas registro de atendimento.
// A migração de carteira só conta essas ocorrências (ver closeAndExpireRepescagem).
let __ensuredOrderCol = false;
async function ensureRepescagemOrderCol(): Promise<void> {
  if (__ensuredOrderCol) return;
  await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS closed_by_order boolean NOT NULL DEFAULT false"));
  __ensuredOrderCol = true;
}

// Coluna locked_date: dia (YYYY-MM-DD) a que a trava manual se aplica. A trava só vale
// para o dia vigente (destrava automática na virada do dia).
let __ensuredLockCol = false;
async function ensureRepescagemLockCol(): Promise<void> {
  if (__ensuredLockCol) return;
  await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false"));
  await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS locked_date varchar"));
  await db.execute(sql.raw("ALTER TABLE repescagem_assignments ADD COLUMN IF NOT EXISTS locked_by varchar"));
  __ensuredLockCol = true;
}

// INJEÇÃO MANUAL (decisão do Admin). Todo report tem um botão "Repescagem": ao acionar, o
// cliente é forçado a cair em repescagem EXCEPCIONALMENTE no dia seguinte (forced_date). O
// sorteio daquele dia injeta o cliente mesmo que ele NÃO esteja vermelho pelas regras normais.
// Depois disso, o cliente volta a respeitar todas as regras (não é reinjetado nos dias seguintes).
let __ensuredForcedTable = false;
async function ensureRepescagemForcedTable(): Promise<void> {
  if (__ensuredForcedTable) return;
  await db.execute(sql.raw(
    "CREATE TABLE IF NOT EXISTS repescagem_forced (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "customer_id varchar NOT NULL, " +
    "forced_date varchar NOT NULL, " +
    "source_report_id varchar, " +
    "created_by varchar, " +
    "created_at timestamptz DEFAULT now())"
  ));
  await db.execute(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS ux_repforced_cust_date ON repescagem_forced (customer_id, forced_date)"));
  __ensuredForcedTable = true;
}

// Zera travas de dias anteriores (destrava automática na virada do dia). Idempotente.
async function resetStaleLocks(today: string): Promise<void> {
  try {
    await ensureRepescagemLockCol();
    await db.execute(sql`UPDATE repescagem_assignments SET locked = false, updated_at = now()
      WHERE locked = true AND (locked_date IS NULL OR locked_date <> ${today})`);
  } catch (e) { console.error('[resetStaleLocks]', (e as any)?.message); }
}

// CAPTURA DE ATENDIMENTO (substitui a trava): a captura usa as colunas locked/locked_by/locked_date.
// Libera automaticamente: capturas de dias anteriores sempre; as de hoje às 18h (BRT).
// Depois de liberada, o cliente volta a aparecer para os demais telemarketings.
async function releaseExpiredCaptures(opts?: { endOfDay?: boolean }): Promise<void> {
  try {
    await ensureRepescagemLockCol();
    const today = brTodayStr();
    const now = new Date();
    const localBR = new Date(now.getTime() + (-180 - now.getTimezoneOffset()) * 60000);
    const hourBR = localBR.getUTCHours();
    // Captura sem desfecho ao encerrar → pendência do atendente (registro obrigatório, nov/2026).
    await marcarCapturasSemRegistro(!!(opts?.endOfDay || hourBR >= 18));
    if (opts?.endOfDay || hourBR >= 18) {
      // Após 18h: libera TODAS as capturas (encerramento do dia).
      await db.execute(sql`UPDATE repescagem_assignments SET locked = false, locked_by = null, locked_date = null, updated_at = now() WHERE locked = true`);
    } else {
      // Antes das 18h: libera só as de dias anteriores.
      await db.execute(sql`UPDATE repescagem_assignments SET locked = false, locked_by = null, locked_date = null, updated_at = now() WHERE locked = true AND (locked_date IS NULL OR locked_date <> ${today})`);
    }
  } catch (e) { console.error('[releaseExpiredCaptures]', (e as any)?.message); }
}

export async function closeAndExpireRepescagem(date: string): Promise<any> {
  await ensureRepescagemOrderCol();
  const inRoute = await db.select().from(repescagemAssignments)
    .where(and(eq(repescagemAssignments.drawDate, date), eq(repescagemAssignments.status, 'in_route')));

  let completed = 0;
  if (inRoute.length > 0) {
    const cids = Array.from(new Set(inRoute.map(r => r.customerId)));
    const arr = cids.join(',');
    // Quem atendeu (attendantId/sellerId) por cliente — prioriza o primeiro sinal.
    const attendedBy = new Map<string, string | null>();
    const mark = (cid: string, who: any) => { if (cid && !attendedBy.has(cid)) attendedBy.set(cid, who || null); };

    // Registro de atendimento (virtual): virtual_service_logs (inclui 'não venda').
    const vlogs = await db.execute(sql`
      SELECT customer_id, attendant_id FROM virtual_service_logs
      WHERE (attendance_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))
        -- Contato automático da IA da repescagem NÃO fecha o card (nov/2026): o cliente segue na
        -- rota até um humano registrar o atendimento ou sair um pedido.
        AND NOT (attendant_id = 'ia' AND COALESCE(service_type, '') = 'repescagem_ia')`);
    for (const r of vlogs.rows as any[]) mark(r.customer_id, r.attendant_id);

    // Registro de atendimento (presencial): check-in de rota.
    const cps = await db.execute(sql`
      SELECT customer_id, seller_id FROM route_checkpoints
      WHERE checkpoint_type = 'check_in' AND (checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of cps.rows as any[]) mark(r.customer_id, r.seller_id);

    // Pedido: billing_pipeline no dia.
    const orders = await db.execute(sql`
      SELECT customer_id FROM billing_pipeline
      WHERE COALESCE(scheduled_billing_date::date,
                     (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of orders.rows as any[]) mark(r.customer_id, null);

    // PEDIDO IMPLANTADO (venda) por vendedor no dia — usado SÓ para a migração de carteira.
    // "implantado" = billing_pipeline com operation_type='venda'; o pedido é de QUEM implantou
    // (seller_id). A migração exige 2 pedidos implantados pelo mesmo vendedor, não atendimento.
    const orderBySeller = new Set<string>();
    const implOrders = await db.execute(sql`
      SELECT customer_id, seller_id FROM billing_pipeline
      WHERE COALESCE(scheduled_billing_date::date,
                     (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) = ${date}::date
        AND COALESCE(operation_type,'venda') = 'venda'
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of implOrders.rows as any[]) { if (r.seller_id) orderBySeller.add(`${r.customer_id}|${r.seller_id}`); }
    // Vendedor que IMPLANTOU o pedido, por cliente — a migração vai para QUEM VENDEU.
    const vendaSellerByCustomer = new Map<string, string>();
    for (const r of implOrders.rows as any[]) { if (r.seller_id && !vendaSellerByCustomer.has(r.customer_id)) vendaSellerByCustomer.set(r.customer_id, r.seller_id); }
    // Periodicidade por cliente — define o limiar de quedas no mês p/ migrar (mensal=1ª, semanal/quinzenal=2ª).
    const periodicityByCustomer = new Map<string, string>();
    try {
      const pr: any = await db.execute(sql`SELECT id, visit_periodicity FROM customers WHERE id = ANY(string_to_array(${arr}, ','))`);
      for (const r of ((pr.rows || pr) as any[])) periodicityByCustomer.set(r.id, String(r.visit_periodicity || 'semanal'));
    } catch (e) { console.error('[repescagem][periodicity]', (e as any)?.message); }

    for (const a of inRoute) {
      if (!attendedBy.has(a.customerId)) continue;
      const by = attendedBy.get(a.customerId) || a.assignedUserId; // venda de quem atendeu
      // Este fechamento veio de um PEDIDO IMPLANTADO pelo vendedor da alocação?
      const hadOrder = orderBySeller.has(`${a.customerId}|${a.assignedUserId}`);
      await db.update(repescagemAssignments).set({
        status: 'completed', completedAt: new Date(), completedByUserId: by, updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      if (hadOrder) await db.execute(sql`UPDATE repescagem_assignments SET closed_by_order = true WHERE id = ${a.id}`);
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id, customerId: a.customerId, fromUserId: a.assignedUserId, toUserId: by,
        action: 'completed', reason: 'Atendido (registro de atendimento ou pedido)',
      });
      // MIGRAÇÃO DE CARTEIRA (formato por quedas no mês) — vale para TODOS os clientes:
      //  • Conta as QUEDAS em repescagem no MÊS da queda atual (distintas last_red_date no mês).
      //  • Limiar por periodicidade: MENSAL/bimestral = 1ª queda | SEMANAL/QUINZENAL = 2ª queda.
      //  • Ao atingir o limiar E a queda-gatilho ter fechado COM VENDA, a carteira migra
      //    IMEDIATAMENTE para QUEM VENDEU (quem implantou o pedido — externo OU telemarketing).
      //  • Não exige mesmo atendente nem ciclos consecutivos. A comissão já vai p/ quem implanta.
      const vendaSeller = vendaSellerByCustomer.get(a.customerId) || null;
      if (vendaSeller && !REPESCAGEM_EXCLUDED_USER_IDS.has(vendaSeller)) {
        const per = String(periodicityByCustomer.get(a.customerId) || 'semanal').toLowerCase();
        const limiar = (per.indexOf('mens') >= 0 || per.indexOf('bime') >= 0) ? 1 : 2;
        const monthStart = `${String(a.lastRedDate).slice(0, 7)}-01`;
        const cnt: any = await db.execute(sql`
          SELECT COUNT(DISTINCT last_red_date)::int AS n FROM repescagem_assignments
          WHERE customer_id = ${a.customerId}
            AND last_red_date >= ${monthStart}
            AND last_red_date <= ${a.lastRedDate}`);
        const quedasNoMes = Number(((cnt.rows || cnt)[0] as any)?.n || 0);
        if (quedasNoMes >= limiar) {
          const cur: any = await db.execute(sql`SELECT seller_id FROM customers WHERE id = ${a.customerId} LIMIT 1`);
          const curSeller = ((cur.rows || cur)[0] as any)?.seller_id || null;
          if (curSeller !== vendaSeller) {
            try {
              const nameOf = async (uid: string | null): Promise<string> => {
                if (!uid) return '—';
                const u: any = await db.execute(sql`SELECT first_name, last_name FROM users WHERE id = ${uid} LIMIT 1`);
                const r = (u.rows || u)[0]; return r ? (`${r.first_name || ''} ${r.last_name || ''}`.trim() || uid) : uid;
              };
              const fromName = await nameOf(curSeller);
              const toName = await nameOf(vendaSeller);
              const ord = limiar === 1 ? '1ª' : `${quedasNoMes}ª`;
              const ocorr = `Migração automática: ${ord} queda em repescagem no mês (${per}) com venda de ${toName}`;
              await storage.updateCustomer(a.customerId, { sellerId: vendaSeller } as any);
              await ensureCarteiraMigrations();
              await db.execute(sql`INSERT INTO carteira_migrations (customer_id, from_seller_id, to_seller_id, ocorrencia, status, decided_by, decided_at)
                VALUES (${a.customerId}, ${curSeller}, ${vendaSeller}, ${ocorr}, 'aprovada', 'sistema', now())`);
              await logCustomerNote({ customerId: a.customerId, label: 'Migração de carteira (repescagem)', text: `Cliente migrado de ${fromName} para ${toName}: ${ord} queda em repescagem no mês (${per}) com venda.`, actor: { id: 'system', name: 'Sistema (Repescagem)' } as any, source: 'repescagem' });
              await db.insert(repescagemAssignmentHistory).values({ assignmentId: a.id, customerId: a.customerId, fromUserId: curSeller, toUserId: vendaSeller, action: 'reassigned', reason: `Migração de carteira (${ord} queda no mês + venda)` });
            } catch (e) { console.error('[repescagem][migracao-auto]', (e as any)?.message); }
          }
        }
      }
      completed++;
    }
  }

  // Expira alocações 'in_route' de dias anteriores (não atendidas) → volta ao bolo.
  const expiredRes = await db.execute(sql`
    UPDATE repescagem_assignments SET status = 'returned', updated_at = now()
    WHERE status = 'in_route' AND draw_date < ${date} RETURNING id`);
  const expired = (expiredRes.rows || []).length;

  return { date, inRoute: inRoute.length, completed, expired };
}

// Fechamento automático (throttled, fire-and-forget). Marca os atendidos do dia
// como concluídos e expira os pendentes de dias anteriores.
async function maybeAutoCloseRepescagem(): Promise<void> {
  const nowMs = Date.now();
  if (__closeRunning || (nowMs - __lastCloseCheckMs) < 120000) return;
  __lastCloseCheckMs = nowMs;
  __closeRunning = true;
  try {
    const now = new Date();
    const local = new Date(now.getTime() + (-3 * 60 - now.getTimezoneOffset()) * 60000);
    const date = local.toISOString().split('T')[0];
    const r = await closeAndExpireRepescagem(date);
    if (r.completed > 0 || r.expired > 0) console.log(`✅ [REPESCAGEM2-CLOSE] ${date}: concluídos=${r.completed}, expirados=${r.expired}`);
  } catch (e: any) {
    console.warn('[REPESCAGEM2-CLOSE] falha:', e?.message);
  } finally { __closeRunning = false; }
}

export function registerRepescagemRoutes(app: Express, opts: {
  authenticateUser: any;
  requireRole: (roles: string[]) => any;
}) {
  const { authenticateUser, requireRole } = opts;

  // 🚫 Tirar da repescagem (Admin, pelo Inbox) — só no dia; ver repescagem-retirar.ts.
  try { registerRepescagemRetirar(app, { authenticateUser, requireRole }); } catch (e: any) { console.error('[repescagem-retirar]', e?.message); }

  // Correção de drift (15/jul/2026): a tabela em produção ficou sem o DEFAULT gen_random_uuid()
  // na coluna id, então os INSERTs do sorteio (runDailyDraw) falhavam com "null value in column id"
  // — e o erro era engolido pelo maybeAutoDraw, deixando a repescagem nunca entrar nas rotas.
  // Restaura o default (idempotente) no boot.
  (async () => {
    try {
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ALTER COLUMN id SET DEFAULT gen_random_uuid()"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignment_history ALTER COLUMN id SET DEFAULT gen_random_uuid()"));
    } catch (e: any) { console.warn('[REPESCAGEM2] ALTER id default:', e?.message); }
    // Garante a coluna carteiras (idempotente, evita corrida com o boot do index.ts) e semeia os
    // defaults que espelham o roteamento de hoje — apenas na primeira vez (nenhuma carteira config.).
    try {
      await db.execute(sql.raw("ALTER TABLE repescagem_attendants ADD COLUMN IF NOT EXISTS carteiras jsonb NOT NULL DEFAULT '[]'::jsonb"));
      await db.execute(sql.raw("ALTER TABLE repescagem_attendants ADD COLUMN IF NOT EXISTS carteira_pcts jsonb NOT NULL DEFAULT '{}'::jsonb"));
      await seedRepescagemCarteirasIfEmpty();
    } catch (e: any) { console.warn('[REPESCAGEM2] carteiras boot:', e?.message); }
  })();

  // Repescagem2: sorteio diário — disparo manual (admin) e inspeção.
  app.post('/api/repescagem/draw', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const date = String(req.query.date || req.body?.date || '').trim() || (() => {
        const now = new Date(); const local = new Date(now.getTime() + (-3 * 60 - now.getTimezoneOffset()) * 60000);
        return local.toISOString().split('T')[0];
      })();
      const force = String(req.query.force || req.body?.force || '') === '1' || req.body?.force === true;
      const result = await runDailyDraw({ drawDate: date, force });
      res.json(result);
    } catch (e: any) {
      console.error('POST /api/repescagem/draw', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Redistribuição manual (admin) — botão "Atualizar". Dispara TODAS as regras de novo,
  // olhando os atendentes habilitados, PRESERVANDO as linhas travadas do dia; ajusta a
  // lista (pending) e a rota do dia (in_route via sorteio).
  app.post('/api/repescagem/redistribute', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const today = brTodayStr();
      await resetStaleLocks(today);
      const draw = await runDailyDraw({ drawDate: today, force: true });
      await reconcileAssignments((req as any).currentUser?.id);
      res.json({ ok: true, drawDate: today, draw });
    } catch (e: any) {
      console.error('POST /api/repescagem/redistribute', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // FORÇAR REPESCAGEM (Admin) — botão "Repescagem" de qualquer report. O cliente é forçado a
  // cair em repescagem EXCEPCIONALMENTE no dia seguinte (forced_date = amanhã BR). O sorteio das
  // 00:10 daquele dia injeta o cliente mesmo que ele NÃO esteja vermelho. Depois disso ele volta
  // a respeitar todas as regras normais de repescagem (não é reinjetado nos dias seguintes).
  app.post('/api/repescagem/forcar', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const customerId = String(req.body?.customerId || '').trim();
      const sourceReportId = req.body?.reportId ? String(req.body.reportId) : null;
      if (!customerId) return res.status(400).json({ message: 'customerId obrigatório' });

      const cust = await db.select({ id: customers.id, name: customers.name, isActive: customers.isActive })
        .from(customers).where(eq(customers.id, customerId)).limit(1);
      if (cust.length === 0) return res.status(404).json({ message: 'Cliente não encontrado' });
      if (cust[0].isActive === false) return res.status(400).json({ message: 'Cliente inativo não entra em repescagem' });

      // Dia seguinte (horário de Brasília).
      // Próximo DIA ÚTIL (sem repescagem no sábado/domingo): decidido na sexta, cai na segunda.
      const forcedDate = proximoDiaUtilRep(brTodayStr());

      await ensureRepescagemForcedTable();
      await db.execute(sql`
        INSERT INTO repescagem_forced (customer_id, forced_date, source_report_id, created_by)
        VALUES (${customerId}, ${forcedDate}, ${sourceReportId}, ${(req.currentUser?.id || null)})
        ON CONFLICT (customer_id, forced_date) DO NOTHING`);

      try {
        await logCustomerNote({
          customerId, label: 'Repescagem (decisão do Admin)',
          text: `Cliente enviado manualmente para a repescagem de ${forcedDate.split('-').reverse().join('/')} (decisão do Admin a partir de um report). Depois desse dia volta a respeitar as regras normais.`,
          actor: { id: req.currentUser?.id || 'admin', name: req.currentUser?.name || 'Admin' } as any,
          source: 'repescagem',
        });
      } catch (_e: any) { console.warn('[REPESCAGEM-FORÇADO] nota:', _e?.message); }

      res.json({ ok: true, customerId, forcedDate });
    } catch (e: any) {
      console.error('POST /api/repescagem/forcar', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Reatribuir manualmente o atendente de uma alocação (admin). Aceita QUALQUER atendente
  // habilitado (override) e TRAVA a linha no dia para a redistribuição não reverter.
  app.post('/api/repescagem/assignments/:id/reassign', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      const { id } = req.params;
      const actor = (req as any).currentUser;
      const isAdmin = actor?.role === 'admin';
      const toUserId = String(req.body?.toUserId || '').trim();
      if (!toUserId) return res.status(400).json({ message: 'toUserId obrigatório' });
      const today = brTodayStr();
      await ensureRepescagemLockCol();
      const rows = await db.select().from(repescagemAssignments).where(eq(repescagemAssignments.id, id));
      if (rows.length === 0) return res.status(404).json({ message: 'Alocação não encontrada' });
      const a = rows[0];
      // Trava tem dono: se já travada hoje por OUTRO usuário, só ele ou admin pode trocar.
      if ((a as any).locked && (a as any).lockedDate === today && (a as any).lockedBy && (a as any).lockedBy !== actor?.id && !isAdmin) {
        return res.status(403).json({ message: 'Linha travada por outro usuário. Só quem travou ou um admin pode alterar.' });
      }
      // Valida: atendente habilitado, elegível (vendedor/telemarketing) e não excluído.
      const enabled = await db.select().from(repescagemAttendants)
        .where(and(eq(repescagemAttendants.userId, toUserId), eq(repescagemAttendants.isEnabled, true)));
      const urows = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, toUserId));
      const role = urows[0]?.role;
      if (enabled.length === 0 || REPESCAGEM_SYSTEM_USER_IDS.has(toUserId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(role as any)) {
        return res.status(400).json({ message: 'Atendente não habilitado para a repescagem' });
      }
      const phase = role === 'vendedor' ? 'external' : 'telemarketing';
      // Atualiza a linha (pending) escolhida — SEM travar (a pedido: sem trava automatica).
      // Se quiser fixar para nao sofrer reconciliacao, use o cadeado manual.
      await db.update(repescagemAssignments).set({
        assignedUserId: toUserId, phase, locked: false, lockedDate: null, lockedBy: null, assignedAt: new Date(), updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, id));
      // Propaga p/ a rota do dia (in_route do MESMO cliente hoje), mantendo consistência.
      await db.execute(sql`UPDATE repescagem_assignments
        SET assigned_user_id = ${toUserId}, phase = ${phase}, locked = false, locked_date = null, locked_by = null, updated_at = now()
        WHERE customer_id = ${a.customerId} AND status = 'in_route' AND draw_date = ${today}`);
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: id, customerId: a.customerId, fromUserId: a.assignedUserId, toUserId,
        action: 'reassigned', reason: 'Troca manual de atendente',
      });
      res.json({ ok: true, assignmentId: id, assignedUserId: toUserId, phase, locked: false });
    } catch (e: any) {
      console.error('POST /api/repescagem/assignments/:id/reassign', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Atribuir manualmente um candidato SEM atribuição (admin) — cria a alocação (pending)
  // com o atendente escolhido e TRAVA no dia. Aceita qualquer atendente habilitado.
  app.post('/api/repescagem/assign', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      const actor = (req as any).currentUser;
      const customerId = String(req.body?.customerId || '').trim();
      const toUserId = String(req.body?.toUserId || '').trim();
      const lastRedDate = String(req.body?.lastRedDate || '').trim() || brTodayStr();
      if (!customerId || !toUserId) return res.status(400).json({ message: 'customerId e toUserId obrigatórios' });
      const today = brTodayStr();
      await ensureRepescagemLockCol();
      const enabled = await db.select().from(repescagemAttendants)
        .where(and(eq(repescagemAttendants.userId, toUserId), eq(repescagemAttendants.isEnabled, true)));
      const urows = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, toUserId));
      const role = urows[0]?.role;
      if (enabled.length === 0 || REPESCAGEM_SYSTEM_USER_IDS.has(toUserId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(role as any)) {
        return res.status(400).json({ message: 'Atendente não habilitado para a repescagem' });
      }
      const phase = role === 'vendedor' ? 'external' : 'telemarketing';
      const carteira = await db.select({ sellerId: customers.sellerId }).from(customers).where(eq(customers.id, customerId));
      const carteiraSellerId = carteira[0]?.sellerId || null;
      // Reaproveita um pending existente do cliente (se houver); senão cria.
      const existing = await db.select().from(repescagemAssignments)
        .where(and(eq(repescagemAssignments.customerId, customerId), eq(repescagemAssignments.status, 'pending')));
      let assignmentId: string;
      if (existing.length > 0) {
        assignmentId = existing[0].id;
        await db.update(repescagemAssignments).set({
          assignedUserId: toUserId, phase, locked: false, lockedDate: null, lockedBy: null, assignedAt: new Date(), updatedAt: new Date(),
        }).where(eq(repescagemAssignments.id, assignmentId));
      } else {
        const ins = await db.insert(repescagemAssignments).values({
          customerId, lastRedDate, assignedUserId: toUserId, status: 'pending', phase,
          carteiraSellerId, locked: false, lockedDate: null, lockedBy: null,
        }).returning();
        assignmentId = ins[0].id;
      }
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId, customerId, fromUserId: null, toUserId,
        action: 'assigned', reason: 'Atribuição manual de atendente',
      });
      res.json({ ok: true, assignmentId, assignedUserId: toUserId, phase, locked: false });
    } catch (e: any) {
      console.error('POST /api/repescagem/assign', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Alteração EM MASSA de atendente: atribui vários clientes selecionados a um atendente.
  // Reaproveita o pending existente de cada cliente (ou cria) e propaga para a rota do dia.
  // SEM trava (mesma regra do reassign/assign individuais).
  app.post('/api/repescagem/assignments/bulk-assign', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      const toUserId = String(req.body?.toUserId || '').trim();
      const customerIds: string[] = Array.isArray(req.body?.customerIds)
        ? Array.from(new Set(req.body.customerIds.map((x: any) => String(x || '').trim()).filter(Boolean)))
        : [];
      if (!toUserId || customerIds.length === 0) return res.status(400).json({ message: 'toUserId e customerIds obrigatórios' });
      const today = brTodayStr();
      await ensureRepescagemLockCol();
      // Valida o atendente-alvo: habilitado, elegível (vendedor/telemarketing) e não excluído.
      const enabled = await db.select().from(repescagemAttendants)
        .where(and(eq(repescagemAttendants.userId, toUserId), eq(repescagemAttendants.isEnabled, true)));
      const urows = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, toUserId));
      const role = urows[0]?.role;
      if (enabled.length === 0 || REPESCAGEM_SYSTEM_USER_IDS.has(toUserId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(role as any)) {
        return res.status(400).json({ message: 'Atendente não habilitado para a repescagem' });
      }
      const phase = role === 'vendedor' ? 'external' : 'telemarketing';
      let updated = 0, created = 0;
      for (const customerId of customerIds) {
        try {
          const existing = await db.select().from(repescagemAssignments)
            .where(and(eq(repescagemAssignments.customerId, customerId), eq(repescagemAssignments.status, 'pending')));
          let assignmentId: string; let fromUserId: string | null = null;
          if (existing.length > 0) {
            assignmentId = existing[0].id; fromUserId = existing[0].assignedUserId;
            await db.update(repescagemAssignments).set({
              assignedUserId: toUserId, phase, locked: false, lockedDate: null, lockedBy: null, assignedAt: new Date(), updatedAt: new Date(),
            }).where(eq(repescagemAssignments.id, assignmentId));
            updated++;
          } else {
            const carteira = await db.select({ sellerId: customers.sellerId }).from(customers).where(eq(customers.id, customerId));
            const ins = await db.insert(repescagemAssignments).values({
              customerId, lastRedDate: today, assignedUserId: toUserId, status: 'pending', phase,
              carteiraSellerId: carteira[0]?.sellerId || null, locked: false, lockedDate: null, lockedBy: null,
            }).returning();
            assignmentId = ins[0].id; created++;
          }
          // Propaga p/ a rota do dia (in_route do MESMO cliente hoje).
          await db.execute(sql`UPDATE repescagem_assignments
            SET assigned_user_id = ${toUserId}, phase = ${phase}, locked = false, locked_date = null, locked_by = null, updated_at = now()
            WHERE customer_id = ${customerId} AND status = 'in_route' AND draw_date = ${today}`);
          await db.insert(repescagemAssignmentHistory).values({
            assignmentId, customerId, fromUserId, toUserId, action: 'reassigned', reason: 'Alteração em massa de atendente',
          });
        } catch (e) { console.error('[bulk-assign] cliente', customerId, (e as any)?.message); }
      }
      res.json({ ok: true, updated, created, total: updated + created });
    } catch (e: any) {
      console.error('POST /api/repescagem/assignments/bulk-assign', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Travar / destravar UMA linha (qualquer usuário). A trava vale só para o dia vigente.
  // Quem trava vira "dono" da trava; só ele ou um admin conseguem destravar.
  // Vendedores externos também capturam clientes da repescagem na Rota do Dia (nov/2026, pedido
  // do Flavio) — mesmas regras do telemarketing: limite de 5, registro obrigatório e pendência.
  app.post('/api/repescagem/assignments/:id/lock', authenticateUser, requireRole([...ALLOWED_ROLES, 'vendedor']), async (req: any, res) => {
    try {
      const { id } = req.params;
      const actor = (req as any).currentUser;
      const isAdmin = actor?.role === 'admin';
      const locked = req.body?.locked === true || String(req.body?.locked) === 'true';
      const today = brTodayStr();
      await ensureRepescagemLockCol();
      const rows = await db.select().from(repescagemAssignments).where(eq(repescagemAssignments.id, id));
      if (rows.length === 0) return res.status(404).json({ message: 'Alocação não encontrada' });
      const a = rows[0];
      const capturadoHoje = !!(a as any).locked && (a as any).lockedDate === today;
      const dono = (a as any).lockedBy || null;
      // LIBERAR: só quem capturou (locked_by) ou um admin.
      if (!locked && capturadoHoje && dono && dono !== actor?.id && !isAdmin) {
        return res.status(403).json({ message: 'Só quem capturou ou um admin pode liberar este cliente.' });
      }
      // CAPTURAR: não pode roubar um cliente já capturado por outro atendente (admin pode).
      if (locked && capturadoHoje && dono && dono !== actor?.id && !isAdmin) {
        return res.status(403).json({ message: 'Cliente já capturado por outro atendente.' });
      }
      // LIMITE DE CAPTURAS SIMULTÂNEAS (nov/2026, decisão do Flavio): cada atendente pode ter no
      // máximo N clientes capturados ao mesmo tempo (padrão 5; system_settings
      // 'repescagem_max_capturas'). A vaga abre quando ele LIBERA um capturado ou quando o
      // atendimento de um capturado é registrado (o card fecha). Admin não tem limite.
      // REGISTRO OBRIGATÓRIO (nov/2026): toda captura precisa de desfecho. Capturas encerram às 18h;
      // depois disso não há captura nova (o encerramento liberaria na hora e viraria pendência).
      if (locked && !isAdmin && !(capturadoHoje && dono === actor?.id)) {
        if (horaBR() >= 18) {
          return res.status(409).json({ message: 'As capturas de repescagem encerram às 18h. Volte a capturar no próximo dia útil.' });
        }
        await resolverCapturasRepescagem({ attendantId: actor?.id || '' });
        const pend = rowsOfAny(await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM repescagem_capturas WHERE attendant_id = ${actor?.id || ''} AND status = 'pendente'`));
        const nPend = Number(pend[0]?.n || 0);
        if (nPend > 0) {
          return res.status(409).json({ message: `Você tem ${nPend} captura(s) sem registro de atendimento. Registre o atendimento ou justifique na Rota do Dia antes de capturar outro cliente.`, pendencias: nPend });
        }
      }
      if (locked && !isAdmin && !(capturadoHoje && dono === actor?.id)) {
        let max = 5;
        try {
          const st: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'repescagem_max_capturas' LIMIT 1`);
          const v = parseInt(String((st.rows || [])[0]?.value ?? '').replace(/"/g, ''), 10);
          if (Number.isFinite(v) && v > 0) max = v;
        } catch { /* padrão 5 */ }
        const cnt: any = await db.execute(sql`
          SELECT COUNT(DISTINCT customer_id)::int AS n FROM repescagem_assignments
           WHERE locked = true AND locked_date = ${today} AND locked_by = ${actor?.id || ''}
             AND customer_id <> ${a.customerId}
             AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${today}))`);
        const emCaptura = Number((cnt.rows || [])[0]?.n || 0);
        if (emCaptura >= max) {
          return res.status(409).json({ message: `Você já tem ${emCaptura} clientes capturados (limite de ${max}). Libere ou registre o atendimento de um deles para capturar outro.`, limite: max, emCaptura });
        }
      }
      if (locked) {
        // CAPTURA: reatribui o cliente ao capturador e trava nele no dia (não some p/ ele; some p/ os demais).
        await db.execute(sql`UPDATE repescagem_assignments
          SET assigned_user_id = ${actor?.id || null}, locked = true, locked_date = ${today}, locked_by = ${actor?.id || null}, updated_at = now()
          WHERE customer_id = ${a.customerId} AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${today}))`);
        try {
          await db.insert(repescagemAssignmentHistory).values({
            assignmentId: id, customerId: a.customerId, fromUserId: a.assignedUserId, toUserId: actor?.id || null,
            action: 'reassigned', reason: 'Captura de atendimento (telemarketing)',
          });
        } catch { /* histórico best-effort */ }
        // Abre o acompanhamento da captura (registro obrigatório). Admin não tem essa obrigação.
        if (!isAdmin && actor?.id) {
          await ensureRepescagemCapturasTable();
          await db.execute(sql`
            INSERT INTO repescagem_capturas (assignment_id, customer_id, attendant_id, capture_date, status)
            SELECT ${id}, ${a.customerId}, ${actor.id}, ${today}::date, 'aberta'
             WHERE NOT EXISTS (SELECT 1 FROM repescagem_capturas WHERE customer_id = ${a.customerId}
                                 AND attendant_id = ${actor.id} AND capture_date = ${today}::date AND status = 'aberta')`);
        }
      } else {
        // LIBERAR COM JUSTIFICATIVA (nov/2026): quem capturou e vai liberar sem ter registrado
        // atendimento nem venda precisa justificar por escrito (vai para o Inbox).
        if (capturadoHoje && dono) {
          await ensureRepescagemCapturasTable();
          await resolverCapturasRepescagem({ customerId: a.customerId });
          const aberta = rowsOfAny(await db.execute(sql`
            SELECT id FROM repescagem_capturas WHERE customer_id = ${a.customerId} AND attendant_id = ${dono} AND status = 'aberta'
             ORDER BY captured_at DESC LIMIT 1`))[0];
          if (aberta) {
            if (dono === actor?.id && !isAdmin) {
              const just = String(req.body?.justificativa || '').trim();
              if (just.length < 10) {
                return res.status(400).json({ message: 'Para liberar sem atendimento, escreva a justificativa (mínimo 10 caracteres).', precisaJustificativa: true });
              }
              await db.execute(sql`UPDATE repescagem_capturas SET status = 'liberada', texto = ${just.slice(0, 2000)}, desfecho_at = now(), resolved_by = ${actor?.id || null}, updated_at = now() WHERE id = ${aberta.id} AND status = 'aberta'`);
              await inboxDesfechoCaptura(aberta.id);
            } else {
              const nmAdm = (await nomeUsuarioRep(actor?.id)) || 'admin';
              await db.execute(sql`UPDATE repescagem_capturas SET status = 'liberada_admin', texto = ${'Liberado pelo admin ' + nmAdm}, desfecho_at = now(), resolved_by = ${actor?.id || null}, updated_at = now() WHERE id = ${aberta.id} AND status = 'aberta'`);
            }
          }
        }
        // LIBERAR: apenas remove a captura (mantém a atribuição atual); volta a aparecer p/ os demais.
        await db.execute(sql`UPDATE repescagem_assignments
          SET locked = false, locked_date = null, locked_by = null, updated_at = now()
          WHERE customer_id = ${a.customerId} AND (status = 'pending' OR (status = 'in_route' AND draw_date = ${today}))`);
      }
      res.json({ ok: true, assignmentId: id, locked, capturedBy: locked ? (actor?.id || null) : null });
    } catch (e: any) {
      console.error('POST /api/repescagem/assignments/:id/lock', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Travar / destravar TODAS as linhas do dia (admin) — cadeado do cabeçalho.
  app.post('/api/repescagem/assignments/lock-all', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const locked = req.body?.locked === true || String(req.body?.locked) === 'true';
      const today = brTodayStr();
      await ensureRepescagemLockCol();
      const upd: any = await db.execute(sql`UPDATE repescagem_assignments
        SET locked = ${locked}, locked_date = ${locked ? today : null}, updated_at = now()
        WHERE status = 'pending' OR (status = 'in_route' AND draw_date = ${today})`);
      res.json({ ok: true, locked, affected: (upd?.rowCount ?? null) });
    } catch (e: any) {
      console.error('POST /api/repescagem/assignments/lock-all', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // 🎯 Capturas do atendente logado: abertas (em atendimento) e PENDÊNCIAS (sem registro até
  // as 18h — bloqueiam novas capturas até registrar o atendimento ou justificar).
  app.get('/api/repescagem/capturas/minhas', authenticateUser, async (req: any, res) => {
    try {
      const actor = (req as any).currentUser;
      if (!actor?.id) return res.json({ abertas: [], pendentes: [] });
      await ensureRepescagemCapturasTable();
      await resolverCapturasRepescagem({ attendantId: actor.id });
      const rows = rowsOfAny(await db.execute(sql`
        SELECT rc.id, rc.customer_id, rc.status, rc.capture_date::text AS data,
               to_char(rc.captured_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS capturado_em,
               COALESCE(NULLIF(TRIM(cu.fantasy_name), ''), cu.name) AS nome
          FROM repescagem_capturas rc LEFT JOIN customers cu ON cu.id = rc.customer_id
         WHERE rc.attendant_id = ${actor.id} AND rc.status IN ('aberta', 'pendente')
         ORDER BY rc.captured_at ASC`));
      const map = (r: any) => ({ id: r.id, customerId: r.customer_id, nome: r.nome || r.customer_id, data: r.data, capturadoEm: r.capturado_em });
      res.json({
        abertas: rows.filter((r: any) => r.status === 'aberta').map(map),
        pendentes: rows.filter((r: any) => r.status === 'pendente').map(map),
      });
    } catch (e: any) {
      console.error('GET /api/repescagem/capturas/minhas', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Justificar uma PENDÊNCIA de captura (o atendente não registrou atendimento nem liberou).
  app.post('/api/repescagem/capturas/:id/justificar', authenticateUser, async (req: any, res) => {
    try {
      const actor = (req as any).currentUser;
      const isAdmin = actor?.role === 'admin';
      await ensureRepescagemCapturasTable();
      const c = rowsOfAny(await db.execute(sql`SELECT id, attendant_id, customer_id, status FROM repescagem_capturas WHERE id = ${req.params.id} LIMIT 1`))[0];
      if (!c) return res.status(404).json({ message: 'Captura não encontrada.' });
      if (c.attendant_id !== actor?.id && !isAdmin) return res.status(403).json({ message: 'Só quem capturou pode justificar.' });
      await resolverCapturasRepescagem({ customerId: c.customer_id });
      const atual = rowsOfAny(await db.execute(sql`SELECT status FROM repescagem_capturas WHERE id = ${c.id}`))[0];
      if (atual?.status !== 'pendente') return res.json({ ok: true, status: atual?.status, jaResolvida: true });
      const just = String(req.body?.justificativa || '').trim();
      if (just.length < 10) return res.status(400).json({ message: 'Escreva a justificativa (mínimo 10 caracteres).' });
      await db.execute(sql`UPDATE repescagem_capturas SET status = 'justificada', texto = ${just.slice(0, 2000)}, desfecho_at = now(), resolved_by = ${actor?.id || null}, updated_at = now() WHERE id = ${c.id} AND status = 'pendente'`);
      await inboxDesfechoCaptura(c.id);
      res.json({ ok: true, status: 'justificada' });
    } catch (e: any) {
      console.error('POST /api/repescagem/capturas/:id/justificar', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Repescagem2 Fase 4: fechamento manual (admin) — conclui atendidos e expira antigos.
  app.post('/api/repescagem/close', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const date = String(req.query.date || req.body?.date || '').trim() || (() => {
        const now = new Date(); const local = new Date(now.getTime() + (-3 * 60 - now.getTimezoneOffset()) * 60000);
        return local.toISOString().split('T')[0];
      })();
      const result = await closeAndExpireRepescagem(date);
      res.json(result);
    } catch (e: any) {
      console.error('POST /api/repescagem/close', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // 🗂️ SUGESTÕES DE MIGRAÇÃO DE CARTEIRA (opção 2): lista pendentes p/ o admin decidir.
  // A migração NÃO é mais automática — só é aplicada quando o admin aprova aqui.
  app.get('/api/repescagem/carteira-sugestoes', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (_req: any, res) => {
    try {
      await ensureCarteiraMigrations();
      const nameExpr = (col: string) => `(SELECT NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),'') FROM users u WHERE u.id = ${col} OR u.omie_vendor_code = ${col} OR u.omie_vendor_code = replace(COALESCE(${col},''),'omie-vendor-','') LIMIT 1)`;
      const q = `SELECT m.id, m.customer_id, m.from_seller_id, m.to_seller_id, m.ocorrencia, m.occurred_at,
        (SELECT c.name FROM customers c WHERE c.id = m.customer_id LIMIT 1) AS customer_name,
        ${nameExpr('m.from_seller_id')} AS from_name,
        ${nameExpr('m.to_seller_id')} AS to_name
        FROM carteira_migrations m WHERE m.status = 'pendente' ORDER BY m.occurred_at DESC`;
      const r: any = await db.execute(sql.raw(q));
      const rows = (r.rows || r) as any[];
      res.json({ ok: true, total: rows.length, sugestoes: rows });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });

  // Aprovar/Rejeitar uma sugestão. body: { acao: 'aprovar' | 'rejeitar' }.
  // Aprovar aplica a migração via storage.updateCustomer (auditado + propaga agenda).
  app.post('/api/repescagem/carteira-sugestoes/:id/decidir', authenticateUser, requireRole(['admin', 'coordinator', 'administrative']), async (req: any, res) => {
    try {
      await ensureCarteiraMigrations();
      const id = String(req.params.id);
      const acao = String(req.body?.acao || '');
      const r: any = await db.execute(sql`SELECT * FROM carteira_migrations WHERE id = ${id} AND status = 'pendente' LIMIT 1`);
      const row = ((r.rows || r) as any[])[0];
      if (!row) return res.status(404).json({ message: 'Sugestão não encontrada ou já decidida.' });
      const u = req.currentUser || {};
      const actor = { id: u.id, name: (`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'admin') };
      if (acao === 'aprovar') {
        const before: any = await storage.getCustomer(row.customer_id);
        if (before && before.sellerId !== row.to_seller_id) {
          await storage.updateCustomer(row.customer_id, { sellerId: row.to_seller_id });
          try { await logCustomerChanges({ customerId: row.customer_id, before, changes: { sellerId: row.to_seller_id }, actor, source: 'repescagem-carteira-aprovada' }); } catch {}
        }
        await db.execute(sql`UPDATE carteira_migrations SET status = 'aprovada', decided_by = ${actor.id}, decided_at = now() WHERE id = ${id}`);
        return res.json({ ok: true, status: 'aprovada' });
      } else if (acao === 'rejeitar') {
        await db.execute(sql`UPDATE carteira_migrations SET status = 'rejeitada', decided_by = ${actor.id}, decided_at = now() WHERE id = ${id}`);
        return res.json({ ok: true, status: 'rejeitada' });
      }
      return res.status(400).json({ message: "acao inválida (use 'aprovar' ou 'rejeitar')" });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  });

  // Inspeção da alocação de um dia (para validação da Fase 2, sem tocar a rota).
  app.get('/api/repescagem/draw', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      const date = String(req.query.date || '').trim() || (() => {
        const now = new Date(); const local = new Date(now.getTime() + (-3 * 60 - now.getTimezoneOffset()) * 60000);
        return local.toISOString().split('T')[0];
      })();
      const rows = await db.select().from(repescagemAssignments)
        .where(and(eq(repescagemAssignments.drawDate, date), isNotNull(repescagemAssignments.phase)));
      const uids = Array.from(new Set(rows.map(r => r.assignedUserId)));
      const us = uids.length ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, role: users.role }).from(users).where(inArray(users.id, uids)) : [];
      const nameById = new Map(us.map(u => [u.id, { name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id, role: u.role }]));
      const cids = Array.from(new Set(rows.map(r => r.customerId)));
      const cs = cids.length ? await db.select({ id: customers.id, name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`, city: customers.city, uf: customers.state }).from(customers).where(inArray(customers.id, cids)) : [];
      const custById = new Map(cs.map(c => [c.id, c]));
      const byPhase: any = { external: 0, telemarketing: 0 };
      const perUser: Record<string, number> = {};
      for (const r of rows) { byPhase[r.phase as string] = (byPhase[r.phase as string] || 0) + 1; perUser[r.assignedUserId] = (perUser[r.assignedUserId] || 0) + 1; }
      res.json({
        drawDate: date, total: rows.length, byPhase,
        perUser: Object.entries(perUser).map(([uid, count]) => ({ userId: uid, name: nameById.get(uid)?.name || uid, role: nameById.get(uid)?.role, count })).sort((a, b) => b.count - a.count),
        items: rows.map(r => ({
          assignmentId: r.id, customerId: r.customerId, customerName: custById.get(r.customerId)?.name || r.customerId,
          uf: custById.get(r.customerId)?.uf || null, city: custById.get(r.customerId)?.city || null,
          phase: r.phase, status: r.status, assignedUserId: r.assignedUserId, assignedUserName: nameById.get(r.assignedUserId)?.name || r.assignedUserId,
          carteiraSellerId: r.carteiraSellerId,
        })),
      });
    } catch (e: any) {
      console.error('GET /api/repescagem/draw', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // ── Repescagem2 Fase 3: camada sobreposta na Rota do Dia ───────────────────
  // Alocações do sorteio (status 'in_route') do vendedor no dia. Ficam FORA de
  // optimized_order, logo intocadas pela otimização/auto-regeneração (travadas).
  // TESTE (admin): dry-run do "pular ciclo". Sem ?apply=true NÃO grava — só mostra o que faria.
  // ?anchor=YYYY-MM-DD opcional (senão usa a última visita agendada passada do cliente).
  app.get('/api/repescagem/pular-ciclo-test/:customerId', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { customerId } = req.params;
      const apply = String(req.query.apply || '') === 'true';
      const anchorStr = String(req.query.anchor || '');
      const { visitAgenda } = await import('@shared/schema');
      const { calculateNextVisitDate } = await import('@shared/visitSchedule');

      const [cust] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
      if (!cust) return res.status(404).json({ error: 'cliente não encontrado' });
      let weekdays: string[] = [];
      try { weekdays = typeof cust.weekdays === 'string' ? JSON.parse(cust.weekdays as string) : ((cust.weekdays as any) || []); } catch { weekdays = []; }

      const readAgenda = async () => {
        const rows = await db.select().from(visitAgenda).where(and(
          eq(visitAgenda.customerId, customerId),
          eq(visitAgenda.visitStatus, 'pending'),
        )).orderBy(sql`${visitAgenda.scheduledDate} ASC`);
        return rows.map((r: any) => new Date(r.scheduledDate).toISOString().slice(0, 10));
      };
      const before = await readAgenda();

      let anchor: Date;
      if (anchorStr) { anchor = new Date(anchorStr + 'T00:00:00'); }
      else {
        const todayStr = brTodayStr();
        const past = await db.select().from(visitAgenda).where(and(
          eq(visitAgenda.customerId, customerId),
          sql`DATE(${visitAgenda.scheduledDate}) <= ${todayStr}`,
        )).orderBy(sql`${visitAgenda.scheduledDate} DESC`).limit(1);
        anchor = past.length ? new Date(past[0].scheduledDate as any) : new Date(todayStr + 'T00:00:00');
      }
      anchor.setHours(0, 0, 0, 0);

      let preview: any = { erro: 'cliente sem weekdays/periodicidade' };
      if (weekdays.length && cust.visitPeriodicity) {
        const per = cust.visitPeriodicity as any;
        const skipped = calculateNextVisitDate({ weekdays, periodicity: per, lastCompletedDate: anchor }).nextDate;
        const resume = calculateNextVisitDate({ weekdays, periodicity: per, lastCompletedDate: skipped }).nextDate;
        const d2 = calculateNextVisitDate({ weekdays, periodicity: per, lastCompletedDate: resume }).nextDate;
        const d3 = calculateNextVisitDate({ weekdays, periodicity: per, lastCompletedDate: d2 }).nextDate;
        preview = {
          periodicidade: per, weekdays,
          ancora: anchor.toISOString().slice(0, 10),
          visitaPulada: skipped.toISOString().slice(0, 10),
          novasProximas3: [resume, d2, d3].map((d: Date) => d.toISOString().slice(0, 10)),
        };
      }

      let after: any = null, result: any = null;
      if (apply) {
        const { recalcularAgendaPulandoCiclo } = await import('./visitScheduleService');
        result = await recalcularAgendaPulandoCiclo(customerId, anchor);
        after = await readAgenda();
      }
      res.json({ customer: cust.name, apply, agendaAntes: before, preview, result, agendaDepois: after });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/repescagem/route-overlay', authenticateUser, async (req: any, res) => {
    try {
      const user = req.currentUser;
      const sellerId = String(req.query.sellerId || '').trim();
      const date = String(req.query.date || '').trim();
      if (!sellerId || !date) return res.status(400).json({ message: 'sellerId e date obrigatórios' });
      if (user.role === 'vendedor' && sellerId !== user.id) return res.status(403).json({ message: 'Acesso negado' });
      const isAdmin = user.role === 'admin';
      const today = brTodayStr();

      // Garante que o sorteio do dia já rodou (antes só disparava ao abrir a página de Repescagem).
      // Sem isto, se ninguém abrisse a página de Repescagem, a rota do dia não recebia repescagem.
      maybeAutoDraw();
      // Fecha os atendidos do dia (throttled) para que saiam da lista de cards.
      maybeAutoCloseRepescagem();
      // Libera capturas expiradas (dias anteriores + hoje após 18h) antes de montar os cards.
      await releaseExpiredCaptures();

      // CARTEIRAS COMPARTILHADAS (nov/2026, regra do Flavio): o % de cada carteira no painel NÃO
      // é rateio. Cada atendente que recebe a carteira vê o SEU % dos clientes dela que caíram,
      // independentemente dos demais (100% = todos). Ex.: Letícia, Amanda e Virgínia com 100% do
      // Gilmar → as três veem todos os clientes do Gilmar em repescagem. Quem CAPTURAR fica com o
      // cliente no dia e ele some para os outros. % não escolhido = 100%.
      const recvPct = new Map<string, number>();
      await ensureFormerExcludedOff();
      if (!REPESCAGEM_SYSTEM_USER_IDS.has(sellerId)) {
        try {
          const ar = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.userId, sellerId));
          const a0: any = ar[0];
          // Atendente DESLIGADO no painel não vê carteiras compartilhadas (continua vendo o que é dele).
          const cart: string[] = a0 && a0.isEnabled !== false && Array.isArray(a0.carteiras) ? a0.carteiras : [];
          const pcts: Record<string, number> = a0 && a0.carteiraPcts && typeof a0.carteiraPcts === 'object' ? a0.carteiraPcts : {};
          for (const src of cart) {
            if (!src || src === sellerId) continue;
            const raw = Number(pcts[src]);
            recvPct.set(String(src), Number.isFinite(raw) && raw > 0 ? Math.min(100, raw) : 100);
          }
        } catch (e) { console.warn('[route-overlay][carteiras]', (e as any)?.message); }
      }
      const recvList = Array.from(recvPct.keys());

      // CARD DUPLO: mostra a repescagem do dia para o ATENDENTE que recebeu
      // (assigned_user_id = sellerId), para o DONO da carteira do cliente
      // (customers.seller_id = sellerId) e para quem RECEBE a carteira no painel (compartilhada).
      const rowsRes: any = await db.execute(sql`
        SELECT ra.id, ra.customer_id, ra.assigned_user_id, ra.phase, c.seller_id AS owner_seller_id,
               ra.locked, ra.locked_by, ra.locked_date
        FROM repescagem_assignments ra
        JOIN customers c ON c.id = ra.customer_id
        WHERE ra.draw_date = ${date} AND ra.status = 'in_route'
          AND (c.is_supplier IS NOT TRUE)
          AND (ra.assigned_user_id = ${sellerId} OR c.seller_id = ${sellerId}
               ${recvList.length ? sql`OR c.seller_id IN (${sql.join(recvList.map((x) => sql`${x}`), sql`, `)})` : sql``})
        ORDER BY ra.last_red_date DESC NULLS LAST, ra.assigned_at DESC NULLS LAST`);
      const seenRowIds = new Set<string>();
      const rawRows = ((rowsRes.rows || []) as any[])
        .filter(r => { if (seenRowIds.has(r.id)) return false; seenRowIds.add(r.id); return true; });
      // % < 100: vê só essa fatia da carteira no dia (ordem estável por cliente; maior % contém a menor).
      const sharedKeep = new Set<string>();
      {
        const byCart = new Map<string, any[]>();
        for (const r of rawRows) {
          const own = String(r.owner_seller_id || '');
          if (!recvPct.has(own)) continue;
          if (!byCart.has(own)) byCart.set(own, []);
          byCart.get(own)!.push(r);
        }
        for (const [own, list] of byCart) {
          const pct = recvPct.get(own) || 100;
          const ord = list.slice().sort((a, b) => repShuffleKey(String(a.customer_id)) - repShuffleKey(String(b.customer_id)));
          const k = pct >= 100 ? ord.length : Math.round((ord.length * pct) / 100);
          for (const r of ord.slice(0, k)) sharedKeep.add(String(r.id));
        }
      }
      const rows = rawRows
        .filter(r => r.assigned_user_id === sellerId || r.owner_seller_id === sellerId || sharedKeep.has(String(r.id)))
        .map(r => ({ id: r.id as string, customerId: r.customer_id as string, assignedUserId: r.assigned_user_id as string, phase: r.phase as string, ownerSellerId: (r.owner_seller_id as string) || null,
          captured: !!r.locked && r.locked_date === today, capturedBy: (!!r.locked && r.locked_date === today) ? (r.locked_by || null) : null }));
      if (rows.length === 0) return res.json([]);
      const cids = Array.from(new Set(rows.map(r => r.customerId)));
      // FASE 4 — "quem colocar o pedido fica com a venda": mapeia o vendedor que IMPLANTOU
      // o PEDIDO (venda) do cliente HOJE. O card na rota de quem NÃO colocou o pedido fica
      // inativo/desabilitado e não entra na justificativa do fechamento de rota.
      const orderWinnerByCustomer = new Map<string, string>();
      try {
        const owArr = cids.join(',');
        const owRes: any = await db.execute(sql`
          SELECT customer_id, seller_id FROM billing_pipeline
          WHERE COALESCE(operation_type,'venda') = 'venda'
            AND seller_id IS NOT NULL
            AND customer_id = ANY(string_to_array(${owArr}, ','))
            AND COALESCE(scheduled_billing_date::date,
                (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) = ${date}::date`);
        for (const r of ((owRes.rows || []) as any[])) {
          if (r.customer_id && r.seller_id && !orderWinnerByCustomer.has(String(r.customer_id))) orderWinnerByCustomer.set(String(r.customer_id), String(r.seller_id));
        }
      } catch (e) { console.warn('[route-overlay][order-winner]', (e as any)?.message); }
      // Nomes de quem recebeu (para o dono ver "em repescagem com X") + de quem colocou o pedido.
      const nameIds = Array.from(new Set([
        ...(rows.map(r => r.assignedUserId).filter(Boolean) as string[]),
        ...(rows.map(r => r.capturedBy).filter(Boolean) as string[]),
        ...Array.from(orderWinnerByCustomer.values()),
      ]));
      const assigneeUsers = nameIds.length ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, nameIds)) : [];
      const assigneeNameById = new Map(assigneeUsers.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id]));
      const cs = await db.select({
        id: customers.id,
        name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
        phone: customers.phone, city: customers.city, uf: customers.state,
        neighborhood: customers.neighborhood,
        address: customers.address, weekdays: customers.weekdays,
        visitPeriodicity: customers.visitPeriodicity,
        semanaAtendimento: customers.semanaAtendimento,
        virtualService: customers.virtualService,
        latitude: customers.latitude, longitude: customers.longitude,
        sellerId: customers.sellerId,
      }).from(customers).where(inArray(customers.id, cids));
      const byId = new Map(cs.map(c => [c.id, c]));
      // Nome do VENDEDOR TITULAR (dono da carteira) de cada cliente — p/ o card do HABILITADO
      // mostrar "Vendedor: <titular>". Resolve por id direto OU pelo código omie do vendedor. (set/2026)
      const ownerNameBySellerId = new Map<string, string>();
      const ownerPhoneBySellerId = new Map<string, string>();
      try {
        const _own: any = await db.execute(sql`
          SELECT DISTINCT c.seller_id AS sid,
                 NULLIF(TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))), '') AS nm,
                 NULLIF(TRIM(COALESCE(u.phone,'')), '') AS ph
          FROM customers c
          LEFT JOIN users u ON (u.id = c.seller_id
                             OR u.omie_vendor_code = c.seller_id
                             OR u.omie_vendor_code = replace(c.seller_id, 'omie-vendor-', ''))
          WHERE c.id IN (${sql.join(cids.map((x: any) => sql`${x}`), sql`, `)})
            AND c.seller_id IS NOT NULL
        `);
        for (const row of ((_own.rows || []) as any[])) {
          if (row.sid && row.nm) ownerNameBySellerId.set(String(row.sid), String(row.nm));
          if (row.sid && row.ph) ownerPhoneBySellerId.set(String(row.sid), String(row.ph));
        }
      } catch (e) { console.warn('[route-overlay][owner-name]', (e as any)?.message); }

      // Contato automático da IA no dia (selo "IA contatou às HH:MM" no card; não é atendimento).
      const iaContatoPor = new Map<string, { em: string; respondeu: boolean }>();
      try {
        const iaR: any = await db.execute(sql`
          SELECT DISTINCT ON (x.customer_id) x.customer_id, x.criado_em,
                 EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = x.conversation_id AND m.sender_type = 'customer' AND m.created_at > x.criado_em) AS respondeu
            FROM ia_repescagem_contatos x
           WHERE x.enviado_ok = true AND x.draw_date = ${date}
             AND x.customer_id = ANY(string_to_array(${cids.join(',')}, ','))
           ORDER BY x.customer_id, x.criado_em DESC`);
        for (const r of ((iaR.rows || []) as any[])) iaContatoPor.set(String(r.customer_id), { em: new Date(r.criado_em).toISOString(), respondeu: !!r.respondeu });
      } catch { /* tabela pode nao existir */ }

      // Quantas vezes o cliente caiu em repescagem (distinct last_red_date).
      // Janela por periodicidade: mensal = últimos 3 meses; semanal/quinzenal = últimos 2 meses.
      const baseDay = brTodayStr();
      const dW3 = new Date(baseDay + 'T00:00:00'); dW3.setMonth(dW3.getMonth() - 3); const win3 = dW3.toISOString().slice(0, 10);
      const dW2 = new Date(baseDay + 'T00:00:00'); dW2.setMonth(dW2.getMonth() - 2); const win2 = dW2.toISOString().slice(0, 10);
      const redRows = await db.select({ customerId: repescagemAssignments.customerId, lastRedDate: repescagemAssignments.lastRedDate })
        .from(repescagemAssignments)
        .where(and(inArray(repescagemAssignments.customerId, cids), gte(repescagemAssignments.lastRedDate, win3)));
      const redByCustomer = new Map<string, string[]>();
      for (const rr of redRows) {
        if (!redByCustomer.has(rr.customerId)) redByCustomer.set(rr.customerId, []);
        redByCustomer.get(rr.customerId)!.push(rr.lastRedDate);
      }
      const countReds = (customerId: string, periodicity: string | null): number => {
        const win = periodicity === 'mensal' ? win3 : win2;
        return new Set((redByCustomer.get(customerId) || []).filter(d => d >= win)).size;
      };

      res.json(rows.map(r => {
        const c = byId.get(r.customerId);
        const per = c?.visitPeriodicity || null;
        return {
          assignmentId: r.id, customerId: r.customerId, customerName: c?.name || r.customerId,
          phone: c?.phone || null, city: c?.city || null, uf: c?.uf || null,
          neighborhood: c?.neighborhood || null,
          address: c?.address || null, weekdays: (c?.weekdays as any) || [],
          latitude: c?.latitude ?? null, longitude: c?.longitude ?? null,
          visitPeriodicity: per,
          semanaAtendimento: (c as any)?.semanaAtendimento || 'toda',
          repescagemCount: countReds(r.customerId, per),
          repescagemWindowMonths: per === 'mensal' ? 3 : 2,
          phase: r.phase, isVirtualClient: !!c?.virtualService,
          ownerSellerName: (c?.sellerId ? (ownerNameBySellerId.get(String(c.sellerId)) || null) : null),
          ownerSellerPhone: (c?.sellerId ? (ownerPhoneBySellerId.get(String(c.sellerId)) || null) : null),
          assignedUserId: r.assignedUserId,
          // DONO da carteira (vendedor de cadastro) do cliente. isOwner = este sellerId é o dono.
          // Regra de fechamento: SOMENTE o vendedor de cadastro justifica repescagem não atendida;
          // o atendente habilitado (que recebeu o cliente) não justifica.
          ownerSellerId: r.ownerSellerId,
          isOwner: !!r.ownerSellerId && r.ownerSellerId === sellerId,
          // Cópia do DONO: o card aparece na rota do dono, mas está atribuído a outro habilitado.
          isOwnerCopy: r.ownerSellerId === sellerId && r.assignedUserId !== sellerId,
          // Carteira COMPARTILHADA: este atendente recebe a carteira no painel (não é o atribuído nem o dono).
          isShared: r.assignedUserId !== sellerId && r.ownerSellerId !== sellerId,
          assignedToName: r.assignedUserId !== sellerId ? (assigneeNameById.get(r.assignedUserId) || null) : null,
          // FASE 4 — atribuição do pedido: quem colocou o pedido (venda) do cliente hoje fica
          // com a venda; o card na rota de quem NÃO colocou fica inativo/desabilitado.
          orderPlaced: !!orderWinnerByCustomer.get(r.customerId),
          orderWinnerUserId: orderWinnerByCustomer.get(r.customerId) || null,
          orderWinnerName: orderWinnerByCustomer.get(r.customerId) ? (assigneeNameById.get(orderWinnerByCustomer.get(r.customerId)!) || null) : null,
          // inativo = houve pedido do cliente hoje, mas não foi o dono desta rota (sellerId) quem colocou.
          inactive: !!orderWinnerByCustomer.get(r.customerId) && orderWinnerByCustomer.get(r.customerId) !== sellerId,
          // CAPTURA DE ATENDIMENTO: quem capturou fica com o card; some para os demais telemarketings.
          captured: r.captured,
          capturedBy: r.capturedBy,
          iaContatoEm: iaContatoPor.get(r.customerId)?.em || null,
          iaRespondeu: !!iaContatoPor.get(r.customerId)?.respondeu,
          capturedByName: r.capturedBy ? (assigneeNameById.get(r.capturedBy) || null) : null,
          canRelease: isAdmin || (!!r.capturedBy && r.capturedBy === user.id),
        };
      // Capturado por OUTRO atendente some desta rota (o dono da carteira continua vendo o card
      // duplo, p/ o fechamento; o admin vê tudo com o selo "capturado por").
      }).filter((it: any) => isAdmin || it.isOwner || !(it.captured && it.capturedBy && it.capturedBy !== sellerId)));
    } catch (e: any) {
      console.error('GET /api/repescagem/route-overlay', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Admin remove um cliente da repescagem do dia — volta ao bolo (novo sorteio).
  app.post('/api/repescagem/route-overlay/:assignmentId/return', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { assignmentId } = req.params;
      const rows = await db.select().from(repescagemAssignments).where(eq(repescagemAssignments.id, assignmentId));
      if (rows.length === 0) return res.status(404).json({ message: 'Alocação não encontrada' });
      await db.update(repescagemAssignments).set({ status: 'returned', locked: false, updatedAt: new Date() })
        .where(eq(repescagemAssignments.id, assignmentId));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId, customerId: rows[0].customerId, fromUserId: rows[0].assignedUserId, toUserId: null,
        action: 'cancelled', reason: 'Removido da rota pelo admin — volta à repescagem',
      });
      res.json({ ok: true });
    } catch (e: any) {
      console.error('POST /api/repescagem/route-overlay/:id/return', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Listar atendentes com suas CARTEIRAS de repescagem e a % de cobertura por carteira.
  // Cada item: { userId, name, role, isEnabled (= tem >= 1 carteira), carteiras: [sellerId...],
  //   coverage: [{ sellerId, sellerName, total, assigned, pct }] } — pct = clientes daquela
  //   carteira em repescagem hoje que estao sob este atendente.
  app.get('/api/repescagem/attendants', authenticateUser, requireRole(ALLOWED_ROLES), async (_req, res) => {
    try {
      // Semeia os defaults (espelho de hoje) se ainda nao houver nenhuma carteira configurada.
      try { await seedRepescagemCarteirasIfEmpty(); } catch {}
      await ensureFormerExcludedOff();

      const eligible = await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
      }).from(users).where(
        and(
          eq(users.isActive, true),
          inArray(users.role, REPESCAGEM_ELIGIBLE_ROLES as any),
        )
      );
      const attendants = await db.select().from(repescagemAttendants);
      const map = new Map(attendants.map(a => [a.userId, a]));

      // ── Cobertura % por carteira, a partir das alocacoes pendentes de hoje ──
      const pending = await db.select({
        customerId: repescagemAssignments.customerId,
        assignedUserId: repescagemAssignments.assignedUserId,
      }).from(repescagemAssignments).where(eq(repescagemAssignments.status, 'pending'));
      const custIds = Array.from(new Set(pending.map(p => p.customerId).filter(Boolean) as string[]));
      const custRows = custIds.length === 0 ? [] : await db.select({
        id: customers.id, sellerId: customers.sellerId,
      }).from(customers).where(inArray(customers.id, custIds));
      const carteiraByCustomer = new Map(custRows.map(c => [c.id, c.sellerId || '']));
      const totalByCarteira = new Map<string, number>();          // total de clientes em repescagem por carteira
      const assignedByUserCarteira = new Map<string, number>();   // `${userId}|${carteira}` -> qtd sob o atendente
      for (const p of pending) {
        const cart = carteiraByCustomer.get(p.customerId) || '';
        if (!cart) continue;
        totalByCarteira.set(cart, (totalByCarteira.get(cart) || 0) + 1);
        const k = `${p.assignedUserId}|${cart}`;
        assignedByUserCarteira.set(k, (assignedByUserCarteira.get(k) || 0) + 1);
      }

      // Nomes das carteiras (sellerIds referenciados nas configs) via tabela users.
      const referenced = new Set<string>();
      for (const a of attendants) for (const s of (Array.isArray((a as any).carteiras) ? (a as any).carteiras as string[] : [])) referenced.add(s);
      const nameRows = referenced.size === 0 ? [] : await db.select({
        id: users.id, firstName: users.firstName, lastName: users.lastName,
      }).from(users).where(inArray(users.id, Array.from(referenced)));
      const nameById = new Map(nameRows.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id]));

      const out = eligible
        .filter(u => !REPESCAGEM_SYSTEM_USER_IDS.has(u.id))
        .map(u => {
          const a = map.get(u.id);
          const carteiras = Array.isArray((a as any)?.carteiras) ? ((a as any).carteiras as string[]) : [];
          const carteiraPcts = ((a as any)?.carteiraPcts && typeof (a as any).carteiraPcts === 'object') ? (a as any).carteiraPcts as Record<string, number> : {};
          const coverage = carteiras.map(sellerId => {
            const total = totalByCarteira.get(sellerId) || 0;
            const assigned = assignedByUserCarteira.get(`${u.id}|${sellerId}`) || 0;
            return {
              sellerId,
              sellerName: nameById.get(sellerId) || sellerId,
              total,
              assigned,
              pct: total > 0 ? Math.round((assigned / total) * 100) : 0,
            };
          });
          return {
            userId: u.id,
            name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id,
            role: u.role, // 'vendedor' (externo) | 'telemarketing' (interno)
            // Chave do painel (liga/desliga), independente das carteiras salvas.
            isEnabled: !!(a as any)?.isEnabled,
            enabledAt: a?.enabledAt || null,
            carteiras,
            carteiraPcts,
            coverage,
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    } catch (e: any) {
      console.error('GET /api/repescagem/attendants', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Carteiras selecionaveis (fontes) = vendedores/telemarketing ATIVOS (donos de clientes).
  app.get('/api/repescagem/carteiras', authenticateUser, requireRole(ALLOWED_ROLES), async (_req, res) => {
    try {
      const sellers = await db.select({
        id: users.id, firstName: users.firstName, lastName: users.lastName, role: users.role,
      }).from(users).where(
        and(eq(users.isActive, true), inArray(users.role, REPESCAGEM_ELIGIBLE_ROLES as any))
      );
      const out = sellers
        .filter(u => !REPESCAGEM_SYSTEM_USER_IDS.has(u.id))
        .map(u => ({ sellerId: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id, role: u.role }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    } catch (e: any) {
      console.error('GET /api/repescagem/carteiras', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Salvar as CARTEIRAS de repescagem de um atendente (admin). Substitui a lista inteira.
  // isEnabled passa a ser derivado: atendente com >= 1 carteira fica habilitado.
  app.post('/api/repescagem/attendants/:userId/carteiras', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { userId } = req.params;
      const body = req.body || {};
      const carteiras: string[] = Array.isArray(body.carteiras) ? Array.from(new Set(body.carteiras.filter((x: any) => typeof x === 'string' && x))) : [];
      if (!userId) return res.status(400).json({ message: 'userId obrigatório' });
      // Valida o atendente: elegivel (vendedor/telemarketing), ativo e nao excluido.
      const target = await db.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, userId));
      if (target.length === 0) return res.status(404).json({ message: 'Usuário não encontrado' });
      const t = target[0];
      if (REPESCAGEM_SYSTEM_USER_IDS.has(userId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(t.role as any) || !t.isActive) {
        return res.status(400).json({ message: 'Usuário não elegível para a repescagem' });
      }
      const existing = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.userId, userId));
      // Carteiras e liga/desliga são independentes: salvar carteiras mantém o estado da chave.
      const isEnabled = existing.length > 0 ? !!existing[0].isEnabled : carteiras.length > 0;
      // Mantem os % apenas das carteiras que continuam na lista (poda os removidos).
      const prevPcts = existing.length > 0 && (existing[0] as any).carteiraPcts && typeof (existing[0] as any).carteiraPcts === 'object'
        ? (existing[0] as any).carteiraPcts as Record<string, number> : {};
      const carteiraPcts: Record<string, number> = {};
      for (const c of carteiras) { if (Number.isFinite(Number(prevPcts[c]))) carteiraPcts[c] = Number(prevPcts[c]); }
      if (existing.length === 0) {
        await db.insert(repescagemAttendants).values({
          id: sql`gen_random_uuid()`,
          userId,
          isEnabled,
          carteiras: carteiras as any,
          carteiraPcts: carteiraPcts as any,
          enabledAt: isEnabled ? new Date() : null,
          disabledAt: isEnabled ? null : new Date(),
        });
      } else {
        await db.update(repescagemAttendants).set({
          isEnabled,
          carteiras: carteiras as any,
          carteiraPcts: carteiraPcts as any,
          enabledAt: existing[0].enabledAt,
          disabledAt: existing[0].disabledAt,
          updatedAt: new Date(),
        }).where(eq(repescagemAttendants.userId, userId));
      }
      await reconcileAssignments((req as any).currentUser?.id);
      res.json({ ok: true, carteiras, isEnabled });
    } catch (e: any) {
      console.error('POST /api/repescagem/attendants/:userId/carteiras', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Definir o % (10..100) de uma carteira para um atendente — controla o rateio quando 2+
  // atendentes recebem a mesma carteira. Salva em carteira_pcts e reconcilia.
  app.post('/api/repescagem/attendants/:userId/carteira-pct', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { userId } = req.params;
      const { sellerId } = req.body || {};
      let pct = Number(req.body?.pct);
      if (!userId || !sellerId) return res.status(400).json({ message: 'userId e sellerId obrigatórios' });
      if (!Number.isFinite(pct)) return res.status(400).json({ message: 'pct inválido' });
      pct = Math.round(pct / 10) * 10;          // passo de 10
      pct = Math.max(10, Math.min(100, pct));   // faixa 10..100
      const existing = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.userId, userId));
      if (existing.length === 0) return res.status(404).json({ message: 'Atendente sem carteiras' });
      const carteiras = Array.isArray((existing[0] as any).carteiras) ? ((existing[0] as any).carteiras as string[]) : [];
      if (!carteiras.includes(sellerId)) return res.status(400).json({ message: 'Carteira não pertence a este atendente' });
      const pcts = ((existing[0] as any).carteiraPcts && typeof (existing[0] as any).carteiraPcts === 'object') ? { ...(existing[0] as any).carteiraPcts } : {};
      pcts[sellerId] = pct;
      await db.update(repescagemAttendants).set({ carteiraPcts: pcts as any, updatedAt: new Date() }).where(eq(repescagemAttendants.userId, userId));
      await reconcileAssignments((req as any).currentUser?.id);
      res.json({ ok: true, sellerId, pct });
    } catch (e: any) {
      console.error('POST /api/repescagem/attendants/:userId/carteira-pct', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Repescagem2: NÃO há mais auto-habilitação. Endpoint mantido apenas para
  // responder de forma clara a clientes antigos que ainda chamem /me.
  app.post('/api/repescagem/attendants/me', authenticateUser, requireRole(ALLOWED_ROLES), async (_req: any, res) => {
    return res.status(403).json({ message: 'Auto-habilitação desativada. Fale com um administrador.' });
  });

  // Repescagem2: administrador habilita/desabilita um atendente elegível.
  app.post('/api/repescagem/attendants/:userId', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const { userId } = req.params;
      const { isEnabled } = req.body || {};
      if (!userId) return res.status(400).json({ message: 'userId obrigatório' });
      // Valida elegibilidade: função externo/telemarketing, ativo e não excluído.
      const target = await db.select({ id: users.id, role: users.role, isActive: users.isActive })
        .from(users).where(eq(users.id, userId));
      if (target.length === 0) return res.status(404).json({ message: 'Usuário não encontrado' });
      const t = target[0];
      if (REPESCAGEM_SYSTEM_USER_IDS.has(userId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(t.role as any) || !t.isActive) {
        return res.status(400).json({ message: 'Usuário não elegível para a repescagem' });
      }
      const existing = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.userId, userId));
      // Repescagem2 (carteiras): a habilitacao agora e derivada das carteiras. Habilitar sem carteiras
      // seria "ligado mas sem receber ninguem", entao ao HABILITAR semeamos ao menos a carteira propria
      // (se ainda vazio); ao DESABILITAR limpamos as carteiras.
      const curCart = existing.length > 0 && Array.isArray((existing[0] as any).carteiras) ? ((existing[0] as any).carteiras as string[]) : [];
      // Desligar NÃO apaga as carteiras: ao religar, o atendente volta com a mesma configuração.
      const nextCart = isEnabled ? (curCart.length > 0 ? curCart : defaultCarteirasFor(userId, true)) : curCart;
      if (existing.length === 0) {
        // id explícito: a coluna no banco pode não ter DEFAULT gen_random_uuid(),
        // então geramos o UUID no próprio INSERT para não violar o NOT NULL.
        await db.insert(repescagemAttendants).values({
          id: sql`gen_random_uuid()`,
          userId,
          isEnabled: !!isEnabled,
          carteiras: nextCart as any,
          enabledAt: isEnabled ? new Date() : null,
          disabledAt: !isEnabled ? new Date() : null,
        });
      } else {
        await db.update(repescagemAttendants).set({
          isEnabled: !!isEnabled,
          carteiras: nextCart as any,
          enabledAt: isEnabled ? new Date() : existing[0].enabledAt,
          disabledAt: !isEnabled ? new Date() : existing[0].disabledAt,
          updatedAt: new Date(),
        }).where(eq(repescagemAttendants.userId, userId));
      }
      // Reconciliar (redistribuição em cascata do fluxo atual)
      await reconcileAssignments((req as any).currentUser?.id);
      res.json({ ok: true });
    } catch (e: any) {
      console.error('POST /api/repescagem/attendants/:userId', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Lista de atribuições enriquecida (clientes para repescagem com atendente atribuído)
  app.get('/api/repescagem/assignments', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      // Repescagem2: dispara o sorteio do dia se ainda não ocorreu (throttled)
      // e fecha/expira as alocações (atendidos → concluídos; antigos → bolo).
      maybeAutoDraw();
      maybeAutoCloseRepescagem();
      // Reconciliar em SEGUNDO PLANO (throttled) — nao bloqueia o carregamento da tela.
      // A lista abaixo reflete o estado atual do banco; o proximo load ja traz o reconcile.
      maybeReconcile((req as any).currentUser?.id);

      // Libera capturas expiradas (dias anteriores + hoje após 18h) antes de montar a lista.
      await releaseExpiredCaptures();

      const pending = await db.select().from(repescagemAssignments)
        .where(eq(repescagemAssignments.status, 'pending'));

      // Carregar nomes de atendentes
      const userIds = Array.from(new Set(pending.map(p => p.assignedUserId)));
      const allUsersList = userIds.length === 0 ? [] : await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      }).from(users).where(inArray(users.id, userIds));
      const userNameById = new Map(allUsersList.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id]));

      // Carregar dados dos clientes
      const customerIds = Array.from(new Set(pending.map(p => p.customerId)));
      const cs = customerIds.length === 0 ? [] : await db.select({
        id: customers.id,
        name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
        sellerId: customers.sellerId,
        weekdays: customers.weekdays,
        periodicity: customers.visitPeriodicity,
        phone: customers.phone,
        city: customers.city,
        neighborhood: customers.neighborhood,
        uf: customers.state,
      }).from(customers).where(inArray(customers.id, customerIds));
      const customerById = new Map(cs.map(c => [c.id, c]));

      // Sellers
      const sellerIds = Array.from(new Set(cs.map(c => c.sellerId).filter(Boolean) as string[]));
      const sellersList = sellerIds.length === 0 ? [] : await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      }).from(users).where(inArray(users.id, sellerIds));
      const sellerNameById = new Map(sellersList.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id]));

      const today = brTodayStr();
      const actor = (req as any).currentUser;
      const isAdmin = actor?.role === 'admin';
      const assignedCustomerIds = new Set(pending.map(p => p.customerId));
      // IA (plano 11/10): contato da IA no dia, se o cliente respondeu e se houve pedido depois.
      const iaPorCliente = new Map<string, { contatoEm: string | null; respondeu: boolean; pedido: boolean }>();
      try {
        if (customerIds.length) {
          const _ids = customerIds.join(',');
          const ia: any = await db.execute(sql`
            SELECT x.customer_id, x.criado_em,
                   EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = x.conversation_id AND m.sender_type = 'customer' AND m.created_at > x.criado_em) AS respondeu,
                   EXISTS (SELECT 1 FROM sales_cards sc WHERE sc.customer_id = x.customer_id AND sc.created_at > x.criado_em AND COALESCE(sc.status,'') <> 'cancelled') AS pedido
            FROM ia_repescagem_contatos x
            WHERE x.enviado_ok = true AND x.criado_em > now() - interval '7 days'
              AND x.customer_id = ANY(string_to_array(${_ids}, ','))
            ORDER BY x.criado_em DESC`);
          for (const r of (ia.rows || []) as any[]) {
            if (!iaPorCliente.has(String(r.customer_id))) iaPorCliente.set(String(r.customer_id), { contatoEm: r.criado_em ? new Date(r.criado_em).toISOString() : null, respondeu: !!r.respondeu, pedido: !!r.pedido });
          }
        }
      } catch { /* tabela pode nao existir ainda */ }
      const result = pending.map(p => {
        const c = customerById.get(p.customerId);
        const days = Math.floor((new Date(today).getTime() - new Date(p.lastRedDate).getTime()) / 86400000);
        const isLocked = !!(p as any).locked && (p as any).lockedDate === today;
        const lockedBy = isLocked ? ((p as any).lockedBy || null) : null;
        // Destravar: admin sempre; o dono da trava; travas do sistema (sem dono) só admin.
        const canUnlock = isAdmin || (!!lockedBy && lockedBy === actor?.id);
        return {
          assignmentId: p.id,
          customerId: p.customerId,
          customerName: c?.name || 'Sem nome',
          customerPhone: c?.phone || null,
          customerCity: c?.city || null,
          customerNeighborhood: c?.neighborhood || null,
          customerUf: c?.uf || null,
          sellerId: c?.sellerId || null,
          sellerName: c?.sellerId ? sellerNameById.get(c.sellerId) : null,
          periodicity: c?.periodicity || 'semanal',
          weekdays: (c?.weekdays as unknown as string[]) || [],
          lastRedDate: p.lastRedDate,
          daysSince: days,
          assignedUserId: p.assignedUserId,
          assignedUserName: userNameById.get(p.assignedUserId) || p.assignedUserId,
          assignedAt: p.assignedAt,
          unassigned: false,
          locked: isLocked,
          lockedBy,
          capturedByName: lockedBy ? (userNameById.get(lockedBy) || null) : null,
          canUnlock,
          ia: iaPorCliente.get(p.customerId) || null,
        };
      });

      // Incluir candidatos da repescagem que ainda não têm atribuição
      // (acontece quando nenhum atendente está habilitado)
      const _today = brTodayStr();
      const _start = (() => { const d = new Date(_today); d.setDate(d.getDate() - 90); return d.toISOString().split('T')[0]; })();
      const _end = (() => { const d = new Date(_today); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();
      const allCandidates = await computeRedCandidates({ startDate: _start, endDate: _end });
      const orphanCustomerIds = allCandidates
        .filter(c => !assignedCustomerIds.has(c.customerId))
        .map(c => c.customerId);
      if (orphanCustomerIds.length > 0) {
        const orphanCustomers = await db.select({
          id: customers.id,
          name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
          sellerId: customers.sellerId,
          weekdays: customers.weekdays,
          periodicity: customers.visitPeriodicity,
          phone: customers.phone,
          city: customers.city,
          neighborhood: customers.neighborhood,
          uf: customers.state,
        }).from(customers).where(inArray(customers.id, orphanCustomerIds));
        const orphanById = new Map(orphanCustomers.map(c => [c.id, c]));
        const orphanSellerIds = Array.from(new Set(orphanCustomers.map(c => c.sellerId).filter(Boolean) as string[]));
        const newSellerIds = orphanSellerIds.filter(id => !sellerNameById.has(id));
        if (newSellerIds.length > 0) {
          const more = await db.select({
            id: users.id, firstName: users.firstName, lastName: users.lastName,
          }).from(users).where(inArray(users.id, newSellerIds));
          for (const u of more) sellerNameById.set(u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id);
        }
        for (const cand of allCandidates) {
          if (assignedCustomerIds.has(cand.customerId)) continue;
          const c = orphanById.get(cand.customerId);
          const days = Math.floor((new Date(today).getTime() - new Date(cand.lastRedDate).getTime()) / 86400000);
          result.push({
            assignmentId: '',
            customerId: cand.customerId,
            customerName: c?.name || cand.customerName || 'Sem nome',
            customerPhone: c?.phone || null,
            customerCity: c?.city || null,
            customerNeighborhood: c?.neighborhood || null,
            customerUf: c?.uf || null,
            sellerId: c?.sellerId || null,
            sellerName: c?.sellerId ? (sellerNameById.get(c.sellerId) || null) : null,
            periodicity: c?.periodicity || cand.periodicity || 'semanal',
            weekdays: (c?.weekdays as unknown as string[]) || cand.weekdays || [],
            lastRedDate: cand.lastRedDate,
            daysSince: days,
            assignedUserId: '',
            assignedUserName: '',
            assignedAt: '' as any,
            unassigned: true,
            locked: false,
            lockedBy: null,
            canUnlock: isAdmin,
          });
        }
      }

      result.sort((a, b) => b.lastRedDate.localeCompare(a.lastRedDate));

      // CAPTURA: esconde dos DEMAIS telemarketings os clientes capturados por outro. O capturador
      // continua vendo o seu, e o admin vê tudo (com selo "capturado por X").
      const visible = isAdmin
        ? result
        : result.filter(r => !(r.locked && r.lockedBy && r.lockedBy !== actor?.id));

      res.json(visible);
    } catch (e: any) {
      console.error('GET /api/repescagem/assignments', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Histórico de uma atribuição/cliente
  app.get('/api/repescagem/history/:customerId', authenticateUser, requireRole(ALLOWED_ROLES), async (req, res) => {
    try {
      const { customerId } = req.params;
      const rows = await db.select().from(repescagemAssignmentHistory)
        .where(eq(repescagemAssignmentHistory.customerId, customerId))
        .orderBy(desc(repescagemAssignmentHistory.createdAt));
      const userIds = Array.from(new Set([
        ...rows.map(r => r.fromUserId).filter(Boolean) as string[],
        ...rows.map(r => r.toUserId).filter(Boolean) as string[],
      ]));
      const us = userIds.length === 0 ? [] : await db.select({
        id: users.id, firstName: users.firstName, lastName: users.lastName,
      }).from(users).where(inArray(users.id, userIds));
      const nameById = new Map(us.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim()]));
      res.json(rows.map(r => ({
        ...r,
        fromUserName: r.fromUserId ? nameById.get(r.fromUserId) || r.fromUserId : null,
        toUserName: r.toUserId ? nameById.get(r.toUserId) || r.toUserId : null,
      })));
    } catch (e: any) {
      console.error('GET /api/repescagem/history', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // Estatísticas: contagem de atendimentos completos por usuário num intervalo
  // Fase 2 — Alerta EM TELA (telemarketing): clientes de repescagem atribuidos ao usuario logado.
  app.get('/api/repescagem/meu-alerta', authenticateUser, requireRole(ALLOWED_ROLES), async (req: any, res) => {
    try {
      const uid = req.currentUser?.id;
      // Alerta em tela e do TELEMARKETING (externos recebem WhatsApp).
      if (!uid || req.currentUser?.role !== 'telemarketing') return res.json({ count: 0, clientes: [] });
      const rows = await db.select().from(repescagemAssignments).where(and(eq(repescagemAssignments.status, 'pending'), eq(repescagemAssignments.assignedUserId, uid)));
      const cids = Array.from(new Set(rows.map(r => r.customerId)));
      const cs = cids.length ? await db.select({ id: customers.id, name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})` }).from(customers).where(inArray(customers.id, cids)) : [];
      const nameById = new Map(cs.map(c => [c.id, c.name]));
      res.json({ count: rows.length, clientes: rows.slice(0, 50).map(r => nameById.get(r.customerId) || r.customerId) });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // 📋 Report diário "Repescagem não atendida": gerar agora (admin) — o agendador faz às 18h.
  app.post('/api/repescagem/nao-atendidos/gerar', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const r = await gerarReportRepescagemNaoAtendida(req.body?.date ? String(req.body.date) : undefined);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      console.error('POST /api/repescagem/nao-atendidos/gerar', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // 📋 Admin decide: os clientes do report VOLTAM para a repescagem (todos ou os marcados).
  // Entram no sorteio seguinte (dia seguinte ao report) por decisão do Admin e são redistribuídos
  // conforme o painel de carteiras. Se esse dia já é HOJE (decisão tomada depois das 00:10), refaz
  // a distribuição de hoje para eles entrarem já. Fecha o report (vai para Resolvidas).
  app.post('/api/repescagem/nao-atendidos/:reportId/devolver', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
      const reportId = String(req.params.reportId || '');
      const rep = rowsOf(await db.execute(sql`SELECT id, status, details FROM change_requests WHERE id = ${reportId} LIMIT 1`))[0];
      if (!rep) return res.status(404).json({ message: 'Report não encontrado' });
      const det = rep.details || {};
      if (det.reportKind !== REP_NAO_ATENDIDA_KIND) return res.status(400).json({ message: 'Este report não é de repescagem não atendida' });
      const todos: string[] = Array.isArray(det.clientes) ? det.clientes.map((c: any) => String(c.customerId)) : [];
      const pedidos: string[] = Array.isArray(req.body?.customerIds) ? req.body.customerIds.map((x: any) => String(x)) : todos;
      const ids = Array.from(new Set(pedidos.filter((x) => todos.includes(x))));
      if (ids.length === 0) return res.status(400).json({ message: 'Nenhum cliente selecionado' });

      const today = brTodayStr();
      // Próximo DIA ÚTIL após o report (sexta → segunda). Decidido depois desse dia: hoje, se for
      // dia útil; senão o próximo dia útil.
      const diaSeguinte = proximoDiaUtilRep(String(det.data || today));
      const forcedDate = diaSeguinte < today ? (isDiaUtilRep(today) ? today : proximoDiaUtilRep(today)) : diaSeguinte;
      await ensureRepescagemForcedTable();
      let devolvidos = 0;
      for (const cid of ids) {
        const ativo = rowsOf(await db.execute(sql`SELECT 1 FROM customers WHERE id = ${cid} AND is_active IS NOT FALSE LIMIT 1`));
        if (!ativo.length) continue;
        await db.execute(sql`
          INSERT INTO repescagem_forced (customer_id, forced_date, source_report_id, created_by)
          VALUES (${cid}, ${forcedDate}, ${reportId}, ${(req.currentUser?.id || null)})
          ON CONFLICT (customer_id, forced_date) DO NOTHING`);
        devolvidos++;
        try {
          await logCustomerNote({
            customerId: cid, label: 'Repescagem (decisão do Admin)',
            text: `Não atendido na repescagem de ${fmtBR(String(det.data || ''))}: devolvido à repescagem de ${fmtBR(forcedDate)} para ser redistribuído (decisão do Admin no report das 18h).`,
            actor: { id: req.currentUser?.id || 'admin', name: req.currentUser?.name || 'Admin' } as any,
            source: 'repescagem',
          });
        } catch { /* nota é best-effort */ }
      }
      // Decisão tomada no próprio dia do sorteio (depois das 00:10): redistribui hoje já.
      let redistribuidoAgora = false;
      if (forcedDate === today) {
        try { await runDailyDraw({ drawDate: today, force: true }); redistribuidoAgora = true; } catch (e) { console.warn('[REP-NAO-ATENDIDA] redistribuição hoje:', (e as any)?.message); }
      }
      const adminNome = req.currentUser ? (`${req.currentUser.firstName || ''} ${req.currentUser.lastName || ''}`.trim() || req.currentUser.email || 'Admin') : 'Admin';
      const texto = `✅ ${devolvidos} de ${todos.length} cliente(s) devolvido(s) à repescagem de ${fmtBR(forcedDate)} para redistribuição` +
        (redistribuidoAgora ? ' (redistribuídos agora).' : ' (entram no sorteio das 00:10).');
      const msg = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'admin', by: req.currentUser?.id || null, byName: adminNome, text: texto, at: new Date().toISOString(), kind: 'system' };
      const novoDet = { ...det, devolvidos: ids, devolvidoPara: forcedDate };
      await db.execute(sql`
        UPDATE change_requests
           SET status = 'lido', resolved_at = NOW(), resolved_by = ${req.currentUser?.id || null}, resolved_by_name = ${adminNome},
               resolution_note = ${texto}, details = ${JSON.stringify(novoDet)}::jsonb,
               messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb
         WHERE id = ${reportId}`);
      res.json({ ok: true, devolvidos, total: todos.length, forcedDate, redistribuidoAgora });
    } catch (e: any) {
      console.error('POST /api/repescagem/nao-atendidos/:reportId/devolver', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  // 📋 Report diário "Repescagem atendida" (17h): gerar agora (admin).
  app.post('/api/repescagem/atendidos/gerar', authenticateUser, requireRole(['admin']), async (req: any, res) => {
    try {
      const r = await gerarReportRepescagemAtendida(req.body?.date ? String(req.body.date) : undefined);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      console.error('POST /api/repescagem/atendidos/gerar', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });

  app.get('/api/repescagem/stats', authenticateUser, requireRole(ALLOWED_ROLES), async (req, res) => {
    try {
      const startDate = String(req.query.startDate || '');
      const endDate = String(req.query.endDate || '');
      if (!startDate || !endDate) return res.status(400).json({ message: 'startDate/endDate' });

      const rows = await db.select().from(repescagemAssignments).where(
        and(
          eq(repescagemAssignments.status, 'completed'),
          gte(repescagemAssignments.completedAt, new Date(`${startDate}T00:00:00-03:00`)),
          lte(repescagemAssignments.completedAt, new Date(`${endDate}T23:59:59-03:00`)),
        )
      );

      const counts = new Map<string, number>();
      for (const r of rows) {
        const uid = r.completedByUserId || r.assignedUserId;
        if (!uid) continue;
        counts.set(uid, (counts.get(uid) || 0) + 1);
      }
      const userIds = Array.from(counts.keys());
      const us = userIds.length === 0 ? [] : await db.select({
        id: users.id, firstName: users.firstName, lastName: users.lastName,
      }).from(users).where(inArray(users.id, userIds));
      const nameById = new Map(us.map(u => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id]));
      const result = Array.from(counts.entries()).map(([userId, count]) => ({
        userId,
        userName: nameById.get(userId) || userId,
        count,
      })).sort((a, b) => b.count - a.count);
      res.json({ total: rows.length, perUser: result });
    } catch (e: any) {
      console.error('GET /api/repescagem/stats', e);
      res.status(500).json({ message: e?.message || 'erro' });
    }
  });
}


// Exportado para o agendador (scheduler.ts): às 18:00 (BRT) libera TODAS as capturas de
// atendimento do dia (encerramento do dia) — o cliente volta a aparecer para os demais
// telemarketings sem depender de alguém abrir a tela.
export async function releaseRepescagemCapturesEndOfDay(): Promise<void> {
  await releaseExpiredCaptures({ endOfDay: true });
}

// ============================================================================
// 📋 REPORT DIÁRIO (18h) — REPESCAGEM DO DIA NÃO ATENDIDA (nov/2026, pedido do Flavio).
// Às 18:00 (BRT) fecha os atendidos do dia (mesma regra oficial: atendimento virtual,
// check-in de rota ou pedido no dia) e manda ao Inbox do admin UM ÚNICO report com todos os
// clientes que caíram na repescagem do dia e continuam sem atendimento. No report o admin
// escolhe se eles VOLTAM para a repescagem (entram no próximo sorteio, redistribuídos conforme
// o painel de carteiras) — mesmo mecanismo do botão "Repescagem" dos reports.
// ============================================================================
const REP_NAO_ATENDIDA_KIND = 'repescagem_nao_atendida';
const repNaoAtendidaEntityId = (date: string) => `repescagem-nao-atendida-${date}`;
const fmtBR = (d: string) => String(d).split('-').reverse().join('/');

export async function gerarReportRepescagemNaoAtendida(dateArg?: string): Promise<{ date: string; total: number; reportId: string | null; created: boolean }> {
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : brTodayStr();
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  // 1) Fecha os atendidos do dia antes de listar (não expira os de hoje).
  try { await closeAndExpireRepescagem(date); } catch (e) { console.warn('[REP-NAO-ATENDIDA] fechamento:', (e as any)?.message); }
  // 2) Clientes da repescagem do dia que continuam sem atendimento.
  const rows = rowsOf(await db.execute(sql`
    SELECT DISTINCT ON (ra.customer_id)
           ra.customer_id, ra.assigned_user_id, ra.phase, ra.last_red_date,
           COALESCE(NULLIF(TRIM(c.fantasy_name), ''), c.name) AS nome,
           c.seller_id, c.city, c.visit_periodicity
      FROM repescagem_assignments ra
      JOIN customers c ON c.id = ra.customer_id
     WHERE ra.draw_date = ${date} AND ra.status = 'in_route'
       AND c.is_supplier IS NOT TRUE AND c.is_active IS NOT FALSE
     ORDER BY ra.customer_id, ra.assigned_at DESC NULLS LAST`));
  const nomeUser = new Map<string, string>();
  try {
    for (const u of rowsOf(await db.execute(sql`SELECT id, omie_vendor_code AS code, TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS nm FROM users`))) {
      const nm = u.nm || String(u.id);
      nomeUser.set(String(u.id), nm);
      if (u.code) { nomeUser.set(String(u.code), nm); nomeUser.set('omie-vendor-' + String(u.code), nm); }
    }
  } catch { /* sem nomes */ }
  const clientes = rows.map((r: any) => ({
    customerId: String(r.customer_id),
    nome: r.nome || String(r.customer_id),
    vendedor: r.seller_id ? (nomeUser.get(String(r.seller_id)) || String(r.seller_id)) : '(sem vendedor)',
    atendente: r.assigned_user_id ? (nomeUser.get(String(r.assigned_user_id)) || String(r.assigned_user_id)) : null,
    fase: r.phase || null,
    periodicidade: r.visit_periodicity || null,
    cidade: r.city || null,
    caiuEm: r.last_red_date || null,
  })).sort((a: any, b: any) => String(a.vendedor).localeCompare(String(b.vendedor)) || String(a.nome).localeCompare(String(b.nome)));

  const { ensureTables } = await import('./change-requests-routes');
  await ensureTables();
  const entityId = repNaoAtendidaEntityId(date);
  const existente = rowsOf(await db.execute(sql`
    SELECT id, status FROM change_requests WHERE entity_type = 'repescagem' AND entity_id = ${entityId}
    ORDER BY created_at DESC LIMIT 1`))[0];
  // Já decidido pelo admin (resolvido): não recria o report do dia.
  if (existente && existente.status !== 'pending') return { date, total: clientes.length, reportId: existente.id, created: false };
  if (clientes.length === 0) return { date, total: 0, reportId: existente?.id || null, created: false };

  const porVendedor = new Map<string, number>();
  for (const c of clientes) porVendedor.set(c.vendedor, (porVendedor.get(c.vendedor) || 0) + 1);
  const resumo = `${clientes.length} cliente(s) caíram na repescagem de ${fmtBR(date)} e não foram atendidos até as 18h ` +
    `(sem atendimento virtual, check-in de rota ou pedido no dia). Por carteira: ` +
    Array.from(porVendedor.entries()).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ') + '. ' +
    `Escolha se eles voltam para a repescagem para serem redistribuídos.`;
  const nomeCard = `Repescagem não atendida — ${fmtBR(date)} (${clientes.length})`;
  const details = { reportKind: REP_NAO_ATENDIDA_KIND, reportLabel: 'Repescagem não atendida', data: date, total: clientes.length, texto: resumo, clientes };
  const msg = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'admin', by: null, byName: 'Sistema', text: resumo, at: new Date().toISOString(), kind: 'system' };

  if (existente) {
    await db.execute(sql`
      UPDATE change_requests
         SET entity_name = ${nomeCard}, details = ${JSON.stringify(details)}::jsonb,
             messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([{ ...msg, text: '🔄 Lista atualizada. ' + resumo }])}::jsonb
       WHERE id = ${existente.id}`);
    return { date, total: clientes.length, reportId: existente.id, created: false };
  }
  const ins = rowsOf(await db.execute(sql`
    INSERT INTO change_requests
      (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
       types, details, status, kind, requested_by, requested_by_name, messages)
    VALUES
      ('repescagem', ${entityId}, NULL, ${nomeCard}, NULL, NULL,
       ${JSON.stringify([])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', 'report', NULL, 'Sistema',
       ${JSON.stringify([msg])}::jsonb)
    RETURNING id`));
  return { date, total: clientes.length, reportId: ins[0]?.id || null, created: true };
}

// ============================================================================
// 📋 REPORT DIÁRIO (17h) — REPESCAGEM ATENDIDA NO DIA (nov/2026, pedido do Flavio).
// De segunda a sexta, às 17:00 (BRT), manda ao Inbox do admin UM report com os clientes que
// foram atendidos na repescagem do dia: carteira, quem atendeu e se houve venda (pedido de
// venda no pipeline no dia, com valor e quem implantou).
// ============================================================================
const REP_ATENDIDA_KIND = 'repescagem_atendida';

export async function gerarReportRepescagemAtendida(dateArg?: string): Promise<{ date: string; total: number; atendidos: number; reportId: string | null; created: boolean; skipped?: string }> {
  const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : brTodayStr();
  if (!isDiaUtilRep(date)) return { date, total: 0, atendidos: 0, reportId: null, created: false, skipped: 'fim de semana' };
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  // Fecha os atendidos até agora (não expira os de hoje).
  try { await closeAndExpireRepescagem(date); } catch (e) { console.warn('[REP-ATENDIDA] fechamento:', (e as any)?.message); }
  const tot = rowsOf(await db.execute(sql`SELECT COUNT(DISTINCT customer_id)::int AS n FROM repescagem_assignments WHERE draw_date = ${date} AND phase IS NOT NULL`))[0];
  const total = Number(tot?.n || 0);
  if (total === 0) return { date, total: 0, atendidos: 0, reportId: null, created: false, skipped: 'sem repescagem no dia' };
  const rows = rowsOf(await db.execute(sql`
    SELECT DISTINCT ON (ra.customer_id)
           ra.customer_id, ra.completed_by_user_id, ra.assigned_user_id, ra.carteira_seller_id,
           COALESCE(NULLIF(TRIM(c.fantasy_name), ''), c.name) AS nome, c.seller_id
      FROM repescagem_assignments ra
      JOIN customers c ON c.id = ra.customer_id
     WHERE ra.draw_date = ${date} AND ra.status = 'completed'
     ORDER BY ra.customer_id, ra.completed_at DESC NULLS LAST`));
  const nomeUser = new Map<string, string>();
  try {
    for (const u of rowsOf(await db.execute(sql`SELECT id, omie_vendor_code AS code, TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS nm FROM users`))) {
      const nm = u.nm || String(u.id);
      nomeUser.set(String(u.id), nm);
      if (u.code) { nomeUser.set(String(u.code), nm); nomeUser.set('omie-vendor-' + String(u.code), nm); }
    }
  } catch { /* sem nomes */ }
  const nomeDe = (id: any) => { const k = String(id || ''); if (!k) return null; if (k.toLowerCase() === 'ia') return 'IA'; return nomeUser.get(k) || k; };
  // Venda no dia: pedido de VENDA no pipeline (mesma data usada no fechamento da repescagem).
  const vendaPor = new Map<string, { valor: number; quem: string | null }>();
  const cids = rows.map((r: any) => String(r.customer_id));
  if (cids.length) {
    const vs = rowsOf(await db.execute(sql`
      SELECT customer_id, COALESCE(SUM(COALESCE(sale_value, 0)), 0) AS v,
             STRING_AGG(DISTINCT COALESCE(NULLIF(TRIM(seller_name), ''), seller_id), ', ') AS quem
        FROM billing_pipeline
       WHERE COALESCE(operation_type, 'venda') = 'venda'
         AND COALESCE(scheduled_billing_date::date, (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) = ${date}::date
         AND customer_id = ANY(string_to_array(${cids.join(',')}, ','))
       GROUP BY customer_id`));
    for (const v of vs) vendaPor.set(String(v.customer_id), { valor: Number(v.v || 0), quem: v.quem ? (nomeDe(v.quem) || String(v.quem)) : null });
  }
  const clientes = rows.map((r: any) => {
    const vd = vendaPor.get(String(r.customer_id));
    return {
      customerId: String(r.customer_id),
      nome: r.nome || String(r.customer_id),
      carteira: nomeDe(r.carteira_seller_id || r.seller_id) || '(sem vendedor)',
      atendeu: nomeDe(r.completed_by_user_id) || nomeDe(r.assigned_user_id) || '—',
      venda: !!vd,
      valor: vd ? vd.valor : 0,
      vendedorPedido: vd ? vd.quem : null,
    };
  }).sort((a: any, b: any) => Number(b.venda) - Number(a.venda) || String(a.carteira).localeCompare(String(b.carteira)) || String(a.nome).localeCompare(String(b.nome)));

  const comVenda = clientes.filter((c: any) => c.venda);
  const valorTotal = comVenda.reduce((s: number, c: any) => s + (c.valor || 0), 0);
  const contar = (k: string) => { const m = new Map<string, number>(); for (const c of clientes as any[]) m.set(c[k], (m.get(c[k]) || 0) + 1); return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([n, q]) => `${n} ${q}`).join(', '); };
  const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const resumo = clientes.length === 0
    ? `Nenhum dos ${total} cliente(s) que caíram na repescagem de ${fmtBR(date)} foi atendido até as 17h.`
    : `${clientes.length} de ${total} cliente(s) da repescagem de ${fmtBR(date)} foram atendidos até as 17h: ` +
      `${comVenda.length} com venda${comVenda.length ? ` (${brl(valorTotal)})` : ''} e ${clientes.length - comVenda.length} sem venda. ` +
      `Quem atendeu: ${contar('atendeu')}. Por carteira: ${contar('carteira')}.`;
  const nomeCard = `Repescagem atendida — ${fmtBR(date)} (${clientes.length} de ${total})`;
  const details = { reportKind: REP_ATENDIDA_KIND, reportLabel: 'Repescagem atendida', data: date, total, atendidos: clientes.length, comVenda: comVenda.length, valorTotal, texto: resumo, clientes };

  const { ensureTables } = await import('./change-requests-routes');
  await ensureTables();
  const entityId = `repescagem-atendida-${date}`;
  const existente = rowsOf(await db.execute(sql`
    SELECT id, status FROM change_requests WHERE entity_type = 'repescagem' AND entity_id = ${entityId}
    ORDER BY created_at DESC LIMIT 1`))[0];
  const msg = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'admin', by: null, byName: 'Sistema', text: resumo, at: new Date().toISOString(), kind: 'system' };
  if (existente) {
    if (existente.status !== 'pending') return { date, total, atendidos: clientes.length, reportId: existente.id, created: false };
    await db.execute(sql`
      UPDATE change_requests
         SET entity_name = ${nomeCard}, details = ${JSON.stringify(details)}::jsonb,
             messages = COALESCE(messages, '[]'::jsonb) || ${JSON.stringify([{ ...msg, text: '🔄 Atualizado. ' + resumo }])}::jsonb
       WHERE id = ${existente.id}`);
    return { date, total, atendidos: clientes.length, reportId: existente.id, created: false };
  }
  const ins = rowsOf(await db.execute(sql`
    INSERT INTO change_requests
      (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
       types, details, status, kind, requested_by, requested_by_name, messages)
    VALUES
      ('repescagem', ${entityId}, NULL, ${nomeCard}, NULL, NULL,
       ${JSON.stringify([])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', 'report', NULL, 'Sistema',
       ${JSON.stringify([msg])}::jsonb)
    RETURNING id`));
  return { date, total, atendidos: clientes.length, reportId: ins[0]?.id || null, created: true };
}

// Exportado para o agendador (scheduler.ts): roda a distribuicao/sorteio da repescagem
// para uma data especifica (ex.: o dia seguinte), programando a rota daquele dia.
export async function runRepescagemDrawForDate(drawDate: string, opts?: { force?: boolean }): Promise<any> {
  return runDailyDraw({ drawDate, force: opts?.force ?? true });
}

// ============================================================================
// Fase 2 — Notificacoes de repescagem.
// WhatsApp aos VENDEDORES EXTERNOS (1 msg consolidada/dia): clientes de carteira
// externa que estao em repescagem. DESLIGADO por padrao (system_settings
// 'repescagem_whatsapp_enabled' != 'true') — em dry-run so registra no log.
// (Os clientes de telemarketing recebem alerta EM TELA via /api/repescagem/meu-alerta.)
// ============================================================================
export async function notifyRepescagemWhatsApp(): Promise<any> {
  try {
    const flag: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'repescagem_whatsapp_enabled' LIMIT 1`);
    const enabled = String(flag.rows?.[0]?.value || '').toLowerCase() === 'true';

    const pend = await db.select().from(repescagemAssignments).where(eq(repescagemAssignments.status, 'pending'));
    const custIds = Array.from(new Set(pend.map(pp => pp.customerId)));
    if (custIds.length === 0) return { enabled, vendors: 0, results: [] };
    const cs = await db.select({
      id: customers.id,
      name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
      sellerId: customers.sellerId,
      periodicity: customers.visitPeriodicity,
    }).from(customers).where(inArray(customers.id, custIds));
    const custById = new Map(cs.map(c => [c.id, c]));
    const sellerIds = Array.from(new Set(cs.map(c => c.sellerId).filter(Boolean) as string[]));
    const us = sellerIds.length ? await db.select({ id: users.id, role: users.role, phone: users.phone, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, sellerIds)) : [];
    const userById = new Map(us.map(u => [u.id, u]));

    // Agrupa clientes de CARTEIRA EXTERNA por vendedor.
    const byVendor = new Map<string, { phone: string; name: string; clientes: string[] }>();
    for (const pp of pend) {
      const c = custById.get(pp.customerId); if (!c || !c.sellerId) continue;
      const seller: any = userById.get(c.sellerId);
      if (!seller || seller.role !== 'vendedor' || !seller.phone) continue;
      let g = byVendor.get(seller.id);
      if (!g) { g = { phone: seller.phone, name: `${seller.firstName || ''} ${seller.lastName || ''}`.trim() || seller.id, clientes: [] }; byVendor.set(seller.id, g); }
      g.clientes.push(c.name);
    }

    const results: any[] = [];
    for (const [, g] of byVendor) {
      const lista = g.clientes.slice(0, 40).map(n => `• ${n}`).join('\n');
      const extra = g.clientes.length > 40 ? `\n… e mais ${g.clientes.length - 40} cliente(s).` : '';
      const msg = `Ola ${g.name}! Os seguintes clientes cairam em REPESCAGEM (nao compraram dentro da periodicidade):\n\n${lista}${extra}\n\nPor favor, revise a periodicidade de cada um e visite/atenda imediatamente. — INTEGRA 2.0`;
      if (enabled) {
        try { const r = await whatsappService.sendMessage(g.phone, msg); results.push({ vendor: g.name, clientes: g.clientes.length, sent: !!r?.success }); }
        catch (e: any) { results.push({ vendor: g.name, clientes: g.clientes.length, sent: false, err: e?.message }); }
      } else {
        results.push({ vendor: g.name, clientes: g.clientes.length, sent: false, dryRun: true });
      }
    }
    console.log(`[REPESCAGEM-WHATSAPP] ${enabled ? 'ENVIADO' : 'DRY-RUN (desligado)'} — ${results.length} vendedor(es) externo(s), ${pend.length} pendentes.`);
    return { enabled, vendors: results.length, results };
  } catch (e: any) {
    console.error('[REPESCAGEM-WHATSAPP] falha:', e?.message);
    return { error: e?.message };
  }
}

// ============================================================================
// 🎯 CAPTURA COM REGISTRO OBRIGATÓRIO (nov/2026, decisão do Flavio).
// Toda captura de repescagem por um atendente (não admin) abre um registro em
// repescagem_capturas e precisa terminar com um desfecho:
//   - venda       → pedido de venda do cliente depois da captura (não precisa texto);
//   - atendida    → registro de atendimento (com texto) ou check-in depois da captura;
//   - liberada    → o atendente liberou SEM atendimento, com justificativa escrita;
//   - pendente    → chegou às 18h sem nada: vira PENDÊNCIA BLOQUEANTE (não captura outro
//                   cliente até registrar o atendimento ou justificar);
//   - justificada → pendência resolvida com justificativa;
//   - cancelada / liberada_admin → captura desfeita pelo admin (sem cobrança).
// Cada desfecho (venda, atendida, liberada, pendente, justificada) vira UM item no Inbox.
// ============================================================================
const REP_CAPTURA_KIND = 'repescagem_captura';
let _capturasTableOk = false;
export async function ensureRepescagemCapturasTable(): Promise<void> {
  if (_capturasTableOk) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS repescagem_capturas (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id varchar,
    customer_id varchar NOT NULL,
    attendant_id varchar NOT NULL,
    capture_date date NOT NULL,
    captured_at timestamp NOT NULL DEFAULT now(),
    status varchar NOT NULL DEFAULT 'aberta',
    desfecho_at timestamp,
    pendente_at timestamp,
    texto text,
    valor numeric,
    quem_vendeu text,
    service_type varchar,
    resolved_by varchar,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_rep_capt_att_status ON repescagem_capturas (attendant_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_rep_capt_cust_status ON repescagem_capturas (customer_id, status)`);
  // Capturas que já estavam ativas antes desta regra entrar no ar passam a ser acompanhadas.
  try {
    await ensureRepescagemLockCol();
    const today = brTodayStr();
    await db.execute(sql`
      INSERT INTO repescagem_capturas (assignment_id, customer_id, attendant_id, capture_date, captured_at, status)
      SELECT DISTINCT ON (ra.customer_id, ra.locked_by) ra.id, ra.customer_id, ra.locked_by, ra.locked_date::date, COALESCE(ra.updated_at, now()), 'aberta'
        FROM repescagem_assignments ra
        JOIN users u ON u.id = ra.locked_by AND COALESCE(u.role::text, '') <> 'admin'
       WHERE ra.locked = true AND ra.locked_date = ${today} AND ra.locked_by IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM repescagem_capturas rc
                          WHERE rc.customer_id = ra.customer_id AND rc.attendant_id = ra.locked_by AND rc.capture_date = ra.locked_date::date)
       ORDER BY ra.customer_id, ra.locked_by, ra.updated_at DESC NULLS LAST`);
  } catch (e) { console.warn('[REP-CAPTURA] backfill:', (e as any)?.message); }
  // Itens do Inbox de captura criados antes da réplica (nov/2026) passam a apontar para quem
  // capturou — assim a réplica do admin chega nas Pendências do Inbox da Rota do Dia dele.
  try {
    await db.execute(sql`
      UPDATE change_requests SET seller_id = details->>'atendenteId'
       WHERE entity_type = 'repescagem' AND details->>'reportKind' = ${REP_CAPTURA_KIND}
         AND seller_id IS NULL AND COALESCE(details->>'atendenteId', '') <> ''`);
  } catch (e) { console.warn('[REP-CAPTURA] seller_id inbox:', (e as any)?.message); }
  _capturasTableOk = true;
  // Corrige capturas marcadas como "venda" em que o pedido foi implantado por OUTRA pessoa.
  void corrigirVendasDeOutro();
  // Limpa na subida os cards de captura que ficaram duplicados com o report normal.
  void unificarCardsCapturaDuplicados().then((k) => { if (k) console.log(`🔗 [REP-CAPTURA] ${k} card(s) de captura unificados com o report do atendimento.`); });
}

const rowsOfAny = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
const horaBR = (): number => {
  const now = new Date();
  return new Date(now.getTime() + (-180 - now.getTimezoneOffset()) * 60000).getUTCHours();
};

const DESFECHO_LABEL: Record<string, string> = {
  venda: 'Atendido com venda',
  atendida: 'Atendido sem venda',
  liberada: 'Liberado sem atendimento (justificado)',
  pendente: 'Capturado sem registro — pendência',
  venda_outro: 'Venda implantada por outro vendedor',
  justificada: 'Pendência justificada',
};
const DESFECHO_EMOJI: Record<string, string> = { venda_outro: '🔁', venda: '💰', atendida: '📝', liberada: '🔓', pendente: '⚠️', justificada: '✍️' };

async function nomeUsuarioRep(id: string | null | undefined): Promise<string | null> {
  const k = String(id || '');
  if (!k) return null;
  if (k.toLowerCase() === 'ia') return 'IA';
  try {
    const u = rowsOfAny(await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${k} OR omie_vendor_code = ${k.replace(/^omie-vendor-/, '')} LIMIT 1`))[0];
    if (u) return (((u.first_name || '') + ' ' + (u.last_name || '')).trim() || (u.email ? String(u.email).split('@')[0] : '')) || k;
  } catch { /* sem nome */ }
  return k;
}

// Cria o item do Inbox para um desfecho de captura (um item por cliente e desfecho).
async function inboxDesfechoCaptura(capturaId: string): Promise<void> {
  try {
    const c = rowsOfAny(await db.execute(sql`
      SELECT rc.*, rc.capture_date::text AS cap_dt, to_char(rc.captured_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS cap_at,
             to_char(COALESCE(rc.desfecho_at, rc.pendente_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS desf_at,
             COALESCE(NULLIF(TRIM(cu.fantasy_name), ''), cu.name) AS nome, cu.seller_id AS carteira_id
        FROM repescagem_capturas rc LEFT JOIN customers cu ON cu.id = rc.customer_id
       WHERE rc.id = ${capturaId} LIMIT 1`))[0];
    if (!c || !DESFECHO_LABEL[c.status]) return;
    const { ensureTables } = await import('./change-requests-routes');
    await ensureTables();
    // 🔗 UM CARD SÓ (nov/2026): atendimento/venda que já gerou o report normal do atendimento
    // (Não-venda, atendimento virtual…) não abre um 2º card — o report normal já mostra o selo
    // "Repescagem · Cliente de X · atendido por Y" e recebe os dados da captura.
    if (c.status === 'atendida' || c.status === 'venda') {
      const rel = await reportNormalDaCaptura(c.id);
      if (rel) {
        await db.execute(sql`
          UPDATE change_requests
             SET details = COALESCE(details, '{}'::jsonb) || ${JSON.stringify({ capturaRepescagem: { capturaId: c.id, desfecho: c.status, capturadoEm: c.cap_at || null, desfechoEm: c.desf_at || null } })}::jsonb
           WHERE id = ${rel}`);
        return;
      }
    }
    const entityId = `repescagem-captura-${c.id}-${c.status}`;
    const ja = rowsOfAny(await db.execute(sql`SELECT id FROM change_requests WHERE entity_type = 'repescagem' AND entity_id = ${entityId} LIMIT 1`));
    if (ja.length) return;
    const atendente = (await nomeUsuarioRep(c.attendant_id)) || '—';
    const carteira = (await nomeUsuarioRep(c.carteira_id)) || '(sem vendedor)';
    const quemRegistrou = c.resolved_by && c.resolved_by !== c.attendant_id ? await nomeUsuarioRep(c.resolved_by) : null;
    const brl = (v: any) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const nome = c.nome || String(c.customer_id);
    const texto = String(c.texto || '').trim();
    let resumo = '';
    if (c.status === 'venda') resumo = `${nome} (carteira ${carteira}) foi atendido na repescagem por ${atendente} com venda de ${brl(c.valor)}${c.quem_vendeu ? ` — pedido de ${c.quem_vendeu}` : ''}.`;
    else if (c.status === 'venda_outro') resumo = `${atendente} capturou ${nome} (carteira ${carteira}), mas o pedido de ${brl(c.valor)} foi implantado por ${c.quem_vendeu || 'outro vendedor'} — a venda é de quem implantou. A captura foi encerrada.`;
    else if (c.status === 'atendida') resumo = `${nome} (carteira ${carteira}) foi atendido na repescagem por ${atendente}, sem venda.${quemRegistrou ? ` Registro feito por ${quemRegistrou}.` : ''}`;
    else if (c.status === 'liberada') resumo = `${atendente} capturou ${nome} (carteira ${carteira}) e liberou sem atendimento.`;
    else if (c.status === 'pendente') resumo = `${atendente} capturou ${nome} (carteira ${carteira}) em ${fmtBR(String(c.cap_dt).slice(0, 10))} e chegou às 18h sem registro de atendimento, sem venda e sem liberar. Ficou com pendência: não captura outro cliente até registrar o atendimento ou justificar.`;
    else if (c.status === 'justificada') resumo = `${atendente} justificou a pendência da captura de ${nome} (carteira ${carteira}).`;
    const details = {
      reportKind: REP_CAPTURA_KIND, reportLabel: 'Captura de repescagem', desfecho: c.status, desfechoLabel: DESFECHO_LABEL[c.status],
      customerId: String(c.customer_id), cliente: nome, carteira, atendente, atendenteId: c.attendant_id,
      capturadoEm: c.cap_at || null, desfechoEm: c.desf_at || null, data: String(c.cap_dt).slice(0, 10),
      texto: texto || null, valor: c.valor != null ? Number(c.valor) : null, quemVendeu: c.quem_vendeu || null,
      serviceType: c.service_type || null, quemRegistrou, resumo,
    };
    const nomeCard = `${DESFECHO_EMOJI[c.status] || ''} ${nome} — ${DESFECHO_LABEL[c.status]}`.trim();
    const msgTxt = texto ? `${resumo}\n\n${c.status === 'liberada' || c.status === 'justificada' ? 'Justificativa' : 'Registro'}: ${texto}` : resumo;
    const msg = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'admin', by: null, byName: 'Sistema', text: msgTxt, at: new Date().toISOString(), kind: 'system' };
    await db.execute(sql`
      INSERT INTO change_requests
        (entity_type, entity_id, customer_id, entity_name, seller_id, seller_name,
         types, details, status, kind, requested_by, requested_by_name, messages)
      VALUES
        ('repescagem', ${entityId}, NULL, ${nomeCard}, ${c.attendant_id || null}, ${atendente},
         ${JSON.stringify([])}::jsonb, ${JSON.stringify(details)}::jsonb, 'pending', 'report', NULL, 'Sistema',
         ${JSON.stringify([msg])}::jsonb)`);
  } catch (e) { console.warn('[REP-CAPTURA] inbox:', (e as any)?.message); }
}

// Captura fechada como "venda" cujo pedido NÃO foi implantado por quem capturou → 'venda_outro'
// (e o card do Inbox passa a dizer quem implantou). Roda na subida do servidor.
async function corrigirVendasDeOutro(): Promise<void> {
  try {
    const rows = rowsOfAny(await db.execute(sql`
      SELECT rc.id FROM repescagem_capturas rc
       WHERE rc.status = 'venda' AND rc.created_at >= now() - interval '30 days'
         AND NOT EXISTS (
           SELECT 1 FROM billing_pipeline bp
            WHERE bp.customer_id::text = rc.customer_id AND COALESCE(bp.operation_type, 'venda') = 'venda'
              AND bp.created_at >= rc.captured_at
              AND (bp.seller_id = rc.attendant_id OR EXISTS (SELECT 1 FROM users u WHERE u.id = rc.attendant_id
                    AND u.omie_vendor_code IS NOT NULL AND bp.seller_id IN (u.omie_vendor_code, 'omie-vendor-' || u.omie_vendor_code))))`));
    for (const r of rows) {
      await db.execute(sql`UPDATE repescagem_capturas SET status = 'venda_outro', updated_at = now() WHERE id = ${r.id} AND status = 'venda'`);
      // Card antigo (desfecho "venda") sai e entra o card correto.
      await db.execute(sql`DELETE FROM change_requests WHERE entity_type = 'repescagem' AND entity_id = ${'repescagem-captura-' + r.id + '-venda'}
                             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(messages, '[]'::jsonb)) m WHERE m->>'kind' IN ('reply', 'resend'))`);
      await inboxDesfechoCaptura(r.id);
    }
    if (rows.length) console.log(`🔁 [REP-CAPTURA] ${rows.length} captura(s) corrigidas para "venda de outro vendedor".`);
  } catch (e) { console.warn('[REP-CAPTURA] corrigir vendas:', (e as any)?.message); }
}

// Report NORMAL (kind='report', entity_type='customer') do mesmo cliente feito por quem capturou
// depois da captura — é o card que fica no Inbox no lugar do card de captura.
async function reportNormalDaCaptura(capturaId: string): Promise<string | null> {
  try {
    const r = rowsOfAny(await db.execute(sql`
      SELECT cr.id FROM change_requests cr, repescagem_capturas rc
       WHERE rc.id = ${capturaId}
         AND cr.kind = 'report' AND cr.entity_type = 'customer'
         AND (cr.entity_id = rc.customer_id OR cr.customer_id = rc.customer_id)
         AND (cr.seller_id = rc.attendant_id OR cr.requested_by = rc.attendant_id)
         AND cr.created_at >= (rc.captured_at AT TIME ZONE 'UTC') - interval '5 minutes'
         AND cr.status <> 'cancelled'
       ORDER BY cr.created_at ASC LIMIT 1`));
    return r[0]?.id ? String(r[0].id) : null;
  } catch { return null; }
}

// Remove o card de captura (atendido/venda) que ficou DUPLICADO com o report normal do mesmo
// atendimento — a captura passa para o report normal. Só remove card sem conversa do admin.
async function unificarCardsCapturaDuplicados(): Promise<number> {
  let n = 0;
  try {
    const dups = rowsOfAny(await db.execute(sql`
      SELECT cr.id, cr.details->>'desfecho' AS desfecho,
             split_part(replace(cr.entity_id, 'repescagem-captura-', ''), '-' || (cr.details->>'desfecho'), 1) AS captura_id
        FROM change_requests cr
       WHERE cr.entity_type = 'repescagem' AND cr.details->>'reportKind' = ${REP_CAPTURA_KIND}
         AND cr.details->>'desfecho' IN ('atendida', 'venda')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(cr.messages, '[]'::jsonb)) m
                          WHERE m->>'kind' IN ('reply', 'resend') )
         AND cr.created_at >= now() - interval '30 days'`));
    for (const d of dups) {
      const capId = String(d.captura_id || '');
      if (!capId) continue;
      const rel = await reportNormalDaCaptura(capId);
      if (!rel) continue;
      const cap = rowsOfAny(await db.execute(sql`
        SELECT to_char(captured_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS cap_at,
               to_char(desfecho_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS desf_at
          FROM repescagem_capturas WHERE id = ${capId}`))[0] || {};
      await db.execute(sql`
        UPDATE change_requests
           SET details = COALESCE(details, '{}'::jsonb) || ${JSON.stringify({ capturaRepescagem: { capturaId: capId, desfecho: d.desfecho, capturadoEm: cap.cap_at || null, desfechoEm: cap.desf_at || null } })}::jsonb
         WHERE id = ${rel}`);
      await db.execute(sql`DELETE FROM change_requests WHERE id = ${d.id}`);
      n++;
    }
  } catch (e) { console.warn('[REP-CAPTURA] unificar:', (e as any)?.message); }
  return n;
}

// Fecha as capturas abertas/pendentes que já tiveram venda ou registro de atendimento
// depois do momento da captura. Chamado ao registrar atendimento, a cada 5 min, antes de
// capturar/liberar e no encerramento das 18h.
export async function resolverCapturasRepescagem(f?: { customerId?: string; attendantId?: string }): Promise<number> {
  await ensureRepescagemCapturasTable();
  const abertas = rowsOfAny(await db.execute(sql`
    SELECT id, customer_id, attendant_id, captured_at::text AS cap_at, status FROM repescagem_capturas
     WHERE status IN ('aberta', 'pendente')
       ${f?.customerId ? sql`AND customer_id = ${f.customerId}` : sql``}
       ${f?.attendantId ? sql`AND attendant_id = ${f.attendantId}` : sql``}`));
  let n = 0;
  for (const c of abertas) {
    try {
      // Venda depois da captura, separando a de QUEM CAPTUROU (o pedido é de quem implantou) da
      // implantada por outra pessoa (ex.: o dono da carteira vendeu enquanto o cliente estava capturado).
      const venda = rowsOfAny(await db.execute(sql`
        SELECT COALESCE(SUM(COALESCE(bp.sale_value, 0)), 0) AS v, COUNT(*)::int AS q,
               COUNT(*) FILTER (WHERE bp.seller_id = ${c.attendant_id}
                 OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${c.attendant_id} AND u.omie_vendor_code IS NOT NULL
                             AND bp.seller_id IN (u.omie_vendor_code, 'omie-vendor-' || u.omie_vendor_code)))::int AS proprio,
               STRING_AGG(DISTINCT COALESCE(NULLIF(TRIM(bp.seller_name), ''), bp.seller_id), ', ') AS quem
          FROM billing_pipeline bp
         WHERE bp.customer_id::text = ${c.customer_id} AND COALESCE(bp.operation_type, 'venda') = 'venda'
           AND bp.created_at >= ${c.cap_at}::timestamp`))[0];
      const log = rowsOfAny(await db.execute(sql`
        SELECT attendant_id, notes, service_type FROM virtual_service_logs
         WHERE customer_id = ${c.customer_id} AND created_at >= ${c.cap_at}::timestamp
           AND NOT (attendant_id = 'ia' AND COALESCE(service_type, '') = 'repescagem_ia')
         ORDER BY (attendant_id = ${c.attendant_id}) DESC, created_at ASC LIMIT 1`))[0];
      let checkin: any = null;
      if (!log) {
        checkin = rowsOfAny(await db.execute(sql`
          SELECT seller_id FROM route_checkpoints
           WHERE customer_id = ${c.customer_id} AND checkpoint_type = 'check_in' AND checkpoint_time >= ${c.cap_at}::timestamp
           ORDER BY checkpoint_time ASC LIMIT 1`))[0];
      }
      let status: string | null = null; let texto: string | null = null; let valor: number | null = null; let quem: string | null = null; let st: string | null = null; let by: string | null = null;
      if (Number(venda?.q || 0) > 0) {
        status = Number(venda?.proprio || 0) > 0 ? 'venda' : 'venda_outro'; valor = Number(venda.v || 0); quem = venda.quem ? (await nomeUsuarioRep(String(venda.quem).split(',')[0].trim())) : null;
        if (log) { texto = log.notes || null; st = log.service_type || null; by = log.attendant_id || null; }
      } else if (log) {
        status = 'atendida'; texto = String(log.notes || '').trim() || '(registro sem texto)'; st = log.service_type || null; by = log.attendant_id || null;
      } else if (checkin) {
        status = 'atendida'; texto = 'Check-in de visita na rota'; by = checkin.seller_id || null;
      }
      if (!status) continue;
      const upd = rowsOfAny(await db.execute(sql`
        UPDATE repescagem_capturas
           SET status = ${status}, desfecho_at = now(), texto = ${texto}, valor = ${valor}, quem_vendeu = ${quem},
               service_type = ${st}, resolved_by = ${by}, updated_at = now()
         WHERE id = ${c.id} AND status IN ('aberta', 'pendente')
         RETURNING id`));
      if (upd.length) { n++; await inboxDesfechoCaptura(c.id); }
    } catch (e) { console.warn('[REP-CAPTURA] resolver:', (e as any)?.message); }
  }
  // Varredura geral (cron de 5 min): junta cards duplicados de captura com o report normal.
  if (!f?.customerId && !f?.attendantId) await unificarCardsCapturaDuplicados();
  return n;
}

// Encerramento: capturas abertas que chegaram ao fim do dia sem desfecho viram PENDÊNCIA
// (se o atendente ainda segurava o cliente) ou são canceladas (captura desfeita pelo admin).
async function marcarCapturasSemRegistro(endOfDay: boolean): Promise<void> {
  try {
    await ensureRepescagemCapturasTable();
    const today = brTodayStr();
    const alvo = rowsOfAny(await db.execute(sql`
      SELECT id FROM repescagem_capturas
       WHERE status = 'aberta' AND ${endOfDay ? sql`capture_date <= ${today}::date` : sql`capture_date < ${today}::date`} LIMIT 1`));
    if (!alvo.length) return;
    await resolverCapturasRepescagem();
    const abertas = rowsOfAny(await db.execute(sql`
      SELECT rc.id,
             EXISTS (SELECT 1 FROM repescagem_assignments ra
                      WHERE ra.customer_id = rc.customer_id AND ra.locked = true AND ra.locked_by = rc.attendant_id
                        AND ra.locked_date = rc.capture_date::text) AS segura
        FROM repescagem_capturas rc
       WHERE rc.status = 'aberta' AND ${endOfDay ? sql`rc.capture_date <= ${today}::date` : sql`rc.capture_date < ${today}::date`}`));
    for (const r of abertas) {
      if (r.segura) {
        const upd = rowsOfAny(await db.execute(sql`UPDATE repescagem_capturas SET status = 'pendente', pendente_at = now(), updated_at = now() WHERE id = ${r.id} AND status = 'aberta' RETURNING id`));
        if (upd.length) await inboxDesfechoCaptura(r.id);
      } else {
        await db.execute(sql`UPDATE repescagem_capturas SET status = 'cancelada', desfecho_at = now(), texto = COALESCE(texto, 'Captura desfeita pelo admin'), updated_at = now() WHERE id = ${r.id} AND status = 'aberta'`);
      }
    }
  } catch (e) { console.warn('[REP-CAPTURA] fim do dia:', (e as any)?.message); }
}
