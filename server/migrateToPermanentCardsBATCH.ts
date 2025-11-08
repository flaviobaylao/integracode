import { db } from './db';
import { salesCards, orderHistory, customers } from '@shared/schema';
import { eq, and, desc, isNotNull, sql, gt } from 'drizzle-orm';
import { calculateNextVisitDate } from '@shared/visitSchedule';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * VERSÃO BATCH PROCESSING + CHECKPOINT da migração
 * 
 * Processa clientes em lotes de 50 para evitar timeout/OOM
 * Salva checkpoint para permitir retomada
 */

interface MigrationCheckpoint {
  lastProcessedCustomerId: string;
  customersProcessed: number;
  permanentCardsCreated: number;
  ordersHistoryCreated: number;
  cardsRemoved: number;
  batchNumber: number;
}

interface MigrationStats extends MigrationCheckpoint {
  skipped: { customerId: string; reason: string }[];
  errors: { customerId: string; error: string }[];
}

const CHECKPOINT_FILE = '/tmp/migration-checkpoint.json';
const BATCH_SIZE = 50;

async function loadCheckpoint(): Promise<MigrationCheckpoint | null> {
  try {
    const data = await fs.readFile(CHECKPOINT_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveCheckpoint(checkpoint: MigrationCheckpoint): Promise<void> {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

export async function migrateToPermanentCardsBATCH(dryRun: boolean = true): Promise<MigrationStats> {
  const checkpoint = await loadCheckpoint();
  const stats: MigrationStats = checkpoint ? {
    ...checkpoint,
    skipped: [],
    errors: []
  } : {
    lastProcessedCustomerId: '',
    customersProcessed: 0,
    permanentCardsCreated: 0,
    ordersHistoryCreated: 0,
    cardsRemoved: 0,
    batchNumber: 0,
    skipped: [],
    errors: [],
  };

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔄 BATCH MIGRATION TO PERMANENT CARDS ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(80)}`);
  
  if (checkpoint) {
    console.log(`📌 RESUMING from checkpoint: Batch #${checkpoint.batchNumber}`);
    console.log(`   Last processed: ${checkpoint.lastProcessedCustomerId}`);
    console.log(`   Progress: ${checkpoint.customersProcessed} customers, ${checkpoint.permanentCardsCreated} cards\n`);
  }

  try {
    // Buscar clientes ativos (excluindo os já processados)
    const whereConditions = [
      eq(customers.isActive, true),
      isNotNull(customers.sellerId),
      isNotNull(customers.weekdays),
      isNotNull(customers.visitPeriodicity)
    ];
    
    if (checkpoint) {
      whereConditions.push(gt(customers.id, checkpoint.lastProcessedCustomerId));
    }

    const activeCustomers = await db
      .select()
      .from(customers)
      .where(and(...whereConditions))
      .orderBy(customers.id); // Order by ID para checkpoint funcionar

    console.log(`📊 Found ${activeCustomers.length} customers to process (total processed so far: ${stats.customersProcessed})\n`);

    // Processar em lotes de BATCH_SIZE
    for (let batchStart = 0; batchStart < activeCustomers.length; batchStart += BATCH_SIZE) {
      stats.batchNumber++;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, activeCustomers.length);
      const batch = activeCustomers.slice(batchStart, batchEnd);
      
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`📦 BATCH #${stats.batchNumber}: Processing customers ${batchStart + 1}-${batchEnd} of ${activeCustomers.length}`);
      console.log(`${'─'.repeat(80)}\n`);

      for (const customer of batch) {
        try {
          stats.customersProcessed++;
          stats.lastProcessedCustomerId = customer.id;
          
          // Parse weekdays
          let parsedWeekdays: string[];
          try {
            parsedWeekdays = typeof customer.weekdays === 'string' 
              ? JSON.parse(customer.weekdays) 
              : customer.weekdays;
          } catch (e) {
            console.log(`⏭️  SKIPPED: ${customer.fantasyName} - Invalid weekdays`);
            stats.skipped.push({ customerId: customer.id, reason: 'Invalid weekdays' });
            continue;
          }

          if (!parsedWeekdays || parsedWeekdays.length === 0) {
            console.log(`⏭️  SKIPPED: ${customer.fantasyName} - No weekdays configured`);
            stats.skipped.push({ customerId: customer.id, reason: 'No weekdays' });
            continue;
          }

          // Buscar cards existentes
          const existingCards = await db
            .select()
            .from(salesCards)
            .where(eq(salesCards.customerId, customer.id))
            .orderBy(desc(salesCards.scheduledDate));

          console.log(`👤 [${stats.customersProcessed}/${stats.customersProcessed + activeCustomers.length - batchEnd}] ${customer.fantasyName || 'null'}`);
          console.log(`   📋 Cards: ${existingCards.length} | 📅 Days: ${parsedWeekdays.join(',')} | 🔁 ${customer.visitPeriodicity}`);

          // ETAPA 1: Mover cards para order_history
          const insertedHistoryIds: string[] = [];

          for (const card of existingCards) {
            let historyStatus: 'pending' | 'completed' | 'cancelled';
            if (card.status === 'completed') {
              historyStatus = 'completed';
            } else if (['pending', 'open', 'in_progress'].includes(card.status)) {
              historyStatus = 'pending';
            } else {
              historyStatus = 'cancelled';
            }
            
            const products = (card.products && Array.isArray(card.products)) ? card.products : [];
            
            const orderData = {
              salesCardId: null,
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
              completedAt: card.status === 'completed' ? card.completedAt : null,
            };

            if (!dryRun) {
              const [inserted] = await db.insert(orderHistory).values(orderData).returning({ id: orderHistory.id });
              insertedHistoryIds.push(inserted.id);
              stats.ordersHistoryCreated++;
            }
          }

          // ETAPA 2: Calcular lastVisitDate e nextVisitDate
          const completedSales = existingCards.filter(c => c.status === 'completed');
          const lastSale = completedSales.length > 0 ? completedSales[0] : null;
          const lastVisitDate = lastSale?.scheduledDate || null;

          const today = new Date();
          const scheduleResult = calculateNextVisitDate({
            weekdays: parsedWeekdays,
            periodicity: customer.visitPeriodicity!,
            lastCompletedDate: lastVisitDate || undefined,
            referenceDate: today
          });
          const nextVisitDate = scheduleResult.nextDate;

          // ETAPA 3: Criar card permanente
          const permanentCardData = {
            customerId: customer.id,
            sellerId: customer.sellerId!,
            scheduledDate: null, // Cards permanentes não têm scheduled date fixo
            status: 'pending' as const,
            products: [],
            saleValue: '0',
            isPermanent: true,
            lastVisitDate: lastVisitDate,
            nextVisitDate: nextVisitDate,
            daysOverdue: 0,
            source: 'system' as const,
          };

          let permanentCardId: string | null = null;
          if (!dryRun) {
            const [created] = await db.insert(salesCards).values(permanentCardData).returning({ id: salesCards.id });
            permanentCardId = created.id;
            stats.permanentCardsCreated++;

            // ETAPA 4: Atualizar order_history para linkar ao card permanente
            if (insertedHistoryIds.length > 0) {
              await db
                .update(orderHistory)
                .set({ salesCardId: permanentCardId })
                .where(sql`id = ANY(${insertedHistoryIds})`);
            }

            // ETAPA 5: Deletar cards antigos
            await db.delete(salesCards).where(eq(salesCards.customerId, customer.id)).where(eq(salesCards.isPermanent, false));
            stats.cardsRemoved += existingCards.length;
          }

          console.log(`   ✅ Permanent card | 🗑️  ${existingCards.length} old | 📊 ${insertedHistoryIds.length} history`);

        } catch (error: any) {
          console.error(`   ❌ ERROR: ${error.message}`);
          stats.errors.push({ customerId: customer.id, error: error.message });
        }
      }

      // Salvar checkpoint após cada batch
      if (!dryRun) {
        await saveCheckpoint({
          lastProcessedCustomerId: stats.lastProcessedCustomerId,
          customersProcessed: stats.customersProcessed,
          permanentCardsCreated: stats.permanentCardsCreated,
          ordersHistoryCreated: stats.ordersHistoryCreated,
          cardsRemoved: stats.cardsRemoved,
          batchNumber: stats.batchNumber,
        });
        console.log(`\n💾 Checkpoint saved (batch #${stats.batchNumber})`);
      }
    }

    // Sumário final
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 MIGRATION SUMMARY`);
    console.log(`${'='.repeat(80)}`);
    console.log(`✅ Customers processed:      ${stats.customersProcessed}`);
    console.log(`✅ Permanent cards created:  ${stats.permanentCardsCreated}`);
    console.log(`✅ Orders history created:   ${stats.ordersHistoryCreated}`);
    console.log(`✅ Old cards removed:        ${stats.cardsRemoved}`);
    console.log(`⏭️  Customers skipped:       ${stats.skipped.length}`);
    console.log(`❌ Errors:                   ${stats.errors.length}`);
    
    if (stats.skipped.length > 0) {
      console.log(`\nSkipped customers:`);
      stats.skipped.forEach(s => console.log(`  - ${s.customerId}: ${s.reason}`));
    }
    
    if (stats.errors.length > 0) {
      console.log(`\nErrors:`);
      stats.errors.forEach(e => console.log(`  - ${e.customerId}: ${e.error}`));
    }
    
    console.log(`${'='.repeat(80)}\n`);
    
    // Limpar checkpoint se concluído com sucesso
    if (!dryRun && stats.errors.length === 0) {
      await fs.unlink(CHECKPOINT_FILE).catch(() => {});
      console.log(`🗑️  Checkpoint file deleted (migration complete)\n`);
    }

  } catch (error: any) {
    console.error(`\n❌ CRITICAL ERROR: ${error.message}`);
    throw error;
  }

  return stats;
}

// CLI execution
const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');

if (dryRun) {
  console.log(`\n⚠️  Running in DRY RUN mode. Use --execute to apply changes.\n`);
} else {
  console.log(`\n⚠️  Running in EXECUTE mode. Changes will be applied to database.\n`);
}

migrateToPermanentCardsBATCH(dryRun)
  .then(stats => {
    if (stats.errors.length === 0 && stats.skipped.length === 0) {
      console.log('✅ Migration completed successfully!');
    } else if (stats.errors.length > 0) {
      console.log(`⚠️  Migration completed with ${stats.errors.length} errors.`);
    } else {
      console.log('✅ Migration completed successfully!');
    }
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
