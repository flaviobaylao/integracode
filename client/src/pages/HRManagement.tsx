import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, Route, Clock, TrendingUp, Calendar, Home } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export default function HRManagement() {
  console.log('✅ HRManagement component rendered!');
  
  const { user } = useAuth();
  const currentDate = new Date();
  const [selectedMonth, setSelectedMonth] = useState((currentDate.getMonth() + 1).toString());
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear().toString());

  // Apenas roles administrativos veem todos os dados
  const isAdmin = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');

  // Buscar dados de quilometragem (backend agora filtra por vendedor)
  const { data: mileageData, isLoading: isLoadingMileage } = useQuery({
    queryKey: ['/api/hr/monthly-mileage', selectedMonth, selectedYear],
    queryFn: async () => {
      const res = await fetch(`/api/hr/monthly-mileage?month=${selectedMonth}&year=${selectedYear}`);
      if (!res.ok) throw new Error('Erro ao buscar quilometragem');
      return res.json();
    },
    enabled: !!selectedMonth && !!selectedYear
  });

  // Buscar dados de carga horária (backend agora filtra por vendedor)
  const { data: hoursData, isLoading: isLoadingHours } = useQuery({
    queryKey: ['/api/hr/monthly-hours', selectedMonth, selectedYear],
    queryFn: async () => {
      const res = await fetch(`/api/hr/monthly-hours?month=${selectedMonth}&year=${selectedYear}`);
      if (!res.ok) throw new Error('Erro ao buscar carga horária');
      return res.json();
    },
    enabled: !!selectedMonth && !!selectedYear
  });

  const months = [
    { value: '1', label: 'Janeiro' },
    { value: '2', label: 'Fevereiro' },
    { value: '3', label: 'Março' },
    { value: '4', label: 'Abril' },
    { value: '5', label: 'Maio' },
    { value: '6', label: 'Junho' },
    { value: '7', label: 'Julho' },
    { value: '8', label: 'Agosto' },
    { value: '9', label: 'Setembro' },
    { value: '10', label: 'Outubro' },
    { value: '11', label: 'Novembro' },
    { value: '12', label: 'Dezembro' }
  ];

  const years = Array.from({ length: 5 }, (_, i) => {
    const year = currentDate.getFullYear() - i;
    return { value: year.toString(), label: year.toString() };
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="mb-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.href = '/'}
          className="flex items-center gap-2"
          data-testid="button-back-dashboard"
        >
          <Home className="h-4 w-4" />
          Voltar ao Dashboard
        </Button>
      </div>
      
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="title-rh">
            <Users className="h-8 w-8 text-honest-blue" />
            {!isAdmin ? 'Minhas Métricas' : 'Recursos Humanos'}
          </h1>
          <p className="text-muted-foreground mt-1">
            {!isAdmin 
              ? 'Acompanhe sua quilometragem e carga horária'
              : 'Controle de quilometragem e carga horária dos vendedores'}
          </p>
        </div>

        <div className="flex gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-gray-500" />
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger className="w-[140px]" data-testid="select-month">
                <SelectValue placeholder="Mês" />
              </SelectTrigger>
              <SelectContent>
                {months.map(month => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Select value={selectedYear} onValueChange={setSelectedYear}>
            <SelectTrigger className="w-[100px]" data-testid="select-year">
              <SelectValue placeholder="Ano" />
            </SelectTrigger>
            <SelectContent>
              {years.map(year => (
                <SelectItem key={year.value} value={year.value}>
                  {year.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue="mileage" className="space-y-4">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="mileage" data-testid="tab-mileage">
            <Route className="h-4 w-4 mr-2" />
            Quilometragem
          </TabsTrigger>
          <TabsTrigger value="hours" data-testid="tab-hours">
            <Clock className="h-4 w-4 mr-2" />
            Carga Horária
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mileage" className="space-y-4">
          {isLoadingMileage ? (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center text-muted-foreground">Carregando dados...</div>
              </CardContent>
            </Card>
          ) : !mileageData || mileageData.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center text-muted-foreground">
                  Nenhum dado de quilometragem encontrado para este período
                </div>
              </CardContent>
            </Card>
          ) : (
            mileageData.map((seller: any) => (
              <Card key={seller.sellerId}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>{seller.sellerName}</span>
                    <span className="text-2xl font-bold text-honest-blue">
                      {seller.totalDistance.toFixed(2)} km
                    </span>
                  </CardTitle>
                  <CardDescription>{seller.sellerEmail}</CardDescription>
                </CardHeader>
                <CardContent>
                  {seller.dailyData.length === 0 ? (
                    <div className="text-center text-muted-foreground py-4">
                      Nenhuma rota registrada neste mês
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Data</TableHead>
                            <TableHead>Dia da Semana</TableHead>
                            <TableHead className="text-right">Distância (km)</TableHead>
                            <TableHead className="text-right">Visitas Completadas</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {seller.dailyData.map((day: any, idx: number) => (
                            <TableRow key={idx} data-testid={`row-mileage-${idx}`}>
                              <TableCell>
                                {format(new Date(day.date), "dd/MM/yyyy", { locale: ptBR })}
                              </TableCell>
                              <TableCell>
                                {format(new Date(day.date), "EEEE", { locale: ptBR })}
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {day.distance.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-right">{day.visits}</TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-muted/50 font-bold">
                            <TableCell colSpan={2}>Total do Mês</TableCell>
                            <TableCell className="text-right text-honest-blue">
                              {seller.totalDistance.toFixed(2)} km
                            </TableCell>
                            <TableCell className="text-right">
                              {seller.dailyData.reduce((sum: number, d: any) => sum + d.visits, 0)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="hours" className="space-y-4">
          {isLoadingHours ? (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center text-muted-foreground">Carregando dados...</div>
              </CardContent>
            </Card>
          ) : !hoursData || hoursData.length === 0 ? (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center text-muted-foreground">
                  Nenhum dado de carga horária encontrado para este período
                </div>
              </CardContent>
            </Card>
          ) : (
            hoursData.map((seller: any) => (
              <Card key={seller.sellerId}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>{seller.sellerName}</span>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-normal text-muted-foreground">
                        Meta: {seller.totalExpectedHours}h
                      </span>
                      <span className={`text-2xl font-bold ${
                        seller.totalDifference >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {seller.totalMonthlyHours.toFixed(2)}h
                        {seller.totalDifference !== 0 && (
                          <span className="text-sm ml-2">
                            ({seller.totalDifference > 0 ? '+' : ''}{seller.totalDifference.toFixed(2)}h)
                          </span>
                        )}
                      </span>
                    </div>
                  </CardTitle>
                  <CardDescription>{seller.sellerEmail}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Dados Diários */}
                  {seller.dailyData.length === 0 ? (
                    <div className="text-center text-muted-foreground py-4">
                      Nenhum check-in registrado neste mês
                    </div>
                  ) : (
                    <div>
                      <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <Calendar className="h-4 w-4" />
                        Registro Diário
                      </h3>
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Data</TableHead>
                              <TableHead>Dia</TableHead>
                              <TableHead>1º Check-in</TableHead>
                              <TableHead>Último Check-out</TableHead>
                              <TableHead className="text-right">Horas Trabalhadas</TableHead>
                              <TableHead className="text-right">Meta</TableHead>
                              <TableHead className="text-right">Diferença</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {seller.dailyData.map((day: any, idx: number) => (
                              <TableRow key={idx} data-testid={`row-hours-${idx}`}>
                                <TableCell>
                                  {format(new Date(day.date), "dd/MM/yyyy", { locale: ptBR })}
                                </TableCell>
                                <TableCell className="font-medium">{day.dayOfWeek}</TableCell>
                                <TableCell>
                                  {day.firstCheckIn 
                                    ? format(new Date(day.firstCheckIn), "HH:mm", { locale: ptBR })
                                    : '-'
                                  }
                                </TableCell>
                                <TableCell>
                                  {day.lastCheckOut 
                                    ? format(new Date(day.lastCheckOut), "HH:mm", { locale: ptBR })
                                    : '-'
                                  }
                                </TableCell>
                                <TableCell className="text-right font-medium">
                                  {day.hoursWorked.toFixed(2)}h
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {day.expectedHours}h
                                </TableCell>
                                <TableCell className={`text-right font-medium ${
                                  day.difference >= 0 ? 'text-green-600' : 'text-red-600'
                                }`}>
                                  {day.difference > 0 ? '+' : ''}{day.difference.toFixed(2)}h
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {/* Totais Semanais */}
                  {seller.weeklyTotals && seller.weeklyTotals.length > 0 && (
                    <div>
                      <h3 className="font-semibold mb-3 flex items-center gap-2">
                        <TrendingUp className="h-4 w-4" />
                        Totais Semanais (Meta: 44h/semana)
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {seller.weeklyTotals.map((week: any) => (
                          <Card key={week.weekNumber} className="bg-muted/30">
                            <CardHeader className="pb-3">
                              <CardTitle className="text-sm">
                                Semana {week.weekNumber}
                              </CardTitle>
                            </CardHeader>
                            <CardContent>
                              <div className="space-y-1">
                                <div className="flex justify-between text-sm">
                                  <span className="text-muted-foreground">Trabalhadas:</span>
                                  <span className="font-bold">{week.hoursWorked.toFixed(2)}h</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                  <span className="text-muted-foreground">Meta:</span>
                                  <span>{week.expectedHours.toFixed(2)}h</span>
                                </div>
                                <div className={`flex justify-between text-sm font-medium ${
                                  week.difference >= 0 ? 'text-green-600' : 'text-red-600'
                                }`}>
                                  <span>Diferença:</span>
                                  <span>
                                    {week.difference > 0 ? '+' : ''}{week.difference.toFixed(2)}h
                                  </span>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
