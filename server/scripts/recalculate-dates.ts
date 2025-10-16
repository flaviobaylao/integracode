import { storage } from '../storage';

async function recalculateDates() {
  try {
    console.log('📅 Iniciando recálculo de datas de visita...\n');
    
    const results = await storage.recalculateAllVisitDates();
    
    console.log('\n✅ Recálculo concluído:');
    console.log(`   - Processados: ${results.processed}`);
    console.log(`   - Atualizados: ${results.updated}`);
    console.log(`   - Erros: ${results.errors}`);
    
    if (results.details.length > 0) {
      console.log('\n📋 Detalhes (primeiros 10):');
      results.details.slice(0, 10).forEach((detail, index) => {
        if (detail.error) {
          console.log(`   ${index + 1}. ❌ Card ${detail.cardId}: ${detail.error}`);
        } else {
          console.log(`   ${index + 1}. ✓ ${detail.customerName}`);
          console.log(`      Antes: ${new Date(detail.oldDate).toLocaleDateString('pt-BR')}`);
          console.log(`      Depois: ${new Date(detail.newDate).toLocaleDateString('pt-BR')}`);
          console.log(`      Método: ${detail.method}`);
        }
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

recalculateDates();
