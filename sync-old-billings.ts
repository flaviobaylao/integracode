import { getOmieService } from './server/omieIntegration';
import { storage } from './server/storage';

async function syncOldBillings() {
  console.log('🔄 Sincronizando notas antigas...');
  
  const omieService = getOmieService(storage);
  
  if (!omieService) {
    console.error('❌ Serviço Omie não configurado');
    process.exit(1);
  }
  
  const orderNumbers = [
    '00023202', '00023380', '00023490', '00023477', '00023820',
    '00024064', '00024249', '00024495', '00024497', '00024511',
    '00024533', '00024805', '00024853', '29051', '29050'
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
    
    if (result.rejectedInvoices && result.rejectedInvoices.length > 0) {
      console.log(`\n📋 Notas Rejeitadas (${result.rejectedInvoices.length}):`);
      result.rejectedInvoices.forEach((r: any) => {
        console.log(`   - NF ${r.invoiceNumber}, Pedido ${r.orderNumber}, Etapa "${r.stage}", Motivo: ${r.reason}`);
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro na sincronização:', error);
    process.exit(1);
  }
}

syncOldBillings();
