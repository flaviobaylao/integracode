/**
 * Teste para verificar edge case identificado pelo architect
 */

import { calculateNextVisitDate } from './shared/visitSchedule';

console.log('🧪 Testando edge case: referenceDate não é dia válido\n');

// Cenário: Hoje é SÁBADO 25/10/2025, cliente tem rota de SEGUNDA
const sabado = new Date('2025-10-25T08:00:00'); // Sábado
console.log('📅 Cenário: Hoje é SÁBADO 25/10/2025');
console.log('   Cliente tem rota: segunda-feira');
console.log('   Periodicidade: semanal');
console.log('   Última visita: undefined (primeira visita)\n');

const result = calculateNextVisitDate({
  weekdays: ['segunda'],
  periodicity: 'semanal',
  lastCompletedDate: undefined,
  referenceDate: sabado
});

console.log('📊 Resultado:');
console.log('   Data retornada: ' + result.nextDate.toISOString().split('T')[0]);
console.log('   Dia da semana: ' + ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][result.nextDate.getDay()]);
console.log('\n✅ Esperado: 2025-10-27 (segunda)');
console.log('❌ ERRO se retornar: 2025-10-25 (sábado)');

// Verificar se está correto
const expectedDate = '2025-10-27';
const actualDate = result.nextDate.toISOString().split('T')[0];

if (actualDate === expectedDate) {
  console.log('\n✅ TESTE PASSOU! Data correta.');
} else {
  console.log('\n❌ TESTE FALHOU! Data incorreta.');
  console.log(`   Esperado: ${expectedDate}`);
  console.log(`   Recebido: ${actualDate}`);
}
