import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import { 
  Search, 
  Phone, 
  ArrowLeft, 
  Filter, 
  X,
  Calendar,
  Users,
  MessageCircle
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
import OmieInstanceBadge from "@/components/OmieInstanceBadge";

interface VirtualClient {
  id: string;
  document: string;
  documentType: string;
  fantasyNameImported: string | null;
  customerId: string | null;
  customer?: {
    id: string;
    name: string;
    fantasyName: string | null;
    phone: string;
    address: string;
    neighborhood: string | null;
    sellerId: string;
    sellerName?: string;
    virtualService: boolean;
    weekdays?: string;
    visitPeriodicity?: string;
  };
  nextThreeVisits: Array<{ date: string; status: string }>;
}

export default function VirtualClientsToday() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isTelemarketing = user?.role === 'telemarketing';
  
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSeller, setSelectedSeller] = useState("");
  const [selectedDayOfRoute, setSelectedDayOfRoute] = useState("");
  const [selectedPeriodicity, setSelectedPeriodicity] = useState("");
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedSalesCard, setSelectedSalesCard] = useState<any>(null);
  const [showSalesCardModal, setShowSalesCardModal] = useState(false);
  const [showSaleEditModal, setShowSaleEditModal] = useState(false);
  const [showNoSaleModal, setShowNoSaleModal] = useState(false);
  const [selectedCardForEdit, setSelectedCardForEdit] = useState<any>(null);
  const [selectedCardForNoSale, setSelectedCardForNoSale] = useState<any>(null);
  const { toast } = useToast();

  // Para telemarketing, NÃO inicializar filtro com seu próprio ID
  // Telemarketing deve ver TODOS os clientes virtuais por padrão
  // Remover auto-seleção que estava causando filtro incorreto

  const { data: activeCustomers = [], isLoading: isLoadingCustomers } = useQuery({
    queryKey: ['/api/active-customers'],
    queryFn: () => fetch('/api/active-customers').then(r => r.json()),
    refetchInterval: 30000,
  });

  // Buscar cards de venda da data selecionada
  const { data: salesCards = [] } = useQuery({
    queryKey: ['/api/sales-cards/by-date', selectedDate],
    queryFn: () => fetch(`/api/sales-cards/by-date/${selectedDate}`).then(r => r.json()).then(d => d.cards || []),
    enabled: !!selectedDate,
  });

  // Extrair vendedores únicos e dias da semana
  const sellers = useMemo(() => {
    const unique = new Map<string, { id: string; name: string }>();
    (activeCustomers as VirtualClient[]).forEach((ac) => {
      if (ac.customer?.sellerId && ac.customer?.sellerName) {
        unique.set(ac.customer.sellerId, {
          id: ac.customer.sellerId,
          name: ac.customer.sellerName,
        });
      }
    });
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [activeCustomers]);

  const daysOfRoute = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
  const periodicities = ["semanal", "quinzenal", "mensal"];

  // Filtrar apenas clientes virtuais com visitas para o dia selecionado
  const filteredClients = useMemo(() => {
    // Parse date string directly without timezone conversion
    // selectedDate formato: "2025-12-01"
    const todayStr = selectedDate;
    
    // Calcular dia da semana da data selecionada usando the date string
    const [yearStr, monthStr, dayStr] = selectedDate.split('-');
    const dateObj = new Date(parseInt(yearStr), parseInt(monthStr) - 1, parseInt(dayStr));
    const todayWeekday = daysOfRoute[dateObj.getDay() === 0 ? 6 : dateObj.getDay() - 1];

    return (activeCustomers as VirtualClient[]).filter((ac) => {
      // Apenas clientes virtuais
      if (!ac.customer?.virtualService) return false;

      // Tem visita agendada para o dia?
      const hasVisitToday = ac.nextThreeVisits?.some((v) => v.date === todayStr);
      if (!hasVisitToday) return false;

      // Filtro de busca
      if (
        searchTerm &&
        !ac.customer?.name?.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !ac.customer?.fantasyName?.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !ac.document?.includes(searchTerm)
      ) {
        return false;
      }

      // Filtro de vendedor
      if (selectedSeller && ac.customer?.sellerId !== selectedSeller) return false;

      // Filtro de dia da semana
      if (selectedDayOfRoute) {
        const weekdays = ac.customer?.weekdays;
        let weekdayArray: string[] = [];
        try {
          weekdayArray = Array.isArray(weekdays)
            ? weekdays
            : typeof weekdays === "string"
            ? JSON.parse(weekdays)
            : [];
        } catch {
          weekdayArray = [];
        }
        if (!weekdayArray.includes(selectedDayOfRoute)) return false;
      }

      // Filtro de periodicidade
      if (selectedPeriodicity && ac.customer?.visitPeriodicity !== selectedPeriodicity) {
        return false;
      }

      return true;
    });
  }, [activeCustomers, searchTerm, selectedSeller, selectedDayOfRoute, selectedPeriodicity, selectedDate, daysOfRoute]);

  const handleClearFilters = () => {
    setSearchTerm("");
    setSelectedSeller("");
    setSelectedDayOfRoute("");
    setSelectedPeriodicity("");
    setSelectedDate(format(new Date(), 'yyyy-MM-dd'));
  };

  const handleRowClick = (e: React.MouseEvent, client: VirtualClient) => {
    e.stopPropagation();
    if (!selectedDate) return;
    
    // Procurar card pelo customerId
    let card = salesCards?.find((c: any) => c.customerId === client.customerId);
    
    // Se não encontrou e o cliente tem customerId, tentar buscar pelo documento
    if (!card && client.document) {
      card = salesCards?.find((c: any) => c.document === client.document);
    }
    
    // Se não encontrou, criar card virtual a partir dos dados do cliente
    if (!card && client.customer) {
      card = {
        id: `virtual-${client.id}`,
        customerId: client.customerId || client.id,
        customerName: client.customer?.name || client.fantasyNameImported || 'Cliente',
        customerPhone: client.customer?.phone || '',
        document: client.document || '',
        address: client.customer?.address || '',
        sellerName: client.customer?.sellerName || '',
        sellerId: client.customer?.sellerId || '',
        scheduledDate: selectedDate,
        status: 'pending',
        items: [],
        totalValue: 0,
        notes: '',
        source: 'virtual-client'
      };
    }
    
    if (card) {
      setSelectedSalesCard(card);
      setShowSalesCardModal(true);
    } else {
      toast({
        title: "Erro ao abrir card",
        description: "Não foi possível abrir o card de vendas para este cliente",
        variant: "destructive"
      });
    }
  };

  const handleEditSale = (card: any) => {
    setSelectedCardForEdit(card);
    setShowSalesCardModal(false);
    setShowSaleEditModal(true);
  };

  const handleNoSale = (card: any) => {
    setSelectedCardForNoSale(card);
    setShowSalesCardModal(false);
    setShowNoSaleModal(true);
  };

  const handleWhatsAppClick = () => {
    navigate("/telemarketing/atendimento");
  };

  return (
    <div className="container mx-auto p-4 space-y-6">
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
      
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="page-title">
          <Phone className="h-6 w-6 text-blue-600" />
          Clientes Virtuais do Dia
        </h1>
        <p className="text-muted-foreground">
          Gerencie os atendimentos virtuais agendados para {(() => {
            const [yearStr, monthStr, dayStr] = selectedDate.split('-');
            const dateObj = new Date(parseInt(yearStr), parseInt(monthStr) - 1, parseInt(dayStr));
            return format(dateObj, "dd 'de' MMMM 'de' yyyy", { locale: ptBR });
          })()}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex flex-row items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar cliente..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-9"
                  data-testid="input-search"
                />
              </div>

              <Filter className="h-4 w-4 text-muted-foreground" />

              {!isTelemarketing && (
                <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                  <SelectTrigger className="w-[140px] h-9" data-testid="select-seller-filter">
                    <SelectValue placeholder="Vendedor" />
                  </SelectTrigger>
                  <SelectContent>
                    {sellers.map((seller) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

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

              <Select value={selectedPeriodicity} onValueChange={setSelectedPeriodicity}>
                <SelectTrigger className="w-[120px] h-9" data-testid="select-periodicity-filter">
                  <SelectValue placeholder="Período" />
                </SelectTrigger>
                <SelectContent>
                  {periodicities.map((period) => (
                    <SelectItem key={period} value={period}>
                      {period === "semanal"
                        ? "Semanal"
                        : period === "quinzenal"
                        ? "Quinzenal"
                        : "Mensal"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-[130px] h-9"
                data-testid="input-date-filter"
              />

              <Button
                variant="outline"
                size="sm"
                onClick={handleClearFilters}
                className="h-9"
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              {filteredClients.length} Cliente{filteredClients.length !== 1 ? "s" : ""} Virtual{filteredClients.length !== 1 ? "is" : ""} para Hoje
            </CardTitle>
            <Badge variant="secondary">
              <Calendar className="h-3 w-3 mr-1" />
              {format(new Date(selectedDate), "dd/MM/yyyy")}
            </Badge>
          </div>
        </CardHeader>
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
                    <TableHead>Nome</TableHead>
                    <TableHead>CPF/CNPJ</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Vendedor</TableHead>
                    <TableHead>Dia da Semana</TableHead>
                    <TableHead>Periodicidade</TableHead>
                    <TableHead>Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredClients.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        Nenhum cliente virtual agendado para este dia
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredClients.map((client) => (
                      <TableRow 
                        key={client.id} 
                        data-testid={`row-client-${client.id}`}
                        className="cursor-pointer hover:bg-muted transition-colors"
                        onClick={(e) => handleRowClick(e, client)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="font-medium">
                              {client.customer?.fantasyName || client.customer?.name || client.fantasyNameImported || "-"}
                            </div>
                            <OmieInstanceBadge instanceId={(client.customer as any)?.omieInstanceId} />
                          </div>
                          {client.customer?.address && (
                            <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                              {client.customer?.neighborhood}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {client.document || "-"}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {client.customer?.phone || "-"}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {client.customer?.sellerName || "-"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {Array.isArray(client.customer?.weekdays)
                              ? (client.customer?.weekdays as string[]).join(", ")
                              : client.customer?.weekdays || "-"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {client.customer?.visitPeriodicity === "semanal"
                              ? "Semanal"
                              : client.customer?.visitPeriodicity === "quinzenal"
                              ? "Quinzenal"
                              : client.customer?.visitPeriodicity === "mensal"
                              ? "Mensal"
                              : "-"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {client.customer?.phone && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const phone = client.customer!.phone.replace(/\D/g, '');
                                  const normalizedPhone = phone.startsWith('55') ? phone : `55${phone}`;
                                  window.location.href = `/telemarketing/atendimento?phone=${normalizedPhone}`;
                                }}
                                title="Abrir conversa no Chat Center"
                                data-testid={`button-chat-center-${client.id}`}
                              >
                                <MessageCircle className="h-4 w-4 text-green-600" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {e.stopPropagation(); handleWhatsAppClick();}}
                              title="Ligar via WhatsApp"
                              data-testid={`button-whatsapp-${client.id}`}
                            >
                              <Phone className="h-4 w-4" />
                            </Button>
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

      {/* Modal de detalhes do card de venda */}
      <SalesCardDetailsModal
        isOpen={showSalesCardModal}
        onClose={() => setShowSalesCardModal(false)}
        card={selectedSalesCard}
        onStartSale={handleEditSale}
        onStartNoSale={handleNoSale}
      />

      {/* Modal de edição de venda */}
      <SaleEditModal
        isOpen={showSaleEditModal}
        onClose={() => {
          setShowSaleEditModal(false);
          setSelectedCardForEdit(null);
        }}
        card={selectedCardForEdit}
      />

      {/* Modal de não venda */}
      <NoSaleModal
        isOpen={showNoSaleModal}
        onClose={() => {
          setShowNoSaleModal(false);
          setSelectedCardForNoSale(null);
        }}
        card={selectedCardForNoSale}
      />
    </div>
  );
}
