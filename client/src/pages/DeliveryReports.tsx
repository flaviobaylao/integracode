import { useState, useMemo } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Calendar,
  Download,
  CheckCircle2,
  XCircle,
  Package,
  Truck,
  RotateCcw,
  Search,
  Clock
} from "lucide-react";

interface DeliveryRecord {
  orderNumber: string;
  customerName: string;
  driverName: string;
  routeDate: string;
  status: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  completedAt: string | null;
  notes: string | null;
  routeName: string | null;
  invoiceStage: string | null;
  delivered: boolean;
}

const statusLabels: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  efetuada: { label: "Entregue", color: "bg-green-100 text-green-800", icon: CheckCircle2 },
  entregue: { label: "Entregue", color: "bg-green-100 text-green-800", icon: CheckCircle2 },
  pendente: { label: "Pendente", color: "bg-yellow-100 text-yellow-800", icon: Clock },
  pending: { label: "Pendente", color: "bg-yellow-100 text-yellow-800", icon: Clock },
  em_pausa: { label: "Em Pausa", color: "bg-blue-100 text-blue-800", icon: Package },
  devolvida: { label: "Devolvida", color: "bg-red-100 text-red-800", icon: RotateCcw },
  cancelada: { label: "Cancelada", color: "bg-gray-100 text-gray-800", icon: XCircle },
};

function getBrazilDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  return { year: y, month: m, day: d, full: `${y}-${m}-${d}` };
}

function getToday() {
  return getBrazilDate().full;
}

function getMonthStart() {
  const { year, month } = getBrazilDate();
  return `${year}-${month}-01`;
}

function formatDateBR(dateStr: string) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('pt-BR');
}

function formatTimeBR(timeStr: string | null) {
  if (!timeStr) return '-';
  const d = new Date(timeStr);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export default function DeliveryReports() {
  const [startDate, setStartDate] = useState(getMonthStart());
  const [endDate, setEndDate] = useState(getToday());
  const [driverFilter, setDriverFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchText, setSearchText] = useState("");

  const { data: records = [], isLoading } = useQuery<DeliveryRecord[]>({
    queryKey: ['/api/deliveries/reports/detailed', startDate, endDate, driverFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate });
      if (driverFilter !== "all") params.set("driver", driverFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/deliveries/reports/detailed?${params}`);
      if (!res.ok) throw new Error("Erro ao carregar relatório");
      return res.json();
    },
    enabled: Boolean(startDate && endDate),
  });

  const { data: driversList = [] } = useQuery<Array<{label: string; value: string}>>({
    queryKey: ['/api/deliveries/reports/drivers-list'],
  });

  const filteredRecords = useMemo(() => {
    if (!searchText.trim()) return records;
    const search = searchText.toLowerCase();
    return records.filter(r =>
      r.customerName?.toLowerCase().includes(search) ||
      r.orderNumber?.toLowerCase().includes(search) ||
      r.driverName?.toLowerCase().includes(search)
    );
  }, [records, searchText]);

  const stats = useMemo(() => {
    const total = filteredRecords.length;
    const delivered = filteredRecords.filter(r => r.delivered).length;
    const pending = filteredRecords.filter(r => ['pendente', 'pending'].includes(r.status)).length;
    const returned = filteredRecords.filter(r => r.status === 'devolvida').length;
    return { total, delivered, pending, returned };
  }, [filteredRecords]);

  const handleExportCSV = () => {
    if (filteredRecords.length === 0) return;
    const headers = ["Nº Pedido", "Cliente", "Entregador", "Data", "Horário Entrega", "Status", "Entrega Efetuada"];
    const rows = filteredRecords.map(r => [
      r.orderNumber || '-',
      r.customerName,
      r.driverName,
      formatDateBR(r.routeDate),
      r.completedAt ? formatTimeBR(r.completedAt) : (r.checkOutTime ? formatTimeBR(r.checkOutTime) : '-'),
      statusLabels[r.status]?.label || r.status,
      r.delivered ? "Sim" : "Não",
    ]);
    const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(";")).join("\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio_entregas_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6" data-testid="delivery-reports">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Relatório de Entregas</h1>
          <p className="text-muted-foreground">
            Detalhamento das entregas por pedido, cliente e entregador
          </p>
        </div>
        <div className="flex gap-2">
          <BackToDashboardButton />
          <Button onClick={handleExportCSV} disabled={filteredRecords.length === 0} data-testid="button-export">
            <Download className="h-4 w-4 mr-2" />
            Exportar CSV
          </Button>
        </div>
      </div>

      <Card data-testid="filters-card">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Calendar className="h-5 w-5" />
            <span>Filtros</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="space-y-2">
              <Label htmlFor="start-date">Data Inicial</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date">Data Final</Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-end-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Entregador</Label>
              <Select value={driverFilter} onValueChange={setDriverFilter}>
                <SelectTrigger data-testid="select-driver">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {driversList.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger data-testid="select-status">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="efetuada">Entregue</SelectItem>
                  <SelectItem value="pendente">Pendente</SelectItem>
                  <SelectItem value="devolvida">Devolvida</SelectItem>
                  <SelectItem value="cancelada">Cancelada</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Buscar</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Pedido, cliente..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="pl-9"
                  data-testid="input-search"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <Package className="h-8 w-8 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
              <div>
                <p className="text-2xl font-bold text-green-600">{stats.delivered}</p>
                <p className="text-xs text-muted-foreground">Entregues</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <Clock className="h-8 w-8 text-yellow-600" />
              <div>
                <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
                <p className="text-xs text-muted-foreground">Pendentes</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <RotateCcw className="h-8 w-8 text-red-600" />
              <div>
                <p className="text-2xl font-bold text-red-600">{stats.returned}</p>
                <p className="text-xs text-muted-foreground">Devolvidas</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="deliveries-table-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Entregas ({filteredRecords.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Carregando dados...</div>
          ) : filteredRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              Nenhuma entrega encontrada no período selecionado
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Nº Pedido</th>
                    <th className="text-left p-3 font-medium">Cliente</th>
                    <th className="text-left p-3 font-medium">Entregador</th>
                    <th className="text-left p-3 font-medium">Data</th>
                    <th className="text-left p-3 font-medium">Horário</th>
                    <th className="text-left p-3 font-medium">Status</th>
                    <th className="text-center p-3 font-medium">Entrega Efetuada</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.map((record, idx) => {
                    const statusInfo = statusLabels[record.status] || { label: record.status, color: "bg-gray-100 text-gray-800", icon: Package };
                    const deliveryTime = record.completedAt || record.checkOutTime;
                    return (
                      <tr key={idx} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="p-3 font-mono text-xs">{record.orderNumber}</td>
                        <td className="p-3 font-medium">{record.customerName}</td>
                        <td className="p-3">{record.driverName}</td>
                        <td className="p-3">{formatDateBR(record.routeDate)}</td>
                        <td className="p-3">{formatTimeBR(deliveryTime)}</td>
                        <td className="p-3">
                          <Badge variant="outline" className={statusInfo.color}>
                            {statusInfo.label}
                          </Badge>
                        </td>
                        <td className="p-3 text-center">
                          {record.delivered ? (
                            <CheckCircle2 className="h-5 w-5 text-green-600 inline-block" />
                          ) : (
                            <XCircle className="h-5 w-5 text-red-400 inline-block" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
