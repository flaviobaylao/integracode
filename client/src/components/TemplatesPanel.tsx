import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MessageSquareText, Plus, Edit2, Trash2, Image as ImageIcon, Send, X, Loader2, Settings } from "lucide-react";

interface Template {
  id: string;
  title: string;
  content: string;
  messageType: string;
  imageUrl: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
}

interface TemplatesPanelProps {
  onSelectTemplate: (template: Template) => void;
  onSendImage?: (imageUrl: string, caption: string) => void;
  isAdmin: boolean;
  hasActiveConversation: boolean;
}

export function TemplatesPanel({ onSelectTemplate, onSendImage, isAdmin, hasActiveConversation }: TemplatesPanelProps) {
  const { toast } = useToast();
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    imageUrl: "",
    category: ""
  });

  const { data: templates = [], isLoading, refetch } = useQuery<Template[]>({
    queryKey: ["/api/chat/quick-templates"],
    refetchInterval: 30000
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return apiRequest("POST", "/api/chat/quick-templates", data);
    },
    onSuccess: () => {
      toast({ title: "Template criado com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/quick-templates"] });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao criar template", variant: "destructive" });
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      return apiRequest("PUT", `/api/chat/quick-templates/${id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Template atualizado com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/quick-templates"] });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao atualizar template", variant: "destructive" });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/chat/quick-templates/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Template removido com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/quick-templates"] });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao remover template", variant: "destructive" });
    }
  });

  const resetForm = () => {
    setFormData({ title: "", content: "", imageUrl: "", category: "" });
    setEditingTemplate(null);
  };

  const handleEdit = (template: Template) => {
    setEditingTemplate(template);
    setFormData({
      title: template.title,
      content: template.content,
      imageUrl: template.imageUrl || "",
      category: template.category || ""
    });
  };

  const handleSubmit = () => {
    if (!formData.title.trim()) {
      toast({ title: "Erro", description: "Informe o título do template", variant: "destructive" });
      return;
    }
    if (!formData.content.trim() && !formData.imageUrl.trim()) {
      toast({ title: "Erro", description: "Informe o conteúdo ou uma imagem", variant: "destructive" });
      return;
    }

    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleTemplateClick = (template: Template) => {
    if (!hasActiveConversation) {
      toast({ title: "Atenção", description: "Selecione uma conversa primeiro", variant: "destructive" });
      return;
    }

    if (template.imageUrl && onSendImage) {
      onSendImage(template.imageUrl, template.content);
    } else {
      onSelectTemplate(template);
    }
  };

  const groupedTemplates = templates.reduce((acc, template) => {
    const category = template.category || "Geral";
    if (!acc[category]) acc[category] = [];
    acc[category].push(template);
    return acc;
  }, {} as Record<string, Template[]>);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2 shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquareText className="w-4 h-4" />
            Templates
          </CardTitle>
          {isAdmin && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowManageDialog(true)}
              className="h-7 w-7 p-0"
              title="Gerenciar templates"
            >
              <Settings className="w-4 h-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-2">
        <ScrollArea className="h-full">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-xs">
              <MessageSquareText className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p>Nenhum template</p>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => setShowManageDialog(true)}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Criar
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(groupedTemplates).map(([category, categoryTemplates]) => (
                <div key={category}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 px-1">
                    {category}
                  </p>
                  <div className="space-y-1">
                    {categoryTemplates.map((template) => (
                      <div
                        key={template.id}
                        onClick={() => handleTemplateClick(template)}
                        className={`p-2 rounded-lg border cursor-pointer transition-all hover:shadow-sm ${
                          hasActiveConversation 
                            ? "hover:bg-green-50 hover:border-green-300" 
                            : "opacity-60 cursor-not-allowed"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {template.imageUrl && (
                            <div className="shrink-0 w-8 h-8 rounded bg-gray-100 overflow-hidden">
                              <img 
                                src={template.imageUrl} 
                                alt="" 
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">
                              {template.title}
                            </p>
                            {template.content && (
                              <p className="text-[10px] text-gray-500 line-clamp-2 mt-0.5">
                                {template.content}
                              </p>
                            )}
                          </div>
                          <Send className="w-3 h-3 text-gray-400 shrink-0" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>

      <Dialog open={showManageDialog} onOpenChange={setShowManageDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Gerenciar Templates de Resposta</DialogTitle>
            <DialogDescription>
              Crie e gerencie mensagens pré-redigidas para uso rápido no atendimento
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden grid grid-cols-2 gap-4">
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">
                {editingTemplate ? "Editar Template" : "Novo Template"}
              </h3>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="title">Título *</Label>
                  <Input
                    id="title"
                    placeholder="Ex: Saudação inicial"
                    value={formData.title}
                    onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="content">Mensagem</Label>
                  <Textarea
                    id="content"
                    placeholder="Digite a mensagem do template..."
                    value={formData.content}
                    onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                    rows={4}
                  />
                </div>
                <div>
                  <Label htmlFor="imageUrl">URL da Imagem (opcional)</Label>
                  <Input
                    id="imageUrl"
                    placeholder="https://exemplo.com/imagem.jpg"
                    value={formData.imageUrl}
                    onChange={(e) => setFormData(prev => ({ ...prev, imageUrl: e.target.value }))}
                  />
                  {formData.imageUrl && (
                    <div className="mt-2 relative w-20 h-20 rounded overflow-hidden border">
                      <img 
                        src={formData.imageUrl} 
                        alt="Preview" 
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = '';
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                </div>
                <div>
                  <Label htmlFor="category">Categoria (opcional)</Label>
                  <Input
                    id="category"
                    placeholder="Ex: Vendas, Suporte"
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleSubmit}
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="flex-1"
                  >
                    {(createMutation.isPending || updateMutation.isPending) && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    {editingTemplate ? "Salvar" : "Criar"}
                  </Button>
                  {editingTemplate && (
                    <Button variant="outline" onClick={resetForm}>
                      Cancelar
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="border-l pl-4">
              <h3 className="font-semibold text-sm mb-3">Templates Existentes</h3>
              <ScrollArea className="h-[350px]">
                <div className="space-y-2 pr-2">
                  {templates.map((template) => (
                    <div
                      key={template.id}
                      className="p-2 rounded border bg-gray-50 hover:bg-gray-100 transition"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {template.imageUrl && <ImageIcon className="w-3 h-3 text-blue-500" />}
                            <p className="text-sm font-medium truncate">{template.title}</p>
                          </div>
                          {template.content && (
                            <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{template.content}</p>
                          )}
                          {template.category && (
                            <Badge variant="secondary" className="text-[10px] mt-1">
                              {template.category}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            onClick={() => handleEdit(template)}
                          >
                            <Edit2 className="w-3 h-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                            onClick={() => {
                              if (confirm("Remover este template?")) {
                                deleteMutation.mutate(template.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {templates.length === 0 && (
                    <p className="text-center text-gray-400 text-sm py-4">
                      Nenhum template criado
                    </p>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowManageDialog(false)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
