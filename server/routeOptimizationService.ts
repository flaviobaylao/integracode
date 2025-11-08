import { DatabaseStorage } from './storage';
import { calculateRouteDistances, calculateTotalRouteDistance as calculateRealRouteDistance } from './routingService';
import { shouldVisitOnDate as shouldVisitOnDateByPeriodicity } from './visitScheduleHistoryService';

// Função Haversine para calcular distância entre dois pontos (em km)
// Usada para otimização rápida, mas não para distâncias finais
function calculateHaversineDistance(
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

// Mantém função pública para compatibilidade (usa Haversine para otimização)
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return calculateHaversineDistance(lat1, lon1, lat2, lon2);
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
 * 1. Nearest Neighbor: construção inicial gulosa (rápida) usando Haversine
 * 2. 2-opt: refinamento para melhorar a solução usando Haversine
 * 3. Cálculo de distâncias reais de moto usando OSRM para a rota final
 */
export async function optimizeRoute(
  startLat: number,
  startLon: number,
  points: RoutePoint[]
): Promise<OptimizedRoute> {
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

  // FASE 1: Nearest Neighbor (construção inicial usando Haversine para velocidade)
  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    // Encontrar o ponto mais próximo (sem prioridade, apenas distância)
    for (let i = 0; i < unvisited.length; i++) {
      const distance = calculateHaversineDistance(
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

  // FASE 2: 2-opt (otimização usando Haversine para velocidade)
  const optimizedPoints = twoOptOptimization(startLat, startLon, orderedPoints);

  // FASE 3: Calcular distâncias REAIS de moto usando OSRM
  const coordinates = [
    { lat: startLat, lon: startLon }, // Casa do vendedor
    ...optimizedPoints.map(p => ({ lat: p.latitude, lon: p.longitude })),
    { lat: startLat, lon: startLon } // Retorno para casa
  ];

  try {
    // Calcular distâncias reais de moto
    const realDistances = await calculateRouteDistances(coordinates);
    
    // Verificar se OSRM retornou distâncias suficientes
    const expectedLegs = optimizedPoints.length + 1; // +1 para o retorno
    
    if (!realDistances || realDistances.length < optimizedPoints.length) {
      // OSRM falhou ou não retornou distâncias suficientes, usar Haversine
      throw new Error('OSRM não retornou distâncias suficientes, usando fallback');
    }
    
    // Construir segmentos com distâncias reais (em metros, converter para km)
    const segments: OptimizedRoute['segments'] = [];
    let totalDistance = 0;
    let currentPoint: any = startPoint;

    for (let i = 0; i < optimizedPoints.length; i++) {
      const distance = realDistances[i] / 1000; // metros para km
      
      segments.push({
        from: currentPoint,
        to: optimizedPoints[i],
        distance
      });

      totalDistance += distance;
      currentPoint = optimizedPoints[i];
    }

    // Retornar à casa do vendedor
    // OSRM pode não retornar o último leg, calcular separadamente se necessário
    let returnDistance = 0;
    if (realDistances.length > optimizedPoints.length) {
      returnDistance = realDistances[optimizedPoints.length] / 1000; // metros para km
    } else {
      // Calcular distância de retorno separadamente
      const { calculateRealDistance } = await import('./routingService');
      const lastPoint = optimizedPoints[optimizedPoints.length - 1];
      const returnDistanceMeters = await calculateRealDistance(
        lastPoint.latitude,
        lastPoint.longitude,
        startLat,
        startLon
      );
      returnDistance = returnDistanceMeters / 1000;
    }
    
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
  } catch (error) {
    console.error('Erro ao calcular distâncias reais, usando Haversine:', error);
    
    // Fallback: usar Haversine se OSRM falhar completamente
    const segments: OptimizedRoute['segments'] = [];
    let totalDistance = 0;
    let currentPoint: any = startPoint;
    currentLat = startLat;
    currentLon = startLon;

    for (const point of optimizedPoints) {
      const distance = calculateHaversineDistance(currentLat, currentLon, point.latitude, point.longitude);
      
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
    const returnDistance = calculateHaversineDistance(
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
}

/**
 * Gera a rota diária para um vendedor consultando direto na tabela customers
 * FONTE ÚNICA DE VERDADE: customers
 * 
 * PERIODICIDADE: Agora usa a lógica correta baseada em SEMANAS (não dias)
 * - Semanal: toda semana nos dias configurados
 * - Quinzenal: semana SIM, semana NÃO (alternado desde serviceStartDate)
 * - Mensal: 1 semana SIM, 3 semanas NÃO (desde serviceStartDate)
 * - Bimestral: a cada 8 semanas (desde serviceStartDate)
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

  const startOfDay = new Date(routeDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(routeDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Descobrir qual dia da semana é a data alvo
  const daysOfWeekFull = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const targetWeekdayFull = daysOfWeekFull[routeDate.getDay()];
  
  console.log(`📅 Gerando rota para ${seller.firstName} ${seller.lastName || ''} - ${targetWeekdayFull} ${routeDate.toLocaleDateString('pt-BR')}`);

  // NOVA ARQUITETURA: Buscar PERMANENT CARDS cuja nextVisitDate é HOJE ou está ATRASADA
  // Permanent cards = 1 card por cliente com isPermanent=true, nextVisitDate calculado dinamicamente
  const { db } = await import('./db');
  const { salesCards, customers } = await import('../shared/schema');
  const { eq, and, lte } = await import('drizzle-orm');
  
  const salesCardsWithCustomers = await db.select({
    cardId: salesCards.id,
    customerId: salesCards.customerId,
    customerName: customers.name,
    customerFantasyName: customers.fantasyName,
    customerAddress: customers.address,
    customerLatitude: customers.latitude,
    customerLongitude: customers.longitude,
    customerVirtualService: customers.virtualService,
    cardStatus: salesCards.status,
    nextVisitDate: salesCards.nextVisitDate,
    lastVisitDate: salesCards.lastVisitDate,
    isPermanent: salesCards.isPermanent
  })
    .from(salesCards)
    .innerJoin(customers, eq(salesCards.customerId, customers.id))
    .where(
      and(
        eq(salesCards.sellerId, sellerId),
        eq(salesCards.isPermanent, true),  // Apenas permanent cards
        lte(salesCards.nextVisitDate, endOfDay)  // nextVisitDate <= hoje (inclui atrasados)
      )
    );

  console.log(`   📋 ${salesCardsWithCustomers.length} clientes com visita agendada/atrasada encontrados`);
  
  // Filtrar apenas visitas presenciais com status válido
  const customersToVisit = salesCardsWithCustomers.filter((sc: any) => {
    // Apenas cards pending ou open
    if (!['pending', 'open'].includes(sc.cardStatus)) return false;
    
    // Não incluir clientes com atendimento virtual
    if (sc.customerVirtualService) return false;
    
    return true;
  });

  console.log(`   ✅ ${customersToVisit.length} visitas presenciais agendadas (${salesCardsWithCustomers.length - customersToVisit.length} virtuais ou outros status)`);

  // Filtrar apenas clientes com coordenadas válidas
  const validCustomers = customersToVisit.filter((c: any) => 
    c.customerLatitude && 
    c.customerLongitude &&
    !isNaN(parseFloat(c.customerLatitude as any)) &&
    !isNaN(parseFloat(c.customerLongitude as any))
  );

  const customersWithoutCoords = customersToVisit.filter((c: any) => 
    !c.customerLatitude || !c.customerLongitude ||
    isNaN(parseFloat(c.customerLatitude as any)) ||
    isNaN(parseFloat(c.customerLongitude as any))
  );

  if (customersWithoutCoords.length > 0) {
    console.log(`   ⚠️  ${customersWithoutCoords.length} clientes sem coordenadas válidas:`);
    customersWithoutCoords.forEach((c: any) => console.log(`      - ${c.customerFantasyName || c.customerName} (${c.customerId})`));
  }

  // 🔍 VALIDAÇÃO DE DISTÂNCIAS ANÔMALAS
  const sellerLat = parseFloat(seller.homeLatitude as any);
  const sellerLon = parseFloat(seller.homeLongitude as any);
  const customersWithSuspiciousCoords: any[] = [];
  
  validCustomers.forEach((c: any) => {
    const customerLat = parseFloat(c.customerLatitude as any);
    const customerLon = parseFloat(c.customerLongitude as any);
    
    // Calcular distância em linha reta (Haversine)
    const distance = calculateHaversineDistance(sellerLat, sellerLon, customerLat, customerLon);
    
    // Alertar se distância > 100km (suspeito para rota diária)
    if (distance > 100) {
      customersWithSuspiciousCoords.push({
        id: c.customerId,
        name: c.customerFantasyName || c.customerName,
        distance: Math.round(distance),
        latitude: c.customerLatitude,
        longitude: c.customerLongitude,
        city: c.customerAddress
      });
    }
  });

  if (customersWithSuspiciousCoords.length > 0) {
    console.log(`   🚨 ALERTA: ${customersWithSuspiciousCoords.length} clientes com coordenadas SUSPEITAS (>100km da casa do vendedor):`);
    customersWithSuspiciousCoords.forEach((c: any) => 
      console.log(`      - ${c.name}: ${c.distance}km de distância (lat: ${c.latitude}, lon: ${c.longitude})`)
    );
  }

  if (validCustomers.length === 0) {
    return {
      routeId: null,
      message: 'Nenhuma visita presencial com coordenadas válidas encontrada para esta data',
      totalVisits: 0,
      visitsWithoutCoordinates: customersWithoutCoords.length,
      warnings: customersWithoutCoords.length > 0 
        ? [`${customersWithoutCoords.length} clientes sem coordenadas configuradas`]
        : []
    };
  }

  // Converter clientes para pontos de rota
  const routePoints: RoutePoint[] = validCustomers.map((c: any) => ({
    id: c.customerId, // Usar ID do cliente como identificador da visita
    latitude: parseFloat(c.customerLatitude as any),
    longitude: parseFloat(c.customerLongitude as any),
    customerName: c.customerFantasyName || c.customerName,
    customerAddress: c.customerAddress || ''
  }));

  console.log(`   🗺️  Otimizando rota com ${routePoints.length} pontos...`);

  // Otimizar a rota (usando distâncias reais de moto)
  const optimizedRoute = await optimizeRoute(
    parseFloat(seller.homeLatitude as any),
    parseFloat(seller.homeLongitude as any),
    routePoints
  );

  console.log(`   ✅ Rota otimizada: ${optimizedRoute.totalDistance.toFixed(2)}km estimados`);

  // 🔍 VALIDAÇÃO DE DISTÂNCIA TOTAL
  const warnings: string[] = [];
  
  if (customersWithSuspiciousCoords.length > 0) {
    warnings.push(`${customersWithSuspiciousCoords.length} clientes com coordenadas suspeitas (>100km). Verifique: ${customersWithSuspiciousCoords.map(c => c.name).join(', ')}`);
  }
  
  if (optimizedRoute.totalDistance > 500) {
    console.log(`   🚨 CRÍTICO: Rota muito longa (${optimizedRoute.totalDistance.toFixed(2)}km)! Verifique coordenadas incorretas.`);
    warnings.push(`Rota muito longa (${optimizedRoute.totalDistance.toFixed(2)}km). Provavelmente há coordenadas erradas.`);
  } else if (optimizedRoute.totalDistance > 300) {
    console.log(`   ⚠️  AVISO: Rota longa (${optimizedRoute.totalDistance.toFixed(2)}km). Revise se há coordenadas incorretas.`);
    warnings.push(`Rota longa (${optimizedRoute.totalDistance.toFixed(2)}km). Revise coordenadas.`);
  }

  // Salvar rota no banco de dados
  const routeData = {
    sellerId,
    routeDate: startOfDay,
    startLatitude: seller.homeLatitude.toString(),
    startLongitude: seller.homeLongitude.toString(),
    startAddress: `Casa do vendedor ${seller.firstName} ${seller.lastName || ''}`,
    optimizedOrder: optimizedRoute.orderedPoints.map(p => p.id), // IDs dos clientes
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
    visitsWithoutCoordinates: customersWithoutCoords,
    warnings,
    suspiciousCoordinates: customersWithSuspiciousCoords
  };
}

/**
 * Registra um checkpoint (check-in ou check-out) e calcula distância percorrida
 * Usa distância real de moto (OSRM) quando possível
 * Detecta automaticamente visitas fora da rota planejada
 */
export async function registerCheckpoint(
  storage: DatabaseStorage,
  dailyRouteId: string,
  visitId: string,
  customerId: string,
  sellerId: string,
  checkpointType: 'check_in' | 'check_out',
  latitude: number,
  longitude: number
): Promise<{ distanceFromPrevious: number; totalDistanceSoFar: number; completedVisits: number; isOffRoute: boolean }> {
  // Buscar a rota para verificar se é visita off-route
  const route = await storage.getDailyRoute(dailyRouteId);
  
  // Verificar se o visitId está na rota planejada (optimizedOrder)
  const isOffRoute = route && route.optimizedOrder 
    ? !route.optimizedOrder.includes(visitId)
    : false;
  
  if (isOffRoute) {
    console.log(`⚠️  VISITA FORA DA ROTA detectada: Cliente ${customerId}, Visita ${visitId}`);
  }
  
  // Buscar último checkpoint
  const lastCheckpoint = await storage.getLastCheckpoint(dailyRouteId);
  
  let distanceFromPrevious = 0;
  let previousLat = null;
  let previousLon = null;
  
  if (lastCheckpoint) {
    previousLat = parseFloat(lastCheckpoint.checkpointLatitude as any);
    previousLon = parseFloat(lastCheckpoint.checkpointLongitude as any);
    
    // Calcular distância real de moto entre checkpoints
    try {
      const { calculateRealDistance } = await import('./routingService');
      const distanceMeters = await calculateRealDistance(previousLat, previousLon, latitude, longitude);
      distanceFromPrevious = distanceMeters / 1000; // Converter para km
    } catch (error) {
      console.error('Erro ao calcular distância real, usando Haversine:', error);
      distanceFromPrevious = calculateHaversineDistance(previousLat, previousLon, latitude, longitude);
    }
  } else {
    // Primeiro checkpoint - calcular distância da casa do vendedor
    if (route) {
      previousLat = parseFloat(route.startLatitude as any);
      previousLon = parseFloat(route.startLongitude as any);
      
      // Calcular distância real de moto da casa até primeiro checkpoint
      try {
        const { calculateRealDistance } = await import('./routingService');
        const distanceMeters = await calculateRealDistance(previousLat, previousLon, latitude, longitude);
        distanceFromPrevious = distanceMeters / 1000; // Converter para km
      } catch (error) {
        console.error('Erro ao calcular distância real, usando Haversine:', error);
        distanceFromPrevious = calculateHaversineDistance(previousLat, previousLon, latitude, longitude);
      }
    }
  }

  // Determinar número de sequência
  const checkpoints = await storage.getRouteCheckpoints(dailyRouteId);
  const sequenceNumber = checkpoints.length + 1;

  // Salvar checkpoint (incluindo informação se é off-route)
  await storage.createRouteCheckpoint({
    dailyRouteId,
    visitId,
    customerId,
    sellerId,
    checkpointType,
    checkpointLatitude: latitude.toString(),
    checkpointLongitude: longitude.toString(),
    checkpointTime: new Date(),
    isOffRoute,
    validationStatus: isOffRoute ? 'pending' : 'validated', // Off-route precisa validação, rotas normais são auto-validadas
    distanceFromPrevious: distanceFromPrevious.toString(),
    previousLatitude: previousLat?.toString() || null,
    previousLongitude: previousLon?.toString() || null,
    sequenceNumber
  });

  // Atualizar distância total percorrida na rota
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
      completedVisits,
      isOffRoute
    };
  }

  return {
    distanceFromPrevious: Math.round(distanceFromPrevious * 100) / 100,
    totalDistanceSoFar: 0,
    completedVisits: 0,
    isOffRoute
  };
}
