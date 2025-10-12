import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { 
  Truck, 
  Package, 
  CheckCircle2, 
  XCircle, 
  Clock,
  MapPin,
  Search,
  Filter,
  RotateCcw,
  AlertTriangle,
  Edit3,
  Eye,
  Zap
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

interface DeliveryItem {
  id: string;
  salesCardId: string;
  customerName: string;
  customerAddress: string;
  customerPhone: string;
  deliveryStatus: string;
  deliveryScheduledDate: string;
  deliveryCompletedDate?: string;
  deliveryFailureReason?: string;
  deliveryNotes?: string;
  deliveryDriverId?: string;
  driverName?: string;
  trackingCode?: string;
  saleValue: number;
  // Novos campos
  deliveryTimeSlots?: string[];
  deliverySaturdayTimeSlots?: string[];
  exclusiveVehicle?: boolean;
  vehicleTypes?: string[];
  isUrgent?: boolean;
}

const deliveryStatusConfig = {
  pending: { icon: Package, label: "Aguardando", color: "secondary" },
  in_transit: { icon: Truck, label: "Em trânsito", color: "default" },
  delivered: { icon: CheckCircle2, label: "Entregue", color: "default" },
  failed: { icon: XCircle, label: "Falharam", color: "destructive" },
  returned: { icon: AlertTriangle, label: "Devolvidas", color: "secondary" }
};

const failureReasonOptions = [
  { value: "customer_absent", label: "Cliente ausente" },
  { value: "address_incorrect", label: "Endereço incorreto" },
  { value: "customer_refused", label: "Cliente recusou" },
  { value: "payment_issue", label: "Problema de pagamento" },
  { value: "product_damaged", label: "Produto danificado" },
  { value: "other", label: "Outros motivos" }
];

export default function DeliveryManagement() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("pending"); // Filtrar apenas "aguardando rota" por padrão
  const [driverFilter, setDriverFilter] = useState("all");
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryItem | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  
  // Novos estados para seleção de pedidos
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);

  // Form state for update modal
  const [updateForm, setUpdateForm] = useState({
    status: "",
    driverId: "",
    notes: "",
    failureReason: "",
    completedDate: ""
  });

  // Query para buscar todas as entregas
  const { data: deliveries, isLoading: isLoadingDeliveries } = useQuery<DeliveryItem[]>({
    queryKey: ['/api/deliveries/all'],
    refetchInterval: 30000, // Atualiza a cada 30 segundos
  });

  // Query para buscar motoristas ativos
  const { data: drivers, isLoading: isLoadingDrivers } = useQuery<any[]>({
    queryKey: ['/api/delivery-drivers/active'],
  });

  // Mutation para atualizar status de entrega
  const updateDeliveryMutation = useMutation({
    mutationFn: async (data: { salesCardId: string; updateData: any }) => {
      const response = await fetch(`/api/deliveries/${data.salesCardId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data.updateData),
      });
      if (!response.ok) throw new Error('Erro ao atualizar entrega');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries/all'] });
      setShowUpdateModal(false);
      setSelectedDelivery(null);
      toast({
        title: "Entrega atualizada",
        description: "O status da entrega foi atualizado com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar entrega",
        variant: "destructive",
      });
    },
  });

  // Mutation para marcar entrega como urgente
  const toggleUrgentMutation = useMutation({
    mutationFn: async (data: { salesCardId: string; isUrgent: boolean }) => {
      const response = await fetch(`/api/sales-cards/${data.salesCardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isUrgent: data.isUrgent }),
      });
      if (!response.ok) throw new Error('Erro ao atualizar urgência');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/deliveries/all'] });
      toast({
        title: "Urgência atualizada",
        description: "A marcação de urgência foi atualizada.",
      });
    },
  });

  // Funções de seleção de pedidos
  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedOrders(new Set());
      setSelectAll(false);
    } else {
      const allIds = new Set(filteredDeliveries.map(d => d.salesCardId));
      setSelectedOrders(allIds);
      setSelectAll(true);
    }
  };

  const handleSelectOrder = (salesCardId: string) => {
    const newSelected = new Set(selectedOrders);
    if (newSelected.has(salesCardId)) {
      newSelected.delete(salesCardId);
    } else {
      newSelected.add(salesCardId);
    }
    setSelectedOrders(newSelected);
    setSelectAll(newSelected.size === filteredDeliveries.length && filteredDeliveries.length > 0);
  };

  const handleToggleUrgent = (salesCardId: string, currentUrgent: boolean) => {
    toggleUrgentMutation.mutate({
      salesCardId,
      isUrgent: !currentUrgent
    });
  };

  // Filtrar entregas
  const filteredDeliveries = useMemo(() => {
    if (!deliveries) return [];

    return deliveries.filter(delivery => {
      const matchesSearch = 
        (delivery.customerName?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (delivery.customerAddress?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (delivery.salesCardId?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (delivery.trackingCode?.toLowerCase() || '').includes(searchTerm.toLowerCase());

      const matchesStatus = statusFilter === "all" || delivery.deliveryStatus === statusFilter;
      const matchesDriver = driverFilter === "all" || delivery.deliveryDriverId === driverFilter;

      return matchesSearch && matchesStatus && matchesDriver;
    });
  }, [deliveries, searchTerm, statusFilter, driverFilter]);

  const handleUpdateDelivery = () => {
    if (!selectedDelivery) return;

    const updateData: any = {
      status: updateForm.status,
      deliveryNotes: updateForm.notes,
      driverId: updateForm.driverId || undefined,
    };

    if (updateForm.status === 'delivered') {
      updateData.deliveryCompletedDate = new Date().toISOString();
    } else if (updateForm.status === 'failed') {
      updateData.deliveryFailureReason = updateForm.failureReason;
    }

    updateDeliveryMutation.mutate({
      salesCardId: selectedDelivery.salesCardId,
      updateData
    });
  };

  const openUpdateModal = (delivery: DeliveryItem) => {
    setSelectedDelivery(delivery);
    setUpdateForm({
      status: delivery.deliveryStatus,
      driverId: delivery.deliveryDriverId || "",
      notes: delivery.deliveryNotes || "",
      failureReason: delivery.deliveryFailureReason || "",
      completedDate: delivery.deliveryCompletedDate || ""
    });
    setShowUpdateModal(true);
  };

  const openDetailsModal = (delivery: DeliveryItem) => {
    setSelectedDelivery(delivery);
    setShowDetailsModal(true);
  };

  return (
    <div className="space-y-6" data-testid="delivery-management">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Gestão de Entregas</h1>
          <p className="text-muted-foreground">
            Gerencie e acompanhe todas as entregas
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card data-testid="filters-card">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Filter className="h-5 w-5" />
            <span>Filtros</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="search">Buscar</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Cliente, endereço, card ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                  data-testid="input-search"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="status-filter">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger data-testid="select-status">
                  <SelectValue placeholder="Todos os status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  {Object.entries(deliveryStatusConfig).map(([value, config]) => (
                    <SelectItem key={value} value={value}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="driver-filter">Motorista</Label>
              <Select value={driverFilter} onValueChange={setDriverFilter}>
                <SelectTrigger data-testid="select-driver">
                  <SelectValue placeholder="Todos os motoristas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os motoristas</SelectItem>
                  {drivers?.map((driver: any) => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>&nbsp;</Label>
              <Button 
                variant="outline" 
                onClick={() => {
                  setSearchTerm("");
                  setStatusFilter("all");
                  setDriverFilter("all");
                }}
                className="w-full"
                data-testid="button-clear-filters"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Limpar Filtros
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Deliveries List */}
      <Card data-testid="deliveries-list-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            Entregas Aguardando Rota ({filteredDeliveries.length})
          </CardTitle>
          {statusFilter === 'pending' && filteredDeliveries.length > 0 && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="select-all"
                checked={selectAll}
                onCheckedChange={handleSelectAll}
                data-testid="checkbox-select-all"
              />
              <Label htmlFor="select-all" className="cursor-pointer">
                Selecionar Todos
              </Label>
              {selectedOrders.size > 0 && (
                <Badge variant="secondary">{selectedOrders.size} selecionados</Badge>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isLoadingDeliveries ? (
            <div className="text-center py-8">Carregando entregas...</div>
          ) : filteredDeliveries.length > 0 ? (
            <div className="space-y-4">
              {filteredDeliveries.map((delivery) => {
                const statusConfig = deliveryStatusConfig[delivery.deliveryStatus as keyof typeof deliveryStatusConfig];
                const StatusIcon = statusConfig?.icon || Package;
                const isSelected = selectedOrders.has(delivery.salesCardId);
                
                return (
                  <div key={delivery.id} className={`border rounded-lg p-4 hover:bg-gray-50 ${isSelected ? 'bg-blue-50 border-blue-300' : ''}`} data-testid={`delivery-item-${delivery.id}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex items-start space-x-3 flex-1">
                        {/* Checkbox de seleção */}
                        {statusFilter === 'pending' && (
                          <Checkbox
                            id={`select-${delivery.salesCardId}`}
                            checked={isSelected}
                            onCheckedChange={() => handleSelectOrder(delivery.salesCardId)}
                            data-testid={`checkbox-select-${delivery.salesCardId}`}
                            className="mt-1"
                          />
                        )}
                        
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center space-x-3">
                            <Badge variant={statusConfig?.color as any}>
                              <StatusIcon className="h-3 w-3 mr-1" />
                              {statusConfig?.label}
                            </Badge>
                            {delivery.isUrgent && (
                              <Badge variant="destructive" className="bg-red-600">
                                <Zap className="h-3 w-3 mr-1" />
                                URGENTE
                              </Badge>
                            )}
                            {delivery.trackingCode && (
                              <Badge variant="outline">
                                {delivery.trackingCode}
                              </Badge>
                            )}
                          </div>
                        
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                              <div className="font-medium">{delivery.customerName}</div>
                              <div className="text-sm text-muted-foreground flex items-center">
                                <MapPin className="h-3 w-3 mr-1" />
                                {delivery.customerAddress}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                📞 {delivery.customerPhone}
                              </div>
                            </div>
                            
                            <div>
                              <div className="text-sm">
                                <strong>Card:</strong> {delivery.salesCardId}
                              </div>
                              <div className="text-sm">
                                <strong>Valor:</strong> R$ {delivery.saleValue?.toFixed(2)}
                              </div>
                              <div className="text-sm">
                                <strong>Agendado:</strong> {new Date(delivery.deliveryScheduledDate).toLocaleDateString('pt-BR')}
                              </div>
                            </div>
                            
                            <div>
                              {delivery.driverName && (
                                <div className="text-sm">
                                  <strong>Motorista:</strong> {delivery.driverName}
                                </div>
                              )}
                              {delivery.deliveryCompletedDate && (
                                <div className="text-sm">
                                  <strong>Concluído:</strong> {new Date(delivery.deliveryCompletedDate).toLocaleDateString('pt-BR')}
                                </div>
                              )}
                              {delivery.deliveryFailureReason && (
                                <div className="text-sm text-red-600">
                                  <strong>Motivo:</strong> {failureReasonOptions.find(r => r.value === delivery.deliveryFailureReason)?.label}
                                </div>
                              )}
                            </div>
                          </div>

                          {delivery.deliveryNotes && (
                            <div className="text-sm bg-gray-50 p-2 rounded">
                              <strong>Observações:</strong> {delivery.deliveryNotes}
                            </div>
                          )}

                          {/* Novas informações: Horários, Dias e Veículos */}
                          <div className="border-t pt-2 mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                            {/* Horários de Entrega */}
                            {delivery.deliveryTimeSlots && delivery.deliveryTimeSlots.length > 0 && (
                              <div className="text-sm">
                                <strong className="text-gray-700">Horários (dias de semana):</strong>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {delivery.deliveryTimeSlots.map((slot, idx) => (
                                    <Badge key={idx} variant="outline" className="text-xs">
                                      <Clock className="h-3 w-3 mr-1" />
                                      {slot}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Horários Sábado */}
                            {delivery.deliverySaturdayTimeSlots && delivery.deliverySaturdayTimeSlots.length > 0 && (
                              <div className="text-sm">
                                <strong className="text-gray-700">Horários (sábado):</strong>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {delivery.deliverySaturdayTimeSlots.map((slot, idx) => (
                                    <Badge key={idx} variant="outline" className="text-xs bg-blue-50">
                                      <Clock className="h-3 w-3 mr-1" />
                                      {slot}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Veículos Exclusivos */}
                            {delivery.exclusiveVehicle && delivery.vehicleTypes && delivery.vehicleTypes.length > 0 && (
                              <div className="text-sm">
                                <strong className="text-orange-700">Veículo Exclusivo:</strong>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {delivery.vehicleTypes.map((vehicle, idx) => (
                                    <Badge key={idx} variant="outline" className="text-xs bg-orange-50 border-orange-300">
                                      <Truck className="h-3 w-3 mr-1" />
                                      {vehicle === 'caminhao' ? '🚛 Caminhão' : vehicle === 'carro' ? '🚗 Carro' : '🏍️ Moto'}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Checkbox de Urgência */}
                          {statusFilter === 'pending' && (
                            <div className="border-t pt-2 mt-2">
                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id={`urgent-${delivery.salesCardId}`}
                                  checked={delivery.isUrgent || false}
                                  onCheckedChange={() => handleToggleUrgent(delivery.salesCardId, delivery.isUrgent || false)}
                                  data-testid={`checkbox-urgent-${delivery.salesCardId}`}
                                />
                                <Label htmlFor={`urgent-${delivery.salesCardId}`} className="cursor-pointer text-sm font-medium flex items-center">
                                  <Zap className="h-4 w-4 mr-1 text-red-600" />
                                  Marcar como entrega urgente
                                </Label>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex flex-col space-y-2 ml-4">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openDetailsModal(delivery)}
                          data-testid={`button-view-${delivery.id}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openUpdateModal(delivery)}
                          data-testid={`button-update-${delivery.id}`}
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Nenhuma entrega encontrada
            </div>
          )}
        </CardContent>
      </Card>

      {/* Update Modal */}
      <Dialog open={showUpdateModal} onOpenChange={setShowUpdateModal}>
        <DialogContent className="max-w-md" data-testid="update-modal">
          <DialogHeader>
            <DialogTitle>Atualizar Entrega</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="update-status">Status</Label>
              <Select value={updateForm.status} onValueChange={(value) => setUpdateForm({...updateForm, status: value})}>
                <SelectTrigger data-testid="update-status-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(deliveryStatusConfig).map(([value, config]) => (
                    <SelectItem key={value} value={value}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="update-driver">Motorista</Label>
              <Select value={updateForm.driverId} onValueChange={(value) => setUpdateForm({...updateForm, driverId: value})}>
                <SelectTrigger data-testid="update-driver-select">
                  <SelectValue placeholder="Selecionar motorista" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Nenhum motorista</SelectItem>
                  {drivers?.map((driver: any) => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {updateForm.status === 'failed' && (
              <div className="space-y-2">
                <Label htmlFor="failure-reason">Motivo da Falha</Label>
                <Select value={updateForm.failureReason} onValueChange={(value) => setUpdateForm({...updateForm, failureReason: value})}>
                  <SelectTrigger data-testid="failure-reason-select">
                    <SelectValue placeholder="Selecionar motivo" />
                  </SelectTrigger>
                  <SelectContent>
                    {failureReasonOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="update-notes">Observações</Label>
              <Textarea
                id="update-notes"
                placeholder="Observações sobre a entrega..."
                value={updateForm.notes}
                onChange={(e) => setUpdateForm({...updateForm, notes: e.target.value})}
                data-testid="update-notes-textarea"
              />
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => setShowUpdateModal(false)}
                data-testid="button-cancel-update"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleUpdateDelivery}
                disabled={updateDeliveryMutation.isPending}
                data-testid="button-save-update"
              >
                {updateDeliveryMutation.isPending ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Details Modal */}
      <Dialog open={showDetailsModal} onOpenChange={setShowDetailsModal}>
        <DialogContent className="max-w-2xl" data-testid="details-modal">
          <DialogHeader>
            <DialogTitle>Detalhes da Entrega</DialogTitle>
          </DialogHeader>
          {selectedDelivery && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="font-medium mb-2">Informações do Cliente</h3>
                  <div className="space-y-1 text-sm">
                    <div><strong>Nome:</strong> {selectedDelivery.customerName}</div>
                    <div><strong>Telefone:</strong> {selectedDelivery.customerPhone}</div>
                    <div><strong>Endereço:</strong> {selectedDelivery.customerAddress}</div>
                  </div>
                </div>
                <div>
                  <h3 className="font-medium mb-2">Informações da Entrega</h3>
                  <div className="space-y-1 text-sm">
                    <div><strong>Card ID:</strong> {selectedDelivery.salesCardId}</div>
                    <div><strong>Valor:</strong> R$ {selectedDelivery.saleValue?.toFixed(2)}</div>
                    <div><strong>Status:</strong> {deliveryStatusConfig[selectedDelivery.deliveryStatus as keyof typeof deliveryStatusConfig]?.label}</div>
                    {selectedDelivery.trackingCode && (
                      <div><strong>Rastreamento:</strong> {selectedDelivery.trackingCode}</div>
                    )}
                  </div>
                </div>
              </div>
              
              {selectedDelivery.deliveryNotes && (
                <div>
                  <h3 className="font-medium mb-2">Observações</h3>
                  <div className="bg-gray-50 p-3 rounded text-sm">
                    {selectedDelivery.deliveryNotes}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}