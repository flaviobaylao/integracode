import { useState, useEffect } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertSalesCardSchema, type SalesCardWithRelations, type CustomerWithSeller } from "@shared/schema";
import { z } from "zod";

interface SalesCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingCard: SalesCardWithRelations | null;
}

export default function SalesCardModal({ isOpen, onClose, editingCard }: SalesCardModalProps) {
  const [formData, setFormData] = useState({
    customerId: '',
    sellerId: '',
    scheduledDate: '',
    scheduledTime: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers } = useQuery({
    queryKey: ['/api/customers'],
    retry: false,
  });

  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  useEffect(() => {
    if (editingCard) {
      const scheduledDate = new Date(editingCard.scheduledDate);
      setFormData({
        customerId: editingCard.customerId,
        sellerId: editingCard.sellerId,
        scheduledDate: scheduledDate.toISOString().split('T')[0],
        scheduledTime: scheduledDate.toTimeString().slice(0, 5),
        notes: editingCard.notes || '',
      });
    } else {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const currentTime = now.toTimeString().slice(0, 5);
      
      setFormData({
        customerId: '',
        sellerId: currentUser?.id || '',
        scheduledDate: today,
        scheduledTime: currentTime,
        notes: '',
      });
    }
    setErrors({});
  }, [editingCard, currentUser, isOpen]);

  const createSalesCardMutation = useMutation({
    mutationFn: async (data: any) => {
      if (editingCard) {
        await apiRequest('PUT', `/api/sales-cards/${editingCard.id}`, data);
      } else {
        await apiRequest('POST', '/api/sales-cards', data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-cards'] });
      onClose();
      toast({
        title: "Sucesso",
        description: editingCard 
          ? "Card atualizado com sucesso!" 
          : "Card criado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    try {
      // Combine date and time into a single DateTime
      const scheduledDateTime = new Date(`${formData.scheduledDate}T${formData.scheduledTime}`);
      
      const dataToValidate = {
        customerId: formData.customerId,
        sellerId: formData.sellerId,
        scheduledDate: scheduledDateTime,
        status: editingCard?.status || 'pending',
        notes: formData.notes || undefined,
      };

      const validatedData = insertSalesCardSchema.parse(dataToValidate);
      createSalesCardMutation.mutate(validatedData);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            fieldErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(fieldErrors);
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editingCard ? 'Editar Card de Venda' : 'Novo Card de Venda'}
          </DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="customerId">Cliente *</Label>
            <Select 
              value={formData.customerId} 
              onValueChange={(value) => setFormData(prev => ({ ...prev, customerId: value }))}
            >
              <SelectTrigger className={errors.customerId ? "border-red-500" : ""}>
                <SelectValue placeholder="Selecione um cliente" />
              </SelectTrigger>
              <SelectContent>
                {customers?.map((customer: CustomerWithSeller) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.customerId && <p className="text-sm text-red-500 mt-1">{errors.customerId}</p>}
          </div>
          
          {currentUser?.role !== 'vendedor' && (
            <div>
              <Label htmlFor="sellerId">Vendedor Responsável *</Label>
              <Select 
                value={formData.sellerId} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, sellerId: value }))}
              >
                <SelectTrigger className={errors.sellerId ? "border-red-500" : ""}>
                  <SelectValue placeholder="Selecione um vendedor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={currentUser?.id || ''}>
                    {currentUser?.firstName} {currentUser?.lastName}
                  </SelectItem>
                </SelectContent>
              </Select>
              {errors.sellerId && <p className="text-sm text-red-500 mt-1">{errors.sellerId}</p>}
            </div>
          )}
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="scheduledDate">Data *</Label>
              <Input
                id="scheduledDate"
                type="date"
                value={formData.scheduledDate}
                onChange={(e) => setFormData(prev => ({ ...prev, scheduledDate: e.target.value }))}
                className={errors.scheduledDate ? "border-red-500" : ""}
              />
              {errors.scheduledDate && <p className="text-sm text-red-500 mt-1">{errors.scheduledDate}</p>}
            </div>
            
            <div>
              <Label htmlFor="scheduledTime">Horário *</Label>
              <Input
                id="scheduledTime"
                type="time"
                value={formData.scheduledTime}
                onChange={(e) => setFormData(prev => ({ ...prev, scheduledTime: e.target.value }))}
                className={errors.scheduledTime ? "border-red-500" : ""}
              />
              {errors.scheduledTime && <p className="text-sm text-red-500 mt-1">{errors.scheduledTime}</p>}
            </div>
          </div>
          
          <div>
            <Label htmlFor="notes">Observações</Label>
            <Textarea
              id="notes"
              rows={3}
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              className={errors.notes ? "border-red-500" : ""}
              placeholder="Observações sobre o atendimento..."
            />
            {errors.notes && <p className="text-sm text-red-500 mt-1">{errors.notes}</p>}
          </div>
          
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button 
              type="submit" 
              className="bg-honest-blue hover:bg-blue-700"
              disabled={createSalesCardMutation.isPending}
            >
              {createSalesCardMutation.isPending 
                ? 'Salvando...' 
                : editingCard ? 'Atualizar Card' : 'Criar Card'
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
