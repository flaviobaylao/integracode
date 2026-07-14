import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Users, Pencil, AlertCircle, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import CustomerEditModal from "@/components/CustomerEditModal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import GeocodeAllButton from "@/components/GeocodeAllButton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import type { Customer } from "@shared/schema";
import OmieInstanceBadge from "@/components/OmieInstanceBadge";
import { sortSellerNamesByType } from "@/lib/sellerOrder";

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
    // Parse weekdays: pode ser "Seg", "Ter, Qua" ou vazio
    const days = weekdays.split(',').map(d => d.trim()).filter(Boolean);
    if (days.length > 0) {
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
    // Parse weekdays: pode ser "Seg", "Ter, Qua" ou vazio
    const days = weekdays.split(',').map(d => d.trim()).filter(Boolean);
    if (days.length > 0) {
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
  const { user } = useAuth();
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedDay, setSelectedDay] = useState<string>("all");
  const [selectedSeller, setSelectedSeller] = useState<string>("all");

  const isVendedor = user?.role === 'vendedor';
  const isTelemarketing = user?.role === 'telemarketing';
  const canAccess = user && ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'].includes(user.role);
  const canEditCustomer = user && ['admin', 'coordinator', 'administrative'].includes(user.role);

  // Query para buscar clientes mapeados (sincroniza Clientes Ativos com coordenadas)
  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ['/api/customers/map-data'],
    queryFn: () => apiRequest('GET', '/api/customers/map-data'),
    enabled: !!canAccess,
    refetchInterval: 30000,
  });

  const { data: usersForType } = useQuery<any[]>({
    queryKey: ['/api/users'],
    queryFn: () => apiRequest('GET', '/api/users'),
    enabled: !!canAccess,
  });

  // Filtrar apenas clientes ativos com coordenadas válidas
  let activeCustomersWithCoords = customers.filter(
    (customer) =>
      customer.isActive &&
      customer.latitude &&
      customer.longitude &&
      Number(customer.latitude) !== 0 &&
      Number(customer.longitude) !== 0
  );

  // Vendedores veem apenas seus próprios clientes
  if (isVendedor && user) {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => c.sellerId === user.id
    );
  }

  // Aplicar filtro de busca por nome/telefone
  if (searchTerm.trim()) {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) =>
        (c.fantasyName || c.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (c.phone || '').includes(searchTerm.replace(/\D/g, ''))
    );
  }

  // Aplicar filtro de vendedor
  if (selectedSeller && selectedSeller !== "all") {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => (c as any).sellerName === selectedSeller
    );
  }

  // Extrair vendedores únicos, ordenados por tipo (CLT, PJ, Telemarketing, Canal)
  const sellerTypeByName: Record<string, string> = {};
  for (const u of (Array.isArray(usersForType) ? usersForType : [])) {
    const n = `${u.firstName || ''} ${u.lastName || ''}`.trim();
    if (n && !(n in sellerTypeByName)) sellerTypeByName[n] = u.sellerType || (u.role === 'telemarketing' ? 'telemarketing' : '');
  }
  const uniqueSellers = sortSellerNamesByType(
    Array.from(
      new Set(
        customers
          .filter((c) => c.isActive && c.latitude && c.longitude && Number(c.latitude) !== 0 && Number(c.longitude) !== 0 && (c as any).sellerName)
          .map((c) => (c as any).sellerName)
      )
    ) as string[],
    sellerTypeByName,
  );

  // Agrupar clientes por dia da semana (ANTES de aplicar filtro de dia, para atualizar a legenda)
  const customersByDay = {
    Segunda: activeCustomersWithCoords.filter((c) => getWeekdayName(c.weekdays) === 'Segunda'),
    Terça: activeCustomersWithCoords.filter((c) => getWeekdayName(c.weekdays) === 'Terça'),
    Quarta: activeCustomersWithCoords.filter((c) => getWeekdayName(c.weekdays) === 'Quarta'),
    Quinta: activeCustomersWithCoords.filter((c) => getWeekdayName(c.weekdays) === 'Quinta'),
    Sexta: activeCustomersWithCoords.filter((c) => getWeekdayName(c.weekdays) === 'Sexta'),
  };

  // Aplicar filtro de dia da semana
  if (selectedDay && selectedDay !== "all") {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => getWeekdayName(c.weekdays) === selectedDay
    );
  }

  // Centro do mapa (São Paulo como padrão, ou centro dos clientes)
  const defaultCenter: [number, number] = [-23.55052, -46.633308];
  const mapCenter: [number, number] =
    activeCustomersWithCoords.length > 0
      ? [
          Number(activeCustomersWithCoords[0].latitude),
          Number(activeCustomersWithCoords[0].longitude),
        ]
      : defaultCenter;

  const handleEditCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsEditModalOpen(true);
  };

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false);
    setSelectedCustomer(null);
  };

  // Verificar acesso
  if (!canAccess) {
    return (
      <div className="space-y-6" data-testid="clients-map-page">
        <Card>
          <CardContent className="p-6">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Você não tem permissão para acessar o Mapa de Clientes. Esta página é restrita a usuários administrativos.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="clients-map-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Mapa de Clientes</h2>
        <div className="flex items-center gap-2">
          <GeocodeAllButton />
          <BackToDashboardButton />
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-6 w-6 text-blue-600" />
            Localização dos Clientes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              <span>
                {activeCustomersWithCoords.length} clientes ativos mapeados
              </span>
            </div>
          </div>
          
          {/* Filtros */}
          <div className="flex gap-4 flex-wrap items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-2 block">Buscar Cliente</label>
              <Input
                placeholder="Nome ou telefone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                data-testid="input-search-customers"
              />
            </div>
            {!isVendedor && (
              <div className="flex-1 min-w-[150px]">
                <label className="text-sm font-medium mb-2 block">Vendedor</label>
                <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                  <SelectTrigger data-testid="select-seller-map">
                    <SelectValue placeholder="Todos os vendedores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {uniqueSellers.map((seller) => (
                      <SelectItem key={seller} value={seller}>
                        {seller}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex-1 min-w-[150px]">
              <label className="text-sm font-medium mb-2 block">Dia da Semana</label>
              <Select value={selectedDay} onValueChange={setSelectedDay}>
                <SelectTrigger data-testid="select-day-map">
                  <SelectValue placeholder="Todos os dias" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os dias</SelectItem>
                  <SelectItem value="Segunda">Segunda</SelectItem>
                  <SelectItem value="Terça">Terça</SelectItem>
                  <SelectItem value="Quarta">Quarta</SelectItem>
                  <SelectItem value="Quinta">Quinta</SelectItem>
                  <SelectItem value="Sexta">Sexta</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(searchTerm || (selectedDay && selectedDay !== "all") || (selectedSeller && selectedSeller !== "all")) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchTerm("");
                  setSelectedDay("all");
                  setSelectedSeller("all");
                }}
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4 mr-1" />
                Limpar Filtros
              </Button>
            )}
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
            <div className="h-[calc(100vh-320px)] min-h-[600px] flex items-center justify-center">
              <p className="text-muted-foreground">Carregando mapa...</p>
            </div>
          ) : activeCustomersWithCoords.length > 0 ? (
            <MapContainer
              center={mapCenter}
              zoom={12}
              style={{ height: 'calc(100vh - 320px)', minHeight: '600px', width: '100%' }}
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
                      <div className="space-y-3 min-w-[220px]">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-base">
                            {customer.fantasyName || customer.name}
                          </h3>
                          <OmieInstanceBadge instanceId={(customer as any).omieInstanceId} />
                        </div>
                        <div className="space-y-1 text-sm">
                          <p className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {customer.address}
                          </p>
                          <p className="font-medium">
                            📅 Dia de Visita: <span style={{ color }}>{dayName}</span>
                          </p>
                          <p>📞 {customer.phone}</p>
                          {(customer as any).sellerName && (
                            <p className="font-medium">
                              👤 Vendedor: {(customer as any).sellerName}
                            </p>
                          )}
                        </div>
                        {canEditCustomer && (
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={() => handleEditCustomer(customer)}
                            data-testid={`button-edit-customer-${customer.id}`}
                          >
                            <Pencil className="h-3 w-3 mr-2" />
                            Editar Cliente
                          </Button>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          ) : (
            <div className="h-[calc(100vh-320px)] min-h-[600px] flex items-center justify-center">
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

      {/* Modal de Edição de Cliente */}
      <CustomerEditModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        customer={selectedCustomer}
      />
    </div>
  );
}
