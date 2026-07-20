import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Location, InsertLocation } from "@shared/schema";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function LocationsManagement() {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch locations
  const { data: locations = [], isLoading } = useQuery<Location[]>({
    queryKey: ['/api/locations'],
    enabled: true,
  });

  // Create location mutation
  const createLocationMutation = useMutation({
    mutationFn: (data: InsertLocation) =>
      apiRequest('/api/locations', 'POST', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/locations'] });
      setIsCreateDialogOpen(false);
      toast({
        title: "Sucesso",
        description: "Localização criada com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar localização",
        variant: "destructive",
      });
    },
  });

  // Update location mutation
  const updateLocationMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<InsertLocation> }) =>
      apiRequest(`/api/locations/${id}`, 'PUT', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/locations'] });
      setEditingLocation(null);
      toast({
        title: "Sucesso",
        description: "Localização atualizada com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar localização",
        variant: "destructive",
      });
    },
  });

  // Delete location mutation
  const deleteLocationMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/locations/${id}`, 'DELETE'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/locations'] });
      toast({
        title: "Sucesso",
        description: "Localização removida com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao remover localização",
        variant: "destructive",
      });
    },
  });

  // Import locations mutation
  const importLocationsMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/locations/import', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error('Erro ao fazer upload do arquivo');
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/locations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      setImportResult(result);
      toast({
        title: "Importação concluída",
        description: result.message,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na importação",
        description: error.message || "Erro ao importar planilha",
        variant: "destructive",
      });
    },
  });

  // Update customer coordinates mutation
  const updateCoordinatesMutation = useMutation({
    mutationFn: () =>
      apiRequest('/api/locations/update-customer-coordinates', 'POST'),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/customers'] });
      toast({
        title: "Coordenadas atualizadas",
        description: result.message,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar coordenadas",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    const data: InsertLocation = {
      cpfCnpj: formData.get('cpfCnpj') as string,
      fantasyName: formData.get('fantasyName') as string,
      latitude: formData.get('latitude') as string,
      longitude: formData.get('longitude') as string,
      isActive: true,
    };

    if (editingLocation) {
      updateLocationMutation.mutate({ id: editingLocation.id, data });
    } else {
      createLocationMutation.mutate(data);
    }
  };

  const handleFileUpload = () => {
    const file = fileInputRef.current?.files?.[0];
    if (file) {
      importLocationsMutation.mutate(file);
    }
  };

  const handleEdit = (location: Location) => {
    setEditingLocation(location);
  };

  const handleDelete = (id: string) => {
    if (window.confirm('Tem certeza que deseja remover esta localização?')) {
      deleteLocationMutation.mutate(id);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-blue mx-auto mb-4"></div>
          <p className="text-gray-600">Carregando localizações...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800" data-testid="title-locations">
            Gerenciamento de Localizações
          </h1>
          <p className="text-gray-600">
            Cadastre e importe localizações de clientes com coordenadas GPS
          </p>
        </div>
        <BackToDashboardButton />
      </div>
        
      <div className="flex space-x-2">
        <Button
          onClick={() => updateCoordinatesMutation.mutate()}
          disabled={updateCoordinatesMutation.isPending}
          variant="outline"
          data-testid="button-update-coordinates"
        >
          <i className="fas fa-sync mr-2"></i>
          {updateCoordinatesMutation.isPending ? 'Atualizando...' : 'Atualizar Coordenadas'}
        </Button>
        
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-location">
              <i className="fas fa-plus mr-2"></i>
              Nova Localização
            </Button>
          </DialogTrigger>
        </Dialog>
      </div>

      <Tabs defaultValue="list" className="w-full">
        <TabsList>
          <TabsTrigger value="list">Lista de Localizações</TabsTrigger>
          <TabsTrigger value="import">Importar Planilha</TabsTrigger>
        </TabsList>
        
        <TabsContent value="list" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Localizações Cadastradas ({locations.length})</CardTitle>
              <CardDescription>
                Gerencie as localizações de clientes e suas coordenadas GPS
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>CNPJ/CPF</TableHead>
                    <TableHead>Nome Fantasia</TableHead>
                    <TableHead>Latitude</TableHead>
                    <TableHead>Longitude</TableHead>
                    <TableHead>Importado em</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locations.map((location: Location) => (
                    <TableRow key={location.id}>
                      <TableCell className="font-mono">{location.cpfCnpj}</TableCell>
                      <TableCell className="font-medium">{location.fantasyName}</TableCell>
                      <TableCell className="font-mono text-sm">{location.latitude}</TableCell>
                      <TableCell className="font-mono text-sm">{location.longitude}</TableCell>
                      <TableCell>
                        {location.importedAt 
                          ? new Date(location.importedAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
                          : 'Manual'
                        }
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end space-x-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(location)}
                            data-testid={`button-edit-${location.id}`}
                          >
                            <i className="fas fa-edit"></i>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDelete(location.id)}
                            className="text-red-600 hover:text-red-700"
                            data-testid={`button-delete-${location.id}`}
                          >
                            <i className="fas fa-trash"></i>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {locations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-gray-500 py-8">
                        Nenhuma localização cadastrada. Use o botão "Nova Localização" ou importe uma planilha.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="import" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Importar Localizações via Planilha</CardTitle>
              <CardDescription>
                Faça upload de uma planilha Excel (.xlsx) com as colunas: CNPJ/CPF, Nome Fantasia, Latitude, Longitude
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div>
                  <Label htmlFor="file-upload">Selecionar Arquivo Excel</Label>
                  <div className="flex items-center space-x-2 mt-2">
                    <Input
                      id="file-upload"
                      type="file"
                      accept=".xlsx,.xls"
                      ref={fileInputRef}
                      className="flex-1"
                      data-testid="input-file-upload"
                    />
                    <Button
                      onClick={handleFileUpload}
                      disabled={importLocationsMutation.isPending}
                      data-testid="button-import-file"
                    >
                      {importLocationsMutation.isPending ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Importando...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-upload mr-2"></i>
                          Importar
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                  <h4 className="font-medium text-blue-800 mb-2">Formato da Planilha:</h4>
                  <p className="text-sm text-blue-700 mb-2">
                    A planilha deve conter as seguintes colunas (nomes flexíveis):
                  </p>
                  <ul className="text-sm text-blue-700 space-y-1">
                    <li>• <strong>CNPJ/CPF</strong> (aceita: cpf_cnpj, cpfCnpj, documento)</li>
                    <li>• <strong>Nome Fantasia</strong> (aceita: fantasy_name, fantasyName, nome)</li>
                    <li>• <strong>Latitude</strong> (aceita: latitude, lat)</li>
                    <li>• <strong>Longitude</strong> (aceita: longitude, lng)</li>
                  </ul>
                </div>

                {importResult && (
                  <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                    <h4 className="font-medium text-green-800 mb-2">Resultado da Importação:</h4>
                    <div className="text-sm text-green-700 space-y-2">
                      <p>• <strong>{importResult.imported}</strong> localizações importadas</p>
                      <p>• <strong>{importResult.coordinatesUpdated.updated}</strong> clientes com coordenadas atualizadas</p>
                      {importResult.errors && importResult.errors.length > 0 && (
                        <div>
                          <p className="text-red-700 font-medium">Erros encontrados:</p>
                          <ul className="text-red-600 text-xs ml-4">
                            {importResult.errors.slice(0, 5).map((error: string, index: number) => (
                              <li key={index}>• {error}</li>
                            ))}
                            {importResult.errors.length > 5 && (
                              <li>• ... e mais {importResult.errors.length - 5} erros</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create/Edit Location Dialog */}
      <Dialog 
        open={isCreateDialogOpen || !!editingLocation} 
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateDialogOpen(false);
            setEditingLocation(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingLocation ? 'Editar Localização' : 'Nova Localização'}
            </DialogTitle>
            <DialogDescription>
              Preencha os dados da localização do cliente
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="cpfCnpj">CNPJ/CPF</Label>
              <Input
                id="cpfCnpj"
                name="cpfCnpj"
                required
                defaultValue={editingLocation?.cpfCnpj || ''}
                placeholder="00.000.000/0000-00 ou 000.000.000-00"
                data-testid="input-cpf-cnpj"
              />
            </div>
            
            <div>
              <Label htmlFor="fantasyName">Nome Fantasia</Label>
              <Input
                id="fantasyName"
                name="fantasyName"
                required
                defaultValue={editingLocation?.fantasyName || ''}
                placeholder="Nome do estabelecimento"
                data-testid="input-fantasy-name"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="latitude">Latitude</Label>
                <Input
                  id="latitude"
                  name="latitude"
                  type="number"
                  step="any"
                  required
                  defaultValue={editingLocation?.latitude || ''}
                  onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); const la = document.getElementById('latitude') as HTMLInputElement | null; const lo = document.getElementById('longitude') as HTMLInputElement | null; if (la) la.value = p[1]; if (lo) lo.value = p[2]; } }}
                  placeholder="-23.5505"
                  data-testid="input-latitude"
                />
              </div>
              
              <div>
                <Label htmlFor="longitude">Longitude</Label>
                <Input
                  id="longitude"
                  name="longitude"
                  type="number"
                  step="any"
                  required
                  defaultValue={editingLocation?.longitude || ''}
                  onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); const la = document.getElementById('latitude') as HTMLInputElement | null; const lo = document.getElementById('longitude') as HTMLInputElement | null; if (la) la.value = p[1]; if (lo) lo.value = p[2]; } }}
                  placeholder="-46.6333"
                  data-testid="input-longitude"
                />
              </div>
            </div>
            
            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsCreateDialogOpen(false);
                  setEditingLocation(null);
                }}
                data-testid="button-cancel"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={createLocationMutation.isPending || updateLocationMutation.isPending}
                data-testid="button-save"
              >
                {createLocationMutation.isPending || updateLocationMutation.isPending
                  ? 'Salvando...'
                  : editingLocation ? 'Atualizar' : 'Criar'
                }
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
