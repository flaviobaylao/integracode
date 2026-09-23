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
  /**
   * Data de início do fornecimento (customers.service_start_date). Quando presente,
   * a periodicidade é ANCORADA nesta data: nenhuma visita é agendada antes dela e,
   * se não houver "última visita" posterior ao início, o ciclo recomeça a partir dela.
   */
  serviceStartDate?: Date;
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

  const rawTargetWeekdays = weekdays
    .map(day => normalizeWeekday(day as string))
    .filter((num): num is number => num !== null);

  if (rawTargetWeekdays.length === 0) {
    throw new Error('Nenhum dia da semana válido encontrado');
  }

  // 🗓️ REGRA DE DIAS ÚTEIS (seg–sex): agendamentos NUNCA caem em sábado (6) ou
  // domingo (0). Remove o fim de semana dos dias-alvo; se o cliente estiver
  // configurado SOMENTE em fim de semana, reprograma para qualquer dia útil
  // (seg–sex), mantendo a periodicidade. Todo o cálculo abaixo escolhe datas
  // apenas dentro de targetWeekdays, então nenhuma data de fim de semana é gerada.
  let targetWeekdays = rawTargetWeekdays.filter(n => n !== 0 && n !== 6);
  if (targetWeekdays.length === 0) {
    targetWeekdays = [1, 2, 3, 4, 5];
  }

  // Garantir que baseDate tenha horas zeradas
  let baseDate = referenceDate ? new Date(referenceDate) : new Date();
  baseDate.setHours(0, 0, 0, 0); // CORRIGIDO: Zerar horas para comparação consistente

  const intervalDays = PERIODICITY_DAYS[periodicity];

  // ÂNCORA DE INÍCIO DO FORNECIMENTO: quando o cliente tem data de início registrada,
  // a periodicidade começa a partir dela — nunca antes. A base mínima passa a ser essa
  // data e uma "última visita" anterior ao início é ignorada (o ciclo recomeça no início).
  const startAnchor = input.serviceStartDate ? new Date(input.serviceStartDate) : null;
  if (startAnchor) startAnchor.setHours(0, 0, 0, 0);
  let baseMovedToStart = false;
  if (startAnchor && startAnchor.getTime() > baseDate.getTime()) {
    baseDate = new Date(startAnchor);
    baseMovedToStart = true; // início FUTURO do fornecimento — a 1ª visita parte da data de início
  }
  let effectiveLast = lastCompletedDate;
  if (startAnchor && effectiveLast) {
    const el = new Date(effectiveLast); el.setHours(0, 0, 0, 0);
    if (el.getTime() < startAnchor.getTime()) effectiveLast = undefined;
  }

  // MENSAL = 1ª ocorrência do DIA DE ROTA no mês (base de calendário), NÃO "+28 dias".
  // Ex.: dia de rota terça → sempre a 1ª terça de cada mês (07/07 → 04/08 → 01/09 → 06/10).
  if (periodicity === 'mensal') {
    if (!effectiveLast) {
      // 🗓️ INÍCIO FUTURO DO FORNECIMENTO: a 1ª visita é a 1ª ocorrência do DIA DE ROTA a partir da
      // data de início — NÃO pula o mês do início. Ex.: início 22/09 (terça) → 1ª visita 22/09
      // (antes ia para 06/10 porque a 1ª terça do mês, 01/09, era anterior ao início). As visitas
      // seguintes continuam na regra mensal (1º dia de rota do mês seguinte).
      if (baseMovedToStart) {
        const firstFromStart = findNextWeekday(baseDate, targetWeekdays);
        firstFromStart.setHours(8, 0, 0, 0);
        return { nextDate: firstFromStart, interval: intervalDays, reason: 'next_weekday' };
      }
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
    const last = new Date(effectiveLast);
    const y = last.getMonth() === 11 ? last.getFullYear() + 1 : last.getFullYear();
    const m = last.getMonth() === 11 ? 0 : last.getMonth() + 1;
    const next = firstTargetWeekdayOfMonth(y, m, targetWeekdays);
    next.setHours(8, 0, 0, 0);
    return { nextDate: next, interval: intervalDays, reason: 'periodicity_applied' };
  }

  // Se não há última visita, encontrar o próximo dia válido da semana
  if (!effectiveLast) {
    // 🔗 FASE QUINZENAL ANCORADA NO INÍCIO DE FORNECIMENTO: para periodicidade com intervalo
    // maior que uma semana (quinzenal), a próxima ocorrência cai EM FASE com a data de início
    // (início, início+14, início+28…), e NÃO no "próximo dia da semana a partir de hoje". Sem
    // isso, clientes virtuais (que nunca têm check-in/visita concluída) eram reprogramados na
    // semana de paridade errada — ex.: comprou 02/09 e 16/09 mas caía em 23/09 em vez de 30/09.
    // (set/2026)
    if (startAnchor && intervalDays > 7 && startAnchor.getTime() <= baseDate.getTime()) {
      let occ = findNextWeekday(new Date(startAnchor), targetWeekdays);
      occ.setHours(0, 0, 0, 0);
      let guard = 0;
      while (occ.getTime() < baseDate.getTime() && guard < 400) {
        const step = new Date(occ);
        step.setDate(step.getDate() + intervalDays);
        occ = findNearestWeekday(step, targetWeekdays);
        occ.setHours(0, 0, 0, 0);
        guard++;
      }
      occ.setHours(8, 0, 0, 0);
      return { nextDate: occ, interval: intervalDays, reason: 'periodicity_applied' };
    }
    const nextDate = findNextWeekday(baseDate, targetWeekdays);
    return {
      nextDate,
      interval: intervalDays,
      reason: 'next_weekday'
    };
  }

  // Calcular data alvo baseada na periodicidade
  const targetDate = new Date(effectiveLast);
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

// ============================================================================
// SEMANA DE ATENDIMENTO  (Grade de Roteiro — 12/set/2026)
//
// O dia da semana sozinho nao consegue dizer "Caldas Novas na ULTIMA terca do
// mes": ele repete o cliente em todas as semanas. A semana de atendimento e' o
// segundo eixo da rota — dia da semana X semana do mes.
//
// REGRA DO QUINZENAL (decidida com o Flavio): 1ª e 3ª ocorrencia, ou 2ª e 4ª.
// Vence a previsibilidade ("sempre a 1ª e a 3ª terca") sobre o intervalo exato:
// na virada de um mes com 5 tercas o intervalo vira 21 dias, 4 vezes por ano.
//
// 'toda' e' o padrao e reproduz exatamente o comportamento anterior.
// NAO existe o valor '4': em 8 dos 12 meses de 2026 a 4ª ocorrencia E' a ultima,
// e dois clientes configurados diferente cairiam no mesmo dia sem ninguem
// entender por que. Para a quarta semana existe um valor so: 'ultima'.
// ============================================================================

export type SemanaAtendimento = "toda" | "1" | "2" | "3" | "4" | "ultima" | "impar" | "par";

export const SEMANAS_ATENDIMENTO: SemanaAtendimento[] = ["toda", "impar", "par", "1", "2", "3", "4", "ultima"];

export const ROTULO_SEMANA: Record<SemanaAtendimento, string> = {
  toda: "Toda semana",
  impar: "1ª e 3ª do mês",
  par: "2ª e 4ª do mês",
  "1": "1ª do mês",
  "2": "2ª do mês",
  "3": "3ª do mês",
  "4": "4ª do mês",
  ultima: "Última do mês",
};

/**
 * Texto de ajuda (tooltip do "i") explicando cada opção de Semana do mês.
 * Centralizado para os módulos mostrarem exatamente a mesma explicação.
 */
export const AJUDA_SEMANA_ATENDIMENTO = [
  "Em qual semana do mês o cliente é visitado (além do dia da rota e da periodicidade).",
  "A semana é contada pela segunda-feira: a semana pertence ao mês da segunda-feira dela.",
  "",
  "• Toda semana: em todas as semanas (só o dia da rota + periodicidade).",
  "• 1ª e 3ª do mês: visita na 1ª e na 3ª semana.",
  "• 2ª e 4ª do mês: visita na 2ª e na 4ª semana.",
  "• 1ª do mês: só na 1ª semana.",
  "• 2ª do mês: só na 2ª semana.",
  "• 3ª do mês: só na 3ª semana.",
  "• 4ª do mês: só na 4ª semana (em meses com 5 semanas é diferente da última).",
  "• Última do mês: sempre na última semana (4ª ou 5ª, conforme o mês).",
].join("\n");

/** Normaliza o que veio do banco. Qualquer coisa fora da lista vira 'toda'. */
export function normalizarSemana(v: any): SemanaAtendimento {
  const s = String(v ?? "").trim().toLowerCase();
  return (SEMANAS_ATENDIMENTO as string[]).includes(s) ? (s as SemanaAtendimento) : "toda";
}

/** Quais semanas do mes a regra seleciona. [] = todas. */
export function ocorrenciasDaSemana(semana: SemanaAtendimento): (number | "ultima")[] {
  switch (semana) {
    case "impar": return [1, 3];
    case "par": return [2, 4];
    case "1": return [1];
    case "2": return [2];
    case "3": return [3];
    case "4": return [4];
    case "ultima": return ["ultima"];
    default: return [];
  }
}

/**
 * As SEGUNDAS-FEIRAS de um mes, em ordem. Cada segunda abre uma semana, e a
 * semana pertence ao mes da segunda dela — definicao dada pelo Flavio em
 * ago/2026 e ja usada pelo quadro da Agenda da Carteira. Por isso a semana e'
 * contada pela segunda, e nao pela enesima ocorrencia do dia de rota: assim a
 * coluna do quadro e a regra do cliente falam da mesma semana.
 */
export function segundasDoMes(ano: number, mes: number): Date[] {
  const fora: Date[] = [];
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  for (let d = 1; d <= ultimoDia; d++) {
    const data = new Date(ano, mes, d);
    if (data.getDay() === 1) fora.push(data);
  }
  return fora;
}

/** A segunda-feira que abre a enesima semana do mes ('ultima' = a ultima). */
export function segundaDaSemana(ano: number, mes: number, n: number | "ultima"): Date | null {
  const segundas = segundasDoMes(ano, mes);
  if (!segundas.length) return null;
  return n === "ultima" ? segundas[segundas.length - 1] : segundas[n - 1] || null;
}

/**
 * Datas das semanas de um MES que casam com (dias da semana X semana).
 * Atencao: a semana pode atravessar a virada — se a ultima segunda de novembro
 * e' dia 30, a terca dessa semana e' 1º de dezembro, e ela ainda e' a ultima
 * semana de NOVEMBRO. E' a regra que o Flavio definiu para o quadro.
 */
export function datasDoMesPelaRegra(
  ano: number, mes: number, alvos: number[], semana: SemanaAtendimento,
): Date[] {
  const uteis = alvos.filter((n) => n >= 1 && n <= 5);
  if (!uteis.length) return [];
  const quais = ocorrenciasDaSemana(semana);
  const segundas = quais.length
    ? quais.map((n) => segundaDaSemana(ano, mes, n)).filter((d): d is Date => !!d)
    : segundasDoMes(ano, mes);
  const fora: Date[] = [];
  for (const segunda of segundas) {
    for (const dow of uteis) {
      const d = new Date(segunda);
      d.setDate(d.getDate() + (dow - 1));
      fora.push(d);
    }
  }
  return fora.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Datas da regra dentro de uma janela [ini, fim] (ambas inclusivas).
 * Determinista: nao depende de ancora nem de encadeamento, entao visita
 * atrasada nao empurra o ciclo inteiro para a frente.
 */
export function datasPelaRegra(
  ini: Date, fim: Date, alvos: number[], semana: SemanaAtendimento,
): Date[] {
  const fora: Date[] = [];
  // Comeca um mes antes: a ultima semana do mes anterior pode cair dentro da
  // janela (segunda dia 30, terca dia 1º do mes seguinte).
  const cursor = new Date(ini.getFullYear(), ini.getMonth() - 1, 1);
  const limite = new Date(fim.getFullYear(), fim.getMonth(), 1);
  while (cursor <= limite) {
    for (const d of datasDoMesPelaRegra(cursor.getFullYear(), cursor.getMonth(), alvos, semana)) {
      if (d >= ini && d <= fim) fora.push(d);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return Array.from(new Set(fora.map((d) => d.getTime()))).sort((a, b) => a - b).map((t) => new Date(t));
}

/**
 * Que semana do mes esta data ocupa, contada pela SEGUNDA-FEIRA da semana dela
 * (e por isso o mes pode ser o anterior, na virada). Devolve tambem se e' a
 * ultima semana daquele mes.
 */
export function semanaDoMesDaData(d: Date): { mes: number; ano: number; n: number; ultima: boolean } {
  const segunda = new Date(d);
  segunda.setDate(segunda.getDate() - ((segunda.getDay() + 6) % 7));
  const ano = segunda.getFullYear();
  const mes = segunda.getMonth();
  const segundas = segundasDoMes(ano, mes);
  const n = segundas.findIndex((x) => x.getDate() === segunda.getDate()) + 1;
  return { mes, ano, n: n || 1, ultima: n === segundas.length };
}
