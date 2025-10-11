import cron from 'node-cron';
import { getOmieService } from './omieIntegration';
import { generateVisitAgenda } from './visitScheduleService';
import { storage } from './storage';
import { generateDailyRoute } from './routeOptimizationService';

console.log('Inicializando agendador de tarefas...');

// Função para sincronização completa (Clientes + Faturamentos + Débitos Vencidos)
async function syncComplete(horario: string) {
  console.log(`🔄 [${horario}] Iniciando sincronização completa automática...`);
  
  try {
    const omieService = getOmieService(storage);
    if (!omieService) {
      console.error(`❌ [${horario}] Serviço Omie não configurado para sincronização automática`);
      return;
    }

    const results = {
      clients: null as any,
      billings: null as any,
      overdueDebts: null as any,
      errors: [] as string[]
    };

    // 1. Sincronizar clientes ativos
    try {
      console.log(`📋 [${horario}] Sincronizando clientes ativos...`);
      const clientResult = await omieService.syncAllClients();
      results.clients = {
        totalProcessed: clientResult.totalProcessed || 0,
        imported: clientResult.imported || 0,
        updated: clientResult.updated || 0
      };
      console.log(`✅ [${horario}] Clientes: ${results.clients.totalProcessed} processados`);
    } catch (error: any) {
      const errorMsg = `Erro ao sincronizar clientes: ${error.message}`;
      results.errors.push(errorMsg);
      console.error(`❌ [${horario}] ${errorMsg}`);
    }

    // 2. Sincronizar faturamentos
    try {
      console.log(`💰 [${horario}] Sincronizando faturamentos...`);
      const billingResult = await omieService.syncAllBillings();
      results.billings = {
        totalProcessed: billingResult.totalProcessed || 0,
        imported: billingResult.imported || 0,
        updated: billingResult.updated || 0
      };
      console.log(`✅ [${horario}] Faturamentos: ${results.billings.totalProcessed} processados`);
    } catch (error: any) {
      const errorMsg = `Erro ao sincronizar faturamentos: ${error.message}`;
      results.errors.push(errorMsg);
      console.error(`❌ [${horario}] ${errorMsg}`);
    }

    // 3. Sincronizar débitos vencidos
    try {
      console.log(`📊 [${horario}] Sincronizando débitos vencidos...`);
      const debtResult = await omieService.getOverdueDebts();
      await storage.syncOverdueDebts(debtResult.debts);
      results.overdueDebts = {
        totalClients: debtResult.totalClients,
        totalAmount: debtResult.totalAmount
      };
      console.log(`✅ [${horario}] Débitos: ${debtResult.totalClients} clientes, R$ ${debtResult.totalAmount.toFixed(2)}`);
    } catch (error: any) {
      const errorMsg = `Erro ao sincronizar débitos vencidos: ${error.message}`;
      results.errors.push(errorMsg);
      console.error(`❌ [${horario}] ${errorMsg}`);
    }

    // Resumo da sincronização
    console.log(`✨ [${horario}] Sincronização completa concluída:`);
    if (results.clients) {
      console.log(`   - Clientes: ${results.clients.totalProcessed} processados (${results.clients.imported} novos, ${results.clients.updated} atualizados)`);
    }
    if (results.billings) {
      console.log(`   - Faturamentos: ${results.billings.totalProcessed} processados (${results.billings.imported} novos, ${results.billings.updated} atualizados)`);
    }
    if (results.overdueDebts) {
      console.log(`   - Débitos: ${results.overdueDebts.totalClients} clientes, Total R$ ${results.overdueDebts.totalAmount.toFixed(2)}`);
    }
    if (results.errors.length > 0) {
      console.log(`   ⚠️ ${results.errors.length} erro(s) encontrado(s)`);
    }
    
  } catch (error) {
    console.error(`❌ [${horario}] Erro crítico na sincronização completa:`, error);
  }
}

// Função para sincronizar débitos vencidos
async function syncOverdueDebts(horario: string) {
  console.log(`🕐 Iniciando sincronização automática de débitos vencidos às ${horario}...`);
  
  try {
    const omieService = getOmieService();
    if (!omieService) {
      console.error('❌ Serviço Omie não configurado para sincronização automática');
      return;
    }

    const result = await omieService.getOverdueDebts();
    
    // Salvar débitos no banco de dados
    const storage = (await import('./storage')).storage;
    await storage.syncOverdueDebts(result.debts);
    
    console.log(`✅ Sincronização automática concluída (${horario}):`);
    console.log(`   - ${result.totalClients} clientes com débitos vencidos`);
    console.log(`   - Total: R$ ${result.totalAmount.toFixed(2)}`);
    console.log(`   - Débitos salvos no banco de dados`);
    
  } catch (error) {
    console.error(`❌ Erro na sincronização automática de débitos vencidos (${horario}):`, error);
  }
}

// Sincronização completa automática de hora em hora a partir das 6h
// Das 06:00 às 23:00 (6h, 7h, 8h, ..., 23h)
cron.schedule('0 6-23 * * *', () => {
  const now = new Date();
  const hour = now.getHours();
  const horario = `${hour.toString().padStart(2, '0')}:00h`;
  syncComplete(horario);
}, {
  timezone: "America/Sao_Paulo"
});

// Geração automática de agenda de visitas todos os dias às 06:00h
cron.schedule('0 6 * * *', async () => {
  console.log('Iniciando geração automática de agenda de visitas às 06:00h...');
  
  try {
    const result = await generateVisitAgenda();
    
    console.log(`✅ Geração de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas criadas`);
    
  } catch (error) {
    console.error('❌ Erro na geração automática de agenda:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Processamento de cards criticamente atrasados todos os dias às 02:00h
cron.schedule('0 2 * * *', async () => {
  console.log('🕐 [SCHEDULER] Iniciando processamento de cards atrasados...');
  
  try {
    // Buscar todos os cards criticamente atrasados (sem filtro de vendedor)
    const overdueCards = await storage.getCriticallyOverdueCards();
    
    console.log(`📋 [SCHEDULER] Encontrados ${overdueCards.length} cards criticamente atrasados (>3 dias)`);
    
    let processedCount = 0;
    let errorCount = 0;
    
    // Processar cada card: marcar como failed e agendar próximo
    for (const card of overdueCards) {
      try {
        const result = await storage.closeCardAndScheduleNext(
          card.id,
          'failed',
          { noSaleReason: 'Card automaticamente marcado como fracassado após 3 dias sem atendimento' }
        );
        
        console.log(`✅ [SCHEDULER] Card ${card.id} marcado como failed. Próxima visita: ${result.nextCard?.scheduledDate || 'N/A'}`);
        processedCount++;
      } catch (error) {
        console.error(`❌ [SCHEDULER] Erro ao processar card ${card.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`✨ [SCHEDULER] Processamento concluído: ${processedCount} sucesso, ${errorCount} erros`);
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro ao buscar cards atrasados:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Geração automática de rotas diárias para todos os vendedores às 05:00h
cron.schedule('0 5 * * *', async () => {
  console.log('🗺️ [SCHEDULER] Iniciando geração automática de rotas diárias às 05:00h...');
  
  try {
    const db = (await import('./db')).db;
    const { users } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');
    
    // Buscar todos os vendedores ativos com coordenadas configuradas
    const vendedores = await db.select()
      .from(users)
      .where(eq(users.role, 'vendedor'));
    
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
    let routesGenerated = 0;
    let routesSkipped = 0;
    let errors = 0;
    
    for (const vendedor of vendedores) {
      try {
        // Verificar se vendedor tem coordenadas configuradas
        if (!vendedor.homeLatitude || !vendedor.homeLongitude) {
          console.log(`⚠️ [SCHEDULER] Vendedor ${vendedor.firstName} ${vendedor.lastName} sem coordenadas de casa configuradas`);
          routesSkipped++;
          continue;
        }
        
        // Verificar se já existe rota para hoje
        const existingRoute = await storage.getDailyRouteBySellerAndDate(vendedor.id, hoje);
        if (existingRoute) {
          console.log(`ℹ️ [SCHEDULER] Rota já existe para ${vendedor.firstName} ${vendedor.lastName}`);
          routesSkipped++;
          continue;
        }
        
        // Gerar rota
        const result = await generateDailyRoute(storage, vendedor.id, hoje);
        
        if (result.warnings && result.warnings.length > 0) {
          console.log(`⚠️ [SCHEDULER] Rota gerada para ${vendedor.firstName} ${vendedor.lastName} com alertas:`, result.warnings);
        } else {
          console.log(`✅ [SCHEDULER] Rota gerada para ${vendedor.firstName} ${vendedor.lastName}: ${result.totalVisits} visitas`);
        }
        
        routesGenerated++;
      } catch (error) {
        console.error(`❌ [SCHEDULER] Erro ao gerar rota para ${vendedor.firstName} ${vendedor.lastName}:`, error);
        errors++;
      }
    }
    
    console.log(`✨ [SCHEDULER] Geração de rotas concluída: ${routesGenerated} geradas, ${routesSkipped} puladas, ${errors} erros`);
    
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro na geração automática de rotas:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});

console.log('✅ Agendador configurado:');
console.log('   - Processamento de cards atrasados às 02:00h (UTC-3)');
console.log('   - Geração de rotas diárias às 05:00h (UTC-3)');
console.log('   - Sincronização completa (Clientes + Faturamentos + Débitos) de hora em hora das 06:00h às 23:00h (UTC-3)');
console.log('   - Geração de agenda de visitas às 06:00h (UTC-3)');