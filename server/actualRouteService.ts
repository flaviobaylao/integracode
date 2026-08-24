import { DatabaseStorage } from './storage';
import { calculateRealDistance } from './routingService';
// Hora oficial do Brasil — regra unica em shared/tempo.ts.
import { agora } from '@shared/tempo';

// (24/ago/2026) Coordenada valida? Descarta (0,0)/nula/fora de faixa. Sem isto, uma
// casa de vendedor nao configurada (start = 0,0 no golfo da Guine) inflava a km:
// casa(0,0) -> check-in(Goiania) -> casa(0,0) somava ~5.710 km por perna (~11.421 km
// de km fantasma). Trechos com ponta invalida passam a valer 0.
function coordOk(lat: number, lon: number): boolean {
  if (!isFinite(lat) || !isFinite(lon)) return false;
  if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false; // (0,0) = nao configurada
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return true;
}

/**
 * Calcula a distância REAL percorrida baseada nos checkpoints (check-ins) realizados
 * Considera apenas visitas validadas (status !== 'cancelled')
 * Segue a ordem cronológica dos check-ins
 * Sempre parte da residência e retorna à residência
 */
export async function calculateActualRouteDistance(
  storage: DatabaseStorage,
  dailyRouteId: string
): Promise<{
  totalDistance: number;
  validatedVisits: number;
  offRouteVisits: number;
  cancelledVisits: number;
  segments: Array<{
    from: string;
    to: string;
    distance: number;
    isOffRoute: boolean;
    validationStatus: string;
  }>;
}> {
  // Buscar rota
  const route = await storage.getDailyRoute(dailyRouteId);
  if (!route) {
    throw new Error('Rota não encontrada');
  }

  // Buscar checkpoints em ordem cronológica (apenas check-ins)
  const allCheckpoints = await storage.getRouteCheckpoints(dailyRouteId);
  const checkIns = allCheckpoints
    .filter(cp => cp.checkpointType === 'check_in')
    .sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());

  const segments = [];
  let totalDistance = 0;
  let validatedVisits = 0;
  let offRouteVisits = 0;
  let cancelledVisits = 0;

  // Ponto de partida: casa do vendedor
  let previousLat = parseFloat(route.startLatitude);
  let previousLon = parseFloat(route.startLongitude);
  let previousName = 'Casa do Vendedor';
  let haveOrigin = coordOk(previousLat, previousLon);

  for (const checkpoint of checkIns) {
    const currentLat = parseFloat(checkpoint.checkpointLatitude as any);
    const currentLon = parseFloat(checkpoint.checkpointLongitude as any);
    
    // Buscar informações do cliente
    const { customers } = await import('../shared/schema');
    const { db } = await import('./db');
    const { eq } = await import('drizzle-orm');
    
    const [customer] = await db.select()
      .from(customers)
      .where(eq(customers.id, checkpoint.customerId))
      .limit(1);

    const customerName = customer?.name || 'Cliente desconhecido';
    
    // Contar tipo de visita
    if (checkpoint.isOffRoute) {
      offRouteVisits++;
    }
    
    if (checkpoint.validationStatus === 'cancelled') {
      cancelledVisits++;
    } else {
      validatedVisits++;
    }

    // Calcular distancia real apenas para visitas validadas E com coordenadas
    // validas nas duas pontas (evita km fantasma vinda de (0,0)/coordenada nula).
    let distance = 0;
    if (checkpoint.validationStatus !== 'cancelled' && haveOrigin && coordOk(currentLat, currentLon)) {
      try {
        const distanceMeters = await calculateRealDistance(
          previousLat,
          previousLon,
          currentLat,
          currentLon
        );
        distance = distanceMeters / 1000; // Converter para km
        totalDistance += distance;
      } catch (error) {
        console.error('Erro ao calcular distância real:', error);
      }
    }

    segments.push({
      from: previousName,
      to: customerName,
      distance: Math.round(distance * 100) / 100,
      isOffRoute: checkpoint.isOffRoute || false,
      validationStatus: checkpoint.validationStatus || 'validated'
    });

    // Se validada e com coordenada valida, vira o novo ponto de referencia (e passa
    // a haver origem, mesmo que a casa fosse invalida: o 1o check-in valido ancora).
    if (checkpoint.validationStatus !== 'cancelled' && coordOk(currentLat, currentLon)) {
      previousLat = currentLat;
      previousLon = currentLon;
      previousName = customerName;
      haveOrigin = true;
    }
  }

  // Distancia de retorno para casa (so se a casa tiver coordenada valida; casa (0,0)
  // nao gera perna de retorno - era metade da km fantasma).
  const homeLatChk = parseFloat(route.startLatitude);
  const homeLonChk = parseFloat(route.startLongitude);
  if (validatedVisits > 0 && haveOrigin && coordOk(homeLatChk, homeLonChk)) {
    try {
      const homeLat = parseFloat(route.startLatitude);
      const homeLon = parseFloat(route.startLongitude);
      const returnDistanceMeters = await calculateRealDistance(
        previousLat,
        previousLon,
        homeLat,
        homeLon
      );
      const returnDistance = returnDistanceMeters / 1000;
      totalDistance += returnDistance;

      segments.push({
        from: previousName,
        to: 'Casa do Vendedor (Retorno)',
        distance: Math.round(returnDistance * 100) / 100,
        isOffRoute: false,
        validationStatus: 'validated'
      });
    } catch (error) {
      console.error('Erro ao calcular distância de retorno:', error);
    }
  }

  return {
    totalDistance: Math.round(totalDistance * 100) / 100,
    validatedVisits,
    offRouteVisits,
    cancelledVisits,
    segments
  };
}

/**
 * Valida uma visita fora da rota
 */
export async function validateOffRouteVisit(
  storage: DatabaseStorage,
  checkpointId: string,
  adminId: string
): Promise<void> {
  const checkpoint = await storage.getRouteCheckpointById(checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'validated',
    validatedBy: adminId,
    validatedAt: agora()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(checkpoint.dailyRouteId, storage);
}

/**
 * Cancela uma visita fora da rota
 */
export async function cancelOffRouteVisit(
  storage: DatabaseStorage,
  checkpointId: string,
  adminId: string
): Promise<void> {
  const checkpoint = await storage.getRouteCheckpointById(checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'cancelled',
    validatedBy: adminId,
    validatedAt: agora()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(checkpoint.dailyRouteId, storage);
}

/**
 * Recalcula a distância total da rota baseado nos checkpoints validados
 */
export async function recalculateRouteDistance(
  dailyRouteId: string,
  storage: DatabaseStorage
): Promise<void> {
  const result = await calculateActualRouteDistance(storage, dailyRouteId);
  
  await storage.updateDailyRoute(dailyRouteId, {
    totalActualDistance: result.totalDistance.toString(),
    completedVisits: result.validatedVisits
  });
}
