/**
 * Script para regenerar sales_cards de clientes com múltiplos dias configurados
 * 
 * Contexto: Após atualização em calculateNextVisitDate, clientes com múltiplos
 * dias (weekdays.length > 1) devem ser alocados para Domingo.
 * 
 * Este script executa syncFutureSalesCards para regenerar os próximos 2 meses.
 */

import { syncFutureSalesCards } from '../visitScheduleService';

async function main() {
  console.log('🔄 Iniciando regeneração de sales_cards para clientes com múltiplos dias...\n');
  console.log('📋 Contexto:');
  console.log('   - Clientes afetados: ~2,977 (com múltiplos dias configurados)');
  console.log('   - Nova regra: Alocar para Domingo quando weekdays.length > 1');
  console.log('   - Janela: Próximos 2 meses\n');
  
  try {
    const startTime = Date.now();
    
    // Executar sincronização completa dos próximos 2 meses
    const stats = await syncFutureSalesCards(2);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ Regeneração concluída com sucesso!\n');
    console.log('📊 Estatísticas:');
    console.log(`   - Clientes processados: ${stats.processed}`);
    console.log(`   - Cards criados: ${stats.created}`);
    console.log(`   - Cards deletados: ${stats.deleted}`);
    console.log(`   - Erros: ${stats.errors}`);
    console.log(`   - Tempo de execução: ${duration}s\n`);
    
    if (stats.errors > 0) {
      console.warn('⚠️ Alguns erros ocorreram durante o processo. Verifique os logs acima.');
      process.exit(1);
    } else {
      console.log('🎉 Todos os clientes com múltiplos dias agora têm sales_cards agendados para Domingo!');
      process.exit(0);
    }
    
  } catch (error) {
    console.error('\n❌ Erro fatal durante a regeneração:', error);
    process.exit(1);
  }
}

main();
