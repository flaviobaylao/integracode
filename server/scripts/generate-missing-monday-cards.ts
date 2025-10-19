import { db } from '../db';
import { salesCards, customers } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';

async function generateMondayCards() {
  try {
    console.log('📅 Gerando cards para segunda-feira 20/10/2025...\n');
    
    const targetDate = new Date('2025-10-20T08:00:00');
    const dayOfWeek = 'segunda';
    
    // Buscar clientes ativos com segunda-feira configurada
    const mondayClients = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.isActive, true),
          sql`${customers.weekdays}::text LIKE '%segunda%'`
        )
      );
    
    console.log(`📋 Encontrados ${mondayClients.length} clientes com segunda-feira configurada\n`);
    
    let created = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const customer of mondayClients) {
      try {
        // Verificar se já existe card para esta data
        const existingCard = await db
          .select()
          .from(salesCards)
          .where(
            and(
              eq(salesCards.customerId, customer.id),
              sql`DATE(${salesCards.scheduledDate}) = '2025-10-20'`
            )
          )
          .limit(1);
        
        if (existingCard.length > 0) {
          skipped++;
          continue;
        }
        
        // Verificar se cliente tem vendedor
        if (!customer.sellerId) {
          console.log(`⚠️ Cliente ${customer.name} sem vendedor`);
          skipped++;
          continue;
        }
        
        // Criar card para 20/10
        await db.insert(salesCards).values({
          customerId: customer.id,
          sellerId: customer.sellerId,
          status: 'pending',
          scheduledDate: targetDate,
          attendanceStartDate: new Date(),
          routeDay: dayOfWeek,
          recurrenceType: customer.visitPeriodicity || 'semanal',
          isRecurring: false,
          parentCardId: null, // Card inicial
          customerLatitude: customer.latitude || null,
          customerLongitude: customer.longitude || null
        } as any);
        
        created++;
        
        if (created % 50 === 0) {
          console.log(`✅ Criados: ${created}/${mondayClients.length}`);
        }
        
      } catch (error: any) {
        errors++;
        console.error(`❌ Erro ao criar card para ${customer.name}:`, error.message);
      }
    }
    
    console.log(`\n✅ Geração concluída:`);
    console.log(`   - Cards criados: ${created}`);
    console.log(`   - Clientes pulados: ${skipped}`);
    console.log(`   - Erros: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

generateMondayCards();
