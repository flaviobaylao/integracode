import { db } from './db';
import { visitAgenda, salesCards, routeCheckpoints } from '@shared/schema';
import { eq, and, isNotNull, isNull, lt, inArray } from 'drizzle-orm';
import type { DatabaseStorage } from './storage';
import { registerCheckpoint } from './routeOptimizationService';

const AUTO_CHECKOUT_MINUTES = 20;

export async function processAutoCheckouts(storage: DatabaseStorage): Promise<{
  processed: number;
  errors: number;
  skippedWithOrder: number;
  skippedWithNoSale: number;
}> {
  let processed = 0;
  let errors = 0;
  let skippedWithOrder = 0;
  let skippedWithNoSale = 0;

  try {
    const twentyMinutesAgo = new Date(Date.now() - AUTO_CHECKOUT_MINUTES * 60 * 1000);

    const visitsNeedingCheckout = await db
      .select()
      .from(visitAgenda)
      .where(
        and(
          isNotNull(visitAgenda.actualCheckIn),
          isNull(visitAgenda.actualCheckOut),
          lt(visitAgenda.actualCheckIn, twentyMinutesAgo)
        )
      );

    console.log(`🤖 Auto check-out: ${visitsNeedingCheckout.length} visita(s) precisam de check-out automático (após ${AUTO_CHECKOUT_MINUTES} min)`);

    for (const visit of visitsNeedingCheckout) {
      try {
        const checkInTime = new Date(visit.actualCheckIn!);
        const now = new Date();
        const minutesElapsed = Math.floor((now.getTime() - checkInTime.getTime()) / (60 * 1000));

        // Verificar se há pedido ou não-venda registrado no sales_card
        if (visit.salesCardId) {
          const [salesCard] = await db
            .select({ status: salesCards.status })
            .from(salesCards)
            .where(eq(salesCards.id, visit.salesCardId))
            .limit(1);
          
          if (salesCard) {
            // Se já tem pedido registrado (completed), não fazer auto check-out
            if (salesCard.status === 'completed') {
              console.log(`  ⏭️ Visita ${visit.id}: Pedido já registrado, aguardando check-out manual`);
              skippedWithOrder++;
              continue;
            }
            
            // Se já tem não-venda registrada, não fazer auto check-out
            if (salesCard.status === 'no_sale') {
              console.log(`  ⏭️ Visita ${visit.id}: Não-venda já registrada, aguardando check-out manual`);
              skippedWithNoSale++;
              continue;
            }
          }
        }

        console.log(`  ⏰ Processando visita ${visit.id}: Check-in há ${minutesElapsed} minutos, sem pedido/não-venda`);

        const checkOutTime = new Date();
        const checkOutLat = visit.checkInLatitude ? parseFloat(visit.checkInLatitude.toString()) : null;
        const checkOutLon = visit.checkInLongitude ? parseFloat(visit.checkInLongitude.toString()) : null;

        if (!checkOutLat || !checkOutLon) {
          console.error(`  ❌ Visita ${visit.id}: Coordenadas de check-in inválidas`);
          errors++;
          continue;
        }

        const visitDuration = Math.round((checkOutTime.getTime() - checkInTime.getTime()) / 60000); // em minutos
        
        await db.update(visitAgenda)
          .set({
            actualCheckOut: checkOutTime,
            checkOutLatitude: checkOutLat.toString(),
            checkOutLongitude: checkOutLon.toString(),
            visitStatus: 'completed',
            visitDuration: visitDuration,
            isAutoCheckout: true // Marcar como check-out automático (20min sem pedido/não-venda)
          })
          .where(eq(visitAgenda.id, visit.id));

        if (visit.salesCardId) {
          // Apenas atualiza dados de check-out, mantém o status atual do card
          // NÃO muda para 'completed' pois isso significa que um pedido foi registrado
          await db.update(salesCards)
            .set({
              checkOutTime: checkOutTime,
              checkOutLatitude: checkOutLat.toString(),
              checkOutLongitude: checkOutLon.toString()
              // Status permanece inalterado (pending/in_progress)
            })
            .where(eq(salesCards.id, visit.salesCardId));
        }

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const dailyRoute = await storage.getDailyRouteBySellerAndDate(visit.sellerId, today);

        if (dailyRoute) {
          await registerCheckpoint(
            storage,
            dailyRoute.id,
            visit.id,
            visit.customerId,
            visit.sellerId,
            'check_out',
            checkOutLat,
            checkOutLon
          );
        }

        console.log(`  ✅ Check-out automático realizado para visita ${visit.id} (${minutesElapsed}min sem pedido/não-venda)`);
        processed++;
      } catch (error: any) {
        console.error(`  ❌ Erro ao processar visita ${visit.id}:`, error.message);
        errors++;
      }
    }

    if (processed > 0 || skippedWithOrder > 0 || skippedWithNoSale > 0) {
      console.log(`✅ Auto check-out finalizado: ${processed} processado(s), ${skippedWithOrder} com pedido, ${skippedWithNoSale} com não-venda, ${errors} erro(s)`);
    }

    return { processed, errors, skippedWithOrder, skippedWithNoSale };
  } catch (error: any) {
    console.error('❌ Erro no serviço de auto check-out:', error);
    return { processed, errors: errors + 1, skippedWithOrder, skippedWithNoSale };
  }
}
