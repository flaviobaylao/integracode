import { getOmieService } from './omieIntegration';
import { storage } from './storage';

async function quickResyncRecent() {
  try {
    console.log('🔄 Sincronização RÁPIDA - apenas pedidos recentes...\n');
    
    const omieService = getOmieService(storage);
    
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado!');
      process.exit(1);
    }
    
    // Limpar cache
    omieService.clearCache();
    
    // Sincronizar apenas pedidos desde 10/11/2025
    console.log('📊 Sincronizando pedidos desde 10/11/2025...');
    const result = await (omieService as any).syncOrdersInRange('10/11/2025', '');
    
    console.log('\n✅ SINCRONIZAÇÃO CONCLUÍDA!');
    console.log('='.repeat(60));
    console.log(`📊 Total processado: ${result.totalProcessed}`);
    console.log(`📥 Importados: ${result.imported}`);
    console.log(`🔄 Atualizados: ${result.updated}`);
    console.log(`⏭️  Pulados: ${result.skipped}`);
    console.log(`❌ Erros: ${result.errors?.length || 0}`);
    
    // Verificar billings "Aguardando Rota"
    console.log('\n🔍 Verificando billings "Aguardando Rota"...');
    const billings = await storage.getBillings({ invoiceStage: 'Aguardando Rota' });
    console.log(`✅ Total: ${billings.length}`);
    
    const comOmieId = billings.filter(b => b.omieOrderId).length;
    const semOmieId = billings.filter(b => !b.omieOrderId).length;
    
    console.log(`   - Com omie_order_id: ${comOmieId}`);
    console.log(`   - Sem omie_order_id: ${semOmieId}`);
    
    // Mostrar alguns exemplos
    if (billings.length > 0) {
      console.log('\n📋 Primeiros 5 billings:');
      billings.slice(0, 5).forEach(b => {
        console.log(`   - NF ${b.invoiceNumber}: omie_order_id=${b.omieOrderId || 'NULL'}, order_number=${b.orderNumber}`);
      });
    }
    
    console.log('\n✅ Sincronização concluída!');
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Erro:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

quickResyncRecent();
