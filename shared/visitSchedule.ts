/**
 * Módulo compartilhado para cálculo de agendamento de visitas
 * Centraliza a lógica de cálculo da próxima visita baseada em:
 * - Dias da semana do cliente (weekdays)
 * - Periodicidade de visita (visitPeriodicity)
 * - Data da última visita completada
 */

export type VisitPeriodicity = 'semanal' | 'quinzenal' | 'mensal';
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
    'sexta-feira': 5
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
  mensal: 28
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
 * Suporta múltiplos dias da semana - escolhe o dia mais próximo disponível
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

  // Garantir que baseDate tenha horas zeradas
  const baseDate = referenceDate ? new Date(referenceDate) : new Date();
  baseDate.setHours(0, 0, 0, 0); // CORRIGIDO: Zerar horas para comparação consistente
  
  const intervalDays = PERIODICITY_DAYS[periodicity];

  // MENSAL = 1ª ocorrência do DIA DE ROTA no mês (base de calendário), NÃO "+28 dias".
  // Ex.: dia de rota terça → sempre a 1ª terça de cada mês (07/07 → 04/08 → 01/09 → 06/10).
  if (periodicity === 'mensal') {
    if (!lastCompletedDate) {
      // Sem última visita: 1º dia-alvo do mês de referência; se já passou, do mês seguinte.
      let cand = firstTargetWeekdayOfMonth(baseDate.getFullYear(), baseDate.getMonth(), targetWeekdays);
      if (!cand || cand < baseDate) {
        const y = baseDate.getMonth() === 11 ? baseDate.getFullYear() + 1 : baseDate.getFullYear();
        const m = baseDate.getMonth() === 11 ? 0 : baseDate.getMonth() + 1;
        cand = firstTargetWeekdayOfMonth(y, m, targetWeekdays);
      }
      cand.setHours(8, 0, 0, 0);
      return { nextDate: cand, interval: intervalDays, reason: 'next_weekday' };
    }
    // Com última visita: 1º dia-alvo do mês SEGUINTE ao da última visita.
    const last = new Date(lastCompletedDate);
    const y = last.getMonth() === 11 ? last.getFullYear() + 1 : last.getFullYear();
    const m = last.getMonth() === 11 ? 0 : last.getMonth() + 1;
    const next = firstTargetWeekdayOfMonth(y, m, targetWeekdays);
    next.setHours(8, 0, 0, 0);
    return { nextDate: next, interval: intervalDays, reason: 'periodicity_applied' };
  }

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
 * Retorna a 1ª ocorrência (mais cedo no mês) de qualquer dia-alvo da semana.
 * Usado para periodicidade MENSAL (ex.: 1ª terça do mês).
 */
function firstTargetWeekdayOfMonth(year: number, month: number, targetWeekdays: number[]): Date {
  let best: Date | null = null;
  for (let day = 1; day <= 7; day++) {
    const d = new Date(year, month, day);
    if (targetWeekdays.includes(d.getDay())) {
      if (!best || d < best) best = d;
    }
  }
  return best || new Date(year, month, 1);
}

/**
 * Encontra o próximo dia válido da semana a partir de uma data base
 * Permite incluir o dia atual se for um dia válido
 */
function findNextWeekday(baseDate: Date, targetWeekdays: number[]): Date {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
  const baseDateDayOfWeek = baseDate.getDay();
  
  // 🔍 DEBUG: Mostrar informações de entrada
  const isDebug = false; // Set to true para debug
  if (isDebug) {
    console.log(`[findNextWeekday] baseDate: ${baseDate.toISOString()}, dayOfWeek: ${baseDateDayOfWeek} (${days[baseDateDayOfWeek]}), targetWeekdays: ${targetWeekdays.map(d => days[d]).join(',')}`);
  }
  
  // Verificar se o dia atual já é válido
  if (targetWeekdays.includes(baseDateDayOfWeek)) {
    const result = new Date(baseDate);
    result.setHours(8, 0, 0, 0);
    if (isDebug) console.log(`[findNextWeekday] ✅ Dia atual é válido: ${days[result.getDay()]}`);
    return result;
  }

  // Procurar nos próximos 7 dias
  for (let i = 1; i <= 7; i++) {
    const testDate = new Date(baseDate);
    testDate.setDate(baseDate.getDate() + i);
    const testDayOfWeek = testDate.getDay();
    
    if (isDebug) {
      console.log(`  [+${i}] testDate: ${testDate.toISOString()}, dayOfWeek: ${testDayOfWeek} (${days[testDayOfWeek]}), isValid: ${targetWeekdays.includes(testDayOfWeek)}`);
    }
    
    if (targetWeekdays.includes(testDayOfWeek)) {
      testDate.setHours(8, 0, 0, 0);
      if (isDebug) console.log(`[findNextWeekday] ✅ Encontrado: ${days[testDate.getDay()]} em +${i} dias`);
      return testDate;
    }
  }

  // Fallback: se não encontrar em 7 dias, nunca deveria chegar aqui
  // mas colocar um console.error para detectar se isso acontecer
  console.error(`[findNextWeekday] ⚠️ NUNCA DEVERIA CHEGAR AQUI - Não encontrou nenhum dia válido em 7 dias!`);
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
 * Aceita múltiplos dias configurados - valida se a data está em qualquer um deles
 */
export function isValidScheduledDate(
  scheduledDate: Date, 
  weekdays: (Weekday | WeekdayAbbr | string)[]
): boolean {
  const targetWeekdays = weekdays
    .map(day => normalizeWeekday(day as string))
    .filter((num): num is number => num !== null);
  
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
