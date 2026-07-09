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
import { Users, Phone, MapPin, Plus, Edit, Trash2, Navigation, X, FileText, History, Download } from "lucide-react";
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

  // Filter vendors from users
  const sellers = useMemo(() => {
    return sortSellersByType((allUsers || []).filter((u: any) => u.role === 'vendedor' && u.isActive));
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

  // Filtrar leads
  const filteredLeads = useMemo(() => {
    return leads.filter(lead => {
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

  const stats = {
    total: leads.length,
    pending: leads.filter(l => l.status === 'pending').length,
    scheduled: leads.filter(l => l.status === 'scheduled').length,
    visited: leads.filter(l => l.status === 'visited').length,
    converted: leads.filter(l => l.status === 'converted').length,
  };

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

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-honest-blue">{stats.total}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Agendados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.scheduled}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Visitados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">{stats.visited}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Convertidos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.converted}</div>
          </CardContent>
        </Card>
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
          <CardTitle>Leads ({filteredLeads.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <SortableTh label="Temp." colKey="temp" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Nome" colKey="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Contato" colKey="contact" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Telefone" colKey="phone" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Coordenadas" colKey="coords" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Status" colKey="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Último Atendimento" colKey="lastService" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Próximo Contato" colKey="nextContact" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  <SortableTh label="Criado em" colKey="created" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left py-3 px-4 font-semibold" />
                  {isAdmin && <th className="text-left py-3 px-4 font-semibold">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {sortedLeads.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 10 : 9} className="text-center py-8 text-gray-500">
                      Nenhum lead encontrado com os filtros aplicados
                    </td>
                  </tr>
                ) : (
                  sortedLeads.map((lead) => (
                    <tr 
                      key={lead.id} 
                      className="border-b hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer" 
                      data-testid={`lead-row-${lead.id}`}
                      onClick={() => setSelectedLeadForService(lead)}
                    >
                      <td className="py-3 px-4">
                        {lead.temperature ? (
                          <div 
                            className={`w-4 h-4 rounded-full ${temperatureColors[lead.temperature]}`}
                            title={temperatureLabels[lead.temperature]}
                          />
                        ) : (
                          <div className="w-4 h-4 rounded-full bg-gray-300" title="Sem temperatura" />
                        )}
                      </td>
                      <td className="py-3 px-4 font-medium">{lead.fantasyName}</td>
                      <td className="py-3 px-4">{lead.contact || '—'}</td>
                      <td className="py-3 px-4">{lead.phone ? <a href={`tel:${lead.phone}`} className="text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>{lead.phone}</a> : '—'}</td>
                      <td className="py-3 px-4 text-xs text-gray-600 dark:text-gray-400">
                        <div className="flex flex-col gap-1">
                          <div>Lat: {parseFloat(lead.latitude.toString()).toFixed(6)}</div>
                          <div>Lon: {parseFloat(lead.longitude.toString()).toFixed(6)}</div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <Badge className={statusColors[lead.status]}>
                          {statusLabels[lead.status]}
                        </Badge>
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
                      <td className="py-3 px-4 text-xs">
                        {(lead as any).nextContactDate ? (
                          <span className={`font-medium ${new Date((lead as any).nextContactDate) < nowBrazil() ? 'text-red-600' : 'text-green-600'}`}>
                            {formatInTimeZone(new Date((lead as any).nextContactDate), 'America/Sao_Paulo', 'dd/MM/yyyy', { locale: ptBR })}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {lead.createdAt ? formatInTimeZone(new Date(lead.createdAt), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '—'}
                      </td>
                      {isAdmin && (
                        <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedLeadForVisitHistory(lead)}
                              title="Histórico de Visitas"
                              data-testid={`button-history-lead-${lead.id}`}
                            >
                              <History className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedLeadForService(lead)}
                              title="Registrar Atendimento"
                              data-testid={`button-service-lead-${lead.id}`}
                            >
                              <FileText className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleEdit(lead)}
                              data-testid={`button-edit-lead-${lead.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDelete(lead.id)}
                              data-testid={`button-delete-lead-${lead.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
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
              <Label htmlFor="phone">Telefone</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="(85) 99999-9999"
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
    </div>
  );
}
