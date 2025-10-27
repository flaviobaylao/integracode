import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { XCircle, AlertTriangle } from "lucide-react";
import type { SalesCardWithRelations } from "@shared/schema";

interface NoSaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: SalesCardWithRelations | null;
}

export default function NoSaleModal({ isOpen, onClose, card }: NoSaleModalProps) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateCardMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/sales-cards/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      toast({
        title: "Sucesso",
        description: "Card marcado como 'Venda Não Realizada' com sucesso!",
      });
      onClose();
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setReason('');
    setNotes('');
    setIsSubmitting(false);
  };

  const handleSubmit = async () => {
    if (!reason) {
      toast({
        title: "Erro",
        description: "Selecione um motivo para a não venda.",
        variant: "destructive",
      });
      return;
    }

    if (!card) return;

    setIsSubmitting(true);
    try {
      await updateCardMutation.mutateAsync({
        id: card.id,
        data: {
          status: 'no_sale',
          noSaleReason: reason,
          notes: notes,
          completedDate: new Date()
        }
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getReasonLabel = (reasonValue: string) => {
    const reasons = {
      'sem_interesse': 'Cliente sem interesse',
      'sem_dinheiro': 'Cliente sem dinheiro',
      'fechado': 'Estabelecimento fechado',
      'outro_fornecedor': 'Já possui fornecedor',
      'produto_inadequado': 'Produto inadequado',
      'preco_alto': 'Preço muito alto',
      'nao_atendeu': 'Cliente não atendeu',
      'reagendado': 'Reagendado para outra data',
      'outro': 'Outro motivo'
    };
    return reasons[reasonValue as keyof typeof reasons] || reasonValue;
  };

  if (!card) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <XCircle className="h-6 w-6 text-red-600" />
            <span>Venda Não Realizada</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Informações do Cliente */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center space-x-2">
                <AlertTriangle className="h-5 w-5 text-orange-500" />
                <span>Registrar Motivo da Não Venda</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-4 p-3 bg-gray-50 rounded-lg">
                <p className="font-semibold">{card.customer.fantasyName || card.customer.name}</p>
                <p className="text-sm text-gray-600">{card.customer.phone}</p>
                <p className="text-sm text-gray-600">{card.customer.address}</p>
              </div>
            </CardContent>
          </Card>

          {/* Formulário de Não Venda */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="reason">Motivo da Não Venda *</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o motivo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sem_interesse">Cliente sem interesse</SelectItem>
                  <SelectItem value="sem_dinheiro">Cliente sem dinheiro</SelectItem>
                  <SelectItem value="fechado">Estabelecimento fechado</SelectItem>
                  <SelectItem value="outro_fornecedor">Já possui fornecedor</SelectItem>
                  <SelectItem value="produto_inadequado">Produto inadequado</SelectItem>
                  <SelectItem value="preco_alto">Preço muito alto</SelectItem>
                  <SelectItem value="nao_atendeu">Cliente não atendeu</SelectItem>
                  <SelectItem value="reagendado">Reagendado para outra data</SelectItem>
                  <SelectItem value="outro">Outro motivo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {reason && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm font-medium text-blue-800">
                  Motivo selecionado: {getReasonLabel(reason)}
                </p>
              </div>
            )}

            <div>
              <Label htmlFor="notes">Observações Adicionais</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Descreva detalhes sobre o motivo da não venda..."
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                Opcional: Adicione informações que possam ajudar em futuras abordagens
              </p>
            </div>
          </div>

          {/* Informações Importantes */}
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5" />
              <div>
                <p className="font-medium text-red-800">Importante:</p>
                <ul className="text-sm text-red-700 mt-1 space-y-1">
                  <li>• Este card será marcado como "Venda Não Realizada"</li>
                  <li>• As informações serão utilizadas para análise e melhorias</li>
                  <li>• Você pode reagendar uma nova visita posteriormente</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="flex justify-end space-x-3 pt-6 border-t">
          <Button 
            variant="outline" 
            onClick={() => {
              onClose();
              resetForm();
            }}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          
          <Button 
            onClick={handleSubmit}
            disabled={isSubmitting || !reason}
            className="bg-red-500 hover:bg-red-600"
          >
            {isSubmitting ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                Registrando...
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 mr-2" />
                Confirmar Não Venda
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}