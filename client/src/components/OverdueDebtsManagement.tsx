import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, RefreshCw, Search, Eye, Download } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as XLSX from 'xlsx';

interface OverdueDebt {
  cliente: {
    codigo_cliente_omie: number;
    nome_fantasia: string;
    cnpj_cpf: string;
  };
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

interface OverdueDebtsData {
  debts: OverdueDebt[];
  totalAmount: number;
  totalClients: number;
}

export default function OverdueDebtsManagement() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedDebt, setSelectedDebt] = useState<OverdueDebt | null>(null);
  const [selectedVendor, setSelectedVendor] = useState<string>("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Query para buscar débitos vencidos do Omie
  const { data: overdueDebts, isLoading, refetch } = useQuery<OverdueDebtsData>({
    queryKey: ['/api/omie/overdue-debts'],
    enabled: false, // Não carregar automaticamente
  });

  // Query para buscar vendedores
  const { data: vendedores, isLoading: isLoadingVendedores } = useQuery<any[]>({
    queryKey: ['/api/omie/vendedores'],
    staleTime: 1000 * 60 * 10, // 10 minutos
  });


  // Mutation para sincronizar débitos vencidos
  const syncOverdueDebts = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/omie/overdue-debts', {
        method: 'GET',
        credentials: 'include'
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Erro ao sincronizar débitos');
      }
      
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['/api/omie/overdue-debts'], data);
      toast({
        title: "Sincronização concluída",
        description: `${data.totalClients} clientes com débitos vencidos encontrados.`,
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

  const filteredDebts = overdueDebts?.debts?.filter(debt => {
    const searchLower = searchTerm.toLowerCase();
    const matchesSearch = debt.cliente.nome_fantasia.toLowerCase().includes(searchLower) ||
                         debt.cliente.cnpj_cpf.includes(searchTerm);
    
    const matchesVendor = selectedVendor === "all" || 
                         debt.vendedores?.includes(parseInt(selectedVendor));
    
    return matchesSearch && matchesVendor;
  }) || [];

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  // Função para exportar débitos para Excel
  const exportToExcel = () => {
    if (!overdueDebts?.debts || overdueDebts.debts.length === 0) {
      toast({
        title: "Nenhum dado para exportar",
        description: "Não há débitos vencidos para exportar.",
        variant: "destructive",
      });
      return;
    }

    try {
      // Preparar dados para planilha principal (resumo por cliente)
      const resumoData = filteredDebts.map((debt, index) => ({
        'Código Cliente': debt.cliente.codigo_cliente_omie,
        'Nome/Razão Social': debt.cliente.nome_fantasia,
        'CNPJ/CPF': debt.cliente.cnpj_cpf,
        'Valor Total em Atraso': debt.valorTotal,
        'Máximo Dias em Atraso': debt.diasMaximoAtraso,
        'Quantidade de Documentos': debt.debitos.length,
      }));

      // Preparar dados detalhados (todos os documentos)
      const detalhesData: any[] = [];
      filteredDebts.forEach((debt) => {
        debt.debitos.forEach((documento) => {
          detalhesData.push({
            'Código Cliente': debt.cliente.codigo_cliente_omie,
            'Nome/Razão Social': debt.cliente.nome_fantasia,
            'CNPJ/CPF': debt.cliente.cnpj_cpf,
            'Número Documento': documento.numero_documento,
            'Valor': documento.valor,
            'Data Vencimento': documento.data_vencimento,
            'Dias em Atraso': documento.dias_atraso,
            'Observação': documento.observacao || '',
          });
        });
      });

      // Criar workbook
      const workbook = XLSX.utils.book_new();

      // Aba 1: Resumo por cliente
      const resumoSheet = XLSX.utils.json_to_sheet(resumoData);
      XLSX.utils.book_append_sheet(workbook, resumoSheet, 'Resumo por Cliente');

      // Aba 2: Detalhes dos documentos
      const detalhesSheet = XLSX.utils.json_to_sheet(detalhesData);
      XLSX.utils.book_append_sheet(workbook, detalhesSheet, 'Detalhes dos Documentos');

      // Aba 3: Estatísticas gerais
      const estatisticasData = [
        { 'Métrica': 'Total de Clientes com Débitos', 'Valor': overdueDebts.totalClients },
        { 'Métrica': 'Valor Total em Atraso', 'Valor': overdueDebts.totalAmount },
        { 'Métrica': 'Valor Médio por Cliente', 'Valor': overdueDebts.totalClients > 0 ? (overdueDebts.totalAmount / overdueDebts.totalClients) : 0 },
        { 'Métrica': 'Total de Documentos Vencidos', 'Valor': detalhesData.length },
        { 'Métrica': 'Data da Exportação', 'Valor': new Date().toLocaleDateString('pt-BR') },
      ];
      const estatisticasSheet = XLSX.utils.json_to_sheet(estatisticasData);
      XLSX.utils.book_append_sheet(workbook, estatisticasSheet, 'Estatísticas');

      // Gerar nome do arquivo
      const dataAtual = new Date().toISOString().split('T')[0];
      const nomeArquivo = `debitos-vencidos-${dataAtual}.xlsx`;

      // Fazer download
      XLSX.writeFile(workbook, nomeArquivo);

      toast({
        title: "Exportação concluída",
        description: `Arquivo "${nomeArquivo}" baixado com sucesso.`,
      });

    } catch (error) {
      console.error('Erro ao exportar para Excel:', error);
      toast({
        title: "Erro na exportação",
        description: "Ocorreu um erro ao gerar o arquivo Excel.",
        variant: "destructive",
      });
    }
  };

  // Função para comparar arquivo Excel
  const compareExcelFile = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('excelFile', file);

      const response = await fetch('/api/omie/compare-excel', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });

      if (!response.ok) {
        let errorMessage = 'Erro ao comparar arquivo';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorMessage;
        } catch {
          // Se não conseguir fazer parse do JSON, usar a mensagem padrão
          errorMessage = `Erro HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      let result;
      try {
        result = await response.json();
      } catch (jsonError) {
        console.error('Erro ao fazer parse do JSON:', jsonError);
        throw new Error('Resposta inválida do servidor. Verifique os logs do console.');
      }
      setComparisonResult(result);
      setShowComparisonModal(true);

      toast({
        title: "Comparação concluída",
        description: "Arquivo Excel analisado com sucesso.",
      });

    } catch (error: any) {
      console.error('Erro ao comparar arquivo Excel:', error);
      toast({
        title: "Erro na comparação",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && 
          !file.name.endsWith('.xlsx')) {
        toast({
          title: "Formato inválido",
          description: "Por favor, selecione um arquivo Excel (.xlsx).",
          variant: "destructive",
        });
        return;
      }
      compareExcelFile(file);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Débitos Vencidos</h1>
          <p className="text-gray-600 mt-1">
            Gerencie os débitos vencidos dos clientes no Omie ERP
          </p>
        </div>
        <div className="flex space-x-3">
          {overdueDebts && filteredDebts.length > 0 && (
            <>
              <Button 
                onClick={exportToExcel}
                variant="outline"
                data-testid="button-export-excel"
              >
                <Download className="h-4 w-4 mr-2" />
                Exportar Excel
              </Button>
            </>
          )}
          <Button 
            onClick={() => syncOverdueDebts.mutate()}
            disabled={syncOverdueDebts.isPending}
            className="bg-honest-orange hover:bg-honest-orange-dark"
            data-testid="button-sync-overdue-debts"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncOverdueDebts.isPending ? 'animate-spin' : ''}`} />
            {syncOverdueDebts.isPending ? 'Sincronizando...' : 'Sincronizar Débitos'}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {overdueDebts && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center">
                <div className="p-2 bg-red-100 rounded-lg mr-4">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-600">Total de Clientes</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {overdueDebts.totalClients}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center">
                <div className="p-2 bg-orange-100 rounded-lg mr-4">
                  <AlertTriangle className="h-6 w-6 text-orange-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-600">Valor Total</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {formatCurrency(overdueDebts.totalAmount)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center">
                <div className="p-2 bg-yellow-100 rounded-lg mr-4">
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-600">Média por Cliente</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {overdueDebts.totalClients > 0 
                      ? formatCurrency(overdueDebts.totalAmount / overdueDebts.totalClients)
                      : formatCurrency(0)
                    }
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Search */}
      {overdueDebts && (
        <div className="flex items-center space-x-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Buscar por nome ou documento..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
              data-testid="input-search-debts"
            />
          </div>
          <div className="min-w-[200px]">
            <Select value={selectedVendor} onValueChange={setSelectedVendor}>
              <SelectTrigger data-testid="select-vendor-filter">
                <SelectValue placeholder={isLoadingVendedores ? "Carregando..." : "Filtrar por vendedor"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os vendedores</SelectItem>
                {vendedores?.map((vendedor) => (
                  <SelectItem key={vendedor.codigo} value={vendedor.codigo.toString()}>
                    {vendedor.nome || `Vendedor ${vendedor.codigo}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Initial state */}
      {!overdueDebts && !isLoading && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Clique em "Sincronizar Débitos" para carregar os débitos vencidos do Omie ERP.
          </AlertDescription>
        </Alert>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
          <Skeleton className="h-[200px] w-full" />
        </div>
      )}

      {/* Débitos List */}
      {overdueDebts && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Lista de Débitos Vencidos</span>
              <Badge variant="secondary">
                {filteredDebts.length} cliente(s)
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredDebts.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                {searchTerm ? 'Nenhum débito encontrado para a busca.' : 'Nenhum débito vencido encontrado.'}
              </div>
            ) : (
              <div className="space-y-4">
                {filteredDebts.map((debt, index) => (
                  <div
                    key={index}
                    className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg text-gray-900">
                          {debt.cliente.nome_fantasia}
                        </h3>
                        <p className="text-sm text-gray-600">
                          {debt.cliente.cnpj_cpf}
                        </p>
                      </div>
                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <p className="font-bold text-lg text-red-600">
                            {formatCurrency(debt.valorTotal)}
                          </p>
                          <p className="text-sm text-gray-600">
                            {debt.diasMaximoAtraso} dias em atraso
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedDebt(debt)}
                          data-testid={`button-view-debt-${index}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3">
                      <Badge 
                        variant={debt.diasMaximoAtraso > 60 ? "destructive" : 
                               debt.diasMaximoAtraso > 30 ? "secondary" : "outline"}
                      >
                        {debt.debitos.length} documento(s) vencido(s)
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Modal de detalhes do débito */}
      {selectedDebt && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-2xl max-h-[80vh] overflow-hidden">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center justify-between">
                <span>Detalhes do Débito</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedDebt(null)}
                >
                  ×
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 overflow-y-auto">
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-lg">
                    {selectedDebt.cliente.nome_fantasia}
                  </h3>
                  <p className="text-gray-600">{selectedDebt.cliente.cnpj_cpf}</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-600">Valor Total</p>
                    <p className="font-bold text-lg text-red-600">
                      {formatCurrency(selectedDebt.valorTotal)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Máximo em Atraso</p>
                    <p className="font-bold text-lg">
                      {selectedDebt.diasMaximoAtraso} dias
                    </p>
                  </div>
                </div>

                <div>
                  <h4 className="font-semibold mb-3">Documentos Vencidos</h4>
                  <div className="space-y-2">
                    {selectedDebt.debitos.map((documento, idx) => (
                      <div key={idx} className="border rounded p-3 bg-gray-50">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="font-medium">Doc: {documento.numero_documento}</p>
                            <p className="text-sm text-gray-600">
                              Vencimento: {formatDate(documento.data_vencimento)}
                            </p>
                            <p className="text-sm text-gray-600">
                              {documento.dias_atraso} dias em atraso
                            </p>
                            {documento.observacao && (
                              <p className="text-sm text-gray-500 mt-1">
                                {documento.observacao}
                              </p>
                            )}
                          </div>
                          <p className="font-bold text-red-600">
                            {formatCurrency(documento.valor)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Modal de comparação removido conforme solicitado */}
    </div>
  );
}