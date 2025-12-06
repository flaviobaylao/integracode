import { useState, useEffect, useMemo } from "react";
import { useMutation, useQueryClient, useQuery } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, ChevronsUpDown, Search, Truck, Clock, MapPin, Target } from "lucide-react";
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
    paymentMethod: 'a_vista',
    operationType: 'venda',
    deliveryWeekdays: [] as string[],
    deliveryTimeSlots: [] as string[],
    deliverySaturdayTimeSlots: [] as string[],
    boletoDays: 7,
    customerLatitude: '',
    customerLongitude: '',
    exclusiveVehicle: false,
    vehicleTypes: [] as string[],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customerOpen, setCustomerOpen] = useState(false);
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: customers } = useQuery<any[]>({
    queryKey: ['/api/customers', 'all'],
    retry: false,
    queryFn: async () => {
      const response = await fetch('/api/customers?allCustomers=true');
      if (!response.ok) throw new Error('Failed to fetch customers');
      return response.json();
    },
  });

  // O Command component gerencia a busca automaticamente
  const filteredCustomers = customers || [];

  // Encontrar cliente selecionado
  const selectedCustomer = customers?.find((c: any) => c.id === formData.customerId);

  // Pre-carregar localização do cliente quando selecionado
  useEffect(() => {
    if (selectedCustomer && (!editingCard)) { // Apenas para novos cards
      if (selectedCustomer.latitude && selectedCustomer.longitude) {
        setFormData(prev => ({
          ...prev,
          customerLatitude: selectedCustomer.latitude,
          customerLongitude: selectedCustomer.longitude,
        }));
      } else {
        setFormData(prev => ({
          ...prev,
          customerLatitude: '',
          customerLongitude: '',
        }));
      }
    }
  }, [selectedCustomer, editingCard]);

  const { data: currentUser } = useQuery({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  // Buscar todos os vendedores (apenas para usuários administrativos)
  const { data: allSellers } = useQuery({
    queryKey: ['/api/users'],
    retry: false,
    enabled: ['admin', 'coordinator', 'administrative'].includes((currentUser as any)?.role),
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
        routeDay: editingCard.routeDay || '',
        recurrenceType: editingCard.recurrenceType || 'semanal',
        paymentMethod: editingCard.paymentMethod || 'a_vista',
        operationType: editingCard.operationType || 'venda',
        deliveryWeekdays: (editingCard as any).deliveryWeekdays || ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'],
        deliveryTimeSlots: (editingCard as any).deliveryTimeSlots || ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
        deliverySaturdayTimeSlots: (editingCard as any).deliverySaturdayTimeSlots || [],
        boletoDays: (editingCard as any).boletoDays || 7,
        customerLatitude: (editingCard as any).customerLatitude || '',
        customerLongitude: (editingCard as any).customerLongitude || '',
        exclusiveVehicle: (editingCard as any).exclusiveVehicle || false,
        vehicleTypes: (editingCard as any).vehicleTypes || [],
      });
    } else {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const currentTime = now.toTimeString().slice(0, 5);
      
      setFormData({
        customerId: '',
        sellerId: (currentUser as any)?.id || '',
        scheduledDate: today,
        scheduledTime: currentTime,
        notes: '',
        routeDay: '',
        recurrenceType: 'semanal',
        paymentMethod: 'a_vista',
        operationType: 'venda',
        deliveryWeekdays: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'],
        deliveryTimeSlots: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
        deliverySaturdayTimeSlots: [],
        boletoDays: 7,
        customerLatitude: '',
        customerLongitude: '',
        exclusiveVehicle: false,
        vehicleTypes: [],
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

  // Função para capturar localização atual
  const captureCurrentLocation = async () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Geolocalização não é suportada pelo navegador.",
        variant: "destructive",
      });
      return;
    }

    setIsCapturingLocation(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData(prev => ({
          ...prev,
          customerLatitude: position.coords.latitude.toString(),
          customerLongitude: position.coords.longitude.toString(),
        }));
        toast({
          title: "Sucesso",
          description: "Localização capturada com sucesso!",
        });
        setIsCapturingLocation(false);
      },
      (error) => {
        let errorMessage = 'Erro desconhecido';
        switch(error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = "Permissão negada. Permita acesso à localização.";
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = "Localização indisponível.";
            break;
          case error.TIMEOUT:
            errorMessage = "Tempo esgotado para capturar localização.";
            break;
        }
        toast({
          title: "Erro de Localização",
          description: errorMessage,
          variant: "destructive",
        });
        setIsCapturingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000
      }
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    try {
      // Combine date and time into a single DateTime
      const scheduledDateTime = new Date(`${formData.scheduledDate}T${formData.scheduledTime}`);
      
      const dataToSubmit = {
        customerId: formData.customerId,
        sellerId: formData.sellerId,
        scheduledDate: scheduledDateTime.toISOString(),
        status: editingCard?.status || 'pending',
        notes: formData.notes || undefined,
        routeDay: formData.routeDay,
        recurrenceType: formData.recurrenceType,
        isRecurring: true,
        deliveryWeekdays: formData.deliveryWeekdays,
        deliveryTimeSlots: formData.deliveryTimeSlots,
        deliverySaturdayTimeSlots: formData.deliverySaturdayTimeSlots,
        boletoDays: formData.boletoDays,
        paymentMethod: formData.paymentMethod,
        operationType: formData.operationType,
        customerLatitude: formData.customerLatitude || null,
        customerLongitude: formData.customerLongitude || null,
        exclusiveVehicle: formData.exclusiveVehicle,
        vehicleTypes: formData.vehicleTypes,
      };

      // Não usar validação Zod aqui - deixar o backend validar
      createSalesCardMutation.mutate(dataToSubmit);
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

  // Dias da semana disponíveis
  const weekdays = [
    { value: 'Seg', label: 'Segunda-feira' },
    { value: 'Ter', label: 'Terça-feira' },
    { value: 'Qua', label: 'Quarta-feira' },
    { value: 'Qui', label: 'Quinta-feira' },
    { value: 'Sex', label: 'Sexta-feira' },
    { value: 'Sab', label: 'Sábado' },
    { value: 'Dom', label: 'Domingo' }
  ];

  // Horários disponíveis das 7h às 19h
  const timeSlots = [
    '07:00', '08:00', '09:00', '10:00', '11:00', '12:00',
    '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'
  ];

  // Função para gerenciar checkboxes de dias da semana
  const handleWeekdayChange = (weekday: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      deliveryWeekdays: checked 
        ? [...prev.deliveryWeekdays, weekday]
        : prev.deliveryWeekdays.filter(w => w !== weekday)
    }));
  };

  // Função para gerenciar checkboxes de horários
  const handleTimeSlotChange = (timeSlot: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      deliveryTimeSlots: checked 
        ? [...prev.deliveryTimeSlots, timeSlot]
        : prev.deliveryTimeSlots.filter(t => t !== timeSlot)
    }));
  };

  // Função para gerenciar checkboxes de horários de sábado
  const handleSaturdayTimeSlotChange = (timeSlot: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      deliverySaturdayTimeSlots: checked
        ? [...prev.deliverySaturdayTimeSlots, timeSlot]
        : prev.deliverySaturdayTimeSlots.filter(slot => slot !== timeSlot)
    }));
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
                    ? `${selectedCustomer.fantasyName || selectedCustomer.name} ${selectedCustomer.cnpj ? `(${selectedCustomer.cnpj})` : ''}`
                    : "Buscar cliente..."
                  }
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0">
                <Command>
                  <CommandInput 
                    placeholder="Buscar por nome, nome fantasia, documento..." 
                  />
                  <CommandList>
                    <CommandEmpty>Nenhum cliente encontrado.</CommandEmpty>
                    <CommandGroup>
                      {filteredCustomers.map((customer: any) => (
                        <CommandItem
                          key={customer.id}
                          value={`${customer.fantasyName || customer.name} ${customer.cnpj || ''} ${customer.phone || ''}`}
                          onSelect={() => {
                            setFormData(prev => ({ 
                              ...prev, 
                              customerId: customer.id
                            }));
                            setCustomerOpen(false);
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
                              {customer.cnpj && <span>{customer.cnpj} • </span>}
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
          
          {(currentUser as any)?.role !== 'vendedor' && (
            <div>
              <Label htmlFor="sellerId">Vendedor Responsável *</Label>
              <Select 
                value={formData.sellerId} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, sellerId: value }))}
                data-testid="select-seller"
              >
                <SelectTrigger className={errors.sellerId ? "border-red-500" : ""} data-testid="trigger-seller">
                  <SelectValue placeholder="Selecione um vendedor" />
                </SelectTrigger>
                <SelectContent>
                  {['admin', 'coordinator', 'administrative'].includes((currentUser as any)?.role) && allSellers ? (
                    // Mostrar todos os usuários que podem fazer vendas para administrativos
                    allSellers
                      .filter((seller: any) => ['vendedor', 'coordinator', 'administrative', 'admin'].includes(seller.role))
                      .map((seller: any) => (
                        <SelectItem key={seller.id} value={seller.id} data-testid={`option-seller-${seller.id}`}>
                          {seller.firstName} {seller.lastName} ({seller.email})
                        </SelectItem>
                      ))
                  ) : (
                    // Mostrar apenas o usuário atual para não-administrativos
                    (currentUser as any)?.id && (
                      <SelectItem value={(currentUser as any)?.id} data-testid="option-seller-current">
                        {(currentUser as any)?.firstName} {(currentUser as any)?.lastName}
                      </SelectItem>
                    )
                  )}
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
                  <SelectItem value="Seg">Segunda-feira</SelectItem>
                  <SelectItem value="Ter">Terça-feira</SelectItem>
                  <SelectItem value="Qua">Quarta-feira</SelectItem>
                  <SelectItem value="Qui">Quinta-feira</SelectItem>
                  <SelectItem value="Sex">Sexta-feira</SelectItem>
                  <SelectItem value="Sab">Sábado</SelectItem>
                  <SelectItem value="Dom">Domingo</SelectItem>
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

          {/* Método de Pagamento e Tipo de Operação */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="paymentMethod">Método de Pagamento *</Label>
              <Select 
                value={formData.paymentMethod} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, paymentMethod: value }))}
              >
                <SelectTrigger className={errors.paymentMethod ? "border-red-500" : ""}>
                  <SelectValue placeholder="Selecione o pagamento" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a_vista">À Vista</SelectItem>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="pix">PIX</SelectItem>
                </SelectContent>
              </Select>
              {errors.paymentMethod && <p className="text-sm text-red-500 mt-1">{errors.paymentMethod}</p>}
            </div>

            <div>
              <Label htmlFor="operationType">Tipo de Operação *</Label>
              <Select 
                value={formData.operationType} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, operationType: value }))}
              >
                <SelectTrigger className={errors.operationType ? "border-red-500" : ""}>
                  <SelectValue placeholder="Tipo da operação" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="venda">Venda</SelectItem>
                  <SelectItem value="troca">Troca</SelectItem>
                  <SelectItem value="amostra">Amostra</SelectItem>
                </SelectContent>
              </Select>
              {errors.operationType && <p className="text-sm text-red-500 mt-1">{errors.operationType}</p>}
            </div>
          </div>

          {/* Prazo para Boleto - Exibido apenas se método de pagamento for boleto */}
          {formData.paymentMethod === 'boleto' && (
            <div>
              <Label htmlFor="boletoDays">Prazo do Boleto (dias) *</Label>
              <Select 
                value={formData.boletoDays.toString()} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, boletoDays: parseInt(value) }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o prazo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 dias</SelectItem>
                  <SelectItem value="10">10 dias</SelectItem>
                  <SelectItem value="14">14 dias</SelectItem>
                  <SelectItem value="15">15 dias</SelectItem>
                  <SelectItem value="21">21 dias</SelectItem>
                  <SelectItem value="28">28 dias</SelectItem>
                  <SelectItem value="30">30 dias</SelectItem>
                  <SelectItem value="32">32 dias</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          
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

          {/* Configurações de Recebimento */}
          <div className="border-t border-gray-200 pt-6">
            <div className="mb-4">
              <div className="flex items-center space-x-2 mb-3">
                <Truck className="h-5 w-5 text-blue-600" />
                <Label className="text-base font-semibold">Configurações de Recebimento</Label>
              </div>
              
              {/* Dias da Semana */}
              <div className="mb-6">
                <Label className="text-sm font-medium mb-3 block">Dias da Semana para Recebimento</Label>
                <div className="grid grid-cols-2 gap-3">
                  {weekdays.map((day) => (
                    <div key={day.value} className="flex items-center space-x-2">
                      <Checkbox
                        id={`weekday-${day.value}`}
                        checked={formData.deliveryWeekdays.includes(day.value)}
                        onCheckedChange={(checked) => handleWeekdayChange(day.value, checked as boolean)}
                        data-testid={`checkbox-weekday-${day.value}`}
                      />
                      <Label 
                        htmlFor={`weekday-${day.value}`} 
                        className="text-sm font-normal cursor-pointer"
                      >
                        {day.label}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Horários de Recebimento */}
              <div>
                <div className="flex items-center space-x-2 mb-3">
                  <Clock className="h-4 w-4 text-blue-600" />
                  <Label className="text-sm font-medium">Horários Disponíveis para Recebimento</Label>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {timeSlots.map((time) => (
                    <div key={time} className="flex items-center space-x-2">
                      <Checkbox
                        id={`time-${time}`}
                        checked={formData.deliveryTimeSlots.includes(time)}
                        onCheckedChange={(checked) => handleTimeSlotChange(time, checked as boolean)}
                        data-testid={`checkbox-time-${time}`}
                      />
                      <Label 
                        htmlFor={`time-${time}`} 
                        className="text-xs font-normal cursor-pointer"
                      >
                        {time}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Horários de Sábado - Exibido apenas se sábado estiver selecionado */}
              {formData.deliveryWeekdays.includes('Sab') && (
                <div className="mt-6">
                  <div className="flex items-center space-x-2 mb-3">
                    <Clock className="h-4 w-4 text-purple-600" />
                    <Label className="text-sm font-medium">Horários aos Sábados</Label>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {timeSlots.map((time) => (
                      <div key={`saturday-${time}`} className="flex items-center space-x-2">
                        <Checkbox
                          id={`saturday-time-${time}`}
                          checked={formData.deliverySaturdayTimeSlots.includes(time)}
                          onCheckedChange={(checked) => handleSaturdayTimeSlotChange(time, checked as boolean)}
                          data-testid={`checkbox-saturday-time-${time}`}
                        />
                        <Label 
                          htmlFor={`saturday-time-${time}`} 
                          className="text-xs font-normal cursor-pointer"
                        >
                          {time} aos sábados
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Veículo Exclusivo - Somente Admin */}
              {(currentUser as any)?.role && ['admin', 'coordinator', 'administrative'].includes((currentUser as any).role) && (
                <div className="mt-6 border-t border-gray-200 pt-6">
                  <div className="flex items-center space-x-2 mb-4">
                    <Truck className="h-4 w-4 text-orange-600" />
                    <Label className="text-sm font-medium">Veículo Exclusivo (Somente Admin)</Label>
                  </div>
                  
                  <div className="flex items-center space-x-2 mb-4">
                    <Checkbox
                      id="exclusive-vehicle"
                      checked={formData.exclusiveVehicle}
                      onCheckedChange={(checked) => {
                        setFormData(prev => ({ 
                          ...prev, 
                          exclusiveVehicle: checked as boolean,
                          vehicleTypes: checked ? prev.vehicleTypes : []
                        }));
                      }}
                      data-testid="checkbox-exclusive-vehicle"
                    />
                    <Label 
                      htmlFor="exclusive-vehicle" 
                      className="text-sm font-normal cursor-pointer"
                    >
                      Recebimento em veículo exclusivo?
                    </Label>
                  </div>

                  {formData.exclusiveVehicle && (
                    <div className="ml-6">
                      <Label className="text-sm font-medium mb-3 block">Tipos de Veículos (máximo 2)</Label>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { value: 'caminhao', label: 'Caminhão' },
                          { value: 'carro', label: 'Carro' },
                          { value: 'moto', label: 'Moto' }
                        ].map((vehicle) => (
                          <div key={vehicle.value} className="flex items-center space-x-2">
                            <Checkbox
                              id={`vehicle-${vehicle.value}`}
                              checked={formData.vehicleTypes.includes(vehicle.value)}
                              onCheckedChange={(checked) => {
                                setFormData(prev => {
                                  const newVehicleTypes = checked 
                                    ? [...prev.vehicleTypes, vehicle.value]
                                    : prev.vehicleTypes.filter(v => v !== vehicle.value);
                                  
                                  // Limitar a 2 veículos
                                  if (newVehicleTypes.length > 2) {
                                    toast({
                                      title: "Limite excedido",
                                      description: "Selecione no máximo 2 tipos de veículos",
                                      variant: "destructive",
                                    });
                                    return prev;
                                  }
                                  
                                  return { ...prev, vehicleTypes: newVehicleTypes };
                                });
                              }}
                              data-testid={`checkbox-vehicle-${vehicle.value}`}
                            />
                            <Label 
                              htmlFor={`vehicle-${vehicle.value}`} 
                              className="text-sm font-normal cursor-pointer"
                            >
                              {vehicle.label}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Georreferenciamento do Cliente */}
          <div className="border-t border-gray-200 pt-6">
            <div className="mb-4">
              <div className="flex items-center space-x-2 mb-3">
                <MapPin className="h-5 w-5 text-green-600" />
                <Label className="text-base font-semibold">Localização do Cliente (Georreferenciamento)</Label>
              </div>
              
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <Label htmlFor="customerLatitude">Latitude</Label>
                  <Input
                    id="customerLatitude"
                    type="text"
                    value={formData.customerLatitude}
                    onChange={(e) => setFormData(prev => ({ ...prev, customerLatitude: e.target.value }))}
                    placeholder="Ex: -23.550520"
                    data-testid="input-latitude"
                  />
                </div>
                <div>
                  <Label htmlFor="customerLongitude">Longitude</Label>
                  <Input
                    id="customerLongitude"
                    type="text"
                    value={formData.customerLongitude}
                    onChange={(e) => setFormData(prev => ({ ...prev, customerLongitude: e.target.value }))}
                    placeholder="Ex: -46.633309"
                    data-testid="input-longitude"
                  />
                </div>
              </div>
              
              <Button
                type="button"
                variant="outline"
                onClick={captureCurrentLocation}
                disabled={isCapturingLocation}
                className="flex items-center space-x-2"
                data-testid="button-capture-location"
              >
                <Target className={`h-4 w-4 ${isCapturingLocation ? 'animate-pulse' : ''}`} />
                <span>
                  {isCapturingLocation ? 'Capturando...' : 'Capturar Localização Atual'}
                </span>
              </Button>
            </div>
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
