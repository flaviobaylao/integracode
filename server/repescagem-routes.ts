import type { Express } from 'express';
import { db } from './db';
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
  // Honest 1 e Honest 2 REMOVIDOS da exclusao -> agora elegiveis (telemarketing)
]);

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
async function computeRedCandidates(opts: { startDate: string; endDate: string }, skipOut?: SkipCiclo[]): Promise<any[]> {
  try { return await __computeRedCandidatesRaw(opts, skipOut); } catch (e) { console.error('[computeRedCandidates] fallback:', (e as any)?.message); return []; }
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
    serviceStartDate: customers.serviceStartDate,
    omieClientCode: customers.omieClientCode,
  }).from(customers).where(inArray(customers.id, customerIds));

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
  function getScheduledDates(weekdays: string[], periodicity: string, startStr: string, endStr: string): string[] {
    const wn = weekdays.map(w => WEEKDAY_MAP[w]).filter(n => n !== undefined);
    if (wn.length === 0) return [];
    const start = new Date(startStr + 'T00:00:00');
    const end = new Date(endStr + 'T00:00:00');
    const dates: string[] = [];
    const current = new Date(start);
    while (current <= end) {
      if (wn.includes(current.getDay())) dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
    const interval = PERIODICITY_DAYS[periodicity] || 7;
    if (interval > 7 && dates.length > 0) {
      const filtered: string[] = [];
      let lastIncluded: Date | null = null;
      for (const d of dates) {
        const dt = new Date(d + 'T00:00:00');
        if (!lastIncluded || (dt.getTime() - lastIncluded.getTime()) / 86400000 >= interval - 2) {
          filtered.push(d);
          lastIncluded = dt;
        }
      }
      return filtered;
    }
    return dates;
  }
  const scheduledByCustomer = new Map<string, Set<string>>();
  for (const c of cs) {
    const wd = parseWeekdays(c.weekdays);
    const dates = getScheduledDates(wd, c.periodicity || 'semanal', startDate, endDate);
    if (dates.length > 0) scheduledByCustomer.set(c.id, new Set(dates));
  }

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

  // 3.5) Atendimentos virtuais (registrados em resgate) contam como visita
  const vlogs = await db.select({
    customerId: virtualServiceLogs.customerId,
    attendanceDate: virtualServiceLogs.attendanceDate,
  }).from(virtualServiceLogs).where(
    and(
      sql`DATE(${virtualServiceLogs.attendanceDate}) >= ${startDate}`,
      sql`DATE(${virtualServiceLogs.attendanceDate}) <= ${endDate}`,
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
    dateStr: sql<string>`DATE(COALESCE(${billings.orderDate}, ${billings.invoiceDate}))::text`,
  }).from(billings).where(
    and(
      eq(billings.isCancelled, false),
      sql`COALESCE(CAST(${billings.totalValue} AS NUMERIC), 0) > 0`,
      sql`DATE(COALESCE(${billings.orderDate}, ${billings.invoiceDate})) >= ${startDate}`,
      sql`DATE(COALESCE(${billings.orderDate}, ${billings.invoiceDate})) <= ${endDate}`,
    )
  );
  for (const b of billingOrders) {
    const cid = omieCodeToCustomerId.get(b.omieCustomerCode || '');
    if (!cid || !b.dateStr) continue;
    orderSet.add(`${cid}_${b.dateStr}`);
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
    const scheduled = Array.from(scheduledByCustomer.get(c.id) || []).filter(d => d < todayStr).sort();
    if (scheduled.length === 0) continue;
    const lastDate = scheduled[scheduled.length - 1];
    const vKey = `${c.id}_${lastDate}`;
    const vrecs = visitMap.get(vKey) || [];
    const hasVisit = vrecs.some(v => v.visitStatus === 'completed' || v.checkInTime) || checkpointSet.has(vKey) || virtualLogSet.has(vKey);
    const hasOrder = orderSet.has(vKey);
    // Vermelho = agendada, no passado, sem visita, sem pedido
    if (hasVisit || hasOrder) continue;
    // NOVO: se o cliente recebeu QUALQUER pedido, atendimento virtual,
    // check-in de rota ou visita concluída APÓS lastDate (inclusive),
    // ele já foi atendido na repescagem -> sai da lista.
    // GATILHO "PULAR CICLO": cliente estava vermelho (visita de rota não realizada) e recebeu
    // um PEDIDO (venda) numa data DIFERENTE do dia de rota (fora da rota / repescagem). Nesse caso
    // o pedido "cobre" a próxima visita → pula 1 ciclo. Âncora = data da visita de rota (lastDate).
    if (skipOut) {
      const vendaDates = vendaOrderDatesByCustomer.get(c.id);
      if (vendaDates) {
        const scheduledSet = scheduledByCustomer.get(c.id) || new Set<string>();
        const foraRotaComVenda = Array.from(vendaDates).some(d => d > lastDate && !scheduledSet.has(d));
        if (foraRotaComVenda) skipOut.push({ customerId: c.id, anchor: lastDate });
      }
    }

    const allDatesAfter: string[] = [];
    for (const map of [orderDatesByCustomer, checkpointDatesByCustomer, virtualLogDatesByCustomer, completedVisitDatesByCustomer]) {
      const set = map.get(c.id);
      if (!set) continue;
      for (const d of set) if (d >= lastDate) allDatesAfter.push(d);
    }
    if (allDatesAfter.length > 0) continue;
    const days = Math.floor((new Date(todayStr).getTime() - new Date(lastDate).getTime()) / 86400000);
    candidates.push({
      customerId: c.id,
      customerName: c.name || 'Sem nome',
      sellerId: c.sellerId || null,
      periodicity: c.periodicity || 'semanal',
      weekdays: (c.weekdays as unknown as string[]) || [],
      lastRedDate: lastDate,
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
  const allEnabledIds = enabledRawIds.filter(id => !REPESCAGEM_EXCLUDED_USER_IDS.has(id));
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
  const ownerSellerIds = Array.from(new Set(custInfo.map(c => c.sellerId).filter(Boolean) as string[]));
  const ownerRoleRows = ownerSellerIds.length > 0
    ? await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ownerSellerIds))
    : [];
  const ownerRoleById = new Map(ownerRoleRows.map(u => [u.id, u.role]));
  const isExternalPortfolio = (custId: string): boolean => {
    const sid = coordById.get(custId)?.sellerId;
    return !!sid && ownerRoleById.get(sid) === 'vendedor';
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
        )
      );
    const logsByCustomer = new Map<string, typeof allLogs>();
    for (const l of allLogs) {
      if (!logsByCustomer.has(l.customerId)) logsByCustomer.set(l.customerId, []);
      logsByCustomer.get(l.customerId)!.push(l);
    }
    for (const a of pending) {
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
    const t = pickLeastLoadedInternal();
    if (t) return { userId: t, phase: 'telemarketing' };
    return null;
  }

  function applyLoad(userId: string, phase: 'external' | 'telemarketing') {
    if (phase === 'external') externalLoad.set(userId, (externalLoad.get(userId) || 0) + 1);
    else internalLoad.set(userId, (internalLoad.get(userId) || 0) + 1);
  }

  // 3.5) Promover para o vendedor externo: clientes de carteira externa que hoje
  // estao no telemarketing mas passaram a qualificar no perimetro (<=2km) da rota
  // do dia de um vendedor externo habilitado (dono primeiro, respeitando o teto).
  // Faz a nova regra valer de imediato na lista existente. So promove (nunca rebaixa
  // por mudanca de rota) para evitar churn diario.
  for (const a of stillPending) {
    if (!candidateByCustomerId.has(a.customerId)) continue;
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
      const toMove = Array.from(validPendingByCustomer.values()).find(a => a.assignedUserId === max.id);
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
      if (priorStatuses.includes('completed')) continue;
      const target = chooseTarget(cand.customerId);
      if (!target) continue; // ninguem habilitado apto — fica sem atribuicao (fallback de orfaos)
      const inserted = await db.insert(repescagemAssignments).values({
        customerId: cand.customerId,
        lastRedDate: cand.lastRedDate,
        assignedUserId: target.userId,
        status: 'pending',
        phase: target.phase,
        carteiraSellerId: coordById.get(cand.customerId)?.sellerId || null,
      }).returning();
      const newAssign = inserted[0];
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: newAssign.id,
        customerId: cand.customerId,
        fromUserId: null,
        toUserId: target.userId,
        action: 'assigned',
        reason: target.phase === 'external' ? 'Distribuicao por perimetro (vendedor externo)' : 'Distribuicao telemarketing',
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
const EXTERNAL_MAX_PER_SELLER = 3;
let __drawRunning = false;
let __lastDrawCheckMs = 0;

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
          const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q);
          const resp = await fetch(url, { headers: { 'User-Agent': 'INTEGRA2.0-repescagem-geo/1.0 (flaviobaylao@gmail.com)' } });
          const arr: any = resp.ok ? await resp.json() : [];
          const cand = Array.isArray(arr) && arr.length ? arr[0] : null;
          if (cand) {
            if (attempts[ai].level === 'endereco' && cep.length === 8) {
              const dc = ((String(cand.display_name).match(/\b\d{5}-?\d{3}\b/) || [''])[0]).replace(/\D/g, '');
              if (dc && dc.slice(0, 5) !== cep.slice(0, 5)) { if (ai < attempts.length - 1) await new Promise(rs => setTimeout(rs, 1100)); continue; }
            }
            hit = cand; break;
          }
          if (ai < attempts.length - 1) await new Promise(rs => setTimeout(rs, 1100));
        }
        if (hit) {
          const cityToken = norm(c.city).split(' ')[0] || '';
          const cityOk = !!cityToken && norm(hit.display_name).includes(cityToken);
          if (cityOk) { await db.execute(sql`UPDATE customers SET latitude = ${String(hit.lat)}, longitude = ${String(hit.lon)}, updated_at = now() WHERE id = ${c.id}`); done++; }
        }
      } catch { /* ignora cliente individual */ }
      await new Promise(rs => setTimeout(rs, 1200));
    }
    if (done) console.log(`[REPESCAGEM2-GEO] geocodificados ${done} candidato(s) sem coordenada`);
  } catch (e: any) { console.warn('[REPESCAGEM2-GEO] falha:', e?.message); }
  finally { __geoRepRunning = false; }
}

async function runDailyDraw(opts: { drawDate: string; force?: boolean }): Promise<any> {
  const drawDate = opts.drawDate;

  // Idempotência: se o dia já foi sorteado, não refaz (a menos que force).
  const existing = await db.select({ id: repescagemAssignments.id })
    .from(repescagemAssignments)
    .where(and(eq(repescagemAssignments.drawDate, drawDate), isNotNull(repescagemAssignments.phase)));
  if (existing.length > 0 && !opts.force) {
    return { skipped: true, reason: 'dia já sorteado', drawDate, existing: existing.length };
  }
  if (existing.length > 0 && opts.force) {
    // Refaz apenas o que ainda não foi atendido (não apaga 'completed').
    await db.delete(repescagemAssignments).where(and(
      eq(repescagemAssignments.drawDate, drawDate),
      isNotNull(repescagemAssignments.phase),
      inArray(repescagemAssignments.status, ['in_route', 'returned', 'pending'] as any),
    ));
  }

  // Atendentes habilitados, separados por função.
  const enabled = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.isEnabled, true));
  const enabledIds = enabled.map(a => a.userId).filter(id => !REPESCAGEM_EXCLUDED_USER_IDS.has(id));
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
    const load = new Map<string, number>(telemarketers.map(id => [id, 0]));
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

// ============================================================================
// Repescagem2 — Fase 4: fechamento e devolução
// "Atendido = tem registro de atendimento OU pedido no dia" → conclui a
// alocação (status 'completed'), atribuindo a venda/atendimento a QUEM ATENDEU.
// As alocações 'in_route' de dias anteriores que não foram atendidas expiram
// (status 'returned') e o cliente volta ao bolo p/ o sorteio do dia seguinte.
// ============================================================================
let __closeRunning = false;
let __lastCloseCheckMs = 0;

async function closeAndExpireRepescagem(date: string): Promise<any> {
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
      WHERE DATE(attendance_date) = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of vlogs.rows as any[]) mark(r.customer_id, r.attendant_id);

    // Registro de atendimento (presencial): check-in de rota.
    const cps = await db.execute(sql`
      SELECT customer_id, seller_id FROM route_checkpoints
      WHERE checkpoint_type = 'check_in' AND DATE(checkpoint_time) = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of cps.rows as any[]) mark(r.customer_id, r.seller_id);

    // Pedido: billing_pipeline no dia.
    const orders = await db.execute(sql`
      SELECT customer_id FROM billing_pipeline
      WHERE DATE(COALESCE(scheduled_billing_date::timestamp, created_at)) = ${date}::date
        AND customer_id = ANY(string_to_array(${arr}, ','))`);
    for (const r of orders.rows as any[]) mark(r.customer_id, null);

    for (const a of inRoute) {
      if (!attendedBy.has(a.customerId)) continue;
      const by = attendedBy.get(a.customerId) || a.assignedUserId; // venda de quem atendeu
      await db.update(repescagemAssignments).set({
        status: 'completed', completedAt: new Date(), completedByUserId: by, updatedAt: new Date(),
      }).where(eq(repescagemAssignments.id, a.id));
      await db.insert(repescagemAssignmentHistory).values({
        assignmentId: a.id, customerId: a.customerId, fromUserId: a.assignedUserId, toUserId: by,
        action: 'completed', reason: 'Atendido (registro de atendimento ou pedido)',
      });
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

  // Correção de drift (15/jul/2026): a tabela em produção ficou sem o DEFAULT gen_random_uuid()
  // na coluna id, então os INSERTs do sorteio (runDailyDraw) falhavam com "null value in column id"
  // — e o erro era engolido pelo maybeAutoDraw, deixando a repescagem nunca entrar nas rotas.
  // Restaura o default (idempotente) no boot.
  (async () => {
    try {
      await db.execute(sql.raw("ALTER TABLE repescagem_assignments ALTER COLUMN id SET DEFAULT gen_random_uuid()"));
      await db.execute(sql.raw("ALTER TABLE repescagem_assignment_history ALTER COLUMN id SET DEFAULT gen_random_uuid()"));
    } catch (e: any) { console.warn('[REPESCAGEM2] ALTER id default:', e?.message); }
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

      // Garante que o sorteio do dia já rodou (antes só disparava ao abrir a página de Repescagem).
      // Sem isto, se ninguém abrisse a página de Repescagem, a rota do dia não recebia repescagem.
      maybeAutoDraw();
      // Fecha os atendidos do dia (throttled) para que saiam da lista de cards.
      maybeAutoCloseRepescagem();

      const rows = await db.select().from(repescagemAssignments).where(and(
        eq(repescagemAssignments.assignedUserId, sellerId),
        eq(repescagemAssignments.drawDate, date),
        eq(repescagemAssignments.status, 'in_route'),
      ));
      if (rows.length === 0) return res.json([]);
      const cids = Array.from(new Set(rows.map(r => r.customerId)));
      const cs = await db.select({
        id: customers.id,
        name: sql<string>`COALESCE(${customers.fantasyName}, ${customers.name})`,
        phone: customers.phone, city: customers.city, uf: customers.state,
        address: customers.address, weekdays: customers.weekdays,
        visitPeriodicity: customers.visitPeriodicity,
        virtualService: customers.virtualService,
        latitude: customers.latitude, longitude: customers.longitude,
      }).from(customers).where(inArray(customers.id, cids));
      const byId = new Map(cs.map(c => [c.id, c]));

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
          address: c?.address || null, weekdays: (c?.weekdays as any) || [],
          latitude: c?.latitude ?? null, longitude: c?.longitude ?? null,
          visitPeriodicity: per,
          repescagemCount: countReds(r.customerId, per),
          repescagemWindowMonths: per === 'mensal' ? 3 : 2,
          phase: r.phase, isVirtualClient: !!c?.virtualService,
        };
      }));
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

  // Listar atendentes (habilitados + perfil disponíveis para se habilitarem)
  app.get('/api/repescagem/attendants', authenticateUser, requireRole(ALLOWED_ROLES), async (_req, res) => {
    try {
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
      const out = eligible
        .filter(u => !REPESCAGEM_EXCLUDED_USER_IDS.has(u.id))
        .map(u => {
          const a = map.get(u.id);
          return {
            userId: u.id,
            name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id,
            role: u.role, // 'vendedor' (externo) | 'telemarketing' (interno)
            isEnabled: a?.isEnabled || false,
            enabledAt: a?.enabledAt || null,
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      res.json(out);
    } catch (e: any) {
      console.error('GET /api/repescagem/attendants', e);
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
      if (REPESCAGEM_EXCLUDED_USER_IDS.has(userId) || !REPESCAGEM_ELIGIBLE_ROLES.includes(t.role as any) || !t.isActive) {
        return res.status(400).json({ message: 'Usuário não elegível para a repescagem' });
      }
      const existing = await db.select().from(repescagemAttendants).where(eq(repescagemAttendants.userId, userId));
      if (existing.length === 0) {
        // id explícito: a coluna no banco pode não ter DEFAULT gen_random_uuid(),
        // então geramos o UUID no próprio INSERT para não violar o NOT NULL.
        await db.insert(repescagemAttendants).values({
          id: sql`gen_random_uuid()`,
          userId,
          isEnabled: !!isEnabled,
          enabledAt: isEnabled ? new Date() : null,
          disabledAt: !isEnabled ? new Date() : null,
        });
      } else {
        await db.update(repescagemAttendants).set({
          isEnabled: !!isEnabled,
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
      // Reconciliar primeiro
      await reconcileAssignments((req as any).currentUser?.id);

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
      const assignedCustomerIds = new Set(pending.map(p => p.customerId));
      const result = pending.map(p => {
        const c = customerById.get(p.customerId);
        const days = Math.floor((new Date(today).getTime() - new Date(p.lastRedDate).getTime()) / 86400000);
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
          });
        }
      }

      result.sort((a, b) => b.lastRedDate.localeCompare(a.lastRedDate));

      res.json(result);
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


// Exportado para o agendador (scheduler.ts): roda a distribuicao/sorteio da repescagem
// para uma data especifica (ex.: o dia seguinte), programando a rota daquele dia.
export async function runRepescagemDrawForDate(drawDate: string, opts?: { force?: boolean }): Promise<any> {
  return runDailyDraw({ drawDate, force: opts?.force ?? true });
}
