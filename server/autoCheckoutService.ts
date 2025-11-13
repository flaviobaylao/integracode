import { db } from './db';
import { visitAgenda, salesCards, routeCheckpoints } from '@shared/schema';
import { eq, and, isNotNull, isNull, lt } from 'drizzle-orm';
import type { DatabaseStorage } from './storage';
import { registerCheckpoint } from './routeOptimizationService';

const AUTO_CHECKOUT_MINUTES = 30;

export async function processAutoCheckouts(storage: DatabaseStorage): Promise<{
  processed: number;
  errors: number;
}> {
  let processed = 0;
  let errors = 0;

  try {
    const thirtyMinutesAgo = new Date(Date.now() - AUTO_CHECKOUT_MINUTES * 60 * 1000);

    const visitsNeedingCheckout = await db
      .select()
      .from(visitAgenda)
      .where(
        and(
          isNotNull(visitAgenda.actualCheckIn),
          isNull(visitAgenda.actualCheckOut),
          lt(visitAgenda.actualCheckIn, thirtyMinutesAgo)
        )
      );

    console.log(`🤖 Auto check-out: ${visitsNeedingCheckout.length} visita(s) precisam de check-out automático`);

    for (const visit of visitsNeedingCheckout) {
      try {
        const checkInTime = new Date(visit.actualCheckIn!);
        const now = new Date();
        const minutesElapsed = Math.floor((now.getTime() - checkInTime.getTime()) / (60 * 1000));

        console.log(`  ⏰ Processando visita ${visit.id}: Check-in há ${minutesElapsed} minutos`);

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
            isAutoCheckout: true // Marcar como check-out automático (30min)
          })
          .where(eq(visitAgenda.id, visit.id));

        if (visit.salesCardId) {
          await db.update(salesCards)
            .set({
              checkOutTime: checkOutTime,
              checkOutLatitude: checkOutLat.toString(),
              checkOutLongitude: checkOutLon.toString(),
              status: 'completed'
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

        console.log(`  ✅ Check-out automático realizado para visita ${visit.id}`);
        processed++;
      } catch (error: any) {
        console.error(`  ❌ Erro ao processar visita ${visit.id}:`, error.message);
        errors++;
      }
    }

    if (processed > 0) {
      console.log(`✅ Auto check-out finalizado: ${processed} processado(s), ${errors} erro(s)`);
    }

    return { processed, errors };
  } catch (error: any) {
    console.error('❌ Erro no serviço de auto check-out:', error);
    return { processed, errors: errors + 1 };
  }
}
