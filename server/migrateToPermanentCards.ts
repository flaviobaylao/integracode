import { db } from './db';
import { salesCards, orderHistory, customers } from '@shared/schema';
import { eq, and, ne, desc, sql } from 'drizzle-orm';

/**
 * Script de migração: Converte sistema de múltiplos sales_cards
 * para sistema de card permanente + order_history
 * 
 * Lógica:
 * 1. Para cada cliente, encontra todos os seus sales_cards
 * 2. Seleciona o card mais antigo como "card permanente"
 * 3. Converte todos os cards finalizados (completed, no_sale, cancelled) em registros de order_history
 * 4. Remove cards duplicados/futuros, mantendo apenas o permanente
 * 5. Atualiza o card permanente com flag isRecurring = false
 */

interface MigrationStats {
  customersProcessed: number;
  permanentCardsCreated: number;
  ordersHistoryCreated: number;
  cardsRemoved: number;
  errors: { customerId: string; error: string }[];
}

export async function migrateToPermanentCards(dryRun: boolean = true): Promise<MigrationStats> {
  const stats: MigrationStats = {
    customersProcessed: 0,
    permanentCardsCreated: 0,
    ordersHistoryCreated: 0,
    cardsRemoved: 0,
    errors: [],
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 MIGRATION TO PERMANENT CARDS ${dryRun ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // Buscar TODOS os clientes (ativos e inativos)
    // Precisamos processar todos para evitar deixar sistema em estado misto
    const allCustomers = await db
      .select()
      .from(customers);

    console.log(`📊 Found ${allCustomers.length} total customers (active + inactive)\n`);

    for (const customer of allCustomers) {
      try {
        stats.customersProcessed++;
        
        // Buscar todos os cards deste cliente
        const customerCards = await db
          .select()
          .from(salesCards)
          .where(eq(salesCards.customerId, customer.id))
          .orderBy(salesCards.createdAt); // Mais antigo primeiro

        if (customerCards.length === 0) {
          console.log(`⚠️  Customer ${customer.fantasyName} (${customer.id}): No cards found`);
          continue;
        }

        // Card permanente = card mais antigo
        const permanentCard = customerCards[0];
        const otherCards = customerCards.slice(1);

        console.log(`\n👤 Customer: ${customer.fantasyName}`);
        console.log(`   📋 Total cards: ${customerCards.length}`);
        console.log(`   ✅ Permanent card: ${permanentCard.id} (created: ${permanentCard.createdAt})`);

        // Atualizar o card permanente para não gerar novos cards
        if (!dryRun) {
          await db
            .update(salesCards)
            .set({
              isRecurring: false,
              notes: sql`COALESCE(${salesCards.notes}, '') || ' [Card Permanente - Migrado]'`,
            })
            .where(eq(salesCards.id, permanentCard.id));
          
          stats.permanentCardsCreated++;
          console.log(`   ✓ Marked as permanent`);
        } else {
          console.log(`   [DRY RUN] Would mark as permanent`);
        }

        // Processar outros cards (converter em order_history)
        for (const card of otherCards) {
          // Apenas cards finalizados viram histórico
          if (['completed', 'no_sale', 'cancelled', 'failed'].includes(card.status)) {
            
            // IMPORTANTE: Sempre criar registro de histórico para preservar dados
            // mesmo se não houver produtos/venda (registro de visitas sem venda)
            
            // Mapear status para os valores aceitos pelo order_history
            let historyStatus: 'pending' | 'completed' | 'cancelled' = 'cancelled';
            if (card.status === 'completed') {
              historyStatus = 'completed';
            } else if (card.status === 'no_sale' || card.status === 'failed' || card.status === 'cancelled') {
              historyStatus = 'cancelled';
            }
            
            // Garantir que products seja um array válido
            const products = (card.products && Array.isArray(card.products)) ? card.products : [];
            
            const orderData = {
              salesCardId: permanentCard.id, // Link para o card permanente
              orderDate: card.scheduledDate || card.createdAt,
              products: products,
              totalValue: card.saleValue || '0',
              status: historyStatus,
              notes: card.notes || (card.status === 'no_sale' ? `Sem venda - Motivo: ${card.noSaleReason || 'Não informado'}` : null),
              checkInTime: card.checkInTime || null,
              checkInLatitude: card.checkInLatitude || null,
              checkInLongitude: card.checkInLongitude || null,
              checkOutTime: card.checkOutTime || null,
              checkOutLatitude: card.checkOutLatitude || null,
              checkOutLongitude: card.checkOutLongitude || null,
              distanceToCustomer: card.distanceToCustomer || null,
              checkInPhotoUrl: card.checkInPhotoUrl || null,
              deliveryScheduledDate: card.deliveryScheduledDate || null,
              deliveryCompletedDate: card.deliveryCompletedDate || null,
              deliveryStatus: card.deliveryStatus || null,
              deliveryNotes: card.deliveryNotes || null,
              trackingCode: card.trackingCode || null,
              invoiceNumber: card.invoiceNumber || null,
              omieOrderId: card.omieOrderId || null,
            };

            if (!dryRun) {
              await db.insert(orderHistory).values(orderData as any);
              stats.ordersHistoryCreated++;
              console.log(`   ➕ Created order history from card ${card.id} (${card.status} → ${historyStatus})`);
            } else {
              console.log(`   [DRY RUN] Would create order history from card ${card.id} (${card.status} → ${historyStatus})`);
            }

            // Remover o card antigo após criar histórico
            if (!dryRun) {
              await db.delete(salesCards).where(eq(salesCards.id, card.id));
              stats.cardsRemoved++;
              console.log(`   ➖ Removed card ${card.id}`);
            } else {
              console.log(`   [DRY RUN] Would remove card ${card.id}`);
            }
          } else {
            // Cards pendentes/em progresso: apenas remover se forem futuros duplicados
            const isPending = card.status === 'pending';
            const isScheduledLater = card.scheduledDate && card.scheduledDate > new Date();
            
            if (isPending && isScheduledLater) {
              if (!dryRun) {
                await db.delete(salesCards).where(eq(salesCards.id, card.id));
                stats.cardsRemoved++;
                console.log(`   ➖ Removed future pending card ${card.id}`);
              } else {
                console.log(`   [DRY RUN] Would remove future pending card ${card.id}`);
              }
            } else {
              console.log(`   ⏭️  Kept active card ${card.id} (${card.status})`);
            }
          }
        }

      } catch (error: any) {
        console.error(`   ❌ Error processing customer ${customer.id}:`, error.message);
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
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 MIGRATION SUMMARY ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Customers processed:       ${stats.customersProcessed}`);
  console.log(`Permanent cards created:   ${stats.permanentCardsCreated}`);
  console.log(`Order history created:     ${stats.ordersHistoryCreated}`);
  console.log(`Cards removed:             ${stats.cardsRemoved}`);
  console.log(`Errors:                    ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log(`\n❌ Errors:`);
    stats.errors.forEach(err => {
      console.log(`   - Customer ${err.customerId}: ${err.error}`);
    });
  }
  
  console.log(`${'='.repeat(60)}\n`);

  return stats;
}

/**
 * Execução via linha de comando
 * Uso:
 *   tsx server/migrateToPermanentCards.ts --dry-run
 *   tsx server/migrateToPermanentCards.ts --execute
 */
if (require.main === module) {
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
}
