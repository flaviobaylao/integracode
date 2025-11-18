/**
 * Calcula os dias de entrega baseado no dia da rota do cliente
 * Os dias de entrega são sempre os próximos 2 dias úteis após o dia da rota
 * Considera apenas dias úteis (segunda a sexta)
 */

export type WeekdayCode = 'SEG' | 'TER' | 'QUA' | 'QUI' | 'SEX' | 'SAB' | 'DOM';

// Ordem dos dias úteis (segunda a sexta)
const BUSINESS_DAYS: WeekdayCode[] = ['SEG', 'TER', 'QUA', 'QUI', 'SEX'];

/**
 * Calcula os próximos 2 dias úteis após um dia da semana
 * @param routeDay - Dia da rota do cliente (SEG, TER, QUA, QUI, SEX, SAB, DOM)
 * @returns Array com os 2 próximos dias úteis
 * 
 * Exemplos:
 * - SEG → ['TER', 'QUA']
 * - QUI → ['SEX', 'SEG']
 * - SEX → ['SEG', 'TER']
 * - SAB → ['SEG', 'TER'] (ignora fim de semana)
 * - DOM → ['SEG', 'TER'] (ignora fim de semana)
 */
export function calculateDeliveryDays(routeDay: string): WeekdayCode[] {
  const normalizedDay = routeDay.toUpperCase().trim();
  
  // Se for sábado ou domingo, considera como se fosse sexta
  // (próximos dias úteis são segunda e terça)
  if (normalizedDay === 'SAB' || normalizedDay === 'DOM') {
    return ['SEG', 'TER'];
  }
  
  // Encontrar o índice do dia da rota nos dias úteis
  const currentIndex = BUSINESS_DAYS.indexOf(normalizedDay as WeekdayCode);
  
  if (currentIndex === -1) {
    // Dia inválido, retornar segunda e terça como padrão
    console.warn(`Dia da rota inválido: ${routeDay}. Usando SEG e TER como padrão.`);
    return ['SEG', 'TER'];
  }
  
  const deliveryDays: WeekdayCode[] = [];
  
  // Calcular os próximos 2 dias úteis
  for (let i = 1; i <= 2; i++) {
    const nextIndex = (currentIndex + i) % BUSINESS_DAYS.length;
    deliveryDays.push(BUSINESS_DAYS[nextIndex]);
  }
  
  return deliveryDays;
}

/**
 * Calcula os dias de entrega para múltiplos dias de rota
 * Remove duplicatas e ordena pelo dia da semana
 * @param routeDays - Array de dias de rota
 * @returns Array único de dias de entrega ordenados
 */
export function calculateDeliveryDaysFromMultipleRoutes(routeDays: string[]): WeekdayCode[] {
  const allDeliveryDays = new Set<WeekdayCode>();
  
  routeDays.forEach(routeDay => {
    const deliveryDays = calculateDeliveryDays(routeDay);
    deliveryDays.forEach(day => allDeliveryDays.add(day));
  });
  
  // Converter para array e ordenar pela ordem dos dias da semana
  return Array.from(allDeliveryDays).sort((a, b) => {
    return BUSINESS_DAYS.indexOf(a) - BUSINESS_DAYS.indexOf(b);
  });
}

/**
 * Formata os dias de entrega para exibição amigável
 * @param deliveryDays - Array de dias de entrega
 * @returns String formatada (ex: "Terça e Quarta")
 */
export function formatDeliveryDays(deliveryDays: WeekdayCode[]): string {
  const dayNames: Record<WeekdayCode, string> = {
    'SEG': 'Segunda',
    'TER': 'Terça',
    'QUA': 'Quarta',
    'QUI': 'Quinta',
    'SEX': 'Sexta',
    'SAB': 'Sábado',
    'DOM': 'Domingo'
  };
  
  if (deliveryDays.length === 0) return 'Nenhum dia';
  if (deliveryDays.length === 1) return dayNames[deliveryDays[0]];
  if (deliveryDays.length === 2) return `${dayNames[deliveryDays[0]]} e ${dayNames[deliveryDays[1]]}`;
  
  // Para 3 ou mais dias
  const lastDay = deliveryDays[deliveryDays.length - 1];
  const otherDays = deliveryDays.slice(0, -1).map(d => dayNames[d]).join(', ');
  return `${otherDays} e ${dayNames[lastDay]}`;
}
