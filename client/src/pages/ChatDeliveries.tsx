import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, CheckCircle, XCircle, Clock, Truck } from "lucide-react";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function ChatDeliveries() {
  const { data: deliveries = [] } = useQuery<any[]>({
    queryKey: ["/api/chat/deliveries"],
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "delivered":
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      case "rejected":
        return <XCircle className="h-4 w-4 text-red-600" />;
      case "confirmed":
        return <Truck className="h-4 w-4 text-blue-600" />;
      default:
        return <Clock className="h-4 w-4 text-amber-600" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
      pending: "outline",
      confirmed: "secondary",
      delivered: "default",
      rejected: "destructive",
    };

    return (
      <Badge variant={variants[status] || "outline"}>
        {status === "pending" && "Pendente"}
        {status === "confirmed" && "Confirmada"}
        {status === "delivered" && "Entregue"}
        {status === "rejected" && "Rejeitada"}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-purple-50">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Entregas via Chat</h1>
            <p className="text-slate-600 mt-1">Gerencie entregas solicitadas via WhatsApp e Telegram</p>
          </div>
          <BackToDashboardButton />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{deliveries.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
              <Clock className="h-4 w-4 text-amber-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {deliveries.filter((d) => d.status === "pending").length}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Entregues</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {deliveries.filter((d) => d.status === "delivered").length}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejeitadas</CardTitle>
              <XCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {deliveries.filter((d) => d.status === "rejected").length}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {deliveries.length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center h-64">
                <div className="text-center text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Nenhuma entrega registrada</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            deliveries.map((delivery: any) => (
              <Card key={delivery.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      {getStatusIcon(delivery.status)}
                      Entrega #{delivery.id?.substring(0, 8)}
                    </CardTitle>
                    {getStatusBadge(delivery.status)}
                  </div>
                  <CardDescription>
                    Pedido: {delivery.orderId?.substring(0, 8)} | 
                    Entregador: {delivery.deliveryPersonId || "Não atribuído"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {delivery.scheduledAt && (
                    <p className="text-sm text-muted-foreground">
                      Agendado para: {new Date(delivery.scheduledAt).toLocaleDateString("pt-BR")}
                    </p>
                  )}
                  {delivery.deliveredAt && (
                    <p className="text-sm text-green-700">
                      Entregue em: {new Date(delivery.deliveredAt).toLocaleString("pt-BR")}
                    </p>
                  )}
                  {delivery.notes && (
                    <p className="text-sm italic">{delivery.notes}</p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
