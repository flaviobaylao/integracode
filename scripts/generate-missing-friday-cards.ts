import { db } from '../server/db';
import { customers, salesCards } from '../shared/schema';
import { eq, and, sql } from 'drizzle-orm';

const TARGET_DATE = new Date('2025-10-25T08:00:00-03:00'); // Sexta, 25/10/2025

async function generateMissingFridayCards() {
  console.log(`\n🎯 Gerando cards faltantes para SEXTA-FEIRA ${TARGET_DATE.toISOString().split('T')[0]}\n`);
  
  try {
    // Buscar todos os clientes ativos que têm SEXTA configurada
    const allCustomers = await db.select()
      .from(customers)
      .where(
        and(
          eq(customers.isActive, true),
          sql`${customers.weekdays}::text LIKE '%sexta%'`
        )
      );
    
    console.log(`📊 Total de clientes com sexta configurada: ${allCustomers.length}`);
    
    let created = 0;
    let skipped = 0;
    
    for (const customer of allCustomers) {
      // Verificar se já existe card para essa data
      const existing = await db.select()
        .from(salesCards)
        .where(
          and(
            eq(salesCards.customerId, customer.id),
            sql`DATE(${salesCards.scheduledDate}) = DATE(${TARGET_DATE.toISOString()})`
          )
        )
        .limit(1);
      
      if (existing.length > 0) {
        skipped++;
        continue;
      }
      
      // Criar card
      await db.insert(salesCards).values({
        customerId: customer.id,
        sellerId: customer.sellerId,
        scheduledDate: TARGET_DATE,
        status: 'pending',
        visitType: 'presencial',
        paymentMethod: customer.paymentMethod || 'Boleto',
        deliveryTimeSlots: customer.deliveryTimeSlots || ['manha'],
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: customer.address,
        customerLatitude: customer.latitude,
        customerLongitude: customer.longitude,
        routeDay: 'sexta',
        visitPeriodicity: customer.visitPeriodicity || 'semanal',
        nextCardId: null,
        previousCardId: null,
        totalValue: 0,
        isUrgentDelivery: false,
        exclusiveVehicle: false,
        vehicleTypes: []
      }).onConflictDoNothing();
      
      created++;
      
      if (created % 100 === 0) {
        console.log(`   ✅ ${created} cards criados...`);
      }
    }
    
    console.log(`\n✨ Geração concluída:`);
    console.log(`   - Cards criados: ${created}`);
    console.log(`   - Cards já existentes (pulados): ${skipped}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  }
}

generateMissingFridayCards();
