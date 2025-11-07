import { db } from './db';
import { salesCards, orderHistory, customers } from '@shared/schema';
import { eq, and, desc, isNotNull, sql } from 'drizzle-orm';
import { calculateNextVisitDate } from '@shared/visitSchedule';

/**
 * Script de migração: Converte sistema de múltiplos sales_cards
 * para sistema de CARD PERMANENTE + order_history
 * 
 * NOVA ARQUITETURA:
 * - 1 sales_card PERMANENTE por cliente ativo (isPermanent=true)
 * - Próxima visita calculada dinamicamente (customers.weekdays + visitPeriodicity)
 * - Histórico de pedidos em order_history
 * - scheduledDate = NULL para cards permanentes (calculado on-demand)
 * 
 * LÓGICA:
 * 1. Para cada cliente ATIVO, criar UM card permanente novo
 * 2. Mover TODOS os cards antigos (completed, failed, cancelled) para order_history
 * 3. Calcular lastVisitDate (última venda em order_history)
 * 4. Calcular nextVisitDate (baseado em weekdays + periodicity + lastVisitDate)
 * 5. Deletar todos os sales_cards antigos
 */

interface MigrationStats {
  customersProcessed: number;
  permanentCardsCreated: number;
  ordersHistoryCreated: number;
  cardsRemoved: number;
  skipped: { customerId: string; reason: string }[];
  errors: { customerId: string; error: string }[];
}

export async function migrateToPermanentCards(dryRun: boolean = true): Promise<MigrationStats> {
  const stats: MigrationStats = {
    customersProcessed: 0,
    permanentCardsCreated: 0,
    ordersHistoryCreated: 0,
    cardsRemoved: 0,
    skipped: [],
    errors: [],
  };

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔄 MIGRATION TO PERMANENT CARDS ARCHITECTURE ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    // Buscar APENAS clientes ATIVOS (inativos não precisam de card permanente)
    const activeCustomers = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.isActive, true),
          isNotNull(customers.sellerId),
          isNotNull(customers.weekdays),
          isNotNull(customers.visitPeriodicity)
        )
      );

    console.log(`📊 Found ${activeCustomers.length} active customers with configuration\n`);

    for (const customer of activeCustomers) {
      try {
        stats.customersProcessed++;
        
        // Parse weekdays
        let parsedWeekdays: string[];
        try {
          parsedWeekdays = typeof customer.weekdays === 'string' 
            ? JSON.parse(customer.weekdays) 
            : customer.weekdays;
        } catch (e) {
          console.log(`⏭️  SKIPPED: ${customer.fantasyName} - Invalid weekdays: ${customer.weekdays}`);
          stats.skipped.push({ customerId: customer.id, reason: 'Invalid weekdays' });
          continue;
        }

        if (!parsedWeekdays || parsedWeekdays.length === 0) {
          console.log(`⏭️  SKIPPED: ${customer.fantasyName} - No weekdays configured`);
          stats.skipped.push({ customerId: customer.id, reason: 'No weekdays' });
          continue;
        }

        // Buscar todos os cards existentes deste cliente
        const existingCards = await db
          .select()
          .from(salesCards)
          .where(eq(salesCards.customerId, customer.id))
          .orderBy(desc(salesCards.scheduledDate));

        console.log(`\n👤 ${customer.fantasyName} (${customer.id})`);
        console.log(`   📋 Existing cards: ${existingCards.length}`);
        console.log(`   📅 Weekdays: ${parsedWeekdays.join(', ')}`);
        console.log(`   🔁 Periodicity: ${customer.visitPeriodicity}`);

        // ETAPA 1: Mover TODOS os cards (incluindo pending/open) para order_history
        // Rastreamos os IDs inseridos para linkar ao card permanente depois
        const insertedHistoryIds: string[] = [];

        for (const card of existingCards) {
          // Determinar status de histórico
          let historyStatus: 'pending' | 'completed' | 'cancelled';
          if (card.status === 'completed') {
            historyStatus = 'completed';
          } else if (['pending', 'open', 'in_progress'].includes(card.status)) {
            historyStatus = 'pending'; // Cards não finalizados ficam como pending
          } else {
            historyStatus = 'cancelled'; // failed, no_sale, cancelled
          }
          
          const products = (card.products && Array.isArray(card.products)) ? card.products : [];
          
          const orderData = {
            salesCardId: null, // Será linkado ao card permanente depois (via insertedHistoryIds)
            orderDate: card.scheduledDate || card.createdAt,
            products: products,
            totalValue: card.saleValue || '0',
            status: historyStatus,
            notes: card.notes || (card.status === 'no_sale' ? `Sem venda - ${card.noSaleReason}` : null),
            checkInTime: card.checkInTime,
            checkInLatitude: card.checkInLatitude,
            checkInLongitude: card.checkInLongitude,
            checkOutTime: card.checkOutTime,
            checkOutLatitude: card.checkOutLatitude,
            checkOutLongitude: card.checkOutLongitude,
            distanceToCustomer: card.distanceToCustomer,
            checkInPhotoUrl: card.checkInPhotoUrl,
            deliveryScheduledDate: card.deliveryScheduledDate,
            deliveryCompletedDate: card.deliveryCompletedDate,
            deliveryStatus: card.deliveryStatus,
            deliveryNotes: card.deliveryNotes,
            trackingCode: card.trackingCode,
            invoiceNumber: card.invoiceNumber,
            omieOrderId: card.omieOrderId,
          };

          if (!dryRun) {
            const [insertedHistory] = await db.insert(orderHistory).values(orderData as any).returning();
            insertedHistoryIds.push(insertedHistory.id); // CAPTURAR ID INSERIDO
            stats.ordersHistoryCreated++;
            console.log(`   ➕ order_history: ${card.scheduledDate?.toISOString().split('T')[0]} (${card.status} → ${historyStatus})`);
          } else {
            console.log(`   [DRY] order_history: ${card.scheduledDate?.toISOString().split('T')[0]} (${card.status} → ${historyStatus})`);
          }
        }

        // ETAPA 2: Calcular lastVisitDate (última venda completada)
        const lastCompletedCard = existingCards.find(card => card.status === 'completed');
        const lastVisitDate = lastCompletedCard?.scheduledDate || null;

        // ETAPA 3: Calcular nextVisitDate usando calculateNextVisitDate()
        let nextVisitDate: Date;
        try {
          const result = calculateNextVisitDate({
            weekdays: parsedWeekdays,
            periodicity: customer.visitPeriodicity as 'semanal' | 'quinzenal' | 'mensal',
            lastCompletedDate: lastVisitDate || undefined,
            referenceDate: new Date()
          });
          nextVisitDate = result.nextDate;
        } catch (e: any) {
          console.log(`   ❌ ERROR calculating nextVisitDate: ${e.message}`);
          stats.errors.push({ customerId: customer.id, error: e.message });
          continue;
        }

        // ETAPA 4: Criar NOVO card permanente
        const permanentCardData = {
          customerId: customer.id,
          sellerId: customer.sellerId,
          status: 'pending' as const,
          isPermanent: true,
          lastVisitDate: lastVisitDate,
          nextVisitDate: nextVisitDate,
          daysOverdue: 0,
          scheduledDate: null, // Cards permanentes não têm scheduledDate (calculado dinamicamente)
          routeDay: parsedWeekdays[0], // Primeiro dia da semana configurado
          recurrenceType: customer.visitPeriodicity || 'semanal',
          isRecurring: false, // Não gera mais cards automáticos
          notes: '[Card Permanente - Sistema migrado]',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        if (!dryRun) {
          const [newCard] = await db.insert(salesCards).values(permanentCardData as any).returning();
          stats.permanentCardsCreated++;
          
          // ETAPA 5: Atualizar APENAS os order_history criados NESTE loop com salesCardId do card permanente
          // FIX: Não usar WHERE IS NULL (pega históricos de outros clientes!) - usar lista de IDs inseridos
          if (insertedHistoryIds.length > 0) {
            await db
              .update(orderHistory)
              .set({ salesCardId: newCard.id })
              .where(sql`id = ANY(ARRAY[${sql.join(insertedHistoryIds.map(id => sql`${id}`), sql`, `)}]::varchar[])`);
            console.log(`   🔗 Linked ${insertedHistoryIds.length} history records to permanent card`);
          }
          
          console.log(`   ✅ PERMANENT CARD created: ${newCard.id}`);
          console.log(`      - Last visit: ${lastVisitDate?.toISOString().split('T')[0] || 'Never'}`);
          console.log(`      - Next visit: ${nextVisitDate.toISOString().split('T')[0]}`);
        } else {
          console.log(`   [DRY] PERMANENT CARD would be created`);
          console.log(`      - Last visit: ${lastVisitDate?.toISOString().split('T')[0] || 'Never'}`);
          console.log(`      - Next visit: ${nextVisitDate.toISOString().split('T')[0]}`);
        }

        // ETAPA 6: Deletar TODOS os cards antigos
        if (!dryRun) {
          for (const card of existingCards) {
            await db.delete(salesCards).where(eq(salesCards.id, card.id));
            stats.cardsRemoved++;
          }
          console.log(`   🗑️  Removed ${existingCards.length} old cards`);
        } else {
          console.log(`   [DRY] Would remove ${existingCards.length} old cards`);
        }

      } catch (error: any) {
        console.error(`   ❌ ERROR processing customer ${customer.fantasyName}:`, error.message);
        stats.errors.push({
          customerId: customer.id,
          error: error.message,
        });
      }
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  }

  // Relatório final
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 MIGRATION SUMMARY ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Customers processed:       ${stats.customersProcessed}`);
  console.log(`Permanent cards created:   ${stats.permanentCardsCreated}`);
  console.log(`Order history created:     ${stats.ordersHistoryCreated}`);
  console.log(`Cards removed:             ${stats.cardsRemoved}`);
  console.log(`Skipped:                   ${stats.skipped.length}`);
  console.log(`Errors:                    ${stats.errors.length}`);
  
  if (stats.skipped.length > 0) {
    console.log(`\n⚠️  Skipped customers:`);
    stats.skipped.slice(0, 10).forEach(item => {
      console.log(`   - ${item.customerId}: ${item.reason}`);
    });
    if (stats.skipped.length > 10) {
      console.log(`   ... and ${stats.skipped.length - 10} more`);
    }
  }
  
  if (stats.errors.length > 0) {
    console.log(`\n❌ Errors:`);
    stats.errors.forEach(err => {
      console.log(`   - ${err.customerId}: ${err.error}`);
    });
  }
  
  console.log(`${'='.repeat(80)}\n`);

  return stats;
}

/**
 * Execução via linha de comando
 * Uso:
 *   tsx server/migrateToPermanentCards.ts              (dry-run)
 *   tsx server/migrateToPermanentCards.ts --execute    (live)
 */
const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');

if (dryRun) {
  console.log('ℹ️  Running in DRY RUN mode. Use --execute to apply changes.\n');
} else {
  console.log('⚠️  Running in EXECUTE mode. Changes will be applied to database.\n');
}

migrateToPermanentCards(dryRun)
  .then(stats => {
    if (dryRun) {
      console.log('✅ Dry run completed. Review the output above.');
      console.log('💡 To execute the migration, run: tsx server/migrateToPermanentCards.ts --execute');
    } else {
      console.log('✅ Migration completed successfully!');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
