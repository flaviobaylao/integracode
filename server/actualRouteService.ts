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
    return {
      totalDistance: Math.round(pTotal * 100) / 100,
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

  return {
    totalDistance: Math.round(totalDistance * 100) / 100,
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
export async function recalculateRouteDistance(
  dailyRouteId: string,
  storage: DatabaseStorage
): Promise<void> {
  const result = await calculateActualRouteDistance(storage, dailyRouteId);
  
  await storage.updateDailyRoute(dailyRouteId, {
    totalActualDistance: result.totalDistance.toString(),
    completedVisits: result.validatedVisits
  });
}
