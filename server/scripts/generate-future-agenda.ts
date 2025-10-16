import { storage } from '../storage';

async function generateFutureAgenda() {
  try {
    const monthsAhead = 3; // 3 meses para frente
    
    console.log(`📅 Iniciando geração de agenda futura para ${monthsAhead} meses...\n`);
    
    const results = await storage.generateFutureVisitAgenda(monthsAhead);
    
    console.log('\n✅ Geração de agenda futura concluída:');
    console.log(`   - Clientes processados: ${results.processed}`);
    console.log(`   - Cards gerados: ${results.generated}`);
    console.log(`   - Erros: ${results.errors}`);
    
    if (results.details.length > 0) {
      console.log('\n📋 Detalhes (primeiros 10 clientes):');
      results.details.slice(0, 10).forEach((detail, index) => {
        if (detail.error) {
          console.log(`   ${index + 1}. ❌ ${detail.customerName}: ${detail.error}`);
        } else if (detail.warning) {
          console.log(`   ${index + 1}. ⚠️ ${detail.customerName}: ${detail.warning}`);
        } else {
          console.log(`   ${index + 1}. ✓ ${detail.customerName} (${detail.periodicity}): ${detail.cardsGenerated} cards criados`);
        }
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

generateFutureAgenda();
