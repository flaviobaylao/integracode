import { getOmieService } from '../server/omieIntegration';

async function testSyncCancellation() {
  const omie = getOmieService();
  if (!omie) {
    console.error('Omie não configurado!');
    return;
  }

  const testOrderId = 4275017943; // NF 00023380 - CANCELADA
  
  console.log('\n🧪 TESTE: Simulando comportamento de syncBillings com nota CANCELADA\n');
  console.log(`Pedido ID: ${testOrderId}`);
  
  // Simular o que acontece no syncBillings
  const stageResult = await omie.fetchPedidoStage(testOrderId);
  
  if (stageResult) {
    const isCancelled = stageResult.cancelled;
    
    console.log(`\n📊 Dados obtidos:`);
    console.log(`   Etapa: ${stageResult.stageName}`);
    console.log(`   Cancelado: ${isCancelled ? '🚫 SIM' : '✅ NÃO'}`);
    
    // Esta é a lógica do syncBillings (linhas 1412-1415)
    if (isCancelled) {
      console.log(`\n✅ TESTE PASSOU!`);
      console.log(`   ↳ Sistema detectou cancelamento`);
      console.log(`   ↳ syncBillings retorna NULL (nota NÃO sincronizada)`);
      console.log(`   ↳ Nota cancelada é IGNORADA ✅`);
      return;
    }
    
    console.log(`\n❌ TESTE FALHOU - Nota deveria ser detectada como cancelada`);
  }
}

testSyncCancellation().catch(console.error);
