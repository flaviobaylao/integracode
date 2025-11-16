import { DatabaseStorage } from './storage';
import { optimizeRoute, calculateDistance } from './routeOptimizationService';
import { nanoid } from 'nanoid';

// ==================== Data Structures ====================

interface DeliveryOrder {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: number;
  customerLongitude: number;
  averageDeliveryTime: number; // em minutos
  exclusiveVehicle: boolean;
  vehicleTypes: ('caminhao' | 'carro' | 'moto')[];
  isUrgent: boolean;
  saleValue: number;
  products: any;
  scheduledDate: Date;
  completedDate: Date;
  paymentMethod: string;
  operationType: string;
}

interface VehicleConfig {
  type: 'caminhao' | 'carro' | 'moto';
  driverId?: string;
  driverName?: string;
  startLatitude: number;
  startLongitude: number;
  startAddress: string;
  timeWindowStart: string; // HH:mm
  timeWindowEnd: string; // HH:mm
  capacity?: number; // número máximo de entregas
}

interface RouteStop {
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  latitude: number;
  longitude: number;
  estimatedArrival: Date;
  estimatedDeparture: Date;
  estimatedServiceTime: number; // em minutos
  stopOrder: number;
  distanceFromPrevious: number;
}

interface VehicleRoute {
  vehicleType: 'caminhao' | 'carro' | 'moto';
  driverId?: string;
  driverName?: string;
  startLatitude: number;
  startLongitude: number;
  startAddress: string;
  stops: RouteStop[];
  totalDistance: number;
  totalDuration: number; // em minutos
  routeDate: Date;
}

interface RoutePlan {
  routes: VehicleRoute[];
  unassignedOrders: DeliveryOrder[];
  stats: {
    totalOrders: number;
    assignedOrders: number;
    unassignedOrders: number;
    totalDistance: number;
    totalVehicles: number;
  };
}

// ==================== Helper Functions ====================

/**
 * Verifica se um pedido é compatível com um veículo
 */
function isOrderCompatibleWithVehicle(
  order: DeliveryOrder,
  vehicleType: 'caminhao' | 'carro' | 'moto'
): boolean {
  // Se não requer veículo exclusivo, qualquer veículo serve
  if (!order.exclusiveVehicle) {
    return true;
  }
  
  // Se requer veículo exclusivo, verificar se o tipo está na lista permitida
  return order.vehicleTypes.includes(vehicleType);
}

/**
 * Calcula a distância do depósito até um pedido
 */
function distanceFromDepot(
  depotLat: number,
  depotLon: number,
  order: DeliveryOrder
): number {
  return calculateDistance(depotLat, depotLon, order.customerLatitude, order.customerLongitude);
}

/**
 * Converte string HH:mm para minutos desde meia-noite
 */
function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Adiciona minutos a uma data
 */
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

// ==================== Main Algorithm ====================

/**
 * FASE 1: Pré-processamento
 * Filtra pedidos por elegibilidade e separa urgentes
 */
function preprocessOrders(
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[]
): {
  eligibleByVehicle: Map<number, DeliveryOrder[]>;
  urgentOrders: DeliveryOrder[];
  regularOrders: DeliveryOrder[];
} {
  // Filtrar pedidos com coordenadas inválidas
  const validOrders = orders.filter(order => {
    const lat = Number(order.customerLatitude);
    const lon = Number(order.customerLongitude);
    const hasValidCoords = 
      order.customerLatitude != null && 
      order.customerLongitude != null &&
      !isNaN(lat) &&
      !isNaN(lon) &&
      lat !== 0 &&
      lon !== 0;
    
    if (!hasValidCoords) {
      console.warn(`Pedido ${order.id} ignorado: coordenadas inválidas (lat: ${order.customerLatitude}, lon: ${order.customerLongitude})`);
    }
    
    return hasValidCoords;
  });

  if (validOrders.length === 0) {
    throw new Error('Nenhum pedido com coordenadas válidas para otimização');
  }

  const eligibleByVehicle = new Map<number, DeliveryOrder[]>();
  const urgentOrders: DeliveryOrder[] = [];
  const regularOrders: DeliveryOrder[] = [];

  // Inicializar mapa de elegibilidade
  vehicles.forEach((_, idx) => {
    eligibleByVehicle.set(idx, []);
  });

  // Classificar pedidos
  for (const order of validOrders) {
    // Verificar quais veículos podem atender este pedido
    vehicles.forEach((vehicle, idx) => {
      if (isOrderCompatibleWithVehicle(order, vehicle.type)) {
        eligibleByVehicle.get(idx)!.push(order);
      }
    });

    // Separar urgentes de regulares
    if (order.isUrgent) {
      urgentOrders.push(order);
    } else {
      regularOrders.push(order);
    }
  }

  return { eligibleByVehicle, urgentOrders, regularOrders };
}

/**
 * FASE 2: Atribuição de Veículos
 * Usa greedy assignment com prioridade para urgentes
 */
function assignOrdersToVehicles(
  urgentOrders: DeliveryOrder[],
  regularOrders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>
): {
  assignments: Map<number, DeliveryOrder[]>;
  unassigned: DeliveryOrder[];
} {
  const assignments = new Map<number, DeliveryOrder[]>();
  const assigned = new Set<string>();
  const unassigned: DeliveryOrder[] = [];

  // Inicializar assignments
  vehicles.forEach((_, idx) => {
    assignments.set(idx, []);
  });

  // Processar pedidos urgentes primeiro
  for (const order of urgentOrders) {
    let bestVehicle = -1;
    let minDistance = Infinity;

    // Encontrar veículo compatível mais próximo com capacidade
    vehicles.forEach((vehicle, idx) => {
      if (!eligibleByVehicle.get(idx)!.find(o => o.id === order.id)) {
        return; // Veículo não compatível
      }

      const currentLoad = assignments.get(idx)!.length;
      if (vehicle.capacity && currentLoad >= vehicle.capacity) {
        return; // Veículo cheio
      }

      const distance = distanceFromDepot(
        vehicle.startLatitude,
        vehicle.startLongitude,
        order
      );

      if (distance < minDistance) {
        minDistance = distance;
        bestVehicle = idx;
      }
    });

    if (bestVehicle >= 0) {
      assignments.get(bestVehicle)!.push(order);
      assigned.add(order.id);
    } else {
      unassigned.push(order);
    }
  }

  // Processar pedidos regulares
  for (const order of regularOrders) {
    if (assigned.has(order.id)) continue;

    let bestVehicle = -1;
    let minDistance = Infinity;

    // Encontrar veículo compatível mais próximo com capacidade
    vehicles.forEach((vehicle, idx) => {
      if (!eligibleByVehicle.get(idx)!.find(o => o.id === order.id)) {
        return; // Veículo não compatível
      }

      const currentLoad = assignments.get(idx)!.length;
      if (vehicle.capacity && currentLoad >= vehicle.capacity) {
        return; // Veículo cheio
      }

      const distance = distanceFromDepot(
        vehicle.startLatitude,
        vehicle.startLongitude,
        order
      );

      if (distance < minDistance) {
        minDistance = distance;
        bestVehicle = idx;
      }
    });

    if (bestVehicle >= 0) {
      assignments.get(bestVehicle)!.push(order);
      assigned.add(order.id);
    } else {
      unassigned.push(order);
    }
  }

  return { assignments, unassigned };
}

/**
 * FASE 3: Otimização por Veículo
 * Aplica Nearest Neighbor + 2-opt para cada veículo
 * Calcula ETAs baseado em tempo de serviço e distância
 */
async function optimizeVehicleRoutes(
  assignments: Map<number, DeliveryOrder[]>,
  vehicles: VehicleConfig[],
  routeDate: Date
): Promise<VehicleRoute[]> {
  const routes: VehicleRoute[] = [];

  for (const [vehicleIdx, orders] of Array.from(assignments.entries())) {
    if (orders.length === 0) continue;

    const vehicle = vehicles[vehicleIdx];
    
    // Converter pedidos para pontos de rota
    const routePoints = orders.map((order: DeliveryOrder) => ({
      id: order.id,
      latitude: order.customerLatitude,
      longitude: order.customerLongitude,
      customerName: order.customerName,
      customerAddress: order.customerAddress
    }));

    // Otimizar ordem das paradas usando algoritmo existente
    const optimized = await optimizeRoute(
      vehicle.startLatitude,
      vehicle.startLongitude,
      routePoints
    );

    // Calcular ETAs
    const timeWindowStartMinutes = timeToMinutes(vehicle.timeWindowStart);
    const startTime = new Date(routeDate);
    startTime.setHours(0, 0, 0, 0);
    startTime.setMinutes(timeWindowStartMinutes);

    let currentTime = new Date(startTime);
    let totalDuration = 0;

    const stops: RouteStop[] = [];

    for (let i = 0; i < optimized.orderedPoints.length; i++) {
      const point = optimized.orderedPoints[i];
      const order = orders.find((o: DeliveryOrder) => o.id === point.id)!;
      const segment = optimized.segments[i];

      console.log(`🔧 [OPTIMIZE] Processing stop for ${order.customerName}:`);
      console.log(`   - order.customerLatitude: ${order.customerLatitude} (type: ${typeof order.customerLatitude})`);
      console.log(`   - order.customerLongitude: ${order.customerLongitude} (type: ${typeof order.customerLongitude})`);
      console.log(`   - Number(lat): ${Number(order.customerLatitude)}`);
      console.log(`   - Number(lng): ${Number(order.customerLongitude)}`);

      // Tempo de viagem até esta parada (assumir 40 km/h médio)
      const travelTimeMinutes = (segment.distance / 40) * 60;
      const arrivalTime = addMinutes(currentTime, travelTimeMinutes);
      
      // Tempo de serviço (entrega)
      const serviceTime = order.averageDeliveryTime;
      const departureTime = addMinutes(arrivalTime, serviceTime);

      stops.push({
        salesCardId: order.id,
        customerId: order.customerId,
        customerName: order.customerName,
        customerAddress: order.customerAddress,
        latitude: Number(order.customerLatitude),
        longitude: Number(order.customerLongitude),
        estimatedArrival: arrivalTime,
        estimatedDeparture: departureTime,
        estimatedServiceTime: serviceTime,
        stopOrder: i + 1,
        distanceFromPrevious: segment.distance
      });

      currentTime = departureTime;
      totalDuration += travelTimeMinutes + serviceTime;
    }

    routes.push({
      vehicleType: vehicle.type,
      driverId: vehicle.driverId,
      driverName: vehicle.driverName,
      startLatitude: vehicle.startLatitude,
      startLongitude: vehicle.startLongitude,
      startAddress: vehicle.startAddress,
      stops,
      totalDistance: optimized.totalDistance,
      totalDuration,
      routeDate
    });
  }

  return routes;
}

/**
 * FASE 4: Persistência
 * Salva rotas e paradas no banco de dados
 */
async function persistRoutePlan(
  storage: DatabaseStorage,
  routes: VehicleRoute[],
  routeDate: Date
): Promise<any[]> {
  const savedRoutes = [];

  for (const route of routes) {
    // Validação defensiva: verificar coordenadas da rota
    if (!route.startLatitude || !route.startLongitude || 
        !isFinite(route.startLatitude) || !isFinite(route.startLongitude) ||
        Math.abs(route.startLatitude) > 90 || Math.abs(route.startLongitude) > 180) {
      throw new Error(`Rota com coordenadas de início inválidas: lat=${route.startLatitude}, lng=${route.startLongitude}`);
    }

    // Criar rota de entrega
    const deliveryRoute = await storage.createDeliveryRoute({
      id: nanoid(),
      vehicleType: route.vehicleType,
      driverId: route.driverId,
      routeDate,
      startLatitude: route.startLatitude.toString(),
      startLongitude: route.startLongitude.toString(),
      startAddress: route.startAddress,
      totalDistance: route.totalDistance.toString(),
      totalDuration: route.totalDuration.toString(),
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Criar paradas da rota
    for (const stop of route.stops) {
      // Validação defensiva: verificar coordenadas da parada
      if (!stop.latitude || !stop.longitude || 
          !isFinite(stop.latitude) || !isFinite(stop.longitude) ||
          stop.latitude === 0 || stop.longitude === 0 ||
          Math.abs(stop.latitude) > 90 || Math.abs(stop.longitude) > 180) {
        throw new Error(`Parada "${stop.customerName}" com coordenadas inválidas: lat=${stop.latitude}, lng=${stop.longitude}`);
      }

      const stopData = {
        id: nanoid(),
        routeId: deliveryRoute.id,
        salesCardId: stop.salesCardId,
        customerId: stop.customerId,
        customerName: stop.customerName,
        customerAddress: stop.customerAddress,
        customerLatitude: stop.latitude.toString(),
        customerLongitude: stop.longitude.toString(),
        estimatedArrival: stop.estimatedArrival,
        estimatedDeparture: stop.estimatedDeparture,
        estimatedServiceTime: stop.estimatedServiceTime.toString(),
        stopOrder: stop.stopOrder,
        distanceFromPrevious: stop.distanceFromPrevious.toString(),
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      console.log(`💾 [PERSIST] Creating stop for ${stop.customerName}:`);
      console.log(`   - stop.latitude: ${stop.latitude} → toString: "${stopData.customerLatitude}"`);
      console.log(`   - stop.longitude: ${stop.longitude} → toString: "${stopData.customerLongitude}"`);

      await storage.createDeliveryRouteStop(stopData);
    }

    savedRoutes.push({
      ...deliveryRoute,
      stops: route.stops
    });
  }

  return savedRoutes;
}

// ==================== Main Entry Point ====================

/**
 * Planeja rotas de entrega para múltiplos veículos
 */
export async function planDeliveryRoutes(
  storage: DatabaseStorage,
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  routeDate: Date
): Promise<RoutePlan> {
  // FASE 1: Pré-processamento
  const { eligibleByVehicle, urgentOrders, regularOrders } = preprocessOrders(orders, vehicles);

  // FASE 2: Atribuição de veículos
  const { assignments, unassigned } = assignOrdersToVehicles(
    urgentOrders,
    regularOrders,
    vehicles,
    eligibleByVehicle
  );

  // FASE 3: Otimização por veículo
  const routes = await optimizeVehicleRoutes(assignments, vehicles, routeDate);

  // FASE 4: Persistir rotas
  await persistRoutePlan(storage, routes, routeDate);

  // Calcular estatísticas
  const totalDistance = routes.reduce((sum, r) => sum + r.totalDistance, 0);
  const assignedOrders = routes.reduce((sum, r) => sum + r.stops.length, 0);

  return {
    routes,
    unassignedOrders: unassigned,
    stats: {
      totalOrders: orders.length,
      assignedOrders,
      unassignedOrders: unassigned.length,
      totalDistance,
      totalVehicles: routes.length
    }
  };
}
