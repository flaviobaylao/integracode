import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
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
  Filter
} from "lucide-react";
import type { SalesCardWithRelations } from "@shared/schema";

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
  'no_sale': 'Não Vendeu'
};

const STATUS_COLORS = {
  'pending': 'bg-yellow-100 text-yellow-800 border-yellow-200',
  'in_progress': 'bg-blue-100 text-blue-800 border-blue-200',
  'completed': 'bg-green-100 text-green-800 border-green-200',
  'no_sale': 'bg-red-100 text-red-800 border-red-200'
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
  const [selectedDay, setSelectedDay] = useState('segunda');
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

  // Buscar cards por dia da semana ou cards atrasados
  const { data: cardsData, isLoading, refetch } = useQuery({
    queryKey: ['/api/sales-cards/by-day', selectedDay, startDate, endDate, currentPage],
    queryFn: async () => {
      // Se "atrasados" for selecionado, usar endpoint específico
      if (selectedDay === 'atrasados') {
        const response = await fetch('/api/sales-cards/critically-overdue');
        if (!response.ok) throw new Error('Failed to fetch overdue cards');
        const cards = await response.json();
        return { cards, pagination: { hasMore: false } };
      }
      
      // Caso contrário, usar endpoint normal de busca por dia
      const params = new URLSearchParams({
        startDate,
        endDate,
        page: currentPage.toString(),
        limit: '20'
      });
      
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
  }, [selectedDay, startDate, endDate]);

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
      year: 'numeric'
    });
  };

  const formatCurrency = (value: number | string) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(numValue || 0);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Agenda de Vendas</h1>
          <p className="text-gray-600">Visualize e gerencie os cards de vendas por dia da semana</p>
        </div>
        <Button
          onClick={() => refetch()}
          variant="outline"
          size="sm"
          className="flex items-center space-x-2"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Atualizar</span>
        </Button>
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
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label>Dia da Semana</Label>
              <Select value={selectedDay} onValueChange={setSelectedDay}>
                <SelectTrigger>
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
            
            <div>
              <Label>Data Inicial</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            
            <div>
              <Label>Data Final</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
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
                        <h3 className="font-semibold text-lg" data-testid={`text-customer-${card.id}`}>
                          {card.customer.name}
                        </h3>
                        <Badge className={STATUS_COLORS[card.status as keyof typeof STATUS_COLORS]}>
                          {STATUS_LABELS[card.status as keyof typeof STATUS_LABELS]}
                        </Badge>
                      </div>
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-600">
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
        onEditSale={handleEditSale}
        onNoSale={handleNoSale}
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