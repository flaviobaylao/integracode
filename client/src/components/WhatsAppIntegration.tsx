import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { MessageTemplate, CustomerWithSeller } from "@shared/schema";

export default function WhatsAppIntegration() {
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: templates, isLoading: templatesLoading } = useQuery({
    queryKey: ['/api/message-templates'],
    retry: false,
  });

  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['/api/customers'],
    retry: false,
  });

  const { data: messageHistory, isLoading: historyLoading } = useQuery({
    queryKey: ['/api/whatsapp/history'],
    retry: false,
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (data: {
      customerId: string;
      message: string;
      templateId?: string;
    }) => {
      await apiRequest('POST', '/api/whatsapp/send', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/whatsapp/history'] });
      setSelectedCustomer('');
      setSelectedTemplate('');
      setCustomMessage('');
      toast({
        title: "Sucesso",
        description: "Mensagem enviada com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createTemplateMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      category: string;
      message: string;
    }) => {
      await apiRequest('POST', '/api/message-templates', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/message-templates'] });
      setShowTemplateModal(false);
      setEditingTemplate(null);
      toast({
        title: "Sucesso",
        description: "Template criado com sucesso!",
      });
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSendMessage = () => {
    if (!selectedCustomer || !customMessage) {
      toast({
        title: "Erro",
        description: "Selecione um cliente e digite uma mensagem",
        variant: "destructive",
      });
      return;
    }

    sendMessageMutation.mutate({
      customerId: selectedCustomer,
      message: customMessage,
      templateId: selectedTemplate || undefined,
    });
  };

  const handleUseTemplate = (template: MessageTemplate) => {
    setSelectedTemplate(template.id);
    setCustomMessage(template.message);
  };

  const openWhatsAppDirect = (phone: string, message: string) => {
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/55${phone.replace(/\D/g, '')}?text=${encodedMessage}`;
    window.open(whatsappUrl, '_blank');
  };

  if (templatesLoading || customersLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-800">WhatsApp Business</h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="animate-pulse">
            <CardContent className="p-6">
              <div className="h-64 bg-gray-200 rounded"></div>
            </CardContent>
          </Card>
          <Card className="animate-pulse">
            <CardContent className="p-6">
              <div className="h-64 bg-gray-200 rounded"></div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-800">WhatsApp Business</h2>
        <Button
          className="bg-green-500 hover:bg-green-600 text-white"
          onClick={() => setShowTemplateModal(true)}
        >
          <i className="fas fa-plus mr-2"></i>Nova Mensagem
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Message Templates */}
        <Card>
          <CardHeader className="border-b border-gray-200">
            <CardTitle className="text-lg font-semibold text-gray-800">
              Templates de Mensagens
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            {templates && templates.length > 0 ? (
              templates.map((template: MessageTemplate) => (
                <div key={template.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-gray-800">{template.name}</h4>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingTemplate(template);
                          setShowTemplateModal(true);
                        }}
                      >
                        <i className="fas fa-edit text-sm"></i>
                      </Button>
                    </div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <p className="text-sm text-gray-700">{template.message}</p>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
                    <span>Categoria: {template.category}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-green-600 hover:text-green-700"
                      onClick={() => handleUseTemplate(template)}
                    >
                      <i className="fab fa-whatsapp mr-1"></i>Usar
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-gray-500 text-center py-8">
                Nenhum template encontrado
              </p>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="space-y-6">
          {/* Send Message */}
          <Card>
            <CardHeader className="border-b border-gray-200">
              <CardTitle className="text-lg font-semibold text-gray-800">
                Enviar Mensagem
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <div>
                <Label htmlFor="customer">Cliente</Label>
                <Select value={selectedCustomer} onValueChange={setSelectedCustomer}>
                  <SelectTrigger>
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
              </div>
              
              <div>
                <Label htmlFor="template">Template</Label>
                <Select value={selectedTemplate} onValueChange={(value) => {
                  setSelectedTemplate(value);
                  const template = templates?.find((t: MessageTemplate) => t.id === value);
                  if (template) {
                    setCustomMessage(template.message);
                  }
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Mensagem personalizada" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Mensagem personalizada</SelectItem>
                    {templates?.map((template: MessageTemplate) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label htmlFor="message">Mensagem</Label>
                <Textarea
                  rows={4}
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  placeholder="Digite sua mensagem..."
                />
              </div>
              
              <Button
                className="w-full bg-green-500 hover:bg-green-600 text-white"
                onClick={handleSendMessage}
                disabled={sendMessageMutation.isPending}
              >
                <i className="fab fa-whatsapp mr-2"></i>
                {sendMessageMutation.isPending ? 'Enviando...' : 'Enviar via WhatsApp'}
              </Button>
            </CardContent>
          </Card>

          {/* Recent Messages */}
          <Card>
            <CardHeader className="border-b border-gray-200">
              <CardTitle className="text-lg font-semibold text-gray-800">
                Mensagens Recentes
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-3">
              {messageHistory && messageHistory.length > 0 ? (
                messageHistory.slice(0, 5).map((message: any) => (
                  <div key={message.id} className="flex items-start space-x-3">
                    <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <i className="fab fa-whatsapp text-green-600 text-sm"></i>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-gray-800">Cliente</span>
                        <span className="text-xs text-gray-500">
                          {new Date(message.sentAt).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 truncate">
                        {message.message.substring(0, 50)}...
                      </p>
                    </div>
                    <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                      Enviado
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center py-8">
                  Nenhuma mensagem enviada
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Template Modal */}
      <Dialog open={showTemplateModal} onOpenChange={setShowTemplateModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? 'Editar Template' : 'Novo Template'}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              createTemplateMutation.mutate({
                name: formData.get('name') as string,
                category: formData.get('category') as string,
                message: formData.get('message') as string,
              });
            }}
          >
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Nome do Template</Label>
                <Input
                  id="name"
                  name="name"
                  defaultValue={editingTemplate?.name}
                  required
                />
              </div>
              <div>
                <Label htmlFor="category">Categoria</Label>
                <Select name="category" defaultValue={editingTemplate?.category} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione uma categoria" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agendamento">Agendamento</SelectItem>
                    <SelectItem value="pos-venda">Pós-venda</SelectItem>
                    <SelectItem value="promocao">Promoção</SelectItem>
                    <SelectItem value="cobranca">Cobrança</SelectItem>
                    <SelectItem value="geral">Geral</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="message">Mensagem</Label>
                <Textarea
                  id="message"
                  name="message"
                  rows={4}
                  defaultValue={editingTemplate?.message}
                  placeholder="Digite a mensagem do template..."
                  required
                />
              </div>
              <div className="flex justify-end space-x-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowTemplateModal(false);
                    setEditingTemplate(null);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  className="bg-green-500 hover:bg-green-600"
                  disabled={createTemplateMutation.isPending}
                >
                  {createTemplateMutation.isPending ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
