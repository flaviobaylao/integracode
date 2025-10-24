/**
 * Teste específico para entender por que 02/11/2025 (domingo) está sendo calculado
 */

import { calculateNextVisitDate } from './shared/visitSchedule';

console.log('🧪 Investigando bug: 02/11/2025 (domingo) sendo calculado para cliente de segunda\n');

// Cenário: Cliente com rota de SEGUNDA, período MENSAL
// Última visita hipotética: 06/10/2025 (segunda)
console.log('📅 Teste 1: Última visita 06/10 (segunda), Mensal');
const result1 = calculateNextVisitDate({
  weekdays: ['segunda'],
  periodicity: 'mensal',
  lastCompletedDate: new Date('2025-10-06T08:00:00')
});
console.log('   Próxima: ' + result1.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result1.nextDate.getDay()]);
console.log('   Cálculo: 06/10 + 30 dias = 05/11 (terça), ajustado para próxima segunda = ?');

// Teste com diferentes datas de outubro
const testDates = [
  new Date('2025-10-03T08:00:00'), // 03/10 sexta
  new Date('2025-10-06T08:00:00'), // 06/10 segunda
  new Date('2025-10-13T08:00:00'), // 13/10 segunda
  new Date('2025-10-20T08:00:00'), // 20/10 segunda
  new Date('2025-10-27T08:00:00')  // 27/10 segunda
];

console.log('\n📊 Testes com diferentes últimas visitas (todas de segunda):');
testDates.forEach(lastDate => {
  const result = calculateNextVisitDate({
    weekdays: ['segunda'],
    periodicity: 'mensal',
    lastCompletedDate: lastDate
  });
  
  const lastStr = lastDate.toISOString().split('T')[0];
  const nextStr = result.nextDate.toISOString().split('T')[0];
  const nextDay = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result.nextDate.getDay()];
  
  console.log(`   ${lastStr} + 30 dias → ${nextStr} (${nextDay})`);
  
  // Verificar se algum resulta em 02/11 (domingo)
  if (nextStr === '2025-11-02') {
    console.log(`   ❌ ENCONTRADO! Esta data resultaria em 02/11 (domingo)`);
  }
});
