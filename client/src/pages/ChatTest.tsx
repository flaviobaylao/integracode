import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Send, Download } from "lucide-react";

export default function ChatTest() {
  const { toast } = useToast();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [messageText, setMessageText] = useState("");
  const [syncLogs, setSyncLogs] = useState<string[]>([]);

  // Sincronizar contatos
  const syncContactsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("/api/chat/sync-contacts", {
        method: "POST",
      } as RequestInit);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sucesso!",
        description: `${data.summary.created} contatos criados, ${data.summary.alreadyExists} já existiam`,
      });
      setSyncLogs([
        `✅ Sincronização concluída`,
        `👥 Total de contatos: ${data.summary.totalContacts}`,
        `✨ Criados: ${data.summary.created}`,
        `⚪ Já existiam: ${data.summary.alreadyExists}`,
        `❌ Erros: ${data.summary.errors}`,
        ...(data.details?.slice(0, 10)?.map((d: any) => `  • ${d.name} (${d.phone}) - ${d.status}`) || [])
      ]);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Enviar mensagem
  const sendMessageMutation = useMutation({
    mutationFn: async () => {
      if (!phoneNumber.trim()) {
        throw new Error("Digite um número de telefone");
      }
      if (!messageText.trim()) {
        throw new Error("Digite uma mensagem");
      }

      const response = await apiRequest("/api/chat/send-message", {
        method: "POST",
        body: JSON.stringify({
          phoneNumber: phoneNumber.trim(),
          message: messageText.trim(),
        }),
      } as RequestInit);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Mensagem enviada!",
        description: "A mensagem foi enviada com sucesso para o WhatsApp",
      });
      setPhoneNumber("");
      setMessageText("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao enviar",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Sincronizar histórico
  const syncHistoryMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("/api/chat/sync-history", {
        method: "POST",
      } as RequestInit);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Histórico sincronizado!",
        description: `${data.summary.totalMessagesImported} mensagens importadas`,
      });
      setSyncLogs([
        `✅ Sincronização de histórico concluída`,
        `📊 Total de chats: ${data.summary.totalChats}`,
        `📝 Processados: ${data.summary.chatsProcessed}`,
        `✅ Sucesso: ${data.summary.successCount}`,
        `❌ Erros: ${data.summary.errorCount}`,
        `💬 Total de mensagens: ${data.summary.totalMessagesImported}`,
      ]);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Teste de WhatsApp</h1>
          <p className="text-gray-600">Enviar e receber mensagens, sincronizar contatos e histórico</p>
        </div>

        {/* Sincronização de Contatos */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Sincronizar Contatos
            </CardTitle>
            <CardDescription>
              Baixar todos os contatos do seu WhatsApp e salvá-los no sistema
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => syncContactsMutation.mutate()}
              disabled={syncContactsMutation.isPending}
              className="w-full"
              size="lg"
            >
              {syncContactsMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sincronizando...
                </>
              ) : (
                "Sincronizar Contatos"
              )}
            </Button>
            {syncLogs.length > 0 && (
              <div className="mt-4 p-3 bg-gray-50 rounded border border-gray-200">
                <pre className="text-xs text-gray-700 whitespace-pre-wrap">
                  {syncLogs.join("\n")}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Enviar Mensagem */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              Enviar Mensagem
            </CardTitle>
            <CardDescription>
              Digite um número de telefone e uma mensagem para testar o envio
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">
                Telefone (ex: 5562911112222)
              </label>
              <Input
                type="tel"
                placeholder="5562911112222"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={sendMessageMutation.isPending}
                data-testid="input-phone"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">
                Mensagem
              </label>
              <Textarea
                placeholder="Digite sua mensagem aqui..."
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                disabled={sendMessageMutation.isPending}
                rows={4}
                data-testid="input-message"
              />
            </div>
            <Button
              onClick={() => sendMessageMutation.mutate()}
              disabled={sendMessageMutation.isPending}
              className="w-full"
              size="lg"
            >
              {sendMessageMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enviando...
                </>
              ) : (
                "Enviar Mensagem"
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Sincronizar Histórico */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Sincronizar Histórico
            </CardTitle>
            <CardDescription>
              Importar todas as mensagens do histórico do WhatsApp
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => syncHistoryMutation.mutate()}
              disabled={syncHistoryMutation.isPending}
              className="w-full"
              size="lg"
              variant="secondary"
            >
              {syncHistoryMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sincronizando...
                </>
              ) : (
                "Sincronizar Histórico"
              )}
            </Button>
            {syncLogs.length > 0 && (
              <div className="mt-4 p-3 bg-gray-50 rounded border border-gray-200">
                <pre className="text-xs text-gray-700 whitespace-pre-wrap">
                  {syncLogs.join("\n")}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Informações */}
        <Card className="bg-blue-50 border-blue-200">
          <CardHeader>
            <CardTitle className="text-blue-900">ℹ️ Como funciona?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-blue-800 space-y-2">
            <p>
              <strong>Sincronizar Contatos:</strong> Baixa todos os contatos ativos do seu WhatsApp e salva no sistema para futuras conversas.
            </p>
            <p>
              <strong>Enviar Mensagem:</strong> Envia uma mensagem de teste para um número específico via WhatsApp.
            </p>
            <p>
              <strong>Sincronizar Histórico:</strong> Importa todas as mensagens trocadas anteriormente do WhatsApp para o banco de dados do sistema.
            </p>
            <p className="mt-4 pt-4 border-t border-blue-200">
              📱 Todas as mensagens são salvas automaticamente quando chegam via webhook do WhatsApp.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
