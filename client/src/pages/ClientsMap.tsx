import { useQuery } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Users } from "lucide-react";

interface Customer {
  id: string;
  name: string;
  fantasyName: string;
  address: string;
  phone: string;
  weekdays: string;
  isActive: boolean;
  latitude: string;
  longitude: string;
}

// Cores dos pins baseadas no dia da semana
const WEEKDAY_COLORS = {
  'SEG': '#22c55e', // Verde
  'Seg': '#22c55e',
  'Segunda': '#22c55e',
  'segunda': '#22c55e',
  'TER': '#3b82f6', // Azul
  'Ter': '#3b82f6',
  'Terça': '#3b82f6',
  'terça': '#3b82f6',
  'QUA': '#eab308', // Amarelo
  'Qua': '#eab308',
  'Quarta': '#eab308',
  'quarta': '#eab308',
  'QUI': '#ef4444', // Vermelho
  'Qui': '#ef4444',
  'Quinta': '#ef4444',
  'quinta': '#ef4444',
  'SEX': '#a855f7', // Roxo
  'Sex': '#a855f7',
  'Sexta': '#a855f7',
  'sexta': '#a855f7',
};

const WEEKDAY_NAMES = {
  'SEG': 'Segunda',
  'Seg': 'Segunda',
  'Segunda': 'Segunda',
  'segunda': 'Segunda',
  'TER': 'Terça',
  'Ter': 'Terça',
  'Terça': 'Terça',
  'terça': 'Terça',
  'QUA': 'Quarta',
  'Qua': 'Quarta',
  'Quarta': 'Quarta',
  'quarta': 'Quarta',
  'QUI': 'Quinta',
  'Qui': 'Quinta',
  'Quinta': 'Quinta',
  'quinta': 'Quinta',
  'SEX': 'Sexta',
  'Sex': 'Sexta',
  'Sexta': 'Sexta',
  'sexta': 'Sexta',
};

// Função para obter a cor do pin baseada no primeiro dia da semana do cliente
function getPinColor(weekdays: string): string {
  try {
    const days = JSON.parse(weekdays);
    if (Array.isArray(days) && days.length > 0) {
      const firstDay = days[0];
      return WEEKDAY_COLORS[firstDay as keyof typeof WEEKDAY_COLORS] || '#6b7280'; // Cinza padrão
    }
  } catch (e) {
    console.error('Error parsing weekdays:', e);
  }
  return '#6b7280'; // Cinza padrão
}

// Função para obter o nome formatado do dia
function getWeekdayName(weekdays: string): string {
  try {
    const days = JSON.parse(weekdays);
    if (Array.isArray(days) && days.length > 0) {
      const firstDay = days[0];
      return WEEKDAY_NAMES[firstDay as keyof typeof WEEKDAY_NAMES] || firstDay;
    }
  } catch (e) {
    console.error('Error parsing weekdays:', e);
  }
  return 'N/A';
}

// Criar ícone customizado do Leaflet
function createCustomIcon(color: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 32px;
        height: 32px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        border: 3px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      ">
        <div style="
          width: 10px;
          height: 10px;
          background-color: white;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "></div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  });
}

export default function ClientsMap() {
  // Query para buscar todos os clientes ativos
  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ['/api/customers'],
    queryFn: () => apiRequest('GET', '/api/customers'),
  });

  // Filtrar apenas clientes ativos com coordenadas válidas
  const activeCustomersWithCoords = customers.filter(
    (customer) =>
      customer.isActive &&
      customer.latitude &&
      customer.longitude &&
      Number(customer.latitude) !== 0 &&
      Number(customer.longitude) !== 0
  );

  // Agrupar clientes por dia da semana
  const customersByDay = {
    Segunda: activeCustomersWithCoords.filter(c => getWeekdayName(c.weekdays) === 'Segunda'),
    Terça: activeCustomersWithCoords.filter(c => getWeekdayName(c.weekdays) === 'Terça'),
    Quarta: activeCustomersWithCoords.filter(c => getWeekdayName(c.weekdays) === 'Quarta'),
    Quinta: activeCustomersWithCoords.filter(c => getWeekdayName(c.weekdays) === 'Quinta'),
    Sexta: activeCustomersWithCoords.filter(c => getWeekdayName(c.weekdays) === 'Sexta'),
  };

  // Centro do mapa (São Paulo como padrão, ou centro dos clientes)
  const defaultCenter: [number, number] = [-23.55052, -46.633308];
  const mapCenter: [number, number] =
    activeCustomersWithCoords.length > 0
      ? [
          Number(activeCustomersWithCoords[0].latitude),
          Number(activeCustomersWithCoords[0].longitude),
        ]
      : defaultCenter;

  return (
    <div className="space-y-6" data-testid="clients-map-page">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-6 w-6 text-blue-600" />
            Mapa de Clientes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              <span>
                {activeCustomersWithCoords.length} clientes ativos mapeados
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Legenda */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Legenda - Dias de Visita</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Badge
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ backgroundColor: '#22c55e', color: 'white' }}
            >
              <div className="w-3 h-3 rounded-full bg-white"></div>
              Segunda ({customersByDay.Segunda.length})
            </Badge>
            <Badge
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ backgroundColor: '#3b82f6', color: 'white' }}
            >
              <div className="w-3 h-3 rounded-full bg-white"></div>
              Terça ({customersByDay.Terça.length})
            </Badge>
            <Badge
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ backgroundColor: '#eab308', color: 'white' }}
            >
              <div className="w-3 h-3 rounded-full bg-white"></div>
              Quarta ({customersByDay.Quarta.length})
            </Badge>
            <Badge
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ backgroundColor: '#ef4444', color: 'white' }}
            >
              <div className="w-3 h-3 rounded-full bg-white"></div>
              Quinta ({customersByDay.Quinta.length})
            </Badge>
            <Badge
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ backgroundColor: '#a855f7', color: 'white' }}
            >
              <div className="w-3 h-3 rounded-full bg-white"></div>
              Sexta ({customersByDay.Sexta.length})
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Mapa */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-[600px] flex items-center justify-center">
              <p className="text-muted-foreground">Carregando mapa...</p>
            </div>
          ) : activeCustomersWithCoords.length > 0 ? (
            <MapContainer
              center={mapCenter}
              zoom={12}
              style={{ height: '600px', width: '100%' }}
              data-testid="map-container"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {activeCustomersWithCoords.map((customer) => {
                const lat = Number(customer.latitude);
                const lng = Number(customer.longitude);
                const color = getPinColor(customer.weekdays);
                const dayName = getWeekdayName(customer.weekdays);

                return (
                  <Marker
                    key={customer.id}
                    position={[lat, lng]}
                    icon={createCustomIcon(color)}
                  >
                    <Popup>
                      <div className="space-y-2 min-w-[200px]">
                        <h3 className="font-bold text-base">
                          {customer.fantasyName || customer.name}
                        </h3>
                        <div className="space-y-1 text-sm">
                          <p className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {customer.address}
                          </p>
                          <p className="font-medium">
                            📅 Dia de Visita: <span style={{ color }}>{dayName}</span>
                          </p>
                          <p>📞 {customer.phone}</p>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          ) : (
            <div className="h-[600px] flex items-center justify-center">
              <div className="text-center space-y-2">
                <MapPin className="h-12 w-12 mx-auto text-gray-300" />
                <p className="text-muted-foreground">
                  Nenhum cliente ativo com coordenadas disponíveis
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
