import { useState, useEffect } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertCustomerSchema, type CustomerWithSeller } from "@shared/schema";
import { z } from "zod";

interface CustomerModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingCustomer: CustomerWithSeller | null;
}

export default function CustomerModal({ isOpen, onClose, editingCustomer }: CustomerModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    document: '',
    phone: '',
    email: '',
    address: '',
    route: '',
    sellerId: '',
    weekdays: [] as string[],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get users for seller selection (only for non-vendedor roles)
  const { data: users } = useQuery({
    queryKey: ['/api/auth/user'],
    retry: false,
  });

  useEffect(() => {
    if (editingCustomer) {
      try {
        const weekdays = JSON.parse(editingCustomer.weekdays);
        setFormData({
          name: editingCustomer.name,
          document: editingCustomer.document,
          phone: editingCustomer.phone,
          email: editingCustomer.email || '',
          address: editingCustomer.address,
          route: editingCustomer.route,
          sellerId: editingCustomer.sellerId,
          weekdays: Array.isArray(weekdays) ? weekdays : [],
        });
      } catch {
        setFormData({
          name: editingCustomer.name,
          document: editingCustomer.document,
          phone: editingCustomer.phone,
          email: editingCustomer.email || '',
          address: editingCustomer.address,
          route: editingCustomer.route,
          sellerId: editingCustomer.sellerId,
          weekdays: [],
        });
      }
    } else {
      setFormData({
        name: '',
        document: '',
        phone: '',
        email: '',
        address: '',
        route: '',
        sellerId: users?.id || '',
        weekdays: [],
      });
    }
    setErrors({});
  }, [editingCustomer, users, isOpen]);

  const createCustomerMutation = useMutation({
    mutationFn: async (data: any) => {
      if (editingCustomer) {
        await apiRequest('PUT', `/api/customers/${editingCustomer.id}`, data);
      } else {
        await apiRequest('POST', '/api/customers', data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      onClose();
      toast({
        title: "Sucesso",
        description: editingCustomer 
          ? "Cliente atualizado com sucesso!" 
          : "Cliente criado com sucesso!",
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
      const dataToValidate = {
        ...formData,
        weekdays: JSON.stringify(formData.weekdays),
      };

      const validatedData = insertCustomerSchema.parse(dataToValidate);
      createCustomerMutation.mutate(validatedData);
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

  const handleWeekdayChange = (day: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      weekdays: checked 
        ? [...prev.weekdays, day]
        : prev.weekdays.filter(d => d !== day)
    }));
  };

  const weekdayOptions = [
    { value: 'monday', label: 'Segunda' },
    { value: 'tuesday', label: 'Terça' },
    { value: 'wednesday', label: 'Quarta' },
    { value: 'thursday', label: 'Quinta' },
    { value: 'friday', label: 'Sexta' },
    { value: 'saturday', label: 'Sábado' },
    { value: 'sunday', label: 'Domingo' },
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingCustomer ? 'Editar Cliente' : 'Novo Cliente'}
          </DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label htmlFor="name">Nome da Empresa/Cliente *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className={errors.name ? "border-red-500" : ""}
              />
              {errors.name && <p className="text-sm text-red-500 mt-1">{errors.name}</p>}
            </div>
            
            <div>
              <Label htmlFor="document">CNPJ/CPF *</Label>
              <Input
                id="document"
                value={formData.document}
                onChange={(e) => setFormData(prev => ({ ...prev, document: e.target.value }))}
                className={errors.document ? "border-red-500" : ""}
                placeholder="00.000.000/0000-00"
              />
              {errors.document && <p className="text-sm text-red-500 mt-1">{errors.document}</p>}
            </div>
            
            <div>
              <Label htmlFor="phone">Telefone *</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                className={errors.phone ? "border-red-500" : ""}
                placeholder="(11) 99999-9999"
              />
              {errors.phone && <p className="text-sm text-red-500 mt-1">{errors.phone}</p>}
            </div>
            
            <div className="md:col-span-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                className={errors.email ? "border-red-500" : ""}
                placeholder="contato@empresa.com"
              />
              {errors.email && <p className="text-sm text-red-500 mt-1">{errors.email}</p>}
            </div>
            
            <div className="md:col-span-2">
              <Label htmlFor="address">Endereço Completo *</Label>
              <Textarea
                id="address"
                rows={3}
                value={formData.address}
                onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                className={errors.address ? "border-red-500" : ""}
                placeholder="Rua, número, bairro, cidade, CEP"
              />
              {errors.address && <p className="text-sm text-red-500 mt-1">{errors.address}</p>}
            </div>
            
            <div>
              <Label htmlFor="route">Rota *</Label>
              <Select 
                value={formData.route} 
                onValueChange={(value) => setFormData(prev => ({ ...prev, route: value }))}
              >
                <SelectTrigger className={errors.route ? "border-red-500" : ""}>
                  <SelectValue placeholder="Selecione uma rota" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="centro">Centro</SelectItem>
                  <SelectItem value="norte">Norte</SelectItem>
                  <SelectItem value="sul">Sul</SelectItem>
                  <SelectItem value="leste">Leste</SelectItem>
                  <SelectItem value="oeste">Oeste</SelectItem>
                </SelectContent>
              </Select>
              {errors.route && <p className="text-sm text-red-500 mt-1">{errors.route}</p>}
            </div>
            
            {users?.role !== 'vendedor' && (
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
                    <SelectItem value={users?.id || ''}>{users?.firstName} {users?.lastName}</SelectItem>
                  </SelectContent>
                </Select>
                {errors.sellerId && <p className="text-sm text-red-500 mt-1">{errors.sellerId}</p>}
              </div>
            )}
            
            <div className="md:col-span-2">
              <Label>Periodicidade de Visitas *</Label>
              <div className="grid grid-cols-7 gap-2 mt-2">
                {weekdayOptions.map((day) => (
                  <div key={day.value} className="flex flex-col items-center space-y-2">
                    <Label htmlFor={day.value} className="text-sm">{day.label}</Label>
                    <Checkbox
                      id={day.value}
                      checked={formData.weekdays.includes(day.value)}
                      onCheckedChange={(checked) => handleWeekdayChange(day.value, checked as boolean)}
                    />
                  </div>
                ))}
              </div>
              {errors.weekdays && <p className="text-sm text-red-500 mt-1">{errors.weekdays}</p>}
            </div>
          </div>
          
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button 
              type="submit" 
              className="bg-honest-blue hover:bg-blue-700"
              disabled={createCustomerMutation.isPending}
            >
              {createCustomerMutation.isPending 
                ? 'Salvando...' 
                : editingCustomer ? 'Atualizar Cliente' : 'Salvar Cliente'
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
