import { getOmieService } from './omieIntegration';
import { storage } from './storage';

async function resyncBillings() {
  try {
    console.log('🔄 Iniciando ressincronização de pedidos do Omie...\n');
    
    const omieService = getOmieService(storage);
    
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado!');
      process.exit(1);
    }
    
    // Limpar cache antes da sincronização
    omieService.clearCache();
    
    console.log('📊 Sincronizando todos os pedidos do Omie...');
    const result = await omieService.syncAllOrders();
    
    console.log('\n✅ RESSINCRONIZAÇÃO CONCLUÍDA!');
    console.log('='.repeat(60));
    console.log(`📊 Total processado: ${result.totalProcessed}`);
    console.log(`📥 Importados: ${result.imported}`);
    console.log(`🔄 Atualizados: ${result.updated}`);
    console.log(`⏭️  Pulados: ${result.skipped}`);
    console.log(`❌ Erros: ${result.errors?.length || 0}`);
    
    if (result.errors && result.errors.length > 0) {
      console.log('\n❌ ERROS:');
      result.errors.forEach((error, idx) => {
        console.log(`${idx + 1}. ${JSON.stringify(error)}`);
      });
    }
    
    // Verificar quantos billings foram criados com "Aguardando Rota"
    console.log('\n🔍 Verificando billings "Aguardando Rota"...');
    const billings = await storage.getBillings({ invoiceStage: 'Aguardando Rota' });
    console.log(`✅ Total de billings "Aguardando Rota": ${billings.length}`);
    
    // Contar quantos têm omie_order_id
    const comOmieId = billings.filter(b => b.omieOrderId).length;
    const semOmieId = billings.filter(b => !b.omieOrderId).length;
    
    console.log(`   - Com omie_order_id: ${comOmieId}`);
    console.log(`   - Sem omie_order_id: ${semOmieId}`);
    
    console.log('\n✅ Ressincronização concluída com sucesso!');
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Erro na ressincronização:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

resyncBillings();
