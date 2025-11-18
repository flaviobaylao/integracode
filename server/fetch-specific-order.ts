import { getOmieService } from './omieIntegration';
import { storage } from './storage';

async function fetchSpecificOrder() {
  try {
    console.log('🔍 Buscando pedido 30464 no Omie...\n');
    
    const omieService = getOmieService(storage);
    
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado!');
      process.exit(1);
    }
    
    // Buscar pedido específico
    const result = await (omieService as any).syncSpecificOrders(['30464']);
    
    console.log('\n✅ RESULTADO:');
    console.log('='.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    
    // Buscar no banco depois da sincronização
    console.log('\n🔍 Verificando no banco de dados...');
    const billings = await storage.getBillings({});
    const found = billings.find(b => 
      b.orderNumber === '30464' || 
      b.invoiceNumber?.includes('26323') ||
      b.invoiceNumber?.includes('26322')
    );
    
    if (found) {
      console.log('\n✅ ENCONTRADO NO BANCO:');
      console.log('='.repeat(60));
      console.log(`NF: ${found.invoiceNumber}`);
      console.log(`Pedido: ${found.orderNumber}`);
      console.log(`Etapa: ${found.invoiceStage}`);
      console.log(`Cliente: ${found.customerFantasyName}`);
      console.log(`Omie Order ID: ${found.omieOrderId}`);
    } else {
      console.log('\n⚠️ NÃO ENCONTRADO NO BANCO após sincronização');
    }
    
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Erro:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

fetchSpecificOrder();
