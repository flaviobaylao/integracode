import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { QrCode, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
import Layout from "@/components/Layout";

function WhatsAppSetupContent() {
  const { toast } = useToast();
  const [instanceName, setInstanceName] = useState("honest-sucos");
  const [apiKey, setApiKey] = useState("");

  interface WhatsAppStatus {
    connected: boolean;
    instanceName?: string;
    phoneNumber?: string;
    qrCode?: string;
  }

  const { data: status, isLoading } = useQuery<WhatsAppStatus>({
    queryKey: ["/api/chat/whatsapp/status"],
    refetchInterval: 5000,
  });

  const setupMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("/api/chat/whatsapp/setup", "POST", {
        instanceName,
        apiKey,
      });
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "WhatsApp configurado com sucesso!",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/whatsapp/status"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao configurar WhatsApp",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("/api/chat/whatsapp/disconnect", "POST", {});
    },
    onSuccess: () => {
      toast({
        title: "Desconectado",
        description: "WhatsApp desconectado com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/whatsapp/status"] });
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-green-50">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Configuração WhatsApp</h1>
          <p className="text-slate-600 mt-1">Configure sua conexão com WhatsApp Business via Evolution API</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {status?.connected ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600" />
              )}
              Status da Conexão
            </CardTitle>
            <CardDescription>
              {status?.connected ? "WhatsApp conectado e pronto para uso" : "WhatsApp não conectado"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status?.connected ? (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  Instância <strong>{status.instanceName}</strong> conectada com sucesso!
                  <br />
                  Número: {status.phoneNumber || "Não disponível"}
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  WhatsApp não está conectado. Configure a instância abaixo.
                </AlertDescription>
              </Alert>
            )}

            {!status?.connected && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="instanceName">Nome da Instância</Label>
                  <Input
                    id="instanceName"
                    value={instanceName}
                    onChange={(e) => setInstanceName(e.target.value)}
                    placeholder="honest-sucos"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="apiKey">API Key (Evolution API)</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Sua chave de API"
                  />
                </div>

                <Button
                  onClick={() => setupMutation.mutate()}
                  disabled={setupMutation.isPending || !instanceName || !apiKey}
                  className="w-full"
                  data-testid="button-setup-whatsapp"
                >
                  {setupMutation.isPending ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Configurando...
                    </>
                  ) : (
                    <>
                      <QrCode className="mr-2 h-4 w-4" />
                      Conectar WhatsApp
                    </>
                  )}
                </Button>
              </div>
            )}

            {status?.connected && (
              <Button
                onClick={() => disconnectMutation.mutate()}
                variant="destructive"
                className="w-full"
                data-testid="button-disconnect-whatsapp"
              >
                Desconectar WhatsApp
              </Button>
            )}
          </CardContent>
        </Card>

        {status?.qrCode && !status.connected && (
          <Card>
            <CardHeader>
              <CardTitle>QR Code</CardTitle>
              <CardDescription>Escaneie este QR Code com seu WhatsApp</CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center">
              <img src={status.qrCode} alt="QR Code" className="max-w-xs" />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default function WhatsAppSetup() {
  const { user, isLoading } = useAuth();
  const [activeView, setActiveView] = useState('whatsapp');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-honest-blue"></div>
      </div>
    );
  }

  if (!user) {
    window.location.href = '/login';
    return null;
  }

  return (
    <Layout activeView={activeView} setActiveView={setActiveView} user={user as any}>
      <WhatsAppSetupContent />
    </Layout>
  );
}
