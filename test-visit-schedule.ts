/**
 * Script de teste para validar a lógica de cálculo de próximas visitas
 */

import { calculateNextVisitDate } from './shared/visitSchedule';

console.log('🧪 Testando lógica de cálculo de visitas\n');

// Teste 1: Cliente com rota de SEGUNDA, periodicidade QUINZENAL
console.log('📅 Teste 1: Segunda-feira, Quinzenal');
console.log('   Última visita: 13/10/2025 (segunda)');
const result1 = calculateNextVisitDate({
  weekdays: ['segunda'],
  periodicity: 'quinzenal',
  lastCompletedDate: new Date('2025-10-13T08:00:00')
});
console.log('   Próxima visita: ' + result1.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result1.nextDate.getDay()]);
console.log('   ✅ Esperado: 2025-10-27 (segunda)\n');

// Teste 2: Cliente com rota de TERÇA, periodicidade SEMANAL
console.log('📅 Teste 2: Terça-feira, Semanal');
console.log('   Última visita: 14/10/2025 (terça)');
const result2 = calculateNextVisitDate({
  weekdays: ['terca'],
  periodicity: 'semanal',
  lastCompletedDate: new Date('2025-10-14T08:00:00')
});
console.log('   Próxima visita: ' + result2.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result2.nextDate.getDay()]);
console.log('   ✅ Esperado: 2025-10-21 (terça)\n');

// Teste 3: Cliente com rota de QUARTA, periodicidade MENSAL
console.log('📅 Teste 3: Quarta-feira, Mensal');
console.log('   Última visita: 02/10/2025 (quarta)');
const result3 = calculateNextVisitDate({
  weekdays: ['quarta'],
  periodicity: 'mensal',
  lastCompletedDate: new Date('2025-10-02T08:00:00')
});
console.log('   Próxima visita: ' + result3.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result3.nextDate.getDay()]);
console.log('   ✅ Esperado: ~2025-11-05 (quarta, próxima após +30 dias)\n');

// Teste 4: Cliente SEM última visita (primeira visita)
console.log('📅 Teste 4: Primeira visita (sem histórico)');
console.log('   Hoje: 24/10/2025 (sexta)');
console.log('   Rota: segunda-feira');
const result4 = calculateNextVisitDate({
  weekdays: ['segunda'],
  periodicity: 'semanal',
  lastCompletedDate: undefined,
  referenceDate: new Date('2025-10-24T08:00:00')
});
console.log('   Próxima visita: ' + result4.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result4.nextDate.getDay()]);
console.log('   ✅ Esperado: 2025-10-27 (próxima segunda)\n');

// Teste 5: Caso problemático - data calculada cai entre dias permitidos
console.log('📅 Teste 5: Data calculada entre dias permitidos');
console.log('   Última visita: 18/10/2025 (sábado)');
console.log('   Periodicidade: semanal (+7 dias = 25/10 que é sábado)');
console.log('   Dias permitidos: segunda e quarta');
const result5 = calculateNextVisitDate({
  weekdays: ['segunda', 'quarta'],
  periodicity: 'semanal',
  lastCompletedDate: new Date('2025-10-18T08:00:00')
});
console.log('   Próxima visita: ' + result5.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result5.nextDate.getDay()]);
console.log('   ✅ Esperado: 2025-10-27 (segunda, próximo dia permitido APÓS 25/10)\n');

console.log('✨ Testes concluídos!');
