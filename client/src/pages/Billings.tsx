import { useActiveSellers, MultiSelect, multiMatch, exportToExcel } from "@/lib/tableTools";
import { useState, useEffect, useRef } from 'react';
import { getBrazilDateISO, BRAZIL_TZ } from '@/lib/brazilTimezone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { Calendar, Download, Filter, RefreshCw, Search, TrendingUp, Home, FileText, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import OmieInstanceBadge from '@/components/OmieInstanceBadge';
import FiscalScenariosTab from '@/components/FiscalScenariosTab';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { apiRequest } from '@/lib/queryClient';

interface Billing {
  id: string;
  omieInvoiceId: string;
  omieOrderId?: string;
  orderNumber?: string;
  invoiceNumber: string;
  customerFantasyName: string;
  customerDocument: string;
  cfop: string;
  invoiceDate: string;
  orderDate?: string;
  totalValue: number;
  dueDate: string;
  paymentMethod: string;
  sellerName: string;
  sellerId: string;
  billingType: string;
  invoiceStatus: string;
  invoiceStage?: string;
  omieInstanceId?: string | null;
  products: Array<{
    code: string;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface BillingFilters {
  sellerId?: string;
  startDate?: string;
  endDate?: string;
  customerDocument?: string;
  invoiceNumber?: string;
  cfop?: string;
  invoiceStage?: string;
  omieInstanceId?: string;
  page: number;
  pageSize: number;
}

interface OmieInstancePublic {
  id: string;
  name: string;
  displayName: string;
  tagColor: string;
  isActive: boolean;
  isDefault: boolean;
}

// Função para converter código CFOP para nome amigável
function getCfopDisplayName(cfop: string): string {
  const cfopMap: Record<string, string> = {
    // CFOPs reais encontrados no sistema (formatos com e sem pontos)
    '5.102': 'VENDA', '5102': 'VENDA',
    '5.101': 'VENDA', '5101': 'VENDA',
    '6.102': 'VENDA', '6102': 'VENDA',
    '6.101': 'VENDA', '6101': 'VENDA',
    '5.949': 'TROCA', '5949': 'TROCA',
    '6.949': 'TROCA', '6949': 'TROCA',
    '5.911': 'AMOSTRA', '5911': 'AMOSTRA',
    '6.911': 'AMOSTRA', '6911': 'AMOSTRA',
    '5.910': 'BONIFICAÇÃO', '5910': 'BONIFICAÇÃO',
    '6.910': 'BONIFICAÇÃO', '6910': 'BONIFICAÇÃO',
    '5.915': 'BONIFICAÇÃO', '5915': 'BONIFICAÇÃO',
    // Outros códigos comuns
    '1.102': 'ENTRADA', '1102': 'ENTRADA',
    '1.202': 'ENTRADA', '1202': 'ENTRADA',
    '2.556': 'DEVOLUÇÃO', '2556': 'DEVOLUÇÃO',
    '1.556': 'DEVOLUÇÃO', '1556': 'DEVOLUÇÃO',
    '1.201': 'DEVOLUÇÃO', '1201': 'DEVOLUÇÃO'
  };
  
  return cfopMap[cfop] || cfop;
}

export default function Billings() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<BillingFilters>({
    page: 1,
    pageSize: 50,
  });
  const [sortField, setSortField] = useState<keyof Billing>('invoiceDate');
  const { sellerOptions, sellerGroups, resolveSeller } = useActiveSellers();
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [customerNameSearch, setCustomerNameSearch] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Query para buscar faturamentos (sem filtros - tudo client-side)
  const { data: billingsArray, isLoading: isLoadingBillings, refetch } = useQuery<Billing[]>({
    queryKey: ['/api/billings'],
    queryFn: () => fetch(`/api/billings`).then(res => res.json())
  });

  // Implementar filtros, ordenação, paginação e stats client-side
  const { billingsData, filteredBillings } = billingsArray ? (() => {
    // 1. Aplicar filtros
    let filtered = billingsArray.filter(billing => {
      // Invoice Number filter
      if (filters.invoiceNumber && !(billing.invoiceNumber || '').toLowerCase().includes(filters.invoiceNumber.toLowerCase())) {
        return false;
      }
      
      // Customer Document filter
      if (filters.customerDocument && !billing.customerDocument?.includes(filters.customerDocument)) {
        return false;
      }
      
      // Date range filter
      if (filters.startDate) {
        const billingDate = new Date(billing.invoiceDate);
        const startDate = new Date(filters.startDate);
        if (billingDate < startDate) return false;
      }
      if (filters.endDate) {
        const billingDate = new Date(billing.invoiceDate);
        const endDate = new Date(filters.endDate);
        if (billingDate > endDate) return false;
      }
      
      // CFOP filter
      if (filters.cfop && getCfopDisplayName(billing.cfop) !== filters.cfop) {
        return false;
      }
      
      // Invoice Stage filter
      if (filters.invoiceStage && billing.invoiceStage !== filters.invoiceStage) {
        return false;
      }
      
      // Vendedor multi (ativos; inativo -> Sem Vendedor)
      if (!multiMatch(sellerMulti, resolveSeller(billing.sellerName || billing.sellerId))) {
        return false;
      }
      // Busca por nome de cliente
      if (customerNameSearch && !(billing.customerFantasyName || '').toLowerCase().includes(customerNameSearch.toLowerCase())) {
        return false;
      }

      // Seller filter
      if (filters.sellerId && billing.sellerId !== filters.sellerId) {
        return false;
      }
      
      // Instance filter
      if (filters.omieInstanceId && billing.omieInstanceId !== filters.omieInstanceId) {
        return false;
      }
      
      return true;
    });
    
    // 2. Aplicar ordenação (ANTES da paginação!)
    if (sortField) {
      filtered.sort((a, b) => {
        const aValue = a[sortField];
        const bValue = b[sortField];
        
        // Handle undefined/null values
        if ((aValue === undefined || aValue === null) && (bValue === undefined || bValue === null)) return 0;
        if (aValue === undefined || aValue === null) return sortDirection === 'asc' ? 1 : -1;
        if (bValue === undefined || bValue === null) return sortDirection === 'asc' ? -1 : 1;
        
        if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }
    
    // 3. Aplicar paginação (DEPOIS da ordenação!)
    const start = (filters.page - 1) * filters.pageSize;
    const end = start + filters.pageSize;
    const paginatedBillings = filtered.slice(start, end);
    
    return {
      billingsData: {
        billings: paginatedBillings,
        total: filtered.length,
        page: filters.page,
        pageSize: filters.pageSize
      },
      filteredBillings: filtered
    };
  })() : { billingsData: null, filteredBillings: [] };

  // Calcular estatísticas client-side dos dados FILTRADOS
  const stats = billingsData ? {
    totalInvoices: billingsData.total,
    totalValue: filteredBillings.reduce((sum, b) => {
      const value = Number(b.totalValue);
      return sum + (isNaN(value) ? 0 : value);
    }, 0),
    averageValue: billingsData.total > 0 
      ? filteredBillings.reduce((sum, b) => {
          const value = Number(b.totalValue);
          return sum + (isNaN(value) ? 0 : value);
        }, 0) / billingsData.total 
      : 0,
    period: filters.startDate && filters.endDate 
      ? `${new Date(filters.startDate).toLocaleDateString('pt-BR', { timeZone: BRAZIL_TZ })} - ${new Date(filters.endDate).toLocaleDateString('pt-BR', { timeZone: BRAZIL_TZ })}`
      : 'Todos os períodos'
  } : null;

  // Query para buscar vendedores
  const { data: sellers } = useQuery({
    queryKey: ['/api/billings/sellers'],
    queryFn: () => fetch('/api/billings/sellers').then(res => res.json())
  });

  // Query para buscar instâncias Omie (para filtro e badges)
  const { data: omieInstances } = useQuery<OmieInstancePublic[]>({
    queryKey: ['/api/omie/instances/public'],
    staleTime: 5 * 60 * 1000,
  });

  const handleFilterChange = (key: keyof BillingFilters, value: string | number | undefined) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
      // Only reset to page 1 when changing filters, not when changing page/pageSize
      ...(key !== 'page' && key !== 'pageSize' ? { page: 1 } : {})
    }));
  };

  const clearFilters = () => {
    setFilters({
      page: 1,
      pageSize: 50,
    });
  };

  const handleSort = (field: keyof Billing) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  // Vencimento / data de faturamento sao DATA DE CALENDARIO (gravadas como meia-noite
  // UTC). Renderizar em America/Sao_Paulo subtraia 3h de um valor sem hora e mostrava o
  // dia ANTERIOR — o mesmo titulo aparecia 20/07 no Financeiro e 19/07 aqui.
  // Data de calendario le-se em 'UTC'. Ver shared/tempo.ts.
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  };

  const handleExport = async () => {
    try {
      const response = await fetch('/api/billings/export', {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Erro ao exportar dados');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dados-omie-${getBrazilDateISO()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({
        title: 'Exportação concluída',
        description: 'Os dados foram exportados com sucesso!',
      });
    } catch (error) {
      toast({
        title: 'Erro na exportação',
        description: 'Não foi possível exportar os dados',
        variant: 'destructive',
      });
    }
  };

  const SortableHeader = ({ field, children }: { field: keyof Billing; children: React.ReactNode }) => (
    <TableHead 
      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
      onClick={() => handleSort(field)}
      data-testid={`header-${field}`}
    >
      <div className="flex items-center gap-1">
        {children}
        {sortField === field ? (
          sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
        ) : (
          <ArrowUpDown className="h-4 w-4 opacity-50" />
        )}
      </div>
    </TableHead>
  );

  // Query para buscar status de sincronização
  const { data: syncStatuses } = useQuery<any[]>({
    queryKey: ['/api/sync-status'],
    refetchInterval: (query) => {
      const statuses = query.state.data;
      const isAnyInProgress = Array.isArray(statuses) && statuses.some(s => s.status === 'in_progress');
      return isAnyInProgress ? 2000 : 10000;
    }
  });

  const displaySync = syncStatuses?.find(s => s.syncType === 'omie_billings');

  useEffect(() => {
    if (displaySync?.status === 'in_progress' && displaySync?.lastSyncAt) {
      const startTime = new Date(displaySync.lastSyncAt).getTime();
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      elapsedIntervalRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
      setElapsedSeconds(null);
    }
    return () => {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    };
  }, [displaySync?.status, displaySync?.lastSyncAt]);

  // Detectar conclusão do sync via polling (confiável em produção, independente do SSE)
  const prevSyncFinishedRef = useRef<string | null>(null);
  useEffect(() => {
    const finishedAt = displaySync?.lastFinishedAt;
    if (!finishedAt) return;
    if (prevSyncFinishedRef.current === finishedAt) return;
    if (prevSyncFinishedRef.current !== null) {
      // Sync acabou de completar — atualizar lista
      queryClient.invalidateQueries({ queryKey: ['/api/billings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/billings/stats'] });
      toast({
        title: 'Sincronização concluída',
        description: displaySync?.message || 'Lista de faturamentos atualizada.',
      });
    }
    prevSyncFinishedRef.current = finishedAt;
  }, [displaySync?.lastFinishedAt]);

  return (
    <div className="p-6 space-y-6">
      {/* Back Button */}
      <div>
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
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold" data-testid="page-title">Faturamentos</h1>
          <p className="text-muted-foreground">
            Gerencie faturamentos e cenários fiscais
          </p>
        </div>
        
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2 flex-wrap justify-end">
            <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
            
            <Button 
              variant="outline" 
              onClick={() => exportToExcel(filteredBillings.map((b) => ({ Pedido: b.orderNumber || "", NF: b.invoiceNumber || "", CFOP: getCfopDisplayName(b.cfop), Cliente: b.customerFantasyName || "", Data: b.invoiceDate ? formatDate(b.invoiceDate) : "", Valor: b.totalValue, Vencimento: b.dueDate ? formatDate(b.dueDate) : "", Pagamento: b.paymentMethod || "", Vendedor: b.sellerName || "", Etapa: b.invoiceStage || "" })), "faturamentos")} 
              data-testid="button-export"
              title="Exportar todos os dados do Omie para Excel"
            >
              <Download className="w-4 h-4 mr-2" />
              Exportar Excel
            </Button>
          </div>
          
          <div className="text-right">
            {displaySync?.status === 'in_progress' && elapsedSeconds !== null ? (
              <p className="text-xs font-semibold text-orange-600 animate-pulse">
                ⏱ Em andamento há {elapsedSeconds >= 60
                  ? `${Math.floor(elapsedSeconds / 60)}min ${elapsedSeconds % 60}s`
                  : `${elapsedSeconds}s`}
              </p>
            ) : (
              <>
                {displaySync?.lastSyncAt && (
                  <p className="text-xs text-muted-foreground">Última tentativa: {new Date(displaySync.lastSyncAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
                )}
                {displaySync?.lastFinishedAt && (
                  <p className="text-xs font-medium text-green-600">Última conclusão: {new Date(displaySync.lastFinishedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
                )}
                {displaySync?.syncDurationSeconds != null && (
                  <p className="text-xs text-muted-foreground">
                    Duração: {displaySync.syncDurationSeconds >= 60
                      ? `${Math.floor(displaySync.syncDurationSeconds / 60)}min ${displaySync.syncDurationSeconds % 60}s`
                      : `${displaySync.syncDurationSeconds}s`}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="faturamentos" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="faturamentos" className="flex items-center gap-2">
            <Download className="h-4 w-4" />Faturamentos
          </TabsTrigger>
          <TabsTrigger value="cenarios" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />Cenários Fiscais
          </TabsTrigger>
        </TabsList>

        <TabsContent value="cenarios" className="mt-4">
          <FiscalScenariosTab />
        </TabsContent>

        <TabsContent value="faturamentos" className="space-y-6 mt-4">

      {/* Estatísticas */}
      {stats && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total de Notas</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="stats-total-invoices">
                {stats.totalInvoices?.toLocaleString('pt-BR') || 0}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Valor Total</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="stats-total-value">
                {formatCurrency(stats.totalValue || 0)}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Valor Médio</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="stats-average-value">
                {formatCurrency(stats.averageValue || 0)}
              </div>
            </CardContent>
          </Card>
          
        </div>
      )}

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="w-5 h-5" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label>Nota Fiscal</Label>
              <Input
                placeholder="Número da NF"
                value={filters.invoiceNumber || ''}
                onChange={(e) => handleFilterChange('invoiceNumber', e.target.value)}
                data-testid="filter-invoice-number"
              />
            </div>
            
            <div className="space-y-2">
              <Label>CNPJ/CPF</Label>
              <Input
                placeholder="Documento do cliente"
                value={filters.customerDocument || ''}
                onChange={(e) => handleFilterChange('customerDocument', e.target.value)}
                data-testid="filter-customer-document"
              />
            </div>
            <div className="space-y-2">
              <Label>Cliente (nome)</Label>
              <Input placeholder="Buscar por nome" value={customerNameSearch} onChange={(e) => setCustomerNameSearch(e.target.value)} data-testid="filter-customer-name" />
            </div>
            
            <div className="space-y-2">
              <Label>Data Inicial</Label>
              <Input
                type="date"
                value={filters.startDate || ''}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                data-testid="filter-start-date"
              />
            </div>
            
            <div className="space-y-2">
              <Label>Data Final</Label>
              <Input
                type="date"
                value={filters.endDate || ''}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                data-testid="filter-end-date"
              />
            </div>

            <div className="space-y-2">
              <Label>CFOP</Label>
              <Select 
                value={filters.cfop || ''}
                onValueChange={(value) => handleFilterChange('cfop', value === 'all' ? '' : value)}
              >
                <SelectTrigger data-testid="filter-cfop">
                  <SelectValue placeholder="Selecionar CFOP" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="VENDA">VENDA</SelectItem>
                  <SelectItem value="TROCA">TROCA</SelectItem>
                  <SelectItem value="AMOSTRA">AMOSTRA</SelectItem>
                  <SelectItem value="BONIFICAÇÃO">BONIFICAÇÃO</SelectItem>
                  <SelectItem value="ENTRADA">ENTRADA</SelectItem>
                  <SelectItem value="DEVOLUÇÃO">DEVOLUÇÃO</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Etapa</Label>
              <Select 
                value={filters.invoiceStage || ''}
                onValueChange={(value) => handleFilterChange('invoiceStage', value === 'all' ? '' : value)}
              >
                <SelectTrigger data-testid="filter-invoice-stage">
                  <SelectValue placeholder="Selecionar Etapa" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="CANCELADO">CANCELADO</SelectItem>
                  <SelectItem value="Pedido de Venda">Pedido de Venda</SelectItem>
                  <SelectItem value="Faturado">Faturado</SelectItem>
                  <SelectItem value="Aguardando Rota">Aguardando Rota</SelectItem>
                  <SelectItem value="Em Rota">Em Rota</SelectItem>
                  <SelectItem value="Entregue">Entregue</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Vendedor</Label>
              <div><MultiSelect label="Vendedor" options={sellerOptions} groups={sellerGroups} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller" /></div>
            </div>

            {omieInstances && omieInstances.length > 0 && (
              <div className="space-y-2">
                <Label>Instância Omie</Label>
                <Select 
                  value={filters.omieInstanceId || 'all'}
                  onValueChange={(value) => handleFilterChange('omieInstanceId', value === 'all' ? undefined : value)}
                >
                  <SelectTrigger data-testid="filter-omie-instance">
                    <SelectValue placeholder="Selecionar Instância" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    {omieInstances.map((instance) => (
                      <SelectItem key={instance.id} value={instance.id}>
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: instance.tagColor }} />
                          {instance.displayName}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            
            <div className="space-y-2">
              <Label>Itens por página</Label>
              <Select 
                value={filters.pageSize.toString()} 
                onValueChange={(value) => handleFilterChange('pageSize', parseInt(value))}
              >
                <SelectTrigger data-testid="filter-page-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <Separator className="my-4" />
          
          <div className="flex gap-2">
            <Button variant="outline" onClick={clearFilters} data-testid="button-clear-filters">
              Limpar Filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tabela de Faturamentos */}
      <Card>
        <CardHeader>
          <CardTitle>
            Lista de Faturamentos
            {billingsData?.total && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                ({billingsData.total} registros)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingBillings ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin" />
              <span className="ml-2">Carregando...</span>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader field="orderNumber">Nº Pedido</SortableHeader>
                    <SortableHeader field="invoiceNumber">Nº NF</SortableHeader>
                    <SortableHeader field="cfop">CFOP</SortableHeader>
                    <SortableHeader field="customerFantasyName">Cliente</SortableHeader>
                    <SortableHeader field="invoiceDate">Data Fat.</SortableHeader>
                    <SortableHeader field="totalValue">Valor</SortableHeader>
                    <SortableHeader field="dueDate">Vencimento</SortableHeader>
                    <SortableHeader field="paymentMethod">Pagamento</SortableHeader>
                    <SortableHeader field="sellerName">Vendedor</SortableHeader>
                    <SortableHeader field="invoiceStage">Etapa</SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(billingsData?.billings.length || 0) === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        Nenhum faturamento encontrado
                      </TableCell>
                    </TableRow>
                  ) : (
                    billingsData?.billings.map((billing) => (
                      <TableRow key={billing.id} data-testid={`row-billing-${billing.id}`}>
                        <TableCell className="font-mono text-sm" data-testid={`cell-order-${billing.id}`}>
                          {billing.orderNumber || '-'}
                        </TableCell>
                        <TableCell className="font-mono text-sm" data-testid={`cell-invoice-${billing.invoiceNumber}`}>
                          {billing.invoiceNumber || '-'}
                        </TableCell>
                        <TableCell data-testid={`cell-cfop-${billing.id}`}>
                          <Badge variant="outline">{getCfopDisplayName(billing.cfop)}</Badge>
                        </TableCell>
                        <TableCell data-testid={`cell-customer-${billing.id}`}>
                          <div className="flex items-center gap-2">
                            <span>{billing.customerFantasyName || '-'}</span>
                            <OmieInstanceBadge instanceId={billing.omieInstanceId} />
                          </div>
                        </TableCell>
                        <TableCell data-testid={`cell-date-${billing.id}`}>
                          {formatDate(billing.invoiceDate)}
                        </TableCell>
                        <TableCell className="font-semibold" data-testid={`cell-value-${billing.id}`}>
                          {formatCurrency(billing.totalValue)}
                        </TableCell>
                        <TableCell data-testid={`cell-due-date-${billing.id}`}>
                          {billing.dueDate ? formatDate(billing.dueDate) : '-'}
                        </TableCell>
                        <TableCell data-testid={`cell-payment-${billing.id}`}>
                          <Badge variant="secondary">{billing.paymentMethod || '-'}</Badge>
                        </TableCell>
                        <TableCell data-testid={`cell-seller-${billing.id}`}>
                          {billing.sellerName || '-'}
                        </TableCell>
                        <TableCell data-testid={`cell-stage-${billing.id}`}>
                          <Badge variant="outline">{billing.invoiceStage || '-'}</Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Paginação */}
          {billingsData && billingsData.total > 0 && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Página {filters.page} de {Math.ceil(billingsData.total / filters.pageSize)} 
                ({billingsData.total} registros)
              </div>
              
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleFilterChange('page', filters.page - 1)}
                  disabled={filters.page === 1}
                  data-testid="button-prev-page"
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleFilterChange('page', filters.page + 1)}
                  disabled={filters.page >= Math.ceil(billingsData.total / filters.pageSize)}
                  data-testid="button-next-page"
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

        </TabsContent>
      </Tabs>
    </div>
  );
}
