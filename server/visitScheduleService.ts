import { db } from './db';
import { customers, visitAgenda } from '../shared/schema';
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm';

// Timezone constants for Brazil (São Paulo)
const BRAZIL_TIMEZONE = 'America/Sao_Paulo';

// Helper function to get current date normalized to Brazil timezone
function getBrazilToday(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: BRAZIL_TIMEZONE }));
}

// Helper function to normalize any date to Brazil timezone
function normalizeToBrazilDate(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: BRAZIL_TIMEZONE }));
}

// Helper function to get start of day in Brazil timezone
function getStartOfDayBrazil(date: Date): Date {
  const normalized = normalizeToBrazilDate(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

// Função para calcular a próxima data de visita baseada na periodicidade
function getNextVisitDate(lastDate: Date, periodicity: string): Date {
  const nextDate = new Date(lastDate);
  
  switch (periodicity) {
    case 'semanal':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'quinzenal':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
    case 'mensal':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case 'bimestral':
      nextDate.setMonth(nextDate.getMonth() + 2);
      break;
    default:
      nextDate.setDate(nextDate.getDate() + 7); // Default semanal
  }
  
  return nextDate;
}

// Função para verificar se um cliente tem visitas agendadas futuras
async function hasUpcomingVisits(customerId: string): Promise<boolean> {
  const today = getBrazilToday();
  const upcomingVisits = await db.select()
    .from(visitAgenda)
    .where(
      and(
        eq(visitAgenda.customerId, customerId),
        gte(visitAgenda.scheduledDate, today),
        eq(visitAgenda.visitStatus, 'pending')
      )
    )
    .limit(1);
    
  return upcomingVisits.length > 0;
}

// Função para calcular o dia da semana em português
function getRouteDay(date: Date): string {
  const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const brazilDate = normalizeToBrazilDate(date);
  return days[brazilDate.getDay()];
}

// Função para gerar visitas para um cliente específico
async function generateVisitsForCustomer(customer: any): Promise<number> {
  let generatedCount = 0;
  const today = getBrazilToday();
  
  // Verificar se já tem visitas futuras
  if (await hasUpcomingVisits(customer.id)) {
    return 0;
  }
  
  // Calcular a data base para gerar próximas visitas
  let baseDate = customer.serviceStartDate ? normalizeToBrazilDate(new Date(customer.serviceStartDate)) : today;
  
  // Se a data de início é no futuro, usar ela como base
  if (baseDate > today) {
    // Gerar a primeira visita na data de início do fornecimento
    await db.insert(visitAgenda).values({
      customerId: customer.id,
      sellerId: customer.sellerId,
      scheduledDate: baseDate,
      routeDay: getRouteDay(baseDate),
      recurrenceType: customer.visitPeriodicity || 'semanal',
      isVirtual: customer.virtualService || false,
      visitStatus: 'pending',
      customerName: customer.name,
      customerLatitude: customer.latitude || null,
      customerLongitude: customer.longitude || null,
      customerAddress: customer.address || null,
    }).onConflictDoNothing();
    generatedCount++;
    
    // Gerar as próximas 3 visitas baseado na periodicidade
    let nextDate = baseDate;
    for (let i = 0; i < 3; i++) {
      nextDate = getNextVisitDate(nextDate, customer.visitPeriodicity);
      await db.insert(visitAgenda).values({
        customerId: customer.id,
        sellerId: customer.sellerId,
        scheduledDate: nextDate,
        routeDay: getRouteDay(nextDate),
        recurrenceType: customer.visitPeriodicity || 'semanal',
        isVirtual: customer.virtualService || false,
        visitStatus: 'pending',
        customerName: customer.name,
        customerLatitude: customer.latitude || null,
        customerLongitude: customer.longitude || null,
        customerAddress: customer.address || null,
      }).onConflictDoNothing();
      generatedCount++;
    }
  } else {
    // Para clientes que já deveriam ter início do fornecimento, calcular próxima visita
    const daysSinceStart = Math.floor((today.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
    let intervalDays = 7; // Default semanal
    
    switch (customer.visitPeriodicity) {
      case 'quinzenal':
        intervalDays = 14;
        break;
      case 'mensal':
        intervalDays = 30;
        break;
      case 'bimestral':
        intervalDays = 60;
        break;
    }
    
    // Calcular quantas visitas já deveriam ter acontecido
    const missedVisits = Math.floor(daysSinceStart / intervalDays);
    
    // Gerar próxima visita baseada no ciclo
    const nextVisitDate = new Date(baseDate);
    nextVisitDate.setDate(nextVisitDate.getDate() + ((missedVisits + 1) * intervalDays));
    
    // Se a próxima visita é hoje ou no futuro, gerar ela e mais algumas
    if (nextVisitDate >= today) {
      await db.insert(visitAgenda).values({
        customerId: customer.id,
        sellerId: customer.sellerId,
        scheduledDate: nextVisitDate,
        routeDay: getRouteDay(nextVisitDate),
        recurrenceType: customer.visitPeriodicity || 'semanal',
        isVirtual: customer.virtualService || false,
        visitStatus: 'pending',
        customerName: customer.name,
        customerLatitude: customer.latitude || null,
        customerLongitude: customer.longitude || null,
        customerAddress: customer.address || null,
      }).onConflictDoNothing();
      generatedCount++;
      
      // Gerar mais 2 visitas futuras
      let subsequentDate = nextVisitDate;
      for (let i = 0; i < 2; i++) {
        subsequentDate = getNextVisitDate(subsequentDate, customer.visitPeriodicity);
        await db.insert(visitAgenda).values({
          customerId: customer.id,
          sellerId: customer.sellerId,
          scheduledDate: subsequentDate,
          routeDay: getRouteDay(subsequentDate),
          recurrenceType: customer.visitPeriodicity || 'semanal',
          isVirtual: customer.virtualService || false,
          visitStatus: 'pending',
          customerName: customer.name,
          customerLatitude: customer.latitude || null,
          customerLongitude: customer.longitude || null,
          customerAddress: customer.address || null,
        }).onConflictDoNothing();
        generatedCount++;
      }
    }
  }
  
  return generatedCount;
}

// Função principal para gerar agenda de visitas
export async function generateVisitAgenda(): Promise<{ processed: number; generated: number }> {
  console.log('🗓️ Iniciando geração automática de agenda de visitas...');
  
  try {
    // Buscar todos os clientes ativos que têm data de início do fornecimento e vendedor associado
    const eligibleCustomers = await db.select()
      .from(customers)
      .where(
        and(
          eq(customers.isActive, true),
          isNotNull(customers.serviceStartDate),
          isNotNull(customers.sellerId)
        )
      );
    
    console.log(`📋 Encontrados ${eligibleCustomers.length} clientes elegíveis para geração de agenda`);
    
    let totalGenerated = 0;
    
    for (const customer of eligibleCustomers) {
      try {
        const generated = await generateVisitsForCustomer(customer);
        totalGenerated += generated;
        
        if (generated > 0) {
          console.log(`✅ Cliente ${customer.name}: ${generated} visitas geradas`);
        }
      } catch (error) {
        console.error(`❌ Erro ao gerar visitas para cliente ${customer.name}:`, error);
      }
    }
    
    console.log(`🎉 Geração concluída: ${totalGenerated} visitas criadas para ${eligibleCustomers.length} clientes`);
    
    return {
      processed: eligibleCustomers.length,
      generated: totalGenerated
    };
    
  } catch (error) {
    console.error('❌ Erro na geração automática de agenda:', error);
    throw error;
  }
}

// Função para sincronizar COMPLETAMENTE os cards futuros (deletar incorretos e criar faltantes)
export async function syncFutureSalesCards(monthsAhead: number = 2): Promise<{
  processed: number;
  created: number;
  deleted: number;
  errors: number;
}> {
  console.log(`🔄 [SYNC-CARDS] Sincronizando cards futuros para ${monthsAhead} meses...`);
  
  const startTime = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const targetDate = new Date(today);
  targetDate.setMonth(targetDate.getMonth() + monthsAhead);
  
  console.log(`📊 [SYNC-CARDS] Janela: ${today.toISOString().split('T')[0]} até ${targetDate.toISOString().split('T')[0]}`);
  
  const stats = {
    processed: 0,
    created: 0,
    deleted: 0,
    errors: 0
  };
  
  try {
    const { salesCards } = await import('../shared/schema');
    const { calculateNextVisitDate } = await import('../shared/visitSchedule');
    const { storage } = await import('./storage');
    const { inArray, notInArray } = await import('drizzle-orm');
    
    // Buscar todos os clientes ativos com periodicidade e weekdays configurados
    const activeCustomers = await db.select({
      id: customers.id,
      name: customers.name,
      sellerId: customers.sellerId,
      visitPeriodicity: customers.visitPeriodicity,
      weekdays: customers.weekdays
    })
    .from(customers)
    .where(
      and(
        eq(customers.isActive, true),
        isNotNull(customers.visitPeriodicity),
        isNotNull(customers.weekdays)
      )
    );
    
    console.log(`📊 [SYNC-CARDS] Encontrados ${activeCustomers.length} clientes ativos`);
    
    for (const customer of activeCustomers) {
      try {
        stats.processed++;
        
        // Parsear weekdays com fallback para formato legado
        let parsedWeekdays;
        try {
          if (typeof customer.weekdays === 'string') {
            // Tentar JSON.parse primeiro
            parsedWeekdays = JSON.parse(customer.weekdays);
          } else {
            parsedWeekdays = customer.weekdays;
          }
        } catch (parseError) {
          // Fallback: tentar converter formato legado "segunda,terça,quarta" para array
          if (typeof customer.weekdays === 'string' && customer.weekdays.includes(',')) {
            parsedWeekdays = customer.weekdays.split(',').map(d => d.trim());
            console.log(`⚠️ [SYNC-CARDS] ${customer.name}: weekdays em formato legado, convertido automaticamente`);
          } else {
            console.log(`❌ [SYNC-CARDS] ${customer.name}: weekdays inválido, pulando`);
            continue;
          }
        }
        
        if (!Array.isArray(parsedWeekdays) || parsedWeekdays.length === 0) {
          continue;
        }
        
        // Calcular todas as datas corretas para este cliente nos próximos 2 meses
        const correctDates: Date[] = [];
        
        // PRIMEIRA visita: próximo dia da semana (sem considerar periodicidade)
        const firstVisit = calculateNextVisitDate({
          weekdays: parsedWeekdays as any[],
          periodicity: customer.visitPeriodicity as any,
          lastCompletedDate: undefined, // Sem última visita = próximo dia da semana
          referenceDate: today // Usar hoje como referência (inclui hoje se for dia válido)
        });
        
        // DEBUG ROYAL
        const isRoyal = customer.name.includes('ROYAL');
        if (isRoyal) {
          console.log(`\n🔍 [ROYAL DEBUG]`);
          console.log(`   Nome: ${customer.name}`);
          console.log(`   Weekdays: ${JSON.stringify(parsedWeekdays)}`);
          console.log(`   Periodicidade: ${customer.visitPeriodicity}`);
          console.log(`   Today: ${today.toISOString()}`);
          console.log(`   FirstVisit.nextDate: ${firstVisit.nextDate.toISOString()}`);
          console.log(`   TargetDate: ${targetDate.toISOString()}`);
        }
        
        if (firstVisit.nextDate <= targetDate) {
          correctDates.push(new Date(firstVisit.nextDate));
          if (isRoyal) console.log(`   ✅ Primeira visita ADICIONADA:`, firstVisit.nextDate.toISOString().split('T')[0]);
        } else {
          if (isRoyal) console.log(`   ❌ Primeira visita FORA DA JANELA`);
        }
        
        // VISITAS SEGUINTES: aplicar periodicidade a partir da primeira
        let currentDate = new Date(firstVisit.nextDate);
        let visitNum = 2;
        while (currentDate <= targetDate) {
          const result = calculateNextVisitDate({
            weekdays: parsedWeekdays as any[],
            periodicity: customer.visitPeriodicity as any,
            lastCompletedDate: currentDate
          });
          
          if (result.nextDate > targetDate) break;
          
          // Evitar duplicar a primeira visita
          if (result.nextDate.getTime() !== firstVisit.nextDate.getTime()) {
            correctDates.push(new Date(result.nextDate));
            if (isRoyal) console.log(`   ✅ Visita ${visitNum} ADICIONADA:`, result.nextDate.toISOString().split('T')[0]);
            visitNum++;
          }
          
          currentDate = new Date(result.nextDate);
        }
        
        if (isRoyal) {
          console.log(`   📋 Total de datas corretas calculadas: ${correctDates.length}`);
          console.log(`   📅 Datas: ${correctDates.map(d => d.toISOString().split('T')[0]).join(', ')}\n`);
        }
        
        // Buscar todos os cards futuros pendentes deste cliente
        const existingCards = await db.select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, customer.id),
              inArray(salesCards.status, ['pending', 'in_progress']),
              gte(salesCards.scheduledDate, today),
              lte(salesCards.scheduledDate, targetDate)
            )
          );
        
        // Identificar cards a deletar (que não estão nas datas corretas)
        const correctDateStrings = correctDates.map(d => {
          const normalized = new Date(d);
          normalized.setHours(0, 0, 0, 0);
          return normalized.toISOString().split('T')[0];
        });
        
        const cardsToDelete = existingCards.filter(card => {
          const cardDate = new Date(card.scheduledDate);
          cardDate.setHours(0, 0, 0, 0);
          const cardDateStr = cardDate.toISOString().split('T')[0];
          return !correctDateStrings.includes(cardDateStr);
        });
        
        // Deletar cards incorretos em batch
        if (cardsToDelete.length > 0) {
          const cardIds = cardsToDelete.map(c => c.id);
          await db.delete(salesCards).where(inArray(salesCards.id, cardIds));
          stats.deleted += cardsToDelete.length;
        }
        
        // Identificar datas faltantes
        const existingDateStrings = existingCards
          .filter(card => !cardsToDelete.find(c => c.id === card.id))
          .map(card => {
            const d = new Date(card.scheduledDate);
            d.setHours(0, 0, 0, 0);
            return d.toISOString().split('T')[0];
          });
        
        const datesToCreate = correctDates.filter(date => {
          const dateStr = new Date(date).toISOString().split('T')[0];
          return !existingDateStrings.includes(dateStr);
        });
        
        // Criar cards faltantes em batch
        if (datesToCreate.length > 0) {
          const cardsToInsert = datesToCreate.map(date => ({
            customerId: customer.id,
            sellerId: customer.sellerId,
            status: 'pending' as const,
            scheduledDate: date,
            routeDay: getRouteDay(date),
            recurrenceType: customer.visitPeriodicity || 'semanal',
            isRecurring: true,
            createdAt: new Date(),
            updatedAt: new Date()
          }));
          
          await db.insert(salesCards).values(cardsToInsert).onConflictDoNothing();
          stats.created += datesToCreate.length;
        }
        
        // Log apenas se houver mudanças significativas (mais de 5 cards)
        if (cardsToDelete.length > 5 || datesToCreate.length > 5) {
          console.log(`📝 [SYNC-CARDS] ${customer.name}: +${datesToCreate.length} criados, -${cardsToDelete.length} deletados`);
        }
        
      } catch (error) {
        console.error(`❌ [SYNC-CARDS] Erro ao processar ${customer.name}:`, error);
        stats.errors++;
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`✨ [SYNC-CARDS] Sincronização concluída em ${duration}s:`);
    console.log(`   - Clientes processados: ${stats.processed}`);
    console.log(`   - Cards criados: ${stats.created}`);
    console.log(`   - Cards deletados: ${stats.deleted}`);
    console.log(`   - Erros: ${stats.errors}`);
    
    return stats;
    
  } catch (error) {
    console.error('❌ [SYNC-CARDS] Erro na sincronização:', error);
    throw error;
  }
}

// Função para garantir cobertura de 2 meses de agenda futura (usando sales_cards)
export async function ensureFutureAgendaCoverage(monthsAhead: number = 2): Promise<{
  processed: number;
  generated: number;
  skipped: number;
  errors: number;
}> {
  console.log(`📅 [FUTURE-AGENDA] Verificando cobertura de ${monthsAhead} meses futuros...`);
  
  const startTime = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Data limite: hoje + monthsAhead meses
  const targetDate = new Date(today);
  targetDate.setMonth(targetDate.getMonth() + monthsAhead);
  
  console.log(`📊 [FUTURE-AGENDA] Janela de geração: ${today.toISOString().split('T')[0]} até ${targetDate.toISOString().split('T')[0]}`);
  
  const stats = {
    processed: 0,
    generated: 0,
    skipped: 0,
    errors: 0
  };
  
  try {
    const { salesCards } = await import('../shared/schema');
    const { storage } = await import('./storage');
    const { sql } = await import('drizzle-orm');
    const { calculateNextVisitDate } = await import('../shared/visitSchedule');
    
    // Buscar todos os clientes ativos com periodicidade configurada
    const activeCustomers = await db.select({
      id: customers.id,
      name: customers.name,
      visitPeriodicity: customers.visitPeriodicity,
      weekdays: customers.weekdays
    })
    .from(customers)
    .where(
      and(
        eq(customers.isActive, true),
        isNotNull(customers.visitPeriodicity),
        isNotNull(customers.weekdays)
      )
    );
    
    console.log(`📊 [FUTURE-AGENDA] Encontrados ${activeCustomers.length} clientes ativos com periodicidade`);
    
    for (const customer of activeCustomers) {
      try {
        stats.processed++;
        
        // Validar e parsear weekdays com tratamento de erros robusto
        let parsedWeekdays;
        try {
          if (typeof customer.weekdays === 'string') {
            // Tentar parsear como JSON
            parsedWeekdays = JSON.parse(customer.weekdays);
          } else {
            parsedWeekdays = customer.weekdays;
          }
        } catch (parseError) {
          console.log(`⚠️ [FUTURE-AGENDA] ${customer.name}: weekdays inválido (não é JSON válido), pulando`);
          stats.skipped++;
          continue;
        }
        
        if (!parsedWeekdays || !Array.isArray(parsedWeekdays) || parsedWeekdays.length === 0) {
          console.log(`⚠️ [FUTURE-AGENDA] ${customer.name}: weekdays vazio ou inválido, pulando`);
          stats.skipped++;
          continue;
        }
        
        // Buscar último card pendente do cliente
        const lastCards = await db.select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, customer.id),
              eq(salesCards.status, 'pending')
            )
          )
          .orderBy(sql`${salesCards.scheduledDate} DESC`)
          .limit(1);
        
        if (lastCards.length === 0) {
          stats.skipped++;
          continue;
        }
        
        const lastCard = lastCards[0];
        let currentCardId = lastCard.id;
        let currentDate = new Date(lastCard.scheduledDate);
        let cardsGenerated = 0;
        
        // Seguir a cadeia de next_card_id até o último card
        let currentCard = lastCard;
        let chainLength = 0;
        const maxChainLength = 100; // Prevenir loops infinitos
        
        while (currentCard.nextCardId && chainLength < maxChainLength) {
          chainLength++;
          const nextCards = await db.select()
            .from(salesCards)
            .where(eq(salesCards.id, currentCard.nextCardId))
            .limit(1);
          
          if (nextCards.length === 0) break;
          
          currentCard = nextCards[0];
          currentCardId = currentCard.id;
          currentDate = new Date(currentCard.scheduledDate);
        }
        
        // Normalizar datas para comparação (remover horas/minutos)
        const currentDateOnly = new Date(currentDate);
        currentDateOnly.setHours(0, 0, 0, 0);
        const targetDateOnly = new Date(targetDate);
        targetDateOnly.setHours(0, 0, 0, 0);
        
        // Se o último card já está além ou igual à janela de 2 meses, pular este cliente
        if (currentDateOnly >= targetDateOnly) {
          console.log(`⏭️ [FUTURE-AGENDA] ${customer.name}: último card em ${currentDateOnly.toISOString().split('T')[0]} (janela até ${targetDateOnly.toISOString().split('T')[0]}), pulando`);
          stats.skipped++;
          continue;
        }
        
        console.log(`🔄 [FUTURE-AGENDA] ${customer.name}: último card em ${currentDateOnly.toISOString().split('T')[0]}, gerando até ${targetDateOnly.toISOString().split('T')[0]}`);
        
        // Gerar cards até cobrir targetDate
        while (currentDate < targetDate) {
          try {
            // Calcular próxima data
            const result = calculateNextVisitDate({
              weekdays: parsedWeekdays as any[],
              periodicity: customer.visitPeriodicity as any,
              lastCompletedDate: currentDate
            });
            
            const nextDate = result.nextDate;
            
            // Se próxima data ultrapassa targetDate, parar
            if (nextDate > targetDate) break;
            
            // Gerar próximo card usando storage
            const newCard = await storage.generateNextSalesCard(currentCardId);
            
            if (!newCard) {
              console.log(`⚠️ [FUTURE-AGENDA] Cliente ${customer.name}: generateNextSalesCard retornou NULL`);
              break;
            }
            
            currentCardId = newCard.id;
            currentDate = new Date(newCard.scheduledDate);
            cardsGenerated++;
            stats.generated++;
            
          } catch (error) {
            console.error(`❌ [FUTURE-AGENDA] Erro ao gerar card para ${customer.name}:`, error);
            stats.errors++;
            break;
          }
        }
        
        if (cardsGenerated > 0) {
          console.log(`✅ [FUTURE-AGENDA] ${customer.name}: ${cardsGenerated} cards gerados`);
        }
        
      } catch (error) {
        console.error(`❌ [FUTURE-AGENDA] Erro ao processar ${customer.name}:`, error);
        stats.errors++;
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`✨ [FUTURE-AGENDA] Verificação concluída em ${duration}s:`);
    console.log(`   - Clientes processados: ${stats.processed}`);
    console.log(`   - Cards gerados: ${stats.generated}`);
    console.log(`   - Clientes pulados: ${stats.skipped}`);
    console.log(`   - Erros: ${stats.errors}`);
    
    // Registrar histórico no systemSettings
    try {
      const { systemSettings } = await import('../shared/schema');
      const historyKey = 'future_agenda_history';
      
      console.log('💾 [FUTURE-AGENDA] Salvando histórico de execução...');
      
      const existingSettings = await db.select()
        .from(systemSettings)
        .where(eq(systemSettings.key, historyKey))
        .limit(1);
      
      const newEntry = {
        timestamp: new Date().toISOString(),
        monthsAhead,
        processed: stats.processed,
        generated: stats.generated,
        skipped: stats.skipped,
        errors: stats.errors,
        durationSeconds: parseFloat(duration)
      };
      
      if (existingSettings.length > 0) {
        console.log('📝 [FUTURE-AGENDA] Atualizando histórico existente...');
        const history = JSON.parse(existingSettings[0].value || '[]');
        history.unshift(newEntry);
        
        // Manter apenas últimas 30 execuções
        const trimmedHistory = history.slice(0, 30);
        
        await db.update(systemSettings)
          .set({ 
            value: JSON.stringify(trimmedHistory),
            updatedAt: new Date()
          })
          .where(eq(systemSettings.key, historyKey));
        
        console.log('✅ [FUTURE-AGENDA] Histórico atualizado com sucesso');
      } else {
        console.log('📝 [FUTURE-AGENDA] Criando novo registro de histórico...');
        await db.insert(systemSettings).values({
          key: historyKey,
          value: JSON.stringify([newEntry]),
          description: 'Histórico de execuções automáticas de geração de agenda futura',
          updatedBy: 'system'
        });
        
        console.log('✅ [FUTURE-AGENDA] Histórico criado com sucesso');
      }
    } catch (historyError: any) {
      console.error('⚠️ [FUTURE-AGENDA] Erro ao salvar histórico:');
      console.error('   Mensagem:', historyError.message);
      console.error('   Stack:', historyError.stack);
    }
    
    return stats;
    
  } catch (error) {
    console.error('❌ [FUTURE-AGENDA] Erro crítico:', error);
    throw error;
  }
}