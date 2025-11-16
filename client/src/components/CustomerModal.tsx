import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient, useQuery } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertCustomerSchema, type InsertCustomer, type Customer, type User } from "@shared/schema";
import { Search, Building2, User as UserIcon, MapPin, Phone, Mail, Calendar, Navigation, Target, Lock, Unlock, Clock, XCircle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

interface CustomerModalProps {
  isOpen: boolean;
  onClose: () => void;
  customer?: Customer | null;
}

interface CNPJData {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string;
  endereco: string;
  cidade: string;
  estado: string;
  cep: string;
  telefone: string;
  email: string;
  situacao: string;
}

const weekdayOptions = [
  { value: 'Seg', label: 'Segunda-feira' },
  { value: 'Ter', label: 'Terça-feira' },
  { value: 'Qua', label: 'Quarta-feira' },
  { value: 'Qui', label: 'Quinta-feira' },
  { value: 'Sex', label: 'Sexta-feira' },
  { value: 'Sab', label: 'Sábado' },
  { value: 'Dom', label: 'Domingo' },
];

// Função para normalizar dias da semana de qualquer formato para o padrão abreviado
function normalizeWeekdays(weekdays: string | string[]): string[] {
  const weekdayMap: Record<string, string> = {
    // Formato abreviado (padrão) - minúsculo e maiúsculo, com e sem acento
    'seg': 'Seg', 'ter': 'Ter', 'qua': 'Qua', 'qui': 'Qui', 'sex': 'Sex', 'sab': 'Sab', 'dom': 'Dom',
    'SEG': 'Seg', 'TER': 'Ter', 'QUA': 'Qua', 'QUI': 'Qui', 'SEX': 'Sex', 'SAB': 'Sab', 'DOM': 'Dom',
    'sáb': 'Sab', 'SÁB': 'Sab', 'sáb.': 'Sab', 'SÁB.': 'Sab',
    // Formato completo português - minúsculo
    'segunda': 'Seg', 'terca': 'Ter', 'quarta': 'Qua', 'quinta': 'Qui', 'sexta': 'Sex', 'sabado': 'Sab', 'domingo': 'Dom',
    // Formato completo português - com acento
    'terça': 'Ter', 'sábado': 'Sab',
    // Formato completo português - maiúsculo
    'SEGUNDA': 'Seg', 'TERCA': 'Ter', 'TERÇA': 'Ter', 'QUARTA': 'Qua', 'QUINTA': 'Qui', 
    'SEXTA': 'Sex', 'SABADO': 'Sab', 'SÁBADO': 'Sab', 'DOMINGO': 'Dom',
    // Formato com "-feira" - minúsculo
    'segunda-feira': 'Seg', 'terca-feira': 'Ter', 'terça-feira': 'Ter',
    'quarta-feira': 'Qua', 'quinta-feira': 'Qui', 'sexta-feira': 'Sex',
    'sabado-feira': 'Sab', 'sábado-feira': 'Sab', 'domingo-feira': 'Dom',
    // Formato em inglês (legacy)
    'monday': 'Seg', 'tuesday': 'Ter', 'wednesday': 'Qua', 'thursday': 'Qui',
    'friday': 'Sex', 'saturday': 'Sab', 'sunday': 'Dom',
    'MONDAY': 'Seg', 'TUESDAY': 'Ter', 'WEDNESDAY': 'Qua', 'THURSDAY': 'Qui',
    'FRIDAY': 'Sex', 'SATURDAY': 'Sab', 'SUNDAY': 'Dom',
  };

  let weekdaysArray: string[] = [];
  
  // Se for string JSON, parsear
  if (typeof weekdays === 'string') {
    try {
      weekdaysArray = JSON.parse(weekdays);
    } catch {
      // ✅ FIX: Se não for JSON válido, split por vírgula/ponto-e-vírgula (dados legados)
      // Exemplo: "segunda,terca,quarta,quinta,sexta, Qua" → ["segunda","terca","quarta","quinta","sexta","Qua"]
      weekdaysArray = weekdays
        .split(/[,;\/]/)      // Split por vírgula, ponto-e-vírgula ou barra
        .map(d => d.trim())    // Remove espaços
        .filter(d => d);       // Remove strings vazias
    }
  } else {
    weekdaysArray = weekdays || [];
  }

  // Normalizar cada dia e remover duplicatas
  const normalized = weekdaysArray
    .map(day => {
      const normalized = weekdayMap[day.toLowerCase().trim()];
      return normalized || day; // Se não encontrar no mapa, retorna original
    })
    .filter(day => day); // Remove valores vazios
  
  // Remove duplicatas preservando ordem (usando Array.from para compatibilidade TS)
  return Array.from(new Set(normalized));
}

export default function CustomerModal({ isOpen, onClose, customer }: CustomerModalProps) {
  const [cnpjLoading, setCnpjLoading] = useState(false);
  const [cnpjData, setCnpjData] = useState<CNPJData | null>(null);
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const [showInactivateDialog, setShowInactivateDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  
  // Vendedores não podem alterar dias de visita, periodicidade e atendimento virtual
  const canManageRouteAndPeriodicity = user?.role !== 'vendedor';
  const canManageVirtualService = user?.role !== 'vendedor';

  const { data: users } = useQuery({
    queryKey: ['/api/users'],
    retry: false,
  });

  const form = useForm<InsertCustomer>({
    resolver: zodResolver(insertCustomerSchema),
    defaultValues: {
      customerType: 'pessoa_fisica',
      name: '',
      cpf: '',
      cnpj: '',
      companyName: '',
      fantasyName: '',
      phone: '',
      email: '',
      address: '',
      city: '',
      state: '',
      zipCode: '',
      route: '',
      sellerId: '',
      weekdays: '[]',
      visitPeriodicity: 'semanal',
      isActive: true,
      latitude: '',
      longitude: '',
      coordinatesLocked: false,
      virtualService: false,
      serviceStartDate: undefined,
    },
  });

  const [customerType, setCustomerType] = useState<'pessoa_fisica' | 'pessoa_juridica'>('pessoa_fisica');
  const coordinatesLocked = form.watch('coordinatesLocked');
  const weekdays = form.watch('weekdays');

  useEffect(() => {
    if (customer) {
      const type = (customer as any).customerType || 'pessoa_fisica';
      setCustomerType(type);
      
      // Normalizar weekdays para o formato padrão abreviado
      const normalizedWeekdays = normalizeWeekdays(customer.weekdays || '[]');
      const weekdaysJson = JSON.stringify(normalizedWeekdays);
      
      form.reset({
        customerType: type,
        name: customer.name || '',
        cpf: (customer as any).cpf || '',
        cnpj: (customer as any).cnpj || '',
        companyName: (customer as any).companyName || '',
        fantasyName: (customer as any).fantasyName || '',
        phone: customer.phone || '',
        email: customer.email || '',
        address: customer.address || '',
        city: (customer as any).city || '',
        state: (customer as any).state || '',
        zipCode: (customer as any).zipCode || '',
        route: customer.route || '',
        sellerId: customer.sellerId || '',
        weekdays: weekdaysJson,
        visitPeriodicity: (customer as any).visitPeriodicity || 'semanal',
        isActive: customer.isActive !== undefined ? customer.isActive : true,
        latitude: (customer as any).latitude || '',
        longitude: (customer as any).longitude || '',
        coordinatesLocked: (customer as any).coordinatesLocked || false,
        virtualService: (customer as any).virtualService || false,
        serviceStartDate: (customer as any).serviceStartDate || undefined,
      });
    } else {
      setCustomerType('pessoa_fisica');
      form.reset({
        customerType: 'pessoa_fisica',
        name: '',
        cpf: '',
        cnpj: '',
        companyName: '',
        fantasyName: '',
        phone: '',
        email: '',
        address: '',
        city: '',
        state: '',
        zipCode: '',
        route: '',
        sellerId: '',
        weekdays: '[]',
        visitPeriodicity: 'semanal',
        isActive: true,
        latitude: '',
        longitude: '',
        coordinatesLocked: false,
        virtualService: false,
        serviceStartDate: undefined,
      });
    }
  }, [customer, form]);

  const captureLocation = () => {
    setIsCapturingLocation(true);
    
    if (!navigator.geolocation) {
      toast({
        title: "Geolocalização não suportada",
        description: "Seu navegador não suporta geolocalização.",
        variant: "destructive",
      });
      setIsCapturingLocation(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = position.coords.latitude.toString();
        const longitude = position.coords.longitude.toString();
        
        form.setValue('latitude', latitude);
        form.setValue('longitude', longitude);
        
        toast({
          title: "Localização capturada!",
          description: `Latitude: ${latitude}, Longitude: ${longitude}`,
        });
        setIsCapturingLocation(false);
      },
      (error) => {
        console.error('Erro ao capturar localização:', error);
        toast({
          title: "Erro ao capturar localização",
          description: "Não foi possível obter sua localização. Verifique as permissões do navegador.",
          variant: "destructive",
        });
        setIsCapturingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  };

  const openWaze = () => {
    const latitude = form.watch('latitude');
    const longitude = form.watch('longitude');
    
    if (!latitude || !longitude) {
      toast({
        title: "Localização não disponível",
        description: "É necessário capturar ou inserir a latitude e longitude primeiro.",
        variant: "destructive",
      });
      return;
    }
    
    const wazeUrl = `https://waze.com/ul?ll=${latitude},${longitude}&navigate=yes&zoom=17`;
    window.open(wazeUrl, '_blank');
  };

  const searchCNPJ = async (cnpj: string) => {
    if (!cnpj || cnpj.replace(/\D/g, '').length !== 14) {
      toast({
        title: "Erro",
        description: "CNPJ deve conter 14 dígitos",
        variant: "destructive",
      });
      return;
    }

    setCnpjLoading(true);
    try {
      const response = await fetch('/api/receita/cnpj', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cnpj }),
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao consultar CNPJ');
      }

      const data: CNPJData = await response.json();
      setCnpjData(data);

      // Preencher automaticamente os campos
      form.setValue('companyName', data.razaoSocial);
      form.setValue('fantasyName', data.nomeFantasia);
      form.setValue('name', data.nomeFantasia || data.razaoSocial);
      form.setValue('address', data.endereco);
      form.setValue('city', data.cidade);
      form.setValue('state', data.estado);
      form.setValue('zipCode', data.cep);
      
      if (data.telefone) {
        form.setValue('phone', data.telefone);
      }
      if (data.email) {
        form.setValue('email', data.email);
      }

      toast({
        title: "Sucesso",
        description: "Dados do CNPJ carregados com sucesso!",
      });
    } catch (error) {
      toast({
        title: "Erro",
        description: error instanceof Error ? error.message : "Erro ao consultar CNPJ",
        variant: "destructive",
      });
    } finally {
      setCnpjLoading(false);
    }
  };

  const customerMutation = useMutation({
    mutationFn: async (data: InsertCustomer) => {
      const method = customer ? 'PUT' : 'POST';
      const url = customer ? `/api/customers/${customer.id}` : '/api/customers';
      // Convert weekdays array to JSON string for API
      const payload = {
        ...data,
        weekdays: typeof data.weekdays === 'string' ? data.weekdays : JSON.stringify(data.weekdays),
      };
      return await apiRequest(method, url, payload);
    },
    onSuccess: (response: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      
      // Mensagem principal de sucesso
      let description = customer ? "Cliente atualizado com sucesso!" : "Cliente criado com sucesso!";
      
      // Adicionar informações sobre Omie e Sales Card (se disponíveis)
      const messages: string[] = [];
      if (response._omieMessage) {
        messages.push(response._omieMessage);
      }
      if (response._salesCardMessage) {
        messages.push(response._salesCardMessage);
      }
      
      if (messages.length > 0) {
        description += "\n\n" + messages.join("\n");
      }
      
      toast({
        title: "Sucesso",
        description,
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const inactivateCustomerMutation = useMutation({
    mutationFn: async () => {
      if (!customer) throw new Error("Cliente não encontrado");
      return await apiRequest('PATCH', `/api/customers/${customer.id}`, { omieStatus: 'inativo' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Cliente inativado",
        description: "O cliente foi inativado com sucesso. Ele não aparecerá mais nas rotas de visitas.",
      });
      setShowInactivateDialog(false);
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleInactivate = () => {
    inactivateCustomerMutation.mutate();
  };

  const onSubmit = (data: InsertCustomer) => {
    customerMutation.mutate(data);
  };

  const handleWeekdayToggle = (weekday: string) => {
    const currentWeekdays = JSON.parse(weekdays || '[]');
    
    if (currentWeekdays.includes(weekday)) {
      // Remove o dia se já estiver selecionado
      const newWeekdays = currentWeekdays.filter((w: string) => w !== weekday);
      form.setValue('weekdays', JSON.stringify(newWeekdays));
    } else {
      // Adiciona o dia - permite múltiplos dias
      const newWeekdays = [...currentWeekdays, weekday];
      form.setValue('weekdays', JSON.stringify(newWeekdays));
    }
  };

  const formatCPF = (value: string) => {
    const cpf = value.replace(/\D/g, '');
    if (cpf.length <= 3) return cpf;
    if (cpf.length <= 6) return cpf.replace(/(\d{3})(\d{0,3})/, '$1.$2');
    if (cpf.length <= 9) return cpf.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
    return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
  };

  const formatCNPJ = (value: string) => {
    const cnpj = value.replace(/\D/g, '');
    if (cnpj.length <= 2) return cnpj;
    if (cnpj.length <= 5) return cnpj.replace(/(\d{2})(\d{0,3})/, '$1.$2');
    if (cnpj.length <= 8) return cnpj.replace(/(\d{2})(\d{3})(\d{0,3})/, '$1.$2.$3');
    if (cnpj.length <= 12) return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{0,4})/, '$1.$2.$3/$4');
    return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, '$1.$2.$3/$4-$5');
  };

  const formatPhone = (value: string) => {
    const phone = value.replace(/\D/g, '');
    if (phone.length <= 10) {
      return phone.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
    }
    return phone.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <UserIcon className="h-5 w-5 text-honest-blue" />
            <span>{customer ? 'Editar Cliente' : 'Novo Cliente'}</span>
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Tipo de Cliente */}
            <Card>
              <CardContent className="pt-6">
                <FormField
                  control={form.control}
                  name="customerType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo de Cliente</FormLabel>
                      <Select 
                        onValueChange={(value: 'pessoa_fisica' | 'pessoa_juridica') => {
                          field.onChange(value);
                          setCustomerType(value);
                          // Limpar campos específicos quando muda o tipo
                          if (value === 'pessoa_fisica') {
                            form.setValue('cnpj', '', { shouldValidate: false });
                            form.setValue('companyName', '', { shouldValidate: false });
                            form.setValue('fantasyName', '', { shouldValidate: false });
                          } else {
                            form.setValue('cpf', '', { shouldValidate: false });
                          }
                        }}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Selecione o tipo" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="pessoa_fisica">
                            <div className="flex items-center space-x-2">
                              <UserIcon className="h-4 w-4" />
                              <span>Pessoa Física</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="pessoa_juridica">
                            <div className="flex items-center space-x-2">
                              <Building2 className="h-4 w-4" />
                              <span>Pessoa Jurídica</span>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Documentos */}
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="cpf"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>CPF</FormLabel>
                        <FormControl>
                          <Input
                            data-testid="input-cpf"
                            placeholder="000.000.000-00"
                            maxLength={14}
                            value={field.value || ''}
                            disabled={!!form.watch('cnpj')}
                            onChange={(e) => {
                              let value = e.target.value.replace(/\D/g, '');
                              let formatted = '';
                              if (value.length <= 3) formatted = value;
                              else if (value.length <= 6) formatted = value.replace(/(\d{3})(\d{0,3})/, '$1.$2');
                              else if (value.length <= 9) formatted = value.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
                              else formatted = value.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
                              field.onChange(formatted);
                              if (formatted) {
                                form.setValue('cnpj', '');
                                form.setValue('customerType', 'pessoa_fisica');
                                setCustomerType('pessoa_fisica');
                              }
                            }}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="cnpj"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>CNPJ</FormLabel>
                        <div className="flex space-x-2">
                          <FormControl>
                            <Input
                              data-testid="input-cnpj"
                              placeholder="00.000.000/0000-00"
                              maxLength={18}
                              value={field.value || ''}
                              disabled={!!form.watch('cpf')}
                              onChange={(e) => {
                                let value = e.target.value.replace(/\D/g, '');
                                let formatted = '';
                                if (value.length <= 2) formatted = value;
                                else if (value.length <= 5) formatted = value.replace(/(\d{2})(\d{0,3})/, '$1.$2');
                                else if (value.length <= 8) formatted = value.replace(/(\d{2})(\d{3})(\d{0,3})/, '$1.$2.$3');
                                else if (value.length <= 12) formatted = value.replace(/(\d{2})(\d{3})(\d{3})(\d{0,4})/, '$1.$2.$3/$4');
                                else formatted = value.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, '$1.$2.$3/$4-$5');
                                field.onChange(formatted);
                                if (formatted) {
                                  form.setValue('cpf', '');
                                  form.setValue('customerType', 'pessoa_juridica');
                                  setCustomerType('pessoa_juridica');
                                }
                              }}
                              onBlur={field.onBlur}
                              name={field.name}
                              ref={field.ref}
                            />
                          </FormControl>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => searchCNPJ(field.value || '')}
                            disabled={cnpjLoading || !field.value}
                            className="px-3"
                          >
                            {cnpjLoading ? (
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-honest-blue"></div>
                            ) : (
                              <Search className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {cnpjData && (
                  <div className="mt-4">
                    <Card className="bg-green-50 border-green-200">
                      <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <Badge variant="secondary" className="bg-green-100 text-green-800">
                            Dados da Receita Federal
                          </Badge>
                          <Badge 
                            variant={cnpjData.situacao === 'ATIVA' ? 'default' : 'destructive'}
                            className={cnpjData.situacao === 'ATIVA' ? 'bg-green-600' : ''}
                          >
                            {cnpjData.situacao}
                          </Badge>
                        </div>
                        <div className="text-sm text-green-700">
                          <p><strong>Razão Social:</strong> {cnpjData.razaoSocial}</p>
                          {cnpjData.nomeFantasia && (
                            <p><strong>Nome Fantasia:</strong> {cnpjData.nomeFantasia}</p>
                          )}
                          <p><strong>Endereço:</strong> {cnpjData.endereco}</p>
                          <p><strong>Cidade:</strong> {cnpjData.cidade} - {cnpjData.estado}</p>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Dados Básicos */}
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {customerType === 'pessoa_juridica' ? 'Nome Fantasia / Razão Social *' : 'Nome Completo *'}
                        </FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Digite o nome" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {customerType === 'pessoa_juridica' && (
                    <>
                      <FormField
                        control={form.control}
                        name="companyName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Razão Social</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ''} placeholder="Razão social da empresa" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="fantasyName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Nome Fantasia</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value || ''} placeholder="Nome fantasia da empresa" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}

                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <Phone className="h-4 w-4" />
                          <span>Telefone *</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="(11) 99999-9999"
                            maxLength={15}
                            onChange={(e) => {
                              const formatted = formatPhone(e.target.value);
                              field.onChange(formatted);
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <Mail className="h-4 w-4" />
                          <span>E-mail</span>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} type="email" placeholder="email@exemplo.com" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Endereço */}
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="address"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel className="flex items-center space-x-1">
                          <MapPin className="h-4 w-4" />
                          <span>Endereço *</span>
                        </FormLabel>
                        <FormControl>
                          <Textarea {...field} placeholder="Rua, número, complemento" rows={2} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="zipCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>CEP</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} placeholder="00000-000" maxLength={9} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cidade</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} placeholder="Nome da cidade" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Estado</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} placeholder="UF" maxLength={2} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Geolocalização */}
            <Card>
              <CardContent className="pt-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <h3 className="text-lg font-medium">Localização GPS</h3>
                      {coordinatesLocked && (
                        <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                          <Lock className="h-3 w-3 mr-1" />
                          Travado
                        </Badge>
                      )}
                    </div>
                    <div className="flex space-x-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={captureLocation}
                        disabled={isCapturingLocation || coordinatesLocked}
                        className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
                        data-testid="button-capture-location"
                      >
                        {isCapturingLocation ? (
                          <>
                            <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full mr-2" />
                            Capturando...
                          </>
                        ) : (
                          <>
                            <Target className="h-4 w-4 mr-2" />
                            Capturar Local
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={openWaze}
                        className="text-blue-600 hover:text-blue-700"
                        data-testid="button-open-waze"
                      >
                        <Navigation className="h-4 w-4 mr-2" />
                        Waze
                      </Button>
                      <Button
                        type="button"
                        variant={coordinatesLocked ? "destructive" : "default"}
                        size="sm"
                        onClick={() => {
                          const newValue = !coordinatesLocked;
                          form.setValue('coordinatesLocked', newValue);
                        }}
                        data-testid="button-toggle-coordinates-lock"
                      >
                        {coordinatesLocked ? (
                          <>
                            <Unlock className="h-4 w-4 mr-2" />
                            Destravar
                          </>
                        ) : (
                          <>
                            <Lock className="h-4 w-4 mr-2" />
                            Travar
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="latitude"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Latitude</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value || ''}
                              placeholder="-23.5505"
                              type="number"
                              step="any"
                              disabled={coordinatesLocked}
                              className={coordinatesLocked ? "opacity-50 cursor-not-allowed" : ""}
                              data-testid="input-latitude"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="longitude"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Longitude</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value || ''}
                              placeholder="-46.6333"
                              type="number"
                              step="any"
                              disabled={coordinatesLocked}
                              className={coordinatesLocked ? "opacity-50 cursor-not-allowed" : ""}
                              data-testid="input-longitude"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Configurações de Venda */}
            <Card>
              <CardContent className="pt-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="route"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rota *</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} placeholder="Ex: Centro, Zona Norte" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="sellerId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Vendedor Responsável *</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Selecione um vendedor" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Array.isArray(users) && users.filter((user: User) => user.role === 'vendedor').map((user: User) => (
                              <SelectItem key={user.id} value={user.id}>
                                {user.firstName} {user.lastName} {user.route && `(${user.route})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="mt-4">
                  <FormField
                    control={form.control}
                    name="weekdays"
                    render={({ field }) => {
                      // Usar field.value em vez de form.watch para garantir sincronização
                      const currentWeekdays = field.value || '[]';
                      return (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <Calendar className="h-4 w-4" />
                          <span>Dias de Visita (selecione um ou mais)</span>
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {canManageRouteAndPeriodicity 
                            ? "Selecione os dias da semana em que o cliente pode receber visitas. Você pode selecionar múltiplos dias."
                            : "Apenas administradores podem alterar os dias de visita"}
                        </FormDescription>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {weekdayOptions.map((option) => {
                            let parsedWeekdays: string[] = [];
                            try {
                              parsedWeekdays = JSON.parse(currentWeekdays);
                            } catch (e) {
                              console.error('Erro ao parsear weekdays:', currentWeekdays, e);
                            }
                            const isSelected = parsedWeekdays.includes(option.value);
                            
                            return (
                              <Button
                                key={option.value}
                                type="button"
                                variant={isSelected ? "default" : "outline"}
                                size="sm"
                                onClick={() => handleWeekdayToggle(option.value)}
                                disabled={!canManageRouteAndPeriodicity}
                                className={isSelected ? "bg-honest-blue hover:bg-honest-blue/90" : ""}
                                data-testid={`button-weekday-${option.value}`}
                              >
                                {option.label}
                              </Button>
                            );
                          })}
                        </div>
                        <FormMessage />
                      </FormItem>
                      )
                    }}
                  />
                </div>

                <div className="mt-4">
                  <FormField
                    control={form.control}
                    name="visitPeriodicity"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <Clock className="h-4 w-4" />
                          <span>Periodicidade de Visita</span>
                        </FormLabel>
                        <Select 
                          value={field.value} 
                          onValueChange={field.onChange}
                          disabled={!canManageRouteAndPeriodicity}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-visit-periodicity">
                              <SelectValue placeholder="Selecione a periodicidade" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="semanal">Semanal</SelectItem>
                            <SelectItem value="quinzenal">Quinzenal</SelectItem>
                            <SelectItem value="mensal">Mensal</SelectItem>
                            <SelectItem value="bimestral">Bimestral</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription className="text-xs">
                          {canManageRouteAndPeriodicity 
                            ? "Defina com que frequência o cliente deve ser visitado" 
                            : "Apenas administradores podem alterar a periodicidade"}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Data de Início do Fornecimento */}
                <div className="mt-4">
                  <FormField
                    control={form.control}
                    name="serviceStartDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <Calendar className="h-4 w-4" />
                          <span>Data de Início do Fornecimento</span>
                        </FormLabel>
                        <FormControl>
                          <Input 
                            {...field} 
                            type="date"
                            value={field.value ? new Date(field.value).toISOString().split('T')[0] : ''}
                            onChange={(e) => field.onChange(e.target.value ? new Date(e.target.value) : null)}
                            data-testid="input-service-start-date"
                          />
                        </FormControl>
                        <FormDescription>
                          Data a partir da qual as visitas serão iniciadas
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Atendimento Virtual - apenas para admin/coordinator/administrative */}
                {canManageVirtualService && (
                  <div className="mt-4">
                    <FormField
                      control={form.control}
                      name="virtualService"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                          <div className="space-y-0.5">
                            <FormLabel className="text-base flex items-center space-x-2">
                              <i className="fas fa-laptop text-blue-600"></i>
                              <span>Atendimento Virtual</span>
                            </FormLabel>
                            <FormDescription>
                              Cliente que receberá atendimento apenas de forma virtual/remota.
                              Não será incluído no cálculo de metas de atendimento presencial.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <div className="flex items-center space-x-2">
                              <input
                                type="checkbox"
                                checked={field.value}
                                onChange={field.onChange}
                                className="rounded border-gray-300 text-honest-blue focus:ring-honest-blue"
                                data-testid="checkbox-virtual-service"
                              />
                            </div>
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Botões */}
            <div className="flex justify-between items-center">
              {/* Botão de Inativação (somente ao editar cliente ativo) */}
              {customer && customer.omieStatus === 'ativo' && (
                <Button 
                  type="button" 
                  variant="destructive"
                  onClick={() => setShowInactivateDialog(true)}
                  disabled={inactivateCustomerMutation.isPending}
                  data-testid="button-inactivate-customer"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Inativar Cliente
                </Button>
              )}
              {!customer || customer.omieStatus !== 'ativo' ? <div /> : null}
              
              <div className="flex space-x-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancelar
                </Button>
                <Button 
                  type="submit" 
                  disabled={customerMutation.isPending}
                  className="bg-honest-blue hover:bg-honest-blue/90"
                  data-testid="button-save-customer"
                >
                  {customerMutation.isPending ? 'Salvando...' : customer ? 'Atualizar' : 'Criar'}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>

      {/* Dialog de Confirmação de Inativação */}
      <AlertDialog open={showInactivateDialog} onOpenChange={setShowInactivateDialog}>
        <AlertDialogContent data-testid="dialog-confirm-inactivate">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar Inativação de Cliente</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja inativar este cliente? Ao inativá-lo:
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Ele não aparecerá mais nas rotas de visitas</li>
                <li>Não será considerado na carteira para fins de positivação</li>
                <li>Você poderá reativá-lo posteriormente editando o cliente</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-inactivate">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleInactivate}
              disabled={inactivateCustomerMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-inactivate"
            >
              {inactivateCustomerMutation.isPending ? 'Inativando...' : 'Sim, Inativar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}