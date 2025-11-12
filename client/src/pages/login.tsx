import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Leaf } from 'lucide-react';
import { Link } from 'wouter';

interface LoginForm {
  email: string;
  password: string;
}

export default function Login() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  
  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>();

  const loginMutation = useMutation({
    mutationFn: async (data: LoginForm) => {
      const response = await fetch('/api/auth/login', {
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
      
      // Comentado: queryClient pode estar quebrado devido a cache do browser
      // queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
      
      // Redirecionar para URL salva ou página inicial
      const redirectUrl = sessionStorage.getItem('redirectAfterLogin');
      if (redirectUrl) {
        sessionStorage.removeItem('redirectAfterLogin');
        window.location.href = redirectUrl;
      } else {
        window.location.href = '/';
      }
    },
    onError: (error: any) => {
      console.error('Erro no login:', error);
      toast({
        title: 'Erro no login',
        description: error.message === 'Email ou senha inválidos' 
          ? 'Email ou senha incorretos' 
          : error.message || 'Erro interno do servidor',
        variant: 'destructive',
      });
      setIsLoading(false);
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
            {!imageError ? (
              <img 
                src="/attached_assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png" 
                alt="Sistema Integra" 
                className="w-20 h-20"
                onError={() => setImageError(true)}
                loading="lazy"
              />
            ) : (
              <div className="w-20 h-20 flex items-center justify-center bg-green-100 rounded-full">
                <Leaf className="w-10 h-10 text-green-600" />
              </div>
            )}
          </div>
          <CardTitle className="text-2xl font-bold text-green-700 dark:text-green-400">
            Sistema Integra
          </CardTitle>
          <CardDescription>
            Sistema de Gestão de Vendas
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" data-testid="label-email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                data-testid="input-email"
                {...register('email', { 
                  required: 'Email é obrigatório',
                  pattern: {
                    value: /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i,
                    message: 'Email inválido'
                  }
                })}
                disabled={isLoading}
              />
              {errors.email && (
                <p className="text-sm text-red-600">{errors.email.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password" data-testid="label-password">Senha</Label>
              <Input
                id="password"
                type="password"
                placeholder="Digite sua senha"
                data-testid="input-password"
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
              data-testid="button-login"
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
            <Link href="/set-password" className="text-sm text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300" data-testid="link-set-password">
              Primeiro acesso? Defina sua senha
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
