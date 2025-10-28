import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Home, MapPin } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';

interface RouteMapProps {
  homeLocation: { latitude: number; longitude: number };
  visits: Array<{
    id: string;
    customerName: string;
    customerLatitude: string | null;
    customerLongitude: string | null;
    actualCheckIn?: string | null;
    actualCheckOut?: string | null;
  }>;
  optimizedOrder: string[];
  checkpoints?: Array<{
    visitId: string;
    latitude: string;
    longitude: string;
    timestamp: string;
    checkpointType: string;
  }>;
}

export default function RouteMap({ homeLocation, visits, optimizedOrder, checkpoints = [] }: RouteMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Validar coordenadas antes de renderizar
  const hasValidCoordinates = 
    homeLocation && 
    typeof homeLocation.latitude === 'number' && 
    typeof homeLocation.longitude === 'number' &&
    !isNaN(homeLocation.latitude) && 
    !isNaN(homeLocation.longitude);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !hasValidCoordinates) return;

    // Inicializar mapa
    const map = L.map(mapContainerRef.current).setView(
      [homeLocation.latitude, homeLocation.longitude],
      13
    );

    mapRef.current = map;

    // Adicionar camada do OpenStreetMap
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;

    const map = mapRef.current;

    // Limpar marcadores e linhas anteriores
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker || layer instanceof L.Polyline) {
        map.removeLayer(layer);
      }
    });

    // Criar ícone da casa
    const homeIconHtml = renderToStaticMarkup(
      <div className="bg-green-600 rounded-full p-2 shadow-lg">
        <Home className="h-6 w-6 text-white" />
      </div>
    );

    const homeIcon = L.divIcon({
      html: homeIconHtml,
      className: '',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });

    // Adicionar marcador da casa
    const homeMarker = L.marker([homeLocation.latitude, homeLocation.longitude], {
      icon: homeIcon,
    })
      .addTo(map)
      .bindPopup('<strong>Sua Casa</strong><br>Início e fim da rota');

    // Array para armazenar coordenadas da rota
    const routeCoordinates: [number, number][] = [
      [homeLocation.latitude, homeLocation.longitude]
    ];

    // Adicionar marcadores para cada visita na ordem otimizada
    optimizedOrder.forEach((visitId, index) => {
      const visit = visits.find(v => v.id === visitId);
      if (!visit || !visit.customerLatitude || !visit.customerLongitude) return;

      const lat = parseFloat(visit.customerLatitude);
      const lon = parseFloat(visit.customerLongitude);

      // Adicionar coordenada à rota
      routeCoordinates.push([lat, lon]);

      // Determinar status da visita
      const status = visit.actualCheckOut 
        ? 'completed' 
        : visit.actualCheckIn 
        ? 'in_progress' 
        : 'pending';

      // Cor baseada no status
      const color = status === 'completed' 
        ? 'bg-green-600' 
        : status === 'in_progress' 
        ? 'bg-blue-600' 
        : 'bg-gray-400';

      // Criar ícone numerado
      const visitIconHtml = renderToStaticMarkup(
        <div className={`${color} rounded-full shadow-lg flex items-center justify-center`}
             style={{ width: '32px', height: '32px' }}>
          <span className="text-white font-bold text-sm">{index + 1}</span>
        </div>
      );

      const visitIcon = L.divIcon({
        html: visitIconHtml,
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      // Adicionar marcador
      const statusText = status === 'completed' 
        ? '✅ Concluída' 
        : status === 'in_progress' 
        ? '🔄 Em andamento' 
        : '⏳ Pendente';

      L.marker([lat, lon], { icon: visitIcon })
        .addTo(map)
        .bindPopup(`
          <strong>${index + 1}. ${visit.customerName}</strong><br>
          Status: ${statusText}
        `);
    });

    // Voltar para casa
    routeCoordinates.push([homeLocation.latitude, homeLocation.longitude]);

    // Desenhar linha da rota otimizada
    if (routeCoordinates.length > 1) {
      const routeLine = L.polyline(routeCoordinates, {
        color: '#3b82f6',
        weight: 3,
        opacity: 0.7,
        dashArray: '10, 5',
      }).addTo(map);

      // Ajustar zoom para mostrar toda a rota
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    }

    // Adicionar marcadores de checkpoints reais (se houver)
    const checkInCoordinates: [number, number][] = [];
    
    checkpoints.forEach((checkpoint) => {
      const lat = parseFloat(checkpoint.latitude);
      const lon = parseFloat(checkpoint.longitude);

      // Validar coordenadas antes de adicionar marcador
      if (isNaN(lat) || isNaN(lon)) return;

      // Coletar coordenadas de check-in para desenhar rota executada
      if (checkpoint.checkpointType === 'check_in') {
        checkInCoordinates.push([lat, lon]);
      }

      const checkpointIconHtml = renderToStaticMarkup(
        <div className="bg-purple-600 rounded-full shadow-lg flex items-center justify-center"
             style={{ width: '12px', height: '12px' }}>
        </div>
      );

      const checkpointIcon = L.divIcon({
        html: checkpointIconHtml,
        className: '',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });

      L.marker([lat, lon], { icon: checkpointIcon })
        .addTo(map)
        .bindPopup(`
          <strong>${checkpoint.checkpointType === 'check_in' ? 'Check-in' : 'Check-out'}</strong><br>
          ${new Date(checkpoint.timestamp).toLocaleString('pt-BR')}
        `);
    });

    // Desenhar rota executada em vermelho (baseado em check-ins)
    if (checkInCoordinates.length > 0) {
      // Adicionar casa do vendedor no início
      const executedRouteCoordinates: [number, number][] = [
        [homeLocation.latitude, homeLocation.longitude],
        ...checkInCoordinates
      ];

      // Desenhar linha vermelha sólida para rota executada
      L.polyline(executedRouteCoordinates, {
        color: '#ef4444', // Vermelho
        weight: 4,
        opacity: 0.8,
      }).addTo(map);
    }

  }, [homeLocation, visits, optimizedOrder, checkpoints, hasValidCoordinates]);

  if (!hasValidCoordinates) {
    return (
      <div className="w-full h-[500px] rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center bg-gray-50 dark:bg-gray-800">
        <div className="text-center">
          <MapPin className="h-12 w-12 mx-auto text-gray-400 mb-2" />
          <p className="text-gray-600 dark:text-gray-400">Coordenadas inválidas</p>
          <p className="text-sm text-gray-500 dark:text-gray-500">Configure as coordenadas de casa para visualizar o mapa</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={mapContainerRef} 
      className="w-full h-[500px] rounded-lg border border-gray-200 dark:border-gray-700"
      data-testid="route-map"
    />
  );
}
