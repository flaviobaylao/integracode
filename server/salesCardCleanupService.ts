import cron from 'node-cron';
import type { IStorage } from './storage';

/**
 * Serviço de limpeza automática de sales cards antigos
 * Remove cards pendentes/rascunho não finalizados com mais de 30 dias
 */

export function startSalesCardCleanupService(storage: IStorage) {
  console.log('🧹 [CLEANUP] Serviço de limpeza de sales cards iniciado');
  
  // Executar limpeza diariamente às 03:00 AM
  cron.schedule('0 3 * * *', async () => {
    try {
      await cleanupOldSalesCards(storage);
    } catch (error) {
      console.error('❌ [CLEANUP] Erro ao executar limpeza de sales cards:', error);
    }
  });
  
  // Executar imediatamente na inicialização (para testes)
  console.log('🧹 [CLEANUP] Executando limpeza inicial...');
  cleanupOldSalesCards(storage).catch(error => {
    console.error('❌ [CLEANUP] Erro na limpeza inicial:', error);
  });
}

async function cleanupOldSalesCards(storage: IStorage) {
  const startTime = Date.now();
  console.log('🧹 [CLEANUP] Iniciando limpeza de sales cards antigos...');
  
  try {
    // Data de corte: 30 dias atrás
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Data mínima válida: 1º de janeiro de 2020
    const minValidDate = new Date('2020-01-01');
    
    console.log(`🧹 [CLEANUP] Removendo cards pendentes/rascunho criados antes de ${thirtyDaysAgo.toISOString()}`);
    
    // Buscar todos os cards pendentes ou rascunho
    const allCards = await storage.getSalesCards();
    
    let removedCount = 0;
    let keptCount = 0;
    let skippedInvalidDate = 0;
    
    for (const card of allCards) {
      // Apenas remover cards com status 'pending' ou 'draft'
      if (card.status !== 'pending' && card.status !== 'draft') {
        continue;
      }
      
      // Verificar se o card é antigo (mais de 30 dias)
      const cardDate = new Date(card.scheduledDate);
      
      // Ignorar cards com datas inválidas ou muito antigas (antes de 2020)
      if (isNaN(cardDate.getTime()) || cardDate < minValidDate) {
        skippedInvalidDate++;
        console.log(`⚠️ [CLEANUP] Card ${card.id} com data inválida/antiga ignorado: ${card.scheduledDate}`);
        continue;
      }
      
      if (cardDate >= thirtyDaysAgo) {
        keptCount++;
        continue;
      }
      
      // Remover o card
      try {
        await storage.deleteSalesCard(card.id);
        removedCount++;
        console.log(`🗑️ [CLEANUP] Card ${card.id} removido (status: ${card.status}, data: ${cardDate.toISOString()})`);
      } catch (deleteError) {
        console.error(`❌ [CLEANUP] Erro ao remover card ${card.id}:`, deleteError);
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ [CLEANUP] Limpeza concluída em ${duration}ms`);
    console.log(`📊 [CLEANUP] Estatísticas:`);
    console.log(`   - Cards removidos: ${removedCount}`);
    console.log(`   - Cards mantidos: ${keptCount}`);
    console.log(`   - Cards com data inválida ignorados: ${skippedInvalidDate}`);
    console.log(`   - Total processados: ${removedCount + keptCount + skippedInvalidDate}`);
    
  } catch (error) {
    console.error('❌ [CLEANUP] Erro durante limpeza:', error);
    throw error;
  }
}

// Exportar função de limpeza manual para uso em rotas de admin
export async function manualCleanup(storage: IStorage): Promise<{
  removed: number;
  kept: number;
  skippedInvalidDate: number;
  total: number;
}> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const minValidDate = new Date('2020-01-01');
  const allCards = await storage.getSalesCards();
  
  let removedCount = 0;
  let keptCount = 0;
  let skippedInvalidDate = 0;
  
  for (const card of allCards) {
    if (card.status !== 'pending' && card.status !== 'draft') {
      continue;
    }
    
    const cardDate = new Date(card.scheduledDate);
    
    // Ignorar cards com datas inválidas ou muito antigas (antes de 2020)
    if (isNaN(cardDate.getTime()) || cardDate < minValidDate) {
      skippedInvalidDate++;
      continue;
    }
    
    if (cardDate >= thirtyDaysAgo) {
      keptCount++;
      continue;
    }
    
    await storage.deleteSalesCard(card.id);
    removedCount++;
  }
  
  return {
    removed: removedCount,
    kept: keptCount,
    skippedInvalidDate,
    total: removedCount + keptCount + skippedInvalidDate
  };
}
