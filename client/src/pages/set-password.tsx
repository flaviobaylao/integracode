import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Leaf, ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';

interface SetPasswordForm {
  email: string;
  newPassword: string;
  confirmPassword: string;
}

export default function SetPassword() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  
  const { register, handleSubmit, watch, formState: { errors } } = useForm<SetPasswordForm>();
  const newPassword = watch('newPassword');

  const setPasswordMutation = useMutation({
    mutationFn: async (data: { email: string; newPassword: string }) => {
      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to set password');
      }
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: 'Senha definida com sucesso',
        description: 'Agora você pode fazer login com seu email e senha.',
      });
      setSuccess(true);
      setIsLoading(false);
    },
    onError: (error: any) => {
      console.error('Erro ao definir senha:', error);
      toast({
        title: 'Erro ao definir senha',
        description: error.message || 'Erro interno do servidor',
        variant: 'destructive',
      });
      setIsLoading(false);
    },
  });

  const onSubmit = (data: SetPasswordForm) => {
    setIsLoading(true);
    setPasswordMutation.mutate({
      email: data.email,
      newPassword: data.newPassword,
    });
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-orange-50 dark:from-green-950 dark:to-orange-950">
        <Card className="w-full max-w-md mx-4">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <img 
                src="/attached_assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png" 
                alt="Sistema Integra" 
                className="w-20 h-20"
              />
            </div>
            <CardTitle className="text-2xl font-bold text-green-700 dark:text-green-400">
              Senha Definida!
            </CardTitle>
            <CardDescription>
              Sua senha foi criada com sucesso
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center space-y-4">
              <p className="text-gray-600 dark:text-gray-400">
                Agora você pode fazer login no sistema usando seu email e a senha que acabou de criar.
              </p>
              <Link href="/login">
                <Button className="w-full bg-green-600 hover:bg-green-700 text-white" data-testid="button-go-to-login">
                  Ir para Login
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-orange-50 dark:from-green-950 dark:to-orange-950">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <img 
              src="/attached_assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png" 
              alt="Sistema Integra" 
              className="w-20 h-20"
            />
          </div>
          <CardTitle className="text-2xl font-bold text-green-700 dark:text-green-400">
            Definir Senha
          </CardTitle>
          <CardDescription>
            Primeiro acesso - Crie sua senha de acesso
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
              <Label htmlFor="newPassword" data-testid="label-new-password">Nova Senha</Label>
              <Input
                id="newPassword"
                type="password"
                placeholder="Mínimo 6 caracteres"
                data-testid="input-new-password"
                {...register('newPassword', { 
                  required: 'Senha é obrigatória',
                  minLength: { value: 6, message: 'Senha deve ter pelo menos 6 caracteres' }
                })}
                disabled={isLoading}
              />
              {errors.newPassword && (
                <p className="text-sm text-red-600">{errors.newPassword.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" data-testid="label-confirm-password">Confirmar Senha</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Digite a senha novamente"
                data-testid="input-confirm-password"
                {...register('confirmPassword', { 
                  required: 'Confirmação de senha é obrigatória',
                  validate: value => value === newPassword || 'As senhas não coincidem'
                })}
                disabled={isLoading}
              />
              {errors.confirmPassword && (
                <p className="text-sm text-red-600">{errors.confirmPassword.message}</p>
              )}
            </div>
            
            <Button 
              type="submit" 
              className="w-full bg-green-600 hover:bg-green-700 text-white"
              disabled={isLoading || setPasswordMutation.isPending}
              data-testid="button-set-password"
            >
              {(isLoading || setPasswordMutation.isPending) ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Definindo senha...
                </>
              ) : (
                'Definir Senha'
              )}
            </Button>
          </form>
          
          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 inline-flex items-center" data-testid="link-back-to-login">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Voltar para Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
