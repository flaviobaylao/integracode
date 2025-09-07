import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { RefreshCw, FileText, Calendar, DollarSign } from "lucide-react";

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

  const totalBillings = billings.length;
  const totalValue = billings.reduce((sum, billing) => sum + billing.totalValue, 0);
  const salesCount = billings.filter(b => b.billingType === 'venda').length;
  const exchangesCount = billings.filter(b => b.billingType === 'troca').length;

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

      {/* Billings Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Lista de Faturamentos
          </CardTitle>
        </CardHeader>
        <CardContent>
          {billings.length === 0 ? (
            <div className="text-center py-10">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">Nenhum faturamento encontrado</p>
              <Button onClick={handleSync} variant="outline" data-testid="button-sync-empty">
                <RefreshCw className="h-4 w-4 mr-2" />
                Sincronizar do Omie
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nota Fiscal</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Vendedor</TableHead>
                  <TableHead>Pagamento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {billings.map((billing) => (
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