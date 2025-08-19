import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { RefreshCw as Sync, Users, AlertTriangle, DollarSign, Calendar, Check, X, Loader2, RefreshCw } from "lucide-react";
import type { User } from "@shared/schema";

interface OmieSyncManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

interface OverdueDebt {
  cliente: any;
  debitos: Array<{
    numero_documento: string;
    valor: number;
    data_vencimento: string;
    dias_atraso: number;
    observacao?: string;
  }>;
  valorTotal: number;
  diasMaximoAtraso: number;
}

interface SyncResult {
  totalProcessed: number;
  imported: number;
  updated: number;
  errors: string[];
}

export default function OmieSyncManager({ isOpen, onClose }: OmieSyncManagerProps) {
  const [selectedSeller, setSelectedSeller] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'clients' | 'vendors' | 'products' | 'debts'>('clients');
  const [syncProgress, setSyncProgress] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Buscar usuários vendedores
  const { data: users } = useQuery({
    queryKey: ['/api/users'],
    retry: false,
  });

  // Buscar débitos em atraso
  const { data: overdueDebts, isLoading: isLoadingDebts, refetch: refetchDebts } = useQuery({
    queryKey: ['/api/omie/overdue-debts'],
    enabled: isOpen && activeTab === 'debts',
    retry: false,
  });

  // Verificar status da integração Omie
  const { data: omieStatus } = useQuery({
    queryKey: ['/api/omie/status'],
    enabled: isOpen,
    retry: false,
  });

  // Mutation para sincronizar todos os clientes
  const syncAllClientsMutation = useMutation({
    mutationFn: async (sellerId: string): Promise<SyncResult> => {
      setIsSyncing(true);
      setSyncProgress(0);
      
      const progressInterval = setInterval(() => {
        setSyncProgress(prev => Math.min(prev + 10, 90));
      }, 1000);

      try {
        const response = await fetch('/api/omie/sync-all-clients', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ defaultSellerId: sellerId })
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json() as SyncResult;
        
        clearInterval(progressInterval);
        setSyncProgress(100);
        
        return result;
      } catch (error) {
        clearInterval(progressInterval);
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    onSuccess: (data: SyncResult) => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      setSyncResult(data);
      toast({
        title: "Sincronização concluída",
        description: `${data.imported} novos clientes importados, ${data.updated} atualizados. ${data.errors.length > 0 ? `${data.errors.length} erro(s) encontrado(s).` : ''}`,
      });
    },
    onError: (error) => {
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
      setSyncResult(null);
    },
  });

  // Mutation para sincronizar vendedores
  const syncVendorsMutation = useMutation({
    mutationFn: async (): Promise<SyncResult> => {
      setIsSyncing(true);
      setSyncProgress(0);
      
      const progressInterval = setInterval(() => {
        setSyncProgress(prev => Math.min(prev + 10, 90));
      }, 1000);

      try {
        const response = await fetch('/api/omie/sync-vendors', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json() as SyncResult;
        
        clearInterval(progressInterval);
        setSyncProgress(100);
        
        return result;
      } catch (error) {
        clearInterval(progressInterval);
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    onSuccess: (data: SyncResult) => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setSyncResult(data);
      toast({
        title: "Sincronização de vendedores concluída",
        description: `${data.imported} novos vendedores importados, ${data.updated} atualizados.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Erro na sincronização de vendedores",
        description: error.message,
        variant: "destructive",
      });
      setSyncResult(null);
    },
  });

  // Mutation para sincronizar produtos
  const syncProductsMutation = useMutation({
    mutationFn: async (): Promise<SyncResult> => {
      setIsSyncing(true);
      setSyncProgress(0);
      
      const progressInterval = setInterval(() => {
        setSyncProgress(prev => Math.min(prev + 10, 90));
      }, 1000);

      try {
        const response = await fetch('/api/omie/sync-products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json() as SyncResult;
        
        clearInterval(progressInterval);
        setSyncProgress(100);
        
        return result;
      } catch (error) {
        clearInterval(progressInterval);
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    onSuccess: (data: SyncResult) => {
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      setSyncResult(data);
      toast({
        title: "Sincronização de produtos concluída",
        description: `${data.imported} novos produtos importados, ${data.updated} atualizados.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Erro na sincronização de produtos",
        description: error.message,
        variant: "destructive",
      });
      setSyncResult(null);
    },
  });

  const handleSyncAllClients = () => {
    if (!selectedSeller) {
      toast({
        title: "Erro",
        description: "Selecione um vendedor padrão para os clientes",
        variant: "destructive",
      });
      return;
    }

    syncAllClientsMutation.mutate(selectedSeller);
  };

  const handleSyncVendors = () => {
    syncVendorsMutation.mutate();
  };

  const handleSyncProducts = () => {
    syncProductsMutation.mutate();
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  const getDaysOverdueColor = (days: number) => {
    if (days <= 15) return 'text-yellow-600';
    if (days <= 30) return 'text-orange-600';
    return 'text-red-600';
  };

  if (!(omieStatus as any)?.configured) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center space-x-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <span>Integração Omie Não Configurada</span>
            </DialogTitle>
          </DialogHeader>
          <div className="text-center py-6">
            <p className="text-gray-600 mb-4">
              A integração com o Omie não está configurada. Entre em contato com o administrador do sistema.
            </p>
            <Button onClick={onClose}>Fechar</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Sync className="h-5 w-5 text-honest-blue" />
            <span>Sincronização Omie</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Tabs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1 bg-gray-100 p-1 rounded-lg">
            <Button
              variant={activeTab === 'clients' ? 'default' : 'ghost'}
              className={`${activeTab === 'clients' ? 'bg-honest-blue text-white' : ''}`}
              onClick={() => setActiveTab('clients')}
            >
              <Users className="h-4 w-4 mr-2" />
              Clientes
            </Button>
            <Button
              variant={activeTab === 'vendors' ? 'default' : 'ghost'}
              className={`${activeTab === 'vendors' ? 'bg-honest-blue text-white' : ''}`}
              onClick={() => setActiveTab('vendors')}
            >
              <Users className="h-4 w-4 mr-2" />
              Vendedores
            </Button>
            <Button
              variant={activeTab === 'products' ? 'default' : 'ghost'}
              className={`${activeTab === 'products' ? 'bg-honest-blue text-white' : ''}`}
              onClick={() => setActiveTab('products')}
            >
              <DollarSign className="h-4 w-4 mr-2" />
              Produtos
            </Button>
            <Button
              variant={activeTab === 'debts' ? 'default' : 'ghost'}
              className={`${activeTab === 'debts' ? 'bg-honest-blue text-white' : ''}`}
              onClick={() => setActiveTab('debts')}
            >
              <AlertTriangle className="h-4 w-4 mr-2" />
              Débitos
            </Button>
          </div>

          {/* Tab: Sincronizar Clientes */}
          {activeTab === 'clients' && (
            <div className="space-y-6">
              {/* Controles */}
              <Card>
                <CardHeader>
                  <CardTitle>Sincronização Completa de Clientes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Esta operação irá buscar todos os clientes do Omie e importar/atualizar no sistema.
                    Clientes existentes serão atualizados, novos clientes serão criados.
                  </p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium mb-2 block">
                        Vendedor Padrão (para novos clientes)
                      </label>
                      <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione o vendedor" />
                        </SelectTrigger>
                        <SelectContent>
                          {users && Array.isArray(users) && (users as any[])
                            .filter((user: any) => user.role === 'vendedor')
                            .map((user: any) => (
                              <SelectItem key={user.id} value={user.id}>
                                {user.firstName} {user.lastName}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex items-end">
                      <Button
                        onClick={handleSyncAllClients}
                        disabled={!selectedSeller || isSyncing}
                        className="bg-honest-blue hover:bg-honest-blue/90 w-full"
                      >
                        {isSyncing ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            Sincronizando...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Sincronizar Todos
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Progresso */}
                  {isSyncing && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Progresso da sincronização</span>
                        <span>{syncProgress}%</span>
                      </div>
                      <Progress value={syncProgress} className="w-full" />
                    </div>
                  )}

                  {/* Resultado */}
                  {syncResult && (
                    <Card className="bg-green-50 border-green-200">
                      <CardContent className="pt-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-2xl font-bold text-honest-blue">{syncResult.totalProcessed}</p>
                            <p className="text-sm text-gray-600">Processados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-green-600">{syncResult.imported}</p>
                            <p className="text-sm text-gray-600">Importados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-blue-600">{syncResult.updated}</p>
                            <p className="text-sm text-gray-600">Atualizados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-red-600">{syncResult.errors?.length || 0}</p>
                            <p className="text-sm text-gray-600">Erros</p>
                          </div>
                        </div>
                        
                        {syncResult?.errors && syncResult.errors.length > 0 && (
                          <div className="mt-4">
                            <p className="font-medium text-red-600 mb-2">Erros encontrados:</p>
                            <div className="max-h-32 overflow-y-auto space-y-1">
                              {syncResult?.errors?.map((error, index) => (
                                <p key={index} className="text-sm text-red-600 bg-red-50 p-2 rounded">
                                  {error}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Tab: Sincronizar Vendedores */}
          {activeTab === 'vendors' && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Sincronização de Vendedores</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Esta operação irá buscar todos os vendedores ativos do Omie e importar/atualizar no sistema.
                  </p>
                  
                  <div className="flex justify-center">
                    <Button
                      onClick={handleSyncVendors}
                      disabled={isSyncing}
                      className="bg-honest-blue hover:bg-honest-blue/90"
                    >
                      {isSyncing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          Sincronizando...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Sincronizar Vendedores
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Progresso */}
                  {isSyncing && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Progresso da sincronização</span>
                        <span>{syncProgress}%</span>
                      </div>
                      <Progress value={syncProgress} className="w-full" />
                    </div>
                  )}

                  {/* Resultado */}
                  {syncResult && (
                    <Card className="bg-green-50 border-green-200">
                      <CardContent className="pt-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-2xl font-bold text-honest-blue">{syncResult.totalProcessed}</p>
                            <p className="text-sm text-gray-600">Processados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-green-600">{syncResult.imported}</p>
                            <p className="text-sm text-gray-600">Importados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-blue-600">{syncResult.updated}</p>
                            <p className="text-sm text-gray-600">Atualizados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-red-600">{syncResult.errors?.length || 0}</p>
                            <p className="text-sm text-gray-600">Erros</p>
                          </div>
                        </div>
                        
                        {syncResult?.errors && syncResult.errors.length > 0 && (
                          <div className="mt-4">
                            <p className="font-medium text-red-600 mb-2">Erros encontrados:</p>
                            <div className="max-h-32 overflow-y-auto space-y-1">
                              {syncResult?.errors?.map((error, index) => (
                                <p key={index} className="text-sm text-red-600 bg-red-50 p-2 rounded">
                                  {error}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Tab: Sincronizar Produtos */}
          {activeTab === 'products' && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Sincronização de Produtos</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Esta operação irá buscar todos os produtos ativos do Omie e importar/atualizar no sistema.
                  </p>
                  
                  <div className="flex justify-center">
                    <Button
                      onClick={handleSyncProducts}
                      disabled={isSyncing}
                      className="bg-honest-blue hover:bg-honest-blue/90"
                    >
                      {isSyncing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          Sincronizando...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Sincronizar Produtos
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Progresso */}
                  {isSyncing && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Progresso da sincronização</span>
                        <span>{syncProgress}%</span>
                      </div>
                      <Progress value={syncProgress} className="w-full" />
                    </div>
                  )}

                  {/* Resultado */}
                  {syncResult && (
                    <Card className="bg-green-50 border-green-200">
                      <CardContent className="pt-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-2xl font-bold text-honest-blue">{syncResult.totalProcessed}</p>
                            <p className="text-sm text-gray-600">Processados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-green-600">{syncResult.imported}</p>
                            <p className="text-sm text-gray-600">Importados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-blue-600">{syncResult.updated}</p>
                            <p className="text-sm text-gray-600">Atualizados</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-red-600">{syncResult.errors?.length || 0}</p>
                            <p className="text-sm text-gray-600">Erros</p>
                          </div>
                        </div>
                        
                        {syncResult?.errors && syncResult.errors.length > 0 && (
                          <div className="mt-4">
                            <p className="font-medium text-red-600 mb-2">Erros encontrados:</p>
                            <div className="max-h-32 overflow-y-auto space-y-1">
                              {syncResult?.errors?.map((error, index) => (
                                <p key={index} className="text-sm text-red-600 bg-red-50 p-2 rounded">
                                  {error}
                                </p>
                              ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Tab: Débitos em Atraso */}
          {activeTab === 'debts' && (
            <div className="space-y-6">
              {/* Estatísticas */}
              {overdueDebts && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center space-x-2">
                        <Users className="h-5 w-5 text-orange-500" />
                        <div>
                          <p className="text-sm text-gray-600">Clientes em Atraso</p>
                          <p className="text-2xl font-bold">{(overdueDebts as any).totalClients}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center space-x-2">
                        <DollarSign className="h-5 w-5 text-red-500" />
                        <div>
                          <p className="text-sm text-gray-600">Valor Total</p>
                          <p className="text-2xl font-bold">{formatCurrency((overdueDebts as any).totalAmount)}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center space-x-2">
                        <RefreshCw className="h-5 w-5 text-blue-500" />
                        <div>
                          <p className="text-sm text-gray-600">Atualizar</p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => refetchDebts()}
                            disabled={isLoadingDebts}
                          >
                            {isLoadingDebts ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Lista de Débitos */}
              <Card>
                <CardHeader>
                  <CardTitle>Clientes com Débitos em Atraso</CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoadingDebts ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-honest-blue" />
                      <span className="ml-2">Carregando débitos...</span>
                    </div>
                  ) : overdueDebts && (overdueDebts as any).debts && (overdueDebts as any).debts.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Cliente</TableHead>
                            <TableHead>Documento</TableHead>
                            <TableHead>Débitos</TableHead>
                            <TableHead>Valor Total</TableHead>
                            <TableHead>Máx. Atraso</TableHead>
                            <TableHead>Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(overdueDebts as any).debts.map((debt: OverdueDebt, index: number) => (
                            <TableRow key={index}>
                              <TableCell>
                                <div>
                                  <p className="font-medium">{debt.cliente?.razao_social}</p>
                                  {debt.cliente?.nome_fantasia && (
                                    <p className="text-sm text-gray-600">{debt.cliente.nome_fantasia}</p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="font-mono text-sm">
                                  {debt.cliente?.cnpj_cpf}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  {debt.debitos.slice(0, 3).map((debito, idx) => (
                                    <div key={idx} className="text-sm">
                                      <span className="font-medium">{debito.numero_documento}</span>
                                      <span className="text-gray-600 ml-2">
                                        {formatDate(debito.data_vencimento)}
                                      </span>
                                    </div>
                                  ))}
                                  {debt.debitos.length > 3 && (
                                    <p className="text-xs text-gray-500">
                                      +{debt.debitos.length - 3} mais
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <span className="font-medium text-red-600">
                                  {formatCurrency(debt.valorTotal)}
                                </span>
                              </TableCell>
                              <TableCell>
                                <Badge 
                                  variant="destructive"
                                  className={getDaysOverdueColor(debt.diasMaximoAtraso)}
                                >
                                  {debt.diasMaximoAtraso} dias
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Button variant="outline" size="sm">
                                  Ver Detalhes
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-500">
                      <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
                      <p>Nenhum débito em atraso encontrado no Omie.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Botões de Ação */}
          <div className="flex justify-end pt-4 border-t">
            <Button variant="outline" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}