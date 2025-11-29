import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle, AlertTriangle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useToast } from "@/hooks/use-toast";

export default function RoutesValidation() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [isValidating, setIsValidating] = useState(false);

  const { data: validation, refetch } = useQuery({
    queryKey: ['/api/routes/validate', startDate, endDate],
    queryFn: () => apiRequest('GET', `/api/routes/validate?startDate=${startDate}&endDate=${endDate}`),
    enabled: false,
  });

  const handleValidate = async () => {
    setIsValidating(true);
    try {
      await refetch();
      toast({ title: "Validação concluída" });
    } catch (error: any) {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    } finally {
      setIsValidating(false);
    }
  };

  const canAccess = user && ['admin', 'coordinator'].includes(user.role);

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Card>
          <CardContent className="py-8">
            <p className="text-red-600">Acesso negado</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-6xl mx-auto">
        <BackToDashboardButton />
        
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Validação de Rotas
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Verifique se todas as visitas planejadas estão nas rotas corretas
          </p>
        </div>

        {/* Filtros */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-sm font-medium mb-2">Data Inicial</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full p-2 border rounded-md dark:bg-gray-800 dark:border-gray-700"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Data Final</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full p-2 border rounded-md dark:bg-gray-800 dark:border-gray-700"
                />
              </div>
              <Button 
                onClick={handleValidate} 
                disabled={isValidating}
                className="w-full"
              >
                {isValidating ? "Validando..." : "Validar Rotas"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {validation && (
          <>
            {/* Resumo */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {validation.validation.summary.withIssues === 0 ? (
                    <CheckCircle className="h-5 w-5 text-green-600" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-yellow-600" />
                  )}
                  Resumo da Validação
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                    <p className="text-sm text-gray-600 dark:text-gray-400">Datas OK</p>
                    <p className="text-2xl font-bold text-green-600">{validation.validation.summary.ok}</p>
                  </div>
                  <div className="p-3 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                    <p className="text-sm text-gray-600 dark:text-gray-400">Com Problemas</p>
                    <p className="text-2xl font-bold text-yellow-600">{validation.validation.summary.withIssues}</p>
                  </div>
                  <div className="p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                    <p className="text-sm text-gray-600 dark:text-gray-400">Planejadas</p>
                    <p className="text-2xl font-bold text-blue-600">{validation.validation.totalPlanned}</p>
                  </div>
                  <div className="p-3 bg-purple-50 dark:bg-purple-950 rounded-lg">
                    <p className="text-sm text-gray-600 dark:text-gray-400">Nas Rotas</p>
                    <p className="text-2xl font-bold text-purple-600">{validation.validation.totalInRoutes}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Visitas Faltando */}
            {validation.validation.missing.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-red-600">
                    <AlertCircle className="h-5 w-5" />
                    Visitas Faltando ({validation.validation.missing.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {validation.validation.missing.map((item: any, idx: number) => (
                      <div key={idx} className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-semibold text-red-900 dark:text-red-100">{item.customerName}</p>
                            <p className="text-xs text-red-700 dark:text-red-300">
                              {item.date} • Vendedor: {item.sellerId}
                            </p>
                          </div>
                          <Badge variant="destructive">Faltando</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Visitas Extras */}
            {validation.validation.extra.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-orange-600">
                    <AlertTriangle className="h-5 w-5" />
                    Visitas Extras ({validation.validation.extra.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {validation.validation.extra.map((item: any, idx: number) => (
                      <div key={idx} className="p-3 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded-lg">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-semibold text-orange-900 dark:text-orange-100">ID: {item.customerId}</p>
                            <p className="text-xs text-orange-700 dark:text-orange-300">
                              {item.date} • Rota: {item.routeId.substring(0, 8)}...
                            </p>
                          </div>
                          <Badge variant="secondary">Extra</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Detalhes por Data */}
            <Card>
              <CardHeader>
                <CardTitle>Detalhes por Data</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-2">Data</th>
                        <th className="text-left py-2 px-2">Vendedor</th>
                        <th className="text-center py-2 px-2">Planejadas</th>
                        <th className="text-center py-2 px-2">Nas Rotas</th>
                        <th className="text-left py-2 px-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.validation.dateRanges.map((item: any, idx: number) => (
                        <tr key={idx} className="border-b hover:bg-gray-50 dark:hover:bg-gray-800">
                          <td className="py-2 px-2">{item.date}</td>
                          <td className="py-2 px-2">{item.sellerId.substring(0, 8)}...</td>
                          <td className="py-2 px-2 text-center font-medium">{item.planned}</td>
                          <td className="py-2 px-2 text-center font-medium">{item.inRoute}</td>
                          <td className="py-2 px-2">
                            {item.status === 'ok' ? (
                              <Badge className="bg-green-600">OK</Badge>
                            ) : (
                              <Badge variant="destructive">Problemas</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
