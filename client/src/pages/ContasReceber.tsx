import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Search, Download } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import * as XLSX from 'xlsx';

interface ContaReceber {
  codigo_lancamento_omie?: number;
  numero_documento?: string;
  tipo_documento?: string;
  codigo_cliente?: number;
  razao_social?: string;
  cnpj_cpf?: string;
  valor_documento?: number;
  valor_a_receber?: number;
  data_vencimento?: string;
  data_previsao?: string;
  status_titulo?: string;
  observacao?: string;
}

interface ContasReceberData {
  titulos: ContaReceber[];
  totalTitulos: number;
  totalPages: number;
}

export default function ContasReceber() {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const { toast } = useToast();

  // Query para buscar todas as contas a receber
  const { data: contasData, isLoading, refetch, isFetching } = useQuery<ContasReceberData>({
    queryKey: ['/api/omie/contas-receber'],
    enabled: false, // Não carregar automaticamente
  });

  // Calcular estatísticas no frontend
  const stats = contasData?.titulos.reduce((acc, titulo) => {
    const dataPrevisao = titulo.data_previsao ? new Date(titulo.data_previsao.split('/').reverse().join('-')) : null;
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
    const valorReceber = titulo.valor_a_receber || 0;
    const isVencido = dataPrevisao && dataPrevisao < hoje && valorReceber > 0;
    
    if (isVencido) {
      acc.vencidos++;
      acc.totalVencido += valorReceber;
    }
    
    acc.totalGeral += valorReceber;
    
    return acc;
  }, { vencidos: 0, totalVencido: 0, totalGeral: 0 }) || { vencidos: 0, totalVencido: 0, totalGeral: 0 };

  // Filtrar títulos no frontend
  const filteredTitulos = contasData?.titulos.filter(titulo => {
    const searchLower = searchTerm.toLowerCase();
    const matchesSearch = 
      titulo.razao_social?.toLowerCase().includes(searchLower) ||
      titulo.cnpj_cpf?.includes(searchTerm) ||
      titulo.numero_documento?.includes(searchTerm);
    
    if (!matchesSearch) return false;
    
    // Filtro de status
    if (filterStatus === "all") return true;
    
    const dataPrevisao = titulo.data_previsao ? new Date(titulo.data_previsao.split('/').reverse().join('-')) : null;
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
    const valorReceber = titulo.valor_a_receber || 0;
    const isVencido = dataPrevisao && dataPrevisao < hoje && valorReceber > 0;
    
    if (filterStatus === "vencido") return isVencido;
    if (filterStatus === "a_vencer") return !isVencido;
    
    return true;
  }) || [];

  // Função para buscar dados
  const handleFetch = async () => {
    try {
      await refetch();
      toast({
        title: "Dados carregados",
        description: `${contasData?.totalTitulos || 0} títulos encontrados.`,
      });
    } catch (error) {
      toast({
        title: "Erro ao carregar dados",
        description: error instanceof Error ? error.message : "Erro desconhecido",
        variant: "destructive",
      });
    }
  };

  // Função para exportar para Excel
  const handleExport = () => {
    if (!filteredTitulos.length) {
      toast({
        title: "Nenhum dado para exportar",
        variant: "destructive",
      });
      return;
    }

    const exportData = filteredTitulos.map(titulo => ({
      'Número Documento': titulo.numero_documento || '',
      'Cliente': titulo.razao_social || '',
      'CPF/CNPJ': titulo.cnpj_cpf || '',
      'Valor Documento': titulo.valor_documento || 0,
      'Valor a Receber': titulo.valor_a_receber || 0,
      'Data Vencimento': titulo.data_vencimento || '',
      'Data Previsão': titulo.data_previsao || '',
      'Status': titulo.status_titulo || '',
      'Observação': titulo.observacao || '',
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Contas a Receber");
    XLSX.writeFile(wb, `contas_receber_${new Date().toISOString().split('T')[0]}.xlsx`);

    toast({
      title: "Exportação concluída",
      description: `${filteredTitulos.length} títulos exportados para Excel.`,
    });
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return dateStr;
  };

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="contas-receber-page">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold" data-testid="page-title">Contas a Receber</h1>
        <div className="flex gap-2">
          <Button 
            onClick={handleExport} 
            variant="outline"
            disabled={!contasData || filteredTitulos.length === 0}
            data-testid="button-export"
          >
            <Download className="h-4 w-4 mr-2" />
            Exportar Excel
          </Button>
          <Button 
            onClick={handleFetch} 
            disabled={isFetching}
            data-testid="button-load"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Carregar Dados
          </Button>
        </div>
      </div>

      {/* Cards de estatísticas */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="card-total-titulos">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total de Títulos
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || isFetching ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-total-titulos">
                {contasData?.totalTitulos || 0}
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-vencidos">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Títulos Vencidos
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || isFetching ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="space-y-1">
                <div className="text-2xl font-bold text-red-600" data-testid="text-vencidos-count">
                  {stats.vencidos}
                </div>
                <div className="text-sm text-red-600" data-testid="text-vencidos-total">
                  {formatCurrency(stats.totalVencido)}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-total-geral">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Valor Total Geral
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading || isFetching ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-total-geral">
                {formatCurrency(stats.totalGeral)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filtros */}
      <Card data-testid="card-filters">
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por cliente, CPF/CNPJ ou documento..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                  data-testid="input-search"
                />
              </div>
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-[200px]" data-testid="select-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="vencido">Vencidos</SelectItem>
                <SelectItem value="a_vencer">A Vencer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Tabela de títulos */}
      <Card data-testid="card-table">
        <CardHeader>
          <CardTitle>
            Títulos ({filteredTitulos.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || isFetching ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : filteredTitulos.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-data">
              {contasData ? "Nenhum título encontrado com os filtros aplicados" : "Clique em 'Carregar Dados' para buscar os títulos"}
            </div>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Documento</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>CPF/CNPJ</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead className="text-right">A Receber</TableHead>
                    <TableHead>Vencimento</TableHead>
                    <TableHead>Previsão</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTitulos.map((titulo, index) => {
                    const dataPrevisao = titulo.data_previsao ? new Date(titulo.data_previsao.split('/').reverse().join('-')) : null;
                    const hoje = new Date();
                    hoje.setHours(0, 0, 0, 0);
                    const isVencido = dataPrevisao && dataPrevisao < hoje && (titulo.valor_a_receber || 0) > 0;
                    
                    return (
                      <TableRow key={index} data-testid={`row-titulo-${index}`}>
                        <TableCell className="font-medium" data-testid={`cell-documento-${index}`}>
                          {titulo.numero_documento || '-'}
                        </TableCell>
                        <TableCell data-testid={`cell-cliente-${index}`}>
                          {titulo.razao_social || '-'}
                        </TableCell>
                        <TableCell data-testid={`cell-cnpj-${index}`}>
                          {titulo.cnpj_cpf || '-'}
                        </TableCell>
                        <TableCell className="text-right" data-testid={`cell-valor-${index}`}>
                          {formatCurrency(titulo.valor_documento || 0)}
                        </TableCell>
                        <TableCell className="text-right" data-testid={`cell-receber-${index}`}>
                          {formatCurrency(titulo.valor_a_receber || 0)}
                        </TableCell>
                        <TableCell data-testid={`cell-vencimento-${index}`}>
                          {formatDate(titulo.data_vencimento || '')}
                        </TableCell>
                        <TableCell data-testid={`cell-previsao-${index}`}>
                          {formatDate(titulo.data_previsao || '')}
                        </TableCell>
                        <TableCell data-testid={`cell-status-${index}`}>
                          {isVencido ? (
                            <Badge variant="destructive" data-testid={`badge-vencido-${index}`}>Vencido</Badge>
                          ) : (
                            <Badge variant="secondary" data-testid={`badge-a-vencer-${index}`}>A Vencer</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
