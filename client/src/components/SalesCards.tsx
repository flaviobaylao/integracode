import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { Monitor, MapPin, Upload, FileSpreadsheet, Trash2 } from "lucide-react";
import SalesCardModal from "./SalesCardModal";
import SalesCardFilters from "./SalesCardFilters";
import SaleModal from "./SaleModal";
import SalesCardDetailsModal from "./SalesCardDetailsModal";
import SaleEditModal from "./SaleEditModal";
import NoSaleModal from "./NoSaleModal";
import type { SalesCardWithRelations } from "@shared/schema";

export default function SalesCards() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [routeFilter, setRouteFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingCard, setEditingCard] = useState<SalesCardWithRelations | null>(null);
  const [actionDialog, setActionDialog] = useState<{
    type: 'sale' | 'no-sale' | null;
    card: SalesCardWithRelations | null;
  }>({ type: null, card: null });
  const [showSaleModal, setShowSaleModal] = useState(false);
  const [selectedCardForSale, setSelectedCardForSale] = useState<SalesCardWithRelations | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedCardForDetails, setSelectedCardForDetails] = useState<SalesCardWithRelations | null>(null);
  const [showSaleEditModal, setShowSaleEditModal] = useState(false);
  const [selectedCardForEdit, setSelectedCardForEdit] = useState<SalesCardWithRelations | null>(null);
  const [showNoSaleModal, setShowNoSaleModal] = useState(false);
  const [selectedCardForNoSale, setSelectedCardForNoSale] = useState<SalesCardWithRelations | null>(null);
  const [showBulkImportDialog, setShowBulkImportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Construir query string para filtros
  const buildQueryString = () => {
    const params = new URLSearchParams();
    if (routeFilter && routeFilter !== 'all') params.append('route_day', routeFilter);
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

  const sendToOmieMutation = useMutation({
    mutationFn: async (cardId: string) => {
      await apiRequest('POST', `/api/sales-cards/${cardId}/send-to-omie`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Pedido enviado para Omie com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro ao Enviar para Omie",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await fetch('/api/sales-cards/bulk-import', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao importar planilha');
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      setShowBulkImportDialog(false);
      setImportFile(null);
      
      let description = data.message;
      if (data.results?.errors?.length > 0) {
        description += `\n\nErros encontrados: ${data.results.errors.length}`;
      }
      
      toast({
        title: "Importação Concluída",
        description,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na Importação",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteAllCardsMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', '/api/sales-cards');
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      setShowDeleteAllDialog(false);
      toast({
        title: "Sucesso",
        description: `${data.deletedCount} cards foram eliminados com sucesso!`,
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

  const handleBulkImport = () => {
    if (!importFile) {
      toast({
        title: "Erro",
        description: "Selecione um arquivo para importar",
        variant: "destructive",
      });
      return;
    }
    
    bulkImportMutation.mutate(importFile);
  };

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

  const handleSendToOmie = (card: SalesCardWithRelations) => {
    if (!card.saleValue || parseFloat(card.saleValue) === 0) {
      toast({
        title: "Aviso",
        description: "Este card não possui uma venda registrada para enviar ao Omie.",
        variant: "destructive",
      });
      return;
    }
    sendToOmieMutation.mutate(card.id);
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
    // Filtro por status
    if (statusFilter !== 'all' && card.status !== statusFilter) {
      return false;
    }
    
    // Filtro por pesquisa (nome fantasia ou CNPJ)
    if (searchQuery) {
      const query = searchQuery.toLowerCase().trim();
      const customerName = card.customer?.name?.toLowerCase() || '';
      const customerCnpj = card.customer?.cnpj?.replace(/\D/g, '') || '';
      const searchQueryClean = query.replace(/\D/g, '');
      
      const matchesName = customerName.includes(query);
      const matchesCnpj = searchQueryClean.length > 0 && customerCnpj.includes(searchQueryClean);
      
      if (!matchesName && !matchesCnpj) {
        return false;
      }
    }
    
    return true;
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
    setRouteFilter('all');
    setStatusFilter('all');
    setSearchQuery('');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Cards de Venda</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setShowBulkImportDialog(true)}
            data-testid="button-bulk-import"
          >
            <Upload className="w-4 h-4 mr-2" />
            Importar Planilha
          </Button>
          {user && (user.role === 'admin' || user.role === 'administrative') && (
            <Button
              variant="destructive"
              onClick={() => setShowDeleteAllDialog(true)}
              data-testid="button-delete-all-cards"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Eliminar Todos os Cards
            </Button>
          )}
          <Button
            className="bg-honest-blue hover:bg-blue-700"
            onClick={() => setShowModal(true)}
          >
            <i className="fas fa-plus mr-2"></i>Novo Card
          </Button>
        </div>
      </div>

      {/* Campo de Pesquisa */}
      <div className="flex items-center gap-4">
        <div className="flex-1 max-w-md">
          <div className="relative">
            <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            <Input
              type="text"
              placeholder="Buscar por nome fantasia ou CNPJ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-customer"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                data-testid="button-clear-search"
              >
                <i className="fas fa-times"></i>
              </button>
            )}
          </div>
        </div>
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
            <Card 
              key={card.id} 
              className="overflow-hidden cursor-pointer hover:shadow-lg transition-shadow duration-200"
              onClick={() => {
                setSelectedCardForDetails(card);
                setShowDetailsModal(true);
              }}
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <Badge className={getStatusColor(card.status)}>
                      {getStatusLabel(card.status)}
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
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingCard(card);
                        setShowModal(true);
                      }}
                    >
                      <i className="fas fa-edit"></i>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteCardMutation.mutate(card.id);
                      }}
                    >
                      <i className="fas fa-trash"></i>
                    </Button>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-gray-800">{card.customer?.name || 'Cliente não encontrado'}</h3>
                    <p className="text-sm text-gray-600">{card.customer?.address || ''}</p>
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
                    <span className="text-sm text-gray-600">{card.customer?.phone || 'Telefone não disponível'}</span>
                  </div>

                  {/* Informações de Pagamento e Operação */}
                  <div className="flex items-center space-x-4 text-sm">
                    <div className="flex items-center space-x-1">
                      <i className="fas fa-credit-card text-blue-500"></i>
                      <span className="font-medium text-blue-600">
                        {card.paymentMethod === 'a_vista' && 'À Vista'}
                        {card.paymentMethod === 'boleto' && 'Boleto'}
                        {card.paymentMethod === 'pix' && 'PIX'}
                        {!card.paymentMethod && 'À Vista'}
                      </span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <i className="fas fa-tag text-purple-500"></i>
                      <span className="font-medium text-purple-600">
                        {card.operationType === 'venda' && 'Venda'}
                        {card.operationType === 'troca' && 'Troca'}
                        {card.operationType === 'amostra' && 'Amostra'}
                        {!card.operationType && 'Venda'}
                      </span>
                    </div>
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
                        onClick={(e) => {
                          e.stopPropagation();
                          openWhatsApp(card.customer.phone, card.customer.name);
                        }}
                      >
                        <i className="fab fa-whatsapp mr-2"></i>WhatsApp
                      </Button>
                      <Button
                        className="flex-1 bg-honest-blue hover:bg-blue-700"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartService(card);
                        }}
                      >
                        Atender
                      </Button>
                    </div>
                  )}
                  
                  
                  {card.status === 'completed' && (
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
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
                      {(!card.omieOrderId || card.omieOrderId === null || card.omieOrderId === '') && (
                        <Button
                          className="bg-orange-500 hover:bg-orange-600 text-white"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSendToOmie(card);
                          }}
                          disabled={sendToOmieMutation.isPending}
                        >
                          {sendToOmieMutation.isPending ? (
                            <i className="fas fa-spinner fa-spin mr-2"></i>
                          ) : (
                            <i className="fas fa-paper-plane mr-2"></i>
                          )}
                          Enviar Omie
                        </Button>
                      )}
                      {card.omieOrderId && card.omieOrderId !== null && card.omieOrderId !== '' && (
                        <Button
                          variant="outline"
                          className="text-green-600 border-green-600"
                          disabled
                        >
                          <i className="fas fa-check mr-2"></i>
                          Enviado
                        </Button>
                      )}
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

      {/* Sale Modal */}
      <SaleModal
        isOpen={showSaleModal}
        onClose={() => {
          setShowSaleModal(false);
          setSelectedCardForSale(null);
        }}
        salesCard={selectedCardForSale}
      />

      {/* Sales Card Details Modal */}
      <SalesCardDetailsModal
        isOpen={showDetailsModal}
        onClose={() => {
          setShowDetailsModal(false);
          setSelectedCardForDetails(null);
        }}
        card={selectedCardForDetails}
        onStartSale={(card) => {
          console.log('onStartSale called with card:', card.id);
          setShowDetailsModal(false);
          setSelectedCardForEdit(card);
          setShowSaleEditModal(true);
          console.log('Set showSaleEditModal to true');
        }}
        onStartNoSale={(card) => {
          setShowDetailsModal(false);
          setSelectedCardForNoSale(card);
          setShowNoSaleModal(true);
        }}
      />

      {/* Sale Edit Modal */}
      <SaleEditModal
        isOpen={showSaleEditModal}
        onClose={() => {
          setShowSaleEditModal(false);
          setSelectedCardForEdit(null);
        }}
        card={selectedCardForEdit}
      />

      {/* No Sale Modal */}
      <NoSaleModal
        isOpen={showNoSaleModal}
        onClose={() => {
          setShowNoSaleModal(false);
          setSelectedCardForNoSale(null);
        }}
        card={selectedCardForNoSale}
      />

      {/* Bulk Import Dialog */}
      <Dialog open={showBulkImportDialog} onOpenChange={setShowBulkImportDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5" />
              Importação em Massa de Cards
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-sm text-blue-900">Formato da Planilha</h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.open('/api/sales-cards/template', '_blank');
                  }}
                  className="text-xs"
                  data-testid="button-download-template"
                >
                  <FileSpreadsheet className="w-3 h-3 mr-1" />
                  Baixar Modelo
                </Button>
              </div>
              <p className="text-sm text-blue-800">
                A planilha deve conter as seguintes colunas:
              </p>
              <ul className="list-disc list-inside text-sm text-blue-800 space-y-1">
                <li><strong>ROTA</strong>: Dia da semana (SEGUNDA-FEIRA, TERÇA-FEIRA, etc.)</li>
                <li><strong>CNPJ/CPF</strong>: CNPJ do cliente (obrigatório)</li>
                <li><strong>Cliente (Nome Fantasia)</strong>: Nome do cliente</li>
                <li><strong>FREQUENCIA</strong>: SEMANAL, QUINZENAL ou MENSAL</li>
              </ul>
              <p className="text-xs text-blue-700 mt-2">
                💡 Se o CNPJ não existir no sistema, o cliente será cadastrado automaticamente via Receita Federal.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-file">Selecionar Arquivo</Label>
              <Input
                id="import-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setImportFile(file);
                }}
                data-testid="input-import-file"
              />
              {importFile && (
                <p className="text-sm text-gray-600">
                  Arquivo selecionado: {importFile.name}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowBulkImportDialog(false);
                  setImportFile(null);
                }}
                data-testid="button-cancel-import"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleBulkImport}
                disabled={!importFile || bulkImportMutation.isPending}
                className="bg-honest-blue hover:bg-blue-700"
                data-testid="button-confirm-import"
              >
                {bulkImportMutation.isPending ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>
                    Importando...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Importar
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete All Cards Confirmation Dialog */}
      <AlertDialog open={showDeleteAllDialog} onOpenChange={setShowDeleteAllDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tem certeza que deseja eliminar todos os cards?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. Todos os cards de vendas serão permanentemente eliminados do sistema.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-all">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAllCardsMutation.mutate()}
              disabled={deleteAllCardsMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete-all"
            >
              {deleteAllCardsMutation.isPending ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  Eliminando...
                </>
              ) : (
                'Eliminar Todos'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
