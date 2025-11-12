export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

export function calculateRouteDistance(coordinates: Array<{ lat: number; lng: number }>): number {
  if (coordinates.length < 2) return 0;
  
  let totalDistance = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const dist = calculateDistance(
      coordinates[i].lat,
      coordinates[i].lng,
      coordinates[i + 1].lat,
      coordinates[i + 1].lng
    );
    totalDistance += dist;
  }
  
  return totalDistance;
}
