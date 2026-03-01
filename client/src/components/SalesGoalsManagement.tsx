import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Plus, Pencil, Trash2, DollarSign, Users, TrendingUp, Calendar } from "lucide-react";
import SalesGoalsDashboard from './SalesGoalsDashboard';
import type { SalesGoal, User } from "@shared/schema";

interface SalesGoalsManagementProps {
  user: User;
}

const SELLER_TYPE_LABELS: Record<string, string> = {
  vendedor_clt: 'Externo CLT',
  vendedor_pj: 'Externo PJ',
  telemarketing: 'Telemarketing',
};

const SELLER_TYPE_COLORS: Record<string, string> = {
  vendedor_clt: 'bg-blue-100 text-blue-800',
  vendedor_pj: 'bg-purple-100 text-purple-800',
  telemarketing: 'bg-amber-100 text-amber-800',
};

const months = [
  { value: 1, label: 'Janeiro' },
  { value: 2, label: 'Fevereiro' },
  { value: 3, label: 'Março' },
  { value: 4, label: 'Abril' },
  { value: 5, label: 'Maio' },
  { value: 6, label: 'Junho' },
  { value: 7, label: 'Julho' },
  { value: 8, label: 'Agosto' },
  { value: 9, label: 'Setembro' },
  { value: 10, label: 'Outubro' },
  { value: 11, label: 'Novembro' },
  { value: 12, label: 'Dezembro' },
];

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

interface CommissionDashboardData {
  sellers: Array<{
    sellerId: string;
    sellerName: string;
    revenueGoal: number;
    revenueActual: number;
    revenueProjected: number;
    achievementPct: number;
  }>;
  telemarketing?: {
    sellerId: string;
    sellerName: string;
    revenueGoal: number;
    revenueActual: number;
    revenueProjected: number;
    achievementPct: number;
  };
  workingDaysElapsed: number;
  workingDaysInMonth: number;
}

interface YearlySummaryData {
  year: number;
  sellers: Array<{
    sellerId: string;
    sellerName: string;
    months: Record<number, { goal: number; actual: number }>;
    totalGoal: number;
    totalActual: number;
  }>;
}

export default function SalesGoalsManagement({ user }: SalesGoalsManagementProps) {
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SalesGoal | null>(null);
  const [selectedSellerId, setSelectedSellerId] = useState<string>('');
  const [revenueGoalValue, setRevenueGoalValue] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ['/api/users'],
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role),
  });

  const { data: salesGoals = [], isLoading } = useQuery<SalesGoal[]>({
    queryKey: ['/api/sales-goals', selectedMonth, selectedYear],
    queryFn: () => fetch(`/api/sales-goals?month=${selectedMonth}&year=${selectedYear}`).then(r => r.json()),
  });

  const { data: dashboardData } = useQuery<CommissionDashboardData>({
    queryKey: ['/api/sales-goals/commission-dashboard', selectedMonth, selectedYear],
    queryFn: async () => {
      const params = new URLSearchParams({ month: selectedMonth.toString(), year: selectedYear.toString() });
      const res = await fetch(`/api/sales-goals/commission-dashboard?${params}`, { credentials: 'include' });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role),
  });

  const { data: yearlySummary } = useQuery<YearlySummaryData>({
    queryKey: ['/api/sales-goals/yearly-summary', selectedYear],
    queryFn: async () => {
      const res = await fetch(`/api/sales-goals/yearly-summary?year=${selectedYear}`, { credentials: 'include' });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role),
  });

  const metricsMap = useMemo(() => {
    const map: Record<string, { actual: number; projected: number; achievement: number }> = {};
    if (dashboardData) {
      for (const s of dashboardData.sellers) {
        map[s.sellerId] = { actual: s.revenueActual, projected: s.revenueProjected, achievement: s.achievementPct };
      }
      if (dashboardData.telemarketing) {
        map[dashboardData.telemarketing.sellerId] = {
          actual: dashboardData.telemarketing.revenueActual,
          projected: dashboardData.telemarketing.revenueProjected,
          achievement: dashboardData.telemarketing.achievementPct,
        };
      }
    }
    return map;
  }, [dashboardData]);

  const activeSellers = allUsers.filter(
    (u: User) => u.isActive && ['vendedor', 'telemarketing'].includes(u.role)
  );

  const individualSellers = activeSellers.filter((u: User) => u.role !== 'telemarketing' && u.sellerType !== 'telemarketing');
  const telemarketingUsers = activeSellers.filter((u: User) => u.role === 'telemarketing' || u.sellerType === 'telemarketing');

  const createGoalMutation = useMutation({
    mutationFn: (goalData: any) => {
      if (editingGoal) {
        return apiRequest('PUT', `/api/sales-goals/${editingGoal.id}`, goalData);
      }
      return apiRequest('POST', '/api/sales-goals', goalData);
    },
    onSuccess: () => {
      toast({
        title: editingGoal ? "Meta atualizada" : "Meta salva",
        description: "A meta de faturamento foi salva com sucesso.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals/commission-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals/yearly-summary'] });
      setIsDialogOpen(false);
      setEditingGoal(null);
      setSelectedSellerId('');
      setRevenueGoalValue('');
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao salvar meta.",
        variant: "destructive",
      });
    },
  });

  const deleteGoalMutation = useMutation({
    mutationFn: (goalId: string) => apiRequest('DELETE', `/api/sales-goals/${goalId}`),
    onSuccess: () => {
      toast({ title: "Meta deletada" });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals/commission-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals/yearly-summary'] });
    },
    onError: () => {
      toast({ title: "Erro", description: "Erro ao deletar meta.", variant: "destructive" });
    },
  });

  const canManage = ['admin', 'coordinator', 'administrative'].includes(user.role);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSellerId || !revenueGoalValue) return;
    createGoalMutation.mutate({
      sellerId: selectedSellerId,
      month: selectedMonth,
      year: selectedYear,
      revenueGoal: parseFloat(revenueGoalValue),
    });
  };

  const openNewGoal = () => {
    setEditingGoal(null);
    setSelectedSellerId('');
    setRevenueGoalValue('');
    setIsDialogOpen(true);
  };

  const openEditGoal = (goal: SalesGoal) => {
    setEditingGoal(goal);
    setSelectedSellerId(goal.sellerId);
    setRevenueGoalValue(goal.revenueGoal?.toString() || '');
    setIsDialogOpen(true);
  };

  const getSellerName = (sellerId: string) => {
    if (sellerId === 'TELEMARKETING') return 'Vendas Internas (Telemarketing)';
    const u = allUsers.find((u: User) => u.id === sellerId);
    return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : sellerId;
  };

  const getSellerType = (sellerId: string) => {
    if (sellerId === 'TELEMARKETING') return 'telemarketing';
    const u = allUsers.find((u: User) => u.id === sellerId);
    return u?.sellerType || '';
  };

  const totalGoal = salesGoals.reduce((s, g) => s + parseFloat(g.revenueGoal?.toString() || '0'), 0);
  const totalActual = salesGoals.reduce((s, g) => s + (metricsMap[g.sellerId]?.actual || 0), 0);
  const totalProjected = salesGoals.reduce((s, g) => s + (metricsMap[g.sellerId]?.projected || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">
          {user.role === 'vendedor' || user.role === 'telemarketing' ? 'Minhas Metas' : 'Metas de Vendas'}
        </h2>
      </div>

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Gerenciar Metas de Faturamento
                </CardTitle>
                <CardDescription>
                  Defina a meta de faturamento mensal para cada vendedor ou equipe de telemarketing.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedMonth.toString()} onValueChange={(v) => setSelectedMonth(parseInt(v))}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {months.map((m) => (
                      <SelectItem key={m.value} value={m.value.toString()}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedYear.toString()} onValueChange={(v) => setSelectedYear(parseInt(v))}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {years.map((y) => (
                      <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={openNewGoal} size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Nova Meta
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : salesGoals.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p>Nenhuma meta configurada para {months.find(m => m.value === selectedMonth)?.label}/{selectedYear}.</p>
                <p className="text-sm">Clique em "Nova Meta" para começar.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendedor</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Meta</TableHead>
                    <TableHead className="text-right">Fat. Atual</TableHead>
                    <TableHead className="text-right">Projeção</TableHead>
                    <TableHead className="text-right">% Ating.</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesGoals.map((goal) => {
                    const type = getSellerType(goal.sellerId);
                    const metrics = metricsMap[goal.sellerId];
                    const goalValue = parseFloat(goal.revenueGoal?.toString() || '0');
                    const actual = metrics?.actual || 0;
                    const projected = metrics?.projected || 0;
                    const achievement = goalValue > 0 ? (projected / goalValue) * 100 : 0;
                    return (
                      <TableRow key={goal.id}>
                        <TableCell className="font-medium">{getSellerName(goal.sellerId)}</TableCell>
                        <TableCell>
                          {type && (
                            <Badge className={SELLER_TYPE_COLORS[type] || 'bg-gray-100'}>
                              {SELLER_TYPE_LABELS[type] || type}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {goalValue > 0 ? formatCurrency(goalValue) : '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(actual)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          <span className={projected >= goalValue && goalValue > 0 ? 'text-green-600 font-semibold' : projected > 0 ? 'text-amber-600' : ''}>
                            {formatCurrency(projected)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {goalValue > 0 ? (
                            <div className="flex items-center justify-end gap-2">
                              <Progress value={Math.min(achievement, 100)} className="w-16 h-2" />
                              <span className={`text-sm font-mono ${achievement >= 100 ? 'text-green-600 font-semibold' : 'text-muted-foreground'}`}>
                                {achievement.toFixed(1)}%
                              </span>
                            </div>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openEditGoal(goal)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { if (confirm('Deletar esta meta?')) deleteGoalMutation.mutate(goal.id); }}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                {salesGoals.length > 1 && (
                  <TableFooter>
                    <TableRow className="bg-muted/50 font-semibold">
                      <TableCell colSpan={2}>Total</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(totalGoal)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(totalActual)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(totalProjected)}</TableCell>
                      <TableCell className="text-right">
                        {totalGoal > 0 ? (
                          <span className={`text-sm font-mono ${(totalProjected / totalGoal) * 100 >= 100 ? 'text-green-600' : ''}`}>
                            {((totalProjected / totalGoal) * 100).toFixed(1)}%
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <SalesGoalsDashboard user={user} />

      {canManage && yearlySummary && yearlySummary.sellers.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Resumo Anual {selectedYear}
            </CardTitle>
            <CardDescription>
              Metas e execução acumuladas do ano para cada vendedor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendedor</TableHead>
                  {months.map(m => (
                    <TableHead key={m.value} className="text-center text-xs px-1 min-w-[70px]">
                      {m.label.slice(0, 3)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total Meta</TableHead>
                  <TableHead className="text-right">Total Exec.</TableHead>
                  <TableHead className="text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yearlySummary.sellers.map(seller => {
                  const pct = seller.totalGoal > 0 ? (seller.totalActual / seller.totalGoal) * 100 : 0;
                  return (
                    <TableRow key={seller.sellerId}>
                      <TableCell className="font-medium whitespace-nowrap">{seller.sellerName}</TableCell>
                      {months.map(m => {
                        const data = seller.months[m.value];
                        if (!data) return <TableCell key={m.value} className="text-center text-xs text-muted-foreground px-1">—</TableCell>;
                        const cellPct = data.goal > 0 ? (data.actual / data.goal) * 100 : 0;
                        return (
                          <TableCell key={m.value} className="text-center text-xs px-1">
                            <div title={`Meta: ${formatCurrency(data.goal)} | Exec: ${formatCurrency(data.actual)}`}>
                              {data.actual > 0 ? (
                                <span className={cellPct >= 100 ? 'text-green-600 font-semibold' : cellPct >= 80 ? 'text-amber-600' : 'text-red-500'}>
                                  {cellPct.toFixed(0)}%
                                </span>
                              ) : data.goal > 0 ? (
                                <span className="text-muted-foreground">0%</span>
                              ) : '—'}
                            </div>
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(seller.totalGoal)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(seller.totalActual)}</TableCell>
                      <TableCell className="text-right">
                        {seller.totalGoal > 0 ? (
                          <span className={`text-sm font-mono font-semibold ${pct >= 100 ? 'text-green-600' : pct >= 80 ? 'text-amber-600' : 'text-red-500'}`}>
                            {pct.toFixed(1)}%
                          </span>
                        ) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell>Total Geral</TableCell>
                  {months.map(m => {
                    let mGoal = 0, mActual = 0;
                    for (const s of yearlySummary.sellers) {
                      if (s.months[m.value]) {
                        mGoal += s.months[m.value].goal;
                        mActual += s.months[m.value].actual;
                      }
                    }
                    const mPct = mGoal > 0 ? (mActual / mGoal) * 100 : 0;
                    return (
                      <TableCell key={m.value} className="text-center text-xs px-1">
                        {mGoal > 0 ? (
                          <span className={mPct >= 100 ? 'text-green-600 font-semibold' : mPct >= 80 ? 'text-amber-600' : mActual > 0 ? 'text-red-500' : 'text-muted-foreground'}>
                            {mActual > 0 ? `${mPct.toFixed(0)}%` : '0%'}
                          </span>
                        ) : '—'}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(yearlySummary.sellers.reduce((s, v) => s + v.totalGoal, 0))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(yearlySummary.sellers.reduce((s, v) => s + v.totalActual, 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {(() => {
                      const tg = yearlySummary.sellers.reduce((s, v) => s + v.totalGoal, 0);
                      const ta = yearlySummary.sellers.reduce((s, v) => s + v.totalActual, 0);
                      const p = tg > 0 ? (ta / tg) * 100 : 0;
                      return tg > 0 ? <span className={`text-sm font-mono font-semibold ${p >= 100 ? 'text-green-600' : 'text-amber-600'}`}>{p.toFixed(1)}%</span> : '—';
                    })()}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{editingGoal ? 'Editar Meta' : 'Nova Meta de Faturamento'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Vendedor / Equipe</Label>
              <Select value={selectedSellerId} onValueChange={setSelectedSellerId} required>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {individualSellers.map((s: User) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.firstName} {s.lastName}
                      {s.sellerType && (
                        <span className="text-xs text-muted-foreground ml-2">
                          ({SELLER_TYPE_LABELS[s.sellerType] || s.sellerType})
                        </span>
                      )}
                    </SelectItem>
                  ))}
                  {telemarketingUsers.length > 0 && (
                    <SelectItem value="TELEMARKETING">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4" />
                        Vendas Internas (Telemarketing)
                        <span className="text-xs text-muted-foreground">({telemarketingUsers.length} membros)</span>
                      </div>
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="revenueGoal">Meta de Faturamento (R$)</Label>
              <Input
                id="revenueGoal"
                type="number"
                step="0.01"
                min="0"
                placeholder="50000.00"
                value={revenueGoalValue}
                onChange={(e) => setRevenueGoalValue(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={createGoalMutation.isPending}>
                {createGoalMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {editingGoal ? 'Salvar' : 'Criar Meta'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
