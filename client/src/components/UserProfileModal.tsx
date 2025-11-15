import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertUserSchema, type InsertUser, type User } from "@shared/schema";
import { MapPin, Home, Navigation } from "lucide-react";

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User;
}

export default function UserProfileModal({ isOpen, onClose, user }: UserProfileModalProps) {
  const [isCapturingLocation, setIsCapturingLocation] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<InsertUser>({
    resolver: zodResolver(insertUserSchema.omit({ id: true })),
    defaultValues: {
      email: '',
      firstName: '',
      lastName: '',
      profileImageUrl: '',
      role: 'vendedor',
      route: '',
      isActive: true,
      homeLatitude: '',
      homeLongitude: '',
    },
  });

  useEffect(() => {
    if (user) {
      form.reset({
        email: user.email || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        profileImageUrl: user.profileImageUrl || '',
        role: user.role || 'vendedor',
        route: user.route || '',
        isActive: user.isActive !== undefined ? user.isActive : true,
        homeLatitude: (user as any).homeLatitude || '',
        homeLongitude: (user as any).homeLongitude || '',
      });
    }
  }, [user, form]);

  const userMutation = useMutation({
    mutationFn: async (data: InsertUser) => {
      return await apiRequest('PUT', `/api/users/${user.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
      toast({
        title: "Sucesso",
        description: "Perfil atualizado com sucesso!",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const captureHomeLocation = () => {
    setIsCapturingLocation(true);
    
    if (!navigator.geolocation) {
      toast({
        title: "Geolocalização não suportada",
        description: "Seu navegador não suporta geolocalização.",
        variant: "destructive",
      });
      setIsCapturingLocation(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = position.coords.latitude.toString();
        const longitude = position.coords.longitude.toString();
        
        form.setValue('homeLatitude', latitude);
        form.setValue('homeLongitude', longitude);
        
        toast({
          title: "Localização capturada!",
          description: `Coordenadas da sua casa salvas: ${latitude}, ${longitude}`,
        });
        setIsCapturingLocation(false);
      },
      (error) => {
        console.error('Erro ao capturar localização:', error);
        toast({
          title: "Erro ao capturar localização",
          description: "Não foi possível obter sua localização. Verifique as permissões do navegador.",
          variant: "destructive",
        });
        setIsCapturingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  };

  const onSubmit = (data: InsertUser) => {
    userMutation.mutate(data);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Home className="h-5 w-5" />
            <span>Meu Perfil</span>
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            
            {/* Informações Básicas */}
            <Card>
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center">
                  <span className="mr-2">📋</span>
                  Informações Básicas
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nome</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} readOnly />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sobrenome</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} readOnly />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} readOnly />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="route"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rota</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value || ''} readOnly />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="mt-4">
                  <Badge variant="secondary" className="capitalize">
                    {user.role === 'vendedor' ? 'Vendedor' : user.role}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Localização da Casa */}
            <Card>
              <CardContent className="p-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center">
                  <Home className="h-5 w-5 mr-2" />
                  Localização da Minha Casa
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="homeLatitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <MapPin className="h-4 w-4" />
                          <span>Latitude</span>
                        </FormLabel>
                        <FormControl>
                          <Input 
                            {...field} 
                            value={field.value || ''}
                            placeholder="Ex: -23.550520"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="homeLongitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center space-x-1">
                          <MapPin className="h-4 w-4" />
                          <span>Longitude</span>
                        </FormLabel>
                        <FormControl>
                          <Input 
                            {...field} 
                            value={field.value || ''}
                            placeholder="Ex: -46.633309"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="mt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={captureHomeLocation}
                    disabled={isCapturingLocation}
                    className="flex items-center space-x-2"
                  >
                    <Navigation className={`h-4 w-4 ${isCapturingLocation ? 'animate-spin' : ''}`} />
                    <span>
                      {isCapturingLocation ? 'Capturando localização...' : 'Capturar minha localização atual'}
                    </span>
                  </Button>
                  <p className="text-sm text-gray-500 mt-2">
                    Clique para capturar automaticamente as coordenadas da sua localização atual
                  </p>
                </div>

                {form.getValues('homeLatitude') && form.getValues('homeLongitude') && (
                  <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
                    <p className="text-sm text-green-700 flex items-center">
                      <MapPin className="h-4 w-4 mr-1" />
                      Coordenadas salvas: {form.getValues('homeLatitude')}, {form.getValues('homeLongitude')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Botões */}
            <div className="flex justify-between items-center">
              <Button 
                type="button" 
                variant="destructive" 
                onClick={() => window.location.href = '/api/logout'}
                data-testid="button-logout"
              >
                <i className="fas fa-sign-out-alt mr-2"></i>
                Sair
              </Button>
              <div className="flex space-x-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancelar
                </Button>
                <Button 
                  type="submit" 
                  disabled={userMutation.isPending}
                  className="bg-honest-blue hover:bg-honest-blue/90"
                >
                  {userMutation.isPending ? 'Salvando...' : 'Salvar Alterações'}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}