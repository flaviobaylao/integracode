import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SalesGoalsDashboard from "@/components/SalesGoalsDashboard";
import SalesGoalsManagement from "@/components/SalesGoalsManagement";
import type { User as SchemaUser } from "@shared/schema";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function SalesGoalsPage() {
  const { user } = useAuth();

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Carregando...</p>
      </div>
    );
  }

  const userForComponents = user as unknown as SchemaUser;
  const canManageGoals = ['admin', 'coordinator', 'administrative'].includes(user.role);

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50">
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              Metas de Vendas
            </h1>
            <p className="text-gray-600 mt-2">
              Acompanhe as metas de faturamento e comissões projetadas
            </p>
          </div>
          <BackToDashboardButton />
        </div>

        {canManageGoals ? (
          <SalesGoalsManagement user={userForComponents} />
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
