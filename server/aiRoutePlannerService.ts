// ============================================================================
// AGENTE DE IA — ROTEIRIZAÇÃO DE ENTREGAS (INTEGRA 2.0 / Honest Sucos)
// ----------------------------------------------------------------------------
// Modelo HÍBRIDO (decisão do Flavio, 26/jul/2026):
//   • A IA decide a DISTRIBUIÇÃO: qual pedido vai em qual veículo/motorista,
//     equilíbrio de carga, prioridades, Brasília × Goiânia, janelas do cliente.
//   • O ALGORITMO decide a SEQUÊNCIA: Nearest-Neighbor + 2-opt + distâncias
//     reais de rua (OSRM), reaproveitando `optimizeVehicleRoutes`.
//   • Uma camada de REPARO determinística valida a proposta da IA contra as
//     restrições duras (capacidade, janela de trabalho, tipo de veículo,
//     veículo exclusivo, BSB) e corrige o que estiver fora, registrando cada
//     ajuste. A IA nunca consegue produzir uma rota inválida.
//   • Sem ANTHROPIC_API_KEY, com erro na API ou com volume acima do teto, cai
//     automaticamente no distribuidor guloso atual (modo 'deterministico').
//
// Chamada Anthropic por fetch puro (mesmo padrão de server/agent-runtime.ts,
// sem dependência nova), com tool-use FORÇADO para garantir saída estruturada.
// ============================================================================

import type { DatabaseStorage } from './storage';
import { calculateDistance } from './routeOptimizationService';
import {
  preprocessOrders,
  assignOrdersToVehicles,
  optimizeVehicleRoutes,
  isOrderCompatibleWithVehicle,
  timeToMinutes,
  type DeliveryOrder,
  type VehicleConfig,
  type VehicleRoute,
  type RoutePlan,
} from './deliveryRouteService';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Teto de pedidos por chamada. Acima disso o briefing fica caro/impreciso → guloso. */
const AI_MAX_ORDERS = Number(process.env.ROUTE_AI_MAX_ORDERS || 250);
const AI_MAX_TOKENS = Number(process.env.ROUTE_AI_MAX_TOKENS || 8000);
const AI_TIMEOUT_MS = Number(process.env.ROUTE_AI_TIMEOUT_MS || 90000);

function resolveModel(m?: string): string {
  const x = (m || process.env.ROUTE_AI_MODEL || '').trim();
  if (x.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5-20251001';
  if (x.startsWith('claude-opus-4-8')) return 'claude-opus-4-8';
  if (x.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
  return 'claude-sonnet-4-6';
}

// ==================== Tipos públicos ====================

export interface AIRouteMeta {
  modo: 'ia' | 'deterministico';
  modelo?: string;
  resumo: string;
  /** Justificativa da IA por veículo (o "porquê" da distribuição). */
  justificativas: Array<{ veiculo: string; texto: string }>;
  /** Observações operacionais (cliente que só recebe em outro dia, etc). */
  alertas: string[];
  /** Correções determinísticas aplicadas por cima da proposta da IA. */
  ajustes: string[];
  /** Utilização por veículo, para a tela mostrar equilíbrio de carga. */
  cargaPorVeiculo: Array<{
    veiculo: string;
    motorista?: string;
    entregas: number;
    minutosEstimados: number;
    minutosDisponiveis: number;
    utilizacaoPct: number;
  }>;
  /**
   * Pedidos vizinhos que acabaram em rotas diferentes, com o MOTIVO.
   * Responde direto a "por que esses dois clientes lado a lado foram para
   * entregadores distintos?" sem ninguém precisar abrir o código.
   */
  vizinhosSeparados: Array<{
    a: string; b: string;
    veiculoA: string; veiculoB: string;
    distanciaKm: number;
    motivo: string;
  }>;
  motivoFallback?: string;
  tokens?: { input: number; output: number };
  duracaoMs?: number;
}

export type AIRoutePlan = RoutePlan & { ai: AIRouteMeta };

interface AIProposal {
  resumo?: string;
  atribuicoes?: Array<{ pedido: string; veiculo: number; urgente?: boolean; motivo?: string }>;
  nao_atribuidos?: Array<{ pedido: string; motivo?: string }>;
  alertas?: string[];
  justificativa_por_veiculo?: Array<{ veiculo: number; texto: string }>;
}

// ==================== Helpers ====================

function norm(s: any): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Pedido é de Brasília/DF? Sinal primário = stage do pipeline (…_bsb); secundário = UF/cidade. */
export function isBsbOrder(o: DeliveryOrder): boolean {
  const stage = norm(o.pipelineStage);
  if (stage.endsWith('_bsb') || stage === 'bsb') return true;
  if (norm(o.customerState) === 'df') return true;
  const city = norm(o.customerCity);
  if (!city) return false;
  return /(brasilia|taguatinga|ceilandia|samambaia|aguas claras|guara|sobradinho|planaltina|gama|nucleo bandeirante|recanto das emas|santa maria|sao sebastiao|valparaiso|luziania|aguas lindas|formosa)/.test(city);
}

function isBaruc(v: VehicleConfig): boolean {
  return norm(v.type) === 'baruc';
}

/** Setor geográfico (N/NE/L/SE/S/SO/O/NO) do pedido em relação à base. */
function sectorFromDepot(depotLat: number, depotLon: number, lat: number, lon: number): string {
  const dy = lat - depotLat;
  const dx = lon - depotLon;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = leste, cresce anti-horário
  const names = ['L', 'NE', 'N', 'NO', 'O', 'SO', 'S', 'SE'];
  const idx = Math.round(((ang + 360) % 360) / 45) % 8;
  return names[idx];
}

function fmtMoney(v: any): string {
  const n = Number(v || 0);
  return n >= 1000 ? `R$${(n / 1000).toFixed(1)}k` : `R$${n.toFixed(0)}`;
}

function weekdaysToText(w: any): string {
  if (!w) return '';
  const arr = Array.isArray(w) ? w : (() => { try { return JSON.parse(String(w)); } catch { return []; } })();
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map((d: any) => String(d).slice(0, 3)).join('/');
}

async function callAnthropic(
  model: string,
  system: string,
  userText: string,
  tool: any,
): Promise<{ ok: boolean; status: number; j: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: AI_MAX_TOKENS,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }, // saída estruturada garantida
        messages: [{ role: 'user', content: userText }],
      }),
      signal: controller.signal,
    });
    const j: any = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, j };
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Briefing enviado ao agente ====================

const SYSTEM_PROMPT = `Você é o roteirizador da Honest Sucos (distribuidora de sucos e polpas em Goiânia-GO e Brasília-DF).
Sua tarefa é DISTRIBUIR os pedidos do dia entre os veículos/motoristas disponíveis. Você NÃO define a ordem das paradas — um algoritmo de otimização (Nearest-Neighbor + 2-opt com distâncias reais de rua) cuida disso depois.

OBJETIVO, nesta ordem de importância:
1. Nenhuma restrição dura violada.
2. Cada veículo atende uma REGIÃO COESA (pedidos vizinhos entre si, mesmo setor), para minimizar quilometragem. Evite rotas que se cruzam.
3. Carga equilibrada entre os motoristas — mas SEM quebrar a coesão do item 2. Uma diferença de até ~30% no nº de entregas é aceitável se isso mantém cada motorista na sua região. NÃO divida uma região só para deixar a contagem igual.
4. Pedidos marcados PRIORIDADE e clientes com janela de horário apertada em veículos com folga — a prioridade foi marcada à mão pela operação e o algoritmo já os coloca no início da rota do motorista.

REGRA DE VIZINHANÇA (importante):
- Dois pedidos a menos de 2 km um do outro devem ficar no MESMO veículo, salvo restrição dura que impeça.
- Pedidos no mesmo endereço (vizinhos 0.0km) SEMPRE no mesmo veículo — são uma parada só.
- Use a lista "vizinhos" de cada pedido: se os vizinhos de um pedido foram para outro veículo, revise.

RESTRIÇÕES DURAS (nunca viole):
- Capacidade máxima de entregas de cada veículo.
- Minutos disponíveis do veículo (janela de trabalho menos 30 min de almoço). Use ~15 min de deslocamento entre paradas + o tempo de atendimento do pedido.
- "veíc:" no pedido indica exigência de tipo de veículo — só pode ir em veículo de tipo compatível.
- Pedidos marcados [BSB] são de Brasília/DF: SÓ podem ir em veículo do tipo "baruc". E veículos "baruc" SÓ levam pedidos [BSB].
- Só use veículos da lista. Só use pedidos da lista.

REGRAS DE SAÍDA:
- Todo pedido deve aparecer EXATAMENTE UMA VEZ: em "atribuicoes" ou em "nao_atribuidos".
- Use os códigos curtos (P1, P2… / V0, V1…), nunca nomes ou ids longos.
- Se um pedido não couber em lugar nenhum, coloque em "nao_atribuidos" com o motivo real.
- Em "alertas", liste observações operacionais que o humano precisa ver (ex.: cliente que hoje não recebe, janela incompatível, pedido muito distante do restante).
- Escreva resumo e justificativas em português do Brasil, curtos e objetivos.

Responda SEMPRE chamando a ferramenta distribuir_entregas.`;

const TOOL_DEF = {
  name: 'distribuir_entregas',
  description: 'Devolve a distribuição dos pedidos entre os veículos disponíveis, com justificativa e alertas.',
  input_schema: {
    type: 'object',
    properties: {
      resumo: {
        type: 'string',
        description: 'Resumo em 1–3 frases da estratégia adotada (regiões, equilíbrio, exceções).',
      },
      atribuicoes: {
        type: 'array',
        description: 'Um item por pedido atribuído.',
        items: {
          type: 'object',
          properties: {
            pedido: { type: 'string', description: 'Código curto do pedido, ex.: P12' },
            veiculo: { type: 'integer', description: 'Índice do veículo, ex.: 0 para V0' },
            urgente: { type: 'boolean', description: 'Marque true para atender no início da rota.' },
            motivo: { type: 'string', description: 'Motivo curto (opcional).' },
          },
          required: ['pedido', 'veiculo'],
        },
      },
      nao_atribuidos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pedido: { type: 'string' },
            motivo: { type: 'string' },
          },
          required: ['pedido', 'motivo'],
        },
      },
      justificativa_por_veiculo: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            veiculo: { type: 'integer' },
            texto: { type: 'string', description: 'Ex.: "Setor Sul e Sudoeste, 12 paradas, ~48 km."' },
          },
          required: ['veiculo', 'texto'],
        },
      },
      alertas: { type: 'array', items: { type: 'string' } },
    },
    required: ['resumo', 'atribuicoes'],
  },
};

function buildBriefing(
  orders: DeliveryOrder[],
  codeByOrderId: Map<string, string>,
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  routeDate: Date,
  weekdayWarnings: Array<{ order: DeliveryOrder; reason: string }>,
): string {
  const depotLat = vehicles[0]?.startLatitude ?? 0;
  const depotLon = vehicles[0]?.startLongitude ?? 0;
  const warnIds = new Set(weekdayWarnings.map((w) => w.order.id));

  // Vizinhos mais próximos (dá estrutura geográfica ao modelo sem mandar matriz completa)
  const neighborsOf = new Map<string, string>();
  for (const a of orders) {
    const ds = orders
      .filter((b) => b.id !== a.id)
      .map((b) => ({
        code: codeByOrderId.get(b.id)!,
        d: calculateDistance(a.customerLatitude, a.customerLongitude, b.customerLatitude, b.customerLongitude),
      }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    neighborsOf.set(a.id, ds.map((n) => `${n.code}(${n.d.toFixed(1)}km)`).join(' '));
  }

  const linhasPedidos = orders.map((o) => {
    const code = codeByOrderId.get(o.id)!;
    const dist = calculateDistance(depotLat, depotLon, o.customerLatitude, o.customerLongitude);
    const setor = sectorFromDepot(depotLat, depotLon, o.customerLatitude, o.customerLongitude);
    const local = [o.customerNeighborhood, o.customerCity].filter(Boolean).join(', ') || (o.customerAddress || '').slice(0, 48);
    const partes: string[] = [
      code,
      `${(o.customerName || '').slice(0, 34)}${isBsbOrder(o) ? ' [BSB]' : ''}`,
      local,
      `${dist.toFixed(1)}km base, setor ${setor}`,
      fmtMoney(o.saleValue),
      `${o.averageDeliveryTime || 30}min`,
    ];
    if (o.exclusiveVehicle && Array.isArray(o.vehicleTypes) && o.vehicleTypes.length > 0) {
      partes.push(`veíc: ${o.vehicleTypes.join('/')}`);
    }
    if (o.isUrgent) partes.push('PRIORIDADE');
    const slots = Array.isArray(o.deliveryTimeSlots) ? o.deliveryTimeSlots.filter(Boolean) : [];
    if (slots.length) partes.push(`janela ${slots.join(',')}`);
    const rw = weekdaysToText(o.receivingWeekdays);
    if (rw) partes.push(`recebe ${rw}${warnIds.has(o.id) ? ' ⚠NÃO-HOJE' : ''}`);
    partes.push(`vizinhos ${neighborsOf.get(o.id) || '-'}`);
    return partes.join(' | ');
  });

  const linhasVeiculos = vehicles.map((v, idx) => {
    const disp = timeToMinutes(v.timeWindowEnd) - timeToMinutes(v.timeWindowStart) - 30;
    const elegiveis = (eligibleByVehicle.get(idx) || []).map((o) => codeByOrderId.get(o.id)).filter(Boolean);
    const partes = [
      `V${idx}`,
      v.type + (isBaruc(v) ? ' (Brasília)' : ''),
      `motorista ${v.driverName || 's/ nome'}${v.licensePlate ? ` placa ${v.licensePlate}` : ''}`,
      `base ${v.startAddress || `${v.startLatitude},${v.startLongitude}`}`,
      `${v.timeWindowStart}-${v.timeWindowEnd} (~${disp}min úteis)`,
      `capacidade ${v.capacity ? `${v.capacity} entregas` : 'sem limite declarado'}`,
      `elegíveis: ${elegiveis.length === orders.length ? 'todos' : (elegiveis.join(',') || 'nenhum')}`,
    ];
    return partes.join(' | ');
  });

  const dataStr = routeDate.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  return [
    `DATA DA ROTA: ${dataStr}`,
    `BASE PRINCIPAL: ${vehicles[0]?.startAddress || '-'} (${depotLat}, ${depotLon})`,
    '',
    `VEÍCULOS DISPONÍVEIS (${vehicles.length}):`,
    ...linhasVeiculos,
    '',
    `PEDIDOS A DISTRIBUIR (${orders.length}):`,
    ...linhasPedidos,
    '',
    'Distribua todos os pedidos chamando distribuir_entregas.',
  ].join('\n');
}

/**
 * Segrega Brasília × Goiânia na ELEGIBILIDADE, valendo tanto para o caminho da IA
 * quanto para o guloso de fallback (que sozinho é cego para BSB e chegava a mandar
 * pedido do DF na moto de Goiânia).
 * Só é aplicado quando existe o veículo da contraparte — se o operador não escalou
 * nenhum BARUC, os pedidos do DF continuam elegíveis para qualquer veículo.
 */
function applyBsbEligibility(
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  vehicles: VehicleConfig[],
): { removidos: number } {
  const anyBaruc = vehicles.some(isBaruc);
  const anyNonBaruc = vehicles.some((v) => !isBaruc(v));
  let removidos = 0;
  vehicles.forEach((v, idx) => {
    const list = eligibleByVehicle.get(idx) || [];
    const filtered = list.filter((o) => {
      const bsb = isBsbOrder(o);
      if (anyBaruc && bsb && !isBaruc(v)) return false;
      if (anyNonBaruc && !bsb && isBaruc(v)) return false;
      return true;
    });
    removidos += list.length - filtered.length;
    eligibleByVehicle.set(idx, filtered);
  });
  return { removidos };
}

// ==================== Camada de reparo determinística ====================

interface RepairContext {
  orders: DeliveryOrder[];
  vehicles: VehicleConfig[];
  eligibleByVehicle: Map<number, DeliveryOrder[]>;
}

function buildEligibilitySet(eligibleByVehicle: Map<number, DeliveryOrder[]>): Map<number, Set<string>> {
  const m = new Map<number, Set<string>>();
  for (const [idx, list] of Array.from(eligibleByVehicle.entries())) {
    m.set(idx, new Set(list.map((o) => o.id)));
  }
  return m;
}

/**
 * Aplica a proposta da IA respeitando as restrições duras.
 * Devolve as atribuições finais, os não atribuídos e a lista de ajustes feitos.
 */
function applyAndRepair(
  proposal: AIProposal,
  ctx: RepairContext,
  codeToOrderId: Map<string, string>,
): { assignments: Map<number, DeliveryOrder[]>; workload: Map<number, number>; unassigned: DeliveryOrder[]; ajustes: string[] } {
  const { orders, vehicles } = ctx;
  const eligible = buildEligibilitySet(ctx.eligibleByVehicle);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const ajustes: string[] = [];

  const assignments = new Map<number, DeliveryOrder[]>();
  const workload = new Map<number, number>();
  vehicles.forEach((v, idx) => {
    assignments.set(idx, []);
    workload.set(idx, 30); // almoço
  });

  const anyBaruc = vehicles.some(isBaruc);
  const anyNonBaruc = vehicles.some((v) => !isBaruc(v));

  const availableMinutes = (idx: number) =>
    timeToMinutes(vehicles[idx].timeWindowEnd) - timeToMinutes(vehicles[idx].timeWindowStart);

  const fits = (idx: number, o: DeliveryOrder): boolean => {
    const v = vehicles[idx];
    if (!eligible.get(idx)?.has(o.id)) return false;
    if (!isOrderCompatibleWithVehicle(o, v.type)) return false;
    if (anyBaruc && isBsbOrder(o) && !isBaruc(v)) return false;
    if (anyNonBaruc && !isBsbOrder(o) && isBaruc(v)) return false;
    if (v.capacity && assignments.get(idx)!.length >= v.capacity) return false;
    if (workload.get(idx)! + (o.averageDeliveryTime || 30) > availableMinutes(idx)) return false;
    return true;
  };

  const place = (idx: number, o: DeliveryOrder) => {
    assignments.get(idx)!.push(o);
    workload.set(idx, workload.get(idx)! + (o.averageDeliveryTime || 30) + 15);
  };

  /**
   * Melhor veículo alternativo.
   * ⚠️ Antes escolhia só pela MENOR CARGA, o que espalhava pedidos vizinhos entre
   * motoristas diferentes (era a causa de dois clientes lado a lado caírem em rotas
   * distintas). Agora pesa PROXIMIDADE primeiro: distância do pedido até a parada
   * mais próxima já atribuída àquele veículo (ou até a base, se ainda estiver vazio),
   * com um empurrãozinho pela carga só para desempatar veículos igualmente perto.
   */
  const bestAlternative = (o: DeliveryOrder): number => {
    let best = -1;
    let melhorCusto = Infinity;
    vehicles.forEach((_, idx) => {
      if (!fits(idx, o)) return;
      const v = vehicles[idx];
      const jaAtribuidos = assignments.get(idx)!;
      let distancia = Infinity;
      for (const outro of jaAtribuidos) {
        const d = calculateDistance(o.customerLatitude, o.customerLongitude, outro.customerLatitude, outro.customerLongitude);
        if (d < distancia) distancia = d;
      }
      if (!Number.isFinite(distancia)) {
        distancia = calculateDistance(o.customerLatitude, o.customerLongitude, v.startLatitude, v.startLongitude);
      }
      // Carga entra como penalidade suave: 1 km equivale a ~4 min de fila.
      const penalidadeCarga = (workload.get(idx)! - 30) / 4;
      const custo = distancia + penalidadeCarga * 0.25;
      if (custo < melhorCusto) {
        melhorCusto = custo;
        best = idx;
      }
    });
    return best;
  };

  const decided = new Set<string>();
  const overflow: DeliveryOrder[] = [];

  for (const a of proposal.atribuicoes || []) {
    const orderId = codeToOrderId.get(String(a.pedido || '').trim().toUpperCase());
    if (!orderId) {
      ajustes.push(`IA citou um pedido inexistente ("${a.pedido}") — ignorado.`);
      continue;
    }
    const o = orderById.get(orderId);
    if (!o) continue;
    if (decided.has(o.id)) {
      ajustes.push(`${o.customerName}: a IA repetiu o pedido em mais de um veículo — mantida a primeira atribuição.`);
      continue;
    }
    decided.add(o.id);
    if (a.urgente) (o as any).isUrgent = true;

    const idx = Number(a.veiculo);
    if (!Number.isInteger(idx) || idx < 0 || idx >= vehicles.length) {
      overflow.push(o);
      ajustes.push(`${o.customerName}: veículo "V${a.veiculo}" não existe — redistribuído.`);
      continue;
    }
    if (fits(idx, o)) {
      place(idx, o);
      continue;
    }
    // Não coube: tenta alternativa antes de desistir
    const alt = bestAlternative(o);
    if (alt >= 0) {
      place(alt, o);
      const motivo = isBsbOrder(o) && !isBaruc(vehicles[idx])
        ? 'pedido de Brasília exige veículo BSB'
        : (vehicles[idx].capacity && assignments.get(idx)!.length >= (vehicles[idx].capacity as number))
          ? 'veículo cheio'
          : 'janela/compatibilidade do veículo';
      ajustes.push(`${o.customerName}: movido de V${idx} para V${alt} (${motivo}).`);
    } else {
      overflow.push(o);
    }
  }

  // Pedidos que a IA declarou não atribuídos — só aceitamos se realmente não couberem
  for (const na of proposal.nao_atribuidos || []) {
    const orderId = codeToOrderId.get(String(na.pedido || '').trim().toUpperCase());
    if (!orderId || decided.has(orderId)) continue;
    const o = orderById.get(orderId);
    if (!o) continue;
    decided.add(o.id);
    overflow.push(o);
  }

  // Pedidos que a IA simplesmente esqueceu
  for (const o of orders) {
    if (decided.has(o.id)) continue;
    decided.add(o.id);
    overflow.push(o);
    ajustes.push(`${o.customerName}: não foi citado pela IA — alocado pelo algoritmo.`);
  }

  // Guloso (menor carga) para tudo que sobrou
  const unassigned: DeliveryOrder[] = [];
  overflow.sort((a, b) => Number(!!b.isUrgent) - Number(!!a.isUrgent));
  for (const o of overflow) {
    const idx = bestAlternative(o);
    if (idx >= 0) place(idx, o);
    else unassigned.push(o);
  }

  return { assignments, workload, unassigned, ajustes };
}

/**
 * Depois da distribuição fechada, procura pares de pedidos PRÓXIMOS que ficaram
 * em veículos diferentes e explica o porquê de cada caso. É o diagnóstico que
 * responde "por que o cliente X e o cliente Y, vizinhos, foram para entregadores
 * diferentes?" — separando restrição dura de decisão de distribuição.
 */
function diagnosticarVizinhosSeparados(
  assignments: Map<number, DeliveryOrder[]>,
  vehicles: VehicleConfig[],
  eligibleByVehicle: Map<number, DeliveryOrder[]>,
  raioKm = 2,
): AIRouteMeta['vizinhosSeparados'] {
  const porPedido = new Map<string, number>();
  const todos: DeliveryOrder[] = [];
  for (const [idx, lista] of Array.from(assignments.entries())) {
    for (const o of lista) { porPedido.set(o.id, idx); todos.push(o); }
  }
  const elegivel = new Map<number, Set<string>>();
  for (const [idx, lista] of Array.from(eligibleByVehicle.entries())) {
    elegivel.set(idx, new Set(lista.map((o) => o.id)));
  }

  const nomeVeic = (idx: number) => {
    const v = vehicles[idx];
    return v?.driverName || `V${idx} (${v?.type || '?'})`;
  };

  const out: AIRouteMeta['vizinhosSeparados'] = [];
  const vistos = new Set<string>();

  for (let i = 0; i < todos.length; i++) {
    for (let j = i + 1; j < todos.length; j++) {
      const a = todos[i], b = todos[j];
      const va = porPedido.get(a.id)!, vb = porPedido.get(b.id)!;
      if (va === vb) continue;
      const d = calculateDistance(a.customerLatitude, a.customerLongitude, b.customerLatitude, b.customerLongitude);
      if (d > raioKm) continue;
      const chave = [a.id, b.id].sort().join('|');
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      // Por que 'a' não poderia estar no veículo de 'b' (e vice-versa)?
      const motivos: string[] = [];
      const checar = (o: DeliveryOrder, destino: number) => {
        const v = vehicles[destino];
        if (!elegivel.get(destino)?.has(o.id) || !isOrderCompatibleWithVehicle(o, v.type)) {
          if (o.exclusiveVehicle && Array.isArray(o.vehicleTypes) && o.vehicleTypes.length) {
            motivos.push(`${o.customerName} exige veículo ${o.vehicleTypes.join('/')} e ${nomeVeic(destino)} é ${v.type}`);
          } else if (isBaruc(v) !== isBsbOrder(o)) {
            motivos.push(`${o.customerName} é de ${isBsbOrder(o) ? 'Brasília' : 'Goiânia'} e ${nomeVeic(destino)} atende o outro polo`);
          } else {
            motivos.push(`${o.customerName} não é elegível para ${nomeVeic(destino)} (janela de horário ou tipo de veículo)`);
          }
          return;
        }
        const v2 = vehicles[destino];
        const carga = assignments.get(destino)!.length;
        if (v2.capacity && carga >= v2.capacity) {
          motivos.push(`${nomeVeic(destino)} já está na capacidade máxima (${v2.capacity} entregas)`);
          return;
        }
        const disp = timeToMinutes(v2.timeWindowEnd) - timeToMinutes(v2.timeWindowStart);
        const usados = 30 + assignments.get(destino)!.reduce((s, x) => s + (x.averageDeliveryTime || 30) + 15, 0);
        if (usados + (o.averageDeliveryTime || 30) > disp) {
          motivos.push(`${nomeVeic(destino)} não tem janela livre para mais uma parada`);
        }
      };
      checar(a, vb);
      checar(b, va);

      out.push({
        a: a.customerName,
        b: b.customerName,
        veiculoA: nomeVeic(va),
        veiculoB: nomeVeic(vb),
        distanciaKm: Math.round(d * 100) / 100,
        motivo: motivos.length
          ? Array.from(new Set(motivos)).join('; ')
          : 'nenhuma restrição impedia juntá-los — foi decisão de distribuição (equilíbrio de carga entre os motoristas). Dá para arrastar um dos dois manualmente se preferir.',
      });
    }
  }
  // Os mais próximos primeiro: são os que mais incomodam quem olha o mapa.
  return out.sort((x, y) => x.distanciaKm - y.distanciaKm).slice(0, 12);
}

// ==================== Entry point ====================

export async function planDeliveryRoutesWithAI(
  storage: DatabaseStorage,
  orders: DeliveryOrder[],
  vehicles: VehicleConfig[],
  routeDate: Date,
  opts?: { persist?: boolean; respectReceivingWeekdays?: boolean; model?: string },
): Promise<AIRoutePlan> {
  const t0 = Date.now();

  // FASE 1 — pré-processamento (coordenadas, elegibilidade por veículo, urgentes)
  const { eligibleByVehicle, urgentOrders, regularOrders, invalidOrders, weekdayWarnings } = preprocessOrders(
    orders,
    vehicles,
    routeDate,
    { respectReceivingWeekdays: opts?.respectReceivingWeekdays === true },
  );

  applyBsbEligibility(eligibleByVehicle, vehicles);

  const validOrders = [...urgentOrders, ...regularOrders];
  const alertas: string[] = weekdayWarnings.map((w) => `${w.order.customerName}: ${w.reason}`);

  // Pedido do DF sem veículo BSB escalado (ou o contrário) fica sem rota — avisa em vez de sumir.
  const semVeiculo = validOrders.filter((o) => !vehicles.some((_, idx) => (eligibleByVehicle.get(idx) || []).some((x) => x.id === o.id)));
  for (const o of semVeiculo) {
    alertas.push(
      `${o.customerName}: ${isBsbOrder(o) ? 'pedido de Brasília/DF' : 'pedido de Goiânia'} sem veículo compatível entre os selecionados.`,
    );
  }

  let assignments: Map<number, DeliveryOrder[]>;
  let workload: Map<number, number>;
  let unassigned: DeliveryOrder[];
  let ajustes: string[] = [];
  const meta: AIRouteMeta = {
    modo: 'deterministico',
    resumo: '',
    justificativas: [],
    alertas,
    ajustes: [],
    cargaPorVeiculo: [],
    vizinhosSeparados: [],
  };

  const semChave = !process.env.ANTHROPIC_API_KEY;
  const grandeDemais = validOrders.length > AI_MAX_ORDERS;

  let proposal: AIProposal | null = null;
  let modelo = resolveModel(opts?.model);

  if (semChave || grandeDemais) {
    meta.motivoFallback = semChave
      ? 'ANTHROPIC_API_KEY não configurada no ambiente — distribuição feita pelo algoritmo guloso.'
      : `Volume acima do teto do agente (${validOrders.length} > ${AI_MAX_ORDERS} pedidos) — distribuição feita pelo algoritmo guloso.`;
  } else {
    // FASE 2 — distribuição pela IA
    const codeByOrderId = new Map<string, string>();
    const codeToOrderId = new Map<string, string>();
    validOrders.forEach((o, i) => {
      const code = `P${i + 1}`;
      codeByOrderId.set(o.id, code);
      codeToOrderId.set(code, o.id);
    });

    try {
      const briefing = buildBriefing(validOrders, codeByOrderId, vehicles, eligibleByVehicle, routeDate, weekdayWarnings);
      console.log(`🤖 [ROTA-IA] ${validOrders.length} pedidos × ${vehicles.length} veículos → ${modelo} (briefing ${briefing.length} chars)`);
      const { ok, status, j } = await callAnthropic(modelo, SYSTEM_PROMPT, briefing, TOOL_DEF);
      if (!ok) {
        throw new Error(`Anthropic HTTP ${status}: ${JSON.stringify(j?.error || j).slice(0, 300)}`);
      }
      const block = (j?.content || []).find((c: any) => c?.type === 'tool_use' && c?.name === TOOL_DEF.name);
      if (!block?.input) {
        throw new Error('Resposta da IA sem tool_use distribuir_entregas.');
      }
      proposal = block.input as AIProposal;
      meta.tokens = {
        input: j?.usage?.input_tokens ?? 0,
        output: j?.usage?.output_tokens ?? 0,
      };
      meta.modelo = modelo;
      console.log(`🤖 [ROTA-IA] proposta recebida: ${proposal.atribuicoes?.length || 0} atribuições, ${proposal.nao_atribuidos?.length || 0} não atribuídos`);
    } catch (e: any) {
      proposal = null;
      meta.motivoFallback = `Falha ao consultar o agente de IA (${e?.message || e}) — distribuição feita pelo algoritmo guloso.`;
      console.error('❌ [ROTA-IA]', e?.message || e);
    }

    if (proposal) {
      const rep = applyAndRepair(proposal, { orders: validOrders, vehicles, eligibleByVehicle }, codeToOrderId);
      assignments = rep.assignments;
      workload = rep.workload;
      unassigned = rep.unassigned;
      ajustes = rep.ajustes;
      meta.modo = 'ia';
      meta.resumo = String(proposal.resumo || '').trim();
      meta.alertas = [...alertas, ...((proposal.alertas || []).map((a) => String(a)))];
      meta.ajustes = ajustes;
      meta.justificativas = (proposal.justificativa_por_veiculo || [])
        .filter((x) => Number.isInteger(x?.veiculo) && vehicles[x.veiculo])
        .map((x) => ({
          veiculo: `V${x.veiculo} · ${vehicles[x.veiculo].type}${vehicles[x.veiculo].driverName ? ` · ${vehicles[x.veiculo].driverName}` : ''}`,
          texto: String(x.texto || ''),
        }));

      const plan = await finish(storage, assignments, workload, unassigned, invalidOrders, vehicles, routeDate, orders, meta, t0, eligibleByVehicle);
      return plan;
    }
  }

  // FASE 2 (fallback) — distribuidor guloso original
  const greedy = assignOrdersToVehicles(urgentOrders, regularOrders, vehicles, eligibleByVehicle);
  assignments = greedy.assignments;
  unassigned = greedy.unassigned;
  workload = new Map<number, number>();
  vehicles.forEach((_, idx) => {
    const list = assignments.get(idx) || [];
    workload.set(idx, 30 + list.reduce((s, o) => s + (o.averageDeliveryTime || 30) + 15, 0));
  });
  meta.resumo = 'Distribuição automática por proximidade e menor carga (sem agente de IA nesta execução).';
  meta.ajustes = [];

  return finish(storage, assignments, workload, unassigned, invalidOrders, vehicles, routeDate, orders, meta, t0, eligibleByVehicle);
}

// ==================== FASE 3/4 comuns ====================

async function finish(
  storage: DatabaseStorage,
  assignments: Map<number, DeliveryOrder[]>,
  workload: Map<number, number>,
  unassigned: DeliveryOrder[],
  invalidOrders: Array<{ order: DeliveryOrder; reason: string }>,
  vehicles: VehicleConfig[],
  routeDate: Date,
  allOrders: DeliveryOrder[],
  meta: AIRouteMeta,
  t0: number,
  eligibleByVehicle?: Map<number, DeliveryOrder[]>,
): Promise<AIRoutePlan> {
  // FASE 3 — sequência ótima por veículo (NN + 2-opt + OSRM), reaproveitando o motor atual
  const routes: VehicleRoute[] = await optimizeVehicleRoutes(assignments, vehicles, routeDate);

  // Carga por veículo (para a tela mostrar equilíbrio)
  meta.cargaPorVeiculo = vehicles.map((v, idx) => {
    const list = assignments.get(idx) || [];
    const disp = timeToMinutes(v.timeWindowEnd) - timeToMinutes(v.timeWindowStart);
    const usados = workload.get(idx) ?? 30;
    return {
      veiculo: `V${idx} · ${v.type}`,
      motorista: v.driverName,
      entregas: list.length,
      minutosEstimados: Math.round(usados),
      minutosDisponiveis: disp,
      utilizacaoPct: disp > 0 ? Math.round((usados / disp) * 1000) / 10 : 0,
    };
  });

  // Diagnóstico de vizinhos separados (responde "por que esses dois foram para
  // entregadores diferentes?" direto na tela).
  if (eligibleByVehicle) {
    try {
      meta.vizinhosSeparados = diagnosticarVizinhosSeparados(assignments, vehicles, eligibleByVehicle);
      if (meta.vizinhosSeparados.length) {
        console.log(`🔎 [ROTA-IA] ${meta.vizinhosSeparados.length} par(es) de pedidos vizinhos em rotas diferentes`);
      }
    } catch (e: any) {
      console.warn('[ROTA-IA] Falha no diagnóstico de vizinhos:', e?.message);
    }
  }

  const allUnassigned = [...unassigned, ...invalidOrders.map((i) => i.order)];
  for (const inv of invalidOrders) {
    meta.alertas.push(`${inv.order.customerName}: ${inv.reason}`);
  }
  if (unassigned.length > 0) {
    meta.alertas.push(
      `${unassigned.length} pedido(s) sem veículo com capacidade/janela disponível — inclua outro motorista ou amplie a janela.`,
    );
  }

  const totalDistance = routes.reduce((s, r) => s + r.totalDistance, 0);
  const assignedOrders = routes.reduce((s, r) => s + r.stops.length, 0);
  meta.duracaoMs = Date.now() - t0;

  // FASE 4 — NÃO persiste aqui. Quem grava rota+paradas e move os cards do
  // pipeline para "Em Rota"/"Em Rota BSB" é POST /api/delivery-routes/save,
  // após a confirmação humana na tela. Isso evita rotas órfãs 'pending'.

  return {
    routes,
    unassignedOrders: allUnassigned,
    stats: {
      totalOrders: allOrders.length,
      assignedOrders,
      unassignedOrders: allUnassigned.length,
      totalDistance,
      totalVehicles: routes.length,
    },
    ai: meta,
  };
}
