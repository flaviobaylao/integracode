import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  MapPin, CheckCircle, XCircle, Camera, Clock, AlertTriangle, 
  Route, FileText, RefreshCw, Download, Home
} from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useAuth } from "@/hooks/useAuth";

interface CheckInRecord {
  origem: 'sales_card' | 'visit_agenda';
  id: string;
  seller_id: string;
  vendedor: string;
  cliente: string;
  documento_cliente: string;
  timestamp: string;
  latitude: string;
  longitude: string;
  distancia_cliente: string | null;
  foto_url: string | null;
  check_out_time: string | null;
  tem_checkpoint: boolean;
  checkpoint_id: string | null;
  checkpoint_time: string | null;
  validation_status: string | null;
  is_off_route: boolean;
  tem_rota_diaria: boolean;
  rota_id: string | null;
}

export default function CheckInAudit() {
  const { user } = useAuth();
  const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');
  
  const [selectedSeller, setSelectedSeller] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Buscar vendedores (apenas admin)
  const { data: sellersData } = useQuery<{ users: any[] }>({
    queryKey: ['/api/users'],
    enabled: isAdmin
  });

  const sellers = sellersData?.users?.filter((u: any) => u.role === 'vendedor') || [];

  // Buscar auditoria de check-ins
  const { data, isLoading, refetch } = useQuery<{ checkIns: CheckInRecord[], stats: any }>({
    queryKey: ['/api/check-ins/audit', {
      sellerId: isAdmin ? selectedSeller : user?.id,
      startDate,
      endDate
    }]
  });

  const checkIns: CheckInRecord[] = data?.checkIns || [];
  const stats = data?.stats || {
    total: 0,
    comCheckpoint: 0,
    semCheckpoint: 0,
    comRota: 0,
    semRota: 0,
    comFoto: 0,
    foraRota: 0,
    porOrigem: { salesCards: 0, visitAgenda: 0 }
  };

  const exportToCSV = () => {
    const headers = ['Data/Hora', 'Vendedor', 'Cliente', 'Documento', 'Latitude', 'Longitude', 
                     'Distância', 'Tem Foto', 'Tem Checkpoint', 'Tem Rota', 'Check-out', 'Origem'];
    const rows = checkIns.map(ci => [
      format(new Date(ci.timestamp), 'dd/MM/yyyy HH:mm:ss'),
      ci.vendedor,
      ci.cliente,
      ci.documento_cliente || '-',
      ci.latitude,
      ci.longitude,
      ci.distancia_cliente ? `${parseFloat(ci.distancia_cliente).toFixed(0)}m` : '-',
      ci.foto_url ? 'Sim' : 'Não',
      ci.tem_checkpoint ? 'Sim' : 'Não',
      ci.tem_rota_diaria ? 'Sim' : 'Não',
      ci.check_out_time ? format(new Date(ci.check_out_time), 'dd/MM/yyyy HH:mm:ss') : '-',
      ci.origem
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `auditoria_check-ins_${format(new Date(), 'yyyy-MM-dd_HH-mm')}.csv`;
    link.click();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
            <FileText className="mr-2" />
            {isAdmin ? 'Auditoria de Check-ins' : 'Meus Check-ins'}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Registro completo de todos os check-ins realizados
          </p>
        </div>
        <BackToDashboardButton />
        <div className="flex gap-2">
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            data-testid="button-refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            onClick={exportToCSV}
            variant="outline"
            size="sm"
            disabled={checkIns.length === 0}
            data-testid="button-export"
          >
            <Download className="h-4 w-4 mr-2" />
            Exportar CSV
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {isAdmin && (
              <div>
                <Label htmlFor="seller-filter">Vendedor</Label>
                <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Todos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {sellers.map((seller: any) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.firstName} {seller.lastName || ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="start-date">Data Inicial</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-start-date"
              />
            </div>
            <div>
              <Label htmlFor="end-date">Data Final</Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-end-date"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Estatísticas */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-honest-blue">{stats.total}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">Total de Check-ins</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-600">{stats.comCheckpoint}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">Com Checkpoint</div>
          </CardContent>
        </Card>
        <Card className={stats.semCheckpoint > 0 ? 'border-red-300' : ''}>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-red-600">{stats.semCheckpoint}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">SEM Checkpoint</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-purple-600">{stats.comFoto}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">Com Foto</div>
          </CardContent>
        </Card>
      </div>

      {/* Alertas de problemas */}
      {stats.semCheckpoint > 0 && (
        <Alert className="mb-6 bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-500" />
          <AlertDescription className="text-red-800 dark:text-red-200">
            <strong>ATENÇÃO:</strong> {stats.semCheckpoint} check-in(s) foram realizados mas NÃO têm checkpoint registrado!
            Isso pode indicar falha no registro de rota ou check-in fora de rota planejada.
          </AlertDescription>
        </Alert>
      )}

      {/* Lista de Check-ins */}
      <Card>
        <CardHeader>
          <CardTitle>Registros de Check-in</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">Carregando...</div>
          ) : checkIns.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              Nenhum check-in encontrado com os filtros selecionados
            </div>
          ) : (
            <div className="space-y-3">
              {checkIns.map((checkIn) => (
                <div
                  key={`${checkIn.origem}-${checkIn.id}`}
                  className={`p-4 rounded-lg border-2 ${
                    !checkIn.tem_checkpoint
                      ? 'bg-red-50 dark:bg-red-950 border-red-500'
                      : checkIn.is_off_route
                      ? 'bg-orange-50 dark:bg-orange-950 border-orange-500'
                      : 'bg-gray-50 dark:bg-gray-800 border-transparent'
                  }`}
                  data-testid={`checkin-${checkIn.id}`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-semibold text-lg text-gray-900 dark:text-white">
                          {checkIn.cliente}
                        </p>
                        {checkIn.foto_url && (
                          <Badge variant="outline" className="text-xs">
                            <Camera className="h-3 w-3 mr-1" />
                            Foto
                          </Badge>
                        )}
                        <Badge variant={checkIn.origem === 'sales_card' ? 'default' : 'secondary'} className="text-xs">
                          {checkIn.origem === 'sales_card' ? 'Card de Vendas' : 'Agenda'}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {checkIn.vendedor} • {checkIn.documento_cliente || 'Sem documento'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {checkIn.tem_checkpoint ? (
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-600" />
                      )}
                      {checkIn.tem_rota_diaria ? (
                        <Route className="h-5 w-5 text-blue-600" />
                      ) : (
                        <Route className="h-5 w-5 text-gray-400" />
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <p className="text-gray-600 dark:text-gray-400 flex items-center">
                        <Clock className="h-3 w-3 mr-1" />
                        Check-in
                      </p>
                      <p className="font-medium">
                        {format(new Date(checkIn.timestamp), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                      </p>
                    </div>
                    {checkIn.check_out_time && (
                      <div>
                        <p className="text-gray-600 dark:text-gray-400 flex items-center">
                          <Clock className="h-3 w-3 mr-1" />
                          Check-out
                        </p>
                        <p className="font-medium">
                          {format(new Date(checkIn.check_out_time), "HH:mm", { locale: ptBR })}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-gray-600 dark:text-gray-400 flex items-center">
                        <MapPin className="h-3 w-3 mr-1" />
                        Coordenadas
                      </p>
                      <p className="font-mono text-xs">
                        {parseFloat(checkIn.latitude).toFixed(6)}, {parseFloat(checkIn.longitude).toFixed(6)}
                      </p>
                    </div>
                    {checkIn.distancia_cliente && (
                      <div>
                        <p className="text-gray-600 dark:text-gray-400">Distância Cliente</p>
                        <p className="font-medium">
                          {(parseFloat(checkIn.distancia_cliente) / 1000).toFixed(2)} km
                        </p>
                      </div>
                    )}
                  </div>

                  {!checkIn.tem_checkpoint && (
                    <div className="mt-2 p-2 bg-red-100 dark:bg-red-900/30 rounded text-sm text-red-800 dark:text-red-200 flex items-center">
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      <strong>ERRO CRÍTICO:</strong> Check-in registrado mas sem checkpoint na tabela route_checkpoints
                    </div>
                  )}

                  {checkIn.is_off_route && (
                    <div className="mt-2 p-2 bg-orange-100 dark:bg-orange-900/30 rounded text-sm text-orange-800 dark:text-orange-200 flex items-center">
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      Visita fora da rota planejada • Status: {checkIn.validation_status}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
