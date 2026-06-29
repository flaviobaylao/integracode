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
 * HELPER: Planeja a rota diária SEM salvar no banco
 * Retorna apenas os dados otimizados para serem salvos/atualizados depois
 * 
 * Usado por:
 * - generateDailyRoute() para criar nova rota
 * - Endpoint de regeneração para atualizar rota existente
 */
export async function planDailyRoute(
  storage: DatabaseStorage,
  sellerId: string,
  routeDate: Date
): Promise<{
  sellerData: any;
  optimizedOrder: string[];
  totalDistance: number;
  totalVisits: number;
  routePoints: any[];
  virtualCustomers: any[];
  customersWithoutCoords: any[];
  customersWithSuspiciousCoords: any[];
  warnings: string[];
}> {
  // Buscar informações do vendedor
  const seller = await storage.getUserById(sellerId);
  
  if (!seller) {
    throw new Error('Vendedor não encontrado');
  }

  // Se vendedor não tem coordenadas, avisar mas continuar com fallback
  if (!seller.homeLatitude || !seller.homeLongitude) {
    console.warn(`⚠️ Vendedor ${seller.firstName} ${seller.lastName || ''} não possui coordenadas de residência. Será usado fallback.`);
  }

  // Descobrir qual dia da semana é a data alvo
  const daysOfWeekFull = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const targetWeekdayFull = daysOfWeekFull[routeDate.getDay()];
  
  console.log(`📅 Planejando rota para ${seller.firstName} ${seller.lastName || ''} - ${targetWeekdayFull} ${routeDate.toLocaleDateString('pt-BR')}`);

  // PRIORIDADE: Buscar clientes das VISITAS PLANEJADAS (visitAgenda)
  // Isso garante que usamos os dados da aba Clientes Ativos
  // CORREÇÃO (28/jun/2026): UNIR visitas planejadas (visit_agenda) COM o cálculo de
  // periodicidade do cadastro — antes a periodicidade só era usada se o visit_agenda
  // estivesse VAZIO, o que descartava clientes devidos e fazia a rota do 2.0 ficar menor
  // que a do 1.0 (ex.: 14 vs 31). A união garante que nenhum cliente devido fique de fora.
  const fromPlanned = await storage.getCustomersFromPlannedVisits(sellerId, routeDate);
  let fromPeriodicity: any[] = [];
  try {
    fromPeriodicity = await storage.getCustomersForDate(sellerId, routeDate);
  } catch (e) {
    console.warn('⚠️ getCustomersForDate falhou na união:', e);
  }
  const _seenIds = new Set<string>();
  let customersScheduled: any[] = [];
  for (const c of [...fromPlanned, ...fromPeriodicity]) {
    if (c && c.id && !_seenIds.has(c.id)) { _seenIds.add(c.id); customersScheduled.push(c); }
  }
  console.log(`   📋 União de fontes: ${fromPlanned.length} planejadas (visit_agenda) + ${fromPeriodicity.length} periodicidade = ${customersScheduled.length} clientes únicos`);

  console.log(`   📋 ${customersScheduled.length} clientes encontrados para a data`);
  
  // ✅ NOVO: Buscar informações de is_virtual para cada cliente na data alvo
  // Usa o método direto de getDailyRoute para pegar visitas virtuais
  let virtualCustomerIds = new Set<string>();
  try {
    const virtuals = await (storage as any).getCustomersWithVirtualVisitsOnDate(sellerId, routeDate);
    virtualCustomerIds = new Set(virtuals.map((c: any) => c.id));
  } catch (err) {
    console.warn('⚠️ Não foi possível buscar visitas virtuais:', err);
  }
  
  // Separar presenciais e virtuais
  const customersToVisit = customersScheduled.filter(c => !virtualCustomerIds.has(c.id));
  const virtualCustomers = customersScheduled.filter(c => virtualCustomerIds.has(c.id));

  console.log(`   ✅ ${customersToVisit.length} visitas presenciais + ${virtualCustomers.length} virtuais`);

  // ✅ CORREÇÃO (Nov 13, 2025): REMOVIDA validação duplicada!
  // getCustomersForDate() já faz a filtragem correta usando calculateNextVisitDate()
  // A revalidação com shouldVisitOnDateByPeriodicity() criava divergência e rejeitava clientes válidos
  
  // Filtrar apenas clientes com coordenadas válidas
  const validCustomers = customersToVisit.filter(c => 
    c.latitude && 
    c.longitude &&
    !isNaN(parseFloat(c.latitude as any)) &&
    !isNaN(parseFloat(c.longitude as any))
  );

  const customersWithoutCoords = customersToVisit.filter(c => 
    !c.latitude || !c.longitude ||
    isNaN(parseFloat(c.latitude as any)) ||
    isNaN(parseFloat(c.longitude as any))
  );

  console.log(`   🔍 DEBUG - Clientes com coordenadas válidas: ${validCustomers.length}/${customersToVisit.length}`);
  
  if (customersWithoutCoords.length > 0) {
    console.log(`   ⚠️  ${customersWithoutCoords.length} clientes SEM coordenadas válidas`);
    // Log dos primeiros 5 clientes sem coordenadas para debug
    customersWithoutCoords.slice(0, 5).forEach((c: any) => {
      console.log(`      - ${c.fantasyName || c.name} (ID: ${c.id}): lat=${c.latitude}, lon=${c.longitude}`);
    });
  }

  // Validação de distâncias anômalas
  const sellerLat = parseFloat(seller.homeLatitude as any);
  const sellerLon = parseFloat(seller.homeLongitude as any);
  const customersWithSuspiciousCoords: any[] = [];
  
  validCustomers.forEach((c: any) => {
    const customerLat = parseFloat(c.latitude as any);
    const customerLon = parseFloat(c.longitude as any);
    const distance = calculateHaversineDistance(sellerLat, sellerLon, customerLat, customerLon);
    
    if (distance > 100) {
      customersWithSuspiciousCoords.push({
        id: c.id,
        name: c.fantasyName || c.name,
        distance: Math.round(distance),
        latitude: c.latitude,
        longitude: c.longitude
      });
    }
  });

  if (customersWithSuspiciousCoords.length > 0) {
    console.log(`   🚨 ALERTA: ${customersWithSuspiciousCoords.length} clientes com coordenadas SUSPEITAS (>100km)`);
  }

  if (validCustomers.length === 0) {
    return {
      sellerData: seller,
      optimizedOrder: [],
      totalDistance: 0,
      totalVisits: 0,
      routePoints: [],
      customersWithoutCoords,
      customersWithSuspiciousCoords,
      warnings: customersWithoutCoords.length > 0 
        ? [`${customersWithoutCoords.length} clientes sem coordenadas`]
        : []
    };
  }

  // Converter clientes para pontos de rota
  const routePoints = validCustomers.map((c: any) => ({
    id: c.id,
    latitude: parseFloat(c.latitude as any),
    longitude: parseFloat(c.longitude as any),
    customerName: c.fantasyName || c.name,
    customerAddress: c.address || ''
  }));

  console.log(`   🗺️  Otimizando rota com ${routePoints.length} pontos...`);

  // Otimizar a rota - usar coordenadas do vendedor ou fallback para primeiro cliente
  let startLat = parseFloat(seller.homeLatitude as any);
  let startLon = parseFloat(seller.homeLongitude as any);
  
  // Se vendedor não tem coordenadas válidas, usar primeira coordenada do cliente como fallback
  if (isNaN(startLat) || isNaN(startLon)) {
    if (routePoints.length > 0) {
      startLat = routePoints[0].latitude;
      startLon = routePoints[0].longitude;
      console.warn(`⚠️ Usando coordenadas do primeiro cliente como ponto de partida: ${startLat}, ${startLon}`);
    } else {
      // Se não há clientes também, retornar erro
      throw new Error('Não é possível gerar rota sem coordenadas de vendedor ou clientes');
    }
  }
  
  const optimizedRoute = await optimizeRoute(
    startLat,
    startLon,
    routePoints
  );

  console.log(`   ✅ Rota otimizada: ${optimizedRoute.totalDistance.toFixed(2)}km estimados`);

  // Validação de distância total
  const warnings: string[] = [];
  
  if (customersWithSuspiciousCoords.length > 0) {
    warnings.push(`${customersWithSuspiciousCoords.length} clientes com coordenadas suspeitas (>100km)`);
  }
  
  if (optimizedRoute.totalDistance > 500) {
    console.log(`   🚨 CRÍTICO: Rota muito longa (${optimizedRoute.totalDistance.toFixed(2)}km)!`);
    warnings.push(`Rota muito longa (${optimizedRoute.totalDistance.toFixed(2)}km)`);
  } else if (optimizedRoute.totalDistance > 300) {
    console.log(`   ⚠️  AVISO: Rota longa (${optimizedRoute.totalDistance.toFixed(2)}km)`);
    warnings.push(`Rota longa (${optimizedRoute.totalDistance.toFixed(2)}km)`);
  }

  const result = {
    sellerData: seller,
    startLatitude: startLat, // Ponto de partida da rota (com fallback se necessário)
    startLongitude: startLon, // Ponto de partida da rota (com fallback se necessário)
    optimizedOrder: optimizedRoute.orderedPoints.map(p => p.id),
    totalDistance: optimizedRoute.totalDistance,
    totalVisits: optimizedRoute.orderedPoints.length,
    routePoints: optimizedRoute.orderedPoints,
    virtualCustomers,
    customersWithoutCoords,
    customersWithSuspiciousCoords,
    warnings
  };

  console.log(`   🔍 DEBUG - Resultado final: ${result.totalVisits} visitas presenciais + ${virtualCustomers.length} virtuais`);
  
  return result;
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
  // Usar helper para planejar rota
  const plan = await planDailyRoute(storage, sellerId, routeDate);
  
  const startOfDay = new Date(routeDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  // Se não houver visitas válidas, retornar erro
  if (plan.totalVisits === 0) {
    return {
      routeId: null,
      message: 'Nenhuma visita presencial com coordenadas válidas encontrada para esta data',
      totalVisits: 0,
      visitsWithoutCoordinates: plan.customersWithoutCoords.length,
      warnings: plan.warnings
    };
  }

  // Salvar rota no banco de dados usando dados do plan
  // Usar startLatitude/startLongitude do plan (que inclui fallback se vendedor não tem coordenadas)
  const routeData = {
    sellerId,
    routeDate: startOfDay,
    startLatitude: (plan.startLatitude || plan.sellerData.homeLatitude || '0').toString(),
    startLongitude: (plan.startLongitude || plan.sellerData.homeLongitude || '0').toString(),
    startAddress: `Casa do vendedor ${plan.sellerData.firstName} ${plan.sellerData.lastName || ''}`,
    optimizedOrder: plan.optimizedOrder, // IDs dos clientes
    totalEstimatedDistance: plan.totalDistance.toString(),
    totalActualDistance: '0',
    totalVisits: plan.totalVisits,
    completedVisits: 0,
    routeStatus: 'pending'
  };

  console.log(`🔍 DEBUG: Antes de createDailyRoute - routeData:`, JSON.stringify(routeData, null, 2));
  const route = await storage.createDailyRoute(routeData);
  console.log(`✅ DEBUG: Após createDailyRoute - route.id: ${route.id}`);

  return {
    routeId: route.id,
    sellerId,
    sellerName: `${plan.sellerData.firstName} ${plan.sellerData.lastName || ''}`,
    routeDate: startOfDay,
    virtualCustomers: plan.virtualCustomers || [],
    startLocation: {
      latitude: plan.startLatitude || parseFloat(plan.sellerData.homeLatitude as any),
      longitude: plan.startLongitude || parseFloat(plan.sellerData.homeLongitude as any),
      address: routeData.startAddress
    },
    optimizedRoute: {
      points: plan.routePoints,
      totalDistance: plan.totalDistance,
      segments: [],
      totalVisits: plan.totalVisits
    },
    visitsWithoutCoordinates: plan.customersWithoutCoords,
    warnings: plan.warnings,
    suspiciousCoordinates: plan.customersWithSuspiciousCoords
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
  
  // Verificar se o customerId está na rota planejada (optimizedOrder)
  // OU se há uma sales_card válida para esse cliente na data da rota (visita adicionada manualmente)
  let isOffRoute = false;
  
  if (route && route.optimizedOrder) {
    // Primeiro, verificar se está no optimizedOrder
    const inOptimizedOrder = route.optimizedOrder.includes(customerId);
    
    if (!inOptimizedOrder) {
      // Se não está no optimizedOrder, verificar se há uma visita ativa (sales_card) para esse cliente
      // Isso cobre o caso de visitas adicionadas manualmente DEPOIS da rota ser gerada
      const routeDate = new Date(route.routeDate);
      const routeDateStr = routeDate.toISOString().split('T')[0];
      
      // Buscar sales_card para esse cliente na data da rota
      try {
        const salesCard = await storage.getSalesCard(visitId);
        if (salesCard && salesCard.customerId === customerId && salesCard.sellerId === sellerId) {
          // Há uma sales_card válida para esse cliente - NÃO é off-route
          isOffRoute = false;
        } else {
          // Nenhuma sales_card encontrada - é off-route
          isOffRoute = true;
        }
      } catch {
        // Se não conseguir encontrar a sales_card, marcar como off-route
        isOffRoute = true;
      }
    }
  }
  
  if (isOffRoute) {
    console.log(`⚠️  VISITA FORA DA ROTA detectada: Cliente ${customerId}, Visita ${visitId}`);
  } else if (route && route.optimizedOrder && !route.optimizedOrder.includes(customerId)) {
    console.log(`✅ Cliente ${customerId} não está em optimizedOrder, mas tem sales_card válida - ADICIONANDO ao optimizedOrder`);
    
    // Adicionar customerId ao optimizedOrder se não estiver lá
    // Isso sincroniza visitas adicionadas manualmente com a rota
    const currentOrder = (route.optimizedOrder as string[]) || [];
    if (!currentOrder.includes(customerId)) {
      const updatedOrder = [...currentOrder, customerId];
      await storage.updateDailyRoute(dailyRouteId, {
        optimizedOrder: updatedOrder,
        totalVisits: updatedOrder.length
      });
      console.log(`✅ optimizedOrder atualizado: ${currentOrder.length} → ${updatedOrder.length} visitas`);
    }
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

  console.log(`✅ Checkpoint ${checkpointType} salvo para visita ${visitId}`);

  // Recalcular distância total da rota usando apenas checkpoints validados
  // IMPORTANTE: Fazer isso DEPOIS de salvar o checkpoint para que ele seja incluído na recalculação
  if (route) {
    console.log(`🔄 Recalculando distância total da rota ${dailyRouteId}...`);
    const { recalculateRouteDistance } = await import('./actualRouteService');
    await recalculateRouteDistance(dailyRouteId, storage);
    
    // Buscar rota atualizada
    const updatedRoute = await storage.getDailyRoute(dailyRouteId);
    const totalDistance = parseFloat(updatedRoute?.totalActualDistance || '0');
    const completedVisits = updatedRoute?.completedVisits || 0;

    console.log(`✅ Rota recalculada: ${totalDistance}km, ${completedVisits} visitas concluídas`);

    return {
      distanceFromPrevious: Math.round(distanceFromPrevious * 100) / 100,
      totalDistanceSoFar: Math.round(totalDistance * 100) / 100,
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
