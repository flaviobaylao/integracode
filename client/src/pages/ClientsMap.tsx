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
import { MultiSelect, multiMatch } from "@/lib/tableTools";

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

// Situações do mapa (múltipla escolha). Cada uma vem de uma consulta própria do
// /api/customers/map-data e pode aparecer no mapa junto com as outras.
const SITUACOES: Array<{ label: string; param: string; sit: string; color: string }> = [
  { label: 'Ativos',     param: 'ativos',     sit: 'ativo',     color: '#16a34a' },
  { label: 'Inativados', param: 'inativados', sit: 'inativado', color: '#9ca3af' },
  { label: 'Perdidos',   param: 'perdidos',   sit: 'perdido',   color: '#4b5563' },
  { label: 'Leads',      param: 'leads',      sit: 'lead',      color: '#eda100' },
];
const SITUACAO_OPTIONS = SITUACOES.map((x) => x.label);
const DIAS_OPTIONS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
const PERIODICIDADE_OPTIONS = ['Semanal', 'Quinzenal', 'Mensal'];

// Cor do pin por situação: inativado = cinza, perdido = cinza escuro, lead = âmbar; ativo = cor do dia.
const SITUACAO_COLORS: Record<string, string> = { inativado: '#9ca3af', perdido: '#4b5563', lead: '#eda100' };
function pinColorFor(c: any): string {
  const s = c?.situacao;
  if (s && SITUACAO_COLORS[s]) return SITUACAO_COLORS[s];
  return getPinColor(c?.weekdays || '');
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
  // Filtros de múltipla escolha (vazio = todos, padrão do MultiSelect do sistema).
  const [dias, setDias] = useState<string[]>([]);
  const [sellers, setSellers] = useState<string[]>([]);
  const [situacoes, setSituacoes] = useState<string[]>(["Ativos"]);
  const [periodicidades, setPeriodicidades] = useState<string[]>([]);

  const isVendedor = user?.role === 'vendedor';
  const isTelemarketing = user?.role === 'telemarketing';
  const canAccess = user && ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'].includes(user.role);
  const canEditCustomer = user && ['admin', 'coordinator', 'administrative'].includes(user.role);

  // Uma consulta por situação: só busca a situação marcada (vazio = todas).
  const situacaoOn = (label: string) => situacoes.length === 0 || situacoes.includes(label);
  const qAtivos = useQuery<Customer[]>({
    queryKey: ['/api/customers/map-data', 'ativos'],
    queryFn: () => apiRequest('GET', '/api/customers/map-data?situacao=ativos'),
    enabled: !!canAccess && situacaoOn('Ativos'),
    refetchInterval: 60000,
  });
  const qInativados = useQuery<Customer[]>({
    queryKey: ['/api/customers/map-data', 'inativados'],
    queryFn: () => apiRequest('GET', '/api/customers/map-data?situacao=inativados'),
    enabled: !!canAccess && situacaoOn('Inativados'),
    refetchInterval: 60000,
  });
  const qPerdidos = useQuery<Customer[]>({
    queryKey: ['/api/customers/map-data', 'perdidos'],
    queryFn: () => apiRequest('GET', '/api/customers/map-data?situacao=perdidos'),
    enabled: !!canAccess && situacaoOn('Perdidos'),
    refetchInterval: 60000,
  });
  const qLeads = useQuery<Customer[]>({
    queryKey: ['/api/customers/map-data', 'leads'],
    queryFn: () => apiRequest('GET', '/api/customers/map-data?situacao=leads'),
    enabled: !!canAccess && situacaoOn('Leads'),
    refetchInterval: 60000,
  });
  const queryPorSituacao: Record<string, any> = {
    Ativos: qAtivos, Inativados: qInativados, Perdidos: qPerdidos, Leads: qLeads,
  };
  const isLoading = SITUACAO_OPTIONS.some((l) => situacaoOn(l) && queryPorSituacao[l].isLoading);
  // Junta as situações selecionadas num conjunto só de pontos.
  const customers: Customer[] = SITUACAO_OPTIONS.flatMap((l) =>
    situacaoOn(l) && Array.isArray(queryPorSituacao[l].data) ? (queryPorSituacao[l].data as Customer[]) : []
  );

  const { data: usersForType } = useQuery<any[]>({
    queryKey: ['/api/users'],
    queryFn: () => apiRequest('GET', '/api/users'),
    enabled: !!canAccess,
  });

  // Clientes com coordenadas válidas (o backend já devolve o conjunto certo por situação).
  let activeCustomersWithCoords = customers.filter(
    (customer) =>
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
        (searchTerm.replace(/\D/g, '').length > 0 && (c.phone || '').includes(searchTerm.replace(/\D/g, '')))
    );
  }

  // Aplicar filtro de vendedor (múltipla escolha; vazio = todos)
  if (sellers.length > 0) {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => multiMatch(sellers, (c as any).sellerName || '')
    );
  }

  // Aplicar filtro de periodicidade de visita (múltipla escolha; vazio = todas)
  if (periodicidades.length > 0) {
    const alvo = periodicidades.map((p) => p.toLowerCase());
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => alvo.includes(String((c as any).visitPeriodicity || '').toLowerCase())
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
          .filter((c) => c.latitude && c.longitude && Number(c.latitude) !== 0 && Number(c.longitude) !== 0 && (c as any).sellerName)
          .map((c) => (c as any).sellerName)
      )
    ) as string[],
    sellerTypeByName,
  );

  // Agrupar por dia da semana (ANTES do filtro de dia, para a legenda). Conta só os ATIVOS,
  // que são os pintados por dia — as demais situações têm cor própria.
  const ativosParaLegenda = activeCustomersWithCoords.filter(
    (c) => ((c as any).situacao || 'ativo') === 'ativo'
  );
  const customersByDay = {
    Segunda: ativosParaLegenda.filter((c) => getWeekdayName(c.weekdays) === 'Segunda'),
    Terça: ativosParaLegenda.filter((c) => getWeekdayName(c.weekdays) === 'Terça'),
    Quarta: ativosParaLegenda.filter((c) => getWeekdayName(c.weekdays) === 'Quarta'),
    Quinta: ativosParaLegenda.filter((c) => getWeekdayName(c.weekdays) === 'Quinta'),
    Sexta: ativosParaLegenda.filter((c) => getWeekdayName(c.weekdays) === 'Sexta'),
  };

  // Aplicar filtro de dia da semana (múltipla escolha; vazio = todos)
  if (dias.length > 0) {
    activeCustomersWithCoords = activeCustomersWithCoords.filter(
      (c) => dias.includes(getWeekdayName(c.weekdays))
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
              <span data-testid="text-map-count">
                {activeCustomersWithCoords.length} pontos mapeados
                {situacoes.length > 0 ? ` (${situacoes.join(', ')})` : ' (todas as situações)'}
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
            <div className="pt-[21px]">
              <MultiSelect
                label="Situação"
                options={SITUACAO_OPTIONS}
                selected={situacoes}
                onChange={setSituacoes}
                testId="select-situacao-map"
              />
            </div>
            {!isVendedor && (
              <div className="pt-[21px]">
                <MultiSelect
                  label="Vendedor"
                  options={uniqueSellers}
                  selected={sellers}
                  onChange={setSellers}
                  testId="select-seller-map"
                />
              </div>
            )}
            <div className="pt-[21px]">
              <MultiSelect
                label="Dia da Semana"
                options={DIAS_OPTIONS}
                selected={dias}
                onChange={setDias}
                testId="select-day-map"
              />
            </div>
            <div className="pt-[21px]">
              <MultiSelect
                label="Periodicidade"
                options={PERIODICIDADE_OPTIONS}
                selected={periodicidades}
                onChange={setPeriodicidades}
                testId="select-periodicity-map"
              />
            </div>
            {(searchTerm || dias.length > 0 || sellers.length > 0 || periodicidades.length > 0 ||
              situacoes.length !== 1 || situacoes[0] !== "Ativos") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchTerm("");
                  setDias([]);
                  setSellers([]);
                  setPeriodicidades([]);
                  setSituacoes(["Ativos"]);
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
          <CardTitle className="text-base">Legenda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Situações visíveis (uma cor por situação; ativos são coloridos pelo dia) */}
          <div className="flex flex-wrap gap-3 items-center">
            {SITUACOES.filter((x) => situacaoOn(x.label)).map((x) => (
              <Badge
                key={x.param}
                className="flex items-center gap-2 px-3 py-1.5"
                style={{ backgroundColor: x.color, color: 'white' }}
              >
                <div className="w-3 h-3 rounded-full bg-white"></div>
                {x.label} ({activeCustomersWithCoords.filter((c) => ((c as any).situacao || 'ativo') === x.sit).length})
              </Badge>
            ))}
          </div>
          {/* Dias de visita: vale para os clientes ATIVOS, que são pintados pelo dia */}
          {situacaoOn('Ativos') && (
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Clientes ativos são pintados pelo dia de visita:
              </p>
              <div className="flex flex-wrap gap-3">
                <Badge className="flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: '#22c55e', color: 'white' }}>
                  <div className="w-3 h-3 rounded-full bg-white"></div>
                  Segunda ({customersByDay.Segunda.length})
                </Badge>
                <Badge className="flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: '#3b82f6', color: 'white' }}>
                  <div className="w-3 h-3 rounded-full bg-white"></div>
                  Terça ({customersByDay.Terça.length})
                </Badge>
                <Badge className="flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: '#eab308', color: 'white' }}>
                  <div className="w-3 h-3 rounded-full bg-white"></div>
                  Quarta ({customersByDay.Quarta.length})
                </Badge>
                <Badge className="flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: '#ef4444', color: 'white' }}>
                  <div className="w-3 h-3 rounded-full bg-white"></div>
                  Quinta ({customersByDay.Quinta.length})
                </Badge>
                <Badge className="flex items-center gap-2 px-3 py-1.5" style={{ backgroundColor: '#a855f7', color: 'white' }}>
                  <div className="w-3 h-3 rounded-full bg-white"></div>
                  Sexta ({customersByDay.Sexta.length})
                </Badge>
              </div>
            </div>
          )}
          {situacaoOn('Leads') && (
            <p className="text-xs text-muted-foreground">
              Em Leads, o dia é o do próximo contato programado.
            </p>
          )}
          {situacaoOn('Perdidos') && (
            <p className="text-xs text-muted-foreground">
              Perdidos: cadastro ativo, mas há 3+ meses sem comprar (comprava com regularidade).
            </p>
          )}
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
                const color = pinColorFor(customer);
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
                          {(customer as any).visitPeriodicity && (
                            <p className="font-medium">
                              🔁 Periodicidade: {String((customer as any).visitPeriodicity).charAt(0).toUpperCase() + String((customer as any).visitPeriodicity).slice(1)}
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
                  Nenhum ponto com coordenadas para os filtros selecionados
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
