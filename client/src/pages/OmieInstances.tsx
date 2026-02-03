import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Loader2, Plus, Pencil, Trash2, Star, Database, RefreshCw, Eye, EyeOff, Server } from "lucide-react";
import type { OmieInstance } from "@shared/schema";

interface OmieInstanceFormData {
  name: string;
  displayName: string;
  appKey: string;
  appSecret: string;
  tagColor: string;
  isActive: boolean;
  isDefault: boolean;
}

const defaultFormData: OmieInstanceFormData = {
  name: "",
  displayName: "",
  appKey: "",
  appSecret: "",
  tagColor: "#3B82F6",
  isActive: true,
  isDefault: false,
};

const PRESET_COLORS = [
  "#3B82F6", // Blue
  "#10B981", // Green
  "#F59E0B", // Amber
  "#EF4444", // Red
  "#8B5CF6", // Purple
  "#EC4899", // Pink
  "#06B6D4", // Cyan
  "#F97316", // Orange
];

export default function OmieInstances() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingInstance, setEditingInstance] = useState<OmieInstance | null>(null);
  const [formData, setFormData] = useState<OmieInstanceFormData>(defaultFormData);
  const [showSecrets, setShowSecrets] = useState(false);

  const { data: instances = [], isLoading, error } = useQuery<OmieInstance[]>({
    queryKey: ["/api/omie/instances"],
    enabled: !!user && user.role === "admin",
  });

  const createMutation = useMutation({
    mutationFn: (data: OmieInstanceFormData) =>
      apiRequest("/api/omie/instances", "POST", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      setIsDialogOpen(false);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Instância Omie criada com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar instância",
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<OmieInstanceFormData> }) =>
      apiRequest(`/api/omie/instances/${id}`, "PUT", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      setIsDialogOpen(false);
      setEditingInstance(null);
      resetForm();
      toast({
        title: "Sucesso",
        description: "Instância atualizada com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar instância",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/omie/instances/${id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      toast({
        title: "Sucesso",
        description: "Instância excluída com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao excluir instância",
        variant: "destructive",
      });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/omie/instances/${id}/set-default`, "POST"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      toast({
        title: "Sucesso",
        description: "Instância definida como padrão",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao definir instância padrão",
        variant: "destructive",
      });
    },
  });

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!user || user.role !== "admin") {
    setLocation("/");
    return null;
  }

  const resetForm = () => {
    setFormData(defaultFormData);
    setEditingInstance(null);
    setShowSecrets(false);
  };

  const handleOpenCreate = () => {
    resetForm();
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (instance: OmieInstance) => {
    setEditingInstance(instance);
    setFormData({
      name: instance.name,
      displayName: instance.displayName,
      appKey: instance.appKey,
      appSecret: instance.appSecret,
      tagColor: instance.tagColor,
      isActive: instance.isActive,
      isDefault: instance.isDefault,
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingInstance) {
      updateMutation.mutate({ id: editingInstance.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (instance: OmieInstance) => {
    if (instance.isDefault) {
      toast({
        title: "Ação não permitida",
        description: "Não é possível excluir a instância padrão. Defina outra como padrão antes.",
        variant: "destructive",
      });
      return;
    }
    if (window.confirm(`Tem certeza que deseja excluir a instância "${instance.displayName}"?`)) {
      deleteMutation.mutate(instance.id);
    }
  };

  const maskSecret = (secret: string) => {
    if (!secret) return "";
    if (secret.length <= 8) return "••••••••";
    return secret.substring(0, 4) + "••••" + secret.substring(secret.length - 4);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <BackToDashboardButton />
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <Server className="h-6 w-6 text-blue-600" />
              Instâncias Omie ERP
            </h1>
            <p className="text-gray-500 text-sm">
              Gerencie múltiplas contas Omie para sincronização de dados
            </p>
          </div>
        </div>
        <Button onClick={handleOpenCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Nova Instância
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Instâncias Configuradas ({instances.length})
          </CardTitle>
          <CardDescription>
            Cada instância representa uma conta Omie ERP separada. Os dados sincronizados serão identificados pela tag colorida correspondente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-red-500 text-center py-4">
              Erro ao carregar instâncias: {String(error)}
            </div>
          ) : instances.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Database className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>Nenhuma instância Omie configurada.</p>
              <p className="text-sm mb-4">Clique em "Nova Instância" para adicionar manualmente ou use o botão abaixo para criar automaticamente.</p>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const response = await apiRequest("/api/omie/instances/init-default", "POST");
                    toast({
                      title: "Sucesso",
                      description: "Instância padrão OMIE GYN criada com sucesso",
                    });
                    queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
                  } catch (error: any) {
                    toast({
                      title: "Erro",
                      description: error.message || "Erro ao criar instância padrão",
                      variant: "destructive",
                    });
                  }
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Inicializar com variáveis de ambiente (OMIE GYN)
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tag</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>App Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Última Sincronização</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((instance) => (
                  <TableRow key={instance.id}>
                    <TableCell>
                      <Badge
                        style={{
                          backgroundColor: instance.tagColor,
                          color: "#fff",
                        }}
                        className="font-semibold"
                      >
                        {instance.name}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{instance.displayName}</span>
                        {instance.isDefault && (
                          <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                        {maskSecret(instance.appKey)}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge variant={instance.isActive ? "default" : "secondary"}>
                        {instance.isActive ? "Ativa" : "Inativa"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {instance.lastSyncAt
                        ? new Date(instance.lastSyncAt).toLocaleString("pt-BR")
                        : "Nunca"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {!instance.isDefault && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDefaultMutation.mutate(instance.id)}
                            disabled={setDefaultMutation.isPending}
                            title="Definir como padrão"
                          >
                            <Star className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenEdit(instance)}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(instance)}
                          disabled={deleteMutation.isPending || instance.isDefault}
                          title={instance.isDefault ? "Não é possível excluir a instância padrão" : "Excluir"}
                          className={instance.isDefault ? "opacity-50 cursor-not-allowed" : "text-red-600 hover:text-red-700"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingInstance ? "Editar Instância Omie" : "Nova Instância Omie"}
            </DialogTitle>
            <DialogDescription>
              {editingInstance
                ? "Atualize as informações da instância Omie."
                : "Configure uma nova conta Omie para sincronização de dados."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Tag (sigla)</Label>
                <Input
                  id="name"
                  placeholder="Ex: GYN, BSB, RJ"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value.toUpperCase() })
                  }
                  maxLength={10}
                  required
                />
                <p className="text-xs text-gray-500">
                  Sigla que aparecerá nas badges de identificação
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="displayName">Nome Completo</Label>
                <Input
                  id="displayName"
                  placeholder="Ex: OMIE GYN - Goiânia"
                  value={formData.displayName}
                  onChange={(e) =>
                    setFormData({ ...formData, displayName: e.target.value })
                  }
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="appKey">App Key</Label>
                <div className="relative">
                  <Input
                    id="appKey"
                    type={showSecrets ? "text" : "password"}
                    placeholder="Chave APP do Omie"
                    value={formData.appKey}
                    onChange={(e) =>
                      setFormData({ ...formData, appKey: e.target.value })
                    }
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setShowSecrets(!showSecrets)}
                  >
                    {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="appSecret">App Secret</Label>
                <Input
                  id="appSecret"
                  type={showSecrets ? "text" : "password"}
                  placeholder="Chave Secret do Omie"
                  value={formData.appSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, appSecret: e.target.value })
                  }
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label>Cor da Tag</Label>
                <div className="flex gap-2 flex-wrap">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`w-8 h-8 rounded-full border-2 transition-all ${
                        formData.tagColor === color
                          ? "border-gray-800 scale-110"
                          : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => setFormData({ ...formData, tagColor: color })}
                    />
                  ))}
                  <Input
                    type="color"
                    value={formData.tagColor}
                    onChange={(e) =>
                      setFormData({ ...formData, tagColor: e.target.value })
                    }
                    className="w-8 h-8 p-0 border-0 cursor-pointer"
                    title="Cor personalizada"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="isActive"
                    checked={formData.isActive}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, isActive: checked })
                    }
                  />
                  <Label htmlFor="isActive">Instância Ativa</Label>
                </div>
                {!editingInstance && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id="isDefault"
                      checked={formData.isDefault}
                      onCheckedChange={(checked) =>
                        setFormData({ ...formData, isDefault: checked })
                      }
                    />
                    <Label htmlFor="isDefault">Definir como padrão</Label>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {editingInstance ? "Salvar" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
