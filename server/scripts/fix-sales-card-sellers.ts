import { db } from '../db';
import { salesCards, customers } from '@shared/schema';
import { eq, and } from 'drizzle-orm';

async function fixSalesCardSellers() {
  try {
    console.log('🔧 Iniciando correção de vendedores nos sales cards...\n');
    
    // Buscar todos os sales cards
    const allCards = await db
      .select({
        cardId: salesCards.id,
        customerId: salesCards.customerId,
        currentSellerId: salesCards.sellerId,
        status: salesCards.status
      })
      .from(salesCards);

    console.log(`📋 Encontrados ${allCards.length} sales cards\n`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const card of allCards) {
      try {
        // Buscar cliente
        const [customer] = await db
          .select()
          .from(customers)
          .where(eq(customers.id, card.customerId))
          .limit(1);

        if (!customer) {
          console.log(`⚠️ Cliente ${card.customerId} não encontrado para card ${card.cardId}`);
          errors++;
          continue;
        }

        // Se cliente não tem vendedor, pular
        if (!customer.sellerId) {
          skipped++;
          continue;
        }

        // Se o card já tem o vendedor correto, pular
        if (card.currentSellerId === customer.sellerId) {
          skipped++;
          continue;
        }

        // Atualizar sales card com vendedor correto
        await db
          .update(salesCards)
          .set({ sellerId: customer.sellerId })
          .where(eq(salesCards.id, card.cardId));

        console.log(`✅ Card ${card.cardId}: ${card.currentSellerId} → ${customer.sellerId}`);
        updated++;

        // Log a cada 100
        if (updated % 100 === 0) {
          console.log(`   → ${updated} cards atualizados...`);
        }

      } catch (error) {
        errors++;
        console.error(`❌ Erro ao processar card ${card.cardId}:`, error);
      }
    }

    console.log(`\n✅ Correção concluída:`);
    console.log(`   - Cards atualizados: ${updated}`);
    console.log(`   - Cards pulados (já corretos ou sem vendedor): ${skipped}`);
    console.log(`   - Erros: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

fixSalesCardSellers();
