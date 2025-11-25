import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { queryClient } from "@/lib/queryClient";
import { Plus, Trash2, Edit2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface QuickTemplate {
  id: string;
  title: string;
  content: string;
  category: string;
  isActive: boolean;
  createdAt: string;
}

export default function QuickTemplates() {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ title: "", content: "", category: "geral" });

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["/api/chat/quick-templates"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      return fetch("/api/chat/quick-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Template criado!" });
      setFormData({ title: "", content: "", category: "geral" });
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/chat/quick-templates"] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return fetch(`/api/chat/quick-templates/${id}`, {
        method: "DELETE"
      }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Template deletado" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/quick-templates"] });
    }
  });

  const handleSubmit = async () => {
    if (!formData.title || !formData.content) {
      toast({ title: "Erro", description: "Preencha todos os campos", variant: "destructive" });
      return;
    }
    await createMutation.mutateAsync(formData);
  };

  const categories = [
    { value: "geral", label: "Geral" },
    { value: "saudacao", label: "Saudação" },
    { value: "vendas", label: "Vendas" },
    { value: "suporte", label: "Suporte" },
    { value: "despedida", label: "Despedida" }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Templates de Resposta Rápida</h1>
            <p className="text-gray-600">Crie respostas padrão para agilizar o atendimento</p>
          </div>
          <BackToDashboardButton />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Formulário */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-lg">Novo Template</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium">Título</label>
                <Input
                  placeholder="Ex: Saudação"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  data-testid="input-template-title"
                />
              </div>

              <div>
                <label className="text-sm font-medium">Categoria</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  data-testid="select-template-category"
                >
                  {categories.map(cat => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm font-medium">Mensagem</label>
                <Textarea
                  placeholder="Digite a mensagem..."
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  data-testid="textarea-template-content"
                  rows={4}
                />
              </div>

              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-save-template"
                className="w-full"
              >
                <Plus className="w-4 h-4 mr-2" />
                Salvar Template
              </Button>
            </CardContent>
          </Card>

          {/* Lista de Templates */}
          <div className="lg:col-span-2 space-y-4">
            {isLoading ? (
              <Card><CardContent className="py-8 text-center text-gray-500">Carregando...</CardContent></Card>
            ) : (templates as QuickTemplate[]).length === 0 ? (
              <Card><CardContent className="py-8 text-center text-gray-500">Nenhum template criado</CardContent></Card>
            ) : (
              (templates as QuickTemplate[]).map((template) => (
                <Card key={template.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-base">{template.title}</CardTitle>
                        <Badge variant="outline" className="mt-2">{template.category}</Badge>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteMutation.mutate(template.id)}
                        data-testid={`button-delete-template-${template.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{template.content}</p>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
