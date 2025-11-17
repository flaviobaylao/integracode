import { DatabaseStorage } from './storage';
import { optimizeRoute, calculateDistance } from './routeOptimizationService';
import { nanoid } from 'nanoid';
import { db } from './db';
import { deliveryHistory } from '../shared/schema';
import { eq, desc, and } from 'drizzle-orm';

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
  customerWeekdays?: string; // JSON array com dias da semana permitidos
  deliveryTimeSlots?: string[]; // Array com horários permitidos (ex: ["08:00-12:00"])
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
  
  // Se requer veículo exclusivo mas não especificou tipos, aceitar qualquer um
  if (!order.vehicleTypes || order.vehicleTypes.length === 0) {
    return true;
  }
  
  // Se especificou tipos, verificar se o tipo está na lista permitida
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

/**
 * Converte data para nome do dia da semana em português
 */
function getWeekdayName(date: Date): string {
  const weekdays = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  return weekdays[date.getDay()];
}

/**
 * Valida se o cliente pode receber entrega no dia da semana especificado
 * @param customerWeekdays - Array ou string JSON com os dias da semana permitidos para o cliente (null = sem restrição)
 * @param routeDate - Data da rota de entrega
 * @returns true se o dia é permitido, false caso contrário
 */
function isValidDeliveryWeekday(customerWeekdays: string | string[] | null | undefined, routeDate: Date): boolean {
  try {
    // Se for null/undefined, permitir qualquer dia (sem restrição)
    if (!customerWeekdays || (Array.isArray(customerWeekdays) && customerWeekdays.length === 0)) {
      return true;
    }
    
    // Se já for array, usar direto; se for string, fazer parse
    const allowedDays = Array.isArray(customerWeekdays) 
      ? customerWeekdays 
      : JSON.parse(customerWeekdays) as string[];
    
    const routeWeekday = getWeekdayName(routeDate);
    
    // Normalizar ambos os lados para comparação (remover acentos e lowercas)
    const normalizedRouteDay = routeWeekday.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    
    return allowedDays.some(day => {
      const normalizedDay = day.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return normalizedDay === normalizedRouteDay || normalizedDay.startsWith(normalizedRouteDay.substring(0, 3));
    });
  } catch (error) {
    console.error('Erro ao validar dia da semana:', error, 'customerWeekdays:', customerWeekdays);
    return true; // Em caso de erro, permitir para não bloquear desnecessariamente
  }
}

/**
 * Valida se o horário da janela de entrega é compatível com os horários permitidos do cliente
 * @param deliveryTimeSlots - Array com horários permitidos (ex: ["08:00", "09:00"] ou ["08:00-12:00"])
 * @param timeWindowStart - Horário de início da janela da rota (ex: "08:00")
 * @param timeWindowEnd - Horário de fim da janela da rota (ex: "12:00")
 * @returns true se há compatibilidade de horários, false caso contrário
 */
function isValidDeliveryTimeSlot(
  deliveryTimeSlots: string[] | undefined,
  timeWindowStart: string,
  timeWindowEnd: string
): boolean {
  // Se não houver restrição de horários, aceitar qualquer janela
  if (!deliveryTimeSlots || deliveryTimeSlots.length === 0) {
    return true;
  }
  
  try {
    const routeStart = timeToMinutes(timeWindowStart);
    const routeEnd = timeToMinutes(timeWindowEnd);
    
    // Verificar se a janela da rota se sobrepõe com algum dos horários permitidos
    for (const slot of deliveryTimeSlots) {
      // Se for intervalo (formato "08:00-12:00")
      if (slot.includes('-')) {
        const [slotStart, slotEnd] = slot.split('-');
        const slotStartMin = timeToMinutes(slotStart);
        const slotEndMin = timeToMinutes(slotEnd);
        
        // Verificar sobreposição de intervalos
        if (routeStart < slotEndMin && routeEnd > slotStartMin) {
          return true;
        }
      } else {
        // Se for horário individual (formato "08:00"), verificar se está dentro da janela
        const slotMin = timeToMinutes(slot);
        
        // Horário individual está dentro da janela do veículo?
        if (slotMin >= routeStart && slotMin < routeEnd) {
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    console.error('Erro ao validar horário de entrega:', error, 'slots:', deliveryTimeSlots);
    return true; // Em caso de erro, permitir para não bloquear desnecessariamente
  }
}

/**
 * Calcula o tempo médio de entrega em minutos baseado no histórico de deliveries
 * @param customerId - ID do cliente
 * @returns Tempo médio em minutos (padrão: 10 se não houver histórico)
 */
async function calculateAverageDeliveryTime(customerId: string): Promise<number> {
  try {
    const history = await db
      .select()
      .from(deliveryHistory)
      .where(
        and(
          eq(deliveryHistory.customerId, customerId),
          eq(deliveryHistory.status, 'delivered')
        )
      )
      .orderBy(desc(deliveryHistory.timestamp))
      .limit(10); // Considerar as últimas 10 entregas concluídas
    
    if (!history || history.length === 0) {
      return 10; // Padrão de 10 minutos se não houver histórico
    }
    
    // Calcular média dos tempos de entrega que foram concluídos (com delivery_duration)
    const validDurations = history
      .map((h: any) => h.deliveryDuration)
      .filter((d: number | null) => d && d > 0);
    
    if (validDurations.length === 0) {
      return 10;
    }
    
    const average = validDurations.reduce((sum: number, d: number) => sum + d, 0) / validDurations.length;
    
    console.log(`📊 [AVG-DELIVERY-TIME] Cliente ${customerId}: ${validDurations.length} entregas, média ${Math.round(average)} min`);
    
    return Math.round(average);
  } catch (error) {
    console.error('Erro ao calcular tempo médio de entrega:', error);
    return 10;
  }
}

// ==================== Main Algorithm ====================

/**
 * FASE 1: Pré-processamento
 * Filtra pedidos por elegibilidade e separa urgentes
 */
function preprocessOrders(
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  routeDate: Date
): {
  eligibleByVehicle: Map<number, DeliveryOrder[]>;
  urgentOrders: DeliveryOrder[];
  regularOrders: DeliveryOrder[];
  invalidOrders: Array<{ order: DeliveryOrder; reason: string }>;
} {
  const invalidOrders: Array<{ order: DeliveryOrder; reason: string }> = [];
  
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
      const reason = `Coordenadas inválidas (lat: ${order.customerLatitude}, lon: ${order.customerLongitude})`;
      console.warn(`Pedido ${order.id} ignorado: ${reason}`);
      invalidOrders.push({ order, reason });
      return false;
    }
    
    // Validar dia da semana permitido para entrega
    if (order.customerWeekdays) {
      if (!isValidDeliveryWeekday(order.customerWeekdays, routeDate)) {
        const routeWeekday = getWeekdayName(routeDate);
        const reason = `Dia da semana não permitido para entrega (rota: ${routeWeekday}, permitido: ${order.customerWeekdays})`;
        console.warn(`Pedido ${order.id} ignorado: ${reason}`);
        invalidOrders.push({ order, reason });
        return false;
      }
    }
    
    return true;
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
    let isEligibleForAnyVehicle = false;
    
    // Verificar quais veículos podem atender este pedido
    vehicles.forEach((vehicle, idx) => {
      // Validar compatibilidade de veículo
      if (!isOrderCompatibleWithVehicle(order, vehicle.type)) {
        return;
      }
      
      // Validar horário de entrega (se especificado)
      if (order.deliveryTimeSlots && order.deliveryTimeSlots.length > 0) {
        if (!isValidDeliveryTimeSlot(order.deliveryTimeSlots, vehicle.timeWindowStart, vehicle.timeWindowEnd)) {
          return;
        }
      }
      
      eligibleByVehicle.get(idx)!.push(order);
      isEligibleForAnyVehicle = true;
    });
    
    // Se não for elegível para nenhum veículo devido a restrições de horário/tipo, marcar como inválido
    if (!isEligibleForAnyVehicle) {
      const reason = order.exclusiveVehicle 
        ? `Requer veículo exclusivo (${order.vehicleTypes.join(', ')}) não disponível ou incompatível com horários`
        : `Horários de entrega incompatíveis com janelas disponíveis`;
      console.warn(`Pedido ${order.id} ignorado: ${reason}`);
      invalidOrders.push({ order, reason });
      continue;
    }

    // Separar urgentes de regulares
    if (order.isUrgent) {
      urgentOrders.push(order);
    } else {
      regularOrders.push(order);
    }
  }

  return { eligibleByVehicle, urgentOrders, regularOrders, invalidOrders };
}

/**
 * FASE 2: Atribuição de Veículos
 * Usa distribuição proporcional com prioridade para urgentes
 * Balanceia carga considerando tempo de trabalho estimado
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
  const vehicleWorkload = new Map<number, number>(); // Tempo de trabalho em minutos
  const assigned = new Set<string>();
  const unassigned: DeliveryOrder[] = [];

  // Inicializar assignments e workload
  vehicles.forEach((vehicle, idx) => {
    assignments.set(idx, []);
    
    // Calcular janela de tempo disponível
    const startMinutes = timeToMinutes(vehicle.timeWindowStart);
    const endMinutes = timeToMinutes(vehicle.timeWindowEnd);
    const availableTime = endMinutes - startMinutes;
    
    // Inicializar workload com tempo de almoço (30 min) já descontado
    vehicleWorkload.set(idx, 30);
    
    console.log(`🚚 Veículo ${idx} (${vehicle.type}): ${availableTime} min disponíveis (${vehicle.timeWindowStart}-${vehicle.timeWindowEnd})`);
  });

  // Processar pedidos urgentes primeiro (prioridade máxima)
  for (const order of urgentOrders) {
    let bestVehicle = -1;
    let minWorkload = Infinity;

    // Encontrar veículo compatível com menor carga atual
    vehicles.forEach((vehicle, idx) => {
      if (!eligibleByVehicle.get(idx)!.find(o => o.id === order.id)) {
        return; // Veículo não compatível
      }

      const currentLoad = assignments.get(idx)!.length;
      if (vehicle.capacity && currentLoad >= vehicle.capacity) {
        return; // Veículo cheio
      }

      // Verificar se tem tempo disponível
      const startMinutes = timeToMinutes(vehicle.timeWindowStart);
      const endMinutes = timeToMinutes(vehicle.timeWindowEnd);
      const availableTime = endMinutes - startMinutes;
      const currentWorkload = vehicleWorkload.get(idx)!;
      
      if (currentWorkload + order.averageDeliveryTime > availableTime) {
        return; // Não cabe na janela de tempo
      }

      // Selecionar veículo com menor carga (para distribuição equilibrada)
      if (currentWorkload < minWorkload) {
        minWorkload = currentWorkload;
        bestVehicle = idx;
      }
    });

    if (bestVehicle >= 0) {
      assignments.get(bestVehicle)!.push(order);
      assigned.add(order.id);
      
      // Atualizar workload (tempo de entrega + tempo médio de deslocamento)
      const estimatedTravelTime = 15; // Estimativa de 15 min entre paradas
      vehicleWorkload.set(bestVehicle, vehicleWorkload.get(bestVehicle)! + order.averageDeliveryTime + estimatedTravelTime);
      
      console.log(`🔴 URGENTE ${order.customerName} → Veículo ${bestVehicle} (carga: ${vehicleWorkload.get(bestVehicle)} min)`);
    } else {
      unassigned.push(order);
      console.warn(`⚠️ Pedido urgente ${order.customerName} não pôde ser atribuído (sem veículos compatíveis ou com capacidade)`);
    }
  }

  // Processar pedidos regulares com distribuição proporcional
  for (const order of regularOrders) {
    if (assigned.has(order.id)) continue;

    let bestVehicle = -1;
    let minWorkload = Infinity;

    // Encontrar veículo compatível com menor carga atual
    vehicles.forEach((vehicle, idx) => {
      if (!eligibleByVehicle.get(idx)!.find(o => o.id === order.id)) {
        return; // Veículo não compatível
      }

      const currentLoad = assignments.get(idx)!.length;
      if (vehicle.capacity && currentLoad >= vehicle.capacity) {
        return; // Veículo cheio
      }

      // Verificar se tem tempo disponível
      const startMinutes = timeToMinutes(vehicle.timeWindowStart);
      const endMinutes = timeToMinutes(vehicle.timeWindowEnd);
      const availableTime = endMinutes - startMinutes;
      const currentWorkload = vehicleWorkload.get(idx)!;
      
      if (currentWorkload + order.averageDeliveryTime > availableTime) {
        return; // Não cabe na janela de tempo
      }

      // Selecionar veículo com menor carga (distribuição proporcional)
      if (currentWorkload < minWorkload) {
        minWorkload = currentWorkload;
        bestVehicle = idx;
      }
    });

    if (bestVehicle >= 0) {
      assignments.get(bestVehicle)!.push(order);
      assigned.add(order.id);
      
      // Atualizar workload
      const estimatedTravelTime = 15; // Estimativa de 15 min entre paradas
      vehicleWorkload.set(bestVehicle, vehicleWorkload.get(bestVehicle)! + order.averageDeliveryTime + estimatedTravelTime);
    } else {
      unassigned.push(order);
    }
  }

  // Log final de distribuição
  console.log('\n📊 DISTRIBUIÇÃO FINAL DE ENTREGAS:');
  vehicles.forEach((vehicle, idx) => {
    const deliveries = assignments.get(idx)!.length;
    const workload = vehicleWorkload.get(idx)!;
    const startMinutes = timeToMinutes(vehicle.timeWindowStart);
    const endMinutes = timeToMinutes(vehicle.timeWindowEnd);
    const availableTime = endMinutes - startMinutes;
    const utilizacao = ((workload / availableTime) * 100).toFixed(1);
    
    console.log(`  Veículo ${idx} (${vehicle.type}): ${deliveries} entregas, ${workload}/${availableTime} min (${utilizacao}% utilização)`);
  });

  return { assignments, unassigned };
}

/**
 * FASE 3: Otimização por Veículo
 * Aplica Nearest Neighbor + 2-opt para cada veículo
 * Calcula ETAs baseado em tempo de serviço e distância
 * PRIORIZA pedidos urgentes no início da rota
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
    
    // Separar pedidos urgentes de regulares
    const urgentOrders = orders.filter(o => o.isUrgent);
    const regularOrders = orders.filter(o => !o.isUrgent);
    
    console.log(`📋 [OPTIMIZATION] Veículo ${vehicleIdx}: ${urgentOrders.length} urgentes, ${regularOrders.length} regulares`);
    
    // Converter para pontos de rota
    const toRoutePoints = (orderList: DeliveryOrder[]) => orderList.map((order: DeliveryOrder) => ({
      id: order.id,
      latitude: order.customerLatitude,
      longitude: order.customerLongitude,
      customerName: order.customerName,
      customerAddress: order.customerAddress
    }));
    
    let allOptimizedPoints: any[] = [];
    
    // Se houver urgentes, otimizar eles primeiro
    if (urgentOrders.length > 0) {
      const urgentPoints = toRoutePoints(urgentOrders);
      const urgentOptimized = await optimizeRoute(
        vehicle.startLatitude,
        vehicle.startLongitude,
        urgentPoints
      );
      allOptimizedPoints = urgentOptimized.orderedPoints;
      console.log(`🔴 [URGENT] Otimizados ${urgentOrders.length} pedidos urgentes`);
    }
    
    // Se houver regulares, otimizar eles depois dos urgentes
    if (regularOrders.length > 0) {
      const regularPoints = toRoutePoints(regularOrders);
      
      // Ponto de partida: último urgente ou depósito
      const startLat = allOptimizedPoints.length > 0 
        ? allOptimizedPoints[allOptimizedPoints.length - 1].latitude 
        : vehicle.startLatitude;
      const startLon = allOptimizedPoints.length > 0 
        ? allOptimizedPoints[allOptimizedPoints.length - 1].longitude 
        : vehicle.startLongitude;
      
      const regularOptimized = await optimizeRoute(
        startLat,
        startLon,
        regularPoints
      );
      
      allOptimizedPoints = [...allOptimizedPoints, ...regularOptimized.orderedPoints];
      console.log(`⚪ [REGULAR] Otimizados ${regularOrders.length} pedidos regulares após urgentes`);
    }
    
    // Calcular ETAs
    const timeWindowStartMinutes = timeToMinutes(vehicle.timeWindowStart);
    const startTime = new Date(routeDate);
    startTime.setHours(0, 0, 0, 0);
    startTime.setMinutes(timeWindowStartMinutes);

    let currentTime = new Date(startTime);
    let totalDuration = 0;
    let totalDistance = 0;

    const stops: RouteStop[] = [];

    for (let i = 0; i < allOptimizedPoints.length; i++) {
      const point = allOptimizedPoints[i];
      const order = orders.find((o: DeliveryOrder) => o.id === point.id)!;

      console.log(`🔧 [OPTIMIZE] Processing stop for ${order.customerName}:`);
      console.log(`   - order.customerLatitude: ${order.customerLatitude} (type: ${typeof order.customerLatitude})`);
      console.log(`   - order.customerLongitude: ${order.customerLongitude} (type: ${typeof order.customerLongitude})`);
      console.log(`   - Number(lat): ${Number(order.customerLatitude)}`);
      console.log(`   - Number(lng): ${Number(order.customerLongitude)}`);

      // Calcular distância do ponto anterior (ou depósito se for o primeiro)
      let distanceFromPrevious: number;
      if (i === 0) {
        // Distância do depósito até primeira parada
        distanceFromPrevious = calculateDistance(
          vehicle.startLatitude,
          vehicle.startLongitude,
          point.latitude,
          point.longitude
        );
      } else {
        // Distância da parada anterior até esta
        const prevPoint = allOptimizedPoints[i - 1];
        distanceFromPrevious = calculateDistance(
          prevPoint.latitude,
          prevPoint.longitude,
          point.latitude,
          point.longitude
        );
      }

      // Tempo de viagem até esta parada (assumir 40 km/h médio)
      const travelTimeMinutes = (distanceFromPrevious / 40) * 60;
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
        distanceFromPrevious: distanceFromPrevious
      });

      currentTime = departureTime;
      totalDuration += travelTimeMinutes + serviceTime;
      totalDistance += distanceFromPrevious;
    }

    routes.push({
      vehicleType: vehicle.type,
      driverId: vehicle.driverId,
      driverName: vehicle.driverName,
      startLatitude: vehicle.startLatitude,
      startLongitude: vehicle.startLongitude,
      startAddress: vehicle.startAddress,
      stops,
      totalDistance,
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
      totalDuration: Math.round(route.totalDuration), // Arredondar para inteiro
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
        estimatedServiceTime: Math.round(stop.estimatedServiceTime), // Arredondar para inteiro
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
  // FASE 1: Pré-processamento com validações de dia da semana e horário
  const { eligibleByVehicle, urgentOrders, regularOrders, invalidOrders } = preprocessOrders(orders, vehicles, routeDate);

  // Log de pedidos inválidos
  if (invalidOrders.length > 0) {
    console.warn(`⚠️ ${invalidOrders.length} pedidos não puderam ser incluídos na rota:`);
    invalidOrders.forEach(({ order, reason }) => {
      console.warn(`  - ${order.customerName}: ${reason}`);
    });
  }

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

  // Calcular estatísticas (incluir invalid orders no total de unassigned)
  const totalDistance = routes.reduce((sum, r) => sum + r.totalDistance, 0);
  const assignedOrders = routes.reduce((sum, r) => sum + r.stops.length, 0);
  const allUnassigned = [...unassigned, ...invalidOrders.map(i => i.order)];

  return {
    routes,
    unassignedOrders: allUnassigned,
    stats: {
      totalOrders: orders.length,
      assignedOrders,
      unassignedOrders: allUnassigned.length,
      totalDistance,
      totalVehicles: routes.length
    }
  };
}
