import { db } from './db';
import { visitScheduleHistory, customers, type InsertVisitScheduleHistory, type Customer } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';

/**
 * Mapeia dias da semana para números (0 = domingo, 6 = sábado)
 * Inclui todos os formatos possíveis: abreviado, completo com maiúscula/minúscula
 */
const WEEKDAY_MAP: Record<string, number> = {
  // Domingo
  'Dom': 0,
  'Domingo': 0,
  'domingo': 0,
  // Segunda
  'Seg': 1,
  'Segunda': 1,
  'segunda': 1,
  'segunda-feira': 1,
  // Terça
  'Ter': 2,
  'Terça': 2,
  'Terca': 2,
  'terça': 2,
  'terca': 2,
  'terca-feira': 2,
  'terça-feira': 2,
  // Quarta
  'Qua': 3,
  'Quarta': 3,
  'quarta': 3,
  'quarta-feira': 3,
  // Quinta
  'Qui': 4,
  'Quinta': 4,
  'quinta': 4,
  'quinta-feira': 4,
  // Sexta
  'Sex': 5,
  'Sexta': 5,
  'sexta': 5,
  'sexta-feira': 5,
  // Sábado
  'Sab': 6,
  'Sábado': 6,
  'Sabado': 6,
  'sábado': 6,
  'sabado': 6,
};

/**
 * Calcula o número da semana desde uma data de referência específica
 */
function getWeeksSinceReference(targetDate: Date, referenceDate: Date): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const diff = targetDate.getTime() - referenceDate.getTime();
  return Math.floor(diff / msPerWeek);
}

/**
 * Verifica se o cliente deve ser visitado nesta data baseado na periodicidade
 * 
 * NOVA LÓGICA:
 * - Semanal: Toda semana no dia configurado
 * - Quinzenal (bi-semanal): Semana SIM, semana NÃO (alternado desde serviceStartDate)
 * - Mensal (quadrisemanal): 1 semana SIM, 3 semanas NÃO (desde serviceStartDate)
 * - Bimestral: A cada 8 semanas (desde serviceStartDate)
 * 
 * Independente de check-in - o calendário não muda se o vendedor não visitou
 * 
 * @param periodicity - Periodicidade do cliente
 * @param targetDate - Data a verificar
 * @param customerWeekdays - Dias da semana configurados (ex: ["Qui", "Sex"])
 * @param serviceStartDate - Data de início do serviço (referência para cálculo)
 */
export function shouldVisitOnDate(
  periodicity: 'semanal' | 'quinzenal' | 'mensal' | 'bimestral',
  targetDate: Date,
  customerWeekdays: string[],
  serviceStartDate: Date | null
): boolean {
  // Verificar se a data cai em um dos dias configurados do cliente
  const targetDayOfWeek = targetDate.getDay();
  const customerDayNumbers = customerWeekdays
    .map(day => WEEKDAY_MAP[day])
    .filter(num => num !== undefined);
  
  if (!customerDayNumbers.includes(targetDayOfWeek)) {
    return false; // Não é um dia configurado para este cliente
  }

  // Para semanal, visita toda semana
  if (periodicity === 'semanal') {
    return true;
  }

  // Se não tem data de início, usa a primeira quinta-feira de 2025 como referência
  const referenceDate = serviceStartDate || new Date('2025-01-02'); // Quinta-feira
  
  // Normalizar datas (remover horas)
  const normalizedTarget = new Date(targetDate);
  normalizedTarget.setHours(0, 0, 0, 0);
  const normalizedReference = new Date(referenceDate);
  normalizedReference.setHours(0, 0, 0, 0);

  // Calcular número da semana desde a data de início do serviço
  const weekNumber = getWeeksSinceReference(normalizedTarget, normalizedReference);

  // Se a data alvo é antes do início do serviço, não visitar
  if (weekNumber < 0) {
    return false;
  }

  switch (periodicity) {
    case 'quinzenal':
      // Bi-semanal: semana PAR = visita, semana ÍMPAR = não visita
      return weekNumber % 2 === 0;
    
    case 'mensal':
      // Quadrisemanal: a cada 4 semanas
      return weekNumber % 4 === 0;
    
    case 'bimestral':
      // A cada 8 semanas
      return weekNumber % 8 === 0;
    
    default:
      return true;
  }
}

/**
 * Gera registros de visitas futuras para um cliente
 * 
 * @param customerId - ID do cliente
 * @param daysAhead - Quantos dias no futuro gerar (padrão: 60)
 */
export async function generateFutureVisitsForCustomer(
  customerId: string,
  daysAhead: number = 60
): Promise<number> {
  // Buscar dados do cliente
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId)
  });
  
  if (!customer || !customer.isActive) {
    return 0; // Cliente não encontrado ou inativo
  }

  if (customer.virtualService) {
    return 0; // Clientes virtuais não têm visitas agendadas
  }

  // Parse dos dias da semana
  const weekdays = JSON.parse(customer.weekdays || '[]') as string[];
  if (weekdays.length === 0) {
    return 0; // Cliente sem dias configurados
  }

  const periodicity = customer.visitPeriodicity || 'semanal';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + daysAhead);

  const visitsToCreate: InsertVisitScheduleHistory[] = [];
  
  // Iterar sobre cada dia no período
  for (let date = new Date(today); date <= endDate; date.setDate(date.getDate() + 1)) {
    const currentDate = new Date(date);
    const dayOfWeek = currentDate.getDay();
    
    // Verificar se é um dos dias configurados do cliente
    const weekdayName = Object.keys(WEEKDAY_MAP).find(
      key => WEEKDAY_MAP[key] === dayOfWeek && key.length === 3 // Pegar formato abreviado
    ) || 'Dom';

    if (shouldVisitOnDate(periodicity, currentDate, weekdays, customer.serviceStartDate)) {
      // Verificar se já existe um registro para esta data
      const existingVisit = await db.query.visitScheduleHistory.findFirst({
        where: (vsh, { and, eq }) => and(
          eq(vsh.customerId, customerId),
          eq(vsh.scheduledDate, currentDate.toISOString().split('T')[0])
        )
      });

      if (!existingVisit) {
        visitsToCreate.push({
          customerId: customer.id,
          sellerId: customer.sellerId,
          scheduledDate: currentDate.toISOString().split('T')[0],
          weekday: weekdayName,
          periodicity,
          visitStatus: 'scheduled',
          customerName: customer.fantasyName || customer.name,
          customerAddress: customer.address,
        });
      }
    }
  }

  // Inserir todas as visitas de uma vez
  if (visitsToCreate.length > 0) {
    await db.insert(visitScheduleHistory).values(visitsToCreate);
  }

  return visitsToCreate.length;
}

/**
 * Gera visitas futuras para todos os clientes ativos
 */
export async function generateFutureVisitsForAllCustomers(
  daysAhead: number = 60
): Promise<{ total: number; byCustomer: Record<string, number> }> {
  const allCustomers = await db.query.customers.findMany();
  const activeCustomers = allCustomers.filter(c => c.isActive && !c.virtualService);
  
  const byCustomer: Record<string, number> = {};
  let total = 0;

  for (const customer of activeCustomers) {
    const count = await generateFutureVisitsForCustomer(customer.id, daysAhead);
    byCustomer[customer.id] = count;
    total += count;
  }

  return { total, byCustomer };
}

/**
 * Marca uma visita como completada (quando há check-in)
 */
export async function markVisitAsCompleted(
  customerId: string,
  visitDate: string,
  checkInTime: Date,
  checkInLatitude: string,
  checkInLongitude: string,
  routeCheckpointId?: string
): Promise<void> {
  await db
    .update(visitScheduleHistory)
    .set({
      visitStatus: 'completed',
      checkInTime,
      checkInLatitude,
      checkInLongitude,
      routeCheckpointId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(visitScheduleHistory.customerId, customerId),
        eq(visitScheduleHistory.scheduledDate, visitDate)
      )
    );
}

/**
 * Marca visitas passadas como "missed" se não foram completadas
 */
export async function markMissedVisits(): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const result = await db
    .update(visitScheduleHistory)
    .set({
      visitStatus: 'missed',
      updatedAt: new Date(),
    })
    .where(
      and(
        sql`scheduled_date < ${todayStr}`,
        eq(visitScheduleHistory.visitStatus, 'scheduled')
      )
    );

  return result.rowCount || 0;
}
