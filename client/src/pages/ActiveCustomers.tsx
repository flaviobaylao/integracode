import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { 
  Upload, 
  FileSpreadsheet, 
  Users, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Search,
  Download,
  Trash2,
  RefreshCcw,
  Home,
  ArrowLeft
} from "lucide-react";
import { Link } from "wouter";

interface ActiveCustomer {
  id: string;
  cpfCnpj: string;
  fantasyName: string;
  customerId: string | null;
  customerFound: boolean;
  importedAt: string;
  createdAt: string;
  customer?: {
    id: string;
    fantasyName: string;
    phone: string;
    sellerId: string;
    weekdays: string;
    isActive: boolean;
  };
}

interface ImportResult {
  success: boolean;
  message: string;
  stats: {
    total: number;
    added: number;
    updated: number;
    removed: number;
    matched: number;
    notFound: number;
  };
}

export default function ActiveCustomers() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const { data: activeCustomers = [], isLoading, refetch } = useQuery<ActiveCustomer[]>({
    queryKey: ["/api/active-customers"],
  });

  const { data: stats } = useQuery<{
    total: number;
    matched: number;
    notFound: number;
  }>({
    queryKey: ["/api/active-customers/stats"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      
      const response = await fetch("/api/active-customers/import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Erro ao importar arquivo");
      }
      
      return response.json();
    },
    onSuccess: (result: ImportResult) => {
      setImportResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers/stats"] });
      toast({
        title: "Importação concluída",
        description: result.message,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro na importação",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("/api/active-customers", {
        method: "DELETE",
      });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers/stats"] });
      setShowConfirmClear(false);
      toast({
        title: "Lista limpa",
        description: "Todos os clientes ativos foram removidos da lista.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro ao limpar lista",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const validTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];

    if (!validTypes.includes(file.type) && !file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      toast({
        title: "Tipo de arquivo inválido",
        description: "Por favor, envie um arquivo Excel (.xlsx, .xls) ou CSV.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    setUploadProgress(30);
    
    try {
      await uploadMutation.mutateAsync(file);
      setUploadProgress(100);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      event.target.value = "";
    }
  }, [uploadMutation, toast]);

  const handleExportTemplate = useCallback(() => {
    const csvContent = "CPF_CNPJ,NOME_FANTASIA\n12345678901,Exemplo Cliente 1\n12345678000102,Exemplo Cliente 2";
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "modelo_clientes_ativos.csv";
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const filteredCustomers = activeCustomers.filter((c) =>
    c.fantasyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.cpfCnpj.includes(searchTerm)
  );

  const formatCpfCnpj = (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 11) {
      return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    } else if (digits.length === 14) {
      return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    }
    return value;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/">
                <Button variant="ghost" size="sm" data-testid="button-home">
                  <Home className="h-4 w-4 mr-2" />
                  Início
                </Button>
              </Link>
              <Separator orientation="vertical" className="h-6" />
              <div className="flex items-center gap-3">
                <Users className="h-6 w-6 text-green-600" />
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Clientes Ativos</h1>
                  <p className="text-sm text-gray-500">Gerenciar lista de clientes para rotas</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportTemplate}
                data-testid="button-export-template"
              >
                <Download className="h-4 w-4 mr-2" />
                Baixar Modelo
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowConfirmClear(true)}
                disabled={activeCustomers.length === 0}
                data-testid="button-clear-all"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Limpar Lista
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-100 rounded-full">
                  <Users className="h-6 w-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total na Lista</p>
                  <p className="text-2xl font-bold" data-testid="text-total-count">
                    {stats?.total || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-green-100 rounded-full">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Encontrados</p>
                  <p className="text-2xl font-bold text-green-600" data-testid="text-matched-count">
                    {stats?.matched || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-yellow-100 rounded-full">
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Não Encontrados</p>
                  <p className="text-2xl font-bold text-yellow-600" data-testid="text-not-found-count">
                    {stats?.notFound || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-purple-100 rounded-full">
                  <FileSpreadsheet className="h-6 w-6 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Taxa de Match</p>
                  <p className="text-2xl font-bold text-purple-600" data-testid="text-match-rate">
                    {stats?.total ? Math.round((stats.matched / stats.total) * 100) : 0}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Importar Planilha
            </CardTitle>
            <CardDescription>
              Envie um arquivo Excel ou CSV com as colunas: CPF_CNPJ e NOME_FANTASIA.
              A lista será sincronizada: novos clientes serão adicionados e clientes que não estão na planilha serão removidos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg p-8 hover:border-green-500 transition-colors">
              {isUploading ? (
                <div className="w-full max-w-md space-y-4">
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-center text-gray-600">Processando arquivo...</p>
                </div>
              ) : (
                <>
                  <FileSpreadsheet className="h-12 w-12 text-gray-400 mb-4" />
                  <p className="text-gray-600 mb-4">Arraste o arquivo aqui ou clique para selecionar</p>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileUpload}
                    className="hidden"
                    id="file-upload"
                    data-testid="input-file-upload"
                  />
                  <label htmlFor="file-upload">
                    <Button asChild data-testid="button-select-file">
                      <span>
                        <Upload className="h-4 w-4 mr-2" />
                        Selecionar Arquivo
                      </span>
                    </Button>
                  </label>
                </>
              )}
            </div>

            {importResult && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <h4 className="font-semibold mb-2">Resultado da Importação</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div>
                    <span className="text-gray-500">Total processado:</span>
                    <span className="ml-2 font-medium">{importResult.stats.total}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Adicionados:</span>
                    <span className="ml-2 font-medium text-green-600">+{importResult.stats.added}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Atualizados:</span>
                    <span className="ml-2 font-medium text-blue-600">{importResult.stats.updated}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Removidos:</span>
                    <span className="ml-2 font-medium text-red-600">-{importResult.stats.removed}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Encontrados:</span>
                    <span className="ml-2 font-medium text-green-600">{importResult.stats.matched}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Não encontrados:</span>
                    <span className="ml-2 font-medium text-yellow-600">{importResult.stats.notFound}</span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Lista de Clientes Ativos</CardTitle>
              <div className="flex items-center gap-4">
                <div className="relative w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Buscar por nome ou CPF/CNPJ..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9"
                    data-testid="input-search"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  data-testid="button-refresh"
                >
                  <RefreshCcw className="h-4 w-4 mr-2" />
                  Atualizar
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
              </div>
            ) : filteredCustomers.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                {searchTerm ? (
                  <p>Nenhum cliente encontrado para "{searchTerm}"</p>
                ) : (
                  <div>
                    <FileSpreadsheet className="h-12 w-12 mx-auto mb-4 text-gray-300" />
                    <p>Nenhum cliente ativo cadastrado</p>
                    <p className="text-sm mt-2">Importe uma planilha para começar</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>CPF/CNPJ</TableHead>
                      <TableHead>Nome Fantasia (Planilha)</TableHead>
                      <TableHead>Nome Fantasia (Cadastro)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Vendedor</TableHead>
                      <TableHead>Dias de Visita</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCustomers.map((customer) => (
                      <TableRow key={customer.id} data-testid={`row-customer-${customer.id}`}>
                        <TableCell className="font-mono text-sm">
                          {formatCpfCnpj(customer.cpfCnpj)}
                        </TableCell>
                        <TableCell>{customer.fantasyName}</TableCell>
                        <TableCell>
                          {customer.customer?.fantasyName || (
                            <span className="text-gray-400 italic">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {customer.customerFound ? (
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                              <CheckCircle className="h-3 w-3 mr-1" />
                              Encontrado
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              Não encontrado
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {customer.customer?.sellerId || (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {customer.customer?.weekdays ? (
                            <span className="text-sm">
                              {(() => {
                                try {
                                  const days = JSON.parse(customer.customer.weekdays);
                                  return Array.isArray(days) ? days.join(", ") : customer.customer.weekdays;
                                } catch {
                                  return customer.customer.weekdays;
                                }
                              })()}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog open={showConfirmClear} onOpenChange={setShowConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Limpar Lista de Clientes Ativos</DialogTitle>
            <DialogDescription>
              Tem certeza que deseja remover todos os clientes ativos da lista? 
              Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfirmClear(false)}
              data-testid="button-cancel-clear"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
              data-testid="button-confirm-clear"
            >
              {clearAllMutation.isPending ? "Removendo..." : "Limpar Lista"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
