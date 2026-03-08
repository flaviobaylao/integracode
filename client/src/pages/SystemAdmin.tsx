import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, AlertCircle, CheckCircle2, Trash2, MessageSquare, GitMerge } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
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

interface ClearChatResult {
  success: boolean;
  message: string;
  deletedCounts?: {
    messages: number;
    conversations: number;
    customers: number;
    aiLogs: number;
  };
  executedBy?: string;
  executedAt?: string;
  error?: string;
}

export default function SystemAdmin() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isDryRun, setIsDryRun] = useState(true);
  const [result, setResult] = useState<RecalculateResult | null>(null);
  
  // Estados para limpar chat
  const [isClearingChat, setIsClearingChat] = useState(false);
  const [clearChatResult, setClearChatResult] = useState<ClearChatResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showClearDialog, setShowClearDialog] = useState(false);
  const { toast } = useToast();

  // Estados para mesclar vendedores BSB
  const [isMerging, setIsMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<any>(null);

  // Estados para corrigir sellers em faturamentos
  const [isFixingSellers, setIsFixingSellers] = useState(false);
  const [fixSellersResult, setFixSellersResult] = useState<any>(null);

  // Estados para enriquecimento completo de NFs
  const [isEnrichingNf, setIsEnrichingNf] = useState(false);
  const [nfEnrichState, setNfEnrichState] = useState<any>(null);
  const nfEnrichPollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isLoading && user?.role !== 'admin') {
      setLocation('/');
    }
  }, [user, isLoading, setLocation]);

  const handleClearAllChat = async () => {
    if (confirmText !== "CONFIRMAR") {
      toast({
        title: "Texto de confirmação incorreto",
        description: "Digite 'CONFIRMAR' para prosseguir com a limpeza.",
        variant: "destructive",
      });
      return;
    }
    
    setIsClearingChat(true);
    setClearChatResult(null);
    
    try {
      const response = await apiRequest('POST', '/api/chat/admin/clear-all', {}) as ClearChatResult;
      setClearChatResult(response);
      
      // Invalidar caches relacionados ao chat
      queryClient.invalidateQueries({ queryKey: ['/api/chat/conversations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/chat/customers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/chat/messages'] });
      
      toast({
        title: "Chat limpo com sucesso!",
        description: `${response.deletedCounts?.messages || 0} mensagens, ${response.deletedCounts?.conversations || 0} conversas removidas.`,
      });
      
      setShowClearDialog(false);
      setConfirmText("");
    } catch (error: any) {
      console.error('Erro ao limpar chat:', error);
      setClearChatResult({
        success: false,
        message: error.message || 'Erro desconhecido',
        error: error.message
      });
      toast({
        title: "Erro ao limpar chat",
        description: error.message || 'Erro desconhecido',
        variant: "destructive",
      });
    } finally {
      setIsClearingChat(false);
    }
  };

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

  const handleFixBillingSellers = async () => {
    setIsFixingSellers(true);
    setFixSellersResult(null);
    try {
      const response = await apiRequest('POST', '/api/admin/fix-billing-sellers', {});
      setFixSellersResult(response);
      toast({ title: 'Vendedores corrigidos!', description: 'seller_id e seller_name atualizados em todos os faturamentos.' });
    } catch (error: any) {
      setFixSellersResult({ success: false, message: error.message });
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setIsFixingSellers(false);
    }
  };

  const handleEnrichAllNf = async () => {
    if (isEnrichingNf) return;
    setIsEnrichingNf(true);
    setNfEnrichState({ running: true, totalByInstance: {}, startedAt: new Date().toISOString() });
    try {
      await apiRequest('POST', '/api/admin/enrich-all-nf', {});
      toast({ title: 'Enriquecimento iniciado!', description: 'Processando em background. O progresso será atualizado automaticamente.' });
      // Iniciar polling de progresso
      nfEnrichPollRef.current = setInterval(async () => {
        try {
          const state = await apiRequest('GET', '/api/admin/enrich-all-nf/state');
          setNfEnrichState(state);
          if (!state.running) {
            clearInterval(nfEnrichPollRef.current!);
            nfEnrichPollRef.current = null;
            setIsEnrichingNf(false);
            if (!state.error) {
              queryClient.invalidateQueries({ queryKey: ['/api/billings'] });
              toast({ title: 'Enriquecimento concluído!', description: 'Números de NF preenchidos para todos os faturamentos.' });
            }
          }
        } catch {}
      }, 3000);
    } catch (error: any) {
      setIsEnrichingNf(false);
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    }
  };

  const handleMergeBsbSellers = async () => {
    setIsMerging(true);
    setMergeResult(null);
    try {
      const response = await apiRequest('POST', '/api/admin/merge-bsb-sellers', {});
      setMergeResult(response);
      toast({
        title: 'Mesclagem concluída!',
        description: 'Vendedores BSB mesclados com sucesso.',
      });
    } catch (error: any) {
      setMergeResult({ success: false, message: error.message });
      toast({
        title: 'Erro na mesclagem',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsMerging(false);
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Administração do Sistema</h1>
          <p className="text-muted-foreground">
            Ferramentas de manutenção e correção de dados
          </p>
        </div>
        <BackToDashboardButton />
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

      {/* Card para Limpar Histórico de Chat */}
      <Card className="border-red-200 bg-red-50/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-700">
            <MessageSquare className="h-5 w-5" />
            Limpar Histórico de Conversas WhatsApp
          </CardTitle>
          <CardDescription className="text-red-600">
            <strong>ATENÇÃO:</strong> Esta ação irá remover TODAS as conversas, mensagens, clientes de chat e logs de IA.
            Use apenas para resolver problemas de números de telefone incorretos ou reiniciar o sistema de chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Ação Irreversível!</strong> Todos os dados de chat serão permanentemente deletados.
              O histórico não poderá ser recuperado após a execução.
            </AlertDescription>
          </Alert>

          <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
            <AlertDialogTrigger asChild>
              <Button 
                variant="destructive" 
                className="w-full"
                data-testid="button-open-clear-dialog"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Limpar Todas as Conversas
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="text-red-600">
                  Confirmar Limpeza Total do Chat
                </AlertDialogTitle>
                <AlertDialogDescription className="space-y-3">
                  <p>
                    Esta ação irá <strong>remover permanentemente</strong>:
                  </p>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    <li>Todas as conversas do WhatsApp</li>
                    <li>Todas as mensagens recebidas e enviadas</li>
                    <li>Todos os clientes de chat cadastrados</li>
                    <li>Todos os logs de IA (ChatGPT)</li>
                  </ul>
                  <p className="font-semibold text-red-600 mt-4">
                    Digite "CONFIRMAR" para prosseguir:
                  </p>
                  <Input
                    placeholder="Digite CONFIRMAR"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                    className="mt-2"
                    data-testid="input-confirm-clear"
                  />
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel 
                  onClick={() => setConfirmText("")}
                  data-testid="button-cancel-clear"
                >
                  Cancelar
                </AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={handleClearAllChat}
                  disabled={isClearingChat || confirmText !== "CONFIRMAR"}
                  data-testid="button-confirm-clear"
                >
                  {isClearingChat ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Limpando...
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Limpar Tudo
                    </>
                  )}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {clearChatResult && (
            <div className="mt-4 space-y-3">
              {clearChatResult.success ? (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800">
                    <strong>Limpeza concluída com sucesso!</strong>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <div>Mensagens: {clearChatResult.deletedCounts?.messages || 0}</div>
                      <div>Conversas: {clearChatResult.deletedCounts?.conversations || 0}</div>
                      <div>Clientes: {clearChatResult.deletedCounts?.customers || 0}</div>
                      <div>Logs IA: {clearChatResult.deletedCounts?.aiLogs || 0}</div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Executado em: {clearChatResult.executedAt}
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Erro:</strong> {clearChatResult.error || clearChatResult.message}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Corrigir Vendedores em Faturamentos
          </CardTitle>
          <CardDescription>
            Preenche os campos Vendedor (seller_id e seller_name) em TODOS os faturamentos de todas as
            instâncias Omie, usando os dados de clientes como referência. Resolve o "-" na coluna Vendedor
            e garante que as metas de faturamento contabilizem corretamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Operação idempotente — pode ser executada múltiplas vezes sem prejuízo.
              Leva alguns segundos para processar todos os registros.
            </AlertDescription>
          </Alert>
          <Button onClick={handleFixBillingSellers} disabled={isFixingSellers}>
            {isFixingSellers ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Corrigindo...</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" />Corrigir Vendedores em Todos os Faturamentos</>
            )}
          </Button>
          {fixSellersResult && (
            <Alert variant={fixSellersResult.success ? 'default' : 'destructive'} className={fixSellersResult.success ? 'bg-green-50 border-green-200' : ''}>
              {fixSellersResult.success ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertCircle className="h-4 w-4" />}
              <AlertDescription>
                {fixSellersResult.success ? (
                  <div className="space-y-1">
                    <div className="font-medium text-green-800">{fixSellersResult.message}</div>
                    <div className="text-sm text-green-700 grid grid-cols-2 gap-1 mt-2">
                      <div>seller_id atribuídos: <strong>{fixSellersResult.details?.sellerIdAssigned}</strong></div>
                      <div>seller_name preenchidos: <strong>{fixSellersResult.details?.sellerNameFilled}</strong></div>
                      <div>Total faturamentos: <strong>{fixSellersResult.details?.totalBillings}</strong></div>
                      <div>Com seller_name: <strong>{fixSellersResult.details?.nowWithSellerName}</strong></div>
                    </div>
                  </div>
                ) : (
                  <span><strong>Erro:</strong> {fixSellersResult.message}</span>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Preencher Números de NF em Faturamentos
          </CardTitle>
          <CardDescription>
            Busca o número de nota fiscal (NF) para todos os pedidos faturados que ainda não têm esse dado.
            Processa todas as instâncias Omie em paralelo. Pode levar 20-40 minutos para processar milhares de pedidos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Processo roda em background sem travar o sistema. Acompanhe o progresso abaixo enquanto processa.
            </AlertDescription>
          </Alert>
          <Button onClick={handleEnrichAllNf} disabled={isEnrichingNf} className="bg-blue-600 hover:bg-blue-700">
            {isEnrichingNf ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processando NFs...</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" />Preencher Todos os Números de NF</>
            )}
          </Button>
          {nfEnrichState && (
            <div className="space-y-2">
              <div className={`text-sm font-medium ${nfEnrichState.running ? 'text-blue-600' : nfEnrichState.error ? 'text-red-600' : 'text-green-700'}`}>
                {nfEnrichState.running ? 'Processando...' : nfEnrichState.error ? `Erro: ${nfEnrichState.error}` : 'Concluído!'}
              </div>
              {Object.entries(nfEnrichState.totalByInstance || {}).map(([label, data]: [string, any]) => (
                <div key={label} className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-2">
                  <span className="font-medium">{label}</span>
                  <span className="text-gray-600">
                    {data.enriched} NFs preenchidas / {data.checked} verificadas
                    {data.total > 0 && ` (${Math.round((data.checked / data.total) * 100)}%)`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            Mesclar Vendedores BSB Duplicados
          </CardTitle>
          <CardDescription>
            Mescla o registro duplicado "Ezequiel BSB" (omie-vendor-10457429564) com "Ezequiel DF"
            (0e92757a), adicionando os códigos Omie do BSB e SERV ao usuário principal,
            corrigindo clientes e faturamentos BSB. Executar apenas uma vez.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Esta operação é idempotente: pode ser executada novamente sem prejuízo caso já tenha sido feita.
              Após a mesclagem, os faturamentos BSB aparecerão nas metas de Ezequiel DF.
            </AlertDescription>
          </Alert>

          <Button
            onClick={handleMergeBsbSellers}
            disabled={isMerging}
            variant="default"
          >
            {isMerging ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Mesclando...
              </>
            ) : (
              <>
                <GitMerge className="mr-2 h-4 w-4" />
                Executar Mesclagem
              </>
            )}
          </Button>

          {mergeResult && (
            <Alert variant={mergeResult.success ? 'default' : 'destructive'} className={mergeResult.success ? 'bg-green-50 border-green-200' : ''}>
              {mergeResult.success ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <AlertCircle className="h-4 w-4" />}
              <AlertDescription>
                {mergeResult.success ? (
                  <div className="space-y-1">
                    <div className="font-medium text-green-800">{mergeResult.message}</div>
                    <div className="text-sm text-green-700 grid grid-cols-2 gap-1 mt-2">
                      <div>Clientes atualizados: <strong>{mergeResult.details?.customersUpdated}</strong></div>
                      <div>Billings seller: <strong>{mergeResult.details?.billingsSellerUpdated}</strong></div>
                      <div>Billings null fixados: <strong>{mergeResult.details?.billingsNullFixed}</strong></div>
                      <div>Duplicado desativado: <strong>{mergeResult.details?.sourceUserDeactivated ? 'Sim' : 'Não'}</strong></div>
                    </div>
                  </div>
                ) : (
                  <span><strong>Erro:</strong> {mergeResult.message}</span>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
