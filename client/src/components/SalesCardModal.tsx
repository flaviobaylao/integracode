import { useState, useEffect, useMemo } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertSalesCardSchema, type SalesCardWithRelations, type CustomerWithSeller } from "@shared/schema";
import { z } from "zod";
import { cn } from "@/lib/utils";

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
    routeDay: '',
    recurrenceType: 'semanal',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers } = useQuery({
    queryKey: ['/api/customers'],
    retry: false,
  });

  // Filtrar clientes baseado na busca
  const filteredCustomers = useMemo(() => {
    if (!customers) return [];
    if (!customerSearch) return customers;
    
    return customers.filter((customer: CustomerWithSeller) =>
      customer.name?.toLowerCase().includes(customerSearch.toLowerCase()) ||
      customer.fantasyName?.toLowerCase().includes(customerSearch.toLowerCase()) ||
      customer.document?.includes(customerSearch) ||
      customer.phone?.includes(customerSearch)
    );
  }, [customers, customerSearch]);

  // Encontrar cliente selecionado
  const selectedCustomer = customers?.find((c: CustomerWithSeller) => c.id === formData.customerId);

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
        routeDay: '',
        recurrenceType: 'semanal',
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
        routeDay: formData.routeDay,
        recurrenceType: formData.recurrenceType,
        isRecurring: true,
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
            <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={customerOpen}
                  className={cn(
                    "w-full justify-between",
                    errors.customerId ? "border-red-500" : ""
                  )}
                >
                  {selectedCustomer 
                    ? `${selectedCustomer.fantasyName || selectedCustomer.name} ${selectedCustomer.document ? `(${selectedCustomer.document})` : ''}`
                    : "Buscar cliente..."
                  }
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0">
                <Command>
                  <CommandInput 
                    placeholder="Buscar por nome, nome fantasia, documento..." 
                    value={customerSearch}
                    onValueChange={setCustomerSearch}
                  />
                  <CommandList>
                    <CommandEmpty>Nenhum cliente encontrado.</CommandEmpty>
                    <CommandGroup>
                      {filteredCustomers.map((customer: CustomerWithSeller) => (
                        <CommandItem
                          key={customer.id}
                          value={customer.id}
                          onSelect={(currentValue) => {
                            setFormData(prev => ({ 
                              ...prev, 
                              customerId: currentValue === formData.customerId ? "" : currentValue 
                            }));
                            setCustomerOpen(false);
                            setCustomerSearch('');
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              formData.customerId === customer.id ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <div className="flex flex-col">
                            <div className="font-medium">
                              {customer.fantasyName || customer.name}
                            </div>
                            <div className="text-sm text-gray-500">
                              {customer.name !== customer.fantasyName && customer.name && (
                                <span>{customer.name} • </span>
                              )}
                              {customer.document && <span>{customer.document} • </span>}
                              {customer.phone && <span>{customer.phone}</span>}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
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

          {/* Campos obrigatórios para recorrência */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="routeDay">Rota (Dia da Semana) *</Label>
              <Select 
                value={formData.routeDay} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, routeDay: value }))}
              >
                <SelectTrigger className={errors.routeDay ? "border-red-500" : ""}>
                  <SelectValue placeholder="Selecione o dia" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="segunda">Segunda-feira</SelectItem>
                  <SelectItem value="terca">Terça-feira</SelectItem>
                  <SelectItem value="quarta">Quarta-feira</SelectItem>
                  <SelectItem value="quinta">Quinta-feira</SelectItem>
                  <SelectItem value="sexta">Sexta-feira</SelectItem>
                  <SelectItem value="sabado">Sábado</SelectItem>
                  <SelectItem value="domingo">Domingo</SelectItem>
                </SelectContent>
              </Select>
              {errors.routeDay && <p className="text-sm text-red-500 mt-1">{errors.routeDay}</p>}
            </div>

            <div>
              <Label htmlFor="recurrenceType">Tipo de Recorrência *</Label>
              <Select 
                value={formData.recurrenceType} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, recurrenceType: value }))}
              >
                <SelectTrigger className={errors.recurrenceType ? "border-red-500" : ""}>
                  <SelectValue placeholder="Frequência" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="semanal">Semanal</SelectItem>
                  <SelectItem value="quinzenal">Quinzenal</SelectItem>
                  <SelectItem value="trisemanal">Trisemanal (3 semanas)</SelectItem>
                  <SelectItem value="mensal">Mensal</SelectItem>
                </SelectContent>
              </Select>
              {errors.recurrenceType && <p className="text-sm text-red-500 mt-1">{errors.recurrenceType}</p>}
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
