import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { safeParseWeekdays, formatWeekdays } from "@/lib/weekdayParser";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import CustomerEditModal from "@/components/CustomerEditModal";
import type { SalesCardWithRelations, Customer } from "@shared/schema";
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
  X,
  Zap,
  Pencil,
  Plus
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
    weekdays?: string;
    visitPeriodicity?: string;
    isPositivatedThisMonth?: boolean;
    lastActivityDate?: string | null;
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

// Função ROBUSTA para parsear weekdays - NUNCA quebra
// Suporta: arrays, PostgreSQL {}, JSON [], strings separadas por vírgula/semicolon/slash
function parseWeekdaysArray(input: any): string[] {
  const VALID_WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
  
  if (!input) return [];
  
  let values: string[] = [];
  
  // Se é array, converte todos elementos para string
  if (Array.isArray(input)) {
    values = input.map(v => String(v || '').trim()).filter(v => v);
  }
  // Se é string
  else {
    const str = String(input || '').trim();
    if (!str) return [];
    
    // Se é PostgreSQL array: {Seg,Ter} ou {"Seg","Ter"}
    if (str.startsWith('{') && str.endsWith('}')) {
      const inner = str.slice(1, -1);
      values = inner.split(',').map(v => v.trim().replace(/^"|"$/g, '')).filter(v => v);
    }
    // Se é JSON array: ["Seg","Ter"] - SÓ tenta parse se for válido
    else if (str.startsWith('[') && str.endsWith(']') && str.includes('"')) {
      try {
        const parsed = JSON.parse(str);
        values = (Array.isArray(parsed) ? parsed : []).map(v => String(v || '').trim()).filter(v => v);
      } catch {
        // Falha silenciosa - não fazer nada
        values = [];
      }
    }
    // Se tem separadores: vírgula, semicolon, slash, ou " e "
    else if (str.includes(',') || str.includes(';') || str.includes('/') || str.includes(' e ')) {
      values = str.split(/[,;/]|\s+e\s+/).map(v => v.trim()).filter(v => v);
    }
    // Caso contrário: valor único
    else {
      values = [str];
    }
  }
  
  // Retorna APENAS valores válidos (Seg, Ter, Qua, etc)
  return values.filter(v => VALID_WEEKDAYS.includes(v));
}

export default function ActiveCustomers() {
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("list");
  const [selectedSeller, setSelectedSeller] = useState<string>("");
  const [selectedDayOfRoute, setSelectedDayOfRoute] = useState<string>("");
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedVirtualType, setSelectedVirtualType] = useState<string>("");
  const [selectedPositivation, setSelectedPositivation] = useState<string>("");
  const [showCardModal, setShowCardModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showNoSaleModal, setShowNoSaleModal] = useState(false);
  const [showCustomerEditModal, setShowCustomerEditModal] = useState(false);
  const [isLeadMode, setIsLeadMode] = useState(false);
  const [selectedCard, setSelectedCard] = useState<SalesCardWithRelations | null>(null);
  const [selectedCustomerForEdit, setSelectedCustomerForEdit] = useState<Customer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleRowClick = async (customerId: string) => {
    try {
      const dateToUse = new Date().toISOString().split('T')[0];
      console.log('🔍 Abrindo card para customer:', customerId, 'data:', dateToUse);
      
      const response = await fetch(`/api/customers/${customerId}/sales-card/${dateToUse}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Erro na resposta:', response.status, errorText);
        throw new Error(`Falha ao buscar card de vendas: ${response.status}`);
      }
      
      const card = await response.json();
      console.log('✅ Card carregado:', card);
      setSelectedCard(card);
      setShowCardModal(true);
    } catch (error) {
      console.error('❌ Erro ao abrir card de vendas:', error);
      toast({
        variant: "destructive",
        title: "Erro ao abrir card",
        description: error instanceof Error ? error.message : "Não foi possível carregar o card de vendas do cliente."
      });
    }
  };

  const handleEditSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setShowEditModal(true);
  };

  const handleNoSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setShowCardModal(false);
    setShowNoSaleModal(true);
  };

  const closeModals = () => {
    setShowCardModal(false);
    setShowEditModal(false);
    setShowNoSaleModal(false);
    setShowCustomerEditModal(false);
    setSelectedCard(null);
    setSelectedCustomerForEdit(null);
  };

  const handleEditCustomer = async (e: React.MouseEvent, customerId: string) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/customers/${customerId}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Falha ao carregar cliente');
      const customer = await response.json();
      setSelectedCustomerForEdit(customer);
      setShowCustomerEditModal(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Erro ao carregar cliente",
        description: "Não foi possível carregar os dados do cliente."
      });
    }
  };

  const handleCustomerEditClose = () => {
    setShowCustomerEditModal(false);
    setSelectedCustomerForEdit(null);
    setIsLeadMode(false);
    queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
  };

  const handleNewLead = () => {
    setSelectedCustomerForEdit(null);
    setIsLeadMode(true);
    setShowCustomerEditModal(true);
  };


  const { 
    data: activeCustomers = [], 
    isLoading: isLoadingCustomers,
    isError: isErrorCustomers,
    error: customerError
  } = useQuery<ActiveCustomerWithVisits[]>({
    queryKey: ["/api/active-customers"],
    retry: 2,
    refetchInterval: 30000, // Atualizar a cada 30s para garantir sincronização
    staleTime: 0, // Dados sempre considerados antigos
  });

  const { 
    data: uploads = [], 
    isLoading: isLoadingUploads,
    isError: isErrorUploads,
    error: uploadError
  } = useQuery<UploadRecord[]>({
    queryKey: ["/api/active-customers/uploads"],
    retry: 2,
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
      
      const contentType = response.headers.get("content-type");
      const text = await response.text();
      
      console.log("Upload response:", {
        ok: response.ok,
        status: response.status,
        contentType,
        textLength: text.length,
        firstChars: text.substring(0, 100)
      });
      
      if (!response.ok) {
        try {
          const error = JSON.parse(text);
          throw new Error(error.message || `Erro: ${response.status}`);
        } catch (e) {
          throw new Error(`Erro no upload (${response.status}): ${text.substring(0, 200)}`);
        }
      }
      
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Resposta inválida do servidor: ${text.substring(0, 200)}`);
      }
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
      console.error("Upload error:", error);
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

  const generateVisitsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/recalculate-delivery-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ dryRun: false })
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || "Erro ao gerar agendamentos");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      console.log('✅ Sucesso ao regenerar agendamentos:', data);
      toast({ 
        title: "✅ Agendamentos regenerados!", 
        description: "Próximas 3 visitas foram recalculadas para todos os clientes!"
      });
      queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] });
    },
    onError: (error: any) => {
      console.error('❌ Erro ao regenerar agendamentos:', error);
      const message = error.message || "Erro ao gerar agendamentos";
      toast({ title: "❌ Erro", description: message, variant: "destructive" });
    }
  });

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

  // Obter lista única de dias de rota
  const daysOfRoute = Array.from(
    new Set(
      activeCustomers
        .filter(ac => ac.customer?.weekdays)
        .flatMap(ac => parseWeekdaysArray(ac.customer?.weekdays))
    )
  ).sort();

  // Obter lista única de periodicidades
  const periodicities = Array.from(
    new Set(
      activeCustomers
        .filter(ac => ac.customer?.visitPeriodicity)
        .map(ac => ac.customer?.visitPeriodicity)
        .filter(Boolean) as string[]
    )
  ).sort();

  const filteredCustomers = activeCustomers.filter((ac) => {
    const searchLower = searchTerm.toLowerCase();
    const name = ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || "";
    const doc = ac.document || "";
    
    // Filtro de busca
    const matchesSearch = name.toLowerCase().includes(searchLower) || doc.includes(searchTerm);
    
    // Filtro de vendedor
    const matchesSeller = !selectedSeller || ac.customer?.sellerId === selectedSeller;
    
    // Filtro de dia de rota
    const matchesDayOfRoute = !selectedDayOfRoute || (ac.customer?.weekdays ? parseWeekdaysArray(ac.customer.weekdays).includes(selectedDayOfRoute) : false);
    
    // Filtro de periodicidade
    const matchesPeriodicity = !selectedPeriodicity || ac.customer?.visitPeriodicity === selectedPeriodicity;
    
    // Filtro de tipo (virtual/presencial)
    const matchesVirtualType = !selectedVirtualType || 
      (selectedVirtualType === "virtual" ? ac.customer?.virtualService === true : ac.customer?.virtualService === false);
    
    // Filtro de data - verificar se cliente tem visita agendada para aquele dia
    const matchesDate = !selectedDate || ac.nextThreeVisits.some(v => v.date === selectedDate);
    
    // Filtro de positivação
    const matchesPositivation = !selectedPositivation || 
      (selectedPositivation === "sim" ? ac.customer?.isPositivatedThisMonth === true : ac.customer?.isPositivatedThisMonth === false);
    
    return matchesSearch && matchesSeller && matchesDayOfRoute && matchesPeriodicity && matchesVirtualType && matchesDate && matchesPositivation;
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

  // Mostrar erro se houver
  if (isErrorCustomers) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-6 flex items-center justify-center">
        <div className="max-w-md bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Erro ao carregar clientes</h2>
          <p className="text-gray-600 mb-6">{customerError?.message || "Não foi possível carregar a lista de clientes ativos"}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            data-testid="button-reload"
          >
            Recarregar Página
          </button>
        </div>
      </div>
    );
  }

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
            className="border-purple-600 text-purple-600 hover:bg-purple-50"
            onClick={handleNewLead}
            data-testid="button-new-lead"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Lead
          </Button>
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
          <Button 
            onClick={() => generateVisitsMutation.mutate()}
            disabled={generateVisitsMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-generate-visits"
          >
            <Zap className="h-4 w-4 mr-2" />
            {generateVisitsMutation.isPending ? "Gerando..." : "Gerar Agendamentos"}
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
          <div className="flex flex-col gap-3">
            <div className="flex flex-row items-center gap-1 flex-wrap">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar..."
                  value={searchTerm}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                  className="pl-10 h-9"
                  data-testid="input-search"
                />
              </div>
              
              <Filter className="h-4 w-4 text-muted-foreground" />
              
              <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                <SelectTrigger className="w-[120px] h-9" data-testid="select-seller-filter">
                  <SelectValue placeholder="Vendedor" />
                </SelectTrigger>
                <SelectContent>
                  {sellers.map((seller) => (
                    <SelectItem key={seller.id} value={seller.id || ""}>
                      {seller.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={selectedDayOfRoute} onValueChange={setSelectedDayOfRoute}>
                <SelectTrigger className="w-[100px] h-9" data-testid="select-day-filter">
                  <SelectValue placeholder="Dia" />
                </SelectTrigger>
                <SelectContent>
                  {daysOfRoute.map((day) => (
                    <SelectItem key={day} value={day}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={selectedVirtualType} onValueChange={setSelectedVirtualType}>
                <SelectTrigger className="w-[100px] h-9" data-testid="select-virtual-filter">
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="presencial">Presencial</SelectItem>
                  <SelectItem value="virtual">Virtual</SelectItem>
                </SelectContent>
              </Select>
              
              <Select value={selectedPeriodicity} onValueChange={setSelectedPeriodicity}>
                <SelectTrigger className="w-[110px] h-9" data-testid="select-periodicity-filter">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent>
                  {periodicities.map((period) => (
                    <SelectItem key={period} value={period}>
                      {period === 'semanal' ? 'Semanal' : period === 'quinzenal' ? 'Quinzenal' : period === 'mensal' ? 'Mensal' : period}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={selectedPositivation} onValueChange={setSelectedPositivation}>
                <SelectTrigger className="w-[120px] h-9" data-testid="select-positivation-filter">
                  <SelectValue placeholder="Positivação" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sim">Positivado</SelectItem>
                  <SelectItem value="nao">Não Positivado</SelectItem>
                </SelectContent>
              </Select>

              <Input
                type="date"
                value={selectedDate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSelectedDate(e.target.value)}
                className="w-[130px] h-9"
                data-testid="input-date-filter"
              />
              
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchTerm("");
                  setSelectedSeller("");
                  setSelectedDayOfRoute("");
                  setSelectedVirtualType("");
                  setSelectedPeriodicity("");
                  setSelectedDate("");
                  setSelectedPositivation("");
                }}
                className="h-9"
                data-testid="button-clear-all-filters"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-base px-3 py-1" data-testid="badge-customer-count">
                📊 {filteredCustomers.length} cliente{filteredCustomers.length !== 1 ? 's' : ''}
              </Badge>
              {(searchTerm || selectedSeller || selectedDayOfRoute || selectedPeriodicity || selectedVirtualType || selectedPositivation) && (
                <span className="text-xs text-muted-foreground">
                  {activeCustomers.length} total
                </span>
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
                        <TableHead>Telefone</TableHead>
                        <TableHead>Vendedor</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Dia da Rota</TableHead>
                        <TableHead>Periodicidade</TableHead>
                        <TableHead>Positivado</TableHead>
                        <TableHead>Última Atividade</TableHead>
                        <TableHead>Próximas 3 Visitas</TableHead>
                        <TableHead>Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCustomers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={12} className="text-center py-8 text-muted-foreground">
                            {searchTerm || selectedSeller ? "Nenhum cliente encontrado com os filtros aplicados" : "Nenhum cliente ativo na lista. Faça upload de uma planilha."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredCustomers.map((ac) => (
                          <TableRow 
                            key={ac.id} 
                            data-testid={`row-customer-${ac.id}`}
                            onClick={() => {
                              if (ac.customer?.id) {
                                handleRowClick(ac.customer.id);
                              }
                            }}
                            className="cursor-pointer hover:bg-muted/50 transition-colors"
                          >
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
                            <TableCell className="font-mono text-sm">
                              {ac.customer?.phone || "-"}
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {ac.customer?.sellerName || `Vendedor ${ac.customer?.sellerId?.slice(0, 4)}` || "-"}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant={ac.customer?.virtualService ? "secondary" : "outline"}>
                                {ac.customer?.virtualService ? "Virtual" : "Presencial"}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {ac.customer?.weekdays ? formatWeekdays(ac.customer.weekdays) : "-"}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">
                                {ac.customer?.visitPeriodicity ? (
                                  ac.customer.visitPeriodicity === 'semanal' ? 'Semanal' :
                                  ac.customer.visitPeriodicity === 'quinzenal' ? 'Quinzenal' :
                                  ac.customer.visitPeriodicity === 'mensal' ? 'Mensal' :
                                  ac.customer.visitPeriodicity
                                ) : "-"}
                              </div>
                            </TableCell>
                            <TableCell>
                              <span className={`font-semibold ${ac.customer?.isPositivatedThisMonth ? 'text-green-600' : 'text-red-500'}`}>
                                {ac.customer?.isPositivatedThisMonth ? 'SIM' : 'NÃO'}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm text-muted-foreground">
                                {ac.customer?.lastActivityDate 
                                  ? format(new Date(ac.customer.lastActivityDate), 'dd/MM/yyyy', { locale: ptBR })
                                  : 'Nunca'}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                {ac.nextThreeVisits.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">Sem agendamento</span>
                                ) : (
                                  ac.nextThreeVisits
                                    .sort((a, b) => a.date.localeCompare(b.date))
                                    .map((v, i) => {
                                      try {
                                        if (!v.date || v.date.length === 0) return null;
                                        // Formato: YYYY-MM-DD -> DD/MM
                                        const [year, month, day] = v.date.split('-');
                                        return (
                                          <Badge key={i} variant="secondary" className="text-xs">
                                            {day}/{month}
                                          </Badge>
                                        );
                                      } catch {
                                        return null;
                                      }
                                    })
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {ac.customer?.id && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => handleEditCustomer(e, ac.customer!.id)}
                                  title="Editar cliente"
                                  data-testid={`button-edit-customer-${ac.id}`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
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

        {/* Modais de card de vendas */}
        {showCardModal && selectedCard && (
          <SalesCardDetailsModal
            isOpen={showCardModal}
            onClose={closeModals}
            card={selectedCard}
            onStartSale={handleEditSale}
            onStartNoSale={handleNoSale}
          />
        )}

        {showEditModal && selectedCard && (
          <SaleEditModal
            isOpen={showEditModal}
            onClose={closeModals}
            card={selectedCard}
          />
        )}

        {showNoSaleModal && selectedCard && (
          <NoSaleModal
            isOpen={showNoSaleModal}
            onClose={closeModals}
            card={selectedCard}
          />
        )}

        {/* Modal de Edição de Cliente / Novo Lead */}
        <CustomerEditModal
          isOpen={showCustomerEditModal}
          onClose={handleCustomerEditClose}
          customer={selectedCustomerForEdit}
          isLead={isLeadMode}
        />

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
