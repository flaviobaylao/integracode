import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SalesGoalsDashboard from "@/components/SalesGoalsDashboard";
import SalesGoalsManagement from "@/components/SalesGoalsManagement";
import CampanhaOutubro from "@/components/CampanhaOutubro";
import ClientesBlindados from "@/components/ClientesBlindados";
import TrocaDescontosTab from "@/components/TrocaDescontosTab";
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

        {/* A campanha mora aqui desde 31/out/2026 (antes era aba do Painel): é o
            mesmo assunto das metas — meta, positivação e novos clientes do mês. */}
        <Tabs defaultValue="metas">
          <TabsList className="mb-4">
            <TabsTrigger value="metas" data-testid="tab-metas">Metas de Faturamento</TabsTrigger>
            {canManageGoals && (
              <TabsTrigger value="trocas" data-testid="tab-descontos-troca">Descontos por troca</TabsTrigger>
            )}
            <TabsTrigger value="campanha" data-testid="tab-campanha">Campanha</TabsTrigger>
            {canManageGoals && (
              <TabsTrigger value="blindados" data-testid="tab-blindados">Clientes blindados</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="metas">
            {canManageGoals ? (
              <SalesGoalsManagement user={userForComponents} />
            ) : (
              <Card>
                <CardContent className="p-6">
                  <SalesGoalsDashboard user={userForComponents} />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* (14/nov/2026) Era sub-aba dentro de "Metas de Faturamento"; agora é aba principal. */}
          {canManageGoals && (
            <TabsContent value="trocas">
              <TrocaDescontosTab user={userForComponents} />
            </TabsContent>
          )}

          <TabsContent value="campanha">
            <Card>
              <CardContent className="p-4 md:p-6">
                <CampanhaOutubro />
              </CardContent>
            </Card>
          </TabsContent>
          {canManageGoals && (
            <TabsContent value="blindados">
              <ClientesBlindados />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
