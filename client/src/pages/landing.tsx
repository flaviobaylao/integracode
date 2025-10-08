import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-honest-blue to-honest-orange flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardContent className="p-8">
          {/* Sistema Integra Logo */}
          <div className="text-center mb-8">
            <img 
              src="/attached_assets/ChatGPT Image 8 de out. de 2025, 11_03_24_1759932343344.png" 
              alt="Sistema Integra" 
              className="mx-auto w-24 h-24 mb-4"
            />
            <h1 className="text-2xl font-bold text-gray-800">Sistema Integra</h1>
            <p className="text-gray-600 text-sm">Sistema de Gestão de Vendas</p>
          </div>
          
          <div className="space-y-4">
            <p className="text-center text-gray-600">
              Acesse sua conta para gerenciar vendas, clientes e produtos.
            </p>
            
            <div className="space-y-2">
              <Button 
                className="w-full bg-honest-blue hover:bg-blue-700"
                onClick={() => window.location.href = '/login'}
                data-testid="button-login"
              >
                Entrar no Sistema
              </Button>
              
              <Button 
                variant="outline" 
                className="w-full border-honest-orange text-honest-orange hover:bg-honest-orange hover:text-white"
                onClick={() => window.location.href = '/set-password'}
                data-testid="button-set-password"
              >
                Primeiro Acesso - Definir Senha
              </Button>
            </div>
            
            <div className="text-center text-sm text-gray-500">
              <p>Sistema de gestão completo para equipes de vendas</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
