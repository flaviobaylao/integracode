import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Phone, Clock, User, MapPin, CheckCircle, XCircle, Calendar, ArrowRight, AlertTriangle } from 'lucide-react';
import BackToDashboardButton from '@/components/BackToDashboardButton';

interface TelemarketingCard {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  scheduled_date: string;
  notes: string;
  telemarketing_notes?: string;
  products?: Array<{
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  sale_value?: string;
  status: string;
}

export default function TelemarketingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedCard, setSelectedCard] = useState<TelemarketingCard | null>(null);
  const [outcome, setOutcome] = useState<'completed' | 'reschedule' | ''>('');
  const [notes, setNotes] = useState('');
  const [rescheduleDate, setRescheduleDate] = useState('');

  // Buscar cards de telemarketing do usuário atual
  const { data: telemarketingCards = [], isLoading } = useQuery<TelemarketingCard[]>({
    queryKey: ['/api/telemarketing/my-cards'],
    refetchInterval: 30000 // Refresh a cada 30 segundos
  });

  // Processar cards em atraso (disponível para coordenadores/admins)
  const processOverdueMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/sales-cards/process-overdue', {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to process overdue cards');
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Cards em atraso processados",
        description: `${data.sentToTelemarketing} enviados para telemarketing, ${data.transferred} transferidos definitivamente`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/telemarketing/my-cards'] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    }
  });

  // Atualizar card de telemarketing
  const updateCardMutation = useMutation({
    mutationFn: async (data: { id: string; outcome: string; notes: string; rescheduleDate?: string }) => {
      const response = await fetch(`/api/telemarketing/cards/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to update card');
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Card atualizado com sucesso",
        description: "O card de telemarketing foi processado",
      });
      setSelectedCard(null);
      setOutcome('');
      setNotes('');
      setRescheduleDate('');
      queryClient.invalidateQueries({ queryKey: ['/api/telemarketing/my-cards'] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    }
  });

  const handleUpdateCard = () => {
    if (!selectedCard || !outcome) return;
    
    updateCardMutation.mutate({
      id: selectedCard.id,
      outcome,
      notes,
      rescheduleDate: outcome === 'reschedule' ? rescheduleDate : undefined
    });
  };

  const getStatusBadge = (status: string, notes: string) => {
    if (notes?.includes('TRANSFERIDO')) {
      return <Badge variant="secondary" className="bg-orange-100 text-orange-800">TRANSFERIDO</Badge>;
    }
    if (notes?.includes('RESGATE')) {
      return <Badge variant="destructive">RESGATE</Badge>;
    }
    return <Badge variant="outline">{status}</Badge>;
  };

  const calculateTotalValue = (products?: Array<any>) => {
    if (!products) return 0;
    return products.reduce((total, product) => total + product.totalPrice, 0);
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-32 bg-gray-200 rounded"></div>
          <div className="h-32 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Telemarketing</h1>
          <p className="text-gray-600">Gerencie cards de resgate e transferências de clientes</p>
        </div>
        
        <div className="flex items-center gap-2">
          <Button 
            onClick={() => processOverdueMutation.mutate()}
            disabled={processOverdueMutation.isPending}
            variant="outline"
            className="flex items-center gap-2"
          >
            <AlertTriangle className="h-4 w-4" />
            Processar Cards em Atraso
          </Button>
          <BackToDashboardButton />
        </div>
      </div>

      {/* Cards de Telemarketing */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Meus Cards ({telemarketingCards.length})
          </h2>
          
          {telemarketingCards.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8 text-gray-500">
                <Phone className="h-12 w-12 mb-4 opacity-50" />
                <p>Nenhum card de telemarketing no momento</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {telemarketingCards.map((card: TelemarketingCard) => (
                <Card 
                  key={card.id} 
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    selectedCard?.id === card.id ? 'ring-2 ring-blue-500 border-blue-500' : ''
                  }`}
                  onClick={() => setSelectedCard(card)}
                >
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">{card.customer_name}</h3>
                        {getStatusBadge(card.status, card.notes || '')}
                      </div>
                      <div className="text-right text-sm text-gray-500">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {format(new Date(card.scheduled_date), 'dd/MM/yyyy', { locale: ptBR })}
                        </div>
                      </div>
                    </div>
                    
                    <div className="space-y-1 text-sm text-gray-600">
                      <div className="flex items-center gap-2">
                        <Phone className="h-3 w-3" />
                        {card.customer_phone}
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-3 w-3" />
                        {card.customer_address}
                      </div>
                      {card.products && card.products.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Valor:</span>
                          R$ {calculateTotalValue(card.products).toFixed(2)}
                        </div>
                      )}
                    </div>
                    
                    {card.notes && (
                      <div className="mt-2 p-2 bg-gray-50 rounded text-xs text-gray-700">
                        {card.notes}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Painel de Atendimento */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <User className="h-5 w-5" />
            Atendimento
          </h2>
          
          {selectedCard ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  {selectedCard.customer_name}
                  {getStatusBadge(selectedCard.status, selectedCard.notes || '')}
                </CardTitle>
                <CardDescription>
                  Card de telemarketing - {format(new Date(selectedCard.scheduled_date), 'dd/MM/yyyy', { locale: ptBR })}
                </CardDescription>
              </CardHeader>
              
              <CardContent className="space-y-4">
                {/* Informações do Cliente */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-gray-500" />
                    <span>{selectedCard.customer_phone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-gray-500" />
                    <span>{selectedCard.customer_address}</span>
                  </div>
                </div>

                {/* Produtos */}
                {selectedCard.products && selectedCard.products.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-2">Produtos:</h4>
                    <div className="space-y-1 text-sm">
                      {selectedCard.products.map((product, index) => (
                        <div key={index} className="flex justify-between">
                          <span>{product.name} (x{product.quantity})</span>
                          <span>R$ {product.totalPrice.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="border-t pt-1 font-medium">
                        <div className="flex justify-between">
                          <span>Total:</span>
                          <span>R$ {calculateTotalValue(selectedCard.products).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Histórico de Observações */}
                {selectedCard.notes && (
                  <div>
                    <h4 className="font-medium mb-2">Observações:</h4>
                    <div className="p-2 bg-gray-50 rounded text-sm text-gray-700">
                      {selectedCard.notes}
                    </div>
                  </div>
                )}

                {/* Formulário de Atendimento */}
                <div className="space-y-4 border-t pt-4">
                  <div>
                    <Label htmlFor="outcome">Resultado do Contato</Label>
                    <Select value={outcome} onValueChange={(value) => setOutcome(value as 'completed' | 'reschedule' | '')}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione o resultado" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="completed">✓ Venda Realizada</SelectItem>
                        <SelectItem value="reschedule">📅 Reagendar</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {outcome === 'reschedule' && (
                    <div>
                      <Label htmlFor="reschedule-date">Nova Data</Label>
                      <Input
                        id="reschedule-date"
                        type="date"
                        value={rescheduleDate}
                        onChange={(e) => setRescheduleDate(e.target.value)}
                      />
                    </div>
                  )}

                  <div>
                    <Label htmlFor="notes">Observações do Atendimento</Label>
                    <Textarea
                      id="notes"
                      placeholder="Descreva o resultado do contato..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={3}
                    />
                  </div>

                  <Button 
                    onClick={handleUpdateCard}
                    disabled={!outcome || updateCardMutation.isPending}
                    className="w-full"
                  >
                    {updateCardMutation.isPending ? 'Salvando...' : 'Finalizar Atendimento'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8 text-gray-500">
                <ArrowRight className="h-12 w-12 mb-4 opacity-50 rotate-180" />
                <p>Selecione um card para iniciar o atendimento</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}