import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SalesGoalsDashboard from "@/components/SalesGoalsDashboard";
import SalesGoalsManagement from "@/components/SalesGoalsManagement";
import type { User as SchemaUser } from "@shared/schema";

export default function SalesGoalsPage() {
  const { user } = useAuth();

  console.log('🎯 SalesGoalsPage carregada!', { user: user?.email, role: user?.role });

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Carregando...</p>
      </div>
    );
  }

  // Cast user for components that expect full schema type (password field is not used)
  const userForComponents = user as unknown as SchemaUser;
  const canManageGoals = ['admin', 'coordinator'].includes(user.role);

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900" data-testid="text-page-title">
            Metas de Vendas
          </h1>
          <p className="text-gray-600 mt-2">
            Acompanhe e gerencie as metas de vendas dos vendedores
          </p>
        </div>

        {canManageGoals ? (
          <Tabs defaultValue="dashboard" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="dashboard" data-testid="tab-dashboard">
                Dashboard de Metas
              </TabsTrigger>
              <TabsTrigger value="management" data-testid="tab-management">
                Gerenciar Metas
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dashboard">
              <SalesGoalsDashboard user={userForComponents} />
            </TabsContent>

            <TabsContent value="management">
              <SalesGoalsManagement user={userForComponents} />
            </TabsContent>
          </Tabs>
        ) : (
          <Card>
            <CardContent className="p-6">
              <SalesGoalsDashboard user={userForComponents} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
