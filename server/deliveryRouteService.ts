import { DatabaseStorage } from './storage';
import { optimizeRoute, calculateDistance } from './routeOptimizationService';
import { nanoid } from 'nanoid';
import { db } from './db';
import { deliveryHistory } from '../shared/schema';
import { eq, desc, and } from 'drizzle-orm';
import { parseJanelas, formatarJanelas, minParaHHMM, textoJanelaComPreferencia, type JanelaMin } from '../shared/janelas-entrega';
import { sequenciarComJanelas, TEMPO_ENTREGA_PADRAO_MIN, type ParadaSeq } from './sequenciamento-janelas';

// ==================== Data Structures ====================

export type VehicleType = 'caminhao' | 'carro' | 'moto' | 'baruc';

export interface DeliveryOrder {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: number;
  customerLongitude: number;
  averageDeliveryTime: number; // em minutos — MEDIDO no cronômetro do entregador, ou 5 min estimados
  tempoEntregaMedido?: boolean; // true = veio da média das entregas cronometradas do cliente
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
  deliveryTimeSlots?: string[]; // Horários de recebimento do DIA DA ROTA (checkboxes de hora cheia ou "08:00-12:00")
  janelas?: JanelaMin[]; // deliveryTimeSlots já convertidos em intervalos (minutos do dia)
  origemJanela?: 'preferencial' | 'recebimento' | 'livre'; // de onde vieram as janelas (18/out/2026)
  preferencial?: JanelaMin[]; // horário preferencial (suave) — 19/out/2026
  // ▼ Campos usados pela roteirização com IA (opcionais; ausentes no fluxo legado)
  receivingWeekdays?: string[] | string | null; // Dias em que o cliente aceita RECEBER
  customerCity?: string | null;
  customerState?: string | null;
  customerNeighborhood?: string | null;
  pipelineStage?: string | null; // stage do billing_pipeline (…_bsb ⇒ Brasília)
  orderNumber?: string | null;
  invoiceNumber?: string | null;
}

export interface VehicleConfig {
  id?: string;
  licensePlate?: string;
  type: VehicleType;
  driverId?: string;
  driverName?: string;
  startLatitude: number;
  startLongitude: number;
  startAddress: string;
  timeWindowStart: string; // HH:mm
  timeWindowEnd: string; // HH:mm
  capacity?: number; // número máximo de entregas
}

export interface RouteStop {
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  latitude: number;
  longitude: number;
  estimatedArrival: string; // HH:mm
  estimatedDeparture: string; // HH:mm
  estimatedServiceTime: number; // em minutos
  stopOrder: number;
  distanceFromPrevious: number;
  isUrgent?: boolean; // prioridade marcada no card do pipeline
  // ▼ Horário de recebimento do cliente e cumprimento dele
  janelaTexto?: string; // "8h às 12h + 14h às 16h" ('' = sem restrição cadastrada)
  chegadaFisica?: string; // HH:mm em que o veículo chega (antes de esperar a abertura)
  esperaMin?: number; // minutos aguardando o cliente abrir
  foraDaJanela?: boolean; // chega depois do horário de recebimento
  atrasoMin?: number;
  tempoEntregaMedido?: boolean;
}

export interface VehicleRoute {
  vehicleType: VehicleType;
  driverId?: string;
  driverName?: string;
  startLatitude: number;
  startLongitude: number;
  startAddress: string;
  stops: RouteStop[];
  totalDistance: number;
  totalDuration: number; // em minutos
  routeDate: Date;
  alertasJanela?: string[]; // paradas que não cabem no horário de recebimento
}

export interface RoutePlan {
  routes: VehicleRoute[];
  alertas?: string[];
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
export function isOrderCompatibleWithVehicle(
  order: DeliveryOrder,
  vehicleType: VehicleType
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
  return (order.vehicleTypes as string[]).includes(vehicleType);
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
export function timeToMinutes(timeStr: string): number {
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
    
    // Normalizar ambos os lados para comparação (remover acentos e converter para lowercase)
    const normalizedRouteDay = routeWeekday.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    
    return allowedDays.some(day => {
      const normalizedDay = day.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      // Comparar os 3 primeiros caracteres (seg, ter, qua, qui, sex, sab, dom)
      return normalizedDay.substring(0, 3) === normalizedRouteDay.substring(0, 3);
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
  timeWindowEnd: string,
  janelasProntas?: JanelaMin[]
): boolean {
  // Períodos de recebimento do cliente (já convertidos para o dia da rota quando
  // vierem prontos). Há compatibilidade se algum período se sobrepõe à jornada.
  const janelas = janelasProntas && janelasProntas.length ? janelasProntas : parseJanelas(deliveryTimeSlots);
  if (janelas.length === 0) return true;
  try {
    const routeStart = timeToMinutes(timeWindowStart);
    const routeEnd = timeToMinutes(timeWindowEnd);
    return janelas.some((j) => routeStart < j.fim && routeEnd > j.ini);
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
export function preprocessOrders(
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  routeDate: Date,
  opts?: { respectReceivingWeekdays?: boolean }
): {
  eligibleByVehicle: Map<number, DeliveryOrder[]>;
  urgentOrders: DeliveryOrder[];
  regularOrders: DeliveryOrder[];
  invalidOrders: Array<{ order: DeliveryOrder; reason: string }>;
  weekdayWarnings: Array<{ order: DeliveryOrder; reason: string }>;
} {
  // ⚠️ COMPATIBILIDADE: por padrão o filtro de dia de recebimento é apenas AVISO
  // (o fluxo legado da tela Gestão de Entregas nunca populava receivingWeekdays).
  // A roteirização com IA pode ligar a exclusão dura via opts.respectReceivingWeekdays.
  const respectWeekdays = opts?.respectReceivingWeekdays === true;
  const weekdayWarnings: Array<{ order: DeliveryOrder; reason: string }> = [];
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
    
    // Validar dia da semana permitido para recebimento (receivingWeekdays)
    if (order.receivingWeekdays && (order.receivingWeekdays as any).length > 0) {
      if (!isValidDeliveryWeekday(order.receivingWeekdays as any, routeDate)) {
        const routeWeekday = getWeekdayName(routeDate);
        const reason = `Dia de recebimento não permitido (rota: ${routeWeekday}, dias permitidos: ${Array.isArray(order.receivingWeekdays) ? order.receivingWeekdays.join(', ') : order.receivingWeekdays})`;
        if (respectWeekdays) {
          console.warn(`Pedido ${order.id} ignorado: ${reason}`);
          invalidOrders.push({ order, reason });
          return false;
        }
        weekdayWarnings.push({ order, reason });
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
        if (!isValidDeliveryTimeSlot(order.deliveryTimeSlots, vehicle.timeWindowStart, vehicle.timeWindowEnd, order.janelas)) {
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

  return { eligibleByVehicle, urgentOrders, regularOrders, invalidOrders, weekdayWarnings };
}

/**
 * FASE 2: Atribuição de Veículos
 * Usa distribuição proporcional com prioridade para urgentes
 * Balanceia carga considerando tempo de trabalho estimado
 */
export function assignOrdersToVehicles(
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
export async function optimizeVehicleRoutes(
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
    
    // ── Horários: deslocamento + espera pela abertura do cliente + tempo de
    // entrega MEDIDO (ou 5 min estimados). A ordem geográfica acima é só o ponto
    // de partida: o sequenciador reordena para cumprir os horários de recebimento.
    const inicioJornada = timeToMinutes(vehicle.timeWindowStart);
    const fimJornada = timeToMinutes(vehicle.timeWindowEnd);
    const orderById = new Map<string, DeliveryOrder>(orders.map((o: DeliveryOrder) => [o.id, o]));
    const paradasSeq: ParadaSeq[] = allOptimizedPoints
      .map((point: any) => orderById.get(point.id))
      .filter(Boolean)
      .map((order: any) => ({
        id: order.id,
        customerId: order.customerId,
        lat: Number(order.customerLatitude),
        lng: Number(order.customerLongitude),
        servico: Number(order.averageDeliveryTime) > 0 ? Number(order.averageDeliveryTime) : TEMPO_ENTREGA_PADRAO_MIN,
        janelas: order.janelas || parseJanelas(order.deliveryTimeSlots),
        preferencial: order.preferencial || [],
        urgente: order.isUrgent === true,
      }));

    const seq = sequenciarComJanelas(
      paradasSeq,
      { lat: vehicle.startLatitude, lng: vehicle.startLongitude },
      inicioJornada,
      fimJornada,
      calculateDistance,
    );

    const stops: RouteStop[] = [];
    const alertasJanela: string[] = [];
    seq.horarios.forEach((h, i) => {
      const order = orderById.get(h.id)!;
      const janelas = order.janelas || parseJanelas(order.deliveryTimeSlots);
      const janelaTexto = textoJanelaComPreferencia(janelas, order.preferencial);
      stops.push({
        salesCardId: order.id,
        customerId: order.customerId,
        customerName: order.customerName,
        customerAddress: order.customerAddress,
        latitude: Number(order.customerLatitude),
        longitude: Number(order.customerLongitude),
        estimatedArrival: minParaHHMM(h.inicio),
        estimatedDeparture: minParaHHMM(h.saida),
        estimatedServiceTime: h.servico,
        stopOrder: i + 1,
        distanceFromPrevious: h.distanciaAnterior,
        isUrgent: order.isUrgent === true,
        janelaTexto,
        chegadaFisica: minParaHHMM(h.chegada),
        esperaMin: Math.round(h.espera),
        foraDaJanela: h.foraDaJanela,
        atrasoMin: Math.round(h.atraso),
        tempoEntregaMedido: order.tempoEntregaMedido === true,
      });
      if (h.foraDaJanela) {
        alertasJanela.push(
          `${order.customerName}: chega às ${minParaHHMM(h.chegada)} (${vehicle.driverName || vehicle.type}), fora do horário de recebimento (${formatarJanelas(janelas)}). Mude de entregador ou reveja a jornada.`,
        );
      }
    });
    if (seq.horaExtra > 0) {
      alertasJanela.push(
        `${vehicle.driverName || vehicle.type}: a rota termina às ${minParaHHMM(seq.fim)}, ${Math.round(seq.horaExtra)} min depois do fim da jornada (${vehicle.timeWindowEnd}).`,
      );
    }

    const totalDistance = seq.distanciaTotal;
    const totalDuration = Math.max(0, seq.fim - seq.partida);
    console.log(`⏰ [ETA-CALC] ${vehicle.driverName || vehicle.type}: sai ${minParaHHMM(seq.partida)}, termina ${minParaHHMM(seq.fim)}, ${seq.foraDaJanela} fora do horário`);

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
      routeDate,
      alertasJanela,
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

    // Resolver dados do motorista (route_name / driver_name / driver_email sao NOT NULL no schema)
    let driverName = route.driverName || '';
    let driverEmail = '';
    if (route.driverId) {
      try {
        const drv = await (storage as any).getDeliveryDriverById(route.driverId);
        if (drv) { driverName = driverName || drv.name || ''; driverEmail = drv.email || ''; }
      } catch (e) { /* segue com fallback */ }
    }
    if (!driverName) driverName = 'Motorista';
    const __dateStr = (routeDate instanceof Date ? routeDate : new Date(routeDate)).toISOString().slice(0, 10);
    const routeName = `ROTA-${__dateStr}-${driverName.toUpperCase().replace(/\s+/g, '-')}-${savedRoutes.length + 1}`;

    // Criar rota de entrega
    const deliveryRoute = await storage.createDeliveryRoute({
      id: nanoid(),
      routeName,
      vehicleType: route.vehicleType,
      driverId: route.driverId,
      driverName,
      driverEmail,
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
        estimatedArrival: stop.estimatedArrival, // Já é string HH:mm
        estimatedDeparture: stop.estimatedDeparture, // Já é string HH:mm
        estimatedServiceTime: Math.round(stop.estimatedServiceTime),
        stopOrder: stop.stopOrder,
        distanceFromPrevious: stop.distanceFromPrevious.toString(),
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      console.log(`💾 [PERSIST] Creating stop for ${stop.customerName}:`);
      console.log(`   - Chegada: ${stop.estimatedArrival}`);
      console.log(`   - Saída: ${stop.estimatedDeparture}`);

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
  routeDate: Date,
  opts?: { persist?: boolean; respectReceivingWeekdays?: boolean }
): Promise<RoutePlan> {
  // FASE 1: Pré-processamento com validações de dia da semana e horário
  const { eligibleByVehicle, urgentOrders, regularOrders, invalidOrders } = preprocessOrders(orders, vehicles, routeDate, opts);

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

  // FASE 4: Persistir rotas (dryRun ⇒ não grava; quem grava é POST /api/delivery-routes/save)
  if (opts?.persist !== false) {
    await persistRoutePlan(storage, routes, routeDate);
  } else {
    console.log('🧪 [ROUTE-PLAN] dryRun: rotas NÃO persistidas nesta etapa (persistência ocorre no /save)');
  }

  // Calcular estatísticas (incluir invalid orders no total de unassigned)
  const totalDistance = routes.reduce((sum, r) => sum + r.totalDistance, 0);
  const assignedOrders = routes.reduce((sum, r) => sum + r.stops.length, 0);
  const allUnassigned = [...unassigned, ...invalidOrders.map(i => i.order)];

  return {
    routes,
    alertas: routes.flatMap((r) => r.alertasJanela || []),
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
