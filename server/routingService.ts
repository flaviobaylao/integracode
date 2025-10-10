import axios from 'axios';

// URL base do OSRM (servidor público)
const OSRM_BASE_URL = 'http://router.project-osrm.org';

// Função Haversine como fallback (linha reta)
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Retorna em metros
}

/**
 * Calcula a distância real de moto entre dois pontos usando OSRM
 * Retorna distância em metros
 */
export async function calculateRealDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): Promise<number> {
  try {
    // Formato: longitude,latitude;longitude,latitude
    const coordinates = `${lon1},${lat1};${lon2},${lat2}`;
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coordinates}`;
    
    const response = await axios.get(url, {
      params: {
        overview: 'false', // Não precisamos da geometria
        steps: 'false'      // Não precisamos das instruções
      },
      timeout: 5000 // 5 segundos de timeout
    });

    if (response.data.code === 'Ok' && response.data.routes && response.data.routes.length > 0) {
      const distance = response.data.routes[0].distance; // em metros
      return Math.round(distance);
    }

    // Se não obteve rota válida, usa Haversine
    console.warn('OSRM não retornou rota válida, usando Haversine');
    return Math.round(calculateHaversineDistance(lat1, lon1, lat2, lon2));
  } catch (error: any) {
    console.error('Erro ao calcular distância real com OSRM:', error.message);
    // Fallback para Haversine em caso de erro
    return Math.round(calculateHaversineDistance(lat1, lon1, lat2, lon2));
  }
}

/**
 * Calcula distâncias reais entre múltiplos pontos (rota sequencial)
 * Retorna array de distâncias entre pontos consecutivos em metros
 */
export async function calculateRouteDistances(
  coordinates: { lat: number; lon: number }[]
): Promise<number[]> {
  if (coordinates.length < 2) {
    return [];
  }

  try {
    // Construir string de coordenadas para OSRM
    const coordsString = coordinates
      .map(c => `${c.lon},${c.lat}`)
      .join(';');
    
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coordsString}`;
    
    const response = await axios.get(url, {
      params: {
        overview: 'false',
        steps: 'false',
        annotations: 'distance' // Retorna distâncias entre waypoints
      },
      timeout: 10000 // 10 segundos para rotas maiores
    });

    if (response.data.code === 'Ok' && response.data.routes && response.data.routes.length > 0) {
      const route = response.data.routes[0];
      const distances: number[] = [];
      
      // Extrair distâncias dos legs (segmentos entre waypoints)
      if (route.legs && route.legs.length > 0) {
        route.legs.forEach((leg: any) => {
          distances.push(Math.round(leg.distance));
        });
        return distances;
      }
    }

    // Fallback: calcular com Haversine
    console.warn('OSRM não retornou distâncias válidas, usando Haversine');
    return calculateHaversineDistances(coordinates);
  } catch (error: any) {
    console.error('Erro ao calcular distâncias de rota com OSRM:', error.message);
    // Fallback para Haversine
    return calculateHaversineDistances(coordinates);
  }
}

/**
 * Calcula distâncias usando Haversine (fallback)
 */
function calculateHaversineDistances(
  coordinates: { lat: number; lon: number }[]
): number[] {
  const distances: number[] = [];
  for (let i = 0; i < coordinates.length - 1; i++) {
    const dist = calculateHaversineDistance(
      coordinates[i].lat,
      coordinates[i].lon,
      coordinates[i + 1].lat,
      coordinates[i + 1].lon
    );
    distances.push(Math.round(dist));
  }
  return distances;
}

/**
 * Calcula distância total de uma rota usando rotas reais de moto
 * Retorna distância em metros
 */
export async function calculateTotalRouteDistance(
  coordinates: { lat: number; lon: number }[]
): Promise<number> {
  if (coordinates.length < 2) {
    return 0;
  }

  try {
    const coordsString = coordinates
      .map(c => `${c.lon},${c.lat}`)
      .join(';');
    
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coordsString}`;
    
    const response = await axios.get(url, {
      params: {
        overview: 'false',
        steps: 'false'
      },
      timeout: 10000
    });

    if (response.data.code === 'Ok' && response.data.routes && response.data.routes.length > 0) {
      const totalDistance = response.data.routes[0].distance; // em metros
      return Math.round(totalDistance);
    }

    // Fallback: somar Haversine
    const distances = calculateHaversineDistances(coordinates);
    return distances.reduce((sum, d) => sum + d, 0);
  } catch (error: any) {
    console.error('Erro ao calcular distância total com OSRM:', error.message);
    // Fallback: somar Haversine
    const distances = calculateHaversineDistances(coordinates);
    return distances.reduce((sum, d) => sum + d, 0);
  }
}

/**
 * Calcula matriz de distâncias entre múltiplos pontos
 * Útil para otimização de rotas
 * Retorna matriz NxN de distâncias em metros
 */
export async function calculateDistanceMatrix(
  coordinates: { lat: number; lon: number }[]
): Promise<number[][]> {
  if (coordinates.length < 2) {
    return [];
  }

  try {
    const coordsString = coordinates
      .map(c => `${c.lon},${c.lat}`)
      .join(';');
    
    const url = `${OSRM_BASE_URL}/table/v1/driving/${coordsString}`;
    
    const response = await axios.get(url, {
      params: {
        annotations: 'distance'
      },
      timeout: 15000 // 15 segundos para matrizes maiores
    });

    if (response.data.code === 'Ok' && response.data.distances) {
      // Arredondar todas as distâncias
      return response.data.distances.map((row: number[]) =>
        row.map(d => Math.round(d))
      );
    }

    // Fallback: calcular matriz com Haversine
    console.warn('OSRM não retornou matriz válida, usando Haversine');
    return calculateHaversineMatrix(coordinates);
  } catch (error: any) {
    console.error('Erro ao calcular matriz de distâncias com OSRM:', error.message);
    // Fallback para Haversine
    return calculateHaversineMatrix(coordinates);
  }
}

/**
 * Calcula matriz de distâncias usando Haversine (fallback)
 */
function calculateHaversineMatrix(
  coordinates: { lat: number; lon: number }[]
): number[][] {
  const matrix: number[][] = [];
  
  for (let i = 0; i < coordinates.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < coordinates.length; j++) {
      if (i === j) {
        matrix[i][j] = 0;
      } else {
        const dist = calculateHaversineDistance(
          coordinates[i].lat,
          coordinates[i].lon,
          coordinates[j].lat,
          coordinates[j].lon
        );
        matrix[i][j] = Math.round(dist);
      }
    }
  }
  
  return matrix;
}
