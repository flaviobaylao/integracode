/**
 * Módulo compartilhado para cálculo de agendamento de visitas
 * Centraliza a lógica de cálculo da próxima visita baseada em:
 * - Dias da semana do cliente (weekdays)
 * - Periodicidade de visita (visitPeriodicity)
 * - Data da última visita completada
 */

export type VisitPeriodicity = 'semanal' | 'quinzenal' | 'mensal' | 'bimestral';
export type Weekday = 'domingo' | 'segunda' | 'terca' | 'quarta' | 'quinta' | 'sexta' | 'sabado';

const WEEKDAY_MAP: { [key in Weekday]: number } = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6
};

const PERIODICITY_DAYS: { [key in VisitPeriodicity]: number } = {
  semanal: 7,
  quinzenal: 14,
  mensal: 30,
  bimestral: 60
};

export interface ScheduleInput {
  weekdays: Weekday[];
  periodicity: VisitPeriodicity;
  lastCompletedDate?: Date;
  referenceDate?: Date;
}

export interface ScheduleResult {
  nextDate: Date;
  interval: number;
  reason: 'next_weekday' | 'periodicity_applied' | 'override';
}

/**
 * Calcula a próxima data de visita baseada nas configurações do cliente
 */
export function calculateNextVisitDate(input: ScheduleInput): ScheduleResult {
  const { weekdays, periodicity, lastCompletedDate, referenceDate } = input;

  if (!weekdays || weekdays.length === 0) {
    throw new Error('Cliente deve ter pelo menos um dia da semana configurado');
  }

  const targetWeekdays = weekdays.map(day => WEEKDAY_MAP[day]);
  const baseDate = referenceDate || new Date();
  const intervalDays = PERIODICITY_DAYS[periodicity];

  // Se não há última visita, encontrar o próximo dia válido da semana
  if (!lastCompletedDate) {
    const nextDate = findNextWeekday(baseDate, targetWeekdays);
    return {
      nextDate,
      interval: intervalDays,
      reason: 'next_weekday'
    };
  }

  // Calcular data alvo baseada na periodicidade
  const targetDate = new Date(lastCompletedDate);
  targetDate.setDate(targetDate.getDate() + intervalDays);

  // Ajustar para o dia da semana mais próximo
  const adjustedDate = findNearestWeekday(targetDate, targetWeekdays);

  return {
    nextDate: adjustedDate,
    interval: intervalDays,
    reason: 'periodicity_applied'
  };
}

/**
 * Encontra o próximo dia válido da semana a partir de uma data base
 * Permite incluir o dia atual se for um dia válido
 */
function findNextWeekday(baseDate: Date, targetWeekdays: number[]): Date {
  // Verificar se o dia atual já é válido
  if (targetWeekdays.includes(baseDate.getDay())) {
    const result = new Date(baseDate);
    result.setHours(8, 0, 0, 0);
    return result;
  }

  // Procurar nos próximos 7 dias
  for (let i = 1; i <= 7; i++) {
    const testDate = new Date(baseDate);
    testDate.setDate(baseDate.getDate() + i);
    
    if (targetWeekdays.includes(testDate.getDay())) {
      testDate.setHours(8, 0, 0, 0);
      return testDate;
    }
  }

  // Fallback: se não encontrar, usar o primeiro dia válido
  const nextDate = new Date(baseDate);
  nextDate.setDate(baseDate.getDate() + 1);
  nextDate.setHours(8, 0, 0, 0);
  return nextDate;
}

/**
 * Encontra o dia da semana mais próximo de uma data alvo
 * Prioriza dias futuros, mas ajusta para o weekday válido mais próximo
 */
function findNearestWeekday(targetDate: Date, targetWeekdays: number[]): Date {
  // Se a data alvo já é um dia válido, usar ela
  if (targetWeekdays.includes(targetDate.getDay())) {
    const result = new Date(targetDate);
    result.setHours(8, 0, 0, 0);
    return result;
  }

  // Procurar para frente até 7 dias
  for (let i = 1; i <= 7; i++) {
    const testDate = new Date(targetDate);
    testDate.setDate(targetDate.getDate() + i);
    
    if (targetWeekdays.includes(testDate.getDay())) {
      testDate.setHours(8, 0, 0, 0);
      return testDate;
    }
  }

  // Fallback
  const result = new Date(targetDate);
  result.setHours(8, 0, 0, 0);
  return result;
}

/**
 * Valida se uma data agendada está alinhada com os dias da semana do cliente
 */
export function isValidScheduledDate(
  scheduledDate: Date, 
  weekdays: Weekday[]
): boolean {
  const targetWeekdays = weekdays.map(day => WEEKDAY_MAP[day]);
  return targetWeekdays.includes(scheduledDate.getDay());
}

/**
 * Calcula a próxima data considerando um agendamento manual/override
 */
export function getNextVisitWithOverride(
  input: ScheduleInput,
  overrideDate?: Date
): Date {
  if (overrideDate) {
    return overrideDate;
  }

  const result = calculateNextVisitDate(input);
  return result.nextDate;
}
