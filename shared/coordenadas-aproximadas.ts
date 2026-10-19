// ============================================================================
// COORDENADAS APROXIMADAS (19/out/2026)
// ----------------------------------------------------------------------------
// Na análise da roteirização de 18/10, 25 de 63 entregas tinham latitude
// "redonda" numa grade de ~2 km (múltiplos exatos de 1/55,5 grau, ex.:
// −16.684685, −16.666667, −16.720721) e 17 clientes diferentes caíam em só 6
// pontos do mapa. É a marca de coordenada de BAIRRO/região, não do endereço —
// faz o mapa mostrar clientes "a 0,00 km" que na rua não estão juntos e engana
// a divisão por região na fronteira entre entregadores.
//
// Regras (qualquer uma marca como aproximada):
//   1. latitude na grade de ~2 km (|lat×55,5 − inteiro| < 0,0015 — chance de
//      falso positivo para coordenada precisa ≈ 0,3%);
//   2. o mesmo ponto (até ~5 m) usado por clientes DIFERENTES (contexto).
// ============================================================================

export function latitudeEmGrade(lat: any): boolean {
  const v = Number(lat);
  if (!Number.isFinite(v) || v === 0) return false;
  const q = Math.abs(v) * 55.5;
  return Math.abs(q - Math.round(q)) < 0.0015;
}

/** Chave do ponto (≈ 5 m) para detectar clientes empilhados na mesma coordenada. */
export function chavePonto(lat: any, lng: any): string {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

/**
 * Marca as coordenadas aproximadas de uma lista (clientes ou pedidos).
 * `clienteDe` diz quem é o cliente (pedidos do mesmo cliente não contam como empilhados).
 */
export function marcarAproximadas<T>(
  itens: T[],
  latDe: (x: T) => any,
  lngDe: (x: T) => any,
  clienteDe: (x: T) => string,
): Map<T, 'grade' | 'empilhado'> {
  const porPonto = new Map<string, Set<string>>();
  for (const x of itens) {
    const k = chavePonto(latDe(x), lngDe(x));
    const s = porPonto.get(k) || new Set<string>();
    s.add(clienteDe(x));
    porPonto.set(k, s);
  }
  const out = new Map<T, 'grade' | 'empilhado'>();
  for (const x of itens) {
    const lat = latDe(x);
    if (!Number.isFinite(Number(lat)) || Number(lat) === 0) continue;
    if (latitudeEmGrade(lat)) out.set(x, 'grade');
    else if ((porPonto.get(chavePonto(lat, lngDe(x)))?.size || 0) > 1) out.set(x, 'empilhado');
  }
  return out;
}
