import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Users, Phone, MapPin, Plus, Edit, Trash2, Navigation } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Lead, type InsertLead, insertLeadSchema } from "@shared/schema";

export default function LeadsManagement() {
  const [isCreating, setIsCreating] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [formData, setFormData] = useState({
    fantasyName: "",
    latitude: "",
    longitude: "",
    contact: "",
    phone: "",
    observation: "",
    status: "pending" as const
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: leads = [], isLoading } = useQuery<Lead[]>({
    queryKey: ['/api/leads'],
  });
  
  const { data: currentUser } = useQuery<any>({
    queryKey: ['/api/auth/user'],
  });

  const createLeadMutation = useMutation({
    mutationFn: async (data: any) => {
      return await apiRequest('POST', '/api/leads', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      setIsCreating(false);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Lead criado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar lead",
        variant: "destructive",
      });
    },
  });

  const updateLeadMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return await apiRequest('PATCH', `/api/leads/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      setEditingLead(null);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Lead atualizado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar lead",
        variant: "destructive",
      });
    },
  });

  const deleteLeadMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest('DELETE', `/api/leads/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      toast({
        title: "Sucesso",
        description: "Lead deletado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao deletar lead",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setFormData({
      fantasyName: "",
      latitude: "",
      longitude: "",
      contact: "",
      phone: "",
      observation: "",
      status: "pending"
    });
  };

  const handleCaptureLocation = () => {
    if (!navigator.geolocation) {
      toast({
        title: "Erro",
        description: "Seu navegador não suporta geolocalização",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Capturando localização",
      description: "Aguarde...",
    });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({
          ...formData,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6)
        });
        toast({
          title: "Sucesso",
          description: "Localização capturada!",
        });
      },
      (error) => {
        toast({
          title: "Erro",
          description: "Não foi possível capturar a localização",
          variant: "destructive",
        });
      }
    );
  };

  const handleSubmit = () => {
    if (!formData.fantasyName || !formData.latitude || !formData.longitude) {
      toast({
        title: "Erro",
        description: "Nome fantasia, latitude e longitude são obrigatórios",
        variant: "destructive",
      });
      return;
    }

    if (editingLead) {
      updateLeadMutation.mutate({
        id: editingLead.id,
        data: formData
      });
    } else {
      createLeadMutation.mutate(formData);
    }
  };

  const handleEdit = (lead: Lead) => {
    setEditingLead(lead);
    setFormData({
      fantasyName: lead.fantasyName,
      latitude: lead.latitude,
      longitude: lead.longitude,
      contact: lead.contact || "",
      phone: lead.phone || "",
      observation: lead.observation || "",
      status: lead.status
    });
  };

  const handleDelete = (id: string) => {
    if (window.confirm("Tem certeza que deseja deletar este lead?")) {
      deleteLeadMutation.mutate(id);
    }
  };

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'coordinator' || currentUser?.role === 'administrative';

  const statusLabels = {
    pending: "Pendente",
    contacted: "Contatado",
    converted: "Convertido",
    cancelled: "Cancelado"
  };

  const statusColors = {
    pending: "bg-yellow-100 text-yellow-800",
    contacted: "bg-blue-100 text-blue-800",
    converted: "bg-green-100 text-green-800",
    cancelled: "bg-gray-100 text-gray-800"
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Gestão de Leads</h1>
          <p className="text-muted-foreground">
            Gerenciar leads de clientes em potencial
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => setIsCreating(true)}
            data-testid="button-create-lead"
          >
            <Plus className="h-4 w-4 mr-2" />
            Novo Lead
          </Button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-honest-blue">{leads.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {leads.filter(l => l.status === 'pending').length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Contatados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {leads.filter(l => l.status === 'contacted').length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Convertidos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {leads.filter(l => l.status === 'converted').length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Leads List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {leads.map((lead) => (
          <Card key={lead.id} data-testid={`lead-card-${lead.id}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{lead.fantasyName}</CardTitle>
                <Badge className={statusColors[lead.status]}>
                  {statusLabels[lead.status]}
                </Badge>
              </div>
              <CardDescription>
                {lead.contact && (
                  <div className="flex items-center gap-1 text-sm">
                    <Users className="h-3 w-3" />
                    {lead.contact}
                  </div>
                )}
                {lead.phone && (
                  <div className="flex items-center gap-1 text-sm">
                    <Phone className="h-3 w-3" />
                    {lead.phone}
                  </div>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="h-4 w-4" />
                <span>{lead.latitude}, {lead.longitude}</span>
              </div>
              
              {lead.observation && (
                <p className="text-sm text-muted-foreground">
                  {lead.observation}
                </p>
              )}

              {isAdmin && (
                <div className="flex gap-2 mt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleEdit(lead)}
                    data-testid={`button-edit-lead-${lead.id}`}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(lead.id)}
                    data-testid={`button-delete-lead-${lead.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={isCreating || !!editingLead} onOpenChange={(open) => {
        if (!open) {
          setIsCreating(false);
          setEditingLead(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingLead ? "Editar Lead" : "Novo Lead"}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="fantasyName">Nome Fantasia *</Label>
              <Input
                id="fantasyName"
                value={formData.fantasyName}
                onChange={(e) => setFormData({ ...formData, fantasyName: e.target.value })}
                placeholder="Nome do lead"
                data-testid="input-fantasy-name"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="latitude">Latitude *</Label>
                <Input
                  id="latitude"
                  type="number"
                  step="0.000001"
                  value={formData.latitude}
                  onChange={(e) => setFormData({ ...formData, latitude: e.target.value })}
                  placeholder="-3.745678"
                  data-testid="input-latitude"
                />
              </div>

              <div>
                <Label htmlFor="longitude">Longitude *</Label>
                <Input
                  id="longitude"
                  type="number"
                  step="0.000001"
                  value={formData.longitude}
                  onChange={(e) => setFormData({ ...formData, longitude: e.target.value })}
                  placeholder="-38.523456"
                  data-testid="input-longitude"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={handleCaptureLocation}
              className="w-full"
              data-testid="button-capture-location"
            >
              <Navigation className="h-4 w-4 mr-2" />
              Capturar Localização Atual
            </Button>

            <div>
              <Label htmlFor="contact">Contato</Label>
              <Input
                id="contact"
                value={formData.contact}
                onChange={(e) => setFormData({ ...formData, contact: e.target.value })}
                placeholder="Nome do contato"
                data-testid="input-contact"
              />
            </div>

            <div>
              <Label htmlFor="phone">Telefone</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="(85) 99999-9999"
                data-testid="input-phone"
              />
            </div>

            <div>
              <Label htmlFor="observation">Observação</Label>
              <Textarea
                id="observation"
                value={formData.observation}
                onChange={(e) => setFormData({ ...formData, observation: e.target.value })}
                placeholder="Observações sobre o lead"
                rows={3}
                data-testid="input-observation"
              />
            </div>

            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                value={formData.status}
                onValueChange={(value: any) => setFormData({ ...formData, status: value })}
              >
                <SelectTrigger data-testid="select-status">
                  <SelectValue placeholder="Selecione o status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="contacted">Contatado</SelectItem>
                  <SelectItem value="converted">Convertido</SelectItem>
                  <SelectItem value="cancelled">Cancelado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setIsCreating(false);
                  setEditingLead(null);
                  resetForm();
                }}
                data-testid="button-cancel"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createLeadMutation.isPending || updateLeadMutation.isPending}
                data-testid="button-save-lead"
              >
                {editingLead ? "Atualizar" : "Criar Lead"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
