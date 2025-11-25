import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Users, Mail, MapPin, Plus, UserCheck, Edit, Home, RefreshCw } from "lucide-react";
import { formatDate } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface Seller {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  route: string;
  isActive: boolean;
  createdAt: string;
  homeLatitude?: string;
  homeLongitude?: string;
}

export default function Sellers() {
  const [editingSeller, setEditingSeller] = useState<Seller | null>(null);
  const [homeLatitude, setHomeLatitude] = useState("");
  const [homeLongitude, setHomeLongitude] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: sellers = [], isLoading } = useQuery<Seller[]>({
    queryKey: ['/api/users'],
  });

  const updateSellerMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/users/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setEditingSeller(null);
      setHomeLatitude("");
      setHomeLongitude("");
      toast({
        title: "Sucesso",
        description: "Coordenadas da casa atualizadas com sucesso!",
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

  const syncVendorsMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', '/api/omie/sync-vendors');
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      toast({
        title: "Sincronização concluída",
        description: `${data.imported} vendedores importados, ${data.updated} atualizados`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na sincronização",
        description: error.message || "Erro ao sincronizar vendedores do Omie",
        variant: "destructive",
      });
    },
  });

  const handleEditClick = (seller: Seller) => {
    setEditingSeller(seller);
    setHomeLatitude(seller.homeLatitude || "");
    setHomeLongitude(seller.homeLongitude || "");
  };

  const handleSaveCoordinates = () => {
    if (!editingSeller) return;

    const lat = parseFloat(homeLatitude);
    const lng = parseFloat(homeLongitude);

    if (isNaN(lat) || isNaN(lng)) {
      toast({
        title: "Erro",
        description: "Por favor, insira coordenadas válidas",
        variant: "destructive",
      });
      return;
    }

    updateSellerMutation.mutate({
      id: editingSeller.id,
      data: {
        homeLatitude: homeLatitude,
        homeLongitude: homeLongitude
      }
    });
  };

  // Filtrar apenas vendedores ativos
  const activeSellers = sellers.filter(user => user.role === 'vendedor' && user.isActive);

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
          <h1 className="text-3xl font-bold tracking-tight">Vendedores Ativos</h1>
          <p className="text-muted-foreground">
            Lista completa de vendedores ativos no sistema
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            onClick={() => syncVendorsMutation.mutate()}
            disabled={syncVendorsMutation.isPending}
            variant="outline"
            size="sm"
            data-testid="button-sync-vendors"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncVendorsMutation.isPending ? 'animate-spin' : ''}`} />
            {syncVendorsMutation.isPending ? 'Sincronizando...' : 'Sincronizar Omie'}
          </Button>
          <Badge variant="secondary" className="px-3 py-1">
            <Users className="h-4 w-4 mr-1" />
            {activeSellers.length} vendedores
          </Badge>
          <BackToDashboardButton />
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Vendedores</CardTitle>
            <UserCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-honest-blue">{activeSellers.length}</div>
            <p className="text-xs text-muted-foreground">Vendedores ativos</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rotas Cobertas</CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-honest-blue">
              {new Set(activeSellers.map(s => s.route)).size}
            </div>
            <p className="text-xs text-muted-foreground">Rotas diferentes</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Com Email</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-honest-blue">
              {activeSellers.filter(s => s.email && s.email.trim() !== '').length}
            </div>
            <p className="text-xs text-muted-foreground">Vendedores com email</p>
          </CardContent>
        </Card>
      </div>

      {/* Sellers List */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Lista de Vendedores</h2>
        
        {activeSellers.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Users className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Nenhum vendedor encontrado</h3>
              <p className="text-muted-foreground text-center mb-4">
                Não há vendedores ativos cadastrados no sistema.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeSellers.map((seller) => (
              <Card key={seller.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">
                      {seller.firstName} {seller.lastName}
                    </CardTitle>
                    <Badge variant="outline" className="text-xs">
                      Ativo
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {seller.email && seller.email.trim() !== '' ? (
                    <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4" />
                      <span className="truncate">{seller.email}</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4" />
                      <span className="text-orange-600">Email não informado</span>
                    </div>
                  )}
                  
                  <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                    <MapPin className="h-4 w-4" />
                    <span>Rota: {seller.route || 'Não definida'}</span>
                  </div>
                  
                  {seller.homeLatitude && seller.homeLongitude ? (
                    <div className="flex items-center space-x-2 text-sm text-green-600">
                      <Home className="h-4 w-4" />
                      <span>Coordenadas cadastradas</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2 text-sm text-orange-600">
                      <Home className="h-4 w-4" />
                      <span>Sem coordenadas da casa</span>
                    </div>
                  )}
                  
                  <div className="text-xs text-muted-foreground">
                    Cadastrado em: {formatDate(new Date(seller.createdAt), "dd/MM/yyyy")}
                  </div>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => handleEditClick(seller)}
                    data-testid={`button-edit-seller-${seller.id}`}
                  >
                    <Edit className="h-4 w-4 mr-2" />
                    Editar Coordenadas
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Edit Coordinates Modal */}
      <Dialog open={!!editingSeller} onOpenChange={() => setEditingSeller(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Editar Coordenadas da Casa - {editingSeller?.firstName} {editingSeller?.lastName}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="homeLatitude">Latitude</Label>
              <Input
                id="homeLatitude"
                type="number"
                step="any"
                placeholder="-23.5505"
                value={homeLatitude}
                onChange={(e) => setHomeLatitude(e.target.value)}
                data-testid="input-home-latitude"
              />
              <p className="text-xs text-muted-foreground">
                Exemplo: -23.5505 (use ponto como separador decimal)
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="homeLongitude">Longitude</Label>
              <Input
                id="homeLongitude"
                type="number"
                step="any"
                placeholder="-46.6333"
                value={homeLongitude}
                onChange={(e) => setHomeLongitude(e.target.value)}
                data-testid="input-home-longitude"
              />
              <p className="text-xs text-muted-foreground">
                Exemplo: -46.6333 (use ponto como separador decimal)
              </p>
            </div>
            
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
              <p className="text-sm text-blue-800">
                💡 <strong>Dica:</strong> Você pode obter as coordenadas abrindo o Google Maps,
                clicando no local da casa do vendedor, e copiando os valores de latitude e longitude
                que aparecem.
              </p>
            </div>
          </div>
          
          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => setEditingSeller(null)}
              data-testid="button-cancel-edit"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleSaveCoordinates}
              disabled={updateSellerMutation.isPending}
              data-testid="button-save-coordinates"
            >
              {updateSellerMutation.isPending ? "Salvando..." : "Salvar Coordenadas"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Action */}
      <div className="flex justify-center pt-6">
        <p className="text-sm text-muted-foreground">
          Para sincronizar mais vendedores, use a funcionalidade de sincronização do Omie
        </p>
      </div>
    </div>
  );
}