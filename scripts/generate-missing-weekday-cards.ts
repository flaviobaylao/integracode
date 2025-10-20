import { db } from '../server/db';
import { customers, salesCards } from '../shared/schema';
import { eq, and, sql } from 'drizzle-orm';

// Configurações para cada dia
const WEEKDAYS = [
  { name: 'quarta', date: '2025-10-22', dayName: 'QUARTA-FEIRA' },
  { name: 'quinta', date: '2025-10-23', dayName: 'QUINTA-FEIRA' }
];

async function generateMissingCards(weekdayConfig: any) {
  const TARGET_DATE = new Date(`${weekdayConfig.date}T08:00:00-03:00`);
  
  console.log(`\n🎯 Gerando cards para ${weekdayConfig.dayName} (${weekdayConfig.date})\n`);
  
  // Buscar clientes que têm esse dia configurado
  const allCustomers = await db.select()
    .from(customers)
    .where(
      and(
        eq(customers.isActive, true),
        sql`${customers.weekdays}::text LIKE ${`%${weekdayConfig.name}%`}`
      )
    );
  
  console.log(`📊 Total de clientes com ${weekdayConfig.name}: ${allCustomers.length}`);
  
  let created = 0;
  let skipped = 0;
  
  for (const customer of allCustomers) {
    // Verificar se já existe
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
      routeDay: weekdayConfig.name,
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
  
  console.log(`✨ ${weekdayConfig.dayName}: ${created} criados, ${skipped} pulados\n`);
  return { created, skipped };
}

async function main() {
  console.log('\n🚀 Iniciando geração de cards para dias faltantes...\n');
  
  const results = [];
  for (const config of WEEKDAYS) {
    const result = await generateMissingCards(config);
    results.push({ day: config.dayName, ...result });
  }
  
  console.log('\n📊 RESUMO FINAL:');
  results.forEach(r => {
    console.log(`   ${r.day}: ${r.created} criados, ${r.skipped} pulados`);
  });
  
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
