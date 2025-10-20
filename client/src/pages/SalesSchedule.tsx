import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import SalesCardDetailsModal from "@/components/SalesCardDetailsModal";
import SaleEditModal from "@/components/SaleEditModal";
import NoSaleModal from "@/components/NoSaleModal";
import {
  Calendar,
  Clock,
  MapPin,
  User,
  ChevronLeft,
  ChevronRight,
  Phone,
  Package,
  RefreshCw,
  Filter,
  Monitor,
  Sparkles,
  Download
} from "lucide-react";
import * as XLSX from 'xlsx';
import type { SalesCardWithRelations } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";

const DAYS_OF_WEEK = [
  { value: 'atrasados', label: '⚠️ Atrasados (>3 dias)' },
  { value: 'segunda', label: 'Segunda-feira' },
  { value: 'terca', label: 'Terça-feira' },
  { value: 'quarta', label: 'Quarta-feira' },
  { value: 'quinta', label: 'Quinta-feira' },
  { value: 'sexta', label: 'Sexta-feira' },
  { value: 'sabado', label: 'Sábado' },
  { value: 'domingo', label: 'Domingo' }
];

const RECURRENCE_LABELS = {
  'semanal': 'Semanal',
  'quinzenal': 'Quinzenal', 
  'trisemanal': 'Tri-semanal',
  'mensal': 'Mensal'
};

const STATUS_LABELS = {
  'pending': 'Pendente',
  'in_progress': 'Em Atendimento', 
  'completed': 'Finalizado',
  'no_sale': 'Não Vendeu',
  'failed': 'Fracassado'
};

const STATUS_COLORS = {
  'pending': 'bg-yellow-100 text-yellow-800 border-yellow-200',
  'in_progress': 'bg-blue-100 text-blue-800 border-blue-200',
  'completed': 'bg-green-100 text-green-800 border-green-200',
  'no_sale': 'bg-red-100 text-red-800 border-red-200',
  'failed': 'bg-gray-100 text-gray-800 border-gray-200'
};

const getWeekdaysLabel = (weekdays: string) => {
  try {
    const days = JSON.parse(weekdays);
    const dayLabels: Record<string, string> = {
      'segunda': 'Seg',
      'terca': 'Ter',
      'quarta': 'Qua',
      'quinta': 'Qui',
      'sexta': 'Sex',
      'sabado': 'Sáb',
      'domingo': 'Dom'
    };
    if (Array.isArray(days) && days.length > 0) {
      return days.map(d => dayLabels[d] || d).join(', ');
    }
    return 'Não definido';
  } catch {
    return weekdays || 'Não definido';
  }
};

export default function SalesSchedule() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [selectedDay, setSelectedDay] = useState('segunda');
  const [selectedSeller, setSelectedSeller] = useState<string>('all');
  const [startDate, setStartDate] = useState(() => {
    const today = new Date();
    today.setDate(today.getDate() - 7); // Última semana
    return today.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    const future = new Date();
    future.setDate(future.getDate() + 30); // Próximos 30 dias
    return future.toISOString().split('T')[0];
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedCard, setSelectedCard] = useState<SalesCardWithRelations | null>(null);
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isNoSaleModalOpen, setIsNoSaleModalOpen] = useState(false);

  // Buscar lista de vendedores (apenas para admin/coordinator/administrative)
  const { data: sellers } = useQuery({
    queryKey: ['/api/users'],
    queryFn: async () => {
      const params = new URLSearchParams({ role: 'vendedor' });
      const response = await fetch(`/api/users?${params}`);
      if (!response.ok) throw new Error('Failed to fetch sellers');
      return response.json();
    },
    enabled: user ? ['admin', 'coordinator', 'administrative'].includes(user.role) : false
  });

  // Mutation para gerar cards futuros
  const generateFutureCardsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/sales-cards/generate-future');
      return response;
    },
    onSuccess: (data) => {
      toast({
        title: "Cards gerados com sucesso!",
        description: `${data.stats.generated} cards criados para ${data.stats.processed} clientes. ${data.stats.skipped} pulados, ${data.stats.errors} erros.`,
        variant: "default"
      });
      refetch();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao gerar cards",
        description: error.message || "Ocorreu um erro ao gerar os cards futuros",
        variant: "destructive"
      });
    }
  });

  // Buscar cards por dia da semana ou cards atrasados
  const { data: cardsData, isLoading, refetch } = useQuery({
    queryKey: ['/api/sales-cards/by-day', selectedDay, selectedSeller, startDate, endDate, currentPage],
    queryFn: async () => {
      // Se "atrasados" for selecionado, usar endpoint específico
      if (selectedDay === 'atrasados') {
        const params = new URLSearchParams();
        if (selectedSeller !== 'all') {
          params.append('sellerId', selectedSeller);
        }
        const response = await fetch(`/api/sales-cards/critically-overdue?${params}`);
        if (!response.ok) throw new Error('Failed to fetch overdue cards');
        const cards = await response.json();
        return { cards, pagination: { hasMore: false } };
      }
      
      // Caso contrário, usar endpoint normal de busca por dia
      const params = new URLSearchParams({
        startDate,
        endDate,
        page: currentPage.toString(),
        limit: '1000'
      });
      
      if (selectedSeller !== 'all') {
        params.append('sellerId', selectedSeller);
      }
      
      const response = await fetch(`/api/sales-cards/by-day/${selectedDay}?${params}`);
      if (!response.ok) throw new Error('Failed to fetch cards');
      return response.json();
    },
    retry: false
  });

  const cards = cardsData?.cards || [];
  const pagination = cardsData?.pagination || { hasMore: false };

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDay, selectedSeller, startDate, endDate]);

  const handleCardClick = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setIsDetailsModalOpen(true);
  };

  const handleEditSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setIsEditModalOpen(true);
  };

  const handleNoSale = (card: SalesCardWithRelations) => {
    setSelectedCard(card);
    setIsNoSaleModalOpen(true);
  };

  const closeModals = () => {
    setSelectedCard(null);
    setIsDetailsModalOpen(false);
    setIsEditModalOpen(false);
    setIsNoSaleModalOpen(false);
    refetch();
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });
  };

  const formatCurrency = (value: number | string) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(numValue || 0);
  };

  const exportToExcel = async () => {
    try {
      toast({
        title: "Exportando...",
        description: "Buscando todos os registros filtrados",
        variant: "default"
      });

      // Buscar TODOS os cards com os filtros atuais (sem paginação)
      let allCards: SalesCardWithRelations[] = [];
      
      if (selectedDay === 'atrasados') {
        const params = new URLSearchParams();
        if (selectedSeller !== 'all') {
          params.append('sellerId', selectedSeller);
        }
        const response = await fetch(`/api/sales-cards/critically-overdue?${params}`);
        if (!response.ok) throw new Error('Failed to fetch overdue cards');
        allCards = await response.json();
      } else {
        // Buscar todos os cards sem limite de paginação
        const params = new URLSearchParams({
          startDate,
          endDate,
          limit: '10000' // Limite alto para pegar todos os cards
        });
        
        if (selectedSeller !== 'all') {
          params.append('sellerId', selectedSeller);
        }
        
        const response = await fetch(`/api/sales-cards/by-day/${selectedDay}?${params}`);
        if (!response.ok) throw new Error('Failed to fetch cards');
        const data = await response.json();
        allCards = data.cards;
      }

      if (!allCards || allCards.length === 0) {
        toast({
          title: "Nenhum dado para exportar",
          description: "Não há cards disponíveis com os filtros atuais",
          variant: "destructive"
        });
        return;
      }

      // Preparar dados para exportação
      const exportData = allCards.map((card: SalesCardWithRelations) => ({
        'Data Agendada': formatDate(card.scheduledDate),
        'Cliente': card.customer.fantasyName || card.customer.name,
        'Razão Social': card.customer.companyName || '-',
        'Telefone': card.customer.phone,
        'Endereço': card.customer.address,
        'Cidade': card.customer.city || '-',
        'Estado': card.customer.state || '-',
        'Vendedor': card.seller ? `${card.seller.firstName || ''} ${card.seller.lastName || ''}`.trim() || card.seller.email || '-' : '-',
        'Status': STATUS_LABELS[card.status as keyof typeof STATUS_LABELS],
        'Tipo de Recorrência': RECURRENCE_LABELS[card.recurrenceType as keyof typeof RECURRENCE_LABELS],
        'Dias da Semana': getWeekdaysLabel(card.customer.weekdays),
        'Valor da Venda': card.saleValue ? formatCurrency(card.saleValue) : '-',
        'Atendimento': card.customer.virtualService ? 'Virtual' : 'Presencial'
      }));

      // Criar workbook e worksheet
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Agenda de Vendas');

      // Ajustar largura das colunas
      const maxWidth = 50;
      const colWidths = Object.keys(exportData[0] || {}).map(key => ({
        wch: Math.min(
          Math.max(
            key.length,
            ...exportData.map(row => String(row[key as keyof typeof row] || '').length)
          ),
          maxWidth
        )
      }));
      ws['!cols'] = colWidths;

      // Gerar nome do arquivo
      const dayLabel = DAYS_OF_WEEK.find(d => d.value === selectedDay)?.label || 'Todos';
      const fileName = `agenda_vendas_${dayLabel.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;

      // Fazer download
      XLSX.writeFile(wb, fileName);

      toast({
        title: "Exportação concluída!",
        description: `${allCards.length} registros exportados para ${fileName}`,
        variant: "default"
      });
    } catch (error) {
      console.error('Error exporting to Excel:', error);
      toast({
        title: "Erro ao exportar",
        description: "Ocorreu um erro ao exportar os dados para Excel",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Agenda de Vendas</h1>
          <p className="text-gray-600">Visualize e gerencie os cards de vendas por dia da semana</p>
        </div>
        <div className="flex items-center space-x-2">
          {user && ['admin', 'coordinator', 'administrative'].includes(user.role) && (
            <Button
              onClick={() => generateFutureCardsMutation.mutate()}
              variant="default"
              size="sm"
              className="flex items-center space-x-2"
              disabled={generateFutureCardsMutation.isPending}
              data-testid="button-generate-future-cards"
            >
              <Sparkles className="h-4 w-4" />
              <span>
                {generateFutureCardsMutation.isPending ? 'Gerando...' : 'Gerar Cards Futuros'}
              </span>
            </Button>
          )}
          <Button
            onClick={exportToExcel}
            variant="outline"
            size="sm"
            className="flex items-center space-x-2"
            disabled={!cards || cards.length === 0}
            data-testid="button-export-excel"
          >
            <Download className="h-4 w-4" />
            <span>Exportar Excel</span>
          </Button>
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            className="flex items-center space-x-2"
            data-testid="button-refresh"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Atualizar</span>
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Filter className="h-5 w-5" />
            <span>Filtros</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <Label>Dia da Semana</Label>
              <Select value={selectedDay} onValueChange={setSelectedDay}>
                <SelectTrigger data-testid="select-day">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OF_WEEK.map(day => (
                    <SelectItem key={day.value} value={day.value}>
                      {day.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            {user && ['admin', 'coordinator', 'administrative'].includes(user.role) && (
              <div>
                <Label>Vendedor</Label>
                <Select value={selectedSeller} onValueChange={setSelectedSeller}>
                  <SelectTrigger data-testid="select-seller">
                    <SelectValue placeholder="Todos os vendedores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os vendedores</SelectItem>
                    {sellers?.map((seller: any) => (
                      <SelectItem key={seller.id} value={seller.id}>
                        {seller.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            
            <div>
              <Label>Data Inicial</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-start-date"
              />
            </div>
            
            <div>
              <Label>Data Final</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-end-date"
              />
            </div>

            <div className="flex items-end">
              <Button 
                onClick={() => refetch()}
                className="w-full"
                data-testid="button-apply-filters"
              >
                Aplicar Filtros
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lista de Cards */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Calendar className="h-5 w-5" />
              <span>
                {DAYS_OF_WEEK.find(d => d.value === selectedDay)?.label} - {cards.length} card(s)
              </span>
            </div>
            
            {/* Paginação */}
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                data-testid="button-previous-page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-gray-600">
                Página {currentPage}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => prev + 1)}
                disabled={!pagination.hasMore}
                data-testid="button-next-page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center items-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
              <span className="ml-2 text-gray-600">Carregando cards...</span>
            </div>
          ) : cards.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Calendar className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p>Nenhum card encontrado para os filtros selecionados</p>
            </div>
          ) : (
            <div className="space-y-4">
              {cards.map((card: SalesCardWithRelations) => (
                <div
                  key={card.id}
                  className="border rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => handleCardClick(card)}
                  data-testid={`card-sales-${card.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-2">
                        <div>
                          <h3 className="font-semibold text-lg" data-testid={`text-customer-${card.id}`}>
                            {card.customer.fantasyName || card.customer.name}
                          </h3>
                          {card.customer.fantasyName && card.customer.companyName && (
                            <p className="text-sm text-gray-500" data-testid={`text-company-${card.id}`}>
                              {card.customer.companyName}
                            </p>
                          )}
                        </div>
                        <Badge className={STATUS_COLORS[card.status as keyof typeof STATUS_COLORS]}>
                          {STATUS_LABELS[card.status as keyof typeof STATUS_LABELS]}
                        </Badge>
                        {card.customer?.virtualService ? (
                          <Badge variant="outline" className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600 dark:text-blue-400">
                            <Monitor className="h-3 w-3 mr-1" />
                            Virtual
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-green-600 bg-green-50 dark:bg-green-900/20">
                            <MapPin className="h-3 w-3 mr-1" />
                            Presencial
                          </Badge>
                        )}
                      </div>
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-600">
                        <div className="flex items-center space-x-2">
                          <User className="h-4 w-4" />
                          <span data-testid={`text-seller-${card.id}`}>
                            {card.seller ? `${card.seller.firstName || ''} ${card.seller.lastName || ''}`.trim() || card.seller.email || 'Sem vendedor' : 'Sem vendedor'}
                          </span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Phone className="h-4 w-4" />
                          <span>{card.customer.phone}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Calendar className="h-4 w-4" />
                          <span>{getWeekdaysLabel(card.customer.weekdays)}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Clock className="h-4 w-4" />
                          <span>{formatDate(card.scheduledDate)}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RefreshCw className="h-4 w-4" />
                          <span>{RECURRENCE_LABELS[card.recurrenceType as keyof typeof RECURRENCE_LABELS]}</span>
                        </div>
                        {(card.customer.latitude || card.customer.longitude) && (
                          <div className="flex items-center space-x-2">
                            <MapPin className="h-4 w-4 text-blue-600" />
                            <span className="text-xs" data-testid={`text-coordinates-${card.id}`}>
                              {card.customer.latitude && `${parseFloat(card.customer.latitude).toFixed(6)}`}
                              {card.customer.latitude && card.customer.longitude && ', '}
                              {card.customer.longitude && `${parseFloat(card.customer.longitude).toFixed(6)}`}
                            </span>
                          </div>
                        )}
                      </div>

                      {card.saleValue && (
                        <div className="mt-2 flex items-center space-x-2">
                          <Package className="h-4 w-4 text-green-600" />
                          <span className="font-semibold text-green-600">
                            {formatCurrency(card.saleValue)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center space-x-2">
                      {card.status === 'pending' && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditSale(card);
                            }}
                            data-testid={`button-finalize-${card.id}`}
                          >
                            Finalizar Venda
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleNoSale(card);
                            }}
                            className="text-red-600 hover:text-red-700"
                            data-testid={`button-no-sale-${card.id}`}
                          >
                            Não Vendeu
                          </Button>
                        </>
                      )}
                      
                      {card.status === 'in_progress' && (
                        <Button
                          size="sm"
                          className="bg-blue-500 hover:bg-blue-600"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditSale(card);
                          }}
                          data-testid={`button-continue-${card.id}`}
                        >
                          Continuar Venda
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modals */}
      <SalesCardDetailsModal
        isOpen={isDetailsModalOpen}
        onClose={closeModals}
        card={selectedCard}
        onStartSale={handleEditSale}
        onStartNoSale={handleNoSale}
      />

      <SaleEditModal
        isOpen={isEditModalOpen}
        onClose={closeModals}
        card={selectedCard}
      />

      <NoSaleModal
        isOpen={isNoSaleModalOpen}
        onClose={closeModals}
        card={selectedCard}
      />
    </div>
  );
}