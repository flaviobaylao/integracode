import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar, MapPin, Clock, User, Filter, Route, RefreshCw } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface VisitAgenda {
  id: string;
  customerId: string;
  sellerId: string;
  scheduledDate: string;
  routeDay: string;
  recurrenceType: string;
  isVirtual: boolean;
  visitStatus: string;
  customerName: string;
  customerLatitude: string | null;
  customerLongitude: string | null;
  customerAddress: string | null;
  actualCheckIn: string | null;
  actualCheckOut: string | null;
  distanceToCustomer: string | null;
  salesCardId: string | null;
  createdAt: string;
}

interface VisitResponse {
  visits: VisitAgenda[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export default function VisitRoutes() {
  const { user } = useAuth();
  const [filters, setFilters] = useState({
    sellerId: 'all',
    startDate: '',
    endDate: '',
    routeDay: 'all',
    visitStatus: 'pending',
    page: 1
  });

  const { data: visits, isLoading, refetch } = useQuery<VisitResponse>({
    queryKey: ['/api/visit-agenda', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value && value !== 'all') params.append(key, value.toString());
      });
      return await apiRequest(`/api/visit-agenda?${params.toString()}`);
    }
  });

  const { data: sellers } = useQuery({
    queryKey: ['/api/users', { role: 'vendedor' }],
    queryFn: async () => await apiRequest('/api/users?role=vendedor'),
    enabled: user?.role !== 'vendedor'
  });

  const generateAgenda = async () => {
    try {
      await apiRequest('/api/visit-agenda/generate', {
        method: 'POST'
      });
      refetch();
    } catch (error) {
      console.error('Erro ao gerar agenda:', error);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap = {
      'pending': { label: 'Pendente', variant: 'default' as const },
      'completed': { label: 'Concluída', variant: 'secondary' as const },
      'missed': { label: 'Perdida', variant: 'destructive' as const },
      'cancelled': { label: 'Cancelada', variant: 'outline' as const }
    };
    
    const statusInfo = statusMap[status as keyof typeof statusMap] || statusMap.pending;
    return <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>;
  };

  const getRecurrenceLabel = (type: string) => {
    const labels = {
      'semanal': 'Semanal',
      'quinzenal': 'Quinzenal', 
      'mensal': 'Mensal',
      'bimestral': 'Bimestral'
    };
    return labels[type as keyof typeof labels] || type;
  };

  const formatDate = (dateStr: string) => {
    return format(new Date(dateStr), "dd/MM/yyyy", { locale: ptBR });
  };

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return format(new Date(dateStr), "HH:mm", { locale: ptBR });
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
            <Route className="mr-2" />
            Rota de Visitas
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Gerencie e visualize a agenda de visitas {user?.role === 'vendedor' ? 'suas' : 'dos vendedores'}
          </p>
        </div>
        {user?.role && ['admin', 'coordinator'].includes(user.role) && (
          <Button
            onClick={generateAgenda}
            className="bg-honest-blue hover:bg-blue-700"
            data-testid="button-generate-agenda"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Gerar Agenda
          </Button>
        )}
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Filter className="mr-2 h-4 w-4" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {user?.role !== 'vendedor' && (
              <div>
                <label className="text-sm font-medium mb-1 block">Vendedor</label>
                <Select
                  value={filters.sellerId}
                  onValueChange={(value) => setFilters(prev => ({ ...prev, sellerId: value }))}
                >
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Todos os vendedores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {sellers?.map((seller: any) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.firstName} {seller.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <label className="text-sm font-medium mb-1 block">Data Inicial</label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))}
                data-testid="input-start-date"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Data Final</label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))}
                data-testid="input-end-date"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Dia da Semana</label>
              <Select
                value={filters.routeDay}
                onValueChange={(value) => setFilters(prev => ({ ...prev, routeDay: value }))}
              >
                <SelectTrigger data-testid="select-route-day">
                  <SelectValue placeholder="Todos os dias" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os dias</SelectItem>
                  <SelectItem value="segunda">Segunda-feira</SelectItem>
                  <SelectItem value="terca">Terça-feira</SelectItem>
                  <SelectItem value="quarta">Quarta-feira</SelectItem>
                  <SelectItem value="quinta">Quinta-feira</SelectItem>
                  <SelectItem value="sexta">Sexta-feira</SelectItem>
                  <SelectItem value="sabado">Sábado</SelectItem>
                  <SelectItem value="domingo">Domingo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Status</label>
              <Select
                value={filters.visitStatus}
                onValueChange={(value) => setFilters(prev => ({ ...prev, visitStatus: value }))}
              >
                <SelectTrigger data-testid="select-visit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="completed">Concluída</SelectItem>
                  <SelectItem value="missed">Perdida</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lista de Visitas */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center">
              <Calendar className="mr-2 h-4 w-4" />
              Agenda de Visitas
            </span>
            {visits && (
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {visits.pagination.total} visita(s) encontrada(s)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue"></div>
            </div>
          ) : !visits?.visits?.length ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <Calendar className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>Nenhuma visita encontrada com os filtros aplicados</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Endereço</TableHead>
                    <TableHead>Dia</TableHead>
                    <TableHead>Recorrência</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Check-in</TableHead>
                    <TableHead>Check-out</TableHead>
                    <TableHead>Tipo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visits.visits.map((visit) => (
                    <TableRow key={visit.id} data-testid={`visit-row-${visit.id}`}>
                      <TableCell className="font-medium">
                        {formatDate(visit.scheduledDate)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center">
                          <User className="mr-2 h-4 w-4 text-gray-400" />
                          {visit.customerName}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm text-gray-600">
                          <MapPin className="mr-1 h-3 w-3" />
                          {visit.customerAddress || 'Não informado'}
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{visit.routeDay}</TableCell>
                      <TableCell>{getRecurrenceLabel(visit.recurrenceType)}</TableCell>
                      <TableCell>{getStatusBadge(visit.visitStatus)}</TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <Clock className="mr-1 h-3 w-3" />
                          {formatTime(visit.actualCheckIn)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-sm">
                          <Clock className="mr-1 h-3 w-3" />
                          {formatTime(visit.actualCheckOut)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {visit.isVirtual ? (
                          <Badge variant="outline">Virtual</Badge>
                        ) : (
                          <Badge variant="secondary">Presencial</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Paginação */}
          {visits && visits.pagination.totalPages > 1 && (
            <div className="flex justify-center mt-6 space-x-2">
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === 1}
                onClick={() => setFilters(prev => ({ ...prev, page: prev.page - 1 }))}
                data-testid="button-prev-page"
              >
                Anterior
              </Button>
              <span className="flex items-center px-4 text-sm text-gray-600 dark:text-gray-400">
                Página {visits.pagination.page} de {visits.pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === visits.pagination.totalPages}
                onClick={() => setFilters(prev => ({ ...prev, page: prev.page + 1 }))}
                data-testid="button-next-page"
              >
                Próxima
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}