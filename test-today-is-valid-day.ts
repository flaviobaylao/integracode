/**
 * Teste: Quando hoje É um dia válido
 */

import { calculateNextVisitDate } from './shared/visitSchedule';

console.log('🧪 Testando: Hoje É um dia válido da rota\n');

// Cenário: Hoje é SEGUNDA 27/10/2025, cliente tem rota de SEGUNDA
const segunda = new Date('2025-10-27T08:00:00'); // Segunda
console.log('📅 Cenário: Hoje é SEGUNDA 27/10/2025');
console.log('   Cliente tem rota: segunda-feira');
console.log('   Periodicidade: semanal');
console.log('   Última visita: undefined (primeira visita)\n');

const result = calculateNextVisitDate({
  weekdays: ['segunda'],
  periodicity: 'semanal',
  lastCompletedDate: undefined,
  referenceDate: segunda
});

console.log('📊 Resultado:');
console.log('   Data retornada: ' + result.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result.nextDate.getDay()]);

// Para primeira visita, incluir hoje se hoje for dia válido é correto
console.log('\n✅ Para PRIMEIRA VISITA: Deve retornar HOJE (2025-10-27) se hoje for dia válido');
console.log('   Razão: Se cliente não tem histórico, a primeira visita pode ser hoje mesmo');

// Mas para SINCRONIZAÇÃO de cards existentes...
console.log('\n⚠️  Para SINCRONIZAÇÃO: Pode ser que queiramos pular hoje e ir para próxima semana?');
console.log('   Depende do contexto de uso da função!');
