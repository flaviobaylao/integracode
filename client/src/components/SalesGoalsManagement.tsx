import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import SalesGoalsDashboard from './SalesGoalsDashboard';
import type { SalesGoal, User } from "@shared/schema";

interface SalesGoalsManagementProps {
  user: User;
}

export default function SalesGoalsManagement({ user }: SalesGoalsManagementProps) {
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SalesGoal | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Buscar vendedores (apenas para admins/coordinators/administrative)
  const { data: sellers = [] } = useQuery<User[]>({
    queryKey: ['/api/users'],
    enabled: ['admin', 'coordinator', 'administrative'].includes(user.role)
  });

  // Buscar metas
  const { data: salesGoals = [], isLoading } = useQuery<SalesGoal[]>({
    queryKey: ['/api/sales-goals', selectedMonth, selectedYear],
    queryFn: () => fetch(`/api/sales-goals?month=${selectedMonth}&year=${selectedYear}`)
      .then(res => res.json())
  });

  // Mutação para criar/atualizar meta
  const createGoalMutation = useMutation({
    mutationFn: (goalData: any) => {
      if (editingGoal) {
        return apiRequest('PUT', `/api/sales-goals/${editingGoal.id}`, goalData);
      } else {
        return apiRequest('POST', '/api/sales-goals', goalData);
      }
    },
    onSuccess: () => {
      toast({
        title: editingGoal ? "Meta atualizada" : "Meta criada",
        description: editingGoal ? "A meta foi atualizada com sucesso." : "A meta foi criada com sucesso.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals'] });
      setIsDialogOpen(false);
      setEditingGoal(null);
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: "Ocorreu um erro ao salvar a meta.",
        variant: "destructive",
      });
      console.error('Error saving goal:', error);
    }
  });

  // Mutação para deletar meta
  const deleteGoalMutation = useMutation({
    mutationFn: (goalId: string) => {
      return apiRequest('DELETE', `/api/sales-goals/${goalId}`);
    },
    onSuccess: () => {
      toast({
        title: "Meta deletada",
        description: "A meta foi deletada com sucesso.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-goals'] });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: "Ocorreu um erro ao deletar a meta.",
        variant: "destructive",
      });
      console.error('Error deleting goal:', error);
    }
  });

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
    { value: 12, label: 'Dezembro' }
  ];

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

  const canManageGoals = ['admin', 'coordinator', 'administrative'].includes(user.role);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    const goalData = {
      sellerId: formData.get('sellerId') as string,
      month: selectedMonth,
      year: selectedYear,
      positivationGoal: formData.get('positivationGoal') ? parseFloat(formData.get('positivationGoal') as string) : null,
      revenueGoal: formData.get('revenueGoal') ? parseFloat(formData.get('revenueGoal') as string) : null,
      overdueDebtGoal: formData.get('overdueDebtGoal') ? parseFloat(formData.get('overdueDebtGoal') as string) : null,
      serviceGoal: formData.get('serviceGoal') ? parseFloat(formData.get('serviceGoal') as string) : null,
    };

    createGoalMutation.mutate(goalData);
  };

  const openNewGoalDialog = () => {
    setEditingGoal(null);
    setIsDialogOpen(true);
  };

  const handleEdit = (goal: SalesGoal) => {
    setEditingGoal(goal);
    setIsDialogOpen(true);
  };

  const handleDelete = (goalId: string) => {
    if (confirm('Tem certeza que deseja deletar esta meta?')) {
      deleteGoalMutation.mutate(goalId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">
          {user.role === 'vendedor' ? 'Minhas Metas' : 'Metas de Vendas'}
        </h2>
      </div>

      <Tabs defaultValue="dashboard" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="dashboard">
            <i className="fas fa-chart-line mr-2"></i>
            Dashboard
          </TabsTrigger>
          <TabsTrigger value="management" disabled={!canManageGoals}>
            <i className="fas fa-cogs mr-2"></i>
            Gerenciamento
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-6">
          <SalesGoalsDashboard user={user} />
        </TabsContent>

        <TabsContent value="management" className="mt-6">
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-700">Gerenciar Metas</h3>
              <div className="flex space-x-2">
                <Select value={selectedMonth.toString()} onValueChange={(value) => setSelectedMonth(parseInt(value))}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month) => (
                      <SelectItem key={month.value} value={month.value.toString()}>
                        {month.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={selectedYear.toString()} onValueChange={(value) => setSelectedYear(parseInt(value))}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canManageGoals && (
                  <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                      <Button onClick={openNewGoalDialog} data-testid="button-new-goal">
                        <i className="fas fa-plus mr-2"></i>
                        Nova Meta
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>
                          {editingGoal ? 'Editar Meta' : 'Nova Meta'}
                        </DialogTitle>
                      </DialogHeader>
                      <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                          <Label htmlFor="sellerId">Vendedor</Label>
                          <Select name="sellerId" defaultValue={editingGoal?.sellerId} required>
                            <SelectTrigger>
                              <SelectValue placeholder="Selecione o vendedor" />
                            </SelectTrigger>
                            <SelectContent>
                              {sellers.filter((seller: User) => seller.role === 'vendedor').map((seller: User) => (
                                <SelectItem key={seller.id} value={seller.id}>
                                  {seller.firstName} {seller.lastName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="positivationGoal">Positivação (%)</Label>
                            <Input
                              id="positivationGoal"
                              name="positivationGoal"
                              type="number"
                              step="0.01"
                              max="100"
                              min="0"
                              defaultValue={editingGoal?.positivationGoal?.toString()}
                              placeholder="85.50"
                              data-testid="input-positivation-goal"
                            />
                          </div>

                          <div>
                            <Label htmlFor="serviceGoal">Atendimento (%)</Label>
                            <Input
                              id="serviceGoal"
                              name="serviceGoal"
                              type="number"
                              step="0.01"
                              max="100"
                              min="0"
                              defaultValue={editingGoal?.serviceGoal?.toString()}
                              placeholder="90.00"
                              data-testid="input-service-goal"
                            />
                          </div>
                        </div>

                        <div>
                          <Label htmlFor="revenueGoal">Faturamento (R$)</Label>
                          <Input
                            id="revenueGoal"
                            name="revenueGoal"
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={editingGoal?.revenueGoal?.toString()}
                            placeholder="50000.00"
                            data-testid="input-revenue-goal"
                          />
                        </div>

                        <div>
                          <Label htmlFor="overdueDebtGoal">Débito Vencido (%)</Label>
                          <Input
                            id="overdueDebtGoal"
                            name="overdueDebtGoal"
                            type="number"
                            step="0.01"
                            max="100"
                            min="0"
                            defaultValue={editingGoal?.overdueDebtGoal?.toString()}
                            placeholder="5.00"
                            data-testid="input-overdue-debt-goal"
                          />
                        </div>

                        <div className="flex justify-end space-x-2 pt-4">
                          <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                            Cancelar
                          </Button>
                          <Button type="submit" disabled={createGoalMutation.isPending} data-testid="button-save-goal">
                            {createGoalMutation.isPending ? 'Salvando...' : 'Salvar'}
                          </Button>
                        </div>
                      </form>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            </div>

            {isLoading ? (
              <div className="flex justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue"></div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {salesGoals.length > 0 ? (
                  salesGoals.map((goal: SalesGoal) => {
                    const seller = sellers.find((s: User) => s.id === goal.sellerId);
                    return (
                      <Card key={goal.id} className="hover:shadow-lg transition-shadow">
                        <CardHeader>
                          <div className="flex justify-between items-start">
                            <div>
                              <CardTitle className="text-lg">
                                {seller ? `${seller.firstName} ${seller.lastName}` : 'Vendedor não encontrado'}
                              </CardTitle>
                              <p className="text-sm text-gray-500">
                                {months.find(m => m.value === goal.month)?.label}/{goal.year}
                              </p>
                            </div>
                            {canManageGoals && (
                              <div className="flex space-x-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleEdit(goal)}
                                  data-testid={`button-edit-goal-${goal.id}`}
                                >
                                  <i className="fas fa-edit text-sm"></i>
                                </Button>
                                {user.role === 'admin' && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleDelete(goal.id)}
                                    data-testid={`button-delete-goal-${goal.id}`}
                                  >
                                    <i className="fas fa-trash text-sm text-red-500"></i>
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {goal.positivationGoal && (
                            <div className="flex justify-between">
                              <Label className="text-sm text-gray-600">Positivação:</Label>
                              <Badge variant="outline">{goal.positivationGoal}%</Badge>
                            </div>
                          )}
                          {goal.revenueGoal && (
                            <div className="flex justify-between">
                              <Label className="text-sm text-gray-600">Faturamento:</Label>
                              <Badge variant="outline">
                                R$ {parseFloat(goal.revenueGoal.toString()).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                              </Badge>
                            </div>
                          )}
                          {goal.overdueDebtGoal && (
                            <div className="flex justify-between">
                              <Label className="text-sm text-gray-600">Débito Vencido:</Label>
                              <Badge variant="outline">{goal.overdueDebtGoal}%</Badge>
                            </div>
                          )}
                          {goal.serviceGoal && (
                            <div className="flex justify-between">
                              <Label className="text-sm text-gray-600">Atendimento:</Label>
                              <Badge variant="outline">{goal.serviceGoal}%</Badge>
                            </div>
                          )}
                          {!goal.positivationGoal && !goal.revenueGoal && !goal.overdueDebtGoal && !goal.serviceGoal && (
                            <p className="text-gray-500 text-sm">Nenhuma meta definida</p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })
                ) : (
                  <div className="col-span-full text-center p-8">
                    <p className="text-gray-500">Nenhuma meta definida para este período</p>
                    {canManageGoals && (
                      <Button onClick={openNewGoalDialog} className="mt-4">
                        <i className="fas fa-plus mr-2"></i>
                        Criar primeira meta
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}