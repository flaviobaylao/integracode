import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Users, Mail, MapPin, Edit, Home, RefreshCw, Briefcase, UserX, UserCheck, Search } from "lucide-react";
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
  sellerType?: string;
  omieVendorCode?: string;
  omieVendorCodes?: Record<string, string>;
}

const SELLER_TYPE_LABELS: Record<string, string> = {
  vendedor_clt: 'Externo CLT',
  vendedor_pj: 'Externo PJ',
  telemarketing: 'Telemarketing',
};

const SELLER_TYPE_COLORS: Record<string, string> = {
  vendedor_clt: 'bg-blue-100 text-blue-800',
  vendedor_pj: 'bg-purple-100 text-purple-800',
  telemarketing: 'bg-amber-100 text-amber-800',
};

export default function Sellers() {
  const [editingSeller, setEditingSeller] = useState<Seller | null>(null);
  const [homeLatitude, setHomeLatitude] = useState("");
  const [homeLongitude, setHomeLongitude] = useState("");
  const [sellerType, setSellerType] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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
      setSellerType("");
      toast({
        title: "Sucesso",
        description: "Vendedor atualizado com sucesso!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar vendedor",
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
    setSellerType(seller.sellerType || "");
  };

  const handleSave = () => {
    if (!editingSeller) return;

    const data: any = {};

    if (homeLatitude && homeLongitude) {
      const lat = parseFloat(homeLatitude);
      const lng = parseFloat(homeLongitude);
      if (!isNaN(lat) && !isNaN(lng)) {
        data.homeLatitude = homeLatitude;
        data.homeLongitude = homeLongitude;
      }
    }

    if (sellerType) {
      data.sellerType = sellerType;
    }

    if (Object.keys(data).length === 0) {
      toast({ title: "Nada para salvar", variant: "destructive" });
      return;
    }

    updateSellerMutation.mutate({ id: editingSeller.id, data });
  };

  const handleQuickSetType = (seller: Seller, type: string) => {
    updateSellerMutation.mutate({
      id: seller.id,
      data: { sellerType: type },
    });
  };

  const handleToggleActive = (seller: Seller) => {
    const newStatus = !seller.isActive;
    const action = newStatus ? 'reativar' : 'inativar';
    if (!confirm(`Tem certeza que deseja ${action} o vendedor ${seller.firstName} ${seller.lastName}?`)) return;
    updateSellerMutation.mutate({
      id: seller.id,
      data: { isActive: newStatus },
    });
  };

  const allSellers = sellers.filter(user =>
    user.role === 'vendedor' || user.role === 'telemarketing'
  );

  const activeSellers = allSellers.filter(s => s.isActive);
  const inactiveSellers = allSellers.filter(s => !s.isActive);

  const displaySellers = (showInactive ? allSellers : activeSellers).filter(s => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const fullName = `${s.firstName} ${s.lastName}`.toLowerCase();
    return fullName.includes(q) || (s.email || '').toLowerCase().includes(q);
  });

  const cltCount = activeSellers.filter(s => s.sellerType === 'vendedor_clt').length;
  const pjCount = activeSellers.filter(s => s.sellerType === 'vendedor_pj').length;
  const tmkCount = activeSellers.filter(s => s.sellerType === 'telemarketing').length;
  const unclassified = activeSellers.filter(s => !s.sellerType).length;

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
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Vendedores</h1>
          <p className="text-muted-foreground">
            Gestão de vendedores do sistema
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            onClick={() => syncVendorsMutation.mutate()}
            disabled={syncVendorsMutation.isPending}
            variant="outline"
            size="sm"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncVendorsMutation.isPending ? 'animate-spin' : ''}`} />
            {syncVendorsMutation.isPending ? 'Sincronizando...' : 'Sincronizar Omie'}
          </Button>
          <Badge variant="secondary" className="px-3 py-1">
            <Users className="h-4 w-4 mr-1" />
            {activeSellers.length} ativos
          </Badge>
          {inactiveSellers.length > 0 && (
            <Badge variant="outline" className="px-3 py-1 text-muted-foreground">
              <UserX className="h-4 w-4 mr-1" />
              {inactiveSellers.length} inativos
            </Badge>
          )}
          <BackToDashboardButton />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-sm text-muted-foreground">Total Ativos</div>
            <div className="text-2xl font-bold">{activeSellers.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-sm text-muted-foreground">Externo CLT</div>
            <div className="text-2xl font-bold text-blue-600">{cltCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-sm text-muted-foreground">Externo PJ</div>
            <div className="text-2xl font-bold text-purple-600">{pjCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-sm text-muted-foreground">Telemarketing</div>
            <div className="text-2xl font-bold text-amber-600">{tmkCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-sm text-muted-foreground">Sem Tipo</div>
            <div className="text-2xl font-bold text-red-500">{unclassified}</div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Lista de Vendedores</h2>
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou email..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 w-64"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={showInactive} onCheckedChange={setShowInactive} />
              <Label className="text-sm cursor-pointer" onClick={() => setShowInactive(!showInactive)}>
                Mostrar inativos
              </Label>
            </div>
          </div>
        </div>
        
        {displaySellers.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Users className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Nenhum vendedor encontrado</h3>
              <p className="text-muted-foreground text-center mb-4">
                {searchQuery ? 'Nenhum resultado para a busca.' : 'Não há vendedores cadastrados no sistema.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {displaySellers.map((seller) => (
              <Card key={seller.id} className={`hover:shadow-md transition-shadow ${!seller.isActive ? 'opacity-60 border-dashed' : ''}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">
                      {seller.firstName} {seller.lastName}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      {!seller.isActive && (
                        <Badge variant="destructive" className="text-xs">Inativo</Badge>
                      )}
                      {seller.sellerType ? (
                        <Badge className={SELLER_TYPE_COLORS[seller.sellerType] || ''}>
                          {SELLER_TYPE_LABELS[seller.sellerType] || seller.sellerType}
                        </Badge>
                      ) : (
                        seller.isActive && (
                          <Badge variant="outline" className="text-red-500 border-red-200">
                            Sem Tipo
                          </Badge>
                        )
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {seller.email && seller.email.trim() !== '' ? (
                    <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4" />
                      <span className="truncate">{seller.email}</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2 text-sm text-orange-600">
                      <Mail className="h-4 w-4" />
                      <span>Email não informado</span>
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

                  {seller.omieVendorCodes && Object.keys(seller.omieVendorCodes).length > 1 && (
                    <div className="flex items-center space-x-2 text-sm text-blue-600">
                      <RefreshCw className="h-4 w-4" />
                      <span>{Object.keys(seller.omieVendorCodes).length} instâncias Omie</span>
                    </div>
                  )}

                  {seller.isActive && !seller.sellerType && (
                    <div className="flex gap-1 pt-1">
                      <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={() => handleQuickSetType(seller, 'vendedor_clt')}>
                        CLT
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={() => handleQuickSetType(seller, 'vendedor_pj')}>
                        PJ
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={() => handleQuickSetType(seller, 'telemarketing')}>
                        TMK
                      </Button>
                    </div>
                  )}
                  
                  <div className="flex gap-2 mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleEditClick(seller)}
                    >
                      <Edit className="h-4 w-4 mr-2" />
                      Editar
                    </Button>
                    <Button
                      variant={seller.isActive ? "outline" : "default"}
                      size="sm"
                      className={seller.isActive ? "text-red-600 hover:text-red-700 hover:bg-red-50" : "bg-green-600 hover:bg-green-700 text-white"}
                      onClick={() => handleToggleActive(seller)}
                      disabled={updateSellerMutation.isPending}
                    >
                      {seller.isActive ? (
                        <>
                          <UserX className="h-4 w-4 mr-1" />
                          Inativar
                        </>
                      ) : (
                        <>
                          <UserCheck className="h-4 w-4 mr-1" />
                          Ativar
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!editingSeller} onOpenChange={() => setEditingSeller(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Editar — {editingSeller?.firstName} {editingSeller?.lastName}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Tipo do Vendedor</Label>
              <Select value={sellerType} onValueChange={setSellerType}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vendedor_clt">
                    <div className="flex items-center gap-2">
                      <Briefcase className="h-4 w-4" />
                      Vendedor Externo CLT
                    </div>
                  </SelectItem>
                  <SelectItem value="vendedor_pj">
                    <div className="flex items-center gap-2">
                      <Briefcase className="h-4 w-4" />
                      Vendedor Externo PJ
                    </div>
                  </SelectItem>
                  <SelectItem value="telemarketing">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Telemarketing
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Define a tabela de comissão aplicável ao vendedor.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="homeLatitude">Latitude</Label>
              <Input
                id="homeLatitude"
                type="number"
                step="any"
                placeholder="-23.5505"
                value={homeLatitude}
                onChange={(e) => setHomeLatitude(e.target.value)}
              />
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
              />
            </div>
          </div>
          
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={() => setEditingSeller(null)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={updateSellerMutation.isPending}>
              {updateSellerMutation.isPending ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
