import { useState, useRef } from "react";
import { BRAZIL_TZ } from '@/lib/brazilTimezone';
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
import { Loader2, Plus, Pencil, Trash2, Star, Database, RefreshCw, Eye, EyeOff, Server, Shield, ShieldCheck, ShieldAlert, Upload, X } from "lucide-react";
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
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
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

  const [certDialogOpen, setCertDialogOpen] = useState(false);
  const [certInstanceId, setCertInstanceId] = useState<string | null>(null);
  const [certInstanceName, setCertInstanceName] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certPassword, setCertPassword] = useState("");
  const [certUploading, setCertUploading] = useState(false);
  const certFileRef = useRef<HTMLInputElement>(null);

  const { data: instances = [], isLoading, error } = useQuery<OmieInstance[]>({
    queryKey: ["/api/omie/instances"],
    enabled: !!user && user.role === "admin",
  });

  const { data: certStatuses = {} } = useQuery<Record<string, any>>({
    queryKey: ["/api/purchases/certificates-status"],
    enabled: !!user && user.role === "admin",
    select: (data: any) => {
      const map: Record<string, any> = {};
      if (data?.instances) {
        for (const inst of data.instances) {
          map[inst.instanceId] = inst;
        }
      }
      return map;
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: OmieInstanceFormData) =>
      apiRequest("POST", "/api/omie/instances", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      setIsDialogOpen(false);
      resetForm();
      toast({ title: "Sucesso", description: "Instância Omie criada com sucesso" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao criar instância", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<OmieInstanceFormData> }) =>
      apiRequest("PUT", `/api/omie/instances/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      setIsDialogOpen(false);
      setEditingInstance(null);
      resetForm();
      toast({ title: "Sucesso", description: "Instância atualizada com sucesso" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao atualizar instância", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/omie/instances/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      toast({ title: "Sucesso", description: "Instância excluída com sucesso" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao excluir instância", variant: "destructive" });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/omie/instances/${id}/set-default`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      toast({ title: "Sucesso", description: "Instância definida como padrão" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao definir instância padrão", variant: "destructive" });
    },
  });

  const [syncingInstanceId, setSyncingInstanceId] = useState<string | null>(null);
  
  const syncClientsMutation = useMutation({
    mutationFn: async (instanceId: string) => {
      setSyncingInstanceId(instanceId);
      return apiRequest("POST", "/api/omie/sync-active-clients", { omieInstanceId: instanceId });
    },
    onSuccess: (data: any) => {
      setSyncingInstanceId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      toast({
        title: "Sincronização concluída",
        description: `${data.imported || 0} clientes importados, ${data.updated || 0} atualizados`,
      });
    },
    onError: (error: any) => {
      setSyncingInstanceId(null);
      toast({ title: "Erro na sincronização", description: error.message || "Erro ao sincronizar clientes", variant: "destructive" });
    },
  });

  const handleUploadCert = async () => {
    if (!certFile || !certPassword || !certInstanceId) return;
    setCertUploading(true);
    try {
      const formData = new FormData();
      formData.append("pfxFile", certFile);
      formData.append("password", certPassword);
      const res = await fetch(`/api/omie/instances/${certInstanceId}/certificate`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao enviar certificado");
      toast({
        title: "Certificado cadastrado",
        description: `Certificado de ${data.certificate?.companyName || "empresa"} cadastrado com sucesso`,
      });
      setCertDialogOpen(false);
      setCertFile(null);
      setCertPassword("");
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/certificates-status"] });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setCertUploading(false);
    }
  };

  const handleDeleteCert = async (instanceId: string, instanceName: string) => {
    if (!window.confirm(`Remover o certificado digital da instância ${instanceName}?`)) return;
    try {
      const res = await apiRequest("DELETE", `/api/omie/instances/${instanceId}/certificate`);
      toast({ title: "Sucesso", description: "Certificado removido" });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/certificates-status"] });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };

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

  const formatDoc = (doc: string) => {
    if (!doc) return "";
    const d = doc.replace(/\D/g, "");
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    return doc;
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
                    await apiRequest("POST", "/api/omie/instances/init-default");
                    toast({ title: "Sucesso", description: "Instância padrão OMIE GYN criada com sucesso" });
                    queryClient.invalidateQueries({ queryKey: ["/api/omie/instances"] });
                  } catch (error: any) {
                    toast({ title: "Erro", description: error.message || "Erro ao criar instância padrão", variant: "destructive" });
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
                  <TableHead>CNPJ</TableHead>
                  <TableHead>Certificado Digital</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Última Sincronização</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((instance) => {
                  const certStatus = certStatuses[instance.id];
                  return (
                    <TableRow key={instance.id}>
                      <TableCell>
                        <Badge
                          style={{ backgroundColor: instance.tagColor, color: "#fff" }}
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
                        {instance.cnpj ? (
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {formatDoc(instance.cnpj)}
                          </code>
                        ) : (
                          <span className="text-xs text-muted-foreground">Auto-detectar</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {certStatus?.hasCertificate ? (
                          <div className="flex items-center gap-2">
                            {certStatus.certificateValid ? (
                              <Badge variant="default" className="bg-green-600 text-xs flex items-center gap-1">
                                <ShieldCheck className="h-3 w-3" />
                                Válido
                              </Badge>
                            ) : (
                              <Badge variant="destructive" className="text-xs flex items-center gap-1">
                                <ShieldAlert className="h-3 w-3" />
                                Expirado
                              </Badge>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                              onClick={() => handleDeleteCert(instance.id, instance.name)}
                              title="Remover certificado"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              setCertInstanceId(instance.id);
                              setCertInstanceName(instance.name);
                              setCertFile(null);
                              setCertPassword("");
                              setCertDialogOpen(true);
                            }}
                          >
                            <Upload className="h-3 w-3 mr-1" />
                            Importar PFX
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={instance.isActive ? "default" : "secondary"}>
                          {instance.isActive ? "Ativa" : "Inativa"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {instance.lastSyncAt
                          ? new Date(instance.lastSyncAt).toLocaleString("pt-BR", { timeZone: BRAZIL_TZ })
                          : "Nunca"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => syncClientsMutation.mutate(instance.id)}
                            disabled={syncingInstanceId === instance.id || !instance.isActive}
                            title={instance.isActive ? "Sincronizar clientes" : "Instância inativa"}
                            className="text-blue-600 hover:text-blue-700"
                          >
                            {syncingInstanceId === instance.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
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
                          <Button variant="ghost" size="sm" onClick={() => handleOpenEdit(instance)} title="Editar">
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
                  );
                })}
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
                  onChange={(e) => setFormData({ ...formData, name: e.target.value.toUpperCase() })}
                  maxLength={10}
                  required
                />
                <p className="text-xs text-gray-500">Sigla que aparecerá nas badges de identificação</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="displayName">Nome Completo</Label>
                <Input
                  id="displayName"
                  placeholder="Ex: OMIE GYN - Goiânia"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
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
                    onChange={(e) => setFormData({ ...formData, appKey: e.target.value })}
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
                  onChange={(e) => setFormData({ ...formData, appSecret: e.target.value })}
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
                        formData.tagColor === color ? "border-gray-800 scale-110" : "border-transparent"
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => setFormData({ ...formData, tagColor: color })}
                    />
                  ))}
                  <Input
                    type="color"
                    value={formData.tagColor}
                    onChange={(e) => setFormData({ ...formData, tagColor: e.target.value })}
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
                    onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
                  />
                  <Label htmlFor="isActive">Instância Ativa</Label>
                </div>
                {!editingInstance && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id="isDefault"
                      checked={formData.isDefault}
                      onCheckedChange={(checked) => setFormData({ ...formData, isDefault: checked })}
                    />
                    <Label htmlFor="isDefault">Definir como padrão</Label>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {editingInstance ? "Salvar" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={certDialogOpen} onOpenChange={setCertDialogOpen}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-600" />
              Certificado Digital A1 — {certInstanceName}
            </DialogTitle>
            <DialogDescription>
              Importe o arquivo PFX/P12 do certificado digital A1 e informe a senha.
              O certificado será vinculado automaticamente à instância pelo CNPJ.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Arquivo PFX/P12</Label>
              <input
                ref={certFileRef}
                type="file"
                accept=".pfx,.p12"
                className="hidden"
                onChange={(e) => setCertFile(e.target.files?.[0] || null)}
              />
              <div
                className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 transition-colors"
                onClick={() => certFileRef.current?.click()}
              >
                {certFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <Shield className="h-5 w-5 text-green-600" />
                    <span className="font-medium text-sm">{certFile.name}</span>
                    <span className="text-xs text-muted-foreground">({(certFile.size / 1024).toFixed(1)} KB)</span>
                  </div>
                ) : (
                  <div>
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Clique para selecionar o arquivo .pfx ou .p12</p>
                  </div>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="certPassword">Senha do Certificado</Label>
              <Input
                id="certPassword"
                type="password"
                placeholder="Digite a senha do certificado"
                value={certPassword}
                onChange={(e) => setCertPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCertDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleUploadCert}
              disabled={!certFile || !certPassword || certUploading}
            >
              {certUploading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {certUploading ? "Processando..." : "Importar Certificado"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
