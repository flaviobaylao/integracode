import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, RefreshCw, CheckCircle2, XCircle, ArrowLeft, Truck, Package, RotateCcw, Send } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface StageLog {
  id: string;
  omieOrderId: number;
  orderNumber: string | null;
  customerName: string | null;
  previousStage: string | null;
  newStage: string;
  stageDescription: string | null;
  trigger: string;
  triggerDetail: string | null;
  routeId: string | null;
  stopId: string | null;
  billingId: string | null;
  driverEmail: string | null;
  triggeredBy: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
}

const TRIGGER_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  send_to_driver: { label: "Envio de Rota", icon: Send, color: "bg-blue-100 text-blue-800" },
  send_all_to_drivers: { label: "Envio em Lote", icon: Send, color: "bg-blue-100 text-blue-800" },
  driver_checkout: { label: "Entrega (checkout)", icon: Package, color: "bg-green-100 text-green-800" },
  complete_delivery: { label: "Entrega Direta", icon: Package, color: "bg-green-100 text-green-800" },
  return_delivery: { label: "Devolução", icon: RotateCcw, color: "bg-orange-100 text-orange-800" },
};

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
  "20": { label: "Em Rota", color: "bg-blue-500" },
  "70": { label: "Entregue", color: "bg-green-500" },
  "80": { label: "Aguardando Rota", color: "bg-yellow-500" },
  "10": { label: "Pedido Incluído", color: "bg-gray-500" },
  "50": { label: "Faturar", color: "bg-purple-500" },
  "60": { label: "Faturado", color: "bg-indigo-500" },
};

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function StageBadge({ code }: { code: string }) {
  const stage = STAGE_LABELS[code];
  if (!stage) return <Badge variant="outline">{code}</Badge>;
  return (
    <Badge className={`${stage.color} text-white`}>
      {stage.label}
    </Badge>
  );
}

export default function OmieStageLogs() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [triggerFilter, setTriggerFilter] = useState<string>("all");
  const [successFilter, setSuccessFilter] = useState<string>("all");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  const queryParams = new URLSearchParams();
  if (triggerFilter && triggerFilter !== "all") queryParams.set("trigger", triggerFilter);
  if (successFilter && successFilter !== "all") queryParams.set("success", successFilter);
  if (startDate) queryParams.set("startDate", startDate);
  if (endDate) queryParams.set("endDate", endDate);

  const { data, isLoading, refetch } = useQuery<{ logs: StageLog[]; total: number; showing: number }>({
    queryKey: ["/api/omie/stage-logs", triggerFilter, successFilter, startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/omie/stage-logs?${queryParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Erro ao buscar logs");
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (authLoading) return null;
  if (!user || !["admin", "coordinator", "administrative"].includes(user.role || "")) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Acesso restrito a administradores.</p>
      </div>
    );
  }

  const logs = data?.logs || [];
  const totalLogs = data?.total || 0;
  const successCount = logs.filter(l => l.success).length;
  const errorCount = logs.filter(l => !l.success).length;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BackToDashboardButton />
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Truck className="h-6 w-6" />
              Logs de Etapas Omie
            </h1>
            <p className="text-sm text-muted-foreground">
              Registro de todas as transições de etapa dos pedidos no Omie
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/omie/stage-logs"] });
            refetch();
          }}
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          Atualizar
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{totalLogs}</div>
            <p className="text-xs text-muted-foreground">Total de registros</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold text-green-600">{successCount}</div>
            <p className="text-xs text-muted-foreground">Sucesso (exibidos)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold text-red-600">{errorCount}</div>
            <p className="text-xs text-muted-foreground">Erros (exibidos)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{data?.showing || 0}</div>
            <p className="text-xs text-muted-foreground">Exibindo</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tipo de ação</label>
              <Select value={triggerFilter} onValueChange={setTriggerFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="send_to_driver">Envio de Rota</SelectItem>
                  <SelectItem value="send_all_to_drivers">Envio em Lote</SelectItem>
                  <SelectItem value="driver_checkout">Entrega (checkout)</SelectItem>
                  <SelectItem value="complete_delivery">Entrega Direta</SelectItem>
                  <SelectItem value="return_delivery">Devolução</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Resultado</label>
              <Select value={successFilter} onValueChange={setSuccessFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="true">Sucesso</SelectItem>
                  <SelectItem value="false">Erro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Data inicial</label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Data final</label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              Nenhum log de transição de etapa encontrado.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Data/Hora</TableHead>
                    <TableHead>Pedido Omie</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Nova Etapa</TableHead>
                    <TableHead>Ação</TableHead>
                    <TableHead>Detalhe</TableHead>
                    <TableHead>Motorista</TableHead>
                    <TableHead className="w-[80px]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map(log => {
                    const triggerInfo = TRIGGER_LABELS[log.trigger] || { label: log.trigger, color: "bg-gray-100 text-gray-800" };
                    return (
                      <TableRow key={log.id} className={!log.success ? "bg-red-50" : ""}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatDate(log.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {log.omieOrderId}
                          {log.orderNumber && (
                            <div className="text-xs text-muted-foreground">NF {log.orderNumber}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm max-w-[200px] truncate">
                          {log.customerName || "-"}
                        </TableCell>
                        <TableCell>
                          <StageBadge code={log.newStage} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={triggerInfo.color}>
                            {triggerInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">
                          {log.triggerDetail || "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {log.driverEmail ? log.driverEmail.split("@")[0] : log.triggeredBy?.split("@")[0] || "-"}
                        </TableCell>
                        <TableCell>
                          {log.success ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                          ) : (
                            <div className="flex items-center gap-1">
                              <XCircle className="h-5 w-5 text-red-500" />
                              {log.errorMessage && (
                                <span className="text-xs text-red-600 max-w-[150px] truncate block" title={log.errorMessage}>
                                  {log.errorMessage}
                                </span>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
