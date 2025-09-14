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

  // Separar por prioridade - clientes com prioridade alta primeiro
  const highPriority = destinations.filter(d => (d.priority || 3) >= 4);
  const normalPriority = destinations.filter(d => (d.priority || 3) < 4);

  const unvisited = [...highPriority, ...normalPriority];
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

      // Aplicar fator de prioridade - clientes de alta prioridade têm "distância" reduzida
      const priorityFactor = (unvisited[i].priority || 3) >= 4 ? 0.7 : 1.0;
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
 */
export function optimizeRouteAdvanced(
  startLocation: { latitude: number; longitude: number },
  destinations: RouteLocation[]
): OptimizedRoute {
  // Começar com rota básica
  let bestRoute = optimizeRoute(startLocation, destinations);
  
  if (destinations.length < 4) {
    return bestRoute; // 2-opt não é eficaz para rotas muito pequenas
  }

  // Aplicar melhoria 2-opt
  let improved = true;
  while (improved) {
    improved = false;
    
    for (let i = 1; i < bestRoute.locations.length - 1; i++) {
      for (let j = i + 1; j < bestRoute.locations.length; j++) {
        // Criar nova rota trocando segmento
        const newRoute = [...bestRoute.locations];
        const segment = newRoute.slice(i, j + 1);
        segment.reverse();
        newRoute.splice(i, j - i + 1, ...segment);
        
        // Calcular nova distância
        let newDistance = 0;
        let currentLoc = startLocation;
        
        for (const location of newRoute) {
          newDistance += calculateDistance(
            currentLoc.latitude,
            currentLoc.longitude,
            location.latitude,
            location.longitude
          );
          currentLoc = location;
        }
        
        // Se melhorou, aceitar nova rota
        if (newDistance < bestRoute.totalDistance) {
          // Recalcular tempo total para a nova ordem
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
            newEstimatedTime += travelTime + visitTime;
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