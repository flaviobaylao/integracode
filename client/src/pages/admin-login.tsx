import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Leaf } from 'lucide-react';

interface LoginForm {
  username: string;
  password: string;
}

export default function AdminLogin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  
  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>();

  const loginMutation = useMutation({
    mutationFn: async (data: LoginForm) => {
      const response = await fetch('/api/auth/local-login', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Login failed');
      }
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: 'Login realizado com sucesso',
        description: 'Bem-vindo ao sistema Honest Sucos!',
      });
      
      // Invalidar cache do usuário para recarregar
      queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
      
      // Redirecionar para home
      window.location.href = '/';
    },
    onError: (error: any) => {
      console.error('Erro no login:', error);
      toast({
        title: 'Erro no login',
        description: error.message === 'Invalid credentials' 
          ? 'Usuário ou senha incorretos' 
          : 'Erro interno do servidor',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = (data: LoginForm) => {
    setIsLoading(true);
    loginMutation.mutate(data);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-orange-50 dark:from-green-950 dark:to-orange-950">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center">
              <Leaf className="h-8 w-8 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-green-700 dark:text-green-400">
            Honest Sucos
          </CardTitle>
          <CardDescription>
            Sistema de Gestão - Acesso Administrativo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Usuário</Label>
              <Input
                id="username"
                type="text"
                placeholder="Digite seu usuário"
                {...register('username', { 
                  required: 'Usuário é obrigatório',
                  minLength: { value: 2, message: 'Usuário deve ter pelo menos 2 caracteres' }
                })}
                disabled={isLoading}
              />
              {errors.username && (
                <p className="text-sm text-red-600">{errors.username.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                placeholder="Digite sua senha"
                {...register('password', { 
                  required: 'Senha é obrigatória',
                  minLength: { value: 6, message: 'Senha deve ter pelo menos 6 caracteres' }
                })}
                disabled={isLoading}
              />
              {errors.password && (
                <p className="text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>
            
            <Button 
              type="submit" 
              className="w-full bg-green-600 hover:bg-green-700 text-white"
              disabled={isLoading || loginMutation.isPending}
            >
              {(isLoading || loginMutation.isPending) ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Entrando...
                </>
              ) : (
                'Entrar'
              )}
            </Button>
          </form>
          
          <div className="mt-6 text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Credenciais administrativas específicas
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}