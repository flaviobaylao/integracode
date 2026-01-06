/**
 * Algoritmo de otimização de rota usando fórmula de Haversine e algoritmo Nearest Neighbor
 */

export interface RouteLocation {
  id: string;
  latitude: number;
  longitude: number;
  customerName: string;
  address?: string;
  priority?: number; // 1-5, onde 5 é prioridade alta
  estimatedDuration?: number; // tempo estimado de visita em minutos
  isVirtual?: boolean; // indica se é atendimento virtual
  isUrgent?: boolean; // entrega urgente (prioridade máxima na roteirização)
}

export interface OptimizedRoute {
  locations: RouteLocation[];
  totalDistance: number; // em metros
  estimatedTotalTime: number; // em minutos
  routeOrder: string[]; // array de IDs na ordem otimizada
}

/**
 * Calcula a distância entre duas coordenadas usando a fórmula de Haversine
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distância em metros
}

/**
 * Calcula o tempo estimado de viagem baseado na distância
 * Assumindo velocidade média de 25 km/h no trânsito urbano
 */
export function calculateTravelTime(distanceMeters: number): number {
  const speedKmh = 25; // velocidade média urbana
  const distanceKm = distanceMeters / 1000;
  return Math.round((distanceKm / speedKmh) * 60); // tempo em minutos
}

/**
 * Algoritmo Nearest Neighbor para otimização de rota
 * Sempre começa da localização inicial (home base do vendedor)
 * Implementa urgent-first grouping: entregas urgentes sempre primeiro
 */
export function optimizeRoute(
  startLocation: { latitude: number; longitude: number },
  destinations: RouteLocation[]
): OptimizedRoute {
  if (destinations.length === 0) {
    return {
      locations: [],
      totalDistance: 0,
      estimatedTotalTime: 0,
      routeOrder: []
    };
  }

  // Separar por urgência E prioridade - 3 grupos:
  // 1. Entregas urgentes (isUrgent=true) - SEMPRE PRIMEIRO
  // 2. Clientes com alta prioridade (priority >= 4)
  // 3. Clientes com prioridade normal (priority < 4)
  const urgentDeliveries = destinations.filter(d => d.isUrgent === true);
  const highPriority = destinations.filter(d => d.isUrgent !== true && (d.priority || 3) >= 4);
  const normalPriority = destinations.filter(d => d.isUrgent !== true && (d.priority || 3) < 4);

  const unvisited = [...urgentDeliveries, ...highPriority, ...normalPriority];
  const route: RouteLocation[] = [];
  const routeOrder: string[] = [];
  let totalDistance = 0;
  let estimatedTotalTime = 0;

  let currentLocation = startLocation;

  // Algoritmo Nearest Neighbor
  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = calculateDistance(
      currentLocation.latitude,
      currentLocation.longitude,
      unvisited[0].latitude,
      unvisited[0].longitude
    );

    // Encontrar o próximo cliente mais próximo
    for (let i = 1; i < unvisited.length; i++) {
      const distance = calculateDistance(
        currentLocation.latitude,
        currentLocation.longitude,
        unvisited[i].latitude,
        unvisited[i].longitude
      );

      // Aplicar fator de prioridade:
      // - Entregas urgentes: fator 0.1 (prioridade MÁXIMA)
      // - Alta prioridade: fator 0.7
      // - Prioridade normal: fator 1.0
      let priorityFactor = 1.0;
      if (unvisited[i].isUrgent === true) {
        priorityFactor = 0.1; // Entregas urgentes sempre primeiro
      } else if ((unvisited[i].priority || 3) >= 4) {
        priorityFactor = 0.7; // Alta prioridade
      }
      
      const adjustedDistance = distance * priorityFactor;

      if (adjustedDistance < nearestDistance) {
        nearestDistance = distance; // usar distância real para cálculos
        nearestIndex = i;
      }
    }

    // Adicionar à rota
    const nextLocation = unvisited[nearestIndex];
    route.push(nextLocation);
    routeOrder.push(nextLocation.id);
    totalDistance += nearestDistance;
    
    // Tempo de viagem + tempo de visita
    const travelTime = calculateTravelTime(nearestDistance);
    const visitTime = nextLocation.estimatedDuration || 30; // 30 min padrão
    estimatedTotalTime += travelTime + visitTime;

    // Atualizar localização atual
    currentLocation = {
      latitude: nextLocation.latitude,
      longitude: nextLocation.longitude
    };

    // Remover da lista de não visitados
    unvisited.splice(nearestIndex, 1);
  }

  return {
    locations: route,
    totalDistance: Math.round(totalDistance),
    estimatedTotalTime,
    routeOrder
  };
}

/**
 * Calcula a eficiência de uma rota (menor é melhor)
 * Considera distância total, tempo e prioridades
 */
export function calculateRouteEfficiency(route: OptimizedRoute): number {
  const distanceScore = route.totalDistance / 1000; // pontos por km
  const timeScore = route.estimatedTotalTime / 60; // pontos por hora
  const priorityScore = route.locations.reduce((sum, loc) => 
    sum + (5 - (loc.priority || 3)), 0); // menos pontos para alta prioridade
  
  return distanceScore + timeScore + priorityScore;
}

/**
 * Versão melhorada usando 2-opt para refinamento local
 * Aplica melhoria local na rota gerada pelo Nearest Neighbor
 * PROTEÇÃO: Limite máximo de iterações para evitar loops infinitos
 */
export function optimizeRouteAdvanced(
  startLocation: { latitude: number; longitude: number },
  destinations: RouteLocation[]
): OptimizedRoute {
  // Validar dados de entrada para evitar erros
  if (!startLocation || isNaN(startLocation.latitude) || isNaN(startLocation.longitude)) {
    console.error('[OPTIMIZE] Coordenadas de início inválidas:', startLocation);
    return {
      locations: destinations,
      totalDistance: 0,
      estimatedTotalTime: 0,
      routeOrder: destinations.map(d => d.id)
    };
  }
  
  // Filtrar destinos com coordenadas válidas
  const validDestinations = destinations.filter(d => 
    d && !isNaN(d.latitude) && !isNaN(d.longitude) && 
    d.latitude !== 0 && d.longitude !== 0
  );
  
  if (validDestinations.length === 0) {
    console.error('[OPTIMIZE] Nenhum destino com coordenadas válidas');
    return {
      locations: [],
      totalDistance: 0,
      estimatedTotalTime: 0,
      routeOrder: []
    };
  }
  
  // Começar com rota básica
  let bestRoute = optimizeRoute(startLocation, validDestinations);
  
  if (validDestinations.length < 4) {
    return bestRoute; // 2-opt não é eficaz para rotas muito pequenas
  }

  // PROTEÇÃO: Limite máximo de iterações (evita loop infinito)
  const MAX_ITERATIONS = 100;
  let iterationCount = 0;
  
  // Aplicar melhoria 2-opt com limite de iterações
  let improved = true;
  while (improved && iterationCount < MAX_ITERATIONS) {
    improved = false;
    iterationCount++;
    
    for (let i = 1; i < bestRoute.locations.length - 1; i++) {
      for (let j = i + 1; j < bestRoute.locations.length; j++) {
        // Criar nova rota trocando segmento
        const newRoute = [...bestRoute.locations];
        const segment = newRoute.slice(i, j + 1);
        segment.reverse();
        newRoute.splice(i, j - i + 1, ...segment);
        
        // Verificar se a troca viola a regra de urgência
        let violatesUrgencyRule = false;
        for (let k = 0; k < newRoute.length - 1; k++) {
          const current = newRoute[k];
          const next = newRoute[k + 1];
          if (next.isUrgent === true && current.isUrgent !== true) {
            violatesUrgencyRule = true;
            break;
          }
        }
        
        if (violatesUrgencyRule) {
          continue;
        }
        
        // Calcular nova distância
        let newDistance = 0;
        let currentLoc = startLocation;
        
        for (const location of newRoute) {
          const dist = calculateDistance(
            currentLoc.latitude,
            currentLoc.longitude,
            location.latitude,
            location.longitude
          );
          // Proteção contra NaN
          if (!isNaN(dist)) {
            newDistance += dist;
          }
          currentLoc = location;
        }
        
        // Se melhorou, aceitar nova rota (com proteção contra NaN)
        if (!isNaN(newDistance) && newDistance < bestRoute.totalDistance) {
          let newEstimatedTime = 0;
          let currentLoc = startLocation;
          
          for (const location of newRoute) {
            const travelTime = calculateTravelTime(calculateDistance(
              currentLoc.latitude,
              currentLoc.longitude,
              location.latitude,
              location.longitude
            ));
            const visitTime = location.estimatedDuration || 30;
            if (!isNaN(travelTime)) {
              newEstimatedTime += travelTime + visitTime;
            }
            currentLoc = location;
          }
          
          bestRoute = {
            ...bestRoute,
            locations: newRoute,
            totalDistance: Math.round(newDistance),
            estimatedTotalTime: newEstimatedTime,
            routeOrder: newRoute.map(loc => loc.id)
          };
          improved = true;
        }
      }
    }
  }
  
  if (iterationCount >= MAX_ITERATIONS) {
    console.warn('[OPTIMIZE] Atingido limite máximo de iterações (100)');
  }
  
  return bestRoute;
}

/**
 * Agrupa localizações por região para otimização em lote
 */
export function groupLocationsByRegion(
  locations: RouteLocation[],
  maxDistanceKm: number = 5
): RouteLocation[][] {
  const groups: RouteLocation[][] = [];
  const unprocessed = [...locations];
  
  while (unprocessed.length > 0) {
    const group = [unprocessed.shift()!];
    const groupCenter = group[0];
    
    // Encontrar localizações próximas
    for (let i = unprocessed.length - 1; i >= 0; i--) {
      const distance = calculateDistance(
        groupCenter.latitude,
        groupCenter.longitude,
        unprocessed[i].latitude,
        unprocessed[i].longitude
      );
      
      if (distance <= maxDistanceKm * 1000) {
        group.push(unprocessed.splice(i, 1)[0]);
      }
    }
    
    groups.push(group);
  }
  
  return groups;
}