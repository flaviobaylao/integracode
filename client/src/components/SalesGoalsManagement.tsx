import { useState, useMemo } from "react";
import { sortSellersByType } from "@/lib/sellerOrder";
import { regraDoVendedor, calcularComissao, descricaoRegra, TIPO_FAIXA_PADRAO, type FaixaComissao } from "@/lib/comissaoMetas";
import { usePermissions } from "@/lib/permissions";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Plus, Pencil, Trash2, DollarSign, Users, TrendingUp, Calendar, Trophy, Info } from "lucide-react";
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
  commissionTiers?: Record<string, FaixaComissao>;
  sellers: Array<{
    sellerId: string;
    sellerName: string;
    revenueGoal: number;
    revenueActual: number;
    revenueByInstance: Record<string, number>;
    revenueProjected: number;
    achievementPct: number;
  }>;
  telemarketing?: {
    sellerId: string;
    sellerName: string;
    revenueGoal: number;
    revenueActual: number;
    revenueByInstance: Record<string, number>;
    revenueProjected: number;
    achievementPct: number;
  };
  workingDaysElapsed: number;
  workingDaysInMonth: number;
  instanceLabels: Record<string, string>;
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

const CARD_METAS = "Metas de Vendas";

export default function SalesGoalsManagement({ user }: SalesGoalsManagementProps) {
  const perms = usePermissions(); // gating de ações (admin bypass / só configurados)
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SalesGoal | null>(null);
  const [selectedSellerId, setSelectedSellerId] = useState<string>('');
  const [revenueGoalValue, setRevenueGoalValue] = useState('');
  const [challengeGoalValue, setChallengeGoalValue] = useState('');
  const [challengeBonusValue, setChallengeBonusValue] = useState('');
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
    // Vendedor e telemarketing tambem precisam: sem isso as colunas de Fat. Atual,
    // Projecao e as tres de comissao apareceriam zeradas para eles. O endpoint ja
    // devolve apenas a propria linha para esses papeis.
    enabled: ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'].includes(user.role),
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

  const { data: coverageData } = useQuery<{ ok: boolean; byUser: Record<string, { planejados: number; atendidos: number; cobertura: number | null }> }>({
    queryKey: ['/api/admin/routes/coverage-weekly'],
    queryFn: async () => {
      const res = await fetch(`/api/admin/routes/coverage-weekly?days=7`, { credentials: 'include' });
      if (!res.ok) return null as any;
      return res.json();
    },
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role),
  });
  const coverageMap = coverageData?.byUser || {};

  const metricsMap = useMemo(() => {
    const map: Record<string, { actual: number; projected: number; achievement: number; byInstance: Record<string, number> }> = {};
    if (dashboardData) {
      for (const s of dashboardData.sellers) {
        map[s.sellerId] = { actual: s.revenueActual, projected: s.revenueProjected, achievement: s.achievementPct, byInstance: s.revenueByInstance || {} };
      }
      if (dashboardData.telemarketing) {
        map[dashboardData.telemarketing.sellerId] = {
          actual: dashboardData.telemarketing.revenueActual,
          projected: dashboardData.telemarketing.revenueProjected,
          achievement: dashboardData.telemarketing.achievementPct,
          byInstance: dashboardData.telemarketing.revenueByInstance || {},
        };
      }
    }
    return map;
  }, [dashboardData]);

  const instanceLabels = dashboardData?.instanceLabels || {};

  const activeSellers = allUsers.filter(
    (u: User) => u.isActive && ['vendedor', 'telemarketing'].includes(u.role)
  );

  const individualSellers = sortSellersByType(activeSellers.filter((u: User) => u.role !== 'telemarketing' && u.sellerType !== 'telemarketing'));
  const telemarketingUsers = sortSellersByType(activeSellers.filter((u: User) => u.role === 'telemarketing' || u.sellerType === 'telemarketing'));

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
  const canEdit = user.role === 'admin';
  // VISIBILIDADE DO BOX (18/08/2026): vendedor e telemarketing passam a ver o box
  // "Gerenciar Metas de Faturamento" para acompanhar a propria comissao — mas SO a
  // propria linha. Gestao (admin/coordinator/administrative) ve a equipe inteira.
  // O backend ja devolve apenas a propria meta para esses papeis; o filtro abaixo
  // e a segunda barreira, para o caso de a API passar a devolver mais.
  const isSellerRole = ['vendedor', 'telemarketing'].includes(user.role);
  const podeVerBox = canManage || isSellerRole;
  const goalsVisiveis = canManage ? salesGoals : salesGoals.filter((g) => g.sellerId === user.id);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSellerId || !revenueGoalValue) return;
    createGoalMutation.mutate({
      sellerId: selectedSellerId,
      month: selectedMonth,
      year: selectedYear,
      revenueGoal: parseFloat(revenueGoalValue),
      challengeGoal: challengeGoalValue ? parseFloat(challengeGoalValue) : null,
      challengeBonus: challengeBonusValue ? parseFloat(challengeBonusValue) : null,
    });
  };

  const openNewGoal = () => {
    setEditingGoal(null);
    setSelectedSellerId('');
    setRevenueGoalValue('');
    setChallengeGoalValue('');
    setChallengeBonusValue('');
    setIsDialogOpen(true);
  };

  const openEditGoal = (goal: SalesGoal) => {
    setEditingGoal(goal);
    setSelectedSellerId(goal.sellerId);
    setRevenueGoalValue(goal.revenueGoal?.toString() || '');
    setChallengeGoalValue((goal as any).challengeGoal?.toString() || '');
    setChallengeBonusValue((goal as any).challengeBonus?.toString() || '');
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

  const totalGoal = goalsVisiveis.reduce((s, g) => s + parseFloat(g.revenueGoal?.toString() || '0'), 0);
  const totalActual = goalsVisiveis.reduce((s, g) => s + (metricsMap[g.sellerId]?.actual || 0), 0);
  const totalProjected = goalsVisiveis.reduce((s, g) => s + (metricsMap[g.sellerId]?.projected || 0), 0);
  // Totais das colunas de comissao. Somam apenas quem TEM regra definida —
  // vendedor sem regra entra como "—" na linha e nao contamina o rodape.
  const totaisComissao = goalsVisiveis.reduce((acc, g) => {
    const nome = getSellerName(g.sellerId);
    const regra = regraDoVendedor(nome);
    if (!regra) return acc;
    const faixa = dashboardData?.commissionTiers?.[TIPO_FAIXA_PADRAO];
    const meta = parseFloat(g.revenueGoal?.toString() || '0');
    const at = metricsMap[g.sellerId]?.actual || 0;
    const pj = metricsMap[g.sellerId]?.projected || 0;
    acc.meta += calcularComissao(regra, meta, 100, faixa, meta) || 0;
    acc.atual += calcularComissao(regra, at, meta > 0 ? (at / meta) * 100 : 0, faixa, meta) || 0;
    acc.proj += calcularComissao(regra, pj, meta > 0 ? (pj / meta) * 100 : 0, faixa, meta) || 0;
    return acc;
  }, { meta: 0, atual: 0, proj: 0 });

  const totalByInstance: Record<string, number> = {};
  for (const g of goalsVisiveis) {
    const byInst = metricsMap[g.sellerId]?.byInstance || {};
    for (const [instId, val] of Object.entries(byInst)) {
      totalByInstance[instId] = (totalByInstance[instId] || 0) + (val as number);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">
          {user.role === 'vendedor' || user.role === 'telemarketing' ? 'Minhas Metas' : 'Metas de Vendas'}
        </h2>
      </div>

      {podeVerBox && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  {canManage ? 'Gerenciar Metas de Faturamento' : 'Minha Meta e Comissão'}
                </CardTitle>
                <CardDescription>
                  {canManage
                    ? 'Defina a meta de faturamento mensal para cada vendedor ou atendente de telemarketing individualmente.'
                    : 'Sua meta do mês, o quanto já foi faturado e a comissão correspondente. Você vê apenas os seus números.'}
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
                {perms.can(CARD_METAS, "criar") && (
                <Button onClick={openNewGoal} size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Nova Meta
                </Button>
                )}
                {/* "i" — explica de onde vem cada valor das 3 colunas de comissao.
                    As faixas do telemarketing sao lidas do proprio backend
                    (commissionTiers) para nunca divergirem da regra em vigor. */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
                      aria-label="Como a comissão é calculada" title="Como a comissão é calculada">
                      <Info className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-[30rem] text-sm">
                    <div className="font-semibold mb-1">Como a comissão é calculada</div>
                    <p className="text-xs text-muted-foreground mb-3">
                      <strong>Comissão</strong> usa a meta, <strong>Comissão Conquistada</strong> usa o
                      faturamento atual e <strong>Projeção da Comissão</strong> usa a projeção do mês.
                    </p>
                    <ul className="space-y-2">
                      <li className="flex gap-2">
                        <span className="font-medium w-40 shrink-0">Gilmar</span>
                        <span>7% sobre o valor da coluna.</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-medium w-40 shrink-0">Carlos e Jhonatan</span>
                        <span>8% sobre o valor da coluna.</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-medium w-40 shrink-0">Radilton e Cleber</span>
                        <span>4,5% sobre o valor da coluna.</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-medium w-40 shrink-0">Robson, Natália e Maria Eduarda</span>
                        <span>
                          Faixas de Comissão de Vendas Internas — a alíquota acompanha o % de
                          atingimento da própria coluna
                          {(() => {
                            const t = dashboardData?.commissionTiers?.telemarketing;
                            if (!t?.thresholds?.length) return '.';
                            const partes = t.thresholds.map((th, i) => {
                              const prox = t.thresholds[i + 1];
                              const faixa = prox ? `${th}–${prox - 0.01}%` : `${th}%+`;
                              return `${faixa}: ${String(t.rates[i]).replace('.', ',')}%`;
                            });
                            return ` (${partes.join(' · ')}).`;
                          })()}
                          {' '}São os <strong>únicos</strong> que seguem faixas; todos os demais têm
                          percentual fixo.
                        </span>
                      </li>
                      <li className="flex gap-2">
                        <span className="font-medium w-40 shrink-0">Letícia</span>
                        <span>
                          4% <strong>da meta</strong> menos R$ 1.400,00 — a diferença entre o fixo dela
                          (R$ 3.200) e a base de um administrativo (R$ 1.800). Ela recebe só o que
                          excede essa diferença. As outras duas colunas são proporcionais ao
                          atingimento: comissão da meta × (valor da coluna ÷ meta).
                        </span>
                      </li>
                    </ul>
                    <p className="text-xs text-muted-foreground mt-3 pt-2 border-t">
                      Quem não está nesta lista aparece com <strong>—</strong>: não há regra definida,
                      e a tela não arbitra um valor. Resultado negativo vira R$ 0,00.
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : goalsVisiveis.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <DollarSign className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p>Nenhuma meta configurada para {months.find(m => m.value === selectedMonth)?.label}/{selectedYear}.</p>
                {canManage && <p className="text-sm">Clique em "Nova Meta" para começar.</p>}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendedor</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Meta</TableHead>
                    <TableHead className="text-right bg-gray-50">Comissão</TableHead>
                    <TableHead className="text-right">Fat. Atual</TableHead>
                    <TableHead className="text-right bg-gray-50">Comissão Conquistada</TableHead>
                    <TableHead className="text-right">Projeção</TableHead>
                    <TableHead className="text-right bg-gray-50">Projeção da Comissão</TableHead>
                    <TableHead className="text-right">% Ating.</TableHead>
                    {canManage && <TableHead className="text-right">% Cobertura (7d)</TableHead>}
                    {canEdit && <TableHead className="text-right">Ações</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {goalsVisiveis.map((goal) => {
                    const type = getSellerType(goal.sellerId);
                    const metrics = metricsMap[goal.sellerId];
                    const goalValue = parseFloat(goal.revenueGoal?.toString() || '0');
                    const actual = metrics?.actual || 0;
                    const projected = metrics?.projected || 0;
                    const achievement = goalValue > 0 ? (projected / goalValue) * 100 : 0;
                    // ── COMISSAO (regra em @/lib/comissaoMetas). Cada coluna usa a sua propria
                    // base; nas faixas, a aliquota segue o atingimento daquela coluna.
                    const regra = regraDoVendedor(getSellerName(goal.sellerId));
                    // Quem segue faixas usa SEMPRE a tabela de Vendas Internas (telemarketing),
                    // mesmo que esteja cadastrado como Externo CLT/PJ.
                    const faixa = dashboardData?.commissionTiers?.[TIPO_FAIXA_PADRAO];
                    const atingAtual = goalValue > 0 ? (actual / goalValue) * 100 : 0;
                    const comissaoMeta = calcularComissao(regra, goalValue, 100, faixa, goalValue);
                    const comissaoAtual = calcularComissao(regra, actual, atingAtual, faixa, goalValue);
                    const comissaoProj = calcularComissao(regra, projected, achievement, faixa, goalValue);
                    const tituloRegra = descricaoRegra(regra);
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
                          {(() => {
                            const challenge = parseFloat((goal as any).challengeGoal?.toString() || '0');
                            if (challenge <= 0) return null;
                            const bonus = parseFloat((goal as any).challengeBonus?.toString() || '0');
                            const pct = challenge > 0 ? (actual / challenge) * 100 : 0;
                            const hit = actual >= challenge;
                            return (
                              <div className={`text-[10px] mt-0.5 flex items-center justify-end gap-1 ${hit ? 'text-green-600 font-semibold' : 'text-amber-600'}`} title="Meta Desafio">
                                <Trophy className="h-3 w-3" />
                                <span>{formatCurrency(challenge)}</span>
                                <span>· {pct.toFixed(0)}%</span>
                                {bonus > 0 && <span>· bônus {formatCurrency(bonus)}</span>}
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right font-mono bg-gray-50" title={tituloRegra}>
                          {comissaoMeta === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className="text-muted-foreground">{formatCurrency(comissaoMeta)}</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          <div>
                            {metrics?.byInstance && Object.keys(metrics.byInstance).length > 0 ? (
                              <>
                                {Object.entries(metrics.byInstance).map(([instId, val]) => (
                                  <div key={instId} className="text-xs text-muted-foreground">
                                    {instanceLabels[instId] || instId.slice(0, 4)}: {formatCurrency(val as number)}
                                  </div>
                                ))}
                                {/* O Total sai SEMPRE. Antes ele so aparecia com 2+ instancias,
                                    entao quando havia uma unica instancia a tela mostrava apenas
                                    o valor daquela instancia e escondia o faturamento real. */}
                                <div className="font-semibold border-t mt-0.5 pt-0.5">Total: {formatCurrency(actual)}</div>
                              </>
                            ) : (
                              formatCurrency(actual)
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono bg-gray-50" title={tituloRegra}>
                          {comissaoAtual === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className="font-semibold">{formatCurrency(comissaoAtual)}</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          <span className={projected >= goalValue && goalValue > 0 ? 'text-green-600 font-semibold' : projected > 0 ? 'text-amber-600' : ''}>
                            {formatCurrency(projected)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono bg-gray-50" title={tituloRegra}>
                          {comissaoProj === null
                            ? <span className="text-muted-foreground">—</span>
                            : <span className="text-muted-foreground">{formatCurrency(comissaoProj)}</span>}
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
                        {canManage && (
                        <TableCell className="text-right">
                          {(() => {
                            const uu = allUsers.find((x: User) => x.id === goal.sellerId) as any;
                            const keys = new Set<string>([goal.sellerId]);
                            if (uu && uu.omieVendorCode) { keys.add(String(uu.omieVendorCode)); keys.add('omie-vendor-' + String(uu.omieVendorCode)); }
                            let plan = 0, atend = 0, has = false;
                            keys.forEach((k) => { const cv = (coverageMap as any)[k]; if (cv) { plan += cv.planejados || 0; atend += cv.atendidos || 0; has = true; } });
                            if (!has || plan <= 0) return <span className="text-muted-foreground">—</span>;
                            const c = Math.min(100, Math.round((atend / plan) * 100));
                            const color = c >= 90 ? 'text-green-600' : c >= 60 ? 'text-amber-600' : 'text-red-600';
                            return <span className={`text-sm font-mono ${color}`} title={`${atend}/${plan} planejados (7d)`}>{c}%</span>;
                          })()}
                        </TableCell>
                        )}
                        {canEdit && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {perms.can(CARD_METAS, "editar") && (
                            <Button variant="ghost" size="sm" onClick={() => openEditGoal(goal)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            )}
                            {perms.can(CARD_METAS, "excluir") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { if (confirm('Deletar esta meta?')) deleteGoalMutation.mutate(goal.id); }}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            )}
                          </div>
                        </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
                {canManage && goalsVisiveis.length > 1 && (
                  <TableFooter>
                    <TableRow className="bg-muted/50 font-semibold">
                      <TableCell colSpan={2}>Total</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(totalGoal)}</TableCell>
                      <TableCell className="text-right font-mono bg-gray-50">{formatCurrency(totaisComissao.meta)}</TableCell>
                      <TableCell className="text-right font-mono">
                        <div>
                          {Object.keys(totalByInstance).length > 0 && Object.keys(totalByInstance).length > 1 && (
                            <>
                              {Object.entries(totalByInstance).map(([instId, val]) => (
                                <div key={instId} className="text-xs text-muted-foreground font-normal">
                                  {instanceLabels[instId] || instId.slice(0, 4)}: {formatCurrency(val)}
                                </div>
                              ))}
                            </>
                          )}
                          <div>{formatCurrency(totalActual)}</div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono bg-gray-50">{formatCurrency(totaisComissao.atual)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(totalProjected)}</TableCell>
                      <TableCell className="text-right font-mono bg-gray-50">{formatCurrency(totaisComissao.proj)}</TableCell>
                      <TableCell className="text-right">
                        {totalGoal > 0 ? (
                          <span className={`text-sm font-mono ${(totalProjected / totalGoal) * 100 >= 100 ? 'text-green-600' : ''}`}>
                            {((totalProjected / totalGoal) * 100).toFixed(1)}%
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell />
                      {canEdit && <TableCell />}
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
                    <>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground border-t mt-1">
                        Telemarketing (individual)
                      </div>
                      {telemarketingUsers.map((s: User) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.firstName} {s.lastName}
                          <span className="text-xs text-muted-foreground ml-2">(Telemarketing)</span>
                        </SelectItem>
                      ))}
                    </>
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
            {/* Meta Desafio (opcional) — igual ao Integra 1.0 */}
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 dark:bg-amber-900/10 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-semibold">Meta Desafio (opcional)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Defina um faturamento alvo (maior que a meta) para o vendedor ganhar um bônus extra ao bater.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="challengeGoal">Meta Desafio (R$)</Label>
                  <Input
                    id="challengeGoal"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="60000.00"
                    value={challengeGoalValue}
                    onChange={(e) => setChallengeGoalValue(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="challengeBonus">Bônus (R$)</Label>
                  <Input
                    id="challengeBonus"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="500.00"
                    value={challengeBonusValue}
                    onChange={(e) => setChallengeBonusValue(e.target.value)}
                  />
                </div>
              </div>
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
