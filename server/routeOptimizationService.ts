import { DatabaseStorage } from './storage';

// Função Haversine para calcular distância entre dois pontos (em km)
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return Math.round(distance * 100) / 100; // Arredondar para 2 casas decimais
}

interface RoutePoint {
  id: string;
  latitude: number;
  longitude: number;
  customerName: string;
  customerAddress?: string;
}

interface OptimizedRoute {
  orderedPoints: RoutePoint[];
  totalDistance: number;
  segments: {
    from: RoutePoint | { latitude: number; longitude: number; name: string };
    to: RoutePoint;
    distance: number;
  }[];
}

/**
 * Calcula a distância total de uma rota (incluindo volta para casa)
 */
function calculateTotalRouteDistance(
  startLat: number,
  startLon: number,
  route: RoutePoint[]
): number {
  let totalDistance = 0;
  let currentLat = startLat;
  let currentLon = startLon;

  for (const point of route) {
    totalDistance += calculateDistance(currentLat, currentLon, point.latitude, point.longitude);
    currentLat = point.latitude;
    currentLon = point.longitude;
  }

  // Retorno para casa
  totalDistance += calculateDistance(currentLat, currentLon, startLat, startLon);
  
  return totalDistance;
}

/**
 * Algoritmo 2-opt otimizado para melhorar uma rota existente
 * Inverte segmentos da rota para reduzir a distância total
 * Usa cálculo de delta ao invés de recalcular toda a rota
 */
function twoOptOptimization(
  startLat: number,
  startLon: number,
  route: RoutePoint[]
): RoutePoint[] {
  if (route.length <= 2) return route;

  let bestRoute = [...route];
  let improved = true;
  let maxIterations = 50;
  let iteration = 0;

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    for (let i = 0; i < bestRoute.length - 1; i++) {
      for (let j = i + 2; j < bestRoute.length; j++) {
        // Calcular apenas o delta de distância (mais eficiente)
        // Pontos envolvidos na troca
        const pointBeforeI = i === 0 
          ? { latitude: startLat, longitude: startLon }
          : bestRoute[i - 1];
        const pointI = bestRoute[i];
        const pointJ = bestRoute[j];
        const pointAfterJ = j === bestRoute.length - 1
          ? { latitude: startLat, longitude: startLon }
          : bestRoute[j + 1];

        // Distância das arestas que serão removidas
        const oldDistance = 
          calculateDistance(pointBeforeI.latitude, pointBeforeI.longitude, pointI.latitude, pointI.longitude) +
          calculateDistance(pointJ.latitude, pointJ.longitude, pointAfterJ.latitude, pointAfterJ.longitude);

        // Distância das novas arestas após inversão
        const newDistance = 
          calculateDistance(pointBeforeI.latitude, pointBeforeI.longitude, pointJ.latitude, pointJ.longitude) +
          calculateDistance(pointI.latitude, pointI.longitude, pointAfterJ.latitude, pointAfterJ.longitude);

        // Se melhorar, aplicar a inversão
        if (newDistance < oldDistance) {
          bestRoute = [
            ...bestRoute.slice(0, i),
            ...bestRoute.slice(i, j + 1).reverse(),
            ...bestRoute.slice(j + 1)
          ];
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return bestRoute;
}

/**
 * Otimiza a rota usando Nearest Neighbor + 2-opt
 * 1. Nearest Neighbor: construção inicial gulosa (rápida)
 * 2. 2-opt: refinamento para melhorar a solução
 */
export function optimizeRoute(
  startLat: number,
  startLon: number,
  points: RoutePoint[]
): OptimizedRoute {
  if (points.length === 0) {
    return {
      orderedPoints: [],
      totalDistance: 0,
      segments: []
    };
  }

  const startPoint = { latitude: startLat, longitude: startLon, name: 'Início (Casa)' };
  const unvisited = [...points];
  const orderedPoints: RoutePoint[] = [];
  let currentLat = startLat;
  let currentLon = startLon;

  // FASE 1: Nearest Neighbor (construção inicial)
  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    // Encontrar o ponto mais próximo (sem prioridade, apenas distância)
    for (let i = 0; i < unvisited.length; i++) {
      const distance = calculateDistance(
        currentLat,
        currentLon,
        unvisited[i].latitude,
        unvisited[i].longitude
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    const nextPoint = unvisited[nearestIndex];
    orderedPoints.push(nextPoint);
    
    currentLat = nextPoint.latitude;
    currentLon = nextPoint.longitude;
    unvisited.splice(nearestIndex, 1);
  }

  // FASE 2: 2-opt (otimização e refinamento)
  const optimizedPoints = twoOptOptimization(startLat, startLon, orderedPoints);

  // Calcular segmentos e distância total da rota otimizada
  const segments: OptimizedRoute['segments'] = [];
  let totalDistance = 0;
  let currentPoint: any = startPoint;
  currentLat = startLat;
  currentLon = startLon;

  for (const point of optimizedPoints) {
    const distance = calculateDistance(currentLat, currentLon, point.latitude, point.longitude);
    
    segments.push({
      from: currentPoint,
      to: point,
      distance
    });

    totalDistance += distance;
    currentLat = point.latitude;
    currentLon = point.longitude;
    currentPoint = point;
  }

  // Retornar à casa do vendedor
  const returnDistance = calculateDistance(
    currentLat,
    currentLon,
    startLat,
    startLon
  );
  
  segments.push({
    from: currentPoint,
    to: { ...startPoint, id: 'home', customerName: 'Retorno (Casa)', customerAddress: '' } as RoutePoint,
    distance: returnDistance
  });

  totalDistance += returnDistance;

  return {
    orderedPoints: optimizedPoints,
    totalDistance: Math.round(totalDistance * 100) / 100,
    segments
  };
}

/**
 * Gera a rota diária para um vendedor
 */
export async function generateDailyRoute(
  storage: DatabaseStorage,
  sellerId: string,
  routeDate: Date
): Promise<any> {
  // Buscar informações do vendedor
  const seller = await storage.getUserById(sellerId);
  
  if (!seller) {
    throw new Error('Vendedor não encontrado');
  }

  if (!seller.homeLatitude || !seller.homeLongitude) {
    throw new Error('Vendedor não possui coordenadas de residência cadastradas');
  }

  // Buscar visitas pendentes do dia
  const startOfDay = new Date(routeDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(routeDate);
  endOfDay.setHours(23, 59, 59, 999);

  const visits = await storage.getVisitAgenda({
    sellerId,
    startDate: startOfDay.toISOString(),
    endDate: endOfDay.toISOString(),
    visitStatus: 'pending'
  });

  // Filtrar apenas visitas presenciais com coordenadas válidas
  const validVisits = visits.filter(v => 
    !v.isVirtual &&
    v.customerLatitude && 
    v.customerLongitude &&
    !isNaN(parseFloat(v.customerLatitude as any)) &&
    !isNaN(parseFloat(v.customerLongitude as any))
  );

  if (validVisits.length === 0) {
    return {
      routeId: null,
      message: 'Nenhuma visita presencial com coordenadas válidas encontrada para esta data',
      totalVisits: 0,
      visitsWithoutCoordinates: visits.filter(v => !v.customerLatitude || !v.customerLongitude).length
    };
  }

  // Converter visitas para pontos de rota
  const routePoints: RoutePoint[] = validVisits.map(v => ({
    id: v.id,
    latitude: parseFloat(v.customerLatitude as any),
    longitude: parseFloat(v.customerLongitude as any),
    customerName: v.customerName,
    customerAddress: v.customerAddress || ''
  }));

  // Otimizar a rota
  const optimizedRoute = optimizeRoute(
    parseFloat(seller.homeLatitude as any),
    parseFloat(seller.homeLongitude as any),
    routePoints
  );

  // Salvar rota no banco de dados
  const routeData = {
    sellerId,
    routeDate: startOfDay,
    startLatitude: seller.homeLatitude.toString(),
    startLongitude: seller.homeLongitude.toString(),
    startAddress: `Casa do vendedor ${seller.firstName} ${seller.lastName || ''}`,
    optimizedOrder: optimizedRoute.orderedPoints.map(p => p.id),
    totalEstimatedDistance: optimizedRoute.totalDistance.toString(),
    totalActualDistance: '0',
    totalVisits: optimizedRoute.orderedPoints.length,
    completedVisits: 0,
    routeStatus: 'pending'
  };

  const route = await storage.createDailyRoute(routeData);

  return {
    routeId: route.id,
    sellerId,
    sellerName: `${seller.firstName} ${seller.lastName || ''}`,
    routeDate: startOfDay,
    startLocation: {
      latitude: parseFloat(seller.homeLatitude as any),
      longitude: parseFloat(seller.homeLongitude as any),
      address: routeData.startAddress
    },
    optimizedRoute: {
      points: optimizedRoute.orderedPoints,
      totalDistance: optimizedRoute.totalDistance,
      segments: optimizedRoute.segments,
      totalVisits: optimizedRoute.orderedPoints.length
    },
    visitsWithoutCoordinates: visits.filter(v => !v.customerLatitude || !v.customerLongitude)
  };
}

/**
 * Registra um checkpoint (check-in ou check-out) e calcula distância percorrida
 */
export async function registerCheckpoint(
  storage: DatabaseStorage,
  dailyRouteId: string,
  visitId: string,
  sellerId: string,
  checkpointType: 'check_in' | 'check_out',
  latitude: number,
  longitude: number
): Promise<{ distanceFromPrevious: number; totalDistanceSoFar: number; completedVisits: number }> {
  // Buscar último checkpoint
  const lastCheckpoint = await storage.getLastCheckpoint(dailyRouteId);
  
  let distanceFromPrevious = 0;
  let previousLat = null;
  let previousLon = null;
  
  if (lastCheckpoint) {
    previousLat = parseFloat(lastCheckpoint.checkpointLatitude as any);
    previousLon = parseFloat(lastCheckpoint.checkpointLongitude as any);
    distanceFromPrevious = calculateDistance(previousLat, previousLon, latitude, longitude);
  } else {
    // Primeiro checkpoint - calcular distância da casa do vendedor
    const route = await storage.getDailyRoute(dailyRouteId);
    if (route) {
      previousLat = parseFloat(route.startLatitude as any);
      previousLon = parseFloat(route.startLongitude as any);
      distanceFromPrevious = calculateDistance(previousLat, previousLon, latitude, longitude);
    }
  }

  // Determinar número de sequência
  const checkpoints = await storage.getRouteCheckpoints(dailyRouteId);
  const sequenceNumber = checkpoints.length + 1;

  // Salvar checkpoint
  await storage.createRouteCheckpoint({
    dailyRouteId,
    visitId,
    sellerId,
    checkpointType,
    checkpointLatitude: latitude.toString(),
    checkpointLongitude: longitude.toString(),
    checkpointTime: new Date(),
    distanceFromPrevious: distanceFromPrevious.toString(),
    previousLatitude: previousLat?.toString() || null,
    previousLongitude: previousLon?.toString() || null,
    sequenceNumber
  });

  // Atualizar distância total percorrida na rota
  const route = await storage.getDailyRoute(dailyRouteId);
  if (route) {
    const currentTotal = parseFloat(route.totalActualDistance || '0');
    const newTotal = currentTotal + distanceFromPrevious;
    
    // Contar visitas completadas (check-outs)
    const completedCount = checkpoints.filter(cp => cp.checkpointType === 'check_out').length;
    const completedVisits = checkpointType === 'check_out' ? completedCount + 1 : completedCount;
    
    await storage.updateDailyRoute(dailyRouteId, {
      totalActualDistance: newTotal.toString(),
      completedVisits,
      routeStatus: checkpointType === 'check_in' && completedVisits === 0 ? 'in_progress' : route.routeStatus
    });

    return {
      distanceFromPrevious: Math.round(distanceFromPrevious * 100) / 100,
      totalDistanceSoFar: Math.round(newTotal * 100) / 100,
      completedVisits
    };
  }

  return {
    distanceFromPrevious: Math.round(distanceFromPrevious * 100) / 100,
    totalDistanceSoFar: 0,
    completedVisits: 0
  };
}
