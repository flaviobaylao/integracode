import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

interface TelegramSetupProps {
  onNavigateBack: () => void;
  onLogout: () => void;
}

export default function TelegramSetup({ onNavigateBack, onLogout }: TelegramSetupProps) {
  const [connectionStatus, setConnectionStatus] = useState<string>('disconnected');
  const [botUsername, setBotUsername] = useState<string>("");
  const [qrCode, setQrCode] = useState<string>("");
  const [botToken, setBotToken] = useState<string>("");
  const [showTokenInput, setShowTokenInput] = useState<boolean>(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Query Telegram status
  const { data: connectionData, refetch: refetchStatus } = useQuery({
    queryKey: ["/api/telegram/status"],
    refetchInterval: 2000, // Poll every 2 seconds
  });

  // Generate setup QR mutation
  const generateSetupQRMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/telegram/generate-setup-qr", {});
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      setQrCode(data.qrCode);
      toast({
        title: "QR Code Gerado",
        description: data.message,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: "Não foi possível gerar QR Code: " + error.message,
        variant: "destructive",
      });
    },
  });

  // Connect bot mutation
  const connectBotMutation = useMutation({
    mutationFn: async (token: string) => {
      const response = await apiRequest("POST", "/api/telegram/connect", { token });
      return await response.json();
    },
    onSuccess: () => {
      setBotToken("");
      setShowTokenInput(false);
      setQrCode("");
      toast({
        title: "Bot Conectado",
        description: "Bot Telegram conectado com sucesso",
      });
      refetchStatus();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: "Não foi possível conectar o bot: " + error.message,
        variant: "destructive",
      });
    },
  });

  // Disconnect bot mutation
  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/telegram/disconnect", {});
      return await response.json();
    },
    onSuccess: () => {
      setConnectionStatus('disconnected');
      setQrCode("");
      setBotUsername("");
      setBotToken("");
      setShowTokenInput(false);
      toast({
        title: "Desconectado",
        description: "Bot Telegram foi desconectado com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: "Não foi possível desconectar: " + error.message,
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (connectionData) {
      const data = connectionData as any;
      setConnectionStatus(data.status || 'disconnected');
      setBotUsername(data.botUsername || "");
      
      if (data.status === 'connected') {
        setQrCode("");
        setShowTokenInput(false);
        toast({
          title: "Bot Conectado",
          description: `Bot Telegram conectado: @${data.botUsername}`,
        });
      }
    }
  }, [connectionData, toast]);

  const handleGenerateSetupQR = () => {
    generateSetupQRMutation.mutate();
  };

  const handleConnectBot = () => {
    if (!botToken.trim()) {
      toast({
        title: "Erro",
        description: "Por favor, insira o token do bot",
        variant: "destructive",
      });
      return;
    }
    connectBotMutation.mutate(botToken.trim());
  };

  const handleDisconnect = () => {
    if (window.confirm('Tem certeza que deseja desconectar o bot Telegram?')) {
      disconnectMutation.mutate();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <button
                onClick={onNavigateBack}
                className="text-gray-600 hover:text-gray-900 transition-colors"
                title="Voltar"
              >
                <i className="fas fa-arrow-left text-xl"></i>
              </button>
              <div className="h-10 w-10 flex items-center justify-center bg-blue-500 rounded-full">
                <i className="fab fa-telegram text-white text-xl"></i>
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-900">Configuração Telegram Bot</h1>
                <p className="text-sm text-gray-600">Configure seu bot para mensagens</p>
              </div>
            </div>
            <button
              onClick={onLogout}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
            >
              <i className="fas fa-sign-out-alt mr-2"></i>
              Sair
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Telegram Setup Notice */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <i className="fab fa-telegram text-blue-500 text-xl"></i>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-blue-800">
                Integração Real com Telegram Bot
              </h3>
              <div className="mt-2 text-sm text-blue-700">
                <p>Configure um bot Telegram real para receber e responder mensagens dos clientes. O bot será conectado através da API oficial do Telegram.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Connection Status Card */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center mb-6">
              <div className="h-12 w-12 bg-blue-500 rounded-full flex items-center justify-center mr-4">
                <i className="fab fa-telegram text-white text-xl"></i>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Status da Conexão</h2>
                <p className="text-sm text-gray-600">Situação atual do bot Telegram</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    connectionStatus === 'connected' ? 'bg-green-500' :
                    connectionStatus === 'connecting' ? 'bg-blue-500' :
                    connectionStatus === 'qr_ready' ? 'bg-yellow-500' : 'bg-red-500'
                  }`}></div>
                  <div>
                    <p className="font-medium text-gray-900">
                      {connectionStatus === 'connected' ? 'Conectado' :
                       connectionStatus === 'connecting' ? 'Conectando...' :
                       connectionStatus === 'qr_ready' ? 'Aguardando configuração' : 'Desconectado'}
                    </p>
                    {botUsername && (
                      <p className="text-sm text-gray-600">@{botUsername}</p>
                    )}
                  </div>
                </div>
              </div>

              {connectionStatus === 'disconnected' && (
                <div className="space-y-3">
                  <button
                    onClick={handleGenerateSetupQR}
                    disabled={generateSetupQRMutation.isPending}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {generateSetupQRMutation.isPending ? (
                      <>
                        <i className="fas fa-spinner fa-spin mr-2"></i>
                        Gerando...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-qrcode mr-2"></i>
                        Ver Instruções de Setup
                      </>
                    )}
                  </button>
                  
                  <button
                    onClick={() => setShowTokenInput(!showTokenInput)}
                    className="w-full bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 flex items-center justify-center"
                  >
                    <i className="fas fa-key mr-2"></i>
                    {showTokenInput ? 'Cancelar' : 'Conectar com Token'}
                  </button>
                </div>
              )}

              {connectionStatus === 'connected' && (
                <button
                  onClick={handleDisconnect}
                  disabled={disconnectMutation.isPending}
                  className="w-full bg-red-600 text-white py-2 px-4 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {disconnectMutation.isPending ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      Desconectando...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-unlink mr-2"></i>
                      Desconectar Bot
                    </>
                  )}
                </button>
              )}

              {/* Token Input */}
              {showTokenInput && (
                <div className="space-y-3 border-t pt-4">
                  <div>
                    <label htmlFor="botToken" className="block text-sm font-medium text-gray-700 mb-2">
                      Token do Bot
                    </label>
                    <input
                      type="text"
                      id="botToken"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder="123456789:ABCdefGhIJKlmNoPQRstUVwxyz"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Cole aqui o token que você recebeu do @BotFather
                    </p>
                  </div>
                  <button
                    onClick={handleConnectBot}
                    disabled={connectBotMutation.isPending || !botToken.trim()}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {connectBotMutation.isPending ? (
                      <>
                        <i className="fas fa-spinner fa-spin mr-2"></i>
                        Conectando...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-plug mr-2"></i>
                        Conectar Bot
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* QR Code / Instructions Card */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center mb-6">
              <div className="h-12 w-12 bg-yellow-500 rounded-full flex items-center justify-center mr-4">
                <i className="fas fa-robot text-white text-xl"></i>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Configuração do Bot</h2>
                <p className="text-sm text-gray-600">Instruções para criar seu bot</p>
              </div>
            </div>

            {qrCode ? (
              <div className="text-center">
                <div className="bg-white p-4 rounded-lg border-2 border-gray-200 inline-block">
                  <img 
                    src={qrCode} 
                    alt="QR Code para instruções" 
                    className="w-48 h-48 mx-auto"
                  />
                </div>
                <div className="mt-4 space-y-2 text-left">
                  <h4 className="font-medium text-gray-900">Como criar seu bot:</h4>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-gray-600">
                    <li>Abra o Telegram e procure por <strong>@BotFather</strong></li>
                    <li>Digite <code className="bg-gray-100 px-1 rounded">/newbot</code> para criar um novo bot</li>
                    <li>Escolha um nome para seu bot (ex: "Atendimento João")</li>
                    <li>Escolha um username terminado em "bot" (ex: "joao_atendimento_bot")</li>
                    <li>Copie o token que aparece como: <code className="bg-gray-100 px-1 rounded">123456789:ABC...</code></li>
                    <li>Cole o token no campo "Token do Bot" acima</li>
                  </ol>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-24 h-24 mx-auto bg-gray-100 rounded-full flex items-center justify-center mb-4">
                  <i className="fab fa-telegram text-gray-400 text-3xl"></i>
                </div>
                <p className="text-gray-600">
                  Clique em "Ver Instruções de Setup" para começar
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Bot Benefits */}
        {connectionStatus === 'connected' && (
          <div className="mt-8 bg-green-50 border border-green-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-green-800 mb-4">Bot Conectado com Sucesso!</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="text-center">
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <i className="fas fa-comments text-white"></i>
                </div>
                <h4 className="font-medium text-green-800">Mensagens Reais</h4>
                <p className="text-sm text-green-600">Receba e responda mensagens reais dos clientes</p>
              </div>
              <div className="text-center">
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <i className="fas fa-robot text-white"></i>
                </div>
                <h4 className="font-medium text-green-800">ChatGPT Integrado</h4>
                <p className="text-sm text-green-600">Respostas automáticas inteligentes</p>
              </div>
              <div className="text-center">
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <i className="fas fa-users text-white"></i>
                </div>
                <h4 className="font-medium text-green-800">Multi-Agente</h4>
                <p className="text-sm text-green-600">Distribuição automática entre agentes</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}