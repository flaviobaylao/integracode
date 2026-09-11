import { DatabaseStorage } from './storage';
import { calculateRealDistance } from './routingService';
// Hora oficial do Brasil — regra unica em shared/tempo.ts.
import { agora } from '@shared/tempo';

// (24/ago/2026) Coordenada valida? Descarta (0,0)/nula/fora de faixa. Sem isto, uma
// casa de vendedor nao configurada (start = 0,0 no golfo da Guine) inflava a km:
// casa(0,0) -> check-in(Goiania) -> casa(0,0) somava ~5.710 km por perna (~11.421 km
// de km fantasma). Trechos com ponta invalida passam a valer 0.
function coordOk(lat: number, lon: number): boolean {
  if (!isFinite(lat) || !isFinite(lon)) return false;
  if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false; // (0,0) = nao configurada
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// ROTA INTERMUNICIPAL (set/2026): "portoes" (bordas de saida da cidade). Quando um
// check-in/lead do dia cai ALEM de um portao (mais longe da casa do que o portao
// naquela direcao — ou seja, o vendedor passou pelo portao pra chegar la), o dia
// conta km INTERMUNICIPAL separada: do PORTAO mais proximo do 1o ponto fora →
// pontos fora (em ordem) → Casa. O restante (trecho urbano) fica na km "normal".
// A km total paga NAO muda: intermunicipal_distance e um recorte informativo do
// total (normal = total − intermunicipal). Coordenadas configuraveis aqui.
// ───────────────────────────────────────────────────────────────────────────
const INTERMUNICIPAL_GATES: Array<[number, number]> = [
  [-16.60089833515983, -49.19913860560444],
  [-16.742269673615645, -49.13975559798092],
  [-16.789277887310842, -49.23811755907917],
];
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function nearestGate(lat: number, lon: number): [number, number] {
  let best = INTERMUNICIPAL_GATES[0], bestD = Infinity;
  for (const g of INTERMUNICIPAL_GATES) { const d = haversineKm(lat, lon, g[0], g[1]); if (d < bestD) { bestD = d; best = g; } }
  return best;
}
// Ponto "fora do perimetro": mais longe da casa do que o portao mais proximo dele
// (o vendedor passou por aquele portao pra chegar ate o ponto). Classificacao por
// linha reta (barata); a distancia intermunicipal em si usa rota real (OSRM).
function isForaPerimetro(lat: number, lon: number, homeLat: number, homeLon: number): boolean {
  if (!coordOk(lat, lon) || !coordOk(homeLat, homeLon)) return false;
  const g = nearestGate(lat, lon);
  return haversineKm(homeLat, homeLon, lat, lon) > haversineKm(homeLat, homeLon, g[0], g[1]);
}
// Km intermunicipal a partir de uma lista ordenada de pontos {lat,lon}: portao mais
// proximo do 1o ponto fora → pontos fora (em ordem) → Casa. 0 se nenhum ponto fora.
async function computeIntermunicipalKm(
  pts: Array<{ lat: number; lon: number }>,
  homeLat: number, homeLon: number
): Promise<number> {
  if (!coordOk(homeLat, homeLon)) return 0;
  const fora = pts.filter((p) => isForaPerimetro(p.lat, p.lon, homeLat, homeLon));
  if (fora.length === 0) return 0;
  const gate = nearestGate(fora[0].lat, fora[0].lon);
  let km = 0, prevLat = gate[0], prevLon = gate[1];
  for (const p of fora) {
    try { km += (await calculateRealDistance(prevLat, prevLon, p.lat, p.lon)) / 1000; } catch { /* trecho com erro = 0 */ }
    prevLat = p.lat; prevLon = p.lon;
  }
  try { km += (await calculateRealDistance(prevLat, prevLon, homeLat, homeLon)) / 1000; } catch { /* retorno com erro = 0 */ }
  return Math.round(km * 100) / 100;
}

/**
 * Calcula a distância REAL percorrida baseada nos checkpoints (check-ins) realizados
 * Considera apenas visitas validadas (status !== 'cancelled')
 * Segue a ordem cronológica dos check-ins
 * Sempre parte da residência e retorna à residência
 */
export async function calculateActualRouteDistance(
  storage: DatabaseStorage,
  dailyRouteId: string
): Promise<{
  totalDistance: number;
  intermunicipalDistance: number;
  validatedVisits: number;
  offRouteVisits: number;
  cancelledVisits: number;
  segments: Array<{
    from: string;
    to: string;
    distance: number;
    isOffRoute: boolean;
    validationStatus: string;
  }>;
}> {
  // Buscar rota
  const route = await storage.getDailyRoute(dailyRouteId);
  if (!route) {
    throw new Error('Rota não encontrada');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROTA DE PROSPECÇÃO (route_mode='prospeccao'): a km conta o PERCURSO COMPLETO
  // do vendedor — casa → 1º lead registrado → … → último → casa (INCLUI a ida
  // casa→1º ponto, diferente da regra normal do dia). Os "check-ins" aqui são os
  // LEADS REGISTRADOS em nome do vendedor na data da prospecção (cada registro =
  // passagem no ponto), em ordem cronológica de criação. (set/2026)
  // ───────────────────────────────────────────────────────────────────────────
  if ((route as any).routeMode === 'prospeccao') {
    const { db } = await import('./db');
    const { sql } = await import('drizzle-orm');
    // Casa do vendedor (fallback p/ cadastro users.home_*, igual à regra normal).
    let pHomeLat = parseFloat(route.startLatitude);
    let pHomeLon = parseFloat(route.startLongitude);
    const _sid = String((route as any).sellerId || '');
    if (!coordOk(pHomeLat, pHomeLon) && _sid) {
      try {
        const rr: any = await db.execute(sql`SELECT home_latitude AS lat, home_longitude AS lon FROM users WHERE id = ${_sid} OR omie_vendor_code = ${_sid} OR omie_vendor_code = replace(${_sid}, 'omie-vendor-', '') LIMIT 1`);
        const hr = (rr && (rr.rows || rr))[0];
        if (hr) { const hl = parseFloat(hr.lat), ho = parseFloat(hr.lon); if (coordOk(hl, ho)) { pHomeLat = hl; pHomeLon = ho; } }
      } catch (e) { /* mantem o start da rota */ }
    }
    // Data da rota (YYYY-MM-DD) — rota gravada em UTC meia-noite.
    const _dateStr = new Date((route as any).routeDate).toISOString().slice(0, 10);
    // Leads registrados em nome do vendedor na data (check-ins da prospecção),
    // em ordem cronológica. Coordenadas são obrigatórias no cadastro de lead.
    let leadRows: any[] = [];
    try {
      const lr: any = await db.execute(sql`
        SELECT latitude AS lat, longitude AS lon, fantasy_name AS name, created_at
        FROM leads
        WHERE (assigned_to = ${_sid} OR created_by = ${_sid})
          AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') = ${_dateStr}::date
        ORDER BY created_at ASC
      `);
      leadRows = (lr && (lr.rows || lr)) || [];
    } catch (e) { leadRows = []; }

    const pSegments: Array<{ from: string; to: string; distance: number; isOffRoute: boolean; validationStatus: string }> = [];
    let pTotal = 0;
    let pPrevLat = pHomeLat, pPrevLon = pHomeLon;
    let pHaveOrigin = coordOk(pHomeLat, pHomeLon); // origem = CASA (a ida casa→1º ponto conta)
    let pPrevName = 'Casa do Vendedor';
    let pCount = 0;
    for (const r of leadRows) {
      const la = parseFloat((r as any).lat), lo = parseFloat((r as any).lon);
      if (!coordOk(la, lo)) continue;
      pCount++;
      if (pHaveOrigin) {
        try {
          const d = (await calculateRealDistance(pPrevLat as number, pPrevLon as number, la, lo)) / 1000;
          pTotal += d;
          pSegments.push({ from: pPrevName, to: (r as any).name || 'Lead', distance: Math.round(d * 100) / 100, isOffRoute: false, validationStatus: 'validated' });
        } catch (e) { /* ignora trecho com erro */ }
      }
      pPrevLat = la; pPrevLon = lo; pPrevName = (r as any).name || 'Lead'; pHaveOrigin = true;
    }
    // Volta pra casa (último lead → casa), fechando o percurso completo.
    if (pCount > 0 && coordOk(pHomeLat, pHomeLon)) {
      try {
        const d = (await calculateRealDistance(pPrevLat as number, pPrevLon as number, pHomeLat, pHomeLon)) / 1000;
        pTotal += d;
        pSegments.push({ from: pPrevName, to: 'Casa do Vendedor (Retorno)', distance: Math.round(d * 100) / 100, isOffRoute: false, validationStatus: 'validated' });
      } catch (e) { /* ignora retorno */ }
    }
    // Intermunicipal na prospecção: leads registrados fora do perímetro contam como
    // trecho intermunicipal (portão → leads fora → casa), mesmo recorte do modo 'dia'.
    const pInterPts = leadRows
      .map((r: any) => ({ lat: parseFloat(r.lat), lon: parseFloat(r.lon) }))
      .filter((p: any) => coordOk(p.lat, p.lon));
    const pInter = await computeIntermunicipalKm(pInterPts, pHomeLat, pHomeLon);
    return {
      totalDistance: Math.round(pTotal * 100) / 100,
      intermunicipalDistance: pInter,
      validatedVisits: pCount,
      offRouteVisits: 0,
      cancelledVisits: 0,
      segments: pSegments
    };
  }

  // Buscar checkpoints em ordem cronológica (apenas check-ins)
  const allCheckpoints = await storage.getRouteCheckpoints(dailyRouteId);
  const checkIns = allCheckpoints
    .filter(cp => cp.checkpointType === 'check_in')
    .sort((a, b) => new Date(a.checkpointTime).getTime() - new Date(b.checkpointTime).getTime());

  const segments = [];
  let totalDistance = 0;
  let validatedVisits = 0;
  let offRouteVisits = 0;
  let cancelledVisits = 0;

  // Casa do vendedor = ponto de RETORNO (fim do km). Se a rota nao tem coordenada de casa
  // valida (start (0,0)/nula — casa nao configurada quando a rota foi gerada), cai para a
  // casa do cadastro do vendedor (users.home_*). Sem um destino de casa valido, a PERNA DE
  // RETORNO (ultimo check-in -> casa) sumia e o km ficava sem a volta pra casa. (set/2026)
  let homeLat = parseFloat(route.startLatitude);
  let homeLon = parseFloat(route.startLongitude);
  if (!coordOk(homeLat, homeLon) && (route as any).sellerId) {
    try {
      const { db } = await import('./db');
      const { sql } = await import('drizzle-orm');
      const _sid = String((route as any).sellerId);
      const rr: any = await db.execute(sql`SELECT home_latitude AS lat, home_longitude AS lon FROM users WHERE id = ${_sid} OR omie_vendor_code = ${_sid} OR omie_vendor_code = replace(${_sid}, 'omie-vendor-', '') LIMIT 1`);
      const hr = (rr && (rr.rows || rr))[0];
      if (hr) { const hl = parseFloat(hr.lat), ho = parseFloat(hr.lon); if (coordOk(hl, ho)) { homeLat = hl; homeLon = ho; } }
    } catch (e) { /* mantem o start da rota */ }
  }

  // REGRA (set/2026): o km conta A PARTIR DO 1o CHECK-IN — NAO conta o trecho casa -> 1o
  // cliente (deslocamento de ida) — e fecha na CASA do vendedor (ultimo check-in -> casa).
  // Por isso a origem NAO comeca na casa: o 1o check-in valido vira a origem SEM gerar
  // perna; do 2o check-in em diante as pernas somam; no fim, soma a volta ate a casa.
  let previousLat: number | null = null;
  let previousLon: number | null = null;
  let previousName = 'Casa do Vendedor';
  let haveOrigin = false;
  // Pontos validados (em ordem cronológica) p/ o recorte intermunicipal.
  const validPts: Array<{ lat: number; lon: number }> = [];

  for (const checkpoint of checkIns) {
    const currentLat = parseFloat(checkpoint.checkpointLatitude as any);
    const currentLon = parseFloat(checkpoint.checkpointLongitude as any);
    
    // Buscar informações do cliente
    const { customers } = await import('../shared/schema');
    const { db } = await import('./db');
    const { eq } = await import('drizzle-orm');
    
    const [customer] = await db.select()
      .from(customers)
      .where(eq(customers.id, checkpoint.customerId))
      .limit(1);

    const customerName = customer?.name || 'Cliente desconhecido';
    
    // Contar tipo de visita
    if (checkpoint.isOffRoute) {
      offRouteVisits++;
    }
    
    if (checkpoint.validationStatus === 'cancelled') {
      cancelledVisits++;
    } else {
      validatedVisits++;
    }

    // Calcular distancia real apenas para visitas validadas E com coordenadas
    // validas nas duas pontas (evita km fantasma vinda de (0,0)/coordenada nula).
    let distance = 0;
    if (checkpoint.validationStatus !== 'cancelled' && haveOrigin && coordOk(currentLat, currentLon)) {
      try {
        const distanceMeters = await calculateRealDistance(
          previousLat as number,
          previousLon as number,
          currentLat,
          currentLon
        );
        distance = distanceMeters / 1000; // Converter para km
        totalDistance += distance;
      } catch (error) {
        console.error('Erro ao calcular distância real:', error);
      }
    }

    segments.push({
      from: previousName,
      to: customerName,
      distance: Math.round(distance * 100) / 100,
      isOffRoute: checkpoint.isOffRoute || false,
      validationStatus: checkpoint.validationStatus || 'validated'
    });

    // Se validada e com coordenada valida, vira o novo ponto de referencia (e passa
    // a haver origem, mesmo que a casa fosse invalida: o 1o check-in valido ancora).
    if (checkpoint.validationStatus !== 'cancelled' && coordOk(currentLat, currentLon)) {
      previousLat = currentLat;
      previousLon = currentLon;
      previousName = customerName;
      haveOrigin = true;
      validPts.push({ lat: currentLat, lon: currentLon });
    }
  }

  // Distancia de RETORNO para casa (ultimo check-in -> casa do vendedor). So conta se
  // houve visita valida e a casa (resolvida acima, com fallback p/ cadastro) e valida.
  if (validatedVisits > 0 && haveOrigin && coordOk(homeLat, homeLon)) {
    try {
      const returnDistanceMeters = await calculateRealDistance(
        previousLat as number,
        previousLon as number,
        homeLat,
        homeLon
      );
      const returnDistance = returnDistanceMeters / 1000;
      totalDistance += returnDistance;

      segments.push({
        from: previousName,
        to: 'Casa do Vendedor (Retorno)',
        distance: Math.round(returnDistance * 100) / 100,
        isOffRoute: false,
        validationStatus: 'validated'
      });
    } catch (error) {
      console.error('Erro ao calcular distância de retorno:', error);
    }
  }

  // Recorte INTERMUNICIPAL do dia (portão → pontos fora → casa). É 0 quando o
  // vendedor não passou por nenhum portão. Informativo: não altera o total pago.
  const intermunicipalDistance = await computeIntermunicipalKm(validPts, homeLat, homeLon);

  return {
    totalDistance: Math.round(totalDistance * 100) / 100,
    intermunicipalDistance,
    validatedVisits,
    offRouteVisits,
    cancelledVisits,
    segments
  };
}

/**
 * Valida uma visita fora da rota
 */
export async function validateOffRouteVisit(
  storage: DatabaseStorage,
  checkpointId: string,
  adminId: string
): Promise<void> {
  const checkpoint = await storage.getRouteCheckpointById(checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'validated',
    validatedBy: adminId,
    validatedAt: agora()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(checkpoint.dailyRouteId, storage);
}

/**
 * Cancela uma visita fora da rota
 */
export async function cancelOffRouteVisit(
  storage: DatabaseStorage,
  checkpointId: string,
  adminId: string
): Promise<void> {
  const checkpoint = await storage.getRouteCheckpointById(checkpointId);
  
  if (!checkpoint) {
    throw new Error('Checkpoint não encontrado');
  }

  if (!checkpoint.isOffRoute) {
    throw new Error('Esta visita não está marcada como fora da rota');
  }

  await storage.updateRouteCheckpoint(checkpointId, {
    validationStatus: 'cancelled',
    validatedBy: adminId,
    validatedAt: agora()
  });

  // Recalcular distância total da rota
  await recalculateRouteDistance(checkpoint.dailyRouteId, storage);
}

/**
 * Recalcula a distância total da rota baseado nos checkpoints validados
 */
// Garante a coluna intermunicipal_distance (padrão do projeto: ALTER IF NOT EXISTS
// em runtime, sem migração manual). Roda 1x por processo.
let __intermColReady = false;
async function ensureIntermunicipalColumn(): Promise<void> {
  if (__intermColReady) return;
  try {
    const { db } = await import('./db');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`ALTER TABLE daily_routes ADD COLUMN IF NOT EXISTS intermunicipal_distance numeric`);
    __intermColReady = true;
  } catch (e: any) { console.warn('[KM] ensure intermunicipal_distance:', e?.message); }
}

export async function recalculateRouteDistance(
  dailyRouteId: string,
  storage: DatabaseStorage
): Promise<void> {
  const result = await calculateActualRouteDistance(storage, dailyRouteId);

  await storage.updateDailyRoute(dailyRouteId, {
    totalActualDistance: result.totalDistance.toString(),
    completedVisits: result.validatedVisits
  });

  // Persiste o recorte intermunicipal (coluna própria, via SQL cru p/ não depender
  // do mapeamento do storage). Não afeta a km total paga.
  try {
    await ensureIntermunicipalColumn();
    const { db } = await import('./db');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE daily_routes SET intermunicipal_distance = ${Number(result.intermunicipalDistance || 0)} WHERE id = ${dailyRouteId}`);
  } catch (e: any) { console.warn('[KM] persist intermunicipal_distance:', e?.message); }
}
