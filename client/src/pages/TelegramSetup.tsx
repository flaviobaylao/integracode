import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Send, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function TelegramSetup() {
  const { toast } = useToast();
  const [botToken, setBotToken] = useState("");

  interface TelegramStatus {
    connected: boolean;
    botUsername?: string;
  }

  const { data: status } = useQuery<TelegramStatus>({
    queryKey: ["/api/chat/telegram/status"],
    refetchInterval: 5000,
  });

  const setupMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("/api/chat/telegram/setup", "POST", { botToken });
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Telegram configurado com sucesso!",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/telegram/status"] });
      setBotToken("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao configurar Telegram",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Configuração Telegram</h1>
            <p className="text-slate-600 mt-1">Configure seu bot do Telegram para atendimento</p>
          </div>
          <BackToDashboardButton />
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
              {status?.connected ? "Telegram conectado e pronto para uso" : "Telegram não conectado"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status?.connected ? (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  Bot <strong>@{status.botUsername}</strong> conectado com sucesso!
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <XCircle className="h-4 w-4" />
                <AlertDescription>
                  Telegram não está conectado. Configure o bot abaixo.
                </AlertDescription>
              </Alert>
            )}

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
              <h3 className="font-semibold text-blue-900">Como criar um bot do Telegram:</h3>
              <ol className="list-decimal list-inside space-y-1 text-sm text-blue-800">
                <li>Abra o Telegram e busque por <strong>@BotFather</strong></li>
                <li>Envie o comando <code className="bg-blue-100 px-1 rounded">/newbot</code></li>
                <li>Escolha um nome para seu bot</li>
                <li>Escolha um username (deve terminar com "bot")</li>
                <li>Copie o token que o BotFather forneceu</li>
                <li>Cole o token no campo abaixo</li>
              </ol>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="botToken">Bot Token</Label>
                <Input
                  id="botToken"
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                  data-testid="input-bot-token"
                />
                <p className="text-xs text-muted-foreground">
                  O token fornecido pelo @BotFather
                </p>
              </div>

              <Button
                onClick={() => setupMutation.mutate()}
                disabled={setupMutation.isPending || !botToken}
                className="w-full"
                data-testid="button-setup-telegram"
              >
                {setupMutation.isPending ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Configurando...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Conectar Bot
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
