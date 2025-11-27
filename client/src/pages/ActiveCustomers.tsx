import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { 
  Upload, 
  Download, 
  Search, 
  Users, 
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  History,
  Calendar,
  ArrowLeft,
  Filter,
  X
} from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ActiveCustomerWithVisits {
  id: string;
  document: string;
  documentType: string;
  fantasyNameImported: string | null;
  customerId: string | null;
  uploadId: string;
  matchStatus: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  customer?: {
    id: string;
    name: string;
    fantasyName: string | null;
    phone: string;
    address: string;
    city: string | null;
    neighborhood: string | null;
    sellerId: string;
    sellerName?: string;
    virtualService: boolean;
  };
  lastTwoVisits: Array<{ date: string; status: string }>;
  nextThreeVisits: Array<{ date: string; status: string }>;
}

interface UploadRecord {
  id: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
  totalRecords: number;
  matchedRecords: number;
  unmatchedRecords: number;
  addedCustomers: number;
  removedCustomers: number;
  keptCustomers: number;
  processingStatus: string;
  errorMessage: string | null;
}

export default function ActiveCustomers() {
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("list");
  const [selectedSeller, setSelectedSeller] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: activeCustomers = [], isLoading: isLoadingCustomers } = useQuery<ActiveCustomerWithVisits[]>({
    queryKey: ["/api/active-customers"],
  });

  const { data: uploads = [], isLoading: isLoadingUploads } = useQuery<UploadRecord[]>({
    queryKey: ["/api/active-customers/uploads"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/active-customers/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Erro no upload");
      }
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Upload concluído",
        description: `${data.totalRecords} registros processados. ${data.matchedRecords} encontrados, ${data.addedCustomers} adicionados, ${data.removedCustomers} removidos.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers/uploads"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Erro no upload",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
        toast({
          title: "Formato inválido",
          description: "Por favor, envie um arquivo Excel (.xlsx ou .xls)",
          variant: "destructive",
        });
        return;
      }
      uploadMutation.mutate(file);
    }
  };

  const handleDownloadTemplate = () => {
    window.location.href = "/api/active-customers/template";
  };

  // Obter lista única de vendedores
  const sellers = Array.from(
    new Map(
      activeCustomers
        .filter(ac => ac.customer?.sellerId)
        .map(ac => [
          ac.customer?.sellerId,
          { id: ac.customer?.sellerId, name: ac.customer?.sellerName || `Vendedor ${ac.customer?.sellerId?.slice(0, 4)}` }
        ])
    ).values()
  ).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const filteredCustomers = activeCustomers.filter((ac) => {
    const searchLower = searchTerm.toLowerCase();
    const name = ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || "";
    const doc = ac.document || "";
    
    // Filtro de busca
    const matchesSearch = name.toLowerCase().includes(searchLower) || doc.includes(searchTerm);
    
    // Filtro de vendedor
    const matchesSeller = !selectedSeller || ac.customer?.sellerId === selectedSeller;
    
    return matchesSearch && matchesSeller;
  });

  const formatDocument = (doc: string, type: string) => {
    if (type === "cpf" && doc.length === 11) {
      return `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`;
    }
    if (type === "cnpj" && doc.length === 14) {
      return `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12)}`;
    }
    return doc;
  };

  const getVisitStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge variant="default" className="bg-green-500">Realizada</Badge>;
      case "missed":
        return <Badge variant="destructive">Perdida</Badge>;
      case "scheduled":
        return <Badge variant="secondary">Agendada</Badge>;
      case "cancelled":
        return <Badge variant="outline">Cancelada</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const stats = {
    total: activeCustomers.length,
    matched: activeCustomers.filter(ac => ac.matchStatus === "matched").length,
    unmatched: activeCustomers.filter(ac => ac.matchStatus === "unmatched").length,
    virtual: activeCustomers.filter(ac => ac.customer?.virtualService).length,
  };

  return (
    <div className="container mx-auto p-4 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="hover:bg-gray-100"
              data-testid="button-back-dashboard"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Dashboard
            </Button>
          </div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="page-title">
            <Users className="h-6 w-6" />
            Clientes Ativos
          </h1>
          <p className="text-muted-foreground">
            Gerencie a lista de clientes ativos para rotas e visitas
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={handleDownloadTemplate}
            data-testid="button-download-template"
          >
            <Download className="h-4 w-4 mr-2" />
            Template
          </Button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".xlsx,.xls"
            className="hidden"
            data-testid="input-file-upload"
          />
          <Button 
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            data-testid="button-upload-file"
          >
            <Upload className="h-4 w-4 mr-2" />
            {uploadMutation.isPending ? "Enviando..." : "Enviar Planilha"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="card-stat-total">
          <CardHeader className="pb-2">
            <CardDescription>Total na Lista</CardDescription>
            <CardTitle className="text-2xl">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card data-testid="card-stat-matched">
          <CardHeader className="pb-2">
            <CardDescription>Encontrados no Sistema</CardDescription>
            <CardTitle className="text-2xl text-green-600">{stats.matched}</CardTitle>
          </CardHeader>
        </Card>
        <Card data-testid="card-stat-unmatched">
          <CardHeader className="pb-2">
            <CardDescription>Não Encontrados</CardDescription>
            <CardTitle className="text-2xl text-orange-600">{stats.unmatched}</CardTitle>
          </CardHeader>
        </Card>
        <Card data-testid="card-stat-virtual">
          <CardHeader className="pb-2">
            <CardDescription>Virtuais</CardDescription>
            <CardTitle className="text-2xl text-blue-600">{stats.virtual}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="list" data-testid="tab-list">
            <Users className="h-4 w-4 mr-2" />
            Lista de Clientes
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            <History className="h-4 w-4 mr-2" />
            Histórico de Uploads
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou CPF/CNPJ..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                data-testid="input-search"
              />
            </div>
            
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                <SelectTrigger className="w-full md:w-[250px]" data-testid="select-seller-filter">
                  <SelectValue placeholder="Filtrar por vendedor..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Todos os vendedores</SelectItem>
                  {sellers.map((seller) => (
                    <SelectItem key={seller.id} value={seller.id || ""}>
                      {seller.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSeller && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedSeller("")}
                  className="px-2"
                  data-testid="button-clear-seller-filter"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {isLoadingCustomers ? (
                <div className="p-4 space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>CPF/CNPJ</TableHead>
                        <TableHead>Nome</TableHead>
                        <TableHead>Vendedor</TableHead>
                        <TableHead>Cidade</TableHead>
                        <TableHead>Virtual</TableHead>
                        <TableHead>Últimas 2 Visitas</TableHead>
                        <TableHead>Próximas 3 Visitas</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCustomers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                            {searchTerm || selectedSeller ? "Nenhum cliente encontrado com os filtros aplicados" : "Nenhum cliente ativo na lista. Faça upload de uma planilha."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredCustomers.map((ac) => (
                          <TableRow key={ac.id} data-testid={`row-customer-${ac.id}`}>
                            <TableCell>
                              {ac.matchStatus === "matched" ? (
                                <span title="Encontrado no sistema">
                                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                                </span>
                              ) : (
                                <span title="Não encontrado no sistema">
                                  <AlertCircle className="h-5 w-5 text-orange-500" />
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {formatDocument(ac.document, ac.documentType)}
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">
                                {ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || "-"}
                              </div>
                              {ac.customer?.address && (
                                <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                  {ac.customer.neighborhood}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {ac.customer?.sellerName || `Vendedor ${ac.customer?.sellerId?.slice(0, 4)}` || "-"}
                              </div>
                            </TableCell>
                            <TableCell>{ac.customer?.city || "-"}</TableCell>
                            <TableCell>
                              {ac.customer?.virtualService ? (
                                <Badge variant="secondary">Sim</Badge>
                              ) : (
                                <span className="text-muted-foreground">Não</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                {ac.lastTwoVisits.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">Sem histórico</span>
                                ) : (
                                  ac.lastTwoVisits.map((v, i) => (
                                    <div key={i} className="flex items-center gap-1 text-xs">
                                      <span>{format(new Date(v.date), "dd/MM", { locale: ptBR })}</span>
                                      {getVisitStatusBadge(v.status)}
                                    </div>
                                  ))
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                {ac.nextThreeVisits.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">Sem agendamento</span>
                                ) : (
                                  ac.nextThreeVisits.map((v, i) => (
                                    <div key={i} className="flex items-center gap-1 text-xs">
                                      <Calendar className="h-3 w-3 text-muted-foreground" />
                                      <span>{format(new Date(v.date), "dd/MM", { locale: ptBR })}</span>
                                    </div>
                                  ))
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" />
                Histórico de Uploads
              </CardTitle>
              <CardDescription>
                Visualize todos os uploads de planilhas realizados
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingUploads ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : uploads.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Nenhum upload realizado ainda
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Arquivo</TableHead>
                        <TableHead>Data</TableHead>
                        <TableHead>Registros</TableHead>
                        <TableHead>Encontrados</TableHead>
                        <TableHead>Adicionados</TableHead>
                        <TableHead>Removidos</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {uploads.map((upload) => (
                        <TableRow key={upload.id} data-testid={`row-upload-${upload.id}`}>
                          <TableCell>
                            {upload.processingStatus === "completed" ? (
                              <CheckCircle2 className="h-5 w-5 text-green-500" />
                            ) : upload.processingStatus === "error" ? (
                              <XCircle className="h-5 w-5 text-red-500" />
                            ) : (
                              <Clock className="h-5 w-5 text-yellow-500" />
                            )}
                          </TableCell>
                          <TableCell className="font-medium">{upload.fileName}</TableCell>
                          <TableCell>
                            {format(new Date(upload.uploadedAt), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                          </TableCell>
                          <TableCell>{upload.totalRecords}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="bg-green-50 text-green-700">
                              {upload.matchedRecords}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="bg-blue-50 text-blue-700">
                              +{upload.addedCustomers}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="bg-red-50 text-red-700">
                              -{upload.removedCustomers}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
