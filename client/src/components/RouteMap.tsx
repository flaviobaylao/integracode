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
    checkInPhotoUrl?: string | null;
    checkInLatitude?: string | null;
    checkInLongitude?: string | null;
  }>;
  virtualVisits?: Array<{ id: string; customerName: string; customerLatitude: string | null; customerLongitude: string | null }>;
  optimizedOrder: string[];
  checkpoints?: Array<{
    visitId: string;
    checkpointLatitude: string;
    checkpointLongitude: string;
    checkpointTime: string;
    checkpointType: string;
  }>;
  onPhotoClick?: (photoData: {
    url: string;
    customerName: string;
    checkInTime: string;
    latitude: string;
    longitude: string;
  }) => void;
}

export default function RouteMap({ homeLocation, visits, virtualVisits = [], optimizedOrder, checkpoints = [], onPhotoClick }: RouteMapProps) {
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

    // [Fase 3] Marcadores dos clientes VIRTUAIS (atendimento remoto) — cor distinta (roxo), NAO entram no tracado.
    (virtualVisits || []).forEach((visit) => {
      if (!visit.customerLatitude || !visit.customerLongitude) return;
      const vlat = parseFloat(visit.customerLatitude);
      const vlon = parseFloat(visit.customerLongitude);
      if (isNaN(vlat) || isNaN(vlon)) return;
      const vIconHtml = renderToStaticMarkup(
        <div className="bg-purple-600 rounded-full shadow-lg flex items-center justify-center border-2 border-white"
             style={{ width: '28px', height: '28px' }}>
          <span className="text-white font-bold text-xs">V</span>
        </div>
      );
      const vIcon = L.divIcon({ html: vIconHtml, className: '', iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([vlat, vlon], { icon: vIcon })
        .addTo(map)
        .bindPopup(`<strong>${visit.customerName}</strong><br>🟣 Cliente virtual (atendimento remoto)`);
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
      const lat = parseFloat(checkpoint.checkpointLatitude);
      const lon = parseFloat(checkpoint.checkpointLongitude);

      // Validar coordenadas antes de adicionar marcador
      if (isNaN(lat) || isNaN(lon)) return;

      // Coletar coordenadas de check-in para desenhar rota executada
      if (checkpoint.checkpointType === 'check_in') {
        checkInCoordinates.push([lat, lon]);
      }

      // Encontrar a visita correspondente para verificar se tem foto
      const correspondingVisit = visits.find(v => v.id === checkpoint.visitId);
      const hasPhoto = correspondingVisit?.checkInPhotoUrl && checkpoint.checkpointType === 'check_in';

      // Ícone diferente se tiver foto (camera icon)
      const checkpointIconHtml = hasPhoto ? renderToStaticMarkup(
        <div className="bg-purple-600 rounded-full shadow-lg flex items-center justify-center cursor-pointer hover:bg-purple-700"
             style={{ width: '20px', height: '20px' }}
             title="Clique para ver a foto">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
            <circle cx="12" cy="13" r="3"/>
          </svg>
        </div>
      ) : renderToStaticMarkup(
        <div className="bg-purple-600 rounded-full shadow-lg flex items-center justify-center"
             style={{ width: '12px', height: '12px' }}>
        </div>
      );

      const checkpointIcon = L.divIcon({
        html: checkpointIconHtml,
        className: hasPhoto ? 'checkpoint-with-photo' : '',
        iconSize: hasPhoto ? [20, 20] : [12, 12],
        iconAnchor: hasPhoto ? [10, 10] : [6, 6],
      });

      const marker = L.marker([lat, lon], { icon: checkpointIcon }).addTo(map);

      // Se tiver foto e callback, adicionar evento de clique
      if (hasPhoto && onPhotoClick && correspondingVisit) {
        marker.on('click', () => {
          onPhotoClick({
            url: correspondingVisit.checkInPhotoUrl!,
            customerName: correspondingVisit.customerName,
            checkInTime: correspondingVisit.actualCheckIn!,
            latitude: correspondingVisit.checkInLatitude || checkpoint.checkpointLatitude,
            longitude: correspondingVisit.checkInLongitude || checkpoint.checkpointLongitude
          });
        });
      }

      // Popup com informações
      const popupContent = hasPhoto 
        ? `<strong>📸 ${checkpoint.checkpointType === 'check_in' ? 'Check-in' : 'Check-out'}</strong><br>
           ${new Date(checkpoint.checkpointTime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}<br>
           <em style="color: #9333ea;">Clique no ícone para ver a foto</em>`
        : `<strong>${checkpoint.checkpointType === 'check_in' ? 'Check-in' : 'Check-out'}</strong><br>
           ${new Date(checkpoint.checkpointTime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;

      marker.bindPopup(popupContent);
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

  }, [homeLocation, visits, virtualVisits, optimizedOrder, checkpoints, hasValidCoordinates]);

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
