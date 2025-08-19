import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Mail, MapPin, Plus, UserCheck } from "lucide-react";
import { formatDate } from "date-fns";

interface Seller {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  route: string;
  isActive: boolean;
  createdAt: string;
}

export default function Sellers() {
  const { data: sellers = [], isLoading } = useQuery<Seller[]>({
    queryKey: ['/api/users'],
  });

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
          <Badge variant="secondary" className="px-3 py-1">
            <Users className="h-4 w-4 mr-1" />
            {activeSellers.length} vendedores
          </Badge>
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
                  
                  <div className="text-xs text-muted-foreground">
                    Cadastrado em: {formatDate(new Date(seller.createdAt), "dd/MM/yyyy")}
                  </div>
                  
                  <div className="text-xs text-muted-foreground">
                    ID: {seller.id}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Action */}
      <div className="flex justify-center pt-6">
        <p className="text-sm text-muted-foreground">
          Para sincronizar mais vendedores, use a funcionalidade de sincronização do Omie
        </p>
      </div>
    </div>
  );
}