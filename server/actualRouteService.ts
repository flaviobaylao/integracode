import { DatabaseStorage } from './storage';
import { calculateRealDistance } from './routingService';

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

    // Calcular distância real apenas para visitas validadas
    let distance = 0;
    if (checkpoint.validationStatus !== 'cancelled') {
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

    // Se validada, atualizar ponto anterior
    if (checkpoint.validationStatus !== 'cancelled') {
      previousLat = currentLat;
      previousLon = currentLon;
      previousName = customerName;
    }
  }

  // Distância de retorno para casa (se houve algum check-in validado)
  if (validatedVisits > 0) {
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
  const checkpoints = await storage.getRouteCheckpoints(''); // Buscar todos primeiro
  const checkpoint = checkpoints.find(cp => cp.id === checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'validated',
    validatedBy: adminId,
    validatedAt: new Date()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(storage, checkpoint.dailyRouteId);
}

/**
 * Cancela uma visita fora da rota
 */
export async function cancelOffRouteVisit(
  storage: DatabaseStorage,
  checkpointId: string,
  adminId: string
): Promise<void> {
  const checkpoints = await storage.getRouteCheckpoints(''); // Buscar todos primeiro
  const checkpoint = checkpoints.find(cp => cp.id === checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'cancelled',
    validatedBy: adminId,
    validatedAt: new Date()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(storage, checkpoint.dailyRouteId);
}

/**
 * Recalcula a distância total da rota baseado nos checkpoints validados
 */
async function recalculateRouteDistance(
  storage: DatabaseStorage,
  dailyRouteId: string
): Promise<void> {
  const result = await calculateActualRouteDistance(storage, dailyRouteId);
  
  await storage.updateDailyRoute(dailyRouteId, {
    totalActualDistance: result.totalDistance.toString(),
    completedVisits: result.validatedVisits
  });
}
