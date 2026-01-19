import { useState } from "react";
import { useQuery, useMutation, queryClient, apiRequest } from "@/lib/queryClient";
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
  Truck, 
  MapPin,
  Clock,
  Calendar,
  Filter,
  Package,
  Image as ImageIcon,
  CheckCircle2,
  Circle,
  XCircle,
  Trash2,
  Plus,
  FileText,
  Map,
  MessageCircle,
  RefreshCw,
  Save,
  Send
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline } from "react-leaflet";
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { format, parseISO } from 'date-fns';
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

interface RouteStop {
  id: string;
  salesCardId: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerLatitude: string;
  customerLongitude: string;
  stopOrder: number;
  estimatedArrival: string;
  estimatedDeparture: string;
  estimatedServiceTime: number;
  distanceFromPrevious: string;
  isPriority: boolean;
  status: string;
  checkInTime?: string;
  checkOutTime?: string;
  photos?: string[];
  completedAt?: string;
}

interface DeliveryRoute {
  id: string;
  routeName: string;
  routeDate: string;
  driverId: string;
  driverName: string;
  vehicleType: string;
  totalDistance: string;
  totalDuration: number;
  totalDeliveries: number;
  status: string;
  startTime?: string;
  endTime?: string;
  stops: RouteStop[];
  createdAt: string;
}

interface StopForTransfer {
  id: string;
  customerName: string;
  customerAddress: string;
  driverId: string;
  driverName: string;
  routeId: string;
  stopOrder: number;
}

export default function RoutesSummary() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedDriver, setSelectedDriver] = useState<string>('all');
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [showAddOrders, setShowAddOrders] = useState(false);
  const [showAddVisits, setShowAddVisits] = useState(false);
  const [showAllRoutesMap, setShowAllRoutesMap] = useState(false);
  const [selectedStopForTransfer, setSelectedStopForTransfer] = useState<StopForTransfer | null>(null);
  const [newDriverIdForTransfer, setNewDriverIdForTransfer] = useState<string>('');
  const [newPositionForReorder, setNewPositionForReorder] = useState<string>('');
  const [removePedidoIds, setRemovePedidoIds] = useState<Set<string>>(new Set());
  const [editingRoute, setEditingRoute] = useState<string | null>(null);
  const [editDriverId, setEditDriverId] = useState<string>('');
  const [editVehicleType, setEditVehicleType] = useState<string>('');
  const { toast } = useToast();

  // Gerar cores únicas por motorista - paleta simplificada
  const colorPalette = [
    '#3b82f6', // Azul
    '#22c55e', // Verde
    '#ef4444', // Vermelho
    '#eab308', // Amarelo
    '#8b5cf6', // Roxo
    '#1f2937', // Preto
    '#f3f4f6'  // Branco (com borda escura)
  ];
  
  // Criar mapa de cores para motoristas - garante cores únicas
  const getDriverColorMap = (): Record<string, string> => {
    const uniqueDrivers = Array.from(new Set(routes.map(r => r.driverId)))
      .sort(); // Ordenar para consistência
    
    const colorMap: Record<string, string> = {};
    uniqueDrivers.forEach((driverId, index) => {
      colorMap[driverId] = colorPalette[index % colorPalette.length];
    });
    
    return colorMap;
  };
  
  const getDriverColor = (driverId: string): string => {
    const colorMap = getDriverColorMap();
    return colorMap[driverId] || colorPalette[0];
  };

  // Gerar ícone colorido para cada motorista com número da ordem
  const createColoredMarkerIcon = (color: string, stopOrder?: number) => {
    const number = stopOrder ? String(stopOrder) : '';
    return L.divIcon({
      html: `<div style="background-color: ${color}; width: 32px; height: 40px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-items: center; position: relative;"><div style="position: absolute; color: white; font-weight: bold; font-size: 10px; transform: rotate(45deg); width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">${number}</div></div>`,
      iconSize: [32, 40],
      iconAnchor: [16, 40],
      popupAnchor: [0, -40],
      className: 'leaflet-div-icon'
    });
  };

  // Buscar entregadores
  const { data: drivers = [] } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers'],
    staleTime: 5 * 60 * 1000, // Cache por 5 minutos
  });

  // Buscar rotas com filtros - inclui rotas criadas por transferência
  const { data: routes = [], isLoading } = useQuery<DeliveryRoute[]>({
    queryKey: ['/api/delivery-routes', { 
      routeDate: selectedDate, 
      driverId: selectedDriver !== 'all' ? selectedDriver : undefined
    }],
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

  // Query para pedidos aguardando rota
  const { data: orders = [] } = useQuery<any[]>({
    queryKey: ['/api/deliveries'],
    queryFn: () => apiRequest('GET', '/api/deliveries'),
  });

  // Mutation para adicionar parada à rota
  const addStopMutation = useMutation({
    mutationFn: async (data: { routeId: string; billingId: string }) => {
      return await apiRequest('POST', `/api/delivery-routes/${data.routeId}/add-stop`, { billingId: data.billingId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setShowAddOrders(false);
      setRemovePedidoIds(new Set());
      toast({
        title: "Pedido adicionado com sucesso!",
        description: "O pedido foi adicionado à rota.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao adicionar pedido",
        description: error.message || "Erro desconhecido",
        variant: "destructive",
      });
    },
  });

  // Mutation para excluir parada individual
  const deleteStopMutation = useMutation({
    mutationFn: async (stopId: string) => {
      return await apiRequest('DELETE', `/api/delivery-routes/stops/${stopId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Parada excluída",
        description: "A entrega foi removida da rota e retornará para Gestão de Rotas.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir parada",
        description: error.message || "Não foi possível excluir a parada.",
        variant: "destructive",
      });
    }
  });

  // Mutation para excluir rota completa
  const deleteRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('DELETE', `/api/delivery-routes/${routeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setSelectedRoute(null); // Fechar detalhes da rota excluída
      toast({
        title: "Rota excluída",
        description: "Todas as entregas foram removidas e retornarão para Gestão de Rotas.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir rota",
        description: error.message || "Não foi possível excluir a rota.",
        variant: "destructive",
      });
    }
  });

  // Mutation para otimizar/reorganizar ordem das paradas
  const optimizeRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('POST', `/api/delivery-routes/${routeId}/optimize`);
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Rota otimizada!",
        description: `A ordem das ${data.totalStops} paradas foi reorganizada. Nova distância: ${data.newDistance} km`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao otimizar rota",
        description: error.message || "Não foi possível otimizar a rota.",
        variant: "destructive",
      });
    }
  });

  // Mutation para transferir parada para outro motorista
  const transferStopMutation = useMutation({
    mutationFn: async (data: { stopId: string; fromRouteId: string; toDriverId: string; newPosition?: number }) => {
      console.log('🚀 [TRANSFER-FRONTEND] Iniciando transferência:', data);
      const payload = {
        toDriverId: data.toDriverId,
        newPosition: data.newPosition,
        routeDate: selectedDate,
        fromRouteId: data.fromRouteId
      };
      console.log('📤 [TRANSFER-FRONTEND] Payload enviado:', payload);
      try {
        const response = await apiRequest('PATCH', `/api/delivery-routes/stops/${data.stopId}/transfer`, payload);
        console.log('✅ [TRANSFER-FRONTEND] Resposta recebida:', response);
        return response;
      } catch (err) {
        console.error('❌ [TRANSFER-FRONTEND] Erro ao fazer requisição:', err);
        throw err;
      }
    },
    onSuccess: () => {
      console.log('✅ [TRANSFER-SUCCESS] Parada transferida com sucesso');
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setSelectedStopForTransfer(null);
      setNewDriverIdForTransfer('');
      setNewPositionForReorder('');
      toast({
        title: "Parada transferida com sucesso!",
        description: "A entrega foi movida para o novo motorista.",
      });
    },
    onError: (error: any) => {
      console.error('❌ [TRANSFER-ERROR] Erro na transferência:', error);
      toast({
        title: "Erro ao transferir parada",
        description: error.message || "Não foi possível transferir a entrega.",
        variant: "destructive",
      });
    }
  });

  // Mutation para reordenar parada dentro da mesma rota
  const reorderStopMutation = useMutation({
    mutationFn: async (data: { stopId: string; routeId: string; newPosition: number }) => {
      return await apiRequest('PATCH', `/api/delivery-routes/stops/${data.stopId}/reorder`, {
        newPosition: data.newPosition,
        routeId: data.routeId
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setSelectedStopForTransfer(null);
      setNewPositionForReorder('');
      toast({
        title: "Ordem de entrega alterada com sucesso!",
        description: "A parada foi movida para a nova posição.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao reordenar parada",
        description: error.message || "Não foi possível reordenar a entrega.",
        variant: "destructive",
      });
    }
  });

  // Mutation para atualizar rota (veículo e entregador)
  const updateRouteMutation = useMutation({
    mutationFn: async (data: { routeId: string; driverId: string; vehicleType: string; driverName: string }) => {
      return await apiRequest('PATCH', `/api/delivery-routes/${data.routeId}`, {
        driverId: data.driverId,
        driverName: data.driverName,
        vehicleType: data.vehicleType
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      setEditingRoute(null);
      toast({
        title: "Rota atualizada com sucesso!",
        description: "Veículo e entregador foram alterados.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar rota",
        description: error.message || "Não foi possível atualizar a rota.",
        variant: "destructive",
      });
    }
  });

  // Mutation para salvar rotas planejadas
  const saveRoutesMutation = useMutation({
    mutationFn: async () => {
      const plannedRoutes = routes.filter(r => r.status === 'planejada');
      if (plannedRoutes.length === 0) {
        throw new Error('Nenhuma rota planejada para salvar');
      }

      const routesToSave = plannedRoutes.map(route => ({
        route: {
          routeDate: route.routeDate,
          driverId: route.driverId,
          driverName: route.driverName,
          vehicleType: route.vehicleType,
          startLatitude: -16.719458733340122,
          startLongitude: -49.29937095026935,
          totalDistance: parseFloat(route.totalDistance),
          totalDuration: route.totalDuration,
          timeWindowStart: '08:00',
          timeWindowEnd: '18:00',
        },
        stops: route.stops.map(stop => ({
          salesCardId: stop.salesCardId,
          billingId: stop.id || '',
          customerId: stop.customerId,
          customerName: stop.customerName,
          customerAddress: stop.customerAddress,
          latitude: parseFloat(stop.customerLatitude),
          longitude: parseFloat(stop.customerLongitude),
          stopOrder: stop.stopOrder,
          isUrgent: stop.isPriority,
        }))
      }));

      return await apiRequest('POST', '/api/delivery-routes/save', { routes: routesToSave });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Rotas salvas com sucesso! ✅",
        description: `${data.routes.length} rotas foram salvas e estão prontas para execução`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao salvar rotas",
        description: error.message || "Não foi possível salvar as rotas",
        variant: "destructive",
      });
    }
  });

  // Mutation para enviar rota individual para o motorista
  const sendRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      return await apiRequest('POST', `/api/delivery-routes/${routeId}/send-to-driver`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Rota enviada com sucesso! 📤",
        description: "O motorista agora pode ver a rota no app.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao enviar rota",
        description: error.message || "Não foi possível enviar a rota",
        variant: "destructive",
      });
    }
  });

  // Mutation para enviar todas as rotas do dia para os motoristas
  const sendAllRoutesMutation = useMutation({
    mutationFn: async (date: string) => {
      return await apiRequest('POST', '/api/delivery-routes/send-all-to-drivers', { date });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-routes'] });
      toast({
        title: "Rotas enviadas com sucesso! 📤",
        description: data.message || "Todas as rotas foram enviadas aos motoristas.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao enviar rotas",
        description: error.message || "Não foi possível enviar as rotas",
        variant: "destructive",
      });
    }
  });

  const activeDrivers = drivers.filter(d => d.isActive);

  // Contar rotas pendentes de envio (status 'rota salva' ou 'pending')
  const pendingSendRoutes = routes.filter(r => r.status === 'rota salva' || r.status === 'pending');

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string; className?: string }> = {
      'pending': { variant: 'secondary', label: 'Pendente (Não Enviada)', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
      'rota salva': { variant: 'secondary', label: 'Salva (Não Enviada)', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
      'rota_enviada': { variant: 'default', label: 'Enviada', className: 'bg-blue-500 text-white' },
      planejada: { variant: 'secondary', label: 'Planejada' },
      em_andamento: { variant: 'default', label: 'Em Andamento', className: 'bg-green-500 text-white' },
      concluida: { variant: 'outline', label: 'Concluída', className: 'bg-gray-200 text-gray-700' },
      cancelada: { variant: 'destructive', label: 'Cancelada' },
    };

    const config = variants[status] || { variant: 'secondary', label: status };
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getDeliveryStatusBadge = (status: string) => {
    const variants: Record<string, { variant: any; label: string; className: string }> = {
      pendente: { variant: 'secondary', label: 'PENDENTE', className: 'bg-gray-200 text-gray-700' },
      efetuada: { variant: 'default', label: 'EFETUADA', className: 'bg-green-500 text-white' },
      em_pausa: { variant: 'outline', label: 'EM PAUSA', className: 'bg-yellow-500 text-white' },
      devolvida: { variant: 'destructive', label: 'DEVOLVIDA', className: 'bg-red-500 text-white' },
    };

    const config = variants[status] || { variant: 'secondary', label: status.toUpperCase(), className: '' };
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getStopStatusIcon = (stop: RouteStop) => {
    if (stop.status === 'efetuada' || stop.completedAt || stop.checkOutTime) {
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    }
    if (stop.status === 'em_pausa' || stop.checkInTime) {
      return <Clock className="h-5 w-5 text-blue-600 animate-pulse" />;
    }
    if (stop.status === 'devolvida') {
      return <XCircle className="h-5 w-5 text-red-600" />;
    }
    return <Circle className="h-5 w-5 text-gray-400" />;
  };

  const calculateDeliveryDuration = (checkIn?: string, checkOut?: string) => {
    if (!checkIn || !checkOut) return null;
    const duration = new Date(checkOut).getTime() - new Date(checkIn).getTime();
    return Math.round(duration / 60000); // minutos
  };

  const selectedRouteData = routes.find(r => r.id === selectedRoute);

  const generateRoutePDF = async () => {
    if (!selectedRouteData) return;
    
    try {
      // Importar jsPDF dinamicamente
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      
      // Cores
      const primaryColor = [34, 197, 94]; // green-600
      const textColor = [0, 0, 0];
      const lightGray = [242, 242, 242];
      
      // Título
      doc.setFontSize(20);
      doc.setTextColor(...primaryColor);
      doc.text('RESUMO DA ROTA DE ENTREGA', 14, 20);
      
      // Data de geração
      doc.setFontSize(10);
      doc.setTextColor(100, 100, 100);
      doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, 14, 28);
      
      // Seção 1: Informações Gerais
      doc.setFontSize(12);
      doc.setTextColor(...primaryColor);
      doc.text('INFORMAÇÕES GERAIS', 14, 38);
      
      doc.setFontSize(10);
      doc.setTextColor(...textColor);
      const infoY = 45;
      doc.text(`Rota: ${selectedRouteData.routeName}`, 14, infoY);
      doc.text(`Motorista: ${selectedRouteData.driverName}`, 14, infoY + 7);
      doc.text(`Data: ${format(parseISO(selectedRouteData.routeDate), 'dd/MM/yyyy')}`, 14, infoY + 14);
      doc.text(`Veículo: ${selectedRouteData.vehicleType === 'caminhao' ? 'Caminhão' : selectedRouteData.vehicleType === 'carro' ? 'Carro' : selectedRouteData.vehicleType === 'baruc' ? 'Baruc' : 'Moto'}`, 14, infoY + 21);
      
      // Seção 2: Métricas
      doc.setFontSize(12);
      doc.setTextColor(...primaryColor);
      doc.text('MÉTRICAS', 14, 80);
      
      doc.setFontSize(10);
      doc.setTextColor(...textColor);
      const metricsY = 87;
      doc.text(`Total de Paradas: ${selectedRouteData.totalDeliveries}`, 14, metricsY);
      doc.text(`Distância Total: ${parseFloat(selectedRouteData.totalDistance).toFixed(1)} km`, 14, metricsY + 7);
      doc.text(`Duração Estimada: ${Math.round(selectedRouteData.totalDuration)} minutos`, 14, metricsY + 14);
      doc.text(`Status: ${selectedRouteData.status.toUpperCase()}`, 14, metricsY + 21);
      
      // Seção 3: Paradas
      doc.setFontSize(12);
      doc.setTextColor(...primaryColor);
      doc.text('PARADAS DA ROTA', 14, 125);
      
      let yPosition = 132;
      const pageHeight = doc.internal.pageSize.getHeight();
      
      if (selectedRouteData.stops && selectedRouteData.stops.length > 0) {
        doc.setFontSize(9);
        
        selectedRouteData.stops.forEach((stop, index) => {
          // Verificar se precisa de nova página
          if (yPosition > pageHeight - 20) {
            doc.addPage();
            yPosition = 14;
          }
          
          doc.setTextColor(34, 197, 94);
          doc.text(`${index + 1}. ${stop.customerName}`, 14, yPosition);
          
          doc.setTextColor(...textColor);
          doc.setFontSize(8);
          doc.text(`Endereço: ${stop.customerAddress}`, 18, yPosition + 5);
          doc.text(`Ordem: ${stop.stopOrder} | Status: ${stop.status.toUpperCase()}`, 18, yPosition + 9);
          
          yPosition += 15;
        });
      }
      
      // Rodapé
      const totalPages = doc.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(
          `Página ${i} de ${totalPages}`,
          doc.internal.pageSize.getWidth() / 2,
          doc.internal.pageSize.getHeight() - 10,
          { align: 'center' }
        );
      }
      
      // Salvar PDF
      doc.save(`Rota_${selectedRouteData.routeName}_${format(parseISO(selectedRouteData.routeDate), 'dd-MM-yyyy')}.pdf`);
      
      toast({
        title: "PDF Gerado com Sucesso",
        description: `O resumo da rota foi salvo como: Rota_${selectedRouteData.routeName}.pdf`,
      });
    } catch (error) {
      console.error('Erro ao gerar PDF:', error);
      toast({
        title: "Erro ao Gerar PDF",
        description: "Não foi possível gerar o PDF da rota",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Resumo das Rotas</h1>
          <p className="text-muted-foreground">Visualize e acompanhe as rotas de entrega</p>
        </div>
        <BackToDashboardButton />
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center">
              <Filter className="h-5 w-5 mr-2" />
              Filtros
            </CardTitle>
            <div className="flex gap-2">
              {routes.filter(r => r.status === 'planejada').length > 0 && (
                <Button 
                  onClick={() => saveRoutesMutation.mutate()}
                  disabled={saveRoutesMutation.isPending}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-save-planned-routes"
                >
                  {saveRoutesMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      💾 Salvar {routes.filter(r => r.status === 'planejada').length} Rota(s)
                    </>
                  )}
                </Button>
              )}
              {pendingSendRoutes.length > 0 && (
                <Button 
                  onClick={() => sendAllRoutesMutation.mutate(selectedDate)}
                  disabled={sendAllRoutesMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-send-all-routes"
                >
                  {sendAllRoutesMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Enviando...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      📤 Enviar {pendingSendRoutes.length} Rota(s) para Motoristas
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Data</Label>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                data-testid="input-route-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Entregador</Label>
              <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                <SelectTrigger data-testid="select-driver">
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
          </div>
          {routes.length > 0 && (
            <div className="pt-4 border-t">
              <Button
                onClick={() => setShowAllRoutesMap(true)}
                className="w-full bg-blue-600 hover:bg-blue-700"
                data-testid="button-show-all-routes-map"
              >
                <Map className="h-4 w-4 mr-2" />
                🗺️ Ver Todas as Rotas no Mapa
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lista de Rotas */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            Carregando rotas...
          </CardContent>
        </Card>
      ) : routes.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            Nenhuma rota encontrada para os filtros selecionados.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {routes.map((route) => (
            <Card 
              key={route.id} 
              className={`cursor-pointer transition-all ${selectedRoute === route.id ? 'ring-2 ring-blue-500' : 'hover:shadow-md'}`}
              onClick={() => setSelectedRoute(selectedRoute === route.id ? null : route.id)}
              data-testid={`route-card-${route.id}`}
            >
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center text-base">
                    <Truck className="h-5 w-5 mr-2" />
                    {route.routeName}
                  </span>
                  {getStatusBadge(route.status)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center text-muted-foreground">
                    <Calendar className="h-4 w-4 mr-2" />
                    {format(parseISO(route.routeDate), 'dd/MM/yyyy')}
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <Truck className="h-4 w-4 mr-2" />
                    {route.driverName} • {route.vehicleType === 'caminhao' ? '🚛 Caminhão' : route.vehicleType === 'carro' ? '🚗 Carro' : route.vehicleType === 'baruc' ? '🚐 Baruc' : '🏍️ Moto'}
                  </div>
                  <div className="flex items-center text-muted-foreground">
                    <Package className="h-4 w-4 mr-2" />
                    {route.totalDeliveries} paradas • {parseFloat(route.totalDistance).toFixed(1)} km • ~{Math.round(route.totalDuration)} min
                  </div>
                  {route.startTime && (
                    <div className="flex items-center text-muted-foreground">
                      <Clock className="h-4 w-4 mr-2" />
                      Iniciada: {new Date(route.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Detalhes da Rota Selecionada */}
      {selectedRouteData && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between mb-4">
              <CardTitle>Detalhes da Rota: {selectedRouteData.routeName}</CardTitle>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingRoute(selectedRoute);
                  setEditDriverId(selectedRouteData.driverId || '');
                  setEditVehicleType(selectedRouteData.vehicleType || '');
                }}
                data-testid="button-edit-route"
              >
                ✏️ Editar Veículo/Entregador
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddOrders(true)}
                data-testid={`button-add-orders-route-${selectedRoute}`}
              >
                <Plus className="h-4 w-4 mr-2" />
                ➕ Adicionar Pedidos
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectedRouteData && optimizeRouteMutation.mutate(selectedRouteData.id)}
                disabled={optimizeRouteMutation.isPending || (selectedRouteData?.stops?.length || 0) < 2}
                data-testid="button-optimize-route"
                className="bg-blue-50 hover:bg-blue-100"
              >
                {optimizeRouteMutation.isPending ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Otimizando...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    🔄 Reorganizar Rota
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={generateRoutePDF}
                data-testid="button-generate-pdf-route"
                className="bg-green-50 hover:bg-green-100"
              >
                <FileText className="h-4 w-4 mr-2" />
                📄 Gerar PDF
              </Button>
              {(selectedRouteData.status === 'rota salva' || selectedRouteData.status === 'pending') && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    sendRouteMutation.mutate(selectedRouteData.id);
                  }}
                  disabled={sendRouteMutation.isPending}
                  data-testid="button-send-route"
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {sendRouteMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Enviando...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      📤 Enviar para Motorista
                    </>
                  )}
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="destructive" 
                    size="sm"
                    data-testid="button-delete-route"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Excluir Rota
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Excluir Rota Completa?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Tem certeza que deseja excluir esta rota? Todas as {selectedRouteData.totalDeliveries} entregas 
                      serão removidas e retornarão para a aba "Gestão de Rotas" para que possam ser incluídas em novas rotas.
                      Esta ação não pode ser desfeita.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deleteRouteMutation.mutate(selectedRouteData.id)}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Confirmar Exclusão
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button variant="outline" size="sm" onClick={() => setSelectedRoute(null)}>
                Fechar
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-4 border-b">
                <div>
                  <div className="text-sm text-muted-foreground">Paradas</div>
                  <div className="text-2xl font-bold">{selectedRouteData.totalDeliveries}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Distância</div>
                  <div className="text-2xl font-bold">{parseFloat(selectedRouteData.totalDistance).toFixed(1)} km</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Duração Est.</div>
                  <div className="text-2xl font-bold">{Math.round(selectedRouteData.totalDuration)} min</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Status</div>
                  <div className="pt-1">{getStatusBadge(selectedRouteData.status)}</div>
                </div>
              </div>

              {/* Mapa da Rota */}
              {selectedRouteData.stops && selectedRouteData.stops.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-semibold flex items-center">
                    <Map className="h-4 w-4 mr-2" />
                    Mapa da Rota
                  </h3>
                  <div className="relative rounded-lg overflow-hidden border h-96 bg-gray-50">
                    <MapContainer
                      center={[
                        parseFloat(selectedRouteData.stops[0]?.customerLatitude || '-15.8'),
                        parseFloat(selectedRouteData.stops[0]?.customerLongitude || '-48.1')
                      ]}
                      zoom={13}
                      scrollWheelZoom={true}
                      style={{ width: '100%', height: '100%' }}
                    >
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; OpenStreetMap contributors'
                      />
                      {/* Desenhar polyline da rota */}
                      {(() => {
                        const sortedStops = [...selectedRouteData.stops].sort((a, b) => a.stopOrder - b.stopOrder);
                        const polylinePoints = sortedStops
                          .map(stop => {
                            const lat = parseFloat(stop.customerLatitude);
                            const lng = parseFloat(stop.customerLongitude);
                            return isNaN(lat) || isNaN(lng) ? null : [lat, lng] as [number, number];
                          })
                          .filter(p => p !== null) as [number, number][];
                        
                        return polylinePoints.length > 1 ? (
                          <Polyline 
                            positions={polylinePoints} 
                            color="#3b82f6"
                            weight={3}
                            opacity={0.7}
                            dashArray="5, 5"
                          />
                        ) : null;
                      })()}
                      {selectedRouteData.stops.map((stop, idx) => {
                        const lat = parseFloat(stop.customerLatitude);
                        const lng = parseFloat(stop.customerLongitude);
                        
                        if (isNaN(lat) || isNaN(lng)) return null;
                        
                        return (
                          <Marker
                            key={stop.id}
                            position={[lat, lng]}
                            icon={createColoredMarkerIcon('#3b82f6', stop.stopOrder)}
                          >
                            <Popup>
                              <div className="text-xs font-medium max-w-xs">
                                <div className="font-bold">{stop.stopOrder}. {stop.customerName}</div>
                                <div className="text-gray-600 mt-1">{stop.customerAddress}</div>
                                <div className="mt-2 flex items-center">
                                  {getDeliveryStatusBadge(stop.status)}
                                </div>
                              </div>
                            </Popup>
                          </Marker>
                        );
                      })}
                    </MapContainer>
                  </div>
                </div>
              )}

              {/* Lista de Paradas */}
              <div className="space-y-3">
                <h3 className="font-semibold">Paradas da Rota</h3>
                {selectedRouteData.stops && selectedRouteData.stops.length > 0 ? (
                  selectedRouteData.stops.map((stop) => {
                  const deliveryDuration = calculateDeliveryDuration(stop.checkInTime, stop.checkOutTime);
                  
                  return (
                    
                    <Card key={stop.id} className={stop.isPriority ? 'border-red-300 bg-red-50' : ''}>
                      <CardContent className="pt-6">
                        <div className="flex items-start space-x-4">
                          <div className="flex-shrink-0">
                            {getStopStatusIcon(stop)}
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="font-semibold flex items-center">
                                  <span className="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full mr-2">
                                    #{stop.stopOrder}
                                  </span>
                                  {stop.customerName}
                                  {stop.isPriority && (
                                    <Badge variant="destructive" className="ml-2 text-xs">
                                      URGENTE
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-sm text-muted-foreground flex items-center mt-1">
                                  <MapPin className="h-3 w-3 mr-1" />
                                  {stop.customerAddress}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {getDeliveryStatusBadge(stop.status)}
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button 
                                      variant="ghost" 
                                      size="sm"
                                      className="h-8 w-8 p-0"
                                      data-testid={`button-delete-stop-${stop.id}`}
                                    >
                                      <Trash2 className="h-4 w-4 text-red-500" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Excluir Entrega da Rota?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Tem certeza que deseja remover a entrega de <strong>{stop.customerName}</strong> desta rota? 
                                        O pedido retornará para a aba "Gestão de Rotas" e poderá ser incluído em uma nova rota.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteStopMutation.mutate(stop.id);
                                        }}
                                        className="bg-red-600 hover:bg-red-700"
                                      >
                                        Confirmar Exclusão
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            </div>

                            {/* Informações de Tempo */}
                            <div className="grid grid-cols-2 gap-4 text-sm border-t pt-2">
                              <div>
                                <div className="text-muted-foreground">ETA</div>
                                <div className="font-medium">
                                  {new Date(stop.estimatedArrival).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              </div>
                              {stop.checkInTime && (
                                <div>
                                  <div className="text-muted-foreground">Check-in</div>
                                  <div className="font-medium text-blue-600">
                                    {new Date(stop.checkInTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </div>
                              )}
                              {stop.checkOutTime && (
                                <div>
                                  <div className="text-muted-foreground">Check-out</div>
                                  <div className="font-medium text-green-600">
                                    {new Date(stop.checkOutTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </div>
                              )}
                              {deliveryDuration && (
                                <div>
                                  <div className="text-muted-foreground">Tempo de Entrega</div>
                                  <div className="font-medium">{deliveryDuration} min</div>
                                </div>
                              )}
                            </div>

                            {/* Fotos */}
                            {stop.photos && stop.photos.length > 0 && (
                              <div className="border-t pt-2">
                                <div className="text-sm text-muted-foreground mb-2 flex items-center">
                                  <ImageIcon className="h-4 w-4 mr-1" />
                                  Fotos da Entrega ({stop.photos.length})
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  {stop.photos.map((photo, idx) => (
                                    <img
                                      key={idx}
                                      src={photo}
                                      alt={`Foto ${idx + 1}`}
                                      className="w-full h-24 object-cover rounded border"
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
                ) : (
                  <div className="text-center py-8">
                    <div className="text-muted-foreground mb-4">
                      Nenhuma parada cadastrada para esta rota
                    </div>
                    <Button
                      onClick={() => setShowAddVisits(true)}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                      data-testid="button-add-visits-empty-route"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Adicionar Visitas à Rota
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal para visualizar todas as rotas no mapa */}
      <Dialog open={showAllRoutesMap} onOpenChange={setShowAllRoutesMap}>
        <DialogContent className="max-w-6xl w-full max-h-[90vh] flex flex-col" data-testid="dialog-all-routes-map">
          <DialogHeader>
            <DialogTitle>Mapa de Todas as Rotas - {format(new Date(selectedDate), 'dd/MM/yyyy')}</DialogTitle>
            <DialogDescription>
              Visualize todas as entregas do dia com pins coloridos por motorista
            </DialogDescription>
          </DialogHeader>

          <div style={{ display: 'flex', height: '600px', width: '100%', position: 'relative' }}>
            {routes.length > 0 ? (
              <>
                {/* Legenda */}
                <div style={{
                  position: 'absolute',
                  top: '16px',
                  left: '16px',
                  zIndex: 50,
                  backgroundColor: 'white',
                  borderRadius: '8px',
                  boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
                  padding: '16px',
                  maxHeight: '384px',
                  overflowY: 'auto'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '12px', fontSize: '14px' }}>Motoristas:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {Array.from(new Set(routes.map(r => r.driverId))).map((driverId) => {
                      const route = routes.find(r => r.driverId === driverId);
                      const color = getDriverColor(driverId);
                      const stopCount = routes
                        .filter(r => r.driverId === driverId)
                        .reduce((acc, r) => acc + (r.stops?.length || 0), 0);
                      
                      return (
                        <div key={driverId} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                          <div
                            style={{
                              width: '16px',
                              height: '16px',
                              borderRadius: '50%',
                              border: '1px solid #d1d5db',
                              backgroundColor: color
                            }}
                          />
                          <span style={{ fontWeight: 500 }}>{route?.driverName}</span>
                          <span style={{ color: '#6b7280' }}>({stopCount})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Mapa com todos os pontos */}
                <MapContainer
                  center={[
                    -15.7942,
                    -48.2720
                  ]}
                  zoom={10}
                  scrollWheelZoom={true}
                  style={{ width: '100%', height: '100%', position: 'relative', zIndex: 1 }}
                >
                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; OpenStreetMap contributors'
                  />
                  {/* Desenhar polylines de cada rota */}
                  {routes.map((route) => {
                    const driverColor = getDriverColor(route.driverId);
                    const sortedStops = [...(route.stops || [])].sort((a, b) => a.stopOrder - b.stopOrder);
                    const polylinePoints = sortedStops
                      .map(stop => {
                        const lat = parseFloat(stop.customerLatitude);
                        const lng = parseFloat(stop.customerLongitude);
                        return isNaN(lat) || isNaN(lng) ? null : [lat, lng] as [number, number];
                      })
                      .filter(p => p !== null) as [number, number][];
                    
                    return (
                      <div key={route.id}>
                        {polylinePoints.length > 1 && (
                          <Polyline 
                            positions={polylinePoints} 
                            color={driverColor}
                            weight={3}
                            opacity={0.6}
                            dashArray="5, 5"
                          />
                        )}
                      </div>
                    );
                  })}
                  {routes.map((route) => {
                    const driverColor = getDriverColor(route.driverId);
                    
                    return route.stops?.map((stop) => {
                      const lat = parseFloat(stop.customerLatitude);
                      const lng = parseFloat(stop.customerLongitude);
                      
                      if (isNaN(lat) || isNaN(lng)) return null;
                      
                      const icon = createColoredMarkerIcon(driverColor, stop.stopOrder);
                      
                      return (
                        <Marker
                          key={stop.id}
                          position={[lat, lng]}
                          icon={icon}
                          eventHandlers={{
                            click: () => {
                              setSelectedStopForTransfer({
                                id: stop.id,
                                customerName: stop.customerName,
                                customerAddress: stop.customerAddress,
                                driverId: route.driverId,
                                driverName: route.driverName,
                                routeId: route.id,
                                stopOrder: stop.stopOrder
                              });
                              setNewDriverIdForTransfer(route.driverId);
                            }
                          }}
                        />
                      );
                    });
                  })}
                </MapContainer>
              </>
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f5f5' }}>
                <p style={{ color: '#999', fontSize: '14px' }}>Nenhuma rota cadastrada para esta data</p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => setShowAllRoutesMap(false)}>
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal para transferir parada para outro motorista */}
      <Dialog open={!!selectedStopForTransfer} onOpenChange={(open) => !open && setSelectedStopForTransfer(null)}>
        <DialogContent className="max-w-md" data-testid="dialog-transfer-stop">
          <DialogHeader>
            <DialogTitle>Trocar Motorista da Entrega</DialogTitle>
            <DialogDescription>
              Selecione o novo motorista responsável por esta entrega
            </DialogDescription>
          </DialogHeader>
          
          {selectedStopForTransfer && (
            <div className="space-y-4 py-4">
              {/* Informações da Entrega */}
              <div className="p-4 bg-gray-50 rounded-lg border">
                <div className="text-sm font-semibold mb-2">Informações da Entrega</div>
                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Parada:</span>
                    <span className="font-medium ml-2">#{selectedStopForTransfer.stopOrder}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Cliente:</span>
                    <span className="font-medium ml-2">{selectedStopForTransfer.customerName}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Endereço:</span>
                    <span className="font-medium ml-2">{selectedStopForTransfer.customerAddress}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Motorista Atual:</span>
                    <span className="font-medium ml-2">{selectedStopForTransfer.driverName}</span>
                  </div>
                </div>
              </div>

              {/* Seleção do Novo Motorista */}
              <div className="space-y-2">
                <Label>Novo Motorista</Label>
                <Select value={newDriverIdForTransfer} onValueChange={setNewDriverIdForTransfer}>
                  <SelectTrigger data-testid="select-new-driver-transfer">
                    <SelectValue placeholder="Selecione um motorista" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeDrivers.map((driver) => (
                      <SelectItem key={driver.id} value={driver.id}>
                        {driver.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Se mantém o mesmo motorista, mostrar opção de reordenar */}
              {newDriverIdForTransfer === selectedStopForTransfer.driverId && (
                <div className="space-y-2">
                  <Label>Nova Posição na Rota</Label>
                  <Select value={newPositionForReorder} onValueChange={setNewPositionForReorder}>
                    <SelectTrigger data-testid="select-new-position">
                      <SelectValue placeholder="Selecione a nova posição" />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: selectedRouteData?.totalDeliveries || 1 }, (_, i) => i + 1).map((pos) => (
                        <SelectItem key={pos} value={pos.toString()}>
                          Posição {pos}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Posição atual: #{selectedStopForTransfer.stopOrder}
                  </p>
                </div>
              )}

              {/* Botões de Ação */}
              <div className="flex gap-2 pt-4 border-t">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setSelectedStopForTransfer(null)}
                >
                  Cancelar
                </Button>
                <Button
                  className="flex-1 bg-blue-600 hover:bg-blue-700"
                  onClick={() => {
                    const newDriverId = newDriverIdForTransfer;
                    console.log('🔄 [TRANSFER-CLICK] Botão clicado - newDriverId:', newDriverId, 'currentDriver:', selectedStopForTransfer?.driverId);
                    if (!newDriverId) {
                      console.warn('⚠️ [TRANSFER-CLICK] Nenhum motorista selecionado');
                      toast({
                        title: "Selecione um motorista",
                        description: "É necessário escolher um novo motorista.",
                      });
                      return;
                    }

                    // Se mudando de motorista
                    if (newDriverId !== selectedStopForTransfer.driverId) {
                      const newPos = newPositionForReorder ? parseInt(newPositionForReorder) : undefined;
                      console.log('🔄 [TRANSFER-CLICK] Mudando motorista - transferindo de', selectedStopForTransfer.driverId, 'para', newDriverId);
                      transferStopMutation.mutate({
                        stopId: selectedStopForTransfer.id,
                        fromRouteId: selectedStopForTransfer.routeId,
                        toDriverId: newDriverId,
                        newPosition: newPos
                      });
                    }
                    // Se reordenando na mesma rota
                    else if (newPositionForReorder && parseInt(newPositionForReorder) !== selectedStopForTransfer.stopOrder) {
                      reorderStopMutation.mutate({
                        stopId: selectedStopForTransfer.id,
                        routeId: selectedStopForTransfer.routeId,
                        newPosition: parseInt(newPositionForReorder)
                      });
                    }
                  }}
                  disabled={
                    transferStopMutation.isPending || 
                    reorderStopMutation.isPending || 
                    !newDriverIdForTransfer ||
                    (newDriverIdForTransfer === selectedStopForTransfer.driverId && !newPositionForReorder)
                  }
                  data-testid="button-confirm-transfer"
                >
                  {transferStopMutation.isPending || reorderStopMutation.isPending ? 'Processando...' : 'Confirmar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal para adicionar pedidos à rota */}
      {/* Dialog para editar rota */}
      <Dialog open={!!editingRoute} onOpenChange={(open) => { if (!open) setEditingRoute(null); }}>
        <DialogContent data-testid="dialog-edit-route">
          <DialogHeader>
            <DialogTitle>Editar Veículo e Entregador</DialogTitle>
            <DialogDescription>
              Altere o veículo e entregador desta rota
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Selecionar Entregador</Label>
              <Select value={editDriverId} onValueChange={setEditDriverId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o entregador" />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map(driver => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name} {driver.email ? `(${driver.email})` : '(sem email)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editDriverId && (() => {
                const selectedDriver = drivers.find(d => d.id === editDriverId);
                return selectedDriver ? (
                  <div className={`text-sm mt-1 p-2 rounded ${selectedDriver.email ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {selectedDriver.email ? (
                      <>📧 Email: <strong>{selectedDriver.email}</strong></>
                    ) : (
                      <>⚠️ <strong>Atenção:</strong> Este motorista não tem email cadastrado. A rota não aparecerá para ele.</>
                    )}
                  </div>
                ) : null;
              })()}
            </div>
            <div className="space-y-2">
              <Label>Tipo de Veículo</Label>
              <Select value={editVehicleType} onValueChange={setEditVehicleType}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o veículo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="moto">🏍️ Moto</SelectItem>
                  <SelectItem value="carro">🚗 Carro</SelectItem>
                  <SelectItem value="caminhao">🚛 Caminhão</SelectItem>
                  <SelectItem value="baruc">🚐 Baruc</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditingRoute(null)}>
              Cancelar
            </Button>
            <Button 
              onClick={() => {
                if (editingRoute && editDriverId) {
                  const driver = drivers.find(d => d.id === editDriverId);
                  updateRouteMutation.mutate({
                    routeId: editingRoute,
                    driverId: editDriverId,
                    driverName: driver?.name || '',
                    vehicleType: editVehicleType
                  });
                }
              }}
              disabled={updateRouteMutation.isPending || !editDriverId}
            >
              {updateRouteMutation.isPending ? 'Atualizando...' : 'Atualizar Rota'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddOrders} onOpenChange={setShowAddOrders}>
        <DialogContent className="max-w-md" data-testid="dialog-add-orders-route">
          <DialogHeader>
            <DialogTitle>Adicionar Pedidos à Rota</DialogTitle>
            <DialogDescription>
              Selecione um pedido disponível para adicionar à rota
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {orders.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                Não há pedidos disponíveis para adicionar
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {orders.map((order) => (
                  <div
                    key={order.id}
                    className="p-3 border border-gray-200 rounded-lg hover:bg-blue-50 cursor-pointer transition"
                    onClick={() => {
                      if (selectedRoute) {
                        addStopMutation.mutate({
                          routeId: selectedRoute,
                          billingId: order.id,
                        });
                      }
                    }}
                  >
                    <div className="font-medium text-sm">{order.customerName}</div>
                    <div className="text-xs text-muted-foreground mt-1">{order.customerAddress}</div>
                    <div className="text-xs text-blue-600 mt-2">
                      R$ {(Number(order.saleValue) || 0).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddVisits} onOpenChange={setShowAddVisits}>
        <DialogContent className="max-w-md" data-testid="dialog-add-visits-empty-route">
          <DialogHeader>
            <DialogTitle>Adicionar Visitas à Rota Vazia</DialogTitle>
            <DialogDescription>
              Selecione um pedido para adicionar à rota
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {orders.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                Não há pedidos disponíveis para adicionar
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {orders.map((order) => (
                  <div
                    key={order.id}
                    className="p-3 border border-gray-200 rounded-lg hover:bg-blue-50 cursor-pointer transition"
                    onClick={() => {
                      if (selectedRoute) {
                        addStopMutation.mutate({
                          routeId: selectedRoute,
                          billingId: order.id,
                        });
                      }
                    }}
                    data-testid={`order-item-${order.id}`}
                  >
                    <div className="font-medium text-sm">{order.customerName}</div>
                    <div className="text-xs text-muted-foreground mt-1">{order.customerAddress}</div>
                    <div className="text-xs text-blue-600 mt-2">
                      R$ {(Number(order.saleValue) || 0).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
