import { getOmieService } from './server/omieIntegration';
import { storage } from './server/storage';

async function syncRemainingOldBillings() {
  console.log('🔄 Sincronizando notas antigas restantes...');
  
  const omieService = getOmieService(storage);
  
  if (!omieService) {
    console.error('❌ Serviço Omie não configurado');
    process.exit(1);
  }
  
  const orderNumbers = [
    '00024805', '00024853'
  ];
  
  console.log(`📋 Sincronizando ${orderNumbers.length} pedidos: ${orderNumbers.join(', ')}`);
  
  try {
    const result = await omieService.syncSpecificOrders(orderNumbers);
    
    console.log('\n✅ Sincronização concluída:');
    console.log(`   - Processados: ${result.totalProcessed}`);
    console.log(`   - Criados: ${result.imported}`);
    console.log(`   - Atualizados: ${result.updated}`);
    console.log(`   - Ignorados: ${result.skipped}`);
    
    if (result.errors.length > 0) {
      console.log(`\n⚠️ Erros (${result.errors.length}):`);
      result.errors.forEach((err: any) => {
        console.log(`   - ${err.orderNumber || 'N/A'}: ${err.error}`);
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro na sincronização:', error);
    process.exit(1);
  }
}

syncRemainingOldBillings();
