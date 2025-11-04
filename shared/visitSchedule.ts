/**
 * Módulo compartilhado para cálculo de agendamento de visitas
 * Centraliza a lógica de cálculo da próxima visita baseada em:
 * - Dias da semana do cliente (weekdays)
 * - Periodicidade de visita (visitPeriodicity)
 * - Data da última visita completada
 */

export type VisitPeriodicity = 'semanal' | 'quinzenal' | 'mensal' | 'bimestral';
export type Weekday = 'domingo' | 'segunda' | 'terca' | 'quarta' | 'quinta' | 'sexta' | 'sabado';
export type WeekdayAbbr = 'Dom' | 'Seg' | 'Ter' | 'Qua' | 'Qui' | 'Sex' | 'Sab';

const WEEKDAY_MAP: { [key in Weekday]: number } = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6
};

const WEEKDAY_ABBR_MAP: { [key in WeekdayAbbr]: number } = {
  Dom: 0,
  Seg: 1,
  Ter: 2,
  Qua: 3,
  Qui: 4,
  Sex: 5,
  Sab: 6
};

/**
 * Normaliza dias da semana de qualquer formato para o número do dia
 * Aceita formatos completos (domingo, segunda, terca) e abreviados (Dom, Seg, Ter)
 */
function normalizeWeekday(day: string): number | null {
  // Formato abreviado
  if (day in WEEKDAY_ABBR_MAP) {
    return WEEKDAY_ABBR_MAP[day as WeekdayAbbr];
  }
  
  // Formato completo
  if (day in WEEKDAY_MAP) {
    return WEEKDAY_MAP[day as Weekday];
  }
  
  // Formatos alternativos com acento ou hífen
  const alternativeMap: { [key: string]: number } = {
    'terça': 2,
    'sábado': 6,
    'segunda-feira': 1,
    'terça-feira': 2,
    'quarta-feira': 3,
    'quinta-feira': 4,
    'sexta-feira': 5,
    'sábado': 6
  };
  
  if (day in alternativeMap) {
    return alternativeMap[day];
  }
  
  console.warn(`⚠️ Dia da semana não reconhecido: "${day}"`);
  return null;
}

const PERIODICITY_DAYS: { [key in VisitPeriodicity]: number } = {
  semanal: 7,
  quinzenal: 14,
  mensal: 30,
  bimestral: 60
};

export interface ScheduleInput {
  weekdays: (Weekday | WeekdayAbbr | string)[];
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
 * 
 * REGRA ESPECIAL: Clientes com MÚLTIPLOS dias configurados devem ser alocados para DOMINGO
 */
export function calculateNextVisitDate(input: ScheduleInput): ScheduleResult {
  const { weekdays, periodicity, lastCompletedDate, referenceDate } = input;

  if (!weekdays || weekdays.length === 0) {
    throw new Error('Cliente deve ter pelo menos um dia da semana configurado');
  }

  const targetWeekdays = weekdays
    .map(day => normalizeWeekday(day as string))
    .filter((num): num is number => num !== null);
  
  if (targetWeekdays.length === 0) {
    throw new Error('Nenhum dia da semana válido encontrado');
  }

  // ⚠️ REGRA ESPECIAL: Clientes com múltiplos dias devem ser alocados para Domingo
  const finalTargetWeekdays = targetWeekdays.length > 1 ? [0] : targetWeekdays; // 0 = Domingo

  const baseDate = referenceDate || new Date();
  const intervalDays = PERIODICITY_DAYS[periodicity];

  // Se não há última visita, encontrar o próximo dia válido da semana
  if (!lastCompletedDate) {
    const nextDate = findNextWeekday(baseDate, finalTargetWeekdays);
    return {
      nextDate,
      interval: intervalDays,
      reason: targetWeekdays.length > 1 ? 'override' : 'next_weekday'
    };
  }

  // Calcular data alvo baseada na periodicidade
  const targetDate = new Date(lastCompletedDate);
  targetDate.setDate(targetDate.getDate() + intervalDays);

  // Ajustar para o dia da semana mais próximo
  const adjustedDate = findNearestWeekday(targetDate, finalTargetWeekdays);

  return {
    nextDate: adjustedDate,
    interval: intervalDays,
    reason: targetWeekdays.length > 1 ? 'override' : 'periodicity_applied'
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
 * Encontra o próximo dia da semana válido a partir de uma data alvo
 * IMPORTANTE: Procura APENAS para frente (nunca para trás) para garantir que
 * a próxima visita sempre respeite a periodicidade configurada
 */
function findNearestWeekday(targetDate: Date, targetWeekdays: number[]): Date {
  // Se a data alvo já é um dia válido, usar ela
  if (targetWeekdays.includes(targetDate.getDay())) {
    const result = new Date(targetDate);
    result.setHours(8, 0, 0, 0);
    return result;
  }

  // Procurar APENAS para frente até 7 dias
  for (let i = 1; i <= 7; i++) {
    const testDate = new Date(targetDate);
    testDate.setDate(targetDate.getDate() + i);
    
    if (targetWeekdays.includes(testDate.getDay())) {
      testDate.setHours(8, 0, 0, 0);
      return testDate;
    }
  }

  // Fallback: se não encontrar em 7 dias, usar o primeiro dia válido da próxima semana
  const fallbackDate = new Date(targetDate);
  fallbackDate.setDate(targetDate.getDate() + 7);
  fallbackDate.setHours(8, 0, 0, 0);
  return fallbackDate;
}

/**
 * Valida se uma data agendada está alinhada com os dias da semana do cliente
 * 
 * REGRA ESPECIAL: Clientes com MÚLTIPLOS dias configurados devem ter visitas em DOMINGO
 */
export function isValidScheduledDate(
  scheduledDate: Date, 
  weekdays: (Weekday | WeekdayAbbr | string)[]
): boolean {
  const targetWeekdays = weekdays
    .map(day => normalizeWeekday(day as string))
    .filter((num): num is number => num !== null);
  
  // ⚠️ REGRA ESPECIAL: Clientes com múltiplos dias devem estar em Domingo
  if (targetWeekdays.length > 1) {
    return scheduledDate.getDay() === 0; // 0 = Domingo
  }
  
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
