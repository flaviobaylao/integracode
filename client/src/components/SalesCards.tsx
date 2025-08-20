import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import SalesCardModal from "./SalesCardModal";
import SalesCardFilters from "./SalesCardFilters";
import type { SalesCardWithRelations } from "@shared/schema";

export default function SalesCards() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [routeFilter, setRouteFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingCard, setEditingCard] = useState<SalesCardWithRelations | null>(null);
  const [actionDialog, setActionDialog] = useState<{
    type: 'sale' | 'no-sale' | null;
    card: SalesCardWithRelations | null;
  }>({ type: null, card: null });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Construir query string para filtros
  const buildQueryString = () => {
    const params = new URLSearchParams();
    if (routeFilter) params.append('route_day', routeFilter);
    if (statusFilter && statusFilter !== 'all') params.append('status', statusFilter);
    return params.toString() ? `?${params.toString()}` : '';
  };

  const { data: salesCards, isLoading } = useQuery({
    queryKey: ['/api/sales-cards', routeFilter, statusFilter],
    queryFn: () => fetch(`/api/sales-cards${buildQueryString()}`, { credentials: 'include' }).then(r => r.json()),
    retry: false,
  });

  const updateCardMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/sales-cards/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      setActionDialog({ type: null, card: null });
      toast({
        title: "Sucesso",
        description: "Card atualizado com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteCardMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/sales-cards/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Card excluído com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const duplicateCardMutation = useMutation({
    mutationFn: async ({ id, newDate }: { id: string; newDate: string }) => {
      await apiRequest('POST', `/api/sales-cards/${id}/duplicate`, { newDate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Card duplicado com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleStartService = (card: SalesCardWithRelations) => {
    updateCardMutation.mutate({
      id: card.id,
      data: { status: 'in_progress' }
    });
  };

  const handleFinalizeSale = (saleValue: number, notes?: string) => {
    if (!actionDialog.card) return;
    
    updateCardMutation.mutate({
      id: actionDialog.card.id,
      data: {
        status: 'completed',
        saleValue,
        completedDate: new Date(),
        notes
      }
    });
  };

  const handleMarkNoSale = (reason: string, notes?: string) => {
    if (!actionDialog.card) return;
    
    updateCardMutation.mutate({
      id: actionDialog.card.id,
      data: {
        status: 'no_sale',
        noSaleReason: reason,
        completedDate: new Date(),
        notes
      }
    });
  };

  const openWhatsApp = (phone: string, customerName: string) => {
    const message = encodeURIComponent(
      `Olá! Somos da Honest Sucos. Gostaria de agendar uma visita para apresentar nossos produtos frescos e naturais. Qual o melhor horário para você?`
    );
    const whatsappUrl = `https://wa.me/55${phone.replace(/\D/g, '')}?text=${message}`;
    window.open(whatsappUrl, '_blank');
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'in_progress':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
        return 'bg-blue-100 text-blue-800';
      case 'no_sale':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed':
        return 'Finalizado';
      case 'in_progress':
        return 'Em Atendimento';
      case 'pending':
        return 'Pendente';
      case 'no_sale':
        return 'Não Venda';
      default:
        return status;
    }
  };

  const filteredCards = salesCards?.filter((card: SalesCardWithRelations) => {
    if (statusFilter === 'all') return true;
    return card.status === statusFilter;
  }) || [];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-800">Cards de Venda</h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-32 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const clearAllFilters = () => {
    setRouteFilter('');
    setStatusFilter('all');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Cards de Venda</h2>
        <Button
          className="bg-honest-blue hover:bg-blue-700"
          onClick={() => setShowModal(true)}
        >
          <i className="fas fa-plus mr-2"></i>Novo Card
        </Button>
      </div>

      {/* Filtros */}
      <SalesCardFilters
        routeDay={routeFilter}
        status={statusFilter}
        onRouteChange={setRouteFilter}
        onStatusChange={setStatusFilter}
        onClearFilters={clearAllFilters}
      />

      {/* Sales Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredCards.length > 0 ? (
          filteredCards.map((card: SalesCardWithRelations) => (
            <Card key={card.id} className="overflow-hidden">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <Badge className={getStatusColor(card.status)}>
                    {getStatusLabel(card.status)}
                  </Badge>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingCard(card);
                        setShowModal(true);
                      }}
                    >
                      <i className="fas fa-edit"></i>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteCardMutation.mutate(card.id)}
                    >
                      <i className="fas fa-trash"></i>
                    </Button>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{card.customer.name}</h3>
                    <p className="text-sm text-gray-600">{card.customer.address}</p>
                  </div>
                  
                  <div className="flex items-center space-x-4 text-sm text-gray-600">
                    <div className="flex items-center space-x-1">
                      <i className="fas fa-calendar"></i>
                      <span>
                        {new Date(card.scheduledDate).toLocaleDateString('pt-BR')} às{' '}
                        {new Date(card.scheduledDate).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-1">
                    <i className="fas fa-phone text-gray-400"></i>
                    <span className="text-sm text-gray-600">{card.customer.phone}</span>
                  </div>

                  {card.saleValue && (
                    <div className="text-right">
                      <p className="text-sm font-medium text-green-600">
                        {new Intl.NumberFormat('pt-BR', {
                          style: 'currency',
                          currency: 'BRL',
                        }).format(parseFloat(card.saleValue))}
                      </p>
                    </div>
                  )}
                </div>
                
                <div className="mt-6">
                  {card.status === 'pending' && (
                    <div className="flex items-center space-x-3">
                      <Button
                        className="flex-1 bg-green-500 hover:bg-green-600 text-white"
                        onClick={() => openWhatsApp(card.customer.phone, card.customer.name)}
                      >
                        <i className="fab fa-whatsapp mr-2"></i>WhatsApp
                      </Button>
                      <Button
                        className="flex-1 bg-honest-blue hover:bg-blue-700"
                        onClick={() => handleStartService(card)}
                      >
                        Atender
                      </Button>
                    </div>
                  )}
                  
                  {card.status === 'in_progress' && (
                    <div className="flex items-center space-x-3">
                      <Button
                        className="flex-1 bg-green-500 hover:bg-green-600 text-white"
                        onClick={() => setActionDialog({ type: 'sale', card })}
                      >
                        <i className="fas fa-check mr-2"></i>Venda
                      </Button>
                      <Button
                        className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                        onClick={() => setActionDialog({ type: 'no-sale', card })}
                      >
                        <i className="fas fa-times mr-2"></i>Não Venda
                      </Button>
                    </div>
                  )}
                  
                  {card.status === 'completed' && (
                    <div className="flex items-center space-x-3">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => {
                          const nextWeek = new Date();
                          nextWeek.setDate(nextWeek.getDate() + 7);
                          duplicateCardMutation.mutate({
                            id: card.id,
                            newDate: nextWeek.toISOString()
                          });
                        }}
                      >
                        <i className="fas fa-copy mr-2"></i>Duplicar
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="col-span-full text-center py-12">
            <p className="text-gray-500">Nenhum card de venda encontrado</p>
          </div>
        )}
      </div>

      {/* Sale Dialog */}
      <Dialog open={actionDialog.type === 'sale'} onOpenChange={() => setActionDialog({ type: null, card: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finalizar Venda</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              const saleValue = parseFloat(formData.get('saleValue') as string);
              const notes = formData.get('notes') as string;
              handleFinalizeSale(saleValue, notes);
            }}
          >
            <div className="space-y-4">
              <div>
                <Label htmlFor="saleValue">Valor da Venda</Label>
                <Input
                  id="saleValue"
                  name="saleValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  required
                />
              </div>
              <div>
                <Label htmlFor="notes">Observações</Label>
                <Textarea
                  id="notes"
                  name="notes"
                  placeholder="Observações sobre a venda..."
                />
              </div>
              <div className="flex justify-end space-x-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActionDialog({ type: null, card: null })}
                >
                  Cancelar
                </Button>
                <Button type="submit" className="bg-green-500 hover:bg-green-600">
                  Finalizar Venda
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* No Sale Dialog */}
      <Dialog open={actionDialog.type === 'no-sale'} onOpenChange={() => setActionDialog({ type: null, card: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar como Não Venda</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              const reason = formData.get('reason') as string;
              const notes = formData.get('notes') as string;
              handleMarkNoSale(reason, notes);
            }}
          >
            <div className="space-y-4">
              <div>
                <Label htmlFor="reason">Motivo</Label>
                <Select name="reason" required>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o motivo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sem_interesse">Sem interesse</SelectItem>
                    <SelectItem value="sem_dinheiro">Sem dinheiro</SelectItem>
                    <SelectItem value="fechado">Estabelecimento fechado</SelectItem>
                    <SelectItem value="outro_fornecedor">Já tem fornecedor</SelectItem>
                    <SelectItem value="outro">Outro motivo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="notes">Observações</Label>
                <Textarea
                  id="notes"
                  name="notes"
                  placeholder="Detalhes sobre o motivo..."
                />
              </div>
              <div className="flex justify-end space-x-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActionDialog({ type: null, card: null })}
                >
                  Cancelar
                </Button>
                <Button type="submit" className="bg-red-500 hover:bg-red-600">
                  Confirmar
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sales Card Modal */}
      {showModal && (
        <SalesCardModal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingCard(null);
          }}
          editingCard={editingCard}
        />
      )}
    </div>
  );
}
