import { useState, useMemo } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, TrendingUp, Target, Calendar, DollarSign, Award, Users, Lock } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import { getBrazilMonth, getBrazilYear } from '@/lib/brazilTimezone';

interface CommissionDashboardData {
  month: number;
  year: number;
  workingDaysInMonth: number;
  workingDaysElapsed: number;
  commissionTiers: Record<string, { thresholds: number[]; rates: number[] }>;
  sellers: SellerResult[];
  telemarketing: SellerResult | null;
  history: HistoryEntry[];
  currentUserId: string;
}

interface SellerResult {
  sellerId: string;
  sellerName: string;
  sellerType: string;
  revenueGoal: number;
  revenueActual: number;
  revenueProjected: number;
  achievementPct: number;
  commissionRate: number;
  commissionTier: number;
  commissionTierLabel: string;
  members?: { id: string; name: string }[];
}

interface HistoryEntry {
  id: string;
  seller_id: string;
  seller_type: string;
  month: number;
  year: number;
  revenue_goal: string;
  revenue_actual: string;
  revenue_projected: string;
  achievement_pct: string;
  commission_pct: string;
  commission_tier: number;
  working_days_total: number;
  working_days_elapsed: number;
  is_projected: boolean;
}

interface SalesGoalsDashboardProps {
  user: User;
}

const SELLER_TYPE_LABELS: Record<string, string> = {
  vendedor_clt: 'Externo CLT',
  vendedor_pj: 'Externo PJ',
  telemarketing: 'Vendas Internas',
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

const formatPct = (value: number) => `${value.toFixed(2)}%`;

function getTierColor(tier: number) {
  switch (tier) {
    case 1: return 'bg-red-100 text-red-800 border-red-200';
    case 2: return 'bg-orange-100 text-orange-800 border-orange-200';
    case 3: return 'bg-green-100 text-green-800 border-green-200';
    case 4: return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 5: return 'bg-teal-100 text-teal-800 border-teal-200';
    default: return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

export default function SalesGoalsDashboard({ user }: SalesGoalsDashboardProps) {
  const [selectedMonth, setSelectedMonth] = useState(getBrazilMonth());
  const [selectedYear, setSelectedYear] = useState(getBrazilYear());
  const { toast } = useToast();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const years = Array.from({ length: 5 }, (_, i) => getBrazilYear() - 2 + i);

  const { data, isLoading } = useQuery<CommissionDashboardData>({
    queryKey: ['/api/sales-goals/commission-dashboard', selectedMonth, selectedYear],
    queryFn: async () => {
      const params = new URLSearchParams({
        month: selectedMonth.toString(),
        year: selectedYear.toString(),
      });
      const res = await fetch(`/api/sales-goals/commission-dashboard?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Erro ao buscar dashboard');
      return res.json();
    },
    staleTime: 30000,
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['/api/sales-goals/commission-dashboard'] });
      toast({ title: "Dados atualizados", description: "Dashboard atualizado com sucesso." });
    } finally {
      setIsRefreshing(false);
    }
  };

  const allEntries = useMemo(() => {
    if (!data) return [];
    const entries = [...data.sellers];
    if (data.telemarketing) entries.push(data.telemarketing);
    return entries;
  }, [data]);

  const isCurrentUser = (sellerId: string) => {
    if (!data) return false;
    if (sellerId === data.currentUserId) return true;
    if (sellerId === 'TELEMARKETING' && data.telemarketing?.members) {
      return data.telemarketing.members.some(m => m.id === data.currentUserId);
    }
    return false;
  };

  const canSeeAllDetails = ['admin', 'coordinator', 'administrative'].includes(user.role);

  const historyByEntity = useMemo(() => {
    if (!data?.history) return {};
    const grouped: Record<string, HistoryEntry[]> = {};
    for (const h of data.history) {
      const key = h.seller_id || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(h);
    }
    for (const key in grouped) {
      grouped[key].sort((a, b) => b.year - a.year || b.month - a.month);
    }
    return grouped;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Target className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>Nenhum dado disponível para o período selecionado.</p>
        <p className="text-sm">Configure metas de faturamento para visualizar o dashboard.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <h2 className="text-2xl font-bold text-gray-800">Dashboard de Comissões</h2>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} disabled={isRefreshing} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
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
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" />
              Dias Úteis
            </div>
            <div className="text-2xl font-bold">
              {data.workingDaysElapsed}/{data.workingDaysInMonth}
            </div>
            <Progress value={(data.workingDaysElapsed / data.workingDaysInMonth) * 100} className="h-1.5 mt-2" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Users className="h-4 w-4" />
              Vendedores
            </div>
            <div className="text-2xl font-bold">{allEntries.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Com metas configuradas</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <DollarSign className="h-4 w-4" />
              Fat. Total Projetado
            </div>
            <div className="text-2xl font-bold">
              {formatCurrency(allEntries.reduce((sum, e) => sum + e.revenueProjected, 0))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <TrendingUp className="h-4 w-4" />
              Fat. Total Atual
            </div>
            <div className="text-2xl font-bold">
              {formatCurrency(allEntries.reduce((sum, e) => sum + e.revenueActual, 0))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="overview">Meta vs Projetado</TabsTrigger>
          <TabsTrigger value="tiers">Faixas de Comissão</TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Target className="h-5 w-5" />
                Meta de Faturamento vs Projetado — {months.find(m => m.value === data.month)?.label}/{data.year}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vendedor</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Meta</TableHead>
                      <TableHead className="text-right">Atual</TableHead>
                      <TableHead className="text-right">Projetado</TableHead>
                      <TableHead className="text-right">% Atingimento</TableHead>
                      <TableHead className="text-center">Faixa</TableHead>
                      {(canSeeAllDetails || user.role === 'vendedor' || user.role === 'telemarketing') && (
                        <TableHead className="text-right">Comissão</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allEntries.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          Nenhuma meta configurada para este período. Crie metas na seção acima.
                        </TableCell>
                      </TableRow>
                    ) : (
                      allEntries.map((entry) => {
                        const isMine = isCurrentUser(entry.sellerId);
                        const showCommission = canSeeAllDetails || isMine;
                        return (
                          <TableRow key={entry.sellerId} className={isMine ? 'bg-blue-50/50' : ''}>
                            <TableCell className="font-medium">
                              {entry.sellerName}
                              {isMine && <Badge variant="outline" className="ml-2 text-xs">Você</Badge>}
                            </TableCell>
                            <TableCell>
                              <Badge className={SELLER_TYPE_COLORS[entry.sellerType] || 'bg-gray-100'}>
                                {SELLER_TYPE_LABELS[entry.sellerType] || entry.sellerType}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {entry.revenueGoal > 0 ? formatCurrency(entry.revenueGoal) : '—'}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCurrency(entry.revenueActual)}
                            </TableCell>
                            <TableCell className="text-right font-mono font-semibold">
                              {formatCurrency(entry.revenueProjected)}
                            </TableCell>
                            <TableCell className="text-right">
                              {entry.revenueGoal > 0 ? (
                                <span className={entry.achievementPct >= 100 ? 'text-green-600 font-semibold' : entry.achievementPct >= 85 ? 'text-amber-600' : 'text-red-600'}>
                                  {formatPct(entry.achievementPct)}
                                </span>
                              ) : '—'}
                            </TableCell>
                            <TableCell className="text-center">
                              {entry.revenueGoal > 0 ? (
                                <Badge className={`${getTierColor(entry.commissionTier)} border`}>
                                  Faixa {entry.commissionTier}
                                </Badge>
                              ) : '—'}
                            </TableCell>
                            {(canSeeAllDetails || user.role === 'vendedor' || user.role === 'telemarketing') && (
                              <TableCell className="text-right">
                                {showCommission && entry.revenueGoal > 0 ? (
                                  <span className="font-semibold text-green-700">{formatPct(entry.commissionRate)}</span>
                                ) : (
                                  <Lock className="h-4 w-4 text-muted-foreground inline" />
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tiers" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            {Object.entries(data.commissionTiers).map(([type, tiers]) => {
              const labels = type === 'telemarketing'
                ? ['Até 89,99%', '90% a 99,99%', '100% a 109,99%', '110% a 119,99%', '120% ou mais']
                : ['Até 84,99%', '85% a 99,99%', '100% a 109,99%', '110% a 119,99%', '120% ou mais'];
              return (
                <Card key={type}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Award className="h-4 w-4" />
                      {type === 'vendedor_clt' ? 'Comissão — Externo CLT' : type === 'vendedor_pj' ? 'Comissão — Externo PJ' : 'Comissão — Vendas Internas'}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Atingimento</TableHead>
                          <TableHead className="text-xs text-right">Índice</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {labels.map((label, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-sm py-1.5">{label}</TableCell>
                            <TableCell className="text-sm text-right font-mono py-1.5">
                              {tiers.rates[i].toFixed(2)}%
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Mapa de Comissões — {months.find(m => m.value === data.month)?.label}/{data.year}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vendedor</TableHead>
                      <TableHead className="text-center">Faixa 1</TableHead>
                      <TableHead className="text-center">Faixa 2</TableHead>
                      <TableHead className="text-center">Faixa 3</TableHead>
                      <TableHead className="text-center">Faixa 4</TableHead>
                      <TableHead className="text-center">Faixa 5</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allEntries.map((entry) => (
                      <TableRow key={entry.sellerId}>
                        <TableCell className="font-medium">
                          {entry.sellerName}
                          <span className="text-xs text-muted-foreground ml-2">
                            ({SELLER_TYPE_LABELS[entry.sellerType] || entry.sellerType})
                          </span>
                        </TableCell>
                        {[1, 2, 3, 4, 5].map((tier) => (
                          <TableCell key={tier} className="text-center">
                            {entry.commissionTier === tier && entry.revenueGoal > 0 ? (
                              <Badge className={`${getTierColor(tier)} border`}>
                                {formatPct(entry.commissionRate)}
                              </Badge>
                            ) : entry.commissionTier > tier && entry.revenueGoal > 0 ? (
                              <span className="text-green-400">✓</span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Histórico de Cumprimento Mensal
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vendedor</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead className="text-right">Meta</TableHead>
                      <TableHead className="text-right">Realizado</TableHead>
                      <TableHead className="text-right">Projetado</TableHead>
                      <TableHead className="text-right">% Ating.</TableHead>
                      <TableHead className="text-center">Faixa</TableHead>
                      <TableHead className="text-right">Comissão</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.history.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                          Nenhum histórico disponível ainda.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.history.map((h) => {
                        const entry = allEntries.find(e => e.sellerId === h.seller_id);
                        const name = entry?.sellerName || h.seller_id;
                        const isCurrent = h.month === data.month && h.year === data.year;
                        return (
                          <TableRow key={h.id} className={isCurrent ? 'bg-blue-50/30' : ''}>
                            <TableCell className="font-medium text-sm">{name}</TableCell>
                            <TableCell>
                              <Badge className={`text-xs ${SELLER_TYPE_COLORS[h.seller_type] || 'bg-gray-100'}`}>
                                {SELLER_TYPE_LABELS[h.seller_type] || h.seller_type}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">
                              {months.find(m => m.value === h.month)?.label?.slice(0, 3)}/{h.year}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatCurrency(parseFloat(h.revenue_goal || '0'))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatCurrency(parseFloat(h.revenue_actual || '0'))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatCurrency(parseFloat(h.revenue_projected || '0'))}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {formatPct(parseFloat(h.achievement_pct || '0'))}
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge className={`${getTierColor(h.commission_tier)} border text-xs`}>
                                F{h.commission_tier}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {parseFloat(h.commission_pct || '0').toFixed(2)}%
                            </TableCell>
                            <TableCell className="text-center">
                              {h.is_projected ? (
                                <Badge variant="outline" className="text-xs">Projetado</Badge>
                              ) : (
                                <Badge className="bg-green-100 text-green-800 text-xs">Fechado</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
