import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  BarChart3, 
  Users, 
  Calendar, 
  TrendingUp,
  DollarSign,
  ShoppingCart,
  Search,
  ArrowLeft,
  Filter
} from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths, parseISO, isWithinInterval, startOfDay, endOfDay } from "date-fns";
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
  const [activeTab, setActiveTab] = useState<'by-attendant' | 'by-day'>('by-attendant');
  
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  const currentMonthEnd = endOfMonth(now);
  const previousMonthStart = startOfMonth(subMonths(now, 1));
  const previousMonthEnd = endOfMonth(subMonths(now, 1));
  
  const monthStart = selectedMonth === 'current' ? currentMonthStart : previousMonthStart;
  const monthEnd = selectedMonth === 'current' ? currentMonthEnd : previousMonthEnd;
  
  const [attendantStartDate, setAttendantStartDate] = useState(format(monthStart, 'yyyy-MM-dd'));
  const [attendantEndDate, setAttendantEndDate] = useState(format(monthEnd > now ? now : monthEnd, 'yyyy-MM-dd'));
  const [selectedAttendant, setSelectedAttendant] = useState<string>('all');
  
  const getUTCBoundary = (date: Date, isEnd: boolean) => {
    const d = new Date(date);
    if (isEnd) {
      d.setHours(23, 59, 59, 999);
    } else {
      d.setHours(0, 0, 0, 0);
    }
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

  const uniqueAttendants = useMemo(() => {
    const attendants = new Map<string, string>();
    for (const log of allLogs) {
      if (!attendants.has(log.attendant_id)) {
        attendants.set(log.attendant_id, log.attendant_name);
      }
    }
    return Array.from(attendants.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allLogs]);

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
      byAttendant: Object.entries(byAttendant).map(([id, data]) => ({ id, ...data })).sort((a, b) => b.total - a.total),
      byDay: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date))
    };
  }, [allLogs]);

  const filteredAttendantDays = useMemo(() => {
    const startFilter = startOfDay(parseISO(attendantStartDate));
    const endFilter = endOfDay(parseISO(attendantEndDate));
    
    const byAttendantDay: Record<string, Record<string, { date: string; total: number; byType: Record<ServiceType, number> }>> = {};
    
    for (const log of allLogs) {
      const logDate = parseISO(log.attendance_date);
      if (!isWithinInterval(logDate, { start: startFilter, end: endFilter })) continue;
      
      const attendantId = log.attendant_id;
      const dateKey = format(logDate, 'yyyy-MM-dd');
      const type = (log.service_type || 'prospecao') as ServiceType;
      
      if (!byAttendantDay[attendantId]) {
        byAttendantDay[attendantId] = {};
      }
      
      if (!byAttendantDay[attendantId][dateKey]) {
        byAttendantDay[attendantId][dateKey] = {
          date: dateKey,
          total: 0,
          byType: { debito_vencido: 0, venda: 0, prospecao: 0 }
        };
      }
      
      byAttendantDay[attendantId][dateKey].total++;
      byAttendantDay[attendantId][dateKey].byType[type]++;
    }
    
    return stats.byAttendant.map(attendant => ({
      ...attendant,
      days: Object.values(byAttendantDay[attendant.id] || {}).sort((a, b) => b.date.localeCompare(a.date))
    }));
  }, [allLogs, attendantStartDate, attendantEndDate, stats.byAttendant]);

  const filteredDaysByAttendant = useMemo(() => {
    if (selectedAttendant === 'all') {
      return stats.byDay;
    }
    
    const filteredByDay: Record<string, { date: string; total: number; byType: Record<ServiceType, number> }> = {};
    
    for (const log of allLogs) {
      if (log.attendant_id !== selectedAttendant) continue;
      
      const type = (log.service_type || 'prospecao') as ServiceType;
      const dateKey = format(parseISO(log.attendance_date), 'yyyy-MM-dd');
      
      if (!filteredByDay[dateKey]) {
        filteredByDay[dateKey] = {
          date: dateKey,
          total: 0,
          byType: { debito_vencido: 0, venda: 0, prospecao: 0 }
        };
      }
      filteredByDay[dateKey].total++;
      filteredByDay[dateKey].byType[type]++;
    }
    
    return Object.values(filteredByDay).sort((a, b) => b.date.localeCompare(a.date));
  }, [allLogs, selectedAttendant, stats.byDay]);

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
        
        <Select value={selectedMonth} onValueChange={(v) => {
          setSelectedMonth(v as 'current' | 'previous');
          const newMonthStart = v === 'current' ? currentMonthStart : previousMonthStart;
          const newMonthEnd = v === 'current' ? currentMonthEnd : previousMonthEnd;
          setAttendantStartDate(format(newMonthStart, 'yyyy-MM-dd'));
          setAttendantEndDate(format(newMonthEnd > now ? now : newMonthEnd, 'yyyy-MM-dd'));
        }}>
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

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'by-attendant' | 'by-day')} className="space-y-4">
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
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    Atendimentos por Atendente
                  </CardTitle>
                  <CardDescription>
                    Detalhamento diário por atendente no período selecionado
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Período:</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="startDate" className="text-sm">De:</Label>
                    <Input
                      id="startDate"
                      type="date"
                      value={attendantStartDate}
                      onChange={(e) => setAttendantStartDate(e.target.value)}
                      className="w-[150px]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="endDate" className="text-sm">Até:</Label>
                    <Input
                      id="endDate"
                      type="date"
                      value={attendantEndDate}
                      onChange={(e) => setAttendantEndDate(e.target.value)}
                      className="w-[150px]"
                    />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {filteredAttendantDays.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Nenhum atendimento registrado neste período
                </div>
              ) : (
                filteredAttendantDays.map((attendant) => (
                  <div key={attendant.id} className="border rounded-lg p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                          <Users className="h-5 w-5 text-blue-600" />
                        </div>
                        <div>
                          <h3 className="font-semibold">{attendant.name}</h3>
                          <p className="text-sm text-muted-foreground">
                            {attendant.days.reduce((sum, d) => sum + d.total, 0)} atendimentos no período
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Badge className="bg-red-100 text-red-700 border-red-200">
                          {attendant.days.reduce((sum, d) => sum + d.byType.debito_vencido, 0)} Débitos
                        </Badge>
                        <Badge className="bg-green-100 text-green-700 border-green-200">
                          {attendant.days.reduce((sum, d) => sum + d.byType.venda, 0)} Vendas
                        </Badge>
                        <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                          {attendant.days.reduce((sum, d) => sum + d.byType.prospecao, 0)} Prosp.
                        </Badge>
                      </div>
                    </div>
                    
                    {attendant.days.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-2">
                        Sem atendimentos no período selecionado
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Data</TableHead>
                            <TableHead className="text-center text-red-600">Débito</TableHead>
                            <TableHead className="text-center text-green-600">Venda</TableHead>
                            <TableHead className="text-center text-purple-600">Prospecção</TableHead>
                            <TableHead className="text-center">Total</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {attendant.days.map((day) => (
                            <TableRow key={day.date}>
                              <TableCell className="font-medium">
                                {format(parseISO(day.date), "dd/MM/yyyy (EEE)", { locale: ptBR })}
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
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="by-day">
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="h-5 w-5" />
                    Atendimentos por Dia
                  </CardTitle>
                  <CardDescription>
                    Histórico diário de atendimentos virtuais
                  </CardDescription>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Atendente:</span>
                  </div>
                  <Select value={selectedAttendant} onValueChange={setSelectedAttendant}>
                    <SelectTrigger className="w-[250px]">
                      <SelectValue placeholder="Todos os atendentes" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos os atendentes</SelectItem>
                      {uniqueAttendants.map((att) => (
                        <SelectItem key={att.id} value={att.id}>
                          {att.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {filteredDaysByAttendant.length === 0 ? (
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
                    {filteredDaysByAttendant.map((day) => (
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
