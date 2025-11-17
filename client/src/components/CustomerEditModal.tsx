import { useState, useEffect } from "react";
import { useMutation } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Customer } from "@shared/schema";
import { Loader2 } from "lucide-react";

interface CustomerEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
}

export default function CustomerEditModal({
  isOpen,
  onClose,
  customer,
}: CustomerEditModalProps) {
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    name: "",
    fantasyName: "",
    companyName: "",
    cpf: "",
    cnpj: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zipCode: "",
    latitude: "",
    longitude: "",
    weekdays: [] as string[],
    visitPeriodicity: "semanal" as "semanal" | "quinzenal" | "mensal" | "bimestral",
    exclusiveVehicle: false,
    vehicleTypes: [] as string[],
    deliveryWeekdays: [] as string[],
    deliveryTimeSlots: [] as string[],
    deliverySaturdayTimeSlots: [] as string[],
  });

  const updateCustomerMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      if (!customer?.id) throw new Error("Customer ID is required");
      return await apiRequest("PATCH", `/api/customers/${customer.id}`, data);
    },
    onSuccess: () => {
      toast({
        title: "Cliente atualizado com sucesso!",
        description: "As informações do cliente foram atualizadas.",
      });
      // Invalidate all sales-cards queries (including by-day queries with all parameters)
      queryClient.invalidateQueries({ 
        queryKey: ['/api/sales-cards'],
        refetchType: 'all'
      });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      onClose();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao atualizar cliente",
        description: error.message || "Ocorreu um erro ao atualizar o cliente",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateCustomerMutation.mutate(formData);
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const toggleWeekday = (day: string) => {
    setFormData((prev) => ({
      ...prev,
      weekdays: prev.weekdays.includes(day)
        ? prev.weekdays.filter((d) => d !== day)
        : [...prev.weekdays, day],
    }));
  };

  const handlePeriodicityChange = (value: string) => {
    setFormData((prev) => ({ 
      ...prev, 
      visitPeriodicity: value as "semanal" | "quinzenal" | "mensal" | "bimestral"
    }));
  };

  const toggleVehicleType = (type: string) => {
    setFormData((prev) => {
      const newTypes = prev.vehicleTypes.includes(type)
        ? prev.vehicleTypes.filter(v => v !== type)
        : [...prev.vehicleTypes, type];
      
      if (newTypes.length > 2) {
        toast({
          title: "Limite excedido",
          description: "Selecione no máximo 2 tipos de veículos",
          variant: "destructive",
        });
        return prev;
      }
      
      return { ...prev, vehicleTypes: newTypes };
    });
  };

  const toggleDeliveryWeekday = (day: string) => {
    setFormData((prev) => ({
      ...prev,
      deliveryWeekdays: prev.deliveryWeekdays.includes(day)
        ? prev.deliveryWeekdays.filter(d => d !== day)
        : [...prev.deliveryWeekdays, day]
    }));
  };

  const toggleDeliveryTimeSlot = (slot: string) => {
    setFormData((prev) => ({
      ...prev,
      deliveryTimeSlots: prev.deliveryTimeSlots.includes(slot)
        ? prev.deliveryTimeSlots.filter(s => s !== slot)
        : [...prev.deliveryTimeSlots, slot]
    }));
  };

  const toggleSaturdayTimeSlot = (slot: string) => {
    setFormData((prev) => ({
      ...prev,
      deliverySaturdayTimeSlots: prev.deliverySaturdayTimeSlots.includes(slot)
        ? prev.deliverySaturdayTimeSlots.filter(s => s !== slot)
        : [...prev.deliverySaturdayTimeSlots, slot]
    }));
  };

  // Update form data when customer changes
  useEffect(() => {
    if (customer) {
      // Parse weekdays from JSON string
      let parsedWeekdays: string[] = [];
      try {
        parsedWeekdays = typeof customer.weekdays === 'string' 
          ? JSON.parse(customer.weekdays) 
          : customer.weekdays || [];
      } catch (e) {
        console.error("Error parsing weekdays:", e);
        parsedWeekdays = [];
      }

      setFormData({
        name: customer.name || "",
        fantasyName: customer.fantasyName || "",
        companyName: customer.companyName || "",
        cpf: customer.cpf || "",
        cnpj: customer.cnpj || "",
        email: customer.email || "",
        phone: customer.phone || "",
        address: customer.address || "",
        city: customer.city || "",
        state: customer.state || "",
        zipCode: customer.zipCode || "",
        latitude: customer.latitude || "",
        longitude: customer.longitude || "",
        weekdays: parsedWeekdays,
        visitPeriodicity: customer.visitPeriodicity || "semanal",
        exclusiveVehicle: customer.exclusiveVehicle || false,
        vehicleTypes: Array.isArray(customer.vehicleTypes) ? customer.vehicleTypes : [],
        deliveryWeekdays: Array.isArray(customer.deliveryWeekdays) ? customer.deliveryWeekdays : [],
        deliveryTimeSlots: Array.isArray(customer.deliveryTimeSlots) ? customer.deliveryTimeSlots : [],
        deliverySaturdayTimeSlots: Array.isArray(customer.deliverySaturdayTimeSlots) ? customer.deliverySaturdayTimeSlots : [],
      });
    }
  }, [customer]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar Dados do Cliente</DialogTitle>
          <DialogDescription>
            Atualize as informações cadastrais do cliente
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Nome e Nome Fantasia */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Nome / Razão Social *</Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
                data-testid="input-customer-name"
              />
            </div>
            <div>
              <Label htmlFor="fantasyName">Nome Fantasia</Label>
              <Input
                id="fantasyName"
                name="fantasyName"
                value={formData.fantasyName}
                onChange={handleChange}
                data-testid="input-customer-fantasy-name"
              />
            </div>
          </div>

          {/* CPF/CNPJ */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="cpf">CPF</Label>
              <Input
                id="cpf"
                name="cpf"
                value={formData.cpf}
                onChange={handleChange}
                data-testid="input-customer-cpf"
              />
            </div>
            <div>
              <Label htmlFor="cnpj">CNPJ</Label>
              <Input
                id="cnpj"
                name="cnpj"
                value={formData.cnpj}
                onChange={handleChange}
                data-testid="input-customer-cnpj"
              />
            </div>
          </div>

          {/* Contato */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                data-testid="input-customer-email"
              />
            </div>
            <div>
              <Label htmlFor="phone">Telefone *</Label>
              <Input
                id="phone"
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                required
                data-testid="input-customer-phone"
              />
            </div>
          </div>

          {/* Endereço */}
          <div>
            <Label htmlFor="address">Endereço</Label>
            <Input
              id="address"
              name="address"
              value={formData.address}
              onChange={handleChange}
              data-testid="input-customer-address"
            />
          </div>

          {/* Cidade, Estado, CEP */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="city">Cidade</Label>
              <Input
                id="city"
                name="city"
                value={formData.city}
                onChange={handleChange}
                data-testid="input-customer-city"
              />
            </div>
            <div>
              <Label htmlFor="state">Estado</Label>
              <Input
                id="state"
                name="state"
                value={formData.state}
                onChange={handleChange}
                maxLength={2}
                data-testid="input-customer-state"
              />
            </div>
            <div>
              <Label htmlFor="zipCode">CEP</Label>
              <Input
                id="zipCode"
                name="zipCode"
                value={formData.zipCode}
                onChange={handleChange}
                data-testid="input-customer-zip-code"
              />
            </div>
          </div>

          {/* Coordenadas Geográficas */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="latitude">Latitude</Label>
              <Input
                id="latitude"
                name="latitude"
                value={formData.latitude}
                onChange={handleChange}
                placeholder="-23.550520"
                data-testid="input-customer-latitude"
              />
            </div>
            <div>
              <Label htmlFor="longitude">Longitude</Label>
              <Input
                id="longitude"
                name="longitude"
                value={formData.longitude}
                onChange={handleChange}
                placeholder="-46.633308"
                data-testid="input-customer-longitude"
              />
            </div>
          </div>

          {/* Dias da Semana de Visita */}
          <div>
            <Label className="mb-2 block">Dias da Semana de Visita *</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { value: "Seg", label: "Segunda-feira" },
                { value: "Ter", label: "Terça-feira" },
                { value: "Qua", label: "Quarta-feira" },
                { value: "Qui", label: "Quinta-feira" },
                { value: "Sex", label: "Sexta-feira" },
                { value: "Sab", label: "Sábado" },
              ].map((day) => (
                <div key={day.value} className="flex items-center space-x-2">
                  <Checkbox
                    id={`weekday-${day.value}`}
                    checked={formData.weekdays.includes(day.value)}
                    onCheckedChange={() => toggleWeekday(day.value)}
                    data-testid={`checkbox-weekday-${day.value}`}
                  />
                  <label
                    htmlFor={`weekday-${day.value}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    {day.label}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Periodicidade de Visita */}
          <div>
            <Label htmlFor="visitPeriodicity">Periodicidade de Visita *</Label>
            <Select
              value={formData.visitPeriodicity}
              onValueChange={handlePeriodicityChange}
            >
              <SelectTrigger data-testid="select-visit-periodicity">
                <SelectValue placeholder="Selecione a periodicidade" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semanal">Semanal</SelectItem>
                <SelectItem value="quinzenal">Quinzenal</SelectItem>
                <SelectItem value="mensal">Mensal</SelectItem>
                <SelectItem value="bimestral">Bimestral</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Configurações de Entrega */}
          <div className="space-y-4 border-t pt-4">
            <h3 className="font-semibold text-lg">Configurações de Entrega</h3>
            
            {/* Veículo Exclusivo */}
            <div className="space-y-3 border border-orange-200 bg-orange-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-orange-900">Veículo Exclusivo</Label>
              
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="exclusive-vehicle-customer"
                  checked={formData.exclusiveVehicle}
                  onCheckedChange={(checked) => {
                    setFormData(prev => ({
                      ...prev,
                      exclusiveVehicle: checked as boolean,
                      vehicleTypes: checked ? prev.vehicleTypes : []
                    }));
                  }}
                  data-testid="checkbox-exclusive-vehicle-customer"
                />
                <label htmlFor="exclusive-vehicle-customer" className="text-sm cursor-pointer">
                  Entrega em veículo exclusivo?
                </label>
              </div>

              {formData.exclusiveVehicle && (
                <div className="ml-6 space-y-2">
                  <Label className="text-sm font-medium">Tipos de Veículos (máximo 2)</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: 'caminhao', label: '🚛 Caminhão' },
                      { value: 'carro', label: '🚗 Carro' },
                      { value: 'moto', label: '🏍️ Moto' }
                    ].map((vehicle) => (
                      <div key={vehicle.value} className="flex items-center space-x-2">
                        <Checkbox
                          id={`vehicle-customer-${vehicle.value}`}
                          checked={formData.vehicleTypes.includes(vehicle.value)}
                          onCheckedChange={() => toggleVehicleType(vehicle.value)}
                          data-testid={`checkbox-vehicle-customer-${vehicle.value}`}
                        />
                        <label htmlFor={`vehicle-customer-${vehicle.value}`} className="text-sm cursor-pointer">
                          {vehicle.label}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Dias de Entrega */}
            <div className="space-y-3 border border-blue-200 bg-blue-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-blue-900">Dias da Semana para Entrega</Label>
              
              <div className="grid grid-cols-4 gap-3">
                {[
                  { value: 'Seg', label: 'Seg' },
                  { value: 'Ter', label: 'Ter' },
                  { value: 'Qua', label: 'Qua' },
                  { value: 'Qui', label: 'Qui' },
                  { value: 'Sex', label: 'Sex' },
                  { value: 'Sab', label: 'Sáb' },
                  { value: 'Dom', label: 'Dom' },
                ].map((day) => (
                  <div key={day.value} className="flex items-center space-x-2">
                    <Checkbox
                      id={`delivery-weekday-customer-${day.value}`}
                      checked={formData.deliveryWeekdays.includes(day.value)}
                      onCheckedChange={() => toggleDeliveryWeekday(day.value)}
                      data-testid={`checkbox-delivery-weekday-customer-${day.value}`}
                    />
                    <label htmlFor={`delivery-weekday-customer-${day.value}`} className="text-sm cursor-pointer">
                      {day.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Horários de Entrega (Seg-Sex) */}
            <div className="space-y-3 border border-green-200 bg-green-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-green-900">Horários de Entrega (Seg-Sex)</Label>
              
              <div className="grid grid-cols-4 gap-3">
                {['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'].map((slot) => (
                  <div key={slot} className="flex items-center space-x-2">
                    <Checkbox
                      id={`time-slot-customer-${slot}`}
                      checked={formData.deliveryTimeSlots.includes(slot)}
                      onCheckedChange={() => toggleDeliveryTimeSlot(slot)}
                      data-testid={`checkbox-time-slot-customer-${slot}`}
                    />
                    <label htmlFor={`time-slot-customer-${slot}`} className="text-sm cursor-pointer">
                      {slot}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Horários de Entrega aos Sábados */}
            <div className="space-y-3 border border-purple-200 bg-purple-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-purple-900">Horários aos Sábados</Label>
              
              <div className="grid grid-cols-4 gap-3">
                {['08:00', '09:00', '10:00', '11:00', '12:00'].map((slot) => (
                  <div key={slot} className="flex items-center space-x-2">
                    <Checkbox
                      id={`saturday-slot-customer-${slot}`}
                      checked={formData.deliverySaturdayTimeSlots.includes(slot)}
                      onCheckedChange={() => toggleSaturdayTimeSlot(slot)}
                      data-testid={`checkbox-saturday-slot-customer-${slot}`}
                    />
                    <label htmlFor={`saturday-slot-customer-${slot}`} className="text-sm cursor-pointer">
                      {slot}
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Botões */}
          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={updateCustomerMutation.isPending}
              data-testid="button-cancel-edit"
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={updateCustomerMutation.isPending}
              data-testid="button-save-customer"
            >
              {updateCustomerMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Salvar Alterações
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
