import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/hooks/use-toast';
import { Calendar, Download, Filter, RefreshCw, Search, RotateCw, TrendingUp } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
  invoiceNumber: string;
  customerFantasyName: string;
  customerDocument: string;
  cfop: string;
  invoiceDate: string;
  totalValue: number;
  dueDate: string;
  paymentMethod: string;
  sellerName: string;
  sellerId: string;
  billingType: string;
  invoiceStatus: string;
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
  page: number;
  pageSize: number;
}

export default function Billings() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<BillingFilters>({
    page: 1,
    pageSize: 50,
  });
  const [syncPeriod, setSyncPeriod] = useState({
    startDate: '',
    endDate: ''
  });
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [sortField, setSortField] = useState<keyof Billing>('invoiceDate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Query para buscar faturamentos
  const { data: billingsData, isLoading: isLoadingBillings, refetch } = useQuery({
    queryKey: ['/api/billings', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          params.append(key, value.toString());
        }
      });
      return fetch(`/api/billings?${params.toString()}`).then(res => res.json());
    }
  });

  // Query para estatísticas
  const { data: stats } = useQuery({
    queryKey: ['/api/billings/stats', filters.sellerId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.sellerId) params.append('sellerId', filters.sellerId);
      return fetch(`/api/billings/stats?${params.toString()}`).then(res => res.json());
    }
  });

  // Mutation para sincronização
  const syncMutation = useMutation({
    mutationFn: (data: { startDate: string; endDate: string }) =>
      apiRequest('/api/billings/sync', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (result) => {
      toast({
        title: 'Sincronização concluída',
        description: `${result.totalProcessed} faturamentos processados. ${result.imported} importados, ${result.updated} atualizados.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/billings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/billings/stats'] });
      setShowSyncDialog(false);
    },
    onError: (error: any) => {
      toast({
        title: 'Erro na sincronização',
        description: error.message || 'Erro desconhecido',
        variant: 'destructive',
      });
    }
  });

  const handleSync = () => {
    if (!syncPeriod.startDate || !syncPeriod.endDate) {
      toast({
        title: 'Erro',
        description: 'Por favor, selecione o período para sincronização',
        variant: 'destructive',
      });
      return;
    }
    syncMutation.mutate(syncPeriod);
  };

  const handleFilterChange = (key: keyof BillingFilters, value: string | number) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
      page: 1 // Reset para primeira página ao filtrar
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

  // Ordenar dados localmente
  const sortedBillings = billingsData?.billings ? [...billingsData.billings].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];
    
    if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
    if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  }) : [];

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  const SortableHeader = ({ field, children }: { field: keyof Billing; children: React.ReactNode }) => (
    <TableHead 
      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
      onClick={() => handleSort(field)}
      data-testid={`header-${field}`}
    >
      <div className="flex items-center gap-1">
        {children}
        {sortField === field && (
          <span className="text-xs">
            {sortDirection === 'asc' ? '↑' : '↓'}
          </span>
        )}
      </div>
    </TableHead>
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold" data-testid="page-title">Faturamentos</h1>
          <p className="text-muted-foreground">
            Sincronize e visualize notas fiscais do Omie ERP
          </p>
        </div>
        
        <div className="flex gap-2">
          <Dialog open={showSyncDialog} onOpenChange={setShowSyncDialog}>
            <DialogTrigger asChild>
              <Button data-testid="button-sync">
                <RotateCw className="w-4 h-4 mr-2" />
                Sincronizar
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sincronizar Faturamentos</DialogTitle>
                <DialogDescription>
                  Selecione o período para sincronizar notas fiscais do Omie ERP
                </DialogDescription>
              </DialogHeader>
              
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="start-date">Data Inicial</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={syncPeriod.startDate}
                    onChange={(e) => setSyncPeriod(prev => ({ ...prev, startDate: e.target.value }))}
                    data-testid="input-start-date"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="end-date">Data Final</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={syncPeriod.endDate}
                    onChange={(e) => setSyncPeriod(prev => ({ ...prev, endDate: e.target.value }))}
                    data-testid="input-end-date"
                  />
                </div>
              </div>
              
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowSyncDialog(false)}>
                  Cancelar
                </Button>
                <Button 
                  onClick={handleSync} 
                  disabled={syncMutation.isPending}
                  data-testid="button-execute-sync"
                >
                  {syncMutation.isPending && <RefreshCw className="w-4 h-4 mr-2 animate-spin" />}
                  Sincronizar
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          
          <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

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
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Período</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground">
                {stats.period}
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
                    <SortableHeader field="invoiceNumber">Nota Fiscal</SortableHeader>
                    <SortableHeader field="customerFantasyName">Cliente</SortableHeader>
                    <SortableHeader field="customerDocument">CNPJ/CPF</SortableHeader>
                    <SortableHeader field="cfop">CFOP</SortableHeader>
                    <SortableHeader field="invoiceDate">Data Fat.</SortableHeader>
                    <SortableHeader field="totalValue">Valor</SortableHeader>
                    <SortableHeader field="dueDate">Vencimento</SortableHeader>
                    <SortableHeader field="paymentMethod">Pagamento</SortableHeader>
                    <SortableHeader field="sellerName">Vendedor</SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedBillings.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                        Nenhum faturamento encontrado
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedBillings.map((billing) => (
                      <TableRow key={billing.id} data-testid={`row-billing-${billing.id}`}>
                        <TableCell className="font-medium" data-testid={`cell-invoice-${billing.invoiceNumber}`}>
                          {billing.invoiceNumber}
                        </TableCell>
                        <TableCell data-testid={`cell-customer-${billing.id}`}>
                          {billing.customerFantasyName}
                        </TableCell>
                        <TableCell data-testid={`cell-document-${billing.id}`}>
                          {billing.customerDocument}
                        </TableCell>
                        <TableCell data-testid={`cell-cfop-${billing.id}`}>
                          <Badge variant="outline">{billing.cfop}</Badge>
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
    </div>
  );
}