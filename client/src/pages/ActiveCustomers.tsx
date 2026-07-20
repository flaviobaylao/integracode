import { useActiveSellers, MultiSelect, multiMatch } from "@/lib/tableTools";
import { useState, useRef, useEffect, Fragment } from "react";
import { nowBrazil, getBrazilDateISO } from '@/lib/brazilTimezone';
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCustomerMarks, SobDelegacaoBadge } from "@/components/SobDelegacaoBadge";
import { safeParseWeekdays, formatWeekdays } from "@/lib/weekdayParser";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ScrollArea } from "@/components/ui/scroll-area";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import CustomerEditModal from "@/components/CustomerEditModal";
import GeocodeAllButton from "@/components/GeocodeAllButton";
import CustomerHistoryBox from "@/components/CustomerHistoryBox";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
import type { SalesCardWithRelations, Customer } from "@shared/schema";
import OmieInstanceBadge from "@/components/OmieInstanceBadge";
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
  FileText,
  UserX,
  ShoppingCart,
  Loader2,
  MessageCircle,
  Copy,
  Send,
  RefreshCw,
  History
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { format, differenceInDays } from "date-fns";
import { ptBR } from "date-fns/locale";

function getDateRecencyClass(dateString: string | null | undefined): string {
  if (!dateString) return '';
  
  try {
    const date = new Date(dateString);
    const today = nowBrazil();
    const daysDiff = differenceInDays(today, date);
    
    if (daysDiff <= 7) {
      return 'bg-green-100 dark:bg-green-900/30';
    } else if (daysDiff <= 15) {
      return 'bg-yellow-100 dark:bg-yellow-900/30';
    } else if (daysDiff <= 30) {
      return 'bg-orange-100 dark:bg-orange-900/30';
    } else {
      return 'bg-red-100 dark:bg-red-900/30';
    }
  } catch {
    return '';
  }
}
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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator' || user?.role === 'administrative';
  const delegMarks = useCustomerMarks();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("list");
  const [selectedSeller, setSelectedSeller] = useState<string>("");
  const { sellerOptions, resolveSeller } = useActiveSellers();
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [selectedDayOfRoute, setSelectedDayOfRoute] = useState<string>("");
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedVirtualType, setSelectedVirtualType] = useState<string>("");
  const [selectedPositivation, setSelectedPositivation] = useState<string>("");
  const [selectedCoords, setSelectedCoords] = useState<string>(""); // "", "com", "sem"
  const [selectedPhone, setSelectedPhone] = useState<string>("");
  const [selectedCity, setSelectedCity] = useState<string>("");
  const [selectedNeighborhood, setSelectedNeighborhood] = useState<string>("");
  const [sortColumn, setSortColumn] = useState<'previousMonth' | 'currentMonth' | 'variation' | 'name' | null>(null);
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
  const [showInactivateDialog, setShowInactivateDialog] = useState(false);
  const [customerToInactivate, setCustomerToInactivate] = useState<{id: string; name: string; activeCustomerId: string} | null>(null);
  const [showLastOrderModal, setShowLastOrderModal] = useState(false);
  const [lastOrderCustomerId, setLastOrderCustomerId] = useState<string | null>(null);
  const [lastOrderData, setLastOrderData] = useState<any>(null);
  const [lastOrderLoading, setLastOrderLoading] = useState(false);
  const [showPendingOmieDialog, setShowPendingOmieDialog] = useState(false);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [selectedPersonType, setSelectedPersonType] = useState<string>("");
  const [segmentMulti, setSegmentMulti] = useState<string[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [bulkSeller, setBulkSeller] = useState("");
  const [bulkPeriodicity, setBulkPeriodicity] = useState("");
  const [bulkVirtualType, setBulkVirtualType] = useState("");
  const [bulkWeekdays, setBulkWeekdays] = useState<string[]>([]);
  const [bulkStartDate, setBulkStartDate] = useState("");
  const [bulkGeocode, setBulkGeocode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: pendingOmieData, isLoading: isLoadingPendingOmie } = useQuery({
    queryKey: ['/api/sales-cards/pending-omie'],
    queryFn: () => fetch('/api/sales-cards/pending-omie', { credentials: 'include' }).then(r => r.json()),
    enabled: showPendingOmieDialog,
  });

  const allCardIds: string[] = pendingOmieData?.pendingCards?.map((c: any) => c.id) || [];
  const allSelected = allCardIds.length > 0 && allCardIds.every(id => selectedCardIds.has(id));
  const someSelected = allCardIds.some(id => selectedCardIds.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedCardIds(new Set());
    } else {
      setSelectedCardIds(new Set(allCardIds));
    }
  };

  const toggleCard = (id: string) => {
    setSelectedCardIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sendToOmieMutation = useMutation({
    mutationFn: async (cardId: string) => {
      await apiRequest('POST', `/api/sales-cards/${cardId}/send-to-omie`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards/pending-omie'] });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      toast({ title: "Sucesso", description: "Pedido enviado para Omie com sucesso!" });
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Erro ao Enviar para Omie", description: error.message });
    },
  });

  const bulkSendMutation = useMutation({
    mutationFn: async (cardIds: string[]) => {
      const res = await apiRequest('POST', '/api/sales-cards/bulk-send-to-omie', { cardIds });
      return res as any;
    },
    onSuccess: (data: any) => {
      setSelectedCardIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards/pending-omie'] });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      toast({ title: "Envio em lote concluído", description: `${data.succeeded} enviado(s) com sucesso, ${data.failed} com falha.` });
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Erro no envio em lote", description: error.message });
    },
  });

  const bulkCancelMutation = useMutation({
    mutationFn: async (cardIds: string[]) => {
      const res = await apiRequest('POST', '/api/sales-cards/bulk-cancel', { cardIds });
      return res as any;
    },
    onSuccess: (data: any) => {
      setSelectedCardIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards/pending-omie'] });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      toast({ title: "Cancelamento concluído", description: `${data.cancelled} pedido(s) cancelado(s).` });
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Erro ao cancelar", description: error.message });
    },
  });

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

  const inactivateMutation = useMutation({
    mutationFn: async ({ customerId, activeCustomerId }: { customerId: string; activeCustomerId: string }) => {
      const response = await fetch(`/api/customers/${customerId}/inactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cardId: activeCustomerId })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Falha ao inativar cliente');
      }
      return response.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "Cliente inativado!", 
        description: data.message || "O cliente foi removido da lista de clientes ativos." 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      setShowInactivateDialog(false);
      setCustomerToInactivate(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Erro", description: error.message || "Falha ao inativar cliente" });
    }
  });

  const handleInactivateCustomer = (e: React.MouseEvent, customerId: string, customerName: string, activeCustomerId: string) => {
    e.stopPropagation();
    setCustomerToInactivate({ id: customerId, name: customerName, activeCustomerId });
    setShowInactivateDialog(true);
  };

  const handleViewLastOrder = async (e: React.MouseEvent, customerId: string) => {
    e.stopPropagation();
    console.log('[LastOrder] Opening modal for customer:', customerId);
    setLastOrderCustomerId(customerId);
    setLastOrderLoading(true);
    setShowLastOrderModal(true);
    setLastOrderData(null);
    
    try {
      console.log('[LastOrder] Fetching from:', `/api/customers/${customerId}/last-order`);
      const response = await fetch(`/api/customers/${customerId}/last-order`, {
        credentials: 'include'
      });
      
      console.log('[LastOrder] Response status:', response.status);
      
      if (!response.ok) {
        throw new Error('Falha ao buscar pedido');
      }
      
      const data = await response.json();
      console.log('[LastOrder] Data received:', data);
      
      if (!data.hasOrder) {
        setLastOrderData(null);
      } else {
        setLastOrderData(data);
      }
    } catch (error) {
      console.error('[LastOrder] Erro ao buscar último pedido:', error);
      toast({ 
        variant: "destructive", 
        title: "Erro", 
        description: "Não foi possível carregar o último pedido." 
      });
      setShowLastOrderModal(false);
    } finally {
      setLastOrderLoading(false);
    }
  };

  const confirmInactivate = () => {
    if (customerToInactivate) {
      inactivateMutation.mutate({ 
        customerId: customerToInactivate.id, 
        activeCustomerId: customerToInactivate.activeCustomerId 
      });
    }
  };

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
      const dateToUse = getBrazilDateISO();
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

  const handleActionClick = (e: React.MouseEvent, ac: ActiveCustomerWithVisits) => {
    e.stopPropagation();
    if (ac.customer?.id) {
      setVirtualActionCustomer({
        id: ac.customer.id,
        name: ac.customer.fantasyName || ac.customer.name
      });
      setShowVirtualActionModal(true);
    } else {
      // Cliente presente na lista mas SEM cadastro vinculado (customer nulo):
      // as ações de atendimento/pedido dependem do id do cadastro, então avisamos
      // em vez de o clique não fazer nada.
      toast({
        variant: "destructive",
        title: "Cliente sem cadastro vinculado",
        description: `${ac.fantasyNameImported || ac.document || 'Este cliente'} está na lista, mas ainda não possui um cadastro completo no sistema. Clique em "Atualizar Cadastros (SEFAZ)" para criar o cadastro e então será possível abrir o atendimento e efetuar pedidos.`,
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

  // 📲 Status de confirmação de telefone por cliente (destacar em vermelho quem não confirmou em 24h)
  const { data: phoneVerif = {} } = useQuery<Record<string, { status: string; over24h: boolean }>>({
    queryKey: ['/api/customers/phone-verification-status'],
    queryFn: () => fetch('/api/customers/phone-verification-status', { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
    refetchInterval: 300000,
    staleTime: 60000,
  });

  // ── Atualização de cadastro via Receita/SEFAZ (job em background) ──
  // O botão dispara o job no servidor; a barra acompanha por polling (2s).
  const { data: receitaSync } = useQuery<any>({
    queryKey: ['/api/admin/cadastro-receita-sync/status'],
    queryFn: () => fetch('/api/admin/cadastro-receita-sync/status', { credentials: 'include' }).then(r => r.json()),
    refetchInterval: (query: any) => (query?.state?.data?.status === 'running' ? 2000 : false),
  });
  const startReceitaSyncMutation = useMutation({
    mutationFn: async () => apiRequest('POST', '/api/admin/cadastro-receita-sync/start'),
    onSuccess: () => {
      toast({ title: 'Atualização iniciada', description: 'Buscando dados oficiais (Receita/SEFAZ) em segundo plano. Contatos não serão alterados.' });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/cadastro-receita-sync/status'] });
    },
    onError: (error: any) => {
      toast({ title: 'Não foi possível iniciar', description: error?.message || 'Erro ao iniciar atualização', variant: 'destructive' });
    },
  });
  const cancelReceitaSyncMutation = useMutation({
    mutationFn: async () => apiRequest('POST', '/api/admin/cadastro-receita-sync/cancel'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/admin/cadastro-receita-sync/status'] }),
  });
  // Ao concluir, recarrega a lista p/ refletir os cadastros atualizados
  const receitaSyncStatus = receitaSync?.status;
  useEffect(() => {
    if (receitaSyncStatus === 'done' && !receitaSync?.fromSnapshot) {
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
    }
  }, [receitaSyncStatus]);

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

  // Query para vendedores ativos (filtro) - endpoint dedicado server-side
  const { data: activeSellers = [] } = useQuery<Array<{ id: string; name: string; allIds?: string[] }>>({
    queryKey: ["/api/sellers/active"],
    staleTime: 30000,
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
      // Âncora = data do ÚLTIMO ATENDIMENTO do cliente (2.0); gera as próximas seguindo as regras base (semanal/quinzenal/mensal).
      const response = await fetch("/api/admin/visits/generate-from-1-0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ apply: true, count: 4, replaceFuture: true })
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || "Erro ao gerar agendamentos");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      console.log('✅ Geração de agendamentos iniciada:', data);
      toast({ 
        title: "✅ Gerando agendamentos!", 
        description: `Ancorado no último atendimento de cada cliente (${data?.comAncora ?? 0} clientes com histórico). As próximas visitas estão sendo criadas em segundo plano.`
      });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/active-customers"] }), 8000);
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
    const dataToExport = filteredCustomers.map((ac) => {
      const prev = ac.previousMonthTotal || 0;
      const curr = ac.currentMonthTotal || 0;
      let variacao = '-';
      if (prev === 0 && curr > 0) variacao = '+100%';
      else if (prev > 0) variacao = `${(((curr - prev) / prev) * 100).toFixed(0)}%`;

      const lastLog = ac.customer?.id ? lastServiceLogs[ac.customer.id] : null;

      return {
        'Status': ac.matchStatus === 'matched' ? 'Encontrado' : 'Não encontrado',
        'CPF/CNPJ': ac.document || '',
        'Nome': ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || '',
        'Bairro': ac.customer?.neighborhood || '',
        'Telefone': ac.customer?.phone || '',
        'Vendedor': ac.customer?.sellerName || '',
        'Tipo': ac.customer?.virtualService ? 'Virtual' : 'Presencial',
        'Dia da Rota': ac.customer?.weekdays ? formatWeekdays(ac.customer.weekdays) : '',
        'Periodicidade': ac.customer?.visitPeriodicity === 'semanal' ? 'Semanal' : ac.customer?.visitPeriodicity === 'quinzenal' ? 'Quinzenal' : ac.customer?.visitPeriodicity === 'mensal' ? 'Mensal' : ac.customer?.visitPeriodicity || '',
        'Positivado': ac.customer?.isPositivatedThisMonth ? 'SIM' : 'NÃO',
        'Mês Anterior': prev > 0 ? prev.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00',
        'Mês Atual': curr > 0 ? curr.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00',
        'Variação': variacao,
        'Última Atividade': ac.customer?.lastActivityDate ? format(new Date(ac.customer.lastActivityDate), 'dd/MM/yyyy', { locale: ptBR }) : '',
        'Último Atend. Virtual': lastLog ? format(new Date(lastLog.date), 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '',
        'Atendente Virtual': lastLog?.attendant || '',
        'Próximas Visitas': ac.nextThreeVisits.length > 0 ? ac.nextThreeVisits.sort((a, b) => a.date.localeCompare(b.date)).map(v => { try { const [y, m, d] = v.date.split('-'); return `${d}/${m}`; } catch { return ''; } }).filter(Boolean).join(', ') : '',
      };
    });

    if (dataToExport.length === 0) {
      toast({
        title: 'Nenhum cliente para exportar',
        description: 'Aplique filtros ou verifique se há clientes na lista',
        variant: 'destructive'
      });
      return;
    }

    const headers = ['Status', 'CPF/CNPJ', 'Nome', 'Bairro', 'Telefone', 'Vendedor', 'Tipo', 'Dia da Rota', 'Periodicidade', 'Positivado', 'Mês Anterior', 'Mês Atual', 'Variação', 'Última Atividade', 'Último Atend. Virtual', 'Atendente Virtual', 'Próximas Visitas'];
    const csvContent = [
      headers.join(';'),
      ...dataToExport.map(row =>
        headers.map(h => `"${(String((row as any)[h]) || '').replace(/"/g, '""')}"`).join(';')
      )
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

  // Lista de vendedores ativos (filtrado no servidor)
  const sellers = activeSellers;

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

  const cities = Array.from(
    new Set(
      activeCustomers
        .map(ac => ac.customer?.city?.trim())
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const neighborhoods = Array.from(
    new Set(
      activeCustomers
        .filter(ac => !selectedCity || ac.customer?.city?.trim() === selectedCity)
        .map(ac => ac.customer?.neighborhood?.trim())
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const segmentOptions = Array.from(
    new Set(
      activeCustomers
        .map(ac => ac.customer?.segmentoPrincipal)
        .filter(Boolean) as string[]
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const SEM_SEGMENTO = "(Sem segmento)";
  const segmentFilterOptions = [
    ...segmentOptions,
    ...(activeCustomers.some(ac => !ac.customer?.segmentoPrincipal) ? [SEM_SEGMENTO] : []),
  ];

  // Função para calcular variação percentual
  const calcVariation = (prev: number, curr: number): number => {
    if (prev === 0 && curr === 0) return -Infinity; // Sem atividade = último na ordenação
    if (prev === 0 && curr > 0) return Infinity; // Novo cliente = primeiro na ordenação
    return ((curr - prev) / prev) * 100;
  };

  // Função para alternar ordenação
  const handleSort = (column: 'previousMonth' | 'currentMonth' | 'variation' | 'name') => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'name' ? 'asc' : 'desc');
    }
  };

  const filteredCustomers = activeCustomers
    .filter((ac) => {
      const searchLower = searchTerm.toLowerCase();
      const name = ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || "";
      const doc = ac.document || "";
      
      // Filtro de busca
      const matchesSearch = name.toLowerCase().includes(searchLower) || doc.includes(searchTerm);
      
      // Filtro de vendedor (verifica todos os IDs equivalentes entre instâncias)
      let matchesSeller = !selectedSeller;
      if (selectedSeller && ac.customer?.sellerId) {
        const sellerEntry = activeSellers.find(s => s.id === selectedSeller);
        const sellerIds = sellerEntry?.allIds || [selectedSeller];
        matchesSeller = sellerIds.includes(ac.customer.sellerId);
      }
      
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
      
      // Filtro de telefone
      const phoneDigits = selectedPhone.replace(/\D/g, '');
      const customerPhone = (ac.customer?.phone || '').replace(/\D/g, '');
      const matchesPhone = !phoneDigits || customerPhone.includes(phoneDigits);
      
      const matchesCity = !selectedCity || ac.customer?.city?.trim() === selectedCity;
      const matchesNeighborhood = !selectedNeighborhood || ac.customer?.neighborhood?.trim() === selectedNeighborhood;
      
      const matchesSellerMulti = multiMatch(sellerMulti, resolveSeller(ac.customer?.sellerName || ac.customer?.sellerId));
      const ptDigits = (ac.document || '').replace(/\D/g, '');
      const personType = (ac.customer as any)?.customerType || (ptDigits.length === 14 ? 'pessoa_juridica' : ptDigits.length === 11 ? 'pessoa_fisica' : '');
      const matchesPersonType = !selectedPersonType || personType === selectedPersonType;
      const matchesSegment = multiMatch(segmentMulti, ac.customer?.segmentoPrincipal || SEM_SEGMENTO);
      // Filtro de coordenadas (com/sem lat-long no cadastro)
      const hasCoords = !!((ac.customer as any)?.latitude && (ac.customer as any)?.longitude);
      const matchesCoords = !selectedCoords || (selectedCoords === 'com' ? hasCoords : !hasCoords);
      return matchesSearch && matchesSeller && matchesSellerMulti && matchesDayOfRoute && matchesPeriodicity && matchesVirtualType && matchesDate && matchesPositivation && matchesPhone && matchesCity && matchesNeighborhood && matchesPersonType && matchesSegment && matchesCoords;
    })
    .sort((a, b) => {
      if (!sortColumn) return 0;

      if (sortColumn === 'name') {
        const an = String(a.customer?.fantasyName || a.customer?.name || a.fantasyNameImported || '');
        const bn = String(b.customer?.fantasyName || b.customer?.name || b.fantasyNameImported || '');
        const cmp = an.localeCompare(bn, 'pt-BR', { sensitivity: 'base' });
        return sortDirection === 'asc' ? cmp : -cmp;
      }

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

  const selectableIds = filteredCustomers.map((ac: any) => ac.customer?.id).filter(Boolean) as string[];
  const allCustomersSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedCustomerIds.has(id));
  const toggleCustomer = (id?: string) => { if (!id) return; setSelectedCustomerIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const toggleSelectAllCustomers = () => { setSelectedCustomerIds((prev) => { if (selectableIds.length > 0 && selectableIds.every((id) => prev.has(id))) return new Set(); return new Set(selectableIds); }); };
  const bulkUpdateMutation = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selectedCustomerIds);
      const fields: any = {};
      if (bulkSeller) fields.sellerId = bulkSeller;
      if (bulkPeriodicity) fields.visitPeriodicity = bulkPeriodicity;
      if (bulkWeekdays.length) fields.weekdays = bulkWeekdays;
      if (bulkStartDate) fields.serviceStartDate = bulkStartDate;
      if (bulkVirtualType) fields.virtualService = bulkVirtualType === 'virtual';
      let updated = 0;
      if (Object.keys(fields).length > 0) {
        const r: any = await apiRequest('POST', '/api/customers/bulk-update', { ids, fields });
        const j = await (r?.json ? r.json() : Promise.resolve({})).catch(() => ({}));
        updated = j.updated ?? 0;
      }
      // Flag "Atualizar coordenadas": geocodifica SOMENTE os clientes selecionados (segundo plano).
      let geocodeCount = 0;
      if (bulkGeocode && ids.length > 0) {
        const g: any = await apiRequest('POST', '/api/admin/customers/geocode-all', { apply: true, recalc: true, customerIds: ids });
        const gj = await (g?.json ? g.json() : Promise.resolve({})).catch(() => ({}));
        geocodeCount = gj.candidates ?? ids.length;
      }
      return { updated, geocoded: bulkGeocode, geocodeCount, hadFields: Object.keys(fields).length > 0 };
    },
    onSuccess: (res: any) => {
      const parts: string[] = [];
      if (res.hadFields) parts.push(`${res.updated ?? 0} de ${selectedCustomerIds.size} cliente(s) alterado(s)`);
      if (res.geocoded) parts.push(`coordenadas de ${res.geocodeCount} cliente(s) sendo buscadas em segundo plano`);
      toast({ title: "Concluído", description: parts.join(' · ') || 'Nada para alterar.' });
      setShowBulkModal(false); setSelectedCustomerIds(new Set()); setBulkSeller(""); setBulkPeriodicity(""); setBulkWeekdays([]); setBulkStartDate(""); setBulkVirtualType(""); setBulkGeocode(false);
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
    },
    onError: (e: any) => { toast({ title: "Erro na edição em massa", description: e?.message || String(e), variant: "destructive" }); },
  });

  const bulkInactivateMutation = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selectedCustomerIds);
      const r: any = await apiRequest('POST', '/api/customers/bulk-inactivate', { ids });
      return await (r?.json ? r.json() : Promise.resolve({})).catch(() => ({}));
    },
    onSuccess: (res: any) => {
      const extra: string[] = [];
      if (res.alreadyInactive) extra.push(`${res.alreadyInactive} já estavam inativos`);
      if (res.deletedCards) extra.push(`${res.deletedCards} agendamento(s) futuro(s) removido(s)`);
      toast({ title: "Inativação em massa concluída", description: `${res.inactivated ?? 0} cliente(s) inativado(s)${extra.length ? ' · ' + extra.join(' · ') : ''}.` });
      setSelectedCustomerIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
    },
    onError: (e: any) => { toast({ title: "Erro na inativação em massa", description: e?.message || String(e), variant: "destructive" }); },
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
        <div className="flex gap-2 flex-wrap">
          <GeocodeAllButton />
          {isAdmin && (
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => startReceitaSyncMutation.mutate()}
              disabled={receitaSync?.status === 'running' || startReceitaSyncMutation.isPending}
              title="Atualiza cadastro (razão social, endereço, cidade, UF, CEP e inscrição estadual) dos clientes ativos com dados faltantes, usando os dados oficiais do CNPJ (Receita/SEFAZ/CNPJ.ws). Contatos não são alterados."
              data-testid="button-receita-sync"
            >
              {receitaSync?.status === 'running' ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Atualizar Cadastros (SEFAZ)
            </Button>
          )}
          <Button
            className="bg-purple-600 hover:bg-purple-700 text-white"
            onClick={handleNewLead}
            data-testid="button-new-lead"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Lead
          </Button>
          <Button
            className="bg-slate-600 hover:bg-slate-700 text-white"
            onClick={handleDownloadTemplate}
            data-testid="button-download-template"
          >
            <Download className="h-4 w-4 mr-2" />
            Template
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={handleExportContacts}
            data-testid="button-export-contacts"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Exportar Contatos
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

      {receitaSync && receitaSync.status && receitaSync.status !== 'idle' && (
        <Card className="border-blue-300 bg-blue-50/60 dark:bg-blue-900/10" data-testid="card-receita-sync-progress">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-medium">
                {receitaSync.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
                <span>
                  Atualização de cadastro (Receita/SEFAZ)
                  {receitaSync.status === 'running' && receitaSync.current ? ` — consultando: ${receitaSync.current}` : ''}
                  {receitaSync.status === 'done' ? ' — concluída' : ''}
                  {receitaSync.status === 'cancelled' ? ' — cancelada' : ''}
                  {receitaSync.status === 'error' ? ' — erro' : ''}
                  {receitaSync.fromSnapshot ? ' (última execução)' : ''}
                </span>
              </div>
              {receitaSync.status === 'running' && (
                <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" onClick={() => cancelReceitaSyncMutation.mutate()} data-testid="button-receita-sync-cancel">
                  <X className="h-4 w-4 mr-1" /> Cancelar
                </Button>
              )}
            </div>
            <Progress value={receitaSync.total > 0 ? Math.round((receitaSync.done / receitaSync.total) * 100) : 0} className="h-3" />
            <p className="text-xs text-muted-foreground">
              {receitaSync.done} de {receitaSync.total} clientes — {receitaSync.updated} atualizados · {receitaSync.skipped} sem mudança · {receitaSync.failed} falhas
              {receitaSync.lastErrors && receitaSync.lastErrors.length > 0 ? ` · último erro: ${receitaSync.lastErrors[receitaSync.lastErrors.length - 1].name}` : ''}
            </p>
          </CardContent>
        </Card>
      )}

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
                  className="pl-10 pr-8 h-9"
                  data-testid="input-search"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm("")}
                    title="Limpar busca"
                    aria-label="Limpar busca"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-clear-search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              
              <Filter className="h-4 w-4 text-muted-foreground" />
              
              <MultiSelect label="Vendedor" options={sellerOptions} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller-active" />

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
              
              <Select value={selectedPersonType} onValueChange={setSelectedPersonType}>
                <SelectTrigger className="w-[120px] h-9" data-testid="select-persontype-filter">
                  <SelectValue placeholder="PJ / PF" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pessoa_juridica">Pessoa Jurídica</SelectItem>
                  <SelectItem value="pessoa_fisica">Pessoa Física</SelectItem>
                </SelectContent>
              </Select>

              <MultiSelect label="Segmento" options={segmentFilterOptions} selected={segmentMulti} onChange={setSegmentMulti} testId="filter-segment-active" />

              <Select value={selectedPositivation} onValueChange={setSelectedPositivation}>
                <SelectTrigger className="w-[120px] h-9" data-testid="select-positivation-filter">
                  <SelectValue placeholder="Positivação" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sim">Positivado</SelectItem>
                  <SelectItem value="nao">Não Positivado</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedCoords} onValueChange={setSelectedCoords}>
                <SelectTrigger className="w-[140px] h-9" data-testid="select-coords-filter">
                  <SelectValue placeholder="Coordenadas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="com">Com coordenada</SelectItem>
                  <SelectItem value="sem">Sem coordenada</SelectItem>
                </SelectContent>
              </Select>

              <Select value={selectedCity} onValueChange={(val) => { setSelectedCity(val); setSelectedNeighborhood(""); }}>
                <SelectTrigger className="w-[130px] h-9" data-testid="select-city-filter">
                  <SelectValue placeholder="Cidade" />
                </SelectTrigger>
                <SelectContent>
                  {cities.map((city) => (
                    <SelectItem key={city} value={city}>
                      {city}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={selectedNeighborhood} onValueChange={setSelectedNeighborhood}>
                <SelectTrigger className="w-[130px] h-9" data-testid="select-neighborhood-filter">
                  <SelectValue placeholder="Bairro" />
                </SelectTrigger>
                <SelectContent>
                  {neighborhoods.map((nb) => (
                    <SelectItem key={nb} value={nb}>
                      {nb}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="relative">
                <Phone className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Telefone"
                  value={selectedPhone}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSelectedPhone(e.target.value)}
                  className="w-[130px] h-9 pl-8"
                  data-testid="input-phone-filter"
                />
              </div>

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
                  setSelectedPhone("");
                  setSelectedCity("");
                  setSelectedNeighborhood("");
                  setSelectedPersonType("");
                  setSelectedCustomerIds(new Set());
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
              {selectedCustomerIds.size > 0 && (
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white h-9" onClick={() => setShowBulkModal(true)} data-testid="button-bulk-edit">
                  ✏️ Editar em massa ({selectedCustomerIds.size})
                </Button>
              )}
              {selectedCustomerIds.size > 0 && (
                <Button
                  size="sm"
                  className="bg-red-600 hover:bg-red-700 text-white h-9"
                  onClick={() => { if (window.confirm(`Inativar ${selectedCustomerIds.size} cliente(s) selecionado(s)?\n\nEles sairão da lista de Clientes Ativos e seus agendamentos futuros pendentes serão removidos.`)) bulkInactivateMutation.mutate(); }}
                  disabled={bulkInactivateMutation.isPending}
                  data-testid="button-bulk-inactivate"
                >
                  🚫 {bulkInactivateMutation.isPending ? "Inativando…" : `Inativar selecionados (${selectedCustomerIds.size})`}
                </Button>
              )}
              {(searchTerm || selectedSeller || selectedDayOfRoute || selectedPeriodicity || selectedVirtualType || selectedPositivation || selectedPhone || selectedCity || selectedNeighborhood) && (
                <span className="text-xs text-muted-foreground">
                  {activeCustomers.length} total
                </span>
              )}
            </div>
          </div>

          <Card>
            <CardContent className="p-0 relative">
              {isLoadingCustomers ? (
                <div className="p-4 space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : (
                <>
                {/* Barra de rolagem horizontal no topo */}
                <div
                  ref={(el) => {
                    if (el) {
                      const tableContainer = el.nextElementSibling as HTMLDivElement;
                      if (tableContainer) {
                        const inner = el.querySelector('div') as HTMLDivElement;
                        const syncFromTop = () => { tableContainer.scrollLeft = el.scrollLeft; };
                        const syncFromTable = () => { el.scrollLeft = tableContainer.scrollLeft; };
                        el.addEventListener('scroll', syncFromTop);
                        tableContainer.addEventListener('scroll', syncFromTable);
                        const updateWidth = () => {
                          if (inner) inner.style.width = `${tableContainer.scrollWidth}px`;
                        };
                        updateWidth();
                        const observer = new ResizeObserver(updateWidth);
                        observer.observe(tableContainer);
                      }
                    }
                  }}
                  className="overflow-x-auto"
                  style={{ overflowY: 'hidden', height: '16px' }}
                >
                  <div style={{ height: '1px' }}></div>
                </div>
                <div 
                  className="overflow-x-auto" 
                  style={{ 
                    maxHeight: 'calc(100vh - 300px)',
                    overflowY: 'auto',
                  }}
                >
                  <Table className="min-w-[1800px]">
                    <TableHeader className="sticky top-0 bg-background z-10" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                      <TableRow>
                        <TableHead className="w-8"><Checkbox checked={allCustomersSelected} onCheckedChange={toggleSelectAllCustomers} aria-label="Selecionar todos" /></TableHead>
                        <TableHead className="min-w-[60px]">Status</TableHead>
                        <TableHead className="min-w-[120px]">CPF/CNPJ</TableHead>
                        <TableHead className="min-w-[180px]">
                          <button
                            onClick={() => handleSort('name')}
                            className="flex items-center gap-1 hover:text-primary transition-colors"
                            data-testid="sort-name"
                          >
                            Nome
                            {sortColumn === 'name' ? (
                              sortDirection === 'desc' ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />
                            ) : (
                              <ArrowUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="min-w-[120px]">Telefone</TableHead>
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
                        <TableHead className="min-w-[80px]">Última Atividade</TableHead>
                        <TableHead className="min-w-[100px]">Último Atend. Virtual</TableHead>
                        <TableHead className="min-w-[140px]">Próximas 3 Visitas</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCustomers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={16} className="text-center py-8 text-muted-foreground">
                            {searchTerm || selectedSeller || selectedPhone || selectedCity || selectedNeighborhood ? "Nenhum cliente encontrado com os filtros aplicados" : "Nenhum cliente ativo na lista. Faça upload de uma planilha."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredCustomers.map((ac) => (
                          <Fragment key={ac.id}>
                          <TableRow
                            data-testid={`row-customer-${ac.id}`}
                            onClick={(e) => handleActionClick(e, ac)}
                            className={`cursor-pointer transition-colors ${((ac.nextThreeVisits?.length ?? 0) === 0) ? 'bg-red-100 hover:bg-red-200' : 'hover:bg-muted/50'}${(ac.customer && (!(ac.customer as any).latitude || !(ac.customer as any).longitude)) ? ' text-red-600' : ''}`}
                          >
                            <TableCell onClick={(e) => e.stopPropagation()} className="w-8">
                              <Checkbox checked={selectedCustomerIds.has(ac.customer?.id || '')} onCheckedChange={() => toggleCustomer(ac.customer?.id)} disabled={!ac.customer?.id} aria-label="Selecionar cliente" />
                            </TableCell>
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
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setHistoryOpenId(historyOpenId === ac.id ? null : ac.id); }}
                                  title="Histórico de alterações"
                                  className={`shrink-0 transition-colors ${historyOpenId === ac.id ? 'text-primary' : 'text-muted-foreground hover:text-primary'}`}
                                  data-testid={`button-history-${ac.id}`}
                                >
                                  <History className="h-4 w-4" />
                                </button>
                                <div className={`font-medium ${(ac.customer as any)?.isConsumerClient ? 'bg-green-100 text-green-800 px-2 py-1 rounded-md inline-block' : ''}`}>
                                  {ac.customer?.fantasyName || ac.customer?.name || ac.fantasyNameImported || "-"}
                                </div>
                                <OmieInstanceBadge instanceId={(ac.customer as any)?.omieInstanceId} />
                                {ac.customer && (!(ac.customer as any).latitude || !(ac.customer as any).longitude) && (
                                  <span className="text-[10px] font-semibold text-red-700 border border-red-300 bg-red-50 px-1.5 py-0.5 rounded whitespace-nowrap" title="Sem coordenadas no cadastro - nao entra na rota do dia">SEM COORDENADA</span>
                                )}
                                <SobDelegacaoBadge show={delegMarks.has(((ac.customer as any)?.id ?? ac.customerId) as string)} />
                              </div>
                              {ac.customer?.address && (
                                <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                  {ac.customer.neighborhood}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {(() => {
                                const _pv = ac.customer?.id ? (phoneVerif as any)[ac.customer.id] : null;
                                const _unconfirmed = !!(_pv && _pv.over24h);
                                const _confirmed = !!(_pv && _pv.status === 'confirmed');
                                return (
                                  <span
                                    className={_unconfirmed ? "text-red-600 font-semibold" : ""}
                                    title={_unconfirmed ? "Telefone não confirmado pelo cliente em 24h" : (_confirmed ? "Telefone confirmado pelo cliente" : "")}
                                  >
                                    {ac.customer?.phone || "-"}
                                    {_confirmed ? " ✓" : ""}
                                  </span>
                                );
                              })()}
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
                              <span className={`text-sm px-2 py-1 rounded ${ac.customer?.lastActivityDate ? getDateRecencyClass(ac.customer.lastActivityDate) : ''}`}>
                                {ac.customer?.lastActivityDate 
                                  ? format(new Date(ac.customer.lastActivityDate), 'dd/MM/yyyy', { locale: ptBR })
                                  : <span className="text-muted-foreground">Nunca</span>}
                              </span>
                            </TableCell>
                            <TableCell>
                              {ac.customer?.id && lastServiceLogs[ac.customer.id] ? (
                                <div className={`flex flex-col gap-0.5 text-xs px-2 py-1 rounded ${getDateRecencyClass(lastServiceLogs[ac.customer.id].date)}`}>
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
                          </TableRow>
                          {historyOpenId === ac.id && (
                            <TableRow className="bg-muted/20 hover:bg-muted/20">
                              <TableCell colSpan={16} className="py-1">
                                <CustomerHistoryBox customerId={ac.customer?.id} />
                              </TableCell>
                            </TableRow>
                          )}
                          </Fragment>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
                </>
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
        {showBulkModal && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowBulkModal(false)}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-3 border-b flex items-center justify-between">
                <div className="font-bold text-gray-800">Editar em massa · {selectedCustomerIds.size} cliente(s)</div>
                <button onClick={() => setShowBulkModal(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
              <div className="px-5 py-4 space-y-4 text-sm">
                <p className="text-xs text-gray-500">Preencha só os campos que quer alterar; os demais ficam como estão.</p>
                <div>
                  <label className="block text-xs font-medium mb-1">Vendedor</label>
                  <select value={bulkSeller} onChange={(e) => setBulkSeller(e.target.value)} className="w-full border rounded px-2 py-1.5">
                    <option value="">— não alterar —</option>
                    {activeSellers.map((sv: any) => (<option key={sv.id} value={sv.id}>{sv.name}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Periodicidade de Visita</label>
                  <select value={bulkPeriodicity} onChange={(e) => setBulkPeriodicity(e.target.value)} className="w-full border rounded px-2 py-1.5">
                    <option value="">— não alterar —</option>
                    <option value="semanal">Semanal</option>
                    <option value="quinzenal">Quinzenal</option>
                    <option value="mensal">Mensal</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Tipo (Atendimento)</label>
                  <select value={bulkVirtualType} onChange={(e) => setBulkVirtualType(e.target.value)} className="w-full border rounded px-2 py-1.5" data-testid="bulk-virtual-type">
                    <option value="">— não alterar —</option>
                    <option value="virtual">Virtual</option>
                    <option value="presencial">Presencial</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Dias de Visita <span className="text-gray-400">(marque para alterar)</span></label>
                  <div className="flex flex-wrap gap-2">
                    {[['Seg', 'Segunda'], ['Ter', 'Terça'], ['Qua', 'Quarta'], ['Qui', 'Quinta'], ['Sex', 'Sexta'], ['Sab', 'Sábado'], ['Dom', 'Domingo']].map(([v, l]) => (
                      <label key={v} className={`px-2 py-1 rounded border cursor-pointer text-xs ${bulkWeekdays.includes(v) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}>
                        <input type="checkbox" className="hidden" checked={bulkWeekdays.includes(v)} onChange={() => setBulkWeekdays((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])} />
                        {l}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Data de Início do Fornecimento</label>
                  <input type="date" value={bulkStartDate} onChange={(e) => setBulkStartDate(e.target.value)} className="w-full border rounded px-2 py-1.5" />
                </div>
                <div className="pt-1 border-t">
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input type="checkbox" checked={bulkGeocode} onChange={(e) => setBulkGeocode(e.target.checked)} data-testid="bulk-geocode-flag" />
                    <span className="text-xs font-medium">Atualizar coordenadas dos clientes selecionados</span>
                  </label>
                  <p className="text-[11px] text-gray-400 mt-1">Ao aplicar, busca/recalcula latitude e longitude apenas dos {selectedCustomerIds.size} cliente(s) marcado(s), em segundo plano.</p>
                </div>
              </div>
              <div className="px-5 py-3 border-t flex justify-end gap-2">
                <button onClick={() => setShowBulkModal(false)} className="px-3 py-1.5 rounded border text-sm">Cancelar</button>
                <button
                  onClick={() => { if (!bulkSeller && !bulkPeriodicity && !bulkWeekdays.length && !bulkStartDate && !bulkVirtualType && !bulkGeocode) { toast({ title: 'Nada para alterar', description: 'Preencha ao menos um campo ou marque atualizar coordenadas.', variant: 'destructive' }); return; } if (window.confirm(`Aplicar a ${selectedCustomerIds.size} cliente(s)?`)) bulkUpdateMutation.mutate(); }}
                  disabled={bulkUpdateMutation.isPending}
                  className="px-4 py-1.5 rounded bg-green-600 text-white text-sm font-medium disabled:opacity-50"
                >{bulkUpdateMutation.isPending ? 'Aplicando…' : 'Aplicar'}</button>
              </div>
            </div>
          </div>
        )}
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

        {/* Modal de Ações Virtuais / Presenciais */}
        <Dialog open={showVirtualActionModal} onOpenChange={setShowVirtualActionModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Ações do Cliente</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 gap-4 py-4">
              <div className="text-center mb-4">
                <p className="font-semibold text-lg">{virtualActionCustomer?.name}</p>
                <p className="text-sm text-muted-foreground">Selecione a ação desejada para este cliente</p>
              </div>

              {/* Botão de WhatsApp / Chat Center */}
              {(() => {
                const customer = activeCustomers.find(ac => ac.customer?.id === virtualActionCustomer?.id)?.customer;
                if (!customer?.phone) return null;
                return (
                  <Button 
                    variant="outline" 
                    className="w-full justify-start h-12 text-green-600 hover:text-green-700 hover:bg-green-50"
                    onClick={() => {
                      const phone = customer.phone!.replace(/\D/g, '');
                      const normalizedPhone = phone.startsWith('55') ? phone : `55${phone}`;
                      window.location.href = `/telemarketing/atendimento?phone=${normalizedPhone}`;
                    }}
                  >
                    <MessageCircle className="h-5 w-5 mr-3" />
                    Abrir no Chat Center (WhatsApp)
                  </Button>
                );
              })()}

              {/* Botão Registrar Atendimento */}
              <Button 
                variant="outline" 
                className="w-full justify-start h-12 text-honest-blue hover:bg-blue-50"
                onClick={() => {
                  if (virtualActionCustomer) {
                    handleOpenServiceLog({ stopPropagation: () => {} } as any, virtualActionCustomer.id, virtualActionCustomer.name);
                    setShowVirtualActionModal(false);
                  }
                }}
              >
                <FileText className="h-5 w-5 mr-3" />
                Registrar Atendimento (Virtual/Presencial)
              </Button>

              {/* Botão Efetuar Pedido / Abrir Card */}
              <Button 
                variant="outline" 
                className="w-full justify-start h-12 text-orange-600 hover:bg-orange-50"
                onClick={() => {
                  if (virtualActionCustomer) {
                    handleRowClick(virtualActionCustomer.id);
                    setShowVirtualActionModal(false);
                  }
                }}
              >
                <ShoppingCart className="h-5 w-5 mr-3" />
                Efetuar Pedido / Abrir Card de Vendas
              </Button>

              {/* Botão Ver Último Pedido */}
              <Button 
                variant="outline" 
                className="w-full justify-start h-12 text-purple-600 hover:bg-purple-50"
                onClick={(e) => {
                  if (virtualActionCustomer) {
                    handleViewLastOrder(e as any, virtualActionCustomer.id);
                    setShowVirtualActionModal(false);
                  }
                }}
              >
                <ShoppingCart className="h-5 w-5 mr-3" />
                Ver Histórico do Último Pedido
              </Button>

              <div className="grid grid-cols-2 gap-2 mt-2">
                {/* Botão Editar Telefone */}
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="text-blue-500 justify-start"
                  onClick={(e) => {
                    const ac = activeCustomers.find(ac => ac.customer?.id === virtualActionCustomer?.id);
                    if (ac?.customer) {
                      handleEditPhone(e as any, ac.customer.id, ac.customer.fantasyName || ac.customer.name, ac.customer.phone || '', ac.customer.contact || '');
                      setShowVirtualActionModal(false);
                    }
                  }}
                >
                  <Phone className="h-4 w-4 mr-2" />
                  Editar Telefone
                </Button>

                {/* Botão Editar Cliente */}
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="justify-start"
                  onClick={(e) => {
                    if (virtualActionCustomer) {
                      handleEditCustomer(e as any, virtualActionCustomer.id);
                      setShowVirtualActionModal(false);
                    }
                  }}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Editar Cliente
                </Button>

                {/* Botão Inativar (apenas Admin) */}
                {isAdmin && (
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className="text-red-500 justify-start col-span-2"
                    onClick={(e) => {
                      const ac = activeCustomers.find(ac => ac.customer?.id === virtualActionCustomer?.id);
                      if (ac?.customer) {
                        handleInactivateCustomer(e as any, ac.customer.id, ac.customer.fantasyName || ac.customer.name, ac.id);
                        setShowVirtualActionModal(false);
                      }
                    }}
                  >
                    <UserX className="h-4 w-4 mr-2" />
                    Inativar Cliente
                  </Button>
                )}
              </div>
            </div>
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
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/customer"] });
              queryClient.invalidateQueries({ queryKey: ["/api/service-logs/stats"] });
            }}
          />
        )}

        {/* Modal de Último Pedido */}
        <Dialog open={showLastOrderModal} onOpenChange={setShowLastOrderModal}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5 text-purple-600" />
                Último Pedido
              </DialogTitle>
            </DialogHeader>
            
            {lastOrderLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
                <span className="ml-2">Carregando...</span>
              </div>
            ) : lastOrderData ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                  <div>
                    <p className="text-sm text-muted-foreground">Cliente</p>
                    <p className="font-semibold">{lastOrderData.customer_fantasy_name || lastOrderData.customer_name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Data do Pedido</p>
                    <p className="font-semibold">
                      {lastOrderData.order_date 
                        ? format(new Date(lastOrderData.order_date), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })
                        : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Valor Total</p>
                    <p className="font-semibold text-green-600 text-lg">
                      R$ {Number(lastOrderData.total_value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Método de Pagamento</p>
                    <p className="font-semibold">{lastOrderData.payment_method || 'Não informado'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Tipo de Pedido</p>
                    <Badge variant={lastOrderData.order_type === 'venda' ? 'default' : lastOrderData.order_type === 'troca' ? 'secondary' : 'outline'}>
                      {lastOrderData.order_type === 'venda' ? 'Venda' : 
                       lastOrderData.order_type === 'troca' ? 'Troca' :
                       lastOrderData.order_type === 'amostra' ? 'Amostra' : 
                       lastOrderData.order_type || 'Não informado'}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Prazo de Pagamento</p>
                    <p className="font-semibold">
                      {lastOrderData.payment_due_date 
                        ? format(new Date(lastOrderData.payment_due_date), "dd/MM/yyyy", { locale: ptBR })
                        : 'Não informado'}
                    </p>
                  </div>
                  {lastOrderData.payment_condition && (
                    <div>
                      <p className="text-sm text-muted-foreground">Condição de Pagamento</p>
                      <p className="font-semibold">{lastOrderData.payment_condition}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    <Badge variant={lastOrderData.status === 'completed' || lastOrderData.status === 'delivered' ? 'default' : 'secondary'}>
                      {lastOrderData.status === 'completed' ? 'Concluído' : 
                       lastOrderData.status === 'delivered' ? 'Entregue' :
                       lastOrderData.status === 'pending' ? 'Pendente' :
                       lastOrderData.status === 'cancelled' ? 'Cancelado' : lastOrderData.status}
                    </Badge>
                  </div>
                </div>

                <div>
                  <h4 className="font-semibold mb-2 flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4" />
                    Itens do Pedido
                  </h4>
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Produto</TableHead>
                          <TableHead className="text-center">Qtd</TableHead>
                          <TableHead className="text-right">Preço Unit.</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(lastOrderData.products || []).map((item: any, index: number) => (
                          <TableRow key={index}>
                            <TableCell className="font-medium">{item.name || item.description || 'Produto'}</TableCell>
                            <TableCell className="text-center">{item.quantity}</TableCell>
                            <TableCell className="text-right">
                              R$ {Number(item.unitPrice || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              R$ {Number(item.totalPrice || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {lastOrderData.notes && (
                  <div>
                    <h4 className="font-semibold mb-2">Observações</h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">{lastOrderData.notes}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Nenhum pedido encontrado para este cliente.</p>
              </div>
            )}

            <DialogFooter className="flex gap-2">
              {lastOrderData && (
                <Button 
                  className="bg-purple-600 hover:bg-purple-700"
                  onClick={async () => {
                    if (!lastOrderCustomerId || !lastOrderData) return;
                    try {
                      const response = await fetch('/api/sales-cards/duplicate-from-order', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                          customerId: lastOrderCustomerId,
                          products: lastOrderData.products || [],
                          paymentMethod: lastOrderData.payment_method,
                          orderType: lastOrderData.order_type
                        })
                      });
                      if (!response.ok) throw new Error('Erro ao duplicar pedido');
                      const newCard = await response.json();
                      toast({ title: "Sucesso", description: "Pedido duplicado com sucesso! Abrindo card de vendas..." });
                      setShowLastOrderModal(false);
                      handleRowClick(lastOrderCustomerId);
                    } catch (error) {
                      toast({ variant: "destructive", title: "Erro", description: "Não foi possível duplicar o pedido." });
                    }
                  }}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicar Pedido
                </Button>
              )}
              <Button variant="outline" onClick={() => setShowLastOrderModal(false)}>
                Fechar
              </Button>
            </DialogFooter>
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

      {/* Dialog de Confirmação para Inativar Cliente */}
      <AlertDialog open={showInactivateDialog} onOpenChange={setShowInactivateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Inativar Cliente</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja inativar o cliente <strong>{customerToInactivate?.name}</strong>?
              <br /><br />
              Esta ação irá remover o cliente da lista de clientes ativos. O cliente poderá ser reativado posteriormente através de um novo upload de planilha.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setCustomerToInactivate(null)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmInactivate}
              className="bg-red-600 hover:bg-red-700"
              disabled={inactivateMutation.isPending}
            >
              {inactivateMutation.isPending ? "Inativando..." : "Inativar Cliente"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog Pedidos Pendentes Omie */}
      <Dialog open={showPendingOmieDialog} onOpenChange={(open) => { setShowPendingOmieDialog(open); if (!open) setSelectedCardIds(new Set()); }}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-orange-500" />
              Pedidos Pendentes de Envio ao Omie
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="flex-1 min-h-0">
            {isLoadingPendingOmie ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin mr-2" />
                <span>Verificando pedidos pendentes...</span>
              </div>
            ) : !pendingOmieData || (pendingOmieData.totalPending === 0) ? (
              <div className="text-center py-12 text-gray-500">
                <Send className="w-12 h-12 mx-auto mb-3 text-green-400" />
                <p className="text-lg font-medium">Nenhum pedido pendente!</p>
                <p className="text-sm">Todos os pedidos foram enviados ao Omie.</p>
              </div>
            ) : (
              <div className="space-y-4 pr-2">
                <div className="flex items-center justify-between p-3 bg-orange-50 rounded-lg border border-orange-200">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-orange-500 flex-shrink-0" />
                    <span className="text-sm text-orange-700 font-medium">
                      {pendingOmieData.totalPending} pedido(s) pendente(s) de envio
                    </span>
                  </div>
                  {selectedCardIds.size > 0 && (
                    <span className="text-sm font-semibold text-blue-700">
                      {selectedCardIds.size} selecionado(s)
                    </span>
                  )}
                </div>

                {pendingOmieData.pendingCards?.length > 0 && (
                  <div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={allSelected}
                              onCheckedChange={toggleSelectAll}
                              aria-label="Selecionar todos"
                              className={someSelected && !allSelected ? "opacity-60" : ""}
                            />
                          </TableHead>
                          <TableHead>Cliente</TableHead>
                          <TableHead>Vendedor</TableHead>
                          <TableHead>Valor</TableHead>
                          <TableHead>Data</TableHead>
                          <TableHead>Ação</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingOmieData.pendingCards.map((card: any) => (
                          <TableRow
                            key={card.id}
                            className={selectedCardIds.has(card.id) ? "bg-blue-50" : ""}
                          >
                            <TableCell>
                              <Checkbox
                                checked={selectedCardIds.has(card.id)}
                                onCheckedChange={() => toggleCard(card.id)}
                                aria-label={`Selecionar pedido de ${card.customerName}`}
                              />
                            </TableCell>
                            <TableCell className="font-medium text-sm">{card.customerName}</TableCell>
                            <TableCell className="text-sm">{card.sellerName}</TableCell>
                            <TableCell className="text-sm font-medium text-green-600">
                              R$ {parseFloat(card.saleValue || '0').toFixed(2)}
                            </TableCell>
                            <TableCell className="text-sm text-gray-500">
                              {card.createdAt ? new Date(card.createdAt).toLocaleDateString('pt-BR') : '-'}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                className="bg-blue-600 hover:bg-blue-700"
                                onClick={() => sendToOmieMutation.mutate(card.id)}
                                disabled={sendToOmieMutation.isPending || bulkSendMutation.isPending}
                              >
                                {sendToOmieMutation.isPending ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <>
                                    <Send className="w-3 h-3 mr-1" />
                                    Enviar
                                  </>
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {/* Bulk action footer - only shown when items are selected */}
          {selectedCardIds.size > 0 && (
            <div className="border-t pt-3 flex items-center justify-between gap-3 flex-shrink-0">
              <span className="text-sm text-gray-600 font-medium">
                {selectedCardIds.size} pedido(s) selecionado(s)
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="border-red-300 text-red-600 hover:bg-red-50"
                  onClick={() => bulkCancelMutation.mutate(Array.from(selectedCardIds))}
                  disabled={bulkCancelMutation.isPending || bulkSendMutation.isPending}
                >
                  {bulkCancelMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <X className="w-4 h-4 mr-2" />
                  )}
                  Cancelar Selecionados
                </Button>
                <Button
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={() => bulkSendMutation.mutate(Array.from(selectedCardIds))}
                  disabled={bulkSendMutation.isPending || bulkCancelMutation.isPending}
                >
                  {bulkSendMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Enviar Selecionados
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
