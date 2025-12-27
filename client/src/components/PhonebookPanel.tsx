import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { 
  Phone, User, Search, Plus, Edit, Trash2, MessageCircle, 
  Link as LinkIcon, Unlink, Building2 
} from "lucide-react";

interface PhonebookContact {
  id: string;
  name: string;
  phone: string;
  notes: string | null;
  customerId: string | null;
  createdByUserId: string | null;
  lastContactedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Customer {
  id: string;
  fantasyName: string;
  companyName: string;
  phone: string;
}

interface PhonebookPanelProps {
  onStartConversation?: (phone: string, name: string) => void;
}

export function PhonebookPanel({ onStartConversation }: PhonebookPanelProps) {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingContact, setEditingContact] = useState<PhonebookContact | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    notes: "",
    customerId: ""
  });

  const { data: contacts = [], isLoading } = useQuery<PhonebookContact[]>({
    queryKey: ["/api/phonebook-contacts", searchTerm],
    queryFn: async () => {
      const params = searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : "";
      const response = await fetch(`/api/phonebook-contacts${params}`, { credentials: "include" });
      if (!response.ok) throw new Error("Erro ao buscar contatos");
      return response.json();
    }
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    select: (data: any[]) => data.slice(0, 100)
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return apiRequest("POST", "/api/phonebook-contacts", data);
    },
    onSuccess: () => {
      toast({ title: "Contato adicionado", description: "O contato foi salvo na agenda" });
      queryClient.invalidateQueries({ queryKey: ["/api/phonebook-contacts"] });
      resetForm();
      setShowAddDialog(false);
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof formData> }) => {
      return apiRequest("PATCH", `/api/phonebook-contacts/${id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Contato atualizado", description: "As alterações foram salvas" });
      queryClient.invalidateQueries({ queryKey: ["/api/phonebook-contacts"] });
      resetForm();
      setEditingContact(null);
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/phonebook-contacts/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Contato removido", description: "O contato foi excluído da agenda" });
      queryClient.invalidateQueries({ queryKey: ["/api/phonebook-contacts"] });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  });

  const resetForm = () => {
    setFormData({ name: "", phone: "", notes: "", customerId: "" });
  };

  const handleEdit = (contact: PhonebookContact) => {
    setEditingContact(contact);
    setFormData({
      name: contact.name,
      phone: contact.phone,
      notes: contact.notes || "",
      customerId: contact.customerId || ""
    });
    setShowAddDialog(true);
  };

  const handleSubmit = () => {
    if (!formData.name || !formData.phone) {
      toast({ title: "Erro", description: "Nome e telefone são obrigatórios", variant: "destructive" });
      return;
    }

    if (editingContact) {
      updateMutation.mutate({ id: editingContact.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleStartChat = (contact: PhonebookContact) => {
    if (onStartConversation) {
      onStartConversation(contact.phone, contact.name);
    }
  };

  const formatPhone = (phone: string) => {
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length === 13) {
      return `+${cleaned.slice(0, 2)} (${cleaned.slice(2, 4)}) ${cleaned.slice(4, 9)}-${cleaned.slice(9)}`;
    }
    if (cleaned.length === 11) {
      return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
  };

  const getLinkedCustomerName = (customerId: string | null) => {
    if (!customerId) return null;
    const customer = customers.find(c => c.id === customerId);
    return customer?.fantasyName || customer?.companyName || "Cliente vinculado";
  };

  return (
    <Card className="h-full flex flex-col" data-testid="phonebook-panel">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Phone className="w-5 h-5" />
            Agenda Telefônica
          </CardTitle>
          <Button 
            size="sm" 
            onClick={() => { resetForm(); setEditingContact(null); setShowAddDialog(true); }}
            data-testid="button-add-contact"
          >
            <Plus className="w-4 h-4 mr-1" />
            Adicionar
          </Button>
        </div>
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <Input
            placeholder="Buscar contatos..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
            data-testid="input-search-contacts"
          />
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full px-4 pb-4">
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">Carregando...</div>
          ) : contacts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {searchTerm ? "Nenhum contato encontrado" : "Nenhum contato na agenda"}
            </div>
          ) : (
            <div className="space-y-2">
              {contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                  data-testid={`contact-item-${contact.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-gray-400" />
                        <span className="font-medium text-sm truncate">{contact.name}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Phone className="w-3 h-3 text-gray-400" />
                        <span className="text-xs text-gray-600">{formatPhone(contact.phone)}</span>
                      </div>
                      {contact.customerId && (
                        <div className="flex items-center gap-1 mt-1">
                          <Building2 className="w-3 h-3 text-blue-500" />
                          <Badge variant="outline" className="text-[10px] h-4 bg-blue-50 text-blue-700">
                            {getLinkedCustomerName(contact.customerId)}
                          </Badge>
                        </div>
                      )}
                      {contact.notes && (
                        <p className="text-xs text-gray-500 mt-1 line-clamp-1">{contact.notes}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleStartChat(contact)}
                        title="Iniciar conversa"
                        data-testid={`button-chat-${contact.id}`}
                      >
                        <MessageCircle className="w-4 h-4 text-green-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleEdit(contact)}
                        title="Editar"
                        data-testid={`button-edit-${contact.id}`}
                      >
                        <Edit className="w-4 h-4 text-blue-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          if (confirm("Deseja remover este contato?")) {
                            deleteMutation.mutate(contact.id);
                          }
                        }}
                        title="Excluir"
                        data-testid={`button-delete-${contact.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingContact ? "Editar Contato" : "Novo Contato"}
            </DialogTitle>
            <DialogDescription>
              {editingContact 
                ? "Atualize as informações do contato" 
                : "Adicione um novo contato à agenda telefônica"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="name">Nome *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Nome do contato"
                data-testid="input-contact-name"
              />
            </div>

            <div>
              <Label htmlFor="phone">Telefone *</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value.replace(/\D/g, "") })}
                placeholder="62999999999"
                data-testid="input-contact-phone"
              />
            </div>

            <div>
              <Label htmlFor="notes">Observações</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Notas sobre o contato..."
                rows={2}
                data-testid="input-contact-notes"
              />
            </div>

            <div>
              <Label htmlFor="customer">Vincular a Cliente</Label>
              <Select
                value={formData.customerId}
                onValueChange={(value) => setFormData({ ...formData, customerId: value === "none" ? "" : value })}
              >
                <SelectTrigger data-testid="select-customer">
                  <SelectValue placeholder="Selecione um cliente (opcional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {customers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id}>
                      {customer.fantasyName || customer.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancelar
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save-contact"
            >
              {(createMutation.isPending || updateMutation.isPending) 
                ? "Salvando..." 
                : (editingContact ? "Salvar" : "Adicionar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
