import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  BarChart3, 
  Users, 
  Calendar, 
  TrendingUp,
  DollarSign,
  ShoppingCart,
  Search,
  ArrowLeft
} from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths, eachDayOfInterval, isSameDay, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

type ServiceType = 'debito_vencido' | 'venda' | 'prospecao';

interface ServiceLog {
  id: string;
  customer_id: string;
  entity_type: string;
  attendant_id: string;
  attendant_name: string;
  attendance_date: string;
  service_type: ServiceType | null;
  notes: string | null;
  images: string[];
  created_at: string;
}

const serviceTypeConfig: Record<ServiceType, { label: string; color: string; bgColor: string; icon: typeof DollarSign }> = {
  debito_vencido: { 
    label: 'Débito Vencido', 
    color: 'text-red-700 dark:text-red-400', 
    bgColor: 'bg-red-100 dark:bg-red-900/30 border-red-200 dark:border-red-800',
    icon: DollarSign 
  },
  venda: { 
    label: 'Venda', 
    color: 'text-green-700 dark:text-green-400', 
    bgColor: 'bg-green-100 dark:bg-green-900/30 border-green-200 dark:border-green-800',
    icon: ShoppingCart 
  },
  prospecao: { 
    label: 'Prospecção', 
    color: 'text-purple-700 dark:text-purple-400', 
    bgColor: 'bg-purple-100 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800',
    icon: Search 
  },
};

export default function VendasDigitais() {
  const [selectedMonth, setSelectedMonth] = useState<'current' | 'previous'>('current');
  
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  const currentMonthEnd = endOfMonth(now);
  const previousMonthStart = startOfMonth(subMonths(now, 1));
  const previousMonthEnd = endOfMonth(subMonths(now, 1));
  
  const monthStart = selectedMonth === 'current' ? currentMonthStart : previousMonthStart;
  const monthEnd = selectedMonth === 'current' ? currentMonthEnd : previousMonthEnd;
  
  // Create explicit UTC boundaries for the month (Brazil timezone is UTC-3)
  const getUTCBoundary = (date: Date, isEnd: boolean) => {
    const d = new Date(date);
    if (isEnd) {
      d.setHours(23, 59, 59, 999);
    } else {
      d.setHours(0, 0, 0, 0);
    }
    // Add 3 hours to convert from Brazil time to UTC
    d.setHours(d.getHours() + 3);
    return d.toISOString();
  };
  
  const { data: allLogs = [], isLoading } = useQuery<ServiceLog[]>({
    queryKey: ["/api/service-logs/all", selectedMonth],
    queryFn: async () => {
      const startDateUTC = getUTCBoundary(monthStart, false);
      const endDateUTC = getUTCBoundary(monthEnd, true);
      const response = await fetch(`/api/service-logs/all?startDate=${startDateUTC}&endDate=${endDateUTC}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch logs');
      return response.json();
    }
  });

  const stats = useMemo(() => {
    const byType: Record<ServiceType, number> = {
      debito_vencido: 0,
      venda: 0,
      prospecao: 0
    };
    
    const byAttendant: Record<string, { name: string; total: number; byType: Record<ServiceType, number> }> = {};
    const byDay: Record<string, { date: string; total: number; byType: Record<ServiceType, number> }> = {};
    
    for (const log of allLogs) {
      const type = (log.service_type || 'prospecao') as ServiceType;
      byType[type]++;
      
      if (!byAttendant[log.attendant_id]) {
        byAttendant[log.attendant_id] = {
          name: log.attendant_name,
          total: 0,
          byType: { debito_vencido: 0, venda: 0, prospecao: 0 }
        };
      }
      byAttendant[log.attendant_id].total++;
      byAttendant[log.attendant_id].byType[type]++;
      
      const dateKey = format(parseISO(log.attendance_date), 'yyyy-MM-dd');
      if (!byDay[dateKey]) {
        byDay[dateKey] = {
          date: dateKey,
          total: 0,
          byType: { debito_vencido: 0, venda: 0, prospecao: 0 }
        };
      }
      byDay[dateKey].total++;
      byDay[dateKey].byType[type]++;
    }
    
    return {
      total: allLogs.length,
      byType,
      byAttendant: Object.values(byAttendant).sort((a, b) => b.total - a.total),
      byDay: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date))
    };
  }, [allLogs]);

  const daysInMonth = useMemo(() => {
    return eachDayOfInterval({ start: monthStart, end: new Date() > monthEnd ? monthEnd : new Date() });
  }, [monthStart, monthEnd]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-6 px-4 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="h-6 w-6" />
              Vendas Digitais
            </h1>
            <p className="text-muted-foreground text-sm">
              Estatísticas de atendimentos virtuais
            </p>
          </div>
        </div>
        
        <Select value={selectedMonth} onValueChange={(v) => setSelectedMonth(v as 'current' | 'previous')}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">
              {format(currentMonthStart, 'MMMM yyyy', { locale: ptBR })}
            </SelectItem>
            <SelectItem value="previous">
              {format(previousMonthStart, 'MMMM yyyy', { locale: ptBR })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total de Atendimentos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-8 w-8 text-blue-500" />
              <span className="text-3xl font-bold">{stats.total}</span>
            </div>
          </CardContent>
        </Card>

        <Card className={serviceTypeConfig.debito_vencido.bgColor}>
          <CardHeader className="pb-2">
            <CardTitle className={`text-sm font-medium ${serviceTypeConfig.debito_vencido.color}`}>
              Débito Vencido
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <DollarSign className={`h-8 w-8 ${serviceTypeConfig.debito_vencido.color}`} />
              <span className={`text-3xl font-bold ${serviceTypeConfig.debito_vencido.color}`}>
                {stats.byType.debito_vencido}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className={serviceTypeConfig.venda.bgColor}>
          <CardHeader className="pb-2">
            <CardTitle className={`text-sm font-medium ${serviceTypeConfig.venda.color}`}>
              Venda
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <ShoppingCart className={`h-8 w-8 ${serviceTypeConfig.venda.color}`} />
              <span className={`text-3xl font-bold ${serviceTypeConfig.venda.color}`}>
                {stats.byType.venda}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className={serviceTypeConfig.prospecao.bgColor}>
          <CardHeader className="pb-2">
            <CardTitle className={`text-sm font-medium ${serviceTypeConfig.prospecao.color}`}>
              Prospecção
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Search className={`h-8 w-8 ${serviceTypeConfig.prospecao.color}`} />
              <span className={`text-3xl font-bold ${serviceTypeConfig.prospecao.color}`}>
                {stats.byType.prospecao}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="by-attendant" className="space-y-4">
        <TabsList>
          <TabsTrigger value="by-attendant" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Por Atendente
          </TabsTrigger>
          <TabsTrigger value="by-day" className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Por Dia
          </TabsTrigger>
        </TabsList>

        <TabsContent value="by-attendant">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Atendimentos por Atendente
              </CardTitle>
              <CardDescription>
                Ranking de atendentes por quantidade de atendimentos virtuais
              </CardDescription>
            </CardHeader>
            <CardContent>
              {stats.byAttendant.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Nenhum atendimento registrado neste período
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Atendente</TableHead>
                      <TableHead className="text-center">
                        <span className="text-red-600">Débito</span>
                      </TableHead>
                      <TableHead className="text-center">
                        <span className="text-green-600">Venda</span>
                      </TableHead>
                      <TableHead className="text-center">
                        <span className="text-purple-600">Prospecção</span>
                      </TableHead>
                      <TableHead className="text-center">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.byAttendant.map((attendant, index) => (
                      <TableRow key={attendant.name}>
                        <TableCell className="font-medium">{index + 1}</TableCell>
                        <TableCell className="font-medium">{attendant.name}</TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-red-100 text-red-700 border-red-200 hover:bg-red-100">
                            {attendant.byType.debito_vencido}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100">
                            {attendant.byType.venda}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-100">
                            {attendant.byType.prospecao}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary" className="font-bold">
                            {attendant.total}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="by-day">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Atendimentos por Dia
              </CardTitle>
              <CardDescription>
                Histórico diário de atendimentos virtuais
              </CardDescription>
            </CardHeader>
            <CardContent>
              {stats.byDay.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Nenhum atendimento registrado neste período
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead className="text-center">
                        <span className="text-red-600">Débito</span>
                      </TableHead>
                      <TableHead className="text-center">
                        <span className="text-green-600">Venda</span>
                      </TableHead>
                      <TableHead className="text-center">
                        <span className="text-purple-600">Prospecção</span>
                      </TableHead>
                      <TableHead className="text-center">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.byDay.map((day) => (
                      <TableRow key={day.date}>
                        <TableCell className="font-medium">
                          {format(parseISO(day.date), "EEEE, dd 'de' MMMM", { locale: ptBR })}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-red-100 text-red-700 border-red-200 hover:bg-red-100">
                            {day.byType.debito_vencido}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100">
                            {day.byType.venda}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge className="bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-100">
                            {day.byType.prospecao}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary" className="font-bold">
                            {day.total}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
