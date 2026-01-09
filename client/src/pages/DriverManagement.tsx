import { useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { 
  Users, 
  Plus,
  Edit3,
  MapPin,
  Phone,
  Car,
  Truck,
  Bike,
  Eye,
  UserCheck,
  UserX,
  Trash2,
  KeyRound
} from "lucide-react";
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

interface Driver {
  id: string;
  name: string;
  phone: string;
  email?: string;
  vehicleType: string;
  licensePlate: string;
  isActive: boolean;
  currentLocation?: string;
  createdAt: string;
  updatedAt: string;
}

const vehicleTypeIcons = {
  moto: Bike,
  carro: Car,
  caminhao: Truck,
  van: Truck,
};

const vehicleTypeOptions = [
  { value: "moto", label: "Moto" },
  { value: "carro", label: "Carro" },
  { value: "van", label: "Van" },
  { value: "caminhao", label: "Caminhão" },
];

export default function DriverManagement() {
  const { toast } = useToast();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showResetPasswordDialog, setShowResetPasswordDialog] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [driverToDelete, setDriverToDelete] = useState<Driver | null>(null);
  const [driverToResetPassword, setDriverToResetPassword] = useState<Driver | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  // Form state
  const [driverForm, setDriverForm] = useState({
    name: "",
    phone: "",
    email: "",
    vehicleType: "",
    licensePlate: "",
    isActive: true,
  });

  // Query para buscar todos os motoristas
  const { data: drivers, isLoading: isLoadingDrivers } = useQuery<Driver[]>({
    queryKey: ['/api/delivery-drivers'],
    refetchInterval: 60000, // Atualiza a cada 1 minuto
  });

  // Query para estatísticas dos motoristas
  const { data: driverStats } = useQuery({
    queryKey: ['/api/delivery-drivers/stats'],
  });

  // Mutation para criar motorista
  const createDriverMutation = useMutation({
    mutationFn: async (driverData: any) => {
      const response = await fetch('/api/delivery-drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(driverData),
      });
      if (!response.ok) throw new Error('Erro ao criar motorista');
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-drivers'] });
      setShowCreateModal(false);
      resetForm();
      
      // Mostrar senha temporária se usuário foi criado
      if (data.userCreated && data.temporaryPassword) {
        toast({
          title: "Motorista criado com conta de acesso!",
          description: `Senha temporária: ${data.temporaryPassword} - Anote para informar ao motorista!`,
          duration: 15000, // 15 segundos para dar tempo de anotar
        });
      } else {
        toast({
          title: "Motorista criado",
          description: "Motorista criado com sucesso.",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar motorista",
        variant: "destructive",
      });
    },
  });

  // Mutation para atualizar motorista
  const updateDriverMutation = useMutation({
    mutationFn: async (data: { id: string; driverData: any }) => {
      const response = await fetch(`/api/delivery-drivers/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data.driverData),
      });
      if (!response.ok) throw new Error('Erro ao atualizar motorista');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-drivers'] });
      setShowEditModal(false);
      setSelectedDriver(null);
      resetForm();
      toast({
        title: "Motorista atualizado",
        description: "Motorista atualizado com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar motorista",
        variant: "destructive",
      });
    },
  });

  // Mutation para alternar status ativo/inativo
  const toggleDriverStatusMutation = useMutation({
    mutationFn: async (data: { id: string; isActive: boolean }) => {
      const response = await fetch(`/api/delivery-drivers/${data.id}/toggle-status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive: data.isActive }),
      });
      if (!response.ok) throw new Error('Erro ao alterar status do motorista');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-drivers'] });
      toast({
        title: "Status alterado",
        description: "Status do motorista alterado com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao alterar status do motorista",
        variant: "destructive",
      });
    },
  });

  // Mutation para deletar motorista
  const deleteDriverMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/delivery-drivers/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao deletar motorista');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/delivery-drivers'] });
      setShowDeleteDialog(false);
      setDriverToDelete(null);
      toast({
        title: "Motorista removido",
        description: "Motorista removido com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao deletar motorista",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setDriverForm({
      name: "",
      phone: "",
      email: "",
      vehicleType: "",
      licensePlate: "",
      isActive: true,
    });
  };

  const handleCreateDriver = () => {
    createDriverMutation.mutate(driverForm);
  };

  const handleUpdateDriver = () => {
    if (!selectedDriver) return;
    updateDriverMutation.mutate({
      id: selectedDriver.id,
      driverData: driverForm
    });
  };

  const openEditModal = (driver: Driver) => {
    setSelectedDriver(driver);
    setDriverForm({
      name: driver.name,
      phone: driver.phone,
      email: driver.email || "",
      vehicleType: driver.vehicleType,
      licensePlate: driver.licensePlate,
      isActive: driver.isActive,
    });
    setShowEditModal(true);
  };

  const handleToggleStatus = (driver: Driver) => {
    toggleDriverStatusMutation.mutate({
      id: driver.id,
      isActive: !driver.isActive
    });
  };

  const handleDeleteClick = (driver: Driver) => {
    setDriverToDelete(driver);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = () => {
    if (driverToDelete) {
      deleteDriverMutation.mutate(driverToDelete.id);
    }
  };

  // Mutation para resetar senha
  const resetPasswordMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/delivery-drivers/${id}/reset-password`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erro ao resetar senha');
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      setNewPassword(data.temporaryPassword);
    },
    onError: (error: any) => {
      setShowResetPasswordDialog(false);
      setDriverToResetPassword(null);
      toast({
        title: "Erro",
        description: error.message || "Erro ao resetar senha",
        variant: "destructive",
      });
    },
  });

  const handleResetPasswordClick = (driver: Driver) => {
    setDriverToResetPassword(driver);
    setNewPassword(null);
    setShowResetPasswordDialog(true);
  };

  const handleConfirmResetPassword = () => {
    if (driverToResetPassword) {
      resetPasswordMutation.mutate(driverToResetPassword.id);
    }
  };

  const handleCloseResetPasswordDialog = () => {
    setShowResetPasswordDialog(false);
    setDriverToResetPassword(null);
    setNewPassword(null);
  };

  // Filtrar motoristas
  const filteredDrivers = drivers?.filter(driver =>
    driver.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    driver.phone.includes(searchTerm) ||
    driver.licensePlate.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const activeDrivers = drivers?.filter(d => d.isActive).length || 0;
  const inactiveDrivers = drivers?.filter(d => !d.isActive).length || 0;

  return (
    <div className="space-y-6" data-testid="driver-management">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">Gestão de Motoristas</h1>
          <p className="text-muted-foreground">
            Gerencie a equipe de entrega
          </p>
        </div>
        <BackToDashboardButton />
        <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-driver">
              <Plus className="h-4 w-4 mr-2" />
              Novo Motorista
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md" data-testid="create-modal">
            <DialogHeader>
              <DialogTitle>Novo Motorista</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nome</Label>
                <Input
                  id="name"
                  value={driverForm.name}
                  onChange={(e) => setDriverForm({...driverForm, name: e.target.value})}
                  placeholder="Nome completo"
                  data-testid="input-name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Telefone</Label>
                <Input
                  id="phone"
                  value={driverForm.phone}
                  onChange={(e) => setDriverForm({...driverForm, phone: e.target.value})}
                  placeholder="(11) 99999-9999"
                  data-testid="input-phone"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={driverForm.email}
                  onChange={(e) => setDriverForm({...driverForm, email: e.target.value})}
                  placeholder="motorista@example.com"
                  data-testid="input-email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="vehicle-type">Tipo de Veículo</Label>
                <select
                  id="vehicle-type"
                  value={driverForm.vehicleType}
                  onChange={(e) => setDriverForm({...driverForm, vehicleType: e.target.value})}
                  className="w-full border rounded-md px-3 py-2"
                  data-testid="select-vehicle-type"
                >
                  <option value="">Selecionar tipo</option>
                  {vehicleTypeOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="license-plate">Placa do Veículo</Label>
                <Input
                  id="license-plate"
                  value={driverForm.licensePlate}
                  onChange={(e) => setDriverForm({...driverForm, licensePlate: e.target.value.toUpperCase()})}
                  placeholder="ABC-1234"
                  data-testid="input-license-plate"
                />
              </div>

              <div className="flex items-center space-x-2">
                <Switch
                  id="active"
                  checked={driverForm.isActive}
                  onCheckedChange={(checked) => setDriverForm({...driverForm, isActive: checked})}
                  data-testid="switch-active"
                />
                <Label htmlFor="active">Motorista ativo</Label>
              </div>

              <div className="flex justify-end space-x-2">
                <Button
                  variant="outline"
                  onClick={() => setShowCreateModal(false)}
                  data-testid="button-cancel"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleCreateDriver}
                  disabled={createDriverMutation.isPending}
                  data-testid="button-create"
                >
                  {createDriverMutation.isPending ? "Criando..." : "Criar"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card data-testid="stat-total">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total de Motoristas</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoadingDrivers ? "-" : drivers?.length || 0}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="stat-active">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Ativos</CardTitle>
            <UserCheck className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {activeDrivers}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="stat-inactive">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Inativos</CardTitle>
            <UserX className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {inactiveDrivers}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card data-testid="search-card">
        <CardContent className="pt-6">
          <div className="relative">
            <Input
              placeholder="Buscar por nome, telefone ou placa..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pr-4"
              data-testid="input-search"
            />
          </div>
        </CardContent>
      </Card>

      {/* Drivers List */}
      <Card data-testid="drivers-list-card">
        <CardHeader>
          <CardTitle>
            Motoristas ({filteredDrivers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingDrivers ? (
            <div className="text-center py-8">Carregando motoristas...</div>
          ) : filteredDrivers.length > 0 ? (
            <div className="space-y-4">
              {filteredDrivers.map((driver) => {
                const VehicleIcon = vehicleTypeIcons[driver.vehicleType as keyof typeof vehicleTypeIcons] || Car;
                
                return (
                  <div key={driver.id} className="border rounded-lg p-4 hover:bg-gray-50" data-testid={`driver-item-${driver.id}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex items-start space-x-4">
                        <div className="flex-shrink-0">
                          <div className={`w-12 h-12 rounded-full ${driver.isActive ? 'bg-green-100' : 'bg-gray-100'} flex items-center justify-center`}>
                            <VehicleIcon className={`h-6 w-6 ${driver.isActive ? 'text-green-600' : 'text-gray-600'}`} />
                          </div>
                        </div>
                        
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center space-x-2">
                            <h3 className="font-medium">{driver.name}</h3>
                            <Badge variant={driver.isActive ? "default" : "secondary"}>
                              {driver.isActive ? "Ativo" : "Inativo"}
                            </Badge>
                          </div>
                          
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <div className="flex items-center">
                              <Phone className="h-3 w-3 mr-2" />
                              {driver.phone}
                            </div>
                            <div className="flex items-center">
                              <VehicleIcon className="h-3 w-3 mr-2" />
                              {vehicleTypeOptions.find(v => v.value === driver.vehicleType)?.label} - {driver.licensePlate}
                            </div>
                            {driver.currentLocation && (
                              <div className="flex items-center">
                                <MapPin className="h-3 w-3 mr-2" />
                                {driver.currentLocation}
                              </div>
                            )}
                            <div className="text-xs">
                              Criado em {new Date(driver.createdAt).toLocaleDateString('pt-BR')}
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleStatus(driver)}
                          disabled={toggleDriverStatusMutation.isPending}
                          data-testid={`button-toggle-${driver.id}`}
                          title={driver.isActive ? "Desativar" : "Ativar"}
                        >
                          {driver.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                        </Button>
                        {driver.email && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleResetPasswordClick(driver)}
                            disabled={resetPasswordMutation.isPending}
                            data-testid={`button-reset-password-${driver.id}`}
                            title="Resetar Senha"
                          >
                            <KeyRound className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditModal(driver)}
                          data-testid={`button-edit-${driver.id}`}
                          title="Editar"
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDeleteClick(driver)}
                          data-testid={`button-delete-${driver.id}`}
                          title="Excluir"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Nenhum motorista encontrado
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className="max-w-md" data-testid="edit-modal">
          <DialogHeader>
            <DialogTitle>Editar Motorista</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Nome</Label>
              <Input
                id="edit-name"
                value={driverForm.name}
                onChange={(e) => setDriverForm({...driverForm, name: e.target.value})}
                placeholder="Nome completo"
                data-testid="edit-input-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-phone">Telefone</Label>
              <Input
                id="edit-phone"
                value={driverForm.phone}
                onChange={(e) => setDriverForm({...driverForm, phone: e.target.value})}
                placeholder="(11) 99999-9999"
                data-testid="edit-input-phone"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-vehicle-type">Tipo de Veículo</Label>
              <select
                id="edit-vehicle-type"
                value={driverForm.vehicleType}
                onChange={(e) => setDriverForm({...driverForm, vehicleType: e.target.value})}
                className="w-full border rounded-md px-3 py-2"
                data-testid="edit-select-vehicle-type"
              >
                <option value="">Selecionar tipo</option>
                {vehicleTypeOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-license-plate">Placa do Veículo</Label>
              <Input
                id="edit-license-plate"
                value={driverForm.licensePlate}
                onChange={(e) => setDriverForm({...driverForm, licensePlate: e.target.value.toUpperCase()})}
                placeholder="ABC-1234"
                data-testid="edit-input-license-plate"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="edit-active"
                checked={driverForm.isActive}
                onCheckedChange={(checked) => setDriverForm({...driverForm, isActive: checked})}
                data-testid="edit-switch-active"
              />
              <Label htmlFor="edit-active">Motorista ativo</Label>
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => setShowEditModal(false)}
                data-testid="button-cancel-edit"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleUpdateDriver}
                disabled={updateDriverMutation.isPending}
                data-testid="button-save-edit"
              >
                {updateDriverMutation.isPending ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja remover o motorista <strong>{driverToDelete?.name}</strong>?
              Esta ação não pode ser desfeita e também removerá a conta de usuário associada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDriverToDelete(null)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDriverMutation.isPending ? "Removendo..." : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Password Dialog */}
      <AlertDialog open={showResetPasswordDialog} onOpenChange={(open) => !open && handleCloseResetPasswordDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {newPassword ? "Senha Resetada!" : "Resetar Senha"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {newPassword ? (
                  <div className="space-y-4">
                    <p>A senha do motorista <strong>{driverToResetPassword?.name}</strong> foi resetada com sucesso.</p>
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <p className="text-sm text-green-800 mb-2">Nova senha temporária:</p>
                      <p className="text-2xl font-bold text-green-700 font-mono tracking-wider">{newPassword}</p>
                    </div>
                    <p className="text-sm text-amber-600">
                      Anote esta senha para informar ao motorista. Após fechar esta janela, a senha não será exibida novamente.
                    </p>
                  </div>
                ) : (
                  <p>
                    Deseja resetar a senha do motorista <strong>{driverToResetPassword?.name}</strong>?
                    Uma nova senha temporária será gerada.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {newPassword ? (
              <AlertDialogAction onClick={handleCloseResetPasswordDialog}>
                Fechar
              </AlertDialogAction>
            ) : (
              <>
                <AlertDialogCancel onClick={handleCloseResetPasswordDialog}>
                  Cancelar
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmResetPassword}
                  disabled={resetPasswordMutation.isPending}
                >
                  {resetPasswordMutation.isPending ? "Resetando..." : "Resetar Senha"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}