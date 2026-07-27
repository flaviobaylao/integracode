// ─── PROVEDOR DE GEOCODIFICACAO ──────────────────────────────────────────────
// Ponto unico de entrada para transformar endereco em coordenada.
//
// Usa a Geocoding API do Google quando GOOGLE_MAPS_API_KEY esta definida;
// sem a chave, cai automaticamente no Nominatim/OSM (comportamento anterior),
// entao a ausencia da variavel nunca derruba a geocodificacao.
//
// POR QUE O GOOGLE: alem de ser ~50x mais rapido (50 req/s contra 1 req/s do
// Nominatim), ele informa a PRECISAO do resultado em location_type. Sem esse
// dado o sistema gravava o centroide de um bairro como se fosse o endereco do
// cliente — origem dos clientes que aparecem empilhados na mesma coordenada.
// Agora a precisao volta em `precisao`/`aproximado` e quem chama decide.
//
// O retorno imita o formato do Nominatim (lat, lon, display_name) para que os
// pontos de chamada existentes continuem funcionando sem reescrita.

export type GeoPrecisao =
  | "rooftop"            // ponto exato do imovel
  | "interpolado"        // interpolado na numeracao da rua
  | "centro_geometrico"  // centro da via/segmento
  | "aproximado"         // centroide de bairro/cidade/CEP — NAO e o endereco
  | "osm";               // Nominatim nao informa precisao

export type GeoHit = {
  lat: string;
  lon: string;
  display_name: string;
  precisao: GeoPrecisao;
  /** true quando a coordenada e o centroide de uma regiao, nao do endereco. */
  aproximado: boolean;
  /** CEP do resultado, so digitos ('' quando o provedor nao devolve). */
  postcode: string;
  provider: "google" | "nominatim";
};

const GOOGLE_KEY = () => String(process.env.GOOGLE_MAPS_API_KEY || "").trim();

export function geocodeProvider(): "google" | "nominatim" {
  return GOOGLE_KEY() ? "google" : "nominatim";
}

/**
 * Intervalo minimo entre chamadas. O Nominatim exige ~1 req/s (politica de uso);
 * o Google aceita ~50 req/s, entao 120ms deixa margem larga.
 */
export function geocodeThrottleMs(): number {
  return geocodeProvider() === "google" ? 120 : 1100;
}

const PRECISAO_GOOGLE: Record<string, GeoPrecisao> = {
  ROOFTOP: "rooftop",
  RANGE_INTERPOLATED: "interpolado",
  GEOMETRIC_CENTER: "centro_geometrico",
  APPROXIMATE: "aproximado",
};

async function geocodeGoogle(query: string): Promise<GeoHit | null> {
  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(query)}` +
    "&components=country:BR&region=br&language=pt-BR" +
    `&key=${encodeURIComponent(GOOGLE_KEY())}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Google Geocoding HTTP ${resp.status}`);
  const j: any = await resp.json();
  const status = String(j?.status || "");
  if (status === "ZERO_RESULTS") return null;
  if (status !== "OK") {
    // REQUEST_DENIED costuma ser restricao de chave errada; OVER_QUERY_LIMIT e
    // cota/faturamento. Vale falhar alto: silenciar aqui esconderia o motivo.
    throw new Error(`Google Geocoding: ${status}${j?.error_message ? ` — ${j.error_message}` : ""}`);
  }
  const r = j?.results?.[0];
  if (!r?.geometry?.location) return null;
  const locType = String(r.geometry.location_type || "");
  const precisao: GeoPrecisao = PRECISAO_GOOGLE[locType] || "aproximado";
  const comps: any[] = Array.isArray(r.address_components) ? r.address_components : [];
  const cep = comps.find((c) => Array.isArray(c?.types) && c.types.includes("postal_code"));
  return {
    lat: String(r.geometry.location.lat),
    lon: String(r.geometry.location.lng),
    display_name: String(r.formatted_address || ""),
    precisao,
    aproximado: precisao === "aproximado",
    postcode: String(cep?.long_name || "").replace(/\D/g, ""),
    provider: "google",
  };
}

async function geocodeNominatim(query: string): Promise<GeoHit | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&addressdetails=1&q=" +
    encodeURIComponent(query);
  const resp = await fetch(url, {
    headers: { "User-Agent": "INTEGRA2.0-geocode/1.0 (flaviobaylao@gmail.com)" },
    signal: AbortSignal.timeout(15000),
  });
  const arr: any = resp.ok ? await resp.json() : [];
  const hit = Array.isArray(arr) && arr.length ? arr[0] : null;
  if (!hit) return null;
  const display = String(hit.display_name || "");
  const cep =
    String(hit?.address?.postcode || "").replace(/\D/g, "") ||
    ((display.match(/\b\d{5}-?\d{3}\b/) || [""])[0]).replace(/\D/g, "");
  return {
    lat: String(hit.lat),
    lon: String(hit.lon),
    display_name: display,
    precisao: "osm",
    aproximado: false, // OSM nao informa; nao da para afirmar que e aproximado
    postcode: cep,
    provider: "nominatim",
  };
}

/** Geocodifica uma consulta ja montada. Devolve null quando nao ha resultado. */
export async function geocodeOne(query: string): Promise<GeoHit | null> {
  if (!String(query || "").trim()) return null;
  return geocodeProvider() === "google" ? geocodeGoogle(query) : geocodeNominatim(query);
}
