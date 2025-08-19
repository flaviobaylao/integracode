import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-honest-blue to-honest-orange flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardContent className="p-8">
          {/* Honest Sucos Logo */}
          <div className="text-center mb-8">
            <div className="mx-auto w-20 h-20 bg-honest-orange rounded-full flex items-center justify-center mb-4">
              <i className="fas fa-glass-whiskey text-white text-2xl"></i>
            </div>
            <h1 className="text-2xl font-bold text-gray-800">Honest Sucos</h1>
            <p className="text-gray-600 text-sm">Sistema de Gestão de Vendas</p>
          </div>
          
          <div className="space-y-4">
            <p className="text-center text-gray-600">
              Acesse sua conta para gerenciar vendas, clientes e produtos.
            </p>
            
            <div className="space-y-2">
              <Button 
                className="w-full bg-honest-blue hover:bg-blue-700"
                onClick={() => window.location.href = '/api/login'}
              >
                Entrar com Replit
              </Button>
              
              <Button 
                variant="outline" 
                className="w-full border-honest-orange text-honest-orange hover:bg-honest-orange hover:text-white"
                onClick={() => window.location.href = '/admin-login'}
              >
                Acesso Administrativo
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
