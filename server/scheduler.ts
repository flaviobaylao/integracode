import cron from 'node-cron';
import { getOmieService } from './omieIntegration';
import { generateVisitAgenda, syncFutureSalesCards } from './visitScheduleService';
import { storage } from './storage';
import { generateDailyRoute } from './routeOptimizationService';

console.log('Inicializando agendador de tarefas...');

// Sincronizar usuários como agentes na inicialização
(async () => {
  await storage.syncUsersAsAgents();
})();

// Job para encerrar conversas inativas a cada 5 minutos
cron.schedule('*/5 * * * *', async () => {
  try {
    await storage.closeInactiveConversations();
  } catch (error) {
    console.error('❌ Erro ao encerrar conversas inativas:', error);
  }
});

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

    // 2. Sincronizar notas fiscais de 2025 (filtro por data de emissão)
    try {
      console.log(`💰 [${horario}] Sincronizando notas fiscais de 2025...`);
      
      // Atualizar status para "em progresso" antes de iniciar
      await storage.updateSyncStatus('omie_billings', { 
        status: 'in_progress', 
        message: 'Sincronização automática iniciada...',
        recordsProcessed: 0,
        currentProgress: 0
      });
      
      const billingResult = await (omieService as any).syncBillings({
        onProgress: (progress: { processed: number, total: number }) => {
          // Atualizar progresso em tempo real
          storage.updateSyncStatus('omie_billings', { 
            status: 'in_progress', 
            recordsProcessed: progress.processed,
            totalRecords: progress.total,
            currentProgress: Math.round((progress.processed / (progress.total || 1)) * 100)
          });
        }
      });
      
      results.billings = {
        totalProcessed: billingResult.totalProcessed || billingResult.newBillings || 0,
        imported: billingResult.imported || billingResult.newBillings || 0,
        updated: billingResult.updated || 0
      };
      
      // Atualizar status para "sucesso" ao concluir
      await storage.updateSyncStatus('omie_billings', { 
        status: 'success', 
        message: `${results.billings.imported} importados, ${results.billings.updated} atualizados`,
        recordsProcessed: results.billings.totalProcessed,
        currentProgress: 100,
        lastFinishedAt: new Date()
      });
      
      console.log(`✅ [${horario}] Notas fiscais: ${results.billings.totalProcessed} processadas`);
    } catch (error: any) {
      const errorMsg = `Erro ao sincronizar notas fiscais: ${error.message}`;
      results.errors.push(errorMsg);
      console.error(`❌ [${horario}] ${errorMsg}`);
      
      // Atualizar status para "erro"
      await storage.updateSyncStatus('omie_billings', { 
        status: 'error', 
        message: errorMsg
      });
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

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Geração automática de agenda de visitas REMOVIDA após migração para cards permanentes
// A geração de visitas agora usa visit_schedule_history em vez de sales_cards
/* 
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
*/

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Processamento de cards atrasados REMOVIDO - não há mais geração de próximos cards
// Cards são permanentes e pedidos são registrados em order_history
/*
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
*/

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

// DESATIVADO: Sistema migrado para cards permanentes + order_history
// Sincronização de agenda futura REMOVIDA - não há mais necessidade de criar/deletar cards recorrentes
// Sistema agora usa cards permanentes (um por cliente) + order_history para pedidos
/*
cron.schedule('0 0 * * *', async () => {
  console.log('🌙 [SCHEDULER] Iniciando sincronização completa de agenda futura à meia-noite...');
  
  try {
    const result = await syncFutureSalesCards(2);
    
    console.log(`✅ [SCHEDULER] Sincronização de agenda concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.created} cards criados`);
    console.log(`   - ${result.deleted} cards deletados`);
    console.log(`   - ${result.errors} erros`);
    
  } catch (error) {
    console.error('❌ [SCHEDULER] Erro na sincronização de agenda futura:', error);
  }
}, {
  timezone: "America/Sao_Paulo"
});
*/

// Auto check-out: processar visitas com check-in há mais de 30 minutos sem check-out
// Executa a cada 5 minutos das 6h às 23h
cron.schedule('*/5 6-23 * * *', async () => {
  try {
    const { processAutoCheckouts } = await import('./autoCheckoutService');
    const result = await processAutoCheckouts(storage);
    
    if (result.processed > 0) {
      console.log(`🤖 [AUTO-CHECKOUT] ${result.processed} visita(s) com check-out automático, ${result.errors} erro(s)`);
    }
  } catch (error: any) {
    console.error('❌ [AUTO-CHECKOUT] Erro no processamento:', error.message);
  }
}, {
  timezone: "America/Sao_Paulo"
});

// Polling fallback: Buscar mensagens da Evolution API a cada 30 segundos (segurança)
// Isso garante que mesmo se o webhook falhar, as mensagens serão sincronizadas
cron.schedule('*/30 * * * * *', async () => {
  try {
    const { evolutionAPIService } = await import('./evolution-api-service');
    
    if (!evolutionAPIService.isConfigured()) {
      return;
    }

    const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'CHAT_HONEST';
    let newMessages = 0;
    let errors = 0;

    // 1. Buscar todos os chats ativos da Evolution API (para pegar novos contatos também)
    const chatsResult = await evolutionAPIService.fetchAllChats(instanceName);
    
    if (chatsResult.success && chatsResult.chats) {
      // Filtrar apenas chats individuais (não grupos)
      const individualChats = chatsResult.chats.filter((chat: any) => {
        const jid = chat.remoteJid || chat.id || '';
        return jid.includes('@s.whatsapp.net') && !jid.includes('@g.us');
      });

      // Sort by updatedAt (most recent first) and take top 10 chats
      // Don't rely solely on unreadCount as it may be reset by Evolution/Web clients
      const chatsToProcess = individualChats
        .sort((a: any, b: any) => {
          const aTime = new Date(a.updatedAt || 0).getTime();
          const bTime = new Date(b.updatedAt || 0).getTime();
          return bTime - aTime; // Most recent first
        })
        .slice(0, 10); // Limitar a 10 chats por ciclo

      for (const chat of chatsToProcess) {
        try {
          const phoneNumber = evolutionAPIService.extractPhoneNumber(chat.remoteJid || chat.id || '');
          
          const result = await evolutionAPIService.fetchChatHistory(instanceName, phoneNumber, 20);

          if (result.success && result.messages && result.messages.length > 0) {
            for (const msg of result.messages) {
              try {
                const msgId = msg.key?.id;
                const msgPhone = evolutionAPIService.extractPhoneNumber(msg.key?.remoteJid || '');
                const isFromMe = msg.key?.fromMe === true;
                const msgContent = evolutionAPIService.extractMessageText(msg.message || {}) || '';

                if (!msgId || !msgPhone) continue;

                // Buscar ou criar cliente
                let customer = await storage.getChatCustomerByPhone(msgPhone);
                if (!customer) {
                  customer = await storage.createChatCustomer({
                    phone: msgPhone,
                    name: msg.pushName || `Cliente ${msgPhone}`
                  });
                }

                // Buscar ou criar conversa
                let conversation = await storage.getChatConversationByPhone(msgPhone);
                if (!conversation) {
                  conversation = await storage.createChatConversation({
                    customerId: customer.id,
                    customerName: customer.name,
                    customerPhone: msgPhone,
                    status: 'new',
                    priority: 'normal'
                  });
                }

                // Check for duplicates using externalId (indexed lookup via storage)
                const existingMsg = await storage.getChatMessageByExternalId(msgId);
                
                if (!existingMsg) {
                  await storage.createChatMessage({
                    conversationId: conversation.id,
                    senderId: isFromMe ? 'system' : customer.id,
                    senderType: isFromMe ? 'system' : 'customer',
                    content: msgContent || '[Mídia/Outro]',
                    messageType: 'text',
                    externalId: msgId
                  });
                  newMessages++;
                }
              } catch (msgError) {
                errors++;
              }
            }
          }
        } catch (convError) {
          errors++;
        }
      }
    }

    if (newMessages > 0) {
      console.log(`📲 [POLLING] ${newMessages} mensagens sincronizadas via polling fallback`);
    }
  } catch (error: any) {
    console.error('❌ [POLLING] Erro no fallback de sincronização:', error.message);
  }
});

// Geração automática de próximas 3 visitas para clientes ativos
cron.schedule('0 0 * * *', async () => {
  console.log('📅 [SCHEDULER] Iniciando geração de próximas 3 visitas para clientes ativos às 00:00h...');
  
  try {
    const result = await storage.generateNextVisitsForActiveCustomers();
    console.log(`✅ [SCHEDULER] Geração de visitas concluída:`);
    console.log(`   - ${result.processed} clientes processados`);
    console.log(`   - ${result.generated} visitas geradas`);
    if (result.errors > 0) {
      console.log(`   - ⚠️ ${result.errors} erro(s) encontrado(s)`);
    }
  } catch (error: any) {
    console.error('❌ [SCHEDULER] Erro na geração de visitas:', error.message);
  }
}, {
  timezone: "America/Sao_Paulo"
});

console.log('✅ Agendador configurado:');
console.log('   - Geração de próximas 3 visitas para clientes ativos diariamente às 00:00h (UTC-3)');
console.log('   - Geração de rotas diárias às 05:00h (UTC-3)');
console.log('   - Sincronização completa (Clientes + Faturamentos + Débitos) de hora em hora das 06:00h às 23:00h (UTC-3)');
console.log('   - Auto check-out de visitas (30+ min sem check-out) a cada 5 minutos das 06:00h às 23:00h (UTC-3)');
console.log('   - Polling fallback WhatsApp a cada 30 segundos (segurança)');
console.log('');
console.log('⚠️  Jobs desativados após migração para cards permanentes:');
console.log('   ✗ Sincronização de agenda futura (não necessário com cards permanentes)');
console.log('   ✗ Processamento de cards atrasados (não necessário com cards permanentes)');
console.log('   ✗ Geração de agenda de visitas (substituído por visit_schedule_history)');