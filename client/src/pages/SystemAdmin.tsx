import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface RecalculateResult {
  mode: string;
  totalCustomers: number;
  changes: number;
  updated: number;
  skipped: number;
  errors: number;
  message: string;
  details?: Array<{
    customerId: string;
    customerName: string;
    visitDays: string;
    beforeDelivery: string;
    afterDelivery: string;
  }>;
  errorDetails?: any[];
}

export default function SystemAdmin() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isDryRun, setIsDryRun] = useState(true);
  const [result, setResult] = useState<RecalculateResult | null>(null);

  useEffect(() => {
    if (!isLoading && user?.role !== 'admin') {
      setLocation('/');
    }
  }, [user, isLoading, setLocation]);

  const handleRecalculate = async (dryRun: boolean) => {
    setIsRecalculating(true);
    setIsDryRun(dryRun);
    setResult(null);

    try {
      const response = await apiRequest('POST', '/api/admin/recalculate-delivery-days', { 
        dryRun 
      }) as RecalculateResult;

      setResult(response);
    } catch (error: any) {
      console.error('Erro ao recalcular dias de entrega:', error);
      setResult({
        mode: dryRun ? 'DRY RUN' : 'APLICADO',
        totalCustomers: 0,
        changes: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        message: error.message || 'Erro desconhecido',
        errorDetails: [{ error: error.message }]
      });
    } finally {
      setIsRecalculating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-honest-orange"></div>
      </div>
    );
  }

  if (user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2">Administração do Sistema</h1>
        <p className="text-muted-foreground">
          Ferramentas de manutenção e correção de dados
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Recalcular Dias de Entrega
          </CardTitle>
          <CardDescription>
            Recalcula os dias de entrega de todos os clientes baseado nos dias de visita configurados.
            Os dias de entrega são automaticamente calculados como os próximos 2 dias úteis após cada dia de visita.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Regra de Negócio:</strong> Segunda-feira visita → Terça + Quarta entrega | 
              Quinta-feira visita → Sexta + Segunda entrega (pula finais de semana)
            </AlertDescription>
          </Alert>

          <div className="flex gap-3">
            <Button
              onClick={() => handleRecalculate(true)}
              disabled={isRecalculating}
              variant="outline"
              data-testid="button-dry-run"
            >
              {isRecalculating && isDryRun ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Simulando...
                </>
              ) : (
                <>
                  <AlertCircle className="mr-2 h-4 w-4" />
                  Simular (Dry Run)
                </>
              )}
            </Button>

            <Button
              onClick={() => handleRecalculate(false)}
              disabled={isRecalculating}
              variant="default"
              data-testid="button-apply"
            >
              {isRecalculating && !isDryRun ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Aplicando...
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Aplicar Recálculo
                </>
              )}
            </Button>
          </div>

          {result && (
            <div className="space-y-4 mt-4">
              <Alert variant={result.errors > 0 ? "destructive" : "default"}>
                <AlertDescription>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{result.message}</span>
                    <Badge variant={result.mode === 'DRY RUN' ? 'outline' : 'default'}>
                      {result.mode}
                    </Badge>
                  </div>
                </AlertDescription>
              </Alert>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{result.totalCustomers}</div>
                    <p className="text-xs text-muted-foreground">Total Analisados</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-orange-600">{result.changes}</div>
                    <p className="text-xs text-muted-foreground">Com Mudanças</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-green-600">{result.updated}</div>
                    <p className="text-xs text-muted-foreground">Atualizados</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-blue-600">{result.skipped}</div>
                    <p className="text-xs text-muted-foreground">Já Corretos</p>
                  </CardContent>
                </Card>
              </div>

              {result.details && result.details.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Detalhes das Mudanças</CardTitle>
                    <CardDescription>
                      Mostrando até 100 primeiros clientes
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {result.details.map((detail) => (
                        <div 
                          key={detail.customerId}
                          className="p-3 border rounded-lg space-y-1 text-sm"
                        >
                          <div className="font-medium">{detail.customerName}</div>
                          <div className="text-xs text-muted-foreground">
                            Dias de Visita: <Badge variant="outline">{detail.visitDays}</Badge>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-red-600">Antes: {detail.beforeDelivery}</span>
                            <span>→</span>
                            <span className="text-green-600">Depois: {detail.afterDelivery}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {result.errorDetails && result.errorDetails.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="font-medium mb-2">
                      {result.errorDetails.length} erro(s) encontrado(s)
                    </div>
                    <div className="text-xs space-y-1">
                      {result.errorDetails.slice(0, 10).map((err, idx) => (
                        <div key={idx}>
                          {err.customerName || 'Cliente desconhecido'}: {err.error}
                        </div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
