import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useState, useMemo } from "react";
import { RefreshCw, FileText, Calendar, DollarSign, Search, Filter, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

interface Billing {
  id: string;
  omieInvoiceId: string;
  invoiceNumber: string;
  customerFantasyName: string;
  billingType: 'venda' | 'troca' | 'amostra';
  totalValue: number;
  invoiceDate: string;
  sellerId: string;
  sellerName: string;
  paymentMethod: string;
  dueDate?: string;
  invoiceStatus: string;
  products?: Array<{
    code: string;
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export default function Billings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Estados dos filtros
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    customerName: '',
    sellerName: ''
  });

  // Estado da ordenação
  const [sorting, setSorting] = useState<{
    field: keyof Billing | null;
    direction: 'asc' | 'desc';
  }>({
    field: null,
    direction: 'asc'
  });

  // Buscar faturamentos
  const { data: billings = [], isLoading, error } = useQuery<Billing[]>({
    queryKey: ['/api/billings'],
    retry: false,
  });

  // Mutação para sincronizar faturamentos
  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/omie/sync-billings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Erro na sincronização');
      }

      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/billings'] });
      toast({
        title: "Sincronização concluída",
        description: `${data.imported} importados, ${data.updated} atualizados, ${data.totalProcessed} processados`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await syncMutation.mutateAsync();
    } finally {
      setIsSyncing(false);
    }
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

  const getBillingTypeBadge = (type: string) => {
    const variants = {
      venda: { color: 'bg-green-100 text-green-800', label: 'Venda' },
      troca: { color: 'bg-yellow-100 text-yellow-800', label: 'Troca' },
      amostra: { color: 'bg-blue-100 text-blue-800', label: 'Amostra' },
    };
    const variant = variants[type as keyof typeof variants] || variants.venda;
    return (
      <Badge className={variant.color}>
        {variant.label}
      </Badge>
    );
  };

  // Aplicar filtros e ordenação
  const filteredBillings = useMemo(() => {
    let filtered = billings.filter((billing) => {
      // Filtro por data de início
      if (filters.startDate) {
        const billingDate = new Date(billing.invoiceDate);
        const startDate = new Date(filters.startDate);
        if (billingDate < startDate) return false;
      }
      
      // Filtro por data final
      if (filters.endDate) {
        const billingDate = new Date(billing.invoiceDate);
        const endDate = new Date(filters.endDate);
        if (billingDate > endDate) return false;
      }
      
      // Filtro por nome do cliente
      if (filters.customerName) {
        const customerName = billing.customerFantasyName.toLowerCase();
        const searchTerm = filters.customerName.toLowerCase();
        if (!customerName.includes(searchTerm)) return false;
      }
      
      // Filtro por vendedor
      if (filters.sellerName) {
        const sellerName = (billing.sellerName || '').toLowerCase();
        const searchTerm = filters.sellerName.toLowerCase();
        if (!sellerName.includes(searchTerm)) return false;
      }
      
      return true;
    });

    // Aplicar ordenação
    if (sorting.field) {
      filtered.sort((a, b) => {
        let aValue = a[sorting.field!];
        let bValue = b[sorting.field!];

        // Tratamento especial para diferentes tipos de dados
        if (sorting.field === 'totalValue') {
          aValue = Number(aValue) || 0;
          bValue = Number(bValue) || 0;
        } else if (sorting.field === 'invoiceDate') {
          aValue = new Date(aValue as string).getTime();
          bValue = new Date(bValue as string).getTime();
        } else if (sorting.field === 'invoiceNumber') {
          // Para número da nota fiscal, ordenar numericamente se possível
          const aNum = Number(String(aValue).replace(/\D/g, '')) || 0;
          const bNum = Number(String(bValue).replace(/\D/g, '')) || 0;
          aValue = aNum;
          bValue = bNum;
        } else {
          // Para strings, converter para lowercase
          aValue = String(aValue || '').toLowerCase();
          bValue = String(bValue || '').toLowerCase();
        }

        if (aValue < bValue) return sorting.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sorting.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [billings, filters, sorting]);

  const totalBillings = filteredBillings.length;
  const totalValue = filteredBillings.reduce((sum, billing) => sum + billing.totalValue, 0);
  const salesCount = filteredBillings.filter(b => b.billingType === 'venda').length;
  const exchangesCount = filteredBillings.filter(b => b.billingType === 'troca').length;

  const handleFilterChange = (field: string, value: string) => {
    setFilters(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const clearFilters = () => {
    setFilters({
      startDate: '',
      endDate: '',
      customerName: '',
      sellerName: ''
    });
  };

  // Função para lidar com ordenação
  const handleSort = (field: keyof Billing) => {
    setSorting(prev => {
      if (prev.field === field) {
        // Se é o mesmo campo, alterna a direção
        return {
          field,
          direction: prev.direction === 'asc' ? 'desc' : 'asc'
        };
      } else {
        // Se é um novo campo, começa com ascendente
        return {
          field,
          direction: 'asc'
        };
      }
    });
  };

  // Função para renderizar ícone de ordenação
  const getSortIcon = (field: keyof Billing) => {
    if (sorting.field !== field) {
      return <ChevronsUpDown className="h-4 w-4 text-gray-400" />;
    }
    return sorting.direction === 'asc' 
      ? <ChevronUp className="h-4 w-4 text-honest-blue" />
      : <ChevronDown className="h-4 w-4 text-honest-blue" />;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-20 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-10">
        <p className="text-red-600">Erro ao carregar faturamentos</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Faturamentos</h1>
          <p className="text-gray-600">Gerencie e sincronize notas fiscais do Omie ERP</p>
        </div>
        <Button
          onClick={handleSync}
          disabled={isSyncing}
          className="bg-honest-blue hover:bg-blue-700"
          data-testid="button-sync-billings"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
          {isSyncing ? 'Sincronizando...' : 'Sincronizar Omie'}
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Total de Notas</p>
                <h3 className="text-2xl font-bold text-gray-800" data-testid="text-total-billings">
                  {totalBillings}
                </h3>
              </div>
              <FileText className="h-8 w-8 text-honest-blue" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Valor Total</p>
                <h3 className="text-2xl font-bold text-gray-800" data-testid="text-total-value">
                  {formatCurrency(totalValue)}
                </h3>
              </div>
              <DollarSign className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Vendas</p>
                <h3 className="text-2xl font-bold text-green-600" data-testid="text-sales-count">
                  {salesCount}
                </h3>
              </div>
              <div className="h-8 w-8 bg-green-100 rounded-full flex items-center justify-center">
                <i className="fas fa-chart-line text-green-600"></i>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Trocas</p>
                <h3 className="text-2xl font-bold text-yellow-600" data-testid="text-exchanges-count">
                  {exchangesCount}
                </h3>
              </div>
              <div className="h-8 w-8 bg-yellow-100 rounded-full flex items-center justify-center">
                <i className="fas fa-exchange-alt text-yellow-600"></i>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="space-y-2">
              <Label htmlFor="start-date">Data Inicial</Label>
              <Input
                id="start-date"
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                data-testid="input-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date">Data Final</Label>
              <Input
                id="end-date"
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                data-testid="input-end-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-search">Nome do Cliente</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="customer-search"
                  type="text"
                  placeholder="Buscar por cliente..."
                  value={filters.customerName}
                  onChange={(e) => handleFilterChange('customerName', e.target.value)}
                  className="pl-9"
                  data-testid="input-customer-search"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="seller-search">Nome do Vendedor</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="seller-search"
                  type="text"
                  placeholder="Buscar por vendedor..."
                  value={filters.sellerName}
                  onChange={(e) => handleFilterChange('sellerName', e.target.value)}
                  className="pl-9"
                  data-testid="input-seller-search"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-600">
              Mostrando {totalBillings} de {billings.length} faturamentos
            </p>
            <Button 
              onClick={clearFilters} 
              variant="outline" 
              size="sm"
              data-testid="button-clear-filters"
            >
              Limpar Filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Billings Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Lista de Faturamentos
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredBillings.length === 0 ? (
            <div className="text-center py-10">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">
                {billings.length === 0 
                  ? "Nenhum faturamento encontrado" 
                  : "Nenhum faturamento corresponde aos filtros aplicados"
                }
              </p>
              {billings.length === 0 ? (
                <Button onClick={handleSync} variant="outline" data-testid="button-sync-empty">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Sincronizar do Omie
                </Button>
              ) : (
                <Button onClick={clearFilters} variant="outline" data-testid="button-clear-filters-empty">
                  Limpar Filtros
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('invoiceNumber')}
                    data-testid="header-invoice-number"
                  >
                    <div className="flex items-center justify-between">
                      <span>Nota Fiscal</span>
                      {getSortIcon('invoiceNumber')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('customerFantasyName')}
                    data-testid="header-customer"
                  >
                    <div className="flex items-center justify-between">
                      <span>Cliente</span>
                      {getSortIcon('customerFantasyName')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('billingType')}
                    data-testid="header-billing-type"
                  >
                    <div className="flex items-center justify-between">
                      <span>Tipo</span>
                      {getSortIcon('billingType')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('totalValue')}
                    data-testid="header-total-value"
                  >
                    <div className="flex items-center justify-between">
                      <span>Valor</span>
                      {getSortIcon('totalValue')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('invoiceDate')}
                    data-testid="header-invoice-date"
                  >
                    <div className="flex items-center justify-between">
                      <span>Data</span>
                      {getSortIcon('invoiceDate')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('sellerName')}
                    data-testid="header-seller-name"
                  >
                    <div className="flex items-center justify-between">
                      <span>Vendedor</span>
                      {getSortIcon('sellerName')}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="cursor-pointer select-none hover:bg-gray-50 transition-colors"
                    onClick={() => handleSort('paymentMethod')}
                    data-testid="header-payment-method"
                  >
                    <div className="flex items-center justify-between">
                      <span>Pagamento</span>
                      {getSortIcon('paymentMethod')}
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBillings.map((billing) => (
                  <TableRow key={billing.id} data-testid={`row-billing-${billing.id}`}>
                    <TableCell className="font-medium">
                      <div>
                        <p className="font-semibold">{billing.invoiceNumber}</p>
                        <p className="text-sm text-gray-500">ID: {billing.omieInvoiceId}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{billing.customerFantasyName}</p>
                    </TableCell>
                    <TableCell>
                      {getBillingTypeBadge(billing.billingType)}
                    </TableCell>
                    <TableCell>
                      <p className="font-semibold text-green-600">
                        {formatCurrency(billing.totalValue)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Calendar className="h-4 w-4 text-gray-400" />
                        {formatDate(billing.invoiceDate)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <p>{billing.sellerName || 'N/A'}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {billing.paymentMethod || 'N/A'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}