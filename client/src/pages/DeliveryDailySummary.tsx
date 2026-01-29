import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Calendar, Truck, CheckCircle2, AlertCircle, Clock, XCircle, Image as ImageIcon, Camera, ExternalLink, FileText } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface DeliveryStop {
  id: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  stopOrder: number;
  status: string;
  checkInTime?: string;
  checkOutTime?: string;
  completedAt?: string;
  isPriority: boolean;
  photos?: string[];
  notes?: string;
}

interface RouteWithDeliveries {
  id: string;
  routeName: string;
  routeDate: string;
  driverName: string;
  driverEmail?: string;
  vehicleType: string;
  totalDeliveries: number;
  status: string;
  stops: DeliveryStop[];
}

export default function DeliveryDailySummary() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [selectedPhotoCustomer, setSelectedPhotoCustomer] = useState<string>('');

  const { data: drivers = [] } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers'],
    staleTime: 5 * 60 * 1000,
  });

  const { data: routes = [], isLoading } = useQuery<RouteWithDeliveries[]>({
    queryKey: ['/api/delivery-routes', selectedDate, selectedDriver],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedDate) params.append('routeDate', selectedDate);
      if (selectedDriver !== 'all') params.append('driverId', selectedDriver);

      const url = `/api/delivery-routes?${params.toString()}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch routes');
      return res.json();
    },
    enabled: !!selectedDate,
  });

  const allDeliveries = routes.flatMap(route => 
    (route.stops || []).map(stop => ({
      ...stop,
      routeId: route.id,
      routeName: route.routeName,
      driverName: route.driverName,
      driverEmail: route.driverEmail,
      routeStatus: route.status,
      vehicleType: route.vehicleType
    }))
  ).sort((a, b) => {
    if (a.driverName !== b.driverName) {
      return a.driverName.localeCompare(b.driverName);
    }
    return a.stopOrder - b.stopOrder;
  });

  const filteredDeliveries = allDeliveries.filter(delivery => {
    if (selectedStatus === 'all') return true;
    if (selectedStatus === 'pendente') return delivery.status === 'pendente' || delivery.status === 'pending';
    return delivery.status === selectedStatus;
  });

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      pendente: 'PENDENTE',
      pending: 'PENDENTE',
      efetuada: 'EFETUADA',
      em_pausa: 'EM PAUSA',
      devolvida: 'DEVOLVIDA',
    };
    return labels[status] || status.toUpperCase();
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      pendente: 'bg-blue-100 text-blue-800',
      pending: 'bg-blue-100 text-blue-800',
      efetuada: 'bg-green-100 text-green-800',
      em_pausa: 'bg-yellow-100 text-yellow-800',
      devolvida: 'bg-red-100 text-red-800',
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'efetuada':
        return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case 'em_pausa':
        return <Clock className="h-4 w-4 text-yellow-600" />;
      case 'devolvida':
        return <XCircle className="h-4 w-4 text-red-600" />;
      default:
        return <AlertCircle className="h-4 w-4 text-blue-400" />;
    }
  };

  const formatNotes = (notes: string | undefined) => {
    if (!notes) return null;
    if (notes.includes('[DEVOLUÇÃO')) {
      return notes.split('] ').pop();
    }
    return notes;
  };

  const totalPendente = allDeliveries.filter(d => d.status === 'pendente' || d.status === 'pending').length;
  const totalEfetuada = allDeliveries.filter(d => d.status === 'efetuada').length;
  const totalDevolvida = allDeliveries.filter(d => d.status === 'devolvida').length;

  const activeDrivers = drivers.filter(d => d.isActive);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Resumo de Entregas do Dia</h1>
          <p className="text-muted-foreground">Visualize todas as entregas com fotos e status</p>
        </div>
        <BackToDashboardButton />
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Calendar className="h-5 w-5 mr-2" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Data</Label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                data-testid="input-delivery-summary-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Entregador</Label>
              <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                <SelectTrigger data-testid="select-delivery-driver">
                  <SelectValue placeholder="Selecione um entregador" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os entregadores</SelectItem>
                  {activeDrivers.map((driver) => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Filtrar por status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="pendente">Pendente</SelectItem>
                  <SelectItem value="efetuada">Efetuada</SelectItem>
                  <SelectItem value="devolvida">Devolvida</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resumo */}
      {!isLoading && allDeliveries.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-gradient-to-br from-blue-50 to-blue-100">
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-blue-700">{allDeliveries.length}</p>
              <p className="text-sm text-blue-600">Total</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-gray-50 to-gray-100">
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-gray-700">{totalPendente}</p>
              <p className="text-sm text-gray-600">Pendentes</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-green-50 to-green-100">
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-green-700">{totalEfetuada}</p>
              <p className="text-sm text-green-600">Efetuadas</p>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-red-50 to-red-100">
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-red-700">{totalDevolvida}</p>
              <p className="text-sm text-red-600">Devolvidas</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Carregando entregas...
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && allDeliveries.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Truck className="h-12 w-12 mx-auto mb-4 text-gray-400" />
            <p className="text-lg font-medium">Nenhuma entrega encontrada</p>
            <p className="text-sm">Selecione outra data ou filtros diferentes</p>
          </CardContent>
        </Card>
      )}

      {/* Tabela de Entregas */}
      {!isLoading && filteredDeliveries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Lista de Entregas
              <Badge variant="secondary">{filteredDeliveries.length} entregas</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">#</TableHead>
                    <TableHead>Motorista</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Endereço</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-center">Horários</TableHead>
                    <TableHead className="text-center">Fotos</TableHead>
                    <TableHead>Observações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDeliveries.map((delivery) => (
                    <TableRow 
                      key={delivery.id}
                      className={
                        delivery.status === 'devolvida' ? 'bg-red-50' :
                        delivery.status === 'efetuada' ? 'bg-green-50' : ''
                      }
                    >
                      <TableCell>
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold">
                          {delivery.stopOrder}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-gray-500" />
                          <span className="font-medium">{delivery.driverName}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{delivery.customerName}</span>
                        {delivery.isPriority && (
                          <Badge variant="destructive" className="ml-2 text-xs">Urgente</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate" title={delivery.customerAddress}>
                        {delivery.customerAddress}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {getStatusIcon(delivery.status)}
                          <Badge className={getStatusColor(delivery.status)}>
                            {getStatusLabel(delivery.status)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {delivery.checkInTime && (
                          <div className="text-gray-600">
                            <span className="font-medium">In:</span> {new Date(delivery.checkInTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                        {delivery.checkOutTime && (
                          <div className="text-gray-600">
                            <span className="font-medium">Out:</span> {new Date(delivery.checkOutTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                        {delivery.completedAt && !delivery.checkOutTime && (
                          <div className="text-green-600">
                            <span className="font-medium">Fim:</span> {new Date(delivery.completedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {delivery.photos && delivery.photos.length > 0 ? (
                          <div className="flex items-center justify-center gap-1">
                            {delivery.photos.slice(0, 3).map((photo, idx) => (
                              <button
                                key={idx}
                                onClick={() => {
                                  setSelectedPhoto(photo);
                                  setSelectedPhotoCustomer(delivery.customerName);
                                }}
                                className="w-10 h-10 rounded border-2 border-green-400 hover:border-green-600 overflow-hidden transition-colors"
                              >
                                <img 
                                  src={photo} 
                                  alt={`Foto ${idx + 1}`}
                                  className="w-full h-full object-cover"
                                />
                              </button>
                            ))}
                            {delivery.photos.length > 3 && (
                              <Badge variant="secondary" className="text-xs">
                                +{delivery.photos.length - 3}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {delivery.notes ? (
                          <div className={`text-sm ${delivery.status === 'devolvida' ? 'text-red-700 font-medium' : 'text-gray-600'}`}>
                            {formatNotes(delivery.notes)}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal de Foto */}
      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              Foto da Entrega - {selectedPhotoCustomer}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            {selectedPhoto && (
              <img 
                src={selectedPhoto} 
                alt={`Foto da entrega - ${selectedPhotoCustomer}`}
                className="max-h-[70vh] w-auto object-contain rounded-lg"
              />
            )}
            <Button
              variant="outline"
              onClick={() => selectedPhoto && window.open(selectedPhoto, '_blank')}
              className="flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Abrir em nova aba
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
