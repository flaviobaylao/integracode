import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@/lib/queryClient";
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
import { Loader2, Plus } from "lucide-react";

interface CustomerEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer: Customer | null;
  isLead?: boolean;
}

export default function CustomerEditModal({
  isOpen,
  onClose,
  customer,
  isLead = false,
}: CustomerEditModalProps) {
  const { toast } = useToast();
  const [isInActiveList, setIsInActiveList] = useState(false);
  
  // Buscar usuários (vendedores)
  const { data: users = [] } = useQuery({
    queryKey: ['/api/users'],
  });

  // Verificar se cliente está na lista de ativos (não verificar para leads)
  useEffect(() => {
    const checkActiveStatus = async () => {
      if (isLead || !customer?.id || !isOpen) {
        setIsInActiveList(false);
        return;
      }
      try {
        const response = await fetch(`/api/active-customers/check/${customer.id}`);
        if (!response.ok) {
          setIsInActiveList(false);
          return;
        }
        
        const data = await response.json();
        const isActive = data?.isActive === true;
        setIsInActiveList(isActive);
      } catch (error) {
        console.error('Erro ao verificar status ativo:', error);
        setIsInActiveList(false);
      }
    };
    checkActiveStatus();
  }, [customer?.id, isOpen, isLead]);

  const { data: instances = [] } = useQuery<any[]>({ queryKey: ["/api/omie/instances/public"] });

  const [formData, setFormData] = useState({
    name: "",
    fantasyName: "",
    companyName: "",
    cpf: "",
    cnpj: "",
    stateRegistration: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zipCode: "",
    latitude: "",
    longitude: "",
    sellerId: "",
    weekdays: [] as string[],
    visitPeriodicity: "semanal" as "semanal" | "quinzenal" | "mensal" | "bimestral",
    exclusiveVehicle: false,
    vehicleTypes: [] as string[],
    receivingWeekdays: [] as string[], // Dias em que cliente aceita receber (configurado manualmente)
    deliveryTimeSlots: [] as string[],
    deliverySaturdayTimeSlots: [] as string[],
    isConsumerClient: false, // Cliente Consumidor - destaque verde
    omieInstanceId: "",
    paymentMethod: "", // Condicao de pagamento do cliente (sobrepoe forma+prazo da venda)
    boletoDays: "" as any,
    collectionDiscount: "" as any,
    paymentInstallments: "" as any,
  });

  const createLeadMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return await apiRequest("POST", `/api/customers`, { ...data, isLead: true });
    },
    onSuccess: () => {
      toast({
        title: "Lead cadastrado com sucesso!",
        description: "O novo lead foi criado e poderá ser incluído em rotas.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
      onClose();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao criar lead",
        description: error.message || "Ocorreu um erro ao criar o lead",
        variant: "destructive",
      });
    },
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
      queryClient.invalidateQueries({ queryKey: ['/api/active-customers'] });
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

  const addToActiveMutation = useMutation({
    mutationFn: async () => {
      if (!customer?.id) throw new Error("Customer ID is required");
      return await apiRequest("POST", `/api/active-customers/add/${customer.id}`, {});
    },
    onSuccess: () => {
      setIsInActiveList(true);
      toast({
        title: "Sucesso!",
        description: "Cliente adicionado à lista de clientes ativos.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/customers', customer?.id, 'active-status'] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao adicionar cliente aos ativos",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: any = {
      ...formData,
      paymentMethod: (formData as any).paymentMethod || null,
      boletoDays: (formData as any).boletoDays === "" || (formData as any).boletoDays == null ? null : Number((formData as any).boletoDays),
      paymentInstallments: (formData as any).paymentInstallments === "" || (formData as any).paymentInstallments == null ? null : Number((formData as any).paymentInstallments),
      collectionDiscount: (formData as any).collectionDiscount === "" || (formData as any).collectionDiscount == null ? null : String((formData as any).collectionDiscount),
      omieInstanceId: (formData as any).omieInstanceId || null,
    };
    
    // Se é novo lead (isLead = true e customer = null), cria novo
    if (isLead && !customer?.id) {
      // Validar que sellerId foi selecionado
      if (!formData.sellerId) {
        toast({
          title: "Campo obrigatório",
          description: "Selecione um vendedor responsável",
          variant: "destructive",
        });
        return;
      }
      createLeadMutation.mutate(payload);
    } else {
      // Caso contrário atualiza existente
      updateCustomerMutation.mutate(payload);
    }
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

  const toggleReceivingWeekday = (day: string) => {
    setFormData((prev) => ({
      ...prev,
      receivingWeekdays: prev.receivingWeekdays.includes(day)
        ? prev.receivingWeekdays.filter(d => d !== day)
        : [...prev.receivingWeekdays, day]
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
        if (typeof customer.weekdays === 'string') {
          const parsed = (() => { try { return JSON.parse(customer.weekdays); } catch { return []; } })();
          parsedWeekdays = Array.isArray(parsed) ? parsed : [];
        } else {
          parsedWeekdays = Array.isArray(customer.weekdays) ? customer.weekdays : [];
        }
      } catch (e) {
        console.error("Error parsing weekdays:", e);
        // Fallback: try to split by comma
        if (typeof customer.weekdays === 'string') {
          parsedWeekdays = customer.weekdays.split(/[,;\/]/).map(d => d.trim()).filter(d => d);
        }
      }

      setFormData({
        name: customer.name || "",
        fantasyName: customer.fantasyName || "",
        companyName: customer.companyName || "",
        cpf: customer.cpf || "",
        cnpj: customer.cnpj || "",
        stateRegistration: (customer as any).stateRegistration || (customer as any).state_registration || "",
        email: customer.email || "",
        phone: customer.phone || "",
        address: customer.address || "",
        city: customer.city || "",
        state: customer.state || "",
        zipCode: customer.zipCode || "",
        latitude: customer.latitude || "",
        longitude: customer.longitude || "",
        sellerId: customer.sellerId || "",
        weekdays: parsedWeekdays,
        visitPeriodicity: customer.visitPeriodicity || "semanal",
        exclusiveVehicle: customer.exclusiveVehicle || false,
        vehicleTypes: Array.isArray(customer.vehicleTypes) ? customer.vehicleTypes : [],
        receivingWeekdays: Array.isArray((customer as any).receivingWeekdays) ? (customer as any).receivingWeekdays : [],
        deliveryTimeSlots: Array.isArray(customer.deliveryTimeSlots) ? customer.deliveryTimeSlots : [],
        deliverySaturdayTimeSlots: Array.isArray(customer.deliverySaturdayTimeSlots) ? customer.deliverySaturdayTimeSlots : [],
        isConsumerClient: (customer as any).isConsumerClient || false,
        omieInstanceId: (customer as any).omieInstanceId || "",
        paymentMethod: (customer as any).paymentMethod || "",
        boletoDays: (customer as any).boletoDays ?? "",
        collectionDiscount: (customer as any).collectionDiscount ?? "",
        paymentInstallments: (customer as any).paymentInstallments ?? "",
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

          {/* Inscrição Estadual */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="stateRegistration">Inscrição Estadual</Label>
              <Input
                id="stateRegistration"
                name="stateRegistration"
                value={(formData as any).stateRegistration}
                onChange={handleChange}
                placeholder="IE (ou ISENTO)"
                data-testid="input-customer-ie"
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

          {/* Vendedor Responsável */}
          <div>
            <Label htmlFor="sellerId">Vendedor Responsável *</Label>
            <Select
              value={formData.sellerId}
              onValueChange={(value) => setFormData(prev => ({ ...prev, sellerId: value }))}
            >
              <SelectTrigger data-testid="select-seller">
                <SelectValue placeholder="Selecione um vendedor" />
              </SelectTrigger>
              <SelectContent>
                {users && Array.isArray(users) && users.filter((u: any) => u.isActive).map((user: any) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.firstName} {user.lastName} ({user.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Instancia (Empresa Emissora) */}
          <div>
            <Label htmlFor="omieInstanceId">Instância (Empresa Emissora)</Label>
            <Select
              value={(formData as any).omieInstanceId || "__none__"}
              onValueChange={(value) => setFormData(prev => ({ ...prev, omieInstanceId: value === "__none__" ? "" : value } as any))}
            >
              <SelectTrigger data-testid="select-omie-instance">
                <SelectValue placeholder="Selecione a empresa/instância" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Não definida</SelectItem>
                {Array.isArray(instances) && (instances as any[]).filter((i: any) => i.isActive !== false).map((i: any) => (
                  <SelectItem key={i.id} value={i.id}>{i.displayName || i.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

          {/* Cliente Consumidor */}
          <div className="flex items-center space-x-3 p-4 border border-green-200 bg-green-50 rounded-lg">
            <Checkbox
              id="is-consumer-client"
              checked={formData.isConsumerClient}
              onCheckedChange={(checked) => {
                setFormData(prev => ({
                  ...prev,
                  isConsumerClient: checked as boolean
                }));
              }}
              data-testid="checkbox-consumer-client"
            />
            <div>
              <label htmlFor="is-consumer-client" className="text-sm font-medium cursor-pointer text-green-900">
                Cliente Consumidor
              </label>
              <p className="text-xs text-green-700">Marque esta opção para destacar o cliente com fundo verde na lista</p>
            </div>
          </div>

          {/* Configurações de Recebimento */}
          <div className="space-y-4 border-t pt-4">
            <h3 className="font-semibold text-lg">Configurações de Recebimento</h3>

            {/* Dados de Pagamento Padrão (condição de pagamento do cliente) */}
            <div className="space-y-3 border border-emerald-200 bg-emerald-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-emerald-900 flex items-center gap-2">
                <i className="fas fa-hand-holding-usd text-emerald-700"></i>
                Dados de Pagamento Padrão
              </Label>
              <p className="text-xs text-emerald-700">Condição de pagamento do cliente. Quando a Forma está definida aqui, ela SOBREPÕE a forma e o prazo da venda ao gerar a cobrança. Deixe "Usar forma da venda" para não sobrepor.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm">Forma de Pagamento</Label>
                  <Select
                    value={(formData as any).paymentMethod || "__none__"}
                    onValueChange={(v) => setFormData(prev => ({ ...prev, paymentMethod: v === "__none__" ? "" : v } as any))}
                  >
                    <SelectTrigger data-testid="select-payment-method">
                      <SelectValue placeholder="Usar forma da venda" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Usar forma da venda (padrão)</SelectItem>
                      <SelectItem value="a_vista">À vista</SelectItem>
                      <SelectItem value="boleto">Boleto</SelectItem>
                      <SelectItem value="pix">PIX</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500 mt-1">Quando definida, sobrepõe a forma E o prazo da venda.</p>
                </div>
                <div>
                  <Label className="text-sm">Prazo (dias)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={(formData as any).boletoDays}
                    onChange={(e) => setFormData(prev => ({ ...prev, boletoDays: e.target.value } as any))}
                    placeholder="Ex.: 7 (boleto) / 5 (PIX)"
                    data-testid="input-boleto-days"
                  />
                  <p className="text-xs text-gray-500 mt-1">Dias até o vencimento. Vazio usa o padrão (boleto 7, PIX 5).</p>
                </div>
                <div>
                  <Label className="text-sm">Parcelamento (nº de parcelas)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={(formData as any).paymentInstallments}
                    onChange={(e) => setFormData(prev => ({ ...prev, paymentInstallments: e.target.value } as any))}
                    placeholder="1"
                    data-testid="input-payment-installments"
                  />
                </div>
                <div>
                  <Label className="text-sm">Desconto de Cobrança (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={(formData as any).collectionDiscount}
                    onChange={(e) => setFormData(prev => ({ ...prev, collectionDiscount: e.target.value } as any))}
                    placeholder="0"
                    data-testid="input-collection-discount"
                  />
                </div>
              </div>
            </div>

            
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

            {/* Dias de Recebimento */}
            <div className="space-y-3 border border-blue-200 bg-blue-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-blue-900">Dias da Semana para Recebimento</Label>
              
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
                      id={`receiving-weekday-customer-${day.value}`}
                      checked={formData.receivingWeekdays.includes(day.value)}
                      onCheckedChange={() => toggleReceivingWeekday(day.value)}
                      data-testid={`checkbox-receiving-weekday-customer-${day.value}`}
                    />
                    <label htmlFor={`receiving-weekday-customer-${day.value}`} className="text-sm cursor-pointer">
                      {day.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Horários de Recebimento (Seg-Sex) */}
            <div className="space-y-3 border border-green-200 bg-green-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-green-900">Horários de Recebimento (Seg-Sex)</Label>
              
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

            {/* Horários de Recebimento aos Sábados */}
            <div className="space-y-3 border border-purple-200 bg-purple-50 p-4 rounded-lg">
              <Label className="text-sm font-medium text-purple-900">Horários de Recebimento aos Sábados</Label>
              
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
          <div className="flex justify-between">
            <div>
              {!isInActiveList && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addToActiveMutation.mutate()}
                  disabled={addToActiveMutation.isPending}
                  className="border-green-600 text-green-600 hover:bg-green-50"
                  data-testid="button-add-to-active"
                >
                  {addToActiveMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Plus className="mr-2 h-4 w-4" />
                  Adicionar aos Clientes Ativos
                </Button>
              )}
            </div>
            <div className="flex space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={updateCustomerMutation.isPending || addToActiveMutation.isPending}
                data-testid="button-cancel-edit"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={updateCustomerMutation.isPending || addToActiveMutation.isPending}
                data-testid="button-save-customer"
              >
                {updateCustomerMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Salvar Alterações
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
