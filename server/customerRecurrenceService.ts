import { eq, and, or } from 'drizzle-orm';
import { db } from './db';
import { customers, salesCards, dailyRoutes } from '@shared/schema';
import { calculateNextVisitDate } from '@shared/visitSchedule';
import { fromZonedTime } from 'date-fns-tz';

interface RecurrenceChange {
  weekdays?: string[];
  visitPeriodicity?: 'semanal' | 'quinzenal' | 'mensal';
  sellerId?: string;
}

interface PreviousState {
  sellerId?: string;
  weekdays?: string[];
  visitPeriodicity?: 'semanal' | 'quinzenal' | 'mensal';
}

interface RecurrenceUpdateResult {
  success: boolean;
  previousNextVisitDate: Date | null;
  newNextVisitDate: Date | null;
  invalidatedRoutes: string[];
  message?: string;
}

export async function applyCustomerRecurrenceChange(
  customerId: string,
  changes: RecurrenceChange,
  previousState: PreviousState
): Promise<RecurrenceUpdateResult> {
  console.info('[RECURRENCE]', {
    customerId,
    changes,
    previousState,
    timestamp: new Date().toISOString()
  });

  return await db.transaction(async (tx) => {
    const customer = await tx.select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    if (customer.length === 0) {
      return {
        success: false,
        previousNextVisitDate: null,
        newNextVisitDate: null,
        invalidatedRoutes: [],
        message: 'Cliente não encontrado'
      };
    }

    const currentCustomer = customer[0];
    
    const permanentCards = await tx.select()
      .from(salesCards)
      .where(and(
        eq(salesCards.customerId, customerId),
        eq(salesCards.isPermanent, true)
      ))
      .limit(1);

    if (permanentCards.length === 0) {
      console.log(`⚠️ [RECURRENCE-UPDATE] Cliente ${customerId} não possui permanent card`);
      return {
        success: false,
        previousNextVisitDate: null,
        newNextVisitDate: null,
        invalidatedRoutes: [],
        message: 'Cliente não possui permanent card'
      };
    }

    const permanentCard = permanentCards[0];
    const previousNextVisitDate = permanentCard.nextVisitDate;

    const finalWeekdays = changes.weekdays || currentCustomer.weekdays || [];
    const finalPeriodicity = changes.visitPeriodicity || currentCustomer.visitPeriodicity || 'semanal';
    const finalSellerId = changes.sellerId || currentCustomer.sellerId;

    console.log(`📊 [RECURRENCE-UPDATE] Estado anterior:`);
    console.log(`   - weekdays: ${JSON.stringify(currentCustomer.weekdays)}`);
    console.log(`   - periodicity: ${currentCustomer.visitPeriodicity}`);
    console.log(`   - nextVisitDate: ${previousNextVisitDate}`);
    console.log(`📊 [RECURRENCE-UPDATE] Novo estado:`);
    console.log(`   - weekdays: ${JSON.stringify(finalWeekdays)}`);
    console.log(`   - periodicity: ${finalPeriodicity}`);

    if (finalWeekdays.length === 0) {
      console.log(`⚠️ [RECURRENCE-UPDATE] Cliente sem dias da semana configurados`);
      return {
        success: false,
        previousNextVisitDate,
        newNextVisitDate: null,
        invalidatedRoutes: [],
        message: 'Cliente sem dias da semana configurados'
      };
    }

    const result = calculateNextVisitDate({
      weekdays: Array.isArray(finalWeekdays) ? finalWeekdays : [finalWeekdays],
      periodicity: finalPeriodicity
    });

    const newNextVisitDate = result.nextDate;

    console.log(`   - NOVO nextVisitDate calculado: ${newNextVisitDate}`);

    await tx.update(salesCards)
      .set({
        nextVisitDate: newNextVisitDate,
        sellerId: finalSellerId
      })
      .where(eq(salesCards.id, permanentCard.id));

    console.log(`✅ [RECURRENCE-UPDATE] Permanent card atualizado com sucesso`);

    const invalidatedRoutes: string[] = [];

    const hasSellerChanged = previousState.sellerId && previousState.sellerId !== finalSellerId;
    const hasDateChanged = previousNextVisitDate && newNextVisitDate &&
      new Date(previousNextVisitDate).toISOString().split('T')[0] !== new Date(newNextVisitDate).toISOString().split('T')[0];

    if (previousNextVisitDate && (hasDateChanged || hasSellerChanged)) {
      const previousDateStr = new Date(previousNextVisitDate).toISOString().split('T')[0];
      const previousRouteDate = fromZonedTime(`${previousDateStr}T00:00:00`, 'America/Sao_Paulo');
      const previousSellerId = previousState.sellerId || finalSellerId;

      if (hasDateChanged && hasSellerChanged) {
        console.info('[RECURRENCE] Data e vendedor mudaram', {
          customerId,
          previousDate: previousDateStr,
          newDate: new Date(newNextVisitDate!).toISOString().split('T')[0],
          previousSeller: previousSellerId,
          newSeller: finalSellerId
        });
      } else if (hasDateChanged) {
        console.info('[RECURRENCE] Data de visita mudou', {
          customerId,
          previousDate: previousDateStr,
          newDate: new Date(newNextVisitDate!).toISOString().split('T')[0]
        });
      } else if (hasSellerChanged) {
        console.info('[RECURRENCE] Vendedor mudou sem alterar data', {
          customerId,
          previousSeller: previousSellerId,
          newSeller: finalSellerId,
          visitDate: previousDateStr
        });
      }

      const affectedRoutes = await tx.select()
        .from(dailyRoutes)
        .where(and(
          eq(dailyRoutes.sellerId, previousSellerId || ''),
          eq(dailyRoutes.routeDate, previousRouteDate)
        ));

      for (const route of affectedRoutes) {
        if (!route.optimizedOrder || route.optimizedOrder.length === 0) {
          continue;
        }
        
        if (route.optimizedOrder.includes(customerId)) {
          const updatedOrder = route.optimizedOrder.filter(id => id !== customerId);
          
          await tx.update(dailyRoutes)
            .set({
              optimizedOrder: updatedOrder,
              totalVisits: updatedOrder.length
            })
            .where(eq(dailyRoutes.id, route.id));

          invalidatedRoutes.push(route.id);
          console.info('[RECURRENCE] Cliente removido da rota antiga', {
            customerId,
            routeId: route.id,
            routeDate: previousDateStr,
            previousSellerId,
            reason: hasDateChanged ? 'data_mudou' : 'vendedor_mudou'
          });
        }
      }
    }

    console.log(`✅ [RECURRENCE-UPDATE] Atualização concluída: ${invalidatedRoutes.length} rotas invalidadas`);

    return {
      success: true,
      previousNextVisitDate,
      newNextVisitDate,
      invalidatedRoutes
    };
  });
}
