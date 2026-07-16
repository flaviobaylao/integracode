import { useState, useMemo, useEffect } from "react";
import { sortSellersByType } from "@/lib/sellerOrder";
import { useTableSort, SortableTh } from "@/lib/tableTools";
import { nowBrazil } from '@/lib/brazilTimezone';
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Users, Phone, MapPin, Plus, Edit, Trash2, Navigation, X, FileText, History, Download, CheckCircle, XCircle, Clock } from "lucide-react";
import * as XLSX from "xlsx";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Lead } from "@shared/schema";
import { formatInTimeZone } from "date-fns-tz";
import { ptBR } from "date-fns/locale";
import VirtualServiceLogModal from "@/components/VirtualServiceLogModal";
import LeadVisitHistoryModal from "@/components/LeadVisitHistoryModal";

export default function LeadsManagement() {
  const [isCreating, setIsCreating] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [selectedLeadForService, setSelectedLeadForService] = useState<Lead | null>(null);
  const [selectedLeadForVisitHistory, setSelectedLeadForVisitHistory] = useState<Lead | null>(null);
  // Desfecho do lead (Converter / Não Convertido / Prorrogar)
  const [converterLead, setConverterLead] = useState<Lead | null>(null);
  const [cust, setCust] = useState<any>({});
  const [naoConverterLead, setNaoConverterLead] = useState<Lead | null>(null);
  const [motivoNao, setMotivoNao] = useState<string>("");
  const [obsNao, setObsNao] = useState<string>("");
  const [prorrogarLead, setProrrogarLead] = useState<Lead | null>(null);
  const [novaDataProrrogar, setNovaDataProrrogar] = useState<string>("");
  // Ver justificativa de um lead não convertido (somente leitura)
  const [justificativaLead, setJustificativaLead] = useState<Lead | null>(null);
  const [formData, setFormData] = useState({
    fantasyName: "",
    latitude: "",
    longitude: "",
    contact: "",
    phone: "",
    observation: "",
    status: "pending" as const,
    assignedTo: "",
    temperature: "" as "" | "cold" | "warm" | "hot" | "very_hot",
  });

  // Filtros
  const [filterName, setFilterName] = useState("");
  const [filterSellerId, setFilterSellerId] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterNextContactFrom, setFilterNextContactFrom] = useState("");
  const [filterNextContactTo, setFilterNextContactTo] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: leads = [], isLoading, refetch, isError, error } = useQuery<Lead[]>({
    queryKey: ['/api/leads'],
  });

  // Debug: Log query state
  useEffect(() => {
    console.log('📋 [LeadsManagement] Query state:', { 
      isLoading, 
      isError, 
      error: error?.message,
      leadsCount: leads?.length 
    });
  }, [isLoading, isError, error, leads]);

  const { data: allUsers = [] } = useQuery<any[]>({
    queryKey: ['/api/users'],
  });

  const { data: currentUser } = useQuery<any>({
    queryKey: ['/api/auth/user'],
  });

  // Fetch last service logs for leads
  const { data: lastServiceLogs = {} } = useQuery<Record<string, { date: string; attendant: string; serviceType: string }>>({
    queryKey: ['/api/service-logs/last/lead'],
  });

  // Visitas do lead selecionado para ver a justificativa de não-conversão
  const { data: justVisits = [], isLoading: justLoading } = useQuery<any[]>({
    queryKey: ['/api/leads', justificativaLead?.id, 'visits'],
    enabled: !!justificativaLead,
  });

  // Filter vendors from users
  const sellers = useMemo(() => {
    return sortSellersByType((allUsers || []).filter((u: any) => u.role === 'vendedor' && u.isActive));
  }, [allUsers]);

  // Nome do vendedor por id (para a coluna Vendedor)
  const sellerNameById = useMemo(() => {
    const m = new Map<string, string>();
    (allUsers || []).forEach((u: any) => m.set(u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id));
    return (id: string | null | undefined) => (id ? (m.get(id) || '—') : '—');
  }, [allUsers]);

  const createLeadMutation = useMutation({
    mutationFn: async (data: any) => {
      return await apiRequest('POST', '/api/leads', {
        ...data,
        createdBy: currentUser?.id || 'system',
        createdByName: currentUser?.firstName ? `${currentUser.firstName} ${currentUser.lastName || ''}`.trim() : currentUser?.email || 'Sistema',
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      await refetch();
      setIsCreating(false);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Lead criado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar lead",
        variant: "destructive",
      });
    },
  });

  const updateLeadMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await apiRequest('PATCH', `/api/leads/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      setEditingLead(null);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Lead atualizado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar lead",
        variant: "destructive",
      });
    },
  });

  const deleteLeadMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest('DELETE', `/api/leads/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      toast({
        title: "Sucesso",
        description: "Lead deletado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao deletar lead",
        variant: "destructive",
      });
    },
  });

  // === Desfecho do lead ===
  const invalidateLeads = () => queryClient.invalidateQueries({ queryKey: ['/api/leads'] });

  const converterMut = useMutation({
    mutationFn: async () => apiRequest('POST', `/api/leads/${converterLead!.id}/convert-to-customer`, {
      name: cust.name,
      customerType: cust.customerType || 'pessoa_juridica',
      cpf: cust.cpf || null,
      cnpj: cust.cnpj || null,
      companyName: cust.companyName || null,
      phone: cust.phone,
      email: cust.email || null,
      address: cust.address,
      city: cust.city || null,
      state: cust.state || null,
      zipCode: cust.zipCode || null,
      neighborhood: cust.neighborhood || null,
      sellerId: converterLead!.assignedTo || null,
      weekdays: cust.weekdays || ['Seg'],
      visitPeriodicity: cust.visitPeriodicity || 'semanal',
    }),
    onSuccess: () => {
      toast({ title: "Lead convertido!", description: "Cliente ativo criado. Registre o primeiro pedido na Rota do Dia / Pedidos." });
      setConverterLead(null); setCust({});
      invalidateLeads();
    },
    onError: (e: any) => toast({ title: "Erro ao converter", description: e?.error || e?.message || "Verifique os dados", variant: "destructive" }),
  });

  const resgatarMut = useMutation({
    mutationFn: async (leadId: string) => apiRequest('POST', `/api/leads/${leadId}/desfecho`, { acao: 'resgatar' }),
    onSuccess: () => {
      toast({ title: "Lead resgatado", description: "Voltou para a lista como novo." });
      invalidateLeads();
    },
    onError: (e: any) => toast({ title: "Erro ao resgatar", description: e?.error || e?.message || "Erro", variant: "destructive" }),
  });

  const naoConverterMut = useMutation({
    mutationFn: async () => apiRequest('POST', `/api/leads/${naoConverterLead!.id}/desfecho`, { acao: 'nao_converter', motivo: motivoNao, observacao: obsNao }),
    onSuccess: () => {
      toast({ title: "Lead finalizado", description: "Registrado como NÃO CONVERTIDO." });
      setNaoConverterLead(null); setMotivoNao(""); setObsNao("");
      invalidateLeads();
    },
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Falha ao finalizar", variant: "destructive" }),
  });

  const prorrogarMut = useMutation({
    mutationFn: async () => apiRequest('POST', `/api/leads/${prorrogarLead!.id}/desfecho`, { acao: 'prorrogar', data: novaDataProrrogar }),
    onSuccess: () => {
      toast({ title: "Retorno prorrogado", description: "Nova data de visita registrada." });
      setProrrogarLead(null); setNovaDataProrrogar("");
      invalidateLeads();
    },
    onError: (e: any) => toast({ title: "Não foi possível prorrogar", description: e?.message || "Erro", variant: "destructive" }),
  });

  const openConverter = (lead: Lead) => {
    setCust({ name: lead.fantasyName, customerType: 'pessoa_juridica', phone: lead.phone || '', address: '', city: '', neighborhood: '', visitPeriodicity: 'semanal' });
    setConverterLead(lead);
  };
  const openProrrogar = (lead: Lead) => {
    const d = nowBrazil(); d.setDate(d.getDate() + 15);
    setNovaDataProrrogar(d.toISOString().slice(0, 10));
    setProrrogarLead(lead);
  };
  // Limites do date picker de prorrogação: amanhã até hoje+15
  const prorrogarMin = (() => { const d = nowBrazil(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
  const prorrogarMax = (() => { const d = nowBrazil(); d.setDate(d.getDate() + 15); return d.toISOString().slice(0, 10); })();

  const resetForm = () => {
    setFormData({
      fantasyName: "",
      latitude: "",
      longitude: "",
      contact: "",
      phone: "",
      observation: "",
      status: "pending",
      assignedTo: "",
      temperature: "",
    });
  };

  const handleCaptureLocation = () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Seu navegador não suporta geolocalização",
        variant: "destructive",
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({
          ...formData,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6)
        });
        toast({
          title: "Sucesso",
          description: "Localização capturada!",
        });
      },
      () => {
        toast({
          title: "Erro",
          description: "Não foi possível capturar a localização",
          variant: "destructive",
        });
      }
    );
  };

  const handleSubmit = () => {
    if (!formData.fantasyName || !formData.latitude || !formData.longitude) {
      toast({
        title: "Erro",
        description: "Nome fantasia, latitude e longitude são obrigatórios",
        variant: "destructive",
      });
      return;
    }

    if (!formData.temperature) {
      toast({
        title: "Erro",
        description: "Temperatura do lead é obrigatória",
        variant: "destructive",
      });
      return;
    }

    // 🔒 TRAVA: telefone válido é obrigatório para cadastrar um novo lead
    if (!editingLead) {
      const _leadDigits = (formData.phone || '').replace(/\D/g, '');
      if (_leadDigits.length < 10 || _leadDigits.length > 13) {
        toast({
          title: "Telefone do lead obrigatório",
          description: "Informe o telefone de contato (DDD + número) para cadastrar o lead.",
          variant: "destructive",
        });
        return;
      }
      const _leadFake = /^(\d)\1+$/.test(_leadDigits)
        || '01234567890123456789'.includes(_leadDigits)
        || '98765432109876543210'.includes(_leadDigits)
        || _leadDigits.includes('00000');
      if (_leadFake) {
        toast({
          title: "Telefone inválido",
          description: "Informe um número real. Números repetidos, sequências ou placeholders não são aceitos.",
          variant: "destructive",
        });
        return;
      }
    }

    if (editingLead) {
      updateLeadMutation.mutate({
        id: editingLead.id,
        data: formData
      });
    } else {
      createLeadMutation.mutate(formData);
    }
  };

  const handleEdit = (lead: Lead) => {
    setEditingLead(lead);
    setFormData({
      fantasyName: lead.fantasyName,
      latitude: lead.latitude.toString(),
      longitude: lead.longitude.toString(),
      contact: lead.contact || "",
      phone: lead.phone || "",
      observation: lead.observation || "",
      status: lead.status as any,
      assignedTo: lead.assignedTo || "",
      temperature: (lead.temperature || "") as "" | "cold" | "warm" | "hot" | "very_hot",
    });
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Tem certeza que deseja deletar este lead?")) {
      deleteLeadMutation.mutate(id);
    }
  };

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';
  const isVendedor = currentUser?.role === 'vendedor';
  const isTelemarketing = currentUser?.role === 'telemarketing';
  const canAct = isAdmin || isVendedor || isTelemarketing;

  const statusLabels: Record<string, string> = {
    pending: "Pendente",
    scheduled: "Agendado",
    visited: "Visitado",
    converted: "Convertido",
    discarded: "Descartado"
  };

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    scheduled: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    visited: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    converted: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    discarded: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
  };

  const temperatureLabels: Record<string, string> = {
    cold: "Frio",
    warm: "Morno",
    hot: "Quente",
    very_hot: "Muito Quente"
  };

  const exportToExcel = () => {
    const data = filteredLeads.map((lead) => ({
      "Nome": lead.fantasyName || "",
      "Contato": lead.contact || "",
      "Telefone": lead.phone || "",
      "Latitude": lead.latitude ? parseFloat(lead.latitude.toString()).toFixed(6) : "",
      "Longitude": lead.longitude ? parseFloat(lead.longitude.toString()).toFixed(6) : "",
      "Status": statusLabels[lead.status] || lead.status,
      "Temperatura": temperatureLabels[lead.temperature || ""] || "",
      "Observação": lead.observation || "",
      "Atribuído a": lead.assignedTo || "",
      "Criado por": lead.createdByName || "",
      "Próximo Contato": lead.nextContactDate ? formatInTimeZone(new Date(String(lead.nextContactDate)), "America/Sao_Paulo", "dd/MM/yyyy", { locale: ptBR }) : "",
      "Criado em": lead.createdAt ? formatInTimeZone(new Date(String(lead.createdAt)), "America/Sao_Paulo", "dd/MM/yyyy HH:mm", { locale: ptBR }) : "",
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads");
    ws["!cols"] = [
      { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 20 }, { wch: 20 },
      { wch: 16 }, { wch: 18 },
    ];
    XLSX.writeFile(wb, `leads_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast({ title: "Exportação concluída", description: `${data.length} leads exportados com sucesso.` });
  };

  const temperatureColors: Record<string, string> = {
    cold: "bg-blue-500",
    warm: "bg-yellow-500",
    hot: "bg-orange-500",
    very_hot: "bg-red-500"
  };

  // Base para estatísticas e lista: aplica TODOS os filtros (nome, vendedor,
  // datas de criação e de próximo contato), MAS mantém todos os status.
  // As caixas de "Desempenho por vendedor" usam esta base, então respeitam o
  // filtro por período (em branco = tudo, incluindo cadastros antigos).
  const statsBaseLeads = useMemo(() => {
    return (leads as any[]).filter(lead => {
      // Filtro por nome
      if (filterName && !lead.fantasyName.toLowerCase().includes(filterName.toLowerCase())) {
        return false;
      }

      // Filtro por vendedor
      if (filterSellerId && lead.assignedTo !== filterSellerId) {
        return false;
      }

      // Filtro por data de criação
      if (filterDateFrom || filterDateTo) {
        if (!lead.createdAt) return false;
        const createdDate = new Date(lead.createdAt);
        if (filterDateFrom) {
          const fromDate = new Date(filterDateFrom);
          if (createdDate < fromDate) return false;
        }
        if (filterDateTo) {
          const toDate = new Date(filterDateTo);
          toDate.setHours(23, 59, 59, 999);
          if (createdDate > toDate) return false;
        }
      }

      // Filtro por data do próximo contato
      if (filterNextContactFrom || filterNextContactTo) {
        if (!lead.nextContactDate) return false;
        const contactDate = new Date(String(lead.nextContactDate));
        if (filterNextContactFrom) {
          const fromDate = new Date(filterNextContactFrom);
          if (contactDate < fromDate) return false;
        }
        if (filterNextContactTo) {
          const toDate = new Date(filterNextContactTo);
          toDate.setHours(23, 59, 59, 999);
          if (contactDate > toDate) return false;
        }
      }

      return true;
    });
  }, [leads, filterName, filterSellerId, filterDateFrom, filterDateTo, filterNextContactFrom, filterNextContactTo]);

  // Lista da tabela: exclui convertidos (que saem da lista e contam apenas nas caixas)
  const filteredLeads = useMemo(() => {
    return statsBaseLeads.filter((lead: any) => lead.status !== 'converted');
  }, [statsBaseLeads]);

  const { sortKey, sortDir, toggleSort, sortRows } = useTableSort();
  const sortedLeads = sortRows(filteredLeads, (lead: any, key: string) => {
    switch (key) {
      case 'temp': return lead.temperature || '';
      case 'name': return lead.fantasyName || '';
      case 'contact': return lead.contact || '';
      case 'phone': return lead.phone || '';
      case 'coords': return lead.latitude != null ? Number(lead.latitude) : -Infinity;
      case 'status': return lead.status || '';
      case 'lastService': return lastServiceLogs[lead.id] && lastServiceLogs[lead.id].date ? new Date(lastServiceLogs[lead.id].date).getTime() : 0;
      case 'nextContact': return lead.nextContactDate ? new Date(lead.nextContactDate).getTime() : 0;
      case 'created': return lead.createdAt ? new Date(lead.createdAt).getTime() : 0;
      default: return '';
    }
  });

  // Não convertidos (descartados) vão para o FINAL da lista, preservando a ordenação dentro de cada grupo
  const displayLeads = [...sortedLeads].sort((a: any, b: any) => (a.status === 'discarded' ? 1 : 0) - (b.status === 'discarded' ? 1 : 0));

  const stats = {
    total: leads.length,
    pending: leads.filter(l => l.status === 'pending').length,
    scheduled: leads.filter(l => l.status === 'scheduled').length,
    visited: leads.filter(l => l.status === 'visited').length,
    converted: leads.filter(l => l.status === 'converted').length,
  };

  // Contagens por vendedor: Convertidos / Não Convertidos / Prorrogados
  const sellerStats = useMemo(() => {
    const nameById = new Map((allUsers || []).map((u: any) => [u.id, `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.id]));
    const byId: Record<string, { id: string; name: string; convertidos: number; naoConvertidos: number; prorrogados: number }> = {};
    for (const l of (statsBaseLeads as any[])) {
      const sid = l.assignedTo || 'sem_vendedor';
      if (!byId[sid]) byId[sid] = { id: sid, name: sid === 'sem_vendedor' ? 'Sem vendedor' : (nameById.get(sid) || 'Vendedor'), convertidos: 0, naoConvertidos: 0, prorrogados: 0 };
      if (l.status === 'converted') byId[sid].convertidos++;
      else if (l.status === 'discarded') byId[sid].naoConvertidos++;
      else if (Number(l.postponementCount || 0) >= 1) byId[sid].prorrogados++;
    }
    return Object.values(byId).sort((a, b) => a.name.localeCompare(b.name));
  }, [statsBaseLeads, allUsers]);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue"></div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="text-red-500 text-lg font-semibold">Erro ao carregar leads</div>
          <div className="text-gray-500 text-sm">{(error as any)?.message || 'Erro desconhecido'}</div>
          <pre className="text-xs text-gray-400 max-w-xl overflow-auto bg-gray-100 p-2 rounded">
            {JSON.stringify({ name: (error as any)?.name, status: (error as any)?.status, stack: (error as any)?.stack?.split?.('\n')?.slice(0, 3) }, null, 2)}
          </pre>
          <Button onClick={() => refetch()} variant="outline">
            Tentar novamente
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Gestão de Leads</h1>
          <p className="text-muted-foreground">
            Gerenciar leads de clientes em potencial
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BackToDashboardButton />
          <Button
            variant="outline"
            onClick={exportToExcel}
            disabled={filteredLeads.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Exportar Excel
          </Button>
          {(isAdmin || isVendedor || isTelemarketing) && (
            <Button
              onClick={() => setIsCreating(true)}
              data-testid="button-create-lead"
            >
              <Plus className="h-4 w-4 mr-2" />
              Novo Lead
            </Button>
          )}
        </div>
      </div>

      {/* Contagens por vendedor: Convertidos / Não Convertidos / Prorrogados */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-2">Desempenho por vendedor</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {sellerStats.length === 0 ? (
            <Card><CardContent className="py-6 text-sm text-muted-foreground">Nenhum lead atribuído.</CardContent></Card>
          ) : sellerStats.map((s) => (
            <Card key={s.id} data-testid={`seller-stats-${s.id}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 truncate">
                  <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate" title={s.name}>{s.name}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-xl font-bold text-green-600">{s.convertidos}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight">Convertidos</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold text-red-600">{s.naoConvertidos}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight">Não convert.</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold text-amber-600">{s.prorrogados}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight">Prorrogados</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label htmlFor="filter-name">Nome</Label>
              <Input
                id="filter-name"
                placeholder="Buscar por nome..."
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
                data-testid="input-filter-name"
              />
            </div>

            <div>
              <Label htmlFor="filter-seller">Vendedor</Label>
              <Select value={filterSellerId || "all"} onValueChange={(val) => setFilterSellerId(val === "all" ? "" : val)}>
                <SelectTrigger data-testid="select-filter-seller">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {sellers.map(seller => (
                    <SelectItem key={seller.id} value={seller.id}>
                      {seller.firstName} {seller.lastName || ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="filter-date-from">Data De</Label>
              <Input
                id="filter-date-from"
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                data-testid="input-filter-date-from"
              />
            </div>

            <div>
              <Label htmlFor="filter-date-to">Data Até</Label>
              <Input
                id="filter-date-to"
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                data-testid="input-filter-date-to"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
            <div>
              <Label htmlFor="filter-next-contact-from">Próx. Contato De</Label>
              <Input
                id="filter-next-contact-from"
                type="date"
                value={filterNextContactFrom}
                onChange={(e) => setFilterNextContactFrom(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="filter-next-contact-to">Próx. Contato Até</Label>
              <Input
                id="filter-next-contact-to"
                type="date"
                value={filterNextContactTo}
                onChange={(e) => setFilterNextContactTo(e.target.value)}
              />
            </div>
          </div>
          {(filterName || filterSellerId || filterDateFrom || filterDateTo || filterNextContactFrom || filterNextContactTo) && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                setFilterName("");
                setFilterSellerId("");
                setFilterDateFrom("");
                setFilterDateTo("");
                setFilterNextContactFrom("");
                setFilterNextContactTo("");
              }}
              data-testid="button-clear-filters"
            >
              <X className="h-4 w-4 mr-2" />
              Limpar Filtros
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Leads List Table */}
      <Card>
        <CardHeader>
          <CardTitle>Leads ({filteredLeads.filter((l: any) => l.status !== 'discarded').length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto max-h-[70vh] rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <SortableTh label="Temp." colKey="temp" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Nome" colKey="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Contato" colKey="contact" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Telefone" colKey="phone" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <th className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950">Vendedor</th>
                  <SortableTh label="Coordenadas" colKey="coords" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Status" colKey="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Criado em" colKey="created" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Último Atendimento" colKey="lastService" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  <SortableTh label="Próximo Contato" colKey="nextContact" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold sticky top-0 z-10 bg-white dark:bg-gray-950" />
                  {canAct && <th className="text-right py-3 px-4 font-semibold sticky top-0 right-0 z-20 bg-white dark:bg-gray-950">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {displayLeads.length === 0 ? (
                  <tr>
                    <td colSpan={canAct ? 11 : 10} className="text-center py-8 text-gray-500">
                      Nenhum lead encontrado com os filtros aplicados
                    </td>
                  </tr>
                ) : (
                  displayLeads.map((lead) => {
                    const descartado = lead.status === 'discarded';
                    return (
                    <tr
                      key={lead.id}
                      className={`border-b hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer ${descartado ? 'bg-gray-50/60 dark:bg-gray-900/40 text-gray-400 dark:text-gray-500' : ''}`}
                      data-testid={`lead-row-${lead.id}`}
                      onClick={() => descartado ? setJustificativaLead(lead) : setSelectedLeadForService(lead)}
                    >
                      <td className="py-3 px-4">
                        {lead.temperature ? (
                          <div
                            className={`w-4 h-4 rounded-full ${descartado ? 'bg-gray-300' : temperatureColors[lead.temperature]}`}
                            title={temperatureLabels[lead.temperature]}
                          />
                        ) : (
                          <div className="w-4 h-4 rounded-full bg-gray-300" title="Sem temperatura" />
                        )}
                      </td>
                      <td className={`py-3 px-4 font-medium ${descartado ? 'text-gray-400 dark:text-gray-500' : ''}`}>{lead.fantasyName}</td>
                      <td className="py-3 px-4">{lead.contact || '—'}</td>
                      <td className="py-3 px-4">{lead.phone ? <a href={`tel:${lead.phone}`} className={descartado ? 'text-gray-400' : 'text-blue-600 hover:underline'} onClick={(e) => e.stopPropagation()}>{lead.phone}</a> : '—'}</td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">{sellerNameById(lead.assignedTo)}</td>
                      <td className="py-3 px-4 text-xs text-gray-500 dark:text-gray-400">
                        <div className="flex flex-col gap-1">
                          <div>Lat: {parseFloat(lead.latitude.toString()).toFixed(6)}</div>
                          <div>Lon: {parseFloat(lead.longitude.toString()).toFixed(6)}</div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-col gap-1 items-start">
                          <Badge className={statusColors[lead.status]}>
                            {statusLabels[lead.status]}
                          </Badge>
                          {Number((lead as any).postponementCount || 0) >= 1 && lead.status !== 'discarded' && lead.status !== 'converted' && (
                            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Prorrogado</Badge>
                          )}
                          {descartado && (lead as any).nonConversionReason && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setJustificativaLead(lead); }}
                              title="Ver justificativa da não-conversão"
                              className="text-left"
                            >
                              <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 font-semibold cursor-pointer hover:bg-red-200 dark:hover:bg-red-800">Motivo: {(lead as any).nonConversionReason}</Badge>
                              <span className="block text-[10px] text-blue-600 dark:text-blue-400 underline mt-0.5">ver justificativa</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        {lead.createdAt ? formatInTimeZone(new Date(lead.createdAt), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '—'}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {lastServiceLogs[lead.id] ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium">
                              {formatInTimeZone(new Date(lastServiceLogs[lead.id].date), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                            </span>
                            <span className="text-gray-500 dark:text-gray-400 truncate max-w-[120px]" title={lastServiceLogs[lead.id].attendant}>
                              {lastServiceLogs[lead.id].attendant}
                            </span>
                          </div>
                        ) : '—'}
                      </td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        {(lead as any).nextContactDate ? (
                          <span className={`font-medium ${descartado ? 'text-gray-400' : (new Date((lead as any).nextContactDate) < nowBrazil() ? 'text-red-600' : 'text-green-600')}`}>
                            {formatInTimeZone(new Date((lead as any).nextContactDate), 'America/Sao_Paulo', 'dd/MM/yyyy', { locale: ptBR })}
                          </span>
                        ) : '—'}
                      </td>
                      {canAct && (
                        <td className="py-3 px-4 sticky right-0 bg-white dark:bg-gray-950" onClick={(e) => e.stopPropagation()}>
                          <div className="flex flex-nowrap gap-2 items-center justify-end">
                            {descartado ? (
                              <Button
                                size="sm"
                                className="bg-blue-600 hover:bg-blue-700 text-white"
                                disabled={resgatarMut.isPending}
                                onClick={() => { if (confirm('Resgatar este lead? Ele volta para a lista como novo, com os mesmos dados.')) resgatarMut.mutate(lead.id); }}
                                title="Resgatar (volta para a lista como novo)"
                                data-testid={`button-resgatar-lead-${lead.id}`}
                              >
                                <History className="h-4 w-4 mr-1" /> Resgatar
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  className="bg-green-600 hover:bg-green-700 text-white whitespace-nowrap"
                                  onClick={() => openConverter(lead)}
                                  title="Converter em cliente (cadastro + 1º pedido)"
                                  data-testid={`button-converter-lead-${lead.id}`}
                                >
                                  <CheckCircle className="h-4 w-4 mr-1" /> Converter
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="whitespace-nowrap"
                                  onClick={() => { setNaoConverterLead(lead); setMotivoNao(""); setObsNao(""); }}
                                  title="Não convertido (justificativa obrigatória)"
                                  data-testid={`button-naoconvertido-lead-${lead.id}`}
                                >
                                  <XCircle className="h-4 w-4 mr-1" /> Não Convertido
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="border-amber-400 text-amber-700 whitespace-nowrap"
                                  disabled={Number((lead as any).postponementCount || 0) >= 1 && !isAdmin}
                                  title={Number((lead as any).postponementCount || 0) >= 1 && !isAdmin ? "Prorrogação já utilizada — somente admin pode reagendar" : "Prorrogar (revisita, máx. 15 dias)"}
                                  onClick={() => openProrrogar(lead)}
                                  data-testid={`button-prorrogar-lead-${lead.id}`}
                                >
                                  <Clock className="h-4 w-4 mr-1" /> {Number((lead as any).postponementCount || 0) >= 1 ? "Prorrogado" : "Prorrogar"}
                                </Button>
                              </>
                            )}
                            {isAdmin && (
                              <>
                                <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => handleEdit(lead)} title="Editar lead" data-testid={`button-edit-lead-${lead.id}`}>
                                  <Edit className="h-4 w-4 mr-1" /> Editar
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setSelectedLeadForVisitHistory(lead)} title="Histórico de Visitas" data-testid={`button-history-lead-${lead.id}`}>
                                <History className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => handleDelete(lead.id)} title="Excluir" data-testid={`button-delete-lead-${lead.id}`}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                      )}
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={isCreating || !!editingLead} onOpenChange={(open) => {
        if (!open) {
          setIsCreating(false);
          setEditingLead(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingLead ? "Editar Lead" : "Novo Lead"}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="fantasyName">Nome Fantasia *</Label>
              <Input
                id="fantasyName"
                value={formData.fantasyName}
                onChange={(e) => setFormData({ ...formData, fantasyName: e.target.value })}
                placeholder="Nome do lead"
                data-testid="input-fantasy-name"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="latitude">Latitude *</Label>
                <Input
                  id="latitude"
                  type="number"
                  step="0.000001"
                  value={formData.latitude}
                  onChange={(e) => setFormData({ ...formData, latitude: e.target.value })}
                  placeholder="-3.745678"
                  data-testid="input-latitude"
                />
              </div>

              <div>
                <Label htmlFor="longitude">Longitude *</Label>
                <Input
                  id="longitude"
                  type="number"
                  step="0.000001"
                  value={formData.longitude}
                  onChange={(e) => setFormData({ ...formData, longitude: e.target.value })}
                  placeholder="-38.523456"
                  data-testid="input-longitude"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={handleCaptureLocation}
              className="w-full"
              data-testid="button-capture-location"
            >
              <Navigation className="h-4 w-4 mr-2" />
              Capturar Localização Atual
            </Button>

            <div>
              <Label htmlFor="contact">Contato</Label>
              <Input
                id="contact"
                value={formData.contact}
                onChange={(e) => setFormData({ ...formData, contact: e.target.value })}
                placeholder="Nome do contato"
                data-testid="input-contact"
              />
            </div>

            <div>
              <Label htmlFor="phone">Telefone *</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="(DDD) 9XXXX-XXXX"
                data-testid="input-phone"
              />
            </div>

            <div>
              <Label htmlFor="observation">Observação</Label>
              <Textarea
                id="observation"
                value={formData.observation}
                onChange={(e) => setFormData({ ...formData, observation: e.target.value })}
                placeholder="Observações sobre o lead"
                rows={3}
                data-testid="input-observation"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="temperature">Temperatura do Lead *</Label>
                <Select
                  value={formData.temperature}
                  onValueChange={(value: any) => setFormData({ ...formData, temperature: value })}
                >
                  <SelectTrigger data-testid="select-temperature">
                    <SelectValue placeholder="Selecione a temperatura" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cold">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-blue-500" />
                        Frio
                      </div>
                    </SelectItem>
                    <SelectItem value="warm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-yellow-500" />
                        Morno
                      </div>
                    </SelectItem>
                    <SelectItem value="hot">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-orange-500" />
                        Quente
                      </div>
                    </SelectItem>
                    <SelectItem value="very_hot">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-red-500" />
                        Muito Quente
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value: any) => setFormData({ ...formData, status: value })}
                >
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="scheduled">Agendado</SelectItem>
                    <SelectItem value="visited">Visitado</SelectItem>
                    <SelectItem value="converted">Convertido</SelectItem>
                    <SelectItem value="discarded">Descartado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor="assignedTo">Vendedor Responsável</Label>
              <Select
                value={formData.assignedTo || "all"}
                onValueChange={(value) => setFormData({ ...formData, assignedTo: value === "all" ? "" : value })}
              >
                <SelectTrigger data-testid="select-seller">
                  <SelectValue placeholder="Selecione um vendedor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Nenhum</SelectItem>
                  {sellers.map(seller => (
                    <SelectItem key={seller.id} value={seller.id} data-testid={`option-seller-${seller.id}`}>
                      {seller.firstName} {seller.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsCreating(false);
                  setEditingLead(null);
                  resetForm();
                }}
                data-testid="button-cancel"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createLeadMutation.isPending || updateLeadMutation.isPending}
                data-testid="button-save-lead"
              >
                {editingLead ? "Atualizar" : "Criar Lead"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {selectedLeadForService && (
        <VirtualServiceLogModal
          open={!!selectedLeadForService}
          onClose={() => setSelectedLeadForService(null)}
          customerId={selectedLeadForService.id}
          customerName={selectedLeadForService.fantasyName}
          defaultServiceType="prospecao"
          entityType="lead"
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/lead"] });
          }}
        />
      )}

      {selectedLeadForVisitHistory && (
        <LeadVisitHistoryModal
          open={!!selectedLeadForVisitHistory}
          onClose={() => setSelectedLeadForVisitHistory(null)}
          leadId={selectedLeadForVisitHistory.id}
          leadName={selectedLeadForVisitHistory.fantasyName}
          currentTemperature={selectedLeadForVisitHistory.temperature as any}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
          }}
        />
      )}

      {/* Dialog: Não Convertido (justificativa obrigatória) */}
      <Dialog open={!!naoConverterLead} onOpenChange={(o) => { if (!o) setNaoConverterLead(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Não convertido — justificativa</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{naoConverterLead?.fantasyName}</p>
            <div>
              <Label>Motivo da não-conversão *</Label>
              <Select value={motivoNao} onValueChange={setMotivoNao}>
                <SelectTrigger><SelectValue placeholder="Selecione o motivo" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="preco">Preço</SelectItem>
                  <SelectItem value="sem_interesse">Sem interesse</SelectItem>
                  <SelectItem value="ja_tem_fornecedor">Já tem fornecedor</SelectItem>
                  <SelectItem value="fechou">Fechou / encerrou</SelectItem>
                  <SelectItem value="sem_perfil">Sem perfil</SelectItem>
                  <SelectItem value="sem_contato">Sem contato</SelectItem>
                  <SelectItem value="outro">Outro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Justificativa / observação *</Label>
              <Textarea value={obsNao} onChange={(e) => setObsNao(e.target.value)} placeholder="Descreva o que aconteceu na visita" rows={3} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNaoConverterLead(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={!motivoNao || !obsNao.trim() || naoConverterMut.isPending} onClick={() => naoConverterMut.mutate()}>
              Confirmar não-conversão
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Ver justificativa da não-conversão (somente leitura) */}
      <Dialog open={!!justificativaLead} onOpenChange={(o) => { if (!o) setJustificativaLead(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Justificativa da não-conversão</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{justificativaLead?.fantasyName}</p>
            <div>
              <Label>Motivo</Label>
              <div className="mt-1">
                <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 font-semibold">
                  {(justificativaLead as any)?.nonConversionReason || '—'}
                </Badge>
              </div>
            </div>
            <div>
              <Label>Justificativa / observação</Label>
              {justLoading ? (
                <p className="text-sm text-muted-foreground mt-1">Carregando…</p>
              ) : (() => {
                const nv = (justVisits as any[])
                  .filter((v: any) => typeof v?.observation === 'string' && v.observation.includes('NÃO CONVERTIDO'))
                  .sort((a: any, b: any) => new Date(b?.visitDate || b?.createdAt || 0).getTime() - new Date(a?.visitDate || a?.createdAt || 0).getTime());
                const last = nv[0];
                if (!last) {
                  return <p className="text-sm text-muted-foreground mt-1">Nenhuma justificativa registrada.</p>;
                }
                const obs = String(last.observation);
                const detail = obs.includes(' - ') ? obs.slice(obs.indexOf(' - ') + 3) : obs;
                const when = last.visitDate || last.createdAt;
                return (
                  <div className="mt-1 space-y-1">
                    <p className="text-sm whitespace-pre-wrap rounded-md border p-3 bg-gray-50 dark:bg-gray-900">{detail}</p>
                    <p className="text-xs text-muted-foreground">
                      Registrado por {last.userName || '—'}
                      {when ? ` em ${formatInTimeZone(new Date(when), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm', { locale: ptBR })}` : ''}
                    </p>
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setJustificativaLead(null)}>Fechar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Prorrogar (revisita, máx. 15 dias) */}
      <Dialog open={!!prorrogarLead} onOpenChange={(o) => { if (!o) setProrrogarLead(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Prorrogar revisita</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{prorrogarLead?.fantasyName}</p>
            <div>
              <Label>Nova data da visita (máximo 15 dias)</Label>
              <Input type="date" value={novaDataProrrogar} min={prorrogarMin} max={prorrogarMax} onChange={(e) => setNovaDataProrrogar(e.target.value)} />
              <p className="text-[11px] text-muted-foreground mt-1">Permitido de {prorrogarMin.split('-').reverse().join('/')} até {prorrogarMax.split('-').reverse().join('/')}.</p>
            </div>
            {Number((prorrogarLead as any)?.postponementCount || 0) >= 1 && (
              <p className="text-xs text-amber-700">Este lead já foi prorrogado uma vez. Reagendamento permitido apenas para admin.</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setProrrogarLead(null)}>Cancelar</Button>
            <Button className="bg-amber-600 hover:bg-amber-700 text-white" disabled={!novaDataProrrogar || prorrogarMut.isPending} onClick={() => prorrogarMut.mutate()}>
              Confirmar prorrogação
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Converter em cliente (cadastro) */}
      <Dialog open={!!converterLead} onOpenChange={(o) => { if (!o) setConverterLead(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Converter em cliente ativo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome / Razão social *</Label>
              <Input value={cust.name || ""} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tipo *</Label>
                <Select value={cust.customerType || "pessoa_juridica"} onValueChange={(v) => setCust({ ...cust, customerType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pessoa_juridica">Pessoa Jurídica (CNPJ)</SelectItem>
                    <SelectItem value="pessoa_fisica">Pessoa Física (CPF)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{(cust.customerType || "pessoa_juridica") === "pessoa_fisica" ? "CPF" : "CNPJ"}</Label>
                <Input
                  value={(cust.customerType === "pessoa_fisica" ? cust.cpf : cust.cnpj) || ""}
                  onChange={(e) => setCust({ ...cust, [cust.customerType === "pessoa_fisica" ? "cpf" : "cnpj"]: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Telefone *</Label>
                <Input value={cust.phone || ""} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
              </div>
              <div>
                <Label>Periodicidade</Label>
                <Select value={cust.visitPeriodicity || "semanal"} onValueChange={(v) => setCust({ ...cust, visitPeriodicity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="semanal">Semanal</SelectItem>
                    <SelectItem value="quinzenal">Quinzenal</SelectItem>
                    <SelectItem value="mensal">Mensal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Endereço *</Label>
              <Input value={cust.address || ""} onChange={(e) => setCust({ ...cust, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Cidade</Label>
                <Input value={cust.city || ""} onChange={(e) => setCust({ ...cust, city: e.target.value })} />
              </div>
              <div>
                <Label>Bairro</Label>
                <Input value={cust.neighborhood || ""} onChange={(e) => setCust({ ...cust, neighborhood: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Após criar o cliente, registre o <strong>primeiro pedido</strong> pela Rota do Dia / Pedidos. Dias de visita padrão: Segunda.</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConverterLead(null)}>Cancelar</Button>
            <Button className="bg-green-600 hover:bg-green-700 text-white" disabled={!cust.name || !cust.phone || !cust.address || converterMut.isPending} onClick={() => converterMut.mutate()}>
              Converter em cliente
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
