/**
 * Teste para verificar se a comparação de datas está funcionando corretamente
 */

console.log('🧪 Testando comparação de datas na sincronização\n');

// Simular o que acontece na sincronização
const correctDates = [
  new Date('2025-10-27T08:00:00'), // Segunda
  new Date('2025-11-03T08:00:00'), // Segunda  
  new Date('2025-11-10T08:00:00'), // Segunda
];

// Cards existentes (simulando)
const existingCards = [
  {
    id: '1',
    scheduledDate: new Date('2025-10-25T08:00:00'), // Sábado (ERRADO)
    routeDay: 'segunda'
  },
  {
    id: '2',
    scheduledDate: new Date('2025-10-27T08:00:00'), // Segunda (CORRETO)
    routeDay: 'segunda'
  },
  {
    id: '3',
    scheduledDate: new Date('2025-11-02T08:00:00'), // Domingo (ERRADO)
    routeDay: 'segunda'
  },
  {
    id: '4',
    scheduledDate: new Date('2025-11-03T08:00:00'), // Segunda (CORRETO)
    routeDay: 'segunda'
  }
];

// Mesma lógica da sincronização
const correctDateStrings = correctDates.map(d => {
  const normalized = new Date(d);
  normalized.setHours(0, 0, 0, 0);
  return normalized.toISOString().split('T')[0];
});

console.log('📅 Datas corretas esperadas:');
correctDateStrings.forEach(d => console.log(`   - ${d}`));

console.log('\n📊 Cards existentes e verificação:');
existingCards.forEach(card => {
  const cardDate = new Date(card.scheduledDate);
  cardDate.setHours(0, 0, 0, 0);
  const cardDateStr = cardDate.toISOString().split('T')[0];
  
  const shouldKeep = correctDateStrings.includes(cardDateStr);
  const action = shouldKeep ? '✅ MANTER' : '❌ DELETAR';
  
  console.log(`   Card ${card.id}: ${cardDateStr} (${card.routeDay}) → ${action}`);
});

// Identificar cards a deletar
const cardsToDelete = existingCards.filter(card => {
  const cardDate = new Date(card.scheduledDate);
  cardDate.setHours(0, 0, 0, 0);
  const cardDateStr = cardDate.toISOString().split('T')[0];
  return !correctDateStrings.includes(cardDateStr);
});

console.log(`\n🗑️  Total de cards a deletar: ${cardsToDelete.length}`);
cardsToDelete.forEach(card => {
  const cardDateStr = new Date(card.scheduledDate).toISOString().split('T')[0];
  console.log(`   - Card ${card.id}: ${cardDateStr}`);
});

console.log(`\n✅ Total de cards a manter: ${existingCards.length - cardsToDelete.length}`);
