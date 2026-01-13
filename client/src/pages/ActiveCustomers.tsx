import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { safeParseWeekdays, formatWeekdays } from "@/lib/weekdayParser";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import CustomerEditModal from "@/components/CustomerEditModal";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
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
  Plus,
  Phone,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  FileText
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
    contact: string | null;
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
  previousMonthTotal?: number;
  currentMonthTotal?: number;
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
  const [sortColumn, setSortColumn] = useState<'previousMonth' | 'currentMonth' | 'variation' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showCardModal, setShowCardModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showNoSaleModal, setShowNoSaleModal] = useState(false);
  const [showCustomerEditModal, setShowCustomerEditModal] = useState(false);
  const [showPhoneEditModal, setShowPhoneEditModal] = useState(false);
  const [isLeadMode, setIsLeadMode] = useState(false);
  const [selectedCard, setSelectedCard] = useState<SalesCardWithRelations | null>(null);
  const [selectedCustomerForEdit, setSelectedCustomerForEdit] = useState<Customer | null>(null);
  const [phoneEditData, setPhoneEditData] = useState<{customerId: string; customerName: string; currentPhone: string; newPhone: string; currentContact: string; newContact: string}>({
    customerId: '', customerName: '', currentPhone: '', newPhone: '', currentContact: '', newContact: ''
  });
  const [showServiceLogModal, setShowServiceLogModal] = useState(false);
  const [serviceLogCustomer, setServiceLogCustomer] = useState<{id: string; name: string} | null>(null);
  const [showVirtualActionModal, setShowVirtualActionModal] = useState(false);
  const [virtualActionCustomer, setVirtualActionCustomer] = useState<{id: string; name: string} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const updatePhoneMutation = useMutation({
    mutationFn: async ({ customerId, phone, contact }: { customerId: string; phone: string; contact: string }) => {
      const response = await fetch(`/api/customers/${customerId}/phone`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone, contact })
      });
      if (!response.ok) throw new Error('Falha ao atualizar dados');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Dados atualizados!", description: "O telefone e contato do cliente foram atualizados com sucesso." });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      setShowPhoneEditModal(false);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Erro", description: error.message || "Falha ao atualizar dados" });
    }
  });

  const handleEditPhone = (e: React.MouseEvent, customerId: string, customerName: string, currentPhone: string, currentContact: string) => {
    e.stopPropagation();
    setPhoneEditData({ customerId, customerName, currentPhone, newPhone: currentPhone, currentContact: currentContact || '', newContact: currentContact || '' });
    setShowPhoneEditModal(true);
  };

  const handleSavePhone = () => {
    if (!phoneEditData.newPhone.trim()) {
      toast({ variant: "destructive", title: "Erro", description: "Digite um telefone válido" });
      return;
    }
    updatePhoneMutation.mutate({ customerId: phoneEditData.customerId, phone: phoneEditData.newPhone, contact: phoneEditData.newContact });
  };

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

  const handleOpenServiceLog = (e: React.MouseEvent, customerId: string, customerName: string) => {
    e.stopPropagation();
    setServiceLogCustomer({ id: customerId, name: customerName });
    setShowServiceLogModal(true);
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

  // Query para estatísticas de atendimentos virtuais
  const { data: serviceLogsStats } = useQuery<{
    total: number;
    today: number;
    month: number;
    byAttendant: Array<{ attendant_name: string; count: string }>;
  }>({
    queryKey: ["/api/service-logs/stats"],
    retry: 1,
  });

  // Query para últimos atendimentos virtuais por cliente
  const { data: lastServiceLogs = {} } = useQuery<Record<string, { date: string; attendant: string; serviceType: string }>>({
    queryKey: ["/api/service-logs/last/customer"],
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

  const handleExportContacts = () => {
    const dataToExport = filteredCustomers.map((ac) => ({
      'Nome Fantasia': ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || '',
      'Telefone': ac.customer?.phone || '',
      'Vendedor': ac.customer?.sellerName || ''
    }));

    if (dataToExport.length === 0) {
      toast({
        title: 'Nenhum cliente para exportar',
        description: 'Aplique filtros ou verifique se há clientes na lista',
        variant: 'destructive'
      });
      return;
    }

    const csvContent = [
      ['Nome Fantasia', 'Telefone', 'Vendedor'].join(';'),
      ...dataToExport.map(row => [
        `"${(row['Nome Fantasia'] || '').replace(/"/g, '""')}"`,
        `"${(row['Telefone'] || '').replace(/"/g, '""')}"`,
        `"${(row['Vendedor'] || '').replace(/"/g, '""')}"`
      ].join(';'))
    ].join('\n');

    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `contatos_clientes_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);

    toast({
      title: 'Contatos exportados',
      description: `${dataToExport.length} clientes exportados com sucesso`
    });
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

  // Função para calcular variação percentual
  const calcVariation = (prev: number, curr: number): number => {
    if (prev === 0 && curr === 0) return -Infinity; // Sem atividade = último na ordenação
    if (prev === 0 && curr > 0) return Infinity; // Novo cliente = primeiro na ordenação
    return ((curr - prev) / prev) * 100;
  };

  // Função para alternar ordenação
  const handleSort = (column: 'previousMonth' | 'currentMonth' | 'variation') => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const filteredCustomers = activeCustomers
    .filter((ac) => {
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
    })
    .sort((a, b) => {
      if (!sortColumn) return 0;
      
      let aValue: number, bValue: number;
      
      if (sortColumn === 'previousMonth') {
        aValue = a.previousMonthTotal || 0;
        bValue = b.previousMonthTotal || 0;
      } else if (sortColumn === 'currentMonth') {
        aValue = a.currentMonthTotal || 0;
        bValue = b.currentMonthTotal || 0;
      } else {
        aValue = calcVariation(a.previousMonthTotal || 0, a.currentMonthTotal || 0);
        bValue = calcVariation(b.previousMonthTotal || 0, b.currentMonthTotal || 0);
      }
      
      if (sortDirection === 'asc') {
        return aValue - bValue;
      }
      return bValue - aValue;
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
          <Button 
            variant="outline"
            className="border-green-600 text-green-600 hover:bg-green-50"
            onClick={handleExportContacts}
            data-testid="button-export-contacts"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Exportar Contatos
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

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
        <Card data-testid="card-stat-virtual-attendance">
          <CardHeader className="pb-2">
            <CardDescription>Atendimentos Virtuais</CardDescription>
            <CardTitle className="text-2xl text-purple-600">
              {serviceLogsStats?.month || 0}
              <span className="text-xs font-normal text-muted-foreground ml-1">/ mês</span>
            </CardTitle>
            {serviceLogsStats?.today ? (
              <span className="text-xs text-green-600">+{serviceLogsStats.today} hoje</span>
            ) : null}
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
                        <TableHead className="text-right">
                          <button
                            onClick={() => handleSort('previousMonth')}
                            className="flex items-center gap-1 ml-auto hover:text-primary transition-colors"
                            data-testid="sort-previous-month"
                          >
                            Mês Anterior
                            {sortColumn === 'previousMonth' ? (
                              sortDirection === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />
                            ) : (
                              <ArrowUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button
                            onClick={() => handleSort('currentMonth')}
                            className="flex items-center gap-1 ml-auto hover:text-primary transition-colors"
                            data-testid="sort-current-month"
                          >
                            Mês Atual
                            {sortColumn === 'currentMonth' ? (
                              sortDirection === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />
                            ) : (
                              <ArrowUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button
                            onClick={() => handleSort('variation')}
                            className="flex items-center gap-1 ml-auto hover:text-primary transition-colors"
                            data-testid="sort-variation"
                          >
                            Variação
                            {sortColumn === 'variation' ? (
                              sortDirection === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />
                            ) : (
                              <ArrowUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>Última Atividade</TableHead>
                        <TableHead>Último Atend. Virtual</TableHead>
                        <TableHead>Próximas 3 Visitas</TableHead>
                        <TableHead>Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCustomers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={16} className="text-center py-8 text-muted-foreground">
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
                                if (ac.customer?.virtualService) {
                                  setVirtualActionCustomer({ 
                                    id: ac.customer.id, 
                                    name: ac.customer.fantasyName || ac.customer.name 
                                  });
                                  setShowVirtualActionModal(true);
                                } else {
                                  handleRowClick(ac.customer.id);
                                }
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
                            <TableCell className="text-right font-mono text-sm">
                              {ac.previousMonthTotal 
                                ? `R$ ${ac.previousMonthTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                                : 'R$ 0,00'}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {ac.currentMonthTotal 
                                ? `R$ ${ac.currentMonthTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                                : 'R$ 0,00'}
                            </TableCell>
                            <TableCell className="text-right">
                              {(() => {
                                const prev = ac.previousMonthTotal || 0;
                                const curr = ac.currentMonthTotal || 0;
                                if (prev === 0 && curr === 0) return <span className="text-gray-400">-</span>;
                                if (prev === 0 && curr > 0) return <span className="text-green-600 font-semibold">+100%</span>;
                                const variation = ((curr - prev) / prev) * 100;
                                const isPositive = variation >= 0;
                                return (
                                  <span className={`font-semibold ${isPositive ? 'text-green-600' : 'text-red-500'}`}>
                                    {isPositive ? '+' : ''}{variation.toFixed(0)}%
                                  </span>
                                );
                              })()}
                            </TableCell>
                            <TableCell>
                              <span className="text-sm text-muted-foreground">
                                {ac.customer?.lastActivityDate 
                                  ? format(new Date(ac.customer.lastActivityDate), 'dd/MM/yyyy', { locale: ptBR })
                                  : 'Nunca'}
                              </span>
                            </TableCell>
                            <TableCell>
                              {ac.customer?.id && lastServiceLogs[ac.customer.id] ? (
                                <div className="flex flex-col gap-0.5 text-xs">
                                  <span className="font-medium">
                                    {format(new Date(lastServiceLogs[ac.customer.id].date), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                                  </span>
                                  <span className="text-muted-foreground truncate max-w-[100px]" title={lastServiceLogs[ac.customer.id].attendant}>
                                    {lastServiceLogs[ac.customer.id].attendant}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
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
                              <div className="flex gap-1">
                                {ac.customer?.id && ac.customer?.virtualService && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => handleOpenServiceLog(e, ac.customer!.id, ac.customer!.fantasyName || ac.customer!.name)}
                                    title="Registrar atendimento virtual"
                                    data-testid={`button-service-log-${ac.id}`}
                                  >
                                    <FileText className="h-4 w-4 text-green-500" />
                                  </Button>
                                )}
                                {ac.customer?.id && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => handleEditPhone(e, ac.customer!.id, ac.customer!.fantasyName || ac.customer!.name, ac.customer!.phone || '', ac.customer!.contact || '')}
                                    title="Editar telefone"
                                    data-testid={`button-edit-phone-${ac.id}`}
                                  >
                                    <Phone className="h-4 w-4 text-blue-500" />
                                  </Button>
                                )}
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

        {/* Modal de Edição Rápida de Telefone e Contato */}
        <Dialog open={showPhoneEditModal} onOpenChange={setShowPhoneEditModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Editar Telefone e Contato</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="text-sm text-muted-foreground">
                Cliente: <span className="font-medium text-foreground">{phoneEditData.customerName}</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact">Nome do Contato</Label>
                <Input
                  id="contact"
                  value={phoneEditData.newContact}
                  onChange={(e) => setPhoneEditData(prev => ({ ...prev, newContact: e.target.value }))}
                  placeholder="Nome da pessoa de contato"
                  data-testid="input-edit-contact"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Telefone</Label>
                <Input
                  id="phone"
                  value={phoneEditData.newPhone}
                  onChange={(e) => setPhoneEditData(prev => ({ ...prev, newPhone: e.target.value }))}
                  placeholder="(00) 00000-0000"
                  data-testid="input-edit-phone"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPhoneEditModal(false)}>
                Cancelar
              </Button>
              <Button 
                onClick={handleSavePhone} 
                disabled={updatePhoneMutation.isPending}
                data-testid="button-save-phone"
              >
                {updatePhoneMutation.isPending ? "Salvando..." : "Salvar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Modal de Registro de Atendimento Virtual */}
        {serviceLogCustomer && (
          <VirtualServiceLogModal
            open={showServiceLogModal}
            onClose={() => {
              setShowServiceLogModal(false);
              setServiceLogCustomer(null);
            }}
            customerId={serviceLogCustomer.id}
            customerName={serviceLogCustomer.name}
          />
        )}

        {/* Modal de Ações para Cliente Virtual */}
        <Dialog open={showVirtualActionModal} onOpenChange={setShowVirtualActionModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-blue-600" />
                Cliente Virtual
              </DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <p className="text-sm text-muted-foreground mb-4">
                Cliente: <span className="font-semibold text-foreground">{virtualActionCustomer?.name}</span>
              </p>
              <div className="flex flex-col gap-3">
                <Button
                  variant="outline"
                  className="w-full justify-start h-12 text-left"
                  onClick={() => {
                    if (virtualActionCustomer) {
                      setServiceLogCustomer(virtualActionCustomer);
                      setShowVirtualActionModal(false);
                      setShowServiceLogModal(true);
                    }
                  }}
                  data-testid="button-register-attendance"
                >
                  <FileText className="h-5 w-5 mr-3 text-blue-600" />
                  <div>
                    <div className="font-medium">Registrar Atendimento</div>
                    <div className="text-xs text-muted-foreground">Registrar notas e histórico de contato</div>
                  </div>
                </Button>
                <Button
                  className="w-full justify-start h-12 text-left bg-green-600 hover:bg-green-700"
                  onClick={() => {
                    if (virtualActionCustomer) {
                      setShowVirtualActionModal(false);
                      handleRowClick(virtualActionCustomer.id);
                    }
                  }}
                  data-testid="button-make-sale"
                >
                  <Plus className="h-5 w-5 mr-3" />
                  <div>
                    <div className="font-medium">Efetuar Venda</div>
                    <div className="text-xs text-green-100">Abrir card de vendas do cliente</div>
                  </div>
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

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
