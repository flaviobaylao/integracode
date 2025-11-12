import { db } from '../server/db';
import { customers, salesCards } from '../shared/schema';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { calculateNextVisitDate } from '../shared/visitSchedule';

/**
 * Script de inicialização para criar cards permanentes para todos os clientes ativos elegíveis
 * 
 * REQUISITOS PARA ELEGIBILIDADE:
 * - Cliente ativo (is_active = true)
 * - Tem vendedor atribuído (seller_id NOT NULL)
 * - Tem dias de visita configurados (weekdays NOT NULL)
 * - Tem periodicidade configurada (visit_periodicity NOT NULL)
 * - Tem coordenadas válidas (latitude AND longitude NOT NULL)
 * 
 * CARDS CRIADOS COM:
 * - isPermanent = true
 * - nextVisitDate calculado com timezone de São Paulo
 * - status = 'pending'
 * - recurrenceType baseado em visitPeriodicity
 * - routeDay baseado no primeiro weekday
 */

interface Stats {
  total: number;
  eligible: number;
  created: number;
  skipped: number;
  errors: number;
  reasons: {
    noSeller: number;
    noWeekdays: number;
    noPeriodicity: number;
    noCoordinates: number;
    alreadyHasCard: number;
    invalidData: number;
  };
}

async function initializePermanentCards() {
  console.log('\n🚀 INICIALIZANDO CARDS PERMANENTES\n');
  console.log('=' .repeat(60));
  
  const stats: Stats = {
    total: 0,
    eligible: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    reasons: {
      noSeller: 0,
      noWeekdays: 0,
      noPeriodicity: 0,
      noCoordinates: 0,
      alreadyHasCard: 0,
      invalidData: 0,
    }
  };

  try {
    // 1. Buscar todos os clientes ativos
    console.log('\n📊 Buscando clientes ativos...');
    const allCustomers = await db.select()
      .from(customers)
      .where(eq(customers.isActive, true));
    
    stats.total = allCustomers.length;
    console.log(`   ✓ Encontrados ${stats.total} clientes ativos\n`);

    // 2. Processar cada cliente
    console.log('🔄 Processando clientes...\n');
    
    for (const customer of allCustomers) {
      try {
        // Validar elegibilidade
        if (!customer.sellerId) {
          stats.reasons.noSeller++;
          console.log(`   ⚠️  SKIP ${customer.name}: sem vendedor atribuído`);
          continue;
        }

        if (!customer.weekdays) {
          stats.reasons.noWeekdays++;
          console.log(`   ⚠️  SKIP ${customer.name}: sem dias de visita configurados`);
          continue;
        }

        if (!customer.visitPeriodicity) {
          stats.reasons.noPeriodicity++;
          console.log(`   ⚠️  SKIP ${customer.name}: sem periodicidade configurada`);
          continue;
        }

        if (!customer.latitude || !customer.longitude) {
          stats.reasons.noCoordinates++;
          console.log(`   ⚠️  SKIP ${customer.name}: sem coordenadas`);
          continue;
        }

        // Cliente é elegível
        stats.eligible++;

        // Verificar se já tem card permanente
        const existingCard = await db.select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, customer.id),
              eq(salesCards.isPermanent, true)
            )
          )
          .limit(1);

        if (existingCard.length > 0) {
          stats.reasons.alreadyHasCard++;
          stats.skipped++;
          console.log(`   ↩️  SKIP ${customer.name}: já tem card permanente`);
          continue;
        }

        // Calcular nextVisitDate
        let weekdaysArray: string[];
        try {
          weekdaysArray = JSON.parse(customer.weekdays);
        } catch {
          stats.reasons.invalidData++;
          console.log(`   ❌ ERRO ${customer.name}: weekdays inválido (${customer.weekdays})`);
          continue;
        }

        if (!Array.isArray(weekdaysArray) || weekdaysArray.length === 0) {
          stats.reasons.invalidData++;
          console.log(`   ❌ ERRO ${customer.name}: weekdays vazio`);
          continue;
        }

        const now = new Date();
        const scheduleResult = calculateNextVisitDate({
          weekdays: weekdaysArray,
          periodicity: customer.visitPeriodicity,
          referenceDate: now
        });
        
        const nextVisitDate = scheduleResult.nextDate;

        // Determinar routeDay (primeiro weekday)
        const routeDay = weekdaysArray[0];

        // Mapear visitPeriodicity para recurrenceType
        const recurrenceType = customer.visitPeriodicity;

        // Criar card permanente
        await db.insert(salesCards).values({
          customerId: customer.id,
          sellerId: customer.sellerId,
          isPermanent: true,
          status: 'pending',
          nextVisitDate: nextVisitDate,
          scheduledDate: nextVisitDate, // Manter compatibilidade
          daysOverdue: 0,
          routeDay: routeDay,
          recurrenceType: recurrenceType,
          isRecurring: true,
          paymentMethod: 'a_vista',
          operationType: 'venda',
          deliveryWeekdays: weekdaysArray,
          deliveryTimeSlots: [],
          customerLatitude: customer.latitude,
          customerLongitude: customer.longitude,
          products: [],
          source: 'integra',
        });

        stats.created++;
        
        if (stats.created % 50 === 0) {
          console.log(`   ✅ Progresso: ${stats.created} cards criados...`);
        }

      } catch (error: any) {
        stats.errors++;
        console.error(`   ❌ ERRO ao processar ${customer.name}:`, error.message);
      }
    }

    // 3. Relatório final
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 RELATÓRIO FINAL\n');
    console.log(`Total de clientes ativos:     ${stats.total}`);
    console.log(`Clientes elegíveis:           ${stats.eligible}`);
    console.log(`Cards criados:                ${stats.created} ✅`);
    console.log(`Cards pulados:                ${stats.skipped}`);
    console.log(`Erros:                        ${stats.errors}\n`);
    
    console.log('📋 MOTIVOS DE EXCLUSÃO:\n');
    console.log(`   Sem vendedor:              ${stats.reasons.noSeller}`);
    console.log(`   Sem dias de visita:        ${stats.reasons.noWeekdays}`);
    console.log(`   Sem periodicidade:         ${stats.reasons.noPeriodicity}`);
    console.log(`   Sem coordenadas:           ${stats.reasons.noCoordinates}`);
    console.log(`   Já tem card:               ${stats.reasons.alreadyHasCard}`);
    console.log(`   Dados inválidos:           ${stats.reasons.invalidData}\n`);
    
    console.log('='.repeat(60));
    console.log('\n✨ INICIALIZAÇÃO CONCLUÍDA!\n');

    // 4. Validação pós-execução
    console.log('🔍 Validando criação...\n');
    const totalPermanentCards = await db.select({ count: sql`count(*)` })
      .from(salesCards)
      .where(eq(salesCards.isPermanent, true));
    
    console.log(`   Total de cards permanentes no banco: ${totalPermanentCards[0].count}`);
    console.log(`   Cards criados nesta execução: ${stats.created}\n`);

  } catch (error) {
    console.error('\n❌ ERRO FATAL:', error);
    process.exit(1);
  }

  process.exit(0);
}

// Executar
initializePermanentCards();
