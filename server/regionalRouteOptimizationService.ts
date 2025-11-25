/**
 * SERVIÇO DE OTIMIZAÇÃO REGIONAL DE ROTAS
 * 
 * Implementa setorização inteligente de entregas:
 * - Agrupa entregas por proximidade geográfica (clustering)
 * - Distribui setores entre veículos disponíveis
 * - Respeita restrições de veículos exclusivos, capacidade, horários
 * - Evita enviar múltiplos veículos para mesma região
 * - Cria rotas compactas e otimizadas por setor
 */

import { DatabaseStorage } from './storage';
import { optimizeRoute } from './routeOptimizationService';
import { calculateDistance } from './routeOptimizationService';

interface DeliveryPoint {
  id: string;
  customerId: string;
  latitude: number;
  longitude: number;
  customerName: string;
  customerAddress?: string;
  exclusiveVehicle: boolean;
  vehicleTypes: string[]; // ['caminhao', 'carro', 'moto']
  timeSlots: string[];
  weekdays: string[];
  isUrgent: boolean;
  priority: number;
}

interface Vehicle {
  id: string;
  driverId: string;
  driverName: string;
  vehicleType: 'caminhao' | 'carro' | 'moto';
  homeLatitude: number;
  homeLongitude: number;
  maxCapacity?: number; // Número máximo de entregas
}

interface Cluster {
  id: number;
  centroid: { latitude: number; longitude: number };
  points: DeliveryPoint[];
  avgLatitude: number;
  avgLongitude: number;
  radius: number; // km
}

interface SectorizedRoute {
  vehicleId: string;
  driverId: string;
  driverName: string;
  vehicleType: string;
  sector: Cluster;
  optimizedOrder: string[];
  deliveryPoints: DeliveryPoint[];
  totalDistance: number;
  totalDeliveries: number;
  warnings: string[];
}

/**
 * Algoritmo K-means adaptado para coordenadas geográficas
 * Agrupa entregas por proximidade usando distância haversine
 */
function kMeansClustering(
  points: DeliveryPoint[],
  k: number,
  maxIterations: number = 50
): Cluster[] {
  if (points.length === 0) return [];
  if (points.length <= k) {
    // Se temos menos pontos que clusters, cada ponto vira um cluster
    return points.map((p, idx) => ({
      id: idx,
      centroid: { latitude: p.latitude, longitude: p.longitude },
      points: [p],
      avgLatitude: p.latitude,
      avgLongitude: p.longitude,
      radius: 0
    }));
  }

  // Inicializar centroides aleatoriamente (k-means++)
  const centroids: { latitude: number; longitude: number }[] = [];
  
  // Primeiro centróide: ponto aleatório
  const firstPoint = points[Math.floor(Math.random() * points.length)];
  centroids.push({ latitude: firstPoint.latitude, longitude: firstPoint.longitude });
  
  // Demais centroides: escolher pontos mais distantes dos existentes
  while (centroids.length < k) {
    let maxDistance = -1;
    let farthestPoint = points[0];
    
    for (const point of points) {
      let minDistToCentroid = Infinity;
      
      for (const centroid of centroids) {
        const dist = calculateDistance(
          point.latitude, point.longitude,
          centroid.latitude, centroid.longitude
        );
        minDistToCentroid = Math.min(minDistToCentroid, dist);
      }
      
      if (minDistToCentroid > maxDistance) {
        maxDistance = minDistToCentroid;
        farthestPoint = point;
      }
    }
    
    centroids.push({ 
      latitude: farthestPoint.latitude, 
      longitude: farthestPoint.longitude 
    });
  }

  let clusters: Cluster[] = [];
  
  // Iterar até convergência
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Atribuir pontos aos clusters mais próximos
    clusters = centroids.map((centroid, idx) => ({
      id: idx,
      centroid,
      points: [],
      avgLatitude: centroid.latitude,
      avgLongitude: centroid.longitude,
      radius: 0
    }));
    
    for (const point of points) {
      let nearestClusterIdx = 0;
      let minDistance = Infinity;
      
      for (let i = 0; i < centroids.length; i++) {
        const distance = calculateDistance(
          point.latitude, point.longitude,
          centroids[i].latitude, centroids[i].longitude
        );
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestClusterIdx = i;
        }
      }
      
      clusters[nearestClusterIdx].points.push(point);
    }
    
    // Remover clusters vazios
    clusters = clusters.filter(c => c.points.length > 0);
    if (clusters.length === 0) break;
    
    // Recalcular centroides (média das coordenadas)
    let changed = false;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const avgLat = cluster.points.reduce((sum, p) => sum + p.latitude, 0) / cluster.points.length;
      const avgLon = cluster.points.reduce((sum, p) => sum + p.longitude, 0) / cluster.points.length;
      
      if (Math.abs(centroids[i].latitude - avgLat) > 0.0001 || 
          Math.abs(centroids[i].longitude - avgLon) > 0.0001) {
        changed = true;
      }
      
      centroids[i] = { latitude: avgLat, longitude: avgLon };
      cluster.centroid = centroids[i];
      cluster.avgLatitude = avgLat;
      cluster.avgLongitude = avgLon;
    }
    
    // Se não mudou, convergiu
    if (!changed) break;
  }
  
  // Calcular raio de cada cluster (distância máxima ao centróide)
  for (const cluster of clusters) {
    let maxDist = 0;
    for (const point of cluster.points) {
      const dist = calculateDistance(
        point.latitude, point.longitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      maxDist = Math.max(maxDist, dist);
    }
    cluster.radius = maxDist;
  }
  
  return clusters;
}

/**
 * Separa entregas que requerem veículos exclusivos
 */
function separateExclusiveDeliveries(
  points: DeliveryPoint[]
): { exclusive: DeliveryPoint[]; regular: DeliveryPoint[] } {
  const exclusive = points.filter(p => p.exclusiveVehicle);
  const regular = points.filter(p => !p.exclusiveVehicle);
  
  return { exclusive, regular };
}

/**
 * Valida se um veículo pode fazer uma entrega
 */
function canVehicleDeliverTo(
  vehicle: Vehicle,
  delivery: DeliveryPoint
): boolean {
  // Se a entrega aceita qualquer veículo
  if (!delivery.vehicleTypes || delivery.vehicleTypes.length === 0) {
    return true;
  }
  
  // Verificar se tipo do veículo está na lista permitida
  return delivery.vehicleTypes.includes(vehicle.vehicleType);
}

/**
 * Atribui clusters a veículos de forma balanceada
 * Prioriza proximidade do veículo ao cluster e capacidade
 */
function assignClustersToVehicles(
  clusters: Cluster[],
  vehicles: Vehicle[]
): Map<string, Cluster[]> {
  const assignment = new Map<string, Cluster[]>();
  
  // Inicializar mapa de atribuições
  for (const vehicle of vehicles) {
    assignment.set(vehicle.id, []);
  }
  
  // Ordenar clusters por tamanho (maiores primeiro para balancear melhor)
  const sortedClusters = [...clusters].sort((a, b) => b.points.length - a.points.length);
  
  for (const cluster of sortedClusters) {
    // Encontrar veículo mais adequado para este cluster
    let bestVehicle: Vehicle | null = null;
    let bestScore = Infinity;
    
    for (const vehicle of vehicles) {
      // Verificar se veículo pode atender TODAS as entregas do cluster
      const canDeliverAll = cluster.points.every(p => canVehicleDeliverTo(vehicle, p));
      if (!canDeliverAll) continue;
      
      // Calcular distância do veículo ao centroide do cluster
      const distance = calculateDistance(
        vehicle.homeLatitude, vehicle.homeLongitude,
        cluster.centroid.latitude, cluster.centroid.longitude
      );
      
      // Contar entregas já atribuídas a este veículo
      const currentLoad = assignment.get(vehicle.id)?.reduce((sum, c) => sum + c.points.length, 0) || 0;
      
      // Score considera: distância + balanceamento de carga
      // Queremos minimizar distância E balancear entregas
      const loadPenalty = currentLoad * 2; // Penaliza veículos com muitas entregas
      const score = distance + loadPenalty;
      
      if (score < bestScore) {
        bestScore = score;
        bestVehicle = vehicle;
      }
    }
    
    if (bestVehicle) {
      assignment.get(bestVehicle.id)!.push(cluster);
    } else {
      // CRÍTICO: Cluster não pode ser atribuído respeitando restrições
      console.error(`❌ CRÍTICO: Cluster ${cluster.id} não pôde ser atribuído a nenhum veículo!`);
      console.error(`   Entregas no cluster: ${cluster.points.length}`);
      const requiredTypes = [...new Set(cluster.points.flatMap(p => p.vehicleTypes))];
      console.error(`   Tipos de veículo necessários: ${requiredTypes.join(', ') || 'qualquer'}`);
      console.error(`   Veículos disponíveis: ${vehicles.map(v => `${v.driverName}(${v.vehicleType})`).join(', ')}`);
      
      // Tentar dividir cluster por tipo de veículo necessário
      if (requiredTypes.length > 1) {
        console.warn(`⚠️  Cluster ${cluster.id} tem entregas com tipos de veículo incompatíveis. Dividindo cluster...`);
        
        // Criar sub-clusters por tipo de veículo
        const subClustersByType = new Map<string, DeliveryPoint[]>();
        
        for (const point of cluster.points) {
          // Se ponto aceita qualquer veículo, colocar em sub-cluster especial
          if (!point.vehicleTypes || point.vehicleTypes.length === 0) {
            if (!subClustersByType.has('any')) {
              subClustersByType.set('any', []);
            }
            subClustersByType.get('any')!.push(point);
          } else {
            // Agrupar por primeiro tipo de veículo aceito
            const vehicleType = point.vehicleTypes[0];
            if (!subClustersByType.has(vehicleType)) {
              subClustersByType.set(vehicleType, []);
            }
            subClustersByType.get(vehicleType)!.push(point);
          }
        }
        
        // Tentar atribuir cada sub-cluster
        let allSubClustersAssigned = true;
        
        for (const [vehicleType, points] of Array.from(subClustersByType.entries())) {
          // Encontrar veículo compatível
          const compatibleVehicles = vehicleType === 'any' 
            ? vehicles
            : vehicles.filter(v => v.vehicleType === vehicleType);
          
          if (compatibleVehicles.length === 0) {
            console.error(`❌ Nenhum veículo ${vehicleType} disponível para ${points.length} entregas do sub-cluster`);
            allSubClustersAssigned = false;
            break;
          }
          
          // Atribuir ao veículo compatível com menos carga
          let bestSubVehicle: Vehicle | null = null;
          let minLoad = Infinity;
          
          for (const vehicle of compatibleVehicles) {
            const currentLoad = assignment.get(vehicle.id)?.reduce((sum, c) => sum + c.points.length, 0) || 0;
            if (currentLoad < minLoad) {
              minLoad = currentLoad;
              bestSubVehicle = vehicle;
            }
          }
          
          if (bestSubVehicle) {
            // Criar sub-cluster
            const subCluster: Cluster = {
              id: cluster.id + (subClustersByType.size > 1 ? `-${vehicleType}` : ''),
              centroid: cluster.centroid,
              points,
              avgLatitude: cluster.avgLatitude,
              avgLongitude: cluster.avgLongitude,
              radius: cluster.radius
            };
            assignment.get(bestSubVehicle.id)!.push(subCluster);
            console.warn(`   ✅ Sub-cluster ${vehicleType}: ${points.length} entregas → ${bestSubVehicle.driverName}`);
          } else {
            allSubClustersAssigned = false;
            break;
          }
        }
        
        if (!allSubClustersAssigned) {
          throw new Error(
            `Não foi possível atribuir todas as entregas do cluster ${cluster.id} mesmo após divisão. ` +
            `Verifique a disponibilidade de veículos dos tipos necessários.`
          );
        }
      } else {
        // Cluster homogêneo mas sem veículo compatível - FALHAR
        throw new Error(
          `Não foi possível atribuir cluster ${cluster.id} com ${cluster.points.length} entregas. ` +
          `Tipo de veículo necessário: ${requiredTypes[0] || 'qualquer'}. ` +
          `Nenhum veículo compatível disponível.`
        );
      }
    }
  }
  
  return assignment;
}

/**
 * Gera rotas setorizadas otimizadas para múltiplos veículos
 * 
 * @param storage - Storage do banco de dados
 * @param routeDate - Data da rota
 * @param availableVehicles - Veículos disponíveis para entregas
 * @param points - Pontos de entrega a serem roteirizados
 * @returns Rotas setorizadas por veículo
 */
export async function generateSectorizedRoutes(
  storage: DatabaseStorage,
  routeDate: Date,
  availableVehicles: Vehicle[],
  points: DeliveryPoint[]
): Promise<SectorizedRoute[]> {
  console.log(`\n🗺️  === GERAÇÃO DE ROTAS SETORIZADAS ===`);
  console.log(`📅 Data: ${routeDate.toLocaleDateString('pt-BR')}`);
  console.log(`🚚 Veículos disponíveis: ${availableVehicles.length}`);
  console.log(`📦 Entregas totais: ${points.length}\n`);
  
  if (points.length === 0) {
    console.log(`⚠️  Nenhuma entrega para roteirizar`);
    return [];
  }
  
  if (availableVehicles.length === 0) {
    throw new Error('Nenhum veículo disponível para gerar rotas');
  }
  
  // PASSO 1: Separar entregas com veículos exclusivos
  const { exclusive, regular } = separateExclusiveDeliveries(points);
  console.log(`📊 Entregas exclusivas: ${exclusive.length}`);
  console.log(`📊 Entregas regulares: ${regular.length}\n`);
  
  const routes: SectorizedRoute[] = [];
  
  // PASSO 2: Processar entregas exclusivas (não clusterizar, atribuir direto a veículos compatíveis)
  if (exclusive.length > 0) {
    console.log(`🎯 Processando entregas com veículo exclusivo...`);
    
    // Validar TODAS as entregas exclusivas antes de processar
    const invalidExclusiveDeliveries: DeliveryPoint[] = [];
    for (const delivery of exclusive) {
      if (!delivery.vehicleTypes || delivery.vehicleTypes.length === 0) {
        console.error(`❌ Entrega exclusiva ${delivery.customerId} sem vehicleTypes definido!`);
        invalidExclusiveDeliveries.push(delivery);
      }
    }
    
    if (invalidExclusiveDeliveries.length > 0) {
      throw new Error(
        `${invalidExclusiveDeliveries.length} entregas exclusivas sem tipo de veículo definido. ` +
        `IDs: ${invalidExclusiveDeliveries.map(d => d.customerId).join(', ')}`
      );
    }
    
    // Agrupar entregas exclusivas por tipo de veículo requerido
    const exclusiveByType = new Map<string, DeliveryPoint[]>();
    
    for (const delivery of exclusive) {
      const vehicleType = delivery.vehicleTypes[0]; // Já validamos que existe
      if (!exclusiveByType.has(vehicleType)) {
        exclusiveByType.set(vehicleType, []);
      }
      exclusiveByType.get(vehicleType)!.push(delivery);
    }
    
    // Atribuir a veículos compatíveis
    const unassignedExclusiveDeliveries: DeliveryPoint[] = [];
    
    for (const [vehicleType, deliveries] of Array.from(exclusiveByType.entries())) {
      const compatibleVehicles = availableVehicles.filter(v => 
        v.vehicleType === vehicleType
      );
      
      if (compatibleVehicles.length === 0) {
        console.error(
          `❌ Nenhum veículo ${vehicleType} disponível para ${deliveries.length} entregas exclusivas!`
        );
        unassignedExclusiveDeliveries.push(...deliveries);
        continue;
      }
      
      // Usar primeiro veículo compatível disponível
      const vehicle = compatibleVehicles[0];
      
      // Otimizar rota
      const routePoints = deliveries.map((d: DeliveryPoint) => ({
        id: d.customerId,
        latitude: d.latitude,
        longitude: d.longitude,
        customerName: d.customerName,
        customerAddress: d.customerAddress
      }));
      
      const optimized = await optimizeRoute(
        vehicle.homeLatitude,
        vehicle.homeLongitude,
        routePoints
      );
      
      routes.push({
        vehicleId: vehicle.id,
        driverId: vehicle.driverId,
        driverName: vehicle.driverName,
        vehicleType: vehicle.vehicleType,
        sector: {
          id: -1,
          centroid: { latitude: vehicle.homeLatitude, longitude: vehicle.homeLongitude },
          points: deliveries,
          avgLatitude: vehicle.homeLatitude,
          avgLongitude: vehicle.homeLongitude,
          radius: 0
        },
        optimizedOrder: optimized.orderedPoints.map(p => p.id),
        deliveryPoints: deliveries,
        totalDistance: optimized.totalDistance,
        totalDeliveries: deliveries.length,
        warnings: [`Rota com veículo exclusivo (${vehicleType})`]
      });
      
      console.log(`   ✅ Rota exclusiva ${vehicleType}: ${deliveries.length} entregas, ${optimized.totalDistance.toFixed(2)}km`);
    }
    
    // Se houver entregas exclusivas não atribuídas, falhar
    if (unassignedExclusiveDeliveries.length > 0) {
      throw new Error(
        `Não foi possível atribuir ${unassignedExclusiveDeliveries.length} entregas exclusivas. ` +
        `Verifique se há veículos dos tipos necessários disponíveis. ` +
        `IDs não atribuídos: ${unassignedExclusiveDeliveries.map(d => d.customerId).slice(0, 5).join(', ')}` +
        `${unassignedExclusiveDeliveries.length > 5 ? '...' : ''}`
      );
    }
  }
  
  // PASSO 3: Clusterizar entregas regulares por região
  if (regular.length > 0) {
    console.log(`\n🌍 Clusterizando ${regular.length} entregas regulares...`);
    
    // Número de clusters = número de veículos disponíveis (balanceado)
    const numClusters = Math.min(availableVehicles.length, regular.length);
    console.log(`   🎯 Criando ${numClusters} setores regionais`);
    
    const clusters = kMeansClustering(regular, numClusters);
    console.log(`   ✅ ${clusters.length} clusters criados`);
    
    // Log de informações dos clusters
    for (const cluster of clusters) {
      console.log(`      Cluster ${cluster.id}: ${cluster.points.length} entregas, raio ${cluster.radius.toFixed(2)}km`);
    }
    
    // PASSO 4: Atribuir clusters a veículos
    console.log(`\n🚛 Atribuindo setores a veículos...`);
    const assignment = assignClustersToVehicles(clusters, availableVehicles);
    
    // PASSO 5: Gerar rotas otimizadas para cada veículo/setor
    console.log(`\n🗺️  Otimizando rotas por setor...\n`);
    
    for (const [vehicleId, assignedClusters] of Array.from(assignment.entries())) {
      if (assignedClusters.length === 0) continue;
      
      const vehicle = availableVehicles.find(v => v.id === vehicleId)!;
      
      // Combinar todos os pontos dos clusters atribuídos a este veículo
      const allPoints = assignedClusters.flatMap((c: Cluster) => c.points);
      
      if (allPoints.length === 0) continue;
      
      // Otimizar rota completa do veículo
      const routePoints = allPoints.map((d: DeliveryPoint) => ({
        id: d.customerId,
        latitude: d.latitude,
        longitude: d.longitude,
        customerName: d.customerName,
        customerAddress: d.customerAddress
      }));
      
      const optimized = await optimizeRoute(
        vehicle.homeLatitude,
        vehicle.homeLongitude,
        routePoints
      );
      
      const warnings: string[] = [];
      if (optimized.totalDistance > 300) {
        warnings.push(`Rota longa (${optimized.totalDistance.toFixed(2)}km)`);
      }
      
      routes.push({
        vehicleId: vehicle.id,
        driverId: vehicle.driverId,
        driverName: vehicle.driverName,
        vehicleType: vehicle.vehicleType,
        sector: assignedClusters[0], // Usar primeiro cluster como representativo
        optimizedOrder: optimized.orderedPoints.map(p => p.id),
        deliveryPoints: allPoints,
        totalDistance: optimized.totalDistance,
        totalDeliveries: allPoints.length,
        warnings
      });
      
      // VALIDAÇÃO: Verificar que todas as entregas são compatíveis com o veículo
      const incompatibleDeliveries = allPoints.filter(p => {
        // Se entrega não especifica tipo, é compatível com qualquer veículo
        if (!p.vehicleTypes || p.vehicleTypes.length === 0) return false;
        // Verificar se tipo do veículo está nos tipos aceitos
        return !p.vehicleTypes.includes(vehicle.vehicleType);
      });
      
      if (incompatibleDeliveries.length > 0) {
        throw new Error(
          `ERRO: ${incompatibleDeliveries.length} entregas incompatíveis com veículo ${vehicle.driverName} (${vehicle.vehicleType}). ` +
          `IDs: ${incompatibleDeliveries.map(d => d.customerId).slice(0, 5).join(', ')}. ` +
          `Isto indica um erro na atribuição de clusters.`
        );
      }
      
      routes.push({
        vehicleId: vehicle.id,
        driverId: vehicle.driverId,
        driverName: vehicle.driverName,
        vehicleType: vehicle.vehicleType,
        sector: assignedClusters[0], // Usar primeiro cluster como representativo
        optimizedOrder: optimized.orderedPoints.map(p => p.id),
        deliveryPoints: allPoints,
        totalDistance: optimized.totalDistance,
        totalDeliveries: allPoints.length,
        warnings
      });
      
      console.log(`   ✅ ${vehicle.driverName} (${vehicle.vehicleType}): ${allPoints.length} entregas, ${optimized.totalDistance.toFixed(2)}km`);
      console.log(`      Setores: ${assignedClusters.map((c: Cluster) => `#${c.id} (${c.points.length})`).join(', ')}`);
    }
  }
  
  console.log(`\n✅ === GERAÇÃO CONCLUÍDA ===`);
  console.log(`📊 Total de rotas geradas: ${routes.length}`);
  const totalDeliveriesInRoutes = routes.reduce((sum, r) => sum + r.totalDeliveries, 0);
  console.log(`📦 Total de entregas: ${totalDeliveriesInRoutes}`);
  console.log(`🛣️  Distância total estimada: ${routes.reduce((sum, r) => sum + r.totalDistance, 0).toFixed(2)}km`);
  
  // VALIDAÇÃO FINAL: Garantir que todas as entregas foram atribuídas
  if (totalDeliveriesInRoutes < points.length) {
    const missing = points.length - totalDeliveriesInRoutes;
    throw new Error(
      `ERRO CRÍTICO: ${missing} entregas não foram atribuídas a nenhuma rota! ` +
      `Total esperado: ${points.length}, Total nas rotas: ${totalDeliveriesInRoutes}`
    );
  }
  
  console.log(`✅ Todas as ${points.length} entregas foram atribuídas com sucesso!\n`);
  
  return routes;
}

/**
 * Gera rotas setorizadas para uma data específica consultando banco de dados
 * 
 * @param storage - Storage do banco de dados
 * @param routeDate - Data para gerar as rotas
 * @returns Rotas setorizadas por veículo
 */
export async function generateDailySectorizedRoutes(
  storage: DatabaseStorage,
  routeDate: Date
): Promise<SectorizedRoute[]> {
  // Buscar motoristas ativos
  const drivers = await storage.getActiveDeliveryDrivers();
  
  if (drivers.length === 0) {
    throw new Error('Nenhum motorista ativo encontrado');
  }
  
  // Montar veículos disponíveis usando coordenadas direto da tabela deliveryDrivers
  const vehicles: Vehicle[] = drivers
    .filter(d => d.isActive)
    .map(d => {
      // Verificar se motorista tem coordenadas cadastradas
      if (!d.homeLatitude || !d.homeLongitude) {
        console.warn(`⚠️  Motorista ${d.name} sem coordenadas de casa cadastradas`);
        return null;
      }
      
      return {
        id: d.id,
        driverId: d.id,
        driverName: d.name,
        vehicleType: (d.vehicleType || 'moto') as 'caminhao' | 'carro' | 'moto',
        homeLatitude: parseFloat(d.homeLatitude as any),
        homeLongitude: parseFloat(d.homeLongitude as any)
      };
    })
    .filter((v): v is Vehicle => v !== null);
  
  if (vehicles.length === 0) {
    throw new Error('Nenhum veículo com coordenadas válidas encontrado');
  }
  
  console.log(`🚚 Veículos disponíveis: ${vehicles.map(v => `${v.driverName} (${v.vehicleType})`).join(', ')}`);
  
  // Buscar entregas pendentes para a data
  const pendingDeliveries = await storage.getPendingDeliveries();
  
  // Filtrar por data (usar receivingWeekdays/deliveryWeekdays)
  const targetWeekday = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][routeDate.getDay()];
  
  // Converter para pontos de entrega
  const deliveryPoints: DeliveryPoint[] = pendingDeliveries
    .filter((d: any) => d.customerLatitude && d.customerLongitude)
    .filter((d: any) => {
      // Filtrar por dia da semana se disponível
      if (d.receivingWeekdays && d.receivingWeekdays.length > 0) {
        return d.receivingWeekdays.includes(targetWeekday);
      }
      return true; // Se não tem preferência, incluir
    })
    .map((d: any) => ({
      id: d.id,
      customerId: d.customerId,
      latitude: parseFloat(d.customerLatitude as any),
      longitude: parseFloat(d.customerLongitude as any),
      customerName: d.customerName || 'Cliente',
      customerAddress: d.customerAddress || '',
      exclusiveVehicle: d.exclusiveVehicle || false,
      vehicleTypes: d.vehicleTypes || [],
      timeSlots: d.deliveryTimeSlots || [],
      weekdays: d.receivingWeekdays || [],
      isUrgent: d.isUrgent || false,
      priority: d.isUrgent ? 5 : 3
    }));
  
  // Gerar rotas setorizadas
  return await generateSectorizedRoutes(storage, routeDate, vehicles, deliveryPoints);
}
