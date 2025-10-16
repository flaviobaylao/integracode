import { db } from '../db';
import { salesCards, customers } from '@shared/schema';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { calculateNextVisitDate } from '@shared/visitSchedule';

async function unlockAllClients() {
  try {
    console.log('🔓 Iniciando desbloqueio de clientes...\n');
    
    // Buscar clientes com apenas 1 card pendente e sem next_card_id
    const clientsToUnlock = await db
      .select({
        customerId: customers.id,
        customerName: customers.name,
        visitPeriodicity: customers.visitPeriodicity,
        weekdays: customers.weekdays,
        cardId: salesCards.id,
        scheduledDate: salesCards.scheduledDate,
        sellerId: salesCards.sellerId,
        products: salesCards.products,
        saleValue: salesCards.saleValue,
        paymentMethod: salesCards.paymentMethod,
        operationType: salesCards.operationType,
        isRecurring: salesCards.isRecurring,
        boletoDays: salesCards.boletoDays,
        deliveryTimeSlots: salesCards.deliveryTimeSlots,
        deliverySaturdayTimeSlots: salesCards.deliverySaturdayTimeSlots,
        customerLatitude: salesCards.customerLatitude,
        customerLongitude: salesCards.customerLongitude,
        exclusiveVehicle: salesCards.exclusiveVehicle,
        vehicleTypes: salesCards.vehicleTypes
      })
      .from(customers)
      .innerJoin(salesCards, eq(customers.id, salesCards.customerId))
      .where(and(
        eq(salesCards.status, 'pending'),
        isNull(salesCards.nextCardId),
        isNull(salesCards.parentCardId)
      ))
      .orderBy(customers.id);

    console.log(`📋 Encontrados ${clientsToUnlock.length} clientes para desbloquear\n`);

    let unlocked = 0;
    let errors = 0;

    for (const client of clientsToUnlock) {
      try {
        if (!client.visitPeriodicity || !client.weekdays) {
          console.log(`⚠️ Pulando ${client.customerName}: sem periodicidade configurada`);
          continue;
        }

        // Parsear weekdays
        const parsedWeekdays = typeof client.weekdays === 'string' 
          ? JSON.parse(client.weekdays) 
          : client.weekdays;

        if (!parsedWeekdays || parsedWeekdays.length === 0) {
          console.log(`⚠️ Pulando ${client.customerName}: weekdays inválido`);
          continue;
        }

        // Calcular próxima visita
        const result = calculateNextVisitDate({
          weekdays: parsedWeekdays as any[],
          periodicity: client.visitPeriodicity as any,
          lastCompletedDate: client.scheduledDate
        });

        const nextDate = result.nextDate;
        const dayOfWeek = nextDate.getDay();
        const weekdayNames = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
        const derivedRouteDay = weekdayNames[dayOfWeek];

        // Inserir próximo card
        const [newCard] = await db.insert(salesCards).values({
          customerId: client.customerId,
          sellerId: client.sellerId,
          status: 'pending',
          scheduledDate: nextDate,
          attendanceStartDate: new Date(),
          routeDay: derivedRouteDay,
          recurrenceType: client.visitPeriodicity,
          isRecurring: client.isRecurring,
          parentCardId: client.cardId,
          products: client.products,
          saleValue: client.saleValue,
          paymentMethod: client.paymentMethod,
          operationType: client.operationType,
          boletoDays: client.boletoDays,
          deliveryTimeSlots: client.deliveryTimeSlots,
          deliverySaturdayTimeSlots: client.deliverySaturdayTimeSlots,
          customerLatitude: client.customerLatitude,
          customerLongitude: client.customerLongitude,
          exclusiveVehicle: client.exclusiveVehicle || false,
          vehicleTypes: (client.vehicleTypes || []) as any
        } as any).returning();

        // Atualizar card pai
        await db
          .update(salesCards)
          .set({ nextCardId: newCard.id })
          .where(eq(salesCards.id, client.cardId));

        unlocked++;
        if (unlocked % 50 === 0) {
          console.log(`✅ Desbloqueados: ${unlocked}/${clientsToUnlock.length}`);
        }

      } catch (error) {
        errors++;
        console.error(`❌ Erro ao desbloquear ${client.customerName}:`, error);
      }
    }

    console.log(`\n✅ Desbloqueio concluído:`);
    console.log(`   - Desbloqueados: ${unlocked}`);
    console.log(`   - Erros: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

unlockAllClients();
