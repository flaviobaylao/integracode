import { storage } from './storage';

async function checkImportResult() {
  console.log('=== VERIFICANDO RESULTADO DA ÚLTIMA IMPORTAÇÃO ===\n');

  // Buscar todos os cards
  const allCards = await storage.getSalesCards();
  
  console.log(`📊 Total de cards no banco: ${allCards.length}\n`);

  // Buscar cards criados nas últimas 2 horas
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  
  const recentCards = allCards.filter(card => 
    card.createdAt && new Date(card.createdAt) > twoHoursAgo
  );

  console.log(`🆕 Cards criados nas últimas 2 horas: ${recentCards.length}\n`);

  if (recentCards.length > 0) {
    console.log('=== CARDS CRIADOS RECENTEMENTE ===\n');
    
    // Agrupar por status
    const byStatus: Record<string, number> = {};
    recentCards.forEach(card => {
      byStatus[card.status] = (byStatus[card.status] || 0) + 1;
    });
    
    console.log('📋 Por status:');
    Object.entries(byStatus).forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });
    
    // Mostrar primeiros 20
    console.log('\n🔍 Primeiros 20 cards criados:');
    for (let i = 0; i < Math.min(20, recentCards.length); i++) {
      const card = recentCards[i];
      const customer = await storage.getCustomer(card.customerId);
      const hasCoords = card.latitude && card.longitude;
      console.log(`   ${i + 1}. ${customer?.fantasyName || customer?.name || 'N/A'} - ${new Date(card.scheduledDate).toLocaleDateString('pt-BR')} - ${card.routeDay} - ${hasCoords ? '✅ GPS' : '❌ SEM GPS'}`);
    }
  }

  // Estatísticas gerais
  console.log('\n=== ESTATÍSTICAS GERAIS ===');
  
  const statusCount: Record<string, number> = {};
  allCards.forEach(card => {
    statusCount[card.status] = (statusCount[card.status] || 0) + 1;
  });
  
  console.log('\n📋 Todos os cards por status:');
  Object.entries(statusCount).forEach(([status, count]) => {
    console.log(`   ${status}: ${count}`);
  });
  
  // Contar cards sem coordenadas
  const cardsWithoutCoords = allCards.filter(card => !card.latitude || !card.longitude);
  console.log(`\n⚠️  Cards SEM coordenadas: ${cardsWithoutCoords.length} de ${allCards.length} (${Math.round(cardsWithoutCoords.length / allCards.length * 100)}%)`);
}

checkImportResult()
  .then(() => {
    console.log('\n✅ Verificação concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
