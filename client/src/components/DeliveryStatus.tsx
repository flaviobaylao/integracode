import { useState } from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Truck, 
  MapPin, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  RotateCcw,
  Package,
  AlertTriangle
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface DeliveryStatusProps {
  salesCardId: string;
  deliveryStatus?: string;
  deliveryCompletedDate?: string;
  deliveryFailureReason?: string;
  deliveryNotes?: string;
  trackingCode?: string;
}

interface DeliveryHistoryItem {
  id: string;
  status: string;
  timestamp: string;
  location?: string;
  notes?: string;
  driver_name?: string;
}

const deliveryStatusConfig = {
  pending: {
    icon: Package,
    label: "Aguardando entrega",
    color: "bg-gray-500",
    textColor: "text-gray-700"
  },
  in_transit: {
    icon: Truck,
    label: "Em trânsito",
    color: "bg-blue-500",
    textColor: "text-blue-700"
  },
  delivered: {
    icon: CheckCircle2,
    label: "Entregue",
    color: "bg-green-500",
    textColor: "text-green-700"
  },
  failed: {
    icon: XCircle,
    label: "Falha na entrega",
    color: "bg-red-500",
    textColor: "text-red-700"
  },
  returned: {
    icon: RotateCcw,
    label: "Devolvido",
    color: "bg-orange-500",
    textColor: "text-orange-700"
  }
};

const failureReasonLabels = {
  customer_absent: "Cliente ausente",
  address_incorrect: "Endereço incorreto",
  customer_refused: "Cliente recusou",
  payment_issue: "Problema de pagamento",
  product_damaged: "Produto danificado",
  other: "Outros motivos"
};

export default function DeliveryStatus({
  salesCardId,
  deliveryStatus = 'pending',
  deliveryCompletedDate,
  deliveryFailureReason,
  deliveryNotes,
  trackingCode
}: DeliveryStatusProps) {
  const [showHistory, setShowHistory] = useState(false);

  const config = deliveryStatusConfig[deliveryStatus as keyof typeof deliveryStatusConfig] || deliveryStatusConfig.pending;
  const IconComponent = config.icon;

  // Buscar histórico de entrega
  const { data: deliveryHistory, isLoading: isLoadingHistory } = useQuery({
    queryKey: ['/api/deliveries', salesCardId, 'history'],
    enabled: showHistory,
    retry: false,
  });

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    return {
      date: date.toLocaleDateString('pt-BR'),
      time: date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
  };

  const getStatusIcon = (status: string) => {
    const statusConfig = deliveryStatusConfig[status as keyof typeof deliveryStatusConfig];
    if (!statusConfig) return Package;
    return statusConfig.icon;
  };

  const getStatusLabel = (status: string) => {
    const statusConfig = deliveryStatusConfig[status as keyof typeof deliveryStatusConfig];
    return statusConfig ? statusConfig.label : 'Status desconhecido';
  };

  return (
    <>
      <div className="flex items-center space-x-2">
        <Badge 
          variant="secondary" 
          className={`${config.color} text-white flex items-center space-x-1 px-2 py-1`}
        >
          <IconComponent className="h-3 w-3" />
          <span className="text-xs">{config.label}</span>
        </Badge>
        
        {trackingCode && (
          <span className="text-xs text-gray-500">#{trackingCode}</span>
        )}
        
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => setShowHistory(true)}
        >
          <MapPin className="h-3 w-3" />
        </Button>
      </div>

      {deliveryStatus === 'delivered' && deliveryCompletedDate && (
        <div className="flex items-center space-x-1 mt-1">
          <Clock className="h-3 w-3 text-green-600" />
          <span className="text-xs text-green-700">
            Entregue em {formatDateTime(deliveryCompletedDate).date} às {formatDateTime(deliveryCompletedDate).time}
          </span>
        </div>
      )}

      {deliveryStatus === 'failed' && deliveryFailureReason && (
        <div className="flex items-center space-x-1 mt-1">
          <AlertTriangle className="h-3 w-3 text-red-600" />
          <span className="text-xs text-red-700">
            {failureReasonLabels[deliveryFailureReason as keyof typeof failureReasonLabels] || deliveryFailureReason}
          </span>
        </div>
      )}

      {deliveryNotes && (
        <div className="mt-1">
          <span className="text-xs text-gray-600">{deliveryNotes}</span>
        </div>
      )}

      {/* Dialog com histórico de entrega */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center space-x-2">
              <Truck className="h-5 w-5" />
              <span>Histórico de Entrega</span>
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {trackingCode && (
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Código de Rastreamento</span>
                  <span className="font-mono text-sm bg-white px-2 py-1 rounded">{trackingCode}</span>
                </div>
              </div>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Status Atual</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center space-x-2">
                  <IconComponent className={`h-4 w-4 ${config.textColor}`} />
                  <span className="font-medium">{config.label}</span>
                </div>
                
                {deliveryStatus === 'delivered' && deliveryCompletedDate && (
                  <p className="text-sm text-gray-600 mt-1">
                    Concluído em {formatDateTime(deliveryCompletedDate).date} às {formatDateTime(deliveryCompletedDate).time}
                  </p>
                )}
                
                {deliveryStatus === 'failed' && deliveryFailureReason && (
                  <p className="text-sm text-red-600 mt-1">
                    Motivo: {failureReasonLabels[deliveryFailureReason as keyof typeof failureReasonLabels] || deliveryFailureReason}
                  </p>
                )}
                
                {deliveryNotes && (
                  <p className="text-sm text-gray-600 mt-2 p-2 bg-gray-50 rounded">
                    {deliveryNotes}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Histórico detalhado */}
            {isLoadingHistory ? (
              <div className="text-center py-4">
                <span className="text-sm text-gray-500">Carregando histórico...</span>
              </div>
            ) : deliveryHistory && deliveryHistory.length > 0 ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Histórico Completo</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {deliveryHistory.map((item: DeliveryHistoryItem) => {
                    const StatusIcon = getStatusIcon(item.status);
                    const datetime = formatDateTime(item.timestamp);
                    
                    return (
                      <div key={item.id} className="flex items-start space-x-3 pb-2 border-b border-gray-100 last:border-b-0">
                        <StatusIcon className="h-4 w-4 mt-1 text-gray-600" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{getStatusLabel(item.status)}</span>
                            <span className="text-xs text-gray-500">{datetime.time}</span>
                          </div>
                          <p className="text-xs text-gray-600">{datetime.date}</p>
                          
                          {item.location && (
                            <div className="flex items-center space-x-1 mt-1">
                              <MapPin className="h-3 w-3 text-gray-400" />
                              <span className="text-xs text-gray-600">{item.location}</span>
                            </div>
                          )}
                          
                          {item.driver_name && (
                            <p className="text-xs text-gray-500 mt-1">Motorista: {item.driver_name}</p>
                          )}
                          
                          {item.notes && (
                            <p className="text-xs text-gray-600 mt-1 p-1 bg-gray-50 rounded">{item.notes}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            ) : (
              <div className="text-center py-4">
                <span className="text-sm text-gray-500">Nenhum histórico de entrega disponível</span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}