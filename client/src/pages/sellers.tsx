import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Users, Mail, MapPin, Edit, Home, RefreshCw, Briefcase, UserX, UserCheck, Search, Plus, Trash2, Radio } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface Seller {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
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
  canal: 'Canal',
};

const SELLER_TYPE_COLORS: Record<string, string> = {
  vendedor_clt: 'bg-blue-100 text-blue-800',
  vendedor_pj: 'bg-purple-100 text-purple-800',
  telemarketing: 'bg-amber-100 text-amber-800',
  canal: 'bg-teal-100 text-teal-800',
};

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrador',
  coordinator: 'Coordenador',
  administrative: 'Administrativo',
  vendedor: 'Vendedor',
  telemarketing: 'Telemarketing',
  motorista: 'Motorista',
  industria: 'Indústria',
};

const ROLE_OPTIONS = ['vendedor', 'telemarketing', 'motorista', 'industria', 'administrative', 'coordinator', 'admin'];

interface SellerForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: string;
  sellerType: string;
  route: string;
  homeLatitude: string;
  homeLongitude: string;
  omieVendorCode: string;
  isActive: boolean;
  password: string;
}

const EMPTY_FORM: SellerForm = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  role: 'vendedor',
  sellerType: '',
  route: '',
  homeLatitude: '',
  homeLongitude: '',
  omieVendorCode: '',
  isActive: true,
  password: '',
};

// Normaliza coordenada única (aceita vírgula ou ponto decimal). Retorna null se vazio/ inválido.
function normalizeCoord(v: string): string | null {
  if (!v || !String(v).trim()) return null;
  const s = String(v).trim().replace(/\s+/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

export default function Sellers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canEdit = ['admin', 'coordinator', 'administrative'].includes(user?.role || '');

  const [dialogMode, setDialogMode] = useState<null | 'create' | 'edit'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SellerForm>({ ...EMPTY_FORM });
  const [deletingSeller, setDeletingSeller] = useState<Seller | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: sellers = [], isLoading } = useQuery<Seller[]>({
    queryKey: ['/api/users'],
  });

  const setField = <K extends keyof SellerForm>(key: K, value: SellerForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const closeDialog = () => {
    setDialogMode(null);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };

  const buildPayload = () => ({
    firstName: form.firstName.trim() || null,
    lastName: form.lastName.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    role: form.role,
    sellerType: form.sellerType || null,
    route: form.route.trim() || null,
    omieVendorCode: form.omieVendorCode.trim() || null,
    homeLatitude: normalizeCoord(form.homeLatitude),
    homeLongitude: normalizeCoord(form.homeLongitude),
    isActive: form.isActive,
  });

  const applyPassword = async (userId: string) => {
    if (form.password && form.password.length >= 6) {
      await apiRequest('PUT', `/api/users/${userId}/password`, { password: form.password });
    }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const created: any = await apiRequest('POST', '/api/users', buildPayload());
      if (created?.id) await applyPassword(created.id);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      closeDialog();
      toast({ title: "Sucesso", description: "Vendedor criado com sucesso!" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao criar vendedor", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingId) return;
      await apiRequest('PUT', `/api/users/${editingId}`, buildPayload());
      await applyPassword(editingId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      closeDialog();
      toast({ title: "Sucesso", description: "Vendedor atualizado com sucesso!" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao atualizar vendedor", variant: "destructive" });
    },
  });

  const quickUpdateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest('PUT', `/api/users/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      toast({ title: "Sucesso", description: "Vendedor atualizado!" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao atualizar vendedor", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      setDeletingSeller(null);
      toast({ title: "Vendedor excluído", description: "O cadastro foi removido permanentemente." });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao excluir vendedor", variant: "destructive" });
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

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setDialogMode('create');
  };

  const openEdit = (seller: Seller) => {
    setForm({
      firstName: seller.firstName || '',
      lastName: seller.lastName || '',
      email: seller.email || '',
      phone: seller.phone || '',
      role: seller.role || 'vendedor',
      sellerType: seller.sellerType || '',
      route: seller.route || '',
      homeLatitude: seller.homeLatitude || '',
      homeLongitude: seller.homeLongitude || '',
      omieVendorCode: seller.omieVendorCode || '',
      isActive: seller.isActive,
      password: '',
    });
    setEditingId(seller.id);
    setDialogMode('edit');
  };

  const handleSubmit = () => {
    if (!form.firstName.trim()) {
      toast({ title: "Nome obrigatório", description: "Informe pelo menos o primeiro nome.", variant: "destructive" });
      return;
    }
    if (form.password && form.password.length < 6) {
      toast({ title: "Senha muito curta", description: "A senha deve ter no mínimo 6 caracteres.", variant: "destructive" });
      return;
    }
    if (dialogMode === 'create') createMutation.mutate();
    else updateMutation.mutate();
  };

  const handleQuickSetType = (seller: Seller, type: string) => {
    quickUpdateMutation.mutate({ id: seller.id, data: { sellerType: type } });
  };

  const handleToggleActive = (seller: Seller) => {
    const newStatus = !seller.isActive;
    quickUpdateMutation.mutate({ id: seller.id, data: { isActive: newStatus } });
  };

  // Ao colar o par "lat, lon" do Google Maps no campo de latitude, separa em latitude/longitude.
  const handleLatInput = (raw: string) => {
    const pair = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (pair) {
      setForm((f) => ({ ...f, homeLatitude: pair[1], homeLongitude: pair[2] }));
    } else {
      setField('homeLatitude', raw);
    }
  };

  const allSellers = sellers.filter(u =>
    u.role === 'vendedor' || u.role === 'telemarketing'
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
  const canalCount = activeSellers.filter(s => s.sellerType === 'canal').length;
  const unclassified = activeSellers.filter(s => !s.sellerType).length;

  const isSaving = createMutation.isPending || updateMutation.isPending;

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
          {isAdmin && (
            <Button onClick={openCreate} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-new-seller">
              <Plus className="h-4 w-4 mr-2" />
              Novo Vendedor
            </Button>
          )}
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

      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
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
            <div className="text-sm text-muted-foreground">Canal</div>
            <div className="text-2xl font-bold text-teal-600">{canalCount}</div>
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

                  {canEdit && seller.isActive && !seller.sellerType && (
                    <div className="flex gap-1 pt-1 flex-wrap">
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => handleQuickSetType(seller, 'vendedor_clt')}>
                        CLT
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => handleQuickSetType(seller, 'vendedor_pj')}>
                        PJ
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => handleQuickSetType(seller, 'telemarketing')}>
                        TMK
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => handleQuickSetType(seller, 'canal')}>
                        Canal
                      </Button>
                    </div>
                  )}

                  <div className="flex gap-2 mt-2">
                    {canEdit && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => openEdit(seller)}
                        data-testid={`button-edit-${seller.id}`}
                      >
                        <Edit className="h-4 w-4 mr-2" />
                        Editar
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        variant={seller.isActive ? "outline" : "default"}
                        size="sm"
                        className={seller.isActive ? "text-red-600 hover:text-red-700 hover:bg-red-50" : "bg-green-600 hover:bg-green-700 text-white"}
                        onClick={() => handleToggleActive(seller)}
                        disabled={quickUpdateMutation.isPending}
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
                    )}
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => setDeletingSeller(seller)}
                        data-testid={`button-delete-${seller.id}`}
                        title="Excluir permanentemente"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Dialog de Criar / Editar vendedor */}
      <Dialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === 'create'
                ? 'Novo Vendedor'
                : `Editar — ${form.firstName} ${form.lastName}`}
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="firstName">Nome *</Label>
              <Input id="firstName" value={form.firstName} onChange={(e) => setField('firstName', e.target.value)} placeholder="Primeiro nome" data-testid="input-firstName" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Sobrenome</Label>
              <Input id="lastName" value={form.lastName} onChange={(e) => setField('lastName', e.target.value)} placeholder="Sobrenome" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email (login)</Label>
              <Input id="email" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder="email@exemplo.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Telefone (WhatsApp)</Label>
              <Input id="phone" value={form.phone} onChange={(e) => setField('phone', e.target.value)} placeholder="5562999999999" />
            </div>

            <div className="space-y-2">
              <Label>Papel de acesso</Label>
              <Select value={form.role} onValueChange={(v) => setField('role', v)}>
                <SelectTrigger><SelectValue placeholder="Selecione o papel" /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_LABELS[r] || r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tipo do Vendedor</Label>
              <Select value={form.sellerType || 'none'} onValueChange={(v) => setField('sellerType', v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Selecione o tipo" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem tipo</SelectItem>
                  <SelectItem value="vendedor_clt"><div className="flex items-center gap-2"><Briefcase className="h-4 w-4" />Vendedor Externo CLT</div></SelectItem>
                  <SelectItem value="vendedor_pj"><div className="flex items-center gap-2"><Briefcase className="h-4 w-4" />Vendedor Externo PJ</div></SelectItem>
                  <SelectItem value="telemarketing"><div className="flex items-center gap-2"><Users className="h-4 w-4" />Telemarketing</div></SelectItem>
                  <SelectItem value="canal"><div className="flex items-center gap-2"><Radio className="h-4 w-4" />Canal</div></SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="route">Rota</Label>
              <Input id="route" value={form.route} onChange={(e) => setField('route', e.target.value)} placeholder="Ex.: Centro, Zona Norte" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="omieVendorCode">Código do Vendedor (Omie)</Label>
              <Input id="omieVendorCode" value={form.omieVendorCode} onChange={(e) => setField('omieVendorCode', e.target.value)} placeholder="Ex.: 2425693369" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="homeLatitude">Latitude (casa)</Label>
              <Input id="homeLatitude" value={form.homeLatitude} onChange={(e) => handleLatInput(e.target.value)} inputMode="decimal" placeholder="-16.691345 (ou cole -16.69, -49.27)" data-testid="input-home-latitude" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="homeLongitude">Longitude (casa)</Label>
              <Input id="homeLongitude" value={form.homeLongitude} onChange={(e) => setField('homeLongitude', e.target.value)} inputMode="decimal" placeholder="-49.278349" data-testid="input-home-longitude" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{dialogMode === 'create' ? 'Senha de acesso (opcional)' : 'Nova senha (deixe em branco p/ manter)'}</Label>
              <Input id="password" type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} placeholder="Mínimo 6 caracteres" autoComplete="new-password" />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Switch checked={form.isActive} onCheckedChange={(v) => setField('isActive', v)} id="isActive" />
              <Label htmlFor="isActive" className="cursor-pointer">{form.isActive ? 'Ativo' : 'Inativo'}</Label>
            </div>
          </div>

          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="outline" onClick={closeDialog}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-seller">
              {isSaving ? "Salvando..." : (dialogMode === 'create' ? "Criar" : "Salvar")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmação de exclusão permanente */}
      <AlertDialog open={!!deletingSeller} onOpenChange={(open) => { if (!open) setDeletingSeller(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir vendedor permanentemente?</AlertDialogTitle>
            <AlertDialogDescription>
              Você está prestes a excluir <strong>{deletingSeller?.firstName} {deletingSeller?.lastName}</strong> de forma
              permanente. Esta ação NÃO poderá ser desfeita. Se quiser apenas removê-lo das rotas, use "Inativar".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => deletingSeller && deleteMutation.mutate(deletingSeller.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Excluindo..." : "Excluir permanentemente"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
